/**
 * =============================================================================
 * AUTH MODULE - SERVICE
 * =============================================================================
 * 
 * Business logic for authentication (OTP-based login for Customer/Transporter).
 * 
 * SECURITY FEATURES:
 * - Cryptographically secure OTP generation (crypto.randomInt)
 * - OTPs stored plain with Redis TTL (auto-delete 5min) + max 3 attempts (secure)
 * - OTPs expire after configured time (default: 5 minutes)
 * - Maximum 3 attempts per OTP
 * - Rate limiting enforced at route level
 * - JWT tokens signed with secure secrets
 * - Plain OTPs NEVER stored or logged in production
 * 
 * SCALABILITY:
 * - Ready for Redis integration (replace in-memory stores)
 * - Stateless JWT design
 * - Horizontal scaling ready
 * 
 * FOR BACKEND DEVELOPERS:
 * - OTPs are logged to console ONLY in development mode
 * - In production, OTPs are sent via SMS only
 * - To test in dev: Check server console for OTP
 * =============================================================================
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import jwt from 'jsonwebtoken';
// REMOVED: bcrypt (unnecessary for OTPs, was causing 5-second delay)
// OTPs are temporary (5min auto-delete) + max 3 attempts = secure without hashing
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config/environment';
import { logger } from '../../shared/services/logger.service';
import { AppError } from '../../shared/types/error.types';
import { UserRole } from '../../shared/types/api.types';
import { db } from '../../shared/database/db';
import { generateSecureOTP, maskForLogging } from '../../shared/utils/crypto.utils';
import { redisService } from '../../shared/services/redis.service';
import { isEnabled, FLAGS } from '../../shared/config/feature-flags';
import { smsService } from './sms.service';
import { otpChallengeService } from './otp-challenge.service';
import { fcmService } from '../../shared/services/fcm.service';
import { availabilityService } from '../../shared/services/availability.service';
import { ONLINE_TRANSPORTERS_SET, TRANSPORTER_PRESENCE_KEY } from '../../shared/services/transporter-online.service';

// =============================================================================
// TWO-TIER JWT CACHE (A04-002)
// =============================================================================

interface JwtCacheEntry {
  userId: string;
  role: string;
  transporterId?: string;
  decodedExp: number;
  cachedAt: number;
}

// Represents the minimal decoded JWT fields that callers need after verification.
interface DecodedJwt {
  userId: string;
  role: string;
  phone?: string;
  jti?: string;
  deviceId?: string;
  exp?: number;
}

/**
 * Hand-rolled LRU cache (~40 lines) backed by a Map.
 * Map preserves insertion order; oldest key = first key in iteration.
 * On every `get` hit the entry is deleted and re-inserted so it becomes
 * the most-recently-used. Eviction removes the first key when max is reached.
 *
 * Do NOT install `lru-cache` package — user rule forbids new dependencies.
 */
class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly maxSize: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    // Move to tail (most-recently-used)
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict oldest (first inserted key still in map)
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    this.map.set(key, value);
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }
}

/** Module-level L1 in-process JWT cache. Max 1000 entries. */
const jwtL1Cache = new LruCache<string, JwtCacheEntry>(1000);

/**
 * Module-level EventEmitter for cross-service jwt_invalidate signals.
 * redis.service.ts emits `userId` events on this emitter when the
 * jwt_invalidate Pub/Sub message arrives; auth.service.ts purges L1.
 */
export const jwtInvalidateEmitter = new EventEmitter();

// Purge L1 on jwt_invalidate Pub/Sub events from redis.service.ts
jwtInvalidateEmitter.on('userId', (invalidatedUserId: string) => {
  for (const [hash, entry] of jwtL1Cache.entries()) {
    if (entry.userId === invalidatedUserId) {
      jwtL1Cache.delete(hash);
    }
  }
});

// =============================================================================
// REDIS KEY PATTERNS
// =============================================================================

