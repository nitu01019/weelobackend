/**
 * =============================================================================
 * ADMIN CONTROLLER
 * =============================================================================
 *
 * Request handlers for admin suspension endpoints.
 * All handlers expect authMiddleware + admin role guard to be applied upstream.
 * =============================================================================
 */

import { Request, Response, NextFunction } from 'express';
import { adminSuspensionService } from './admin-suspension.service';
import { logger } from '../../shared/services/logger.service';
import { redriveFailedDispatch } from '../order/order-dispatch-outbox.service';

/**
 * POST /admin/users/:id/suspend
 * Body: { reason: string, durationHours: number }
 */
export async function suspendUser(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const targetUserId = req.params.id;
    const { reason, durationHours } = req.body ?? {};

    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'reason is required' },
      });
      return;
    }

    if (
      typeof durationHours !== 'number' ||
      !Number.isFinite(durationHours) ||
      durationHours <= 0
    ) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'durationHours must be a positive number',
        },
      });
      return;
    }

    // Prevent admin from suspending themselves
    if (targetUserId === req.user?.userId) {
      res.status(400).json({
        success: false,
        error: { code: 'SELF_SUSPEND', message: 'Cannot suspend yourself' },
      });
      return;
    }

    await adminSuspensionService.suspendUser(
      targetUserId,
      reason.trim(),
      durationHours,
      req.user!.userId
    );

    res.json({
      success: true,
      data: {
        userId: targetUserId,
        action: 'suspended',
        durationHours,
        reason: reason.trim(),
      },
    });
  } catch (error) {
    logger.error('[AdminController] suspendUser failed', {
      targetUserId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * POST /admin/users/:id/warn
 * Body: { reason: string }
 */
export async function warnUser(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const targetUserId = req.params.id;
    const { reason } = req.body ?? {};

    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'reason is required' },
      });
      return;
    }

    await adminSuspensionService.warnUser(
      targetUserId,
      reason.trim(),
      req.user!.userId
    );

    res.json({
      success: true,
      data: {
        userId: targetUserId,
        action: 'warned',
        reason: reason.trim(),
      },
    });
  } catch (error) {
    logger.error('[AdminController] warnUser failed', {
      targetUserId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * POST /admin/users/:id/unsuspend
 * Body: { reason?: string }
 */
export async function unsuspendUser(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const targetUserId = req.params.id;
    const { reason } = req.body ?? {};

    await adminSuspensionService.unsuspendUser(
      targetUserId,
      req.user!.userId,
      typeof reason === 'string' ? reason.trim() : undefined
    );

    res.json({
      success: true,
      data: {
        userId: targetUserId,
        action: 'unsuspended',
      },
    });
  } catch (error) {
    logger.error('[AdminController] unsuspendUser failed', {
      targetUserId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * GET /admin/users/:id/status
 * Returns suspension status or { suspended: false }
 */
export async function getUserStatus(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const targetUserId = req.params.id;
    const status = await adminSuspensionService.getUserSuspensionStatus(targetUserId);

    res.json({
      success: true,
      data: status
        ? { suspended: true, ...status }
        : { suspended: false, userId: targetUserId },
    });
  } catch (error) {
    logger.error('[AdminController] getUserStatus failed', {
      targetUserId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * GET /admin/users/:id/actions
 * Returns admin action history for the user
 */
export async function getUserActions(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const targetUserId = req.params.id;
    const actions = await adminSuspensionService.getActionHistory(targetUserId);

    res.json({
      success: true,
      data: {
        userId: targetUserId,
        actions,
        count: actions.length,
      },
    });
  } catch (error) {
    logger.error('[AdminController] getUserActions failed', {
      targetUserId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * POST /admin/dispatch-outbox/:orderId/retry
 * Re-drives a failed dispatch outbox row back to pending.
 */
export async function redriveDispatchOutbox(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { orderId } = req.params;

    if (!orderId || typeof orderId !== 'string' || orderId.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'orderId is required' },
      });
      return;
    }

    const updated = await redriveFailedDispatch(orderId.trim());

    if (!updated) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'No failed dispatch outbox row found for this orderId',
        },
      });
      return;
    }

    logger.info('[AdminController] Dispatch outbox re-driven', {
      orderId: orderId.trim(),
      adminUserId: req.user?.userId,
    });

    res.json({
      success: true,
      data: {
        orderId: updated.orderId,
        status: updated.status,
        attempts: updated.attempts,
        message: 'Dispatch outbox row reset to pending for retry',
      },
    });
  } catch (error) {
    logger.error('[AdminController] redriveDispatchOutbox failed', {
      orderId: req.params.orderId,
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}
