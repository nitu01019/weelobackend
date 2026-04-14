/**
 * =============================================================================
 * BOOKING MODULE - RADIUS EXPANSION SERVICE
 * =============================================================================
 *
 * Handles:
 * - startProgressiveExpansion
 * - advanceRadiusStep
 * - radiusDbFallback
 * - clearRadiusKeys
 * =============================================================================
 */

import { db, BookingRecord } from '../../shared/database/db';
import { prismaClient } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, SocketEvent } from '../../shared/services/socket.service';
import { fcmService } from '../../shared/services/fcm.service';
import { queueService } from '../../shared/services/queue.service';
import { availabilityService } from '../../shared/services/availability.service';
import { progressiveRadiusMatcher } from '../order/progressive-radius-matcher';
import { transporterOnlineService } from '../../shared/services/transporter-online.service';
import { redisService } from '../../shared/services/redis.service';
import { distanceMatrixService } from '../../shared/services/distance-matrix.service';
import { buildBroadcastPayload, getRemainingTimeoutSeconds } from './booking-payload.helper';
import {
  BOOKING_CONFIG,
  RADIUS_EXPANSION_CONFIG,
  TIMER_KEYS,
  RADIUS_KEYS,
  RadiusStepTimerData,
} from './booking.types';

export class BookingRadiusService {

  // DR-23 FIX: Track fallback setTimeout handles so they can be cancelled
  // when clearRadiusKeys is called (e.g., on booking cancel/expire).
  private fallbackTimers = new Map<string, NodeJS.Timeout>();

  // ==========================================================================
  // PROGRESSIVE RADIUS EXPANSION (Requirement 6)
  // ==========================================================================

