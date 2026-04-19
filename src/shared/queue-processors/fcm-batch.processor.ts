/**
 * FCM Batch Queue Processor
 *
 * Sends push notifications to up to 500 drivers in ONE API call.
 * Uses Firebase Admin SDK multicast with circuit breaker protection.
 * When circuit is open, skips batch FCM entirely (Socket.IO is primary).
 */

import { logger } from '../services/logger.service';
import type { QueueJob } from '../services/queue.service';

export function registerFcmBatchProcessor(
  queue: { process(queueName: string, processor: (job: QueueJob) => Promise<void>): void },
  queueName: string
): void {
  queue.process(queueName, async (job) => {
    const { fcmCircuit }: typeof import('../services/circuit-breaker.service') = require('../services/circuit-breaker.service');
    const { tokens, notification } = job.data;

    await fcmCircuit.tryWithFallback(
      async () => {
        // Import fcmService
        const fcmService = (await import('../services/fcm.service')).fcmService;

        // Get FCM SDK
        let admin: typeof import('firebase-admin') | null = null;
        try {
          admin = require('firebase-admin');
        } catch (error) {
          logger.warn('[FCM_BATCH] Firebase Admin not available, falling back to individual sends');
          // Fallback: Send one-by-one using fcmService
          for (const token of tokens) {
            try {
              await fcmService.sendToTokens([token], {
                type: notification.data?.type || 'general',
                title: notification.title,
                body: notification.body,
                priority: 'high',
                data: notification.data
              });
            } catch (err: unknown) {
              if ((err as Record<string, unknown>)?.code === 'messaging/registration-token-not-registered') {
                // Token invalid, remove from Redis
                // DR-17 FIX: Use sRem matching fcm.service.ts key pattern `fcm:tokens:{userId}`.
                // userId is not available in batch job data, so we log a warning.
                // Dead token cleanup for multicast is handled by fcmService.sendToTokens() when userId is known.
                logger.warn(`[FCM_BATCH] Dead token detected but userId unavailable in batch job — token cannot be removed from Redis set`, { token });
              }
            }
          }
          return;
        }

        // Use Firebase Admin SDK multicast for batch send
        // FCM supports up to 500 tokens per request
        if (!admin) return; // guard: admin was set above; if catch returned early we never reach here
        if (tokens.length === 1) {
          await fcmService.sendToTokens(tokens, {
            type: notification.data?.type || 'general',
            title: notification.title,
            body: notification.body,
            priority: 'high',
            data: notification.data
          });
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const batchResponse = await (admin.messaging() as any).sendMulticast({
            tokens: tokens.slice(0, 500),  // FCM limit: 500
            notification: {
              title: notification.title,
              body: notification.body
            },
            data: notification.data || {}
          });

          const successCount = batchResponse.successCount || 0;
          const failureCount = (tokens.length || 1) - successCount;

          logger.info(`[FCM_BATCH] Sent to ${tokens.length} drivers: ${successCount} succeeded, ${failureCount} failed`);

          // Remove invalid tokens from Redis
          for (const token of tokens) {
            const index = batchResponse.responses.findIndex((r: { success: boolean }) => r.success === false);
            if (index !== -1 && batchResponse.responses[index].error?.code === 'messaging/registration-token-not-registered') {
              // DR-17 FIX: Use sRem matching fcm.service.ts key pattern `fcm:tokens:{userId}`.
                // userId is not available in batch job data, so we log a warning.
                // Dead token cleanup for multicast is handled by fcmService.sendToTokens() when userId is known.
                logger.warn(`[FCM_BATCH] Dead token detected but userId unavailable in batch job — token cannot be removed from Redis set`, { token });
            }
          }
        }
      },
      async () => {
        // Circuit open -- skip batch FCM (Socket.IO is primary delivery channel)
        logger.info(`[FCM_BATCH] Circuit open \u2014 skipping batch push for ${tokens.length} tokens (Socket.IO primary)`);
      }
    );
  });
}
