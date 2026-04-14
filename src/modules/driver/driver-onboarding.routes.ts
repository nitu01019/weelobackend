/**
 * =============================================================================
 * DRIVER ONBOARDING ROUTES
 * =============================================================================
 *
 * API Endpoints:
 * - POST /onboard/initiate  - Transporter initiates driver onboarding (sends OTP)
 * - POST /onboard/verify    - Verify OTP and add driver to fleet
 * - POST /onboard/resend    - Resend OTP to driver's phone
 * - POST /create            - Transporter creates a new driver (direct)
 * - GET  /list              - Transporter gets all their drivers
 *
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { otpRateLimiter } from '../../shared/middleware/rate-limiter.middleware';
import { validateSchema, maskPhone } from '../../shared/utils/validation.utils';
import { driverService } from './driver.service';
import { createDriverSchema } from './driver.schema';
import { fleetCacheService, onDriverChange } from '../../shared/services/fleet-cache.service';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { smsService } from '../auth/sms.service';
import { generateSecureOTP, maskForLogging } from '../../shared/utils/crypto.utils';
import { config } from '../../config/environment';
import { db } from '../../shared/database/db';
import { getErrorMessage } from '../../shared/utils/error.utils';

const driverOnboardingRouter = Router();

// =============================================================================
// DRIVER ONBOARDING WITH OTP VERIFICATION (NEW!)
// =============================================================================

// Validation schemas for onboarding
const onboardInitiateSchema = z.object({
  phone: z.string().min(10).max(10).regex(/^\d{10}$/, 'Phone must be 10 digits'),
  name: z.string().min(2).max(100),
  licenseNumber: z.string().min(3).max(30),
  licensePhoto: z.string().nullish(),  // Base64 or URL of DL photo (optional)
  email: z.string().email().nullish().or(z.literal(''))  // Optional email, can be null or empty
}).passthrough();  // Allow extra fields

const onboardVerifySchema = z.object({
  phone: z.string().min(10).max(10),
  otp: z.string().min(4).max(6)
});

/**
 * POST /api/v1/driver/onboard/initiate
 *
 * Step 1: Transporter initiates driver onboarding
 * - OTP is sent to DRIVER's phone for verification
 * - Ensures driver owns the phone number
 */
driverOnboardingRouter.post(
  '/onboard/initiate',
  authMiddleware,
  roleGuard(['transporter']),
  otpRateLimiter,  // #46: Rate limit OTP requests on driver onboarding
  async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;

      // #119: Avoid logging full request body (may contain PII); log masked phone instead
      logger.info('[DRIVER ONBOARD] Request received', { phone: maskPhone(req.body?.phone || '') });

      const data = validateSchema(onboardInitiateSchema, req.body);
      const driverPhone = data.phone;

      // Check if driver already exists
      const existingResult = db.getUserByPhone ? await db.getUserByPhone(driverPhone, 'driver') : null;
      const existing = existingResult && typeof (existingResult as any).then === 'function'
        ? await existingResult
        : existingResult;

      if (existing) {
        if ((existing as any).transporterId === transporterId) {
          return res.status(409).json({
            success: false,
            error: { code: 'DRIVER_ALREADY_IN_FLEET', message: 'This driver is already in your fleet' }
          });
        }
        return res.status(409).json({
          success: false,
          error: { code: 'DRIVER_EXISTS', message: 'A driver with this phone already exists with another transporter' }
        });
      }

      // Get transporter info
      const transporterResult = await db.getUserById(transporterId);
      const transporter = transporterResult && typeof (transporterResult as any).then === 'function'
        ? await transporterResult
        : transporterResult;

      // Generate OTP
      const otp = generateSecureOTP(6);
      const hashedOtp = await bcrypt.hash(otp, 10);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      // Store in Redis
      const redisKey = `driver-onboard:${driverPhone}`;
      await redisService.setJSON(redisKey, {
        hashedOtp,
        transporterId,
        transporterName: (transporter as any)?.name || (transporter as any)?.businessName || 'Transporter',
        driverPhone,
        driverName: data.name,
        licenseNumber: data.licenseNumber,
        licensePhoto: data.licensePhoto || null,  // Store DL photo
        email: data.email || null,
        expiresAt: expiresAt.toISOString(),
        attempts: 0
      }, 600); // 10 minute TTL

      // Send OTP to driver's phone via SMS (same as auth flow)
      try {
        logger.info('[DRIVER ONBOARD] Sending SMS to driver', { phone: maskForLogging(driverPhone, 2, 4) });
        await smsService.sendOtp(driverPhone, otp);
        logger.info('[DRIVER ONBOARD] OTP SMS sent successfully', { phone: maskForLogging(driverPhone, 2, 4) });
      } catch (smsErr: unknown) {
        logger.error('[DRIVER ONBOARD] SMS failed', {
          error: getErrorMessage(smsErr),
          phone: maskForLogging(driverPhone, 2, 4),
          stack: smsErr instanceof Error ? smsErr.stack?.substring(0, 200) : undefined
        });
        // Don't fail - OTP is stored and shown in dev mode
      }

      // #47/#119: Dev-only OTP log with masked phone; OTP visible only in dev
      if (config.isDevelopment) {
        logger.debug('[DRIVER ONBOARD] OTP generated', {
          phoneLast4: driverPhone.slice(-4),
          otpLength: otp.length
        });
      }

      return res.json({
        success: true,
        data: {
          message: 'OTP sent to driver\'s phone',
          driverPhoneMasked: driverPhone.substring(0, 2) + '****' + driverPhone.substring(6),
          expiresInMinutes: 10
        },
        message: 'OTP sent to driver\'s phone. Ask driver for the code.'
      });
    } catch (error: unknown) {
      logger.error('[DRIVER ONBOARD] Initiate failed', { error: getErrorMessage(error) });
      return res.status(400).json({
        success: false,
        error: { code: (error as { code?: string }).code || 'ERROR', message: getErrorMessage(error) || 'Failed to send OTP' }
      });
    }
  }
);

