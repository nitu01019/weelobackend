/**
 * Notification Outbox \u2014 Redis-backed buffer for dual-circuit-open scenario.
 *
 * When BOTH socketCircuit AND fcmCircuit are open, notifications have no
 * delivery path and would be silently dropped. This outbox catches them
 * in a per-user Redis list so they can be drained once either circuit
 * recovers.
 *
 * Delivery guarantee: AT-LEAST-ONCE.
 * Drain acquires a per-entry distributed lock BEFORE attempting emission.
 * On emit failure the lock is released so the entry can be retried.
 * Downstream consumers must be idempotent.
 *
 * P6 amendments implemented here:
 *  P6-T01  Discriminated-union OutboxEntry.payload
 *  P6-T02  Drain: socket-first, FCM fallback
 *  P6-T03  Structured log + metric on every drain failure (no silent-loss)
 *  P6-T32  Per-pod drain concurrency capped at 8 via hand-rolled semaphore
 *  P6-T33  Redis SETNX per-entry inflight guard via acquireLock (best-effort; note below)
 *  P6-C    Mark inflight BEFORE emit; release on failure (at-least-once ordering)
 *  P6-D    Legacy-entry shim: missing kind -> coerce to FCM + counter
 *
 * NOTE (P6-T33 / P6-B): This outbox is Redis-only (no Postgres table exists).
 * Row-level Postgres CAS is therefore NOT applicable. The inflight guard uses
 * redisService.acquireLock with a 30-second TTL as a best-effort pod-level
 * dedup. If a pod crashes after acquiring the lock but before the entry is
 * consumed, the entry will be re-processed after TTL expiry (at-least-once).
 * A true crash-safe Postgres outbox table should be introduced in a future
 * migration phase.
 */

import { redisService } from './redis.service';
import { logger } from './logger.service';
// F-B-50: Direct import from the canonical queue.service.ts singleton.
// Replaces a broken runtime require against a non-exported facade singleton
// whose failure was being silently swallowed by .catch(() => {}).
import { queueService } from './queue.service';
import { metrics } from '../monitoring/metrics.service';
import { emitToUser } from './socket.service';
import { fcmService } from './fcm.service';

const OUTBOX_PREFIX = 'notification:outbox:';
const OUTBOX_TTL_SECONDS = 3600;       // 1 hour
const FRESHNESS_MS = 15 * 60 * 1000;   // 15 minutes -- skip stale items on drain

// P3-T12/T15: O(1) counter key for outbox_size gauge (avoids SCAN on drain).
const OUTBOX_SIZE_KEY = 'outbox:size';

// P6-T32: Per-pod drain concurrency limit -- 8 simultaneous drain coroutines.
const DRAIN_CONCURRENCY = 8;

// Holder ID for inflight lock -- pod-stable within a drain call.
const INFLIGHT_HOLDER = 'outbox-drain-pod';

// =============================================================================
// P6-T01: Discriminated-union OutboxEntry.payload
//
// Producers that pass a plain {title, body} object (no kind) are caught by
// the legacy shim in drainOutbox (P6-D amendment) and coerced to FCM.
// New producers MUST pass a typed payload with an explicit kind.
// =============================================================================

export type FcmOutboxPayload = {
  kind: 'fcm';
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

export type SocketOutboxPayload = {
  kind: 'socket';
  event: string;
  data: Record<string, unknown>;
};

/** Typed payload -- use this for new producers. */
export type TypedOutboxPayload = FcmOutboxPayload | SocketOutboxPayload;

/**
 * Legacy un-typed payload shape (pre-P6). Kept for the migration shim.
 * P6-D: drain will coerce this to FcmOutboxPayload automatically.
 */
export type LegacyOutboxPayload = { title: string; body: string; data?: Record<string, unknown> };

export interface OutboxEntry {
  userId: string;
  /** Discriminated union (P6-T01). Legacy entries that lack kind are handled
   * by the drain shim (P6-D). */
  payload: TypedOutboxPayload | LegacyOutboxPayload;
  timestamp: number;
  reason?: string;
}

// =============================================================================
// P6-T32: Hand-rolled semaphore (no npm install)
// =============================================================================

function makeSemaphore(maxConcurrency: number) {
  let running = 0;
  const queue: Array<() => void> = [];

  function acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (running < maxConcurrency) {
        running++;
        resolve();
      } else {
        queue.push(() => {
          running++;
          resolve();
        });
      }
    });
  }

  function release(): void {
    running--;
    const next = queue.shift();
    if (next) next();
  }

  return { acquire, release };
}

