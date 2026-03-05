import { availabilityService } from '../../shared/services/availability.service';
import { generateVehicleKey } from '../../shared/services/vehicle-key.service';
import { h3GeoIndexService, FF_H3_INDEX_ENABLED } from '../../shared/services/h3-geo-index.service';
import { logger } from '../../shared/services/logger.service';

export interface RadiusStep {
  radiusKm: number;
  windowMs: number;
  /** H3 ring count for this step (used when FF_H3_INDEX_ENABLED=true) */
  h3RingK?: number;
}

export interface ProgressiveMatchState {
  orderId: string;
  vehicleType: string;
  vehicleSubtype: string;
  stepIndex: number;
}

export interface CandidateTransporter {
  transporterId: string;
  distanceKm: number;
  latitude: number;
  longitude: number;
}

// ============================================================================
// PROGRESSIVE RADIUS STEPS
// ============================================================================

/** Original 3-step progression (default) */
export const PROGRESSIVE_RADIUS_STEPS: RadiusStep[] = [
  { radiusKm: 10, windowMs: 20_000 },
  { radiusKm: 25, windowMs: 20_000 },
  { radiusKm: 30, windowMs: 20_000 }
];

/**
 * Extended 7-step progression with H3 ring mappings.
 * Feature-flagged: FF_H3_RADIUS_STEPS_7=true
 *
 * Ring K → approximate radius: ringK × 0.461km (H3 res 8 edge length)
 */
const FF_H3_RADIUS_STEPS_7 = process.env.FF_H3_RADIUS_STEPS_7 === 'true';

export const PROGRESSIVE_RADIUS_STEPS_7: RadiusStep[] = [
  { radiusKm: 5, windowMs: 0, h3RingK: 8 },          // ~5 km, immediate
  { radiusKm: 10, windowMs: 10_000, h3RingK: 15 },    // ~10 km at +10s
  { radiusKm: 15, windowMs: 20_000, h3RingK: 22 },    // ~15 km
  { radiusKm: 30, windowMs: 25_000, h3RingK: 44 },    // ~30 km
  { radiusKm: 60, windowMs: 30_000, h3RingK: 88 },    // ~60 km
  { radiusKm: 100, windowMs: 40_000, h3RingK: 150 }   // ~100 km
];

function getActiveSteps(): RadiusStep[] {
  return FF_H3_RADIUS_STEPS_7 ? PROGRESSIVE_RADIUS_STEPS_7 : PROGRESSIVE_RADIUS_STEPS;
}

function toRadians(value: number): number {
  return value * (Math.PI / 180);
}

function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

class ProgressiveRadiusMatcher {
  getStep(stepIndex: number): RadiusStep | undefined {
    const steps = getActiveSteps();
    if (stepIndex < 0 || stepIndex >= steps.length) return undefined;
    return steps[stepIndex];
  }

  getStepCount(): number {
    return getActiveSteps().length;
  }

