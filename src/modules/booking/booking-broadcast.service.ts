/**
 * =============================================================================
 * BOOKING MODULE - BROADCAST SERVICE
 * =============================================================================
 *
 * Handles:
 * - broadcastBookingToTransporters
 * - sendFcmPushNotifications
 * - setupBookingTimeout
 * - setBookingRedisKeys
 * - startBookingTimeout
 * =============================================================================
 */

import { prismaClient } from '../../shared/database/prisma.service';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, SocketEvent, isUserConnectedAsync } from '../../shared/services/socket.service';
import { fcmService } from '../../shared/services/fcm.service';
import { queueService } from '../../shared/services/queue.service';
import { redisService } from '../../shared/services/redis.service';
import { assertValidTransition, BOOKING_VALID_TRANSITIONS } from '../../core/state-machines';
import { adminSuspensionService } from '../admin/admin-suspension.service';
import { buildBroadcastPayload } from './booking-payload.helper';
import type { BookingContext } from './booking-context';
import {
  BOOKING_CONFIG,
  RADIUS_EXPANSION_CONFIG,
  TIMER_KEYS,
  RADIUS_KEYS,
  BookingTimerData,
} from './booking.types';

// Forward reference for startProgressiveExpansion (set by facade)
let _radiusService: {
  startProgressiveExpansion: (
    bookingId: string, customerId: string, vehicleKey: string,
    vehicleType: string, vehicleSubtype: string,
    pickupLat: number, pickupLng: number
  ) => Promise<void>;
} | null = null;

export function setBroadcastRadiusServiceRef(ref: typeof _radiusService): void {
  _radiusService = ref;
}

export class BookingBroadcastService {

