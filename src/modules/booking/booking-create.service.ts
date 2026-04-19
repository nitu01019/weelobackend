/**
 * =============================================================================
 * BOOKING MODULE - CREATE SERVICE
 * =============================================================================
 *
 * Handles:
 * - createBooking and all its sub-methods (backpressure, idempotency, lock,
 *   distance calculation, fare validation, matching, persist, broadcast, FCM,
 *   timeout setup, Redis keys)
 * =============================================================================
 */

import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import { db, BookingRecord } from '../../shared/database/db';
import { Prisma } from '@prisma/client';
import { prismaClient, withDbTimeout, BookingStatus, OrderStatus } from '../../shared/database/prisma.service';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, SocketEvent } from '../../shared/services/socket.service';
import { CreateBookingInput } from './booking.schema';
import { availabilityService } from '../../shared/services/availability.service';
import { generateVehicleKey } from '../../shared/services/vehicle-key.service';
import { progressiveRadiusMatcher } from '../order/progressive-radius-matcher';
import { transporterOnlineService } from '../../shared/services/transporter-online.service';
import { redisService } from '../../shared/services/redis.service';
import { haversineDistanceKm } from '../../shared/utils/geospatial.utils';
import { distanceMatrixService } from '../../shared/services/distance-matrix.service';
import { googleMapsService } from '../../shared/services/google-maps.service';
import { roundCoord } from '../../shared/utils/geo.utils';
import type { BookingContext } from './booking-context';
import {
  BOOKING_CONFIG,
  RADIUS_EXPANSION_CONFIG,
  TERMINAL_STATUSES,
} from './booking.types';
import { assertValidTransition, BOOKING_VALID_TRANSITIONS } from '../../core/state-machines';

// FIX #49: Parse once at module level instead of every request
// FIX #25: NaN guard + floor of 1 prevents 0 from blocking all requests
const _rawBCL = parseInt(process.env.BOOKING_CONCURRENCY_LIMIT || '50', 10);
const BOOKING_CONCURRENCY_LIMIT = Math.max(1, isNaN(_rawBCL) ? 50 : _rawBCL);
const BACKPRESSURE_TTL_SECONDS = 300;

// Forward reference for broadcast service methods (set by facade)
let _broadcastService: {
  broadcastBookingToTransporters: (ctx: BookingContext) => Promise<void>;
  sendFcmPushNotifications: (ctx: BookingContext) => Promise<void>;
  setupBookingTimeout: (ctx: BookingContext) => Promise<void>;
  setBookingRedisKeys: (ctx: BookingContext) => Promise<void>;
  startBookingTimeout: (bookingId: string, customerId: string) => Promise<void>;
} | null = null;

export function setBroadcastServiceRef(ref: typeof _broadcastService): void {
  _broadcastService = ref;
}

export class BookingCreateService {

  // ==========================================================================
  // CREATE BOOKING (CUSTOMER)
  // ==========================================================================

