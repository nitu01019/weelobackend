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
import { 
  updateLocationSchema, 
  getTrackingQuerySchema, 
  batchLocationSchema,
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
