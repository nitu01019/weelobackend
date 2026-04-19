/**
 * =============================================================================
 * DISTANCE MATRIX SERVICE — Batch ETA Lookups via Google Distance Matrix API
 * =============================================================================
 *
 * Google Distance Matrix API — batch ETA lookups (up to 25 origins per request).
 * Used for: transporter RANKING during matching (need ETAs for many candidates).
 * Cache: 5 minutes per origin-destination pair.
 *
 * NOTE: directions-api.service.ts handles single ROUTE calculation (turn-by-turn
 * polyline, duration_in_traffic). These are separate Google APIs with different
 * pricing and use cases. Do NOT consolidate — they serve different purposes.
 *
 * PURPOSE:
 * Dedicated service for computing pickup distance and ETA between transporters
 * and pickup locations using Google Distance Matrix API.
 *
 * This is SEPARATE from directions-api.service.ts which uses Google Directions
 * API for maps/routes/route rendering.
 *
 * ARCHITECTURE (matches Uber/Ola production patterns):
 * 1. Redis cache check (4-decimal precision ≈ 11m, 5-min TTL)
 * 2. Google Distance Matrix API — BATCHED (up to 25 origins per request)
 * 3. Haversine fallback (always available, instant)
 *
 * BATCHING (Industry Standard):
 * - Google Distance Matrix API supports up to 25 origins × 25 destinations
 * - Origins are pipe-separated: lat1,lng1|lat2,lng2|...
 * - Billing is per element (origin × dest) — same cost batched or individual
 * - 20 transporters → 1 API call instead of 20 separate calls
 *
 * CACHING:
 * - Key format: dm:{oLat4},{oLng4}:{dLat4},{dLng4}
 * - TTL: 300 seconds (5 minutes) — matches Uber's 1-5 min ETA cache
 * - Expected hit rate: ~60-80% in dense Indian cities
 *
 * RATE LIMITING:
 * - Token-bucket rate limiter (200 QPS per instance, configurable)
 * - With 2 ECS tasks: 2 × 200 = 400 QPS total
 * - Google allows 3,000 EPM (50 EPS) — with batching, well within limits
 * - When bucket depleted → instant haversine fallback (no queue, no wait)
 *
 * @author Weelo Engineering
 * =============================================================================
 */

import { redisService } from './redis.service';
import { logger } from './logger.service';
import { config } from '../../config/environment';
import { CIRCUITY_FACTORS } from '../utils/geospatial.utils';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Cache TTL — 5 minutes (matches Uber's 1-5 min ETA cache pattern) */
const CACHE_TTL_SECONDS = 300;

/** Cache key prefix */
const CACHE_PREFIX = 'dm';

/** Max origins per Google Distance Matrix API request (Google limit: 25) */
const MAX_ORIGINS_PER_REQUEST = 25;

/** API timeout per request (ms) */
const API_TIMEOUT_MS = 3000;

/** Coordinate precision for cache key (4 decimal places ≈ 11m — good dedup) */
const COORD_PRECISION = 4;

/**
 * Rate limit: Elements Per Second (EPS) per instance.
 * Google allows 60,000 EPM = 1,000 EPS total across all instances.
 * With 2 ECS tasks: 1000 / 2 = 500 EPS per instance.
 * Default 400 (leaves 20% safety margin for burst absorption).
 */
const MAX_EPS = Math.max(
    10,
    parseInt(process.env.DISTANCE_MATRIX_MAX_EPS || '400', 10) || 400
);

// =============================================================================
// TOKEN-BUCKET RATE LIMITER (per-instance)
// =============================================================================

class TokenBucket {
    private tokens: number;
    private lastRefill: number;
    private readonly maxTokens: number;
    private readonly refillRatePerMs: number;

    constructor(ratePerSecond: number) {
        this.maxTokens = ratePerSecond;
        this.tokens = ratePerSecond;
        this.lastRefill = Date.now();
        this.refillRatePerMs = ratePerSecond / 1000;
    }

    tryConsume(count: number = 1): boolean {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRatePerMs);
        this.lastRefill = now;
        if (this.tokens >= count) {
            this.tokens -= count;
            return true;
        }
        return false;
    }
}

const rateLimiter = new TokenBucket(MAX_EPS);

// =============================================================================
// TYPES
// =============================================================================

export interface DistanceMatrixResult {
    /** Duration in seconds (road-time) */
    durationSeconds: number;
    /** Distance in meters (road distance) */
    distanceMeters: number;
    /** Whether this came from cache */
    cached: boolean;
    /** Source: 'distance_matrix' | 'haversine_fallback' | 'cache' */
    source: string;
}

