/**
 * Notification Outbox — Redis-backed buffer for dual-circuit-open scenario.
 *
 * When BOTH socketCircuit AND fcmCircuit are open, notifications have no
 * delivery path and would be silently dropped. This outbox catches them
 * in a per-user Redis list so they can be drained once either circuit
 * recovers.
 */

import { redisService } from './redis.service';
import { logger } from './logger.service';

const OUTBOX_PREFIX = 'notification:outbox:';
const OUTBOX_TTL_SECONDS = 3600;       // 1 hour
const FRESHNESS_MS = 15 * 60 * 1000;   // 15 minutes — skip stale items on drain

export interface OutboxEntry {
  userId: string;
  payload: { title: string; body: string; data?: Record<string, string> };
  timestamp: number;
}

/**
 * Buffer a notification when both circuits are open.
 */
export async function bufferNotification(
  userId: string,
  payload: OutboxEntry['payload'],
): Promise<void> {
  const key = `${OUTBOX_PREFIX}${userId}`;
  const entry: OutboxEntry = { userId, payload, timestamp: Date.now() };
  try {
    await redisService.lPush(key, JSON.stringify(entry));
    await redisService.expire(key, OUTBOX_TTL_SECONDS);
    logger.info(`[NotificationOutbox] Buffered notification for user ${userId}`);
  } catch (err: any) {
    logger.warn(`[NotificationOutbox] Failed to buffer for ${userId}: ${err?.message}`);
  }
}

/**
 * Drain the outbox for a user — called when a circuit recovers.
 * Skips entries older than FRESHNESS_MS.
 */
export async function drainOutbox(userId: string): Promise<void> {
  const key = `${OUTBOX_PREFIX}${userId}`;
  try {
    const { queueManagementService } = require('./queue-management.service');
    let item: string | null;
    while ((item = await redisService.rPop(key))) {
      const parsed: OutboxEntry = JSON.parse(item);
      if (Date.now() - parsed.timestamp > FRESHNESS_MS) continue;
      await queueManagementService
        .queuePushNotification(parsed.userId, parsed.payload)
        .catch(() => {});
    }
    logger.info(`[NotificationOutbox] Drained outbox for user ${userId}`);
  } catch (err: any) {
    logger.warn(`[NotificationOutbox] Drain failed for ${userId}: ${err?.message}`);
  }
}

/**
 * Drain ALL user outboxes — called on circuit recovery.
 * Uses SCAN (not KEYS) to find outbox entries without blocking Redis.
 */
export async function drainAllOutboxes(): Promise<void> {
  try {
    const pattern = `${OUTBOX_PREFIX}*`;
    const prefixLen = OUTBOX_PREFIX.length;
    let drained = 0;

    for await (const key of redisService.scanIterator(pattern, 50)) {
      const userId = key.slice(prefixLen);
      if (userId) {
        await drainOutbox(userId);
        drained++;
      }
    }

    if (drained > 0) {
      logger.info(`[NotificationOutbox] Recovery drain complete: ${drained} user(s) processed`);
    }
  } catch (err: any) {
    logger.warn(`[NotificationOutbox] drainAllOutboxes failed: ${err?.message}`);
  }
}
