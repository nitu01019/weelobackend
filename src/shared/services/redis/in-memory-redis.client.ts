/**
 * In-Memory Redis Client - Development / Fallback implementation.
 * Used when Redis is not available or not configured.
 */

import { logger } from '../logger.service';
import type { IRedisClient, IRedisTransaction, GeoMember, RedisEventListener } from './redis.types';

// Discriminated union for in-memory store entries — each variant has a literal type tag
// so TypeScript can narrow entry.value to the correct concrete type in each method.
type InMemoryStoreEntry =
  | { type: 'string'; value: string; expiresAt?: number }
  | { type: 'list'; value: string[]; expiresAt?: number }
  | { type: 'set'; value: Set<string>; expiresAt?: number }
  | { type: 'hash'; value: Map<string, string>; expiresAt?: number }
  | { type: 'geo'; value: Map<string, { lng: number; lat: number }>; expiresAt?: number }
  | { type: 'zset'; value: Map<string, number>; expiresAt?: number };

export class InMemoryRedisClient implements IRedisClient {
  private store = new Map<string, InMemoryStoreEntry>();
  private subscribers = new Map<string, Set<(message: string) => void>>();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private evalWarned = false;
  // Fix G2: Cap in-memory store to prevent unbounded growth in dev/fallback
  private readonly MAX_KEYS = 10000;
  // #99 FIX: Event-driven BRPOP wakeup — waiters are notified via setImmediate on lPush
  private brPopWaiters = new Map<string, Array<() => void>>();

  constructor() {
    // Cleanup expired keys every 10 seconds
    this.cleanupInterval = setInterval(() => this.cleanup(), 10000);
    this.cleanupInterval.unref();
    logger.info('📦 [Redis] In-memory fallback initialized (development mode)');
  }

  /** Fix G2: Evict oldest entries without TTL when store exceeds MAX_KEYS */
  private enforceMaxKeys(): void {
    if (this.store.size <= this.MAX_KEYS) return;
    const entries = [...this.store.entries()];
    const toRemove = entries
      .filter(([, v]) => !v.expiresAt)
      .slice(0, this.store.size - this.MAX_KEYS);
    for (const [key] of toRemove) {
      this.store.delete(key);
    }
    // If still over limit, evict the oldest with TTL
    if (this.store.size > this.MAX_KEYS) {
      const remaining = [...this.store.keys()].slice(0, this.store.size - this.MAX_KEYS);
      for (const key of remaining) {
        this.store.delete(key);
      }
    }
  }

