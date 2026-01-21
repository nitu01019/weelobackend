"use strict";
/**
 * =============================================================================
 * TRACKING MODULE - SERVICE
 * =============================================================================
 *
 * Business logic for real-time location tracking.
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.trackingService = void 0;
const error_types_1 = require("../../shared/types/error.types");
const logger_service_1 = require("../../shared/services/logger.service");
const socket_service_1 = require("../../shared/services/socket.service");
// In-memory stores (replace with Redis in production)
const locationStore = new Map();
const historyStore = new Map();
class TrackingService {
    /**
     * Update driver location
     */
    async updateLocation(driverId, data) {
        const existing = locationStore.get(data.tripId);
        // Verify driver owns this trip
        if (existing && existing.driverId !== driverId) {
            throw new error_types_1.AppError(403, 'FORBIDDEN', 'Not authorized to update this trip');
        }
        const locationData = {
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
            (0, socket_service_1.emitToBooking)(existing.bookingId, socket_service_1.SocketEvent.LOCATION_UPDATED, {
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
        (0, socket_service_1.emitToTrip)(data.tripId, socket_service_1.SocketEvent.LOCATION_UPDATED, {
            tripId: data.tripId,
            driverId,
            latitude: data.latitude,
            longitude: data.longitude,
            speed: data.speed,
            bearing: data.bearing,
            timestamp: new Date().toISOString()
        });
        logger_service_1.logger.debug('Location updated', { tripId: data.tripId, driverId });
    }
    /**
     * Initialize tracking for a trip (called when assignment starts)
     */
    async initializeTracking(tripId, driverId, vehicleNumber, bookingId) {
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
        logger_service_1.logger.info('Tracking initialized', { tripId, driverId });
    }
    /**
     * Update tracking status
     */
    async updateStatus(tripId, status) {
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
    async getTripTracking(tripId, _userId, _userRole) {
        const location = locationStore.get(tripId);
        if (!location) {
            throw new error_types_1.AppError(404, 'TRACKING_NOT_FOUND', 'No tracking data for this trip');
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
    async getCurrentLocation(tripId, userId, userRole) {
        return this.getTripTracking(tripId, userId, userRole);
    }
    /**
     * Get all truck locations for a booking
     */
    async getBookingTracking(bookingId, _userId, _userRole) {
        // Find all trips for this booking
        const trucks = [];
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
    async getTripHistory(tripId, _userId, _userRole, query) {
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
    async getLocationHistory(tripId, userId, userRole, query) {
        return this.getTripHistory(tripId, userId, userRole, query);
    }
    /**
     * Clean up tracking when trip completes
     */
    async completeTracking(tripId) {
        const location = locationStore.get(tripId);
        if (location) {
            location.status = 'completed';
            locationStore.set(tripId, location);
        }
        logger_service_1.logger.info('Tracking completed', { tripId });
    }
}
exports.trackingService = new TrackingService();
//# sourceMappingURL=tracking.service.js.map