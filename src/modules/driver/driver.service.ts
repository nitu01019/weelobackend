/**
 * =============================================================================
 * DRIVER MODULE - SERVICE
 * =============================================================================
 * 
 * Business logic for driver operations.
 * =============================================================================
 */

import { v4 as uuid } from 'uuid';
import { db, BookingRecord, UserRecord } from '../../shared/database/db';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { socketService } from '../../shared/services/socket.service';
import { fleetCacheService } from '../../shared/services/fleet-cache.service';
import { CreateDriverInput } from './driver.schema';

interface DashboardData {
  stats: {
    totalTrips: number;
    completedToday: number;
    totalEarnings: number;
    todayEarnings: number;
    rating: number;
    acceptanceRate: number;
  };
  recentTrips: any[];
  availability: {
    isOnline: boolean;
    lastOnline: string | null;
  };
}

interface AvailabilityData {
  isOnline: boolean;
  currentLocation?: {
    latitude: number;
    longitude: number;
  };
  lastUpdated: string;
}

interface EarningsData {
  period: string;
  totalEarnings: number;
  tripCount: number;
  avgPerTrip: number;
  breakdown: {
    date: string;
    amount: number;
    trips: number;
  }[];
}

class DriverService {
  
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

    logger.info(`Driver created: ${data.name} (${data.phone}) for transporter ${transporterId}`);
    
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
    
