"use strict";
/**
 * =============================================================================
 * ORDER SERVICE - Multi-Vehicle Type Booking System
 * =============================================================================
 *
 * SCALABILITY: Designed for millions of concurrent bookings
 * - Each order can have multiple vehicle types (Tipper + Container + Open)
 * - Each vehicle type creates a separate SubRequest
 * - Each SubRequest broadcasts ONLY to transporters with that vehicle type
 *
 * FLOW:
 * 1. Customer creates ORDER with multiple vehicle types
 * 2. System creates TruckRequests (one per truck, grouped by type)
 * 3. Each vehicle type broadcasts to matching transporters
 * 4. Transporters see ONLY requests matching their vehicles
 * 5. Real-time updates to customer as trucks get filled
 *
 * MODULARITY:
 * - Clear separation: Order → TruckRequests → Assignments
 * - Easy to extend for new vehicle types
 * - AWS-ready with message queue support (TODO)
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.orderService = void 0;
const uuid_1 = require("uuid");
const db_1 = require("../../shared/database/db");
const logger_service_1 = require("../../shared/services/logger.service");
const socket_service_1 = require("../../shared/services/socket.service");
const fcm_service_1 = require("../../shared/services/fcm.service");
const cache_service_1 = require("../../shared/services/cache.service");
const queue_service_1 = require("../../shared/services/queue.service");
// =============================================================================
// CACHE KEYS & TTL (Optimized for fast lookups)
// =============================================================================
const CACHE_KEYS = {
    TRANSPORTERS_BY_VEHICLE: 'trans:vehicle:', // trans:vehicle:tipper:20-24Ton
    ORDER: 'order:',
    ACTIVE_REQUESTS: 'active:requests:'
};
const CACHE_TTL = {
    TRANSPORTERS: 300, // 5 minutes - transporters by vehicle type
    ORDER: 60, // 1 minute - order details
    ACTIVE_REQUESTS: 30 // 30 seconds - active requests list
};
// =============================================================================
// SERVICE CLASS
// =============================================================================
class OrderService {
    // Timeout for broadcasts (5 minutes default)
    BROADCAST_TIMEOUT_MS = 5 * 60 * 1000;
    // Active timers for order expiry
    orderTimers = new Map();
    // ===========================================================================
    // CACHED LOOKUPS (Optimized for millions of requests)
    // ===========================================================================
    /**
     * Get transporters by vehicle type (CACHED + AVAILABILITY FILTERED)
     * Uses cache to avoid repeated DB queries during high-load broadcasts
     *
     * IMPORTANT: Only returns transporters who are:
     * 1. Have matching vehicle type
     * 2. Are marked as "available" (online toggle is ON)
     */
    async getTransportersByVehicleCached(vehicleType, vehicleSubtype) {
        const cacheKey = `${CACHE_KEYS.TRANSPORTERS_BY_VEHICLE}${vehicleType}:${vehicleSubtype}`;
        // Try cache first
        const cached = await cache_service_1.cacheService.get(cacheKey);
        let transporterIds;
        if (cached) {
            logger_service_1.logger.debug(`Cache HIT: ${cacheKey}`);
            transporterIds = JSON.parse(cached);
        }
        else {
            // Cache miss - query database
            transporterIds = db_1.db.getTransportersWithVehicleType(vehicleType, vehicleSubtype);
            // Store in cache
            await cache_service_1.cacheService.set(cacheKey, JSON.stringify(transporterIds), CACHE_TTL.TRANSPORTERS);
            logger_service_1.logger.debug(`Cache SET: ${cacheKey} (${transporterIds.length} transporters)`);
        }
        // FILTER: Only include transporters who are AVAILABLE (online toggle ON)
        const availableTransporters = transporterIds.filter(transporterId => {
            const transporter = db_1.db.getUserById(transporterId);
            // isAvailable defaults to true if not set
            return transporter && transporter.isAvailable !== false;
        });
        if (availableTransporters.length < transporterIds.length) {
            const unavailableCount = transporterIds.length - availableTransporters.length;
            logger_service_1.logger.info(`📵 Filtered out ${unavailableCount} offline transporters (${availableTransporters.length} available)`);
        }
        return availableTransporters;
    }
    /**
     * Invalidate transporter cache when vehicles change
     */
    async invalidateTransporterCache(vehicleType, vehicleSubtype) {
        if (vehicleSubtype) {
            await cache_service_1.cacheService.delete(`${CACHE_KEYS.TRANSPORTERS_BY_VEHICLE}${vehicleType}:${vehicleSubtype}`);
        }
        else {
            // Invalidate all subtypes for this vehicle type
            const keys = await cache_service_1.cacheService.keys(`${CACHE_KEYS.TRANSPORTERS_BY_VEHICLE}${vehicleType}:*`);
            for (const key of keys) {
                await cache_service_1.cacheService.delete(key);
            }
        }
        logger_service_1.logger.debug(`Cache invalidated: transporters for ${vehicleType}${vehicleSubtype ? ':' + vehicleSubtype : ':*'}`);
    }
    /**
     * Create a new order with multiple vehicle types
     *
     * SCALABILITY NOTES:
     * - For millions of users, this should be moved to a message queue
     * - Each vehicle type can be processed in parallel
     * - Database writes should be batched
     */
    async createOrder(request) {
        const orderId = (0, uuid_1.v4)();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + this.BROADCAST_TIMEOUT_MS).toISOString();
        // Calculate totals
        const totalTrucks = request.vehicleRequirements.reduce((sum, req) => sum + req.quantity, 0);
        const totalAmount = request.vehicleRequirements.reduce((sum, req) => sum + (req.quantity * req.pricePerTruck), 0);
        logger_service_1.logger.info(`╔══════════════════════════════════════════════════════════════╗`);
        logger_service_1.logger.info(`║  🚛 NEW MULTI-VEHICLE ORDER                                   ║`);
        logger_service_1.logger.info(`╠══════════════════════════════════════════════════════════════╣`);
        logger_service_1.logger.info(`║  Order ID: ${orderId.substring(0, 8)}...`);
        logger_service_1.logger.info(`║  Customer: ${request.customerName}`);
        logger_service_1.logger.info(`║  Total Trucks: ${totalTrucks}`);
        logger_service_1.logger.info(`║  Total Amount: ₹${totalAmount}`);
        logger_service_1.logger.info(`║  Vehicle Types: ${request.vehicleRequirements.length}`);
        request.vehicleRequirements.forEach((req, i) => {
            logger_service_1.logger.info(`║    ${i + 1}. ${req.quantity}x ${req.vehicleType} (${req.vehicleSubtype}) @ ₹${req.pricePerTruck}`);
        });
        logger_service_1.logger.info(`╚══════════════════════════════════════════════════════════════╝`);
        // 1. Create the parent Order
        const order = {
            id: orderId,
            customerId: request.customerId,
            customerName: request.customerName,
            customerPhone: request.customerPhone,
            pickup: request.pickup,
            drop: request.drop,
            distanceKm: request.distanceKm,
            totalTrucks,
            trucksFilled: 0,
            totalAmount,
            goodsType: request.goodsType,
            cargoWeightKg: request.cargoWeightKg,
            status: 'active',
            scheduledAt: request.scheduledAt,
            expiresAt
        };
        db_1.db.createOrder(order);
        // 2. Create TruckRequests for each vehicle type
        const truckRequests = [];
        const responseRequests = [];
        let requestNumber = 1;
        for (const vehicleReq of request.vehicleRequirements) {
            // Create one TruckRequest per truck (not per type)
            // This allows each truck to be assigned independently
            for (let i = 0; i < vehicleReq.quantity; i++) {
                const truckRequestId = (0, uuid_1.v4)();
                const truckRequest = {
                    id: truckRequestId,
                    orderId,
                    requestNumber,
                    vehicleType: vehicleReq.vehicleType,
                    vehicleSubtype: vehicleReq.vehicleSubtype,
                    pricePerTruck: vehicleReq.pricePerTruck,
                    status: 'searching',
                    notifiedTransporters: []
                };
                truckRequests.push(truckRequest);
                requestNumber++;
            }
            // Find matching transporters for this vehicle type
            const matchingTransporters = db_1.db.getTransportersWithVehicleType(vehicleReq.vehicleType, vehicleReq.vehicleSubtype);
            responseRequests.push({
                id: truckRequests[truckRequests.length - 1].id,
                vehicleType: vehicleReq.vehicleType,
                vehicleSubtype: vehicleReq.vehicleSubtype,
                quantity: vehicleReq.quantity,
                pricePerTruck: vehicleReq.pricePerTruck,
                matchingTransporters: matchingTransporters.length
            });
        }
        // Batch create all truck requests
        db_1.db.createTruckRequestsBatch(truckRequests);
        // 3. Broadcast to matching transporters (per vehicle type)
        await this.broadcastToTransporters(orderId, request, truckRequests, expiresAt);
        // 4. Set expiry timer
        this.setOrderExpiryTimer(orderId, this.BROADCAST_TIMEOUT_MS);
        return {
            orderId,
            totalTrucks,
            totalAmount,
            truckRequests: responseRequests,
            expiresAt
        };
    }
    /**
     * Broadcast truck requests to matching transporters
     *
     * KEY: Each vehicle type goes ONLY to transporters with that type
     */
    async broadcastToTransporters(orderId, request, truckRequests, expiresAt) {
        // Group requests by vehicle type for efficient broadcasting
        const requestsByType = new Map();
        for (const tr of truckRequests) {
            const key = `${tr.vehicleType}_${tr.vehicleSubtype}`;
            if (!requestsByType.has(key)) {
                requestsByType.set(key, []);
            }
            requestsByType.get(key).push(tr);
        }
        // Broadcast each vehicle type to matching transporters (PARALLEL for speed)
        const broadcastPromises = [];
        for (const [typeKey, requests] of requestsByType) {
            const [vehicleType, vehicleSubtype] = typeKey.split('_');
            // Find transporters with this vehicle type (CACHED for speed)
            const matchingTransporters = await this.getTransportersByVehicleCached(vehicleType, vehicleSubtype);
            if (matchingTransporters.length === 0) {
                logger_service_1.logger.warn(`⚠️ No transporters found for ${vehicleType} (${vehicleSubtype})`);
                continue;
            }
            logger_service_1.logger.info(`📢 Broadcasting ${requests.length}x ${vehicleType} (${vehicleSubtype}) to ${matchingTransporters.length} transporters`);
            // Create broadcast data for this vehicle type
            // Send the FIRST request of this type (others are same type, just different trucks)
            const firstRequest = requests[0];
            const broadcastData = {
                type: 'new_truck_request',
                orderId,
                truckRequestId: firstRequest.id,
                requestNumber: firstRequest.requestNumber,
                customerName: request.customerName,
                pickup: {
                    latitude: request.pickup.latitude,
                    longitude: request.pickup.longitude,
                    address: request.pickup.address,
                    city: request.pickup.city
                },
                drop: {
                    latitude: request.drop.latitude,
                    longitude: request.drop.longitude,
                    address: request.drop.address,
                    city: request.drop.city
                },
                vehicleType,
                vehicleSubtype,
                pricePerTruck: firstRequest.pricePerTruck,
                distanceKm: request.distanceKm,
                goodsType: request.goodsType,
                expiresAt,
                createdAt: new Date().toISOString()
            };
            // Also include how many trucks of this type are needed
            const extendedBroadcast = {
                ...broadcastData,
                trucksNeededOfThisType: requests.length,
                totalTrucksInOrder: truckRequests.length
            };
            // WebSocket broadcast to all matching transporters (QUEUED for scalability)
            // For small batches (<50), send directly; for large batches, use queue
            if (matchingTransporters.length < 50) {
                // Direct send for small batches (faster)
                for (const transporterId of matchingTransporters) {
                    (0, socket_service_1.emitToUser)(transporterId, 'new_broadcast', extendedBroadcast);
                }
                logger_service_1.logger.info(`   📱 Direct broadcast to ${matchingTransporters.length} transporters`);
            }
            else {
                // Use queue for large batches (prevents blocking)
                await queue_service_1.queueService.queueBroadcastBatch(matchingTransporters, 'new_broadcast', extendedBroadcast);
                logger_service_1.logger.info(`   📱 Queued broadcast to ${matchingTransporters.length} transporters`);
            }
            // Update truck requests with notified transporters (batch update)
            const requestIds = requests.map(r => r.id);
            for (const tr of requests) {
                db_1.db.updateTruckRequest(tr.id, {
                    notifiedTransporters: matchingTransporters
                });
            }
            // FCM Push notifications (QUEUED for reliability)
            await queue_service_1.queueService.queuePushNotificationBatch(matchingTransporters, {
                title: `🚛 ${extendedBroadcast.trucksNeededOfThisType}x ${vehicleType.toUpperCase()} Required!`,
                body: `${extendedBroadcast.pickup.city || extendedBroadcast.pickup.address} → ${extendedBroadcast.drop.city || extendedBroadcast.drop.address}`,
                data: {
                    type: 'new_truck_request',
                    orderId: extendedBroadcast.orderId,
                    truckRequestId: extendedBroadcast.truckRequestId
                }
            });
        }
    }
    /**
     * Send push notifications asynchronously
     * Does not block the main flow
     */
    async sendPushNotificationsAsync(transporterIds, broadcastData) {
        try {
            const successCount = await (0, fcm_service_1.sendBatchPushNotifications)(transporterIds, {
                title: `🚛 ${broadcastData.trucksNeededOfThisType}x ${broadcastData.vehicleType.toUpperCase()} Required!`,
                body: `${broadcastData.pickup.city || broadcastData.pickup.address} → ${broadcastData.drop.city || broadcastData.drop.address} | ₹${broadcastData.pricePerTruck}/truck`,
                data: {
                    type: 'new_truck_request',
                    orderId: broadcastData.orderId,
                    truckRequestId: broadcastData.truckRequestId,
                    vehicleType: broadcastData.vehicleType
                }
            });
            logger_service_1.logger.info(`📱 FCM: Push notifications sent to ${successCount}/${transporterIds.length} transporters`);
        }
        catch (error) {
            logger_service_1.logger.error(`FCM batch send failed: ${error.message}`);
        }
    }
    /**
     * Set timer to expire order after timeout
     */
    setOrderExpiryTimer(orderId, timeoutMs) {
        // Clear existing timer if any
        if (this.orderTimers.has(orderId)) {
            clearTimeout(this.orderTimers.get(orderId));
        }
        const timer = setTimeout(() => {
            this.handleOrderExpiry(orderId);
        }, timeoutMs);
        this.orderTimers.set(orderId, timer);
        logger_service_1.logger.info(`⏱️ Order expiry timer set for ${orderId} (${timeoutMs / 1000}s)`);
    }
    /**
     * Handle order expiry
     * Mark unfilled truck requests as expired
     */
    async handleOrderExpiry(orderId) {
        logger_service_1.logger.info(`⏰ ORDER EXPIRED: ${orderId}`);
        const order = db_1.db.getOrderById(orderId);
        if (!order)
            return;
        // Only expire if not fully filled
        if (order.status === 'fully_filled' || order.status === 'completed') {
            return;
        }
        // Get all truck requests for this order
        const truckRequests = db_1.db.getTruckRequestsByOrder(orderId);
        const unfilled = truckRequests.filter(tr => tr.status === 'searching');
        if (unfilled.length > 0) {
            // Update unfilled requests to expired
            const unfilledIds = unfilled.map(tr => tr.id);
            db_1.db.updateTruckRequestsBatch(unfilledIds, { status: 'expired' });
            logger_service_1.logger.info(`   ${unfilled.length} truck requests expired`);
        }
        // Update order status
        const newStatus = order.trucksFilled > 0 ? 'partially_filled' : 'expired';
        db_1.db.updateOrder(orderId, { status: newStatus });
        // Notify customer
        (0, socket_service_1.emitToUser)(order.customerId, 'order_expired', {
            orderId,
            totalTrucks: order.totalTrucks,
            trucksFilled: order.trucksFilled,
            status: newStatus
        });
        // Cleanup timer
        this.orderTimers.delete(orderId);
    }
    /**
     * Accept a truck request (transporter assigns vehicle + driver)
     *
     * Called when transporter accepts from the Captain app
     */
    async acceptTruckRequest(truckRequestId, transporterId, vehicleId, driverId) {
        const truckRequest = db_1.db.getTruckRequestById(truckRequestId);
        if (!truckRequest) {
            return { success: false, message: 'Truck request not found' };
        }
        if (truckRequest.status !== 'searching') {
            return { success: false, message: `Request already ${truckRequest.status}` };
        }
        const order = db_1.db.getOrderById(truckRequest.orderId);
        if (!order) {
            return { success: false, message: 'Order not found' };
        }
        // Get details
        const transporter = db_1.db.getUserById(transporterId);
        const vehicle = db_1.db.getVehicleById(vehicleId);
        const driver = db_1.db.getUserById(driverId);
        if (!vehicle) {
            return { success: false, message: 'Vehicle not found' };
        }
        if (!driver) {
            return { success: false, message: 'Driver not found' };
        }
        // Verify vehicle type matches
        if (vehicle.vehicleType !== truckRequest.vehicleType) {
            return {
                success: false,
                message: `Vehicle type mismatch. Request requires ${truckRequest.vehicleType}, vehicle is ${vehicle.vehicleType}`
            };
        }
        const assignmentId = (0, uuid_1.v4)();
        const tripId = (0, uuid_1.v4)();
        const now = new Date().toISOString();
        // Update truck request
        db_1.db.updateTruckRequest(truckRequestId, {
            status: 'assigned',
            assignedTransporterId: transporterId,
            assignedTransporterName: transporter?.name || transporter?.businessName || '',
            assignedVehicleId: vehicleId,
            assignedVehicleNumber: vehicle.vehicleNumber,
            assignedDriverId: driverId,
            assignedDriverName: driver.name,
            assignedDriverPhone: driver.phone,
            tripId,
            assignedAt: now
        });
        // Create assignment record
        db_1.db.createAssignment({
            id: assignmentId,
            bookingId: truckRequest.orderId, // Legacy field
            truckRequestId,
            orderId: truckRequest.orderId,
            transporterId,
            transporterName: transporter?.name || '',
            vehicleId,
            vehicleNumber: vehicle.vehicleNumber,
            vehicleType: vehicle.vehicleType,
            vehicleSubtype: vehicle.vehicleSubtype,
            driverId,
            driverName: driver.name,
            driverPhone: driver.phone,
            tripId,
            status: 'pending',
            assignedAt: now
        });
        // Update order progress
        const newTrucksFilled = order.trucksFilled + 1;
        let newStatus = 'partially_filled';
        if (newTrucksFilled >= order.totalTrucks) {
            newStatus = 'fully_filled';
        }
        db_1.db.updateOrder(order.id, {
            trucksFilled: newTrucksFilled,
            status: newStatus
        });
        // Update vehicle status
        db_1.db.updateVehicle(vehicleId, {
            status: 'in_transit',
            currentTripId: tripId,
            assignedDriverId: driverId
        });
        logger_service_1.logger.info(`✅ Truck request ${truckRequestId} accepted`);
        logger_service_1.logger.info(`   Vehicle: ${vehicle.vehicleNumber} (${vehicle.vehicleType})`);
        logger_service_1.logger.info(`   Driver: ${driver.name} (${driver.phone})`);
        logger_service_1.logger.info(`   Order progress: ${newTrucksFilled}/${order.totalTrucks}`);
        // ============== NOTIFY DRIVER ==============
        const driverNotification = {
            type: 'trip_assigned',
            assignmentId,
            tripId,
            orderId: order.id,
            truckRequestId,
            pickup: order.pickup,
            drop: order.drop,
            vehicleNumber: vehicle.vehicleNumber,
            farePerTruck: truckRequest.pricePerTruck,
            distanceKm: order.distanceKm,
            customerName: order.customerName,
            customerPhone: order.customerPhone,
            assignedAt: now,
            message: `New trip assigned! ${order.pickup.address} → ${order.drop.address}`
        };
        (0, socket_service_1.emitToUser)(driverId, 'trip_assigned', driverNotification);
        logger_service_1.logger.info(`📢 Notified driver ${driver.name} about trip assignment`);
        // Push notification to driver
        (0, fcm_service_1.sendPushNotification)(driverId, {
            title: '🚛 New Trip Assigned!',
            body: `${order.pickup.city || order.pickup.address} → ${order.drop.city || order.drop.address}`,
            data: {
                type: 'trip_assigned',
                tripId,
                assignmentId,
                orderId: order.id
            }
        }).catch(err => logger_service_1.logger.warn(`FCM to driver failed: ${err.message}`));
        // ============== NOTIFY CUSTOMER ==============
        const customerNotification = {
            type: 'truck_confirmed',
            orderId: order.id,
            truckRequestId,
            assignmentId,
            truckNumber: newTrucksFilled,
            totalTrucks: order.totalTrucks,
            trucksConfirmed: newTrucksFilled,
            remainingTrucks: order.totalTrucks - newTrucksFilled,
            isFullyFilled: newTrucksFilled >= order.totalTrucks,
            driver: {
                name: driver.name,
                phone: driver.phone
            },
            vehicle: {
                number: vehicle.vehicleNumber,
                type: vehicle.vehicleType,
                subtype: vehicle.vehicleSubtype
            },
            transporter: {
                name: transporter?.name || transporter?.businessName || '',
                phone: transporter?.phone || ''
            },
            message: `Truck ${newTrucksFilled}/${order.totalTrucks} confirmed!`
        };
        (0, socket_service_1.emitToUser)(order.customerId, 'truck_confirmed', customerNotification);
        logger_service_1.logger.info(`📢 Notified customer - ${newTrucksFilled}/${order.totalTrucks} trucks confirmed`);
        // Push notification to customer
        (0, fcm_service_1.sendPushNotification)(order.customerId, {
            title: `🚛 Truck ${newTrucksFilled}/${order.totalTrucks} Confirmed!`,
            body: `${vehicle.vehicleNumber} (${driver.name}) assigned`,
            data: {
                type: 'truck_confirmed',
                orderId: order.id,
                trucksConfirmed: newTrucksFilled,
                totalTrucks: order.totalTrucks
            }
        }).catch(err => logger_service_1.logger.warn(`FCM to customer failed: ${err.message}`));
        // If fully filled, cancel expiry timer
        if (newStatus === 'fully_filled') {
            if (this.orderTimers.has(order.id)) {
                clearTimeout(this.orderTimers.get(order.id));
                this.orderTimers.delete(order.id);
            }
            logger_service_1.logger.info(`🎉 Order ${order.id} fully filled! All ${order.totalTrucks} trucks assigned.`);
        }
        return {
            success: true,
            assignmentId,
            tripId,
            message: `Successfully assigned. ${newTrucksFilled}/${order.totalTrucks} trucks filled.`
        };
    }
    /**
     * Get order details with all truck requests
     */
    getOrderDetails(orderId) {
        const order = db_1.db.getOrderById(orderId);
        if (!order)
            return null;
        const truckRequests = db_1.db.getTruckRequestsByOrder(orderId);
        return {
            ...order,
            truckRequests
        };
    }
    /**
     * Get active truck requests for a transporter
     * Returns ONLY requests matching their vehicle types
     */
    getActiveRequestsForTransporter(transporterId) {
        return db_1.db.getActiveTruckRequestsForTransporter(transporterId);
    }
    /**
     * Get orders by customer
     */
    getOrdersByCustomer(customerId) {
        return db_1.db.getOrdersByCustomer(customerId);
    }
}
// Export singleton
exports.orderService = new OrderService();
//# sourceMappingURL=order.service.js.map