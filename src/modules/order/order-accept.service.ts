/**
 * =============================================================================
 * ORDER ACCEPT SERVICE - Truck request acceptance flow
 * =============================================================================
 *
 * Extracted from OrderService (Phase 9 of decomposition).
 * Handles the full accept-truck-request flow: transporter assigns a vehicle +
 * driver to a truck request. Uses serializable transactions with CAS guards
 * and automatic retry on contention.
 *
 * Cross-references:
 *   - clearProgressiveStepTimers (order-timer.service.ts)
 *   - clearCustomerActiveBroadcast (order-broadcast.service.ts)
 *   - orderExpiryTimerKey (order-timer.service.ts)
 *
 * IMPORTANT: This file must NOT import from order.service.ts to avoid
 * circular dependencies. All dependencies flow one direction:
 *   order.service.ts -> order-accept.service.ts
 * =============================================================================
 */

import { v4 as uuidv4 } from 'uuid';
import { Prisma } from '@prisma/client';
import { OrderRecord } from '../../shared/database/db';
import { prismaClient, withDbTimeout, OrderStatus, AssignmentStatus } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, SocketEvent } from '../../shared/services/socket.service';
import { queueService } from '../../shared/services/queue.service';
import { redisService } from '../../shared/services/redis.service';
import { metrics } from '../../shared/monitoring/metrics.service';
import { AppError } from '../../shared/types/error.types';
import { maskPhoneForExternal } from '../../shared/utils/pii.utils';
import { clearProgressiveStepTimers } from './order-timer.service';
import { clearCustomerActiveBroadcast } from './order-broadcast.service';
import { orderExpiryTimerKey } from './order-timer.service';
import { HOLD_CONFIG } from '../../core/config/hold-config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AcceptTruckRequestResult {
  success: boolean;
  assignmentId?: string;
  tripId?: string;
  message: string;
  /** H-19: true when the assigned driver appears offline at time of assignment */
  driverOfflineWarning?: boolean;
}

// ---------------------------------------------------------------------------
// Main accept function
// ---------------------------------------------------------------------------

/**
 * Accept a truck request (transporter assigns vehicle + driver)
 *
 * Called when transporter accepts from the Captain app
 */
