/**
 * =============================================================================
 * ORDER CANCEL SERVICE - Cancellation logic extracted from OrderService
 * =============================================================================
 *
 * Extracted from order.service.ts (Phase 8 of decomposition).
 * Contains: cancelOrder, buildCancelPayloadHash, getCancelIdempotentResponse,
 * persistCancelIdempotentResponse, registerCancelRebookChurn,
 * enforceCancelRebookCooldown, and cancel-related feature flags.
 * =============================================================================
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { Prisma } from '@prisma/client';
import { OrderRecord } from '../../shared/database/db';
import { prismaClient, withDbTimeout, OrderStatus, AssignmentStatus, VehicleStatus, TruckRequestStatus } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { generateVehicleKey } from '../../shared/services/vehicle-key.service';
import { AppError } from '../../shared/types/error.types';
import { metrics } from '../../shared/monitoring/metrics.service';
import { maskPhoneForExternal } from '../../shared/utils/pii.utils';
import { truckHoldService } from '../truck-hold/truck-hold.service';
import type {
  OrderLifecycleOutboxPayload,
  OrderCancelledOutboxPayload,
  CancelOrderResult,
} from './order-types';
import {
  FF_CANCEL_OUTBOX_ENABLED,
  enqueueCancelLifecycleOutbox as enqueueCancelLifecycleOutboxFn,
  processLifecycleOutboxImmediately as processLifecycleOutboxImmediatelyFn,
  emitCancellationLifecycle as emitCancellationLifecycleFn,
} from './order-lifecycle-outbox.service';
import {
  evaluateTruckCancelPolicy as evaluateTruckCancelPolicyFn,
} from './order-cancel-policy.service';
import {
  clearCustomerActiveBroadcast as clearCustomerActiveBroadcastFn,
} from './order-broadcast.service';
import {
  orderExpiryTimerKey as orderExpiryTimerKeyFn,
  clearProgressiveStepTimers as clearProgressiveStepTimersFn,
} from './order-timer.service';

// =============================================================================
// FEATURE FLAGS (cancel-specific)
// =============================================================================

export const FF_CANCEL_EVENT_VERSION_ENFORCED = process.env.FF_CANCEL_EVENT_VERSION_ENFORCED !== 'false';
export const FF_CANCEL_REBOOK_CHURN_GUARD = process.env.FF_CANCEL_REBOOK_CHURN_GUARD !== 'false';
export const FF_CANCEL_DEFERRED_SETTLEMENT = process.env.FF_CANCEL_DEFERRED_SETTLEMENT !== 'false';
export const FF_CANCEL_IDEMPOTENCY_REQUIRED = process.env.FF_CANCEL_IDEMPOTENCY_REQUIRED !== 'false';

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

export function buildCancelPayloadHash(orderId: string, reason?: string): string {
  const normalizedReason = (reason || '').trim().toLowerCase();
  return crypto
    .createHash('sha256')
    .update(`${orderId}::${normalizedReason}`)
    .digest('hex');
}

export async function getCancelIdempotentResponse(
  customerId: string,
  idempotencyKey: string,
  payloadHash: string
): Promise<CancelOrderResult | null> {
  const row = await prismaClient.orderCancelIdempotency.findUnique({
    where: {
      customerId_operation_idempotencyKey: {
        customerId,
        operation: 'cancel',
        idempotencyKey
      }
    }
  });
  if (!row) return null;
  if (row.payloadHash !== payloadHash) {
    throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key reused with different cancel payload');
  }
  return row.responseJson as unknown as CancelOrderResult;
}

export async function persistCancelIdempotentResponse(
  customerId: string,
  idempotencyKey: string,
  payloadHash: string,
  orderId: string,
  response: CancelOrderResult,
  statusCode: number
): Promise<void> {
  try {
    await prismaClient.orderCancelIdempotency.create({
      data: {
        id: uuidv4(),
        customerId,
        operation: 'cancel',
        idempotencyKey,
        payloadHash,
        orderId,
        statusCode,
        responseJson: response as unknown as Prisma.InputJsonValue
      }
    });
  } catch (error: unknown) {
    const prismaError = error as { code?: string };
    if (prismaError?.code !== 'P2002') throw error;
    const replay = await getCancelIdempotentResponse(customerId, idempotencyKey, payloadHash);
    if (!replay) {
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key conflict');
    }
  }
}

export async function registerCancelRebookChurn(customerId: string): Promise<void> {
  if (!FF_CANCEL_REBOOK_CHURN_GUARD) return;
  const countKey = `cancel:rebook:count:${customerId}`;
  const cooldownKey = `cancel:rebook:cooldown:${customerId}`;
  try {
    const newCount = await redisService.incr(countKey);
    if (newCount === 1) {
      await redisService.expire(countKey, 120).catch(() => false);
    }
    if (newCount > 6) {
      await redisService.set(cooldownKey, '120', 120);
    } else if (newCount > 3) {
      const existingTtl = await redisService.ttl(cooldownKey).catch(() => -1);
      if (existingTtl <= 0) {
        await redisService.set(cooldownKey, '15', 15);
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown';
    logger.warn('Failed to update cancel rebook churn counter', {
      customerId,
      error: message
    });
  }
}

export async function enforceCancelRebookCooldown(customerId: string): Promise<void> {
  if (!FF_CANCEL_REBOOK_CHURN_GUARD) return;
  const cooldownKey = `cancel:rebook:cooldown:${customerId}`;
  const remaining = await redisService.ttl(cooldownKey).catch(() => -1);
  if (remaining > 0) {
    metrics.incrementCounter('cancel_rebook_throttled_total', {
      bucket: remaining > 60 ? 'hard' : 'soft'
    });
    throw new AppError(
      429,
      'CANCEL_REBOOK_COOLDOWN',
      `Please wait ${remaining}s before creating another order.`,
      { retryAfter: remaining }
    );
  }
}

// =============================================================================
// MAIN CANCEL ORDER FUNCTION
// =============================================================================

export async function cancelOrder(
  orderId: string,
  customerId: string,
  reason?: string,
  idempotencyKey?: string,
  options: { createDispute?: boolean } = {}
): Promise<CancelOrderResult> {
  logger.info(`CANCEL ORDER: ${orderId} by customer ${customerId}`);
  const normalizedReason = (reason || '').trim();
  const effectiveReason = normalizedReason || 'Cancelled by customer';
  const payloadHash = buildCancelPayloadHash(orderId, effectiveReason);

  if (FF_CANCEL_IDEMPOTENCY_REQUIRED && !idempotencyKey) {
    logger.warn('[CANCEL] Idempotency key missing while strict flag is enabled', {
      orderId,
      customerId
    });
    throw new AppError(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'X-Idempotency-Key header is required for cancellation.'
    );
  }

  if (idempotencyKey) {
    const replay = await getCancelIdempotentResponse(customerId, idempotencyKey, payloadHash);
    if (replay) return replay;
  }

  // F-H2 FIX: Distributed lock prevents concurrent cancellation race conditions
  const lockKey = `lock:order-cancel:${orderId}`;
  const lockHolder = `cancel:${process.pid}:${Date.now()}`;
  const lock = await redisService.acquireLock(lockKey, lockHolder, 15);
  if (!lock.acquired) {
    throw new AppError(409, 'CANCEL_IN_PROGRESS', 'Order cancellation is already in progress');
  }

  try {

  let lifecycleOutboxId: string | null = null;
  let lifecyclePayload: OrderCancelledOutboxPayload | null = null;
  let closedHoldsCount = 0;
  let closedHoldIds: string[] = [];
  let result: CancelOrderResult = {
    success: false,
    message: 'Cancel failed',
    transportersNotified: 0
  };
  let statusCode = 400;
  // Live availability: capture vehicle data from inside transaction for post-commit hook
  let releasedVehicleData: Array<{ transporterId: string; vehicleId: string; vehicleType: string; vehicleSubtype: string; previousStatus: string }> = [];

  const cancellableOrderStatuses: OrderStatus[] = [
    OrderStatus.created,
    OrderStatus.broadcasting,
    OrderStatus.active,
    OrderStatus.partially_filled,
    OrderStatus.fully_filled
  ];
  const activeAssignmentStatuses: AssignmentStatus[] = [
    AssignmentStatus.pending,
    AssignmentStatus.driver_accepted,
    AssignmentStatus.en_route_pickup,
    AssignmentStatus.at_pickup,
    AssignmentStatus.in_transit
  ];

  // withDbTimeout enforces statement_timeout=8s inside the TX — prevents pool exhaustion on DB slowness.
  await withDbTimeout(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) {
      statusCode = 404;
      result = { success: false, message: 'Order not found', transportersNotified: 0 };
      return;
    }
    if (order.customerId !== customerId) {
      statusCode = 403;
      result = {
        success: false,
        message: 'You can only cancel your own orders',
        transportersNotified: 0
      };
      return;
    }

    const assignmentRows = await tx.assignment.findMany({
      where: { orderId, status: { in: activeAssignmentStatuses } },
      select: {
        id: true,
        status: true,
        driverId: true,
        tripId: true,
        vehicleId: true,
        transporterId: true,
        vehicleType: true,
        vehicleSubtype: true
      }
    });
    const stageEvaluation = evaluateTruckCancelPolicyFn(order as unknown as OrderRecord, assignmentRows, normalizedReason);
    metrics.incrementCounter('cancel_requests_total', {
      stage: stageEvaluation.stage.toLowerCase(),
      decision: stageEvaluation.decision
    });

    if (stageEvaluation.reasonRequired && !normalizedReason) {
      statusCode = 400;
      result = {
        success: false,
        message: 'Cancellation reason is required at this stage',
        transportersNotified: 0,
        policyStage: stageEvaluation.stage,
        cancelDecision: stageEvaluation.decision,
        reasonRequired: true,
        reasonCode: stageEvaluation.reasonCode,
        penaltyBreakdown: stageEvaluation.penaltyBreakdown,
        driverCompensationBreakdown: stageEvaluation.driverCompensationBreakdown,
        settlementState: stageEvaluation.settlementState,
        pendingPenaltyAmount: stageEvaluation.pendingPenaltyAmount,
        eventVersion: Number(order.lifecycleEventVersion || 0),
        serverTimeMs: Date.now()
      };
      return;
    }

    if (stageEvaluation.decision === 'blocked_dispute_only') {
      let disputeId: string | undefined;
      if (options.createDispute) {
        disputeId = uuidv4();
        await tx.cancelDispute.create({
          data: {
            id: disputeId,
            orderId,
            customerId,
            stage: stageEvaluation.stage,
            reasonCode: normalizedReason || stageEvaluation.reasonCode,
            notes: normalizedReason || null,
            status: 'open'
          }
        });
        metrics.incrementCounter('cancel_dispute_created_total', {
          stage: stageEvaluation.stage.toLowerCase()
        });
      }

      statusCode = 409;
      result = {
        success: false,
        message: disputeId
          ? 'Cancellation blocked. Dispute created.'
          : 'Cancellation blocked at this stage. Please raise a dispute.',
        transportersNotified: 0,
        policyStage: stageEvaluation.stage,
        cancelDecision: stageEvaluation.decision,
        reasonRequired: stageEvaluation.reasonRequired,
        reasonCode: stageEvaluation.reasonCode,
        penaltyBreakdown: stageEvaluation.penaltyBreakdown,
        driverCompensationBreakdown: stageEvaluation.driverCompensationBreakdown,
        settlementState: stageEvaluation.settlementState,
        pendingPenaltyAmount: stageEvaluation.pendingPenaltyAmount,
        disputeId,
        eventVersion: Number(order.lifecycleEventVersion || 0),
        serverTimeMs: Date.now()
      };
      return;
    }

    const updated = await tx.order.updateMany({
      where: {
        id: orderId,
        customerId,
        status: { in: cancellableOrderStatuses }
      },
      data: {
        status: OrderStatus.cancelled,
        stateChangedAt: new Date(),
        cancelledAt: new Date().toISOString(),
        cancellationReason: effectiveReason,
        lifecycleEventVersion: { increment: 1 }
      }
    });

    const refreshedOrder = await tx.order.findUnique({ where: { id: orderId } });
    if (!refreshedOrder) {
      statusCode = 404;
      result = { success: false, message: 'Order not found', transportersNotified: 0 };
      return;
    }

    if (updated.count === 0) {
      if (refreshedOrder.status === OrderStatus.cancelled) {
        statusCode = 200;
        result = {
          success: true,
          message: 'Order already cancelled',
          transportersNotified: 0,
          policyStage: stageEvaluation.stage,
          cancelDecision: 'allowed',
          reasonRequired: stageEvaluation.reasonRequired,
          reasonCode: stageEvaluation.reasonCode,
          penaltyBreakdown: stageEvaluation.penaltyBreakdown,
          driverCompensationBreakdown: stageEvaluation.driverCompensationBreakdown,
          settlementState: stageEvaluation.settlementState,
          pendingPenaltyAmount: stageEvaluation.pendingPenaltyAmount,
          eventVersion: Number(refreshedOrder.lifecycleEventVersion || 0),
          serverTimeMs: Date.now()
        };
        return;
      }
      statusCode = 409;
      result = {
        success: false,
        message: `Cannot cancel order in ${refreshedOrder.status} state`,
        transportersNotified: 0,
        policyStage: stageEvaluation.stage,
        cancelDecision: stageEvaluation.decision,
        reasonRequired: stageEvaluation.reasonRequired,
        reasonCode: stageEvaluation.reasonCode,
        penaltyBreakdown: stageEvaluation.penaltyBreakdown,
        driverCompensationBreakdown: stageEvaluation.driverCompensationBreakdown,
        settlementState: stageEvaluation.settlementState,
        pendingPenaltyAmount: stageEvaluation.pendingPenaltyAmount,
        eventVersion: Number(refreshedOrder.lifecycleEventVersion || 0),
        serverTimeMs: Date.now()
      };
      return;
    }

    const truckRequests = await tx.truckRequest.findMany({
      where: { orderId },
      select: {
        id: true,
        status: true,
        notifiedTransporters: true
      }
    });

    const activeHolds = await tx.truckHoldLedger.findMany({
      where: { orderId, status: 'active' },
      select: {
        holdId: true,
        transporterId: true,
        truckRequestIds: true
      }
    });
    closedHoldsCount = activeHolds.length;
    closedHoldIds = activeHolds.map((hold) => hold.holdId);

    for (const hold of activeHolds) {
      await tx.truckRequest.updateMany({
        where: {
          id: { in: hold.truckRequestIds },
          orderId,
          status: TruckRequestStatus.held,
          heldById: hold.transporterId
        },
        data: {
          status: TruckRequestStatus.cancelled,
          heldById: null,
          heldAt: null
        }
      });
      await tx.truckHoldLedger.update({
        where: { holdId: hold.holdId },
        data: {
          status: 'cancelled',
          terminalReason: 'ORDER_CANCELLED',
          releasedAt: new Date()
        }
      });
    }

    await tx.truckRequest.updateMany({
      where: {
        orderId,
        status: { in: [TruckRequestStatus.searching, TruckRequestStatus.held] }
      },
      data: {
        status: TruckRequestStatus.cancelled,
        heldById: null,
        heldAt: null
      }
    });

    if (assignmentRows.length > 0) {
      await tx.assignment.updateMany({
        where: {
          orderId,
          status: { in: activeAssignmentStatuses }
        },
        data: {
          status: AssignmentStatus.cancelled
        }
      });
    }

    const vehicleIdsToRelease = Array.from(
      new Set(
        assignmentRows
          .map((assignment) => assignment.vehicleId)
          .filter((id): id is string => Boolean(id))
      )
    );
    if (vehicleIdsToRelease.length > 0) {
      // A4#8: Capture actual vehicle statuses BEFORE releasing (not hardcoded)
      const vehicleStatusRows = await tx.vehicle.findMany({
        where: { id: { in: vehicleIdsToRelease } },
        select: { id: true, status: true }
      });
      const vehicleStatusMap = new Map(vehicleStatusRows.map(v => [v.id, v.status]));

      await tx.vehicle.updateMany({
        where: { id: { in: vehicleIdsToRelease }, status: { not: VehicleStatus.available } },
        data: {
          status: VehicleStatus.available,
          currentTripId: null,
          assignedDriverId: null
        }
      });
      // Capture data for post-commit live availability hook (with actual previous status)
      releasedVehicleData = assignmentRows
        .filter(a => a.vehicleId && a.transporterId)
        .map(a => ({
          transporterId: a.transporterId,
          vehicleId: a.vehicleId!,
          vehicleType: a.vehicleType || '',
          vehicleSubtype: a.vehicleSubtype || '',
          previousStatus: vehicleStatusMap.get(a.vehicleId!) || 'in_transit'
        }));
    }

    await tx.orderDispatchOutbox.updateMany({
      where: {
        orderId,
        status: { in: ['pending', 'retrying', 'processing'] }
      },
      data: {
        status: 'failed',
        processedAt: new Date(),
        lockedAt: null,
        lastError: 'ORDER_CANCELLED'
      }
    });

    const eventVersion = Number(refreshedOrder.lifecycleEventVersion || 1);
    const eventId = uuidv4();
    const serverTimeMs = Date.now();
    const cancelledAt = refreshedOrder.cancelledAt || new Date().toISOString();

    await tx.cancellationLedger.create({
      data: {
        id: uuidv4(),
        orderId,
        customerId,
        driverId: assignmentRows[0]?.driverId || null,
        policyStage: stageEvaluation.stage,
        reasonCode: normalizedReason || stageEvaluation.reasonCode,
        penaltyAmount: stageEvaluation.penaltyBreakdown.finalAmount,
        compensationAmount: stageEvaluation.driverCompensationBreakdown.finalAmount,
        settlementState: stageEvaluation.settlementState,
        cancelDecision: stageEvaluation.decision,
        eventVersion,
        idempotencyKey: idempotencyKey || null
      }
    });

    if (stageEvaluation.pendingPenaltyAmount > 0 && FF_CANCEL_DEFERRED_SETTLEMENT) {
      await tx.customerPenaltyDue.create({
        data: {
          id: uuidv4(),
          customerId,
          orderId,
          amount: stageEvaluation.pendingPenaltyAmount,
          state: 'due',
          nextOrderHint: 'Pending cancellation fee will be adjusted on next booking.'
        }
      });
    }

    const activeDriverIds = Array.from(
      new Set(
        assignmentRows
          .map((assignment) => assignment.driverId)
          .filter((id): id is string => Boolean(id))
      )
    );
    if (activeDriverIds.length > 0 && stageEvaluation.driverCompensationBreakdown.finalAmount > 0 && FF_CANCEL_DEFERRED_SETTLEMENT) {
      const perDriverAmount = Math.round((stageEvaluation.driverCompensationBreakdown.finalAmount / activeDriverIds.length) * 100) / 100;
      await tx.driverCompensationLedger.createMany({
        data: activeDriverIds.map((driverId) => ({
          id: uuidv4(),
          driverId,
          orderId,
          amount: perDriverAmount,
          state: 'pending'
        }))
      });
    }

    const now = new Date();
    await tx.cancellationAbuseCounter.upsert({
      where: { customerId },
      create: {
        customerId,
        cancelCount7d: 1,
        cancelCount30d: 1,
        cancelAfterLoadingCount: stageEvaluation.stage === 'LOADING_STARTED' ? 1 : 0,
        cancelRebook2mCount: 1,
        riskTier: stageEvaluation.stage === 'LOADING_STARTED' ? 'warning' : 'normal',
        lastCancelAt: now
      },
      update: {
        cancelCount7d: { increment: 1 },
        cancelCount30d: { increment: 1 },
        cancelAfterLoadingCount: stageEvaluation.stage === 'LOADING_STARTED'
          ? { increment: 1 }
          : undefined,
        cancelRebook2mCount: { increment: 1 },
        lastCancelAt: now,
        riskTier: stageEvaluation.stage === 'LOADING_STARTED' ? 'warning' : undefined
      }
    });

    const transporterIds = Array.from(
      truckRequests.reduce((set, row) => {
        (row.notifiedTransporters || []).forEach((id) => {
          if (typeof id === 'string' && id.trim().length > 0) set.add(id.trim());
        });
        return set;
      }, new Set<string>())
    );

    lifecyclePayload = {
      type: 'order_cancelled',
      orderId,
      customerId,
      transporters: transporterIds,
      drivers: assignmentRows
        .filter((assignment) => Boolean(assignment.driverId))
        .map((assignment) => ({
          driverId: String(assignment.driverId),
          tripId: assignment.tripId || undefined,
          customerName: refreshedOrder.customerName,
          customerPhone: maskPhoneForExternal(refreshedOrder.customerPhone),
          pickupAddress: (refreshedOrder.pickup as any)?.address || '',
          dropAddress: (refreshedOrder.drop as any)?.address || ''
        })),
      reason: effectiveReason,
      reasonCode: stageEvaluation.reasonCode,
      cancelledBy: 'customer',
      refundStatus: stageEvaluation.settlementState || 'none',
      assignmentIds: assignmentRows.map((a) => a.id),
      cancelledAt,
      eventId,
      eventVersion: FF_CANCEL_EVENT_VERSION_ENFORCED ? eventVersion : 1,
      serverTimeMs,
      compensationAmount: stageEvaluation.driverCompensationBreakdown?.finalAmount || 0,
      settlementState: stageEvaluation.settlementState || 'none'
    };

    if (FF_CANCEL_OUTBOX_ENABLED && lifecyclePayload) {
      lifecycleOutboxId = await enqueueCancelLifecycleOutboxFn(lifecyclePayload, tx);
    }

    statusCode = 200;
    result = {
      success: true,
      message: 'Order cancelled successfully',
      transportersNotified: transporterIds.length,
      driversNotified: lifecyclePayload.drivers?.length || 0,
      assignmentsCancelled: assignmentRows.length,
      policyStage: stageEvaluation.stage,
      cancelDecision: stageEvaluation.decision,
      reasonRequired: stageEvaluation.reasonRequired,
      reasonCode: stageEvaluation.reasonCode,
      penaltyBreakdown: stageEvaluation.penaltyBreakdown,
      driverCompensationBreakdown: stageEvaluation.driverCompensationBreakdown,
      settlementState: stageEvaluation.settlementState,
      pendingPenaltyAmount: stageEvaluation.pendingPenaltyAmount,
      eventId,
      eventVersion: lifecyclePayload.eventVersion,
      serverTimeMs
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeoutMs: 8000 });

  if (result.success) {
    await redisService.cancelTimer(orderExpiryTimerKeyFn(orderId));
    await clearProgressiveStepTimersFn(orderId);
    await clearCustomerActiveBroadcastFn(customerId);
    await registerCancelRebookChurn(customerId);
    await truckHoldService.clearHoldCacheEntries(closedHoldIds);

    // Live availability + fleet cache: vehicles released back to available AFTER transaction committed
    // A4#8: Use actual previous status instead of hardcoded 'in_transit'
    const { onVehicleTransition } = require('../../shared/services/vehicle-lifecycle.service');
    for (const rv of releasedVehicleData) {
      const vKey = generateVehicleKey(rv.vehicleType, rv.vehicleSubtype);
      onVehicleTransition(
        rv.transporterId, rv.vehicleId, vKey,
        rv.previousStatus, 'available', 'orderCancel'
      ).catch((err: any) => logger.warn('[ORDER] Vehicle transition sync failed', { error: err?.message }));
    }

    metrics.incrementCounter('holds_released_on_cancel_total', {
      bucket: closedHoldsCount > 0 ? 'has_holds' : 'none'
    }, Math.max(1, closedHoldsCount));

    if (FF_CANCEL_OUTBOX_ENABLED && lifecycleOutboxId) {
      try {
        await processLifecycleOutboxImmediatelyFn(lifecycleOutboxId);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'unknown';
        logger.warn('[CANCEL OUTBOX] immediate dispatch failed; worker will retry', {
          orderId,
          outboxId: lifecycleOutboxId,
          error: message
        });
      }
    } else if (lifecyclePayload) {
      await emitCancellationLifecycleFn(lifecyclePayload);
    }
  }

  if (idempotencyKey) {
    await persistCancelIdempotentResponse(
      customerId,
      idempotencyKey,
      payloadHash,
      orderId,
      result,
      statusCode
    );
  }

  return result;

  } finally {
    // F-H2: Always release the distributed lock
    await redisService.releaseLock(lockKey, lockHolder).catch(() => {});
  }
}
