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
import { z } from 'zod';
import { bookingService } from './booking.service';
import { orderService as canonicalOrderService, ActiveTruckRequestOrderGroup } from '../order/order.service';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { prismaClient } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { bookingQueue, Priority } from '../../shared/resilience/request-queue';
import { validateRequest } from '../../shared/utils/validation.utils';
import { createBookingSchema, createOrderSchema, getBookingsQuerySchema, acceptTruckRequestSchema } from './booking.schema';
import {
  buildCreateOrderResponseData,
  normalizeCreateOrderInput,
  toCreateOrderServiceRequest
} from '../order/order.contract';
// Fix F1: Import shared normalizer instead of local duplicate
import { normalizeOrderLifecycleState } from '../../shared/utils/order-lifecycle.utils';
import { maskPhoneForExternal } from '../../shared/utils/pii.utils';
import crypto from 'crypto';
import { AppError } from '../../shared/types/error.types';
import { emitToUser, SocketEvent } from '../../shared/services/socket.service';
import { setOrderExpiryTimer } from '../order/order-timer.service';

const router = Router();

// F-L2 FIX: Validate route :id params as UUIDs
const uuidParamSchema = z.object({ id: z.string().uuid('Invalid ID format') });
function validateIdParam(req: Request, _res: Response, next: NextFunction) {
  try {
    uuidParamSchema.parse(req.params);
    next();
  } catch (err) {
    next(new AppError(400, 'INVALID_PARAM', 'ID must be a valid UUID'));
  }
}

// F-L2 FIX: Validate route :orderId params as UUIDs
const uuidOrderIdParamSchema = z.object({ orderId: z.string().uuid('Invalid ID format') });
function validateOrderIdParam(req: Request, _res: Response, next: NextFunction) {
  try {
    uuidOrderIdParamSchema.parse(req.params);
    next();
  } catch (err) {
    next(new AppError(400, 'INVALID_PARAM', 'Order ID must be a valid UUID'));
  }
}

// F-L3 FIX: Validate cancel reason length
const cancelBodySchema = z.object({
  reason: z.string().trim().max(500).optional(),
}).passthrough();
const FF_LEGACY_BOOKING_PROXY_TO_ORDER = process.env.FF_LEGACY_BOOKING_PROXY_TO_ORDER !== 'false';
const BROADCAST_TIMEOUT_SECONDS = parseInt(process.env.BROADCAST_TIMEOUT_SECONDS || '120', 10);

// H18: Valid statuses for partial-fill actions (expired or partially_filled)
const PARTIAL_FILL_ACTION_STATUSES = ['expired', 'partially_filled'] as const;

function buildSyncCursorFromOrders(
  orders: ActiveTruckRequestOrderGroup[]
): string {
  const latestMs = orders.reduce((acc, item) => {
    const order = item.order;
    const updatedMs = order.updatedAt ? new Date(order.updatedAt).getTime() : 0;
    const stateChangedMs = order.stateChangedAt ? new Date(order.stateChangedAt).getTime() : 0;
    const createdMs = order.createdAt ? new Date(order.createdAt).getTime() : 0;
    return Math.max(acc, updatedMs, stateChangedMs, createdMs);
  }, 0);
  return new Date(latestMs || Date.now()).toISOString();
}

