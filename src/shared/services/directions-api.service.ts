/**
 * =============================================================================
 * DIRECTIONS API SERVICE — Single Route Calculation via Google Directions API
 * =============================================================================
 *
 * Google Directions API — single route calculation with polyline.
 * Used for: server-side distance/duration verification of customer-provided route.
 * Cache: 3 minutes per route (geohash6 precision for cache sharing).
 *
 * NOTE: distance-matrix.service.ts handles BATCH ETA lookups for matching
 * (up to 25 origins per request). These are separate Google APIs with different
 * pricing and use cases. Do NOT consolidate — they serve different purposes.
 *
 * WHAT THIS DOES:
 * Fetches road-time ETA (duration in traffic) between two geographic points
 * using Google Directions API. Results are cached in Redis for 3 minutes
 * to minimize API calls and latency.
 *
 * PHASE 5: Circuit breaker wraps Google API call. When circuit opens after\n * repeated failures, skips the API entirely (saves 300ms timeout) and goes\n * straight to haversine fallback.\n *
 * WHY GOOGLE DIRECTIONS OVER HAVERSINE:
 * - Haversine gives straight-line distance — useless in cities with one-way
 *   roads, bridges, flyovers, and no-entry zones
 * - Directions API gives real road-time ETA with live traffic
 * - Critical for accurate dispatch — a transporter 2km away by air could
 *   be 15 minutes away by road, while one 5km away could be 5 minutes
 *
 * CACHING STRATEGY:
 * - Cache key: directions:{originGeohash}:{destGeohash} (geohash6 precision)
 * - TTL: 180 seconds (3 minutes) — traffic changes slowly at this granularity
 * - Geohash6 precision: ~1.2km — close-enough transporters share cache
 * - Hit rate in dense cities: ~60-80% (many transporters near same roads)
 *
 * RATE LIMITING:
 * - Google Directions API: 50 QPS standard, 500 QPS premium
 * - We batch top-20 candidates only (not all 200+ candidates)
 * - With 3-min cache at geohash6, effective QPS is very low
 *
 * FEATURE FLAG:
 * - FF_DIRECTIONS_API_SCORING_ENABLED defaults to ON (true) when env var is unset
 * - Set to 'false' explicitly to disable Google Directions API scoring
 * - When disabled: Haversine distance scoring (zero API calls)
 * - When enabled: Google Directions for top-N, Haversine for rest
 *
 * LATENCY IMPACT:
 * - Cache hit: ~1ms (Redis GET)
 * - Cache miss: ~200-400ms (Google API call + Redis SET)
 * - Called ONLY for top-20 candidates (not all 200+)
 * - Runs in parallel with broadcast prep — NOT on hot path
 *
 * @author Weelo Engineering
 * @version 1.0.0
 * =============================================================================
 */

import { redisService } from './redis.service';
import { logger } from './logger.service';
import { config } from '../../config/environment';
import { CIRCUITY_FACTORS } from '../utils/geospatial.utils';

// =============================================================================
// CONSTANTS
// =============================================================================

// FF_DIRECTIONS_API_SCORING_ENABLED: defaults to ON (true) when env var is unset.
// Set to 'false' explicitly to disable Google Directions API scoring.
export const FF_DIRECTIONS_API_SCORING_ENABLED =
    process.env.FF_DIRECTIONS_API_SCORING_ENABLED !== 'false';

/** Cache TTL — 3 minutes (traffic changes slowly at geohash6 granularity) */
const CACHE_TTL_SECONDS = 180;

/** Cache key prefix */
const CACHE_PREFIX = 'directions';

/** Max concurrent API calls per batch (in-flight parallelism) */
const MAX_CONCURRENT_API_CALLS = 10;

/** API timeout per request (ms) — 2s: fast fail on slow network */
const API_TIMEOUT_MS = 2000;

/** Coordinate precision for cache key (2 decimal places ≈ ~1.1km for cache sharing) */
const GEOHASH_PRECISION = 2;

