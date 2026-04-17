/**
 * =============================================================================
 * BOOKING MODULE - LIFECYCLE SERVICE
 * =============================================================================
 *
 * Handles:
 * - handleBookingTimeout (expiry logic)
 * - cancelBooking
 * - incrementTrucksFilled
 * - decrementTrucksFilled
 * - cancelBookingTimeout
 * - clearBookingTimers
 * - clearCustomerActiveBroadcast
 * =============================================================================
 */

import { db, BookingRecord } from '../../shared/database/db';
import { prismaClient, BookingStatus, AssignmentStatus } from '../../shared/database/prisma.service';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, emitToBooking, SocketEvent } from '../../shared/services/socket.service';
import { queueService } from '../../shared/services/queue.service';
import { redisService } from '../../shared/services/redis.service';
import { releaseVehicle } from '../../shared/services/vehicle-lifecycle.service';
import { assertValidTransition, BOOKING_VALID_TRANSITIONS } from '../../core/state-machines';
import { TIMER_KEYS, RADIUS_KEYS, TERMINAL_STATUSES } from './booking.types';

// FIX #45: Parse once at module level
const BOOKING_MAX_AGE_HOURS = parseInt(process.env.BOOKING_MAX_AGE_HOURS || '24', 10);

// Forward reference for startBookingTimeout (set by facade)
let _createService: {
  startBookingTimeout: (bookingId: string, customerId: string) => Promise<void>;
} | null = null;

export function setCreateServiceRef(ref: typeof _createService): void {
  _createService = ref;
}

export class BookingLifecycleService {

  /**
   * FIX #16: Resume interrupted broadcasts on server restart.
   * Finds bookings stuck in 'broadcasting' status for >30s (stale) and re-queues them.
   * Called once at server startup to recover from crash/restart mid-broadcast.
   *
   * Industry standard (Uber): On restart, scan for in-flight dispatches and re-queue.
   */
  async resumeInterruptedBroadcasts(): Promise<void> {
    // #84: Acquire a distributed lock so only one ECS instance runs the resume scan.
    // Without this lock, all instances restarting together would fan out duplicate resume jobs.
    const lockKey = 'lock:resume:interrupted:broadcasts';
    const lockHolder = `resume:${process.pid}:${Date.now()}`;
    const lockResult = await redisService.acquireLock(lockKey, lockHolder, 60).catch(() => ({ acquired: false }));
    if (!lockResult.acquired) {
      logger.info('[STARTUP] Resume skipped — another instance holds the resume lock');
      return;
    }

    const STALE_THRESHOLD_MS = 30_000; // 30 seconds
    try {
      const staleBroadcasts = await prismaClient.booking.findMany({
        where: {
          status: 'broadcasting' as any,
          updatedAt: { lt: new Date(Date.now() - STALE_THRESHOLD_MS) }
        },
        select: { id: true, customerId: true, expiresAt: true },
        take: 100,  // FIX-27: Bound query to prevent unbounded result sets
      });

      if (staleBroadcasts.length === 0) {
        logger.info('[STARTUP] No interrupted broadcasts to resume');
        return;
      }

      // #85: Skip bookings whose broadcast window has already expired OR has null expiresAt.
      // Re-queuing an expired broadcast would immediately trigger a timeout handler.
      // Bookings with null expiresAt are invalid — they should not be resumed.
      const now = new Date();
      const resumable = staleBroadcasts.filter(b => {
        if (!(b as any).expiresAt) {
          logger.warn('[STARTUP] Skipping broadcast with null expiresAt', { bookingId: b.id });
          return false;
        }
        return new Date((b as any).expiresAt) > now;
      });

      if (resumable.length === 0) {
        logger.info('[STARTUP] All stale broadcasts are expired — nothing to resume', {
          staleCount: staleBroadcasts.length,
        });
        return;
      }

      logger.info('[STARTUP] Found interrupted broadcasts to resume', {
        staleCount: staleBroadcasts.length,
        resumableCount: resumable.length,
      });

      for (const booking of resumable) {
        try {
          await queueService.enqueue('booking:resume-broadcast', {
            bookingId: booking.id,
            customerId: booking.customerId,
          });
          logger.info('[STARTUP] Re-queued interrupted broadcast', { bookingId: booking.id });
        } catch (err: unknown) {
          logger.error('[STARTUP] Failed to resume broadcast', {
            bookingId: booking.id,
            error: (err as Error)?.message,
          });
        }
      }
    } catch (err: unknown) {
      logger.error('[STARTUP] resumeInterruptedBroadcasts scan failed', {
        error: (err as Error)?.message,
      });
    } finally {
      await redisService.releaseLock(lockKey, lockHolder).catch(() => {});
    }
  }

