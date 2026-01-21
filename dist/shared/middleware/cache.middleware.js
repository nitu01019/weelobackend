"use strict";
/**
 * =============================================================================
 * CACHE MIDDLEWARE
 * =============================================================================
 *
 * In-memory caching for high-performance API responses.
 *
 * SCALABILITY (For millions of users):
 * - In-memory cache for single instance (current)
 * - Ready for Redis upgrade (see comments)
 * - TTL-based automatic expiration
 * - Cache invalidation support
 *
 * PERFORMANCE:
 * - Sub-millisecond cache hits
 * - Reduces database load
 * - Configurable per-route
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheKeyGenerators = exports.cache = void 0;
exports.cacheMiddleware = cacheMiddleware;
exports.invalidateCache = invalidateCache;
const logger_service_1 = require("../services/logger.service");
/**
 * Simple in-memory cache
 * Replace with Redis for horizontal scaling:
 *
 * import { createClient } from 'redis';
 * const redis = createClient({ url: process.env.REDIS_URL });
 */
class MemoryCache {
    cache = new Map();
    maxSize;
    cleanupInterval = null;
    constructor(maxSize = 10000) {
        this.maxSize = maxSize;
        this.startCleanup();
    }
    /**
     * Get cached value
     */
    get(key) {
        const entry = this.cache.get(key);
        if (!entry)
            return null;
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            return null;
        }
        return entry.data;
    }
    /**
     * Set cached value with TTL
     */
    set(key, data, ttlSeconds, etag) {
        // Evict oldest entries if cache is full
        if (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey)
                this.cache.delete(oldestKey);
        }
        this.cache.set(key, {
            data,
            expiresAt: Date.now() + (ttlSeconds * 1000),
            etag,
        });
    }
    /**
     * Delete cached value
     */
    delete(key) {
        return this.cache.delete(key);
    }
    /**
     * Delete by pattern (e.g., "booking:*")
     */
    deleteByPattern(pattern) {
        let deleted = 0;
        const regex = new RegExp(pattern.replace('*', '.*'));
        for (const key of this.cache.keys()) {
            if (regex.test(key)) {
                this.cache.delete(key);
                deleted++;
            }
        }
        return deleted;
    }
    /**
     * Clear all cache
     */
    clear() {
        this.cache.clear();
    }
    /**
     * Get cache stats
     */
    getStats() {
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
        };
    }
    /**
     * Cleanup expired entries periodically
     */
    startCleanup() {
        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            for (const [key, entry] of this.cache.entries()) {
                if (now > entry.expiresAt) {
                    this.cache.delete(key);
                }
            }
        }, 60000); // Every minute
    }
    /**
     * Stop cleanup interval
     */
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
    }
}
// Global cache instance
exports.cache = new MemoryCache();
/**
 * Cache middleware factory
 *
 * Usage:
 * app.get('/api/pricing', cacheMiddleware(300), pricingController);
 *
 * @param ttlSeconds - Time to live in seconds
 * @param keyGenerator - Optional custom key generator
 */
function cacheMiddleware(ttlSeconds = 60, keyGenerator) {
    return (req, res, next) => {
        // Only cache GET requests
        if (req.method !== 'GET') {
            next();
            return;
        }
        // Generate cache key
        const cacheKey = keyGenerator
            ? keyGenerator(req)
            : `${req.originalUrl}:${req.headers['authorization']?.substring(0, 20) || 'anon'}`;
        // Check cache
        const cached = exports.cache.get(cacheKey);
        if (cached) {
            logger_service_1.logger.debug('Cache hit', { key: cacheKey });
            res.setHeader('X-Cache', 'HIT');
            res.json(cached);
            return;
        }
        // Store original json method
        const originalJson = res.json.bind(res);
        // Override json to cache response
        res.json = (body) => {
            // Only cache successful responses
            if (res.statusCode >= 200 && res.statusCode < 300) {
                exports.cache.set(cacheKey, body, ttlSeconds);
                res.setHeader('X-Cache', 'MISS');
            }
            return originalJson(body);
        };
        next();
    };
}
/**
 * Cache invalidation helper
 * Call after mutations to invalidate related cache
 *
 * Usage:
 * await invalidateCache('booking:*'); // Invalidate all booking cache
 */
function invalidateCache(pattern) {
    const deleted = exports.cache.deleteByPattern(pattern);
    logger_service_1.logger.debug('Cache invalidated', { pattern, deleted });
    return deleted;
}
/**
 * Cache key generators for common patterns
 */
exports.cacheKeyGenerators = {
    // User-specific cache (e.g., user profile)
    userSpecific: (req) => `user:${req.user?.userId}:${req.originalUrl}`,
    // Public cache (e.g., vehicle types)
    public: (req) => `public:${req.originalUrl}`,
    // Location-based cache (e.g., pricing by route)
    locationBased: (req) => {
        const { from, to } = req.query;
        return `location:${from}:${to}:${req.originalUrl}`;
    },
};
//# sourceMappingURL=cache.middleware.js.map