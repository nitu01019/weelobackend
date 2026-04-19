/**
 * =============================================================================
 * FLEET CACHE SERVICE - Redis Caching for Vehicles & Drivers
 * =============================================================================
 * 
 * WHAT THIS DOES:
 * - Caches transporter's vehicles for fast truck selection
 * - Caches transporter's drivers for fast driver assignment
 * - Auto-updates cache when data changes (create, update, delete)
 * - Provides filtered queries (by vehicle type, availability, etc.)
 * 
 * WHY REDIS CACHING?
 * - Database queries for vehicles/drivers are expensive at scale
 * - Truck selection page needs fast response (<100ms)
 * - Driver assignment page needs fast response (<100ms)
 * - Millions of concurrent requests need shared cache across servers
 * 
 * CACHE STRUCTURE (F-B-03: FleetCache owns `fleetcache:*`; tracking owns `fleet:*`):
 * ─────────────────────────────────────────────────────────────────────────────
 * VEHICLES:
 *   fleetcache:vehicles:{transporterId}         → JSON array of all vehicles
 *   fleetcache:vehicles:{transporterId}:type:{vehicleType} → Filtered by type
 *   fleetcache:vehicles:available:{transporterId} → Only available vehicles
 *
 * DRIVERS:
 *   fleetcache:drivers:{transporterId}          → JSON array of all drivers
 *   fleetcache:drivers:available:{transporterId} → Only available drivers
 *
 * INDEXES (for fast lookups):
 *   fleetcache:vehicle:{vehicleId}              → Single vehicle details
 *   fleetcache:driver:{driverId}                → Single driver details
 * 
 * TTL:
 *   - Vehicle list: 5 minutes (300 seconds)
 *   - Driver list: 5 minutes (300 seconds)
 *   - Individual vehicle/driver: 10 minutes (600 seconds)
 * 
 * AUTO-UPDATE TRIGGERS:
 * ─────────────────────────────────────────────────────────────────────────────
 * - Vehicle created → Invalidate transporter's vehicle cache
 * - Vehicle updated → Invalidate + update individual vehicle
 * - Vehicle status changed → Invalidate available vehicles cache
 * - Driver created → Invalidate transporter's driver cache
 * - Driver status changed → Invalidate available drivers cache
 * - Trip assigned → Update vehicle & driver availability caches
 * - Trip completed → Update vehicle & driver availability caches
 * 
 * SCALABILITY:
 * ─────────────────────────────────────────────────────────────────────────────
 * - Cache-aside pattern (lazy loading)
 * - TTL-based expiration (prevents stale data)
 * - Event-driven invalidation (immediate consistency when needed)
 * - Fallback to database on cache miss
 * 
 * USAGE:
 * ```typescript
 * import { fleetCacheService } from './fleet-cache.service';
 * 
 * // Get cached vehicles (fast)
 * const vehicles = await fleetCacheService.getTransporterVehicles(transporterId);
 * 
 * // Get filtered by type
 * const openTrucks = await fleetCacheService.getTransporterVehiclesByType(
 *   transporterId, 'Open', '17ft'
 * );
 * 
 * // Invalidate on update
 * await fleetCacheService.invalidateVehicleCache(transporterId, vehicleId);
 * ```
 * 
 * @author Weelo Team
 * @version 1.0.0
 * =============================================================================
 */

import { cacheService } from './cache.service';
import { logger } from './logger.service';
import { db } from '../database/db';
import { prismaClient } from '../database/prisma.service';
import { redisService } from './redis.service';
// F-B-02 Phase A: constants + shapes now live in fleet-cache-types.ts (single
// source of truth). Local duplicates removed; the class below is marked
// @deprecated — callers should migrate to the free-function module
// (fleet-cache-read.service.ts / fleet-cache-write.service.ts) in Phase C.
import {
  FLEET_CACHE_PREFIX,
  CACHE_KEYS,
  CACHE_TTL,
  CachedVehicle,
  CachedDriver,
  AvailabilitySnapshot,
} from './fleet-cache-types';

