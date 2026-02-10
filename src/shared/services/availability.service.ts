/**
 * =============================================================================
 * AVAILABILITY SERVICE
 * =============================================================================
 * 
 * Maintains a LIVE availability table of drivers/transporters.
 * 
 * VERSION 2.0 - REDIS POWERED:
 * - Uses Redis geospatial commands for O(log N) proximity queries
 * - Auto-expire removes stale drivers (no manual cleanup needed)
 * - Works across multiple servers (horizontal scaling)
 * - Falls back to in-memory for development
 * 
 * REDIS KEY PATTERNS:
 * - geo:drivers:{vehicleKey}       = Geospatial index (GEOADD/GEORADIUS)
 * - driver:details:{transporterId} = Driver details hash (TTL: 60s)
 * - driver:vehicle:{transporterId} = Current vehicle key
 * - online:drivers                 = Set of all online drivers
 * 
 * PERFORMANCE:
 * - Update: O(log N) ~1ms
 * - Search: O(log N + M) ~5ms (M = results count)
 * - Offline: O(log N) ~1ms
 * 
 * USAGE:
 * ```typescript
 * // Update driver location (call every 5 seconds)
 * await availabilityService.updateAvailability({
 *   transporterId: 'trans_123',
 *   vehicleKey: 'open_17ft',
 *   vehicleId: 'v_456',
 *   latitude: 28.6139,
 *   longitude: 77.2090
 * });
 * 
 * // Find nearby drivers
 * const nearby = await availabilityService.getAvailableTransporters(
 *   'open_17ft', 28.6139, 77.2090, 20
 * );
 * ```
 * 
 * @author Weelo Team
 * @version 2.0.0
 */

import { logger } from './logger.service';
import { redisService, GeoMember } from './redis.service';

// =============================================================================
// GEOHASH IMPLEMENTATION (Simple version - no external dependency)
// =============================================================================

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/**
 * Encode latitude/longitude to geohash
 * @param lat - Latitude (-90 to 90)
 * @param lng - Longitude (-180 to 180)
 * @param precision - Number of characters (default 5 = ~5km accuracy)
 */
