/**
 * =============================================================================
 * TRUCK HOLD STORE — Redis-Backed Distributed Hold Storage
 * =============================================================================
 *
 * Redis-backed holds store for distributed locking.
 *
 * CRITICAL FOR SCALABILITY:
 * - Atomic operations prevent race conditions
 * - TTL auto-expires holds (no cleanup needed)
 * - Works across multiple server instances
 * - Survives server restarts
 */

import { redisService } from '../../shared/services/redis.service';
import { logger } from '../../shared/services/logger.service';
import { TruckHold, TruckHoldRedis, CONFIG } from './truck-hold.types';

// =============================================================================
// REDIS KEYS - Distributed Locking for Truck Holds
// =============================================================================

/**
 * Redis key patterns for truck holds
 *
 * WHY REDIS IS MANDATORY HERE:
 * - Prevents double assignment (race conditions)
 * - Atomic SETNX operations for locking
 * - TTL auto-releases locks (no manual cleanup)
 * - Works across multiple server instances
 *
 * KEY PATTERNS:
 * - hold:{holdId}                    → Hold data (JSON, TTL: 180s / 3 min)
 * - hold:order:{orderId}             → Set of holdIds for this order
 * - hold:transporter:{transporterId} → Set of holdIds for this transporter
 *
 * FIX #40: Per-truck Redis locks (lock:truck:{truckRequestId}) removed.
 * Concurrency is now handled by PG SERIALIZABLE transactions.
 */
export const REDIS_KEYS = {
  HOLD: (holdId: string) => `hold:${holdId}`,
  HOLDS_BY_ORDER: (orderId: string) => `hold:order:${orderId}`,
  HOLDS_BY_TRANSPORTER: (transporterId: string) => `hold:transporter:${transporterId}`,
};

// =============================================================================
// REDIS-POWERED HOLD STORE
// =============================================================================

/**
 * Redis-backed holds store for distributed hold data and index management.
 *
 * FIX #40: Concurrency control is handled by PostgreSQL SERIALIZABLE
 * transactions in truck-hold-confirm.service.ts and truck-hold-release.service.ts.
 * The Redis-based acquireLock/releaseLock per-truck locking that was previously
 * in add() was vestigial -- holdStore.add() was never called from production code
 * (only tests). PG SERIALIZABLE transactions provide stronger guarantees.
 *
 * This store now serves as a cache/index layer:
 * - Hold data cache (JSON, TTL-based auto-expiry)
 * - Order/transporter index sets for fast lookups
 * - Best-effort cleanup on release (called from truck-hold-release.service.ts)
 */
class HoldStore {

