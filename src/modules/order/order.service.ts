/**
 * =============================================================================
 * ORDER SERVICE - Multi-Vehicle Type Booking System
 * =============================================================================
 * 
 * SCALABILITY: Designed for millions of concurrent bookings
 * - Each order can have multiple vehicle types (Tipper + Container + Open)
 * - Each vehicle type creates a separate SubRequest
 * - Each SubRequest broadcasts ONLY to transporters with that vehicle type
 * 
 * FLOW:
 * 1. Customer creates ORDER with multiple vehicle types
 * 2. System creates TruckRequests (one per truck, grouped by type)
 * 3. Each vehicle type broadcasts to matching transporters
 * 4. Transporters see ONLY requests matching their vehicles
 * 5. Real-time updates to customer as trucks get filled
 * 
 * MODULARITY:
 * - Clear separation: Order → TruckRequests → Assignments
 * - Easy to extend for new vehicle types
 * - AWS-ready with message queue support (TODO(LEO-L2): add SQS/SNS integration)
 * =============================================================================
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { Prisma } from '@prisma/client';
import { db, OrderRecord, TruckRequestRecord } from '../../shared/database/db';
import { prismaClient, withDbTimeout, OrderStatus, AssignmentStatus, VehicleStatus, BookingStatus, TruckRequestStatus } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, SocketEvent } from '../../shared/services/socket.service';
import { sendPushNotification } from '../../shared/services/fcm.service';
import { availabilityService } from '../../shared/services/availability.service';
import { generateVehicleKey } from '../../shared/services/vehicle-key.service';
import { redisService } from '../../shared/services/redis.service';
import { liveAvailabilityService } from '../../shared/services/live-availability.service';
import { pricingService } from '../pricing/pricing.service';
import { AppError } from '../../shared/types/error.types';
import { googleMapsService } from '../../shared/services/google-maps.service';
import { metrics } from '../../shared/monitoring/metrics.service';
import { truckHoldService } from '../truck-hold/truck-hold.service';
import { roundCoord } from '../../shared/utils/geo.utils';
import { haversineDistanceKm } from '../../shared/utils/geospatial.utils';
import { releaseVehicle } from '../../shared/services/vehicle-lifecycle.service';
// Fix B4: Import state machine for order status assertions
import { assertValidTransition, ORDER_VALID_TRANSITIONS } from '../../core/state-machines';
import {
  getOrderDetailsQuery,
  getActiveRequestsForTransporterQuery,
  getOrdersByCustomerQuery,
  getOrderWithRequestsQuery,
  getActiveTruckRequestsForTransporterQuery,
  getCustomerOrdersQuery,
  ActiveTruckRequestOrderGroup as ActiveTruckRequestOrderGroupImported
} from './order-query.service';
import type {
  DispatchAttemptContext,
  DispatchAttemptOutcome,
  OrderLifecycleOutboxPayload,
  OrderCancelledOutboxPayload,
  TruckCancelPolicyStage,
  TruckCancelDecision,
  CancelMoneyBreakdown,
  TruckCancelPolicyEvaluation,
  CancelOrderResult,
} from './order-types';
import {
  FF_ORDER_DISPATCH_OUTBOX,
  FF_ORDER_DISPATCH_STATUS_EVENTS,
  ORDER_DISPATCH_OUTBOX_POLL_MS,
  ORDER_DISPATCH_OUTBOX_BATCH_SIZE,
  startDispatchOutboxWorker as startDispatchOutboxWorkerFn,
  enqueueOrderDispatchOutbox as enqueueOrderDispatchOutboxFn,
  processDispatchOutboxImmediately as processDispatchOutboxImmediatelyFn,
} from './order-dispatch-outbox.service';
import {
  FF_CANCEL_OUTBOX_ENABLED,
  ORDER_CANCEL_OUTBOX_POLL_MS,
  ORDER_CANCEL_OUTBOX_BATCH_SIZE,
  startLifecycleOutboxWorker as startLifecycleOutboxWorkerFn,
  enqueueCancelLifecycleOutbox as enqueueCancelLifecycleOutboxFn,
  processLifecycleOutboxImmediately as processLifecycleOutboxImmediatelyFn,
  emitCancellationLifecycle as emitCancellationLifecycleFn,
  handleOrderExpiry as handleOrderExpiryFn,
} from './order-lifecycle-outbox.service';
import {
  broadcastToTransporters as broadcastToTransportersFn,
  processProgressiveBroadcastStep as processProgressiveBroadcastStepFn,
  broadcastVehicleTypePayload as broadcastVehicleTypePayloadFn,
  emitBroadcastStateChanged as emitBroadcastStateChangedFn,
  emitToTransportersWithAdaptiveFanout as emitToTransportersWithAdaptiveFanoutFn,
  emitDriverCancellationEvents as emitDriverCancellationEventsFn,
  buildRequestsByType as buildRequestsByTypeFn,
  getNotifiedTransporters as getNotifiedTransportersFn,
  markTransportersNotified as markTransportersNotifiedFn,
  chunkTransporterIds as chunkTransporterIdsFn,
  notifiedTransportersKey as notifiedTransportersKeyFn,
  makeVehicleGroupKey as makeVehicleGroupKeyFn,
  parseVehicleGroupKey as parseVehicleGroupKeyFn,
  getTransportersByVehicleCached as getTransportersByVehicleCachedFn,
  invalidateTransporterCache as invalidateTransporterCacheFn,
  withEventMeta as withEventMetaFn,
  clearCustomerActiveBroadcast as clearCustomerActiveBroadcastFn,
  scheduleNextProgressiveStep as scheduleNextProgressiveStepFn,
  orderBroadcastStepTimerKey as orderBroadcastStepTimerKeyFn,
  FF_BROADCAST_STRICT_SENT_ACCOUNTING,
} from './order-broadcast.service';
import {
  orderExpiryTimerKey as orderExpiryTimerKeyFn,
  setOrderExpiryTimer as setOrderExpiryTimerFn,
  clearProgressiveStepTimers as clearProgressiveStepTimersFn,
  processExpiredTimers as processExpiredTimersFn,
  stopOrderTimerChecker as stopOrderTimerCheckerFn,
} from './order-timer.service';
import {
  deriveTruckCancelStage as deriveTruckCancelStageFn,
  calculateWaitingCharges as calculateWaitingChargesFn,
  createMoneyBreakdown as createMoneyBreakdownFn,
  evaluateTruckCancelPolicy as evaluateTruckCancelPolicyFn,
  getCancelPreview as getCancelPreviewFn,
  createCancelDispute as createCancelDisputeFn,
} from './order-cancel-policy.service';
import {
  FF_CANCEL_EVENT_VERSION_ENFORCED,
  FF_CANCEL_REBOOK_CHURN_GUARD,
  FF_CANCEL_DEFERRED_SETTLEMENT,
  FF_CANCEL_IDEMPOTENCY_REQUIRED,
  cancelOrder as cancelOrderFn,
  buildCancelPayloadHash as buildCancelPayloadHashFn,
  getCancelIdempotentResponse as getCancelIdempotentResponseFn,
  persistCancelIdempotentResponse as persistCancelIdempotentResponseFn,
  registerCancelRebookChurn as registerCancelRebookChurnFn,
  enforceCancelRebookCooldown as enforceCancelRebookCooldownFn,
} from './order-cancel.service';
import {
  acceptTruckRequest as acceptTruckRequestFn,
} from './order-accept.service';
// F-A-50: Centralized feature flag + smart-timeout service for consolidated path
import { FLAGS, isEnabled } from '../../shared/config/feature-flags';
import { smartTimeoutService } from '../order-timeout';

// =============================================================================
// CACHE KEYS & TTL (Optimized for fast lookups)
// =============================================================================
const CACHE_KEYS = {
  ORDER: 'order:',
  ACTIVE_REQUESTS: 'active:requests:'
};

const CACHE_TTL = {
  ORDER: 60,            // 1 minute - order details
  ACTIVE_REQUESTS: 30   // 30 seconds - active requests list
};

const FF_DB_STRICT_IDEMPOTENCY = process.env.FF_DB_STRICT_IDEMPOTENCY !== 'false';

// M-20 FIX: In-memory backpressure fallback when Redis is unavailable.
// Not as accurate as Redis (per-instance only), but prevents total flood.
let inMemoryInflight = 0;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Vehicle requirement in a booking
 * Customer can request multiple types in one booking
 */
export interface VehicleRequirement {
  vehicleType: string;      // e.g., "tipper", "container", "open"
  vehicleSubtype: string;   // e.g., "20-24 Ton", "17ft"
  quantity: number;         // How many trucks of this type
  pricePerTruck: number;    // Price for this specific type
}

/**
 * Route Point for intermediate stops
 * 
 * IMPORTANT: Stops are defined BEFORE booking only!
 * After booking: NO adding, removing, or reordering
 */
export interface RoutePointInput {
  type: 'PICKUP' | 'STOP' | 'DROP';
  latitude: number;
  longitude: number;
  address: string;
  city?: string;
  state?: string;
}

