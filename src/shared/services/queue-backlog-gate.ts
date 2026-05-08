/**
 * =============================================================================
 * A08a-006 — QUEUE BACKLOG CAPS (backpressure gate)
 * =============================================================================
 *
 * Enforces a per-queue depth ceiling on producer enqueues to protect
 * ElastiCache RAM (cache.r6g.xlarge ~26 GiB usable) and keep queue drain
 * latencies bounded. Warn at 80% of cap, reject at 100%.
 *
 * Flag-gated: OFF by default. When OFF, assertDepthUnderCap is a no-op and
 * legacy "accept unconditionally" behaviour is preserved.
 *
 * CAP SOURCES (derived from the Master Fix Plan 2026-04-23 Phase 4):
 *   HOLD_EXPIRY                   50_000  — expiry ticks are cheap but spiky
 *   ASSIGNMENT_RECONCILIATION     20_000  — 2-min cron tolerates backlog
 *   VEHICLE_RELEASE               10_000  — low rate, high-importance retries
 *   FCM_BATCH                    100_000  — bulk fanout tolerates deeper queue
 *   push                          50_000  — per-user push batches
 *
 * PERFORMANCE: We sum depth across priority lists + the delayed ZSET (~5
 * Redis reads worst-case per probe). A 100ms in-memory TTL cache absorbs
 * the 5K rps producer rate so Redis is hit at ~10 probes/s per task.
 *
 * See docs/ops/queue-caps.md for rollout, alarm thresholds, and the 7-day
 * observation protocol. See docs/ops/elasticache-capacity.md for the RAM
 * budget table.
 * =============================================================================
 */

import { FLAGS, isEnabled } from '../config/feature-flags';
import { redisService } from './redis.service';
import { metrics } from '../monitoring/metrics.service';
import { logger } from './logger.service';

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

/** Per-queue backlog ceiling (sum across priority lists + delayed ZSET). */
export const QUEUE_CAPS: Readonly<Record<string, number>> = Object.freeze({
  'hold-expiry': 50_000,
  'assignment-reconciliation': 20_000,
  'vehicle-release': 10_000,
  fcm_batch: 100_000,
  push: 50_000,
});

/**
 * ADR: A05-029 — per-queue backpressure policy with discriminated-union
 * decision. Replaces the implicit "throw for everything gated" semantic with
 * an explicit per-queue choice:
 *
 *   fail_loud   — caller catches BacklogCapExceededError and surfaces a 5xx
 *                  (correctness-critical queues only).
 *   silent_drop — caller receives `null` from `add(...)` and counts a metric;
 *                  the legacy nullable-return contract for 80+ silent-drop
 *                  callers is preserved (OAD-4).
 *
 * Critical queues fail loud so a backlog stall pages ops immediately.
 * Everything else stays silent so transient spikes don't cascade into a 5xx
 * storm on user-facing routes.
 */
export type BackpressureDecision =
  | { readonly action: 'proceed' }
  | { readonly action: 'silent_drop'; readonly reason: string }
  | { readonly action: 'fail_loud';   readonly error:  BacklogCapExceededError };

interface QueuePolicy { readonly cap: number; readonly failLoud: boolean; }

const QUEUE_POLICY: Readonly<Record<string, QueuePolicy>> = Object.freeze({
  'hold-expiry':                { cap: 50_000,  failLoud: true  },
  'vehicle-release':            { cap: 10_000,  failLoud: true  },
  'assignment-reconciliation':  { cap: 20_000,  failLoud: true  },
  fcm_batch:                    { cap: 100_000, failLoud: false },
  push:                         { cap: 50_000,  failLoud: false },
});

/**
 * Compute the policy decision for a given queue + observed depth without
 * throwing. Returns a discriminated union so callers can dispatch on the
 * outcome explicitly. Use `applyBackpressurePolicy` (below) when you also
 * want the depth probe + fail-open contract; use this lower-level helper
 * when you already have the depth in hand.
 */
export function decideBackpressure(queueName: string, depth: number): BackpressureDecision {
  const policy = QUEUE_POLICY[queueName];
  if (!policy) return { action: 'proceed' };
  if (depth < policy.cap) return { action: 'proceed' };
  if (policy.failLoud) {
    return { action: 'fail_loud', error: new BacklogCapExceededError(queueName) };
  }
  return { action: 'silent_drop', reason: `${queueName} at cap ${policy.cap}, depth ${depth}` };
}