// =============================================================================
// FLEET CACHE SERVICE (@deprecated — see F-B-02 Phase C for deletion plan)
// =============================================================================

/**
 * @deprecated F-B-02: constants moved to `fleet-cache-types.ts`; split read
 *   and write helpers live in `fleet-cache-read.service.ts` and
 *   `fleet-cache-write.service.ts`. This class remains as a thin compatibility
 *   wrapper for one release to avoid a disruptive change across the ~20 call
 *   sites. Phase C (follow-up PR) replaces the wrapper with a re-export of
 *   the free-function API and then removes this file.
 */
class FleetCacheService {

  /**
   * F-B-03: Prefixes owned by this service. Boot-time assertion in server.ts
   * enumerates these across services and throws on overlap.
   */
  readonly registeredPrefixes: readonly string[] = [FLEET_CACHE_PREFIX];

  // ===========================================================================
  // VEHICLE CACHE METHODS
  // ===========================================================================

  /**
   * Get all vehicles for a transporter (cached)
   * 
   * @param transporterId - The transporter's ID
   * @param forceRefresh - Force database fetch (bypass cache)
   * @returns Array of cached vehicles
   */
  async getTransporterVehicles(
    transporterId: string,
    forceRefresh: boolean = false
  ): Promise<CachedVehicle[]> {
    const cacheKey = CACHE_KEYS.VEHICLES(transporterId);

    // Check cache first (unless force refresh)
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

    // Cache miss - fetch from database
    logger.debug(`[FleetCache] MISS: vehicles for ${transporterId.substring(0, 8)}, fetching from DB`);

    // IMPORTANT: db.getVehiclesByTransporter may return a Promise (Prisma) or array (JSON db)
    // We need to handle both cases
    const dbResult = await db.getVehiclesByTransporter(transporterId);
    const dbVehicles = Array.isArray(dbResult) ? dbResult : await dbResult;

    // Handle case where result is null/undefined
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

    // Store in cache
    try {
      await cacheService.set(cacheKey, vehicles, CACHE_TTL.VEHICLE_LIST);
      logger.debug(`[FleetCache] Cached ${vehicles.length} vehicles for ${transporterId.substring(0, 8)}`);
    } catch (error) {
      logger.warn(`[FleetCache] Cache write error: ${error}`);
    }

    return vehicles;
  }

  /**
   * Get vehicles filtered by type (cached)
   * 
   * @param transporterId - The transporter's ID
   * @param vehicleType - Vehicle type (e.g., "Open", "Container")
   * @param vehicleSubtype - Optional subtype (e.g., "17ft", "20-24 Ton")
   * @returns Filtered array of vehicles
   */
  async getTransporterVehiclesByType(
    transporterId: string,
    vehicleType: string,
    vehicleSubtype?: string
  ): Promise<CachedVehicle[]> {
    const cacheKey = CACHE_KEYS.VEHICLES_BY_TYPE(transporterId, vehicleType, vehicleSubtype);

    // Check cache first
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

    // Cache miss - get all vehicles and filter
    const allVehicles = await this.getTransporterVehicles(transporterId);

    const filtered = allVehicles.filter(v => {
      const typeMatch = v.vehicleType.toLowerCase() === vehicleType.toLowerCase();
      const subtypeMatch = !vehicleSubtype ||
        v.vehicleSubtype.toLowerCase() === vehicleSubtype.toLowerCase();
      return typeMatch && subtypeMatch;
    });

    // Store filtered result in cache
    try {
      await cacheService.set(cacheKey, filtered, CACHE_TTL.VEHICLE_LIST);
    } catch (error) {
      logger.warn(`[FleetCache] Cache write error: ${error}`);
    }

    return filtered;
  }

  /**
   * Get only available vehicles (cached)
   * 
   * @param transporterId - The transporter's ID
   * @param vehicleType - Optional filter by type
   * @param vehicleSubtype - Optional filter by subtype
   * @returns Available vehicles only
   */
  async getAvailableVehicles(
    transporterId: string,
    vehicleType?: string,
    vehicleSubtype?: string
  ): Promise<CachedVehicle[]> {
    // Get all vehicles (cached)
    const allVehicles = vehicleType
      ? await this.getTransporterVehiclesByType(transporterId, vehicleType, vehicleSubtype)
      : await this.getTransporterVehicles(transporterId);

    // Filter for available only
    return allVehicles.filter(v => v.status === 'available' && v.isActive);
  }

