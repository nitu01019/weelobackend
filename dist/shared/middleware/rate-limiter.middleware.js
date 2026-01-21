"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.trackingRateLimiter = exports.profileRateLimiter = exports.otpRateLimiter = exports.authRateLimiter = exports.rateLimiter = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const environment_1 = require("../../config/environment");
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
exports.rateLimiter = (0, express_rate_limit_1.default)({
    windowMs: environment_1.config.rateLimit.windowMs,
    max: environment_1.config.rateLimit.maxRequests,
    message: {
        success: false,
        error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests. Please try again later.'
        }
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Skip rate limiting in development if needed
    skip: () => environment_1.config.isDevelopment && false // Set to true to disable in dev
});
/**
 * Strict rate limiter for auth endpoints
 * 10 requests per 15 minutes per IP (allows retries)
 */
exports.authRateLimiter = (0, express_rate_limit_1.default)({
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
    legacyHeaders: false
});
/**
 * OTP rate limiter - PRODUCTION READY FOR MILLIONS
 * 5 OTP requests per 10 minutes per phone number
 *
 * This is keyed by PHONE NUMBER, not IP - so millions of users
 * can request OTPs simultaneously from different phones.
 * Each phone gets its own rate limit bucket.
 */
exports.otpRateLimiter = (0, express_rate_limit_1.default)({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 5, // 5 OTPs per phone per 10 minutes
    keyGenerator: (req) => {
        // Rate limit by phone number - allows millions of concurrent users
        // Each phone number gets its own bucket
        const phone = req.body?.phone || '';
        return `otp:${phone}`;
    },
    message: {
        success: false,
        error: {
            code: 'OTP_RATE_LIMIT_EXCEEDED',
            message: 'Too many OTP requests for this phone. Please try again in 10 minutes.'
        }
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Don't skip in production - OTP abuse is critical to prevent
    skip: () => false
});
/**
 * Profile update rate limiter
 * 30 requests per minute per user (allows rapid saves)
 */
exports.profileRateLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000, // 1 minute
    max: 30,
    keyGenerator: (req) => {
        // Rate limit by user ID for authenticated requests
        return `profile:${req.user?.userId || req.ip || 'unknown'}`;
    },
    message: {
        success: false,
        error: {
            code: 'PROFILE_RATE_LIMIT_EXCEEDED',
            message: 'Too many profile updates. Please wait a moment.'
        }
    },
    standardHeaders: true,
    legacyHeaders: false
});
/**
 * Tracking updates rate limiter
 * 120 requests per minute (2 per second) per driver
 * Allows for GPS updates every 500ms
 */
exports.trackingRateLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000, // 1 minute
    max: 120, // 2 per second
    keyGenerator: (req) => {
        // Rate limit by user ID for authenticated requests
        return `tracking:${req.user?.userId || req.ip || 'unknown'}`;
    },
    message: {
        success: false,
        error: {
            code: 'TRACKING_RATE_LIMIT_EXCEEDED',
            message: 'Too many location updates. Maximum 2 per second.'
        }
    },
    standardHeaders: true,
    legacyHeaders: false
});
//# sourceMappingURL=rate-limiter.middleware.js.map