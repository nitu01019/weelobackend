/**
 * =============================================================================
 * DRIVER AUTH MODULE - SERVICE
 * =============================================================================
 * 
 * Business logic for DRIVER authentication.
 * 
 * FLOW:
 * 1. Driver enters their phone number
 * 2. System finds driver in database by phone
 * 3. System gets the transporter who owns this driver
 * 4. OTP is generated and sent to TRANSPORTER's phone (NOT driver's!)
 * 5. Driver gets OTP from transporter (asks them verbally/SMS)
 * 6. Driver enters OTP and gets authenticated
 * 
 * WHY OTP GOES TO TRANSPORTER:
 * - Ensures driver is authorized by their transporter
 * - Prevents unauthorized driver access
 * - Transporter maintains control over their fleet
 * 
 * SECURITY:
 * - Cryptographically secure OTP generation (crypto.randomInt)
 * - OTPs are hashed before storage (SHA-256 for new OTPs; legacy bcrypt verify compatibility retained temporarily)
 * - OTPs expire after configured time (default: 5 minutes)
 * - Maximum 3 attempts before OTP is invalidated
 * - Rate limiting enforced at route level
 * - Access tokens signed with JWT_SECRET
 * - Refresh tokens signed with JWT_REFRESH_SECRET (separate key!)
 * - Dev details logged via logger.debug (never to console)
 * 
 * SCALABILITY:
 * - Redis-powered OTP storage (same as customer auth)
 * - Stateless JWT tokens (millions of concurrent users)
 * - Horizontal scaling ready
 * 
 * FOR BACKEND DEVELOPERS:
 * - To test driver login in dev: Check logger debug output for OTP delivery status
 * - In production: OTP is sent to transporter via SMS
 * - OTPs are stored in Redis with key pattern: driver-otp:{driverPhone}
 * =============================================================================
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../../config/environment';
import { logger } from '../../shared/services/logger.service';
import { AppError } from '../../shared/types/error.types';
import { db, UserRecord } from '../../shared/database/db';
import { generateSecureOTP, maskForLogging } from '../../shared/utils/crypto.utils';
import { smsService } from '../auth/sms.service';
import { otpChallengeService } from '../auth/otp-challenge.service';
import { redisService } from '../../shared/services/redis.service';

// =============================================================================
// REDIS KEY PATTERNS (consistent with auth.service.ts)
// =============================================================================

const REDIS_KEYS = {
  /** Driver OTP storage: driver-otp:{driverPhone} */
  DRIVER_OTP: (driverPhone: string) => `driver-otp:${driverPhone}`,
  
  /** Driver refresh token storage: driver-refresh:{tokenId} */
  DRIVER_REFRESH_TOKEN: (tokenId: string) => `driver-refresh:${tokenId}`,
  
  /** Driver's refresh tokens set: driver:tokens:{driverId} */
  DRIVER_TOKENS: (driverId: string) => `driver:tokens:${driverId}`,
  OTP_VERIFY_LOCK: (driverPhone: string) => `driver-otp:verify:lock:${driverPhone}`,
};

/**
 * DriverAuthService - Handles driver-specific authentication
 * 
 * SEPARATION FROM TRANSPORTER AUTH:
 * - Drivers use /api/v1/driver-auth/* endpoints
 * - OTP is sent to TRANSPORTER's phone (not driver's)
 * - Driver must ask transporter for the OTP
 * - This ensures transporter authorization
 */
class DriverAuthService {
  // Use config values for consistency with auth.service.ts

