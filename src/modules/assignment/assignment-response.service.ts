/**
 * =============================================================================
 * ASSIGNMENT MODULE - RESPONSE SERVICE
 * =============================================================================
 *
 * Handles driver acceptance of assignments.
 * =============================================================================
 */

import { db, AssignmentRecord } from '../../shared/database/db';
import { VehicleStatus } from '@prisma/client';
import { prismaClient, withDbTimeout } from '../../shared/database/prisma.service';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, emitToBooking, SocketEvent } from '../../shared/services/socket.service';
import { queueService } from '../../shared/services/queue.service';
import { redisService } from '../../shared/services/redis.service';
import { liveAvailabilityService } from '../../shared/services/live-availability.service';
import { invalidateVehicleCache } from '../../shared/services/fleet-cache-write.service';
import { trackingService } from '../tracking/tracking.service';

// =============================================================================
// RESPONSE SERVICE
// =============================================================================

class AssignmentResponseService {
  private resolveAssignmentStreamId(assignment: AssignmentRecord): string | undefined {
    return assignment.bookingId || assignment.orderId;
  }

  // ==========================================================================
  // ACCEPT ASSIGNMENT (Driver accepts)
  // ==========================================================================

  async acceptAssignment(
    assignmentId: string,
    driverId: string
  ): Promise<AssignmentRecord> {
    const assignment = await db.getAssignmentById(assignmentId);

    if (!assignment) {
      throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found');
    }

    if (assignment.driverId !== driverId) {
      throw new AppError(403, 'FORBIDDEN', 'This assignment is not for you');
    }

    if (assignment.status !== 'pending') {
      // =====================================================================
      // FIX: Include currentStatus in error so app can show helpful message
      //   - 'driver_accepted' → "You've already accepted this trip" (not an error)
      //   - 'cancelled'       → "This trip was cancelled by the transporter"
      //   - 'driver_declined'  → "This trip has expired"
      // Uber pattern: error response contains the actual state for client-side handling
      // =====================================================================
      const statusMessages: Record<string, string> = {
        'driver_accepted': 'You have already accepted this trip',
        'cancelled': 'This trip was cancelled by the transporter',
        'driver_declined': 'This trip has expired or been declined',
        'en_route_pickup': 'You have already accepted this trip',
        'at_pickup': 'You have already accepted this trip',
        'in_transit': 'This trip is already in progress',
        'completed': 'This trip has already been completed'
      };
      const message = statusMessages[assignment.status] || `Assignment cannot be accepted (current status: ${assignment.status})`;
      const error = new AppError(400, 'INVALID_STATUS', message);
      (error as AppError & { currentStatus?: string }).currentStatus = assignment.status;
      throw error;
    }

    // =================================================================
    // RULE: ONE ACTIVE TRIP PER DRIVER (Double-check at accept time)
    // Even if assignment was created, driver might have accepted another
    // trip in the meantime. This is the final safety check.
    // =================================================================
    // H-17 FIX: Use direct DB query instead of stale cache for the safety-critical
    // driver busy check. The previous 3s cache could allow double-accept when two
    // accept requests arrive within the cache window. This is a safety guard so
    // correctness > performance. Cache is kept below for read-only display purposes.
    const activeAssignment = await prismaClient.assignment.findFirst({
      where: {
        driverId,
        status: { in: ['pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit'] },
        id: { not: assignmentId },
      },
    });
    if (activeAssignment) {
      logger.warn(`Driver ${driverId} tried to accept ${assignmentId} but already has active assignment: ${activeAssignment.id}`);
      throw new AppError(400, 'DRIVER_BUSY',
        `Driver already has active assignment ${activeAssignment.id}`);
    }

    // Queue job is idempotent: handleAssignmentTimeout() uses updateMany({ where: { status: 'pending' }})
    // so if driver accepted first, the timer no-ops when it fires.
    // No explicit cancellation needed.

    // =====================================================================
    // CRITICAL FIX: Atomic transaction for assignment + vehicle status
    // =====================================================================
    // BEFORE: Two separate DB writes — assignment update could succeed
    //   but vehicle update could fail, leaving inconsistent state.
    // NOW: Single Prisma transaction — both succeed or both roll back.
    // =====================================================================
    const updated = await withDbTimeout(async (tx) => {
      // 1. Atomically update assignment status (only if still pending)
      const updatedAssignment = await tx.assignment.updateMany({
        where: { id: assignmentId, status: 'pending' },
        data: {
          status: 'driver_accepted',
          driverAcceptedAt: new Date().toISOString()
        }
      });

      if (updatedAssignment.count === 0) {
        throw new AppError(400, 'ASSIGNMENT_STATE_CHANGED',
          'Assignment is no longer pending — it may have timed out or been cancelled.');
      }

      // 2. Atomically update vehicle status: on_hold → in_transit
      if (assignment.vehicleId) {
        await tx.vehicle.updateMany({
          where: {
            id: assignment.vehicleId,
            status: { in: ['on_hold', 'available'] as VehicleStatus[] }  // Accept from on_hold (normal) or available (legacy)
          },
          data: {
            status: 'in_transit',
            currentTripId: assignment.tripId,
            assignedDriverId: driverId,
            lastStatusChange: new Date().toISOString()
          }
        });
      }

      // Return the updated assignment
      return await tx.assignment.findUnique({ where: { id: assignmentId } });
    }, { timeoutMs: 8000 });

    if (!updated) {
      throw new AppError(500, 'ACCEPT_FAILED', 'Failed to accept assignment');
    }

    // Problem 16 fix: Cancel Redis-backed assignment timeout (driver accepted)
    queueService.cancelAssignmentTimeout(assignmentId).catch((cancelErr: unknown) => {
      logger.warn(`[acceptAssignment] Failed to cancel timeout timer: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`);
    });

    // =====================================================================
    // FIX C-10: Redis-based idempotency guard — prevents double side effects
    // when both confirmed-hold.service and assignment-response.service
    // process the same acceptance. The first path to acquire wins; the
    // second path skips all post-accept side effects.
    // Uses the same key pattern as confirmed-hold.service.ts.
    // =====================================================================
    const sideEffectKey = `side-effect:accept:${assignmentId}`;
    const sideEffectLock = await redisService.acquireLock(sideEffectKey, 'assignment-response', 300);
    if (!sideEffectLock.acquired) {
      logger.info(`[ASSIGNMENT] Skipping duplicate side effects for assignment ${assignmentId} (already applied by another path)`);
    } else {

    // =====================================================================
    // Post-transaction: Update Redis availability (non-fatal)
    // =====================================================================
    if (assignment.vehicleId) {
      try {
        const vehicle = await prismaClient.vehicle.findUnique({
          where: { id: assignment.vehicleId },
          select: { vehicleKey: true, transporterId: true }
        });
        if (vehicle?.vehicleKey && vehicle?.transporterId) {
          await liveAvailabilityService.onVehicleStatusChange(
            vehicle.transporterId,
            vehicle.vehicleKey,
            'on_hold',            // Was on_hold while pending
            'in_transit'          // Now in transit after driver accepted
          ).catch(err => logger.warn('[acceptAssignment] Redis update failed', err));

          // Issue #5: Invalidate fleet cache so dashboard reflects in_transit immediately
          invalidateVehicleCache(vehicle.transporterId, assignment.vehicleId)
            .catch(err => logger.warn('[acceptAssignment] Fleet cache invalidation failed (non-fatal)', err));
        }

        logger.info(`[ASSIGNMENT] Vehicle set to in_transit: ${assignment.vehicleNumber} (driver accepted)`);
      } catch (err: unknown) {
        logger.error('[ASSIGNMENT] Failed to update Redis vehicle status', {
          vehicleId: assignment.vehicleId,
          assignmentId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    // =====================================================================
    // FIX: Seed tracking at acceptance with driver's real GPS
    // =====================================================================
    // BEFORE: initializeTracking() existed but was never called → customer
    //   hit 404 "No tracking data" for 5–30 seconds after driver accepted
    // NOW: Fetch driver's last known GPS from Redis and seed trip tracking
    //   immediately. Customer sees driver position on map right away.
    // Uber/Grab pattern: backend seeds tracking at acceptance time.
    // =====================================================================
    try {
      const driverLocationKey = `driver:location:${driverId}`;
      const driverLocation = await redisService.getJSON<{ latitude: number; longitude: number; timestamp?: number }>(driverLocationKey);
      // initializeTracking seeds the Redis trip key + adds driver to fleet set
      await trackingService.initializeTracking(
        assignment.tripId,
        driverId,
        assignment.vehicleNumber,
        assignment.bookingId,
        assignment.transporterId,
        assignment.vehicleId
      );
      // If we have the driver's real GPS, overwrite the 0,0 default
      // GPS STALENESS: Reject location older than 5 minutes (driver may have moved)
      const GPS_MAX_AGE_MS = 5 * 60 * 1000;
      const locationAge = driverLocation?.timestamp ? Date.now() - driverLocation.timestamp : 0;
      if (driverLocation?.latitude && driverLocation?.longitude) {
        if (locationAge > GPS_MAX_AGE_MS) {
          logger.warn(`[ASSIGNMENT] Stale GPS for driver ${driverId}: ${Math.round(locationAge / 1000)}s old — skipping seed, waiting for live update`);
        } else {
          const tripKey = `driver:trip:${assignment.tripId}`;
          const tripData = await redisService.getJSON<Record<string, unknown>>(tripKey);
          if (tripData) {
            tripData.latitude = driverLocation.latitude;
            tripData.longitude = driverLocation.longitude;
            tripData.status = 'driver_accepted';
            await redisService.setJSON(tripKey, tripData, 86400);
          }
        }
      }
    } catch (err: unknown) {
      // Non-fatal — tracking will initialize on first GPS update anyway
      logger.warn(`[ASSIGNMENT] Failed to seed tracking at acceptance (non-fatal)`, {
        tripId: assignment.tripId, error: err instanceof Error ? err.message : String(err)
      });
    }

    // Notify booking room
    const acceptanceStreamId = this.resolveAssignmentStreamId(assignment);
    if (acceptanceStreamId) {
      emitToBooking(acceptanceStreamId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
        assignmentId,
        tripId: assignment.tripId,
        status: 'driver_accepted',
        vehicleNumber: assignment.vehicleNumber
      });
    }

    // FCM push to transporter: driver accepted
    queueService.queuePushNotification(assignment.transporterId, {
      title: '✅ Driver Accepted Trip',
      body: `${assignment.driverName} accepted the trip (${assignment.vehicleNumber})`,
      data: {
        type: 'assignment_update',
        assignmentId,
        tripId: assignment.tripId,
        status: 'driver_accepted'
      }
    }).catch(err => {
      logger.warn(`FCM: Failed to notify transporter of acceptance`, err);
    });

    // =====================================================================
    // Phase 5: FCM push to CUSTOMER — "Driver on the way!"
    // =====================================================================
    // Customer may have app backgrounded. This ensures they know a driver
    // accepted their booking even when not watching the tracking screen.
    // =====================================================================
    const booking = assignment.bookingId
      ? await db.getBookingById(assignment.bookingId)
      : undefined;
    if (booking?.customerId) {
      // WebSocket to customer
      emitToUser(booking.customerId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
        assignmentId,
        tripId: assignment.tripId,
        bookingId: assignment.bookingId,
        status: 'driver_accepted',
        driverName: assignment.driverName,
        vehicleNumber: assignment.vehicleNumber,
        message: `${assignment.driverName} accepted. Vehicle: ${assignment.vehicleNumber}`
      });

      // FCM push to customer
      // M8 FIX: Customer app checks TYPE_DRIVER_ASSIGNED = "driver_assigned",
      // so FCM type must be 'driver_assigned' (not 'driver_accepted')
      queueService.queuePushNotification(booking.customerId, {
        title: '🚛 Driver on the way!',
        body: `${assignment.driverName} accepted. Vehicle: ${assignment.vehicleNumber}`,
        data: {
          type: 'driver_assigned',
          assignmentId,
          tripId: assignment.tripId,
          bookingId: assignment.bookingId,
          driverName: assignment.driverName,
          vehicleNumber: assignment.vehicleNumber,
          status: 'driver_accepted'
        }
      }).catch(err => {
        logger.warn(`FCM: Failed to notify customer of driver acceptance`, err);
      });
    }

    } // end FIX C-10 idempotency guard

    logger.info(`Assignment accepted: ${assignmentId} by driver ${driverId}`);

    // Invalidate negative cache — driver now has an active assignment
    await redisService.del(`driver:active-assignment:${driverId}`).catch(() => {});

    return updated! as unknown as AssignmentRecord;
  }
}

export const assignmentResponseService = new AssignmentResponseService();
