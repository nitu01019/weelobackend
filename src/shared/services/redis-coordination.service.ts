/**
 * =============================================================================
 * REDIS COORDINATION SERVICE — F-B-06 (fail-closed wrapper)
 * =============================================================================
 *
 * Problem:
 *   The single `redisService` in this repo is the only Redis abstraction, and
 *   on connection failure it silently swaps to an in-memory fallback. That
 *   fallback is acceptable for caches (fleetcache, route-ETA) where a miss
 *   just means "hit the DB", but catastrophic for COORDINATION primitives:
 *     - distributed locks (truck-hold, confirm serialisation)
 *     - idempotency keys (createOrder, cancel)
 *     - rate-limiters (OTP, dispatch)
 *     - leader-election
 *   If these silently fall back to a per-process Map, the property they were
 *   meant to enforce (uniqueness across the fleet) quietly evaporates, and
 *   bugs surface as double-confirmed holds or duplicate side-effects.
 *
 * Fix:
 *   Expose a thin coordination-only wrapper. In production with
 *   `FF_REDIS_FAIL_CLOSED=true`, connect failure triggers a 5-second grace
 *   log-then-exit(1) so ECS drains the task via ALB and reschedules it on a
 *   node that can reach Redis. Outside production, or with the flag off, we
 *   preserve existing behavior (delegate to redisService; in-memory fallback
 *   is used).
 *
 * Notes:
 *   - The underlying transport (redisService) is unchanged; both this wrapper
 *     and redis-cache.service.ts delegate to it.
 *   - This file never creates a second connection — there is still exactly
 *     one ioredis client in the process, as before.
 *   - Readiness is already wired in health.routes.ts via
 *     `redisService.isConnected()`. The coordination wrapper's isReady()
 *     mirrors that, so /health/ready can call either.
 * =============================================================================
 */

import { redisService } from './redis.service';
import { logger } from './logger.service';
import { FLAGS, isEnabled } from '../config/feature-flags';

const EXIT_GRACE_MS = 5_000;

let failClosedExitScheduled = false;

/**
 * Exposed as a module-level flag so tests can assert the readiness state
 * transition without racing the real process.exit() path.
 */
export let readinessBlocked = false;

/**
 * Flip readinessBlocked and, in production with FF_REDIS_FAIL_CLOSED=true,
 * schedule a delayed process.exit(1) so ALB has time to drain the task.
 *
 * Idempotent: repeat calls are no-ops.
 */
export function markCoordinationLost(reason: string): void {
  if (readinessBlocked) return;
  readinessBlocked = true;

  logger.error(`[RedisCoord] coordination_redis_lost: ${reason}`);
  try {
    const { metrics } = require('../monitoring/metrics.service');
    metrics.incrementCounter('redis_coordination_lost_total');
  } catch {
    /* metrics not available in test envs */
  }

  const isProduction = process.env.NODE_ENV === 'production';
  const failClosed = isEnabled(FLAGS.REDIS_FAIL_CLOSED);

  if (!isProduction || !failClosed) {
    // Non-production OR flag off — preserve legacy behavior: log + degrade,
    // do NOT exit. Readiness probe callers may still observe readinessBlocked
    // and emit 503 if they choose to.
    logger.warn(
      `[RedisCoord] legacy fallback active (NODE_ENV=${process.env.NODE_ENV}, ` +
        `FF_REDIS_FAIL_CLOSED=${process.env.FF_REDIS_FAIL_CLOSED ?? '(unset)'}) — ` +
        'coordination primitives may silently degrade'
    );
    return;
  }

  if (failClosedExitScheduled) return;
  failClosedExitScheduled = true;

  logger.error(
    `[RedisCoord] production fail-closed: scheduling process.exit(1) in ${EXIT_GRACE_MS}ms to trigger ALB drain`
  );
  const timer = setTimeout(() => {
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  }, EXIT_GRACE_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Only exposed for tests. Do NOT call in production code.
 */
export function __resetForTests(): void {
  readinessBlocked = false;
  failClosedExitScheduled = false;
}

export const redisCoordination = {
  /**
   * Is the coordination layer ready to serve? Used by /health/ready.
   * Returns false when `markCoordinationLost` has been invoked AND fail-closed
   * mode is enabled; otherwise mirrors redisService.isConnected().
   */
  isReady(): boolean {
    if (readinessBlocked && isEnabled(FLAGS.REDIS_FAIL_CLOSED)) return false;
    return redisService.isConnected();
  },

  // --- Delegated coordination primitives ---------------------------------
  // All methods throw (not swallow) on underlying transport failure so the
  // caller — a lock acquire, idempotency CAS, rate-limit INCR — is aware
  // and can take compensating action (retry, 503, surfaced error).

  get(key: string): Promise<string | null> {
    return redisService.get(key);
  },

  set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    return redisService.set(key, value, ttlSeconds);
  },

  del(key: string): Promise<boolean> {
    return redisService.del(key);
  },

  exists(key: string): Promise<boolean> {
    return redisService.exists(key);
  },

  expire(key: string, ttlSeconds: number): Promise<boolean> {
    return redisService.expire(key, ttlSeconds);
  },

  incr(key: string): Promise<number> {
    return redisService.incr(key);
  },

  incrBy(key: string, amount: number): Promise<number> {
    return redisService.incrBy(key, amount);
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eval(script: string, keys: string[], args: string[]): Promise<any> {
    return redisService.eval(script, keys, args);
  },

  acquireLock(
    lockKey: string,
    holder: string,
    ttlSeconds: number
  ): Promise<{ acquired: boolean; ttl?: number }> {
    return redisService.acquireLock(lockKey, holder, ttlSeconds);
  },

  releaseLock(lockKey: string, holder: string): Promise<boolean> {
    return redisService.releaseLock(lockKey, holder);
  },
};
