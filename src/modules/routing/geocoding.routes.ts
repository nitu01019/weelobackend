/**
 * =============================================================================
 * GEOCODING ROUTES - Place Search & Reverse Geocoding
 * =============================================================================
 * 
 * Provides API endpoints for:
 * - Place search (autocomplete)
 * - Reverse geocoding (coordinates to address)
 * - Route calculation with Google Maps
 * 
 * All endpoints use Google Maps API with Haversine fallback.
 * =============================================================================
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { googleMapsService } from '../../shared/services/google-maps.service';
import { routingService } from './routing.service';
import { logger } from '../../shared/services/logger.service';
import { placesRateLimiter } from '../../shared/middleware/rate-limiter.middleware';
import { optionalAuthMiddleware } from '../../shared/middleware/auth.middleware';

const router = Router();

// =============================================================================
// PER-IP DAILY BUDGET PROTECTION - Prevents Google Maps bill abuse
// =============================================================================
// 
// SCALABILITY: Per-IP tracking prevents any single user from abusing the API
//   while allowing millions of legitimate users. Map auto-cleans every hour.
// 
// SECURITY: Even if someone bypasses rate limiter, budget hard-caps their calls.
//   Tracked per-IP (not global), so one abuser doesn't block all users.
// 
// EASY UNDERSTANDING:
//   - Each IP gets X calls per day per API type
//   - Exceeding = 429 Too Many Requests
//   - Counters reset at midnight
//   - Old entries cleaned every hour to prevent memory leak
// 
// CODING STANDARDS: Uses Map for O(1) lookups, setInterval for cleanup
// =============================================================================
interface IpBudget {
  search: number;
  reverse: number;
  route: number;
  date: string;
}

const PER_IP_LIMITS = {
  search: 200,    // 200 searches/day per IP (normal user does ~20-30)
  reverse: 100,   // 100 reverse geocodes/day per IP
  route: 50,      // 50 route calculations/day per IP (most expensive)
};

const ipBudgetMap = new Map<string, IpBudget>();

// Clean up stale entries every hour to prevent memory leak
setInterval(() => {
  const today = new Date().toDateString();
  let cleaned = 0;
  for (const [ip, budget] of ipBudgetMap.entries()) {
    if (budget.date !== today) {
      ipBudgetMap.delete(ip);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logger.info(`🧹 Cleaned ${cleaned} stale IP budget entries`);
  }
}, 60 * 60 * 1000); // Every hour

function getClientIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() 
    || req.socket.remoteAddress 
    || 'unknown';
}

function checkIpBudget(req: Request, type: 'search' | 'reverse' | 'route'): boolean {
  const ip = getClientIp(req);
  const today = new Date().toDateString();
  
  let budget = ipBudgetMap.get(ip);
  if (!budget || budget.date !== today) {
    budget = { search: 0, reverse: 0, route: 0, date: today };
    ipBudgetMap.set(ip, budget);
  }
  
  if (budget[type] >= PER_IP_LIMITS[type]) {
    logger.warn(`🚫 IP budget exceeded: ${ip} - ${type} (${budget[type]}/${PER_IP_LIMITS[type]})`);
    return false; // Budget exceeded
  }
  
  budget[type]++;
  return true; // OK
}

// Apply optional auth to all geocoding routes
// This allows tracking which user makes requests for logging
// SECURITY: Rate limiter + per-IP budget provides defense in depth
router.use(optionalAuthMiddleware);

// =============================================================================
// SCHEMAS
// =============================================================================

const placeSearchSchema = z.object({
    query: z.string().min(2).max(200),
    biasLat: z.number().min(-90).max(90).optional(),
    biasLng: z.number().min(-180).max(180).optional(),
    maxResults: z.number().int().min(1).max(20).default(5),
});

const reverseGeocodeSchema = z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
});

const routeCalculationSchema = z.object({
    from: z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
    }),
    to: z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
    }),
    truckMode: z.boolean().default(true),
    includePolyline: z.boolean().default(false), // Return route geometry for map
});

// =============================================================================
// ROUTES
// =============================================================================

/**
 * POST /api/v1/geocoding/search
 * 
 * Search for places by text query (autocomplete)
 * 
 * Request:
 * {
 *   "query": "Connaught Place Delhi",
 *   "biasLat": 28.6139,  // optional: bias toward this location
 *   "biasLng": 77.2090,
 *   "maxResults": 5
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "data": [
 *     {
 *       "placeId": "...",
 *       "label": "Connaught Place, New Delhi, Delhi, India",
 *       "latitude": 28.6329,
 *       "longitude": 77.2195
 *     }
 *   ]
 * }
 */
