/**
 * =============================================================================
 * BOOKING MODULE - CONTROLLER
 * =============================================================================
 */

import { Request, Response, NextFunction } from 'express';
import { bookingService } from './booking.service';
import { createBookingSchema, getBookingsQuerySchema } from './booking.schema';
import { validateSchema } from '../../shared/utils/validation.utils';
import { successResponse } from '../../shared/types/api.types';
import { asyncHandler } from '../../shared/middleware/error.middleware';

class BookingController {
  /**
   * Create new booking broadcast
   */
  createBooking = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.userId!;
    const userPhone = req.userPhone!;
    const data = validateSchema(createBookingSchema, req.body);
    
    const booking = await bookingService.createBooking(userId, userPhone, data);
    
    res.status(201).json(successResponse({ booking }));
  });

  /**
   * Get customer's bookings
   */
  getMyBookings = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.userId!;
    const query = validateSchema(getBookingsQuerySchema, req.query);
    
    const result = await bookingService.getCustomerBookings(userId, {
      ...query,
      page: query.page ?? 1,
      limit: query.limit ?? 20
    });
    
    res.json(successResponse(result.bookings, {
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      total: result.total,
      hasMore: result.hasMore
    }));
  });

  /**
   * Get active broadcasts (for transporters)
   */
  getActiveBroadcasts = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const transporterId = req.userId!;
    const query = validateSchema(getBookingsQuerySchema, req.query);
    
    const result = await bookingService.getActiveBroadcasts(transporterId, {
      ...query,
      page: query.page ?? 1,
      limit: query.limit ?? 20
    });
    
    res.json(successResponse(result.bookings, {
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      total: result.total,
      hasMore: result.hasMore
    }));
  });

  /**
   * Get booking by ID
   */
  getBookingById = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const userId = req.userId!;
    const userRole = req.userRole!;
    
    const booking = await bookingService.getBookingById(id, userId, userRole);
    
    res.json(successResponse({ booking }));
  });

  /**
   * Get assigned trucks for a booking
   */
  getAssignedTrucks = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const userId = req.userId!;
    const userRole = req.userRole!;
    
    const trucks = await bookingService.getAssignedTrucks(id, userId, userRole);
    
    res.json(successResponse({ trucks }));
  });

  /**
   * Cancel booking
   */
  cancelBooking = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const userId = req.userId!;
    
    const booking = await bookingService.cancelBooking(id, userId);
    
    res.json(successResponse({ booking, message: 'Booking cancelled successfully' }));
  });
}

export const bookingController = new BookingController();