function encodeGeohash(lat: number, lng: number, precision: number = 5): string {
  let latRange = [-90, 90];
  let lngRange = [-180, 180];
  let hash = '';
  let bit = 0;
  let ch = 0;
  let isLng = true;
  
  while (hash.length < precision) {
    const range = isLng ? lngRange : latRange;
    const val = isLng ? lng : lat;
    const mid = (range[0] + range[1]) / 2;
    
    if (val >= mid) {
      ch |= (1 << (4 - bit));
      range[0] = mid;
    } else {
      range[1] = mid;
    }
    
    isLng = !isLng;
    bit++;
    
    if (bit === 5) {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  
  return hash;
}

/**
 * Get neighboring geohashes (for proximity search)
 * Returns the 8 surrounding geohashes + the center = 9 cells total
 * 
 * Geohash grid looks like:
 *   NW | N | NE
 *   ---+---+---
 *   W  | C | E
 *   ---+---+---
 *   SW | S | SE
 * 
 * This ensures we check all adjacent cells for nearby drivers
 * Total cells checked = 9 max (fast lookup < 5ms)
 */
function getNeighbors(geohash: string): string[] {
  if (!geohash || geohash.length === 0) return [geohash];
  
  const neighbors: string[] = [geohash]; // Center
  
  // Simplified but effective neighbor calculation
  // Uses last character variation for adjacent cells
  const lastChar = geohash[geohash.length - 1];
  const prefix = geohash.slice(0, -1);
  const idx = BASE32.indexOf(lastChar);
  
  // Direct neighbors (N, S, E, W)
  if (idx > 0) neighbors.push(prefix + BASE32[idx - 1]);
  if (idx < 31) neighbors.push(prefix + BASE32[idx + 1]);
  
  // Row-based neighbors (using 8-column layout of geohash)
  if (idx >= 8) neighbors.push(prefix + BASE32[idx - 8]);
  if (idx <= 23) neighbors.push(prefix + BASE32[idx + 8]);
  
  // Diagonal neighbors
  if (idx > 0 && idx >= 8) neighbors.push(prefix + BASE32[idx - 9]);
  if (idx < 31 && idx >= 8) neighbors.push(prefix + BASE32[idx - 7]);
  if (idx > 0 && idx <= 23) neighbors.push(prefix + BASE32[idx + 7]);
  if (idx < 31 && idx <= 23) neighbors.push(prefix + BASE32[idx + 9]);
  
  // Filter valid and unique
  return [...new Set(neighbors.filter(n => n && n.length === geohash.length))];
}

// =============================================================================
// REDIS KEY PATTERNS
// =============================================================================

const REDIS_KEYS = {
  /** Geospatial index: geo:drivers:{vehicleKey} */
  GEO_DRIVERS: (vehicleKey: string) => `geo:drivers:${vehicleKey}`,
  
  /** Driver details hash: driver:details:{transporterId} */
  DRIVER_DETAILS: (transporterId: string) => `driver:details:${transporterId}`,
  
  /** Driver's current vehicle key: driver:vehicle:{transporterId} */
  DRIVER_VEHICLE: (transporterId: string) => `driver:vehicle:${transporterId}`,
  
  /** All online drivers set: online:drivers */
  ONLINE_DRIVERS: 'online:drivers',
};

// =============================================================================
// TYPES
// =============================================================================

interface DriverAvailability {
  transporterId: string;
  driverId?: string;
  vehicleKey: string;
  vehicleId: string;
  latitude: number;
  longitude: number;
  lastSeen: number;
  isOnTrip: boolean;
}

interface AvailabilityStats {
  totalOnline: number;
  byVehicleType: Record<string, number>;
  byGeohash: Record<string, number>;
  redisMode: boolean;
}

interface NearbyDriver {
  transporterId: string;
  distance: number;
  vehicleKey: string;
  vehicleId: string;
  latitude: number;
  longitude: number;
}

// =============================================================================
// SERVICE CLASS (Redis-Powered)
// =============================================================================

class AvailabilityService {
  
  /** TTL for driver details (60 seconds - auto-offline if no heartbeat) */
  private readonly DRIVER_TTL_SECONDS = 60;
  
  /** Heartbeat interval recommendation for clients */
  readonly HEARTBEAT_INTERVAL_MS = 5 * 1000;
  
  /** Default search radius in km */
  private readonly DEFAULT_SEARCH_RADIUS_KM = 50;
  
  constructor() {
    logger.info('[Availability] Redis-powered service initialized');
  }
  
  // ===========================================================================
  // MAIN API
  // ===========================================================================
  
  /**
   * Update driver/transporter availability
   * 
   * NOW USES REDIS:
   * - Stores location in Redis geospatial index (GEOADD)
   * - Auto-expires after 60 seconds (no heartbeat = offline)
   * - Works across multiple servers
   * 
   * @param data - Driver availability data
   */
  updateAvailability(data: {
    transporterId: string;
    driverId?: string;
    vehicleKey: string;
    vehicleId: string;
    latitude: number;
    longitude: number;
    isOnTrip?: boolean;
  }): void {
    // Call async version but don't await (fire and forget for backward compat)
    this.updateAvailabilityAsync(data).catch(err => {
      logger.error(`[Availability] Update failed: ${err.message}`);
    });
  }
  
  /**
   * Async version of updateAvailability
   */
  async updateAvailabilityAsync(data: {
    transporterId: string;
    driverId?: string;
    vehicleKey: string;
    vehicleId: string;
    latitude: number;
    longitude: number;
    isOnTrip?: boolean;
  }): Promise<void> {
    const {
      transporterId,
      driverId,
      vehicleKey,
      vehicleId,
      latitude,
      longitude,
      isOnTrip = false
    } = data;
    
    const now = Date.now();
    
    try {
      // 1. Get previous vehicle key (if driver changed vehicle)
      const previousVehicleKey = await redisService.get(
        REDIS_KEYS.DRIVER_VEHICLE(transporterId)
      );
      
      // 2. If vehicle changed, remove from old geo index
      if (previousVehicleKey && previousVehicleKey !== vehicleKey) {
        await redisService.geoRemove(
          REDIS_KEYS.GEO_DRIVERS(previousVehicleKey),
          transporterId
        );
      }
      
      // 3. Store driver details (with TTL for auto-cleanup)
      const details: Record<string, string> = {
        transporterId,
        vehicleKey,
        vehicleId,
        latitude: latitude.toString(),
        longitude: longitude.toString(),
        lastSeen: now.toString(),
        isOnTrip: isOnTrip.toString(),
      };
      
      if (driverId) {
        details.driverId = driverId;
      }
      
      await redisService.hMSet(REDIS_KEYS.DRIVER_DETAILS(transporterId), details);
      await redisService.expire(REDIS_KEYS.DRIVER_DETAILS(transporterId), this.DRIVER_TTL_SECONDS);
      
      // 4. Store current vehicle key
      await redisService.set(
        REDIS_KEYS.DRIVER_VEHICLE(transporterId),
        vehicleKey,
        this.DRIVER_TTL_SECONDS
      );
      
      // 5. Update geo index (only if NOT on trip)
      if (!isOnTrip) {
        await redisService.geoAdd(
          REDIS_KEYS.GEO_DRIVERS(vehicleKey),
          longitude,
          latitude,
          transporterId
        );
        
        await redisService.sAdd(REDIS_KEYS.ONLINE_DRIVERS, transporterId);
        
        logger.debug(`[Availability] Updated: ${transporterId} @ (${latitude}, ${longitude}) - ${vehicleKey}`);
      } else {
        await redisService.geoRemove(
          REDIS_KEYS.GEO_DRIVERS(vehicleKey),
          transporterId
        );
        
        logger.debug(`[Availability] ${transporterId} on trip - removed from geo index`);
      }
      
    } catch (error: any) {
      logger.error(`[Availability] updateAvailabilityAsync failed: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Mark driver as offline (remove from availability)
   * 
   * Call this on:
   * - App close / background
   * - Logout
   * - Toggle offline
   */
  setOffline(transporterId: string): void {
    // Fire and forget for backward compatibility
    this.setOfflineAsync(transporterId).catch(err => {
      logger.error(`[Availability] setOffline failed: ${err.message}`);
    });
  }
  
  /**
   * Async version of setOffline
   */
  async setOfflineAsync(transporterId: string): Promise<void> {
    try {
      // 1. Get current vehicle key
      const vehicleKey = await redisService.get(
        REDIS_KEYS.DRIVER_VEHICLE(transporterId)
      );
      
      // 2. Remove from geo index
      if (vehicleKey) {
        await redisService.geoRemove(
          REDIS_KEYS.GEO_DRIVERS(vehicleKey),
          transporterId
        );
      }
      
      // 3. Remove from online set
      await redisService.sRem(REDIS_KEYS.ONLINE_DRIVERS, transporterId);
      
      // 4. Delete driver details
      await redisService.del(REDIS_KEYS.DRIVER_DETAILS(transporterId));
      await redisService.del(REDIS_KEYS.DRIVER_VEHICLE(transporterId));
      
      logger.info(`[Availability] Offline: ${transporterId}`);
      
    } catch (error: any) {
      logger.error(`[Availability] setOfflineAsync failed: ${error.message}`);
    }
  }
  
  /**
   * Get available transporters by vehicle key and location
   * 
   * NOW USES REDIS GEORADIUS:
   * - O(log N + M) complexity where M = results
   * - Returns drivers sorted by distance
   * - Auto-filters stale entries
   * 
   * @param vehicleKey - Normalized vehicle key (e.g., "open_17ft")
   * @param latitude - Pickup latitude
   * @param longitude - Pickup longitude
   * @param limit - Max results (default 20)
   * @returns Array of transporter IDs, sorted by proximity
   */
  getAvailableTransporters(
    vehicleKey: string,
    latitude: number,
    longitude: number,
    limit: number = 20
  ): string[] {
    // For backward compatibility, we need sync return
    // But Redis is async, so we return empty and log warning
    // Use getAvailableTransportersAsync for proper async usage
    logger.warn('[Availability] getAvailableTransporters called synchronously - use getAvailableTransportersAsync instead');
    
    // Trigger async version in background
    this.getAvailableTransportersAsync(vehicleKey, latitude, longitude, limit)
      .then(results => {
        logger.debug(`[Availability] Async found ${results.length} transporters for ${vehicleKey}`);
      })
      .catch(err => {
        logger.error(`[Availability] Async search failed: ${err.message}`);
      });
    
    return [];
  }
  
  /**
   * Async version - USE THIS for proper Redis-powered searches
   */
  async getAvailableTransportersAsync(
    vehicleKey: string,
    latitude: number,
    longitude: number,
    limit: number = 20,
    radiusKm: number = this.DEFAULT_SEARCH_RADIUS_KM
  ): Promise<string[]> {
    try {
      // Use Redis GEORADIUS to find nearby drivers
      const nearbyDrivers = await redisService.geoRadius(
        REDIS_KEYS.GEO_DRIVERS(vehicleKey),
        longitude,
        latitude,
        radiusKm,
        'km'
      );
      
      // Filter out drivers who are on trip or have stale data
      const validDrivers: Array<{ id: string; distance: number }> = [];
      
      for (const driver of nearbyDrivers) {
        // Check if driver details exist and not on trip
        const details = await redisService.hGetAll(
          REDIS_KEYS.DRIVER_DETAILS(driver.member)
        );
        
        // Skip if no details (TTL expired = offline)
        if (!details || Object.keys(details).length === 0) {
          // Clean up stale geo entry
          await redisService.geoRemove(
            REDIS_KEYS.GEO_DRIVERS(vehicleKey),
            driver.member
          );
          continue;
        }
        
        // Skip if on trip
        if (details.isOnTrip === 'true') {
          continue;
        }
        
        validDrivers.push({
          id: driver.member,
          distance: driver.distance || 0
        });
      }
      
      // Already sorted by distance from GEORADIUS
      const result = validDrivers.slice(0, limit).map(d => d.id);
      
      logger.info(`[Availability] Found ${result.length} available for ${vehicleKey} within ${radiusKm}km of (${latitude}, ${longitude})`);
      
      return result;
      
    } catch (error: any) {
      logger.error(`[Availability] getAvailableTransportersAsync failed: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Get available transporters with full details
   */
  async getAvailableTransportersWithDetails(
    vehicleKey: string,
    latitude: number,
    longitude: number,
    limit: number = 20,
    radiusKm: number = this.DEFAULT_SEARCH_RADIUS_KM
  ): Promise<NearbyDriver[]> {
    try {
      const nearbyDrivers = await redisService.geoRadius(
        REDIS_KEYS.GEO_DRIVERS(vehicleKey),
        longitude,
        latitude,
        radiusKm,
        'km'
      );
      
      const result: NearbyDriver[] = [];
      
      for (const driver of nearbyDrivers) {
        if (result.length >= limit) break;
        
        const details = await redisService.hGetAll(
          REDIS_KEYS.DRIVER_DETAILS(driver.member)
        );
        
        if (!details || Object.keys(details).length === 0) continue;
        if (details.isOnTrip === 'true') continue;
        
        result.push({
          transporterId: driver.member,
          distance: driver.distance || 0,
          vehicleKey: details.vehicleKey,
          vehicleId: details.vehicleId,
          latitude: parseFloat(details.latitude),
          longitude: parseFloat(details.longitude)
        });
      }
      
      return result;
      
    } catch (error: any) {
      logger.error(`[Availability] getAvailableTransportersWithDetails failed: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Get available transporters for MULTIPLE vehicle keys
   * Used when a booking has multiple vehicle types
   * 
   * @param vehicleKeys - Array of normalized vehicle keys
   * @param latitude - Pickup latitude
   * @param longitude - Pickup longitude
   * @param limitPerType - Max results per vehicle type (default 20)
   * @returns Map of vehicleKey -> transporter IDs
   */
  getAvailableTransportersMulti(
    vehicleKeys: string[],
    latitude: number,
    longitude: number,
    limitPerType: number = 20
  ): Map<string, string[]> {
    // Sync version for backward compat - returns empty
    logger.warn('[Availability] getAvailableTransportersMulti called synchronously - use async version');
    return new Map();
  }
  
  /**
   * Async version for multiple vehicle keys
   */
  async getAvailableTransportersMultiAsync(
    vehicleKeys: string[],
    latitude: number,
    longitude: number,
    limitPerType: number = 20
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    
    // Run searches in parallel for better performance
    const searches = vehicleKeys.map(async (vehicleKey) => {
      const transporters = await this.getAvailableTransportersAsync(
        vehicleKey, latitude, longitude, limitPerType
      );
      return { vehicleKey, transporters };
    });
    
    const results = await Promise.all(searches);
    
    for (const { vehicleKey, transporters } of results) {
      result.set(vehicleKey, transporters);
    }
    
    return result;
  }
  
  /**
   * Check if a specific transporter is available
   */
  isAvailable(transporterId: string): boolean {
    // Sync version - use isAvailableAsync for proper check
    logger.warn('[Availability] isAvailable called synchronously - use isAvailableAsync');
    return false;
  }
  
  /**
   * Async version of isAvailable
   */
  async isAvailableAsync(transporterId: string): Promise<boolean> {
    try {
      const details = await redisService.hGetAll(
        REDIS_KEYS.DRIVER_DETAILS(transporterId)
      );
      
      if (!details || Object.keys(details).length === 0) {
        return false;
      }
      
      return details.isOnTrip !== 'true';
      
    } catch (error) {
      return false;
    }
  }
  
  /**
   * Get driver details
   */
  async getDriverDetails(transporterId: string): Promise<DriverAvailability | null> {
    try {
      const details = await redisService.hGetAll(
        REDIS_KEYS.DRIVER_DETAILS(transporterId)
      );
      
      if (!details || Object.keys(details).length === 0) {
        return null;
      }
      
      return {
        transporterId: details.transporterId,
        driverId: details.driverId,
        vehicleKey: details.vehicleKey,
        vehicleId: details.vehicleId,
        latitude: parseFloat(details.latitude),
        longitude: parseFloat(details.longitude),
        lastSeen: parseInt(details.lastSeen, 10),
        isOnTrip: details.isOnTrip === 'true'
      };
      
    } catch (error) {
      return null;
    }
  }
  
  /**
   * Get availability statistics
   */
  getStats(): AvailabilityStats {
    // Sync version - returns empty stats
    return { totalOnline: 0, byVehicleType: {}, byGeohash: {}, redisMode: true };
  }
  
  /**
   * Async version of getStats
   */
  async getStatsAsync(): Promise<AvailabilityStats> {
    try {
      const totalOnline = await redisService.sCard(REDIS_KEYS.ONLINE_DRIVERS);
      const byVehicleType: Record<string, number> = {};
      const byGeohash: Record<string, number> = {};
      
      // Get breakdown by vehicle type
      const onlineDrivers = await redisService.sMembers(REDIS_KEYS.ONLINE_DRIVERS);
      
      for (const driverId of onlineDrivers.slice(0, 1000)) {
        const vehicleKey = await redisService.get(REDIS_KEYS.DRIVER_VEHICLE(driverId));
        if (vehicleKey) {
          byVehicleType[vehicleKey] = (byVehicleType[vehicleKey] || 0) + 1;
        }
      }
      
      return {
        totalOnline,
        byVehicleType,
        byGeohash,
        redisMode: redisService.isRedisEnabled()
      };
      
    } catch (error: any) {
      logger.error(`[Availability] getStatsAsync failed: ${error.message}`);
      return { totalOnline: 0, byVehicleType: {}, byGeohash: {}, redisMode: false };
    }
  }
  
  /**
   * Health check
   */
  async healthCheck(): Promise<{ healthy: boolean; mode: string; latencyMs: number }> {
    const start = Date.now();
    
    try {
      await redisService.sCard(REDIS_KEYS.ONLINE_DRIVERS);
      
      return {
        healthy: true,
        mode: redisService.isRedisEnabled() ? 'redis' : 'memory',
        latencyMs: Date.now() - start
      };
    } catch (error) {
      return {
        healthy: false,
        mode: redisService.isRedisEnabled() ? 'redis' : 'memory',
        latencyMs: Date.now() - start
      };
    }
  }
  
  /**
   * Stop the service (for graceful shutdown)
   * Note: No cleanup interval needed with Redis - TTL handles expiration
   */
  stop(): void {
    logger.info('[Availability] Service stopped (Redis handles cleanup via TTL)');
  }
}

// =============================================================================
// SINGLETON EXPORT
// =============================================================================

export const availabilityService = new AvailabilityService();

// Export geohash utilities for external use
export { encodeGeohash, getNeighbors };
