/**
 * =============================================================================
 * VEHICLE MODULE - ROUTES (Clean Rewrite)
 * =============================================================================
 * 
 * API routes for vehicle registration and management.
 * Transporters use these to register and manage their trucks.
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { vehicleService } from './vehicle.service';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { db } from '../../shared/database/db';
import { validateSchema } from '../../shared/utils/validation.utils';
import {
  registerVehicleSchema,
  updateVehicleSchema,
  assignDriverSchema,
  getVehiclesQuerySchema,
  updateStatusSchema,
  setMaintenanceSchema
} from './vehicle.schema';
import { logger } from '../../shared/services/logger.service';
import { fleetCacheService, onVehicleChange } from '../../shared/services/fleet-cache.service';

const router = Router();

// =============================================================================
// PUBLIC ROUTES (No auth required)
// =============================================================================

/**
 * @route   GET /vehicles/types
 * @desc    Get available vehicle types catalog
 * @access  Public
 */
router.get('/types', async (_req: Request, res: Response) => {
  try {
    const types = [
      { type: 'mini', name: 'Mini/Pickup', subtypes: ['Tata Ace', 'Dost'] },
      { type: 'lcv', name: 'LCV', subtypes: ['14ft Open', '17ft Open', '19ft Open', '14ft Container', '17ft Container'] },
      { type: 'open', name: 'Open Truck', subtypes: ['17 Feet', '19 Feet', '20 Feet', '22 Feet', '24 Feet'] },
      { type: 'container', name: 'Container', subtypes: ['19 Feet', '20 Feet', '24 Feet', '32 Feet Single', '32 Feet Multi'] },
      { type: 'trailer', name: 'Trailer', subtypes: ['20-22 Ton', '23-25 Ton', '26-28 Ton', '32-35 Ton'] },
      { type: 'tipper', name: 'Tipper', subtypes: ['9-11 Ton', '15-17 Ton', '20-24 Ton', '25+ Ton'] },
      { type: 'tanker', name: 'Tanker', subtypes: ['12-15 Ton', '16-20 Ton', '21-25 Ton', '30+ Ton'] },
      { type: 'bulker', name: 'Bulker', subtypes: ['20-22 Ton', '23-25 Ton', '26-28 Ton', '32+ Ton'] },
      { type: 'dumper', name: 'Dumper', subtypes: ['9-11 Ton', '16-19 Ton', '20-25 Ton', '30+ Ton'] }
    ];
    
    res.json({
      success: true,
      data: { types }
    });
  } catch (error) {
    logger.error('Error getting vehicle types', error);
    res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Failed to get vehicle types' }
    });
  }
});

// =============================================================================
// PROTECTED ROUTES (Auth required)
// =============================================================================

/**
 * @route   GET /vehicles/list
 * @desc    Get transporter's vehicles with status counts
 * @access  Transporter only
 * 
 * REDIS CACHING:
 * - Cache key: fleet:vehicles:{transporterId}
 * - TTL: 5 minutes
 * - Auto-invalidated on vehicle create/update/delete
 */
router.get(
  '/list',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const forceRefresh = req.query.refresh === 'true';
      
      logger.info(`[Vehicles] Getting vehicles for ${transporterId.substring(0, 8)}... (cache: ${forceRefresh ? 'bypass' : 'enabled'})`);
      
      // Get vehicles from Redis cache (falls back to DB on cache miss)
      const cachedVehicles = await fleetCacheService.getTransporterVehicles(transporterId, forceRefresh);
      
      // Filter only active vehicles
      const vehicles = cachedVehicles.filter(v => v.isActive !== false);
      
      // Calculate status counts
      const available = vehicles.filter(v => v.status === 'available' || !v.status).length;
      const inTransit = vehicles.filter(v => v.status === 'in_transit').length;
      const maintenance = vehicles.filter(v => v.status === 'maintenance').length;
      
      // Normalize vehicles - ensure all have a status field
      const normalizedVehicles = vehicles.map(v => ({
        ...v,
        status: v.status || 'available'
      }));
      
      logger.info(`[Vehicles] Returning ${normalizedVehicles.length} vehicles (${available} available)`);
      
      res.json({
        success: true,
        data: {
          vehicles: normalizedVehicles,
          total: normalizedVehicles.length,
          available,
          inTransit,
          maintenance,
          cached: !forceRefresh  // Indicate if from cache
        }
      });
    } catch (error) {
      logger.error('[Vehicles] Error getting vehicle list', error);
      next(error);
    }
  }
);

