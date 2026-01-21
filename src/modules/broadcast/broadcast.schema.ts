/**
 * =============================================================================
 * BROADCAST MODULE - SCHEMA
 * =============================================================================
 * 
 * Zod validation schemas for broadcast-related API requests.
 * Broadcasts are booking notifications sent to available transporters/drivers.
 * =============================================================================
 */

import { z } from 'zod';

// =============================================================================
// REQUEST SCHEMAS
// =============================================================================

/**
 * Schema for getting broadcasts with filters
 */
export const getBroadcastsQuerySchema = z.object({
  status: z.enum(['pending', 'accepted', 'expired', 'cancelled']).optional(),
  vehicleType: z.string().optional(),
  limit: z.string().transform(Number).pipe(z.number().int().min(1).max(100)).optional().default('20'),
  offset: z.string().transform(Number).pipe(z.number().int().min(0)).optional().default('0')
});

/**
 * Schema for accepting a broadcast
 */
export const acceptBroadcastSchema = z.object({
  body: z.object({
    broadcastId: z.string().uuid('Invalid broadcast ID'),
    vehicleId: z.string().uuid('Invalid vehicle ID'),
    driverId: z.string().uuid('Invalid driver ID').optional(),
    estimatedArrival: z.number().int().min(5).max(480).optional() // Minutes, 5 min to 8 hours
  })
});

/**
 * Schema for rejecting a broadcast
 */
export const rejectBroadcastSchema = z.object({
  body: z.object({
    broadcastId: z.string().uuid('Invalid broadcast ID'),
    reason: z.enum([
      'no_vehicle_available',
      'too_far',
      'price_too_low',
      'schedule_conflict',
      'other'
    ]).optional(),
    notes: z.string().max(500).optional()
  })
});

/**
 * Schema for creating a broadcast (internal - from booking)
 */
export const createBroadcastSchema = z.object({
  body: z.object({
    bookingId: z.string().uuid('Invalid booking ID'),
    vehicleType: z.string().min(1, 'Vehicle type is required'),
    vehicleSubtype: z.string().optional(),
    pickup: z.object({
      address: z.string().min(1),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180)
    }),
    drop: z.object({
      address: z.string().min(1),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180)
    }),
    trucksNeeded: z.number().int().min(1).max(50),
    estimatedPrice: z.number().min(0),
    expiresAt: z.string().datetime().optional()
  })
});

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type GetBroadcastsQuery = z.infer<typeof getBroadcastsQuerySchema>;
export type AcceptBroadcastInput = z.infer<typeof acceptBroadcastSchema>['body'];
export type RejectBroadcastInput = z.infer<typeof rejectBroadcastSchema>['body'];
export type CreateBroadcastInput = z.infer<typeof createBroadcastSchema>['body'];