  getRawClient(): { on(event: string, handler: RedisEventListener): unknown } | null {
    return null; // No real ioredis client in in-memory mode
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.store.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`[Redis] Cleanup: removed ${cleaned} expired keys`);
    }
  }

  private isExpired(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return true;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return true;
    }
    return false;
  }

  async connect(): Promise<void> {
    logger.info('📦 [Redis] In-memory mode - no connection needed');
  }

  async disconnect(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.store.clear();
    this.subscribers.clear();
  }

  isConnected(): boolean {
    return true;
  }

  // =========== Basic Operations ===========

  async get(key: string): Promise<string | null> {
    if (this.isExpired(key)) return null;
    const entry = this.store.get(key);
    return entry?.type === 'string' ? entry.value : null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const entry: InMemoryStoreEntry = ttlSeconds && ttlSeconds > 0
      ? { value, type: 'string', expiresAt: Date.now() + (ttlSeconds * 1000) }
      : { value, type: 'string' };
    this.store.set(key, entry);
    this.enforceMaxKeys(); // Fix G2: Prevent unbounded growth
  }

  async del(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return !this.isExpired(key);
  }

  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    const entry = this.store.get(key);
    if (!entry) return false;
    entry.expiresAt = Date.now() + (ttlSeconds * 1000);
    return true;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry || !entry.expiresAt) return -1;
    const remaining = Math.ceil((entry.expiresAt - Date.now()) / 1000);
    return remaining > 0 ? remaining : -2;
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const result: string[] = [];

    for (const key of this.store.keys()) {
      if (regex.test(key) && !this.isExpired(key)) {
        result.push(key);
      }
    }

    return result;
  }

  async *scanIterator(pattern: string, _count?: number): AsyncIterableIterator<string> {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    for (const key of this.store.keys()) {
      if (regex.test(key) && !this.isExpired(key)) {
        yield key;
      }
    }
  }

  async incr(key: string): Promise<number> {
    return this.incrBy(key, 1);
  }

  async incrBy(key: string, amount: number): Promise<number> {
    const entry = this.store.get(key);
    let value = 0;

    if (entry && entry.type === 'string') {
      value = parseInt(entry.value, 10) || 0;
    }

    value += amount;

    if (entry && entry.type === 'string') {
      entry.value = value.toString();
    } else {
      this.store.set(key, { value: value.toString(), type: 'string' });
    }

    return value;
  }

  // =========== Lists (for queues - PRODUCTION SCALABILITY) ===========

  async lPush(key: string, value: string): Promise<number> {
    let entry = this.store.get(key);

    if (!entry || entry.type !== 'list') {
      entry = { value: [] as string[], type: 'list' };
      this.store.set(key, entry);
    }

    entry.value.unshift(value);

    // #99 FIX: Wake up any BRPOP waiter for this key immediately
    this.notifyBrPopWaiters(key);

    return entry.value.length;
  }

  async lPushMany(key: string, values: string[]): Promise<number> {
    if (values.length === 0) {
      return this.lLen(key);
    }

    let entry = this.store.get(key);
    if (!entry || entry.type !== 'list') {
      entry = { value: [] as string[], type: 'list' };
      this.store.set(key, entry);
    }

    for (const value of values) {
      entry.value.unshift(value);
    }

    // #99 FIX: Wake up any BRPOP waiter for this key immediately
    this.notifyBrPopWaiters(key);

    return entry.value.length;
  }

  async rPush(key: string, value: string): Promise<number> {
    let entry = this.store.get(key);
    if (!entry || entry.type !== 'list') {
      entry = { value: [] as string[], type: 'list' };
      this.store.set(key, entry);
    }
    entry.value.push(value);
    return entry.value.length;
  }

  async lRange(key: string, start: number, stop: number): Promise<string[]> {
    if (this.isExpired(key)) return [];
    const entry = this.store.get(key);
    if (!entry || entry.type !== 'list') return [];

    const len = entry.value.length;
    if (len === 0) return [];
    const normalStart = start < 0 ? Math.max(0, len + start) : Math.max(0, start);
    const normalStop = stop < 0 ? len + stop : Math.min(stop, len - 1);
    if (normalStart > normalStop || normalStart >= len) return [];
    return entry.value.slice(normalStart, normalStop + 1);
  }

  async lTrim(key: string, start: number, stop: number): Promise<void> {
    const entry = this.store.get(key);
    if (!entry || entry.type !== 'list') return;
    const len = entry.value.length;
    const normalStart = start < 0 ? Math.max(0, len + start) : start;
    const normalStop = stop < 0 ? len + stop : Math.min(stop, len - 1);
    entry.value = entry.value.slice(normalStart, normalStop + 1);
  }

  async rPop(key: string): Promise<string | null> {
    if (this.isExpired(key)) return null;
    const entry = this.store.get(key);
    if (!entry || entry.type !== 'list') return null;

    const value = entry.value.pop();
    return value || null;
  }

  async lLen(key: string): Promise<number> {
    if (this.isExpired(key)) return 0;
    const entry = this.store.get(key);
    if (!entry || entry.type !== 'list') return 0;
    return entry.value.length;
  }

  /**
   * #99 FIX: Event-driven BRPOP — sleeps up to 5s between polls (was 100ms busy-loop).
   * When lPush/lPushMany adds an item, it calls notifyBrPopWaiters() which wakes
   * the sleeping waiter via setImmediate, so latency stays low while CPU usage drops ~50x.
   */
  async brPop(key: string, timeoutSeconds: number): Promise<string | null> {
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;

    while (Date.now() - startTime < timeoutMs) {
      const value = await this.rPop(key);
      if (value !== null) {
        return value;
      }
      // Wait for either a push notification or a 5s fallback poll
      const remainingMs = timeoutMs - (Date.now() - startTime);
      if (remainingMs <= 0) break;
      const waitMs = Math.min(5000, remainingMs);
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, waitMs);
        // Register this waiter so lPush can wake it immediately
        if (!this.brPopWaiters.has(key)) {
          this.brPopWaiters.set(key, []);
        }
        this.brPopWaiters.get(key)!.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    return null;
  }

  /** #99 FIX: Notify BRPOP waiters that data is available on this key */
  private notifyBrPopWaiters(key: string): void {
    const waiters = this.brPopWaiters.get(key);
    if (waiters && waiters.length > 0) {
      // Wake the first waiter (FIFO) via setImmediate for immediate processing
      const waiter = waiters.shift()!;
      setImmediate(waiter);
    }
  }

  // =========== Sets ===========

  async sAdd(key: string, ...members: string[]): Promise<number> {
    let entry = this.store.get(key);

    if (!entry || entry.type !== 'set') {
      entry = { value: new Set<string>(), type: 'set' };
      this.store.set(key, entry);
    }

    let added = 0;
    for (const member of members) {
      if (!entry.value.has(member)) {
        entry.value.add(member);
        added++;
      }
    }

    return added;
  }

  async sRem(key: string, ...members: string[]): Promise<number> {
    const entry = this.store.get(key);
    if (!entry || entry.type !== 'set') return 0;

    let removed = 0;
    for (const member of members) {
      if (entry.value.delete(member)) {
        removed++;
      }
    }

    return removed;
  }

  async sMembers(key: string): Promise<string[]> {
    if (this.isExpired(key)) return [];
    const entry = this.store.get(key);
    if (!entry || entry.type !== 'set') return [];
    return Array.from(entry.value);
  }

  async sScan(key: string, _cursor: string, _count: number = 100): Promise<[string, string[]]> {
    const members = await this.sMembers(key);
    return ['0', members];
  }

  async sIsMember(key: string, member: string): Promise<boolean> {
    if (this.isExpired(key)) return false;
    const entry = this.store.get(key);
    if (!entry || entry.type !== 'set') return false;
    return entry.value.has(member);
  }

  /** H-P4: Batch SISMEMBER for in-memory fallback */
  async smIsMembers(key: string, members: string[]): Promise<boolean[]> {
    const set = this.isExpired(key) ? null : this.store.get(key);
    if (!set || set.type !== 'set') return members.map(() => false);
    return members.map(m => set.value.has(m));
  }

  async sCard(key: string): Promise<number> {
    if (this.isExpired(key)) return 0;
    const entry = this.store.get(key);
    if (!entry || entry.type !== 'set') return 0;
    return entry.value.size;
  }

  async sUnion(...keys: string[]): Promise<string[]> {
    const result = new Set<string>();
    for (const key of keys) {
      const members = await this.sMembers(key);
      for (const m of members) result.add(m);
    }
    return Array.from(result);
  }

  // Sorted Sets (in-memory simulation for Phase 4)
  async zAdd(key: string, score: number, member: string): Promise<number> {
    if (this.isExpired(key)) this.store.delete(key);
    let entry = this.store.get(key);
    if (!entry || entry.type !== 'zset') {
      entry = { type: 'zset', value: new Map<string, number>() };
      this.store.set(key, entry);
    }
    const isNew = !entry.value.has(member);
    entry.value.set(member, score);
    return isNew ? 1 : 0;
  }

  async zRangeByScore(key: string, min: number | string, max: number | string): Promise<string[]> {
    if (this.isExpired(key)) return [];
    const entry = this.store.get(key);
    if (!entry || entry.type !== 'zset') return [];
    const minVal = min === '-inf' ? -Infinity : Number(min);
    const maxVal = max === '+inf' ? Infinity : Number(max);
    const results: Array<{ member: string; score: number }> = [];
    for (const [member, score] of entry.value) {
      if (score >= minVal && score <= maxVal) {
        results.push({ member, score });
      }
    }
    results.sort((a, b) => a.score - b.score);
    return results.map(r => r.member);
  }

  async zRemRangeByScore(key: string, min: number | string, max: number | string): Promise<number> {
    if (this.isExpired(key)) return 0;
    const entry = this.store.get(key);
    if (!entry || entry.type !== 'zset') return 0;
    const minVal = min === '-inf' ? -Infinity : Number(min);
    const maxVal = max === '+inf' ? Infinity : Number(max);
    let removed = 0;
    for (const [member, score] of entry.value) {
      if (score >= minVal && score <= maxVal) {
        entry.value.delete(member);
        removed++;
      }
    }
    return removed;
  }

  // =========== Hashes ===========

  async hSet(key: string, field: string, value: string): Promise<void> {
    let entry = this.store.get(key);

    if (!entry || entry.type !== 'hash') {
      entry = { value: new Map<string, string>(), type: 'hash' };
      this.store.set(key, entry);
    }

    entry.value.set(field, value);
  }

  async hGet(key: string, field: string): Promise<string | null> {
    if (this.isExpired(key)) return null;
    const entry = this.store.get(key);
    if (!entry || entry.type !== 'hash') return null;
    return entry.value.get(field) || null;
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    if (this.isExpired(key)) return {};
    const entry = this.store.get(key);
    if (!entry || entry.type !== 'hash') return {};
    return Object.fromEntries(entry.value);
  }

  async hGetAllBatch(keys: string[]): Promise<Record<string, string>[]> {
    if (keys.length === 0) return [];
    return Promise.all(keys.map((key) => this.hGetAll(key)));
  }

  async hDel(key: string, ...fields: string[]): Promise<number> {
    const entry = this.store.get(key);
    if (!entry || entry.type !== 'hash') return 0;

    let deleted = 0;
    for (const field of fields) {
      if (entry.value.delete(field)) {
        deleted++;
      }
    }

    return deleted;
  }

  async hIncrBy(key: string, field: string, increment: number): Promise<number> {
    let entry = this.store.get(key);
    if (!entry || entry.type !== 'hash') {
      entry = { value: new Map<string, string>(), type: 'hash' };
      this.store.set(key, entry);
    }
    const current = parseInt(entry.value.get(field) || '0', 10);
    const newVal = current + increment;
    entry.value.set(field, newVal.toString());
    return newVal;
  }

  async hMSet(key: string, data: Record<string, string>): Promise<void> {
    for (const [field, value] of Object.entries(data)) {
      await this.hSet(key, field, value);
    }
  }

  // =========== Geospatial ===========

  async geoAdd(key: string, longitude: number, latitude: number, member: string): Promise<number> {
    let entry = this.store.get(key);

    if (!entry || entry.type !== 'geo') {
      entry = { value: new Map<string, { lng: number; lat: number }>(), type: 'geo' };
      this.store.set(key, entry);
    }

    const isNew = !entry.value.has(member);
    entry.value.set(member, { lng: longitude, lat: latitude });

    return isNew ? 1 : 0;
  }

  async geoRemove(key: string, member: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry || entry.type !== 'geo') return 0;
    return entry.value.delete(member) ? 1 : 0;
  }

  async geoPos(key: string, member: string): Promise<{ longitude: number; latitude: number } | null> {
    if (this.isExpired(key)) return null;
    const entry = this.store.get(key);
    if (!entry || entry.type !== 'geo') return null;

    const pos = entry.value.get(member);
    if (!pos) return null;

    return { longitude: pos.lng, latitude: pos.lat };
  }

  async geoRadius(key: string, longitude: number, latitude: number, radius: number, unit: 'km' | 'm'): Promise<GeoMember[]> {
    if (this.isExpired(key)) return [];
    const entry = this.store.get(key);
    if (!entry || entry.type !== 'geo') return [];

    const radiusMeters = unit === 'km' ? radius * 1000 : radius;
    const results: GeoMember[] = [];

    for (const [member, pos] of entry.value.entries()) {
      const distance = this.haversineDistance(latitude, longitude, pos.lat, pos.lng);

      if (distance <= radiusMeters) {
        results.push({
          member,
          distance: unit === 'km' ? distance / 1000 : distance,
          coordinates: { longitude: pos.lng, latitude: pos.lat }
        });
      }
    }

    results.sort((a, b) => (a.distance || 0) - (b.distance || 0));

    return results;
  }

  async geoRadiusByMember(key: string, member: string, radius: number, unit: 'km' | 'm'): Promise<GeoMember[]> {
    const pos = await this.geoPos(key, member);
    if (!pos) return [];
    return this.geoRadius(key, pos.longitude, pos.latitude, radius, unit);
  }

  private haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000;
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  private toRad(deg: number): number {
    return deg * (Math.PI / 180);
  }

  // =========== Pub/Sub ===========

  async publish(channel: string, message: string): Promise<number> {
    const subs = this.subscribers.get(channel);
    if (!subs || subs.size === 0) return 0;

    for (const callback of subs) {
      try {
        callback(message);
      } catch (e) {
        logger.error(`[Redis] Pub/Sub callback error: ${e}`);
      }
    }

    return subs.size;
  }

  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, new Set());
    }
    this.subscribers.get(channel)!.add(callback);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.subscribers.delete(channel);
  }

  // =========== Transactions ===========

  multi(): IRedisTransaction {
    return new InMemoryTransaction(this);
  }

  // =========== Lua Scripts ===========

  async eval(_script: string, _keys: string[], _args: string[]): Promise<unknown> {
    if (!this.evalWarned) {
      logger.error('[Redis] Lua scripts NOT supported in in-memory mode -- all atomic operations degraded');
      this.evalWarned = true;
    }
    return null;
  }

  async sAddWithExpire(key: string, ttlSeconds: number, ...members: string[]): Promise<void> {
    if (members.length === 0) return;
    await this.sAdd(key, ...members);
    await this.expire(key, ttlSeconds);
  }
}

// In-memory transaction
class InMemoryTransaction implements IRedisTransaction {
  private operations: Array<() => Promise<unknown>> = [];

  constructor(private client: InMemoryRedisClient) { }

  set(key: string, value: string): IRedisTransaction {
    this.operations.push(() => this.client.set(key, value));
    return this;
  }

  del(key: string): IRedisTransaction {
    this.operations.push(() => this.client.del(key));
    return this;
  }

  expire(key: string, ttlSeconds: number): IRedisTransaction {
    this.operations.push(() => this.client.expire(key, ttlSeconds));
    return this;
  }

  sAdd(key: string, ...members: string[]): IRedisTransaction {
    this.operations.push(() => this.client.sAdd(key, ...members));
    return this;
  }

  sRem(key: string, ...members: string[]): IRedisTransaction {
    this.operations.push(() => this.client.sRem(key, ...members));
    return this;
  }

  async exec(): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const op of this.operations) {
      results.push(await op());
    }
    return results;
  }
}
