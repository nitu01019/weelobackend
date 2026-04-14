/**
 * =============================================================================
 * COMPLETION ORCHESTRATOR — Single entry point for trip completion
 * =============================================================================
 *
 * ROOT CAUSE (C1): Two independent completion paths exist:
 *   - tracking.service.ts (driver-initiated via driver app)
 *   - assignment.service.ts (admin/API path via updateStatus)
 *
 * Neither implements ALL required side-effects. The tracking path misses
 * outbox rows, rating prompts, and cache cleanup. The assignment path
 * misses Redis tracking cleanup and booking/order cascade.
 *
 * SOLUTION: Single completeTrip() function with the full side-effect
 * checklist, called by both paths. Each side-effect is wrapped in
 * try/catch so one failure cannot block others.
 *
 * Industry reference: Uber "Trip Completion Checklist" pattern.
 *
 * Issues resolved: C1, H16, H17, M6, M7
 * =============================================================================
 */

import { v4 as uuid } from 'uuid';
import { prismaClient } from '../../shared/database/prisma.service';
import { db } from '../../shared/database/db';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { queueService } from '../../shared/services/queue.service';
import { emitToUser, emitToBooking, emitToTrip, SocketEvent } from '../../shared/services/socket.service';
import { TERMINAL_ASSIGNMENT_STATUSES } from '../../core/state-machines';
import { liveAvailabilityService } from '../../shared/services/live-availability.service';
import { invalidateVehicleCache } from '../../shared/services/fleet-cache-write.service';
import { enqueueCompletionLifecycleOutbox } from '../order/order-lifecycle-outbox.service';
import type { TripCompletedOutboxPayload } from '../order/order-types';
import { trackingService } from '../tracking/tracking.service';

// =============================================================================
// TYPES
// =============================================================================

type CompletedBy = 'driver' | 'admin' | 'timeout';

