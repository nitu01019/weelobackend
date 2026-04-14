/**
 * =============================================================================
 * TRUCK HOLD RELEASE — Release, Close, and Cache Cleanup
 * =============================================================================
 *
 * Handles:
 * - releaseHold(): Release a single hold (manual, cleanup, or system)
 * - closeActiveHoldsForOrder(): Close all active holds when order terminates
 * - clearHoldCacheEntries(): Clear Redis cache for hold IDs
 */

import { Prisma } from '@prisma/client';
import { prismaClient, withDbTimeout, TruckRequestStatus } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { metrics } from '../../shared/monitoring/metrics.service';
import { holdStore } from './truck-hold-store.service';
import {
  ACTIVE_ORDER_STATUSES,
  FF_HOLD_SAFE_RELEASE_GUARD,
} from './truck-hold.types';
import {
  buildOperationPayloadHash,
  getIdempotentOperationResponse,
  saveIdempotentOperationResponse,
} from './truck-hold-create.service';

// =============================================================================
// RELEASE HOLD
// =============================================================================

/**
 * RELEASE HOLD
 * ------------
 * Called when:
 * - Transporter clicks "Reject"
 * - Hold expires (cleanup job)
 * - Transporter closes app
 *
 * @param holdId - The hold ID to release
 * @param transporterId - The transporter releasing (optional, for validation)
 * @param idempotencyKey - Optional idempotency key
 * @param releaseSource - Source of the release
 * @param broadcastFn - Callback to broadcast availability update
 */