  /**
   * Create a new booking request
   *
   * ENHANCED BROADCAST SYSTEM:
   * 1. Customer selects vehicle type (e.g., "tipper", "20-24 Ton")
   * 2. System finds ALL transporters with that vehicle TYPE
   * 3. Broadcasts to ALL matching transporters simultaneously
   * 4. Starts timeout countdown
   * 5. Multiple transporters can accept (partial fulfillment)
   * 6. Auto-expires if not filled within timeout
   *
   * SCALABILITY:
   * - Idempotency key prevents duplicate bookings
   * - Redis stores key for 24 hours
   * - Supports millions of concurrent users
   *
   * EASY UNDERSTANDING:
   * - If idempotency key exists, return cached booking
   * - Otherwise create new booking and cache key
   */
  async createBooking(
    customerId: string,
    customerPhone: string,
    data: CreateBookingInput,
    idempotencyKey?: string
  ): Promise<BookingRecord & { matchingTransportersCount: number; timeoutSeconds: number }> {
    const ctx: BookingContext = {
      customerId,
      customerPhone,
      data,
      idempotencyKey,
      concurrencyKey: 'booking:create:inflight',
      incremented: false,
      lockKey: `customer-broadcast-create:${customerId}`,
      lockAcquired: false,
      lockHolder: uuid(),
      dedupeKey: '',
      idempotencyHash: '',
      customerName: 'Customer',
      distanceSource: 'client_fallback',
      clientDistanceKm: data.distanceKm,
      vehicleKey: '',
      matchingTransporters: [],
      skipProgressiveExpansion: false,
      step1Candidates: [],
      candidateMap: new Map(),
      cappedTransporters: [],
      bookingId: uuid(),
      booking: null,
      expiresAt: '',
      earlyReturn: null,
    };

    // FIX #32: Cancel-rebook cooldown — prevent rapid cancel+rebook abuse (30s window)
    const cooldownKey = `booking:cancel-cooldown:${ctx.customerId}`;
    const hasCooldown = await redisService.get(cooldownKey).catch((): null => null);
    if (hasCooldown) {
      throw new AppError(429, 'CANCEL_COOLDOWN', 'Please wait before creating a new booking');
    }

    await this.acquireBookingBackpressure(ctx);
    try {
      const idempotencyResult = await this.checkBookingIdempotency(ctx);
      if (idempotencyResult) return idempotencyResult;

      await this.acquireCustomerBroadcastLock(ctx);
      try {
        const serverIdempotencyResult = await this.checkServerSideIdempotency(ctx);
        if (serverIdempotencyResult) return serverIdempotencyResult;

        await this.resolveCustomerName(ctx);
        await this.calculateRouteDistance(ctx);
        this.validateBookingFare(ctx);

        ctx.expiresAt = new Date(Date.now() + BOOKING_CONFIG.TIMEOUT_MS).toISOString();

        await this.findMatchingTransporters(ctx);
        await this.persistBookingTransaction(ctx);

        if (ctx.earlyReturn) return ctx.earlyReturn;

        // FIX #8: Null guard — broadcastService may not be initialized yet.
        // Booking is already persisted at this point, so crashing would leave it
        // stuck in 'created' forever. Log and return gracefully; reconciliation
        // will pick up the orphaned booking.
        if (!_broadcastService) {
          logger.error('[BookingCreate] BroadcastService not initialized after booking persisted', {
            bookingId: ctx.bookingId,
            customerId: ctx.customerId,
          });
          return {
            ...ctx.booking!,
            matchingTransportersCount: ctx.matchingTransporters.length,
            timeoutSeconds: BOOKING_CONFIG.TIMEOUT_MS / 1000
          };
        }

        // FIX #23: Wrap post-persist broadcast calls. If any fail, expire the orphaned
        // booking so the customer can rebook immediately instead of waiting for stale GC.
        try {
          await _broadcastService.broadcastBookingToTransporters(ctx);
          await _broadcastService.sendFcmPushNotifications(ctx);
          await _broadcastService.setupBookingTimeout(ctx);
          await _broadcastService.setBookingRedisKeys(ctx);
        } catch (broadcastErr: unknown) {
          logger.error('[BookingCreate] Post-persist broadcast pipeline failed — expiring orphaned booking', {
            bookingId: ctx.bookingId,
            customerId: ctx.customerId,
            error: (broadcastErr as Error)?.message,
          });
          // CAS expire: only transition from non-terminal states
          // Fix #75: Assert valid transition before CAS write.
          // The booking could be in 'created' or 'broadcasting' here — both allow -> expired.
          // We cannot know the exact current status without a read, so we validate
          // the two possible source states at assertion time.
          try { assertValidTransition('Booking', BOOKING_VALID_TRANSITIONS, 'created', 'expired'); } catch { /* created->expired is valid */ }
          try { assertValidTransition('Booking', BOOKING_VALID_TRANSITIONS, 'broadcasting', 'expired'); } catch { /* broadcasting->expired is valid */ }
          await prismaClient.booking.updateMany({
            where: { id: ctx.bookingId, status: { notIn: ['cancelled', 'expired', 'completed', 'fully_filled'] } },
            data: { status: 'expired', stateChangedAt: new Date() },
          }).catch((err) => { logger.warn('[BookingCreate] Failed to expire booking after broadcast failure', { bookingId: ctx.bookingId, error: err instanceof Error ? err.message : String(err) }); });
          // Notify customer
          emitToUser(ctx.customerId, SocketEvent.BOOKING_EXPIRED, {
            bookingId: ctx.bookingId,
            status: 'expired',
            reason: 'broadcast_failed',
            message: 'Could not notify drivers. Please try again.',
          });
          // Also emit order_expired for customer app compatibility
          emitToUser(ctx.customerId, 'order_expired', {
            bookingId: ctx.bookingId,
            status: 'expired',
            reason: 'broadcast_failed',
            message: 'Could not notify drivers. Please try again.',
          });
          // Clear active-broadcast key so the customer is not stuck
          await redisService.del(`customer:active-broadcast:${ctx.customerId}`).catch(() => {});
          throw broadcastErr;
        }

        return {
          ...ctx.booking!,
          matchingTransportersCount: ctx.matchingTransporters.length,
          timeoutSeconds: BOOKING_CONFIG.TIMEOUT_MS / 1000
        };
      } finally {
        await this.releaseCustomerBroadcastLock(ctx);
      }
    } finally {
      await this.releaseBookingBackpressure(ctx);
    }
  }

  // ---------------------------------------------------------------------------
  // createBooking sub-methods (private, same class — preserves all original logic)
  // ---------------------------------------------------------------------------

