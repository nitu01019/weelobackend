/**
 * =============================================================================
 * AVAILABILITY SERVICE
 * =============================================================================
 * 
 * Maintains a LIVE availability table of transporters.
 * 
 * VERSION 2.0 - REDIS POWERED:
 * - Uses Redis geospatial commands for O(log N) proximity queries
 * - Auto-expire removes stale transporters (no manual cleanup needed)
 * - Works across multiple servers (horizontal scaling)
 * - Falls back to in-memory for development
 * 
 * REDIS KEY PATTERNS:
 * - geo:transporters:{vehicleKey}       = Geospatial index (GEOADD/GEORADIUS)
 * - transporter:details:{transporterId} = Transporter details hash (TTL: 60s)
 * - transporter:vehicle:{transporterId} = Current vehicle key
 * - online:transporters                 = Set of all online transporters
 * 
 * PERFORMANCE:
 * - Update: O(log N) ~1ms
 * - Search: O(log N + M) ~5ms (M = results count)
 * - Offline: O(log N) ~1ms
 * 
 * USAGE:
 * ```typescript
 * // Update transporter location (call every 5 seconds)
 * await availabilityService.updateAvailability({
 *   transporterId: 'trans_123',
 *   vehicleKey: 'open_17ft',
 *   vehicleId: 'v_456',
 *   latitude: 28.6139,
 *   longitude: 77.2090
 * });
 * 
 * // Find nearby transporters
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
import { db } from '../database/db';
import { haversineDistanceKm } from '../utils/geospatial.utils';
import { h3GeoIndexService } from './h3-geo-index.service';

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
 * This ensures we check all adjacent cells for nearby transporters
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
  /** Geospatial index: geo:transporters:{vehicleKey} */
  GEO_TRANSPORTERS: (vehicleKey: string) => `geo:transporters:${vehicleKey}`,

  /** Transporter details hash: transporter:details:{transporterId} */
  TRANSPORTER_DETAILS: (transporterId: string) => `transporter:details:${transporterId}`,

  /** Transporter's current vehicle key: transporter:vehicle:{transporterId} */
  TRANSPORTER_VEHICLE: (transporterId: string) => `transporter:vehicle:${transporterId}`,

  /** Transporter's indexed vehicle keys set: transporter:vehicle:keys:{transporterId} */
  TRANSPORTER_VEHICLE_KEYS: (transporterId: string) => `transporter:vehicle:keys:${transporterId}`,

  /** All online transporters set: online:transporters */
  ONLINE_TRANSPORTERS: 'online:transporters',
};

// =============================================================================
// TYPES
// =============================================================================

interface TransporterAvailability {
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

interface NearbyTransporter {
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

  /** TTL for transporter details (90 seconds - generous buffer for 2G/EDGE networks) */
  private readonly TRANSPORTER_TTL_SECONDS = 90;

  /** Heartbeat interval recommendation for clients */
  readonly HEARTBEAT_INTERVAL_MS = 5 * 1000;

  /** Default search radius in km */
  private readonly DEFAULT_SEARCH_RADIUS_KM = 50;

  /**
   * GEO failure fallback throttling (per vehicleKey+radius).
   * Prevents DB pressure during Redis incidents.
   */
  private readonly GEO_FALLBACK_MIN_INTERVAL_MS = parseInt(
    process.env.GEO_FALLBACK_MIN_INTERVAL_MS || '1500',
    10
  );
  private readonly GEO_FALLBACK_MAX_CANDIDATES = parseInt(
    process.env.GEO_FALLBACK_MAX_CANDIDATES || '800',
    10
  );
  private readonly geoFallbackLastRunMs = new Map<string, number>();

  constructor() {
    logger.info('[Availability] Redis-powered service initialized');
  }

  // ===========================================================================
  // MAIN API
  // ===========================================================================

