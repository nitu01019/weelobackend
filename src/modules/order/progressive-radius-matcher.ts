/**
 * =============================================================================
 * PROGRESSIVE RADIUS MATCHER — H3 Primary + GEORADIUS Fallback + ETA Ranking
 * =============================================================================
 *
 * DISPATCH CASCADE:
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. H3 SUNION (primary)           → O(k) Redis ops, ~2-5ms
 *    ↓ if fails / 0 results
 * 2. GEORADIUS (automatic fallback) → O(N log N), ~10-50ms
 *    ↓ after candidates found
 * 3. Google Directions API (ETA)    → Real road ETA ranking, ~200-400ms
 *    ↓ if fails
 * 4. Haversine (final fallback)     → Pure math, ~0.1ms
 *
 * FEATURE FLAGS:
 * - FF_H3_INDEX_ENABLED=true  → H3 primary, GEORADIUS fallback
 * - FF_H3_INDEX_ENABLED=false → GEORADIUS only (current production behavior)
 * - FF_H3_RADIUS_STEPS_7=true → 7-step expansion (5→10→15→30→60→100km)
 *
 * =============================================================================
 */

import { availabilityService } from '../../shared/services/availability.service';
import { generateVehicleKey, generateVehicleKeyCandidates } from '../../shared/services/vehicle-key.service';
import { h3GeoIndexService, FF_H3_INDEX_ENABLED } from '../../shared/services/h3-geo-index.service';
import { directionsApiService } from '../../shared/services/directions-api.service';
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
  /** ETA in seconds from pickup (Google API or haversine estimate) */
  etaSeconds?: number;
  /** Source of ETA: 'google' | 'haversine' */
  etaSource?: 'google' | 'haversine';
}

// ============================================================================
// PROGRESSIVE RADIUS STEPS
// ============================================================================

