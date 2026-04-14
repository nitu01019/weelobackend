/**
 * =============================================================================
 * ORDER DELEGATES SERVICE - OrderService class + re-exports from bridge
 * =============================================================================
 *
 * Extracted from order.service.ts during file-size decomposition.
 * Contains:
 * - The OrderService class (constructor + all instance methods)
 * - Re-exports all standalone delegate functions from order-delegates-bridge
 *
 * The facade (order.service.ts) imports OrderService from here, instantiates
 * the singleton, and re-exports sub-module symbols.
 * =============================================================================
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import type { CreateOrderRequest, CreateOrderResponse } from './order-core-types';
import type { CancelOrderResult, TruckCancelPolicyStage } from './order-types';
import type { OrderCreateContext } from './order-create-context';
import { OrderRecord, TruckRequestRecord } from '../../shared/database/db';
import {
  buildRequestPayloadHash,
  acquireOrderBackpressure,
  releaseOrderBackpressure,
  validateOrderRequest,
  enforceOrderDebounce,
  checkOrderIdempotency,
  checkExistingActiveOrders,
  checkOrderServerIdempotency,
  resolveServerRouteDistance,
  validateAndCorrectPrices,
  buildOrderRoutePoints,
  persistOrderTransaction,
  broadcastOrderToTransporters,
  setupOrderExpiry,
  cacheOrderIdempotencyResponse,
} from './order-creation.service';
import {
  FF_ORDER_DISPATCH_OUTBOX,
} from './order-dispatch-outbox.service';
import {
  FF_CANCEL_OUTBOX_ENABLED,
} from './order-lifecycle-outbox.service';
import { ActiveTruckRequestOrderGroup as ActiveTruckRequestOrderGroupImported } from './order-query.service';

// Import all bridge delegates for use in class methods
import {
  checkRateLimit,
  startLifecycleOutboxWorker,
  startDispatchOutboxWorker,
  enqueueOrderDispatchOutbox,
  processDispatchOutboxImmediately,
  broadcastToTransportersPublic,
  emitBroadcastStateChangedPublic,
  emitToTransportersWithAdaptiveFanoutPublic,
  emitDriverCancellationEventsPublic,
  withEventMetaPublic,
  orderExpiryTimerKeyPublic,
  clearProgressiveStepTimersPublic,
  clearCustomerActiveBroadcastPublic,
  invalidateTransporterCache,
  processExpiredTimers,
  handleOrderExpiry,
  getCancelPreview,
  createCancelDispute,
  cancelOrder,
  acceptTruckRequest,
  getOrderDetails,
  getActiveRequestsForTransporter,
  getOrdersByCustomer,
  getOrderWithRequests,
  getActiveTruckRequestsForTransporter,
  getCustomerOrders,
  enforceCancelRebookCooldown,
} from './order-delegates-bridge.service';

// =============================================================================
// Re-export all bridge delegates so existing imports from this module still work
// =============================================================================
export {
  checkRateLimit,
  startLifecycleOutboxWorker,
  enqueueCancelLifecycleOutbox,
  processLifecycleOutboxImmediately,
  emitCancellationLifecycle,
  startDispatchOutboxWorker,
  enqueueOrderDispatchOutbox,
  processDispatchOutboxImmediately,
  broadcastToTransportersPublic,
  emitBroadcastStateChangedPublic,
  emitToTransportersWithAdaptiveFanoutPublic,
  emitDriverCancellationEventsPublic,
  withEventMetaPublic,
  orderExpiryTimerKeyPublic,
  clearProgressiveStepTimersPublic,
  clearCustomerActiveBroadcastPublic,
  orderBroadcastStepTimerKey,
  notifiedTransportersKey,
  makeVehicleGroupKey,
  parseVehicleGroupKey,
  broadcastToTransporters,
  processProgressiveBroadcastStep,
  scheduleNextProgressiveStep,
  buildRequestsByType,
  getNotifiedTransporters,
  markTransportersNotified,
  broadcastVehicleTypePayload,
  clearCustomerActiveBroadcast,
  withEventMeta,
  emitBroadcastStateChanged,
  emitToTransportersWithAdaptiveFanout,
  getTransportersByVehicleCached,
  invalidateTransporterCache,
  setOrderExpiryTimer,
  clearProgressiveStepTimers,
  processExpiredTimers,
  emitDriverCancellationEvents,
  handleOrderExpiry,
  deriveTruckCancelStage,
  calculateWaitingCharges,
  createMoneyBreakdown,
  evaluateTruckCancelPolicy,
  getCancelPreview,
  createCancelDispute,
  buildCancelPayloadHash,
  getCancelIdempotentResponseDelegate,
  persistCancelIdempotentResponseDelegate,
  registerCancelRebookChurn,
  enforceCancelRebookCooldown,
  cancelOrder,
  acceptTruckRequest,
  getOrderDetails,
  getActiveRequestsForTransporter,
  getOrdersByCustomer,
  getOrderWithRequests,
  getActiveTruckRequestsForTransporter,
  getCustomerOrders,
} from './order-delegates-bridge.service';

// =============================================================================
// ORDER SERVICE CLASS
// =============================================================================

export class OrderService {

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
      this.outboxWorkerTimer = startDispatchOutboxWorker({
        outboxWorkerTimer: this.outboxWorkerTimer,
        outboxWorkerRunning: this.outboxWorkerRunning,
        isShuttingDown: this.isShuttingDown
      });
    }
    if (FF_CANCEL_OUTBOX_ENABLED && process.env.NODE_ENV !== 'test') {
      this.lifecycleOutboxWorkerTimer = startLifecycleOutboxWorker({
        lifecycleOutboxWorkerTimer: this.lifecycleOutboxWorkerTimer,
        lifecycleOutboxWorkerRunning: this.lifecycleOutboxWorkerRunning,
        isShuttingDown: this.isShuttingDown
      });
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

  // ===========================================================================
  // Broadcast Public Bridge Methods
  // ===========================================================================

  broadcastToTransportersPublic(
    orderId: string,
    request: CreateOrderRequest,
    truckRequests: TruckRequestRecord[],
    expiresAt: string,
    pickup: { latitude: number; longitude: number; address: string; city?: string; state?: string }
  ) {
    return broadcastToTransportersPublic(orderId, request, truckRequests, expiresAt, pickup);
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
    emitBroadcastStateChangedPublic(customerId, payload);
  }

  emitToTransportersWithAdaptiveFanoutPublic(
    transporterIds: string[],
    events: Array<{ event: string; payload: Record<string, unknown> }>,
    context: string
  ): Promise<void> {
    return emitToTransportersWithAdaptiveFanoutPublic(transporterIds, events, context);
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
    return emitDriverCancellationEventsPublic(driverId, payload);
  }

  withEventMetaPublic<T extends Record<string, unknown>>(payload: T, eventId?: string): T & { eventId: string; emittedAt: string } {
    return withEventMetaPublic(payload, eventId);
  }

  orderExpiryTimerKeyPublic(orderId: string): string {
    return orderExpiryTimerKeyPublic(orderId);
  }

  async clearProgressiveStepTimersPublic(orderId: string): Promise<void> {
    return clearProgressiveStepTimersPublic(orderId);
  }

  async clearCustomerActiveBroadcastPublic(customerId: string): Promise<void> {
    return clearCustomerActiveBroadcastPublic(customerId);
  }

  // ===========================================================================
  // Rate Limiting
  // ===========================================================================

  async checkRateLimit(
    key: string,
    limit: number,
    windowSeconds: number
  ): Promise<{ allowed: boolean; retryAfter: number }> {
    return checkRateLimit(key, limit, windowSeconds);
  }

  // ===========================================================================
  // Transporter Lookup
  // ===========================================================================

  async invalidateTransporterCache(vehicleType: string, vehicleSubtype?: string): Promise<void> {
    return invalidateTransporterCache(vehicleType, vehicleSubtype);
  }

  // ===========================================================================
  // CREATE ORDER
  // ===========================================================================

  async createOrder(request: CreateOrderRequest): Promise<CreateOrderResponse> {
    const ctx: OrderCreateContext = {
      request,
      backpressureKey: 'order:create:inflight',
      maxConcurrentOrders: Math.max(10, Math.min(1000, parseInt(process.env.ORDER_MAX_CONCURRENT_CREATES || '200', 10))),
      requestPayloadHash: '',
      lockKey: `customer-broadcast-create:${request.customerId}`,
      lockAcquired: false,
      dedupeKey: '',
      idempotencyHash: '',
      distanceSource: 'client_fallback',
      clientDistanceKm: request.distanceKm,
      totalAmount: 0,
      totalTrucks: 0,
      routePoints: [],
      pickup: { latitude: 0, longitude: 0, address: '' },
      drop: { latitude: 0, longitude: 0, address: '' },
      orderId: uuidv4(),
      expiresAt: '',
      truckRequests: [],
      responseRequests: [],
      dispatchState: 'dispatching',
      dispatchReasonCode: undefined,
      dispatchAttempts: 1,
      onlineCandidates: 0,
      notifiedTransporters: 0,
      orderResponse: null,
      earlyReturn: null,
    };

    await acquireOrderBackpressure(ctx);
    try {
      validateOrderRequest(ctx);
      ctx.requestPayloadHash = buildRequestPayloadHash(request);

      await enforceCancelRebookCooldown(request.customerId);
      await enforceOrderDebounce(ctx);

      const idempotencyResult = await checkOrderIdempotency(ctx);
      if (idempotencyResult) return idempotencyResult;

      await checkExistingActiveOrders(ctx);
      try {
        const serverIdempotencyResult = await checkOrderServerIdempotency(ctx);
        if (serverIdempotencyResult) return serverIdempotencyResult;

        await resolveServerRouteDistance(ctx);
        validateAndCorrectPrices(ctx);
        buildOrderRoutePoints(ctx, this.BROADCAST_TIMEOUT_MS);
        await persistOrderTransaction(ctx, enqueueOrderDispatchOutbox);
        await broadcastOrderToTransporters(ctx, processDispatchOutboxImmediately);
        await setupOrderExpiry(ctx, this.BROADCAST_TIMEOUT_MS);
        await cacheOrderIdempotencyResponse(ctx, this.BROADCAST_TIMEOUT_MS);

        return ctx.orderResponse!;
      } finally {
        await redisService.releaseLock(ctx.lockKey, request.customerId).catch((err: unknown) => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          logger.warn('Failed to release customer broadcast lock', { customerId: request.customerId, error: errorMessage });
        });
      }
    } finally {
      await releaseOrderBackpressure(ctx);
    }
  }

  // ===========================================================================
  // Expiry & Timer
  // ===========================================================================

  async processExpiredTimers(): Promise<void> {
    return processExpiredTimers();
  }

  async handleOrderExpiry(orderId: string): Promise<void> {
    return handleOrderExpiry(orderId);
  }

  // ===========================================================================
  // Cancel
  // ===========================================================================

  async getCancelPreview(orderId: string, customerId: string, reason?: string): Promise<CancelOrderResult> {
    return getCancelPreview(orderId, customerId, reason);
  }

  async createCancelDispute(
    orderId: string,
    customerId: string,
    reasonCode?: string,
    notes?: string
  ): Promise<{ success: boolean; disputeId?: string; message: string; stage?: TruckCancelPolicyStage }> {
    return createCancelDispute(orderId, customerId, reasonCode, notes);
  }

  async cancelOrder(
    orderId: string,
    customerId: string,
    reason?: string,
    idempotencyKey?: string,
    options: { createDispute?: boolean } = {}
  ): Promise<CancelOrderResult> {
    return cancelOrder(orderId, customerId, reason, idempotencyKey, options);
  }

  // ===========================================================================
  // Accept
  // ===========================================================================

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
    return acceptTruckRequest(truckRequestId, transporterId, vehicleId, driverId);
  }

  // ===========================================================================
  // Query Delegates
  // ===========================================================================

  async getOrderDetails(orderId: string): Promise<(OrderRecord & { truckRequests: TruckRequestRecord[] }) | null> {
    return getOrderDetails(orderId);
  }

  async getActiveRequestsForTransporter(transporterId: string): Promise<TruckRequestRecord[]> {
    return getActiveRequestsForTransporter(transporterId);
  }

  async getOrdersByCustomer(customerId: string): Promise<OrderRecord[]> {
    return getOrdersByCustomer(customerId);
  }

  async getOrderWithRequests(orderId: string, userId: string, userRole: string) {
    return getOrderWithRequests(orderId, userId, userRole);
  }

  async getActiveTruckRequestsForTransporter(transporterId: string): Promise<ActiveTruckRequestOrderGroupImported[]> {
    return getActiveTruckRequestsForTransporter(transporterId);
  }

  async getCustomerOrders(customerId: string, page: number = 1, limit: number = 20) {
    return getCustomerOrders(customerId, page, limit);
  }
}