  /**
   * Get single vehicle (cached)
   */
  async getVehicle(vehicleId: string): Promise<CachedVehicle | null> {
    const cacheKey = CACHE_KEYS.VEHICLE(vehicleId);

    try {
      const cached = await cacheService.get<CachedVehicle>(cacheKey);
      if (cached && typeof cached === 'object' && cached.id) {
        return cached;
      }
      if (cached && (typeof cached !== 'object' || !cached.id)) {
        logger.warn(`[FleetCache] Corrupted cache for vehicle:${vehicleId.substring(0, 8)}, deleting`);
        await cacheService.delete(cacheKey).catch(() => {});
      }
    } catch (error) {
      logger.warn(`[FleetCache] Cache read error: ${error}`);
    }

    // Fetch from DB - handle both sync (JSON) and async (Prisma)
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

  /**
   * Get all drivers for a transporter (cached)
   */
  async getTransporterDrivers(
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

    // Cache miss - fetch from database
    logger.debug(`[FleetCache] MISS: drivers for ${transporterId.substring(0, 8)}, fetching from DB`);

    // Handle both sync (JSON) and async (Prisma) database calls
    let dbDrivers: any[] = [];
    if (db.getDriversByTransporter) {
      const dbResult = await db.getDriversByTransporter(transporterId);
      dbDrivers = Array.isArray(dbResult) ? dbResult : await dbResult;
    }

    // Handle null/undefined
    if (!dbDrivers || !Array.isArray(dbDrivers)) {
      dbDrivers = [];
    }

    // =========================================================================
    // REAL totalTrips FROM ASSIGNMENT RECORDS (Phase 5 — no more hardcoded 0)
    // =========================================================================
    // Batch-query completed assignment counts for all drivers in parallel.
    // Uses @@index([driverId, status]) — O(log n) per query, sub-50ms.
    // Graceful fallback: if Prisma fails, uses 0 (dashboard still loads).
    // =========================================================================
    let tripCountMap: Record<string, number> = {};
    try {
      const driverIds = dbDrivers.map((d: any) => d.id);
      if (driverIds.length > 0) {
        const tripCounts = await prismaClient.assignment.groupBy({
          by: ['driverId'],
          where: { driverId: { in: driverIds }, status: 'completed' },
          _count: { id: true }
        });
        for (const tc of tripCounts) {
          tripCountMap[tc.driverId] = tc._count.id;
        }
      }
    } catch (err: any) {
      logger.warn(`[FleetCache] Failed to query real trip counts, using fallback`, { error: err.message });
    }

    // =========================================================================
    // ACTIVE ASSIGNMENT CHECK — Prevent assigning drivers with pending jobs
    // =========================================================================
    // A driver may have currentTripId=null in the User table (no trip running)
    // but still have a 'pending' Assignment row from a previous hold/confirm.
    // The @@unique([driverId, status]) constraint would block a new create.
    // Industry standard (Uber/Ola): check assignment table at listing time.
    // Uses @@index([driverId, status]) — O(log n), sub-50ms.
    // =========================================================================
    let activeAssignmentMap: Record<string, string> = {};
    try {
      const allDriverIds = dbDrivers.map((d: any) => d.id);
      if (allDriverIds.length > 0) {
        const activeAssignments = await prismaClient.assignment.findMany({
          where: {
            driverId: { in: allDriverIds },
            status: { in: ['pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit'] }
          },
          select: { driverId: true, tripId: true }
        });
        for (const a of activeAssignments) {
          activeAssignmentMap[a.driverId] = a.tripId;
        }
        if (activeAssignments.length > 0) {
          logger.info(`[FleetCache] ${activeAssignments.length} driver(s) have active assignments — excluded from available list`);
        }
      }
    } catch (err: any) {
      logger.warn(`[FleetCache] Failed to check active assignments, using fallback`, { error: err.message });
    }

    // =========================================================================
    // REAL-TIME ONLINE STATUS — Check Redis presence for each driver
    // =========================================================================
    // Driver is ONLINE if: DB isAvailable=true AND Redis presence key exists
    // This prevents ghost-online (DB says online but driver crashed).
    // Batch check is efficient — Promise.all runs in parallel.
    // =========================================================================
    const driverIds = dbDrivers.map((d: any) => d.id);
    let onlineStatusMap: Record<string, boolean> = {};
    try {
      if (driverIds.length > 0) {
        const onlineChecks = await Promise.all(
          driverIds.map(async (id: string) => {
            const exists = await redisService.exists(`driver:presence:${id}`);
            return { id, online: exists };
          })
        );
        for (const check of onlineChecks) {
          onlineStatusMap[check.id] = check.online;
        }
      }
    } catch (err: any) {
      logger.warn(`[FleetCache] Failed to check online status, using fallback`, { error: err.message });
    }

    const drivers: CachedDriver[] = dbDrivers.map((d: any) => ({
      id: d.id,
      transporterId: d.transporterId || transporterId,
      name: d.name,
      phone: d.phone,
      profilePhotoUrl: d.profilePhotoUrl || d.profilePhoto, // Support both field names
      rating: d.rating || 4.5, // Placeholder until customer rating system
      totalTrips: tripCountMap[d.id] || d.totalTrips || 0,
      status: d.status || 'active',
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

  /**
   * Get only available drivers (cached)
   */
  async getAvailableDrivers(transporterId: string): Promise<CachedDriver[]> {
    const allDrivers = await this.getTransporterDrivers(transporterId);
    return allDrivers.filter(d => d.status === 'active' && d.isAvailable && !d.currentTripId);
  }

  /**
   * Get single driver (cached)
   */
  async getDriver(driverId: string): Promise<CachedDriver | null> {
    const cacheKey = CACHE_KEYS.DRIVER(driverId);

    try {
      const cached = await cacheService.get<CachedDriver>(cacheKey);
      if (cached && typeof cached === 'object' && cached.id) {
        return cached;
      }
      if (cached && (typeof cached !== 'object' || !cached.id)) {
        logger.warn(`[FleetCache] Corrupted cache for driver:${driverId.substring(0, 8)}, deleting`);
        await cacheService.delete(cacheKey).catch(() => {});
      }
    } catch (error) {
      logger.warn(`[FleetCache] Cache read error: ${error}`);
    }

    // Fetch from DB - handle both sync (JSON) and async (Prisma)
    const dbResult = await db.getUserById(driverId);
    const driver = dbResult && typeof dbResult.then === 'function' ? await dbResult : dbResult;
    if (!driver || driver.role !== 'driver') return null;

    // Check Redis presence for online status
    let isOnline = false;
    try {
      const presenceExists = await redisService.exists(`driver:presence:${driverId}`);
      isOnline = (driver.isAvailable !== false) && presenceExists;
    } catch (err: any) {
      logger.warn(`[FleetCache] Failed to check online status for driver ${driverId}`, { error: err.message });
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

  /**
   * Get availability snapshot for a transporter (used in broadcasts)
   * This is the data sent to each transporter showing their capacity
   */
  async getAvailabilitySnapshot(
    transporterId: string,
    vehicleType: string,
    vehicleSubtype?: string
  ): Promise<AvailabilitySnapshot> {
    const cacheKey = CACHE_KEYS.AVAILABILITY_SNAPSHOT(transporterId, vehicleType);

    try {
      const cached = await cacheService.get<AvailabilitySnapshot>(cacheKey);
      if (cached && typeof cached === 'object' && cached.transporterId) {
        return cached;
      }
      if (cached && (typeof cached !== 'object' || !cached.transporterId)) {
        logger.warn(`[FleetCache] Corrupted cache for snapshot:${transporterId.substring(0, 8)}, deleting`);
        await cacheService.delete(cacheKey).catch(() => {});
      }
    } catch (error) {
      logger.warn(`[FleetCache] Cache read error: ${error}`);
    }

    // Calculate snapshot
    const vehicles = await this.getTransporterVehiclesByType(transporterId, vehicleType, vehicleSubtype);

    // Handle both sync (JSON) and async (Prisma) database calls
    const transporterResult = await db.getUserById(transporterId);
    const transporter = transporterResult && typeof transporterResult.then === 'function'
      ? await transporterResult
      : transporterResult;

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
  // CACHE INVALIDATION (Auto-Update)
  // ===========================================================================

  /**
   * Invalidate vehicle cache when vehicle data changes
   * Call this after: create, update, delete vehicle
   */
  async invalidateVehicleCache(transporterId: string, vehicleId?: string): Promise<void> {
    logger.info(`[FleetCache] Invalidating vehicle cache for ${transporterId.substring(0, 8)}`);

    const keysToDelete = [
      CACHE_KEYS.VEHICLES(transporterId),
      CACHE_KEYS.VEHICLES_AVAILABLE(transporterId)
    ];

    // Also delete type-specific caches (we don't know which types changed)
    try {
      const iterator = cacheService.scanIterator(`fleetcache:vehicles:${transporterId}:type:*`);
      for await (const key of iterator) {
        keysToDelete.push(key);
      }
    } catch (error) {
      logger.warn(`[FleetCache] Error getting pattern keys: ${error}`);
    }

    // Delete snapshot caches
    try {
      const iterator = cacheService.scanIterator(`fleetcache:snapshot:${transporterId}:*`);
      for await (const key of iterator) {
        keysToDelete.push(key);
      }
    } catch (error) {
      logger.warn(`[FleetCache] Error getting snapshot keys: ${error}`);
    }

    // Delete individual vehicle cache
    if (vehicleId) {
      keysToDelete.push(CACHE_KEYS.VEHICLE(vehicleId));
    }

    // Delete all keys
    for (const key of keysToDelete) {
      try {
        await cacheService.delete(key);
      } catch (error) {
        logger.warn(`[FleetCache] Error deleting key ${key}: ${error}`);
      }
    }

    logger.debug(`[FleetCache] Invalidated ${keysToDelete.length} cache keys`);
  }

  /**
   * Invalidate driver cache when driver data changes
   * Call this after: create, update, delete driver
   */
  async invalidateDriverCache(transporterId: string, driverId?: string): Promise<void> {
    logger.info(`[FleetCache] Invalidating driver cache for ${transporterId.substring(0, 8)}`);

    const keysToDelete = [
      CACHE_KEYS.DRIVERS(transporterId),
      CACHE_KEYS.DRIVERS_AVAILABLE(transporterId)
    ];

    // Delete individual driver cache
    if (driverId) {
      keysToDelete.push(CACHE_KEYS.DRIVER(driverId));
    }

    for (const key of keysToDelete) {
      try {
        await cacheService.delete(key);
      } catch (error) {
        logger.warn(`[FleetCache] Error deleting key ${key}: ${error}`);
      }
    }

    logger.debug(`[FleetCache] Invalidated ${keysToDelete.length} driver cache keys`);
  }

  /**
   * Invalidate both vehicle and driver cache on trip assignment
   * Call this when: trip assigned, trip completed, trip cancelled
   */
  async invalidateOnTripChange(
    transporterId: string,
    vehicleId: string,
    driverId: string
  ): Promise<void> {
    logger.info(`[FleetCache] Invalidating fleet cache on trip change`);

    await Promise.all([
      this.invalidateVehicleCache(transporterId, vehicleId),
      this.invalidateDriverCache(transporterId, driverId)
    ]);
  }

  /**
   * Update single vehicle status in cache (for real-time updates)
   * More efficient than full invalidation for status changes
   */
  async updateVehicleStatus(
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

        // Also invalidate list caches for this transporter
        await this.invalidateVehicleCache(vehicle.transporterId);

        logger.debug(`[FleetCache] Updated vehicle ${vehicleId} status to ${status}`);
      }
    } catch (error) {
      logger.warn(`[FleetCache] Error updating vehicle status: ${error}`);
    }
  }

  /**
   * Update single driver availability in cache
   */
  async updateDriverAvailability(
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

        // Also invalidate list caches for this transporter
        await this.invalidateDriverCache(driver.transporterId);

        logger.debug(`[FleetCache] Updated driver ${driverId} availability to ${isAvailable}`);
      }
    } catch (error) {
      logger.warn(`[FleetCache] Error updating driver availability: ${error}`);
    }
  }

  // ===========================================================================
  // CACHE STATS & MONITORING
  // ===========================================================================

  /**
   * Get cache statistics for monitoring
   */
  async getStats(): Promise<{
    vehicleKeys: number;
    driverKeys: number;
    snapshotKeys: number;
  }> {
    try {
      let vehicleCount = 0;
      for await (const _ of cacheService.scanIterator('fleetcache:vehicle*')) {
        vehicleCount++;
      }

      let driverCount = 0;
      for await (const _ of cacheService.scanIterator('fleetcache:driver*')) {
        driverCount++;
      }

      let snapshotCount = 0;
      for await (const _ of cacheService.scanIterator('fleetcache:snapshot*')) {
        snapshotCount++;
      }

      return {
        vehicleKeys: vehicleCount,
        driverKeys: driverCount,
        snapshotKeys: snapshotCount
      };
    } catch (error) {
      logger.warn(`[FleetCache] Error getting stats: ${error}`);
      return { vehicleKeys: 0, driverKeys: 0, snapshotKeys: 0 };
    }
  }

  /**
   * Clear all fleet caches (use with caution).
   *
   * F-B-03: Scan only the `fleetcache:*` prefix (FleetCache-owned) and additionally
   * refuse to delete any key that resembles a tracking-owned `fleet:*` key
   * (fleet:index:transporters or fleet:{uuid} active-driver sets). This is a
   * fail-closed defense-in-depth against prefix-glob regressions.
   */
  async clearAll(): Promise<void> {
    logger.warn('[FleetCache] Clearing ALL fleet caches');

    try {
      const iterator = cacheService.scanIterator(`${FLEET_CACHE_PREFIX}*`);
      let count = 0;
      let skipped = 0;
      for await (const key of iterator) {
        if (TRACKING_KEY_DENYLIST.test(key)) {
          // Fail-closed: refuse to delete tracking-owned keys even if a regression
          // routes them under the fleetcache prefix.
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
}

// F-B-03: Tracking-shape regex — matches `fleet:index:transporters` and
// `fleet:{uuid}` active-driver sets. Used as defensive deny-list in clearAll.
const TRACKING_KEY_DENYLIST = /^fleet:(index:transporters|[0-9a-f]{8}-[0-9a-f]{4}-)/i;

// =============================================================================
// EXPORT SINGLETON
// =============================================================================

export const fleetCacheService = new FleetCacheService();

// =============================================================================
// AUTO-UPDATE HOOKS (Call these from other services)
// =============================================================================

/**
 * Hook to call when vehicle is created/updated/deleted
 */
export async function onVehicleChange(transporterId: string, vehicleId: string): Promise<void> {
  await fleetCacheService.invalidateVehicleCache(transporterId, vehicleId);
}

/**
 * Hook to call when driver is created/updated/deleted
 */
export async function onDriverChange(transporterId: string, driverId: string): Promise<void> {
  await fleetCacheService.invalidateDriverCache(transporterId, driverId);
}

/**
 * Hook to call when trip status changes
 */
export async function onTripChange(
  transporterId: string,
  vehicleId: string,
  driverId: string,
  newVehicleStatus: 'available' | 'in_transit',
  tripId?: string
): Promise<void> {
  // Update individual items first (fast)
  await Promise.all([
    fleetCacheService.updateVehicleStatus(vehicleId, newVehicleStatus, tripId),
    fleetCacheService.updateDriverAvailability(driverId, newVehicleStatus === 'available', tripId)
  ]);

  // Then invalidate list caches (ensures consistency)
  await fleetCacheService.invalidateOnTripChange(transporterId, vehicleId, driverId);
}
