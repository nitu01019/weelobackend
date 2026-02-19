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
import { prismaClient } from '../../shared/database/prisma.service';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, emitToBooking, SocketEvent } from '../../shared/services/socket.service';
import { redisService } from '../../shared/services/redis.service';
import { queueService } from '../../shared/services/queue.service';
import { bookingService } from '../booking/booking.service';
import { CreateAssignmentInput, UpdateStatusInput, GetAssignmentsQuery } from './assignment.schema';

// =============================================================================
// ASSIGNMENT TIMEOUT CONFIGURATION
// =============================================================================
// 
// SCALABILITY: Redis-based timers survive server restarts and work across ECS
// EASY UNDERSTANDING: Driver has 60 seconds to accept/decline, then auto-expires
// MODULARITY: Same timer pattern as booking.service.ts and booking/order.service.ts
// =============================================================================

const ASSIGNMENT_CONFIG = {
  /** How long driver has to respond (60 seconds) */
  TIMEOUT_MS: 60 * 1000,
  
  /** How often to check for expired assignments (every 5 seconds) */
  EXPIRY_CHECK_INTERVAL_MS: 5 * 1000,
};

/** Redis key pattern for assignment timers */
const TIMER_KEYS = {
  ASSIGNMENT_EXPIRY: (assignmentId: string) => `timer:assignment:${assignmentId}`,
};

/** Timer data stored in Redis */
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
// ASSIGNMENT EXPIRY CHECKER (Runs on every server instance)
// =============================================================================
// 
// SCALABILITY: Every ECS instance runs this checker, but Redis distributed locks
//   ensure only ONE instance processes each expired assignment (no duplicates)
// EASY UNDERSTANDING: Same pattern as booking.service.ts expiry checker
// MODULARITY: Independent from AssignmentService — runs as background job
// =============================================================================

let assignmentExpiryCheckerInterval: NodeJS.Timeout | null = null;

/**
 * Start the assignment expiry checker
 * Uses Redis locks to prevent duplicate processing across ECS instances
 */
function startAssignmentExpiryChecker(): void {
  if (assignmentExpiryCheckerInterval) return;
  
  assignmentExpiryCheckerInterval = setInterval(async () => {
    try {
      await processExpiredAssignments();
    } catch (error: any) {
      logger.error('Assignment expiry checker error', { error: error.message });
    }
  }, ASSIGNMENT_CONFIG.EXPIRY_CHECK_INTERVAL_MS);
  
  logger.info('📅 Assignment expiry checker started (Redis-based, cluster-safe)');
}

export function stopAssignmentExpiryChecker(): void {
  if (assignmentExpiryCheckerInterval) {
    clearInterval(assignmentExpiryCheckerInterval);
    assignmentExpiryCheckerInterval = null;
    logger.info('Assignment expiry checker stopped');
  }
}

/**
 * Process all expired assignment timers
 * 
 * SCALABILITY: Distributed lock prevents duplicate handling across instances
 * EASY UNDERSTANDING: Scan expired → lock → handle timeout → unlock
 * CODING STANDARDS: Same pattern as processExpiredOrders() in booking/order.service.ts
 */
async function processExpiredAssignments(): Promise<void> {
  const expiredTimers = await redisService.getExpiredTimers<AssignmentTimerData>('timer:assignment:');
  
  for (const timer of expiredTimers) {
    // Acquire distributed lock (prevents duplicate processing)
    const lockKey = `lock:assignment-expiry:${timer.data.assignmentId}`;
    const lock = await redisService.acquireLock(lockKey, 'expiry-checker', 30);
    
    if (!lock.acquired) continue; // Another instance is handling this
    
    try {
      await assignmentService.handleAssignmentTimeout(timer.data);
      await redisService.cancelTimer(timer.key);
    } catch (error: any) {
      logger.error('Failed to process expired assignment', {
        assignmentId: timer.data.assignmentId,
        error: error.message
      });
    } finally {
      await redisService.releaseLock(lockKey, 'expiry-checker');
    }
  }
}

