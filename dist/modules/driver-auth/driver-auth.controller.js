"use strict";
/**
 * =============================================================================
 * DRIVER AUTH MODULE - CONTROLLER
 * =============================================================================
 *
 * Request handlers for driver authentication endpoints.
 * Follows same pattern as main auth controller for consistency.
 *
 * ENDPOINTS:
 * POST /driver-auth/send-otp   - Send OTP to transporter for driver login
 * POST /driver-auth/verify-otp - Verify OTP and get driver tokens
 * GET  /driver-auth/debug-otp  - Get pending OTP (development only)
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.driverAuthController = void 0;
const driver_auth_service_1 = require("./driver-auth.service");
const logger_service_1 = require("../../shared/services/logger.service");
class DriverAuthController {
    /**
     * Send OTP for driver login
     * OTP is sent to the transporter's phone, not the driver's
     *
     * @route POST /api/v1/driver-auth/send-otp
     */
    async sendOtp(req, res, next) {
        try {
            const { driverPhone } = req.body;
            logger_service_1.logger.info(`[DRIVER AUTH] OTP request for driver: ${driverPhone}`);
            const result = await driver_auth_service_1.driverAuthService.sendOtp(driverPhone);
            res.status(200).json({
                success: true,
                message: result.message,
                data: {
                    transporterPhoneMasked: result.transporterPhoneMasked,
                    driverId: result.driverId,
                    driverName: result.driverName,
                    expiresInMinutes: 5,
                },
            });
        }
        catch (error) {
            next(error);
        }
    }
    /**
     * Verify OTP and authenticate driver
     * Returns JWT tokens and driver profile
     *
     * @route POST /api/v1/driver-auth/verify-otp
     */
    async verifyOtp(req, res, next) {
        try {
            const { driverPhone, otp } = req.body;
            logger_service_1.logger.info(`[DRIVER AUTH] OTP verification for driver: ${driverPhone}`);
            const result = await driver_auth_service_1.driverAuthService.verifyOtp(driverPhone, otp);
            res.status(200).json({
                success: true,
                message: 'Driver authenticated successfully',
                data: {
                    accessToken: result.accessToken,
                    refreshToken: result.refreshToken,
                    driver: result.driver,
                    role: 'DRIVER',
                },
            });
        }
        catch (error) {
            next(error);
        }
    }
}
// Export singleton instance
exports.driverAuthController = new DriverAuthController();
//# sourceMappingURL=driver-auth.controller.js.map