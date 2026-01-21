"use strict";
/**
 * =============================================================================
 * BOOKING MODULE - SERVICE
 * =============================================================================
 *
 * Business logic for customer bookings.
 *
 * KEY FEATURES:
 * 1. Smart Matching Algorithm
 *    - Finds transporters with matching truck TYPE (simplified for testing)
 *    - Broadcasts to ALL matching transporters
 *
 * 2. Request Timeout System
 *    - Configurable timeout (5 min test / 30 min production)
 *    - Auto-expires unfilled bookings
 *    - Notifies customer with "No vehicle available"
 *
 * 3. Partial Fulfillment
 *    - Multiple transporters can fill same request
 *    - Tracks trucks filled vs trucks needed
 *    - Keeps broadcasting until all trucks filled or timeout
 *
 * SCALABILITY: Designed for millions of concurrent users
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.bookingService = void 0;
const uuid_1 = require("uuid");
const db_1 = require("../../shared/database/db");
const error_types_1 = require("../../shared/types/error.types");
const logger_service_1 = require("../../shared/services/logger.service");
const socket_service_1 = require("../../shared/services/socket.service");
const fcm_service_1 = require("../../shared/services/fcm.service");
// =============================================================================
// CONFIGURATION - Easy to adjust for testing vs production
// =============================================================================
const BOOKING_CONFIG = {
    // Timeout in milliseconds (5 minutes for testing, 30 minutes for production)
    TIMEOUT_MS: 5 * 60 * 1000, // 5 minutes
    // How often to check for expired bookings
    EXPIRY_CHECK_INTERVAL_MS: 30 * 1000, // Every 30 seconds
    // Countdown notification interval (notify customer of remaining time)
    COUNTDOWN_INTERVAL_MS: 60 * 1000, // Every 1 minute
};
// Store active timers for cleanup
const bookingTimers = new Map();
const countdownTimers = new Map();
class BookingService {
    // ==========================================================================
    // CREATE BOOKING (CUSTOMER)
    // ==========================================================================
    /**
     * Create a new booking request
     *
     * ENHANCED BROADCAST SYSTEM:
     * 1. Customer selects vehicle type (e.g., "tipper", "20-24 Ton")
     * 2. System finds ALL transporters with that vehicle TYPE
     * 3. Broadcasts to ALL matching transporters simultaneously
     * 4. Starts timeout countdown
     * 5. Multiple transporters can accept (partial fulfillment)
     * 6. Auto-expires if not filled within timeout
     */
    async createBooking(customerId, customerPhone, data) {
        // Get customer name
        const customer = db_1.db.getUserById(customerId);
        const customerName = customer?.name || 'Customer';
        // Calculate expiry based on config timeout
        const expiresAt = new Date(Date.now() + BOOKING_CONFIG.TIMEOUT_MS).toISOString();
        // ========================================
        // SMART MATCHING: Find ALL transporters with matching vehicle TYPE
        // Simplified: Match by type only (not subtype) for broader reach during testing
        // ========================================
        const matchingTransporters = db_1.db.getTransportersWithVehicleType(data.vehicleType
        // Note: vehicleSubtype is optional - matches any subtype of that type
        );
        logger_service_1.logger.info(`╔══════════════════════════════════════════════════════════════╗`);
        logger_service_1.logger.info(`║  🚛 NEW BOOKING REQUEST                                       ║`);
        logger_service_1.logger.info(`╠══════════════════════════════════════════════════════════════╣`);
        logger_service_1.logger.info(`║  Vehicle: ${data.vehicleType} - ${data.vehicleSubtype || 'Any'}`);
        logger_service_1.logger.info(`║  Trucks Needed: ${data.trucksNeeded}`);
        logger_service_1.logger.info(`║  Price/Truck: ₹${data.pricePerTruck}`);
        logger_service_1.logger.info(`║  Distance: ${data.distanceKm} km`);
        logger_service_1.logger.info(`║  Matching Transporters: ${matchingTransporters.length}`);
        logger_service_1.logger.info(`║  Timeout: ${BOOKING_CONFIG.TIMEOUT_MS / 1000} seconds`);
        logger_service_1.logger.info(`╚══════════════════════════════════════════════════════════════╝`);
        // Create booking
        const booking = db_1.db.createBooking({
            id: (0, uuid_1.v4)(),
            customerId,
            customerName,
            customerPhone,
            pickup: {
                latitude: data.pickup.coordinates.latitude,
                longitude: data.pickup.coordinates.longitude,
                address: data.pickup.address,
                city: data.pickup.city,
                state: data.pickup.state
            },
            drop: {
                latitude: data.drop.coordinates.latitude,
                longitude: data.drop.coordinates.longitude,
                address: data.drop.address,
                city: data.drop.city,
                state: data.drop.state
            },
            vehicleType: data.vehicleType,
            vehicleSubtype: data.vehicleSubtype,
            trucksNeeded: data.trucksNeeded,
            trucksFilled: 0,
            distanceKm: data.distanceKm,
            pricePerTruck: data.pricePerTruck,
            totalAmount: data.pricePerTruck * data.trucksNeeded,
            goodsType: data.goodsType,
            weight: data.weight,
            status: 'active',
            notifiedTransporters: matchingTransporters,
            scheduledAt: data.scheduledAt,
            expiresAt
        });
        // ========================================
        // HANDLE: No matching transporters found
        // ========================================
        if (matchingTransporters.length === 0) {
            logger_service_1.logger.warn(`⚠️ NO TRANSPORTERS FOUND for ${data.vehicleType}`);
            // Immediately notify customer
            (0, socket_service_1.emitToUser)(customerId, socket_service_1.SocketEvent.NO_VEHICLES_AVAILABLE, {
                bookingId: booking.id,
                vehicleType: data.vehicleType,
                vehicleSubtype: data.vehicleSubtype,
                message: `No ${data.vehicleType} vehicles available right now. Please try again later or select a different vehicle type.`,
                suggestion: 'search_again'
            });
            // Mark as expired immediately
            db_1.db.updateBooking(booking.id, { status: 'expired' });
            return {
                ...booking,
                status: 'expired',
                matchingTransportersCount: 0,
                timeoutSeconds: 0
            };
        }
        // ========================================
        // BROADCAST TO ALL MATCHING TRANSPORTERS
        // ========================================
        const broadcastPayload = {
            bookingId: booking.id,
            customerName: booking.customerName,
            vehicleType: booking.vehicleType,
            vehicleSubtype: booking.vehicleSubtype,
            trucksNeeded: booking.trucksNeeded,
            trucksFilled: 0,
            pricePerTruck: booking.pricePerTruck,
            totalFare: booking.totalAmount,
            pickupAddress: booking.pickup.address,
            pickupCity: booking.pickup.city,
            dropAddress: booking.drop.address,
            dropCity: booking.drop.city,
            distanceKm: booking.distanceKm,
            goodsType: booking.goodsType,
            weight: data.weight,
            createdAt: booking.createdAt,
            expiresAt: booking.expiresAt,
            timeoutSeconds: BOOKING_CONFIG.TIMEOUT_MS / 1000,
            isUrgent: false
        };
        for (const transporterId of matchingTransporters) {
            const transporter = db_1.db.getUserById(transporterId);
            // Send via WebSocket (for app in foreground)
            (0, socket_service_1.emitToUser)(transporterId, socket_service_1.SocketEvent.NEW_BROADCAST, broadcastPayload);
            logger_service_1.logger.info(`📢 Notified: ${transporter?.name || transporterId} (${transporter?.businessName || 'N/A'})`);
        }
        // ========================================
        // SEND FCM PUSH NOTIFICATIONS (for app in background)
        // ========================================
        fcm_service_1.fcmService.notifyNewBroadcast(matchingTransporters, {
            broadcastId: booking.id,
            customerName: booking.customerName,
            vehicleType: booking.vehicleType,
            trucksNeeded: booking.trucksNeeded,
            farePerTruck: booking.pricePerTruck,
            pickupCity: booking.pickup.city,
            dropCity: booking.drop.city
        }).then(sentCount => {
            logger_service_1.logger.info(`📱 FCM: Push notifications sent to ${sentCount}/${matchingTransporters.length} transporters`);
        }).catch(err => {
            logger_service_1.logger.warn('📱 FCM: Failed to send push notifications', err);
        });
        // ========================================
        // START TIMEOUT TIMER
        // ========================================
        this.startBookingTimeout(booking.id, customerId);
        // ========================================
        // START COUNTDOWN NOTIFICATIONS (optional)
        // ========================================
        this.startCountdownNotifications(booking.id, customerId);
        logger_service_1.logger.info(`✅ Booking ${booking.id} created, ${matchingTransporters.length} transporters notified`);
        return {
            ...booking,
            matchingTransportersCount: matchingTransporters.length,
            timeoutSeconds: BOOKING_CONFIG.TIMEOUT_MS / 1000
        };
    }
    /**
     * Start timeout timer for booking
     * Auto-expires booking if not fully filled within timeout
     */
    startBookingTimeout(bookingId, customerId) {
        // Clear any existing timer
        if (bookingTimers.has(bookingId)) {
            clearTimeout(bookingTimers.get(bookingId));
        }
        const timer = setTimeout(async () => {
            await this.handleBookingTimeout(bookingId, customerId);
        }, BOOKING_CONFIG.TIMEOUT_MS);
        bookingTimers.set(bookingId, timer);
        logger_service_1.logger.info(`⏱️ Timeout timer started for booking ${bookingId} (${BOOKING_CONFIG.TIMEOUT_MS / 1000}s)`);
    }
    /**
     * Handle booking timeout - called when timer expires
     */
    async handleBookingTimeout(bookingId, customerId) {
        const booking = db_1.db.getBookingById(bookingId);
        if (!booking) {
            logger_service_1.logger.warn(`Booking ${bookingId} not found for timeout handling`);
            return;
        }
        // Skip if already completed or cancelled
        if (['fully_filled', 'completed', 'cancelled'].includes(booking.status)) {
            logger_service_1.logger.info(`Booking ${bookingId} already ${booking.status}, skipping timeout`);
            this.clearBookingTimers(bookingId);
            return;
        }
        logger_service_1.logger.info(`⏰ TIMEOUT: Booking ${bookingId} expired`);
        // Check if partially filled
        if (booking.trucksFilled > 0 && booking.trucksFilled < booking.trucksNeeded) {
            // Partially filled - notify customer
            db_1.db.updateBooking(bookingId, { status: 'expired' });
            (0, socket_service_1.emitToUser)(customerId, socket_service_1.SocketEvent.BOOKING_EXPIRED, {
                bookingId,
                status: 'partially_filled_expired',
                trucksNeeded: booking.trucksNeeded,
                trucksFilled: booking.trucksFilled,
                message: `Only ${booking.trucksFilled} of ${booking.trucksNeeded} trucks were assigned. Would you like to continue with partial fulfillment or search again?`,
                options: ['continue_partial', 'search_again', 'cancel']
            });
            // Also notify via booking room
            (0, socket_service_1.emitToBooking)(bookingId, socket_service_1.SocketEvent.BOOKING_EXPIRED, {
                bookingId,
                status: 'partially_filled_expired',
                trucksFilled: booking.trucksFilled
            });
        }
        else if (booking.trucksFilled === 0) {
            // No trucks filled - "No vehicle available"
            db_1.db.updateBooking(bookingId, { status: 'expired' });
            (0, socket_service_1.emitToUser)(customerId, socket_service_1.SocketEvent.NO_VEHICLES_AVAILABLE, {
                bookingId,
                vehicleType: booking.vehicleType,
                vehicleSubtype: booking.vehicleSubtype,
                message: `No ${booking.vehicleType} available right now. We'll help you find alternatives.`,
                suggestion: 'search_again',
                options: ['search_again', 'try_different_vehicle', 'cancel']
            });
            (0, socket_service_1.emitToBooking)(bookingId, socket_service_1.SocketEvent.BOOKING_EXPIRED, {
                bookingId,
                status: 'expired',
                trucksFilled: 0
            });
        }
        // Clear timers
        this.clearBookingTimers(bookingId);
        // Notify all transporters that this broadcast is no longer available
        for (const transporterId of booking.notifiedTransporters) {
            (0, socket_service_1.emitToUser)(transporterId, socket_service_1.SocketEvent.BOOKING_EXPIRED, {
                bookingId,
                message: 'This booking request has expired'
            });
        }
    }
    /**
     * Start countdown notifications to customer
     */
    startCountdownNotifications(bookingId, customerId) {
        let remainingMs = BOOKING_CONFIG.TIMEOUT_MS;
        const countdownInterval = setInterval(() => {
            remainingMs -= BOOKING_CONFIG.COUNTDOWN_INTERVAL_MS;
            if (remainingMs <= 0) {
                clearInterval(countdownInterval);
                return;
            }
            const booking = db_1.db.getBookingById(bookingId);
            if (!booking || ['fully_filled', 'completed', 'cancelled', 'expired'].includes(booking.status)) {
                clearInterval(countdownInterval);
                return;
            }
            // Send countdown update
            (0, socket_service_1.emitToUser)(customerId, socket_service_1.SocketEvent.BROADCAST_COUNTDOWN, {
                bookingId,
                remainingSeconds: Math.floor(remainingMs / 1000),
                trucksNeeded: booking.trucksNeeded,
                trucksFilled: booking.trucksFilled,
                status: booking.status
            });
        }, BOOKING_CONFIG.COUNTDOWN_INTERVAL_MS);
        countdownTimers.set(bookingId, countdownInterval);
    }
    /**
     * Clear all timers for a booking
     */
    clearBookingTimers(bookingId) {
        if (bookingTimers.has(bookingId)) {
            clearTimeout(bookingTimers.get(bookingId));
            bookingTimers.delete(bookingId);
        }
        if (countdownTimers.has(bookingId)) {
            clearInterval(countdownTimers.get(bookingId));
            countdownTimers.delete(bookingId);
        }
    }
    /**
     * Cancel booking timeout (called when fully filled)
     */
    cancelBookingTimeout(bookingId) {
        this.clearBookingTimers(bookingId);
        logger_service_1.logger.info(`⏱️ Timeout cancelled for booking ${bookingId}`);
    }
    // ==========================================================================
    // GET BOOKINGS
    // ==========================================================================
    /**
     * Get customer's bookings
     */
    async getCustomerBookings(customerId, query) {
        let bookings = db_1.db.getBookingsByCustomer(customerId);
        // Filter by status
        if (query.status) {
            bookings = bookings.filter(b => b.status === query.status);
        }
        // Sort by newest first
        bookings.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        const total = bookings.length;
        // Pagination
        const start = (query.page - 1) * query.limit;
        bookings = bookings.slice(start, start + query.limit);
        return {
            bookings,
            total,
            hasMore: start + bookings.length < total
        };
    }
    /**
     * Get active broadcasts for a transporter
     * ONLY returns bookings where transporter has matching trucks!
     */
    async getActiveBroadcasts(transporterId, query) {
        // Get bookings that match this transporter's vehicle types
        let bookings = db_1.db.getActiveBookingsForTransporter(transporterId);
        // Only show active/partially filled
        bookings = bookings.filter(b => b.status === 'active' || b.status === 'partially_filled');
        // Sort by newest first
        bookings.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        const total = bookings.length;
        // Pagination
        const start = (query.page - 1) * query.limit;
        bookings = bookings.slice(start, start + query.limit);
        logger_service_1.logger.info(`Transporter ${transporterId} can see ${total} matching bookings`);
        return {
            bookings,
            total,
            hasMore: start + bookings.length < total
        };
    }
    /**
     * Get booking by ID
     */
    async getBookingById(bookingId, userId, userRole) {
        const booking = db_1.db.getBookingById(bookingId);
        if (!booking) {
            throw new error_types_1.AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
        }
        // Access control
        if (userRole === 'customer' && booking.customerId !== userId) {
            throw new error_types_1.AppError(403, 'FORBIDDEN', 'Access denied');
        }
        // Transporters can only see if they have matching vehicles
        if (userRole === 'transporter') {
            const transporterVehicles = db_1.db.getVehiclesByTransporter(userId);
            const hasMatchingVehicle = transporterVehicles.some(v => v.vehicleType === booking.vehicleType && v.isActive);
            if (!hasMatchingVehicle) {
                throw new error_types_1.AppError(403, 'FORBIDDEN', 'You do not have matching vehicles for this booking');
            }
        }
        return booking;
    }
    /**
     * Get assigned trucks for a booking
     */
    async getAssignedTrucks(bookingId, userId, userRole) {
        const booking = db_1.db.getBookingById(bookingId);
        if (!booking) {
            throw new error_types_1.AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
        }
        // Verify access
        if (userRole === 'customer' && booking.customerId !== userId) {
            throw new error_types_1.AppError(403, 'FORBIDDEN', 'Access denied');
        }
        // Get assignments for this booking
        const assignments = db_1.db.getAssignmentsByBooking(bookingId);
        return assignments.map(a => ({
            assignmentId: a.id,
            tripId: a.tripId,
            vehicleNumber: a.vehicleNumber,
            vehicleType: a.vehicleType,
            driverName: a.driverName,
            driverPhone: a.driverPhone,
            status: a.status,
            assignedAt: a.assignedAt
        }));
    }
    // ==========================================================================
    // UPDATE BOOKING
    // ==========================================================================
    /**
     * Cancel booking
     */
    async cancelBooking(bookingId, customerId) {
        const booking = db_1.db.getBookingById(bookingId);
        if (!booking) {
            throw new error_types_1.AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
        }
        if (booking.customerId !== customerId) {
            throw new error_types_1.AppError(403, 'FORBIDDEN', 'You can only cancel your own bookings');
        }
        if (booking.status === 'cancelled' || booking.status === 'completed') {
            throw new error_types_1.AppError(400, 'INVALID_STATUS', 'Booking cannot be cancelled');
        }
        const updated = db_1.db.updateBooking(bookingId, { status: 'cancelled' });
        // Notify via WebSocket
        (0, socket_service_1.emitToBooking)(bookingId, socket_service_1.SocketEvent.BOOKING_UPDATED, {
            bookingId,
            status: 'cancelled'
        });
        logger_service_1.logger.info(`Booking cancelled: ${bookingId}`);
        return updated;
    }
    /**
     * Update trucks filled (called when assignment is created)
     * ENHANCED: Cancels timeout when fully filled, notifies all parties
     */
    async incrementTrucksFilled(bookingId) {
        const booking = db_1.db.getBookingById(bookingId);
        if (!booking) {
            throw new error_types_1.AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
        }
        const newFilled = booking.trucksFilled + 1;
        const newStatus = newFilled >= booking.trucksNeeded ? 'fully_filled' : 'partially_filled';
        const updated = db_1.db.updateBooking(bookingId, {
            trucksFilled: newFilled,
            status: newStatus
        });
        // Notify customer via WebSocket
        (0, socket_service_1.emitToUser)(booking.customerId, socket_service_1.SocketEvent.BOOKING_UPDATED, {
            bookingId,
            status: newStatus,
            trucksFilled: newFilled,
            trucksNeeded: booking.trucksNeeded,
            message: newStatus === 'fully_filled'
                ? `🎉 All ${booking.trucksNeeded} trucks assigned! Your booking is complete.`
                : `✅ ${newFilled}/${booking.trucksNeeded} trucks assigned. Searching for more...`
        });
        // Also notify via booking room
        (0, socket_service_1.emitToBooking)(bookingId, socket_service_1.SocketEvent.BOOKING_UPDATED, {
            bookingId,
            status: newStatus,
            trucksFilled: newFilled,
            trucksNeeded: booking.trucksNeeded
        });
        // If fully filled, cancel timeout and notify
        if (newStatus === 'fully_filled') {
            this.cancelBookingTimeout(bookingId);
            // Send fully filled event to customer
            (0, socket_service_1.emitToUser)(booking.customerId, socket_service_1.SocketEvent.BOOKING_FULLY_FILLED, {
                bookingId,
                trucksNeeded: booking.trucksNeeded,
                trucksFilled: newFilled,
                message: 'All trucks have been assigned to your booking!'
            });
            // Notify remaining transporters that booking is no longer available
            for (const transporterId of booking.notifiedTransporters) {
                (0, socket_service_1.emitToUser)(transporterId, socket_service_1.SocketEvent.BOOKING_UPDATED, {
                    bookingId,
                    status: 'fully_filled',
                    message: 'This booking has been fully filled'
                });
            }
            logger_service_1.logger.info(`🎉 Booking ${bookingId} FULLY FILLED: ${newFilled}/${booking.trucksNeeded} trucks`);
        }
        else {
            // Partially filled - notify customer
            (0, socket_service_1.emitToUser)(booking.customerId, socket_service_1.SocketEvent.BOOKING_PARTIALLY_FILLED, {
                bookingId,
                trucksNeeded: booking.trucksNeeded,
                trucksFilled: newFilled,
                remaining: booking.trucksNeeded - newFilled,
                message: `${newFilled} truck${newFilled > 1 ? 's' : ''} assigned, searching for ${booking.trucksNeeded - newFilled} more...`
            });
            logger_service_1.logger.info(`📦 Booking ${bookingId} PARTIALLY FILLED: ${newFilled}/${booking.trucksNeeded} trucks`);
        }
        return updated;
    }
    /**
     * Decrement trucks filled (called when assignment is cancelled)
     */
    async decrementTrucksFilled(bookingId) {
        const booking = db_1.db.getBookingById(bookingId);
        if (!booking) {
            throw new error_types_1.AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
        }
        const newFilled = Math.max(0, booking.trucksFilled - 1);
        const newStatus = newFilled === 0 ? 'active' : 'partially_filled';
        const updated = db_1.db.updateBooking(bookingId, {
            trucksFilled: newFilled,
            status: newStatus
        });
        // Notify via WebSocket
        (0, socket_service_1.emitToBooking)(bookingId, socket_service_1.SocketEvent.BOOKING_UPDATED, {
            bookingId,
            status: newStatus,
            trucksFilled: newFilled,
            trucksNeeded: booking.trucksNeeded
        });
        return updated;
    }
}
exports.bookingService = new BookingService();
//# sourceMappingURL=booking.service.js.map