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
 * - FF_DIRECTIONS_API_SCORING_ENABLED=false (default)
 * - When false: Tier 1 only (zero API calls, zero latency impact)
 * - When true: Tier 1 + Tier 2 (API calls for top-20 only)
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

import { directionsApiService, FF_DIRECTIONS_API_SCORING_ENABLED } from './directions-api.service';
import { logger } from './logger.service';

// =============================================================================
// CONSTANTS
// =============================================================================

/** How many top candidates to score with Google Directions API (Tier 2) */
const TIER2_TOP_N = parseInt(process.env.TIER2_TOP_N || '20', 10);

/** Average city speed assumption for Tier 1 (km/h) */
const AVERAGE_CITY_SPEED_KMH = 30;

/** Road distance multiplier (straight-line → road distance) */
const ROAD_FACTOR = 1.4;

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
}

export interface CandidateInput {
    transporterId: string;
    distanceKm: number;
    latitude: number;
    longitude: number;
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
        const tier1Scored = candidates.map((c): ScoredCandidate => ({
            transporterId: c.transporterId,
            distanceKm: c.distanceKm,
            etaSeconds: this.haversineEtaSeconds(c.distanceKm),
            etaSource: 'haversine',
            latitude: c.latitude,
            longitude: c.longitude
        }));

        // Sort by Tier 1 ETA
        tier1Scored.sort((a, b) => a.etaSeconds - b.etaSeconds);

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

            // Apply Tier 2 scores to top-N
            for (const candidate of topN) {
                const result = directionsResults.get(candidate.transporterId);
                if (result) {
                    candidate.etaSeconds = result.durationSeconds;
                    candidate.etaSource = result.source;
                }
            }

            // Re-sort top-N by Tier 2 ETA
            topN.sort((a, b) => a.etaSeconds - b.etaSeconds);

            // Combine: re-ranked top-N + rest (Tier 1 scores)
            const finalResults = [...topN, ...rest];

            const cacheHits = Array.from(directionsResults.values()).filter(r => r.cached).length;
            const apiCalls = directionsResults.size - cacheHits;

            logger.info('[CandidateScorer] Two-tier scoring', {
                scoringMode: 'tier2_directions',
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