/**
 * @route   GET /vehicles/available
 * @desc    Get available vehicles (for trip assignment)
 * @access  Transporter only
 * 
 * REDIS CACHING:
 * - Uses fleet cache with available filter
 * - TTL: 5 minutes
 * - Auto-invalidated on vehicle status change
 * 
 * QUERY PARAMS:
 * - vehicleType: Filter by type (e.g., "Open", "Container")
 * - vehicleSubtype: Filter by subtype (e.g., "17ft")
 * - refresh: Set to "true" to bypass cache
 */
router.get(
  '/available',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const vehicleType = req.query.vehicleType as string | undefined;
      const vehicleSubtype = req.query.vehicleSubtype as string | undefined;
      const forceRefresh = req.query.refresh === 'true';
      
      logger.info(`[Vehicles] Getting available vehicles for ${transporterId.substring(0, 8)}... type: ${vehicleType || 'all'}`);
      
      // Use Redis cache for available vehicles
      const cachedVehicles = await fleetCacheService.getAvailableVehicles(
        transporterId,
        vehicleType,
        vehicleSubtype
      );
      
      logger.info(`[Vehicles] Found ${cachedVehicles.length} available vehicles`);
      
      res.json({
        success: true,
        data: { 
          vehicles: cachedVehicles,
          total: cachedVehicles.length,
          cached: !forceRefresh
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /vehicles/summary
 * @desc    Get vehicle types summary for transporter
 * @access  Transporter only
 */
router.get(
  '/summary',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const summary = await vehicleService.getVehicleTypesSummary(req.user!.userId);
      
      res.json({
        success: true,
        data: { summary }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /vehicles/stats
 * @desc    Get vehicle status statistics
 * @access  Transporter only
 */
router.get(
  '/stats',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await vehicleService.getTransporterVehicles(
        req.user!.userId,
        { page: 1, limit: 1000 }
      );
      
      res.json({
        success: true,
        data: {
          statusCounts: result.statusCounts,
          total: result.total
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /vehicles/check/:vehicleNumber
 * @desc    Check if vehicle number is available for registration
 * @access  Transporter only
 * 
 * RETURNS:
 * - available: true if can be registered as new
 * - exists: true if vehicle exists in system
 * - ownedByYou: true if you already own this vehicle
 * - vehicleId: ID of existing vehicle (if owned by you)
 * 
 * USE CASES:
 * - Check before registering to avoid errors
 * - Determine if should use upsert instead of register
 */
router.get(
  '/check/:vehicleNumber',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { vehicleNumber } = req.params;
      const transporterId = req.user!.userId;
      
      const result = await vehicleService.checkVehicleAvailability(vehicleNumber, transporterId);
      
      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /vehicles
 * @desc    Register a new vehicle
 * @access  Transporter only
 * 
 * NOTE: Returns 409 if vehicle already exists.
 * Use PUT /vehicles/upsert for create-or-update behavior.
 * 
 * AUTO-UPDATE CACHE:
 * - Invalidates fleet:vehicles:{transporterId} on success
 * - Ensures new vehicle appears immediately in truck selection
 */
router.post(
  '/',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      logger.info(`[Vehicles] Registering vehicle for transporter: ${transporterId}`);
      logger.debug(`[Vehicles] Request body: ${JSON.stringify(req.body)}`);
      
      const data = validateSchema(registerVehicleSchema, req.body);
      
      const vehicle = await vehicleService.registerVehicle(transporterId, data);
      
      // AUTO-UPDATE: Invalidate Redis cache so new vehicle appears immediately
      await onVehicleChange(transporterId, vehicle.id);
      logger.info(`[Vehicles] Cache invalidated for transporter ${transporterId.substring(0, 8)}`);
      
      logger.info(`[Vehicles] Vehicle registered: ${vehicle.vehicleNumber}`);
      
      res.status(201).json({
        success: true,
        data: { vehicle },
        message: `Vehicle ${vehicle.vehicleNumber} registered successfully`
      });
    } catch (error: any) {
      logger.error('[Vehicles] Error registering vehicle', error);
      
      // Handle validation errors
      if (error.code === 'VALIDATION_ERROR') {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: error.message }
        });
      }
      
      // Handle duplicate vehicle - same owner
      if (error.code === 'VEHICLE_EXISTS_SAME_OWNER') {
        return res.status(409).json({
          success: false,
          error: { 
            code: 'VEHICLE_EXISTS_SAME_OWNER', 
            message: error.message,
            data: error.data  // Contains vehicleId for update
          }
        });
      }
      
      // Handle duplicate vehicle - different owner
      if (error.code === 'VEHICLE_EXISTS') {
        return res.status(409).json({
          success: false,
          error: { code: 'VEHICLE_EXISTS', message: error.message }
        });
      }
      
      next(error);
    }
  }
);

/**
 * @route   PUT /vehicles/upsert
 * @desc    Register or Update vehicle (Upsert)
 * @access  Transporter only
 * 
 * BEHAVIOR:
 * - If vehicle doesn't exist: creates new vehicle (201)
 * - If vehicle exists and you own it: updates it (200)
 * - If vehicle exists and owned by someone else: returns 409 error
 * 
 * RESPONSE:
 * - vehicle: The created/updated vehicle
 * - isNew: true if created, false if updated
 * - message: Success message
 * 
 * USE THIS FOR:
 * - "Save" buttons where user might be editing existing vehicle
 * - Batch operations where you want to avoid checking first
 */
router.put(
  '/upsert',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      logger.info(`[Vehicles] Upsert vehicle for transporter: ${transporterId}`);
      
      const data = validateSchema(registerVehicleSchema, req.body);
      
      const result = await vehicleService.registerOrUpdateVehicle(transporterId, data);
      
      // AUTO-UPDATE: Invalidate Redis cache
      await onVehicleChange(transporterId, result.vehicle.id);
      
      const action = result.isNew ? 'registered' : 'updated';
      logger.info(`[Vehicles] Vehicle ${action}: ${result.vehicle.vehicleNumber}`);
      
      res.status(result.isNew ? 201 : 200).json({
        success: true,
        data: { 
          vehicle: result.vehicle,
          isNew: result.isNew
        },
        message: `Vehicle ${result.vehicle.vehicleNumber} ${action} successfully`
      });
    } catch (error: any) {
      logger.error('[Vehicles] Error upserting vehicle', error);
      
      // Handle validation errors
      if (error.code === 'VALIDATION_ERROR') {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: error.message }
        });
      }
      
      // Handle duplicate vehicle owned by someone else
      if (error.code === 'VEHICLE_EXISTS') {
        return res.status(409).json({
          success: false,
          error: { code: 'VEHICLE_EXISTS', message: error.message }
        });
      }
      
      next(error);
    }
  }
);

/**
 * @route   GET /vehicles/:vehicleId
 * @desc    Get vehicle details by ID
 * @access  Transporter only (own vehicles)
 */
router.get(
  '/:vehicleId',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { vehicleId } = req.params;
      const transporterId = req.user!.userId;
      
      const vehicle = await vehicleService.getVehicleById(vehicleId);
      
      // Verify ownership
      if (vehicle.transporterId !== transporterId) {
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'This vehicle does not belong to you' }
        });
      }
      
      res.json({
        success: true,
        data: { vehicle }
      });
    } catch (error: any) {
      if (error.code === 'VEHICLE_NOT_FOUND') {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Vehicle not found' }
        });
      }
      next(error);
    }
  }
);

