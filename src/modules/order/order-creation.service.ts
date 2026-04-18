/**
 * =============================================================================
 * ORDER CREATION SERVICE - Extracted sub-functions (NOT the active path)
 * =============================================================================
 *
 * These functions are imported by order-delegates.service.ts, which defines
 * a SECOND OrderService class. However, NO route imports that class —
 * all routes use the OrderService in order.service.ts directly.
 *
 * This file is NOT dead code (its functions are imported), but the
 * orchestration via order-delegates.service.ts IS a dead code path.
 *
 * Status: DEPRECATED — scheduled for cleanup.
 * =============================================================================
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { Prisma } from '@prisma/client';
import { db, OrderRecord, TruckRequestRecord } from '../../shared/database/db';
import { prismaClient, withDbTimeout, OrderStatus, BookingStatus, TruckRequestStatus } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { truncate } from '../../shared/utils/truncate';
import { redisService } from '../../shared/services/redis.service';
import { pricingService, verifyQuoteToken } from '../pricing/pricing.service';
import { AppError } from '../../shared/types/error.types';
import { metrics } from '../../shared/monitoring/metrics.service';
import { googleMapsService } from '../../shared/services/google-maps.service';
import { roundCoord } from '../../shared/utils/geo.utils';
import { TERMINAL_STATUSES } from '../booking/booking.types';
import type { OrderCreateContext } from './order-create-context';
import { assertValidTransition, ORDER_VALID_TRANSITIONS } from '../../core/state-machines';
import type { CreateOrderRequest, CreateOrderResponse } from './order-core-types';
import type { DispatchAttemptContext, DispatchAttemptOutcome } from './order-types';
import {
  FF_ORDER_DISPATCH_OUTBOX,
} from './order-dispatch-outbox.service';
import {
  broadcastToTransporters as broadcastToTransportersFn,
  emitBroadcastStateChanged as emitBroadcastStateChangedFn,
} from './order-broadcast.service';
import {
  setOrderExpiryTimer as setOrderExpiryTimerFn,
} from './order-timer.service';
// enforceCancelRebookCooldown called from facade via order-delegates.service.ts

// M-20 FIX: In-memory backpressure fallback when Redis is unavailable.
// Not as accurate as Redis (per-instance only), but prevents total flood.
//
// L6 (P1-T1.5) — Per-instance drift note:
//   `inMemoryInflight` is module-local state. With N ECS replicas, the total
//   in-flight capacity during a Redis outage is N * IN_MEMORY_MAX (not the
//   intended single-cluster-wide cap). Redis-up path uses a shared counter
//   and is correct; this fallback intentionally trades accuracy for
//   availability. A one-time `[BACKPRESSURE]` log below records the moment
//   we fall into this degraded mode so oncall can correlate with Redis
//   outage alarms. Documentation-only; no functional change.
let inMemoryInflight = 0;
let inMemoryModeLogged = false;

/**
 * Build a SHA-256 hash of the order request payload for idempotency matching.
 */
export function buildRequestPayloadHash(request: CreateOrderRequest): string {
  const routeFingerprint = (request.routePoints || [])
    .map((point) => [
      point.type,
      Number(point.latitude).toFixed(5),
      Number(point.longitude).toFixed(5),
      (point.address || '').trim().toLowerCase()
    ].join(':'))
    .join('|');
  const requirementsFingerprint = request.vehicleRequirements
    .map((item) => [
      (item.vehicleType || '').trim().toLowerCase(),
      (item.vehicleSubtype || '').trim().toLowerCase(),
      item.quantity,
      item.pricePerTruck
    ].join(':'))
    .sort()
    .join('|');

  const payload = [
    request.customerId,
    routeFingerprint,
    requirementsFingerprint,
    Number(request.distanceKm || 0).toFixed(2),
    (request.goodsType || '').trim().toLowerCase(),
    request.cargoWeightKg ?? '',
    request.scheduledAt ?? ''
  ].join('::');

  return crypto.createHash('sha256').update(payload).digest('hex');
}

// DB idempotency helpers are in order-idempotency.service.ts
import {
  getDbIdempotentResponse,
  persistDbIdempotentResponse,
} from './order-idempotency.service';

// ---------------------------------------------------------------------------
// createOrder sub-methods (extracted from OrderService class)
// ---------------------------------------------------------------------------

