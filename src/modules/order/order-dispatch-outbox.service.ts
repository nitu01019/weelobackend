/**
 * =============================================================================
 * ORDER DISPATCH OUTBOX SERVICE - Durable dispatch outbox processing
 * =============================================================================
 *
 * Extracted from OrderService (Phase 3 of decomposition).
 * Handles the durable outbox pattern for order dispatch: enqueue, claim,
 * retry, and process dispatch rows with exponential back-off.
 *
 * Cross-reference: processDispatchOutboxRow and persistOrderDispatchSnapshot
 * call broadcastToTransporters / emitBroadcastStateChanged which are
 * extracted to order-broadcast.service.ts and imported directly.
 * =============================================================================
 */

import { v4 as uuidv4 } from 'uuid';
import { Prisma } from '@prisma/client';
import { db, OrderRecord } from '../../shared/database/db';
import { prismaClient } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import type {
  OrderDispatchOutboxPayload,
  DispatchAttemptContext,
  DispatchAttemptOutcome,
  DispatchOutboxRow,
} from './order-types';
import type { CreateOrderRequest, CreateOrderResponse } from './order.service';
import {
  broadcastToTransporters,
  emitBroadcastStateChanged,
} from './order-broadcast.service';

// ---------------------------------------------------------------------------
// Constants (moved from order.service.ts)
// ---------------------------------------------------------------------------

export const FF_ORDER_DISPATCH_OUTBOX = process.env.FF_ORDER_DISPATCH_OUTBOX !== 'false';
export const FF_ORDER_DISPATCH_STATUS_EVENTS = process.env.FF_ORDER_DISPATCH_STATUS_EVENTS !== 'false';
export const ORDER_DISPATCH_OUTBOX_POLL_MS = Math.max(500, parseInt(process.env.ORDER_DISPATCH_OUTBOX_POLL_MS || '1500', 10) || 1500);
export const ORDER_DISPATCH_OUTBOX_BATCH_SIZE = Math.max(1, parseInt(process.env.ORDER_DISPATCH_OUTBOX_BATCH_SIZE || '20', 10) || 20);

// ---------------------------------------------------------------------------
// Dispatch Outbox Functions
// ---------------------------------------------------------------------------

/**
 * Starts the dispatch outbox polling worker.
 * Called from OrderService constructor; state is managed via returned handles.
 */
export function startDispatchOutboxWorker(state: {
  outboxWorkerTimer: NodeJS.Timeout | null;
  outboxWorkerRunning: boolean;
  isShuttingDown: boolean;
}): NodeJS.Timeout | null {
  if (state.outboxWorkerTimer) return state.outboxWorkerTimer;

  const poll = async (): Promise<void> => {
    // Fix B10: Skip polling if shutting down
    if (state.isShuttingDown || state.outboxWorkerRunning) return;
    state.outboxWorkerRunning = true;
    try {
      await processDispatchOutboxBatch();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown';
      logger.error('Order dispatch outbox worker tick failed', {
        error: message
      });
    } finally {
      state.outboxWorkerRunning = false;
    }
  };

  // Fix B6: Add jitter to prevent thundering herd across instances
  const JITTER_MS = Math.floor(Math.random() * 500);
  const timer = setInterval(() => {
    void poll();
  }, ORDER_DISPATCH_OUTBOX_POLL_MS + JITTER_MS);
  timer.unref?.();
  void poll();

  logger.info('Order dispatch outbox worker started', {
    pollMs: ORDER_DISPATCH_OUTBOX_POLL_MS + JITTER_MS,
    batchSize: ORDER_DISPATCH_OUTBOX_BATCH_SIZE
  });

  return timer;
}

export function calculateDispatchRetryDelayMs(attempt: number): number {
  const cappedAttempt = Math.max(1, attempt);
  const baseMs = Math.min(60_000, Math.pow(2, cappedAttempt) * 1000);
  const jitterMs = Math.floor(Math.random() * 750);
  return baseMs + jitterMs;
}

