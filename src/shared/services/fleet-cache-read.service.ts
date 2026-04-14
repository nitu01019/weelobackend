/**
 * =============================================================================
 * FLEET CACHE READ SERVICE - Vehicle & driver cache reads
 * =============================================================================
 *
 * Extracted from fleet-cache.service.ts (file-split).
 * Contains: getTransporterVehicles, getTransporterVehiclesByType,
 *           getAvailableVehicles, getVehicle, getTransporterDrivers,
 *           getAvailableDrivers, getDriver, getAvailabilitySnapshot, getStats.
 * =============================================================================
 */

import { cacheService } from './cache.service';
import { logger } from './logger.service';
import { db } from '../database/db';
import { prismaClient } from '../database/prisma.service';
import { redisService } from './redis.service';
import {
  CACHE_KEYS,
  CACHE_TTL,
  CachedVehicle,
  CachedDriver,
  AvailabilitySnapshot,
} from './fleet-cache-types';

// ===========================================================================
// VEHICLE CACHE METHODS
// ===========================================================================

export async function getTransporterVehicles(
  transporterId: string,
  forceRefresh: boolean = false
): Promise<CachedVehicle[]> {
  const cacheKey = CACHE_KEYS.VEHICLES(transporterId);

  if (!forceRefresh) {
    try {
      const cached = await cacheService.get<CachedVehicle[]>(cacheKey);
      if (cached && Array.isArray(cached)) {
        logger.debug(`[FleetCache] HIT: vehicles for ${transporterId.substring(0, 8)}`);
        return cached;
      }
      if (cached && !Array.isArray(cached)) {
        logger.warn(`[FleetCache] Corrupted cache (not array) for vehicles:${transporterId.substring(0, 8)}, deleting`);
        await cacheService.delete(cacheKey).catch(() => {});
      }
    } catch (error) {
      logger.warn(`[FleetCache] Cache read error: ${error}`);
    }
  }

  logger.debug(`[FleetCache] MISS: vehicles for ${transporterId.substring(0, 8)}, fetching from DB`);

  const dbResult = await db.getVehiclesByTransporter(transporterId);
  const dbVehicles = Array.isArray(dbResult) ? dbResult : await dbResult;

  if (!dbVehicles || !Array.isArray(dbVehicles)) {
    logger.warn(`[FleetCache] No vehicles found for ${transporterId.substring(0, 8)}`);
    return [];
  }

  const vehicles: CachedVehicle[] = dbVehicles.map(v => ({
    id: v.id,
    transporterId: v.transporterId,
    vehicleNumber: v.vehicleNumber,
    vehicleType: v.vehicleType,
    vehicleSubtype: v.vehicleSubtype || '',
    capacityTons: v.capacityTons || 0,
    status: v.status as any,
    currentTripId: v.currentTripId,
    assignedDriverId: v.assignedDriverId,
    isActive: v.isActive,
    lastUpdated: new Date().toISOString()
  }));

  try {
    await cacheService.set(cacheKey, vehicles, CACHE_TTL.VEHICLE_LIST);
    logger.debug(`[FleetCache] Cached ${vehicles.length} vehicles for ${transporterId.substring(0, 8)}`);
  } catch (error) {
    logger.warn(`[FleetCache] Cache write error: ${error}`);
  }

  return vehicles;
}

export async function getTransporterVehiclesByType(
  transporterId: string,
  vehicleType: string,
  vehicleSubtype?: string
): Promise<CachedVehicle[]> {
  const cacheKey = CACHE_KEYS.VEHICLES_BY_TYPE(transporterId, vehicleType, vehicleSubtype);

  try {
    const cached = await cacheService.get<CachedVehicle[]>(cacheKey);
    if (cached && Array.isArray(cached)) {
      logger.debug(`[FleetCache] HIT: ${vehicleType} vehicles for ${transporterId.substring(0, 8)}`);
      return cached;
    }
    if (cached && !Array.isArray(cached)) {
      logger.warn(`[FleetCache] Corrupted cache (not array) for vehiclesByType:${transporterId.substring(0, 8)}, deleting`);
      await cacheService.delete(cacheKey).catch(() => {});
    }
  } catch (error) {
    logger.warn(`[FleetCache] Cache read error: ${error}`);
  }

  const allVehicles = await getTransporterVehicles(transporterId);
  const filtered = allVehicles.filter(v => {
    const typeMatch = v.vehicleType.toLowerCase() === vehicleType.toLowerCase();
    const subtypeMatch = !vehicleSubtype ||
      v.vehicleSubtype.toLowerCase() === vehicleSubtype.toLowerCase();
    return typeMatch && subtypeMatch;
  });

  try {
    await cacheService.set(cacheKey, filtered, CACHE_TTL.VEHICLE_LIST);
  } catch (error) {
    logger.warn(`[FleetCache] Cache write error: ${error}`);
  }

  return filtered;
}