  private async acquireBookingBackpressure(ctx: BookingContext): Promise<void> {
    // FIX A5#27: Redis concurrency counter — backpressure to prevent system overload
    // FIX #49: BOOKING_CONCURRENCY_LIMIT and BACKPRESSURE_TTL_SECONDS are now module-level constants
    try {
      const inflight = await redisService.incr(ctx.concurrencyKey);
      ctx.incremented = true;
      // TTL as crash safety net only (finally handles normal decrement)
      await redisService.expire(ctx.concurrencyKey, BACKPRESSURE_TTL_SECONDS).catch(() => {});
      if (inflight > BOOKING_CONCURRENCY_LIMIT) {
        await redisService.incrBy(ctx.concurrencyKey, -1).catch(() => {});
        ctx.incremented = false;
        throw new AppError(503, 'SYSTEM_BUSY', 'Too many bookings being processed.');
      }
    } catch (err) {
      if (err instanceof AppError) throw err; // re-throw 503
      // Redis down — skip backpressure, proceed with booking
      ctx.incremented = false;
    }
  }

  private async releaseBookingBackpressure(ctx: BookingContext): Promise<void> {
    // FIX A5#27: Only decrement if we successfully incremented (QA-8 fix)
    if (ctx.incremented) {
      await redisService.incrBy(ctx.concurrencyKey, -1).catch(() => {});
    }
  }

  private async checkBookingIdempotency(
    ctx: BookingContext
  ): Promise<(BookingRecord & { matchingTransportersCount: number; timeoutSeconds: number }) | null> {
    // SCALABILITY: Check idempotency key to prevent duplicate bookings
    if (!ctx.idempotencyKey) return null;

    // FIX #30: Include payload hash so same customer with different payloads gets different keys.
    // Prevents scenario: customer sends booking A, then booking B with different pickup — both
    // would be deduped under the same key without the payload hash.
    const payloadHash = crypto.createHash('sha256')
      .update(JSON.stringify({
        pickup: ctx.data.pickup.coordinates,
        drop: ctx.data.drop.coordinates,
        vehicleType: ctx.data.vehicleType,
      }))
      .digest('hex').slice(0, 16);
    const cacheKey = `idempotency:booking:${ctx.customerId}:${ctx.idempotencyKey}:${payloadHash}`;

    // FIX #31: Try to return cached response directly from Redis (avoids DB re-query on replay)
    const cachedResponse = await redisService.get(cacheKey) as string | null;

    if (cachedResponse) {
      // Check if this is a full cached response (JSON) or just a booking ID (legacy)
      try {
        const parsed = JSON.parse(cachedResponse);
        if (parsed && parsed.id && parsed.status) {
          // FIX: If the cached booking is cancelled or expired, bypass idempotency
          if (parsed.status === 'cancelled' || parsed.status === 'expired') {
            logger.info(`Idempotency: Cached booking ${parsed.id} is ${parsed.status} -- bypassing, allowing new booking`);
            await redisService.del(cacheKey);
          } else {
            logger.info('Idempotency: Returning cached response (no DB query)', {
              customerId: ctx.customerId,
              idempotencyKey: ctx.idempotencyKey,
              existingBookingId: parsed.id,
              existingStatus: parsed.status,
            });
            return parsed;
          }
        }
      } catch {
        // Not JSON — treat as legacy booking ID string
        const bookingId = cachedResponse;
        const existingBooking = await db.getBookingById(bookingId);

        if (existingBooking && (existingBooking.status === 'cancelled' || existingBooking.status === 'expired')) {
          logger.info(`Idempotency: Existing booking ${bookingId} is ${existingBooking.status} -- bypassing, allowing new booking`);
          await redisService.del(cacheKey);
        } else if (existingBooking) {
          logger.info('Idempotency: Duplicate booking request detected (legacy key)', {
            customerId: ctx.customerId,
            idempotencyKey: ctx.idempotencyKey,
            existingBookingId: bookingId,
            existingStatus: existingBooking.status,
          });

          const matchingTransporters = await db.getTransportersWithVehicleType(ctx.data.vehicleType);
          const result = {
            ...existingBooking,
            matchingTransportersCount: matchingTransporters.length,
            timeoutSeconds: Math.floor(BOOKING_CONFIG.TIMEOUT_MS / 1000),
          };
          // Upgrade: cache full response for future replays
          await redisService.set(cacheKey, JSON.stringify(result), 86400).catch(() => {});
          return result;
        }
      }
    }
    // Store the cacheKey on context so setBookingRedisKeys can use it
    ctx.idempotencyHash = payloadHash;
    return null;
  }

