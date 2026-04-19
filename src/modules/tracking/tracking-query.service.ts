/**
 * =============================================================================
 * TRACKING MODULE - QUERY SERVICE
 * =============================================================================
 *
 * Read-only query methods for trip tracking, booking tracking,
 * fleet tracking, and location history retrieval.
 * =============================================================================
 */

import { AppError } from '../../shared/types/error.types';
import { redisService } from '../../shared/services/redis.service';
import { safeJsonParse } from '../../shared/utils/safe-json.utils';
import {
  GetTrackingQuery,
  TrackingResponse,
  BookingTrackingResponse,
  LocationHistoryEntry,
} from './tracking.schema';
import {
  assertBookingTrackingAccess,
  assertTripTrackingAccess
} from './tracking-access.policy';
import {
  REDIS_KEYS,
  LocationData,
  FleetTrackingResponse,
} from './tracking.types';

class TrackingQueryService {
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
  /**
   * F-L17 FIX: Added pagination params to avoid fetching all driver locations at once.
   * Slices driver IDs before hitting Redis so we only fetch the page we need.
   */
  async getFleetTracking(
    transporterId: string,
    page: number = 1,
    limit: number = 50
  ): Promise<FleetTrackingResponse & { page: number; limit: number; totalDrivers: number }> {
    // Get all active driver IDs for this transporter
    const allDriverIds = await redisService.sMembers(REDIS_KEYS.FLEET_DRIVERS(transporterId));
    const totalDrivers = allDriverIds.length;

    // F-L17: Paginate driver IDs before fetching locations from Redis
    const offset = (page - 1) * limit;
    const paginatedDriverIds = allDriverIds.slice(offset, offset + limit);

    const drivers: FleetTrackingResponse['drivers'] = [];

    // Fetch only paginated driver locations in parallel
    const locationPromises = paginatedDriverIds.map(driverId =>
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
      totalDrivers,
      page,
      limit,
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
    let history: LocationHistoryEntry[] = rawHistory
      .map((entry) => safeJsonParse<LocationHistoryEntry | null>(entry, null))
      .filter((entry): entry is LocationHistoryEntry => entry !== null);

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
}

export const trackingQueryService = new TrackingQueryService();