export async function getAvailableVehicles(
  transporterId: string,
  vehicleType?: string,
  vehicleSubtype?: string
): Promise<CachedVehicle[]> {
  const allVehicles = vehicleType
    ? await getTransporterVehiclesByType(transporterId, vehicleType, vehicleSubtype)
    : await getTransporterVehicles(transporterId);

  return allVehicles.filter(v => v.status === 'available' && v.isActive);
}

export async function getVehicle(vehicleId: string): Promise<CachedVehicle | null> {
  const cacheKey = CACHE_KEYS.VEHICLE(vehicleId);

  try {
    const cached = await cacheService.get<CachedVehicle>(cacheKey);
    if (cached && typeof cached === 'object' && cached.id) return cached;
    if (cached && (typeof cached !== 'object' || !cached.id)) {
      logger.warn(`[FleetCache] Corrupted cache for vehicle:${vehicleId.substring(0, 8)}, deleting`);
      await cacheService.delete(cacheKey).catch(() => {});
    }
  } catch (error) {
    logger.warn(`[FleetCache] Cache read error: ${error}`);
  }

  const dbResult = await db.getVehicleById(vehicleId);
  const vehicle = dbResult && typeof dbResult.then === 'function' ? await dbResult : dbResult;
  if (!vehicle) return null;

  const cachedVehicle: CachedVehicle = {
    id: vehicle.id,
    transporterId: vehicle.transporterId,
    vehicleNumber: vehicle.vehicleNumber,
    vehicleType: vehicle.vehicleType,
    vehicleSubtype: vehicle.vehicleSubtype || '',
    capacityTons: vehicle.capacityTons || 0,
    status: vehicle.status as any,
    currentTripId: vehicle.currentTripId,
    assignedDriverId: vehicle.assignedDriverId,
    isActive: vehicle.isActive,
    lastUpdated: new Date().toISOString()
  };

  try {
    await cacheService.set(cacheKey, cachedVehicle, CACHE_TTL.INDIVIDUAL);
  } catch (error) {
    logger.warn(`[FleetCache] Cache write error: ${error}`);
  }

  return cachedVehicle;
}

// ===========================================================================
// DRIVER CACHE METHODS
// ===========================================================================

