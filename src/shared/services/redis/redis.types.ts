/**
 * Redis Types - All interfaces and type definitions for the Redis service layer.
 */

export interface RedisConfig {
  url: string;
  maxRetries: number;
  retryDelayMs: number;
  maxConnections: number;
  connectionTimeoutMs: number;
  commandTimeoutMs: number;
}

export interface GeoMember {
  member: string;
  distance?: number;
  coordinates?: { longitude: number; latitude: number };
}

export interface LockResult {
  acquired: boolean;
  ttl?: number;
}

export type RedisValue = string | number | Buffer;

// Permissive event listener type — ioredis events use typed callbacks (Error, string, etc.)
// that are not assignable to (...args: unknown[]) => void due to contravariance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RedisEventListener = (...args: any[]) => void;

export interface IRedisClient {
  // Connection
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Basic operations
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
  expire(key: string, ttlSeconds: number): Promise<boolean>;
  ttl(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  scanIterator(pattern: string, count?: number): AsyncIterableIterator<string>;

  // Atomic increment (for rate limiting)
  incr(key: string): Promise<number>;
  incrBy(key: string, amount: number): Promise<number>;

  // Lists (for queues - PRODUCTION SCALABILITY)
  lPush(key: string, value: string): Promise<number>;
  lPushMany(key: string, values: string[]): Promise<number>;
  rPush(key: string, value: string): Promise<number>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  lTrim(key: string, start: number, stop: number): Promise<void>;
  rPop(key: string): Promise<string | null>;
  lLen(key: string): Promise<number>;
  brPop(key: string, timeoutSeconds: number): Promise<string | null>;

  // Sets
  sAdd(key: string, ...members: string[]): Promise<number>;
  sRem(key: string, ...members: string[]): Promise<number>;
  sMembers(key: string): Promise<string[]>;
  sScan(key: string, cursor: string, count?: number): Promise<[string, string[]]>;
  sIsMember(key: string, member: string): Promise<boolean>;
  /** H-P4: Batch SISMEMBER -- checks multiple members in a single round-trip */
  smIsMembers(key: string, members: string[]): Promise<boolean[]>;
  sCard(key: string): Promise<number>;
  sUnion(...keys: string[]): Promise<string[]>;

  // Sorted Sets (for Phase 4 sequence delivery)
  zAdd(key: string, score: number, member: string): Promise<number>;
  zRangeByScore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zRemRangeByScore(key: string, min: number | string, max: number | string): Promise<number>;

  // Hashes
  hSet(key: string, field: string, value: string): Promise<void>;
  hGet(key: string, field: string): Promise<string | null>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hGetAllBatch(keys: string[]): Promise<Record<string, string>[]>;
  hDel(key: string, ...fields: string[]): Promise<number>;
  hIncrBy(key: string, field: string, increment: number): Promise<number>;
  hMSet(key: string, data: Record<string, string>): Promise<void>;

  // Geospatial
  geoAdd(key: string, longitude: number, latitude: number, member: string): Promise<number>;
  geoRemove(key: string, member: string): Promise<number>;
  geoPos(key: string, member: string): Promise<{ longitude: number; latitude: number } | null>;
  geoRadius(key: string, longitude: number, latitude: number, radius: number, unit: 'km' | 'm'): Promise<GeoMember[]>;
  geoRadiusByMember(key: string, member: string, radius: number, unit: 'km' | 'm'): Promise<GeoMember[]>;

  // Pub/Sub
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, callback: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;

  // Transactions
  multi(): IRedisTransaction;

  // Lua scripts (for atomic operations)
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;

  /**
   * Atomic SADD + EXPIRE via Lua script (LINE Engineering pattern).
   * Prevents orphaned sets without TTL if crash occurs between separate calls.
   */
  sAddWithExpire(key: string, ttlSeconds: number, ...members: string[]): Promise<void>;

  // Raw client access (for Socket.IO Redis Streams adapter)
  getRawClient(): { on(event: string, handler: RedisEventListener): unknown } | null;
}

export interface IRedisTransaction {
  set(key: string, value: string): IRedisTransaction;
  del(key: string): IRedisTransaction;
  expire(key: string, ttlSeconds: number): IRedisTransaction;
  sAdd(key: string, ...members: string[]): IRedisTransaction;
  sRem(key: string, ...members: string[]): IRedisTransaction;
  exec(): Promise<unknown[]>;
}
