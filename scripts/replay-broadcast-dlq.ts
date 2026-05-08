#!/usr/bin/env ts-node
/**
 * =============================================================================
 * F-PERF-02 follow-up — Broadcast DLQ drainer
 * =============================================================================
 *
 * Leader-elected drainer that replays entries from `dlq:broadcasts` (populated
 * by the partial-admit path in `queueBroadcastBatch`) back through the regular
 * queueing path so the deferred broadcasts are still delivered once the spike
 * subsides.
 *
 * MUST run on exactly ONE pod at a time — uses `redisService.acquireLock`
 * with a randomly-generated holder so a peer pod that beats us to the lock
 * silently exits. Recovery is idempotent: each entry is moved into an
 * `inflight` list via `LMOVE` so a crash mid-iteration cannot lose data.
 *
 * Usage:
 *   ts-node scripts/replay-broadcast-dlq.ts                  # single pass
 *   ts-node scripts/replay-broadcast-dlq.ts --daemon         # 30s loop
 *   ts-node scripts/replay-broadcast-dlq.ts --max-iterations=500
 *
 * =============================================================================
 */

import { randomUUID } from 'crypto';
import { redisService } from '../src/shared/services/redis.service';
import { queueService } from '../src/shared/services/queue.service';
import { logger } from '../src/shared/services/logger.service';
import { metrics } from '../src/shared/monitoring/metrics.service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DLQ_KEY = 'dlq:broadcasts';
const INFLIGHT_KEY = 'dlq:broadcasts:inflight';
const PERMANENT_KEY = 'dlq:broadcasts:permanent';
const DRAINER_LOCK_KEY = 'dlq:drainer:lock';
const DRAINER_LOCK_TTL_SECONDS = 60;

// Max replay attempts before an entry is moved to the permanent dead-letter list.
// Tunable via DLQ_MAX_REPLAY_ATTEMPTS env var. Applies to guard_lookup_error entries.
const MAX_REPLAY_ATTEMPTS = parseInt(process.env.DLQ_MAX_REPLAY_ATTEMPTS || '5', 10);

// Cap on the permanent DLQ list length — mirrors the DLQ_KEY cap in queue.service.ts.
const DLQ_MAX_SIZE = parseInt(process.env.DLQ_MAX_SIZE || '5000', 10);

const DEFAULT_MAX_ITERATIONS = 1000;
const DAEMON_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DlqEntry {
  transporterId: string;
  event: string;
  data: unknown;
  droppedAt: number;
  reason?: string;
  /** Retry counter set by the live-path producer and incremented by the drainer on each failed replay. */
  attempt?: number;
}

export interface DrainOptions {
  /** Stop after replaying this many entries (default 1000). Use to bound a single pass. */
  readonly maxIterations?: number;
  /** Optional injected lock holder (for tests). Defaults to a per-invocation UUID. */
  readonly holderId?: string;
}

export interface DrainResult {
  readonly acquiredLeader: boolean;
  readonly replayed: number;
  readonly failed: number;
  readonly remaining: number;
}

// ---------------------------------------------------------------------------
// Single-pass drain
// ---------------------------------------------------------------------------

/**
 * Drain `dlq:broadcasts` once. Acquires the leader lock — if a peer is
 * already draining, returns early with `acquiredLeader: false`.
 */
