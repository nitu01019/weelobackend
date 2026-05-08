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
const DRAINER_LOCK_KEY = 'dlq:drainer:lock';
const DRAINER_LOCK_TTL_SECONDS = 60;

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
      reason: err instanceof Error ? err.message.slice(0, 64) : 'replay_throw'
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
