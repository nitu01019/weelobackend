/**
 * =============================================================================
 * ORDER BROADCAST SERVICE - Transporter broadcast & fanout system
 * =============================================================================
 *
 * Extracted from OrderService (Phase 5 of decomposition).
 * Handles broadcasting truck requests to transporters: progressive radius
 * matching, vehicle-type-specific fanout, adaptive chunking, and
 * notified-transporter tracking.
 *
 * Also hosts shared helpers (withEventMeta, clearCustomerActiveBroadcast)
 * used by lifecycle-outbox and dispatch-outbox services.
 *
 * IMPORTANT: This file must NOT import from order.service.ts to avoid
 * circular dependencies. All dependencies flow one direction:
 *   order.service.ts → order-broadcast.service.ts
 * =============================================================================
 */

import { v4 as uuidv4 } from 'uuid';
import { db, TruckRequestRecord } from '../../shared/database/db';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, emitToUsers } from '../../shared/services/socket.service';
import { sendPushNotification } from '../../shared/services/fcm.service';
import { cacheService } from '../../shared/services/cache.service';
import { queueService } from '../../shared/services/queue.service';
import { generateVehicleKey } from '../../shared/services/vehicle-key.service';
import { transporterOnlineService } from '../../shared/services/transporter-online.service';
import { routingService } from '../routing';
import { redisService } from '../../shared/services/redis.service';
import { PROGRESSIVE_RADIUS_STEPS, progressiveRadiusMatcher } from './progressive-radius-matcher';
import { candidateScorerService } from '../../shared/services/candidate-scorer.service';
import { metrics } from '../../shared/monitoring/metrics.service';
import type {
  BroadcastRoutePoint,
  BroadcastRouteBreakdown,
  BroadcastData,
} from './order-types';
import type { CreateOrderRequest } from './order.service';

// ---------------------------------------------------------------------------
// Constants (moved from order.service.ts)
// ---------------------------------------------------------------------------

const CACHE_KEYS = {
  TRANSPORTERS_BY_VEHICLE: 'trans:vehicle:',  // trans:vehicle:tipper:20-24Ton
};

const CACHE_TTL = {
  TRANSPORTERS: 300,    // 5 minutes - transporters by vehicle type
};

export const FF_BROADCAST_STRICT_SENT_ACCOUNTING = process.env.FF_BROADCAST_STRICT_SENT_ACCOUNTING !== 'false';

// ---------------------------------------------------------------------------
// Instance-level config (read once at module load)
// ---------------------------------------------------------------------------

const BROADCAST_TIMEOUT_MS = parseInt(process.env.BROADCAST_TIMEOUT_SECONDS || '120', 10) * 1000;
const TRANSPORTER_FANOUT_QUEUE_ENABLED = (process.env.ORDER_TRANSPORTER_FANOUT_QUEUE_ENABLED || 'true') === 'true';
const TRANSPORTER_FANOUT_SYNC_THRESHOLD = Math.max(
  1,
  parseInt(process.env.ORDER_TRANSPORTER_FANOUT_SYNC_THRESHOLD || '64', 10) || 64
);
const TRANSPORTER_FANOUT_CHUNK_SIZE = Math.min(500, Math.max(
  25,
  parseInt(process.env.ORDER_TRANSPORTER_FANOUT_QUEUE_CHUNK_SIZE || '500', 10) || 500
));
const ORDER_STEP_TIMER_PREFIX = 'timer:order-broadcast-step:';

// Duplicated from order-dispatch-outbox.service.ts to avoid circular import chain.
// Both files read from the same env var so they stay in sync.
const FF_ORDER_DISPATCH_STATUS_EVENTS = process.env.FF_ORDER_DISPATCH_STATUS_EVENTS !== 'false';

// ---------------------------------------------------------------------------
// Shared helpers (used by broadcast + lifecycle-outbox + dispatch-outbox)
// ---------------------------------------------------------------------------

/**
 * Add standard event metadata for correlation across logs, sockets and load tests.
 */
export function withEventMeta<T extends Record<string, unknown>>(payload: T, eventId?: string): T & { eventId: string; emittedAt: string } {
  return {
    ...payload,
    eventId: eventId || uuidv4(),
    emittedAt: new Date().toISOString()
  };
}

/**
 * Clear customer active broadcast key and associated idempotency keys.
 */
