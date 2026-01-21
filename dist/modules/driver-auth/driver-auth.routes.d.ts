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
declare const router: import("express-serve-static-core").Router;
/**
 * @route   GET /api/v1/driver-auth/debug-otp
 * @desc    Debug endpoint removed for security
 * @access  N/A
 *
 * NOTE: The debug-otp endpoint has been REMOVED for security reasons.
 * Plain OTPs are no longer stored - only hashed versions are kept.
 * In development mode, OTPs are shown in the server console when generated.
 */
export { router as driverAuthRouter };
//# sourceMappingURL=driver-auth.routes.d.ts.map