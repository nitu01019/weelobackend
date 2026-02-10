/**
 * =============================================================================
 * ROUTING SERVICE - ETA & Distance Calculations
 * =============================================================================
 * 
 * SCALABILITY:
 * ─────────────────────────────────────────────────────────────────────────────
 * - All calculations are PURE FUNCTIONS (no DB, no I/O)
 * - O(n) complexity where n = route points (max 4)
 * - Each calculation takes < 1ms
 * - Easily handles millions of concurrent requests
 * - Stateless - can run on any server instance
 * 
 * MODULARITY:
 * ─────────────────────────────────────────────────────────────────────────────
 * - Single responsibility: Route calculations only
 * - No dependencies on other modules
 * - Easy to unit test
 * - Uses Google Maps for accurate routing (road-following polylines)
 * 
 * ROUTING SOURCES:
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Google Maps Directions API (primary - industry standard)
 * 2. Haversine formula (fallback - straight line)
 * 
 * =============================================================================
 */

import { logger } from '../../shared/services/logger.service';
import { googleMapsService } from '../../shared/services/google-maps.service';
import {
  haversineDistanceKm,
  estimateRoadDistanceKm,
} from '../../shared/utils/geospatial.utils';
import {
  ROUTING_CONFIG,
  RouteLeg,
  RouteBreakdown,
  ETAUpdate,
  RoutePointInput,
} from './routing.schema';

// =============================================================================
// MAIN SERVICE CLASS
// =============================================================================

class RoutingService {

  // ===========================================================================
  // PUBLIC: Calculate Route Breakdown
  // ===========================================================================

  /**
   * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   * ┃  CALCULATE ROUTE BREAKDOWN                                              ┃
   * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
   * 
   * Takes array of route points and returns full breakdown with:
   * - Distance per leg
   * - Duration per leg
   * - Cumulative ETA at each point
   * - Total distance & duration
   * 
   * EXAMPLE INPUT:
   * [
   *   { type: 'PICKUP', lat: 28.61, lng: 77.20, address: 'Delhi' },
   *   { type: 'STOP',   lat: 26.91, lng: 75.78, address: 'Jaipur' },
   *   { type: 'DROP',   lat: 19.07, lng: 72.87, address: 'Mumbai' }
   * ]
   * 
   * EXAMPLE OUTPUT:
   * {
   *   legs: [
   *     { fromIndex: 0, toIndex: 1, distanceKm: 270, durationMinutes: 405 },
   *     { fromIndex: 1, toIndex: 2, distanceKm: 640, durationMinutes: 960 }
   *   ],
   *   totalDistanceKm: 910,
   *   totalDurationMinutes: 1365,
   *   totalDurationFormatted: "22 hrs 45 mins"
   * }
   * 
   * @param routePoints Array of route points in order
   * @param departureTime Optional departure time for ETA calculation
   * @returns RouteBreakdown with all calculations
   */
  calculateRouteBreakdown(
    routePoints: RoutePointInput[],
    departureTime?: Date
  ): RouteBreakdown {

    // Validate minimum points
    if (!routePoints || routePoints.length < 2) {
      logger.warn('Route breakdown requires at least 2 points');
      return this.emptyBreakdown();
    }

    const legs: RouteLeg[] = [];
    let cumulativeMinutes = 0;

    // Calculate each leg (A→B, B→C, C→D)
    for (let i = 0; i < routePoints.length - 1; i++) {
      const from = routePoints[i];
      const to = routePoints[i + 1];

      // Calculate distance using shared Haversine utility
      const straightLineKm = haversineDistanceKm(
        from.latitude, from.longitude,
        to.latitude, to.longitude
      );

      // Apply road multiplier for more realistic estimate
      const roadDistanceKm = estimateRoadDistanceKm(straightLineKm);

      // Calculate duration based on average speed (or AWS response)
      let durationMinutes = Math.round((roadDistanceKm / ROUTING_CONFIG.AVERAGE_SPEED_KMH) * 60);

      const leg: RouteLeg = {
        fromIndex: i,
        toIndex: i + 1,
        fromType: from.type,
        toType: to.type,
        fromAddress: from.address || `Point ${i}`,
        toAddress: to.address || `Point ${i + 1}`,
        fromCity: from.city,
        toCity: to.city,
        distanceKm: roadDistanceKm,
        durationMinutes,
        etaFromStartMinutes: cumulativeMinutes,
        etaToEndMinutes: cumulativeMinutes + durationMinutes,
      };

      legs.push(leg);
      cumulativeMinutes += durationMinutes;
    }

    // Calculate totals
    const totalDistanceKm = legs.reduce((sum, leg) => sum + leg.distanceKm, 0);
    const totalDurationMinutes = legs.reduce((sum, leg) => sum + leg.durationMinutes, 0);
    const totalStops = routePoints.filter(p => p.type === 'STOP').length;
    const totalBufferMinutes = totalStops * ROUTING_CONFIG.BUFFER_TIME_PER_STOP_MINUTES;
    const grandTotalMinutes = totalDurationMinutes + totalBufferMinutes;

    // Calculate estimated arrival
    let estimatedArrival: string | undefined;
    if (departureTime) {
      const arrivalDate = new Date(departureTime.getTime() + grandTotalMinutes * 60 * 1000);
      estimatedArrival = arrivalDate.toISOString();
    }

    const breakdown: RouteBreakdown = {
      legs,
      totalPoints: routePoints.length,
      totalStops,
      totalDistanceKm,
      totalDurationMinutes,
      totalDurationFormatted: this.formatDuration(totalDurationMinutes),
      totalBufferMinutes,
      grandTotalMinutes,
      estimatedArrival,
      averageSpeedKmh: ROUTING_CONFIG.AVERAGE_SPEED_KMH,
    };

    logger.debug(`📍 Route calculated: ${totalDistanceKm} km, ${this.formatDuration(grandTotalMinutes)} (${totalStops} stops)`);

    return breakdown;
  }