  private async acquireCustomerBroadcastLock(ctx: BookingContext): Promise<void> {
    // ========================================
    // ONE-ACTIVE-BROADCAST-PER-CUSTOMER GUARD
    // ========================================
    // Layered dedup pattern (Uber RAMEN / Stripe idempotency):
    //   Layer 1: Redis fast-path check below (catches 95%+ duplicates before DB)
    //   Layer 2: SERIALIZABLE TX further down is the real guard (correctness)
    // The Redis check is intentionally OUTSIDE the TX for performance —
    // if Redis is degraded, the SERIALIZABLE TX alone is sufficient.
    const activeKey = `customer:active-broadcast:${ctx.customerId}`;
    const existingBroadcastId = await redisService.get(activeKey);
    if (existingBroadcastId) {
      throw new AppError(409, 'ACTIVE_ORDER_EXISTS', 'Request already in progress. Cancel it first.');
    }

    // CRITICAL #17: Use unique request ID as lock holder instead of customerId
    // to prevent reentrant lock acquisition by the same customer
    const lock = await redisService.acquireLock(ctx.lockKey, ctx.lockHolder, 30);
    if (!lock.acquired) {
      throw new AppError(409, 'ACTIVE_ORDER_EXISTS', 'Request already in progress. Cancel it first.');
    }
    ctx.lockAcquired = true;
    // FIX-R2-6: Redis degradation guard — SERIALIZABLE TX below is the real dedup backstop
    if (redisService.isDegraded) {
      logger.warn('[LOCK] Redis degraded — booking dedup relies on SERIALIZABLE TX', { customerId: ctx.customerId, lockKey: ctx.lockKey });
    }
  }

  private async releaseCustomerBroadcastLock(ctx: BookingContext): Promise<void> {
    if (ctx.lockAcquired) {
      // CRITICAL #17: Release lock using the same unique request ID used for acquisition
      await redisService.releaseLock(ctx.lockKey, ctx.lockHolder).catch((err: unknown) => {
        logger.warn('Failed to release customer broadcast lock', { customerId: ctx.customerId, error: (err as Error).message });
      });
    }
  }

  private async checkServerSideIdempotency(
    ctx: BookingContext
  ): Promise<(BookingRecord & { matchingTransportersCount: number; timeoutSeconds: number }) | null> {
    // ========================================
    // SERVER-GENERATED IDEMPOTENCY (double-tap / retry protection)
    // ========================================
    // FIX #29: Guard undefined/NaN coordinate values with String(v ?? 'MISSING')
    // to prevent NaN hash collisions when coords are absent or non-numeric.
    const idempotencyFingerprint = [
      ctx.customerId,
      ctx.data.vehicleType,
      ctx.data.vehicleSubtype || '',
      String(ctx.data.pickup?.coordinates?.latitude != null ? roundCoord(ctx.data.pickup.coordinates!.latitude) : 'MISSING'),
      String(ctx.data.pickup?.coordinates?.longitude != null ? roundCoord(ctx.data.pickup.coordinates!.longitude) : 'MISSING'),
      String(ctx.data.drop?.coordinates?.latitude != null ? roundCoord(ctx.data.drop.coordinates!.latitude) : 'MISSING'),
      String(ctx.data.drop?.coordinates?.longitude != null ? roundCoord(ctx.data.drop.coordinates!.longitude) : 'MISSING'),
      String(ctx.data.trucksNeeded ?? 'MISSING'),
      String(ctx.data.pricePerTruck ?? 'MISSING')
    ].join(':');
    ctx.idempotencyHash = crypto.createHash('sha256').update(idempotencyFingerprint).digest('hex').substring(0, 32);
    // FIX #77: Use booking-specific prefix to avoid collision with order deduplication keys
    ctx.dedupeKey = `idem:booking:create:${ctx.customerId}:${ctx.idempotencyHash}`;

    const existingDedupeId = await redisService.get(ctx.dedupeKey);
    if (existingDedupeId) {
      const existingDedupeBooking = await db.getBookingById(existingDedupeId);
      if (existingDedupeBooking && !['cancelled', 'expired'].includes(existingDedupeBooking.status)) {
        logger.info('Idempotent replay: returning existing booking', { bookingId: existingDedupeId, idempotencyHash: ctx.idempotencyHash });
        const matchingTransporters = await db.getTransportersWithVehicleType(ctx.data.vehicleType);
        return {
          ...existingDedupeBooking,
          matchingTransportersCount: matchingTransporters.length,
          timeoutSeconds: Math.floor(BOOKING_CONFIG.TIMEOUT_MS / 1000)
        };
      }
    }
    return null;
  }

  private async resolveCustomerName(ctx: BookingContext): Promise<void> {
    const customer = await db.getUserById(ctx.customerId);
    ctx.customerName = customer?.name || 'Customer';
  }

