/**
 * =============================================================================
 * ASSIGNMENT MODULE - LIFECYCLE SERVICE
 * =============================================================================
 *
 * Status transitions, cancellation, decline, and timeout handling.
 * =============================================================================
 */

import { db, AssignmentRecord } from '../../shared/database/db';
import { prismaClient } from '../../shared/database/prisma.service';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, emitToBooking, SocketEvent } from '../../shared/services/socket.service';
import { queueService } from '../../shared/services/queue.service';
import { redisService } from '../../shared/services/redis.service';
import { onVehicleTransition } from '../../shared/services/vehicle-lifecycle.service';
import { UpdateStatusInput } from './assignment.schema';
import { ASSIGNMENT_CONFIG, AssignmentTimerData } from './assignment.types';
import { TERMINAL_ASSIGNMENT_STATUSES, ASSIGNMENT_VALID_TRANSITIONS } from '../../core/state-machines';

// =============================================================================
// LIFECYCLE SERVICE
// =============================================================================

class AssignmentLifecycleService {
  private async persistAssignmentReason(
    assignmentId: string,
    reason: string
  ): Promise<void> {
    await redisService.set(`assignment:reason:${assignmentId}`, reason, 86400)
      .catch(err => logger.warn('[assignmentReason] Redis write failed', err));
  }

  private resolveAssignmentStreamId(assignment: AssignmentRecord): string | undefined {
    return assignment.bookingId || assignment.orderId;
  }

  // NOTE: This legacy function should eventually be migrated to use the centralized
  // releaseVehicle() from vehicle-lifecycle.service.ts. However, it is currently
  // called outside of Prisma transactions where the post-TX Redis sync happens separately.
  // The Redis sync in releaseVehicleIfBusy already reads the ACTUAL vehicle status
  // (vehicle.status) rather than hardcoding, so it is correct as-is.
  private async releaseVehicleIfBusy(
    vehicleId: string | undefined,
    transporterId: string | undefined,
    contextLabel: string
  ): Promise<void> {
    if (!vehicleId) return;

    // #89: Fix TOCTOU race — read the vehicle status BEFORE the CAS update so we
    // know the old status for the Redis availability sync. The read and updateMany
    // are separate calls (Prisma doesn't support RETURNING), but updateMany's CAS
    // WHERE clause guarantees we only sync Redis when the update actually committed.
    const vehicle = await prismaClient.vehicle.findUnique({
      where: { id: vehicleId },
      select: { vehicleKey: true, transporterId: true, status: true }
    });

    // #89: Use updateMany's CAS result to determine if Redis sync is needed.
    // If count === 0 the vehicle was already 'available' — skip the Redis sync.
    const result = await prismaClient.vehicle.updateMany({
      where: { id: vehicleId, status: { not: 'available' } },
      data: {
        status: 'available',
        currentTripId: null,
        assignedDriverId: null,
        lastStatusChange: new Date().toISOString()
      }
    });

    if (result.count === 0) {
      logger.info(`[${contextLabel}] Vehicle ${vehicleId} already available, skipping release`);
      return;
    }

    // Only sync Redis + fleet cache when we KNOW the DB update committed (result.count > 0)
    if (vehicle?.vehicleKey && transporterId && vehicle.status !== 'available') {
      await onVehicleTransition(
        transporterId, vehicleId, vehicle.vehicleKey,
        vehicle.status, 'available', contextLabel
      );
    }
  }

  private async restoreOrderTruckRequest(
    assignment: Pick<AssignmentRecord, 'orderId' | 'truckRequestId'>
  ): Promise<void> {
    if (!assignment.orderId || !assignment.truckRequestId) return;

    await prismaClient.truckRequest.updateMany({
      where: { id: assignment.truckRequestId, orderId: assignment.orderId },
      data: {
        status: 'searching',
        assignedVehicleId: null,
        assignedVehicleNumber: null,
        assignedDriverId: null,
        assignedDriverName: null,
        assignedDriverPhone: null,
        tripId: null,
        assignedAt: null
      }
    });
  }

  // ==========================================================================
  // UPDATE STATUS
  // ==========================================================================

