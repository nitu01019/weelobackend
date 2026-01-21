/**
 * =============================================================================
 * VEHICLE MODULE - CONTROLLER
 * =============================================================================
 */
import { Request, Response, NextFunction } from 'express';
declare class VehicleController {
    /**
     * Get vehicle types catalog
     */
    getVehicleTypes: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Calculate pricing for a route
     */
    calculatePricing: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Register a new vehicle
     */
    registerVehicle: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Get transporter's vehicles
     */
    getMyVehicles: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Get vehicle by ID
     */
    getVehicleById: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Update vehicle
     */
    updateVehicle: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Delete vehicle
     */
    deleteVehicle: (req: Request, res: Response, next: NextFunction) => void;
}
export declare const vehicleController: VehicleController;
export {};
//# sourceMappingURL=vehicle.controller.d.ts.map