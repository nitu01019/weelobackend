/**
 * =============================================================================
 * TRANSPORTER ROUTES - API for transporter operations
 * =============================================================================
 * 
 * ENDPOINTS:
 * - PUT  /api/v1/transporter/availability   - Update online/offline status
 * - GET  /api/v1/transporter/availability   - Get current availability status
 * - GET  /api/v1/transporter/profile        - Get transporter profile
 * - PUT  /api/v1/transporter/profile        - Update transporter profile
 * - GET  /api/v1/transporter/stats          - Get transporter statistics
 * 
 * AVAILABILITY FEATURE:
 * - When transporter is OFFLINE, they won't receive broadcasts
 * - Even if their vehicles match the request
 * - Used for breaks, end of day, etc.
 * 
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { db } from '../../shared/database/db';
import { logger } from '../../shared/services/logger.service';
import { cacheService } from '../../shared/services/cache.service';
import { availabilityService } from '../../shared/services/availability.service';
import { generateVehicleKey } from '../../shared/services/vehicle-key.service';

const router = Router();

// =============================================================================
// AVAILABILITY ENDPOINTS
// =============================================================================

/**
 * PUT /api/v1/transporter/availability
 * Update transporter's online/offline status
 * 
 * Body: { isAvailable: boolean }
 */
router.put(
  '/availability',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const { isAvailable } = req.body;
      
      if (typeof isAvailable !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'isAvailable must be a boolean'
          }
        });
      }
      
      // Update in database
      await db.updateUser(user.userId, {
        isAvailable,
        availabilityUpdatedAt: new Date().toISOString()
      });
      
      // Invalidate cache
      await cacheService.delete(`user:${user.userId}`);
      
      // Invalidate transporter cache for all vehicle types they own
      const vehicles = await db.getVehiclesByTransporter(user.userId);
      const vehicleTypes = new Set(vehicles.map(v => v.vehicleType));
      for (const type of vehicleTypes) {
        await cacheService.delete(`trans:vehicle:${type}:*`);
      }
      
      logger.info(`📢 Transporter ${user.userId} is now ${isAvailable ? 'ONLINE ✅' : 'OFFLINE ❌'}`);
      
      res.json({
        success: true,
        data: {
          isAvailable,
          updatedAt: new Date().toISOString()
        }
      });
      
    } catch (error: any) {
      logger.error(`Update availability error: ${error.message}`);
      next(error);
    }
  }
);

/**
 * GET /api/v1/transporter/availability
 * Get transporter's current availability status
 */
router.get(
  '/availability',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      
      const transporter = await db.getUserById(user.userId);
      
      if (!transporter) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Transporter not found'
          }
        });
      }
      
      res.json({
        success: true,
        data: {
          isAvailable: transporter.isAvailable !== false, // Default to true
          updatedAt: transporter.availabilityUpdatedAt || transporter.updatedAt
        }
      });
      
    } catch (error: any) {
      logger.error(`Get availability error: ${error.message}`);
      next(error);
    }
  }
);

/**
 * POST /api/v1/transporter/heartbeat
 * Update transporter's live location and availability
 * 
 * CALL THIS EVERY 5 SECONDS from the Captain app
 * 
 * This powers the LIVE AVAILABILITY TABLE for proximity-based matching:
 * - Geohash-indexed for fast nearby searches
 * - Stale entries (>60 sec) auto-removed
 * - Used to find top 10 nearby transporters for batch notify
 * 
 * Body: {
 *   latitude: number,
 *   longitude: number,
 *   vehicleId?: string,    // Currently active vehicle (optional)
 *   isOnTrip?: boolean     // Whether currently on a trip
 * }
 */
router.post(
  '/heartbeat',
  authMiddleware,
  roleGuard(['transporter', 'driver']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const { latitude, longitude, vehicleId, isOnTrip } = req.body;
      
      // Validate coordinates
      if (typeof latitude !== 'number' || typeof longitude !== 'number') {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'latitude and longitude are required numbers'
          }
        });
        return;
      }
      
      // Get transporter's vehicles to determine vehicleKey
      const vehicles = await db.getVehiclesByTransporter(user.userId);
      
      if (vehicles.length === 0) {
        res.status(400).json({
          success: false,
          error: {
            code: 'NO_VEHICLES',
            message: 'No vehicles registered. Register a vehicle first.'
          }
        });
        return;
      }
      
      // Use specified vehicle or first available
      const vehicle = vehicleId 
        ? vehicles.find(v => v.id === vehicleId)
        : vehicles.find(v => v.isActive && v.status === 'available') || vehicles[0];
      
      if (!vehicle) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VEHICLE_NOT_FOUND',
            message: 'Specified vehicle not found'
          }
        });
        return;
      }
      
      // Generate vehicle key if not present (legacy vehicle)
      const vehicleKey = vehicle.vehicleKey || generateVehicleKey(vehicle.vehicleType, vehicle.vehicleSubtype);
      
      // Update availability service (geohash-indexed)
      availabilityService.updateAvailability({
        transporterId: user.userId,
        driverId: user.role === 'driver' ? user.userId : undefined,
        vehicleKey,
        vehicleId: vehicle.id,
        latitude,
        longitude,
        isOnTrip: isOnTrip || false
      });
      
      res.json({
        success: true,
        data: {
          registered: true,
          vehicleKey,
          vehicleId: vehicle.id,
          isOnTrip: isOnTrip || false,
          nextHeartbeatMs: availabilityService.HEARTBEAT_INTERVAL_MS
        }
      });
      
    } catch (error: any) {
      logger.error(`Heartbeat error: ${error.message}`);
      next(error);
    }
  }
);