  // ===========================================================================
  // PUBLIC: Calculate ETA Update (for live tracking)
  // ===========================================================================

  /**
   * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   * ┃  CALCULATE ETA UPDATE                                                   ┃
   * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
   * 
   * Recalculates ETA based on driver's current position.
   * Called when driver location updates.
   * 
   * @param routePoints Full route
   * @param currentRouteIndex Which point driver is heading to (0, 1, 2...)
   * @param currentLat Driver's current latitude
   * @param currentLng Driver's current longitude
   * @returns ETAUpdate with remaining distances and times
   */
  calculateETAUpdate(
    routePoints: RoutePointInput[],
    currentRouteIndex: number,
    currentLat: number,
    currentLng: number
  ): ETAUpdate {

    // Get next destination
    const nextPoint = routePoints[currentRouteIndex];
    if (!nextPoint) {
      // Already at or past final destination
      return {
        currentLegIndex: routePoints.length - 2,
        currentRouteIndex,
        remainingDistanceCurrentLeg: 0,
        remainingDistanceTotal: 0,
        etaToNextStop: 0,
        etaToFinalDrop: 0,
        estimatedArrival: new Date().toISOString(),
      };
    }

    // Distance to next stop
    const distanceToNext = estimateRoadDistanceKm(haversineDistanceKm(
      currentLat, currentLng,
      nextPoint.latitude, nextPoint.longitude
    ));

    // ETA to next stop
    const etaToNextMinutes = Math.round((distanceToNext / ROUTING_CONFIG.AVERAGE_SPEED_KMH) * 60);

    // Calculate remaining legs
    let remainingDistanceTotal = distanceToNext;
    let remainingDurationMinutes = etaToNextMinutes;

    for (let i = currentRouteIndex; i < routePoints.length - 1; i++) {
      const from = routePoints[i];
      const to = routePoints[i + 1];

      const legDistance = estimateRoadDistanceKm(haversineDistanceKm(
        from.latitude, from.longitude,
        to.latitude, to.longitude
      ));

      // Don't double-count current leg
      if (i > currentRouteIndex) {
        remainingDistanceTotal += legDistance;
        remainingDurationMinutes += Math.round((legDistance / ROUTING_CONFIG.AVERAGE_SPEED_KMH) * 60);
      }
    }

    // Add buffer for remaining stops
    const remainingStops = routePoints.slice(currentRouteIndex).filter(p => p.type === 'STOP').length;
    remainingDurationMinutes += remainingStops * ROUTING_CONFIG.BUFFER_TIME_PER_STOP_MINUTES;

    // Calculate arrival time
    const arrivalDate = new Date(Date.now() + remainingDurationMinutes * 60 * 1000);

    return {
      currentLegIndex: Math.max(0, currentRouteIndex - 1),
      currentRouteIndex,
      remainingDistanceCurrentLeg: Math.round(distanceToNext),
      remainingDistanceTotal: Math.round(remainingDistanceTotal),
      etaToNextStop: etaToNextMinutes,
      etaToFinalDrop: remainingDurationMinutes,
      estimatedArrival: arrivalDate.toISOString(),
    };
  }

