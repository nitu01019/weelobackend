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
import { prismaClient, BookingStatus, AssignmentStatus, VehicleStatus } from '../../shared/database/prisma.service';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, emitToBooking, SocketEvent, isUserConnected } from '../../shared/services/socket.service';
import { fcmService } from '../../shared/services/fcm.service';
import { queueService } from '../../shared/services/queue.service';
import { CreateBookingInput, GetBookingsQuery } from './booking.schema';
import { availabilityService } from '../../shared/services/availability.service';
import { generateVehicleKey } from '../../shared/services/vehicle-key.service';
import { transporterOnlineService } from '../../shared/services/transporter-online.service';
import { redisService } from '../../shared/services/redis.service';
// 4 PRINCIPLES: Import production-grade error codes
import { ErrorCode } from '../../core/constants';
import { buildBroadcastPayload, getRemainingTimeoutSeconds } from './booking-payload.helper';

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
// 4-step progressive search. If no transporter accepts at step N,
// expand to step N+1 after the step timeout. After all steps exhaust,
// fall back to DB query for ALL matching transporters.
// =============================================================================
const RADIUS_EXPANSION_CONFIG = {
  steps: [
    { radiusKm: 10, timeoutMs: 15_000 },  // Step 1: 10km, wait 15s
    { radiusKm: 25, timeoutMs: 15_000 },  // Step 2: 25km, wait 15s
    { radiusKm: 50, timeoutMs: 15_000 },  // Step 3: 50km, wait 15s
    { radiusKm: 75, timeoutMs: 15_000 },  // Step 4: 75km (max), wait 15s
  ],
  maxTransportersPerStep: 20,  // Top N nearest per step
};

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
  pickupLat: number;
  pickupLng: number;
  currentStep: number;  // 0-indexed (0 = step 1 already done, advance to step 2)
}

// =============================================================================
// EXPIRY CHECKER (Runs on every server instance - Redis ensures no duplicates)
// =============================================================================
let expiryCheckerInterval: NodeJS.Timeout | null = null;

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
    // Try to acquire lock for this booking (prevents duplicate processing)
    const lockKey = `lock:booking-expiry:${timer.data.bookingId}`;
    const lock = await redisService.acquireLock(lockKey, 'expiry-checker', 30);

    if (!lock.acquired) {
      // Another instance is processing this booking
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
      await redisService.releaseLock(lockKey, 'expiry-checker').catch(() => {});
    }
  }
}

