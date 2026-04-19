/**
 * =============================================================================
 * GEO UTILITIES - Coordinate Rounding & Helpers
 * =============================================================================
 *
 * Canonical location for geo-related pure utility functions.
 * Import from here instead of defining inline.
 *
 * =============================================================================
 */

/**
 * Round a coordinate to 3 decimal places (~111 m precision).
 * Used for idempotency fingerprints where sub-block accuracy suffices.
 */
export function roundCoord(n: number): number {
  return Math.round(n * 1000) / 1000;
}
