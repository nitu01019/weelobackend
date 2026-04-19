/**
 * Redis module - Re-exports all Redis types, clients, and the singleton service.
 */

// Types
export type { IRedisClient, IRedisTransaction, GeoMember, LockResult, RedisConfig, RedisValue } from './redis.types';

// Client implementations
export { InMemoryRedisClient } from './in-memory-redis.client';
export { RealRedisClient } from './real-redis.client';

// Service facade
export { RedisService } from './redis.service';

// Singleton instance
import { RedisService } from './redis.service';
export const redisService = new RedisService();
