/**
 * Assignment Reconciliation Queue Processor
 *
 * Safety net for orphaned assignments and abandoned trucks.
 * Industry pattern (Uber uTask): Periodic background sweep catches orphaned
 * records left behind when queue/Redis was down during assignment creation.
 *
 * PHASE 1: Orphaned PENDING assignments (ECS restart during 30s timer)
 * PHASE 2: Abandoned IN-TRANSIT trucks (driver disappeared mid-trip)
 * PHASE 3: Reverse vehicle reconciliation (orphaned vehicles with no active assignment)
 */

import { logger } from '../services/logger.service';
import { redisService } from '../services/redis.service';
import { prismaClient } from '../database/prisma.service';
import type { QueueJob } from '../services/queue.service';

/**
 * Interface for the QueueService methods needed by this processor.
 */
export interface ReconciliationProcessorDeps {
  queuePushNotification(userId: string, notification: {
    title: string;
    body: string;
    data?: Record<string, string>;
  }): Promise<string>;
}

export function registerAssignmentReconciliationProcessor(
  queue: { process(queueName: string, processor: (job: QueueJob) => Promise<void>): void },
  deps: ReconciliationProcessorDeps,
  queueName: string
): void {
  queue.process(queueName, async (_job) => {
    const lockKey = 'lock:assignment-reconciliation';
    const lock = await redisService.acquireLock(lockKey, 'reconciler', 120);
    if (!lock.acquired) {
      return; // Another instance is processing
    }

    try {
      // =====================================================================
      // PHASE 1: Orphaned PENDING assignments (ECS restart during 30s timer)
      // =====================================================================
      // FIX #9: Tighter reconciliation threshold -- 90s instead of 3min.
      // Env-configurable with Math.max guard to prevent dangerously low values.
      // assignedAt is String (ISO), so compare as string -- ISO strings sort lexicographically
      const RECONCILE_THRESHOLD_MS = Math.max(30000, parseInt(process.env.ASSIGNMENT_RECONCILE_THRESHOLD_MS || '90000', 10) || 90000);
      const thresholdAgoISO = new Date(Date.now() - RECONCILE_THRESHOLD_MS).toISOString();
      const orphaned = await prismaClient.assignment.findMany({
        where: {
          status: 'pending',
          assignedAt: { lt: thresholdAgoISO }
        },
        take: 100
      });

      if (orphaned.length > 0) {
        logger.warn(`[RECONCILIATION] Found ${orphaned.length} orphaned pending assignments`);

        // Use the FULL handleAssignmentTimeout pipeline (same as normal timeout).
        // This includes: status update, vehicle release, booking decrement,
        // transporter notification, driver notification, booking room emit, FCM push.
        // Industry pattern (Uber uTask): reconciliation uses same cleanup path as normal flow.
        const { assignmentService }: typeof import('../../modules/assignment/assignment.service') = require('../../modules/assignment/assignment.service');

        for (const assignment of orphaned) {
          try {
            await assignmentService.handleAssignmentTimeout({
              assignmentId: assignment.id,
              driverId: assignment.driverId,
              driverName: assignment.driverName || '',
              transporterId: assignment.transporterId,
              vehicleId: assignment.vehicleId,
              vehicleNumber: assignment.vehicleNumber || '',
              bookingId: assignment.bookingId || '',
              orderId: assignment.orderId || '',
              truckRequestId: assignment.truckRequestId || '',
              tripId: assignment.tripId || '',
              createdAt: assignment.assignedAt
            });
            logger.info(`[RECONCILIATION] Processed orphaned pending: ${assignment.id}`);
          } catch (err: unknown) {
            logger.error(`[RECONCILIATION] Failed pending: ${assignment.id}`, { error: err instanceof Error ? err.message : String(err) });
          }
        }
      }

      // =====================================================================
      // PHASE 2: Abandoned IN-TRANSIT trucks (driver disappeared mid-trip)
      // =====================================================================
      // TRUCK-SPECIFIC: Freight trips can legitimately last 4-8 hours.
      // A truck in active status for >12 hours with NO completion is
      // likely abandoned (driver phone died, app crashed, driver went AWOL).
      //
      // FIX A4#17: Split thresholds -- in-transit uses 48h, pre-transit uses 24h.
      // FIX A4#16: Cursor-based pagination to handle unbounded abandoned trips.
      // FIX A4#18: Notify driver (FCM) and transporter (WebSocket) on reconciliation cancel.
      // FIX A4#19: Status-check before decrementing trucksFilled to avoid double-decrement.
      // =====================================================================
      // FIX #48: Reduced default from 48h to 12h — 48h is far too long for freight
      // trips that typically complete in 4-8 hours. Configurable via env.
      const STALE_TRANSIT_HOURS = parseInt(process.env.STALE_ACTIVE_TRIP_HOURS || '12', 10);
      const STALE_PRE_TRANSIT_HOURS = parseInt(process.env.STALE_PRE_TRANSIT_TRIP_HOURS || '6', 10);
      const staleTransitCutoff = new Date(Date.now() - STALE_TRANSIT_HOURS * 60 * 60 * 1000).toISOString();
      const stalePreTransitCutoff = new Date(Date.now() - STALE_PRE_TRANSIT_HOURS * 60 * 60 * 1000).toISOString();

      // FIX A4#16: Cursor-based pagination -- process all abandoned trips in batches of 50
      const BATCH_SIZE = 50;
      let totalAbandoned = 0;
      let cursor: string | undefined;

      const { onVehicleTransition }: typeof import('../services/vehicle-lifecycle.service') = require('../services/vehicle-lifecycle.service');
      // FIX A4#18: Lazy require to avoid circular dependency
      const { emitToUser, SocketEvent }: typeof import('../services/socket.service') = require('../services/socket.service');

      // eslint-disable-next-line no-constant-condition
      while (true) {
        // FIX A4#17: OR clause -- different thresholds for in-transit vs pre-transit
        const abandonedBatch = await prismaClient.assignment.findMany({
          where: {
            OR: [
              // In-transit trips: use startedAt (48h threshold)
              {
                status: { in: ['in_transit', 'arrived_at_drop'] },
                startedAt: { not: null, lt: staleTransitCutoff }
              },
              // Pre-transit trips: use assignedAt (24h threshold)
              {
                status: { in: ['driver_accepted', 'en_route_pickup', 'at_pickup'] },
                assignedAt: { lt: stalePreTransitCutoff }
              }
            ]
          },
          include: {
            vehicle: { select: { id: true, vehicleKey: true, transporterId: true, status: true } }
          },
          orderBy: { id: 'asc' },
          take: BATCH_SIZE,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {})
        });

        if (abandonedBatch.length === 0) break;

        totalAbandoned += abandonedBatch.length;
        cursor = abandonedBatch[abandonedBatch.length - 1].id;

        logger.warn(`[RECONCILIATION] Processing batch of ${abandonedBatch.length} abandoned trip(s) (transit>${STALE_TRANSIT_HOURS}h, pre-transit>${STALE_PRE_TRANSIT_HOURS}h)`);

        for (const assignment of abandonedBatch) {
          try {
            const ageHours = Math.round((Date.now() - new Date(assignment.assignedAt).getTime()) / (60 * 60 * 1000));

            // 1. Cancel the assignment (system-level -- no user context needed)
            // Use updateMany count to detect if another process already cancelled (QA-3 race fix)
            const cancelResult = await prismaClient.assignment.updateMany({
              where: { id: assignment.id, status: { in: ['driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit', 'arrived_at_drop'] } },
              data: { status: 'cancelled' }
            });

            // If count === 0, another process already cancelled this assignment -- skip all side effects
            if (cancelResult.count === 0) {
              logger.info(`[RECONCILIATION] Assignment ${assignment.id} already cancelled by another process, skipping`);
              continue;
            }

            // 2. Release the vehicle back to available
            if (assignment.vehicleId) {
              const prevStatus = assignment.vehicle?.status || 'in_transit';
              await prismaClient.vehicle.updateMany({
                where: { id: assignment.vehicleId, status: { not: 'available' } },
                data: {
                  status: 'available',
                  currentTripId: null,
                  assignedDriverId: null,
                  lastStatusChange: new Date().toISOString()
                }
              });

              // 3. Update Redis + fleet cache via centralized wrapper
              const vehicleKey = assignment.vehicle?.vehicleKey;
              const transporterId = assignment.vehicle?.transporterId || assignment.transporterId;
              if (transporterId) {
                await onVehicleTransition(
                  transporterId,
                  assignment.vehicleId,
                  vehicleKey,
                  prevStatus,
                  'available',
                  'reconciliation'
                );
              }
            }

            // 4. Decrement trucks filled on booking/order
            // FIX A4#19: Check parent status before decrementing -- avoid double-decrement on already-cancelled/completed
            if (assignment.bookingId) {
              const booking = await prismaClient.booking.findUnique({
                where: { id: assignment.bookingId },
                select: { status: true }
              });
              if (booking && booking.status !== 'cancelled' && booking.status !== 'completed') {
                const { bookingService }: typeof import('../../modules/booking/booking.service') = require('../../modules/booking/booking.service');
                await bookingService.decrementTrucksFilled(assignment.bookingId).catch(() => {});
              }
            } else if (assignment.orderId) {
              // FIX A4#19: Floor guard + status check -- only decrement if order is still active
              // DB migration needed: ALTER TABLE "Order" ADD CONSTRAINT chk_order_trucks_filled_nonneg CHECK ("trucksFilled" >= 0);
              await prismaClient.$executeRaw`
                UPDATE "Order"
                SET "trucksFilled" = GREATEST(0, "trucksFilled" - 1),
                    "updatedAt" = NOW()
                WHERE "id" = ${assignment.orderId}
                  AND "status" NOT IN ('cancelled', 'completed')
              `.catch(() => {});
            }

            logger.warn(`[RECONCILIATION] Released abandoned truck: ${assignment.vehicleNumber || 'unknown'} ` +
              `(assignment ${assignment.id}, status was '${assignment.status}', ${ageHours}h old)`);

            // FIX A4#18: Notify driver and transporter after reconciliation cancel
            if (assignment.driverId) {
              deps.queuePushNotification(assignment.driverId, {
                title: 'Trip Cancelled',
                body: 'Your trip was auto-cancelled due to inactivity.',
                data: { type: 'assignment_cancelled', reason: 'system_reconciliation' }
              }).catch((err: unknown) => logger.warn('[RECONCILIATION] FCM notify driver failed', { error: err instanceof Error ? err.message : String(err) }));
            }
            if (assignment.vehicleId) {
              const transporterId = assignment.vehicle?.transporterId || assignment.transporterId;
              if (transporterId) {
                try {
                  emitToUser(transporterId, SocketEvent.VEHICLE_STATUS_CHANGED, {
                    vehicleId: assignment.vehicleId,
                    status: 'available',
                    reason: 'system_reconciliation'
                  });
                } catch (socketErr: unknown) {
                  logger.warn('[RECONCILIATION] WebSocket notify transporter failed', { error: socketErr instanceof Error ? socketErr.message : String(socketErr) });
                }
              }
            }
          } catch (err: unknown) {
            logger.error(`[RECONCILIATION] Failed abandoned: ${assignment.id}`, { error: err instanceof Error ? err.message : String(err) });
          }
        }

        // If batch was smaller than BATCH_SIZE, we've processed all records
        if (abandonedBatch.length < BATCH_SIZE) break;
      }

      if (totalAbandoned > 0) {
        logger.warn(`[RECONCILIATION] Total abandoned trips processed: ${totalAbandoned}`);
      }
      // =====================================================================
      // PHASE 3: Reverse vehicle reconciliation -- find vehicles stuck
      //          with no active assignment (orphaned vehicles)
      // =====================================================================
      // Catches vehicles stuck in 'in_transit' or 'on_hold' where the
      // assignment was cancelled/completed but vehicle release failed silently.
      // Uses raw SQL for index-friendly query (Vehicle.status + updatedAt).
      // =====================================================================
      try {
        // FIX #47: Use different thresholds per vehicle status.
        // on_hold vehicles are only valid during the 45s driver accept window,
        // so 10min is far too long -- use 5min. in_transit keeps 10min since
        // freight trips have legitimate pauses (loading, toll stops, etc.).
        const orphanedVehicles = await prismaClient.$queryRaw<
          Array<{ id: string; status: string; transporterId: string; vehicleKey: string }>
        >`
          SELECT v."id", v."status", v."transporterId", v."vehicleKey"
          FROM "Vehicle" v
          WHERE v."status" IN ('in_transit', 'on_hold')
          AND (
            (v."status" = 'on_hold' AND v."updatedAt" < NOW() - INTERVAL '5 minutes')
            OR
            (v."status" = 'in_transit' AND v."updatedAt" < NOW() - INTERVAL '10 minutes')
          )
          AND NOT EXISTS (
            SELECT 1 FROM "Assignment" a
            WHERE a."vehicleId" = v."id"
            AND a."status" IN ('pending', 'driver_accepted', 'in_transit', 'en_route_pickup', 'at_pickup', 'arrived_at_drop')
          )
          LIMIT 50
        `;

        for (const v of orphanedVehicles) {
          const { releaseVehicle: releaseOrphaned }: typeof import('../services/vehicle-lifecycle.service') = require('../services/vehicle-lifecycle.service');
          await releaseOrphaned(v.id, 'reconciliation:orphaned').catch((err: unknown) => {
            logger.warn('[RECONCILIATION] Failed to release orphaned vehicle', { vehicleId: v.id, error: err instanceof Error ? err.message : String(err) });
          });
        }

        if (orphanedVehicles.length > 0) {
          logger.info(`[RECONCILIATION] Released ${orphanedVehicles.length} orphaned vehicles`);
        }
      } catch (orphanErr: unknown) {
        logger.warn('[RECONCILIATION] Orphaned vehicle scan failed (non-fatal)', { error: orphanErr instanceof Error ? orphanErr.message : String(orphanErr) });
      }
    } finally {
      await redisService.releaseLock(lockKey, 'reconciler').catch(() => {});
    }
  });
}