  /**
   * Add hold data to Redis cache + indexes (no distributed locking).
   * Concurrency is handled by PG SERIALIZABLE transactions in the confirm/release services.
   */
  async add(hold: TruckHold): Promise<boolean> {
    try {
      // Store hold data
      const holdData: TruckHoldRedis = {
        ...hold,
        createdAt: hold.createdAt.toISOString(),
        expiresAt: hold.expiresAt.toISOString(),
      };

      // FIX #95: Align data TTL and index TTL to the same value to avoid index
      // entries pointing to expired data or data outliving its index entries.
      const holdTtl = CONFIG.HOLD_DURATION_SECONDS + 60;

      await redisService.setJSON(
        REDIS_KEYS.HOLD(hold.holdId),
        holdData,
        holdTtl
      );

      // Add to order index
      await redisService.sAdd(REDIS_KEYS.HOLDS_BY_ORDER(hold.orderId), hold.holdId);
      await redisService.expire(REDIS_KEYS.HOLDS_BY_ORDER(hold.orderId), holdTtl);

      // Add to transporter index
      await redisService.sAdd(REDIS_KEYS.HOLDS_BY_TRANSPORTER(hold.transporterId), hold.holdId);
      await redisService.expire(REDIS_KEYS.HOLDS_BY_TRANSPORTER(hold.transporterId), holdTtl);

      logger.info(`[HoldStore] Hold ${hold.holdId} stored in Redis cache`);
      return true;

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[HoldStore] Failed to add hold: ${message}`);
      return false;
    }
  }

  /**
   * Get hold by ID
   */
  async get(holdId: string): Promise<TruckHold | undefined> {
    try {
      const data = await redisService.getJSON<TruckHoldRedis>(REDIS_KEYS.HOLD(holdId));
      if (!data) return undefined;

      return {
        ...data,
        createdAt: new Date(data.createdAt),
        expiresAt: new Date(data.expiresAt),
      };
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Update hold status
   */
  async updateStatus(holdId: string, status: TruckHold['status']): Promise<void> {
    try {
      const hold = await this.get(holdId);
      if (!hold) return;

      const updated = { ...hold, status };

      const holdData: TruckHoldRedis = {
        ...updated,
        createdAt: updated.createdAt.toISOString(),
        expiresAt: updated.expiresAt.toISOString(),
      };

      // Get remaining TTL
      const ttl = await redisService.ttl(REDIS_KEYS.HOLD(holdId));
      await redisService.setJSON(REDIS_KEYS.HOLD(holdId), holdData, ttl > 0 ? ttl : 60);

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[HoldStore] Failed to update status: ${message}`);
    }
  }

  /**
   * Remove hold data and indexes from Redis cache.
   * FIX #40: No per-truck lock release needed -- PG SERIALIZABLE transactions
   * handle concurrency. This is best-effort cache cleanup only.
   */
  async remove(holdId: string): Promise<void> {
    try {
      const hold = await this.get(holdId);
      if (!hold) return;

      // Remove from indexes
      await redisService.sRem(REDIS_KEYS.HOLDS_BY_ORDER(hold.orderId), holdId);
      await redisService.sRem(REDIS_KEYS.HOLDS_BY_TRANSPORTER(hold.transporterId), holdId);

      // Delete hold data
      await redisService.del(REDIS_KEYS.HOLD(holdId));

      logger.info(`[HoldStore] Hold ${holdId} removed from Redis cache`);

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[HoldStore] Failed to remove hold: ${message}`);
    }
  }

  /**
   * Get all active holds for an order
   * FIX #91: Replaced O(N) sequential redis.get calls with a single pipeline batch fetch.
   */
  async getActiveHoldsByOrder(orderId: string): Promise<TruckHold[]> {
    try {
      const holdIds = await redisService.sMembers(REDIS_KEYS.HOLDS_BY_ORDER(orderId));
      if (holdIds.length === 0) return [];

      const keys = holdIds.map(id => REDIS_KEYS.HOLD(id));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawClient = redisService.getClient() as any;
      const pipeline = rawClient?.pipeline();
      if (!pipeline) return [];
      keys.forEach((k: string) => pipeline.get(k));
      const results: Array<[Error | null, string | null]> = await pipeline.exec();

      const now = new Date();
      const activeHolds: TruckHold[] = [];

      for (const [err, val] of results) {
        if (err || !val) continue;
        try {
          const data: TruckHoldRedis = JSON.parse(val);
          if (data.status === 'active' && new Date(data.expiresAt) > now) {
            activeHolds.push({
              ...data,
              createdAt: new Date(data.createdAt),
              expiresAt: new Date(data.expiresAt),
            });
          }
        } catch {
          // Malformed cache entry — skip
        }
      }

      return activeHolds;
    } catch (error) {
      return [];
    }
  }

  /**
   * Get active hold by transporter for a specific order/vehicle type
   */
  async getTransporterHold(
    transporterId: string,
    orderId: string,
    vehicleType: string,
    vehicleSubtype: string
  ): Promise<TruckHold | undefined> {
    try {
      const holdIds = await redisService.sMembers(REDIS_KEYS.HOLDS_BY_TRANSPORTER(transporterId));

      for (const holdId of holdIds) {
        const hold = await this.get(holdId);
        if (
          hold &&
          hold.status === 'active' &&
          hold.orderId === orderId &&
          hold.vehicleType.toLowerCase() === vehicleType.toLowerCase() &&
          hold.vehicleSubtype.toLowerCase() === vehicleSubtype.toLowerCase() &&
          new Date(hold.expiresAt) > new Date()
        ) {
          return hold;
        }
      }

      return undefined;
    } catch (error) {
      return undefined;
    }
  }
}

// Singleton store instance
export const holdStore = new HoldStore();
