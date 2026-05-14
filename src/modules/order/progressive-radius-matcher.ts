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
 *
 * RADIUS STEPS (H-X2 unified):
 * - 6-step expansion: 5→10→15→30→60→100 km
 * - Total window: 80s (fits within 90% of 120s booking timeout)
 *
 * =============================================================================
 */

import { availabilityService } from '../../shared/services/availability.service';
import { generateVehicleKey, generateVehicleKeyCandidates } from '../../shared/services/vehicle-key.service';
import {
  h3GeoIndexService,
  FF_H3_INDEX_ENABLED,
  FF_H3_DUAL_INDEX_READ,
  FF_H3_DUAL_INDEX_WRITE
} from '../../shared/services/h3-geo-index.service';
import { distanceMatrixService } from '../../shared/services/distance-matrix.service';
import { redisService } from '../../shared/services/redis.service';
import { logger } from '../../shared/services/logger.service';
// Fix F2: Import shared haversine instead of local duplicate
import { haversineDistanceKm } from '../../shared/utils/geospatial.utils';

/**
 * Fix #15/#16 — RadiusStep carries the per-step query resolution and a
 * PINNED `h3FallbackRingK` (no runtime arithmetic; closes Attack #3).
 *
 * - `h3QueryResolution` selects child (8) vs parent (7) index. Parent reads
 *   require both FF_H3_DUAL_INDEX_WRITE and FF_H3_DUAL_INDEX_READ to be true.
 * - `h3FallbackRingK` is the equivalent res-8 ringK used when the res-7
 *   parent index is empty (warm-up / partial-write / FF mid-flip).
 */
export interface RadiusStep {
  radiusKm: number;
  windowMs: number;
  /** Ring K at h3QueryResolution */
  h3RingK: number;
  /** 7 = parent index; 8 = child index */
  h3QueryResolution: number;
  /** res-8 equivalent ringK for fallback (PINNED, no × 2.65 arithmetic) */
  h3FallbackRingK: number;
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

/**
 * Fix H-X2 + Fix #15/#16: Unified 6-step progressive radius expansion.
 *
 * - Steps 0-2 (radiusKm ≤ 15km) query at res-8 (child index, h3RingK = h3FallbackRingK).
 * - Steps 3-5 (radiusKm ≥ 30km) query at res-7 parent index when FF_H3_DUAL_INDEX
 *   is on; fallback to res-8 using the PINNED `h3FallbackRingK` (NO runtime × 2.65).
 *
 * Total window: 10+10+15+15+15+15 = 80s < 108s (passes booking.service startup validation).
 */
export const PROGRESSIVE_RADIUS_STEPS: RadiusStep[] = [
  { radiusKm: 5,   windowMs: 10_000, h3RingK: 8,   h3QueryResolution: 8, h3FallbackRingK: 8 },
  { radiusKm: 10,  windowMs: 10_000, h3RingK: 15,  h3QueryResolution: 8, h3FallbackRingK: 15 },
  { radiusKm: 15,  windowMs: 15_000, h3RingK: 22,  h3QueryResolution: 8, h3FallbackRingK: 22 },
  // Steps 3-5: query at the res-7 parent index when FF on; fallback ringK is pinned.
  { radiusKm: 30,  windowMs: 15_000, h3RingK: 17,  h3QueryResolution: 7, h3FallbackRingK: 44 },
  { radiusKm: 60,  windowMs: 15_000, h3RingK: 33,  h3QueryResolution: 7, h3FallbackRingK: 88 },
  { radiusKm: 100, windowMs: 15_000, h3RingK: 57,  h3QueryResolution: 7, h3FallbackRingK: 150 }
];

function getActiveSteps(): RadiusStep[] {
  return PROGRESSIVE_RADIUS_STEPS;
}

// Fix F2: Local haversineDistanceKm removed -- now imported from geospatial.utils

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