export async function clearCustomerActiveBroadcast(customerId: string): Promise<void> {
  const activeKey = `customer:active-broadcast:${customerId}`;
  await redisService.del(activeKey).catch((err: unknown) => {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to clear customer active broadcast key', { customerId, error: errorMessage });
  });
  // Clean up server-generated idempotency key
  const latestIdemKey = await redisService.get(`idem:broadcast:latest:${customerId}`).catch(() => null);
  if (latestIdemKey) {
    await redisService.del(latestIdemKey).catch(() => { });
    await redisService.del(`idem:broadcast:latest:${customerId}`).catch(() => { });
  }
  // Clean up client-supplied idempotency key
  const latestClientIdemKey = await redisService.get(`idempotency:order:${customerId}:latest`).catch(() => null);
  if (latestClientIdemKey) {
    await redisService.del(`idempotency:${customerId}:${latestClientIdemKey}`).catch(() => { });
    await redisService.del(`idempotency:order:${customerId}:latest`).catch(() => { });
  }
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

export function notifiedTransportersKey(orderId: string, vehicleType: string, vehicleSubtype: string): string {
  return `order:notified:transporters:${orderId}:${generateVehicleKey(vehicleType, vehicleSubtype)}`;
}

export function makeVehicleGroupKey(vehicleType: string, vehicleSubtype: string): string {
  return JSON.stringify([vehicleType, vehicleSubtype || '']);
}

export function parseVehicleGroupKey(groupKey: string): { vehicleType: string; vehicleSubtype: string } {
  try {
    const parsed = JSON.parse(groupKey);
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return {
        vehicleType: parsed[0],
        vehicleSubtype: parsed[1]
      };
    }
  } catch {
    // Legacy fallback below
  }

  const splitIndex = groupKey.indexOf('_');
  if (splitIndex === -1) {
    return { vehicleType: groupKey, vehicleSubtype: '' };
  }
  return {
    vehicleType: groupKey.slice(0, splitIndex),
    vehicleSubtype: groupKey.slice(splitIndex + 1)
  };
}

// ---------------------------------------------------------------------------
// Transporter lookup (cached)
// ---------------------------------------------------------------------------

/**
 * Get transporters by vehicle type (CACHED + AVAILABILITY FILTERED)
 * Uses cache to avoid repeated DB queries during high-load broadcasts
 */