  // H13: Use canonical ASSIGNMENT_VALID_TRANSITIONS from src/core/state-machines.ts
  // (single source of truth — M-20 fix enforced, L-17 partial_delivery included)

  // ---------------------------------------------------------------------------
  // Status transition dispatch map — maps target status to its handler
  // ---------------------------------------------------------------------------
  private readonly transitionHandlers: Record<string, (
    assignmentId: string,
    assignment: AssignmentRecord,
    updates: Partial<AssignmentRecord>
  ) => Promise<void>> = {
    in_transit: async (_id, _assignment, updates) => {
      this.handleTransitionToInTransit(updates);
    },
    completed: async (assignmentId, assignment, updates) => {
      this.handleTransitionToCompleted(updates);
      await this.releaseVehicleOnCompletion(assignmentId, assignment);
    },
  };

  async updateStatus(
    assignmentId: string,
    driverId: string,
    data: UpdateStatusInput
  ): Promise<AssignmentRecord> {
    // 1. Validate
    const assignment = await this.validateStatusTransition(assignmentId, driverId, data.status);

    // 2. Build updates and dispatch per-status handler
    const updates: Partial<AssignmentRecord> = { status: data.status as AssignmentRecord['status'] };
    const handler = this.transitionHandlers[data.status];
    if (handler) {
      await handler(assignmentId, assignment, updates);
    }

    // 3. Persist
    const updated = await db.updateAssignment(assignmentId, updates);

    // 4. Notify
    await this.emitStatusChangeNotifications(assignmentId, assignment, data.status);
    if (data.status === 'completed') {
      await this.notifyCompletionParties(assignmentId, assignment);
    }

    logger.info(`Assignment status updated: ${assignmentId} -> ${data.status}`);
    return updated!;
  }

  // ---------------------------------------------------------------------------
  // Extracted: validate assignment exists, driver owns it, transition is valid
  // ---------------------------------------------------------------------------
  private async validateStatusTransition(
    assignmentId: string,
    driverId: string,
    targetStatus: string
  ): Promise<AssignmentRecord> {
    const assignment = await db.getAssignmentById(assignmentId);

    if (!assignment) {
      throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found');
    }

    if (assignment.driverId !== driverId) {
      throw new AppError(403, 'FORBIDDEN', 'This assignment is not for you');
    }

    const allowedNext = ASSIGNMENT_VALID_TRANSITIONS[assignment.status] ?? [];
    if (!allowedNext.includes(targetStatus)) {
      throw new AppError(400, 'INVALID_TRANSITION',
        `Cannot transition assignment from '${assignment.status}' to '${targetStatus}'`);
    }

    return assignment;
  }

  // ---------------------------------------------------------------------------
  // Per-status handlers (pure data mutations, no DB writes)
  // ---------------------------------------------------------------------------
  private handleTransitionToInTransit(updates: Partial<AssignmentRecord>): void {
    updates.startedAt = new Date().toISOString();
  }

  private handleTransitionToCompleted(updates: Partial<AssignmentRecord>): void {
    updates.completedAt = new Date().toISOString();
  }

