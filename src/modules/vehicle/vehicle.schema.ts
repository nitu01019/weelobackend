/**
 * =============================================================================
 * VEHICLE MODULE - VALIDATION SCHEMAS
 * =============================================================================
 */

import { z } from 'zod';
import { vehicleNumberSchema, vehicleTypeSchema, paginationSchema } from '../../shared/utils/validation.utils';

// Vehicle status enum for validation
export const vehicleStatusSchema = z.enum(['available', 'in_transit', 'maintenance', 'inactive']);

/**
 * Register Vehicle Schema
 * Note: transporterId comes from auth token, not request body
 * Using passthrough() to allow extra fields from mobile apps
 */
export const registerVehicleSchema = z.object({
  vehicleNumber: vehicleNumberSchema,
  vehicleType: vehicleTypeSchema,
  vehicleSubtype: z.string().min(1).max(50),
  capacity: z.string().min(1).max(20),
  model: z.string().max(50).optional().nullable(),
  year: z.number().int().min(1990).max(2030).optional().nullable(),
  
  // Documents (optional during registration, required for verification)
  rcNumber: z.string().max(30).optional().nullable(),
  rcExpiry: z.string().optional().nullable(),
  insuranceNumber: z.string().max(50).optional().nullable(),
  insuranceExpiry: z.string().optional().nullable(),
  permitNumber: z.string().max(50).optional().nullable(),
  permitExpiry: z.string().optional().nullable(),
  fitnessExpiry: z.string().optional().nullable(),
  
  // Photos (URLs)
  vehiclePhotos: z.array(z.string().url()).optional().nullable(),
  rcPhoto: z.string().url().optional().nullable(),
  insurancePhoto: z.string().url().optional().nullable(),
  
  // Allow these fields from mobile apps (ignored, we use auth token)
  transporterId: z.string().optional(),
  documents: z.any().optional()
}).passthrough();

/**
 * Update Vehicle Schema
 */
export const updateVehicleSchema = registerVehicleSchema.partial();

/**
 * Assign Driver to Vehicle
 */
export const assignDriverSchema = z.object({
  driverId: z.string().uuid()
}).strict();

/**
 * Get Vehicles Query
 */
export const getVehiclesQuerySchema = paginationSchema.extend({
  vehicleType: vehicleTypeSchema.optional(),
  status: vehicleStatusSchema.optional(),
  isActive: z.coerce.boolean().optional()
});

/**
 * Update Vehicle Status Schema
 */
export const updateStatusSchema = z.object({
  status: vehicleStatusSchema,
  tripId: z.string().uuid().optional(),
  maintenanceReason: z.string().max(200).optional(),
  maintenanceEndDate: z.string().optional()
});

/**
 * Set Maintenance Schema
 */
export const setMaintenanceSchema = z.object({
  reason: z.string().min(3).max(200),
  expectedEndDate: z.string().optional()
});

/**
 * Pricing Query Schema
 */
export const pricingQuerySchema = z.object({
  vehicleType: vehicleTypeSchema,
  distanceKm: z.coerce.number().int().min(1),
  trucksNeeded: z.coerce.number().int().min(1).optional()
});

// Type exports
export type RegisterVehicleInput = z.infer<typeof registerVehicleSchema>;
export type UpdateVehicleInput = z.infer<typeof updateVehicleSchema>;
export type AssignDriverInput = z.infer<typeof assignDriverSchema>;
export type GetVehiclesQuery = z.infer<typeof getVehiclesQuerySchema>;
export type PricingQuery = z.infer<typeof pricingQuerySchema>;
