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
      ...query,
      trucksNeeded: query.trucksNeeded ?? 1
    });
    res.json(successResponse({ pricing }));
  });

  /**
   * Register a new vehicle
   */
  registerVehicle = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const transporterId = req.userId!;
    const data = validateSchema(registerVehicleSchema, req.body);
    
    const vehicle = await vehicleService.registerVehicle(transporterId, data);
    
    res.status(201).json(successResponse({ vehicle }));
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
