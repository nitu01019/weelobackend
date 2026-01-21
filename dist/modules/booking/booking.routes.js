"use strict";
/**
 * =============================================================================
 * BOOKING MODULE - ROUTES
 * =============================================================================
 *
 * API routes for booking/broadcast management.
 * All routes require authentication except where noted.
 *
 * NEW: Order System Routes (Multi-Truck Requests)
 * - POST /bookings/orders - Create order with multiple truck types
 * - GET /bookings/orders/:id - Get order with all truck requests
 * - GET /bookings/requests/active - Get active truck requests for transporter
 * - POST /bookings/requests/:id/accept - Accept a truck request
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.bookingRouter = void 0;
const express_1 = require("express");
const booking_service_1 = require("./booking.service");
const order_service_1 = require("./order.service");
const auth_middleware_1 = require("../../shared/middleware/auth.middleware");
const validation_utils_1 = require("../../shared/utils/validation.utils");
const booking_schema_1 = require("./booking.schema");
const router = (0, express_1.Router)();
exports.bookingRouter = router;
/**
 * @route   POST /bookings
 * @desc    Create new booking (broadcasts to transporters)
 * @access  Customer only
 */
router.post('/', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['customer']), (0, validation_utils_1.validateRequest)(booking_schema_1.createBookingSchema), async (req, res, next) => {
    try {
        const booking = await booking_service_1.bookingService.createBooking(req.user.userId, req.user.phone, req.body);
        res.status(201).json({
            success: true,
            data: { booking }
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /bookings
 * @desc    Get customer's bookings with pagination
 * @access  Customer only
 */
router.get('/', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['customer']), async (req, res, next) => {
    try {
        const query = booking_schema_1.getBookingsQuerySchema.parse(req.query);
        const result = await booking_service_1.bookingService.getCustomerBookings(req.user.userId, query);
        res.json({
            success: true,
            data: result
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /bookings/active
 * @desc    Get active broadcasts (for transporters to view and bid)
 * @access  Transporter only
 */
router.get('/active', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const query = booking_schema_1.getBookingsQuerySchema.parse(req.query);
        const result = await booking_service_1.bookingService.getActiveBroadcasts(req.user.userId, query);
        res.json({
            success: true,
            data: result
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /bookings/:id
 * @desc    Get booking details
 * @access  Customer (own bookings), Transporter (active bookings)
 */
router.get('/:id', auth_middleware_1.authMiddleware, async (req, res, next) => {
    try {
        const booking = await booking_service_1.bookingService.getBookingById(req.params.id, req.user.userId, req.user.role);
        res.json({
            success: true,
            data: { booking }
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /bookings/:id/trucks
 * @desc    Get trucks assigned to a booking
 * @access  Customer (own bookings), Transporter (own assignments)
 */
router.get('/:id/trucks', auth_middleware_1.authMiddleware, async (req, res, next) => {
    try {
        const trucks = await booking_service_1.bookingService.getAssignedTrucks(req.params.id, req.user.userId, req.user.role);
        res.json({
            success: true,
            data: { trucks }
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   PATCH /bookings/:id/cancel
 * @desc    Cancel a booking
 * @access  Customer only (own bookings)
 */
router.patch('/:id/cancel', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['customer']), async (req, res, next) => {
    try {
        const booking = await booking_service_1.bookingService.cancelBooking(req.params.id, req.user.userId);
        res.json({
            success: true,
            data: { booking }
        });
    }
    catch (error) {
        next(error);
    }
});
// =============================================================================
// NEW: ORDER SYSTEM ROUTES (Multi-Truck Requests)
// =============================================================================
/**
 * @route   POST /bookings/orders
 * @desc    Create new order with multiple truck types
 * @access  Customer only
 *
 * @body {
 *   pickup: { coordinates: { latitude, longitude }, address, city, state },
 *   drop: { coordinates: { latitude, longitude }, address, city, state },
 *   distanceKm: number,
 *   trucks: [
 *     { vehicleType: "open", vehicleSubtype: "17ft", quantity: 2, pricePerTruck: 15000 },
 *     { vehicleType: "container", vehicleSubtype: "4ton", quantity: 3, pricePerTruck: 20000 }
 *   ],
 *   goodsType?: string,
 *   weight?: string
 * }
 *
 * @response {
 *   order: OrderRecord,
 *   truckRequests: TruckRequestRecord[],
 *   broadcastSummary: { totalRequests, groupedBy, totalTransportersNotified },
 *   timeoutSeconds: number
 * }
 */
router.post('/orders', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['customer']), (0, validation_utils_1.validateRequest)(booking_schema_1.createOrderSchema), async (req, res, next) => {
    try {
        const result = await order_service_1.orderService.createOrder(req.user.userId, req.user.phone, req.body);
        res.status(201).json({
            success: true,
            data: result
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /bookings/orders
 * @desc    Get customer's orders with pagination
 * @access  Customer only
 */
router.get('/orders', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['customer']), async (req, res, next) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const result = await order_service_1.orderService.getCustomerOrders(req.user.userId, page, limit);
        res.json({
            success: true,
            data: result
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /bookings/orders/:id
 * @desc    Get order details with all truck requests
 * @access  Customer (own orders), Transporter (matching vehicle types)
 */
router.get('/orders/:id', auth_middleware_1.authMiddleware, async (req, res, next) => {
    try {
        const result = await order_service_1.orderService.getOrderWithRequests(req.params.id, req.user.userId, req.user.role);
        res.json({
            success: true,
            data: result
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /bookings/requests/active
 * @desc    Get active truck requests for transporter (only matching vehicle types)
 * @access  Transporter only
 *
 * Returns truck requests grouped by order, filtered to only show
 * requests that match the transporter's registered vehicle types.
 */
router.get('/requests/active', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const result = await order_service_1.orderService.getActiveTruckRequestsForTransporter(req.user.userId);
        res.json({
            success: true,
            data: {
                orders: result,
                count: result.length
            }
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   POST /bookings/requests/:id/accept
 * @desc    Accept a truck request (transporter assigns their truck)
 * @access  Transporter only
 *
 * @body {
 *   vehicleId: string,    // Which vehicle to assign
 *   driverId?: string     // Optional: assign specific driver
 * }
 */
router.post('/requests/:id/accept', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const { vehicleId, driverId } = req.body;
        if (!vehicleId) {
            return res.status(400).json({
                success: false,
                error: { code: 'VEHICLE_REQUIRED', message: 'vehicleId is required' }
            });
        }
        const request = await order_service_1.orderService.acceptTruckRequest(req.params.id, req.user.userId, vehicleId, driverId);
        res.json({
            success: true,
            data: { request }
        });
    }
    catch (error) {
        next(error);
    }
});
//# sourceMappingURL=booking.routes.js.map