    logger.info(`📡 Real-time update sent: driver_added for transporter ${transporterId}`);
    
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
        .filter(v => v.status === 'in_transit' && v.assignedDriverId)
        .map(v => v.assignedDriverId)
    );

    const activeDrivers = drivers.filter(d => d.isActive);
    const available = activeDrivers.filter(d => !driversOnTrip.has(d.id)).length;
    const onTrip = activeDrivers.filter(d => driversOnTrip.has(d.id)).length;

    return {
      drivers: activeDrivers,
      total: activeDrivers.length,
      available,
      onTrip
    };
  }

  // ==========================================================================
  // DRIVER DASHBOARD
  // ==========================================================================

  /**
   * Get driver dashboard data
   */
  async getDashboard(userId: string): Promise<DashboardData> {
    const bookings = await db.getBookingsByDriver(userId);
    
    const today = new Date().toISOString().split('T')[0];
    const completedBookings = bookings.filter((b: BookingRecord) => b.status === 'completed');
    const todayBookings = completedBookings.filter((b: BookingRecord) => 
      b.updatedAt?.startsWith(today)
    );
    
    const totalEarnings = completedBookings.reduce((sum: number, b: BookingRecord) => sum + (b.totalAmount || 0), 0);
    const todayEarnings = todayBookings.reduce((sum: number, b: BookingRecord) => sum + (b.totalAmount || 0), 0);
    
    return {
      stats: {
        totalTrips: completedBookings.length,
        completedToday: todayBookings.length,
        totalEarnings,
        todayEarnings,
        rating: 4.5, // Default rating
        acceptanceRate: 85 // TODO: Calculate from actual data
      },
      recentTrips: completedBookings.slice(0, 5).map((b: BookingRecord) => ({
        id: b.id,
        pickup: b.pickup?.address || 'Unknown',
        dropoff: b.drop?.address || 'Unknown',
        price: b.totalAmount,
        date: b.updatedAt,
        status: b.status
      })),
      availability: {
        isOnline: false,
        lastOnline: null
      }
    };
  }

  /**
   * Get driver availability status
   */
  async getAvailability(_userId: string): Promise<AvailabilityData> {
    return {
      isOnline: false,
      currentLocation: undefined,
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Update driver availability
   */
  async updateAvailability(
    _userId: string, 
    data: { isOnline?: boolean; currentLocation?: { latitude: number; longitude: number } }
  ): Promise<AvailabilityData> {
    // For now, just return the status - would need to extend UserRecord for full support
    return {
      isOnline: data.isOnline || false,
      currentLocation: data.currentLocation,
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Get driver earnings
   */
  async getEarnings(userId: string, period: string = 'week'): Promise<EarningsData> {
    const bookings = await db.getBookingsByDriver(userId);
    const completedBookings = bookings.filter((b: BookingRecord) => b.status === 'completed');
    
    const now = new Date();
    let startDate: Date;
    
    switch (period) {
      case 'today':
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'week':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      default:
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }
    
    const periodBookings = completedBookings.filter((b: BookingRecord) => 
      new Date(b.updatedAt || b.createdAt) >= startDate
    );
    
    const totalEarnings = periodBookings.reduce((sum: number, b: BookingRecord) => sum + (b.totalAmount || 0), 0);
    
    // Group by date for breakdown
    const byDate: { [key: string]: { amount: number; trips: number } } = {};
    periodBookings.forEach((b: BookingRecord) => {
      const date = (b.updatedAt || b.createdAt).split('T')[0];
      if (!byDate[date]) {
        byDate[date] = { amount: 0, trips: 0 };
      }
      byDate[date].amount += b.totalAmount || 0;
      byDate[date].trips += 1;
    });
    
    return {
      period,
      totalEarnings,
      tripCount: periodBookings.length,
      avgPerTrip: periodBookings.length > 0 ? totalEarnings / periodBookings.length : 0,
      breakdown: Object.entries(byDate).map(([date, data]) => ({
        date,
        amount: data.amount,
        trips: data.trips
      }))
    };
  }

  /**
   * Get driver trips
   */
  async getTrips(
    userId: string, 
    options: { status?: string; limit: number; offset: number }
  ) {
    let bookings = await db.getBookingsByDriver(userId);
    
    if (options.status) {
      bookings = bookings.filter((b: BookingRecord) => b.status === options.status);
    }
    
    const total = bookings.length;
    const trips = bookings
      .sort((a: BookingRecord, b: BookingRecord) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(options.offset, options.offset + options.limit)
      .map((b: BookingRecord) => ({
        id: b.id,
        pickup: b.pickup?.address || 'Unknown',
        dropoff: b.drop?.address || 'Unknown',
        price: b.totalAmount,
        status: b.status,
        date: b.createdAt,
        customer: b.customerName || 'Customer'
      }));
    
    return {
      trips,
      total,
      hasMore: options.offset + options.limit < total
    };
  }

  /**
   * Get active trip for driver
   */
  async getActiveTrip(userId: string) {
    const bookings = await db.getBookingsByDriver(userId);
    const activeStatuses = ['active', 'partially_filled', 'in_progress'];
    
    const activeTrip = bookings.find((b: BookingRecord) => activeStatuses.includes(b.status));
    
    if (!activeTrip) {
      return null;
    }
    
    return {
      id: activeTrip.id,
      status: activeTrip.status,
      pickup: {
        address: activeTrip.pickup?.address,
        location: { lat: activeTrip.pickup?.latitude, lng: activeTrip.pickup?.longitude }
      },
      dropoff: {
        address: activeTrip.drop?.address,
        location: { lat: activeTrip.drop?.latitude, lng: activeTrip.drop?.longitude }
      },
      price: activeTrip.totalAmount,
      customer: {
        name: activeTrip.customerName,
        phone: activeTrip.customerPhone
      },
      createdAt: activeTrip.createdAt
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
    } catch (error: any) {
      logger.error('[DRIVER SERVICE] Failed to complete profile', { 
        driverId, 
        error: error.message 
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
    } catch (error: any) {
      logger.error('[DRIVER SERVICE] Failed to get driver', { 
        driverId, 
        error: error.message 
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
    } catch (error: any) {
      logger.error('[DRIVER SERVICE] Failed to update profile photo', { 
        driverId, 
        error: error.message 
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
      const updateData: any = {};

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
    } catch (error: any) {
      logger.error('[DRIVER SERVICE] Failed to update license photos', { 
        driverId, 
        error: error.message 
      });
      throw error;
    }
  }
}

export const driverService = new DriverService();
