#!/usr/bin/env ts-node
/**
 * =============================================================================
 * Fix #36 — Timer ZSET eviction DLQ drainer (per-prefix ZSETs)
 * =============================================================================
 *
 * Leader-elected drainer that re-queues entries from the seven per-prefix
 * `dlq:timers:evicted:{<prefix>}` ZSETs (populated by the cap-overflow path
 * in `redisService.setTimer` Lua at `redis.service.ts:2644`/`:2859`) back into
 * their shard ZSETs via `redisService.setTimer`.
 *
 * Mirrors the pattern of `scripts/replay-broadcast-dlq.ts` — distinct lock key
 * `lock:timer-evictions:drainer:lock` so it never contends with the broadcast
 * DLQ drainer (`lock:dlq:drainer:lock`).
 *
 * Per-entry liveness check
 * ------------------------
 * Each ZSET member is the original timer key (e.g. `timer:order-broadcast-step:abc`).
 * On each tick we:
 *   1. ZRANGEBYSCORE -inf +inf LIMIT 0 BATCH on the per-prefix DLQ ZSET.
 *   2. GET the timer key to read its payload (`{data, expiresAt, createdAt}`).
 *   3. If GET returns non-null AND `expiresAt > now` → re-queue via
 *      `redisService.setTimer` (alive timer was prematurely evicted by the
 *       10K cap; restore it). outcome=requeued.
 *   4. If GET returns null OR expiresAt has passed → drop. outcome=discarded.
 *   5. If `setTimer` throws → leave entry in ZSET (next tick retries).
 *      outcome=requeue_failed.
 *   6. ZREM after every requeued/discarded outcome (idempotent — never
 *      ZREMRANGEBYSCORE, since that would discard items we may not have
 *      handled yet within the batch).
 *
 * Usage:
 *   ts-node scripts/replay-timer-evictions.ts                  # single pass
 *   ts-node scripts/replay-timer-evictions.ts --daemon         # 30s loop
 *   ts-node scripts/replay-timer-evictions.ts --max-iterations=500
 *
 * =============================================================================
 */

import { randomUUID } from 'crypto';
import { redisService } from '../src/shared/services/redis.service';
import { logger } from '../src/shared/services/logger.service';
import { metrics } from '../src/shared/monitoring/metrics.service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The seven prefix tags that match `TIMER_PREFIX_TO_SHARD` at
// `src/shared/services/redis.service.ts:1834-1846`. Listed explicitly here so
// that adding a new prefix is a deliberate two-file change, not silent drift.
const TIMER_DLQ_PREFIX_TAGS: readonly string[] = [
  'order-expiry',
  'order-broadcast-step',
  'assignment-timeout',
  'booking-order',
  'booking',
  'radius',
  'rating-reminder',
] as const;

// Distinct lock namespace from broadcast drainer (`lock:dlq:drainer:lock`).
// `acquireLock` already prepends `lock:`; final Redis key is
// `lock:timer-evictions:drainer:lock`.
const DRAINER_LOCK_KEY = 'timer-evictions:drainer:lock';
const DRAINER_LOCK_TTL_SECONDS = 60;

const DEFAULT_MAX_ITERATIONS = 1000;
const DEFAULT_DAEMON_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 100;

