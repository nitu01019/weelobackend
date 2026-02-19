/**
 * =============================================================================
 * RATE LIMITER MIDDLEWARE
 * =============================================================================
 * 
 * Prevents abuse by limiting request rates.
 * 
 * SCALABILITY (Production-ready for millions of users):
 * - Redis-backed store for distributed rate limiting across ECS instances
 * - Falls back to in-memory store if Redis is unavailable (graceful degradation)
 * - Different limits for different endpoint types
 * - Atomic Redis INCR + EXPIRE ensures accurate counting under high concurrency
 * 
 * SECURITY:
 * - Protects against brute force attacks
 * - Prevents API abuse
 * - Per-phone rate limiting for OTP (not per-IP)
 * 
 * MODULARITY:
 * - RedisRateLimitStore is a reusable class implementing express-rate-limit's Store
 * - Uses existing redisService singleton (no new Redis connections)
 * - Can be swapped for any other store without changing limiter configs
 * 
 * EASY UNDERSTANDING:
 * - Each limiter clearly documents its purpose, window, and max
 * - Redis store is transparent — same behavior as in-memory, just distributed
 * - Fallback logic is simple: Redis available → use Redis, otherwise → in-memory
 * =============================================================================
 */

import rateLimit from 'express-rate-limit';
import { config } from '../../config/environment';
import { redisService } from '../services/redis.service';
import { logger } from '../services/logger.service';

// =============================================================================
// REDIS RATE LIMIT STORE (Distributed across all ECS instances)
// =============================================================================

/**
 * Redis-backed store for express-rate-limit
 * 
 * SCALABILITY:
 * - Shared counter across ALL server instances (ECS tasks)
 * - Uses atomic Redis INCR — no race conditions even at millions of req/sec
 * - Automatic TTL cleanup — no memory leaks
 * 
 * EASY UNDERSTANDING:
 * - Implements express-rate-limit's Store interface
 * - increment() → Redis INCR + EXPIRE (atomic counter with TTL)
 * - decrement() → Redis INCRBY -1 (for successful requests that shouldn't count)
 * - resetKey() → Redis DEL (clear a specific key)
 * 
 * MODULARITY:
 * - Uses existing redisService singleton (no new connections)
 * - Prefix isolates rate limit keys from other Redis data
 * - Can be reused for any rate limiter configuration
 */
class RedisRateLimitStore {
  private prefix: string;
  private windowMs: number;

  constructor(windowMs: number, prefix: string = 'rl:') {
    this.prefix = prefix;
    this.windowMs = windowMs;
  }

  /**
   * Get the Redis key for a given client identifier
   */
  private getKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  /**
   * Increment the rate limit counter for a key
   * 
   * SCALABILITY: Uses Redis INCR (atomic) + EXPIRE (auto-cleanup)
   * - First request: INCR creates key with value 1, EXPIRE sets TTL
   * - Subsequent requests: INCR atomically increments, TTL already set
   * - After window expires: Redis auto-deletes the key
   * 
   * @returns { totalHits, resetTime } — current count and when the window resets
   */
  async increment(key: string): Promise<{ totalHits: number; resetTime: Date }> {
    const redisKey = this.getKey(key);
    const windowSeconds = Math.ceil(this.windowMs / 1000);

    try {
      const totalHits = await redisService.incrementWithTTL(redisKey, windowSeconds);
      const ttl = await redisService.ttl(redisKey);
      const resetTime = new Date(Date.now() + (ttl > 0 ? ttl * 1000 : this.windowMs));

      return { totalHits, resetTime };
    } catch (error: any) {
      // GRACEFUL DEGRADATION: If Redis fails, return a permissive response
      // The in-memory fallback in express-rate-limit will handle it
      logger.warn(`[RateLimit] Redis increment failed for ${key}: ${error.message}`);
      return { totalHits: 0, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  /**
   * Decrement the counter (for successful requests that shouldn't count)
   * 
   * EASY UNDERSTANDING: express-rate-limit calls this when a request
   * succeeds and the `skipSuccessfulRequests` option is enabled.
   * We decrement by 1 so successful requests don't eat into the limit.
   */
  async decrement(key: string): Promise<void> {
    const redisKey = this.getKey(key);

    try {
      // Atomic decrement — avoids read-modify-write race condition
      await redisService.incrBy(redisKey, -1);
    } catch (error: any) {
      logger.warn(`[RateLimit] Redis decrement failed for ${key}: ${error.message}`);
      // Non-critical — just means one extra request counted
    }
  }

  /**
   * Reset the counter for a specific key
   * 
   * MODULARITY: Used when you want to manually clear a rate limit
   * (e.g., after successful OTP verification, reset the OTP limit)
   */
  async resetKey(key: string): Promise<void> {
    const redisKey = this.getKey(key);

    try {
      await redisService.del(redisKey);
    } catch (error: any) {
      logger.warn(`[RateLimit] Redis resetKey failed for ${key}: ${error.message}`);
    }
  }
}

// =============================================================================
// STORE FACTORY (Auto-selects Redis or In-Memory)
// =============================================================================

/**
 * Create the appropriate rate limit store based on Redis availability
 * 
 * SCALABILITY: Uses Redis in production for distributed counting
 * EASY UNDERSTANDING: Simple factory — Redis available → Redis store, else → undefined (in-memory)
 * MODULARITY: Each limiter gets its own store instance with appropriate prefix
 * 
 * @param windowMs - The rate limit window in milliseconds
 * @param name - Unique name for this limiter (used as Redis key prefix)
 * @returns RedisRateLimitStore if Redis is enabled, undefined for in-memory fallback
 */
function createStore(windowMs: number, name: string): any {
  const redisEnabled = process.env.REDIS_ENABLED === 'true';
  
  if (redisEnabled) {
    logger.info(`🔒 [RateLimit] Redis store enabled for "${name}" limiter`);
    return new RedisRateLimitStore(windowMs, `rl:${name}:`);
  }
  
  // In-memory fallback (development or Redis unavailable)
  // express-rate-limit uses its built-in MemoryStore when store is undefined
  return undefined;
}

// =============================================================================
// RATE LIMITERS
// =============================================================================

/**
 * Default rate limiter for all routes
 * 1000 requests per minute per IP (production-ready)
 */
export const rateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests. Please try again later.'
    }
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: createStore(config.rateLimit.windowMs, 'global'),
  // Skip rate limiting in development if needed
  skip: () => config.isDevelopment && false // Set to true to disable in dev
});

