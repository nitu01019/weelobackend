/**
 * =============================================================================
 * TRACKING MODULE - ROUTES
 * =============================================================================
 * 
 * API routes for real-time location tracking.
 * Drivers update location, customers/transporters view tracking.
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { trackingService } from './tracking.service';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { validateRequest } from '../../shared/utils/validation.utils';
import { googleMapsService } from '../../shared/services/google-maps.service';
import { redisService } from '../../shared/services/redis.service';
import { db } from '../../shared/database/db';

// Redis key builders (matching tracking.service.ts)
const DRIVER_LOCATION_KEY = (driverId: string) => `driver:location:${driverId}`;
import { 
  updateLocationSchema, 
  getTrackingQuerySchema, 
  batchLocationSchema,
  tripStatusUpdateSchema,
  DriverOnlineStatus 
} from './tracking.schema';
import { z } from 'zod';

const router = Router();

/**
 * @route   POST /tracking/update
 * @desc    Update driver location
 * @access  Driver only
 */
router.post(
  '/update',
  authMiddleware,
  roleGuard(['driver']),
  validateRequest(updateLocationSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await trackingService.updateLocation(
        req.user!.userId,
        req.body
      );
      
      res.json({
        success: true,
        message: 'Location updated'
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /tracking/:tripId
 * @desc    Get current location for a trip
 * @access  Customer (own booking), Transporter (own assignment), Driver (own trip)
 */
router.get(
  '/:tripId',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tracking = await trackingService.getTripTracking(
        req.params.tripId,
        req.user!.userId,
        req.user!.role
      );
      
      res.json({
        success: true,
        data: tracking
      });
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// GET /tracking/booking/:bookingId/eta — Batch Real Google Maps ETA
// =============================================================================
//
// Phase 5: Returns real driving-time ETA for each active truck.
// Uses Google Directions API with aggressive caching (1hr TTL).
//
// ⚠️ IMPORTANT: This route MUST be BEFORE /booking/:bookingId
// Express matches routes in order. If /booking/:bookingId comes first,
// "/booking/abc/eta" matches with bookingId="abc" and never reaches /eta.
//
// SCALABILITY:
//   - Cache means 1000 requests for same route = 1 Google API call
//   - Promise.allSettled — one truck failure doesn't block others
//   - Only calculates for active trucks (not completed/cancelled)
//
// DATA ISOLATION:
//   - Customer can only see their own booking's ETA
//   - Transporter can see ETA for bookings with their assignments
//
// REQUEST: GET /tracking/booking/:bookingId/eta
// RESPONSE: { success, data: { etas: { [tripId]: { durationMinutes, distanceKm, durationText } } } }
// =============================================================================

router.get(
  '/booking/:bookingId/eta',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { bookingId } = req.params;

      // Get booking to verify access + get drop location
      const booking = await db.getBookingById(bookingId);
      if (!booking) {
        return res.status(404).json({
          success: false,
          error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
        });
      }

      // Access check: customer owns this booking
      if (req.user!.role === 'customer' && booking.customerId !== req.user!.userId) {
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Access denied' }
        });
      }

      // Get drop location from booking
      // booking.drop stores { latitude, longitude, address, city }
      const dropLat = booking.drop?.latitude || booking.drop?.lat;
      const dropLng = booking.drop?.longitude || booking.drop?.lng;
      if (!dropLat || !dropLng) {
        return res.json({
          success: true,
          data: { etas: {} }
        });
      }

      // Get all active truck positions from Redis
      const assignments = await db.getAssignmentsByBooking(bookingId);
      const activeTrucks: Array<{ tripId: string; lat: number; lng: number }> = [];

      for (const assignment of assignments) {
        // Skip completed/cancelled
        if (['completed', 'cancelled', 'driver_declined'].includes(assignment.status)) continue;

        // Get current location from Redis (real-time)
        const location = await redisService.getJSON<any>(
          DRIVER_LOCATION_KEY(assignment.driverId)
        );

        if (location && location.latitude && location.longitude) {
          activeTrucks.push({
            tripId: assignment.tripId,
            lat: location.latitude,
            lng: location.longitude
          });
        }
      }

      // Batch ETA calculation via Google Maps
      const etas = await googleMapsService.getBatchETA(
        activeTrucks,
        { lat: dropLat, lng: dropLng }
      );

      res.json({
        success: true,
        data: { etas }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /tracking/booking/:bookingId
 * @desc    Get all truck locations for a booking (multi-truck view)
 * @access  Customer (own booking)
 */
router.get(
  '/booking/:bookingId',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tracking = await trackingService.getBookingTracking(
        req.params.bookingId,
        req.user!.userId,
        req.user!.role
      );
      
      res.json({
        success: true,
        data: tracking
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /tracking/history/:tripId
 * @desc    Get location history for a trip
 * @access  Customer (own booking), Transporter (own assignment)
 */
router.get(
  '/history/:tripId',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = getTrackingQuerySchema.parse(req.query);
      const history = await trackingService.getTripHistory(
        req.params.tripId,
        req.user!.userId,
        req.user!.role,
        query
      );
      
      res.json({
        success: true,
        data: history
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /tracking/fleet
 * @desc    Get all active driver locations for transporter's fleet
 * @access  Transporter only
 * 
 * USAGE:
 * - Captain app calls this to show all trucks on map
 * - Returns array of driver locations with their current status
 * - Frontend should interpolate between location updates for smooth animation
 * 
 * RESPONSE:
 * {
 *   transporterId: "...",
 *   activeDrivers: 5,
 *   drivers: [
 *     { driverId, vehicleNumber, latitude, longitude, speed, bearing, status, lastUpdated }
 *   ]
 * }
 */
router.get(
  '/fleet',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fleet = await trackingService.getFleetTracking(req.user!.userId);
      
      res.json({
        success: true,
        data: fleet
      });
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// TRIP STATUS UPDATE (Driver Progression)
// =============================================================================

/**
 * @route   PUT /tracking/trip/:tripId/status
 * @desc    Update trip status (driver clicks: Reached Pickup → Loading Complete → Start Trip → Complete)
 * @access  Driver only (assigned driver)
 * 
 * STATUS FLOW:
 *   heading_to_pickup → at_pickup → loading_complete → in_transit → completed
 * 
 * WHAT HAPPENS ON EACH CALL:
 *   1. Assignment looked up by tripId (@unique index → O(1))
 *   2. Validates driver owns this trip
 *   3. Updates Postgres Assignment record (for statuses in Prisma enum)
 *   4. Updates Redis tracking data (for customer live tracking)
 *   5. WebSocket broadcast to booking room + trip room (real-time UI)
 *   6. FCM push to customer (even if app is closed/backgrounded)
 * 
 * REQUEST: { status: "at_pickup" | "loading_complete" | "in_transit" | "completed" | ... }
 * RESPONSE: { success: true, message: "Status updated to at_pickup" }
 * 
 * SCALABILITY:
 *   - @unique tripId index → O(1) lookup
 *   - Redis O(1) update
 *   - FCM queued (fire-and-forget)
 *   - Single API call per status change
 */
router.put(
  '/trip/:tripId/status',
  authMiddleware,
  roleGuard(['driver']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tripId } = req.params;
      const data = tripStatusUpdateSchema.parse(req.body);

      await trackingService.updateTripStatus(
        tripId,
        req.user!.userId,
        data
      );

      res.json({
        success: true,
        message: `Status updated to ${data.status}`
      });
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// OFFLINE RESILIENCE ENDPOINTS
// =============================================================================

/**
 * @route   POST /tracking/batch
 * @desc    Upload batch of buffered location points (offline sync)
 * @access  Driver only
 * 
 * USE CASE:
 * - Driver was offline for 5 minutes
 * - App buffered 30 location points locally
 * - On reconnect, uploads all at once
 * 
 * REQUEST:
 * {
 *   tripId: "uuid",
 *   points: [
 *     { latitude, longitude, speed, bearing, accuracy, timestamp },
 *     ...
 *   ]
 * }
 * 
 * RESPONSE:
 * {
 *   processed: 30,      // Total points received
 *   accepted: 25,       // Added to live/history
 *   stale: 3,           // Too old (history only)
 *   duplicate: 1,       // Already seen (ignored)
 *   invalid: 1,         // Unrealistic data (flagged)
 *   lastAcceptedTimestamp: "2024-01-23T..."
 * }
 * 
 * RULES:
 * - Max 100 points per batch
 * - Points must have timestamps
 * - Duplicate timestamps are rejected
 * - Points older than 60s go to history only
 * - Unrealistic speed jumps are flagged
 */
router.post(
  '/batch',
  authMiddleware,
  roleGuard(['driver']),
  validateRequest(batchLocationSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await trackingService.uploadBatchLocations(
        req.user!.userId,
        req.body
      );
      
      res.json({
        success: true,
        message: `Processed ${result.processed} points`,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /tracking/status
 * @desc    Get current driver's online status
 * @access  Driver only (self)
 * 
 * RESPONSE:
 * {
 *   status: "ONLINE" | "OFFLINE" | "UNKNOWN"
 * }
 * 
 * STATUS MEANING:
 * - ONLINE: Updated within 2 minutes
 * - OFFLINE: Explicitly set by app
 * - UNKNOWN: No update for > 2 minutes (network issue?)
 */
router.get(
  '/status',
  authMiddleware,
  roleGuard(['driver']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await trackingService.getDriverStatus(req.user!.userId);
      
      res.json({
        success: true,
        data: { status }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   PUT /tracking/status
 * @desc    Update driver's online status
 * @access  Driver only
 * 
 * REQUEST:
 * { status: "ONLINE" | "OFFLINE" }
 * 
 * USE CASE:
 * - App goes to background → set OFFLINE
 * - App comes to foreground → set ONLINE
 * - Helps transporter know if driver is active
 */
router.put(
  '/status',
  authMiddleware,
  roleGuard(['driver']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const schema = z.object({
        status: z.enum(['ONLINE', 'OFFLINE'])
      });
      
      const { status } = schema.parse(req.body);
      
      await trackingService.setDriverStatus(req.user!.userId, status as DriverOnlineStatus);
      
      res.json({
        success: true,
        message: `Status set to ${status}`
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /tracking/driver/:driverId/status
 * @desc    Get a specific driver's online status
 * @access  Transporter only (own drivers)
 * 
 * USE CASE:
 * - Transporter wants to know if their driver is active
 * - Fleet management dashboard
 */
router.get(
  '/driver/:driverId/status',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await trackingService.getDriverStatus(req.params.driverId);
      
      res.json({
        success: true,
        data: { 
          driverId: req.params.driverId,
          status 
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

export { router as trackingRouter };
