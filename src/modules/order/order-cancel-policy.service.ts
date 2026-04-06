/**
 * =============================================================================
 * ORDER CANCEL POLICY SERVICE
 * =============================================================================
 *
 * Extracted from OrderService (Phase 7 of decomposition).
 * Contains cancel policy evaluation, preview, and dispute logic.
 *
 * Methods moved here:
 * - deriveTruckCancelStage
 * - calculateWaitingCharges
 * - createMoneyBreakdown
 * - evaluateTruckCancelPolicy
 * - getCancelPreview
 * - createCancelDispute
 * =============================================================================
 */

import { v4 as uuidv4 } from 'uuid';
import { db, OrderRecord } from '../../shared/database/db';
import { prismaClient, AssignmentStatus } from '../../shared/database/prisma.service';
import { metrics } from '../../shared/monitoring/metrics.service';
import type {
  TruckCancelPolicyStage,
  TruckCancelDecision,
  CancelMoneyBreakdown,
  TruckCancelPolicyEvaluation,
  CancelOrderResult,
} from './order-types';

// =============================================================================
// FEATURE FLAGS
// =============================================================================

const FF_CANCEL_POLICY_TRUCK_V1 = process.env.FF_CANCEL_POLICY_TRUCK_V1 !== 'false';

// =============================================================================
// CANCEL POLICY FUNCTIONS
// =============================================================================

export function deriveTruckCancelStage(
  order: Pick<OrderRecord, 'status' | 'loadingStartedAt' | 'unloadingStartedAt'>,
  assignments: Array<{ status: AssignmentStatus }>
): TruckCancelPolicyStage {
  if (order.unloadingStartedAt) return 'UNLOADING_STARTED';

  const statuses = new Set(assignments.map((assignment) => assignment.status));
  if (statuses.has(AssignmentStatus.in_transit)) return 'IN_TRANSIT';
  if (order.loadingStartedAt) return 'LOADING_STARTED';
  if (statuses.has(AssignmentStatus.at_pickup)) return 'AT_PICKUP';
  if (
    statuses.has(AssignmentStatus.pending) ||
    statuses.has(AssignmentStatus.driver_accepted) ||
    statuses.has(AssignmentStatus.en_route_pickup)
  ) {
    return 'DRIVER_ASSIGNED';
  }
  return 'SEARCHING';
}

export function calculateWaitingCharges(order: Pick<OrderRecord, 'stopWaitTimers'>): number {
  const nowMs = Date.now();
  const timers = Array.isArray(order.stopWaitTimers) ? order.stopWaitTimers : [];
  let waitingMinutes = 0;
  for (const timer of timers) {
    if (timer.departedAt) continue;
    const arrivedAtRaw = typeof timer.arrivedAt === 'string' ? timer.arrivedAt : '';
    if (!arrivedAtRaw) continue;
    const arrivedAtMs = new Date(arrivedAtRaw).getTime();
    if (!Number.isFinite(arrivedAtMs)) continue;
    waitingMinutes = Math.max(waitingMinutes, Math.floor((nowMs - arrivedAtMs) / 60_000));
  }
  const graceMinutes = 5;
  return Math.max(0, waitingMinutes - graceMinutes) * 5;
}

export function createMoneyBreakdown(
  baseCancellationFee: number,
  waitingCharges: number,
  percentageFareComponent: number,
  driverMinimumGuarantee: number
): CancelMoneyBreakdown {
  return {
    baseCancellationFee,
    waitingCharges,
    percentageFareComponent,
    driverMinimumGuarantee,
    finalAmount: Math.max(
      baseCancellationFee,
      waitingCharges,
      percentageFareComponent,
      driverMinimumGuarantee
    )
  };
}

