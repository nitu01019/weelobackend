/**
 * =============================================================================
 * TRUCK HOLD CREATE — Hold Creation, Simple Confirm, Idempotency
 * =============================================================================
 *
 * FIX F-A-76 (thin-wrap marker, Strangler Fig intermediate — 2026-04-17):
 *   This file is DEPRECATED and scheduled for deletion in Phase 4 (post-soak).
 *   Zero non-test production importers (verified by d1-rajat Phase 1 grep).
 *   The canonical runtime surface is `truckHoldService` in truck-hold.service.ts
 *   (the monolith). The top-level functions exported here are preserved only
 *   because 14 existing test files use `fs.readFileSync` on this file's source
 *   text to verify fix-marker comments and code patterns (see audit d1-rajat.md).
 *   Phase 4 will migrate those assertions to the monolith source and then
 *   outright-delete this file. Until then, DO NOT import from this path in new
 *   production code — use `truckHoldService` instead. ESLint enforces this via
 *   `no-restricted-imports` (warn-level during soak, with test-override).
 *   See docs audits/phase3/e3-yash.md for the soak/delete plan.
 *
 * Handles:
 * - holdTrucks(): Atomic DB claim for truck holds
 * - confirmHold(): Simple hold confirmation (without vehicle/driver)
 * - Idempotency helpers for hold/release operations
 * - Metrics recording for hold outcomes
 */

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prismaClient, withDbTimeout, TruckRequestStatus, HoldPhase } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { metrics } from '../../shared/monitoring/metrics.service';
import {
  HoldTrucksRequest,
  HoldTrucksResponse,
  CONFIG,
  TERMINAL_ORDER_STATUSES,
  HOLD_EVENT_VERSION,
  FF_HOLD_DB_ATOMIC_CLAIM,
  FF_HOLD_STRICT_IDEMPOTENCY,
  FF_HOLD_RECONCILE_RECOVERY,
} from './truck-hold.types';

// =============================================================================
// IDEMPOTENCY HELPERS
// =============================================================================

export function normalizeVehiclePart(value: string | null | undefined): string {
  return (value || '').trim();
}

export function buildOperationPayloadHash(operation: 'hold' | 'release', payload: Record<string, unknown>): string {
  return crypto
    .createHash('sha256')
    .update(`${operation}:${JSON.stringify(payload)}`)
    .digest('hex');
}

export async function getIdempotentOperationResponse(
  transporterId: string,
  operation: 'hold' | 'release',
  idempotencyKey?: string
): Promise<{
  statusCode: number;
  response: HoldTrucksResponse | { success: boolean; message: string; error?: string };
  payloadHash: string;
} | null> {
  if (!FF_HOLD_STRICT_IDEMPOTENCY || !idempotencyKey) return null;

  const existing = await prismaClient.truckHoldIdempotency.findUnique({
    where: {
      transporterId_operation_idempotencyKey: {
        transporterId,
        operation,
        idempotencyKey
      }
    }
  });

  if (!existing) return null;

  return {
    statusCode: existing.statusCode,
    response: existing.responseJson as unknown as HoldTrucksResponse | { success: boolean; message: string; error?: string },
    payloadHash: existing.payloadHash
  };
}

export async function saveIdempotentOperationResponse(
  transporterId: string,
  operation: 'hold' | 'release',
  idempotencyKey: string | undefined,
  payloadHash: string,
  statusCode: number,
  response: HoldTrucksResponse | { success: boolean; message: string; error?: string }
): Promise<void> {
  if (!FF_HOLD_STRICT_IDEMPOTENCY || !idempotencyKey) return;

  await prismaClient.truckHoldIdempotency.upsert({
    where: {
      transporterId_operation_idempotencyKey: {
        transporterId,
        operation,
        idempotencyKey
      }
    },
    update: {
      payloadHash,
      statusCode,
      responseJson: response as unknown as Prisma.InputJsonValue
    },
    create: {
      id: uuidv4(),
      transporterId,
      operation,
      idempotencyKey,
      payloadHash,
      statusCode,
      responseJson: response as unknown as Prisma.InputJsonValue
    }
  });
}

export async function findActiveLedgerHold(
  transporterId: string,
  orderId: string,
  vehicleType: string,
  vehicleSubtype: string
) {
  const now = new Date();
  return prismaClient.truckHoldLedger.findFirst({
    where: {
      transporterId,
      orderId,
      vehicleType: { equals: vehicleType, mode: 'insensitive' },
      vehicleSubtype: { equals: vehicleSubtype, mode: 'insensitive' },
      status: 'active',
      expiresAt: { gt: now }
    },
    orderBy: { createdAt: 'desc' }
  });
}