export async function getTransporterDrivers(
  transporterId: string,
  forceRefresh: boolean = false
): Promise<CachedDriver[]> {
  const cacheKey = CACHE_KEYS.DRIVERS(transporterId);

  if (!forceRefresh) {
    try {
      const cached = await cacheService.get<CachedDriver[]>(cacheKey);
      if (cached && Array.isArray(cached)) {
        logger.debug(`[FleetCache] HIT: drivers for ${transporterId.substring(0, 8)}`);
        return cached;
      }
      if (cached && !Array.isArray(cached)) {
        logger.warn(`[FleetCache] Corrupted cache (not array) for drivers:${transporterId.substring(0, 8)}, deleting`);
        await cacheService.delete(cacheKey).catch(() => {});
      }
    } catch (error) {
      logger.warn(`[FleetCache] Cache read error: ${error}`);
    }
  }

  logger.debug(`[FleetCache] MISS: drivers for ${transporterId.substring(0, 8)}, fetching from DB`);

  let dbDrivers: Array<{ id: string; transporterId?: string; name: string; phone: string; profilePhotoUrl?: string; profilePhoto?: string; rating?: number; totalTrips?: number; status?: string; isAvailable?: boolean; currentTripId?: string }> = [];
  if (db.getDriversByTransporter) {
    const dbResult = await db.getDriversByTransporter(transporterId);
    dbDrivers = Array.isArray(dbResult) ? dbResult : await dbResult;
  }
  if (!dbDrivers || !Array.isArray(dbDrivers)) { dbDrivers = []; }

  // Real totalTrips from assignment records
  let tripCountMap: Record<string, number> = {};
  try {
    const driverIds = dbDrivers.map((d) => d.id);
    if (driverIds.length > 0) {
      const tripCounts = await prismaClient.assignment.groupBy({
        by: ['driverId'],
        where: { driverId: { in: driverIds }, status: 'completed' },
        _count: { id: true }
      });
      for (const tc of tripCounts) { tripCountMap[tc.driverId] = tc._count.id; }
    }
  } catch (err: unknown) {
    logger.warn(`[FleetCache] Failed to query real trip counts`, { error: err instanceof Error ? err.message : String(err) });
  }

  // Active assignment check
  let activeAssignmentMap: Record<string, string> = {};
  try {
    const allDriverIds = dbDrivers.map((d) => d.id);
    if (allDriverIds.length > 0) {
      const activeAssignments = await prismaClient.assignment.findMany({
        where: {
          driverId: { in: allDriverIds },
          status: { in: ['pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit'] }
        },
        select: { driverId: true, tripId: true }
      });
      for (const a of activeAssignments) { activeAssignmentMap[a.driverId] = a.tripId; }
      if (activeAssignments.length > 0) {
        logger.info(`[FleetCache] ${activeAssignments.length} driver(s) have active assignments`);
      }
    }
  } catch (err: unknown) {
    logger.warn(`[FleetCache] Failed to check active assignments`, { error: err instanceof Error ? err.message : String(err) });
  }

  // Real-time online status
  const driverIds = dbDrivers.map((d) => d.id);
  let onlineStatusMap: Record<string, boolean> = {};
  try {
    if (driverIds.length > 0) {
      const onlineChecks = await Promise.all(
        driverIds.map(async (id: string) => {
          const exists = await redisService.exists(`driver:presence:${id}`);
          return { id, online: exists };
        })
      );
      for (const check of onlineChecks) { onlineStatusMap[check.id] = check.online; }
    }
  } catch (err: unknown) {
    logger.warn(`[FleetCache] Failed to check online status`, { error: err instanceof Error ? err.message : String(err) });
  }

  const drivers: CachedDriver[] = dbDrivers.map((d) => ({
    id: d.id,
    transporterId: d.transporterId || transporterId,
    name: d.name,
    phone: d.phone,
    profilePhotoUrl: d.profilePhotoUrl || d.profilePhoto,
    rating: d.rating || 4.5,
    totalTrips: tripCountMap[d.id] || d.totalTrips || 0,
    status: (d.status || 'active') as 'inactive' | 'active' | 'suspended',
    isAvailable: d.isAvailable !== false,
    isOnline: (d.isAvailable !== false) && (onlineStatusMap[d.id] === true),
    currentTripId: d.currentTripId || activeAssignmentMap[d.id] || undefined,
    lastUpdated: new Date().toISOString()
  }));

  try {
    await cacheService.set(cacheKey, drivers, CACHE_TTL.DRIVER_LIST);
    logger.debug(`[FleetCache] Cached ${drivers.length} drivers for ${transporterId.substring(0, 8)}`);
  } catch (error) {
    logger.warn(`[FleetCache] Cache write error: ${error}`);
  }

  return drivers;
}

export async function getAvailableDrivers(transporterId: string): Promise<CachedDriver[]> {
  const allDrivers = await getTransporterDrivers(transporterId);
  // H15 FIX: Also check Redis presence to exclude ghost-online drivers
  return allDrivers.filter(d => d.status === 'active' && d.isAvailable && d.isOnline && !d.currentTripId);
}

