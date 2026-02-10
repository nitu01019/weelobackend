/**
 * =============================================================================
 * GEOSPATIAL UTILITIES - Haversine Distance Calculations
 * =============================================================================
 *
 * SCALABILITY: Pure functions, O(1) complexity, no I/O
 * EASY UNDERSTANDING: Single source of truth for distance calculations
 * MODULARITY: Shared across RoutingService, TrackingService, etc.
 * CODING STANDARDS: Consistent with existing patterns
 *
 * =============================================================================
 */

/**
 * Earth's radius constants
 */
export const EARTH_RADIUS = {
  KM: 6371,
  METERS: 6371000,
};

/**
 * Calculate distance between two GPS coordinates using Haversine formula
 *
 * WHY HAVERSINE:
 * - Accurate for Earth's surface (spherical geometry)
 * - No external API calls (instant, free, offline)
 * - Good enough for logistics (±5% accuracy vs road distance)
 *
 * @param lat1 Origin latitude
 * @param lng1 Origin longitude
 * @param lat2 Destination latitude
 * @param lng2 Destination longitude
 * @returns Distance in kilometers
 */
export function haversineDistanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS.KM * c;
}

/**
 * Calculate distance in meters (for tracking/proximity checks)
 *
 * @param lat1 Origin latitude
 * @param lng1 Origin longitude
 * @param lat2 Destination latitude
 * @param lng2 Destination longitude
 * @returns Distance in meters
 */
export function haversineDistanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  return haversineDistanceKm(lat1, lng1, lat2, lng2) * 1000;
}

/**
 * Convert degrees to radians
 */
function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Road distance multiplier (straight line to road estimate)
 * Industry standard: 1.3x for urban, 1.4x for rural
 */
export const ROAD_DISTANCE_MULTIPLIER = 1.35;

/**
 * Calculate estimated road distance from straight-line distance
 *
 * @param straightLineKm Haversine distance in km
 * @returns Estimated road distance in km
 */
export function estimateRoadDistanceKm(straightLineKm: number): number {
  return Math.round(straightLineKm * ROAD_DISTANCE_MULTIPLIER);
}