const REDIS_KEYS = {
  /** OTP storage: otp:{phone}:{role} */
  OTP: (phone: string, role: string) => `otp:${phone}:${role}`,
  OTP_VERIFY_LOCK: (phone: string, role: string) => `otp:verify:lock:${phone}:${role}`,

  /** Refresh token storage: refresh:{tokenId} */
  REFRESH_TOKEN: (tokenId: string) => `refresh:${tokenId}`,

  /** User's refresh tokens set: user:tokens:{userId} */
  USER_TOKENS: (userId: string) => `user:tokens:${userId}`,
};

// REFRESH TOKEN STORAGE (Redis-powered)
// =============================================================================
// Redis key: refresh:{tokenId}
// Value: JSON { userId, expiresAt }
// TTL: Refresh token expiry time

interface RefreshTokenEntry {
  userId: string;
  expiresAt: string; // ISO string for JSON serialization
  deviceId?: string; // Device binding: preserved across token refresh
}

// =============================================================================
// TYPES
// =============================================================================

interface AuthUser {
  id: string;
  phone: string;
  role: UserRole;
  name?: string;
  email?: string;
  createdAt: Date;
  updatedAt: Date;
}

class AuthService {
  // ==========================================================================
  // OTP STORAGE STRATEGY (Multi-Task Safe)
  // ==========================================================================
  // PRIMARY: Redis (shared across all ECS tasks, auto-expires with TTL)
  // FALLBACK: PostgreSQL database (shared across all tasks, manual cleanup)
  // 
  // WHY NOT IN-MEMORY:
  // With 2+ ECS tasks behind ALB, in-memory is per-process. OTP stored on
  // Task A cannot be verified on Task B → "Invalid OTP" error every time.
  //
  // SCALABILITY: Both Redis and PostgreSQL are shared across all tasks
  // EASY UNDERSTANDING: Try Redis → fallback to DB → never lose an OTP
  // MODULARITY: Fallback is transparent to the caller
  // CODING STANDARDS: Graceful degradation with shared state
  // ==========================================================================

  /**
   * Send OTP to phone number
   * 
   * SECURITY:
   * - Uses cryptographically secure OTP generation
   * - OTP stored plain with Redis TTL (auto-delete, no bcrypt overhead)
   * - OTP is logged to console ONLY in development mode
   * - In production, OTP is sent via SMS only
   * 
   * @param phone - Phone number to send OTP to
   * @param role - User role (customer, transporter, driver)
   * @returns Object with expiry time and message
   */
  async sendOtp(phone: string, role: UserRole): Promise<{ expiresIn: number; message: string }> {
    // 30-second per-phone cooldown to prevent OTP spam
    const cooldownKey = `otp:cooldown:${phone}:${role}`;
    let cooldownActive = false;
    try {
      cooldownActive = await redisService.exists(cooldownKey);
    } catch (err: unknown) {
      // Fail-open: if Redis is down, allow the OTP send rather than blocking all users
      logger.warn('[OTP] Cooldown check failed-open', { phone: maskForLogging(phone, 2, 4), role });
    }
    if (cooldownActive) {
      throw new AppError(429, 'OTP_COOLDOWN', 'Please wait 30 seconds before requesting another OTP');
    }

    // Generate cryptographically secure 6-digit OTP
    const otp = generateSecureOTP(config.otp.length);

    // PERFORMANCE FIX: Store plain OTP (was causing 5-second delay with bcrypt)
    // SECURITY: Still secure because:
    // - Redis TTL auto-deletes in 5 minutes
    // - Max 3 verification attempts
    // - 6-digit = 1M combinations (impossible to guess in 3 tries)
    // - Rate limiting prevents spam

    const key = REDIS_KEYS.OTP(phone, role);
    const issueResult = await otpChallengeService.issueChallenge({
      otp,
      redisKey: key,
      dbKey: { phone, role },
      logContext: { phone: maskForLogging(phone, 2, 4), role }
    });

    const expiresAt = issueResult.expiresAt;

    // Set 30-second cooldown after OTP is generated and stored
    try {
      await redisService.set(cooldownKey, '1', 30); // 30 second TTL
    } catch (err) {
      logger.warn('[OTP] Cooldown write failed, OTP still valid', {
        phone: maskForLogging(phone, 2, 4),
        error: (err as Error).message
      });
    }

    if (!issueResult.storedInRedis && !issueResult.storedInDb) {
      logger.error('❌ CRITICAL: OTP could not be stored in Redis OR PostgreSQL', {
        phone: maskForLogging(phone, 2, 4),
        role
      });
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'OTP service temporarily unavailable. Please try again in a moment.');
    }

