"use strict";
/**
 * =============================================================================
 * TRACKING MODULE - VALIDATION SCHEMAS
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.locationHistoryQuerySchema = exports.getTrackingQuerySchema = exports.updateLocationSchema = void 0;
const zod_1 = require("zod");
const validation_utils_1 = require("../../shared/utils/validation.utils");
/**
 * Update location request schema
 */
exports.updateLocationSchema = zod_1.z.object({
    tripId: zod_1.z.string().uuid(),
    latitude: zod_1.z.number().min(-90).max(90),
    longitude: zod_1.z.number().min(-180).max(180),
    speed: zod_1.z.number().min(0).max(200).optional().default(0),
    bearing: zod_1.z.number().min(0).max(360).optional().default(0)
}).strict();
/**
 * Get tracking query schema
 */
exports.getTrackingQuerySchema = validation_utils_1.paginationSchema.extend({
    fromTime: zod_1.z.string().datetime().optional(),
    toTime: zod_1.z.string().datetime().optional()
});
/**
 * Location history query schema
 */
exports.locationHistoryQuerySchema = validation_utils_1.paginationSchema.extend({
    fromTime: zod_1.z.string().datetime().optional(),
    toTime: zod_1.z.string().datetime().optional()
});
//# sourceMappingURL=tracking.schema.js.map