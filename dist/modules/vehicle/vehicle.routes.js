"use strict";
/**
 * =============================================================================
 * VEHICLE MODULE - ROUTES
 * =============================================================================
 *
 * API routes for vehicle registration and management.
 * Transporters use these to register and manage their trucks.
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.vehicleRouter = void 0;
const express_1 = require("express");
const vehicle_service_1 = require("./vehicle.service");
const auth_middleware_1 = require("../../shared/middleware/auth.middleware");
const db_1 = require("../../shared/database/db");
const validation_utils_1 = require("../../shared/utils/validation.utils");
const vehicle_schema_1 = require("./vehicle.schema");
const router = (0, express_1.Router)();
exports.vehicleRouter = router;
/**
 * @route   POST /vehicles
 * @desc    Register a new vehicle
 * @access  Transporter only
 */
router.post('/', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const data = (0, validation_utils_1.validateSchema)(vehicle_schema_1.registerVehicleSchema, req.body);
        const vehicle = await vehicle_service_1.vehicleService.registerVehicle(req.user.userId, data);
        res.status(201).json({
            success: true,
            data: { vehicle },
            message: `Vehicle ${vehicle.vehicleNumber} registered successfully`
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /vehicles
 * @desc    Get transporter's vehicles with status counts
 * @access  Transporter only
 */
router.get('/', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const query = (0, validation_utils_1.validateSchema)(vehicle_schema_1.getVehiclesQuerySchema, req.query);
        const result = await vehicle_service_1.vehicleService.getTransporterVehicles(req.user.userId, query);
        res.json({
            success: true,
            data: {
                vehicles: result.vehicles,
                total: result.total,
                hasMore: result.hasMore,
                page: query.page,
                limit: query.limit,
                statusCounts: {
                    total: result.statusCounts.total || 0,
                    available: result.statusCounts.available || 0,
                    inTransit: result.statusCounts.in_transit || 0,
                    maintenance: result.statusCounts.maintenance || 0,
                    inactive: result.statusCounts.inactive || 0
                }
            }
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /vehicles/list
 * @desc    Get transporter's vehicles - Simple endpoint like driver/list
 * @access  Transporter only
 *
 * Response format (matches DriverListResponse):
 * {
 *   success: true,
 *   data: {
 *     vehicles: [...],
 *     total: 10,
 *     available: 5,
 *     inTransit: 3,
 *     maintenance: 2
 *   }
 * }
 */
router.get('/list', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const transporterId = req.user.userId;
        // Get all vehicles for this transporter directly from database
        const allVehicles = db_1.db.getVehiclesByTransporter(transporterId);
        // Filter only active vehicles
        const vehicles = allVehicles.filter(v => v.isActive);
        // Calculate counts
        // Note: Vehicles without status are considered 'available' (default state)
        const available = vehicles.filter(v => v.status === 'available' || !v.status).length;
        const inTransit = vehicles.filter(v => v.status === 'in_transit').length;
        const maintenance = vehicles.filter(v => v.status === 'maintenance').length;
        console.log(`[Vehicles] Returning ${vehicles.length} vehicles for transporter ${transporterId}`);
        // Normalize vehicles - ensure all have a status field (default to 'available')
        const normalizedVehicles = vehicles.map(v => ({
            ...v,
            status: v.status || 'available' // Default to 'available' if status is missing
        }));
        res.json({
            success: true,
            data: {
                vehicles: normalizedVehicles,
                total: normalizedVehicles.length,
                available: available,
                inTransit: inTransit,
                maintenance: maintenance
            }
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /vehicles/available
 * @desc    Get available vehicles (for assignment)
 * @access  Transporter only
 */
router.get('/available', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const vehicleType = req.query.vehicleType;
        const vehicles = await vehicle_service_1.vehicleService.getAvailableVehicles(req.user.userId, vehicleType);
        res.json({
            success: true,
            data: { vehicles }
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /vehicles/summary
 * @desc    Get vehicle types summary
 * @access  Transporter only
 */
router.get('/summary', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const summary = await vehicle_service_1.vehicleService.getVehicleTypesSummary(req.user.userId);
        res.json({
            success: true,
            data: { summary }
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /vehicles/types
 * @desc    Get available vehicle types (public)
 * @access  Public
 */
router.get('/types', async (_req, res, _next) => {
    // Static list of vehicle types
    const types = [
        { type: 'mini', name: 'Mini Truck', subtypes: ['Tata Ace', 'Mahindra Bolero', 'Ashok Leyland Dost'] },
        { type: 'lcv', name: 'LCV', subtypes: ['14 Feet', '17 Feet', '19 Feet'] },
        { type: 'tipper', name: 'Tipper', subtypes: ['10-12 Ton', '16-18 Ton', '20-24 Ton'] },
        { type: 'container', name: 'Container', subtypes: ['20 Feet', '24 Feet', '32 Feet', '40 Feet'] },
        { type: 'trailer', name: 'Trailer', subtypes: ['20 Feet', '22 Feet', '40 Feet'] },
        { type: 'tanker', name: 'Tanker', subtypes: ['10 KL', '12 KL', '16 KL', '20 KL'] },
        { type: 'bulker', name: 'Bulker', subtypes: ['22 MT', '25 MT', '30 MT', '35 MT'] },
        { type: 'open', name: 'Open Body', subtypes: ['14 Feet', '17 Feet', '19 Feet', '22 Feet'] },
        { type: 'dumper', name: 'Dumper', subtypes: ['10 Wheel', '12 Wheel', '14 Wheel'] },
        { type: 'tractor', name: 'Tractor Trolley', subtypes: ['Single Trolley', 'Double Trolley'] }
    ];
    res.json({
        success: true,
        data: { types }
    });
});
/**
 * @route   GET /vehicles/:vehicleId
 * @desc    Get vehicle details
 * @access  Transporter only (own vehicles)
 */
router.get('/:vehicleId', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const vehicle = await vehicle_service_1.vehicleService.getVehicleById(req.params.vehicleId);
        // Verify ownership
        if (vehicle.transporterId !== req.user.userId) {
            res.status(403).json({
                success: false,
                error: { code: 'FORBIDDEN', message: 'This vehicle does not belong to you' }
            });
            return;
        }
        res.json({
            success: true,
            data: { vehicle }
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   PUT /vehicles/:vehicleId
 * @desc    Update vehicle details
 * @access  Transporter only (own vehicles)
 */
router.put('/:vehicleId', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const data = (0, validation_utils_1.validateSchema)(vehicle_schema_1.updateVehicleSchema, req.body);
        const vehicle = await vehicle_service_1.vehicleService.updateVehicle(req.params.vehicleId, req.user.userId, data);
        res.json({
            success: true,
            data: { vehicle }
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   POST /vehicles/:vehicleId/assign-driver
 * @desc    Assign driver to vehicle
 * @access  Transporter only
 */
router.post('/:vehicleId/assign-driver', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const data = (0, validation_utils_1.validateSchema)(vehicle_schema_1.assignDriverSchema, req.body);
        const vehicle = await vehicle_service_1.vehicleService.assignDriver(req.params.vehicleId, req.user.userId, data.driverId);
        res.json({
            success: true,
            data: { vehicle },
            message: 'Driver assigned successfully'
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   POST /vehicles/:vehicleId/unassign-driver
 * @desc    Unassign driver from vehicle
 * @access  Transporter only
 */
router.post('/:vehicleId/unassign-driver', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const vehicle = await vehicle_service_1.vehicleService.unassignDriver(req.params.vehicleId, req.user.userId);
        res.json({
            success: true,
            data: { vehicle },
            message: 'Driver unassigned successfully'
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   DELETE /vehicles/:vehicleId
 * @desc    Delete vehicle
 * @access  Transporter only (own vehicles)
 */
router.delete('/:vehicleId', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        await vehicle_service_1.vehicleService.deleteVehicle(req.params.vehicleId, req.user.userId);
        res.json({
            success: true,
            message: 'Vehicle deleted successfully'
        });
    }
    catch (error) {
        next(error);
    }
});
// =============================================================================
// STATUS MANAGEMENT ENDPOINTS
// =============================================================================
/**
 * @route   PUT /vehicles/:vehicleId/status
 * @desc    Update vehicle status (available, in_transit, maintenance, inactive)
 * @access  Transporter only (own vehicles)
 */
router.put('/:vehicleId/status', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const data = (0, validation_utils_1.validateSchema)(vehicle_schema_1.updateStatusSchema, req.body);
        const vehicle = await vehicle_service_1.vehicleService.updateVehicleStatus(req.params.vehicleId, req.user.userId, data.status, {
            tripId: data.tripId,
            maintenanceReason: data.maintenanceReason,
            maintenanceEndDate: data.maintenanceEndDate
        });
        res.json({
            success: true,
            message: `Vehicle status updated to ${data.status}`,
            data: { vehicle }
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   PUT /vehicles/:vehicleId/maintenance
 * @desc    Put vehicle in maintenance mode
 * @access  Transporter only (own vehicles)
 */
router.put('/:vehicleId/maintenance', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const data = (0, validation_utils_1.validateSchema)(vehicle_schema_1.setMaintenanceSchema, req.body);
        const vehicle = await vehicle_service_1.vehicleService.setMaintenance(req.params.vehicleId, req.user.userId, data.reason, data.expectedEndDate);
        res.json({
            success: true,
            message: 'Vehicle set to maintenance mode',
            data: { vehicle }
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   PUT /vehicles/:vehicleId/available
 * @desc    Mark vehicle as available (ready for trips)
 * @access  Transporter only (own vehicles)
 */
router.put('/:vehicleId/available', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const vehicle = await vehicle_service_1.vehicleService.setAvailable(req.params.vehicleId, req.user.userId);
        res.json({
            success: true,
            message: 'Vehicle is now available for trips',
            data: { vehicle }
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /vehicles/available
 * @desc    Get all available vehicles for the transporter
 * @access  Transporter only
 */
router.get('/available', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const { vehicleType } = req.query;
        const vehicles = await vehicle_service_1.vehicleService.getAvailableVehicles(req.user.userId, vehicleType);
        res.json({
            success: true,
            data: {
                vehicles,
                total: vehicles.length
            }
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /vehicles/stats
 * @desc    Get vehicle status summary (counts by status)
 * @access  Transporter only
 */
router.get('/stats', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const result = await vehicle_service_1.vehicleService.getTransporterVehicles(req.user.userId, { page: 1, limit: 1000 } // Get all for stats
        );
        res.json({
            success: true,
            data: {
                statusCounts: result.statusCounts,
                total: result.total
            }
        });
    }
    catch (error) {
        next(error);
    }
});
//# sourceMappingURL=vehicle.routes.js.map