/**
 * =============================================================================
 * DRIVER ONBOARDING MODULE - SERVICE
 * =============================================================================
 * 
 * Handles driver onboarding with OTP verification.
 * 
 * FLOW:
 * 1. Transporter enters driver's phone number and details
 * 2. OTP is sent to DRIVER's phone (not transporter's!)
 * 3. Driver shares OTP with transporter (call/text)
 * 4. Transporter enters OTP to verify
 * 5. Driver is added to transporter's fleet
 * 
 * WHY OTP TO DRIVER:
 * - Ensures the driver owns the phone number
 * - Prevents adding random/fake phone numbers
 * - Driver consent to be added to fleet
 * 
 * SECURITY:
 * - OTPs are hashed with bcrypt before storage
 * - OTPs expire after 10 minutes (longer than login OTP)
 * - Maximum 3 attempts before OTP is invalidated
 * - Rate limiting at route level
 * 
 * SCALABILITY:
 * - Redis-powered OTP storage (same as auth module)
 * - Stateless design for horizontal scaling
 * =============================================================================
 */

import { v4 as uuid } from 'uuid';
import bcrypt from 'bcryptjs';
import { config } from '../../config/environment';
import { logger } from '../../shared/services/logger.service';
import { AppError } from '../../shared/types/error.types';
import { db, UserRecord } from '../../shared/database/db';
import { generateSecureOTP, maskForLogging } from '../../shared/utils/crypto.utils';
import { redisService } from '../../shared/services/redis.service';
import { smsService } from '../auth/sms.service';

// =============================================================================
// REDIS KEY PATTERNS
// =============================================================================

const REDIS_KEYS = {
  /** Driver onboarding OTP: driver-onboard-otp:{driverPhone} */
  DRIVER_ONBOARD_OTP: (driverPhone: string) => `driver-onboard-otp:${driverPhone}`,
};

// =============================================================================
// TYPES
// =============================================================================

interface DriverOnboardOtpEntry {
  hashedOtp: string;
  transporterId: string;
  transporterName: string;
  driverPhone: string;
  driverName: string;
  licenseNumber: string;
  email?: string;
  expiresAt: string;
  attempts: number;
}

interface InitiateOnboardingInput {
  phone: string;
  name: string;
  licenseNumber: string;
  email?: string;
}

// =============================================================================
// SERVICE
// =============================================================================

class DriverOnboardingService {
  
  private readonly OTP_EXPIRY_MINUTES = 10; // Longer than login OTP since driver needs to share
  private readonly MAX_ATTEMPTS = 3;

  /**
   * Step 1: Initiate driver onboarding
   * 
   * - Validates driver doesn't already exist
   * - Generates OTP and sends to DRIVER's phone
   * - Stores hashed OTP in Redis
   * 
   * @param transporterId - ID of the transporter adding the driver
   * @param data - Driver details (phone, name, license)
   */
  async initiateOnboarding(
    transporterId: string,
    data: InitiateOnboardingInput
  ): Promise<{
    message: string;
    driverPhoneMasked: string;
    expiresInMinutes: number;
  }> {
    const driverPhone = data.phone.trim();
    
    // 1. Validate transporter exists
    const transporterResult = await db.getUserById(transporterId);
    const transporter = transporterResult && typeof transporterResult.then === 'function'
      ? await transporterResult
      : transporterResult;
    
    if (!transporter || transporter.role !== 'transporter') {
      throw new AppError(403, 'NOT_TRANSPORTER', 'Only transporters can add drivers');
    }

    // 2. Check if driver already exists with this phone
    const existingResult = await db.getUserByPhone(driverPhone, 'driver');
    const existing = existingResult && typeof existingResult.then === 'function'
      ? await existingResult
      : existingResult;
    
    if (existing) {
      if (existing.transporterId === transporterId) {
        throw new AppError(
          409, 
          'DRIVER_ALREADY_IN_FLEET', 
          'This driver is already in your fleet'
        );
      }
      throw new AppError(
        409, 
        'DRIVER_EXISTS', 
        'A driver with this phone number already exists with another transporter'
      );
    }

    // 3. Generate secure OTP
    const otp = generateSecureOTP(config.otp.length);
    const hashedOtp = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + this.OTP_EXPIRY_MINUTES * 60 * 1000);

