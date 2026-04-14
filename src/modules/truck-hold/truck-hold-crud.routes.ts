/**
 * =============================================================================
 * TRUCK HOLD CRUD ROUTES - Hold, confirm, release, availability, my-active
 * =============================================================================
 *
 * Extracted from truck-hold.routes.ts (file-split).
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { truckHoldService } from './truck-hold.service';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { transporterRateLimit } from '../../shared/middleware/transporter-rate-limit.middleware';
import { getErrorMessage } from '../../shared/utils/error.utils';

// =============================================================================
// ZOD VALIDATION SCHEMAS
// =============================================================================

const holdTrucksSchema = z.object({
  orderId: z.string().min(1, 'orderId is required'),
  vehicleType: z.string().min(1, 'vehicleType is required'),
  vehicleSubtype: z.string().optional().default(''),
  quantity: z.number({ coerce: true }).int().positive('quantity must be a positive integer'),
});

const confirmHoldSchema = z.object({
  holdId: z.string().min(1, 'holdId is required'),
});

const confirmWithAssignmentsSchema = z.object({
  holdId: z.string().min(1, 'holdId is required'),
  assignments: z.array(z.object({
    vehicleId: z.string().min(1, 'vehicleId is required'),
    driverId: z.string().min(1, 'driverId is required'),
  })).min(1, 'At least one assignment is required').max(50),
});

const releaseHoldSchema = z.object({
  holdId: z.string().min(1, 'holdId is required'),
});

const router = Router();

function mapHoldErrorToHttpStatus(code?: string): number {
  switch ((code || '').toUpperCase()) {
    case 'VALIDATION_ERROR': return 400;
    case 'IDEMPOTENCY_CONFLICT': return 409;
    case 'NOT_ENOUGH_AVAILABLE': case 'ALREADY_HOLDING': case 'TRUCK_STATE_CHANGED':
    case 'ORDER_INACTIVE': case 'HOLD_EXPIRED': return 409;
    case 'INTERNAL_ERROR': return 500;
    default: return 400;
  }
}

function mapReleaseErrorToHttpStatus(code?: string): number {
  switch ((code || '').toUpperCase()) {
    case 'VALIDATION_ERROR': return 400;
    case 'FORBIDDEN': return 403;
    case 'HOLD_NOT_FOUND': return 404;
    case 'IDEMPOTENCY_CONFLICT': return 409;
    case 'INTERNAL_ERROR': return 500;
    default: return 400;
  }
}

// POST /truck-hold/hold
router.post(
  '/hold',
  authMiddleware,
  roleGuard(['transporter']),
  transporterRateLimit('holdTrucks'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const idempotencyKey = (req.header('X-Idempotency-Key') || req.header('x-idempotency-key') || '').trim() || undefined;

      const parsed = holdTrucksSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map(i => i.message).join('; ') } });
      }
      const { orderId, vehicleType, vehicleSubtype, quantity: quantityNumber } = parsed.data;

      logger.info(`[TruckHoldRoutes] Hold request from ${transporterId}: ${quantityNumber}x ${vehicleType}`);
      const result = await truckHoldService.holdTrucks({
        orderId, transporterId, vehicleType, vehicleSubtype,
        quantity: quantityNumber, idempotencyKey
      });

      if (result.success) {
        res.json({
          success: true,
          data: { holdId: result.holdId, expiresAt: result.expiresAt, heldQuantity: result.heldQuantity, holdState: result.holdState, eventId: result.eventId, eventVersion: result.eventVersion, serverTimeMs: result.serverTimeMs },
          message: result.message
        });
      } else {
        res.status(mapHoldErrorToHttpStatus(result.error)).json({ success: false, error: { code: result.error, message: result.message } });
      }
    } catch (error) { return next(error); }
  }
);

// POST /truck-hold/confirm
router.post(
  '/confirm',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const parsed = confirmHoldSchema.safeParse(req.body);
      if (!parsed.success) { return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map(i => i.message).join('; ') } }); }
      const { holdId } = parsed.data;
      logger.info(`[TruckHoldRoutes] Simple confirm request: ${holdId} by ${transporterId}`);
      const result = await truckHoldService.confirmHold(holdId, transporterId);
      if (result.success) {
        res.json({ success: true, data: { assignedTrucks: result.assignedTrucks }, message: result.message });
      } else {
        res.status(400).json({ success: false, error: { code: 'CONFIRM_FAILED', message: result.message } });
      }
    } catch (error) { return next(error); }
  }
);

// POST /truck-hold/confirm-with-assignments
router.post(
  '/confirm-with-assignments',
  authMiddleware,
  roleGuard(['transporter']),
  transporterRateLimit('confirmHoldWithAssignments'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      let idempotencyCacheKey: string | null = null;

      const parsed = confirmWithAssignmentsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map(i => i.message).join('; ') } });
      }
      const { holdId, assignments } = parsed.data;

      const idempotencyKey = (req.header('X-Idempotency-Key') || req.header('x-idempotency-key') || '').trim();
      idempotencyCacheKey = idempotencyKey ? `idempotency:truck-hold:confirm:${transporterId}:${holdId}:${idempotencyKey}` : null;

      if (idempotencyCacheKey) {
        try {
          const cached = await redisService.getJSON<{ status: number; body: unknown }>(idempotencyCacheKey);
          if (cached) { return res.status(cached.status).json(cached.body); }
        } catch (cacheError: unknown) {
          logger.warn(`[TruckHoldRoutes] Idempotency read failed: ${getErrorMessage(cacheError)}`);
        }
      }

      logger.info(`[TruckHoldRoutes] Confirm with assignments: ${holdId} by ${transporterId} (${assignments.length} trucks)`);
      const result = await truckHoldService.confirmHoldWithAssignments(holdId, transporterId, assignments as Array<{ vehicleId: string; driverId: string }>);

      if (result.success) {
        const responseBody = { success: true, data: { assignmentIds: result.assignmentIds, tripIds: result.tripIds }, message: result.message };
        if (idempotencyCacheKey) { await redisService.setJSON(idempotencyCacheKey, { status: 200, body: responseBody }, 120).catch(() => {}); }
        res.json(responseBody);
      } else {
        const responseBody = { success: false, error: { code: 'CONFIRM_FAILED', message: result.message, failedAssignments: result.failedAssignments } };
        if (idempotencyCacheKey) { await redisService.setJSON(idempotencyCacheKey, { status: 400, body: responseBody }, 45).catch(() => {}); }
        res.status(400).json(responseBody);
      }
    } catch (error) { return next(error); }
  }
);

// POST /truck-hold/release
router.post(
  '/release',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const idempotencyKey = (req.header('X-Idempotency-Key') || req.header('x-idempotency-key') || '').trim() || undefined;
      const parsed = releaseHoldSchema.safeParse(req.body);
      if (!parsed.success) { return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map(i => i.message).join('; ') } }); }
      const { holdId } = parsed.data;
      logger.info(`[TruckHoldRoutes] Release request: ${holdId} by ${transporterId}`);
      const result = await truckHoldService.releaseHold(holdId, transporterId, idempotencyKey);
      const status = result.success ? 200 : mapReleaseErrorToHttpStatus(result.error);
      res.status(status).json({
        success: result.success, message: result.message,
        error: result.success ? undefined : { code: result.error || 'RELEASE_FAILED', message: result.message }
      });
    } catch (error) { return next(error); }
  }
);

// GET /truck-hold/my-active
router.get(
  '/my-active',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const orderId = String(req.query.orderId || '').trim();
      const vehicleType = String(req.query.vehicleType || '').trim();
      const vehicleSubtype = String(req.query.vehicleSubtype || '').trim();
      if (!orderId || !vehicleType) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'orderId and vehicleType are required' } });
      }
      const hold = await truckHoldService.getMyActiveHold(transporterId, orderId, vehicleType, vehicleSubtype);
      return res.json({ success: true, data: hold, message: hold ? 'Active hold found' : 'No active hold' });
    } catch (error) { return next(error); }
  }
);

// GET /truck-hold/availability/:orderId
router.get(
  '/availability/:orderId',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      const availability = await truckHoldService.getOrderAvailability(orderId);
      if (!availability) { return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } }); }
      res.json({ success: true, data: availability });
    } catch (error) { return next(error); }
  }
);

export { router as truckHoldCrudRouter };
