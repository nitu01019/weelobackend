/**
 * =============================================================================
 * TRACKING MODULE - SERVICE
 * =============================================================================
 *
 * Business logic for real-time location tracking.
 * =============================================================================
 */
import { UpdateLocationInput, GetTrackingQuery, TrackingResponse, BookingTrackingResponse, LocationHistoryEntry } from './tracking.schema';
declare class TrackingService {
    /**
     * Update driver location
     */
    updateLocation(driverId: string, data: UpdateLocationInput): Promise<void>;
    /**
     * Initialize tracking for a trip (called when assignment starts)
     */
    initializeTracking(tripId: string, driverId: string, vehicleNumber: string, bookingId: string): Promise<void>;
    /**
     * Update tracking status
     */
    updateStatus(tripId: string, status: string): Promise<void>;
    /**
     * Get current location for a trip
     * Alias: getCurrentLocation
     */
    getTripTracking(tripId: string, _userId: string, _userRole: string): Promise<TrackingResponse>;
    /**
     * Get current location - alias for getTripTracking
     */
    getCurrentLocation(tripId: string, userId: string, userRole: string): Promise<TrackingResponse>;
    /**
     * Get all truck locations for a booking
     */
    getBookingTracking(bookingId: string, _userId?: string, _userRole?: string): Promise<BookingTrackingResponse>;
    /**
     * Get location history for a trip
     */
    getTripHistory(tripId: string, _userId: string, _userRole: string, query: GetTrackingQuery): Promise<LocationHistoryEntry[]>;
    /**
     * Get location history - alias for getTripHistory
     */
    getLocationHistory(tripId: string, userId: string, userRole: string, query: GetTrackingQuery): Promise<LocationHistoryEntry[]>;
    /**
     * Clean up tracking when trip completes
     */
    completeTracking(tripId: string): Promise<void>;
}
export declare const trackingService: TrackingService;
export {};
//# sourceMappingURL=tracking.service.d.ts.map