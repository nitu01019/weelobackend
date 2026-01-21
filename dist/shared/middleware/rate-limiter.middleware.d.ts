/**
 * =============================================================================
 * RATE LIMITER MIDDLEWARE
 * =============================================================================
 *
 * Prevents abuse by limiting request rates.
 *
 * SCALABILITY (Production-ready for millions of users):
 * - In-memory store works for single instance
 * - For horizontal scaling, use Redis store (see comments below)
 * - Different limits for different endpoint types
 *
 * SECURITY:
 * - Protects against brute force attacks
 * - Prevents API abuse
 * - Per-phone rate limiting for OTP (not per-IP)
 * =============================================================================
 */
/**
 * Production Note: For millions of users across multiple servers,
 * uncomment and configure Redis store:
 *
 * import RedisStore from 'rate-limit-redis';
 * import { createClient } from 'redis';
 * const redisClient = createClient({ url: config.redisUrl });
 * redisClient.connect();
 *
 * Then add to each limiter:
 * store: new RedisStore({ sendCommand: (...args) => redisClient.sendCommand(args) })
 */
/**
 * Default rate limiter for all routes
 * 1000 requests per minute per IP (production-ready)
 */
export declare const rateLimiter: import("express-rate-limit").RateLimitRequestHandler;
/**
 * Strict rate limiter for auth endpoints
 * 10 requests per 15 minutes per IP (allows retries)
 */
export declare const authRateLimiter: import("express-rate-limit").RateLimitRequestHandler;
/**
 * OTP rate limiter - PRODUCTION READY FOR MILLIONS
 * 5 OTP requests per 10 minutes per phone number
 *
 * This is keyed by PHONE NUMBER, not IP - so millions of users
 * can request OTPs simultaneously from different phones.
 * Each phone gets its own rate limit bucket.
 */
export declare const otpRateLimiter: import("express-rate-limit").RateLimitRequestHandler;
/**
 * Profile update rate limiter
 * 30 requests per minute per user (allows rapid saves)
 */
export declare const profileRateLimiter: import("express-rate-limit").RateLimitRequestHandler;
/**
 * Tracking updates rate limiter
 * 120 requests per minute (2 per second) per driver
 * Allows for GPS updates every 500ms
 */
export declare const trackingRateLimiter: import("express-rate-limit").RateLimitRequestHandler;
//# sourceMappingURL=rate-limiter.middleware.d.ts.map