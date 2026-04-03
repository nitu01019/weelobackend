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
import { Request, Response } from 'express';
import { config } from '../../config/environment';
import { redisService } from '../services/redis.service';
import { logger } from '../services/logger.service';

// =============================================================================
// REDIS RATE LIMIT STORE (Distributed across all ECS instances)
// =============================================================================

/**
 * Redis-backed store for express-rate-limit
 * 
 * Phase 10: Netflix/Uber-style dual-counter pattern:
 * 
 * PRIMARY: Redis (distributed, shared across ECS instances)
 * FALLBACK: In-memory Map (per-instance, still enforces limits)
 * 
 * FAIL-SAFE BEHAVIOR:
 * - Redis UP → uses Redis (distributed counting, consistent across instances)
 * - Redis DOWN → uses in-memory backup counter (per-instance, still blocks abuse)
 * - Redis RECOVERS → next request auto-uses Redis again (seamless recovery)
 * 
 * WHY NOT throw error: express-rate-limit calls next(error) → 500 for ALL users
 * WHY NOT return totalHits:0: fail-open → unlimited requests → security vulnerability
 * WHY this works: in-memory counter is cheap (Map), self-cleans via TTL, and
 *   provides per-instance rate limiting which is better than no rate limiting
 * 
 * COST: ~50 bytes per active rate limit key in memory. At 2.3M users
 *   with 1-minute windows, worst case = ~115MB (well within ECS limits)
 */
class RedisRateLimitStore {
  private prefix: string;
  private windowMs: number;
  // Phase 10: In-memory backup counter for Redis failures
  private memoryCounters = new Map<string, { hits: number; resetAt: number }>();
  private memoryCleanupInterval: ReturnType<typeof setInterval>;

  constructor(windowMs: number, prefix: string = 'rl:') {
    this.prefix = prefix;
    this.windowMs = windowMs;

    // Self-clean expired entries every 60s to prevent memory leaks
    this.memoryCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.memoryCounters) {
        if (now > entry.resetAt) {
          this.memoryCounters.delete(key);
        }
      }
    }, 60_000);
    // Don't prevent process exit
    if (this.memoryCleanupInterval.unref) {
      this.memoryCleanupInterval.unref();
    }
  }

  /**
   * Get the Redis key for a given client identifier
   */
  private getKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  /**
   * In-memory fallback counter
   * Used when Redis is unreachable — still enforces per-instance limits
   */
  private incrementMemory(key: string): { totalHits: number; resetTime: Date } {
    const now = Date.now();
    let entry = this.memoryCounters.get(key);

    if (!entry || now > entry.resetAt) {
      // New window
      entry = { hits: 1, resetAt: now + this.windowMs };
      this.memoryCounters.set(key, entry);
    } else {
      entry.hits++;
    }

    return { totalHits: entry.hits, resetTime: new Date(entry.resetAt) };
  }

  /**
   * Increment rate limit counter
   * 
   * TRIES Redis first. On failure, falls back to in-memory counter.
   * When Redis recovers, automatically switches back to Redis on next call.
   * 
   * @returns { totalHits, resetTime } — current count and when window resets
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
      // Phase 10: FAIL-CLOSED with in-memory backup (Netflix pattern)
      // - NOT throw (causes 500 errors for ALL users)
      // - NOT totalHits:0 (fail-open, security vulnerability)
      // - YES in-memory counter (per-instance, still enforces limits)
      // When Redis comes back → next call auto-uses Redis (seamless recovery)
      logger.warn(`[RateLimit] Redis failed for ${key}: ${error.message} — using in-memory counter`);
      return this.incrementMemory(key);
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

function resolveRetryAfterMs(req: Request, fallbackWindowMs: number): number {
  const rateLimitMeta = (req as any).rateLimit;
  const resetAtMs = rateLimitMeta?.resetTime instanceof Date
    ? rateLimitMeta.resetTime.getTime()
    : null;
  if (resetAtMs == null) {
    return Math.max(1000, fallbackWindowMs);
  }
  return Math.max(1000, resetAtMs - Date.now());
}

function throttleHandler(code: string, message: string, fallbackWindowMs: number) {
  return (req: Request, res: Response) => {
    const retryAfterMs = resolveRetryAfterMs(req, fallbackWindowMs);
    res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000).toString());
    res.status(429).json({
      success: false,
      error: {
        code,
        message,
        retryAfterMs
      }
    });
  };
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
  handler: throttleHandler(
    'RATE_LIMIT_EXCEEDED',
    'Too many requests. Please try again later.',
    config.rateLimit.windowMs
  ),
  standardHeaders: true,
  legacyHeaders: false,
  store: createStore(config.rateLimit.windowMs, 'global'),
  // CRITICAL FIX: Skip rate limiting for ALB/ELB health checkers and /health path.
  // ELB health checker fires every 30s from internal IPs and has no way to
  // back off — hitting 429 caused ALB to mark tasks unhealthy during deploy.
  skip: (req: Request) => {
    if (req.path === '/health' || req.path === '/health/live' || req.path === '/health/ready') {
      return true;
    }
    const ua = req.headers['user-agent'] || '';
    if (ua.includes('ELB-HealthChecker') || ua.includes('HealthChecker')) {
      return true;
    }
    return config.isDevelopment && false;
  }
});

/**
 * Strict rate limiter for auth endpoints
 * 10 requests per 15 minutes per IP (allows retries)
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  handler: throttleHandler(
    'AUTH_RATE_LIMIT_EXCEEDED',
    'Too many authentication attempts. Please try again in 15 minutes.',
    15 * 60 * 1000
  ),
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
    // Rate limit by phone number + role — allows millions of concurrent users
    // Each phone+role combination gets its own bucket
    //
    // CRITICAL: Different auth modules use different field names:
    //   - Customer auth: req.body.phone + req.body.role='customer'
    //   - Transporter:   req.body.phone + req.body.role='transporter'
    //   - Driver auth:   req.body.driverPhone (no role field, inferred as 'driver')
    // We check ALL possible fields to ensure per-phone-per-role isolation.
    // Without role, phone 1234 as Customer eats into Transporter's limit.
    const phone = req.body?.phone || req.body?.driverPhone || req.ip || 'unknown';
    const role = req.body?.role || (req.body?.driverPhone ? 'driver' : 'customer');
    return `otp:${phone}:${role}`;
  },
  handler: throttleHandler(
    'OTP_RATE_LIMIT_EXCEEDED',
    'Too many OTP attempts. Please try again in 2 minutes.',
    2 * 60 * 1000
  ),
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
    return `profile:${req.user?.userId || req.ip || 'unknown'}`;
  },
  handler: throttleHandler(
    'PROFILE_RATE_LIMIT_EXCEEDED',
    'Too many profile updates. Please wait a moment.',
    60 * 1000
  ),
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
    return `tracking:${req.user?.userId || req.ip || 'unknown'}`;
  },
  handler: throttleHandler(
    'TRACKING_RATE_LIMIT_EXCEEDED',
    'Too many location updates. Maximum 2 per second.',
    60 * 1000
  ),
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
  handler: throttleHandler(
    'PLACES_RATE_LIMIT_EXCEEDED',
    'Too many geocoding requests. Please slow down.',
    60 * 1000
  ),
  standardHeaders: true,
  legacyHeaders: false,
  store: createStore(60 * 1000, 'places')
});
