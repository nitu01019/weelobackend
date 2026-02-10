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
 * - OTPs are hashed with bcrypt before storage (plain OTP is NEVER stored)
 * - OTPs expire after configured time (default: 5 minutes)
 * - Maximum 3 attempts before OTP is invalidated
 * - Rate limiting enforced at route level
 * - Access tokens signed with JWT_SECRET
 * - Refresh tokens signed with JWT_REFRESH_SECRET (separate key!)
 * - OTPs logged to console ONLY in development mode
 * 
 * SCALABILITY:
 * - Redis-powered OTP storage (same as customer auth)
 * - Stateless JWT tokens (millions of concurrent users)
 * - Horizontal scaling ready
 * 
 * FOR BACKEND DEVELOPERS:
 * - To test driver login in dev: Check server console for OTP
 * - In production: OTP is sent to transporter via SMS
 * - OTPs are stored in Redis with key pattern: driver-otp:{driverPhone}
 * =============================================================================
 */

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../../config/environment';
import { logger } from '../../shared/services/logger.service';
import { AppError } from '../../shared/types/error.types';
import { db, UserRecord } from '../../shared/database/db';
import { generateSecureOTP, maskForLogging } from '../../shared/utils/crypto.utils';
import { redisService } from '../../shared/services/redis.service';
import { smsService } from '../auth/sms.service';

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
};

// =============================================================================
// OTP STORAGE INTERFACE (Redis-powered, same pattern as auth.service.ts)
// =============================================================================

/**
 * OTP entry stored in Redis
 * Key: driver-otp:{driverPhone}
 * TTL: OTP expiry time (auto-cleanup)
 */