  /**
   * Handle booking timeout - called when timer expires
   * Made public for the expiry checker to call
   */
  async handleBookingTimeout(bookingId: string, customerId: string): Promise<void> {
    const booking = await db.getBookingById(bookingId);

    if (!booking) {
      logger.warn(`Booking ${bookingId} not found for timeout handling`);
      return;
    }

    // #18 -- Explicit status assertions: skip terminal states
    if (['fully_filled', 'completed', 'cancelled'].includes(booking.status)) {
      logger.info(`Booking ${bookingId} already ${booking.status}, skipping timeout`);
      this.clearBookingTimers(bookingId);
      return;
    }

    // #18 -- Log and skip unexpected states (safety guard)
    const EXPECTED_TIMEOUT_STATES = ['broadcasting', 'active', 'partially_filled', 'created'];
    if (!EXPECTED_TIMEOUT_STATES.includes(booking.status)) {
      logger.warn('[BOOKING] Timeout for booking in unexpected status', { bookingId, status: booking.status });
      return;
    }

    logger.info(`⏰ TIMEOUT: Booking ${bookingId} expired`);

    // State machine validation for timeout -> expired transition (warn-only)
    try {
      assertValidTransition('Booking', BOOKING_VALID_TRANSITIONS, booking.status, 'expired');
    } catch (e) {
      logger.warn('[BOOKING] Invalid state transition attempted', {
        bookingId, from: booking.status, to: 'expired', error: (e as Error).message
      });
    }

    // Check if partially filled
    if (booking.trucksFilled > 0 && booking.trucksFilled < booking.trucksNeeded) {
      // Partially filled - notify customer
      // FIX-R2-2: Conditional status write — only expire from active-like states
      try {
        await prismaClient.booking.updateMany({
          where: { id: bookingId, status: { in: ['broadcasting', 'active', 'partially_filled', 'created'] } },
          data: { status: 'expired', stateChangedAt: new Date() }
        });
      } catch (err: unknown) {
        logger.error('[BOOKING] Failed to expire partially filled booking', { bookingId, error: (err as Error).message });
      }

      emitToUser(customerId, SocketEvent.BOOKING_EXPIRED, {
        bookingId,
        status: 'partially_filled_expired',
        trucksNeeded: booking.trucksNeeded,
        trucksFilled: booking.trucksFilled,
        message: `Only ${booking.trucksFilled} of ${booking.trucksNeeded} trucks were assigned. Would you like to continue with partial fulfillment or search again?`,
        options: ['continue_partial', 'search_again', 'cancel']
      });
      // Also emit order_expired for customer app compatibility (customer listens for order_expired)
      emitToUser(customerId, 'order_expired', {
        bookingId,
        status: 'partially_filled_expired',
        trucksNeeded: booking.trucksNeeded,
        trucksFilled: booking.trucksFilled,
        message: `Only ${booking.trucksFilled} of ${booking.trucksNeeded} trucks were assigned. Would you like to continue with partial fulfillment or search again?`,
        options: ['continue_partial', 'search_again', 'cancel'],
        _compat: 'booking_expired',
      });

      // Also notify via booking room
      emitToBooking(bookingId, SocketEvent.BOOKING_EXPIRED, {
        bookingId,
        status: 'partially_filled_expired',
        trucksFilled: booking.trucksFilled
      });

    } else if (booking.trucksFilled === 0) {
      // No trucks filled - "No vehicle available"
      // FIX-R2-2: Conditional status write — only expire from active-like states
      try {
        await prismaClient.booking.updateMany({
          where: { id: bookingId, status: { in: ['broadcasting', 'active', 'partially_filled', 'created'] } },
          data: { status: 'expired', stateChangedAt: new Date() }
        });
      } catch (err: unknown) {
        logger.error('[BOOKING] Failed to expire unfilled booking', { bookingId, error: (err as Error).message });
      }

      emitToUser(customerId, SocketEvent.NO_VEHICLES_AVAILABLE, {
        bookingId,
        vehicleType: booking.vehicleType,
        vehicleSubtype: booking.vehicleSubtype,
        message: `No ${booking.vehicleType} available right now. We'll help you find alternatives.`,
        suggestion: 'search_again',
        options: ['search_again', 'try_different_vehicle', 'cancel']
      });

      emitToBooking(bookingId, SocketEvent.BOOKING_EXPIRED, {
        bookingId,
        status: 'expired',
        trucksFilled: 0
      });
    }

    // Clear timers
    this.clearBookingTimers(bookingId);

    // Clear customer active broadcast key (one-per-customer enforcement)
    await this.clearCustomerActiveBroadcast(customerId);

    // Notify all transporters that this broadcast is no longer available
    // WebSocket (for apps in foreground)
    for (const transporterId of booking.notifiedTransporters) {
      emitToUser(transporterId, SocketEvent.BOOKING_EXPIRED, {
        bookingId,
        orderId: bookingId,
        broadcastId: bookingId,
        reason: 'timeout',
        message: 'This booking request has expired',
        customerName: booking.customerName
      });
    }

    // ========================================
    // FCM PUSH: Notify transporters of expiry (for apps in background)
    // ========================================
    // SCALABILITY: Queued via queueService — reliable with retry
    // EASY UNDERSTANDING: Transporters need to clear this booking from their UI
    // MODULARITY: Fire-and-forget, doesn't block timeout handling
    if (booking.notifiedTransporters.length > 0) {
      queueService.queuePushNotificationBatch(
        booking.notifiedTransporters,
        {
          title: '⏰ Booking Expired',
          body: `${booking.vehicleType} booking request has expired`,
          priority: 'high', // W0-1: top-level priority drives FCM android.priority; data.priority retained for Android-side client compat.
          data: {
            type: 'booking_expired',
            bookingId,
            vehicleType: booking.vehicleType,
            priority: 'high', // H-09 FIX: Time-sensitive expiry events must be high priority (consumed by FCM consumer)
          }
        }
      ).catch(err => {
        logger.warn(`FCM: Failed to queue expiry push for booking ${bookingId}`, err);
      });
    }
  }

