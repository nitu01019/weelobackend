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
export const updateStatusSchema = z.object({
  status: assignmentStatusSchema,
  notes: z.string().max(500).optional(),
  location: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180)
  }).optional()
}).strict();

/**
 * Get Assignments Query Schema
 */
export const getAssignmentsQuerySchema = paginationSchema.extend({
  status: assignmentStatusSchema.optional(),
  bookingId: z.string().uuid().optional()
});

// Type exports
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;
export type UpdateStatusInput = z.infer<typeof updateStatusSchema>;
export type GetAssignmentsQuery = z.infer<typeof getAssignmentsQuerySchema>;
