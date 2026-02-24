/**
 * =============================================================================
 * DRIVER AUTH MODULE - CONTROLLER
 * =============================================================================
 *
 * Request handlers for driver authentication endpoints.
 * Mirrors main auth controller patterns: Zod validation + asyncHandler + successResponse.
 * =============================================================================
 */

import { Request, Response, NextFunction } from 'express';
import { driverAuthService } from './driver-auth.service';
import {
  SendDriverOtpInput,
  VerifyDriverOtpInput,
  sendDriverOtpSchema,
  verifyDriverOtpSchema,
} from './driver-auth.schema';
import { validateSchema } from '../../shared/utils/validation.utils';
import { asyncHandler } from '../../shared/middleware/error.middleware';
import { logger } from '../../shared/services/logger.service';
import { maskForLogging } from '../../shared/utils/crypto.utils';

class DriverAuthController {
  /**
   * Send OTP for driver login
   * OTP is sent to the transporter's phone, not the driver's
   *
   * @route POST /api/v1/driver-auth/send-otp
   */
  sendOtp = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const data = validateSchema(sendDriverOtpSchema, req.body) as SendDriverOtpInput;

    logger.info('[DRIVER AUTH] OTP request for driver', {
      driverPhone: maskForLogging(data.driverPhone, 2, 4)
    });

    const result = await driverAuthService.sendOtp(data.driverPhone);

    res.status(200).json({
      success: true,
      message: result.message,
      data: {
        transporterPhoneMasked: result.transporterPhoneMasked,
        driverId: result.driverId,
        driverName: result.driverName,
        expiresInMinutes: result.expiresInMinutes,
      },
    });
  });

  /**
   * Verify OTP and authenticate driver
   * Returns JWT tokens and driver profile
   *
   * @route POST /api/v1/driver-auth/verify-otp
   */
  verifyOtp = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const data = validateSchema(verifyDriverOtpSchema, req.body) as VerifyDriverOtpInput;

    logger.info('[DRIVER AUTH] OTP verification for driver', {
      driverPhone: maskForLogging(data.driverPhone, 2, 4)
    });

    const result = await driverAuthService.verifyOtp(data.driverPhone, data.otp);

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
  });
}

// Export singleton instance
export const driverAuthController = new DriverAuthController();
