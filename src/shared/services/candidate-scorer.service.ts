/**
 * =============================================================================
 * CANDIDATE SCORER SERVICE — Two-Tier ETA-Based Dispatch Scoring
 * =============================================================================
 *
 * WHAT THIS DOES:
 * Re-ranks candidate transporters by estimated road-time to pickup instead of
 * simple straight-line distance. This ensures that the closest transporter
 * *by road* gets the broadcast first, not the closest by air.
 *
 * TWO-TIER SCORING:
 *
 * TIER 1 — Haversine Approximation (ALL candidates):
 * - Zero external API calls
 * - Uses straight-line distance × 1.4 road factor ÷ 30 km/h avg speed
 * - Applied to all 200+ candidates
 * - Used for initial sort + top-N selection
 * - Latency: ~0ms (pure math)
 *
 * TIER 2 — Google Directions API (TOP-N candidates only):
 * - Real road-time with live traffic data
 * - Applied to top 20 candidates from Tier 1
 * - Cached for 3 minutes at geohash6 precision
 * - Feature-flagged: FF_DIRECTIONS_API_SCORING_ENABLED
 * - Latency: ~1ms cache hit, ~200-400ms cache miss
 *
 * FALLBACK:
 * - If Google API fails → Tier 1 scores are used
 * - If Redis cache fails → Google API is called directly
 * - If everything fails → Original Haversine sort is preserved
 *
 * FEATURE FLAG:
 * - FF_DIRECTIONS_API_SCORING_ENABLED defaults to ON (true) when env var is unset
 * - Set to 'false' explicitly to disable Google Directions API scoring
 * - When disabled: Tier 1 only (zero API calls, zero latency impact)
 * - When enabled: Tier 1 + Tier 2 (API calls for top-N only)
 *
 * LATENCY IMPACT (when flag is ON):
 * - Tier 1: 0ms (pure math)
 * - Tier 2 (cache hit): ~1ms per batch
 * - Tier 2 (cache miss): ~200-400ms per batch (parallel API calls)
 * - Total worst case: ~400ms (well within acceptable for dispatch)
 * - Runs BEFORE broadcast emission — NOT on transporter's hot path
 *
 * @author Weelo Engineering
 * @version 1.0.0
 * =============================================================================
 */

import { z } from 'zod';
import { directionsApiService, FF_DIRECTIONS_API_SCORING_ENABLED } from './directions-api.service';
import { logger } from './logger.service';
import { metrics } from '../monitoring/metrics.service';
import { CIRCUITY_FACTORS } from '../utils/geospatial.utils';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * How many top candidates to score with Google Directions API (Tier 2).
 * FIX #25: Increased default from 20 to 50 (2 Google API batches of 25 origins).
 * Env-configurable via CANDIDATE_SCORER_TOP_N for cost/accuracy tradeoff.
 */
const TIER2_TOP_N = Math.max(1, parseInt(process.env.CANDIDATE_SCORER_TOP_N || '50', 10) || 50);

/**
 * Average city speed assumption for Tier 1 (km/h).
 * FIX #34: Env-configurable via HAVERSINE_AVG_SPEED_KMH.
 * Default 30 matches Indian urban truck speed.
 */
const AVERAGE_CITY_SPEED_KMH = Math.max(1, parseInt(process.env.HAVERSINE_AVG_SPEED_KMH || '30', 10) || 30);

/**
 * Road distance multiplier (straight-line to road distance).
 * FIX #34: Env-configurable via HAVERSINE_ROAD_FACTOR.
 * Default 1.4 based on Ballou et al. (2002) India urban circuity: 1.25-1.50.
 * Now imported from shared CIRCUITY_FACTORS for single source of truth.
 */
const ROAD_FACTOR = CIRCUITY_FACTORS.ETA_RANKING;

// =============================================================================
// M-3 FIX: Multi-factor transporter scoring (Uber DISCO pattern)
// =============================================================================
// Configurable: FF_BEHAVIORAL_SCORING=true enables it (default: false for safe rollout)
// When disabled, compositeScore === etaSeconds (pure ETA ranking, zero behavioral impact)
// =============================================================================

