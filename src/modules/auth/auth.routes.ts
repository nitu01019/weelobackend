/**
 * =============================================================================
 * AUTH MODULE - ROUTES
 * =============================================================================
 * 
 * Authentication routes for OTP-based login.
 * 
 * Endpoints:
 * POST /auth/send-otp     - Send OTP to phone number
 * POST /auth/verify-otp   - Verify OTP and get tokens
 * POST /auth/refresh      - Refresh access token
 * POST /auth/logout       - Invalidate tokens
 * =============================================================================
 */

import { Router } from 'express';
import { authController } from './auth.controller';
import { otpRateLimiter, authRateLimiter } from '../../shared/middleware/rate-limiter.middleware';
import { authenticate } from '../../shared/middleware/auth.middleware';
// Note: authService and config imports removed - debug endpoint was removed for security

const router = Router();

/**
 * @route   POST /api/v1/auth/send-otp
 * @desc    Send OTP to phone number
 * @access  Public (rate limited)
 */
router.post('/send-otp', otpRateLimiter, authController.sendOtp);

/**
 * @route   POST /api/v1/auth/verify-otp
 * @desc    Verify OTP and return tokens
 * @access  Public (rate limited)
 */
router.post('/verify-otp', authRateLimiter, authController.verifyOtp);

/**
 * @route   POST /api/v1/auth/refresh
 * @desc    Refresh access token using refresh token
 * @access  Public
 */
router.post('/refresh', authController.refreshToken);

/**
 * @route   POST /api/v1/auth/logout
 * @desc    Logout and invalidate tokens
 * @access  Private
 */
router.post('/logout', authenticate, authController.logout);

/**
 * @route   GET /api/v1/auth/me
 * @desc    Get current user info
 * @access  Private
 */
router.get('/me', authenticate, authController.getCurrentUser);

/**
 * @route   GET /api/v1/auth/debug-otp
 * @desc    Debug endpoint removed for security
 * @access  N/A
 * 
 * NOTE: The debug-otp endpoint has been REMOVED for security reasons.
 * Plain OTPs are no longer stored - only hashed versions are kept.
 * In development mode, OTPs are shown in the server console when generated.
 */
// Debug OTP endpoint removed - check server console for OTPs in development mode

export { router as authRouter };