  // ---------------------------------------------------------------------------
  // Release vehicle back to available on trip completion
  // ---------------------------------------------------------------------------
  // BEFORE: Only set completedAt — vehicle stayed in_transit forever
  //   until the 48-hour reconciliation sweep caught it.
  // NOW: Release vehicle immediately so it's available for new trips.
  // Same releaseVehicleIfBusy() used by cancel/decline/timeout.
  // ---------------------------------------------------------------------------
  private async releaseVehicleOnCompletion(
    assignmentId: string,
    assignment: AssignmentRecord
  ): Promise<void> {
    if (!assignment.vehicleId) return;
    try {
      // Lazy require to avoid circular imports
      const { releaseVehicle } = require('../../shared/services/vehicle-lifecycle.service');
      await releaseVehicle(assignment.vehicleId, 'tripCompleted');
      logger.info(`[ASSIGNMENT] Vehicle released on trip completion: ${assignment.vehicleNumber}`);
    } catch (err: unknown) {
      logger.error('[ASSIGNMENT] Failed to release vehicle on trip completion', {
        vehicleId: assignment.vehicleId,
        assignmentId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Emit status change to the booking/order room (common to all transitions)
  // ---------------------------------------------------------------------------
  private async emitStatusChangeNotifications(
    assignmentId: string,
    assignment: AssignmentRecord,
    newStatus: string
  ): Promise<void> {
    const payload = {
      assignmentId,
      tripId: assignment.tripId,
      status: newStatus,
      vehicleNumber: assignment.vehicleNumber
    };
    const updateStreamId = this.resolveAssignmentStreamId(assignment);
    if (updateStreamId) {
      // Issue #20: Canonical event
      emitToBooking(updateStreamId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, payload);
      // Issue #20: Backward-compat alias (remove after next app release)
      emitToBooking(updateStreamId, SocketEvent.TRIP_ASSIGNED, payload);
    }
  }

  // ---------------------------------------------------------------------------
  // Direct notifications on trip completion (WebSocket + FCM)
  // ---------------------------------------------------------------------------
  // BEFORE: Only emitted to booking room. Transporter/customer may not
  //   be in that room -> they never learn the trip finished.
  // NOW: Direct WebSocket + FCM push (same pattern as cancel/decline).
  // ---------------------------------------------------------------------------
  private async notifyCompletionParties(
    assignmentId: string,
    assignment: AssignmentRecord
  ): Promise<void> {
    // Notify transporter directly
    emitToUser(assignment.transporterId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
      assignmentId,
      tripId: assignment.tripId,
      status: 'completed',
      vehicleNumber: assignment.vehicleNumber,
      driverName: assignment.driverName,
      message: `${assignment.driverName} completed the trip (${assignment.vehicleNumber})`
    });

    queueService.queuePushNotification(assignment.transporterId, {
      title: '✅ Trip Completed',
      body: `${assignment.driverName} completed the trip (${assignment.vehicleNumber})`,
      data: {
        type: 'assignment_update',
        assignmentId,
        tripId: assignment.tripId,
        status: 'completed'
      }
    }).catch(err => {
      logger.warn(`FCM: Failed to notify transporter of completion`, err);
    });

    // Notify customer if booking exists
    const booking = assignment.bookingId
      ? await db.getBookingById(assignment.bookingId)
      : undefined;
    if (booking?.customerId) {
      emitToUser(booking.customerId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
        assignmentId,
        tripId: assignment.tripId,
        bookingId: assignment.bookingId,
        status: 'completed',
        vehicleNumber: assignment.vehicleNumber,
        message: `Your delivery has been completed (${assignment.vehicleNumber})`
      });

      queueService.queuePushNotification(booking.customerId, {
        title: '📦 Delivery Completed',
        body: `Your delivery has arrived! Vehicle: ${assignment.vehicleNumber}`,
        data: {
          type: 'assignment_update',
          assignmentId,
          tripId: assignment.tripId,
          bookingId: assignment.bookingId,
          status: 'completed'
        }
      }).catch(err => {
        logger.warn(`FCM: Failed to notify customer of completion`, err);
      });
    }
  }

  // ==========================================================================
  // CANCEL ASSIGNMENT
  // ==========================================================================

  async cancelAssignment(
    assignmentId: string,
    userId: string
  ): Promise<void> {
    const assignment = await db.getAssignmentById(assignmentId);

    if (!assignment) {
      throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found');
    }

    // Only transporter or driver can cancel
    if (assignment.transporterId !== userId && assignment.driverId !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied');
    }

    // F-H11 FIX: Terminal state guard — prevent cancelling already-completed/cancelled assignments
    const TERMINAL_SET = new Set<string>(TERMINAL_ASSIGNMENT_STATUSES);
    if (TERMINAL_SET.has(assignment.status)) {
      throw new AppError(409, 'ASSIGNMENT_ALREADY_TERMINAL', `Assignment is already ${assignment.status}`);
    }

    // Queue job is idempotent: if assignment is cancelled, handleAssignmentTimeout() no-ops.

    // M-15 FIX: Read vehicle status BEFORE transaction for correct oldStatus in Redis sync
    let preTransactionVehicle: { vehicleKey: string; transporterId: string; status: string } | null = null;
    if (assignment.vehicleId) {
      const v = await prismaClient.vehicle.findUnique({
        where: { id: assignment.vehicleId },
        select: { vehicleKey: true, transporterId: true, status: true }
      });
      if (v) preTransactionVehicle = { vehicleKey: v.vehicleKey ?? '', transporterId: v.transporterId, status: String(v.status) };
    }

    // =====================================================================
    // FIX M-2: Atomic transaction — cancel assignment + release vehicle
    // BEFORE: Two separate DB writes; vehicle release could fail after
    //   assignment already cancelled → vehicle stuck in non-available state.
    // NOW: Single Prisma transaction — both succeed or both roll back.
    // =====================================================================
    await prismaClient.$transaction(async (tx) => {
      // F-H11 FIX: CAS — only cancel if not already terminal
      const cancelResult = await tx.assignment.updateMany({
        where: {
          id: assignmentId,
          status: { notIn: [...TERMINAL_ASSIGNMENT_STATUSES] as any }
        },
        data: { status: 'cancelled' }
      });
      if (cancelResult.count === 0) {
        logger.info('[ASSIGNMENT] Cancel skipped — already terminal (CAS)', { assignmentId });
        return; // Idempotent — assignment was already terminal
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

    // Post-transaction: Redis + fleet cache sync (non-transactional, fail-safe)
    // M-15 FIX: Use pre-transaction vehicle status (not post-TX which is always 'available')
    if (preTransactionVehicle?.vehicleKey && assignment.transporterId && preTransactionVehicle.status !== 'available') {
      onVehicleTransition(
        assignment.transporterId, assignment.vehicleId, preTransactionVehicle.vehicleKey,
        preTransactionVehicle.status, 'available', 'cancelAssignment'
      ).catch(err => logger.warn('[cancelAssignment] Vehicle transition failed', err));
    }

    // Problem 16 fix: Cancel Redis-backed assignment timeout (assignment cancelled)
    queueService.cancelAssignmentTimeout(assignmentId).catch((cancelErr: unknown) => {
      logger.warn(`[cancelAssignment] Failed to cancel timeout timer: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`);
    });

    // Invalidate negative cache on cancel
    await redisService.del(`driver:active-assignment:${assignment.driverId}`).catch(() => {});

    // Decrement trucks filled (Fix H-A1: lazy require to break circular dep)
    // DB migration needed: ALTER TABLE "Order" ADD CONSTRAINT chk_order_trucks_filled_nonneg CHECK ("trucksFilled" >= 0);
    if (assignment.bookingId) {
      const { bookingService }: typeof import('../booking/booking.service') = require('../booking/booking.service');
      await bookingService.decrementTrucksFilled(assignment.bookingId);
    } else if (assignment.orderId) {
      // Floor guard: GREATEST(0, ...) prevents negative trucksFilled on concurrent cancels
      // Order status guard: skip decrement on already-cancelled/completed orders
      await prismaClient.$executeRaw`
        UPDATE "Order"
        SET "trucksFilled" = GREATEST(0, "trucksFilled" - 1),
            "updatedAt" = NOW()
        WHERE "id" = ${assignment.orderId}
          AND "status" NOT IN ('cancelled', 'completed')
      `;
      await this.restoreOrderTruckRequest(assignment);
    }

    // Notify booking room
    const cancelStreamId = this.resolveAssignmentStreamId(assignment);
    if (cancelStreamId) {
      emitToBooking(cancelStreamId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
        assignmentId,
        tripId: assignment.tripId,
        status: 'cancelled',
        vehicleNumber: assignment.vehicleNumber
      });
    }

    // =====================================================================
    // FIX: Notify driver directly on cancellation
    // =====================================================================
    // BEFORE: Only emitted to booking room. Driver may not be in that room
    //   → driver keeps driving to a cancelled order, never gets the message.
    // NOW: Direct WebSocket to driver + FCM push for background coverage.
    // Uber/Grab/Gojek pattern: direct push notification to driver on cancel.
    // =====================================================================
    if (assignment.driverId) {
      // WebSocket — direct to driver
      emitToUser(assignment.driverId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
        assignmentId,
        tripId: assignment.tripId,
        status: 'cancelled',
        vehicleNumber: assignment.vehicleNumber,
        message: 'This trip has been cancelled. Please return to dashboard.'
      });

      // FCM push — covers backgrounded/closed app
      queueService.queuePushNotification(assignment.driverId, {
        title: '🚫 Trip Cancelled',
        body: `Trip ${assignment.vehicleNumber} has been cancelled. Please return to dashboard.`,
        data: {
          type: 'assignment_update',
          assignmentId,
          tripId: assignment.tripId,
          status: 'cancelled'
        }
      }).catch(err => {
        logger.warn(`FCM: Failed to notify driver of cancellation`, err);
      });
    }

    logger.info(`Assignment cancelled: ${assignmentId}`);
  }

  // ==========================================================================
  // DECLINE ASSIGNMENT (Driver explicitly declines)
  // ==========================================================================
  //
  // DIFFERENT FROM cancelAssignment():
  // - Sets status to 'driver_declined' (not 'cancelled')
  // - Notifies transporter with actionable "Reassign?" message
  // - FCM push to transporter for background notification
  // - Releases vehicle for reassignment
  //
  // SCALABILITY: Notifications queued via queueService for reliability
  // EASY UNDERSTANDING: Driver says "no" → transporter gets notified → can reassign
  // MODULARITY: Separate from cancel — cancel is for transporter-initiated removal
  // ==========================================================================

  async declineAssignment(
    assignmentId: string,
    driverId: string
  ): Promise<void> {
    const assignment = await db.getAssignmentById(assignmentId);

    if (!assignment) {
      throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found');
    }

    if (assignment.driverId !== driverId) {
      throw new AppError(403, 'FORBIDDEN', 'This assignment is not for you');
    }

    if (assignment.status !== 'pending') {
      throw new AppError(400, 'INVALID_STATUS', 'Assignment cannot be declined');
    }

    // Problem 16 fix: Cancel Redis-backed assignment timeout (driver declined)
    queueService.cancelAssignmentTimeout(assignmentId).catch((cancelErr: unknown) => {
      logger.warn(`[declineAssignment] Failed to cancel timeout timer: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`);
    });

    // M-15 FIX: Read vehicle status BEFORE transaction for correct oldStatus in Redis sync
    let preDeclineVehicle: { vehicleKey: string; transporterId: string; status: string } | null = null;
    if (assignment.vehicleId) {
      const v = await prismaClient.vehicle.findUnique({
        where: { id: assignment.vehicleId },
        select: { vehicleKey: true, transporterId: true, status: true }
      });
      if (v) preDeclineVehicle = { vehicleKey: v.vehicleKey ?? '', transporterId: v.transporterId, status: String(v.status) };
    }

    // =====================================================================
    // FIX M-2: Atomic transaction — decline assignment + release vehicle
    // BEFORE: Two separate DB writes; vehicle release could fail after
    //   assignment already declined → vehicle stuck in non-available state.
    // NOW: Single Prisma transaction — both succeed or both roll back.
    // =====================================================================
    await prismaClient.$transaction(async (tx) => {
      await tx.assignment.update({
        where: { id: assignmentId },
        data: { status: 'driver_declined' }
      });
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
    await this.persistAssignmentReason(assignmentId, 'declined');

    // Post-transaction: Redis + fleet cache sync (non-transactional, fail-safe)
    // M-15 FIX: Use pre-transaction vehicle status (not post-TX which is always 'available')
    if (preDeclineVehicle?.vehicleKey && assignment.transporterId && preDeclineVehicle.status !== 'available') {
      onVehicleTransition(
        assignment.transporterId, assignment.vehicleId, preDeclineVehicle.vehicleKey,
        preDeclineVehicle.status, 'available', 'declineAssignment'
      ).catch(err => logger.warn('[declineAssignment] Vehicle transition failed', err));
    }

    // Invalidate negative cache on decline
    await redisService.del(`driver:active-assignment:${driverId}`).catch(() => {});

    // 3. Decrement trucks filled (Fix H-A1: lazy require to break circular dep)
    // DB migration needed: ALTER TABLE "Order" ADD CONSTRAINT chk_order_trucks_filled_nonneg CHECK ("trucksFilled" >= 0);
    if (assignment.bookingId) {
      const { bookingService }: typeof import('../booking/booking.service') = require('../booking/booking.service');
      await bookingService.decrementTrucksFilled(assignment.bookingId);
    } else if (assignment.orderId) {
      // Floor guard: GREATEST(0, ...) prevents negative trucksFilled on concurrent declines
      // Order status guard: skip decrement on already-cancelled/completed orders
      await prismaClient.$executeRaw`
        UPDATE "Order"
        SET "trucksFilled" = GREATEST(0, "trucksFilled" - 1),
            "updatedAt" = NOW()
        WHERE "id" = ${assignment.orderId}
          AND "status" NOT IN ('cancelled', 'completed')
      `;
      await this.restoreOrderTruckRequest(assignment);
    }

    // 5. Notify transporter via WebSocket: driver declined
    emitToUser(assignment.transporterId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
      assignmentId,
      tripId: assignment.tripId,
      status: 'driver_declined',
      driverId: assignment.driverId,
      driverName: assignment.driverName,
      vehicleNumber: assignment.vehicleNumber,
      vehicleId: assignment.vehicleId,
      message: `${assignment.driverName} declined the trip. Please reassign.`
    });

    // 6. Notify booking room
    const declineStreamId = this.resolveAssignmentStreamId(assignment);
    if (declineStreamId) {
      emitToBooking(declineStreamId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
        assignmentId,
        tripId: assignment.tripId,
        status: 'driver_declined',
        vehicleNumber: assignment.vehicleNumber
      });
    }

    // 7. FCM push to transporter (for background notification)
    queueService.queuePushNotification(assignment.transporterId, {
      title: '❌ Driver Declined Trip',
      body: `${assignment.driverName} declined the trip (${assignment.vehicleNumber}). Reassign?`,
      data: {
        type: 'assignment_update',
        assignmentId,
        tripId: assignment.tripId,
        vehicleId: assignment.vehicleId,
        status: 'driver_declined'
      }
    }).catch(err => {
      logger.warn(`FCM: Failed to notify transporter of decline`, err);
    });

    logger.info(`Assignment declined: ${assignmentId} by driver ${driverId}`);
  }

  // ==========================================================================
  // HANDLE ASSIGNMENT TIMEOUT (Driver didn't respond in time)
  // ==========================================================================
  //
  // Called by setTimeout in queue.service.ts when the self-destruct timer fires.
  // Safe to call even if driver already accepted/declined — updateMany no-ops.
  //
  // SCALABILITY: In-process timer — zero Redis hops, guaranteed to fire
  // EASY UNDERSTANDING: No response in ASSIGNMENT_TIMEOUT_MS → same as decline + timeout reason
  // MODULARITY: Uses same vehicle release + notification pattern as decline
  // ==========================================================================

  async handleAssignmentTimeout(timerData: AssignmentTimerData): Promise<void> {
    const { assignmentId, driverId, driverName, transporterId, vehicleId, vehicleNumber, bookingId, tripId, orderId, truckRequestId } = timerData;

    logger.info(`⏰ TIMEOUT: Assignment ${assignmentId} — driver ${driverName} didn't respond`);

    // 1. Atomic status update with precondition — prevents race with concurrent accept/decline
    // If driver accepted concurrently, this no-ops (count === 0) and we skip gracefully
    // Issue #21: DB uses 'driver_declined' (Prisma enum constraint), but all notifications
    // consistently use 'expired' status. reason='timeout' distinguishes from explicit decline.
    const updated = await prismaClient.assignment.updateMany({
      where: { id: assignmentId, status: 'pending' },
      data: { status: 'driver_declined' }
    });

    if (updated.count === 0) {
      // Driver already accepted/declined before timeout fired — skip
      const assignment = await db.getAssignmentById(assignmentId);
      logger.info(`Assignment ${assignmentId} already ${assignment?.status ?? 'gone'}, timeout no-op`);
      return;
    }
    await this.persistAssignmentReason(assignmentId, 'timeout');

    // Fetch assignment for notification data
    const assignment = await db.getAssignmentById(assignmentId);
    if (!assignment) {
      logger.warn(`Assignment ${assignmentId} not found after timeout update`);
      return;
    }

    // 2. Release vehicle back to available
    await this.releaseVehicleIfBusy(vehicleId, transporterId, 'timeout');

    // 3. Decrement trucks filled (Fix H-A1: lazy require to break circular dep)
    // For multi-truck system: use orderId instead of bookingId
    if (bookingId) {
      const { bookingService }: typeof import('../booking/booking.service') = require('../booking/booking.service');
      await bookingService.decrementTrucksFilled(bookingId);
    } else if (orderId) {
      // Multi-truck system: decrement trucksFilled on Order
      // Floor guard: GREATEST(0, ...) prevents negative trucksFilled on concurrent timeouts
      // Order status guard: skip decrement on already-cancelled/completed orders
      // DB migration needed: ALTER TABLE "Order" ADD CONSTRAINT chk_order_trucks_filled_nonneg CHECK ("trucksFilled" >= 0);
      await prismaClient.$executeRaw`
        UPDATE "Order"
        SET "trucksFilled" = GREATEST(0, "trucksFilled" - 1),
            "updatedAt" = NOW()
        WHERE "id" = ${orderId}
          AND "status" NOT IN ('cancelled', 'completed')
      `;
      // Also update TruckRequest status back to held
      await this.restoreOrderTruckRequest({ orderId, truckRequestId });
    }

    // 4. Notify transporter: driver timed out (WebSocket)
    // Issue #22: Use ASSIGNMENT_TIMEOUT (not DRIVER_TIMEOUT which is overloaded with presence)
    emitToUser(transporterId, SocketEvent.ASSIGNMENT_TIMEOUT, {
      assignmentId,
      tripId,
      driverId,
      driverName,
      vehicleNumber,
      vehicleId,
      status: 'expired',
      reason: 'timeout',
      message: `${driverName} didn't respond in ${ASSIGNMENT_CONFIG.TIMEOUT_MS / 1000} seconds`
    });
    // Issue #20: Backward-compat alias (remove after next app release)
    emitToUser(transporterId, SocketEvent.DRIVER_TIMEOUT, {
      assignmentId,
      tripId,
      driverId,
      driverName,
      vehicleNumber,
      vehicleId,
      status: 'expired',
      reason: 'timeout',
      message: `${driverName} didn't respond in ${ASSIGNMENT_CONFIG.TIMEOUT_MS / 1000} seconds`
    });

    // 5. Notify driver: assignment expired (WebSocket)
    // Issue #21: Use 'expired' to match the DB status consistently
    emitToUser(driverId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
      assignmentId,
      tripId,
      status: 'expired',
      reason: 'timeout',
      message: 'Trip assignment expired — you didn\'t respond in time'
    });

    // 6. Notify booking room
    // Issue #21: Standardize to 'expired' status
    const timeoutStreamId = bookingId || orderId;
    if (timeoutStreamId) {
      emitToBooking(timeoutStreamId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
        assignmentId,
        tripId,
        status: 'expired',
        vehicleNumber,
        reason: 'timeout'
      });
    }

    // 7. FCM push to transporter (background notification)
    // Issue #21: Standardize FCM status to 'expired' (was 'timed_out')
    queueService.queuePushNotification(transporterId, {
      title: '⏰ Driver Didn\'t Respond',
      body: `${driverName} didn't respond in time (${vehicleNumber}). Reassign?`,
      data: {
        type: 'assignment_timeout',
        assignmentId,
        tripId,
        vehicleId,
        driverName,
        status: 'expired'
      }
    }).catch(err => {
      logger.warn(`FCM: Failed to notify transporter of timeout`, err);
    });

    // 8. FCM push to driver (let them know they missed it)
    // Issue #23: Corrected misleading "reassigned" text — no auto-reassignment exists
    queueService.queuePushNotification(driverId, {
      title: '⏰ Trip Assignment Expired',
      body: 'Assignment has expired. The vehicle is now available for other bookings.',
      data: {
        type: 'assignment_update',
        assignmentId,
        tripId,
        status: 'expired'
      }
    }).catch(err => {
      logger.warn(`FCM: Failed to notify driver of timeout`, err);
    });

    logger.info(`Assignment timed out: ${assignmentId} — vehicle ${vehicleNumber} released`);
  }
}

export const assignmentLifecycleService = new AssignmentLifecycleService();
