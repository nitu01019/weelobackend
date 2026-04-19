/**
 * =============================================================================
 * TRACKING MODULE - LOCATION UPDATE SERVICE
 * =============================================================================
 *
 * Core real-time and batch location update logic.
 * Handles single GPS updates from driver app (every 5-10s),
 * batch uploads for offline sync, driver online status,
 * and unrealistic speed jump detection.
 * =============================================================================
 */

import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToBooking, emitToTrip, emitToUser, SocketEvent } from '../../shared/services/socket.service';
import { redisService } from '../../shared/services/redis.service';
import { haversineDistanceMeters } from '../../shared/utils/geospatial.utils';
import {
  UpdateLocationInput,
  BatchLocationInput,
  BatchLocationPoint,
  BatchUploadResult,
  LocationHistoryEntry,
  DriverOnlineStatus,
  TRACKING_CONFIG
} from './tracking.schema';
import {
  REDIS_KEYS,
  TTL,
  LocationData,
} from './tracking.types';
import { trackingHistoryService } from './tracking-history.service';
import { trackingTripService } from './tracking-trip.service';

class TrackingLocationService {
  /**
   * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   * ┃  UPDATE DRIVER LOCATION - The Core of Live Tracking                   ┃
   * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
   *
   * Called by driver app every 5-10 seconds.
   *
   * FLOW:
   * 1. Store in Redis (instant, in-memory)
   * 2. Broadcast via WebSocket (real-time to watchers)
   * 3. Add to history (for route replay)
   *
   * WHAT FRONTEND DOES:
   * - Receives this point
   * - Interpolates between last point and this point
   * - Creates smooth animation (the "live" illusion)
   */
  async updateLocation(driverId: string, data: UpdateLocationInput): Promise<void> {
    try {
      // 1. Get existing trip data from Redis
      const existing = await redisService.getJSON<LocationData>(REDIS_KEYS.TRIP_LOCATION(data.tripId));

      // Verify driver owns this trip
      if (existing && existing.driverId !== driverId) {
        throw new AppError(403, 'FORBIDDEN', 'Not authorized to update this trip');
      }

      const now = new Date().toISOString();

      // =====================================================================
      // GPS SPOOF DETECTION — Layer 1 (Uber/Grab/Gojek pattern)
      // =====================================================================
      // Android Location.isMock() (API 31+) reports if GPS is from a mock provider.
      // We LOG and FLAG but do NOT BLOCK — budget phones sometimes trigger false
      // positives via WiFi-based location providers.
      // Redis flag tracks mock usage per trip for post-trip review.
      // Broadcast includes isMockLocation so customer app can show "⚠️ GPS accuracy low".
      // =====================================================================
      if (data.isMockLocation === true) {
        logger.warn('🚨 [SPOOF] Mock GPS location detected', {
          tripId: data.tripId, driverId,
          lat: data.latitude, lng: data.longitude,
          speed: data.speed, accuracy: data.accuracy
        });
        // Flag the trip in Redis (expires with trip data — 24h)
        redisService.set(`mock_gps:${data.tripId}`, 'true', TTL.TRIP).catch(() => {});
      }

      // 2. Create location data
      const locationData: LocationData = {
        tripId: data.tripId,
        driverId,
        transporterId: existing?.transporterId,
        vehicleId: existing?.vehicleId,
        vehicleNumber: existing?.vehicleNumber || '',
        bookingId: existing?.bookingId || '',
        orderId: existing?.orderId,
        latitude: data.latitude,
        longitude: data.longitude,
        speed: data.speed || 0,
        bearing: data.bearing || 0,
        accuracy: data.accuracy,
        status: existing?.status || 'in_transit',
        lastUpdated: now
      };

      const historyEntry: LocationHistoryEntry = {
        latitude: data.latitude,
        longitude: data.longitude,
        speed: data.speed || 0,
        timestamp: now
      };

      // 3. Store in Redis (both trip and driver location)
      await Promise.all([
        // Trip location (for trip tracking)
        redisService.setJSON(REDIS_KEYS.TRIP_LOCATION(data.tripId), locationData, TTL.TRIP),

        // Driver's current location (for fleet tracking)
        redisService.setJSON(REDIS_KEYS.DRIVER_LOCATION(driverId), locationData, TTL.LOCATION),
      ]);

      // 4. Add to history (fire-and-forget), but sample to reduce hot-path write load.
      if (await trackingHistoryService.shouldPersistHistoryPoint(data.tripId, historyEntry, locationData.status)) {
        trackingHistoryService.addToHistory(data.tripId, historyEntry);
      }

      // 5. Broadcast via WebSocket - THE KEY FOR REAL-TIME
      // Phase 7 (7B): Include staleness info so customer app can show
      // "GPS unavailable" instead of a silently frozen marker.
      // Use the device's GPS timestamp (if sent) to detect truly stale points.
      // Falls back to 0 (fresh) if no client timestamp was provided.
      const clientTs = data.timestamp ? new Date(data.timestamp).getTime() : Date.now();
      const locationAgeMs = Math.max(0, Date.now() - clientTs);
      const broadcastPayload = {
        tripId: data.tripId,
        driverId,
        latitude: data.latitude,
        longitude: data.longitude,
        speed: data.speed,
        bearing: data.bearing,
        timestamp: now,
        isStale: locationAgeMs > 60_000,
        locationAgeMs,
        // GPS spoof flag — customer app can show "⚠️ GPS accuracy low" when true
        ...(data.isMockLocation === true && { isMockLocation: true })
      };

      // Broadcast to booking room (customer watches this)
      if (existing?.bookingId) {
        emitToBooking(existing.bookingId, SocketEvent.LOCATION_UPDATED, broadcastPayload);
      }

      // Broadcast to trip room (specific trip watchers)
      emitToTrip(data.tripId, SocketEvent.LOCATION_UPDATED, broadcastPayload);

      // Broadcast to transporter (for fleet view)
      if (existing?.transporterId) {
        emitToUser(existing.transporterId, SocketEvent.LOCATION_UPDATED, broadcastPayload);
      }

      trackingHistoryService.publishTrackingEventAsync({
        driverId,
        tripId: data.tripId,
        bookingId: existing?.bookingId,
        orderId: existing?.orderId,
        latitude: data.latitude,
        longitude: data.longitude,
        speed: data.speed || 0,
        bearing: data.bearing || 0,
        ts: now,
        source: 'gps'
      });

      logger.debug('📍 Location updated', { tripId: data.tripId, driverId, lat: data.latitude, lng: data.longitude });

      // ==================================================================
      // Phase 7: 2km Proximity Notification — "Your driver is about to arrive"
      // ==================================================================
      // Only when driver is heading to pickup (en_route_pickup / heading_to_pickup)
      // Uses Redis flag to send only ONCE per trip (no spam)
      // Uses Google Directions API for road distance (async, non-blocking)
      // ==================================================================
      if (
        existing &&
        (existing.status === 'en_route_pickup' || existing.status === 'heading_to_pickup') &&
        (existing.orderId || existing.bookingId)
      ) {
        trackingTripService.checkAndSendProximityNotification(
          data.tripId,
          driverId,
          data.latitude,
          data.longitude,
          existing
        ).catch(err => {
          logger.debug('[TRACKING] Proximity check failed (non-fatal)', {
            tripId: data.tripId, error: err?.message
          });
        });
      }

    } catch (error: unknown) {
      logger.error(`Failed to update location: ${error instanceof Error ? error.message : String(error)}`, { tripId: data.tripId, driverId });
      throw error;
    }
  }