/**
 * Google Directions API QPS limit (configurable via env).
 * Standard: 50 QPS, Premium: 500 QPS. Default: 450 (leaves 10% headroom).
 * When rate limit is exceeded, falls back to haversine immediately.
 */
const DIRECTIONS_API_MAX_QPS = Math.max(
    10,
    parseInt(process.env.DIRECTIONS_API_MAX_QPS || '450', 10) || 450
);

// =============================================================================
// TOKEN-BUCKET RATE LIMITER
// Industry standard QPS guard — Uber/Google internal services use this pattern.
// When bucket is empty we fall back to haversine (zero wait, zero latency spike).
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

    /** Try to consume one token. Returns true if allowed, false if rate limited. */
    tryConsume(): boolean {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        // Refill tokens proportional to elapsed time
        this.tokens = Math.min(
            this.maxTokens,
            this.tokens + elapsed * this.refillRatePerMs
        );
        this.lastRefill = now;

        if (this.tokens >= 1) {
            this.tokens -= 1;
            return true;
        }
        return false; // Rate limited — caller falls back to haversine
    }
}

/** Single shared rate limiter for the entire process */
const directionsRateLimiter = new TokenBucket(DIRECTIONS_API_MAX_QPS);

// =============================================================================
// TYPES
// =============================================================================

export interface DirectionsResult {
    /** Duration in seconds (real road-time) */
    durationSeconds: number;
    /** Distance in meters (road distance, not straight-line) */
    distanceMeters: number;
    /** Whether this came from cache */
    cached: boolean;
    /** Source: 'google_api' | 'haversine_fallback' | 'cache' */
    source: string;
}

// =============================================================================
// SERVICE CLASS
// =============================================================================

class DirectionsApiService {

    /**
     * Get road-time ETA from origin to destination.
     * Uses Redis cache first, falls back to Google API, then Haversine.
     *
     * @param originLat - Origin latitude (transporter location)
     * @param originLng - Origin longitude
     * @param destLat - Destination latitude (pickup location)
     * @param destLng - Destination longitude
     * @returns DirectionsResult with duration and distance
     */
    async getEta(
        originLat: number,
        originLng: number,
        destLat: number,
        destLng: number
    ): Promise<DirectionsResult> {
        // 1. Check cache first
        const cacheKey = this.buildCacheKey(originLat, originLng, destLat, destLng);

        try {
            const cached = await redisService.get(cacheKey);
            if (cached) {
                const parsed = JSON.parse(cached);
                return { ...parsed, cached: true, source: 'cache' };
            }
        } catch {
            // Cache miss or error — continue to API
        }

        // 2. Check rate limit BEFORE calling Google API
        // Phase 6 production hardening: token bucket prevents QPS overrun.
        // When depleted → instant haversine fallback (no queuing, no latency spike)
        if (FF_DIRECTIONS_API_SCORING_ENABLED && config.googleMaps.apiKey) {
            if (!directionsRateLimiter.tryConsume()) {
                // Rate limited — haversine fallback is instant
                logger.debug('[DirectionsAPI] Rate limit hit, using haversine fallback');
                return this.haversineFallback(originLat, originLng, destLat, destLng);
            }
            const { directionsCircuit } = require('./circuit-breaker.service');
            try {
                const result = await directionsCircuit.tryWithFallback(
                    async () => {
                        const apiResult = await this.callGoogleDirections(
                            originLat, originLng, destLat, destLng
                        );
                        // Cache the result
                        await redisService.set(cacheKey, JSON.stringify({
                            durationSeconds: apiResult.durationSeconds,
                            distanceMeters: apiResult.distanceMeters
                        }), CACHE_TTL_SECONDS).catch(() => { });
                        return apiResult;
                    },
                    async () => {
                        return this.haversineFallback(originLat, originLng, destLat, destLng);
                    }
                );
                return result;
            } catch (error: any) {
                logger.warn(`[DirectionsAPI] Circuit breaker error, falling back to Haversine: ${error.message}`);
            }
        }

        // 3. Fallback: Haversine approximation
        return this.haversineFallback(originLat, originLng, destLat, destLng);
    }

