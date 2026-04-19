/**
 * =============================================================================
 * BOOKING MODULE - SERVICE
 * =============================================================================
 * 
 * Business logic for customer bookings.
 * 
 * KEY FEATURES:
 * 1. Smart Matching Algorithm
 *    - Finds transporters with matching truck TYPE (simplified for testing)
 *    - Broadcasts to ALL matching transporters
 * 
 * 2. Request Timeout System
 *    - Configurable timeout (5 min test / 30 min production)
 *    - Auto-expires unfilled bookings
 *    - Notifies customer with "No vehicle available"
 * 
 * 3. Partial Fulfillment
 *    - Multiple transporters can fill same request
 *    - Tracks trucks filled vs trucks needed
 *    - Keeps broadcasting until all trucks filled or timeout
 * 
 * SCALABILITY: Designed for millions of concurrent users
 * =============================================================================
 */

import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import { db, BookingRecord } from '../../shared/database/db';
import { Prisma } from '@prisma/client';
import { prismaClient, withDbTimeout, BookingStatus, AssignmentStatus, VehicleStatus } from '../../shared/database/prisma.service';
import { AppError } from '../../shared/types/error.types';
import { config } from '../../config/environment';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, emitToBooking, SocketEvent, isUserConnected } from '../../shared/services/socket.service';
import { fcmService } from '../../shared/services/fcm.service';
import { queueService } from '../../shared/services/queue.service';
import { CreateBookingInput, GetBookingsQuery } from './booking.schema';
import { availabilityService } from '../../shared/services/availability.service';
import { generateVehicleKey } from '../../shared/services/vehicle-key.service';
import { progressiveRadiusMatcher, PROGRESSIVE_RADIUS_STEPS } from '../order/progressive-radius-matcher';
import { transporterOnlineService } from '../../shared/services/transporter-online.service';
import { redisService } from '../../shared/services/redis.service';
import { liveAvailabilityService } from '../../shared/services/live-availability.service';
import { releaseVehicle } from '../../shared/services/vehicle-lifecycle.service';
import { haversineDistanceKm } from '../../shared/utils/geospatial.utils';
import { distanceMatrixService } from '../../shared/services/distance-matrix.service';
// 4 PRINCIPLES: Import production-grade error codes
import { ErrorCode } from '../../core/constants';
import { assertValidTransition, BOOKING_VALID_TRANSITIONS } from '../../core/state-machines';
import { buildBroadcastPayload, getRemainingTimeoutSeconds } from './booking-payload.helper';
import { googleMapsService } from '../../shared/services/google-maps.service';
import { roundCoord } from '../../shared/utils/geo.utils';

// =============================================================================
// CONFIGURATION - Easy to adjust for testing vs production
// =============================================================================

const BROADCAST_TIMEOUT_SECONDS = parseInt(process.env.BROADCAST_TIMEOUT_SECONDS || '120', 10);

const BOOKING_CONFIG = {
  // Timeout: env-configurable, default 120s. Must be > progressive radius time (4 × 15s = 60s)
  TIMEOUT_MS: BROADCAST_TIMEOUT_SECONDS * 1000,

  // How often to check for expired bookings (Redis-based)
  EXPIRY_CHECK_INTERVAL_MS: 5 * 1000,  // Every 5 seconds
};

// =============================================================================
// PROGRESSIVE RADIUS EXPANSION CONFIG (Requirement 6)
// =============================================================================
// Fix H-X2: Unified config — imports steps from progressive-radius-matcher.ts
// Both booking path and order path now share the same 6-step radius steps.
// Total time: 10+10+15+15+15+15 = 80s < 108s (passes startup validation)
// =============================================================================
const RADIUS_EXPANSION_CONFIG = {
  steps: PROGRESSIVE_RADIUS_STEPS.map(step => ({
    radiusKm: step.radiusKm,
    timeoutMs: step.windowMs,
  })),
  maxTransportersPerStep: 20,  // Top N nearest per step
};

// =============================================================================
// STARTUP CONFIG VALIDATION (F-2-17)
// Fail fast if radius expansion time budget exceeds booking timeout.
// =============================================================================
const TOTAL_RADIUS_EXPANSION_MS = RADIUS_EXPANSION_CONFIG.steps.reduce(
  (sum, step) => sum + step.timeoutMs, 0
);
if (TOTAL_RADIUS_EXPANSION_MS >= BOOKING_CONFIG.TIMEOUT_MS * 0.9) {
  throw new Error(
    `Config error: total radius expansion time (${TOTAL_RADIUS_EXPANSION_MS}ms) must be < 90% of ` +
    `booking timeout (${BOOKING_CONFIG.TIMEOUT_MS}ms). ` +
    `Set BROADCAST_TIMEOUT_SECONDS > ${Math.ceil(TOTAL_RADIUS_EXPANSION_MS / 900)}`
  );
}

// =============================================================================
// REDIS KEY PATTERNS (for distributed timers)
// =============================================================================
const TIMER_KEYS = {
  BOOKING_EXPIRY: (bookingId: string) => `timer:booking:${bookingId}`,
  COUNTDOWN: (bookingId: string) => `timer:countdown:${bookingId}`,
  RADIUS_STEP: (bookingId: string) => `timer:radius:${bookingId}`,
};

// Redis keys for progressive radius tracking
const RADIUS_KEYS = {
  CURRENT_STEP: (bookingId: string) => `broadcast:radius:step:${bookingId}`,
  NOTIFIED_SET: (bookingId: string) => `broadcast:notified:${bookingId}`,
};

// Timer data interface
interface BookingTimerData {
  bookingId: string;
  customerId: string;
  createdAt: string;
}

// Timer data for progressive radius expansion steps
interface RadiusStepTimerData {
  bookingId: string;
  customerId: string;
  vehicleKey: string;
  vehicleType: string;
  vehicleSubtype: string;
  pickupLat: number;
  pickupLng: number;
  currentStep: number;  // 0-indexed (0 = step 1 already done, advance to step 2)
}

// =============================================================================
// EXPIRY CHECKER (Runs on every server instance - Redis ensures no duplicates)
// =============================================================================
let expiryCheckerInterval: NodeJS.Timeout | null = null;
// Fix #17: Counter for DB-based expiry sweep (runs every 12th tick = 60s)
let dbSweepCounter = 0;

/**
 * Start the booking expiry checker
 * This runs on every server instance but uses Redis locks to prevent duplicate processing
 */
function startBookingExpiryChecker(): void {
  if (expiryCheckerInterval) return;

  expiryCheckerInterval = setInterval(async () => {
    try {
      await processExpiredBookings();
      await processRadiusExpansionTimers();

      // Fix #17: DB-based fallback sweep every 60s (12 * 5s interval).
      // Catches bookings that expired according to DB but were missed by Redis
      // (e.g., Redis restart wiped all timers). Industry pattern: Stripe "completer".
      dbSweepCounter++;
      if (dbSweepCounter % 12 === 0) {
        await sweepExpiredBookingsFromDB();
      }
    } catch (error: any) {
      logger.error('Booking expiry checker error', { error: error.message });
    }
  }, BOOKING_CONFIG.EXPIRY_CHECK_INTERVAL_MS);

  logger.info('📅 Booking expiry checker started (Redis-based, cluster-safe)');
}

/**
 * Process all expired booking timers
 * Uses Redis distributed lock to prevent multiple instances processing the same booking
 */
async function processExpiredBookings(): Promise<void> {
  const expiredTimers = await redisService.getExpiredTimers<BookingTimerData>('timer:booking:');

  for (const timer of expiredTimers) {
    // Per-booking unified lock: both expiry and radius expansion contend on the same key.
    // Prevents race where one expires the booking while the other expands radius.
    // Pattern: Martin Kleppmann -- single lock per entity, not per operation type.
    const lockKey = `lock:booking:${timer.data.bookingId}`;
    const lock = await redisService.acquireLock(lockKey, 'expiry-checker', 30);

    if (!lock.acquired) {
      // Another instance is processing this booking
      continue;
    }

    // FIX-R2-6: Idempotent DB status check after lock (guards against Redis-degraded multi-instance)
    const freshBooking = await db.getBookingById(timer.data.bookingId);
    if (!freshBooking || ['expired', 'completed', 'cancelled', 'fully_filled'].includes(freshBooking.status)) {
      await redisService.releaseLock(lockKey, 'expiry-checker');
      continue;
    }

    try {
      // Cancel timer FIRST to prevent re-processing if handleBookingTimeout throws
      await redisService.cancelTimer(timer.key);
      await bookingService.handleBookingTimeout(timer.data.bookingId, timer.data.customerId);
    } catch (error: any) {
      logger.error('Failed to process expired booking', {
        bookingId: timer.data.bookingId,
        error: error.message
      });
    } finally {
      await redisService.releaseLock(lockKey, 'expiry-checker').catch(() => { });
    }
  }
}

/**
 * DB-based fallback for expired bookings missed by Redis timers.
 * Runs every 60s (12th tick of the 5s interval). Catches bookings that expired
 * according to DB but were never processed (e.g., Redis restart wiped timers).
 *
 * Industry pattern: Stripe "completer" process -- finds unfinished keys
 * and drives them to completion.
 *
 * Handler (handleBookingTimeout) is already idempotent: checks booking status
 * before acting, skips terminal states. Safe to call on already-processed bookings.
 *
 * Fix #17: Booking expiry timer lost on Redis restart.
 */
async function sweepExpiredBookingsFromDB(): Promise<void> {
  const lockKey = 'lock:booking-db-sweep';
  const lock = await redisService.acquireLock(lockKey, 'db-sweep', 55);
  if (!lock.acquired) return;

  try {
    // expiresAt is stored as ISO string in DB (type String in Prisma schema).
    // ISO 8601 strings compare lexicographically, so string lte works correctly.
    const nowIso = new Date().toISOString();
    const expiredBookings = await prismaClient.booking.findMany({
      where: {
        status: { in: ['broadcasting', 'active', 'partially_filled', 'created'] },
        expiresAt: { lte: nowIso },
      },
      select: { id: true, customerId: true },
      take: 50, // Process in batches to bound cycle time
    });

    if (expiredBookings.length === 0) return;

    logger.warn(`[DB-SWEEP] Found ${expiredBookings.length} expired bookings missed by Redis timers`);

    for (const b of expiredBookings) {
      try {
        await bookingService.handleBookingTimeout(b.id, b.customerId);
      } catch (err: any) {
        logger.error(`[DB-SWEEP] Failed to expire booking ${b.id}: ${err.message}`);
      }
    }
  } finally {
    await redisService.releaseLock(lockKey, 'db-sweep').catch(() => {});
  }
}

// Exported so server.ts can call it after Redis is ready (no auto-start on import).
export { startBookingExpiryChecker };

/** Stop the booking expiry checker (for graceful shutdown) */
export function stopBookingExpiryChecker(): void {
  if (expiryCheckerInterval) {
    clearInterval(expiryCheckerInterval);
    expiryCheckerInterval = null;
    logger.info('Booking expiry checker stopped');
  }
}

