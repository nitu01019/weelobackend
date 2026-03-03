/**
 * =============================================================================
 * TRACKING MODULE - SERVICE (Ola/Uber Style Live Tracking)
 * =============================================================================
 * 
 * Real-time location tracking for drivers and fleet monitoring.
 * 
 * HOW IT WORKS (The Secret):
 * ─────────────────────────────
 * 1. Driver app sends GPS every 5-10 seconds (smart interval based on speed)
 * 2. Backend stores in Redis (ultra-fast, in-memory)
 * 3. Backend broadcasts via WebSocket to interested clients
 * 4. Frontend receives point A → point B and INTERPOLATES (creates smooth motion)
 * 
 * The frontend creates the "live" illusion. Backend just sends points.
 * 
 * REDIS STORAGE:
 * ─────────────────────────────
 * - driver:location:{driverId}    → Current location (JSON, TTL: 5 min)
 * - driver:trip:{tripId}          → Trip location data (JSON, TTL: 24h)
 * - driver:history:{tripId}       → Location history list
 * - fleet:{transporterId}         → Set of active driver IDs
 * 
 * SCALABILITY:
 * ─────────────────────────────
 * - Redis handles millions of location updates
 * - WebSocket pub/sub for multi-server
 * - Stateless service - horizontal scaling ready
 * 
 * @author Weelo Team
 * @version 2.0.0 (Redis-powered for production scale)
 * =============================================================================
 */

import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToBooking, emitToTrip, emitToUser, SocketEvent } from '../../shared/services/socket.service';
import { redisService } from '../../shared/services/redis.service';
import { queueService } from '../../shared/services/queue.service';
import { haversineDistanceMeters } from '../../shared/utils/geospatial.utils';
import { prismaClient } from '../../shared/database/prisma.service';
import { googleMapsService } from '../../shared/services/google-maps.service';
import {
  UpdateLocationInput,
  GetTrackingQuery,
  TrackingResponse,
  BookingTrackingResponse,
  LocationHistoryEntry,
  BatchLocationInput,
  BatchLocationPoint,
  BatchUploadResult,
  DriverOnlineStatus,
  TripStatusUpdateInput,
  TRACKING_CONFIG
} from './tracking.schema';
import {
  assertBookingTrackingAccess,
  assertTripTrackingAccess
} from './tracking-access.policy';

// =============================================================================
// REDIS KEYS
// =============================================================================

const REDIS_KEYS = {
  /** Current driver location: driver:location:{driverId} */
  DRIVER_LOCATION: (driverId: string) => `driver:location:${driverId}`,

  /** Trip tracking data: driver:trip:{tripId} */
  TRIP_LOCATION: (tripId: string) => `driver:trip:${tripId}`,

  /** Location history: driver:history:{tripId} */
  TRIP_HISTORY: (tripId: string) => `driver:history:${tripId}`,

  /** Fleet active drivers: fleet:{transporterId} */
  FLEET_DRIVERS: (transporterId: string) => `fleet:${transporterId}`,
  /** Index of transporter IDs that currently have active fleet sets */
  ACTIVE_FLEET_TRANSPORTERS: 'fleet:index:transporters',

  /** Active trips by booking: booking:trips:{bookingId} */
  BOOKING_TRIPS: (bookingId: string) => `booking:trips:${bookingId}`,

  // =========================================================================
  // OFFLINE RESILIENCE KEYS (NEW)
  // =========================================================================

  /** Last accepted timestamp for a driver: driver:last_ts:{driverId} 
   *  Used to reject out-of-order/duplicate points */
  DRIVER_LAST_TS: (driverId: string) => `driver:last_ts:${driverId}`,

  /** Driver online status: driver:status:{driverId}
   *  Values: ONLINE | OFFLINE | UNKNOWN */
  DRIVER_STATUS: (driverId: string) => `driver:status:${driverId}`,
};

// TTL values (in seconds)
const TTL = {
  LOCATION: 300,           // 5 minutes - location expires if no update
  TRIP: 86400,             // 24 hours - trip data
  HISTORY: 86400 * 7,      // 7 days - keep history for analytics
};

const HISTORY_PERSIST_MIN_INTERVAL_MS = parseInt(process.env.TRACKING_HISTORY_MIN_INTERVAL_MS || '15000', 10);
const HISTORY_PERSIST_MIN_MOVEMENT_METERS = parseInt(process.env.TRACKING_HISTORY_MIN_MOVEMENT_METERS || '75', 10);
const HISTORY_STATE_MAX_ENTRIES = parseInt(process.env.TRACKING_HISTORY_STATE_MAX_ENTRIES || '50000', 10);
const TRACKING_STREAM_ENABLED = process.env.TRACKING_STREAM_ENABLED === 'true';

// =============================================================================
// TYPES
// =============================================================================

interface LocationData {
  tripId: string;
  driverId: string;
  transporterId?: string;
  vehicleId?: string;
  vehicleNumber: string;
  bookingId: string;
  orderId?: string;
  latitude: number;
  longitude: number;
  speed: number;
  bearing: number;
  accuracy?: number;
  status: string;
  lastUpdated: string;  // ISO string for Redis
}

interface HistoryPersistState {
  latitude: number;
  longitude: number;
  timestampMs: number;
  status: string;
}

/**
 * Fleet tracking response - for transporter to see all their trucks
 */
export interface FleetTrackingResponse {
  transporterId: string;
  activeDrivers: number;
  drivers: Array<{
    driverId: string;
    driverName?: string;
    vehicleNumber: string;
    tripId?: string;
    latitude: number;
    longitude: number;
    speed: number;
    bearing: number;
    status: string;
    lastUpdated: string;
  }>;
}

