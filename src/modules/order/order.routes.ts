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
import { orderService, CreateOrderRequest, VehicleRequirement } from './order.service';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { logger } from '../../shared/services/logger.service';
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
 * POST /api/v1/orders
 * Create a new order with multiple vehicle types
 * 
 * Role: customer
 */
router.post(
  '/',
  authMiddleware,
  roleGuard(['customer']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Validate request body
      const validationResult = createOrderSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request data',
            details: validationResult.error.errors
          }
        });
      }
      
      const data = validationResult.data;
      const user = (req as any).user;
      
      // Create order request
      const orderRequest: CreateOrderRequest = {
        customerId: user.userId,
        customerName: user.name || 'Customer',
        customerPhone: user.phone,
        pickup: data.pickup,
        drop: data.drop,
        distanceKm: data.distanceKm,
        vehicleRequirements: data.vehicleRequirements,
        goodsType: data.goodsType,
        cargoWeightKg: data.cargoWeightKg,
        scheduledAt: data.scheduledAt
      };
      
      // Create order and broadcast
      const result = await orderService.createOrder(orderRequest);
      
      logger.info(`Order created by ${user.phone}: ${result.orderId}`);
      
      res.status(201).json({
        success: true,
        data: result
      });
      
    } catch (error: any) {
      logger.error(`Create order error: ${error.message}`);
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
      
      const orders = orderService.getOrdersByCustomer(user.userId);
      
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
      
      const requests = orderService.getActiveRequestsForTransporter(user.userId);
      
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
      
      const order = orderService.getOrderDetails(id);
      
      if (!order) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Order not found'
          }
        });
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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Validate request body
      const validationResult = acceptRequestSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request data',
            details: validationResult.error.errors
          }
        });
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
        return res.status(400).json({
          success: false,
          error: {
            code: 'ACCEPT_FAILED',
            message: result.message
          }
        });
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

export default router;
