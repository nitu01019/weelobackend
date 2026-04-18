/**
 * =============================================================================
 * /route-multi REQUEST SCHEMA (F-A-38)
 * =============================================================================
 *
 * Zod schema for the multi-waypoint routing request body.
 *
 * Why a dedicated file (not inline in geocoding.routes.ts):
 *   - The schema is reused by the weighted-IP-budget computation
 *     (cost = points.length - 1) which needs `points` typed post-validation.
 *   - Separate file keeps route-handler code focused on HTTP concerns.
 *   - Import-friendly for unit testing — validates in < 1ms without Express.
 *
 * Bounds:
 *   - 2..25 points: a single pickup + drop at minimum; Google Directions API
 *     caps effective waypoints at 25 for standard tier — matching that here
 *     avoids surprising downstream failures.
 *   - lat in [-90, 90], lng in [-180, 180]: standard WGS84 envelope.
 *   - label ≤ 128 chars: defensive cap on opaque client labels.
 * =============================================================================
 */

import { z } from 'zod';

export const routeMultiPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  label: z.string().max(128).optional(),
});

export const routeMultiSchema = z.object({
  points: z.array(routeMultiPointSchema).min(2).max(25),
  truckMode: z.boolean().optional().default(true),
  includePolyline: z.boolean().optional().default(true),
});

export type RouteMultiRequest = z.infer<typeof routeMultiSchema>;
export type RouteMultiPoint = z.infer<typeof routeMultiPointSchema>;
