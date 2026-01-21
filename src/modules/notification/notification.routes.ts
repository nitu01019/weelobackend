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

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.middleware';
import { fcmService } from '../../shared/services/fcm.service';
import { logger } from '../../shared/services/logger.service';

const router = Router();

// =============================================================================
// SCHEMAS
// =============================================================================

const RegisterTokenSchema = z.object({
  token: z.string().min(10, 'Invalid FCM token'),
  deviceType: z.enum(['android', 'ios']).optional(),
  deviceId: z.string().optional()
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
router.post('/register-token', authMiddleware, async (req: Request, res: Response) => {
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
    const userId = req.user!.userId;
    const userRole = req.user!.role;

    // Register token
    fcmService.registerToken(userId, token);

    // Subscribe to role-based topics
    if (userRole === 'transporter') {
      await fcmService.subscribeToTopic(userId, 'transporter_all');
    } else if (userRole === 'driver') {
      await fcmService.subscribeToTopic(userId, 'driver_all');
    } else if (userRole === 'customer') {
      await fcmService.subscribeToTopic(userId, 'customer_all');
    }

    logger.info(`FCM token registered for user ${userId} (${userRole})`);

    res.json({
      success: true,
      data: {
        message: 'FCM token registered successfully',
        userId,
        role: userRole
      }
    });
  } catch (error) {
    logger.error('Failed to register FCM token', error);
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
router.delete('/unregister-token', authMiddleware, async (req: Request, res: Response) => {
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

    const userId = req.user!.userId;
    
    fcmService.removeToken(userId, token);

    logger.info(`FCM token removed for user ${userId}`);

    res.json({
      success: true,
      data: {
        message: 'FCM token removed successfully'
      }
    });
  } catch (error) {
    logger.error('Failed to unregister FCM token', error);
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
router.get('/preferences', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    
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
  } catch (error) {
    logger.error('Failed to get notification preferences', error);
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
router.put('/preferences', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const preferences = req.body;

    // In production, save to database
    logger.info(`Notification preferences updated for user ${userId}`, preferences);

    res.json({
      success: true,
      data: {
        message: 'Preferences updated successfully',
        preferences
      }
    });
  } catch (error) {
    logger.error('Failed to update notification preferences', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update notification preferences'
      }
    });
  }
});

export const notificationRouter = router;
