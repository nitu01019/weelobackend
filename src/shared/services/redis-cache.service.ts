/**
 * =============================================================================
 * REDIS CACHE SERVICE — F-B-06 (fail-open wrapper)
 * =============================================================================
 *
 * Counterpart to redis-coordination.service.ts. For pure-cache readers (fleet
 * cache, route-ETA cache, availability snapshots) a Redis miss or transport
 * failure is SAFE — the caller falls back to the database (cache-aside).
 * Returning `null` on error preserves that contract without surfacing a throw
 * up the request path.
 *
 * Important:
 *   - This wrapper does NOT suppress errors on writes. A write that silently
 *     swallows is worse than a read miss — the next read would return stale
 *     data or an empty snapshot, which for broadcasts means "no transporters
 *     have this truck type". Writes throw; readers increment a miss counter
 *     and return the null/default.
 *   - No feature flag. This is purely a pattern wrapper — the behavior is
 *     identical to what individual cache-aside call sites already do inline.
 * =============================================================================
 */

import { redisService } from './redis.service';
import { logger } from './logger.service';

function bumpMissCounter(label: string): void {
  try {
    const { metrics } = require('../monitoring/metrics.service');
    metrics.incrementCounter('redis_cache_miss_total', { reason: label });
  } catch {
    /* metrics not available in test envs */
  }
}

export const redisCache = {
  /**
   * Fail-open cache read. Returns `null` on any underlying failure so the
   * caller can proceed straight to the DB-backed fallback (cache-aside).
   */
  async get(key: string): Promise<string | null> {
    try {
      return await redisService.get(key);
    } catch (err: unknown) {
      logger.warn(`[RedisCache] get(${key}) failed: ${(err as Error).message}`);
      bumpMissCounter('get_error');
      return null;
    }
  },

  async getJSON<T>(key: string): Promise<T | null> {
    try {
      return await redisService.getJSON<T>(key);
    } catch (err: unknown) {
      logger.warn(`[RedisCache] getJSON(${key}) failed: ${(err as Error).message}`);
      bumpMissCounter('getJSON_error');
      return null;
    }
  },

  /**
   * Cache writes surface errors. Callers wrap in try/catch when they want
   * to treat a write failure as non-fatal (standard cache-aside fill path).
   */
  set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    return redisService.set(key, value, ttlSeconds);
  },

  setJSON<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    return redisService.setJSON(key, value, ttlSeconds);
  },

  async del(key: string): Promise<boolean> {
    try {
      return await redisService.del(key);
    } catch (err: unknown) {
      logger.warn(`[RedisCache] del(${key}) failed: ${(err as Error).message}`);
      return false;
    }
  },

  async exists(key: string): Promise<boolean> {
    try {
      return await redisService.exists(key);
    } catch {
      return false;
    }
  },
};