export function evaluateTruckCancelPolicy(
  order: Pick<OrderRecord, 'totalAmount' | 'stopWaitTimers' | 'status' | 'loadingStartedAt' | 'unloadingStartedAt'>,
  assignments: Array<{ status: AssignmentStatus }>,
  reason?: string
): TruckCancelPolicyEvaluation {
  if (!FF_CANCEL_POLICY_TRUCK_V1) {
    return {
      stage: 'SEARCHING',
      decision: 'allowed',
      reasonRequired: false,
      reasonCode: 'CANCEL_POLICY_DISABLED',
      penaltyBreakdown: createMoneyBreakdown(0, 0, 0, 0),
      driverCompensationBreakdown: createMoneyBreakdown(0, 0, 0, 0),
      settlementState: 'waived',
      pendingPenaltyAmount: 0
    };
  }

  const stage = deriveTruckCancelStage(order, assignments);
  const waitingCharges = calculateWaitingCharges(order);
  const percentage30 = Math.round((Number(order.totalAmount || 0) * 0.30) * 100) / 100;

  let decision: TruckCancelDecision = 'allowed';
  let reasonRequired = false;
  let reasonCode = 'CUSTOMER_CANCELLED';
  let penaltyBreakdown = createMoneyBreakdown(0, 0, 0, 0);
  let driverCompensationBreakdown = createMoneyBreakdown(0, 0, 0, 0);

  switch (stage) {
    case 'SEARCHING':
      penaltyBreakdown = createMoneyBreakdown(0, 0, 0, 0);
      driverCompensationBreakdown = createMoneyBreakdown(0, 0, 0, 0);
      reasonCode = 'CANCEL_SEARCHING';
      break;
    case 'DRIVER_ASSIGNED':
      penaltyBreakdown = createMoneyBreakdown(50, 0, 0, 0);
      driverCompensationBreakdown = createMoneyBreakdown(50, 0, 0, 50);
      reasonCode = 'CANCEL_AFTER_ASSIGNMENT';
      break;
    case 'AT_PICKUP':
      reasonRequired = true;
      penaltyBreakdown = createMoneyBreakdown(100, waitingCharges, 0, 100);
      driverCompensationBreakdown = createMoneyBreakdown(100, waitingCharges, 0, 100);
      reasonCode = 'CANCEL_AT_PICKUP';
      break;
    case 'LOADING_STARTED':
      reasonRequired = true;
      penaltyBreakdown = createMoneyBreakdown(100, waitingCharges, percentage30, 100);
      driverCompensationBreakdown = createMoneyBreakdown(100, waitingCharges, Math.round((percentage30 * 0.5) * 100) / 100, 100);
      reasonCode = 'CANCEL_LOADING_STARTED';
      break;
    case 'IN_TRANSIT':
      decision = 'blocked_dispute_only';
      reasonRequired = true;
      reasonCode = 'CANCEL_BLOCKED_IN_TRANSIT';
      break;
    case 'UNLOADING_STARTED':
      decision = 'blocked_dispute_only';
      reasonRequired = true;
      reasonCode = 'CANCEL_BLOCKED_UNLOADING_STARTED';
      break;
  }

  if (reasonRequired && (!reason || reason.trim().length === 0)) {
    reasonCode = `${reasonCode}_REASON_REQUIRED`;
  }

  const pendingPenaltyAmount = decision === 'allowed' ? penaltyBreakdown.finalAmount : 0;
  const settlementState: 'pending' | 'settled' | 'waived' = decision !== 'allowed'
    ? 'waived'
    : (pendingPenaltyAmount > 0 || driverCompensationBreakdown.finalAmount > 0)
      ? 'pending'
      : 'settled';

  return {
    stage,
    decision,
    reasonRequired,
    reasonCode,
    penaltyBreakdown,
    driverCompensationBreakdown,
    settlementState,
    pendingPenaltyAmount
  };
}

export async function getCancelPreview(orderId: string, customerId: string, reason?: string): Promise<CancelOrderResult> {
  const order = await db.getOrderById(orderId);
  if (!order) {
    return { success: false, message: 'Order not found', transportersNotified: 0 };
  }
  if (order.customerId !== customerId) {
    return { success: false, message: 'You can only cancel your own orders', transportersNotified: 0 };
  }

  const assignments = await prismaClient.assignment.findMany({
    where: {
      orderId,
      status: {
        in: [
          AssignmentStatus.pending,
          AssignmentStatus.driver_accepted,
          AssignmentStatus.en_route_pickup,
          AssignmentStatus.at_pickup,
          AssignmentStatus.in_transit
        ]
      }
    },
    select: { status: true }
  });
  const evaluation = evaluateTruckCancelPolicy(order, assignments, reason);
  return {
    success: true,
    message: evaluation.decision === 'allowed'
      ? 'Cancellation allowed under current stage'
      : 'Cancellation blocked. Please use dispute.',
    transportersNotified: 0,
    policyStage: evaluation.stage,
    cancelDecision: evaluation.decision,
    reasonRequired: evaluation.reasonRequired,
    reasonCode: evaluation.reasonCode,
    penaltyBreakdown: evaluation.penaltyBreakdown,
    driverCompensationBreakdown: evaluation.driverCompensationBreakdown,
    settlementState: evaluation.settlementState,
    pendingPenaltyAmount: evaluation.pendingPenaltyAmount,
    serverTimeMs: Date.now(),
    eventVersion: Number(order.lifecycleEventVersion || 0)
  };
}

export async function createCancelDispute(
  orderId: string,
  customerId: string,
  reasonCode?: string,
  notes?: string
): Promise<{ success: boolean; disputeId?: string; message: string; stage?: TruckCancelPolicyStage }> {
  const order = await db.getOrderById(orderId);
  if (!order) return { success: false, message: 'Order not found' };
  if (order.customerId !== customerId) return { success: false, message: 'You can only dispute your own orders' };

  const assignments = await prismaClient.assignment.findMany({
    where: {
      orderId,
      status: {
        in: [
          AssignmentStatus.pending,
          AssignmentStatus.driver_accepted,
          AssignmentStatus.en_route_pickup,
          AssignmentStatus.at_pickup,
          AssignmentStatus.in_transit
        ]
      }
    },
    select: { status: true }
  });
  const stage = deriveTruckCancelStage(order, assignments);
  if (stage !== 'IN_TRANSIT' && stage !== 'UNLOADING_STARTED') {
    return {
      success: false,
      message: 'Dispute can be raised only when cancellation is blocked in transit/unloading stage',
      stage
    };
  }

  const disputeId = uuidv4();
  await prismaClient.cancelDispute.create({
    data: {
      id: disputeId,
      orderId,
      customerId,
      stage,
      reasonCode: reasonCode || null,
      notes: notes || null,
      status: 'open'
    }
  });

  metrics.incrementCounter('cancel_dispute_created_total', { stage: stage.toLowerCase() });
  return { success: true, disputeId, message: 'Dispute created successfully', stage };
}
