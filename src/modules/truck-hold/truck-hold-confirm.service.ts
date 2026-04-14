/**
 * =============================================================================
 * TRUCK HOLD CONFIRM — Confirm Hold With Vehicle & Driver Assignments
 * =============================================================================
 *
 * Saga orchestrator for confirming a hold with specific vehicle + driver
 * assignments. Steps:
 *   1. validateHoldForConfirmation
 *   2. validateAssignmentVehicles
 *   3. buildAssignmentPlan
 *   4. executeAssignmentTransaction
 *   5. notifyAssignmentParties
 *   6. finalizeHoldConfirmation
 *   7. formatConfirmationResponse
 *   8. handleAssignmentFailure
 */

import { v4 as uuidv4 } from 'uuid';
import { Prisma, TruckHoldLedger } from '@prisma/client';
import { db } from '../../shared/database/db';
import type { LocationRecord } from '../../shared/database/record-types';
import { prismaClient, withDbTimeout, AssignmentStatus, OrderStatus, TruckRequestStatus, VehicleStatus } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { socketService, SocketEvent } from '../../shared/services/socket.service';
import { queueService } from '../../shared/services/queue.service';
import { redisService } from '../../shared/services/redis.service';
import { driverService } from '../driver/driver.service';
import { HOLD_CONFIG } from '../../core/config/hold-config';
import { TERMINAL_ORDER_STATUSES } from './truck-hold.types';
import { maskPhoneForExternal } from '../../shared/utils/pii.utils';

// ---------------------------------------------------------------------------
// Internal select types for Prisma partial results
// ---------------------------------------------------------------------------

/** Partial vehicle shape returned from batch validation selects */
type ConfirmVehicleSelect = {
  id: string;
  transporterId: string;
  status: string;
  currentTripId: string | null;
  vehicleType: string;
  vehicleSubtype: string;
  vehicleNumber: string;
};

/** Partial driver (user) shape returned from batch validation selects */
type ConfirmDriverSelect = {
  id: string;
  name: string;
  phone: string | null;
  transporterId: string | null;
};

/** Extended location shape — `latitude`/`longitude` canonical + `lat`/`lng` aliases from legacy db fields */
type ConfirmLocationShape = LocationRecord & { lat?: number | null; lng?: number | null };

/** Order shape expected by confirm saga steps */
type ConfirmOrderShape = {
  id: string;
  totalTrucks: number;
  trucksFilled: number;
  pickup: ConfirmLocationShape;
  drop: ConfirmLocationShape;
  routePoints: unknown;
  distanceKm: number | null;
  customerName: string | null;
  customerPhone: string | null;
  status: string;
};

/** Transporter (user) shape expected by confirm saga steps */
type ConfirmTransporterShape = {
  id: string;
  name: string | null;
  businessName?: string | null;
} | null;

// ---------------------------------------------------------------------------
// Typed results for saga sub-steps
// ---------------------------------------------------------------------------
const ACTIVE_ASSIGNMENT_STATUSES: AssignmentStatus[] = [
  AssignmentStatus.pending,
  AssignmentStatus.driver_accepted,
  AssignmentStatus.en_route_pickup,
  AssignmentStatus.at_pickup,
  AssignmentStatus.in_transit
];

// =============================================================================
// CONFIRM HOLD WITH ASSIGNMENTS (Saga Orchestrator)
// =============================================================================

/**
 * Called when transporter confirms with specific vehicle + driver for each truck.
 * Orchestrates: validate -> validate vehicles -> execute TX -> notify -> finalize
 */
