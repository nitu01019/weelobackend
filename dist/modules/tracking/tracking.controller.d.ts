/**
 * =============================================================================
 * TRACKING MODULE - CONTROLLER
 * =============================================================================
 */
import { Request, Response, NextFunction } from 'express';
declare class TrackingController {
    /**
     * Update driver's current location
     */
    updateLocation: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Get current location for a trip
     */
    getCurrentLocation: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Get location history for a trip
     */
    getLocationHistory: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Get all driver locations for a booking (multi-truck view)
     */
    getBookingTracking: (req: Request, res: Response, next: NextFunction) => void;
}
export declare const trackingController: TrackingController;
export {};
//# sourceMappingURL=tracking.controller.d.ts.map