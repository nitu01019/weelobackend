"use strict";
/**
 * =============================================================================
 * TRANSPORTER ROUTES - API for transporter operations
 * =============================================================================
 *
 * ENDPOINTS:
 * - PUT  /api/v1/transporter/availability   - Update online/offline status
 * - GET  /api/v1/transporter/availability   - Get current availability status
 * - GET  /api/v1/transporter/profile        - Get transporter profile
 * - PUT  /api/v1/transporter/profile        - Update transporter profile
 * - GET  /api/v1/transporter/stats          - Get transporter statistics
 *
 * AVAILABILITY FEATURE:
 * - When transporter is OFFLINE, they won't receive broadcasts
 * - Even if their vehicles match the request
 * - Used for breaks, end of day, etc.
 *
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_middleware_1 = require("../../shared/middleware/auth.middleware");
const db_1 = require("../../shared/database/db");
const logger_service_1 = require("../../shared/services/logger.service");
const cache_service_1 = require("../../shared/services/cache.service");
const router = (0, express_1.Router)();
// =============================================================================
// AVAILABILITY ENDPOINTS
// =============================================================================
/**
 * PUT /api/v1/transporter/availability
 * Update transporter's online/offline status
 *
 * Body: { isAvailable: boolean }
 */
router.put('/availability', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const user = req.user;
        const { isAvailable } = req.body;
        if (typeof isAvailable !== 'boolean') {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'isAvailable must be a boolean'
                }
            });
        }
        // Update in database
        db_1.db.updateUser(user.userId, {
            isAvailable,
            availabilityUpdatedAt: new Date().toISOString()
        });
        // Invalidate cache
        await cache_service_1.cacheService.delete(`user:${user.userId}`);
        // Invalidate transporter cache for all vehicle types they own
        const vehicles = db_1.db.getVehiclesByTransporter(user.userId);
        const vehicleTypes = new Set(vehicles.map(v => v.vehicleType));
        for (const type of vehicleTypes) {
            await cache_service_1.cacheService.delete(`trans:vehicle:${type}:*`);
        }
        logger_service_1.logger.info(`📢 Transporter ${user.userId} is now ${isAvailable ? 'ONLINE ✅' : 'OFFLINE ❌'}`);
        res.json({
            success: true,
            data: {
                isAvailable,
                updatedAt: new Date().toISOString()
            }
        });
    }
    catch (error) {
        logger_service_1.logger.error(`Update availability error: ${error.message}`);
        next(error);
    }
});
/**
 * GET /api/v1/transporter/availability
 * Get transporter's current availability status
 */
router.get('/availability', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const user = req.user;
        const transporter = db_1.db.getUserById(user.userId);
        if (!transporter) {
            return res.status(404).json({
                success: false,
                error: {
                    code: 'NOT_FOUND',
                    message: 'Transporter not found'
                }
            });
        }
        res.json({
            success: true,
            data: {
                isAvailable: transporter.isAvailable !== false, // Default to true
                updatedAt: transporter.availabilityUpdatedAt || transporter.updatedAt
            }
        });
    }
    catch (error) {
        logger_service_1.logger.error(`Get availability error: ${error.message}`);
        next(error);
    }
});
// =============================================================================
// PROFILE ENDPOINTS
// =============================================================================
/**
 * GET /api/v1/transporter/profile
 * Get transporter profile with stats
 */
router.get('/profile', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const user = req.user;
        const transporter = db_1.db.getUserById(user.userId);
        if (!transporter) {
            return res.status(404).json({
                success: false,
                error: {
                    code: 'NOT_FOUND',
                    message: 'Transporter not found'
                }
            });
        }
        // Get vehicles count
        const vehicles = db_1.db.getVehiclesByTransporter(user.userId);
        const drivers = db_1.db.getDriversByTransporter(user.userId);
        res.json({
            success: true,
            data: {
                profile: {
                    id: transporter.id,
                    name: transporter.name,
                    businessName: transporter.businessName,
                    phone: transporter.phone,
                    email: transporter.email,
                    gstNumber: transporter.gstNumber,
                    isAvailable: transporter.isAvailable !== false,
                    createdAt: transporter.createdAt
                },
                stats: {
                    vehiclesCount: vehicles.length,
                    driversCount: drivers.length,
                    availableVehicles: vehicles.filter(v => v.status === 'available').length,
                    activeTrips: vehicles.filter(v => v.status === 'in_transit').length
                }
            }
        });
    }
    catch (error) {
        logger_service_1.logger.error(`Get profile error: ${error.message}`);
        next(error);
    }
});
/**
 * PUT /api/v1/transporter/profile
 * Update transporter profile
 */
router.put('/profile', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const user = req.user;
        const { name, businessName, email, gstNumber } = req.body;
        const updates = {};
        if (name)
            updates.name = name;
        if (businessName)
            updates.businessName = businessName;
        if (email)
            updates.email = email;
        if (gstNumber)
            updates.gstNumber = gstNumber;
        db_1.db.updateUser(user.userId, updates);
        // Invalidate cache
        await cache_service_1.cacheService.delete(`user:${user.userId}`);
        const updated = db_1.db.getUserById(user.userId);
        logger_service_1.logger.info(`Transporter ${user.userId} profile updated`);
        res.json({
            success: true,
            data: {
                profile: {
                    id: updated?.id,
                    name: updated?.name,
                    businessName: updated?.businessName,
                    phone: updated?.phone,
                    email: updated?.email,
                    gstNumber: updated?.gstNumber
                }
            }
        });
    }
    catch (error) {
        logger_service_1.logger.error(`Update profile error: ${error.message}`);
        next(error);
    }
});
// =============================================================================
// STATS ENDPOINTS
// =============================================================================
/**
 * GET /api/v1/transporter/stats
 * Get transporter statistics (earnings, trips, etc.)
 */
router.get('/stats', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const user = req.user;
        // Get all assignments for this transporter
        const assignments = db_1.db.getAssignmentsByTransporter(user.userId);
        // Calculate stats
        const totalTrips = assignments.length;
        const completedTrips = assignments.filter(a => a.status === 'completed').length;
        const activeTrips = assignments.filter(a => a.status === 'in_progress' || a.status === 'pending').length;
        // TODO: Calculate actual earnings from completed trips
        const totalEarnings = completedTrips * 1500; // Placeholder
        res.json({
            success: true,
            data: {
                totalTrips,
                completedTrips,
                activeTrips,
                totalEarnings,
                rating: 4.5, // Placeholder
                acceptanceRate: totalTrips > 0 ? Math.round((completedTrips / totalTrips) * 100) : 100
            }
        });
    }
    catch (error) {
        logger_service_1.logger.error(`Get stats error: ${error.message}`);
        next(error);
    }
});
exports.default = router;
//# sourceMappingURL=transporter.routes.js.map