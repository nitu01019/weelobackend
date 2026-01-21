"use strict";
/**
 * =============================================================================
 * BOOKING MODULE - CONTROLLER
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.bookingController = void 0;
const booking_service_1 = require("./booking.service");
const booking_schema_1 = require("./booking.schema");
const validation_utils_1 = require("../../shared/utils/validation.utils");
const api_types_1 = require("../../shared/types/api.types");
const error_middleware_1 = require("../../shared/middleware/error.middleware");
class BookingController {
    /**
     * Create new booking broadcast
     */
    createBooking = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const userId = req.userId;
        const userPhone = req.userPhone;
        const data = (0, validation_utils_1.validateSchema)(booking_schema_1.createBookingSchema, req.body);
        const booking = await booking_service_1.bookingService.createBooking(userId, userPhone, data);
        res.status(201).json((0, api_types_1.successResponse)({ booking }));
    });
    /**
     * Get customer's bookings
     */
    getMyBookings = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const userId = req.userId;
        const query = (0, validation_utils_1.validateSchema)(booking_schema_1.getBookingsQuerySchema, req.query);
        const result = await booking_service_1.bookingService.getCustomerBookings(userId, {
            ...query,
            page: query.page ?? 1,
            limit: query.limit ?? 20
        });
        res.json((0, api_types_1.successResponse)(result.bookings, {
            page: query.page ?? 1,
            limit: query.limit ?? 20,
            total: result.total,
            hasMore: result.hasMore
        }));
    });
    /**
     * Get active broadcasts (for transporters)
     */
    getActiveBroadcasts = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const transporterId = req.userId;
        const query = (0, validation_utils_1.validateSchema)(booking_schema_1.getBookingsQuerySchema, req.query);
        const result = await booking_service_1.bookingService.getActiveBroadcasts(transporterId, {
            ...query,
            page: query.page ?? 1,
            limit: query.limit ?? 20
        });
        res.json((0, api_types_1.successResponse)(result.bookings, {
            page: query.page ?? 1,
            limit: query.limit ?? 20,
            total: result.total,
            hasMore: result.hasMore
        }));
    });
    /**
     * Get booking by ID
     */
    getBookingById = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const { id } = req.params;
        const userId = req.userId;
        const userRole = req.userRole;
        const booking = await booking_service_1.bookingService.getBookingById(id, userId, userRole);
        res.json((0, api_types_1.successResponse)({ booking }));
    });
    /**
     * Get assigned trucks for a booking
     */
    getAssignedTrucks = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const { id } = req.params;
        const userId = req.userId;
        const userRole = req.userRole;
        const trucks = await booking_service_1.bookingService.getAssignedTrucks(id, userId, userRole);
        res.json((0, api_types_1.successResponse)({ trucks }));
    });
    /**
     * Cancel booking
     */
    cancelBooking = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const { id } = req.params;
        const userId = req.userId;
        const booking = await booking_service_1.bookingService.cancelBooking(id, userId);
        res.json((0, api_types_1.successResponse)({ booking, message: 'Booking cancelled successfully' }));
    });
}
exports.bookingController = new BookingController();
//# sourceMappingURL=booking.controller.js.map