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
import { prismaClient } from '../database/prisma.service';
import { haversineDistanceKm } from '../utils/geospatial.utils';
import { h3GeoIndexService } from './h3-geo-index.service';
import { metrics } from '../monitoring/metrics.service';

// =============================================================================
// M-16 FIX: Atomic heartbeat update via Lua script.
// Replaces separate del() + sAdd() which has a tiny window where the set
// does not exist (race condition during concurrent heartbeats).
// Single round-trip: DEL + SADD(members) + EXPIRE in one atomic op.
// =============================================================================
const LUA_HEARTBEAT_SET_UPDATE = `
redis.call('DEL', KEYS[1])
for i = 1, #ARGV - 1 do
  redis.call('SADD', KEYS[1], ARGV[i])
end
redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
return 1
`;

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
    // Fire-and-forget is acceptable (Uber uses same pattern for GPS updates --
    // next heartbeat corrects drift). But failures must be visible in monitoring.
    this.updateAvailabilityAsync(data).catch(err => {
      logger.error(`[Availability] Update failed: ${err.message}`);
      // Increment failure counter for monitoring dashboards / alerting
      try {
        metrics.incrementCounter('availability.update.failure_total');
      } catch { /* metrics service may not be initialized */ }
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
      // Fix C4/F-5-14: Phase 1 — parallel reads (was 8-10 sequential Redis calls)
      const [previousVehicleKey, previousVehicleKeys] = await Promise.all([
        redisService.get(REDIS_KEYS.TRANSPORTER_VEHICLE(transporterId)),
        redisService.sMembers(REDIS_KEYS.TRANSPORTER_VEHICLE_KEYS(transporterId)).catch(() => [] as string[])
      ]);

      // Phase 2: Stale cleanup in parallel
      const staleVehicleKeys = new Set(previousVehicleKeys);
      if (previousVehicleKey) staleVehicleKeys.add(previousVehicleKey);
      const staleRemoveOps: Promise<any>[] = [];
      for (const staleKey of staleVehicleKeys) {
        if (!staleKey || staleKey === vehicleKey) continue;
        staleRemoveOps.push(
          redisService.geoRemove(REDIS_KEYS.GEO_TRANSPORTERS(staleKey), transporterId)
        );
      }
      if (staleRemoveOps.length > 0) {
        await Promise.all(staleRemoveOps);
      }

      // Phase 3: All writes batched via Promise.all
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

      // M-16 FIX: Atomic del+sAdd+expire via Lua (replaces separate del then sAdd)
      const vehicleKeysKey = REDIS_KEYS.TRANSPORTER_VEHICLE_KEYS(transporterId);
      const writeOps: Promise<any>[] = [
        redisService.hMSet(REDIS_KEYS.TRANSPORTER_DETAILS(transporterId), details),
        redisService.set(REDIS_KEYS.TRANSPORTER_VEHICLE(transporterId), vehicleKey, this.TRANSPORTER_TTL_SECONDS),
        redisService.eval(
          LUA_HEARTBEAT_SET_UPDATE,
          [vehicleKeysKey],
          [vehicleKey, String(this.TRANSPORTER_TTL_SECONDS)]
        ),
      ];

      if (!isOnTrip) {
        writeOps.push(
          redisService.geoAdd(REDIS_KEYS.GEO_TRANSPORTERS(vehicleKey), longitude, latitude, transporterId),
          redisService.sAdd(REDIS_KEYS.ONLINE_TRANSPORTERS, transporterId)
        );
      } else {
        writeOps.push(
          redisService.geoRemove(REDIS_KEYS.GEO_TRANSPORTERS(vehicleKey), transporterId)
        );
      }

      await Promise.all(writeOps);

      // Phase 4: TTL refreshes in parallel
      // Fix C5/F-5-15: Safety-net TTL on geo + online keys — refreshed every heartbeat, expires if no heartbeats for 10 min
      // Note: TRANSPORTER_VEHICLE_KEYS TTL is now set atomically inside LUA_HEARTBEAT_SET_UPDATE (M-16)
      // H-7 FIX: Add jitter (0-59s) to shared-key TTLs to spread EXPIRE calls and reduce Redis hotspot contention
      const jitteredTtl = 600 + Math.floor(Math.random() * 60);
      await Promise.all([
        redisService.expire(REDIS_KEYS.TRANSPORTER_DETAILS(transporterId), this.TRANSPORTER_TTL_SECONDS),
        ...(!isOnTrip ? [
          redisService.expire(REDIS_KEYS.GEO_TRANSPORTERS(vehicleKey), jitteredTtl).catch(() => {}),
          redisService.expire(REDIS_KEYS.ONLINE_TRANSPORTERS, jitteredTtl).catch(() => {}),
        ] : []),
      ]);

      if (!isOnTrip) {
        logger.debug(`[Availability] Updated: ${transporterId} @ (${latitude}, ${longitude}) - ${vehicleKey}`);
      } else {
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
    // M-16 FIX: Atomic del+sAdd+expire via Lua (replaces separate del then sAdd+expire)
    await redisService.eval(
      LUA_HEARTBEAT_SET_UPDATE,
      [REDIS_KEYS.TRANSPORTER_VEHICLE_KEYS(transporterId)],
      [...currentVehicleKeys, String(this.TRANSPORTER_TTL_SECONDS)]
    );

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
   * @deprecated Use {@link getAvailableTransportersAsync} instead. Will be removed in v2.
   * This synchronous wrapper always returns [] because Redis operations are async.
   * Retained only for backward API compatibility.
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
    logger.warn('[Availability] DEPRECATED: getAvailableTransporters called -- use getAvailableTransportersAsync');

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

      // H-P4 FIX: Batch SMISMEMBER replaces per-transporter SISMEMBER loop.
      // Single Redis round-trip instead of N round-trips.
      const transporterIds = nearbyTransporters.map(entry => entry.member);
      let onlineFlags: boolean[];
      try {
        onlineFlags = await redisService.smIsMembers(REDIS_KEYS.ONLINE_TRANSPORTERS, transporterIds);
      } catch (err) {
        logger.warn('[Availability] smIsMembers failed, fail-open applied', {
          error: err instanceof Error ? err.message : String(err),
          candidateCount: transporterIds.length
        });
        onlineFlags = transporterIds.map(() => true);
      }

      // Filter out transporters who are offline, on trip, or stale.
      const validTransporters: Array<{ id: string; distance: number }> = [];
      for (let i = 0; i < nearbyTransporters.length; i++) {
        const entry = nearbyTransporters[i];

        if (!onlineFlags[i]) {
          // Not in online set -- clean up stale geo entry
          await redisService.geoRemove(
            REDIS_KEYS.GEO_TRANSPORTERS(vehicleKey), entry.member
          ).catch(() => {});
          continue;
        }

        const details = detailsMap.get(entry.member) || {};

        // Skip if no details (TTL expired = offline).
        if (Object.keys(details).length === 0) {
          // FIX #2: Clean up stale entry from ALL indexes, not just current vehicleKey geo.
          // Previously only removed from the single geo index being queried, leaving
          // the transporter in online SET and H3 cells for up to 90s.
          try {
            await redisService.geoRemove(
              REDIS_KEYS.GEO_TRANSPORTERS(vehicleKey),
              entry.member
            );
            // Also remove from online set (stale entry)
            await redisService.sRem(REDIS_KEYS.ONLINE_TRANSPORTERS, entry.member);
            // Also clean H3 index (fire-and-forget)
            h3GeoIndexService.removeTransporter(entry.member).catch(() => {});
          } catch (cleanupErr: any) {
            // Non-critical: don't let cleanup failure break the query path
            logger.warn(`[Availability] Stale cleanup failed for ${entry.member}: ${cleanupErr.message}`);
          }
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

      // Online check — filter out offline transporters (same pattern as availability-geo.service.ts)
      const transporterIds = nearbyTransporters.map(entry => entry.member);
      let onlineFlags: boolean[];
      try {
        onlineFlags = await redisService.smIsMembers(REDIS_KEYS.ONLINE_TRANSPORTERS, transporterIds);
      } catch (err) {
        logger.warn('[Availability] Online filter failed in getAvailableTransportersWithDetails, proceeding with all candidates', {
          error: err instanceof Error ? err.message : String(err),
          candidateCount: transporterIds.length
        });
        onlineFlags = transporterIds.map(() => true); // fail-open
      }

      const result: NearbyTransporter[] = [];

      for (let i = 0; i < nearbyTransporters.length; i++) {
        if (result.length >= limit) break;

        const entry = nearbyTransporters[i];

        // Filter out offline transporters and clean up stale geo entries
        if (!onlineFlags[i]) {
          await redisService.geoRemove(
            REDIS_KEYS.GEO_TRANSPORTERS(vehicleKey), entry.member
          ).catch(() => {});
          continue;
        }

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
   * @deprecated Use {@link getAvailableTransportersMultiAsync} instead. Will be removed in v2.
   * This synchronous wrapper always returns an empty Map because Redis operations are async.
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

      // Fix C7/F-5-23: Use SSCAN for bounded member fetch instead of SMEMBERS on unbounded SET
      const onlineTransporters: string[] = [];
      let scanCursor = '0';
      do {
        const [newCursor, batch] = await redisService.sScan(REDIS_KEYS.ONLINE_TRANSPORTERS, scanCursor, 100);
        scanCursor = newCursor;
        onlineTransporters.push(...batch);
        if (onlineTransporters.length >= 1000) break;
      } while (scanCursor !== '0');
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
   * Rebuild online:transporters SET from DB after Redis restart.
   *
   * Only runs when the online:transporters SET is empty (cold-start indicator).
   * Queries active transporters from the DB and re-adds them to the online SET
   * so that filterOnline() works immediately. Full geo positions will be
   * repopulated by normal heartbeats within ~5 seconds.
   *
   * Industry pattern: Uber State Digest, Grab Pharos auto-rebuild.
   * Fix #16: Redis restart wipes geo index, no rebuild.
   */
  async rebuildGeoFromDB(): Promise<void> {
    try {
      const onlineCount = await redisService.sCard(REDIS_KEYS.ONLINE_TRANSPORTERS);
      if (onlineCount > 0) {
        logger.info('[Availability] Redis geo index populated -- skipping rebuild');
        return;
      }

      logger.warn('[Availability] Redis geo index EMPTY -- rebuilding from DB');

      const recentTransporters = await prismaClient.user.findMany({
        where: {
          role: 'transporter',
          isAvailable: true,
          isActive: true,
        },
        select: { id: true },
        take: 500,
      });

      if (recentTransporters.length === 0) {
        logger.info('[Availability] No active transporters in DB -- clean cold start');
        return;
      }

      let rebuilt = 0;
      for (const t of recentTransporters) {
        // Add to online SET so filterOnline works immediately.
        // Full geo positions will rebuild via next heartbeat (~5s).
        await redisService.sAdd(REDIS_KEYS.ONLINE_TRANSPORTERS, t.id);
        rebuilt++;
      }

      logger.warn(
        `[Availability] Geo rebuild: added ${rebuilt} transporters to online set. ` +
        `Full geo index will rebuild via heartbeats within 5s.`
      );
    } catch (err: any) {
      logger.error(`[Availability] rebuildGeoFromDB failed: ${err.message}`);
    }
  }

  /**
   * Prune stale geo index entries.
   *
   * Scans all `geo:transporters:*` sorted sets, cross-references each member
   * against the `online:transporters` SET, and removes members whose
   * transporters are offline. This prevents phantom entries from accumulating
   * in the geo index after transporter TTL expiry or missed offline events.
   *
   * Called every 5 minutes from server.ts bootstrap. Uses a distributed lock
   * so only one ECS instance prunes at a time.
   *
   * Industry pattern: Uber Ringpop periodic index scrub.
   */
  async pruneStaleGeoEntries(): Promise<number> {
    const lockKey = 'prune-stale-geo-entries';
    let lockAcquired = false;
    try {
      const lockResult = await redisService.acquireLock(lockKey, 'geo-pruner', 120);
      lockAcquired = lockResult.acquired;
      if (!lockAcquired) return 0;
    } catch {
      return 0;
    }

    let totalPruned = 0;
    try {
      const geoKeys = await redisService.keys('geo:transporters:*');
      if (geoKeys.length === 0) {
        logger.debug('[Availability] Geo prune: no geo keys found');
        return 0;
      }

      for (const geoKey of geoKeys) {
        try {
          // Use geoRadius with earth-scale radius to list all members in this sorted set
          const allMembers = await redisService.geoRadius(geoKey, 0, 0, 40000, 'km');
          if (allMembers.length === 0) continue;

          const memberIds = allMembers.map(m => m.member);

          // Batch check online status via SMISMEMBER (single round-trip)
          let onlineFlags: boolean[];
          try {
            onlineFlags = await redisService.smIsMembers(REDIS_KEYS.ONLINE_TRANSPORTERS, memberIds);
          } catch {
            // If smIsMembers fails, fall back to individual checks
            onlineFlags = await Promise.all(
              memberIds.map(id => redisService.sIsMember(REDIS_KEYS.ONLINE_TRANSPORTERS, id).catch(() => true))
            );
          }

          for (let i = 0; i < memberIds.length; i++) {
            if (!onlineFlags[i]) {
              await redisService.geoRemove(geoKey, memberIds[i]).catch(() => {});
              totalPruned++;
            }
          }
        } catch (err: any) {
          logger.warn(`[Availability] Geo prune failed for key ${geoKey}: ${err.message}`);
        }
      }

      if (totalPruned > 0) {
        logger.info(`[Availability] Geo prune complete: removed ${totalPruned} stale entries from ${geoKeys.length} geo keys`);
      } else {
        logger.debug(`[Availability] Geo prune complete: 0 stale entries (${geoKeys.length} geo keys scanned)`);
      }
    } catch (err: any) {
      logger.error(`[Availability] Geo prune failed: ${err.message}`);
    } finally {
      if (lockAcquired) {
        redisService.releaseLock(lockKey, 'geo-pruner').catch(() => {});
      }
    }

    return totalPruned;
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
