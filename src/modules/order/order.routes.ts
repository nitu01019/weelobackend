/**
 * =============================================================================
 * ORDER ROUTES - Multi-Vehicle Type Booking System
 * =============================================================================
 * 
 * API Endpoints:
 * - POST /api/v1/orders           - Create new order (customer)
 * - GET  /api/v1/orders           - Get customer's orders
 * - GET  /api/v1/orders/:id       - Get order details
 * - GET  /api/v1/orders/active    - Get active requests for transporter
 * - POST /api/v1/orders/accept    - Accept a truck request (transporter)
 * 
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { orderService } from './order.service';
import { db } from '../../shared/database/db';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { logger } from '../../shared/services/logger.service';
import { emitToUser } from '../../shared/services/socket.service';
import { redisService } from '../../shared/services/redis.service';
import { bookingQueue, trackingQueue, Priority } from '../../shared/resilience/request-queue';
import {
  buildCreateOrderResponseData,
  normalizeCreateOrderInput,
  toCreateOrderServiceRequest
} from './order.contract';
import { z } from 'zod';

const router = Router();

const ACTIVE_ORDER_STATUSES = new Set(['created', 'broadcasting', 'active', 'partially_filled']);

function normalizeOrderStatus(status: unknown): string {
  return typeof status === 'string' ? status.toLowerCase() : '';
}

function normalizeOrderLifecycleState(status: unknown): 'active' | 'cancelled' | 'expired' | 'accepted' {
  const normalized = normalizeOrderStatus(status);
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
  if (normalized === 'expired') return 'expired';
  if (normalized === 'fully_filled' || normalized === 'completed' || normalized === 'closed') return 'accepted';
  return 'active';
}

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const locationSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  address: z.string().min(1),
  city: z.string().optional(),
  state: z.string().optional()
});

const vehicleRequirementSchema = z.object({
  vehicleType: z.string().min(1),
  vehicleSubtype: z.string().min(1),
  quantity: z.number().int().min(1).max(100),
  pricePerTruck: z.number().min(0)
});

const createOrderSchema = z.object({
  pickup: locationSchema,
  drop: locationSchema,
  distanceKm: z.number().min(0),
  vehicleRequirements: z.array(vehicleRequirementSchema).min(1).max(20).optional(),
  trucks: z.array(vehicleRequirementSchema).min(1).max(20).optional(),
  goodsType: z.string().optional(),
  cargoWeightKg: z.number().optional(),
  scheduledAt: z.string().optional()
}).refine(
  (data) => Array.isArray(data.vehicleRequirements) || Array.isArray(data.trucks),
  { message: 'Either vehicleRequirements OR trucks must be provided' }
);

const acceptRequestSchema = z.object({
  truckRequestId: z.string().uuid(),
  vehicleId: z.string().uuid(),
  driverId: z.string().uuid()
});

// =============================================================================
// ROUTES
// =============================================================================

/**
 * GET /api/v1/orders/check-active
 * Check if customer has an active order
 * 
 * MODULARITY: Separate endpoint for checking active orders
 * SCALABILITY: Lightweight query, can handle millions of requests
 * EASY UNDERSTANDING: Returns simple true/false with order details
 * 
 * Role: customer
 */
router.get(
  '/check-active',
  authMiddleware,
  roleGuard(['customer']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const activeOrder = await db.getActiveOrderByCustomer(user.userId);

      res.json({
        success: true,
        data: {
          hasActiveOrder: !!activeOrder,
          activeOrder: activeOrder ? {
            orderId: activeOrder.id,
            status: normalizeOrderStatus(activeOrder.status),
            createdAt: activeOrder.createdAt
          } : null
        }
      });
    } catch (error) {
      logger.error('Check active order error:', error);
      next(error);
    }
  }
);

/**
 * POST /api/v1/orders
 * Create a new order with multiple vehicle types
 * 
 * RULES:
 * 1. ONE ACTIVE ORDER PER CUSTOMER - Customer must cancel current order before creating new one
 * 2. RATE LIMITED - Max 5 orders per minute per customer to prevent abuse
 * 3. DISTRIBUTED LOCK - Prevents race conditions from concurrent requests
 * 4. IDEMPOTENCY - Accepts idempotency key from header for safe retries
 * 
 * Role: customer
 */
