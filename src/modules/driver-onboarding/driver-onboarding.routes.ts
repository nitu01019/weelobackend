/**
 * =============================================================================
 * DRIVER ONBOARDING MODULE - ROUTES
 * =============================================================================
 * 
 * API routes for driver onboarding with OTP verification.
 * 
 * ENDPOINTS:
 * POST /api/v1/driver-onboarding/initiate    - Start onboarding, send OTP to driver
 * POST /api/v1/driver-onboarding/verify      - Verify OTP and add driver
 * POST /api/v1/driver-onboarding/resend      - Resend OTP
 * POST /api/v1/driver-onboarding/cancel      - Cancel pending onboarding
 * 
 * ALL ENDPOINTS REQUIRE:
 * - Authentication (JWT token)
 * - Transporter role
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { validateSchema } from '../../shared/utils/validation.utils';
import { driverOnboardingService } from './driver-onboarding.service';
import { logger } from '../../shared/services/logger.service';
import { onDriverChange } from '../../shared/services/fleet-cache.service';

const router = Router();

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const initiateSchema = z.object({
  phone: z.string()
    .min(10, 'Phone number must be 10 digits')
    .max(10, 'Phone number must be 10 digits')
    .regex(/^\d{10}$/, 'Invalid phone number format'),
  name: z.string()
    .min(2, 'Name must be at least 2 characters')
    .max(100, 'Name too long'),
  licenseNumber: z.string()
    .min(5, 'Invalid license number')
    .max(20, 'License number too long'),
  email: z.string().email('Invalid email').optional()
});

const verifySchema = z.object({
  phone: z.string()
    .min(10, 'Phone number must be 10 digits')
    .max(10, 'Phone number must be 10 digits'),
  otp: z.string()
    .min(4, 'OTP must be at least 4 digits')
    .max(6, 'OTP must be at most 6 digits')
});

const resendSchema = z.object({
  phone: z.string()
    .min(10, 'Phone number must be 10 digits')
    .max(10, 'Phone number must be 10 digits')
});

// =============================================================================
// ROUTES
// =============================================================================

/**
 * POST /api/v1/driver-onboarding/initiate
 * 
 * Start driver onboarding process.
 * Sends OTP to DRIVER's phone for verification.
 * 
 * Body: { phone, name, licenseNumber, email? }
 * Response: { success, data: { message, driverPhoneMasked, expiresInMinutes } }
 */
router.post(
  '/initiate',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      
      // Log incoming request body for debugging
      logger.info('[DRIVER ONBOARD] Request body received', {
        body: JSON.stringify(req.body),
        hasPhone: !!req.body?.phone,
        hasName: !!req.body?.name,
        hasLicense: !!req.body?.licenseNumber
      });
      
      // Validate with better error handling
      let data;
      try {
        data = validateSchema(initiateSchema, req.body);
      } catch (validationError: any) {
        logger.error('[DRIVER ONBOARD] Validation failed', { 
          error: validationError.message,
          body: req.body 
        });
        return res.status(400).json({
          success: false,
          error: { 
            code: 'VALIDATION_ERROR', 
            message: validationError.message || 'Invalid request data'
          }
        });
      }
      
      logger.info('[DRIVER ONBOARD] Initiating onboarding', {
        transporterId: transporterId.substring(0, 8),
        driverPhone: data.phone.substring(0, 2) + '****'
      });
      
      const result = await driverOnboardingService.initiateOnboarding(transporterId, {
        phone: data.phone,
        name: data.name,
        licenseNumber: data.licenseNumber,
        email: data.email
      });
      
      res.json({
        success: true,
        data: result,
        message: result.message
      });
    } catch (error: any) {
      logger.error('[DRIVER ONBOARD] Initiate failed', { 
        error: error.message,
        code: error.code,
        stack: error.stack?.substring(0, 200)
      });
      
      if (error.code) {
        return res.status(error.statusCode || 400).json({
          success: false,
          error: { code: error.code, message: error.message }
        });
      }
      next(error);
    }
  }
);

/**
 * POST /api/v1/driver-onboarding/verify
 * 
 * Verify OTP and add driver to transporter's fleet.
 * 
 * Body: { phone, otp }
 * Response: { success, data: { driver, message } }
 */
router.post(
  '/verify',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const data = validateSchema(verifySchema, req.body);
      
      logger.info('[DRIVER ONBOARD] Verifying OTP', {
        transporterId: transporterId.substring(0, 8),
        driverPhone: data.phone.substring(0, 2) + '****'
      });
      
      const result = await driverOnboardingService.verifyAndAddDriver(
        transporterId,
        data.phone,
        data.otp
      );
      
      // Invalidate cache
      await onDriverChange(transporterId, result.driver.id);
      
      res.status(201).json({
        success: true,
        data: {
          driver: {
            id: result.driver.id,
            name: result.driver.name,
            phone: result.driver.phone,
            licenseNumber: result.driver.licenseNumber,
            isVerified: result.driver.isVerified
          }
        },
        message: result.message
      });
    } catch (error: any) {
      logger.error('[DRIVER ONBOARD] Verify failed', { error: error.message });
      
      if (error.code) {
        return res.status(error.statusCode || 400).json({
          success: false,
          error: { code: error.code, message: error.message }
        });
      }
      next(error);
    }
  }
);

/**
 * POST /api/v1/driver-onboarding/resend
 * 
 * Resend OTP to driver's phone.
 * 
 * Body: { phone }
 * Response: { success, data: { message, expiresInMinutes } }
 */
router.post(
  '/resend',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const data = validateSchema(resendSchema, req.body);
      
      const result = await driverOnboardingService.resendOtp(transporterId, data.phone);
      
      res.json({
        success: true,
        data: result,
        message: result.message
      });
    } catch (error: any) {
      if (error.code) {
        return res.status(error.statusCode || 400).json({
          success: false,
          error: { code: error.code, message: error.message }
        });
      }
      next(error);
    }
  }
);

/**
 * POST /api/v1/driver-onboarding/cancel
 * 
 * Cancel pending onboarding request.
 * 
 * Body: { phone }
 * Response: { success, message }
 */
router.post(
  '/cancel',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const data = validateSchema(resendSchema, req.body);
      
      await driverOnboardingService.cancelOnboarding(transporterId, data.phone);
      
      res.json({
        success: true,
        message: 'Onboarding cancelled'
      });
    } catch (error: any) {
      if (error.code) {
        return res.status(error.statusCode || 400).json({
          success: false,
          error: { code: error.code, message: error.message }
        });
      }
      next(error);
    }
  }
);

export default router;