router.post('/search', placesRateLimiter, async (req: Request, res: Response) => {
    try {
        // SECURITY: Per-IP daily budget check (prevents bill abuse)
        if (!checkIpBudget(req, 'search')) {
            return res.status(429).json({
                success: false,
                error: 'DAILY_LIMIT_EXCEEDED',
                message: 'Daily search limit exceeded. Try again tomorrow.',
            });
        }

        const parsed = placeSearchSchema.safeParse(req.body);

        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                error: 'VALIDATION_ERROR',
                message: parsed.error.errors[0]?.message || 'Invalid request',
            });
        }

        const { query, biasLat, biasLng, maxResults } = parsed.data;

        // Check if Google Maps is available
        if (!googleMapsService.isAvailable()) {
            return res.status(503).json({
                success: false,
                error: 'SERVICE_UNAVAILABLE',
                message: 'Geocoding service not configured. Add GOOGLE_MAPS_API_KEY.',
            });
        }

        const biasPosition = biasLat && biasLng
            ? { lat: biasLat, lng: biasLng }
            : undefined;

        const results = await googleMapsService.searchPlaces(query, biasPosition, maxResults);

        logger.debug(`Place search: "${query}" returned ${results.length} results`);

        return res.json({
            success: true,
            data: results,
        });

    } catch (error: any) {
        logger.error(`Place search error: ${error.message}`);
        return res.status(500).json({
            success: false,
            error: 'INTERNAL_ERROR',
            message: 'Failed to search places',
        });
    }
});

/**
 * POST /api/v1/geocoding/reverse
 * 
 * Reverse geocode: coordinates to address
 * 
 * Request:
 * {
 *   "latitude": 28.6139,
 *   "longitude": 77.2090
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "data": {
 *     "address": "Connaught Place, New Delhi, Delhi 110001, India",
 *     "city": "New Delhi",
 *     "state": "Delhi",
 *     "country": "India",
 *     "postalCode": "110001"
 *   }
 * }
 */
router.post('/reverse', placesRateLimiter, async (req: Request, res: Response) => {
    try {
        // SECURITY: Per-IP daily budget check (prevents bill abuse)
        if (!checkIpBudget(req, 'reverse')) {
            return res.status(429).json({
                success: false,
                error: 'DAILY_LIMIT_EXCEEDED',
                message: 'Daily reverse geocoding limit exceeded. Try again tomorrow.',
            });
        }

        const parsed = reverseGeocodeSchema.safeParse(req.body);

        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                error: 'VALIDATION_ERROR',
                message: parsed.error.errors[0]?.message || 'Invalid request',
            });
        }

        const { latitude, longitude } = parsed.data;

        // Check if Google Maps is available
        if (!googleMapsService.isAvailable()) {
            return res.status(503).json({
                success: false,
                error: 'SERVICE_UNAVAILABLE',
                message: 'Geocoding service not configured. Add GOOGLE_MAPS_API_KEY.',
            });
        }

        const result = await googleMapsService.reverseGeocode(latitude, longitude);

        if (!result) {
            return res.status(404).json({
                success: false,
                error: 'NOT_FOUND',
                message: 'No address found for these coordinates',
            });
        }

        return res.json({
            success: true,
            data: result,
        });

    } catch (error: any) {
        logger.error(`Reverse geocode error: ${error.message}`);
        return res.status(500).json({
            success: false,
            error: 'INTERNAL_ERROR',
            message: 'Failed to reverse geocode',
        });
    }
});

/**
 * POST /api/v1/geocoding/route
 * 
 * Calculate route between two points using AWS Location
 * Falls back to Haversine if AWS unavailable
 * 
 * Request:
 * {
 *   "from": { "latitude": 28.6139, "longitude": 77.2090 },
 *   "to": { "latitude": 19.0760, "longitude": 72.8777 },
 *   "truckMode": true
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "data": {
 *     "distanceKm": 1420,
 *     "durationMinutes": 1704,
 *     "durationFormatted": "28 hrs 24 mins",
 *     "source": "aws"
 *   }
 * }
 */
