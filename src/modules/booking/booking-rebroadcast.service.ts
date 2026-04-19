/**
 * =============================================================================
 * BOOKING MODULE - REBROADCAST SERVICE
 * =============================================================================
 *
 * Handles:
 * - deliverMissedBroadcasts (Requirement 1: Transporter Toggle -> Re-Broadcast)
 * =============================================================================
 */

import { db, BookingRecord } from '../../shared/database/db';
import { prismaClient } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, SocketEvent } from '../../shared/services/socket.service';
import { fcmService } from '../../shared/services/fcm.service';
import { availabilityService } from '../../shared/services/availability.service';
import { redisService } from '../../shared/services/redis.service';
import { queueService } from '../../shared/services/queue.service';
import { haversineDistanceKm } from '../../shared/utils/geospatial.utils';
import { buildBroadcastPayload, getRemainingTimeoutSeconds } from './booking-payload.helper';
import { BOOKING_CONFIG } from './booking.types';

// FIX #56: Unified broadcast radius cap — rebroadcast geo filter and DB fallback
// now use the same configurable value (was 150km vs 200km mismatch).
const MAX_BROADCAST_RADIUS_KM = parseInt(process.env.MAX_BROADCAST_RADIUS_KM || '100', 10);

export class BookingRebroadcastService {

  // ==========================================================================
  // DELIVER MISSED BROADCASTS (Requirement 1: Transporter Toggle → Re-Broadcast)
  // ==========================================================================

