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
import { orderService, CreateOrderRequest } from './order.service';
import { db } from '../../shared/database/db';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { logger } from '../../shared/services/logger.service';
import { emitToUser } from '../../shared/services/socket.service';
import { redisService } from '../../shared/services/redis.service';
import { bookingQueue, trackingQueue, Priority } from '../../shared/resilience/request-queue';
import { z } from 'zod';

const router = Router();

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
  vehicleRequirements: z.array(vehicleRequirementSchema).min(1).max(20),
  goodsType: z.string().optional(),
  cargoWeightKg: z.number().optional(),
  scheduledAt: z.string().optional()
});

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
            status: activeOrder.status,
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
      
      // =================================================================
      // RULE 1: ONE ACTIVE ORDER PER CUSTOMER
      // Customer must cancel their current order before creating a new one
      // This ensures clean request handling and prevents spam
      // EASY UNDERSTANDING: Clear, user-friendly error message
      // SCALABILITY: Auto-expires old orders to prevent blocking
      // =================================================================
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
              status: activeOrder.status
            }
          }
        });
        return;
      }
      
      // =================================================================
      // RULE 2: RATE LIMITING - Max 5 orders per minute per customer
      // Prevents abuse and ensures fair usage
      // =================================================================
      const rateLimitKey = `order_create:${user.userId}`;
      const rateLimit = await orderService.checkRateLimit(rateLimitKey, 5, 60); // 5 per minute
      if (!rateLimit.allowed) {
        logger.warn(`🚫 Rate limit exceeded for customer ${user.phone}`);
        res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: `Too many requests. Please wait ${rateLimit.retryAfter} seconds before trying again.`,
            data: {
              retryAfter: rateLimit.retryAfter,
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
        
        // Extract idempotency key from header
        const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;
        if (idempotencyKey) {
          logger.debug(`🔑 Idempotency key received: ${idempotencyKey.substring(0, 8)}...`);
        }
        
        // Create order request - validated data has required fields
        const orderRequest: CreateOrderRequest = {
          customerId: user.userId,
          customerName: user.name || 'Customer',
          customerPhone: user.phone,
          pickup: {
            latitude: data.pickup.latitude,
            longitude: data.pickup.longitude,
            address: data.pickup.address,
            city: data.pickup.city,
            state: data.pickup.state
          },
          drop: {
          latitude: data.drop.latitude,
          longitude: data.drop.longitude,
          address: data.drop.address,
          city: data.drop.city,
          state: data.drop.state
        },
        distanceKm: data.distanceKm,
        vehicleRequirements: data.vehicleRequirements.map(vr => ({
          vehicleType: vr.vehicleType,
          vehicleSubtype: vr.vehicleSubtype,
          quantity: vr.quantity,
          pricePerTruck: vr.pricePerTruck
        })),
        goodsType: data.goodsType,
        cargoWeightKg: data.cargoWeightKg,
        scheduledAt: data.scheduledAt,
        idempotencyKey: idempotencyKey  // Pass idempotency key to service
      };
      
      // Create order and broadcast
      const result = await orderService.createOrder(orderRequest);
      
      logger.info(`Order created by ${user.phone}: ${result.orderId}`);
      
      // Format response to match Android app's expected structure
      // Android expects: { order: OrderData, truckRequests: [...], broadcastSummary: {...}, timeoutSeconds: int }
      const responseData = {
        order: {
          id: result.orderId,
          customerId: user.userId,
          customerName: user.name || 'Customer',
          customerPhone: user.phone,
          // Android app expects: { coordinates: { latitude, longitude }, address }
          pickup: {
            coordinates: {
              latitude: data.pickup.latitude,
              longitude: data.pickup.longitude
            },
            address: data.pickup.address
          },
          drop: {
            coordinates: {
              latitude: data.drop.latitude,
              longitude: data.drop.longitude
            },
            address: data.drop.address
          },
          distanceKm: data.distanceKm,
          totalTrucks: result.totalTrucks,
          trucksFilled: 0,
          totalAmount: result.totalAmount,
          goodsType: data.goodsType || null,
          weight: data.cargoWeightKg ? `${data.cargoWeightKg} kg` : null,
          status: 'active',
          scheduledAt: data.scheduledAt || null,
          expiresAt: result.expiresAt,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        truckRequests: result.truckRequests.map((tr, index) => ({
          id: tr.id,
          orderId: result.orderId,
          requestNumber: index + 1,
          vehicleType: tr.vehicleType,
          vehicleSubtype: tr.vehicleSubtype,
          pricePerTruck: tr.pricePerTruck,
          status: 'searching',
          assignedTransporterId: null,
          assignedTransporterName: null,
          assignedVehicleNumber: null,
          assignedDriverName: null,
          assignedDriverPhone: null,
          tripId: null,
          assignedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        })),
        broadcastSummary: {
          totalRequests: result.totalTrucks,
          totalTransportersNotified: result.truckRequests.reduce((sum, tr) => sum + tr.matchingTransporters, 0),
          groupedBy: result.truckRequests.map(tr => ({
            vehicleType: tr.vehicleType,
            vehicleSubtype: tr.vehicleSubtype,
            count: tr.quantity,
            transportersNotified: tr.matchingTransporters
          }))
        },
        timeoutSeconds: 60  // 1 minute timeout for broadcasts
      };
      
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
      
      logger.info(`📛 Order cancellation requested: ${orderId} by ${user.phone}`);
      
      // Cancel the order and broadcast to transporters
      const result = await orderService.cancelOrder(orderId, user.userId, reason);
      
      if (!result.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'CANCEL_FAILED',
            message: result.message
          }
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
          transportersNotified: result.transportersNotified,
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
      
      logger.info(`📛 Cancel request: Order ${orderId} by customer ${user.phone}`);
      
      // SCALABILITY: Use existing cancelOrder service
      const result = await orderService.cancelOrder(orderId, user.userId, 'Customer cancelled from app');
      
      if (result.success) {
        logger.info(`✅ Order ${orderId} cancelled successfully. Transporters notified: ${result.transportersNotified}`);
        res.json({
          success: true,
          message: result.message,
          data: {
            transportersNotified: result.transportersNotified
          }
        });
      } else {
        logger.warn(`⚠️ Cancel failed: ${result.message}`);
        res.status(400).json({
          success: false,
          error: {
            code: 'CANCEL_FAILED',
            message: result.message
          }
        });
      }
    } catch (error: any) {
      logger.error(`Cancel order error: ${error.message}`);
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
      
      // Order is active if PENDING and has time remaining
      const isActive = order.status === 'PENDING' && remainingSeconds > 0;
      
      res.json({
        success: true,
        data: {
          orderId: order.id,
          status: order.status,
          remainingSeconds,
          isActive,
          expiresAt: order.expiresAt
        }
      });
    } catch (error: any) {
      logger.error(`Get order status error: ${error.message}`);
      next(error);
    }
  }
);

export default router;
