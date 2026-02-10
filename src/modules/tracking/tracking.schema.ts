/**
 * =============================================================================
 * TRACKING MODULE - VALIDATION SCHEMAS
 * =============================================================================
 * 
 * OFFLINE RESILIENCE:
 * ─────────────────────────────────────────────────────────────────────────────
 * Mobile networks are flaky. Driver app:
 * 1. Caches location points locally when offline (circular buffer)
 * 2. On reconnect, uploads batch of points with timestamps
 * 3. Backend handles out-of-order, stale, and duplicate data safely
 * 
 * KEY RULES:
 * - Always send timestamp from device (not server time)
 * - Batch uploads accepted up to MAX_BATCH_SIZE
 * - Points older than STALE_THRESHOLD go to history only, not live
 * - Unrealistic speed jumps are flagged/ignored
 * =============================================================================
 */

import { z } from 'zod';
import { paginationSchema } from '../../shared/utils/validation.utils';

// =============================================================================
// CONFIGURATION - Easy to adjust for production tuning
// =============================================================================

export const TRACKING_CONFIG = {
  /** Max points in a batch upload (prevents server overload) */
  MAX_BATCH_SIZE: 100,
  
  /** Points older than this (seconds) go to history only, not live location */
  STALE_THRESHOLD_SECONDS: 60,
  
  /** Max realistic speed in m/s (200 km/h = 55 m/s for trucks) */
  MAX_REALISTIC_SPEED_MS: 55,
  
  /** If gap > this between points, mark driver as UNKNOWN */
  OFFLINE_THRESHOLD_SECONDS: 120,
  
  /** Minimum time between points to accept (prevents spam) */
  MIN_INTERVAL_MS: 1000,
};

// =============================================================================
// SINGLE LOCATION UPDATE (Real-time mode)
// =============================================================================

/**
 * Update location request schema
 * 
 * SENT BY: Driver app every 5-10 seconds (real-time mode)
 * PAYLOAD SIZE: Keep minimal (~100 bytes) for efficient transmission
 */
export const updateLocationSchema = z.object({
  tripId: z.string().uuid(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  speed: z.number().min(0).max(200).optional().default(0),      // m/s
  bearing: z.number().min(0).max(360).optional().default(0),    // degrees
  accuracy: z.number().min(0).max(500).optional(),              // meters (GPS accuracy)
  timestamp: z.string().datetime().optional(),                   // Device timestamp (ISO)
}).strict();

// =============================================================================
// BATCH LOCATION UPLOAD (Offline sync mode)
// =============================================================================

/**
 * Single location point in a batch
 * 
 * IMPORTANT: timestamp is REQUIRED for batch - we need to know when each point was captured
 */
export const batchLocationPointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  speed: z.number().min(0).max(200).optional().default(0),
  bearing: z.number().min(0).max(360).optional().default(0),
  accuracy: z.number().min(0).max(500).optional(),
  timestamp: z.string().datetime(),  // REQUIRED for batch - when point was captured
});

/**
 * Batch location upload schema
 * 
 * SENT BY: Driver app after reconnecting from offline
 * USE CASE: Upload buffered points collected while offline
 * 
 * RULES:
 * - Max 100 points per batch (throttle server-side)
 * - Points must have timestamps
 * - Server processes in order, discards stale/duplicate
 */
export const batchLocationSchema = z.object({
  tripId: z.string().uuid(),
  points: z.array(batchLocationPointSchema)
    .min(1, 'At least 1 point required')
    .max(TRACKING_CONFIG.MAX_BATCH_SIZE, `Max ${TRACKING_CONFIG.MAX_BATCH_SIZE} points per batch`),
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

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;
export type GetTrackingQuery = z.infer<typeof getTrackingQuerySchema>;
export type BatchLocationPoint = z.infer<typeof batchLocationPointSchema>;
export type BatchLocationInput = z.infer<typeof batchLocationSchema>;

/**
 * Batch upload result - tells app what happened to each point
 */
export interface BatchUploadResult {
  tripId: string;
  processed: number;        // Total points processed
  accepted: number;         // Points that updated live/history
  stale: number;            // Points too old (added to history only)
  duplicate: number;        // Points with same/older timestamp (ignored)
  invalid: number;          // Points with unrealistic data (flagged)
  lastAcceptedTimestamp: string | null;  // Latest timestamp accepted
}

/**
 * Driver online status - used for fleet monitoring
 */
export type DriverOnlineStatus = 'ONLINE' | 'OFFLINE' | 'UNKNOWN';
