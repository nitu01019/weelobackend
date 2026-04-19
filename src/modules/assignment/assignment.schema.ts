/**
 * =============================================================================
 * ASSIGNMENT MODULE - VALIDATION SCHEMAS
 * =============================================================================
 */

import { z } from 'zod';
import { paginationSchema, assignmentStatusSchema } from '../../shared/utils/validation.utils';

/**
 * Create Assignment Schema (Transporter assigns truck)
 */
export const createAssignmentSchema = z.object({
  bookingId: z.string().uuid(),
  vehicleId: z.string().uuid(),
  driverId: z.string().uuid()
}).strict();

/**
 * Update Status Schema
 */
/**
 * L-17: Partial delivery reason codes.
 * Used when driver marks a delivery as partial instead of completed.
 */
export const partialReasonSchema = z.enum([
  'CUSTOMER_ABSENT',
  'WRONG_ADDRESS',
  'GOODS_DAMAGED',
  'PARTIAL_UNLOAD',
  'ACCESS_DENIED',
  'OTHER'
]);

export const updateStatusSchema = z.object({
  status: assignmentStatusSchema,
  notes: z.string().max(500).optional(),
  location: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180)
  }).optional(),
  // L-17: Partial delivery metadata (only relevant when status = 'partial_delivery')
  deliveryNotes: z.string().max(1000).optional(),
  partialReason: partialReasonSchema.optional()
}).strict();

/**
 * Get Assignments Query Schema
 */
export const getAssignmentsQuerySchema = paginationSchema.extend({
  status: assignmentStatusSchema.optional(),
  bookingId: z.string().uuid().optional()
});

/**
 * Decline Assignment Schema (Driver declines)
 */
export const declineAssignmentSchema = z.object({
  reason: z.string().max(500).optional(),
  reasonType: z.enum(['explicit', 'timeout', 'auto_system']).default('explicit'),
}).strict();

// Type exports
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;
export type UpdateStatusInput = z.infer<typeof updateStatusSchema>;
export type GetAssignmentsQuery = z.infer<typeof getAssignmentsQuerySchema>;
export type DeclineAssignmentInput = z.infer<typeof declineAssignmentSchema>;