export async function acquireOrderBackpressure(ctx: OrderCreateContext): Promise<void> {
  // Fix B11: Redis-based system-wide backpressure -- shed load before heavy work
  try {
    const inflight = await redisService.incrBy(ctx.backpressureKey, 1);
    // Fix #34/#73: Track that Redis counter was incremented
    ctx.redisBackpressureIncremented = true;
    // Set TTL on first use (safety net for stale counters)
    // H-P6 FIX: Log backpressure TTL refresh failures instead of silently ignoring
    await redisService.expire(ctx.backpressureKey, 300).catch((err: unknown) => { logger.warn('[ORDER] Backpressure TTL refresh failed', { error: err instanceof Error ? err.message : String(err) }); });
    if (inflight > ctx.maxConcurrentOrders) {
      await redisService.incrBy(ctx.backpressureKey, -1).catch((err: unknown) => { logger.warn('[ORDER] Backpressure decrement failed', { error: err instanceof Error ? err.message : String(err) }); });
      // Fix #34/#73: Rejection already decremented, so reset flag
      ctx.redisBackpressureIncremented = false;
      logger.warn('[ORDER] System backpressure: too many concurrent order creates', { inflight, max: ctx.maxConcurrentOrders });
      throw new AppError(503, 'SYSTEM_BUSY', 'System is processing too many orders. Please retry in a few seconds.');
    }
  } catch (err: unknown) {
    // If Redis fails, use in-memory fallback instead of allowing everything through
    if (err instanceof AppError) throw err;
    // M-20 FIX: In-memory backpressure fallback when Redis is unavailable
    const IN_MEMORY_MAX = Math.ceil(ctx.maxConcurrentOrders / 4); // Per-instance share
    // L6 (P1-T1.5): log once per process when the in-memory path is first selected.
    // This marks the moment the service dropped into degraded (per-instance) backpressure
    // mode so oncall can correlate with Redis outage alarms. No functional change.
    if (!inMemoryModeLogged) {
      inMemoryModeLogged = true;
      logger.warn(`[BACKPRESSURE] In-memory mode engaged; expected per-instance capacity = ${IN_MEMORY_MAX}. Redis unavailable or disabled. Per-instance drift expected across multiple ECS tasks.`);
    }
    inMemoryInflight++;
    // Fix #34/#73: Track that in-memory counter was incremented
    ctx.inMemoryBackpressureIncremented = true;
    if (inMemoryInflight > IN_MEMORY_MAX) {
      inMemoryInflight--;
      // Fix #34/#73: Rejection already decremented, so reset flag
      ctx.inMemoryBackpressureIncremented = false;
      logger.warn('[ORDER] In-memory backpressure triggered (Redis unavailable)', { inMemoryInflight, max: IN_MEMORY_MAX });
      throw new AppError(503, 'SYSTEM_BUSY', 'System is processing too many orders. Please retry in a few seconds.');
    }
    logger.warn('[ORDER] Backpressure counter failed, using in-memory fallback', { error: (err as Error).message, inMemoryInflight, max: IN_MEMORY_MAX });
  }
}

export async function releaseOrderBackpressure(ctx: OrderCreateContext): Promise<void> {
  // Fix #34/#73: Only decrement Redis if we actually incremented it (prevents double-decrement / counter drift)
  if (ctx.redisBackpressureIncremented) {
    await redisService.incrBy(ctx.backpressureKey, -1).catch((err: unknown) => { logger.warn('[ORDER] Backpressure decrement failed in finally', { error: err instanceof Error ? err.message : String(err) }); });
    ctx.redisBackpressureIncremented = false;
  }
  // Fix #34/#73: Only decrement in-memory if we actually incremented it (prevents counter drift)
  if (ctx.inMemoryBackpressureIncremented) {
    inMemoryInflight = Math.max(0, inMemoryInflight - 1);
    ctx.inMemoryBackpressureIncremented = false;
  }
}

export function validateOrderRequest(ctx: OrderCreateContext): void {
  // Hard server-side validation (defense-in-depth in addition to route schema)
  if (!Array.isArray(ctx.request.vehicleRequirements) || ctx.request.vehicleRequirements.length === 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'At least one truck requirement is required');
  }
  const invalidQuantity = ctx.request.vehicleRequirements.find((item) => item.quantity <= 0);
  if (invalidQuantity) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Truck quantity must be greater than zero');
  }
}

export async function enforceOrderDebounce(ctx: OrderCreateContext): Promise<void> {
  // ==========================================================================
  // PER-CUSTOMER ORDER DEBOUNCE (3 second cooldown)
  // ==========================================================================
  const DEBOUNCE_SECONDS = 3;
  const debounceKey = `debounce:order:${ctx.request.customerId}`;

  try {
    const debounceActive = await redisService.get(debounceKey);
    if (debounceActive) {
      logger.warn(`⚠️ ORDER DEBOUNCE: Customer ${ctx.request.customerId} tried to place order within ${DEBOUNCE_SECONDS}s cooldown`);
      throw new AppError(429, 'RATE_LIMITED', 'Please wait a few seconds before placing another order.');
    }
    // Set debounce key — auto-expires after 3 seconds
    await redisService.set(debounceKey, '1', DEBOUNCE_SECONDS);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // If error is our debounce AppError, rethrow it
    if (error instanceof AppError) throw error;
    // If Redis fails, skip debounce (don't block orders)
    metrics.incrementCounter('order_debounce_redis_bypass_total');
    logger.warn(`⚠️ Debounce check failed: ${message}. Proceeding without debounce.`);
  }
}

