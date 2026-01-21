"use strict";
/**
 * =============================================================================
 * USER MODULE - CONTROLLER
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.userController = void 0;
const user_service_1 = require("./user.service");
const user_schema_1 = require("./user.schema");
const validation_utils_1 = require("../../shared/utils/validation.utils");
const api_types_1 = require("../../shared/types/api.types");
const error_middleware_1 = require("../../shared/middleware/error.middleware");
class UserController {
    /**
     * Get current user profile
     */
    getProfile = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const userId = req.userId;
        const user = await user_service_1.userService.getUserById(userId);
        res.json((0, api_types_1.successResponse)({ user }));
    });
    /**
     * Update current user profile
     */
    updateProfile = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const userId = req.userId;
        const data = (0, validation_utils_1.validateSchema)(user_schema_1.updateProfileSchema, req.body);
        const user = await user_service_1.userService.updateProfile(userId, data);
        res.json((0, api_types_1.successResponse)({ user }));
    });
    /**
     * Get user by ID (admin only)
     */
    getUserById = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const { id } = req.params;
        const user = await user_service_1.userService.getUserById(id);
        res.json((0, api_types_1.successResponse)({ user }));
    });
}
exports.userController = new UserController();
//# sourceMappingURL=user.controller.js.map