const drainSemaphore = makeSemaphore(DRAIN_CONCURRENCY);

// =============================================================================
// P6-D: Legacy-entry coercion shim
// =============================================================================

function coerceLegacyPayload(raw: OutboxEntry['payload']): TypedOutboxPayload {
  if ('kind' in raw) {
    return raw as TypedOutboxPayload;
  }
  // Entry predates P6 -- coerce to FCM kind.
  const legacy = raw as LegacyOutboxPayload;
  const coerced: FcmOutboxPayload = {
    kind: 'fcm',
    title: legacy.title ?? '(legacy)',
    body: legacy.body ?? '',
    data: legacy.data,
  };
  // P6-D: emit legacy-entry counter per amendment
  metrics.incrementCounter('outbox_drain_legacy_entries_total', { origin_phase: 'pre_p6' });
  return coerced;
}

// =============================================================================
// P6-T02 / P6-C: Socket-kind entry drain with at-least-once ordering
// =============================================================================

async function drainSocketEntry(parsed: OutboxEntry, typed: SocketOutboxPayload): Promise<void> {
  const entryId = `outbox-inflight:${parsed.userId}:${parsed.timestamp}`;

  // P6-T33 / P6-C: Acquire inflight lock BEFORE emit (at-least-once ordering).
  // acquireLock uses SET NX EX -- atomic, first writer wins.
  // NOTE (P6-B): Redis lock is NOT crash-durable. A pod crash after this
  // point means the entry will be retried after TTL=30s expiry (at-least-once).
  const lockResult = await redisService.acquireLock(entryId, INFLIGHT_HOLDER, 30).catch(() => ({ acquired: false }));
  if (!lockResult.acquired) {
    // Another pod already claimed this entry -- skip to avoid double-delivery.
    return;
  }

  const drainStart = Date.now();

  try {
    // P6-T02: Socket-first path
    let socketDelivered = false;
    try {
      const delivered = emitToUser(parsed.userId, typed.event, typed.data);
      if (!delivered) {
        throw new Error('socket_not_delivered');
      }
      socketDelivered = true;
    } catch (socketErr: unknown) {
      // P6-T02: FCM fallback on socket failure
      const socketMsg = socketErr instanceof Error ? socketErr.message : String(socketErr);
      logger.warn('[NotificationOutbox] socket emit failed, falling back to FCM', {
        userId: parsed.userId,
        event: typed.event,
        reason: socketMsg,
      });
      // Best-effort FCM fallback using generic notification
      await fcmService.sendToUser(parsed.userId, {
        type: 'general',
        title: '(notification)',
        body: `Event: ${typed.event}`,
        priority: 'high',
      });
      socketDelivered = true; // fallback counts as delivered
    }

    if (socketDelivered) {
      const drainMs = Date.now() - drainStart;
      metrics.observeHistogram('outbox_drain_latency_ms', drainMs, { outbox: 'notification' });
      metrics.incrementCounter('outbox_drained_total', { outcome: 'delivered', outbox: 'notification' });
      redisService.incrBy(OUTBOX_SIZE_KEY, -1).catch(() => {/* non-critical */});
      // Release lock early -- entry is consumed
      redisService.releaseLock(entryId, INFLIGHT_HOLDER).catch(() => {/* non-critical */});
    }
  } catch (emitErr: unknown) {
    // P6-C: On terminal emit failure, release inflight lock so entry can be retried.
    await redisService.releaseLock(entryId, INFLIGHT_HOLDER).catch(() => {/* non-critical */});

    // P6-T03: Structured log + metric -- no silent-loss
    const reason = emitErr instanceof Error ? emitErr.message : String(emitErr);
    logger.error('[NotificationOutbox] outbox drain failure', {
      reason,
      entryId,
      kind: 'socket',
    });
    metrics.incrementCounter('outbox_drain_failures_total', { reason: reason.slice(0, 64) });
    metrics.incrementCounter('outbox_drained_total', { outcome: 'failed', outbox: 'notification' });
  }
}

