/**
 * =============================================================================
 * ORDER LIFECYCLE OUTBOX SERVICE - Durable lifecycle outbox processing
 * =============================================================================
 *
 * Extracted from OrderService (Phase 4 of decomposition).
 * Handles the durable outbox pattern for order lifecycle events (cancellation,
 * expiry): enqueue, claim, retry, and process lifecycle rows with exponential
 * back-off.
 *
 * Cross-reference: emitCancellationLifecycle and handleOrderExpiry call
 * broadcast methods (emitToTransportersWithAdaptiveFanout,
 * emitDriverCancellationEvents, clearCustomerActiveBroadcast, withEventMeta)
 * which are imported directly from order-broadcast.service.ts.
 * Timer methods (clearProgressiveStepTimers, orderExpiryTimerKey) are
 * imported directly from order-timer.service.ts (Phase 6 extraction).
 * =============================================================================
 */

import { v4 as uuidv4 } from 'uuid';
import { Prisma } from '@prisma/client';
import { db, OrderRecord } from '../../shared/database/db';
import { prismaClient, AssignmentStatus, OrderStatus } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, emitToBooking } from '../../shared/services/socket.service';
import { sendPushNotification, fcmService } from '../../shared/services/fcm.service';
import { queueService } from '../../shared/services/queue.service';
import { generateVehicleKey } from '../../shared/services/vehicle-key.service';
import { liveAvailabilityService } from '../../shared/services/live-availability.service';
import { redisService } from '../../shared/services/redis.service';
import { metrics } from '../../shared/monitoring/metrics.service';
import { maskPhoneForExternal } from '../../shared/utils/pii.utils';
import { truckHoldService } from '../truck-hold/truck-hold.service';
import { releaseVehicle } from '../../shared/services/vehicle-lifecycle.service';
import type {
  OrderLifecycleOutboxPayload,
  OrderCancelledOutboxPayload,
  TripCompletedOutboxPayload,
  LifecycleOutboxRow,
} from './order-types';
import type { CreateOrderResponse } from './order.service';
import {
  emitToTransportersWithAdaptiveFanout,
  emitDriverCancellationEvents,
  withEventMeta,
  clearCustomerActiveBroadcast,
} from './order-broadcast.service';
import {
  orderExpiryTimerKey,
  clearProgressiveStepTimers,
} from './order-timer.service';

// ---------------------------------------------------------------------------
// Constants (moved from order.service.ts)
// ---------------------------------------------------------------------------

export const FF_CANCEL_OUTBOX_ENABLED = process.env.FF_CANCEL_OUTBOX_ENABLED !== 'false';
export const ORDER_CANCEL_OUTBOX_POLL_MS = Math.max(500, parseInt(process.env.ORDER_CANCEL_OUTBOX_POLL_MS || '1500', 10) || 1500);
export const ORDER_CANCEL_OUTBOX_BATCH_SIZE = Math.max(1, parseInt(process.env.ORDER_CANCEL_OUTBOX_BATCH_SIZE || '20', 10) || 20);

// ---------------------------------------------------------------------------
// Lifecycle Outbox Functions
// ---------------------------------------------------------------------------

export function lifecycleOutboxDelegate(tx?: Prisma.TransactionClient) {
  return tx?.orderLifecycleOutbox ?? prismaClient.orderLifecycleOutbox;
}

export function parseLifecycleOutboxPayload(payload: Prisma.JsonValue): OrderLifecycleOutboxPayload | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  const type = typeof raw.type === 'string' ? raw.type : '';

  if (type === 'trip_completed') {
    return parseTripCompletedPayload(raw);
  }

  if (type !== 'order_cancelled') return null;
  return parseCancelledPayload(raw);
}

