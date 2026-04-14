/**
 * =============================================================================
 * ASSIGNMENT MODULE - DISPATCH SERVICE
 * =============================================================================
 *
 * Handles assignment creation (transporter assigns truck to booking).
 * =============================================================================
 */

import { v4 as uuid } from 'uuid';
import { Prisma, AssignmentStatus, VehicleStatus } from '@prisma/client';
import { db, AssignmentRecord } from '../../shared/database/db';
import { withDbTimeout } from '../../shared/database/prisma.service';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, emitToBooking, SocketEvent } from '../../shared/services/socket.service';
import { queueService } from '../../shared/services/queue.service';
import { CreateAssignmentInput } from './assignment.schema';
import { ASSIGNMENT_CONFIG, AssignmentTimerData } from './assignment.types';

// =============================================================================
// DISPATCH SERVICE
// =============================================================================

class AssignmentDispatchService {
  // ==========================================================================
  // CREATE ASSIGNMENT (Transporter assigns truck to booking)
  // ==========================================================================

  async createAssignment(
    transporterId: string,
    data: CreateAssignmentInput
  ): Promise<AssignmentRecord> {
    // Verify booking exists and is active
    const booking = await db.getBookingById(data.bookingId);
    if (!booking) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }

    if (booking.status !== 'active' && booking.status !== 'partially_filled') {
      throw new AppError(400, 'BOOKING_NOT_ACTIVE', 'Booking is not accepting more trucks');
    }

    // Verify vehicle belongs to this transporter
    const vehicle = await db.getVehicleById(data.vehicleId);
    if (!vehicle) {
      throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found');
    }
    if (vehicle.transporterId !== transporterId) {
      throw new AppError(403, 'FORBIDDEN', 'This vehicle does not belong to you');
    }

    // Industry Standard: Verify vehicle is available (not in transit/busy)
    // Uber/Ola/Porter Pattern: Prevent double-booking by checking vehicle status
    if (vehicle.status !== 'available') {
      throw new AppError(400, 'VEHICLE_BUSY',
        `Vehicle ${vehicle.vehicleNumber} is currently ${vehicle.status}. Please select an available vehicle.`);
    }

    // Verify vehicle type matches booking
    if (vehicle.vehicleType !== booking.vehicleType) {
      throw new AppError(400, 'VEHICLE_MISMATCH',
        `Booking requires ${booking.vehicleType}, but vehicle is ${vehicle.vehicleType}`);
    }

    // Verify vehicle subtype matches booking (prevents wrong truck capacity)
    // Case-insensitive: handles "Open Body" vs "open body" variants
    // Only enforced when both booking and vehicle have a subtype (backward compatible)
    if (booking.vehicleSubtype && vehicle.vehicleSubtype &&
        vehicle.vehicleSubtype.toLowerCase() !== booking.vehicleSubtype.toLowerCase()) {
      throw new AppError(400, 'VEHICLE_SUBTYPE_MISMATCH',
        `Booking requires "${booking.vehicleSubtype}", but vehicle is "${vehicle.vehicleSubtype}"`);
    }

    // Verify driver belongs to this transporter
    const driver = await db.getUserById(data.driverId);
    if (!driver) {
      throw new AppError(404, 'DRIVER_NOT_FOUND', 'Driver not found');
    }
    if (driver.transporterId !== transporterId) {
      throw new AppError(403, 'FORBIDDEN', 'This driver does not belong to you');
    }

    // Get transporter info (outside transaction — read-only, no race risk)
    const transporter = await db.getUserById(transporterId);

    // =================================================================
    // RULE: ONE ACTIVE TRIP PER DRIVER
    // Wrap check + create in Serializable transaction to prevent
    // race condition where two concurrent requests both pass the check
    // and both create assignments for the same driver.
    // =================================================================
    const tripId = uuid();
    const assignmentId = uuid();
    const assignment: AssignmentRecord = {
      id: assignmentId,
      bookingId: data.bookingId,
      transporterId,
      transporterName: transporter?.businessName || transporter?.name || 'Transporter',
      vehicleId: data.vehicleId,
      vehicleNumber: vehicle.vehicleNumber,
      vehicleType: vehicle.vehicleType,
      vehicleSubtype: vehicle.vehicleSubtype,
      driverId: data.driverId,
      driverName: driver.name,
      driverPhone: driver.phone,
      tripId,
      status: 'pending',
      assignedAt: new Date().toISOString()
    };