// Start expiry checker when module loads
startBookingExpiryChecker();

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
    const lockKey = `lock:radius-expand:${timer.data.bookingId}`;
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
      await redisService.releaseLock(lockKey, 'radius-expander').catch(() => {});
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
    const activeKey = `customer:active-broadcast:${customerId}`;
    const existingBroadcastId = await redisService.get(activeKey);
    if (existingBroadcastId) {
      throw new AppError(409, 'ORDER_ACTIVE_EXISTS', 'Request already in progress. Cancel it first.');
    }

    const lockKey = `customer-broadcast-create:${customerId}`;
    const lock = await redisService.acquireLock(lockKey, customerId, 10);
    if (!lock.acquired) {
      throw new AppError(409, 'ORDER_ACTIVE_EXISTS', 'Request already in progress. Cancel it first.');
    }

    try {
    // ========================================
    // SERVER-GENERATED IDEMPOTENCY (double-tap / retry protection)
    // ========================================
    const roundCoord = (n: number) => Math.round(n * 1000) / 1000;
    const idempotencyFingerprint = [
      customerId,
      data.vehicleType,
      data.vehicleSubtype || '',
      roundCoord(data.pickup.coordinates.latitude),
      roundCoord(data.pickup.coordinates.longitude),
      roundCoord(data.drop.coordinates.latitude),
      roundCoord(data.drop.coordinates.longitude)
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

    // Calculate expiry based on config timeout
    const expiresAt = new Date(Date.now() + BOOKING_CONFIG.TIMEOUT_MS).toISOString();

    // ========================================
    // PROGRESSIVE RADIUS SEARCH (Requirement 6)
    // Step 1: Start with smallest radius (10km)
    // If no one accepts, expiry checker expands every 15s
    // ========================================
    const vehicleKey = generateVehicleKey(data.vehicleType, data.vehicleSubtype);
    const step1 = RADIUS_EXPANSION_CONFIG.steps[0];

    // Step 1 search: smallest radius
    let nearbyTransporters = await availabilityService.getAvailableTransportersAsync(
      vehicleKey,
      data.pickup.coordinates.latitude,
      data.pickup.coordinates.longitude,
      RADIUS_EXPANSION_CONFIG.maxTransportersPerStep,
      step1.radiusKm
    );

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
      matchingTransporters = await transporterOnlineService.filterOnline(allDbTransporters);
      skipProgressiveExpansion = true;  // DB fallback already notified all — no radius expansion needed
      logger.info(`📋 Fallback to DATABASE matching (${allDbTransporters.length} total, ${matchingTransporters.length} online) — skipping progressive expansion`);
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
    await prismaClient.$transaction(async (tx) => {
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
          totalAmount: data.pricePerTruck * data.trucksNeeded,
          goodsType: data.goodsType,
          weight: data.weight,
          status: BookingStatus.created,
          stateChangedAt: new Date(),
          notifiedTransporters: matchingTransporters,
          scheduledAt: data.scheduledAt,
          expiresAt
        }
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    // Fetch as BookingRecord (converts JSON fields + dates for downstream use)
    const booking = await db.getBookingById(bookingId);
    if (!booking) {
      throw new AppError(500, 'BOOKING_CREATE_FAILED', 'Failed to create booking');
    }

    // Emit lifecycle state: created
    emitToUser(customerId, 'broadcast_state_changed', {
      bookingId: booking.id,
      status: 'created',
      stateChangedAt: new Date().toISOString()
    });

    // ========================================
    // HANDLE: No matching transporters found
    // ========================================
    if (matchingTransporters.length === 0) {
      logger.warn(`⚠️ NO TRANSPORTERS FOUND for ${data.vehicleType}`);

      // Immediately notify customer
      emitToUser(customerId, SocketEvent.NO_VEHICLES_AVAILABLE, {
        bookingId: booking.id,
        vehicleType: data.vehicleType,
        vehicleSubtype: data.vehicleSubtype,
        message: `No ${data.vehicleType} vehicles available right now. Please try again later or select a different vehicle type.`,
        suggestion: 'search_again'
      });

      // Mark as expired immediately
      await db.updateBooking(booking.id, { status: 'expired', stateChangedAt: new Date() });

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
    // IMPORTANT: Include broadcastId AND orderId for Captain app compatibility
    // Captain app's SocketIOService checks broadcastId first, then orderId
    const broadcastPayload = buildBroadcastPayload(booking, {
      timeoutSeconds: BOOKING_CONFIG.TIMEOUT_MS / 1000,
      trucksFilled: 0
    });

    logger.info(`📢 Broadcasting to ${matchingTransporters.length} transporters for ${data.vehicleType} ${data.vehicleSubtype || ''} (Radius Step 1: ${step1.radiusKm}km)`);

    // Phase 3 optimization: No per-transporter DB queries in broadcast loop.
    // filterOnline() already guarantees all transporters are online.
    // Name lookup was only for logging — not needed for broadcast payload.
    for (const transporterId of matchingTransporters) {
      emitToUser(transporterId, SocketEvent.NEW_BROADCAST, broadcastPayload);
    }

    // Transition: created -> broadcasting (transporters have been notified)
    await db.updateBooking(booking.id, { status: 'broadcasting', stateChangedAt: new Date() });
    emitToUser(customerId, 'broadcast_state_changed', {
      bookingId: booking.id,
      status: 'broadcasting',
      stateChangedAt: new Date().toISOString()
    });

    // ========================================
    // TRACK NOTIFIED TRANSPORTERS FOR PROGRESSIVE RADIUS (Requirement 6)
    // Store in Redis SET so later steps only broadcast to NEW transporters
    // ========================================
    if (matchingTransporters.length > 0) {
      const notifiedSetKey = RADIUS_KEYS.NOTIFIED_SET(booking.id);
      const ttlSeconds = Math.ceil(BOOKING_CONFIG.TIMEOUT_MS / 1000) + 120;
      try {
        await redisService.sAdd(notifiedSetKey, ...matchingTransporters);
      } catch (e: any) {
        // Retry once — incomplete notified set causes duplicate broadcasts on radius expansion
        logger.warn('[RADIUS] sAdd failed, retrying once', { bookingId: booking.id, error: e.message });
        await redisService.sAdd(notifiedSetKey, ...matchingTransporters).catch((retryErr: any) => {
          logger.error('[RADIUS] Failed to track notified transporters after retry — radius expansion may send duplicate broadcasts', {
            bookingId: booking.id, error: retryErr.message, transporterCount: matchingTransporters.length
          });
        });
      }
      // Set TTL on the notified set (same as booking timeout + buffer)
      await redisService.expire(notifiedSetKey, ttlSeconds).catch(() => {});
    }

    // ========================================
    // SEND FCM PUSH NOTIFICATIONS (for app in background)
    // ========================================
    fcmService.notifyNewBroadcast(matchingTransporters, {
      broadcastId: booking.id,
      customerName: booking.customerName,
      vehicleType: booking.vehicleType,
      trucksNeeded: booking.trucksNeeded,
      farePerTruck: booking.pricePerTruck,
      pickupCity: booking.pickup.city,
      dropCity: booking.drop.city
    }).then(sentCount => {
      logger.info(`📱 FCM: Push notifications sent to ${sentCount}/${matchingTransporters.length} transporters`);
    }).catch(err => {
      logger.warn('📱 FCM: Failed to send push notifications', err);
    });

    // ========================================
    // START TIMEOUT TIMER
    // ========================================
    this.startBookingTimeout(booking.id, customerId);

    // Transition: broadcasting -> active (timer started, awaiting responses)
    await db.updateBooking(booking.id, { status: 'active', stateChangedAt: new Date() });
    emitToUser(customerId, 'broadcast_state_changed', {
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

    // Store server-generated idempotency key
    const bookingTimeoutSeconds = Math.ceil(BOOKING_CONFIG.TIMEOUT_MS / 1000);
    await redisService.set(dedupeKey, booking.id, bookingTimeoutSeconds + 30);
    await redisService.set(`idem:broadcast:latest:${customerId}`, dedupeKey, bookingTimeoutSeconds + 30);

    // Set customer active broadcast key (one-per-customer enforcement)
    await redisService.set(activeKey, booking.id, bookingTimeoutSeconds + 60);

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

    // Skip if already completed or cancelled
    if (['fully_filled', 'completed', 'cancelled'].includes(booking.status)) {
      logger.info(`Booking ${bookingId} already ${booking.status}, skipping timeout`);
      this.clearBookingTimers(bookingId);
      return;
    }

    logger.info(`⏰ TIMEOUT: Booking ${bookingId} expired`);

    // Check if partially filled
    if (booking.trucksFilled > 0 && booking.trucksFilled < booking.trucksNeeded) {
      // Partially filled - notify customer
      await db.updateBooking(bookingId, { status: 'expired', stateChangedAt: new Date() });

      emitToUser(customerId, SocketEvent.BOOKING_EXPIRED, {
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
      await db.updateBooking(bookingId, { status: 'expired', stateChangedAt: new Date() });

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
    await redisService.del(activeKey).catch((err: any) => {
      logger.warn('Failed to clear customer active broadcast key', { customerId, error: err.message });
    });
    // Clean up server-generated idempotency key
    const latestIdemKey = await redisService.get(`idem:broadcast:latest:${customerId}`).catch(() => null);
    if (latestIdemKey) {
      await redisService.del(latestIdemKey).catch(() => {});
      await redisService.del(`idem:broadcast:latest:${customerId}`).catch(() => {});
    }
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
   * STOPS if:
   * - Booking is cancelled/expired/fully_filled
   * - All steps exhausted → fall back to DB query
   */
  async advanceRadiusStep(data: RadiusStepTimerData): Promise<void> {
    const nextStepIndex = data.currentStep + 1;
    const totalSteps = RADIUS_EXPANSION_CONFIG.steps.length;

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

    // Search at expanded radius
    const nearbyTransporters = await availabilityService.getAvailableTransportersAsync(
      data.vehicleKey,
      data.pickupLat,
      data.pickupLng,
      RADIUS_EXPANSION_CONFIG.maxTransportersPerStep,
      step.radiusKm
    );

    // Dedup: remove already-notified transporters
    let alreadyNotified: string[] = [];
    try {
      alreadyNotified = await redisService.sMembers(RADIUS_KEYS.NOTIFIED_SET(data.bookingId));
    } catch (_) { }
    const alreadyNotifiedSet = new Set(alreadyNotified);
    const newTransporters = nearbyTransporters.filter(t => !alreadyNotifiedSet.has(t));

    logger.info(`[RADIUS STEP ${nextStepIndex + 1}] Found ${nearbyTransporters.length} total, ${newTransporters.length} NEW transporters`);

    // Broadcast to new transporters only
    if (newTransporters.length > 0) {
      const now = new Date();
      const broadcastPayload = buildBroadcastPayload(booking, {
        timeoutSeconds: getRemainingTimeoutSeconds(booking, BOOKING_CONFIG.TIMEOUT_MS),
        radiusStep: nextStepIndex + 1
      });

      for (const transporterId of newTransporters) {
        emitToUser(transporterId, SocketEvent.NEW_BROADCAST, broadcastPayload);
      }

      // Track newly notified transporters
      await redisService.sAdd(RADIUS_KEYS.NOTIFIED_SET(data.bookingId), ...newTransporters).catch(() => { });

      // Also update the booking's notified list in DB
      const allNotified = [...(booking.notifiedTransporters || []), ...newTransporters];
      const uniqueNotified = [...new Set(allNotified)];
      await db.updateBooking(data.bookingId, { notifiedTransporters: uniqueNotified });

      // FCM push to new transporters
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
    const onlineTransporters = await transporterOnlineService.filterOnline(allDbTransporters);

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

    const now = new Date();
    const broadcastPayload = buildBroadcastPayload(booking, {
      timeoutSeconds: getRemainingTimeoutSeconds(booking, BOOKING_CONFIG.TIMEOUT_MS),
      radiusStep: RADIUS_EXPANSION_CONFIG.steps.length + 1  // DB fallback marker
    });

    for (const transporterId of newTransporters) {
      emitToUser(transporterId, SocketEvent.NEW_BROADCAST, broadcastPayload);
    }

    // Update DB record with all notified transporters
    const allNotified = [...(booking.notifiedTransporters || []), ...newTransporters];
    const uniqueNotified = [...new Set(allNotified)];
    await db.updateBooking(data.bookingId, { notifiedTransporters: uniqueNotified });

    // FCM push
    fcmService.notifyNewBroadcast(newTransporters, {
      broadcastId: booking.id,
      customerName: booking.customerName,
      vehicleType: booking.vehicleType,
      trucksNeeded: booking.trucksNeeded - booking.trucksFilled,
      farePerTruck: booking.pricePerTruck,
      pickupCity: booking.pickup.city,
      dropCity: booking.drop.city
    }).catch(() => { });

    logger.info(`[RADIUS] ✅ DB fallback delivered to ${newTransporters.length} additional transporters`);
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

    // Only show active/partially filled
    bookings = bookings.filter(b =>
      b.status === 'active' || b.status === 'partially_filled'
    );

    // Sort by newest first
    bookings.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = bookings.length;

    // Pagination
    const start = (query.page - 1) * query.limit;
    bookings = bookings.slice(start, start + query.limit);

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
    // ATOMIC cancel: only succeeds if status is still cancellable
    const updated = await prismaClient.booking.updateMany({
      where: {
        id: bookingId,
        customerId,
        status: { in: [BookingStatus.created, BookingStatus.broadcasting, BookingStatus.active, BookingStatus.partially_filled] }
      },
      data: {
        status: BookingStatus.cancelled,
        stateChangedAt: new Date()
      }
    });

    // Fetch current state for response and post-cancel logic
    const booking = await db.getBookingById(bookingId);

    if (!booking) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }

    if (booking.customerId !== customerId) {
      throw new AppError(403, 'FORBIDDEN', 'You can only cancel your own bookings');
    }

    // IDEMPOTENT: already cancelled is success (not error)
    if (updated.count === 0 && booking.status === 'cancelled') {
      logger.info('Idempotent cancel: booking already cancelled', { bookingId });
      return booking;
    }

    if (updated.count === 0) {
      throw new AppError(409, 'BOOKING_CANNOT_CANCEL', `Cannot cancel booking in ${booking.status} state`);
    }

    // === CANCEL WON: Full cleanup ===

    // 1. Clear all timers INCLUDING radius expansion keys
    await this.clearBookingTimers(bookingId);

    // 2. Clear customer active broadcast key + idempotency keys
    await this.clearCustomerActiveBroadcast(customerId);

    // 3. Clear notified transporter set
    await redisService.del(`broadcast:notified:${bookingId}`).catch(() => {});

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

    // 5. Notify all notified transporters
    if (booking.notifiedTransporters && booking.notifiedTransporters.length > 0) {
      for (const transporterId of booking.notifiedTransporters) {
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
      logger.info(`[CANCEL] Sent BOOKING_EXPIRED to ${booking.notifiedTransporters.length} transporters`);

      // FCM push for background/closed apps
      queueService.queuePushNotificationBatch(
        booking.notifiedTransporters,
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

    // 7. Revert active assignments — release vehicles and notify drivers
    try {
      const activeAssignments = await prismaClient.assignment.findMany({
        where: { bookingId, status: { in: [AssignmentStatus.pending, AssignmentStatus.driver_accepted, AssignmentStatus.en_route_pickup] } }
      });
      if (activeAssignments.length > 0) {
        await prismaClient.assignment.updateMany({
          where: { bookingId, status: { in: [AssignmentStatus.pending, AssignmentStatus.driver_accepted, AssignmentStatus.en_route_pickup] } },
          data: { status: AssignmentStatus.cancelled }
        });
        for (const assignment of activeAssignments) {
          if (assignment.vehicleId) {
            await prismaClient.vehicle.update({
              where: { id: assignment.vehicleId },
              data: { status: VehicleStatus.available, currentTripId: null, assignedDriverId: null }
            }).catch(() => {});
          }
          if (assignment.driverId) {
            emitToUser(assignment.driverId, 'trip_cancelled', {
              bookingId, tripId: assignment.tripId, message: 'Trip cancelled by customer'
            });
          }
        }
        logger.info(`[CANCEL] Reverted ${activeAssignments.length} assignments, released vehicles`);
      }
    } catch (err: any) {
      logger.warn(`[CANCEL] Failed to revert assignments (non-critical)`, { error: err.message });
    }

    // Re-fetch to get the updated record
    const cancelledBooking = await db.getBookingById(bookingId);
    logger.info(`[CANCEL] Booking ${bookingId} cancelled, all broadcast state cleaned`);
    return cancelledBooking || booking;
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

    const newFilled = booking.trucksFilled + 1;
    const newStatus = newFilled >= booking.trucksNeeded ? 'fully_filled' : 'partially_filled';

    const updated = await db.updateBooking(bookingId, {
      trucksFilled: newFilled,
      status: newStatus,
      stateChangedAt: new Date()
    });

    // Notify customer via WebSocket
    emitToUser(booking.customerId, SocketEvent.BOOKING_UPDATED, {
      bookingId,
      status: newStatus,
      trucksFilled: newFilled,
      trucksNeeded: booking.trucksNeeded,
      message: newStatus === 'fully_filled'
        ? `🎉 All ${booking.trucksNeeded} trucks assigned! Your booking is complete.`
        : `✅ ${newFilled}/${booking.trucksNeeded} trucks assigned. Searching for more...`
    });

    // Also notify via booking room
    emitToBooking(bookingId, SocketEvent.BOOKING_UPDATED, {
      bookingId,
      status: newStatus,
      trucksFilled: newFilled,
      trucksNeeded: booking.trucksNeeded
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

    return updated!;
  }

  /**
   * Decrement trucks filled (called when assignment is cancelled)
   */
  async decrementTrucksFilled(bookingId: string): Promise<BookingRecord> {
    const booking = await db.getBookingById(bookingId);

    if (!booking) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }

    const newFilled = Math.max(0, booking.trucksFilled - 1);
    const newStatus = newFilled === 0 ? 'active' : 'partially_filled';

    const updated = await db.updateBooking(bookingId, {
      trucksFilled: newFilled,
      status: newStatus,
      stateChangedAt: new Date()
    });

    // Notify via WebSocket
    emitToBooking(bookingId, SocketEvent.BOOKING_UPDATED, {
      bookingId,
      status: newStatus,
      trucksFilled: newFilled,
      trucksNeeded: booking.trucksNeeded
    });

    return updated!;
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
      const bookings = await db.getActiveBookingsForTransporter(transporterId);
      const now = new Date();

      // Filter: only unexpired bookings created within last 30 minutes (prevents huge fan-out)
      const thirtyMinsAgo = new Date(now.getTime() - 30 * 60 * 1000);
      const activeBookings = bookings.filter(b => {
        if (!b.expiresAt) return true; // No expiry = still active
        if (new Date(b.expiresAt) <= now) return false; // Already expired
        // Only deliver recent bookings — old ones are unlikely to still need trucks
        const createdAt = b.createdAt ? new Date(b.createdAt) : now;
        return createdAt >= thirtyMinsAgo;
      }).slice(0, 20); // Cap at 20 to prevent unbounded fan-out

      if (activeBookings.length === 0) {
        logger.info(`[RE-BROADCAST] Transporter ${transporterId} came online — 0 active bookings to deliver`);
        return;
      }

      logger.info(`╔══════════════════════════════════════════════════════════════╗`);
      logger.info(`║  📡 RE-BROADCAST: Delivering ${activeBookings.length} missed bookings            ║`);
      logger.info(`║  Transporter: ${transporterId}                                ║`);
      logger.info(`╚══════════════════════════════════════════════════════════════╝`);

      for (const booking of activeBookings) {
        // Build the SAME broadcast payload format as createBooking()
        const broadcastPayload = buildBroadcastPayload(booking, {
          timeoutSeconds: getRemainingTimeoutSeconds(booking, BOOKING_CONFIG.TIMEOUT_MS),
          isRebroadcast: true
        });

        emitToUser(transporterId, SocketEvent.NEW_BROADCAST, broadcastPayload);
        logger.info(`  📡 Delivered booking ${booking.id} (${booking.vehicleType}, ${booking.trucksNeeded - booking.trucksFilled} trucks remaining)`);
      }

      // Add this transporter to each booking's notifiedTransporters in DB
      // so they receive cancellation/expiry notifications later
      for (const booking of activeBookings) {
        if (!booking.notifiedTransporters.includes(transporterId)) {
          const updatedNotified = [...booking.notifiedTransporters, transporterId];
          await db.updateBooking(booking.id, { notifiedTransporters: updatedNotified }).catch((err: any) => {
            logger.warn(`[RE-BROADCAST] Failed to update notifiedTransporters for booking ${booking.id}`, { error: err.message });
          });
        }
      }

      // FCM push summary (one notification for all missed bookings)
      fcmService.notifyNewBroadcast([transporterId], {
        broadcastId: activeBookings[0].id,
        customerName: activeBookings.length === 1 ? activeBookings[0].customerName : 'Multiple Customers',
        vehicleType: activeBookings.length === 1 ? activeBookings[0].vehicleType : 'Multiple Types',
        trucksNeeded: activeBookings.reduce((sum, b) => sum + (b.trucksNeeded - b.trucksFilled), 0),
        farePerTruck: activeBookings[0].pricePerTruck,
        pickupCity: activeBookings[0].pickup.city,
        dropCity: activeBookings[0].drop.city
      }).catch(err => {
        logger.warn(`[RE-BROADCAST] FCM push failed for transporter ${transporterId}`, err);
      });

      logger.info(`[RE-BROADCAST] ✅ Delivered ${activeBookings.length} bookings to transporter ${transporterId}`);
    } catch (error: any) {
      // Non-critical — transporter can still manually refresh
      logger.error(`[RE-BROADCAST] Failed to deliver missed broadcasts to ${transporterId}`, {
        error: error.message
      });
    }
  }
}

export const bookingService = new BookingService();
