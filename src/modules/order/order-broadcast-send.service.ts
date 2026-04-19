/**
 * =============================================================================
 * ORDER BROADCAST SEND SERVICE - Transporter fanout & delivery
 * =============================================================================
 *
 * Extracted from order-broadcast.service.ts (file-split).
 * Contains: broadcastToTransporters, broadcastVehicleTypePayload,
 *           emitToTransportersWithAdaptiveFanout, emitBroadcastStateChanged,
 *           emitDriverCancellationEvents, and scheduling helpers.
 *
 * IMPORTANT: This file must NOT import from order.service.ts or the facade
 * order-broadcast.service.ts to avoid circular dependencies.
 * =============================================================================
 */

import { v4 as uuidv4 } from 'uuid';
import { db, TruckRequestRecord } from '../../shared/database/db';
import { prismaClient } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, emitToUsers } from '../../shared/services/socket.service';
import { sendPushNotification } from '../../shared/services/fcm.service';
import { queueService } from '../../shared/services/queue.service';
import { redisService } from '../../shared/services/redis.service';
import { maskPhoneForExternal } from '../../shared/utils/pii.utils';
import { routingService } from '../routing';
import { PROGRESSIVE_RADIUS_STEPS, progressiveRadiusMatcher } from './progressive-radius-matcher';
import { candidateScorerService } from '../../shared/services/candidate-scorer.service';
import { metrics } from '../../shared/monitoring/metrics.service';
import type {
  BroadcastRoutePoint,
  BroadcastRouteBreakdown,
  BroadcastData,
} from './order-types';
import type { CreateOrderRequest } from './order-core-types';
import { getErrorMessage } from '../../shared/utils/error.utils';
import { adminSuspensionService } from '../admin/admin-suspension.service';

// Import query helpers directly (not through facade)
import {
  buildRequestsByType,
  getNotifiedTransporters,
  markTransportersNotified,
  chunkTransporterIds,
  parseVehicleGroupKey,
  withEventMeta,
  FF_BROADCAST_STRICT_SENT_ACCOUNTING,
} from './order-broadcast-query.service';

// ---------------------------------------------------------------------------
// Instance-level config (read once at module load)
// ---------------------------------------------------------------------------

const TRANSPORTER_FANOUT_QUEUE_ENABLED = (process.env.ORDER_TRANSPORTER_FANOUT_QUEUE_ENABLED || 'true') === 'true';
const TRANSPORTER_FANOUT_SYNC_THRESHOLD = Math.max(
  1,
  parseInt(process.env.ORDER_TRANSPORTER_FANOUT_SYNC_THRESHOLD || '64', 10) || 64
);

const ORDER_STEP_TIMER_PREFIX = 'timer:order-broadcast-step:';

