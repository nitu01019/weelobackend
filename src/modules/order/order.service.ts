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
 * - AWS-ready with message queue support (TODO)
 * =============================================================================
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { Prisma } from '@prisma/client';
import { db, OrderRecord, TruckRequestRecord } from '../../shared/database/db';
import { prismaClient, OrderStatus, AssignmentStatus, VehicleStatus, BookingStatus, TruckRequestStatus } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, emitToUsers } from '../../shared/services/socket.service';
import { sendPushNotification } from '../../shared/services/fcm.service';
import { cacheService } from '../../shared/services/cache.service';
import { queueService } from '../../shared/services/queue.service';
import { availabilityService } from '../../shared/services/availability.service';
import { generateVehicleKey } from '../../shared/services/vehicle-key.service';
import { transporterOnlineService } from '../../shared/services/transporter-online.service';
import { routingService } from '../routing';
import { redisService } from '../../shared/services/redis.service';
import { pricingService } from '../pricing/pricing.service';
import { AppError } from '../../shared/types/error.types';
import { PROGRESSIVE_RADIUS_STEPS, progressiveRadiusMatcher } from './progressive-radius-matcher';
import { candidateScorerService } from '../../shared/services/candidate-scorer.service';
import { metrics } from '../../shared/monitoring/metrics.service';
import { truckHoldService } from '../truck-hold/truck-hold.service';

// =============================================================================
// CACHE KEYS & TTL (Optimized for fast lookups)
// =============================================================================
const CACHE_KEYS = {
  TRANSPORTERS_BY_VEHICLE: 'trans:vehicle:',  // trans:vehicle:tipper:20-24Ton
  ORDER: 'order:',
  ACTIVE_REQUESTS: 'active:requests:'
};

const CACHE_TTL = {
  TRANSPORTERS: 300,    // 5 minutes - transporters by vehicle type
  ORDER: 60,            // 1 minute - order details
  ACTIVE_REQUESTS: 30   // 30 seconds - active requests list
};

const FF_BROADCAST_STRICT_SENT_ACCOUNTING = process.env.FF_BROADCAST_STRICT_SENT_ACCOUNTING !== 'false';
const FF_DB_STRICT_IDEMPOTENCY = process.env.FF_DB_STRICT_IDEMPOTENCY !== 'false';
const FF_ORDER_DISPATCH_OUTBOX = process.env.FF_ORDER_DISPATCH_OUTBOX !== 'false';
const FF_ORDER_DISPATCH_STATUS_EVENTS = process.env.FF_ORDER_DISPATCH_STATUS_EVENTS !== 'false';
const FF_CANCEL_OUTBOX_ENABLED = process.env.FF_CANCEL_OUTBOX_ENABLED !== 'false';
const FF_CANCEL_POLICY_TRUCK_V1 = process.env.FF_CANCEL_POLICY_TRUCK_V1 !== 'false';
const FF_CANCEL_EVENT_VERSION_ENFORCED = process.env.FF_CANCEL_EVENT_VERSION_ENFORCED !== 'false';
const FF_CANCEL_REBOOK_CHURN_GUARD = process.env.FF_CANCEL_REBOOK_CHURN_GUARD !== 'false';
const FF_CANCEL_DEFERRED_SETTLEMENT = process.env.FF_CANCEL_DEFERRED_SETTLEMENT !== 'false';
const FF_CANCEL_IDEMPOTENCY_REQUIRED = process.env.FF_CANCEL_IDEMPOTENCY_REQUIRED !== 'false';
const ORDER_DISPATCH_OUTBOX_POLL_MS = Math.max(500, parseInt(process.env.ORDER_DISPATCH_OUTBOX_POLL_MS || '1500', 10) || 1500);
const ORDER_DISPATCH_OUTBOX_BATCH_SIZE = Math.max(1, parseInt(process.env.ORDER_DISPATCH_OUTBOX_BATCH_SIZE || '20', 10) || 20);
const ORDER_CANCEL_OUTBOX_POLL_MS = Math.max(500, parseInt(process.env.ORDER_CANCEL_OUTBOX_POLL_MS || '1500', 10) || 1500);
const ORDER_CANCEL_OUTBOX_BATCH_SIZE = Math.max(1, parseInt(process.env.ORDER_CANCEL_OUTBOX_BATCH_SIZE || '20', 10) || 20);

type OrderDispatchOutboxStatus = 'pending' | 'processing' | 'retrying' | 'dispatched' | 'failed';

interface OrderDispatchOutboxPayload {
  orderId: string;
}

interface DispatchAttemptContext {
  request: CreateOrderRequest;
  truckRequests: TruckRequestRecord[];
  expiresAt: string;
  pickup: { latitude: number; longitude: number; address: string; city?: string; state?: string };
}

interface DispatchAttemptOutcome {
  dispatchState: CreateOrderResponse['dispatchState'];
  reasonCode?: string;
  onlineCandidates: number;
  notifiedTransporters: number;
  dispatchAttempts: number;
}

interface DispatchOutboxRow {
  id: string;
  orderId: string;
  payload: Prisma.JsonValue;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: Date;
  lockedAt: Date | null;
}

type OrderLifecycleOutboxStatus = 'pending' | 'processing' | 'retrying' | 'dispatched' | 'failed';

interface OrderLifecycleOutboxPayload {
  type: 'order_cancelled';
  orderId: string;
  customerId: string;
  transporters: string[];
  drivers: Array<{
    driverId: string;
    tripId?: string;
    customerName?: string;
    customerPhone?: string;
    pickupAddress?: string;
    dropAddress?: string;
  }>;
  reason: string;
  reasonCode: string;
  cancelledAt: string;
  eventId: string;
  eventVersion: number;
  serverTimeMs: number;
  compensationAmount?: number;
  settlementState?: string;
}

interface LifecycleOutboxRow {
  id: string;
  orderId: string;
  eventType: string;
  payload: Prisma.JsonValue;
  status: OrderLifecycleOutboxStatus;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: Date;
  lockedAt: Date | null;
}

type TruckCancelPolicyStage =
  | 'SEARCHING'
  | 'DRIVER_ASSIGNED'
  | 'AT_PICKUP'
  | 'LOADING_STARTED'
  | 'IN_TRANSIT'
  | 'UNLOADING_STARTED';

type TruckCancelDecision = 'allowed' | 'blocked_dispute_only';

interface CancelMoneyBreakdown {
  baseCancellationFee: number;
  waitingCharges: number;
  percentageFareComponent: number;
  driverMinimumGuarantee: number;
  finalAmount: number;
}

interface TruckCancelPolicyEvaluation {
  stage: TruckCancelPolicyStage;
  decision: TruckCancelDecision;
  reasonRequired: boolean;
  reasonCode: string;
  penaltyBreakdown: CancelMoneyBreakdown;
  driverCompensationBreakdown: CancelMoneyBreakdown;
  settlementState: 'pending' | 'settled' | 'waived';
  pendingPenaltyAmount: number;
}

interface CancelOrderResult {
  success: boolean;
  message: string;
  transportersNotified: number;
  driversNotified?: number;
  assignmentsCancelled?: number;
  policyStage?: TruckCancelPolicyStage;
  cancelDecision?: TruckCancelDecision;
  reasonRequired?: boolean;
  reasonCode?: string;
  penaltyBreakdown?: CancelMoneyBreakdown;
  driverCompensationBreakdown?: CancelMoneyBreakdown;
  settlementState?: 'pending' | 'settled' | 'waived';
  pendingPenaltyAmount?: number;
  eventId?: string;
  eventVersion?: number;
  serverTimeMs?: number;
  disputeId?: string;
}

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

/**
 * Route Point for broadcast
 */
interface BroadcastRoutePoint {
  type: 'PICKUP' | 'STOP' | 'DROP';
  latitude: number;
  longitude: number;
  address: string;
  city?: string;
  stopIndex: number;
}

/**
 * Route Leg for broadcast (ETA per leg)
 */
interface BroadcastRouteLeg {
  fromIndex: number;
  toIndex: number;
  fromType: string;
  toType: string;
  fromAddress: string;
  toAddress: string;
  fromCity?: string;
  toCity?: string;
  distanceKm: number;
  durationMinutes: number;
  durationFormatted: string;
  etaMinutes: number;  // Cumulative ETA from start
}

/**
 * Route Breakdown for broadcast
 */
interface BroadcastRouteBreakdown {
  legs: BroadcastRouteLeg[];
  totalDistanceKm: number;
  totalDurationMinutes: number;
  totalDurationFormatted: string;
  totalStops: number;
  estimatedArrival?: string;
}

export interface ActiveTruckRequestOrderGroup {
  order: OrderRecord;
  requests: TruckRequestRecord[];
}

/**
 * Broadcast data sent to transporters via WebSocket
 * 
 * IMPORTANT: Field names must match what Captain app's SocketIOService expects!
 * Captain app parses these in handleNewBroadcast() with fallbacks.
 * 
 * ROUTE POINTS:
 * - routePoints array includes all stops (PICKUP → STOP → STOP → DROP)
 * - Driver sees full route before accepting
 * - currentRouteIndex always 0 for new broadcasts
 * 
 * @see Captain app: SocketIOService.kt -> handleNewBroadcast()
 */
interface BroadcastData {
  type: 'new_broadcast' | 'new_truck_request';
  orderId: string;
  truckRequestId: string;
  requestNumber: number;

  // Customer info
  customerName: string;

  // =========================================================================
  // ROUTE POINTS (NEW - with intermediate stops)
  // =========================================================================
  routePoints: BroadcastRoutePoint[];
  totalStops: number;  // Number of intermediate stops (0, 1, or 2)

  // =========================================================================
  // ROUTE BREAKDOWN (NEW - ETA per leg)
  // =========================================================================
  routeBreakdown: BroadcastRouteBreakdown;

  // Locations - nested format (legacy, for backward compatibility)
  pickup: {
    latitude: number;
    longitude: number;
    address: string;
    city?: string;
  };
  drop: {
    latitude: number;
    longitude: number;
    address: string;
    city?: string;
  };

  // Locations - flat format (for Captain app compatibility)
  pickupAddress: string;
  pickupCity: string;
  dropAddress: string;
  dropCity: string;

  // Vehicle requirements (THIS is what the transporter can fulfill)
  vehicleType: string;
  vehicleSubtype: string;
  pricePerTruck: number;
  farePerTruck: number;  // Alias for Captain app

  // Trip info
  distanceKm: number;
  distance: number;      // Alias for Captain app
  goodsType?: string;

  // Timing
  expiresAt: string;
  createdAt: string;
  eventId?: string;
  eventVersion?: number;
  serverTimeMs?: number;
}

// =============================================================================
// SERVICE CLASS
// =============================================================================

class OrderService {

  // Timeout for broadcasts (1 minute - quick response needed)
  private readonly BROADCAST_TIMEOUT_MS = parseInt(process.env.BROADCAST_TIMEOUT_SECONDS || '120', 10) * 1000;
  private readonly TRANSPORTER_FANOUT_QUEUE_ENABLED = (process.env.ORDER_TRANSPORTER_FANOUT_QUEUE_ENABLED || 'true') === 'true';
  private readonly TRANSPORTER_FANOUT_SYNC_THRESHOLD = Math.max(
    1,
    parseInt(process.env.ORDER_TRANSPORTER_FANOUT_SYNC_THRESHOLD || '64', 10) || 64
  );
  private readonly TRANSPORTER_FANOUT_CHUNK_SIZE = Math.max(
    25,
    parseInt(process.env.ORDER_TRANSPORTER_FANOUT_QUEUE_CHUNK_SIZE || '500', 10) || 500
  );
  private readonly ORDER_EXPIRY_TIMER_PREFIX = 'timer:order-expiry:';
  private readonly ORDER_STEP_TIMER_PREFIX = 'timer:order-broadcast-step:';
  private readonly ORDER_STEP_TIMER_LOCK_PREFIX = 'lock:order-broadcast-step:';
  private outboxWorkerTimer: NodeJS.Timeout | null = null;
  private outboxWorkerRunning = false;
  private lifecycleOutboxWorkerTimer: NodeJS.Timeout | null = null;
  private lifecycleOutboxWorkerRunning = false;

  constructor() {
    if (FF_ORDER_DISPATCH_OUTBOX && process.env.NODE_ENV !== 'test') {
      this.startDispatchOutboxWorker();
    }
    if (FF_CANCEL_OUTBOX_ENABLED && process.env.NODE_ENV !== 'test') {
      this.startLifecycleOutboxWorker();
    }
  }

  private startDispatchOutboxWorker(): void {
    if (this.outboxWorkerTimer) return;

    const poll = async (): Promise<void> => {
      if (this.outboxWorkerRunning) return;
      this.outboxWorkerRunning = true;
      try {
        await this.processDispatchOutboxBatch();
      } catch (error: any) {
        logger.error('Order dispatch outbox worker tick failed', {
          error: error?.message || 'unknown'
        });
      } finally {
        this.outboxWorkerRunning = false;
      }
    };

    this.outboxWorkerTimer = setInterval(() => {
      void poll();
    }, ORDER_DISPATCH_OUTBOX_POLL_MS);
    this.outboxWorkerTimer.unref?.();
    void poll();

    logger.info('Order dispatch outbox worker started', {
      pollMs: ORDER_DISPATCH_OUTBOX_POLL_MS,
      batchSize: ORDER_DISPATCH_OUTBOX_BATCH_SIZE
    });
  }

  private calculateDispatchRetryDelayMs(attempt: number): number {
    const cappedAttempt = Math.max(1, attempt);
    const baseMs = Math.min(60_000, Math.pow(2, cappedAttempt) * 1000);
    const jitterMs = Math.floor(Math.random() * 750);
    return baseMs + jitterMs;
  }

