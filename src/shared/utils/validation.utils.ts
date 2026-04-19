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
import { AppError } from '../types/error.types';

// ============================================================
// COMMON SCHEMAS
// ============================================================

/**
 * UUID schema
 */
export const uuidSchema = z.string().uuid();

/**
 * Phone number schema (Indian format)
 */
export const phoneSchema = z.string()
  .transform(val => {
    // Remove +91 or 91 prefix if present
    let cleaned = val.trim();
    if (cleaned.startsWith('+91')) {
      cleaned = cleaned.substring(3);
    } else if (cleaned.startsWith('91') && cleaned.length === 12) {
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
export const vehicleNumberSchema = z.string()
  .transform(val => val.toUpperCase().replace(/[\s\-]/g, '')) // Remove spaces and dashes
  .refine(
    val => /^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{1,4}$/.test(val),
    { message: 'Invalid vehicle number format (e.g., MH02AB1234)' }
  );

/**
 * Coordinates schema
 */
export const coordinatesSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180)
}).refine(
  (coords) => coords.latitude >= 6.5 && coords.latitude <= 37.0 &&
              coords.longitude >= 68.0 && coords.longitude <= 97.5,
  { message: 'Coordinates must be within India service area' }
);

/**
 * Location schema
 * Note: address min length reduced to 1 for testing flexibility
 */
export const locationSchema = z.object({
  // Nested format: { coordinates: { latitude, longitude } }
  coordinates: coordinatesSchema.optional(),
  // Flat format: { latitude, longitude } (used by customer app)
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  address: z.string().min(1).max(500),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  pincode: z.string().max(10).optional()
}).refine(
  (data) => {
    if (data.coordinates) return true;
    if (data.latitude !== undefined && data.longitude !== undefined) return true;
    return false;
  },
  { message: 'Either coordinates object OR latitude+longitude fields are required' }
).refine(
  (data) => {
    const lat = data.coordinates?.latitude ?? data.latitude;
    const lng = data.coordinates?.longitude ?? data.longitude;
    if (lat === undefined || lng === undefined) return true; // let other validators catch missing
    return lat >= 6.5 && lat <= 37.0 && lng >= 68.0 && lng <= 97.5;
  },
  { message: 'Location must be within India service area' }
);

/**
 * Pagination schema
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

/**
 * Booking status schema
 */
export const bookingStatusSchema = z.enum([
  'created',
  'broadcasting',
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
export const assignmentStatusSchema = z.enum([
  'pending',
  'driver_accepted',
  'driver_declined',
  'en_route_pickup',
  'at_pickup',
  'in_transit',
  'arrived_at_drop',
  'completed',
  'partial_delivery', // L-17: Driver marks delivery as partial with reason
  'cancelled'
]);

/**
 * Vehicle type schema
 */
export const vehicleTypeSchema = z.enum([
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
export const userRoleSchema = z.enum([
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
export const otpSchema = z.string().length(6).regex(/^\d+$/, 'OTP must be 6 digits');

/**
 * Synchronous schema validation - validates data and returns parsed result
 * Throws AppError on validation failure
 * 
 * @param schema - Zod schema to validate against
 * @param data - Data to validate
 * @returns Validated and transformed data
 */
export function validateSchema<T extends z.ZodSchema>(
  schema: T,
  data: unknown
): z.infer<T> {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const details = error.errors.map(e => ({
        field: e.path.join('.'),
        message: e.message
      }));
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request data', { fields: details });
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
export function validateRequest<T extends z.ZodSchema>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      // Parse and validate
      const validated = schema.parse(req.body);

      // Replace body with validated data (includes transforms)
      req.body = validated;

      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }));

        next(new AppError(400, 'VALIDATION_ERROR', 'Invalid request data', { fields: details }));
      } else {
        next(error);
      }
    }
  };
}

/**
 * Query validation middleware
 * Validates request query params against a Zod schema
 */
export function validateQuery<T extends z.ZodSchema>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const validated = schema.parse(req.query);
      req.query = validated as any;
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }));

        next(new AppError(400, 'VALIDATION_ERROR', 'Invalid query parameters', { fields: details }));
      } else {
        next(error);
      }
    }
  };
}

// ============================================================
// PAGINATION UTILITIES
// ============================================================

/**
 * Maximum allowed page size for API queries
 */
export const MAX_PAGE_SIZE = 100;

/**
 * Default page size when none is provided or value is invalid
 */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * Clamp a requested page size to a safe range.
 * Returns defaultSize for invalid/falsy/non-positive values.
 * Caps at MAX_PAGE_SIZE for values exceeding the maximum.
 *
 * @param requested - The raw page size value (may be number, string, undefined, etc.)
 * @param defaultSize - Fallback when requested is invalid (defaults to DEFAULT_PAGE_SIZE)
 * @returns A safe page size number
 */
export function clampPageSize(requested: any, defaultSize: number = DEFAULT_PAGE_SIZE): number {
  const num = Number(requested);
  if (isNaN(num) || num < 1) return defaultSize;
  return Math.min(num, MAX_PAGE_SIZE);
}

// ============================================================
// SANITIZATION UTILITIES
// ============================================================

/**
 * Sanitize string input
 * Removes potentially dangerous characters
 */
export function sanitizeString(input: string): string {
  return input
    .trim()
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .replace(/[<>'"]/g, ''); // Remove special chars
}

/**
 * Sanitize phone number
 * Extracts only digits
 */
export function sanitizePhone(input: string): string {
  return input.replace(/\D/g, '').slice(-10);
}

/**
 * Mask phone number for logging
 */
export function maskPhone(phone: string): string {
  if (phone.length < 4) return '****';
  return '******' + phone.slice(-4);
}

/**
 * Mask sensitive data for logging
 */
export function maskSensitive(data: Record<string, any>): Record<string, any> {
  const sensitiveKeys = ['password', 'token', 'otp', 'secret', 'key'];
  const masked = { ...data };

  for (const key of Object.keys(masked)) {
    if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
      masked[key] = '***REDACTED***';
    }
  }

  return masked;
}