    /**
     * Batch ETA lookup for multiple origins to a single destination.
     * Runs calls in parallel with concurrency limit.
     *
     * @param origins - Array of {lat, lng, id} for each transporter
     * @param destLat - Pickup latitude
     * @param destLng - Pickup longitude
     * @returns Map of transporterId → DirectionsResult
     */
    async batchGetEta(
        origins: Array<{ lat: number; lng: number; id: string }>,
        destLat: number,
        destLng: number
    ): Promise<Map<string, DirectionsResult>> {
        const results = new Map<string, DirectionsResult>();

        // Process in chunks to respect concurrency limits
        for (let i = 0; i < origins.length; i += MAX_CONCURRENT_API_CALLS) {
            const chunk = origins.slice(i, i + MAX_CONCURRENT_API_CALLS);
            const chunkResults = await Promise.all(
                chunk.map(async (origin) => {
                    const result = await this.getEta(origin.lat, origin.lng, destLat, destLng);
                    return { id: origin.id, result };
                })
            );

            for (const { id, result } of chunkResults) {
                results.set(id, result);
            }
        }

        return results;
    }

    // ===========================================================================
    // PRIVATE — GOOGLE DIRECTIONS API CALL
    // ===========================================================================

    private async callGoogleDirections(
        originLat: number,
        originLng: number,
        destLat: number,
        destLng: number
    ): Promise<DirectionsResult> {
        const apiKey = config.googleMaps.apiKey;
        const url = `https://maps.googleapis.com/maps/api/directions/json` +
            `?origin=${originLat},${originLng}` +
            `&destination=${destLat},${destLng}` +
            `&mode=driving` +
            `&departure_time=now` +
            `&traffic_model=best_guess` +
            `&key=${apiKey}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

        try {
            const response = await fetch(url, { signal: controller.signal });
            const data: any = await response.json();

            if (data.status !== 'OK' || !data.routes?.[0]?.legs?.[0]) {
                throw new Error(`Directions API returned: ${data.status}`);
            }

            const leg = data.routes[0].legs[0];

            // Use duration_in_traffic if available (more accurate)
            const duration = leg.duration_in_traffic || leg.duration;

            return {
                durationSeconds: duration.value,
                distanceMeters: leg.distance.value,
                cached: false,
                source: 'google_api'
            };
        } finally {
            clearTimeout(timeout);
        }
    }

    // ===========================================================================
    // PRIVATE — HAVERSINE FALLBACK
    // ===========================================================================

    private haversineFallback(
        originLat: number,
        originLng: number,
        destLat: number,
        destLng: number
    ): DirectionsResult {
        const distanceKm = this.haversineKm(originLat, originLng, destLat, destLng);

        // Approximate road-time: assume 30 km/h average speed in Indian cities
        // This is a conservative estimate (real road distance is 1.3-1.5x straight line)
        // Now uses shared CIRCUITY_FACTORS for single source of truth.
        const roadDistanceKm = distanceKm * CIRCUITY_FACTORS.ETA_RANKING;
        const durationSeconds = (roadDistanceKm / 30) * 3600; // 30 km/h avg

        return {
            durationSeconds: Math.round(durationSeconds),
            distanceMeters: Math.round(roadDistanceKm * 1000),
            cached: false,
            source: 'haversine_fallback'
        };
    }

    // ===========================================================================
    // PRIVATE — CACHE KEY BUILDER
    // ===========================================================================

    private buildCacheKey(
        originLat: number,
        originLng: number,
        destLat: number,
        destLng: number
    ): string {
        // Quantize to ~1.1km precision for better cache hit rate between nearby drivers
        const oLat = originLat.toFixed(GEOHASH_PRECISION);
        const oLng = originLng.toFixed(GEOHASH_PRECISION);
        const dLat = destLat.toFixed(GEOHASH_PRECISION);
        const dLng = destLng.toFixed(GEOHASH_PRECISION);
        return `${CACHE_PREFIX}:${oLat},${oLng}:${dLat},${dLng}`;
    }

    // ===========================================================================
    // PRIVATE — HAVERSINE DISTANCE
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

export const directionsApiService = new DirectionsApiService();
