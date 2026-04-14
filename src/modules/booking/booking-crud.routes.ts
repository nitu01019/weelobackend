// TODO(L-08): This route file is not mounted in server.ts. Wire it when the booking module split is completed.

/**
 * =============================================================================
 * BOOKING CRUD ROUTES - Core booking + order CRUD endpoints
 * =============================================================================
 *
 * Extracted from booking.routes.ts (file-split).
 * Contains: POST /bookings, GET /bookings, GET /bookings/active,
 *           GET /bookings/:id, GET /bookings/:id/trucks, PATCH /bookings/:id/cancel,
 *           POST /bookings/orders, GET /bookings/orders, GET /bookings/orders/:id,
 *           POST /bookings/requests/:id/accept, GET /bookings/requests/active.
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
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

const router = Router();

// Rate limit for legacy POST /bookings
const legacyBookingRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req: Request) => {
    return `booking:legacy:${(req as any).user?.userId || req.ip || 'unknown'}`;
  },
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many booking requests. Please wait before trying again.',
      }
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});
const FF_LEGACY_BOOKING_PROXY_TO_ORDER = process.env.FF_LEGACY_BOOKING_PROXY_TO_ORDER !== 'false';

function mapOrderResponseToLegacyBooking(
  responseData: ReturnType<typeof buildCreateOrderResponseData>,
  legacyPayload: {
    vehicleType: string;
    vehicleSubtype: string;
    trucksNeeded: number;
    pricePerTruck: number;
    weight?: string;
  }
): Record<string, unknown> {
  return {
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
    timeoutSeconds: responseData.timeoutSeconds,
  };
}

export function buildSyncCursorFromOrders(
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

export function parseSyncCursorMs(syncCursor: unknown): number | null {
  if (typeof syncCursor !== 'string' || syncCursor.trim().length === 0) return null;
  const parsed = Date.parse(syncCursor);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

// POST /bookings (legacy)
// @deprecated Use POST /api/v1/orders instead. This legacy route will be removed in a future version.
router.post(
  '/',
  authMiddleware,
  roleGuard(['customer']),
  legacyBookingRateLimit,
  bookingQueue.middleware({ priority: Priority.HIGH, timeout: 15000 }),
  validateRequest(createBookingSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // M16: Deprecation headers — canonical route is POST /api/v1/orders
      res.setHeader('X-Deprecated', 'true');
      res.setHeader('X-Deprecated-Reason', 'Use POST /api/v1/orders instead');
      logger.info('[OrderIngress] create_booking_request_legacy', {
        route_path: '/api/v1/bookings', route_alias_used: true, customerId: req.user!.userId
      });
      res.setHeader('X-Weelo-Legacy-Proxy', FF_LEGACY_BOOKING_PROXY_TO_ORDER ? 'true' : 'false');
      res.setHeader('X-Weelo-Canonical-Path', '/bookings/orders');

      if (FF_LEGACY_BOOKING_PROXY_TO_ORDER) {
        const customerId = req.user!.userId;
        const legacyPayload = req.body as any;
        const canonicalInput = normalizeCreateOrderInput({
          pickup: legacyPayload.pickup, drop: legacyPayload.drop,
          distanceKm: legacyPayload.distanceKm, goodsType: legacyPayload.goodsType,
          cargoWeightKg: legacyPayload.cargoWeightKg, weight: legacyPayload.weight,
          scheduledAt: legacyPayload.scheduledAt,
          vehicleRequirements: [{
            vehicleType: legacyPayload.vehicleType, vehicleSubtype: legacyPayload.vehicleSubtype,
            quantity: legacyPayload.trucksNeeded, pricePerTruck: legacyPayload.pricePerTruck
          }]
        });
        const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;
        const serviceRequest = toCreateOrderServiceRequest(
          canonicalInput, { id: customerId, name: 'Customer', phone: req.user!.phone }, idempotencyKey
        );
        const result = await canonicalOrderService.createOrder(serviceRequest);
        const responseData = buildCreateOrderResponseData(
          result, canonicalInput, { id: customerId, name: 'Customer', phone: req.user!.phone }
        );
        logger.info('[OrderIngress] legacy_proxy_used=true', { customerId, orderId: result.orderId });
        res.status(201).json({
          success: true,
          data: { booking: mapOrderResponseToLegacyBooking(responseData, legacyPayload) }
        });
        return;
      }

      const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;
      const booking = await bookingService.createBooking(req.user!.userId, req.user!.phone, req.body, idempotencyKey);
      res.status(201).json({ success: true, data: { booking } });
    } catch (error) { return next(error); }
  }
);

// GET /bookings
router.get(
  '/',
  authMiddleware,
  roleGuard(['customer']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = getBookingsQuerySchema.parse(req.query);
      const result = await bookingService.getCustomerBookings(req.user!.userId, query);
      const completedIds = result.bookings.filter(b => b.status === 'completed').map(b => b.id);
      let ratingStatusMap: Record<string, boolean> = {};
      if (completedIds.length > 0) {
        try {
          const [ratedAssignments, totalAssignments] = await Promise.all([
            prismaClient.assignment.groupBy({
              by: ['bookingId'],
              where: { bookingId: { in: completedIds }, status: 'completed', customerRating: { not: null } },
              _count: { id: true }
            }),
            prismaClient.assignment.groupBy({
              by: ['bookingId'],
              where: { bookingId: { in: completedIds }, status: 'completed' },
              _count: { id: true }
            })
          ]);
          const ratedMap = new Map(ratedAssignments.map(r => [r.bookingId, r._count.id]));
          const totalMap = new Map(totalAssignments.map(t => [t.bookingId, t._count.id]));
          for (const id of completedIds) {
            const rated = ratedMap.get(id) || 0;
            const total = totalMap.get(id) || 0;
            ratingStatusMap[id] = total > 0 && rated >= total;
          }
        } catch (err) {
          logger.warn('[BOOKINGS] Rating status check failed', { error: (err as Error).message });
        }
      }
      const enrichedBookings = result.bookings.map(b => ({
        ...b,
        isRated: b.status === 'completed' ? (ratingStatusMap[b.id] ?? false) : undefined,
        hasUnratedTrips: b.status === 'completed' ? !(ratingStatusMap[b.id] ?? false) : undefined
      }));
      res.json({ success: true, data: { ...result, bookings: enrichedBookings } });
    } catch (error) { return next(error); }
  }
);

// GET /bookings/active
router.get(
  '/active',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = getBookingsQuerySchema.parse(req.query);
      const result = await bookingService.getActiveBroadcasts(req.user!.userId, query);
      res.json({ success: true, data: result });
    } catch (error) { return next(error); }
  }
);

// GET /bookings/:id
router.get(
  '/:id',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const booking = await bookingService.getBookingById(req.params.id, req.user!.userId, req.user!.role);
      res.json({ success: true, data: { booking } });
    } catch (error) { return next(error); }
  }
);

// GET /bookings/:id/trucks
router.get(
  '/:id/trucks',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const trucks = await bookingService.getAssignedTrucks(req.params.id, req.user!.userId, req.user!.role);
      res.json({ success: true, data: { trucks } });
    } catch (error) { return next(error); }
  }
);

// PATCH /bookings/:id/cancel
router.patch(
  '/:id/cancel',
  authMiddleware,
  roleGuard(['customer']),
  bookingQueue.middleware({ priority: Priority.HIGH, timeout: 12000 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const booking = await bookingService.cancelBooking(req.params.id, req.user!.userId);
      res.json({ success: true, data: { booking } });
    } catch (error) { return next(error); }
  }
);

// POST /bookings/orders
// @deprecated Use POST /api/v1/orders instead. This secondary route will be removed in a future version.
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
    try {
      const lockAcquired = await redisService.acquireLock(lockKey, customerId, 10);
      if (!lockAcquired.acquired) {
        res.status(409).json({
          success: false,
          error: { code: 'CONCURRENT_REQUEST', message: 'Another order request is being processed.', data: { retryAfter: 2 } }
        });
        return;
      }
      const rateLimit = await canonicalOrderService.checkRateLimit(`order_create:${customerId}`, 5, 60);
      if (!rateLimit.allowed) {
        const retryAfterMs = Math.max(1000, (rateLimit.retryAfter || 1) * 1000);
        res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000).toString());
        res.status(429).json({
          success: false,
          error: { code: 'RATE_LIMIT_EXCEEDED', message: `Too many requests. Please wait.`, retryAfterMs, data: { retryAfter: rateLimit.retryAfter, retryAfterMs, limit: 5, window: '1 minute' } }
        });
        return;
      }
      logger.info('[OrderIngress] create_order_request', { route_path: '/api/v1/bookings/orders', customerId });
      const normalizedInput = normalizeCreateOrderInput(req.body);
      const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;
      const serviceRequest = toCreateOrderServiceRequest(
        normalizedInput, { id: customerId, name: 'Customer', phone: req.user!.phone }, idempotencyKey
      );
      const result = await canonicalOrderService.createOrder(serviceRequest);
      res.status(201).json({
        success: true,
        data: buildCreateOrderResponseData(result, normalizedInput, { id: req.user!.userId, name: 'Customer', phone: req.user!.phone })
      });
    } catch (error) { return next(error); }
    finally { await redisService.releaseLock(lockKey, customerId).catch(() => { }); }
  }
);

// GET /bookings/orders
router.get(
  '/orders',
  authMiddleware,
  roleGuard(['customer']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const result = await canonicalOrderService.getCustomerOrders(req.user!.userId, page, limit);
      res.json({ success: true, data: result });
    } catch (error) { return next(error); }
  }
);

// GET /bookings/orders/:id
router.get(
  '/orders/:id',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await canonicalOrderService.getOrderWithRequests(req.params.id, req.user!.userId, req.user!.role);
      res.json({ success: true, data: result });
    } catch (error) { return next(error); }
  }
);

// GET /bookings/requests/active
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
      res.json({ success: true, data: { orders: responseOrders, count: result.length, syncCursor, snapshotUnchanged } });
    } catch (error) { return next(error); }
  }
);

// POST /bookings/requests/:id/accept
router.post(
  '/requests/:id/accept',
  authMiddleware,
  roleGuard(['transporter']),
  validateRequest(acceptTruckRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    const truckRequestId = req.params.id;
    const lockKey = 'lock:truck-request:' + truckRequestId;
    let lock = { acquired: false };
    try { lock = await redisService.acquireLock(lockKey, 'accept-handler', 15); }
    catch (lockErr: any) { logger.warn('[ACCEPT] Lock acquisition failed', { error: lockErr?.message }); }
    try {
      const { vehicleId, driverId } = req.body;
      if (!vehicleId) {
        return res.status(400).json({ success: false, error: { code: 'VEHICLE_REQUIRED', message: 'vehicleId is required' } });
      }
      const request = await canonicalOrderService.acceptTruckRequest(req.params.id, req.user!.userId, vehicleId, driverId);
      res.json({ success: true, data: { request } });
    } catch (error) { return next(error); }
    finally { if (lock.acquired) { await redisService.releaseLock(lockKey, 'accept-handler').catch(() => { }); } }
  }
);

export { router as bookingCrudRouter };