function parseCancelledPayload(raw: Record<string, unknown>): OrderCancelledOutboxPayload | null {
  const orderId = typeof raw.orderId === 'string' ? raw.orderId.trim() : '';
  const customerId = typeof raw.customerId === 'string' ? raw.customerId.trim() : '';
  if (!orderId || !customerId) return null;
  const transporters = Array.isArray(raw.transporters)
    ? raw.transporters.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const drivers: OrderCancelledOutboxPayload['drivers'] = Array.isArray(raw.drivers)
    ? raw.drivers.reduce<OrderCancelledOutboxPayload['drivers']>((acc, item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return acc;
      const row = item as Record<string, unknown>;
      const driverId = typeof row.driverId === 'string' ? row.driverId.trim() : '';
      if (!driverId) return acc;
      acc.push({
        driverId,
        tripId: typeof row.tripId === 'string' ? row.tripId : undefined,
        customerName: typeof row.customerName === 'string' ? row.customerName : undefined,
        customerPhone: typeof row.customerPhone === 'string' ? maskPhoneForExternal(row.customerPhone) : undefined,
        pickupAddress: typeof row.pickupAddress === 'string' ? row.pickupAddress : undefined,
        dropAddress: typeof row.dropAddress === 'string' ? row.dropAddress : undefined
      });
      return acc;
    }, [])
    : [];
  const reason = typeof raw.reason === 'string' && raw.reason.trim().length > 0
    ? raw.reason.trim()
    : 'Cancelled by customer';
  const reasonCode = typeof raw.reasonCode === 'string' && raw.reasonCode.trim().length > 0
    ? raw.reasonCode.trim()
    : 'CUSTOMER_CANCELLED';
  const cancelledBy = raw.cancelledBy === 'customer' || raw.cancelledBy === 'transporter' || raw.cancelledBy === 'system'
    ? raw.cancelledBy
    : 'customer';
  const refundStatus = typeof raw.refundStatus === 'string' && raw.refundStatus.trim().length > 0
    ? raw.refundStatus.trim()
    : 'none';
  const assignmentIds = Array.isArray(raw.assignmentIds)
    ? raw.assignmentIds.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const cancelledAt = typeof raw.cancelledAt === 'string' && raw.cancelledAt.trim().length > 0
    ? raw.cancelledAt
    : new Date().toISOString();
  const eventId = typeof raw.eventId === 'string' && raw.eventId.trim().length > 0
    ? raw.eventId
    : uuidv4();
  const eventVersion = Number(raw.eventVersion || 1);
  const serverTimeMs = Number(raw.serverTimeMs || Date.now());
  return {
    type: 'order_cancelled',
    orderId,
    customerId,
    transporters,
    drivers,
    reason,
    reasonCode,
    cancelledBy,
    refundStatus,
    assignmentIds,
    cancelledAt,
    eventId,
    eventVersion: Number.isFinite(eventVersion) && eventVersion > 0 ? Math.floor(eventVersion) : 1,
    serverTimeMs: Number.isFinite(serverTimeMs) && serverTimeMs > 0 ? Math.floor(serverTimeMs) : Date.now()
  };
}

function parseTripCompletedPayload(raw: Record<string, unknown>): TripCompletedOutboxPayload | null {
  const assignmentId = typeof raw.assignmentId === 'string' ? raw.assignmentId.trim() : '';
  const tripId = typeof raw.tripId === 'string' ? raw.tripId.trim() : '';
  const driverId = typeof raw.driverId === 'string' ? raw.driverId.trim() : '';
  const transporterId = typeof raw.transporterId === 'string' ? raw.transporterId.trim() : '';
  if (!assignmentId || !tripId || !driverId || !transporterId) return null;
  const bookingId = typeof raw.bookingId === 'string' ? raw.bookingId.trim() : '';
  const orderId = typeof raw.orderId === 'string' ? raw.orderId.trim() : '';
  const vehicleId = typeof raw.vehicleId === 'string' ? raw.vehicleId.trim() : '';
  const customerId = typeof raw.customerId === 'string' ? raw.customerId.trim() : '';
  const completedAt = typeof raw.completedAt === 'string' && raw.completedAt.trim().length > 0
    ? raw.completedAt
    : new Date().toISOString();
  const eventId = typeof raw.eventId === 'string' && raw.eventId.trim().length > 0
    ? raw.eventId
    : uuidv4();
  const eventVersion = Number(raw.eventVersion || 1);
  const serverTimeMs = Number(raw.serverTimeMs || Date.now());
  return {
    type: 'trip_completed',
    assignmentId,
    tripId,
    bookingId,
    orderId,
    vehicleId,
    transporterId,
    driverId,
    customerId,
    completedAt,
    eventId,
    eventVersion: Number.isFinite(eventVersion) && eventVersion > 0 ? Math.floor(eventVersion) : 1,
    serverTimeMs: Number.isFinite(serverTimeMs) && serverTimeMs > 0 ? Math.floor(serverTimeMs) : Date.now()
  };
}

