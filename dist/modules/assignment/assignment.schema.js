"use strict";
/**
 * =============================================================================
 * ASSIGNMENT MODULE - VALIDATION SCHEMAS
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAssignmentsQuerySchema = exports.updateStatusSchema = exports.createAssignmentSchema = void 0;
const zod_1 = require("zod");
const validation_utils_1 = require("../../shared/utils/validation.utils");
/**
 * Create Assignment Schema (Transporter assigns truck)
 */
exports.createAssignmentSchema = zod_1.z.object({
    bookingId: zod_1.z.string().uuid(),
    vehicleId: zod_1.z.string().uuid(),
    driverId: zod_1.z.string().uuid()
}).strict();
/**
 * Update Status Schema
 */
exports.updateStatusSchema = zod_1.z.object({
    status: validation_utils_1.assignmentStatusSchema,
    notes: zod_1.z.string().max(500).optional(),
    location: zod_1.z.object({
        latitude: zod_1.z.number().min(-90).max(90),
        longitude: zod_1.z.number().min(-180).max(180)
    }).optional()
}).strict();
/**
 * Get Assignments Query Schema
 */
exports.getAssignmentsQuerySchema = validation_utils_1.paginationSchema.extend({
    status: validation_utils_1.assignmentStatusSchema.optional(),
    bookingId: zod_1.z.string().uuid().optional()
});
//# sourceMappingURL=assignment.schema.js.map