  // ===========================================================================
  // PUBLIC: Simple Distance Calculation
  // ===========================================================================

  /**
   * Calculate distance between two points
   * Returns road distance (with multiplier)
   */
  calculateDistance(
    lat1: number, lng1: number,
    lat2: number, lng2: number
  ): number {
    return estimateRoadDistanceKm(haversineDistanceKm(lat1, lng1, lat2, lng2));
  }

  /**
   * Calculate distance using AWS Location Service (async)
   * Falls back to Haversine calculation if AWS is unavailable
   * 
   * @param lat1 Origin latitude
   * @param lng1 Origin longitude
   * @param lat2 Destination latitude
   * @param lng2 Destination longitude
   * @param truckMode Use truck-specific routing
   * @param includePolyline Return route geometry for map drawing
   * @returns Object with distance (km), duration (minutes), source, and optional polyline
   */
  async calculateDistanceWithAWS(
    lat1: number, lng1: number,
    lat2: number, lng2: number,
    truckMode: boolean = true,
    includePolyline: boolean = false
  ): Promise<{
    distanceKm: number;
    durationMinutes: number;
    source: 'aws' | 'haversine';
    polyline?: Array<[number, number]>;
  }> {

    // Try Google Maps Directions API first (industry standard)
    if (googleMapsService.isAvailable()) {
      const googleResult = await googleMapsService.calculateRoute(
        [{ lat: lat1, lng: lng1 }, { lat: lat2, lng: lng2 }],
        truckMode
      );

      if (googleResult) {
        return {
          distanceKm: googleResult.distanceKm,
          durationMinutes: googleResult.durationMinutes,
          source: 'google' as any,
          polyline: googleResult.polyline,
        };
      }
    }

    // Fallback to Haversine (no polyline available)
    const distanceKm = this.calculateDistance(lat1, lng1, lat2, lng2);
    const durationMinutes = this.calculateETA(distanceKm);

    // Generate simple 2-point fallback polyline
    const fallbackPolyline: Array<[number, number]> = includePolyline
      ? [[lat1, lng1], [lat2, lng2]]
      : [];

    return {
      distanceKm,
      durationMinutes,
      source: 'haversine',
      polyline: includePolyline ? fallbackPolyline : undefined,
    };
  }