  // ===========================================================================
  // BATCH LOCATION UPLOAD - Offline Resilience
  // ===========================================================================

  /**
   * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   * ┃  BATCH LOCATION UPLOAD - For Offline Sync                              ┃
   * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
   *
   * Called when driver app reconnects after being offline.
   * Processes buffered location points with proper timestamp handling.
   *
   * RULES:
   * 1. Points are sorted by timestamp (oldest first)
   * 2. Points with timestamp <= last_seen_ts are DUPLICATES (ignored)
   * 3. Points older than STALE_THRESHOLD go to HISTORY only (not live)
   * 4. Points with unrealistic speed jumps are FLAGGED
   * 5. Only the NEWEST valid point updates live location
   *
   * WHY THIS MATTERS:
   * - Driver was offline for 5 minutes
   * - App buffered 30 location points locally
   * - On reconnect, uploads all 30 at once
   * - We need to:
   *   a) Add ALL points to history (for route replay)
   *   b) Update live location with ONLY the newest valid point
   *   c) Reject duplicates if driver retries the upload
   *
   * @param driverId - The driver uploading
   * @param data - Batch of location points with timestamps
   * @returns BatchUploadResult with counts of processed/accepted/stale/etc
   */
  async uploadBatchLocations(
    driverId: string,
    data: BatchLocationInput
  ): Promise<BatchUploadResult> {
    const { tripId, points } = data;

    logger.info(`📦 Batch upload: ${points.length} points for trip ${tripId}`, { driverId });

    const result: BatchUploadResult = {
      tripId,
      processed: points.length,
      accepted: 0,
      stale: 0,
      duplicate: 0,
      invalid: 0,
      lastAcceptedTimestamp: null
    };

    try {
      // 1. Get existing trip data
      const existing = await redisService.getJSON<LocationData>(REDIS_KEYS.TRIP_LOCATION(tripId));

      if (existing && existing.driverId !== driverId) {
        throw new AppError(403, 'FORBIDDEN', 'Not authorized to update this trip');
      }

      // 2. Get last accepted timestamp for this driver
      const lastTsStr = await redisService.get(REDIS_KEYS.DRIVER_LAST_TS(driverId));
      const lastTs = lastTsStr ? new Date(lastTsStr).getTime() : 0;

      // 3. Sort points by timestamp (oldest first for proper processing)
      const sortedPoints = [...points].sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      const now = Date.now();
      const staleThreshold = now - (TRACKING_CONFIG.STALE_THRESHOLD_SECONDS * 1000);

      let newestValidPoint: BatchLocationPoint | null = null;
      let newestValidTs = 0;
      let previousPoint: BatchLocationPoint | null = null;

      // FIX #54: Collect history entries for batched Redis writes (backpressure).
      // Before: each point fired 3 individual Redis calls (rPush, lTrim, expire).
      // For 30 points, that was 90 round-trips. Now we batch via multi().
      const historyEntries: LocationHistoryEntry[] = [];

      // 4. Process each point
      for (const point of sortedPoints) {
        const pointTs = new Date(point.timestamp).getTime();

        // 4a. Check for duplicate (timestamp <= last accepted)
        if (pointTs <= lastTs) {
          result.duplicate++;
          continue;
        }

        // 4b. Check for unrealistic speed jump
        if (previousPoint && this.isUnrealisticJump(previousPoint, point)) {
          result.invalid++;
          logger.warn('Unrealistic speed jump detected', {
            tripId,
            from: { lat: previousPoint.latitude, lng: previousPoint.longitude },
            to: { lat: point.latitude, lng: point.longitude },
            timeDiffMs: pointTs - new Date(previousPoint.timestamp).getTime()
          });
          continue;
        }

        // 4c. Check if point is stale (too old for live, but still add to history)
        if (pointTs < staleThreshold) {
          result.stale++;
          // Collect for batched write instead of individual call
          historyEntries.push({
            latitude: point.latitude,
            longitude: point.longitude,
            speed: point.speed || 0,
            timestamp: point.timestamp
          });
          previousPoint = point;
          continue;
        }

        // 4d. Point is valid and fresh - track newest
        result.accepted++;

        // Collect for batched write
        historyEntries.push({
          latitude: point.latitude,
          longitude: point.longitude,
          speed: point.speed || 0,
          timestamp: point.timestamp
        });

        // Track newest valid point
        if (pointTs > newestValidTs) {
          newestValidTs = pointTs;
          newestValidPoint = point;
          result.lastAcceptedTimestamp = point.timestamp;
        }

        previousPoint = point;
      }

      // FIX #54: Batch history writes with capped concurrency for backpressure.
      // Before: unbounded sequential writes (1 round-trip per point = 90+ for 30 pts).
      // Now: batch in groups of 10 to limit concurrent Redis connections.
      if (historyEntries.length > 0) {
        try {
          const HISTORY_BATCH_SIZE = 10;
          for (let i = 0; i < historyEntries.length; i += HISTORY_BATCH_SIZE) {
            const batch = historyEntries.slice(i, i + HISTORY_BATCH_SIZE);
            await Promise.all(
              batch.map(entry => trackingHistoryService.addToHistory(tripId, entry))
            );
          }
        } catch (histErr: unknown) {
          logger.warn('[TRACKING] Batched history write failed (non-fatal)', {
            tripId, count: historyEntries.length, error: histErr instanceof Error ? histErr.message : String(histErr)
          });
        }
      }

      // 5. Update live location with ONLY the newest valid point
      if (newestValidPoint) {
        const locationData: LocationData = {
          tripId,
          driverId,
          transporterId: existing?.transporterId,
          vehicleId: existing?.vehicleId,
          vehicleNumber: existing?.vehicleNumber || '',
          bookingId: existing?.bookingId || '',
          orderId: existing?.orderId,
          latitude: newestValidPoint.latitude,
          longitude: newestValidPoint.longitude,
          speed: newestValidPoint.speed || 0,
          bearing: newestValidPoint.bearing || 0,
          accuracy: newestValidPoint.accuracy,
          status: existing?.status || 'in_transit',
          lastUpdated: newestValidPoint.timestamp
        };

        // Update Redis
        // H-25: Extend the real presence key (35s TTL heartbeat) instead of
        // writing to the redundant driver:status key. Backward compat: also
        // write driver:status during transition period.
        await Promise.all([
          redisService.setJSON(REDIS_KEYS.TRIP_LOCATION(tripId), locationData, TTL.TRIP),
          redisService.setJSON(REDIS_KEYS.DRIVER_LOCATION(driverId), locationData, TTL.LOCATION),
          redisService.set(REDIS_KEYS.DRIVER_LAST_TS(driverId), newestValidPoint.timestamp, TTL.LOCATION),
          redisService.expire(`driver:presence:${driverId}`, 35).catch(() => {}),
          redisService.set(REDIS_KEYS.DRIVER_STATUS(driverId), 'ONLINE', TTL.LOCATION),
        ]);

        // Broadcast latest location
        const broadcastPayload = {
          tripId,
          driverId,
          latitude: newestValidPoint.latitude,
          longitude: newestValidPoint.longitude,
          speed: newestValidPoint.speed,
          bearing: newestValidPoint.bearing,
          timestamp: newestValidPoint.timestamp,
          source: 'batch_sync'  // Tells client this came from offline sync
        };

        if (existing?.bookingId) {
          emitToBooking(existing.bookingId, SocketEvent.LOCATION_UPDATED, broadcastPayload);
        }
        emitToTrip(tripId, SocketEvent.LOCATION_UPDATED, broadcastPayload);
        if (existing?.transporterId) {
          emitToUser(existing.transporterId, SocketEvent.LOCATION_UPDATED, broadcastPayload);
        }

        await trackingHistoryService.setHistoryPersistState(tripId, {
          latitude: newestValidPoint.latitude,
          longitude: newestValidPoint.longitude,
          timestampMs: new Date(newestValidPoint.timestamp).getTime(),
          status: locationData.status
        });

        trackingHistoryService.publishTrackingEventAsync({
          driverId,
          tripId,
          bookingId: existing?.bookingId,
          orderId: existing?.orderId,
          latitude: newestValidPoint.latitude,
          longitude: newestValidPoint.longitude,
          speed: newestValidPoint.speed || 0,
          bearing: newestValidPoint.bearing || 0,
          ts: newestValidPoint.timestamp,
          source: 'batch_sync'
        });
      }

      logger.info(`📦 Batch complete: ${result.accepted} accepted, ${result.stale} stale, ${result.duplicate} duplicate, ${result.invalid} invalid`, { tripId });

      return result;

    } catch (error: unknown) {
      logger.error(`Batch upload failed: ${error instanceof Error ? error.message : String(error)}`, { tripId, driverId });
      throw error;
    }
  }

