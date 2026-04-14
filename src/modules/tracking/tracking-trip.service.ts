/**
 * =============================================================================
 * TRACKING MODULE - TRIP LIFECYCLE SERVICE
 * =============================================================================
 *
 * Handles trip initialization, status updates (driver progression),
 * trip completion, geofence checks, and proximity notifications.
 * =============================================================================
 */

import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToBooking, emitToTrip, emitToUser, SocketEvent } from '../../shared/services/socket.service';
import { redisService } from '../../shared/services/redis.service';
import { queueService } from '../../shared/services/queue.service';
import { releaseVehicle } from '../../shared/services/vehicle-lifecycle.service';
import { haversineDistanceMeters } from '../../shared/utils/geospatial.utils';
import { safeJsonParse } from '../../shared/utils/safe-json.utils';
import { prismaClient } from '../../shared/database/prisma.service';
import { AssignmentStatus } from '@prisma/client';
import { googleMapsService } from '../../shared/services/google-maps.service';
import { metrics } from '../../shared/monitoring/metrics.service';
import { TripStatusUpdateInput } from './tracking.schema';
import {
  REDIS_KEYS,
  TTL,
  LocationData,
} from './tracking.types';
import { trackingHistoryService } from './tracking-history.service';
import { trackingFleetService } from './tracking-fleet.service';
import { ASSIGNMENT_VALID_TRANSITIONS } from '../../core/state-machines';

class TrackingTripService {
  // =========================================================================
  // Issue #46 FIX: Retry with backoff for tracking initialization
  //
  // PROBLEM: If initializeTracking fails (Redis blip, network timeout),
  //   the customer sees "accepted" but gets no live location updates.
  //   The driver appears as a ghost — accepted but invisible on the map.
  //
  // FIX: Retry up to 3 times with linear backoff (1s, 2s, 3s).
  //   If all retries fail, log CRITICAL so ops can investigate, but
  //   don't throw — the assignment itself already succeeded in Postgres.
  // =========================================================================

  private static readonly TRACKING_INIT_MAX_RETRIES = 3;

