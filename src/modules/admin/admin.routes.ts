/**
 * =============================================================================
 * ADMIN ROUTES
 * =============================================================================
 *
 * Admin endpoints for user suspension management.
 * All routes require authentication + admin role.
 *
 * ENDPOINTS:
 *   POST   /admin/users/:id/suspend                - Suspend a user
 *   POST   /admin/users/:id/warn                   - Warn a user
 *   POST   /admin/users/:id/unsuspend              - Unsuspend a user
 *   GET    /admin/users/:id/status                 - Get suspension status
 *   GET    /admin/users/:id/actions                - Get action history
 *   POST   /admin/dispatch-outbox/:orderId/retry   - Re-drive failed dispatch
 *   PUT    /admin/disputes/:disputeId/resolve      - Resolve a cancel dispute (H-26)
 *   POST   /admin/orders/:orderId/rebroadcast      - Manual rebroadcast for expired/stalled orders (L-11)
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import {
  suspendUser,
  warnUser,
  unsuspendUser,
  getUserStatus,
  getUserActions,
  redriveDispatchOutbox,
} from './admin.controller';
import { adminResolveDispute } from '../order/order-cancel-policy.service';
import { db } from '../../shared/database/db';
import { redisService } from '../../shared/services/redis.service';
import { broadcastToTransporters } from '../order/order-broadcast.service';
import { logger } from '../../shared/services/logger.service';

const router = Router();

// All admin routes require authentication + admin role
router.use(authMiddleware);
router.use(roleGuard(['admin']));

router.post('/users/:id/suspend', suspendUser);
router.post('/users/:id/warn', warnUser);
router.post('/users/:id/unsuspend', unsuspendUser);
router.get('/users/:id/status', getUserStatus);
router.get('/users/:id/actions', getUserActions);

// Dispatch outbox DLQ re-drive
router.post('/dispatch-outbox/:orderId/retry', redriveDispatchOutbox);

// H-26: Admin dispute resolution
router.put('/disputes/:disputeId/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { disputeId } = req.params;
    const resolution = req.body?.resolution;
    const adminNotes = typeof req.body?.notes === 'string' ? req.body.notes.substring(0, 2000) : undefined;

    if (resolution !== 'resolved' && resolution !== 'rejected') {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_RESOLUTION', message: 'Resolution must be "resolved" or "rejected"' }
      });
    }

    const result = await adminResolveDispute(disputeId, resolution, adminNotes);
    if (!result.success) {
      return res.status(404).json({ success: false, error: { code: 'DISPUTE_NOT_FOUND', message: result.message } });
    }

    return res.json({ success: true, data: { message: result.message } });
  } catch (error) {
    next(error);
  }
});

// L-11: Manual rebroadcast for expired/stalled orders
const REBROADCAST_ELIGIBLE_STATUSES = ['expired', 'cancelled'] as const;
const BROADCAST_TIMEOUT_SECONDS = parseInt(process.env.BROADCAST_TIMEOUT_SECONDS || '120', 10);

router.post('/orders/:orderId/rebroadcast', async (req: Request, res: Response, next: NextFunction) => {
  const { orderId } = req.params;

  try {
    // 1. Validate orderId
    if (!orderId || typeof orderId !== 'string' || orderId.length < 10) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_ORDER_ID', message: 'A valid orderId parameter is required' },
      });
    }

    // 2. Fetch the order
    const order = await db.getOrderById(orderId);
    if (!order) {
      return res.status(404).json({
        success: false,
        error: { code: 'ORDER_NOT_FOUND', message: `Order ${orderId} not found` },
      });
    }

    // 3. Verify order is in a rebroadcast-eligible state
    if (!REBROADCAST_ELIGIBLE_STATUSES.includes(order.status as typeof REBROADCAST_ELIGIBLE_STATUSES[number])) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'ORDER_NOT_ELIGIBLE',
          message: `Order status is "${order.status}". Rebroadcast is only allowed for: ${REBROADCAST_ELIGIBLE_STATUSES.join(', ')}`,
        },
      });
    }

    logger.info('[ADMIN-REBROADCAST] Starting manual rebroadcast', {
      orderId,
      previousStatus: order.status,
      adminUserId: (req as any).user?.id,
    });

    // 4. Compute new expiresAt
    const newExpiresAt = new Date(Date.now() + BROADCAST_TIMEOUT_SECONDS * 1000).toISOString();

    // 5. Reset order status to broadcasting
    await db.updateOrder(orderId, {
      status: 'broadcasting' as any,
      expiresAt: newExpiresAt,
      dispatchState: 'dispatching',
      dispatchAttempts: (order.dispatchAttempts ?? 0) + 1,
      stateChangedAt: new Date(),
    } as any);

    // 6. Reset truck requests that are in terminal states back to searching
    const truckRequests = await db.getTruckRequestsByOrder(orderId);
    const resetJobs = truckRequests
      .filter((tr) => tr.status === 'expired' || tr.status === 'cancelled')
      .map((tr) =>
        db.updateTruckRequest(tr.id, {
          status: 'searching' as any,
          notifiedTransporters: [],
        } as any)
      );
    await Promise.allSettled(resetJobs);

    // 7. Clear Redis notified-transporter sets for this order
    let keysDeleted = 0;
    try {
      const scanPattern = `order:notified:transporters:${orderId}:*`;
      for await (const key of redisService.scanIterator(scanPattern)) {
        await redisService.del(key);
        keysDeleted++;
      }
    } catch (redisErr: unknown) {
      const msg = redisErr instanceof Error ? redisErr.message : String(redisErr);
      logger.warn('[ADMIN-REBROADCAST] Failed to clear Redis notified sets (proceeding anyway)', {
        orderId,
        error: msg,
      });
    }

    // 8. Re-fetch truck requests after reset and trigger broadcast
    const freshTruckRequests = await db.getTruckRequestsByOrder(orderId);
    const searchingRequests = freshTruckRequests.filter((tr) => tr.status === 'searching');

    let broadcastResult = { onlineCandidates: 0, notifiedTransporters: 0 };
    if (searchingRequests.length > 0) {
      // Resolve pickup from order data
      const pickup = order.pickup as { latitude: number; longitude: number; address: string; city?: string; state?: string };
      const drop = order.drop as { latitude: number; longitude: number; address: string; city?: string };

      const createOrderRequest = {
        customerId: order.customerId,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        routePoints: order.routePoints,
        pickup,
        drop,
        distanceKm: order.distanceKm,
        vehicleRequirements: [],
        goodsType: order.goodsType,
        cargoWeightKg: order.cargoWeightKg,
      };

      broadcastResult = await broadcastToTransporters(
        orderId,
        createOrderRequest as any,
        searchingRequests,
        newExpiresAt,
        pickup
      );
    }

    // 9. Update dispatch state based on result
    await db.updateOrder(orderId, {
      dispatchState: broadcastResult.notifiedTransporters > 0 ? 'dispatched' : 'dispatch_failed',
      onlineCandidatesCount: broadcastResult.onlineCandidates,
      notifiedCount: broadcastResult.notifiedTransporters,
      lastDispatchAt: new Date(),
    } as any);

    logger.info('[ADMIN-REBROADCAST] Rebroadcast completed', {
      orderId,
      onlineCandidates: broadcastResult.onlineCandidates,
      notifiedTransporters: broadcastResult.notifiedTransporters,
      truckRequestsReset: resetJobs.length,
      redisKeysDeleted: keysDeleted,
    });

    return res.json({
      success: true,
      data: {
        orderId,
        newStatus: 'broadcasting',
        expiresAt: newExpiresAt,
        onlineCandidates: broadcastResult.onlineCandidates,
        notifiedTransporters: broadcastResult.notifiedTransporters,
        truckRequestsReset: resetJobs.length,
        redisKeysCleared: keysDeleted,
      },
    });
  } catch (error) {
    logger.error('[ADMIN-REBROADCAST] Failed', {
      orderId,
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
});

export { router as adminRouter };
