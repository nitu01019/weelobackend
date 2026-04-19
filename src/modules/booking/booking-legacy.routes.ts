// TODO(L-08): This route file is not mounted in server.ts. Wire it when the booking module split is completed.

/**
 * =============================================================================
 * BOOKING LEGACY ROUTES - Cancel, status, snapshot, dispute endpoints
 * =============================================================================
 *
 * Extracted from booking.routes.ts (file-split).
 * Contains: POST /bookings/orders/:orderId/cancel, cancel-preview, dispute,
 *           GET /bookings/orders/:orderId/status, broadcast-snapshot.
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { orderService as canonicalOrderService } from '../order/order.service';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { logger } from '../../shared/services/logger.service';
import { bookingQueue, Priority } from '../../shared/resilience/request-queue';
import { normalizeOrderLifecycleState } from '../../shared/utils/order-lifecycle.utils';
import { maskPhoneForExternal } from '../../shared/utils/pii.utils';

const router = Router();

// POST /bookings/orders/:orderId/cancel
router.post(
  '/orders/:orderId/cancel',
  authMiddleware,
  roleGuard(['customer']),
  bookingQueue.middleware({ priority: Priority.HIGH, timeout: 12000 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      logger.info('[OrderIngress] cancel_order_request', {
        route_path: '/api/v1/bookings/orders/:orderId/cancel',
        customerId: req.user!.userId,
        orderId: req.params.orderId
      });
      const { orderId } = req.params;
      const { reason } = req.body ?? {};
      const idempotencyKey = req.header('X-Idempotency-Key') || req.header('x-idempotency-key') || undefined;
      const result = await canonicalOrderService.cancelOrder(orderId, req.user!.userId, reason, idempotencyKey);

      if (!result.success) {
        const statusCode = result.cancelDecision === 'blocked_dispute_only' ? 409 : 400;
        return res.status(statusCode).json({
          success: false,
          error: {
            code: result.cancelDecision === 'blocked_dispute_only' ? 'CANCEL_BLOCKED_DISPUTE_ONLY' : 'CANCEL_FAILED',
            message: result.message,
            data: {
              policyStage: result.policyStage, cancelDecision: result.cancelDecision,
              reasonRequired: result.reasonRequired, reasonCode: result.reasonCode,
              penaltyBreakdown: result.penaltyBreakdown, driverCompensationBreakdown: result.driverCompensationBreakdown,
              settlementState: result.settlementState, pendingPenaltyAmount: result.pendingPenaltyAmount,
              disputeId: result.disputeId, eventVersion: result.eventVersion, serverTimeMs: result.serverTimeMs
            }
          }
        });
      }

      res.json({
        success: true,
        data: {
          orderId, status: 'cancelled', reason: reason || 'Cancelled by customer',
          policyStage: result.policyStage, cancelDecision: result.cancelDecision,
          reasonRequired: result.reasonRequired, reasonCode: result.reasonCode,
          penaltyBreakdown: result.penaltyBreakdown, driverCompensationBreakdown: result.driverCompensationBreakdown,
          settlementState: result.settlementState, pendingPenaltyAmount: result.pendingPenaltyAmount,
          eventId: result.eventId, eventVersion: result.eventVersion, serverTimeMs: result.serverTimeMs,
          transportersNotified: result.transportersNotified, cancelledAt: new Date().toISOString()
        }
      });
    } catch (error) { return next(error); }
  }
);

// GET /bookings/orders/:orderId/cancel-preview
router.get(
  '/orders/:orderId/cancel-preview',
  authMiddleware,
  roleGuard(['customer']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      const reason = typeof req.query.reason === 'string' ? req.query.reason : undefined;
      const preview = await canonicalOrderService.getCancelPreview(orderId, req.user!.userId, reason);
      if (!preview.success) {
        return res.status(404).json({
          success: false,
          error: { code: 'CANCEL_PREVIEW_FAILED', message: preview.message }
        });
      }
      return res.json({
        success: true,
        data: {
          orderId, policyStage: preview.policyStage, cancelDecision: preview.cancelDecision,
          reasonRequired: preview.reasonRequired, reasonCode: preview.reasonCode,
          penaltyBreakdown: preview.penaltyBreakdown, driverCompensationBreakdown: preview.driverCompensationBreakdown,
          settlementState: preview.settlementState, pendingPenaltyAmount: preview.pendingPenaltyAmount,
          eventVersion: preview.eventVersion, serverTimeMs: preview.serverTimeMs
        }
      });
    } catch (error) { return next(error); }
  }
);

// POST /bookings/orders/:orderId/cancel/dispute
router.post(
  '/orders/:orderId/cancel/dispute',
  authMiddleware,
  roleGuard(['customer']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      const reasonCode = typeof req.body?.reasonCode === 'string' ? req.body.reasonCode : undefined;
      const notes = typeof req.body?.notes === 'string' ? req.body.notes : undefined;
      const dispute = await canonicalOrderService.createCancelDispute(orderId, req.user!.userId, reasonCode, notes);
      if (!dispute.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'DISPUTE_CREATE_FAILED', message: dispute.message, data: { stage: dispute.stage } }
        });
      }
      return res.json({
        success: true,
        data: { disputeId: dispute.disputeId, stage: dispute.stage, message: dispute.message }
      });
    } catch (error) { return next(error); }
  }
);

// GET /bookings/orders/:orderId/status
router.get(
  '/orders/:orderId/status',
  authMiddleware,
  roleGuard(['customer']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      logger.info('[OrderIngress] order_status_request', {
        route_path: '/api/v1/bookings/orders/:orderId/status',
        customerId: req.user!.userId, orderId
      });
      const details = await canonicalOrderService.getOrderDetails(orderId);
      if (!details) {
        return res.status(404).json({ success: false, error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' } });
      }
      if (details.customerId !== req.user!.userId) {
        return res.status(404).json({ success: false, error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' } });
      }
      const nowMs = Date.now();
      const expiresAtMs = new Date(details.expiresAt).getTime();
      const remainingMs = Math.max(0, expiresAtMs - nowMs);
      const remainingSeconds = Math.floor(remainingMs / 1000);
      const activeStatuses = new Set(['created', 'broadcasting', 'active', 'partially_filled']);
      const isActive = activeStatuses.has(details.status) && remainingSeconds > 0;
      res.json({
        success: true,
        data: {
          orderId: details.id, status: details.status, remainingSeconds, isActive,
          expiresAt: details.expiresAt, dispatchState: details.dispatchState || 'queued',
          dispatchAttempts: Number(details.dispatchAttempts || 0),
          notifiedTransporters: Number(details.notifiedCount || 0),
          onlineCandidates: Number(details.onlineCandidatesCount || 0),
          reasonCode: details.dispatchReasonCode || null, serverTimeMs: Date.now()
        }
      });
    } catch (error) { return next(error); }
  }
);

// GET /bookings/orders/:orderId/broadcast-snapshot
router.get(
  '/orders/:orderId/broadcast-snapshot',
  authMiddleware,
  roleGuard(['customer', 'transporter', 'driver']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      const scopedOrder = await canonicalOrderService.getOrderWithRequests(orderId, req.user!.userId, req.user!.role);
      const details = { ...scopedOrder.order, truckRequests: scopedOrder.requests };
      const nowMs = Date.now();
      const expiresAtMs = new Date(details.expiresAt).getTime();
      const lifecycleState = normalizeOrderLifecycleState(details.status);
      const syncCursor = new Date(
        Math.max(nowMs, new Date(details.updatedAt ?? nowMs).getTime(), new Date(details.stateChangedAt ?? nowMs).getTime())
      ).toISOString();

      res.json({
        success: true,
        data: {
          orderId: details.id, state: lifecycleState, status: details.status,
          dispatchState: details.dispatchState || 'queued',
          reasonCode: details.dispatchReasonCode || null,
          eventVersion: Math.floor(new Date(details.updatedAt ?? Date.now()).getTime() / 1000),
          serverTimeMs: nowMs, expiresAtMs, syncCursor,
          order: {
            id: details.id, customerId: details.customerId, customerName: details.customerName,
            customerPhone: maskPhoneForExternal(details.customerPhone), pickup: details.pickup, drop: details.drop,
            distanceKm: details.distanceKm, totalTrucks: details.totalTrucks,
            trucksFilled: details.trucksFilled, totalAmount: details.totalAmount,
            goodsType: details.goodsType, weight: details.weight,
            status: details.status, expiresAt: details.expiresAt, createdAt: details.createdAt
          },
          requests: details.truckRequests.map((request: any) => ({
            id: request.id, orderId: request.orderId, requestNumber: request.requestNumber,
            vehicleType: request.vehicleType, vehicleSubtype: request.vehicleSubtype,
            pricePerTruck: request.pricePerTruck, status: request.status,
            assignedTransporterId: request.assignedTransporterId,
            assignedVehicleNumber: request.assignedVehicleNumber,
            assignedDriverName: request.assignedDriverName, createdAt: request.createdAt
          }))
        }
      });
    } catch (error) { return next(error); }
  }
);

export { router as bookingLegacyRouter };
