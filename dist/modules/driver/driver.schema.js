"use strict";
/**
 * =============================================================================
 * DRIVER MODULE - SCHEMA
 * =============================================================================
 *
 * Zod validation schemas for driver-related API requests.
 * Ensures type safety and input validation.
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDriverSchema = exports.updateTripStatusSchema = exports.getEarningsQuerySchema = exports.getTripsQuerySchema = exports.updateAvailabilitySchema = void 0;
const zod_1 = require("zod");
// =============================================================================
// REQUEST SCHEMAS
// =============================================================================
/**
 * Schema for updating driver availability
 */
exports.updateAvailabilitySchema = zod_1.z.object({
    body: zod_1.z.object({
        isOnline: zod_1.z.boolean({
            required_error: 'isOnline status is required',
            invalid_type_error: 'isOnline must be a boolean'
        }),
        currentLocation: zod_1.z.object({
            latitude: zod_1.z.number().min(-90).max(90),
            longitude: zod_1.z.number().min(-180).max(180)
        }).optional()
    })
});
/**
 * Schema for getting driver trips with filters
 */
exports.getTripsQuerySchema = zod_1.z.object({
    status: zod_1.z.enum(['pending', 'active', 'completed', 'cancelled']).optional(),
    limit: zod_1.z.string().transform(Number).pipe(zod_1.z.number().int().min(1).max(100)).optional().default('20'),
    offset: zod_1.z.string().transform(Number).pipe(zod_1.z.number().int().min(0)).optional().default('0')
});
/**
 * Schema for getting earnings with period filter
 */
exports.getEarningsQuerySchema = zod_1.z.object({
    period: zod_1.z.enum(['today', 'week', 'month', 'year']).optional().default('week')
});
/**
 * Schema for updating trip status by driver
 */
exports.updateTripStatusSchema = zod_1.z.object({
    body: zod_1.z.object({
        tripId: zod_1.z.string().uuid('Invalid trip ID'),
        status: zod_1.z.enum(['started', 'arrived_pickup', 'loaded', 'in_transit', 'arrived_drop', 'completed']),
        notes: zod_1.z.string().max(500).optional()
    })
});
/**
 * Schema for transporter creating a driver
 */
exports.createDriverSchema = zod_1.z.object({
    phone: zod_1.z.string()
        .min(10, 'Phone must be at least 10 digits')
        .max(15, 'Phone must be at most 15 digits')
        .regex(/^[0-9+]+$/, 'Invalid phone number format'),
    name: zod_1.z.string()
        .min(2, 'Name must be at least 2 characters')
        .max(100, 'Name must be at most 100 characters'),
    licenseNumber: zod_1.z.string()
        .min(5, 'License number must be at least 5 characters')
        .max(25, 'License number must be at most 25 characters'),
    email: zod_1.z.string().email('Invalid email').optional().nullable(),
    emergencyContact: zod_1.z.string().max(15).optional().nullable(),
    address: zod_1.z.string().max(500).optional().nullable(),
    aadharNumber: zod_1.z.string().max(20).optional().nullable()
}).passthrough();
//# sourceMappingURL=driver.schema.js.map