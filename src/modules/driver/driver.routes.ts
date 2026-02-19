/**
 * =============================================================================
 * DRIVER MODULE - ROUTES
 * =============================================================================
 * 
 * API routes for driver-specific operations like dashboard and availability.
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import multer from 'multer';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppError } from '../../shared/types/error.types';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { validateRequest, validateSchema } from '../../shared/utils/validation.utils';
import { driverService } from './driver.service';
import { s3UploadService } from '../../shared/services/s3-upload.service';
import { socketService } from '../../shared/services/socket.service';

// Multer configuration for photo uploads (memory storage for S3)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files allowed'));
    }
  }
});
import { 
  updateAvailabilitySchema, 
  getTripsQuerySchema, 
  getEarningsQuerySchema,
  createDriverSchema
} from './driver.schema';
import { fleetCacheService, onDriverChange } from '../../shared/services/fleet-cache.service';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { smsService } from '../auth/sms.service';
import { generateSecureOTP, maskForLogging } from '../../shared/utils/crypto.utils';
import { config } from '../../config/environment';
import { db } from '../../shared/database/db';
import { prismaClient } from '../../shared/database/prisma.service';

const router = Router();

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
router.post(
  '/onboard/initiate',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      
      logger.info('[DRIVER ONBOARD] Request received', { body: JSON.stringify(req.body) });
      
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
      } catch (smsErr: any) {
        logger.error('[DRIVER ONBOARD] SMS failed', { 
          error: smsErr.message,
          phone: maskForLogging(driverPhone, 2, 4),
          stack: smsErr.stack?.substring(0, 200)
        });
        // Don't fail - OTP is stored and shown in dev mode
      }
      
      // Dev mode: Log OTP (same as auth flow)
      if (config.isDevelopment) {
        console.log('\n');
        console.log('╔══════════════════════════════════════════════════════════════╗');
        console.log('║       🚗 DRIVER ONBOARD OTP (DEV MODE ONLY)                  ║');
        console.log('╠══════════════════════════════════════════════════════════════╣');
        console.log(`║  Driver Phone: ${maskForLogging(driverPhone, 2, 4).padEnd(44)}║`);
        console.log(`║  OTP:          ${otp.padEnd(44)}║`);
        console.log('╠══════════════════════════════════════════════════════════════╣');
        console.log('║  ⚠️  Ask driver for this OTP to complete registration!       ║');
        console.log('╚══════════════════════════════════════════════════════════════╝');
        console.log('\n');
      }
      
      res.json({
        success: true,
        data: {
          message: 'OTP sent to driver\'s phone',
          driverPhoneMasked: driverPhone.substring(0, 2) + '****' + driverPhone.substring(6),
          expiresInMinutes: 10
        },
        message: 'OTP sent to driver\'s phone. Ask driver for the code.'
      });
    } catch (error: any) {
      logger.error('[DRIVER ONBOARD] Initiate failed', { error: error.message });
      res.status(400).json({
        success: false,
        error: { code: error.code || 'ERROR', message: error.message || 'Failed to send OTP' }
      });
    }
  }
);

/**
 * POST /api/v1/driver/onboard/verify
 * 
 * Step 2: Verify OTP and add driver to fleet
 */
router.post(
  '/onboard/verify',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
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
      
      res.status(201).json({
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
    } catch (error: any) {
      logger.error('[DRIVER ONBOARD] Verify failed', { error: error.message });
      res.status(400).json({
        success: false,
        error: { code: error.code || 'ERROR', message: error.message || 'Failed to verify OTP' }
      });
    }
  }
);

/**
 * POST /api/v1/driver/onboard/resend
 * 
 * Resend OTP to driver's phone
 */