class TrackingService {
  private readonly historyPersistStateByTrip = new Map<string, HistoryPersistState>();

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
      if (this.shouldPersistHistoryPoint(data.tripId, historyEntry, locationData.status)) {
        this.addToHistory(data.tripId, historyEntry);
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
        locationAgeMs
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

      this.publishTrackingEventAsync({
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
        this.checkAndSendProximityNotification(
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

    } catch (error: any) {
      logger.error(`Failed to update location: ${error.message}`, { tripId: data.tripId, driverId });
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
          logger.warn('🚨 Unrealistic speed jump detected', {
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
          // Add to history only
          await this.addToHistory(tripId, {
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

        // Add to history
        await this.addToHistory(tripId, {
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
        await Promise.all([
          redisService.setJSON(REDIS_KEYS.TRIP_LOCATION(tripId), locationData, TTL.TRIP),
          redisService.setJSON(REDIS_KEYS.DRIVER_LOCATION(driverId), locationData, TTL.LOCATION),
          redisService.set(REDIS_KEYS.DRIVER_LAST_TS(driverId), newestValidPoint.timestamp, TTL.LOCATION),
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

        this.rememberHistoryPersistState(tripId, {
          latitude: newestValidPoint.latitude,
          longitude: newestValidPoint.longitude,
          timestampMs: new Date(newestValidPoint.timestamp).getTime(),
          status: locationData.status
        });

        this.publishTrackingEventAsync({
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

    } catch (error: any) {
      logger.error(`Batch upload failed: ${error.message}`, { tripId, driverId });
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
   * STATUS LOGIC:
   * - ONLINE: Updated within OFFLINE_THRESHOLD
   * - OFFLINE: Explicitly set (app backgrounded, etc)
   * - UNKNOWN: No update for > OFFLINE_THRESHOLD (network issue?)
   */
  async getDriverStatus(driverId: string): Promise<DriverOnlineStatus> {
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
   */
  async setDriverStatus(driverId: string, status: DriverOnlineStatus): Promise<void> {
    await redisService.set(REDIS_KEYS.DRIVER_STATUS(driverId), status, TTL.LOCATION);
    logger.debug(`Driver ${driverId} status: ${status}`);
  }

  /**
   * Add location to history (Redis list)
   */
  private async addToHistory(tripId: string, entry: LocationHistoryEntry): Promise<void> {
    try {
      const key = REDIS_KEYS.TRIP_HISTORY(tripId);
      // Use Redis list ops: O(1) append, atomic, no read-modify-write race
      await redisService.rPush(key, JSON.stringify(entry));
      // Cap at last 1000 points (lTrim keeps indices -1000 to -1)
      await redisService.lTrim(key, -1000, -1);
      await redisService.expire(key, TTL.HISTORY);
    } catch (error: any) {
      if (String(error?.message || error).includes('WRONGTYPE')) {
        // Backward compatibility: older versions stored history as JSON string.
        // Reset key type once and retry list write.
        const key = REDIS_KEYS.TRIP_HISTORY(tripId);
        try {
          await redisService.del(key);
          await redisService.rPush(key, JSON.stringify(entry));
          await redisService.lTrim(key, -1000, -1);
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

  /**
   * Initialize tracking for a trip (called when assignment starts)
   */
  async initializeTracking(
    tripId: string,
    driverId: string,
    vehicleNumber: string,
    bookingId: string,
    transporterId?: string,
    vehicleId?: string,
    orderId?: string
  ): Promise<void> {
    const now = new Date().toISOString();

    const locationData: LocationData = {
      tripId,
      driverId,
      transporterId,
      vehicleId,
      vehicleNumber,
      bookingId,
      orderId,
      latitude: 0,
      longitude: 0,
      speed: 0,
      bearing: 0,
      status: 'pending',
      lastUpdated: now
    };

    // Store in Redis
    await redisService.setJSON(REDIS_KEYS.TRIP_LOCATION(tripId), locationData, TTL.TRIP);

    // Add to booking's trip list
    if (bookingId) {
      await redisService.sAdd(REDIS_KEYS.BOOKING_TRIPS(bookingId), tripId);
      await redisService.expire(REDIS_KEYS.BOOKING_TRIPS(bookingId), TTL.TRIP);
    }

    // Add driver to transporter's fleet
    if (transporterId) {
      await this.addDriverToFleet(transporterId, driverId);
    }

    // Initialize empty history
    await redisService.del(REDIS_KEYS.TRIP_HISTORY(tripId));
    this.historyPersistStateByTrip.delete(tripId);

    logger.info('🚀 Tracking initialized', { tripId, driverId, bookingId });
  }

  /**
   * Update tracking status
   */
  async updateStatus(tripId: string, status: string): Promise<void> {
    const location = await redisService.getJSON<LocationData>(REDIS_KEYS.TRIP_LOCATION(tripId));
    if (location) {
      location.status = status;
      location.lastUpdated = new Date().toISOString();
      await redisService.setJSON(REDIS_KEYS.TRIP_LOCATION(tripId), location, TTL.TRIP);

      // Broadcast status update
      emitToTrip(tripId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
        tripId,
        status,
        timestamp: location.lastUpdated
      });
    }
  }

  /**
   * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   * ┃  UPDATE TRIP STATUS — Driver Status Progression                        ┃
   * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
   * 
   * Called by Captain app when driver taps status buttons:
   *   "Reached Pickup" → "Loading Complete" → "Start Trip" → "Complete Trip"
   * 
   * FULL FLOW (what happens on each call):
   *   1. Look up Assignment by tripId (unique index → O(1))
   *   2. Validate driver owns the assignment
   *   3. Update Assignment record in Postgres (if status maps to Prisma enum)
   *   4. Update Redis tracking data (for live tracking by customer)
   *   5. WebSocket broadcast to booking room + trip room (real-time UI update)
   *   6. FCM push to customer (even if their app is closed/backgrounded)
   * 
   * STATUS MAPPING (Captain app → Prisma enum → Redis):
   *   heading_to_pickup → en_route_pickup  → heading_to_pickup (Redis)
   *   at_pickup         → at_pickup        → at_pickup (Redis)
   *   loading_complete  → (Redis only)     → loading_complete (Redis)
   *   in_transit        → in_transit       → in_transit (Redis)
   *   completed         → completed        → completed (Redis)
   * 
   * NOTE: 'loading_complete' is a tracking-only status — stored in Redis
   *       but NOT in Prisma. The Prisma enum jumps at_pickup → in_transit.
   *       This is an intermediate UI step so customer sees "Loading Complete".
   * 
   * SCALABILITY:
   *   - Assignment lookup by tripId uses @unique index → O(1)
   *   - Redis update is O(1) in-memory
   *   - FCM is queued (fire-and-forget) — never blocks the response
   *   - WebSocket broadcast is O(1) per room
   * 
   * DATA ISOLATION:
   *   - Only the assigned driver can update their own trip
   * 
   * @param tripId    - Trip ID (unique on Assignment table)
   * @param driverId  - Driver making the update (from JWT)
   * @param data      - { status: 'at_pickup' | 'loading_complete' | 'in_transit' | 'completed' | ... }
   */
  async updateTripStatus(
    tripId: string,
    driverId: string,
    data: TripStatusUpdateInput
  ): Promise<void> {
    const { status } = data;

    try {
      logger.info('[TRACKING] Updating trip status', { tripId, driverId, status });

      // ------------------------------------------------------------------
      // 1. Look up assignment by tripId — uses @unique index, O(1)
      // ------------------------------------------------------------------
      const assignment = await prismaClient.assignment.findUnique({
        where: { tripId },
        include: {
          booking: { select: { customerId: true, customerName: true, id: true, pickup: true } },
          order: { select: { id: true, customerId: true, pickup: true } }
        }
      });

      if (!assignment) {
        throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'No assignment found for this trip');
      }

      if (assignment.driverId !== driverId) {
        throw new AppError(403, 'FORBIDDEN', 'This trip is not assigned to you');
      }

      // ------------------------------------------------------------------
      // 1b. Prevent backward status transitions (idempotent protection)
      //     e.g. driver can't go from in_transit → at_pickup
      //     Already-completed trips are immutable
      // ------------------------------------------------------------------
      const STATUS_ORDER: Record<string, number> = {
        'pending': 0,
        'driver_accepted': 1,
        'heading_to_pickup': 2,
        'en_route_pickup': 2,
        'at_pickup': 3,
        'loading_complete': 4,
        'in_transit': 5,
        'arrived_at_drop': 6,
        'completed': 7,
        'cancelled': -1,
        'driver_declined': -1
      };

      const currentOrder = STATUS_ORDER[assignment.status] ?? 0;
      const newOrder = STATUS_ORDER[status] ?? 0;

      if (assignment.status === 'completed') {
        throw new AppError(400, 'TRIP_ALREADY_COMPLETED', 'This trip is already completed');
      }

      if (assignment.status === 'cancelled' || assignment.status === 'driver_declined') {
        throw new AppError(400, 'TRIP_NOT_ACTIVE', 'This trip is no longer active');
      }

      if (newOrder <= currentOrder && newOrder > 0) {
        // Same status = idempotent (return success, don't re-process)
        if (newOrder === currentOrder) {
          logger.info('[TRACKING] Idempotent status update — already at this status', { tripId, status });
          return;
        }
        throw new AppError(400, 'INVALID_STATUS_TRANSITION',
          `Cannot go from ${assignment.status} to ${status}. Status can only move forward.`);
      }

      // ------------------------------------------------------------------
      // Phase 7 (7A): Geofence check — driver must be within 200m of pickup
      //               before marking 'at_pickup'. Prevents fake arrivals.
      //               Uses Google Directions API for road distance.
      //               If Google API or GPS unavailable, allow (don't block).
      // ------------------------------------------------------------------
      if (status === 'at_pickup') {
        const driverLocation = await redisService.getJSON<LocationData>(
          REDIS_KEYS.DRIVER_LOCATION(driverId)
        );
        if (driverLocation?.latitude && driverLocation?.longitude) {
          const pickupSource = assignment.order?.pickup || assignment.booking?.pickup;
          const pickupData = typeof pickupSource === 'string'
            ? JSON.parse(pickupSource as string)
            : pickupSource;
          const pickupLat = pickupData?.latitude || pickupData?.lat;
          const pickupLng = pickupData?.longitude || pickupData?.lng;
          if (pickupLat && pickupLng) {
            const MAX_ARRIVAL_DISTANCE_M = parseInt(
              process.env.MAX_ARRIVAL_DISTANCE_METERS || '200', 10
            );
            try {
              // Use Google Directions API for accurate road distance
              const eta = await googleMapsService.getETA(
                { lat: driverLocation.latitude, lng: driverLocation.longitude },
                { lat: Number(pickupLat), lng: Number(pickupLng) }
              );
              if (eta) {
                const roadDistanceMeters = eta.distanceKm * 1000;
                if (roadDistanceMeters > MAX_ARRIVAL_DISTANCE_M) {
                  logger.warn('[TRACKING] Arrival rejected — too far from pickup (road distance)', {
                    tripId, driverId,
                    roadDistanceMeters: Math.round(roadDistanceMeters),
                    maxAllowed: MAX_ARRIVAL_DISTANCE_M
                  });
                  throw new AppError(400, 'TOO_FAR_FROM_PICKUP',
                    `You are ${Math.round(roadDistanceMeters)}m away by road. Please move within ${MAX_ARRIVAL_DISTANCE_M}m of pickup.`
                  );
                }
              }
              // If eta is null (Google API failed), allow through
            } catch (geoErr: any) {
              // If it's our own AppError (TOO_FAR), re-throw it
              if (geoErr instanceof AppError) throw geoErr;
              // Otherwise Google API failed — allow through (don't block legitimate arrivals)
              logger.warn('[TRACKING] Google Directions geofence check failed, allowing through', {
                tripId, error: geoErr?.message
              });
            }
          }
        }
        // If no GPS data in Redis, allow — don't block legitimate arrivals
      }

      // ------------------------------------------------------------------
      // 2. Map Captain app status → Prisma enum (where applicable)
      //    'loading_complete' is Redis-only (not in Prisma enum)
      // ------------------------------------------------------------------
      const prismaStatusMap: Record<string, string | null> = {
        'heading_to_pickup': 'en_route_pickup',
        'at_pickup': 'at_pickup',
        'loading_complete': null,  // Redis-only, skip Prisma update
        'in_transit': 'in_transit',
        'arrived_at_drop': 'arrived_at_drop',
        'completed': 'completed'
      };

      const prismaStatus = prismaStatusMap[status];

      // ------------------------------------------------------------------
      // 3. Update Assignment in Postgres (if status maps to Prisma enum)
      // ------------------------------------------------------------------
      if (prismaStatus) {
        const updates: Record<string, any> = { status: prismaStatus };

        if (prismaStatus === 'in_transit') {
          updates.startedAt = new Date().toISOString();
        }
        if (prismaStatus === 'completed') {
          updates.completedAt = new Date().toISOString();
        }

        await prismaClient.assignment.update({
          where: { tripId },
          data: updates
        });

        // Phase 7 (7E): Populate Order timestamps for cancel policy stage detection
        const targetOrderId = assignment.orderId || assignment.order?.id;
        if (targetOrderId) {
          if (status === 'at_pickup') {
            await prismaClient.order.update({
              where: { id: targetOrderId },
              data: { loadingStartedAt: new Date() }
            }).catch(err => {
              logger.warn('[TRACKING] Failed to set loadingStartedAt (non-fatal)', {
                orderId: targetOrderId, error: err.message
              });
            });
          }
          if (status === 'arrived_at_drop') {
            await prismaClient.order.update({
              where: { id: targetOrderId },
              data: { unloadingStartedAt: new Date() }
            }).catch(err => {
              logger.warn('[TRACKING] Failed to set unloadingStartedAt (non-fatal)', {
                orderId: targetOrderId, error: err.message
              });
            });
          }
        }
      }

      // ------------------------------------------------------------------
      // 4. Update Redis tracking data (for live tracking by customer)
      //    Graceful: if Redis is down, Postgres update already succeeded
      //    Customer just won't see live update until Redis recovers
      // ------------------------------------------------------------------
      try {
        await this.updateStatus(tripId, status);
      } catch (redisErr: any) {
        logger.warn('[TRACKING] Redis status update failed (Postgres already updated, non-fatal)', {
          tripId, status, error: redisErr.message
        });
      }

      // ------------------------------------------------------------------
      // 5. Complete tracking cleanup (if trip completed)
      //    Uses its own Redis calls — also graceful if Redis is down
      //    NOTE: completeTracking() broadcasts its own WebSocket event,
      //    so we skip the duplicate broadcast below for 'completed'
      // ------------------------------------------------------------------
      if (status === 'completed') {
        // Phase 9A: Double-tap guard — Redis lock prevents race condition
        // Scenario: Two rapid "Complete" taps → both pass Postgres idempotent check
        //           before first one commits → duplicate completion events.
        // Solution: SETNX lock with 10s TTL. Second tap gets lock-failed → returns silently.
        const tripCompleteLock = `lock:trip-complete:${tripId}`;
        const completeLock = await redisService.acquireLock(tripCompleteLock, 'trip-completion', 10);
        if (!completeLock.acquired) {
          logger.info('[TRACKING] Trip completion already in progress (double-tap guard)', { tripId });
          return; // Idempotent — first request will handle everything
        }

        try {
          try {
            await this.completeTracking(tripId);
          } catch (completeErr: any) {
            logger.warn('[TRACKING] completeTracking cleanup failed (non-fatal)', {
              tripId, error: completeErr.message
            });
          }

          // Phase 5: Check if ALL trucks for this booking are now completed
          // If yes → update booking status + notify customer
          const completedBookingId = assignment.booking?.id || assignment.bookingId;
          if (completedBookingId) {
            this.checkBookingCompletion(completedBookingId).catch(err => {
              logger.warn('[TRACKING] Booking completion check failed (non-fatal)', {
                bookingId: completedBookingId, error: err.message
              });
            });
          }
        } finally {
          await redisService.releaseLock(tripCompleteLock, 'trip-completion').catch(() => { });
        }
      }

      // ------------------------------------------------------------------
      // 6. FCM push to customer (even if app is closed/backgrounded)
      //    Fire-and-forget — never blocks the response
      // ------------------------------------------------------------------
      const customerId = assignment.booking?.customerId;
      const bookingId = assignment.booking?.id || assignment.bookingId;

      if (customerId) {
        const statusMessages: Record<string, { title: string; body: string }> = {
          'heading_to_pickup': {
            title: '🚛 Driver on the way',
            body: `Driver ${assignment.driverName} is heading to pickup location`
          },
          'at_pickup': {
            title: '📍 Driver arrived at pickup',
            body: `Driver ${assignment.driverName} has arrived at the pickup location`
          },
          'loading_complete': {
            title: '📦 Loading complete',
            body: `Loading is complete. ${assignment.driverName} will start the trip shortly`
          },
          'in_transit': {
            title: '🚀 Trip started!',
            body: `Your truck (${assignment.vehicleNumber}) is on the way to the destination`
          },
          'arrived_at_drop': {
            title: '📍 Driver arrived at drop-off',
            body: `Driver ${assignment.driverName} has arrived at the drop-off location`
          },
          'completed': {
            title: '✅ Delivery complete!',
            body: `Your delivery by ${assignment.vehicleNumber} has been completed`
          }
        };

        const message = statusMessages[status];
        if (message) {
          queueService.queuePushNotification(customerId, {
            title: message.title,
            body: message.body,
            data: {
              type: 'trip_status_update',
              tripId,
              status,
              assignmentId: assignment.id,
              bookingId: bookingId || '',
              vehicleNumber: assignment.vehicleNumber,
              driverName: assignment.driverName
            }
          }).catch(err => {
            logger.warn('[TRACKING] FCM push failed (non-critical)', {
              tripId, customerId, error: err.message
            });
          });
        }
      }

      // ------------------------------------------------------------------
      // 7. WebSocket broadcast to booking room (customer's live UI)
      //    NOTE: For 'completed', completeTracking() already broadcasts
      //    to the trip room, so we only broadcast to booking + transporter
      //    to avoid duplicate events on the trip channel.
      // ------------------------------------------------------------------
      const broadcastPayload = {
        tripId,
        assignmentId: assignment.id,
        status,
        vehicleNumber: assignment.vehicleNumber,
        driverName: assignment.driverName,
        timestamp: new Date().toISOString()
      };

      if (bookingId) {
        emitToBooking(bookingId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, broadcastPayload);
      }

      // For non-completed statuses, also broadcast to trip room
      // (completeTracking already handles this for 'completed')
      if (status !== 'completed') {
        emitToTrip(tripId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, broadcastPayload);
      }

      // Notify transporter of all status changes
      emitToUser(assignment.transporterId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, broadcastPayload);

      logger.info('[TRACKING] Trip status updated successfully', {
        tripId, status, driverId, vehicleNumber: assignment.vehicleNumber
      });

    } catch (error: any) {
      logger.error('[TRACKING] Failed to update trip status', {
        tripId, driverId, status, error: error.message,
        stack: error.stack?.substring(0, 300)
      });

      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(500, 'INTERNAL_ERROR', 'Failed to update trip status');
    }
  }

  /**
   * Get current location for a trip
   * Used by: Customer app to track their truck
   */
  async getTripTracking(
    tripId: string,
    userId: string,
    userRole: string
  ): Promise<TrackingResponse> {
    await assertTripTrackingAccess(tripId, userId, userRole);
    const location = await redisService.getJSON<LocationData>(REDIS_KEYS.TRIP_LOCATION(tripId));

    if (!location) {
      throw new AppError(404, 'TRACKING_NOT_FOUND', 'No tracking data for this trip');
    }

    return {
      tripId: location.tripId,
      driverId: location.driverId,
      vehicleNumber: location.vehicleNumber,
      latitude: location.latitude,
      longitude: location.longitude,
      speed: location.speed,
      bearing: location.bearing,
      status: location.status,
      lastUpdated: location.lastUpdated
    };
  }

  /**
   * Get current location - alias for getTripTracking
   */
  async getCurrentLocation(
    tripId: string,
    userId: string,
    userRole: string
  ): Promise<TrackingResponse> {
    return this.getTripTracking(tripId, userId, userRole);
  }

  /**
   * Get all truck locations for a booking (multi-truck view)
   * Used by: Customer app to see all their trucks on map
   */
  async getBookingTracking(
    bookingId: string,
    userId?: string,
    userRole?: string
  ): Promise<BookingTrackingResponse> {
    const scopedUserId = userId || '';
    const scopedRole = userRole || '';
    const scope = await assertBookingTrackingAccess(bookingId, scopedUserId, scopedRole);

    // Get all trip IDs for this booking
    const redisTripIds = await redisService.sMembers(REDIS_KEYS.BOOKING_TRIPS(bookingId));
    const tripIds = Array.from(new Set([...scope.tripIds, ...redisTripIds]));

    const trucks: TrackingResponse[] = [];

    // Fetch all trip locations in parallel
    const locationPromises = tripIds.map(tripId =>
      redisService.getJSON<LocationData>(REDIS_KEYS.TRIP_LOCATION(tripId))
    );

    const locations = await Promise.all(locationPromises);

    for (const location of locations) {
      if (location && (location.bookingId === bookingId || location.orderId === bookingId)) {
        trucks.push({
          tripId: location.tripId,
          driverId: location.driverId,
          vehicleNumber: location.vehicleNumber,
          latitude: location.latitude,
          longitude: location.longitude,
          speed: location.speed,
          bearing: location.bearing,
          status: location.status,
          lastUpdated: location.lastUpdated
        });
      }
    }

    return {
      bookingId,
      trucks
    };
  }

  /**
   * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   * ┃  GET FLEET TRACKING - For Transporter to See All Their Trucks         ┃
   * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
   * 
   * Returns all active driver locations for a transporter's fleet.
   * Used by: Captain app to show fleet map view
   * 
   * FRONTEND SHOULD:
   * - Show all drivers on map
   * - Interpolate movement for each driver
   * - Use different colors for different statuses
   */
  async getFleetTracking(transporterId: string): Promise<FleetTrackingResponse> {
    // Get all active driver IDs for this transporter
    const driverIds = await redisService.sMembers(REDIS_KEYS.FLEET_DRIVERS(transporterId));

    const drivers: FleetTrackingResponse['drivers'] = [];

    // Fetch all driver locations in parallel
    const locationPromises = driverIds.map(driverId =>
      redisService.getJSON<LocationData>(REDIS_KEYS.DRIVER_LOCATION(driverId))
    );

    const locations = await Promise.all(locationPromises);

    for (const location of locations) {
      if (location) {
        drivers.push({
          driverId: location.driverId,
          vehicleNumber: location.vehicleNumber,
          tripId: location.tripId,
          latitude: location.latitude,
          longitude: location.longitude,
          speed: location.speed,
          bearing: location.bearing,
          status: location.status,
          lastUpdated: location.lastUpdated
        });
      }
    }

    return {
      transporterId,
      activeDrivers: drivers.length,
      drivers
    };
  }

  /**
   * Get location history for a trip (route replay)
   */
  async getTripHistory(
    tripId: string,
    userId: string,
    userRole: string,
    query: GetTrackingQuery
  ): Promise<LocationHistoryEntry[]> {
    await assertTripTrackingAccess(tripId, userId, userRole);
    const historyKey = REDIS_KEYS.TRIP_HISTORY(tripId);
    const rawHistory = await redisService.lRange(historyKey, 0, -1);
    let history: LocationHistoryEntry[] = rawHistory.map((entry) => {
      try {
        return JSON.parse(entry) as LocationHistoryEntry;
      } catch {
        return null;
      }
    }).filter((entry): entry is LocationHistoryEntry => entry !== null);

    // Backward compatibility for pre-list history keys.
    if (history.length === 0) {
      history = await redisService.getJSON<LocationHistoryEntry[]>(historyKey) || [];
    }

    let filtered = history;

    // Filter by time range if specified
    if (query.fromTime) {
      const from = new Date(query.fromTime);
      filtered = filtered.filter(h => new Date(h.timestamp) >= from);
    }
    if (query.toTime) {
      const to = new Date(query.toTime);
      filtered = filtered.filter(h => new Date(h.timestamp) <= to);
    }

    // Pagination
    const start = (query.page - 1) * query.limit;
    return filtered.slice(start, start + query.limit);
  }

  /**
   * Get location history - alias for getTripHistory
   */
  async getLocationHistory(
    tripId: string,
    userId: string,
    userRole: string,
    query: GetTrackingQuery
  ): Promise<LocationHistoryEntry[]> {
    return this.getTripHistory(tripId, userId, userRole, query);
  }

  /**
   * Clean up tracking when trip completes
   */
  async completeTracking(tripId: string): Promise<void> {
    const location = await redisService.getJSON<LocationData>(REDIS_KEYS.TRIP_LOCATION(tripId));

    if (location) {
      location.status = 'completed';
      location.lastUpdated = new Date().toISOString();
      await redisService.setJSON(REDIS_KEYS.TRIP_LOCATION(tripId), location, TTL.TRIP);

      // Remove driver from active fleet
      if (location.transporterId) {
        await redisService.sRem(REDIS_KEYS.FLEET_DRIVERS(location.transporterId), location.driverId);
        const fleetSize = await redisService.sCard(REDIS_KEYS.FLEET_DRIVERS(location.transporterId));
        if (fleetSize <= 0) {
          await redisService.sRem(REDIS_KEYS.ACTIVE_FLEET_TRANSPORTERS, location.transporterId);
        }
      }

      // Broadcast completion
      emitToTrip(tripId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
        tripId,
        status: 'completed',
        timestamp: location.lastUpdated
      });
    }

    this.historyPersistStateByTrip.delete(tripId);

    logger.info('✅ Tracking completed', { tripId });
  }

  /**
   * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   * ┃  PROXIMITY NOTIFICATION — Driver within 2km of pickup                   ┃
   * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
   * 
   * Called on every location update when driver is heading to pickup.
   * Sends FCM push to customer: "Your driver is about to arrive!"
   * 
   * PERFORMANCE (critical for 2+ lakh concurrent users):
   *   - Step 1: Quick Redis flag check — O(1), ~0.2ms
   *     If already notified → return immediately (no further work)
   *   - Step 2: Quick haversine check — O(1), pure math, ~0.01ms
   *     If driver > 3km straight-line → skip Google API call entirely
   *   - Step 3: Google Directions API — only called when driver is ~3km away
   *     This means per trip, Google API is called maybe 5-10 times total
   *     (from 3km to pickup), NOT on every GPS update
   *   - Step 4: Set Redis flag — O(1), prevents duplicate notifications
   * 
   * RESULT: 99%+ of location updates hit only Step 1 (Redis flag) or
   *         Step 2 (haversine) — no Google API call needed.
   * 
   * SENT ONCE per trip per driver (Redis flag with 30min TTL).
   * Fire-and-forget from updateLocation — never blocks the GPS response.
   */
  private async checkAndSendProximityNotification(
    tripId: string,
    driverId: string,
    driverLat: number,
    driverLng: number,
    existing: LocationData
  ): Promise<void> {
    const PROXIMITY_KEY = `proximity_notified:${tripId}`;

    // Step 1: Redis flag check — already notified? Skip immediately.
    const alreadyNotified = await redisService.get(PROXIMITY_KEY);
    if (alreadyNotified) return;

    // Step 2: Rough haversine check — if driver is > 3km straight-line, skip Google API
    // This prevents calling Google API on 99%+ of location updates
    const entityId = existing.orderId || existing.bookingId;
    if (!entityId) return;

    // Get pickup location
    let pickupLat: number | null = null;
    let pickupLng: number | null = null;
    let customerId: string | null = null;
    let vehicleNumber = existing.vehicleNumber || '';
    let driverName = '';

    // Try order first, then booking
    const assignment = await prismaClient.assignment.findFirst({
      where: { tripId },
      select: {
        driverName: true,
        vehicleNumber: true,
        vehicleType: true,
        order: { select: { pickup: true, customerId: true } },
        booking: { select: { pickup: true, customerId: true } }
      }
    });

    if (!assignment) return;

    driverName = assignment.driverName || '';
    vehicleNumber = assignment.vehicleNumber || vehicleNumber;

    const pickupSource = assignment.order?.pickup || assignment.booking?.pickup;
    const pickupData = typeof pickupSource === 'string'
      ? JSON.parse(pickupSource as string)
      : pickupSource as any;

    pickupLat = Number(pickupData?.latitude || pickupData?.lat);
    pickupLng = Number(pickupData?.longitude || pickupData?.lng);
    customerId = assignment.order?.customerId || assignment.booking?.customerId || null;

    if (!pickupLat || !pickupLng || !customerId) return;

    // Quick straight-line check — skip Google API if clearly > 3km away
    const straightLineMeters = haversineDistanceMeters(
      driverLat, driverLng, pickupLat, pickupLng
    );
    if (straightLineMeters > 3000) return; // Too far, skip Google API call

    // Step 3: Google Directions API — accurate road distance
    const PROXIMITY_THRESHOLD_KM = parseFloat(
      process.env.DRIVER_PROXIMITY_NOTIFICATION_KM || '2'
    );

    const eta = await googleMapsService.getETA(
      { lat: driverLat, lng: driverLng },
      { lat: pickupLat, lng: pickupLng }
    );

    if (!eta || eta.distanceKm > PROXIMITY_THRESHOLD_KM) return;

    // Step 4: Driver is within 2km by road — send notification!
    // Set Redis flag FIRST (prevent race condition with concurrent GPS updates)
    await redisService.set(PROXIMITY_KEY, '1', 1800); // 30 min TTL

    // Send FCM push to customer
    queueService.queuePushNotification(customerId, {
      title: '🚛 Your driver is almost here!',
      body: `${driverName} (${vehicleNumber}) is about ${eta.durationText} away`,
      data: {
        type: 'driver_approaching',
        tripId,
        driverId,
        vehicleNumber,
        driverName,
        distanceKm: String(eta.distanceKm.toFixed(1)),
        durationMinutes: String(eta.durationMinutes),
        durationText: eta.durationText
      }
    }).catch(err => {
      logger.warn('[TRACKING] Proximity FCM push failed (non-fatal)', {
        tripId, customerId, error: err?.message
      });
    });

    // Also emit via WebSocket for instant UI update
    emitToUser(customerId, 'driver_approaching', {
      tripId,
      driverId,
      vehicleNumber,
      driverName,
      distanceKm: eta.distanceKm,
      durationMinutes: eta.durationMinutes,
      durationText: eta.durationText,
      timestamp: new Date().toISOString()
    });

    logger.info('[TRACKING] 🔔 Proximity notification sent — driver within 2km', {
      tripId, driverId, vehicleNumber,
      roadDistanceKm: eta.distanceKm.toFixed(1),
      durationText: eta.durationText
    });
  }

  private shouldPersistHistoryPoint(tripId: string, entry: LocationHistoryEntry, status: string): boolean {
    const timestampMs = new Date(entry.timestamp).getTime();
    if (!Number.isFinite(timestampMs)) return false;

    const previous = this.historyPersistStateByTrip.get(tripId);
    if (!previous) {
      this.rememberHistoryPersistState(tripId, {
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
      this.rememberHistoryPersistState(tripId, {
        latitude: entry.latitude,
        longitude: entry.longitude,
        timestampMs,
        status
      });
    }
    return shouldPersist;
  }

  private rememberHistoryPersistState(tripId: string, state: HistoryPersistState): void {
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

  private publishTrackingEventAsync(event: {
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

  /**
   * Add driver to transporter's fleet (for fleet tracking)
   */
  async addDriverToFleet(transporterId: string, driverId: string): Promise<void> {
    await redisService.sAdd(REDIS_KEYS.FLEET_DRIVERS(transporterId), driverId);
    await redisService.expire(REDIS_KEYS.FLEET_DRIVERS(transporterId), TTL.TRIP);
    await redisService.sAdd(REDIS_KEYS.ACTIVE_FLEET_TRANSPORTERS, transporterId);
    logger.debug('Driver added to fleet', { transporterId, driverId });
  }

  /**
   * Remove driver from fleet
   */
  async removeDriverFromFleet(transporterId: string, driverId: string): Promise<void> {
    await redisService.sRem(REDIS_KEYS.FLEET_DRIVERS(transporterId), driverId);
    const fleetSize = await redisService.sCard(REDIS_KEYS.FLEET_DRIVERS(transporterId));
    if (fleetSize <= 0) {
      await redisService.sRem(REDIS_KEYS.ACTIVE_FLEET_TRANSPORTERS, transporterId);
    }
    // Also delete their location
    await redisService.del(REDIS_KEYS.DRIVER_LOCATION(driverId));
    logger.debug('Driver removed from fleet', { transporterId, driverId });
  }

  // ===========================================================================
  // PHASE 5: DRIVER OFFLINE DETECTION
  // ===========================================================================
  // 
  // PRD 5.2: "Backend detects no GPS for 2min → notify transporter"
  // 
  // HOW IT WORKS:
  //   1. Runs every 30 seconds
  //   2. Scans all active fleet drivers (from Redis sets)
  //   3. Checks each driver's lastUpdated timestamp
  //   4. If > 2 minutes stale → driver may be offline
  //   5. Notifies transporter via WebSocket + FCM
  //   6. Uses Redis key to prevent duplicate notifications (5min cooldown)
  // 
  // SCALABILITY:
  //   - Only checks drivers in active fleets (no full DB scan)
  //   - Redis operations are O(1) per driver
  //   - Distributed lock prevents duplicate processing across ECS instances
  //   - Cooldown key prevents notification spam
  // 
  // GRACEFUL:
  //   - Non-critical — if Redis is down, checker silently skips
  //   - Never throws — all errors caught and logged
  // ===========================================================================

  private offlineCheckerInterval: NodeJS.Timeout | null = null;

  /**
   * Start the driver offline checker
   */
  startDriverOfflineChecker(): void {
    if (this.offlineCheckerInterval) return;

    this.offlineCheckerInterval = setInterval(async () => {
      try {
        await this.checkDriversOffline();
      } catch (error: any) {
        logger.warn('[OFFLINE CHECKER] Error (non-fatal)', { error: error.message });
      }
    }, 30_000); // Every 30 seconds

    logger.info('🔍 Driver offline checker started (30s interval, 2min threshold)');
  }

  stopDriverOfflineChecker(): void {
    if (this.offlineCheckerInterval) {
      clearInterval(this.offlineCheckerInterval);
      this.offlineCheckerInterval = null;
      logger.info('Driver offline checker stopped');
    }
  }

  /**
   * Check all active fleet drivers for offline status
   */
  private async checkDriversOffline(): Promise<void> {
    // Distributed lock — only one ECS instance runs this at a time
    const lock = await redisService.acquireLock('offline-checker', 'tracker', 25);
    if (!lock.acquired) return;

    try {
      let transporterIds = await redisService.sMembers(REDIS_KEYS.ACTIVE_FLEET_TRANSPORTERS);

      // Backward compatibility fallback for historical deployments that populated
      // only fleet:{transporterId} sets and not the active transporter index.
      if (transporterIds.length === 0) {
        const allFleetKeys: string[] = [];
        for await (const key of redisService.scanIterator('fleet:*')) {
          allFleetKeys.push(key);
        }
        const uuidRegex = /^fleet:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        transporterIds = allFleetKeys
          .filter(key => uuidRegex.test(key))
          .map(key => key.replace('fleet:', ''));
        transporterIds = Array.from(new Set(transporterIds));
        if (transporterIds.length > 0) {
          await redisService.sAdd(REDIS_KEYS.ACTIVE_FLEET_TRANSPORTERS, ...transporterIds);
        }
      }

      const locationBatchSize = Math.max(
        25,
        Math.min(400, parseInt(process.env.TRACKING_OFFLINE_CHECK_BATCH_SIZE || '120', 10) || 120)
      );

      for (const transporterId of transporterIds) {
        const driverIds = await redisService.sMembers(REDIS_KEYS.FLEET_DRIVERS(transporterId));
        if (driverIds.length === 0) {
          await redisService.sRem(REDIS_KEYS.ACTIVE_FLEET_TRANSPORTERS, transporterId);
          continue;
        }

        const offlineDrivers: Array<{ driverId: string; location: LocationData; ageSeconds: number }> = [];
        for (let i = 0; i < driverIds.length; i += locationBatchSize) {
          const chunk = driverIds.slice(i, i + locationBatchSize);
          const chunkResults = await Promise.all(
            chunk.map(async (driverId) => {
              const location = await redisService.getJSON<LocationData>(REDIS_KEYS.DRIVER_LOCATION(driverId));
              if (!location) return null;
              const lastUpdateMs = new Date(location.lastUpdated).getTime();
              const ageSeconds = (Date.now() - lastUpdateMs) / 1000;
              if (ageSeconds <= 120) return null;
              return { driverId, location, ageSeconds };
            })
          );
          for (const offlineDriver of chunkResults) {
            if (offlineDriver) {
              offlineDrivers.push(offlineDriver);
            }
          }
        }

        for (const offlineDriver of offlineDrivers) {
          const { driverId, location, ageSeconds } = offlineDriver;
          const cooldownKey = `offline:notified:${driverId}`;
          const alreadyNotified = await redisService.get(cooldownKey);
          if (alreadyNotified) continue;

          await redisService.set(cooldownKey, '1', 300);

          emitToUser(transporterId, 'driver_may_be_offline', {
            driverId,
            driverName: location.vehicleNumber,
            vehicleNumber: location.vehicleNumber,
            tripId: location.tripId,
            lastSeenSeconds: Math.round(ageSeconds),
            lastLatitude: location.latitude,
            lastLongitude: location.longitude,
            message: `Driver (${location.vehicleNumber}) hasn't sent GPS for ${Math.round(ageSeconds / 60)} minutes`
          });

          // === CASE 5.2 FIX: Also notify the CUSTOMER if this driver has an active trip ===
          if (location.tripId) {
            try {
              const assignment = await prismaClient.assignment.findFirst({
                where: { tripId: location.tripId, status: { in: ['pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit'] } },
                select: {
                  driverName: true,
                  vehicleNumber: true,
                  booking: { select: { customerId: true } },
                  order: { select: { customerId: true } }
                }
              });
              const customerId = assignment?.booking?.customerId || assignment?.order?.customerId;
              if (customerId) {
                emitToUser(customerId, 'driver_connectivity_issue', {
                  tripId: location.tripId,
                  driverName: assignment?.driverName || location.vehicleNumber,
                  vehicleNumber: assignment?.vehicleNumber || location.vehicleNumber,
                  lastSeenSeconds: Math.round(ageSeconds),
                  message: `Your driver may have poor connectivity. We're monitoring the situation.`,
                  timestamp: new Date().toISOString()
                });
                queueService.queuePushNotification(customerId, {
                  title: '⚠️ Driver connectivity issue',
                  body: `${assignment?.driverName || location.vehicleNumber} may have poor network. Your trip is still active.`,
                  data: {
                    type: 'driver_connectivity_issue',
                    tripId: location.tripId,
                    vehicleNumber: assignment?.vehicleNumber || location.vehicleNumber
                  }
                }).catch(() => { }); // Fire-and-forget
              }
            } catch (lookupError: any) {
              // Non-critical — transporter notification already sent
              logger.warn('[OFFLINE CHECKER] Customer lookup failed (non-fatal)', { tripId: location.tripId, error: lookupError?.message });
            }
          }

          queueService.queuePushNotification(transporterId, {
            title: '⚠️ Driver May Be Offline',
            body: `${location.vehicleNumber} hasn't sent GPS for ${Math.round(ageSeconds / 60)} min`,
            data: {
              type: 'driver_offline',
              driverId,
              tripId: location.tripId,
              vehicleNumber: location.vehicleNumber,
              lastSeenSeconds: String(Math.round(ageSeconds))
            }
          }).catch(err => {
            logger.warn('[OFFLINE CHECKER] FCM push failed', { error: err.message });
          });

          logger.warn(`[OFFLINE CHECKER] Driver ${driverId} (${location.vehicleNumber}) offline for ${Math.round(ageSeconds)}s`);
        }
      }
    } finally {
      await redisService.releaseLock('offline-checker', 'tracker');
    }
  }

  // ===========================================================================
  // PHASE 5: BOOKING COMPLETION CHECK
  // ===========================================================================
  // 
  // PRD 5.2: "Booking completes when ALL trucks complete"
  // 
  // Called from updateTripStatus() when a single truck completes.
  // Checks if all assignments for the booking are completed.
  // If yes → updates booking status and sends customer notification.
  // ===========================================================================

  async checkBookingCompletion(bookingId: string): Promise<void> {
    try {
      // =====================================================================
      // DISTRIBUTED LOCK — prevents duplicate "All complete!" notifications
      // 
      // RACE CONDITION SCENARIO:
      //   Truck A and Truck B complete at the same time (within ms).
      //   Both call checkBookingCompletion(bookingId).
      //   Without a lock, both see "all completed" and send 2x notifications.
      //
      // SOLUTION: Redis distributed lock with 10s TTL.
      //   Only the first instance processes; second one skips.
      //   Lock auto-releases after 10s (safety net if crash).
      //
      // SCALABILITY: O(1) Redis SETNX — works across all ECS instances.
      // =====================================================================
      const lockKey = `lock:booking-completion:${bookingId}`;
      const lock = await redisService.acquireLock(lockKey, 'completion-checker', 10);
      if (!lock.acquired) {
        logger.debug('[BOOKING COMPLETION] Lock not acquired (another instance handling)', { bookingId });
        return;
      }

      try {
        // Get all assignments for this booking
        const assignments = await prismaClient.assignment.findMany({
          where: { bookingId },
          select: { id: true, status: true }
        });

        if (assignments.length === 0) return;

        const allCompleted = assignments.every(a => a.status === 'completed');

        if (allCompleted) {
          logger.info(`[BOOKING COMPLETION] All ${assignments.length} trucks completed for booking ${bookingId}`);

          // Update booking status + notify customer
          // Uses db.ts (which wraps Prisma or JSON — handles both)
          const { db: dbService } = await import('../../shared/database/db');
          const booking = await dbService.getBookingById(bookingId);

          if (booking) {
            // Only update if not already completed (idempotent)
            if (booking.status !== 'completed') {
              await dbService.updateBooking(bookingId, { status: 'completed' });
            }

            if (booking.customerId) {
              // WebSocket
              emitToUser(booking.customerId, 'booking_completed', {
                bookingId,
                totalTrucks: assignments.length,
                message: `All ${assignments.length} deliveries complete!`
              });

              // FCM push
              queueService.queuePushNotification(booking.customerId, {
                title: '✅ All Deliveries Complete!',
                body: `All ${assignments.length} truck(s) have completed delivery. Rate your experience!`,
                data: {
                  type: 'booking_completed',
                  bookingId,
                  totalTrucks: String(assignments.length)
                }
              }).catch(err => {
                logger.warn('[BOOKING COMPLETION] FCM push failed', { error: err.message });
              });
            }
          }
        } else {
          const completedCount = assignments.filter(a => a.status === 'completed').length;
          logger.info(`[BOOKING COMPLETION] ${completedCount}/${assignments.length} trucks completed for booking ${bookingId}`);
        }
      } finally {
        await redisService.releaseLock(lockKey, 'completion-checker');
      }
    } catch (error: any) {
      // Non-critical — individual trip completion already succeeded
      logger.warn('[BOOKING COMPLETION] Check failed (non-fatal)', { bookingId, error: error.message });
    }
  }
}

export const trackingService = new TrackingService();

// Start driver offline checker when module loads
trackingService.startDriverOfflineChecker();
