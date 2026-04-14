/**
 * =============================================================================
 * AVAILABILITY GEO SERVICE — Geo search, GEORADIUS, H3 queries
 * =============================================================================
 * Extracted from availability.service.ts for modularity.
 * =============================================================================
 */

import { logger } from './logger.service';
import { redisService } from './redis.service';
import { db } from '../database/db';
import { haversineDistanceKm } from '../utils/geospatial.utils';
import { h3GeoIndexService } from './h3-geo-index.service';
import { REDIS_KEYS, type NearbyTransporter } from './availability-types';
import { loadTransporterDetailsMap } from './availability-cache.service';

/**
 * GEO failure fallback throttling (per vehicleKey+radius).
 */
const GEO_FALLBACK_MIN_INTERVAL_MS = parseInt(
  process.env.GEO_FALLBACK_MIN_INTERVAL_MS || '1500',
  10
);
const GEO_FALLBACK_MAX_CANDIDATES = parseInt(
  process.env.GEO_FALLBACK_MAX_CANDIDATES || '800',
  10
);
const geoFallbackLastRunMs = new Map<string, number>();

/**
 * Async version - USE THIS for proper Redis-powered searches
 */
export async function getAvailableTransportersAsync(
  vehicleKey: string,
  latitude: number,
  longitude: number,
  limit: number = 20,
  radiusKm: number = 50
): Promise<string[]> {
  try {
    const nearbyTransporters = await redisService.geoRadius(
      REDIS_KEYS.GEO_TRANSPORTERS(vehicleKey),
      longitude, latitude, radiusKm, 'km'
    );

    const detailsMap = await loadTransporterDetailsMap(
      nearbyTransporters.map((entry) => entry.member)
    );

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

    const validTransporters: Array<{ id: string; distance: number }> = [];
    for (let i = 0; i < nearbyTransporters.length; i++) {
      const entry = nearbyTransporters[i];

      if (!onlineFlags[i]) {
        await redisService.geoRemove(
          REDIS_KEYS.GEO_TRANSPORTERS(vehicleKey), entry.member
        ).catch(() => {});
        continue;
      }

      const details = detailsMap.get(entry.member) || {};

      if (Object.keys(details).length === 0) {
        try {
          await redisService.geoRemove(REDIS_KEYS.GEO_TRANSPORTERS(vehicleKey), entry.member);
          await redisService.sRem(REDIS_KEYS.ONLINE_TRANSPORTERS, entry.member);
          h3GeoIndexService.removeTransporter(entry.member).catch(() => {});
        } catch (cleanupErr: unknown) {
          logger.warn(`[Availability] Stale cleanup failed for ${entry.member}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
        }
        continue;
      }

      if (details.isOnTrip === 'true') continue;

      validTransporters.push({ id: entry.member, distance: entry.distance || 0 });
    }

    const result = validTransporters.slice(0, limit).map(d => d.id);

    logger.info(`[Availability] Found ${result.length} available for ${vehicleKey} within ${radiusKm}km of (${latitude}, ${longitude})`);
    logger.info('[Availability] matching.source=redis_geo', {
      matchingSource: 'redis_geo', vehicleKey, radiusKm,
      candidates: nearbyTransporters.length, matched: result.length
    });

    return result;
  } catch (error: unknown) {
    logger.error(`[Availability] getAvailableTransportersAsync failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * Get available transporters with full details
 */
export async function getAvailableTransportersWithDetails(
  vehicleKey: string,
  latitude: number,
  longitude: number,
  limit: number = 20,
  radiusKm: number = 50
): Promise<NearbyTransporter[]> {
  try {
    const nearbyTransporters = await redisService.geoRadius(
      REDIS_KEYS.GEO_TRANSPORTERS(vehicleKey),
      longitude, latitude, radiusKm, 'km'
    );

    const detailsMap = await loadTransporterDetailsMap(
      nearbyTransporters.map((entry) => entry.member)
    );

    // Online check — same pattern as getAvailableTransportersAsync()
    const transporterIds = nearbyTransporters.map(entry => entry.member);
    let onlineFlags: boolean[];
    try {
      onlineFlags = await redisService.smIsMembers(REDIS_KEYS.ONLINE_TRANSPORTERS, transporterIds);
    } catch (err) {
      logger.warn('[Availability] smIsMembers failed in getAvailableTransportersWithDetails, fail-open applied', {
        error: err instanceof Error ? err.message : String(err),
        candidateCount: transporterIds.length
      });
      onlineFlags = transporterIds.map(() => true);
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
      matchingSource: 'redis_geo', vehicleKey, radiusKm,
      candidates: nearbyTransporters.length, matched: result.length
    });

    return result;
  } catch (error: unknown) {
    logger.error(`[Availability] getAvailableTransportersWithDetails failed: ${error instanceof Error ? error.message : String(error)}`);
    return getAvailableTransportersWithFallback({
      vehicleKey, latitude, longitude, limit, radiusKm,
      errorMessage: error instanceof Error ? error.message : 'unknown'
    });
  }
}

export async function getAvailableTransportersWithFallback(params: {
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
  const lastRun = geoFallbackLastRunMs.get(throttleKey) ?? 0;
  if (now - lastRun < GEO_FALLBACK_MIN_INTERVAL_MS) {
    logger.warn('[Availability] GEO fallback throttled', {
      vehicleKey, radiusKm, waitMs: GEO_FALLBACK_MIN_INTERVAL_MS - (now - lastRun), reason: errorMessage
    });
    return [];
  }
  geoFallbackLastRunMs.set(throttleKey, now);
  if (geoFallbackLastRunMs.size > 3000) {
    const oldestKey = geoFallbackLastRunMs.keys().next().value;
    if (oldestKey) geoFallbackLastRunMs.delete(oldestKey);
  }

  try {
    logger.info('[Availability] matching.source=fallback_db', {
      matchingSource: 'fallback_db', vehicleKey: normalizedVehicleKey, radiusKm, reason: errorMessage
    });
    const candidateTransporters = await db.getTransportersByVehicleKey(
      normalizedVehicleKey, GEO_FALLBACK_MAX_CANDIDATES
    );
    if (candidateTransporters.length === 0) {
      logger.warn('[Availability] GEO fallback found no candidate transporters', { vehicleKey: normalizedVehicleKey, radiusKm });
      return [];
    }

    const detailsMap = await loadTransporterDetailsMap(candidateTransporters);
    const result: NearbyTransporter[] = [];
    for (const transporterId of candidateTransporters) {
      if (result.length >= limit) break;

      const details = detailsMap.get(transporterId) || {};
      if (Object.keys(details).length === 0) continue;
      if (details.isOnTrip === 'true') continue;

      const indexedKeys = (details.vehicleKeys || '').split(',').map((key) => key.trim().toLowerCase()).filter(Boolean);
      const currentVehicleKey = (details.vehicleKey || '').trim().toLowerCase();
      const keyMatches = currentVehicleKey === normalizedVehicleKey || indexedKeys.includes(normalizedVehicleKey);
      if (!keyMatches) continue;

      const candidateLat = Number(details.latitude);
      const candidateLng = Number(details.longitude);
      if (!Number.isFinite(candidateLat) || !Number.isFinite(candidateLng)) continue;

      const distanceKm = haversineDistanceKm(latitude, longitude, candidateLat, candidateLng);
      if (distanceKm > radiusKm) continue;

      result.push({
        transporterId, distance: distanceKm,
        vehicleKey: details.vehicleKey || normalizedVehicleKey,
        vehicleId: details.vehicleId || '',
        latitude: candidateLat, longitude: candidateLng
      });
    }

    result.sort((left, right) => left.distance - right.distance);
    logger.warn('[Availability] GEO fallback served results from DB+Redis details', {
      vehicleKey: normalizedVehicleKey, radiusKm, matched: result.length, candidatesScanned: candidateTransporters.length
    });
    return result.slice(0, limit);
  } catch (fallbackError: unknown) {
    logger.error('[Availability] GEO fallback failed', {
      vehicleKey: normalizedVehicleKey, radiusKm, sourceError: errorMessage, fallbackError: fallbackError instanceof Error ? fallbackError.message : 'unknown'
    });
    return [];
  }
}

/**
 * Async version for multiple vehicle keys
 */
export async function getAvailableTransportersMultiAsync(
  vehicleKeys: string[],
  latitude: number,
  longitude: number,
  limitPerType: number = 20
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();

  const searches = vehicleKeys.map(async (vehicleKey) => {
    const transporters = await getAvailableTransportersAsync(
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