export async function checkOrderIdempotency(ctx: OrderCreateContext): Promise<CreateOrderResponse | null> {
  // ==========================================================================
  // IDEMPOTENCY CHECK - Prevents duplicate orders on network retry
  // ==========================================================================
  if (!ctx.request.idempotencyKey) return null;

  const cacheKey = `idempotency:${ctx.request.customerId}:${ctx.request.idempotencyKey}`;

  try {
    const cached = await redisService.get(cacheKey);
    if (cached) {
      // Fix #78: Wrap JSON.parse in try-catch to handle corrupted Redis cache gracefully
      let cachedResponse: CreateOrderResponse;
      try {
        cachedResponse = JSON.parse(cached) as CreateOrderResponse;
      } catch (parseError: unknown) {
        logger.warn('[ORDER] Corrupted idempotency cache — deleting key and falling through to normal creation', {
          cacheKey,
          rawValue: typeof cached === 'string' ? cached.substring(0, 100) : String(cached),
          error: parseError instanceof Error ? parseError.message : String(parseError),
        });
        await redisService.del(cacheKey).catch(() => {});
        // Fall through to normal creation
        return null;
      }
      logger.info(`Idempotency HIT: Returning cached order ${truncate(cachedResponse.orderId, 11)} for key ${truncate(ctx.request.idempotencyKey, 11)}`);
      return cachedResponse;
    }
    logger.debug(`Idempotency MISS: Processing new order for key ${truncate(ctx.request.idempotencyKey, 11)}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Idempotency cache error: ${message}. Proceeding with order creation.`);
    // Continue with order creation even if cache fails
  }

  const dbReplay = await getDbIdempotentResponse(
    ctx.request.customerId,
    ctx.request.idempotencyKey,
    ctx.requestPayloadHash
  );
  if (dbReplay) {
    logger.info('✅ DB Idempotency HIT: returning stored response', {
      customerId: ctx.request.customerId,
      idempotencyKey: truncate(ctx.request.idempotencyKey, 11),
      orderId: dbReplay.orderId
    });
    return dbReplay;
  }
  return null;
}

export async function checkExistingActiveOrders(ctx: OrderCreateContext): Promise<void> {
  // ========================================
  // ONE-ACTIVE-BROADCAST-PER-CUSTOMER GUARD
  // ========================================
  // Layer 1: Redis fast-path (catches 95%+ duplicates before DB).
  // Intentionally OUTSIDE the transaction for performance.
  // I-4 FIX: Wrap Redis ops in try/catch — if Redis is down, fall through to DB
  // SERIALIZABLE transaction (the authoritative guard). Better to allow a rare
  // duplicate attempt (caught by TX) than to block ALL order creation.
  const activeKey = `customer:active-broadcast:${ctx.request.customerId}`;
  try {
    const existingBroadcastId = await redisService.get(activeKey);
    if (existingBroadcastId) {
      throw new AppError(409, 'ACTIVE_ORDER_EXISTS', 'You already have an active order');
    }
  } catch (error: unknown) {
    if (error instanceof AppError) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[ORDER] Redis active-broadcast check failed: ${msg}. Falling through to DB guard.`);
  }

  // Layer 2: Distributed lock to serialize concurrent creates from same customer.
  // I-4 FIX: If lock acquisition fails, proceed without lock — the SERIALIZABLE TX
  // is the real concurrency guard; the lock is an optimization, not a requirement.
  try {
    const lock = await redisService.acquireLock(ctx.lockKey, ctx.request.customerId, 10);
    if (!lock.acquired) {
      throw new AppError(409, 'LOCK_CONTENTION', 'Order creation in progress, please wait');
    }
    ctx.lockAcquired = true;
  } catch (error: unknown) {
    if (error instanceof AppError) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[ORDER] Redis lock acquisition failed: ${msg}. Proceeding without lock (DB TX is authoritative).`);
  }

  // FIX #11: DB authoritative check REMOVED from here.
  // It was running OUTSIDE the SERIALIZABLE transaction, creating a TOCTOU race:
  // two concurrent requests could both pass this check before either creates.
  // The same check runs INSIDE persistOrderTransaction's SERIALIZABLE TX (the real guard).
  // Redis fast-path + lock above catch 95%+ of duplicates; the TX catches the rest.
}