/**
 * DELETE /api/v1/transporter/heartbeat
 * Mark transporter as offline (remove from availability)
 * 
 * Call this when:
 * - App goes to background
 * - User logs out
 * - User toggles offline
 */
router.delete(
  '/heartbeat',
  authMiddleware,
  roleGuard(['transporter', 'driver']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      
      // Remove from availability service
      availabilityService.setOffline(user.userId);
      
      logger.info(`📴 Transporter ${user.userId} went offline`);
      
      res.json({
        success: true,
        data: {
          offline: true,
          timestamp: new Date().toISOString()
        }
      });
      
    } catch (error: any) {
      logger.error(`Offline error: ${error.message}`);
      next(error);
    }
  }
);

/**
 * GET /api/v1/transporter/availability/stats
 * Get live availability statistics (for admin/debugging)
 */
router.get(
  '/availability/stats',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stats = availabilityService.getStats();
      
      res.json({
        success: true,
        data: stats
      });
      
    } catch (error: any) {
      logger.error(`Availability stats error: ${error.message}`);
      next(error);
    }
  }
);

// =============================================================================
// PROFILE ENDPOINTS
// =============================================================================

/**
 * GET /api/v1/transporter/profile
 * Get transporter profile with stats
 */
router.get(
  '/profile',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      
      const transporter = await db.getUserById(user.userId);
      
      if (!transporter) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Transporter not found'
          }
        });
      }
      
      // Get vehicles count
      const vehicles = await db.getVehiclesByTransporter(user.userId);
      const drivers = await db.getDriversByTransporter(user.userId);
      
      res.json({
        success: true,
        data: {
          profile: {
            id: transporter.id,
            name: transporter.name,
            businessName: transporter.businessName,
            phone: transporter.phone,
            email: transporter.email,
            gstNumber: transporter.gstNumber,
            isAvailable: transporter.isAvailable !== false,
            createdAt: transporter.createdAt
          },
          stats: {
            vehiclesCount: vehicles.length,
            driversCount: drivers.length,
            availableVehicles: vehicles.filter(v => v.status === 'available').length,
            activeTrips: vehicles.filter(v => v.status === 'in_transit').length
          }
        }
      });
      
    } catch (error: any) {
      logger.error(`Get profile error: ${error.message}`);
      next(error);
    }
  }
);

/**
 * PUT /api/v1/transporter/profile
 * Update transporter profile
 */
router.put(
  '/profile',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const { name, businessName, email, gstNumber } = req.body;
      
      const updates: any = {};
      if (name) updates.name = name;
      if (businessName) updates.businessName = businessName;
      if (email) updates.email = email;
      if (gstNumber) updates.gstNumber = gstNumber;
      
      await db.updateUser(user.userId, updates);
      
      // Invalidate cache
      await cacheService.delete(`user:${user.userId}`);
      
      const updated = await db.getUserById(user.userId);
      
      logger.info(`Transporter ${user.userId} profile updated`);
      
      res.json({
        success: true,
        data: {
          profile: {
            id: updated?.id,
            name: updated?.name,
            businessName: updated?.businessName,
            phone: updated?.phone,
            email: updated?.email,
            gstNumber: updated?.gstNumber
          }
        }
      });
      
    } catch (error: any) {
      logger.error(`Update profile error: ${error.message}`);
      next(error);
    }
  }
);

// =============================================================================
// STATS ENDPOINTS
// =============================================================================

/**
 * GET /api/v1/transporter/stats
 * Get transporter statistics (earnings, trips, etc.)
 */
router.get(
  '/stats',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      
      // Get all assignments for this transporter
      const assignments = await db.getAssignmentsByTransporter(user.userId);
      
      // Calculate stats
      const totalTrips = assignments.length;
      const completedTrips = assignments.filter(a => a.status === 'completed').length;
      const activeTrips = assignments.filter(a => a.status === 'in_progress' || a.status === 'pending').length;
      
      // TODO: Calculate actual earnings from completed trips
      const totalEarnings = completedTrips * 1500; // Placeholder
      
      res.json({
        success: true,
        data: {
          totalTrips,
          completedTrips,
          activeTrips,
          totalEarnings,
          rating: 4.5, // Placeholder
          acceptanceRate: totalTrips > 0 ? Math.round((completedTrips / totalTrips) * 100) : 100
        }
      });
      
    } catch (error: any) {
      logger.error(`Get stats error: ${error.message}`);
      next(error);
    }
  }
);

export default router;
