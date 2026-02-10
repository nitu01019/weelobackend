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
import { haversineDistanceMeters } from '../../shared/utils/geospatial.utils';
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
  TRACKING_CONFIG
} from './tracking.schema';

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

      // 3. Store in Redis (both trip and driver location)
      await Promise.all([
        // Trip location (for trip tracking)
        redisService.setJSON(REDIS_KEYS.TRIP_LOCATION(data.tripId), locationData, TTL.TRIP),
        
        // Driver's current location (for fleet tracking)
        redisService.setJSON(REDIS_KEYS.DRIVER_LOCATION(driverId), locationData, TTL.LOCATION),
      ]);

      // 4. Add to history (fire and forget)
      this.addToHistory(data.tripId, {
        latitude: data.latitude,
        longitude: data.longitude,
        speed: data.speed || 0,
        timestamp: now
      });

      // 5. Broadcast via WebSocket - THE KEY FOR REAL-TIME
      const broadcastPayload = {
        tripId: data.tripId,
        driverId,
        latitude: data.latitude,
        longitude: data.longitude,
        speed: data.speed,
        bearing: data.bearing,
        timestamp: now
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

      logger.debug('📍 Location updated', { tripId: data.tripId, driverId, lat: data.latitude, lng: data.longitude });
      
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
      const history = await redisService.getJSON<LocationHistoryEntry[]>(key) || [];
      
      history.push(entry);
      
      // Keep last 1000 points (prevent unbounded growth)
      if (history.length > 1000) {
        history.shift();
      }
      
      await redisService.setJSON(key, history, TTL.HISTORY);
    } catch (error) {
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
      await redisService.sAdd(REDIS_KEYS.FLEET_DRIVERS(transporterId), driverId);
      await redisService.expire(REDIS_KEYS.FLEET_DRIVERS(transporterId), TTL.TRIP);
    }
    
    // Initialize empty history
    await redisService.setJSON(REDIS_KEYS.TRIP_HISTORY(tripId), [], TTL.HISTORY);

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
   * Get current location for a trip
   * Used by: Customer app to track their truck
   */
  async getTripTracking(
    tripId: string,
    _userId: string,
    _userRole: string
  ): Promise<TrackingResponse> {
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
    _userId?: string,
    _userRole?: string
  ): Promise<BookingTrackingResponse> {
    // Get all trip IDs for this booking
    const tripIds = await redisService.sMembers(REDIS_KEYS.BOOKING_TRIPS(bookingId));
    
    const trucks: TrackingResponse[] = [];

    // Fetch all trip locations in parallel
    const locationPromises = tripIds.map(tripId => 
      redisService.getJSON<LocationData>(REDIS_KEYS.TRIP_LOCATION(tripId))
    );
    
    const locations = await Promise.all(locationPromises);
    
    for (const location of locations) {
      if (location && location.bookingId === bookingId) {
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
    _userId: string,
    _userRole: string,
    query: GetTrackingQuery
  ): Promise<LocationHistoryEntry[]> {
    const history = await redisService.getJSON<LocationHistoryEntry[]>(REDIS_KEYS.TRIP_HISTORY(tripId)) || [];

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
      }
      
      // Broadcast completion
      emitToTrip(tripId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
        tripId,
        status: 'completed',
        timestamp: location.lastUpdated
      });
    }
    
    logger.info('✅ Tracking completed', { tripId });
  }
  
  /**
   * Add driver to transporter's fleet (for fleet tracking)
   */
  async addDriverToFleet(transporterId: string, driverId: string): Promise<void> {
    await redisService.sAdd(REDIS_KEYS.FLEET_DRIVERS(transporterId), driverId);
    await redisService.expire(REDIS_KEYS.FLEET_DRIVERS(transporterId), TTL.TRIP);
    logger.debug('Driver added to fleet', { transporterId, driverId });
  }
  
  /**
   * Remove driver from fleet
   */
  async removeDriverFromFleet(transporterId: string, driverId: string): Promise<void> {
    await redisService.sRem(REDIS_KEYS.FLEET_DRIVERS(transporterId), driverId);
    // Also delete their location
    await redisService.del(REDIS_KEYS.DRIVER_LOCATION(driverId));
    logger.debug('Driver removed from fleet', { transporterId, driverId });
  }
}

export const trackingService = new TrackingService();
