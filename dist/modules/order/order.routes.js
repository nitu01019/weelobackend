"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const order_service_1 = require("./order.service");
const auth_middleware_1 = require("../../shared/middleware/auth.middleware");
const logger_service_1 = require("../../shared/services/logger.service");
const zod_1 = require("zod");
const router = (0, express_1.Router)();
// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================
const locationSchema = zod_1.z.object({
    latitude: zod_1.z.number(),
    longitude: zod_1.z.number(),
    address: zod_1.z.string().min(1),
    city: zod_1.z.string().optional(),
    state: zod_1.z.string().optional()
});
const vehicleRequirementSchema = zod_1.z.object({
    vehicleType: zod_1.z.string().min(1),
    vehicleSubtype: zod_1.z.string().min(1),
    quantity: zod_1.z.number().int().min(1).max(100),
    pricePerTruck: zod_1.z.number().min(0)
});
const createOrderSchema = zod_1.z.object({
    pickup: locationSchema,
    drop: locationSchema,
    distanceKm: zod_1.z.number().min(0),
    vehicleRequirements: zod_1.z.array(vehicleRequirementSchema).min(1).max(20),
    goodsType: zod_1.z.string().optional(),
    cargoWeightKg: zod_1.z.number().optional(),
    scheduledAt: zod_1.z.string().optional()
});
const acceptRequestSchema = zod_1.z.object({
    truckRequestId: zod_1.z.string().uuid(),
    vehicleId: zod_1.z.string().uuid(),
    driverId: zod_1.z.string().uuid()
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
router.post('/', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['customer']), async (req, res, next) => {
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
        const user = req.user;
        // Create order request
        const orderRequest = {
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
        const result = await order_service_1.orderService.createOrder(orderRequest);
        logger_service_1.logger.info(`Order created by ${user.phone}: ${result.orderId}`);
        res.status(201).json({
            success: true,
            data: result
        });
    }
    catch (error) {
        logger_service_1.logger.error(`Create order error: ${error.message}`);
        next(error);
    }
});
/**
 * GET /api/v1/orders
 * Get customer's orders
 *
 * Role: customer
 */
router.get('/', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['customer']), async (req, res, next) => {
    try {
        const user = req.user;
        const orders = order_service_1.orderService.getOrdersByCustomer(user.userId);
        res.json({
            success: true,
            data: {
                orders,
                total: orders.length
            }
        });
    }
    catch (error) {
        logger_service_1.logger.error(`Get orders error: ${error.message}`);
        next(error);
    }
});
/**
 * GET /api/v1/orders/active
 * Get active truck requests for transporter
 * Returns ONLY requests matching their vehicle types
 *
 * Role: transporter
 */
router.get('/active', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const user = req.user;
        const requests = order_service_1.orderService.getActiveRequestsForTransporter(user.userId);
        // Group by order for better display
        const byOrder = new Map();
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
    }
    catch (error) {
        logger_service_1.logger.error(`Get active requests error: ${error.message}`);
        next(error);
    }
});
/**
 * GET /api/v1/orders/:id
 * Get order details with all truck requests
 *
 * Role: customer, transporter
 */
router.get('/:id', auth_middleware_1.authMiddleware, async (req, res, next) => {
    try {
        const { id } = req.params;
        const order = order_service_1.orderService.getOrderDetails(id);
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
    }
    catch (error) {
        logger_service_1.logger.error(`Get order details error: ${error.message}`);
        next(error);
    }
});
/**
 * POST /api/v1/orders/accept
 * Accept a truck request (assign vehicle + driver)
 *
 * Role: transporter
 */
router.post('/accept', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
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
        const user = req.user;
        // Accept the request
        const result = await order_service_1.orderService.acceptTruckRequest(truckRequestId, user.userId, vehicleId, driverId);
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
    }
    catch (error) {
        logger_service_1.logger.error(`Accept request error: ${error.message}`);
        next(error);
    }
});
exports.default = router;
//# sourceMappingURL=order.routes.js.map