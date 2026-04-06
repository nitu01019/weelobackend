/**
 * =============================================================================
 * ORDER TIMER SERVICE - Distributed timer management for order expiry & steps
 * =============================================================================
 *
 * Extracted from OrderService (Phase 6 of decomposition).
 * Manages Redis-based distributed timers for:
 *   - Order expiry (overall broadcast timeout)
 *   - Progressive broadcast step scheduling
 *
 * Cross-references:
 *   - processExpiredOrderTimers calls handleOrderExpiry (order-lifecycle-outbox)
 *   - processExpiredBroadcastStepTimers calls processProgressiveBroadcastStep (order-broadcast)
 *   - startOrderTimerChecker uses lazy require for orderService.processExpiredTimers
 *
 * IMPORTANT: This file must NOT import from order.service.ts to avoid
 * circular dependencies. The only exception is the lazy require in
 * startOrderTimerChecker which breaks the cycle at runtime.
 * =============================================================================
 */

import { redisService } from '../../shared/services/redis.service';
import { logger } from '../../shared/services/logger.service';
import { processProgressiveBroadcastStep } from './order-broadcast.service';

// ---------------------------------------------------------------------------
// Lazy import helpers — breaks circular dep with order-lifecycle-outbox
// ---------------------------------------------------------------------------

function getHandleOrderExpiry(): (orderId: string) => Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { handleOrderExpiry } = require('./order-lifecycle-outbox.service');
  return handleOrderExpiry;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ORDER_EXPIRY_TIMER_PREFIX = 'timer:order-expiry:';
export const ORDER_STEP_TIMER_PREFIX = 'timer:order-broadcast-step:';
export const ORDER_STEP_TIMER_LOCK_PREFIX = 'lock:order-broadcast-step:';
// M-21 FIX: Make timer poll interval configurable via env var (default 2s unchanged)
const ORDER_TIMER_CHECK_INTERVAL_MS = parseInt(process.env.TIMER_POLL_INTERVAL_MS || '2000', 10) || 2_000;

let orderTimerCheckerInterval: NodeJS.Timeout | null = null;

// ---------------------------------------------------------------------------
// Key generators
// ---------------------------------------------------------------------------

export function orderExpiryTimerKey(orderId: string): string {
  return `${ORDER_EXPIRY_TIMER_PREFIX}${orderId}`;
}

// ---------------------------------------------------------------------------
// Timer CRUD
// ---------------------------------------------------------------------------

export async function setOrderExpiryTimer(orderId: string, timeoutMs: number): Promise<void> {
  // Cancel any existing timer
  await redisService.cancelTimer(orderExpiryTimerKey(orderId));

  // Set new timer in Redis
  const expiresAt = new Date(Date.now() + timeoutMs);
  const timerData = {
    orderId,
    createdAt: new Date().toISOString()
  };

  await redisService.setTimer(orderExpiryTimerKey(orderId), timerData, expiresAt);
  logger.info(`⏱️ Order expiry timer set for ${orderId} (${timeoutMs / 1000}s) [Redis-based]`);
}

export async function clearProgressiveStepTimers(orderId: string): Promise<void> {
  const pattern = `${ORDER_STEP_TIMER_PREFIX}${orderId}:*`;
  const batch: string[] = [];

  for await (const key of redisService.scanIterator(pattern, 200)) {
    batch.push(key);
    if (batch.length < 200) continue;
    await Promise.allSettled(batch.map((timerKey) => redisService.cancelTimer(timerKey).catch(() => false)));
    batch.length = 0;
  }

  if (batch.length > 0) {
    await Promise.allSettled(batch.map((timerKey) => redisService.cancelTimer(timerKey).catch(() => false)));
  }
}

// ---------------------------------------------------------------------------
// Expired timer processors
// ---------------------------------------------------------------------------

export async function processExpiredTimers(): Promise<void> {
  await processExpiredOrderTimers();
  await processExpiredBroadcastStepTimers();
}

export async function processExpiredOrderTimers(): Promise<void> {
  const expiredTimers = await redisService.getExpiredTimers<{ orderId: string }>(
    ORDER_EXPIRY_TIMER_PREFIX
  );
  for (const timer of expiredTimers) {
    const orderId = timer.data?.orderId;
    if (!orderId) {
      await redisService.cancelTimer(timer.key).catch(() => false);
      continue;
    }

    const lockKey = `${ORDER_STEP_TIMER_LOCK_PREFIX}expiry:${orderId}`;
    const lock = await redisService.acquireLock(lockKey, 'order-expiry-checker', 30);
    if (!lock.acquired) continue;

    try {
      await getHandleOrderExpiry()(orderId);
    } finally {
      await redisService.cancelTimer(timer.key).catch(() => false);
      await redisService.releaseLock(lockKey, 'order-expiry-checker').catch(() => { });
    }
  }
}

