"use strict";
/**
 * =============================================================================
 * NOTIFICATION MODULE - ROUTES
 * =============================================================================
 *
 * Handles FCM token registration and notification preferences.
 *
 * ENDPOINTS:
 * - POST /api/v1/notifications/register-token - Register FCM token
 * - DELETE /api/v1/notifications/unregister-token - Remove FCM token
 * - GET /api/v1/notifications/preferences - Get notification preferences
 * - PUT /api/v1/notifications/preferences - Update notification preferences
 *
 * FOR BACKEND DEVELOPERS:
 * - Tokens are stored in memory (use Redis/DB in production)
 * - Call register-token after login and on token refresh
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.notificationRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const auth_middleware_1 = require("../../shared/middleware/auth.middleware");
const fcm_service_1 = require("../../shared/services/fcm.service");
const logger_service_1 = require("../../shared/services/logger.service");
const router = (0, express_1.Router)();
// =============================================================================
// SCHEMAS
// =============================================================================
const RegisterTokenSchema = zod_1.z.object({
    token: zod_1.z.string().min(10, 'Invalid FCM token'),
    deviceType: zod_1.z.enum(['android', 'ios']).optional(),
    deviceId: zod_1.z.string().optional()
});
// =============================================================================
// REGISTER FCM TOKEN
// =============================================================================
/**
 * POST /api/v1/notifications/register-token
 *
 * Register FCM token for push notifications.
 * Call this:
 * - After successful login
 * - When FCM token is refreshed
 *
 * @body {token: string, deviceType?: 'android' | 'ios', deviceId?: string}
 */
router.post('/register-token', auth_middleware_1.authMiddleware, async (req, res) => {
    try {
        const validation = RegisterTokenSchema.safeParse(req.body);
        if (!validation.success) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: validation.error.errors[0].message
                }
            });
        }
        const { token, deviceType, deviceId } = validation.data;
        const userId = req.user.userId;
        const userRole = req.user.role;
        // Register token
        fcm_service_1.fcmService.registerToken(userId, token);
        // Subscribe to role-based topics
        if (userRole === 'transporter') {
            await fcm_service_1.fcmService.subscribeToTopic(userId, 'transporter_all');
        }
        else if (userRole === 'driver') {
            await fcm_service_1.fcmService.subscribeToTopic(userId, 'driver_all');
        }
        else if (userRole === 'customer') {
            await fcm_service_1.fcmService.subscribeToTopic(userId, 'customer_all');
        }
        logger_service_1.logger.info(`FCM token registered for user ${userId} (${userRole})`);
        res.json({
            success: true,
            data: {
                message: 'FCM token registered successfully',
                userId,
                role: userRole
            }
        });
    }
    catch (error) {
        logger_service_1.logger.error('Failed to register FCM token', error);
        res.status(500).json({
            success: false,
            error: {
                code: 'INTERNAL_ERROR',
                message: 'Failed to register notification token'
            }
        });
    }
});
// =============================================================================
// UNREGISTER FCM TOKEN
// =============================================================================
/**
 * DELETE /api/v1/notifications/unregister-token
 *
 * Remove FCM token (on logout or token refresh)
 *
 * @body {token: string}
 */
router.delete('/unregister-token', auth_middleware_1.authMiddleware, async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Token is required'
                }
            });
        }
        const userId = req.user.userId;
        fcm_service_1.fcmService.removeToken(userId, token);
        logger_service_1.logger.info(`FCM token removed for user ${userId}`);
        res.json({
            success: true,
            data: {
                message: 'FCM token removed successfully'
            }
        });
    }
    catch (error) {
        logger_service_1.logger.error('Failed to unregister FCM token', error);
        res.status(500).json({
            success: false,
            error: {
                code: 'INTERNAL_ERROR',
                message: 'Failed to unregister notification token'
            }
        });
    }
});
// =============================================================================
// GET NOTIFICATION PREFERENCES
// =============================================================================
/**
 * GET /api/v1/notifications/preferences
 *
 * Get user's notification preferences
 */
router.get('/preferences', auth_middleware_1.authMiddleware, async (req, res) => {
    try {
        const userId = req.user.userId;
        // Default preferences (in production, fetch from database)
        const preferences = {
            newBroadcasts: true,
            tripUpdates: true,
            payments: true,
            promotions: false,
            sound: true,
            vibration: true
        };
        res.json({
            success: true,
            data: preferences
        });
    }
    catch (error) {
        logger_service_1.logger.error('Failed to get notification preferences', error);
        res.status(500).json({
            success: false,
            error: {
                code: 'INTERNAL_ERROR',
                message: 'Failed to get notification preferences'
            }
        });
    }
});
// =============================================================================
// UPDATE NOTIFICATION PREFERENCES
// =============================================================================
/**
 * PUT /api/v1/notifications/preferences
 *
 * Update user's notification preferences
 */
router.put('/preferences', auth_middleware_1.authMiddleware, async (req, res) => {
    try {
        const userId = req.user.userId;
        const preferences = req.body;
        // In production, save to database
        logger_service_1.logger.info(`Notification preferences updated for user ${userId}`, preferences);
        res.json({
            success: true,
            data: {
                message: 'Preferences updated successfully',
                preferences
            }
        });
    }
    catch (error) {
        logger_service_1.logger.error('Failed to update notification preferences', error);
        res.status(500).json({
            success: false,
            error: {
                code: 'INTERNAL_ERROR',
                message: 'Failed to update notification preferences'
            }
        });
    }
});
exports.notificationRouter = router;
//# sourceMappingURL=notification.routes.js.map