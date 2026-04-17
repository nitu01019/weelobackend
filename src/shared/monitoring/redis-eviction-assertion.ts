/**
 * =============================================================================
 * REDIS EVICTION POLICY RUNTIME ASSERTION  (W0-3 / F-A-77)
 * =============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * F-A-77 introduces a durable HOLD_EXPIRY queue (BullMQ delayed-jobs) and
 * relies on Redis as a persistent store for distributed locks, idempotency
 * keys, and hold state.  If Redis is configured with an eviction policy
 * other than `noeviction` (e.g. `allkeys-lru`, `volatile-ttl`) then under
 * memory pressure Redis will silently evict keys — including BullMQ jobs
 * and lock keys — which corrupts the whole hold lifecycle and is extremely
 * hard to reproduce after the fact.
 *
 * The `.env.example` already documents `REDIS_MAXMEMORY_POLICY=noeviction`,
 * but documentation without enforcement is a landmine.  This module adds a
 * runtime assertion at boot, BEFORE BullMQ workers start.
 *
 * ELASTICACHE ESCAPE HATCH
 * ------------------------
 * Some managed Redis providers (notably AWS ElastiCache Serverless) restrict
 * the `CONFIG` command and respond with `NOPERM ... no permissions to run
 * the 'config|get' command`.  In that case we CANNOT verify the policy, so
 * we log a WARN + increment `redis_eviction_check_skipped_total` but DO NOT
 * halt boot.  Ops owns the policy for those providers; failing closed would
 * brick every managed-Redis deployment.
 *
 * USAGE
 * -----
 * ```ts
 *   // After Redis is initialized, before BullMQ workers start:
 *   const rawClient = redisService.getClient();
 *   if (rawClient) {
 *     await assertRedisEvictionPolicy(rawClient);  // throws on bad policy
 *   }
 * ```
 * =============================================================================
 */

import { logger } from '../services/logger.service';
import { metrics } from './metrics.service';

/**
 * The only eviction policy that is safe for a Redis instance backing BullMQ
 * delayed jobs, distributed locks, and idempotency keys.  Anything else
 * exposes us to silent key-eviction under memory pressure.
 */
const REQUIRED_POLICY = 'noeviction';

/**
 * Raised when the Redis `maxmemory-policy` is something other than
 * `noeviction`.  Carries the observed policy so callers can render helpful
 * log lines without re-parsing the message.
 */
export class RedisEvictionPolicyError extends Error {
  public readonly policy: string;

  constructor(policy: string) {
    const remediation =
      `Required policy is '${REQUIRED_POLICY}'. ` +
      `Run: redis-cli CONFIG SET maxmemory-policy noeviction  ` +
      `(or set REDIS_MAXMEMORY_POLICY=noeviction in your redis.conf). ` +
      `See .env.example and F-A-77 documentation.`;

    super(
      `REDIS_EVICTION_POLICY_INVALID: observed '${policy}', expected '${REQUIRED_POLICY}'. ${remediation}`
    );

    this.name = 'RedisEvictionPolicyError';
    this.policy = policy;

    // Preserve the prototype chain after super() (TypeScript extend-Error quirk).
    Object.setPrototypeOf(this, RedisEvictionPolicyError.prototype);
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Minimal interface we need from an ioredis-like client.  Using a structural
 * type keeps this module decoupled from the real RedisService (which would
 * create a circular dependency: redis.service imports metrics imports redis).
 */
export interface RedisCommandClient {
  call(command: string, ...args: unknown[]): Promise<unknown>;
}

/**
 * Detect whether an error returned by ioredis is the "no permission" error
 * that managed-Redis providers (e.g. ElastiCache) emit for the `CONFIG`
 * command.  ioredis does not always set a `.code`, so we also match on the
 * message prefix `NOPERM` which the Redis protocol always includes.
 */
function isNoPermError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as { code?: unknown; message?: unknown };
  if (typeof anyErr.code === 'string' && anyErr.code.toUpperCase() === 'NOPERM') {
    return true;
  }
  if (typeof anyErr.message === 'string' && anyErr.message.toUpperCase().startsWith('NOPERM')) {
    return true;
  }
  return false;
}

/**
 * Extract the policy string from an ioredis `CONFIG GET` result.
 *
 * ioredis returns an array: `[ 'maxmemory-policy', '<policy>' ]`.  Redis 7
 * may also return an object in RESP3, so we handle both defensively.
 */
function extractPolicy(raw: unknown): string | null {
  if (Array.isArray(raw) && raw.length >= 2 && typeof raw[1] === 'string') {
    return raw[1];
  }
  // RESP3 map shape: { 'maxmemory-policy': 'noeviction' }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const map = raw as Record<string, unknown>;
    const v = map['maxmemory-policy'];
    if (typeof v === 'string') return v;
  }
  return null;
}

/**
 * Assert that the live Redis instance has `maxmemory-policy = noeviction`.
 *
 * Behaviour matrix:
 *
 *   | Observation             | Action                                   |
 *   |-------------------------|------------------------------------------|
 *   | noeviction              | Info log, return (boot continues)        |
 *   | any other policy        | Throw RedisEvictionPolicyError (halts)   |
 *   | NOPERM on CONFIG GET    | WARN + skip-counter, return (no halt)    |
 *   | Unrecognised response   | WARN + skip-counter, return (no halt)    |
 *   | Other transport error   | WARN + skip-counter, return (no halt)    |
 *
 * We treat anything OTHER than "definitely bad policy" as a skip so that
 * a transient network issue during boot can't permanently brick a fleet.
 * The counter `redis_eviction_check_skipped_total` gives ops visibility
 * if the check is being silently skipped everywhere.
 */
export async function assertRedisEvictionPolicy(
  client: RedisCommandClient
): Promise<void> {
  let raw: unknown;
  try {
    raw = await client.call('CONFIG', 'GET', 'maxmemory-policy');
  } catch (err: unknown) {
    if (isNoPermError(err)) {
      metrics.incrementCounter('redis_eviction_check_skipped_total', {
        reason: 'noperm',
      });
      logger.warn(
        'REDIS_EVICTION_POLICY_CHECK_SKIPPED: CONFIG GET denied by provider (NOPERM) — boot continues. Ops must verify maxmemory-policy=noeviction out-of-band.',
        { reason: 'noperm' }
      );
      return;
    }
    // Transport/other error: skip (fail-open) rather than halt boot — a
    // Redis blip during startup shouldn't take the fleet down.
    metrics.incrementCounter('redis_eviction_check_skipped_total', {
      reason: 'error',
    });
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      'REDIS_EVICTION_POLICY_CHECK_SKIPPED: CONFIG GET failed — boot continues.',
      { reason: 'error', error: msg }
    );
    return;
  }

  const policy = extractPolicy(raw);
  if (policy === null) {
    metrics.incrementCounter('redis_eviction_check_skipped_total', {
      reason: 'unrecognised_response',
    });
    logger.warn(
      'REDIS_EVICTION_POLICY_CHECK_SKIPPED: unrecognised CONFIG GET response — boot continues.',
      { reason: 'unrecognised_response' }
    );
    return;
  }

  if (policy === REQUIRED_POLICY) {
    logger.info(
      `[Redis] maxmemory-policy = ${REQUIRED_POLICY} (F-A-77 requirement satisfied)`
    );
    return;
  }

  // Bad policy — halt boot.
  throw new RedisEvictionPolicyError(policy);
}
