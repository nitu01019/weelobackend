"use strict";
/**
 * =============================================================================
 * CACHE SERVICE - Redis-Ready Caching Layer
 * =============================================================================
 *
 * Abstraction layer for caching that supports both:
 * - In-memory storage (development, single server)
 * - Redis storage (production, horizontal scaling)
 *
 * WHY THIS MATTERS FOR MILLIONS OF USERS:
 * - In-memory storage only works on a single server
 * - With multiple servers (load balanced), in-memory data isn't shared
 * - Redis provides a shared cache across all server instances
 * - OTPs, refresh tokens, rate limits all need to be shared
 *
 * HOW TO USE:
 * 1. Development: Just run the server, in-memory storage is used by default
 * 2. Production: Set REDIS_ENABLED=true and REDIS_URL in environment
 *
 * FOR BACKEND DEVELOPERS:
 * - Import { cacheService } from './cache.service'
 * - Use cacheService.set(), get(), delete() for all caching needs
 * - The service automatically uses Redis or in-memory based on config
 *
 * @module cache.service
 * =============================================================================
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheService = void 0;
const environment_1 = require("../../config/environment");
const logger_service_1 = require("./logger.service");
// =============================================================================
// IN-MEMORY CACHE (Development / Single Server)
// =============================================================================
class InMemoryCache {
    store = new Map();
    constructor() {
        // Run cleanup every 60 seconds to remove expired entries
        setInterval(() => this.cleanup(), 60000);
        logger_service_1.logger.info('📦 In-memory cache initialized');
    }
    async get(key) {
        const entry = this.store.get(key);
        if (!entry)
            return null;
        // Check if expired
        if (entry.expiresAt && Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return null;
        }
        return entry.value;
    }
    async set(key, value, ttlSeconds) {
        const entry = { value };
        if (ttlSeconds && ttlSeconds > 0) {
            entry.expiresAt = Date.now() + (ttlSeconds * 1000);
        }
        this.store.set(key, entry);
    }
    async delete(key) {
        return this.store.delete(key);
    }
    async exists(key) {
        const value = await this.get(key);
        return value !== null;
    }
    async keys(pattern) {
        // Simple pattern matching (supports * wildcard)
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        const matchingKeys = [];
        for (const key of this.store.keys()) {
            if (regex.test(key)) {
                // Check if not expired
                const entry = this.store.get(key);
                if (entry && (!entry.expiresAt || Date.now() <= entry.expiresAt)) {
                    matchingKeys.push(key);
                }
            }
        }
        return matchingKeys;
    }
    async clear() {
        this.store.clear();
    }
    cleanup() {
        const now = Date.now();
        let cleaned = 0;
        for (const [key, entry] of this.store.entries()) {
            if (entry.expiresAt && now > entry.expiresAt) {
                this.store.delete(key);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            logger_service_1.logger.debug(`Cache cleanup: removed ${cleaned} expired entries`);
        }
    }
    // Get cache stats (for debugging)
    getStats() {
        return {
            size: this.store.size,
            keys: Array.from(this.store.keys())
        };
    }
}
// =============================================================================
// REDIS CACHE (Production / Horizontal Scaling)
// =============================================================================
class RedisCache {
    client = null;
    isConnected = false;
    constructor() {
        this.initialize();
    }
    async initialize() {
        try {
            // Dynamic import to avoid loading Redis if not used
            const { createClient } = await Promise.resolve().then(() => __importStar(require('redis')));
            this.client = createClient({
                url: environment_1.config.redis.url,
                socket: {
                    reconnectStrategy: (retries) => {
                        if (retries > 10) {
                            logger_service_1.logger.error('Redis: Max reconnection attempts reached');
                            return new Error('Max reconnection attempts reached');
                        }
                        return Math.min(retries * 100, 3000);
                    }
                }
            });
            this.client.on('error', (err) => {
                logger_service_1.logger.error('Redis error:', err);
                this.isConnected = false;
            });
            this.client.on('connect', () => {
                logger_service_1.logger.info('🔴 Redis connected');
                this.isConnected = true;
            });
            this.client.on('reconnecting', () => {
                logger_service_1.logger.warn('Redis reconnecting...');
            });
            await this.client.connect();
        }
        catch (error) {
            logger_service_1.logger.error('Failed to initialize Redis:', error);
            throw error;
        }
    }
    async get(key) {
        if (!this.isConnected)
            return null;
        return await this.client.get(key);
    }
    async set(key, value, ttlSeconds) {
        if (!this.isConnected)
            return;
        if (ttlSeconds && ttlSeconds > 0) {
            await this.client.setEx(key, ttlSeconds, value);
        }
        else {
            await this.client.set(key, value);
        }
    }
    async delete(key) {
        if (!this.isConnected)
            return false;
        const result = await this.client.del(key);
        return result > 0;
    }
    async exists(key) {
        if (!this.isConnected)
            return false;
        const result = await this.client.exists(key);
        return result > 0;
    }
    async keys(pattern) {
        if (!this.isConnected)
            return [];
        return await this.client.keys(pattern);
    }
    async clear() {
        if (!this.isConnected)
            return;
        await this.client.flushDb();
    }
}
// =============================================================================
// CACHE SERVICE (Unified Interface)
// =============================================================================
class CacheService {
    cache;
    prefix = 'weelo:';
    constructor() {
        // Use Redis if enabled, otherwise use in-memory
        if (environment_1.config.redis.enabled) {
            logger_service_1.logger.info('🔴 Initializing Redis cache for production scalability');
            this.cache = new RedisCache();
        }
        else {
            logger_service_1.logger.info('📦 Using in-memory cache (enable Redis for production)');
            this.cache = new InMemoryCache();
        }
    }
    /**
     * Get value from cache
     */
    async get(key) {
        const value = await this.cache.get(this.prefix + key);
        if (!value)
            return null;
        try {
            return JSON.parse(value);
        }
        catch {
            return value;
        }
    }
    /**
     * Set value in cache
     * @param key - Cache key
     * @param value - Value to store (will be JSON stringified)
     * @param ttlSeconds - Time to live in seconds (optional)
     */
    async set(key, value, ttlSeconds) {
        const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
        await this.cache.set(this.prefix + key, stringValue, ttlSeconds);
    }
    /**
     * Delete value from cache
     */
    async delete(key) {
        return await this.cache.delete(this.prefix + key);
    }
    /**
     * Check if key exists
     */
    async exists(key) {
        return await this.cache.exists(this.prefix + key);
    }
    /**
     * Get all keys matching pattern
     */
    async keys(pattern) {
        const keys = await this.cache.keys(this.prefix + pattern);
        return keys.map(k => k.replace(this.prefix, ''));
    }
    /**
     * Clear all cache (use with caution!)
     */
    async clear() {
        await this.cache.clear();
    }
    // ===========================================================================
    // CONVENIENCE METHODS FOR COMMON USE CASES
    // ===========================================================================
    /**
     * Store OTP with automatic expiry
     */
    async setOTP(phone, role, hashedOtp, expiryMinutes = 5) {
        const key = `otp:${phone}:${role}`;
        await this.set(key, {
            hashedOtp,
            attempts: 0,
            createdAt: new Date().toISOString()
        }, expiryMinutes * 60);
    }
    /**
     * Get OTP data
     */
    async getOTP(phone, role) {
        const key = `otp:${phone}:${role}`;
        return await this.get(key);
    }
    /**
     * Increment OTP attempts
     */
    async incrementOTPAttempts(phone, role) {
        const key = `otp:${phone}:${role}`;
        const data = await this.get(key);
        if (!data)
            return -1;
        data.attempts++;
        // Keep same TTL by not specifying it (Redis will keep existing TTL)
        await this.set(key, data, 5 * 60); // Reset TTL to 5 minutes
        return data.attempts;
    }
    /**
     * Delete OTP
     */
    async deleteOTP(phone, role) {
        const key = `otp:${phone}:${role}`;
        await this.delete(key);
    }
    /**
     * Store refresh token
     */
    async setRefreshToken(token, userId, expiryDays = 30) {
        const key = `refresh:${token}`;
        await this.set(key, { userId, createdAt: new Date().toISOString() }, expiryDays * 24 * 60 * 60);
    }
    /**
     * Get refresh token data
     */
    async getRefreshToken(token) {
        const key = `refresh:${token}`;
        return await this.get(key);
    }
    /**
     * Delete refresh token
     */
    async deleteRefreshToken(token) {
        const key = `refresh:${token}`;
        await this.delete(key);
    }
    /**
     * Delete all refresh tokens for a user (logout from all devices)
     */
    async deleteAllUserRefreshTokens(userId) {
        const keys = await this.keys('refresh:*');
        for (const key of keys) {
            const data = await this.get(`refresh:${key.replace('refresh:', '')}`);
            if (data && data.userId === userId) {
                await this.delete(key);
            }
        }
    }
}
// Export singleton instance
exports.cacheService = new CacheService();
// =============================================================================
// USAGE EXAMPLES FOR BACKEND DEVELOPERS
// =============================================================================
/**
 * STORING AND RETRIEVING OTPs:
 * ```typescript
 * import { cacheService } from './cache.service';
 *
 * // Store OTP (automatically expires in 5 minutes)
 * await cacheService.setOTP('9876543210', 'customer', hashedOtp);
 *
 * // Get OTP
 * const otpData = await cacheService.getOTP('9876543210', 'customer');
 * if (otpData) {
 *   console.log(otpData.hashedOtp, otpData.attempts);
 * }
 *
 * // Delete OTP after successful verification
 * await cacheService.deleteOTP('9876543210', 'customer');
 * ```
 *
 * STORING REFRESH TOKENS:
 * ```typescript
 * // Store refresh token (expires in 30 days)
 * await cacheService.setRefreshToken(token, userId);
 *
 * // Validate refresh token
 * const data = await cacheService.getRefreshToken(token);
 * if (data && data.userId === expectedUserId) {
 *   // Token is valid
 * }
 *
 * // Logout from all devices
 * await cacheService.deleteAllUserRefreshTokens(userId);
 * ```
 *
 * GENERIC CACHING:
 * ```typescript
 * // Cache any data with TTL
 * await cacheService.set('user:123:profile', userProfile, 3600); // 1 hour
 *
 * // Retrieve cached data
 * const profile = await cacheService.get<UserProfile>('user:123:profile');
 * ```
 */
//# sourceMappingURL=cache.service.js.map