    await withDbTimeout(async (tx) => {
      // Re-check inside transaction with Serializable isolation
      const activeStatuses = ['pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit', 'arrived_at_drop'];
      const activeAssignment = await tx.assignment.findFirst({
        where: { driverId: data.driverId, status: { in: activeStatuses as AssignmentStatus[] } }
      });
      if (activeAssignment) {
        logger.warn(`⚠️ Driver ${driver.name} already has active trip: ${activeAssignment.tripId}`);
        throw new AppError(400, 'DRIVER_BUSY',
          `Driver ${driver.name} already has an active trip. Please assign a different driver.`);
      }
      // CRITICAL: use tx (transaction context) not db (global client) so the
      // Serializable isolation actually prevents concurrent duplicate assignments.
      await tx.assignment.create({ data: assignment as Prisma.AssignmentUncheckedCreateInput });

      // =====================================================================
      // FIX: Set vehicle to on_hold ATOMICALLY with assignment creation
      // =====================================================================
      // BEFORE: Vehicle stayed 'available' during pending phase → could be
      //   double-booked by another assignment request.
      // NOW: Vehicle becomes 'on_hold' inside same transaction → if assignment
      //   creation fails, vehicle status rolls back too.
      // =====================================================================
      await tx.vehicle.updateMany({
        where: {
          id: data.vehicleId,
          status: { in: ['available'] as VehicleStatus[] }  // Only hold if currently available
        },
        data: {
          status: 'on_hold',
          currentTripId: tripId,
          assignedDriverId: data.driverId,
          lastStatusChange: new Date().toISOString()
        }
      });

      // H-10 FIX: Increment trucksFilled INSIDE the transaction so the count
      // rolls back if any subsequent step fails. Uses raw SQL to avoid circular
      // dependency on bookingService while staying within the TX boundary.
      if (data.bookingId) {
        await tx.$queryRaw`
          UPDATE "Booking"
          SET "trucksFilled" = "trucksFilled" + 1,
              "stateChangedAt" = NOW()
          WHERE id = ${data.bookingId}
            AND "trucksFilled" < "trucksNeeded"
        `;
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeoutMs: 8000 });

    // =========================================================================
    // START ASSIGNMENT TIMEOUT TIMER (In-process self-destruct)
    // =========================================================================
    // SCALABILITY: setTimeout fires at ASSIGNMENT_TIMEOUT_MS (default 30s) — zero polling
    // EASY UNDERSTANDING: Driver has 30s to accept/decline, then auto-expires
    // SAFETY: If driver accepts before timeout, timer fires but no-ops (idempotent)
    // =========================================================================
    const timerData: AssignmentTimerData = {
      assignmentId: assignment.id,
      driverId: data.driverId,
      driverName: driver.name,
      transporterId,
      vehicleId: data.vehicleId,
      vehicleNumber: vehicle.vehicleNumber,
      bookingId: data.bookingId,
      tripId,
      createdAt: new Date().toISOString()
    };

    try {
      await queueService.scheduleAssignmentTimeout(timerData, ASSIGNMENT_CONFIG.TIMEOUT_MS);
      logger.info(`⏱️ Assignment timeout started: ${assignment.id} (${ASSIGNMENT_CONFIG.TIMEOUT_MS / 1000}s)`);
    } catch (timeoutErr) {
      logger.error('[CRITICAL] Failed to schedule assignment timeout — manual intervention needed', {
        assignmentId: assignment.id,
        error: timeoutErr instanceof Error ? timeoutErr.message : String(timeoutErr)
      });
    }

    // H-10: incrementTrucksFilled now happens inside the transaction above (raw SQL).
    // The external bookingService.incrementTrucksFilled call has been removed to
    // prevent the count from persisting when the transaction rolls back.

    // Notify customer
    emitToBooking(data.bookingId, SocketEvent.TRUCK_ASSIGNED, {
      bookingId: data.bookingId,
      assignment: {
        id: assignment.id,
        vehicleNumber: assignment.vehicleNumber,
        driverName: assignment.driverName,
        status: assignment.status
      }
    });

    // Notify driver — C-07 fix: use TRIP_ASSIGNED so Captain app shows trip overlay
    // (matches assignment.service.ts:310 and socket.service.ts:741 reconnect path)
    emitToUser(data.driverId, SocketEvent.TRIP_ASSIGNED, {
      assignmentId: assignment.id,
      tripId,
      bookingId: data.bookingId,
      status: 'pending',
      message: 'New trip assigned to you'
    });

    // =====================================================================
    // FCM PUSH BACKUP — same pattern as truck-hold.service.ts:1393-1405
    // Industry (Uber CCG): Every critical notification via Socket + FCM
    // for at-least-once delivery. Dedup handled by SocketIOService.kt
    // seenBroadcastIds LRU cache (2048 entries).
    // =====================================================================
    queueService.queuePushNotification(data.driverId, {
      title: '🚛 New Trip Assigned!',
      body: `Trip for ${vehicle.vehicleNumber}. Accept within ${ASSIGNMENT_CONFIG.TIMEOUT_MS / 1000} seconds.`,
      data: {
        type: 'trip_assigned',
        assignmentId: assignment.id,
        tripId,
        bookingId: data.bookingId,
        vehicleNumber: vehicle.vehicleNumber
      }
    }).catch(err => {
      logger.warn(`FCM: Failed to queue assignment push for driver ${data.driverId}`, err);
    });

    logger.info(`Assignment created: ${assignment.id} for booking ${data.bookingId} (Socket + FCM)`);
    return assignment;
  }
}

export const assignmentDispatchService = new AssignmentDispatchService();
