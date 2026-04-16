/**
 * =============================================================================
 * FLEET CACHE WRITE SERVICE - Invalidation, status updates, hooks
 * =============================================================================
 *
 * Extracted from fleet-cache.service.ts (file-split).
 * Contains: invalidateVehicleCache, invalidateDriverCache, invalidateOnTripChange,
 *           updateVehicleStatus, updateDriverAvailability, clearAll,
 *           onVehicleChange, onDriverChange, onTripChange hooks.
 * =============================================================================
 */

import { cacheService } from './cache.service';
import { logger } from './logger.service';
import {
  CACHE_KEYS,
  CACHE_TTL,
  FLEET_CACHE_PREFIX,
  CachedVehicle,
  CachedDriver,
} from './fleet-cache-types';

// F-B-03: Tracking-shape regex — matches `fleet:index:transporters` and
// `fleet:{uuid}` active-driver sets. Used as defensive deny-list in clearAll.
const TRACKING_KEY_DENYLIST = /^fleet:(index:transporters|[0-9a-f]{8}-[0-9a-f]{4}-)/i;

// ===========================================================================
// CACHE INVALIDATION
// ===========================================================================

export async function invalidateVehicleCache(transporterId: string, vehicleId?: string): Promise<void> {
  logger.info(`[FleetCache] Invalidating vehicle cache for ${transporterId.substring(0, 8)}`);

  const keysToDelete = [
    CACHE_KEYS.VEHICLES(transporterId),
    CACHE_KEYS.VEHICLES_AVAILABLE(transporterId)
  ];

  try {
    const iterator = cacheService.scanIterator(`fleetcache:vehicles:${transporterId}:type:*`);
    for await (const key of iterator) { keysToDelete.push(key); }
  } catch (error) {
    logger.warn(`[FleetCache] Error getting pattern keys: ${error}`);
  }

  try {
    const iterator = cacheService.scanIterator(`fleetcache:snapshot:${transporterId}:*`);
    for await (const key of iterator) { keysToDelete.push(key); }
  } catch (error) {
    logger.warn(`[FleetCache] Error getting snapshot keys: ${error}`);
  }

  if (vehicleId) { keysToDelete.push(CACHE_KEYS.VEHICLE(vehicleId)); }

  for (const key of keysToDelete) {
    try { await cacheService.delete(key); }
    catch (error) { logger.warn(`[FleetCache] Error deleting key ${key}: ${error}`); }
  }

  logger.debug(`[FleetCache] Invalidated ${keysToDelete.length} cache keys`);
}

export async function invalidateDriverCache(transporterId: string, driverId?: string): Promise<void> {
  logger.info(`[FleetCache] Invalidating driver cache for ${transporterId.substring(0, 8)}`);

  const keysToDelete = [
    CACHE_KEYS.DRIVERS(transporterId),
    CACHE_KEYS.DRIVERS_AVAILABLE(transporterId)
  ];

  if (driverId) { keysToDelete.push(CACHE_KEYS.DRIVER(driverId)); }

  for (const key of keysToDelete) {
    try { await cacheService.delete(key); }
    catch (error) { logger.warn(`[FleetCache] Error deleting key ${key}: ${error}`); }
  }

  logger.debug(`[FleetCache] Invalidated ${keysToDelete.length} driver cache keys`);
}

export async function invalidateOnTripChange(
  transporterId: string,
  vehicleId: string,
  driverId: string
): Promise<void> {
  logger.info(`[FleetCache] Invalidating fleet cache on trip change`);
  await Promise.all([
    invalidateVehicleCache(transporterId, vehicleId),
    invalidateDriverCache(transporterId, driverId)
  ]);
}

// ===========================================================================
// TARGETED CACHE UPDATES
// ===========================================================================

export async function updateVehicleStatus(
  vehicleId: string,
  status: 'available' | 'on_hold' | 'in_transit' | 'maintenance' | 'inactive',
  tripId?: string
): Promise<void> {
  const cacheKey = CACHE_KEYS.VEHICLE(vehicleId);

  try {
    const vehicle = await cacheService.get<CachedVehicle>(cacheKey);
    if (vehicle) {
      vehicle.status = status;
      vehicle.currentTripId = tripId;
      vehicle.lastUpdated = new Date().toISOString();
      await cacheService.set(cacheKey, vehicle, CACHE_TTL.INDIVIDUAL);
      await invalidateVehicleCache(vehicle.transporterId);
      logger.debug(`[FleetCache] Updated vehicle ${vehicleId} status to ${status}`);
    }
  } catch (error) {
    logger.warn(`[FleetCache] Error updating vehicle status: ${error}`);
  }
}

export async function updateDriverAvailability(
  driverId: string,
  isAvailable: boolean,
  tripId?: string
): Promise<void> {
  const cacheKey = CACHE_KEYS.DRIVER(driverId);

  try {
    const driver = await cacheService.get<CachedDriver>(cacheKey);
    if (driver) {
      driver.isAvailable = isAvailable;
      driver.currentTripId = tripId;
      driver.lastUpdated = new Date().toISOString();
      await cacheService.set(cacheKey, driver, CACHE_TTL.INDIVIDUAL);
      await invalidateDriverCache(driver.transporterId);
      logger.debug(`[FleetCache] Updated driver ${driverId} availability to ${isAvailable}`);
    }
  } catch (error) {
    logger.warn(`[FleetCache] Error updating driver availability: ${error}`);
  }
}

// ===========================================================================
// CLEAR ALL
// ===========================================================================

export async function clearAll(): Promise<void> {
  logger.warn('[FleetCache] Clearing ALL fleet caches');
  try {
    // F-B-03: Scan only the FleetCache-owned prefix + defensive deny-list.
    const iterator = cacheService.scanIterator(`${FLEET_CACHE_PREFIX}*`);
    let count = 0;
    let skipped = 0;
    for await (const key of iterator) {
      if (TRACKING_KEY_DENYLIST.test(key)) {
        logger.error(`[FleetCache] fleetcache_refuse_tracking_key: refused to delete tracking-shaped key under fleetcache scan: ${key}`);
        skipped++;
        continue;
      }
      await cacheService.delete(key);
      count++;
    }
    logger.info(`[FleetCache] Cleared ${count} cache entries (skipped=${skipped})`);
  } catch (error) {
    logger.error(`[FleetCache] Error clearing caches: ${error}`);
  }
}

// ===========================================================================
// AUTO-UPDATE HOOKS
// ===========================================================================

export async function onVehicleChange(transporterId: string, vehicleId: string): Promise<void> {
  await invalidateVehicleCache(transporterId, vehicleId);
}

export async function onDriverChange(transporterId: string, driverId: string): Promise<void> {
  await invalidateDriverCache(transporterId, driverId);
}

export async function onTripChange(
  transporterId: string,
  vehicleId: string,
  driverId: string,
  newVehicleStatus: 'available' | 'in_transit',
  tripId?: string
): Promise<void> {
  await Promise.all([
    updateVehicleStatus(vehicleId, newVehicleStatus, tripId),
    updateDriverAvailability(driverId, newVehicleStatus === 'available', tripId)
  ]);
  await invalidateOnTripChange(transporterId, vehicleId, driverId);
}
