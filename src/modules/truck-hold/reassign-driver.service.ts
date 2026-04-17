/**
 * =============================================================================
 * DRIVER REASSIGNMENT SERVICE
 * =============================================================================
 *
 * Cancel-and-Rematch pattern (Uber/Ola industry standard):
 * 1. Validate assignment is in reassignable state (pending | driver_accepted)
 * 2. In SERIALIZABLE transaction:
 *    a. Cancel old assignment (CAS guard)
 *    b. Release old vehicle -> available
 *    c. Create new assignment for new driver
 *    d. Hold new vehicle -> on_hold
 * 3. Post-transaction: emit socket events, FCM push, schedule timeout
 *
 * Rate limit: max 3 reassigns per original assignment (tracked in Redis)
 * =============================================================================
 */

import { v4 as uuid } from 'uuid';
import { Prisma } from '@prisma/client';
import { prismaClient, withDbTimeout } from '../../shared/database/prisma.service';
import { db } from '../../shared/database/db';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { emitToUser, emitToBooking, SocketEvent } from '../../shared/services/socket.service';
import { queueService } from '../../shared/services/queue.service';
import { liveAvailabilityService } from '../../shared/services/live-availability.service';
import { invalidateVehicleCache } from '../../shared/services/fleet-cache-write.service';
// State machine imports available if needed for future transition validation
// import { ASSIGNMENT_VALID_TRANSITIONS, TERMINAL_ASSIGNMENT_STATUSES } from '../../core/state-machines';
import { HOLD_CONFIG } from '../../core/config/hold-config';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Only these statuses allow reassignment (trip not yet started) */
const REASSIGNABLE_STATUSES = ['pending', 'driver_accepted'] as const;

/** Max reassigns per original assignment chain */
const MAX_REASSIGNS_PER_ASSIGNMENT = 3;

/** Redis key TTL for reassign counter (24 hours) */
const REASSIGN_COUNTER_TTL_SECONDS = 86400;

/** Driver accept timeout (reuse centralized config) */
const DRIVER_ACCEPT_TIMEOUT_MS = HOLD_CONFIG.driverAcceptTimeoutMs;

// =============================================================================
// TYPES
// =============================================================================

interface ReassignDriverInput {
  assignmentId: string;
  transporterId: string;
  newDriverId: string;
  reason?: string;
}

interface ReassignDriverResult {
  success: boolean;
  newAssignmentId?: string;
  newTripId?: string;
  message: string;
  errorCode?: string;
}

// =============================================================================
// SERVICE
// =============================================================================

/**
 * Reassign a driver for an existing assignment.
 *
 * Cancel-and-Rematch pattern:
 * - Old assignment is cancelled atomically
 * - New assignment is created in the same transaction
 * - Vehicle status transitions: old vehicle released, (same or new) vehicle held
 *
 * @param input - assignmentId, transporterId, newDriverId, optional reason
 * @returns ReassignDriverResult with new assignment ID on success
 */