function envInt(name: string, fallback: number, min = 1): number {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

const DAEMON_INTERVAL_MS = envInt('TIMER_DLQ_DRAIN_INTERVAL_MS', DEFAULT_DAEMON_INTERVAL_MS, 1_000);
const BATCH_SIZE = envInt('TIMER_DLQ_DRAIN_BATCH_SIZE', DEFAULT_BATCH_SIZE);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Payload shape produced by `redisService.setTimer` at
 * `src/shared/services/redis.service.ts:2617-2625`.  Only the fields we need
 * for replay decisions are typed.
 */
interface TimerPayload {
  data: unknown;
  expiresAt: string;
  createdAt?: string;
}

export type DrainOutcome = 'requeued' | 'discarded' | 'requeue_failed';

export interface DrainOptions {
  readonly maxIterations?: number;
  readonly holderId?: string;
  readonly batchSize?: number;
}

export interface DrainResult {
  readonly acquiredLeader: boolean;
  readonly requeued: number;
  readonly discarded: number;
  readonly requeueFailed: number;
  readonly remainingByPrefix: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Per-prefix drain
// ---------------------------------------------------------------------------

/**
 * Drain a single per-prefix DLQ ZSET. Returns counts per outcome.
 *
 * Pulls up to `batchSize` members via ZRANGEBYSCORE, processes each, and ZREMs
 * handled members one at a time so that a crash mid-batch leaves unhandled
 * entries in place (idempotent recovery on next tick).
 */
async function drainPrefix(
  prefixTag: string,
  batchSize: number
): Promise<{ requeued: number; discarded: number; requeueFailed: number }> {
  const dlqKey = `dlq:timers:evicted:{${prefixTag}}`;
  let requeued = 0;
  let discarded = 0;
  let requeueFailed = 0;

  // ZRANGEBYSCORE LIMIT bounds at Redis side (avoids loading entire DLQ into
  // memory when overflow is sustained). Members returned in score order so
  // earliest-due entries replay first.
  const membersRaw = await redisService
    .eval(
      `return redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', '+inf', 'LIMIT', 0, tonumber(ARGV[1]))`,
      [dlqKey],
      [String(batchSize)]
    )
    .catch((err: unknown) => {
      logger.warn('[TimerDLQ-Drainer] ZRANGEBYSCORE failed — skipping prefix', {
        prefixTag,
        err: err instanceof Error ? err.message : String(err),
      });
      return [] as unknown;
    });
  const members = Array.isArray(membersRaw) ? (membersRaw as string[]) : [];

  if (members.length === 0) {
    return { requeued, discarded, requeueFailed };
  }

  const batch = members;
  const now = Date.now();

  for (const timerKey of batch) {
    const outcome = await processEntry(timerKey, now);

    if (outcome === 'requeued') {
      requeued++;
    } else if (outcome === 'discarded') {
      discarded++;
    } else {
      requeueFailed++;
    }

    metrics.incrementCounter('timer_dlq_drained_total', {
      prefix: prefixTag,
      outcome,
    });

    // ZREM the member only on terminal outcomes (requeued/discarded). For
    // `requeue_failed` we leave the entry so the next tick retries — the
    // 7-day EXPIRE on the DLQ ZSET (set by the eviction Lua at
    // redis.service.ts:2644 + :2859) caps total dwell time even if a poison
    // entry never recovers.
    if (outcome === 'requeued' || outcome === 'discarded') {
      // Single-element ZREM via Lua so the operation is atomic per member;
      // the public `redisService` API does not expose `zRem` directly.
      await redisService
        .eval("return redis.call('ZREM', KEYS[1], ARGV[1])", [dlqKey], [timerKey])
        .catch((err: unknown) => {
          logger.warn('[TimerDLQ-Drainer] ZREM failed — entry will retry next tick', {
            prefixTag,
            timerKey,
            err: err instanceof Error ? err.message : String(err),
          });
        });
    }
  }

  return { requeued, discarded, requeueFailed };
}

/**
 * Decide the fate of a single evicted timer.
 *
 * - GET returns null OR JSON parse fails OR expiresAt has passed → discard.
 * - expiresAt is still in the future → requeue via redisService.setTimer.
 * - setTimer throws → requeue_failed (leave entry for next tick).
 */
async function processEntry(timerKey: string, nowMs: number): Promise<DrainOutcome> {
  const raw = await redisService.get(timerKey).catch(() => null);
  if (!raw) return 'discarded';

  let parsed: TimerPayload;
  try {
    parsed = JSON.parse(raw) as TimerPayload;
  } catch {
    return 'discarded';
  }

  if (!parsed || typeof parsed.expiresAt !== 'string') {
    return 'discarded';
  }

  const expiresAtMs = new Date(parsed.expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    return 'discarded';
  }

  try {
    await redisService.setTimer(timerKey, parsed.data, new Date(expiresAtMs));
    logger.info('[TimerDLQ-Drainer] Re-queued evicted timer', {
      timerKey,
      expiresAt: parsed.expiresAt,
    });
    return 'requeued';
  } catch (err: unknown) {
    logger.warn('[TimerDLQ-Drainer] setTimer failed — leaving entry for retry', {
      timerKey,
      err: err instanceof Error ? err.message : String(err),
    });
    return 'requeue_failed';
  }
}

// ---------------------------------------------------------------------------
// Single-pass drain (across all 7 prefixes)
// ---------------------------------------------------------------------------

export async function drain(opts: DrainOptions = {}): Promise<DrainResult> {
  const holderId = opts.holderId ?? randomUUID();
  const batchSize = Math.max(1, opts.batchSize ?? BATCH_SIZE);
  // `maxIterations` is interpreted as a per-prefix cap — same semantics as
  // the broadcast drainer's bound on a single pass.
  const perPrefixCap = Math.max(1, opts.maxIterations ?? DEFAULT_MAX_ITERATIONS);
  const effectiveBatch = Math.min(batchSize, perPrefixCap);

  const lock = await redisService.acquireLock(DRAINER_LOCK_KEY, holderId, DRAINER_LOCK_TTL_SECONDS);
  if (!lock.acquired) {
    logger.info('[TimerDLQ-Drainer] Peer is leader — exiting gracefully');
    return {
      acquiredLeader: false,
      requeued: 0,
      discarded: 0,
      requeueFailed: 0,
      remainingByPrefix: {},
    };
  }

  let totalRequeued = 0;
  let totalDiscarded = 0;
  let totalRequeueFailed = 0;
  const remainingByPrefix: Record<string, number> = {};

  try {
    for (const prefixTag of TIMER_DLQ_PREFIX_TAGS) {
      const counts = await drainPrefix(prefixTag, effectiveBatch);
      totalRequeued += counts.requeued;
      totalDiscarded += counts.discarded;
      totalRequeueFailed += counts.requeueFailed;

      // Sample remaining depth via ZCARD (O(1)) for ops dashboards.
      const remaining = await redisService
        .eval(
          `return redis.call('ZCARD', KEYS[1])`,
          [`dlq:timers:evicted:{${prefixTag}}`],
          []
        )
        .then((n) => (typeof n === 'number' ? n : Number(n ?? -1)))
        .catch(() => -1);
      remainingByPrefix[prefixTag] = remaining;
    }

    logger.info('[TimerDLQ-Drainer] Pass complete', {
      requeued: totalRequeued,
      discarded: totalDiscarded,
      requeueFailed: totalRequeueFailed,
      remainingByPrefix,
      holderId,
    });

    return {
      acquiredLeader: true,
      requeued: totalRequeued,
      discarded: totalDiscarded,
      requeueFailed: totalRequeueFailed,
      remainingByPrefix,
    };
  } finally {
    await redisService.releaseLock(DRAINER_LOCK_KEY, holderId).catch((err: unknown) => {
      logger.warn('[TimerDLQ-Drainer] Failed to release lock — relying on TTL', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Daemon mode (setInterval with .unref())
// ---------------------------------------------------------------------------

export function startDaemon(opts: DrainOptions = {}): () => void {
  const intervalHandle = setInterval(() => {
    drain(opts).catch((err: unknown) => {
      logger.error('[TimerDLQ-Drainer] Daemon tick failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }, DAEMON_INTERVAL_MS);
  intervalHandle.unref();

  logger.info(`[TimerDLQ-Drainer] Daemon started — tick=${DAEMON_INTERVAL_MS}ms, batch=${BATCH_SIZE}`);

  return () => {
    clearInterval(intervalHandle);
    logger.info('[TimerDLQ-Drainer] Daemon stopped');
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { daemon: boolean; maxIterations: number } {
  let daemon = false;
  let maxIterations = DEFAULT_MAX_ITERATIONS;
  for (const arg of argv) {
    if (arg === '--daemon') {
      daemon = true;
    } else if (arg.startsWith('--max-iterations=')) {
      const parsed = parseInt(arg.split('=')[1] || '', 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxIterations = parsed;
      }
    }
  }
  return { daemon, maxIterations };
}

if (require.main === module) {
  const { daemon, maxIterations } = parseArgs(process.argv.slice(2));

  if (daemon) {
    const stop = startDaemon({ maxIterations });
    const shutdown = (signal: string) => {
      logger.info(`[TimerDLQ-Drainer] Received ${signal} — shutting down`);
      stop();
      process.exit(0);
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
    setInterval(() => { /* keepalive */ }, 1 << 30);
  } else {
    drain({ maxIterations })
      .then((result) => {
        logger.info('[TimerDLQ-Drainer] CLI single-pass complete', { ...result });
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error('[TimerDLQ-Drainer] CLI run failed', {
          err: err instanceof Error ? err.message : String(err),
        });
        process.exit(1);
      });
  }
}
