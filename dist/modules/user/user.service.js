"use strict";
/**
 * =============================================================================
 * USER MODULE - SERVICE
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.userService = void 0;
const error_types_1 = require("../../shared/types/error.types");
const logger_service_1 = require("../../shared/services/logger.service");
// In-memory store (replace with DB in production)
const userStore = new Map();
class UserService {
    /**
     * Get user by ID
     */
    async getUserById(userId) {
        const user = userStore.get(userId);
        if (!user) {
            throw new error_types_1.AppError(404, 'USER_NOT_FOUND', 'User not found');
        }
        return user;
    }
    /**
     * Update user profile
     */
    async updateProfile(userId, data) {
        const user = userStore.get(userId);
        if (!user) {
            throw new error_types_1.AppError(404, 'USER_NOT_FOUND', 'User not found');
        }
        // Update fields
        const updatedUser = {
            ...user,
            ...data,
            updatedAt: new Date()
        };
        userStore.set(userId, updatedUser);
        logger_service_1.logger.info('User profile updated', { userId });
        return updatedUser;
    }
    /**
     * Create or update user (called from auth service)
     */
    async upsertUser(userData) {
        const existing = userStore.get(userData.id);
        const user = {
            ...existing,
            ...userData,
            createdAt: existing?.createdAt || new Date(),
            updatedAt: new Date()
        };
        userStore.set(user.id, user);
        return user;
    }
}
exports.userService = new UserService();
//# sourceMappingURL=user.service.js.map