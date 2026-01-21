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

import { Router } from 'express';
import { driverAuthController } from './driver-auth.controller';
import { otpRateLimiter, authRateLimiter } from '../../shared/middleware/rate-limiter.middleware';
// Note: config import removed - debug endpoint was removed for security

const router = Router();

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
router.post(
  '/send-otp',
  otpRateLimiter,
  driverAuthController.sendOtp.bind(driverAuthController)
);

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
router.post(
  '/verify-otp',
  authRateLimiter,
  driverAuthController.verifyOtp.bind(driverAuthController)
);

/**
 * @route   GET /api/v1/driver-auth/debug-otp
 * @desc    Debug endpoint removed for security
 * @access  N/A
 * 
 * NOTE: The debug-otp endpoint has been REMOVED for security reasons.
 * Plain OTPs are no longer stored - only hashed versions are kept.
 * In development mode, OTPs are shown in the server console when generated.
 */
// Debug OTP endpoint removed - check server console for OTPs in development mode

export { router as driverAuthRouter };