  private parseDispatchOutboxPayload(payload: Prisma.JsonValue): OrderDispatchOutboxPayload | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    const raw = payload as Record<string, unknown>;
    const orderId = typeof raw.orderId === 'string' ? raw.orderId.trim() : '';
    if (!orderId) return null;
    return { orderId };
  }

  private orderDispatchOutboxDelegate(tx?: Prisma.TransactionClient) {
    return tx?.orderDispatchOutbox ?? prismaClient.orderDispatchOutbox;
  }

  private async enqueueOrderDispatchOutbox(orderId: string, tx?: Prisma.TransactionClient): Promise<void> {
    await this.orderDispatchOutboxDelegate(tx).upsert({
      where: { orderId },
      update: {
        payload: { orderId },
        status: 'pending',
        nextRetryAt: new Date(),
        lockedAt: null,
        processedAt: null,
        lastError: null
      },
      create: {
        id: uuidv4(),
        orderId,
        payload: { orderId },
        status: 'pending',
        attempts: 0,
        maxAttempts: 8,
        nextRetryAt: new Date()
      }
    });
  }

  private async claimDispatchOutboxByOrderId(orderId: string): Promise<DispatchOutboxRow | null> {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - 120_000);
    const claim = await this.orderDispatchOutboxDelegate().updateMany({
      where: {
        orderId,
        status: { in: ['pending', 'retrying'] },
        nextRetryAt: { lte: now },
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }]
      },
      data: {
        status: 'processing',
        lockedAt: now
      }
    });
    if (claim.count === 0) return null;
    const row = await this.orderDispatchOutboxDelegate().findUnique({
      where: { orderId }
    });
    return row as DispatchOutboxRow | null;
  }

  private async claimReadyDispatchOutboxRows(limit: number): Promise<DispatchOutboxRow[]> {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - 120_000);
    const candidates = await this.orderDispatchOutboxDelegate().findMany({
      where: {
        status: { in: ['pending', 'retrying'] },
        nextRetryAt: { lte: now },
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }]
      },
      orderBy: [{ nextRetryAt: 'asc' }, { createdAt: 'asc' }],
      take: limit
    });

    const claimed: DispatchOutboxRow[] = [];
    for (const candidate of candidates) {
      const claim = await this.orderDispatchOutboxDelegate().updateMany({
        where: {
          id: candidate.id,
          status: { in: ['pending', 'retrying'] },
          nextRetryAt: { lte: now },
          OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }]
        },
        data: {
          status: 'processing',
          lockedAt: now
        }
      });
      if (claim.count > 0) {
        claimed.push({
          id: candidate.id,
          orderId: candidate.orderId,
          payload: candidate.payload as Prisma.JsonValue,
          status: 'processing',
          attempts: candidate.attempts,
          maxAttempts: candidate.maxAttempts,
          nextRetryAt: candidate.nextRetryAt,
          lockedAt: now
        });
      }
    }

    return claimed;
  }

  private async buildDispatchAttemptContext(orderId: string): Promise<{
    order: OrderRecord;
    context: DispatchAttemptContext | null;
  } | null> {
    const order = await db.getOrderById(orderId);
    if (!order) return null;

    const activeStatuses = new Set(['created', 'broadcasting', 'active', 'partially_filled']);
    if (!activeStatuses.has(String(order.status))) {
      return { order, context: null };
    }

    const truckRequests = await db.getTruckRequestsByOrder(orderId);
    const pickup = order.pickup;
    const requestFromOrder: CreateOrderRequest = {
      customerId: order.customerId,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      routePoints: order.routePoints,
      pickup: order.pickup,
      drop: order.drop,
      distanceKm: order.distanceKm,
      vehicleRequirements: [],
      goodsType: order.goodsType || undefined,
      cargoWeightKg: order.cargoWeightKg || undefined
    };

    return {
      order,
      context: {
        request: requestFromOrder,
        truckRequests,
        expiresAt: order.expiresAt,
        pickup
      }
    };
  }

  private async persistOrderDispatchSnapshot(
    order: OrderRecord,
    outcome: DispatchAttemptOutcome
  ): Promise<void> {
    await db.updateOrder(order.id, {
      dispatchState: outcome.dispatchState,
      dispatchAttempts: outcome.dispatchAttempts,
      dispatchReasonCode: outcome.reasonCode || null,
      onlineCandidatesCount: outcome.onlineCandidates,
      notifiedCount: outcome.notifiedTransporters,
      lastDispatchAt: new Date()
    });

    this.emitBroadcastStateChanged(order.customerId, {
      orderId: order.id,
      status: order.status,
      dispatchState: outcome.dispatchState,
      dispatchAttempts: outcome.dispatchAttempts,
      reasonCode: outcome.reasonCode,
      onlineCandidates: outcome.onlineCandidates,
      notifiedTransporters: outcome.notifiedTransporters,
      stateChangedAt: new Date().toISOString()
    });
  }

  private async processDispatchOutboxRow(
    row: DispatchOutboxRow,
    providedContext?: DispatchAttemptContext
  ): Promise<DispatchAttemptOutcome> {
    const payload = this.parseDispatchOutboxPayload(row.payload);
    const resolvedOrderId = payload?.orderId || row.orderId;
    const attemptNumber = Math.max(1, row.attempts + 1);

    const built = await this.buildDispatchAttemptContext(resolvedOrderId);
    if (!built) {
      await this.orderDispatchOutboxDelegate().update({
        where: { id: row.id },
        data: {
          status: 'failed',
          attempts: attemptNumber,
          lastError: 'ORDER_NOT_FOUND',
          processedAt: new Date(),
          lockedAt: null
        }
      });
      return {
        dispatchState: 'dispatch_failed',
        reasonCode: 'ORDER_NOT_FOUND',
        onlineCandidates: 0,
        notifiedTransporters: 0,
        dispatchAttempts: attemptNumber
      };
    }

    const order = built.order;
    const activeStatuses = new Set(['created', 'broadcasting', 'active', 'partially_filled']);
    if (!activeStatuses.has(String(order.status))) {
      await this.orderDispatchOutboxDelegate().update({
        where: { id: row.id },
        data: {
          status: 'failed',
          attempts: attemptNumber,
          lastError: 'ORDER_INACTIVE',
          processedAt: new Date(),
          lockedAt: null
        }
      });
      const outcome: DispatchAttemptOutcome = {
        dispatchState: 'dispatch_failed',
        reasonCode: 'ORDER_INACTIVE',
        onlineCandidates: 0,
        notifiedTransporters: 0,
        dispatchAttempts: attemptNumber
      };
      await this.persistOrderDispatchSnapshot(order, outcome);
      return outcome;
    }

    const context = providedContext || built.context;
    if (!context) {
      const outcome: DispatchAttemptOutcome = {
        dispatchState: 'dispatch_failed',
        reasonCode: 'ORDER_INACTIVE',
        onlineCandidates: 0,
        notifiedTransporters: 0,
        dispatchAttempts: attemptNumber
      };
      await this.persistOrderDispatchSnapshot(order, outcome);
      return outcome;
    }

    try {
      const stats = await this.broadcastToTransporters(
        order.id,
        context.request,
        context.truckRequests,
        context.expiresAt,
        context.pickup
      );

      const noOnlineTransporters = stats.onlineCandidates === 0;
      const transientDispatchGap = stats.onlineCandidates > 0 && stats.notifiedTransporters === 0;
      const reasonCode = noOnlineTransporters
        ? 'NO_ONLINE_TRANSPORTERS'
        : transientDispatchGap
          ? 'DISPATCH_RETRYING'
          : undefined;
      const dispatchState: CreateOrderResponse['dispatchState'] = stats.notifiedTransporters > 0
        ? 'dispatched'
        : 'dispatch_failed';

      const shouldRetry = reasonCode === 'DISPATCH_RETRYING' && attemptNumber < row.maxAttempts;
      let finalReasonCode = reasonCode;
      if (shouldRetry) {
        const delayMs = this.calculateDispatchRetryDelayMs(attemptNumber);
        await this.orderDispatchOutboxDelegate().update({
          where: { id: row.id },
          data: {
            status: 'retrying',
            attempts: attemptNumber,
            nextRetryAt: new Date(Date.now() + delayMs),
            lastError: 'DISPATCH_RETRYING',
            lockedAt: null
          }
        });
      } else if (reasonCode === 'DISPATCH_RETRYING') {
        finalReasonCode = 'DISPATCH_FAILED';
        await this.orderDispatchOutboxDelegate().update({
          where: { id: row.id },
          data: {
            status: 'failed',
            attempts: attemptNumber,
            processedAt: new Date(),
            lastError: 'DISPATCH_RETRY_EXHAUSTED',
            lockedAt: null
          }
        });
      } else if (reasonCode === 'NO_ONLINE_TRANSPORTERS') {
        await this.orderDispatchOutboxDelegate().update({
          where: { id: row.id },
          data: {
            status: 'failed',
            attempts: attemptNumber,
            processedAt: new Date(),
            lastError: 'NO_ONLINE_TRANSPORTERS',
            lockedAt: null
          }
        });
      } else {
        await this.orderDispatchOutboxDelegate().update({
          where: { id: row.id },
          data: {
            status: 'dispatched',
            attempts: attemptNumber,
            processedAt: new Date(),
            lastError: null,
            lockedAt: null
          }
        });
      }

      const outcome: DispatchAttemptOutcome = {
        dispatchState,
        reasonCode: finalReasonCode,
        onlineCandidates: stats.onlineCandidates,
        notifiedTransporters: stats.notifiedTransporters,
        dispatchAttempts: attemptNumber
      };
      await this.persistOrderDispatchSnapshot(order, outcome);
      return outcome;
    } catch (error: any) {
      const retryable = attemptNumber < row.maxAttempts;
      const reasonCode = retryable ? 'DISPATCH_RETRYING' : 'DISPATCH_FAILED';
      const updateData: any = retryable
        ? {
          status: 'retrying',
          attempts: attemptNumber,
          nextRetryAt: new Date(Date.now() + this.calculateDispatchRetryDelayMs(attemptNumber)),
          lastError: error?.message || 'DISPATCH_FAILED',
          lockedAt: null
        }
        : {
          status: 'failed',
          attempts: attemptNumber,
          processedAt: new Date(),
          lastError: error?.message || 'DISPATCH_FAILED',
          lockedAt: null
        };

      await this.orderDispatchOutboxDelegate().update({
        where: { id: row.id },
        data: updateData
      });

      const outcome: DispatchAttemptOutcome = {
        dispatchState: 'dispatch_failed',
        reasonCode,
        onlineCandidates: 0,
        notifiedTransporters: 0,
        dispatchAttempts: attemptNumber
      };
      await this.persistOrderDispatchSnapshot(order, outcome);
      return outcome;
    }
  }

  private async processDispatchOutboxBatch(limit = ORDER_DISPATCH_OUTBOX_BATCH_SIZE): Promise<void> {
    if (!FF_ORDER_DISPATCH_OUTBOX) return;
    const rows = await this.claimReadyDispatchOutboxRows(limit);
    for (const row of rows) {
      try {
        await this.processDispatchOutboxRow(row);
      } catch (error: any) {
        logger.error('Order dispatch outbox row processing failed', {
          outboxId: row.id,
          orderId: row.orderId,
          error: error?.message || 'unknown'
        });
      }
    }
  }

  private async processDispatchOutboxImmediately(
    orderId: string,
    context: DispatchAttemptContext
  ): Promise<DispatchAttemptOutcome | null> {
    if (!FF_ORDER_DISPATCH_OUTBOX) return null;
    const row = await this.claimDispatchOutboxByOrderId(orderId);
    if (!row) return null;
    return this.processDispatchOutboxRow(row, context);
  }

  private lifecycleOutboxDelegate(tx?: Prisma.TransactionClient) {
    return tx?.orderLifecycleOutbox ?? prismaClient.orderLifecycleOutbox;
  }

  private parseLifecycleOutboxPayload(payload: Prisma.JsonValue): OrderLifecycleOutboxPayload | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const raw = payload as Record<string, unknown>;
    const type = typeof raw.type === 'string' ? raw.type : '';
    if (type !== 'order_cancelled') return null;
    const orderId = typeof raw.orderId === 'string' ? raw.orderId.trim() : '';
    const customerId = typeof raw.customerId === 'string' ? raw.customerId.trim() : '';
    if (!orderId || !customerId) return null;
    const transporters = Array.isArray(raw.transporters)
      ? raw.transporters.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const drivers: OrderLifecycleOutboxPayload['drivers'] = Array.isArray(raw.drivers)
      ? raw.drivers.reduce<OrderLifecycleOutboxPayload['drivers']>((acc, item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return acc;
        const row = item as Record<string, unknown>;
        const driverId = typeof row.driverId === 'string' ? row.driverId.trim() : '';
        if (!driverId) return acc;
        acc.push({
          driverId,
          tripId: typeof row.tripId === 'string' ? row.tripId : undefined,
          customerName: typeof row.customerName === 'string' ? row.customerName : undefined,
          customerPhone: typeof row.customerPhone === 'string' ? row.customerPhone : undefined,
          pickupAddress: typeof row.pickupAddress === 'string' ? row.pickupAddress : undefined,
          dropAddress: typeof row.dropAddress === 'string' ? row.dropAddress : undefined
        });
        return acc;
      }, [])
      : [];
    const reason = typeof raw.reason === 'string' && raw.reason.trim().length > 0
      ? raw.reason.trim()
      : 'Cancelled by customer';
    const reasonCode = typeof raw.reasonCode === 'string' && raw.reasonCode.trim().length > 0
      ? raw.reasonCode.trim()
      : 'CUSTOMER_CANCELLED';
    const cancelledAt = typeof raw.cancelledAt === 'string' && raw.cancelledAt.trim().length > 0
      ? raw.cancelledAt
      : new Date().toISOString();
    const eventId = typeof raw.eventId === 'string' && raw.eventId.trim().length > 0
      ? raw.eventId
      : uuidv4();
    const eventVersion = Number(raw.eventVersion || 1);
    const serverTimeMs = Number(raw.serverTimeMs || Date.now());
    return {
      type: 'order_cancelled',
      orderId,
      customerId,
      transporters,
      drivers,
      reason,
      reasonCode,
      cancelledAt,
      eventId,
      eventVersion: Number.isFinite(eventVersion) && eventVersion > 0 ? Math.floor(eventVersion) : 1,
      serverTimeMs: Number.isFinite(serverTimeMs) && serverTimeMs > 0 ? Math.floor(serverTimeMs) : Date.now()
    };
  }

  private calculateLifecycleRetryDelayMs(attempt: number): number {
    const scheduleMs = [1000, 2000, 4000, 8000, 16000, 30000, 60000];
    const base = scheduleMs[Math.max(0, Math.min(scheduleMs.length - 1, attempt - 1))];
    const jitter = Math.floor(Math.random() * 500);
    return base + jitter;
  }

  private startLifecycleOutboxWorker(): void {
    if (this.lifecycleOutboxWorkerTimer) return;

    const poll = async (): Promise<void> => {
      if (this.lifecycleOutboxWorkerRunning) return;
      this.lifecycleOutboxWorkerRunning = true;
      try {
        await this.processLifecycleOutboxBatch();
      } catch (error: any) {
        logger.error('Order lifecycle outbox worker tick failed', {
          error: error?.message || 'unknown'
        });
      } finally {
        this.lifecycleOutboxWorkerRunning = false;
      }
    };

    this.lifecycleOutboxWorkerTimer = setInterval(() => {
      void poll();
    }, ORDER_CANCEL_OUTBOX_POLL_MS);
    this.lifecycleOutboxWorkerTimer.unref?.();
    void poll();

    logger.info('Order lifecycle outbox worker started', {
      pollMs: ORDER_CANCEL_OUTBOX_POLL_MS,
      batchSize: ORDER_CANCEL_OUTBOX_BATCH_SIZE
    });
  }

  private async enqueueCancelLifecycleOutbox(
    payload: OrderLifecycleOutboxPayload,
    tx?: Prisma.TransactionClient
  ): Promise<string> {
    const outboxId = uuidv4();
    await this.lifecycleOutboxDelegate(tx).create({
      data: {
        id: outboxId,
        orderId: payload.orderId,
        eventType: payload.type,
        payload: payload as unknown as Prisma.InputJsonValue,
        status: 'pending',
        attempts: 0,
        maxAttempts: 10,
        nextRetryAt: new Date()
      }
    });
    return outboxId;
  }

  private async claimLifecycleOutboxById(outboxId: string): Promise<LifecycleOutboxRow | null> {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - 120_000);
    const claimed = await this.lifecycleOutboxDelegate().updateMany({
      where: {
        id: outboxId,
        status: { in: ['pending', 'retrying'] },
        nextRetryAt: { lte: now },
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }]
      },
      data: {
        status: 'processing',
        lockedAt: now
      }
    });
    if (claimed.count === 0) return null;
    const row = await this.lifecycleOutboxDelegate().findUnique({ where: { id: outboxId } });
    return row as LifecycleOutboxRow | null;
  }

  private async claimReadyLifecycleOutboxRows(limit: number): Promise<LifecycleOutboxRow[]> {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - 120_000);
    const candidates = await this.lifecycleOutboxDelegate().findMany({
      where: {
        status: { in: ['pending', 'retrying'] },
        nextRetryAt: { lte: now },
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }]
      },
      orderBy: [{ nextRetryAt: 'asc' }, { createdAt: 'asc' }],
      take: limit
    });

    const claimed: LifecycleOutboxRow[] = [];
    for (const candidate of candidates) {
      const claim = await this.lifecycleOutboxDelegate().updateMany({
        where: {
          id: candidate.id,
          status: { in: ['pending', 'retrying'] },
          nextRetryAt: { lte: now },
          OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }]
        },
        data: {
          status: 'processing',
          lockedAt: now
        }
      });
      if (claim.count > 0) {
        claimed.push({
          id: candidate.id,
          orderId: candidate.orderId,
          eventType: candidate.eventType,
          payload: candidate.payload as Prisma.JsonValue,
          status: 'processing',
          attempts: candidate.attempts,
          maxAttempts: candidate.maxAttempts,
          nextRetryAt: candidate.nextRetryAt,
          lockedAt: now
        });
      }
    }
    return claimed;
  }

  private async emitCancellationLifecycle(payload: OrderLifecycleOutboxPayload): Promise<void> {
    const dismissalPayload = {
      broadcastId: payload.orderId,
      orderId: payload.orderId,
      reason: 'customer_cancelled',
      reasonCode: payload.reasonCode,
      message: 'Sorry, the customer cancelled this order',
      cancelledAt: payload.cancelledAt,
      eventId: payload.eventId,
      eventVersion: payload.eventVersion,
      serverTimeMs: payload.serverTimeMs,
      emittedAt: new Date().toISOString()
    };
    const cancellationPayload = {
      type: 'order_cancelled',
      orderId: payload.orderId,
      reason: payload.reason,
      reasonCode: payload.reasonCode,
      cancelledAt: payload.cancelledAt,
      eventId: payload.eventId,
      eventVersion: payload.eventVersion,
      serverTimeMs: payload.serverTimeMs,
      emittedAt: new Date().toISOString(),
      broadcastId: payload.orderId
    };

    if (payload.transporters.length > 0) {
      await this.emitToTransportersWithAdaptiveFanout(
        payload.transporters,
        [
          { event: 'order_cancelled', payload: cancellationPayload },
          { event: 'broadcast_dismissed', payload: dismissalPayload }
        ],
        'order_cancelled_lifecycle'
      );

      await queueService.queuePushNotificationBatch(payload.transporters, {
        title: '❌ Order Cancelled',
        body: `Order #${payload.orderId.slice(-8).toUpperCase()} was cancelled by customer`,
        data: {
          type: 'order_cancelled',
          orderId: payload.orderId,
          broadcastId: payload.orderId,
          reasonCode: payload.reasonCode,
          cancelledAt: payload.cancelledAt,
          eventId: payload.eventId,
          eventVersion: String(payload.eventVersion),
          serverTimeMs: String(payload.serverTimeMs)
        }
      });
    }

    emitToUser(payload.customerId, 'order_cancelled', {
      orderId: payload.orderId,
      status: 'cancelled',
      reason: payload.reason,
      reasonCode: payload.reasonCode,
      cancelledAt: payload.cancelledAt,
      stateChangedAt: payload.cancelledAt,
      eventId: payload.eventId,
      eventVersion: payload.eventVersion,
      serverTimeMs: payload.serverTimeMs,
      emittedAt: new Date().toISOString()
    });

    await queueService.queuePushNotificationBatch([payload.customerId], {
      title: 'Search cancelled',
      body: 'Your truck search was cancelled.',
      data: {
        type: 'order_cancelled',
        orderId: payload.orderId,
        broadcastId: payload.orderId,
        reasonCode: payload.reasonCode,
        cancelledAt: payload.cancelledAt,
        eventId: payload.eventId,
        eventVersion: String(payload.eventVersion),
        serverTimeMs: String(payload.serverTimeMs)
      }
    });

    for (const driver of payload.drivers) {
      this.emitDriverCancellationEvents(driver.driverId, {
        orderId: payload.orderId,
        tripId: driver.tripId,
        reason: payload.reason,
        message: 'Trip cancelled by customer',
        cancelledAt: payload.cancelledAt,
        customerName: driver.customerName || '',
        customerPhone: driver.customerPhone || '',
        pickupAddress: driver.pickupAddress || '',
        dropAddress: driver.dropAddress || '',
        compensationAmount: payload.compensationAmount,
        settlementState: payload.settlementState
      });
    }
  }

  private async processLifecycleOutboxRow(row: LifecycleOutboxRow): Promise<void> {
    const payload = this.parseLifecycleOutboxPayload(row.payload);
    const nextAttempt = Math.max(1, row.attempts + 1);
    if (!payload) {
      await this.lifecycleOutboxDelegate().update({
        where: { id: row.id },
        data: {
          status: 'failed',
          attempts: nextAttempt,
          processedAt: new Date(),
          lockedAt: null,
          lastError: 'INVALID_PAYLOAD',
          dlqReason: 'INVALID_PAYLOAD'
        }
      });
      return;
    }

    try {
      await this.emitCancellationLifecycle(payload);
      await this.lifecycleOutboxDelegate().update({
        where: { id: row.id },
        data: {
          status: 'dispatched',
          attempts: nextAttempt,
          processedAt: new Date(),
          lockedAt: null,
          lastError: null,
          dlqReason: null
        }
      });
    } catch (error: any) {
      const retryable = nextAttempt < row.maxAttempts;
      metrics.incrementCounter('cancel_emit_retry_total', {
        channel: 'lifecycle_outbox',
        retryable: retryable ? 'true' : 'false'
      });
      if (retryable) {
        await this.lifecycleOutboxDelegate().update({
          where: { id: row.id },
          data: {
            status: 'retrying',
            attempts: nextAttempt,
            nextRetryAt: new Date(Date.now() + this.calculateLifecycleRetryDelayMs(nextAttempt)),
            lockedAt: null,
            lastError: error?.message || 'CANCEL_LIFECYCLE_EMIT_FAILED'
          }
        });
      } else {
        await this.lifecycleOutboxDelegate().update({
          where: { id: row.id },
          data: {
            status: 'failed',
            attempts: nextAttempt,
            processedAt: new Date(),
            lockedAt: null,
            lastError: error?.message || 'CANCEL_LIFECYCLE_EMIT_FAILED',
            dlqReason: 'RETRY_EXHAUSTED'
          }
        });
        logger.error('[CANCEL OUTBOX] moved to DLQ', {
          outboxId: row.id,
          orderId: row.orderId,
          eventType: row.eventType,
          attempts: nextAttempt
        });
      }
    }
  }

  private async processLifecycleOutboxBatch(limit = ORDER_CANCEL_OUTBOX_BATCH_SIZE): Promise<void> {
    if (!FF_CANCEL_OUTBOX_ENABLED) return;
    const rows = await this.claimReadyLifecycleOutboxRows(limit);
    for (const row of rows) {
      try {
        await this.processLifecycleOutboxRow(row);
      } catch (error: any) {
        logger.error('Order lifecycle outbox row processing failed', {
          outboxId: row.id,
          orderId: row.orderId,
          eventType: row.eventType,
          error: error?.message || 'unknown'
        });
      }
    }
  }

  private async processLifecycleOutboxImmediately(outboxId: string): Promise<void> {
    if (!FF_CANCEL_OUTBOX_ENABLED) return;
    const row = await this.claimLifecycleOutboxById(outboxId);
    if (!row) return;
    await this.processLifecycleOutboxRow(row);
  }

  private orderExpiryTimerKey(orderId: string): string {
    return `${this.ORDER_EXPIRY_TIMER_PREFIX}${orderId}`;
  }

  private orderBroadcastStepTimerKey(
    orderId: string,
    vehicleType: string,
    vehicleSubtype: string,
    stepIndex: number
  ): string {
    return `${this.ORDER_STEP_TIMER_PREFIX}${orderId}:${vehicleType}:${vehicleSubtype}:${stepIndex}`;
  }

  private notifiedTransportersKey(orderId: string, vehicleType: string, vehicleSubtype: string): string {
    return `order:notified:transporters:${orderId}:${generateVehicleKey(vehicleType, vehicleSubtype)}`;
  }

  private makeVehicleGroupKey(vehicleType: string, vehicleSubtype: string): string {
    return JSON.stringify([vehicleType, vehicleSubtype || '']);
  }

  private parseVehicleGroupKey(groupKey: string): { vehicleType: string; vehicleSubtype: string } {
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
    } catch (error: any) {
      if (error?.code !== 'P2002') {
        throw error;
      }
      const existing = await this.getDbIdempotentResponse(customerId, idempotencyKey, payloadHash);
      if (!existing) {
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key conflict');
      }
    }
  }

  // Redis key patterns for distributed timers
  private readonly TIMER_KEYS = {
    ORDER_EXPIRY: (orderId: string) => this.orderExpiryTimerKey(orderId)
  };

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

  /**
   * Clean up expired rate limit entries
   * NOTE: With Redis, TTL handles cleanup automatically - this is now a no-op
   */
  cleanupRateLimits(): void {
    // Redis TTL handles cleanup automatically
    // This method kept for backward compatibility
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
    const cacheKey = `${CACHE_KEYS.TRANSPORTERS_BY_VEHICLE}${vehicleType}:${vehicleSubtype}`;

    // Try cache first - cacheService.get<T>() already parses JSON!
    let transporterIds: string[];

    try {
      const cached = await cacheService.get<string[]>(cacheKey);

      if (cached && Array.isArray(cached)) {
        logger.debug(`Cache HIT: ${cacheKey} (${cached.length} transporters)`);
        transporterIds = cached;
      } else {
        // Cache miss - query database
        transporterIds = await db.getTransportersWithVehicleType(vehicleType, vehicleSubtype);

        // Store in cache (cacheService.set() handles JSON.stringify internally)
        await cacheService.set(cacheKey, transporterIds, CACHE_TTL.TRANSPORTERS);
        logger.debug(`Cache SET: ${cacheKey} (${transporterIds.length} transporters)`);
      }
    } catch (error: any) {
      // If cache fails, fall back to database
      logger.warn(`Cache error for ${cacheKey}: ${error.message}. Falling back to DB.`);
      transporterIds = await db.getTransportersWithVehicleType(vehicleType, vehicleSubtype);
    }

    // FILTER: Only include transporters who are AVAILABLE (online toggle ON)
    // Phase 3 optimization: Uses Redis `online:transporters` set for O(1) filtering
    // instead of N+1 DB queries (getUserById per transporter).
    // Graceful degradation: falls back to DB check if Redis is unavailable.
    const availableTransporters = await transporterOnlineService.filterOnline(transporterIds);

    return availableTransporters;
  }

  /**
   * Invalidate transporter cache when vehicles change
   */
  async invalidateTransporterCache(vehicleType: string, vehicleSubtype?: string): Promise<void> {
    if (vehicleSubtype) {
      await cacheService.delete(`${CACHE_KEYS.TRANSPORTERS_BY_VEHICLE}${vehicleType}:${vehicleSubtype}`);
    } else {
      // Invalidate all subtypes for this vehicle type
      const iterator = cacheService.scanIterator(`${CACHE_KEYS.TRANSPORTERS_BY_VEHICLE}${vehicleType}:*`);
      for await (const key of iterator) {
        await cacheService.delete(key);
      }
    }
    logger.debug(`Cache invalidated: transporters for ${vehicleType}${vehicleSubtype ? ':' + vehicleSubtype : ':*'}`);
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
    // Hard server-side validation (defense-in-depth in addition to route schema)
    if (!Array.isArray(request.vehicleRequirements) || request.vehicleRequirements.length === 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'At least one truck requirement is required');
    }
    const invalidQuantity = request.vehicleRequirements.find((item) => item.quantity <= 0);
    if (invalidQuantity) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Truck quantity must be greater than zero');
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
        throw new Error(`Please wait a few seconds before placing another order.`);
      }
      // Set debounce key — auto-expires after 3 seconds
      await redisService.set(debounceKey, '1', DEBOUNCE_SECONDS);
    } catch (error: any) {
      // If error is our debounce error, rethrow it
      if (error.message.includes('Please wait')) throw error;
      // If Redis fails, skip debounce (don't block orders)
      logger.warn(`⚠️ Debounce check failed: ${error.message}. Proceeding without debounce.`);
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
      } catch (error: any) {
        logger.warn(`⚠️ Idempotency cache error: ${error.message}. Proceeding with order creation.`);
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
    const existingBroadcastId = await redisService.get(activeKey);
    if (existingBroadcastId) {
      throw new Error('Request already in progress. Cancel it first.');
    }

    const lockKey = `customer-broadcast-create:${request.customerId}`;
    const lock = await redisService.acquireLock(lockKey, request.customerId, 10);
    if (!lock.acquired) {
      throw new Error('Request already in progress. Cancel it first.');
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
        throw new Error('Request already in progress. Cancel it first.');
      }

      // ========================================
      // SERVER-GENERATED IDEMPOTENCY (double-tap / retry protection)
      // ========================================
      const roundCoord = (n: number) => Math.round(n * 1000) / 1000;
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

      const existingDedupeId = await redisService.get(dedupeKey);
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
        } catch (error: any) {
          logger.warn(`⚠️ Price validation failed for ${req.vehicleType}: ${error.message}. Using client price.`);
          // If pricing service fails, allow client price to avoid blocking orders
        }
      }

      const totalAmount = request.vehicleRequirements.reduce(
        (sum, req) => sum + (req.quantity * req.pricePerTruck),
        0
      );

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
        throw new Error('Either routePoints OR both pickup and drop must be provided'); // TODO: Replace with ValidationError when imported
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

      // Narrow serializable transaction: duplicate-check + order + truckRequests + dispatch outbox bootstrap.
      // This removes the crash window where order exists but outbox row does not.
      await prismaClient.$transaction(async (tx) => {
        const dupBooking = await tx.booking.findFirst({
          where: { customerId: request.customerId, status: { in: [BookingStatus.created, BookingStatus.broadcasting, BookingStatus.active, BookingStatus.partially_filled] } }
        });
        const dupOrder = await tx.order.findFirst({
          where: { customerId: request.customerId, status: { in: [OrderStatus.created, OrderStatus.broadcasting, OrderStatus.active, OrderStatus.partially_filled] } }
        });
        if (dupBooking || dupOrder) {
          throw new Error('Request already in progress. Cancel it first.');
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
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

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
        const immediateOutcome = await this.processDispatchOutboxImmediately(orderId, dispatchContext);
        if (immediateOutcome) {
          dispatchState = immediateOutcome.dispatchState;
          dispatchReasonCode = immediateOutcome.reasonCode;
          onlineCandidates = immediateOutcome.onlineCandidates;
          notifiedTransporters = immediateOutcome.notifiedTransporters;
          dispatchAttempts = immediateOutcome.dispatchAttempts;
        } else {
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
          dispatchState = 'dispatch_failed';
          dispatchReasonCode = 'DISPATCH_RETRYING';
          logger.error(`⚠️ Broadcast error (order still created): ${broadcastError.message}`);
          logger.error(broadcastError.stack);
        }
      }

      // 4. Set expiry timer
      this.setOrderExpiryTimer(orderId, this.BROADCAST_TIMEOUT_MS);

      // Transition: broadcasting -> active (timer started, awaiting responses)
      await db.updateOrder(orderId, {
        status: 'active',
        stateChangedAt: new Date(),
        dispatchState,
        dispatchAttempts,
        dispatchReasonCode: dispatchReasonCode || null,
        onlineCandidatesCount: onlineCandidates,
        notifiedCount: notifiedTransporters,
        lastDispatchAt: new Date()
      });
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
  }

  /**
   * Broadcast truck requests to matching transporters
   * 
   * KEY: Each vehicle type goes ONLY to transporters with that type
   * 
   * CRITICAL FIX: Accepts `resolvedPickup` as parameter instead of using
   * `request.pickup` which is OPTIONAL (undefined when routePoints used).
   * The caller extracts pickup from routePoints or request.pickup.
   */
  private async broadcastToTransporters(
    orderId: string,
    request: CreateOrderRequest,
    truckRequests: TruckRequestRecord[],
    expiresAt: string,
    resolvedPickup: { latitude: number; longitude: number; address: string; city?: string; state?: string }
  ): Promise<{ onlineCandidates: number; notifiedTransporters: number }> {
    const requestsByType = this.buildRequestsByType(truckRequests);
    let onlineCandidates = 0;
    let notifiedTransporters = 0;

    for (const [typeKey, requests] of requestsByType) {
      const { vehicleType, vehicleSubtype } = this.parseVehicleGroupKey(typeKey);
      const alreadyNotified = await this.getNotifiedTransporters(orderId, vehicleType, vehicleSubtype);
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

      // Phase 3: Score candidates by ETA (feature-flagged, default OFF → no-op sort)
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
      onlineCandidates += targetTransporters.length;

      if (targetTransporters.length > 0) {
        metrics.incrementCounter('broadcast_fanout_total', { vehicleType }, targetTransporters.length);
        const sendResult = await this.broadcastVehicleTypePayload(
          orderId,
          request,
          truckRequests,
          requestsByType,
          requests,
          vehicleType,
          vehicleSubtype,
          targetTransporters,
          expiresAt
        );
        await this.markTransportersNotified(orderId, vehicleType, vehicleSubtype, sendResult.sentTransporters);
        notifiedTransporters += sendResult.sentTransporters.length;
      } else {
        metrics.incrementCounter('broadcast_skipped_no_available', { vehicleType });
        logger.warn(`⚠️ No transporters found for ${vehicleType} (${vehicleSubtype}) in step 10km`);
      }

      // Always schedule the next step for unresolved demand.
      // When demand is fulfilled before the timer fires, step processing exits early.
      await this.scheduleNextProgressiveStep(orderId, vehicleType, vehicleSubtype, 1);
    }

    return { onlineCandidates, notifiedTransporters };
  }

  private async processProgressiveBroadcastStep(timerData: {
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

    const alreadyNotified = await this.getNotifiedTransporters(
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

    if (targetTransporters.length === 0) {
      metrics.incrementCounter('broadcast_skipped_no_available', { vehicleType: timerData.vehicleType });
      await this.scheduleNextProgressiveStep(
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

    const requestsByType = this.buildRequestsByType(truckRequests);
    const sendResult = await this.broadcastVehicleTypePayload(
      timerData.orderId,
      requestFromOrder,
      truckRequests,
      requestsByType,
      activeRequestsForType,
      timerData.vehicleType,
      timerData.vehicleSubtype,
      targetTransporters,
      order.expiresAt
    );
    await this.markTransportersNotified(
      timerData.orderId,
      timerData.vehicleType,
      timerData.vehicleSubtype,
      sendResult.sentTransporters
    );

    await this.scheduleNextProgressiveStep(
      timerData.orderId,
      timerData.vehicleType,
      timerData.vehicleSubtype,
      timerData.stepIndex + 1
    );
  }

  private async scheduleNextProgressiveStep(
    orderId: string,
    vehicleType: string,
    vehicleSubtype: string,
    stepIndex: number
  ): Promise<void> {
    const step = PROGRESSIVE_RADIUS_STEPS[stepIndex];
    if (!step) return;

    const timerKey = this.orderBroadcastStepTimerKey(orderId, vehicleType, vehicleSubtype, stepIndex);
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

  private buildRequestsByType(requests: TruckRequestRecord[]): Map<string, TruckRequestRecord[]> {
    const requestsByType = new Map<string, TruckRequestRecord[]>();
    for (const request of requests) {
      const key = this.makeVehicleGroupKey(request.vehicleType, request.vehicleSubtype);
      if (!requestsByType.has(key)) {
        requestsByType.set(key, []);
      }
      requestsByType.get(key)!.push(request);
    }
    return requestsByType;
  }

  private async getNotifiedTransporters(orderId: string, vehicleType: string, vehicleSubtype: string): Promise<Set<string>> {
    const key = this.notifiedTransportersKey(orderId, vehicleType, vehicleSubtype);
    const members = await redisService.sMembers(key).catch(() => []);
    return new Set(members);
  }

  private async markTransportersNotified(
    orderId: string,
    vehicleType: string,
    vehicleSubtype: string,
    transporterIds: string[]
  ): Promise<void> {
    if (transporterIds.length === 0) return;
    const key = this.notifiedTransportersKey(orderId, vehicleType, vehicleSubtype);
    await redisService.sAdd(key, ...transporterIds).catch(() => { });
    const ttlSeconds = Math.ceil(this.BROADCAST_TIMEOUT_MS / 1000) + 120;
    await redisService.expire(key, ttlSeconds).catch(() => { });
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
    expiresAt: string
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
      const { vehicleType: requestVehicleType, vehicleSubtype: requestVehicleSubtype } = this.parseVehicleGroupKey(key);
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

    const socketQueueJobs: Array<Promise<void>> = [];
    for (const transporterId of matchingTransporters) {
      const availability = availabilityMap.get(transporterId);
      if (!availability || availability.available <= 0) {
        skippedNoAvailable++;
        continue;
      }

      const trucksYouCanProvide = Math.min(availability.available, trucksStillNeeded);
      const personalizedBroadcast = {
        ...extendedBroadcast,
        trucksYouCanProvide,
        maxTrucksYouCanProvide: trucksYouCanProvide,
        yourAvailableTrucks: availability.available,
        yourTotalTrucks: availability.totalOwned,
        trucksStillNeeded,
        trucksNeededOfThisType: trucksStillNeeded,
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
    }

    // === PHASE 4: ADAPTIVE FANOUT CHUNKING (configurable) ===
    // Split enqueue jobs into chunks to prevent Redis CPU spike on large fanout.
    // Closest transporters (sorted by ETA) are in the first chunk.
    // Default chunk size = 500 (effectively no chunking for normal orders).
    const FANOUT_CHUNK_SIZE = Math.max(
      10,
      parseInt(process.env.FF_ADAPTIVE_FANOUT_CHUNK_SIZE || '500', 10) || 500
    );
    const FANOUT_CHUNK_DELAY_MS = Math.max(
      0,
      parseInt(process.env.FF_ADAPTIVE_FANOUT_DELAY_MS || '0', 10) || 0
    );

    if (socketQueueJobs.length > 0) {
      if (socketQueueJobs.length <= FANOUT_CHUNK_SIZE || FANOUT_CHUNK_DELAY_MS === 0) {
        // No chunking needed — fire all at once (original behavior)
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

  /**
   * Set timer to expire order after timeout (Redis-based for cluster support)
   * 
   * SCALABILITY: Uses Redis timers instead of in-memory setTimeout
   * - Works across multiple server instances
   * - Survives server restarts
   * - No duplicate processing (Redis locks)
   */
  private async clearCustomerActiveBroadcast(customerId: string): Promise<void> {
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

  /**
   * Add standard event metadata for correlation across logs, sockets and load tests.
   */
  private withEventMeta<T extends Record<string, unknown>>(payload: T, eventId?: string): T & { eventId: string; emittedAt: string } {
    return {
      ...payload,
      eventId: eventId || uuidv4(),
      emittedAt: new Date().toISOString()
    };
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
    if (!FF_ORDER_DISPATCH_STATUS_EVENTS) return;
    metrics.incrementCounter('broadcast_state_transition_total', {
      status: (payload.status || 'unknown').toLowerCase(),
      dispatch_state: (payload.dispatchState || 'unknown').toLowerCase(),
      reason_code: (payload.reasonCode || 'none').toLowerCase()
    });
    emitToUser(
      customerId,
      'broadcast_state_changed',
      this.withEventMeta({
        ...payload,
        eventVersion: 1,
        serverTimeMs: Date.now(),
        stateChangedAt: payload.stateChangedAt || new Date().toISOString()
      })
    );
  }

  private chunkTransporterIds(transporterIds: string[]): string[][] {
    if (transporterIds.length <= this.TRANSPORTER_FANOUT_CHUNK_SIZE) {
      return [transporterIds];
    }
    const chunks: string[][] = [];
    for (let index = 0; index < transporterIds.length; index += this.TRANSPORTER_FANOUT_CHUNK_SIZE) {
      chunks.push(transporterIds.slice(index, index + this.TRANSPORTER_FANOUT_CHUNK_SIZE));
    }
    return chunks;
  }

  private async emitToTransportersWithAdaptiveFanout(
    transporterIds: string[],
    events: Array<{ event: string; payload: Record<string, unknown> }>,
    context: string
  ): Promise<void> {
    if (transporterIds.length === 0 || events.length === 0) return;

    const uniqueTransporters = Array.from(new Set(transporterIds));
    const useSynchronousEmit = !this.TRANSPORTER_FANOUT_QUEUE_ENABLED ||
      uniqueTransporters.length <= this.TRANSPORTER_FANOUT_SYNC_THRESHOLD;

    if (useSynchronousEmit) {
      for (const eventSpec of events) {
        emitToUsers(uniqueTransporters, eventSpec.event, eventSpec.payload);
      }
      return;
    }

    const chunks = this.chunkTransporterIds(uniqueTransporters);
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

  private async setOrderExpiryTimer(orderId: string, timeoutMs: number): Promise<void> {
    // Cancel any existing timer
    await redisService.cancelTimer(this.TIMER_KEYS.ORDER_EXPIRY(orderId));

    // Set new timer in Redis
    const expiresAt = new Date(Date.now() + timeoutMs);
    const timerData = {
      orderId,
      createdAt: new Date().toISOString()
    };

    await redisService.setTimer(this.TIMER_KEYS.ORDER_EXPIRY(orderId), timerData, expiresAt);
    logger.info(`⏱️ Order expiry timer set for ${orderId} (${timeoutMs / 1000}s) [Redis-based]`);
  }

  private async clearProgressiveStepTimers(orderId: string): Promise<void> {
    const pattern = `${this.ORDER_STEP_TIMER_PREFIX}${orderId}:*`;
    const batch: string[] = [];

    for await (const key of redisService.scanIterator(pattern, 200)) {
      batch.push(key);
      if (batch.length < 200) continue;
      await Promise.allSettled(batch.map((timerKey) => redisService.cancelTimer(timerKey).catch(() => false)));
      batch.length = 0;
    }

    if (batch.length > 0) {
      await Promise.allSettled(batch.map((timerKey) => redisService.cancelTimer(timerKey).catch(() => false)));
    }
  }

  async processExpiredTimers(): Promise<void> {
    await this.processExpiredOrderTimers();
    await this.processExpiredBroadcastStepTimers();
  }

  private async processExpiredOrderTimers(): Promise<void> {
    const expiredTimers = await redisService.getExpiredTimers<{ orderId: string }>(
      this.ORDER_EXPIRY_TIMER_PREFIX
    );
    for (const timer of expiredTimers) {
      const orderId = timer.data?.orderId;
      if (!orderId) {
        await redisService.cancelTimer(timer.key).catch(() => false);
        continue;
      }

      const lockKey = `${this.ORDER_STEP_TIMER_LOCK_PREFIX}expiry:${orderId}`;
      const lock = await redisService.acquireLock(lockKey, 'order-expiry-checker', 30);
      if (!lock.acquired) continue;

      try {
        await this.handleOrderExpiry(orderId);
      } finally {
        await redisService.cancelTimer(timer.key).catch(() => false);
        await redisService.releaseLock(lockKey, 'order-expiry-checker').catch(() => { });
      }
    }
  }

  private async processExpiredBroadcastStepTimers(): Promise<void> {
    const expiredTimers = await redisService.getExpiredTimers<{
      orderId: string;
      vehicleType: string;
      vehicleSubtype: string;
      stepIndex: number;
      scheduledAtMs?: number;
      stepWindowMs?: number;
    }>(this.ORDER_STEP_TIMER_PREFIX);
    for (const timer of expiredTimers) {
      const data = timer.data;
      if (!data?.orderId || !data.vehicleType || data.stepIndex == null) {
        await redisService.cancelTimer(timer.key).catch(() => false);
        continue;
      }

      const lockKey = `${this.ORDER_STEP_TIMER_LOCK_PREFIX}${data.orderId}:${data.vehicleType}:${data.vehicleSubtype}:${data.stepIndex}`;
      const lock = await redisService.acquireLock(lockKey, 'order-step-checker', 30);
      if (!lock.acquired) continue;

      try {
        const expectedAtMs = Date.parse(timer.expiresAt);
        const triggerLatencyMs = Number.isFinite(expectedAtMs)
          ? Math.max(0, Date.now() - expectedAtMs)
          : 0;
        if (triggerLatencyMs > 2_500) {
          logger.warn('[ORDER STEP TIMER] Trigger latency above budget', {
            orderId: data.orderId,
            vehicleType: data.vehicleType,
            vehicleSubtype: data.vehicleSubtype || '',
            stepIndex: Number(data.stepIndex),
            triggerLatencyMs,
            expectedAt: timer.expiresAt
          });
        } else {
          logger.debug('[ORDER STEP TIMER] Trigger latency', {
            orderId: data.orderId,
            vehicleType: data.vehicleType,
            vehicleSubtype: data.vehicleSubtype || '',
            stepIndex: Number(data.stepIndex),
            triggerLatencyMs
          });
        }

        await this.processProgressiveBroadcastStep({
          orderId: data.orderId,
          vehicleType: data.vehicleType,
          vehicleSubtype: data.vehicleSubtype || '',
          stepIndex: Number(data.stepIndex)
        });
      } finally {
        await redisService.cancelTimer(timer.key).catch(() => false);
        await redisService.releaseLock(lockKey, 'order-step-checker').catch(() => { });
      }
    }
  }

  /**
   * Emit cancellation events to drivers with dual-event compatibility.
   *
   * Captain app currently consumes both `trip_cancelled` (new) and
   * `order_cancelled` (legacy) paths. Keep payload shape aligned so
   * either listener can drive the same UI behavior.
   */
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

  /**
   * Handle order expiry
   * Mark unfilled truck requests as expired
   */
  async handleOrderExpiry(orderId: string): Promise<void> {
    logger.info(`⏰ ORDER EXPIRED: ${orderId}`);

    const order = await db.getOrderById(orderId);
    if (!order) return;

    // Only expire if still in an expirable state
    if (order.status === OrderStatus.fully_filled || order.status === OrderStatus.completed || order.status === OrderStatus.cancelled) {
      return;
    }

    // Get all truck requests for this order
    const truckRequests = await db.getTruckRequestsByOrder(orderId);
    const unfilled = truckRequests.filter(tr => tr.status === 'searching');

    if (unfilled.length > 0) {
      // Update unfilled requests to expired
      const unfilledIds = unfilled.map(tr => tr.id);
      await db.updateTruckRequestsBatch(unfilledIds, { status: 'expired' });

      logger.info(`   ${unfilled.length} truck requests expired`);
    }

    // =========================================================================
    // Derive timeout reason before customer/transporter notifications
    // =========================================================================
    // Two customer-facing timeout cases:
    // 1) NO_ONLINE_TRANSPORTERS: no transporter matched in the configured radius waves
    // 2) NO_TRANSPORTER_ACCEPTANCE: transporters were notified but none accepted in time
    // =========================================================================
    const notifiedTransporters = new Set<string>();
    for (const tr of truckRequests) {
      if (tr.notifiedTransporters) {
        tr.notifiedTransporters.forEach((t: string) => notifiedTransporters.add(t));
      }
    }

    const transporterIds = Array.from(notifiedTransporters);
    const notifiedCount = transporterIds.length;
    const newStatus = order.trucksFilled > 0 ? 'partially_filled' : 'expired';
    const reasonCode = order.trucksFilled > 0
      ? 'PARTIAL_FILL_TIMEOUT'
      : notifiedCount > 0
        ? 'NO_TRANSPORTER_ACCEPTANCE'
        : 'NO_ONLINE_TRANSPORTERS';
    const derivedDispatchState: CreateOrderResponse['dispatchState'] = order.trucksFilled > 0 ? 'dispatched' : 'dispatch_failed';
    const onlineCandidates = Math.max(order.onlineCandidatesCount || 0, notifiedCount);
    const expiredAt = new Date().toISOString();

    await db.updateOrder(orderId, {
      status: newStatus,
      stateChangedAt: new Date(),
      dispatchState: derivedDispatchState,
      dispatchReasonCode: reasonCode,
      onlineCandidatesCount: onlineCandidates,
      notifiedCount,
      lastDispatchAt: new Date()
    });

    const closedExpiryHolds = await truckHoldService.closeActiveHoldsForOrder(orderId, 'ORDER_EXPIRED');
    if (closedExpiryHolds > 0) {
      logger.info(`[ORDER EXPIRY] Closed ${closedExpiryHolds} active hold(s) for order ${orderId}`);
    }

    // Notify customer — includes explicit timeout reason for precise UX messaging.
    emitToUser(order.customerId, 'order_expired', this.withEventMeta({
      orderId,
      status: newStatus,
      expiredAt,
      totalTrucks: order.totalTrucks,
      trucksFilled: order.trucksFilled,
      reasonCode,
      onlineCandidates,
      notifiedTransporters: notifiedCount
    }));

    // =========================================================================
    // Notify ALL transporters to remove expired broadcast
    // =========================================================================
    // Uses queue for large fanout and keeps broadcast_dismissed compatibility.
    // =========================================================================

    if (transporterIds.length > 0) {
      const expiryEventId = uuidv4();
      const expiryPayload = {
        broadcastId: orderId,
        orderId,
        reason: 'timeout',
        timestamp: new Date().toISOString(),
        message: 'This booking request has expired',
        eventId: expiryEventId,
        emittedAt: new Date().toISOString()
      };

      // broadcast_dismissed feeds BroadcastListScreen overlay (same infrastructure as cancel)
      const expiredDismissData = {
        broadcastId: orderId,
        orderId,
        reason: 'timeout',
        message: 'This booking request has expired',
        cancelledAt: expiredAt,
        eventId: expiryEventId,
        emittedAt: new Date().toISOString()
      };

      await this.emitToTransportersWithAdaptiveFanout(
        transporterIds,
        [
          { event: 'broadcast_expired', payload: expiryPayload },
          { event: 'broadcast_dismissed', payload: expiredDismissData }
        ],
        'order_expiry'
      );
      logger.info(`   📱 Expiry broadcast dispatched to ${transporterIds.length} transporters`);

      // FCM: Push notification for background/closed app transporters
      await queueService.queuePushNotificationBatch(
        transporterIds,
        {
          title: '⏰ Request Expired',
          body: `A truck request has expired`,
          data: {
            type: 'broadcast_expired',
            orderId
          }
        }
      ).catch((err: unknown) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.warn(`FCM: Failed to queue expiry push for order ${orderId}: ${errorMessage}`);
      });
    }

    // GAP 4 FIX: Notify drivers whose trips are in-flight when order expires.
    // TripAcceptDeclineScreen only listens to 'order_cancelled', not 'order_expired'.
    // Without this, a driver stays on a dead TripAcceptDeclineScreen forever if
    // the 120s search timer fires while they are deciding.
    try {
      const cancellableAssignmentStatuses = [
        AssignmentStatus.pending,
        AssignmentStatus.driver_accepted,
        AssignmentStatus.en_route_pickup,
        AssignmentStatus.at_pickup,
        AssignmentStatus.in_transit
      ];

      const activeAssignments = await prismaClient.assignment.findMany({
        where: {
          orderId,
          status: { in: cancellableAssignmentStatuses }
        }
      });

      if (activeAssignments.length > 0) {
        const candidateAssignmentIds = activeAssignments.map(a => a.id);

        // Atomic phase: pending assignments only (preconditioned to avoid races).
        await prismaClient.assignment.updateMany({
          where: {
            id: { in: candidateAssignmentIds },
            status: AssignmentStatus.pending
          },
          data: { status: AssignmentStatus.cancelled }
        });

        // Re-check and cancel any remaining in-flight assignments with status preconditions.
        const nonPendingStatuses = cancellableAssignmentStatuses.filter(
          (status) => status !== AssignmentStatus.pending
        );
        if (nonPendingStatuses.length > 0) {
          await prismaClient.assignment.updateMany({
            where: {
              id: { in: candidateAssignmentIds },
              status: { in: nonPendingStatuses }
            },
            data: { status: AssignmentStatus.cancelled }
          });
        }

        // Re-fetch the subset that is actually cancelled to avoid stale notifications.
        const cancelledAssignments = await prismaClient.assignment.findMany({
          where: {
            id: { in: candidateAssignmentIds },
            status: AssignmentStatus.cancelled
          }
        });

        if (cancelledAssignments.length > 0) {
          const vehicleIdsToRelease = Array.from(
            new Set(
              cancelledAssignments
                .map((assignment) => assignment.vehicleId)
                .filter((id): id is string => Boolean(id))
            )
          );
          if (vehicleIdsToRelease.length > 0) {
            await prismaClient.vehicle.updateMany({
              where: {
                id: { in: vehicleIdsToRelease }
              },
              data: {
                status: VehicleStatus.available,
                currentTripId: null,
                assignedDriverId: null
              }
            }).catch(() => { });
          }

          for (const assignment of cancelledAssignments) {
            if (assignment.driverId) {
              this.emitDriverCancellationEvents(assignment.driverId, {
                orderId,
                tripId: assignment.tripId,
                reason: 'timeout',
                message: 'This trip request has expired',
                cancelledAt: expiredAt,
                customerName: order.customerName,
                customerPhone: order.customerPhone,
                pickupAddress: order.pickup?.address || '',
                dropAddress: order.drop?.address || ''
              });
              sendPushNotification(assignment.driverId, {
                title: 'Trip Expired',
                body: 'This trip request has expired.',
                data: {
                  type: 'trip_cancelled',
                  orderId,
                  tripId: assignment.tripId || '',
                  reason: 'timeout',
                  cancelledAt: expiredAt
                }
              }).catch((err: unknown) => {
                const errorMessage = err instanceof Error ? err.message : String(err);
                logger.warn(`FCM to driver failed: ${errorMessage}`);
              });
            }
          }

          logger.info(`[EXPIRY] Notified ${cancelledAssignments.length} drivers of order expiry`);
        }
      }
    } catch (err: unknown) {
      // Non-blocking — expiry still succeeds even if driver notify fails
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn(`[EXPIRY] Failed to notify drivers (non-critical)`, { error: errorMessage });
    }

    // GAP 7 FIX: FCM push to customer for background/killed app.
    // handleOrderExpiry only did WS + transporter FCM, not customer FCM.
    await queueService.queuePushNotificationBatch(
      [order.customerId],
      {
        title: reasonCode === 'NO_ONLINE_TRANSPORTERS'
          ? 'No transporters available nearby'
          : reasonCode === 'NO_TRANSPORTER_ACCEPTANCE'
            ? 'No one accepted your request'
            : 'Search timed out',
        body: reasonCode === 'NO_ONLINE_TRANSPORTERS'
          ? 'No transporters were available in nearby area. Tap to search again.'
          : reasonCode === 'NO_TRANSPORTER_ACCEPTANCE'
            ? 'Transporters were notified, but no one accepted in time. Tap to search again.'
            : 'Your search timed out. Tap to search again.',
        data: {
          type: 'order_expired',
          orderId,
          status: newStatus,
          reasonCode
        }
      }
    ).catch((err: unknown) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn(`FCM: Failed to send expiry push to customer ${order.customerId}`, { error: errorMessage });
    });

    // Cleanup timers from Redis
    await redisService.cancelTimer(this.TIMER_KEYS.ORDER_EXPIRY(orderId));
    await this.clearProgressiveStepTimers(orderId);

    // Clear customer active broadcast key (one-per-customer enforcement)
    await this.clearCustomerActiveBroadcast(order.customerId);
  }

  private deriveTruckCancelStage(
    order: Pick<OrderRecord, 'status' | 'loadingStartedAt' | 'unloadingStartedAt'>,
    assignments: Array<{ status: AssignmentStatus }>
  ): TruckCancelPolicyStage {
    if (order.unloadingStartedAt) return 'UNLOADING_STARTED';

    const statuses = new Set(assignments.map((assignment) => assignment.status));
    if (statuses.has(AssignmentStatus.in_transit)) return 'IN_TRANSIT';
    if (order.loadingStartedAt) return 'LOADING_STARTED';
    if (statuses.has(AssignmentStatus.at_pickup)) return 'AT_PICKUP';
    if (
      statuses.has(AssignmentStatus.pending) ||
      statuses.has(AssignmentStatus.driver_accepted) ||
      statuses.has(AssignmentStatus.en_route_pickup)
    ) {
      return 'DRIVER_ASSIGNED';
    }
    return 'SEARCHING';
  }

  private calculateWaitingCharges(order: Pick<OrderRecord, 'stopWaitTimers'>): number {
    const nowMs = Date.now();
    const timers = Array.isArray(order.stopWaitTimers) ? order.stopWaitTimers : [];
    let waitingMinutes = 0;
    for (const timer of timers) {
      if (timer.departedAt) continue;
      const arrivedAtRaw = typeof timer.arrivedAt === 'string' ? timer.arrivedAt : '';
      if (!arrivedAtRaw) continue;
      const arrivedAtMs = new Date(arrivedAtRaw).getTime();
      if (!Number.isFinite(arrivedAtMs)) continue;
      waitingMinutes = Math.max(waitingMinutes, Math.floor((nowMs - arrivedAtMs) / 60_000));
    }
    const graceMinutes = 5;
    return Math.max(0, waitingMinutes - graceMinutes) * 5;
  }

  private createMoneyBreakdown(
    baseCancellationFee: number,
    waitingCharges: number,
    percentageFareComponent: number,
    driverMinimumGuarantee: number
  ): CancelMoneyBreakdown {
    return {
      baseCancellationFee,
      waitingCharges,
      percentageFareComponent,
      driverMinimumGuarantee,
      finalAmount: Math.max(
        baseCancellationFee,
        waitingCharges,
        percentageFareComponent,
        driverMinimumGuarantee
      )
    };
  }

  private evaluateTruckCancelPolicy(
    order: Pick<OrderRecord, 'totalAmount' | 'stopWaitTimers' | 'status' | 'loadingStartedAt' | 'unloadingStartedAt'>,
    assignments: Array<{ status: AssignmentStatus }>,
    reason?: string
  ): TruckCancelPolicyEvaluation {
    if (!FF_CANCEL_POLICY_TRUCK_V1) {
      return {
        stage: 'SEARCHING',
        decision: 'allowed',
        reasonRequired: false,
        reasonCode: 'CANCEL_POLICY_DISABLED',
        penaltyBreakdown: this.createMoneyBreakdown(0, 0, 0, 0),
        driverCompensationBreakdown: this.createMoneyBreakdown(0, 0, 0, 0),
        settlementState: 'waived',
        pendingPenaltyAmount: 0
      };
    }

    const stage = this.deriveTruckCancelStage(order, assignments);
    const waitingCharges = this.calculateWaitingCharges(order);
    const percentage30 = Math.round((Number(order.totalAmount || 0) * 0.30) * 100) / 100;

    let decision: TruckCancelDecision = 'allowed';
    let reasonRequired = false;
    let reasonCode = 'CUSTOMER_CANCELLED';
    let penaltyBreakdown = this.createMoneyBreakdown(0, 0, 0, 0);
    let driverCompensationBreakdown = this.createMoneyBreakdown(0, 0, 0, 0);

    switch (stage) {
      case 'SEARCHING':
        penaltyBreakdown = this.createMoneyBreakdown(0, 0, 0, 0);
        driverCompensationBreakdown = this.createMoneyBreakdown(0, 0, 0, 0);
        reasonCode = 'CANCEL_SEARCHING';
        break;
      case 'DRIVER_ASSIGNED':
        penaltyBreakdown = this.createMoneyBreakdown(50, 0, 0, 0);
        driverCompensationBreakdown = this.createMoneyBreakdown(50, 0, 0, 50);
        reasonCode = 'CANCEL_AFTER_ASSIGNMENT';
        break;
      case 'AT_PICKUP':
        reasonRequired = true;
        penaltyBreakdown = this.createMoneyBreakdown(100, waitingCharges, 0, 100);
        driverCompensationBreakdown = this.createMoneyBreakdown(100, waitingCharges, 0, 100);
        reasonCode = 'CANCEL_AT_PICKUP';
        break;
      case 'LOADING_STARTED':
        reasonRequired = true;
        penaltyBreakdown = this.createMoneyBreakdown(100, waitingCharges, percentage30, 100);
        driverCompensationBreakdown = this.createMoneyBreakdown(100, waitingCharges, Math.round((percentage30 * 0.5) * 100) / 100, 100);
        reasonCode = 'CANCEL_LOADING_STARTED';
        break;
      case 'IN_TRANSIT':
        decision = 'blocked_dispute_only';
        reasonRequired = true;
        reasonCode = 'CANCEL_BLOCKED_IN_TRANSIT';
        break;
      case 'UNLOADING_STARTED':
        decision = 'blocked_dispute_only';
        reasonRequired = true;
        reasonCode = 'CANCEL_BLOCKED_UNLOADING_STARTED';
        break;
    }

    if (reasonRequired && (!reason || reason.trim().length === 0)) {
      reasonCode = `${reasonCode}_REASON_REQUIRED`;
    }

    const pendingPenaltyAmount = decision === 'allowed' ? penaltyBreakdown.finalAmount : 0;
    const settlementState: 'pending' | 'settled' | 'waived' = decision !== 'allowed'
      ? 'waived'
      : (pendingPenaltyAmount > 0 || driverCompensationBreakdown.finalAmount > 0)
        ? 'pending'
        : 'settled';

    return {
      stage,
      decision,
      reasonRequired,
      reasonCode,
      penaltyBreakdown,
      driverCompensationBreakdown,
      settlementState,
      pendingPenaltyAmount
    };
  }

  private buildCancelPayloadHash(orderId: string, reason?: string): string {
    const normalizedReason = (reason || '').trim().toLowerCase();
    return crypto
      .createHash('sha256')
      .update(`${orderId}::${normalizedReason}`)
      .digest('hex');
  }

  private async getCancelIdempotentResponse(
    customerId: string,
    idempotencyKey: string,
    payloadHash: string
  ): Promise<CancelOrderResult | null> {
    const row = await prismaClient.orderCancelIdempotency.findUnique({
      where: {
        customerId_operation_idempotencyKey: {
          customerId,
          operation: 'cancel',
          idempotencyKey
        }
      }
    });
    if (!row) return null;
    if (row.payloadHash !== payloadHash) {
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key reused with different cancel payload');
    }
    return row.responseJson as unknown as CancelOrderResult;
  }

  private async persistCancelIdempotentResponse(
    customerId: string,
    idempotencyKey: string,
    payloadHash: string,
    orderId: string,
    response: CancelOrderResult,
    statusCode: number
  ): Promise<void> {
    try {
      await prismaClient.orderCancelIdempotency.create({
        data: {
          id: uuidv4(),
          customerId,
          operation: 'cancel',
          idempotencyKey,
          payloadHash,
          orderId,
          statusCode,
          responseJson: response as unknown as Prisma.InputJsonValue
        }
      });
    } catch (error: any) {
      if (error?.code !== 'P2002') throw error;
      const replay = await this.getCancelIdempotentResponse(customerId, idempotencyKey, payloadHash);
      if (!replay) {
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key conflict');
      }
    }
  }

  private async registerCancelRebookChurn(customerId: string): Promise<void> {
    if (!FF_CANCEL_REBOOK_CHURN_GUARD) return;
    const countKey = `cancel:rebook:count:${customerId}`;
    const cooldownKey = `cancel:rebook:cooldown:${customerId}`;
    try {
      const newCount = await redisService.incr(countKey);
      if (newCount === 1) {
        await redisService.expire(countKey, 120).catch(() => false);
      }
      if (newCount > 6) {
        await redisService.set(cooldownKey, '120', 120);
      } else if (newCount > 3) {
        const existingTtl = await redisService.ttl(cooldownKey).catch(() => -1);
        if (existingTtl <= 0) {
          await redisService.set(cooldownKey, '15', 15);
        }
      }
    } catch (error: any) {
      logger.warn('Failed to update cancel rebook churn counter', {
        customerId,
        error: error?.message || 'unknown'
      });
    }
  }

  private async enforceCancelRebookCooldown(customerId: string): Promise<void> {
    if (!FF_CANCEL_REBOOK_CHURN_GUARD) return;
    const cooldownKey = `cancel:rebook:cooldown:${customerId}`;
    const remaining = await redisService.ttl(cooldownKey).catch(() => -1);
    if (remaining > 0) {
      metrics.incrementCounter('cancel_rebook_throttled_total', {
        bucket: remaining > 60 ? 'hard' : 'soft'
      });
      throw new AppError(
        429,
        'CANCEL_REBOOK_COOLDOWN',
        `Please wait ${remaining}s before creating another order.`,
        { retryAfter: remaining }
      );
    }
  }

  async getCancelPreview(orderId: string, customerId: string, reason?: string): Promise<CancelOrderResult> {
    const order = await db.getOrderById(orderId);
    if (!order) {
      return { success: false, message: 'Order not found', transportersNotified: 0 };
    }
    if (order.customerId !== customerId) {
      return { success: false, message: 'You can only cancel your own orders', transportersNotified: 0 };
    }

    const assignments = await prismaClient.assignment.findMany({
      where: {
        orderId,
        status: {
          in: [
            AssignmentStatus.pending,
            AssignmentStatus.driver_accepted,
            AssignmentStatus.en_route_pickup,
            AssignmentStatus.at_pickup,
            AssignmentStatus.in_transit
          ]
        }
      },
      select: { status: true }
    });
    const evaluation = this.evaluateTruckCancelPolicy(order, assignments, reason);
    return {
      success: true,
      message: evaluation.decision === 'allowed'
        ? 'Cancellation allowed under current stage'
        : 'Cancellation blocked. Please use dispute.',
      transportersNotified: 0,
      policyStage: evaluation.stage,
      cancelDecision: evaluation.decision,
      reasonRequired: evaluation.reasonRequired,
      reasonCode: evaluation.reasonCode,
      penaltyBreakdown: evaluation.penaltyBreakdown,
      driverCompensationBreakdown: evaluation.driverCompensationBreakdown,
      settlementState: evaluation.settlementState,
      pendingPenaltyAmount: evaluation.pendingPenaltyAmount,
      serverTimeMs: Date.now(),
      eventVersion: Number(order.lifecycleEventVersion || 0)
    };
  }

  async createCancelDispute(
    orderId: string,
    customerId: string,
    reasonCode?: string,
    notes?: string
  ): Promise<{ success: boolean; disputeId?: string; message: string; stage?: TruckCancelPolicyStage }> {
    const order = await db.getOrderById(orderId);
    if (!order) return { success: false, message: 'Order not found' };
    if (order.customerId !== customerId) return { success: false, message: 'You can only dispute your own orders' };

    const assignments = await prismaClient.assignment.findMany({
      where: {
        orderId,
        status: {
          in: [
            AssignmentStatus.pending,
            AssignmentStatus.driver_accepted,
            AssignmentStatus.en_route_pickup,
            AssignmentStatus.at_pickup,
            AssignmentStatus.in_transit
          ]
        }
      },
      select: { status: true }
    });
    const stage = this.deriveTruckCancelStage(order, assignments);
    if (stage !== 'IN_TRANSIT' && stage !== 'UNLOADING_STARTED') {
      return {
        success: false,
        message: 'Dispute can be raised only when cancellation is blocked in transit/unloading stage',
        stage
      };
    }

    const disputeId = uuidv4();
    await prismaClient.cancelDispute.create({
      data: {
        id: disputeId,
        orderId,
        customerId,
        stage,
        reasonCode: reasonCode || null,
        notes: notes || null,
        status: 'open'
      }
    });

    metrics.incrementCounter('cancel_dispute_created_total', { stage: stage.toLowerCase() });
    return { success: true, disputeId, message: 'Dispute created successfully', stage };
  }

  /**
   * Cancel an order — atomic, idempotent, race-safe
   *
   * Uses updateMany with status precondition to prevent cancel-vs-accept races.
   * Already-cancelled orders return success (idempotent).
   */
  async cancelOrder(
    orderId: string,
    customerId: string,
    reason?: string,
    idempotencyKey?: string,
    options: { createDispute?: boolean } = {}
  ): Promise<CancelOrderResult> {
    logger.info(`CANCEL ORDER: ${orderId} by customer ${customerId}`);
    const normalizedReason = (reason || '').trim();
    const effectiveReason = normalizedReason || 'Cancelled by customer';
    const payloadHash = this.buildCancelPayloadHash(orderId, effectiveReason);

    if (FF_CANCEL_IDEMPOTENCY_REQUIRED && !idempotencyKey) {
      logger.warn('[CANCEL] Idempotency key missing while strict flag is enabled', {
        orderId,
        customerId
      });
      throw new AppError(
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'X-Idempotency-Key header is required for cancellation.'
      );
    }

    if (idempotencyKey) {
      const replay = await this.getCancelIdempotentResponse(customerId, idempotencyKey, payloadHash);
      if (replay) return replay;
    }

    let lifecycleOutboxId: string | null = null;
    let lifecyclePayload: OrderLifecycleOutboxPayload | null = null;
    let closedHoldsCount = 0;
    let closedHoldIds: string[] = [];
    let result: CancelOrderResult = {
      success: false,
      message: 'Cancel failed',
      transportersNotified: 0
    };
    let statusCode = 400;

    const cancellableOrderStatuses: OrderStatus[] = [
      OrderStatus.created,
      OrderStatus.broadcasting,
      OrderStatus.active,
      OrderStatus.partially_filled
    ];
    const activeAssignmentStatuses: AssignmentStatus[] = [
      AssignmentStatus.pending,
      AssignmentStatus.driver_accepted,
      AssignmentStatus.en_route_pickup,
      AssignmentStatus.at_pickup,
      AssignmentStatus.in_transit
    ];

    await prismaClient.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) {
        statusCode = 404;
        result = { success: false, message: 'Order not found', transportersNotified: 0 };
        return;
      }
      if (order.customerId !== customerId) {
        statusCode = 403;
        result = {
          success: false,
          message: 'You can only cancel your own orders',
          transportersNotified: 0
        };
        return;
      }

      const assignmentRows = await tx.assignment.findMany({
        where: { orderId, status: { in: activeAssignmentStatuses } },
        select: {
          id: true,
          status: true,
          driverId: true,
          tripId: true,
          vehicleId: true
        }
      });
      const stageEvaluation = this.evaluateTruckCancelPolicy(order as unknown as OrderRecord, assignmentRows, normalizedReason);
      metrics.incrementCounter('cancel_requests_total', {
        stage: stageEvaluation.stage.toLowerCase(),
        decision: stageEvaluation.decision
      });

      if (stageEvaluation.reasonRequired && !normalizedReason) {
        statusCode = 400;
        result = {
          success: false,
          message: 'Cancellation reason is required at this stage',
          transportersNotified: 0,
          policyStage: stageEvaluation.stage,
          cancelDecision: stageEvaluation.decision,
          reasonRequired: true,
          reasonCode: stageEvaluation.reasonCode,
          penaltyBreakdown: stageEvaluation.penaltyBreakdown,
          driverCompensationBreakdown: stageEvaluation.driverCompensationBreakdown,
          settlementState: stageEvaluation.settlementState,
          pendingPenaltyAmount: stageEvaluation.pendingPenaltyAmount,
          eventVersion: Number(order.lifecycleEventVersion || 0),
          serverTimeMs: Date.now()
        };
        return;
      }

      if (stageEvaluation.decision === 'blocked_dispute_only') {
        let disputeId: string | undefined;
        if (options.createDispute) {
          disputeId = uuidv4();
          await tx.cancelDispute.create({
            data: {
              id: disputeId,
              orderId,
              customerId,
              stage: stageEvaluation.stage,
              reasonCode: normalizedReason || stageEvaluation.reasonCode,
              notes: normalizedReason || null,
              status: 'open'
            }
          });
          metrics.incrementCounter('cancel_dispute_created_total', {
            stage: stageEvaluation.stage.toLowerCase()
          });
        }

        statusCode = 409;
        result = {
          success: false,
          message: disputeId
            ? 'Cancellation blocked. Dispute created.'
            : 'Cancellation blocked at this stage. Please raise a dispute.',
          transportersNotified: 0,
          policyStage: stageEvaluation.stage,
          cancelDecision: stageEvaluation.decision,
          reasonRequired: stageEvaluation.reasonRequired,
          reasonCode: stageEvaluation.reasonCode,
          penaltyBreakdown: stageEvaluation.penaltyBreakdown,
          driverCompensationBreakdown: stageEvaluation.driverCompensationBreakdown,
          settlementState: stageEvaluation.settlementState,
          pendingPenaltyAmount: stageEvaluation.pendingPenaltyAmount,
          disputeId,
          eventVersion: Number(order.lifecycleEventVersion || 0),
          serverTimeMs: Date.now()
        };
        return;
      }

      const updated = await tx.order.updateMany({
        where: {
          id: orderId,
          customerId,
          status: { in: cancellableOrderStatuses }
        },
        data: {
          status: OrderStatus.cancelled,
          stateChangedAt: new Date(),
          cancelledAt: new Date().toISOString(),
          cancellationReason: effectiveReason,
          lifecycleEventVersion: { increment: 1 }
        }
      });

      const refreshedOrder = await tx.order.findUnique({ where: { id: orderId } });
      if (!refreshedOrder) {
        statusCode = 404;
        result = { success: false, message: 'Order not found', transportersNotified: 0 };
        return;
      }

      if (updated.count === 0) {
        if (refreshedOrder.status === OrderStatus.cancelled) {
          statusCode = 200;
          result = {
            success: true,
            message: 'Order already cancelled',
            transportersNotified: 0,
            policyStage: stageEvaluation.stage,
            cancelDecision: 'allowed',
            reasonRequired: stageEvaluation.reasonRequired,
            reasonCode: stageEvaluation.reasonCode,
            penaltyBreakdown: stageEvaluation.penaltyBreakdown,
            driverCompensationBreakdown: stageEvaluation.driverCompensationBreakdown,
            settlementState: stageEvaluation.settlementState,
            pendingPenaltyAmount: stageEvaluation.pendingPenaltyAmount,
            eventVersion: Number(refreshedOrder.lifecycleEventVersion || 0),
            serverTimeMs: Date.now()
          };
          return;
        }
        statusCode = 409;
        result = {
          success: false,
          message: `Cannot cancel order in ${refreshedOrder.status} state`,
          transportersNotified: 0,
          policyStage: stageEvaluation.stage,
          cancelDecision: stageEvaluation.decision,
          reasonRequired: stageEvaluation.reasonRequired,
          reasonCode: stageEvaluation.reasonCode,
          penaltyBreakdown: stageEvaluation.penaltyBreakdown,
          driverCompensationBreakdown: stageEvaluation.driverCompensationBreakdown,
          settlementState: stageEvaluation.settlementState,
          pendingPenaltyAmount: stageEvaluation.pendingPenaltyAmount,
          eventVersion: Number(refreshedOrder.lifecycleEventVersion || 0),
          serverTimeMs: Date.now()
        };
        return;
      }

      const truckRequests = await tx.truckRequest.findMany({
        where: { orderId },
        select: {
          id: true,
          status: true,
          notifiedTransporters: true
        }
      });

      const activeHolds = await tx.truckHoldLedger.findMany({
        where: { orderId, status: 'active' },
        select: {
          holdId: true,
          transporterId: true,
          truckRequestIds: true
        }
      });
      closedHoldsCount = activeHolds.length;
      closedHoldIds = activeHolds.map((hold) => hold.holdId);

      for (const hold of activeHolds) {
        await tx.truckRequest.updateMany({
          where: {
            id: { in: hold.truckRequestIds },
            orderId,
            status: TruckRequestStatus.held,
            heldById: hold.transporterId
          },
          data: {
            status: TruckRequestStatus.cancelled,
            heldById: null,
            heldAt: null
          }
        });
        await tx.truckHoldLedger.update({
          where: { holdId: hold.holdId },
          data: {
            status: 'cancelled',
            terminalReason: 'ORDER_CANCELLED',
            releasedAt: new Date()
          }
        });
      }

      await tx.truckRequest.updateMany({
        where: {
          orderId,
          status: { in: [TruckRequestStatus.searching, TruckRequestStatus.held] }
        },
        data: {
          status: TruckRequestStatus.cancelled,
          heldById: null,
          heldAt: null
        }
      });

      if (assignmentRows.length > 0) {
        await tx.assignment.updateMany({
          where: {
            orderId,
            status: { in: activeAssignmentStatuses }
          },
          data: {
            status: AssignmentStatus.cancelled
          }
        });
      }

      const vehicleIdsToRelease = Array.from(
        new Set(
          assignmentRows
            .map((assignment) => assignment.vehicleId)
            .filter((id): id is string => Boolean(id))
        )
      );
      if (vehicleIdsToRelease.length > 0) {
        await tx.vehicle.updateMany({
          where: { id: { in: vehicleIdsToRelease } },
          data: {
            status: VehicleStatus.available,
            currentTripId: null,
            assignedDriverId: null
          }
        });
      }

      await tx.orderDispatchOutbox.updateMany({
        where: {
          orderId,
          status: { in: ['pending', 'retrying', 'processing'] }
        },
        data: {
          status: 'failed',
          processedAt: new Date(),
          lockedAt: null,
          lastError: 'ORDER_CANCELLED'
        }
      });

      const eventVersion = Number(refreshedOrder.lifecycleEventVersion || 1);
      const eventId = uuidv4();
      const serverTimeMs = Date.now();
      const cancelledAt = refreshedOrder.cancelledAt || new Date().toISOString();

      await tx.cancellationLedger.create({
        data: {
          id: uuidv4(),
          orderId,
          customerId,
          driverId: assignmentRows[0]?.driverId || null,
          policyStage: stageEvaluation.stage,
          reasonCode: normalizedReason || stageEvaluation.reasonCode,
          penaltyAmount: stageEvaluation.penaltyBreakdown.finalAmount,
          compensationAmount: stageEvaluation.driverCompensationBreakdown.finalAmount,
          settlementState: stageEvaluation.settlementState,
          cancelDecision: stageEvaluation.decision,
          eventVersion,
          idempotencyKey: idempotencyKey || null
        }
      });

      if (stageEvaluation.pendingPenaltyAmount > 0 && FF_CANCEL_DEFERRED_SETTLEMENT) {
        await tx.customerPenaltyDue.create({
          data: {
            id: uuidv4(),
            customerId,
            orderId,
            amount: stageEvaluation.pendingPenaltyAmount,
            state: 'due',
            nextOrderHint: 'Pending cancellation fee will be adjusted on next booking.'
          }
        });
      }

      const activeDriverIds = Array.from(
        new Set(
          assignmentRows
            .map((assignment) => assignment.driverId)
            .filter((id): id is string => Boolean(id))
        )
      );
      if (activeDriverIds.length > 0 && stageEvaluation.driverCompensationBreakdown.finalAmount > 0 && FF_CANCEL_DEFERRED_SETTLEMENT) {
        const perDriverAmount = Math.round((stageEvaluation.driverCompensationBreakdown.finalAmount / activeDriverIds.length) * 100) / 100;
        await tx.driverCompensationLedger.createMany({
          data: activeDriverIds.map((driverId) => ({
            id: uuidv4(),
            driverId,
            orderId,
            amount: perDriverAmount,
            state: 'pending'
          }))
        });
      }

      const now = new Date();
      await tx.cancellationAbuseCounter.upsert({
        where: { customerId },
        create: {
          customerId,
          cancelCount7d: 1,
          cancelCount30d: 1,
          cancelAfterLoadingCount: stageEvaluation.stage === 'LOADING_STARTED' ? 1 : 0,
          cancelRebook2mCount: 1,
          riskTier: stageEvaluation.stage === 'LOADING_STARTED' ? 'warning' : 'normal',
          lastCancelAt: now
        },
        update: {
          cancelCount7d: { increment: 1 },
          cancelCount30d: { increment: 1 },
          cancelAfterLoadingCount: stageEvaluation.stage === 'LOADING_STARTED'
            ? { increment: 1 }
            : undefined,
          cancelRebook2mCount: { increment: 1 },
          lastCancelAt: now,
          riskTier: stageEvaluation.stage === 'LOADING_STARTED' ? 'warning' : undefined
        }
      });

      const transporterIds = Array.from(
        truckRequests.reduce((set, row) => {
          (row.notifiedTransporters || []).forEach((id) => {
            if (typeof id === 'string' && id.trim().length > 0) set.add(id.trim());
          });
          return set;
        }, new Set<string>())
      );

      lifecyclePayload = {
        type: 'order_cancelled',
        orderId,
        customerId,
        transporters: transporterIds,
        drivers: assignmentRows
          .filter((assignment) => Boolean(assignment.driverId))
          .map((assignment) => ({
            driverId: String(assignment.driverId),
            tripId: assignment.tripId || undefined,
            customerName: refreshedOrder.customerName,
            customerPhone: refreshedOrder.customerPhone,
            pickupAddress: (refreshedOrder.pickup as any)?.address || '',
            dropAddress: (refreshedOrder.drop as any)?.address || ''
          })),
        reason: effectiveReason,
        reasonCode: stageEvaluation.reasonCode,
        cancelledAt,
        eventId,
        eventVersion: FF_CANCEL_EVENT_VERSION_ENFORCED ? eventVersion : 1,
        serverTimeMs,
        compensationAmount: stageEvaluation.driverCompensationBreakdown?.finalAmount || 0,
        settlementState: stageEvaluation.settlementState || 'none'
      };

      if (FF_CANCEL_OUTBOX_ENABLED && lifecyclePayload) {
        lifecycleOutboxId = await this.enqueueCancelLifecycleOutbox(lifecyclePayload, tx);
      }

      statusCode = 200;
      result = {
        success: true,
        message: 'Order cancelled successfully',
        transportersNotified: transporterIds.length,
        driversNotified: lifecyclePayload.drivers?.length || 0,
        assignmentsCancelled: assignmentRows.length,
        policyStage: stageEvaluation.stage,
        cancelDecision: stageEvaluation.decision,
        reasonRequired: stageEvaluation.reasonRequired,
        reasonCode: stageEvaluation.reasonCode,
        penaltyBreakdown: stageEvaluation.penaltyBreakdown,
        driverCompensationBreakdown: stageEvaluation.driverCompensationBreakdown,
        settlementState: stageEvaluation.settlementState,
        pendingPenaltyAmount: stageEvaluation.pendingPenaltyAmount,
        eventId,
        eventVersion: lifecyclePayload.eventVersion,
        serverTimeMs
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    if (result.success) {
      await redisService.cancelTimer(this.TIMER_KEYS.ORDER_EXPIRY(orderId));
      await this.clearProgressiveStepTimers(orderId);
      await this.clearCustomerActiveBroadcast(customerId);
      await this.registerCancelRebookChurn(customerId);
      await truckHoldService.clearHoldCacheEntries(closedHoldIds);

      metrics.incrementCounter('holds_released_on_cancel_total', {
        bucket: closedHoldsCount > 0 ? 'has_holds' : 'none'
      }, Math.max(1, closedHoldsCount));

      if (FF_CANCEL_OUTBOX_ENABLED && lifecycleOutboxId) {
        try {
          await this.processLifecycleOutboxImmediately(lifecycleOutboxId);
        } catch (error: any) {
          logger.warn('[CANCEL OUTBOX] immediate dispatch failed; worker will retry', {
            orderId,
            outboxId: lifecycleOutboxId,
            error: error?.message || 'unknown'
          });
        }
      } else if (lifecyclePayload) {
        await this.emitCancellationLifecycle(lifecyclePayload);
      }
    }

    if (idempotencyKey) {
      await this.persistCancelIdempotentResponse(
        customerId,
        idempotencyKey,
        payloadHash,
        orderId,
        result,
        statusCode
      );
    }

    return result;
  }

  /**
   * Accept a truck request (transporter assigns vehicle + driver)
   * 
   * Called when transporter accepts from the Captain app
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
    const MAX_RETRIES = 3;
    let txResult: {
      assignmentId: string;
      tripId: string;
      newTrucksFilled: number;
      newStatus: OrderRecord['status'];
      orderId: string;
      customerId: string;
      orderPickup: OrderRecord['pickup'];
      orderDrop: OrderRecord['drop'];
      orderDistanceKm: number;
      orderCustomerName: string;
      orderCustomerPhone: string;
      orderTotalTrucks: number;
      truckRequestPricePerTruck: number;
      vehicleNumber: string;
      vehicleType: string;
      vehicleSubtype: string;
      driverName: string;
      driverPhone: string;
      transporterName: string;
      transporterPhone: string;
      now: string;
    } | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        txResult = await prismaClient.$transaction(async (tx) => {
          // ----- Read all data inside the transaction -----
          const truckRequest = await tx.truckRequest.findUnique({
            where: { id: truckRequestId }
          });

          if (!truckRequest) {
            throw new Error('EARLY_RETURN:Truck request not found');
          }

          if (truckRequest.status !== 'searching') {
            throw new Error(`EARLY_RETURN:Request already ${truckRequest.status}`);
          }

          const order = await tx.order.findUnique({
            where: { id: truckRequest.orderId }
          });
          if (!order) {
            throw new Error('EARLY_RETURN:Order not found');
          }

          const transporter = await tx.user.findUnique({
            where: { id: transporterId }
          });

          const vehicle = await tx.vehicle.findUnique({
            where: { id: vehicleId }
          });
          if (!vehicle) {
            throw new Error('EARLY_RETURN:Vehicle not found');
          }

          // Phase 6 guard: Vehicle must be available (not already on a trip)
          if (vehicle.status !== 'available') {
            metrics.incrementCounter('assignment_blocked_total', { reason: 'vehicle_busy' });
            throw new Error(
              `EARLY_RETURN:Vehicle ${vehicle.vehicleNumber} is currently ${vehicle.status}`
            );
          }
          if (vehicle.currentTripId) {
            metrics.incrementCounter('assignment_blocked_total', { reason: 'vehicle_on_trip' });
            throw new Error(
              `EARLY_RETURN:Vehicle ${vehicle.vehicleNumber} is already on trip ${vehicle.currentTripId}`
            );
          }

          const driver = await tx.user.findUnique({
            where: { id: driverId }
          });
          if (!driver) {
            throw new Error('EARLY_RETURN:Driver not found');
          }

          // Phase 6 guard: Driver must NOT have an active assignment already
          const existingDriverAssignment = await tx.assignment.findFirst({
            where: {
              driverId,
              status: { in: ['pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit'] }
            },
            select: { id: true, tripId: true, orderId: true }
          });
          if (existingDriverAssignment) {
            metrics.incrementCounter('assignment_blocked_total', { reason: 'driver_busy' });
            throw new Error(
              `EARLY_RETURN:Driver ${driver.name} is already assigned to an active trip`
            );
          }

          // Verify vehicle type matches
          if (vehicle.vehicleType !== truckRequest.vehicleType) {
            throw new Error(
              `EARLY_RETURN:Vehicle type mismatch. Request requires ${truckRequest.vehicleType}, vehicle is ${vehicle.vehicleType}`
            );
          }

          // Phase 6 guard: Verify vehicle SUBTYPE matches
          if (vehicle.vehicleSubtype !== truckRequest.vehicleSubtype) {
            throw new Error(
              `EARLY_RETURN:Vehicle subtype mismatch. Request requires ${truckRequest.vehicleSubtype}, vehicle is ${vehicle.vehicleSubtype}`
            );
          }

          // ----- Optimistic lock: update truck request only if still 'searching' -----
          const truckRequestUpdate = await tx.truckRequest.updateMany({
            where: { id: truckRequestId, status: 'searching' },
            data: {
              status: 'assigned',
              assignedTransporterId: transporterId,
              assignedTransporterName: transporter?.name || transporter?.businessName || '',
              assignedVehicleId: vehicleId,
              assignedVehicleNumber: vehicle.vehicleNumber,
              assignedDriverId: driverId,
              assignedDriverName: driver.name,
              assignedDriverPhone: driver.phone,
              tripId: uuidv4(),
              assignedAt: new Date().toISOString()
            }
          });

          if (truckRequestUpdate.count === 0) {
            throw new Error('EARLY_RETURN:This request is no longer available');
          }

          // Fetch the updated truck request to get generated tripId
          const updatedTruckRequest = await tx.truckRequest.findUnique({
            where: { id: truckRequestId }
          });
          const tripId = updatedTruckRequest!.tripId!;
          const assignmentId = uuidv4();
          const now = new Date().toISOString();

          // ----- Create assignment record inside transaction -----
          await tx.assignment.create({
            data: {
              id: assignmentId,
              bookingId: truckRequest.orderId, // Legacy field
              truckRequestId,
              orderId: truckRequest.orderId,
              transporterId,
              transporterName: transporter?.name || '',
              vehicleId,
              vehicleNumber: vehicle.vehicleNumber,
              vehicleType: vehicle.vehicleType,
              vehicleSubtype: vehicle.vehicleSubtype,
              driverId,
              driverName: driver.name,
              driverPhone: driver.phone || '',
              tripId,
              status: AssignmentStatus.pending,
              assignedAt: now
            }
          });

          // ----- Optimistic lock: update order progress only if trucksFilled hasn't changed -----
          const orderUpdate = await tx.order.updateMany({
            where: { id: order.id, trucksFilled: order.trucksFilled },
            data: {
              trucksFilled: { increment: 1 }
            }
          });

          if (orderUpdate.count === 0) {
            // Another concurrent request incremented trucksFilled first; retry
            throw new Error('RETRY:Order state changed concurrently');
          }

          const newTrucksFilled = order.trucksFilled + 1;
          const newStatus = newTrucksFilled >= order.totalTrucks
            ? OrderStatus.fully_filled
            : OrderStatus.partially_filled;

          await tx.order.update({
            where: { id: order.id },
            data: { status: newStatus, stateChangedAt: new Date() }
          });

          // ----- Update vehicle status inside transaction -----
          await tx.vehicle.update({
            where: { id: vehicleId },
            data: {
              status: VehicleStatus.in_transit,
              currentTripId: tripId,
              assignedDriverId: driverId
            }
          });

          // Parse JSON fields for notification use outside the transaction
          const pickup = typeof order.pickup === 'string'
            ? JSON.parse(order.pickup as string)
            : order.pickup;
          const drop = typeof order.drop === 'string'
            ? JSON.parse(order.drop as string)
            : order.drop;

          return {
            assignmentId,
            tripId,
            newTrucksFilled,
            newStatus,
            orderId: order.id,
            customerId: order.customerId,
            orderPickup: pickup as OrderRecord['pickup'],
            orderDrop: drop as OrderRecord['drop'],
            orderDistanceKm: order.distanceKm,
            orderCustomerName: order.customerName,
            orderCustomerPhone: order.customerPhone,
            orderTotalTrucks: order.totalTrucks,
            truckRequestPricePerTruck: truckRequest.pricePerTruck,
            vehicleNumber: vehicle.vehicleNumber,
            vehicleType: vehicle.vehicleType,
            vehicleSubtype: vehicle.vehicleSubtype,
            driverName: driver.name,
            driverPhone: driver.phone || '',
            transporterName: transporter?.name || transporter?.businessName || '',
            transporterPhone: transporter?.phone || '',
            now
          };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

        // Transaction succeeded, break out of retry loop
        break;
      } catch (error: any) {
        // Handle EARLY_RETURN errors (validation failures — no retry)
        if (error?.message?.startsWith('EARLY_RETURN:')) {
          return {
            success: false,
            message: error.message.replace('EARLY_RETURN:', '')
          };
        }

        // Handle retryable serialization conflicts (P2034 / 40001)
        const isRetryableContention =
          error?.code === 'P2034' ||
          error?.code === '40001' ||
          error?.message?.startsWith('RETRY:');

        if (!isRetryableContention || attempt >= MAX_RETRIES) {
          logger.error(`acceptTruckRequest failed after ${attempt} attempt(s)`, {
            truckRequestId,
            vehicleId,
            driverId,
            error: error.message
          });
          throw error;
        }

        logger.warn('[OrderAccept] Contention retry', {
          truckRequestId,
          vehicleId,
          driverId,
          attempt,
          maxAttempts: MAX_RETRIES,
          code: error.code || 'RETRY'
        });
      }
    }

    if (!txResult) {
      return {
        success: false,
        message: 'Unable to finalize assignment after retries'
      };
    }

    // =====================================================================
    // All notifications OUTSIDE the transaction (side-effects are not
    // rolled back on serialization retry, so they must happen after commit)
    // =====================================================================

    const {
      assignmentId,
      tripId,
      newTrucksFilled,
      newStatus,
      orderId,
      customerId,
      orderPickup,
      orderDrop,
      orderDistanceKm,
      orderCustomerName,
      orderCustomerPhone,
      orderTotalTrucks,
      truckRequestPricePerTruck,
      vehicleNumber,
      vehicleType,
      vehicleSubtype,
      driverName,
      driverPhone,
      transporterName,
      transporterPhone,
      now
    } = txResult;

    metrics.incrementCounter('assignment_success_total');
    logger.info(`Truck request ${truckRequestId} accepted`);
    logger.info(`   Vehicle: ${vehicleNumber} (${vehicleType})`);
    logger.info(`   Driver: ${driverName} (${driverPhone})`);
    logger.info(`   Order progress: ${newTrucksFilled}/${orderTotalTrucks}`);

    // ============== NOTIFY DRIVER ==============
    const driverNotification = {
      type: 'trip_assigned',
      assignmentId,
      tripId,
      orderId,
      truckRequestId,
      pickup: orderPickup,
      drop: orderDrop,
      vehicleNumber,
      farePerTruck: truckRequestPricePerTruck,
      distanceKm: orderDistanceKm,
      customerName: orderCustomerName,
      customerPhone: orderCustomerPhone,
      assignedAt: now,
      message: `New trip assigned! ${orderPickup.address} → ${orderDrop.address}`
    };

    emitToUser(driverId, 'trip_assigned', driverNotification);
    logger.info(`Notified driver ${driverName} about trip assignment`);

    // Push notification to driver
    sendPushNotification(driverId, {
      title: 'New Trip Assigned!',
      body: `${orderPickup.city || orderPickup.address} → ${orderDrop.city || orderDrop.address}`,
      data: {
        type: 'trip_assigned',
        tripId,
        assignmentId,
        orderId
      }
    }).catch((err: unknown) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn(`FCM to driver failed: ${errorMessage}`);
    });

    // ============== NOTIFY CUSTOMER ==============
    const customerEventId = uuidv4();
    const customerNotification = {
      type: 'truck_confirmed',
      orderId,
      truckRequestId,
      assignmentId,
      truckNumber: newTrucksFilled,
      totalTrucks: orderTotalTrucks,
      trucksConfirmed: newTrucksFilled,
      remainingTrucks: orderTotalTrucks - newTrucksFilled,
      isFullyFilled: newTrucksFilled >= orderTotalTrucks,
      driver: {
        name: driverName,
        phone: driverPhone
      },
      vehicle: {
        number: vehicleNumber,
        type: vehicleType,
        subtype: vehicleSubtype
      },
      transporter: {
        name: transporterName,
        phone: transporterPhone
      },
      message: `Truck ${newTrucksFilled}/${orderTotalTrucks} confirmed!`,
      eventId: customerEventId,
      emittedAt: now
    };

    emitToUser(customerId, 'truck_confirmed', customerNotification);
    logger.info(`Notified customer - ${newTrucksFilled}/${orderTotalTrucks} trucks confirmed`);

    // Phase 3 parity: keep searching dialog in sync with backend fill progress.
    emitToUser(customerId, 'trucks_remaining_update', {
      orderId,
      trucksNeeded: orderTotalTrucks,
      trucksFilled: newTrucksFilled,
      trucksRemaining: Math.max(orderTotalTrucks - newTrucksFilled, 0),
      isFullyFilled: newTrucksFilled >= orderTotalTrucks,
      timestamp: now,
      eventId: customerEventId,
      emittedAt: now
    });

    // Lifecycle update whenever order status changes due to accept flow.
    emitToUser(customerId, 'broadcast_state_changed', this.withEventMeta({
      orderId,
      status: newStatus,
      dispatchState: 'dispatched',
      eventVersion: 1,
      serverTimeMs: Date.now(),
      stateChangedAt: now
    }, customerEventId));

    if (newStatus === 'fully_filled') {
      const latestAssignment = {
        assignmentId,
        tripId,
        vehicleNumber,
        driverName,
        driverPhone
      };
      emitToUser(customerId, 'booking_fully_filled', {
        orderId,
        trucksNeeded: orderTotalTrucks,
        trucksFilled: newTrucksFilled,
        filledAt: now,
        eventId: customerEventId,
        emittedAt: now,
        latestAssignment,
        // Keep array for backward compatibility with existing consumers.
        assignments: [
          latestAssignment
        ]
      });
    }

    // Push notification to customer
    sendPushNotification(customerId, {
      title: `Truck ${newTrucksFilled}/${orderTotalTrucks} Confirmed!`,
      body: `${vehicleNumber} (${driverName}) assigned`,
      data: {
        type: 'truck_confirmed',
        orderId,
        trucksConfirmed: newTrucksFilled,
        totalTrucks: orderTotalTrucks
      }
    }).catch((err: unknown) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn(`FCM to customer failed: ${errorMessage}`);
    });

    // If fully filled, cancel expiry timer and clear active key
    if (newStatus === 'fully_filled') {
      await redisService.cancelTimer(this.TIMER_KEYS.ORDER_EXPIRY(orderId)).catch(() => { });
      await this.clearProgressiveStepTimers(orderId).catch(() => { });
      await this.clearCustomerActiveBroadcast(customerId);
      logger.info(`Order ${orderId} fully filled! All ${orderTotalTrucks} trucks assigned.`);
    }

    return {
      success: true,
      assignmentId,
      tripId,
      message: `Successfully assigned. ${newTrucksFilled}/${orderTotalTrucks} trucks filled.`
    };
  }

  /**
   * Get order details with all truck requests
   */
  async getOrderDetails(orderId: string): Promise<(OrderRecord & { truckRequests: TruckRequestRecord[] }) | null> {
    const order = await db.getOrderById(orderId);
    if (!order) return null;

    const truckRequests = await db.getTruckRequestsByOrder(orderId);

    return {
      ...order,
      truckRequests
    };
  }

  /**
   * Get active truck requests for a transporter
   * Returns ONLY requests matching their vehicle types
   */
  async getActiveRequestsForTransporter(transporterId: string): Promise<TruckRequestRecord[]> {
    return await db.getActiveTruckRequestsForTransporter(transporterId);
  }

  /**
   * Get orders by customer
   */
  async getOrdersByCustomer(customerId: string): Promise<OrderRecord[]> {
    return await db.getOrdersByCustomer(customerId);
  }

  /**
   * Get order details and truck requests with role-aware access checks.
   */
  async getOrderWithRequests(orderId: string, userId: string, userRole: string) {
    const order = await db.getOrderById(orderId);
    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
    }

    const requests = await db.getTruckRequestsByOrder(orderId);

    if (userRole === 'customer' && order.customerId !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied');
    }

    if (userRole === 'transporter') {
      const canAccess = requests.some((request) => {
        const notified = request.notifiedTransporters || [];
        return notified.includes(userId) || request.assignedTransporterId === userId;
      });
      if (!canAccess) {
        throw new AppError(403, 'FORBIDDEN', 'Access denied');
      }
    }

    if (userRole === 'driver') {
      const assignments = await prismaClient.assignment.findMany({
        where: { orderId },
        select: { driverId: true }
      });
      const canAccess = assignments.some((assignment) => assignment.driverId === userId);
      if (!canAccess) {
        throw new AppError(403, 'FORBIDDEN', 'Access denied');
      }
    }

    return {
      order,
      requests,
      summary: {
        totalTrucks: order.totalTrucks,
        trucksFilled: order.trucksFilled,
        trucksSearching: requests.filter((request) => request.status === 'searching').length,
        trucksExpired: requests.filter((request) => request.status === 'expired').length
      }
    };
  }

  /**
   * Get active truck requests grouped by order for transporter control surfaces.
   */
  async getActiveTruckRequestsForTransporter(transporterId: string): Promise<ActiveTruckRequestOrderGroup[]> {
    const requests = await db.getActiveTruckRequestsForTransporter(transporterId);
    const byOrder = new Map<string, TruckRequestRecord[]>();

    for (const request of requests) {
      if (!byOrder.has(request.orderId)) {
        byOrder.set(request.orderId, []);
      }
      byOrder.get(request.orderId)!.push(request);
    }

    const orderIds = Array.from(byOrder.keys());
    const orders = await db.getOrdersByIds(orderIds);
    const orderById = new Map(orders.map(order => [order.id, order]));

    const grouped = Array.from(byOrder.entries()).map(([orderId, orderRequests]) => {
      const order = orderById.get(orderId);
      if (!order) return null;
      return {
        order,
        requests: orderRequests.sort((left, right) => left.requestNumber - right.requestNumber)
      };
    });

    return grouped
      .filter((entry): entry is ActiveTruckRequestOrderGroup => entry !== null)
      .sort((left, right) => {
        return new Date(right.order.createdAt).getTime() - new Date(left.order.createdAt).getTime();
      });
  }

  /**
   * Get customer orders with pagination and per-order request summary.
   */
  async getCustomerOrders(customerId: string, page: number = 1, limit: number = 20) {
    const boundedPage = Math.max(1, page);
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const orders = await db.getOrdersByCustomer(customerId);
    const sortedOrders = orders.sort((left, right) => {
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    });

    const total = sortedOrders.length;
    const start = (boundedPage - 1) * boundedLimit;
    const paginatedOrders = sortedOrders.slice(start, start + boundedLimit);

    const ordersWithSummary = await Promise.all(
      paginatedOrders.map(async (order) => {
        const requests = await db.getTruckRequestsByOrder(order.id);
        return {
          ...order,
          requestsSummary: {
            total: requests.length,
            searching: requests.filter((request) => request.status === 'searching').length,
            assigned: requests.filter((request) => request.status === 'assigned').length,
            completed: requests.filter((request) => request.status === 'completed').length,
            expired: requests.filter((request) => request.status === 'expired').length
          }
        };
      })
    );

    return {
      orders: ordersWithSummary,
      total,
      hasMore: start + paginatedOrders.length < total
    };
  }
}

const ORDER_TIMER_CHECK_INTERVAL_MS = 2_000;
let orderTimerCheckerInterval: NodeJS.Timeout | null = null;

function startOrderTimerChecker(): void {
  if (orderTimerCheckerInterval) return;
  orderTimerCheckerInterval = setInterval(async () => {
    try {
      await orderService.processExpiredTimers();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`[ORDER TIMER] Failed to process timers: ${errorMessage}`);
    }
  }, ORDER_TIMER_CHECK_INTERVAL_MS);
}

export function stopOrderTimerChecker(): void {
  if (!orderTimerCheckerInterval) return;
  clearInterval(orderTimerCheckerInterval);
  orderTimerCheckerInterval = null;
}

// Export singleton
export const orderService = new OrderService();
startOrderTimerChecker();