/**
 * Process radius expansion timers — called from the same expiry checker interval.
 * When a radius step timer expires, advances to the next step and broadcasts
 * to new transporters in the expanded radius.
 */
async function processRadiusExpansionTimers(): Promise<void> {
  const expiredTimers = await redisService.getExpiredTimers<RadiusStepTimerData>('timer:radius:');

  for (const timer of expiredTimers) {
    // Per-booking unified lock: same key as processExpiredBookings ensures mutual exclusion.
    // If expiry gets the lock, radius expansion skips. If expansion gets it, expiry waits.
    const lockKey = `lock:booking:${timer.data.bookingId}`;
    const lock = await redisService.acquireLock(lockKey, 'radius-expander', 15);

    if (!lock.acquired) continue;

    try {
      // Cancel timer FIRST to prevent re-processing if advanceRadiusStep throws
      await redisService.cancelTimer(timer.key);
      await bookingService.advanceRadiusStep(timer.data);
    } catch (error: any) {
      logger.error('[RADIUS EXPANSION] Failed to advance step', {
        bookingId: timer.data.bookingId,
        step: timer.data.currentStep,
        error: error.message
      });
    } finally {
      await redisService.releaseLock(lockKey, 'radius-expander').catch(() => { });
    }
  }
}

class BookingService {

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
    // FIX A5#27: Redis concurrency counter — backpressure to prevent system overload
    const BOOKING_CONCURRENCY_LIMIT = Math.max(1, config.bookingConcurrencyLimit);
    const BACKPRESSURE_TTL_SECONDS = 300;
    const RETRY_AFTER_SECONDS = 2;
    const concurrencyKey = 'booking:create:inflight';
    let incremented = false;
    try {
      const inflight = await redisService.incr(concurrencyKey);
      incremented = true;
      // TTL as crash safety net only (finally handles normal decrement)
      await redisService.expire(concurrencyKey, BACKPRESSURE_TTL_SECONDS).catch(() => {});
      if (inflight > BOOKING_CONCURRENCY_LIMIT) {
        await redisService.incrBy(concurrencyKey, -1).catch(() => {});
        incremented = false;
        throw new AppError(429, 'SYSTEM_BUSY', 'Too many bookings being processed. Please retry shortly.', { retryAfter: RETRY_AFTER_SECONDS });
      }
    } catch (err) {
      if (err instanceof AppError) throw err; // re-throw 429
      // Redis down — log warning and skip backpressure, proceed with booking
      logger.warn('Backpressure guard skipped: Redis unavailable', { error: err instanceof Error ? err.message : String(err) });
      incremented = false;
    }

