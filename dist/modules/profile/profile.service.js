"use strict";
/**
 * =============================================================================
 * PROFILE MODULE - SERVICE
 * =============================================================================
 *
 * Business logic for user profile management.
 * Handles Customer, Transporter, and Driver profiles.
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.profileService = void 0;
const uuid_1 = require("uuid");
const db_1 = require("../../shared/database/db");
const error_types_1 = require("../../shared/types/error.types");
const logger_service_1 = require("../../shared/services/logger.service");
class ProfileService {
    // ==========================================================================
    // GET PROFILE
    // ==========================================================================
    /**
     * Get user profile by ID
     */
    async getProfile(userId) {
        const user = db_1.db.getUserById(userId);
        if (!user) {
            throw new error_types_1.AppError(404, 'USER_NOT_FOUND', 'Profile not found');
        }
        return user;
    }
    /**
     * Get user profile by phone
     */
    async getProfileByPhone(phone, role) {
        const user = db_1.db.getUserByPhone(phone, role);
        return user || null;
    }
    // ==========================================================================
    // CUSTOMER PROFILE
    // ==========================================================================
    /**
     * Create or update customer profile
     */
    async updateCustomerProfile(userId, phone, data) {
        const user = db_1.db.createUser({
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
        logger_service_1.logger.info(`Customer profile updated: ${userId}`);
        return user;
    }
    // ==========================================================================
    // TRANSPORTER PROFILE
    // ==========================================================================
    /**
     * Create or update transporter profile
     */
    async updateTransporterProfile(userId, phone, data) {
        // Handle both 'company' and 'businessName' for flexibility
        const businessName = data.company || data.businessName;
        const businessAddress = data.address || data.businessAddress;
        const user = db_1.db.createUser({
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
        logger_service_1.logger.info(`Transporter profile updated: ${userId}`);
        return user;
    }
    /**
     * Get transporter's drivers
     */
    async getTransporterDrivers(transporterId) {
        return db_1.db.getDriversByTransporter(transporterId);
    }
    /**
     * Add driver to transporter's fleet
     */
    async addDriver(transporterId, data) {
        // Check if driver already exists with this phone
        const existing = db_1.db.getUserByPhone(data.phone, 'driver');
        if (existing) {
            throw new error_types_1.AppError(400, 'DRIVER_EXISTS', 'Driver with this phone already exists');
        }
        const driver = db_1.db.createUser({
            id: (0, uuid_1.v4)(),
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
        logger_service_1.logger.info(`Driver added: ${driver.id} for transporter ${transporterId}`);
        return driver;
    }
    /**
     * Remove driver from transporter's fleet
     */
    async removeDriver(transporterId, driverId) {
        const driver = db_1.db.getUserById(driverId);
        if (!driver) {
            throw new error_types_1.AppError(404, 'DRIVER_NOT_FOUND', 'Driver not found');
        }
        if (driver.transporterId !== transporterId) {
            throw new error_types_1.AppError(403, 'FORBIDDEN', 'This driver does not belong to you');
        }
        db_1.db.updateUser(driverId, { isActive: false });
        logger_service_1.logger.info(`Driver removed: ${driverId} from transporter ${transporterId}`);
    }
    // ==========================================================================
    // DRIVER PROFILE
    // ==========================================================================
    /**
     * Create or update driver profile (by driver themselves)
     */
    async updateDriverProfile(userId, phone, data) {
        // Get existing to preserve transporterId
        const existing = db_1.db.getUserById(userId);
        const user = db_1.db.createUser({
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
        logger_service_1.logger.info(`Driver profile updated: ${userId}`);
        return user;
    }
    /**
     * Get driver's transporter info
     */
    async getDriverTransporter(driverId) {
        const driver = db_1.db.getUserById(driverId);
        if (!driver?.transporterId)
            return null;
        return db_1.db.getUserById(driver.transporterId) || null;
    }
}
exports.profileService = new ProfileService();
//# sourceMappingURL=profile.service.js.map