  /**
   * Clear all timers for a booking (Redis-based)
   * Also cleans up progressive radius expansion keys
   */
  async clearCustomerActiveBroadcast(customerId: string): Promise<void> {
    const activeKey = `customer:active-broadcast:${customerId}`;
    const latestIdemKey = await redisService.get(`idem:broadcast:latest:${customerId}`).catch((): null => null);

    // Delete all keys in parallel (reduces 4 sequential Redis calls to 1 round-trip)
    const delPromises: Promise<unknown>[] = [
      redisService.del(activeKey).catch((err: unknown) => {
        logger.warn('Failed to clear customer active broadcast key', { customerId, error: (err as Error).message });
      }),
      redisService.del(`idem:broadcast:latest:${customerId}`).catch(() => { })
    ];
    if (latestIdemKey) {
      delPromises.push(redisService.del(latestIdemKey).catch(() => { }));
    }
    await Promise.all(delPromises);
  }

  async clearBookingTimers(bookingId: string): Promise<void> {
    await Promise.all([
      redisService.cancelTimer(TIMER_KEYS.BOOKING_EXPIRY(bookingId)),
      redisService.cancelTimer(TIMER_KEYS.RADIUS_STEP(bookingId)),
      redisService.del(RADIUS_KEYS.CURRENT_STEP(bookingId)).catch(() => { }),
      redisService.del(RADIUS_KEYS.NOTIFIED_SET(bookingId)).catch(() => { }),
    ]);
  }

  /**
   * Cancel booking timeout (called when fully filled)
   */
  async cancelBookingTimeout(bookingId: string): Promise<void> {
    await this.clearBookingTimers(bookingId);
    logger.info(`⏱️ Timeout cancelled for booking ${bookingId}`);
  }

  // ==========================================================================
  // UPDATE BOOKING
  // ==========================================================================

  /**
   * Cancel booking — atomic, idempotent, race-safe
   *
   * Uses updateMany with status precondition to prevent cancel-vs-accept races.
   * Already-cancelled bookings return success (idempotent).
   */
  async cancelBooking(bookingId: string, customerId: string): Promise<BookingRecord> {
    // Idempotent — safe to call even if timers don't exist yet.
    await this.clearBookingTimers(bookingId).catch(() => { });

    // Pre-flight: fetch booking for ownership check and idempotency
    const preflight = await db.getBookingById(bookingId);
    if (!preflight) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }
    if (preflight.customerId !== customerId) {
      throw new AppError(403, 'FORBIDDEN', 'You can only cancel your own bookings');
    }
    // IDEMPOTENT: already cancelled is success (not error)
    if (preflight.status === 'cancelled') {
      logger.info('Idempotent cancel: booking already cancelled', { bookingId });
      return preflight;
    }

    // =====================================================================
    // #27 — SPLIT CANCEL TRANSACTION (QA-4 pattern)
    // Booking cancel + assignment cancel = INSIDE $transaction (atomic)
    // Vehicle release + Redis cleanup + notifications = OUTSIDE (best-effort)
    // =====================================================================
    let cancelledAssignments: Array<{ id: string; vehicleId: string | null; transporterId: string; vehicleType: string | null; vehicleSubtype: string | null; driverId: string | null; tripId: string | null; status: string }> = [];

    // A5#2: Booking-level distributed lock to serialize cancel-vs-accept races.
    // CAS inside the transaction is the real safety net; lock reduces wasted work.
    // C-04 FIX: acquireLock() prepends `lock:` automatically, so pass `booking:${id}`
    const lockKey = 'booking:' + bookingId;
    let lock = { acquired: false };
    try {
      lock = await redisService.acquireLock(lockKey, `cancel:${customerId}`, 15);
    } catch (lockErr: unknown) {
      // Redis failure should not block cancels — CAS is the real guard
      logger.warn('[CANCEL] Lock acquisition failed, proceeding with CAS only', { error: (lockErr as Error)?.message });
    }
    try {

    const updated = await prismaClient.$transaction(async (tx) => {
      // 1. Cancel booking — only succeeds if status is still cancellable
      const result = await tx.booking.updateMany({
        where: {
          id: bookingId,
          customerId,
          status: { in: [BookingStatus.created, BookingStatus.broadcasting, BookingStatus.active, BookingStatus.partially_filled, BookingStatus.fully_filled] }
        },
        data: {
          status: BookingStatus.cancelled,
          stateChangedAt: new Date()
        }
      });

      if (result.count === 0) {
        // Re-check: if already cancelled, return 0 (handled below as idempotent)
        return result;
      }

      // 2. Find active assignments BEFORE cancelling (need vehicleId list)
      // Fix B3: Only cancel PRE-TRIP assignments. Mid-trip vehicles must NOT be released.
      // FIX #14: Protected status guard — do NOT release assignments where the driver
      // has already committed/traveled (Uber standard: once en-route, assignment is locked).
      // Only pending (unacknowledged) assignments are auto-released on booking cancel.
      const cancellableStatuses = [
        AssignmentStatus.pending,
      ];
      const activeAssignments = await tx.assignment.findMany({
        where: { bookingId, status: { in: cancellableStatuses } },
        select: { id: true, vehicleId: true, transporterId: true, vehicleType: true, vehicleSubtype: true, driverId: true, tripId: true, status: true }
      });

      // 3. Cancel all active assignments
      if (activeAssignments.length > 0) {
        await tx.assignment.updateMany({
          where: { bookingId, status: { in: cancellableStatuses } },
          data: { status: AssignmentStatus.cancelled }
        });
      }

      // Store for post-transaction cleanup
      cancelledAssignments = activeAssignments;
      return result;
    }, { timeout: 10000 });

    // Post-transaction: re-fetch for final state
    const booking = await db.getBookingById(bookingId);
    if (!booking) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }

