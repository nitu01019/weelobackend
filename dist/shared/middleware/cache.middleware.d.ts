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
import { Request, Response, NextFunction } from 'express';
/**
 * Simple in-memory cache
 * Replace with Redis for horizontal scaling:
 *
 * import { createClient } from 'redis';
 * const redis = createClient({ url: process.env.REDIS_URL });
 */
declare class MemoryCache {
    private cache;
    private maxSize;
    private cleanupInterval;
    constructor(maxSize?: number);
    /**
     * Get cached value
     */
    get(key: string): any | null;
    /**
     * Set cached value with TTL
     */
    set(key: string, data: any, ttlSeconds: number, etag?: string): void;
    /**
     * Delete cached value
     */
    delete(key: string): boolean;
    /**
     * Delete by pattern (e.g., "booking:*")
     */
    deleteByPattern(pattern: string): number;
    /**
     * Clear all cache
     */
    clear(): void;
    /**
     * Get cache stats
     */
    getStats(): {
        size: number;
        maxSize: number;
    };
    /**
     * Cleanup expired entries periodically
     */
    private startCleanup;
    /**
     * Stop cleanup interval
     */
    destroy(): void;
}
export declare const cache: MemoryCache;
/**
 * Cache middleware factory
 *
 * Usage:
 * app.get('/api/pricing', cacheMiddleware(300), pricingController);
 *
 * @param ttlSeconds - Time to live in seconds
 * @param keyGenerator - Optional custom key generator
 */
export declare function cacheMiddleware(ttlSeconds?: number, keyGenerator?: (req: Request) => string): (req: Request, res: Response, next: NextFunction) => void;
/**
 * Cache invalidation helper
 * Call after mutations to invalidate related cache
 *
 * Usage:
 * await invalidateCache('booking:*'); // Invalidate all booking cache
 */
export declare function invalidateCache(pattern: string): number;
/**
 * Cache key generators for common patterns
 */
export declare const cacheKeyGenerators: {
    userSpecific: (req: Request) => string;
    public: (req: Request) => string;
    locationBased: (req: Request) => string;
};
export {};
//# sourceMappingURL=cache.middleware.d.ts.map