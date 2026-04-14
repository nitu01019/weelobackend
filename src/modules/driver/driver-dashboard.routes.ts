/**
 * =============================================================================
 * DRIVER DASHBOARD ROUTES (Dashboard, Performance, Availability, Earnings, Trips)
 * =============================================================================
 *
 * API Endpoints:
 * - GET  /dashboard       - Get driver dashboard with stats
 * - GET  /performance     - Get driver performance metrics
 * - GET  /availability    - Get current driver availability status
 * - GET  /available       - Get available drivers for assignment (Transporter)
 * - GET  /online-drivers  - Get currently online drivers (Transporter)
 * - PUT  /availability    - Update driver availability status
 * - GET  /earnings        - Get driver earnings summary
 * - GET  /trips           - Get driver's trip history
 * - GET  /trips/active    - Get driver's currently active trip
 *
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { validateRequest } from '../../shared/utils/validation.utils';
import { driverService } from './driver.service';
import {
  updateAvailabilitySchema,
  getEarningsQuerySchema
} from './driver.schema';
import { fleetCacheService, onDriverChange } from '../../shared/services/fleet-cache.service';
import { logger } from '../../shared/services/logger.service';

const driverDashboardRouter = Router();

// =============================================================================
// DRIVER DASHBOARD
// =============================================================================

/**
 * GET /api/v1/driver/dashboard
 * Get driver dashboard with stats, recent trips, and earnings
 */
driverDashboardRouter.get(
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
      return next(error);
    }
  }
);

// =============================================================================
// DRIVER PERFORMANCE
// =============================================================================

/**
 * GET /api/v1/driver/performance
 * Get driver performance metrics (acceptance rate, completion rate, rating, distance)
 *
 * SCALABILITY:
 *   - All queries use indexed columns (driverId, driverId+status)
 *   - COUNT queries → O(log n), sub-50ms at millions of rows
 *   - Can add Redis cache (5min TTL) at scale
 *
 * DATA ISOLATION:
 *   - Every query is WHERE driverId = ? — driver only sees their own data
 *
 * RESPONSE:
 *   { success: true, data: { rating, totalRatings, acceptanceRate,
 *     onTimeDeliveryRate, completionRate, totalTrips, totalDistance } }
 */
driverDashboardRouter.get(
  '/performance',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let targetDriverId = req.user!.userId;

      // Phase 5: Transporter can query a specific driver's performance
      // Usage: GET /api/v1/driver/performance?driverId=xxx
      if (req.user!.role === 'transporter' && req.query.driverId) {
        const requestedDriverId = req.query.driverId as string;
        // Verify driver belongs to this transporter
        const driver = await fleetCacheService.getDriver(requestedDriverId);
        if (!driver || driver.transporterId !== req.user!.userId) {
          return res.status(403).json({
            success: false,
            error: { code: 'FORBIDDEN', message: 'This driver does not belong to you' }
          });
        }
        targetDriverId = requestedDriverId;
      }

      const performance = await driverService.getPerformance(targetDriverId);

      res.json({
        success: true,
        data: performance
      });
    } catch (error) {
      return next(error);
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
driverDashboardRouter.get(
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
      return next(error);
    }
  }
);

/**
 * GET /api/v1/driver/available
 * Get available drivers for assignment (Transporter only)
 *
 * REDIS CACHING:
 * - Returns only available drivers (active, not on trip)
 * - TTL: 5 minutes
 */