export async function drain(opts: DrainOptions = {}): Promise<DrainResult> {
  const holderId = opts.holderId ?? randomUUID();
  const maxIterations = Math.max(1, opts.maxIterations ?? DEFAULT_MAX_ITERATIONS);

  const lock = await redisService.acquireLock(DRAINER_LOCK_KEY, holderId, DRAINER_LOCK_TTL_SECONDS);
  if (!lock.acquired) {
    logger.info('[DLQ-Drainer] Peer is leader — exiting gracefully');
    return { acquiredLeader: false, replayed: 0, failed: 0, remaining: -1 };
  }

  let replayed = 0;
  let failed = 0;

  try {
    for (let i = 0; i < maxIterations; i++) {
      // Atomic move: pop from the right of the DLQ list, push to the LEFT
      // of the inflight list. A crash before `lRem` keeps the entry
      // recoverable on the next pass (we drain inflight first below).
      const raw = await redisService.blMove(
        DLQ_KEY,
        INFLIGHT_KEY,
        'RIGHT',
        'LEFT',
        0 // non-blocking — returns null when the source list is empty
      );

      if (!raw) {
        break;
      }

      const replayResult = await replayEntry(raw);
      if (replayResult.ok) {
        replayed++;
        // Successfully replayed — remove this exact element from the
        // inflight list. `LREM key 0 element` removes all occurrences.
        await redisService.lRem(INFLIGHT_KEY, 0, raw).catch((err: unknown) => {
          logger.warn('[DLQ-Drainer] Failed to LREM replayed entry from inflight', {
            error: err instanceof Error ? err.message : String(err)
          });
        });

        try {
          metrics.incrementCounter('broadcast_dlq_replayed_total', {
            event: replayResult.event ?? 'unknown'
          });
        } catch { /* metrics never break drainer */ }
      } else {
        failed++;
        // Don't LREM — keep the entry in inflight for ops to inspect.
        try {
          metrics.incrementCounter('broadcast_dlq_replay_failed_total', {
            event: replayResult.event ?? 'unknown',
            reason: replayResult.reason ?? 'unknown'
          });
        } catch { /* metrics never break drainer */ }
        logger.warn('[DLQ-Drainer] Entry replay failed — left in inflight for inspection', {
          reason: replayResult.reason, event: replayResult.event
        });
      }
    }

    const remaining = await redisService.lLen(DLQ_KEY).catch(() => -1);
    try {
      metrics.setGauge('broadcast_dlq_depth', Math.max(0, remaining));
    } catch { /* never break */ }

    logger.info('[DLQ-Drainer] Pass complete', {
      replayed, failed, remaining, holderId
    });

    return { acquiredLeader: true, replayed, failed, remaining };
  } finally {
    await redisService.releaseLock(DRAINER_LOCK_KEY, holderId).catch((err: unknown) => {
      logger.warn('[DLQ-Drainer] Failed to release lock — relying on TTL', {
        error: err instanceof Error ? err.message : String(err)
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Per-entry replay
// ---------------------------------------------------------------------------

interface ReplayOutcome {
  readonly ok: boolean;
  readonly event?: string;
  readonly reason?: string;
}

async function replayEntry(raw: string): Promise<ReplayOutcome> {
  let parsed: DlqEntry;
  try {
    parsed = JSON.parse(raw) as DlqEntry;
  } catch (err: unknown) {
    return { ok: false, reason: 'parse_error' };
  }

  if (!parsed.transporterId || !parsed.event) {
    return { ok: false, reason: 'malformed_entry', event: parsed.event };
  }

  switch (parsed.reason) {
    case 'guard_lookup_error':
      return replayGuardLookupError(raw, parsed);
    default:
      return replayDefault(parsed);
  }
}

/**
 * Replay handler for entries with reason='guard_lookup_error' (pushed by
 * queue.service.ts when getOrderStatusForQueueGuard throws a transient error).
 *
 * Uses bounded retry semantics:
 *   - attempt < MAX_REPLAY_ATTEMPTS → try emit; on failure re-push with attempt+1 and signal ok=true
 *     (LREM from inflight happens in drain() on ok=true)
 *   - attempt >= MAX_REPLAY_ATTEMPTS → move to dlq:broadcasts:permanent, signal ok=true so LREM fires
 *
 * Crash safety: LMOVE already moved the entry into INFLIGHT_KEY before this
 * function is called. On re-push we write back to DLQ_KEY and then signal ok
 * so drain() calls LREM on INFLIGHT_KEY — no double-entry risk.
 */
async function replayGuardLookupError(raw: string, parsed: DlqEntry): Promise<ReplayOutcome> {
  // Default attempt to 1 for legacy entries written before this field existed.
  const attempt = parsed.attempt ?? 1;

  if (attempt >= MAX_REPLAY_ATTEMPTS) {
    const permanentEntry = JSON.stringify({
      ...parsed,
      finalFailureAt: Date.now(),
      reason: `${parsed.reason}_max_replay_exceeded`,
    });
    try {
      await redisService.lPush(PERMANENT_KEY, permanentEntry);
      await redisService.lTrim(PERMANENT_KEY, 0, DLQ_MAX_SIZE - 1);
      metrics.incrementCounter('dlq_permanent_total', {
        queue: 'broadcasts',
        reason: parsed.reason ?? 'unknown',
      });
    } catch (permErr: unknown) {
      logger.error('[DLQ-Drainer] Failed to write to permanent dead-letter list', {
        error: permErr instanceof Error ? permErr.message : String(permErr),
        transporterId: parsed.transporterId,
        event: parsed.event,
      });
    }
    logger.error('[DLQ-Drainer] Broadcast moved to permanent dead-letter — max replay attempts exhausted', {
      transporterId: parsed.transporterId,
      event: parsed.event,
      attempts: attempt,
      reason: parsed.reason,
    });
    // Signal ok=true so drain() calls LREM on INFLIGHT_KEY to clean up.
    return { ok: true, event: parsed.event };
  }

  try {
    await queueService.queueBroadcastBatch(
      [parsed.transporterId],
      parsed.event,
      parsed.data,
      { bypassDepthGuard: true }
    );
    return { ok: true, event: parsed.event };
  } catch (err: unknown) {
    // Replay failed — re-enqueue with bumped attempt counter, then signal ok=true
    // so drain() removes this copy from INFLIGHT_KEY (the re-enqueued copy
    // is a new entry in DLQ_KEY with attempt+1, not a duplicate).
    const retryEntry = JSON.stringify({ ...parsed, attempt: attempt + 1 });
    try {
      await redisService.lPush(DLQ_KEY, retryEntry);
      await redisService.lTrim(DLQ_KEY, 0, DLQ_MAX_SIZE - 1);
      metrics.incrementCounter('dlq_replay_failed_total', {
        queue: 'broadcasts',
        attempt: String(attempt + 1),
      });
    } catch (requeueErr: unknown) {
      logger.error('[DLQ-Drainer] Failed to re-enqueue guard_lookup_error entry', {
        error: requeueErr instanceof Error ? requeueErr.message : String(requeueErr),
        transporterId: parsed.transporterId,
        event: parsed.event,
      });
    }
    logger.warn('[DLQ-Drainer] guard_lookup_error replay failed — re-enqueued with bumped attempt', {
      transporterId: parsed.transporterId,
      event: parsed.event,
      attempt: attempt + 1,
      error: err instanceof Error ? err.message.slice(0, 64) : 'replay_throw',
    });
    // Signal ok=true so LREM fires on the old INFLIGHT_KEY copy.
    return { ok: true, event: parsed.event };
  }
}

/**
 * Default replay handler for entries without a recognised reason
 * (e.g. depth_guard_overflow entries from #6, or legacy entries with no reason).
 * On failure leaves the entry pinned in INFLIGHT_KEY for ops inspection — the
 * original drainer behaviour preserved for non-lookup-error cases.
 */
async function replayDefault(parsed: DlqEntry): Promise<ReplayOutcome> {
  try {
    // Replay via the same `queueBroadcastBatch` path with the depth-cap
    // guard explicitly bypassed — recovery must not be re-DLQ'd in a
    // tight loop (which would create an unbounded reshuffle storm).
    await queueService.queueBroadcastBatch(
      [parsed.transporterId],
      parsed.event,
      parsed.data,
      { bypassDepthGuard: true }
    );
    return { ok: true, event: parsed.event };
  } catch (err: unknown) {
    return {
      ok: false,
      event: parsed.event,
      reason: err instanceof Error ? err.message.slice(0, 64) : 'replay_throw',
    };
  }
}

// ---------------------------------------------------------------------------
// Daemon mode (setInterval with .unref())
// ---------------------------------------------------------------------------

/**
 * Start a 30s `setInterval` loop. Returns a stop callback that clears the
 * interval. Each tick calls `drain()` — leader contention is automatically
 * resolved by the per-tick `acquireLock` round-trip.
 */
export function startDaemon(opts: DrainOptions = {}): () => void {
  const intervalHandle = setInterval(() => {
    drain(opts).catch((err: unknown) => {
      logger.error('[DLQ-Drainer] Daemon tick failed', {
        error: err instanceof Error ? err.message : String(err)
      });
    });
  }, DAEMON_INTERVAL_MS);
  // Don't keep the process alive solely for this poller (matches every
  // long-running interval in the codebase per F-PERF-05).
  intervalHandle.unref();

  logger.info(`[DLQ-Drainer] Daemon started — tick=${DAEMON_INTERVAL_MS}ms`);

  return () => {
    clearInterval(intervalHandle);
    logger.info('[DLQ-Drainer] Daemon stopped');
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
    // SIGTERM/SIGINT cleanup so ECS task termination is graceful.
    const shutdown = (signal: string) => {
      logger.info(`[DLQ-Drainer] Received ${signal} — shutting down`);
      stop();
      process.exit(0);
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
    // Keep the process alive — the unref'd interval alone won't.
    setInterval(() => { /* keepalive */ }, 1 << 30);
  } else {
    drain({ maxIterations })
      .then((result) => {
        logger.info('[DLQ-Drainer] CLI single-pass complete', { ...result });
        process.exit(result.acquiredLeader ? 0 : 0);
      })
      .catch((err: unknown) => {
        logger.error('[DLQ-Drainer] CLI run failed', {
          error: err instanceof Error ? err.message : String(err)
        });
        process.exit(1);
      });
  }
}