  /**
   * Send OTP for driver login
   * 
   * FLOW:
   * 1. Find driver by phone in database
   * 2. Find their transporter
   * 3. Generate OTP and hash it
   * 4. Store ONLY hashed OTP in Redis (with TTL)
   * 5. Send OTP to TRANSPORTER's phone via SMS
   * 
   * @param driverPhone - The driver's phone number
   * @returns Object with masked transporter phone for UI hint
   * @throws AppError if driver not found or not associated with any transporter
   */
  async sendOtp(driverPhone: string): Promise<{
    message: string;
    transporterPhoneMasked: string;
    driverId: string;
    driverName: string;
    expiresInMinutes: number;
  }> {
    // 1. Find driver by phone number
    const driver = await this.findDriverByPhone(driverPhone);
    
    if (!driver) {
      logger.warn('[DRIVER AUTH] Driver not found', { 
        phone: maskForLogging(driverPhone, 2, 4) 
      });
      throw new AppError(
        404,
        'DRIVER_NOT_FOUND',
        'Driver not found. Please contact your transporter to register you.'
      );
    }

    if (!driver.transporterId) {
      logger.warn('[DRIVER AUTH] Driver has no transporter', { 
        driverId: driver.id 
      });
      throw new AppError(
        400,
        'NO_TRANSPORTER',
        'Driver not associated with any transporter. Please contact support.'
      );
    }

    // 2. Find the transporter who owns this driver
    const transporter = await this.findTransporterById(driver.transporterId);
    
    if (!transporter) {
      logger.error('[DRIVER AUTH] Transporter not found', { 
        transporterId: driver.transporterId 
      });
      throw new AppError(
        404,
        'TRANSPORTER_NOT_FOUND',
        'Transporter account not found. Please contact support.'
      );
    }

    logger.info('[DRIVER AUTH] Phone numbers check', {
      driverPhone: maskForLogging(driverPhone, 2, 4),
      transporterPhone: maskForLogging(transporter.phone, 2, 4),
      arePhonesSame: driverPhone === transporter.phone
    });

    // 3. Per-transporter SMS rate limit (max 20 OTPs per hour)
    const smsRateKey = `sms_rate:transporter:${transporter.id}`;
    try {
      const count = await redisService.incr(smsRateKey);
      if (count === 1) {
        await redisService.expire(smsRateKey, 3600);
      }
      if (count > 20) {
        logger.warn('[DRIVER AUTH] Transporter SMS rate limit exceeded', {
          transporterId: transporter.id,
          count
        });
        throw new AppError(
          429,
          'SMS_RATE_LIMIT_EXCEEDED',
          'Too many OTP requests for this transporter. Please try again later.'
        );
      }
    } catch (err: unknown) {
      if (err instanceof AppError) throw err;
      logger.warn('[DRIVER AUTH] SMS rate limit check failed, proceeding', {
        error: err instanceof Error ? err.message : String(err)
      });
    }

    // 4. Generate cryptographically secure OTP
    const otp = generateSecureOTP(config.otp.length);

    // 4. Store OTP challenge (Redis + PostgreSQL backup, shared OTP core)
    const key = REDIS_KEYS.DRIVER_OTP(driverPhone);
    const issueResult = await otpChallengeService.issueChallenge({
      otp,
      redisKey: key,
      dbKey: { phone: driverPhone, role: 'driver' },
      logContext: { driverPhone: maskForLogging(driverPhone, 2, 4) }
    });

    const expiresAt = issueResult.expiresAt;
    if (!issueResult.storedInRedis && !issueResult.storedInDb) {
      logger.error('[DRIVER AUTH] ❌ CRITICAL: OTP not stored in Redis OR PostgreSQL', {
        driverPhone: maskForLogging(driverPhone, 2, 4)
      });
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'OTP service temporarily unavailable. Please try again in a moment.');
    }

    // 5. Send OTP to TRANSPORTER's phone via SMS
    try {
      await smsService.sendOtp(transporter.phone, otp);
      logger.info('[DRIVER AUTH] OTP SMS sent to transporter', {
        driverId: driver.id,
        driverPhone: maskForLogging(driverPhone, 2, 4),
        transporterPhone: maskForLogging(transporter.phone, 2, 4),
        expiresAt: expiresAt.toISOString()
      });
    } catch (smsError: any) {
      logger.error('[DRIVER AUTH] Failed to send OTP SMS to transporter', { 
        error: smsError.message, 
        transporterPhone: maskForLogging(transporter.phone, 2, 4) 
      });
      if (config.isProduction) {
        await otpChallengeService.deleteChallenge({
          redisKey: key,
          dbKey: { phone: driverPhone, role: 'driver' },
          logContext: { driverPhone: maskForLogging(driverPhone, 2, 4), reason: 'sms_send_failed' }
        });
        throw new AppError(503, 'SMS_SEND_FAILED', 'Could not deliver OTP. Please try again in a moment.');
      }
      // Non-production only: allow pending/dev fallback behavior.
    }

