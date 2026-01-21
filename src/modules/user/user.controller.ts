/**
 * =============================================================================
 * USER MODULE - CONTROLLER
 * =============================================================================
 */

import { Request, Response, NextFunction } from 'express';
import { userService } from './user.service';
import { updateProfileSchema } from './user.schema';
import { validateSchema } from '../../shared/utils/validation.utils';
import { successResponse } from '../../shared/types/api.types';
import { asyncHandler } from '../../shared/middleware/error.middleware';

class UserController {
  /**
   * Get current user profile
   */
  getProfile = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.userId!;
    const user = await userService.getUserById(userId);
    res.json(successResponse({ user }));
  });

  /**
   * Update current user profile
   */
  updateProfile = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.userId!;
    const data = validateSchema(updateProfileSchema, req.body);
    
    const user = await userService.updateProfile(userId, data);
    res.json(successResponse({ user }));
  });

  /**
   * Get user by ID (admin only)
   */
  getUserById = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const user = await userService.getUserById(id);
    res.json(successResponse({ user }));
  });
}

export const userController = new UserController();