    // 4. Store OTP in Redis
    const key = REDIS_KEYS.DRIVER_ONBOARD_OTP(driverPhone);
    const otpEntry: DriverOnboardOtpEntry = {
      hashedOtp,
      transporterId,
      transporterName: transporter.name || transporter.businessName || 'Transporter',
      driverPhone,
      driverName: data.name.trim(),
      licenseNumber: data.licenseNumber.trim(),
      email: data.email?.trim(),
      expiresAt: expiresAt.toISOString(),
      attempts: 0
    };
    
    const ttlSeconds = this.OTP_EXPIRY_MINUTES * 60;
    await redisService.setJSON(key, otpEntry, ttlSeconds);

    // 5. Send OTP to DRIVER's phone
    try {
      await smsService.sendOtp(driverPhone, otp);
      logger.info('[DRIVER ONBOARD] OTP sent to driver', {
        transporterId,
        driverPhone: maskForLogging(driverPhone, 2, 4),
        expiresAt: expiresAt.toISOString()
      });
    } catch (smsError: any) {
      logger.error('[DRIVER ONBOARD] Failed to send OTP', {
        error: smsError.message,
        driverPhone: maskForLogging(driverPhone, 2, 4)
      });
      // Log SMS failure but don't block the flow
    }

    // 6. Return response - always via SMS
    return {
      message: `OTP sent to driver's phone (${this.maskPhone(driverPhone)}). Ask driver for the code.`,
      driverPhoneMasked: this.maskPhone(driverPhone),
      expiresInMinutes: this.OTP_EXPIRY_MINUTES
    };
  }

  /**
   * Step 2: Verify OTP and add driver to fleet
   * 
   * - Verifies OTP from driver
   * - Creates driver account
   * - Links driver to transporter
   * 
   * @param transporterId - ID of the transporter
   * @param driverPhone - Driver's phone number
   * @param otp - OTP received from driver
   */
  async verifyAndAddDriver(
    transporterId: string,
    driverPhone: string,
    otp: string
  ): Promise<{
    driver: UserRecord;
    message: string;
  }> {
    const key = REDIS_KEYS.DRIVER_ONBOARD_OTP(driverPhone);
    const stored = await redisService.getJSON<DriverOnboardOtpEntry>(key);

    // 1. Check if OTP request exists
    if (!stored) {
      logger.warn('[DRIVER ONBOARD] OTP not found', {
        phone: maskForLogging(driverPhone, 2, 4)
      });
      throw new AppError(
        400,
        'OTP_NOT_FOUND',
        'No pending request found. Please initiate driver onboarding again.'
      );
    }

    // 2. Verify transporter matches
    if (stored.transporterId !== transporterId) {
      logger.warn('[DRIVER ONBOARD] Transporter mismatch', {
        expected: stored.transporterId.substring(0, 8),
        got: transporterId.substring(0, 8)
      });
      throw new AppError(
        403,
        'FORBIDDEN',
        'This onboarding request was initiated by a different transporter'
      );
    }

    // 3. Check expiry
    if (new Date() > new Date(stored.expiresAt)) {
      await redisService.del(key);
      throw new AppError(
        400,
        'OTP_EXPIRED',
        'OTP has expired. Please start again.'
      );
    }

    // 4. Check attempts
    if (stored.attempts >= this.MAX_ATTEMPTS) {
      await redisService.del(key);
      throw new AppError(
        400,
        'OTP_MAX_ATTEMPTS',
        'Too many failed attempts. Please start again.'
      );
    }

    // 5. Verify OTP
    const isValid = await bcrypt.compare(otp, stored.hashedOtp);
    
    if (!isValid) {
      stored.attempts++;
      const remainingTtl = await redisService.ttl(key);
      await redisService.setJSON(key, stored, remainingTtl > 0 ? remainingTtl : 60);
      
      const remaining = this.MAX_ATTEMPTS - stored.attempts;
      logger.warn('[DRIVER ONBOARD] Invalid OTP', {
        phone: maskForLogging(driverPhone, 2, 4),
        attemptsRemaining: remaining
      });
      throw new AppError(
        400,
        'OTP_INVALID',
        `Invalid OTP. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
      );
    }

    // 6. OTP verified - delete it
    await redisService.del(key);

    // 7. Double check driver doesn't exist (race condition protection)
    const existingResult = await db.getUserByPhone(driverPhone, 'driver');
    const existing = existingResult && typeof existingResult.then === 'function'
      ? await existingResult
      : existingResult;
    
    if (existing) {
      throw new AppError(409, 'DRIVER_EXISTS', 'Driver was already added');
    }

    // 8. Create driver account
    const driverResult = await db.createUser({
      id: uuid(),
      phone: driverPhone,
      role: 'driver',
      name: stored.driverName,
      email: stored.email,
      transporterId: transporterId,
      licenseNumber: stored.licenseNumber,
      isVerified: true,  // Phone verified via OTP
      isActive: true
    });
    
    const driver = driverResult && typeof driverResult.then === 'function'
      ? await driverResult
      : driverResult;

    logger.info('[DRIVER ONBOARD] Driver added successfully', {
      driverId: driver.id,
      driverPhone: maskForLogging(driverPhone, 2, 4),
      transporterId
    });

    return {
      driver,
      message: `Driver ${driver.name} added successfully!`
    };
  }

  /**
   * Resend OTP for driver onboarding
   */
  async resendOtp(
    transporterId: string,
    driverPhone: string
  ): Promise<{
    message: string;
    expiresInMinutes: number;
  }> {
    const key = REDIS_KEYS.DRIVER_ONBOARD_OTP(driverPhone);
    const stored = await redisService.getJSON<DriverOnboardOtpEntry>(key);

    if (!stored) {
      throw new AppError(
        400,
        'NO_PENDING_REQUEST',
        'No pending onboarding request found. Please start again.'
      );
    }

    if (stored.transporterId !== transporterId) {
      throw new AppError(403, 'FORBIDDEN', 'Request belongs to another transporter');
    }

    // Generate new OTP
    const otp = generateSecureOTP(config.otp.length);
    const hashedOtp = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + this.OTP_EXPIRY_MINUTES * 60 * 1000);

    // Update stored entry
    stored.hashedOtp = hashedOtp;
    stored.expiresAt = expiresAt.toISOString();
    stored.attempts = 0;

    const ttlSeconds = this.OTP_EXPIRY_MINUTES * 60;
    await redisService.setJSON(key, stored, ttlSeconds);

    // Send OTP
    try {
      await smsService.sendOtp(driverPhone, otp);
    } catch (error) {
      logger.error('[DRIVER ONBOARD] Failed to resend OTP', { error });
    }

    // Dev console
    if (config.isDevelopment) {
      console.log(`\n🔄 RESENT OTP for driver ${maskForLogging(driverPhone, 2, 4)}: ${otp}\n`);
    }

    return {
      message: 'OTP resent to driver\'s phone',
      expiresInMinutes: this.OTP_EXPIRY_MINUTES
    };
  }

  /**
   * Cancel pending onboarding request
   */
  async cancelOnboarding(
    transporterId: string,
    driverPhone: string
  ): Promise<void> {
    const key = REDIS_KEYS.DRIVER_ONBOARD_OTP(driverPhone);
    const stored = await redisService.getJSON<DriverOnboardOtpEntry>(key);

    if (stored && stored.transporterId === transporterId) {
      await redisService.del(key);
      logger.info('[DRIVER ONBOARD] Onboarding cancelled', {
        driverPhone: maskForLogging(driverPhone, 2, 4)
      });
    }
  }

  /**
   * Mask phone number for display
   */
  private maskPhone(phone: string): string {
    if (phone.length < 4) return '****';
    return phone.substring(0, 2) + '****' + phone.substring(phone.length - 4);
  }
}

export const driverOnboardingService = new DriverOnboardingService();
