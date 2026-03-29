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
import { liveAvailabilityService } from '../../shared/services/live-availability.service';
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
  /** How long driver has to respond. Default 30s (industry standard: Uber/Ola/Porter) */
  TIMEOUT_MS: parseInt(process.env.ASSIGNMENT_TIMEOUT_MS || '30000', 10),
};

/** Timer data — used by both queue processor and createAssignment */
interface AssignmentTimerData {
  assignmentId: string;
  driverId: string;
  driverName: string;
  transporterId: string;
  vehicleId: string;
  vehicleNumber: string;
  bookingId?: string;  // Optional for multi-truck system (uses orderId instead)
  tripId: string;
  createdAt: string;
  orderId?: string;      // Optional for multi-truck system
  truckRequestId?: string; // Optional for multi-truck system
}

// =============================================================================
// ASSIGNMENT SERVICE
// =============================================================================

class AssignmentService {
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

  private async releaseVehicleIfBusy(
    vehicleId: string | undefined,
    transporterId: string | undefined,
    contextLabel: string
  ): Promise<void> {
    if (!vehicleId) return;

    const vehicle = await prismaClient.vehicle.findUnique({
      where: { id: vehicleId },
      select: { vehicleKey: true, transporterId: true, status: true }
    });

    await db.updateVehicle(vehicleId, {
      status: 'available',
      currentTripId: undefined,
      assignedDriverId: undefined,
      lastStatusChange: new Date().toISOString()
    });

    if (vehicle?.vehicleKey && transporterId && vehicle.status !== 'available') {
      await liveAvailabilityService.onVehicleStatusChange(
        transporterId,
        vehicle.vehicleKey,
        vehicle.status,
        'available'
      ).catch(err => logger.warn(`[${contextLabel}] Redis update failed`, err));
    }
  }