export async function checkOrderServerIdempotency(ctx: OrderCreateContext): Promise<CreateOrderResponse | null> {
  // ========================================
  // SERVER-GENERATED IDEMPOTENCY (double-tap / retry protection)
  // ========================================
  // Extract pickup/drop coords from routePoints or legacy fields
  const idemPickup = ctx.request.routePoints?.[0] || ctx.request.pickup;
  const idemDrop = ctx.request.routePoints?.[ctx.request.routePoints?.length ? ctx.request.routePoints.length - 1 : 0] || ctx.request.drop;
  const truckTypesSorted = ctx.request.vehicleRequirements
    .map(t => `${t.vehicleType}:${t.vehicleSubtype || ''}:${t.quantity}`)
    .sort()
    .join('|');
  const idempotencyFingerprint = [
    ctx.request.customerId,
    truckTypesSorted,
    roundCoord(idemPickup?.latitude || 0),
    roundCoord(idemPickup?.longitude || 0),
    roundCoord(idemDrop?.latitude || 0),
    roundCoord(idemDrop?.longitude || 0)
  ].join(':');
  ctx.idempotencyHash = crypto.createHash('sha256').update(idempotencyFingerprint).digest('hex').substring(0, 32);
  // FIX #77: Use order-specific prefix to avoid collision with booking deduplication keys
  ctx.dedupeKey = `idem:order:create:${ctx.request.customerId}:${ctx.idempotencyHash}`;

  // I-4 FIX: Wrap Redis dedup check in try/catch — if Redis fails, skip dedup
  // and let the DB SERIALIZABLE transaction handle uniqueness.
  try {
    const existingDedupeId = await redisService.get(ctx.dedupeKey);
    if (existingDedupeId) {
      const existingDedupeOrder = await db.getOrderById(existingDedupeId);
      if (existingDedupeOrder && !['cancelled', 'expired'].includes(existingDedupeOrder.status)) {
        logger.info('Idempotent replay: returning existing order', { orderId: existingDedupeId, idempotencyHash: ctx.idempotencyHash });
        const totalTrucks = ctx.request.vehicleRequirements.reduce((sum, req) => sum + req.quantity, 0);
        const totalAmount = ctx.request.vehicleRequirements.reduce((sum, req) => sum + (req.quantity * req.pricePerTruck), 0);
        return {
          orderId: existingDedupeId,
          totalTrucks,
          totalAmount,
          dispatchState: 'dispatched',
          dispatchAttempts: 1,
          onlineCandidates: existingDedupeOrder.onlineCandidatesCount || 0,
          notifiedTransporters: existingDedupeOrder.notifiedCount || 0,
          reasonCode: existingDedupeOrder.dispatchReasonCode || undefined,
          serverTimeMs: Date.now(),
          truckRequests: [],
          expiresAt: existingDedupeOrder.expiresAt,
          expiresIn: 0
        };
      }
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[ORDER] Redis server-idempotency check failed: ${msg}. Proceeding without dedup (DB TX is authoritative).`);
  }
  return null;
}

export async function resolveServerRouteDistance(ctx: OrderCreateContext): Promise<void> {
  // ==========================================================================
  // SERVER-SIDE ROUTE DISTANCE (Google Directions API)
  // ==========================================================================
  ctx.clientDistanceKm = ctx.request.distanceKm;
  ctx.distanceSource = 'client_fallback';

  try {
    // Build route points for Google API: pickup -> waypoints -> drop
    const routePointsForGoogle: Array<{ lat: number; lng: number }> = [];

    if (ctx.request.routePoints && ctx.request.routePoints.length >= 2) {
      for (const point of ctx.request.routePoints) {
        routePointsForGoogle.push({ lat: point.latitude, lng: point.longitude });
      }
    } else if (ctx.request.pickup && ctx.request.drop) {
      routePointsForGoogle.push(
        { lat: ctx.request.pickup.latitude, lng: ctx.request.pickup.longitude },
        { lat: ctx.request.drop.latitude, lng: ctx.request.drop.longitude }
      );
    }

    if (routePointsForGoogle.length >= 2) {
      // Truck mode: OFF by default. When FF_TRUCK_MODE_ROUTING=true,
      // heavy vehicles avoid highways/tolls for truck-accurate routing.
      const FF_TRUCK_MODE_ROUTING = process.env.FF_TRUCK_MODE_ROUTING === 'true';
      const HEAVY_VEHICLE_TYPES = new Set(['open', 'container', 'tipper', 'flatbed']);
      const primaryVehicleType = ctx.request.vehicleRequirements[0]?.vehicleType || '';
      const useTruckMode = FF_TRUCK_MODE_ROUTING && HEAVY_VEHICLE_TYPES.has(primaryVehicleType);

      const googleRoute = await googleMapsService.calculateRoute(
        routePointsForGoogle,
        useTruckMode
      );

      if (googleRoute && googleRoute.distanceKm > 0) {
        ctx.request.distanceKm = googleRoute.distanceKm;
        ctx.distanceSource = 'google';

        const deltaPercent = ctx.clientDistanceKm > 0
          ? Math.round(((googleRoute.distanceKm - ctx.clientDistanceKm) / ctx.clientDistanceKm) * 100)
          : 0;

        logger.info('[ORDER] Route distance calculated via Google Directions', {
          distanceSource: 'google',
          clientDistanceKm: ctx.clientDistanceKm,
          serverDistanceKm: googleRoute.distanceKm,
          deltaPercent: `${deltaPercent}%`,
          durationMinutes: googleRoute.durationMinutes,
          routePoints: routePointsForGoogle.length,
          // Flag anomaly if client sent >3x different from Google
          ...(Math.abs(deltaPercent) > 200 ? { distanceAnomaly: true } : {})
        });
      } else {
        logger.warn('[ORDER] Google Directions returned null/zero — using client distance', {
          distanceSource: 'client_fallback',
          clientDistanceKm: ctx.clientDistanceKm,
          reason: 'google_returned_empty'
        });
      }
    }
  } catch (routeError: unknown) {
    // Google API failure — keep customer distance, never block order creation
    logger.warn('[ORDER] Google Directions API failed — using client distance', {
      distanceSource: 'client_fallback',
      clientDistanceKm: ctx.clientDistanceKm,
      reason: routeError instanceof Error ? routeError.message : 'unknown'
    });
  }
}

export function validateAndCorrectPrices(ctx: OrderCreateContext): void {
  // ==========================================================================
  // SECURITY: Server-side price validation
  //
  // F-A-26: when the client replays a signed quote token from
  // `pricingService.calculateEstimate`, we HMAC-verify it here instead of
  // silently re-pricing. This prevents two back-to-back requests in the same
  // 5-min surge bucket from returning different amounts, while still
  // catching tampered/forged tokens (Stripe PaymentIntent semantics).
  // ==========================================================================
  const PRICE_TOLERANCE = 0.05; // 5% tolerance for rounding/surge timing

  for (const req of ctx.request.vehicleRequirements) {
    // F-A-26: short-circuit to "accept client price" when the quote token is
    // present, HMAC-valid, and its 5-min bucket has not yet expired.
    if (
      req.quoteToken &&
      req.surgeRuleId &&
      req.surgeBucketStart &&
      req.surgeBucketEnd
    ) {
      const tokenValid = verifyQuoteToken(
        req.quoteToken,
        {
          pricePerTruck: req.pricePerTruck,
          surgeRuleId: req.surgeRuleId,
          surgeBucketStart: req.surgeBucketStart,
          surgeBucketEnd: req.surgeBucketEnd,
        }
      );
      if (tokenValid) {
        logger.info(
          `[ORDER] Quote token valid for ${req.vehicleType}/${req.vehicleSubtype}; ` +
          `honoring client price ₹${req.pricePerTruck} (surgeRule=${req.surgeRuleId})`
        );
        continue;
      }
      logger.warn(
        `⚠️ QUOTE TOKEN REJECTED for ${req.vehicleType}/${req.vehicleSubtype} ` +
        `(surgeRule=${req.surgeRuleId}); falling through to server re-price.`
      );
    }

    try {
      const serverEstimate = pricingService.calculateEstimate({
        vehicleType: req.vehicleType,
        vehicleSubtype: req.vehicleSubtype,
        distanceKm: ctx.request.distanceKm,
        trucksNeeded: req.quantity,
        cargoWeightKg: ctx.request.cargoWeightKg
      });

      const serverPrice = serverEstimate.pricePerTruck;
      const clientPrice = req.pricePerTruck;
      const priceDiff = (clientPrice - serverPrice) / serverPrice;

      if (priceDiff < -PRICE_TOLERANCE) {
        // Client price is suspiciously low - use server price
        logger.warn(`⚠️ PRICE TAMPER DETECTED: ${req.vehicleType}/${req.vehicleSubtype} ` +
          `client=₹${clientPrice} vs server=₹${serverPrice} (diff=${(priceDiff * 100).toFixed(1)}%). ` +
          `Using server price.`);
        req.pricePerTruck = serverPrice;
      } else if (Math.abs(priceDiff) > PRICE_TOLERANCE) {
        // Price differs significantly but client paid more - log but allow
        logger.info(`ℹ️ Price variance: ${req.vehicleType}/${req.vehicleSubtype} ` +
          `client=₹${clientPrice} vs server=₹${serverPrice} (diff=${(priceDiff * 100).toFixed(1)}%)`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // FIX #31: Apply minimum fare floor when pricing service fails.
      // Prevents ₹0 / ₹1 orders slipping through when pricing service is down.
      const _rawMinFare = parseInt(process.env.MINIMUM_FARE_PER_TRUCK || '500', 10);
      const MINIMUM_FARE = isNaN(_rawMinFare) ? 500 : _rawMinFare;
      req.pricePerTruck = Math.max(MINIMUM_FARE, req.pricePerTruck);
      logger.warn(`⚠️ Price validation failed for ${req.vehicleType}: ${message}. Applied fare floor ₹${MINIMUM_FARE}, using ₹${req.pricePerTruck}.`);
    }
  }

  ctx.totalAmount = Math.round(
    ctx.request.vehicleRequirements.reduce(
      (sum, req) => sum + (req.quantity * req.pricePerTruck),
      0
    ) * 100
  ) / 100;
}

export function buildOrderRoutePoints(ctx: OrderCreateContext, BROADCAST_TIMEOUT_MS: number): void {
  // ==========================================================================
  // BUILD ROUTE POINTS (with intermediate stops support)
  // ==========================================================================
  if (ctx.request.routePoints && ctx.request.routePoints.length >= 2) {
    // NEW: Use provided routePoints
    ctx.routePoints = ctx.request.routePoints.map((point, index) => ({
      ...point,
      stopIndex: index
    }));

    // Extract pickup (first) and drop (last) for backward compatibility
    const firstPoint = ctx.request.routePoints[0];
    const lastPoint = ctx.request.routePoints[ctx.request.routePoints.length - 1];

    ctx.pickup = {
      latitude: firstPoint.latitude,
      longitude: firstPoint.longitude,
      address: firstPoint.address,
      city: firstPoint.city,
      state: firstPoint.state
    };

    ctx.drop = {
      latitude: lastPoint.latitude,
      longitude: lastPoint.longitude,
      address: lastPoint.address,
      city: lastPoint.city,
      state: lastPoint.state
    };

    logger.info(`📍 Route has ${ctx.routePoints.length} points (${ctx.routePoints.filter(p => p.type === 'STOP').length} intermediate stops)`);
  } else if (ctx.request.pickup && ctx.request.drop) {
    // LEGACY: Build routePoints from pickup + drop
    ctx.pickup = ctx.request.pickup;
    ctx.drop = ctx.request.drop;

    ctx.routePoints = [
      { type: 'PICKUP', ...ctx.pickup, stopIndex: 0 },
      { type: 'DROP', ...ctx.drop, stopIndex: 1 }
    ];

    logger.info(`📍 Route has 2 points (no intermediate stops)`);
  } else {
    throw new Error('Either routePoints OR both pickup and drop must be provided');
  }

  // Calculate totals
  ctx.totalTrucks = ctx.request.vehicleRequirements.reduce((sum, req) => sum + req.quantity, 0);
  if (ctx.totalTrucks <= 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Total trucks must be greater than zero');
  }

  ctx.expiresAt = new Date(Date.now() + BROADCAST_TIMEOUT_MS).toISOString();

  const stopsCount = ctx.routePoints.filter(p => p.type === 'STOP').length;

  logger.info(`╔══════════════════════════════════════════════════════════════╗`);
  logger.info(`║  🚛 NEW MULTI-VEHICLE ORDER                                   ║`);
  logger.info(`╠══════════════════════════════════════════════════════════════╣`);
  logger.info(`║  Order ID: ${truncate(ctx.orderId, 11)}`);
  logger.info(`║  Customer: ${ctx.request.customerName}`);
  logger.info(`║  Total Trucks: ${ctx.totalTrucks}`);
  logger.info(`║  Total Amount: ₹${ctx.totalAmount}`);
  logger.info(`║  Vehicle Types: ${ctx.request.vehicleRequirements.length}`);
  ctx.request.vehicleRequirements.forEach((req, i) => {
    logger.info(`║    ${i + 1}. ${req.quantity}x ${req.vehicleType} (${req.vehicleSubtype}) @ ₹${req.pricePerTruck}`);
  });
  logger.info(`║  Route Points: ${ctx.routePoints.length} (${stopsCount} stops)`);
  ctx.routePoints.forEach((point, i) => {
    logger.info(`║    ${i}. [${point.type}] ${truncate(point.address, 43)}`);
  });
  logger.info(`╚══════════════════════════════════════════════════════════════╝`);
}

export async function persistOrderTransaction(
  ctx: OrderCreateContext,
  enqueueOrderDispatchOutbox: (orderId: string, tx?: Prisma.TransactionClient) => Promise<void>
): Promise<void> {
  // 1. Create the parent Order
  const order: Omit<OrderRecord, 'createdAt' | 'updatedAt'> = {
    id: ctx.orderId,
    customerId: ctx.request.customerId,
    customerName: ctx.request.customerName,
    customerPhone: ctx.request.customerPhone,

    // Route points (NEW - with intermediate stops)
    routePoints: ctx.routePoints,
    currentRouteIndex: 0,        // Start at pickup
    stopWaitTimers: [],          // Empty until driver reaches stops

    // Legacy pickup/drop (for backward compatibility)
    pickup: ctx.pickup,
    drop: ctx.drop,

    distanceKm: ctx.request.distanceKm,
    totalTrucks: ctx.totalTrucks,
    trucksFilled: 0,
    totalAmount: ctx.totalAmount,
    goodsType: ctx.request.goodsType,
    cargoWeightKg: ctx.request.cargoWeightKg,
    status: 'created',
    stateChangedAt: new Date(),
    dispatchState: 'queued',
    dispatchAttempts: 0,
    dispatchReasonCode: null,
    onlineCandidatesCount: 0,
    notifiedCount: 0,
    lastDispatchAt: null,
    scheduledAt: ctx.request.scheduledAt,
    expiresAt: ctx.expiresAt
  };

  // 2. Prepare TruckRequests for each vehicle type
  let requestNumber = 1;
  for (const vehicleReq of ctx.request.vehicleRequirements) {
    // Create one TruckRequest per truck (not per type)
    for (let i = 0; i < vehicleReq.quantity; i++) {
      const truckRequestId = uuidv4();

      const truckRequest: Omit<TruckRequestRecord, 'createdAt' | 'updatedAt'> = {
        id: truckRequestId,
        orderId: ctx.orderId,
        requestNumber,
        vehicleType: vehicleReq.vehicleType,
        vehicleSubtype: vehicleReq.vehicleSubtype,
        pricePerTruck: vehicleReq.pricePerTruck,
        status: 'searching',
        notifiedTransporters: []
      };

      ctx.truckRequests.push(truckRequest as TruckRequestRecord);
      requestNumber++;
    }

    // Find matching transporters for this vehicle type
    const matchingTransporters = await db.getTransportersWithVehicleType(
      vehicleReq.vehicleType,
      vehicleReq.vehicleSubtype
    );

    ctx.responseRequests.push({
      id: ctx.truckRequests[ctx.truckRequests.length - 1].id,
      vehicleType: vehicleReq.vehicleType,
      vehicleSubtype: vehicleReq.vehicleSubtype,
      quantity: vehicleReq.quantity,
      pricePerTruck: vehicleReq.pricePerTruck,
      matchingTransporters: matchingTransporters.length
    });
  }

  // M-12 VERIFIED: Order + TruckRequests + dispatch outbox are created atomically
  // inside a single Serializable transaction. If any step fails, all roll back.
  await withDbTimeout(async (tx) => {
    // FIX #11 + CRITICAL#2: AUTHORITATIVE active-order guard INSIDE SERIALIZABLE TX.
    // This is the TOCTOU-safe check — PostgreSQL serializable isolation aborts
    // one transaction on conflict, so two concurrent requests cannot both pass.
    // The Redis fast-path in checkExistingActiveOrders is a performance optimization only.
    const dupBooking = await tx.booking.findFirst({
      where: { customerId: ctx.request.customerId, status: { notIn: [...TERMINAL_STATUSES] as BookingStatus[] } }
    });
    const dupOrder = await tx.order.findFirst({
      where: { customerId: ctx.request.customerId, status: { notIn: [...TERMINAL_STATUSES] as OrderStatus[] } }
    });
    if (dupBooking || dupOrder) {
      throw new AppError(409, 'ACTIVE_ORDER_EXISTS', 'You already have an active order');
    }

    await tx.order.create({
      data: {
        ...order,
        routePoints: order.routePoints as unknown as Prisma.InputJsonValue,
        stopWaitTimers: order.stopWaitTimers as unknown as Prisma.InputJsonValue,
        pickup: order.pickup as unknown as Prisma.InputJsonValue,
        drop: order.drop as unknown as Prisma.InputJsonValue,
        status: order.status as OrderStatus
      }
    });

    if (ctx.truckRequests.length > 0) {
      await tx.truckRequest.createMany({
        data: ctx.truckRequests.map((truckRequest) => ({
          id: truckRequest.id,
          orderId: truckRequest.orderId,
          requestNumber: truckRequest.requestNumber,
          vehicleType: truckRequest.vehicleType,
          vehicleSubtype: truckRequest.vehicleSubtype,
          pricePerTruck: truckRequest.pricePerTruck,
          status: truckRequest.status as TruckRequestStatus,
          heldById: truckRequest.heldBy || null,
          heldAt: truckRequest.heldAt || null,
          assignedTransporterId: truckRequest.assignedTransporterId || truckRequest.assignedTo || null,
          assignedTransporterName: truckRequest.assignedTransporterName || null,
          assignedVehicleId: truckRequest.assignedVehicleId || null,
          assignedVehicleNumber: truckRequest.assignedVehicleNumber || null,
          assignedDriverId: truckRequest.assignedDriverId || null,
          assignedDriverName: truckRequest.assignedDriverName || null,
          assignedDriverPhone: truckRequest.assignedDriverPhone || null,
          tripId: truckRequest.tripId || null,
          notifiedTransporters: truckRequest.notifiedTransporters || [],
          assignedAt: truckRequest.assignedAt || null
        })),
        skipDuplicates: true
      });
    }

    await tx.order.update({
      where: { id: ctx.orderId },
      data: {
        status: OrderStatus.broadcasting,
        stateChangedAt: new Date(),
        dispatchState: 'dispatching',
        dispatchAttempts: ctx.dispatchAttempts,
        dispatchReasonCode: null,
        lastDispatchAt: new Date()
      }
    });

    if (FF_ORDER_DISPATCH_OUTBOX) {
      await enqueueOrderDispatchOutbox(ctx.orderId, tx);
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeoutMs: 8000 });
}

export async function broadcastOrderToTransporters(
  ctx: OrderCreateContext,
  processDispatchOutboxImmediately: (orderId: string, context: DispatchAttemptContext) => Promise<DispatchAttemptOutcome | null>
): Promise<void> {
  // Emit lifecycle state: created
  emitBroadcastStateChangedFn(ctx.request.customerId, {
    orderId: ctx.orderId,
    status: 'created',
    dispatchState: 'queued',
    dispatchAttempts: 0
  });

  // Emit lifecycle state: broadcasting
  emitBroadcastStateChangedFn(ctx.request.customerId, {
    orderId: ctx.orderId,
    status: 'broadcasting',
    dispatchState: 'dispatching',
    dispatchAttempts: ctx.dispatchAttempts
  });

  // 3. Dispatch through durable outbox (or fallback direct dispatch when flag disabled)
  const dispatchContext: DispatchAttemptContext = {
    request: ctx.request,
    truckRequests: ctx.truckRequests,
    expiresAt: ctx.expiresAt,
    pickup: ctx.pickup
  };

  if (FF_ORDER_DISPATCH_OUTBOX) {
    const immediateOutcome = await processDispatchOutboxImmediately(ctx.orderId, dispatchContext);
    if (immediateOutcome) {
      ctx.dispatchState = immediateOutcome.dispatchState;
      ctx.dispatchReasonCode = immediateOutcome.reasonCode;
      ctx.onlineCandidates = immediateOutcome.onlineCandidates;
      ctx.notifiedTransporters = immediateOutcome.notifiedTransporters;
      ctx.dispatchAttempts = immediateOutcome.dispatchAttempts;
    } else {
      ctx.dispatchState = 'dispatching';
      ctx.dispatchReasonCode = 'DISPATCH_RETRYING';
      ctx.dispatchAttempts = 1;
    }
  } else {
    // IMPORTANT: Wrapped in try-catch - dispatch errors should NEVER fail order creation
    try {
      const dispatchStats = await broadcastToTransportersFn(ctx.orderId, ctx.request, ctx.truckRequests, ctx.expiresAt, ctx.pickup);
      ctx.onlineCandidates = dispatchStats.onlineCandidates;
      ctx.notifiedTransporters = dispatchStats.notifiedTransporters;

      if (ctx.notifiedTransporters > 0) {
        ctx.dispatchState = 'dispatched';
      } else {
        ctx.dispatchState = 'dispatch_failed';
        ctx.dispatchReasonCode = dispatchStats.onlineCandidates === 0
          ? 'NO_ONLINE_TRANSPORTERS'
          : 'DISPATCH_RETRYING';
      }
    } catch (broadcastError: unknown) {
      // M-10 FIX: Use DISPATCH_ERROR (not DISPATCH_RETRYING) when broadcast throws
      ctx.dispatchState = 'dispatch_failed';
      ctx.dispatchReasonCode = 'DISPATCH_ERROR';
      logger.error(`[ORDER] Broadcast failed for order ${ctx.orderId}, marked dispatch_failed for retry`, {
        orderId: ctx.orderId,
        error: broadcastError instanceof Error ? broadcastError.message : String(broadcastError),
        stack: broadcastError instanceof Error ? broadcastError.stack : undefined
      });
    }
  }
}

export async function setupOrderExpiry(
  ctx: OrderCreateContext,
  BROADCAST_TIMEOUT_MS: number
): Promise<void> {
  // 4. Set expiry timer
  setOrderExpiryTimerFn(ctx.orderId, BROADCAST_TIMEOUT_MS);

  // Fix #74: If zero transporters were notified and dispatch would be 'dispatched',
  // downgrade to 'dispatch_failed' with NO_ONLINE_TRANSPORTERS reason code.
  // Do NOT transition the order to 'active' when nobody was notified.
  if (ctx.notifiedTransporters === 0 && ctx.dispatchState === 'dispatched') {
    ctx.dispatchState = 'dispatch_failed';
    ctx.dispatchReasonCode = 'NO_ONLINE_TRANSPORTERS';
  }

  // Fix #74: Choose target status based on whether any transporters were notified.
  // Orders with 0 notified transporters go to 'expired' (not 'active'), because
  // there is nobody to respond and the order would just sit uselessly.
  const targetStatus = ctx.notifiedTransporters === 0 ? 'expired' : 'active';

  // Fix B4: Assert valid transition before writing
  assertValidTransition('Order', ORDER_VALID_TRANSITIONS, 'broadcasting', targetStatus);

  // Fix B2: CAS guard -- only transition from broadcasting/created
  const casResult = await prismaClient.order.updateMany({
    where: {
      id: ctx.orderId,
      status: { in: ['broadcasting', 'created'] }
    },
    data: {
      status: targetStatus,
      stateChangedAt: new Date(),
      dispatchState: ctx.dispatchState,
      dispatchAttempts: ctx.dispatchAttempts,
      dispatchReasonCode: ctx.dispatchReasonCode || null,
      onlineCandidatesCount: ctx.onlineCandidates,
      notifiedCount: ctx.notifiedTransporters,
      lastDispatchAt: new Date()
    }
  });
  if (casResult.count === 0) {
    logger.warn('[ORDER] CAS failed: broadcasting->' + targetStatus + ' blocked, order no longer in expected state', { orderId: ctx.orderId });
  }
  emitBroadcastStateChangedFn(ctx.request.customerId, {
    orderId: ctx.orderId,
    status: targetStatus,
    dispatchState: ctx.dispatchState,
    dispatchAttempts: ctx.dispatchAttempts,
    reasonCode: ctx.dispatchReasonCode,
    onlineCandidates: ctx.onlineCandidates,
    notifiedTransporters: ctx.notifiedTransporters
  });

  // SCALABILITY: Calculate expiresIn for UI countdown timer
  const expiresIn = Math.floor(BROADCAST_TIMEOUT_MS / 1000);

  // Build response
  ctx.orderResponse = {
    orderId: ctx.orderId,
    totalTrucks: ctx.totalTrucks,
    totalAmount: ctx.totalAmount,
    dispatchState: ctx.dispatchState,
    dispatchAttempts: ctx.dispatchAttempts,
    onlineCandidates: ctx.onlineCandidates,
    notifiedTransporters: ctx.notifiedTransporters,
    reasonCode: ctx.dispatchReasonCode,
    serverTimeMs: Date.now(),
    truckRequests: ctx.responseRequests,
    expiresAt: ctx.expiresAt,
    expiresIn  // NEW: UI uses this for countdown (backend-driven)
  };
}

export async function cacheOrderIdempotencyResponse(
  ctx: OrderCreateContext,
  BROADCAST_TIMEOUT_MS: number
): Promise<void> {
  // ==========================================================================
  // IDEMPOTENCY CACHE - Store response for future retries
  // ==========================================================================
  if (ctx.request.idempotencyKey) {
    const cacheKey = `idempotency:${ctx.request.customerId}:${ctx.request.idempotencyKey}`;
    const ttl = 86_400; // 24 hours

    try {
      await redisService.set(cacheKey, JSON.stringify(ctx.orderResponse), ttl);
      // Store pointer for cleanup on cancel/expiry
      await redisService.set(`idempotency:order:${ctx.request.customerId}:latest`, ctx.request.idempotencyKey, ttl);
      await persistDbIdempotentResponse(
        ctx.request.customerId,
        ctx.request.idempotencyKey,
        ctx.requestPayloadHash,
        ctx.orderId,
        ctx.orderResponse!
      );
      logger.info(`Idempotency cached: ${truncate(cacheKey, 53)} (TTL: ${ttl}s)`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`⚠️ Failed to cache idempotency response: ${message}`);
      // Non-critical error, continue
    }
  }

  // Store server-generated idempotency key
  // I-4 FIX (defense-in-depth): These are post-commit cache writes — order is already
  // in DB. If Redis fails here, dedup cache is stale but DB TX guard still catches dupes.
  const orderTimeoutSeconds = Math.ceil(BROADCAST_TIMEOUT_MS / 1000);
  try {
    await redisService.set(ctx.dedupeKey, ctx.orderId, orderTimeoutSeconds + 30);
    await redisService.set(`idem:broadcast:latest:${ctx.request.customerId}`, ctx.dedupeKey, orderTimeoutSeconds + 30);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[ORDER] Post-commit dedup cache write failed: ${msg}. Order already persisted — DB guard is authoritative.`);
  }

  // FIX CRITICAL#3: TTL=86400 (24h) as SAFETY CEILING, not primary cleanup.
  // Primary cleanup is explicit DEL on terminal status (clearCustomerActiveBroadcast).
  // Industry standard (Stripe): idempotency keys have 24h TTL, cleared on completion.
  const activeKey = `customer:active-broadcast:${ctx.request.customerId}`;
  const ACTIVE_BROADCAST_TTL_SECONDS = 86400;
  try {
    await redisService.set(activeKey, ctx.orderId, ACTIVE_BROADCAST_TTL_SECONDS);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[ORDER] Post-commit active-broadcast cache write failed: ${msg}. Order already persisted — DB guard is authoritative.`);
  }
}
