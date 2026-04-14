/**
 * Push Notification Queue Processor
 *
 * Handles individual FCM push notifications with circuit breaker protection.
 * When circuit is open, skips FCM (Socket.IO is primary delivery channel).
 */

import { logger } from '../services/logger.service';
import type { QueueJob } from '../services/queue.service';

export function registerPushNotificationProcessor(
  queue: { process(queueName: string, processor: (job: QueueJob) => Promise<void>): void },
  queueName: string
): void {
  queue.process(queueName, async (job) => {
    const { sendPushNotification }: typeof import('../services/fcm.service') = require('../services/fcm.service');
    const { fcmCircuit }: typeof import('../services/circuit-breaker.service') = require('../services/circuit-breaker.service');
    const { userId, notification } = job.data;

    await fcmCircuit.tryWithFallback(
      async () => {
        await sendPushNotification(userId, notification);
      },
      async () => {
        // Circuit open -- skip FCM push (Socket.IO is primary delivery channel)
        logger.info(`[FCM] Circuit open \u2014 skipping push for user ${userId} (Socket.IO primary)`);
      }
    );
  });
}
