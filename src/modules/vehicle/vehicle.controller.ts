/**
 * =============================================================================
 * VEHICLE MODULE - CONTROLLER
 * =============================================================================
 */

import { Request, Response, NextFunction } from 'express';
import { vehicleService } from './vehicle.service';
import { 
  registerVehicleSchema, 
  updateVehicleSchema,
  pricingQuerySchema,
  getVehiclesQuerySchema 
} from './vehicle.schema';
import { validateSchema } from '../../shared/utils/validation.utils';
import { successResponse } from '../../shared/types/api.types';
import { asyncHandler } from '../../shared/middleware/error.middleware';

class VehicleController {
  /**
   * Get vehicle types catalog
   */
  getVehicleTypes = asyncHandler(async (_req: Request, res: Response, _next: NextFunction) => {
    const types = await vehicleService.getVehicleTypes();
    res.json(successResponse({ types }));
  });

  /**
   * Calculate pricing for a route
   */
  calculatePricing = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const query = validateSchema(pricingQuerySchema, req.query);
    const pricing = await vehicleService.calculatePricing({
      vehicleType: query.vehicleType,
      distanceKm: query.distanceKm,
      trucksNeeded: query.trucksNeeded ?? 1
    });
    res.json(successResponse({ pricing }));
  });

  /**
   * Check if vehicle number is available for registration
   * GET /api/v1/vehicles/check/:vehicleNumber
   * 
   * Returns:
   * - available: boolean - true if can be registered
   * - exists: boolean - true if vehicle exists in system
   * - ownedByYou: boolean - true if vehicle belongs to calling transporter
   * - vehicleId: string - ID of existing vehicle (if exists and owned by you)
   */
  checkVehicleAvailability = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { vehicleNumber } = req.params;
    const transporterId = req.userId;
    
    const result = await vehicleService.checkVehicleAvailability(vehicleNumber, transporterId);
    
    res.json(successResponse(result));
  });

  /**
   * Register a new vehicle
   * POST /api/v1/vehicles
   * 
   * Returns 409 if vehicle already exists (use upsert for update-or-create)
   */
  registerVehicle = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const transporterId = req.userId!;
    const data = validateSchema(registerVehicleSchema, req.body);
    
    const vehicle = await vehicleService.registerVehicle(transporterId, data);
    
    res.status(201).json(successResponse({ vehicle }));
  });

  /**
   * Register or Update vehicle (Upsert)
   * PUT /api/v1/vehicles/upsert
   * 
   * - If vehicle doesn't exist: creates new vehicle
   * - If vehicle exists and belongs to you: updates it
   * - If vehicle exists and belongs to someone else: returns 409 error
   * 
   * Response includes `isNew` flag to indicate if vehicle was created or updated
   */
  upsertVehicle = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const transporterId = req.userId!;
    const data = validateSchema(registerVehicleSchema, req.body);
    
    const result = await vehicleService.registerOrUpdateVehicle(transporterId, data);
    
    res.status(result.isNew ? 201 : 200).json(successResponse({
      vehicle: result.vehicle,
      isNew: result.isNew,
      message: result.isNew 
        ? `Vehicle ${result.vehicle.vehicleNumber} registered successfully`
        : `Vehicle ${result.vehicle.vehicleNumber} updated successfully`
    }));
  });

  /**
   * Get transporter's vehicles
   */
  getMyVehicles = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const transporterId = req.userId!;
    const query = validateSchema(getVehiclesQuerySchema, req.query);
    
    const result = await vehicleService.getTransporterVehicles(transporterId, {
      ...query,
      page: query.page ?? 1,
      limit: query.limit ?? 20
    });
    
    res.json(successResponse(result.vehicles, {
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      total: result.total,
      hasMore: result.hasMore
    }));
  });

  /**
   * Get vehicle by ID
   */
  getVehicleById = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const vehicle = await vehicleService.getVehicleById(id);
    res.json(successResponse({ vehicle }));
  });

  /**
   * Update vehicle
   */
  updateVehicle = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const transporterId = req.userId!;
    const data = validateSchema(updateVehicleSchema, req.body);
    
    const vehicle = await vehicleService.updateVehicle(id, transporterId, data);
    
    res.json(successResponse({ vehicle }));
  });

  /**
   * Delete vehicle
   */
  deleteVehicle = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const transporterId = req.userId!;
    
    await vehicleService.deleteVehicle(id, transporterId);
    
    res.json(successResponse({ message: 'Vehicle deleted successfully' }));
  });
}

export const vehicleController = new VehicleController();
