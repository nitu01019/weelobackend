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

import { redisService, timerBatchLimit, timerShardZset } from '../../shared/services/redis.service';
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
// Fix #1: Batch limit uses shared helper (TIMER_BATCH_LIMIT env, default 100, max TIMER_BATCH_LIMIT_MAX=500)
const ORDER_TIMER_BATCH_LIMIT = timerBatchLimit();
// NEW#2: Orphan recovery runs every 5m by default; raise to 60s under heavy crash scenarios
const TIMER_ORPHAN_RECOVERY_INTERVAL_MS = parseInt(process.env.TIMER_ORPHAN_RECOVERY_INTERVAL_MS || '300000', 10) || 300_000;

// Fix #1: Pod-stable jitter so N pods don't all hit the ZSET simultaneously
function podPollOffsetMs(intervalMs: number): number {
  const host = process.env.HOSTNAME || process.env.ECS_TASK_ID || `pid-${process.pid}`;
  let h = 0;
  for (let i = 0; i < host.length; i++) h = ((h << 5) - h + host.charCodeAt(i)) | 0;
  return Math.abs(h) % Math.max(1, intervalMs);
}

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
    ORDER_EXPIRY_TIMER_PREFIX, ORDER_TIMER_BATCH_LIMIT
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
  }>(ORDER_STEP_TIMER_PREFIX, ORDER_TIMER_BATCH_LIMIT);
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
  const offset = podPollOffsetMs(ORDER_TIMER_CHECK_INTERVAL_MS);
  setTimeout(() => {
    if (orderTimerCheckerInterval) return;
    orderTimerCheckerInterval = setInterval(async () => {
      try {
        await processExpiredTimers();
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`[ORDER TIMER] Failed to process timers: ${errorMessage}`);
      }
    }, ORDER_TIMER_CHECK_INTERVAL_MS);
    orderTimerCheckerInterval.unref();
  }, offset).unref();
  logger.info(`[ORDER TIMER] Started — interval=${ORDER_TIMER_CHECK_INTERVAL_MS}ms, batchLimit=${ORDER_TIMER_BATCH_LIMIT}, podOffset=${offset}ms`);
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

  const zscoreLua = `return redis.call('zscore', KEYS[1], ARGV[1])`;
  const useLegacy = process.env.FF_TIMER_LEGACY_ZSET_ENABLED !== 'false';

  for (const key of keys) {
    try {
      const shardZset = timerShardZset(key);

      // Key is tracked if it appears in EITHER the shard ZSET or legacy timers:pending
      const shardScore = await redisService.eval(zscoreLua, [shardZset], [key]).catch(() => null);
      const legacyScore = useLegacy
        ? await redisService.eval(zscoreLua, ['timers:pending'], [key]).catch(() => null)
        : null;

      if ((shardScore !== null && shardScore !== undefined) ||
          (legacyScore !== null && legacyScore !== undefined)) continue;

      // Read the timer data to get the expiresAt timestamp
      const raw = await redisService.get(key);
      if (!raw) continue;

      let timer: { data: unknown; expiresAt: string };
      try {
        timer = JSON.parse(raw);
      } catch {
        await redisService.del(key).catch(() => {});
        continue;
      }

      const expiresAtMs = new Date(timer.expiresAt).getTime();
      if (!Number.isFinite(expiresAtMs)) {
        await redisService.del(key).catch(() => {});
        continue;
      }

      // NEW#2: Re-add to shard ZSET (and legacy during dual-write window)
      await redisService.zAdd(shardZset, expiresAtMs, key);
      if (useLegacy) {
        await redisService.zAdd('timers:pending', expiresAtMs, key);
      }

      recovered++;
      logger.info(`[C-8 Recovery] Re-queued orphaned ${label}: ${key}`);
    } catch (keyErr: unknown) {
      const msg = keyErr instanceof Error ? keyErr.message : String(keyErr);
      logger.warn(`[C-8 Recovery] Error processing key ${key}: ${msg}`);
    }
  }

  return recovered;
}

// NEW#2: All timer prefixes to scan during orphan recovery.
// Kept in sync with TIMER_PREFIX_TO_SHARD in redis.service.ts.
const ALL_TIMER_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['timer:order-broadcast-step:', 'step timer'],
  ['timer:order-expiry:',         'expiry timer'],
  ['timer:assignment-timeout:',   'assignment-timeout timer'],
  ['timer:booking-order:',        'booking-order timer'],
  ['timer:booking:',              'booking timer'],
  ['timer:radius:',               'radius timer'],
  ['timer:rating-reminder:',      'rating-reminder timer'],
];

/**
 * C-8 FIX + NEW#2: Scan for orphaned timer keys across ALL 7 timer prefixes.
 * Checks both the shard ZSET and legacy timers:pending; re-adds to both during
 * the dual-write window (FF_TIMER_LEGACY_ZSET_ENABLED=true).
 *
 * Safe to call repeatedly — idempotent: already-tracked keys are skipped.
 */
export async function recoverOrphanedStepTimers(): Promise<number> {
  let total = 0;
  const counts: string[] = [];

  for (const [prefix, label] of ALL_TIMER_PREFIXES) {
    try {
      const n = await recoverOrphanedTimersByPrefix(prefix, label);
      if (n > 0) counts.push(`${n} ${label}`);
      total += n;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[C-8 Recovery] Scan failed for ${label}: ${msg}`);
    }
  }

  if (total > 0) {
    logger.info(`[C-8 Recovery] Recovered ${total} orphaned timer(s): ${counts.join(', ')}`);
  } else {
    logger.info('[C-8 Recovery] No orphaned timers found across all 7 prefixes');
  }
  return total;
}

let orphanRecoveryInterval: ReturnType<typeof setInterval> | null = null;

/**
 * NEW#2: Start periodic orphan recovery.  Runs recoverOrphanedStepTimers on
 * an interval (TIMER_ORPHAN_RECOVERY_INTERVAL_MS, default 300s).  Idempotent
 * — calling more than once is safe.
 */
export function startOrphanRecovery(): void {
  if (orphanRecoveryInterval) return;
  orphanRecoveryInterval = setInterval(() => {
    recoverOrphanedStepTimers().catch((err: unknown) => {
      logger.warn(`[C-8 Recovery] Periodic scan error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, TIMER_ORPHAN_RECOVERY_INTERVAL_MS);
  orphanRecoveryInterval.unref();
  logger.info(`[ORDER TIMER] Orphan recovery started — interval=${TIMER_ORPHAN_RECOVERY_INTERVAL_MS}ms`);
}

// Auto-start on module load (same behavior as before extraction)
if (process.env.NODE_ENV !== 'test') {
  startOrderTimerChecker();
}