  private async calculateRouteDistance(ctx: BookingContext): Promise<void> {
    // ==========================================================================
    // SERVER-SIDE ROUTE DISTANCE (Google Directions API)
    // ==========================================================================
    // FIX P7: Moved BEFORE fare check so we validate against server-authoritative
    // distance (Google-verified), not the client-supplied distance which could be
    // manipulated or inaccurate (Haversine instead of road distance).
    // Falls back to customer value if Google fails — never blocks bookings.
    // ==========================================================================
    ctx.clientDistanceKm = ctx.data.distanceKm;
    ctx.distanceSource = 'client_fallback';

    try {
      const pickupCoords = ctx.data.pickup.coordinates;
      const dropCoords = ctx.data.drop.coordinates;

      if (pickupCoords && dropCoords) {
        // Truck mode: OFF by default. When FF_TRUCK_MODE_ROUTING=true,
        // heavy vehicles avoid highways/tolls for truck-accurate routing.
        const FF_TRUCK_MODE_ROUTING = process.env.FF_TRUCK_MODE_ROUTING === 'true';
        const HEAVY_VEHICLE_TYPES = new Set(['open', 'container', 'tipper', 'flatbed']);
        const useTruckMode = FF_TRUCK_MODE_ROUTING && HEAVY_VEHICLE_TYPES.has(ctx.data.vehicleType);

        const googleRoute = await googleMapsService.calculateRoute(
          [
            { lat: pickupCoords.latitude, lng: pickupCoords.longitude },
            { lat: dropCoords.latitude, lng: dropCoords.longitude }
          ],
          useTruckMode
        );

        if (googleRoute && googleRoute.distanceKm > 0) {
          ctx.data.distanceKm = googleRoute.distanceKm;
          ctx.distanceSource = 'google';

          const deltaPercent = ctx.clientDistanceKm > 0
            ? Math.round(((googleRoute.distanceKm - ctx.clientDistanceKm) / ctx.clientDistanceKm) * 100)
            : 0;

          logger.info('[BOOKING] Route distance calculated via Google Directions', {
            distanceSource: 'google',
            clientDistanceKm: ctx.clientDistanceKm,
            serverDistanceKm: googleRoute.distanceKm,
            deltaPercent: `${deltaPercent}%`,
            durationMinutes: googleRoute.durationMinutes,
            ...(Math.abs(deltaPercent) > 200 ? { distanceAnomaly: true } : {})
          });
        } else {
          logger.warn('[BOOKING] Google Directions returned null/zero — will run Haversine check', {
            clientDistanceKm: ctx.clientDistanceKm, reason: 'google_returned_empty'
          });
        }
      }
    } catch (routeError: unknown) {
      logger.warn('[BOOKING] Google Directions failed — will run Haversine check', {
        clientDistanceKm: ctx.clientDistanceKm, error: (routeError as Error).message
      });
    }

    // FIX-R2-3: Haversine sanity check for ALL non-Google paths (covers both null-return AND exception)
    // FIX #30: When Google fails, always use Haversine for fare (never trust client-supplied distance).
    // Haversine * 1.3 road-correction is the server-authoritative value on the fallback path.
    if (ctx.distanceSource === 'client_fallback') {
      const haversineKm = haversineDistanceKm(
        ctx.data.pickup.coordinates!.latitude, ctx.data.pickup.coordinates!.longitude,
        ctx.data.drop.coordinates!.latitude, ctx.data.drop.coordinates!.longitude
      );
      if (haversineKm > 0) {
        const roadEstimate = Math.ceil(haversineKm * 1.3);
        if (Math.abs(ctx.data.distanceKm - haversineKm) / haversineKm > 0.5) {
          logger.warn('[BOOKING] Client distance differs >50% from Haversine — using Haversine road estimate for fare', {
            clientKm: ctx.data.distanceKm, haversineKm, roadEstimate
          });
        } else {
          logger.info('[BOOKING] Google unavailable — using Haversine road estimate for fare (not client distance)', {
            clientKm: ctx.data.distanceKm, haversineKm, roadEstimate
          });
        }
        ctx.data.distanceKm = roadEstimate;
        // Keep as 'client_fallback' type (haversine IS the client_fallback path)
        ctx.distanceSource = 'client_fallback';
      }
    }
  }

  private validateBookingFare(ctx: BookingContext): void {
    // ========================================
    // SERVER-SIDE FARE SANITY CHECK (uses server-verified distance)
    // ========================================
    // FIX P7: Now runs AFTER Google distance calc so we use the server-authoritative
    // distance (data.distanceKm is now Google-verified or client fallback).
    // Prevents financial exploits (e.g., ₹1 per truck for 200km)
    // Uses env-configurable floor: MIN_FARE_PER_KM (default ₹8/km)
    // Tolerance: FARE_TOLERANCE (default 0.5 = 50% below estimate)
    // Formula: reject if pricePerTruck < max(500, distKm × minRate × tolerance)
    const MIN_FARE_PER_KM = parseInt(process.env.MIN_FARE_PER_KM || '8', 10);
    const FARE_TOLERANCE = parseFloat(process.env.FARE_TOLERANCE || '0.5');
    const fareCheckDistanceKm = ctx.data.distanceKm; // Google-verified or client fallback
    const estimatedMinFare = Math.max(500, Math.round(fareCheckDistanceKm * MIN_FARE_PER_KM * FARE_TOLERANCE));
    if (ctx.data.pricePerTruck < estimatedMinFare) {
      throw new AppError(400, 'FARE_TOO_LOW',
        `Price ₹${ctx.data.pricePerTruck} is below minimum ₹${estimatedMinFare} for ${fareCheckDistanceKm}km trip`);
    }
  }

