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
import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';
/**
 * UUID schema
 */
export declare const uuidSchema: z.ZodString;
/**
 * Phone number schema (Indian format)
 */
export declare const phoneSchema: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
/**
 * Vehicle number schema (Indian format)
 * Accepts formats: MH02AB1234, MH-02-AB-1234, HR 55 A 1234
 * Normalizes to: MH02AB1234 (no spaces/dashes)
 */
export declare const vehicleNumberSchema: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
/**
 * Coordinates schema
 */
export declare const coordinatesSchema: z.ZodObject<{
    latitude: z.ZodNumber;
    longitude: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    latitude: number;
    longitude: number;
}, {
    latitude: number;
    longitude: number;
}>;
/**
 * Location schema
 * Note: address min length reduced to 1 for testing flexibility
 */
export declare const locationSchema: z.ZodObject<{
    coordinates: z.ZodObject<{
        latitude: z.ZodNumber;
        longitude: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        latitude: number;
        longitude: number;
    }, {
        latitude: number;
        longitude: number;
    }>;
    address: z.ZodString;
    city: z.ZodOptional<z.ZodString>;
    state: z.ZodOptional<z.ZodString>;
    pincode: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    coordinates: {
        latitude: number;
        longitude: number;
    };
    address: string;
    city?: string | undefined;
    state?: string | undefined;
    pincode?: string | undefined;
}, {
    coordinates: {
        latitude: number;
        longitude: number;
    };
    address: string;
    city?: string | undefined;
    state?: string | undefined;
    pincode?: string | undefined;
}>;
/**
 * Pagination schema
 */
export declare const paginationSchema: z.ZodObject<{
    page: z.ZodDefault<z.ZodNumber>;
    limit: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    page: number;
}, {
    limit?: number | undefined;
    page?: number | undefined;
}>;
/**
 * Booking status schema
 */
export declare const bookingStatusSchema: z.ZodEnum<["active", "partially_filled", "fully_filled", "in_progress", "completed", "cancelled", "expired"]>;
/**
 * Assignment status schema
 */
export declare const assignmentStatusSchema: z.ZodEnum<["pending", "driver_accepted", "en_route_pickup", "at_pickup", "in_transit", "completed", "cancelled"]>;
/**
 * Vehicle type schema
 */
export declare const vehicleTypeSchema: z.ZodEnum<["mini", "lcv", "tipper", "container", "trailer", "tanker", "bulker", "open", "dumper", "tractor"]>;
/**
 * User role schema
 */
export declare const userRoleSchema: z.ZodEnum<["customer", "transporter", "driver", "admin"]>;
/**
 * OTP schema for validation
 */
export declare const otpSchema: z.ZodString;
/**
 * Synchronous schema validation - validates data and returns parsed result
 * Throws AppError on validation failure
 *
 * @param schema - Zod schema to validate against
 * @param data - Data to validate
 * @returns Validated and transformed data
 */
export declare function validateSchema<T extends z.ZodSchema>(schema: T, data: unknown): z.infer<T>;
/**
 * Request validation middleware
 * Validates request body against a Zod schema
 *
 * @param schema - Zod schema to validate against
 */
export declare function validateRequest<T extends z.ZodSchema>(schema: T): (req: Request, _res: Response, next: NextFunction) => void;
/**
 * Query validation middleware
 * Validates request query params against a Zod schema
 */
export declare function validateQuery<T extends z.ZodSchema>(schema: T): (req: Request, _res: Response, next: NextFunction) => void;
/**
 * Sanitize string input
 * Removes potentially dangerous characters
 */
export declare function sanitizeString(input: string): string;
/**
 * Sanitize phone number
 * Extracts only digits
 */
export declare function sanitizePhone(input: string): string;
/**
 * Mask phone number for logging
 */
export declare function maskPhone(phone: string): string;
/**
 * Mask sensitive data for logging
 */
export declare function maskSensitive(data: Record<string, any>): Record<string, any>;
//# sourceMappingURL=validation.utils.d.ts.map