"use strict";
/**
 * =============================================================================
 * DRIVER AUTH MODULE - VALIDATION SCHEMAS
 * =============================================================================
 *
 * Zod schemas for driver authentication request validation.
 *
 * FLOW:
 * 1. Driver enters their phone number
 * 2. System finds which transporter this driver belongs to
 * 3. OTP is sent to TRANSPORTER's phone (not driver's)
 * 4. Driver gets OTP from transporter and enters it
 * 5. Driver gets authenticated
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyDriverOtpSchema = exports.sendDriverOtpSchema = void 0;
const zod_1 = require("zod");
/**
 * Schema for sending OTP to transporter for driver login
 * Driver provides their phone, OTP goes to their transporter
 */
exports.sendDriverOtpSchema = zod_1.z.object({
    body: zod_1.z.object({
        driverPhone: zod_1.z.string()
            .min(10, 'Phone number must be at least 10 digits')
            .max(15, 'Phone number too long')
            .regex(/^[0-9]+$/, 'Phone number must contain only digits'),
    }),
});
/**
 * Schema for verifying OTP and logging in driver
 */
exports.verifyDriverOtpSchema = zod_1.z.object({
    body: zod_1.z.object({
        driverPhone: zod_1.z.string()
            .min(10, 'Phone number must be at least 10 digits')
            .max(15, 'Phone number too long')
            .regex(/^[0-9]+$/, 'Phone number must contain only digits'),
        otp: zod_1.z.string()
            .length(6, 'OTP must be 6 digits')
            .regex(/^[0-9]+$/, 'OTP must contain only digits'),
    }),
});
//# sourceMappingURL=driver-auth.schema.js.map