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
import { updateLocationSchema, getTrackingQuerySchema } from './tracking.schema';
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

export { router as trackingRouter };
