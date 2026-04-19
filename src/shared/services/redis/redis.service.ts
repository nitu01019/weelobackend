/**
 * RedisService - Main facade class for all Redis operations.
 * Automatically uses Real Redis or In-Memory fallback.
 */

import { logger } from '../logger.service';
import type { IRedisClient, IRedisTransaction, RedisConfig, GeoMember, LockResult } from './redis.types';
import { InMemoryRedisClient } from './in-memory-redis.client';
import { RealRedisClient } from './real-redis.client';

export class RedisService {
  private client: IRedisClient;
  private initialized = false;
  private useRedis = false;
  public isDegraded: boolean = false;
  private reconnectProbeTimer: ReturnType<typeof setInterval> | null = null;

  // DR-20: Track PG advisory locks we actually acquired so releaseLock
  // only calls pg_advisory_unlock for locks this process owns.
  private pgAdvisoryLocks = new Set<string>();

  /**
   * #55 FIX: Safe JSON.stringify that handles circular references.
   * Returns '[Circular]' for back-references instead of throwing.
   */
  private safeStringify(value: unknown): string {
    const seen = new WeakSet();
    return JSON.stringify(value, function (_key, val) {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });
  }

  // M-15 FIX: Environment-aware Redis key prefix.
  readonly keyPrefix: string = process.env.REDIS_KEY_PREFIX || '';

  /**
   * Adds environment prefix to Redis keys for namespace isolation.
   * WARNING: This method is currently NOT wired into Redis operations.
   * If staging and production share a Redis instance, keys WILL collide.
   * TODO: Wire prefixKey() into all Redis operations when REDIS_KEY_PREFIX is set.
   * See CRITICAL #16 in code review findings.
   *
   * M-15: Prefix a key with the environment namespace.
   * Idempotent -- already-prefixed keys are returned unchanged.
   */
  prefixKey(key: string): string {
    if (!this.keyPrefix) return key;
    if (key.startsWith(`${this.keyPrefix}:`)) return key;
    return `${this.keyPrefix}:${key}`;
  }

  constructor() {
    this.client = new InMemoryRedisClient();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const redisEnabled = process.env.REDIS_ENABLED === 'true';
    const redisUrl = process.env.REDIS_URL;
    const isProduction = process.env.NODE_ENV === 'production';

    if (redisEnabled && redisUrl) {
      try {
        const config: RedisConfig = {
          url: redisUrl,
          maxRetries: parseInt(process.env.REDIS_MAX_RETRIES || '5', 10),
          retryDelayMs: parseInt(process.env.REDIS_RETRY_DELAY_MS || '1000', 10),
          maxConnections: parseInt(process.env.REDIS_MAX_CONNECTIONS || '20', 10),
          connectionTimeoutMs: parseInt(process.env.REDIS_CONNECTION_TIMEOUT_MS || '3000', 10),
          commandTimeoutMs: parseInt(process.env.REDIS_COMMAND_TIMEOUT_MS || '3000', 10),
        };

        logger.info(`[Redis] Initializing connection (timeout: ${config.connectionTimeoutMs}ms, retries: ${config.maxRetries})`);

        const realClient = new RealRedisClient(config);
        await realClient.connect();

        this.client = realClient;
        this.useRedis = true;
        this.isDegraded = false;

        // FIX F-5-10b: Attach runtime event handlers to reset/set isDegraded
        const rawClient = realClient.getRawClient();
        if (rawClient && typeof rawClient.on === 'function') {
          rawClient.on('ready', () => {
            this.isDegraded = false;
            this.stopReconnectProbe();
            logger.info('[Redis] Connection recovered -- isDegraded reset to false');
          });

          rawClient.on('close', () => {
            this.isDegraded = true;
            this.startReconnectProbe();
            logger.warn('[Redis] Connection lost -- isDegraded set to true');
          });
        }

        logger.info('✅ [Redis] Production Redis connected successfully');

      } catch (error: unknown) {
        logger.error(`[Redis] Failed to connect to Redis: ${error instanceof Error ? error.message : String(error)}`);
        logger.warn('⚠️  [Redis] Connection failed, falling back to in-memory mode');
        logger.warn('⚠️  [Redis] OTP and caching will work, but not persistent across restarts');
        logger.warn('⚠️  [Redis] Fix Redis connectivity for full production functionality');
        this.client = new InMemoryRedisClient();
        this.useRedis = false;
        this.isDegraded = true;
        this.startReconnectProbe();
      }
    } else {
      if (isProduction) {
        logger.error('❌ [Redis] FATAL: REDIS_ENABLED not set in production');
        throw new Error('Redis is required in production mode');
      }

      logger.info('📦 [Redis] Using in-memory storage (set REDIS_ENABLED=true for production)');
    }

    // CRITICAL #16 fix: Error at startup if REDIS_KEY_PREFIX is not set in production.
    // Without a prefix, staging and production will collide if they share a Redis instance.
    // Uses logger.error (not warn) so this surfaces in alerting dashboards.
    if (process.env.NODE_ENV === 'production' && !process.env.REDIS_KEY_PREFIX) {
      logger.error('[Redis] REDIS_KEY_PREFIX not set in production. If staging and production share a Redis instance, keys WILL collide. Set REDIS_KEY_PREFIX env var.');
    }

    this.initialized = true;
  }