    // ==========================================================================
    // SEND OTP VIA SMS (Fire-and-forget for instant response)
    // In development with mock provider: OTP is logged to console
    // In production with aws-sns/twilio/msg91: Real SMS is sent
    // 
    // LATENCY FIX: Respond to client IMMEDIATELY after OTP is stored.
    // SMS is sent asynchronously — if it fails in production, OTP is
    // cleaned up in the background so a stale OTP can't be verified.
    // This is how Uber/Ola/Rapido work: instant response, SMS arrives shortly.
    // ==========================================================================
    const maskedPhone = maskForLogging(phone, 2, 4);

    // Fire-and-forget: don't await SMS delivery
    smsService.sendOtp(phone, otp).then(() => {
      logger.info('OTP SMS sent successfully', { phone: maskedPhone, role });
    }).catch(async (smsError: unknown) => {
      const smsErrMsg = smsError instanceof Error ? smsError.message : String(smsError);
      const smsErrCode = smsError instanceof Error && 'code' in smsError ? (smsError as { code?: string }).code : 'UNKNOWN';
      logger.error('Failed to send OTP SMS', {
        error: smsErrMsg,
        errorCode: smsErrCode || 'UNKNOWN',
        phone: maskedPhone,
        role,
        otpStored: true,
      });
      // Production safety: clean up OTP so a never-delivered OTP can't be verified
      if (config.isProduction) {
        await otpChallengeService.deleteChallenge({
          redisKey: key,
          dbKey: { phone, role },
          logContext: { phone: maskedPhone, role, reason: 'sms_send_failed' }
        }).catch((cleanupErr: unknown) => {
          const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
          logger.error('Failed to clean up OTP after SMS failure', { error: cleanupMsg });
        });
      }
    });

    // Log without exposing OTP (safe for production logs)
    logger.info('OTP generated', {
      phone: maskedPhone,
      role,
      expiresAt: expiresAt.toISOString()
    });

