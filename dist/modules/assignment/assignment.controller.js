"use strict";
/**
 * =============================================================================
 * ASSIGNMENT MODULE - CONTROLLER
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.assignmentController = void 0;
const assignment_service_1 = require("./assignment.service");
const assignment_schema_1 = require("./assignment.schema");
const validation_utils_1 = require("../../shared/utils/validation.utils");
const api_types_1 = require("../../shared/types/api.types");
const error_middleware_1 = require("../../shared/middleware/error.middleware");
class AssignmentController {
    /**
     * Create new assignment (Transporter assigns truck to booking)
     */
    createAssignment = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const transporterId = req.userId;
        const data = (0, validation_utils_1.validateSchema)(assignment_schema_1.createAssignmentSchema, req.body);
        const assignment = await assignment_service_1.assignmentService.createAssignment(transporterId, data);
        res.status(201).json((0, api_types_1.successResponse)({ assignment }));
    });
    /**
     * Get assignments (filtered by user role)
     */
    getAssignments = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const userId = req.userId;
        const userRole = req.userRole;
        const query = (0, validation_utils_1.validateSchema)(assignment_schema_1.getAssignmentsQuerySchema, req.query);
        const result = await assignment_service_1.assignmentService.getAssignments(userId, userRole, {
            ...query,
            page: query.page ?? 1,
            limit: query.limit ?? 20
        });
        res.json((0, api_types_1.successResponse)(result.assignments, {
            page: query.page ?? 1,
            limit: query.limit ?? 20,
            total: result.total,
            hasMore: result.hasMore
        }));
    });
    /**
     * Get driver's assignments
     */
    getDriverAssignments = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const driverId = req.userId;
        const query = (0, validation_utils_1.validateSchema)(assignment_schema_1.getAssignmentsQuerySchema, req.query);
        const result = await assignment_service_1.assignmentService.getDriverAssignments(driverId, {
            ...query,
            page: query.page ?? 1,
            limit: query.limit ?? 20
        });
        res.json((0, api_types_1.successResponse)(result.assignments, {
            page: query.page ?? 1,
            limit: query.limit ?? 20,
            total: result.total,
            hasMore: result.hasMore
        }));
    });
    /**
     * Get assignment by ID
     */
    getAssignmentById = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const { id } = req.params;
        const userId = req.userId;
        const userRole = req.userRole;
        const assignment = await assignment_service_1.assignmentService.getAssignmentById(id, userId, userRole);
        res.json((0, api_types_1.successResponse)({ assignment }));
    });
    /**
     * Driver accepts assignment
     */
    acceptAssignment = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const { id } = req.params;
        const driverId = req.userId;
        const assignment = await assignment_service_1.assignmentService.acceptAssignment(id, driverId);
        res.json((0, api_types_1.successResponse)({ assignment, message: 'Assignment accepted' }));
    });
    /**
     * Update assignment status
     */
    updateStatus = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const { id } = req.params;
        const driverId = req.userId;
        const data = (0, validation_utils_1.validateSchema)(assignment_schema_1.updateStatusSchema, req.body);
        const assignment = await assignment_service_1.assignmentService.updateStatus(id, driverId, data);
        res.json((0, api_types_1.successResponse)({ assignment }));
    });
    /**
     * Cancel assignment
     */
    cancelAssignment = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const { id } = req.params;
        const transporterId = req.userId;
        await assignment_service_1.assignmentService.cancelAssignment(id, transporterId);
        res.json((0, api_types_1.successResponse)({ message: 'Assignment cancelled' }));
    });
}
exports.assignmentController = new AssignmentController();
//# sourceMappingURL=assignment.controller.js.map