router.post(
  '/onboard/resend',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
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
      
      if (config.isDevelopment) {
        console.log(`\n🔐 RESENT OTP: ${otp} (for ${phone})\n`);
      }
      
      res.json({
        success: true,
        data: { message: 'OTP resent', expiresInMinutes: 10 },
        message: 'OTP resent to driver\'s phone'
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        error: { code: 'ERROR', message: error.message || 'Failed to resend OTP' }
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
router.post(
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
      next(error);
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
router.get(
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
      next(error);
    }
  }
);

// =============================================================================
// DRIVER DASHBOARD
// =============================================================================

/**
 * GET /api/v1/driver/dashboard
 * Get driver dashboard with stats, recent trips, and earnings
 */
router.get(
  '/dashboard',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const dashboard = await driverService.getDashboard(userId);
      
      res.json({
        success: true,
        data: dashboard
      });
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// DRIVER PERFORMANCE
// =============================================================================

/**
 * GET /api/v1/driver/performance
 * Get driver performance metrics (acceptance rate, completion rate, rating, distance)
 * 
 * SCALABILITY:
 *   - All queries use indexed columns (driverId, driverId+status)
 *   - COUNT queries → O(log n), sub-50ms at millions of rows
 *   - Can add Redis cache (5min TTL) at scale
 * 
 * DATA ISOLATION:
 *   - Every query is WHERE driverId = ? — driver only sees their own data
 * 
 * RESPONSE:
 *   { success: true, data: { rating, totalRatings, acceptanceRate,
 *     onTimeDeliveryRate, completionRate, totalTrips, totalDistance } }
 */
router.get(
  '/performance',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let targetDriverId = req.user!.userId;

      // Phase 5: Transporter can query a specific driver's performance
      // Usage: GET /api/v1/driver/performance?driverId=xxx
      if (req.user!.role === 'transporter' && req.query.driverId) {
        const requestedDriverId = req.query.driverId as string;
        // Verify driver belongs to this transporter
        const driver = await fleetCacheService.getDriver(requestedDriverId);
        if (!driver || driver.transporterId !== req.user!.userId) {
          return res.status(403).json({
            success: false,
            error: { code: 'FORBIDDEN', message: 'This driver does not belong to you' }
          });
        }
        targetDriverId = requestedDriverId;
      }

      const performance = await driverService.getPerformance(targetDriverId);

      res.json({
        success: true,
        data: performance
      });
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// DRIVER AVAILABILITY
// =============================================================================

/**
 * GET /api/v1/driver/availability
 * Get current driver availability status
 */
router.get(
  '/availability',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const availability = await driverService.getAvailability(userId);
      
      res.json({
        success: true,
        data: availability
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/driver/available
 * Get available drivers for assignment (Transporter only)
 * 
 * REDIS CACHING:
 * - Returns only available drivers (active, not on trip)
 * - TTL: 5 minutes
 */
router.get(
  '/available',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      
      logger.info(`[Drivers] Getting available drivers for ${transporterId.substring(0, 8)}`);
      
      // Use Redis cache for available drivers
      const availableDrivers = await fleetCacheService.getAvailableDrivers(transporterId);
      
      logger.info(`[Drivers] Found ${availableDrivers.length} available drivers`);
      
      res.json({
        success: true,
        data: {
          drivers: availableDrivers,
          total: availableDrivers.length
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/driver/online-drivers
 * Get currently online drivers for a transporter (real-time from Redis)
 * 
 * Uses Redis SET + presence key verification for accurate status.
 * No caching — always returns real-time data.
 */
router.get(
  '/online-drivers',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      
      const onlineDriverIds = await driverService.getOnlineDriverIds(transporterId);
      
      res.json({
        success: true,
        data: {
          onlineDriverIds,
          total: onlineDriverIds.length
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /api/v1/driver/availability
 * Update driver availability status
 * 
 * AUTO-UPDATE CACHE: Invalidates driver cache on availability change
 */
router.put(
  '/availability',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  validateRequest(updateAvailabilitySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const { isOnline, currentLocation } = req.body;
      
      const availability = await driverService.updateAvailability(userId, {
        isOnline,
        currentLocation
      });
      
      // AUTO-UPDATE: Invalidate driver cache for the transporter
      // Get driver's transporter ID from the service
      const driver = await fleetCacheService.getDriver(userId);
      if (driver && driver.transporterId) {
        await onDriverChange(driver.transporterId, userId);
        logger.info(`[Drivers] Cache invalidated for availability change`);
      }
      
      res.json({
        success: true,
        message: isOnline ? 'You are now online' : 'You are now offline',
        data: availability
      });
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// DRIVER EARNINGS
// =============================================================================

/**
 * GET /api/v1/driver/earnings
 * Get driver earnings summary
 */
router.get(
  '/earnings',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let targetDriverId = req.user!.userId;

      // Phase 5: Transporter can query a specific driver's earnings
      // Usage: GET /api/v1/driver/earnings?driverId=xxx&period=month
      if (req.user!.role === 'transporter' && req.query.driverId) {
        const requestedDriverId = req.query.driverId as string;
        // Verify driver belongs to this transporter
        const driver = await fleetCacheService.getDriver(requestedDriverId);
        if (!driver || driver.transporterId !== req.user!.userId) {
          return res.status(403).json({
            success: false,
            error: { code: 'FORBIDDEN', message: 'This driver does not belong to you' }
          });
        }
        targetDriverId = requestedDriverId;
      }

      const query = getEarningsQuerySchema.parse(req.query);
      
      const earnings = await driverService.getEarnings(targetDriverId, query.period);
      
      res.json({
        success: true,
        data: earnings
      });
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// DRIVER TRIPS/BOOKINGS
// =============================================================================

/**
 * GET /api/v1/driver/trips
 * Get driver's trip history
 */
router.get(
  '/trips',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let targetDriverId = req.user!.userId;

      // Phase 5: Transporter can query a specific driver's trips
      // Usage: GET /api/v1/driver/trips?driverId=xxx&status=completed
      if (req.user!.role === 'transporter' && req.query.driverId) {
        const requestedDriverId = req.query.driverId as string;
        // Verify driver belongs to this transporter
        const driver = await fleetCacheService.getDriver(requestedDriverId);
        if (!driver || driver.transporterId !== req.user!.userId) {
          return res.status(403).json({
            success: false,
            error: { code: 'FORBIDDEN', message: 'This driver does not belong to you' }
          });
        }
        targetDriverId = requestedDriverId;
      }

      const { status, limit = 20, offset = 0 } = req.query;
      
      const trips = await driverService.getTrips(targetDriverId, {
        status: status as string,
        limit: Number(limit),
        offset: Number(offset)
      });
      
      res.json({
        success: true,
        data: trips
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/driver/trips/active
 * Get driver's currently active trip
 */
router.get(
  '/trips/active',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let targetDriverId = req.user!.userId;

      // Phase 5: Transporter can query a specific driver's active trip
      if (req.user!.role === 'transporter' && req.query.driverId) {
        const requestedDriverId = req.query.driverId as string;
        const driver = await fleetCacheService.getDriver(requestedDriverId);
        if (!driver || driver.transporterId !== req.user!.userId) {
          return res.status(403).json({
            success: false,
            error: { code: 'FORBIDDEN', message: 'This driver does not belong to you' }
          });
        }
        targetDriverId = requestedDriverId;
      }

      const activeTrip = await driverService.getActiveTrip(targetDriverId);
      
      res.json({
        success: true,
        data: activeTrip
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/driver/complete-profile
 * Complete driver profile with photos (selfie, license)
 * 
 * Uploads photos to S3 and saves profile data
 * Scalable: Supports millions of concurrent uploads
 * 
 * Body (multipart/form-data):
 * - driverPhoto: File (selfie)
 * - licenseFront: File (license front)
 * - licenseBack: File (license back)
 * - licenseNumber: string
 * - vehicleType: string
 * - address: string (optional)
 */
router.post(
  '/complete-profile',
  authMiddleware,
  roleGuard(['driver']),
  upload.fields([
    { name: 'driverPhoto', maxCount: 1 },
    { name: 'licenseFront', maxCount: 1 },
    { name: 'licenseBack', maxCount: 1 }
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const driverId = req.user!.userId;
      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      const { licenseNumber, vehicleType, address, language } = req.body;

      logger.info('[DRIVER PROFILE] Starting profile completion', { 
        driverId,
        hasDriverPhoto: !!files?.driverPhoto,
        hasLicenseFront: !!files?.licenseFront,
        hasLicenseBack: !!files?.licenseBack
      });

      // Validate required fields
      if (!licenseNumber || !vehicleType) {
        throw new AppError(400, 'VALIDATION_ERROR', 'License number and vehicle type are required');
      }

      if (!files?.driverPhoto || !files?.licenseFront || !files?.licenseBack) {
        throw new AppError(400, 'VALIDATION_ERROR', 'All three photos are required');
      }

      // Upload photos to S3
      const { s3UploadService } = await import('../../shared/services/s3-upload.service');
      
      const photoUrls = await s3UploadService.uploadDriverPhotos(driverId, {
        driverPhoto: files.driverPhoto[0].buffer,
        licenseFront: files.licenseFront[0].buffer,
        licenseBack: files.licenseBack[0].buffer,
      });

      // Update driver profile in database
      const updatedDriver = await driverService.completeProfile(driverId, {
        licenseNumber,
        vehicleType,
        address: address || '',
        language: language || 'en',
        driverPhotoUrl: photoUrls.driverPhotoUrl!,
        licenseFrontUrl: photoUrls.licenseFrontUrl!,
        licenseBackUrl: photoUrls.licenseBackUrl!,
        isProfileCompleted: true,
      });

      // Emit WebSocket event for real-time update
      const { socketService } = await import('../../shared/services/socket.service');
      socketService.emitToUser(driverId, 'profile_completed', {
        driverId,
        message: 'Profile completed successfully',
        driver: {
          id: updatedDriver.id,
          name: updatedDriver.name,
          licenseNumber,
          vehicleType,
          isProfileCompleted: true,
        }
      });

      logger.info('[DRIVER PROFILE] Profile completed successfully', { 
        driverId,
        photoUrls: Object.keys(photoUrls)
      });

      res.json({
        success: true,
        message: 'Profile completed successfully',
        data: {
          driver: {
            id: updatedDriver.id,
            name: updatedDriver.name,
            phone: updatedDriver.phone,
            licenseNumber,
            vehicleType,
            address,
            photoUrls,
            isProfileCompleted: true,
          }
        }
      });
    } catch (error) {
      logger.error('[DRIVER PROFILE] Profile completion failed', { 
        error: (error as Error).message,
        driverId: req.user?.userId
      });
      next(error);
    }
  }
);

// =============================================================================
// PROFILE MANAGEMENT ENDPOINTS
// =============================================================================
// Get, update, and manage driver profile photos with real-time updates
// Scalable, modular, easy to understand
// =============================================================================

/**
 * Get Driver Profile with Photos
 * GET /api/v1/driver/profile
 * 
 * Returns complete driver profile including:
 * - Basic info (name, phone, email)
 * - Profile photo URL
 * - License photos (front & back)
 * - Vehicle preferences
 * - Profile completion status
 * 
 * Scalability: Cached for performance
 * Modularity: Reusable service method
 */
router.get(
  '/profile',
  authMiddleware,
  roleGuard(['driver']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const driverId = req.user!.userId;
      
      logger.info('[DRIVER PROFILE] Fetching profile', { driverId });

      // Get driver profile from service
      const driver = await driverService.getDriverById(driverId);

      if (!driver) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'DRIVER_NOT_FOUND',
            message: 'Driver profile not found'
          }
        });
      }

      // Format response with photo URLs
      const driverData = driver as any; // Cast to access all properties
      const profileData = {
        id: driverData.id,
        name: driverData.name,
        phone: driverData.phone,
        email: driverData.email,
        licenseNumber: driverData.licenseNumber,
        vehicleType: driverData.preferredVehicleType,
        address: driverData.address,
        language: driverData.preferredLanguage,
        photos: {
          profilePhoto: driverData.profilePhoto || null,
          licenseFront: driverData.licenseFrontPhoto || null,
          licenseBack: driverData.licenseBackPhoto || null
        },
        isProfileCompleted: driverData.isProfileCompleted,
        createdAt: driverData.createdAt,
        updatedAt: driverData.updatedAt
      };

      res.json({
        success: true,
        data: { driver: profileData }
      });

    } catch (error) {
      logger.error('[DRIVER PROFILE] Failed to fetch profile', {
        error: (error as Error).message,
        driverId: req.user?.userId
      });
      next(error);
    }
  }
);

/**
 * Update Profile Photo
 * PUT /api/v1/driver/profile/photo
 * 
 * Updates driver's profile photo and emits real-time update event
 * 
 * Scalability: S3 for unlimited storage, WebSocket for real-time
 * Modularity: Separate endpoint for single responsibility
 */
router.put(
  '/profile/photo',
  authMiddleware,
  roleGuard(['driver']),
  upload.single('photo'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const driverId = req.user!.userId;
      const photoFile = req.file;

      if (!photoFile) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'PHOTO_REQUIRED',
            message: 'Profile photo is required'
          }
        });
      }

      logger.info('[DRIVER PROFILE] Updating profile photo', { driverId });

      // Upload to S3
      const uploadResults = await s3UploadService.uploadDriverPhotos(
        driverId,
        { driverPhoto: photoFile.buffer }
      );
      const photoUrl = uploadResults.driverPhotoUrl!;

      // Update in database
      const updatedDriver = await driverService.updateProfilePhoto(driverId, photoUrl);

      // Emit real-time update via WebSocket
      socketService.emitToUser(driverId, 'profile_photo_updated', {
        photoUrl,
        updatedAt: new Date()
      });

      res.json({
        success: true,
        message: 'Profile photo updated successfully',
        data: {
          photoUrl,
          driver: {
            id: updatedDriver.id,
            name: updatedDriver.name,
            profilePhoto: photoUrl
          }
        }
      });

    } catch (error) {
      logger.error('[DRIVER PROFILE] Failed to update profile photo', {
        error: (error as Error).message,
        driverId: req.user?.userId
      });
      next(error);
    }
  }
);

/**
 * Update License Photos
 * PUT /api/v1/driver/profile/license
 * 
 * Updates driver's license photos (front and/or back) with real-time updates
 * 
 * Scalability: Handles multiple files, S3 storage
 * Modularity: Clear separation of concerns
 */
router.put(
  '/profile/license',
  authMiddleware,
  roleGuard(['driver']),
  upload.fields([
    { name: 'licenseFront', maxCount: 1 },
    { name: 'licenseBack', maxCount: 1 }
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const driverId = req.user!.userId;
      const files = req.files as { [fieldname: string]: Express.Multer.File[] };

      if (!files?.licenseFront && !files?.licenseBack) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'PHOTOS_REQUIRED',
            message: 'At least one license photo is required'
          }
        });
      }

      logger.info('[DRIVER PROFILE] Updating license photos', { driverId });

      let licenseFrontUrl: string | undefined;
      let licenseBackUrl: string | undefined;

      // Build photos object
      const photosToUpload: any = {};
      if (files.licenseFront?.[0]) {
        photosToUpload.licenseFront = files.licenseFront[0].buffer;
      }
      if (files.licenseBack?.[0]) {
        photosToUpload.licenseBack = files.licenseBack[0].buffer;
      }

      // Upload to S3
      const uploadResults = await s3UploadService.uploadDriverPhotos(
        driverId,
        photosToUpload
      );
      
      licenseFrontUrl = uploadResults.licenseFrontUrl;
      licenseBackUrl = uploadResults.licenseBackUrl;

      // Update in database
      const updatedDriver = await driverService.updateLicensePhotos(
        driverId,
        licenseFrontUrl,
        licenseBackUrl
      );

      // Emit real-time update via WebSocket
      socketService.emitToUser(driverId, 'license_photos_updated', {
        licenseFrontUrl,
        licenseBackUrl,
        updatedAt: new Date()
      });

      res.json({
        success: true,
        message: 'License photos updated successfully',
        data: {
          photos: {
            licenseFront: licenseFrontUrl || (updatedDriver as any).licenseFrontPhoto,
            licenseBack: licenseBackUrl || (updatedDriver as any).licenseBackPhoto
          },
          driver: {
            id: updatedDriver.id,
            name: updatedDriver.name
          }
        }
      });

    } catch (error) {
      logger.error('[DRIVER PROFILE] Failed to update license photos', {
        error: (error as Error).message,
        driverId: req.user?.userId
      });
      next(error);
    }
  }
);

/**
 * =============================================================================
 * ADMIN: Regenerate Presigned URLs for All Driver Photos
 * =============================================================================
 * 
 * POST /api/v1/driver/regenerate-urls
 * 
 * Converts old S3 URLs to presigned URLs for existing photos
 * Useful after bucket policy changes or initial setup
 */
router.post('/regenerate-urls', authMiddleware, roleGuard(['transporter']), async (req: Request, res: Response) => {
  try {
    logger.info('[ADMIN] Regenerating presigned URLs...');
    
    const s3Client = new S3Client({
      region: process.env.AWS_SNS_REGION || 'ap-south-1',
    });
    
    const bucket = process.env.S3_BUCKET || 'weelo-driver-profiles-production';
    
    async function generatePresignedUrl(oldUrl: string): Promise<string> {
      try {
        const urlParts = oldUrl.split('.com/');
        if (urlParts.length < 2) return oldUrl;
        
        const key = urlParts[1];
        
        const command = new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        });
        
        const presignedUrl = await getSignedUrl(s3Client, command, {
          expiresIn: 604800, // 7 days
        });
        
        return presignedUrl;
      } catch (error: any) {
        logger.error('Failed to generate presigned URL', { error: error.message });
        return oldUrl;
      }
    }
    
    // Get all drivers from database with photos
    const drivers = await prismaClient.user.findMany({
      where: {
        role: 'driver',
        OR: [
          { profilePhoto: { not: null } },
          { licenseFrontPhoto: { not: null } },
          { licenseBackPhoto: { not: null } }
        ]
      }
    });
    
    logger.info(`Found ${drivers.length} drivers with photos`);
    
    let updated = 0;
    
    for (const driver of drivers) {
      const updates: any = {};
      
      if (driver.profilePhoto && !driver.profilePhoto.includes('X-Amz-Signature')) {
        updates.profilePhoto = await generatePresignedUrl(driver.profilePhoto);
      }
      
      if (driver.licenseFrontPhoto && !driver.licenseFrontPhoto.includes('X-Amz-Signature')) {
        updates.licenseFrontPhoto = await generatePresignedUrl(driver.licenseFrontPhoto);
      }
      
      if (driver.licenseBackPhoto && !driver.licenseBackPhoto.includes('X-Amz-Signature')) {
        updates.licenseBackPhoto = await generatePresignedUrl(driver.licenseBackPhoto);
      }
      
      if (Object.keys(updates).length > 0) {
        await prismaClient.user.update({
          where: { id: driver.id },
          data: updates
        });
        updated++;
        logger.info(`Updated URLs for driver: ${driver.name || driver.phone}`);
      }
    }
    
    logger.info(`✅ Regenerated URLs for ${updated} drivers`);
    
    res.json({
      success: true,
      message: `Regenerated presigned URLs for ${updated} drivers`,
      data: { updated, total: drivers.length },
    });
  } catch (error: any) {
    logger.error('Failed to regenerate URLs', { error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'REGENERATION_FAILED', message: error.message },
    });
  }
});

export { router as driverRouter };
