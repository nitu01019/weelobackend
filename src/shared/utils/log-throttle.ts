/**
 * =============================================================================
 * LOG THROTTLE — hot-path error log rate-limiting (Fix #18, Phase 6, 2026-05-14)
 * =============================================================================
 *
 * Per-key rate-limited / deduplicated log emitter for Redis-down and similar
 * flood scenarios. At 300 RPS a 5s Redis blip used to emit ~1500 identical
 * `[RateLimit] Redis error, denying request for safety` lines to CloudWatch;
 * this collapses those to ≤1 emission per windowMs (default 10s) per stable
 * key, with a tail `suppressedCount` so the volume signal is preserved.
 *
 * Design notes:
 *   - Factory + DI clock so each test gets a fresh Map (no module-scope state
 *     leak; jest.resetModules() not required).
 *   - Bounded `MAX_KEYS = 256` Map: LRU re-insertion + eviction protects
 *     against `redis_down:${transporterId}` dynamic-key OOM (43M entries/day
 *     at 500 RPS × 86400s ≈ 4.1GB heap on m6i.large).
 *   - NODE_ENV opt-in dev-throw: only `development` / `test` throw on
 *     dynamic-key misuse; production / staging / unset NODE_ENV silently
 *     evict + emit a counter so misuse is observable in misconfigured ECS
 *     containers without crashing the pod.
 *   - Imports `logger` from logger.service.ts and `metrics` from
 *     metrics.service.ts. logger.service.ts intentionally does NOT re-export
 *     anything from this file — that would form a
 *     logger → log-throttle → metrics → logger cycle. Callers import directly
 *     from this utility.
 * =============================================================================
 */

import { logger } from '../services/logger.service';
import { metrics as metricsService } from '../monitoring/metrics.service';

export interface ThrottleLogger {
  error: (message: string, meta?: Record<string, unknown>) => void;
}

export interface ThrottleDeps {
  now: () => number;
  logger: ThrottleLogger;
}

export type LogErrorThrottled = (
  key: string,
  message: string,
  meta?: Record<string, unknown>,
  windowMs?: number,
) => void;

const MAX_KEYS = 256;
const DEFAULT_WINDOW_MS = 10_000;

export function createLogThrottle(deps: ThrottleDeps): LogErrorThrottled {
  const lastEmit = new Map<string, number>();
  const suppressed = new Map<string, number>();

  function touch(key: string, t: number): void {
    // LRU re-insertion: Map iteration order is insertion order (ES2015).
    lastEmit.delete(key);
    lastEmit.set(key, t);
  }

  function evictOldest(): void {
    const firstKey = lastEmit.keys().next().value;
    if (firstKey !== undefined) {
      lastEmit.delete(firstKey);
      suppressed.delete(firstKey);
    }
  }

  return function logErrorThrottled(
    key: string,
    message: string,
    meta: Record<string, unknown> = {},
    windowMs: number = DEFAULT_WINDOW_MS,
  ): void {
    // Dynamic-key misuse guard (OPT-IN dev-throw for ECS misconfigs).
    if (lastEmit.size >= MAX_KEYS && !lastEmit.has(key)) {
      const env = process.env.NODE_ENV;
      if (env === 'development' || env === 'test') {
        throw new Error(
          `logErrorThrottled: too many distinct keys (${lastEmit.size} >= ${MAX_KEYS}). ` +
            `Did you pass a dynamic key like '${key}'? Use a stable identifier.`,
        );
      }
      // Production / staging / unset NODE_ENV: drop oldest + emit metric.
      try {
        metricsService.incrementCounter('log_throttle_keyspace_full_total', {
          drop_key_prefix: key.split(':')[0] || 'unknown',
        });
      } catch {
        /* metrics best-effort — never break the tick on a metric write */
      }
      evictOldest();
      // fall through and accept the new key after eviction
    }

    const t = deps.now();
    const last = lastEmit.get(key);

    if (last !== undefined && t - last < windowMs) {
      suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
      try {
        metricsService.incrementCounter('log_throttle_suppressed_total', { key });
      } catch {
        /* metrics best-effort — never break the tick on a metric write */
      }
      return;
    }

    const drop = suppressed.get(key) ?? 0;
    suppressed.delete(key);
    touch(key, t);

    deps.logger.error(message, {
      ...meta,
      throttleKey: key,
      suppressedCount: drop,
      throttleWindowMs: windowMs,
    });
  };
}

/**
 * Production singleton. Callers import `logErrorThrottled` directly from this
 * file (NOT re-exported via logger.service.ts to avoid the circular-import
 * loop logger → log-throttle → metrics → logger).
 */
export const logErrorThrottled: LogErrorThrottled = createLogThrottle({
  now: Date.now,
  logger,
});
