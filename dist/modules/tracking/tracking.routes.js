"use strict";
/**
 * =============================================================================
 * TRACKING MODULE - ROUTES
 * =============================================================================
 *
 * API routes for real-time location tracking.
 * Drivers update location, customers/transporters view tracking.
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.trackingRouter = void 0;
const express_1 = require("express");
const tracking_service_1 = require("./tracking.service");
const auth_middleware_1 = require("../../shared/middleware/auth.middleware");
const validation_utils_1 = require("../../shared/utils/validation.utils");
const tracking_schema_1 = require("./tracking.schema");
const router = (0, express_1.Router)();
exports.trackingRouter = router;
/**
 * @route   POST /tracking/update
 * @desc    Update driver location
 * @access  Driver only
 */
router.post('/update', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['driver']), (0, validation_utils_1.validateRequest)(tracking_schema_1.updateLocationSchema), async (req, res, next) => {
    try {
        await tracking_service_1.trackingService.updateLocation(req.user.userId, req.body);
        res.json({
            success: true,
            message: 'Location updated'
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /tracking/:tripId
 * @desc    Get current location for a trip
 * @access  Customer (own booking), Transporter (own assignment), Driver (own trip)
 */
router.get('/:tripId', auth_middleware_1.authMiddleware, async (req, res, next) => {
    try {
        const tracking = await tracking_service_1.trackingService.getTripTracking(req.params.tripId, req.user.userId, req.user.role);
        res.json({
            success: true,
            data: tracking
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /tracking/booking/:bookingId
 * @desc    Get all truck locations for a booking (multi-truck view)
 * @access  Customer (own booking)
 */
router.get('/booking/:bookingId', auth_middleware_1.authMiddleware, async (req, res, next) => {
    try {
        const tracking = await tracking_service_1.trackingService.getBookingTracking(req.params.bookingId, req.user.userId, req.user.role);
        res.json({
            success: true,
            data: tracking
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /tracking/history/:tripId
 * @desc    Get location history for a trip
 * @access  Customer (own booking), Transporter (own assignment)
 */
router.get('/history/:tripId', auth_middleware_1.authMiddleware, async (req, res, next) => {
    try {
        const query = tracking_schema_1.getTrackingQuerySchema.parse(req.query);
        const history = await tracking_service_1.trackingService.getTripHistory(req.params.tripId, req.user.userId, req.user.role, query);
        res.json({
            success: true,
            data: history
        });
    }
    catch (error) {
        next(error);
    }
});
//# sourceMappingURL=tracking.routes.js.map