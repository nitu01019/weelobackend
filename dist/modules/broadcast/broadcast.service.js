"use strict";
/**
 * =============================================================================
 * BROADCAST MODULE - SERVICE
 * =============================================================================
 *
 * Business logic for broadcast management.
 * Broadcasts are booking requests sent to drivers/transporters.
 *
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.broadcastService = void 0;
const uuid_1 = require("uuid");
const db_1 = require("../../shared/database/db");
const logger_service_1 = require("../../shared/services/logger.service");
const socket_service_1 = require("../../shared/services/socket.service");
const fcm_service_1 = require("../../shared/services/fcm.service");
class BroadcastService {
    /**
     * Get active broadcasts for a driver
     * Returns bookings that are still looking for trucks
     */
    async getActiveBroadcasts(params) {
        const { driverId, vehicleType } = params;
        // Get user to find their transporter
        const user = db_1.db.getUserById(driverId);
        const transporterId = user?.transporterId || driverId;
        // Get active bookings for this transporter
        const bookings = db_1.db.getActiveBookingsForTransporter(transporterId);
        const activeBroadcasts = bookings
            .filter((booking) => {
            // Filter by vehicle type if specified
            if (vehicleType && booking.vehicleType.toLowerCase() !== vehicleType.toLowerCase()) {
                return false;
            }
            // Check if not expired
            if (new Date(booking.expiresAt) < new Date()) {
                return false;
            }
            // Check if still needs trucks
            if (booking.trucksFilled >= booking.trucksNeeded) {
                return false;
            }
            return true;
        })
            .map((booking) => this.mapBookingToBroadcast(booking));
        logger_service_1.logger.info(`Found ${activeBroadcasts.length} active broadcasts for driver ${driverId}`);
        return activeBroadcasts;
    }
    /**
     * Get broadcast by ID
     */
    async getBroadcastById(broadcastId) {
        const booking = db_1.db.getBookingById(broadcastId);
        if (!booking) {
            throw new Error('Broadcast not found');
        }
        return this.mapBookingToBroadcast(booking);
    }
    /**
     * Accept a broadcast (assign driver/vehicle to booking)
     *
     * FLOW:
     * 1. Validate booking is still available
     * 2. Create assignment record
     * 3. Update booking status
     * 4. Notify DRIVER via WebSocket + Push (trip assignment)
     * 5. Notify CUSTOMER via WebSocket (real-time confirmation)
     *
     * SCALABILITY:
     * - Uses async notifications (non-blocking)
     * - Idempotent - safe to retry
     * - Transaction-safe with database
     */
    async acceptBroadcast(broadcastId, params) {
        const { driverId, vehicleId } = params;
        const booking = db_1.db.getBookingById(broadcastId);
        if (!booking) {
            throw new Error('Broadcast not found');
        }
        if (booking.trucksFilled >= booking.trucksNeeded) {
            throw new Error('Broadcast already filled');
        }
        if (new Date(booking.expiresAt) < new Date()) {
            throw new Error('Broadcast has expired');
        }
        // Get driver and vehicle info
        const driver = db_1.db.getUserById(driverId);
        const vehicle = db_1.db.getVehicleById(vehicleId);
        const transporter = driver?.transporterId ? db_1.db.getUserById(driver.transporterId) : null;
        // Create assignment
        const assignmentId = (0, uuid_1.v4)();
        const tripId = (0, uuid_1.v4)();
        const now = new Date().toISOString();
        const assignment = {
            id: assignmentId,
            bookingId: broadcastId,
            tripId,
            transporterId: driver?.transporterId || driverId,
            transporterName: transporter?.name || '',
            driverId,
            driverName: driver?.name || 'Driver',
            driverPhone: driver?.phone || '',
            vehicleId,
            vehicleNumber: vehicle?.vehicleNumber || '',
            vehicleType: vehicle?.vehicleType || booking.vehicleType,
            vehicleSubtype: vehicle?.vehicleSubtype || booking.vehicleSubtype || '',
            status: 'pending', // Driver needs to accept
            assignedAt: now
        };
        db_1.db.createAssignment(assignment);
        // Update booking - determine new status
        const newTrucksFilled = booking.trucksFilled + 1;
        let newStatus = 'partially_filled';
        if (newTrucksFilled >= booking.trucksNeeded) {
            newStatus = 'fully_filled';
        }
        db_1.db.updateBooking(broadcastId, {
            trucksFilled: newTrucksFilled,
            status: newStatus
        });
        logger_service_1.logger.info(`✅ Broadcast ${broadcastId} accepted - Driver: ${driverId}, Vehicle: ${vehicleId}`);
        logger_service_1.logger.info(`   📊 Progress: ${newTrucksFilled}/${booking.trucksNeeded} trucks assigned`);
        // ============== NOTIFY DRIVER ==============
        // Send notification to driver about the trip assignment
        const driverNotification = {
            type: 'trip_assignment',
            assignmentId,
            tripId,
            bookingId: broadcastId,
            pickup: booking.pickup,
            drop: booking.drop,
            vehicleNumber: vehicle?.vehicleNumber || '',
            farePerTruck: booking.pricePerTruck,
            distanceKm: booking.distanceKm,
            customerName: booking.customerName,
            customerPhone: booking.customerPhone,
            assignedAt: now,
            message: `New trip assigned! ${booking.pickup.address} → ${booking.drop.address}`
        };
        // WebSocket notification to driver
        (0, socket_service_1.emitToUser)(driverId, 'trip_assigned', driverNotification);
        logger_service_1.logger.info(`📢 Notified driver ${driverId} (${driver?.name}) about trip assignment`);
        // Push notification to driver (async, non-blocking)
        (0, fcm_service_1.sendPushNotification)(driverId, {
            title: '🚛 New Trip Assigned!',
            body: `${booking.pickup.city || booking.pickup.address} → ${booking.drop.city || booking.drop.address}`,
            data: {
                type: 'trip_assignment',
                tripId,
                assignmentId,
                bookingId: broadcastId
            }
        }).catch(err => {
            logger_service_1.logger.warn(`FCM to driver ${driverId} failed: ${err.message}`);
        });
        // ============== NOTIFY CUSTOMER ==============
        // Send real-time update to customer about truck confirmation
        const customerNotification = {
            type: 'truck_confirmed',
            bookingId: broadcastId,
            assignmentId,
            truckNumber: newTrucksFilled,
            totalTrucksNeeded: booking.trucksNeeded,
            trucksConfirmed: newTrucksFilled,
            remainingTrucks: booking.trucksNeeded - newTrucksFilled,
            isFullyFilled: newTrucksFilled >= booking.trucksNeeded,
            driver: {
                name: driver?.name || 'Driver',
                phone: driver?.phone || ''
            },
            vehicle: {
                number: vehicle?.vehicleNumber || '',
                type: vehicle?.vehicleType || booking.vehicleType,
                subtype: vehicle?.vehicleSubtype || booking.vehicleSubtype
            },
            transporter: {
                name: transporter?.name || transporter?.businessName || '',
                phone: transporter?.phone || ''
            },
            message: `Truck ${newTrucksFilled}/${booking.trucksNeeded} confirmed! ${vehicle?.vehicleNumber || 'Vehicle'} assigned.`
        };
        // WebSocket notification to customer
        (0, socket_service_1.emitToUser)(booking.customerId, 'truck_confirmed', customerNotification);
        logger_service_1.logger.info(`📢 Notified customer ${booking.customerId} - ${newTrucksFilled}/${booking.trucksNeeded} trucks confirmed`);
        // Also emit to booking room for any listeners
        (0, socket_service_1.emitToRoom)(`booking:${broadcastId}`, 'booking_updated', {
            bookingId: broadcastId,
            status: newStatus,
            trucksFilled: newTrucksFilled,
            trucksNeeded: booking.trucksNeeded
        });
        // Push notification to customer (async)
        (0, fcm_service_1.sendPushNotification)(booking.customerId, {
            title: `🚛 Truck ${newTrucksFilled}/${booking.trucksNeeded} Confirmed!`,
            body: `${vehicle?.vehicleNumber || 'Vehicle'} (${driver?.name || 'Driver'}) assigned to your booking`,
            data: {
                type: 'truck_confirmed',
                bookingId: broadcastId,
                trucksConfirmed: newTrucksFilled,
                totalTrucks: booking.trucksNeeded
            }
        }).catch(err => {
            logger_service_1.logger.warn(`FCM to customer ${booking.customerId} failed: ${err.message}`);
        });
        return {
            assignmentId,
            tripId,
            status: 'assigned',
            trucksConfirmed: newTrucksFilled,
            totalTrucksNeeded: booking.trucksNeeded,
            isFullyFilled: newTrucksFilled >= booking.trucksNeeded
        };
    }
    /**
     * Decline a broadcast
     */
    async declineBroadcast(broadcastId, params) {
        const { driverId, reason, notes } = params;
        // Just log the decline - no need to store for now
        logger_service_1.logger.info(`Broadcast ${broadcastId} declined by ${driverId}. Reason: ${reason}`, { notes });
        return { success: true };
    }
    /**
     * Get broadcast history for a driver
     */
    async getBroadcastHistory(params) {
        const { driverId, page, limit, status } = params;
        // Get bookings for this driver
        let bookings = db_1.db.getBookingsByDriver(driverId);
        // Filter by status if provided
        if (status) {
            bookings = bookings.filter((b) => b.status === status);
        }
        const total = bookings.length;
        const pages = Math.ceil(total / limit);
        // Paginate
        const start = (page - 1) * limit;
        const paginatedBookings = bookings.slice(start, start + limit);
        return {
            broadcasts: paginatedBookings.map((b) => this.mapBookingToBroadcast(b)),
            pagination: {
                page,
                limit,
                total,
                pages
            }
        };
    }
    /**
     * Create a new broadcast (from transporter)
     */
    async createBroadcast(params) {
        const broadcastId = (0, uuid_1.v4)();
        // Get customer info
        const customer = db_1.db.getUserById(params.customerId);
        const booking = {
            id: broadcastId,
            customerId: params.customerId,
            customerName: customer?.name || 'Customer',
            customerPhone: customer?.phone || '',
            pickup: {
                latitude: params.pickupLocation.latitude,
                longitude: params.pickupLocation.longitude,
                address: params.pickupLocation.address,
                city: params.pickupLocation.city,
                state: params.pickupLocation.state
            },
            drop: {
                latitude: params.dropLocation.latitude,
                longitude: params.dropLocation.longitude,
                address: params.dropLocation.address,
                city: params.dropLocation.city,
                state: params.dropLocation.state
            },
            vehicleType: params.vehicleType,
            vehicleSubtype: params.vehicleSubtype || '',
            trucksNeeded: params.totalTrucksNeeded,
            trucksFilled: 0,
            distanceKm: 0, // Would be calculated
            pricePerTruck: params.farePerTruck,
            totalAmount: params.farePerTruck * params.totalTrucksNeeded,
            goodsType: params.goodsType,
            weight: params.weight,
            status: 'active',
            notifiedTransporters: [params.transporterId],
            expiresAt: params.expiresAt || new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
        };
        const createdBooking = db_1.db.createBooking(booking);
        // TODO: Send push notifications to drivers
        const notifiedDrivers = 10; // Mock number
        logger_service_1.logger.info(`Broadcast ${broadcastId} created, ${notifiedDrivers} drivers notified`);
        return {
            broadcast: this.mapBookingToBroadcast(createdBooking),
            notifiedDrivers
        };
    }
    /**
     * Map internal booking to broadcast format for API response
     * Enhanced with capacity/tonnage information
     */
    mapBookingToBroadcast(booking) {
        // Import vehicle catalog to get capacity info
        const { getSubtypeConfig } = require('../pricing/vehicle-catalog');
        // Get capacity information for the vehicle subtype
        const subtypeConfig = getSubtypeConfig(booking.vehicleType, booking.vehicleSubtype);
        return {
            broadcastId: booking.id,
            customerId: booking.customerId,
            customerName: booking.customerName || 'Customer',
            customerMobile: booking.customerPhone || '',
            pickupLocation: booking.pickup,
            dropLocation: booking.drop,
            distance: booking.distanceKm || 0,
            estimatedDuration: Math.round((booking.distanceKm || 100) * 1.5), // Rough estimate: 1.5 min per km
            totalTrucksNeeded: booking.trucksNeeded,
            trucksFilledSoFar: booking.trucksFilled || 0,
            vehicleType: booking.vehicleType,
            vehicleSubtype: booking.vehicleSubtype,
            goodsType: booking.goodsType || 'General',
            weight: booking.weight || 'N/A',
            farePerTruck: booking.pricePerTruck,
            totalFare: booking.totalAmount,
            status: booking.status,
            isUrgent: false,
            createdAt: booking.createdAt,
            expiresAt: booking.expiresAt,
            // Enhanced: Capacity information for transporters
            capacityInfo: subtypeConfig ? {
                capacityKg: subtypeConfig.capacityKg,
                capacityTons: subtypeConfig.capacityKg / 1000,
                minTonnage: subtypeConfig.minTonnage,
                maxTonnage: subtypeConfig.maxTonnage
            } : null
        };
    }
}
exports.broadcastService = new BroadcastService();
//# sourceMappingURL=broadcast.service.js.map