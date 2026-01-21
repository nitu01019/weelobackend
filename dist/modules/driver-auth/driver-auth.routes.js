"use strict";
/**
 * =============================================================================
 * DRIVER AUTH MODULE - ROUTES
 * =============================================================================
 *
 * Routes for driver authentication (separate from transporter auth).
 *
 * ENDPOINTS:
 * POST /api/v1/driver-auth/send-otp     - Send OTP to transporter for driver login
 * POST /api/v1/driver-auth/verify-otp   - Verify OTP and get driver tokens
 * GET  /api/v1/driver-auth/debug-otp    - Get pending OTP (development only)
 *
 * SECURITY:
 * - Rate limiting on OTP endpoints
 * - Input validation via Zod schemas
 * - OTPs expire after 5 minutes
 * - Max 3 OTP verification attempts
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.driverAuthRouter = void 0;
const express_1 = require("express");
const driver_auth_controller_1 = require("./driver-auth.controller");
const rate_limiter_middleware_1 = require("../../shared/middleware/rate-limiter.middleware");
// Note: config import removed - debug endpoint was removed for security
const router = (0, express_1.Router)();
exports.driverAuthRouter = router;
/**
 * @route   POST /api/v1/driver-auth/send-otp
 * @desc    Send OTP to transporter for driver login
 * @access  Public
 *
 * Request body:
 * {
 *   "driverPhone": "9876543210"
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "message": "OTP sent to your transporter. Please ask them for the code.",
 *   "data": {
 *     "transporterPhoneMasked": "78****631",
 *     "driverId": "driver-uuid",
 *     "driverName": "Ramesh Kumar",
 *     "expiresInMinutes": 5
 *   }
 * }
 */
router.post('/send-otp', rate_limiter_middleware_1.otpRateLimiter, driver_auth_controller_1.driverAuthController.sendOtp.bind(driver_auth_controller_1.driverAuthController));
/**
 * @route   POST /api/v1/driver-auth/verify-otp
 * @desc    Verify OTP and authenticate driver
 * @access  Public
 *
 * Request body:
 * {
 *   "driverPhone": "9876543210",
 *   "otp": "123456"
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "message": "Driver authenticated successfully",
 *   "data": {
 *     "accessToken": "jwt...",
 *     "refreshToken": "jwt...",
 *     "driver": {
 *       "id": "driver-uuid",
 *       "name": "Ramesh Kumar",
 *       "phone": "9876543210",
 *       "transporterId": "transporter-uuid",
 *       "transporterName": "ABC Logistics",
 *       "licenseNumber": "DL1234567890",
 *       "profilePhoto": "https://..."
 *     },
 *     "role": "DRIVER"
 *   }
 * }
 */
router.post('/verify-otp', rate_limiter_middleware_1.authRateLimiter, driver_auth_controller_1.driverAuthController.verifyOtp.bind(driver_auth_controller_1.driverAuthController));
//# sourceMappingURL=driver-auth.routes.js.map