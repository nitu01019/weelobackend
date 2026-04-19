/**
 * =============================================================================
 * ORDER BROADCAST QUERY SERVICE - Lookup, key helpers, and shared utilities
 * =============================================================================
 *
 * Extracted from order-broadcast.service.ts (file-split).
 * Contains: key helpers, transporter lookup (cached), buildRequestsByType,
 *           getNotifiedTransporters, markTransportersNotified, chunkTransporterIds,
 *           withEventMeta, clearCustomerActiveBroadcast, and related constants.
 *
 * IMPORTANT: This file must NOT import from order.service.ts or the facade
 * order-broadcast.service.ts to avoid circular dependencies.
 * =============================================================================
 */

import { db, TruckRequestRecord } from '../../shared/database/db';
import { logger } from '../../shared/services/logger.service';
import { cacheService } from '../../shared/services/cache.service';
import { transporterOnlineService } from '../../shared/services/transporter-online.service';
import { redisService } from '../../shared/services/redis.service';
import { BROADCAST_DEDUP_TTL_BUFFER_SECONDS } from '../../core/config/hold-config';
// M-04 FIX: Import shared helpers from single source of truth
import {
  withEventMeta,
  notifiedTransportersKey,
  makeVehicleGroupKey,
  parseVehicleGroupKey,
  buildRequestsByType,
  chunkTransporterIds as chunkTransporterIdsBase,
} from './order-broadcast-helpers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_KEYS = {
  TRANSPORTERS_BY_VEHICLE: 'trans:vehicle:',
};

const CACHE_TTL = {
  TRANSPORTERS: 300,
};

export const FF_BROADCAST_STRICT_SENT_ACCOUNTING = process.env.FF_BROADCAST_STRICT_SENT_ACCOUNTING !== 'false';

const BROADCAST_TIMEOUT_MS = parseInt(process.env.BROADCAST_TIMEOUT_SECONDS || '120', 10) * 1000;
const TRANSPORTER_FANOUT_CHUNK_SIZE = Math.min(500, Math.max(
  25,
  parseInt(process.env.ORDER_TRANSPORTER_FANOUT_QUEUE_CHUNK_SIZE || '500', 10) || 500
));

// ---------------------------------------------------------------------------
// Shared helpers — re-exported from order-broadcast-helpers.ts (M-04 FIX)
// ---------------------------------------------------------------------------

// Imported above for internal use; re-exported here for external consumers.
export { withEventMeta, notifiedTransportersKey, makeVehicleGroupKey, parseVehicleGroupKey, buildRequestsByType };

/**
 * Clear customer active broadcast key and associated idempotency keys.
 */
export async function clearCustomerActiveBroadcast(customerId: string): Promise<void> {
  const activeKey = `customer:active-broadcast:${customerId}`;
  await redisService.del(activeKey).catch((err: unknown) => {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to clear customer active broadcast key', { customerId, error: errorMessage });
  });
  // Clean up server-generated idempotency key
  const latestIdemKey = await redisService.get(`idem:broadcast:latest:${customerId}`).catch((): null => null);
  if (latestIdemKey) {
    await redisService.del(latestIdemKey).catch(() => { });
    await redisService.del(`idem:broadcast:latest:${customerId}`).catch(() => { });
  }
  // Clean up client-supplied idempotency key
  const latestClientIdemKey = await redisService.get(`idempotency:order:${customerId}:latest`).catch((): null => null);
  if (latestClientIdemKey) {
    await redisService.del(`idempotency:${customerId}:${latestClientIdemKey}`).catch(() => { });
    await redisService.del(`idempotency:order:${customerId}:latest`).catch(() => { });
  }
}

// Key helpers — re-exported above from order-broadcast-helpers.ts (M-04 FIX)

// ---------------------------------------------------------------------------
// Transporter lookup (cached)
// ---------------------------------------------------------------------------

/**
 * Get transporters by vehicle type (CACHED + AVAILABILITY FILTERED)
 */