router.post(
  '/',
  authMiddleware,
  roleGuard(['customer']),
  bookingQueue.middleware({ priority: Priority.HIGH, timeout: 15000 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;

      // =================================================================
      // DISTRIBUTED LOCK - Prevent concurrent order creation
      // =================================================================
      // SCALABILITY: Redis-based lock works across all server instances
      // EASY UNDERSTANDING: Only one order creation per customer at a time
      // MODULARITY: Lock auto-expires after 10s to prevent deadlocks
      // =================================================================
      const lockKey = `order:create:${user.userId}`;
      const lockAcquired = await redisService.acquireLock(lockKey, user.userId, 10);

      logger.info('[OrderIngress] create_order_request', {
        route_path: '/api/v1/orders',
        route_alias_used: true,
        customerId: user.userId
      });

      if (!lockAcquired.acquired) {
        logger.warn(`🔒 Concurrent order request blocked for customer ${user.phone}`);
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

      logger.debug(`🔓 Lock acquired for customer ${user.phone}, processing order...`);

      // Extract idempotency key early so route-level active-order guard does not
      // block safe retries of the same booking attempt.
      const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;
      if (idempotencyKey) {
        logger.debug(`🔑 Idempotency key received: ${idempotencyKey.substring(0, 8)}...`);
      }

      // =================================================================
      // RULE 1: ONE ACTIVE ORDER PER CUSTOMER
      // Customer must cancel their current order before creating a new one
      // This ensures clean request handling and prevents spam
      // EASY UNDERSTANDING: Clear, user-friendly error message
      // SCALABILITY: Auto-expires old orders to prevent blocking
      // =================================================================
      if (!idempotencyKey) {
        const activeOrder = await db.getActiveOrderByCustomer(user.userId);
        if (activeOrder) {
          logger.warn(`⚠️ Customer ${user.phone} already has active order: ${activeOrder.id}`);
          res.status(400).json({
            success: false,
            error: {
              code: 'ACTIVE_ORDER_EXISTS',
              message: 'You already have an active order. Please wait for it to complete or cancel it first.',
              data: {
                activeOrderId: activeOrder.id,
                createdAt: activeOrder.createdAt,
                status: normalizeOrderStatus(activeOrder.status)
              }
            }
          });
          return;
        }
      }

      // =================================================================
      // RULE 2: RATE LIMITING - Max 5 orders per minute per customer
      // Prevents abuse and ensures fair usage
      // =================================================================
      const rateLimitKey = `order_create:${user.userId}`;
      const rateLimit = await orderService.checkRateLimit(rateLimitKey, 5, 60); // 5 per minute
      if (!rateLimit.allowed) {
        logger.warn(`🚫 Rate limit exceeded for customer ${user.phone}`);
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

      try {
        // Debug: Log raw request body
        logger.info(`[Orders] POST / - Customer: ${user.phone}`);
        logger.info(`[Orders] POST / - Body: ${JSON.stringify(req.body, null, 2)}`);

        // Validate request body
        const validationResult = createOrderSchema.safeParse(req.body);
        if (!validationResult.success) {
          res.status(400).json({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid request data',
              details: validationResult.error.errors
            }
          });
          return;
        }

        const data = validationResult.data;
        const normalizedInput = normalizeCreateOrderInput(data);

        const orderRequest = toCreateOrderServiceRequest(
          normalizedInput,
          {
            id: user.userId,
            name: user.name || 'Customer',
            phone: user.phone
          },
          idempotencyKey
        );

        // Create order and broadcast
        const result = await orderService.createOrder(orderRequest);

        logger.info(`Order created by ${user.phone}: ${result.orderId}`);

        const responseData = buildCreateOrderResponseData(
          result,
          normalizedInput,
          {
            id: user.userId,
            name: user.name || 'Customer',
            phone: user.phone
          }
        );

        res.status(201).json({
          success: true,
          data: responseData
        });

      } catch (error: any) {
        logger.error(`Create order error: ${error.message}`);
        next(error);
      } finally {
        // =================================================================
        // ALWAYS RELEASE LOCK - Even on error
        // =================================================================
        // SCALABILITY: Prevents lock leaks across server instances
        // EASY UNDERSTANDING: Clean resource management
        // MODULARITY: Lock is scoped to this request only
        // =================================================================
        await redisService.releaseLock(lockKey, user.userId);
        logger.debug(`🔓 Lock released for customer ${user.phone}`);
      }
    } catch (error: any) {
      logger.error(`Order creation error: ${error.message}`);
      next(error);
    }
  }
);

/**
 * GET /api/v1/orders
 * Get customer's orders
 * 
 * Role: customer
 */
router.get(
  '/',
  authMiddleware,
  roleGuard(['customer']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;

      const orders = await orderService.getOrdersByCustomer(user.userId);

      res.json({
        success: true,
        data: {
          orders,
          total: orders.length
        }
      });

    } catch (error: any) {
      logger.error(`Get orders error: ${error.message}`);
      next(error);
    }
  }
);