export function calculateLifecycleRetryDelayMs(attempt: number): number {
  const scheduleMs = [1000, 2000, 4000, 8000, 16000, 30000, 60000];
  const base = scheduleMs[Math.max(0, Math.min(scheduleMs.length - 1, attempt - 1))];
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

/**
 * Starts the lifecycle outbox polling worker.
 * Called from OrderService constructor; state is managed via returned handles.
 */
export function startLifecycleOutboxWorker(state: {
  lifecycleOutboxWorkerTimer: NodeJS.Timeout | null;
  lifecycleOutboxWorkerRunning: boolean;
  isShuttingDown: boolean;
}): NodeJS.Timeout | null {
  if (state.lifecycleOutboxWorkerTimer) return state.lifecycleOutboxWorkerTimer;

  const poll = async (): Promise<void> => {
    if (state.lifecycleOutboxWorkerRunning) return;
    state.lifecycleOutboxWorkerRunning = true;
    try {
      await processLifecycleOutboxBatch();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown';
      logger.error('Order lifecycle outbox worker tick failed', {
        error: message
      });
    } finally {
      state.lifecycleOutboxWorkerRunning = false;
    }
  };

  const timer = setInterval(() => {
    void poll();
  }, ORDER_CANCEL_OUTBOX_POLL_MS);
  timer.unref?.();
  void poll();

  logger.info('Order lifecycle outbox worker started', {
    pollMs: ORDER_CANCEL_OUTBOX_POLL_MS,
    batchSize: ORDER_CANCEL_OUTBOX_BATCH_SIZE
  });

  return timer;
}

export async function enqueueCancelLifecycleOutbox(
  payload: OrderLifecycleOutboxPayload,
  tx?: Prisma.TransactionClient
): Promise<string> {
  const outboxId = uuidv4();
  await lifecycleOutboxDelegate(tx).create({
    data: {
      id: outboxId,
      orderId: payload.orderId,
      eventType: payload.type,
      payload: payload as unknown as Prisma.InputJsonValue,
      status: 'pending',
      attempts: 0,
      maxAttempts: 10,
      nextRetryAt: new Date()
    }
  });
  return outboxId;
}

export async function enqueueCompletionLifecycleOutbox(
  payload: TripCompletedOutboxPayload
): Promise<string> {
  const outboxId = uuidv4();
  // orderId may be empty for booking-path trips; use bookingId as fallback for the DB column
  const outboxOrderId = payload.orderId || payload.bookingId || payload.assignmentId;
  await lifecycleOutboxDelegate().create({
    data: {
      id: outboxId,
      orderId: outboxOrderId,
      eventType: 'trip_completed',
      payload: payload as unknown as Prisma.InputJsonValue,
      status: 'pending',
      attempts: 0,
      maxAttempts: 10,
      nextRetryAt: new Date()
    }
  });
  return outboxId;
}

export async function claimLifecycleOutboxById(outboxId: string): Promise<LifecycleOutboxRow | null> {
  const now = new Date();
  const staleLockBefore = new Date(now.getTime() - 120_000);
  const claimed = await lifecycleOutboxDelegate().updateMany({
    where: {
      id: outboxId,
      status: { in: ['pending', 'retrying'] },
      nextRetryAt: { lte: now },
      OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }]
    },
    data: {
      status: 'processing',
      lockedAt: now
    }
  });
  if (claimed.count === 0) return null;
  const row = await lifecycleOutboxDelegate().findUnique({ where: { id: outboxId } });
  return row as LifecycleOutboxRow | null;
}