export function recordHoldOutcomeMetrics(result: HoldTrucksResponse, startedAtMs: number, replay: boolean = false): void {
  const durationMs = Math.max(0, Date.now() - startedAtMs);
  metrics.observeHistogram('hold_latency_ms', durationMs, {
    replay: replay ? 'true' : 'false',
    result: result.success ? 'success' : 'failed'
  });
  if (replay) {
    metrics.incrementCounter('hold_idempotent_replay_total', {
      result: result.success ? 'success' : 'failed',
      reason: (result.error || 'none').toLowerCase()
    });
    return;
  }
  if (result.success) {
    metrics.incrementCounter('hold_success_total');
  } else {
    const reason = (result.error || 'unknown').toLowerCase();
    metrics.incrementCounter('hold_conflict_total', { reason });
  }
}

// =============================================================================
// HOLD TRUCKS
// =============================================================================

/**
 * HOLD TRUCKS
 * -----------
 * Called when transporter clicks "Accept X trucks"
 *
 * 1. Validates request
 * 2. Checks availability
 * 3. Marks truck requests as "held"
 * 4. Creates hold record with TTL
 * 5. Broadcasts update to all transporters
 *
 * @param request - Hold request details
 * @param broadcastFn - Callback to broadcast availability update
 * @returns HoldTrucksResponse
 */
