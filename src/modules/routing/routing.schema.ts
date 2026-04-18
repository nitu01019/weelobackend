/**
 * =============================================================================
 * ROUTING MODULE - SCHEMAS & TYPES
 * =============================================================================
 * 
 * Defines data structures for route calculations.
 * 
 * KEY CONCEPTS:
 * - RouteLeg: Single segment between two consecutive points (A → B)
 * - RouteBreakdown: Full route with all legs and totals
 * - ETA: Estimated Time of Arrival based on average truck speed
 * 
 * EXAMPLE:
 * Route: Delhi → Jaipur → Mumbai
 * 
 * Legs:
 *   Leg 0: Delhi → Jaipur   (270 km, 6.75 hrs)
 *   Leg 1: Jaipur → Mumbai  (640 km, 16 hrs)
 * 
 * Total: 910 km, 22.75 hrs
 * =============================================================================
 */

import { z } from 'zod';

// =============================================================================
// CONFIGURATION - Easy to tune for production
// =============================================================================

export const ROUTING_CONFIG = {
  /**
   * Average truck speed in km/h
   * 
   * REASONING:
   * - Highway speed: 60-80 km/h
   * - City/traffic: 20-30 km/h
   * - Rest stops, loading: reduces effective speed
   * - Conservative estimate: 40 km/h average
   * 
   * Can be made dynamic based on:
   * - Time of day (night = faster)
   * - Route type (highway vs city)
   * - Vehicle type (lighter = faster)
   */
  AVERAGE_SPEED_KMH: 40,
  
  /**
   * Road distance multiplier
   * 
   * Haversine gives straight-line distance.
   * Roads are typically 20-30% longer due to curves.
   * 
   * 1.25 = roads are 25% longer than straight line
   */
  ROAD_DISTANCE_MULTIPLIER: 1.25,
  
  /**
   * Buffer time per stop (in minutes)
   * 
   * Time for:
   * - Loading/unloading at intermediate stops
   * - Paperwork, verification
   * - Parking, maneuvering
   */
  BUFFER_TIME_PER_STOP_MINUTES: 30,
  
  /**
   * Earth's radius in km (for Haversine formula)
   */
  EARTH_RADIUS_KM: 6371,
};

// =============================================================================
// ROUTE POINT (Input)
// =============================================================================

/**
 * Coordinates for a point
 */
export const coordinatesSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

/**
 * Route point with type
 */
export const routePointInputSchema = z.object({
  type: z.enum(['PICKUP', 'STOP', 'DROP']),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  address: z.string().optional(),
  city: z.string().optional(),
  stopIndex: z.number().int().min(0).optional(),
});

// =============================================================================
// ROUTE LEG (Output)
// =============================================================================

/**
 * Single leg of a route (segment between two points)
 * 
 * EXAMPLE:
 * Leg 0: Delhi → Jaipur
 *   fromIndex: 0
 *   toIndex: 1
 *   fromType: PICKUP
 *   toType: STOP
 *   distanceKm: 270
 *   durationMinutes: 405 (6.75 hours)
 *   etaFromStart: 0 (departure)
 */
export interface RouteLeg {
  /** Index of starting point (0, 1, 2...) */
  fromIndex: number;
  
  /** Index of ending point (1, 2, 3...) */
  toIndex: number;
  
  /** Type of starting point */
  fromType: 'PICKUP' | 'STOP' | 'DROP';
  
  /** Type of ending point */
  toType: 'PICKUP' | 'STOP' | 'DROP';
  
  /** Starting point address (for display) */
  fromAddress: string;
  
  /** Ending point address (for display) */
  toAddress: string;
  
  /** Starting point city */
  fromCity?: string;
  
  /** Ending point city */
  toCity?: string;
  
  /** Distance of this leg in km */
  distanceKm: number;
  
  /** Duration of this leg in minutes */
  durationMinutes: number;
  
  /** Cumulative time from trip start to reach START of this leg (minutes) */
  etaFromStartMinutes: number;
  
  /** Cumulative time from trip start to reach END of this leg (minutes) */
  etaToEndMinutes: number;
}

// =============================================================================
// ROUTE BREAKDOWN (Full Output)
// =============================================================================

/**
 * Complete route breakdown with all legs and totals
 * 
 * USAGE:
 * 1. Customer sees: "Your delivery has 2 stops, total 910 km, ~23 hours"
 * 2. Driver sees: "Next stop: Jaipur (270 km, 6.75 hrs away)"
 * 3. Transporter sees: Full route on map before accepting
 */
export interface RouteBreakdown {
  /** Array of legs in order */
  legs: RouteLeg[];
  
  /** Total number of route points */
  totalPoints: number;
  
  /** Number of intermediate stops (excluding pickup & drop) */
  totalStops: number;
  
  /** Total distance across all legs (km) */
  totalDistanceKm: number;
  
  /** Total duration across all legs (minutes) */
  totalDurationMinutes: number;
  
  /** Total duration formatted as string (e.g., "22 hrs 45 mins") */
  totalDurationFormatted: string;
  
  /** Buffer time for all stops (minutes) */
  totalBufferMinutes: number;
  
  /** Grand total including buffer (minutes) */
  grandTotalMinutes: number;
  
  /** Estimated arrival time at final drop (ISO string) */
  estimatedArrival?: string;
  
  /** Average speed used for calculation (km/h) */
  averageSpeedKmh: number;
}

// =============================================================================
// ETA UPDATE (For live tracking)
// =============================================================================

/**
 * ETA update for a specific leg
 * 
 * Used when driver progresses through route.
 * Recalculates remaining time based on current position.
 */
export interface ETAUpdate {
  /** Current leg index (which leg driver is on) */
  currentLegIndex: number;
  
  /** Current route index (which point driver is heading to) */
  currentRouteIndex: number;
  
  /** Distance remaining in current leg (km) */
  remainingDistanceCurrentLeg: number;
  
  /** Total remaining distance (km) */
  remainingDistanceTotal: number;
  
  /** ETA to next stop (minutes) */
  etaToNextStop: number;
  
  /** ETA to final drop (minutes) */
  etaToFinalDrop: number;
  
  /** Estimated arrival at final drop (ISO string) */
  estimatedArrival: string;
}

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type Coordinates = z.infer<typeof coordinatesSchema>;
export type RoutePointInput = z.infer<typeof routePointInputSchema>;
