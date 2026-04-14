/**
 * =============================================================================
 * POST-ACCEPT SIDE EFFECTS — Centralized handler for post-driver-acceptance
 * =============================================================================
 *
 * After a driver accepts an assignment, several side effects must fire:
 * 1. Vehicle Redis availability update (on_hold -> in_transit)
 * 2. Tracking initialization
 * 3. GPS seeding from driver location Redis key
 * 4. Customer notification (Socket + FCM)
 * 5. Transporter notification (FCM)
 *
 * This module is imported lazily to avoid circular dependencies.
 * =============================================================================
 */

import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PostAcceptContext {
  assignmentId: string;
  driverId: string;
  vehicleId: string;
  vehicleNumber: string;
  tripId: string;
  bookingId: string;
  orderId?: string;
  transporterId: string;
  driverName: string;
}

// ---------------------------------------------------------------------------
// Lazy imports to avoid circular dependencies
// ---------------------------------------------------------------------------

function getLiveAvailabilityService() {
  return require('../../shared/services/live-availability.service').liveAvailabilityService;
}

function getOnVehicleTransition() {
  return require('../../shared/services/vehicle-lifecycle.service').onVehicleTransition;
}

function getTrackingService() {
  return require('../tracking/tracking.service').trackingService;
}

function getSocketService() {
  return require('../../shared/services/socket.service');
}

function getQueueService() {
  return require('../../shared/services/queue.service').queueService;
}