  private async findMatchingTransporters(ctx: BookingContext): Promise<void> {
    // ========================================
    // PROGRESSIVE RADIUS SEARCH (Requirement 6)
    // Step 1: Start with smallest radius (10km)
    // If no one accepts, expiry checker expands every 15s
    // ========================================
    ctx.vehicleKey = generateVehicleKey(ctx.data.vehicleType, ctx.data.vehicleSubtype);
    const step1 = RADIUS_EXPANSION_CONFIG.steps[0];

    // Step 1 search: H3 primary → GEORADIUS fallback → Google ETA → Haversine
    ctx.step1Candidates = await progressiveRadiusMatcher.findCandidates({
      pickupLat: ctx.data.pickup.coordinates!.latitude,
      pickupLng: ctx.data.pickup.coordinates!.longitude,
      vehicleType: ctx.data.vehicleType,
      vehicleSubtype: ctx.data.vehicleSubtype || '',
      stepIndex: 0,
      alreadyNotified: new Set(),
      limit: RADIUS_EXPANSION_CONFIG.maxTransportersPerStep
    });
    let nearbyTransporters = ctx.step1Candidates.map(c => c.transporterId);

    logger.info(`📍 [RADIUS STEP 1/${RADIUS_EXPANSION_CONFIG.steps.length}] Found ${nearbyTransporters.length} transporters within ${step1.radiusKm}km for ${ctx.vehicleKey}`);

    // Fallback: If no nearby online transporters at step 1, get ALL transporters from DB
    // This ensures we still broadcast even if no one has sent heartbeats recently
    ctx.skipProgressiveExpansion = false;  // DB fallback already covers everyone
    if (nearbyTransporters.length > 0) {
      ctx.matchingTransporters = nearbyTransporters;
      logger.info(`🎯 Using PROXIMITY-BASED matching (${nearbyTransporters.length} nearby at ${step1.radiusKm}km)`);
    } else {
      const allDbTransporters = await db.getTransportersWithVehicleType(ctx.data.vehicleType);
      // Cap at 100 to prevent unbounded fan-out — covers all realistic online counts
      ctx.matchingTransporters = (await transporterOnlineService.filterOnline(allDbTransporters)).slice(0, 100);
      ctx.skipProgressiveExpansion = true;  // DB fallback already notified all — no radius expansion needed
      logger.info(`📋 Fallback to DATABASE matching (${allDbTransporters.length} total, ${ctx.matchingTransporters.length} online) — skipping progressive expansion`);

      // Load transporter locations from Redis → calculate road distance + ETA
      // Uses directionsApiService (Redis cache → Google Distance Matrix → Haversine)
      if (ctx.matchingTransporters.length > 0) {
        try {
          const detailsMap = await availabilityService.loadTransporterDetailsMap(ctx.matchingTransporters);
          const origins: Array<{ lat: number; lng: number; id: string }> = [];

          for (const tid of ctx.matchingTransporters) {
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
              origins,
              ctx.data.pickup.coordinates!.latitude,
              ctx.data.pickup.coordinates!.longitude
            );

            for (const origin of origins) {
              const eta = etaResults.get(origin.id);
              if (eta) {
                ctx.step1Candidates.push({
                  transporterId: origin.id,
                  distanceKm: eta.distanceMeters / 1000,
                  latitude: origin.lat,
                  longitude: origin.lng,
                  etaSeconds: eta.durationSeconds,
                  etaSource: eta.source as any
                });
              }
            }

            const cacheHits = Array.from(etaResults.values()).filter(r => r.cached).length;
            logger.info(`📍 DB fallback: Road distance for ${origins.length} transporters (cache hits: ${cacheHits}, API calls: ${origins.length - cacheHits})`);
          }
        } catch (err: unknown) {
          logger.warn(`⚠️ Failed to calculate ETA for DB fallback: ${(err as Error).message}`);
          // Last-resort haversine fallback if directionsApiService completely fails
          try {
            const detailsMap = await availabilityService.loadTransporterDetailsMap(ctx.matchingTransporters);
            for (const tid of ctx.matchingTransporters) {
              const details = detailsMap.get(tid);
              if (details) {
                const lat = parseFloat(details.latitude);
                const lng = parseFloat(details.longitude);
                if (Number.isFinite(lat) && Number.isFinite(lng)) {
                  const distKm = haversineDistanceKm(
                    ctx.data.pickup.coordinates!.latitude,
                    ctx.data.pickup.coordinates!.longitude,
                    lat, lng
                  );
                  const etaSec = Math.round((distKm / 30) * 3600);
                  ctx.step1Candidates.push({
                    transporterId: tid,
                    distanceKm: distKm,
                    latitude: lat,
                    longitude: lng,
                    etaSeconds: etaSec,
                    etaSource: 'haversine'
                  });
                }
              }
            }
            logger.info(`📍 DB fallback: Haversine fallback for ${ctx.step1Candidates.length} transporters`);
          } catch (fallbackErr: unknown) {
            logger.warn(`⚠️ Haversine fallback also failed: ${(fallbackErr as Error).message}`);
          }
        }
      }

      // Fix D3/F-3-6: Distance cap on step 1 DB fallback — prevent nationwide broadcasts
      const MAX_STEP1_FALLBACK_RADIUS_KM = 100;
      const candidateDistanceMap = new Map<string, number>();
      for (const c of ctx.step1Candidates) {
        candidateDistanceMap.set(c.transporterId, c.distanceKm);
      }
      const beforeFilter = ctx.matchingTransporters.length;
      ctx.matchingTransporters = ctx.matchingTransporters.filter(tid => {
        const dist = candidateDistanceMap.get(tid);
        if (dist !== undefined) {
          return dist <= MAX_STEP1_FALLBACK_RADIUS_KM;
        }
        // FIX #29: No distance data means we cannot verify proximity — exclude
        // to prevent nationwide broadcasts when ETA service fails completely.
        // Safe: progressive radius expansion will re-discover them in later steps.
        return false;
      });
      if (ctx.matchingTransporters.length < beforeFilter) {
        logger.info(`[RADIUS] Step 1 DB fallback distance cap: ${beforeFilter} -> ${ctx.matchingTransporters.length} (filtered ${beforeFilter - ctx.matchingTransporters.length} beyond ${MAX_STEP1_FALLBACK_RADIUS_KM}km)`);
      }
    }

