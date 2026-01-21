/**
 * =============================================================================
 * USER MODULE - ROUTES
 * =============================================================================
 * 
 * User profile management routes.
 * =============================================================================
 */

import { Router } from 'express';
import { userController } from './user.controller';
import { authenticate, authorize, UserRole } from '../../shared/middleware/auth.middleware';

const router = Router();

/**
 * @route   GET /api/v1/users/profile
 * @desc    Get current user profile
 * @access  Private
 */
router.get('/profile', authenticate, userController.getProfile);

/**
 * @route   PUT /api/v1/users/profile
 * @desc    Update current user profile
 * @access  Private
 */
router.put('/profile', authenticate, userController.updateProfile);

/**
 * @route   GET /api/v1/users/:id
 * @desc    Get user by ID (admin only)
 * @access  Private (Admin)
 */
router.get('/:id', authenticate, authorize(UserRole.ADMIN), userController.getUserById);

export { router as userRouter };