  private async restoreOrderTruckRequest(
    assignment: Pick<AssignmentRecord, 'orderId' | 'truckRequestId'>
  ): Promise<void> {
    if (!assignment.orderId || !assignment.truckRequestId) return;

    await prismaClient.truckRequest.updateMany({
      where: { id: assignment.truckRequestId, orderId: assignment.orderId },
      data: {
        status: 'held',
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
          status: { in: ['available'] as any }  // Only hold if currently available
        },
        data: {
          status: 'on_hold',
          currentTripId: tripId,
          assignedDriverId: data.driverId,
          lastStatusChange: new Date().toISOString()
        }
      });
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

  // ==========================================================================
  // GET ASSIGNMENTS
  // ==========================================================================

  async getAssignments(
    userId: string,
    userRole: string,
    query: GetAssignmentsQuery
  ): Promise<{ assignments: AssignmentRecord[]; total: number; hasMore: boolean }> {
    let assignments: AssignmentRecord[];

    // PRESERVING WORKING CODE: Use existing db methods that return AssignmentRecord[]
    if (userRole === 'transporter') {
      assignments = await db.getAssignmentsByTransporter(userId);
    } else if (userRole === 'customer') {
      // SAFE FIX: Replace N+1 loop with single Prisma query with relation
      // Get customer's bookings IDs once
      const bookings = await db.getBookingsByCustomer(userId);
      const bookingIds = bookings.map(b => b.id);

      if (bookingIds.length === 0) {
        return { assignments: [], total: 0, hasMore: false };
      }

      // Industry Standard: Netflix WHERE IN pattern - single query instead of N queries
      // 50 bookings = 1 query (was: 1 + 50 queries)
      const rawAssignments = await prismaClient.assignment.findMany({
        where: { bookingId: { in: bookingIds } },
        orderBy: { assignedAt: 'desc' }
      });

      // Convert Prisma result to AssignmentRecord format using existing helper
      assignments = rawAssignments.map(a => ({
        id: a.id,
        bookingId: a.bookingId || '',
        truckRequestId: a.truckRequestId || '',
        orderId: a.orderId || '',
        transporterId: a.transporterId,
        transporterName: '', // Not selected in WHERE IN - would need JOIN
        vehicleId: a.vehicleId,
        vehicleNumber: a.vehicleNumber,
        vehicleType: a.vehicleType,
        vehicleSubtype: a.vehicleSubtype,
        driverId: a.driverId,
        driverName: a.driverName || '',
        driverPhone: '',
        tripId: a.tripId,
        assignedAt: a.assignedAt || '', // Already string in DB
        driverAcceptedAt: a.driverAcceptedAt || '', // Already string
        status: a.status as any,
        startedAt: (a as any).startedAt || '',
        completedAt: (a as any).completedAt || ''
      } as AssignmentRecord)); // Fix: Double closing brace for map function
    } else {
      assignments = [];
    }

    // Filter by status (keeping existing pattern to preserve behavior)
    if (query.status) {
      assignments = assignments.filter(a => a.status === query.status);
    }

    // Filter by booking (keeping existing pattern)
    if (query.bookingId) {
      assignments = assignments.filter(a => a.bookingId === query.bookingId);
    }

    const total = assignments.length;

    // Pagination (keeping existing pattern)
    const start = (query.page - 1) * query.limit;
    assignments = assignments.slice(start, start + query.limit);
    const hasMore = start + assignments.length < total;

    return { assignments, total, hasMore };
  }

  async getDriverAssignments(
    driverId: string,
    query: GetAssignmentsQuery
  ): Promise<{ assignments: AssignmentRecord[]; total: number; hasMore: boolean }> {
    // PRESERVING WORKING CODE: Use existing db method
    let assignments = await db.getAssignmentsByDriver(driverId);

    // Filter by status (keeping existing working pattern)
    if (query.status) {
      assignments = assignments.filter(a => a.status === query.status);
    }

    const total = assignments.length;

    // Pagination (keeping existing working pattern)
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
            status: { in: ['on_hold', 'available'] as any }  // Accept from on_hold (normal) or available (legacy)
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
        }
        logger.info(`[ASSIGNMENT] Vehicle set to in_transit: ${assignment.vehicleNumber} (driver accepted)`);
      } catch (err: any) {
        logger.error('[ASSIGNMENT] Failed to update Redis vehicle status', {
          vehicleId: assignment.vehicleId,
          assignmentId,
          error: err?.message
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
          const tripData = await redisService.getJSON<any>(tripKey);
          if (tripData) {
            tripData.latitude = driverLocation.latitude;
            tripData.longitude = driverLocation.longitude;
            tripData.status = 'driver_accepted';
            await redisService.setJSON(tripKey, tripData, 86400);
          }
        }
      }
    } catch (err: any) {
      // Non-fatal — tracking will initialize on first GPS update anyway
      logger.warn(`[ASSIGNMENT] Failed to seed tracking at acceptance (non-fatal)`, {
        tripId: assignment.tripId, error: err?.message
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
    const updateStreamId = this.resolveAssignmentStreamId(assignment);
    if (updateStreamId) {
      emitToBooking(updateStreamId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
        assignmentId,
        tripId: assignment.tripId,
        status: data.status,
        vehicleNumber: assignment.vehicleNumber
      });
    }

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
    if (assignment.bookingId) {
      await bookingService.decrementTrucksFilled(assignment.bookingId);
    } else if (assignment.orderId) {
      await prismaClient.order.update({
        where: { id: assignment.orderId },
        data: { trucksFilled: { decrement: 1 } }
      });
      await this.restoreOrderTruckRequest(assignment);
    }

    // Release vehicle back to available
    await this.releaseVehicleIfBusy(
      assignment.vehicleId,
      assignment.transporterId,
      'cancelAssignment'
    );

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

    // Queue job fires at 60s but handleAssignmentTimeout() no-ops if assignment is no longer pending.
    // No explicit cancellation needed.

    // 2. Update status to driver_declined
    await db.updateAssignment(assignmentId, { status: 'driver_declined' });
    await this.persistAssignmentReason(assignmentId, 'declined');

    // 3. Release vehicle back to available
    await this.releaseVehicleIfBusy(
      assignment.vehicleId,
      assignment.transporterId,
      'declineAssignment'
    );

    // 4. Decrement trucks filled
    if (assignment.bookingId) {
      await bookingService.decrementTrucksFilled(assignment.bookingId);
    } else if (assignment.orderId) {
      await prismaClient.order.update({
        where: { id: assignment.orderId },
        data: { trucksFilled: { decrement: 1 } }
      });
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
    const { assignmentId, driverId, driverName, transporterId, vehicleId, vehicleNumber, bookingId, tripId, orderId, truckRequestId } = timerData;

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
    await this.persistAssignmentReason(assignmentId, 'timeout');

    // Fetch assignment for notification data
    const assignment = await db.getAssignmentById(assignmentId);
    if (!assignment) {
      logger.warn(`Assignment ${assignmentId} not found after timeout update`);
      return;
    }

    // 2. Release vehicle back to available
    await this.releaseVehicleIfBusy(vehicleId, transporterId, 'timeout');

    // 3. Decrement trucks filled
    // For multi-truck system: use orderId instead of bookingId
    if (bookingId) {
      await bookingService.decrementTrucksFilled(bookingId);
    } else if (orderId) {
      // Multi-truck system: decrement trucksFilled on Order
      await prismaClient.order.update({
        where: { id: orderId },
        data: { trucksFilled: { decrement: 1 } }
      });
      // Also update TruckRequest status back to held
      await this.restoreOrderTruckRequest({ orderId, truckRequestId });
    }

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
    const timeoutStreamId = bookingId || orderId;
    if (timeoutStreamId) {
      emitToBooking(timeoutStreamId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
        assignmentId,
        tripId,
        status: 'driver_declined',
        vehicleNumber,
        reason: 'timeout'
      });
    }

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