// Start expiry checker when module loads
startAssignmentExpiryChecker();

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

    await prismaClient.$transaction(async (tx) => {
      // Re-check inside transaction with Serializable isolation
      const activeStatuses = ['pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit'];
      const activeAssignment = await tx.assignment.findFirst({
        where: { driverId: data.driverId, status: { in: activeStatuses as any } }
      });
      if (activeAssignment) {
        logger.warn(`⚠️ Driver ${driver.name} already has active trip: ${activeAssignment.tripId}`);
        throw new AppError(400, 'DRIVER_BUSY',
          `Driver ${driver.name} already has an active trip. Please assign a different driver.`);
      }
      await db.createAssignment(assignment);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    // =========================================================================
    // START 60-SECOND TIMEOUT TIMER (Redis-based)
    // =========================================================================
    // SCALABILITY: Redis timer survives restarts, works across ECS instances
    // EASY UNDERSTANDING: Driver has 60s to accept/decline, then auto-expires
    // MODULARITY: Same pattern as booking.service.ts timer
    // =========================================================================
    const expiresAt = new Date(Date.now() + ASSIGNMENT_CONFIG.TIMEOUT_MS);
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
    
    await redisService.setTimer(
      TIMER_KEYS.ASSIGNMENT_EXPIRY(assignment.id),
      timerData,
      expiresAt
    );
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

    logger.info(`Assignment created: ${assignment.id} for booking ${data.bookingId}`);
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
      throw new AppError(400, 'INVALID_STATUS', 'Assignment cannot be accepted');
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

    const updated = await db.updateAssignment(assignmentId, {
      status: 'driver_accepted',
      driverAcceptedAt: new Date().toISOString()
    });

    // Cancel timeout timer — driver responded in time
    await redisService.cancelTimer(TIMER_KEYS.ASSIGNMENT_EXPIRY(assignmentId));
    logger.info(`⏱️ Assignment timeout cancelled (accepted): ${assignmentId}`);

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
    pending:          ['driver_accepted', 'driver_declined', 'cancelled'],
    driver_accepted:  ['en_route_pickup', 'cancelled'],
    en_route_pickup:  ['at_pickup', 'cancelled'],
    at_pickup:        ['in_transit', 'cancelled'],
    in_transit:       ['completed', 'cancelled'],
    completed:        [],
    driver_declined:  [],
    cancelled:        [],
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

    await db.updateAssignment(assignmentId, { status: 'cancelled' });

    // Cancel timeout timer
    await redisService.cancelTimer(TIMER_KEYS.ASSIGNMENT_EXPIRY(assignmentId));

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

    // 1. Update status to driver_declined
    await db.updateAssignment(assignmentId, { status: 'driver_declined' });

    // 2. Cancel timeout timer — driver responded (with decline)
    await redisService.cancelTimer(TIMER_KEYS.ASSIGNMENT_EXPIRY(assignmentId));

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
  // Called by expiry checker when Redis timer expires.
  // Same effect as decline, but with 'timeout' reason for transporter UI.
  // 
  // SCALABILITY: Called from expiry checker with distributed lock
  // EASY UNDERSTANDING: No response in 60s → same as decline + timeout reason
  // MODULARITY: Uses same vehicle release + notification pattern as decline
  // ==========================================================================

  async handleAssignmentTimeout(timerData: AssignmentTimerData): Promise<void> {
    const { assignmentId, driverId, driverName, transporterId, vehicleId, vehicleNumber, bookingId, tripId } = timerData;

    // Fetch current assignment — skip if already responded
    const assignment = await db.getAssignmentById(assignmentId);
    if (!assignment) {
      logger.warn(`Assignment ${assignmentId} not found for timeout handling`);
      return;
    }

    // Skip if driver already accepted/declined/completed
    if (assignment.status !== 'pending') {
      logger.info(`Assignment ${assignmentId} already ${assignment.status}, skipping timeout`);
      return;
    }

    logger.info(`⏰ TIMEOUT: Assignment ${assignmentId} — driver ${driverName} didn't respond`);

    // 1. Update status to driver_declined (timed out = effectively declined)
    await db.updateAssignment(assignmentId, { status: 'driver_declined' });

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
    emitToUser(driverId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
      assignmentId,
      tripId,
      status: 'expired',
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