/**
 * GET /api/v1/orders/active
 * Get active truck requests for transporter
 * Returns ONLY requests matching their vehicle types
 * 
 * Role: transporter
 */
router.get(
  '/active',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;

      const requests = await orderService.getActiveRequestsForTransporter(user.userId);

      // Group by order for better display
      const byOrder = new Map<string, any>();
      for (const req of requests) {
        if (!byOrder.has(req.orderId)) {
          byOrder.set(req.orderId, {
            orderId: req.orderId,
            requests: []
          });
        }
        byOrder.get(req.orderId).requests.push(req);
      }

      res.json({
        success: true,
        data: {
          requests,
          total: requests.length,
          byOrder: Array.from(byOrder.values())
        }
      });

    } catch (error: any) {
      logger.error(`Get active requests error: ${error.message}`);
      next(error);
    }
  }
);

/**
 * GET /api/v1/orders/:id
 * Get order details with all truck requests
 * 
 * Role: customer, transporter
 */
router.get(
  '/:id',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const order = await orderService.getOrderDetails(id);

      if (!order) {
        res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Order not found'
          }
        });
        return;
      }

      res.json({
        success: true,
        data: order
      });

    } catch (error: any) {
      logger.error(`Get order details error: ${error.message}`);
      next(error);
    }
  }
);

/**
 * POST /api/v1/orders/accept
 * Accept a truck request (assign vehicle + driver)
 * 
 * Role: transporter
 */
router.post(
  '/accept',
  authMiddleware,
  roleGuard(['transporter']),
  bookingQueue.middleware({ priority: Priority.CRITICAL, timeout: 12000 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Validate request body
      const validationResult = acceptRequestSchema.safeParse(req.body);
      if (!validationResult.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request data',
            details: validationResult.error.errors
          }
        });
        return;
      }

      const { truckRequestId, vehicleId, driverId } = validationResult.data;
      const user = (req as any).user;

      // Accept the request
      const result = await orderService.acceptTruckRequest(
        truckRequestId,
        user.userId,
        vehicleId,
        driverId
      );

      if (!result.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'ACCEPT_FAILED',
            message: result.message
          }
        });
        return;
      }

      res.json({
        success: true,
        data: result
      });

    } catch (error: any) {
      logger.error(`Accept request error: ${error.message}`);
      next(error);
    }
  }
);

/**
 * POST /api/v1/orders/:id/cancel
 * Cancel an order and notify all transporters to stop showing it
 * 
 * IMPORTANT: This broadcasts 'order_cancelled' to ALL transporters who received the broadcast
 * Captain app should listen for this event and remove the order from overlay/list
 * 
 * Role: customer (only the customer who created the order can cancel)
 * 
 * SCALABILITY NOTES:
 * - Uses WebSocket broadcast for instant notification
 * - All transporters with matching vehicle types will receive cancellation
 * - Handles millions of concurrent cancellations efficiently
 */
router.post(
  '/:id/cancel',
  authMiddleware,
  roleGuard(['customer']),
  bookingQueue.middleware({ priority: Priority.HIGH, timeout: 12000 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id: orderId } = req.params;
      const user = (req as any).user;
      const { reason } = req.body;
      const idempotencyKey = req.header('X-Idempotency-Key') || req.header('x-idempotency-key') || undefined;

      logger.info(`📛 Order cancellation requested: ${orderId} by ${user.phone}`);

      // Cancel the order and broadcast to transporters
      const result = await orderService.cancelOrder(orderId, user.userId, reason, idempotencyKey);

      if (!result.success) {
        const statusCode = result.cancelDecision === 'blocked_dispute_only' ? 409 : 400;
        res.status(statusCode).json({
          success: false,
          error: {
            code: result.cancelDecision === 'blocked_dispute_only' ? 'CANCEL_BLOCKED_DISPUTE_ONLY' : 'CANCEL_FAILED',
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
          },
        });
        return;
      }

      logger.info(`✅ Order cancelled: ${orderId}, notified ${result.transportersNotified} transporters`);

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
          driversNotified: result.driversNotified || 0,
          assignmentsCancelled: result.assignmentsCancelled || 0,
          cancelledAt: new Date().toISOString()
        }
      });

    } catch (error: any) {
      logger.error(`Cancel order error: ${error.message}`);
      next(error);
    }
  }
);