interface OriginWithId {
    lat: number;
    lng: number;
    id: string;
}

// =============================================================================
// SERVICE CLASS
// =============================================================================

class DistanceMatrixService {

    /**
     * Get road distance and ETA from a single transporter to pickup.
     * Redis cache → Distance Matrix API → Haversine fallback.
     */
    async getPickupDistance(
        transporterLat: number,
        transporterLng: number,
        pickupLat: number,
        pickupLng: number
    ): Promise<DistanceMatrixResult> {
        const results = await this.batchGetPickupDistance(
            [{ lat: transporterLat, lng: transporterLng, id: '_single' }],
            pickupLat, pickupLng
        );
        return results.get('_single') || this.haversineFallback(transporterLat, transporterLng, pickupLat, pickupLng);
    }

    /**
     * Batch distance lookup for multiple transporters to one pickup.
     *
     * PRODUCTION FLOW:
     * 1. Check Redis cache for ALL origins (parallel)
     * 2. Collect cache misses
     * 3. Chunk misses into groups of 25 (Google limit)
     * 4. ONE API call per chunk with pipe-separated origins
     * 5. Parse per-element responses
     * 6. Cache each result individually in Redis
     * 7. Return merged Map<id, DistanceMatrixResult>
     *
     * COST: same billing whether batched or individual (per element)
     * SPEED: 1 HTTP call instead of 20 for 20 transporters
     */
    async batchGetPickupDistance(
        origins: OriginWithId[],
        pickupLat: number,
        pickupLng: number
    ): Promise<Map<string, DistanceMatrixResult>> {
        const results = new Map<string, DistanceMatrixResult>();
        if (origins.length === 0) return results;

        // =====================================================================
        // STEP 1: Check Redis cache for ALL origins
        // =====================================================================
        const cacheMisses: OriginWithId[] = [];

        await Promise.all(origins.map(async (origin) => {
            const cacheKey = this.buildCacheKey(origin.lat, origin.lng, pickupLat, pickupLng);
            try {
                const cached = await redisService.get(cacheKey);
                if (cached) {
                    const parsed = JSON.parse(cached);
                    results.set(origin.id, {
                        durationSeconds: parsed.durationSeconds,
                        distanceMeters: parsed.distanceMeters,
                        cached: true,
                        source: 'cache'
                    });
                    return;
                }
            } catch { /* Redis error — treat as miss */ }
            cacheMisses.push(origin);
        }));

        // If all origins were cached, return immediately
        if (cacheMisses.length === 0) {
            logger.debug(`[DistanceMatrix] All ${origins.length} origins served from cache`);
            return results;
        }

        // =====================================================================
        // STEP 2: API key check (fast fail — no point chunking without key)
        // =====================================================================
        const apiKey = config.googleMaps.apiKey;
        if (!apiKey) {
            logger.debug('[DistanceMatrix] No API key → haversine fallback');
            for (const origin of cacheMisses) {
                results.set(origin.id, this.haversineFallback(origin.lat, origin.lng, pickupLat, pickupLng));
            }
            return results;
        }

        // =====================================================================
        // STEP 3: Batch API calls — chunk into groups of 25
        // Rate limit per chunk: consume tokens = element count (not 1 per batch).
        // Google bills per element (60,000 EPM = 1,000 EPS).
        // If a chunk exceeds budget → haversine for that chunk only.
        // =====================================================================
        for (let i = 0; i < cacheMisses.length; i += MAX_ORIGINS_PER_REQUEST) {
            const chunk = cacheMisses.slice(i, i + MAX_ORIGINS_PER_REQUEST);

            // Per-chunk rate limit: consume tokens equal to element count
            if (!rateLimiter.tryConsume(chunk.length)) {
                logger.debug(`[DistanceMatrix] Rate limited → haversine for ${chunk.length} elements (tokens insufficient)`);
                for (const origin of chunk) {
                    results.set(origin.id, this.haversineFallback(origin.lat, origin.lng, pickupLat, pickupLng));
                }
                continue; // Try next chunk (tokens may have refilled)
            }

            try {
                const batchResults = await this.callDistanceMatrixBatch(chunk, pickupLat, pickupLng, apiKey);

                // Store results + cache each individually
                for (const [id, result] of batchResults) {
                    results.set(id, result);

                    // Cache the successful result
                    const origin = chunk.find(o => o.id === id);
                    if (origin && result.source === 'distance_matrix') {
                        const cacheKey = this.buildCacheKey(origin.lat, origin.lng, pickupLat, pickupLng);
                        redisService.set(cacheKey, JSON.stringify({
                            durationSeconds: result.durationSeconds,
                            distanceMeters: result.distanceMeters
                        }), CACHE_TTL_SECONDS).catch(() => { });
                    }
                }
            } catch (error: any) {
                // Entire chunk failed → haversine for all origins in this chunk
                logger.warn(`[DistanceMatrix] Batch API failed → haversine for ${chunk.length} origins: ${error.message}`);
                for (const origin of chunk) {
                    results.set(origin.id, this.haversineFallback(origin.lat, origin.lng, pickupLat, pickupLng));
                }
            }
        }

        const cacheHits = origins.length - cacheMisses.length;
        const apiCalls = Math.ceil(cacheMisses.length / MAX_ORIGINS_PER_REQUEST);
        logger.info(`[DistanceMatrix] Batch: ${origins.length} origins, ${cacheHits} cache hits, ${cacheMisses.length} API lookups in ${apiCalls} call(s)`);

        return results;
    }