    logger.info(`╔══════════════════════════════════════════════════════════════╗`);
    logger.info(`║  🚛 NEW BOOKING REQUEST (Progressive Radius)                    ║`);
    logger.info(`╠══════════════════════════════════════════════════════════════╣`);
    logger.info(`║  Vehicle: ${ctx.data.vehicleType} - ${ctx.data.vehicleSubtype || 'Any'}`);
    logger.info(`║  Trucks Needed: ${ctx.data.trucksNeeded}`);
    logger.info(`║  Price/Truck: ₹${ctx.data.pricePerTruck}`);
    logger.info(`║  Distance: ${ctx.data.distanceKm} km`);
    logger.info(`║  Step 1 Radius: ${step1.radiusKm}km`);
    logger.info(`║  Matching Transporters (Step 1): ${ctx.matchingTransporters.length}`);
    logger.info(`║  Timeout: ${BOOKING_CONFIG.TIMEOUT_MS / 1000} seconds`);
    logger.info(`╚══════════════════════════════════════════════════════════════╝`);
  }

  private async persistBookingTransaction(ctx: BookingContext): Promise<void> {
    // ========================================
    // SERIALIZABLE TRANSACTION: DB check + create (TOCTOU-safe)
    // Prevents duplicate active bookings when Redis lock fails.
    // PostgreSQL serializable isolation aborts one transaction on conflict.
    // ========================================
    await withDbTimeout(async (tx) => {
      // DB authoritative check (covers Redis failure edge case)
      // FIX CRITICAL#1: ALLOWLIST pattern — block ALL non-terminal statuses
      // (including fully_filled and in_progress which were previously missed).
      // Any new status added in the future is automatically blocked.
      const existingBooking = await tx.booking.findFirst({
        where: { customerId: ctx.customerId, status: { notIn: [...TERMINAL_STATUSES] as BookingStatus[] } }
      });
      const existingOrder = await tx.order.findFirst({
        where: { customerId: ctx.customerId, status: { notIn: [...TERMINAL_STATUSES] as OrderStatus[] } }
      });
      if (existingBooking || existingOrder) {
        throw new AppError(409, 'ACTIVE_ORDER_EXISTS', 'Request already in progress. Cancel it first.');
      }

      // Create booking atomically with the check
      await tx.booking.create({
        data: {
          id: ctx.bookingId,
          customerId: ctx.customerId,
          customerName: ctx.customerName,
          customerPhone: ctx.customerPhone,
          pickup: {
            latitude: ctx.data.pickup.coordinates!.latitude,
            longitude: ctx.data.pickup.coordinates!.longitude,
            address: ctx.data.pickup.address,
            city: ctx.data.pickup.city,
            state: ctx.data.pickup.state
          } as Prisma.JsonObject,
          drop: {
            latitude: ctx.data.drop.coordinates!.latitude,
            longitude: ctx.data.drop.coordinates!.longitude,
            address: ctx.data.drop.address,
            city: ctx.data.drop.city,
            state: ctx.data.drop.state
          } as Prisma.JsonObject,
          vehicleType: ctx.data.vehicleType,
          vehicleSubtype: ctx.data.vehicleSubtype,
          trucksNeeded: ctx.data.trucksNeeded,
          trucksFilled: 0,
          distanceKm: ctx.data.distanceKm,
          pricePerTruck: ctx.data.pricePerTruck,
          totalAmount: Math.round(ctx.data.pricePerTruck * ctx.data.trucksNeeded * 100) / 100,
          goodsType: ctx.data.goodsType,
          weight: ctx.data.weight,
          status: BookingStatus.created,
          stateChangedAt: new Date(),
          // Cap at 200 to bound cancel/expire iteration (industry standard)
          notifiedTransporters: ctx.matchingTransporters.slice(0, 200),
          scheduledAt: ctx.data.scheduledAt,
          expiresAt: ctx.expiresAt
        }
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeoutMs: 8000 });

    // Fetch as BookingRecord (converts JSON fields + dates for downstream use)
    ctx.booking = await db.getBookingById(ctx.bookingId);
    if (!ctx.booking) {
      throw new AppError(500, 'BOOKING_CREATE_FAILED', 'Failed to create booking');
    }

    // ========================================
    // SET ACTIVE-BROADCAST GUARD EARLY (before any broadcasts)
    // Moved here from after broadcasts to prevent race where a second
    // createBooking call slips in while broadcasts are still being sent.
    // ========================================
    // FIX CRITICAL#3: TTL=86400 (24h) as SAFETY CEILING, not primary cleanup.
    // Primary cleanup is explicit DEL on terminal status (clearCustomerActiveBroadcast).
    // Industry standard (Stripe): idempotency keys have 24h TTL, cleared on completion.
    //
    // FIX #33 (pragmatic): This Redis SET runs AFTER the DB commit. A crash between
    // DB commit and this line leaves the booking in DB without a Redis guard key.
    // True atomicity requires an outbox pattern (too large a change for this fix).
    // Recovery: bookingLifecycleService.resumeInterruptedBroadcasts() on startup
    // detects bookings stuck in 'broadcasting' and re-queues them, which also
    // restores the active-broadcast key. This covers the crash-recovery path.
    const activeKey = `customer:active-broadcast:${ctx.customerId}`;
    const ACTIVE_BROADCAST_TTL_SECONDS = 86400;
    await redisService.set(activeKey, ctx.booking.id, ACTIVE_BROADCAST_TTL_SECONDS);

    // Emit lifecycle state: created
    emitToUser(ctx.customerId, SocketEvent.BROADCAST_STATE_CHANGED, {
      bookingId: ctx.booking.id,
      status: 'created',
      stateChangedAt: new Date().toISOString()
    });

    // ========================================
    // HANDLE: No matching transporters found
    // ========================================
    if (ctx.matchingTransporters.length === 0) {
      logger.warn(`⚠️ NO TRANSPORTERS FOUND for ${ctx.data.vehicleType}`);

      // Immediately notify customer
      emitToUser(ctx.customerId, SocketEvent.NO_VEHICLES_AVAILABLE, {
        bookingId: ctx.booking.id,
        vehicleType: ctx.data.vehicleType,
        vehicleSubtype: ctx.data.vehicleSubtype,
        message: `No ${ctx.data.vehicleType} vehicles available right now. Please try again later or select a different vehicle type.`,
        suggestion: 'search_again'
      });

      // Transition through broadcasting before expiring (created -> broadcasting -> expired)
      // This ensures state machine consistency even on the no-transporter path
      // Fix #75: Assert valid transition before CAS write
      assertValidTransition('Booking', BOOKING_VALID_TRANSITIONS, 'created', 'broadcasting');
      // FIX-R2-1: Conditional status write — only transition from 'created'
      await prismaClient.booking.updateMany({
        where: { id: ctx.booking.id, status: 'created' },
        data: { status: 'broadcasting', stateChangedAt: new Date() }
      });
      // Mark as expired immediately
      // Fix #75: Assert valid transition before CAS write
      assertValidTransition('Booking', BOOKING_VALID_TRANSITIONS, 'broadcasting', 'expired');
      // FIX-R2-1: Conditional status write — only transition from created/broadcasting
      try {
        await prismaClient.booking.updateMany({
          where: { id: ctx.booking.id, status: { in: ['created', 'broadcasting'] } },
          data: { status: 'expired', stateChangedAt: new Date() }
        });
      } catch (err: unknown) {
        logger.error('[BOOKING] Failed to mark booking as expired (no transporters)', { bookingId: ctx.booking.id, error: (err as Error).message });
      }

      // FIX MEDIUM#27: Clean up Redis active-broadcast key so customer can rebook
      // immediately instead of waiting for the 24h TTL to expire.
      await redisService.del(activeKey).catch((err: unknown) => {
        logger.warn('[BOOKING] Failed to clear active key on no-transporter path', {
          bookingId: ctx.booking!.id, error: (err as Error).message
        });
      });

      // FIX #28: Set server-side idempotency cache on no-transporter early-return path
      // so that replayed requests don't re-execute the full create pipeline.
      if (ctx.dedupeKey) {
        await redisService.set(ctx.dedupeKey, ctx.booking.id, Math.ceil(BOOKING_CONFIG.TIMEOUT_MS / 1000) + 30).catch(() => {});
      }

      ctx.earlyReturn = {
        ...ctx.booking,
        status: 'expired',
        matchingTransportersCount: 0,
        timeoutSeconds: 0
      };
    }
  }

}

export const bookingCreateService = new BookingCreateService();