/**
 * Create order request from customer app
 * 
 * ROUTE POINTS:
 * - Option 1: Full route with stops (routePoints array)
 * - Option 2: Simple pickup/drop (legacy, backward compatible)
 * 
 * If routePoints is provided, pickup/drop are extracted from first/last points
 */
export interface CreateOrderRequest {
  customerId: string;
  customerName: string;
  customerPhone: string;

  // Option 1: Full route with intermediate stops (NEW - preferred)
  routePoints?: RoutePointInput[];

  // Option 2: Simple pickup/drop (LEGACY - backward compatible)
  pickup?: {
    latitude: number;
    longitude: number;
    address: string;
    city?: string;
    state?: string;
  };
  drop?: {
    latitude: number;
    longitude: number;
    address: string;
    city?: string;
    state?: string;
  };

  distanceKm: number;

  // Multiple vehicle types
  vehicleRequirements: VehicleRequirement[];

  // Optional
  goodsType?: string;
  cargoWeightKg?: number;
  scheduledAt?: string;  // For scheduled bookings

  // SCALABILITY: Idempotency key prevents duplicate orders on network retry
  idempotencyKey?: string;  // UUID from client (optional)
}

/**
 * Response after creating order
 */
export interface CreateOrderResponse {
  orderId: string;
  totalTrucks: number;
  totalAmount: number;
  dispatchState: 'queued' | 'dispatching' | 'dispatched' | 'dispatch_failed';
  dispatchAttempts: number;
  onlineCandidates: number;
  notifiedTransporters: number;
  reasonCode?: string;
  serverTimeMs: number;
  truckRequests: {
    id: string;
    vehicleType: string;
    vehicleSubtype: string;
    quantity: number;
    pricePerTruck: number;
    matchingTransporters: number;
  }[];
  expiresAt: string;
  expiresIn: number;  // SCALABILITY: Duration in seconds - UI uses this for countdown timer
}

export { ActiveTruckRequestOrderGroup } from './order-query.service';

// =============================================================================
// SERVICE CLASS
// =============================================================================

class OrderService {

  // Timeout for broadcasts (used by createOrder for expiry calculation)
  private readonly BROADCAST_TIMEOUT_MS = parseInt(process.env.BROADCAST_TIMEOUT_SECONDS || '120', 10) * 1000;
  private outboxWorkerTimer: NodeJS.Timeout | null = null;
  private outboxWorkerRunning = false;
  private lifecycleOutboxWorkerTimer: NodeJS.Timeout | null = null;
  private lifecycleOutboxWorkerRunning = false;
  // Fix B10: Graceful shutdown flag
  private isShuttingDown = false;

