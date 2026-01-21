/**
 * =============================================================================
 * PROFILE MODULE - VALIDATION SCHEMAS
 * =============================================================================
 */

import { z } from 'zod';
import { phoneSchema } from '../../shared/utils/validation.utils';

/**
 * Create/Update Customer Profile
 */
export const customerProfileSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email().optional(),
  profilePhoto: z.string().url().optional(),
  company: z.string().max(200).optional(),
  gstNumber: z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/).optional()
}).strict();

/**
 * Create/Update Transporter Profile
 * Accepts both 'company' and 'businessName' for flexibility
 */
export const transporterProfileSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().optional().nullable(),
  profilePhoto: z.string().optional().nullable(),
  company: z.string().max(200).optional().nullable(),
  businessName: z.string().max(200).optional().nullable(),
  businessAddress: z.string().max(500).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  panNumber: z.string().optional().nullable(),
  gstNumber: z.string().optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  state: z.string().max(100).optional().nullable()
});

/**
 * Create/Update Driver Profile
 */
export const driverProfileSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().optional().nullable(),
  profilePhoto: z.string().optional().nullable(),
  licenseNumber: z.string().max(20).optional().nullable(),
  licenseExpiry: z.string().optional().nullable(),
  aadharNumber: z.string().optional().nullable(),
  emergencyContact: z.string().optional().nullable(),
  address: z.string().optional().nullable()
});

/**
 * Add Driver (by Transporter)
 */
export const addDriverSchema = z.object({
  phone: phoneSchema,
  name: z.string().min(2).max(100),
  licenseNumber: z.string().min(5).max(20).optional(),
  licenseExpiry: z.string().optional(),
  aadharNumber: z.string().regex(/^[0-9]{12}$/).optional()
}).strict();

// Type exports
export type CustomerProfileInput = z.infer<typeof customerProfileSchema>;
export type TransporterProfileInput = z.infer<typeof transporterProfileSchema>;
export type DriverProfileInput = z.infer<typeof driverProfileSchema>;
export type AddDriverInput = z.infer<typeof addDriverSchema>;
