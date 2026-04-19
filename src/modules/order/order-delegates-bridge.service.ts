/**
 * =============================================================================
 * ORDER DELEGATES BRIDGE - Standalone delegate/bridge functions
 * =============================================================================
 *
 * Extracted from order-delegates.service.ts during file-size decomposition.
 * Contains all standalone exported delegate functions that bridge to
 * sub-services (broadcast, timer, cancel, accept, query, outbox, etc.).
 *
 * The OrderService class (in order-delegates.service.ts) imports from here.
 * =============================================================================
 */

import { Prisma } from '@prisma/client';
import { OrderRecord, TruckRequestRecord } from '../../shared/database/db';
import { AssignmentStatus } from '../../shared/database/prisma.service';
import { redisService } from '../../shared/services/redis.service';
import type { CreateOrderRequest } from './order-core-types';
import type {
  DispatchAttemptContext,
  DispatchAttemptOutcome,
  OrderLifecycleOutboxPayload,
  OrderCancelledOutboxPayload,
  TruckCancelPolicyStage,
  CancelMoneyBreakdown,
  TruckCancelPolicyEvaluation,
  CancelOrderResult,
} from './order-types';
import {
  startDispatchOutboxWorker as startDispatchOutboxWorkerFn,
  enqueueOrderDispatchOutbox as enqueueOrderDispatchOutboxFn,
  processDispatchOutboxImmediately as processDispatchOutboxImmediatelyFn,
} from './order-dispatch-outbox.service';
import {
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
  notifiedTransportersKey as notifiedTransportersKeyFn,
  makeVehicleGroupKey as makeVehicleGroupKeyFn,
  parseVehicleGroupKey as parseVehicleGroupKeyFn,
  getTransportersByVehicleCached as getTransportersByVehicleCachedFn,
  invalidateTransporterCache as invalidateTransporterCacheFn,
  withEventMeta as withEventMetaFn,
  clearCustomerActiveBroadcast as clearCustomerActiveBroadcastFn,
  scheduleNextProgressiveStep as scheduleNextProgressiveStepFn,
  orderBroadcastStepTimerKey as orderBroadcastStepTimerKeyFn,
} from './order-broadcast.service';
import {
  orderExpiryTimerKey as orderExpiryTimerKeyFn,
  setOrderExpiryTimer as setOrderExpiryTimerFn,
  clearProgressiveStepTimers as clearProgressiveStepTimersFn,
  processExpiredTimers as processExpiredTimersFn,
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
import {
  getOrderDetailsQuery,
  getActiveRequestsForTransporterQuery,
  getOrdersByCustomerQuery,
  getOrderWithRequestsQuery,
  getActiveTruckRequestsForTransporterQuery,
  getCustomerOrdersQuery,
  ActiveTruckRequestOrderGroup as ActiveTruckRequestOrderGroupImported
} from './order-query.service';

// ---------------------------------------------------------------------------
// Rate Limiting
// ---------------------------------------------------------------------------

/**
 * Check if request is within rate limit
 *
 * SCALABILITY: Uses Redis for distributed rate limiting
 * - Works across all server instances
 * - Atomic increment prevents race conditions
 * - Automatic TTL cleanup
 */
export async function checkRateLimit(
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

// ---------------------------------------------------------------------------
// Lifecycle Outbox Delegates
// ---------------------------------------------------------------------------

export function startLifecycleOutboxWorker(state: {
  lifecycleOutboxWorkerTimer: NodeJS.Timeout | null;
  lifecycleOutboxWorkerRunning: boolean;
  isShuttingDown: boolean;
}): NodeJS.Timeout | null {
  return startLifecycleOutboxWorkerFn(state);
}

export async function enqueueCancelLifecycleOutbox(
  payload: OrderLifecycleOutboxPayload,
  tx?: Prisma.TransactionClient
): Promise<string> {
  return enqueueCancelLifecycleOutboxFn(payload, tx);
}

export async function processLifecycleOutboxImmediately(outboxId: string): Promise<void> {
  return processLifecycleOutboxImmediatelyFn(outboxId);
}

export async function emitCancellationLifecycle(payload: OrderCancelledOutboxPayload): Promise<void> {
  return emitCancellationLifecycleFn(payload);
}

// ---------------------------------------------------------------------------
// Dispatch Outbox Delegates
// ---------------------------------------------------------------------------

export function startDispatchOutboxWorker(state: {
  outboxWorkerTimer: NodeJS.Timeout | null;
  outboxWorkerRunning: boolean;
  isShuttingDown: boolean;
}): NodeJS.Timeout | null {
  return startDispatchOutboxWorkerFn(state);
}

export async function enqueueOrderDispatchOutbox(orderId: string, tx?: Prisma.TransactionClient): Promise<void> {
  return enqueueOrderDispatchOutboxFn(orderId, tx);
}

export async function processDispatchOutboxImmediately(
  orderId: string,
  context: DispatchAttemptContext
): Promise<DispatchAttemptOutcome | null> {
  return processDispatchOutboxImmediatelyFn(orderId, context);
}

// ---------------------------------------------------------------------------
// Broadcast Public Bridge Methods
// ---------------------------------------------------------------------------

export function broadcastToTransportersPublic(
  orderId: string,
  request: CreateOrderRequest,
  truckRequests: TruckRequestRecord[],
  expiresAt: string,
  pickup: { latitude: number; longitude: number; address: string; city?: string; state?: string }
) {
  return broadcastToTransportersFn(orderId, request, truckRequests, expiresAt, pickup);
}

export function emitBroadcastStateChangedPublic(
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

export function emitToTransportersWithAdaptiveFanoutPublic(
  transporterIds: string[],
  events: Array<{ event: string; payload: Record<string, unknown> }>,
  context: string
): Promise<void> {
  return emitToTransportersWithAdaptiveFanoutFn(transporterIds, events, context);
}

export function emitDriverCancellationEventsPublic(
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

export function withEventMetaPublic<T extends Record<string, unknown>>(payload: T, eventId?: string): T & { eventId: string; emittedAt: string } {
  return withEventMetaFn(payload, eventId);
}

export function orderExpiryTimerKeyPublic(orderId: string): string {
  return orderExpiryTimerKeyFn(orderId);
}

export async function clearProgressiveStepTimersPublic(orderId: string): Promise<void> {
  return clearProgressiveStepTimersFn(orderId);
}

export async function clearCustomerActiveBroadcastPublic(customerId: string): Promise<void> {
  return clearCustomerActiveBroadcastFn(customerId);
}

// ---------------------------------------------------------------------------
// Broadcast Thin Delegates (private in OrderService)
// ---------------------------------------------------------------------------

export function orderBroadcastStepTimerKey(
  orderId: string,
  vehicleType: string,
  vehicleSubtype: string,
  stepIndex: number
): string {
  return orderBroadcastStepTimerKeyFn(orderId, vehicleType, vehicleSubtype, stepIndex);
}

export function notifiedTransportersKey(orderId: string, vehicleType: string, vehicleSubtype: string): string {
  return notifiedTransportersKeyFn(orderId, vehicleType, vehicleSubtype);
}

export function makeVehicleGroupKey(vehicleType: string, vehicleSubtype: string): string {
  return makeVehicleGroupKeyFn(vehicleType, vehicleSubtype);
}

export function parseVehicleGroupKey(groupKey: string): { vehicleType: string; vehicleSubtype: string } {
  return parseVehicleGroupKeyFn(groupKey);
}

export async function broadcastToTransporters(
  orderId: string,
  request: CreateOrderRequest,
  truckRequests: TruckRequestRecord[],
  expiresAt: string,
  resolvedPickup: { latitude: number; longitude: number; address: string; city?: string; state?: string }
): Promise<{ onlineCandidates: number; notifiedTransporters: number }> {
  return broadcastToTransportersFn(orderId, request, truckRequests, expiresAt, resolvedPickup);
}

export async function processProgressiveBroadcastStep(timerData: {
  orderId: string;
  vehicleType: string;
  vehicleSubtype: string;
  stepIndex: number;
}): Promise<void> {
  return processProgressiveBroadcastStepFn(timerData);
}

export async function scheduleNextProgressiveStep(
  orderId: string,
  vehicleType: string,
  vehicleSubtype: string,
  stepIndex: number
): Promise<void> {
  return scheduleNextProgressiveStepFn(orderId, vehicleType, vehicleSubtype, stepIndex);
}

export function buildRequestsByType(requests: TruckRequestRecord[]): Map<string, TruckRequestRecord[]> {
  return buildRequestsByTypeFn(requests);
}

export async function getNotifiedTransporters(orderId: string, vehicleType: string, vehicleSubtype: string): Promise<Set<string>> {
  return getNotifiedTransportersFn(orderId, vehicleType, vehicleSubtype);
}

export async function markTransportersNotified(
  orderId: string,
  vehicleType: string,
  vehicleSubtype: string,
  transporterIds: string[]
): Promise<void> {
  return markTransportersNotifiedFn(orderId, vehicleType, vehicleSubtype, transporterIds);
}

export async function broadcastVehicleTypePayload(
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

export async function clearCustomerActiveBroadcast(customerId: string): Promise<void> {
  return clearCustomerActiveBroadcastFn(customerId);
}

export function withEventMeta<T extends Record<string, unknown>>(payload: T, eventId?: string): T & { eventId: string; emittedAt: string } {
  return withEventMetaFn(payload, eventId);
}

export function emitBroadcastStateChanged(
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

export async function emitToTransportersWithAdaptiveFanout(
  transporterIds: string[],
  events: Array<{ event: string; payload: Record<string, unknown> }>,
  context: string
): Promise<void> {
  return emitToTransportersWithAdaptiveFanoutFn(transporterIds, events, context);
}

export async function getTransportersByVehicleCached(
  vehicleType: string,
  vehicleSubtype: string
): Promise<string[]> {
  return getTransportersByVehicleCachedFn(vehicleType, vehicleSubtype);
}

export async function invalidateTransporterCache(vehicleType: string, vehicleSubtype?: string): Promise<void> {
  return invalidateTransporterCacheFn(vehicleType, vehicleSubtype);
}

// ---------------------------------------------------------------------------
// Timer Delegates
// ---------------------------------------------------------------------------

export async function setOrderExpiryTimer(orderId: string, timeoutMs: number): Promise<void> {
  return setOrderExpiryTimerFn(orderId, timeoutMs);
}

export async function clearProgressiveStepTimers(orderId: string): Promise<void> {
  return clearProgressiveStepTimersFn(orderId);
}

export async function processExpiredTimers(): Promise<void> {
  return processExpiredTimersFn();
}

export function emitDriverCancellationEvents(
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
export async function handleOrderExpiry(orderId: string): Promise<void> {
  return handleOrderExpiryFn(orderId);
}

// ---------------------------------------------------------------------------
// Cancel Policy Delegates
// ---------------------------------------------------------------------------

export function deriveTruckCancelStage(
  order: Pick<OrderRecord, 'status' | 'loadingStartedAt' | 'unloadingStartedAt'>,
  assignments: Array<{ status: AssignmentStatus }>
): TruckCancelPolicyStage {
  return deriveTruckCancelStageFn(order, assignments);
}

export function calculateWaitingCharges(order: Pick<OrderRecord, 'stopWaitTimers'>): number {
  return calculateWaitingChargesFn(order);
}

export function createMoneyBreakdown(
  baseCancellationFee: number,
  waitingCharges: number,
  percentageFareComponent: number,
  driverMinimumGuarantee: number
): CancelMoneyBreakdown {
  return createMoneyBreakdownFn(baseCancellationFee, waitingCharges, percentageFareComponent, driverMinimumGuarantee);
}

export function evaluateTruckCancelPolicy(
  order: Pick<OrderRecord, 'totalAmount' | 'stopWaitTimers' | 'status' | 'loadingStartedAt' | 'unloadingStartedAt'>,
  assignments: Array<{ status: AssignmentStatus }>,
  reason?: string
): TruckCancelPolicyEvaluation {
  return evaluateTruckCancelPolicyFn(order, assignments, reason);
}

/**
 * Get cancel preview (delegates to order-cancel-policy.service.ts)
 */
export async function getCancelPreview(orderId: string, customerId: string, reason?: string): Promise<CancelOrderResult> {
  return getCancelPreviewFn(orderId, customerId, reason);
}

/**
 * Create cancel dispute (delegates to order-cancel-policy.service.ts)
 */
export async function createCancelDispute(
  orderId: string,
  customerId: string,
  reasonCode?: string,
  notes?: string
): Promise<{ success: boolean; disputeId?: string; message: string; stage?: TruckCancelPolicyStage }> {
  return createCancelDisputeFn(orderId, customerId, reasonCode, notes);
}

// ---------------------------------------------------------------------------
// Cancel Helper Delegates
// ---------------------------------------------------------------------------

export function buildCancelPayloadHash(orderId: string, reason?: string): string {
  return buildCancelPayloadHashFn(orderId, reason);
}

export async function getCancelIdempotentResponseDelegate(
  customerId: string,
  idempotencyKey: string,
  payloadHash: string
): Promise<CancelOrderResult | null> {
  return getCancelIdempotentResponseFn(customerId, idempotencyKey, payloadHash);
}

export async function persistCancelIdempotentResponseDelegate(
  customerId: string,
  idempotencyKey: string,
  payloadHash: string,
  orderId: string,
  response: CancelOrderResult,
  statusCode: number
): Promise<void> {
  return persistCancelIdempotentResponseFn(customerId, idempotencyKey, payloadHash, orderId, response, statusCode);
}

export async function registerCancelRebookChurn(customerId: string): Promise<void> {
  return registerCancelRebookChurnFn(customerId);
}

export async function enforceCancelRebookCooldown(customerId: string): Promise<void> {
  return enforceCancelRebookCooldownFn(customerId);
}

/**
 * Cancel an order -- atomic, idempotent, race-safe
 * (delegates to order-cancel.service.ts)
 */
export async function cancelOrder(
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
export async function acceptTruckRequest(
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

// ---------------------------------------------------------------------------
// Query Delegates
// ---------------------------------------------------------------------------

export async function getOrderDetails(orderId: string): Promise<(OrderRecord & { truckRequests: TruckRequestRecord[] }) | null> {
  return getOrderDetailsQuery(orderId);
}

export async function getActiveRequestsForTransporter(transporterId: string): Promise<TruckRequestRecord[]> {
  return getActiveRequestsForTransporterQuery(transporterId);
}

export async function getOrdersByCustomer(customerId: string): Promise<OrderRecord[]> {
  return getOrdersByCustomerQuery(customerId);
}

export async function getOrderWithRequests(orderId: string, userId: string, userRole: string) {
  return getOrderWithRequestsQuery(orderId, userId, userRole);
}

export async function getActiveTruckRequestsForTransporter(transporterId: string): Promise<ActiveTruckRequestOrderGroupImported[]> {
  return getActiveTruckRequestsForTransporterQuery(transporterId);
}

export async function getCustomerOrders(customerId: string, page: number = 1, limit: number = 20) {
  return getCustomerOrdersQuery(customerId, page, limit);
}
