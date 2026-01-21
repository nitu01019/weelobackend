"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRouter = void 0;
const express_1 = require("express");
const auth_controller_1 = require("./auth.controller");
const rate_limiter_middleware_1 = require("../../shared/middleware/rate-limiter.middleware");
const auth_middleware_1 = require("../../shared/middleware/auth.middleware");
// Note: authService and config imports removed - debug endpoint was removed for security
const router = (0, express_1.Router)();
exports.authRouter = router;
/**
 * @route   POST /api/v1/auth/send-otp
 * @desc    Send OTP to phone number
 * @access  Public (rate limited)
 */
router.post('/send-otp', rate_limiter_middleware_1.otpRateLimiter, auth_controller_1.authController.sendOtp);
/**
 * @route   POST /api/v1/auth/verify-otp
 * @desc    Verify OTP and return tokens
 * @access  Public (rate limited)
 */
router.post('/verify-otp', rate_limiter_middleware_1.authRateLimiter, auth_controller_1.authController.verifyOtp);
/**
 * @route   POST /api/v1/auth/refresh
 * @desc    Refresh access token using refresh token
 * @access  Public
 */
router.post('/refresh', auth_controller_1.authController.refreshToken);
/**
 * @route   POST /api/v1/auth/logout
 * @desc    Logout and invalidate tokens
 * @access  Private
 */
router.post('/logout', auth_middleware_1.authenticate, auth_controller_1.authController.logout);
/**
 * @route   GET /api/v1/auth/me
 * @desc    Get current user info
 * @access  Private
 */
router.get('/me', auth_middleware_1.authenticate, auth_controller_1.authController.getCurrentUser);
//# sourceMappingURL=auth.routes.js.map