/**
 * =============================================================================
 * DRIVER MODULE - MANAGEMENT SERVICE
 * =============================================================================
 *
 * CRUD operations: create driver, list drivers, profile completion,
 * photo management, and driver lookup.
 * =============================================================================
 */

import { v4 as uuid } from 'uuid';
import { db, UserRecord, VehicleRecord } from '../../shared/database/db';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { socketService } from '../../shared/services/socket.service';
import { fleetCacheService } from '../../shared/services/fleet-cache.service';
import { CreateDriverInput } from './driver.schema';
import { maskPhoneForLog } from '../../shared/utils/pii.utils';
import { Prisma } from '@prisma/client';
import { getErrorMessage } from '../../shared/utils/error.utils';

class DriverManagementService {

  // ==========================================================================
  // TRANSPORTER - DRIVER MANAGEMENT
  // ==========================================================================

  /**
   * Create a new driver under a transporter
   */
  async createDriver(transporterId: string, data: CreateDriverInput & { licensePhoto?: string }): Promise<UserRecord> {
    // Check if driver with this phone already exists
    const existingResult = await db.getUserByPhone(data.phone, 'driver');
    const existing = existingResult && typeof (existingResult as any).then === 'function'
      ? await existingResult
      : existingResult;

    if (existing) {
      throw new AppError(400, 'DRIVER_EXISTS', 'A driver with this phone number already exists');
    }

    const driverResult = await db.createUser({
      id: uuid(),
      phone: data.phone,
      role: 'driver',
      name: data.name,
      email: data.email || undefined,
      transporterId: transporterId,
      licenseNumber: data.licenseNumber,
      licensePhoto: (data as any).licensePhoto || undefined,  // DL photo URL/base64
      isVerified: false,
      isActive: true
    });

    const driver = driverResult && typeof (driverResult as any).then === 'function'
      ? await driverResult
      : driverResult;

    logger.info(`Driver created: ${data.name} (${maskPhoneForLog(data.phone)}) for transporter ${transporterId}`);

    // Get updated driver stats
    const driverStats = await this.getTransporterDrivers(transporterId);

    // Emit real-time update to transporter
    socketService.emitToUser(transporterId, 'driver_added', {
      driver: {
        id: driver.id,
        name: driver.name,
        phone: driver.phone,
        licenseNumber: driver.licenseNumber,
        isVerified: driver.isVerified
      },
      driverStats: {
        total: driverStats.total,
        available: driverStats.available,
        onTrip: driverStats.onTrip
      },
      message: `Driver ${data.name} added successfully`
    });

    logger.info(`Real-time update sent: driver_added for transporter ${transporterId}`);

    return driver;
  }

  /**
   * Get all drivers for a transporter with stats
   */
  async getTransporterDrivers(transporterId: string): Promise<{
    drivers: UserRecord[];
    total: number;
    available: number;
    onTrip: number;
  }> {
    const drivers = await db.getDriversByTransporter(transporterId);

    // Get all vehicles to check which drivers are assigned
    const vehicles = await db.getVehiclesByTransporter(transporterId);
    const driversOnTrip = new Set(
      vehicles
        .filter((v: VehicleRecord) => v.status === 'in_transit' && v.assignedDriverId)
        .map((v: VehicleRecord) => v.assignedDriverId)
    );

    const activeDrivers = drivers.filter((d: UserRecord) => d.isActive);
    const available = activeDrivers.filter((d: UserRecord) => !driversOnTrip.has(d.id)).length;
    const onTrip = activeDrivers.filter((d: UserRecord) => driversOnTrip.has(d.id)).length;

    return {
      drivers: activeDrivers,
      total: activeDrivers.length,
      available,
      onTrip
    };
  }