const BEHAVIORAL_SCORING_ENABLED = process.env.FF_BEHAVIORAL_SCORING === 'true';

/**
 * F-A-86: Zod schema for weights. Each weight in [0, 1] and the sum must be
 * 1.0 (+/- 5%) so composite scores remain comparable across releases. Exported
 * for unit tests.
 */
export const WeightsSchema = z
  .object({
    eta: z.number().min(0).max(1),
    acceptance: z.number().min(0).max(1),
    responseTime: z.number().min(0).max(1),
    rating: z.number().min(0).max(1),
  })
  .refine(
    (w) => Math.abs(w.eta + w.acceptance + w.responseTime + w.rating - 1) < 0.05,
    { message: 'weights must sum to 1.0 (+/- 5%)' },
  );

/** Raw weights from env (unvalidated). */
const rawBehavioralWeights = {
  eta: parseFloat(process.env.BEHAVIORAL_WEIGHT_ETA || '0.5'),             // 50% proximity
  acceptance: parseFloat(process.env.BEHAVIORAL_WEIGHT_ACCEPTANCE || '0.2'), // 20% reliability
  responseTime: parseFloat(process.env.BEHAVIORAL_WEIGHT_RESPONSE || '0.2'), // 20% speed
  rating: parseFloat(process.env.BEHAVIORAL_WEIGHT_RATING || '0.1'),         // 10% quality
};

const weightsValidation = WeightsSchema.safeParse(rawBehavioralWeights);

// Module-load setGauge call must tolerate partial metrics mocks used by
// legacy unit tests that only mock incrementCounter/observeHistogram.
function safeSetGauge(name: string, value: number): void {
  if (typeof (metrics as { setGauge?: unknown }).setGauge === 'function') {
    metrics.setGauge(name, value);
  }
}

if (!weightsValidation.success) {
  safeSetGauge('scorer_weights_boot_valid', 0);
  const issues = weightsValidation.error.issues.map((i) => `${i.path.join('.') || 'weights'}: ${i.message}`).join('; ');
  if (BEHAVIORAL_SCORING_ENABLED) {
    // Fail-fast boot: misconfigured weights + flag ON would silently skew
    // dispatch fairness. Blow up so the deploy is rolled back.
    logger.error('[CandidateScorer] Invalid BEHAVIORAL_WEIGHTS with FF_BEHAVIORAL_SCORING=true', {
      weights: rawBehavioralWeights,
      issues,
    });
    throw new Error(`[CandidateScorer] Invalid BEHAVIORAL_WEIGHTS: ${issues}`);
  }
  // Flag OFF: log once at boot; legacy ETA-only path is safe regardless.
  logger.warn('[CandidateScorer] Invalid BEHAVIORAL_WEIGHTS (FF_BEHAVIORAL_SCORING is OFF, tolerating)', {
    weights: rawBehavioralWeights,
    issues,
  });
} else {
  safeSetGauge('scorer_weights_boot_valid', 1);
}

/** Weights for composite scoring - lower score is better. Frozen to prevent runtime mutation. */
const BEHAVIORAL_WEIGHTS = Object.freeze({ ...rawBehavioralWeights });

logger.info('[CandidateScorer] Effective BEHAVIORAL_WEIGHTS', {
  weights: BEHAVIORAL_WEIGHTS,
  behavioralScoringEnabled: BEHAVIORAL_SCORING_ENABLED,
  validated: weightsValidation.success,
});

export { BEHAVIORAL_WEIGHTS };

/** Safe defaults for transporters without behavioral data */
const BEHAVIORAL_DEFAULTS = {
  acceptanceRate: 0.5,   // 50% acceptance (neutral)
  avgResponseTime: 30,   // 30 seconds (neutral)
  rating: 3.0,           // 3/5 (neutral)
};

export interface BehavioralFactors {
  acceptanceRate?: number;  // 0-1
  avgResponseTime?: number; // seconds
  rating?: number;          // 1-5
}