export async function claimReadyLifecycleOutboxRows(limit: number): Promise<LifecycleOutboxRow[]> {
  const now = new Date();
  const staleLockBefore = new Date(now.getTime() - 120_000);

  try {
    const rows = await prismaClient.$queryRaw<LifecycleOutboxRow[]>`
      UPDATE "OrderLifecycleOutbox"
      SET "status" = 'processing',
          "lockedAt" = ${now}
      WHERE id IN (
        SELECT id FROM "OrderLifecycleOutbox"
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
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[Lifecycle Outbox] SKIP LOCKED query failed, rethrowing to caller', { error: message });
    throw err;
  }
}

export async function emitCancellationLifecycle(payload: OrderCancelledOutboxPayload): Promise<void> {
  const dismissalPayload = {
    broadcastId: payload.orderId,
    orderId: payload.orderId,
    reason: 'customer_cancelled',
    reasonCode: payload.reasonCode,
    message: 'Sorry, the customer cancelled this order',
    cancelledAt: payload.cancelledAt,
    eventId: payload.eventId,
    eventVersion: payload.eventVersion,
    serverTimeMs: payload.serverTimeMs,
    emittedAt: new Date().toISOString()
  };
  const cancellationPayload = {
    type: 'order_cancelled',
    orderId: payload.orderId,
    reason: payload.reason,
    reasonCode: payload.reasonCode,
    cancelledAt: payload.cancelledAt,
    eventId: payload.eventId,
    eventVersion: payload.eventVersion,
    serverTimeMs: payload.serverTimeMs,
    emittedAt: new Date().toISOString(),
    broadcastId: payload.orderId
  };

  if (payload.transporters.length > 0) {
    await emitToTransportersWithAdaptiveFanout(
      payload.transporters,
      [
        { event: 'order_cancelled', payload: cancellationPayload },
        { event: 'broadcast_dismissed', payload: dismissalPayload }
      ],
      'order_cancelled_lifecycle'
    );

    await queueService.queuePushNotificationBatch(payload.transporters, {
      title: '❌ Order Cancelled',
      body: `Order #${payload.orderId.slice(-8).toUpperCase()} was cancelled by customer`,
      priority: 'high', // W0-1: top-level priority drives FCM android.priority so transporters on doze see cancellation promptly.
      data: {
        type: 'order_cancelled',
        orderId: payload.orderId,
        broadcastId: payload.orderId,
        reasonCode: payload.reasonCode,
        cancelledAt: payload.cancelledAt,
        eventId: payload.eventId,
        eventVersion: String(payload.eventVersion),
        serverTimeMs: String(payload.serverTimeMs)
      }
    });
  }

  emitToUser(payload.customerId, 'order_cancelled', {
    orderId: payload.orderId,
    status: 'cancelled',
    reason: payload.reason,
    reasonCode: payload.reasonCode,
    cancelledBy: payload.cancelledBy,
    refundStatus: payload.refundStatus,
    assignmentIds: payload.assignmentIds,
    cancelledAt: payload.cancelledAt,
    stateChangedAt: payload.cancelledAt,
    eventId: payload.eventId,
    eventVersion: payload.eventVersion,
    serverTimeMs: payload.serverTimeMs,
    emittedAt: new Date().toISOString()
  });

  await queueService.queuePushNotificationBatch([payload.customerId], {
    title: 'Search cancelled',
    body: 'Your truck search was cancelled.',
    data: {
      type: 'order_cancelled',
      orderId: payload.orderId,
      broadcastId: payload.orderId,
      reasonCode: payload.reasonCode,
      cancelledAt: payload.cancelledAt,
      eventId: payload.eventId,
      eventVersion: String(payload.eventVersion),
      serverTimeMs: String(payload.serverTimeMs)
    }
  });

  for (const driver of payload.drivers) {
    emitDriverCancellationEvents(driver.driverId, {
      orderId: payload.orderId,
      tripId: driver.tripId,
      reason: payload.reason,
      message: 'Trip cancelled by customer',
      cancelledAt: payload.cancelledAt,
      customerName: driver.customerName || '',
      customerPhone: maskPhoneForExternal(driver.customerPhone || ''),
      pickupAddress: driver.pickupAddress || '',
      dropAddress: driver.dropAddress || '',
      compensationAmount: payload.compensationAmount,
      settlementState: payload.settlementState
    });
  }
}

// ---------------------------------------------------------------------------
// Trip Completed Lifecycle Emission
// ---------------------------------------------------------------------------
// Emits payment_pending Socket.IO event and FCM notification on trip completion.
// This is the TRIGGER for payment — no actual payment module exists yet.
// Follows same pattern as emitCancellationLifecycle above.
// ---------------------------------------------------------------------------

