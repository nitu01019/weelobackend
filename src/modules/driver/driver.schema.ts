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
 * W-5 E4-1b / B2 fix — Zod schema for POST /api/v1/transporter/heartbeat.
 *
 * The Captain app (Android) `NetworkClassifier.kt` emits Android-API telephony
 * labels: WIFI / NR / LTE / HSPA / EDGE / CELL / NONE / UNKNOWN. iOS / future
 * Captain builds are expected to emit canonical labels:
 * WIFI / 5G / 4G / 3G / 2G / UNKNOWN. The Zod enum below is the SUPERSET so
 * neither shape produces a 400; server-side `normalizeNetworkClass()` in
 * presence.config.ts collapses both forms to the canonical wire enum before
 * persistence and before any downstream consumer reads it.
 *
 * The field is `.nullable().optional()` so older app builds — which omit the
 * field entirely or send null — pass validation unchanged.
 *
 * The schema validates the wire shape only; coordinate range / vehicle
 * resolution / availability sync remain in the route handler so the existing
 * 503 / 400 contracts are preserved.
 *
 * NOTE: This widens, not narrows. No Captain build that was passing today can
 * fail tomorrow. The cellular cohort that 100%-rejected before this change
 * starts passing on deploy.
 */
export const heartbeatRequestSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  vehicleId: z.string().optional(),
  isOnTrip: z.boolean().optional(),
  networkClass: z.enum([
    // canonical wire form (iOS / future Captain / SSOT)
    'WIFI', '4G', '5G', '3G', '2G', 'UNKNOWN',
    // Captain Android telephony aliases (server normalises post-parse)
    'NR', 'LTE', 'HSPA', 'EDGE', 'CELL', 'NONE',
  ]).nullable().optional(),
}).passthrough();

export type HeartbeatRequestInput = z.infer<typeof heartbeatRequestSchema>;

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
