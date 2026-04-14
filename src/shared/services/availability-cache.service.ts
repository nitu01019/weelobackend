/**
 * =============================================================================
 * AVAILABILITY CACHE SERVICE — Stats, health check, cache queries
 * =============================================================================
 * Extracted from availability.service.ts for modularity.
 * =============================================================================
 */

import { logger } from './logger.service';
import { redisService } from './redis.service';
import { prismaClient } from '../database/prisma.service';
import { REDIS_KEYS, type AvailabilityStats, type TransporterAvailability } from './availability-types';

/**
 * Batch load transporter details from Redis hashes.
 * Shared utility used by both geo and cache services.
 */
export async function loadTransporterDetailsMap(
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
 * Check if a specific transporter is available (async)
 */
export async function isAvailableAsync(transporterId: string): Promise<boolean> {
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
export async function getTransporterDetails(transporterId: string): Promise<TransporterAvailability | null> {
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
 * Async version of getStats
 */
export async function getStatsAsync(): Promise<AvailabilityStats> {
  try {
    const totalOnline = await redisService.sCard(REDIS_KEYS.ONLINE_TRANSPORTERS);
    const byVehicleType: Record<string, number> = {};
    const byGeohash: Record<string, number> = {};

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
      const detailsMap = await loadTransporterDetailsMap(transporterSlice);
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
  } catch (error: unknown) {
    logger.error(`[Availability] getStatsAsync failed: ${error instanceof Error ? error.message : String(error)}`);
    return { totalOnline: 0, byVehicleType: {}, byGeohash: {}, redisMode: false };
  }
}

/**
 * Health check
 */
export async function healthCheck(): Promise<{ healthy: boolean; mode: string; latencyMs: number }> {
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
 */
export async function rebuildGeoFromDB(): Promise<void> {
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
      await redisService.sAdd(REDIS_KEYS.ONLINE_TRANSPORTERS, t.id);
      rebuilt++;
    }

    logger.warn(
      `[Availability] Geo rebuild: added ${rebuilt} transporters to online set. ` +
      `Full geo index will rebuild via heartbeats within 5s.`
    );
  } catch (err: unknown) {
    logger.error(`[Availability] rebuildGeoFromDB failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