    try {
    // SCALABILITY: Check idempotency key to prevent duplicate bookings
    if (idempotencyKey) {
      const cacheKey = `idempotency:booking:${customerId}:${idempotencyKey}`;
      const cachedBooking = await redisService.get(cacheKey) as string | null;

      if (cachedBooking) {
        const existingBooking = await db.getBookingById(cachedBooking);

        // FIX: If the existing booking is cancelled or expired, bypass idempotency
        // This allows the customer to immediately re-request after cancelling
        if (existingBooking && (existingBooking.status === 'cancelled' || existingBooking.status === 'expired')) {
          logger.info(`🔓 Idempotency: Existing booking ${cachedBooking} is ${existingBooking.status} — bypassing, allowing new booking`);
          // Clear the stale idempotency key so it doesn't block future requests
          await redisService.del(cacheKey);
        } else if (existingBooking) {
          // EASY UNDERSTANDING: Duplicate request detected, return existing ACTIVE booking
          logger.info(`🔒 Idempotency: Duplicate booking request detected`, {
            customerId,
            idempotencyKey,
            existingBookingId: cachedBooking,
            existingStatus: existingBooking.status
          });

          const matchingTransporters = await db.getTransportersWithVehicleType(data.vehicleType);
          return {
            ...existingBooking,
            matchingTransportersCount: matchingTransporters.length,
            timeoutSeconds: Math.floor(BOOKING_CONFIG.TIMEOUT_MS / 1000)
          };
        }
      }
    }

    // ========================================
    // ONE-ACTIVE-BROADCAST-PER-CUSTOMER GUARD
    // ========================================
    // Layered dedup pattern (Uber RAMEN / Stripe idempotency):
    //   Layer 1: Redis fast-path check below (catches 95%+ duplicates before DB)
    //   Layer 2: SERIALIZABLE TX further down is the real guard (correctness)
    // The Redis check is intentionally OUTSIDE the TX for performance —
    // if Redis is degraded, the SERIALIZABLE TX alone is sufficient.
    const activeKey = `customer:active-broadcast:${customerId}`;
    const existingBroadcastId = await redisService.get(activeKey);
    if (existingBroadcastId) {
      throw new AppError(409, 'ORDER_ACTIVE_EXISTS', 'Request already in progress. Cancel it first.');
    }

    const lockKey = `customer-broadcast-create:${customerId}`;
    const lock = await redisService.acquireLock(lockKey, customerId, 30);
    if (!lock.acquired) {
      throw new AppError(409, 'ORDER_ACTIVE_EXISTS', 'Request already in progress. Cancel it first.');
    }
    // FIX-R2-6: Redis degradation guard — SERIALIZABLE TX below is the real dedup backstop
    if (redisService.isDegraded) {
      logger.warn('[LOCK] Redis degraded — booking dedup relies on SERIALIZABLE TX', { customerId, lockKey });
    }

    try {
      // ========================================
      // SERVER-GENERATED IDEMPOTENCY (double-tap / retry protection)
      // ========================================
      const idempotencyFingerprint = [
        customerId,
        data.vehicleType,
        data.vehicleSubtype || '',
        roundCoord(data.pickup.coordinates.latitude),
        roundCoord(data.pickup.coordinates.longitude),
        roundCoord(data.drop.coordinates.latitude),
        roundCoord(data.drop.coordinates.longitude),
        String(data.trucksNeeded),
        String(data.pricePerTruck)
      ].join(':');
      const idempotencyHash = crypto.createHash('sha256').update(idempotencyFingerprint).digest('hex').substring(0, 32);
      const dedupeKey = `idem:broadcast:create:${customerId}:${idempotencyHash}`;

      const existingDedupeId = await redisService.get(dedupeKey);
      if (existingDedupeId) {
        const existingDedupeBooking = await db.getBookingById(existingDedupeId);
        if (existingDedupeBooking && !['cancelled', 'expired'].includes(existingDedupeBooking.status)) {
          logger.info('Idempotent replay: returning existing booking', { bookingId: existingDedupeId, idempotencyHash });
          const matchingTransporters = await db.getTransportersWithVehicleType(data.vehicleType);
          return {
            ...existingDedupeBooking,
            matchingTransportersCount: matchingTransporters.length,
            timeoutSeconds: Math.floor(BOOKING_CONFIG.TIMEOUT_MS / 1000)
          };
        }
      }

      // Get customer name
      const customer = await db.getUserById(customerId);
      const customerName = customer?.name || 'Customer';

      // ==========================================================================
      // SERVER-SIDE ROUTE DISTANCE (Google Directions API)
      // ==========================================================================
      // FIX P7: Moved BEFORE fare check so we validate against server-authoritative
      // distance (Google-verified), not the client-supplied distance which could be
      // manipulated or inaccurate (Haversine instead of road distance).
      // Falls back to customer value if Google fails — never blocks bookings.
      // ==========================================================================
      const clientDistanceKm = data.distanceKm;
      let distanceSource: 'google' | 'client_fallback' = 'client_fallback';

      try {
        const pickupCoords = data.pickup.coordinates;
        const dropCoords = data.drop.coordinates;

        if (pickupCoords && dropCoords) {
          // Truck mode: OFF by default. When FF_TRUCK_MODE_ROUTING=true,
          // heavy vehicles avoid highways/tolls for truck-accurate routing.
          const FF_TRUCK_MODE_ROUTING = process.env.FF_TRUCK_MODE_ROUTING === 'true';
          const HEAVY_VEHICLE_TYPES = new Set(['open', 'container', 'tipper', 'flatbed']);
          const useTruckMode = FF_TRUCK_MODE_ROUTING && HEAVY_VEHICLE_TYPES.has(data.vehicleType);

          const googleRoute = await googleMapsService.calculateRoute(
            [
              { lat: pickupCoords.latitude, lng: pickupCoords.longitude },
              { lat: dropCoords.latitude, lng: dropCoords.longitude }
            ],
            useTruckMode
          );

          if (googleRoute && googleRoute.distanceKm > 0) {
            data.distanceKm = googleRoute.distanceKm;
            distanceSource = 'google';

            const deltaPercent = clientDistanceKm > 0
              ? Math.round(((googleRoute.distanceKm - clientDistanceKm) / clientDistanceKm) * 100)
              : 0;

            logger.info('[BOOKING] Route distance calculated via Google Directions', {
              distanceSource: 'google',
              clientDistanceKm,
              serverDistanceKm: googleRoute.distanceKm,
              deltaPercent: `${deltaPercent}%`,
              durationMinutes: googleRoute.durationMinutes,
              ...(Math.abs(deltaPercent) > 200 ? { distanceAnomaly: true } : {})
            });
          } else {
            logger.warn('[BOOKING] Google Directions returned null/zero — will run Haversine check', {
              clientDistanceKm, reason: 'google_returned_empty'
            });
          }
        }
      } catch (routeError: any) {
        logger.warn('[BOOKING] Google Directions failed — will run Haversine check', {
          clientDistanceKm, error: (routeError as Error).message
        });
      }

      // FIX-R2-3: Haversine sanity check for ALL non-Google paths (covers both null-return AND exception)
      if (distanceSource === 'client_fallback') {
        const haversineKm = haversineDistanceKm(
          data.pickup.coordinates.latitude, data.pickup.coordinates.longitude,
          data.drop.coordinates.latitude, data.drop.coordinates.longitude
        );
        if (haversineKm > 0 && Math.abs(data.distanceKm - haversineKm) / haversineKm > 0.5) {
          logger.warn('[BOOKING] Client distance differs >50% from Haversine — using Haversine', {
            clientKm: data.distanceKm, haversineKm, roadEstimate: Math.ceil(haversineKm * 1.3)
          });
          data.distanceKm = Math.ceil(haversineKm * 1.3);
        }
      }

      // ========================================
      // SERVER-SIDE FARE SANITY CHECK (uses server-verified distance)
      // ========================================
      // FIX P7: Now runs AFTER Google distance calc so we use the server-authoritative
      // distance (data.distanceKm is now Google-verified or client fallback).
      // Prevents financial exploits (e.g., ₹1 per truck for 200km)
      // Uses env-configurable floor: MIN_FARE_PER_KM (default ₹8/km)
      // Tolerance: FARE_TOLERANCE (default 0.5 = 50% below estimate)
      // Formula: reject if pricePerTruck < max(500, distKm × minRate × tolerance)
      const _rawMFPK = parseInt(process.env.MIN_FARE_PER_KM || '8', 10);
      const MIN_FARE_PER_KM = isNaN(_rawMFPK) ? 8 : _rawMFPK;
      const _rawFT = parseFloat(process.env.FARE_TOLERANCE || '0.5');
      const FARE_TOLERANCE = isNaN(_rawFT) ? 0.5 : _rawFT;
      const fareCheckDistanceKm = data.distanceKm; // Google-verified or client fallback
      const estimatedMinFare = Math.max(500, Math.round(fareCheckDistanceKm * MIN_FARE_PER_KM * FARE_TOLERANCE));
      if (data.pricePerTruck < estimatedMinFare) {
        throw new AppError(400, 'FARE_TOO_LOW',
          `Price ₹${data.pricePerTruck} is below minimum ₹${estimatedMinFare} for ${fareCheckDistanceKm}km trip`);
      }

      // Calculate expiry based on config timeout
      const expiresAt = new Date(Date.now() + BOOKING_CONFIG.TIMEOUT_MS).toISOString();

      // ========================================
      // PROGRESSIVE RADIUS SEARCH (Requirement 6)
      // Step 1: Start with smallest radius (10km)
      // If no one accepts, expiry checker expands every 15s
      // ========================================
      const vehicleKey = generateVehicleKey(data.vehicleType, data.vehicleSubtype);
      const step1 = RADIUS_EXPANSION_CONFIG.steps[0];

      // Step 1 search: H3 primary → GEORADIUS fallback → Google ETA → Haversine
      const step1Candidates = await progressiveRadiusMatcher.findCandidates({
        pickupLat: data.pickup.coordinates.latitude,
        pickupLng: data.pickup.coordinates.longitude,
        vehicleType: data.vehicleType,
        vehicleSubtype: data.vehicleSubtype || '',
        stepIndex: 0,
        alreadyNotified: new Set(),
        limit: RADIUS_EXPANSION_CONFIG.maxTransportersPerStep
      });
      let nearbyTransporters = step1Candidates.map(c => c.transporterId);

      logger.info(`📍 [RADIUS STEP 1/${RADIUS_EXPANSION_CONFIG.steps.length}] Found ${nearbyTransporters.length} transporters within ${step1.radiusKm}km for ${vehicleKey}`);

      // Fallback: If no nearby online transporters at step 1, get ALL transporters from DB
      // This ensures we still broadcast even if no one has sent heartbeats recently
      let matchingTransporters: string[];
      let skipProgressiveExpansion = false;  // DB fallback already covers everyone
      if (nearbyTransporters.length > 0) {
        matchingTransporters = nearbyTransporters;
        logger.info(`🎯 Using PROXIMITY-BASED matching (${nearbyTransporters.length} nearby at ${step1.radiusKm}km)`);
      } else {
        const allDbTransporters = await db.getTransportersWithVehicleType(data.vehicleType);
        // Cap at 100 to prevent unbounded fan-out — covers all realistic online counts
        matchingTransporters = (await transporterOnlineService.filterOnline(allDbTransporters)).slice(0, 100);
        skipProgressiveExpansion = true;  // DB fallback already notified all — no radius expansion needed
        logger.info(`📋 Fallback to DATABASE matching (${allDbTransporters.length} total, ${matchingTransporters.length} online) — skipping progressive expansion`);

        // Load transporter locations from Redis → calculate road distance + ETA
        // Uses directionsApiService (Redis cache → Google Distance Matrix → Haversine)
        if (matchingTransporters.length > 0) {
          try {
            const detailsMap = await availabilityService.loadTransporterDetailsMap(matchingTransporters);
            const origins: Array<{ lat: number; lng: number; id: string }> = [];

            for (const tid of matchingTransporters) {
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
                data.pickup.coordinates.latitude,
                data.pickup.coordinates.longitude
              );

              for (const origin of origins) {
                const eta = etaResults.get(origin.id);
                if (eta) {
                  step1Candidates.push({
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
          } catch (err: any) {
            logger.warn(`⚠️ Failed to calculate ETA for DB fallback: ${err.message}`);
            // Last-resort haversine fallback if directionsApiService completely fails
            try {
              const detailsMap = await availabilityService.loadTransporterDetailsMap(matchingTransporters);
              for (const tid of matchingTransporters) {
                const details = detailsMap.get(tid);
                if (details) {
                  const lat = parseFloat(details.latitude);
                  const lng = parseFloat(details.longitude);
                  if (Number.isFinite(lat) && Number.isFinite(lng)) {
                    const distKm = haversineDistanceKm(
                      data.pickup.coordinates.latitude,
                      data.pickup.coordinates.longitude,
                      lat, lng
                    );
                    const etaSec = Math.round((distKm / 30) * 3600);
                    step1Candidates.push({
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
              logger.info(`📍 DB fallback: Haversine fallback for ${step1Candidates.length} transporters`);
            } catch (fallbackErr: any) {
              logger.warn(`⚠️ Haversine fallback also failed: ${fallbackErr.message}`);
            }
          }
        }

        // Fix D3/F-3-6: Distance cap on step 1 DB fallback — prevent nationwide broadcasts
        const MAX_STEP1_FALLBACK_RADIUS_KM = 200;
        const candidateDistanceMap = new Map<string, number>();
        for (const c of step1Candidates) {
          candidateDistanceMap.set(c.transporterId, c.distanceKm);
        }
        const beforeFilter = matchingTransporters.length;
        matchingTransporters = matchingTransporters.filter(tid => {
          const dist = candidateDistanceMap.get(tid);
          if (dist !== undefined) {
            return dist <= MAX_STEP1_FALLBACK_RADIUS_KM;
          }
          return true; // No distance data — include (haversine fallback may not have run)
        });
        if (matchingTransporters.length < beforeFilter) {
          logger.info(`[RADIUS] Step 1 DB fallback distance cap: ${beforeFilter} -> ${matchingTransporters.length} (filtered ${beforeFilter - matchingTransporters.length} beyond ${MAX_STEP1_FALLBACK_RADIUS_KM}km)`);
        }
      }

      logger.info(`╔══════════════════════════════════════════════════════════════╗`);
      logger.info(`║  🚛 NEW BOOKING REQUEST (Progressive Radius)                    ║`);
      logger.info(`╠══════════════════════════════════════════════════════════════╣`);
      logger.info(`║  Vehicle: ${data.vehicleType} - ${data.vehicleSubtype || 'Any'}`);
      logger.info(`║  Trucks Needed: ${data.trucksNeeded}`);
      logger.info(`║  Price/Truck: ₹${data.pricePerTruck}`);
      logger.info(`║  Distance: ${data.distanceKm} km`);
      logger.info(`║  Step 1 Radius: ${step1.radiusKm}km`);
      logger.info(`║  Matching Transporters (Step 1): ${matchingTransporters.length}`);
      logger.info(`║  Timeout: ${BOOKING_CONFIG.TIMEOUT_MS / 1000} seconds`);
      logger.info(`╚══════════════════════════════════════════════════════════════╝`);

      // ========================================
      // SERIALIZABLE TRANSACTION: DB check + create (TOCTOU-safe)
      // Prevents duplicate active bookings when Redis lock fails.
      // PostgreSQL serializable isolation aborts one transaction on conflict.
      // ========================================
      const bookingId = uuid();
      await withDbTimeout(async (tx) => {
        // DB authoritative check (covers Redis failure edge case)
        const existingBooking = await tx.booking.findFirst({
          where: { customerId, status: { in: [BookingStatus.created, BookingStatus.broadcasting, BookingStatus.active, BookingStatus.partially_filled] } }
        });
        const existingOrder = await tx.order.findFirst({
          where: { customerId, status: { in: ['created', 'broadcasting', 'active', 'partially_filled'] } }
        });
        if (existingBooking || existingOrder) {
          throw new AppError(409, 'ORDER_ACTIVE_EXISTS', 'Request already in progress. Cancel it first.');
        }

        // Create booking atomically with the check
        await tx.booking.create({
          data: {
            id: bookingId,
            customerId,
            customerName,
            customerPhone,
            pickup: {
              latitude: data.pickup.coordinates.latitude,
              longitude: data.pickup.coordinates.longitude,
              address: data.pickup.address,
              city: data.pickup.city,
              state: data.pickup.state
            } as Prisma.JsonObject,
            drop: {
              latitude: data.drop.coordinates.latitude,
              longitude: data.drop.coordinates.longitude,
              address: data.drop.address,
              city: data.drop.city,
              state: data.drop.state
            } as Prisma.JsonObject,
            vehicleType: data.vehicleType,
            vehicleSubtype: data.vehicleSubtype,
            trucksNeeded: data.trucksNeeded,
            trucksFilled: 0,
            distanceKm: data.distanceKm,
            pricePerTruck: data.pricePerTruck,
            totalAmount: Math.round(data.pricePerTruck * data.trucksNeeded * 100) / 100,
            goodsType: data.goodsType,
            weight: data.weight,
            status: BookingStatus.created,
            stateChangedAt: new Date(),
            // Cap at 200 to bound cancel/expire iteration (industry standard)
            notifiedTransporters: matchingTransporters.slice(0, 200),
            scheduledAt: data.scheduledAt,
            expiresAt
          }
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeoutMs: 8000 });

      // Fetch as BookingRecord (converts JSON fields + dates for downstream use)
      const booking = await db.getBookingById(bookingId);
      if (!booking) {
        throw new AppError(500, 'BOOKING_CREATE_FAILED', 'Failed to create booking');
      }

      // ========================================
      // SET ACTIVE-BROADCAST GUARD EARLY (before any broadcasts)
      // Moved here from after broadcasts to prevent race where a second
      // createBooking call slips in while broadcasts are still being sent.
      // ========================================
      // +30s buffer: safe margin after worst-case expiry delay (QA-validated)
      const earlyGuardTtl = Math.ceil(BOOKING_CONFIG.TIMEOUT_MS / 1000) + 30;
      await redisService.set(activeKey, booking.id, earlyGuardTtl);

      // Emit lifecycle state: created
      emitToUser(customerId, SocketEvent.BROADCAST_STATE_CHANGED, {
        bookingId: booking.id,
        status: 'created',
        stateChangedAt: new Date().toISOString()
      });

      // ========================================
      // HANDLE: No matching transporters found
      // ========================================
      if (matchingTransporters.length === 0) {
        logger.warn(`⚠️ NO TRANSPORTERS FOUND for ${data.vehicleType}`);

        // FIX-19: Cache the no-supply outcome before early return so dedupeKey is set
        try {
          await redisService.set(dedupeKey, JSON.stringify({ status: 'no_supply', bookingId: booking.id }), 86400);
        } catch { /* non-fatal */ }

        // Immediately notify customer
        emitToUser(customerId, SocketEvent.NO_VEHICLES_AVAILABLE, {
          bookingId: booking.id,
          vehicleType: data.vehicleType,
          vehicleSubtype: data.vehicleSubtype,
          message: `No ${data.vehicleType} vehicles available right now. Please try again later or select a different vehicle type.`,
          suggestion: 'search_again'
        });

        // Transition through broadcasting before expiring (created -> broadcasting -> expired)
        // This ensures state machine consistency even on the no-transporter path
        // FIX-R2-1: Conditional status write — only transition from 'created'
        await prismaClient.booking.updateMany({
          where: { id: booking.id, status: 'created' },
          data: { status: 'broadcasting', stateChangedAt: new Date() }
        });
        // Mark as expired immediately
        // FIX-R2-1: Conditional status write — only transition from created/broadcasting
        try {
          await prismaClient.booking.updateMany({
            where: { id: booking.id, status: { in: ['created', 'broadcasting'] } },
            data: { status: 'expired', stateChangedAt: new Date() }
          });
        } catch (err: any) {
          logger.error('[BOOKING] Failed to mark booking as expired (no transporters)', { bookingId: booking.id, error: err.message });
        }

        return {
          ...booking,
          status: 'expired',
          matchingTransportersCount: 0,
          timeoutSeconds: 0
        };
      }

      // ========================================
      // BROADCAST TO ALL MATCHING TRANSPORTERS
      // ========================================
      // FIX-18: Wrap broadcast section in try-catch — expire orphaned booking on failure
      try {
      // IMPORTANT: Include broadcastId AND orderId for Captain app compatibility
      // Captain app's SocketIOService checks broadcastId first, then orderId
      //
      // Per-transporter pickup distance: Build a lookup map from candidates.
      // Each transporter gets their OWN pickupDistanceKm and pickupEtaMinutes.
      const candidateMap = new Map<string, { distanceKm: number; etaSeconds: number }>();
      for (const c of step1Candidates) {
        candidateMap.set(c.transporterId, { distanceKm: c.distanceKm || 0, etaSeconds: c.etaSeconds || 0 });
      }

      // Fill gap: Transporters in matchingTransporters but not in candidateMap
      // (happens when Redis has no location for a DB-fallback transporter)
      // Use -1 as sentinel → broadcast helper renders "nearby" instead of "0 km"
      let locationGapCount = 0;
      for (const tid of matchingTransporters) {
        if (!candidateMap.has(tid)) {
          candidateMap.set(tid, { distanceKm: -1, etaSeconds: 0 });
          locationGapCount++;
        }
      }
      if (locationGapCount > 0) {
        logger.warn(`📊 [PICKUP_GAP] ${locationGapCount} transporter(s) have no location data — pickup distance unknown`);
      }


      // H-19 FIX: Cap notified transporters to prevent FCM throttling and latency spikes
      const MAX_BROADCAST_TRANSPORTERS = parseInt(process.env.MAX_BROADCAST_TRANSPORTERS || '100', 10);
      const cappedTransporters = matchingTransporters.length > MAX_BROADCAST_TRANSPORTERS
        ? (() => {
            logger.info(`[Broadcast] Capping ${matchingTransporters.length} -> ${MAX_BROADCAST_TRANSPORTERS} transporters`);
            return matchingTransporters.slice(0, MAX_BROADCAST_TRANSPORTERS);
          })()
        : matchingTransporters;

      logger.info(`📢 Broadcasting to ${cappedTransporters.length} transporters for ${data.vehicleType} ${data.vehicleSubtype || ''} (Radius Step 1: ${step1.radiusKm}km)`);

      // H-10 FIX: Route through queue for guaranteed delivery when available
      const useQueue = process.env.FF_SEQUENCE_DELIVERY_ENABLED === 'true'
        && queueService && typeof queueService.queueBroadcast === 'function';

      // Phase 3 optimization: No per-transporter DB queries in broadcast loop.
      // filterOnline() already guarantees all transporters are online.
      // M-23 FIX: Check booking status every N transporters to stop broadcasting after cancel
      const BOOKING_STATUS_CHECK_INTERVAL = Math.max(
        5,
        parseInt(process.env.BROADCAST_STATUS_CHECK_INTERVAL || '20', 10) || 20
      );
      let bookingBroadcastIdx = 0;
      for (const transporterId of cappedTransporters) {
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
        const candidate = candidateMap.get(transporterId);
        // Math.max(0, ...) clamps -1 sentinel (unknown location) to 0
        const pickupDistKm = candidate ? Math.max(0, Math.round(candidate.distanceKm * 10) / 10) : 0;
        const pickupEtaMin = candidate ? Math.max(0, Math.ceil(candidate.etaSeconds / 60)) : 0;

        const broadcastPayload = buildBroadcastPayload(booking, {
          timeoutSeconds: BOOKING_CONFIG.TIMEOUT_MS / 1000,
          trucksFilled: 0,
          pickupDistanceKm: pickupDistKm,
          pickupEtaMinutes: pickupEtaMin,
          pickupEtaSeconds: candidate ? Math.max(0, candidate.etaSeconds) : 0
        });

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
      // Fix B1: State machine ENFORCED -- invalid transitions throw, CAS guard is the race-condition safety net
      assertValidTransition('Booking', BOOKING_VALID_TRANSITIONS, booking.status, 'broadcasting');
      // FIX-R2-1: Conditional status write — only transition from 'created'
      try {
        await prismaClient.booking.updateMany({
          where: { id: booking.id, status: 'created' },
          data: { status: 'broadcasting', stateChangedAt: new Date() }
        });
      } catch (err: any) {
        logger.error('[BOOKING] Failed to update status to broadcasting', { bookingId: booking.id, error: err.message });
      }
      emitToUser(customerId, SocketEvent.BROADCAST_STATE_CHANGED, {
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
      if (matchingTransporters.length > 0) {
        const notifiedSetKey = RADIUS_KEYS.NOTIFIED_SET(booking.id);
        const ttlSeconds = Math.ceil(BOOKING_CONFIG.TIMEOUT_MS / 1000) + 120;
        try {
          // FIX #21: Atomic SADD + EXPIRE via Lua script (LINE Engineering pattern).
          // Prevents orphaned sets without TTL if crash occurs between separate calls.
          await redisService.sAddWithExpire(notifiedSetKey, ttlSeconds, ...matchingTransporters);
        } catch (e: any) {
          // Retry once — incomplete notified set causes duplicate broadcasts on radius expansion
          logger.warn('[RADIUS] sAddWithExpire failed, retrying once', { bookingId: booking.id, error: e.message });
          await redisService.sAddWithExpire(notifiedSetKey, ttlSeconds, ...matchingTransporters).catch((retryErr: any) => {
            logger.error('[RADIUS] Failed to track notified transporters after retry — radius expansion may send duplicate broadcasts (safe: accept is idempotent)', {
              bookingId: booking.id, error: retryErr.message, transporterCount: matchingTransporters.length
            });
          });
        }
      }

      // ========================================
      // SEND FCM PUSH NOTIFICATIONS (for app in background)
      // ========================================
      // Fix E6: Only send FCM to transporters NOT connected via socket
      // H-19: Use cappedTransporters (already capped above) for FCM too
      const offlineTransporters = cappedTransporters.filter(tid => !isUserConnected(tid));
      if (offlineTransporters.length > 0) {
        fcmService.notifyNewBroadcast(offlineTransporters, {
          broadcastId: booking.id,
          customerName: booking.customerName,
          vehicleType: booking.vehicleType,
          trucksNeeded: booking.trucksNeeded,
          farePerTruck: booking.pricePerTruck,
          pickupCity: booking.pickup.city,
          dropCity: booking.drop.city,
          // Fix E3: Pass additional fields for background decision-making
          pickupAddress: booking.pickup.address,
          dropAddress: booking.drop.address,
          distanceKm: booking.distanceKm,
          vehicleSubtype: booking.vehicleSubtype,
          expiresAt: booking.expiresAt
        }).then(sentCount => {
          // FIX-23: Escalate to warn when 0 FCM notifications delivered
          if (sentCount === 0) {
            logger.warn('[Booking] All transporters offline — 0 FCM notifications sent', {
              bookingId: booking.id,
              offlineCount: offlineTransporters.length,
              totalTransporters: cappedTransporters.length,
            });
          } else {
            logger.info(`📱 FCM: Push notifications sent to ${sentCount}/${offlineTransporters.length} offline transporters (${cappedTransporters.length - offlineTransporters.length} connected via socket)`);
          }

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
        }).catch(err => {
          logger.warn('📱 FCM: Failed to send push notifications', err);
        });
      } else {
        logger.info(`📱 FCM: All ${cappedTransporters.length} transporters connected via socket -- skipping FCM`);
      }
      } catch (broadcastErr) {
        // FIX-18: Broadcast failed — expire orphaned booking so it doesn't hang forever
        logger.error('[Booking] Broadcast failed — expiring orphaned booking', {
          bookingId: booking.id,
          error: broadcastErr instanceof Error ? broadcastErr.message : String(broadcastErr),
        });
        await prismaClient.booking.update({
          where: { id: booking.id },
          data: { status: 'expired', stateChangedAt: new Date() },
        }).catch(expireErr => logger.error('[Booking] Failed to expire orphaned booking', { bookingId: booking.id, error: String(expireErr) }));
        throw broadcastErr;
      }

      // ========================================
      // START TIMEOUT TIMER
      // ========================================
      this.startBookingTimeout(booking.id, customerId);

      // Transition: broadcasting -> active (timer started, awaiting responses)
      // Fix B1: State machine ENFORCED -- invalid transitions throw
      assertValidTransition('Booking', BOOKING_VALID_TRANSITIONS, 'broadcasting', 'active');
      // FIX-R2-1: Conditional status write — only transition from 'broadcasting'
      try {
        await prismaClient.booking.updateMany({
          where: { id: booking.id, status: 'broadcasting' },
          data: { status: 'active', stateChangedAt: new Date() }
        });
      } catch (err: any) {
        logger.error('[BOOKING] Failed to update status to active', { bookingId: booking.id, error: err.message });
      }
      emitToUser(customerId, SocketEvent.BROADCAST_STATE_CHANGED, {
        bookingId: booking.id,
        status: 'active',
        stateChangedAt: new Date().toISOString()
      });

      // ========================================
      // START PROGRESSIVE RADIUS EXPANSION (Requirement 6)
      // Schedule step 2 to trigger after step 1 timeout
      // SKIP if DB fallback was used (all transporters already notified)
      // ========================================
      if (!skipProgressiveExpansion) {
        this.startProgressiveExpansion(booking.id, customerId, vehicleKey,
          data.vehicleType, data.vehicleSubtype || '',
          data.pickup.coordinates.latitude, data.pickup.coordinates.longitude);
      } else {
        logger.info(`[RADIUS] Skipping progressive expansion — DB fallback already covered all transporters`);
      }

      logger.info(`✅ Booking ${booking.id} created, ${matchingTransporters.length} transporters notified (step 1/${RADIUS_EXPANSION_CONFIG.steps.length})`);

      // SCALABILITY: Store idempotency key to prevent duplicate bookings
      if (idempotencyKey) {
        const cacheKey = `idempotency:booking:${customerId}:${idempotencyKey}`;
        // Store for 24 hours (TTL in seconds)
        await redisService.set(cacheKey, booking.id, 24 * 60 * 60);
        // Also store a 'latest' pointer so cancelBooking can find the exact key to delete
        // without using KEYS pattern scan (which fails on ElastiCache Serverless)
        await redisService.set(`idempotency:booking:${customerId}:latest`, idempotencyKey, 24 * 60 * 60);
        logger.info(`🔒 Idempotency key stored for booking ${booking.id}`, { idempotencyKey });
      }

      // NOTE: activeKey SET after DB commit is intentional — SERIALIZABLE TX is the real
      // dedup guard. This Redis key is a fast-path optimization, not the source of truth.
      // Store server-generated idempotency key
      const bookingTimeoutSeconds = Math.ceil(BOOKING_CONFIG.TIMEOUT_MS / 1000);
      await redisService.set(dedupeKey, booking.id, bookingTimeoutSeconds + 30);
      await redisService.set(`idem:broadcast:latest:${customerId}`, dedupeKey, bookingTimeoutSeconds + 30);

      // NOTE: activeKey already set early (right after booking creation, before broadcasts)

      return {
        ...booking,
        matchingTransportersCount: matchingTransporters.length,
        timeoutSeconds: BOOKING_CONFIG.TIMEOUT_MS / 1000
      };
    } finally {
      await redisService.releaseLock(lockKey, customerId).catch((err: any) => {
        logger.warn('Failed to release customer broadcast lock', { customerId, error: err.message });
      });
    }
    } finally {
      // FIX A5#27: Only decrement if we successfully incremented (QA-8 fix)
      if (incremented) {
        await redisService.incrBy(concurrencyKey, -1).catch(() => {});
      }
    }
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
  private async startBookingTimeout(bookingId: string, customerId: string): Promise<void> {
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

  /**
   * Handle booking timeout - called when timer expires
   * Made public for the expiry checker to call
   */
  async handleBookingTimeout(bookingId: string, customerId: string): Promise<void> {
    const booking = await db.getBookingById(bookingId);

    if (!booking) {
      logger.warn(`Booking ${bookingId} not found for timeout handling`);
      return;
    }

    // #18 -- Explicit status assertions: skip terminal states
    if (['fully_filled', 'completed', 'cancelled'].includes(booking.status)) {
      logger.info(`Booking ${bookingId} already ${booking.status}, skipping timeout`);
      this.clearBookingTimers(bookingId);
      return;
    }

    // #18 -- Log and skip unexpected states (safety guard)
    const EXPECTED_TIMEOUT_STATES = ['broadcasting', 'active', 'partially_filled', 'created'];
    if (!EXPECTED_TIMEOUT_STATES.includes(booking.status)) {
      logger.warn('[BOOKING] Timeout for booking in unexpected status', { bookingId, status: booking.status });
      return;
    }

    logger.info(`⏰ TIMEOUT: Booking ${bookingId} expired`);

    // State machine validation for timeout -> expired transition (warn-only)
    try {
      assertValidTransition('Booking', BOOKING_VALID_TRANSITIONS, booking.status, 'expired');
    } catch (e) {
      logger.warn('[BOOKING] Invalid state transition attempted', {
        bookingId, from: booking.status, to: 'expired', error: (e as Error).message
      });
    }

    // Check if partially filled
    if (booking.trucksFilled > 0 && booking.trucksFilled < booking.trucksNeeded) {
      // Partially filled - notify customer
      // FIX-R2-2: Conditional status write — only expire from active-like states
      try {
        await prismaClient.booking.updateMany({
          where: { id: bookingId, status: { in: ['broadcasting', 'active', 'partially_filled', 'created'] } },
          data: { status: 'expired', stateChangedAt: new Date() }
        });
      } catch (err: any) {
        logger.error('[BOOKING] Failed to expire partially filled booking', { bookingId, error: err.message });
      }

      emitToUser(customerId, SocketEvent.BOOKING_EXPIRED, {
        bookingId,
        status: 'partially_filled_expired',
        trucksNeeded: booking.trucksNeeded,
        trucksFilled: booking.trucksFilled,
        message: `Only ${booking.trucksFilled} of ${booking.trucksNeeded} trucks were assigned. Would you like to continue with partial fulfillment or search again?`,
        options: ['continue_partial', 'search_again', 'cancel']
      });
      // Also emit order_expired for customer app compatibility
      emitToUser(customerId, 'order_expired', {
        bookingId,
        status: 'partially_filled_expired',
        trucksNeeded: booking.trucksNeeded,
        trucksFilled: booking.trucksFilled,
        message: `Only ${booking.trucksFilled} of ${booking.trucksNeeded} trucks were assigned. Would you like to continue with partial fulfillment or search again?`,
        options: ['continue_partial', 'search_again', 'cancel']
      });

      // Also notify via booking room
      emitToBooking(bookingId, SocketEvent.BOOKING_EXPIRED, {
        bookingId,
        status: 'partially_filled_expired',
        trucksFilled: booking.trucksFilled
      });

    } else if (booking.trucksFilled === 0) {
      // No trucks filled - "No vehicle available"
      // FIX-R2-2: Conditional status write — only expire from active-like states
      try {
        await prismaClient.booking.updateMany({
          where: { id: bookingId, status: { in: ['broadcasting', 'active', 'partially_filled', 'created'] } },
          data: { status: 'expired', stateChangedAt: new Date() }
        });
      } catch (err: any) {
        logger.error('[BOOKING] Failed to expire unfilled booking', { bookingId, error: err.message });
      }

      emitToUser(customerId, SocketEvent.NO_VEHICLES_AVAILABLE, {
        bookingId,
        vehicleType: booking.vehicleType,
        vehicleSubtype: booking.vehicleSubtype,
        message: `No ${booking.vehicleType} available right now. We'll help you find alternatives.`,
        suggestion: 'search_again',
        options: ['search_again', 'try_different_vehicle', 'cancel']
      });

      emitToBooking(bookingId, SocketEvent.BOOKING_EXPIRED, {
        bookingId,
        status: 'expired',
        trucksFilled: 0
      });
    }

    // Clear timers
    this.clearBookingTimers(bookingId);

    // Clear customer active broadcast key (one-per-customer enforcement)
    await this.clearCustomerActiveBroadcast(customerId);

    // Notify all transporters that this broadcast is no longer available
    // WebSocket (for apps in foreground)
    for (const transporterId of booking.notifiedTransporters) {
      emitToUser(transporterId, SocketEvent.BOOKING_EXPIRED, {
        bookingId,
        orderId: bookingId,
        broadcastId: bookingId,
        reason: 'timeout',
        message: 'This booking request has expired',
        customerName: booking.customerName
      });
    }

    // ========================================
    // FCM PUSH: Notify transporters of expiry (for apps in background)
    // ========================================
    // SCALABILITY: Queued via queueService — reliable with retry
    // EASY UNDERSTANDING: Transporters need to clear this booking from their UI
    // MODULARITY: Fire-and-forget, doesn't block timeout handling
    if (booking.notifiedTransporters.length > 0) {
      queueService.queuePushNotificationBatch(
        booking.notifiedTransporters,
        {
          title: '⏰ Booking Expired',
          body: `${booking.vehicleType} booking request has expired`,
          data: {
            type: 'booking_expired',
            bookingId,
            vehicleType: booking.vehicleType
          }
        }
      ).catch(err => {
        logger.warn(`FCM: Failed to queue expiry push for booking ${bookingId}`, err);
      });
    }
  }

  /**
   * Clear all timers for a booking (Redis-based)
   * Also cleans up progressive radius expansion keys
   */
  private async clearCustomerActiveBroadcast(customerId: string): Promise<void> {
    const activeKey = `customer:active-broadcast:${customerId}`;
    const latestIdemKey = await redisService.get(`idem:broadcast:latest:${customerId}`).catch(() => null);

    // Delete all keys in parallel (reduces 4 sequential Redis calls to 1 round-trip)
    const delPromises: Promise<unknown>[] = [
      redisService.del(activeKey).catch((err: any) => {
        logger.warn('Failed to clear customer active broadcast key', { customerId, error: err.message });
      }),
      redisService.del(`idem:broadcast:latest:${customerId}`).catch(() => { })
    ];
    if (latestIdemKey) {
      delPromises.push(redisService.del(latestIdemKey).catch(() => { }));
    }
    await Promise.all(delPromises);
  }

  private async clearBookingTimers(bookingId: string): Promise<void> {
    await Promise.all([
      redisService.cancelTimer(TIMER_KEYS.BOOKING_EXPIRY(bookingId)),
      redisService.cancelTimer(TIMER_KEYS.RADIUS_STEP(bookingId)),
      redisService.del(RADIUS_KEYS.CURRENT_STEP(bookingId)).catch(() => { }),
      redisService.del(RADIUS_KEYS.NOTIFIED_SET(bookingId)).catch(() => { }),
    ]);
  }

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
  private async startProgressiveExpansion(
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
    await redisService.setTimer(TIMER_KEYS.RADIUS_STEP(bookingId), timerData, expiresAt);

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
    const newTransporters = expandedCandidates.map(c => c.transporterId);

    logger.info(`[RADIUS STEP ${nextStepIndex + 1}] Found ${expandedCandidates.length} candidates, ${newTransporters.length} NEW transporters`);

    // Broadcast to new transporters only (with per-transporter pickup distance)
    if (newTransporters.length > 0) {
      const now = new Date();
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

      // Also update the booking's notified list in DB
      const allNotified = [...(booking.notifiedTransporters || []), ...newTransporters];
      // Cap at 200 to bound cancel/expire iteration (industry standard)
      const uniqueNotified = [...new Set(allNotified)].slice(0, 200);
      try {
        await db.updateBooking(data.bookingId, { notifiedTransporters: uniqueNotified });
      } catch (err: any) {
        logger.error('[RADIUS] Failed to update notifiedTransporters', { bookingId: data.bookingId, error: err.message });
      }

      // TODO: refactor to use fcmService.sendWithRetry when notifyNewBroadcast is decomposed
      fcmService.notifyNewBroadcast(newTransporters, {
        broadcastId: booking.id,
        customerName: booking.customerName,
        vehicleType: booking.vehicleType,
        trucksNeeded: booking.trucksNeeded - booking.trucksFilled,
        farePerTruck: booking.pricePerTruck,
        pickupCity: booking.pickup.city,
        dropCity: booking.drop.city
      }).catch(() => { });

      logger.info(`[RADIUS STEP ${nextStepIndex + 1}] ✅ Broadcast to ${newTransporters.length} NEW transporters at ${step.radiusKm}km`);
    }

    // Schedule next step
    if (nextStepIndex + 1 < totalSteps) {
      const nextTimerData: RadiusStepTimerData = {
        ...data,
        currentStep: nextStepIndex
      };
      const nextExpiresAt = new Date(Date.now() + step.timeoutMs);
      await redisService.setTimer(TIMER_KEYS.RADIUS_STEP(data.bookingId), nextTimerData, nextExpiresAt);
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
      await redisService.setTimer(TIMER_KEYS.RADIUS_STEP(data.bookingId), finalTimerData, finalExpiresAt);
    }
  }

  /**
   * DB fallback after all progressive radius steps are exhausted.
   * Queries ALL transporters with matching vehicle type from DB.
   */
  private async radiusDbFallback(booking: BookingRecord, data: RadiusStepTimerData): Promise<void> {
    const allDbTransporters = await db.getTransportersWithVehicleType(booking.vehicleType);
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
    } catch (err: any) {
      logger.warn(`[RADIUS] DB fallback distance calc failed: ${err.message} — broadcasting with haversine estimates`);
    }

    // Fix D2/F-3-5: Filter out transporters beyond 200km to prevent nationwide broadcasts
    const MAX_FALLBACK_RADIUS_KM = 200;
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
    } catch (err: any) {
      logger.error('[RADIUS] Failed to update notifiedTransporters (DB fallback)', { bookingId: data.bookingId, error: err.message });
    }

    // TODO: refactor to use fcmService.sendWithRetry when notifyNewBroadcast is decomposed
    fcmService.notifyNewBroadcast(distanceFilteredTransporters, {
      broadcastId: booking.id,
      customerName: booking.customerName,
      vehicleType: booking.vehicleType,
      trucksNeeded: booking.trucksNeeded - booking.trucksFilled,
      farePerTruck: booking.pricePerTruck,
      pickupCity: booking.pickup.city,
      dropCity: booking.drop.city
    }).catch(() => { });

    logger.info(`[RADIUS] DB fallback delivered to ${distanceFilteredTransporters.length} transporters (${candidateMap.size} with road distance)`);
  }

  /**
   * Clean up radius expansion keys (separate from booking timers)
   */
  private async clearRadiusKeys(bookingId: string): Promise<void> {
    await Promise.all([
      redisService.cancelTimer(TIMER_KEYS.RADIUS_STEP(bookingId)),
      redisService.del(RADIUS_KEYS.CURRENT_STEP(bookingId)).catch(() => { }),
      redisService.del(RADIUS_KEYS.NOTIFIED_SET(bookingId)).catch(() => { }),
    ]);
  }

  /**
   * Cancel booking timeout (called when fully filled)
   */
  async cancelBookingTimeout(bookingId: string): Promise<void> {
    await this.clearBookingTimers(bookingId);
    logger.info(`⏱️ Timeout cancelled for booking ${bookingId}`);
  }

  // ==========================================================================
  // GET BOOKINGS
  // ==========================================================================

  /**
   * Get customer's bookings
   */
  async getCustomerBookings(
    customerId: string,
    query: GetBookingsQuery
  ): Promise<{ bookings: BookingRecord[]; total: number; hasMore: boolean }> {
    let bookings = await db.getBookingsByCustomer(customerId);

    // Filter by status
    if (query.status) {
      bookings = bookings.filter(b => b.status === query.status);
    }

    // Sort by newest first
    bookings.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = bookings.length;

    // Pagination
    const start = (query.page - 1) * query.limit;
    bookings = bookings.slice(start, start + query.limit);

    return {
      bookings,
      total,
      hasMore: start + bookings.length < total
    };
  }

  /**
   * Get active broadcasts for a transporter
   * ONLY returns bookings where transporter has matching trucks!
   */
  async getActiveBroadcasts(
    transporterId: string,
    query: GetBookingsQuery
  ): Promise<{ bookings: BookingRecord[]; total: number; hasMore: boolean }> {
    // Get bookings that match this transporter's vehicle types
    let bookings = await db.getActiveBookingsForTransporter(transporterId);

    // Only show active/partially filled and not expired
    // Fix E5: Filter out bookings past their expiresAt even if status not yet updated
    const now = new Date();
    bookings = bookings.filter(b =>
      (b.status === 'active' || b.status === 'partially_filled')
      && (!b.expiresAt || new Date(b.expiresAt) > now)
    );

    // Sort by newest first
    bookings.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = bookings.length;

    // Pagination
    // FIX F-4-1: Add page param for reconnect broadcasts
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const start = (page - 1) * limit;
    bookings = bookings.slice(start, start + limit);

    logger.info(`Transporter ${transporterId} can see ${total} matching bookings`);

    return {
      bookings,
      total,
      hasMore: start + bookings.length < total
    };
  }

  /**
   * Get booking by ID
   */
  async getBookingById(
    bookingId: string,
    userId: string,
    userRole: string
  ): Promise<BookingRecord> {
    const booking = await db.getBookingById(bookingId);

    if (!booking) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }

    // Access control
    if (userRole === 'customer' && booking.customerId !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied');
    }

    // Transporters can only see if they have matching vehicles
    if (userRole === 'transporter') {
      const transporterVehicles = await db.getVehiclesByTransporter(userId);
      const hasMatchingVehicle = transporterVehicles.some(
        v => v.vehicleType === booking.vehicleType && v.isActive
      );

      if (!hasMatchingVehicle) {
        // 4 PRINCIPLES: Business logic error (insufficient vehicles)
        throw new AppError(403, ErrorCode.VEHICLE_INSUFFICIENT, 'You do not have matching vehicles for this booking');
      }
    }

    return booking;
  }

  /**
   * Get assigned trucks for a booking
   */
  async getAssignedTrucks(
    bookingId: string,
    userId: string,
    userRole: string
  ): Promise<any[]> {
    const booking = await db.getBookingById(bookingId);

    if (!booking) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }

    // Verify access
    if (userRole === 'customer' && booking.customerId !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied');
    }

    // Get assignments for this booking
    const assignments = await db.getAssignmentsByBooking(bookingId);

    // Batch fetch driver ratings — single query, no N+1
    const driverIds: string[] = assignments.map(a => String(a.driverId || '')).filter(id => id.length > 0);
    const uniqueDriverIds = [...new Set(driverIds)];
    let driverRatingsMap: Map<string, { avg: number | null, total: number }> = new Map();
    if (uniqueDriverIds.length > 0) {
      try {
        const drivers = await prismaClient.user.findMany({
          where: { id: { in: uniqueDriverIds } },
          select: { id: true, avgRating: true, totalRatings: true }
        });
        drivers.forEach(d => driverRatingsMap.set(d.id, { avg: d.avgRating, total: d.totalRatings }));
      } catch (err) {
        // Graceful fallback — don't block tracking if rating query fails
        logger.warn('[BOOKING] Failed to fetch driver ratings, falling back', { error: (err as Error).message });
      }
    }

    return assignments.map(a => {
      const driverRatingData = driverRatingsMap.get(a.driverId);
      return {
        assignmentId: a.id,
        tripId: a.tripId,
        vehicleNumber: a.vehicleNumber,
        vehicleType: a.vehicleType,
        driverName: a.driverName,
        driverPhone: a.driverPhone,
        driverProfilePhotoUrl: a.driverProfilePhotoUrl || null,
        driverRating: driverRatingData?.avg ?? null,     // Real avg rating from DB (null = new driver)
        driverTotalRatings: driverRatingData?.total ?? 0, // How many ratings
        customerRating: a.customerRating ?? null,          // This customer's rating for this trip
        status: a.status,
        assignedAt: a.assignedAt,
        currentLocation: a.currentLocation || null
      };
    });
  }

  // ==========================================================================
  // UPDATE BOOKING
  // ==========================================================================

  /**
   * Cancel booking — atomic, idempotent, race-safe
   *
   * Uses updateMany with status precondition to prevent cancel-vs-accept races.
   * Already-cancelled bookings return success (idempotent).
   */
  async cancelBooking(bookingId: string, customerId: string): Promise<BookingRecord> {
    // Idempotent — safe to call even if timers don't exist yet.
    await this.clearBookingTimers(bookingId).catch(() => { });

    // Pre-flight: fetch booking for ownership check and idempotency
    const preflight = await db.getBookingById(bookingId);
    if (!preflight) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }
    if (preflight.customerId !== customerId) {
      throw new AppError(403, 'FORBIDDEN', 'You can only cancel your own bookings');
    }
    // IDEMPOTENT: already cancelled is success (not error)
    if (preflight.status === 'cancelled') {
      logger.info('Idempotent cancel: booking already cancelled', { bookingId });
      return preflight;
    }

    // =====================================================================
    // #27 — SPLIT CANCEL TRANSACTION (QA-4 pattern)
    // Booking cancel + assignment cancel = INSIDE $transaction (atomic)
    // Vehicle release + Redis cleanup + notifications = OUTSIDE (best-effort)
    // =====================================================================
    let cancelledAssignments: Array<{ id: string; vehicleId: string | null; transporterId: string; vehicleType: string | null; vehicleSubtype: string | null; driverId: string | null; tripId: string | null; status: string }> = [];

    // A5#2: Booking-level distributed lock to serialize cancel-vs-accept races.
    // CAS inside the transaction is the real safety net; lock reduces wasted work.
    const lockKey = 'lock:booking:' + bookingId;
    let lock = { acquired: false };
    try {
      lock = await redisService.acquireLock(lockKey, `cancel:${customerId}`, 15);
    } catch (lockErr: any) {
      // Redis failure should not block cancels — CAS is the real guard
      logger.warn('[CANCEL] Lock acquisition failed, proceeding with CAS only', { error: lockErr?.message });
    }
    try {

    const updated = await prismaClient.$transaction(async (tx) => {
      // 1. Cancel booking — only succeeds if status is still cancellable
      const result = await tx.booking.updateMany({
        where: {
          id: bookingId,
          customerId,
          status: { in: [BookingStatus.created, BookingStatus.broadcasting, BookingStatus.active, BookingStatus.partially_filled, BookingStatus.fully_filled, BookingStatus.in_progress] }
        },
        data: {
          status: BookingStatus.cancelled,
          stateChangedAt: new Date()
        }
      });

      if (result.count === 0) {
        // Re-check: if already cancelled, return 0 (handled below as idempotent)
        return result;
      }

      // 2. Find active assignments BEFORE cancelling (need vehicleId list)
      // Fix B3: Cancel pre-trip AND mid-trip assignments so they don't become orphaned.
      // H-25: in_transit and arrived_at_drop were previously excluded, leaving orphan records.
      const cancellableStatuses = [
        AssignmentStatus.pending,
        AssignmentStatus.driver_accepted,
        AssignmentStatus.en_route_pickup,
        AssignmentStatus.at_pickup,
        AssignmentStatus.in_transit,
        AssignmentStatus.arrived_at_drop,
      ];
      const activeAssignments = await tx.assignment.findMany({
        where: { bookingId, status: { in: cancellableStatuses } },
        select: { id: true, vehicleId: true, transporterId: true, vehicleType: true, vehicleSubtype: true, driverId: true, tripId: true, status: true }
      });

      // 3. Cancel all active assignments
      if (activeAssignments.length > 0) {
        await tx.assignment.updateMany({
          where: { bookingId, status: { in: cancellableStatuses } },
          data: { status: AssignmentStatus.cancelled }
        });
      }

      // Store for post-transaction cleanup
      cancelledAssignments = activeAssignments;
      return result;
    }, { timeout: 10000 });

    // Post-transaction: re-fetch for final state
    const booking = await db.getBookingById(bookingId);
    if (!booking) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }

    // IDEMPOTENT: race with another cancel — already cancelled is success
    if (updated.count === 0 && booking.status === 'cancelled') {
      logger.info('Idempotent cancel: booking already cancelled', { bookingId });
      return booking;
    }

    if (updated.count === 0) {
      throw new AppError(409, 'BOOKING_CANNOT_CANCEL', `Cannot cancel booking in ${booking.status} state`);
    }

    // H-26: Cancellation ledger + abuse counter (parity with order-cancel.service.ts)
    try {
      await prismaClient.$transaction(async (tx) => {
        // Cancellation ledger entry for audit trail
        await tx.cancellationLedger.create({
          data: {
            id: uuid(),
            orderId: bookingId,
            customerId,
            driverId: cancelledAssignments[0]?.driverId || null,
            policyStage: 'PRE_DISPATCH',
            reasonCode: 'customer_cancelled',
            penaltyAmount: 0,
            compensationAmount: 0,
            settlementState: 'pending',
            cancelDecision: 'allowed',
            eventVersion: 1,
            idempotencyKey: null
          }
        });

        // Abuse counter — upsert to track repeat cancellations
        const now = new Date();
        await tx.cancellationAbuseCounter.upsert({
          where: { customerId },
          create: {
            customerId,
            cancelCount7d: 1,
            cancelCount30d: 1,
            cancelAfterLoadingCount: 0,
            cancelRebook2mCount: 1,
            riskTier: 'normal',
            lastCancelAt: now
          },
          update: {
            cancelCount7d: { increment: 1 },
            cancelCount30d: { increment: 1 },
            cancelRebook2mCount: { increment: 1 },
            lastCancelAt: now
          }
        });
      }, { timeout: 5000 });
    } catch (ledgerErr: any) {
      // Non-blocking: ledger/abuse counter failure must not prevent cancellation
      logger.warn('[CANCEL] Cancellation ledger/abuse counter write failed (non-critical)', { bookingId, error: ledgerErr?.message });
    }

    // === CANCEL WON: Best-effort cleanup (DB is already consistent) ===

    // 1. Timers already cleared above (before DB update) — skip duplicate call

    // 2. Clear customer active broadcast key + idempotency keys
    await this.clearCustomerActiveBroadcast(customerId).catch(e => logger.warn('Timer cleanup failed', e));

    // 3. Clear notified transporter set
    await redisService.del(`broadcast:notified:${bookingId}`).catch(() => { });

    // 4. Clear legacy client idempotency cache
    try {
      const latestIdempotencyKey = `idempotency:booking:${customerId}:latest`;
      const storedKey = await redisService.get(latestIdempotencyKey) as string | null;
      if (storedKey) {
        await redisService.del(`idempotency:booking:${customerId}:${storedKey}`);
        await redisService.del(latestIdempotencyKey);
      }
    } catch (err: any) {
      logger.warn(`[CANCEL] Failed to clear legacy idempotency cache (non-critical)`, { error: err.message });
    }

    // #28 — Re-fetch notifiedTransporters AFTER cancel commit for fresh data
    const freshBooking = await db.getBookingById(bookingId);
    const notifiedTransporters = freshBooking?.notifiedTransporters || booking.notifiedTransporters || [];

    // 5. Notify all notified transporters (using fresh list)
    if (notifiedTransporters.length > 0) {
      for (const transporterId of notifiedTransporters) {
        emitToUser(transporterId, SocketEvent.BOOKING_EXPIRED, {
          bookingId,
          orderId: bookingId,
          broadcastId: bookingId,
          status: 'cancelled',
          reason: 'customer_cancelled',
          message: `Sorry, this order was cancelled by ${booking.customerName}`,
          customerName: booking.customerName
        });
      }
      logger.info(`[CANCEL] Sent BOOKING_EXPIRED to ${notifiedTransporters.length} transporters`);

      // FCM push for background/closed apps
      queueService.queuePushNotificationBatch(
        notifiedTransporters,
        {
          title: '❌ Booking Cancelled',
          body: `${booking.customerName} cancelled ${booking.vehicleType} booking`,
          data: {
            type: 'booking_cancelled',
            bookingId,
            vehicleType: booking.vehicleType
          }
        }
      ).catch(err => {
        logger.warn(`FCM: Failed to queue cancellation push for booking ${bookingId}`, err);
      });
    }

    // 6. Emit to the booking room (for customer foreground)
    emitToBooking(bookingId, SocketEvent.BOOKING_UPDATED, {
      bookingId,
      status: 'cancelled'
    });

    // 7. Post-transaction: vehicle release + Redis cache sync + driver notifications
    for (const assignment of cancelledAssignments) {
      const isInProgressTrip = ['in_transit', 'at_pickup', 'arrived_at_drop'].includes(assignment.status);

      if (assignment.vehicleId) {
        // Vehicle release OUTSIDE transaction (best-effort, QA-4 pattern)
        await releaseVehicle(assignment.vehicleId, 'bookingCancellation').catch((err: any) => {
          logger.warn('[BOOKING_CANCEL] Vehicle release failed', { vehicleId: assignment.vehicleId, error: err.message });
        });
      }
      if (assignment.driverId) {
        emitToUser(assignment.driverId, SocketEvent.TRIP_CANCELLED, {
          assignmentId: assignment.id,
          bookingId,
          tripId: assignment.tripId,
          reason: 'booking_cancelled_by_customer',
          wasInProgress: isInProgressTrip,
          previousStatus: assignment.status,
          message: isInProgressTrip
            ? 'Trip cancelled by customer while in progress. Please stop and return.'
            : 'Trip cancelled by customer'
        });

        // FCM push: driver gets notification even if app is backgrounded
        queueService.queuePushNotificationBatch(
          [assignment.driverId],
          {
            title: isInProgressTrip ? 'Trip Cancelled (In Progress)' : 'Trip Cancelled',
            body: isInProgressTrip
              ? `Customer cancelled the trip while ${assignment.status.replace(/_/g, ' ')}. Please stop and contact support if needed.`
              : `${booking.customerName} cancelled the booking`,
            data: {
              type: 'trip_cancelled',
              assignmentId: assignment.id,
              bookingId,
              tripId: assignment.tripId,
              reason: 'booking_cancelled_by_customer',
              wasInProgress: String(isInProgressTrip)
            }
          }
        ).catch((fcmErr: any) => {
          logger.warn(`[CANCEL] FCM to driver ${assignment.driverId} failed`, { error: fcmErr.message });
        });
      }
    }
    if (cancelledAssignments.length > 0) {
      const inProgressCount = cancelledAssignments.filter(a =>
        ['in_transit', 'at_pickup', 'arrived_at_drop'].includes(a.status)
      ).length;
      logger.info(`[CANCEL] Reverted ${cancelledAssignments.length} assignments (${inProgressCount} in-progress), released vehicles`);
    }

    // M3 FIX: Notify in-transit/arrived_at_drop drivers about customer cancellation.
    // These drivers are intentionally NOT in cancelledAssignments (safety: loaded
    // truck stays in_transit), but they still need to know the customer cancelled.
    try {
      const inTransitAssignments = await prismaClient.assignment.findMany({
        where: {
          bookingId,
          status: { in: [AssignmentStatus.in_transit, AssignmentStatus.arrived_at_drop] }
        },
        select: { id: true, driverId: true, tripId: true, status: true }
      });
      for (const assignment of inTransitAssignments) {
        if (!assignment.driverId) continue;

        emitToUser(assignment.driverId, SocketEvent.TRIP_CANCELLED, {
          assignmentId: assignment.id,
          bookingId,
          tripId: assignment.tripId,
          reason: 'booking_cancelled_by_customer',
          wasInProgress: true,
          previousStatus: assignment.status,
          statusChanged: false,
          message: 'Customer has cancelled this booking. Please complete delivery and contact support if needed.'
        });

        queueService.queuePushNotificationBatch(
          [assignment.driverId],
          {
            title: 'Booking Cancelled by Customer',
            body: `Customer cancelled the booking while you are ${assignment.status.replace(/_/g, ' ')}. Please complete delivery and contact support if needed.`,
            data: {
              type: 'booking_cancelled_notification',
              assignmentId: assignment.id,
              bookingId,
              tripId: assignment.tripId,
              reason: 'booking_cancelled_by_customer',
              wasInProgress: 'true',
              statusChanged: 'false'
            }
          }
        ).catch((fcmErr: any) => {
          logger.warn(`[CANCEL] FCM to in-transit driver ${assignment.driverId} failed`, { error: fcmErr.message });
        });
      }
      if (inTransitAssignments.length > 0) {
        logger.info(`[CANCEL] Notified ${inTransitAssignments.length} in-transit/arrived_at_drop drivers (status NOT changed)`);
      }
    } catch (notifyErr: any) {
      logger.warn('[CANCEL] Failed to notify in-transit drivers (non-critical)', { error: notifyErr?.message });
    }

    logger.info(`[CANCEL] Booking ${bookingId} cancelled, all broadcast state cleaned`);
    return freshBooking || booking;

    } finally {
      // A5#2: Release booking-level lock (safe even if not acquired)
      if (lock.acquired) {
        await redisService.releaseLock(lockKey, `cancel:${customerId}`).catch(() => { });
      }
    }
  }

  /**
   * Update trucks filled (called when assignment is created)
   * ENHANCED: Cancels timeout when fully filled, notifies all parties
   */
  async incrementTrucksFilled(bookingId: string): Promise<BookingRecord> {
    const booking = await db.getBookingById(bookingId);

    if (!booking) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }


    // Problem 10 fix: Idempotency guard - skip if already fully filled
    if (booking.trucksFilled >= booking.trucksNeeded || booking.status === 'fully_filled') {
      logger.warn(`[incrementTrucksFilled] Booking ${bookingId} already at capacity (${booking.trucksFilled}/${booking.trucksNeeded}), skipping`);
      return booking;
    }

    // =====================================================================
    // ATOMIC INCREMENT with idempotency WHERE clause (Problem 10 fix)
    // Added: AND "trucksFilled" < "trucksNeeded" to prevent over-counting
    // =====================================================================
    const atomicResult = await prismaClient.$queryRaw<Array<{ trucksFilled: number; trucksNeeded: number }>>`
      UPDATE "Booking"
      SET "trucksFilled" = "trucksFilled" + 1,
          "stateChangedAt" = NOW()
      WHERE id = ${bookingId}
        AND "trucksFilled" < "trucksNeeded"
      RETURNING "trucksFilled", "trucksNeeded"
    `;

    if (!atomicResult || atomicResult.length === 0) {
      // Problem 10: 0 rows = already at capacity, not an error
      logger.warn(`[incrementTrucksFilled] Atomic increment returned 0 rows for ${bookingId} - already at capacity`);
      const currentBooking = await db.getBookingById(bookingId);
      return currentBooking || booking;
    }

    const newFilled = atomicResult[0].trucksFilled;
    const newStatus = newFilled >= atomicResult[0].trucksNeeded ? 'fully_filled' : 'partially_filled';

    // FIX-R2-9: Conditional status write — block if booking already in terminal state
    let updated: BookingRecord | undefined;
    try {
      const statusResult = await prismaClient.booking.updateMany({
        where: {
          id: bookingId,
          status: { notIn: ['cancelled', 'expired', 'completed'] }
        },
        data: { status: newStatus, stateChangedAt: new Date() }
      });
      if (statusResult.count === 0) {
        logger.warn('[RACE] Status write blocked — booking already in terminal state', {
          bookingId, attemptedStatus: newStatus
        });
      }
      updated = await db.getBookingById(bookingId);
    } catch (err: any) {
      logger.error('[BOOKING] Failed to update status after increment', { bookingId, newStatus, error: err.message });
    }

    // M-19 FIX: Emit booking_updated only via emitToUser (customer's personal room).
    // Previously also emitted via emitToBooking (booking room), causing the customer
    // to receive the event twice since they are in both rooms. The personal room
    // emission is the canonical one because it carries the user-facing message.
    emitToUser(booking.customerId, SocketEvent.BOOKING_UPDATED, {
      bookingId,
      status: newStatus,
      trucksFilled: newFilled,
      trucksNeeded: booking.trucksNeeded,
      message: newStatus === 'fully_filled'
        ? `All ${booking.trucksNeeded} trucks assigned! Your booking is complete.`
        : `${newFilled}/${booking.trucksNeeded} trucks assigned. Searching for more...`
    });

    // If fully filled, cancel timeout, clear active key, and notify
    if (newStatus === 'fully_filled') {
      await this.cancelBookingTimeout(bookingId);
      await this.clearCustomerActiveBroadcast(booking.customerId);

      // Send fully filled event to customer
      emitToUser(booking.customerId, SocketEvent.BOOKING_FULLY_FILLED, {
        bookingId,
        trucksNeeded: booking.trucksNeeded,
        trucksFilled: newFilled,
        message: 'All trucks have been assigned to your booking!'
      });

      // Notify remaining transporters that booking is no longer available
      for (const transporterId of booking.notifiedTransporters) {
        emitToUser(transporterId, SocketEvent.BOOKING_EXPIRED, {
          bookingId,
          orderId: bookingId,
          broadcastId: bookingId,
          reason: 'fully_filled',
          message: 'All trucks have been assigned for this booking',
          customerName: booking.customerName
        });
      }

      logger.info(`🎉 Booking ${bookingId} FULLY FILLED: ${newFilled}/${booking.trucksNeeded} trucks`);
    } else {
      // Partially filled - notify customer
      emitToUser(booking.customerId, SocketEvent.BOOKING_PARTIALLY_FILLED, {
        bookingId,
        trucksNeeded: booking.trucksNeeded,
        trucksFilled: newFilled,
        remaining: booking.trucksNeeded - newFilled,
        message: `${newFilled} truck${newFilled > 1 ? 's' : ''} assigned, searching for ${booking.trucksNeeded - newFilled} more...`
      });

      logger.info(`📦 Booking ${bookingId} PARTIALLY FILLED: ${newFilled}/${booking.trucksNeeded} trucks`);
    }

    return updated || booking;
  }

  /**
   * Decrement trucks filled (called when assignment is cancelled)
   */
  async decrementTrucksFilled(bookingId: string): Promise<BookingRecord> {
    const booking = await db.getBookingById(bookingId);

    if (!booking) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }

    // =====================================================================
    // ATOMIC DECREMENT — Same pattern as incrementTrucksFilled fix
    // Old code: read trucksFilled → subtract 1 in JS → write back (RACE)
    //   Two concurrent cancels both read 3, both write 2 → count = 2 (should be 1)
    // New code: single SQL SET "trucksFilled" = GREATEST(0, "trucksFilled" - 1)
    //   Database guarantees atomicity. GREATEST(0, ...) prevents negative values.
    // =====================================================================
    const atomicResult = await prismaClient.$queryRaw<Array<{ trucksFilled: number }>>`
      UPDATE "Booking"
      SET "trucksFilled" = GREATEST(0, "trucksFilled" - 1),
          "stateChangedAt" = NOW()
      WHERE id = ${bookingId}
        AND "status" NOT IN ('cancelled', 'expired', 'completed')
      RETURNING "trucksFilled"
    `;

    if (!atomicResult || atomicResult.length === 0) {
      throw new AppError(500, 'DECREMENT_FAILED', 'Failed to decrement trucks filled');
    }

    const newFilled = atomicResult[0].trucksFilled;
    const newStatus = newFilled === 0 ? 'active' : 'partially_filled';

    // FIX-R2-9: Conditional status write — block if booking already in terminal state
    let updated: BookingRecord | undefined;
    try {
      const statusResult = await prismaClient.booking.updateMany({
        where: {
          id: bookingId,
          status: { notIn: ['cancelled', 'expired', 'completed'] }
        },
        data: { status: newStatus, stateChangedAt: new Date() }
      });
      if (statusResult.count === 0) {
        logger.warn('[RACE] Status write blocked — booking already in terminal state', {
          bookingId, attemptedStatus: newStatus
        });
      }
      updated = await db.getBookingById(bookingId);
    } catch (err: any) {
      logger.error('[BOOKING] Failed to update status after decrement', { bookingId, newStatus, error: err.message });
    }

    // Notify via WebSocket
    emitToBooking(bookingId, SocketEvent.BOOKING_UPDATED, {
      bookingId,
      status: newStatus,
      trucksFilled: newFilled,
      trucksNeeded: booking.trucksNeeded
    });

    // Fix B5: Restart broadcast/timeout for remaining slots after decrement
    if (newFilled < booking.trucksNeeded) {
      const remaining = booking.trucksNeeded - newFilled;
      logger.info(`[BOOKING] Driver declined after fill. Restarting broadcast for ${remaining} remaining slots`, { bookingId });
      this.startBookingTimeout(bookingId, booking.customerId);
      // Emit socket event to customer
      emitToUser(booking.customerId, SocketEvent.TRUCKS_REMAINING_UPDATE, {
        bookingId, trucksFilled: newFilled, trucksNeeded: booking.trucksNeeded
      });
    }

    return updated || booking;
  }

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
      const existing = await redisService.get(rateLimitKey).catch(() => null);
      if (existing) {
        logger.info(`[RE-BROADCAST] Rate limited for transporter ${transporterId} — skipping`);
        return;
      }
      await redisService.set(rateLimitKey, '1', 10).catch(() => { });

      const bookings = await db.getActiveBookingsForTransporter(transporterId);
      const now = new Date();

      // Filter: only unexpired bookings created within last 30 minutes (prevents huge fan-out)
      const thirtyMinsAgo = new Date(now.getTime() - 30 * 60 * 1000);
      let activeBookings = bookings.filter(b => {
        if (!b.expiresAt) return true; // No expiry = still active
        if (new Date(b.expiresAt) <= now) return false; // Already expired
        // Only deliver recent bookings — old ones are unlikely to still need trucks
        const createdAt = b.createdAt ? new Date(b.createdAt) : now;
        return createdAt >= thirtyMinsAgo;
      }).slice(0, 20); // Cap at 20 to prevent unbounded fan-out

      // ===================================================================
      // GEO FILTER: Only deliver bookings within 150km of transporter's
      // current location. Graceful fallback: if location not in Redis yet
      // (transporter just toggled online, GPS ping hasn't arrived), deliver
      // all — same safe behaviour as before this fix.
      // Industry standard: Uber's DISCO only replays offers within the
      // driver's H3 k-ring. We use haversine (already imported) as it
      // works across all booking types (legacy + order).
      // ===================================================================
      const transporterGeoDetails = await availabilityService
        .getTransporterDetails(transporterId)
        .catch(() => null);

      if (transporterGeoDetails?.latitude && transporterGeoDetails?.longitude) {
        const beforeGeo = activeBookings.length;
        activeBookings = activeBookings.filter(b => {
          const distKm = haversineDistanceKm(
            transporterGeoDetails.latitude,
            transporterGeoDetails.longitude,
            b.pickup.latitude,
            b.pickup.longitude
          );
          return distKm <= 150;
        });
        logger.info(
          `[RE-BROADCAST] Geo-filtered: ${beforeGeo} → ${activeBookings.length} ` +
          `bookings within 150km of transporter ${transporterId}`
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
          activeBookings = activeBookings.filter(b => {
            const key = `${(b.vehicleType || '').toLowerCase()}_${(b.vehicleSubtype || '').toLowerCase()}`;
            return vehicleKeys.has(key);
          });
          if (beforeSubtype !== activeBookings.length) {
            logger.info(`[RE-BROADCAST] Subtype-filtered: ${beforeSubtype} → ${activeBookings.length} bookings matching fleet`);
          }
        }
      } catch { /* DB query failed -- proceed without subtype filter (safe: accept validates) */ }

      // FIX #31: Skip bookings where this transporter already has an active assignment.
      // The status filter above prevents fully-accepted bookings, but partially_filled
      // bookings could have this transporter already assigned. Re-broadcasting is safe
      // (accept handler is idempotent) but skipping reduces noise.
      try {
        const existingAssignments = await prismaClient.assignment.findMany({
          where: {
            transporterId,
            bookingId: { in: activeBookings.map(b => b.id) },
            status: { in: ['pending', 'driver_accepted', 'in_transit'] }
          },
          select: { bookingId: true }
        });
        if (existingAssignments.length > 0) {
          const assignedBookingIds = new Set(existingAssignments.map(a => a.bookingId));
          activeBookings = activeBookings.filter(b => !assignedBookingIds.has(b.id));
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

      for (const booking of activeBookings) {
        // Build the SAME broadcast payload format as createBooking()
        const broadcastPayload = buildBroadcastPayload(booking, {
          timeoutSeconds: getRemainingTimeoutSeconds(booking, BOOKING_CONFIG.TIMEOUT_MS),
          isRebroadcast: true
        });

        emitToUser(transporterId, SocketEvent.NEW_BROADCAST, broadcastPayload);
        logger.info(`  Delivered booking ${booking.id} (${booking.vehicleType}, ${booking.trucksNeeded - booking.trucksFilled} trucks remaining)`);

        // H-7 FIX: Broadcast delivery tracking for re-broadcast (fire-and-forget)
        try {
          if (typeof redisService.hSet === 'function') {
            redisService.hSet(
              `broadcast:delivery:${booking.id}`,
              transporterId,
              JSON.stringify({ emittedAt: Date.now(), channel: 'socket', rebroadcast: true })
            ).then(() => redisService.expire(`broadcast:delivery:${booking.id}`, 3600))
             .catch((_err: unknown) => { /* silent -- observability only */ });
          }
        } catch (_h7Err: unknown) { /* H-7 is observability only -- never crash broadcast */ }
      }

      // Add this transporter to each booking's notifiedTransporters in DB
      // so they receive cancellation/expiry notifications later
      for (const booking of activeBookings) {
        if (!booking.notifiedTransporters.includes(transporterId)) {
          // Cap at 200 to bound cancel/expire iteration (industry standard)
          const updatedNotified = [...booking.notifiedTransporters, transporterId].slice(0, 200);
          await db.updateBooking(booking.id, { notifiedTransporters: updatedNotified }).catch((err: any) => {
            logger.warn(`[RE-BROADCAST] Failed to update notifiedTransporters for booking ${booking.id}`, { error: err.message });
          });
        }
      }

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
    } catch (error: any) {
      // Non-critical — transporter can still manually refresh
      logger.error(`[RE-BROADCAST] Failed to deliver missed broadcasts to ${transporterId}`, {
        error: error.message
      });
    }
  }
}

export const bookingService = new BookingService();
