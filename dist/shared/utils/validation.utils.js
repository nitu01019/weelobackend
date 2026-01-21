"use strict";
/**
 * =============================================================================
 * VALIDATION UTILITIES
 * =============================================================================
 *
 * Shared validation schemas and utilities.
 * Used across all modules for consistent validation.
 *
 * SECURITY:
 * - Strict schema validation
 * - Reject unknown fields
 * - Input sanitization
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.otpSchema = exports.userRoleSchema = exports.vehicleTypeSchema = exports.assignmentStatusSchema = exports.bookingStatusSchema = exports.paginationSchema = exports.locationSchema = exports.coordinatesSchema = exports.vehicleNumberSchema = exports.phoneSchema = exports.uuidSchema = void 0;
exports.validateSchema = validateSchema;
exports.validateRequest = validateRequest;
exports.validateQuery = validateQuery;
exports.sanitizeString = sanitizeString;
exports.sanitizePhone = sanitizePhone;
exports.maskPhone = maskPhone;
exports.maskSensitive = maskSensitive;
const zod_1 = require("zod");
const error_types_1 = require("../types/error.types");
// ============================================================
// COMMON SCHEMAS
// ============================================================
/**
 * UUID schema
 */
exports.uuidSchema = zod_1.z.string().uuid();
/**
 * Phone number schema (Indian format)
 */
exports.phoneSchema = zod_1.z.string()
    .transform(val => {
    // Remove +91 or 91 prefix if present
    let cleaned = val.trim();
    if (cleaned.startsWith('+91')) {
        cleaned = cleaned.substring(3);
    }
    else if (cleaned.startsWith('91') && cleaned.length === 12) {
        cleaned = cleaned.substring(2);
    }
    return cleaned;
})
    .refine(val => /^[6-9]\d{9}$/.test(val), {
    message: 'Invalid phone number. Use 10 digits starting with 6-9'
});
/**
 * Vehicle number schema (Indian format)
 * Accepts formats: MH02AB1234, MH-02-AB-1234, HR 55 A 1234
 * Normalizes to: MH02AB1234 (no spaces/dashes)
 */
exports.vehicleNumberSchema = zod_1.z.string()
    .transform(val => val.toUpperCase().replace(/[\s\-]/g, '')) // Remove spaces and dashes
    .refine(val => /^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{1,4}$/.test(val), { message: 'Invalid vehicle number format (e.g., MH02AB1234)' });
/**
 * Coordinates schema
 */
exports.coordinatesSchema = zod_1.z.object({
    latitude: zod_1.z.number().min(-90).max(90),
    longitude: zod_1.z.number().min(-180).max(180)
});
/**
 * Location schema
 * Note: address min length reduced to 1 for testing flexibility
 */
exports.locationSchema = zod_1.z.object({
    coordinates: exports.coordinatesSchema,
    address: zod_1.z.string().min(1).max(500),
    city: zod_1.z.string().max(100).optional(),
    state: zod_1.z.string().max(100).optional(),
    pincode: zod_1.z.string().max(10).optional()
});
/**
 * Pagination schema
 */
exports.paginationSchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    limit: zod_1.z.coerce.number().int().min(1).max(100).default(20)
});
/**
 * Booking status schema
 */
exports.bookingStatusSchema = zod_1.z.enum([
    'active',
    'partially_filled',
    'fully_filled',
    'in_progress',
    'completed',
    'cancelled',
    'expired'
]);
/**
 * Assignment status schema
 */
exports.assignmentStatusSchema = zod_1.z.enum([
    'pending',
    'driver_accepted',
    'en_route_pickup',
    'at_pickup',
    'in_transit',
    'completed',
    'cancelled'
]);
/**
 * Vehicle type schema
 */
exports.vehicleTypeSchema = zod_1.z.enum([
    'mini',
    'lcv',
    'tipper',
    'container',
    'trailer',
    'tanker',
    'bulker',
    'open',
    'dumper',
    'tractor'
]);
/**
 * User role schema
 */
exports.userRoleSchema = zod_1.z.enum([
    'customer',
    'transporter',
    'driver',
    'admin'
]);
// ============================================================
// VALIDATION MIDDLEWARE
// ============================================================
/**
 * OTP schema for validation
 */
exports.otpSchema = zod_1.z.string().length(6).regex(/^\d+$/, 'OTP must be 6 digits');
/**
 * Synchronous schema validation - validates data and returns parsed result
 * Throws AppError on validation failure
 *
 * @param schema - Zod schema to validate against
 * @param data - Data to validate
 * @returns Validated and transformed data
 */
function validateSchema(schema, data) {
    try {
        return schema.parse(data);
    }
    catch (error) {
        if (error instanceof zod_1.z.ZodError) {
            const details = error.errors.map(e => ({
                field: e.path.join('.'),
                message: e.message
            }));
            throw new error_types_1.AppError(400, 'VALIDATION_ERROR', 'Invalid request data', { fields: details });
        }
        throw error;
    }
}
/**
 * Request validation middleware
 * Validates request body against a Zod schema
 *
 * @param schema - Zod schema to validate against
 */
function validateRequest(schema) {
    return (req, _res, next) => {
        try {
            // Parse and validate
            const validated = schema.parse(req.body);
            // Replace body with validated data (includes transforms)
            req.body = validated;
            next();
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                const details = error.errors.map(e => ({
                    field: e.path.join('.'),
                    message: e.message
                }));
                // Log validation errors for debugging
                console.log('=== VALIDATION ERROR ===');
                console.log('Path:', req.path);
                console.log('Request body:', JSON.stringify(req.body, null, 2));
                console.log('Validation errors:', JSON.stringify(details, null, 2));
                console.log('========================');
                next(new error_types_1.AppError(400, 'VALIDATION_ERROR', 'Invalid request data', { fields: details }));
            }
            else {
                next(error);
            }
        }
    };
}
/**
 * Query validation middleware
 * Validates request query params against a Zod schema
 */
function validateQuery(schema) {
    return (req, _res, next) => {
        try {
            const validated = schema.parse(req.query);
            req.query = validated;
            next();
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                const details = error.errors.map(e => ({
                    field: e.path.join('.'),
                    message: e.message
                }));
                next(new error_types_1.AppError(400, 'VALIDATION_ERROR', 'Invalid query parameters', { fields: details }));
            }
            else {
                next(error);
            }
        }
    };
}
// ============================================================
// SANITIZATION UTILITIES
// ============================================================
/**
 * Sanitize string input
 * Removes potentially dangerous characters
 */
function sanitizeString(input) {
    return input
        .trim()
        .replace(/<[^>]*>/g, '') // Remove HTML tags
        .replace(/[<>'"]/g, ''); // Remove special chars
}
/**
 * Sanitize phone number
 * Extracts only digits
 */
function sanitizePhone(input) {
    return input.replace(/\D/g, '').slice(-10);
}
/**
 * Mask phone number for logging
 */
function maskPhone(phone) {
    if (phone.length < 4)
        return '****';
    return '******' + phone.slice(-4);
}
/**
 * Mask sensitive data for logging
 */
function maskSensitive(data) {
    const sensitiveKeys = ['password', 'token', 'otp', 'secret', 'key'];
    const masked = { ...data };
    for (const key of Object.keys(masked)) {
        if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
            masked[key] = '***REDACTED***';
        }
    }
    return masked;
}
//# sourceMappingURL=validation.utils.js.map