interface CompletionResult {
  success: boolean;
  assignmentId: string;
  /** True if this call was a no-op because the trip was already completed */
  alreadyCompleted: boolean;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Idempotency lock TTL — prevents double-completion from concurrent requests */
const IDEMPOTENCY_LOCK_TTL_SECONDS = 30;

/** Delay before sending rating prompt FCM (ms) */
const RATING_PROMPT_DELAY_MS = 3 * 60 * 1000; // 3 minutes

/** Rating reminder Redis key TTLs */
const RATING_REMINDER_24H_TTL = 24 * 3600;
const RATING_REMINDER_72H_TTL = 72 * 3600;

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================

/**
 * Unified trip completion function. Executes the full side-effect checklist
 * in order. Each non-DB side-effect is wrapped in try/catch so one failure
 * does not block the others.
 *
 * @param assignmentId - The assignment to complete
 * @param completedBy  - Who triggered completion (for logging/audit)
 * @param terminalStatus - 'completed' or 'partial_delivery' (L-17)
 * @param partialReason - Reason string when terminalStatus is 'partial_delivery'
 */
export async function completeTrip(
  assignmentId: string,
  completedBy: CompletedBy,
  terminalStatus: 'completed' | 'partial_delivery' = 'completed',
  partialReason?: string
): Promise<CompletionResult> {
  const logCtx = { assignmentId, completedBy, terminalStatus };

  // =========================================================================
  // (a) Idempotency guard — Redis SET NX prevents double-completion
  // =========================================================================
  const lockKey = `completion:${assignmentId}`;
  const holderId = `completion:${process.pid}:${Date.now()}`;
  const lock = await redisService.acquireLock(lockKey, holderId, IDEMPOTENCY_LOCK_TTL_SECONDS);

  if (!lock.acquired) {
    logger.info('[COMPLETION] Already in progress (idempotency guard)', logCtx);
    return { success: true, assignmentId, alreadyCompleted: true };
  }

  try {
    // Fetch the full assignment record
    const assignment = await db.getAssignmentById(assignmentId);
    if (!assignment) {
      logger.warn('[COMPLETION] Assignment not found', logCtx);
      return { success: false, assignmentId, alreadyCompleted: false };
    }

    // Already terminal — idempotent no-op
    const TERMINAL = new Set<string>(TERMINAL_ASSIGNMENT_STATUSES);
    if (TERMINAL.has(assignment.status)) {
      logger.info('[COMPLETION] Assignment already terminal', { ...logCtx, currentStatus: assignment.status });
      return { success: true, assignmentId, alreadyCompleted: true };
    }

    const completedAt = new Date().toISOString();

    // =========================================================================
    // (b) Atomic $transaction: assignment → terminal + vehicle → available
    // =========================================================================
    // H17 fix: Both writes in one transaction — no partial state possible.
    let actualVehicleStatus = 'in_transit';
    if (assignment.vehicleId) {
      const veh = await prismaClient.vehicle.findUnique({
        where: { id: assignment.vehicleId },
        select: { status: true }
      });
      if (veh?.status) actualVehicleStatus = veh.status;
    }

    await prismaClient.$transaction(async (tx) => {
      // CAS guard: only update if not already terminal
      const result = await tx.assignment.updateMany({
        where: {
          id: assignmentId,
          status: { notIn: [...TERMINAL_ASSIGNMENT_STATUSES] as any }
        },
        data: {
          status: terminalStatus as any,
          completedAt
        }
      });

      if (result.count === 0) {
        // Another path completed it between our check and TX — idempotent
        logger.info('[COMPLETION] CAS guard: assignment already terminal in TX', logCtx);
        return;
      }

      if (assignment.vehicleId) {
        await tx.vehicle.updateMany({
          where: { id: assignment.vehicleId, status: { not: 'available' } },
          data: {
            status: 'available',
            currentTripId: null,
            assignedDriverId: null,
            lastStatusChange: new Date().toISOString()
          }
        });
      }
    });

    // Post-transaction: Redis vehicle availability sync (non-fatal)
    if (assignment.vehicleId) {
      try {
        const vehicle = await prismaClient.vehicle.findUnique({
          where: { id: assignment.vehicleId },
          select: { vehicleKey: true, transporterId: true }
        });
        if (vehicle?.vehicleKey && assignment.transporterId) {
          await liveAvailabilityService.onVehicleStatusChange(
            assignment.transporterId, vehicle.vehicleKey, actualVehicleStatus, 'available'
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('[COMPLETION] Redis vehicle sync failed (non-fatal)', { ...logCtx, error: msg });
      }
    }

    logger.info('[COMPLETION] Atomic TX committed', { ...logCtx, vehicleId: assignment.vehicleId });

    // =========================================================================
    // (c) Redis tracking cleanup — completeTracking keys
    // =========================================================================
    try {
      await trackingService.completeTracking(assignment.tripId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[COMPLETION] completeTracking cleanup failed (non-fatal)', { ...logCtx, error: msg });
    }

    // =========================================================================
    // (d) Write trip_completed outbox row (payment trigger)
    // =========================================================================
    try {
      const customerId = await resolveCustomerId(assignment.bookingId, assignment.orderId);
      const outboxPayload: TripCompletedOutboxPayload = {
        type: 'trip_completed',
        assignmentId,
        tripId: assignment.tripId,
        bookingId: assignment.bookingId || '',
        orderId: assignment.orderId || '',
        vehicleId: assignment.vehicleId || '',
        transporterId: assignment.transporterId,
        driverId: assignment.driverId,
        customerId: customerId || '',
        completedAt,
        eventId: uuid(),
        eventVersion: 1,
        serverTimeMs: Date.now()
      };
      await enqueueCompletionLifecycleOutbox(outboxPayload);
      logger.info('[COMPLETION] Outbox row written', { assignmentId, tripId: assignment.tripId });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[COMPLETION] Outbox write failed (non-fatal)', { ...logCtx, error: msg });
    }

    // =========================================================================
    // (e) Schedule rating prompt (3-min delayed FCM)
    // =========================================================================
    const ratingCustomerId = await resolveCustomerId(assignment.bookingId, assignment.orderId);
    if (ratingCustomerId) {
      try {
        setTimeout(async () => {
          try {
            await queueService.queuePushNotification(ratingCustomerId, {
              title: 'How was your delivery?',
              body: `Rate your experience with ${assignment.driverName || 'your driver'}`,
              data: { type: 'rating_prompt', assignmentId, tripId: assignment.tripId, screen: 'RATING' }
            });
          } catch (err) {
            logger.warn('[COMPLETION] Rating prompt FCM failed', { assignmentId });
          }
        }, RATING_PROMPT_DELAY_MS);
      } catch (err: unknown) {
        logger.warn('[COMPLETION] Rating prompt scheduling failed (non-fatal)', { assignmentId });
      }

      // =====================================================================
      // (f) Set rating reminder Redis keys (24h/72h TTL)
      // =====================================================================
      try {
        const reminderData = JSON.stringify({
          customerId: ratingCustomerId,
          assignmentId,
          driverName: assignment.driverName || 'your driver'
        });
        redisService.set(`rating:remind:24h:${assignmentId}`, reminderData, RATING_REMINDER_24H_TTL).catch(() => {});
        redisService.set(`rating:remind:72h:${assignmentId}`, reminderData, RATING_REMINDER_72H_TTL).catch(() => {});
      } catch (err: unknown) {
        logger.warn('[COMPLETION] Rating reminder Redis keys failed (non-fatal)', { assignmentId });
      }
    }

    // =========================================================================
    // (g) Cascade: checkBookingCompletion → checkOrderCompletion
    // =========================================================================
    try {
      const completedBookingId = assignment.bookingId;
      if (completedBookingId) {
        await trackingService.checkBookingCompletion(completedBookingId);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[COMPLETION] Booking completion cascade failed (non-fatal)', { ...logCtx, error: msg });
    }

    // =========================================================================
    // (h) Invalidate fleet cache — fixes M7
    // =========================================================================
    try {
      if (assignment.transporterId) {
        await invalidateVehicleCache(assignment.transporterId, assignment.vehicleId);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[COMPLETION] Fleet cache invalidation failed (non-fatal)', { ...logCtx, error: msg });
    }

    // =========================================================================
    // (i) Clear driver:active-assignment cache — fixes H16
    // =========================================================================
    try {
      if (assignment.driverId) {
        await redisService.del(`driver:active-assignment:${assignment.driverId}`);
      }
    } catch (err: unknown) {
      logger.warn('[COMPLETION] Driver active-assignment cache clear failed (non-fatal)', { assignmentId });
    }

    // =========================================================================
    // (j) WebSocket broadcast to all relevant rooms
    // =========================================================================
    try {
      const isPartial = terminalStatus === 'partial_delivery';
      const broadcastPayload = {
        assignmentId,
        tripId: assignment.tripId,
        status: terminalStatus,
        vehicleNumber: assignment.vehicleNumber,
        driverName: assignment.driverName,
        ...(isPartial && { partialReason }),
        completedAt,
        timestamp: completedAt
      };

      // Booking room
      if (assignment.bookingId) {
        emitToBooking(assignment.bookingId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, broadcastPayload);
      }

      // Transporter direct
      emitToUser(assignment.transporterId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
        ...broadcastPayload,
        message: isPartial
          ? `${assignment.driverName} partially delivered (${assignment.vehicleNumber}). Reason: ${partialReason || 'N/A'}`
          : `${assignment.driverName} completed the trip (${assignment.vehicleNumber})`
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[COMPLETION] WebSocket broadcast failed (non-fatal)', { ...logCtx, error: msg });
    }

    // =========================================================================
    // (k) FCM push to customer + transporter
    // =========================================================================
    try {
      const isPartial = terminalStatus === 'partial_delivery';
      const pushTitle = isPartial ? 'Partial Delivery' : 'Trip Completed';

      // Transporter FCM
      const transporterMsg = isPartial
        ? `${assignment.driverName} partially delivered (${assignment.vehicleNumber}). Reason: ${partialReason || 'N/A'}`
        : `${assignment.driverName} completed the trip (${assignment.vehicleNumber})`;

      queueService.queuePushNotification(assignment.transporterId, {
        title: pushTitle,
        body: transporterMsg,
        data: { type: 'assignment_update', assignmentId, tripId: assignment.tripId, status: terminalStatus }
      }).catch(err => {
        logger.warn('[COMPLETION] Transporter FCM failed', { assignmentId, error: String(err) });
      });

      // Customer FCM
      const customerId = await resolveCustomerId(assignment.bookingId, assignment.orderId);
      if (customerId) {
        const customerPushBody = isPartial
          ? `Your delivery was partially completed. Vehicle: ${assignment.vehicleNumber}`
          : `Your delivery has arrived! Vehicle: ${assignment.vehicleNumber}`;

        emitToUser(customerId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
          assignmentId,
          tripId: assignment.tripId,
          bookingId: assignment.bookingId,
          status: terminalStatus,
          vehicleNumber: assignment.vehicleNumber,
          ...(isPartial && { partialReason }),
          message: isPartial
            ? `Your delivery has been partially completed (${assignment.vehicleNumber})`
            : `Your delivery has been completed (${assignment.vehicleNumber})`
        });

        queueService.queuePushNotification(customerId, {
          title: pushTitle,
          body: customerPushBody,
          data: {
            type: 'assignment_update',
            assignmentId,
            tripId: assignment.tripId,
            bookingId: assignment.bookingId || '',
            status: terminalStatus
          }
        }).catch(err => {
          logger.warn('[COMPLETION] Customer FCM failed', { assignmentId, error: String(err) });
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[COMPLETION] FCM push failed (non-fatal)', { ...logCtx, error: msg });
    }

    logger.info('[COMPLETION] Trip completion orchestrator finished', {
      ...logCtx,
      tripId: assignment.tripId,
      vehicleNumber: assignment.vehicleNumber
    });

    return { success: true, assignmentId, alreadyCompleted: false };

  } finally {
    await redisService.releaseLock(lockKey, holderId).catch(() => {});
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Resolve the customer ID from either a booking or an order.
 * Returns empty string if not found. Non-throwing.
 */
async function resolveCustomerId(
  bookingId?: string | null,
  orderId?: string | null
): Promise<string> {
  try {
    if (bookingId) {
      const booking = await prismaClient.booking.findUnique({
        where: { id: bookingId },
        select: { customerId: true }
      });
      if (booking?.customerId) return booking.customerId;
    }
    if (orderId) {
      const order = await prismaClient.order.findUnique({
        where: { id: orderId },
        select: { customerId: true }
      });
      if (order?.customerId) return order.customerId;
    }
  } catch (err: unknown) {
    logger.warn('[COMPLETION] resolveCustomerId failed', {
      bookingId, orderId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return '';
}
