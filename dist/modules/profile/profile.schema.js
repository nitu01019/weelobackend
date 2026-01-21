"use strict";
/**
 * =============================================================================
 * PROFILE MODULE - VALIDATION SCHEMAS
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.addDriverSchema = exports.driverProfileSchema = exports.transporterProfileSchema = exports.customerProfileSchema = void 0;
const zod_1 = require("zod");
const validation_utils_1 = require("../../shared/utils/validation.utils");
/**
 * Create/Update Customer Profile
 */
exports.customerProfileSchema = zod_1.z.object({
    name: zod_1.z.string().min(2).max(100),
    email: zod_1.z.string().email().optional(),
    profilePhoto: zod_1.z.string().url().optional(),
    company: zod_1.z.string().max(200).optional(),
    gstNumber: zod_1.z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/).optional()
}).strict();
/**
 * Create/Update Transporter Profile
 * Accepts both 'company' and 'businessName' for flexibility
 */
exports.transporterProfileSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(100),
    email: zod_1.z.string().email().optional().nullable(),
    profilePhoto: zod_1.z.string().optional().nullable(),
    company: zod_1.z.string().max(200).optional().nullable(),
    businessName: zod_1.z.string().max(200).optional().nullable(),
    businessAddress: zod_1.z.string().max(500).optional().nullable(),
    address: zod_1.z.string().max(500).optional().nullable(),
    panNumber: zod_1.z.string().optional().nullable(),
    gstNumber: zod_1.z.string().optional().nullable(),
    city: zod_1.z.string().max(100).optional().nullable(),
    state: zod_1.z.string().max(100).optional().nullable()
});
/**
 * Create/Update Driver Profile
 */
exports.driverProfileSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(100),
    email: zod_1.z.string().email().optional().nullable(),
    profilePhoto: zod_1.z.string().optional().nullable(),
    licenseNumber: zod_1.z.string().max(20).optional().nullable(),
    licenseExpiry: zod_1.z.string().optional().nullable(),
    aadharNumber: zod_1.z.string().optional().nullable(),
    emergencyContact: zod_1.z.string().optional().nullable(),
    address: zod_1.z.string().optional().nullable()
});
/**
 * Add Driver (by Transporter)
 */
exports.addDriverSchema = zod_1.z.object({
    phone: validation_utils_1.phoneSchema,
    name: zod_1.z.string().min(2).max(100),
    licenseNumber: zod_1.z.string().min(5).max(20).optional(),
    licenseExpiry: zod_1.z.string().optional(),
    aadharNumber: zod_1.z.string().regex(/^[0-9]{12}$/).optional()
}).strict();
//# sourceMappingURL=profile.schema.js.map