function getPrismaClient() {
  return require('../../shared/database/prisma.service').prismaClient;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GPS_SEED_TTL_SECONDS = 86400; // 24 hours

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Apply all post-accept side effects after a driver accepts an assignment.
 *
 * Each step is wrapped individually so one failure does not block others.
 * All errors are logged but never thrown — the accept itself already succeeded.
 */
export async function applyPostAcceptSideEffects(ctx: PostAcceptContext): Promise<void> {
  const tag = `[POST_ACCEPT:${ctx.assignmentId}]`;
  logger.info(`${tag} Applying post-accept side effects`, {
    driverId: ctx.driverId,
    vehicleId: ctx.vehicleId,
    tripId: ctx.tripId,
    bookingId: ctx.bookingId,
  });

  // 1. Vehicle Redis availability update (on_hold -> in_transit)
  try {
    const prisma = getPrismaClient();
    const vehicle = await prisma.vehicle.findUnique({
      where: { id: ctx.vehicleId },
      select: { vehicleKey: true, transporterId: true, status: true },
    });

    if (vehicle && vehicle.vehicleKey) {
      const vehicleTransition = getOnVehicleTransition();
      await vehicleTransition(
        vehicle.transporterId, ctx.vehicleId, vehicle.vehicleKey,
        vehicle.status || 'on_hold', 'in_transit', 'postAcceptEffects'
      );
      logger.info(`${tag} Redis + fleet cache updated: ${vehicle.status} -> in_transit`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`${tag} Vehicle availability update failed (non-fatal)`, { error: message });
  }

  // 2. Tracking initialization
  try {
    const trackingSvc = getTrackingService();
    if (typeof trackingSvc.initializeTracking === 'function') {
      await trackingSvc.initializeTracking(
        ctx.tripId,
        ctx.driverId,
        ctx.vehicleNumber,
        ctx.bookingId,
        ctx.transporterId,
        ctx.vehicleId
      );
      logger.info(`${tag} Tracking initialized for trip ${ctx.tripId}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`${tag} Tracking initialization failed (non-fatal)`, { error: message });
  }

  // 3. GPS seeding from driver location Redis key
  try {
    const locationKey = `driver:location:${ctx.driverId}`;
    const raw = await redisService.get(locationKey);
    if (raw) {
      const location = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (location && location.latitude && location.longitude) {
        // F-M26 FIX: GPS staleness check — reject location older than 5 minutes (matches Path A)
        const GPS_MAX_AGE_MS = 5 * 60 * 1000;
        const locationAge = location.updatedAt
          ? Date.now() - new Date(location.updatedAt).getTime()
          : (location.timestamp ? Date.now() - location.timestamp : 0);

        if (locationAge > GPS_MAX_AGE_MS) {
          logger.warn(`${tag} Stale GPS for driver ${ctx.driverId}: ${Math.round(locationAge / 1000)}s old — skipping seed`);
        } else {
          const tripLocationKey = `driver:trip:${ctx.tripId}`;
          await redisService.setJSON(tripLocationKey, {
            tripId: ctx.tripId,
            driverId: ctx.driverId,
            vehicleNumber: ctx.vehicleNumber,
            latitude: location.latitude,
            longitude: location.longitude,
            speed: location.speed || 0,
            bearing: location.bearing || 0,
            status: 'driver_accepted',
            lastUpdated: new Date().toISOString(),
          }, GPS_SEED_TTL_SECONDS);
          logger.info(`${tag} GPS seeded from driver location: (${location.latitude}, ${location.longitude})`);
        }
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`${tag} GPS seeding failed (non-fatal)`, { error: message });
  }

  // 4. Customer notification (Socket + FCM)
  try {
    const socketMod = getSocketService();
    const queueSvc = getQueueService();

    // Find the customer — try booking first, fall back to order
    const prisma = getPrismaClient();
    let customerId: string | undefined;

    const booking = ctx.bookingId
      ? await prisma.booking.findUnique({
          where: { id: ctx.bookingId },
          select: { customerId: true },
        })
      : null;

    if (booking?.customerId) {
      customerId = booking.customerId;
    } else if (ctx.orderId) {
      const order = await prisma.order.findUnique({
        where: { id: ctx.orderId },
        select: { customerId: true },
      });
      customerId = order?.customerId;
    }

    if (customerId) {
      // F-H13 FIX: Use canonical SocketEvent enum (aligned with assignment-response.service.ts Path A)
      const { SocketEvent } = socketMod;
      const eventName = SocketEvent?.ASSIGNMENT_STATUS_CHANGED || 'assignment_status_changed';

      const entityId = ctx.bookingId || ctx.orderId;

      // Socket notification to customer
      socketMod.emitToUser(customerId, eventName, {
        assignmentId: ctx.assignmentId,
        driverName: ctx.driverName,
        vehicleNumber: ctx.vehicleNumber,
        tripId: ctx.tripId,
        bookingId: ctx.bookingId,
        orderId: ctx.orderId,
        status: 'driver_accepted',
        message: `Driver ${ctx.driverName} accepted with vehicle ${ctx.vehicleNumber}`,
      });

      // F-H13 FIX: Broadcast to booking/order room (matches Path A)
      if (entityId && typeof socketMod.emitToBooking === 'function') {
        socketMod.emitToBooking(entityId, eventName, {
          assignmentId: ctx.assignmentId,
          tripId: ctx.tripId,
          status: 'driver_accepted',
          vehicleNumber: ctx.vehicleNumber,
        });
      }

      // FCM push notification (queued)
      // F-H17 FIX: Customer app checks TYPE_DRIVER_ASSIGNED = "driver_assigned",
      // so FCM type must be 'driver_assigned' (not 'assignment_update') — matches Path A
      await queueSvc.queuePushNotification(customerId, {
        title: 'Driver Accepted!',
        body: `${ctx.driverName} is assigned to your trip with vehicle ${ctx.vehicleNumber}`,
        data: {
          type: 'driver_assigned',
          assignmentId: ctx.assignmentId,
          tripId: ctx.tripId,
          bookingId: ctx.bookingId,
          orderId: ctx.orderId,
          driverName: ctx.driverName,
          vehicleNumber: ctx.vehicleNumber,
          status: 'driver_accepted',
        },
      });
      logger.info(`${tag} Customer ${customerId} notified (socket + FCM)`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`${tag} Customer notification failed (non-fatal)`, { error: message });
  }

  // 5. Transporter notification (FCM)
  try {
    const queueSvc = getQueueService();

    await queueSvc.queuePushNotification(ctx.transporterId, {
      title: 'Driver Accepted Assignment',
      body: `${ctx.driverName} accepted the trip with vehicle ${ctx.vehicleNumber}`,
      data: {
        type: 'assignment_update',
        assignmentId: ctx.assignmentId,
        tripId: ctx.tripId,
        bookingId: ctx.bookingId,
        status: 'driver_accepted',
      },
    });
    logger.info(`${tag} Transporter ${ctx.transporterId} notified (FCM)`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`${tag} Transporter notification failed (non-fatal)`, { error: message });
  }

  logger.info(`${tag} Post-accept side effects complete`);
}
