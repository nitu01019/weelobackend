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
// Fix H-A1: Lazy require() to break inverted dependency (assignment→booking circular)
// bookingService is imported at call sites via require() to avoid module load cycle.
import { trackingService } from '../tracking/tracking.service';
import { CreateAssignmentInput, UpdateStatusInput, GetAssignmentsQuery } from './assignment.schema';
import { HOLD_CONFIG } from '../../core/config/hold-config';
import { enqueueCompletionLifecycleOutbox } from '../order/order-lifecycle-outbox.service';
import type { TripCompletedOutboxPayload } from '../order/order-types';
import { tryAutoRedispatch } from './auto-redispatch.service';

// =============================================================================
// ASSIGNMENT TIMEOUT — Queue-based (replaces setInterval polling)
// =============================================================================
//
// BEFORE: setInterval(5000ms) on EVERY ECS instance → Redis SCAN for expired keys
//   → 50 instances × SCAN every 5s = 600 Redis ops/minute even at 3am
//
// NOW: In-process setTimeout fires at HOLD_CONFIG.driverAcceptTimeoutMs
//   → Zero polling, zero wasted CPU, sub-second accuracy
//
// Processor registered in: queue.service.ts → registerDefaultProcessors()
// =============================================================================

const ASSIGNMENT_CONFIG = {
  /** How long driver has to respond. Fix H-X1: centralized via HOLD_CONFIG */
  TIMEOUT_MS: HOLD_CONFIG.driverAcceptTimeoutMs,
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

    const vehicle = await prismaClient.vehicle.findUnique({
      where: { id: vehicleId },
      select: { vehicleKey: true, transporterId: true, status: true }
    });

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
        // H10 FIX: Restore to 'searching' not 'held' (no holdOwnerId = ghost hold)
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

    // Update booking trucks filled (Fix H-A1: lazy require to break circular dep)
    if (data.bookingId) {
      const { bookingService }: typeof import('../booking/booking.service') = require('../booking/booking.service');
      await bookingService.incrementTrucksFilled(data.bookingId);
    }

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
        vehicleNumber: vehicle.vehicleNumber,
        driverName: assignment.driverName || '',
        vehicleType: vehicle.vehicleType || '',
        status: 'trip_assigned'
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

      // Build where clause for optional status/booking filters
      const where: Record<string, unknown> = { bookingId: { in: bookingIds } };
      if (query.status) {
        where.status = query.status;
      }
      if (query.bookingId) {
        where.bookingId = query.bookingId;
      }

      // DB-level pagination: count + paginated fetch in parallel
      const skip = (query.page - 1) * query.limit;
      const [total, rawAssignments] = await Promise.all([
        prismaClient.assignment.count({ where }),
        prismaClient.assignment.findMany({
          where,
          orderBy: { assignedAt: 'desc' },
          skip,
          take: query.limit
        })
      ]);

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
      } as AssignmentRecord));

      const hasMore = skip + assignments.length < total;
      return { assignments, total, hasMore };
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
    // BUG-M5 FIX: For customers, include booking/order relations so that
    // (a) access control can check customerId, and (b) response contains
    // booking/order details. Without include, assignment.booking and
    // assignment.order are always undefined, causing a 403 for every customer.
    if (userRole === 'customer') {
      const raw = await prismaClient.assignment.findUnique({
        where: { id: assignmentId },
        include: {
          booking: { select: { id: true, customerId: true } },
          order: { select: { id: true, customerId: true } }
        }
      });

      if (!raw) {
        throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found');
      }

      const isOwner = raw.booking?.customerId === userId || raw.order?.customerId === userId;
      if (!isOwner) {
        throw new AppError(403, 'FORBIDDEN', 'You do not have access to this assignment');
      }

      // Return as AssignmentRecord (same shape other callers expect)
      const assignment: AssignmentRecord = {
        id: raw.id,
        bookingId: raw.bookingId || '',
        truckRequestId: raw.truckRequestId || '',
        orderId: raw.orderId || '',
        transporterId: raw.transporterId,
        transporterName: raw.transporterName || '',
        vehicleId: raw.vehicleId,
        vehicleNumber: raw.vehicleNumber,
        vehicleType: raw.vehicleType,
        vehicleSubtype: raw.vehicleSubtype,
        driverId: raw.driverId,
        driverName: raw.driverName || '',
        driverPhone: '',
        tripId: raw.tripId,
        status: raw.status as AssignmentRecord['status'],
        assignedAt: raw.assignedAt || '',
        driverAcceptedAt: raw.driverAcceptedAt || '',
        startedAt: (raw as any).startedAt || '',
        completedAt: (raw as any).completedAt || ''
      };

      return assignment;
    }

    // Driver / transporter path: bare lookup (no relations needed)
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
    // H9 FIX: Direct DB query for safety-critical double-assignment check
    // (15s cache was allowing stale reads that could permit double-assignment)
    const activeAssignment = await db.getActiveAssignmentByDriver(driverId);
    if (activeAssignment && activeAssignment.id !== assignmentId) {
      logger.warn(`⚠️ Driver ${driverId} tried to accept ${assignmentId} but already has active trip: ${activeAssignment.tripId}`);
      throw new AppError(400, 'DRIVER_BUSY',
        'You already have an active trip. Complete or cancel it before accepting a new one.');
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

    // Problem 16 fix: Cancel Redis-backed assignment timeout (driver accepted)
    queueService.cancelAssignmentTimeout(assignmentId).catch((cancelErr: any) => {
      logger.warn(`[acceptAssignment] Failed to cancel timeout timer: ${cancelErr?.message}`);
    });

    // =====================================================================
    // FIX C-11: Redis-based idempotency guard — prevents double side effects
    // on mobile retries. CAS guard protects DB, this protects everything after.
    // Pattern: assignment-response.service.ts:156
    // =====================================================================
    const sideEffectKey = `side-effect:accept:${assignmentId}`;
    const sideEffectLock = await redisService.acquireLock(sideEffectKey, 'accept-guard', 300);
    if (!sideEffectLock.acquired) {
      logger.info(`[ASSIGNMENT] Skipping duplicate side effects for ${assignmentId}`);
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
    } else if (assignment.orderId) {
      // H2 FIX: Multi-truck order path — customer notification was missing
      const order = await prismaClient.order.findUnique({
        where: { id: assignment.orderId },
        select: { customerId: true }
      });
      if (order?.customerId) {
        emitToUser(order.customerId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
          assignmentId,
          tripId: assignment.tripId,
          orderId: assignment.orderId,
          status: 'driver_accepted',
          driverName: assignment.driverName,
          vehicleNumber: assignment.vehicleNumber,
          message: `${assignment.driverName} accepted. Vehicle: ${assignment.vehicleNumber}`
        });

        // H2 FIX: FCM push to customer (order path — was missing)
        queueService.queuePushNotification(order.customerId, {
          title: 'Driver on the way!',
          body: `${assignment.driverName} accepted. Vehicle: ${assignment.vehicleNumber}`,
          data: {
            type: 'driver_assigned',
            assignmentId,
            tripId: assignment.tripId,
            orderId: assignment.orderId,
            driverName: assignment.driverName || '',
            vehicleNumber: assignment.vehicleNumber || '',
            status: 'driver_accepted'
          }
        }).catch(err => {
          logger.warn(`FCM: Failed to notify customer of driver acceptance (order path)`, err);
        });
      }
    }

    } // end FIX C-11 side-effect idempotency guard

    logger.info(`Assignment accepted: ${assignmentId} by driver ${driverId}`);

    // Invalidate negative cache — driver now has an active assignment
    await redisService.del(`driver:active-assignment:${driverId}`).catch(() => {});

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

    // Log notes and location for audit (Assignment table lacks these columns)
    if (data.notes || data.location) {
      logger.info(`[ASSIGNMENT] Status update metadata`, {
        assignmentId,
        status: data.status,
        notes: data.notes,
        location: data.location
      });
    }

    if (data.status === 'in_transit') {
      updates.startedAt = new Date().toISOString();
    }

    if (data.status === 'completed') {
      updates.completedAt = new Date().toISOString();
    }

    // =====================================================================
    // FIX C-12 + C-15: Atomic transaction for completion (status + vehicle)
    // =====================================================================
    // BEFORE: db.updateAssignment() then separate releaseVehicle() — crash
    //   between the two leaves vehicle stuck in_transit with completed assignment.
    // NOW: Single $transaction() for the completed path, matching the pattern
    //   already used by cancelAssignment() (~line 1008) and declineAssignment()
    //   (~line 1162) in this same file.
    // Non-completed transitions keep using db.updateAssignment() (no vehicle
    //   release needed, so no atomicity concern).
    // =====================================================================
    let updated: AssignmentRecord;
    if (data.status === 'completed') {
      // Read actual vehicle status before transaction for Redis sync
      let actualVehicleStatus = 'in_transit';
      if (assignment.vehicleId) {
        const veh = await prismaClient.vehicle.findUnique({
          where: { id: assignment.vehicleId },
          select: { status: true }
        });
        if (veh?.status) actualVehicleStatus = veh.status;
      }

      await prismaClient.$transaction(async (tx) => {
        await tx.assignment.update({
          where: { id: assignmentId },
          data: {
            status: 'completed',
            completedAt: updates.completedAt
          }
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

      // Post-transaction: Redis sync (non-fatal, same pattern as cancel/decline)
      if (assignment.vehicleId) {
        const vehicle = await prismaClient.vehicle.findUnique({
          where: { id: assignment.vehicleId },
          select: { vehicleKey: true, transporterId: true }
        });
        if (vehicle?.vehicleKey && assignment.transporterId) {
          liveAvailabilityService.onVehicleStatusChange(
            assignment.transporterId, vehicle.vehicleKey, actualVehicleStatus, 'available'
          ).catch(err => logger.warn('[updateStatus:completed] Redis sync failed', err));
        }
      }
      logger.info(`[ASSIGNMENT] Vehicle released on trip completion: ${assignment.vehicleNumber}`);

      // =====================================================================
      // FIX C-18: Write trip_completed outbox row (payment trigger)
      // =====================================================================
      // Pattern: Transactional outbox (Uber/Spotify standard).
      // The outbox row signals "a trip completed, payment should happen".
      // The lifecycle outbox poller picks it up and emits payment_pending
      // Socket.IO event + FCM notification. No actual payment module yet.
      // Non-fatal: outbox write failure must NOT break the completion flow.
      // =====================================================================
      try {
        let completionCustomerId = '';
        if (assignment.bookingId) {
          const bk = await prismaClient.booking.findUnique({
            where: { id: assignment.bookingId },
            select: { customerId: true }
          });
          completionCustomerId = bk?.customerId ?? '';
        } else if (assignment.orderId) {
          const ord = await prismaClient.order.findUnique({
            where: { id: assignment.orderId },
            select: { customerId: true }
          });
          completionCustomerId = ord?.customerId ?? '';
        }

        const completionPayload: TripCompletedOutboxPayload = {
          type: 'trip_completed',
          assignmentId,
          tripId: assignment.tripId,
          bookingId: assignment.bookingId || '',
          orderId: assignment.orderId || '',
          vehicleId: assignment.vehicleId || '',
          transporterId: assignment.transporterId,
          driverId,
          customerId: completionCustomerId,
          completedAt: updates.completedAt || new Date().toISOString(),
          eventId: uuid(),
          eventVersion: 1,
          serverTimeMs: Date.now()
        };
        await enqueueCompletionLifecycleOutbox(completionPayload);
        logger.info('[ASSIGNMENT] trip_completed outbox row written', {
          assignmentId,
          tripId: assignment.tripId,
          customerId: completionCustomerId
        });
      } catch (outboxErr: unknown) {
        // Non-fatal: trip completion succeeds even if outbox write fails
        const outboxErrMsg = outboxErr instanceof Error ? outboxErr.message : String(outboxErr);
        logger.warn('[ASSIGNMENT] Failed to write trip_completed outbox row (non-fatal)', {
          assignmentId,
          tripId: assignment.tripId,
          error: outboxErrMsg
        });
      }

      // Re-fetch the updated assignment to return to caller
      updated = (await db.getAssignmentById(assignmentId))!;
    } else {
      updated = await db.updateAssignment(assignmentId, updates);
    }

    // Notify booking room
    const updateStreamId = this.resolveAssignmentStreamId(assignment);
    if (updateStreamId) {
      emitToBooking(updateStreamId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
        assignmentId,
        tripId: assignment.tripId,
        status: data.status,
        vehicleNumber: assignment.vehicleNumber,
        ...(data.notes && { notes: data.notes }),
        ...(data.location && { location: data.location })
      });
    }

    // =====================================================================
    // FIX: Direct notifications on trip completion
    // =====================================================================
    // BEFORE: Only emitted to booking room. Transporter/customer may not
    //   be in that room → they never learn the trip finished.
    // NOW: Direct WebSocket + FCM push (same pattern as cancel/decline).
    // =====================================================================
    if (data.status === 'completed') {
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

    // =====================================================================
    // FIX M-2: Atomic transaction — cancel assignment + release vehicle
    // BEFORE: Two separate DB writes; vehicle release could fail after
    //   assignment already cancelled → vehicle stuck in non-available state.
    // NOW: Single Prisma transaction — both succeed or both roll back.
    // =====================================================================
    await prismaClient.$transaction(async (tx) => {
      await tx.assignment.update({
        where: { id: assignmentId },
        data: { status: 'cancelled' }
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

    // Post-transaction: Redis cache sync (non-transactional, fail-safe)
    if (assignment.vehicleId) {
      const vehicle = await prismaClient.vehicle.findUnique({
        where: { id: assignment.vehicleId },
        select: { vehicleKey: true, transporterId: true }
      });
      if (vehicle?.vehicleKey && assignment.transporterId) {
        liveAvailabilityService.onVehicleStatusChange(
          assignment.transporterId, vehicle.vehicleKey, 'in_transit', 'available'
        ).catch(err => logger.warn('[cancelAssignment] Redis sync failed', err));
      }
    }

    // Problem 16 fix: Cancel Redis-backed assignment timeout (assignment cancelled)
    queueService.cancelAssignmentTimeout(assignmentId).catch((cancelErr: any) => {
      logger.warn(`[cancelAssignment] Failed to cancel timeout timer: ${cancelErr?.message}`);
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
    driverId: string,
    options?: { reason?: string; type?: string }
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

    // M17 FIX: Read actual vehicle status before transaction (not hardcoded 'in_transit')
    let actualVehicleStatus = 'in_transit';
    if (assignment.vehicleId) {
      const veh = await prismaClient.vehicle.findUnique({
        where: { id: assignment.vehicleId },
        select: { status: true }
      });
      if (veh?.status) actualVehicleStatus = veh.status;
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
        data: {
          status: 'driver_declined',
          // H11: Persist decline reason from driver
          ...(options?.reason ? { declineReason: options.reason } : {}),
          ...(options?.type ? { declineType: options.type } : { declineType: 'explicit' }),
          declinedAt: new Date(),
        }
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

    // M16 FIX: Cancel timeout AFTER transaction succeeds (not before)
    // Timeout should only be cancelled once we KNOW the decline was persisted
    queueService.cancelAssignmentTimeout(assignmentId).catch((cancelErr: any) => {
      logger.warn(`[declineAssignment] Failed to cancel timeout timer: ${cancelErr?.message}`);
    });

    // Post-transaction: Redis cache sync (non-transactional, fail-safe)
    if (assignment.vehicleId) {
      const vehicle = await prismaClient.vehicle.findUnique({
        where: { id: assignment.vehicleId },
        select: { vehicleKey: true, transporterId: true }
      });
      if (vehicle?.vehicleKey && assignment.transporterId) {
        liveAvailabilityService.onVehicleStatusChange(
          assignment.transporterId, vehicle.vehicleKey, actualVehicleStatus, 'available'
        ).catch(err => logger.warn('[declineAssignment] Redis sync failed', err));
      }
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

      // M19 FIX: Restart broadcast timeout for next candidate (matches booking-path behavior)
      if (assignment.orderId) {
        try {
          const { smartTimeoutService } = await import('../order-timeout/smart-timeout.service');
          await smartTimeoutService.extendTimeout({
            orderId: assignment.orderId,
            driverId: assignment.driverId,
            driverName: assignment.driverName,
            assignmentId,
            truckRequestId: assignment.truckRequestId,
            isFirstDriver: false,
            reason: 'driver_declined'
          });
        } catch (restartErr: any) {
          logger.warn('[declineAssignment] Failed to restart broadcast timeout', { error: restartErr?.message });
        }
      }
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

    // H3 FIX: Notify customer that search continues (don't expose individual decline)
    let declineCustomerId: string | null = null;
    if (assignment.bookingId) {
      const bk = await prismaClient.booking.findUnique({
        where: { id: assignment.bookingId },
        select: { customerId: true }
      });
      declineCustomerId = bk?.customerId ?? null;
    } else if (assignment.orderId) {
      const ord = await prismaClient.order.findUnique({
        where: { id: assignment.orderId },
        select: { customerId: true }
      });
      declineCustomerId = ord?.customerId ?? null;
    }
    if (declineCustomerId) {
      emitToUser(declineCustomerId, 'order_progress', {
        orderId: assignment.orderId,
        bookingId: assignment.bookingId,
        status: 'searching',
        message: 'Finding another driver for your order...'
      });
    }

    // =====================================================================
    // FIX C-03: Auto re-dispatch to next available driver after decline
    // =====================================================================
    // Existing "Reassign?" notification to transporter is PRESERVED above.
    // This is ADDITIONAL: best-effort automatic cascade to next driver.
    // Non-fatal: wrapped in try/catch so failure never breaks decline flow.
    // =====================================================================
    try {
      await tryAutoRedispatch({
        bookingId: assignment.bookingId || undefined,
        orderId: assignment.orderId || undefined,
        transporterId: assignment.transporterId,
        vehicleId: assignment.vehicleId,
        vehicleType: assignment.vehicleType,
        vehicleSubtype: assignment.vehicleSubtype || undefined,
        declinedDriverId: driverId,
        assignmentId,
      });
    } catch (redispatchErr: unknown) {
      logger.warn('[declineAssignment] Auto-redispatch failed (non-fatal)', {
        assignmentId,
        error: redispatchErr instanceof Error ? redispatchErr.message : String(redispatchErr),
      });
    }

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
        // H20 FIX: Unify with DB/socket status ('driver_declined' + reason)
        status: 'driver_declined',
        reason: 'timeout'
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
        // H20 FIX: Unify with DB/socket status ('driver_declined' + reason)
        status: 'driver_declined',
        reason: 'timeout'
      }
    }).catch(err => {
      logger.warn(`FCM: Failed to notify driver of timeout`, err);
    });

    // =====================================================================
    // FIX C-03: Auto re-dispatch to next available driver after timeout
    // =====================================================================
    // Existing "Reassign?" FCM/WebSocket to transporter is PRESERVED above.
    // This is ADDITIONAL: best-effort automatic cascade to next driver.
    // Non-fatal: wrapped in try/catch so failure never breaks timeout flow.
    // =====================================================================
    try {
      await tryAutoRedispatch({
        bookingId: bookingId || undefined,
        orderId: orderId || undefined,
        transporterId,
        vehicleId,
        vehicleType: assignment.vehicleType,
        vehicleSubtype: assignment.vehicleSubtype || undefined,
        declinedDriverId: driverId,
        assignmentId,
      });
    } catch (redispatchErr: unknown) {
      logger.warn('[handleAssignmentTimeout] Auto-redispatch failed (non-fatal)', {
        assignmentId,
        error: redispatchErr instanceof Error ? redispatchErr.message : String(redispatchErr),
      });
    }

    logger.info(`Assignment timed out: ${assignmentId} — vehicle ${vehicleNumber} released`);
  }
}

export const assignmentService = new AssignmentService();
