/**
 * =============================================================================
 * BOOKING MODULE - CONTROLLER
 * =============================================================================
 */
import { Request, Response, NextFunction } from 'express';
declare class BookingController {
    /**
     * Create new booking broadcast
     */
    createBooking: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Get customer's bookings
     */
    getMyBookings: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Get active broadcasts (for transporters)
     */
    getActiveBroadcasts: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Get booking by ID
     */
    getBookingById: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Get assigned trucks for a booking
     */
    getAssignedTrucks: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Cancel booking
     */
    cancelBooking: (req: Request, res: Response, next: NextFunction) => void;
}
export declare const bookingController: BookingController;
export {};
//# sourceMappingURL=booking.controller.d.ts.map