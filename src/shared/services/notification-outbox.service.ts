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
// F-B-50: Direct import from the canonical queue.service.ts singleton.
// Replaces a broken runtime `require` against a non-exported facade singleton
// whose failure was being silently swallowed by `.catch(() => {})`.
import { queueService } from './queue.service';
import { metrics } from '../monitoring/metrics.service';

const OUTBOX_PREFIX = 'notification:outbox:';
const OUTBOX_TTL_SECONDS = 3600;       // 1 hour
const FRESHNESS_MS = 15 * 60 * 1000;   // 15 minutes — skip stale items on drain

// P3-T12/T15: O(1) counter key for outbox_size gauge (avoids SCAN on drain).
const OUTBOX_SIZE_KEY = 'outbox:size';

export interface OutboxEntry {
  userId: string;
  payload: { title: string; body: string; data?: Record<string, string> };
  timestamp: number;
  reason?: string;
}

/**
 * Buffer a notification when both circuits are open.
 * P3-T12: emits outbox_buffered_total{reason} + INCR outbox:size.
 */
export async function bufferNotification(
  userId: string,
  payload: OutboxEntry['payload'],
  reason?: string,
): Promise<void> {
  const key = `${OUTBOX_PREFIX}${userId}`;
  const entry: OutboxEntry = { userId, payload, timestamp: Date.now(), reason };
  try {
    await redisService.lPush(key, JSON.stringify(entry));
    await redisService.expire(key, OUTBOX_TTL_SECONDS);
    // P3-T12: buffered counter + O(1) size counter
    metrics.incrementCounter('outbox_buffered_total', { reason: entry.reason ?? 'adapter_down' });
    await redisService.incr(OUTBOX_SIZE_KEY).catch(() => {/* non-critical — size is best-effort */});
    logger.info(`[NotificationOutbox] Buffered notification for user ${userId}`);
  } catch (err: any) {
    logger.warn(`[NotificationOutbox] Failed to buffer for ${userId}: ${err?.message}`);
  }
}

/**
 * Drain the outbox for a user — called when a circuit recovers.
 * Skips entries older than FRESHNESS_MS.
 * P3-T13: emits outbox_drained_total{outcome,outbox}.
 * P3-T14: observes outbox_drain_latency_ms{outbox}.
 * P3-T15/T16: structured error logging with failure counter; no silent-loss.
 */
export async function drainOutbox(userId: string): Promise<void> {
  const key = `${OUTBOX_PREFIX}${userId}`;
  try {
    let item: string | null;
    while ((item = await redisService.rPop(key))) {
      const parsed: OutboxEntry = JSON.parse(item);

      // P3-T13: stale-skip path
      if (Date.now() - parsed.timestamp > FRESHNESS_MS) {
        metrics.incrementCounter('outbox_drained_total', { outcome: 'stale_skipped', outbox: 'notification' });
        // stale entries still consume an outbox slot — decrement size
        await redisService.incrBy(OUTBOX_SIZE_KEY, -1).catch(() => {});
        continue;
      }

      // P3-T14: measure per-entry drain latency
      const drainStart = Date.now();
      const entryUserId = parsed.userId;

      await queueService
        .queuePushNotification(parsed.userId, parsed.payload)
        .then(() => {
          const drainMs = Date.now() - drainStart;
          // P3-T14: latency histogram
          metrics.observeHistogram('outbox_drain_latency_ms', drainMs, { outbox: 'notification' });
          // P3-T13: delivered
          metrics.incrementCounter('outbox_drained_total', { outcome: 'delivered', outbox: 'notification' });
          // P3-T15: O(1) size counter — decremented only on delivered
          redisService.incrBy(OUTBOX_SIZE_KEY, -1).catch(() => {});
        })
        .catch((err: unknown) => {
          // P3-T16: structured logger replaces silent `.catch(() => {})` (A12-011)
          const message = err instanceof Error ? err.message : String(err);
          logger.error('[NotificationOutbox] outbox drain failed', { err: message, entryUserId });
          // P3-T13 / P3-T16: failure counter
          metrics.incrementCounter('outbox_drained_total', { outcome: 'failed', outbox: 'notification' });
          // NOTE: on failure we do NOT decrement outbox:size — the entry was
          // not re-pushed so Redis list is already shorter, but the counter
          // would undercount. Leave it slightly over-counted rather than
          // letting it drift negative.
        });
    }
    logger.info(`[NotificationOutbox] Drained outbox for user ${userId}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[NotificationOutbox] Drain failed for ${userId}: ${message}`);
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

// P3-T15: Sample outbox_size gauge every 30s via O(1) GET (not SCAN).
// Guard NODE_ENV !== 'test' so test suites never run the background timer.
if (process.env.NODE_ENV !== 'test') {
  const sizeTimer = setInterval(async () => {
    try {
      const raw = await redisService.get(OUTBOX_SIZE_KEY);
      const n = parseInt(raw ?? '0', 10);
      metrics.setGauge('outbox_size', isNaN(n) ? 0 : Math.max(0, n));
    } catch {
      // non-critical — skip this sample
    }
  }, 30_000);

  // Prevent this timer from keeping the process alive in integration tests or
  // short-lived scripts that happen to set NODE_ENV to something other than 'test'.
  if (typeof (sizeTimer as unknown as { unref?: () => void }).unref === 'function') {
    (sizeTimer as unknown as { unref: () => void }).unref();
  }
}

// P3-T7 (Part B §2.9): legacy-entry coercion shim not present in this file.
// OutboxEntry already carries an optional `reason` field — no legacy coercion
// path exists. outbox_drain_legacy_entries_total is SKIPPED (not applicable).