export async function getTransportersByVehicleCached(
  vehicleType: string,
  vehicleSubtype: string
): Promise<string[]> {
  const cacheKey = `${CACHE_KEYS.TRANSPORTERS_BY_VEHICLE}${vehicleType}:${vehicleSubtype}`;

  let transporterIds: string[];

  try {
    const cached = await cacheService.get<string[]>(cacheKey);

    if (cached && Array.isArray(cached)) {
      logger.debug(`Cache HIT: ${cacheKey} (${cached.length} transporters)`);
      transporterIds = cached;
    } else {
      transporterIds = await db.getTransportersWithVehicleType(vehicleType, vehicleSubtype);
      await cacheService.set(cacheKey, transporterIds, CACHE_TTL.TRANSPORTERS);
      logger.debug(`Cache SET: ${cacheKey} (${transporterIds.length} transporters)`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Cache error for ${cacheKey}: ${message}. Falling back to DB.`);
    transporterIds = await db.getTransportersWithVehicleType(vehicleType, vehicleSubtype);
  }

  const availableTransporters = await transporterOnlineService.filterOnline(transporterIds);

  // Cap at 100 to prevent unbounded fan-out
  return availableTransporters.slice(0, 100);
}

/**
 * Invalidate transporter cache when vehicles change
 */
export async function invalidateTransporterCache(vehicleType: string, vehicleSubtype?: string): Promise<void> {
  if (vehicleSubtype) {
    await cacheService.delete(`${CACHE_KEYS.TRANSPORTERS_BY_VEHICLE}${vehicleType}:${vehicleSubtype}`);
  } else {
    const iterator = cacheService.scanIterator(`${CACHE_KEYS.TRANSPORTERS_BY_VEHICLE}${vehicleType}:*`);
    for await (const key of iterator) {
      await cacheService.delete(key);
    }
  }
  logger.debug(`Cache invalidated: transporters for ${vehicleType}${vehicleSubtype ? ':' + vehicleSubtype : ':*'}`);
}

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------

// buildRequestsByType — re-exported above from order-broadcast-helpers.ts (M-04 FIX)

export async function getNotifiedTransporters(orderId: string, vehicleType: string, vehicleSubtype: string): Promise<Set<string>> {
  const key = notifiedTransportersKey(orderId, vehicleType, vehicleSubtype);
  const members = await redisService.sMembers(key).catch(async (err: unknown) => {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn('[Broadcast] Redis SMEMBERS failed, falling back to DB', { orderId, error: errorMessage });
    try {
      const truckRequests = await db.getTruckRequestsByOrder(orderId);
      const dbNotified = new Set<string>();
      for (const tr of truckRequests) {
        if (Array.isArray(tr.notifiedTransporters)) {
          for (const tid of tr.notifiedTransporters) {
            dbNotified.add(tid);
          }
        }
      }
      return Array.from(dbNotified);
    } catch {
      return [];
    }
  });
  return new Set(members);
}

export async function markTransportersNotified(
  orderId: string,
  vehicleType: string,
  vehicleSubtype: string,
  transporterIds: string[]
): Promise<void> {
  if (transporterIds.length === 0) return;
  const key = notifiedTransportersKey(orderId, vehicleType, vehicleSubtype);
  const ttlSeconds = Math.ceil(BROADCAST_TIMEOUT_MS / 1000) + BROADCAST_DEDUP_TTL_BUFFER_SECONDS;
  await redisService.sAddWithExpire(key, ttlSeconds, ...transporterIds).catch((err: unknown) => {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn('[Broadcast] Failed to mark transporters as notified in Redis', { orderId, error: errorMessage });
  });
}

// M-04 FIX: Delegate to shared helper, binding the module-level chunk size
export function chunkTransporterIds(transporterIds: string[]): string[][] {
  return chunkTransporterIdsBase(transporterIds, TRANSPORTER_FANOUT_CHUNK_SIZE);
}