export async function getTransportersByVehicleCached(
  vehicleType: string,
  vehicleSubtype: string
): Promise<string[]> {
  const cacheKey = `${CACHE_KEYS.TRANSPORTERS_BY_VEHICLE}${vehicleType}:${vehicleSubtype}`;

  let transporterIds: string[];

  try {
    const cached = await cacheService.get<string[]>(cacheKey);

    if (cached && Array.isArray(cached)) {
      logger.debug(`Cache HIT: ${cacheKey} (${cached.length} transporters)`);
      transporterIds = cached;
    } else {
      transporterIds = await db.getTransportersWithVehicleType(vehicleType, vehicleSubtype);
      await cacheService.set(cacheKey, transporterIds, CACHE_TTL.TRANSPORTERS);
      logger.debug(`Cache SET: ${cacheKey} (${transporterIds.length} transporters)`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Cache error for ${cacheKey}: ${message}. Falling back to DB.`);
    transporterIds = await db.getTransportersWithVehicleType(vehicleType, vehicleSubtype);
  }

  const availableTransporters = await transporterOnlineService.filterOnline(transporterIds);

  // Cap at 100 to prevent unbounded fan-out — matches booking.service.ts pattern (Google AIP-158)
  return availableTransporters.slice(0, 100);
}

/**
 * Invalidate transporter cache when vehicles change
 */
export async function invalidateTransporterCache(vehicleType: string, vehicleSubtype?: string): Promise<void> {
  if (vehicleSubtype) {
    await cacheService.delete(`${CACHE_KEYS.TRANSPORTERS_BY_VEHICLE}${vehicleType}:${vehicleSubtype}`);
  } else {
    const iterator = cacheService.scanIterator(`${CACHE_KEYS.TRANSPORTERS_BY_VEHICLE}${vehicleType}:*`);
    for await (const key of iterator) {
      await cacheService.delete(key);
    }
  }
  logger.debug(`Cache invalidated: transporters for ${vehicleType}${vehicleSubtype ? ':' + vehicleSubtype : ':*'}`);
}

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------

export function buildRequestsByType(requests: TruckRequestRecord[]): Map<string, TruckRequestRecord[]> {
  const requestsByType = new Map<string, TruckRequestRecord[]>();
  for (const request of requests) {
    const key = makeVehicleGroupKey(request.vehicleType, request.vehicleSubtype);
    if (!requestsByType.has(key)) {
      requestsByType.set(key, []);
    }
    requestsByType.get(key)!.push(request);
  }
  return requestsByType;
}

export async function getNotifiedTransporters(orderId: string, vehicleType: string, vehicleSubtype: string): Promise<Set<string>> {
  const key = notifiedTransportersKey(orderId, vehicleType, vehicleSubtype);
  const members = await redisService.sMembers(key).catch(() => []);
  return new Set(members);
}

export async function markTransportersNotified(
  orderId: string,
  vehicleType: string,
  vehicleSubtype: string,
  transporterIds: string[]
): Promise<void> {
  if (transporterIds.length === 0) return;
  const key = notifiedTransportersKey(orderId, vehicleType, vehicleSubtype);
  // Fix C1: Atomic SADD+EXPIRE via Lua script -- prevents orphaned sets without TTL
  const ttlSeconds = Math.ceil(BROADCAST_TIMEOUT_MS / 1000) + 120;
  await redisService.sAddWithExpire(key, ttlSeconds, ...transporterIds).catch(() => { });
}

export function chunkTransporterIds(transporterIds: string[]): string[][] {
  if (transporterIds.length <= TRANSPORTER_FANOUT_CHUNK_SIZE) {
    return [transporterIds];
  }
  const chunks: string[][] = [];
  for (let index = 0; index < transporterIds.length; index += TRANSPORTER_FANOUT_CHUNK_SIZE) {
    chunks.push(transporterIds.slice(index, index + TRANSPORTER_FANOUT_CHUNK_SIZE));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Broadcast state changed (customer-facing lifecycle event)
// ---------------------------------------------------------------------------

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
  if (!FF_ORDER_DISPATCH_STATUS_EVENTS) return;
  metrics.incrementCounter('broadcast_state_transition_total', {
    status: (payload.status || 'unknown').toLowerCase(),
    dispatch_state: (payload.dispatchState || 'unknown').toLowerCase(),
    reason_code: (payload.reasonCode || 'none').toLowerCase()
  });
  emitToUser(
    customerId,
    'broadcast_state_changed',
    withEventMeta({
      ...payload,
      eventVersion: 1,
      serverTimeMs: Date.now(),
      stateChangedAt: payload.stateChangedAt || new Date().toISOString()
    })
  );

  // C-3 FIX: FCM fallback for offline customer — fire-and-forget
  // If customer kills the app or loses connectivity, they miss all progress
  // events via socket. This ensures intermediate states (broadcast updates,
  // truck holds, radius expansion) still reach them via push notification.
  sendPushNotification(customerId, {
    title: 'Order Update',
    body: `Your order status changed to ${payload.status}`,
    data: {
      type: 'ORDER_STATUS_UPDATE',
      orderId: payload.orderId,
      status: payload.status,
    },
  }).catch((err: unknown) => {
    logger.warn('[FCM] Intermediate state push failed', {
      orderId: payload.orderId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

// ---------------------------------------------------------------------------
// Adaptive transporter fanout
// ---------------------------------------------------------------------------

export async function emitToTransportersWithAdaptiveFanout(
  transporterIds: string[],
  events: Array<{ event: string; payload: Record<string, unknown> }>,
  context: string
): Promise<void> {
  if (transporterIds.length === 0 || events.length === 0) return;

  const uniqueTransporters = Array.from(new Set(transporterIds));
  const useSynchronousEmit = !TRANSPORTER_FANOUT_QUEUE_ENABLED ||
    uniqueTransporters.length <= TRANSPORTER_FANOUT_SYNC_THRESHOLD;

  if (useSynchronousEmit) {
    for (const eventSpec of events) {
      emitToUsers(uniqueTransporters, eventSpec.event, eventSpec.payload);
    }
    return;
  }

  const chunks = chunkTransporterIds(uniqueTransporters);
  const queued: Array<{ chunk: string[]; event: string; payload: Record<string, unknown>; promise: Promise<string[]> }> = [];

  for (const eventSpec of events) {
    for (const chunk of chunks) {
      queued.push({
        chunk,
        event: eventSpec.event,
        payload: eventSpec.payload,
        promise: queueService.queueBroadcastBatch(chunk, eventSpec.event, eventSpec.payload)
      });
    }
  }

  const settled = await Promise.allSettled(queued.map((job) => job.promise));
  let fallbackDeliveries = 0;

  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') return;
    const failedJob = queued[index];
    fallbackDeliveries += failedJob.chunk.length;
    emitToUsers(failedJob.chunk, failedJob.event, failedJob.payload);
  });

  if (fallbackDeliveries > 0) {
    logger.warn(`[FANOUT] Queue fallback used for ${fallbackDeliveries} transporter deliveries`, {
      context,
      events: events.map((item) => item.event),
      totalTransporters: uniqueTransporters.length
    });
  } else {
    logger.info(`[FANOUT] Queued transporter fanout`, {
      context,
      events: events.map((item) => item.event),
      totalTransporters: uniqueTransporters.length,
      chunks: chunks.length
    });
  }
}

// ---------------------------------------------------------------------------
// Driver cancellation events
// ---------------------------------------------------------------------------

/**
 * Emit cancellation events to drivers with dual-event compatibility.
 *
 * Captain app currently consumes both `trip_cancelled` (new) and
 * `order_cancelled` (legacy) paths. Keep payload shape aligned so
 * either listener can drive the same UI behavior.
 */
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
  const correlationEventId = uuidv4();
  const emittedAt = new Date().toISOString();
  const eventPayload = {
    orderId: payload.orderId,
    tripId: payload.tripId ?? '',
    reason: payload.reason,
    message: payload.message,
    cancelledAt: payload.cancelledAt || new Date().toISOString(),
    customerName: payload.customerName ?? '',
    customerPhone: payload.customerPhone ?? '',
    pickupAddress: payload.pickupAddress ?? '',
    dropAddress: payload.dropAddress ?? '',
    compensationAmount: payload.compensationAmount ?? 0,
    settlementState: payload.settlementState ?? 'none',
    eventId: correlationEventId,
    emittedAt
  };

  emitToUser(driverId, 'trip_cancelled', eventPayload);
  emitToUser(driverId, 'order_cancelled', eventPayload);
}

// ---------------------------------------------------------------------------
// Core broadcast methods
// ---------------------------------------------------------------------------

/**
 * Broadcast truck requests to matching transporters
 *
 * KEY: Each vehicle type goes ONLY to transporters with that type
 *
 * CRITICAL FIX: Accepts `resolvedPickup` as parameter instead of using
 * `request.pickup` which is OPTIONAL (undefined when routePoints used).
 * The caller extracts pickup from routePoints or request.pickup.
 */
export async function broadcastToTransporters(
  orderId: string,
  request: CreateOrderRequest,
  truckRequests: TruckRequestRecord[],
  expiresAt: string,
  resolvedPickup: { latitude: number; longitude: number; address: string; city?: string; state?: string }
): Promise<{ onlineCandidates: number; notifiedTransporters: number }> {
  const requestsByType = buildRequestsByType(truckRequests);
  let onlineCandidates = 0;
  let notifiedTransporters = 0;

  for (const [typeKey, requests] of requestsByType) {
    const { vehicleType, vehicleSubtype } = parseVehicleGroupKey(typeKey);
    const alreadyNotified = await getNotifiedTransporters(orderId, vehicleType, vehicleSubtype);
    // Phase 6: Measure candidate lookup latency
    const lookupStart = Date.now();
    const stepCandidates = await progressiveRadiusMatcher.findCandidates({
      pickupLat: resolvedPickup.latitude,
      pickupLng: resolvedPickup.longitude,
      vehicleType,
      vehicleSubtype,
      stepIndex: 0,
      alreadyNotified
    });
    metrics.observeHistogram('broadcast_candidate_lookup_ms', Date.now() - lookupStart, {
      algorithm: process.env.FF_H3_INDEX_ENABLED === 'true' ? 'h3' : 'georadius',
      step: '0'
    });
    metrics.incrementCounter('broadcast_candidates_found', { vehicleType, step: '0' }, stepCandidates.length);

    // Phase 3: Score candidates by ETA (feature-flagged, default OFF -> no-op sort)
    const scoringStart = Date.now();
    const scoredCandidates = await candidateScorerService.scoreAndRank(
      stepCandidates,
      resolvedPickup.latitude,
      resolvedPickup.longitude
    );
    metrics.observeHistogram('broadcast_scoring_ms', Date.now() - scoringStart, {
      source: process.env.FF_DIRECTIONS_API_SCORING_ENABLED === 'true' ? 'directions_api' : 'h3_approx'
    });
    const targetTransporters = scoredCandidates.map((c) => c.transporterId);
    // Preserve per-transporter pickup distance from scored candidates
    // (already computed by progressive-radius-matcher via Distance Matrix API)
    const candidateDistanceMap = new Map(
      scoredCandidates.map((c) => [c.transporterId, { distanceKm: c.distanceKm, etaSeconds: c.etaSeconds }])
    );
    onlineCandidates += targetTransporters.length;

    if (targetTransporters.length > 0) {
      metrics.incrementCounter('broadcast_fanout_total', { vehicleType }, targetTransporters.length);
      const sendResult = await broadcastVehicleTypePayload(
        orderId,
        request,
        truckRequests,
        requestsByType,
        requests,
        vehicleType,
        vehicleSubtype,
        targetTransporters,
        expiresAt,
        candidateDistanceMap
      );
      await markTransportersNotified(orderId, vehicleType, vehicleSubtype, sendResult.sentTransporters);
      notifiedTransporters += sendResult.sentTransporters.length;
    } else {
      metrics.incrementCounter('broadcast_skipped_no_available', { vehicleType });
      logger.warn(`⚠️ No transporters found for ${vehicleType} (${vehicleSubtype}) in step 10km`);
    }

    // Always schedule the next step for unresolved demand.
    // When demand is fulfilled before the timer fires, step processing exits early.
    await scheduleNextProgressiveStep(orderId, vehicleType, vehicleSubtype, 1);
  }

  return { onlineCandidates, notifiedTransporters };
}

/**
 * Process a single progressive broadcast step (called by timer)
 */
export async function processProgressiveBroadcastStep(timerData: {
  orderId: string;
  vehicleType: string;
  vehicleSubtype: string;
  stepIndex: number;
}): Promise<void> {
  const step = progressiveRadiusMatcher.getStep(timerData.stepIndex);
  if (!step) return;

  const order = await db.getOrderById(timerData.orderId);
  if (!order) return;
  if (!['created', 'broadcasting', 'active', 'partially_filled'].includes(order.status)) {
    return;
  }

  const truckRequests = await db.getTruckRequestsByOrder(timerData.orderId);
  const activeRequestsForType = truckRequests.filter((request) => {
    return request.status === 'searching' &&
      request.vehicleType === timerData.vehicleType &&
      request.vehicleSubtype === timerData.vehicleSubtype;
  });
  if (activeRequestsForType.length === 0) return;

  const alreadyNotified = await getNotifiedTransporters(
    timerData.orderId,
    timerData.vehicleType,
    timerData.vehicleSubtype
  );
  // Phase 6: Measure progressive step candidate lookup latency
  const stepLookupStart = Date.now();
  const stepCandidates = await progressiveRadiusMatcher.findCandidates({
    pickupLat: order.pickup.latitude,
    pickupLng: order.pickup.longitude,
    vehicleType: timerData.vehicleType,
    vehicleSubtype: timerData.vehicleSubtype,
    stepIndex: timerData.stepIndex,
    alreadyNotified
  });
  metrics.observeHistogram('broadcast_candidate_lookup_ms', Date.now() - stepLookupStart, {
    algorithm: process.env.FF_H3_INDEX_ENABLED === 'true' ? 'h3' : 'georadius',
    step: String(timerData.stepIndex)
  });
  metrics.incrementCounter('broadcast_candidates_found', {
    vehicleType: timerData.vehicleType, step: String(timerData.stepIndex)
  }, stepCandidates.length);

  // Phase 3: Score candidates by ETA (feature-flagged)
  const stepScoringStart = Date.now();
  const scoredCandidates = await candidateScorerService.scoreAndRank(
    stepCandidates,
    order.pickup.latitude,
    order.pickup.longitude
  );
  metrics.observeHistogram('broadcast_scoring_ms', Date.now() - stepScoringStart, {
    source: process.env.FF_DIRECTIONS_API_SCORING_ENABLED === 'true' ? 'directions_api' : 'h3_approx'
  });
  const targetTransporters = scoredCandidates.map((c) => c.transporterId);
  // Preserve per-transporter pickup distance from scored candidates
  const candidateDistanceMap = new Map(
    scoredCandidates.map((c) => [c.transporterId, { distanceKm: c.distanceKm, etaSeconds: c.etaSeconds }])
  );

  if (targetTransporters.length === 0) {
    metrics.incrementCounter('broadcast_skipped_no_available', { vehicleType: timerData.vehicleType });

    // H-12/H-17 FIX: Proactive customer notification when all radius steps exhausted.
    // Previously only fired when alreadyNotified.size === 0 (zero transporters ever notified).
    // Now also fires when steps are exhausted even if some transporters were notified earlier
    // but this final step found zero NEW candidates — customer needs to know search is widening.
    const nextStep = progressiveRadiusMatcher.getStep(timerData.stepIndex + 1);
    if (!nextStep) {
      try {
        logger.info(`[ProgressiveMatch] All radius steps exhausted for ${timerData.vehicleType} — notifying customer`, {
          orderId: timerData.orderId,
          alreadyNotifiedCount: alreadyNotified.size,
          maxRadiusKm: step.radiusKm,
        });
        emitToUser(order.customerId, 'no_vehicles_available', {
          orderId: timerData.orderId,
          vehicleType: timerData.vehicleType,
          vehicleSubtype: timerData.vehicleSubtype,
          reason: alreadyNotified.size === 0 ? 'no_transporters_in_area' : 'no_new_transporters_at_max_radius',
          message: 'No transporters available in your area right now. We will keep searching until timeout.',
          radiusSearchedKm: step.radiusKm,
          transportersNotifiedSoFar: alreadyNotified.size,
          payloadVersion: 1,
          _seq: Date.now(), // client-side dedup
          timestamp: new Date().toISOString(),
        });
      } catch (emitErr: any) {
        logger.warn('[ProgressiveMatch] Failed to emit no_vehicles_available', {
          orderId: timerData.orderId,
          error: emitErr?.message,
        });
      }
    }

    await scheduleNextProgressiveStep(
      timerData.orderId,
      timerData.vehicleType,
      timerData.vehicleSubtype,
      timerData.stepIndex + 1
    );
    return;
  }
  metrics.incrementCounter('broadcast_fanout_total', { vehicleType: timerData.vehicleType }, targetTransporters.length);

  const requestFromOrder: CreateOrderRequest = {
    customerId: order.customerId,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    routePoints: order.routePoints,
    pickup: order.pickup,
    drop: order.drop,
    distanceKm: order.distanceKm,
    vehicleRequirements: [],
    goodsType: order.goodsType,
    cargoWeightKg: order.cargoWeightKg
  };

  const requestsByType = buildRequestsByType(truckRequests);
  const sendResult = await broadcastVehicleTypePayload(
    timerData.orderId,
    requestFromOrder,
    truckRequests,
    requestsByType,
    activeRequestsForType,
    timerData.vehicleType,
    timerData.vehicleSubtype,
    targetTransporters,
    order.expiresAt,
    candidateDistanceMap
  );
  await markTransportersNotified(
    timerData.orderId,
    timerData.vehicleType,
    timerData.vehicleSubtype,
    sendResult.sentTransporters
  );

  await scheduleNextProgressiveStep(
    timerData.orderId,
    timerData.vehicleType,
    timerData.vehicleSubtype,
    timerData.stepIndex + 1
  );
}

/**
 * Broadcast payload for a specific vehicle type to matching transporters
 */
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
  if (matchingTransporters.length === 0) {
    return { sentTransporters: [], skippedNoAvailable: 0 };
  }

  const firstRequest = requests[0];
  const order = await db.getOrderById(orderId);
  if (!order) {
    logger.warn(`Order ${orderId} missing while broadcasting ${vehicleType}/${vehicleSubtype}`);
    return { sentTransporters: [], skippedNoAvailable: 0 };
  }

  const broadcastRoutePoints: BroadcastRoutePoint[] = order.routePoints?.map(point => ({
    type: point.type,
    latitude: point.latitude,
    longitude: point.longitude,
    address: point.address,
    city: point.city,
    stopIndex: point.stopIndex
  })) || [];
  const totalStops = broadcastRoutePoints.filter(point => point.type === 'STOP').length;
  const pickupPoint = broadcastRoutePoints.find(point => point.type === 'PICKUP') || request.pickup;
  const dropPoint = broadcastRoutePoints.find(point => point.type === 'DROP') || request.drop;

  const routeBreakdownCalc = routingService.calculateRouteBreakdown(
    order.routePoints?.map((point) => ({
      type: point.type,
      latitude: point.latitude,
      longitude: point.longitude,
      address: point.address,
      city: point.city,
      stopIndex: point.stopIndex
    })) || [],
    new Date()
  );

  const routeBreakdown: BroadcastRouteBreakdown = {
    legs: routeBreakdownCalc.legs.map((leg) => ({
      fromIndex: leg.fromIndex,
      toIndex: leg.toIndex,
      fromType: leg.fromType,
      toType: leg.toType,
      fromAddress: leg.fromAddress,
      toAddress: leg.toAddress,
      fromCity: leg.fromCity,
      toCity: leg.toCity,
      distanceKm: leg.distanceKm,
      durationMinutes: leg.durationMinutes,
      durationFormatted: `${Math.floor(leg.durationMinutes / 60)} hrs ${leg.durationMinutes % 60} mins`,
      etaMinutes: leg.etaToEndMinutes
    })),
    totalDistanceKm: routeBreakdownCalc.totalDistanceKm,
    totalDurationMinutes: routeBreakdownCalc.totalDurationMinutes,
    totalDurationFormatted: routeBreakdownCalc.totalDurationFormatted,
    totalStops: routeBreakdownCalc.totalStops,
    estimatedArrival: routeBreakdownCalc.estimatedArrival
  };
  const broadcastEventId = uuidv4();
  const broadcastServerTimeMs = Date.now();

  const broadcastData: BroadcastData = {
    type: 'new_broadcast',
    orderId,
    truckRequestId: firstRequest.id,
    requestNumber: firstRequest.requestNumber,
    customerName: request.customerName,
    routePoints: broadcastRoutePoints,
    totalStops,
    routeBreakdown,
    pickup: {
      latitude: pickupPoint?.latitude || 0,
      longitude: pickupPoint?.longitude || 0,
      address: pickupPoint?.address || '',
      city: pickupPoint?.city
    },
    drop: {
      latitude: dropPoint?.latitude || 0,
      longitude: dropPoint?.longitude || 0,
      address: dropPoint?.address || '',
      city: dropPoint?.city
    },
    pickupAddress: pickupPoint?.address || '',
    pickupCity: pickupPoint?.city || '',
    dropAddress: dropPoint?.address || '',
    dropCity: dropPoint?.city || '',
    vehicleType,
    vehicleSubtype,
    pricePerTruck: firstRequest.pricePerTruck,
    farePerTruck: firstRequest.pricePerTruck,
    distanceKm: request.distanceKm,
    distance: request.distanceKm,
    goodsType: request.goodsType,
    expiresAt,
    createdAt: new Date().toISOString(),
    eventId: broadcastEventId,
    eventVersion: 1,
    serverTimeMs: broadcastServerTimeMs
  };

  const requestedVehicles: any[] = [];
  for (const [key, reqs] of requestsByType) {
    const { vehicleType: requestVehicleType, vehicleSubtype: requestVehicleSubtype } = parseVehicleGroupKey(key);
    const first = reqs[0];
    requestedVehicles.push({
      vehicleType: requestVehicleType,
      vehicleSubtype: requestVehicleSubtype || '',
      count: reqs.length,
      filledCount: reqs.filter((requestItem) => requestItem.status !== 'searching').length,
      farePerTruck: first.pricePerTruck,
      capacityTons: 0
    });
  }

  const trucksStillNeeded = requests.length;
  const extendedBroadcast = {
    ...broadcastData,
    broadcastId: orderId,
    trucksNeededOfThisType: trucksStillNeeded,
    trucksNeeded: trucksStillNeeded,
    totalTrucksInOrder: truckRequests.length,
    totalTrucksNeeded: truckRequests.length,
    trucksFilled: truckRequests.filter((requestItem) => requestItem.status !== 'searching').length,
    requestedVehicles
  };

  const availabilitySnapshot = await db.getTransportersAvailabilitySnapshot(vehicleType, vehicleSubtype) as Array<{
    transporterId: string;
    transporterName: string;
    totalOwned: number;
    available: number;
    inTransit: number;
  }>;
  const availabilityMap = new Map(
    availabilitySnapshot.map((item) => [item.transporterId, item])
  );

  const sentTransporters: string[] = [];
  const enqueueAcceptedTransporters: string[] = [];
  const enqueueFailedTransporters: string[] = [];
  let skippedNoAvailable = 0;

  // M-23 FIX: Pre-emit order status check interval.
  // Check every N transporters to avoid DB spam, but catch cancellations mid-broadcast.
  const BROADCAST_STATUS_CHECK_INTERVAL = Math.max(
    5,
    parseInt(process.env.BROADCAST_STATUS_CHECK_INTERVAL || '20', 10) || 20
  );
  let broadcastEmitCount = 0;
  let broadcastAborted = false;

  const socketQueueJobs: Array<Promise<void>> = [];
  for (const transporterId of matchingTransporters) {
    // M-23 FIX: Check order status before emitting (reduce stale broadcasts after cancel)
    // Only check every N transporters to avoid DB spam
    if (broadcastEmitCount > 0 && broadcastEmitCount % BROADCAST_STATUS_CHECK_INTERVAL === 0) {
      try {
        const currentOrder = await db.getOrderById(orderId);
        if (currentOrder && ['cancelled', 'expired', 'completed', 'fully_filled'].includes(currentOrder.status)) {
          logger.info('[Broadcast] Order became inactive mid-broadcast, stopping', {
            orderId, status: currentOrder.status, emittedSoFar: broadcastEmitCount
          });
          broadcastAborted = true;
          break;
        }
      } catch (checkErr: unknown) {
        // Fail-open: if check fails, continue broadcasting
        const msg = checkErr instanceof Error ? checkErr.message : String(checkErr);
        logger.warn('[Broadcast] Mid-broadcast status check failed', { orderId, error: msg });
      }
    }

    const availability = availabilityMap.get(transporterId);
    if (!availability || availability.available <= 0) {
      skippedNoAvailable++;
      continue;
    }

    const trucksYouCanProvide = Math.min(availability.available, trucksStillNeeded);
    // Per-transporter pickup distance from Distance Matrix API (already computed)
    const pickupData = candidateDistanceMap?.get(transporterId);
    if (!pickupData) {
      logger.warn('broadcast.pickup_data_missing', {
        orderId,
        transporterId,
        candidateMapSize: candidateDistanceMap?.size ?? 0
      });
    }
    const personalizedBroadcast = {
      ...extendedBroadcast,
      trucksYouCanProvide,
      maxTrucksYouCanProvide: trucksYouCanProvide,
      yourAvailableTrucks: availability.available,
      yourTotalTrucks: availability.totalOwned,
      trucksStillNeeded,
      trucksNeededOfThisType: trucksStillNeeded,
      pickupDistanceKm: pickupData?.distanceKm ?? 0,
      pickupEtaMinutes: Math.ceil((pickupData?.etaSeconds ?? 0) / 60),
      isPersonalized: true,
      personalizedFor: transporterId
    };

    const enqueueStartedAt = Date.now();
    socketQueueJobs.push(
      queueService
        .queueBroadcast(transporterId, 'new_broadcast', personalizedBroadcast)
        .then(() => {
          enqueueAcceptedTransporters.push(transporterId);
          logger.info('broadcast.enqueue.accepted', {
            orderId,
            transporterId,
            latencyMs: Date.now() - enqueueStartedAt
          });
        })
        .catch((error) => {
          enqueueFailedTransporters.push(transporterId);
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`Failed to queue broadcast for transporter ${transporterId}: ${message}`, {
            orderId,
            transporterId,
            metric: 'broadcast.enqueue.failed',
            latencyMs: Date.now() - enqueueStartedAt
          });
        })
    );
    if (!FF_BROADCAST_STRICT_SENT_ACCOUNTING) {
      sentTransporters.push(transporterId);
    }
    broadcastEmitCount++;
  }

  if (broadcastAborted) {
    logger.info('[Broadcast] Broadcast aborted early due to inactive order', {
      orderId, emittedSoFar: broadcastEmitCount, totalCandidates: matchingTransporters.length
    });
  }

  // === PHASE 4: ADAPTIVE FANOUT CHUNKING (configurable) ===
  // Split enqueue jobs into chunks to prevent Redis CPU spike on large fanout.
  // Closest transporters (sorted by ETA) are in the first chunk.
  // Default chunk size = 500 (effectively no chunking for normal orders).
  const FANOUT_CHUNK_SIZE = Math.min(
    500,
    Math.max(
      10,
      parseInt(process.env.FF_ADAPTIVE_FANOUT_CHUNK_SIZE || '500', 10) || 500
    )
  );
  const FANOUT_CHUNK_DELAY_MS = Math.max(
    0,
    parseInt(process.env.FF_ADAPTIVE_FANOUT_DELAY_MS || '0', 10) || 0
  );

  if (socketQueueJobs.length > 0) {
    if (socketQueueJobs.length <= FANOUT_CHUNK_SIZE || FANOUT_CHUNK_DELAY_MS === 0) {
      // No chunking needed -- fire all at once (original behavior)
      await Promise.allSettled(socketQueueJobs);
    } else {
      // Chunked fanout with inter-chunk delay
      for (let i = 0; i < socketQueueJobs.length; i += FANOUT_CHUNK_SIZE) {
        const chunk = socketQueueJobs.slice(i, i + FANOUT_CHUNK_SIZE);
        await Promise.allSettled(chunk);
        if (i + FANOUT_CHUNK_SIZE < socketQueueJobs.length && FANOUT_CHUNK_DELAY_MS > 0) {
          await new Promise(resolve => setTimeout(resolve, FANOUT_CHUNK_DELAY_MS));
        }
      }
    }
  }

  if (FF_BROADCAST_STRICT_SENT_ACCOUNTING) {
    sentTransporters.push(...enqueueAcceptedTransporters);
  }

  const notifiedUpdateJobs: Array<Promise<unknown>> = [];
  for (const requestItem of requests) {
    const mergedNotified = Array.from(
      new Set([
        ...(requestItem.notifiedTransporters || []),
        ...sentTransporters
      ])
    );
    notifiedUpdateJobs.push(db.updateTruckRequest(requestItem.id, {
      notifiedTransporters: mergedNotified
    }));
  }
  if (notifiedUpdateJobs.length > 0) {
    await Promise.allSettled(notifiedUpdateJobs);
  }

  if (sentTransporters.length > 0) {
    await queueService.queuePushNotificationBatch(
      sentTransporters,
      {
        title: `🚛 ${extendedBroadcast.trucksNeededOfThisType}x ${vehicleType.toUpperCase()} Required!`,
        body: `${extendedBroadcast.pickup.city || extendedBroadcast.pickup.address} → ${extendedBroadcast.drop.city || extendedBroadcast.drop.address}`,
        data: {
          type: 'new_broadcast',
          orderId: extendedBroadcast.orderId,
          broadcastId: extendedBroadcast.broadcastId,
          truckRequestId: extendedBroadcast.truckRequestId,
          legacyType: 'new_truck_request'
        }
      }
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to queue push notifications for order ${orderId}: ${message}`);
    });
  }

  logger.info('broadcast.enqueue.summary', {
    orderId,
    metricAccepted: 'broadcast.enqueue.accepted',
    metricFailed: 'broadcast.enqueue.failed',
    metricLatency: 'broadcast.enqueue.latency_ms',
    acceptedCount: enqueueAcceptedTransporters.length,
    failedCount: enqueueFailedTransporters.length,
    skippedNoAvailable,
    strictMode: FF_BROADCAST_STRICT_SENT_ACCOUNTING
  });

  return { sentTransporters, skippedNoAvailable };
}