export async function getDriver(driverId: string): Promise<CachedDriver | null> {
  const cacheKey = CACHE_KEYS.DRIVER(driverId);

  try {
    const cached = await cacheService.get<CachedDriver>(cacheKey);
    if (cached && typeof cached === 'object' && cached.id) return cached;
    if (cached && (typeof cached !== 'object' || !cached.id)) {
      logger.warn(`[FleetCache] Corrupted cache for driver:${driverId.substring(0, 8)}, deleting`);
      await cacheService.delete(cacheKey).catch(() => {});
    }
  } catch (error) {
    logger.warn(`[FleetCache] Cache read error: ${error}`);
  }

  const dbResult = await db.getUserById(driverId);
  const driver = dbResult && typeof dbResult.then === 'function' ? await dbResult : dbResult;
  if (!driver || driver.role !== 'driver') return null;

  let isOnline = false;
  try {
    const presenceExists = await redisService.exists(`driver:presence:${driverId}`);
    isOnline = (driver.isAvailable !== false) && presenceExists;
  } catch (err: unknown) {
    logger.warn(`[FleetCache] Failed to check online status for driver ${driverId}`, { error: err instanceof Error ? err.message : String(err) });
  }

  const cached: CachedDriver = {
    id: driver.id,
    transporterId: driver.transporterId || '',
    name: driver.name,
    phone: driver.phone,
    rating: driver.rating || 4.5,
    totalTrips: driver.totalTrips || 0,
    status: driver.status || 'active',
    isAvailable: driver.isAvailable !== false,
    isOnline,
    currentTripId: driver.currentTripId,
    lastUpdated: new Date().toISOString()
  };

  try {
    await cacheService.set(cacheKey, cached, CACHE_TTL.INDIVIDUAL);
  } catch (error) {
    logger.warn(`[FleetCache] Cache write error: ${error}`);
  }

  return cached;
}

// ===========================================================================
// AVAILABILITY SNAPSHOT (for broadcasts)
// ===========================================================================

export async function getAvailabilitySnapshot(
  transporterId: string,
  vehicleType: string,
  vehicleSubtype?: string
): Promise<AvailabilitySnapshot> {
  const cacheKey = CACHE_KEYS.AVAILABILITY_SNAPSHOT(transporterId, vehicleType);

  try {
    const cached = await cacheService.get<AvailabilitySnapshot>(cacheKey);
    if (cached && typeof cached === 'object' && cached.transporterId) return cached;
    if (cached && (typeof cached !== 'object' || !cached.transporterId)) {
      logger.warn(`[FleetCache] Corrupted cache for snapshot:${transporterId.substring(0, 8)}, deleting`);
      await cacheService.delete(cacheKey).catch(() => {});
    }
  } catch (error) {
    logger.warn(`[FleetCache] Cache read error: ${error}`);
  }

  const vehicles = await getTransporterVehiclesByType(transporterId, vehicleType, vehicleSubtype);
  const transporterResult = await db.getUserById(transporterId);
  const transporter = transporterResult && typeof transporterResult.then === 'function'
    ? await transporterResult : transporterResult;

  const snapshot: AvailabilitySnapshot = {
    transporterId,
    transporterName: transporter?.name || transporter?.businessName || 'Unknown',
    vehicleType,
    vehicleSubtype,
    totalOwned: vehicles.filter(v => v.isActive).length,
    available: vehicles.filter(v => v.status === 'available' && v.isActive).length,
    inTransit: vehicles.filter(v => v.status === 'in_transit').length,
    lastUpdated: new Date().toISOString()
  };

  try {
    await cacheService.set(cacheKey, snapshot, CACHE_TTL.SNAPSHOT);
  } catch (error) {
    logger.warn(`[FleetCache] Cache write error: ${error}`);
  }

  return snapshot;
}

// ===========================================================================
// CACHE STATS
// ===========================================================================

export async function getStats(): Promise<{
  vehicleKeys: number;
  driverKeys: number;
  snapshotKeys: number;
}> {
  try {
    let vehicleCount = 0;
    for await (const _ of cacheService.scanIterator('fleet:vehicle*')) { vehicleCount++; }
    let driverCount = 0;
    for await (const _ of cacheService.scanIterator('fleet:driver*')) { driverCount++; }
    let snapshotCount = 0;
    for await (const _ of cacheService.scanIterator('fleet:snapshot*')) { snapshotCount++; }
    return { vehicleKeys: vehicleCount, driverKeys: driverCount, snapshotKeys: snapshotCount };
  } catch (error) {
    logger.warn(`[FleetCache] Error getting stats: ${error}`);
    return { vehicleKeys: 0, driverKeys: 0, snapshotKeys: 0 };
  }
}