/**
 * Calculate composite score from ETA + behavioral factors.
 * Lower score = better candidate.
 *
 * When FF_BEHAVIORAL_SCORING is OFF, returns etaSeconds unchanged.
 * When ON, blends ETA with acceptance rate, response time, and rating.
 */
function calculateCompositeScore(
    etaSeconds: number,
    factors: BehavioralFactors
): number {
    if (!BEHAVIORAL_SCORING_ENABLED) {
        return etaSeconds; // Legacy: ETA-only ranking
    }

    const acceptanceRate = factors.acceptanceRate ?? BEHAVIORAL_DEFAULTS.acceptanceRate;
    const avgResponseTime = factors.avgResponseTime ?? BEHAVIORAL_DEFAULTS.avgResponseTime;
    const rating = factors.rating ?? BEHAVIORAL_DEFAULTS.rating;

    // Weighted scoring — lower is better
    // (1 - acceptanceRate) * 100: low acceptance = high penalty
    // (6 - rating) * 10: low rating = high penalty
    return (
        (etaSeconds * BEHAVIORAL_WEIGHTS.eta) +
        ((1 - acceptanceRate) * 100 * BEHAVIORAL_WEIGHTS.acceptance) +
        (avgResponseTime * BEHAVIORAL_WEIGHTS.responseTime) +
        ((6 - rating) * 10 * BEHAVIORAL_WEIGHTS.rating)
    );
}

// =============================================================================
// TYPES
// =============================================================================

export interface ScoredCandidate {
    transporterId: string;
    /** Straight-line distance in km (from Haversine) */
    distanceKm: number;
    /** Estimated road-time to pickup in seconds */
    etaSeconds: number;
    /** Source of ETA: 'haversine' | 'google_api' | 'cache' */
    etaSource: string;
    /** Latitude of transporter */
    latitude: number;
    /** Longitude of transporter */
    longitude: number;
    /** M-3: Composite score blending ETA + behavioral factors (lower is better).
     *  When FF_BEHAVIORAL_SCORING is OFF, equals etaSeconds. */
    compositeScore: number;
}

export interface CandidateInput {
    transporterId: string;
    distanceKm: number;
    latitude: number;
    longitude: number;
    /** M-3: Optional behavioral data (acceptance rate, response time, rating) */
    behavioralFactors?: BehavioralFactors;
}

// =============================================================================
// SERVICE CLASS
// =============================================================================

class CandidateScorerService {

