/**
 * =============================================================================
 * QUEUE PAYLOAD SCHEMAS
 * =============================================================================
 *
 * Zod schemas for every queue payload used in QueueService.QUEUES.
 * These are additive — existing callers are NOT modified.
 * Future refactors can import these for runtime validation.
 *
 * Derived from:
 *   - QueueService.QUEUES in queue.service.ts
 *   - Processor logic in queue.service.ts / queue-redis.service.ts
 *   - TrackingEventPayload in queue.types.ts
 * =============================================================================
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// BROADCAST queue payload (transporterId + event + arbitrary data)
// ---------------------------------------------------------------------------

export const BroadcastPayload = z.object({
  transporterId: z.string().min(1),
  event: z.string().min(1),
  data: z.record(z.unknown()).optional(),
});
export type BroadcastPayloadType = z.infer<typeof BroadcastPayload>;

// ---------------------------------------------------------------------------
// PUSH_NOTIFICATION queue payload
// ---------------------------------------------------------------------------

export const PushNotificationPayload = z.object({
  userId: z.string().min(1),
  notification: z.object({
    title: z.string(),
    body: z.string(),
    data: z.record(z.string()).optional(),
  }),
});
export type PushNotificationPayloadType = z.infer<typeof PushNotificationPayload>;

// ---------------------------------------------------------------------------
// FCM_BATCH queue payload (up to 500 tokens)
// ---------------------------------------------------------------------------

export const FcmBatchPayload = z.object({
  tokens: z.array(z.string().min(1)).min(1).max(500),
  notification: z.object({
    title: z.string(),
    body: z.string(),
    data: z.record(z.string()).optional(),
  }),
});
export type FcmBatchPayloadType = z.infer<typeof FcmBatchPayload>;

// ---------------------------------------------------------------------------
// TRACKING_EVENTS queue payload (mirrors TrackingEventPayload)
// ---------------------------------------------------------------------------

export const TrackingEventPayload = z.object({
  driverId: z.string().min(1),
  tripId: z.string().min(1),
  bookingId: z.string().optional(),
  orderId: z.string().optional(),
  latitude: z.number(),
  longitude: z.number(),
  speed: z.number(),
  bearing: z.number(),
  ts: z.string(),
  source: z.enum(['gps', 'batch_sync', 'system']),
});
export type TrackingEventPayloadType = z.infer<typeof TrackingEventPayload>;

// ---------------------------------------------------------------------------
// ASSIGNMENT_RECONCILIATION queue payload (empty — trigger-only)
// ---------------------------------------------------------------------------

export const AssignmentReconciliationPayload = z.object({}).passthrough();
export type AssignmentReconciliationPayloadType = z.infer<typeof AssignmentReconciliationPayload>;

// ---------------------------------------------------------------------------
// VEHICLE_RELEASE queue payload
// ---------------------------------------------------------------------------

export const VehicleReleasePayload = z.object({
  vehicleId: z.string().min(1),
  context: z.string().optional(),
});
export type VehicleReleasePayloadType = z.infer<typeof VehicleReleasePayload>;

// ---------------------------------------------------------------------------
// HOLD_EXPIRY queue payload
// ---------------------------------------------------------------------------

export const HoldExpiryPayload = z.object({
  holdId: z.string().min(1),
  orderId: z.string().optional(),
  reason: z.string().optional(),
});
export type HoldExpiryPayloadType = z.infer<typeof HoldExpiryPayload>;

// ---------------------------------------------------------------------------
// ASSIGNMENT TIMEOUT data (used by scheduleAssignmentTimeout)
// ---------------------------------------------------------------------------

export const AssignmentTimeoutPayload = z.object({
  assignmentId: z.string().min(1),
  driverId: z.string().min(1),
  driverName: z.string(),
  transporterId: z.string().min(1),
  vehicleId: z.string().min(1),
  vehicleNumber: z.string(),
  bookingId: z.string().optional(),
  tripId: z.string(),
  createdAt: z.string(),
  orderId: z.string().optional(),
  truckRequestId: z.string().optional(),
});
export type AssignmentTimeoutPayloadType = z.infer<typeof AssignmentTimeoutPayload>;
