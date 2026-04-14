/**
 * =============================================================================
 * POD (Proof of Delivery) ROUTES
 * =============================================================================
 *
 * Endpoints for the Proof-of-Delivery OTP flow:
 *   POST /pod/:tripId/generate  - Driver generates OTP (sends SMS to customer)
 *   POST /pod/:tripId/verify    - Driver enters OTP received from customer
 *   GET  /pod/:tripId/status    - Check POD status for a trip
 *
 * Feature flag: FF_POD_OTP_REQUIRED gates business logic inside the service,
 * NOT the route existence. Routes always exist so the app can call them.
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { prismaClient } from '../../shared/database/prisma.service';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import {
  generatePodOtp,
  validatePodOtp,
  markPodVerified,
  isPodVerified,
  isPodOtpPending,
  isPodRequired,
} from './pod.service';
import {
  podGenerateParamsSchema,
  podVerifyParamsSchema,
  podVerifyBodySchema,
} from './tracking.schema';

const router = Router();

/**
 * @route   POST /pod/:tripId/generate
 * @desc    Generate POD OTP and send to customer via SMS
 * @access  Driver only (must be assigned to this trip, status must be arrived_at_drop)
 */
router.post(
  '/:tripId/generate',
  authMiddleware,
  roleGuard(['driver']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tripId } = podGenerateParamsSchema.parse(req.params);
      const driverId = req.user!.userId;

      // Look up the assignment for this trip
      const assignment = await prismaClient.assignment.findUnique({
        where: { tripId },
        select: {
          id: true,
          driverId: true,
          status: true,
          order: { select: { customerId: true, customerPhone: true } },
          booking: { select: { customerId: true, customerPhone: true } },
        },
      }) as any;

      if (!assignment) {
        throw new AppError(404, 'TRIP_NOT_FOUND', 'Trip not found');
      }

      if (assignment.driverId !== driverId) {
        throw new AppError(403, 'FORBIDDEN', 'You are not assigned to this trip');
      }

      if (assignment.status !== 'arrived_at_drop') {
        throw new AppError(
          400,
          'INVALID_STATUS',
          `POD OTP can only be generated when status is arrived_at_drop. Current: ${assignment.status}`,
        );
      }

      if (!isPodRequired()) {
        return res.json({
          success: true,
          message: 'POD OTP is not required (feature flag disabled)',
          data: { required: false },
        });
      }

      const customerId =
        assignment.order?.customerId || assignment.booking?.customerId || 'unknown';
      const customerPhone =
        assignment.order?.customerPhone || assignment.booking?.customerPhone;

      await generatePodOtp(tripId, customerId, customerPhone);

      // Do NOT return the OTP value — it is sent to the customer via SMS
      res.json({
        success: true,
        message: 'Delivery OTP sent to customer',
        data: { required: true, otpSent: true },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @route   POST /pod/:tripId/verify
 * @desc    Verify POD OTP entered by driver (received from customer)
 * @access  Driver only (must be assigned to this trip)
 */
router.post(
  '/:tripId/verify',
  authMiddleware,
  roleGuard(['driver']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tripId } = podVerifyParamsSchema.parse(req.params);
      const { otp } = podVerifyBodySchema.parse(req.body);
      const driverId = req.user!.userId;

      // Look up the assignment to verify ownership
      const assignment = await prismaClient.assignment.findUnique({
        where: { tripId },
        select: { id: true, driverId: true },
      });

      if (!assignment) {
        throw new AppError(404, 'TRIP_NOT_FOUND', 'Trip not found');
      }

      if (assignment.driverId !== driverId) {
        throw new AppError(403, 'FORBIDDEN', 'You are not assigned to this trip');
      }

      await validatePodOtp(tripId, otp);
      await markPodVerified(tripId);

      logger.info('[POD] OTP verified successfully', { tripId, driverId });

      res.json({
        success: true,
        message: 'Delivery confirmed',
        data: { verified: true },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @route   GET /pod/:tripId/status
 * @desc    Get POD status for a trip (is OTP required, pending, verified?)
 * @access  Driver or Transporter
 */
router.get(
  '/:tripId/status',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tripId } = podGenerateParamsSchema.parse(req.params);
      const requesterId = req.user!.userId;
      const requesterRole = req.user!.role;

      // Verify the requester has access to this trip
      const assignment = await prismaClient.assignment.findUnique({
        where: { tripId },
        select: { id: true, driverId: true, transporterId: true },
      });

      if (!assignment) {
        throw new AppError(404, 'TRIP_NOT_FOUND', 'Trip not found');
      }

      if (
        requesterRole === 'driver' && assignment.driverId !== requesterId
      ) {
        throw new AppError(403, 'FORBIDDEN', 'You are not assigned to this trip');
      }

      if (
        requesterRole === 'transporter' && assignment.transporterId !== requesterId
      ) {
        throw new AppError(403, 'FORBIDDEN', 'This trip does not belong to your fleet');
      }

      const required = isPodRequired();
      const verified = await isPodVerified(tripId);
      const otpPending = await isPodOtpPending(tripId);

      res.json({
        success: true,
        data: {
          required,
          verified,
          otpPending,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

export { router as podRouter };