    if (FF_H3_INDEX_ENABLED) {
      const { h3Circuit } = require('../../shared/services/circuit-breaker.service');
      candidates = await h3Circuit.tryWithFallback(
        () => this.findCandidatesH3({
          pickupLat,
          pickupLng,
          vehicleKeys: vehicleKeyCandidates,
          step,
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
    // LAYER 3: DISTANCE MATRIX ETA RANKING
    // Uses distanceMatrixService (Google Distance Matrix API) which has:
    //   - Redis cache (5-min TTL, ~60-80% hit rate in dense areas)
    //   - Token-bucket rate limiter (450 QPS)
    //   - Haversine fallback (always-available)
    // NOTE: This is SEPARATE from directions-api.service.ts (maps/routes)
    // ========================================================================
    try {
      const origins = candidates.map(c => ({
        lat: c.latitude,
        lng: c.longitude,
        id: c.transporterId
      }));

      const etaResults = await distanceMatrixService.batchGetPickupDistance(origins, pickupLat, pickupLng);

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
    step: RadiusStep;
    alreadyNotified: Set<string>;
    limit: number;
  }): Promise<CandidateTransporter[] | undefined> {
    const { pickupLat, pickupLng, vehicleKeys, step, alreadyNotified, limit } = params;
    const radiusKm = step.radiusKm;

    try {
      // Fix #16 (Attack #4): Snapshot FF + step config ONCE per dispatch.
      // All parallel vehicleKey lookups within this Promise.all observe the SAME
      // dualReadOn / useParent / ringK / queryRes / fallbackRingK values, even if
      // env vars or step mutations happen mid-flight. Closes mid-flight race.
      const dualReadOn = FF_H3_DUAL_INDEX_READ && FF_H3_DUAL_INDEX_WRITE;
      const useParent = dualReadOn && step.h3QueryResolution === 7;
      const ringK = useParent ? step.h3RingK : step.h3FallbackRingK;
      const queryRes = useParent ? 7 : 8;
      const fallbackRingK = step.h3FallbackRingK;

      // FIX #2: H3 lookup across ALL vehicleKey variants (parallel)
      const candidateArrays = await Promise.all(
        vehicleKeys.map(key =>
          h3GeoIndexService.getCandidatesNewRing(
            pickupLat, pickupLng, key, ringK, alreadyNotified, queryRes, fallbackRingK
          )
        )
      );
      const rawCandidateIds = [...new Set(candidateArrays.flat())];

      // FIX #3/#14: Filter out candidates whose h3:pos:{id} key has expired.
      // H3 cell TTL (180s) > position key TTL (90s), creating a 90s ghost window.
      // Query-time filtering catches stale entries before they reach dispatch.
      // Industry pattern: Grab Pharos -- query-time staleness filtering.
      let candidateIds: string[];
      try {
        const liveChecks = await Promise.all(
          rawCandidateIds.map(async (id) => {
            const posExists = await redisService.exists(`h3:pos:${id}`);
            if (!posExists) {
              logger.debug(`[H3] Stale candidate ${id} -- posKey expired, skipping`);
            }
            return { id, live: posExists };
          })
        );
        candidateIds = liveChecks.filter(c => c.live).map(c => c.id);
      } catch (err: any) {
        // If existence check fails, use all candidates (safe fallback)
        logger.warn(`[H3] posKey existence check failed, using all candidates: ${err.message}`);
        candidateIds = rawCandidateIds;
      }

      if (candidateIds.length === 0) {
        logger.info('[RadiusMatcher] H3 returned 0 candidates, falling back to GEORADIUS', {
          vehicleKeys, ringK, radiusKm
        });
        return undefined; // triggers GEORADIUS fallback
      }

      // Load transporter:details Redis hash directly — NO GEORADIUS
      const detailsMap = await availabilityService.loadTransporterDetailsMap(candidateIds);

      // =====================================================================
      // FIX M-5: Double-check online status via the authoritative presence SET.
      // The details hash can be stale by up to 90s. The online:transporters SET
      // is updated on every heartbeat (4s interval).
      // =====================================================================
      const onlineFlags = await redisService.smIsMembers(
        'online:transporters', candidateIds
      ).catch((err) => {
        logger.warn('[RadiusMatcher] smIsMembers failed, fail-open applied', {
          error: err instanceof Error ? err.message : String(err),
          candidateCount: candidateIds.length
        });
        return candidateIds.map(() => true);
      });

      // Filter: online + not on trip + within radius
      const results: CandidateTransporter[] = [];
      for (let i = 0; i < candidateIds.length; i++) {
        const transporterId = candidateIds[i];

        // M-5: Skip transporters not in the authoritative online set
        if (!onlineFlags[i]) continue;

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
        queryRes,
        fallbackRingK,
        dualReadOn,
        radiusKm,
        h3RawCandidates: rawCandidateIds.length,
        h3LiveCandidates: candidateIds.length,
        h3StaleFiltered: rawCandidateIds.length - candidateIds.length,
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
