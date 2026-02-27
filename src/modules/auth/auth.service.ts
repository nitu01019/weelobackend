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
    }).catch(async (smsError: any) => {
      logger.error('❌ Failed to send OTP SMS', {
        error: smsError.message,
        errorCode: smsError.code || 'UNKNOWN',
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
        }).catch((cleanupErr: any) => {
          logger.error('Failed to clean up OTP after SMS failure', { error: cleanupErr.message });
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
   * @returns User data and JWT tokens
   */
  async verifyOtp(phone: string, otp: string, role: UserRole): Promise<{
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
    } catch (err: any) {
      logger.warn('Error fetching user, will create new', { error: err.message });
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
      } catch (err: any) {
        logger.warn('Error creating user in DB, using fallback', { error: err.message });
      }

      // If dbUser is still null/undefined, create a fallback object
      if (!dbUser || !dbUser.id) {
        dbUser = {
          id: newUserId,
          phone: phone,
          role: role,
          name: '',
          email: null,
          isVerified: false,
          isActive: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
      }
      isNewUser = true;

      logger.info('New user created', {
        userId: dbUser.id,
        phone: maskForLogging(phone, 2, 4),
        role
      });

      // Development only: Show user creation details
      if (config.isDevelopment) {
        console.log('\n');
        console.log('╔══════════════════════════════════════════════════════════════╗');
        console.log('║                  👤 NEW USER CREATED                         ║');
        console.log('╠══════════════════════════════════════════════════════════════╣');
        console.log(`║  User ID: ${dbUser.id.padEnd(50)}║`);
        console.log(`║  Phone:   ${maskForLogging(phone, 2, 4).padEnd(50)}║`);
        console.log(`║  Role:    ${role.padEnd(50)}║`);
        console.log('╚══════════════════════════════════════════════════════════════╝');
        console.log('\n');
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

    // Generate tokens
    const accessToken = this.generateAccessToken(user);
    const refreshToken = this.generateRefreshToken(user);

    // Log successful authentication (safe for production)
    logger.info('User authenticated successfully', {
      userId: user.id,
      phone: maskForLogging(phone, 2, 4),
      role,
      isNewUser
    });

    // Development only: Show login details
    if (config.isDevelopment) {
      console.log('\n');
      console.log('╔══════════════════════════════════════════════════════════════╗');
      console.log('║                  ✅ LOGIN SUCCESSFUL                         ║');
      console.log('╠══════════════════════════════════════════════════════════════╣');
      console.log(`║  User ID:  ${user.id.substring(0, 36).padEnd(49)}║`);
      console.log(`║  Phone:    ${maskForLogging(phone, 2, 4).padEnd(49)}║`);
      console.log(`║  Role:     ${role.padEnd(49)}║`);
      console.log(`║  New User: ${(isNewUser ? 'Yes' : 'No').padEnd(49)}║`);
      console.log('╚══════════════════════════════════════════════════════════════╝');
      console.log('\n');
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
    expiresIn: number;
  }> {
    // Verify refresh token
    let decoded: any;
    try {
      decoded = jwt.verify(refreshToken, config.jwt.refreshSecret);
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

    // Generate new access token
    const accessToken = this.generateAccessToken(user);

    return {
      accessToken,
      expiresIn: this.getExpirySeconds(config.jwt.expiresIn)
    };
  }

  /**
   * Logout user - invalidate refresh token
   */
  async logout(userId: string): Promise<void> {
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

  private generateAccessToken(user: AuthUser): string {
    return jwt.sign(
      {
        userId: user.id,
        role: user.role,
        phone: user.phone
      },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn } as jwt.SignOptions
    );
  }

  private generateRefreshToken(user: AuthUser): string {
    const token = jwt.sign(
      { userId: user.id },
      config.jwt.refreshSecret,
      { expiresIn: config.jwt.refreshExpiresIn } as jwt.SignOptions
    );

    // Store refresh token in Redis (fire and forget)
    const expiresAt = new Date(Date.now() + this.getExpirySeconds(config.jwt.refreshExpiresIn) * 1000);
    const tokenId = this.hashToken(token);
    const ttlSeconds = this.getExpirySeconds(config.jwt.refreshExpiresIn);

    // Store token entry with TTL
    const entry: RefreshTokenEntry = {
      userId: user.id,
      expiresAt: expiresAt.toISOString()
    };

    redisService.setJSON(REDIS_KEYS.REFRESH_TOKEN(tokenId), entry, ttlSeconds).catch(err => {
      logger.error(`Failed to store refresh token: ${err.message}`);
    });

    // Track token ID for user (for logout all devices)
    redisService.sAdd(REDIS_KEYS.USER_TOKENS(user.id), tokenId).catch(err => {
      logger.error(`Failed to track user token: ${err.message}`);
    });

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
