/**
 * =============================================================================
 * AUTH MODULE - CONTROLLER
 * =============================================================================
 * 
 * Handles HTTP requests for authentication.
 * Controller only handles request/response - business logic is in service.
 * =============================================================================
 */

import { Request, Response, NextFunction } from 'express';
import { authService } from './auth.service';
import { sendOtpSchema, verifyOtpSchema, refreshTokenSchema } from './auth.schema';
import { validateSchema } from '../../shared/utils/validation.utils';
import { successResponse } from '../../shared/types/api.types';
import { asyncHandler } from '../../shared/middleware/error.middleware';

class AuthController {
  /**
   * Send OTP to phone number
   */
  sendOtp = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const data = validateSchema(sendOtpSchema, req.body);
    
    const result = await authService.sendOtp(data.phone, data.role || 'customer');
    
    res.status(200).json(successResponse({
      message: result.message,
      expiresIn: result.expiresIn
    }));
  });

  /**
   * Verify OTP and return tokens
   */
  verifyOtp = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    // Debug: Log incoming request body
    console.log('=== VERIFY OTP REQUEST ===');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    console.log('==========================');
    
    const data = validateSchema(verifyOtpSchema, req.body);
    
    const result = await authService.verifyOtp(data.phone, data.otp, data.role || 'customer');
    
    res.status(200).json(successResponse({
      user: result.user,
      tokens: {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn
      },
      isNewUser: result.isNewUser
    }));
  });

  /**
   * Refresh access token
   */
  refreshToken = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const data = validateSchema(refreshTokenSchema, req.body);
    
    const result = await authService.refreshToken(data.refreshToken);
    
    res.status(200).json(successResponse({
      accessToken: result.accessToken,
      expiresIn: result.expiresIn
    }));
  });

  /**
   * Logout user
   */
  logout = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.userId!;
    
    await authService.logout(userId);
    
    res.status(200).json(successResponse({
      message: 'Logged out successfully'
    }));
  });

  /**
   * Get current user info
   */
  getCurrentUser = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.userId!;
    
    const user = await authService.getUserById(userId);
    
    res.status(200).json(successResponse({ user }));
  });
}

export const authController = new AuthController();