export async function emitTripCompletedLifecycle(payload: TripCompletedOutboxPayload): Promise<void> {
  const eventPayload = {
    type: 'trip_completed',
    assignmentId: payload.assignmentId,
    tripId: payload.tripId,
    bookingId: payload.bookingId,
    orderId: payload.orderId,
    vehicleId: payload.vehicleId,
    transporterId: payload.transporterId,
    driverId: payload.driverId,
    customerId: payload.customerId,
    completedAt: payload.completedAt,
    eventId: payload.eventId,
    eventVersion: payload.eventVersion,
    serverTimeMs: payload.serverTimeMs,
    emittedAt: new Date().toISOString()
  };

  logger.info('[TRIP_COMPLETED OUTBOX] Processing trip completion event', {
    assignmentId: payload.assignmentId,
    tripId: payload.tripId,
    bookingId: payload.bookingId,
    orderId: payload.orderId,
    driverId: payload.driverId,
    transporterId: payload.transporterId,
    customerId: payload.customerId,
    completedAt: payload.completedAt
  });

  // 1. Emit payment_pending to booking room (customer + transporter listening)
  const roomId = payload.bookingId || payload.orderId;
  if (roomId) {
    emitToBooking(roomId, 'payment_pending', eventPayload);
  }

  // 2. Direct Socket.IO to customer
  if (payload.customerId) {
    emitToUser(payload.customerId, 'payment_pending', eventPayload);
  }

  // 3. Direct Socket.IO to transporter
  if (payload.transporterId) {
    emitToUser(payload.transporterId, 'payment_pending', eventPayload);
  }

  // 4. FCM push to customer (covers background/killed app)
  if (payload.customerId) {
    await fcmService.notifyPayment(payload.customerId, {
      amount: 0, // Actual fare calculation is a future initiative
      tripId: payload.tripId,
      status: 'pending'
    }).catch((err: unknown) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn('[TRIP_COMPLETED OUTBOX] FCM payment notification to customer failed (non-fatal)', {
        customerId: payload.customerId,
        tripId: payload.tripId,
        error: errorMessage
      });
    });
  }

  // 5. FCM push to transporter
  if (payload.transporterId) {
    await fcmService.notifyPayment(payload.transporterId, {
      amount: 0,
      tripId: payload.tripId,
      status: 'pending'
    }).catch((err: unknown) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn('[TRIP_COMPLETED OUTBOX] FCM payment notification to transporter failed (non-fatal)', {
        transporterId: payload.transporterId,
        tripId: payload.tripId,
        error: errorMessage
      });
    });
  }

  logger.info('[TRIP_COMPLETED OUTBOX] Payment trigger emitted successfully', {
    assignmentId: payload.assignmentId,
    tripId: payload.tripId
  });
}

export async function processLifecycleOutboxRow(row: LifecycleOutboxRow): Promise<void> {
  const payload = parseLifecycleOutboxPayload(row.payload);
  const nextAttempt = Math.max(1, row.attempts + 1);
  if (!payload) {
    await lifecycleOutboxDelegate().update({
      where: { id: row.id },
      data: {
        status: 'failed',
        attempts: nextAttempt,
        processedAt: new Date(),
        lockedAt: null,
        lastError: 'INVALID_PAYLOAD',
        dlqReason: 'INVALID_PAYLOAD'
      }
    });
    return;
  }

  try {
    // Dispatch to the correct handler based on event type
    if (payload.type === 'trip_completed') {
      await emitTripCompletedLifecycle(payload);
    } else {
      await emitCancellationLifecycle(payload);
    }
    await lifecycleOutboxDelegate().update({
      where: { id: row.id },
      data: {
        status: 'dispatched',
        attempts: nextAttempt,
        processedAt: new Date(),
        lockedAt: null,
        lastError: null,
        dlqReason: null
      }
    });
  } catch (error: unknown) {
    const errorLabel = payload.type === 'trip_completed' ? 'TRIP_COMPLETED_EMIT_FAILED' : 'CANCEL_LIFECYCLE_EMIT_FAILED';
    const message = error instanceof Error ? error.message : errorLabel;
    const retryable = nextAttempt < row.maxAttempts;
    metrics.incrementCounter('cancel_emit_retry_total', {
      channel: 'lifecycle_outbox',
      retryable: retryable ? 'true' : 'false'
    });
    if (retryable) {
      await lifecycleOutboxDelegate().update({
        where: { id: row.id },
        data: {
          status: 'retrying',
          attempts: nextAttempt,
          nextRetryAt: new Date(Date.now() + calculateLifecycleRetryDelayMs(nextAttempt)),
          lockedAt: null,
          lastError: message
        }
      });
    } else {
      await lifecycleOutboxDelegate().update({
        where: { id: row.id },
        data: {
          status: 'failed',
          attempts: nextAttempt,
          processedAt: new Date(),
          lockedAt: null,
          lastError: message,
          dlqReason: 'RETRY_EXHAUSTED'
        }
      });
      logger.error('[LIFECYCLE OUTBOX] moved to DLQ', {
        outboxId: row.id,
        orderId: row.orderId,
        eventType: row.eventType,
        attempts: nextAttempt
      });
    }
  }
}