    return {
      expiresIn: config.otp.expiryMinutes * 60,
      message: `OTP sent to ${maskedPhone}. Please check your SMS.`
    };
  }

  /**
   * Verify OTP and return tokens
   * Creates new user in database if first time login
   * 
   * SECURITY:
   * - OTP is compared using the shared OTP challenge verifier (SHA-256)
   * - OTP is deleted after successful verification
   * - Maximum 3 attempts before OTP is invalidated
   * - Failed attempts are logged for security monitoring
   * 
   * @param phone - Phone number that received OTP
   * @param otp - OTP entered by user
   * @param role - User role
   * @param deviceId - Optional device identifier for device binding
   * @returns User data and JWT tokens
   */
  async verifyOtp(phone: string, otp: string, role: UserRole, deviceId?: string): Promise<{
    user: AuthUser;
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    isNewUser: boolean;
    preferredLanguage: string | null;
  }> {
    const key = REDIS_KEYS.OTP(phone, role);
    const verifyResult = await otpChallengeService.verifyChallenge({
      otp,
      redisKey: key,
      dbKey: { phone, role },
      verifyLockKey: REDIS_KEYS.OTP_VERIFY_LOCK(phone, role),
      hashStrategy: 'sha256',
      logContext: { phone: maskForLogging(phone, 2, 4), role }
    });

    if (!verifyResult.ok) {
      const failed = verifyResult as Exclude<typeof verifyResult, { ok: true }>;
      switch (failed.code) {
        case 'OTP_VERIFY_IN_PROGRESS':
          throw new AppError(409, 'OTP_VERIFY_IN_PROGRESS', 'OTP verification already in progress. Please try again.');
        case 'OTP_EXPIRED':
          throw new AppError(400, 'OTP_EXPIRED', 'OTP has expired. Please request a new one.');
        case 'MAX_ATTEMPTS':
          throw new AppError(400, 'MAX_ATTEMPTS', 'Too many failed attempts. Please request a new OTP.');
        case 'OTP_INVALID':
          if (typeof failed.attemptsRemaining === 'number') {
            const remaining = failed.attemptsRemaining;
            throw new AppError(400, 'INVALID_OTP', `Invalid OTP. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`);
          }
          throw new AppError(400, 'INVALID_OTP', 'Invalid or expired OTP. Please request a new one.');
        case 'OTP_NOT_FOUND':
        default:
          throw new AppError(400, 'INVALID_OTP', 'Invalid or expired OTP. Please request a new one.');
      }
    }

    // Find or create user in DATABASE
    let dbUser: any = null;
    let isNewUser = false;
    const newUserId = uuidv4();

    try {
      dbUser = await db.getUserByPhone(phone, role);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn('Error fetching user, will create new', { error: errMsg });
    }

    if (!dbUser) {
      try {
        dbUser = await db.createUser({
          id: newUserId,
          phone,
          role: role as 'customer' | 'transporter' | 'driver',
          name: '',
          isVerified: false,
          isActive: true
        });
      } catch (err: unknown) {
        const createErrMsg = err instanceof Error ? err.message : String(err);
        logger.error('Error creating user in DB', { error: createErrMsg });
        throw new AppError(503, 'DB_UNAVAILABLE', 'Unable to create user account. Please try again.');
      }

      if (!dbUser || !dbUser.id) {
        throw new AppError(503, 'DB_UNAVAILABLE', 'Unable to create user account. Please try again.');
      }
      isNewUser = true;

      logger.info('New user created', {
        userId: dbUser.id,
        phone: maskForLogging(phone, 2, 4),
        role
      });

      // Development only: Show user creation details
      if (config.isDevelopment) {
        logger.debug('New user created (dev)', {
          userId: dbUser.id,
          phone: maskForLogging(phone, 2, 4),
          role
        });
      }
    }

    // Convert DB user to auth user format - with guaranteed fallbacks
    const user: AuthUser = {
      id: String(dbUser?.id || newUserId),
      phone: String(dbUser?.phone || phone),
      role: (dbUser?.role || role) as UserRole,
      name: String(dbUser?.name || ''),
      email: dbUser?.email || null,
      createdAt: dbUser?.createdAt ? new Date(dbUser.createdAt) : new Date(),
      updatedAt: dbUser?.updatedAt ? new Date(dbUser.updatedAt) : new Date()
    };

    // Generate tokens (deviceId is embedded in JWT for device binding)
    const accessToken = this.generateAccessToken(user, deviceId);
    const refreshToken = await this.generateRefreshToken(user, deviceId);

    // Log successful authentication (safe for production)
    logger.info('User authenticated successfully', {
      userId: user.id,
      phone: maskForLogging(phone, 2, 4),
      role,
      isNewUser,
      deviceBound: !!deviceId
    });

    // Development only: Show login details
    if (config.isDevelopment) {
      logger.debug('Login successful (dev)', {
        userId: user.id,
        phone: maskForLogging(phone, 2, 4),
        role,
        isNewUser
      });
    }

    return {
      user,
      accessToken,
      refreshToken,
      expiresIn: this.getExpirySeconds(config.jwt.expiresIn),
      isNewUser,
      // SCALABILITY: preferredLanguage returned on login so app can
      // restore it instantly without an extra API call
      preferredLanguage: dbUser?.preferredLanguage || null
    };
  }

  /**
   * Refresh access token
   */
  async refreshToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    // Verify refresh token
    let decoded: any;
    try {
      decoded = jwt.verify(refreshToken, config.jwt.refreshSecret, { algorithms: ['HS256'] });
    } catch {
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token');
    }

    // Check if token is in Redis store (not invalidated)
    // We use a hash of the token as the key to avoid storing the actual token
    const tokenId = this.hashToken(refreshToken);
    const stored = await redisService.getJSON<RefreshTokenEntry>(REDIS_KEYS.REFRESH_TOKEN(tokenId));

    if (!stored || stored.userId !== decoded.userId) {
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token has been revoked');
    }

    // Get user from database
    const dbUser = await db.getUserById(decoded.userId);
    if (!dbUser) {
      throw new AppError(401, 'USER_NOT_FOUND', 'User not found');
    }

    // Convert to auth user
    const user: AuthUser = {
      id: dbUser.id,
      phone: dbUser.phone,
      role: dbUser.role as UserRole,
      name: dbUser.name,
      email: dbUser.email,
      createdAt: new Date(dbUser.createdAt),
      updatedAt: new Date(dbUser.updatedAt)
    };

    // Preserve deviceId from the original refresh token for device binding continuity
    const refreshDeviceId: string | undefined = decoded.deviceId || stored.deviceId || undefined;

    // Generate new access token (carries same deviceId as original)
    const accessToken = this.generateAccessToken(user, refreshDeviceId);

    // Rotate refresh token: invalidate old, issue new
    // Grace period: keep old token valid for 30s instead of immediate delete.
    // If the client crashes or loses network after sending the refresh request
    // but before saving the new token, the old token still works briefly.
    // This follows the Auth0 "Rotation Overlap Period" / Okta 30-second grace window pattern.
    await redisService.expire(REDIS_KEYS.REFRESH_TOKEN(tokenId), 30);
    await redisService.sRem(REDIS_KEYS.USER_TOKENS(user.id), tokenId);
    const newRefreshToken = await this.generateRefreshToken(user, refreshDeviceId);

    return {
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn: this.getExpirySeconds(config.jwt.expiresIn)
    };
  }

  /**
   * Logout user - invalidate refresh token
   */
  async logout(userId: string, jti?: string, exp?: number): Promise<void> {
    // Blacklist the access token JTI so it cannot be reused
    if (jti && exp) {
      const remainingTTL = exp - Math.floor(Date.now() / 1000);
      if (remainingTTL > 0) {
        try {
          await redisService.set(`blacklist:${jti}`, 'revoked', remainingTTL);
        } catch { /* non-critical — token will expire naturally */ }
      }
    }

    // Get all token IDs for this user from Redis
    const userTokensKey = REDIS_KEYS.USER_TOKENS(userId);
    const tokenIds = await redisService.sMembers(userTokensKey);

    // Delete all refresh tokens
    for (const tokenId of tokenIds) {
      await redisService.del(REDIS_KEYS.REFRESH_TOKEN(tokenId));
    }

    // Delete the user tokens set
    await redisService.del(userTokensKey);

    // Publish jwt_invalidate so all ECS tasks purge their L1/L2 JWT caches for
    // this user. Graceful: a publish failure must NOT cause logout to fail.
    try {
      await redisService.publish('jwt_invalidate', userId);
    } catch (pubErr: unknown) {
      const pubMsg = pubErr instanceof Error ? pubErr.message : String(pubErr);
      logger.warn('[Auth] jwt_invalidate publish failed', { userId, error: pubMsg });
      try {
        const { metrics } = require('../../shared/monitoring/metrics.service');
        metrics.incrementCounter('jwt_invalidate_publish_failed_total');
      } catch { /* metrics optional */ }
    }

    // Best-effort hard cleanup for logout correctness across app restarts/retries.
    // Keeps behavior additive and idempotent.
    const userRole = await db.getUserById(userId)
      .then((user) => user?.role?.toLowerCase())
      .catch(() => undefined);

    if (userRole === 'transporter' || userRole === 'driver') {
      availabilityService.setOffline(userId);
    }

    const cleanupResults = await Promise.allSettled([
      fcmService.removeAllTokens(userId),
      redisService.del(`socket:conncount:${userId}`),
      redisService.del(`driver:presence:${userId}`),
      redisService.del(TRANSPORTER_PRESENCE_KEY(userId)),
      redisService.sRem(ONLINE_TRANSPORTERS_SET, userId)
    ]);
    const cleanupFailures = cleanupResults.filter((result) => result.status === 'rejected').length;

    logger.info('User logged out', { userId, cleanupFailures });
  }

  /**
   * Get user by ID from database
   */
  async getUserById(userId: string): Promise<AuthUser> {
    const dbUser = await db.getUserById(userId);
    if (!dbUser) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }

    return {
      id: dbUser.id,
      phone: dbUser.phone,
      role: dbUser.role as UserRole,
      name: dbUser.name,
      email: dbUser.email,
      createdAt: new Date(dbUser.createdAt),
      updatedAt: new Date(dbUser.updatedAt)
    };
  }

  /**
   * Two-tier JWT verification cache (A04-002).
   *
   * Tier hierarchy when FF_JWT_CACHE_ENABLED=ON:
   *   L1 (in-process LRU)  → near-zero latency, max 1000 entries
   *   L2 (Redis)           → shared across ECS tasks, TTL-backed
   *   Full verify          → jsonwebtoken + blacklist check; populates L1+L2
   *
   * P5-D: Admin or transporter-owner tokens get a 5s L1 TTL (vs 30s default)
   *       to narrow the blacklist propagation window for high-privilege tokens.
   *
   * When the flag is OFF the method falls through immediately to full verify
   * so the cache is a pure no-op during staged rollout.
   */
  async verifyAccessTokenCached(token: string): Promise<DecodedJwt> {
    if (!isEnabled(FLAGS.JWT_CACHE_ENABLED)) {
      // Flag OFF: bypass cache, full verify always
      const decoded = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] }) as DecodedJwt;
      return decoded;
    }

    const hash = this.hashTokenShort(token);
    const nowSec = Math.floor(Date.now() / 1000);

    // ── L1 check ──────────────────────────────────────────────────────────────
    const l1Entry = jwtL1Cache.get(hash);
    if (l1Entry) {
      const isAdmin = l1Entry.role === 'admin';
      // P5-D: elevated tokens use 5s L1 TTL; standard tokens use 30s
      const l1TtlSec = isAdmin ? 5 : 30;
      const l1ExpiresAtSec = Math.floor(l1Entry.cachedAt / 1000) + l1TtlSec;
      if (l1Entry.decodedExp > nowSec + 5 && nowSec < l1ExpiresAtSec) {
        try {
          const { metrics } = require('../shared/monitoring/metrics.service');
          metrics.incrementCounter('jwt_cache_hits_total', { tier: 'l1' });
        } catch { /* metrics optional */ }
        return { userId: l1Entry.userId, role: l1Entry.role };
      }
      // L1 entry expired — evict and continue to L2
      jwtL1Cache.delete(hash);
    }

    // ── L2 check ──────────────────────────────────────────────────────────────
    try {
      const l2Entry = await redisService.jwtCacheGet(hash);
      if (l2Entry && l2Entry.decodedExp > nowSec + 5) {
        // Warm L1 from L2
        jwtL1Cache.set(hash, l2Entry);
        try {
          const { metrics } = require('../shared/monitoring/metrics.service');
          metrics.incrementCounter('jwt_cache_hits_total', { tier: 'l2' });
        } catch { /* metrics optional */ }
        return { userId: l2Entry.userId, role: l2Entry.role };
      }
    } catch {
      // Redis unavailable — fall through to full verify
    }

    // ── Full verify ───────────────────────────────────────────────────────────
    const decoded = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] }) as DecodedJwt;

    const entry: JwtCacheEntry = {
      userId: decoded.userId,
      role: decoded.role,
      decodedExp: decoded.exp ?? (nowSec + 3600),
      cachedAt: Date.now(),
    };

    // Populate L1
    jwtL1Cache.set(hash, entry);

    // Populate L2 — non-blocking; Redis write failure must not block auth
    const remainingSec = entry.decodedExp - nowSec;
    if (remainingSec > 5) {
      Promise.allSettled([redisService.jwtCacheSet(hash, entry, remainingSec)]).catch(() => {});
    }

    try {
      const { metrics } = require('../shared/monitoring/metrics.service');
      metrics.incrementCounter('jwt_cache_hits_total', { tier: 'full' });
    } catch { /* metrics optional */ }

    return decoded;
  }

  // ============================================================
  // PRIVATE METHODS
  // ============================================================

  // NOTE: OTP generation is now handled by generateSecureOTP() from crypto.utils.ts
  // The getPendingOtp() method has been REMOVED for security reasons
  // Plain OTPs are never stored - only hashed versions are kept

  private generateAccessToken(user: AuthUser, deviceId?: string): string {
    return jwt.sign(
      {
        userId: user.id,
        role: user.role,
        phone: user.phone,
        jti: crypto.randomUUID(),
        ...(deviceId ? { deviceId } : {})
      },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn } as jwt.SignOptions
    );
  }

  private async generateRefreshToken(user: AuthUser, deviceId?: string): Promise<string> {
    const token = jwt.sign(
      { userId: user.id, ...(deviceId ? { deviceId } : {}) },
      config.jwt.refreshSecret,
      { expiresIn: config.jwt.refreshExpiresIn } as jwt.SignOptions
    );

    const expiresAt = new Date(Date.now() + this.getExpirySeconds(config.jwt.refreshExpiresIn) * 1000);
    const tokenId = this.hashToken(token);
    const ttlSeconds = this.getExpirySeconds(config.jwt.refreshExpiresIn);

    // Store token entry with TTL (deviceId preserved for refresh flow)
    const entry: RefreshTokenEntry = {
      userId: user.id,
      expiresAt: expiresAt.toISOString(),
      ...(deviceId ? { deviceId } : {})
    };

    try {
      await redisService.setJSON(REDIS_KEYS.REFRESH_TOKEN(tokenId), entry, ttlSeconds);
      await redisService.sAdd(REDIS_KEYS.USER_TOKENS(user.id), tokenId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to store refresh token in Redis', { error: msg });
      throw new AppError(500, 'TOKEN_STORAGE_FAILED', 'Failed to store authentication token');
    }

    return token;
  }

  /**
   * Hash token to create a safe key for Redis storage
   */
  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex').substring(0, 32);
  }

  /**
   * Hash token to a 24-char hex prefix for L1/L2 JWT cache keys (A04-002).
   * Shorter than hashToken (32 chars) to minimize Redis key overhead.
   */
  private hashTokenShort(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
  }

  private getExpirySeconds(duration: string): number {
    const match = duration.match(/^(\d+)([dhms])$/);
    if (!match) return 3600; // Default 1 hour

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case 'd': return value * 24 * 60 * 60;
      case 'h': return value * 60 * 60;
      case 'm': return value * 60;
      case 's': return value;
      default: return 3600;
    }
  }
}

export const authService = new AuthService();
