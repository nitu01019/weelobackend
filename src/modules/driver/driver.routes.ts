/**
 * =============================================================================
 * DRIVER MODULE - ROUTES
 * =============================================================================
 * 
 * API routes for driver-specific operations like dashboard and availability.
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { validateRequest, validateSchema } from '../../shared/utils/validation.utils';
import { driverService } from './driver.service';
import { 
  updateAvailabilitySchema, 
  getTripsQuerySchema, 
  getEarningsQuerySchema,
  createDriverSchema
} from './driver.schema';

const router = Router();

// =============================================================================
// TRANSPORTER - MANAGE DRIVERS
// =============================================================================

/**
 * POST /api/v1/driver/create
 * Transporter creates a new driver under their account
 */
router.post(
  '/create',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = validateSchema(createDriverSchema, req.body);
      const transporterId = req.user!.userId;
      
      const driver = await driverService.createDriver(transporterId, data);
      
      res.status(201).json({
        success: true,
        data: { driver },
        message: `Driver ${driver.name} added successfully`
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/driver/list
 * Transporter gets all their drivers
 */
router.get(
  '/list',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const result = await driverService.getTransporterDrivers(transporterId);
      
      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// DRIVER DASHBOARD
// =============================================================================

/**
 * GET /api/v1/driver/dashboard
 * Get driver dashboard with stats, recent trips, and earnings
 */
router.get(
  '/dashboard',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const dashboard = await driverService.getDashboard(userId);
      
      res.json({
        success: true,
        data: dashboard
      });
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// DRIVER AVAILABILITY
// =============================================================================

/**
 * GET /api/v1/driver/availability
 * Get current driver availability status
 */
router.get(
  '/availability',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const availability = await driverService.getAvailability(userId);
      
      res.json({
        success: true,
        data: availability
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /api/v1/driver/availability
 * Update driver availability status
 */
router.put(
  '/availability',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  validateRequest(updateAvailabilitySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const { isOnline, currentLocation } = req.body;
      
      const availability = await driverService.updateAvailability(userId, {
        isOnline,
        currentLocation
      });
      
      res.json({
        success: true,
        message: isOnline ? 'You are now online' : 'You are now offline',
        data: availability
      });
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// DRIVER EARNINGS
// =============================================================================

/**
 * GET /api/v1/driver/earnings
 * Get driver earnings summary
 */
router.get(
  '/earnings',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const query = getEarningsQuerySchema.parse(req.query);
      
      const earnings = await driverService.getEarnings(userId, query.period);
      
      res.json({
        success: true,
        data: earnings
      });
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// DRIVER TRIPS/BOOKINGS
// =============================================================================

/**
 * GET /api/v1/driver/trips
 * Get driver's trip history
 */
router.get(
  '/trips',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const { status, limit = 20, offset = 0 } = req.query;
      
      const trips = await driverService.getTrips(userId, {
        status: status as string,
        limit: Number(limit),
        offset: Number(offset)
      });
      
      res.json({
        success: true,
        data: trips
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/driver/trips/active
 * Get driver's currently active trip
 */
router.get(
  '/trips/active',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const activeTrip = await driverService.getActiveTrip(userId);
      
      res.json({
        success: true,
        data: activeTrip
      });
    } catch (error) {
      next(error);
    }
  }
);

export { router as driverRouter };