/** Original 3-step progression (default) — with H3 ring mappings */
export const PROGRESSIVE_RADIUS_STEPS: RadiusStep[] = [
  { radiusKm: 10, windowMs: 20_000, h3RingK: 15 },
  { radiusKm: 25, windowMs: 20_000, h3RingK: 38 },
  { radiusKm: 30, windowMs: 20_000, h3RingK: 44 }
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

  /**
   * Find candidate transporters for broadcast dispatch.
   *
   * CASCADE:
   * 1. H3 SUNION (if enabled) → load transporter:details hash → filter
   * 2. GEORADIUS fallback (if H3 fails or disabled)
   * 3. Google Directions API → real ETA ranking
   * 4. Haversine → fallback ETA ranking
   */
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

    // FIX #2: Generate ALL possible normalized key forms to handle canonical
    // alias ordering variants (e.g. open_17ft vs open_17_ft_open).
    const vehicleKeyCandidates = generateVehicleKeyCandidates(vehicleType, vehicleSubtype);
    const vehicleKey = vehicleKeyCandidates[0] || generateVehicleKey(vehicleType, vehicleSubtype);

    // ========================================================================
    // LAYER 1: H3 PRIMARY PATH (Feature-flagged)
    // H3 → transporter:details hash → filter. NO GEORADIUS.
    // ========================================================================
    let candidates: CandidateTransporter[] | undefined;

    if (FF_H3_INDEX_ENABLED && step.h3RingK !== undefined) {
      const { h3Circuit } = require('../../shared/services/circuit-breaker.service');
      candidates = await h3Circuit.tryWithFallback(
        () => this.findCandidatesH3({
          pickupLat,
          pickupLng,
          vehicleKeys: vehicleKeyCandidates,
          ringK: step.h3RingK!,
          radiusKm: step.radiusKm,
          alreadyNotified,
          limit
        }),
        async () => undefined as any // fallback = fall through to GEORADIUS
      );
    }

    // ========================================================================
    // LAYER 2: GEORADIUS FALLBACK (if H3 disabled / failed / 0 results)
    // ========================================================================
    if (candidates === undefined) {
      candidates = await this.findCandidatesGeoRadius({
        pickupLat,
        pickupLng,
        vehicleKeys: vehicleKeyCandidates,
        radiusKm: step.radiusKm,
        alreadyNotified,
        limit
      });
    }

    if (candidates.length === 0) return [];

    // ========================================================================
    // LAYER 3: CACHED ETA RANKING (Redis cache → Google Distance Matrix → Haversine)
    // Uses directionsApiService which has:
    //   - Redis cache (geohash6 precision, 3-min TTL, ~60-80% hit rate)
    //   - Token-bucket rate limiter (450 QPS)
    //   - Circuit breaker (auto-trips → haversine fallback)
    //   - Haversine fallback (always-available)
    // ========================================================================
    try {
      const origins = candidates.map(c => ({
        lat: c.latitude,
        lng: c.longitude,
        id: c.transporterId
      }));

      const etaResults = await directionsApiService.batchGetEta(origins, pickupLat, pickupLng);

      // Merge ETA data back into candidates
      const enriched = candidates
        .map(c => {
          const eta = etaResults.get(c.transporterId);
          return {
            ...c,
            etaSeconds: eta?.durationSeconds,
            etaSource: eta?.source as ('google' | 'haversine' | undefined),
            distanceKm: eta ? eta.distanceMeters / 1000 : c.distanceKm
          };
        })
        .sort((a, b) => (a.etaSeconds ?? Infinity) - (b.etaSeconds ?? Infinity))
        .slice(0, limit);

      const cacheHits = Array.from(etaResults.values()).filter(r => r.cached).length;
      logger.info('[RadiusMatcher] ETA-ranked candidates', {
        matchingSource: FF_H3_INDEX_ENABLED ? 'h3_index' : 'georadius',
        etaSource: enriched[0]?.etaSource || 'none',
        vehicleKey,
        stepIndex,
        radiusKm: step.radiusKm,
        totalCandidates: enriched.length,
        cacheHits,
        apiCalls: etaResults.size - cacheHits
      });

      return enriched;
    } catch (error: any) {
      // If ETA ranking completely fails, return haversine-sorted candidates
      logger.warn(`[RadiusMatcher] ETA ranking failed, using haversine order: ${error.message}`);
      return candidates.slice(0, limit);
    }
  }

  // ==========================================================================
  // LAYER 1: H3 CANDIDATE FINDER (Primary — no GEORADIUS)
  // ==========================================================================

  private async findCandidatesH3(params: {
    pickupLat: number;
    pickupLng: number;
    vehicleKeys: string[];
    ringK: number;
    radiusKm: number;
    alreadyNotified: Set<string>;
    limit: number;
  }): Promise<CandidateTransporter[] | undefined> {
    const { pickupLat, pickupLng, vehicleKeys, ringK, radiusKm, alreadyNotified, limit } = params;

    try {
      // FIX #2: H3 lookup across ALL vehicleKey variants (parallel)
      const candidateArrays = await Promise.all(
        vehicleKeys.map(key =>
          h3GeoIndexService.getCandidates(pickupLat, pickupLng, key, ringK, alreadyNotified)
        )
      );
      const candidateIds = [...new Set(candidateArrays.flat())];

      if (candidateIds.length === 0) {
        logger.info('[RadiusMatcher] H3 returned 0 candidates, falling back to GEORADIUS', {
          vehicleKeys, ringK, radiusKm
        });
        return undefined; // triggers GEORADIUS fallback
      }

      // Load transporter:details Redis hash directly — NO GEORADIUS
      const detailsMap = await availabilityService.loadTransporterDetailsMap(candidateIds);

      // Filter: online + not on trip + within radius
      const results: CandidateTransporter[] = [];
      for (const transporterId of candidateIds) {
        const details = detailsMap.get(transporterId);

        // No details = TTL expired = transporter offline → skip
        if (!details || Object.keys(details).length === 0) continue;

        // On trip → skip
        if (details.isOnTrip === 'true') continue;

        // Must have valid coordinates
        const lat = parseFloat(details.latitude);
        const lng = parseFloat(details.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

        // Strict haversine distance check (H3 cells are approximate)
        const distanceKm = haversineDistanceKm(pickupLat, pickupLng, lat, lng);
        if (distanceKm > radiusKm) continue;

        results.push({
          transporterId,
          distanceKm,
          latitude: lat,
          longitude: lng
        });
      }

      // Sort by distance initially (ETA ranking happens in findCandidates)
      results.sort((a, b) => a.distanceKm - b.distanceKm);

      logger.info('[RadiusMatcher] H3 candidate lookup (no GEORADIUS)', {
        matchingSource: 'h3_index',
        vehicleKeys,
        ringK,
        radiusKm,
        h3Candidates: candidateIds.length,
        filteredOnline: results.length
      });

      return results.slice(0, limit);
    } catch (error: any) {
      logger.warn(`[RadiusMatcher] H3 lookup failed, falling back to GEORADIUS: ${error.message}`);
      return undefined; // triggers GEORADIUS fallback
    }
  }

  // ==========================================================================
  // LAYER 2: GEORADIUS FALLBACK (automatic when H3 fails/disabled)
  // ==========================================================================

  private async findCandidatesGeoRadius(params: {
    pickupLat: number;
    pickupLng: number;
    vehicleKeys: string[];
    radiusKm: number;
    alreadyNotified: Set<string>;
    limit: number;
  }): Promise<CandidateTransporter[]> {
    const { pickupLat, pickupLng, vehicleKeys, radiusKm, alreadyNotified, limit } = params;

    // FIX #2: Query ALL possible vehicleKey forms to handle canonical alias
    // ordering variants. Parallel queries keep latency unchanged.
    const nearbyArrays = await Promise.all(
      vehicleKeys.map(key =>
        availabilityService.getAvailableTransportersWithDetails(
          key, pickupLat, pickupLng, Math.max(limit * 2, 100), radiusKm
        )
      )
    );
    // Merge + dedup by transporterId (keep first occurrence)
    const seenTransporters = new Set<string>();
    const nearby = nearbyArrays.flat().filter(entry => {
      if (seenTransporters.has(entry.transporterId)) return false;
      seenTransporters.add(entry.transporterId);
      return true;
    });

    return nearby
      .map((entry) => {
        const strictDistanceKm = haversineDistanceKm(
          pickupLat,
          pickupLng,
          entry.latitude,
          entry.longitude
        );
        return {
          transporterId: entry.transporterId,
          distanceKm: strictDistanceKm,
          latitude: entry.latitude,
          longitude: entry.longitude
        };
      })
      .filter((candidate) => {
        return candidate.distanceKm <= radiusKm &&
          !alreadyNotified.has(candidate.transporterId);
      })
      .sort((left, right) => left.distanceKm - right.distanceKm)
      .slice(0, limit);
  }
}

export const progressiveRadiusMatcher = new ProgressiveRadiusMatcher();
