/**
 * =============================================================================
 * TRACKING MODULE - HISTORY PERSISTENCE SERVICE
 * =============================================================================
 *
 * Handles location history storage, sampling, and persist state management.
 * Includes the Redis-backed history persist state (with in-memory fallback)
 * and the tracking event stream publisher.
 * =============================================================================
 */

import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { queueService } from '../../shared/services/queue.service';
import { prismaClient } from '../../shared/database/prisma.service';
import { haversineDistanceMeters } from '../../shared/utils/geospatial.utils';
import { LocationHistoryEntry } from './tracking.schema';
import {
  REDIS_KEYS,
  TTL,
  HISTORY_PERSIST_MIN_INTERVAL_MS,
  HISTORY_PERSIST_MIN_MOVEMENT_METERS,
  HISTORY_STATE_MAX_ENTRIES,
  TRACKING_STREAM_ENABLED,
  HistoryPersistState,
} from './tracking.types';

class TrackingHistoryService {
  // WARNING: In-memory state — lost on ECS restart. TODO: migrate to Redis.
  // KNOWN_ISSUE(H2): history persist state resets on restart; harmless (next GPS update re-seeds it)
  private readonly historyPersistStateByTrip = new Map<string, HistoryPersistState>();

  /**
   * Add location to history (Redis list)
   */
  async addToHistory(tripId: string, entry: LocationHistoryEntry): Promise<void> {
    try {
      const key = REDIS_KEYS.TRIP_HISTORY(tripId);
      // Use Redis list ops: O(1) append, atomic, no read-modify-write race
      await redisService.rPush(key, JSON.stringify(entry));
      // Cap at last 5000 points (H-30: supports ~7-14h trips at 10s intervals)
      await redisService.lTrim(key, -5000, -1);
      await redisService.expire(key, TTL.HISTORY);
    } catch (error: unknown) {
      if (String(error instanceof Error ? error.message : error).includes('WRONGTYPE')) {
        // Backward compatibility: older versions stored history as JSON string.
        // Reset key type once and retry list write.
        const key = REDIS_KEYS.TRIP_HISTORY(tripId);
        try {
          await redisService.del(key);
          await redisService.rPush(key, JSON.stringify(entry));
          await redisService.lTrim(key, -5000, -1);
          await redisService.expire(key, TTL.HISTORY);
          return;
        } catch (retryError) {
          logger.warn(`Failed to recover history key type: ${retryError}`);
        }
      }
      // Non-critical - log but don't throw
      logger.warn(`Failed to add to history: ${error}`);
    }
  }

  async shouldPersistHistoryPoint(tripId: string, entry: LocationHistoryEntry, status: string): Promise<boolean> {
    const timestampMs = new Date(entry.timestamp).getTime();
    if (!Number.isFinite(timestampMs)) return false;

    const previous = await this.getHistoryPersistState(tripId);
    if (!previous) {
      await this.setHistoryPersistState(tripId, {
        latitude: entry.latitude,
        longitude: entry.longitude,
        timestampMs,
        status
      });
      return true;
    }

    const isStatusChange = previous.status !== status;
    if (timestampMs <= previous.timestampMs && !isStatusChange) {
      return false;
    }

    const elapsedMs = Math.max(0, timestampMs - previous.timestampMs);
    const movedMeters = haversineDistanceMeters(
      previous.latitude,
      previous.longitude,
      entry.latitude,
      entry.longitude
    );
    const shouldPersist = isStatusChange ||
      elapsedMs >= HISTORY_PERSIST_MIN_INTERVAL_MS ||
      movedMeters >= HISTORY_PERSIST_MIN_MOVEMENT_METERS;

    if (shouldPersist) {
      await this.setHistoryPersistState(tripId, {
        latitude: entry.latitude,
        longitude: entry.longitude,
        timestampMs,
        status
      });
    }
    return shouldPersist;
  }

  rememberHistoryPersistState(tripId: string, state: HistoryPersistState): void {
    if (this.historyPersistStateByTrip.has(tripId)) {
      this.historyPersistStateByTrip.delete(tripId);
    }
    this.historyPersistStateByTrip.set(tripId, state);
    if (this.historyPersistStateByTrip.size > HISTORY_STATE_MAX_ENTRIES) {
      const oldestKey = this.historyPersistStateByTrip.keys().next().value;
      if (oldestKey) {
        this.historyPersistStateByTrip.delete(oldestKey);
      }
    }
  }

  // ===========================================================================
  // REDIS-BACKED HISTORY PERSIST STATE (FIX A4#20)
  // ===========================================================================
  // Replaces in-memory-only Map with Redis-backed storage (48h TTL).
  // In-memory Map kept as fallback if Redis read/write fails.
  // ===========================================================================

  async getHistoryPersistState(tripId: string): Promise<HistoryPersistState | null> {
    try {
      const redisState = await redisService.getJSON<HistoryPersistState>(REDIS_KEYS.HISTORY_PERSIST_STATE(tripId));
      if (redisState) {
        // Sync in-memory fallback
        this.historyPersistStateByTrip.set(tripId, redisState);
        return redisState;
      }
    } catch (err: unknown) {
      logger.debug('[TRACKING] Redis persist state read failed, using in-memory fallback', {
        tripId, error: err instanceof Error ? err.message : String(err)
      });
    }
    // Fallback to in-memory Map
    return this.historyPersistStateByTrip.get(tripId) || null;
  }

