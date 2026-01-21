"use strict";
/**
 * =============================================================================
 * ASSIGNMENT MODULE - ROUTES
 * =============================================================================
 *
 * API routes for truck assignments.
 * Transporters create assignments, drivers accept/decline and update status.
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.assignmentRouter = void 0;
const express_1 = require("express");
const assignment_service_1 = require("./assignment.service");
const auth_middleware_1 = require("../../shared/middleware/auth.middleware");
const validation_utils_1 = require("../../shared/utils/validation.utils");
const assignment_schema_1 = require("./assignment.schema");
const router = (0, express_1.Router)();
exports.assignmentRouter = router;
/**
 * @route   POST /assignments
 * @desc    Create assignment (Transporter assigns truck to booking)
 * @access  Transporter only
 */
router.post('/', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), (0, validation_utils_1.validateRequest)(assignment_schema_1.createAssignmentSchema), async (req, res, next) => {
    try {
        const assignment = await assignment_service_1.assignmentService.createAssignment(req.user.userId, req.body);
        res.status(201).json({
            success: true,
            data: assignment
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /assignments
 * @desc    Get assignments (filtered by role)
 * @access  Transporter, Customer
 */
router.get('/', auth_middleware_1.authMiddleware, async (req, res, next) => {
    try {
        const query = assignment_schema_1.getAssignmentsQuerySchema.parse(req.query);
        const result = await assignment_service_1.assignmentService.getAssignments(req.user.userId, req.user.role, query);
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
 * @route   GET /assignments/driver
 * @desc    Get driver's assignments
 * @access  Driver only
 */
router.get('/driver', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['driver']), async (req, res, next) => {
    try {
        const query = assignment_schema_1.getAssignmentsQuerySchema.parse(req.query);
        const result = await assignment_service_1.assignmentService.getDriverAssignments(req.user.userId, query);
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
 * @route   GET /assignments/:id
 * @desc    Get assignment by ID
 * @access  Transporter (own), Driver (assigned), Customer (own booking)
 */
router.get('/:id', auth_middleware_1.authMiddleware, async (req, res, next) => {
    try {
        const assignment = await assignment_service_1.assignmentService.getAssignmentById(req.params.id, req.user.userId, req.user.role);
        res.json({
            success: true,
            data: assignment
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   PATCH /assignments/:id/accept
 * @desc    Accept assignment
 * @access  Driver only (assigned driver)
 */
router.patch('/:id/accept', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['driver']), async (req, res, next) => {
    try {
        const assignment = await assignment_service_1.assignmentService.acceptAssignment(req.params.id, req.user.userId);
        res.json({
            success: true,
            data: assignment
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   PATCH /assignments/:id/decline
 * @desc    Decline assignment
 * @access  Driver only (assigned driver)
 */
router.patch('/:id/decline', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['driver']), async (req, res, next) => {
    try {
        // For now, treat decline same as cancel from driver side
        // In production, this would trigger reassignment flow
        await assignment_service_1.assignmentService.cancelAssignment(req.params.id, req.user.userId);
        res.json({
            success: true,
            message: 'Assignment declined'
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   PATCH /assignments/:id/status
 * @desc    Update assignment status (trip progress)
 * @access  Driver only (assigned driver)
 */
router.patch('/:id/status', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['driver']), (0, validation_utils_1.validateRequest)(assignment_schema_1.updateStatusSchema), async (req, res, next) => {
    try {
        const assignment = await assignment_service_1.assignmentService.updateStatus(req.params.id, req.user.userId, req.body);
        res.json({
            success: true,
            data: assignment
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   DELETE /assignments/:id
 * @desc    Cancel assignment
 * @access  Transporter only (own assignments)
 */
router.delete('/:id', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        await assignment_service_1.assignmentService.cancelAssignment(req.params.id, req.user.userId);
        res.json({
            success: true,
            message: 'Assignment cancelled'
        });
    }
    catch (error) {
        next(error);
    }
});
//# sourceMappingURL=assignment.routes.js.map