    // IDEMPOTENT: race with another cancel — already cancelled is success
    if (updated.count === 0 && booking.status === 'cancelled') {
      logger.info('Idempotent cancel: booking already cancelled', { bookingId });
      return booking;
    }

    if (updated.count === 0) {
      throw new AppError(409, 'BOOKING_CANNOT_CANCEL', `Cannot cancel booking in ${booking.status} state`);
    }

    // === CANCEL WON: Best-effort cleanup (DB is already consistent) ===

    // 1. Timers already cleared above (before DB update) — skip duplicate call

    // 2. Clear customer active broadcast key + idempotency keys
    await this.clearCustomerActiveBroadcast(customerId).catch(e => logger.warn('Timer cleanup failed', e));

    // FIX #32: Set cancel-rebook cooldown (30s) to prevent rapid cancel+rebook abuse
    await redisService.set(`booking:cancel-cooldown:${customerId}`, '1', 30).catch(() => {});

    // 3. Clear notified transporter set
    await redisService.del(`broadcast:notified:${bookingId}`).catch(() => { });

    // 4. Clear legacy client idempotency cache
    try {
      const latestIdempotencyKey = `idempotency:booking:${customerId}:latest`;
      const storedKey = await redisService.get(latestIdempotencyKey) as string | null;
      if (storedKey) {
        await redisService.del(`idempotency:booking:${customerId}:${storedKey}`);
        await redisService.del(latestIdempotencyKey);
      }
    } catch (err: unknown) {
      logger.warn(`[CANCEL] Failed to clear legacy idempotency cache (non-critical)`, { error: (err as Error).message });
    }

    // #28 — Re-fetch notifiedTransporters AFTER cancel commit for fresh data
    const freshBooking = await db.getBookingById(bookingId);
    const notifiedTransporters = freshBooking?.notifiedTransporters || booking.notifiedTransporters || [];

    // 5. Notify all notified transporters (using fresh list)
    // FIX #88: Emit BOOKING_CANCELLED for cancellations, BOOKING_EXPIRED only for timeouts.
    // Also emit legacy BOOKING_EXPIRED with _deprecated flag for backward compatibility.
    if (notifiedTransporters.length > 0) {
      for (const transporterId of notifiedTransporters) {
        // New canonical event for cancellation
        emitToUser(transporterId, SocketEvent.BOOKING_CANCELLED, {
          bookingId,
          orderId: bookingId,
          broadcastId: bookingId,
          status: 'cancelled',
          reason: 'customer_cancelled',
          message: `Sorry, this order was cancelled by ${booking.customerName}`,
          customerName: booking.customerName
        });
        // Legacy backward-compatible event (deprecated — clients should migrate to BOOKING_CANCELLED)
        emitToUser(transporterId, SocketEvent.BOOKING_EXPIRED, {
          bookingId,
          orderId: bookingId,
          broadcastId: bookingId,
          status: 'cancelled',
          reason: 'customer_cancelled',
          message: `Sorry, this order was cancelled by ${booking.customerName}`,
          customerName: booking.customerName,
          _deprecated: true
        });
      }
      logger.info(`[CANCEL] Sent BOOKING_CANCELLED + legacy BOOKING_EXPIRED to ${notifiedTransporters.length} transporters`);

      // FCM push for background/closed apps
      queueService.queuePushNotificationBatch(
        notifiedTransporters,
        {
          title: '❌ Booking Cancelled',
          body: `${booking.customerName} cancelled ${booking.vehicleType} booking`,
          data: {
            type: 'booking_cancelled',
            bookingId,
            vehicleType: booking.vehicleType
          }
        }
      ).catch(err => {
        logger.warn(`FCM: Failed to queue cancellation push for booking ${bookingId}`, err);
      });
    }

    // 6. Emit to the booking room (for customer foreground)
    emitToBooking(bookingId, SocketEvent.BOOKING_UPDATED, {
      bookingId,
      status: 'cancelled'
    });

