/**
 * =============================================================================
 * LEADER ELECTION HELPER (F-A-56)
 * =============================================================================
 *
 * Distributed leader-election primitive used by sweepers/pollers that must
 * run on exactly one ECS instance (e.g., order-dispatch-outbox poller,
 * smart-timeout sweeper).
 *
 * API:
 *   acquireLeader(key, instanceId, ttl)  — fresh acquisition (SET NX EX).
 *   renewLeader(key, instanceId, ttl)    — atomic CAS renewal: only the
 *                                           current owner's renew succeeds.
 *                                           Prevents the "blind SET stomps a
 *                                           new leader" bug (F-A-56).
 *   startHeartbeat(...)                  — setInterval wrapper with .unref()
 *                                           and safe error handling.
 *
 * Why CAS matters:
 *   The pre-fix code at order-dispatch-outbox.service.ts:494 called
 *     redisService.set(OUTBOX_LEADER_KEY, instanceId, OUTBOX_LEADER_TTL)
 *   after each batch — a blind write. If the leader GC-paused past the TTL
 *   and a new leader legitimately took over, the blind set silently stomped
 *   the new leader → two pollers process the same rows → duplicate emits.
 *
 * Industry match: Redis Redlock safety rules + Martin Kleppmann "How to do
 * distributed locking" (fencing tokens + CAS renewal).
 * =============================================================================
 */

import { redisService } from './redis.service';
import { logger } from './logger.service';
import { metrics } from '../monitoring/metrics.service';

/**
 * Atomic CAS renewal script. Run as EVAL because Redis guarantees the
 * entire script runs without interleaving with any other client command.
 *
 *   KEYS[1] = leader-election key (e.g., 'outbox:leader')
 *   ARGV[1] = our instanceId — MUST equal the current stored value
 *   ARGV[2] = new TTL in seconds
 *
 * Returns 1 on successful renewal, 0 if someone else owns the key (or no
 * owner at all — the key expired silently).
 */
export const LEADER_RENEW_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]); return 1 else return 0 end`;

/**
 * Attempt to become leader for `key`.
 *
 * Uses SET NX EX semantics: succeeds only if no current owner holds the
 * lease. Returns false when another instance already owns it.
 */
export async function acquireLeader(
  key: string,
  instanceId: string,
  ttlSeconds: number
): Promise<boolean> {
  if (!key || !instanceId || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('acquireLeader: invalid arguments');
  }
  // Prefer an explicit `setNxEx` if the redis client exposes it; fall back
  // to `acquireLock` (which is the existing SET-NX-EX primitive on this
  // codebase). Either returns truthy on fresh acquisition.
  const anyRedis = redisService as unknown as {
    setNxEx?: (k: string, v: string, ttl: number) => Promise<boolean>;
  };
  if (typeof anyRedis.setNxEx === 'function') {
    try {
      const ok = await anyRedis.setNxEx(key, instanceId, ttlSeconds);
      if (ok) metrics.incrementCounter('outbox_leader_elections_total', { key, result: 'acquired' });
      return Boolean(ok);
    } catch (err) {
      logger.error('[LeaderElection] setNxEx failed', {
        key,
        error: err instanceof Error ? err.message : 'unknown',
      });
      return false;
    }
  }

  // Fallback: acquireLock on the raw key namespace. acquireLock prefixes
  // 'lock:' internally; keep the same key-space for callers that also read
  // the raw value via GET so the Lua CAS stays symmetric. We therefore use
  // eval-based SET NX EX on the raw key instead of the prefixed helper.
  try {
    const result = await redisService.eval(
      `if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then return 1 else return 0 end`,
      [key],
      [instanceId, String(ttlSeconds)]
    );
    const acquired = result === 1 || result === '1';
    if (acquired) {
      metrics.incrementCounter('outbox_leader_elections_total', { key, result: 'acquired' });
    }
    return acquired;
  } catch (err) {
    logger.error('[LeaderElection] acquireLeader eval failed', {
      key,
      error: err instanceof Error ? err.message : 'unknown',
    });
    return false;
  }
}

/**
 * Atomic compare-and-set renewal. Succeeds only if we are still the
 * recorded owner.
 */
export async function renewLeader(
  key: string,
  instanceId: string,
  ttlSeconds: number
): Promise<boolean> {
  if (!key || !instanceId || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('renewLeader: invalid arguments');
  }
  try {
    const result = await redisService.eval(
      LEADER_RENEW_SCRIPT,
      [key],
      [instanceId, String(ttlSeconds)]
    );
    const renewed = result === 1 || result === '1';
    if (!renewed) {
      metrics.incrementCounter('outbox_leader_renewals_failed_total', { key });
    }
    return renewed;
  } catch (err) {
    logger.error('[LeaderElection] renewLeader eval failed', {
      key,
      error: err instanceof Error ? err.message : 'unknown',
    });
    metrics.incrementCounter('outbox_leader_renewals_failed_total', { key, reason: 'exception' });
    return false;
  }
}

/**
 * Install a background heartbeat that keeps renewing the lease while this
 * instance is still the owner. Returns the timer so callers can clear it
 * on shutdown.
 *
 * - TTL defaults to 60s (matches F-A-56 guidance: 3× batch budget).
 * - Interval defaults to 20s (renew at 1/3 TTL so one missed tick is safe).
 * - The returned timer is .unref()'d so it never blocks process exit.
 */
export function startHeartbeat(
  key: string,
  instanceId: string,
  ttlSeconds: number = 60,
  intervalMs: number = 20_000
): NodeJS.Timeout {
  const timer = setInterval(async () => {
    try {
      const ok = await renewLeader(key, instanceId, ttlSeconds);
      if (!ok) {
        // Lost leadership — surface it so the caller can stop polling.
        logger.warn('[LeaderElection] Lost leadership during heartbeat', { key, instanceId });
      }
    } catch (err) {
      logger.error('[LeaderElection] Heartbeat tick failed', {
        key,
        instanceId,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }, intervalMs);

  // NodeJS timers block the event loop from exiting unless .unref() is
  // called. In tests without unref() a leaked heartbeat hangs process exit.
  if (typeof (timer as any).unref === 'function') {
    (timer as any).unref();
  }
  return timer;
}