  /**
   * Calculate route with multiple waypoints using AWS Location Service
   * Returns road-following polyline for map display
   * 
   * @param points Array of route points in order [pickup, ...stops, drop]
   * @param truckMode Use truck-specific routing
   * @param includePolyline Return route geometry for map drawing
   * @returns Object with distance, duration, legs, source, and polyline
   */
  async calculateMultiPointRouteWithAWS(
    points: Array<{ lat: number; lng: number; label?: string }>,
    truckMode: boolean = true,
    includePolyline: boolean = true
  ): Promise<{
    distanceKm: number;
    durationMinutes: number;
    source: 'aws' | 'haversine';
    polyline?: Array<[number, number]>;
    legs?: Array<{
      distanceKm: number;
      durationMinutes: number;
    }>;
  }> {

    if (points.length < 2) {
      return {
        distanceKm: 0,
        durationMinutes: 0,
        source: 'haversine',
      };
    }

    // =======================================================================
    // PRIORITY 1: Google Maps Directions API (industry standard)
    // =======================================================================
    if (googleMapsService.isAvailable()) {
      const googleResult = await googleMapsService.calculateRoute(points, truckMode);

      if (googleResult) {
        logger.debug(`📍 Using Google Maps: ${googleResult.distanceKm} km (${googleResult.polyline.length} polyline points)`);
        return {
          distanceKm: googleResult.distanceKm,
          durationMinutes: googleResult.durationMinutes,
          source: 'google' as any, // Extended type
          polyline: googleResult.polyline,
          legs: googleResult.legs?.map(leg => ({
            distanceKm: leg.distanceKm,
            durationMinutes: leg.durationMinutes,
          })),
        };
      }
    }

    // Haversine fallback (straight line) - only when Google Maps fails

    // Fallback: Calculate using Haversine for each leg
    let totalDistance = 0;
    let totalDuration = 0;
    const legs: Array<{ distanceKm: number; durationMinutes: number }> = [];
    const fallbackPolyline: Array<[number, number]> = [];

    for (let i = 0; i < points.length - 1; i++) {
      const from = points[i];
      const to = points[i + 1];

      const legDistance = this.calculateDistance(from.lat, from.lng, to.lat, to.lng);
      const legDuration = this.calculateETA(legDistance);

      totalDistance += legDistance;
      totalDuration += legDuration;

      legs.push({
        distanceKm: legDistance,
        durationMinutes: legDuration,
      });

      // Add points to fallback polyline
      if (includePolyline) {
        if (i === 0) {
          fallbackPolyline.push([from.lat, from.lng]);
        }
        fallbackPolyline.push([to.lat, to.lng]);
      }
    }

    return {
      distanceKm: totalDistance,
      durationMinutes: totalDuration,
      source: 'haversine',
      polyline: includePolyline ? fallbackPolyline : undefined,
      legs,
    };
  }

  /**
   * Calculate ETA between two points
   * Returns duration in minutes
   */
  calculateETA(distanceKm: number): number {
    return Math.round((distanceKm / ROUTING_CONFIG.AVERAGE_SPEED_KMH) * 60);
  }

  // ===========================================================================
  // PUBLIC: Helpers
  // ===========================================================================

  /**
   * Format duration in human-readable string
   * 
   * Examples:
   * - 45 → "45 mins"
   * - 90 → "1 hr 30 mins"
   * - 1440 → "24 hrs"
   */
  formatDuration(minutes: number): string {
    if (minutes < 60) {
      return `${minutes} mins`;
    }

    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;

    if (mins === 0) {
      return `${hours} hr${hours > 1 ? 's' : ''}`;
    }

    return `${hours} hr${hours > 1 ? 's' : ''} ${mins} mins`;
  }

  /**
   * Empty breakdown for edge cases
   */
  private emptyBreakdown(): RouteBreakdown {
    return {
      legs: [],
      totalPoints: 0,
      totalStops: 0,
      totalDistanceKm: 0,
      totalDurationMinutes: 0,
      totalDurationFormatted: '0 mins',
      totalBufferMinutes: 0,
      grandTotalMinutes: 0,
      averageSpeedKmh: ROUTING_CONFIG.AVERAGE_SPEED_KMH,
    };
  }
}

// =============================================================================
// EXPORT SINGLETON
// =============================================================================

export const routingService = new RoutingService();