/** Keys match the QueueService.QUEUES constants (literal queue names). */
const DEPTH_CACHE_TTL_MS = 100;
const WARN_THRESHOLD_FRACTION = 0.8;

// Priority suffix drain order — mirrors RedisQueue.PRIORITY_SUFFIXES so this
// helper does not need to reach into the class internals.
const PRIORITY_SUFFIXES: readonly string[] = [':critical', ':high', ':normal', ':low'];

// ---------------------------------------------------------------------------
// ERRORS
// ---------------------------------------------------------------------------

export class QueueBackpressureError extends Error {
  public readonly queue: string;
  constructor(queue: string) {
    super(`Queue ${queue} at capacity — rejected by backlog cap`);
    this.queue = queue;
    this.name = 'QueueBackpressureError';
  }
}

/**
 * W-2b A-6 / W-(-1) RED test 2 contract: distinct error type so RE-THROW
 * callers (per OAD-4 alternative semantics) can disambiguate from the
 * legacy `QueueBackpressureError` symbol. Subclasses `QueueBackpressureError`
 * so existing `instanceof QueueBackpressureError` checks at producer sites
 * (RedisQueue.add / InMemoryQueue.add) keep matching unchanged. Callers that
 * later opt into RE-THROW can `instanceof BacklogCapExceededError` to filter
 * specifically the backlog-cap path. Additive — no legacy throw site changes.
 */
export class BacklogCapExceededError extends QueueBackpressureError {
  constructor(queue: string) {
    super(queue);
    this.name = 'BacklogCapExceededError';
  }
}

// ---------------------------------------------------------------------------
// DEPTH PROBE (with 100ms TTL cache)
// ---------------------------------------------------------------------------

interface DepthSnapshot {
  depth: number;
  sampledAtMs: number;
}

const depthCache = new Map<string, DepthSnapshot>();
const depthInFlight = new Map<string, Promise<number>>();

/**
 * Sum of all priority lists + legacy list + delayed ZSET for a queue.
 *
 * Uses a 100ms TTL in-memory cache to absorb the 5K rps producer rate so
 * Redis is hit at most ~10 times/sec per task for each queue.
 */
export async function getAggregatedDepth(queueName: string): Promise<number> {
  const now = Date.now();
  const cached = depthCache.get(queueName);
  if (cached && now - cached.sampledAtMs < DEPTH_CACHE_TTL_MS) {
    return cached.depth;
  }

  const pending = depthInFlight.get(queueName);
  if (pending) {
    return pending;
  }

  const probe = (async () => {
    try {
      const legacyKey = `queue:${queueName}`;
      const delayedKey = `delayed:${queueName}`;
      const priorityKeys = PRIORITY_SUFFIXES.map((s) => `${legacyKey}${s}`);

      // lLen on 5 lists + zRangeByScore (-inf..+inf) for delayed count.
      const [legacyLen, ...priorityLens] = await Promise.all([
        redisService.lLen(legacyKey),
        ...priorityKeys.map((k) => redisService.lLen(k)),
      ]);

      // Delayed ZSET — approximate count via zRangeByScore(-inf, +inf).
      // Cheap because we discard the result array size only.
      let delayedLen = 0;
      try {
        const rows = await redisService.zRangeByScore(delayedKey, '-inf', '+inf');
        delayedLen = rows.length;
      } catch {
        // ignore — delayed ZSET may not exist in tests
      }

      const total =
        (legacyLen || 0) +
        priorityLens.reduce((s, n) => s + (n || 0), 0) +
        delayedLen;

      depthCache.set(queueName, { depth: total, sampledAtMs: Date.now() });
      return total;
    } finally {
      depthInFlight.delete(queueName);
    }
  })();

  depthInFlight.set(queueName, probe);
  return probe;
}

// ---------------------------------------------------------------------------
// GATE
// ---------------------------------------------------------------------------

/**
 * Assert that a queue has capacity for a new job. Throws
 * `QueueBackpressureError` when at/above the cap.
 *
 * - Flag OFF → no-op (legacy behaviour preserved).
 * - Flag ON + depth ≥ 80% cap → warn counter increments; still allowed.
 * - Flag ON + depth ≥ 100% cap → reject counter increments; throws.
 */