router.post('/route', placesRateLimiter, async (req: Request, res: Response) => {
    try {
        // SECURITY: Per-IP daily budget check (prevents bill abuse - route is most expensive)
        if (!checkIpBudget(req, 'route')) {
            return res.status(429).json({
                success: false,
                error: 'DAILY_LIMIT_EXCEEDED',
                message: 'Daily route calculation limit exceeded. Try again tomorrow.',
            });
        }

        const parsed = routeCalculationSchema.safeParse(req.body);

        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                error: 'VALIDATION_ERROR',
                message: parsed.error.errors[0]?.message || 'Invalid request',
            });
        }

        const { from, to, truckMode, includePolyline } = parsed.data;

        const result = await routingService.calculateDistanceWithAWS(
            from.latitude, from.longitude,
            to.latitude, to.longitude,
            truckMode,
            includePolyline
        );

        // Format duration
        const hours = Math.floor(result.durationMinutes / 60);
        const mins = result.durationMinutes % 60;
        const durationFormatted = hours > 0
            ? `${hours} hr${hours > 1 ? 's' : ''} ${mins} mins`
            : `${mins} mins`;

        const responseData: any = {
            distanceKm: result.distanceKm,
            durationMinutes: result.durationMinutes,
            durationFormatted,
            source: result.source,
        };

        // Include polyline if requested
        if (includePolyline && result.polyline) {
            responseData.polyline = result.polyline;
        }

        return res.json({
            success: true,
            data: responseData,
        });

    } catch (error: any) {
        logger.error(`Route calculation error: ${error.message}`);
        return res.status(500).json({
            success: false,
            error: 'INTERNAL_ERROR',
            message: 'Failed to calculate route',
        });
    }
});

/**
 * POST /api/v1/geocoding/route-multi
 * 
 * Calculate route with multiple waypoints (pickup → stops → drop)
 * Returns road-following polyline for map display
 * 
 * Request body:
 * {
 *   "points": [
 *     { "lat": 28.61, "lng": 77.20, "label": "Pickup" },
 *     { "lat": 26.91, "lng": 75.78, "label": "Stop 1" },
 *     { "lat": 19.07, "lng": 72.87, "label": "Drop" }
 *   ],
 *   "truckMode": true,
 *   "includePolyline": true
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "data": {
 *     "distanceKm": 910,
 *     "durationMinutes": 820,
 *     "polyline": [[28.61, 77.20], ...],
 *     "legs": [{ "distanceKm": 270, "durationMinutes": 280 }, ...],
 *     "source": "aws"
 *   }
 * }
 */
router.post('/route-multi', placesRateLimiter, async (req: Request, res: Response) => {
    try {
        // SECURITY: Per-IP daily budget check (route-multi is MOST expensive - uses multiple API calls)
        if (!checkIpBudget(req, 'route')) {
            return res.status(429).json({
                success: false,
                error: 'DAILY_LIMIT_EXCEEDED',
                message: 'Daily route calculation limit exceeded. Try again tomorrow.',
            });
        }

        const { points, truckMode = true, includePolyline = true } = req.body;

        // Validate points array
        if (!Array.isArray(points) || points.length < 2) {
            return res.status(400).json({
                success: false,
                error: 'VALIDATION_ERROR',
                message: 'At least 2 points are required (pickup and drop)',
            });
        }

        // Validate each point has lat/lng
        for (let i = 0; i < points.length; i++) {
            const point = points[i];
            if (typeof point.lat !== 'number' || typeof point.lng !== 'number') {
                return res.status(400).json({
                    success: false,
                    error: 'VALIDATION_ERROR',
                    message: `Point ${i} must have valid lat and lng numbers`,
                });
            }
        }

        const result = await routingService.calculateMultiPointRouteWithAWS(
            points,
            truckMode,
            includePolyline
        );

        // Format duration
        const hours = Math.floor(result.durationMinutes / 60);
        const mins = result.durationMinutes % 60;
        const durationFormatted = hours > 0
            ? `${hours} hr${hours > 1 ? 's' : ''} ${mins} mins`
            : `${mins} mins`;

        const responseData: any = {
            distanceKm: result.distanceKm,
            durationMinutes: result.durationMinutes,
            durationFormatted,
            source: result.source,
        };

        // Include polyline if requested
        if (includePolyline && result.polyline) {
            responseData.polyline = result.polyline;
        }

        // Include leg breakdown
        if (result.legs) {
            responseData.legs = result.legs;
        }

        return res.json({
            success: true,
            data: responseData,
        });

    } catch (error: any) {
        logger.error(`Multi-point route calculation error: ${error.message}`);
        return res.status(500).json({
            success: false,
            error: 'INTERNAL_ERROR',
            message: 'Failed to calculate multi-point route',
        });
    }
});

/**
 * GET /api/v1/geocoding/status
 * 
 * Check if Google Maps Service is available
 */
router.get('/status', (_req: Request, res: Response) => {
    return res.json({
        success: true,
        data: {
            available: googleMapsService.isAvailable(),
            service: 'Google Maps API',
        },
    });
});

export default router;