export async function processExpiredBroadcastStepTimers(): Promise<void> {
  const expiredTimers = await redisService.getExpiredTimers<{
    orderId: string;
    vehicleType: string;
    vehicleSubtype: string;
    stepIndex: number;
    scheduledAtMs?: number;
    stepWindowMs?: number;
  }>(ORDER_STEP_TIMER_PREFIX);
  for (const timer of expiredTimers) {
    const data = timer.data;
    if (!data?.orderId || !data.vehicleType || data.stepIndex == null) {
      await redisService.cancelTimer(timer.key).catch(() => false);
      continue;
    }

    const lockKey = `${ORDER_STEP_TIMER_LOCK_PREFIX}${data.orderId}:${data.vehicleType}:${data.vehicleSubtype}:${data.stepIndex}`;
    const lock = await redisService.acquireLock(lockKey, 'order-step-checker', 30);
    if (!lock.acquired) continue;

    try {
      const expectedAtMs = Date.parse(timer.expiresAt);
      const triggerLatencyMs = Number.isFinite(expectedAtMs)
        ? Math.max(0, Date.now() - expectedAtMs)
        : 0;
      if (triggerLatencyMs > 2_500) {
        logger.warn('[ORDER STEP TIMER] Trigger latency above budget', {
          orderId: data.orderId,
          vehicleType: data.vehicleType,
          vehicleSubtype: data.vehicleSubtype || '',
          stepIndex: Number(data.stepIndex),
          triggerLatencyMs,
          expectedAt: timer.expiresAt
        });
      } else {
        logger.debug('[ORDER STEP TIMER] Trigger latency', {
          orderId: data.orderId,
          vehicleType: data.vehicleType,
          vehicleSubtype: data.vehicleSubtype || '',
          stepIndex: Number(data.stepIndex),
          triggerLatencyMs
        });
      }

      await processProgressiveBroadcastStep({
        orderId: data.orderId,
        vehicleType: data.vehicleType,
        vehicleSubtype: data.vehicleSubtype || '',
        stepIndex: Number(data.stepIndex)
      });
    } finally {
      await redisService.cancelTimer(timer.key).catch(() => false);
      await redisService.releaseLock(lockKey, 'order-step-checker').catch(() => { });
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level timer checker (setInterval)
// ---------------------------------------------------------------------------

export function startOrderTimerChecker(): void {
  if (orderTimerCheckerInterval) return;
  orderTimerCheckerInterval = setInterval(async () => {
    try {
      await processExpiredTimers();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`[ORDER TIMER] Failed to process timers: ${errorMessage}`);
    }
  }, ORDER_TIMER_CHECK_INTERVAL_MS);
}

export function stopOrderTimerChecker(): void {
  if (!orderTimerCheckerInterval) return;
  clearInterval(orderTimerCheckerInterval);
  orderTimerCheckerInterval = null;
}

// ---------------------------------------------------------------------------
// C-8 FIX: Startup recovery for orphaned progressive step timers
// ---------------------------------------------------------------------------
// After a server crash, timer keys may exist in Redis but not in the
// `timers:pending` sorted set (because getExpiredTimers ZREMs entries
// before the caller finishes processing). This function scans for
// orphaned step timer keys and re-adds them to the sorted set so the
// next processExpiredTimers cycle picks them up.
// ---------------------------------------------------------------------------

/**
 * C-8 FIX: Recover a set of timer keys that exist in Redis but are missing
 * from the `timers:pending` sorted set (orphaned by a crash between ZREM
 * and successful processing).
 */
async function recoverOrphanedTimersByPrefix(prefix: string, label: string): Promise<number> {
  let recovered = 0;
  const keys: string[] = [];
  for await (const key of redisService.scanIterator(`${prefix}*`, 200)) {
    keys.push(key);
  }

  if (keys.length === 0) return 0;

  logger.info(`[C-8 Recovery] Found ${keys.length} ${label} key(s) in Redis, checking for orphans`);

  for (const key of keys) {
    try {
      // Check if this key is already in the sorted set via Lua ZSCORE
      const score = await redisService.eval(
        `return redis.call('zscore', KEYS[1], ARGV[1])`,
        ['timers:pending'],
        [key]
      ).catch(() => null);

      // If score exists the key is already tracked -- skip
      if (score !== null && score !== undefined) continue;

      // Read the timer data to get the expiresAt timestamp
      const raw = await redisService.get(key);
      if (!raw) continue;

      let timer: { data: unknown; expiresAt: string };
      try {
        timer = JSON.parse(raw);
      } catch {
        // Corrupt key -- delete it
        await redisService.del(key).catch(() => {});
        continue;
      }

      const expiresAtMs = new Date(timer.expiresAt).getTime();
      if (!Number.isFinite(expiresAtMs)) {
        await redisService.del(key).catch(() => {});
        continue;
      }

      // Re-add to sorted set so processExpiredTimers picks it up
      await redisService.zAdd('timers:pending', expiresAtMs, key);

      recovered++;
      logger.info(`[C-8 Recovery] Re-queued orphaned ${label}: ${key}`);
    } catch (keyErr: unknown) {
      const msg = keyErr instanceof Error ? keyErr.message : String(keyErr);
      logger.warn(`[C-8 Recovery] Error processing key ${key}: ${msg}`);
    }
  }

  return recovered;
}

/**
 * C-8 FIX: Scan for orphaned order timer keys (both step timers and expiry
 * timers) that exist in Redis but are not in the `timers:pending` sorted set.
 * Re-adds them so the polling loop picks them up within 2 seconds.
 *
 * Call this once during server startup, after Redis is connected.
 */
export async function recoverOrphanedStepTimers(): Promise<number> {
  try {
    const stepRecovered = await recoverOrphanedTimersByPrefix(
      ORDER_STEP_TIMER_PREFIX, 'step timer'
    );
    const expiryRecovered = await recoverOrphanedTimersByPrefix(
      ORDER_EXPIRY_TIMER_PREFIX, 'expiry timer'
    );
    const total = stepRecovered + expiryRecovered;

    if (total > 0) {
      logger.info(`[C-8 Recovery] Recovered ${total} orphaned timer(s) (${stepRecovered} step, ${expiryRecovered} expiry)`);
    } else {
      logger.info('[C-8 Recovery] No orphaned order timers found');
    }
    return total;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[C-8 Recovery] Scan failed (timers will fire via next poll): ${msg}`);
    return 0;
  }
}

// Auto-start on module load (same behavior as before extraction)
if (process.env.NODE_ENV !== 'test') {
  startOrderTimerChecker();
}