export async function processLifecycleOutboxBatch(limit = ORDER_CANCEL_OUTBOX_BATCH_SIZE): Promise<void> {
  if (!FF_CANCEL_OUTBOX_ENABLED) return;
  const rows = await claimReadyLifecycleOutboxRows(limit);
  for (const row of rows) {
    try {
      await processLifecycleOutboxRow(row);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown';
      logger.error('Order lifecycle outbox row processing failed', {
        outboxId: row.id,
        orderId: row.orderId,
        eventType: row.eventType,
        error: message
      });
    }
  }
}

export async function processLifecycleOutboxImmediately(outboxId: string): Promise<void> {
  if (!FF_CANCEL_OUTBOX_ENABLED) return;
  const row = await claimLifecycleOutboxById(outboxId);
  if (!row) return;
  await processLifecycleOutboxRow(row);
}

/**
 * Handle order expiry — marks unfilled truck requests as expired and notifies
 * all affected parties (customer, transporters, drivers).
 */
export async function handleOrderExpiry(orderId: string): Promise<void> {
  logger.info(`⏰ ORDER EXPIRED: ${orderId}`);

  const order = await db.getOrderById(orderId);
  if (!order) return;

  // Only expire if still in an expirable state
  if (order.status === OrderStatus.fully_filled || order.status === OrderStatus.completed || order.status === OrderStatus.cancelled) {
    return;
  }

  // Get all truck requests for this order
  const truckRequests = await db.getTruckRequestsByOrder(orderId);
  const unfilled = truckRequests.filter(tr => tr.status === 'searching');

  if (unfilled.length > 0) {
    // Update unfilled requests to expired
    const unfilledIds = unfilled.map(tr => tr.id);
    await db.updateTruckRequestsBatch(unfilledIds, { status: 'expired' });

    logger.info(`   ${unfilled.length} truck requests expired`);
  }

  // =========================================================================
  // Derive timeout reason before customer/transporter notifications
  // =========================================================================
  // Two customer-facing timeout cases:
  // 1) NO_ONLINE_TRANSPORTERS: no transporter matched in the configured radius waves
  // 2) NO_TRANSPORTER_ACCEPTANCE: transporters were notified but none accepted in time
  // =========================================================================
  const notifiedTransporters = new Set<string>();
  for (const tr of truckRequests) {
    if (tr.notifiedTransporters) {
      tr.notifiedTransporters.forEach((t: string) => notifiedTransporters.add(t));
    }
  }

  const transporterIds = Array.from(notifiedTransporters);
  const notifiedCount = transporterIds.length;
  // Fix B9: On timeout, expire the order regardless of partial fill count.
  // Partially filled orders should transition to 'expired', not stay as 'partially_filled'.
  const newStatus = 'expired';
  const reasonCode = order.trucksFilled > 0
    ? 'PARTIAL_FILL_TIMEOUT'
    : notifiedCount > 0
      ? 'NO_TRANSPORTER_ACCEPTANCE'
      : 'NO_ONLINE_TRANSPORTERS';
  const derivedDispatchState: CreateOrderResponse['dispatchState'] = order.trucksFilled > 0 ? 'dispatched' : 'dispatch_failed';
  const onlineCandidates = Math.max(order.onlineCandidatesCount || 0, notifiedCount);
  const expiredAt = new Date().toISOString();

  await db.updateOrder(orderId, {
    status: newStatus,
    stateChangedAt: new Date(),
    dispatchState: derivedDispatchState,
    dispatchReasonCode: reasonCode,
    onlineCandidatesCount: onlineCandidates,
    notifiedCount,
    lastDispatchAt: new Date()
  });

  const closedExpiryHolds = await truckHoldService.closeActiveHoldsForOrder(orderId, 'ORDER_EXPIRED');
  if (closedExpiryHolds > 0) {
    logger.info(`[ORDER EXPIRY] Closed ${closedExpiryHolds} active hold(s) for order ${orderId}`);
  }

  // Notify customer — includes explicit timeout reason for precise UX messaging.
  emitToUser(order.customerId, 'order_expired', withEventMeta({
    orderId,
    status: newStatus,
    expiredAt,
    totalTrucks: order.totalTrucks,
    trucksFilled: order.trucksFilled,
    reasonCode,
    onlineCandidates,
    notifiedTransporters: notifiedCount
  }));

  // =========================================================================
  // Notify ALL transporters to remove expired broadcast
  // =========================================================================
  // Uses queue for large fanout and keeps broadcast_dismissed compatibility.
  // =========================================================================

  if (transporterIds.length > 0) {
    const expiryEventId = uuidv4();
    const expiryPayload = {
      broadcastId: orderId,
      orderId,
      reason: 'timeout',
      timestamp: new Date().toISOString(),
      message: 'This booking request has expired',
      eventId: expiryEventId,
      emittedAt: new Date().toISOString()
    };

    // broadcast_dismissed feeds BroadcastListScreen overlay (same infrastructure as cancel)
    const expiredDismissData = {
      broadcastId: orderId,
      orderId,
      reason: 'timeout',
      message: 'This booking request has expired',
      cancelledAt: expiredAt,
      eventId: expiryEventId,
      emittedAt: new Date().toISOString()
    };

    await emitToTransportersWithAdaptiveFanout(
      transporterIds,
      [
        { event: 'broadcast_expired', payload: expiryPayload },
        { event: 'broadcast_dismissed', payload: expiredDismissData }
      ],
      'order_expiry'
    );
    logger.info(`   📱 Expiry broadcast dispatched to ${transporterIds.length} transporters`);

    // FCM: Push notification for background/closed app transporters
    await queueService.queuePushNotificationBatch(
      transporterIds,
      {
        title: '⏰ Request Expired',
        body: `A truck request has expired`,
        data: {
          type: 'broadcast_expired',
          orderId
        }
      }
    ).catch((err: unknown) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn(`FCM: Failed to queue expiry push for order ${orderId}: ${errorMessage}`);
    });
  }

  // GAP 4 FIX: Notify drivers whose trips are in-flight when order expires.
  // TripAcceptDeclineScreen only listens to 'order_cancelled', not 'order_expired'.
  // Without this, a driver stays on a dead TripAcceptDeclineScreen forever if
  // the 120s search timer fires while they are deciding.
  try {
    const cancellableAssignmentStatuses = [
      AssignmentStatus.pending,
      AssignmentStatus.driver_accepted,
      AssignmentStatus.en_route_pickup,
      AssignmentStatus.at_pickup,
      AssignmentStatus.in_transit
    ];

    const activeAssignments = await prismaClient.assignment.findMany({
      where: {
        orderId,
        status: { in: cancellableAssignmentStatuses }
      },
      select: {
        id: true, driverId: true, vehicleId: true, tripId: true,
        status: true, orderId: true, transporterId: true,
      },
      take: 200,  // FIX-27: Bound query to prevent unbounded result sets
    });

    if (activeAssignments.length > 0) {
      const candidateAssignmentIds = activeAssignments.map(a => a.id);

      // Atomic phase: pending assignments only (preconditioned to avoid races).
      await prismaClient.assignment.updateMany({
        where: {
          id: { in: candidateAssignmentIds },
          status: AssignmentStatus.pending
        },
        data: { status: AssignmentStatus.cancelled }
      });

      // Re-check and cancel any remaining in-flight assignments with status preconditions.
      const nonPendingStatuses = cancellableAssignmentStatuses.filter(
        (status) => status !== AssignmentStatus.pending
      );
      if (nonPendingStatuses.length > 0) {
        await prismaClient.assignment.updateMany({
          where: {
            id: { in: candidateAssignmentIds },
            status: { in: nonPendingStatuses }
          },
          data: { status: AssignmentStatus.cancelled }
        });
      }

      // Re-fetch the subset that is actually cancelled to avoid stale notifications.
      const cancelledAssignments = await prismaClient.assignment.findMany({
        where: {
          id: { in: candidateAssignmentIds },
          status: AssignmentStatus.cancelled
        },
        select: {
          id: true, driverId: true, vehicleId: true, tripId: true,
          status: true, orderId: true, transporterId: true,
        },
        take: 200,  // FIX-27: Bound query to prevent unbounded result sets
      });

      if (cancelledAssignments.length > 0) {
        const vehicleIdsToRelease = Array.from(
          new Set(
            cancelledAssignments
              .map((assignment) => assignment.vehicleId)
              .filter((id): id is string => Boolean(id))
          )
        );
        // Use centralized releaseVehicle() for validated transition + Redis sync
        for (const vId of vehicleIdsToRelease) {
          await releaseVehicle(vId, 'orderExpiry').catch((err: any) => {
            logger.warn('[ORDER_EXPIRY] Vehicle release failed', { vehicleId: vId, error: err.message });
          });
        }

        for (const assignment of cancelledAssignments) {
          if (assignment.driverId) {
            emitDriverCancellationEvents(assignment.driverId, {
              orderId,
              tripId: assignment.tripId,
              reason: 'timeout',
              message: 'This trip request has expired',
              cancelledAt: expiredAt,
              customerName: order.customerName,
              customerPhone: maskPhoneForExternal(order.customerPhone),
              pickupAddress: order.pickup?.address || '',
              dropAddress: order.drop?.address || ''
            });
            sendPushNotification(assignment.driverId, {
              title: 'Trip Expired',
              body: 'This trip request has expired.',
              data: {
                type: 'trip_cancelled',
                orderId,
                tripId: assignment.tripId || '',
                reason: 'timeout',
                cancelledAt: expiredAt
              }
            }).catch((err: unknown) => {
              const errorMessage = err instanceof Error ? err.message : String(err);
              logger.warn(`FCM to driver failed: ${errorMessage}`);
            });
          }
        }

        logger.info(`[EXPIRY] Notified ${cancelledAssignments.length} drivers of order expiry`);
      }
    }
  } catch (err: unknown) {
    // Non-blocking — expiry still succeeds even if driver notify fails
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn(`[EXPIRY] Failed to notify drivers (non-critical)`, { error: errorMessage });
  }

  // GAP 7 FIX: FCM push to customer for background/killed app.
  // handleOrderExpiry only did WS + transporter FCM, not customer FCM.
  await queueService.queuePushNotificationBatch(
    [order.customerId],
    {
      title: reasonCode === 'NO_ONLINE_TRANSPORTERS'
        ? 'No transporters available nearby'
        : reasonCode === 'NO_TRANSPORTER_ACCEPTANCE'
          ? 'No one accepted your request'
          : 'Search timed out',
      body: reasonCode === 'NO_ONLINE_TRANSPORTERS'
        ? 'No transporters were available in nearby area. Tap to search again.'
        : reasonCode === 'NO_TRANSPORTER_ACCEPTANCE'
          ? 'Transporters were notified, but no one accepted in time. Tap to search again.'
          : 'Your search timed out. Tap to search again.',
      data: {
        type: 'order_expired',
        orderId,
        status: newStatus,
        reasonCode
      }
    }
  ).catch((err: unknown) => {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn(`FCM: Failed to send expiry push to customer ${order.customerId}`, { error: errorMessage });
  });

  // Cleanup timers from Redis
  const expiryTimerKey = orderExpiryTimerKey(orderId);
  await redisService.cancelTimer(expiryTimerKey);
  await clearProgressiveStepTimers(orderId);

  // Clear customer active broadcast key (one-per-customer enforcement)
  await clearCustomerActiveBroadcast(order.customerId);
}