// ---------------------------------------------------------------------------
// Progressive step scheduling
// ---------------------------------------------------------------------------

export async function scheduleNextProgressiveStep(
  orderId: string,
  vehicleType: string,
  vehicleSubtype: string,
  stepIndex: number
): Promise<void> {
  const step = PROGRESSIVE_RADIUS_STEPS[stepIndex];
  if (!step) return;

  const timerKey = orderBroadcastStepTimerKey(orderId, vehicleType, vehicleSubtype, stepIndex);
  const alreadyScheduled = await redisService.hasTimer(timerKey).catch(() => false);
  if (alreadyScheduled) return;

  await redisService.setTimer(
    timerKey,
    {
      orderId,
      vehicleType,
      vehicleSubtype,
      stepIndex,
      scheduledAtMs: Date.now(),
      stepWindowMs: step.windowMs
    },
    new Date(Date.now() + step.windowMs)
  );
}

/**
 * Timer key for broadcast step timers (used by order-timer extraction)
 */
export function orderBroadcastStepTimerKey(
  orderId: string,
  vehicleType: string,
  vehicleSubtype: string,
  stepIndex: number
): string {
  return `${ORDER_STEP_TIMER_PREFIX}${orderId}:${vehicleType}:${vehicleSubtype}:${stepIndex}`;
}