export function parseDispatchOutboxPayload(payload: Prisma.JsonValue): OrderDispatchOutboxPayload | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const raw = payload as Record<string, unknown>;
  const orderId = typeof raw.orderId === 'string' ? raw.orderId.trim() : '';
  if (!orderId) return null;
  return { orderId };
}

export function orderDispatchOutboxDelegate(tx?: Prisma.TransactionClient) {
  return tx?.orderDispatchOutbox ?? prismaClient.orderDispatchOutbox;
}

export async function enqueueOrderDispatchOutbox(orderId: string, tx?: Prisma.TransactionClient): Promise<void> {
  await orderDispatchOutboxDelegate(tx).upsert({
    where: { orderId },
    update: {
      payload: { orderId },
      status: 'pending',
      nextRetryAt: new Date(),
      lockedAt: null,
      processedAt: null,
      lastError: null
    },
    create: {
      id: uuidv4(),
      orderId,
      payload: { orderId },
      status: 'pending',
      attempts: 0,
      maxAttempts: 8,
      nextRetryAt: new Date()
    }
  });
}

export async function claimDispatchOutboxByOrderId(orderId: string): Promise<DispatchOutboxRow | null> {
  const now = new Date();
  const staleLockBefore = new Date(now.getTime() - 120_000);
  const claim = await orderDispatchOutboxDelegate().updateMany({
    where: {
      orderId,
      status: { in: ['pending', 'retrying'] },
      nextRetryAt: { lte: now },
      OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }]
    },
    data: {
      status: 'processing',
      lockedAt: now
    }
  });
  if (claim.count === 0) return null;
  const row = await orderDispatchOutboxDelegate().findUnique({
    where: { orderId }
  });
  return row as DispatchOutboxRow | null;
}

// Fix B6: Replace N+1 CAS claiming with single atomic SQL using FOR UPDATE SKIP LOCKED.
// Prevents thundering herd when multiple instances poll concurrently.
export async function claimReadyDispatchOutboxRows(limit: number): Promise<DispatchOutboxRow[]> {
  const now = new Date();
  const staleLockBefore = new Date(now.getTime() - 120_000);

  try {
    const rows = await prismaClient.$queryRaw<DispatchOutboxRow[]>`
      UPDATE "OrderDispatchOutbox"
      SET "status" = 'processing',
          "lockedAt" = ${now}
      WHERE id IN (
        SELECT id FROM "OrderDispatchOutbox"
        WHERE "status" IN ('pending', 'retrying')
          AND "nextRetryAt" <= ${now}
          AND ("lockedAt" IS NULL OR "lockedAt" < ${staleLockBefore})
        ORDER BY "nextRetryAt" ASC, "createdAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `;
    return rows;
  } catch (err: unknown) {
    // H-D5 FIX: Rethrow to caller — processDispatchOutboxBatch.poll() already has try-catch
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[Outbox] SKIP LOCKED query failed, rethrowing to caller', { error: message });
    throw err;
  }
}

export async function buildDispatchAttemptContext(orderId: string): Promise<{
  order: OrderRecord;
  context: DispatchAttemptContext | null;
} | null> {
  const order = await db.getOrderById(orderId);
  if (!order) return null;

  const activeStatuses = new Set(['created', 'broadcasting', 'active', 'partially_filled']);
  if (!activeStatuses.has(String(order.status))) {
    return { order, context: null };
  }

  const truckRequests = await db.getTruckRequestsByOrder(orderId);
  const pickup = order.pickup;
  const requestFromOrder: CreateOrderRequest = {
    customerId: order.customerId,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    routePoints: order.routePoints,
    pickup: order.pickup,
    drop: order.drop,
    distanceKm: order.distanceKm,
    vehicleRequirements: [],
    goodsType: order.goodsType || undefined,
    cargoWeightKg: order.cargoWeightKg || undefined
  };

  return {
    order,
    context: {
      request: requestFromOrder,
      truckRequests,
      expiresAt: order.expiresAt,
      pickup
    }
  };
}

