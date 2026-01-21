/**
 * =============================================================================
 * PROFILE MODULE - SERVICE
 * =============================================================================
 * 
 * Business logic for user profile management.
 * Handles Customer, Transporter, and Driver profiles.
 * =============================================================================
 */

import { v4 as uuid } from 'uuid';
import { db, UserRecord } from '../../shared/database/db';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import {
  CustomerProfileInput,
  TransporterProfileInput,
  DriverProfileInput,
  AddDriverInput
} from './profile.schema';

class ProfileService {
  
  // ==========================================================================
  // GET PROFILE
  // ==========================================================================

  /**
   * Get user profile by ID
   */
  async getProfile(userId: string): Promise<UserRecord> {
    const user = db.getUserById(userId);
    
    if (!user) {
      throw new AppError(404, 'USER_NOT_FOUND', 'Profile not found');
    }
    
    return user;
  }

  /**
   * Get user profile by phone
   */
  async getProfileByPhone(phone: string, role: string): Promise<UserRecord | null> {
    const user = db.getUserByPhone(phone, role);
    return user || null;
  }

  // ==========================================================================
  // CUSTOMER PROFILE
  // ==========================================================================

  /**
   * Create or update customer profile
   */
  async updateCustomerProfile(
    userId: string,
    phone: string,
    data: CustomerProfileInput
  ): Promise<UserRecord> {
    const user = db.createUser({
      id: userId,
      phone,
      role: 'customer',
      name: data.name,
      email: data.email,
      profilePhoto: data.profilePhoto,
      company: data.company,
      gstNumber: data.gstNumber,
      isVerified: true,
      isActive: true
    });

    logger.info(`Customer profile updated: ${userId}`);
    return user;
  }

  // ==========================================================================
  // TRANSPORTER PROFILE
  // ==========================================================================

  /**
   * Create or update transporter profile
   */
  async updateTransporterProfile(
    userId: string,
    phone: string,
    data: TransporterProfileInput
  ): Promise<UserRecord> {
    // Handle both 'company' and 'businessName' for flexibility
    const businessName = data.company || data.businessName;
    const businessAddress = data.address || data.businessAddress;
    
    const user = db.createUser({
      id: userId,
      phone,
      role: 'transporter',
      name: data.name,
      email: data.email,
      profilePhoto: data.profilePhoto,
      businessName: businessName,
      businessAddress: businessAddress,
      panNumber: data.panNumber,
      gstNumber: data.gstNumber,
      isVerified: true,
      isActive: true
    });

    logger.info(`Transporter profile updated: ${userId}`);
    return user;
  }

  /**
   * Get transporter's drivers
   */
  async getTransporterDrivers(transporterId: string): Promise<UserRecord[]> {
    return db.getDriversByTransporter(transporterId);
  }

  /**
   * Add driver to transporter's fleet
   */
  async addDriver(
    transporterId: string,
    data: AddDriverInput
  ): Promise<UserRecord> {
    // Check if driver already exists with this phone
    const existing = db.getUserByPhone(data.phone, 'driver');
    if (existing) {
      throw new AppError(400, 'DRIVER_EXISTS', 'Driver with this phone already exists');
    }

    const driver = db.createUser({
      id: uuid(),
      phone: data.phone,
      role: 'driver',
      name: data.name,
      transporterId: transporterId,
      licenseNumber: data.licenseNumber,
      licenseExpiry: data.licenseExpiry,
      aadharNumber: data.aadharNumber,
      isVerified: false,
      isActive: true
    });

    logger.info(`Driver added: ${driver.id} for transporter ${transporterId}`);
    return driver;
  }

  /**
   * Remove driver from transporter's fleet
   */
  async removeDriver(transporterId: string, driverId: string): Promise<void> {
    const driver = db.getUserById(driverId);
    
    if (!driver) {
      throw new AppError(404, 'DRIVER_NOT_FOUND', 'Driver not found');
    }
    
    if (driver.transporterId !== transporterId) {
      throw new AppError(403, 'FORBIDDEN', 'This driver does not belong to you');
    }

    db.updateUser(driverId, { isActive: false });
    logger.info(`Driver removed: ${driverId} from transporter ${transporterId}`);
  }

  // ==========================================================================
  // DRIVER PROFILE
  // ==========================================================================

  /**
   * Create or update driver profile (by driver themselves)
   */
  async updateDriverProfile(
    userId: string,
    phone: string,
    data: DriverProfileInput
  ): Promise<UserRecord> {
    // Get existing to preserve transporterId
    const existing = db.getUserById(userId);
    
    const user = db.createUser({
      id: userId,
      phone,
      role: 'driver',
      name: data.name,
      email: data.email,
      profilePhoto: data.profilePhoto,
      licenseNumber: data.licenseNumber,
      licenseExpiry: data.licenseExpiry,
      aadharNumber: data.aadharNumber,
      transporterId: existing?.transporterId,
      isVerified: true,
      isActive: true
    });

    logger.info(`Driver profile updated: ${userId}`);
    return user;
  }

  /**
   * Get driver's transporter info
   */
  async getDriverTransporter(driverId: string): Promise<UserRecord | null> {
    const driver = db.getUserById(driverId);
    if (!driver?.transporterId) return null;
    
    return db.getUserById(driver.transporterId) || null;
  }
}

export const profileService = new ProfileService();