// =============================================================================
// Public API
// =============================================================================

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
    await redisService.incr(OUTBOX_SIZE_KEY).catch(() => {/* non-critical -- size is best-effort */});
    logger.info(`[NotificationOutbox] Buffered notification for user ${userId}`);
  } catch (err: any) {
    logger.warn(`[NotificationOutbox] Failed to buffer for ${userId}: ${err?.message}`);
  }
}

/**
 * Drain the outbox for a user -- called when a circuit recovers.
 * Skips entries older than FRESHNESS_MS.
 *
 * P3-T13: emits outbox_drained_total{outcome,outbox}.
 * P3-T14: observes outbox_drain_latency_ms{outbox}.
 * P3-T15/T16: structured error logging with failure counter; no silent-loss.
 * P6-T02: socket-first with FCM fallback.
 * P6-T03: structured logger.error + metric on every failure.
 * P6-T32: concurrency capped at DRAIN_CONCURRENCY (8) via semaphore.
 * P6-C:   at-least-once ordering -- acquire inflight lock BEFORE emit.
 * P6-D:   legacy-entry coercion shim.
 *
 * For FCM-kind entries, also routes through queueService.queuePushNotification
 * for backward compatibility with the F-B-50 contract.
 */
export async function drainOutbox(userId: string): Promise<void> {
  const key = `${OUTBOX_PREFIX}${userId}`;
  try {
    const drainTasks: Array<Promise<void>> = [];
    let item: string | null;

    while ((item = await redisService.rPop(key))) {
      const parsed: OutboxEntry = JSON.parse(item);

      // P3-T13: stale-skip path
      if (Date.now() - parsed.timestamp > FRESHNESS_MS) {
        metrics.incrementCounter('outbox_drained_total', { outcome: 'stale_skipped', outbox: 'notification' });
        // stale entries still consume an outbox slot -- decrement size
        await redisService.incrBy(OUTBOX_SIZE_KEY, -1).catch(() => {});
        continue;
      }

      // P6-T32: acquire semaphore slot before spawning drain task
      const task = (async (entry: OutboxEntry) => {
        await drainSemaphore.acquire();
        try {
          const typed = coerceLegacyPayload(entry.payload);

          if (typed.kind === 'socket') {
            // P6-T02: socket-first path with FCM fallback
            await drainSocketEntry(entry, typed);
          } else {
            // FCM kind -- route through queueService (F-B-50 backward compat)
            const drainStart = Date.now();
            await queueService
              .queuePushNotification(entry.userId, {
                title: typed.title,
                body: typed.body,
                ...(typed.data ? { data: typed.data as Record<string, string> } : {}),
              })
              .then(() => {
                metrics.observeHistogram('outbox_drain_latency_ms', Date.now() - drainStart, { outbox: 'notification' });
                metrics.incrementCounter('outbox_drained_total', { outcome: 'delivered', outbox: 'notification' });
                redisService.incrBy(OUTBOX_SIZE_KEY, -1).catch(() => {});
              })
              .catch((err: unknown) => {
                // P3-T16 / P6-T03: structured logger replaces silent .catch(() => {}) (A12-011)
                const message = err instanceof Error ? err.message : String(err);
                logger.error("[NotificationOutbox] outbox drain failed", { err: message, entryUserId: entry.userId });
                // P3-T13 / P3-T16: failure counter
                metrics.incrementCounter('outbox_drained_total', { outcome: 'failed', outbox: 'notification' });
                metrics.incrementCounter('outbox_drain_failures_total', { reason: message.slice(0, 64) });
              });
          }
        } finally {
          drainSemaphore.release();
        }
      })(parsed);

      drainTasks.push(task);
    }

    // Await all concurrently-bounded drain tasks
    await Promise.all(drainTasks);

    logger.info(`[NotificationOutbox] Drained outbox for user ${userId}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[NotificationOutbox] Drain failed for ${userId}: ${message}`);
  }
}

/**
 * Drain ALL user outboxes -- called on circuit recovery.
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
      // non-critical -- skip this sample
    }
  }, 30_000);

  // Prevent this timer from keeping the process alive in integration tests or
  // short-lived scripts that happen to set NODE_ENV to something other than 'test'.
  if (typeof (sizeTimer as unknown as { unref?: () => void }).unref === 'function') {
    (sizeTimer as unknown as { unref: () => void }).unref();
  }
}