export async function assertDepthUnderCap(queueName: string): Promise<void> {
  if (!isEnabled(FLAGS.QUEUE_BACKLOG_CAPS)) return;
  const cap = QUEUE_CAPS[queueName];
  if (!cap) return; // queue is not gated

  // W-2b A-9 / delta A-07 (V8 R4) — fail-open on depth-probe failure.
  // A transient Redis blip during `getAggregatedDepth` (e.g. ECONNRESET on the
  // lLen probe) MUST NOT crash the producer or escalate to a backpressure
  // reject. Lost depth signal → allow the enqueue to proceed. WARN log +
  // `queue_depth_probe_failures_total` counter let operators alarm on probe
  // instability without blocking traffic. Reject counter is intentionally
  // NOT incremented because the cap was not actually exceeded — we just lost
  // the ability to measure it.
  let depth: number;
  try {
    depth = await getAggregatedDepth(queueName);
  } catch (probeErr: unknown) {
    const errMessage = probeErr instanceof Error ? probeErr.message : String(probeErr);
    try {
      logger.warn('[QueueBacklogGate] depth-probe failed — fail-open (enqueue allowed)', {
        queue: queueName, error: errMessage,
      });
    } catch { /* never break fail-open on a log write */ }
    try {
      metrics.incrementCounter('queue_depth_probe_failures_total', { queue: queueName });
    } catch { /* never break fail-open on a metric write */ }
    return;
  }

  if (depth >= cap) {
    try {
      metrics.incrementCounter('queue_backpressure_rejected_total', {
        queue: queueName,
      });
    } catch {
      /* never break the reject path on a metric write */
    }
    throw new QueueBackpressureError(queueName);
  }

  if (depth >= WARN_THRESHOLD_FRACTION * cap) {
    try {
      metrics.incrementCounter('queue_depth_warn_total', { queue: queueName });
    } catch {
      /* never break on metric write */
    }
  }
}

/**
 * Resolve the per-queue backpressure decision end-to-end:
 *   1. Flag OFF or queue not in QUEUE_CAPS → 'proceed'.
 *   2. Probe depth via `getAggregatedDepth`. On Redis blip / probe failure:
 *      fail-open with 'proceed' + a `queue_depth_probe_failures_total`
 *      counter. Lost depth signal must NOT crash the producer or escalate
 *      to a backpressure reject (W-2b A-9 contract).
 *   3. Otherwise return `decideBackpressure(queueName, depth)`.
 *
 * Public API for queue producers (InMemoryQueue.add / RedisQueue.add). The
 * caller dispatches on the discriminated union: 'silent_drop' returns null
 * (OAD-4 — preserves the 80+ legacy callers ignoring the return value);
 * 'fail_loud' throws `BacklogCapExceededError` so a correctness-critical
 * queue at cap pages ops instead of silently losing work.
 */
export async function applyBackpressurePolicy(queueName: string): Promise<BackpressureDecision> {
  if (!isEnabled(FLAGS.QUEUE_BACKLOG_CAPS)) return { action: 'proceed' };
  if (QUEUE_CAPS[queueName] === undefined) return { action: 'proceed' };

  let depth: number;
  try {
    depth = await getAggregatedDepth(queueName);
  } catch (probeErr: unknown) {
    const errMessage = probeErr instanceof Error ? probeErr.message : String(probeErr);
    try {
      logger.warn('[QueueBacklogGate] depth-probe failed — fail-open (enqueue allowed)', {
        queue: queueName, error: errMessage,
      });
    } catch { /* never break fail-open on a log write */ }
    try {
      metrics.incrementCounter('queue_depth_probe_failures_total', { queue: queueName });
    } catch { /* never break fail-open on a metric write */ }
    return { action: 'proceed' };
  }

  // Warn metric — same threshold as legacy assertDepthUnderCap.
  const cap = QUEUE_CAPS[queueName];
  if (cap !== undefined && depth >= WARN_THRESHOLD_FRACTION * cap) {
    try {
      metrics.incrementCounter('queue_depth_warn_total', { queue: queueName });
    } catch { /* never break on metric write */ }
  }

  return decideBackpressure(queueName, depth);
}

/** Test-only helper — clear the in-memory depth cache between cases. */
export function __resetDepthCacheForTests(): void {
  depthCache.clear();
  depthInFlight.clear();
}