function parseSyncCursorMs(syncCursor: unknown): number | null {
  if (typeof syncCursor !== 'string' || syncCursor.trim().length === 0) return null;
  const parsed = Date.parse(syncCursor);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

/**
 * @route   POST /bookings
 * @desc    Create new booking (broadcasts to transporters)
 * @access  Customer only
 * @deprecated Use POST /api/v1/orders instead. This legacy route proxies to the
 *             canonical order creation service and will be removed in a future version.
 */
router.post(
  '/',
  authMiddleware,
  roleGuard(['customer']),
  // Fix A7: Rate-limit legacy path to match canonical /orders route
  bookingQueue.middleware({ priority: Priority.HIGH, timeout: 15000 }),
  validateRequest(createBookingSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      logger.info('[OrderIngress] create_booking_request_legacy', {
        route_path: '/api/v1/bookings',
        route_alias_used: true,
        customerId: req.user!.userId
      });

      // M16: Deprecation headers — canonical route is POST /api/v1/orders
      res.setHeader('X-Deprecated', 'true');
      res.setHeader('X-Deprecated-Reason', 'Use POST /api/v1/orders instead');
      res.setHeader('X-Weelo-Legacy-Proxy', FF_LEGACY_BOOKING_PROXY_TO_ORDER ? 'true' : 'false');
      res.setHeader('X-Weelo-Canonical-Path', '/api/v1/orders');

      if (FF_LEGACY_BOOKING_PROXY_TO_ORDER) {
        const customerId = req.user!.userId;

        // M10 FIX: Add distributed Redis lock + per-customer rate limit
        // to match canonical POST /bookings/orders protections
        const lockKey = `order:create:${customerId}`;
        const lockToken = crypto.randomUUID();
        let lockAcquired = { acquired: false };
        try {
          lockAcquired = await redisService.acquireLock(lockKey, lockToken, 10);
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
              name: req.user?.name || 'Customer',
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
              name: req.user?.name || 'Customer',
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
        } finally {
          // M10: Release lock in finally block to prevent deadlocks (same as canonical)
          if (lockAcquired.acquired) {
            await redisService.releaseLock(lockKey, lockToken).catch(() => { });
          }
        }
      }

      const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;
      const booking = await bookingService.createBooking(
        req.user!.userId,
        req.user!.phone,
        req.body,
        idempotencyKey
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
  roleGuard(['customer', 'transporter']),
  validateIdParam,
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
  roleGuard(['customer', 'transporter']),
  validateIdParam,
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
  validateIdParam,
  bookingQueue.middleware({ priority: Priority.HIGH, timeout: 12000 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // F-L3 FIX: Validate cancel reason length
      if (req.body) { cancelBodySchema.parse(req.body); }
      const booking = await bookingService.cancelBooking(
        req.params.id,
        req.user!.userId
      );

      res.json({
        success: true,
        data: { booking }
      });
    } catch (error: any) {
      // C7 FIX: When FF_LEGACY_BOOKING_PROXY_TO_ORDER is on, orders live in Order table.
      // If booking cancel returns 404, fall back to canonical order cancel.
      if (FF_LEGACY_BOOKING_PROXY_TO_ORDER && error?.statusCode === 404) {
        try {
          const { reason } = req.body ?? {};
          const idempotencyKey = req.header('X-Idempotency-Key') || req.header('x-idempotency-key') || undefined;
          const result = await canonicalOrderService.cancelOrder(req.params.id, req.user!.userId, reason, idempotencyKey);

          if (!result.success) {
            const isAuthError = result.message === 'You can only cancel your own orders';
            const statusCode = result.cancelDecision === 'blocked_dispute_only' ? 409 : isAuthError ? 403 : 400;
            return res.status(statusCode).json({
              success: false,
              error: { code: isAuthError ? 'FORBIDDEN' : 'CANCEL_FAILED', message: result.message }
            });
          }

          return res.json({
            success: true,
            data: {
              booking: {
                id: req.params.id,
                status: 'cancelled',
                reason: reason || 'Cancelled by customer',
                cancelledAt: new Date().toISOString()
              }
            }
          });
        } catch (orderError) {
          return next(orderError);
        }
      }
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
 * @deprecated Use POST /api/v1/orders instead. This secondary route duplicates
 *             the canonical order creation endpoint and will be removed in a future version.
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
    // M16: Deprecation headers — canonical route is POST /api/v1/orders
    res.setHeader('X-Deprecated', 'true');
    res.setHeader('X-Deprecated-Reason', 'Use POST /api/v1/orders instead');
    const customerId = req.user!.userId;
    const lockKey = `order:create:${customerId}`;
    const lockToken = crypto.randomUUID();
    try {
      const lockAcquired = await redisService.acquireLock(lockKey, lockToken, 10);
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
          name: req.user?.name || 'Customer',
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
            name: req.user?.name || 'Customer',
            phone: req.user!.phone
          }
        )
      });
    } catch (error) {
      next(error);
    } finally {
      await redisService.releaseLock(lockKey, lockToken).catch(() => { });
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
      const paginationQuery = z.object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }).parse(req.query);
      const page = paginationQuery.page;
      const limit = paginationQuery.limit;

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
  roleGuard(['customer', 'transporter']),
  validateIdParam,
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
  validateOrderIdParam,
  bookingQueue.middleware({ priority: Priority.HIGH, timeout: 12000 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // F-L3 FIX: Validate cancel reason length
      if (req.body) { cancelBodySchema.parse(req.body); }
      logger.info('[OrderIngress] cancel_order_request', {
        route_path: '/api/v1/bookings/orders/:orderId/cancel',
        route_alias_used: false,
        customerId: req.user!.userId,
        orderId: req.params.orderId
      });

      const { orderId } = req.params;
      const { reason } = req.body ?? {};
      const idempotencyKey = req.header('X-Idempotency-Key') || req.header('x-idempotency-key') || undefined;
      const result = await canonicalOrderService.cancelOrder(orderId, req.user!.userId, reason, idempotencyKey);

      if (!result.success) {
        const isAuthError = result.message === 'You can only cancel your own orders';
        const statusCode = result.cancelDecision === 'blocked_dispute_only' ? 409 : isAuthError ? 403 : 400;
        return res.status(statusCode).json({
          success: false,
          error: {
            code: result.cancelDecision === 'blocked_dispute_only' ? 'CANCEL_BLOCKED_DISPUTE_ONLY' : isAuthError ? 'FORBIDDEN' : 'CANCEL_FAILED',
            message: result.message,
            data: {
              policyStage: result.policyStage,
              cancelDecision: result.cancelDecision,
              reasonRequired: result.reasonRequired,
              reasonCode: result.reasonCode,
              penaltyBreakdown: result.penaltyBreakdown,
              driverCompensationBreakdown: result.driverCompensationBreakdown,
              settlementState: result.settlementState,
              pendingPenaltyAmount: result.pendingPenaltyAmount,
              disputeId: result.disputeId,
              eventVersion: result.eventVersion,
              serverTimeMs: result.serverTimeMs
            }
          }
        });
      }

      res.json({
        success: true,
        data: {
          orderId,
          status: 'cancelled',
          reason: reason || 'Cancelled by customer',
          policyStage: result.policyStage,
          cancelDecision: result.cancelDecision,
          reasonRequired: result.reasonRequired,
          reasonCode: result.reasonCode,
          penaltyBreakdown: result.penaltyBreakdown,
          driverCompensationBreakdown: result.driverCompensationBreakdown,
          settlementState: result.settlementState,
          pendingPenaltyAmount: result.pendingPenaltyAmount,
          eventId: result.eventId,
          eventVersion: result.eventVersion,
          serverTimeMs: result.serverTimeMs,
          transportersNotified: result.transportersNotified,
          cancelledAt: new Date().toISOString()
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/orders/:orderId/cancel-preview',
  authMiddleware,
  roleGuard(['customer']),
  validateOrderIdParam,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      const reason = typeof req.query.reason === 'string' ? req.query.reason : undefined;
      const preview = await canonicalOrderService.getCancelPreview(orderId, req.user!.userId, reason);
      if (!preview.success) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'CANCEL_PREVIEW_FAILED',
            message: preview.message
          }
        });
      }

      return res.json({
        success: true,
        data: {
          orderId,
          policyStage: preview.policyStage,
          cancelDecision: preview.cancelDecision,
          reasonRequired: preview.reasonRequired,
          reasonCode: preview.reasonCode,
          penaltyBreakdown: preview.penaltyBreakdown,
          driverCompensationBreakdown: preview.driverCompensationBreakdown,
          settlementState: preview.settlementState,
          pendingPenaltyAmount: preview.pendingPenaltyAmount,
          eventVersion: preview.eventVersion,
          serverTimeMs: preview.serverTimeMs
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/orders/:orderId/cancel/dispute',
  authMiddleware,
  roleGuard(['customer']),
  validateOrderIdParam,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      const reasonCode = typeof req.body?.reasonCode === 'string' ? req.body.reasonCode : undefined;
      const notes = typeof req.body?.notes === 'string' ? req.body.notes : undefined;
      const dispute = await canonicalOrderService.createCancelDispute(orderId, req.user!.userId, reasonCode, notes);

      if (!dispute.success) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'DISPUTE_CREATE_FAILED',
            message: dispute.message,
            data: { stage: dispute.stage }
          }
        });
      }

      return res.json({
        success: true,
        data: {
          disputeId: dispute.disputeId,
          stage: dispute.stage,
          message: dispute.message
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// H18: PARTIAL-FILL ACTION ENDPOINTS
// =============================================================================

/**
 * @route   POST /bookings/orders/:orderId/continue-partial
 * @desc    Accept current partial fill — stop searching, move to fully_filled
 * @access  Customer only
 *
 * When a booking times out with some trucks assigned (partially_filled_expired),
 * the customer can choose to proceed with the trucks already assigned.
 * This transitions the order to fully_filled, adjusts totalTrucks to match
 * trucksFilled, and notifies transporters.
 */
router.post(
  '/orders/:orderId/continue-partial',
  authMiddleware,
  roleGuard(['customer']),
  validateOrderIdParam,
  bookingQueue.middleware({ priority: Priority.HIGH, timeout: 10000 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      const customerId = req.user!.userId;

      // 1. Fetch order
      const order = await canonicalOrderService.getOrderDetails(orderId);
      if (!order) {
        return res.status(404).json({
          success: false,
          error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' }
        });
      }

      // 2. BOLA guard — 404 to prevent info leakage
      if (order.customerId !== customerId) {
        return res.status(404).json({
          success: false,
          error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' }
        });
      }

      // 3. Must have at least 1 truck filled
      if (order.trucksFilled < 1) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'NO_TRUCKS_FILLED',
            message: 'Cannot continue with partial fill — no trucks have been assigned yet.'
          }
        });
      }

      // 4. Must be in a valid state for this action
      if (!PARTIAL_FILL_ACTION_STATUSES.includes(order.status as any)) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'INVALID_ORDER_STATE',
            message: `Cannot continue partial fill — order is in '${order.status}' state.`,
            data: { currentStatus: order.status }
          }
        });
      }

      // 5. CAS update: only transition from allowed states
      const result = await prismaClient.order.updateMany({
        where: {
          id: orderId,
          customerId,
          status: { in: [...PARTIAL_FILL_ACTION_STATUSES] },
        },
        data: {
          status: 'fully_filled',
          totalTrucks: order.trucksFilled,
          stateChangedAt: new Date(),
        }
      });

      if (result.count === 0) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'STATE_RACE',
            message: 'Order state changed before your request could be processed. Please refresh.'
          }
        });
      }

      // 6. Also update unfilled TruckRequests to 'cancelled'
      await prismaClient.truckRequest.updateMany({
        where: {
          orderId,
          status: { in: ['searching', 'expired'] },
        },
        data: { status: 'cancelled' }
      }).catch((err: unknown) => {
        logger.warn('[H18] Failed to cancel unfilled truck requests', { orderId, error: (err as Error).message });
      });

      logger.info('[H18] Customer accepted partial fill', {
        orderId,
        customerId,
        trucksFilled: order.trucksFilled,
        originalTotal: order.totalTrucks,
      });

      // 7. Notify customer
      emitToUser(customerId, SocketEvent.BOOKING_FULLY_FILLED, {
        orderId,
        bookingId: orderId,
        trucksFilled: order.trucksFilled,
        trucksNeeded: order.trucksFilled,
        partialAccepted: true,
        message: `Proceeding with ${order.trucksFilled} truck${order.trucksFilled > 1 ? 's' : ''}. Your booking is confirmed.`
      });

      res.json({
        success: true,
        data: {
          orderId,
          status: 'fully_filled',
          trucksFilled: order.trucksFilled,
          totalTrucks: order.trucksFilled,
          partialAccepted: true,
          message: `Order updated — proceeding with ${order.trucksFilled} of ${order.totalTrucks} trucks.`
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /bookings/orders/:orderId/search-again
 * @desc    Reset search window and continue matching for remaining trucks
 * @access  Customer only
 *
 * When a booking times out (expired or partially_filled), the customer can
 * choose to search again. This extends expiresAt, resets the order to 'active',
 * and restarts the broadcast/dispatch cycle for unfilled truck requests.
 */
router.post(
  '/orders/:orderId/search-again',
  authMiddleware,
  roleGuard(['customer']),
  validateOrderIdParam,
  bookingQueue.middleware({ priority: Priority.HIGH, timeout: 10000 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      const customerId = req.user!.userId;

      // 1. Fetch order
      const order = await canonicalOrderService.getOrderDetails(orderId);
      if (!order) {
        return res.status(404).json({
          success: false,
          error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' }
        });
      }

      // 2. BOLA guard
      if (order.customerId !== customerId) {
        return res.status(404).json({
          success: false,
          error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' }
        });
      }

      // 3. Must be in a valid state for search-again
      if (!PARTIAL_FILL_ACTION_STATUSES.includes(order.status as any)) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'INVALID_ORDER_STATE',
            message: `Cannot search again — order is in '${order.status}' state.`,
            data: { currentStatus: order.status }
          }
        });
      }

      // 4. Must still have unfilled trucks
      const remaining = order.totalTrucks - order.trucksFilled;
      if (remaining <= 0) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'ALL_TRUCKS_FILLED',
            message: 'All trucks are already assigned. No need to search again.'
          }
        });
      }

      // 5. Extend expiresAt and reset status to 'active' (CAS guard)
      const newExpiresAt = new Date(Date.now() + BROADCAST_TIMEOUT_SECONDS * 1000);
      const targetStatus = order.trucksFilled > 0 ? 'partially_filled' : 'active';

      const result = await prismaClient.order.updateMany({
        where: {
          id: orderId,
          customerId,
          status: { in: [...PARTIAL_FILL_ACTION_STATUSES] },
        },
        data: {
          status: targetStatus,
          expiresAt: newExpiresAt.toISOString(),
          stateChangedAt: new Date(),
        }
      });

      if (result.count === 0) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'STATE_RACE',
            message: 'Order state changed before your request could be processed. Please refresh.'
          }
        });
      }

      // 6. Reset unfilled TruckRequests back to 'searching' for re-broadcast
      await prismaClient.truckRequest.updateMany({
        where: {
          orderId,
          status: { in: ['cancelled', 'expired'] },
        },
        data: { status: 'searching' }
      }).catch((err: unknown) => {
        logger.warn('[H18] Failed to reset truck requests for search-again', { orderId, error: (err as Error).message });
      });

      // 7. Restart the order expiry timer
      await setOrderExpiryTimer(orderId, BROADCAST_TIMEOUT_SECONDS * 1000).catch((err: unknown) => {
        logger.warn('[H18] Failed to restart order expiry timer', { orderId, error: (err as Error).message });
      });

      // 8. Set customer active broadcast key so one-per-customer guard works
      await redisService.set(
        `customer:active-broadcast:${customerId}`,
        orderId,
        BROADCAST_TIMEOUT_SECONDS + 30
      ).catch(() => {});

      logger.info('[H18] Customer triggered search-again', {
        orderId,
        customerId,
        trucksFilled: order.trucksFilled,
        remaining,
        newExpiresAt: newExpiresAt.toISOString(),
      });

      // 9. Notify customer
      emitToUser(customerId, SocketEvent.BOOKING_UPDATED, {
        orderId,
        bookingId: orderId,
        status: targetStatus,
        trucksFilled: order.trucksFilled,
        trucksNeeded: order.totalTrucks,
        remainingSeconds: BROADCAST_TIMEOUT_SECONDS,
        expiresAt: newExpiresAt.toISOString(),
        searchRestarted: true,
        message: `Searching for ${remaining} more truck${remaining > 1 ? 's' : ''}...`
      });

      res.json({
        success: true,
        data: {
          orderId,
          status: targetStatus,
          trucksFilled: order.trucksFilled,
          totalTrucks: order.totalTrucks,
          remaining,
          remainingSeconds: BROADCAST_TIMEOUT_SECONDS,
          expiresAt: newExpiresAt.toISOString(),
          searchRestarted: true,
          message: `Search restarted — looking for ${remaining} more truck${remaining > 1 ? 's' : ''}.`
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
  validateOrderIdParam,
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

      // H-S2 FIX: BOLA guard — return 404 (not 403) to prevent info leakage
      if (details.customerId !== req.user!.userId) {
        return res.status(404).json({
          success: false,
          error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' }
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
          expiresAt: details.expiresAt,
          dispatchState: details.dispatchState || 'queued',
          dispatchAttempts: Number(details.dispatchAttempts || 0),
          notifiedTransporters: Number(details.notifiedCount || 0),
          onlineCandidates: Number(details.onlineCandidatesCount || 0),
          reasonCode: details.dispatchReasonCode || null,
          serverTimeMs: Date.now()
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /bookings/orders/:orderId/broadcast-snapshot
 * @desc    Canonical snapshot for transporter/captain reconcile after socket gaps
 * @access  Customer only
 */
router.get(
  '/orders/:orderId/broadcast-snapshot',
  authMiddleware,
  roleGuard(['customer', 'transporter', 'driver']),
  validateOrderIdParam,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      const scopedOrder = await canonicalOrderService.getOrderWithRequests(
        orderId,
        req.user!.userId,
        req.user!.role
      );
      const details = {
        ...scopedOrder.order,
        truckRequests: scopedOrder.requests
      };

      const nowMs = Date.now();
      const expiresAtMs = new Date(details.expiresAt).getTime();
      const lifecycleState = normalizeOrderLifecycleState(details.status);
      const syncCursor = new Date(
        Math.max(
          nowMs,
          new Date(details.updatedAt ?? nowMs).getTime(),
          new Date(details.stateChangedAt ?? nowMs).getTime()
        )
      ).toISOString();

      res.json({
        success: true,
        data: {
          orderId: details.id,
          state: lifecycleState,
          status: details.status,
          dispatchState: details.dispatchState || 'queued',
          reasonCode: details.dispatchReasonCode || null,
          eventVersion: Math.floor(new Date(details.updatedAt ?? Date.now()).getTime() / 1000),
          serverTimeMs: nowMs,
          expiresAtMs,
          syncCursor,
          order: {
            id: details.id,
            customerId: details.customerId,
            customerName: details.customerName,
            customerPhone: maskPhoneForExternal(details.customerPhone),
            pickup: details.pickup,
            drop: details.drop,
            distanceKm: details.distanceKm,
            totalTrucks: details.totalTrucks,
            trucksFilled: details.trucksFilled,
            totalAmount: details.totalAmount,
            goodsType: details.goodsType,
            weight: details.weight,
            status: details.status,
            expiresAt: details.expiresAt,
            createdAt: details.createdAt
          },
          requests: details.truckRequests.map((request) => ({
            id: request.id,
            orderId: request.orderId,
            requestNumber: request.requestNumber,
            vehicleType: request.vehicleType,
            vehicleSubtype: request.vehicleSubtype,
            pricePerTruck: request.pricePerTruck,
            status: request.status,
            assignedTransporterId: request.assignedTransporterId,
            assignedVehicleNumber: request.assignedVehicleNumber,
            assignedDriverName: request.assignedDriverName,
            createdAt: request.createdAt
          }))
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
      const syncCursor = buildSyncCursorFromOrders(result);
      const requestedCursorMs = parseSyncCursorMs(req.query.syncCursor);
      const latestChangeMs = Date.parse(syncCursor);
      const snapshotUnchanged = requestedCursorMs !== null && Number.isFinite(latestChangeMs) && latestChangeMs <= requestedCursorMs;
      const responseOrders = snapshotUnchanged ? [] : result;

      res.json({
        success: true,
        data: {
          orders: responseOrders,
          count: result.length,
          syncCursor,
          snapshotUnchanged
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
  validateIdParam,
  // Fix F5: Zod validation for accept body (vehicleId required UUID, driverId optional UUID)
  validateRequest(acceptTruckRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    // A5#1: Distributed lock on truckRequestId to serialize concurrent accepts.
    // Note: req.params.id is a truckRequestId, not bookingId.
    // CAS inside the transaction is the real safety net; lock reduces wasted work.
    const truckRequestId = req.params.id;
    const lockKey = 'lock:truck-request:' + truckRequestId;
    let lock = { acquired: false };
    try {
      lock = await redisService.acquireLock(lockKey, 'accept-handler', 15);
    } catch (lockErr: any) {
      // Redis failure should not block accepts — CAS is the real guard
      logger.warn('[ACCEPT] Lock acquisition failed, proceeding with CAS only', { error: lockErr?.message });
    }
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
    } finally {
      // Release lock if acquired (safe even if not acquired — releaseLock checks holder)
      if (lock.acquired) {
        await redisService.releaseLock(lockKey, 'accept-handler').catch(() => { });
      }
    }
  }
);

export { router as bookingRouter };
