/**
 * =============================================================================
 * TRACKING MODULE - CONTROLLER
 * =============================================================================
 */

import { Request, Response, NextFunction } from 'express';
import { trackingService } from './tracking.service';
import { updateLocationSchema, locationHistoryQuerySchema } from './tracking.schema';
import { validateSchema } from '../../shared/utils/validation.utils';
import { successResponse } from '../../shared/types/api.types';
import { asyncHandler } from '../../shared/middleware/error.middleware';

class TrackingController {
  /**
   * Update driver's current location
   */
  updateLocation = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const driverId = req.userId!;
    const data = validateSchema(updateLocationSchema, req.body);
    
    const tracking = await trackingService.updateLocation(driverId, data);
    
    res.json(successResponse({ tracking }));
  });

  /**
   * Get current location for a trip
   */
  getCurrentLocation = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { tripId } = req.params;
    const userId = req.userId!;
    const userRole = req.userRole!;
    
    const tracking = await trackingService.getCurrentLocation(tripId, userId, userRole);
    
    res.json(successResponse({ tracking }));
  });

  /**
   * Get location history for a trip
   */
  getLocationHistory = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { tripId } = req.params;
    const userId = req.userId!;
    const userRole = req.userRole!;
    const query = validateSchema(locationHistoryQuerySchema, req.query);
    
    const history = await trackingService.getLocationHistory(tripId, userId, userRole, {
      ...query,
      limit: query.limit ?? 100
    });
    
    res.json(successResponse({ history }));
  });

  /**
   * Get all driver locations for a booking (multi-truck view)
   */
  getBookingTracking = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { bookingId } = req.params;
    const customerId = req.userId!;
    
    const tracking = await trackingService.getBookingTracking(bookingId, customerId);
    
    res.json(successResponse({ tracking }));
  });
}

export const trackingController = new TrackingController();