/**
 * POST /api/v1/driver/onboard/verify
 *
 * Step 2: Verify OTP and add driver to fleet
 */
driverOnboardingRouter.post(
  '/onboard/verify',
  authMiddleware,
  roleGuard(['transporter']),
  otpRateLimiter,  // #46: Rate limit OTP verify requests on driver onboarding
  async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const data = validateSchema(onboardVerifySchema, req.body);
      const driverPhone = data.phone;

      // Get stored OTP
      const redisKey = `driver-onboard:${driverPhone}`;
      const stored = await redisService.getJSON<any>(redisKey);

      if (!stored) {
        return res.status(400).json({
          success: false,
          error: { code: 'OTP_NOT_FOUND', message: 'No pending request. Please start again.' }
        });
      }

      // Verify transporter
      if (stored.transporterId !== transporterId) {
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'This request belongs to another transporter' }
        });
      }

      // Check expiry
      if (new Date() > new Date(stored.expiresAt)) {
        await redisService.del(redisKey);
        return res.status(400).json({
          success: false,
          error: { code: 'OTP_EXPIRED', message: 'OTP has expired. Please start again.' }
        });
      }

      // Check attempts
      if (stored.attempts >= 3) {
        await redisService.del(redisKey);
        return res.status(400).json({
          success: false,
          error: { code: 'OTP_MAX_ATTEMPTS', message: 'Too many failed attempts. Please start again.' }
        });
      }

      // Verify OTP
      const isValid = await bcrypt.compare(data.otp, stored.hashedOtp);

      if (!isValid) {
        stored.attempts++;
        await redisService.setJSON(redisKey, stored, 600);
        return res.status(400).json({
          success: false,
          error: { code: 'OTP_INVALID', message: `Invalid OTP. ${3 - stored.attempts} attempts remaining.` }
        });
      }

      // OTP valid - delete it
      await redisService.del(redisKey);

      // Create driver with all details including DL photo
      const driver = await driverService.createDriver(transporterId, {
        phone: driverPhone,
        name: stored.driverName,
        licenseNumber: stored.licenseNumber,
        licensePhoto: stored.licensePhoto,
        email: stored.email
      });

      // Invalidate cache
      await onDriverChange(transporterId, driver.id);

      logger.info('[DRIVER ONBOARD] Driver added', {
        driverId: driver.id,
        phone: maskForLogging(driverPhone, 2, 4)
      });

      return res.status(201).json({
        success: true,
        data: {
          driver: {
            id: driver.id,
            name: driver.name,
            phone: driver.phone,
            licenseNumber: driver.licenseNumber,
            isVerified: true
          }
        },
        message: `Driver ${driver.name} added successfully!`
      });
    } catch (error: unknown) {
      logger.error('[DRIVER ONBOARD] Verify failed', { error: getErrorMessage(error) });
      return res.status(400).json({
        success: false,
        error: { code: (error as { code?: string }).code || 'ERROR', message: getErrorMessage(error) || 'Failed to verify OTP' }
      });
    }
  }
);

