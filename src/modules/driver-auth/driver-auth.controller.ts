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
import { driverAuthService } from './driver-auth.service';
import { SendDriverOtpInput, VerifyDriverOtpInput } from './driver-auth.schema';
import { logger } from '../../shared/services/logger.service';

class DriverAuthController {
  
  /**
   * Send OTP for driver login
   * OTP is sent to the transporter's phone, not the driver's
   * 
   * @route POST /api/v1/driver-auth/send-otp
   */
  async sendOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { driverPhone } = req.body as SendDriverOtpInput;
      
      logger.info(`[DRIVER AUTH] OTP request for driver: ${driverPhone}`);
      
      const result = await driverAuthService.sendOtp(driverPhone);
      
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
    } catch (error) {
      next(error);
    }
  }

  /**
   * Verify OTP and authenticate driver
   * Returns JWT tokens and driver profile
   * 
   * @route POST /api/v1/driver-auth/verify-otp
   */
  async verifyOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { driverPhone, otp } = req.body as VerifyDriverOtpInput;
      
      logger.info(`[DRIVER AUTH] OTP verification for driver: ${driverPhone}`);
      
      const result = await driverAuthService.verifyOtp(driverPhone, otp);
      
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
    } catch (error) {
      next(error);
    }
  }

  /**
   * Debug OTP endpoint removed for security
   * 
   * NOTE: The getDebugOtp method has been REMOVED for security reasons.
   * Plain OTPs are no longer stored - only hashed versions are kept.
   * In development mode, OTPs are shown in the server console when generated.
   */
}

// Export singleton instance
export const driverAuthController = new DriverAuthController();
