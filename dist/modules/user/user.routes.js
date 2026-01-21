"use strict";
/**
 * =============================================================================
 * USER MODULE - ROUTES
 * =============================================================================
 *
 * User profile management routes.
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.userRouter = void 0;
const express_1 = require("express");
const user_controller_1 = require("./user.controller");
const auth_middleware_1 = require("../../shared/middleware/auth.middleware");
const router = (0, express_1.Router)();
exports.userRouter = router;
/**
 * @route   GET /api/v1/users/profile
 * @desc    Get current user profile
 * @access  Private
 */
router.get('/profile', auth_middleware_1.authenticate, user_controller_1.userController.getProfile);
/**
 * @route   PUT /api/v1/users/profile
 * @desc    Update current user profile
 * @access  Private
 */
router.put('/profile', auth_middleware_1.authenticate, user_controller_1.userController.updateProfile);
/**
 * @route   GET /api/v1/users/:id
 * @desc    Get user by ID (admin only)
 * @access  Private (Admin)
 */
router.get('/:id', auth_middleware_1.authenticate, (0, auth_middleware_1.authorize)(auth_middleware_1.UserRole.ADMIN), user_controller_1.userController.getUserById);
//# sourceMappingURL=user.routes.js.map