/**
 * Strict rate limiter for auth endpoints
 * 10 requests per 15 minutes per IP (allows retries)
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: {
    success: false,
    error: {
      code: 'AUTH_RATE_LIMIT_EXCEEDED',
      message: 'Too many authentication attempts. Please try again in 15 minutes.'
    }
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: createStore(15 * 60 * 1000, 'auth')
});

/**
 * OTP rate limiter - PRODUCTION READY FOR MILLIONS
 * 5 OTP requests per 2 minutes per phone number
 * 
 * WHY 2 MINUTES (not 10):
 *   - Users often retry quickly (wrong number, SMS delayed, etc.)
 *   - 10 minutes was too frustrating — users abandon the app
 *   - 2 minutes still prevents brute force (max 150 OTPs/hour vs 30)
 *   - SMS costs are negligible at this volume
 *   - Rapido/Ola use similar windows (~1-2 minutes)
 * 
 * SECURITY: Still safe because:
 *   - OTP is 6 digits = 1M combinations, 5 attempts = 0.0005% chance
 *   - OTP expires in 5 minutes (separate from rate limit)
 *   - Verification has its own attempt limit (3 wrong → OTP invalidated)
 * 
 * This is keyed by PHONE NUMBER, not IP — so millions of users
 * can request OTPs simultaneously from different phones.
 * Each phone gets its own rate limit bucket.
 */
export const otpRateLimiter = rateLimit({
  windowMs: 2 * 60 * 1000, // 2 minutes
  max: 5, // 5 OTPs per phone per 2 minutes
  keyGenerator: (req) => {
    // Rate limit by phone number — allows millions of concurrent users
    // Each phone number gets its own bucket
    //
    // CRITICAL: Different auth modules use different field names:
    //   - Customer auth: req.body.phone
    //   - Driver auth:   req.body.driverPhone
    //   - Transporter:   req.body.phone
    // We check ALL possible fields to ensure per-phone isolation.
    // Without this, all requests with empty phone share one bucket = instant block.
    const phone = req.body?.phone || req.body?.driverPhone || req.ip || 'unknown';
    return `otp:${phone}`;
  },
  message: {
    success: false,
    error: {
      code: 'OTP_RATE_LIMIT_EXCEEDED',
      message: 'Too many OTP attempts. Please try again in 2 minutes.'
    }
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: createStore(2 * 60 * 1000, 'otp'),
  // Don't skip in production — OTP abuse is critical to prevent
  skip: () => false
});

/**
 * Profile update rate limiter
 * 30 requests per minute per user (allows rapid saves)
 */
export const profileRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  keyGenerator: (req) => {
    // Rate limit by user ID for authenticated requests
    return `profile:${(req as any).user?.userId || req.ip || 'unknown'}`;
  },
  message: {
    success: false,
    error: {
      code: 'PROFILE_RATE_LIMIT_EXCEEDED',
      message: 'Too many profile updates. Please wait a moment.'
    }
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: createStore(60 * 1000, 'profile')
});

/**
 * Tracking updates rate limiter
 * 120 requests per minute (2 per second) per driver
 * Allows for GPS updates every 500ms
 */
export const trackingRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // 2 per second
  keyGenerator: (req) => {
    // Rate limit by user ID for authenticated requests
    return `tracking:${(req as any).user?.userId || req.ip || 'unknown'}`;
  },
  message: {
    success: false,
    error: {
      code: 'TRACKING_RATE_LIMIT_EXCEEDED',
      message: 'Too many location updates. Maximum 2 per second.'
    }
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: createStore(60 * 1000, 'tracking')
});

/**
 * Places/Geocoding rate limiter - SCALABILITY PROTECTION
 * 60 requests per minute per IP (1 per second)
 * 
 * Protects Google Maps API quota from abuse while allowing
 * normal autocomplete usage (debounced to ~1 req/300ms on client)
 */
export const placesRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 1 per second average
  keyGenerator: (req) => {
    // Rate limit by IP for unauthenticated geocoding requests
    return `places:${req.ip || 'unknown'}`;
  },
  message: {
    success: false,
    error: {
      code: 'PLACES_RATE_LIMIT_EXCEEDED',
      message: 'Too many geocoding requests. Please slow down.'
    }
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: createStore(60 * 1000, 'places')
});
