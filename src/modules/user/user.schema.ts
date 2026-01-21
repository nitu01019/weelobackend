/**
 * =============================================================================
 * USER MODULE - VALIDATION SCHEMAS
 * =============================================================================
 */

import { z } from 'zod';

/**
 * Update profile request schema
 */
export const updateProfileSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  email: z.string().email().optional(),
  businessName: z.string().max(200).optional(),
  gstNumber: z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1}$/, 'Invalid GST number').optional(),
  address: z.string().max(500).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  profilePicture: z.string().url().optional()
}).strict();

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