export async function acceptTruckRequest(
  truckRequestId: string,
  transporterId: string,
  vehicleId: string,
  driverId: string
): Promise<AcceptTruckRequestResult> {
  const MAX_RETRIES = 3;
  let txResult: {
    assignmentId: string;
    tripId: string;
    newTrucksFilled: number;
    newStatus: OrderRecord['status'];
    orderId: string;
    customerId: string;
    orderPickup: OrderRecord['pickup'];
    orderDrop: OrderRecord['drop'];
    orderDistanceKm: number;
    orderCustomerName: string;
    orderCustomerPhone: string;
    orderTotalTrucks: number;
    truckRequestPricePerTruck: number;
    vehicleNumber: string;
    vehicleType: string;
    vehicleSubtype: string;
    vehicleKey: string;
    driverName: string;
    driverPhone: string;
    transporterName: string;
    transporterPhone: string;
    now: string;
    driverOfflineWarning: boolean;
  } | null = null;

  // Cross-path vehicle mutex (H-11 fix): Acquire a distributed lock on vehicleId
  // before entering the accept flow. This prevents the same vehicle from being
  // concurrently assigned via order-accept AND broadcast-accept paths.
  const vehicleLockKey = `lock:vehicle:${vehicleId}`;
  const vehicleLockHolder = `order:${Date.now()}:${process.pid}`;
  const vehicleLock = await redisService.acquireLock(vehicleLockKey, vehicleLockHolder, 15);
  if (!vehicleLock.acquired) {
    throw new AppError(409, 'VEHICLE_LOCKED', 'Vehicle is being assigned in another operation');
  }

  try {

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // withDbTimeout enforces statement_timeout=6s inside the TX — tighter budget for accept flow.
      txResult = await withDbTimeout(async (tx) => {
        // ----- Read all data inside the transaction -----
        const truckRequest = await tx.truckRequest.findUnique({
          where: { id: truckRequestId }
        });

        if (!truckRequest) {
          throw new Error('EARLY_RETURN:Truck request not found');
        }

        if (truckRequest.status !== 'searching') {
          throw new Error(`EARLY_RETURN:Request already ${truckRequest.status}`);
        }

        const order = await tx.order.findUnique({
          where: { id: truckRequest.orderId }
        });
        if (!order) {
          throw new Error('EARLY_RETURN:Order not found');
        }

        const transporter = await tx.user.findUnique({
          where: { id: transporterId },
          select: { id: true, name: true, businessName: true, phone: true, role: true, isActive: true }
        });

        // C-09 FIX: Validate transporter exists and is active
        if (!transporter) {
          throw new Error('EARLY_RETURN:Transporter account not found');
        }
        if (transporter.role !== 'transporter') {
          throw new Error('EARLY_RETURN:Only transporters can accept truck requests');
        }
        if (transporter.isActive === false) {
          metrics.incrementCounter('assignment_blocked_total', { reason: 'transporter_suspended' });
          throw new Error('EARLY_RETURN:Transporter account is suspended');
        }

        const vehicle = await tx.vehicle.findUnique({
          where: { id: vehicleId }
        });
        if (!vehicle) {
          throw new Error('EARLY_RETURN:Vehicle not found');
        }
        if (vehicle.transporterId !== transporterId) {
          throw new Error('EARLY_RETURN:Vehicle does not belong to your fleet');
        }

        // Phase 6 guard: Vehicle must be available (not already on a trip)
        if (vehicle.status !== 'available') {
          metrics.incrementCounter('assignment_blocked_total', { reason: 'vehicle_busy' });
          throw new Error(
            `EARLY_RETURN:Vehicle ${vehicle.vehicleNumber} is currently ${vehicle.status}`
          );
        }
        if (vehicle.currentTripId) {
          metrics.incrementCounter('assignment_blocked_total', { reason: 'vehicle_on_trip' });
          throw new Error(
            `EARLY_RETURN:Vehicle ${vehicle.vehicleNumber} is already on trip ${vehicle.currentTripId}`
          );
        }

        const driver = await tx.user.findUnique({
          where: { id: driverId }
        });
        if (!driver) {
          throw new Error('EARLY_RETURN:Driver not found');
        }
        if (driver.transporterId !== transporterId) {
          throw new Error('EARLY_RETURN:Driver does not belong to your fleet');
        }

        // Phase 6 guard: Driver must NOT have an active assignment already
        const existingDriverAssignment = await tx.assignment.findFirst({
          where: {
            driverId,
            status: { in: ['pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit'] }
          },
          select: { id: true, tripId: true, orderId: true }
        });
        if (existingDriverAssignment) {
          metrics.incrementCounter('assignment_blocked_total', { reason: 'driver_busy' });
          throw new Error(
            `EARLY_RETURN:Driver ${driver.name} is already assigned to an active trip`
          );
        }

        // FIX #32: WARN-ONLY presence check — Weelo allows pre-assignment of
        // en-route drivers (transporter may assign a driver traveling to the depot
        // who is not yet connected to the app). This is informational only.
        // H-19: Track offline status so API response can include a warning flag
        // for the transporter app to show a confirmation dialog.
        let driverOfflineWarning = false;
        try {
          const { driverService: _driverSvc }: typeof import('../driver/driver.service') = require('../driver/driver.service');
          const isDriverOnline = await _driverSvc.isDriverOnline(driverId);
          if (!isDriverOnline) {
            driverOfflineWarning = true;
            logger.warn('[ACCEPT] Driver may be offline', { driverId, orderId: truckRequest.orderId });
            metrics.incrementCounter('assignment_driver_offline_warn');
            // Continue anyway — Weelo allows pre-assignment of en-route drivers
          }
        } catch (presenceErr: unknown) {
          // Presence check is best-effort — never block the accept flow
          logger.warn('[ACCEPT] Driver presence check failed (non-blocking)', {
            driverId,
            error: presenceErr instanceof Error ? presenceErr.message : String(presenceErr)
          });
        }

        // Verify vehicle type matches
        if (vehicle.vehicleType !== truckRequest.vehicleType) {
          throw new Error(
            `EARLY_RETURN:Vehicle type mismatch. Request requires ${truckRequest.vehicleType}, vehicle is ${vehicle.vehicleType}`
          );
        }

        // Phase 6 guard: Verify vehicle SUBTYPE matches
        if (vehicle.vehicleSubtype !== truckRequest.vehicleSubtype) {
          throw new Error(
            `EARLY_RETURN:Vehicle subtype mismatch. Request requires ${truckRequest.vehicleSubtype}, vehicle is ${vehicle.vehicleSubtype}`
          );
        }

        // ----- Optimistic lock: update truck request only if still 'searching' -----
        const truckRequestUpdate = await tx.truckRequest.updateMany({
          where: { id: truckRequestId, status: 'searching' },
          data: {
            status: 'assigned',
            assignedTransporterId: transporterId,
            assignedTransporterName: transporter.name || transporter.businessName || '',
            assignedVehicleId: vehicleId,
            assignedVehicleNumber: vehicle.vehicleNumber,
            assignedDriverId: driverId,
            assignedDriverName: driver.name,
            assignedDriverPhone: driver.phone,
            tripId: uuidv4(),
            assignedAt: new Date().toISOString()
          }
        });

        if (truckRequestUpdate.count === 0) {
          throw new Error('EARLY_RETURN:This request is no longer available');
        }

        // Fetch the updated truck request to get generated tripId
        const updatedTruckRequest = await tx.truckRequest.findUnique({
          where: { id: truckRequestId }
        });
        const tripId = updatedTruckRequest!.tripId!;
        const assignmentId = uuidv4();
        const now = new Date().toISOString();

        // ----- Create assignment record inside transaction -----
        await tx.assignment.create({
          data: {
            id: assignmentId,
            bookingId: null,  // New multi-truck system uses orderId + truckRequestId, not legacy Booking
            truckRequestId,
            orderId: truckRequest.orderId,
            transporterId,
            transporterName: transporter.name || '',
            vehicleId,
            vehicleNumber: vehicle.vehicleNumber,
            vehicleType: vehicle.vehicleType,
            vehicleSubtype: vehicle.vehicleSubtype,
            driverId,
            driverName: driver.name,
            driverPhone: driver.phone || '',
            tripId,
            status: AssignmentStatus.pending,
            assignedAt: now
          }
        });

        // Fix B8: Atomic CAS increment + guard -- combines increment and status-check
        // Uses updateMany with CAS on trucksFilled to prevent two-write race.
        const orderUpdate = await tx.order.updateMany({
          where: {
            id: order.id,
            trucksFilled: order.trucksFilled,
            status: { notIn: ['cancelled', 'expired', 'fully_filled'] },
            expiresAt: { gt: new Date().toISOString() }
          },
          data: {
            trucksFilled: { increment: 1 }
          }
        });

        if (orderUpdate.count === 0) {
          throw new Error('RETRY:Order state changed concurrently');
        }

        const newTrucksFilled = order.trucksFilled + 1;
        const newStatus = newTrucksFilled >= order.totalTrucks
          ? OrderStatus.fully_filled
          : OrderStatus.partially_filled;

        // Single atomic status update with CAS guard
        await tx.order.updateMany({
          where: { id: order.id, status: { notIn: ['cancelled', 'expired'] } },
          data: { status: newStatus, stateChangedAt: new Date() }
        });

        // C-04 FIX: Set vehicle to on_hold ATOMICALLY inside the transaction.
        // BEFORE: Vehicle stayed 'available' for 0-45s until driver accepted → double-booking window.
        // NOW: Vehicle becomes 'on_hold' immediately → matches assignment.service.ts:249-260 pattern.
        // Vehicle transitions on_hold → in_transit in assignment.acceptAssignment() when driver accepts.
        await tx.vehicle.updateMany({
          where: {
            id: vehicleId,
            status: 'available'  // CAS guard: only hold if still available
          },
          data: {
            status: 'on_hold',
            currentTripId: tripId,
            assignedDriverId: driverId,
            lastStatusChange: new Date().toISOString()
          }
        });

        // Parse JSON fields for notification use outside the transaction
        let pickup: unknown;
        try {
          pickup = typeof order.pickup === 'string'
            ? JSON.parse(order.pickup as string)
            : order.pickup;
        } catch {
          pickup = order.pickup;
        }
        let drop: unknown;
        try {
          drop = typeof order.drop === 'string'
            ? JSON.parse(order.drop as string)
            : order.drop;
        } catch {
          drop = order.drop;
        }

        return {
          assignmentId,
          tripId,
          newTrucksFilled,
          newStatus,
          orderId: order.id,
          customerId: order.customerId,
          orderPickup: pickup as OrderRecord['pickup'],
          orderDrop: drop as OrderRecord['drop'],
          orderDistanceKm: order.distanceKm,
          orderCustomerName: order.customerName,
          orderCustomerPhone: maskPhoneForExternal(order.customerPhone),
          orderTotalTrucks: order.totalTrucks,
          truckRequestPricePerTruck: truckRequest.pricePerTruck,
          vehicleNumber: vehicle.vehicleNumber,
          vehicleType: vehicle.vehicleType,
          vehicleSubtype: vehicle.vehicleSubtype,
          vehicleKey: vehicle.vehicleKey || '',
          driverName: driver.name,
          driverPhone: driver.phone || '',
          transporterName: transporter.name || transporter.businessName || '',
          transporterPhone: transporter.phone || '',
          now,
          driverOfflineWarning
        };
      // Fix B10(F-2-12): Serializable isolation guarantees fresh reads on retry.
      // When a serialization conflict occurs (P2034/40001), the next retry re-reads
      // the order inside the transaction and sees the latest committed state.
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeoutMs: 6000 });

      // Transaction succeeded, break out of retry loop
      break;
    } catch (error: unknown) {
      const errMessage = error instanceof Error ? error.message : String(error);
      const errCode = (error as { code?: string })?.code;

      // Handle EARLY_RETURN errors (validation failures — no retry)
      if (errMessage.startsWith('EARLY_RETURN:')) {
        return {
          success: false,
          message: errMessage.replace('EARLY_RETURN:', '')
        };
      }

      // Handle retryable serialization conflicts (P2034 / 40001)
      const isRetryableContention =
        errCode === 'P2034' ||
        errCode === '40001' ||
        errMessage.startsWith('RETRY:');

      if (!isRetryableContention || attempt >= MAX_RETRIES) {
        logger.error(`acceptTruckRequest failed after ${attempt} attempt(s)`, {
          truckRequestId,
          vehicleId,
          driverId,
          error: errMessage
        });
        throw error;
      }

      logger.warn('[OrderAccept] Contention retry', {
        truckRequestId,
        vehicleId,
        driverId,
        attempt,
        maxAttempts: MAX_RETRIES,
        code: errCode || 'RETRY'
      });
    }
  }

  if (!txResult) {
    return {
      success: false,
      message: 'Unable to finalize assignment after retries'
    };
  }

  // =====================================================================
  // All notifications OUTSIDE the transaction (side-effects are not
  // rolled back on serialization retry, so they must happen after commit)
  // =====================================================================

  const {
    assignmentId,
    tripId,
    newTrucksFilled,
    newStatus,
    orderId,
    customerId,
    orderPickup,
    orderDrop,
    orderDistanceKm,
    orderCustomerName,
    orderCustomerPhone,
    orderTotalTrucks,
    truckRequestPricePerTruck,
    vehicleNumber,
    vehicleType,
    vehicleSubtype,
    vehicleKey,
    driverName,
    driverPhone,
    transporterName,
    transporterPhone,
    now,
    driverOfflineWarning
  } = txResult;

  metrics.incrementCounter('assignment_success_total');
  logger.info(`Truck request ${truckRequestId} accepted`);
  logger.info(`   Vehicle: ${vehicleNumber} (${vehicleType})`);
  logger.info(`   Driver: ${driverName} (${driverPhone})`);
  logger.info(`   Order progress: ${newTrucksFilled}/${orderTotalTrucks}`);

  // F-H6 FIX: Schedule 45s assignment timeout immediately after creation
  // Industry standard (Uber): Every assignment gets immediate timeout scheduling.
  // Without this, vehicles stay stuck up to 3.5 min until the DB reconciliation catches it.
  try {
    const timeoutMs = HOLD_CONFIG?.driverAcceptTimeoutMs || 45_000;
    await queueService.scheduleAssignmentTimeout({
      assignmentId,
      driverId,
      driverName: driverName || 'Driver',
      transporterId,
      vehicleId,
      vehicleNumber: vehicleNumber || '',
      orderId,
      tripId,
      createdAt: new Date().toISOString(),
    }, timeoutMs);
  } catch (err: unknown) {
    // Non-fatal: DB reconciliation will catch within 2 minutes
    logger.error('[ORDER ACCEPT] Failed to schedule assignment timeout', {
      assignmentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // C-04 FIX: Redis + fleet cache sync after vehicle set to on_hold in the transaction.
  if (vehicleKey) {
    try {
      const { onVehicleTransition } = require('../../shared/services/vehicle-lifecycle.service');
      await onVehicleTransition(
        transporterId, vehicleId, vehicleKey,
        'available', 'on_hold', 'orderAccept'
      );
    } catch (redisErr: unknown) {
      logger.warn('[OrderAccept] Vehicle transition sync failed (non-fatal)', {
        vehicleId,
        error: redisErr instanceof Error ? redisErr.message : String(redisErr)
      });
    }
  }

  // ============== NOTIFY DRIVER ==============
  const driverNotification = {
    type: 'trip_assigned',
    assignmentId,
    tripId,
    orderId,
    truckRequestId,
    pickup: orderPickup,
    drop: orderDrop,
    vehicleNumber,
    farePerTruck: truckRequestPricePerTruck,
    distanceKm: orderDistanceKm,
    customerName: orderCustomerName,
    customerPhone: orderCustomerPhone,
    assignedAt: now,
    message: `New trip assigned! ${orderPickup.address} → ${orderDrop.address}`
  };

  emitToUser(driverId, SocketEvent.TRIP_ASSIGNED, driverNotification);
  logger.info(`Notified driver ${driverName} about trip assignment`);

  // M-09 FIX: Use queued push notification (consistent with assignment.service.ts pattern)
  // BEFORE: Direct sendPushNotification() — bypasses queue, no retry, no rate limiting.
  // NOW: queuePushNotification() — matches every other FCM call in the codebase.
  queueService.queuePushNotification(driverId, {
    title: 'New Trip Assigned!',
    body: `${orderPickup.city || orderPickup.address} → ${orderDrop.city || orderDrop.address}`,
    data: {
      type: 'trip_assigned',
      tripId,
      assignmentId,
      orderId,
      driverName: driverName || '',
      vehicleNumber: vehicleNumber || '',
      vehicleType: vehicleType || '',
      status: 'trip_assigned'
    }
  }).catch((err: unknown) => {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn(`FCM to driver failed: ${errorMessage}`);
  });

  // ============== NOTIFY CUSTOMER - PRD 7777: ONLY ON DRIVER ACCEPT ==============
  // F-H8: INTENTIONAL — Order-accept path does NOT send customer notification per PRD 7777.
  // Broadcast-accept path DOES send full truck_confirmed notification.
  // This is a product decision, not a bug. To enable customer notification on order-accept,
  // set FF_ORDER_ACCEPT_CUSTOMER_NOTIFICATION=true in environment.
  //
  // REMOVED: Customer notification during truck hold/assignment
  // Customer should ONLY be notified when driver accepts - see assignment.service.ts
  // The customer will be notified in assignment.acceptAssignment() when driver accepts
  //
  // const customerEventId = uuidv4();
  // const customerNotification = {
  //   type: 'truck_confirmed',
  //   orderId,
  //   truckRequestId,
  //   assignmentId,
  //   truckNumber: newTrucksFilled,
  //   totalTrucks: orderTotalTrucks,
  //   trucksConfirmed: newTrucksFilled,
  //   remainingTrucks: orderTotalTrucks - newTrucksFilled,
  //   isFullyFilled: newTrucksFilled >= orderTotalTrucks,
  //   driver: {
  //     name: driverName,
  //     phone: driverPhone
  //   },
  //   vehicle: {
  //     number: vehicleNumber,
  //     type: vehicleType,
  //     subtype: vehicleSubtype
  //   },
  //   transporter: {
  //     name: transporterName,
  //     phone: transporterPhone
  //   },
  //   message: `Truck ${newTrucksFilled}/${orderTotalTrucks} confirmed!`,
  //   eventId: customerEventId,
  //   emittedAt: now
  // };
  // emitToUser(customerId, 'truck_confirmed', customerNotification);
  // logger.info(`Notified customer - ${newTrucksFilled}/${orderTotalTrucks} trucks confirmed`);
  //
  // Phase 3 parity: keep searching dialog in sync with backend fill progress.
  emitToUser(customerId, 'trucks_remaining_update', {
    orderId,
    trucksNeeded: orderTotalTrucks,
    trucksFilled: newTrucksFilled,
    trucksRemaining: Math.max(orderTotalTrucks - newTrucksFilled, 0),
    isFullyFilled: newTrucksFilled >= orderTotalTrucks,
    timestamp: now,
    emittedAt: now
  });
  //
  // Lifecycle update whenever order status changes due to accept flow.
  // emitToUser(customerId, 'broadcast_state_changed', this.withEventMeta({
  //   orderId,
  //   status: newStatus,
  //   dispatchState: 'dispatched',
  //   eventVersion: 1,
  //   serverTimeMs: Date.now(),
  //   stateChangedAt: now
  // }, customerEventId));

  // PRD 7777: Notify customer when all trucks are filled so searching screen transitions out.
  if (newStatus === 'fully_filled') {
    const latestAssignment = {
      assignmentId,
      tripId,
      vehicleNumber,
      driverName,
      driverPhone
    };

    // M-21 FIX: Include ALL assignments for this order, not just the latest one.
    // Customer app needs the full list to display all assigned trucks.
    let allAssignments: Array<{
      id: string; tripId: string; vehicleNumber: string;
      driverName: string | null; driverPhone: string; status: string;
    }> = [];
    try {
      allAssignments = await prismaClient.assignment.findMany({
        where: { orderId },
        select: {
          id: true, tripId: true, vehicleNumber: true,
          driverName: true, driverPhone: true, status: true,
        },
      });
    } catch (err: unknown) {
      // Non-fatal: fall back to just the latest assignment
      logger.warn('[OrderAccept] Failed to fetch all assignments for fully_filled event', {
        orderId, error: err instanceof Error ? err.message : String(err),
      });
    }

    emitToUser(customerId, 'booking_fully_filled', {
      orderId,
      trucksNeeded: orderTotalTrucks,
      trucksFilled: newTrucksFilled,
      filledAt: now,
      emittedAt: now,
      latestAssignment,
      assignments: allAssignments.length > 0
        ? allAssignments.map(a => ({
            assignmentId: a.id,
            tripId: a.tripId,
            vehicleNumber: a.vehicleNumber,
            driverName: a.driverName || '',
            driverPhone: a.driverPhone,
            status: a.status,
          }))
        : [latestAssignment]
    });
  }

  // Push notification to customer - REMOVED per PRD 7777
  // Customer will be notified when driver accepts
  // sendPushNotification(customerId, {
  //   title: `Truck ${newTrucksFilled}/${orderTotalTrucks} Confirmed!`,
  //   body: `${vehicleNumber} (${driverName}) assigned`,
  //   data: {
  //     type: 'truck_confirmed',
  //     orderId,
  //     trucksConfirmed: newTrucksFilled,
  //     totalTrucks: orderTotalTrucks
  //   }
  // }).catch((err: unknown) => {
  //   const errorMessage = err instanceof Error ? err.message : String(err);
  //   logger.warn(`FCM to customer failed: ${errorMessage}`);
  // });

  // If fully filled, cancel expiry timer and clear active key
  if (newStatus === 'fully_filled') {
    await redisService.cancelTimer(orderExpiryTimerKey(orderId)).catch(() => { });
    await clearProgressiveStepTimers(orderId).catch(() => { });
    await clearCustomerActiveBroadcast(customerId);
    logger.info(`Order ${orderId} fully filled! All ${orderTotalTrucks} trucks assigned.`);
  }

  return {
    success: true,
    assignmentId,
    tripId,
    message: `Successfully assigned. ${newTrucksFilled}/${orderTotalTrucks} trucks filled.`,
    // H-19: Include offline warning so transporter app can show confirmation dialog
    ...(driverOfflineWarning ? { driverOfflineWarning: true } : {})
  };

  } finally {
    // H-11: Always release the vehicle mutex
    await redisService.releaseLock(vehicleLockKey, vehicleLockHolder).catch(() => {});
  }
}
