/**
 * =============================================================================
 * TRACKING MODULE - VALIDATION SCHEMAS
 * =============================================================================
 */

import { z } from 'zod';
import { paginationSchema } from '../../shared/utils/validation.utils';

/**
 * Update location request schema
 */
export const updateLocationSchema = z.object({
  tripId: z.string().uuid(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  speed: z.number().min(0).max(200).optional().default(0),
  bearing: z.number().min(0).max(360).optional().default(0)
}).strict();

/**
 * Get tracking query schema
 */
export const getTrackingQuerySchema = paginationSchema.extend({
  fromTime: z.string().datetime().optional(),
  toTime: z.string().datetime().optional()
});

/**
 * Location history query schema
 */
export const locationHistoryQuerySchema = paginationSchema.extend({
  fromTime: z.string().datetime().optional(),
  toTime: z.string().datetime().optional()
});

/**
 * Tracking response type
 */
export interface TrackingResponse {
  tripId: string;
  driverId: string;
  vehicleNumber: string;
  latitude: number;
  longitude: number;
  speed: number;
  bearing: number;
  status: string;
  lastUpdated: string;
}

/**
 * Booking tracking response (multiple trucks)
 */
export interface BookingTrackingResponse {
  bookingId: string;
  trucks: TrackingResponse[];
}

/**
 * Location history entry
 */
export interface LocationHistoryEntry {
  latitude: number;
  longitude: number;
  speed: number;
  timestamp: string;
}

/**
 * Type exports
 */
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;
export type GetTrackingQuery = z.infer<typeof getTrackingQuerySchema>;
