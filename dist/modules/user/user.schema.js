"use strict";
/**
 * =============================================================================
 * USER MODULE - VALIDATION SCHEMAS
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateProfileSchema = void 0;
const zod_1 = require("zod");
/**
 * Update profile request schema
 */
exports.updateProfileSchema = zod_1.z.object({
    name: zod_1.z.string().min(2).max(100).optional(),
    email: zod_1.z.string().email().optional(),
    businessName: zod_1.z.string().max(200).optional(),
    gstNumber: zod_1.z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1}$/, 'Invalid GST number').optional(),
    address: zod_1.z.string().max(500).optional(),
    city: zod_1.z.string().max(100).optional(),
    state: zod_1.z.string().max(100).optional(),
    profilePicture: zod_1.z.string().url().optional()
}).strict();
//# sourceMappingURL=user.schema.js.map