  /**
   * Update transporter availability
   * 
   * NOW USES REDIS:
   * - Stores location in Redis geospatial index (GEOADD)
   * - Auto-expires after 60 seconds (no heartbeat = offline)
   * - Works across multiple servers
   * 
   * @param data - Transporter availability data
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
      // 1. Get previously indexed vehicle keys.
      const previousVehicleKey = await redisService.get(
        REDIS_KEYS.TRANSPORTER_VEHICLE(transporterId)
      );
      const previousVehicleKeys = await redisService.sMembers(
        REDIS_KEYS.TRANSPORTER_VEHICLE_KEYS(transporterId)
      ).catch(() => []);

      // 2. If vehicle changed, remove stale geo index entries.
      const staleVehicleKeys = new Set(previousVehicleKeys);
      if (previousVehicleKey) staleVehicleKeys.add(previousVehicleKey);
      for (const staleKey of staleVehicleKeys) {
        if (!staleKey || staleKey === vehicleKey) continue;
        await redisService.geoRemove(
          REDIS_KEYS.GEO_TRANSPORTERS(staleKey),
          transporterId
        );
      }

      // 3. Store transporter details (with TTL for auto-cleanup)
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

      await redisService.hMSet(REDIS_KEYS.TRANSPORTER_DETAILS(transporterId), details);
      await redisService.expire(REDIS_KEYS.TRANSPORTER_DETAILS(transporterId), this.TRANSPORTER_TTL_SECONDS);

      // 4. Store current vehicle key
      await redisService.set(
        REDIS_KEYS.TRANSPORTER_VEHICLE(transporterId),
        vehicleKey,
        this.TRANSPORTER_TTL_SECONDS
      );
      await redisService.del(REDIS_KEYS.TRANSPORTER_VEHICLE_KEYS(transporterId));
      await redisService.sAdd(REDIS_KEYS.TRANSPORTER_VEHICLE_KEYS(transporterId), vehicleKey);
      await redisService.expire(REDIS_KEYS.TRANSPORTER_VEHICLE_KEYS(transporterId), this.TRANSPORTER_TTL_SECONDS);

      // 5. Update geo index (only if NOT on trip)
      if (!isOnTrip) {
        await redisService.geoAdd(
          REDIS_KEYS.GEO_TRANSPORTERS(vehicleKey),
          longitude,
          latitude,
          transporterId
        );

        await redisService.sAdd(REDIS_KEYS.ONLINE_TRANSPORTERS, transporterId);

        logger.debug(`[Availability] Updated: ${transporterId} @ (${latitude}, ${longitude}) - ${vehicleKey}`);
      } else {
        await redisService.geoRemove(
          REDIS_KEYS.GEO_TRANSPORTERS(vehicleKey),
          transporterId
        );

        logger.debug(`[Availability] ${transporterId} on trip - removed from geo index`);
      }

      // Shadow-build H3 index (fire-and-forget, zero latency impact)
      if (!isOnTrip) {
        h3GeoIndexService.updateLocation(transporterId, latitude, longitude, [vehicleKey]).catch(() => { });
      } else {
        h3GeoIndexService.removeTransporter(transporterId).catch(() => { });
      }

    } catch (error: any) {
      logger.error(`[Availability] updateAvailabilityAsync failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Multi-vehicle variant for transporter heartbeat.
   * Indexes all active fleet vehicle keys at the same transporter location.
   */
  async updateAvailabilityForVehicleKeysAsync(data: {
    transporterId: string;
    driverId?: string;
    vehicleEntries: Array<{ vehicleKey: string; vehicleId: string }>;
    latitude: number;
    longitude: number;
    isOnTrip?: boolean;
  }): Promise<void> {
    const {
      transporterId,
      driverId,
      vehicleEntries,
      latitude,
      longitude,
      isOnTrip = false
    } = data;

    const normalizedEntries = Array.from(
      new Map(
        vehicleEntries
          .filter(entry => entry.vehicleKey && entry.vehicleId)
          .map(entry => [entry.vehicleKey, entry])
      ).values()
    );
    if (normalizedEntries.length === 0) {
      throw new Error('No vehicle keys provided for availability sync');
    }

    const primary = normalizedEntries[0];
    const currentVehicleKeys = normalizedEntries.map(entry => entry.vehicleKey);
    const now = Date.now();

    const previousVehicleKey = await redisService.get(
      REDIS_KEYS.TRANSPORTER_VEHICLE(transporterId)
    );
    const previousVehicleKeys = await redisService.sMembers(
      REDIS_KEYS.TRANSPORTER_VEHICLE_KEYS(transporterId)
    ).catch(() => []);

    const staleVehicleKeys = new Set(previousVehicleKeys);
    if (previousVehicleKey) staleVehicleKeys.add(previousVehicleKey);
    for (const staleKey of staleVehicleKeys) {
      if (!staleKey || currentVehicleKeys.includes(staleKey)) continue;
      await redisService.geoRemove(REDIS_KEYS.GEO_TRANSPORTERS(staleKey), transporterId);
    }

    const details: Record<string, string> = {
      transporterId,
      vehicleKey: primary.vehicleKey,
      vehicleId: primary.vehicleId,
      vehicleKeys: currentVehicleKeys.join(','),
      latitude: latitude.toString(),
      longitude: longitude.toString(),
      lastSeen: now.toString(),
      isOnTrip: isOnTrip.toString(),
    };
    if (driverId) details.driverId = driverId;

    await redisService.hMSet(REDIS_KEYS.TRANSPORTER_DETAILS(transporterId), details);
    await redisService.expire(REDIS_KEYS.TRANSPORTER_DETAILS(transporterId), this.TRANSPORTER_TTL_SECONDS);
    await redisService.set(
      REDIS_KEYS.TRANSPORTER_VEHICLE(transporterId),
      primary.vehicleKey,
      this.TRANSPORTER_TTL_SECONDS
    );
    await redisService.del(REDIS_KEYS.TRANSPORTER_VEHICLE_KEYS(transporterId));
    await redisService.sAdd(REDIS_KEYS.TRANSPORTER_VEHICLE_KEYS(transporterId), ...currentVehicleKeys);
    await redisService.expire(REDIS_KEYS.TRANSPORTER_VEHICLE_KEYS(transporterId), this.TRANSPORTER_TTL_SECONDS);

    if (!isOnTrip) {
      await Promise.all(currentVehicleKeys.map((key) =>
        redisService.geoAdd(
          REDIS_KEYS.GEO_TRANSPORTERS(key),
          longitude,
          latitude,
          transporterId
        )
      ));
      await redisService.sAdd(REDIS_KEYS.ONLINE_TRANSPORTERS, transporterId);
    } else {
      await Promise.all(currentVehicleKeys.map((key) =>
        redisService.geoRemove(REDIS_KEYS.GEO_TRANSPORTERS(key), transporterId)
      ));
    }

    logger.debug(`[Availability] Updated multi-vehicle index: ${transporterId} keys=${currentVehicleKeys.length}`);

    // Shadow-build H3 index for all vehicle keys (fire-and-forget)
    if (!isOnTrip) {
      h3GeoIndexService.updateLocation(transporterId, latitude, longitude, currentVehicleKeys).catch(() => { });
    } else {
      h3GeoIndexService.removeTransporter(transporterId).catch(() => { });
    }
  }