  isRedisEnabled(): boolean {
    return this.useRedis;
  }

  private startReconnectProbe(): void {
    if (this.reconnectProbeTimer) return;
    const PROBE_INTERVAL_MS = 30_000;

    this.reconnectProbeTimer = setInterval(async () => {
      try {
        const { metrics } = require('../../monitoring/metrics.service');
        metrics.incrementCounter('redis_degraded_total');
      } catch { /* metrics not available */ }

      const redisUrl = process.env.REDIS_URL;
      if (!redisUrl) return;

      try {
        const probe = new RealRedisClient({
          url: redisUrl,
          maxRetries: 1,
          retryDelayMs: 500,
          maxConnections: 1,
          connectionTimeoutMs: 3000,
          commandTimeoutMs: 3000,
        });
        await probe.connect();
        this.client = probe;
        this.useRedis = true;
        this.isDegraded = false;
        this.stopReconnectProbe();
        logger.info('[Redis] Reconnect probe succeeded -- restored real Redis');
      } catch {
        logger.debug('[Redis] Reconnect probe failed -- still degraded');
      }
    }, PROBE_INTERVAL_MS);

    if (this.reconnectProbeTimer.unref) {
      this.reconnectProbeTimer.unref();
    }
  }

  private stopReconnectProbe(): void {
    if (this.reconnectProbeTimer) {
      clearInterval(this.reconnectProbeTimer);
      this.reconnectProbeTimer = null;
    }
  }

  getClient(): any {
    return this.client.getRawClient();
  }

  isConnected(): boolean {
    return this.client.isConnected();
  }

