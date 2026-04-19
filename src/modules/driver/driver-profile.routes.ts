/**
 * =============================================================================
 * DRIVER PROFILE ROUTES (Profile, Photos, Admin URL Regeneration)
 * =============================================================================
 *
 * API Endpoints:
 * - POST /complete-profile      - Complete driver profile with photos
 * - GET  /profile               - Get driver profile with photos
 * - PUT  /profile/photo         - Update profile photo
 * - PUT  /profile/license       - Update license photos
 * - POST /regenerate-urls       - Regenerate presigned URLs for all driver photos
 *
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppError } from '../../shared/types/error.types';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { driverService } from './driver.service';
import { s3UploadService } from '../../shared/services/s3-upload.service';
import { socketService } from '../../shared/services/socket.service';
import { logger } from '../../shared/services/logger.service';
import { prismaClient } from '../../shared/database/prisma.service';
import { maskPhoneForLog } from '../../shared/utils/pii.utils';
import { getErrorMessage } from '../../shared/utils/error.utils';

// Multer configuration for photo uploads (memory storage for S3)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files allowed'));
    }
  }
});

const driverProfileRouter = Router();

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
driverProfileRouter.post(
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
      return next(error);
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
driverProfileRouter.get(
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
      return next(error);
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
driverProfileRouter.put(
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
      return next(error);
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
driverProfileRouter.put(
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
      const photosToUpload: Record<string, Buffer> = {};
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
            licenseFront: licenseFrontUrl,
            licenseBack: licenseBackUrl
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
      return next(error);
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
driverProfileRouter.post('/regenerate-urls', authMiddleware, roleGuard(['transporter']), async (_req: Request, res: Response) => {
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
      } catch (error: unknown) {
        logger.error('Failed to generate presigned URL', { error: getErrorMessage(error) });
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
      const updates: Record<string, string> = {};

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
        logger.info(`Updated URLs for driver: ${driver.name || maskPhoneForLog(driver.phone)}`);
      }
    }

    logger.info(`✅ Regenerated URLs for ${updated} drivers`);

    res.json({
      success: true,
      message: `Regenerated presigned URLs for ${updated} drivers`,
      data: { updated, total: drivers.length },
    });
  } catch (error: unknown) {
    logger.error('Failed to regenerate URLs', { error: getErrorMessage(error) });
    res.status(500).json({
      success: false,
      error: { code: 'REGENERATION_FAILED', message: getErrorMessage(error) },
    });
  }
});

export { driverProfileRouter };