export async function confirmHoldWithAssignments(
  holdId: string,
  transporterId: string,
  assignments: Array<{ vehicleId: string; driverId: string }>,
  releaseHoldFn: (holdId: string, transporterId: string) => Promise<void>,
  broadcastFn: (orderId: string) => void
): Promise<{
  success: boolean;
  message: string;
  assignmentIds?: string[];
  tripIds?: string[];
  failedAssignments?: Array<{ vehicleId: string; reason: string }>;
}> {
  logger.info(`[TruckHold] CONFIRM HOLD WITH ASSIGNMENTS | Hold: ${holdId} | Transporter: ${transporterId} | Assignments: ${assignments.length}`);

  // CRITICAL #6 FIX: Distributed lock to prevent concurrent confirm attempts.
  // The previous code used a plain get() check-then-act pattern which is not atomic.
  const lockKey = `hold:confirm:lock:${holdId}`;
  const lock = await redisService.acquireLock(lockKey, transporterId, 30);
  if (!lock.acquired) {
    // Lock not acquired — check idempotency cache in case this is a retry of an already-confirmed hold
    const idemKey = `hold:confirm:${holdId}`;
    try {
      const existing = await redisService.get(idemKey);
      if (existing) return JSON.parse(existing);
    } catch { /* Redis down */ }
    return { success: false, message: 'Confirmation already in progress. Please wait.' };
  }

  try {
    // FIX #52: Idempotency check — if this holdId was already confirmed, return
    // the cached result instead of re-running the full saga. Prevents duplicate
    // assignments from double-tap or network retry on the transporter's app.
    const idemKey = `hold:confirm:${holdId}`;
    try {
      const existing = await redisService.get(idemKey);
      if (existing) {
        logger.info(`[TruckHold] Idempotent replay for hold ${holdId}`);
        return JSON.parse(existing);
      }
    } catch { /* Redis down -- proceed without idempotency cache */ }

    // 1. Validate hold
    const holdValidation = await validateHoldForConfirmation(holdId, transporterId, assignments.length, releaseHoldFn);
    if (!holdValidation.valid) return holdValidation.errorResponse!;
    const hold = holdValidation.hold!;

    // 2. Validate vehicles & drivers
    const vehicleValidation = await validateAssignmentVehicles(
      hold, transporterId, assignments
    );
    if (!vehicleValidation.valid) return vehicleValidation.errorResponse!;

    // 3. Build assignment plan
    const plan = buildAssignmentPlan(vehicleValidation.validatedVehicles!, assignments);

    // 4. Fetch order + transporter context
    const order = await db.getOrderById(hold.orderId);
    if (!order) {
      return { success: false, message: 'Order not found' };
    }
    const transporter = await db.getUserById(transporterId);

    // 5. Execute SERIALIZABLE DB transaction
    const txResult = await executeAssignmentTransaction(
      hold, transporterId, transporter, plan, order
    );

    // 6. Notify assignment parties (Socket.IO + FCM + timeout scheduling)
    await notifyAssignmentParties(txResult.assignments, order, transporterId);

    // 7. Mark hold as confirmed and broadcast
    await finalizeHoldConfirmation(holdId, hold.orderId, broadcastFn);

    // 8. Format and return response
    const result = formatConfirmationResponse(txResult, order);

    // FIX #52: Cache successful result for idempotency (5 min TTL)
    try {
      await redisService.set(idemKey, JSON.stringify(result), 300);
    } catch { /* Redis down -- idempotency is best-effort */ }

    return result;

  } catch (error: unknown) {
    return handleAssignmentFailure(error);
  } finally {
    // CRITICAL #6: Always release the distributed lock
    await redisService.releaseLock(lockKey, transporterId).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Step 1: Validate hold exists, is active, not expired, count matches
// ---------------------------------------------------------------------------
async function validateHoldForConfirmation(
  holdId: string,
  transporterId: string,
  assignmentCount: number,
  releaseHoldFn: (holdId: string, transporterId: string) => Promise<void>
): Promise<{
  valid: boolean;
  hold?: TruckHoldLedger;
  errorResponse?: { success: false; message: string };
}> {
  const hold = await prismaClient.truckHoldLedger.findUnique({ where: { holdId } });

  if (!hold) {
    return { valid: false, errorResponse: { success: false, message: 'Hold not found or expired' } };
  }
  if (hold.transporterId !== transporterId) {
    return { valid: false, errorResponse: { success: false, message: 'This hold belongs to another transporter' } };
  }
  if (hold.status !== 'active') {
    return { valid: false, errorResponse: { success: false, message: `Hold is ${hold.status}. Cannot confirm.` } };
  }
  if (hold.expiresAt <= new Date()) {
    await releaseHoldFn(holdId, transporterId);
    return { valid: false, errorResponse: { success: false, message: 'Hold expired. Please try again.' } };
  }
  if (assignmentCount !== hold.quantity) {
    return {
      valid: false,
      errorResponse: { success: false, message: `Expected ${hold.quantity} assignments but got ${assignmentCount}` }
    };
  }

  return { valid: true, hold };
}

// ---------------------------------------------------------------------------
// Step 2: Batch fetch vehicles/drivers, check availability, duplicates, online
// ---------------------------------------------------------------------------
async function validateAssignmentVehicles(
  hold: TruckHoldLedger,
  transporterId: string,
  assignments: Array<{ vehicleId: string; driverId: string }>
): Promise<{
  valid: boolean;
  validatedVehicles?: Array<{ vehicle: ConfirmVehicleSelect; driver: ConfirmDriverSelect; truckRequestId: string }>;
  uniqueVehicleIds?: string[];
  uniqueDriverIds?: string[];
  errorResponse?: { success: false; message: string; failedAssignments: Array<{ vehicleId: string; reason: string }> };
}> {
  const failedAssignments: Array<{ vehicleId: string; reason: string }> = [];
  const validatedVehicles: Array<{ vehicle: ConfirmVehicleSelect; driver: ConfirmDriverSelect; truckRequestId: string }> = [];
  const seenVehicleIds = new Set<string>();
  const seenDriverIds = new Set<string>();
  const uniqueVehicleIds = Array.from(new Set(assignments.map(a => a.vehicleId)));
  const uniqueDriverIds = Array.from(new Set(assignments.map(a => a.driverId)));

  const [vehicleRows, driverRows, activeDriverAssignments, activeVehicleAssignments] = await Promise.all([
    prismaClient.vehicle.findMany({
      where: { id: { in: uniqueVehicleIds } },
      select: {
        id: true, transporterId: true, status: true, currentTripId: true,
        vehicleType: true, vehicleSubtype: true, vehicleNumber: true
      }
    }),
    prismaClient.user.findMany({
      where: { id: { in: uniqueDriverIds } },
      select: { id: true, name: true, phone: true, transporterId: true }
    }),
    prismaClient.assignment.findMany({
      where: { driverId: { in: uniqueDriverIds }, status: { in: ACTIVE_ASSIGNMENT_STATUSES } },
      select: { driverId: true, tripId: true }
    }),
    prismaClient.assignment.findMany({
      where: { vehicleId: { in: uniqueVehicleIds }, status: { in: ACTIVE_ASSIGNMENT_STATUSES } },
      select: { vehicleId: true, tripId: true }
    })
  ]);

  const vehicleMap = new Map(vehicleRows.map(v => [v.id, v]));
  const driverMap = new Map(driverRows.map(d => [d.id, d]));
  const activeDriverMap = new Map(activeDriverAssignments.map(a => [a.driverId, a]));
  const activeVehicleMap = new Map(activeVehicleAssignments.map(a => [a.vehicleId, a]));

  // Batch driver online check
  const driverOnlineMap = await driverService.areDriversOnline(uniqueDriverIds);

  for (let i = 0; i < assignments.length; i++) {
    const { vehicleId, driverId } = assignments[i];
    const truckRequestId = hold.truckRequestIds[i];

    if (seenVehicleIds.has(vehicleId)) {
      failedAssignments.push({ vehicleId, reason: 'Duplicate vehicle in request payload' });
      continue;
    }
    seenVehicleIds.add(vehicleId);

    if (seenDriverIds.has(driverId)) {
      failedAssignments.push({ vehicleId, reason: 'Duplicate driver in request payload' });
      continue;
    }
    seenDriverIds.add(driverId);

    const vehicle = vehicleMap.get(vehicleId);
    if (!vehicle) {
      failedAssignments.push({ vehicleId, reason: 'Vehicle not found' });
      continue;
    }
    if (vehicle.transporterId !== transporterId) {
      failedAssignments.push({ vehicleId, reason: 'Vehicle does not belong to you' });
      continue;
    }
    if (vehicle.status !== 'available') {
      failedAssignments.push({
        vehicleId,
        reason: `Vehicle is ${vehicle.status}${vehicle.currentTripId ? ` (Trip: ${vehicle.currentTripId})` : ''}`
      });
      continue;
    }

    const activeVehicleAssignment = activeVehicleMap.get(vehicleId);
    if (activeVehicleAssignment) {
      failedAssignments.push({
        vehicleId,
        reason: `Vehicle ${vehicle.vehicleNumber} is already reserved for trip ${activeVehicleAssignment.tripId}`
      });
      continue;
    }

    if (vehicle.vehicleType.toLowerCase() !== hold.vehicleType.toLowerCase()) {
      failedAssignments.push({
        vehicleId,
        reason: `Vehicle type mismatch. Expected ${hold.vehicleType}, got ${vehicle.vehicleType}`
      });
      continue;
    }

    // Subtype enforcement: prevent e.g. 10-wheel assigned to 6-wheel slot
    if (hold.vehicleSubtype && vehicle.vehicleSubtype &&
      vehicle.vehicleSubtype.toLowerCase() !== hold.vehicleSubtype.toLowerCase()) {
      failedAssignments.push({
        vehicleId,
        reason: `Vehicle subtype mismatch. Expected ${hold.vehicleSubtype}, got ${vehicle.vehicleSubtype}`
      });
      continue;
    }

    const driver = driverMap.get(driverId);
    if (!driver) {
      failedAssignments.push({ vehicleId, reason: 'Driver not found' });
      continue;
    }
    if (driver.transporterId !== transporterId && driver.id !== transporterId) {
      failedAssignments.push({ vehicleId, reason: 'Driver does not belong to you' });
      continue;
    }

    const activeAssignment = activeDriverMap.get(driverId);
    if (activeAssignment) {
      failedAssignments.push({
        vehicleId,
        reason: `Driver ${driver.name} is already on trip ${activeAssignment.tripId}`
      });
      continue;
    }

    // Reject offline driver BEFORE creating anything (Uber/Ola/Porter fail-fast pattern)
    const isOnline = driverOnlineMap.get(driverId) ?? false;
    if (!isOnline) {
      failedAssignments.push({
        vehicleId,
        reason: `Driver ${driver.name} is offline. Please select an online driver.`
      });
      continue;
    }

    validatedVehicles.push({ vehicle, driver, truckRequestId });
  }

  // If ANY assignment failed, reject the whole batch (atomicity)
  if (failedAssignments.length > 0) {
    logger.warn(`[TruckHold] ❌ ${failedAssignments.length} assignments failed validation`);
    failedAssignments.forEach(f => logger.warn(`   - ${f.vehicleId}: ${f.reason}`));
    return {
      valid: false,
      errorResponse: {
        success: false,
        message: `${failedAssignments.length} assignment(s) failed validation`,
        failedAssignments
      }
    };
  }

  return { valid: true, validatedVehicles, uniqueVehicleIds, uniqueDriverIds };
}

// ---------------------------------------------------------------------------
// Step 3: Map vehicles to truck requests (pure data, no side effects)
// ---------------------------------------------------------------------------
function buildAssignmentPlan(
  validatedVehicles: Array<{ vehicle: ConfirmVehicleSelect; driver: ConfirmDriverSelect; truckRequestId: string }>,
  _assignments: Array<{ vehicleId: string; driverId: string }>
): Array<{ vehicle: ConfirmVehicleSelect; driver: ConfirmDriverSelect; truckRequestId: string }> {
  // Currently 1:1 mapping — plan is the validated list itself.
  // Extracted so future logic (partial fills, priority sorting) has a home.
  return validatedVehicles;
}

// ---------------------------------------------------------------------------
// Step 4: SERIALIZABLE DB transaction — create assignments atomically
// ---------------------------------------------------------------------------
async function executeAssignmentTransaction(
  hold: TruckHoldLedger,
  transporterId: string,
  transporter: ConfirmTransporterShape,
  plan: Array<{ vehicle: ConfirmVehicleSelect; driver: ConfirmDriverSelect; truckRequestId: string }>,
  _order: ConfirmOrderShape
): Promise<{
  assignments: Array<{
    assignmentId: string; tripId: string; truckRequestId: string;
    vehicle: ConfirmVehicleSelect; driver: ConfirmDriverSelect; farePerTruck: number;
  }>;
  newTrucksFilled: number;
  newStatus: OrderStatus;
}> {
  const uniqueVehicleIds = Array.from(new Set(plan.map(p => p.vehicle.id)));
  const uniqueDriverIds = Array.from(new Set(plan.map(p => p.driver.id)));
  const now = new Date().toISOString();

  return withDbTimeout(async (tx) => {
    const txAssignments: Array<{
      assignmentId: string; tripId: string; truckRequestId: string;
      vehicle: ConfirmVehicleSelect; driver: ConfirmDriverSelect; farePerTruck: number;
    }> = [];

    // FIX #38: Fetch order INSIDE the SERIALIZABLE transaction to prevent
    // TOCTOU race — order could be cancelled between the pre-TX check and here.
    const currentOrder = await tx.order.findUnique({
      where: { id: hold.orderId },
      select: { id: true, totalTrucks: true, trucksFilled: true, status: true }
    });
    if (!currentOrder) throw new Error('ORDER_NOT_FOUND');
    if (TERMINAL_ORDER_STATUSES.has(currentOrder.status)) {
      throw new Error(`ORDER_TERMINAL:${currentOrder.status}`);
    }

    const txTruckRequests = await tx.truckRequest.findMany({
      where: { id: { in: hold.truckRequestIds }, orderId: hold.orderId },
      select: { id: true, orderId: true, status: true, heldById: true, pricePerTruck: true }
    });
    const txTruckRequestMap = new Map(txTruckRequests.map(tr => [tr.id, tr]));
    if (txTruckRequests.length !== hold.truckRequestIds.length) {
      throw new Error('TRUCK_REQUEST_NOT_FOUND');
    }

    const txVehicles = await tx.vehicle.findMany({
      where: { id: { in: uniqueVehicleIds } },
      select: { id: true, transporterId: true, status: true, currentTripId: true }
    });
    const txVehicleMap = new Map(txVehicles.map(v => [v.id, v]));

    const [txBusyDrivers, txBusyVehicles] = await Promise.all([
      tx.assignment.findMany({
        where: { driverId: { in: uniqueDriverIds }, status: { in: ACTIVE_ASSIGNMENT_STATUSES } },
        select: { driverId: true, tripId: true }
      }),
      tx.assignment.findMany({
        where: { vehicleId: { in: uniqueVehicleIds }, status: { in: ACTIVE_ASSIGNMENT_STATUSES } },
        select: { vehicleId: true, tripId: true }
      })
    ]);
    if (txBusyDrivers.length > 0) {
      const bd = txBusyDrivers[0];
      throw new Error(`DRIVER_BUSY:${bd.driverId}:${bd.tripId}`);
    }
    if (txBusyVehicles.length > 0) {
      const bv = txBusyVehicles[0];
      throw new Error(`VEHICLE_RESERVED:${bv.vehicleId}:${bv.tripId}`);
    }

    for (const { vehicle, driver, truckRequestId } of plan) {
      const txVehicle = txVehicleMap.get(vehicle.id);
      if (!txVehicle || txVehicle.transporterId !== transporterId) {
        throw new Error(`VEHICLE_NOT_IN_FLEET:${vehicle.id}`);
      }
      if (txVehicle.status !== VehicleStatus.available) {
        throw new Error(`VEHICLE_UNAVAILABLE:${vehicle.id}:${txVehicle.currentTripId || ''}`);
      }

      const truckRequest = txTruckRequestMap.get(truckRequestId);
      if (!truckRequest || truckRequest.orderId !== hold.orderId) {
        throw new Error(`TRUCK_REQUEST_NOT_FOUND:${truckRequestId}`);
      }
      if (truckRequest.status !== 'held' || truckRequest.heldById !== transporterId) {
        throw new Error(`TRUCK_REQUEST_NOT_HELD:${truckRequestId}`);
      }

      const assignmentId = uuidv4();
      const tripId = uuidv4();

      const requestUpdated = await tx.truckRequest.updateMany({
        where: {
          id: truckRequestId, orderId: hold.orderId,
          status: TruckRequestStatus.held, heldById: transporterId
        },
        data: {
          status: TruckRequestStatus.assigned,
          assignedTransporterId: transporterId,
          assignedTransporterName: transporter?.name || transporter?.businessName || '',
          assignedVehicleId: vehicle.id,
          assignedVehicleNumber: vehicle.vehicleNumber,
          assignedDriverId: driver.id,
          assignedDriverName: driver.name,
          assignedDriverPhone: driver.phone || '',
          tripId, assignedAt: now, heldById: null, heldAt: null
        }
      });
      if (requestUpdated.count === 0) {
        throw new Error(`TRUCK_REQUEST_STATE_CHANGED:${truckRequestId}`);
      }

      await tx.assignment.create({
        data: {
          id: assignmentId,
          bookingId: null,
          truckRequestId, orderId: hold.orderId, transporterId,
          transporterName: transporter?.name || transporter?.businessName || '',
          vehicleId: vehicle.id, vehicleNumber: vehicle.vehicleNumber,
          vehicleType: vehicle.vehicleType, vehicleSubtype: vehicle.vehicleSubtype || '',
          driverId: driver.id, driverName: driver.name, driverPhone: driver.phone || '',
          tripId, status: AssignmentStatus.pending, assignedAt: now
        }
      });

      // Set vehicle to on_hold atomically inside transaction
      await tx.vehicle.updateMany({
        where: { id: vehicle.id, status: { in: ['available'] as any } },
        data: {
          status: 'on_hold', currentTripId: tripId,
          assignedDriverId: driver.id, lastStatusChange: now
        }
      });

      txAssignments.push({
        assignmentId, tripId, truckRequestId, vehicle, driver,
        farePerTruck: truckRequest.pricePerTruck
      });
    }

    const updatedOrder = await tx.order.update({
      where: { id: hold.orderId },
      data: { trucksFilled: { increment: txAssignments.length } },
      select: { trucksFilled: true, totalTrucks: true }
    });
    const newStatus: OrderStatus =
      updatedOrder.trucksFilled >= updatedOrder.totalTrucks
        ? OrderStatus.fully_filled
        : OrderStatus.partially_filled;
    await tx.order.update({
      where: { id: hold.orderId },
      data: { status: newStatus }
    });

    return { assignments: txAssignments, newTrucksFilled: updatedOrder.trucksFilled, newStatus };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

// ---------------------------------------------------------------------------
// Step 5: Socket.IO + FCM notifications + timeout scheduling
// ---------------------------------------------------------------------------
async function notifyAssignmentParties(
  txAssignments: Array<{
    assignmentId: string; tripId: string; truckRequestId: string;
    vehicle: ConfirmVehicleSelect; driver: ConfirmDriverSelect; farePerTruck: number;
  }>,
  order: ConfirmOrderShape,
  transporterId: string
): Promise<void> {
  const DRIVER_TIMEOUT_MS = HOLD_CONFIG.driverAcceptTimeoutMs;
  const now = new Date().toISOString();

  // Log all assignments for debugging
  for (const assignment of txAssignments) {
    logger.info(
      `   ✅ Assignment created: ${assignment.vehicle.vehicleNumber} → ${assignment.driver.name} (Trip: ${assignment.tripId.substring(0, 8)})`
    );
  }

  // Individual trip_assigned events (backward compatible with current Android app)
  for (const assignment of txAssignments) {
    const driverNotification = {
      type: 'trip_assigned',
      assignmentId: assignment.assignmentId,
      tripId: assignment.tripId,
      orderId: order.id,
      truckRequestId: assignment.truckRequestId,
      pickup: order.pickup,
      drop: order.drop,
      routePoints: order.routePoints,
      vehicleNumber: assignment.vehicle.vehicleNumber,
      farePerTruck: assignment.farePerTruck,
      distanceKm: order.distanceKm,
      customerName: order.customerName,
      customerPhone: maskPhoneForExternal(order.customerPhone),
      assignedAt: now,
      expiresAt: new Date(Date.now() + DRIVER_TIMEOUT_MS).toISOString(),
      message: `New trip assigned! ${order.pickup.address} → ${order.drop.address}`
    };
    socketService.emitToUser(assignment.driver.id, SocketEvent.TRIP_ASSIGNED, driverNotification);
  }
  logger.info(`   📢 Individual trip_assigned events sent to ${txAssignments.length} driver(s) (backward compatible)`);

  // Individual per-driver FCM push (backup when Socket.IO is down)
  for (const assignment of txAssignments) {
    const driverNotificationFcm = {
      type: 'trip_assigned',
      assignmentId: assignment.assignmentId,
      tripId: assignment.tripId,
      orderId: order.id,
      truckRequestId: assignment.truckRequestId,
      pickupAddress: order.pickup.address,
      pickupCity: order.pickup.city || '',
      pickupLat: String(order.pickup.lat ?? order.pickup.latitude ?? 0),
      pickupLng: String(order.pickup.lng ?? order.pickup.longitude ?? 0),
      dropAddress: order.drop.address,
      dropCity: order.drop.city || '',
      dropLat: String(order.drop.lat ?? order.drop.latitude ?? 0),
      dropLng: String(order.drop.lng ?? order.drop.longitude ?? 0),
      vehicleNumber: assignment.vehicle.vehicleNumber,
      fare: String(assignment.farePerTruck ?? 0),
      distanceKm: String(order.distanceKm ?? 0),
      customerName: order.customerName || '',
      customerPhone: maskPhoneForExternal(order.customerPhone),
      assignedAt: now,
      expiresAt: new Date(Date.now() + DRIVER_TIMEOUT_MS).toISOString()
    };
    queueService.queuePushNotification(assignment.driver.id, {
      title: '🚛 New Trip Assigned!',
      body: `${order.pickup.address} → ${order.drop.address}`,
      data: driverNotificationFcm
    }).catch(err => {
      logger.warn(`FCM: trip_assigned push failed for driver ${assignment.driver.id}`, err);
    });
  }
  logger.info(`   📱 Individual FCM pushed to ${txAssignments.length} driver(s)`);

  // Schedule timeout jobs for each driver (independent timeouts)
  // FIX #44: Wrap each scheduling call in try/catch so a failure is logged at
  // error level. Without this, a Redis outage silently drops the timeout,
  // leaving the assignment stuck in 'pending' until the 2-min reconciliation sweep.
  for (const assignment of txAssignments) {
    const assignmentTimerData = {
      assignmentId: assignment.assignmentId,
      tripId: assignment.tripId,
      driverId: assignment.driver.id,
      driverName: assignment.driver.name,
      transporterId,
      vehicleId: assignment.vehicle.id,
      vehicleNumber: assignment.vehicle.vehicleNumber,
      orderId: order.id,
      truckRequestId: assignment.truckRequestId,
      createdAt: now
    };
    try {
      await queueService.scheduleAssignmentTimeout(assignmentTimerData, DRIVER_TIMEOUT_MS);
      logger.info(`   Timeout scheduled: ${assignment.assignmentId} (${assignment.vehicle.vehicleNumber} -> ${assignment.driver.name}) [${DRIVER_TIMEOUT_MS / 1000}s]`);
    } catch (timeoutErr: unknown) {
      // Non-fatal: L3 DB reconciliation will catch within 2 minutes
      const errMsg = timeoutErr instanceof Error ? timeoutErr.message : String(timeoutErr);
      logger.error('Assignment timeout scheduling FAILED', {
        assignmentId: assignment.assignmentId,
        tripId: assignment.tripId,
        driverId: assignment.driver.id,
        error: errMsg,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Step 6: Mark hold as confirmed in ledger and broadcast availability
// FIX #5: Retry with exponential backoff + compensation on final failure.
// Industry standard (Stripe): Saga pattern with compensation.
// Industry standard (Uber): State mutations in same TX, side effects in retry phase.
// ---------------------------------------------------------------------------

/** Retry backoff delays in ms: 500ms, 1000ms, 2000ms */
const FINALIZE_RETRY_DELAYS_MS = [500, 1000, 2000] as const;

async function finalizeHoldConfirmation(
  holdId: string,
  orderId: string,
  broadcastFn: (orderId: string) => void
): Promise<void> {
  // Customer NOT notified during hold — only on driver ACCEPT (PRD 7777)
  let lastError: unknown = null;

  for (let attempt = 0; attempt < FINALIZE_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await prismaClient.truckHoldLedger.update({
        where: { holdId },
        data: { status: 'confirmed', confirmedAt: new Date(), terminalReason: null }
      });
      // Success — broadcast and return
      broadcastFn(orderId);
      return;
    } catch (err: unknown) {
      lastError = err;
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`[TruckHold] finalizeHoldConfirmation attempt ${attempt + 1}/${FINALIZE_RETRY_DELAYS_MS.length} failed`, {
        holdId, orderId, error: errMsg
      });
      // Wait before next attempt (exponential backoff)
      if (attempt < FINALIZE_RETRY_DELAYS_MS.length - 1) {
        await new Promise(resolve => setTimeout(resolve, FINALIZE_RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  // All retries exhausted — compensation path
  const errMsg = lastError instanceof Error ? (lastError as Error).message : String(lastError);
  logger.error(`[TruckHold] CRITICAL: finalizeHoldConfirmation failed after ${FINALIZE_RETRY_DELAYS_MS.length} retries`, {
    holdId, orderId, error: errMsg
  });

  // Mark hold with needsFinalization flag so cleanup skips it.
  // Uses terminalReason as the flag since no schema change is needed.
  await prismaClient.truckHoldLedger.update({
    where: { holdId },
    data: { status: 'finalized', terminalReason: 'NEEDS_FINALIZATION' }
  }).catch((flagErr: unknown) => {
    const flagErrMsg = flagErr instanceof Error ? flagErr.message : String(flagErr);
    logger.error('[TruckHold] CRITICAL: Could not set needsFinalization flag', {
      holdId, error: flagErrMsg
    });
  });

  // Queue compensation job for async retry
  queueService.enqueue('hold:finalize-retry', {
    holdId,
    orderId,
    retriedAt: new Date().toISOString(),
  }).catch((qErr: unknown) => {
    const qErrMsg = qErr instanceof Error ? qErr.message : String(qErr);
    logger.error('[TruckHold] CRITICAL: Could not enqueue finalize-retry compensation job', {
      holdId, error: qErrMsg
    });
  });
}

// ---------------------------------------------------------------------------
// Step 7: Build the success response
// ---------------------------------------------------------------------------
function formatConfirmationResponse(
  txResult: {
    assignments: Array<{ assignmentId: string; tripId: string; vehicle: ConfirmVehicleSelect; driver: ConfirmDriverSelect }>;
    newTrucksFilled: number;
    newStatus: OrderStatus;
  },
  order: ConfirmOrderShape
): {
  success: true;
  message: string;
  assignmentIds: string[];
  tripIds: string[];
} {
  const assignmentIds = txResult.assignments.map(a => a.assignmentId);
  const tripIds = txResult.assignments.map(a => a.tripId);

  logger.info(`╔══════════════════════════════════════════════════════════════╗`);
  logger.info(`║  ✅ HOLD CONFIRMED SUCCESSFULLY                              ║`);
  logger.info(`╠══════════════════════════════════════════════════════════════╣`);
  logger.info(`║  Assignments: ${assignmentIds.length}`);
  logger.info(`║  Order progress: ${txResult.newTrucksFilled}/${order.totalTrucks}`);
  logger.info(`║  Status: ${txResult.newStatus}`);
  logger.info(`╚══════════════════════════════════════════════════════════════╝`);

  return {
    success: true,
    message: `${txResult.assignments.length} truck(s) assigned successfully!`,
    assignmentIds,
    tripIds
  };
}

// ---------------------------------------------------------------------------
// Step 8: Compensating actions / error translation
// ---------------------------------------------------------------------------
function handleAssignmentFailure(error: unknown): {
  success: false;
  message: string;
} {
  const msg = error instanceof Error ? error.message : String(error);
  const prismaError = error as { code?: string; meta?: { target?: string[] } };
  logger.error(`[TruckHold] Error confirming with assignments: ${msg}`, error);

  // Prisma unique constraint violation (P2002)
  if (prismaError?.code === 'P2002') {
    const target = Array.isArray(prismaError?.meta?.target) ? prismaError.meta.target.join(', ') : '';
    if (target.includes('driverId')) {
      return { success: false, message: 'This driver already has an active assignment. Please choose a different driver.' };
    }
    return { success: false, message: `Duplicate assignment conflict (${target}). Please try again.` };
  }

  // Prisma serialization failure (P2034)
  if (prismaError?.code === 'P2034') {
    return { success: false, message: 'Another transaction is in progress. Please try again in a moment.' };
  }

  // Known thrown errors from within the transaction
  if (msg.startsWith('DRIVER_BUSY:')) {
    const parts = msg.split(':');
    return { success: false, message: `Driver ${parts[1] || ''} is already on a trip. Choose a different driver.` };
  }
  if (msg.startsWith('VEHICLE_UNAVAILABLE:')) {
    return { success: false, message: 'Vehicle is no longer available. Please go back and select another vehicle.' };
  }
  if (msg.startsWith('TRUCK_REQUEST_NOT_HELD:') || msg.startsWith('TRUCK_REQUEST_STATE_CHANGED:')) {
    return { success: false, message: 'Hold expired or was taken by another transporter. Please try again.' };
  }
  if (msg === 'ORDER_NOT_FOUND' || msg.startsWith('TRUCK_REQUEST_NOT_FOUND')) {
    return { success: false, message: 'This order is no longer available.' };
  }
  // FIX #38: Handle terminal order status detected inside TX
  if (msg.startsWith('ORDER_TERMINAL:')) {
    return { success: false, message: 'This order has been cancelled or completed. Cannot confirm.' };
  }

  return { success: false, message: 'Failed to confirm. Please try again.' };
}
