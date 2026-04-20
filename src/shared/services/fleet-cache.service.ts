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

// F-B-02 Phase A: constants + shapes now live in fleet-cache-types.ts (single
// source of truth). Local duplicates removed; the class below is marked
// @deprecated — callers should migrate to the free-function module
// (fleet-cache-read.service.ts / fleet-cache-write.service.ts) in Phase C.
import {
  FLEET_CACHE_PREFIX,
  CachedVehicle,
  CachedDriver,
  AvailabilitySnapshot,
} from './fleet-cache-types';
// F3.NEW-3 / F3.8: class methods delegate to free-function modules so the
// F3.1 / F3.NEW-2 isOnline-on-HIT recompute (and any future read/write fixes)
// take effect through every caller of the deprecated wrapper.
import * as fleetCacheRead from './fleet-cache-read.service';
import * as fleetCacheWrite from './fleet-cache-write.service';

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
  // F3.8: All read/write methods below delegate to the free-function modules.
  // F3.NEW-3: getAvailableDrivers (and all read methods) now route through the
  // free functions, so the F3.1 list-HIT + F3.NEW-2 individual-HIT isOnline
  // recomputes take effect via every caller of this deprecated wrapper.
  // ===========================================================================

  // --- Vehicle reads -----------------------------------------------------
  async getTransporterVehicles(
    transporterId: string,
    forceRefresh: boolean = false
  ): Promise<CachedVehicle[]> {
    return fleetCacheRead.getTransporterVehicles(transporterId, forceRefresh);
  }

  async getTransporterVehiclesByType(
    transporterId: string,
    vehicleType: string,
    vehicleSubtype?: string
  ): Promise<CachedVehicle[]> {
    return fleetCacheRead.getTransporterVehiclesByType(transporterId, vehicleType, vehicleSubtype);
  }

  async getAvailableVehicles(
    transporterId: string,
    vehicleType?: string,
    vehicleSubtype?: string
  ): Promise<CachedVehicle[]> {
    return fleetCacheRead.getAvailableVehicles(transporterId, vehicleType, vehicleSubtype);
  }

  async getVehicle(vehicleId: string): Promise<CachedVehicle | null> {
    return fleetCacheRead.getVehicle(vehicleId);
  }

  // --- Driver reads ------------------------------------------------------
  async getTransporterDrivers(
    transporterId: string,
    forceRefresh: boolean = false
  ): Promise<CachedDriver[]> {
    return fleetCacheRead.getTransporterDrivers(transporterId, forceRefresh);
  }

  async getAvailableDrivers(transporterId: string): Promise<CachedDriver[]> {
    return fleetCacheRead.getAvailableDrivers(transporterId);
  }

  async getDriver(driverId: string): Promise<CachedDriver | null> {
    return fleetCacheRead.getDriver(driverId);
  }

  // --- Availability snapshot --------------------------------------------
  async getAvailabilitySnapshot(
    transporterId: string,
    vehicleType: string,
    vehicleSubtype?: string
  ): Promise<AvailabilitySnapshot> {
    return fleetCacheRead.getAvailabilitySnapshot(transporterId, vehicleType, vehicleSubtype);
  }

  // --- Cache invalidation -----------------------------------------------
  async invalidateVehicleCache(transporterId: string, vehicleId?: string): Promise<void> {
    return fleetCacheWrite.invalidateVehicleCache(transporterId, vehicleId);
  }

  async invalidateDriverCache(transporterId: string, driverId?: string): Promise<void> {
    return fleetCacheWrite.invalidateDriverCache(transporterId, driverId);
  }

  async invalidateOnTripChange(
    transporterId: string,
    vehicleId: string,
    driverId: string
  ): Promise<void> {
    return fleetCacheWrite.invalidateOnTripChange(transporterId, vehicleId, driverId);
  }

  // --- Targeted updates -------------------------------------------------
  async updateVehicleStatus(
    vehicleId: string,
    status: 'available' | 'on_hold' | 'in_transit' | 'maintenance' | 'inactive',
    tripId?: string
  ): Promise<void> {
    return fleetCacheWrite.updateVehicleStatus(vehicleId, status, tripId);
  }

  async updateDriverAvailability(
    driverId: string,
    isAvailable: boolean,
    tripId?: string
  ): Promise<void> {
    return fleetCacheWrite.updateDriverAvailability(driverId, isAvailable, tripId);
  }

  // --- Stats & clear ----------------------------------------------------
  async getStats(): Promise<{
    vehicleKeys: number;
    driverKeys: number;
    snapshotKeys: number;
  }> {
    return fleetCacheRead.getStats();
  }

  async clearAll(): Promise<void> {
    return fleetCacheWrite.clearAll();
  }
}

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
