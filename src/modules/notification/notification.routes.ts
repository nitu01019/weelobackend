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
import { redisService } from '../../shared/services/redis.service';
import { FLAGS, isEnabled } from '../../shared/config/feature-flags';
import { metrics } from '../../shared/monitoring/metrics.service';

const router = Router();

// =============================================================================
// SCHEMAS
// =============================================================================

const RegisterTokenSchema = z.object({
  token: z.string().min(10, 'Invalid FCM token'),
  deviceType: z.enum(['android', 'ios']).optional(),
  deviceId: z.string().optional(),
  // A05-015 (Phase 3.2): client-reported app build versionCode.
  // Android: BuildConfig.VERSION_CODE. iOS: CFBundleVersion (stringified -> int).
  // REST boundary clamp: 0..9_999_999 mirrors the SQL CHECK constraint
  // (docs/ops/sql/A05-015-appVersionCode.sql) so bad input fails at the edge.
  appVersionCode: z.number().int().min(0).max(9_999_999).nullable().optional(),
  // A05-005 (F-3): per-device stable identifier so the (userId, installId) UNIQUE
  // index UPSERTs the same row on token refresh instead of multiplying duplicates.
  // Pre-Captain rollout the column is absent on the wire — the service defaults
  // to 'legacy' so the unique constraint stays satisfied for all legacy devices
  // until the apps start sending a real per-install identifier.
  installId: z.string().min(1).max(64).optional(),
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
    // B1 — kill-switch on token registration. Default ON; flip
    // FF_FCM_REGISTRATION_ENABLED=false to immediately reject new device-token
    // registrations without redeploy. Existing DeviceToken rows + push delivery
    // remain active; only NEW registrations are blocked.
    if (!isEnabled(FLAGS.FCM_REGISTRATION_ENABLED)) {
      metrics.incrementCounter('fcm_registration_blocked_total', { reason: 'flag_off' });
      return res.status(503).json({
        success: false,
        error: {
          code: 'FCM_REGISTRATION_DISABLED',
          message: 'FCM token registration is temporarily disabled'
        }
      });
    }

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

    const { token, deviceType, deviceId, appVersionCode, installId } = validation.data;
    const userId = req.user!.userId;
    const userRole = req.user!.role;

    // Register token (Redis-backed for scalability across ECS instances)
    // A05-015 (Phase 3.2): pass optional appVersionCode through to fcm.service,
    // which persists it on the DeviceToken row and observes the Phase 3.3 histogram.
    // A05-005 (F-3): pass optional installId for per-device dedup; service falls
    // back to 'legacy' so older clients still satisfy the (userId, installId) UNIQUE.
    await fcmService.registerToken(
      userId,
      token,
      deviceType || 'android',
      appVersionCode,
      installId
    );

    // A05-014: Subscribe to role-based topics.
    // The 3 subscribeToTopic calls are orphaned — sendToTopic() is never invoked
    // from any production path. They cost ~300ms per registration and silently
    // churn Firebase quota. Gate behind FF_FCM_TOPIC_SUBSCRIPTIONS_ENABLED:
    // default OFF skips the calls; flip ON to restore the legacy behaviour
    // for rollback. Keep fcmService.sendToTopic / subscribeToTopic methods —
    // they remain valid for future batch-announcement flows.
    if (isEnabled(FLAGS.FCM_TOPIC_SUBSCRIPTIONS_ENABLED)) {
      const topicByRole: Record<string, string | undefined> = {
        transporter: 'transporter_all',
        driver: 'driver_all',
        customer: 'customer_all',
      };
      const topic = topicByRole[userRole];
      if (topic) {
        let outcome: 'success' | 'noop' | 'error' = 'noop';
        try {
          const ok = await fcmService.subscribeToTopic(userId, topic);
          outcome = ok ? 'success' : 'noop';
        } catch (subErr) {
          outcome = 'error';
          logger.error(`FCM topic subscribe failed for ${userId} -> ${topic}`, subErr);
        } finally {
          metrics.incrementCounter('fcm_topic_subscribe_total', {
            role: userRole,
            topic,
            outcome,
          });
        }
      }
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
    
    await fcmService.removeToken(userId, token);

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

    const defaults = {
      newBroadcasts: true,
      tripUpdates: true,
      payments: true,
      promotions: false,
      sound: true,
      vibration: true
    };

    const saved = await redisService.getJSON<Record<string, boolean>>(`notification_prefs:${userId}`);
    const preferences = saved ? { ...defaults, ...saved } : defaults;

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

    await redisService.setJSON(`notification_prefs:${userId}`, preferences, 86400 * 365);
    logger.info(`Notification preferences updated for user ${userId}`);

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

/** POST alias for Captain app compatibility (Captain declares both POST and PUT) */
router.post('/preferences', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const preferences = req.body;

    await redisService.setJSON(`notification_prefs:${userId}`, preferences, 86400 * 365);
    logger.info(`Notification preferences updated for user ${userId}`);

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