  /**
   * Mark transporter as offline (remove from availability)
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
        REDIS_KEYS.TRANSPORTER_VEHICLE(transporterId)
      );
      const vehicleKeys = await redisService.sMembers(
        REDIS_KEYS.TRANSPORTER_VEHICLE_KEYS(transporterId)
      ).catch(() => []);

      // 2. Remove from geo index
      if (vehicleKey) {
        await redisService.geoRemove(
          REDIS_KEYS.GEO_TRANSPORTERS(vehicleKey),
          transporterId
        );
      }
      for (const indexedKey of vehicleKeys) {
        if (!indexedKey || indexedKey === vehicleKey) continue;
        await redisService.geoRemove(
          REDIS_KEYS.GEO_TRANSPORTERS(indexedKey),
          transporterId
        );
      }

      // 3. Remove from online set
      await redisService.sRem(REDIS_KEYS.ONLINE_TRANSPORTERS, transporterId);

      // 4. Delete transporter details
      await redisService.del(REDIS_KEYS.TRANSPORTER_DETAILS(transporterId));
      await redisService.del(REDIS_KEYS.TRANSPORTER_VEHICLE(transporterId));
      await redisService.del(REDIS_KEYS.TRANSPORTER_VEHICLE_KEYS(transporterId));

      logger.info(`[Availability] Offline: ${transporterId}`);

      // Remove from H3 index (fire-and-forget)
      h3GeoIndexService.removeTransporter(transporterId).catch(() => { });

    } catch (error: any) {
      logger.error(`[Availability] setOfflineAsync failed: ${error.message}`);
    }
  }

  /**
   * Get available transporters by vehicle key and location
   * 
   * NOW USES REDIS GEORADIUS:
   * - O(log N + M) complexity where M = results
   * - Returns transporters sorted by distance
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
      // Runtime matching source of truth: Redis GEO index (authoritative hot path).
      // Geohash helpers in this file are auxiliary utilities and not the primary matcher.
      const nearbyTransporters = await redisService.geoRadius(
        REDIS_KEYS.GEO_TRANSPORTERS(vehicleKey),
        longitude,
        latitude,
        radiusKm,
        'km'
      );

      // Batch Redis hash lookups to avoid N round-trips under burst.
      const detailsMap = await this.loadTransporterDetailsMap(
        nearbyTransporters.map((entry) => entry.member)
      );

      // Filter out transporters who are on trip or stale.
      const validTransporters: Array<{ id: string; distance: number }> = [];
      for (const entry of nearbyTransporters) {
        const details = detailsMap.get(entry.member) || {};

        // Skip if no details (TTL expired = offline).
        if (Object.keys(details).length === 0) {
          // Clean up stale geo entry in background-safe path.
          await redisService.geoRemove(
            REDIS_KEYS.GEO_TRANSPORTERS(vehicleKey),
            entry.member
          );
          continue;
        }

        // Skip if on trip.
        if (details.isOnTrip === 'true') {
          continue;
        }

        validTransporters.push({
          id: entry.member,
          distance: entry.distance || 0
        });
      }

      // Already sorted by distance from GEORADIUS
      const result = validTransporters.slice(0, limit).map(d => d.id);

      logger.info(`[Availability] Found ${result.length} available for ${vehicleKey} within ${radiusKm}km of (${latitude}, ${longitude})`);
      logger.info('[Availability] matching.source=redis_geo', {
        matchingSource: 'redis_geo',
        vehicleKey,
        radiusKm,
        candidates: nearbyTransporters.length,
        matched: result.length
      });

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
  ): Promise<NearbyTransporter[]> {
    try {
      // Runtime matching source of truth: Redis GEO index (authoritative hot path).
      // Geohash helpers are intentionally retained as utility/fallback helpers.
      const nearbyTransporters = await redisService.geoRadius(
        REDIS_KEYS.GEO_TRANSPORTERS(vehicleKey),
        longitude,
        latitude,
        radiusKm,
        'km'
      );

      const detailsMap = await this.loadTransporterDetailsMap(
        nearbyTransporters.map((entry) => entry.member)
      );
      const result: NearbyTransporter[] = [];

      for (const entry of nearbyTransporters) {
        if (result.length >= limit) break;

        const details = detailsMap.get(entry.member) || {};
        if (Object.keys(details).length === 0) continue;
        if (details.isOnTrip === 'true') continue;

        const transporterLat = Number(details.latitude);
        const transporterLng = Number(details.longitude);
        if (!Number.isFinite(transporterLat) || !Number.isFinite(transporterLng)) continue;

        result.push({
          transporterId: entry.member,
          distance: entry.distance || 0,
          vehicleKey: details.vehicleKey || vehicleKey,
          vehicleId: details.vehicleId || '',
          latitude: transporterLat,
          longitude: transporterLng
        });
      }
      logger.info('[Availability] matching.source=redis_geo', {
        matchingSource: 'redis_geo',
        vehicleKey,
        radiusKm,
        candidates: nearbyTransporters.length,
        matched: result.length
      });

      return result;

    } catch (error: any) {
      logger.error(`[Availability] getAvailableTransportersWithDetails failed: ${error.message}`);
      return this.getAvailableTransportersWithFallback({
        vehicleKey,
        latitude,
        longitude,
        limit,
        radiusKm,
        errorMessage: error?.message || 'unknown'
      });
    }
  }

  private async getAvailableTransportersWithFallback(params: {
    vehicleKey: string;
    latitude: number;
    longitude: number;
    limit: number;
    radiusKm: number;
    errorMessage: string;
  }): Promise<NearbyTransporter[]> {
    const { vehicleKey, latitude, longitude, limit, radiusKm, errorMessage } = params;
    const normalizedVehicleKey = vehicleKey.trim().toLowerCase();
    const now = Date.now();
    const throttleKey = `${normalizedVehicleKey}|${Math.round(radiusKm * 10)}`;
    const lastRun = this.geoFallbackLastRunMs.get(throttleKey) ?? 0;
    if (now - lastRun < this.GEO_FALLBACK_MIN_INTERVAL_MS) {
      logger.warn('[Availability] GEO fallback throttled', {
        vehicleKey,
        radiusKm,
        waitMs: this.GEO_FALLBACK_MIN_INTERVAL_MS - (now - lastRun),
        reason: errorMessage
      });
      return [];
    }
    this.geoFallbackLastRunMs.set(throttleKey, now);
    if (this.geoFallbackLastRunMs.size > 3000) {
      const oldestKey = this.geoFallbackLastRunMs.keys().next().value;
      if (oldestKey) {
        this.geoFallbackLastRunMs.delete(oldestKey);
      }
    }

    try {
      logger.info('[Availability] matching.source=fallback_db', {
        matchingSource: 'fallback_db',
        vehicleKey: normalizedVehicleKey,
        radiusKm,
        reason: errorMessage
      });
      const candidateTransporters = await db.getTransportersByVehicleKey(
        normalizedVehicleKey,
        this.GEO_FALLBACK_MAX_CANDIDATES
      );
      if (candidateTransporters.length === 0) {
        logger.warn('[Availability] GEO fallback found no candidate transporters', {
          vehicleKey: normalizedVehicleKey,
          radiusKm
        });
        return [];
      }

      const detailsMap = await this.loadTransporterDetailsMap(candidateTransporters);
      const result: NearbyTransporter[] = [];
      for (const transporterId of candidateTransporters) {
        if (result.length >= limit) break;

        const details = detailsMap.get(transporterId) || {};
        if (Object.keys(details).length === 0) continue;
        if (details.isOnTrip === 'true') continue;

        const indexedKeys = (details.vehicleKeys || '')
          .split(',')
          .map((key) => key.trim().toLowerCase())
          .filter(Boolean);
        const currentVehicleKey = (details.vehicleKey || '').trim().toLowerCase();
        const keyMatches = currentVehicleKey === normalizedVehicleKey || indexedKeys.includes(normalizedVehicleKey);
        if (!keyMatches) continue;

        const candidateLat = Number(details.latitude);
        const candidateLng = Number(details.longitude);
        if (!Number.isFinite(candidateLat) || !Number.isFinite(candidateLng)) continue;

        const distanceKm = haversineDistanceKm(
          latitude,
          longitude,
          candidateLat,
          candidateLng
        );
        if (distanceKm > radiusKm) continue;

        result.push({
          transporterId,
          distance: distanceKm,
          vehicleKey: details.vehicleKey || normalizedVehicleKey,
          vehicleId: details.vehicleId || '',
          latitude: candidateLat,
          longitude: candidateLng
        });
      }

      result.sort((left, right) => left.distance - right.distance);
      logger.warn('[Availability] GEO fallback served results from DB+Redis details', {
        vehicleKey: normalizedVehicleKey,
        radiusKm,
        matched: result.length,
        candidatesScanned: candidateTransporters.length
      });
      return result.slice(0, limit);
    } catch (fallbackError: any) {
      logger.error('[Availability] GEO fallback failed', {
        vehicleKey: normalizedVehicleKey,
        radiusKm,
        sourceError: errorMessage,
        fallbackError: fallbackError?.message || 'unknown'
      });
      return [];
    }
  }

  async loadTransporterDetailsMap(
    transporterIds: string[]
  ): Promise<Map<string, Record<string, string>>> {
    const uniqueIds = Array.from(new Set(transporterIds.filter(Boolean)));
    if (uniqueIds.length === 0) return new Map();

    const keys = uniqueIds.map((id) => REDIS_KEYS.TRANSPORTER_DETAILS(id));
    const detailsList = await redisService.hGetAllBatch(keys).catch(() =>
      uniqueIds.map(() => ({} as Record<string, string>))
    );

    const detailsMap = new Map<string, Record<string, string>>();
    uniqueIds.forEach((id, index) => {
      detailsMap.set(id, detailsList[index] || {});
    });
    return detailsMap;
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
        REDIS_KEYS.TRANSPORTER_DETAILS(transporterId)
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
   * Get transporter details
   */
  async getTransporterDetails(transporterId: string): Promise<TransporterAvailability | null> {
    try {
      const details = await redisService.hGetAll(
        REDIS_KEYS.TRANSPORTER_DETAILS(transporterId)
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
      const totalOnline = await redisService.sCard(REDIS_KEYS.ONLINE_TRANSPORTERS);
      const byVehicleType: Record<string, number> = {};
      const byGeohash: Record<string, number> = {};

      // Get breakdown by vehicle type (BATCHED — single pipeline instead of N GETs)
      const onlineTransporters = await redisService.sMembers(REDIS_KEYS.ONLINE_TRANSPORTERS);
      const transporterSlice = onlineTransporters.slice(0, 1000);

      if (transporterSlice.length > 0) {
        const detailsMap = await this.loadTransporterDetailsMap(transporterSlice);
        for (const [, details] of detailsMap.entries()) {
          const vehicleKey = details.vehicleKey;
          if (vehicleKey) {
            byVehicleType[vehicleKey] = (byVehicleType[vehicleKey] || 0) + 1;
          }
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
      await redisService.sCard(REDIS_KEYS.ONLINE_TRANSPORTERS);

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
