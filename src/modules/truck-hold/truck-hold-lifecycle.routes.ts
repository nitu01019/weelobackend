/**
 * =============================================================================
 * TRUCK HOLD LIFECYCLE ROUTES - Flex hold, confirmed hold, timeout, progress
 * =============================================================================
 *
 * Extracted from truck-hold.routes.ts (file-split).
 * Contains: flex-hold, confirmed-hold, driver accept/decline,
 *           order-timeout, order-progress, order-assignments.
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { flexHoldService } from './flex-hold.service';
import { confirmedHoldService } from './confirmed-hold.service';
import { smartTimeoutService } from '../order-timeout/smart-timeout.service';
import { progressTrackingService } from '../order-timeout/progress.service';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { transporterRateLimit } from '../../shared/middleware/transporter-rate-limit.middleware';

// =============================================================================
// ZOD VALIDATION SCHEMAS
// =============================================================================

const flexHoldCreateSchema = z.object({
  orderId: z.string().min(1, 'orderId is required'),
  vehicleType: z.string().min(1, 'vehicleType is required'),
  vehicleSubtype: z.string().min(1, 'vehicleSubtype is required'),
  quantity: z.number({ coerce: true }).int().positive(),
  truckRequestIds: z.array(z.string().min(1)).min(1).max(50),
});

const flexHoldExtendSchema = z.object({
  holdId: z.string().min(1, 'holdId is required'),
  reason: z.string().optional(),
  driverId: z.string().optional(),
  assignmentId: z.string().optional(),
});

const confirmedHoldInitSchema = z.object({
  holdId: z.string().min(1, 'holdId is required'),
  assignments: z.array(z.object({
    assignmentId: z.string().min(1),
    driverId: z.string().min(1),
    truckRequestId: z.string().min(1),
  })).min(1, 'At least one assignment is required').max(50),
});

const orderTimeoutInitSchema = z.object({
  orderId: z.string().min(1, 'orderId is required'),
  totalTrucks: z.number({ coerce: true }).int().positive(),
});

const orderTimeoutExtendSchema = z.object({
  orderId: z.string().min(1, 'orderId is required'),
  driverId: z.string().min(1, 'driverId is required'),
  driverName: z.string().min(1, 'driverName is required'),
  assignmentId: z.string().min(1, 'assignmentId is required'),
  truckRequestId: z.string().optional(),
  isFirstDriver: z.boolean().optional().default(false),
  reason: z.string().optional(),
});

const router = Router();

// POST /truck-hold/flex-hold
router.post(
  '/flex-hold',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const parsed = flexHoldCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map(i => i.message).join('; ') } });
      }
      const { orderId, vehicleType, vehicleSubtype, quantity, truckRequestIds } = parsed.data;
      const result = await flexHoldService.createFlexHold({
        orderId, transporterId, vehicleType, vehicleSubtype, quantity, truckRequestIds
      });
      res.status(result.success ? 201 : 400).json({
        success: result.success,
        data: result.success ? { holdId: result.holdId, phase: result.phase, expiresAt: result.expiresAt, remainingSeconds: result.remainingSeconds, canExtend: result.canExtend } : undefined,
        message: result.message,
        error: result.error ? { code: result.error } : undefined
      });
    } catch (error) { return next(error); }
  }
);

// POST /truck-hold/flex-hold/extend
router.post(
  '/flex-hold/extend',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = flexHoldExtendSchema.safeParse(req.body);
      if (!parsed.success) { return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map(i => i.message).join('; ') } }); }
      const { holdId, reason, driverId, assignmentId } = parsed.data;
      const result = await flexHoldService.extendFlexHold({ holdId, reason: reason || 'Driver assignment', driverId, assignmentId });
      if (result.success) {
        res.json({ success: true, data: { newExpiresAt: result.newExpiresAt, addedSeconds: result.addedSeconds, extendedCount: result.extendedCount, canExtend: result.canExtend }, message: result.message });
      } else {
        res.status(400).json({ success: false, error: { code: result.error || 'EXTEND_FAILED', message: result.message } });
      }
    } catch (error) { return next(error); }
  }
);

// GET /truck-hold/flex-hold/:holdId
router.get(
  '/flex-hold/:holdId',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const state = await flexHoldService.getFlexHoldState(req.params.holdId);
      if (!state) { return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Flex hold not found' } }); }
      res.json({ success: true, data: state });
    } catch (error) { return next(error); }
  }
);

// POST /truck-hold/confirmed-hold/initialize
router.post(
  '/confirmed-hold/initialize',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = confirmedHoldInitSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map(i => i.message).join('; ') } });
      }
      const { holdId, assignments } = parsed.data;
      const transporterId = req.user!.userId;
      const result = await confirmedHoldService.initializeConfirmedHold(holdId, transporterId, assignments as Array<{ assignmentId: string; driverId: string; truckRequestId: string }>);
      if (result.success) {
        res.json({ success: true, data: { confirmedExpiresAt: result.confirmedExpiresAt }, message: result.message });
      } else {
        res.status(400).json({ success: false, error: { code: 'INITIALIZE_FAILED', message: result.message } });
      }
    } catch (error) { return next(error); }
  }
);

// GET /truck-hold/confirmed-hold/:holdId
router.get(
  '/confirmed-hold/:holdId',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const state = await confirmedHoldService.getConfirmedHoldState(req.params.holdId);
      if (!state) { return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Confirmed hold not found' } }); }
      res.json({ success: true, data: state });
    } catch (error) { return next(error); }
  }
);

// PUT /truck-hold/driver/:assignmentId/accept
router.put(
  '/driver/:assignmentId/accept',
  authMiddleware,
  roleGuard(['driver']),
  transporterRateLimit('driverAcceptDecline'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const driverId = req.user!.userId;
      const result = await confirmedHoldService.handleDriverAcceptance(req.params.assignmentId, driverId);
      if (result.success) {
        res.status(200).json({
          success: true,
          data: { accepted: result.accepted, declined: result.declined, timeout: result.timeout },
          message: result.message
        });
      } else {
        res.status(400).json({
          success: false,
          error: { code: result.errorCode || 'DRIVER_ACTION_FAILED', message: result.message },
          data: { accepted: result.accepted, declined: result.declined, timeout: result.timeout }
        });
      }
    } catch (error) { return next(error); }
  }
);

// PUT /truck-hold/driver/:assignmentId/decline
router.put(
  '/driver/:assignmentId/decline',
  authMiddleware,
  roleGuard(['driver']),
  transporterRateLimit('driverAcceptDecline'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const driverId = req.user!.userId;
      const { reason } = req.body;
      const result = await confirmedHoldService.handleDriverDecline(req.params.assignmentId, driverId, reason);
      if (result.success) {
        res.status(200).json({
          success: true,
          data: { accepted: result.accepted, declined: result.declined, timeout: result.timeout },
          message: result.message
        });
      } else {
        res.status(400).json({
          success: false,
          error: { code: result.errorCode || 'DRIVER_ACTION_FAILED', message: result.message },
          data: { accepted: result.accepted, declined: result.declined, timeout: result.timeout }
        });
      }
    } catch (error) { return next(error); }
  }
);

// POST /truck-hold/order-timeout/initialize
router.post(
  '/order-timeout/initialize',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = orderTimeoutInitSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map(i => i.message).join('; ') } });
      }
      const { orderId, totalTrucks } = parsed.data;
      const result = await smartTimeoutService.initializeOrderTimeout(orderId, totalTrucks);
      if (result.success) { res.json({ success: true, data: { expiresAt: result.expiresAt } }); }
      else { res.status(500).json({ success: false, error: { code: 'INITIALIZE_FAILED', message: 'Failed to initialize order timeout' } }); }
    } catch (error) { return next(error); }
  }
);

// POST /truck-hold/order-timeout/extend
router.post(
  '/order-timeout/extend',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = orderTimeoutExtendSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map(i => i.message).join('; ') } });
      }
      const { orderId, driverId, driverName, assignmentId, truckRequestId, isFirstDriver, reason } = parsed.data;
      const result = await smartTimeoutService.extendTimeout({
        orderId, driverId, driverName, assignmentId, truckRequestId,
        isFirstDriver, reason: reason || 'Driver accepted trip'
      });
      res.status(result.success ? 200 : 400).json({
        success: result.success,
        data: result.success ? {
          newExpiresAt: result.newExpiresAt, addedSeconds: result.addedSeconds,
          totalExtendedSeconds: result.totalExtendedSeconds, remainingSeconds: result.remainingSeconds,
          isFirstExtension: result.isFirstExtension
        } : undefined,
        message: result.message
      });
    } catch (error) { return next(error); }
  }
);

// GET /truck-hold/order-timeout/:orderId
router.get(
  '/order-timeout/:orderId',
  authMiddleware,
  roleGuard(['customer', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const state = await smartTimeoutService.getOrderTimeout(req.params.orderId);
      if (!state) { return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order timeout not found' } }); }
      res.json({ success: true, data: state });
    } catch (error) { return next(error); }
  }
);

// GET /truck-hold/order-progress/:orderId
router.get(
  '/order-progress/:orderId',
  authMiddleware,
  roleGuard(['customer', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const progress = await smartTimeoutService.getOrderProgress(req.params.orderId);
      if (!progress) { return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order progress not found' } }); }
      res.json({ success: true, data: progress });
    } catch (error) { return next(error); }
  }
);

// GET /truck-hold/order-assignments/:orderId
router.get(
  '/order-assignments/:orderId',
  authMiddleware,
  roleGuard(['customer', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const assignments = await progressTrackingService.getOrderAssignments(req.params.orderId);
      if (!assignments) { return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order assignments not found' } }); }
      res.json({ success: true, data: assignments });
    } catch (error) { return next(error); }
  }
);

export { router as truckHoldLifecycleRouter };
