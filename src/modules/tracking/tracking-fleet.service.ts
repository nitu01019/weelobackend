/**
 * =============================================================================
 * TRACKING MODULE - FLEET MANAGEMENT SERVICE
 * =============================================================================
 *
 * Fleet driver management, driver offline detection,
 * booking completion checks, and order completion checks.
 * =============================================================================
 */

import { logger } from '../../shared/services/logger.service';
import { emitToUser, SocketEvent } from '../../shared/services/socket.service';
import { redisService } from '../../shared/services/redis.service';
import { queueService } from '../../shared/services/queue.service';
import { prismaClient } from '../../shared/database/prisma.service';
import {
  REDIS_KEYS,
  TTL,
  LocationData,
} from './tracking.types';
import { clearCustomerActiveBroadcast } from '../order/order-broadcast.service';

class TrackingFleetService {
  // ===========================================================================
  // FLEET DRIVER MANAGEMENT
  // ===========================================================================

  /**
   * Add driver to transporter's fleet (for fleet tracking)
   *
   * INDUSTRY PATTERN (Uber/Grab): Retry failed Redis set operations.
   * Without retry, a single Redis blip during acceptance makes the driver
   * invisible in the transporter's fleet map for the entire trip.
   * Max 2 retries with 200ms backoff. Non-fatal — driver still gets
   * tracked via trip key, just not visible in fleet map temporarily.
   */
  async addDriverToFleet(transporterId: string, driverId: string): Promise<void> {
    const MAX_RETRIES = 2;
    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      try {
        await redisService.sAdd(REDIS_KEYS.FLEET_DRIVERS(transporterId), driverId);
        await redisService.expire(REDIS_KEYS.FLEET_DRIVERS(transporterId), TTL.TRIP);
        await redisService.sAdd(REDIS_KEYS.ACTIVE_FLEET_TRANSPORTERS, transporterId);
        logger.debug('Driver added to fleet', { transporterId, driverId });
        return; // Success — exit
      } catch (err: unknown) {
        if (attempt <= MAX_RETRIES) {
          const backoffMs = 200 * attempt;
          logger.warn(`[FLEET] sAdd failed, retry ${attempt}/${MAX_RETRIES} after ${backoffMs}ms`, {
            transporterId, driverId, error: err instanceof Error ? err.message : String(err)
          });
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        } else {
          // All retries exhausted — log but don't throw (non-fatal)
          logger.error(`[FLEET] addDriverToFleet failed after ${MAX_RETRIES} retries`, {
            transporterId, driverId, error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }
  }

  /**
   * Remove driver from fleet
   */
  async removeDriverFromFleet(transporterId: string, driverId: string): Promise<void> {
    await redisService.sRem(REDIS_KEYS.FLEET_DRIVERS(transporterId), driverId);
    const fleetSize = await redisService.sCard(REDIS_KEYS.FLEET_DRIVERS(transporterId));
    if (fleetSize <= 0) {
      await redisService.sRem(REDIS_KEYS.ACTIVE_FLEET_TRANSPORTERS, transporterId);
    }
    // Also delete their location
    await redisService.del(REDIS_KEYS.DRIVER_LOCATION(driverId));
    logger.debug('Driver removed from fleet', { transporterId, driverId });
  }

  // ===========================================================================
  // PHASE 5: DRIVER OFFLINE DETECTION
  // ===========================================================================
  //
  // PRD 5.2: "Backend detects no GPS for 2min → notify transporter"
  //
  // HOW IT WORKS:
  //   1. Runs every 30 seconds
  //   2. Scans all active fleet drivers (from Redis sets)
  //   3. Checks each driver's lastUpdated timestamp
  //   4. If > 2 minutes stale → driver may be offline
  //   5. Notifies transporter via WebSocket + FCM
  //   6. Uses Redis key to prevent duplicate notifications (5min cooldown)
  //
  // SCALABILITY:
  //   - Only checks drivers in active fleets (no full DB scan)
  //   - Redis operations are O(1) per driver
  //   - Distributed lock prevents duplicate processing across ECS instances
  //   - Cooldown key prevents notification spam
  //
  // GRACEFUL:
  //   - Non-critical — if Redis is down, checker silently skips
  //   - Never throws — all errors caught and logged
  // ===========================================================================

  private offlineCheckerInterval: NodeJS.Timeout | null = null;

  /**
   * Start the driver offline checker
   */
  startDriverOfflineChecker(): void {
    if (this.offlineCheckerInterval) return;

    this.offlineCheckerInterval = setInterval(async () => {
      try {
        await this.checkDriversOffline();
      } catch (error: unknown) {
        logger.warn('[OFFLINE CHECKER] Error (non-fatal)', { error: error instanceof Error ? error.message : String(error) });
      }
    }, 30_000); // Every 30 seconds
    // L1 FIX: unref() so this non-critical timer doesn't block process exit
    this.offlineCheckerInterval.unref();

    logger.info('Driver offline checker started (30s interval, 2min threshold)');
  }

  stopDriverOfflineChecker(): void {
    if (this.offlineCheckerInterval) {
      clearInterval(this.offlineCheckerInterval);
      this.offlineCheckerInterval = null;
      logger.info('Driver offline checker stopped');
    }
  }

  /**
   * Check all active fleet drivers for offline status
   */
  private async checkDriversOffline(): Promise<void> {
    // Distributed lock — only one ECS instance runs this at a time
    const lock = await redisService.acquireLock('offline-checker', 'tracker', 25);
    if (!lock.acquired) return;

    try {
      let transporterIds = await redisService.sMembers(REDIS_KEYS.ACTIVE_FLEET_TRANSPORTERS);

      // Backward compatibility fallback for historical deployments that populated
      // only fleet:{transporterId} sets and not the active transporter index.
      if (transporterIds.length === 0) {
        const allFleetKeys: string[] = [];
        for await (const key of redisService.scanIterator('fleet:*')) {
          allFleetKeys.push(key);
        }
        const uuidRegex = /^fleet:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        transporterIds = allFleetKeys
          .filter(key => uuidRegex.test(key))
          .map(key => key.replace('fleet:', ''));
        transporterIds = Array.from(new Set(transporterIds));
        if (transporterIds.length > 0) {
          await redisService.sAdd(REDIS_KEYS.ACTIVE_FLEET_TRANSPORTERS, ...transporterIds);
        }
      }

      const locationBatchSize = Math.max(
        25,
        Math.min(400, parseInt(process.env.TRACKING_OFFLINE_CHECK_BATCH_SIZE || '120', 10) || 120)
      );

      for (const transporterId of transporterIds) {
        const driverIds = await redisService.sMembers(REDIS_KEYS.FLEET_DRIVERS(transporterId));
        if (driverIds.length === 0) {
          await redisService.sRem(REDIS_KEYS.ACTIVE_FLEET_TRANSPORTERS, transporterId);
          continue;
        }

        const offlineDrivers: Array<{ driverId: string; location: LocationData; ageSeconds: number }> = [];
        for (let i = 0; i < driverIds.length; i += locationBatchSize) {
          const chunk = driverIds.slice(i, i + locationBatchSize);
          const chunkResults = await Promise.all(
            chunk.map(async (driverId) => {
              const location = await redisService.getJSON<LocationData>(REDIS_KEYS.DRIVER_LOCATION(driverId));
              if (!location) return null;
              const lastUpdateMs = new Date(location.lastUpdated).getTime();
              const ageSeconds = (Date.now() - lastUpdateMs) / 1000;
              if (ageSeconds <= 120) return null;
              return { driverId, location, ageSeconds };
            })
          );
          for (const offlineDriver of chunkResults) {
            if (offlineDriver) {
              offlineDrivers.push(offlineDriver);
            }
          }
        }

        for (const offlineDriver of offlineDrivers) {
          const { driverId, location, ageSeconds } = offlineDriver;
          const cooldownKey = `offline:notified:${driverId}`;
          const alreadyNotified = await redisService.get(cooldownKey);
          if (alreadyNotified) continue;

          await redisService.set(cooldownKey, '1', 300);

          // F-L15 FIX: Look up actual driver name from DB instead of using vehicleNumber
          let resolvedDriverName: string = location.vehicleNumber || 'Unknown';
          try {
            const driverUser = await prismaClient.user.findUnique({
              where: { id: driverId },
              select: { name: true }
            });
            if (driverUser?.name) {
              resolvedDriverName = driverUser.name;
            }
          } catch (_) { /* non-fatal — fall back to vehicleNumber */ }

          emitToUser(transporterId, SocketEvent.DRIVER_MAY_BE_OFFLINE, {
            driverId,
            driverName: resolvedDriverName,
            vehicleNumber: location.vehicleNumber,
            tripId: location.tripId,
            lastSeenSeconds: Math.round(ageSeconds),
            lastLatitude: location.latitude,
            lastLongitude: location.longitude,
            message: `Driver (${resolvedDriverName}) hasn't sent GPS for ${Math.round(ageSeconds / 60)} minutes`
          });

          // === CASE 5.2 FIX: Also notify the CUSTOMER if this driver has an active trip ===
          if (location.tripId) {
            try {
              const assignment = await prismaClient.assignment.findFirst({
                where: { tripId: location.tripId, status: { in: ['pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit'] } },
                select: {
                  driverName: true,
                  vehicleNumber: true,
                  booking: { select: { customerId: true } },
                  order: { select: { customerId: true } }
                }
              });
              const customerId = assignment?.booking?.customerId || assignment?.order?.customerId;
              if (customerId) {
                emitToUser(customerId, 'driver_connectivity_issue', {
                  tripId: location.tripId,
                  driverName: assignment?.driverName || location.vehicleNumber,
                  vehicleNumber: assignment?.vehicleNumber || location.vehicleNumber,
                  lastSeenSeconds: Math.round(ageSeconds),
                  message: `Your driver may have poor connectivity. We're monitoring the situation.`,
                  timestamp: new Date().toISOString()
                });
                queueService.queuePushNotification(customerId, {
                  title: '⚠️ Driver connectivity issue',
                  body: `${assignment?.driverName || location.vehicleNumber} may have poor network. Your trip is still active.`,
                  data: {
                    type: 'driver_connectivity_issue',
                    tripId: location.tripId,
                    vehicleNumber: assignment?.vehicleNumber || location.vehicleNumber
                  }
                }).catch(() => { }); // Fire-and-forget
              }
            } catch (lookupError: unknown) {
              // Non-critical — transporter notification already sent
              logger.warn('[OFFLINE CHECKER] Customer lookup failed (non-fatal)', { tripId: location.tripId, error: lookupError instanceof Error ? lookupError.message : String(lookupError) });
            }
          }

          queueService.queuePushNotification(transporterId, {
            title: '⚠️ Driver May Be Offline',
            body: `${location.vehicleNumber} hasn't sent GPS for ${Math.round(ageSeconds / 60)} min`,
            data: {
              type: 'driver_offline',
              driverId,
              tripId: location.tripId,
              vehicleNumber: location.vehicleNumber,
              lastSeenSeconds: String(Math.round(ageSeconds))
            }
          }).catch(err => {
            logger.warn('[OFFLINE CHECKER] FCM push failed', { error: err.message });
          });

          logger.warn(`[OFFLINE CHECKER] Driver ${driverId} (${location.vehicleNumber}) offline for ${Math.round(ageSeconds)}s`);
        }
      }
    } finally {
      await redisService.releaseLock('offline-checker', 'tracker');
    }
  }

  // ===========================================================================
  // PHASE 5: BOOKING COMPLETION CHECK
  // ===========================================================================
  //
  // PRD 5.2: "Booking completes when ALL trucks complete"
  //
  // Called from updateTripStatus() when a single truck completes.
  // Checks if all assignments for the booking are completed.
  // If yes → updates booking status and sends customer notification.
  // ===========================================================================

  async checkBookingCompletion(bookingId: string): Promise<void> {
    try {
      // =====================================================================
      // DISTRIBUTED LOCK — prevents duplicate "All complete!" notifications
      //
      // RACE CONDITION SCENARIO:
      //   Truck A and Truck B complete at the same time (within ms).
      //   Both call checkBookingCompletion(bookingId).
      //   Without a lock, both see "all completed" and send 2x notifications.
      //
      // SOLUTION: Redis distributed lock with 10s TTL.
      //   Only the first instance processes; second one skips.
      //   Lock auto-releases after 10s (safety net if crash).
      //
      // SCALABILITY: O(1) Redis SETNX — works across all ECS instances.
      // =====================================================================
      const lockKey = `lock:booking-completion:${bookingId}`;
      const lock = await redisService.acquireLock(lockKey, 'completion-checker', 10);
      if (!lock.acquired) {
        logger.debug('[BOOKING COMPLETION] Lock not acquired (another instance handling)', { bookingId });
        return;
      }

      try {
        // Get all assignments for this booking
        const assignments = await prismaClient.assignment.findMany({
          where: { bookingId },
          select: { id: true, status: true }
        });

        if (assignments.length === 0) return;

        // F-M21 FIX: Use terminal status set — partial_delivery and cancelled are also terminal
        const TERMINAL_BOOKING_STATUSES = new Set(['completed', 'cancelled', 'partial_delivery']);
        const allTerminal = assignments.every(a => TERMINAL_BOOKING_STATUSES.has(a.status));
        const hasCompleted = assignments.some(a => a.status === 'completed');

        if (allTerminal && hasCompleted) {
          logger.info(`[BOOKING COMPLETION] All ${assignments.length} trucks completed for booking ${bookingId}`);

          // Update booking status + notify customer
          // Uses db.ts (which wraps Prisma or JSON — handles both)
          const { db: dbService } = await import('../../shared/database/db');
          const booking = await dbService.getBookingById(bookingId);

          if (booking) {
            // Only update if not already completed or cancelled (idempotent)
            if (booking.status !== 'completed' && booking.status !== 'cancelled') {
              await dbService.updateBooking(bookingId, { status: 'completed' });

              // F-H18 FIX: Clear active-broadcast sentinel so customer can create new bookings
              clearCustomerActiveBroadcast(booking.customerId).catch(err => {
                logger.warn('[BOOKING COMPLETION] clearCustomerActiveBroadcast failed (non-fatal)', {
                  bookingId, customerId: booking.customerId, error: err instanceof Error ? err.message : String(err)
                });
              });

              // Notifications inside guard to prevent duplicates (QA-4 fix)
              if (booking.customerId) {
                emitToUser(booking.customerId, SocketEvent.BOOKING_UPDATED, {
                  bookingId,
                  status: 'completed',
                  totalTrucks: assignments.length,
                  message: `All ${assignments.length} deliveries complete!`
                });

                queueService.queuePushNotification(booking.customerId, {
                  title: 'All Deliveries Complete!',
                  body: `All ${assignments.length} truck(s) have completed delivery.`,
                  data: {
                    type: 'booking_status_changed',
                    bookingId,
                    status: 'completed',
                    totalTrucks: String(assignments.length)
                  }
                }).catch(err => {
                  logger.warn('[BOOKING COMPLETION] FCM push failed', { error: err.message });
                });
              }

              // Cascade: check if parent order is fully completed
              // Booking model has no orderId — look it up via assignment (QA-4 CRITICAL fix)
              const orderAssignment = await prismaClient.assignment.findFirst({
                where: { bookingId, orderId: { not: null } },
                select: { orderId: true }
              });
              if (orderAssignment?.orderId) {
                this.checkOrderCompletion(orderAssignment.orderId).catch(err =>
                  logger.warn('[ORDER COMPLETION] Check failed (non-fatal)', { orderId: orderAssignment.orderId, error: err.message })
                );
              }
            } else if (booking.status === 'cancelled') {
              logger.info('[BOOKING COMPLETION] Booking already cancelled, skipping completion', { bookingId });
            }
          }
        } else {
          const completedCount = assignments.filter(a => a.status === 'completed').length;
          logger.info(`[BOOKING COMPLETION] ${completedCount}/${assignments.length} trucks completed for booking ${bookingId}`);
        }
      } finally {
        await redisService.releaseLock(lockKey, 'completion-checker');
      }
    } catch (error: unknown) {
      // Non-critical — individual trip completion already succeeded
      logger.warn('[BOOKING COMPLETION] Check failed (non-fatal)', { bookingId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // ===========================================================================
  // ORDER COMPLETION CHECK (FIX A4#33)
  // ===========================================================================
  //
  // When a booking completes, check if ALL bookings/assignments for the parent
  // order are now terminal. If all completed (or mix of completed+cancelled
  // with at least one completed) → mark order 'completed'.
  // If ALL cancelled → mark order 'cancelled'.
  // Uses distributed lock to prevent duplicate updates across ECS instances.
  // ===========================================================================

  async checkOrderCompletion(orderId: string): Promise<void> {
    const lockKey = `order-completion:${orderId}`;
    const holderId = `order-completion:${process.pid}:${Date.now()}`;
    const lock = await redisService.acquireLock(lockKey, holderId, 10);
    if (!lock.acquired) {
      logger.debug('[ORDER COMPLETION] Lock not acquired (another instance handling)', { orderId });
      return;
    }

    try {
      // Get all assignments for this order
      const assignments = await prismaClient.assignment.findMany({
        where: { orderId },
        select: { id: true, status: true }
      });

      if (assignments.length === 0) return;

      // F-M25 FIX: Add partial_delivery to terminal status set
      const terminalStatuses = new Set(['completed', 'cancelled', 'partial_delivery']);
      const allTerminal = assignments.every(a => terminalStatuses.has(a.status));

      if (!allTerminal) {
        const completedCount = assignments.filter(a => a.status === 'completed').length;
        const cancelledCount = assignments.filter(a => a.status === 'cancelled').length;
        logger.info(`[ORDER COMPLETION] Not all terminal: ${completedCount} completed, ${cancelledCount} cancelled, ${assignments.length} total`, { orderId });
        return;
      }

      const hasCompleted = assignments.some(a => a.status === 'completed');
      const allCancelled = assignments.every(a => a.status === 'cancelled');

      let newOrderStatus: 'completed' | 'cancelled';
      if (allCancelled) {
        newOrderStatus = 'cancelled';
      } else if (hasCompleted) {
        newOrderStatus = 'completed';
      } else {
        return; // Should not happen, but guard
      }

      // Fetch current order to check idempotency and get customerId
      const order = await prismaClient.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, customerId: true }
      });

      if (!order) {
        logger.warn('[ORDER COMPLETION] Order not found', { orderId });
        return;
      }

      if (order.status === 'completed' || order.status === 'cancelled') {
        logger.info('[ORDER COMPLETION] Order already terminal, skipping', { orderId, status: order.status });
        return;
      }

      // CAS: only update if order is still active (prevents duplicate notifications)
      const updateResult = await prismaClient.order.updateMany({
        where: { id: orderId, status: { notIn: ['completed', 'cancelled'] } },
        data: { status: newOrderStatus }
      });

      if (updateResult.count === 0) {
        logger.info('[ORDER COMPLETION] Order already updated by concurrent process', { orderId });
        return;
      }

      // F-H18 FIX: Clear active-broadcast sentinel so customer can create new bookings
      if (order.customerId) {
        clearCustomerActiveBroadcast(order.customerId).catch(err => {
          logger.warn('[ORDER COMPLETION] clearCustomerActiveBroadcast failed (non-fatal)', {
            orderId, customerId: order.customerId, error: err instanceof Error ? err.message : String(err)
          });
        });
      }

      logger.info(`[ORDER COMPLETION] Order marked as ${newOrderStatus}`, {
        orderId,
        totalAssignments: assignments.length,
        completedCount: assignments.filter(a => a.status === 'completed').length,
        cancelledCount: assignments.filter(a => a.status === 'cancelled').length
      });

      // Notify customer
      if (order.customerId) {
        if (newOrderStatus === 'completed') {
          emitToUser(order.customerId, SocketEvent.ORDER_STATUS_UPDATE, {
            orderId,
            totalAssignments: assignments.length,
            message: `All deliveries for your order are complete!`
          });
          // Backward compat: Customer app listens for 'booking_completed' for rating trigger
          emitToUser(order.customerId, 'booking_completed', {
            orderId,
            bookingId: orderId,
            completedAt: new Date().toISOString()
          });

          queueService.queuePushNotification(order.customerId, {
            title: '✅ Order Complete!',
            body: `All ${assignments.length} delivery(ies) for your order are done. Rate your experience!`,
            data: {
              type: 'order_completed',
              orderId,
              totalAssignments: String(assignments.length)
            }
          }).catch(err => {
            logger.warn('[ORDER COMPLETION] FCM push failed', { orderId, error: err.message });
          });
        } else {
          emitToUser(order.customerId, SocketEvent.ORDER_STATUS_UPDATE, {
            orderId,
            totalAssignments: assignments.length,
            message: `Your order has been cancelled.`
          });
        }
      }
    } finally {
      await redisService.releaseLock(lockKey, holderId).catch(() => {});
    }
  }
}

export const trackingFleetService = new TrackingFleetService();
