/**
 * =============================================================================
 * CASCADE DISPATCH SERVICE - Auto-Reassign on Driver Decline/Timeout
 * =============================================================================
 *
 * Issue #19 + H-06: When a driver declines or times out (45s), automatically
 * cascade to the NEXT available driver in the transporter's fleet.
 * The transporter can still manually choose a different driver from the
 * Captain app if they want.
 *
 * RULES:
 * - MAX_CASCADE_RETRIES = 3 (configurable via env: MAX_CASCADE_RETRIES)
 * - 2-second delay between retries
 * - Cascades to next available driver (excludes already-tried drivers)
 * - Falls back to the same driver only if no other drivers are available
 * - If max retries reached, stop and let transporter handle manually
 * - The existing "Please reassign" notification to transporter still fires
 *
 * FLOW:
 * 1. Driver declines/times out -> handleDriverDecline() runs cleanup
 * 2. After cleanup, retrySameDriver() is called (name kept for backward compat)
 * 3. Add declined driver to Redis SET of tried drivers
 * 4. Query next available driver excluding tried ones
 * 5. Create new assignment + schedule 45s timeout
 * 6. If max retries reached or no drivers available, stop
 *
 * @author Weelo Team
 * =============================================================================
 */

import { v4 as uuidv4 } from 'uuid';
import { Prisma, AssignmentStatus, VehicleStatus } from '@prisma/client';
import { prismaClient } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { socketService, isUserConnectedAsync } from '../../shared/services/socket.service';
import { queueService } from '../../shared/services/queue.service';
import { HOLD_CONFIG } from '../../core/config/hold-config';
import { getErrorMessage } from '../../shared/utils/error.utils';

// =============================================================================
// CONFIGURATION
// =============================================================================

const MAX_CASCADE_RETRIES = parseInt(
  process.env.MAX_CASCADE_RETRIES || '3',
  10
);

/** Delay between cascade attempts in milliseconds */
const CASCADE_DELAY_MS = 2000;

/** Redis key prefix for cascade retry counter */
const CASCADE_RETRY_KEY = (truckRequestId: string) =>
  `cascade:${truckRequestId}:retries`;

/** Redis key prefix for tracking tried (declined/timed-out) drivers */
const CASCADE_TRIED_DRIVERS_KEY = (truckRequestId: string) =>
  `cascade:${truckRequestId}:tried_drivers`;

/** TTL for cascade Redis keys: 5 minutes */
const CASCADE_KEY_TTL = 300;

// =============================================================================
// TYPES
// =============================================================================

interface CascadeContext {
  truckRequestId: string;
  orderId: string;
  transporterId: string;
  vehicleId: string;
  vehicleNumber: string;
  vehicleType: string;
  vehicleSubtype: string;
  declinedDriverId: string;
}

// =============================================================================
// CASCADE DISPATCH SERVICE
// =============================================================================

