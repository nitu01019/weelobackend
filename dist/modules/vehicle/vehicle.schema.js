"use strict";
/**
 * =============================================================================
 * VEHICLE MODULE - VALIDATION SCHEMAS
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.pricingQuerySchema = exports.setMaintenanceSchema = exports.updateStatusSchema = exports.getVehiclesQuerySchema = exports.assignDriverSchema = exports.updateVehicleSchema = exports.registerVehicleSchema = exports.vehicleStatusSchema = void 0;
const zod_1 = require("zod");
const validation_utils_1 = require("../../shared/utils/validation.utils");
// Vehicle status enum for validation
exports.vehicleStatusSchema = zod_1.z.enum(['available', 'in_transit', 'maintenance', 'inactive']);
/**
 * Register Vehicle Schema
 * Note: transporterId comes from auth token, not request body
 * Using passthrough() to allow extra fields from mobile apps
 */
exports.registerVehicleSchema = zod_1.z.object({
    vehicleNumber: validation_utils_1.vehicleNumberSchema,
    vehicleType: validation_utils_1.vehicleTypeSchema,
    vehicleSubtype: zod_1.z.string().min(1).max(50),
    capacity: zod_1.z.string().min(1).max(20),
    model: zod_1.z.string().max(50).optional().nullable(),
    year: zod_1.z.number().int().min(1990).max(2030).optional().nullable(),
    // Documents (optional during registration, required for verification)
    rcNumber: zod_1.z.string().max(30).optional().nullable(),
    rcExpiry: zod_1.z.string().optional().nullable(),
    insuranceNumber: zod_1.z.string().max(50).optional().nullable(),
    insuranceExpiry: zod_1.z.string().optional().nullable(),
    permitNumber: zod_1.z.string().max(50).optional().nullable(),
    permitExpiry: zod_1.z.string().optional().nullable(),
    fitnessExpiry: zod_1.z.string().optional().nullable(),
    // Photos (URLs)
    vehiclePhotos: zod_1.z.array(zod_1.z.string().url()).optional().nullable(),
    rcPhoto: zod_1.z.string().url().optional().nullable(),
    insurancePhoto: zod_1.z.string().url().optional().nullable(),
    // Allow these fields from mobile apps (ignored, we use auth token)
    transporterId: zod_1.z.string().optional(),
    documents: zod_1.z.any().optional()
}).passthrough();
/**
 * Update Vehicle Schema
 */
exports.updateVehicleSchema = exports.registerVehicleSchema.partial();
/**
 * Assign Driver to Vehicle
 */
exports.assignDriverSchema = zod_1.z.object({
    driverId: zod_1.z.string().uuid()
}).strict();
/**
 * Get Vehicles Query
 */
exports.getVehiclesQuerySchema = validation_utils_1.paginationSchema.extend({
    vehicleType: validation_utils_1.vehicleTypeSchema.optional(),
    status: exports.vehicleStatusSchema.optional(),
    isActive: zod_1.z.coerce.boolean().optional()
});
/**
 * Update Vehicle Status Schema
 */
exports.updateStatusSchema = zod_1.z.object({
    status: exports.vehicleStatusSchema,
    tripId: zod_1.z.string().uuid().optional(),
    maintenanceReason: zod_1.z.string().max(200).optional(),
    maintenanceEndDate: zod_1.z.string().optional()
});
/**
 * Set Maintenance Schema
 */
exports.setMaintenanceSchema = zod_1.z.object({
    reason: zod_1.z.string().min(3).max(200),
    expectedEndDate: zod_1.z.string().optional()
});
/**
 * Pricing Query Schema
 */
exports.pricingQuerySchema = zod_1.z.object({
    vehicleType: validation_utils_1.vehicleTypeSchema,
    distanceKm: zod_1.z.coerce.number().int().min(1),
    trucksNeeded: zod_1.z.coerce.number().int().min(1).optional()
});
//# sourceMappingURL=vehicle.schema.js.map