  /**
   * Initialize tracking for a trip (called when assignment starts).
   * Retries up to 3 times with linear backoff on failure.
   */
  async initializeTracking(
    tripId: string,
    driverId: string,
    vehicleNumber: string,
    bookingId: string,
    transporterId?: string,
    vehicleId?: string,
    orderId?: string
  ): Promise<void> {
    const maxRetries = TrackingTripService.TRACKING_INIT_MAX_RETRIES;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.doInitializeTracking(tripId, driverId, vehicleNumber, bookingId, transporterId, vehicleId, orderId);
        metrics.incrementCounter('tracking.init_success_total');
        return; // Success
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[TRACKING] Tracking initialization failed', {
          tripId, bookingId, attempt, maxRetries, error: message
        });
        metrics.incrementCounter('tracking.init_retry_total', { attempt: String(attempt) });

        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * attempt)); // 1s, 2s, 3s backoff
        }
      }
    }

    // All retries exhausted
    metrics.incrementCounter('tracking.init_failure_total');
    logger.error('CRITICAL: Tracking initialization failed after all retries — customer will see accepted but no live tracking', {
      tripId, driverId, bookingId, vehicleId, maxRetries
    });
  }

  /**
   * Core tracking initialization logic (extracted for retry wrapper).
   */
  private async doInitializeTracking(
    tripId: string,
    driverId: string,
    vehicleNumber: string,
    bookingId: string,
    transporterId?: string,
    vehicleId?: string,
    orderId?: string
  ): Promise<void> {
    const now = new Date().toISOString();

    const locationData: LocationData = {
      tripId,
      driverId,
      transporterId,
      vehicleId,
      vehicleNumber,
      bookingId,
      orderId,
      latitude: 0,
      longitude: 0,
      speed: 0,
      bearing: 0,
      status: 'pending',
      lastUpdated: now
    };

    // Store in Redis
    await redisService.setJSON(REDIS_KEYS.TRIP_LOCATION(tripId), locationData, TTL.TRIP);

    // Add to booking's trip list
    if (bookingId) {
      await redisService.sAdd(REDIS_KEYS.BOOKING_TRIPS(bookingId), tripId);
      await redisService.expire(REDIS_KEYS.BOOKING_TRIPS(bookingId), TTL.TRIP);
    }

    // Add driver to transporter's fleet
    if (transporterId) {
      await trackingFleetService.addDriverToFleet(transporterId, driverId);
    }

    // Initialize empty history
    await redisService.del(REDIS_KEYS.TRIP_HISTORY(tripId));
    await trackingHistoryService.deleteHistoryPersistState(tripId);

    logger.info('[TRACKING] Tracking initialized', { tripId, driverId, bookingId });
  }

  /**
   * Update tracking status
   */
  async updateStatus(tripId: string, status: string): Promise<void> {
    const location = await redisService.getJSON<LocationData>(REDIS_KEYS.TRIP_LOCATION(tripId));
    if (location) {
      location.status = status;
      location.lastUpdated = new Date().toISOString();
      await redisService.setJSON(REDIS_KEYS.TRIP_LOCATION(tripId), location, TTL.TRIP);

      // Broadcast status update
      emitToTrip(tripId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
        tripId,
        status,
        timestamp: location.lastUpdated
      });
    }
  }

  /**
   * Update trip status — Driver status progression.
   * Called by Captain app: "Reached Pickup" -> "Loading" -> "Start Trip" -> "Complete".
   * Validates ownership, updates Postgres + Redis, broadcasts via WebSocket + FCM.
   */
  async updateTripStatus(
    tripId: string,
    driverId: string,
    data: TripStatusUpdateInput
  ): Promise<void> {
    const { status } = data;

    try {
      logger.info('[TRACKING] Updating trip status', { tripId, driverId, status });

      // 1. Look up assignment by tripId
      const assignment = await prismaClient.assignment.findUnique({
        where: { tripId },
        include: {
          booking: { select: { customerId: true, customerName: true, id: true, pickup: true, drop: true } },
          order: { select: { id: true, customerId: true, pickup: true, drop: true } }
        }
      });

      if (!assignment) {
        throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'No assignment found for this trip');
      }

      if (assignment.driverId !== driverId) {
        throw new AppError(403, 'FORBIDDEN', 'This trip is not assigned to you');
      }

      // 1b. H13: Use canonical ASSIGNMENT_VALID_TRANSITIONS (single source of truth)
      // Replaces ordinal-based validation — enforces M-20 (no direct in_transit→completed)

      if (assignment.status === 'completed') {
        throw new AppError(400, 'TRIP_ALREADY_COMPLETED', 'This trip is already completed');
      }

      if (assignment.status === 'cancelled' || assignment.status === 'driver_declined') {
        throw new AppError(400, 'TRIP_NOT_ACTIVE', 'This trip is no longer active');
      }

      // Idempotent: same status = no-op
      if (assignment.status === status) {
        logger.info('[TRACKING] Idempotent status update — already at this status', { tripId, status });
        return;
      }

      const allowedNext = ASSIGNMENT_VALID_TRANSITIONS[assignment.status] ?? [];
      if (!allowedNext.includes(status)) {
        throw new AppError(400, 'INVALID_STATUS_TRANSITION',
          `Cannot go from ${assignment.status} to ${status}. ` +
          `Allowed: [${(allowedNext as readonly string[]).join(', ')}]`);
      }

      // Phase 7A: Geofence check — driver must be within 200m of pickup
      if (status === 'at_pickup') {
        const driverLocation = await redisService.getJSON<LocationData>(
          REDIS_KEYS.DRIVER_LOCATION(driverId)
        );
        if (driverLocation?.latitude && driverLocation?.longitude) {
          const pickupSource = assignment.order?.pickup || assignment.booking?.pickup;
          const pickupData = (typeof pickupSource === 'string'
            ? safeJsonParse<Record<string, unknown>>(pickupSource, {})
            : pickupSource) as Record<string, unknown> | undefined;
          const pickupLat = pickupData?.latitude || pickupData?.lat;
          const pickupLng = pickupData?.longitude || pickupData?.lng;
          if (pickupLat && pickupLng) {
            const MAX_ARRIVAL_DISTANCE_M = parseInt(
              process.env.MAX_ARRIVAL_DISTANCE_METERS || '200', 10
            );
            try {
              // Use Google Directions API for accurate road distance
              const eta = await googleMapsService.getETA(
                { lat: driverLocation.latitude, lng: driverLocation.longitude },
                { lat: Number(pickupLat), lng: Number(pickupLng) }
              );
              if (eta) {
                const roadDistanceMeters = eta.distanceKm * 1000;
                if (roadDistanceMeters > MAX_ARRIVAL_DISTANCE_M) {
                  logger.warn('[TRACKING] Arrival rejected — too far from pickup (road distance)', {
                    tripId, driverId,
                    roadDistanceMeters: Math.round(roadDistanceMeters),
                    maxAllowed: MAX_ARRIVAL_DISTANCE_M
                  });
                  throw new AppError(400, 'TOO_FAR_FROM_PICKUP',
                    `You are ${Math.round(roadDistanceMeters)}m away by road. Please move within ${MAX_ARRIVAL_DISTANCE_M}m of pickup.`
                  );
                }
              }
              // If eta is null (Google API failed), allow through
            } catch (geoErr: unknown) {
              // If it's our own AppError (TOO_FAR), re-throw it
              if (geoErr instanceof AppError) throw geoErr;
              // Otherwise Google API failed — allow through (don't block legitimate arrivals)
              logger.warn('[TRACKING] Google Directions geofence check failed, allowing through', {
                tripId, error: geoErr instanceof Error ? geoErr.message : String(geoErr)
              });
            }
          }
        }
        // If no GPS data in Redis, allow — don't block legitimate arrivals
      }

      // F-M23: Drop-off geofence — driver must be near drop location (fail-open, 500m default)
      if (status === 'arrived_at_drop') {
        const driverLocation = await redisService.getJSON<LocationData>(
          REDIS_KEYS.DRIVER_LOCATION(driverId)
        );
        if (driverLocation?.latitude && driverLocation?.longitude) {
          const dropSource = assignment.order?.drop || assignment.booking?.drop;
          const dropData = (typeof dropSource === 'string'
            ? safeJsonParse<Record<string, unknown>>(dropSource, {})
            : dropSource) as Record<string, unknown> | undefined;
          const dropLat = dropData?.latitude || dropData?.lat;
          const dropLng = dropData?.longitude || dropData?.lng;
          if (dropLat && dropLng) {
            const MAX_DROP_DISTANCE_M = parseInt(
              process.env.MAX_DROP_ARRIVAL_DISTANCE_METERS || '500', 10
            );
            try {
              const eta = await googleMapsService.getETA(
                { lat: driverLocation.latitude, lng: driverLocation.longitude },
                { lat: Number(dropLat), lng: Number(dropLng) }
              );
              if (eta) {
                const roadDistanceMeters = eta.distanceKm * 1000;
                if (roadDistanceMeters > MAX_DROP_DISTANCE_M) {
                  logger.warn('[TRACKING] Drop-off arrival rejected — too far from drop (road distance)', {
                    tripId, driverId,
                    roadDistanceMeters: Math.round(roadDistanceMeters),
                    maxAllowed: MAX_DROP_DISTANCE_M
                  });
                  throw new AppError(400, 'TOO_FAR_FROM_DROP',
                    `You are ${Math.round(roadDistanceMeters)}m away. Please move within ${MAX_DROP_DISTANCE_M}m of drop-off.`
                  );
                }
              }
              // If eta is null (Google API failed), allow through
            } catch (geoErr: unknown) {
              // If it's our own AppError (TOO_FAR_FROM_DROP), re-throw it
              if (geoErr instanceof AppError) throw geoErr;
              // Otherwise Google API failed — fail-open: allow status change
              logger.warn('[TRACKING] Drop geofence check failed, allowing through', {
                tripId, error: geoErr instanceof Error ? geoErr.message : String(geoErr)
              });
            }
          }
        }
        // If no GPS data in Redis, allow — don't block legitimate arrivals
      }

      // 2. Map Captain app status to Prisma enum ('loading_complete' is Redis-only)
      const prismaStatusMap: Record<string, string | null> = {
        'heading_to_pickup': 'en_route_pickup',
        'at_pickup': 'at_pickup',
        'loading_complete': null,  // Redis-only, skip Prisma update
        'in_transit': 'in_transit',
        'arrived_at_drop': 'arrived_at_drop',
        'completed': 'completed'
      };

      const prismaStatus = prismaStatusMap[status];

      // H-20: POD gate — block completion until delivery OTP is verified
      // Dynamic require avoids circular dependency with pod.service
      if (status === 'completed') {
        const { isPodRequired } = require('./pod.service');
        if (isPodRequired()) {
          const podVerified = await redisService.get(`pod:verified:${tripId}`);
          if (!podVerified) {
            throw new AppError(400, 'POD_OTP_REQUIRED',
              'Delivery OTP verification required before completing this trip');
          }
        }
      }

      // 3. Update Assignment in Postgres
      if (prismaStatus) {
        const updates: Record<string, any> = { status: prismaStatus };

        if (prismaStatus === 'in_transit') {
          updates.startedAt = new Date().toISOString();
        }
        if (prismaStatus === 'completed') {
          updates.completedAt = new Date().toISOString();
        }

        if (prismaStatus === 'completed') {
          // F-C3 FIX: Atomic completion — assignment CAS update + vehicle release in one TX
          // F-M20 FIX: CAS update with status precondition prevents concurrent double-completion
          const txOps: any[] = [
            prismaClient.assignment.updateMany({
              where: {
                tripId,
                status: { in: ['in_transit', 'arrived_at_drop'] as any }
              },
              data: updates
            })
          ];
          // Include vehicle status release in the same transaction
          if (assignment.vehicleId) {
            txOps.push(
              prismaClient.vehicle.updateMany({
                where: { id: assignment.vehicleId, status: { not: 'available' as any } },
                data: {
                  status: 'available' as any,
                  currentTripId: null,
                  assignedDriverId: null,
                  lastStatusChange: new Date().toISOString()
                }
              })
            );
          }
          const txResults = await prismaClient.$transaction(txOps);
          const completionResult = txResults[0] as { count: number };
          // Idempotent: if CAS matched 0 rows, this completion was already applied
          if (completionResult.count === 0) {
            logger.info('[TRACKING] Completion already applied (CAS idempotent)', { tripId });
            return;
          }
        } else {
          // F-M20 FIX: Non-completion statuses — CAS updateMany with terminal-status guard
          const updateResult = await prismaClient.assignment.updateMany({
            where: {
              tripId,
              status: { not: { in: ['completed', 'cancelled'] as any } }
            },
            data: updates
          });
          if (updateResult.count === 0) {
            logger.info('[TRACKING] Status update skipped (CAS — already terminal)', { tripId, status: prismaStatus });
          }
        }

        // M6 FIX: Wire parent Order/Booking to in_progress when first assignment
        // hits in_transit (mirrors H-36 fix in assignment.service.ts).
        // CAS pattern: only transitions from pre-transit states. Non-fatal.
        if (prismaStatus === 'in_transit') {
          try {
            if (assignment.orderId || assignment.order?.id) {
              await prismaClient.order.updateMany({
                where: {
                  id: (assignment.orderId || assignment.order?.id)!,
                  status: { in: ['fully_filled', 'partially_filled'] },
                },
                data: { status: 'in_progress' },
              });
            }
            if (assignment.bookingId || assignment.booking?.id) {
              await prismaClient.booking.updateMany({
                where: {
                  id: (assignment.bookingId || assignment.booking?.id)!,
                  status: { in: ['fully_filled', 'partially_filled'] },
                },
                data: { status: 'in_progress' },
              });
            }
          } catch (err) {
            logger.warn('[TRACKING] Failed to transition parent to in_progress (non-fatal)', {
              tripId, error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Phase 7 (7E): Populate Order timestamps for cancel policy stage detection
        const targetOrderId = assignment.orderId || assignment.order?.id;
        if (targetOrderId) {
          if (status === 'at_pickup') {
            await prismaClient.order.update({
              where: { id: targetOrderId },
              data: { loadingStartedAt: new Date() }
            }).catch(err => {
              logger.warn('[TRACKING] Failed to set loadingStartedAt (non-fatal)', {
                orderId: targetOrderId, error: err.message
              });
            });
          }
          if (status === 'arrived_at_drop') {
            await prismaClient.order.update({
              where: { id: targetOrderId },
              data: { unloadingStartedAt: new Date() }
            }).catch(err => {
              logger.warn('[TRACKING] Failed to set unloadingStartedAt (non-fatal)', {
                orderId: targetOrderId, error: err.message
              });
            });
          }
        }
      }

      // H-20: POD OTP generation — fire-and-forget at arrived_at_drop
      // Dynamic require avoids circular dependency with pod.service
      if (status === 'arrived_at_drop') {
        const { isPodRequired, generatePodOtp } = require('./pod.service');
        if (isPodRequired()) {
          const customerId = assignment.booking?.customerId || assignment.order?.customerId;
          if (customerId) {
            generatePodOtp(tripId, customerId).catch((err: any) =>
              logger.warn('[POD] OTP generation failed (non-fatal)', {
                tripId, assignmentId: assignment.id, error: err instanceof Error ? err.message : String(err)
              })
            );
          }
        }
      }

      // 4. Update Redis tracking data (graceful — Postgres already succeeded)
      try {
        await this.updateStatus(tripId, status);
      } catch (redisErr: unknown) {
        logger.warn('[TRACKING] Redis status update failed (Postgres already updated, non-fatal)', {
          tripId, status, error: redisErr instanceof Error ? redisErr.message : String(redisErr)
        });
      }

      // 5. Complete tracking cleanup (completeTracking broadcasts its own WS event)
      if (status === 'completed') {
        // Phase 9A: Double-tap guard — Redis lock prevents race condition
        // Scenario: Two rapid "Complete" taps → both pass Postgres idempotent check
        //           before first one commits → duplicate completion events.
        // Solution: SETNX lock with 10s TTL. Second tap gets lock-failed → returns silently.
        const tripCompleteLock = `lock:trip-complete:${tripId}`;
        const completeLock = await redisService.acquireLock(tripCompleteLock, 'trip-completion', 10);
        if (!completeLock.acquired) {
          logger.info('[TRACKING] Trip completion already in progress (double-tap guard)', { tripId });
          return; // Idempotent — first request will handle everything
        }

        try {
          try {
            await this.completeTracking(tripId);
          } catch (completeErr: unknown) {
            logger.warn('[TRACKING] completeTracking cleanup failed (non-fatal)', {
              tripId, error: completeErr instanceof Error ? completeErr.message : String(completeErr)
            });
          }

          // H-23: Flush GPS history from Redis to TripRoutePoint DB table
          // Fire-and-forget: route data stays in Redis for 7 days as backup
          trackingHistoryService.flushHistoryToDb(tripId).catch(flushErr => {
            logger.warn('[TRACKING] flushHistoryToDb failed (non-fatal)', {
              tripId, error: flushErr instanceof Error ? flushErr.message : String(flushErr)
            });
          });

          // =================================================================
          // FIX 7.6: Release vehicle back to 'available' on completion
          // =================================================================
          // F-C3: Vehicle DB status already updated atomically in the
          // completion TX above. This releaseVehicle call now serves as
          // a Redis cache sync fallback — it is idempotent (no-ops if
          // vehicle is already 'available' in DB).
          // =================================================================
          if (assignment.vehicleId) {
            try {
              await releaseVehicle(assignment.vehicleId, 'tripCompletion');
            } catch (vehErr: unknown) {
              logger.error('[TRACKING] releaseVehicle failed, enqueueing retry', {
                vehicleId: assignment.vehicleId, tripId, error: vehErr instanceof Error ? vehErr.message : String(vehErr)
              });
              queueService.enqueue('vehicle-release', {
                vehicleId: assignment.vehicleId,
                context: 'tripCompletion'
              }).catch((err) => { logger.warn('[TrackingTrip] Vehicle release queue enqueue failed', { vehicleId: assignment.vehicleId, error: err instanceof Error ? err.message : String(err) }); });
            }
          }

          // Phase 5: Check if ALL trucks for this booking are now completed
          // If yes → update booking status + notify customer
          const completedBookingId = assignment.booking?.id || assignment.bookingId;
          if (completedBookingId) {
            trackingFleetService.checkBookingCompletion(completedBookingId).catch(err => {
              logger.warn('[TRACKING] Booking completion check failed (non-fatal)', {
                bookingId: completedBookingId, error: err.message
              });
            });
          }
        } finally {
          await redisService.releaseLock(tripCompleteLock, 'trip-completion').catch(() => { });
        }
      }

      // 6. FCM push to customer (fire-and-forget)
      const customerId = assignment.booking?.customerId;
      const bookingId = assignment.booking?.id || assignment.bookingId;

      if (customerId) {
        const statusMessages: Record<string, { title: string; body: string }> = {
          'heading_to_pickup': {
            title: '🚛 Driver on the way',
            body: `Driver ${assignment.driverName} is heading to pickup location`
          },
          'at_pickup': {
            title: '📍 Driver arrived at pickup',
            body: `Driver ${assignment.driverName} has arrived at the pickup location`
          },
          'loading_complete': {
            title: '📦 Loading complete',
            body: `Loading is complete. ${assignment.driverName} will start the trip shortly`
          },
          'in_transit': {
            title: '🚀 Trip started!',
            body: `Your truck (${assignment.vehicleNumber}) is on the way to the destination`
          },
          'arrived_at_drop': {
            title: '📍 Driver arrived at drop-off',
            body: `Driver ${assignment.driverName} has arrived at the drop-off location`
          },
          'completed': {
            title: '✅ Delivery complete!',
            body: `Your delivery by ${assignment.vehicleNumber} has been completed`
          }
        };

        const message = statusMessages[status];
        if (message) {
          queueService.queuePushNotification(customerId, {
            title: message.title,
            body: message.body,
            data: {
              type: 'trip_status_update',
              tripId,
              status,
              assignmentId: assignment.id,
              bookingId: bookingId || '',
              vehicleNumber: assignment.vehicleNumber,
              driverName: assignment.driverName
            }
          }).catch(err => {
            logger.warn('[TRACKING] FCM push failed (non-critical)', {
              tripId, customerId, error: err.message
            });
          });
        }
      }

      // 7. WebSocket broadcast to booking + transporter
      const broadcastPayload = {
        tripId,
        assignmentId: assignment.id,
        status,
        vehicleNumber: assignment.vehicleNumber,
        driverName: assignment.driverName,
        timestamp: new Date().toISOString()
      };

      if (bookingId) {
        emitToBooking(bookingId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, broadcastPayload);
      }

      // For non-completed statuses, also broadcast to trip room
      // (completeTracking already handles this for 'completed')
      if (status !== 'completed') {
        emitToTrip(tripId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, broadcastPayload);
      }

      // Notify transporter of all status changes
      emitToUser(assignment.transporterId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, broadcastPayload);

      logger.info('[TRACKING] Trip status updated successfully', {
        tripId, status, driverId, vehicleNumber: assignment.vehicleNumber
      });

    } catch (error: unknown) {
      logger.error('[TRACKING] Failed to update trip status', {
        tripId, driverId, status, error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack?.substring(0, 300) : undefined
      });

      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(500, 'INTERNAL_ERROR', 'Failed to update trip status');
    }
  }

  /**
   * Clean up tracking when trip completes
   */
  async completeTracking(tripId: string): Promise<void> {
    const location = await redisService.getJSON<LocationData>(REDIS_KEYS.TRIP_LOCATION(tripId));

    if (location) {
      location.status = 'completed';
      location.lastUpdated = new Date().toISOString();
      await redisService.setJSON(REDIS_KEYS.TRIP_LOCATION(tripId), location, TTL.TRIP);

      // Remove driver from active fleet
      if (location.transporterId) {
        await redisService.sRem(REDIS_KEYS.FLEET_DRIVERS(location.transporterId), location.driverId);
        const fleetSize = await redisService.sCard(REDIS_KEYS.FLEET_DRIVERS(location.transporterId));
        if (fleetSize <= 0) {
          await redisService.sRem(REDIS_KEYS.ACTIVE_FLEET_TRANSPORTERS, location.transporterId);
        }
      }

      // Broadcast completion
      emitToTrip(tripId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
        tripId,
        status: 'completed',
        timestamp: location.lastUpdated
      });
    }

    await trackingHistoryService.deleteHistoryPersistState(tripId);

    logger.info('✅ Tracking completed', { tripId });
  }

  /**
   * Proximity notification — sends FCM when driver is within 2km of pickup.
   * Uses 4-step cascade: Redis flag -> haversine -> Google Directions -> notify.
   * Sent once per trip per driver (Redis flag with 30min TTL).
   */
  async checkAndSendProximityNotification(
    tripId: string,
    driverId: string,
    driverLat: number,
    driverLng: number,
    existing: LocationData
  ): Promise<void> {
    const PROXIMITY_KEY = `proximity_notified:${tripId}`;

    // Step 1: Redis flag check — already notified? Skip immediately.
    const alreadyNotified = await redisService.get(PROXIMITY_KEY);
    if (alreadyNotified) return;

    // Step 2: Rough haversine check — if driver is > 3km straight-line, skip Google API
    // This prevents calling Google API on 99%+ of location updates
    const entityId = existing.orderId || existing.bookingId;
    if (!entityId) return;

    // Get pickup location
    let pickupLat: number | null = null;
    let pickupLng: number | null = null;
    let customerId: string | null = null;
    let vehicleNumber = existing.vehicleNumber || '';
    let driverName = '';

    // Try order first, then booking
    const assignment = await prismaClient.assignment.findFirst({
      where: { tripId },
      select: {
        driverName: true,
        vehicleNumber: true,
        vehicleType: true,
        order: { select: { pickup: true, customerId: true } },
        booking: { select: { pickup: true, customerId: true } }
      }
    });

    if (!assignment) return;

    driverName = assignment.driverName || '';
    vehicleNumber = assignment.vehicleNumber || vehicleNumber;

    const pickupSource = assignment.order?.pickup || assignment.booking?.pickup;
    const pickupData = typeof pickupSource === 'string'
      ? safeJsonParse<Record<string, unknown>>(pickupSource, {})
      : pickupSource as Record<string, unknown> | undefined;

    pickupLat = Number(pickupData?.latitude || pickupData?.lat);
    pickupLng = Number(pickupData?.longitude || pickupData?.lng);
    customerId = assignment.order?.customerId || assignment.booking?.customerId || null;

    if (!pickupLat || !pickupLng || !customerId) return;

    // Quick straight-line check — skip Google API if clearly > 3km away
    const straightLineMeters = haversineDistanceMeters(
      driverLat, driverLng, pickupLat, pickupLng
    );
    if (straightLineMeters > 3000) return; // Too far, skip Google API call

    // Step 3: Google Directions API — accurate road distance
    const PROXIMITY_THRESHOLD_KM = parseFloat(
      process.env.DRIVER_PROXIMITY_NOTIFICATION_KM || '2'
    );

    const eta = await googleMapsService.getETA(
      { lat: driverLat, lng: driverLng },
      { lat: pickupLat, lng: pickupLng }
    );

    if (!eta || eta.distanceKm > PROXIMITY_THRESHOLD_KM) return;

    // Step 4: Driver is within 2km by road — send notification!
    // Set Redis flag FIRST (prevent race condition with concurrent GPS updates)
    await redisService.set(PROXIMITY_KEY, '1', 1800); // 30 min TTL

    // Send FCM push to customer
    queueService.queuePushNotification(customerId, {
      title: '🚛 Your driver is almost here!',
      body: `${driverName} (${vehicleNumber}) is about ${eta.durationText} away`,
      data: {
        type: 'driver_approaching',
        tripId,
        driverId,
        vehicleNumber,
        driverName,
        distanceKm: String(eta.distanceKm.toFixed(1)),
        durationMinutes: String(eta.durationMinutes),
        durationText: eta.durationText
      }
    }).catch(err => {
      logger.warn('[TRACKING] Proximity FCM push failed (non-fatal)', {
        tripId, customerId, error: err?.message
      });
    });

    // Also emit via WebSocket for instant UI update
    emitToUser(customerId, 'driver_approaching', {
      tripId,
      driverId,
      vehicleNumber,
      driverName,
      distanceKm: eta.distanceKm,
      durationMinutes: eta.durationMinutes,
      durationText: eta.durationText,
      timestamp: new Date().toISOString()
    });

    logger.info('[TRACKING] Proximity notification sent — driver within 2km', {
      tripId, driverId, vehicleNumber,
      roadDistanceKm: eta.distanceKm.toFixed(1),
      durationText: eta.durationText
    });
  }

  // ===========================================================================
  // Issue #59 FIX: Trip tracking reconciliation with orphan alerting
  //
  // PROBLEM: When Redis has trip tracking keys with no matching active
  //   DB assignment, the customer/transporter sees stale tracking data.
  //   Previously these orphans were silently ignored.
  //
  // FIX: Periodic reconciliation sweep that:
  //   1. Scans Redis for trip tracking keys
  //   2. Cross-references with Postgres assignments
  //   3. Logs RECONCILIATION ALERT with count, IDs, and oldest age
  //   4. Increments metric counter for monitoring dashboards
  //   5. Cleans up orphaned Redis keys
  // ===========================================================================

  /**
   * Reconcile tracking trip keys in Redis against active DB assignments.
   * Finds orphaned tracking records (Redis key exists but no active assignment).
   * Returns count of orphaned records found and cleaned.
   */
  async reconcileTrackingTrips(): Promise<{ orphanedCount: number; cleanedCount: number }> {
    const sweepStart = Date.now();
    let orphanedCount = 0;
    let cleanedCount = 0;

    try {
      // Scan Redis for all trip tracking keys
      const tripKeys: string[] = [];
      for await (const key of redisService.scanIterator('driver:trip:*')) {
        tripKeys.push(key);
      }

      if (tripKeys.length === 0) {
        metrics.observeHistogram('reconciliation.sweep_duration_ms', Date.now() - sweepStart, { type: 'tracking' });
        return { orphanedCount: 0, cleanedCount: 0 };
      }

      // Extract tripIds from keys
      const tripIdMap = new Map<string, string>(); // tripId -> redisKey
      for (const key of tripKeys) {
        const tripId = key.replace('driver:trip:', '');
        if (tripId) {
          tripIdMap.set(tripId, key);
        }
      }

      // Batch-check which tripIds have active assignments in DB
      const activeAssignments = await prismaClient.assignment.findMany({
        where: {
          tripId: { in: Array.from(tripIdMap.keys()) },
          status: { in: ['pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit'] as AssignmentStatus[] },
        },
        select: { tripId: true },
      });

      const activeTripIds = new Set(activeAssignments.map(a => a.tripId).filter(Boolean));

      // Find orphaned trip keys
      const orphanedRecords: Array<{ tripId: string; redisKey: string; locationData: LocationData | null }> = [];

      for (const [tripId, redisKey] of tripIdMap) {
        if (!activeTripIds.has(tripId)) {
          const locationData = await redisService.getJSON<LocationData>(redisKey);
          orphanedRecords.push({ tripId, redisKey, locationData });
        }
      }

      orphanedCount = orphanedRecords.length;

      if (orphanedRecords.length > 0) {
        // Compute oldest age for alerting
        const ages = orphanedRecords
          .map(r => r.locationData?.lastUpdated ? Date.now() - new Date(r.locationData.lastUpdated).getTime() : 0)
          .filter(a => a > 0);
        const oldestAgeMs = ages.length > 0 ? Math.max(...ages) : 0;

        logger.error('RECONCILIATION ALERT: Orphaned tracking records found', {
          type: 'tracking',
          count: orphanedRecords.length,
          ids: orphanedRecords.map(r => r.tripId).slice(0, 10),
          oldestAgeMs,
          oldestAgeMinutes: Math.round(oldestAgeMs / 60000),
        });

        metrics.incrementCounter('reconciliation.orphaned_records_total', { type: 'tracking' }, orphanedRecords.length);
        metrics.incrementCounter('reconciliation.tracking_orphans_total', {}, orphanedRecords.length);

        // Clean up orphaned keys (only if older than 10 minutes to avoid race with fresh accepts)
        const MIN_ORPHAN_AGE_MS = 10 * 60 * 1000;
        for (const record of orphanedRecords) {
          const age = record.locationData?.lastUpdated
            ? Date.now() - new Date(record.locationData.lastUpdated).getTime()
            : Infinity;
          if (age >= MIN_ORPHAN_AGE_MS) {
            try {
              await redisService.del(record.redisKey);
              cleanedCount++;
            } catch (delErr: unknown) {
              const msg = delErr instanceof Error ? delErr.message : String(delErr);
              logger.warn('[RECONCILIATION] Failed to delete orphaned tracking key', {
                redisKey: record.redisKey, error: msg
              });
            }
          }
        }

        logger.info('[RECONCILIATION] Tracking sweep complete', {
          orphanedCount,
          cleanedCount,
          skippedTooYoung: orphanedCount - cleanedCount,
        });
      }

      metrics.observeHistogram('reconciliation.sweep_duration_ms', Date.now() - sweepStart, { type: 'tracking' });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[RECONCILIATION] Tracking reconciliation sweep failed', {
        error: message,
        elapsedMs: Date.now() - sweepStart,
      });
    }

    return { orphanedCount, cleanedCount };
  }
}

export const trackingTripService = new TrackingTripService();
