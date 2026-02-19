/**
 * =============================================================================
 * DRIVER MODULE - SCHEMA
 * =============================================================================
 * 
 * Zod validation schemas for driver-related API requests.
 * Ensures type safety and input validation.
 * =============================================================================
 */

import { z } from 'zod';

// =============================================================================
// REQUEST SCHEMAS
// =============================================================================

/**
 * Schema for updating driver availability
 */
export const updateAvailabilitySchema = z.object({
  isOnline: z.boolean({
    required_error: 'isOnline status is required',
    invalid_type_error: 'isOnline must be a boolean'
  }),
  currentLocation: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180)
  }).optional().nullable().transform(val => val ?? undefined)
});

/**
 * Schema for getting driver trips with filters
 */
export const getTripsQuerySchema = z.object({
  status: z.enum(['pending', 'active', 'completed', 'cancelled']).optional(),
  limit: z.string().transform(Number).pipe(z.number().int().min(1).max(100)).optional().default('20'),
  offset: z.string().transform(Number).pipe(z.number().int().min(0)).optional().default('0')
});

/**
 * Schema for getting earnings with period filter
 */
export const getEarningsQuerySchema = z.object({
  period: z.enum(['today', 'week', 'month', 'year']).optional().default('week')
});

/**
 * Schema for updating trip status by driver
 * 
 * @deprecated Use tripStatusUpdateSchema from tracking.schema.ts instead.
 *             The actual route is PUT /tracking/trip/:tripId/status
 *             with statuses: heading_to_pickup, at_pickup, loading_complete, in_transit, completed
 */
// Removed: updateTripStatusSchema — moved to tracking module (tracking.schema.ts)

/**
 * Schema for transporter creating a driver
 */
export const createDriverSchema = z.object({
  phone: z.string()
    .min(10, 'Phone must be at least 10 digits')
    .max(15, 'Phone must be at most 15 digits')
    .regex(/^[0-9+]+$/, 'Invalid phone number format'),
  name: z.string()
    .min(2, 'Name must be at least 2 characters')
    .max(100, 'Name must be at most 100 characters'),
  licenseNumber: z.string()
    .min(5, 'License number must be at least 5 characters')
    .max(25, 'License number must be at most 25 characters'),
  email: z.string().email('Invalid email').optional().nullable(),
  emergencyContact: z.string().max(15).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  aadharNumber: z.string().max(20).optional().nullable()
}).passthrough();

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type UpdateAvailabilityInput = z.infer<typeof updateAvailabilitySchema>;
export type GetTripsQuery = z.infer<typeof getTripsQuerySchema>;
export type GetEarningsQuery = z.infer<typeof getEarningsQuerySchema>;
// Removed: UpdateTripStatusInput — use TripStatusUpdateInput from tracking.schema.ts
export type CreateDriverInput = z.infer<typeof createDriverSchema>;