  constructor() {
    if (FF_ORDER_DISPATCH_OUTBOX && process.env.NODE_ENV !== 'test') {
      this.startDispatchOutboxWorker();
    }
    if (FF_CANCEL_OUTBOX_ENABLED && process.env.NODE_ENV !== 'test') {
      this.startLifecycleOutboxWorker();
    }

    // Fix B10: SIGTERM/SIGINT graceful shutdown for outbox workers
    if (process.env.NODE_ENV !== 'test') {
      const shutdownHandler = () => {
        logger.info('[OrderService] SIGTERM/SIGINT received, stopping outbox polling...');
        this.isShuttingDown = true;
        if (this.outboxWorkerTimer) {
          clearInterval(this.outboxWorkerTimer);
          this.outboxWorkerTimer = null;
        }
        if (this.lifecycleOutboxWorkerTimer) {
          clearInterval(this.lifecycleOutboxWorkerTimer);
          this.lifecycleOutboxWorkerTimer = null;
        }
      };
      process.on('SIGTERM', shutdownHandler);
      process.on('SIGINT', shutdownHandler);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle Outbox Delegates (extracted to order-lifecycle-outbox.service.ts)
  // ---------------------------------------------------------------------------

  private startLifecycleOutboxWorker(): void {
    this.lifecycleOutboxWorkerTimer = startLifecycleOutboxWorkerFn({
      lifecycleOutboxWorkerTimer: this.lifecycleOutboxWorkerTimer,
      lifecycleOutboxWorkerRunning: this.lifecycleOutboxWorkerRunning,
      isShuttingDown: this.isShuttingDown
    });
  }

  private async enqueueCancelLifecycleOutbox(
    payload: OrderLifecycleOutboxPayload,
    tx?: Prisma.TransactionClient
  ): Promise<string> {
    return enqueueCancelLifecycleOutboxFn(payload, tx);
  }

  private async processLifecycleOutboxImmediately(outboxId: string): Promise<void> {
    return processLifecycleOutboxImmediatelyFn(outboxId);
  }

  private async emitCancellationLifecycle(payload: OrderCancelledOutboxPayload): Promise<void> {
    return emitCancellationLifecycleFn(payload);
  }

  // ---------------------------------------------------------------------------
  // Dispatch Outbox Delegates (extracted to order-dispatch-outbox.service.ts)
  // ---------------------------------------------------------------------------

  private startDispatchOutboxWorker(): void {
    this.outboxWorkerTimer = startDispatchOutboxWorkerFn({
      outboxWorkerTimer: this.outboxWorkerTimer,
      outboxWorkerRunning: this.outboxWorkerRunning,
      isShuttingDown: this.isShuttingDown
    });
  }

  private async enqueueOrderDispatchOutbox(orderId: string, tx?: Prisma.TransactionClient): Promise<void> {
    return enqueueOrderDispatchOutboxFn(orderId, tx);
  }

  private async processDispatchOutboxImmediately(
    orderId: string,
    context: DispatchAttemptContext
  ): Promise<DispatchAttemptOutcome | null> {
    return processDispatchOutboxImmediatelyFn(orderId, context);
  }

  // ---------------------------------------------------------------------------
  // Broadcast Delegates (extracted to order-broadcast.service.ts)
  // ---------------------------------------------------------------------------

  // Public bridge methods kept for cross-module access from outbox services.
  // These delegate to standalone functions in order-broadcast.service.ts.
  broadcastToTransportersPublic(
    orderId: string,
    request: CreateOrderRequest,
    truckRequests: TruckRequestRecord[],
    expiresAt: string,
    pickup: { latitude: number; longitude: number; address: string; city?: string; state?: string }
  ) {
    return broadcastToTransportersFn(orderId, request, truckRequests, expiresAt, pickup);
  }

  emitBroadcastStateChangedPublic(
    customerId: string,
    payload: {
      orderId: string;
      status: string;
      dispatchState?: string;
      dispatchAttempts?: number;
      reasonCode?: string;
      onlineCandidates?: number;
      notifiedTransporters?: number;
      stateChangedAt?: string;
    }
  ): void {
    emitBroadcastStateChangedFn(customerId, payload);
  }

  emitToTransportersWithAdaptiveFanoutPublic(
    transporterIds: string[],
    events: Array<{ event: string; payload: Record<string, unknown> }>,
    context: string
  ): Promise<void> {
    return emitToTransportersWithAdaptiveFanoutFn(transporterIds, events, context);
  }

  emitDriverCancellationEventsPublic(
    driverId: string,
    payload: {
      orderId: string;
      tripId?: string | null;
      reason: string;
      message: string;
      cancelledAt?: string;
      customerName?: string;
      customerPhone?: string;
      pickupAddress?: string;
      dropAddress?: string;
      compensationAmount?: number;
      settlementState?: string;
    }
  ): void {
    return emitDriverCancellationEventsFn(driverId, payload);
  }

  withEventMetaPublic<T extends Record<string, unknown>>(payload: T, eventId?: string): T & { eventId: string; emittedAt: string } {
    return withEventMetaFn(payload, eventId);
  }

  orderExpiryTimerKeyPublic(orderId: string): string {
    return orderExpiryTimerKeyFn(orderId);
  }

  async clearProgressiveStepTimersPublic(orderId: string): Promise<void> {
    return clearProgressiveStepTimersFn(orderId);
  }

  async clearCustomerActiveBroadcastPublic(customerId: string): Promise<void> {
    return clearCustomerActiveBroadcastFn(customerId);
  }

  private orderBroadcastStepTimerKey(
    orderId: string,
    vehicleType: string,
    vehicleSubtype: string,
    stepIndex: number
  ): string {
    return orderBroadcastStepTimerKeyFn(orderId, vehicleType, vehicleSubtype, stepIndex);
  }

  private notifiedTransportersKey(orderId: string, vehicleType: string, vehicleSubtype: string): string {
    return notifiedTransportersKeyFn(orderId, vehicleType, vehicleSubtype);
  }

  private makeVehicleGroupKey(vehicleType: string, vehicleSubtype: string): string {
    return makeVehicleGroupKeyFn(vehicleType, vehicleSubtype);
  }

  private parseVehicleGroupKey(groupKey: string): { vehicleType: string; vehicleSubtype: string } {
    return parseVehicleGroupKeyFn(groupKey);
  }

  private buildRequestPayloadHash(request: CreateOrderRequest): string {
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

  private async getDbIdempotentResponse(
    customerId: string,
    idempotencyKey: string,
    payloadHash: string
  ): Promise<CreateOrderResponse | null> {
    const row = await prismaClient.orderIdempotency.findUnique({
      where: { customerId_idempotencyKey: { customerId, idempotencyKey } }
    });
    if (!row) return null;
    if (row.payloadHash !== payloadHash) {
      if (!FF_DB_STRICT_IDEMPOTENCY) {
        logger.warn('Idempotency key reused with different payload while strict mode is disabled', {
          customerId,
          idempotencyKey: `${idempotencyKey.substring(0, 8)}...`
        });
        return null;
      }
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key reused with different payload');
    }
    return row.responseJson as unknown as CreateOrderResponse;
  }

  private async persistDbIdempotentResponse(
    customerId: string,
    idempotencyKey: string,
    payloadHash: string,
    orderId: string,
    response: CreateOrderResponse
  ): Promise<void> {
    try {
      await prismaClient.orderIdempotency.create({
        data: {
          id: uuidv4(),
          customerId,
          idempotencyKey,
          payloadHash,
          orderId,
          responseJson: response as unknown as Prisma.InputJsonValue
        }
      });
    } catch (error: unknown) {
      const prismaError = error as { code?: string };
      if (prismaError?.code !== 'P2002') {
        throw error;
      }
      const existing = await this.getDbIdempotentResponse(customerId, idempotencyKey, payloadHash);
      if (!existing) {
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key conflict');
      }
    }
  }

  // ===========================================================================
  // CACHED LOOKUPS (Optimized for millions of requests)
  // ===========================================================================

  // ==========================================================================
  // RATE LIMITING (Redis-based for cluster support)
  // ==========================================================================

  /**
   * Check if request is within rate limit
   * 
   * SCALABILITY: Uses Redis for distributed rate limiting
   * - Works across all server instances
   * - Atomic increment prevents race conditions
   * - Automatic TTL cleanup
   * 
   * @param key Unique key for rate limiting (e.g., "order_create:userId")
   * @param limit Maximum requests allowed
   * @param windowSeconds Time window in seconds
   * @returns { allowed: boolean, retryAfter: number }
   */
  async checkRateLimit(
    key: string,
    limit: number,
    windowSeconds: number
  ): Promise<{ allowed: boolean; retryAfter: number }> {
    const result = await redisService.checkRateLimit(`ratelimit:order:${key}`, limit, windowSeconds);

    return {
      allowed: result.allowed,
      retryAfter: result.allowed ? 0 : result.resetIn
    };
  }

  // ==========================================================================
  // TRANSPORTER LOOKUP (CACHED)
  // ==========================================================================

  /**
   * Get transporters by vehicle type (CACHED + AVAILABILITY FILTERED)
   * Uses cache to avoid repeated DB queries during high-load broadcasts
   * 
   * IMPORTANT: Only returns transporters who are:
   * 1. Have matching vehicle type
   * 2. Are marked as "available" (online toggle is ON)
   * 
   * NOTE: cacheService.get() already handles JSON parsing, so we don't need
   * to call JSON.parse() again on the cached value!
   */
  private async getTransportersByVehicleCached(
    vehicleType: string,
    vehicleSubtype: string
  ): Promise<string[]> {
    return getTransportersByVehicleCachedFn(vehicleType, vehicleSubtype);
  }

  /**
   * Invalidate transporter cache when vehicles change
   */
  async invalidateTransporterCache(vehicleType: string, vehicleSubtype?: string): Promise<void> {
    return invalidateTransporterCacheFn(vehicleType, vehicleSubtype);
  }

  /**
   * Create a new order with multiple vehicle types
   * 
   * SCALABILITY NOTES:
   * - For millions of users, this should be moved to a message queue
   * - Each vehicle type can be processed in parallel
   * - Database writes should be batched
   * - Idempotency prevents duplicate processing on retry
   * 
   * ROUTE POINTS:
   * - If routePoints provided, use them directly
   * - If only pickup/drop provided, build routePoints from them
   * - routePoints are IMMUTABLE after creation
   */
  async createOrder(request: CreateOrderRequest): Promise<CreateOrderResponse> {
    // Fix B11: Redis-based system-wide backpressure -- shed load before heavy work
    const BACKPRESSURE_KEY = 'order:create:inflight';
    const MAX_CONCURRENT_ORDERS = Math.max(10, Math.min(1000, parseInt(process.env.ORDER_MAX_CONCURRENT_CREATES || '200', 10)));
    // FIX-35: Track whether in-memory fallback was used so we only decrement
    // the in-memory counter when it was actually incremented. Prevents counter
    // drift when Redis succeeds for increment but fails for decrement (or vice versa).
    let usedInMemoryFallback = false;
    try {
      const inflight = await redisService.incrBy(BACKPRESSURE_KEY, 1);
      // Set TTL on first use (safety net for stale counters)
      // H-P6 FIX: Log backpressure TTL refresh failures instead of silently ignoring
      await redisService.expire(BACKPRESSURE_KEY, 300).catch((err: unknown) => { logger.warn('[ORDER] Backpressure TTL refresh failed', { error: err instanceof Error ? err.message : String(err) }); });
      if (inflight > MAX_CONCURRENT_ORDERS) {
        await redisService.incrBy(BACKPRESSURE_KEY, -1).catch((err: unknown) => { logger.warn('[ORDER] Backpressure decrement failed', { error: err instanceof Error ? err.message : String(err) }); });
        logger.warn('[ORDER] System backpressure: too many concurrent order creates', { inflight, max: MAX_CONCURRENT_ORDERS });
        throw new AppError(503, 'SYSTEM_BUSY', 'System is processing too many orders. Please retry in a few seconds.');
      }
    } catch (err: unknown) {
      // If Redis fails, use in-memory fallback instead of allowing everything through
      if (err instanceof AppError) throw err;
      // M-20 FIX: In-memory backpressure fallback when Redis is unavailable
      const IN_MEMORY_MAX = Math.ceil(MAX_CONCURRENT_ORDERS / 4); // Per-instance share
      inMemoryInflight++;
      // FIX-35: Mark that in-memory counter was incremented
      usedInMemoryFallback = true;
      if (inMemoryInflight > IN_MEMORY_MAX) {
        inMemoryInflight--;
        // FIX-35: Rejection already decremented, reset flag
        usedInMemoryFallback = false;
        logger.warn('[ORDER] In-memory backpressure triggered (Redis unavailable)', { inMemoryInflight, max: IN_MEMORY_MAX });
        throw new AppError(503, 'SYSTEM_BUSY', 'System is processing too many orders. Please retry in a few seconds.');
      }
      logger.warn('[ORDER] Backpressure counter failed, using in-memory fallback', { error: (err as Error).message, inMemoryInflight, max: IN_MEMORY_MAX });
    }

    try {
    // Hard server-side validation (defense-in-depth in addition to route schema)
    if (!Array.isArray(request.vehicleRequirements) || request.vehicleRequirements.length === 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'At least one truck requirement is required');
    }
    const invalidQuantity = request.vehicleRequirements.find((item) => item.quantity <= 0);
    if (invalidQuantity) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Truck quantity must be greater than zero');
    }
    const totalTrucks = request.vehicleRequirements.reduce((sum, item) => sum + item.quantity, 0);
    if (totalTrucks > 50) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Maximum 50 trucks per order');
    }
    const requestPayloadHash = this.buildRequestPayloadHash(request);

    await this.enforceCancelRebookCooldown(request.customerId);

    // ==========================================================================
    // PER-CUSTOMER ORDER DEBOUNCE (3 second cooldown)
    // ==========================================================================
    // SCALABILITY: Redis-based, works across all server instances
    // EASY UNDERSTANDING: Prevents rapid-fire different orders from same customer
    // MODULARITY: Independent of idempotency (which checks same request, this
    //             checks same customer making ANY request too quickly)
    // CODING STANDARDS: Uses Redis SETNX for atomic check-and-set
    //
    // NOTE: Idempotency = same request retried. Debounce = different requests
    //       submitted too quickly. Both are needed for production safety.
    // ==========================================================================
    const DEBOUNCE_SECONDS = 3;
    const debounceKey = `debounce:order:${request.customerId}`;

    try {
      const debounceActive = await redisService.get(debounceKey);
      if (debounceActive) {
        logger.warn(`⚠️ ORDER DEBOUNCE: Customer ${request.customerId} tried to place order within ${DEBOUNCE_SECONDS}s cooldown`);
        throw new AppError(429, 'RATE_LIMITED', 'Please wait a few seconds before placing another order.');
      }
      // Set debounce key — auto-expires after 3 seconds
      await redisService.set(debounceKey, '1', DEBOUNCE_SECONDS);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // If error is our debounce AppError, rethrow it
      if (error instanceof AppError) throw error;
      // If Redis fails, skip debounce (don't block orders)
      logger.warn(`⚠️ Debounce check failed: ${message}. Proceeding without debounce.`);
    }

    // ==========================================================================
    // IDEMPOTENCY CHECK - Prevents duplicate orders on network retry
    // ==========================================================================
    // SCALABILITY: Uses Redis for fast lookup across all server instances
    // EASY UNDERSTANDING: Same idempotency key = return cached response
    // MODULARITY: Can be called multiple times safely
    // ==========================================================================
    if (request.idempotencyKey) {
      const cacheKey = `idempotency:${request.customerId}:${request.idempotencyKey}`;

      try {
        const cached = await redisService.get(cacheKey);
        if (cached) {
          const cachedResponse = JSON.parse(cached) as CreateOrderResponse;
          logger.info(`✅ Idempotency HIT: Returning cached order ${cachedResponse.orderId.substring(0, 8)}... for key ${request.idempotencyKey.substring(0, 8)}...`);
          return cachedResponse;
        }
        logger.debug(`🔍 Idempotency MISS: Processing new order for key ${request.idempotencyKey.substring(0, 8)}...`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`⚠️ Idempotency cache error: ${message}. Proceeding with order creation.`);
        // Continue with order creation even if cache fails
      }

      const dbReplay = await this.getDbIdempotentResponse(
        request.customerId,
        request.idempotencyKey,
        requestPayloadHash
      );
      if (dbReplay) {
        logger.info('✅ DB Idempotency HIT: returning stored response', {
          customerId: request.customerId,
          idempotencyKey: `${request.idempotencyKey.substring(0, 8)}...`,
          orderId: dbReplay.orderId
        });
        return dbReplay;
      }
    }

    // ========================================
    // ONE-ACTIVE-BROADCAST-PER-CUSTOMER GUARD
    // ========================================
    const activeKey = `customer:active-broadcast:${request.customerId}`;
    let existingBroadcastId: string | null = null;
    try {
      existingBroadcastId = await redisService.get(activeKey);
    } catch (err) {
      logger.warn('Redis sentinel dedup check failed, proceeding without cache', { orderId: request.customerId, error: (err as Error).message });
    }
    if (existingBroadcastId) {
      throw new AppError(409, 'ACTIVE_ORDER_EXISTS', 'You already have an active order');
    }

    const lockKey = `customer-broadcast-create:${request.customerId}`;
    let lock: { acquired: boolean } = { acquired: false };
    try {
      lock = await redisService.acquireLock(lockKey, request.customerId, 10);
    } catch (err) {
      logger.warn('Redis acquireLock failed, proceeding without lock', { orderId: request.customerId, error: (err as Error).message });
      metrics.incrementCounter('order_create_lock_fallback_total');
      lock = { acquired: true }; // skip lock on failure; DB unique constraint is the guarantee
    }
    if (!lock.acquired) {
      throw new AppError(409, 'LOCK_CONTENTION', 'Order creation in progress, please wait');
    }

    try {
      // DB authoritative check (covers Redis failure edge case)
      const existingBooking = await prismaClient.booking.findFirst({
        where: { customerId: request.customerId, status: { in: [BookingStatus.created, BookingStatus.broadcasting, BookingStatus.active, BookingStatus.partially_filled] } }
      });
      const existingOrder = await prismaClient.order.findFirst({
        where: { customerId: request.customerId, status: { in: [OrderStatus.created, OrderStatus.broadcasting, OrderStatus.active, OrderStatus.partially_filled] } }
      });
      if (existingBooking || existingOrder) {
        throw new AppError(409, 'ACTIVE_ORDER_EXISTS', 'You already have an active order');
      }

      // ========================================
      // SERVER-GENERATED IDEMPOTENCY (double-tap / retry protection)
      // ========================================
      // Extract pickup/drop coords from routePoints or legacy fields
      const idemPickup = request.routePoints?.[0] || request.pickup;
      const idemDrop = request.routePoints?.[request.routePoints?.length ? request.routePoints.length - 1 : 0] || request.drop;
      const truckTypesSorted = request.vehicleRequirements
        .map(t => `${t.vehicleType}:${t.vehicleSubtype || ''}:${t.quantity}`)
        .sort()
        .join('|');
      const idempotencyFingerprint = [
        request.customerId,
        truckTypesSorted,
        roundCoord(idemPickup?.latitude || 0),
        roundCoord(idemPickup?.longitude || 0),
        roundCoord(idemDrop?.latitude || 0),
        roundCoord(idemDrop?.longitude || 0)
      ].join(':');
      const idempotencyHash = crypto.createHash('sha256').update(idempotencyFingerprint).digest('hex').substring(0, 32);
      const dedupeKey = `idem:broadcast:create:${request.customerId}:${idempotencyHash}`;

      let existingDedupeId: string | null = null;
      try {
        existingDedupeId = await redisService.get(dedupeKey);
      } catch (err) {
        logger.warn('Redis dedup check failed, proceeding without cache', { orderId: request.customerId, error: (err as Error).message });
      }
      if (existingDedupeId) {
        const existingDedupeOrder = await db.getOrderById(existingDedupeId);
        if (existingDedupeOrder && !['cancelled', 'expired'].includes(existingDedupeOrder.status)) {
          logger.info('Idempotent replay: returning existing order', { orderId: existingDedupeId, idempotencyHash });
          const totalTrucks = request.vehicleRequirements.reduce((sum, req) => sum + req.quantity, 0);
          const totalAmount = request.vehicleRequirements.reduce((sum, req) => sum + (req.quantity * req.pricePerTruck), 0);
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

      const orderId = uuidv4();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.BROADCAST_TIMEOUT_MS).toISOString();

      // Calculate totals
      const totalTrucks = request.vehicleRequirements.reduce((sum, req) => sum + req.quantity, 0);
      if (totalTrucks <= 0) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Total trucks must be greater than zero');
      }

      // ==========================================================================
      // SERVER-SIDE ROUTE DISTANCE (Google Directions API)
      // ==========================================================================
      // The customer app sends distanceKm which may be Haversine (straight-line)
      // or stale. We recalculate using Google Directions API for accurate road
      // distance. Falls back to customer value if Google fails — never blocks orders.
      //
      // MUST run BEFORE price validation so pricing uses accurate distance.
      // googleMapsService.calculateRoute() has built-in 1hr cache — same route
      // requested 1000x = 1 Google API call.
      // ==========================================================================
      const clientDistanceKm = request.distanceKm;
      let distanceSource: 'google' | 'client_fallback' = 'client_fallback';

      try {
        // Build route points for Google API: pickup → waypoints → drop
        const routePointsForGoogle: Array<{ lat: number; lng: number }> = [];

        if (request.routePoints && request.routePoints.length >= 2) {
          for (const point of request.routePoints) {
            routePointsForGoogle.push({ lat: point.latitude, lng: point.longitude });
          }
        } else if (request.pickup && request.drop) {
          routePointsForGoogle.push(
            { lat: request.pickup.latitude, lng: request.pickup.longitude },
            { lat: request.drop.latitude, lng: request.drop.longitude }
          );
        }

        if (routePointsForGoogle.length >= 2) {
          // Truck mode: OFF by default. When FF_TRUCK_MODE_ROUTING=true,
          // heavy vehicles avoid highways/tolls for truck-accurate routing.
          const FF_TRUCK_MODE_ROUTING = process.env.FF_TRUCK_MODE_ROUTING === 'true';
          const HEAVY_VEHICLE_TYPES = new Set(['open', 'container', 'tipper', 'flatbed']);
          const primaryVehicleType = request.vehicleRequirements[0]?.vehicleType || '';
          const useTruckMode = FF_TRUCK_MODE_ROUTING && HEAVY_VEHICLE_TYPES.has(primaryVehicleType);

          const googleRoute = await googleMapsService.calculateRoute(
            routePointsForGoogle,
            useTruckMode
          );

          if (googleRoute && googleRoute.distanceKm > 0) {
            request.distanceKm = googleRoute.distanceKm;
            distanceSource = 'google';

            const deltaPercent = clientDistanceKm > 0
              ? Math.round(((googleRoute.distanceKm - clientDistanceKm) / clientDistanceKm) * 100)
              : 0;

            logger.info('[ORDER] Route distance calculated via Google Directions', {
              distanceSource: 'google',
              clientDistanceKm,
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
              clientDistanceKm,
              reason: 'google_returned_empty'
            });
          }
        }
      } catch (routeError: any) {
        // Google API failure — keep customer distance, never block order creation
        logger.warn('[ORDER] Google Directions API failed — using client distance', {
          distanceSource: 'client_fallback',
          clientDistanceKm,
          reason: routeError?.message || 'unknown'
        });
      }

      // FIX-8: Haversine floor validation when using client-provided distance.
      // Client distance may be stale, zero, or manipulated. Apply a minimum floor
      // of haversine * 1.3 (India road circuity factor) so pricing is never based
      // on an impossibly low distance value.
      // Note: local pickup/drop variables are declared later, so derive coords from request fields.
      const haversinePickup = request.routePoints?.[0] || request.pickup;
      const haversineDrop = request.routePoints?.[request.routePoints?.length ? request.routePoints.length - 1 : 0] || request.drop;
      if (distanceSource === 'client_fallback' && haversinePickup && haversineDrop) {
        const haversineDist = haversineDistanceKm(
          haversinePickup.latitude, haversinePickup.longitude,
          haversineDrop.latitude, haversineDrop.longitude
        );
        if (haversineDist > 0) {
          const haversineFloor = Math.ceil(haversineDist * 1.3);
          if (request.distanceKm < haversineFloor) {
            logger.warn('[ORDER] Client distance below haversine floor — correcting', {
              clientDistanceKm: request.distanceKm,
              haversineKm: haversineDist,
              haversineFloor,
              orderId
            });
            request.distanceKm = haversineFloor;
          }

          // Ceiling: cap absurdly high client distances
          const haversineCeiling = Math.ceil(haversineDist * 3.0);
          if (request.distanceKm > haversineCeiling) {
            logger.warn('[ORDER] Client distance exceeds ceiling, capping', {
              clientDistance: request.distanceKm,
              haversineDist,
              ceiling: haversineCeiling
            });
            request.distanceKm = haversineCeiling;
          }
        }
      }

      // ==========================================================================
      // SECURITY: Server-side price validation
      // ==========================================================================
      // Recalculate prices server-side to prevent client-side price tampering.
      // The client-submitted pricePerTruck is compared against the server-calculated
      // price. If the client price is lower (manipulated), we use the server price.
      // A tolerance of 5% is allowed for rounding/timing differences (e.g., surge).
      // ==========================================================================
      const PRICE_TOLERANCE = 0.05; // 5% tolerance for rounding/surge timing

      for (const req of request.vehicleRequirements) {
        try {
          const serverEstimate = pricingService.calculateEstimate({
            vehicleType: req.vehicleType,
            vehicleSubtype: req.vehicleSubtype,
            distanceKm: request.distanceKm,
            trucksNeeded: req.quantity,
            cargoWeightKg: request.cargoWeightKg
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
          logger.warn(`⚠️ Price validation failed for ${req.vehicleType}: ${message}. Using client price.`);
          // If pricing service fails, allow client price to avoid blocking orders
        }
      }

      const totalAmount = Math.round(
        request.vehicleRequirements.reduce(
          (sum, req) => sum + (req.quantity * req.pricePerTruck),
          0
        ) * 100
      ) / 100;

      // ==========================================================================
      // BUILD ROUTE POINTS (with intermediate stops support)
      // ==========================================================================
      // 
      // INPUT OPTIONS:
      // 1. routePoints array (NEW) - directly use these
      // 2. pickup + drop (LEGACY) - build routePoints from them
      //
      // OUTPUT: routePoints array with auto-assigned stopIndex
      // ==========================================================================

      let routePoints: { type: 'PICKUP' | 'STOP' | 'DROP'; latitude: number; longitude: number; address: string; city?: string; state?: string; stopIndex: number }[];
      let pickup: { latitude: number; longitude: number; address: string; city?: string; state?: string };
      let drop: { latitude: number; longitude: number; address: string; city?: string; state?: string };

      if (request.routePoints && request.routePoints.length >= 2) {
        // NEW: Use provided routePoints
        routePoints = request.routePoints.map((point, index) => ({
          ...point,
          stopIndex: index
        }));

        // Extract pickup (first) and drop (last) for backward compatibility
        const firstPoint = request.routePoints[0];
        const lastPoint = request.routePoints[request.routePoints.length - 1];

        pickup = {
          latitude: firstPoint.latitude,
          longitude: firstPoint.longitude,
          address: firstPoint.address,
          city: firstPoint.city,
          state: firstPoint.state
        };

        drop = {
          latitude: lastPoint.latitude,
          longitude: lastPoint.longitude,
          address: lastPoint.address,
          city: lastPoint.city,
          state: lastPoint.state
        };

        logger.info(`📍 Route has ${routePoints.length} points (${routePoints.filter(p => p.type === 'STOP').length} intermediate stops)`);
      } else if (request.pickup && request.drop) {
        // LEGACY: Build routePoints from pickup + drop
        pickup = request.pickup;
        drop = request.drop;

        routePoints = [
          { type: 'PICKUP', ...pickup, stopIndex: 0 },
          { type: 'DROP', ...drop, stopIndex: 1 }
        ];

        logger.info(`📍 Route has 2 points (no intermediate stops)`);
      } else {
        // SCALABILITY: Use structured error code for monitoring
        // EASY UNDERSTANDING: Clear validation error message
        // MODULARITY: Consistent with other validation errors
        // CODING STANDARDS: REST API error response pattern
        throw new Error('Either routePoints OR both pickup and drop must be provided'); // TODO(LEO-L2): Replace with ValidationError when imported
      }

      const stopsCount = routePoints.filter(p => p.type === 'STOP').length;

      logger.info(`╔══════════════════════════════════════════════════════════════╗`);
      logger.info(`║  🚛 NEW MULTI-VEHICLE ORDER                                   ║`);
      logger.info(`╠══════════════════════════════════════════════════════════════╣`);
      logger.info(`║  Order ID: ${orderId.substring(0, 8)}...`);
      logger.info(`║  Customer: ${request.customerName}`);
      logger.info(`║  Total Trucks: ${totalTrucks}`);
      logger.info(`║  Total Amount: ₹${totalAmount}`);
      logger.info(`║  Vehicle Types: ${request.vehicleRequirements.length}`);
      request.vehicleRequirements.forEach((req, i) => {
        logger.info(`║    ${i + 1}. ${req.quantity}x ${req.vehicleType} (${req.vehicleSubtype}) @ ₹${req.pricePerTruck}`);
      });
      logger.info(`║  Route Points: ${routePoints.length} (${stopsCount} stops)`);
      routePoints.forEach((point, i) => {
        logger.info(`║    ${i}. [${point.type}] ${point.address.substring(0, 40)}...`);
      });
      logger.info(`╚══════════════════════════════════════════════════════════════╝`);

      // 1. Create the parent Order
      const order: Omit<OrderRecord, 'createdAt' | 'updatedAt'> = {
        id: orderId,
        customerId: request.customerId,
        customerName: request.customerName,
        customerPhone: request.customerPhone,

        // Route points (NEW - with intermediate stops)
        routePoints,
        currentRouteIndex: 0,        // Start at pickup
        stopWaitTimers: [],          // Empty until driver reaches stops

        // Legacy pickup/drop (for backward compatibility)
        pickup,
        drop,

        distanceKm: request.distanceKm,
        totalTrucks,
        trucksFilled: 0,
        totalAmount,
        goodsType: request.goodsType,
        cargoWeightKg: request.cargoWeightKg,
        status: 'created',
        stateChangedAt: new Date(),
        dispatchState: 'queued',
        dispatchAttempts: 0,
        dispatchReasonCode: null,
        onlineCandidatesCount: 0,
        notifiedCount: 0,
        lastDispatchAt: null,
        scheduledAt: request.scheduledAt,
        expiresAt
      };

      // 2. Prepare TruckRequests for each vehicle type
      const truckRequests: TruckRequestRecord[] = [];
      const responseRequests: CreateOrderResponse['truckRequests'] = [];
      let requestNumber = 1;

      for (const vehicleReq of request.vehicleRequirements) {
        // Create one TruckRequest per truck (not per type)
        // This allows each truck to be assigned independently
        for (let i = 0; i < vehicleReq.quantity; i++) {
          const truckRequestId = uuidv4();

          const truckRequest: Omit<TruckRequestRecord, 'createdAt' | 'updatedAt'> = {
            id: truckRequestId,
            orderId,
            requestNumber,
            vehicleType: vehicleReq.vehicleType,
            vehicleSubtype: vehicleReq.vehicleSubtype,
            pricePerTruck: vehicleReq.pricePerTruck,
            status: 'searching',
            notifiedTransporters: []
          };

          truckRequests.push(truckRequest as TruckRequestRecord);
          requestNumber++;
        }

        // Find matching transporters for this vehicle type
        const matchingTransporters = await db.getTransportersWithVehicleType(
          vehicleReq.vehicleType,
          vehicleReq.vehicleSubtype
        );

        responseRequests.push({
          id: truckRequests[truckRequests.length - 1].id,
          vehicleType: vehicleReq.vehicleType,
          vehicleSubtype: vehicleReq.vehicleSubtype,
          quantity: vehicleReq.quantity,
          pricePerTruck: vehicleReq.pricePerTruck,
          matchingTransporters: matchingTransporters.length
        });
      }

      let dispatchState: CreateOrderResponse['dispatchState'] = 'dispatching';
      let dispatchReasonCode: string | undefined;
      let dispatchAttempts = 1;
      let onlineCandidates = 0;
      let notifiedTransporters = 0;

      // M-12 VERIFIED: Order + TruckRequests + dispatch outbox are created atomically
      // inside a single Serializable transaction. If any step fails, all roll back.
      // Narrow serializable transaction: duplicate-check + order + truckRequests + dispatch outbox bootstrap.
      // This removes the crash window where order exists but outbox row does not.
      // withDbTimeout enforces statement_timeout=8s inside the TX — prevents pool exhaustion on DB slowness.
      await withDbTimeout(async (tx) => {
        const dupBooking = await tx.booking.findFirst({
          where: { customerId: request.customerId, status: { in: [BookingStatus.created, BookingStatus.broadcasting, BookingStatus.active, BookingStatus.partially_filled] } }
        });
        const dupOrder = await tx.order.findFirst({
          where: { customerId: request.customerId, status: { in: [OrderStatus.created, OrderStatus.broadcasting, OrderStatus.active, OrderStatus.partially_filled] } }
        });
        if (dupBooking || dupOrder) {
          throw new AppError(409, 'ACTIVE_ORDER_EXISTS', 'Request already in progress. Cancel it first.');
        }

        await tx.order.create({
          data: {
            ...order,
            routePoints: order.routePoints as any,
            stopWaitTimers: order.stopWaitTimers as any,
            pickup: order.pickup as any,
            drop: order.drop as any,
            status: order.status as OrderStatus
          }
        });

        if (truckRequests.length > 0) {
          await tx.truckRequest.createMany({
            data: truckRequests.map((truckRequest) => ({
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
          where: { id: orderId },
          data: {
            status: OrderStatus.broadcasting,
            stateChangedAt: new Date(),
            dispatchState: 'dispatching',
            dispatchAttempts,
            dispatchReasonCode: null,
            lastDispatchAt: new Date()
          }
        });

        if (FF_ORDER_DISPATCH_OUTBOX) {
          await this.enqueueOrderDispatchOutbox(orderId, tx);
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeoutMs: 8000 });

      // Emit lifecycle state: created
      this.emitBroadcastStateChanged(request.customerId, {
        orderId,
        status: 'created',
        dispatchState: 'queued',
        dispatchAttempts: 0
      });

      // Emit lifecycle state: broadcasting
      this.emitBroadcastStateChanged(request.customerId, {
        orderId,
        status: 'broadcasting',
        dispatchState: 'dispatching',
        dispatchAttempts
      });

      // 3. Dispatch through durable outbox (or fallback direct dispatch when flag disabled)
      const dispatchContext: DispatchAttemptContext = {
        request,
        truckRequests,
        expiresAt,
        pickup
      };

      if (FF_ORDER_DISPATCH_OUTBOX) {
        // F-A-50 / F-A-70 prep: when CREATE_ORDER_CONSOLIDATED is ON, await the
        // dispatch and use the DispatchAttemptOutcome to set real dispatchState /
        // notifiedTransporters instead of unconditionally stamping 'dispatching'.
        // Default (OFF): legacy fire-and-forget behavior — outbox poller retries.
        if (isEnabled(FLAGS.CREATE_ORDER_CONSOLIDATED)) {
          metrics.incrementCounter('order_create_path_total', { path: 'consolidated' });
          try {
            const outcome = await this.processDispatchOutboxImmediately(orderId, dispatchContext);
            if (outcome) {
              dispatchState = outcome.dispatchState;
              dispatchReasonCode = outcome.reasonCode;
              dispatchAttempts = outcome.dispatchAttempts;
              onlineCandidates = outcome.onlineCandidates;
              notifiedTransporters = outcome.notifiedTransporters;
            } else {
              // Null outcome = flag disabled inside helper / lock contention —
              // leave state as 'dispatching' and let outbox poller retry.
              dispatchState = 'dispatching';
              dispatchReasonCode = 'DISPATCH_RETRYING';
              dispatchAttempts = 1;
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error('[ORDER] Consolidated immediate dispatch threw', { orderId, error: message });
            dispatchState = 'dispatch_failed';
            dispatchReasonCode = 'DISPATCH_ERROR';
          }
        } else {
          metrics.incrementCounter('order_create_path_total', { path: 'legacy' });
          this.processDispatchOutboxImmediately(orderId, dispatchContext).catch(err =>
            logger.warn('Immediate dispatch failed, outbox poller will retry', { orderId, error: err.message })
          );
          dispatchState = 'dispatching';
          dispatchReasonCode = 'DISPATCH_RETRYING';
          dispatchAttempts = 1;
        }
      } else {
        // IMPORTANT: Wrapped in try-catch - dispatch errors should NEVER fail order creation
        try {
          const dispatchStats = await this.broadcastToTransporters(orderId, request, truckRequests, expiresAt, pickup);
          onlineCandidates = dispatchStats.onlineCandidates;
          notifiedTransporters = dispatchStats.notifiedTransporters;

          if (notifiedTransporters > 0) {
            dispatchState = 'dispatched';
          } else {
            dispatchState = 'dispatch_failed';
            dispatchReasonCode = dispatchStats.onlineCandidates === 0
              ? 'NO_ONLINE_TRANSPORTERS'
              : 'DISPATCH_RETRYING';
          }
        } catch (broadcastError: any) {
          // M-10 FIX: Use DISPATCH_ERROR (not DISPATCH_RETRYING) when broadcast throws
          dispatchState = 'dispatch_failed';
          dispatchReasonCode = 'DISPATCH_ERROR';
          logger.error(`[ORDER] Broadcast failed for order ${orderId}, marked dispatch_failed for retry`, {
            orderId,
            error: broadcastError.message,
            stack: broadcastError.stack
          });
        }
      }

      // FIX-14: Expire immediately when 0 transporters were notified.
      // Waiting the full broadcast timeout (120s) with zero supply wastes
      // the customer's time. Expire now and let them retry or widen the search.
      if (notifiedTransporters === 0 && dispatchState === 'dispatch_failed') {
        logger.warn('[Order] 0 transporters notified — expiring immediately', { orderId, onlineCandidates, dispatchReasonCode });
        // F-A-50 / FIX #74 port: assert the 'broadcasting'->'expired' edge is
        // valid in ORDER_VALID_TRANSITIONS before writing. Mirrors the delegate
        // path in order-creation.service.ts::setupOrderExpiry (line 801).
        assertValidTransition('Order', ORDER_VALID_TRANSITIONS, 'broadcasting', 'expired');
        await prismaClient.order.update({
          where: { id: orderId },
          data: {
            status: 'expired' as OrderStatus,
            dispatchState: 'no_supply',
            stateChangedAt: new Date(),
          },
        });
        // Notify customer
        try {
          emitToUser(request.customerId, SocketEvent.ORDER_NO_SUPPLY, {
            orderId,
            message: 'No vehicles available in your area right now. Please try again.',
          });
        } catch { /* non-fatal */ }
        // Clean up customer active broadcast key
        await this.clearCustomerActiveBroadcast(request.customerId).catch(() => {});
        // Build and return expired response
        const expiredResponse: CreateOrderResponse = {
          orderId,
          totalTrucks,
          totalAmount,
          dispatchState: 'dispatch_failed',
          dispatchAttempts,
          onlineCandidates,
          notifiedTransporters: 0,
          reasonCode: 'NO_SUPPLY',
          serverTimeMs: Date.now(),
          truckRequests: responseRequests,
          expiresAt,
          expiresIn: 0
        };
        return expiredResponse;
      }

      // 4. Set expiry timer
      // F-A-50 / FIX #77: when CREATE_ORDER_CONSOLIDATED is ON, kick off the
      // smart-timeout tracker so +60s/+30s extensions are recorded on driver
      // confirm. Legacy `setOrderExpiryTimer` is retained behind the flag for
      // safe rollback — it's the deprecated (F-A-52) expiry checker.
      if (isEnabled(FLAGS.CREATE_ORDER_CONSOLIDATED)) {
        try {
          await smartTimeoutService.initializeOrderTimeout(orderId, totalTrucks);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn('[ORDER] smartTimeoutService.initializeOrderTimeout failed, falling back to legacy timer', { orderId, error: message });
          this.setOrderExpiryTimer(orderId, this.BROADCAST_TIMEOUT_MS);
        }
      } else {
        this.setOrderExpiryTimer(orderId, this.BROADCAST_TIMEOUT_MS);
      }

      // Fix B4: Assert valid transition before writing
      // Note: order was created as 'broadcasting', and we're transitioning to 'active'.
      // CAS guard below is the race-condition safety net.
      assertValidTransition('Order', ORDER_VALID_TRANSITIONS, 'broadcasting', 'active');

      // Fix B2: CAS guard -- only transition from broadcasting/created
      const casResult = await prismaClient.order.updateMany({
        where: {
          id: orderId,
          status: { in: ['broadcasting', 'created'] }
        },
        data: {
          status: 'active',
          stateChangedAt: new Date(),
          dispatchState,
          dispatchAttempts,
          dispatchReasonCode: dispatchReasonCode || null,
          onlineCandidatesCount: onlineCandidates,
          notifiedCount: notifiedTransporters,
          lastDispatchAt: new Date()
        }
      });
      if (casResult.count === 0) {
        logger.warn('[ORDER] CAS failed: broadcasting->active blocked, order no longer in expected state', { orderId });
      }
      this.emitBroadcastStateChanged(request.customerId, {
        orderId,
        status: 'active',
        dispatchState,
        dispatchAttempts,
        reasonCode: dispatchReasonCode,
        onlineCandidates,
        notifiedTransporters
      });

      // SCALABILITY: Calculate expiresIn for UI countdown timer
      // EASY UNDERSTANDING: UI always matches backend TTL
      const expiresIn = Math.floor(this.BROADCAST_TIMEOUT_MS / 1000); // 60 seconds

      // Build response
      const orderResponse: CreateOrderResponse = {
        orderId,
        totalTrucks,
        totalAmount,
        dispatchState,
        dispatchAttempts,
        onlineCandidates,
        notifiedTransporters,
        reasonCode: dispatchReasonCode,
        serverTimeMs: Date.now(),
        truckRequests: responseRequests,
        expiresAt,
        expiresIn  // NEW: UI uses this for countdown (backend-driven)
      };

      // ==========================================================================
      // IDEMPOTENCY CACHE - Store response for future retries
      // ==========================================================================
      // SCALABILITY: 24-hour TTL prevents duplicate processing across network retries
      // EASY UNDERSTANDING: Client can safely retry failed requests, even hours later
      // MODULARITY: Automatic cleanup via Redis TTL; DB backup is permanent
      // ==========================================================================
      if (request.idempotencyKey) {
        const cacheKey = `idempotency:${request.customerId}:${request.idempotencyKey}`;
        const ttl = 86_400; // 24 hours — covers all realistic mobile retry windows

        try {
          await redisService.set(cacheKey, JSON.stringify(orderResponse), ttl);
          // Store pointer for cleanup on cancel/expiry
          await redisService.set(`idempotency:order:${request.customerId}:latest`, request.idempotencyKey, ttl);
          await this.persistDbIdempotentResponse(
            request.customerId,
            request.idempotencyKey,
            requestPayloadHash,
            orderId,
            orderResponse
          );
          logger.info(`Idempotency cached: ${cacheKey.substring(0, 50)}... (TTL: ${ttl}s)`);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`⚠️ Failed to cache idempotency response: ${message}`);
          // Non-critical error, continue
        }
      }

      // Store server-generated idempotency key
      const orderTimeoutSeconds = Math.ceil(this.BROADCAST_TIMEOUT_MS / 1000);
      await redisService.set(dedupeKey, orderId, orderTimeoutSeconds + 30);
      await redisService.set(`idem:broadcast:latest:${request.customerId}`, dedupeKey, orderTimeoutSeconds + 30);

      // Set customer active broadcast key (one-per-customer enforcement)
      await redisService.set(activeKey, orderId, orderTimeoutSeconds + 60);

      // Return response
      return orderResponse;
    } finally {
      await redisService.releaseLock(lockKey, request.customerId).catch((err: unknown) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.warn('Failed to release customer broadcast lock', { customerId: request.customerId, error: errorMessage });
      });
    }
    // Fix B11: Decrement backpressure counter (outer try/finally)
    } finally {
      // H-P6 FIX: Log backpressure decrement failures instead of silently ignoring
      if (!usedInMemoryFallback) {
        // Redis path was used for increment — decrement via Redis
        await redisService.incrBy(BACKPRESSURE_KEY, -1).catch((err: unknown) => { logger.warn('[ORDER] Backpressure decrement failed in finally', { error: err instanceof Error ? err.message : String(err) }); });
      }
      // FIX-35: Only decrement in-memory counter when it was actually incremented.
      // Previously this always decremented, causing negative drift when Redis succeeded.
      if (usedInMemoryFallback) {
        inMemoryInflight = Math.max(0, inMemoryInflight - 1);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Broadcast Thin Delegates (implementation in order-broadcast.service.ts)
  // ---------------------------------------------------------------------------

  private async broadcastToTransporters(
    orderId: string,
    request: CreateOrderRequest,
    truckRequests: TruckRequestRecord[],
    expiresAt: string,
    resolvedPickup: { latitude: number; longitude: number; address: string; city?: string; state?: string }
  ): Promise<{ onlineCandidates: number; notifiedTransporters: number }> {
    return broadcastToTransportersFn(orderId, request, truckRequests, expiresAt, resolvedPickup);
  }

  private async processProgressiveBroadcastStep(timerData: {
    orderId: string;
    vehicleType: string;
    vehicleSubtype: string;
    stepIndex: number;
  }): Promise<void> {
    return processProgressiveBroadcastStepFn(timerData);
  }

  private async scheduleNextProgressiveStep(
    orderId: string,
    vehicleType: string,
    vehicleSubtype: string,
    stepIndex: number
  ): Promise<void> {
    return scheduleNextProgressiveStepFn(orderId, vehicleType, vehicleSubtype, stepIndex);
  }

  private buildRequestsByType(requests: TruckRequestRecord[]): Map<string, TruckRequestRecord[]> {
    return buildRequestsByTypeFn(requests);
  }

  private async getNotifiedTransporters(orderId: string, vehicleType: string, vehicleSubtype: string): Promise<Set<string>> {
    return getNotifiedTransportersFn(orderId, vehicleType, vehicleSubtype);
  }

  private async markTransportersNotified(
    orderId: string,
    vehicleType: string,
    vehicleSubtype: string,
    transporterIds: string[]
  ): Promise<void> {
    return markTransportersNotifiedFn(orderId, vehicleType, vehicleSubtype, transporterIds);
  }

  private async broadcastVehicleTypePayload(
    orderId: string,
    request: CreateOrderRequest,
    truckRequests: TruckRequestRecord[],
    requestsByType: Map<string, TruckRequestRecord[]>,
    requests: TruckRequestRecord[],
    vehicleType: string,
    vehicleSubtype: string,
    matchingTransporters: string[],
    expiresAt: string,
    candidateDistanceMap?: Map<string, { distanceKm: number; etaSeconds: number }>
  ): Promise<{ sentTransporters: string[]; skippedNoAvailable: number }> {
    return broadcastVehicleTypePayloadFn(orderId, request, truckRequests, requestsByType, requests, vehicleType, vehicleSubtype, matchingTransporters, expiresAt, candidateDistanceMap);
  }

  private async clearCustomerActiveBroadcast(customerId: string): Promise<void> {
    return clearCustomerActiveBroadcastFn(customerId);
  }

  private withEventMeta<T extends Record<string, unknown>>(payload: T, eventId?: string): T & { eventId: string; emittedAt: string } {
    return withEventMetaFn(payload, eventId);
  }

  private emitBroadcastStateChanged(
    customerId: string,
    payload: {
      orderId: string;
      status: string;
      dispatchState?: string;
      dispatchAttempts?: number;
      reasonCode?: string;
      onlineCandidates?: number;
      notifiedTransporters?: number;
      stateChangedAt?: string;
    }
  ): void {
    emitBroadcastStateChangedFn(customerId, payload);
  }

  private async emitToTransportersWithAdaptiveFanout(
    transporterIds: string[],
    events: Array<{ event: string; payload: Record<string, unknown> }>,
    context: string
  ): Promise<void> {
    return emitToTransportersWithAdaptiveFanoutFn(transporterIds, events, context);
  }

  // ---------------------------------------------------------------------------
  // Timer Delegates (extracted to order-timer.service.ts)
  // ---------------------------------------------------------------------------

  /**
   * @deprecated F-A-52: Legacy in-memory expiry timer. Replaced by
   * `smartTimeoutService.initializeOrderTimeout` which persists the timeout in
   * Postgres and supports +60s/+30s extensions on driver confirm. Retained
   * behind `FF_CREATE_ORDER_CONSOLIDATED=false` for safe rollback during the
   * F-A-50 soak window. Will be removed once the flag flips to default ON.
   */
  private async setOrderExpiryTimer(orderId: string, timeoutMs: number): Promise<void> {
    return setOrderExpiryTimerFn(orderId, timeoutMs);
  }

  private async clearProgressiveStepTimers(orderId: string): Promise<void> {
    return clearProgressiveStepTimersFn(orderId);
  }

  async processExpiredTimers(): Promise<void> {
    return processExpiredTimersFn();
  }

  private emitDriverCancellationEvents(
    driverId: string,
    payload: {
      orderId: string;
      tripId?: string | null;
      reason: string;
      message: string;
      cancelledAt?: string;
      customerName?: string;
      customerPhone?: string;
      pickupAddress?: string;
      dropAddress?: string;
      compensationAmount?: number;
      settlementState?: string;
    }
  ): void {
    emitDriverCancellationEventsFn(driverId, payload);
  }

  /**
   * Handle order expiry (delegates to order-lifecycle-outbox.service.ts)
   */
  async handleOrderExpiry(orderId: string): Promise<void> {
    return handleOrderExpiryFn(orderId);
  }

  /**
   * Derive truck cancel stage (delegates to order-cancel-policy.service.ts)
   */
  private deriveTruckCancelStage(
    order: Pick<OrderRecord, 'status' | 'loadingStartedAt' | 'unloadingStartedAt'>,
    assignments: Array<{ status: AssignmentStatus }>
  ): TruckCancelPolicyStage {
    return deriveTruckCancelStageFn(order, assignments);
  }

  /**
   * Calculate waiting charges (delegates to order-cancel-policy.service.ts)
   */
  private calculateWaitingCharges(order: Pick<OrderRecord, 'stopWaitTimers'>): number {
    return calculateWaitingChargesFn(order);
  }

  /**
   * Create money breakdown (delegates to order-cancel-policy.service.ts)
   */
  private createMoneyBreakdown(
    baseCancellationFee: number,
    waitingCharges: number,
    percentageFareComponent: number,
    driverMinimumGuarantee: number
  ): CancelMoneyBreakdown {
    return createMoneyBreakdownFn(baseCancellationFee, waitingCharges, percentageFareComponent, driverMinimumGuarantee);
  }

  /**
   * Evaluate truck cancel policy (delegates to order-cancel-policy.service.ts)
   */
  private evaluateTruckCancelPolicy(
    order: Pick<OrderRecord, 'totalAmount' | 'stopWaitTimers' | 'status' | 'loadingStartedAt' | 'unloadingStartedAt'>,
    assignments: Array<{ status: AssignmentStatus }>,
    reason?: string
  ): TruckCancelPolicyEvaluation {
    return evaluateTruckCancelPolicyFn(order, assignments, reason);
  }

  // ---------------------------------------------------------------------------
  // Cancel Helper Delegates (extracted to order-cancel.service.ts)
  // ---------------------------------------------------------------------------

  private buildCancelPayloadHash(orderId: string, reason?: string): string {
    return buildCancelPayloadHashFn(orderId, reason);
  }

  private async getCancelIdempotentResponse(
    customerId: string,
    idempotencyKey: string,
    payloadHash: string
  ): Promise<CancelOrderResult | null> {
    return getCancelIdempotentResponseFn(customerId, idempotencyKey, payloadHash);
  }

  private async persistCancelIdempotentResponse(
    customerId: string,
    idempotencyKey: string,
    payloadHash: string,
    orderId: string,
    response: CancelOrderResult,
    statusCode: number
  ): Promise<void> {
    return persistCancelIdempotentResponseFn(customerId, idempotencyKey, payloadHash, orderId, response, statusCode);
  }

  private async registerCancelRebookChurn(customerId: string): Promise<void> {
    return registerCancelRebookChurnFn(customerId);
  }

  private async enforceCancelRebookCooldown(customerId: string): Promise<void> {
    return enforceCancelRebookCooldownFn(customerId);
  }

  /**
   * Get cancel preview (delegates to order-cancel-policy.service.ts)
   */
  async getCancelPreview(orderId: string, customerId: string, reason?: string): Promise<CancelOrderResult> {
    return getCancelPreviewFn(orderId, customerId, reason);
  }

  /**
   * Create cancel dispute (delegates to order-cancel-policy.service.ts)
   */
  async createCancelDispute(
    orderId: string,
    customerId: string,
    reasonCode?: string,
    notes?: string
  ): Promise<{ success: boolean; disputeId?: string; message: string; stage?: TruckCancelPolicyStage }> {
    return createCancelDisputeFn(orderId, customerId, reasonCode, notes);
  }

  /**
   * Cancel an order — atomic, idempotent, race-safe
   * (delegates to order-cancel.service.ts)
   */
  async cancelOrder(
    orderId: string,
    customerId: string,
    reason?: string,
    idempotencyKey?: string,
    options: { createDispute?: boolean } = {}
  ): Promise<CancelOrderResult> {
    return cancelOrderFn(orderId, customerId, reason, idempotencyKey, options);
  }

  /**
   * Accept a truck request (transporter assigns vehicle + driver)
   * (delegates to order-accept.service.ts)
   */
  async acceptTruckRequest(
    truckRequestId: string,
    transporterId: string,
    vehicleId: string,
    driverId: string
  ): Promise<{
    success: boolean;
    assignmentId?: string;
    tripId?: string;
    message: string;
  }> {
    return acceptTruckRequestFn(truckRequestId, transporterId, vehicleId, driverId);
  }

  // -------------------------------------------------------------------------
  // Query delegates (implementation in order-query.service.ts)
  // -------------------------------------------------------------------------

  async getOrderDetails(orderId: string): Promise<(OrderRecord & { truckRequests: TruckRequestRecord[] }) | null> {
    return getOrderDetailsQuery(orderId);
  }

  async getActiveRequestsForTransporter(transporterId: string): Promise<TruckRequestRecord[]> {
    return getActiveRequestsForTransporterQuery(transporterId);
  }

  async getOrdersByCustomer(customerId: string): Promise<OrderRecord[]> {
    return getOrdersByCustomerQuery(customerId);
  }

  async getOrderWithRequests(orderId: string, userId: string, userRole: string) {
    return getOrderWithRequestsQuery(orderId, userId, userRole);
  }

  async getActiveTruckRequestsForTransporter(transporterId: string): Promise<ActiveTruckRequestOrderGroupImported[]> {
    return getActiveTruckRequestsForTransporterQuery(transporterId);
  }

  async getCustomerOrders(customerId: string, page: number = 1, limit: number = 20) {
    return getCustomerOrdersQuery(customerId, page, limit);
  }
}

// Export singleton
export const orderService = new OrderService();

// Re-export query functions for direct imports
export {
  getOrderDetailsQuery,
  getActiveRequestsForTransporterQuery,
  getOrdersByCustomerQuery,
  getOrderWithRequestsQuery,
  getActiveTruckRequestsForTransporterQuery,
  getCustomerOrdersQuery
} from './order-query.service';

// Re-export dispatch outbox functions for direct imports
export {
  FF_ORDER_DISPATCH_OUTBOX,
  FF_ORDER_DISPATCH_STATUS_EVENTS,
  ORDER_DISPATCH_OUTBOX_POLL_MS,
  ORDER_DISPATCH_OUTBOX_BATCH_SIZE,
  startDispatchOutboxWorker,
  calculateDispatchRetryDelayMs,
  parseDispatchOutboxPayload,
  orderDispatchOutboxDelegate,
  enqueueOrderDispatchOutbox,
  claimDispatchOutboxByOrderId,
  claimReadyDispatchOutboxRows,
  buildDispatchAttemptContext,
  persistOrderDispatchSnapshot,
  processDispatchOutboxRow,
  processDispatchOutboxBatch,
  processDispatchOutboxImmediately,
} from './order-dispatch-outbox.service';

// Re-export lifecycle outbox functions for direct imports
export {
  FF_CANCEL_OUTBOX_ENABLED,
  ORDER_CANCEL_OUTBOX_POLL_MS,
  ORDER_CANCEL_OUTBOX_BATCH_SIZE,
  startLifecycleOutboxWorker,
  lifecycleOutboxDelegate,
  parseLifecycleOutboxPayload,
  calculateLifecycleRetryDelayMs,
  enqueueCancelLifecycleOutbox,
  claimLifecycleOutboxById,
  claimReadyLifecycleOutboxRows,
  emitCancellationLifecycle,
  processLifecycleOutboxRow,
  processLifecycleOutboxBatch,
  processLifecycleOutboxImmediately,
  handleOrderExpiry,
} from './order-lifecycle-outbox.service';

// Re-export broadcast functions for direct imports
export {
  broadcastToTransporters,
  processProgressiveBroadcastStep,
  broadcastVehicleTypePayload,
  emitBroadcastStateChanged,
  emitToTransportersWithAdaptiveFanout,
  emitDriverCancellationEvents,
  buildRequestsByType,
  getNotifiedTransporters,
  markTransportersNotified,
  chunkTransporterIds,
  notifiedTransportersKey,
  makeVehicleGroupKey,
  parseVehicleGroupKey,
  getTransportersByVehicleCached,
  invalidateTransporterCache,
  withEventMeta,
  clearCustomerActiveBroadcast,
  scheduleNextProgressiveStep,
  orderBroadcastStepTimerKey,
  FF_BROADCAST_STRICT_SENT_ACCOUNTING,
} from './order-broadcast.service';

// Re-export timer functions for direct imports
export {
  orderExpiryTimerKey,
  setOrderExpiryTimer,
  clearProgressiveStepTimers,
  processExpiredTimers,
  processExpiredOrderTimers,
  processExpiredBroadcastStepTimers,
  startOrderTimerChecker,
  stopOrderTimerChecker,
  ORDER_EXPIRY_TIMER_PREFIX,
  ORDER_STEP_TIMER_PREFIX,
  ORDER_STEP_TIMER_LOCK_PREFIX,
} from './order-timer.service';

// Re-export cancel policy functions for direct imports
export {
  deriveTruckCancelStage,
  calculateWaitingCharges,
  createMoneyBreakdown,
  evaluateTruckCancelPolicy,
  getCancelPreview,
  createCancelDispute,
} from './order-cancel-policy.service';

// Re-export cancel functions for direct imports
export {
  FF_CANCEL_EVENT_VERSION_ENFORCED,
  FF_CANCEL_REBOOK_CHURN_GUARD,
  FF_CANCEL_DEFERRED_SETTLEMENT,
  FF_CANCEL_IDEMPOTENCY_REQUIRED,
  cancelOrder,
  buildCancelPayloadHash,
  getCancelIdempotentResponse,
  persistCancelIdempotentResponse,
  registerCancelRebookChurn,
  enforceCancelRebookCooldown,
} from './order-cancel.service';

// Re-export accept functions for direct imports
export {
  acceptTruckRequest,
} from './order-accept.service';