    // ===========================================================================
    // PRIVATE — BATCHED GOOGLE DISTANCE MATRIX API CALL
    // Sends up to 25 origins in one request (pipe-separated)
    // Response: data.rows[i].elements[0] for each origin i
    // ===========================================================================

    private async callDistanceMatrixBatch(
        origins: OriginWithId[],
        destLat: number,
        destLng: number,
        apiKey: string
    ): Promise<Map<string, DistanceMatrixResult>> {
        const results = new Map<string, DistanceMatrixResult>();

        // Build pipe-separated origins string: lat1,lng1|lat2,lng2|...
        const originsStr = origins.map(o => `${o.lat},${o.lng}`).join('|');
        const destination = `${destLat},${destLng}`;

        const url = `https://maps.googleapis.com/maps/api/distancematrix/json` +
            `?origins=${encodeURIComponent(originsStr)}` +
            `&destinations=${encodeURIComponent(destination)}` +
            `&mode=driving` +
            `&key=${apiKey}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

        try {
            const response = await fetch(url, { signal: controller.signal });
            const data: any = await response.json();

            if (data.status !== 'OK') {
                throw new Error(`Distance Matrix API returned: ${data.status}`);
            }

            // Parse per-origin results: data.rows[i].elements[0]
            for (let i = 0; i < origins.length; i++) {
                const origin = origins[i];
                const element = data.rows?.[i]?.elements?.[0];

                if (element?.status === 'OK' && element.duration && element.distance) {
                    results.set(origin.id, {
                        durationSeconds: element.duration.value,
                        distanceMeters: element.distance.value,
                        cached: false,
                        source: 'distance_matrix'
                    });
                } else {
                    // Individual element failed (e.g., ZERO_RESULTS) → haversine for this one
                    results.set(origin.id, this.haversineFallback(origin.lat, origin.lng, destLat, destLng));
                }
            }
        } finally {
            clearTimeout(timeout);
        }

        return results;
    }

    // ===========================================================================
    // PRIVATE — HAVERSINE FALLBACK (instant, always available)
    // ===========================================================================

    private haversineFallback(
        originLat: number,
        originLng: number,
        destLat: number,
        destLng: number
    ): DistanceMatrixResult {
        const distanceKm = this.haversineKm(originLat, originLng, destLat, destLng);
        // FIX #34: Env-configurable speed and road factor (shared with candidate-scorer).
        // Defaults match Indian urban truck patterns (Ballou et al. 2002).
        // Now uses shared CIRCUITY_FACTORS for single source of truth.
        const roadFactor = CIRCUITY_FACTORS.ETA_RANKING;
        const avgSpeedKmh = Math.max(1, parseInt(process.env.HAVERSINE_AVG_SPEED_KMH || '30', 10) || 30);
        const roadDistanceKm = distanceKm * roadFactor;
        const durationSeconds = (roadDistanceKm / avgSpeedKmh) * 3600;

        return {
            durationSeconds: Math.round(durationSeconds),
            distanceMeters: Math.round(roadDistanceKm * 1000),
            cached: false,
            source: 'haversine_fallback'
        };
    }

    // ===========================================================================
    // PRIVATE — CACHE KEY
    // ===========================================================================

    private buildCacheKey(oLat: number, oLng: number, dLat: number, dLng: number): string {
        return `${CACHE_PREFIX}:${oLat.toFixed(COORD_PRECISION)},${oLng.toFixed(COORD_PRECISION)}:${dLat.toFixed(COORD_PRECISION)},${dLng.toFixed(COORD_PRECISION)}`;
    }

    // ===========================================================================
    // PRIVATE — HAVERSINE FORMULA
    // ===========================================================================

    private haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
}

// =============================================================================
// SINGLETON EXPORT
// =============================================================================

export const distanceMatrixService = new DistanceMatrixService();
