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
 * 
 * =============================================================================
 * ROUTE POINTS (Intermediate Stops)
 * =============================================================================
 * 
 * IMPORTANT: Stops are defined BEFORE booking only!
 * - Customer enters: Pickup → Stop 1 → Stop 2 → Drop
 * - After booking: NO adding, removing, or reordering
 * - Route is IMMUTABLE after creation
 * 
 * WHY THIS MATTERS:
 * - Pricing is calculated upfront for entire route
 * - Single payment intent (no mid-trip recalculation)
 * - Driver sees full route before accepting
 * - Progress tracked via currentRouteIndex (0, 1, 2, 3...)
 * =============================================================================
 */

import { z } from 'zod';
import { 
  locationSchema, 
  coordinatesSchema,
  vehicleTypeSchema, 
  paginationSchema,
  bookingStatusSchema 
} from '../../shared/utils/validation.utils';

// =============================================================================
// ROUTE POINTS - For intermediate stops
// =============================================================================

/**
 * Route Point Type
 * - PICKUP: Starting point (always index 0)
 * - STOP: Intermediate stop (index 1 to N-1)
 * - DROP: Final destination (always last index)
 */
export const routePointTypeSchema = z.enum(['PICKUP', 'STOP', 'DROP']);

/**
 * Single Route Point
 * 
 * BACKEND DEVELOPER NOTE:
 * - routePoints array is IMMUTABLE after booking
 * - Max 4 points: 1 pickup + 2 stops + 1 drop
 * - Index is auto-assigned: 0=pickup, 1,2=stops, N=drop
 */
export const routePointSchema = z.object({
  type: routePointTypeSchema,
  coordinates: coordinatesSchema,
  address: z.string().min(1).max(500),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  stopIndex: z.number().int().min(0).max(3).optional()  // Auto-assigned if not provided
});

/**
 * Route Points Array
 * - Minimum 2 (pickup + drop)
 * - Maximum 4 (pickup + 2 stops + drop)
 */
export const routePointsSchema = z.array(routePointSchema)
  .min(2, 'At least pickup and drop required')
  .max(4, 'Maximum 2 intermediate stops allowed');

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
 * Create Order Schema (NEW - Multi-truck types with Route Points)
 * 
 * This is the primary schema for creating bookings with multiple truck types.
 * Each truck selection expands into individual TruckRequests.
 * 
 * ROUTE POINTS:
 * - Customer can add up to 2 intermediate stops
 * - If routePoints provided, pickup/drop are extracted from it
 * - If not provided, pickup/drop fields are used (backward compatible)
 * 
 * PRICING:
 * - Total distance calculated as sum of all legs (A→B + B→C + C→D)
 * - Per-stop fee may apply (configurable)
 * - Single payment for entire route
 */
export const createOrderSchema = z.object({
  // Option 1: Full route with stops (NEW - preferred)
  routePoints: routePointsSchema.optional(),
  
  // Option 2: Simple pickup/drop (LEGACY - backward compatible)
  pickup: locationSchema.optional(),
  drop: locationSchema.optional(),
  
  // Distance - total for all legs combined
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
}).refine(
  // Either routePoints OR (pickup AND drop) must be provided
  (data) => {
    if (data.routePoints && data.routePoints.length >= 2) return true;
    if (data.pickup && data.drop) return true;
    return false;
  },
  { message: 'Either routePoints OR both pickup and drop must be provided' }
);

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

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type RoutePointType = z.infer<typeof routePointTypeSchema>;
export type RoutePoint = z.infer<typeof routePointSchema>;
export type TruckSelection = z.infer<typeof truckSelectionSchema>;
export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type GetBookingsQuery = z.infer<typeof getBookingsQuerySchema>;

/**
 * Route Progress - Used for tracking driver's position through route
 */
export interface RouteProgress {
  currentRouteIndex: number;      // 0 = at pickup, 1 = at stop 1, etc.
  currentPointType: RoutePointType;
  nextPointType: RoutePointType | null;
  totalPoints: number;
  isCompleted: boolean;
}

/**
 * Stop Wait Timer - Track wait time at each stop
 */
export interface StopWaitTimer {
  stopIndex: number;
  arrivedAt: string;           // ISO datetime when driver arrived
  departedAt?: string;         // ISO datetime when driver left
  waitTimeSeconds: number;     // Calculated wait time
  freeWaitSeconds: number;     // Free wait time allowed (from config)
  extraChargeApplied: number;  // Extra charge if exceeded free wait
}

// =============================================================================
// ROUTE LEG - For ETA per leg calculation
// =============================================================================

/**
 * Single leg of a route (segment between two consecutive points)
 * 
 * EXAMPLE:
 * Leg 0: Delhi → Jaipur
 *   fromIndex: 0, toIndex: 1
 *   distanceKm: 270
 *   durationMinutes: 405 (6.75 hours)
 *   etaFromStartMinutes: 0 (departure)
 * 
 * BACKEND DEVELOPER NOTE:
 * - Legs are calculated automatically when order is created
 * - Use routingService.calculateRouteBreakdown() to generate
 * - Legs array has (routePoints.length - 1) elements
 */
export interface RouteLegInfo {
  /** Index of starting point (0, 1, 2...) */
  fromIndex: number;
  
  /** Index of ending point (1, 2, 3...) */
  toIndex: number;
  
  /** Type of starting point */
  fromType: 'PICKUP' | 'STOP' | 'DROP';
  
  /** Type of ending point */
  toType: 'PICKUP' | 'STOP' | 'DROP';
  
  /** Starting point address */
  fromAddress: string;
  
  /** Ending point address */
  toAddress: string;
  
  /** Starting point city */
  fromCity?: string;
  
  /** Ending point city */
  toCity?: string;
  
  /** Distance of this leg in km */
  distanceKm: number;
  
  /** Duration of this leg in minutes */
  durationMinutes: number;
  
  /** Duration formatted (e.g., "6 hrs 45 mins") */
  durationFormatted?: string;
  
  /** Cumulative time from trip start to reach END of this leg (minutes) */
  etaMinutes: number;
}

/**
 * Route Breakdown - Full route with all legs and totals
 * 
 * INCLUDED IN:
 * - Order response
 * - Broadcast to transporters
 * - Trip details for driver
 * - Tracking for customer
 * 
 * EXAMPLE:
 * {
 *   legs: [{ Delhi→Jaipur: 270km, 6.75hrs }, { Jaipur→Mumbai: 640km, 16hrs }],
 *   totalDistanceKm: 910,
 *   totalDurationMinutes: 1365,
 *   totalDurationFormatted: "22 hrs 45 mins"
 * }
 */
export interface RouteBreakdownInfo {
  /** Array of legs in order */
  legs: RouteLegInfo[];
  
  /** Total number of route points */
  totalPoints: number;
  
  /** Number of intermediate stops (excluding pickup & drop) */
  totalStops: number;
  
  /** Total distance across all legs (km) */
  totalDistanceKm: number;
  
  /** Total duration across all legs (minutes) */
  totalDurationMinutes: number;
  
  /** Total duration formatted (e.g., "22 hrs 45 mins") */
  totalDurationFormatted: string;
  
  /** Buffer time for all stops (minutes) */
  totalBufferMinutes: number;
  
  /** Grand total including buffer (minutes) */
  grandTotalMinutes: number;
  
  /** Estimated arrival at final drop (ISO string) */
  estimatedArrival?: string;
}
