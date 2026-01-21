/**
 * =============================================================================
 * TRACKING MODULE - SERVICE
 * =============================================================================
 * 
 * Business logic for real-time location tracking.
 * =============================================================================
 */

import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToBooking, emitToTrip, SocketEvent } from '../../shared/services/socket.service';
import { 
  UpdateLocationInput, 
  GetTrackingQuery, 
  TrackingResponse,
  BookingTrackingResponse,
  LocationHistoryEntry
} from './tracking.schema';

// In-memory stores (replace with Redis in production)
const locationStore = new Map<string, LocationData>();
const historyStore = new Map<string, LocationHistoryEntry[]>();

interface LocationData {
  tripId: string;
  driverId: string;
  vehicleNumber: string;
  bookingId: string;
  latitude: number;
  longitude: number;
  speed: number;
  bearing: number;
  status: string;
  lastUpdated: Date;
}

class TrackingService {
  /**
   * Update driver location
   */
  async updateLocation(driverId: string, data: UpdateLocationInput): Promise<void> {
    const existing = locationStore.get(data.tripId);
    
    // Verify driver owns this trip
    if (existing && existing.driverId !== driverId) {
      throw new AppError(403, 'FORBIDDEN', 'Not authorized to update this trip');
    }

    const locationData: LocationData = {
      tripId: data.tripId,
      driverId,
      vehicleNumber: existing?.vehicleNumber || '',
      bookingId: existing?.bookingId || '',
      latitude: data.latitude,
      longitude: data.longitude,
      speed: data.speed || 0,
      bearing: data.bearing || 0,
      status: existing?.status || 'in_transit',
      lastUpdated: new Date()
    };

    locationStore.set(data.tripId, locationData);

    // Store in history
    const history = historyStore.get(data.tripId) || [];
    history.push({
      latitude: data.latitude,
      longitude: data.longitude,
      speed: data.speed || 0,
      timestamp: new Date().toISOString()
    });
    
    // Keep last 1000 points
    if (history.length > 1000) {
      history.shift();
    }
    historyStore.set(data.tripId, history);

    // Broadcast to booking room
    if (existing?.bookingId) {
      emitToBooking(existing.bookingId, SocketEvent.LOCATION_UPDATED, {
        tripId: data.tripId,
        driverId,
        latitude: data.latitude,
        longitude: data.longitude,
        speed: data.speed,
        bearing: data.bearing,
        timestamp: new Date().toISOString()
      });
    }

    // Broadcast to trip room
    emitToTrip(data.tripId, SocketEvent.LOCATION_UPDATED, {
      tripId: data.tripId,
      driverId,
      latitude: data.latitude,
      longitude: data.longitude,
      speed: data.speed,
      bearing: data.bearing,
      timestamp: new Date().toISOString()
    });

    logger.debug('Location updated', { tripId: data.tripId, driverId });
  }

  /**
   * Initialize tracking for a trip (called when assignment starts)
   */
  async initializeTracking(
    tripId: string,
    driverId: string,
    vehicleNumber: string,
    bookingId: string
  ): Promise<void> {
    locationStore.set(tripId, {
      tripId,
      driverId,
      vehicleNumber,
      bookingId,
      latitude: 0,
      longitude: 0,
      speed: 0,
      bearing: 0,
      status: 'pending',
      lastUpdated: new Date()
    });

    historyStore.set(tripId, []);
    logger.info('Tracking initialized', { tripId, driverId });
  }

  /**
   * Update tracking status
   */
  async updateStatus(tripId: string, status: string): Promise<void> {
    const location = locationStore.get(tripId);
    if (location) {
      location.status = status;
      locationStore.set(tripId, location);
    }
  }

  /**
   * Get current location for a trip
   * Alias: getCurrentLocation
   */
  async getTripTracking(
    tripId: string,
    _userId: string,
    _userRole: string
  ): Promise<TrackingResponse> {
    const location = locationStore.get(tripId);

    if (!location) {
      throw new AppError(404, 'TRACKING_NOT_FOUND', 'No tracking data for this trip');
    }

    // Access control would check booking/assignment ownership
    // Simplified for now

    return {
      tripId: location.tripId,
      driverId: location.driverId,
      vehicleNumber: location.vehicleNumber,
      latitude: location.latitude,
      longitude: location.longitude,
      speed: location.speed,
      bearing: location.bearing,
      status: location.status,
      lastUpdated: location.lastUpdated.toISOString()
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
   * Get all truck locations for a booking
   */
  async getBookingTracking(
    bookingId: string,
    _userId?: string,
    _userRole?: string
  ): Promise<BookingTrackingResponse> {
    // Find all trips for this booking
    const trucks: TrackingResponse[] = [];

    for (const [_tripId, location] of locationStore.entries()) {
      if (location.bookingId === bookingId) {
        trucks.push({
          tripId: location.tripId,
          driverId: location.driverId,
          vehicleNumber: location.vehicleNumber,
          latitude: location.latitude,
          longitude: location.longitude,
          speed: location.speed,
          bearing: location.bearing,
          status: location.status,
          lastUpdated: location.lastUpdated.toISOString()
        });
      }
    }

    return {
      bookingId,
      trucks
    };
  }

  /**
   * Get location history for a trip
   */
  async getTripHistory(
    tripId: string,
    _userId: string,
    _userRole: string,
    query: GetTrackingQuery
  ): Promise<LocationHistoryEntry[]> {
    const history = historyStore.get(tripId) || [];

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
    const location = locationStore.get(tripId);
    if (location) {
      location.status = 'completed';
      locationStore.set(tripId, location);
    }
    logger.info('Tracking completed', { tripId });
  }
}

export const trackingService = new TrackingService();
