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
import { smsService } from './sms.service';
import { otpChallengeService } from './otp-challenge.service';
import { fcmService } from '../../shared/services/fcm.service';
import { availabilityService } from '../../shared/services/availability.service';
import { ONLINE_TRANSPORTERS_SET, TRANSPORTER_PRESENCE_KEY } from '../../shared/services/transporter-online.service';

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