export async function persistOrderDispatchSnapshot(
  order: OrderRecord,
  outcome: DispatchAttemptOutcome
): Promise<void> {
  await db.updateOrder(order.id, {
    dispatchState: outcome.dispatchState,
    dispatchAttempts: outcome.dispatchAttempts,
    dispatchReasonCode: outcome.reasonCode || null,
    onlineCandidatesCount: outcome.onlineCandidates,
    notifiedCount: outcome.notifiedTransporters,
    lastDispatchAt: new Date()
  });

  // emitBroadcastStateChanged imported directly from order-broadcast.service.ts
  emitBroadcastStateChanged(order.customerId, {
    orderId: order.id,
    status: order.status,
    dispatchState: outcome.dispatchState,
    dispatchAttempts: outcome.dispatchAttempts,
    reasonCode: outcome.reasonCode,
    onlineCandidates: outcome.onlineCandidates,
    notifiedTransporters: outcome.notifiedTransporters,
    stateChangedAt: new Date().toISOString()
  });
}

export async function processDispatchOutboxRow(
  row: DispatchOutboxRow,
  providedContext?: DispatchAttemptContext
): Promise<DispatchAttemptOutcome> {
  const payload = parseDispatchOutboxPayload(row.payload);
  const resolvedOrderId = payload?.orderId || row.orderId;
  const attemptNumber = Math.max(1, row.attempts + 1);

  const built = await buildDispatchAttemptContext(resolvedOrderId);
  if (!built) {
    await orderDispatchOutboxDelegate().update({
      where: { id: row.id },
      data: {
        status: 'failed',
        attempts: attemptNumber,
        lastError: 'ORDER_NOT_FOUND',
        processedAt: new Date(),
        lockedAt: null
      }
    });
    return {
      dispatchState: 'dispatch_failed',
      reasonCode: 'ORDER_NOT_FOUND',
      onlineCandidates: 0,
      notifiedTransporters: 0,
      dispatchAttempts: attemptNumber
    };
  }

  const order = built.order;
  const activeStatuses = new Set(['created', 'broadcasting', 'active', 'partially_filled']);
  if (!activeStatuses.has(String(order.status))) {
    await orderDispatchOutboxDelegate().update({
      where: { id: row.id },
      data: {
        status: 'failed',
        attempts: attemptNumber,
        lastError: 'ORDER_INACTIVE',
        processedAt: new Date(),
        lockedAt: null
      }
    });
    const outcome: DispatchAttemptOutcome = {
      dispatchState: 'dispatch_failed',
      reasonCode: 'ORDER_INACTIVE',
      onlineCandidates: 0,
      notifiedTransporters: 0,
      dispatchAttempts: attemptNumber
    };
    await persistOrderDispatchSnapshot(order, outcome);
    return outcome;
  }

  const context = providedContext || built.context;
  if (!context) {
    const outcome: DispatchAttemptOutcome = {
      dispatchState: 'dispatch_failed',
      reasonCode: 'ORDER_INACTIVE',
      onlineCandidates: 0,
      notifiedTransporters: 0,
      dispatchAttempts: attemptNumber
    };
    await persistOrderDispatchSnapshot(order, outcome);
    return outcome;
  }

  try {
    // broadcastToTransporters imported directly from order-broadcast.service.ts
    const stats = await broadcastToTransporters(
      order.id,
      context.request,
      context.truckRequests,
      context.expiresAt,
      context.pickup
    );

    const noOnlineTransporters = stats.onlineCandidates === 0;
    const transientDispatchGap = stats.onlineCandidates > 0 && stats.notifiedTransporters === 0;
    const reasonCode = noOnlineTransporters
      ? 'NO_ONLINE_TRANSPORTERS'
      : transientDispatchGap
        ? 'DISPATCH_RETRYING'
        : undefined;
    const dispatchState: CreateOrderResponse['dispatchState'] = stats.notifiedTransporters > 0
      ? 'dispatched'
      : 'dispatch_failed';

    const shouldRetry = reasonCode === 'DISPATCH_RETRYING' && attemptNumber < row.maxAttempts;
    let finalReasonCode = reasonCode;
    if (shouldRetry) {
      const delayMs = calculateDispatchRetryDelayMs(attemptNumber);
      await orderDispatchOutboxDelegate().update({
        where: { id: row.id },
        data: {
          status: 'retrying',
          attempts: attemptNumber,
          nextRetryAt: new Date(Date.now() + delayMs),
          lastError: 'DISPATCH_RETRYING',
          lockedAt: null
        }
      });
    } else if (reasonCode === 'DISPATCH_RETRYING') {
      finalReasonCode = 'DISPATCH_FAILED';
      await orderDispatchOutboxDelegate().update({
        where: { id: row.id },
        data: {
          status: 'failed',
          attempts: attemptNumber,
          processedAt: new Date(),
          lastError: 'DISPATCH_RETRY_EXHAUSTED',
          lockedAt: null
        }
      });
    } else if (reasonCode === 'NO_ONLINE_TRANSPORTERS') {
      await orderDispatchOutboxDelegate().update({
        where: { id: row.id },
        data: {
          status: 'failed',
          attempts: attemptNumber,
          processedAt: new Date(),
          lastError: 'NO_ONLINE_TRANSPORTERS',
          lockedAt: null
        }
      });
    } else {
      await orderDispatchOutboxDelegate().update({
        where: { id: row.id },
        data: {
          status: 'dispatched',
          attempts: attemptNumber,
          processedAt: new Date(),
          lastError: null,
          lockedAt: null
        }
      });
    }

    const outcome: DispatchAttemptOutcome = {
      dispatchState,
      reasonCode: finalReasonCode,
      onlineCandidates: stats.onlineCandidates,
      notifiedTransporters: stats.notifiedTransporters,
      dispatchAttempts: attemptNumber
    };
    await persistOrderDispatchSnapshot(order, outcome);
    return outcome;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'DISPATCH_FAILED';
    const retryable = attemptNumber < row.maxAttempts;
    const reasonCode = retryable ? 'DISPATCH_RETRYING' : 'DISPATCH_FAILED';
    const updateData: any = retryable
      ? {
        status: 'retrying',
        attempts: attemptNumber,
        nextRetryAt: new Date(Date.now() + calculateDispatchRetryDelayMs(attemptNumber)),
        lastError: message,
        lockedAt: null
      }
      : {
        status: 'failed',
        attempts: attemptNumber,
        processedAt: new Date(),
        lastError: message,
        lockedAt: null
      };

    await orderDispatchOutboxDelegate().update({
      where: { id: row.id },
      data: updateData
    });

    const outcome: DispatchAttemptOutcome = {
      dispatchState: 'dispatch_failed',
      reasonCode,
      onlineCandidates: 0,
      notifiedTransporters: 0,
      dispatchAttempts: attemptNumber
    };
    await persistOrderDispatchSnapshot(order, outcome);
    return outcome;
  }
}

export async function processDispatchOutboxBatch(limit = ORDER_DISPATCH_OUTBOX_BATCH_SIZE): Promise<void> {
  if (!FF_ORDER_DISPATCH_OUTBOX) return;
  const rows = await claimReadyDispatchOutboxRows(limit);
  for (const row of rows) {
    try {
      await processDispatchOutboxRow(row);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown';
      logger.error('Order dispatch outbox row processing failed', {
        outboxId: row.id,
        orderId: row.orderId,
        error: message
      });
    }
  }
}

export async function processDispatchOutboxImmediately(
  orderId: string,
  context: DispatchAttemptContext
): Promise<DispatchAttemptOutcome | null> {
  if (!FF_ORDER_DISPATCH_OUTBOX) return null;
  const row = await claimDispatchOutboxByOrderId(orderId);
  if (!row) return null;
  return processDispatchOutboxRow(row, context);
}