export async function releaseHold(
  holdId: string,
  transporterId: string | undefined,
  idempotencyKey: string | undefined,
  releaseSource: 'manual' | 'cleanup' | 'system',
  broadcastFn: (orderId: string) => void
): Promise<{ success: boolean; message: string; error?: string }> {
  logger.info(`[TruckHold] Release request: ${holdId}`);

  const normalizedHoldId = (holdId || '').trim();
  const payloadHash = buildOperationPayloadHash('release', { holdId: normalizedHoldId });
  if (transporterId && idempotencyKey) {
    const replay = await getIdempotentOperationResponse(transporterId, 'release', idempotencyKey);
    if (replay) {
      if (replay.payloadHash !== payloadHash) {
        return {
          success: false,
          message: 'Idempotency key reused with a different release payload.',
          error: 'IDEMPOTENCY_CONFLICT'
        };
      }
      return replay.response as { success: boolean; message: string; error?: string };
    }
  }

  let response: { success: boolean; message: string; error?: string } = { success: false, message: 'Failed to release hold', error: 'INTERNAL_ERROR' };

  try {
    if (!normalizedHoldId) {
      response = { success: false, message: 'holdId is required', error: 'VALIDATION_ERROR' };
      return response;
    }

    const hold = await prismaClient.truckHoldLedger.findUnique({ where: { holdId: normalizedHoldId } });

    if (!hold) {
      response = { success: false, message: 'Hold not found', error: 'HOLD_NOT_FOUND' };
      return response;
    }

    if (transporterId && hold.transporterId !== transporterId) {
      response = { success: false, message: 'This hold belongs to another transporter', error: 'FORBIDDEN' };
      return response;
    }

    if (hold.status !== 'active') {
      response = { success: true, message: 'Hold already released' };
      return response;
    }

    const resolvedTransporterId = hold.transporterId;
    await withDbTimeout(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: hold.orderId },
        select: { status: true }
      });

      const orderStatus = (order?.status || '').toString();
      const isActiveOrder = ACTIVE_ORDER_STATUSES.has(orderStatus);
      const nextTruckStatus: TruckRequestStatus = isActiveOrder
        ? TruckRequestStatus.searching
        : orderStatus === 'cancelled'
          ? TruckRequestStatus.cancelled
          : orderStatus === 'expired'
            ? TruckRequestStatus.expired
            : TruckRequestStatus.expired;

      const where: Prisma.TruckRequestWhereInput = {
        id: { in: hold.truckRequestIds },
        orderId: hold.orderId,
        status: TruckRequestStatus.held
      };

      if (FF_HOLD_SAFE_RELEASE_GUARD) {
        where.heldById = resolvedTransporterId;
      }

      await tx.truckRequest.updateMany({
        where,
        data: {
          status: nextTruckStatus,
          heldById: null,
          heldAt: null
        }
      });

      await tx.truckHoldLedger.update({
        where: { holdId: normalizedHoldId },
        data: {
          status: isActiveOrder
            ? 'released'
            : orderStatus === 'cancelled'
              ? 'cancelled'
              : 'expired',
          terminalReason: isActiveOrder ? 'RELEASED_BY_TRANSPORTER' : `ORDER_${orderStatus.toUpperCase() || 'INACTIVE'}`,
          releasedAt: new Date()
        }
      });
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeoutMs: 8000
    });

    // best-effort Redis cleanup for stale lock/index keys
    await holdStore.remove(normalizedHoldId).catch(() => { });

    // 3. Broadcast update
    broadcastFn(hold.orderId);

    logger.info(`[TruckHold] ✅ Released hold ${normalizedHoldId}. ${hold.quantity} trucks reconciled.`);
    if (releaseSource !== 'cleanup') {
      metrics.incrementCounter('hold_release_total', { source: releaseSource });
    }

    response = { success: true, message: 'Hold released successfully.' };
    return response;

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[TruckHold] Error releasing hold: ${message}`, error);
    response = { success: false, message: 'Failed to release hold', error: 'INTERNAL_ERROR' };
    return response;
  } finally {
    if (transporterId && idempotencyKey) {
      // FIX #94: statusCode inlined — derived from response.success instead of a separate variable
      await saveIdempotentOperationResponse(
        transporterId,
        'release',
        idempotencyKey,
        payloadHash,
        response.success ? 200 : 400,
        response
      ).catch(() => { });
    }
  }
}

// =============================================================================
// CLOSE ACTIVE HOLDS FOR ORDER
// =============================================================================

export async function closeActiveHoldsForOrder(
  orderId: string,
  terminalReason: 'ORDER_CANCELLED' | 'ORDER_EXPIRED'
): Promise<number> {
  const activeHolds = await prismaClient.truckHoldLedger.findMany({
    where: {
      orderId,
      status: 'active'
    },
    select: {
      holdId: true,
      transporterId: true,
      truckRequestIds: true
    }
  });

  if (activeHolds.length === 0) return 0;

  const terminalTruckStatus: TruckRequestStatus = terminalReason === 'ORDER_CANCELLED'
    ? TruckRequestStatus.cancelled
    : TruckRequestStatus.expired;

  // M-14 FIX: Process hold releases in parallel instead of sequentially.
  // When an order has many active holds, sequential processing adds unnecessary latency.
  const results = await Promise.allSettled(
    activeHolds.map(hold =>
      withDbTimeout(async (tx) => {
        await tx.truckRequest.updateMany({
          where: {
            id: { in: hold.truckRequestIds },
            orderId,
            status: TruckRequestStatus.held,
            heldById: hold.transporterId
          },
          data: {
            status: terminalTruckStatus,
            heldById: null,
            heldAt: null
          }
        });

        await tx.truckHoldLedger.update({
          where: { holdId: hold.holdId },
          data: {
            status: terminalReason === 'ORDER_CANCELLED' ? 'cancelled' : 'expired',
            terminalReason,
            releasedAt: new Date()
          }
        });
      }).then(() => holdStore.remove(hold.holdId).catch(() => {}))
    )
  );

  const failures = results.filter(r => r.status === 'rejected');
  if (failures.length > 0) {
    logger.warn(`[HoldRelease] ${failures.length}/${activeHolds.length} releases failed for order ${orderId}`);
  }

  return activeHolds.length;
}

// =============================================================================
// CLEAR HOLD CACHE ENTRIES
// =============================================================================

export async function clearHoldCacheEntries(holdIds: string[]): Promise<void> {
  if (!Array.isArray(holdIds) || holdIds.length === 0) return;
  for (const holdId of holdIds) {
    if (!holdId) continue;
    await holdStore.remove(holdId).catch(() => { });
  }
}
