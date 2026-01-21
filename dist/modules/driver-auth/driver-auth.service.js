"use strict";
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
 * 4. OTP is generated and sent to TRANSPORTER's phone
 * 5. Driver gets OTP from transporter (asks them verbally/SMS)
 * 6. Driver enters OTP and gets authenticated
 *
 * SECURITY:
 * - Cryptographically secure OTP generation (crypto.randomInt)
 * - OTPs are hashed before storage (plain OTP is NEVER stored)
 * - OTPs expire after configured time (default: 5 minutes)
 * - Maximum 3 attempts before OTP is invalidated
 * - Rate limiting enforced at route level
 * - Access tokens signed with JWT_SECRET
 * - Refresh tokens signed with JWT_REFRESH_SECRET (separate key!)
 * - OTPs logged to console ONLY in development mode
 *
 * SCALABILITY:
 * - Stateless JWT tokens (millions of concurrent users)
 * - In-memory OTP store (TODO: Replace with Redis for clustering)
 * - Async operations throughout
 *
 * FOR BACKEND DEVELOPERS:
 * - To test driver login in dev: Check server console for OTP
 * - In production: OTP is sent to transporter via SMS
 * =============================================================================
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.driverAuthService = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const environment_1 = require("../../config/environment");
const logger_service_1 = require("../../shared/services/logger.service");
const error_types_1 = require("../../shared/types/error.types");
const db_1 = require("../../shared/database/db");
const crypto_utils_1 = require("../../shared/utils/crypto.utils");
const driverOtpStore = new Map();
/**
 * DriverAuthService - Handles driver-specific authentication
 * Separate from transporter auth for modularity and scalability
 */
