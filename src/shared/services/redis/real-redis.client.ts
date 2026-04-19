/**
 * Real Redis Client - Production implementation using ioredis.
 * Handles connection pooling, cluster mode, TLS, and all Redis operations.
 */

import { logger } from '../logger.service';
import { config } from '../../../config/environment';
import type { IRedisClient, IRedisTransaction, RedisConfig, GeoMember, RedisEventListener } from './redis.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisInstance = any;

export class RealRedisClient implements IRedisClient {
  private client: RedisInstance | null = null;
  private subscriber: RedisInstance | null = null;
  private blockingClient: RedisInstance | null = null;  // Dedicated client for BRPOP/BLPOP (BullMQ pattern)
  private connected = false;
  private reconnecting = false;
  private subscriptions = new Map<string, (message: string) => void>();
  private offlineQueueGuardInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private config: RedisConfig) { }

  getRawClient(): { on(event: string, handler: RedisEventListener): unknown } | null {
    return this.client;
  }

  async connect(): Promise<void> {
    try {
      // Dynamic import of ioredis (production dependency)
      const Redis = require('ioredis');

      const isClusterMode = process.env.REDIS_CLUSTER === 'true';
      const clusterNodes = (process.env.REDIS_NODES || '').split(',').filter(Boolean);
      const useTls = this.config.url.startsWith('rediss://');
      const rejectUnauthorized = process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false';

      if (isClusterMode && clusterNodes.length > 0) {
        const nodes = clusterNodes.map(node => {
          const [host, port] = node.split(':');
          return { host: host.trim(), port: parseInt(port || '6379', 10) };
        });

        logger.info(`[Redis] Cluster mode: connecting to ${nodes.length} node(s)`);

        this.client = new Redis.Cluster(nodes, {
          redisOptions: {
            maxRetriesPerRequest: 1,
            commandTimeout: this.config.commandTimeoutMs,
            // #54 FIX: enableOfflineQueue: true prevents silent command drops during
            // brief reconnections. A periodic guard (below) caps the queue at 1000
            // and forces reconnect if it grows too large.
            enableOfflineQueue: true,
            keepAlive: 1000,
            tls: useTls ? { rejectUnauthorized } : undefined,
            password: process.env.REDIS_PASSWORD || undefined,
          },
          clusterRetryStrategy: (times: number) => {
            if (times % 10 === 0) {
              logger.warn(`[Redis] Cluster reconnect attempt ${times} — still retrying`);
            }
            return Math.min(times * 200, 5000);
          },
          enableReadyCheck: true,
          scaleReads: 'slave',
          natMap: undefined,
          dnsLookup: undefined,
        });

        this.subscriber = new Redis.Cluster(nodes, {
          redisOptions: {
            tls: useTls ? { rejectUnauthorized } : undefined,
            password: process.env.REDIS_PASSWORD || undefined,
          },
        });

        logger.info(`[Redis] Cluster mode initialized (${nodes.length} nodes, TLS: ${useTls})`);

      } else {
        this.client = new Redis(this.config.url, {
          // #54 FIX: enableOfflineQueue: true prevents silent command drops during
          // brief reconnections. A periodic guard (below) caps the queue at 1000
          // and forces reconnect if it grows too large, preventing unbounded memory growth.
          maxRetriesPerRequest: 3,
          retryStrategy: (times: number) => {
            if (times % 10 === 0) {
              logger.warn(`[Redis] Reconnect attempt ${times} — still retrying`);
            }
            return Math.min(times * 200, 5000);
          },
          connectTimeout: this.config.connectionTimeoutMs,
          commandTimeout: this.config.commandTimeoutMs,
          enableOfflineQueue: true,
          enableReadyCheck: true,
          lazyConnect: false,
          keepAlive: 1000,
          tls: useTls ? { rejectUnauthorized } : undefined,
        });

        this.subscriber = new Redis(this.config.url, {
          maxRetriesPerRequest: this.config.maxRetries,
          connectTimeout: this.config.connectionTimeoutMs,
          tls: useTls ? { rejectUnauthorized } : undefined,
        });

        this.blockingClient = new Redis(this.config.url, {
          maxRetriesPerRequest: null,
          connectTimeout: this.config.connectionTimeoutMs,
          // #54 FIX: enableOfflineQueue: true for blocking client too
          enableOfflineQueue: true,
          enableReadyCheck: true,
          lazyConnect: false,
          keepAlive: 1000,
          tls: useTls ? { rejectUnauthorized } : undefined,
        });

        this.blockingClient.on('error', (err: Error) => {
          logger.error(`[Redis] Blocking client error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }

      // Event handlers
      this.client.on('connect', () => {
        logger.info('🔴 [Redis] Connected to Redis server');
        this.connected = true;
        this.reconnecting = false;
      });

      this.client.on('ready', () => {
        logger.info('🔴 [Redis] Client ready');
      });

      this.client.on('error', (err: Error) => {
        logger.error(`[Redis] Error: ${err instanceof Error ? err.message : String(err)}`);
      });

      this.client.on('close', () => {
        logger.warn('[Redis] Connection closed');
        this.connected = false;
      });

      this.client.on('reconnecting', () => {
        logger.info('[Redis] Reconnecting...');
        this.reconnecting = true;
      });

      // Subscriber event handlers
      this.subscriber.on('message', (channel: string, message: string) => {
        const callback = this.subscriptions.get(channel);
        if (callback) {
          try {
            callback(message);
          } catch (e) {
            logger.error(`[Redis] Subscriber callback error: ${e}`);
          }
        }
      });

      // #54 FIX: Periodic guard — if the offline queue grows beyond 1000 commands
      // (e.g., Redis is down for an extended period), force a reconnect to flush the
      // queue and prevent unbounded memory growth.
      const OFFLINE_QUEUE_MAX = 1000;
      this.offlineQueueGuardInterval = setInterval(() => {
        try {
          const queueLen = this.client?.commandQueue?.length ?? this.client?.offlineQueue?.length ?? 0;
          if (queueLen > OFFLINE_QUEUE_MAX) {
            logger.warn(`[Redis] Offline queue size (${queueLen}) exceeds ${OFFLINE_QUEUE_MAX} — forcing reconnect`);
            this.client.disconnect(true);
          }
        } catch { /* guard must never throw */ }
      }, 5000);
      this.offlineQueueGuardInterval.unref();

      // Wait for connection
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Redis connection timeout'));
        }, this.config.connectionTimeoutMs);

        this.client.once('ready', () => {
          clearTimeout(timeout);
          resolve();
        });

        this.client.once('error', (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      logger.info('🔴 [Redis] Successfully connected to Redis');

    } catch (error: unknown) {
      logger.error(`[Redis] Connection failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    // #54 FIX: Clear the offline queue guard interval on shutdown
    if (this.offlineQueueGuardInterval) {
      clearInterval(this.offlineQueueGuardInterval);
      this.offlineQueueGuardInterval = null;
    }
    if (this.blockingClient) {
      await this.blockingClient.quit().catch(() => {});
    }
    if (this.subscriber) {
      await this.subscriber.quit();
    }
    if (this.client) {
      await this.client.quit();
    }
    this.connected = false;
    logger.info('[Redis] Disconnected');
  }

  isConnected(): boolean {
    return this.connected && !this.reconnecting;
  }

  // =========== Basic Operations ===========

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds && ttlSeconds > 0) {
      await this.client.setex(key, ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<boolean> {
    const result = await this.client.del(key);
    return result > 0;
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);
    return result > 0;
  }

  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.expire(key, ttlSeconds);
    return result > 0;
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  async keys(pattern: string): Promise<string[]> {
    // #98 FIX: Use SCAN instead of blocking KEYS command.
    // KEYS blocks the Redis event loop and can cause timeouts in production
    // when the keyspace is large. SCAN iterates incrementally.
    const results: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor, 'MATCH', pattern, 'COUNT', 100
      );
      cursor = nextCursor;
      results.push(...keys);
    } while (cursor !== '0');
    return results;
  }

  async *scanIterator(pattern: string, count = 100): AsyncIterableIterator<string> {
    if (!this.client) return;

    let cursor = '0';
    do {
      const result = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', count);
      cursor = result[0];
      const keys = result[1];

      for (const key of keys) {
        yield key;
      }
    } while (cursor !== '0');
  }

  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async incrBy(key: string, amount: number): Promise<number> {
    return this.client.incrby(key, amount);
  }

  // =========== Lists ===========

  async lPush(key: string, value: string): Promise<number> {
    return this.client.lpush(key, value);
  }

  async lPushMany(key: string, values: string[]): Promise<number> {
    if (values.length === 0) {
      return this.lLen(key);
    }
    return this.client.lpush(key, ...values);
  }

  async rPush(key: string, value: string): Promise<number> {
    return this.client.rpush(key, value);
  }

  async lRange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.lrange(key, start, stop);
  }

  async lTrim(key: string, start: number, stop: number): Promise<void> {
    await this.client.ltrim(key, start, stop);
  }

  async rPop(key: string): Promise<string | null> {
    return this.client.rpop(key);
  }

  async lLen(key: string): Promise<number> {
    return this.client.llen(key);
  }

  async brPop(key: string, timeoutSeconds: number): Promise<string | null> {
    if (!this.blockingClient) {
      const result = await this.client.rpop(key);
      return result ?? null;
    }

    try {
      const result = await this.blockingClient.brpop(key, timeoutSeconds);
      return result ? result[1] : null;
    } catch (err: unknown) {
      logger.warn(`[Redis] BRPOP failed, falling back to RPOP: ${err instanceof Error ? err.message : String(err)}`);
      const result = await this.client.rpop(key);
      if (!result) {
        // Cap sleep to 500ms max to avoid blocking the event loop on long BRPOP timeouts.
        await new Promise(resolve => setTimeout(resolve, Math.min(500, timeoutSeconds * 1000)));
      }
      return result ?? null;
    }
  }

  // =========== Sets ===========

  async sAdd(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return this.client.sadd(key, ...members);
  }

  async sRem(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return this.client.srem(key, ...members);
  }

  async sMembers(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }

  async sScan(key: string, cursor: string, count: number = 100): Promise<[string, string[]]> {
    const result = await this.client.sscan(key, cursor, 'COUNT', count);
    return [result[0], result[1]];
  }

  async sIsMember(key: string, member: string): Promise<boolean> {
    const result = await this.client.sismember(key, member);
    return result > 0;
  }

  /** H-P4: Batch SISMEMBER via Redis SMISMEMBER (Redis 6.2+) */
  async smIsMembers(key: string, members: string[]): Promise<boolean[]> {
    if (members.length === 0) return [];
    const results = await this.client.smismember(key, ...members);
    return results.map((r: number) => r === 1);
  }

  async sCard(key: string): Promise<number> {
    return this.client.scard(key);
  }

  async sUnion(...keys: string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    return this.client.sunion(...keys);
  }

  // Sorted Sets
  async zAdd(key: string, score: number, member: string): Promise<number> {
    return this.client.zadd(key, score, member);
  }

  async zRangeByScore(key: string, min: number | string, max: number | string): Promise<string[]> {
    return this.client.zrangebyscore(key, min, max);
  }

  async zRemRangeByScore(key: string, min: number | string, max: number | string): Promise<number> {
    return this.client.zremrangebyscore(key, min, max);
  }

  // =========== Hashes ===========

  async hSet(key: string, field: string, value: string): Promise<void> {
    await this.client.hset(key, field, value);
  }

  async hGet(key: string, field: string): Promise<string | null> {
    return this.client.hget(key, field);
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    return this.client.hgetall(key);
  }

  async hGetAllBatch(keys: string[]): Promise<Record<string, string>[]> {
    if (keys.length === 0) return [];
    const pipeline = this.client.pipeline();
    keys.forEach((key) => pipeline.hgetall(key));
    const responses = await pipeline.exec();
    if (!responses || !Array.isArray(responses)) {
      return keys.map(() => ({}));
    }

    return responses.map((entry: [Error | null, unknown]) => {
      const [error, value] = Array.isArray(entry) ? entry : [null, {}];
      if (error) {
        return {};
      }
      if (value && typeof value === 'object') {
        return value as Record<string, string>;
      }
      return {};
    });
  }

  async hDel(key: string, ...fields: string[]): Promise<number> {
    if (fields.length === 0) return 0;
    return this.client.hdel(key, ...fields);
  }

  async hIncrBy(key: string, field: string, increment: number): Promise<number> {
    return this.client.hincrby(key, field, increment);
  }

  async hMSet(key: string, data: Record<string, string>): Promise<void> {
    if (Object.keys(data).length === 0) return;
    await this.client.hmset(key, data);
  }

  // =========== Geospatial ===========

  async geoAdd(key: string, longitude: number, latitude: number, member: string): Promise<number> {
    return this.client.geoadd(key, longitude, latitude, member);
  }

  async geoRemove(key: string, member: string): Promise<number> {
    return this.client.zrem(key, member);
  }

  async geoPos(key: string, member: string): Promise<{ longitude: number; latitude: number } | null> {
    const result = await this.client.geopos(key, member);
    if (!result || !result[0]) return null;
    return {
      longitude: parseFloat(result[0][0]),
      latitude: parseFloat(result[0][1])
    };
  }

  async geoRadius(key: string, longitude: number, latitude: number, radius: number, unit: 'km' | 'm', count: number = config.geoQueryMaxCandidates || 250): Promise<GeoMember[]> {
    try {
      const results = await this.client.geosearch(
        key,
        'FROMLONLAT', longitude, latitude,
        'BYRADIUS', radius, unit,
        'WITHDIST', 'WITHCOORD',
        'ASC',
        'COUNT', count
      );

      return this.parseGeoResults(results);
    } catch (e) {
      const results = await this.client.georadius(
        key, longitude, latitude, radius, unit,
        'WITHDIST', 'WITHCOORD', 'ASC',
        'COUNT', count
      );

      return this.parseGeoResults(results);
    }
  }

  async geoRadiusByMember(key: string, member: string, radius: number, unit: 'km' | 'm'): Promise<GeoMember[]> {
    const results = await this.client.georadiusbymember(
      key, member, radius, unit,
      'WITHDIST', 'WITHCOORD', 'ASC'
    );

    return this.parseGeoResults(results);
  }

  private parseGeoResults(results: unknown[]): GeoMember[] {
    if (!results || !Array.isArray(results)) return [];

    return results.map((item: unknown): GeoMember => {
      if (Array.isArray(item)) {
        return {
          member: String(item[0]),
          distance: item[1] ? parseFloat(String(item[1])) : undefined,
          coordinates: item[2] ? {
            longitude: parseFloat(String((item[2] as unknown[])[0])),
            latitude: parseFloat(String((item[2] as unknown[])[1]))
          } : undefined
        };
      }
      return { member: String(item) };
    });
  }

  // =========== Pub/Sub ===========

  async publish(channel: string, message: string): Promise<number> {
    return this.client.publish(channel, message);
  }

  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    this.subscriptions.set(channel, callback);
    await this.subscriber.subscribe(channel);
    logger.info(`[Redis] Subscribed to channel: ${channel}`);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.subscriptions.delete(channel);
    await this.subscriber.unsubscribe(channel);
  }

  // =========== Transactions ===========

  multi(): IRedisTransaction {
    return new RealRedisTransaction(this.client.multi());
  }

  // =========== Lua Scripts ===========

  async eval(script: string, keys: string[], args: string[]): Promise<any> {
    return this.client.eval(script, keys.length, ...keys, ...args);
  }

  async sAddWithExpire(key: string, ttlSeconds: number, ...members: string[]): Promise<void> {
    if (members.length === 0) return;
    const luaScript = `
      for i = 2, #ARGV do redis.call('SADD', KEYS[1], ARGV[i]) end
      redis.call('EXPIRE', KEYS[1], ARGV[1])
      return 1
    `;
    await this.eval(luaScript, [key], [String(ttlSeconds), ...members]);
  }
}

// Real Redis transaction
class RealRedisTransaction implements IRedisTransaction {
  constructor(private pipeline: { set(k: string, v: string): unknown; del(k: string): unknown; expire(k: string, ttl: number): unknown; sadd(k: string, ...m: string[]): unknown; srem(k: string, ...m: string[]): unknown; exec(): Promise<Array<[Error | null, unknown]>> }) { }

  set(key: string, value: string): IRedisTransaction {
    this.pipeline.set(key, value);
    return this;
  }

  del(key: string): IRedisTransaction {
    this.pipeline.del(key);
    return this;
  }

  expire(key: string, ttlSeconds: number): IRedisTransaction {
    this.pipeline.expire(key, ttlSeconds);
    return this;
  }

  sAdd(key: string, ...members: string[]): IRedisTransaction {
    this.pipeline.sadd(key, ...members);
    return this;
  }

  sRem(key: string, ...members: string[]): IRedisTransaction {
    this.pipeline.srem(key, ...members);
    return this;
  }

  async exec(): Promise<unknown[]> {
    const results = await this.pipeline.exec();
    // ioredis returns [[err, result], [err, result], ...]
    return (results ?? []).map((r: [Error | null, unknown]) => r[1]);
  }
}
