/**
 * =============================================================================
 * RATE LIMIT SERVICE — Redis SSOT per-IP budget (F-A-37)
 * =============================================================================
 *
 * Replaces `new Map<string, IpBudget>()` + `setInterval` per-process cleanup
 * at `src/modules/routing/geocoding.routes.ts` with a shared ElastiCache
 * key: `rl:{endpoint}:{ip}` incremented atomically via Lua (INCRBY + EXPIRE +
 * cap check). This prevents the per-ECS-task quota doubling bug — under
 * scale-out, the old Map was per-process, so N tasks = N×budget.
 *
 * Design:
 * - Atomic cap-and-incr via Lua script. redisService.eval() abstracts over
 *   real ioredis (cluster-safe) and in-memory fallback.
 * - EVALSHA caching: we SCRIPT LOAD on first use (opportunistic, non-blocking)
 *   and EVALSHA thereafter, with NOSCRIPT fallback to re-load. If the
 *   underlying redis client does not expose EVALSHA (in-memory/dev),
 *   transparently fall back to eval().
 * - Fail-open on any Redis/script error. Correctness guarantee: a transient
 *   Redis blip MUST NOT block legitimate users. We increment
 *   `geocode_ratelimit_fallopen_total` so alerting can page on
 *   `rate > 1/5m for 10m`.
 *
 * Lua semantics (atomic):
 *   local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
 *   if cur + tonumber(ARGV[1]) > tonumber(ARGV[2]) then return -1 end
 *   local new = redis.call('INCRBY', KEYS[1], ARGV[1])
 *   if new == tonumber(ARGV[1]) then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
 *   return new
 *
 * KEYS[1] = rl bucket key
 * ARGV[1] = costUnits (int)
 * ARGV[2] = limit (int)
 * ARGV[3] = ttlSec (int)
 *
 * Returns:
 *   new counter value (>= costUnits) on allow
 *   -1 on deny (limit exceeded)
 *
 * Flag: FF_GEOCODE_RATELIMIT_REDIS (default OFF). When OFF, the legacy
 * Map-based path remains at the route layer; this service is not invoked.
 * =============================================================================
 */

import { redisService } from './redis.service';
import { logger } from './logger.service';
import { metrics } from '../monitoring/metrics.service';

// Module-scoped SHA cache — loaded once per process on first successful load.
let cachedSha: string | null = null;

export const LUA_RATELIMIT_INCR_CAP = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if cur + tonumber(ARGV[1]) > tonumber(ARGV[2]) then
  return -1
end
local new = redis.call('INCRBY', KEYS[1], ARGV[1])
if new == tonumber(ARGV[1]) then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return new
`.trim();

export interface RateLimitInput {
  /** Endpoint slug, e.g. "geocode:search" — used in metric label + key. */
  endpoint: string;
  /** Client IP from X-Forwarded-For (first hop) or socket.remoteAddress. */
  ip: string;
  /** Weight of this request (1 for single, N for fan-out endpoints). */
  costUnits: number;
  /** Key TTL (bucket reset window) in seconds. */
  windowSec: number;
  /** Max total cost allowed within the window. */
  limit: number;
}

export interface RateLimitResult {
  /** true ⇒ request may proceed. */
  allowed: boolean;
  /** Current counter value on allow, or undefined on deny/fallopen. */
  current?: number;
  /** true ⇒ Redis unreachable, allowed as safety. */
  fallopen?: boolean;
}

/**
 * Atomically check-and-increment an IP budget.
 *
 * Behavior:
 *  - allowed=true on allow; `current` = new counter value
 *  - allowed=false on limit-exceeded deny
 *  - allowed=true + fallopen=true on Redis failure (safety)
 *
 * Metrics emitted:
 *  - `geocode_ratelimit_allowed_total{endpoint}` on allow
 *  - `geocode_ratelimit_denied_total{endpoint}` on deny
 *  - `geocode_ratelimit_fallopen_total` on Redis error
 */
export async function checkAndIncrementIpBudget(
  input: RateLimitInput,
): Promise<RateLimitResult> {
  const { endpoint, ip, costUnits, windowSec, limit } = input;
  const key = `rl:${endpoint}:${ip}`;
  const args = [String(costUnits), String(limit), String(windowSec)];

  try {
    const result = await executeScript(key, args);

    if (result === null || result === undefined) {
      // In-memory fallback returns null — treat as fail-open (dev/test only).
      metrics.incrementCounter('geocode_ratelimit_fallopen_total');
      return { allowed: true, fallopen: true };
    }

    const n = typeof result === 'number' ? result : parseInt(String(result), 10);
    if (n < 0) {
      metrics.incrementCounter('geocode_ratelimit_denied_total', { endpoint });
      return { allowed: false };
    }

    metrics.incrementCounter('geocode_ratelimit_allowed_total', { endpoint });
    return { allowed: true, current: n };
  } catch (err: any) {
    // Fail-open — log, count, allow. Alert on fallopen rate paging oncall.
    logger.warn(
      `[RateLimit] Redis rate-limit fail-open for ${endpoint}:${ip} — ${err?.message || err}`,
    );
    metrics.incrementCounter('geocode_ratelimit_fallopen_total');
    return { allowed: true, fallopen: true };
  }
}

/**
 * Run the Lua cap-and-incr script, preferring EVALSHA with a NOSCRIPT fallback.
 * Falls back to plain EVAL when the underlying client does not expose EVALSHA
 * (in-memory dev fallback or custom wrappers).
 */
async function executeScript(key: string, args: string[]): Promise<any> {
  // Opportunistic EVALSHA path — only when raw ioredis client is available.
  const raw: any = (redisService as any).getRawClient?.();
  if (raw && typeof raw.evalsha === 'function') {
    try {
      if (!cachedSha && typeof raw.script === 'function') {
        try {
          cachedSha = await raw.script('LOAD', LUA_RATELIMIT_INCR_CAP);
        } catch {
          // SCRIPT LOAD failed — fall through to EVAL.
          cachedSha = null;
        }
      }
      if (cachedSha) {
        try {
          return await raw.evalsha(cachedSha, 1, key, ...args);
        } catch (err: any) {
          // NOSCRIPT → reload + retry once.
          if (String(err?.message || '').includes('NOSCRIPT')) {
            cachedSha = null;
            return await redisService.eval(LUA_RATELIMIT_INCR_CAP, [key], args);
          }
          throw err;
        }
      }
    } catch {
      // Any evalsha path failure — fall through to plain EVAL below.
      cachedSha = null;
    }
  }

  // Default path: wrapper-level EVAL (works for both real ioredis and
  // in-memory fallback — the latter returns null which the caller treats as
  // fail-open).
  return redisService.eval(LUA_RATELIMIT_INCR_CAP, [key], args);
}

/**
 * Test-only: reset the cached SHA. Exported for `jest.resetModules()` safety.
 */
export function __resetScriptCache(): void {
  cachedSha = null;
}