  /**
   * Deliver all active, unexpired bookings to a transporter who just came online.
   *
   * Called AFTER the toggle-to-ONLINE state change succeeds.
   * Fire-and-forget — does NOT block the toggle API response.
   *
   * FLOW:
   * 1. Fetch all active/partially_filled bookings matching transporter's fleet
   * 2. Filter out expired bookings (expiresAt < now)
   * 3. Emit `new_broadcast` for each via WebSocket
   * 4. Send FCM push for background delivery
   *
   * SCALABILITY:
   * - Uses existing getActiveBookingsForTransporter() — indexed query
   * - Non-blocking (async, fire-and-forget from caller)
   * - No distributed lock needed (read-only, idempotent delivery)
   */
  async deliverMissedBroadcasts(transporterId: string): Promise<void> {
    try {
      // Rate limit: max once per 10 seconds per transporter to prevent DOS via rapid toggle
      const rateLimitKey = `ratelimit:missed-broadcasts:${transporterId}`;
      const existing = await redisService.get(rateLimitKey).catch((): null => null);
      if (existing) {
        logger.info(`[RE-BROADCAST] Rate limited for transporter ${transporterId} — skipping`);
        return;
      }
      await redisService.set(rateLimitKey, '1', 10).catch(() => { });

      const bookings = await db.getActiveBookingsForTransporter(transporterId);
      const now = new Date();

      // Filter: only unexpired bookings created within last 30 minutes (prevents huge fan-out)
      const thirtyMinsAgo = new Date(now.getTime() - 30 * 60 * 1000);
      let activeBookings = bookings.filter((b: BookingRecord) => {
        if (!b.expiresAt) return true; // No expiry = still active
        if (new Date(b.expiresAt) <= now) return false; // Already expired
        // Only deliver recent bookings — old ones are unlikely to still need trucks
        const createdAt = b.createdAt ? new Date(b.createdAt) : now;
        return createdAt >= thirtyMinsAgo;
      }).slice(0, 20); // Cap at 20 to prevent unbounded fan-out

      // ===================================================================
      // GEO FILTER: Only deliver bookings within MAX_BROADCAST_RADIUS_KM of
      // transporter's current location. Graceful fallback: if location not
      // in Redis yet (transporter just toggled online, GPS ping hasn't
      // arrived), deliver all — same safe behaviour as before this fix.
      // FIX #56: Uses unified MAX_BROADCAST_RADIUS_KM (env-configurable,
      // default 200km) — was hardcoded 150km, mismatching DB fallback 200km.
      // ===================================================================
      const transporterGeoDetails = await availabilityService
        .getTransporterDetails(transporterId)
        .catch((): null => null);

      if (transporterGeoDetails?.latitude && transporterGeoDetails?.longitude) {
        const beforeGeo = activeBookings.length;
        activeBookings = activeBookings.filter((b: BookingRecord) => {
          const distKm = haversineDistanceKm(
            transporterGeoDetails.latitude,
            transporterGeoDetails.longitude,
            b.pickup.latitude,
            b.pickup.longitude
          );
          return distKm <= MAX_BROADCAST_RADIUS_KM;
        });
        logger.info(
          `[RE-BROADCAST] Geo-filtered: ${beforeGeo} → ${activeBookings.length} ` +
          `bookings within ${MAX_BROADCAST_RADIUS_KM}km of transporter ${transporterId}`
        );
      } else {
        logger.info(
          `[RE-BROADCAST] No Redis location for transporter ${transporterId} ` +
          `— skipping geo filter (graceful fallback)`
        );
      }

      // Fix E10: Filter by vehicle subtype -- only deliver bookings matching transporter's fleet
      try {
        const transporterVehicles = await prismaClient.vehicle.findMany({
          where: { transporterId, status: { not: 'inactive' } },
          select: { vehicleType: true, vehicleSubtype: true }
        });
        if (transporterVehicles.length > 0) {
          const vehicleKeys = new Set(
            transporterVehicles.map(v => `${(v.vehicleType || '').toLowerCase()}_${(v.vehicleSubtype || '').toLowerCase()}`)
          );
          const beforeSubtype = activeBookings.length;
          activeBookings = activeBookings.filter((b: BookingRecord) => {
            const key = `${(b.vehicleType || '').toLowerCase()}_${(b.vehicleSubtype || '').toLowerCase()}`;
            return vehicleKeys.has(key);
          });
          if (beforeSubtype !== activeBookings.length) {
            logger.info(`[RE-BROADCAST] Subtype-filtered: ${beforeSubtype} → ${activeBookings.length} bookings matching fleet`);
          }
        }
      } catch { /* DB query failed -- proceed without subtype filter (safe: accept validates) */ }

      // FIX #153: Skip bookings where this transporter already has an active hold.
      // If a TruckHoldLedger entry exists (FLEX/CONFIRMED) for this transporter,
      // exclude those bookings from rebroadcast to avoid conflicting signals.
      try {
        const activeHolds = await prismaClient.truckHoldLedger.findMany({
          where: {
            orderId: { in: activeBookings.map((b: BookingRecord) => b.id) },
            phase: { in: ['FLEX', 'CONFIRMED'] },
            releasedAt: null,
          },
          select: { orderId: true, transporterId: true },
        });
        if (activeHolds.length > 0) {
          const holdsByOrder = new Map<string, Set<string>>();
          for (const h of activeHolds) {
            if (!holdsByOrder.has(h.orderId)) holdsByOrder.set(h.orderId, new Set());
            holdsByOrder.get(h.orderId)!.add(h.transporterId);
          }
          const beforeHoldFilter = activeBookings.length;
          activeBookings = activeBookings.filter((b: BookingRecord) => {
            const holders = holdsByOrder.get(b.id);
            // Skip this booking for this transporter if they already hold it
            return !holders || !holders.has(transporterId);
          });
          if (beforeHoldFilter !== activeBookings.length) {
            logger.info(`[RE-BROADCAST] Hold-filtered: ${beforeHoldFilter} → ${activeBookings.length} bookings (excluded active holds)`);
          }
        }
      } catch { /* DB query failed -- proceed without hold filter (safe: accept validates) */ }

      // FIX #31: Skip bookings where this transporter already has an active assignment.
      // The status filter above prevents fully-accepted bookings, but partially_filled
      // bookings could have this transporter already assigned. Re-broadcasting is safe
      // (accept handler is idempotent) but skipping reduces noise.
      try {
        const existingAssignments = await prismaClient.assignment.findMany({
          where: {
            transporterId,
            bookingId: { in: activeBookings.map((b: BookingRecord) => b.id) },
            status: { in: ['pending', 'driver_accepted', 'in_transit'] }
          },
          select: { bookingId: true }
        });
        if (existingAssignments.length > 0) {
          const assignedBookingIds = new Set(existingAssignments.map(a => a.bookingId));
          activeBookings = activeBookings.filter((b: BookingRecord) => !assignedBookingIds.has(b.id));
        }
      } catch { /* DB query failed -- proceed with all bookings (safe: accept is idempotent) */ }

      if (activeBookings.length === 0) {
        logger.info(`[RE-BROADCAST] Transporter ${transporterId} came online — 0 active bookings to deliver`);
        return;
      }

      logger.info(`╔══════════════════════════════════════════════════════════════╗`);
      logger.info(`║  RE-BROADCAST: Delivering ${activeBookings.length} missed bookings              ║`);
      logger.info(`║  Transporter: ${transporterId}                                ║`);
      logger.info(`╚══════════════════════════════════════════════════════════════╝`);

      // FIX #57: Route rebroadcasts through queue when enabled (same pattern as radius expansion).
      // Before: always direct emitToUser — no retry, no backpressure, no delivery guarantees.
      // Now: queue routing with direct-emit fallback, matching booking-radius.service.ts.
      // FIX #12: Use opt-IN pattern (=== 'true'), matching booking-broadcast.service.ts and booking-radius.service.ts
      const useQueueRebroadcast = process.env.FF_SEQUENCE_DELIVERY_ENABLED === 'true'
        && queueService && typeof queueService.queueBroadcast === 'function';

      for (const booking of activeBookings) {
        // Build the SAME broadcast payload format as createBooking()
        const broadcastPayload = buildBroadcastPayload(booking, {
          timeoutSeconds: getRemainingTimeoutSeconds(booking, BOOKING_CONFIG.TIMEOUT_MS),
          isRebroadcast: true
        });

        if (useQueueRebroadcast) {
          queueService.queueBroadcast(transporterId, SocketEvent.NEW_BROADCAST, broadcastPayload)
            .catch((queueErr: unknown) => {
              logger.warn('[RE-BROADCAST] Queue failed, falling back to direct emit', {
                bookingId: booking.id, error: (queueErr as Error)?.message
              });
              emitToUser(transporterId, SocketEvent.NEW_BROADCAST, broadcastPayload);
            });
        } else {
          emitToUser(transporterId, SocketEvent.NEW_BROADCAST, broadcastPayload);
        }
        logger.info(`  Delivered booking ${booking.id} (${booking.vehicleType}, ${booking.trucksNeeded - booking.trucksFilled} trucks remaining)`);

        // H-7 FIX: Broadcast delivery tracking for re-broadcast (fire-and-forget)
        try {
          if (typeof redisService.hSet === 'function') {
            redisService.hSet(
              `broadcast:delivery:${booking.id}`,
              transporterId,
              JSON.stringify({ emittedAt: Date.now(), channel: useQueueRebroadcast ? 'queue' : 'socket', rebroadcast: true })
            ).then(() => redisService.expire(`broadcast:delivery:${booking.id}`, 3600))
             .catch((_err: unknown) => { /* silent -- observability only */ });
          }
        } catch (_h7Err: unknown) { /* H-7 is observability only -- never crash broadcast */ }
      }

      // H-11 FIX: Parallel DB writes via Promise.allSettled — replaces sequential for loop
      // so they receive cancellation/expiry notifications later
      await Promise.allSettled(
        activeBookings
          .filter((b: BookingRecord) => !b.notifiedTransporters.includes(transporterId))
          .map((booking: BookingRecord) => {
            // Cap at 200 to bound cancel/expire iteration (industry standard)
            const updatedNotified = [...booking.notifiedTransporters, transporterId].slice(0, 200);
            return db.updateBooking(booking.id, { notifiedTransporters: updatedNotified }).catch((err: unknown) => {
              logger.warn(`[RE-BROADCAST] Failed to update notifiedTransporters for booking ${booking.id}`, { error: (err as Error).message });
            });
          })
      );

      // FIX #32: Individual FCM per booking with unique tag (Android notification grouping).
      // Prevents Android from collapsing 4+ notifications into a summary that loses
      // individual booking data. Industry pattern: Uber RAMEN -- individual push per event.
      for (const booking of activeBookings) {
        fcmService.notifyNewBroadcast([transporterId], {
          broadcastId: booking.id,
          customerName: booking.customerName,
          vehicleType: booking.vehicleType,
          trucksNeeded: booking.trucksNeeded - booking.trucksFilled,
          farePerTruck: booking.pricePerTruck,
          pickupCity: booking.pickup.city,
          dropCity: booking.drop.city,
          notificationTag: `broadcast_${booking.id}`,
          isRebroadcast: true
        }).catch(err => {
          logger.warn(`[RE-BROADCAST] FCM push failed for booking ${booking.id}`, err);
        });
      }

      logger.info(`[RE-BROADCAST] Delivered ${activeBookings.length} bookings to transporter ${transporterId}`);
    } catch (error: unknown) {
      // Non-critical — transporter can still manually refresh
      logger.error(`[RE-BROADCAST] Failed to deliver missed broadcasts to ${transporterId}`, {
        error: (error as Error).message
      });
    }
  }
}

export const bookingRebroadcastService = new BookingRebroadcastService();
