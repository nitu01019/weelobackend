/**
 * =============================================================================
 * ASSIGNMENT MODULE - SERVICE
 * =============================================================================
 * 
 * Business logic for truck assignments.
 * Transporters assign their trucks to customer bookings.
 * =============================================================================
 */

import { v4 as uuid } from 'uuid';
import { Prisma } from '@prisma/client';
import { db, AssignmentRecord } from '../../shared/database/db';
import { prismaClient, withDbTimeout } from '../../shared/database/prisma.service';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, emitToBooking, SocketEvent } from '../../shared/services/socket.service';
import { queueService } from '../../shared/services/queue.service';
import { redisService } from '../../shared/services/redis.service';
import { bookingService } from '../booking/booking.service';
import { trackingService } from '../tracking/tracking.service';
import { CreateAssignmentInput, UpdateStatusInput, GetAssignmentsQuery } from './assignment.schema';

// =============================================================================
// ASSIGNMENT TIMEOUT — Queue-based (replaces setInterval polling)
// =============================================================================
// 
// BEFORE: setInterval(5000ms) on EVERY ECS instance → Redis SCAN for expired keys
//   → 50 instances × SCAN every 5s = 600 Redis ops/minute even at 3am
//
// NOW: Queue delayed job fires exactly at 60s → ONE worker processes it
//   → Zero polling, zero wasted CPU, sub-second accuracy
//
// Processor registered in: queue.service.ts → registerDefaultProcessors()
// =============================================================================

const ASSIGNMENT_CONFIG = {
  /** How long driver has to respond (60 seconds) */
  TIMEOUT_MS: 60 * 1000,
};

/** Timer data — used by both queue processor and createAssignment */
interface AssignmentTimerData {
  assignmentId: string;
  driverId: string;
  driverName: string;
  transporterId: string;
  vehicleId: string;
  vehicleNumber: string;
  bookingId: string;
  tripId: string;
  createdAt: string;
}

// =============================================================================
// ASSIGNMENT SERVICE
// =============================================================================

class AssignmentService {

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

