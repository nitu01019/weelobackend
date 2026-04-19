/**
 * =============================================================================
 * HOLD FINALIZE-RETRY PROCESSOR
 * =============================================================================
 *
 * Processes compensation jobs from the 'hold:finalize-retry' queue.
 * These jobs are enqueued when finalizeHoldConfirmation exhausts its
 * inline retries (3 attempts with exponential backoff).
 *
 * The processor attempts to mark the hold as 'expired' with a CAS guard
 * so that holds already in a terminal state are never overwritten.
 * If the hold has associated vehicles, they are released back to available.
 *
 * Registration: called from server.ts alongside registerHoldExpiryProcessor().
 *
 * @author Weelo Team
 * @version 1.0.0
 * =============================================================================
 */

import { prismaClient } from '../../shared/database/prisma.service';
import { onVehicleTransition } from '../../shared/services/vehicle-lifecycle.service';
import { logger } from '../../shared/services/logger.service';
import { queueService, QueueJob } from '../../shared/services/queue.service';
import { TERMINAL_HOLD_STATUSES, RELEASABLE_ASSIGNMENT_STATUSES } from './truck-hold.types';
import type { TruckHoldLedger } from '@prisma/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FinalizeRetryJobData {
  holdId: string;
  orderId: string;
  retriedAt: string;
}

// ---------------------------------------------------------------------------
// Queue name — must match the name used in queueService.enqueue() in
// truck-hold-confirm.service.ts (line ~664).
// ---------------------------------------------------------------------------
const QUEUE_NAME = 'hold:finalize-retry';

// ---------------------------------------------------------------------------
// Processor implementation
// ---------------------------------------------------------------------------

async function processFinalizeRetry(job: QueueJob<FinalizeRetryJobData>): Promise<void> {
  const { holdId, orderId } = job.data;

  logger.info('[FinalizeRetry] Processing compensation job', { holdId, orderId, jobId: job.id });

  try {
    // 1. Look up the hold
    const hold = await prismaClient.truckHoldLedger.findUnique({
      where: { holdId },
    });

    if (!hold) {
      logger.warn('[FinalizeRetry] Hold not found — already cleaned up', { holdId });
      return;
    }

    // 2. If already in a terminal state, nothing to do
    if (TERMINAL_HOLD_STATUSES.includes(hold.status)) {
      logger.info('[FinalizeRetry] Hold already in terminal state — no action needed', {
        holdId,
        status: hold.status,
      });
      return;
    }

    // 3. CAS guard: only expire holds NOT already in a terminal state
    const result = await prismaClient.truckHoldLedger.updateMany({
      where: {
        holdId,
        status: { notIn: TERMINAL_HOLD_STATUSES },
      },
      data: {
        status: 'expired',
        terminalReason: 'finalize_retry_compensation',
        releasedAt: new Date(),
      },
    });

    if (result.count === 0) {
      logger.info('[FinalizeRetry] Hold transitioned to terminal state concurrently — skipping', {
        holdId,
      });
      return;
    }

    logger.info('[FinalizeRetry] Marked hold as expired via compensation', { holdId, orderId });

    // 4. Release associated vehicles (same pattern as hold-expiry-cleanup)
    await releaseHoldVehicles(hold);

    logger.info('[FinalizeRetry] Compensation complete', { holdId, orderId });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('[FinalizeRetry] Error processing compensation job', {
      holdId,
      orderId,
      error: errMsg,
    });
    throw error; // Re-throw to trigger retry via queue
  }
}

// ---------------------------------------------------------------------------
// Vehicle release helper — mirrors hold-expiry-cleanup.releaseConfirmedVehicles
// ---------------------------------------------------------------------------

async function releaseHoldVehicles(hold: TruckHoldLedger): Promise<void> {
  if (!hold.orderId) {
    logger.warn('[FinalizeRetry] Hold has no orderId — cannot release vehicles', {
      holdId: hold.holdId,
    });
    return;
  }

  const assignments = await prismaClient.assignment.findMany({
    where: {
      orderId: hold.orderId,
      status: { in: RELEASABLE_ASSIGNMENT_STATUSES },
    },
  });

  if (assignments.length === 0) {
    logger.info('[FinalizeRetry] No releasable assignments found', { holdId: hold.holdId });
    return;
  }

  // Batch-fetch vehicles for all assignments
  const vehicleIds = [...new Set(assignments.map(a => a.vehicleId).filter(Boolean))];
  const vehicles = vehicleIds.length > 0
    ? await prismaClient.vehicle.findMany({
        where: { id: { in: vehicleIds } },
        select: { id: true, status: true, vehicleNumber: true, vehicleKey: true },
      })
    : [];
  const vehicleMap = new Map(vehicles.map(v => [v.id, v]));

  for (const assignment of assignments) {
    const vehicle = vehicleMap.get(assignment.vehicleId);
    if (!vehicle) continue;

    const oldStatus = vehicle.status;

    const [cancelResult, vehicleUpdated] = await prismaClient.$transaction(async (tx) => {
      const txCancelResult = await tx.assignment.updateMany({
        where: {
          id: assignment.id,
          status: { in: RELEASABLE_ASSIGNMENT_STATUSES },
        },
        data: { status: 'cancelled' },
      });

      if (txCancelResult.count === 0) {
        return [txCancelResult, { count: 0 }];
      }

      const txVehicleUpdated = await tx.vehicle.updateMany({
        where: { id: vehicle.id, status: { not: 'available' } },
        data: {
          status: 'available',
          currentTripId: null,
          assignedDriverId: null,
          lastStatusChange: new Date().toISOString(),
        },
      });

      return [txCancelResult, txVehicleUpdated];
    });

    if (cancelResult.count === 0) {
      logger.info('[FinalizeRetry] Assignment not cancelled — driver may have accepted', {
        holdId: hold.holdId,
        assignmentId: assignment.id,
      });
      continue;
    }

    if (vehicleUpdated.count > 0) {
      await onVehicleTransition(
        hold.transporterId,
        vehicle.id,
        vehicle.vehicleKey,
        oldStatus as string,
        'available',
        'finalizeRetry'
      );
    }

    logger.info('[FinalizeRetry] Released vehicle', {
      holdId: hold.holdId,
      vehicleId: vehicle.id,
      vehicleNumber: vehicle.vehicleNumber,
    });
  }
}

// ---------------------------------------------------------------------------
// Registration — called from server.ts
// ---------------------------------------------------------------------------

export function registerFinalizeRetryProcessor(): void {
  queueService.registerProcessor(QUEUE_NAME, processFinalizeRetry);
  logger.info(`[FinalizeRetry] Processor registered for queue: ${QUEUE_NAME}`);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { processFinalizeRetry, QUEUE_NAME as FINALIZE_RETRY_QUEUE_NAME };
export type { FinalizeRetryJobData };