class CascadeDispatchService {
  /**
   * Cascade to the next available driver after decline/timeout.
   *
   * Called AFTER the existing decline cleanup (release vehicle, decrement
   * trucksFilled, emit decline notification). This is additive -- the
   * existing "Please reassign" notification to transporter still fires,
   * so the transporter can manually choose a different driver if they want.
   *
   * H-06 FIX: Previously retried the SAME declined driver. Now tracks all
   * tried drivers in a Redis SET and queries for the next available driver
   * from the transporter's fleet, excluding already-tried ones. Falls back
   * to the declined driver only if no other drivers are available.
   */
  async retrySameDriver(ctx: CascadeContext): Promise<void> {
    const {
      truckRequestId,
      orderId,
      transporterId,
      vehicleId,
      vehicleNumber,
      vehicleType,
      vehicleSubtype,
      declinedDriverId,
    } = ctx;

    try {
      // Increment retry counter
      const retryCount = await redisService.incr(CASCADE_RETRY_KEY(truckRequestId));
      await redisService.expire(CASCADE_RETRY_KEY(truckRequestId), CASCADE_KEY_TTL);

      if (retryCount > MAX_CASCADE_RETRIES) {
        logger.info(
          `[CascadeDispatch] Max retries (${MAX_CASCADE_RETRIES}) reached for truckRequest ${truckRequestId} — transporter must reassign manually`
        );
        return;
      }

      // H-06: Add declined driver to exclusion set
      const triedKey = CASCADE_TRIED_DRIVERS_KEY(truckRequestId);
      await redisService.sAdd(triedKey, declinedDriverId);
      await redisService.expire(triedKey, CASCADE_KEY_TTL);

      // H-06: Get all tried drivers
      const triedDriverIds = await redisService.sMembers(triedKey);

      // H-06: Query next available driver from transporter's fleet, excluding tried ones
      const nextDriver = await prismaClient.user.findFirst({
        where: {
          transporterId,
          role: 'driver',
          isActive: true,
          id: { notIn: triedDriverIds },
        },
        select: { id: true, name: true, phone: true },
        orderBy: { updatedAt: 'desc' },
      });

      // H-06: Fall back to the declined driver only if no other drivers are available
      let selectedDriver = nextDriver;
      if (!selectedDriver) {
        logger.info(
          `[CascadeDispatch] No untried drivers available for transporter ${transporterId} — falling back to declined driver ${declinedDriverId}`
        );
        selectedDriver = await prismaClient.user.findFirst({
          where: {
            id: declinedDriverId,
            isActive: true,
          },
          select: { id: true, name: true, phone: true },
        });
      }

      if (!selectedDriver) {
        logger.info(
          `[CascadeDispatch] No drivers available (including declined driver ${declinedDriverId}) — stopping cascade`
        );
        return;
      }

      const isFallback = selectedDriver.id === declinedDriverId;
      logger.info(
        `[CascadeDispatch] ${isFallback ? 'Retrying same' : 'Cascading to next'} driver ${selectedDriver.id} (${selectedDriver.name}) ` +
          `attempt ${retryCount}/${MAX_CASCADE_RETRIES} for truckRequest ${truckRequestId}` +
          (isFallback ? ' [fallback — no other drivers]' : ` [skipped ${triedDriverIds.length} tried driver(s)]`)
      );

      // 2-second delay before creating the new assignment
      await this.delay(CASCADE_DELAY_MS);

      // Create the new assignment via transaction
      await this.createCascadedAssignment({
        truckRequestId,
        orderId,
        transporterId,
        vehicleId,
        vehicleNumber,
        vehicleType,
        vehicleSubtype,
        driver: selectedDriver,
      });
    } catch (err) {
      logger.warn(
        `[CascadeDispatch] Failed for truckRequest ${truckRequestId}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  /**
   * Create a new assignment for the cascaded driver within a Serializable transaction.
   * Mirrors the pattern in truck-hold-confirm.service.ts.
   */
  private async createCascadedAssignment(params: {
    truckRequestId: string;
    orderId: string;
    transporterId: string;
    vehicleId: string;
    vehicleNumber: string;
    vehicleType: string;
    vehicleSubtype: string;
    driver: { id: string; name: string; phone: string | null };
  }): Promise<void> {
    const {
      truckRequestId,
      orderId,
      transporterId,
      vehicleId,
      vehicleNumber,
      vehicleType,
      vehicleSubtype,
      driver,
    } = params;

    const assignmentId = uuidv4();
    const tripId = uuidv4();
    const now = new Date().toISOString();

    // Get transporter info for assignment record
    const transporter = await prismaClient.user.findUnique({
      where: { id: transporterId },
      select: { name: true, businessName: true },
    });
    const transporterName =
      transporter?.name || transporter?.businessName || 'Transporter';

    await prismaClient.$transaction(
      async (tx) => {
        // Guard: verify truckRequest is still in 'held' state for this transporter
        const truckRequest = await tx.truckRequest.findFirst({
          where: {
            id: truckRequestId,
            status: 'held',
            heldById: transporterId,
          },
          select: { id: true },
        });

        if (!truckRequest) {
          logger.info(
            `[CascadeDispatch] TruckRequest ${truckRequestId} no longer held -- skipping cascade`
          );
          return;
        }

        // Guard: verify driver is still free (no active assignment)
        const activeStatuses: AssignmentStatus[] = [
          'pending',
          'driver_accepted',
          'en_route_pickup',
          'at_pickup',
          'in_transit',
          'arrived_at_drop',
        ];
        const activeAssignment = await tx.assignment.findFirst({
          where: {
            driverId: driver.id,
            status: { in: activeStatuses },
          },
        });
        if (activeAssignment) {
          logger.info(
            `[CascadeDispatch] Driver ${driver.name} (${driver.id}) now busy -- skipping`
          );
          return;
        }

        // Guard: verify vehicle is available
        const vehicle = await tx.vehicle.findFirst({
          where: { id: vehicleId, status: 'available' },
          select: { id: true },
        });
        if (!vehicle) {
          logger.info(
            `[CascadeDispatch] Vehicle ${vehicleId} no longer available -- skipping`
          );
          return;
        }

        // Update truck request: assign new driver
        await tx.truckRequest.update({
          where: { id: truckRequestId },
          data: {
            status: 'assigned',
            assignedDriverId: driver.id,
            assignedDriverName: driver.name,
            assignedDriverPhone: driver.phone || '',
            assignedVehicleId: vehicleId,
            assignedVehicleNumber: vehicleNumber,
            tripId,
            assignedAt: now,
          },
        });

        // Create assignment record
        await tx.assignment.create({
          data: {
            id: assignmentId,
            bookingId: null,
            truckRequestId,
            orderId,
            transporterId,
            transporterName,
            vehicleId,
            vehicleNumber,
            vehicleType,
            vehicleSubtype,
            driverId: driver.id,
            driverName: driver.name,
            driverPhone: driver.phone || '',
            tripId,
            status: AssignmentStatus.pending,
            assignedAt: now,
          },
        });

        // Set vehicle to on_hold atomically
        await tx.vehicle.updateMany({
          where: {
            id: vehicleId,
            status: { in: ['available'] as VehicleStatus[] },
          },
          data: {
            status: 'on_hold',
            currentTripId: tripId,
            assignedDriverId: driver.id,
            lastStatusChange: now,
          },
        });

        // Increment trucksFilled on the order
        await tx.order.update({
          where: { id: orderId },
          data: { trucksFilled: { increment: 1 } },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 8000,
      }
    );

    // Post-transaction side effects (non-fatal)

    // Schedule driver acceptance timeout (45s)
    const timerData = {
      assignmentId,
      tripId,
      driverId: driver.id,
      driverName: driver.name,
      transporterId,
      vehicleId,
      vehicleNumber,
      orderId,
      truckRequestId,
      createdAt: now,
    };

    try {
      await queueService.scheduleAssignmentTimeout(
        timerData,
        HOLD_CONFIG.driverAcceptTimeoutMs
      );
      logger.info(
        `[CascadeDispatch] Timeout scheduled: ${assignmentId} (${vehicleNumber} -> ${driver.name}) ` +
          `[${HOLD_CONFIG.driverAcceptTimeoutSeconds}s]`
      );
    } catch (timeoutErr) {
      logger.error('[CascadeDispatch] Timeout scheduling FAILED (L3 reconciliation will catch)', {
        assignmentId,
        error: getErrorMessage(timeoutErr),
      });
    }

    // Notify driver via Socket.IO
    try {
      // Fetch order details for the notification
      const order = await prismaClient.order.findUnique({
        where: { id: orderId },
        select: {
          pickup: true,
          drop: true,
          distanceKm: true,
          customerName: true,
          customerPhone: true,
        },
      });

      if (order) {
        const pickup = order.pickup as Record<string, unknown>;
        const drop = order.drop as Record<string, unknown>;

        // F-L9 FIX: Check if driver is online before emitting via Socket.
        // FCM backup is sent regardless (below), so this just avoids unnecessary Socket emit.
        const isDriverOnline = await isUserConnectedAsync(driver.id).catch(() => false);
        if (isDriverOnline) {
          await socketService.emitToUser(driver.id, 'trip_assigned', {
            assignmentId,
            tripId,
            orderId,
            truckRequestId,
            pickupAddress: pickup?.address || '',
            dropAddress: drop?.address || '',
            vehicleNumber,
            status: 'pending',
            expiresAt: new Date(
              Date.now() + HOLD_CONFIG.driverAcceptTimeoutMs
            ).toISOString(),
            isCascade: true,
          });
        } else {
          logger.debug('[CascadeDispatch] Skipping Socket emit — driver offline, FCM will deliver', {
            driverId: driver.id,
            assignmentId,
          });
        }
      }
    } catch (notifyErr) {
      logger.warn('[CascadeDispatch] Socket notification failed (non-fatal)', {
        assignmentId,
        error: getErrorMessage(notifyErr),
      });
    }

    // FCM push to driver
    try {
      const order = await prismaClient.order.findUnique({
        where: { id: orderId },
        select: { pickup: true, drop: true },
      });
      const pickup = (order?.pickup as Record<string, unknown>) || {};
      const drop = (order?.drop as Record<string, unknown>) || {};

      await queueService.queuePushNotification(driver.id, {
        title: 'New Trip Assigned!',
        body: `${pickup?.address || 'Pickup'} -> ${drop?.address || 'Drop'}`,
        data: {
          type: 'trip_assigned',
          assignmentId,
          tripId,
          orderId,
          truckRequestId,
          vehicleNumber,
          status: 'pending',
        },
      });
    } catch (fcmErr) {
      logger.warn('[CascadeDispatch] FCM push failed (non-fatal)', {
        driverId: driver.id,
        error: getErrorMessage(fcmErr),
      });
    }

    // Notify transporter about the auto-reassignment
    try {
      await socketService.emitToUser(transporterId, 'cascade_reassigned', {
        truckRequestId,
        orderId,
        assignmentId,
        newDriverId: driver.id,
        newDriverName: driver.name,
        vehicleNumber,
        message: `Auto-reassigned to ${driver.name} after previous driver declined.`,
      });
    } catch {
      // Non-fatal
    }

    logger.info(
      `[CascadeDispatch] Successfully cascaded: truckRequest=${truckRequestId} ` +
        `driver=${driver.name} (${driver.id}) assignment=${assignmentId}`
    );
  }

  /** Promise-based delay */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// =============================================================================
// EXPORT SINGLETON
// =============================================================================

export const cascadeDispatchService = new CascadeDispatchService();