export async function reassignDriver(input: ReassignDriverInput): Promise<ReassignDriverResult> {
  const { assignmentId, transporterId, newDriverId, reason } = input;

  // =========================================================================
  // 1. FETCH & VALIDATE OLD ASSIGNMENT
  // =========================================================================

  const oldAssignment = await db.getAssignmentById(assignmentId);
  if (!oldAssignment) {
    throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found');
  }

  // Ownership check
  if (oldAssignment.transporterId !== transporterId) {
    throw new AppError(403, 'FORBIDDEN', 'This assignment does not belong to you');
  }

  // Status check: only pending or driver_accepted can be reassigned
  if (!(REASSIGNABLE_STATUSES as readonly string[]).includes(oldAssignment.status)) {
    throw new AppError(400, 'ASSIGNMENT_NOT_REASSIGNABLE',
      `Cannot reassign: assignment is '${oldAssignment.status}'. ` +
      `Reassignment is only allowed when status is 'pending' or 'driver_accepted'.`
    );
  }

  // Same driver check
  if (oldAssignment.driverId === newDriverId) {
    throw new AppError(400, 'SAME_DRIVER', 'New driver is the same as the current driver');
  }

  // =========================================================================
  // 2. RATE LIMIT: Max 3 reassigns per assignment chain
  // =========================================================================

  // Track by the original assignment or chain root
  // Use the assignment's bookingId/orderId + vehicleId as the chain key
  const chainKey = `reassign:count:${oldAssignment.bookingId || oldAssignment.orderId || ''}:${oldAssignment.vehicleId}`;
  const currentCount = await redisService.get(chainKey);
  const count = parseInt(currentCount || '0', 10);

  if (count >= MAX_REASSIGNS_PER_ASSIGNMENT) {
    return {
      success: false,
      message: `Maximum ${MAX_REASSIGNS_PER_ASSIGNMENT} reassignments reached for this truck. Please cancel and create a new assignment instead.`,
      errorCode: 'MAX_REASSIGNS_EXCEEDED',
    };
  }

  // =========================================================================
  // 3. VALIDATE NEW DRIVER
  // =========================================================================

  const newDriver = await db.getUserById(newDriverId);
  if (!newDriver) {
    throw new AppError(404, 'DRIVER_NOT_FOUND', 'New driver not found');
  }

  if (newDriver.transporterId !== transporterId) {
    throw new AppError(403, 'FORBIDDEN', 'New driver does not belong to you');
  }

  // =========================================================================
  // 4. VALIDATE VEHICLE STILL EXISTS
  // =========================================================================

  const vehicle = await prismaClient.vehicle.findUnique({
    where: { id: oldAssignment.vehicleId },
    select: {
      id: true,
      vehicleKey: true,
      transporterId: true,
      vehicleNumber: true,
      vehicleType: true,
      vehicleSubtype: true,
      status: true,
    },
  });

  if (!vehicle) {
    throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle no longer exists');
  }

  // =========================================================================
  // 5. TRANSACTIONAL CANCEL-AND-REMATCH
  // =========================================================================

  const newAssignmentId = uuid();
  const newTripId = uuid();

  const transporter = await db.getUserById(transporterId);
  const transporterName = transporter?.businessName || transporter?.name || 'Transporter';

  try {
    await withDbTimeout(async (tx) => {
      // -----------------------------------------------------------------
      // 5a. CAS: Cancel old assignment (only if still in reassignable state)
      // -----------------------------------------------------------------
      const cancelResult = await tx.assignment.updateMany({
        where: {
          id: assignmentId,
          status: { in: [...REASSIGNABLE_STATUSES] as any },
        },
        data: {
          status: 'cancelled',
          declineReason: reason || 'reassigned_by_transporter',
          declineType: 'reassignment',
          declinedAt: new Date(),
        },
      });

      if (cancelResult.count === 0) {
        throw new AppError(409, 'ASSIGNMENT_STATE_CHANGED',
          'Assignment status changed before reassignment could complete. Please try again.');
      }

      // -----------------------------------------------------------------
      // 5b. Release old vehicle -> available (CAS: only if not already available)
      // -----------------------------------------------------------------
      await tx.vehicle.updateMany({
        where: { id: oldAssignment.vehicleId, status: { not: 'available' } },
        data: {
          status: 'available',
          currentTripId: null,
          assignedDriverId: null,
          lastStatusChange: new Date().toISOString(),
        },
      });

      // -----------------------------------------------------------------
      // 5c. Check new driver is not already on an active trip
      // -----------------------------------------------------------------
      const activeStatuses = ['pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit', 'arrived_at_drop'];
      const existingActiveAssignment = await tx.assignment.findFirst({
        where: { driverId: newDriverId, status: { in: activeStatuses as any } },
        select: { id: true, tripId: true },
      });

      if (existingActiveAssignment) {
        throw new AppError(400, 'NEW_DRIVER_BUSY',
          `Driver ${newDriver.name} already has an active trip. Please assign a different driver.`);
      }

      // -----------------------------------------------------------------
      // 5d. Create new assignment for new driver (same vehicle, same order refs)
      // -----------------------------------------------------------------
      await tx.assignment.create({
        data: {
          id: newAssignmentId,
          bookingId: oldAssignment.bookingId || null,
          truckRequestId: oldAssignment.truckRequestId || null,
          orderId: oldAssignment.orderId || null,
          transporterId,
          transporterName,
          vehicleId: oldAssignment.vehicleId,
          vehicleNumber: oldAssignment.vehicleNumber,
          vehicleType: oldAssignment.vehicleType,
          vehicleSubtype: oldAssignment.vehicleSubtype || '',
          driverId: newDriverId,
          driverName: newDriver.name,
          driverPhone: newDriver.phone,
          tripId: newTripId,
          status: 'pending',
          assignedAt: new Date().toISOString(),
        } as any,
      });

      // -----------------------------------------------------------------
      // 5e. Hold vehicle for new assignment -> on_hold (CAS: only if available)
      // -----------------------------------------------------------------
      await tx.vehicle.updateMany({
        where: { id: oldAssignment.vehicleId, status: 'available' },
        data: {
          status: 'on_hold',
          currentTripId: newTripId,
          assignedDriverId: newDriverId,
          lastStatusChange: new Date().toISOString(),
        },
      });

      // -----------------------------------------------------------------
      // 5f. Update TruckRequest if applicable (point to new assignment)
      // -----------------------------------------------------------------
      if (oldAssignment.truckRequestId) {
        await tx.truckRequest.updateMany({
          where: { id: oldAssignment.truckRequestId },
          data: {
            assignedDriverId: newDriverId,
            assignedDriverName: newDriver.name,
            assignedDriverPhone: newDriver.phone,
            tripId: newTripId,
            assignedAt: new Date().toISOString(),
          },
        });
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeoutMs: 10000 });
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error('[reassignDriver] Transaction failed', {
      assignmentId,
      newDriverId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new AppError(500, 'REASSIGN_FAILED', 'Reassignment failed due to a server error. Please try again.');
  }

  // =========================================================================
  // 6. POST-TRANSACTION: Redis/cache sync (non-fatal)
  // =========================================================================

  // 6a. Increment reassign counter
  try {
    const newCount = await redisService.incr(chainKey);
    if (newCount === 1) {
      await redisService.expire(chainKey, REASSIGN_COUNTER_TTL_SECONDS);
    }
  } catch (err) {
    logger.warn('[reassignDriver] Failed to increment reassign counter (non-fatal)', {
      chainKey, error: err instanceof Error ? err.message : String(err),
    });
  }

  // 6b. Vehicle status sync: old status -> available -> on_hold
  // The vehicle went available then on_hold within the TX. For Redis,
  // we just need to reflect the final state (on_hold).
  if (vehicle.vehicleKey) {
    liveAvailabilityService.onVehicleStatusChange(
      transporterId, vehicle.vehicleKey,
      vehicle.status, // whatever it was before
      'on_hold'
    ).catch(err => logger.warn('[reassignDriver] Redis availability sync failed', err));
  }
  invalidateVehicleCache(transporterId, oldAssignment.vehicleId)
    .catch(err => logger.warn('[reassignDriver] Fleet cache invalidation failed', err));

  // 6c. Cancel old assignment timeout
  queueService.cancelAssignmentTimeout(assignmentId).catch(err => {
    logger.warn('[reassignDriver] Failed to cancel old timeout', { error: err?.message });
  });

  // 6d. Invalidate driver active-assignment caches
  await redisService.del(`driver:active-assignment:${oldAssignment.driverId}`).catch(() => {});
  await redisService.del(`driver:active-assignment:${newDriverId}`).catch(() => {});

  // =========================================================================
  // 7. SCHEDULE NEW ASSIGNMENT TIMEOUT
  // =========================================================================

  try {
    await queueService.scheduleAssignmentTimeout({
      assignmentId: newAssignmentId,
      driverId: newDriverId,
      driverName: newDriver.name,
      transporterId,
      vehicleId: oldAssignment.vehicleId,
      vehicleNumber: oldAssignment.vehicleNumber,
      bookingId: oldAssignment.bookingId || undefined,
      tripId: newTripId,
      createdAt: new Date().toISOString(),
      orderId: oldAssignment.orderId || undefined,
      truckRequestId: oldAssignment.truckRequestId || undefined,
    }, DRIVER_ACCEPT_TIMEOUT_MS);
    logger.info(`[reassignDriver] Timeout scheduled for new assignment ${newAssignmentId} (${DRIVER_ACCEPT_TIMEOUT_MS / 1000}s)`);
  } catch (timeoutErr) {
    logger.error('[reassignDriver] CRITICAL: Failed to schedule timeout for new assignment', {
      newAssignmentId,
      error: timeoutErr instanceof Error ? timeoutErr.message : String(timeoutErr),
    });
    // Compensate: don't leave orphan pending assignment without timeout
    await prismaClient.assignment.updateMany({
      where: { id: newAssignmentId, status: 'pending' },
      data: { status: 'cancelled' },
    }).catch(compErr => {
      logger.error('[reassignDriver] Compensation cancel also failed', {
        newAssignmentId, error: compErr instanceof Error ? compErr.message : String(compErr),
      });
    });
    return {
      success: false,
      message: 'Reassignment failed: could not schedule driver timeout. Please try again.',
      errorCode: 'TIMEOUT_SCHEDULE_FAILED',
    };
  }

  // =========================================================================
  // 8. NOTIFICATIONS
  // =========================================================================

  const bookingOrOrderId = oldAssignment.bookingId || oldAssignment.orderId;

  // 8a. Notify OLD driver: assignment cancelled (WebSocket + FCM)
  emitToUser(oldAssignment.driverId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
    assignmentId,
    tripId: oldAssignment.tripId,
    status: 'cancelled',
    vehicleNumber: oldAssignment.vehicleNumber,
    message: 'This trip has been reassigned to another driver.',
  });

  queueService.queuePushNotification(oldAssignment.driverId, {
    title: 'Trip Reassigned',
    body: `Trip ${oldAssignment.vehicleNumber} has been reassigned to another driver.`,
    data: {
      type: 'assignment_update',
      assignmentId,
      tripId: oldAssignment.tripId,
      status: 'cancelled',
    },
  }).catch(err => logger.warn('[reassignDriver] FCM to old driver failed', err));

  // 8b. Notify NEW driver: new trip assigned (WebSocket + FCM)
  emitToUser(newDriverId, SocketEvent.TRIP_ASSIGNED, {
    assignmentId: newAssignmentId,
    tripId: newTripId,
    bookingId: oldAssignment.bookingId || undefined,
    orderId: oldAssignment.orderId || undefined,
    status: 'pending',
    message: 'New trip assigned to you',
  });

  queueService.queuePushNotification(newDriverId, {
    title: 'New Trip Assigned!',
    body: `Trip for ${oldAssignment.vehicleNumber}. Accept within ${DRIVER_ACCEPT_TIMEOUT_MS / 1000} seconds.`,
    data: {
      type: 'trip_assigned',
      priority: 'high', // Android-side priority via data map per FCM SDK contract
      assignmentId: newAssignmentId,
      tripId: newTripId,
      bookingId: oldAssignment.bookingId || '',
      orderId: oldAssignment.orderId || '',
      vehicleNumber: oldAssignment.vehicleNumber,
      vehicleType: oldAssignment.vehicleType || '',
      status: 'trip_assigned',
    },
  }).catch(err => logger.warn('[reassignDriver] FCM to new driver failed', err));

  // 8c. Notify booking/order room: assignment cancelled + new assignment created
  if (bookingOrOrderId) {
    emitToBooking(bookingOrOrderId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
      assignmentId,
      tripId: oldAssignment.tripId,
      status: 'cancelled',
      vehicleNumber: oldAssignment.vehicleNumber,
      reason: 'reassigned',
    });

    emitToBooking(bookingOrOrderId, SocketEvent.TRUCK_ASSIGNED, {
      bookingId: oldAssignment.bookingId || undefined,
      orderId: oldAssignment.orderId || undefined,
      assignment: {
        id: newAssignmentId,
        vehicleNumber: oldAssignment.vehicleNumber,
        driverName: newDriver.name,
        status: 'pending',
      },
    });
  }

  // 8d. Notify transporter: reassignment successful
  emitToUser(transporterId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
    assignmentId: newAssignmentId,
    oldAssignmentId: assignmentId,
    tripId: newTripId,
    status: 'pending',
    driverId: newDriverId,
    driverName: newDriver.name,
    vehicleNumber: oldAssignment.vehicleNumber,
    vehicleId: oldAssignment.vehicleId,
    message: `Driver reassigned: ${oldAssignment.driverName} -> ${newDriver.name}`,
  });

  logger.info('[reassignDriver] Reassignment complete', {
    oldAssignmentId: assignmentId,
    newAssignmentId,
    oldDriverId: oldAssignment.driverId,
    newDriverId,
    vehicleId: oldAssignment.vehicleId,
    reason: reason || 'none',
  });

  return {
    success: true,
    newAssignmentId,
    newTripId,
    message: `Driver reassigned from ${oldAssignment.driverName} to ${newDriver.name}`,
  };
}