    // 7. Post-transaction: vehicle release + Redis cache sync + driver notifications
    // FIX #14: Only release vehicles for assignments that were actually cancelled (pending).
    // Protected assignments (driver_accepted, en_route_pickup, at_pickup, in_transit) are
    // NOT cancelled and NOT released — the driver has already traveled.
    for (const assignment of cancelledAssignments) {
      if (assignment.vehicleId) {
        // Vehicle release OUTSIDE transaction (best-effort, QA-4 pattern)
        await releaseVehicle(assignment.vehicleId, 'bookingCancellation').catch((err: unknown) => {
          logger.warn('[BOOKING_CANCEL] Vehicle release failed', { vehicleId: assignment.vehicleId, error: (err as Error).message });
        });
      }
      if (assignment.driverId) {
        emitToUser(assignment.driverId, SocketEvent.TRIP_CANCELLED, {
          assignmentId: assignment.id,
          bookingId,
          tripId: assignment.tripId,
          reason: 'booking_cancelled_by_customer',
          wasInProgress: false,
          previousStatus: assignment.status,
          message: 'Trip cancelled by customer'
        });

        // FCM push: driver gets notification even if app is backgrounded
        queueService.queuePushNotificationBatch(
          [assignment.driverId],
          {
            title: 'Trip Cancelled',
            body: `${booking.customerName} cancelled the booking`,
            data: {
              type: 'trip_cancelled',
              assignmentId: assignment.id,
              bookingId,
              tripId: assignment.tripId ?? '',
              reason: 'booking_cancelled_by_customer',
              wasInProgress: 'false'
            }
          }
        ).catch((fcmErr: unknown) => {
          logger.warn(`[CANCEL] FCM to driver ${assignment.driverId} failed`, { error: (fcmErr as Error).message });
        });
      }
    }

    // FIX #14: Also find protected (non-releasable) assignments and log them
    const protectedAssignments = await prismaClient.assignment.findMany({
      where: {
        bookingId,
        status: { in: ['at_pickup', 'en_route_pickup', 'in_transit', 'driver_accepted'] }
      },
      select: { id: true, driverId: true, status: true }
    });
    if (protectedAssignments.length > 0) {
      logger.info('[CANCEL] Protected assignments NOT released (driver already committed)', {
        bookingId,
        protectedCount: protectedAssignments.length,
        statuses: protectedAssignments.map(a => a.status),
      });
      // Notify protected drivers that the booking was cancelled but their assignment remains
      for (const pa of protectedAssignments) {
        if (pa.driverId) {
          emitToUser(pa.driverId, SocketEvent.BOOKING_UPDATED, {
            bookingId,
            status: 'cancelled',
            assignmentProtected: true,
            message: 'Booking cancelled by customer. Your assignment is protected — contact support for next steps.'
          });
        }
      }
    }

    if (cancelledAssignments.length > 0) {
      logger.info(`[CANCEL] Reverted ${cancelledAssignments.length} pending assignments, released vehicles`);
    }