/**
 * POST /api/v1/driver/onboard/resend
 *
 * Resend OTP to driver's phone
 */
driverOnboardingRouter.post(
  '/onboard/resend',
  authMiddleware,
  roleGuard(['transporter']),
  otpRateLimiter,  // #46: Rate limit OTP resend requests on driver onboarding
  async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const { phone } = req.body;

      if (!phone) {
        return res.status(400).json({
          success: false,
          error: { code: 'MISSING_PHONE', message: 'Phone number is required' }
        });
      }

      const redisKey = `driver-onboard:${phone}`;
      const stored = await redisService.getJSON<any>(redisKey);

      if (!stored || stored.transporterId !== transporterId) {
        return res.status(400).json({
          success: false,
          error: { code: 'NO_PENDING_REQUEST', message: 'No pending request found. Please start again.' }
        });
      }

      // Generate new OTP
      const otp = generateSecureOTP(6);
      const hashedOtp = await bcrypt.hash(otp, 10);

      stored.hashedOtp = hashedOtp;
      stored.attempts = 0;
      stored.expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      await redisService.setJSON(redisKey, stored, 600);

      // Send SMS
      try {
        await smsService.sendOtp(phone, otp);
      } catch (err) {
        logger.error('[DRIVER ONBOARD] Resend SMS failed', { error: (err as any).message });
      }

      // #47/#119: Mask phone in resend log; guard with isDevelopment
      if (config.isDevelopment) {
        logger.debug('[DRIVER ONBOARD] OTP resent', { phoneLast4: phone.slice(-4) });
      }

      return res.json({
        success: true,
        data: { message: 'OTP resent', expiresInMinutes: 10 },
        message: 'OTP resent to driver\'s phone'
      });
    } catch (error: unknown) {
      return res.status(400).json({
        success: false,
        error: { code: 'ERROR', message: getErrorMessage(error) || 'Failed to resend OTP' }
      });
    }
  }
);

// =============================================================================
// TRANSPORTER - MANAGE DRIVERS
// =============================================================================

/**
 * POST /api/v1/driver/create
 * Transporter creates a new driver under their account
 *
 * AUTO-UPDATE CACHE: Invalidates driver cache on create
 */
driverOnboardingRouter.post(
  '/create',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = validateSchema(createDriverSchema, req.body);
      const transporterId = req.user!.userId;

      const driver = await driverService.createDriver(transporterId, data);

      // AUTO-UPDATE: Invalidate Redis cache so new driver appears immediately
      await onDriverChange(transporterId, driver.id);
      logger.info(`[Drivers] Cache invalidated for transporter ${transporterId.substring(0, 8)}`);

      res.status(201).json({
        success: true,
        data: { driver },
        message: `Driver ${driver.name} added successfully`
      });
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * GET /api/v1/driver/list
 * Transporter gets all their drivers
 *
 * REDIS CACHING:
 * - Cache key: fleet:drivers:{transporterId}
 * - TTL: 5 minutes
 * - Auto-invalidated on driver create/update/delete
 */
driverOnboardingRouter.get(
  '/list',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const forceRefresh = req.query.refresh === 'true';

      logger.info(`[Drivers] Getting drivers for ${transporterId.substring(0, 8)}... (cache: ${forceRefresh ? 'bypass' : 'enabled'})`);

      // Use Redis cache for drivers list
      const cachedDrivers = await fleetCacheService.getTransporterDrivers(transporterId, forceRefresh);

      // Calculate stats
      const activeDrivers = cachedDrivers.filter(d => d.status === 'active');
      const availableDrivers = cachedDrivers.filter(d => d.status === 'active' && d.isAvailable && !d.currentTripId);

      logger.info(`[Drivers] Found ${cachedDrivers.length} drivers (${availableDrivers.length} available)`);

      res.json({
        success: true,
        data: {
          drivers: cachedDrivers,
          total: cachedDrivers.length,
          active: activeDrivers.length,
          available: availableDrivers.length,
          cached: !forceRefresh
        }
      });
    } catch (error) {
      return next(error);
    }
  }
);

export { driverOnboardingRouter };
