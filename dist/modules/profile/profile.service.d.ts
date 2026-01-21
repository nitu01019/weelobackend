/**
 * =============================================================================
 * PROFILE MODULE - SERVICE
 * =============================================================================
 *
 * Business logic for user profile management.
 * Handles Customer, Transporter, and Driver profiles.
 * =============================================================================
 */
import { UserRecord } from '../../shared/database/db';
import { CustomerProfileInput, TransporterProfileInput, DriverProfileInput, AddDriverInput } from './profile.schema';
declare class ProfileService {
    /**
     * Get user profile by ID
     */
    getProfile(userId: string): Promise<UserRecord>;
    /**
     * Get user profile by phone
     */
    getProfileByPhone(phone: string, role: string): Promise<UserRecord | null>;
    /**
     * Create or update customer profile
     */
    updateCustomerProfile(userId: string, phone: string, data: CustomerProfileInput): Promise<UserRecord>;
    /**
     * Create or update transporter profile
     */
    updateTransporterProfile(userId: string, phone: string, data: TransporterProfileInput): Promise<UserRecord>;
    /**
     * Get transporter's drivers
     */
    getTransporterDrivers(transporterId: string): Promise<UserRecord[]>;
    /**
     * Add driver to transporter's fleet
     */
    addDriver(transporterId: string, data: AddDriverInput): Promise<UserRecord>;
    /**
     * Remove driver from transporter's fleet
     */
    removeDriver(transporterId: string, driverId: string): Promise<void>;
    /**
     * Create or update driver profile (by driver themselves)
     */
    updateDriverProfile(userId: string, phone: string, data: DriverProfileInput): Promise<UserRecord>;
    /**
     * Get driver's transporter info
     */
    getDriverTransporter(driverId: string): Promise<UserRecord | null>;
}
export declare const profileService: ProfileService;
export {};
//# sourceMappingURL=profile.service.d.ts.map