  async broadcastBookingToTransporters(ctx: BookingContext): Promise<void> {
    const booking = ctx.booking!;

    // FIX #32: Validate state BEFORE sending any broadcasts.
    // If the booking is no longer in 'created' state (e.g., cancelled during matching),
    // skip the entire broadcast phase instead of sending broadcasts then failing the assertion.
    assertValidTransition('Booking', BOOKING_VALID_TRANSITIONS, booking.status, 'broadcasting');

    // ========================================
    // BROADCAST TO ALL MATCHING TRANSPORTERS
    // ========================================
    // IMPORTANT: Include broadcastId AND orderId for Captain app compatibility
    // Captain app's SocketIOService checks broadcastId first, then orderId
    //
    // Per-transporter pickup distance: Build a lookup map from candidates.
    // Each transporter gets their OWN pickupDistanceKm and pickupEtaMinutes.
    ctx.candidateMap = new Map();
    for (const c of ctx.step1Candidates) {
      ctx.candidateMap.set(c.transporterId, { distanceKm: c.distanceKm || 0, etaSeconds: c.etaSeconds || 0 });
    }

    // Fill gap: Transporters in matchingTransporters but not in candidateMap
    // (happens when Redis has no location for a DB-fallback transporter)
    // Use -1 as sentinel → broadcast helper renders "nearby" instead of "0 km"
    let locationGapCount = 0;
    for (const tid of ctx.matchingTransporters) {
      if (!ctx.candidateMap.has(tid)) {
        ctx.candidateMap.set(tid, { distanceKm: -1, etaSeconds: 0 });
        locationGapCount++;
      }
    }
    if (locationGapCount > 0) {
      logger.warn(`📊 [PICKUP_GAP] ${locationGapCount} transporter(s) have no location data — pickup distance unknown`);
    }


    // H-19 FIX: Cap notified transporters to prevent FCM throttling and latency spikes
    const MAX_BROADCAST_TRANSPORTERS = parseInt(process.env.MAX_BROADCAST_TRANSPORTERS || '100', 10);
    ctx.cappedTransporters = ctx.matchingTransporters.length > MAX_BROADCAST_TRANSPORTERS
      ? (() => {
          logger.info(`[Broadcast] Capping ${ctx.matchingTransporters.length} -> ${MAX_BROADCAST_TRANSPORTERS} transporters`);
          return ctx.matchingTransporters.slice(0, MAX_BROADCAST_TRANSPORTERS);
        })()
      : ctx.matchingTransporters;

    const step1 = RADIUS_EXPANSION_CONFIG.steps[0];
    logger.info(`📢 Broadcasting to ${ctx.cappedTransporters.length} transporters for ${ctx.data.vehicleType} ${ctx.data.vehicleSubtype || ''} (Radius Step 1: ${step1.radiusKm}km)`);

    // H-10 FIX: Route through queue for guaranteed delivery when available
    // FIX #12: Opt-IN, not opt-OUT. Undefined env must default to OFF (direct broadcast).
    // Previously `!== 'false'` meant undefined/missing env var activated the queue,
    // which is unsafe for a feature flag — new deploys with no env would silently
    // switch broadcast delivery to queue mode.
    const useQueue = process.env.FF_SEQUENCE_DELIVERY_ENABLED === 'true'
      && queueService && typeof queueService.queueBroadcast === 'function';

    // Phase 3 optimization: No per-transporter DB queries in broadcast loop.
    // filterOnline() already guarantees all transporters are online.
    //
    // FIX #13: Batch eligibility check — single query to verify transporters
    // have an available vehicle of the requested type, instead of per-transporter
    // DB queries. This replaces the old O(N) pattern with O(1) DB query.
    let eligibleTransporters = ctx.cappedTransporters;
    try {
      const requestedType = booking.vehicleType;
      const requestedSubtype = booking.vehicleSubtype;
      const whereClause: Record<string, unknown> = {
        transporterId: { in: ctx.cappedTransporters },
        isActive: true,
        vehicleType: requestedType,
      };
      if (requestedSubtype) {
        whereClause.vehicleSubtype = requestedSubtype;
      }
      const eligibleRows = await prismaClient.vehicle.findMany({
        where: whereClause,
        select: { transporterId: true },
        distinct: ['transporterId'],
        take: 500,  // FIX-27: Bound query to prevent unbounded result sets
      });
      const eligibleSet = new Set(eligibleRows.map((v: { transporterId: string }) => v.transporterId));
      eligibleTransporters = ctx.cappedTransporters.filter(tid => eligibleSet.has(tid));
      if (eligibleTransporters.length < ctx.cappedTransporters.length) {
        logger.info(`[Broadcast] Batch eligibility: ${ctx.cappedTransporters.length} -> ${eligibleTransporters.length} (filtered ${ctx.cappedTransporters.length - eligibleTransporters.length} without matching vehicles)`);
      }
    } catch (eligErr: unknown) {
      // Fail-open: if batch check fails, broadcast to all (previous behavior)
      const msg = eligErr instanceof Error ? eligErr.message : String(eligErr);
      logger.warn('[Broadcast] Batch eligibility check failed, broadcasting to all', { bookingId: booking.id, error: msg });
    }

    // KYC/Verification gate (defense-in-depth): skip unverified transporters.
    // Primary gate is at query level (getTransportersWithVehicleType), but this
    // catches any that slip through via cache, Redis geo index, or fallback paths.
    try {
      const verifiedRows = await prismaClient.user.findMany({
        where: {
          id: { in: eligibleTransporters },
          isVerified: true,
        },
        select: { id: true },
        take: 500,  // FIX-27: Bound query to prevent unbounded result sets
      });
      const verifiedSet = new Set(verifiedRows.map((u: { id: string }) => u.id));
      const beforeKyc = eligibleTransporters.length;
      eligibleTransporters = eligibleTransporters.filter(tid => {
        if (verifiedSet.has(tid)) return true;
        logger.info(`[Dispatch] Skipping unverified transporter ${tid}`);
        return false;
      });
      if (eligibleTransporters.length < beforeKyc) {
        logger.info(`[Broadcast] KYC gate: ${beforeKyc} -> ${eligibleTransporters.length} (filtered ${beforeKyc - eligibleTransporters.length} unverified transporters)`);
      }
    } catch (kycErr: unknown) {
      // Fail-open: if KYC check fails, proceed with current list (previous behavior)
      const msg = kycErr instanceof Error ? kycErr.message : String(kycErr);
      logger.warn('[Broadcast] KYC verification check failed, proceeding with current list', { bookingId: booking.id, error: msg });
    }

    // C7 FIX (booking path): Filter out suspended transporters before broadcasting.
    // H1 FIX: Batch suspension check — single Redis round-trip instead of N+1 calls.
    try {
      const suspendedSet = await adminSuspensionService.getSuspendedUserIds(eligibleTransporters);
      const beforeSuspension = eligibleTransporters.length;
      eligibleTransporters = eligibleTransporters.filter((tid) => !suspendedSet.has(tid));
      const suspendedCount = beforeSuspension - eligibleTransporters.length;
      if (suspendedCount > 0) {
        logger.info('[Broadcast] Filtered suspended transporters (booking path)', {
          bookingId: booking.id,
          suspendedCount,
          remainingCount: eligibleTransporters.length,
        });
      }
    } catch (suspensionErr: unknown) {
      // Fail-open: if suspension check fails, proceed with current list
      const msg = suspensionErr instanceof Error ? suspensionErr.message : String(suspensionErr);
      logger.warn('[Broadcast] Suspension check failed, proceeding with current list', { bookingId: booking.id, error: msg });
    }

    // M-23 FIX: Check booking status mid-broadcast to stop after cancel.
    // FIX #80: Adaptive interval so small batches (<50) still get a cancel check.
    // Old fixed interval of 50 meant < 50 transporters never triggered the check.
    // New formula: max(5, min(50, floor(count/3))) — scales with batch size.
    const transporterCount = eligibleTransporters.length;
    const BOOKING_STATUS_CHECK_INTERVAL = Math.max(
      5,
      Math.min(50, Math.floor(transporterCount / 3) || 5)
    );
    let bookingBroadcastIdx = 0;
    for (const transporterId of eligibleTransporters) {
      if (bookingBroadcastIdx > 0 && bookingBroadcastIdx % BOOKING_STATUS_CHECK_INTERVAL === 0) {
        try {
          const currentBooking = await prismaClient.booking.findUnique({
            where: { id: booking.id },
            select: { status: true },
          });
          if (currentBooking && ['cancelled', 'expired', 'completed', 'fully_filled'].includes(currentBooking.status)) {
            logger.info('[Broadcast] Booking became inactive mid-broadcast, stopping', {
              bookingId: booking.id, status: currentBooking.status, emittedSoFar: bookingBroadcastIdx
            });
            break;
          }
        } catch (checkErr: unknown) {
          // Fail-open: if check fails, continue broadcasting
          const msg = checkErr instanceof Error ? checkErr.message : String(checkErr);
          logger.warn('[Broadcast] Mid-broadcast booking status check failed', { bookingId: booking.id, error: msg });
        }
      }
      bookingBroadcastIdx++;
      const candidate = ctx.candidateMap.get(transporterId);
      // Math.max(0, ...) clamps -1 sentinel (unknown location) to 0
      const pickupDistKm = candidate ? Math.max(0, Math.round(candidate.distanceKm * 10) / 10) : 0;
      const pickupEtaMin = candidate ? Math.max(0, Math.ceil(candidate.etaSeconds / 60)) : 0;

      const broadcastPayload: Record<string, unknown> = {
        ...buildBroadcastPayload(booking, {
          timeoutSeconds: BOOKING_CONFIG.TIMEOUT_MS / 1000,
          trucksFilled: 0,
          pickupDistanceKm: pickupDistKm,
          pickupEtaMinutes: pickupEtaMin,
          pickupEtaSeconds: candidate ? Math.max(0, candidate.etaSeconds) : 0
        }),
        // M-10 FIX: Dedup nonce — clients can use this to discard duplicate broadcasts
        broadcastNonce: `${booking.id}:${Date.now()}:${bookingBroadcastIdx}`,
      };

      // H-10 FIX: Route through queue for guaranteed delivery, fallback to direct emit
      if (useQueue) {
        queueService.queueBroadcast(transporterId, SocketEvent.NEW_BROADCAST, broadcastPayload)
          .catch((queueErr: unknown) => {
            logger.warn('[Broadcast] Queue failed, falling back to direct emit', { error: (queueErr as Error)?.message });
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
            JSON.stringify({ emittedAt: Date.now(), channel: useQueue ? 'queue' : 'socket' })
          ).then(() => redisService.expire(`broadcast:delivery:${booking.id}`, 3600))
           .catch((_err: unknown) => { /* silent -- observability only */ });
        }
      } catch (_h7Err: unknown) { /* H-7 is observability only -- never crash broadcast */ }
    }

    // FIX #29: INTENTIONAL DESIGN — Fire-and-forget broadcast delivery.
    // Socket.IO emits above do NOT wait for delivery confirmation before
    // transitioning status. This matches industry standard (Uber RAMEN):
    // at-least-once delivery + client-side reconciliation on app foreground.
    // deliverMissedBroadcasts() catches any transporters that missed the emit.

    // Transition: created -> broadcasting (transporters have been notified)
    // FIX #32: State assertion already done at method entry (before broadcasts).
    // FIX-R2-1: Conditional status write — only transition from 'created'
    try {
      await prismaClient.booking.updateMany({
        where: { id: booking.id, status: 'created' },
        data: { status: 'broadcasting', stateChangedAt: new Date() }
      });
    } catch (err: unknown) {
      logger.error('[BOOKING] Failed to update status to broadcasting', { bookingId: booking.id, error: (err as Error).message });
    }
    emitToUser(ctx.customerId, SocketEvent.BROADCAST_STATE_CHANGED, {
      bookingId: booking.id,
      status: 'broadcasting',
      stateChangedAt: new Date().toISOString()
    });

    // ========================================
    // TRACK NOTIFIED TRANSPORTERS FOR PROGRESSIVE RADIUS (Requirement 6)
    // Store in Redis SET so later steps only broadcast to NEW transporters.
    //
    // FIX #18: This SET is lost on Redis restart. Duplicate broadcasts after
    // restart are safe because the accept handler is idempotent (checks
    // assignment status before creating). See advanceRadiusStep() for the
    // DB fallback that recovers notifiedTransporters from the booking row.
    // Industry pattern: Uber RAMEN — at-least-once delivery by design.
    // ========================================
    if (ctx.matchingTransporters.length > 0) {
      const notifiedSetKey = RADIUS_KEYS.NOTIFIED_SET(booking.id);
      const ttlSeconds = Math.ceil(BOOKING_CONFIG.TIMEOUT_MS / 1000) + 120;
      try {
        // FIX #21: Atomic SADD + EXPIRE via Lua script (LINE Engineering pattern).
        // Prevents orphaned sets without TTL if crash occurs between separate calls.
        await redisService.sAddWithExpire(notifiedSetKey, ttlSeconds, ...ctx.matchingTransporters);
      } catch (e: unknown) {
        // Retry once — incomplete notified set causes duplicate broadcasts on radius expansion
        logger.warn('[RADIUS] sAddWithExpire failed, retrying once', { bookingId: booking.id, error: (e as Error).message });
        await redisService.sAddWithExpire(notifiedSetKey, ttlSeconds, ...ctx.matchingTransporters).catch((retryErr: unknown) => {
          logger.error('[RADIUS] Failed to track notified transporters after retry — radius expansion may send duplicate broadcasts (safe: accept is idempotent)', {
            bookingId: booking.id, error: (retryErr as Error).message, transporterCount: ctx.matchingTransporters.length
          });
        });
      }
    }
  }