interface DriverOtpEntry {
  hashedOtp: string;
  driverId: string;
  driverName: string;
  transporterId: string;
  transporterPhone: string;
  transporterName: string;
  expiresAt: string; // ISO string for JSON serialization
  attempts: number;
}

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

    // DEBUG: Log actual phone numbers to identify the issue
    logger.info('[DRIVER AUTH DEBUG] Phone numbers check', {
      driverPhone: maskForLogging(driverPhone, 2, 4),
      transporterPhone: maskForLogging(transporter.phone, 2, 4),
      driverPhoneFull: driverPhone,
      transporterPhoneFull: transporter.phone,
      arePhonesSame: driverPhone === transporter.phone
    });

    // 3. Generate cryptographically secure OTP
    const otp = generateSecureOTP(config.otp.length);
    
    // Hash OTP before storing (NEVER store plain OTP)
    const hashedOtp = await bcrypt.hash(otp, 10);
    
    // Calculate expiry
    const expiresAt = new Date(Date.now() + config.otp.expiryMinutes * 60 * 1000);

    // 4. Store ONLY hashed OTP in Redis with TTL (auto-expires)
    const key = REDIS_KEYS.DRIVER_OTP(driverPhone);
    const otpEntry: DriverOtpEntry = {
      hashedOtp,
      driverId: driver.id,
      driverName: driver.name || 'Driver',
      transporterId: driver.transporterId,
      transporterPhone: transporter.phone,
      transporterName: transporter.name || transporter.businessName || 'Transporter',
      expiresAt: expiresAt.toISOString(),
      attempts: 0
    };
    
    // Store with TTL (auto-cleanup by Redis)
    const ttlSeconds = config.otp.expiryMinutes * 60;
    await redisService.setJSON(key, otpEntry, ttlSeconds);

    // 5. Send OTP to TRANSPORTER's phone via SMS
    // Driver asks transporter for this OTP verbally or via other means
    
    // CRITICAL DEBUG: Console log to verify the actual number SMS is being sent to
    console.log('\n');
    console.log('╔═══════════════════════════════════════════════════════╗');
    console.log('║          🔍 DRIVER AUTH - OTP SENDING DEBUG           ║');
    console.log('╠═══════════════════════════════════════════════════════╣');
    console.log(`║  Driver Phone (input):     ${driverPhone.padEnd(28)}║`);
    console.log(`║  Transporter Phone (dest): ${transporter.phone.padEnd(28)}║`);
    console.log(`║  Same number?:             ${(driverPhone === transporter.phone ? 'YES ❌' : 'NO ✅').padEnd(28)}║`);
    console.log('╚═══════════════════════════════════════════════════════╝');
    console.log('\n');
    
    try {
      await smsService.sendOtp(transporter.phone, otp);
      logger.info('[DRIVER AUTH] OTP SMS sent to transporter', {
        driverId: driver.id,
        driverPhone: maskForLogging(driverPhone, 2, 4),
        transporterPhone: maskForLogging(transporter.phone, 2, 4),
        transporterPhoneFull: transporter.phone,
        expiresAt: expiresAt.toISOString()
      });
    } catch (smsError: any) {
      logger.error('[DRIVER AUTH] Failed to send OTP SMS to transporter', { 
        error: smsError.message, 
        transporterPhone: maskForLogging(transporter.phone, 2, 4) 
      });
      // Continue anyway - OTP is stored and can be verified
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
   * - OTP is compared using bcrypt (timing-safe)
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
    const stored = await redisService.getJSON<DriverOtpEntry>(key);

    // 1. Check if OTP exists
    if (!stored) {
      logger.warn('[DRIVER AUTH] OTP verification failed - no OTP found', { 
        phone: maskForLogging(driverPhone, 2, 4) 
      });
      throw new AppError(
        400,
        'OTP_NOT_FOUND',
        'No OTP request found. Please request a new OTP.'
      );
    }

    // 2. Check if OTP is expired (Redis TTL handles this, but double-check)
    if (new Date() > new Date(stored.expiresAt)) {
      await redisService.del(key);
      logger.warn('[DRIVER AUTH] OTP verification failed - expired', { 
        phone: maskForLogging(driverPhone, 2, 4) 
      });
      throw new AppError(
        400,
        'OTP_EXPIRED',
        'OTP has expired. Please request a new one.'
      );
    }

    // 3. Check attempts (max configured attempts) - using atomic increment
    const maxAttempts = config.otp.maxAttempts;
    const currentAttempts = await redisService.getOtpAttempts(key);
    if (currentAttempts >= maxAttempts) {
      await redisService.deleteOtpWithAttempts(key);
      logger.warn('[DRIVER AUTH] OTP verification failed - max attempts exceeded', { 
        phone: maskForLogging(driverPhone, 2, 4),
        attempts: currentAttempts
      });
      throw new AppError(
        400,
        'OTP_MAX_ATTEMPTS',
        'Too many failed attempts. Please request a new OTP.'
      );
    }

    // 4. Verify OTP using bcrypt (timing-safe comparison)
    const isValid = await bcrypt.compare(otp, stored.hashedOtp);

    if (!isValid) {
      // ATOMIC increment attempts - prevents race conditions
      // Even if 100 concurrent requests come in, each gets a unique attempt number
      const attemptResult = await redisService.incrementOtpAttempts(key, maxAttempts);
      
      logger.warn('[DRIVER AUTH] OTP verification failed - invalid OTP', { 
        phone: maskForLogging(driverPhone, 2, 4),
        attemptsRemaining: attemptResult.remaining
      });
      
      // If max attempts reached after this increment, delete OTP
      if (!attemptResult.allowed) {
        await redisService.deleteOtpWithAttempts(key);
        throw new AppError(
          400,
          'OTP_MAX_ATTEMPTS',
          'Too many failed attempts. Please request a new OTP.'
        );
      }
      
      throw new AppError(
        400,
        'OTP_INVALID',
        `Invalid OTP. ${attemptResult.remaining} attempt${attemptResult.remaining !== 1 ? 's' : ''} remaining.`
      );
    }

    // 5. OTP verified - delete it immediately (single use) along with attempts counter
    await redisService.deleteOtpWithAttempts(key);

    // 6. Get fresh driver and transporter data from database
    const driver = await this.findDriverByPhone(driverPhone);
    const transporter = await this.findTransporterById(stored.transporterId);

    if (!driver || !transporter) {
      logger.error('[DRIVER AUTH] Data integrity error after OTP verification', {
        driverFound: !!driver,
        transporterFound: !!transporter
      });
      throw new AppError(500, 'DATA_ERROR', 'Driver or transporter data not found.');
    }

    // 7. Generate JWT tokens
    const accessToken = this.generateAccessToken(driver);
    const refreshToken = this.generateRefreshToken(driver);

    // Log successful authentication (safe for production)
    logger.info('[DRIVER AUTH] Driver authenticated successfully', { 
      driverId: driver.id, 
      phone: maskForLogging(driverPhone, 2, 4),
      transporterId: transporter.id
    });

    // Development only: Show login details
    if (config.isDevelopment) {
      console.log('\n');
      console.log('╔══════════════════════════════════════════════════════════════╗');
      console.log('║                ✅ DRIVER LOGIN SUCCESSFUL                    ║');
      console.log('╠══════════════════════════════════════════════════════════════╣');
      console.log(`║  Driver ID:   ${driver.id.substring(0, 36).padEnd(46)}║`);
      console.log(`║  Driver:      ${(driver.name || 'Driver').padEnd(46)}║`);
      console.log(`║  Phone:       ${maskForLogging(driverPhone, 2, 4).padEnd(46)}║`);
      console.log(`║  Transporter: ${(transporter.name || transporter.businessName || 'Transporter').padEnd(46)}║`);
      console.log('╚══════════════════════════════════════════════════════════════╝');
      console.log('\n');
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
  private generateRefreshToken(driver: UserRecord): string {
    return jwt.sign(
      {
        userId: driver.id,
        type: 'refresh',
        role: 'driver',
      },
      config.jwt.refreshSecret,
      { expiresIn: config.jwt.refreshExpiresIn } as jwt.SignOptions
    );
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