  /**
   * Complete driver profile with photos and details
   *
   * @param driverId - Driver's user ID
   * @param profileData - Profile completion data
   * @returns Updated driver record
   */
  async completeProfile(
    driverId: string,
    profileData: {
      licenseNumber: string;
      vehicleType: string;
      address: string;
      language: string;
      driverPhotoUrl: string;
      licenseFrontUrl: string;
      licenseBackUrl: string;
      isProfileCompleted: boolean;
    }
  ): Promise<UserRecord> {
    try {
      logger.info('[DRIVER SERVICE] Completing driver profile', { driverId });

      // Update driver in database using db.updateUser wrapper
      const driver = await db.updateUser(driverId, {
        licenseNumber: profileData.licenseNumber,
        preferredVehicleType: profileData.vehicleType,
        address: profileData.address,
        preferredLanguage: profileData.language,
        profilePhoto: profileData.driverPhotoUrl,
        licenseFrontPhoto: profileData.licenseFrontUrl,
        licenseBackPhoto: profileData.licenseBackUrl,
        isProfileCompleted: profileData.isProfileCompleted
      });

      if (!driver) {
        throw new Error('Driver not found');
      }

      // Invalidate cache
      await fleetCacheService.invalidateDriverCache(driverId);

      logger.info('[DRIVER SERVICE] Profile completed successfully', {
        driverId,
        licenseNumber: profileData.licenseNumber
      });

      return driver;
    } catch (error: unknown) {
      logger.error('[DRIVER SERVICE] Failed to complete profile', {
        driverId,
        error: getErrorMessage(error)
      });
      throw error;
    }
  }

  /**
   * =============================================================================
   * PROFILE PHOTO MANAGEMENT METHODS
   * =============================================================================
   * Scalable, modular methods for updating driver photos
   * Easy to understand, follows coding standards
   * =============================================================================
   */

  /**
   * Get driver by ID
   *
   * @param driverId - Driver's user ID
   * @returns Driver record with all details
   */
  async getDriverById(driverId: string): Promise<UserRecord | null> {
    try {
      logger.info('[DRIVER SERVICE] Getting driver', { driverId });

      // Use db.getUserById wrapper method
      const driver = await db.getUserById(driverId);

      if (!driver) {
        logger.warn('[DRIVER SERVICE] Driver not found', { driverId });
        return null;
      }

      // Verify it's a driver role
      if (driver.role !== 'driver') {
        logger.warn('[DRIVER SERVICE] User is not a driver', { driverId, role: driver.role });
        return null;
      }

      logger.info('[DRIVER SERVICE] Driver retrieved successfully', {
        driverId,
        hasProfile: !!driver.profilePhoto
      });

      return driver;
    } catch (error: unknown) {
      logger.error('[DRIVER SERVICE] Failed to get driver', {
        driverId,
        error: getErrorMessage(error)
      });
      throw error;
    }
  }

  /**
   * Update profile photo
   *
   * @param driverId - Driver's user ID
   * @param photoUrl - New profile photo URL (S3)
   * @returns Updated driver record
   */
  async updateProfilePhoto(
    driverId: string,
    photoUrl: string
  ): Promise<UserRecord> {
    try {
      logger.info('[DRIVER SERVICE] Updating profile photo', { driverId });

      // Use db.updateUser wrapper method
      const driver = await db.updateUser(driverId, {
        profilePhoto: photoUrl
      });

      if (!driver) {
        throw new Error('Driver not found');
      }

      // Invalidate cache for real-time updates
      await fleetCacheService.invalidateDriverCache(driverId);

      logger.info('[DRIVER SERVICE] Profile photo updated', { driverId });

      return driver;
    } catch (error: unknown) {
      logger.error('[DRIVER SERVICE] Failed to update profile photo', {
        driverId,
        error: getErrorMessage(error)
      });
      throw error;
    }
  }

  /**
   * Update license photos (front and/or back)
   *
   * @param driverId - Driver's user ID
   * @param licenseFrontUrl - New license front URL (optional)
   * @param licenseBackUrl - New license back URL (optional)
   * @returns Updated driver record
   */
  async updateLicensePhotos(
    driverId: string,
    licenseFrontUrl?: string,
    licenseBackUrl?: string
  ): Promise<UserRecord> {
    try {
      logger.info('[DRIVER SERVICE] Updating license photos', { driverId });

      // Build update data dynamically
      const updateData: Prisma.UserUpdateInput = {};

      if (licenseFrontUrl) {
        updateData.licenseFrontPhoto = licenseFrontUrl;
      }

      if (licenseBackUrl) {
        updateData.licenseBackPhoto = licenseBackUrl;
      }

      // Use db.updateUser wrapper method
      const driver = await db.updateUser(driverId, updateData);

      if (!driver) {
        throw new Error('Driver not found');
      }

      // Invalidate cache for real-time updates
      await fleetCacheService.invalidateDriverCache(driverId);

      logger.info('[DRIVER SERVICE] License photos updated', { driverId });

      return driver;
    } catch (error: unknown) {
      logger.error('[DRIVER SERVICE] Failed to update license photos', {
        driverId,
        error: getErrorMessage(error)
      });
      throw error;
    }
  }
}

export const driverManagementService = new DriverManagementService();
