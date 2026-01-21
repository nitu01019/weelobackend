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
declare class CacheService {
    private cache;
    private prefix;
    constructor();
    /**
     * Get value from cache
     */
    get<T = string>(key: string): Promise<T | null>;
    /**
     * Set value in cache
     * @param key - Cache key
     * @param value - Value to store (will be JSON stringified)
     * @param ttlSeconds - Time to live in seconds (optional)
     */
    set(key: string, value: any, ttlSeconds?: number): Promise<void>;
    /**
     * Delete value from cache
     */
    delete(key: string): Promise<boolean>;
    /**
     * Check if key exists
     */
    exists(key: string): Promise<boolean>;
    /**
     * Get all keys matching pattern
     */
    keys(pattern: string): Promise<string[]>;
    /**
     * Clear all cache (use with caution!)
     */
    clear(): Promise<void>;
    /**
     * Store OTP with automatic expiry
     */
    setOTP(phone: string, role: string, hashedOtp: string, expiryMinutes?: number): Promise<void>;
    /**
     * Get OTP data
     */
    getOTP(phone: string, role: string): Promise<{
        hashedOtp: string;
        attempts: number;
    } | null>;
    /**
     * Increment OTP attempts
     */
    incrementOTPAttempts(phone: string, role: string): Promise<number>;
    /**
     * Delete OTP
     */
    deleteOTP(phone: string, role: string): Promise<void>;
    /**
     * Store refresh token
     */
    setRefreshToken(token: string, userId: string, expiryDays?: number): Promise<void>;
    /**
     * Get refresh token data
     */
    getRefreshToken(token: string): Promise<{
        userId: string;
    } | null>;
    /**
     * Delete refresh token
     */
    deleteRefreshToken(token: string): Promise<void>;
    /**
     * Delete all refresh tokens for a user (logout from all devices)
     */
    deleteAllUserRefreshTokens(userId: string): Promise<void>;
}
export declare const cacheService: CacheService;
export {};
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
//# sourceMappingURL=cache.service.d.ts.map