driverDashboardRouter.get(
  '/available',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;

      logger.info(`[Drivers] Getting available drivers for ${transporterId.substring(0, 8)}`);

      // Use Redis cache for available drivers
      const availableDrivers = await fleetCacheService.getAvailableDrivers(transporterId);

      logger.info(`[Drivers] Found ${availableDrivers.length} available drivers`);

      res.json({
        success: true,
        data: {
          drivers: availableDrivers,
          total: availableDrivers.length
        }
      });
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * GET /api/v1/driver/online-drivers
 * Get currently online drivers for a transporter (real-time from Redis)
 *
 * Uses Redis SET + presence key verification for accurate status.
 * No caching — always returns real-time data.
 */
driverDashboardRouter.get(
  '/online-drivers',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;

      const onlineDriverIds = await driverService.getOnlineDriverIds(transporterId);

      res.json({
        success: true,
        data: {
          onlineDriverIds,
          total: onlineDriverIds.length
        }
      });
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * PUT /api/v1/driver/availability
 * Update driver availability status
 *
 * AUTO-UPDATE CACHE: Invalidates driver cache on availability change
 */
driverDashboardRouter.put(
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

      // AUTO-UPDATE: Invalidate driver cache for the transporter
      // Get driver's transporter ID from the service
      const driver = await fleetCacheService.getDriver(userId);
      if (driver && driver.transporterId) {
        await onDriverChange(driver.transporterId, userId);
        logger.info(`[Drivers] Cache invalidated for availability change`);
      }

      res.json({
        success: true,
        message: isOnline ? 'You are now online' : 'You are now offline',
        data: availability
      });
    } catch (error) {
      return next(error);
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
driverDashboardRouter.get(
  '/earnings',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let targetDriverId = req.user!.userId;

      // Phase 5: Transporter can query a specific driver's earnings
      // Usage: GET /api/v1/driver/earnings?driverId=xxx&period=month
      if (req.user!.role === 'transporter' && req.query.driverId) {
        const requestedDriverId = req.query.driverId as string;
        // Verify driver belongs to this transporter
        const driver = await fleetCacheService.getDriver(requestedDriverId);
        if (!driver || driver.transporterId !== req.user!.userId) {
          return res.status(403).json({
            success: false,
            error: { code: 'FORBIDDEN', message: 'This driver does not belong to you' }
          });
        }
        targetDriverId = requestedDriverId;
      }

      const query = getEarningsQuerySchema.parse(req.query);

      const earnings = await driverService.getEarnings(targetDriverId, query.period);

      res.json({
        success: true,
        data: earnings
      });
    } catch (error) {
      return next(error);
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
driverDashboardRouter.get(
  '/trips',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let targetDriverId = req.user!.userId;

      // Phase 5: Transporter can query a specific driver's trips
      // Usage: GET /api/v1/driver/trips?driverId=xxx&status=completed
      if (req.user!.role === 'transporter' && req.query.driverId) {
        const requestedDriverId = req.query.driverId as string;
        // Verify driver belongs to this transporter
        const driver = await fleetCacheService.getDriver(requestedDriverId);
        if (!driver || driver.transporterId !== req.user!.userId) {
          return res.status(403).json({
            success: false,
            error: { code: 'FORBIDDEN', message: 'This driver does not belong to you' }
          });
        }
        targetDriverId = requestedDriverId;
      }

      const { status, limit = 20, offset = 0 } = req.query;

      const trips = await driverService.getTrips(targetDriverId, {
        status: status as string,
        limit: Number(limit),
        offset: Number(offset)
      });

      res.json({
        success: true,
        data: trips
      });
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * GET /api/v1/driver/trips/active
 * Get driver's currently active trip
 */
driverDashboardRouter.get(
  '/trips/active',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let targetDriverId = req.user!.userId;

      // Phase 5: Transporter can query a specific driver's active trip
      if (req.user!.role === 'transporter' && req.query.driverId) {
        const requestedDriverId = req.query.driverId as string;
        const driver = await fleetCacheService.getDriver(requestedDriverId);
        if (!driver || driver.transporterId !== req.user!.userId) {
          return res.status(403).json({
            success: false,
            error: { code: 'FORBIDDEN', message: 'This driver does not belong to you' }
          });
        }
        targetDriverId = requestedDriverId;
      }

      const activeTrip = await driverService.getActiveTrip(targetDriverId);

      res.json({
        success: true,
        data: activeTrip
      });
    } catch (error) {
      return next(error);
    }
  }
);

export { driverDashboardRouter };