  async sendFcmPushNotifications(ctx: BookingContext): Promise<void> {
    const booking = ctx.booking!;
    // ========================================
    // SEND FCM PUSH NOTIFICATIONS (for app in background)
    // ========================================
    // Fix E6: Only send FCM to transporters NOT connected via socket
    // H-19: Use cappedTransporters (already capped above) for FCM too
    // FIX #24: Use async Redis-aware presence check (works across all ECS instances)
    const presenceResults = await Promise.all(
      ctx.cappedTransporters.map(async (tid) => ({ tid, connected: await isUserConnectedAsync(tid) }))
    );
    const offlineTransporters = presenceResults.filter(r => !r.connected).map(r => r.tid);
    if (offlineTransporters.length > 0) {
      // FIX #18: Await FCM on critical initial broadcast path — ensures delivery attempt
      // completes before the method returns. Errors are caught and logged, not thrown.
      try {
        const sentCount = await fcmService.notifyNewBroadcast(offlineTransporters, {
          broadcastId: booking.id,
          customerName: booking.customerName,
          vehicleType: booking.vehicleType,
          trucksNeeded: booking.trucksNeeded,
          farePerTruck: booking.pricePerTruck,
          pickupCity: booking.pickup.city ?? '',
          dropCity: booking.drop.city ?? '',
          // Fix E3: Pass additional fields for background decision-making
          pickupAddress: booking.pickup.address,
          dropAddress: booking.drop.address,
          distanceKm: booking.distanceKm,
          vehicleSubtype: booking.vehicleSubtype,
          expiresAt: booking.expiresAt
        });
        logger.info(`📱 FCM: Push notifications sent to ${sentCount}/${offlineTransporters.length} offline transporters (${ctx.cappedTransporters.length - offlineTransporters.length} connected via socket)`);

        // H-7 FIX: Track FCM delivery for observability (fire-and-forget)
        try {
          if (typeof redisService.hSet === 'function') {
            for (const tid of offlineTransporters) {
              redisService.hSet(
                `broadcast:delivery:${booking.id}`,
                `${tid}:fcm`,
                JSON.stringify({ emittedAt: Date.now(), channel: 'fcm' })
              ).catch((_fcmTrackErr: unknown) => { /* silent -- observability only */ });
            }
          }
        } catch (_h7Err: unknown) { /* H-7 is observability only -- never crash broadcast */ }
      } catch (err) {
        logger.error('📱 FCM: Failed to send initial broadcast push notifications', {
          bookingId: booking.id,
          offlineCount: offlineTransporters.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      logger.info(`📱 FCM: All ${ctx.cappedTransporters.length} transporters connected via socket -- skipping FCM`);
    }
  }

  async setupBookingTimeout(ctx: BookingContext): Promise<void> {
    const booking = ctx.booking!;

    // FIX #74: Guard against zero-notified bookings being set to 'active'.
    // If eligibleTransporters was 0 after the batch eligibility filter, the
    // booking should be expired (not active) so the customer can rebook.
    const notifiedCount = ctx.cappedTransporters?.length ?? ctx.matchingTransporters?.length ?? 0;
    if (notifiedCount === 0) {
      logger.warn('[BOOKING] Zero transporters notified — expiring instead of activating', {
        bookingId: booking.id,
        cappedCount: ctx.cappedTransporters?.length,
        matchingCount: ctx.matchingTransporters?.length,
      });
      try {
        await prismaClient.booking.updateMany({
          where: { id: booking.id, status: { in: ['created', 'broadcasting'] } },
          data: { status: 'expired', stateChangedAt: new Date() },
        });
      } catch (err: unknown) {
        logger.error('[BOOKING] Failed to expire zero-notified booking', { bookingId: booking.id, error: (err as Error).message });
      }
      emitToUser(ctx.customerId, SocketEvent.BOOKING_EXPIRED, {
        bookingId: booking.id,
        status: 'expired',
        reason: 'no_eligible_transporters',
        message: 'No eligible drivers available right now. Please try again.',
      });
      // Also emit order_expired for customer app compatibility (C1 fix)
      emitToUser(ctx.customerId, 'order_expired', {
        bookingId: booking.id,
        status: 'expired',
        reason: 'no_eligible_transporters',
        message: 'No eligible drivers available right now. Please try again.',
      });
      await redisService.del(`customer:active-broadcast:${ctx.customerId}`).catch(() => {});
      return;
    }

    // ========================================
    // START TIMEOUT TIMER
    // ========================================
    this.startBookingTimeout(booking.id, ctx.customerId);

    // Transition: broadcasting -> active (timer started, awaiting responses)
    // Fix B1: State machine ENFORCED -- invalid transitions throw
    assertValidTransition('Booking', BOOKING_VALID_TRANSITIONS, 'broadcasting', 'active');
    // FIX-R2-1: Conditional status write — only transition from 'broadcasting'
    try {
      await prismaClient.booking.updateMany({
        where: { id: booking.id, status: 'broadcasting' },
        data: { status: 'active', stateChangedAt: new Date() }
      });
    } catch (err: unknown) {
      logger.error('[BOOKING] Failed to update status to active', { bookingId: booking.id, error: (err as Error).message });
    }
    emitToUser(ctx.customerId, SocketEvent.BROADCAST_STATE_CHANGED, {
      bookingId: booking.id,
      status: 'active',
      stateChangedAt: new Date().toISOString()
    });

    // ========================================
    // START PROGRESSIVE RADIUS EXPANSION (Requirement 6)
    // Schedule step 2 to trigger after step 1 timeout
    // SKIP if DB fallback was used (all transporters already notified)
    // ========================================
    if (!ctx.skipProgressiveExpansion) {
      // CRITICAL #9: Null guard replaces non-null assertion on _radiusService
      if (!_radiusService) {
        logger.error('[BROADCAST] FATAL: _radiusService not initialized — cannot start progressive expansion', {
          bookingId: booking.id,
        });
        throw new AppError(500, 'SERVICE_NOT_READY', 'Broadcast service not fully initialized');
      }
      // DR-22 FIX: Add .catch() to fire-and-forget call to prevent unhandled rejection
      _radiusService.startProgressiveExpansion(booking.id, ctx.customerId, ctx.vehicleKey,
        ctx.data.vehicleType, ctx.data.vehicleSubtype || '',
        ctx.data.pickup!.coordinates!.latitude, ctx.data.pickup!.coordinates!.longitude)
        .catch(err => logger.error('[BROADCAST] Progressive expansion failed (non-fatal)', { bookingId: booking.id, error: err instanceof Error ? err.message : String(err) }));
    } else {
      logger.info(`[RADIUS] Skipping progressive expansion — DB fallback already covered all transporters`);
    }

    logger.info(`✅ Booking ${booking.id} created, ${ctx.matchingTransporters.length} transporters notified (step 1/${RADIUS_EXPANSION_CONFIG.steps.length})`);
  }

  async setBookingRedisKeys(ctx: BookingContext): Promise<void> {
    const booking = ctx.booking!;
    // SCALABILITY: Store idempotency key to prevent duplicate bookings
    // FIX #30/#31: Key now includes payload hash; value is full response JSON (not just ID)
    if (ctx.idempotencyKey) {
      const cacheKey = `idempotency:booking:${ctx.customerId}:${ctx.idempotencyKey}:${ctx.idempotencyHash}`;
      const fullResponse = JSON.stringify({
        ...booking,
        matchingTransportersCount: ctx.matchingTransporters.length,
        timeoutSeconds: Math.floor(BOOKING_CONFIG.TIMEOUT_MS / 1000),
      });
      // Store for 24 hours (TTL in seconds)
      await redisService.set(cacheKey, fullResponse, 24 * 60 * 60);
      // Also store a 'latest' pointer so cancelBooking can find the exact key to delete
      // without using KEYS pattern scan (which fails on ElastiCache Serverless)
      await redisService.set(`idempotency:booking:${ctx.customerId}:latest`, `${ctx.idempotencyKey}:${ctx.idempotencyHash}`, 24 * 60 * 60);
      logger.info('Idempotency key stored for booking (with payload hash)', {
        bookingId: booking.id,
        idempotencyKey: ctx.idempotencyKey,
        payloadHash: ctx.idempotencyHash,
      });
    }

    // Store server-generated idempotency key
    const bookingTimeoutSeconds = Math.ceil(BOOKING_CONFIG.TIMEOUT_MS / 1000);
    await redisService.set(ctx.dedupeKey, booking.id, bookingTimeoutSeconds + 30);
    await redisService.set(`idem:broadcast:latest:${ctx.customerId}`, ctx.dedupeKey, bookingTimeoutSeconds + 30);

    // NOTE: activeKey already set early (right after booking creation, before broadcasts)
  }

  /**
   * Start timeout timer for booking (Redis-based for cluster support)
   * Auto-expires booking if not fully filled within timeout
   *
   * SCALABILITY: Uses Redis timers instead of in-memory setTimeout
   * - Works across multiple server instances
   * - Survives server restarts
   * - No duplicate processing (Redis locks)
   */
  async startBookingTimeout(bookingId: string, customerId: string): Promise<void> {
    // Cancel any existing timer for this booking
    await redisService.cancelTimer(TIMER_KEYS.BOOKING_EXPIRY(bookingId));

    // Set new timer in Redis
    const expiresAt = new Date(Date.now() + BOOKING_CONFIG.TIMEOUT_MS);
    const timerData: BookingTimerData = {
      bookingId,
      customerId,
      createdAt: new Date().toISOString()
    };

    await redisService.setTimer(TIMER_KEYS.BOOKING_EXPIRY(bookingId), timerData, expiresAt);

    logger.info(`⏱️ Timeout timer started for booking ${bookingId} (${BOOKING_CONFIG.TIMEOUT_MS / 1000}s) [Redis-based]`);
  }
}

export const bookingBroadcastService = new BookingBroadcastService();
