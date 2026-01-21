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
declare const router: import("express-serve-static-core").Router;
/**
 * @route   GET /api/v1/auth/debug-otp
 * @desc    Debug endpoint removed for security
 * @access  N/A
 *
 * NOTE: The debug-otp endpoint has been REMOVED for security reasons.
 * Plain OTPs are no longer stored - only hashed versions are kept.
 * In development mode, OTPs are shown in the server console when generated.
 */
export { router as authRouter };
//# sourceMappingURL=auth.routes.d.ts.map