  async setHistoryPersistState(tripId: string, state: HistoryPersistState): Promise<void> {
    // Always update in-memory fallback
    this.rememberHistoryPersistState(tripId, state);
    // Write to Redis with 48h TTL (fire-and-forget — non-critical)
    const TTL_48H = 48 * 60 * 60; // 172800 seconds
    try {
      await redisService.setJSON(REDIS_KEYS.HISTORY_PERSIST_STATE(tripId), state, TTL_48H);
    } catch (err: unknown) {
      logger.debug('[TRACKING] Redis persist state write failed (in-memory fallback active)', {
        tripId, error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  async deleteHistoryPersistState(tripId: string): Promise<void> {
    this.historyPersistStateByTrip.delete(tripId);
    try {
      await redisService.del(REDIS_KEYS.HISTORY_PERSIST_STATE(tripId));
    } catch {
      // Non-critical — key will expire via TTL
    }
  }

  // ===========================================================================
  // H-23: FLUSH GPS HISTORY TO DB ON TRIP COMPLETION
  // ===========================================================================
  // Reads the Redis history list for a trip and batch-inserts to TripRoutePoint.
  // Called on trip completion so route data survives Redis TTL expiry.
  // Non-fatal: if DB write fails, data remains in Redis for 7 days.
  // ===========================================================================

  // F-M19 FIX: Douglas-Peucker route compression — 70-90% point reduction
  async flushHistoryToDb(tripId: string): Promise<void> {
    const key = REDIS_KEYS.TRIP_HISTORY(tripId);
    try {
      const raw = await redisService.lRange(key, 0, -1);
      if (!raw || raw.length === 0) {
        logger.debug('[TRACKING] No history points to flush', { tripId });
        return;
      }

      const points = raw
        .map(r => {
          try { return JSON.parse(r); } catch { return null; }
        })
        .filter(Boolean)
        .map((p: Record<string, unknown>) => ({
          tripId,
          latitude: Number(p.latitude || p.lat) || 0,
          longitude: Number(p.longitude || p.lng) || 0,
          speed: p.speed != null ? Number(p.speed) : null,
          heading: p.heading != null ? Number(p.heading) : (p.bearing != null ? Number(p.bearing) : null),
          timestamp: new Date(String(p.timestamp || p.ts || Date.now())),
        }))
        .filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));

      if (points.length === 0) {
        logger.debug('[TRACKING] All history points invalid after parsing', { tripId });
        return;
      }

      // F-M19: Apply Douglas-Peucker compression before DB insert
      const rawCount = points.length;
      const compressed = simplifyRoute(points, 0.0002);

      if (rawCount !== compressed.length) {
        logger.info(`[TRACKING] Route compressed: ${rawCount} → ${compressed.length} points (${Math.round((1 - compressed.length / rawCount) * 100)}% reduction)`, { tripId });
      }

      // Batch insert in chunks of 500 to avoid oversized queries
      const BATCH_SIZE = 500;
      for (let i = 0; i < compressed.length; i += BATCH_SIZE) {
        await prismaClient.tripRoutePoint.createMany({
          data: compressed.slice(i, i + BATCH_SIZE),
          skipDuplicates: true,
        });
      }

      logger.info(`[TRACKING] Flushed ${compressed.length} route points to DB`, { tripId });
    } catch (err: unknown) {
      // Non-fatal: Redis history remains for 7 days as backup
      logger.warn('[TRACKING] Failed to flush history to DB (non-fatal)', {
        tripId, error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  publishTrackingEventAsync(event: {
    driverId: string;
    tripId: string;
    bookingId?: string;
    orderId?: string;
    latitude: number;
    longitude: number;
    speed: number;
    bearing: number;
    ts: string;
    source: 'gps' | 'batch_sync' | 'system';
  }): void {
    if (!TRACKING_STREAM_ENABLED) return;
    queueService.queueTrackingEvent(event).catch((error) => {
      logger.warn(`[TRACKING] Failed to enqueue tracking event: ${error.message}`, {
        tripId: event.tripId,
        driverId: event.driverId
      });
    });
  }
}

// F-M19 FIX: Douglas-Peucker route compression — 70-90% point reduction
// Inline implementation to avoid external dependency (simplify-js)
function perpendicularDistance(
  point: { latitude: number; longitude: number },
  lineStart: { latitude: number; longitude: number },
  lineEnd: { latitude: number; longitude: number }
): number {
  const dx = lineEnd.longitude - lineStart.longitude;
  const dy = lineEnd.latitude - lineStart.latitude;
  const norm = Math.sqrt(dx * dx + dy * dy);
  if (norm === 0) return Math.sqrt(
    Math.pow(point.longitude - lineStart.longitude, 2) +
    Math.pow(point.latitude - lineStart.latitude, 2)
  );
  return Math.abs(
    dy * point.longitude - dx * point.latitude +
    lineEnd.longitude * lineStart.latitude - lineEnd.latitude * lineStart.longitude
  ) / norm;
}

function simplifyRoute<T extends { latitude: number; longitude: number }>(
  points: T[],
  epsilon: number = 0.0002
): T[] {
  if (points.length <= 2) return points;

  // Find the point with maximum distance from the line between first and last
  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistance(points[i], first, last);
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = simplifyRoute(points.slice(0, maxIdx + 1), epsilon);
    const right = simplifyRoute(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}

export const trackingHistoryService = new TrackingHistoryService();