    logger.info(`[CANCEL] Booking ${bookingId} cancelled, all broadcast state cleaned`);
    return freshBooking || booking;

    } finally {
      // A5#2: Release booking-level lock (safe even if not acquired)
      if (lock.acquired) {
        await redisService.releaseLock(lockKey, `cancel:${customerId}`).catch(() => { });
      }
    }
  }

  /**
   * Update trucks filled (called when assignment is created)
   * ENHANCED: Cancels timeout when fully filled, notifies all parties
   */
  async incrementTrucksFilled(bookingId: string): Promise<BookingRecord> {
    const booking = await db.getBookingById(bookingId);

    if (!booking) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }


    // Problem 10 fix: Idempotency guard - skip if already fully filled
    if (booking.trucksFilled >= booking.trucksNeeded || booking.status === 'fully_filled') {
      logger.warn(`[incrementTrucksFilled] Booking ${bookingId} already at capacity (${booking.trucksFilled}/${booking.trucksNeeded}), skipping`);
      return booking;
    }

    // =====================================================================
    // ATOMIC INCREMENT with idempotency WHERE clause (Problem 10 fix)
    // Added: AND "trucksFilled" < "trucksNeeded" to prevent over-counting
    // =====================================================================
    const atomicResult = await prismaClient.$queryRaw<Array<{ trucksFilled: number; trucksNeeded: number }>>`
      UPDATE "Booking"
      SET "trucksFilled" = "trucksFilled" + 1,
          "stateChangedAt" = NOW()
      WHERE id = ${bookingId}
        AND "trucksFilled" < "trucksNeeded"
      RETURNING "trucksFilled", "trucksNeeded"
    `;

    if (!atomicResult || atomicResult.length === 0) {
      // Problem 10: 0 rows = already at capacity, not an error
      logger.warn(`[incrementTrucksFilled] Atomic increment returned 0 rows for ${bookingId} - already at capacity`);
      const currentBooking = await db.getBookingById(bookingId);
      return currentBooking || booking;
    }

    const newFilled = atomicResult[0].trucksFilled;
    const newStatus = newFilled >= atomicResult[0].trucksNeeded ? 'fully_filled' : 'partially_filled';

    // FIX-R2-9: Conditional status write — block if booking already in terminal state
    let updated: BookingRecord | undefined;
    try {
      const statusResult = await prismaClient.booking.updateMany({
        where: {
          id: bookingId,
          status: { notIn: ['cancelled', 'expired', 'completed'] }
        },
        data: { status: newStatus, stateChangedAt: new Date() }
      });
      if (statusResult.count === 0) {
        logger.warn('[RACE] Status write blocked — booking already in terminal state', {
          bookingId, attemptedStatus: newStatus
        });
      }
      updated = await db.getBookingById(bookingId);
    } catch (err: unknown) {
      logger.error('[BOOKING] Failed to update status after increment', { bookingId, newStatus, error: (err as Error).message });
    }

    // M-19 FIX: Emit booking_updated only via emitToUser (customer's personal room).
    // Previously also emitted via emitToBooking (booking room), causing the customer
    // to receive the event twice since they are in both rooms. The personal room
    // emission is the canonical one because it carries the user-facing message.
    emitToUser(booking.customerId, SocketEvent.BOOKING_UPDATED, {
      bookingId,
      status: newStatus,
      trucksFilled: newFilled,
      trucksNeeded: booking.trucksNeeded,
      message: newStatus === 'fully_filled'
        ? `All ${booking.trucksNeeded} trucks assigned! Your booking is complete.`
        : `${newFilled}/${booking.trucksNeeded} trucks assigned. Searching for more...`
    });

    // If fully filled, cancel timeout, clear active key, and notify
    if (newStatus === 'fully_filled') {
      await this.cancelBookingTimeout(bookingId);
      await this.clearCustomerActiveBroadcast(booking.customerId);

      // Send fully filled event to customer
      emitToUser(booking.customerId, SocketEvent.BOOKING_FULLY_FILLED, {
        bookingId,
        trucksNeeded: booking.trucksNeeded,
        trucksFilled: newFilled,
        message: 'All trucks have been assigned to your booking!'
      });

      // Notify remaining transporters that booking is no longer available
      for (const transporterId of booking.notifiedTransporters) {
        emitToUser(transporterId, SocketEvent.BOOKING_EXPIRED, {
          bookingId,
          orderId: bookingId,
          broadcastId: bookingId,
          reason: 'fully_filled',
          message: 'All trucks have been assigned for this booking',
          customerName: booking.customerName
        });
      }

      logger.info(`🎉 Booking ${bookingId} FULLY FILLED: ${newFilled}/${booking.trucksNeeded} trucks`);
    } else {
      // Partially filled - notify customer
      emitToUser(booking.customerId, SocketEvent.BOOKING_PARTIALLY_FILLED, {
        bookingId,
        trucksNeeded: booking.trucksNeeded,
        trucksFilled: newFilled,
        // M18 FIX: Legacy aliases for Captain app compatibility
        filled: newFilled,               // Captain reads 'filled'
        total: booking.trucksNeeded,      // Captain reads 'total'
        remaining: booking.trucksNeeded - newFilled,
        message: `${newFilled} truck${newFilled > 1 ? 's' : ''} assigned, searching for ${booking.trucksNeeded - newFilled} more...`
      });

      logger.info(`📦 Booking ${bookingId} PARTIALLY FILLED: ${newFilled}/${booking.trucksNeeded} trucks`);
    }

    return updated || booking;
  }

  /**
   * Decrement trucks filled (called when assignment is cancelled)
   */
  async decrementTrucksFilled(bookingId: string): Promise<BookingRecord> {
    const booking = await db.getBookingById(bookingId);

    if (!booking) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }

    // =====================================================================
    // ATOMIC DECREMENT — Same pattern as incrementTrucksFilled fix
    // Old code: read trucksFilled → subtract 1 in JS → write back (RACE)
    //   Two concurrent cancels both read 3, both write 2 → count = 2 (should be 1)
    // New code: single SQL SET "trucksFilled" = GREATEST(0, "trucksFilled" - 1)
    //   Database guarantees atomicity. GREATEST(0, ...) prevents negative values.
    // =====================================================================
    // CRITICAL #19: Add status guard to prevent decrement on terminal bookings
    const atomicResult = await prismaClient.$queryRaw<Array<{ trucksFilled: number }>>`
      UPDATE "Booking"
      SET "trucksFilled" = GREATEST(0, "trucksFilled" - 1),
          "stateChangedAt" = NOW()
      WHERE id = ${bookingId}
        AND "status" NOT IN ('cancelled', 'expired', 'completed')
      RETURNING "trucksFilled"
    `;

    if (!atomicResult || atomicResult.length === 0) {
      logger.warn('[BOOKING] Skipped decrement — booking is in terminal state or not found', { bookingId });
      return booking;
    }

    const newFilled = atomicResult[0].trucksFilled;
    const newStatus = newFilled === 0 ? 'active' : 'partially_filled';

    // FIX-R2-9: Conditional status write — block if booking already in terminal state
    let updated: BookingRecord | undefined;
    try {
      const statusResult = await prismaClient.booking.updateMany({
        where: {
          id: bookingId,
          status: { notIn: ['cancelled', 'expired', 'completed'] }
        },
        data: { status: newStatus, stateChangedAt: new Date() }
      });
      if (statusResult.count === 0) {
        logger.warn('[RACE] Status write blocked — booking already in terminal state', {
          bookingId, attemptedStatus: newStatus
        });
      }
      updated = await db.getBookingById(bookingId);
    } catch (err: unknown) {
      logger.error('[BOOKING] Failed to update status after decrement', { bookingId, newStatus, error: (err as Error).message });
    }

    // Notify via WebSocket
    emitToBooking(bookingId, SocketEvent.BOOKING_UPDATED, {
      bookingId,
      status: newStatus,
      trucksFilled: newFilled,
      trucksNeeded: booking.trucksNeeded
    });

    // Fix B5: Restart broadcast/timeout for remaining slots after decrement
    if (newFilled < booking.trucksNeeded) {
      const remaining = booking.trucksNeeded - newFilled;
      logger.info(`[BOOKING] Driver declined after fill. Restarting broadcast for ${remaining} remaining slots`, { bookingId });
      // CRITICAL #10: Null guard replaces non-null assertion on _createService
      if (!_createService) {
        logger.error('[LIFECYCLE] FATAL: _createService not initialized — cannot restart booking timeout', { bookingId });
        return updated || booking;
      }
      _createService.startBookingTimeout(bookingId, booking.customerId);
      // Emit socket event to customer
      emitToUser(booking.customerId, SocketEvent.TRUCKS_REMAINING_UPDATE, {
        bookingId, trucksFilled: newFilled, trucksNeeded: booking.trucksNeeded
      });
    }

    return updated || booking;
  }

  /**
   * FIX #45: Hard expiry for bookings older than BOOKING_MAX_AGE_HOURS.
   * Safety net: even if the normal timeout handler fails or misses a booking,
   * this reconciliation ensures no booking stays active indefinitely.
   * Called periodically by the expiry checker or reconciliation loop.
   * Returns the count of bookings expired.
   */
  async expireStaleBookings(): Promise<number> {
    const cutoff = new Date(Date.now() - BOOKING_MAX_AGE_HOURS * 60 * 60 * 1000);

    try {
      // CRITICAL #11: First findMany to get stale bookings for cleanup
      const staleBookings = await prismaClient.booking.findMany({
        where: {
          status: { notIn: [...TERMINAL_STATUSES] as BookingStatus[] },
          createdAt: { lt: cutoff },
        },
        select: { id: true, customerId: true },
        take: 100,  // FIX-27: Bound query to prevent unbounded result sets
      });

      if (staleBookings.length === 0) {
        return 0;
      }

      const staleIds = staleBookings.map(b => b.id);

      // CAS guard: only expire the found IDs that are still non-terminal
      const result = await prismaClient.booking.updateMany({
        where: {
          id: { in: staleIds },
          status: { notIn: [...TERMINAL_STATUSES] as BookingStatus[] },
        },
        data: {
          status: BookingStatus.expired,
          stateChangedAt: new Date(),
        },
      });

      if (result.count > 0) {
        logger.warn(`[RECONCILIATION] Hard-expired ${result.count} stale bookings older than ${BOOKING_MAX_AGE_HOURS}h`, {
          cutoff: cutoff.toISOString(),
          expiredCount: result.count,
        });
      }

      // Per-booking cleanup: Redis keys + customer notification
      // Batch customer:active-broadcast deletes via Redis multi() to reduce round-trips.
      // clearBookingTimers handles all timer + radius keys per booking.
      try {
        const tx = redisService.multi();
        const uniqueCustomers = new Set<string>();
        for (const stale of staleBookings) {
          uniqueCustomers.add(stale.customerId);
        }
        for (const customerId of uniqueCustomers) {
          tx.del(`customer:active-broadcast:${customerId}`);
        }
        await tx.exec();
      } catch (batchErr: unknown) {
        const msg = batchErr instanceof Error ? batchErr.message : String(batchErr);
        logger.warn('[RECONCILIATION] Batch Redis cleanup failed, falling back to per-booking', { error: msg });
      }

      for (const stale of staleBookings) {
        try {
          // clearBookingTimers cleans: booking expiry timer, radius step timer,
          // current step key, and notified transporter set — all in parallel.
          await this.clearBookingTimers(stale.id);
          // Notify customer that their booking expired
          emitToUser(stale.customerId, SocketEvent.BOOKING_EXPIRED, {
            bookingId: stale.id,
            status: 'expired',
            reason: 'stale_booking_reconciliation',
            message: 'Your booking has expired due to inactivity.',
          });
          // Also emit order_expired for customer app compatibility (customer listens for order_expired)
          emitToUser(stale.customerId, 'order_expired', {
            bookingId: stale.id,
            status: 'expired',
            reason: 'stale_booking_reconciliation',
            message: 'Your booking has expired due to inactivity.',
            _compat: 'booking_expired',
          });
        } catch (cleanupErr: unknown) {
          // One failure must not block others
          const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
          logger.warn('[RECONCILIATION] Per-booking cleanup failed', {
            bookingId: stale.id, customerId: stale.customerId, error: msg,
          });
        }
      }

      return result.count;
    } catch (err: unknown) {
      logger.error('[RECONCILIATION] Failed to expire stale bookings', { error: (err as Error).message });
      return 0;
    }
  }
}