// =============================================================================
// ROUTE PROGRESS ENDPOINTS (Intermediate Stops)
// =============================================================================

/**
 * @route   POST /orders/:orderId/reached-stop
 * @desc    Driver reached a stop - increment currentRouteIndex
 * @access  Driver only
 * 
 * FLOW:
 * 1. Driver arrives at stop (pickup, intermediate, or drop)
 * 2. Taps "Reached" button in app
 * 3. Backend increments currentRouteIndex
 * 4. Customer receives update via WebSocket
 * 
 * INDEX PROGRESSION:
 * - 0 = At pickup (initial)
 * - 1 = At first stop (or drop if no stops)
 * - 2 = At second stop (or drop)
 * - N = At drop (final)
 * 
 * IDEMPOTENT: Calling again with same index is ignored
 */
router.post(
  '/:orderId/reached-stop',
  authMiddleware,
  roleGuard(['driver']),
  trackingQueue.middleware({ priority: Priority.NORMAL, timeout: 10000 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      const driverId = req.user!.userId;

      const order = await db.getOrderById(orderId);

      if (!order) {
        return res.status(404).json({
          success: false,
          error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' }
        });
      }

      // Verify driver is assigned to this order
      const assignments = await db.getAssignmentsByOrder(orderId);
      const driverAssignment = assignments.find(a => a.driverId === driverId);

      if (!driverAssignment) {
        return res.status(403).json({
          success: false,
          error: { code: 'NOT_ASSIGNED', message: 'You are not assigned to this order' }
        });
      }

      const currentIndex = order.currentRouteIndex || 0;
      const totalPoints = order.routePoints?.length || 2;

      // Check if already at final stop
      if (currentIndex >= totalPoints - 1) {
        return res.json({
          success: true,
          message: 'Already at final destination',
          data: {
            currentRouteIndex: currentIndex,
            currentPoint: order.routePoints?.[currentIndex] || null,
            nextPoint: null,
            isCompleted: true
          }
        });
      }

      // Increment index
      const newIndex = currentIndex + 1;
      const currentPoint = order.routePoints?.[newIndex];
      const nextPoint = order.routePoints?.[newIndex + 1] || null;
      const isCompleted = newIndex >= totalPoints - 1;

      // Phase 7 (7D): Geofence check — driver must be within 200m of target stop (road distance)
      // Uses Google Directions API for accurate distance. Falls back gracefully.
      if (currentPoint?.latitude && currentPoint?.longitude) {
        const driverLoc = await redisService.getJSON<any>(`driver:location:${driverId}`).catch(() => null);
        if (driverLoc?.latitude && driverLoc?.longitude) {
          const MAX_STOP_DISTANCE_M = parseInt(
            process.env.MAX_STOP_DISTANCE_METERS || '200', 10
          );
          try {
            const { googleMapsService } = await import('../../shared/services/google-maps.service');
            const eta = await googleMapsService.getETA(
              { lat: driverLoc.latitude, lng: driverLoc.longitude },
              { lat: Number(currentPoint.latitude), lng: Number(currentPoint.longitude) }
            );
            if (eta) {
              const roadDistanceM = eta.distanceKm * 1000;
              if (roadDistanceM > MAX_STOP_DISTANCE_M) {
                return res.status(400).json({
                  success: false,
                  error: {
                    code: 'TOO_FAR_FROM_STOP',
                    message: `You are ${Math.round(roadDistanceM)}m away by road. Please move within ${MAX_STOP_DISTANCE_M}m.`
                  }
                });
              }
            }
            // If eta is null (Google API failed), allow through
          } catch (geoErr: any) {
            // Google API failure — allow through, don't block legitimate stops
            logger.warn(`[STOP] Google Directions geofence failed, allowing through: ${geoErr?.message}`);
          }
        }
      }

      // Record arrival time for wait timer
      const now = new Date().toISOString();
      const stopWaitTimers = order.stopWaitTimers || [];

      // Add wait timer for this stop (if it's a STOP, not pickup/drop)
      if (currentPoint?.type === 'STOP') {
        stopWaitTimers.push({
          stopIndex: newIndex,
          arrivedAt: now,
          waitTimeSeconds: 0
        });
      }

      // Update order
      await db.updateOrder(orderId, {
        currentRouteIndex: newIndex,
        stopWaitTimers
      });

      logger.info(`📍 Driver ${driverId} reached stop ${newIndex} of ${totalPoints - 1}`);
      logger.info(`   [${currentPoint?.type}] ${currentPoint?.address}`);

      // Notify customer via WebSocket
      const progressUpdate = {
        type: 'route_progress_updated',
        orderId,
        driverId,
        currentRouteIndex: newIndex,
        currentPoint,
        nextPoint,
        totalPoints,
        isCompleted,
        arrivedAt: now
      };

      emitToUser(order.customerId, 'route_progress_updated', progressUpdate);

      // If completed (reached drop), update order status
      if (isCompleted && currentPoint?.type === 'DROP') {
        await db.updateOrder(orderId, { status: 'completed' });

        // Notify customer
        emitToUser(order.customerId, 'order_completed', {
          orderId,
          completedAt: now
        });

        logger.info(`🎉 Order ${orderId} completed!`);
      }

      res.json({
        success: true,
        message: `Reached ${currentPoint?.type || 'stop'}`,
        data: {
          currentRouteIndex: newIndex,
          currentPoint,
          nextPoint,
          totalPoints,
          isCompleted,
          arrivedAt: now
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /orders/:orderId/route
 * @desc    Get full route with current progress
 * @access  Customer, Driver, Transporter (involved in order)
 * 
 * RESPONSE:
 * {
 *   routePoints: [...],
 *   currentRouteIndex: 1,
 *   totalPoints: 4,
 *   isCompleted: false,
 *   stopWaitTimers: [...]
 * }
 */
router.get(
  '/:orderId/route',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      const userId = req.user!.userId;

      const order = await db.getOrderById(orderId);

      if (!order) {
        return res.status(404).json({
          success: false,
          error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' }
        });
      }

      // Verify user is involved (customer, driver, or transporter)
      const isCustomer = order.customerId === userId;
      const assignments = await db.getAssignmentsByOrder(orderId);
      const isDriverOrTransporter = assignments.some(
        a => a.driverId === userId || a.transporterId === userId
      );

      if (!isCustomer && !isDriverOrTransporter) {
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'You are not involved in this order' }
        });
      }

      const currentIndex = order.currentRouteIndex || 0;
      const routePoints = order.routePoints || [];
      const totalPoints = routePoints.length;
      const currentPoint = routePoints[currentIndex] || null;
      const nextPoint = routePoints[currentIndex + 1] || null;
      const isCompleted = currentIndex >= totalPoints - 1;

      res.json({
        success: true,
        data: {
          orderId,
          routePoints,
          currentRouteIndex: currentIndex,
          currentPoint,
          nextPoint,
          totalPoints,
          totalStops: routePoints.filter(p => p.type === 'STOP').length,
          isCompleted,
          stopWaitTimers: order.stopWaitTimers || []
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /orders/:orderId/departed-stop
 * @desc    Driver departed from a stop - record departure time
 * @access  Driver only
 * 
 * Used for tracking wait time at stops (for extra charges if exceeded)
 */
router.post(
  '/:orderId/departed-stop',
  authMiddleware,
  roleGuard(['driver']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      const driverId = req.user!.userId;

      const order = await db.getOrderById(orderId);

      if (!order) {
        return res.status(404).json({
          success: false,
          error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' }
        });
      }

      // Verify driver is assigned
      const assignments = await db.getAssignmentsByOrder(orderId);
      const driverAssignment = assignments.find(a => a.driverId === driverId);

      if (!driverAssignment) {
        return res.status(403).json({
          success: false,
          error: { code: 'NOT_ASSIGNED', message: 'You are not assigned to this order' }
        });
      }

      const currentIndex = order.currentRouteIndex || 0;
      const stopWaitTimers = order.stopWaitTimers || [];
      const now = new Date().toISOString();

      // Find the current stop timer and update departure
      const timerIndex = stopWaitTimers.findIndex(t => t.stopIndex === currentIndex && !t.departedAt);

      if (timerIndex >= 0) {
        const arrivedAt = new Date(stopWaitTimers[timerIndex].arrivedAt).getTime();
        const departedAt = new Date(now).getTime();
        const waitTimeSeconds = Math.floor((departedAt - arrivedAt) / 1000);

        stopWaitTimers[timerIndex] = {
          ...stopWaitTimers[timerIndex],
          departedAt: now,
          waitTimeSeconds
        };

        await db.updateOrder(orderId, { stopWaitTimers });

        logger.info(`📍 Driver ${driverId} departed stop ${currentIndex}, wait time: ${waitTimeSeconds}s`);
      }

      res.json({
        success: true,
        message: 'Departure recorded',
        data: {
          currentRouteIndex: currentIndex,
          stopWaitTimers
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /api/v1/orders/:orderId/cancel
 * Cancel an active order
 * 
 * SCALABILITY: Uses existing cancelOrder service (already handles Redis cleanup)
 * EASY UNDERSTANDING: Customer can cancel search before driver accepts
 * MODULARITY: Reuses existing cancelOrder logic
 * 
 * Role: customer
 */
router.delete(
  '/:orderId/cancel',
  authMiddleware,
  roleGuard(['customer']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      const user = (req as any).user;
      const idempotencyKey = req.header('X-Idempotency-Key') || req.header('x-idempotency-key') || undefined;

      logger.info(`📛 Cancel request: Order ${orderId} by customer ${user.phone}`);

      // SCALABILITY: Use existing cancelOrder service
      const result = await orderService.cancelOrder(orderId, user.userId, 'Customer cancelled from app', idempotencyKey);

      if (result.success) {
        logger.info(`✅ Order ${orderId} cancelled successfully. Transporters notified: ${result.transportersNotified}`);
        res.json({
          success: true,
          message: result.message,
          data: {
            transportersNotified: result.transportersNotified,
            driversNotified: result.driversNotified || 0,
            assignmentsCancelled: result.assignmentsCancelled || 0,
            eventId: result.eventId,
            eventVersion: result.eventVersion,
            serverTimeMs: result.serverTimeMs
          }
        });
      } else {
        logger.warn(`⚠️ Cancel failed: ${result.message}`);
        const statusCode = result.cancelDecision === 'blocked_dispute_only' ? 409 : 400;
        res.status(statusCode).json({
          success: false,
          error: {
            code: result.cancelDecision === 'blocked_dispute_only' ? 'CANCEL_BLOCKED_DISPUTE_ONLY' : 'CANCEL_FAILED',
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
    } catch (error: any) {
      logger.error(`Cancel order error: ${error.message}`);
      next(error);
    }
  }
);

router.get(
  '/:orderId/cancel-preview',
  authMiddleware,
  roleGuard(['customer']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      const user = (req as any).user;
      const reason = typeof req.query.reason === 'string' ? req.query.reason : undefined;
      const preview = await orderService.getCancelPreview(orderId, user.userId, reason);
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
  '/:orderId/cancel/dispute',
  authMiddleware,
  roleGuard(['customer']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      const user = (req as any).user;
      const reasonCode = typeof req.body?.reasonCode === 'string' ? req.body.reasonCode : undefined;
      const notes = typeof req.body?.notes === 'string' ? req.body.notes : undefined;
      const dispute = await orderService.createCancelDispute(orderId, user.userId, reasonCode, notes);
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

/**
 * GET /api/v1/orders/:orderId/status
 * Get order status and remaining time
 * 
 * SCALABILITY: Used when app resumes to check if order still active
 * EASY UNDERSTANDING: Returns exact remaining seconds from backend
 * MODULARITY: Backend is source of truth for timer
 * 
 * Role: customer
 */
router.get(
  '/:orderId/status',
  authMiddleware,
  roleGuard(['customer']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;

      logger.debug(`📊 Status check: Order ${orderId}`);

      const order = await db.orders.findUnique({
        where: { id: orderId }
      });

      if (!order) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'ORDER_NOT_FOUND',
            message: 'Order not found'
          }
        });
      }

      // SCALABILITY: Calculate remaining time from database timestamp
      // EASY UNDERSTANDING: Backend calculates, UI just displays
      const now = Date.now();
      const expiresAt = new Date(order.expiresAt).getTime();
      const remainingMs = Math.max(0, expiresAt - now);
      const remainingSeconds = Math.floor(remainingMs / 1000);

      const normalizedStatus = normalizeOrderStatus(order.status);
      const isActive = ACTIVE_ORDER_STATUSES.has(normalizedStatus) && remainingSeconds > 0;

      res.json({
        success: true,
        data: {
          orderId: order.id,
          status: normalizedStatus,
          remainingSeconds,
          isActive,
          expiresAt: order.expiresAt,
          dispatchState: (order as any).dispatchState || 'queued',
          dispatchAttempts: Number((order as any).dispatchAttempts || 0),
          notifiedTransporters: Number((order as any).notifiedCount || 0),
          onlineCandidates: Number((order as any).onlineCandidatesCount || 0),
          reasonCode: (order as any).dispatchReasonCode || null,
          serverTimeMs: Date.now()
        }
      });
    } catch (error: any) {
      logger.error(`Get order status error: ${error.message}`);
      next(error);
    }
  }
);

/**
 * GET /api/v1/orders/:orderId/broadcast-snapshot
 * Canonical snapshot for reconnect/stale payload reconciliation.
 */
router.get(
  '/:orderId/broadcast-snapshot',
  authMiddleware,
  roleGuard(['customer']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      const order = await db.orders.findUnique({ where: { id: orderId } });
      if (!order) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'ORDER_NOT_FOUND',
            message: 'Order not found'
          }
        });
      }

      const requests = await db.getTruckRequestsByOrder(orderId);
      const nowMs = Date.now();
      const expiresAtMs = new Date(order.expiresAt).getTime();
      const syncCursor = new Date(
        Math.max(
          nowMs,
          new Date((order as any).updatedAt ?? nowMs).getTime(),
          new Date((order as any).stateChangedAt ?? nowMs).getTime()
        )
      ).toISOString();

      res.json({
        success: true,
        data: {
          orderId: order.id,
          state: normalizeOrderLifecycleState(order.status),
          status: normalizeOrderStatus(order.status),
          dispatchState: (order as any).dispatchState || 'queued',
          reasonCode: (order as any).dispatchReasonCode || null,
          eventVersion: Math.floor(new Date((order as any).updatedAt ?? Date.now()).getTime() / 1000),
          serverTimeMs: nowMs,
          expiresAtMs,
          syncCursor,
          order: {
            id: order.id,
            customerId: order.customerId,
            customerName: order.customerName,
            customerPhone: order.customerPhone,
            pickup: order.pickup,
            drop: order.drop,
            distanceKm: order.distanceKm,
            totalTrucks: order.totalTrucks,
            trucksFilled: order.trucksFilled,
            totalAmount: order.totalAmount,
            goodsType: order.goodsType,
            weight: order.weight,
            status: normalizeOrderStatus(order.status),
            expiresAt: order.expiresAt,
            createdAt: order.createdAt
          },
          requests: requests.map((request) => ({
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
    } catch (error: any) {
      logger.error(`Get broadcast snapshot error: ${error.message}`);
      next(error);
    }
  }
);

// =============================================================================
// GET /pending-settlements — customer-facing pending penalty/settlement dues
// =============================================================================
router.get('/pending-settlements',
  authMiddleware,
  roleGuard(['customer']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const dues = await (orderService as any).prisma.customerPenaltyDue.findMany({
        where: {
          customerId: user.userId,
          state: 'due'
        },
        orderBy: { createdAt: 'desc' },
        take: 20
      });

      const totalPending = dues.reduce((sum: number, d: any) => sum + (Number(d.amount) || 0), 0);

      res.json({
        success: true,
        data: {
          totalPending,
          count: dues.length,
          items: dues.map((d: any) => ({
            id: d.id,
            orderId: d.orderId,
            amount: Number(d.amount) || 0,
            state: d.state,
            nextOrderHint: d.nextOrderHint || 'Will be adjusted on next booking.',
            createdAt: d.createdAt
          }))
        }
      });
    } catch (error: any) {
      logger.error(`Get pending settlements error: ${error.message}`);
      next(error);
    }
  }
);

export default router;