  async findCandidates(params: {
    pickupLat: number;
    pickupLng: number;
    vehicleType: string;
    vehicleSubtype: string;
    stepIndex: number;
    alreadyNotified: Set<string>;
    limit?: number;
  }): Promise<CandidateTransporter[]> {
    const {
      pickupLat,
      pickupLng,
      vehicleType,
      vehicleSubtype,
      stepIndex,
      alreadyNotified,
      limit = 250
    } = params;
    const step = this.getStep(stepIndex);
    if (!step) return [];

    const vehicleKey = generateVehicleKey(vehicleType, vehicleSubtype);

    // ========================================================================
    // H3 PATH (Feature-flagged — default OFF)
    // When enabled, uses H3 hex-cell lookup instead of GEORADIUS.
    // Existing GEORADIUS path is untouched below.
    // ========================================================================
    if (FF_H3_INDEX_ENABLED && step.h3RingK !== undefined) {
      // Phase 5: Circuit breaker wraps H3 lookup. When circuit OPEN,
      // falls through to GEORADIUS path below (returns undefined → skips early return).
      const { h3Circuit } = require('../../shared/services/circuit-breaker.service');
      const h3Result = await h3Circuit.tryWithFallback(
        () => this.findCandidatesH3({
          pickupLat,
          pickupLng,
          vehicleKey,
          ringK: step.h3RingK!,
          radiusKm: step.radiusKm,
          alreadyNotified,
          limit
        }),
        async () => undefined as any // fallback = fall through to GEORADIUS below
      );
      if (h3Result !== undefined) return h3Result;
      // Circuit is OPEN — fall through to GEORADIUS path
    }

    // ========================================================================
    // ORIGINAL GEORADIUS PATH (always available, untouched)
    // ========================================================================
    const nearby = await availabilityService.getAvailableTransportersWithDetails(
      vehicleKey,
      pickupLat,
      pickupLng,
      Math.max(limit * 2, 100),
      step.radiusKm
    );

    return nearby
      .map((driver) => {
        const strictDistanceKm = haversineDistanceKm(
          pickupLat,
          pickupLng,
          driver.latitude,
          driver.longitude
        );
        return {
          transporterId: driver.transporterId,
          distanceKm: strictDistanceKm,
          latitude: driver.latitude,
          longitude: driver.longitude
        };
      })
      .filter((candidate) => {
        return candidate.distanceKm <= step.radiusKm &&
          !alreadyNotified.has(candidate.transporterId);
      })
      .sort((left, right) => left.distanceKm - right.distanceKm)
      .slice(0, limit);
  }

  // ==========================================================================
  // H3 CANDIDATE FINDER (Private — only called when FF_H3_INDEX_ENABLED=true)
  // ==========================================================================

  private async findCandidatesH3(params: {
    pickupLat: number;
    pickupLng: number;
    vehicleKey: string;
    ringK: number;
    radiusKm: number;
    alreadyNotified: Set<string>;
    limit: number;
  }): Promise<CandidateTransporter[] | undefined> {
    const { pickupLat, pickupLng, vehicleKey, ringK, radiusKm, alreadyNotified, limit } = params;

    try {
      // H3 candidate lookup — O(k) Redis SUNION
      const candidateIds = await h3GeoIndexService.getCandidates(
        pickupLat, pickupLng, vehicleKey, ringK, alreadyNotified
      );

      if (candidateIds.length === 0) {
        // H3 cells empty (expired TTL / cold start) — fall through to GEORADIUS
        logger.info('[RadiusMatcher] H3 returned 0 candidates, falling back to GEORADIUS', {
          vehicleKey, ringK, radiusKm
        });
        return undefined; // triggers GEORADIUS fallback in findCandidates()
      }

      // H3 found candidates — load details from GEORADIUS for lat/lng + distance
      const nearby = await availabilityService.getAvailableTransportersWithDetails(
        vehicleKey,
        pickupLat,
        pickupLng,
        Math.max(limit * 3, 200),
        radiusKm
      );

      // UNION approach: include ALL transporters within radius (not just H3 matches)
      // H3 is a fast hint for WHO might be nearby, GEORADIUS provides ground truth.
      const results = nearby
        .map(driver => ({
          transporterId: driver.transporterId,
          distanceKm: haversineDistanceKm(pickupLat, pickupLng, driver.latitude, driver.longitude),
          latitude: driver.latitude,
          longitude: driver.longitude
        }))
        .filter(c => c.distanceKm <= radiusKm && !alreadyNotified.has(c.transporterId))
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, limit);

      logger.info('[RadiusMatcher] H3 candidate lookup', {
        matchingSource: 'h3_index',
        vehicleKey,
        ringK,
        radiusKm,
        h3Candidates: candidateIds.length,
        geoNearby: nearby.length,
        matched: results.length
      });

      return results;
    } catch (error: any) {
      // Fallback to GEORADIUS on H3 failure — zero latency regression
      logger.warn(`[RadiusMatcher] H3 lookup failed, falling back to GEORADIUS: ${error.message}`);
      return undefined; // triggers GEORADIUS fallback in findCandidates()
    }
  }
}

export const progressiveRadiusMatcher = new ProgressiveRadiusMatcher();