export async function holdTrucks(
  request: HoldTrucksRequest,
  broadcastFn: (orderId: string) => void
): Promise<HoldTrucksResponse> {
  const holdStartedAtMs = Date.now();
  metrics.incrementCounter('hold_request_total');

  const transporterId = request.transporterId;
  const orderId = (request.orderId || '').trim();
  const vehicleType = normalizeVehiclePart(request.vehicleType);
  const vehicleSubtype = normalizeVehiclePart(request.vehicleSubtype);
  const quantity = Number(request.quantity);
  const idempotencyKey = request.idempotencyKey?.trim() || undefined;

  logger.info(`[TruckHold] Hold request: ${quantity}x ${vehicleType} ${vehicleSubtype} for order ${orderId}`);

  const payloadHash = buildOperationPayloadHash('hold', {
    orderId,
    vehicleType: vehicleType.toLowerCase(),
    vehicleSubtype: vehicleSubtype.toLowerCase(),
    quantity
  });

  const idempotentReplay = await getIdempotentOperationResponse(
    transporterId,
    'hold',
    idempotencyKey
  );
  if (idempotentReplay) {
    if (idempotentReplay.payloadHash !== payloadHash) {
      const conflict = {
        success: false,
        message: 'Idempotency key reused with a different hold payload.',
        error: 'IDEMPOTENCY_CONFLICT'
      };
      recordHoldOutcomeMetrics(conflict, holdStartedAtMs, true);
      return conflict;
    }
    const replayResponse = idempotentReplay.response as HoldTrucksResponse;
    recordHoldOutcomeMetrics(replayResponse, holdStartedAtMs, true);
    return replayResponse;
  }

  const eventId = uuidv4();
  const serverTimeMs = Date.now();
  let response: HoldTrucksResponse;
  let statusCode = 400;

  try {
    if (!orderId || !vehicleType || !Number.isFinite(quantity)) {
      response = {
        success: false,
        message: 'orderId, vehicleType and finite quantity are required.',
        error: 'VALIDATION_ERROR'
      };
      await saveIdempotentOperationResponse(transporterId, 'hold', idempotencyKey, payloadHash, statusCode, response);
      recordHoldOutcomeMetrics(response, holdStartedAtMs);
      return response;
    }

    if (!Number.isInteger(quantity) || quantity < CONFIG.MIN_HOLD_QUANTITY || quantity > CONFIG.MAX_HOLD_QUANTITY) {
      response = {
        success: false,
        message: `Quantity must be an integer between ${CONFIG.MIN_HOLD_QUANTITY} and ${CONFIG.MAX_HOLD_QUANTITY}.`,
        error: 'VALIDATION_ERROR'
      };
      await saveIdempotentOperationResponse(transporterId, 'hold', idempotencyKey, payloadHash, statusCode, response);
      recordHoldOutcomeMetrics(response, holdStartedAtMs);
      return response;
    }

    if (FF_HOLD_RECONCILE_RECOVERY) {
      const existingHold = await findActiveLedgerHold(transporterId, orderId, vehicleType, vehicleSubtype);
      if (existingHold) {
        statusCode = 200;
        response = {
          success: true,
          holdId: existingHold.holdId,
          expiresAt: existingHold.expiresAt,
          heldQuantity: existingHold.quantity,
          holdState: 'reserved',
          eventId,
          eventVersion: HOLD_EVENT_VERSION,
          serverTimeMs,
          message: `${existingHold.quantity} truck(s) already reserved for this request.`
        };
        await saveIdempotentOperationResponse(transporterId, 'hold', idempotencyKey, payloadHash, statusCode, response);
        recordHoldOutcomeMetrics(response, holdStartedAtMs, true);
        return response;
      }
    }

    // H-16 FIX: Check for existing FLEX hold before creating a legacy hold.
    // Prevents two parallel hold systems from creating overlapping holds
    // for the same order + transporter combination.
    const existingFlexHold = await prismaClient.truckHoldLedger.findFirst({
      where: {
        orderId,
        transporterId,
        status: 'active',
        phase: HoldPhase.FLEX,
      },
    });
    if (existingFlexHold) {
      response = {
        success: false,
        message: 'Active flex hold already exists. Use the flex hold API to manage it.',
        error: 'FLEX_HOLD_CONFLICT',
      };
      recordHoldOutcomeMetrics(response, holdStartedAtMs);
      return response;
    }

    const holdId = `HOLD_${uuidv4().substring(0, 8).toUpperCase()}`;
    const now = new Date();
    const holdDurationMs = CONFIG.HOLD_DURATION_SECONDS * 1000;
    let expiresAt = new Date(now.getTime() + holdDurationMs);
    let heldCount = 0;

    await withDbTimeout(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, expiresAt: true }
      });

      if (!order) throw new Error('ORDER_NOT_FOUND');
      if (TERMINAL_ORDER_STATUSES.has(order.status)) throw new Error('ORDER_INACTIVE');

      // AB3: Cap hold lifetime to broadcast/order remaining time.
      // A hold must never outlive its parent broadcast.
      const broadcastRemainingMs = new Date(order.expiresAt).getTime() - now.getTime();
      if (broadcastRemainingMs > 0) {
        const cappedDurationMs = Math.min(holdDurationMs, broadcastRemainingMs);
        expiresAt = new Date(now.getTime() + cappedDurationMs);
      }

      const claimedRows = FF_HOLD_DB_ATOMIC_CLAIM
        ? await tx.$queryRaw<Array<{ id: string }>>`
              SELECT id
              FROM "TruckRequest"
              WHERE "orderId" = ${orderId}
                AND lower("vehicleType") = lower(${vehicleType})
                AND lower("vehicleSubtype") = lower(${vehicleSubtype})
                AND "status" = 'searching'
              ORDER BY "requestNumber" ASC, "createdAt" ASC
              FOR UPDATE SKIP LOCKED
              LIMIT ${quantity}
            `
        : await tx.truckRequest.findMany({
          where: {
            orderId,
            vehicleType: { equals: vehicleType, mode: 'insensitive' },
            vehicleSubtype: { equals: vehicleSubtype, mode: 'insensitive' },
            status: TruckRequestStatus.searching
          },
          orderBy: [{ requestNumber: 'asc' }, { createdAt: 'asc' }],
          take: quantity,
          select: { id: true }
        });

      const selectedIds = claimedRows.map((row) => row.id);
      if (selectedIds.length < quantity) {
        throw new Error(`NOT_ENOUGH_AVAILABLE:${selectedIds.length}`);
      }

      const claimUpdate = await tx.truckRequest.updateMany({
        where: {
          id: { in: selectedIds },
          orderId,
          status: TruckRequestStatus.searching
        },
        data: {
          status: TruckRequestStatus.held,
          heldById: transporterId,
          heldAt: now.toISOString()
        }
      });

      if (claimUpdate.count !== quantity) {
        throw new Error('TRUCK_STATE_CHANGED');
      }

      await tx.truckHoldLedger.create({
        data: {
          holdId,
          orderId,
          transporterId,
          vehicleType,
          vehicleSubtype,
          quantity,
          truckRequestIds: selectedIds,
          status: 'active',
          expiresAt
        }
      });

      heldCount = claimUpdate.count;
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeoutMs: 8000
    });

    response = {
      success: true,
      holdId,
      expiresAt,
      heldQuantity: heldCount,
      holdState: 'reserved',
      eventId,
      eventVersion: HOLD_EVENT_VERSION,
      serverTimeMs,
      message: `${heldCount} truck(s) reserved for ${CONFIG.HOLD_DURATION_SECONDS} seconds. Assign drivers to finalize.`
    };
    statusCode = 200;

    broadcastFn(orderId);
    logger.info(`[TruckHold] ✅ Held ${heldCount} trucks. Hold ID: ${holdId}, Expires: ${expiresAt.toISOString()}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'HOLD_FAILED';
    if (message.startsWith('NOT_ENOUGH_AVAILABLE')) {
      const available = parseInt(message.split(':')[1] || '0', 10);
      response = {
        success: false,
        message: `Only ${available} trucks available right now.`,
        error: 'NOT_ENOUGH_AVAILABLE'
      };
    } else if (message === 'ORDER_NOT_FOUND') {
      response = {
        success: false,
        message: 'This request no longer exists.',
        error: 'ORDER_INACTIVE'
      };
    } else if (message === 'ORDER_INACTIVE') {
      response = {
        success: false,
        message: 'This request is no longer active.',
        error: 'ORDER_INACTIVE'
      };
    } else if (message === 'TRUCK_STATE_CHANGED') {
      response = {
        success: false,
        message: 'Truck availability changed. Please retry.',
        error: 'TRUCK_STATE_CHANGED'
      };
    } else {
      logger.error(`[TruckHold] Error holding trucks: ${message}`, error);
      response = {
        success: false,
        message: 'Failed to reserve trucks. Please retry.',
        error: 'INTERNAL_ERROR'
      };
    }
  }

  await saveIdempotentOperationResponse(transporterId, 'hold', idempotencyKey, payloadHash, statusCode, response);
  recordHoldOutcomeMetrics(response, holdStartedAtMs);
  return response;
}

// =============================================================================
// CONFIRM HOLD (Simple)
// =============================================================================

/**
 * CONFIRM HOLD (Simple)
 * ---------------------
 * Called when transporter confirms their selection within the hold period.
 * This is the SIMPLE version - just confirms the hold without vehicle/driver assignment.
 * Use confirmHoldWithAssignments() for full assignment flow.
 *
 * 1. Validates hold exists and is active
 * 2. Marks trucks as "assigned"
 * 3. Marks hold as "confirmed"
 * 4. Broadcasts update
 *
 * @param holdId - The hold ID to confirm
 * @param transporterId - The transporter confirming
 * @param releaseHoldFn - Callback to release hold on expiry
 * @param broadcastFn - Callback to broadcast availability update
 * @returns Success/failure response
 */
export async function confirmHold(
  holdId: string,
  transporterId: string,
  releaseHoldFn: (holdId: string, transporterId: string) => Promise<any>,
  broadcastFn: (orderId: string) => void
): Promise<{ success: boolean; message: string; assignedTrucks?: string[] }> {
  const confirmStartedAtMs = Date.now();
  logger.info(`[TruckHold] Simple confirm request: ${holdId} by ${transporterId}`);

  try {
    const hold = await prismaClient.truckHoldLedger.findUnique({ where: { holdId } });

    if (!hold) {
      return { success: false, message: 'Hold not found or expired' };
    }

    if (hold.transporterId !== transporterId) {
      return { success: false, message: 'This hold belongs to another transporter' };
    }

    if (hold.status !== 'active') {
      return { success: false, message: `Hold is ${hold.status}. Cannot confirm.` };
    }

    if (hold.expiresAt <= new Date()) {
      // Release the hold
      await releaseHoldFn(holdId, transporterId);
      return { success: false, message: 'Hold expired. Please try again.' };
    }

    const now = new Date().toISOString();
    const confirmed = await withDbTimeout(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: hold.orderId },
        select: { status: true, id: true }
      });
      if (!order || TERMINAL_ORDER_STATUSES.has(order.status)) {
        throw new Error('ORDER_INACTIVE');
      }

      const update = await tx.truckRequest.updateMany({
        where: {
          id: { in: hold.truckRequestIds },
          orderId: hold.orderId,
          status: TruckRequestStatus.held,
          heldById: transporterId
        },
        data: {
          status: TruckRequestStatus.assigned,
          assignedTransporterId: transporterId,
          assignedAt: now,
          heldById: null,
          heldAt: null
        }
      });

      if (update.count !== hold.quantity) {
        throw new Error('TRUCK_STATE_CHANGED');
      }

      await tx.order.update({
        where: { id: hold.orderId },
        data: { trucksFilled: { increment: hold.quantity } }
      });

      await tx.truckHoldLedger.update({
        where: { holdId },
        data: {
          status: 'confirmed',
          confirmedAt: new Date(),
          terminalReason: null
        }
      });

      return update.count;
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeoutMs: 8000
    });

    // 5. Broadcast update
    broadcastFn(hold.orderId);

    logger.info(`[TruckHold] ✅ Confirmed hold ${holdId}. ${confirmed} trucks assigned to ${transporterId}`);

    return {
      success: true,
      message: `${hold.quantity} truck(s) assigned successfully. Please assign drivers.`,
      assignedTrucks: hold.truckRequestIds
    };

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'ORDER_INACTIVE') {
      return { success: false, message: 'This request is no longer active.' };
    }
    if (message === 'TRUCK_STATE_CHANGED') {
      return { success: false, message: 'Some held trucks changed state. Please retry.' };
    }
    logger.error(`[TruckHold] Error confirming hold: ${message}`, error);
    return { success: false, message: 'Failed to confirm. Please try again.' };
  } finally {
    metrics.observeHistogram('confirm_latency_ms', Math.max(0, Date.now() - confirmStartedAtMs));
  }
}