    /**
     * Score and re-rank candidates by ETA to pickup.
     *
     * ALGORITHM:
     * 1. Apply Tier 1 (Haversine approximation) to ALL candidates
     * 2. Sort by Tier 1 ETA
     * 3. If FF_DIRECTIONS_API_SCORING_ENABLED:
     *    a. Take top TIER2_TOP_N candidates
     *    b. Batch Google Directions API lookup
     *    c. Re-rank top-N by real road-time ETA
     *    d. Append remaining candidates (Tier 1 scores kept)
     * 4. Return scored + sorted candidates
     *
     * @param candidates - Unsorted candidates from progressive radius matcher
     * @param pickupLat - Pickup latitude
     * @param pickupLng - Pickup longitude
     * @returns Scored candidates sorted by ETA (fastest first)
     */
    async scoreAndRank(
        candidates: CandidateInput[],
        pickupLat: number,
        pickupLng: number
    ): Promise<ScoredCandidate[]> {
        if (candidates.length === 0) return [];

        const startMs = Date.now();

        // =======================================================================
        // TIER 1 — Haversine Approximation (ALL candidates, zero API calls)
        // =======================================================================
        const tier1Scored = candidates.map((c): ScoredCandidate => {
            const eta = this.haversineEtaSeconds(c.distanceKm);
            return {
                transporterId: c.transporterId,
                distanceKm: c.distanceKm,
                etaSeconds: eta,
                etaSource: 'haversine',
                latitude: c.latitude,
                longitude: c.longitude,
                compositeScore: calculateCompositeScore(eta, c.behavioralFactors || {}),
            };
        });

        // Sort by composite score (ETA-only when behavioral scoring is OFF)
        tier1Scored.sort((a, b) => a.compositeScore - b.compositeScore);

        // If Directions API scoring is disabled, return Tier 1 results
        if (!FF_DIRECTIONS_API_SCORING_ENABLED) {
            logger.debug(`[CandidateScorer] Tier 1 only: ${tier1Scored.length} candidates scored in ${Date.now() - startMs}ms`);
            return tier1Scored;
        }

        // =======================================================================
        // TIER 2 — Google Directions API (TOP-N candidates only)
        // =======================================================================
        try {
            const topN = tier1Scored.slice(0, TIER2_TOP_N);
            const rest = tier1Scored.slice(TIER2_TOP_N);

            const origins = topN.map((c) => ({
                lat: c.latitude,
                lng: c.longitude,
                id: c.transporterId
            }));

            const directionsResults = await directionsApiService.batchGetEta(
                origins,
                pickupLat,
                pickupLng
            );

            // Apply Tier 2 scores to top-N + recalculate composite
            const candidateBehavioralMap = new Map(
                candidates.map(c => [c.transporterId, c.behavioralFactors || {}])
            );
            for (const candidate of topN) {
                const result = directionsResults.get(candidate.transporterId);
                if (result) {
                    candidate.etaSeconds = result.durationSeconds;
                    candidate.etaSource = result.source;
                    // M-3: Recalculate composite with real ETA
                    const factors = candidateBehavioralMap.get(candidate.transporterId) || {};
                    candidate.compositeScore = calculateCompositeScore(result.durationSeconds, factors);
                }
            }

            // Re-sort top-N by composite score (ETA-only when behavioral OFF)
            topN.sort((a, b) => a.compositeScore - b.compositeScore);

            // FIX #25: Apply confidence penalty to haversine-only candidates.
            // Haversine ETA can be 12-110% inaccurate depending on road network.
            // 20% penalty pushes uncertain estimates below API-scored candidates.
            const penalizedRest = rest.map(c => {
              const penalizedEta = Math.round(c.etaSeconds * 1.2);
              const factors = candidateBehavioralMap.get(c.transporterId) || {};
              return {
                ...c,
                etaSeconds: penalizedEta,
                etaSource: 'haversine_penalized',
                compositeScore: calculateCompositeScore(penalizedEta, factors),
              };
            });

            // Combine: re-ranked top-N + penalized rest
            const finalResults = [...topN, ...penalizedRest];

            const cacheHits = Array.from(directionsResults.values()).filter(r => r.cached).length;
            const apiCalls = directionsResults.size - cacheHits;

            logger.info('[CandidateScorer] Two-tier scoring', {
                scoringMode: 'tier2_directions',
                behavioralScoring: BEHAVIORAL_SCORING_ENABLED,
                totalCandidates: candidates.length,
                tier2Candidates: topN.length,
                cacheHits,
                apiCalls,
                durationMs: Date.now() - startMs
            });

            return finalResults;
        } catch (error: any) {
            // Tier 2 failed — return Tier 1 results (zero regression)
            logger.warn(`[CandidateScorer] Tier 2 failed, using Tier 1: ${error.message}`);
            return tier1Scored;
        }
    }

    // ===========================================================================
    // PRIVATE HELPERS
    // ===========================================================================

    /**
     * Estimate road-time ETA from Haversine distance.
     * Formula: distance × roadFactor ÷ avgSpeed
     *
     * @param distanceKm - Straight-line distance in km
     * @returns Estimated seconds
     */
    private haversineEtaSeconds(distanceKm: number): number {
        const roadDistanceKm = distanceKm * ROAD_FACTOR;
        return Math.round((roadDistanceKm / AVERAGE_CITY_SPEED_KMH) * 3600);
    }
}

// =============================================================================
// SINGLETON EXPORT
// =============================================================================

export const candidateScorerService = new CandidateScorerService();