export const bookingLifecycleService = new BookingLifecycleService();

/**
 * FIX #68 + C-03: Register the booking:resume-broadcast queue processor.
 * Without this, jobs enqueued by resumeInterruptedBroadcasts() have no consumer
 * and are silently dropped. Called once at server startup (see server.ts).
 *
 * C-03 FIX: Instead of immediately expiring the booking, re-queue it for
 * re-broadcasting with a retry counter (max 3). Only expire after retries
 * are exhausted. This prevents server restarts from killing active bookings.
 */
export function registerResumeBroadcastProcessor(): void {
  const MAX_RESUME_RETRIES = 3;
  const RESUME_RETRY_DELAY_MS = 2000;

  queueService.registerProcessor('booking:resume-broadcast', async (job) => {
    const { bookingId, customerId, retryCount = 0 } = job.data as {
      bookingId: string;
      customerId: string;
      retryCount?: number;
    };
    logger.info('[ResumeBroadcast] Processing stale broadcast recovery', {
      bookingId, customerId, retryCount, maxRetries: MAX_RESUME_RETRIES,
    });
    try {
      // Check if booking is still in a resumable state
      const booking = await prismaClient.booking.findUnique({
        where: { id: bookingId },
        select: { id: true, status: true, expiresAt: true },
      });

      if (!booking) {
        logger.warn('[ResumeBroadcast] Booking not found, skipping', { bookingId });
        return;
      }

      // Already in terminal state — nothing to do
      if (['cancelled', 'expired', 'completed', 'fully_filled'].includes(booking.status)) {
        logger.info('[ResumeBroadcast] Booking already in terminal state, skipping', {
          bookingId, status: booking.status,
        });
        return;
      }

      // Check if broadcast window has already passed
      const now = new Date();
      if (booking.expiresAt && new Date(booking.expiresAt) <= now) {
        logger.info('[ResumeBroadcast] Booking broadcast window expired, expiring booking', { bookingId });
        await prismaClient.booking.updateMany({
          where: {
            id: bookingId,
            status: { notIn: ['cancelled', 'expired', 'completed', 'fully_filled'] },
          },
          data: { status: 'expired', stateChangedAt: new Date() },
        });
        emitToUser(customerId, SocketEvent.BOOKING_EXPIRED, {
          bookingId,
          status: 'expired',
          reason: 'broadcast_window_expired',
          message: 'Your booking has expired. Please try again.',
        });
        // Also emit order_expired for customer app compatibility (customer listens for order_expired)
        emitToUser(customerId, 'order_expired', {
          bookingId,
          status: 'expired',
          reason: 'broadcast_window_expired',
          message: 'Your booking has expired. Please try again.',
          _compat: 'booking_expired',
        });
        await redisService.del(`customer:active-broadcast:${customerId}`).catch(() => {});
        return;
      }

      // Retries exhausted — expire the booking
      if (retryCount >= MAX_RESUME_RETRIES) {
        logger.warn('[ResumeBroadcast] Max retries exhausted, expiring booking', {
          bookingId, retryCount,
        });
        const result = await prismaClient.booking.updateMany({
          where: {
            id: bookingId,
            status: { notIn: ['cancelled', 'expired', 'completed', 'fully_filled'] },
          },
          data: { status: 'expired', stateChangedAt: new Date() },
        });
        if (result.count > 0) {
          emitToUser(customerId, SocketEvent.BOOKING_EXPIRED, {
            bookingId,
            status: 'expired',
            reason: 'interrupted_broadcast_recovery_exhausted',
            message: 'Your previous booking could not be broadcast after multiple attempts. Please try again.',
          });
          // Also emit order_expired for customer app compatibility (customer listens for order_expired)
          emitToUser(customerId, 'order_expired', {
            bookingId,
            status: 'expired',
            reason: 'interrupted_broadcast_recovery_exhausted',
            message: 'Your previous booking could not be broadcast after multiple attempts. Please try again.',
            _compat: 'booking_expired',
          });
          await redisService.del(`customer:active-broadcast:${customerId}`).catch(() => {});
        }
        return;
      }

      // C-03 FIX: Extend the booking timeout by 60 seconds and re-queue for
      // another resume attempt instead of expiring immediately.
      const extendMs = 60_000;
      const newExpiresAt = new Date(now.getTime() + extendMs);
      await prismaClient.booking.updateMany({
        where: {
          id: bookingId,
          status: { notIn: ['cancelled', 'expired', 'completed', 'fully_filled'] },
        },
        data: { expiresAt: newExpiresAt.toISOString(), stateChangedAt: new Date() },
      });

      // DR-19 FIX: Restart the Redis expiry timer to match the extended expiresAt.
      // Without this, the timer from the previous run is gone (server restarted),
      // and the booking will never auto-expire via the timer-based path.
      await redisService.setTimer(
        TIMER_KEYS.BOOKING_EXPIRY(bookingId),
        { bookingId, customerId },
        newExpiresAt
      ).catch(timerErr => {
        const msg = timerErr instanceof Error ? timerErr.message : String(timerErr);
        logger.warn('[ResumeBroadcast] Failed to restart Redis timer (non-fatal — reconciliation backstop)', {
          bookingId, error: msg,
        });
      });

      logger.info('[ResumeBroadcast] Extended booking timeout and re-queuing for broadcast', {
        bookingId, retryCount: retryCount + 1, newExpiresAt: newExpiresAt.toISOString(),
      });

      // Re-queue the booking for another resume attempt with incremented retry count
      await queueService.enqueue('booking:resume-broadcast', {
        bookingId,
        customerId,
        retryCount: retryCount + 1,
      }, { delay: RESUME_RETRY_DELAY_MS });

    } catch (err: unknown) {
      logger.error('[ResumeBroadcast] Failed to process resume job', { bookingId, error: (err as Error)?.message });
      throw err; // Let queue retry
    }
  });
}
