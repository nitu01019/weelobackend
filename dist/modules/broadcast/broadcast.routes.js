"use strict";
/**
 * =============================================================================
 * BROADCAST MODULE - ROUTES
 * =============================================================================
 *
 * API routes for broadcast management (booking requests sent to drivers).
 *
 * FLOW:
 * 1. Customer creates booking → Backend creates broadcast
 * 2. Drivers see active broadcasts via GET /broadcasts/active
 * 3. Driver accepts → POST /broadcasts/:id/accept
 * 4. Driver declines → POST /broadcasts/:id/decline
 *
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.broadcastRouter = void 0;
const express_1 = require("express");
const broadcast_service_1 = require("./broadcast.service");
const auth_middleware_1 = require("../../shared/middleware/auth.middleware");
const router = (0, express_1.Router)();
exports.broadcastRouter = router;
/**
 * @route   GET /broadcasts/active
 * @desc    Get active broadcasts for driver/transporter
 * @access  Driver, Transporter
 * @query   driverId, vehicleType (optional), maxDistance (optional)
 */
router.get('/active', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['driver', 'transporter']), async (req, res, next) => {
    try {
        const { driverId, vehicleType, maxDistance } = req.query;
        const broadcasts = await broadcast_service_1.broadcastService.getActiveBroadcasts({
            driverId: driverId || req.user.userId,
            vehicleType: vehicleType,
            maxDistance: maxDistance ? parseFloat(maxDistance) : undefined
        });
        res.json({
            success: true,
            broadcasts,
            count: broadcasts.length
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /broadcasts/:broadcastId
 * @desc    Get broadcast details
 * @access  Driver, Transporter
 */
router.get('/:broadcastId', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['driver', 'transporter']), async (req, res, next) => {
    try {
        const broadcast = await broadcast_service_1.broadcastService.getBroadcastById(req.params.broadcastId);
        res.json({
            success: true,
            broadcast
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   POST /broadcasts/:broadcastId/accept
 * @desc    Accept a broadcast (driver accepts the trip)
 * @access  Driver, Transporter
 * @body    { driverId, vehicleId, estimatedArrival?, notes? }
 */
router.post('/:broadcastId/accept', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['driver', 'transporter']), async (req, res, next) => {
    try {
        const { driverId, vehicleId, estimatedArrival, notes } = req.body;
        const result = await broadcast_service_1.broadcastService.acceptBroadcast(req.params.broadcastId, {
            driverId: driverId || req.user.userId,
            vehicleId,
            estimatedArrival,
            notes
        });
        res.json({
            success: true,
            message: 'Broadcast accepted successfully',
            assignmentId: result.assignmentId,
            tripId: result.tripId,
            status: 'ASSIGNED'
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   POST /broadcasts/:broadcastId/decline
 * @desc    Decline a broadcast
 * @access  Driver, Transporter
 * @body    { driverId, reason, notes? }
 */
router.post('/:broadcastId/decline', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['driver', 'transporter']), async (req, res, next) => {
    try {
        const { driverId, reason, notes } = req.body;
        await broadcast_service_1.broadcastService.declineBroadcast(req.params.broadcastId, {
            driverId: driverId || req.user.userId,
            reason,
            notes
        });
        res.json({
            success: true,
            message: 'Broadcast declined'
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /broadcasts/history
 * @desc    Get broadcast history for driver
 * @access  Driver, Transporter
 * @query   driverId, page, limit, status
 */
router.get('/history', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['driver', 'transporter']), async (req, res, next) => {
    try {
        const { driverId, page = '1', limit = '20', status } = req.query;
        const result = await broadcast_service_1.broadcastService.getBroadcastHistory({
            driverId: driverId || req.user.userId,
            page: parseInt(page),
            limit: parseInt(limit),
            status: status
        });
        res.json({
            success: true,
            broadcasts: result.broadcasts,
            pagination: result.pagination
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   POST /broadcasts/create
 * @desc    Create broadcast (transporter only)
 * @access  Transporter
 */
router.post('/create', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const result = await broadcast_service_1.broadcastService.createBroadcast({
            ...req.body,
            transporterId: req.user.userId
        });
        res.status(201).json({
            success: true,
            broadcast: result.broadcast,
            notifiedDrivers: result.notifiedDrivers
        });
    }
    catch (error) {
        next(error);
    }
});
//# sourceMappingURL=broadcast.routes.js.map