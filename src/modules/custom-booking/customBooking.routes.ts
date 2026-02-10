/**
 * =============================================================================
 * CUSTOM BOOKING MODULE - ROUTES
 * =============================================================================
 * 
 * API routes for custom booking requests (long-term contracts).
 * 
 * @route   POST /api/custom-booking      - Create new request
 * @route   GET  /api/custom-booking      - Get customer's requests
 * @route   GET  /api/custom-booking/:id  - Get single request
 * @route   POST /api/custom-booking/:id/cancel - Cancel request
 * 
 * SCALABILITY: 
 * - Rate limiting (10 req/min per user)
 * - Idempotency key for duplicate prevention
 * - Queue-based admin notifications
 * - Pagination on list endpoints
 * 
 * MODULARITY: Completely isolated from instant booking
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../../shared/middleware/auth.middleware';
import { otpRateLimiter } from '../../shared/middleware/rate-limiter.middleware';
import { redisService } from '../../shared/services/redis.service';
import { queueService } from '../../shared/services/queue.service';
import { customBookingService } from './customBooking.service';
import {
    createCustomBookingSchema,
    getRequestsQuerySchema,
    cancelRequestSchema
} from './customBooking.schema';

const router = Router();

/**
 * @route   POST /api/custom-booking
 * @desc    Create new custom booking request
 * @access  Customer only
 * 
 * SCALABILITY:
 * - otpRateLimiter: 10 requests/minute per IP
 * - Idempotency key: Prevents duplicate submissions (24hr cache)
 * - Queue notification: Admin notified asynchronously
 */
router.post(
    '/',
    authMiddleware,
    otpRateLimiter,  // Rate limit: 10 req/min per IP
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            // === IDEMPOTENCY CHECK ===
            // Prevents duplicate submissions if user clicks submit multiple times
            const idempotencyKey = req.headers['x-idempotency-key'] as string;
            if (idempotencyKey) {
                const existing = await redisService.get(`custom_booking:idempotent:${idempotencyKey}`);
                if (existing) {
                    // Return cached response (already processed)
                    return res.status(200).json({
                        success: true,
                        message: 'Request already submitted',
                        data: JSON.parse(existing)
                    });
                }
            }

            // === CREATE REQUEST ===
            const request = await customBookingService.createCustomBookingRequest({
                customerId: req.user!.userId,
                customerName: (req.user as any).name || 'Customer',
                customerPhone: req.user!.phone,
                customerEmail: req.body.customerEmail,
                companyName: req.body.companyName,
                pickupCity: req.body.pickupCity,
                pickupState: req.body.pickupState,
                dropCity: req.body.dropCity,
                dropState: req.body.dropState,
                additionalInfo: req.body.additionalInfo,
                vehicleRequirements: req.body.vehicleRequirements,
                startDate: req.body.startDate,
                endDate: req.body.endDate,
                isFlexible: req.body.isFlexible,
                goodsType: req.body.goodsType,
                estimatedWeight: req.body.estimatedWeight,
                specialRequests: req.body.specialRequests
            });

            const responseData = {
                requestId: request.id,
                status: request.status
            };

            // === CACHE IDEMPOTENCY RESULT (24 hours) ===
            if (idempotencyKey) {
                await redisService.set(
                    `custom_booking:idempotent:${idempotencyKey}`,
                    JSON.stringify(responseData),
                    86400  // 24 hours TTL
                );
            }

            // === QUEUE ADMIN NOTIFICATION (async - non-blocking) ===
            queueService.queuePushNotification('admin', {
                title: 'New Custom Booking Request',
                body: `${(req.user as any).name || 'Customer'} - ${req.body.pickupCity} to ${req.body.dropCity}`,
                data: { requestId: request.id, type: 'custom_booking' }
            }).catch(() => { }); // Fire and forget - don't block response

            res.status(201).json({
                success: true,
                message: 'Your request has been submitted. Our team will contact you soon.',
                data: responseData
            });
        } catch (error) {
            next(error);
        }
    }
);

/**
 * @route   GET /api/custom-booking
 * @desc    Get customer's custom booking requests
 * @access  Customer only
 */
router.get(
    '/',
    authMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const query = getRequestsQuerySchema.parse(req.query);
            const result = await customBookingService.getCustomerRequests(
                req.user!.userId,
                query.page || 1,
                query.limit || 10
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
 * @route   GET /api/custom-booking/:id
 * @desc    Get single request details
 * @access  Customer (own requests only)
 */
router.get(
    '/:id',
    authMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const request = await customBookingService.getRequestById(
                req.params.id,
                req.user!.userId
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

/**
 * @route   POST /api/custom-booking/:id/cancel
 * @desc    Cancel a pending request
 * @access  Customer (own requests only)
 */
router.post(
    '/:id/cancel',
    authMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const request = await customBookingService.cancelRequest(
                req.params.id,
                req.user!.userId
            );

            res.json({
                success: true,
                message: 'Request cancelled successfully',
                data: { requestId: request.id, status: request.status }
            });
        } catch (error) {
            next(error);
        }
    }
);

export { router as customBookingRouter };
