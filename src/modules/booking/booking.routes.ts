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
import { orderService as canonicalOrderService } from '../order/order.service';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { prismaClient } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { bookingQueue, Priority } from '../../shared/resilience/request-queue';
import { validateRequest } from '../../shared/utils/validation.utils';
import { createBookingSchema, createOrderSchema, getBookingsQuerySchema } from './booking.schema';
import {
  buildCreateOrderResponseData,
  normalizeCreateOrderInput,
  toCreateOrderServiceRequest
} from '../order/order.contract';
const router = Router();
const FF_LEGACY_BOOKING_PROXY_TO_ORDER = process.env.FF_LEGACY_BOOKING_PROXY_TO_ORDER !== 'false';

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
      logger.info('[OrderIngress] create_booking_request_legacy', {
        route_path: '/api/v1/bookings',
        route_alias_used: true,
        customerId: req.user!.userId
      });

      res.setHeader('X-Weelo-Legacy-Proxy', FF_LEGACY_BOOKING_PROXY_TO_ORDER ? 'true' : 'false');
      res.setHeader('X-Weelo-Canonical-Path', '/bookings/orders');

      if (FF_LEGACY_BOOKING_PROXY_TO_ORDER) {
        const customerId = req.user!.userId;
        const legacyPayload = req.body as {
          pickup: unknown;
          drop: unknown;
          vehicleType: string;
          vehicleSubtype: string;
          trucksNeeded: number;
          distanceKm: number;
          pricePerTruck: number;
          goodsType?: string;
          cargoWeightKg?: number;
          weight?: string;
          scheduledAt?: string;
        };

        const canonicalInput = normalizeCreateOrderInput({
          pickup: legacyPayload.pickup,
          drop: legacyPayload.drop,
          distanceKm: legacyPayload.distanceKm,
          goodsType: legacyPayload.goodsType,
          cargoWeightKg: legacyPayload.cargoWeightKg,
          weight: legacyPayload.weight,
          scheduledAt: legacyPayload.scheduledAt,
          vehicleRequirements: [{
            vehicleType: legacyPayload.vehicleType,
            vehicleSubtype: legacyPayload.vehicleSubtype,
            quantity: legacyPayload.trucksNeeded,
            pricePerTruck: legacyPayload.pricePerTruck
          }]
        });

        const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;
        const serviceRequest = toCreateOrderServiceRequest(
          canonicalInput,
          {
            id: customerId,
            name: 'Customer',
            phone: req.user!.phone
          },
          idempotencyKey
        );
        const result = await canonicalOrderService.createOrder(serviceRequest);
        const responseData = buildCreateOrderResponseData(
          result,
          canonicalInput,
          {
            id: customerId,
            name: 'Customer',
            phone: req.user!.phone
          }
        );

        logger.info('[OrderIngress] legacy_proxy_used=true', {
          customerId,
          orderId: result.orderId,
          route_path: '/api/v1/bookings',
          canonical_path: '/api/v1/bookings/orders'
        });

        res.status(201).json({
          success: true,
          data: {
            booking: {
              id: responseData.order.id,
              customerId: responseData.order.customerId,
              customerName: responseData.order.customerName,
              customerPhone: responseData.order.customerPhone,
              pickup: responseData.order.pickup,
              drop: responseData.order.drop,
              vehicleType: legacyPayload.vehicleType,
              vehicleSubtype: legacyPayload.vehicleSubtype,
              trucksNeeded: legacyPayload.trucksNeeded,
              trucksFilled: responseData.order.trucksFilled ?? 0,
              distanceKm: responseData.order.distanceKm,
              pricePerTruck: legacyPayload.pricePerTruck,
              totalAmount: responseData.order.totalAmount,
              goodsType: responseData.order.goodsType,
              weight: legacyPayload.weight,
              status: responseData.order.status,
              scheduledAt: responseData.order.scheduledAt,
              expiresAt: responseData.order.expiresAt,
              createdAt: responseData.order.createdAt,
              updatedAt: responseData.order.updatedAt,
              matchingTransportersCount: responseData.broadcastSummary.totalTransportersNotified,
              timeoutSeconds: responseData.timeoutSeconds
            }
          }
        });
        return;
      }

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
          // Batch queries: count rated and total assignments per booking (parallel)
          const [ratedAssignments, totalAssignments] = await Promise.all([
            prismaClient.assignment.groupBy({
              by: ['bookingId'],
              where: {
                bookingId: { in: completedIds },
                status: 'completed',
                customerRating: { not: null }
              },
              _count: { id: true }
            }),
            prismaClient.assignment.groupBy({
              by: ['bookingId'],
              where: {
                bookingId: { in: completedIds },
                status: 'completed'
              },
              _count: { id: true }
            })
          ]);

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
  bookingQueue.middleware({ priority: Priority.HIGH, timeout: 15000 }),
  validateRequest(createOrderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    const customerId = req.user!.userId;
    const lockKey = `order:create:${customerId}`;
    try {
      const lockAcquired = await redisService.acquireLock(lockKey, customerId, 10);
      if (!lockAcquired.acquired) {
        res.status(409).json({
          success: false,
          error: {
            code: 'CONCURRENT_REQUEST',
            message: 'Another order request is being processed. Please wait a moment and try again.',
            data: {
              retryAfter: 2
            }
          }
        });
        return;
      }

      const rateLimit = await canonicalOrderService.checkRateLimit(`order_create:${customerId}`, 5, 60);
      if (!rateLimit.allowed) {
        const retryAfterMs = Math.max(1000, (rateLimit.retryAfter || 1) * 1000);
        res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000).toString());
        res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: `Too many requests. Please wait ${rateLimit.retryAfter} seconds before trying again.`,
            retryAfterMs,
            data: {
              retryAfter: rateLimit.retryAfter,
              retryAfterMs,
              limit: 5,
              window: '1 minute'
            }
          }
        });
        return;
      }

      logger.info('[OrderIngress] create_order_request', {
        route_path: '/api/v1/bookings/orders',
        route_alias_used: false,
        customerId
      });

      const normalizedInput = normalizeCreateOrderInput(req.body);
      const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;
      const serviceRequest = toCreateOrderServiceRequest(
        normalizedInput,
        {
          id: customerId,
          name: 'Customer',
          phone: req.user!.phone
        },
        idempotencyKey
      );
      const result = await canonicalOrderService.createOrder(serviceRequest);
      
      res.status(201).json({
        success: true,
        data: buildCreateOrderResponseData(
          result,
          normalizedInput,
          {
            id: req.user!.userId,
            name: 'Customer',
            phone: req.user!.phone
          }
        )
      });
    } catch (error) {
      next(error);
    } finally {
      await redisService.releaseLock(lockKey, customerId).catch(() => {});
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
      
      const result = await canonicalOrderService.getCustomerOrders(req.user!.userId, page, limit);
      
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
      const result = await canonicalOrderService.getOrderWithRequests(
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
 * @route   POST /bookings/orders/:orderId/cancel
 * @desc    Cancel order (canonical alias path)
 * @access  Customer only
 */
router.post(
  '/orders/:orderId/cancel',
  authMiddleware,
  roleGuard(['customer']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      logger.info('[OrderIngress] cancel_order_request', {
        route_path: '/api/v1/bookings/orders/:orderId/cancel',
        route_alias_used: false,
        customerId: req.user!.userId,
        orderId: req.params.orderId
      });

      const { orderId } = req.params;
      const { reason } = req.body ?? {};
      const result = await canonicalOrderService.cancelOrder(orderId, req.user!.userId, reason);

      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'CANCEL_FAILED',
            message: result.message
          }
        });
      }

      res.json({
        success: true,
        data: {
          orderId,
          status: 'cancelled',
          reason: reason || 'Cancelled by customer',
          transportersNotified: result.transportersNotified,
          cancelledAt: new Date().toISOString()
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /bookings/orders/:orderId/status
 * @desc    Get order status + remaining seconds (canonical alias path)
 * @access  Customer only
 */
router.get(
  '/orders/:orderId/status',
  authMiddleware,
  roleGuard(['customer']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      logger.info('[OrderIngress] order_status_request', {
        route_path: '/api/v1/bookings/orders/:orderId/status',
        route_alias_used: false,
        customerId: req.user!.userId,
        orderId
      });

      const details = await canonicalOrderService.getOrderDetails(orderId);
      if (!details) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'ORDER_NOT_FOUND',
            message: 'Order not found'
          }
        });
      }

      const nowMs = Date.now();
      const expiresAtMs = new Date(details.expiresAt).getTime();
      const remainingMs = Math.max(0, expiresAtMs - nowMs);
      const remainingSeconds = Math.floor(remainingMs / 1000);
      const activeStatuses = new Set(['created', 'broadcasting', 'active', 'partially_filled']);
      const isActive = activeStatuses.has(details.status) && remainingSeconds > 0;

      res.json({
        success: true,
        data: {
          orderId: details.id,
          status: details.status,
          remainingSeconds,
          isActive,
          expiresAt: details.expiresAt
        }
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
      const result = await canonicalOrderService.getActiveTruckRequestsForTransporter(req.user!.userId);
      
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
      
      const request = await canonicalOrderService.acceptTruckRequest(
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