  // ===========================================================================
  // BASIC OPERATIONS
  // ===========================================================================

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    return this.client.set(key, value, ttlSeconds);
  }

  async del(key: string): Promise<boolean> {
    return this.client.del(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.client.exists(key);
  }

  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    return this.client.expire(key, ttlSeconds);
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  async keys(pattern: string, limit = 1000): Promise<string[]> {
    const results: string[] = [];
    for await (const key of this.client.scanIterator(pattern)) {
      results.push(key);
      if (results.length >= limit) break;
    }
    return results;
  }

  async *scanIterator(pattern: string, count = 100): AsyncIterableIterator<string> {
    const iterator = this.client.scanIterator(pattern, count);
    for await (const key of iterator) {
      yield key;
    }
  }

  // ===========================================================================
  // LIST OPERATIONS
  // ===========================================================================

  async lPush(key: string, value: string): Promise<number> {
    return this.client.lPush(key, value);
  }

  async lPushMany(key: string, values: string[]): Promise<number> {
    return this.client.lPushMany(key, values);
  }

  async rPush(key: string, value: string): Promise<number> {
    return this.client.rPush(key, value);
  }

  async lRange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.lRange(key, start, stop);
  }

  async lTrim(key: string, start: number, stop: number): Promise<void> {
    await this.client.lTrim(key, start, stop);
  }

  async rPop(key: string): Promise<string | null> {
    return this.client.rPop(key);
  }

  async lLen(key: string): Promise<number> {
    return this.client.lLen(key);
  }

  async brPop(key: string, timeoutSeconds: number): Promise<string | null> {
    return this.client.brPop(key, timeoutSeconds);
  }

  // ===========================================================================
  // JSON HELPERS
  // ===========================================================================

  async getJSON<T>(key: string): Promise<T | null> {
    if (!this.initialized) {
      logger.warn(`[Redis] getJSON called before initialization, waiting...`);
      await this.initialize();
    }
    const value = await this.client.get(key);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  async setJSON<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    if (!this.initialized) {
      logger.warn(`[Redis] setJSON called before initialization, waiting...`);
      await this.initialize();
    }
    // #55 FIX: Use safeStringify to avoid crash on circular objects
    await this.client.set(key, this.safeStringify(value), ttlSeconds);
  }

  // ===========================================================================
  // CACHE STAMPEDE PROTECTION (Singleflight Pattern)
  // ===========================================================================

  private inflightRequests: Map<string, Promise<any>> = new Map();

  async getOrSet<T>(key: string, ttlSeconds: number, backingFn: () => Promise<T>): Promise<T> {
    try {
      const cached = await this.getJSON<T>(key);
      if (cached !== null) {
        return cached;
      }
    } catch {
      // Redis down -- fall through to backing function
    }

    const inflight = this.inflightRequests.get(key);
    if (inflight) {
      return inflight as Promise<T>;
    }

    const promise = (async () => {
      try {
        const timeoutMs = 30_000;
        const result = await Promise.race([
          backingFn(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('getOrSet backing fn timeout')), timeoutMs))
        ]);
        try {
          await this.setJSON(key, result, ttlSeconds);
        } catch {
          // Cache write failed
        }
        return result;
      } finally {
        this.inflightRequests.delete(key);
      }
    })();

    this.inflightRequests.set(key, promise);
    return promise;
  }

  // ===========================================================================
  // RATE LIMITING
  // ===========================================================================

  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async incrBy(key: string, amount: number): Promise<number> {
    return this.client.incrBy(key, amount);
  }

  async atomicIncr(key: string, ttlSeconds: number): Promise<number> {
    return this.incrementWithTTL(key, ttlSeconds);
  }

  async incrementWithTTL(key: string, ttlSeconds: number): Promise<number> {
    const result = await this.incrementWithTTLAndRemaining(key, ttlSeconds);
    return result.count;
  }

  async incrementWithTTLAndRemaining(key: string, ttlSeconds: number): Promise<{ count: number; ttl: number }> {
    try {
      const result = await this.client.eval(
        `
        local count = redis.call('INCR', KEYS[1])
        if count == 1 then
          redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
        else
          local currentTtl = redis.call('TTL', KEYS[1])
          if currentTtl == -1 then
            redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
          end
        end
        local ttl = redis.call('TTL', KEYS[1])
        return {count, ttl}
        `,
        [key],
        [String(ttlSeconds)]
      );

      if (result === null || result === undefined) {
        throw new Error('eval returned null (in-memory mode)');
      }

      if (Array.isArray(result) && result.length >= 2) {
        return { count: Number(result[0]), ttl: Number(result[1]) };
      }

      return { count: Number(result), ttl: ttlSeconds };
    } catch (error: unknown) {
      const count = await this.client.incr(key);
      let currentTtl = ttlSeconds;
      try {
        const redisTtl = await this.client.ttl(key);
        if (redisTtl < 0) {
          await this.client.expire(key, ttlSeconds);
        } else {
          currentTtl = redisTtl;
        }
      } catch {
        // Best effort
      }
      return { count, ttl: currentTtl };
    }
  }

  async checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<{
    allowed: boolean;
    remaining: number;
    resetIn: number;
  }> {
    const { count, ttl } = await this.incrementWithTTLAndRemaining(key, windowSeconds);

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetIn: ttl > 0 ? ttl : windowSeconds
    };
  }

  // ===========================================================================
  // OTP ATOMIC OPERATIONS
  // ===========================================================================

  async incrementOtpAttempts(key: string, maxAttempts: number): Promise<{
    allowed: boolean;
    attempts: number;
    remaining: number;
  }> {
    const attemptsKey = `${key}:attempts`;
    const attempts = await this.client.incr(attemptsKey);
    const mainTtl = await this.client.ttl(key);
    if (mainTtl > 0) {
      await this.client.expire(attemptsKey, mainTtl);
    }
    const remaining = Math.max(0, maxAttempts - attempts);
    return {
      allowed: attempts <= maxAttempts,
      attempts,
      remaining
    };
  }

  async getOtpAttempts(key: string): Promise<number> {
    const attemptsKey = `${key}:attempts`;
    const value = await this.client.get(attemptsKey);
    return value ? parseInt(value, 10) : 0;
  }

  async deleteOtpWithAttempts(key: string): Promise<void> {
    const attemptsKey = `${key}:attempts`;
    await Promise.all([
      this.client.del(key),
      this.client.del(attemptsKey)
    ]);
  }

  // ===========================================================================
  // DISTRIBUTED TIMERS
  // ===========================================================================

  async setTimer<T>(timerKey: string, data: T, expiresAt: Date): Promise<void> {
    const ttlSeconds = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));

    const timerData = {
      data,
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date().toISOString()
    };

    // #55 FIX: Use safeStringify to avoid crash on circular objects
    await this.client.set(timerKey, this.safeStringify(timerData), ttlSeconds + 60);

    await this.client.eval(
      `redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
       redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -10001)
       if redis.call('TTL', KEYS[1]) == -1 then
         redis.call('EXPIRE', KEYS[1], 2592000)
       end
       return 1`,
      ['timers:pending'],
      [expiresAt.getTime().toString(), timerKey]
    ).catch(() => {
      this.client.sAdd('timers:pending:set', timerKey);
    });
  }

  async getExpiredTimers<T>(timerPrefix: string): Promise<Array<{ key: string; data: T; expiresAt: string }>> {
    const now = Date.now();
    const expired: Array<{ key: string; data: T; expiresAt: string }> = [];

    try {
      const expiredKeys = await this.client.eval(
        `return redis.call('zrangebyscore', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 100)`,
        ['timers:pending'],
        [now.toString()]
      ) as string[] | null;

      if (expiredKeys && Array.isArray(expiredKeys)) {
        for (const key of expiredKeys) {
          if (!key.startsWith(timerPrefix)) continue;

          const timerJson = await this.client.get(key);
          if (timerJson) {
            try {
              const timer = JSON.parse(timerJson);
              if (new Date(timer.expiresAt).getTime() <= now) {
                expired.push({
                  key,
                  data: timer.data as T,
                  expiresAt: timer.expiresAt
                });
              }
            } catch (e) {
              await this.client.del(key);
            }
          }

          await this.client.eval(
            `redis.call('zrem', KEYS[1], ARGV[1])`,
            ['timers:pending'],
            [key]
          ).catch(() => { });
        }
      }
    } catch (e) {
      const keys: string[] = [];
      for await (const k of this.client.scanIterator(`${timerPrefix}*`)) {
        keys.push(k);
      }
      for (const key of keys) {
        const timerJson = await this.client.get(key);
        if (timerJson) {
          try {
            const timer = JSON.parse(timerJson);
            if (new Date(timer.expiresAt).getTime() <= now) {
              expired.push({
                key,
                data: timer.data as T,
                expiresAt: timer.expiresAt
              });
            }
          } catch (e) {
            await this.client.del(key);
          }
        }
      }
    }

    return expired;
  }

  async cancelTimer(timerKey: string): Promise<boolean> {
    const deleted = await this.client.del(timerKey);

    await this.client.eval(
      `redis.call('zrem', KEYS[1], ARGV[1])`,
      ['timers:pending'],
      [timerKey]
    ).catch(() => {
      this.client.sRem('timers:pending:set', timerKey);
    });

    return deleted;
  }

  async hasTimer(timerKey: string): Promise<boolean> {
    return this.client.exists(timerKey);
  }

  // ===========================================================================
  // SETS
  // ===========================================================================

  async sAdd(key: string, ...members: string[]): Promise<number> {
    return this.client.sAdd(key, ...members);
  }

  async sRem(key: string, ...members: string[]): Promise<number> {
    return this.client.sRem(key, ...members);
  }

  async sMembers(key: string): Promise<string[]> {
    return this.client.sMembers(key);
  }

  async sScan(key: string, cursor: string, count: number = 100): Promise<[string, string[]]> {
    return this.client.sScan(key, cursor, count);
  }

  async sIsMember(key: string, member: string): Promise<boolean> {
    return this.client.sIsMember(key, member);
  }

  async smIsMembers(key: string, members: string[]): Promise<boolean[]> {
    return this.client.smIsMembers(key, members);
  }

  async sCard(key: string): Promise<number> {
    return this.client.sCard(key);
  }

  async sUnion(...keys: string[]): Promise<string[]> {
    return this.client.sUnion(...keys);
  }

  // Sorted Sets
  async zAdd(key: string, score: number, member: string): Promise<number> {
    return this.client.zAdd(key, score, member);
  }

  async zRangeByScore(key: string, min: number | string, max: number | string): Promise<string[]> {
    return this.client.zRangeByScore(key, min, max);
  }

  async zRemRangeByScore(key: string, min: number | string, max: number | string): Promise<number> {
    return this.client.zRemRangeByScore(key, min, max);
  }

  // ===========================================================================
  // HASHES
  // ===========================================================================

  async hSet(key: string, field: string, value: string): Promise<void> {
    return this.client.hSet(key, field, value);
  }

  async hGet(key: string, field: string): Promise<string | null> {
    return this.client.hGet(key, field);
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    return this.client.hGetAll(key);
  }

  async hGetAllBatch(keys: string[]): Promise<Record<string, string>[]> {
    return this.client.hGetAllBatch(keys);
  }

  async hDel(key: string, ...fields: string[]): Promise<number> {
    return this.client.hDel(key, ...fields);
  }

  async hIncrBy(key: string, field: string, increment: number): Promise<number> {
    return this.client.hIncrBy(key, field, increment);
  }

  async hMSet(key: string, data: Record<string, string>): Promise<void> {
    return this.client.hMSet(key, data);
  }

  async hSetJSON<T>(key: string, field: string, value: T): Promise<void> {
    // #55 FIX: Use safeStringify to avoid crash on circular objects
    await this.client.hSet(key, field, this.safeStringify(value));
  }

  async hGetJSON<T>(key: string, field: string): Promise<T | null> {
    const value = await this.client.hGet(key, field);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  // ===========================================================================
  // GEOSPATIAL
  // ===========================================================================

  async geoAdd(key: string, longitude: number, latitude: number, member: string): Promise<number> {
    return this.client.geoAdd(key, longitude, latitude, member);
  }

  async geoRemove(key: string, member: string): Promise<number> {
    return this.client.geoRemove(key, member);
  }

  async geoPos(key: string, member: string): Promise<{ longitude: number; latitude: number } | null> {
    return this.client.geoPos(key, member);
  }

  async geoRadius(key: string, longitude: number, latitude: number, radius: number, unit: 'km' | 'm' = 'km'): Promise<GeoMember[]> {
    return this.client.geoRadius(key, longitude, latitude, radius, unit);
  }

  async geoRadiusByMember(key: string, member: string, radius: number, unit: 'km' | 'm' = 'km'): Promise<GeoMember[]> {
    return this.client.geoRadiusByMember(key, member, radius, unit);
  }

  // ===========================================================================
  // DISTRIBUTED LOCKS
  // ===========================================================================

  async acquireLock(lockKey: string, holderId: string, ttlSeconds: number): Promise<LockResult> {
    const key = `lock:${lockKey}`;

    const result = await this.client.eval(
      `
      if redis.call('exists', KEYS[1]) == 0 then
        redis.call('setex', KEYS[1], ARGV[2], ARGV[1])
        return 1
      elseif redis.call('get', KEYS[1]) == ARGV[1] then
        redis.call('expire', KEYS[1], ARGV[2])
        return 1
      else
        return 0
      end
      `,
      [key],
      [holderId, ttlSeconds.toString()]
    );

    if (result !== null) {
      return {
        acquired: result === 1,
        ttl: result === 1 ? ttlSeconds : undefined
      };
    }

    // Fallback: Lua returned null (in-memory mode or eval failure)
    try {
      const { metrics } = require('../../monitoring/metrics.service');
      metrics.incrementCounter('redis_lock_fallback_total');
    } catch { /* metrics not available */ }

    if (this.isDegraded) {
      try {
        const { prismaClient } = require('../../database/prisma.service');
        // #57 FIX: Set a 10s lock_timeout so pg_try_advisory_lock never hangs
        // indefinitely if the PG process stalls. Applied consistently before every
        // advisory lock acquire path.
        await prismaClient.$executeRaw`SET LOCAL lock_timeout = '10000'`.catch(() => {});
        const pgResult = await prismaClient.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_lock(hashtext(${key})) AS locked
        `;
        const acquired = pgResult?.[0]?.locked === true;
        if (acquired) {
          // DR-20 FIX: Track that we acquired this PG advisory lock so releaseLock
          // only unlocks locks we actually own.
          this.pgAdvisoryLocks.add(key);
          await this.client.set(key, holderId, ttlSeconds).catch(() => {});
          logger.warn('[Redis] Lock acquired via PostgreSQL advisory lock (degraded mode)', {
            lockKey: key, holderId
          });
        }
        return { acquired, ttl: acquired ? ttlSeconds : undefined };
      } catch (pgError: unknown) {
        const pgMsg = pgError instanceof Error ? pgError.message : String(pgError);
        logger.error('[Redis] PG advisory lock failed -- rejecting lock request (Tier 3)', {
          lockKey: key, holderId, error: pgMsg
        });
        return { acquired: false };
      }
    }

    // Non-degraded in-memory mode (dev/test only)
    const existing = await this.client.get(key);
    if (!existing) {
      await this.client.set(key, holderId, ttlSeconds);
      return { acquired: true, ttl: ttlSeconds };
    } else if (existing === holderId) {
      await this.client.expire(key, ttlSeconds);
      return { acquired: true, ttl: ttlSeconds };
    }
    return { acquired: false };
  }

  async releaseLock(lockKey: string, holderId: string): Promise<boolean> {
    const key = `lock:${lockKey}`;

    const result = await this.client.eval(
      `
      if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1])
      else
        return 0
      end
      `,
      [key],
      [holderId]
    );

    if (result === null) {
      if (this.isDegraded) {
        // DR-20 FIX: Only call pg_advisory_unlock if we actually acquired this lock.
        // Unconditional unlock can release a lock held by another process/session.
        if (this.pgAdvisoryLocks.has(key)) {
          try {
            const { prismaClient } = require('../../database/prisma.service');
            await prismaClient.$queryRaw`SELECT pg_advisory_unlock(hashtext(${key}))`;
          } catch { /* PG release failure */ }
          this.pgAdvisoryLocks.delete(key);
        } else {
          logger.debug('[Redis] Skipping pg_advisory_unlock -- lock not owned by this process', {
            lockKey: key, holderId
          });
        }
      }
      const existing = await this.client.get(key);
      if (existing === holderId) {
        await this.client.del(key);
        return true;
      }
      return false;
    }

    return result === 1;
  }

  async isLockHeldBy(lockKey: string, holderId: string): Promise<boolean> {
    const key = `lock:${lockKey}`;
    const holder = await this.client.get(key);
    return holder === holderId;
  }

  async getLockHolder(lockKey: string): Promise<string | null> {
    const key = `lock:${lockKey}`;
    return this.client.get(key);
  }

  // ===========================================================================
  // PUB/SUB
  // ===========================================================================

  async publish(channel: string, message: string): Promise<number> {
    return this.client.publish(channel, message);
  }

  async publishJSON<T>(channel: string, data: T): Promise<number> {
    // #55 FIX: Use safeStringify to avoid crash on circular objects
    return this.client.publish(channel, this.safeStringify(data));
  }

  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    return this.client.subscribe(channel, callback);
  }

  async subscribeJSON<T>(channel: string, callback: (data: T) => void): Promise<void> {
    return this.client.subscribe(channel, (message) => {
      try {
        const data = JSON.parse(message) as T;
        callback(data);
      } catch (e) {
        logger.error(`[Redis] Failed to parse pub/sub message: ${e}`);
      }
    });
  }

  async unsubscribe(channel: string): Promise<void> {
    return this.client.unsubscribe(channel);
  }

  async eval(script: string, keys: string[], args: string[]): Promise<any> {
    return this.client.eval(script, keys, args);
  }

  /**
   * CRITICAL #22 fix: Atomically move delayed jobs from a sorted set to a list queue.
   * Uses a Lua script so ZRANGEBYSCORE + LPUSH + ZREM run as a single atomic
   * operation, preventing duplicate delivery if the poller crashes mid-way.
   *
   * SAFETY: Uses LIMIT 0 100 to cap each invocation. Without it, if 10,000 jobs
   * become ready at once (e.g., after a Redis outage), the Lua script would block
   * the Redis event loop for the entire batch. The caller should loop until the
   * return value is < 100.
   *
   * @param delayedKey - Sorted set key holding delayed jobs (score = processAfter timestamp)
   * @param queueKey   - List key for the main FIFO queue
   * @param maxScore   - Move jobs with score <= maxScore (typically Date.now())
   * @returns Number of jobs moved (max 100 per call)
   */
  async moveDelayedJobsAtomic(delayedKey: string, queueKey: string, maxScore: number): Promise<number> {
    const luaScript = `
      local jobs = redis.call('ZRANGEBYSCORE', KEYS[1], '0', ARGV[1], 'LIMIT', 0, 100)
      if #jobs == 0 then return 0 end
      for i, job in ipairs(jobs) do
        redis.call('LPUSH', KEYS[2], job)
        redis.call('ZREM', KEYS[1], job)
      end
      return #jobs
    `;
    const result = await this.client.eval(luaScript, [delayedKey, queueKey], [String(maxScore)]);
    return typeof result === 'number' ? result : 0;
  }

  async sAddWithExpire(key: string, ttlSeconds: number, ...members: string[]): Promise<void> {
    return this.client.sAddWithExpire(key, ttlSeconds, ...members);
  }

  // ===========================================================================
  // TRANSACTIONS
  // ===========================================================================

  multi(): IRedisTransaction {
    return this.client.multi();
  }

  // ===========================================================================
  // HEALTH CHECK
  // ===========================================================================

  async healthCheck(): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; mode: string; latencyMs?: number }> {
    if (this.isDegraded) {
      return { status: 'degraded', mode: 'memory-fallback' };
    }

    const start = Date.now();

    try {
      await this.client.set('health:check', 'ok', 10);
      const value = await this.client.get('health:check');

      if (value !== 'ok') {
        return { status: 'unhealthy', mode: this.useRedis ? 'redis' : 'memory' };
      }

      return {
        status: 'healthy',
        mode: this.useRedis ? 'redis' : 'memory',
        latencyMs: Date.now() - start
      };
    } catch (e) {
      return { status: 'unhealthy', mode: this.useRedis ? 'redis' : 'memory' };
    }
  }

  // ===========================================================================
  // CLEANUP / SHUTDOWN
  // ===========================================================================

  async shutdown(): Promise<void> {
    logger.info('[Redis] Shutting down...');
    this.stopReconnectProbe();
    await this.client.disconnect();
  }
}
