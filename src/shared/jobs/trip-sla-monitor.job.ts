/**
 * Trip SLA Monitor -- Checks active trips for duration anomalies
 *
 * Tier 1 (INFO):  Trip > 12h with no location update in 1h -> log warning
 * Tier 2 (WARN):  Trip > 18h with no location update in 2h -> socket alert to transporter
 * Tier 3 (ALERT): Trip > 24h with no location update in 3h -> log error (Sentry captures)
 *
 * Does NOT auto-cancel -- trucks legitimately take 10-24h
 * Feature flag: FF_TRIP_SLA_MONITOR (default: false)
 */

import { logger } from '../services/logger.service';
import { prismaClient } from '../database/prisma.service';
import { redisService } from '../services/redis.service';

// Lazy import to avoid circular dependency (socket uses driver.service)
function getSocketService(): typeof import('../services/socket.service')['socketService'] {
  return require('../services/socket.service').socketService;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCAN_INTERVAL_MS = 30 * 60 * 1000;   // 30 minutes
const LOCK_KEY = 'trip-sla-monitor';
const LOCK_HOLDER = 'sla-job';
const LOCK_TTL_SECONDS = 120;               // 2 minutes

const HOURS = (h: number): number => h * 60 * 60 * 1000;

const TIER_1_DURATION_MS = HOURS(12);
const TIER_1_STALE_MS   = HOURS(1);

const TIER_2_DURATION_MS = HOURS(18);
const TIER_2_STALE_MS   = HOURS(2);

const TIER_3_DURATION_MS = HOURS(24);
const TIER_3_STALE_MS   = HOURS(3);

const ACTIVE_TRIP_STATUSES = [
  'en_route_pickup',
  'at_pickup',
  'in_transit',
  'arrived_at_drop',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LocationData {
  latitude?: number;
  longitude?: number;
  lastUpdated?: string;  // ISO string — this is what tracking.service.ts stores
  timestamp?: number;    // Legacy fallback (numeric epoch)
}

/**
 * FIX Problem 19: The tracking service stores `lastUpdated` (ISO string),
 * not `timestamp` (number). Parse lastUpdated as a Date, falling back to
 * legacy `timestamp` field for any old-format entries.
 */
async function getLastLocationTimestamp(driverId: string): Promise<number | null> {
  try {
    const raw = await redisService.get(`driver:location:${driverId}`);
    if (!raw) return null;
    const parsed: LocationData = JSON.parse(raw);
    if (parsed.lastUpdated) {
      const ms = new Date(parsed.lastUpdated).getTime();
      if (!isNaN(ms)) return ms;
    }
    return parsed.timestamp ?? null; // fallback for any legacy format
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core scan
// ---------------------------------------------------------------------------

export async function scanActiveTrips(): Promise<void> {
  // Distributed lock -- prevents duplicate processing across ECS instances
  let lockAcquired = false;
  try {
    const lockResult = await redisService.acquireLock(LOCK_KEY, LOCK_HOLDER, LOCK_TTL_SECONDS);
    lockAcquired = lockResult.acquired;
    if (!lockAcquired) {
      return; // Another instance is already running
    }
  } catch (lockErr: unknown) {
    const message = lockErr instanceof Error ? lockErr.message : String(lockErr);
    logger.warn(`[TRIP_SLA] Lock acquisition failed, proceeding without lock: ${message}`);
  }

  try {
    const activeAssignments = await prismaClient.assignment.findMany({
      where: {
        status: { in: [...ACTIVE_TRIP_STATUSES] },
      },
      select: {
        id: true,
        tripId: true,
        driverId: true,
        transporterId: true,
        driverName: true,
        vehicleNumber: true,
        status: true,
        assignedAt: true,
        startedAt: true,
      },
      take: 500, // Batch limit
    });

    const now = Date.now();
    let tier1Count = 0;
    let tier2Count = 0;
    let tier3Count = 0;

    for (const assignment of activeAssignments) {
      // Use startedAt if available, otherwise fall back to assignedAt
      const startTime = assignment.startedAt ?? assignment.assignedAt;
      const tripStartMs = new Date(startTime).getTime();
      if (isNaN(tripStartMs)) continue;

      const durationMs = now - tripStartMs;
      const lastTs = await getLastLocationTimestamp(assignment.driverId);
      const locationStalenessMs = lastTs ? now - lastTs : Infinity;

      // Tier 3 check first (most severe)
      if (durationMs > TIER_3_DURATION_MS && locationStalenessMs > TIER_3_STALE_MS) {
        tier3Count++;
        logger.error(
          `[TRIP_SLA] Tier 3 ALERT: Assignment ${assignment.id} (trip ${assignment.tripId}) ` +
          `driver ${assignment.driverName} (${assignment.driverId}) vehicle ${assignment.vehicleNumber} ` +
          `has been active for ${Math.round(durationMs / HOURS(1))}h with no location update for ` +
          `${lastTs ? Math.round(locationStalenessMs / HOURS(1)) + 'h' : 'NEVER'}. Status: ${assignment.status}`
        );
      } else if (durationMs > TIER_2_DURATION_MS && locationStalenessMs > TIER_2_STALE_MS) {
        tier2Count++;
        logger.warn(
          `[TRIP_SLA] Tier 2 WARN: Assignment ${assignment.id} (trip ${assignment.tripId}) ` +
          `driver ${assignment.driverName} vehicle ${assignment.vehicleNumber} ` +
          `active for ${Math.round(durationMs / HOURS(1))}h, location stale ` +
          `${lastTs ? Math.round(locationStalenessMs / HOURS(1)) + 'h' : 'NEVER'}. Status: ${assignment.status}`
        );
        // Emit socket alert to transporter
        try {
          const socketSvc = getSocketService();
          socketSvc.emitToUser(assignment.transporterId, 'driver_may_be_offline', {
            assignmentId: assignment.id,
            tripId: assignment.tripId,
            driverId: assignment.driverId,
            driverName: assignment.driverName,
            vehicleNumber: assignment.vehicleNumber,
            durationHours: Math.round(durationMs / HOURS(1)),
            lastLocationAgeHours: lastTs ? Math.round(locationStalenessMs / HOURS(1)) : null,
            status: assignment.status,
          });
        } catch (socketErr: unknown) {
          const msg = socketErr instanceof Error ? socketErr.message : String(socketErr);
          logger.warn(`[TRIP_SLA] Socket emit failed for assignment ${assignment.id}: ${msg}`);
        }
      } else if (durationMs > TIER_1_DURATION_MS && locationStalenessMs > TIER_1_STALE_MS) {
        tier1Count++;
        logger.warn(
          `[TRIP_SLA] Tier 1 INFO: Assignment ${assignment.id} (trip ${assignment.tripId}) ` +
          `driver ${assignment.driverName} active for ${Math.round(durationMs / HOURS(1))}h, ` +
          `location stale ${lastTs ? Math.round(locationStalenessMs / HOURS(1)) + 'h' : 'NEVER'}. ` +
          `Status: ${assignment.status}`
        );
      }
      // No alert if location is fresh -- legitimate long-haul trip
    }

    logger.info(
      `[TRIP_SLA] Scan complete: ${activeAssignments.length} active trips, ` +
      `${tier1Count} info, ${tier2Count} warn, ${tier3Count} alert`
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[TRIP_SLA] Scan failed: ${message}`);
  } finally {
    if (lockAcquired) {
      try {
        await redisService.releaseLock(LOCK_KEY, LOCK_HOLDER);
      } catch {
        // Lock will auto-expire via TTL
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

export function startTripSLAMonitor(): void {
  if (process.env.FF_TRIP_SLA_MONITOR !== 'true') {
    logger.info('[TRIP_SLA] Feature flag FF_TRIP_SLA_MONITOR is off, monitor disabled');
    return;
  }

  logger.info('[TRIP_SLA] Starting Trip SLA Monitor (every 30 minutes)');

  // Run immediately on startup
  scanActiveTrips();

  // Then run every 30 minutes
  setInterval(() => {
    scanActiveTrips();
  }, SCAN_INTERVAL_MS);
}
