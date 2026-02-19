/**
 * =============================================================================
 * BOOKING MODULE - ROUTES
 * =============================================================================
 * 
 * API routes for booking/broadcast management.
 * All routes require authentication except where noted.
 * 
 * NEW: Order System Routes (Multi-Truck Requests)
 * - POST /bookings/orders - Create order with multiple truck types
 * - GET /bookings/orders/:id - Get order with all truck requests
 * - GET /bookings/requests/active - Get active truck requests for transporter
 * - POST /bookings/requests/:id/accept - Accept a truck request
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { bookingService } from './booking.service';
import { orderService } from './order.service';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { prismaClient } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { validateRequest } from '../../shared/utils/validation.utils';
import { createBookingSchema, createOrderSchema, getBookingsQuerySchema } from './booking.schema';
const router = Router();

/**
 * @route   POST /bookings
 * @desc    Create new booking (broadcasts to transporters)
 * @access  Customer only
 */
router.post(
  '/',
  authMiddleware,
  roleGuard(['customer']),
  validateRequest(createBookingSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const booking = await bookingService.createBooking(
        req.user!.userId,
        req.user!.phone,
        req.body
      );
      
      res.status(201).json({
        success: true,
        data: { booking }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /bookings
 * @desc    Get customer's bookings with pagination
 * @access  Customer only
 */
router.get(
  '/',
  authMiddleware,
  roleGuard(['customer']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = getBookingsQuerySchema.parse(req.query);
      const result = await bookingService.getCustomerBookings(req.user!.userId, query);

      // Enrich completed bookings with rating status (non-blocking)
      // Allows Customer app to show "Rate" badge on unrated completed bookings
      const completedIds = result.bookings
        .filter(b => b.status === 'completed')
        .map(b => b.id);

      let ratingStatusMap: Record<string, boolean> = {};
      if (completedIds.length > 0) {
        try {
          // Batch query: count rated assignments per booking (single DB call)
          const ratedAssignments = await prismaClient.assignment.groupBy({
            by: ['bookingId'],
            where: {
              bookingId: { in: completedIds },
              status: 'completed',
              customerRating: { not: null }
            },
            _count: { id: true }
          });

          const totalAssignments = await prismaClient.assignment.groupBy({
            by: ['bookingId'],
            where: {
              bookingId: { in: completedIds },
              status: 'completed'
            },
            _count: { id: true }
          });

          const ratedMap = new Map(ratedAssignments.map(r => [r.bookingId, r._count.id]));
          const totalMap = new Map(totalAssignments.map(t => [t.bookingId, t._count.id]));

          for (const id of completedIds) {
            const rated = ratedMap.get(id) || 0;
            const total = totalMap.get(id) || 0;
            // isRated = true only if ALL completed assignments have been rated
            ratingStatusMap[id] = total > 0 && rated >= total;
          }
        } catch (err) {
          // Graceful: if rating check fails, default to not-rated (show Rate button)
          logger.warn('[BOOKINGS] Rating status check failed, defaulting', { error: (err as Error).message });
        }
      }

      // Merge isRated into booking responses
      const enrichedBookings = result.bookings.map(b => ({
        ...b,
        isRated: b.status === 'completed' ? (ratingStatusMap[b.id] ?? false) : undefined,
        hasUnratedTrips: b.status === 'completed' ? !(ratingStatusMap[b.id] ?? false) : undefined
      }));
      
      res.json({
        success: true,
        data: {
          ...result,
          bookings: enrichedBookings
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /bookings/active
 * @desc    Get active broadcasts (for transporters to view and bid)
 * @access  Transporter only
 */
router.get(
  '/active',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = getBookingsQuerySchema.parse(req.query);
      const result = await bookingService.getActiveBroadcasts(req.user!.userId, query);
      
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
 * @route   GET /bookings/:id
 * @desc    Get booking details
 * @access  Customer (own bookings), Transporter (active bookings)
 */
router.get(
  '/:id',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const booking = await bookingService.getBookingById(
        req.params.id,
        req.user!.userId,
        req.user!.role
      );
      
      res.json({
        success: true,
        data: { booking }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /bookings/:id/trucks
 * @desc    Get trucks assigned to a booking
 * @access  Customer (own bookings), Transporter (own assignments)
 */
router.get(
  '/:id/trucks',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const trucks = await bookingService.getAssignedTrucks(
        req.params.id,
        req.user!.userId,
        req.user!.role
      );
      
      res.json({
        success: true,
        data: { trucks }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   PATCH /bookings/:id/cancel
 * @desc    Cancel a booking
 * @access  Customer only (own bookings)
 */
router.patch(
  '/:id/cancel',
  authMiddleware,
  roleGuard(['customer']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const booking = await bookingService.cancelBooking(
        req.params.id,
        req.user!.userId
      );
      
      res.json({
        success: true,
        data: { booking }
      });
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// NEW: ORDER SYSTEM ROUTES (Multi-Truck Requests)
// =============================================================================

/**
 * @route   POST /bookings/orders
 * @desc    Create new order with multiple truck types
 * @access  Customer only
 * 
 * @body {
 *   pickup: { coordinates: { latitude, longitude }, address, city, state },
 *   drop: { coordinates: { latitude, longitude }, address, city, state },
 *   distanceKm: number,
 *   trucks: [
 *     { vehicleType: "open", vehicleSubtype: "17ft", quantity: 2, pricePerTruck: 15000 },
 *     { vehicleType: "container", vehicleSubtype: "4ton", quantity: 3, pricePerTruck: 20000 }
 *   ],
 *   goodsType?: string,
 *   weight?: string
 * }
 * 
 * @response {
 *   order: OrderRecord,
 *   truckRequests: TruckRequestRecord[],
 *   broadcastSummary: { totalRequests, groupedBy, totalTransportersNotified },
 *   timeoutSeconds: number
 * }
 */
router.post(
  '/orders',
  authMiddleware,
  roleGuard(['customer']),
  validateRequest(createOrderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await orderService.createOrder(
        req.user!.userId,
        req.user!.phone,
        req.body
      );
      
      res.status(201).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /bookings/orders
 * @desc    Get customer's orders with pagination
 * @access  Customer only
 */
router.get(
  '/orders',
  authMiddleware,
  roleGuard(['customer']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      
      const result = await orderService.getCustomerOrders(req.user!.userId, page, limit);
      
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
 * @route   GET /bookings/orders/:id
 * @desc    Get order details with all truck requests
 * @access  Customer (own orders), Transporter (matching vehicle types)
 */
router.get(
  '/orders/:id',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await orderService.getOrderWithRequests(
        req.params.id,
        req.user!.userId,
        req.user!.role
      );
      
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
 * @route   GET /bookings/requests/active
 * @desc    Get active truck requests for transporter (only matching vehicle types)
 * @access  Transporter only
 * 
 * Returns truck requests grouped by order, filtered to only show
 * requests that match the transporter's registered vehicle types.
 */
router.get(
  '/requests/active',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await orderService.getActiveTruckRequestsForTransporter(req.user!.userId);
      
      res.json({
        success: true,
        data: { 
          orders: result,
          count: result.length
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /bookings/requests/:id/accept
 * @desc    Accept a truck request (transporter assigns their truck)
 * @access  Transporter only
 * 
 * @body {
 *   vehicleId: string,    // Which vehicle to assign
 *   driverId?: string     // Optional: assign specific driver
 * }
 */
router.post(
  '/requests/:id/accept',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { vehicleId, driverId } = req.body;
      
      if (!vehicleId) {
        return res.status(400).json({
          success: false,
          error: { code: 'VEHICLE_REQUIRED', message: 'vehicleId is required' }
        });
      }
      
      const request = await orderService.acceptTruckRequest(
        req.params.id,
        req.user!.userId,
        vehicleId,
        driverId
      );
      
      res.json({
        success: true,
        data: { request }
      });
    } catch (error) {
      next(error);
    }
  }
);

export { router as bookingRouter };