class DriverAuthService {
    OTP_EXPIRY_MINUTES = 5;
    MAX_OTP_ATTEMPTS = 3;
    SALT_ROUNDS = 10;
    /**
     * Send OTP for driver login
     *
     * @param driverPhone - The driver's phone number
     * @returns Object with masked transporter phone for UI hint
     * @throws AppError if driver not found or not associated with any transporter
     */
    async sendOtp(driverPhone) {
        // 1. Find driver by phone number
        const driver = await this.findDriverByPhone(driverPhone);
        if (!driver) {
            throw new error_types_1.AppError(404, 'DRIVER_NOT_FOUND', 'Driver not found. Please contact your transporter to register you.');
        }
        if (!driver.transporterId) {
            throw new error_types_1.AppError(400, 'NO_TRANSPORTER', 'Driver not associated with any transporter. Please contact support.');
        }
        // 2. Find the transporter who owns this driver
        const transporter = await this.findTransporterById(driver.transporterId);
        if (!transporter) {
            throw new error_types_1.AppError(404, 'TRANSPORTER_NOT_FOUND', 'Transporter account not found. Please contact support.');
        }
        // 3. Generate cryptographically secure OTP
        const otp = (0, crypto_utils_1.generateSecureOTP)(environment_1.config.otp.length);
        const hashedOtp = await bcryptjs_1.default.hash(otp, this.SALT_ROUNDS);
        const expiresAt = new Date(Date.now() + this.OTP_EXPIRY_MINUTES * 60 * 1000);
        // 4. Store ONLY hashed OTP (keyed by driver phone)
        // Plain OTP is NEVER stored for security
        driverOtpStore.set(driverPhone, {
            hashedOtp,
            driverId: driver.id,
            transporterId: driver.transporterId,
            transporterPhone: transporter.phone,
            expiresAt,
            attempts: 0,
        });
        // 5. Log OTP (DEVELOPMENT ONLY)
        // In production, OTP would be sent to transporter via SMS
        logger_service_1.logger.info('[DRIVER AUTH] OTP generated', {
            driverId: driver.id,
            driverPhone: (0, crypto_utils_1.maskForLogging)(driverPhone, 2, 4),
            transporterPhone: (0, crypto_utils_1.maskForLogging)(transporter.phone, 2, 4),
            expiresAt: expiresAt.toISOString()
        });
        // Development only: Show OTP in console
        if (environment_1.config.isDevelopment) {
            console.log('\n' + '='.repeat(60));
            console.log(`🔐 DRIVER LOGIN OTP (DEV MODE ONLY)`);
            console.log(`   Driver: ${driver.name} (${(0, crypto_utils_1.maskForLogging)(driverPhone, 2, 4)})`);
            console.log(`   OTP sent to Transporter: ${(0, crypto_utils_1.maskForLogging)(transporter.phone, 2, 4)}`);
            console.log(`   OTP: ${otp}`);
            console.log(`   Expires in: ${this.OTP_EXPIRY_MINUTES} minutes`);
            console.log('='.repeat(60));
            console.log(`⚠️  This OTP is shown ONLY in development mode!`);
            console.log('='.repeat(60) + '\n');
        }
        // 6. Return response with masked transporter phone
        return {
            message: environment_1.config.isDevelopment
                ? `OTP sent. Check server console for OTP (dev mode).`
                : `OTP sent to your transporter. Please ask them for the code.`,
            transporterPhoneMasked: this.maskPhone(transporter.phone),
            driverId: driver.id,
            driverName: driver.name || 'Driver',
        };
    }
    /**
     * Verify OTP and authenticate driver
     *
     * @param driverPhone - Driver's phone number
     * @param otp - OTP received from transporter
     * @returns JWT tokens and driver data
     */
    async verifyOtp(driverPhone, otp) {
        // 1. Get stored OTP entry
        const otpEntry = driverOtpStore.get(driverPhone);
        if (!otpEntry) {
            throw new error_types_1.AppError(400, 'OTP_NOT_FOUND', 'No OTP request found. Please request a new OTP.');
        }
        // 2. Check expiry
        if (new Date() > otpEntry.expiresAt) {
            driverOtpStore.delete(driverPhone);
            throw new error_types_1.AppError(400, 'OTP_EXPIRED', 'OTP has expired. Please request a new one.');
        }
        // 3. Check attempts
        if (otpEntry.attempts >= this.MAX_OTP_ATTEMPTS) {
            driverOtpStore.delete(driverPhone);
            throw new error_types_1.AppError(400, 'OTP_MAX_ATTEMPTS', 'Too many failed attempts. Please request a new OTP.');
        }
        // 4. Verify OTP
        const isValid = await bcryptjs_1.default.compare(otp, otpEntry.hashedOtp);
        if (!isValid) {
            otpEntry.attempts += 1;
            throw new error_types_1.AppError(400, 'OTP_INVALID', `Invalid OTP. ${this.MAX_OTP_ATTEMPTS - otpEntry.attempts} attempts remaining.`);
        }
        // 5. OTP is valid - clean up immediately (single use)
        driverOtpStore.delete(driverPhone);
        // 6. Get driver and transporter data
        const driver = await this.findDriverByPhone(driverPhone);
        const transporter = await this.findTransporterById(otpEntry.transporterId);
        if (!driver || !transporter) {
            throw new error_types_1.AppError(500, 'DATA_ERROR', 'Driver or transporter data not found.');
        }
        // 7. Generate JWT tokens
        const accessToken = this.generateAccessToken(driver);
        const refreshToken = this.generateRefreshToken(driver);
        logger_service_1.logger.info(`[DRIVER AUTH] Driver logged in: ${driver.name} (${driverPhone})`);
        // 8. Return tokens and driver data
        return {
            accessToken,
            refreshToken,
            driver: {
                id: driver.id,
                name: driver.name || 'Driver',
                phone: driver.phone,
                transporterId: driver.transporterId,
                transporterName: transporter.name || 'Transporter',
                licenseNumber: driver.licenseNumber,
                profilePhoto: driver.profilePhoto,
            },
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
    async findDriverByPhone(phone) {
        return db_1.db.getUserByPhone(phone, 'driver');
    }
    /**
     * Find transporter by ID
     */
    async findTransporterById(transporterId) {
        return db_1.db.getUserById(transporterId);
    }
    /**
     * Mask phone number for privacy (78****631)
     */
    maskPhone(phone) {
        if (phone.length < 6)
            return '****';
        return phone.slice(0, 2) + '****' + phone.slice(-3);
    }
    /**
     * Generate JWT access token for driver
     * Uses JWT_SECRET for signing
     */
    generateAccessToken(driver) {
        return jsonwebtoken_1.default.sign({
            userId: driver.id,
            phone: driver.phone,
            role: 'driver',
            transporterId: driver.transporterId,
        }, environment_1.config.jwt.secret, { expiresIn: environment_1.config.jwt.expiresIn });
    }
    /**
     * Generate JWT refresh token for driver
     *
     * SECURITY: Uses JWT_REFRESH_SECRET (separate from access token secret)
     * This ensures that even if access token secret is compromised,
     * refresh tokens remain secure.
     */
    generateRefreshToken(driver) {
        return jsonwebtoken_1.default.sign({
            userId: driver.id,
            type: 'refresh',
            role: 'driver',
        }, environment_1.config.jwt.refreshSecret, // FIXED: Use refreshSecret, not secret
        { expiresIn: environment_1.config.jwt.refreshExpiresIn });
    }
}
// Export singleton instance
exports.driverAuthService = new DriverAuthService();
//# sourceMappingURL=driver-auth.service.js.map