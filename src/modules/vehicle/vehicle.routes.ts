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
 */
router.get(
  '/list',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      logger.info(`[Vehicles] Getting vehicles for transporter: ${transporterId}`);
      
      // Get all vehicles for this transporter
      const allVehicles = db.getVehiclesByTransporter(transporterId);
      
      // Filter only active vehicles
      const vehicles = allVehicles.filter(v => v.isActive !== false);
      
      // Calculate status counts
      const available = vehicles.filter(v => v.status === 'available' || !v.status).length;
      const inTransit = vehicles.filter(v => v.status === 'in_transit').length;
      const maintenance = vehicles.filter(v => v.status === 'maintenance').length;
      
      // Normalize vehicles - ensure all have a status field
      const normalizedVehicles = vehicles.map(v => ({
        ...v,
        status: v.status || 'available'
      }));
      
      logger.info(`[Vehicles] Returning ${normalizedVehicles.length} vehicles`);
      
      res.json({
        success: true,
        data: {
          vehicles: normalizedVehicles,
          total: normalizedVehicles.length,
          available,
          inTransit,
          maintenance
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
 */
router.get(
  '/available',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const vehicleType = req.query.vehicleType as string | undefined;
      
      const vehicles = await vehicleService.getAvailableVehicles(transporterId, vehicleType);
      
      res.json({
        success: true,
        data: { 
          vehicles,
          total: vehicles.length
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
 * @route   POST /vehicles
 * @desc    Register a new vehicle
 * @access  Transporter only
 */
router.post(
  '/',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      logger.info(`[Vehicles] Registering vehicle for transporter: ${transporterId}`);
      logger.info(`[Vehicles] Request body: ${JSON.stringify(req.body)}`);
      
      const data = validateSchema(registerVehicleSchema, req.body);
      
      const vehicle = await vehicleService.registerVehicle(transporterId, data);
      
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
      
      // Handle duplicate vehicle
      if (error.code === 'VEHICLE_EXISTS') {
        return res.status(400).json({
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
