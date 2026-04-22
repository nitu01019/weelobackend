/**
 * =============================================================================
 * ORDER TYPES - Internal type definitions for order module
 * =============================================================================
 *
 * Extracted from OrderService (Phase 2 of decomposition).
 * Contains all non-exported internal types used across order sub-services.
 * =============================================================================
 */

import { Prisma } from '@prisma/client';
import type { TruckRequestRecord } from '../../shared/database/db';
import type { CreateOrderRequest, CreateOrderResponse } from './order.service';

// ---------------------------------------------------------------------------
// Dispatch Outbox Types
// ---------------------------------------------------------------------------

export type OrderDispatchOutboxStatus = 'pending' | 'processing' | 'retrying' | 'dispatched' | 'failed';

export interface OrderDispatchOutboxPayload {
  orderId: string;
}

export interface DispatchAttemptContext {
  request: CreateOrderRequest;
  truckRequests: TruckRequestRecord[];
  expiresAt: string;
  pickup: { latitude: number; longitude: number; address: string; city?: string; state?: string };
}

export interface DispatchAttemptOutcome {
  dispatchState: CreateOrderResponse['dispatchState'];
  reasonCode?: string;
  onlineCandidates: number;
  notifiedTransporters: number;
  dispatchAttempts: number;
}

export interface DispatchOutboxRow {
  id: string;
  orderId: string;
  payload: Prisma.JsonValue;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: Date;
  lockedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Lifecycle Outbox Types
// ---------------------------------------------------------------------------

export type OrderLifecycleOutboxStatus = 'pending' | 'processing' | 'retrying' | 'dispatched' | 'failed';

export interface OrderCancelledOutboxPayload {
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
  cancelledBy: 'customer' | 'transporter' | 'system';
  refundStatus: string;
  assignmentIds: string[];
  cancelledAt: string;
  eventId: string;
  eventVersion: number;
  serverTimeMs: number;
  compensationAmount?: number;
  settlementState?: string;
}

export interface TripCompletedOutboxPayload {
  type: 'trip_completed';
  assignmentId: string;
  tripId: string;
  bookingId: string;
  orderId: string;
  vehicleId: string;
  transporterId: string;
  driverId: string;
  customerId: string;
  completedAt: string;
  eventId: string;
  eventVersion: number;
  serverTimeMs: number;
}

// P4 F2.1: post-commit assignment-timer scheduling via durable outbox.
// Replaces fire-and-forget queueService.scheduleAssignmentTimeout(...) call
// after confirmed-hold tx commit — poller replays the scheduling so the 45s
// driver-acceptance timer survives a crash between commit and timer insert.
export interface AssignmentTimerSchedulePayload {
  type: 'assignment_timer_schedule';
  assignmentId: string;
  driverId: string;
  driverName: string;
  transporterId: string;
  vehicleId: string;
  vehicleNumber: string;
  tripId: string | null;
  orderId: string;
  bookingId: string | null;
  truckRequestId: string | null;
  scheduleAt: string;
  eventId: string;
  eventVersion: number;
  serverTimeMs: number;
  createdAt: string;
}

// P4 F2.NEW-2: post-commit fleet-cache invalidation via durable outbox.
// Replaces the non-transactional Redis write after confirmed-hold tx commit so
// fleet-cache never stays stale if the process crashes between commit and the
// cache invalidate — poller replays invalidateVehicleCache per vehicle.
export interface AssignmentCacheRefreshPayload {
  type: 'assignment_cache_refresh';
  transporterId: string;
  vehicleIds: string[];
  assignmentIds: string[];
  eventId: string;
  serverTimeMs: number;
}

// W3 A03-004 / A13-005: durable post-commit trip_assigned fan-out via outbox.
// Replaces the fire-and-forget socket emit + FCM enqueue loop at
// confirmed-hold.service.ts:472-577 so a process crash between DB tx commit
// and the per-driver loop no longer silently drops driver notifications.
// One row per driver is written INSIDE the confirmed-hold tx; the outbox
// poller replays emitToUser + queuePushNotification on crash-recovery.
// customerPhone stores the ALREADY-MASKED value (producer calls
// maskPhoneForExternal before persisting; parser does NOT re-mask so the
// replayed payload is byte-identical to the fast-path emission).
// pickup/drop use canonical { latitude, longitude, ... }; socket lat/lng
// aliasing (A13-013) is applied at dispatcher-replay time, keeping the row
// producer-shape-agnostic.
export interface TripAssignedFanoutPayload {
  type: 'trip_assigned_fanout';
  orderId: string;
  tripId: string | null;
  assignmentId: string;
  driverId: string;
  transporterId: string;
  bookingId: string | null;
  truckRequestId: string | null;
  pickup: { latitude: number; longitude: number; address: string; city?: string };
  drop: { latitude: number; longitude: number; address: string; city?: string };
  farePerTruck: number;
  distanceKm: number | null;
  vehicleNumber: string | null;
  vehicleType: string | null;
  customerName: string;
  customerPhone: string;
  assignedAt: string;
  expiresAt: string;
  message: string;
  eventId: string;
  eventVersion: number;
  serverTimeMs: number;
}

export type OrderLifecycleOutboxPayload =
  | OrderCancelledOutboxPayload
  | TripCompletedOutboxPayload
  | AssignmentTimerSchedulePayload
  | AssignmentCacheRefreshPayload
  | TripAssignedFanoutPayload;

export interface LifecycleOutboxRow {
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

// ---------------------------------------------------------------------------
// Cancel Policy Types
// ---------------------------------------------------------------------------

export type TruckCancelPolicyStage =
  | 'SEARCHING'
  | 'DRIVER_ASSIGNED'
  | 'AT_PICKUP'
  | 'LOADING_STARTED'
  | 'IN_TRANSIT'
  | 'UNLOADING_STARTED';

export type TruckCancelDecision = 'allowed' | 'blocked_dispute_only';

export interface CancelMoneyBreakdown {
  baseCancellationFee: number;
  waitingCharges: number;
  percentageFareComponent: number;
  driverMinimumGuarantee: number;
  finalAmount: number;
}

export interface TruckCancelPolicyEvaluation {
  stage: TruckCancelPolicyStage;
  decision: TruckCancelDecision;
  reasonRequired: boolean;
  reasonCode: string;
  penaltyBreakdown: CancelMoneyBreakdown;
  driverCompensationBreakdown: CancelMoneyBreakdown;
  settlementState: 'pending' | 'settled' | 'waived';
  pendingPenaltyAmount: number;
}

export interface CancelOrderResult {
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

// ---------------------------------------------------------------------------
// Broadcast Types
// ---------------------------------------------------------------------------

/**
 * Route Point for broadcast
 */
export interface BroadcastRoutePoint {
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
export interface BroadcastRouteLeg {
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
export interface BroadcastRouteBreakdown {
  legs: BroadcastRouteLeg[];
  totalDistanceKm: number;
  totalDurationMinutes: number;
  totalDurationFormatted: string;
  totalStops: number;
  estimatedArrival?: string;
}

/**
 * Broadcast data sent to transporters via WebSocket
 *
 * IMPORTANT: Field names must match what Captain app's SocketIOService expects!
 * Captain app parses these in handleNewBroadcast() with fallbacks.
 *
 * ROUTE POINTS:
 * - routePoints array includes all stops (PICKUP -> STOP -> STOP -> DROP)
 * - Driver sees full route before accepting
 * - currentRouteIndex always 0 for new broadcasts
 *
 * @see Captain app: SocketIOService.kt -> handleNewBroadcast()
 */
export interface BroadcastData {
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
