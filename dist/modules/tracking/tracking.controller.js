"use strict";
/**
 * =============================================================================
 * TRACKING MODULE - CONTROLLER
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.trackingController = void 0;
const tracking_service_1 = require("./tracking.service");
const tracking_schema_1 = require("./tracking.schema");
const validation_utils_1 = require("../../shared/utils/validation.utils");
const api_types_1 = require("../../shared/types/api.types");
const error_middleware_1 = require("../../shared/middleware/error.middleware");
class TrackingController {
    /**
     * Update driver's current location
     */
    updateLocation = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const driverId = req.userId;
        const data = (0, validation_utils_1.validateSchema)(tracking_schema_1.updateLocationSchema, req.body);
        const tracking = await tracking_service_1.trackingService.updateLocation(driverId, data);
        res.json((0, api_types_1.successResponse)({ tracking }));
    });
    /**
     * Get current location for a trip
     */
    getCurrentLocation = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const { tripId } = req.params;
        const userId = req.userId;
        const userRole = req.userRole;
        const tracking = await tracking_service_1.trackingService.getCurrentLocation(tripId, userId, userRole);
        res.json((0, api_types_1.successResponse)({ tracking }));
    });
    /**
     * Get location history for a trip
     */
    getLocationHistory = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const { tripId } = req.params;
        const userId = req.userId;
        const userRole = req.userRole;
        const query = (0, validation_utils_1.validateSchema)(tracking_schema_1.locationHistoryQuerySchema, req.query);
        const history = await tracking_service_1.trackingService.getLocationHistory(tripId, userId, userRole, {
            ...query,
            limit: query.limit ?? 100
        });
        res.json((0, api_types_1.successResponse)({ history }));
    });
    /**
     * Get all driver locations for a booking (multi-truck view)
     */
    getBookingTracking = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const { bookingId } = req.params;
        const customerId = req.userId;
        const tracking = await tracking_service_1.trackingService.getBookingTracking(bookingId, customerId);
        res.json((0, api_types_1.successResponse)({ tracking }));
    });
}
exports.trackingController = new TrackingController();
//# sourceMappingURL=tracking.controller.js.map