/**
 * @deprecated Legacy booking order accept logic. See order.service.ts deprecation notice.
 *
 * Handles transporter accepting a specific truck request with optimistic locking
 * and serializable transactions. Emits real-time notifications to all parties.
 */

import { v4 as uuid } from 'uuid';
import crypto from 'crypto';
import { Prisma, User, Vehicle, Order, TruckRequest } from '@prisma/client';
import { TruckRequestRecord } from '../../shared/database/db';
import { withDbTimeout, AssignmentStatus } from '../../shared/database/prisma.service';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, SocketEvent } from '../../shared/services/socket.service';
import { redisService } from '../../shared/services/redis.service';
import { queueService } from '../../shared/services/queue.service';
import { HOLD_CONFIG } from '../../core/config/hold-config';
import { cancelOrderTimeout } from './legacy-order-timeout.service';

// =============================================================================
// ACCEPT TRUCK REQUEST
// =============================================================================

/**
 * Accept a truck request (transporter assigns their truck)
 *
 * LIGHTNING FAST FLOW:
 * 1. Validate request is still available (atomic check)
 * 2. Update request status immediately
 * 3. Send confirmation to accepting transporter
 * 4. Update remaining count for all other transporters
 * 5. Notify customer with progress update
 *
 * HANDLES: 10 same truck type -> 10 transporters get notified -> Each can accept 1
 */