// Duplicated from order-dispatch-outbox.service.ts to avoid circular import chain.
const FF_ORDER_DISPATCH_STATUS_EVENTS = process.env.FF_ORDER_DISPATCH_STATUS_EVENTS !== 'false';

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

  // C-3 FIX: FCM fallback for offline customer
  sendPushNotification(customerId, {
    title: 'Order Update',
    body: `Your order status changed to ${payload.status}`,
    data: {
      type: 'order_status_update',
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
    customerPhone: maskPhoneForExternal(payload.customerPhone),
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

    const scoringStart = Date.now();
    const scoredCandidates = await candidateScorerService.scoreAndRank(
      stepCandidates,
      resolvedPickup.latitude,
      resolvedPickup.longitude
    );
    metrics.observeHistogram('broadcast_scoring_ms', Date.now() - scoringStart, {
      source: process.env.FF_DIRECTIONS_API_SCORING_ENABLED === 'true' ? 'directions_api' : 'h3_approx'
    });
    const allCandidateTransporters = scoredCandidates.map((c) => c.transporterId);
    const candidateDistanceMap = new Map(
      scoredCandidates.map((c) => [c.transporterId, { distanceKm: c.distanceKm, etaSeconds: c.etaSeconds }])
    );

    // Filter out suspended transporters before broadcasting
    const suspensionChecks = await Promise.all(
      allCandidateTransporters.map(async (tid) => ({
        id: tid,
        suspended: await adminSuspensionService.isUserSuspended(tid),
      }))
    );
    const targetTransporters = suspensionChecks
      .filter((c) => !c.suspended)
      .map((c) => c.id);
    const suspendedCount = allCandidateTransporters.length - targetTransporters.length;
    if (suspendedCount > 0) {
      logger.info('[Broadcast] Filtered suspended transporters', {
        orderId,
        vehicleType,
        suspendedCount,
        remainingCount: targetTransporters.length,
      });
    }

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
      logger.warn(`No transporters found for ${vehicleType} (${vehicleSubtype}) in step 10km`);
    }

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

  const truckRequests: TruckRequestRecord[] = await db.getTruckRequestsByOrder(timerData.orderId);
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
  const candidateDistanceMap = new Map(
    scoredCandidates.map((c) => [c.transporterId, { distanceKm: c.distanceKm, etaSeconds: c.etaSeconds }])
  );

  if (targetTransporters.length === 0) {
    metrics.incrementCounter('broadcast_skipped_no_available', { vehicleType: timerData.vehicleType });

    const nextStep = progressiveRadiusMatcher.getStep(timerData.stepIndex + 1);
    if (!nextStep) {
      try {
        logger.info(`[ProgressiveMatch] All radius steps exhausted for ${timerData.vehicleType} -- notifying customer`, {
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
          _seq: Date.now(),
          timestamp: new Date().toISOString(),
        });
      } catch (emitErr: unknown) {
        logger.warn('[ProgressiveMatch] Failed to emit no_vehicles_available', {
          orderId: timerData.orderId,
          error: getErrorMessage(emitErr),
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
    customerPhone: maskPhoneForExternal(order.customerPhone),
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

  const rawRoutePoints: BroadcastRoutePoint[] = (order.routePoints as BroadcastRoutePoint[]) || [];
  const broadcastRoutePoints: BroadcastRoutePoint[] = rawRoutePoints.map((point) => ({
    type: point.type,
    latitude: point.latitude,
    longitude: point.longitude,
    address: point.address,
    city: point.city,
    stopIndex: point.stopIndex
  }));
  const totalStops = broadcastRoutePoints.filter((point: BroadcastRoutePoint) => point.type === 'STOP').length;
  const pickupPoint = broadcastRoutePoints.find((point: BroadcastRoutePoint) => point.type === 'PICKUP') || request.pickup;
  const dropPoint = broadcastRoutePoints.find((point: BroadcastRoutePoint) => point.type === 'DROP') || request.drop;

  const routeBreakdownCalc = routingService.calculateRouteBreakdown(
    rawRoutePoints.map((point) => ({
      type: point.type,
      latitude: point.latitude,
      longitude: point.longitude,
      address: point.address,
      city: point.city,
      stopIndex: point.stopIndex
    })),
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

  const requestedVehicles: Array<{ vehicleType: string; vehicleSubtype: string; count: number; filledCount: number; farePerTruck: number; capacityTons: number }> = [];
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

  // KYC/Verification gate (defense-in-depth): skip unverified transporters.
  // Primary gate is at query level (getTransportersWithVehicleType), but this
  // catches any that slip through via cache, Redis geo index, or fallback paths.
  let verifiedTransporters = matchingTransporters;
  try {
    const verifiedRows = await prismaClient.user.findMany({
      where: {
        id: { in: matchingTransporters },
        isVerified: true,
      },
      select: { id: true },
    });
    const verifiedSet = new Set(verifiedRows.map((u: { id: string }) => u.id));
    const beforeKyc = matchingTransporters.length;
    verifiedTransporters = matchingTransporters.filter(tid => {
      if (verifiedSet.has(tid)) return true;
      logger.info(`[Dispatch] Skipping unverified transporter ${tid}`);
      return false;
    });
    if (verifiedTransporters.length < beforeKyc) {
      logger.info(`[OrderBroadcast] KYC gate: ${beforeKyc} -> ${verifiedTransporters.length} (filtered ${beforeKyc - verifiedTransporters.length} unverified transporters)`);
    }
  } catch (kycErr: unknown) {
    // Fail-open: if KYC check fails, proceed with current list (previous behavior)
    const msg = kycErr instanceof Error ? kycErr.message : String(kycErr);
    logger.warn('[OrderBroadcast] KYC verification check failed, proceeding with current list', { orderId, error: msg });
  }

  const sentTransporters: string[] = [];
  const enqueueAcceptedTransporters: string[] = [];
  const enqueueFailedTransporters: string[] = [];
  let skippedNoAvailable = 0;

  const BROADCAST_STATUS_CHECK_INTERVAL = Math.max(
    5,
    parseInt(process.env.BROADCAST_STATUS_CHECK_INTERVAL || '20', 10) || 20
  );
  let broadcastEmitCount = 0;
  let broadcastAborted = false;

  const socketQueueJobs: Array<Promise<void>> = [];
  for (const transporterId of verifiedTransporters) {
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
      await Promise.allSettled(socketQueueJobs);
    } else {
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
        title: `\u{1F69B} ${extendedBroadcast.trucksNeededOfThisType}x ${vehicleType.toUpperCase()} Required!`,
        body: `${extendedBroadcast.pickup.city || extendedBroadcast.pickup.address} \u2192 ${extendedBroadcast.drop.city || extendedBroadcast.drop.address}`,
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
 * Timer key for broadcast step timers
 */
export function orderBroadcastStepTimerKey(
  orderId: string,
  vehicleType: string,
  vehicleSubtype: string,
  stepIndex: number
): string {
  return `${ORDER_STEP_TIMER_PREFIX}${orderId}:${vehicleType}:${vehicleSubtype}:${stepIndex}`;
}
