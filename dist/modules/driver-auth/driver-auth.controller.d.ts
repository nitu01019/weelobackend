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
import { Request, Response, NextFunction } from 'express';
declare class DriverAuthController {
    /**
     * Send OTP for driver login
     * OTP is sent to the transporter's phone, not the driver's
     *
     * @route POST /api/v1/driver-auth/send-otp
     */
    sendOtp(req: Request, res: Response, next: NextFunction): Promise<void>;
    /**
     * Verify OTP and authenticate driver
     * Returns JWT tokens and driver profile
     *
     * @route POST /api/v1/driver-auth/verify-otp
     */
    verifyOtp(req: Request, res: Response, next: NextFunction): Promise<void>;
}
export declare const driverAuthController: DriverAuthController;
export {};
//# sourceMappingURL=driver-auth.controller.d.ts.map