"use strict";
/**
 * =============================================================================
 * AUTH MODULE - VALIDATION SCHEMAS
 * =============================================================================
 *
 * Zod schemas for validating auth requests.
 * These define the API contract for auth endpoints.
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshTokenSchema = exports.verifyOtpSchema = exports.sendOtpSchema = void 0;
const zod_1 = require("zod");
const validation_utils_1 = require("../../shared/utils/validation.utils");
/**
 * Send OTP request schema
 */
exports.sendOtpSchema = zod_1.z.object({
    phone: validation_utils_1.phoneSchema,
    role: validation_utils_1.userRoleSchema.default('customer')
}).strict(); // Reject unknown fields
/**
 * Verify OTP request schema
 */
exports.verifyOtpSchema = zod_1.z.object({
    phone: validation_utils_1.phoneSchema,
    otp: validation_utils_1.otpSchema,
    role: validation_utils_1.userRoleSchema.default('customer'),
    // Optional device info for multi-device support (nullable to handle app sending null)
    deviceId: zod_1.z.string().max(100).nullable().optional(),
    deviceName: zod_1.z.string().max(100).nullable().optional()
}).strict();
/**
 * Refresh token request schema
 */
exports.refreshTokenSchema = zod_1.z.object({
    refreshToken: zod_1.z.string().min(1, 'Refresh token is required')
}).strict();
//# sourceMappingURL=auth.schema.js.map