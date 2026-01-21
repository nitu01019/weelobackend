"use strict";
/**
 * =============================================================================
 * DRIVER MODULE - ROUTES
 * =============================================================================
 *
 * API routes for driver-specific operations like dashboard and availability.
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.driverRouter = void 0;
const express_1 = require("express");
const auth_middleware_1 = require("../../shared/middleware/auth.middleware");
const validation_utils_1 = require("../../shared/utils/validation.utils");
const driver_service_1 = require("./driver.service");
const driver_schema_1 = require("./driver.schema");
const router = (0, express_1.Router)();
exports.driverRouter = router;
// =============================================================================
// TRANSPORTER - MANAGE DRIVERS
// =============================================================================
/**
 * POST /api/v1/driver/create
 * Transporter creates a new driver under their account
 */
router.post('/create', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const data = (0, validation_utils_1.validateSchema)(driver_schema_1.createDriverSchema, req.body);
        const transporterId = req.user.userId;
        const driver = await driver_service_1.driverService.createDriver(transporterId, data);
        res.status(201).json({
            success: true,
            data: { driver },
            message: `Driver ${driver.name} added successfully`
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * GET /api/v1/driver/list
 * Transporter gets all their drivers
 */
router.get('/list', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const transporterId = req.user.userId;
        const result = await driver_service_1.driverService.getTransporterDrivers(transporterId);
        res.json({
            success: true,
            data: result
        });
    }
    catch (error) {
        next(error);
    }
});
// =============================================================================
// DRIVER DASHBOARD
// =============================================================================
/**
 * GET /api/v1/driver/dashboard
 * Get driver dashboard with stats, recent trips, and earnings
 */
router.get('/dashboard', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['driver', 'transporter']), async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const dashboard = await driver_service_1.driverService.getDashboard(userId);
        res.json({
            success: true,
            data: dashboard
        });
    }
    catch (error) {
        next(error);
    }
});
// =============================================================================
// DRIVER AVAILABILITY
// =============================================================================
/**
 * GET /api/v1/driver/availability
 * Get current driver availability status
 */
router.get('/availability', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['driver', 'transporter']), async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const availability = await driver_service_1.driverService.getAvailability(userId);
        res.json({
            success: true,
            data: availability
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * PUT /api/v1/driver/availability
 * Update driver availability status
 */
router.put('/availability', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['driver', 'transporter']), (0, validation_utils_1.validateRequest)(driver_schema_1.updateAvailabilitySchema), async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const { isOnline, currentLocation } = req.body;
        const availability = await driver_service_1.driverService.updateAvailability(userId, {
            isOnline,
            currentLocation
        });
        res.json({
            success: true,
            message: isOnline ? 'You are now online' : 'You are now offline',
            data: availability
        });
    }
    catch (error) {
        next(error);
    }
});
// =============================================================================
// DRIVER EARNINGS
// =============================================================================
/**
 * GET /api/v1/driver/earnings
 * Get driver earnings summary
 */
router.get('/earnings', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['driver', 'transporter']), async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const query = driver_schema_1.getEarningsQuerySchema.parse(req.query);
        const earnings = await driver_service_1.driverService.getEarnings(userId, query.period);
        res.json({
            success: true,
            data: earnings
        });
    }
    catch (error) {
        next(error);
    }
});
// =============================================================================
// DRIVER TRIPS/BOOKINGS
// =============================================================================
/**
 * GET /api/v1/driver/trips
 * Get driver's trip history
 */
router.get('/trips', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['driver', 'transporter']), async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const { status, limit = 20, offset = 0 } = req.query;
        const trips = await driver_service_1.driverService.getTrips(userId, {
            status: status,
            limit: Number(limit),
            offset: Number(offset)
        });
        res.json({
            success: true,
            data: trips
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * GET /api/v1/driver/trips/active
 * Get driver's currently active trip
 */
router.get('/trips/active', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['driver', 'transporter']), async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const activeTrip = await driver_service_1.driverService.getActiveTrip(userId);
        res.json({
            success: true,
            data: activeTrip
        });
    }
    catch (error) {
        next(error);
    }
});
//# sourceMappingURL=driver.routes.js.map