export async function acceptTruckRequest(
  requestId: string,
  transporterId: string,
  vehicleId: string,
  driverId?: string
): Promise<TruckRequestRecord> {

  const startTime = Date.now();
  const MAX_RETRIES = 3;

  // DR-03 FIX: Distributed lock before transaction — prevents concurrent accepts
  // for the same request. Matches broadcast-accept.service.ts lock pattern.
  const lockKey = `legacy-accept:${requestId}`;
  const lockHolder = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`;
  let lockAcquired = false;

  try {
    const lock = await redisService.acquireLock(lockKey, lockHolder, 20);
    lockAcquired = lock.acquired;
    if (!lockAcquired) {
      throw new AppError(429, 'LOCK_CONTENTION', 'Another accept is being processed for this request. Please retry.');
    }
  } catch (error: unknown) {
    if (error instanceof AppError) throw error;
    // Redis failure: proceed without lock (fail-open for availability)
    logger.warn('[LegacyAccept] Lock acquisition failed, proceeding without lock', {
      requestId, error: error instanceof Error ? error.message : String(error),
    });
  }

  try {

  // -------------------------------------------------------------------
  // ATOMIC TRANSACTION with optimistic locking + P2034 retry loop
  // Pattern: Prisma Serializable isolation + updateMany WHERE status guard
  // Reference: broadcast.service.ts line 411
  // -------------------------------------------------------------------
  let txResult: {
    updatedRequest: TruckRequestRecord;
    request: TruckRequest;
    vehicle: Vehicle;
    transporter: User | null;
    driver: User | null;
    order: Order | null;
    tripId: string;
    assignmentId: string;
    newFilled: number;
    trucksRemaining: number;
    newStatus: string;
    allRequests: { id: string; status: string; vehicleType: string; vehicleSubtype: string; notifiedTransporters: string[]; assignedVehicleNumber?: string | null; assignedTransporterName?: string | null; assignedDriverName?: string | null; assignedDriverPhone?: string | null; requestNumber: number }[];
    remainingRequests: { id: string; status: string; vehicleType: string; vehicleSubtype: string; notifiedTransporters: string[] }[];
    notifiedTransporters: Set<string>;
  } | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      txResult = await withDbTimeout(async (tx) => {

        // STEP 1: Validate request exists and is still available (inside tx)
        const request = await tx.truckRequest.findUnique({ where: { id: requestId } });
        if (!request) {
          throw new AppError(404, 'REQUEST_NOT_FOUND', 'Truck request not found');
        }

        if (request.status !== 'searching') {
          throw new AppError(400, 'REQUEST_ALREADY_TAKEN',
            'This truck request was just taken by another transporter. Check for remaining trucks.');
        }

        // Verify transporter has this vehicle type (inside tx for consistency)
        const vehicle = await tx.vehicle.findUnique({ where: { id: vehicleId } });
        if (!vehicle) {
          throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found');
        }
        if (vehicle.transporterId !== transporterId) {
          throw new AppError(403, 'FORBIDDEN', 'This vehicle does not belong to you');
        }
        if (vehicle.vehicleType !== request.vehicleType || vehicle.vehicleSubtype !== request.vehicleSubtype) {
          throw new AppError(400, 'VEHICLE_TYPE_MISMATCH',
            `Your vehicle (${vehicle.vehicleType} ${vehicle.vehicleSubtype}) doesn't match the request (${request.vehicleType} ${request.vehicleSubtype})`);
        }

        // C-05 FIX: Vehicle availability guard — must be available, not on an active trip
        if (vehicle.status !== 'available') {
          throw new AppError(409, 'VEHICLE_UNAVAILABLE',
            `Vehicle ${vehicleId} is not available (status: ${vehicle.status})`);
        }
        if (vehicle.currentTripId) {
          throw new AppError(409, 'VEHICLE_ON_TRIP',
            `Vehicle ${vehicleId} is already on trip ${vehicle.currentTripId}`);
        }

        // C-05 FIX: Driver busy guard — must not have an active assignment
        if (driverId) {
          const activeDriverAssignment = await tx.assignment.findFirst({
            where: {
              driverId,
              status: { in: ['pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit'] }
            },
            select: { id: true }
          });
          if (activeDriverAssignment) {
            throw new AppError(409, 'DRIVER_BUSY',
              `Driver ${driverId} already has active assignment ${activeDriverAssignment.id}`);
          }
        }

        // Get transporter and driver info (inside tx)
        const transporter = await tx.user.findUnique({ where: { id: transporterId } });
        const driver = driverId
          ? await tx.user.findUnique({ where: { id: driverId } })
          : null;

        // STEP 2: Optimistic lock -- updateMany with status guard
        // If another concurrent request already flipped status away from 'searching',
        // this WHERE clause matches 0 rows and we detect the conflict.
        const tripId = uuid();
        const now = new Date().toISOString();

        const requestUpdate = await tx.truckRequest.updateMany({
          where: {
            id: requestId,
            status: 'searching'
          },
          data: {
            status: 'assigned',
            assignedTransporterId: transporterId,
            assignedTransporterName: transporter?.businessName || transporter?.name || 'Unknown',
            assignedVehicleId: vehicleId,
            assignedVehicleNumber: vehicle.vehicleNumber,
            assignedDriverId: driverId || null,
            assignedDriverName: driver?.name || null,
            assignedDriverPhone: driver?.phone || null,
            tripId,
            assignedAt: now
          }
        });

        if (requestUpdate.count === 0) {
          throw new AppError(409, 'REQUEST_ALREADY_TAKEN',
            'This request is no longer available');
        }

        // Fetch the updated request record after the atomic update
        const updatedRow = await tx.truckRequest.findUnique({ where: { id: requestId } });
        if (!updatedRow) {
          throw new AppError(500, 'INTERNAL_ERROR', 'Failed to read updated truck request');
        }

        // Map to TruckRequestRecord shape
        const updatedRequest = {
          ...updatedRow as any,
          heldBy: updatedRow.heldById || undefined,
          assignedTo: updatedRow.assignedTransporterId || undefined,
          status: updatedRow.status as TruckRequestRecord['status'],
          notifiedTransporters: updatedRow.notifiedTransporters || [],
          createdAt: updatedRow.createdAt.toISOString(),
          updatedAt: updatedRow.updatedAt.toISOString(),
        } as TruckRequestRecord;

        // DR-02 FIX: CAS vehicle status update — set to 'on_hold' atomically.
        // Prevents double-assignment of the same vehicle across concurrent accepts.
        const vehicleCas = await tx.vehicle.updateMany({
          where: { id: vehicleId, status: 'available' },
          data: { status: 'on_hold' }
        });
        if (vehicleCas.count === 0) {
          throw new AppError(409, 'VEHICLE_UNAVAILABLE', 'Vehicle is no longer available');
        }

        // DR-01 FIX: Create assignment record inside transaction.
        // Legacy path was missing assignment creation — matching order-accept.service.ts pattern.
        const assignmentId = uuid();
        await tx.assignment.create({
          data: {
            id: assignmentId,
            bookingId: null,
            truckRequestId: requestId,
            orderId: request.orderId,
            transporterId,
            transporterName: transporter?.businessName || transporter?.name || '',
            vehicleId,
            vehicleNumber: vehicle.vehicleNumber,
            vehicleType: vehicle.vehicleType,
            vehicleSubtype: vehicle.vehicleSubtype || '',
            driverId: driverId ?? '',
            driverName: driver?.name ?? '',
            driverPhone: driver?.phone || '',
            tripId,
            status: AssignmentStatus.pending,
            assignedAt: now
          }
        });

        // STEP 3: Get parent order and update atomically
        const order = await tx.order.findUnique({ where: { id: request.orderId } });
        if (!order) {
          logger.error(`Order ${request.orderId} not found for request ${requestId}`);
          return {
            updatedRequest,
            request,
            vehicle,
            transporter,
            driver,
            order: null,
            tripId,
            assignmentId,
            newFilled: 0,
            trucksRemaining: 0,
            newStatus: 'unknown',
            allRequests: [],
            remainingRequests: [],
            notifiedTransporters: new Set<string>()
          };
        }

        const newFilled = order.trucksFilled + 1;
        const trucksRemaining = order.totalTrucks - newFilled;
        const newStatus = newFilled >= order.totalTrucks ? 'fully_filled' : 'partially_filled';

        // Optimistic lock on order: only update if trucksFilled hasn't changed
        const orderUpdate = await tx.order.updateMany({
          where: {
            id: request.orderId,
            trucksFilled: order.trucksFilled
          },
          data: {
            trucksFilled: newFilled,
            status: newStatus as any
          }
        });

        if (orderUpdate.count === 0) {
          // Another concurrent accept changed trucksFilled -- retry will re-read
          throw new AppError(409, 'ORDER_STATE_CHANGED',
            'Order state changed concurrently. Retrying.');
        }

        // STEP 4: Get remaining searching requests (inside tx for consistency)
        const allRequestRows = await tx.truckRequest.findMany({
          where: { orderId: request.orderId }
        });
        const allRequests = allRequestRows.map((r) => ({
          ...r,
          heldBy: r.heldById || undefined,
          assignedTo: r.assignedTransporterId || undefined,
          status: r.status as string,
          notifiedTransporters: r.notifiedTransporters || [],
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        }));

        const remainingRequests = allRequests.filter((r) =>
          r.status === 'searching' &&
          r.vehicleType === request.vehicleType &&
          r.vehicleSubtype === request.vehicleSubtype
        );

        // Collect notified transporters for post-tx notifications
        const notifiedTransporters = new Set<string>();
        allRequests.forEach((r) =>
          (r.notifiedTransporters as string[]).forEach((t: string) => notifiedTransporters.add(t))
        );

        return {
          updatedRequest,
          request,
          vehicle,
          transporter,
          driver,
          order,
          tripId,
          assignmentId,
          newFilled,
          trucksRemaining,
          newStatus,
          allRequests,
          remainingRequests,
          notifiedTransporters
        };

      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

      // Transaction succeeded -- break out of retry loop
      break;

    } catch (txError: unknown) {
      // Retry on serialization conflict (P2034 = Prisma, 40001 = Postgres)
      const isRetryable = (txError as { code?: string })?.code === 'P2034' || (txError as { code?: string })?.code === '40001';
      if (isRetryable && attempt < MAX_RETRIES) {
        logger.warn(`[acceptTruckRequest] Serialization conflict, retry ${attempt}/${MAX_RETRIES}`, {
          requestId, transporterId, vehicleId, attempt, code: (txError as { code?: string }).code
        });
        continue;
      }
      // Non-retryable or exhausted retries -- rethrow
      throw txError;
    }
  }

  if (!txResult) {
    throw new AppError(409, 'REQUEST_ALREADY_TAKEN',
      'Unable to complete assignment after retries');
  }

  // -------------------------------------------------------------------
  // ALL NOTIFICATIONS BELOW -- outside the transaction
  // -------------------------------------------------------------------
  const {
    updatedRequest, request, vehicle, transporter, driver, order,
    tripId, assignmentId, newFilled, trucksRemaining, newStatus,
    allRequests, remainingRequests, notifiedTransporters
  } = txResult;

  // If order was missing, return early (edge case preserved from original)
  if (!order) {
    return updatedRequest;
  }

  // DR-04 FIX: Schedule assignment timeout after transaction commits.
  // Without this, pending assignments never expire. Matches order-accept.service.ts pattern.
  if (assignmentId) {
    try {
      const timeoutMs = HOLD_CONFIG.driverAcceptTimeoutMs;
      await queueService.scheduleAssignmentTimeout({
        assignmentId,
        driverId: driverId || '',
        driverName: driver?.name || '',
        transporterId,
        vehicleId,
        vehicleNumber: vehicle.vehicleNumber,
        bookingId: order.id,
        tripId,
        createdAt: new Date().toISOString(),
      }, timeoutMs);
      logger.info('[LegacyAccept] Assignment timeout scheduled', {
        assignmentId,
        timeoutSeconds: timeoutMs / 1000,
      });
    } catch (err) {
      // Non-fatal: DB reconciliation will catch within 2 minutes
      logger.error('[LegacyAccept] Failed to schedule assignment timeout', {
        assignmentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Invalidate vehicle cache after transaction commit
  redisService.del(`cache:vehicles:transporter:${transporterId}`).catch(() => {});

  logger.info(`╔══════════════════════════════════════════════════════════════╗`);
  logger.info(`║  TRUCK ACCEPTED (atomic)                                     ║`);
  logger.info(`╠══════════════════════════════════════════════════════════════╣`);
  logger.info(`║  Request: ${requestId}`);
  logger.info(`║  Transporter: ${transporter?.name || transporterId}`);
  logger.info(`║  Vehicle: ${vehicle.vehicleNumber} (${vehicle.vehicleType} ${vehicle.vehicleSubtype})`);
  logger.info(`║  Progress: ${newFilled}/${order.totalTrucks} trucks filled`);
  logger.info(`║  Remaining (same type): ${remainingRequests.length}`);
  logger.info(`║  Processing time: ${Date.now() - startTime}ms`);
  logger.info(`╚══════════════════════════════════════════════════════════════╝`);

  // STEP 5: Send INSTANT confirmation to accepting transporter
  emitToUser(transporterId, SocketEvent.ACCEPT_CONFIRMATION, {
    success: true,
    requestId,
    orderId: order.id,
    vehicleNumber: vehicle.vehicleNumber,
    tripId,
    message: `You got it! Truck ${request.requestNumber} assigned to you.`,

    // Show if more trucks available of same type
    moreTrucksAvailable: remainingRequests.length > 0,
    remainingOfSameType: remainingRequests.length,
    remainingRequestIds: remainingRequests.map((r) => r.id)
  });

  // STEP 6: Update ALL other transporters with remaining count
  for (const otherTransporterId of notifiedTransporters) {
    if (otherTransporterId !== transporterId) {
      // Tell them this specific request is gone
      emitToUser(otherTransporterId, SocketEvent.REQUEST_NO_LONGER_AVAILABLE, {
        orderId: order.id,
        requestId,
        takenBy: transporter?.businessName || 'Another transporter',
        message: 'This truck was just taken'
      });

      // Update remaining truck count for this order
      emitToUser(otherTransporterId, SocketEvent.TRUCKS_REMAINING_UPDATE, {
        orderId: order.id,
        vehicleType: request.vehicleType,
        vehicleSubtype: request.vehicleSubtype,

        // Overall order progress
        totalTrucks: order.totalTrucks,
        trucksFilled: newFilled,
        trucksRemaining,

        // Remaining of same type (what they can still accept)
        remainingOfSameType: remainingRequests.length,
        remainingRequestIds: remainingRequests.map((r) => r.id),

        // Status
        orderStatus: newStatus,
        message: remainingRequests.length > 0
          ? `${remainingRequests.length} ${request.vehicleType} ${request.vehicleSubtype} trucks still available!`
          : `All ${request.vehicleType} ${request.vehicleSubtype} trucks have been taken.`
      });
    }
  }

  // STEP 7: Notify customer with REAL-TIME progress
  emitToUser(order.customerId, SocketEvent.TRUCK_ASSIGNED, {
    orderId: order.id,
    requestId,
    requestNumber: request.requestNumber,
    vehicleType: request.vehicleType,
    vehicleSubtype: request.vehicleSubtype,
    vehicleNumber: vehicle.vehicleNumber,
    transporterName: transporter?.businessName || transporter?.name,
    transporterPhone: transporter?.phone,
    driverName: driver?.name,
    driverPhone: driver?.phone,
    tripId,

    // Progress info
    trucksFilled: newFilled,
    totalTrucks: order.totalTrucks,
    trucksRemaining,
    progressPercent: Math.round((newFilled / order.totalTrucks) * 100),

    message: `Truck ${newFilled}/${order.totalTrucks} assigned!`
  });

  // STEP 8: Handle completion or partial fill
  if (newStatus === 'fully_filled') {
    // All trucks filled - Cancel timeout
    await cancelOrderTimeout(order.id);

    emitToUser(order.customerId, SocketEvent.BOOKING_FULLY_FILLED, {
      orderId: order.id,
      totalTrucks: order.totalTrucks,
      totalAmount: order.totalAmount,
      message: 'All trucks have been assigned! Your order is complete.',
      assignedTrucks: allRequests
        .filter((r) => r.status === 'assigned')
        .map((r) => ({
          requestNumber: r.requestNumber,
          vehicleType: r.vehicleType,
          vehicleSubtype: r.vehicleSubtype,
          vehicleNumber: r.assignedVehicleNumber,
          transporterName: r.assignedTransporterName,
          driverName: r.assignedDriverName,
          driverPhone: r.assignedDriverPhone
        }))
    });

    // Notify all transporters that order is complete
    for (const tid of notifiedTransporters) {
      if (tid !== transporterId) {
        emitToUser(tid, SocketEvent.ORDER_STATUS_UPDATE, {
          orderId: order.id,
          status: 'fully_filled',
          message: 'This order has been fully filled'
        });
      }
    }

    logger.info(`ORDER ${order.id} FULLY FILLED!`);
  }

  // M-04 FIX: Normalize legacy response to match modern AcceptTruckRequestResult shape
  return {
    ...updatedRequest,
    success: true,
    assignmentId: assignmentId || (updatedRequest as any).assignmentId || undefined,
    tripId: updatedRequest.tripId || undefined,
    message: 'Truck request accepted successfully',
  } as TruckRequestRecord;

  } finally {
    // DR-03: Release distributed lock
    if (lockAcquired) {
      await redisService.releaseLock(lockKey, lockHolder).catch(() => {});
    }
  }
}

