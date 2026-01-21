/**
 * =============================================================================
 * BOOKING MODULE - VALIDATION SCHEMAS
 * =============================================================================
 * 
 * NEW ARCHITECTURE: Multi-Truck Request System
 * 
 * Order (Parent) → TruckRequests (Children)
 * 
 * Customer selects: 2x Open 17ft + 3x Container 4ton
 * System creates: 1 Order with 5 TruckRequests
 * Each TruckRequest is broadcast to matching transporters
 * =============================================================================
 */

import { z } from 'zod';
import { 
  locationSchema, 
  vehicleTypeSchema, 
  paginationSchema,
  bookingStatusSchema 
} from '../../shared/utils/validation.utils';

/**
 * Individual Truck Selection (from customer)
 */
export const truckSelectionSchema = z.object({
  vehicleType: vehicleTypeSchema,
  vehicleSubtype: z.string().min(2).max(50),
  quantity: z.number().int().min(1).max(20),
  pricePerTruck: z.number().int().min(1)
});

/**
 * Create Booking Schema (LEGACY - Single truck type)
 * Kept for backward compatibility
 */
export const createBookingSchema = z.object({
  pickup: locationSchema,
  drop: locationSchema,
  vehicleType: vehicleTypeSchema,
  vehicleSubtype: z.string().min(2).max(50),
  trucksNeeded: z.number().int().min(1).max(100),
  distanceKm: z.number().int().min(1),
  pricePerTruck: z.number().int().min(1),
  goodsType: z.string().max(100).optional(),
  weight: z.string().max(50).optional(),
  cargoWeightKg: z.number().int().min(0).max(100000).optional(),
  capacityInfo: z.object({
    capacityKg: z.number().int().optional(),
    capacityTons: z.number().optional(),
    minTonnage: z.number().optional(),
    maxTonnage: z.number().optional()
  }).optional(),
  scheduledAt: z.string().datetime().optional(),
  notes: z.string().max(500).optional()
});

/**
 * Create Order Schema (NEW - Multi-truck types)
 * 
 * This is the primary schema for creating bookings with multiple truck types.
 * Each truck selection expands into individual TruckRequests.
 */
export const createOrderSchema = z.object({
  pickup: locationSchema,
  drop: locationSchema,
  distanceKm: z.number().int().min(1),
  
  // Array of truck selections - each type/subtype with quantity
  trucks: z.array(truckSelectionSchema).min(1).max(50),
  
  // Goods info (applies to all trucks in order)
  goodsType: z.string().max(100).optional(),
  weight: z.string().max(50).optional(),
  cargoWeightKg: z.number().int().min(0).max(100000).optional(),
  
  // Scheduling
  scheduledAt: z.string().datetime().optional(),
  notes: z.string().max(500).optional()
});

/**
 * Get Bookings Query Schema
 */
export const getBookingsQuerySchema = paginationSchema.extend({
  status: bookingStatusSchema.optional()
});

/**
 * Get Order Query Schema
 */
export const getOrderQuerySchema = z.object({
  orderId: z.string().uuid()
});

// Type exports
export type TruckSelection = z.infer<typeof truckSelectionSchema>;
export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type GetBookingsQuery = z.infer<typeof getBookingsQuerySchema>;