    // Log without exposing OTP (safe for production logs)
    logger.info('[DRIVER AUTH] OTP generated for driver', { 
      driverId: driver.id,
      driverPhone: maskForLogging(driverPhone, 2, 4), 
      transporterId: transporter.id,
      expiresAt: expiresAt.toISOString()
    });

    // 6. Return response with masked transporter phone - always via SMS
    const message = `OTP sent to your transporter (${this.maskPhone(transporter.phone)}). Please ask them for the code.`;

    return {
      message,
      transporterPhoneMasked: this.maskPhone(transporter.phone),
      driverId: driver.id,
      driverName: driver.name || 'Driver',
      expiresInMinutes: config.otp.expiryMinutes
    };
  }

  /**
   * Verify OTP and authenticate driver
   * 
   * SECURITY:
   * - OTP is compared using shared OTP verifier (SHA-256 + legacy bcrypt compatibility)
   * - OTP is deleted after successful verification (single use)
   * - Maximum attempts enforced before OTP is invalidated
   * - Failed attempts are logged for security monitoring
   * 
   * @param driverPhone - Driver's phone number
   * @param otp - OTP received from transporter
   * @returns JWT tokens and driver data
   */
  async verifyOtp(driverPhone: string, otp: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    driver: {
      id: string;
      name: string;
      phone: string;
      transporterId: string;
      transporterName: string;
      licenseNumber?: string;
      profilePhoto?: string;
      preferredLanguage?: string | null;
      isProfileCompleted: boolean;
    };
    role: string;
  }> {
    const key = REDIS_KEYS.DRIVER_OTP(driverPhone);
    const verifyResult = await otpChallengeService.verifyChallenge({
      otp,
      redisKey: key,
      dbKey: { phone: driverPhone, role: 'driver' },
      verifyLockKey: REDIS_KEYS.OTP_VERIFY_LOCK(driverPhone),
      hashStrategy: 'sha256_or_bcrypt_compat',
      logContext: { driverPhone: maskForLogging(driverPhone, 2, 4) }
    });

    if (!verifyResult.ok) {
      const failed = verifyResult as Exclude<typeof verifyResult, { ok: true }>;
      switch (failed.code) {
        case 'OTP_VERIFY_IN_PROGRESS':
          throw new AppError(409, 'OTP_VERIFY_IN_PROGRESS', 'OTP verification already in progress. Please try again.');
        case 'OTP_NOT_FOUND':
          throw new AppError(400, 'OTP_NOT_FOUND', 'No OTP request found. Please request a new OTP.');
        case 'OTP_EXPIRED':
          throw new AppError(400, 'OTP_EXPIRED', 'OTP has expired. Please request a new one.');
        case 'MAX_ATTEMPTS':
          throw new AppError(400, 'OTP_MAX_ATTEMPTS', 'Too many failed attempts. Please request a new OTP.');
        case 'OTP_INVALID': {
          const remaining = failed.attemptsRemaining;
          if (typeof remaining === 'number') {
            throw new AppError(
              400,
              'OTP_INVALID',
              `Invalid OTP. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
            );
          }
          throw new AppError(400, 'OTP_INVALID', 'Invalid OTP. Please try again.');
        }
      }
    }

    // 6. Get fresh driver and transporter data from database
    const driver = await this.findDriverByPhone(driverPhone);
    const transporter = driver?.transporterId
      ? await this.findTransporterById(driver.transporterId)
      : undefined;

    if (!driver || !transporter) {
      logger.error('[DRIVER AUTH] Data integrity error after OTP verification', {
        driverFound: !!driver,
        transporterFound: !!transporter
      });
      throw new AppError(500, 'DATA_ERROR', 'Driver or transporter data not found.');
    }

    // 7. Generate JWT tokens
    const accessToken = this.generateAccessToken(driver);
    const refreshToken = await this.generateRefreshToken(driver);

    // Log successful authentication (safe for production)
    logger.info('[DRIVER AUTH] Driver authenticated successfully', { 
      driverId: driver.id, 
      phone: maskForLogging(driverPhone, 2, 4),
      transporterId: transporter.id
    });

    // Development only: Show login details
    if (config.isDevelopment) {
      logger.debug('Driver login successful (dev)', {
        driverId: driver.id,
        driverName: driver.name || 'Driver',
        phoneLast4: driverPhone.slice(-4),
        transporterName: transporter.name || transporter.businessName || 'Transporter',
        transporterId: transporter.id,
      });
    }

    // 8. Return tokens and driver data
    // SCALABILITY: preferredLanguage + isProfileCompleted included so
    // app restores state instantly on login — no extra API call needed.
    // This eliminates the need for separate profile/language fetch calls
    // and ensures the onboarding check works reliably on re-login.
    return {
      accessToken,
      refreshToken,
      expiresIn: this.getExpirySeconds(config.jwt.expiresIn),
      driver: {
        id: driver.id,
        name: driver.name || 'Driver',
        phone: driver.phone,
        transporterId: driver.transporterId!,
        transporterName: transporter.name || transporter.businessName || 'Transporter',
        licenseNumber: driver.licenseNumber,
        profilePhoto: driver.profilePhoto,
        preferredLanguage: driver.preferredLanguage || null,
        isProfileCompleted: driver.isProfileCompleted || false,
      },
      role: 'DRIVER'
    };
  }

  // ===========================================================================
  // PRIVATE HELPER METHODS
  // ===========================================================================
  
  // NOTE: OTP generation is now handled by generateSecureOTP() from crypto.utils.ts
  // The getPendingOtp() method has been REMOVED for security reasons
  // Plain OTPs are never stored - only hashed versions are kept

  /**
   * Find driver by phone number in database
   */
  private async findDriverByPhone(phone: string): Promise<UserRecord | undefined> {
    return await db.getUserByPhone(phone, 'driver');
  }

  /**
   * Find transporter by ID
   */
  private async findTransporterById(transporterId: string): Promise<UserRecord | undefined> {
    return await db.getUserById(transporterId);
  }

  /**
   * Mask phone number for privacy (78****631)
   */
  private maskPhone(phone: string): string {
    if (phone.length < 6) return '****';
    return phone.slice(0, 2) + '****' + phone.slice(-3);
  }

  /**
   * Generate JWT access token for driver
   * Uses JWT_SECRET for signing
   */
  private generateAccessToken(driver: UserRecord): string {
    return jwt.sign(
      {
        userId: driver.id,
        phone: driver.phone,
        role: 'driver',
        transporterId: driver.transporterId,
        jti: crypto.randomUUID()
      },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn } as jwt.SignOptions
    );
  }

  /**
   * Generate JWT refresh token for driver
   * 
   * SECURITY: Uses JWT_REFRESH_SECRET (separate from access token secret)
   * This ensures that even if access token secret is compromised,
   * refresh tokens remain secure.
   */
  private async generateRefreshToken(driver: UserRecord): Promise<string> {
    const token = jwt.sign(
      {
        userId: driver.id,
        type: 'refresh',
        role: 'driver',
      },
      config.jwt.refreshSecret,
      { expiresIn: config.jwt.refreshExpiresIn } as jwt.SignOptions
    );

    // Store refresh token in Redis so POST /auth/refresh can find it
    // MUST use same key pattern as auth.service.ts: refresh:{tokenHash}
    const ttlSeconds = this.getExpirySeconds(config.jwt.refreshExpiresIn);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const tokenId = this.hashToken(token);

    const entry = {
      userId: driver.id,
      expiresAt: expiresAt.toISOString(),
    };

    try {
      await redisService.setJSON(`refresh:${tokenId}`, entry, ttlSeconds);
      await redisService.sAdd(`user:tokens:${driver.id}`, tokenId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to store driver refresh token in Redis', { error: msg });
      throw new AppError(500, 'TOKEN_STORAGE_FAILED', 'Failed to store authentication token');
    }

    return token;
  }

  /**
   * Hash token to create a safe key for Redis storage.
   * Must match auth.service.ts hashToken() exactly.
   */
  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex').substring(0, 32);
  }

  /**
   * Parse JWT expiry duration string to seconds
   * Supports: d (days), h (hours), m (minutes), s (seconds)
   *
   * @param duration - Duration string like "7d", "24h", "30m", "60s"
   * @returns Number of seconds
   */
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

// Export singleton instance
export const driverAuthService = new DriverAuthService();