  /**
   * Start progressive radius expansion for a booking.
   * Schedules a Redis timer for step 2 (step 1 is done in createBooking).
   *
   * If step 1 already found transporters, the timer will still fire
   * and expand the search — more transporters = higher acceptance chance.
   */
  async startProgressiveExpansion(
    bookingId: string,
    customerId: string,
    vehicleKey: string,
    vehicleType: string,
    vehicleSubtype: string,
    pickupLat: number,
    pickupLng: number
  ): Promise<void> {
    // If there's only 1 step configured, no expansion needed
    if (RADIUS_EXPANSION_CONFIG.steps.length <= 1) return;

    const step1 = RADIUS_EXPANSION_CONFIG.steps[0];

    // Store current step (0 = step 1 done)
    await redisService.set(
      RADIUS_KEYS.CURRENT_STEP(bookingId),
      '0',
      Math.ceil(BOOKING_CONFIG.TIMEOUT_MS / 1000) + 120
    ).catch(() => { });

    // Schedule step 2 timer
    const timerData: RadiusStepTimerData = {
      bookingId,
      customerId,
      vehicleKey,
      vehicleType,
      vehicleSubtype,
      pickupLat,
      pickupLng,
      currentStep: 0  // Will advance to step 1 (index) when timer fires
    };

    const expiresAt = new Date(Date.now() + step1.timeoutMs);
    // FIX #15: Redis failure fallback — if Redis timer scheduling fails, use in-memory
    // setTimeout as a fallback. This survives Redis outages but not server restarts.
    try {
      await redisService.setTimer(TIMER_KEYS.RADIUS_STEP(bookingId), timerData, expiresAt);
    } catch (redisErr: unknown) {
      logger.warn('[RADIUS] Redis failed for radius scheduling, using in-memory fallback', {
        bookingId, error: (redisErr as Error)?.message
      });
      // H-13 FIX: Acquire distributed lock inside setTimeout callback to prevent
      // duplicate execution when multiple instances have the same in-memory fallback.
      // DR-23 FIX: Store timer handle for cancellation; DR-24 FIX: unique lockId
      const fallbackTimer = setTimeout(async () => {
        this.fallbackTimers.delete(bookingId);
        const lockId = `fallback-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
        const lock = await redisService.acquireLock(`radius:${bookingId}`, lockId, 30).catch(() => ({ acquired: false }));
        if (!lock.acquired) return; // another instance handling it
        try {
          await this.advanceRadiusStep(timerData);
        } catch (err: unknown) {
          logger.error('[RADIUS] In-memory fallback radius step failed', {
            bookingId, error: (err as Error)?.message
          });
        } finally {
          await redisService.releaseLock(`radius:${bookingId}`, lockId).catch(() => {});
        }
      }, step1.timeoutMs);
      this.fallbackTimers.set(bookingId, fallbackTimer);
    }

    logger.info(`[RADIUS] Progressive expansion scheduled for booking ${bookingId} (step 2 in ${step1.timeoutMs / 1000}s)`);
  }

  /**
   * Advance to the next radius expansion step.
   * Called by the expiry checker when a radius step timer fires.
   *
   * FLOW:
   * 1. Check booking is still active (not cancelled/expired/fully_filled)
   * 2. Search at the new (larger) radius
   * 3. Filter out already-notified transporters (Redis SET dedup)
   * 4. Broadcast to NEW transporters only
   * 5. Schedule next step if not at max
   *
   * FIX #30: INTENTIONAL DESIGN — The DB read at step 1 occurs under the
   * per-booking distributed lock acquired in processRadiusExpansionTimers()
   * (Fix 2.4, lock key: `lock:booking:{bookingId}`). The stale-read window
   * between lock acquisition and DB read is acceptable because:
   * (a) the accept handler is idempotent — duplicate broadcasts don't cause
   *     double-assignment, and
   * (b) the worst case is one extra radius step for a booking that was just
   *     cancelled/expired, which is immediately caught by the next status check.
   *
   * STOPS if:
   * - Booking is cancelled/expired/fully_filled
   * - All steps exhausted → fall back to DB query
   */
  async advanceRadiusStep(data: RadiusStepTimerData): Promise<void> {
    const nextStepIndex = data.currentStep + 1;
    // FIX #36: Clamp totalSteps to matcher's actual step count.
    // H-X2: Both configs are now unified (derived from PROGRESSIVE_RADIUS_STEPS).
    // Clamp is kept as a safety net in case they diverge in the future.
    const matcherStepCount = progressiveRadiusMatcher.getStepCount();
    const totalSteps = Math.min(RADIUS_EXPANSION_CONFIG.steps.length, matcherStepCount);
    if (RADIUS_EXPANSION_CONFIG.steps.length !== matcherStepCount) {
      logger.warn('[RADIUS] Step count mismatch between booking config and matcher', {
        bookingServiceSteps: RADIUS_EXPANSION_CONFIG.steps.length,
        matcherSteps: matcherStepCount,
        effectiveSteps: totalSteps
      });
    }

    // Check booking is still active
    const booking = await db.getBookingById(data.bookingId);
    if (!booking || ['fully_filled', 'completed', 'cancelled', 'expired'].includes(booking.status)) {
      logger.info(`[RADIUS] Booking ${data.bookingId} is ${booking?.status || 'not found'} — stopping expansion`);
      await this.clearRadiusKeys(data.bookingId);
      return;
    }

    // If all steps exhausted, do final DB fallback
    if (nextStepIndex >= totalSteps) {
      logger.info(`[RADIUS] All ${totalSteps} steps exhausted for booking ${data.bookingId} — DB fallback`);
      await this.radiusDbFallback(booking, data);
      await this.clearRadiusKeys(data.bookingId);
      return;
    }

    const step = RADIUS_EXPANSION_CONFIG.steps[nextStepIndex];
    logger.info(`[RADIUS STEP ${nextStepIndex + 1}/${totalSteps}] Expanding to ${step.radiusKm}km for booking ${data.bookingId}`);

    // Dedup: load already-notified transporters
    let alreadyNotified: string[] = [];
    try {
      alreadyNotified = await redisService.sMembers(RADIUS_KEYS.NOTIFIED_SET(data.bookingId));
    } catch (_) { }
    const alreadyNotifiedSet = new Set(alreadyNotified);

    // Search at expanded radius: H3 primary → GEORADIUS fallback → Google ETA → Haversine
    const expandedCandidates = await progressiveRadiusMatcher.findCandidates({
      pickupLat: data.pickupLat,
      pickupLng: data.pickupLng,
      vehicleType: data.vehicleType || data.vehicleKey.split('_')[0] || '',
      vehicleSubtype: data.vehicleSubtype || data.vehicleKey.split('_').slice(1).join('_') || '',
      stepIndex: nextStepIndex,
      alreadyNotified: alreadyNotifiedSet,
      limit: RADIUS_EXPANSION_CONFIG.maxTransportersPerStep
    });
    const rawNewTransporters = expandedCandidates.map(c => c.transporterId);

    // FIX #81: Filter for online transporters before broadcasting — radius expansion
    // was previously skipping the online check that the DB fallback path already does.
    const newTransporters = rawNewTransporters.length > 0
      ? await transporterOnlineService.filterOnline(rawNewTransporters)
      : [];

    logger.info(`[RADIUS STEP ${nextStepIndex + 1}] Found ${expandedCandidates.length} candidates, ${rawNewTransporters.length} new, ${newTransporters.length} online`);

    // FIX #55: Mid-broadcast cancellation check — verify booking is still active
    // before fanning out to new transporters. Prevents wasted broadcasts after cancel.
    if (newTransporters.length > 0) {
      const freshBooking = await db.getBookingById(data.bookingId);
      if (!freshBooking || ['cancelled', 'completed', 'expired', 'fully_filled'].includes(freshBooking.status)) {
        logger.info('[RADIUS] Booking no longer active during radius expansion, stopping', {
          bookingId: data.bookingId, status: freshBooking?.status
        });
        await this.clearRadiusKeys(data.bookingId);
        return;
      }
    }

    // Broadcast to new transporters only (with per-transporter pickup distance)
    if (newTransporters.length > 0) {
      const expandedCandidateMap = new Map<string, { distanceKm: number; etaSeconds: number }>();
      for (const c of expandedCandidates) {
        expandedCandidateMap.set(c.transporterId, { distanceKm: c.distanceKm || 0, etaSeconds: c.etaSeconds || 0 });
      }

      for (const transporterId of newTransporters) {
        const candidate = expandedCandidateMap.get(transporterId);
        const broadcastPayload = buildBroadcastPayload(booking, {
          timeoutSeconds: getRemainingTimeoutSeconds(booking, BOOKING_CONFIG.TIMEOUT_MS),
          radiusStep: nextStepIndex + 1,
          pickupDistanceKm: candidate ? Math.round(candidate.distanceKm * 10) / 10 : 0,
          pickupEtaMinutes: candidate ? Math.ceil(candidate.etaSeconds / 60) : 0,
          pickupEtaSeconds: candidate ? Math.max(0, candidate.etaSeconds) : 0
        });

        // H-10 FIX: Route through queue for guaranteed delivery, fallback to direct emit
        const useQueueRadius = process.env.FF_SEQUENCE_DELIVERY_ENABLED === 'true'
          && queueService && typeof queueService.queueBroadcast === 'function';
        if (useQueueRadius) {
          queueService.queueBroadcast(transporterId, SocketEvent.NEW_BROADCAST, broadcastPayload)
            .catch((queueErr: unknown) => {
              logger.warn('[Broadcast][Radius] Queue failed, falling back to direct emit', { error: (queueErr as Error)?.message });
              emitToUser(transporterId, SocketEvent.NEW_BROADCAST, broadcastPayload);
            });
        } else {
          emitToUser(transporterId, SocketEvent.NEW_BROADCAST, broadcastPayload);
        }

        // H-7 FIX: Broadcast delivery tracking for observability (fire-and-forget)
        try {
          if (typeof redisService.hSet === 'function') {
            redisService.hSet(
              `broadcast:delivery:${booking.id}`,
              transporterId,
              JSON.stringify({ emittedAt: Date.now(), channel: useQueueRadius ? 'queue' : 'socket', radiusStep: nextStepIndex + 1 })
            ).then(() => redisService.expire(`broadcast:delivery:${booking.id}`, 3600))
             .catch((_err: unknown) => { /* silent -- observability only */ });
          }
        } catch (_h7Err: unknown) { /* H-7 is observability only -- never crash broadcast */ }
      }

      // Track newly notified transporters (Fix C2/F-5-4: atomic SADD+EXPIRE prevents orphan keys)
      const radiusTtl = Math.ceil(BOOKING_CONFIG.TIMEOUT_MS / 1000) + 120;
      await redisService.sAddWithExpire(
        RADIUS_KEYS.NOTIFIED_SET(data.bookingId), radiusTtl, ...newTransporters
      ).catch(() => { });

      // M-09 FIX: Atomic append of notifiedTransporters — prevents concurrent radius steps
      // from clobbering each other's writes via read-modify-write race.
      // Uses raw SQL with jsonb_array_elements_text + DISTINCT to merge atomically.
      try {
        const newTransportersJson = JSON.stringify(newTransporters);
        await prismaClient.$executeRaw`
          UPDATE "Booking"
          SET "notifiedTransporters" = (
            SELECT jsonb_agg(DISTINCT t)
            FROM jsonb_array_elements_text(
              COALESCE("notifiedTransporters", '[]'::jsonb) || ${newTransportersJson}::jsonb
            ) AS t
            LIMIT 200
          )
          WHERE id = ${data.bookingId}
        `;
      } catch (err: unknown) {
        // Fallback to non-atomic write if raw SQL fails (e.g. schema mismatch)
        logger.warn('[RADIUS] Atomic notifiedTransporters update failed, falling back', { bookingId: data.bookingId, error: (err as Error).message });
        const allNotified = [...(booking.notifiedTransporters || []), ...newTransporters];
        const uniqueNotified = [...new Set(allNotified)].slice(0, 200);
        await db.updateBooking(data.bookingId, { notifiedTransporters: uniqueNotified }).catch((fallbackErr: unknown) => {
          logger.error('[RADIUS] Failed to update notifiedTransporters (fallback)', { bookingId: data.bookingId, error: (fallbackErr as Error).message });
        });
      }

      // FIX #33: Filter out already-notified transporters before radius expansion FCM.
      // Without this, transporters who received the broadcast at a previous radius step
      // get a duplicate FCM push, causing badge inflation and user confusion.
      const previouslyNotified = new Set(alreadyNotified);
      const fcmTargets = newTransporters.filter(t => !previouslyNotified.has(t));

      // FIX #18: Reliable FCM for radius expansion — these notifications are critical
      // because transporters just entered the expanded radius and have no socket broadcast yet.
      if (fcmTargets.length > 0) {
        fcmService.notifyNewBroadcast(fcmTargets, {
          broadcastId: booking.id,
          customerName: booking.customerName,
          vehicleType: booking.vehicleType,
          trucksNeeded: booking.trucksNeeded - booking.trucksFilled,
          farePerTruck: booking.pricePerTruck,
          pickupCity: booking.pickup.city ?? '',
          dropCity: booking.drop.city ?? ''
        }).catch(err => {
          logger.error('[RADIUS] FCM push failed for radius expansion step', {
            bookingId: booking.id,
            targetCount: fcmTargets.length,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      logger.info(`[RADIUS STEP ${nextStepIndex + 1}] ✅ Broadcast to ${newTransporters.length} NEW transporters at ${step.radiusKm}km`);
    }

    // Schedule next step — FIX #15: Redis failure fallback for all subsequent steps
    if (nextStepIndex + 1 < totalSteps) {
      const nextTimerData: RadiusStepTimerData = {
        ...data,
        currentStep: nextStepIndex
      };
      const nextExpiresAt = new Date(Date.now() + step.timeoutMs);
      try {
        await redisService.setTimer(TIMER_KEYS.RADIUS_STEP(data.bookingId), nextTimerData, nextExpiresAt);
      } catch (redisErr: unknown) {
        logger.warn('[RADIUS] Redis failed for next step scheduling, using in-memory fallback', {
          bookingId: data.bookingId, step: nextStepIndex + 1, error: (redisErr as Error)?.message
        });
        // H-13 FIX: Acquire distributed lock inside setTimeout callback
        // DR-23 FIX: Store timer handle for cancellation; DR-24 FIX: unique lockId
        const nextFallbackTimer = setTimeout(async () => {
          this.fallbackTimers.delete(data.bookingId);
          const lockId = `fallback-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
          const lock = await redisService.acquireLock(`radius:${data.bookingId}`, lockId, 30).catch(() => ({ acquired: false }));
          if (!lock.acquired) return;
          try {
            await this.advanceRadiusStep(nextTimerData);
          } catch (err: unknown) {
            logger.error('[RADIUS] In-memory fallback next step failed', {
              bookingId: data.bookingId, error: (err as Error)?.message
            });
          } finally {
            await redisService.releaseLock(`radius:${data.bookingId}`, lockId).catch(() => {});
          }
        }, step.timeoutMs);
        this.fallbackTimers.set(data.bookingId, nextFallbackTimer);
      }
      await redisService.set(RADIUS_KEYS.CURRENT_STEP(data.bookingId), nextStepIndex.toString(),
        Math.ceil(BOOKING_CONFIG.TIMEOUT_MS / 1000) + 120).catch(() => { });

      logger.info(`[RADIUS] Next expansion (step ${nextStepIndex + 2}) scheduled in ${step.timeoutMs / 1000}s`);
    } else {
      // Last step done — schedule final DB fallback after this step's timeout
      const finalTimerData: RadiusStepTimerData = {
        ...data,
        currentStep: nextStepIndex  // Will trigger DB fallback (>= totalSteps)
      };
      const finalExpiresAt = new Date(Date.now() + step.timeoutMs);
      try {
        await redisService.setTimer(TIMER_KEYS.RADIUS_STEP(data.bookingId), finalTimerData, finalExpiresAt);
      } catch (redisErr: unknown) {
        logger.warn('[RADIUS] Redis failed for final step scheduling, using in-memory fallback', {
          bookingId: data.bookingId, error: (redisErr as Error)?.message
        });
        // H-13 FIX: Acquire distributed lock inside setTimeout callback
        // DR-23 FIX: Store timer handle for cancellation; DR-24 FIX: unique lockId
        const finalFallbackTimer = setTimeout(async () => {
          this.fallbackTimers.delete(data.bookingId);
          const lockId = `fallback-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
          const lock = await redisService.acquireLock(`radius:${data.bookingId}`, lockId, 30).catch(() => ({ acquired: false }));
          if (!lock.acquired) return;
          try {
            await this.advanceRadiusStep(finalTimerData);
          } catch (err: unknown) {
            logger.error('[RADIUS] In-memory fallback final step failed', {
              bookingId: data.bookingId, error: (err as Error)?.message
            });
          } finally {
            await redisService.releaseLock(`radius:${data.bookingId}`, lockId).catch(() => {});
          }
        }, step.timeoutMs);
        this.fallbackTimers.set(data.bookingId, finalFallbackTimer);
      }
    }
  }

  /**
   * DB fallback after all progressive radius steps are exhausted.
   * Queries ALL transporters with matching vehicle type from DB.
   */
  private async radiusDbFallback(booking: BookingRecord, data: RadiusStepTimerData): Promise<void> {
    // FIX #34: Pass vehicleSubtype to DB fallback query so we don't broadcast
    // to transporters who only have a different subtype (e.g. 10-wheel vs 6-wheel).
    const allDbTransporters = await db.getTransportersWithVehicleType(
      booking.vehicleType,
      booking.vehicleSubtype || undefined
    );
    // Cap at 100 to prevent unbounded fan-out — covers all realistic online counts
    const onlineTransporters = (await transporterOnlineService.filterOnline(allDbTransporters)).slice(0, 100);

    // Dedup: remove already-notified
    let alreadyNotified: string[] = [];
    try {
      alreadyNotified = await redisService.sMembers(RADIUS_KEYS.NOTIFIED_SET(data.bookingId));
    } catch (_) { }
    const alreadyNotifiedSet = new Set(alreadyNotified);
    const newTransporters = onlineTransporters.filter(t => !alreadyNotifiedSet.has(t));

    if (newTransporters.length === 0) {
      logger.info(`[RADIUS] DB fallback found 0 additional transporters for booking ${data.bookingId}`);
      return;
    }

    logger.info(`[RADIUS] DB fallback found ${newTransporters.length} additional transporters for booking ${data.bookingId}`);

    // =====================================================================
    // FIX: Compute per-transporter pickup distance (Distance Matrix → cache → haversine)
    // Previously this sent pickupDistanceKm=0 for ALL transporters → showed --
    // =====================================================================
    const candidateMap = new Map<string, { distanceKm: number; etaSeconds: number }>();
    try {
      const detailsMap = await availabilityService.loadTransporterDetailsMap(newTransporters);
      const origins: Array<{ lat: number; lng: number; id: string }> = [];

      for (const tid of newTransporters) {
        const details = detailsMap.get(tid);
        if (details) {
          const lat = parseFloat(details.latitude);
          const lng = parseFloat(details.longitude);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            origins.push({ lat, lng, id: tid });
          }
        }
      }

      if (origins.length > 0) {
        const etaResults = await distanceMatrixService.batchGetPickupDistance(
          origins, data.pickupLat, data.pickupLng
        );
        for (const origin of origins) {
          const eta = etaResults.get(origin.id);
          if (eta) {
            candidateMap.set(origin.id, {
              distanceKm: eta.distanceMeters / 1000,
              etaSeconds: eta.durationSeconds
            });
          }
        }
      }
    } catch (err: unknown) {
      logger.warn(`[RADIUS] DB fallback distance calc failed: ${(err as Error).message} — broadcasting with haversine estimates`);
    }

    // Fix D2/F-3-5 + FIX #56: Unified broadcast radius cap (env-configurable)
    const MAX_FALLBACK_RADIUS_KM = parseInt(process.env.MAX_BROADCAST_RADIUS_KM || '100', 10);
    const distanceFilteredTransporters = newTransporters.filter(tid => {
      const candidate = candidateMap.get(tid);
      if (candidate) {
        return candidate.distanceKm <= MAX_FALLBACK_RADIUS_KM;
      }
      // No distance data — include but log (haversine fallback didn't produce data)
      return true;
    });

    if (distanceFilteredTransporters.length === 0) {
      logger.info(`[RADIUS] DB fallback: all ${newTransporters.length} transporters beyond ${MAX_FALLBACK_RADIUS_KM}km cap`);
      return;
    }

    if (distanceFilteredTransporters.length < newTransporters.length) {
      logger.info(`[RADIUS] DB fallback distance cap: ${newTransporters.length} -> ${distanceFilteredTransporters.length} (filtered ${newTransporters.length - distanceFilteredTransporters.length} beyond ${MAX_FALLBACK_RADIUS_KM}km)`);
    }

    // Broadcast with per-transporter pickup distance
    const useQueueFallback = process.env.FF_SEQUENCE_DELIVERY_ENABLED === 'true'
      && queueService && typeof queueService.queueBroadcast === 'function';
    for (const transporterId of distanceFilteredTransporters) {
      const candidate = candidateMap.get(transporterId);
      const broadcastPayload = buildBroadcastPayload(booking, {
        timeoutSeconds: getRemainingTimeoutSeconds(booking, BOOKING_CONFIG.TIMEOUT_MS),
        pickupDistanceKm: candidate ? Math.round(candidate.distanceKm * 10) / 10 : 0,
        pickupEtaMinutes: candidate ? Math.ceil(candidate.etaSeconds / 60) : 0,
        pickupEtaSeconds: candidate ? Math.max(0, candidate.etaSeconds) : 0,
        radiusStep: RADIUS_EXPANSION_CONFIG.steps.length + 1  // DB fallback marker
      });

      // H-10 FIX: Route through queue for guaranteed delivery, fallback to direct emit
      if (useQueueFallback) {
        queueService.queueBroadcast(transporterId, SocketEvent.NEW_BROADCAST, broadcastPayload)
          .catch((queueErr: unknown) => {
            logger.warn('[Broadcast][DBFallback] Queue failed, falling back to direct emit', { error: (queueErr as Error)?.message });
            emitToUser(transporterId, SocketEvent.NEW_BROADCAST, broadcastPayload);
          });
      } else {
        emitToUser(transporterId, SocketEvent.NEW_BROADCAST, broadcastPayload);
      }

      // H-7 FIX: Broadcast delivery tracking for observability (fire-and-forget)
      try {
        if (typeof redisService.hSet === 'function') {
          redisService.hSet(
            `broadcast:delivery:${booking.id}`,
            transporterId,
            JSON.stringify({ emittedAt: Date.now(), channel: useQueueFallback ? 'queue' : 'socket', radiusStep: 'db_fallback' })
          ).then(() => redisService.expire(`broadcast:delivery:${booking.id}`, 3600))
           .catch((_err: unknown) => { /* silent -- observability only */ });
        }
      } catch (_h7Err: unknown) { /* H-7 is observability only -- never crash broadcast */ }
    }

    // Update DB record with all notified transporters
    const allNotified = [...(booking.notifiedTransporters || []), ...distanceFilteredTransporters];
    // Cap at 200 to bound cancel/expire iteration (industry standard)
    const uniqueNotified = [...new Set(allNotified)].slice(0, 200);
    try {
      await db.updateBooking(data.bookingId, { notifiedTransporters: uniqueNotified });
    } catch (err: unknown) {
      logger.error('[RADIUS] Failed to update notifiedTransporters (DB fallback)', { bookingId: data.bookingId, error: (err as Error).message });
    }

    // FIX #18: Reliable FCM for DB fallback — last chance to reach transporters
    fcmService.notifyNewBroadcast(distanceFilteredTransporters, {
      broadcastId: booking.id,
      customerName: booking.customerName,
      vehicleType: booking.vehicleType,
      trucksNeeded: booking.trucksNeeded - booking.trucksFilled,
      farePerTruck: booking.pricePerTruck,
      pickupCity: booking.pickup.city ?? '',
      dropCity: booking.drop.city ?? ''
    }).catch(err => {
      logger.error('[RADIUS] FCM push failed for DB fallback broadcast', {
        bookingId: booking.id,
        targetCount: distanceFilteredTransporters.length,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    logger.info(`[RADIUS] DB fallback delivered to ${distanceFilteredTransporters.length} transporters (${candidateMap.size} with road distance)`);
  }

  /**
   * Clean up radius expansion keys (separate from booking timers)
   */
  private async clearRadiusKeys(bookingId: string): Promise<void> {
    // DR-23 FIX: Cancel any in-memory fallback setTimeout for this booking
    const fallbackTimer = this.fallbackTimers.get(bookingId);
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      this.fallbackTimers.delete(bookingId);
    }

    await Promise.all([
      redisService.cancelTimer(TIMER_KEYS.RADIUS_STEP(bookingId)),
      redisService.del(RADIUS_KEYS.CURRENT_STEP(bookingId)).catch(() => { }),
      redisService.del(RADIUS_KEYS.NOTIFIED_SET(bookingId)).catch(() => { }),
    ]);
  }
}

export const bookingRadiusService = new BookingRadiusService();