  /**
   * Check if jump between two points is unrealistic (impossibly fast)
   *
   * FORMULA: distance / time > MAX_REALISTIC_SPEED
   *
   * This catches:
   * - GPS glitches (sudden teleportation)
   * - Wrong device clock
   * - Spoofed locations
   */
  private isUnrealisticJump(from: BatchLocationPoint, to: BatchLocationPoint): boolean {
    const timeDiffMs = new Date(to.timestamp).getTime() - new Date(from.timestamp).getTime();

    // If time difference is too small, can't reliably calculate speed
    if (timeDiffMs < TRACKING_CONFIG.MIN_INTERVAL_MS) {
      return false; // Accept but don't flag
    }

    const distanceMeters = haversineDistanceMeters(
      from.latitude, from.longitude,
      to.latitude, to.longitude
    );

    const speedMs = distanceMeters / (timeDiffMs / 1000);

    return speedMs > TRACKING_CONFIG.MAX_REALISTIC_SPEED_MS;
  }

  /**
   * Get driver's online status
   *
   * H-25: Consolidated presence check — reads driver:presence (35s heartbeat)
   * first as the authoritative source, then falls back to driver:status (300s TTL)
   * for backward compatibility during transition.
   *
   * STATUS LOGIC:
   * - ONLINE: driver:presence key exists (active heartbeat) OR driver:status = ONLINE
   * - OFFLINE: Explicitly set OR no presence/status/location data
   * - UNKNOWN: No update for > OFFLINE_THRESHOLD (network issue?)
   */
  async getDriverStatus(driverId: string): Promise<DriverOnlineStatus> {
    // H-25: Check the real presence key first (35s TTL heartbeat — authoritative)
    try {
      const presenceExists = await redisService.exists(`driver:presence:${driverId}`);
      if (presenceExists) {
        return 'ONLINE';
      }
    } catch {
      // Non-critical — fall through to legacy check
    }

    // Backward compat: check legacy driver:status key
    const status = await redisService.get(REDIS_KEYS.DRIVER_STATUS(driverId));

    if (status === 'ONLINE' || status === 'OFFLINE') {
      return status;
    }

    // Check if we have recent location data
    const location = await redisService.getJSON<LocationData>(REDIS_KEYS.DRIVER_LOCATION(driverId));

    if (!location) {
      return 'OFFLINE';
    }

    const lastUpdateMs = new Date(location.lastUpdated).getTime();
    const ageSeconds = (Date.now() - lastUpdateMs) / 1000;

    if (ageSeconds > TRACKING_CONFIG.OFFLINE_THRESHOLD_SECONDS) {
      return 'UNKNOWN';
    }

    return 'ONLINE';
  }

  /**
   * Set driver status explicitly (called by app when going background/foreground)
   *
   * H-25: Also manages driver:presence key for consistency.
   * When ONLINE: extends presence TTL. When OFFLINE: deletes presence key.
   */
  async setDriverStatus(driverId: string, status: DriverOnlineStatus): Promise<void> {
    await redisService.set(REDIS_KEYS.DRIVER_STATUS(driverId), status, TTL.LOCATION);

    // H-25: Keep presence key in sync
    if (status === 'ONLINE') {
      await redisService.expire(`driver:presence:${driverId}`, 35).catch(() => {});
    } else if (status === 'OFFLINE') {
      await redisService.del(`driver:presence:${driverId}`).catch(() => {});
    }

    logger.debug(`Driver ${driverId} status: ${status}`);
  }
}

export const trackingLocationService = new TrackingLocationService();