    // Verify vehicle type matches booking
    if (vehicle.vehicleType !== booking.vehicleType) {
      throw new AppError(400, 'VEHICLE_MISMATCH',
        `Booking requires ${booking.vehicleType}, but vehicle is ${vehicle.vehicleType}`);
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
        where: { driverId: data.driverId, status: { in: activeStatuses as any } }
      });
      if (activeAssignment) {
        logger.warn(`⚠️ Driver ${driver.name} already has active trip: ${activeAssignment.tripId}`);
        throw new AppError(400, 'DRIVER_BUSY',
          `Driver ${driver.name} already has an active trip. Please assign a different driver.`);
      }
      // CRITICAL: use tx (transaction context) not db (global client) so the
      // Serializable isolation actually prevents concurrent duplicate assignments.
      await tx.assignment.create({ data: assignment as any });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeoutMs: 8000 });

    // =========================================================================
    // START 60-SECOND TIMEOUT TIMER (Queue-based delayed job)
    // =========================================================================
    // SCALABILITY: Queue job fires exactly at 60s — zero polling, one worker
    // EASY UNDERSTANDING: Driver has 60s to accept/decline, then auto-expires
    // SAFETY: If driver accepts before 60s, job fires but no-ops (idempotent)
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

    await queueService.scheduleAssignmentTimeout(timerData, ASSIGNMENT_CONFIG.TIMEOUT_MS);
    logger.info(`⏱️ Assignment timeout started: ${assignment.id} (${ASSIGNMENT_CONFIG.TIMEOUT_MS / 1000}s)`);

    // Update booking trucks filled
    await bookingService.incrementTrucksFilled(data.bookingId);

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

    // Notify driver
    emitToUser(data.driverId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
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
      body: `Trip for ${vehicle.vehicleNumber}. Accept within 60 seconds.`,
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

  // ==========================================================================
  // GET ASSIGNMENTS
  // ==========================================================================

  async getAssignments(
    userId: string,
    userRole: string,
    query: GetAssignmentsQuery
  ): Promise<{ assignments: AssignmentRecord[]; total: number; hasMore: boolean }> {
    let assignments: AssignmentRecord[];

    if (userRole === 'transporter') {
      assignments = await db.getAssignmentsByTransporter(userId);
    } else if (userRole === 'customer') {
      // Get customer's bookings, then get assignments for those
      const bookings = await db.getBookingsByCustomer(userId);
      const bookingIds = bookings.map(b => b.id);
      assignments = [];
      for (const bookingId of bookingIds) {
        const bookingAssignments = await db.getAssignmentsByBooking(bookingId);
        assignments.push(...bookingAssignments);
      }
    } else {
      assignments = [];
    }

    // Filter by status
    if (query.status) {
      assignments = assignments.filter(a => a.status === query.status);
    }

    // Filter by booking
    if (query.bookingId) {
      assignments = assignments.filter(a => a.bookingId === query.bookingId);
    }

    const total = assignments.length;

    // Pagination
    const start = (query.page - 1) * query.limit;
    assignments = assignments.slice(start, start + query.limit);
    const hasMore = start + assignments.length < total;

    return { assignments, total, hasMore };
  }

  async getDriverAssignments(
    driverId: string,
    query: GetAssignmentsQuery
  ): Promise<{ assignments: AssignmentRecord[]; total: number; hasMore: boolean }> {
    let assignments = await db.getAssignmentsByDriver(driverId);

    // Filter by status
    if (query.status) {
      assignments = assignments.filter(a => a.status === query.status);
    }

    const total = assignments.length;

    // Pagination
    const start = (query.page - 1) * query.limit;
    assignments = assignments.slice(start, start + query.limit);
    const hasMore = start + assignments.length < total;

    return { assignments, total, hasMore };
  }

  async getAssignmentById(
    assignmentId: string,
    userId: string,
    userRole: string
  ): Promise<AssignmentRecord> {
    const assignment = await db.getAssignmentById(assignmentId);

    if (!assignment) {
      throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found');
    }

    // Access control
    if (userRole === 'driver' && assignment.driverId !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied');
    }
    if (userRole === 'transporter' && assignment.transporterId !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied');
    }

    return assignment;
  }

  // ==========================================================================
  // UPDATE STATUS
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
      (error as any).currentStatus = assignment.status;
      throw error;
    }

    // =================================================================
    // RULE: ONE ACTIVE TRIP PER DRIVER (Double-check at accept time)
    // Even if assignment was created, driver might have accepted another
    // trip in the meantime. This is the final safety check.
    // =================================================================
    const activeAssignment = await db.getActiveAssignmentByDriver(driverId);
    if (activeAssignment && activeAssignment.id !== assignmentId) {
      logger.warn(`⚠️ Driver ${driverId} tried to accept ${assignmentId} but already has active trip: ${activeAssignment.tripId}`);
      throw new AppError(400, 'DRIVER_BUSY',
        'You already have an active trip. Complete or cancel it before accepting a new one.');
    }

    // Queue job is idempotent: handleAssignmentTimeout() uses updateMany({ where: { status: 'pending' }})
    // so if driver accepted first, the queue job no-ops when it fires at 60s.
    // No explicit cancellation needed.

    const updated = await db.updateAssignment(assignmentId, {
      status: 'driver_accepted',
      driverAcceptedAt: new Date().toISOString()
    });

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
      const driverLocation = await redisService.getJSON<{ latitude: number; longitude: number }>(driverLocationKey);
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
      if (driverLocation?.latitude && driverLocation?.longitude) {
        const tripKey = `driver:trip:${assignment.tripId}`;
        const tripData = await redisService.getJSON<any>(tripKey);
        if (tripData) {
          tripData.latitude = driverLocation.latitude;
          tripData.longitude = driverLocation.longitude;
          tripData.status = 'driver_accepted';
          await redisService.setJSON(tripKey, tripData, 86400);
        }
      }
    } catch (err: any) {
      // Non-fatal — tracking will initialize on first GPS update anyway
      logger.warn(`[ASSIGNMENT] Failed to seed tracking at acceptance (non-fatal)`, {
        tripId: assignment.tripId, error: err?.message
      });
    }

    // Notify booking room
    emitToBooking(assignment.bookingId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
      assignmentId,
      tripId: assignment.tripId,
      status: 'driver_accepted',
      vehicleNumber: assignment.vehicleNumber
    });

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
    const booking = await db.getBookingById(assignment.bookingId);
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
      queueService.queuePushNotification(booking.customerId, {
        title: '🚛 Driver on the way!',
        body: `${assignment.driverName} accepted. Vehicle: ${assignment.vehicleNumber}`,
        data: {
          type: 'driver_accepted',
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

    logger.info(`Assignment accepted: ${assignmentId} by driver ${driverId}`);
    return updated!;
  }

  // Valid assignment status transitions (prevents backward/invalid moves)
  private static readonly VALID_TRANSITIONS: Record<string, string[]> = {
    pending: ['driver_accepted', 'driver_declined', 'cancelled'],
    driver_accepted: ['en_route_pickup', 'cancelled'],
    en_route_pickup: ['at_pickup', 'cancelled'],
    at_pickup: ['in_transit', 'cancelled'],
    in_transit: ['arrived_at_drop', 'completed', 'cancelled'],
    arrived_at_drop: ['completed', 'cancelled'],
    completed: [],
    driver_declined: [],
    cancelled: [],
  };

  async updateStatus(
    assignmentId: string,
    driverId: string,
    data: UpdateStatusInput
  ): Promise<AssignmentRecord> {
    const assignment = await db.getAssignmentById(assignmentId);

    if (!assignment) {
      throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found');
    }

    if (assignment.driverId !== driverId) {
      throw new AppError(403, 'FORBIDDEN', 'This assignment is not for you');
    }

    // Validate status transition
    const allowedNext = AssignmentService.VALID_TRANSITIONS[assignment.status] ?? [];
    if (!allowedNext.includes(data.status)) {
      throw new AppError(400, 'INVALID_TRANSITION',
        `Cannot transition assignment from '${assignment.status}' to '${data.status}'`);
    }

    const updates: Partial<AssignmentRecord> = {
      status: data.status as any
    };

    if (data.status === 'in_transit') {
      updates.startedAt = new Date().toISOString();
    }

    if (data.status === 'completed') {
      updates.completedAt = new Date().toISOString();
    }

    const updated = await db.updateAssignment(assignmentId, updates);

    // Notify booking room
    emitToBooking(assignment.bookingId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
      assignmentId,
      tripId: assignment.tripId,
      status: data.status,
      vehicleNumber: assignment.vehicleNumber
    });

    logger.info(`Assignment status updated: ${assignmentId} -> ${data.status}`);
    return updated!;
  }

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

    // Queue job is idempotent: if assignment is cancelled, handleAssignmentTimeout() no-ops.

    await db.updateAssignment(assignmentId, { status: 'cancelled' });

    // Decrement trucks filled
    await bookingService.decrementTrucksFilled(assignment.bookingId);

    // Release vehicle back to available
    if (assignment.vehicleId) {
      await db.updateVehicle(assignment.vehicleId, {
        status: 'available',
        currentTripId: undefined,
        assignedDriverId: undefined,
        lastStatusChange: new Date().toISOString()
      });
    }

    // Notify booking room
    emitToBooking(assignment.bookingId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
      assignmentId,
      tripId: assignment.tripId,
      status: 'cancelled',
      vehicleNumber: assignment.vehicleNumber
    });

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

    // Queue job fires at 60s but handleAssignmentTimeout() no-ops if assignment is no longer pending.
    // No explicit cancellation needed.

    // 2. Update status to driver_declined
    await db.updateAssignment(assignmentId, { status: 'driver_declined' });

    // 3. Release vehicle back to available
    if (assignment.vehicleId) {
      await db.updateVehicle(assignment.vehicleId, {
        status: 'available',
        currentTripId: undefined,
        assignedDriverId: undefined,
        lastStatusChange: new Date().toISOString()
      });
    }

    // 4. Decrement trucks filled
    await bookingService.decrementTrucksFilled(assignment.bookingId);

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
    emitToBooking(assignment.bookingId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
      assignmentId,
      tripId: assignment.tripId,
      status: 'driver_declined',
      vehicleNumber: assignment.vehicleNumber
    });

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
  // HANDLE ASSIGNMENT TIMEOUT (Driver didn't respond in 60s)
  // ==========================================================================
  // 
  // Called by the queue processor in queue.service.ts when the delayed job fires.
  // Safe to call even if driver already accepted/declined — updateMany no-ops.
  // 
  // SCALABILITY: Distributed lock in queue processor prevents duplicate handling
  // EASY UNDERSTANDING: No response in 60s → same as decline + timeout reason
  // MODULARITY: Uses same vehicle release + notification pattern as decline
  // ==========================================================================

  async handleAssignmentTimeout(timerData: AssignmentTimerData): Promise<void> {
    const { assignmentId, driverId, driverName, transporterId, vehicleId, vehicleNumber, bookingId, tripId } = timerData;

    logger.info(`⏰ TIMEOUT: Assignment ${assignmentId} — driver ${driverName} didn't respond`);

    // 1. Atomic status update with precondition — prevents race with concurrent accept/decline
    // If driver accepted concurrently, this no-ops (count === 0) and we skip gracefully
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

    // Fetch assignment for notification data
    const assignment = await db.getAssignmentById(assignmentId);
    if (!assignment) {
      logger.warn(`Assignment ${assignmentId} not found after timeout update`);
      return;
    }

    // 2. Release vehicle back to available
    if (vehicleId) {
      await db.updateVehicle(vehicleId, {
        status: 'available',
        currentTripId: undefined,
        assignedDriverId: undefined,
        lastStatusChange: new Date().toISOString()
      });
    }

    // 3. Decrement trucks filled
    await bookingService.decrementTrucksFilled(bookingId);

    // 4. Notify transporter: driver timed out (WebSocket)
    emitToUser(transporterId, SocketEvent.DRIVER_TIMEOUT, {
      assignmentId,
      tripId,
      driverId,
      driverName,
      vehicleNumber,
      vehicleId,
      reason: 'timeout',
      message: `${driverName} didn't respond in ${ASSIGNMENT_CONFIG.TIMEOUT_MS / 1000} seconds`
    });

    // 5. Notify driver: assignment expired (WebSocket)
    // Use 'driver_declined' to match the DB status; include reason:'timeout' so
    // the driver app can show a user-friendly "expired" message without a schema mismatch.
    emitToUser(driverId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
      assignmentId,
      tripId,
      status: 'driver_declined',
      reason: 'timeout',
      message: 'Trip assignment expired — you didn\'t respond in time'
    });

    // 6. Notify booking room
    emitToBooking(bookingId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
      assignmentId,
      tripId,
      status: 'driver_declined',
      vehicleNumber,
      reason: 'timeout'
    });

    // 7. FCM push to transporter (background notification)
    queueService.queuePushNotification(transporterId, {
      title: '⏰ Driver Didn\'t Respond',
      body: `${driverName} didn't respond in time (${vehicleNumber}). Reassign?`,
      data: {
        type: 'driver_timeout',
        assignmentId,
        tripId,
        vehicleId,
        driverName,
        status: 'timed_out'
      }
    }).catch(err => {
      logger.warn(`FCM: Failed to notify transporter of timeout`, err);
    });

    // 8. FCM push to driver (let them know they missed it)
    queueService.queuePushNotification(driverId, {
      title: '⏰ Trip Assignment Expired',
      body: `You didn't respond in time. The trip has been reassigned.`,
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

export const assignmentService = new AssignmentService();