/**
 * @route   PUT /vehicles/:vehicleId
 * @desc    Update vehicle details
 * @access  Transporter only (own vehicles)
 */
router.put(
  '/:vehicleId',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { vehicleId } = req.params;
      const transporterId = req.user!.userId;
      const data = validateSchema(updateVehicleSchema, req.body);
      
      const vehicle = await vehicleService.updateVehicle(vehicleId, transporterId, data);
      
      // AUTO-UPDATE: Invalidate Redis cache
      await onVehicleChange(transporterId, vehicleId);
      
      res.json({
        success: true,
        data: { vehicle }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   DELETE /vehicles/:vehicleId
 * @desc    Delete vehicle (soft delete)
 * @access  Transporter only (own vehicles)
 * 
 * AUTO-UPDATE CACHE: Invalidates on delete
 */
router.delete(
  '/:vehicleId',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { vehicleId } = req.params;
      const transporterId = req.user!.userId;
      
      await vehicleService.deleteVehicle(vehicleId, transporterId);
      
      // AUTO-UPDATE: Invalidate Redis cache
      await onVehicleChange(transporterId, vehicleId);
      
      res.json({
        success: true,
        message: 'Vehicle deleted successfully'
      });
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// STATUS MANAGEMENT ROUTES
// =============================================================================

/**
 * @route   PUT /vehicles/:vehicleId/status
 * @desc    Update vehicle status
 * @access  Transporter only
 * 
 * AUTO-UPDATE CACHE: Invalidates on status change
 * (critical for real-time availability in truck selection)
 */
router.put(
  '/:vehicleId/status',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { vehicleId } = req.params;
      const transporterId = req.user!.userId;
      const data = validateSchema(updateStatusSchema, req.body);
      
      const vehicle = await vehicleService.updateVehicleStatus(
        vehicleId,
        transporterId,
        data.status,
        {
          tripId: data.tripId,
          maintenanceReason: data.maintenanceReason,
          maintenanceEndDate: data.maintenanceEndDate
        }
      );
      
      // AUTO-UPDATE: Invalidate Redis cache (status affects availability)
      await onVehicleChange(transporterId, vehicleId);
      
      res.json({
        success: true,
        message: `Vehicle status updated to ${data.status}`,
        data: { vehicle }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   PUT /vehicles/:vehicleId/maintenance
 * @desc    Put vehicle in maintenance mode
 * @access  Transporter only
 * 
 * AUTO-UPDATE CACHE: Invalidates when vehicle goes to maintenance
 */
router.put(
  '/:vehicleId/maintenance',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { vehicleId } = req.params;
      const transporterId = req.user!.userId;
      const data = validateSchema(setMaintenanceSchema, req.body);
      
      const vehicle = await vehicleService.setMaintenance(
        vehicleId,
        transporterId,
        data.reason,
        data.expectedEndDate
      );
      
      // AUTO-UPDATE: Invalidate Redis cache
      await onVehicleChange(transporterId, vehicleId);
      
      res.json({
        success: true,
        message: 'Vehicle set to maintenance mode',
        data: { vehicle }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   PUT /vehicles/:vehicleId/available
 * @desc    Mark vehicle as available
 * @access  Transporter only
 */
router.put(
  '/:vehicleId/available',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { vehicleId } = req.params;
      const transporterId = req.user!.userId;
      
      const vehicle = await vehicleService.setAvailable(vehicleId, transporterId);
      
      res.json({
        success: true,
        message: 'Vehicle is now available',
        data: { vehicle }
      });
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// DRIVER ASSIGNMENT ROUTES
// =============================================================================

/**
 * @route   POST /vehicles/:vehicleId/assign-driver
 * @desc    Assign driver to vehicle
 * @access  Transporter only
 */
router.post(
  '/:vehicleId/assign-driver',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { vehicleId } = req.params;
      const transporterId = req.user!.userId;
      const data = validateSchema(assignDriverSchema, req.body);
      
      const vehicle = await vehicleService.assignDriver(vehicleId, transporterId, data.driverId);
      
      res.json({
        success: true,
        data: { vehicle },
        message: 'Driver assigned successfully'
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /vehicles/:vehicleId/unassign-driver
 * @desc    Unassign driver from vehicle
 * @access  Transporter only
 */
router.post(
  '/:vehicleId/unassign-driver',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { vehicleId } = req.params;
      const transporterId = req.user!.userId;
      
      const vehicle = await vehicleService.unassignDriver(vehicleId, transporterId);
      
      res.json({
        success: true,
        data: { vehicle },
        message: 'Driver unassigned successfully'
      });
    } catch (error) {
      next(error);
    }
  }
);

export { router as vehicleRouter };
