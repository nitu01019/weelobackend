/**
 * =============================================================================
 * CONFIRMED HOLD PHASE 2 SERVICE - Two-Phase Truck Hold System
 * =============================================================================
 *
 * PHASE 2 (CONFIRMED) - PRD 7777:
 * - Max 180s duration from confirmation
 * - Trucks are exclusively locked
 * - Drivers get 45s each to accept/decline
 * - If driver declines, truck goes back to FLEX (Phase 1)
 * - No further extensions possible
 * - Transitions to COMPLETED or EXPIRED
 *
 * CONFIGURATION:
 * - CONFIRMED_HOLD_MAX_SECONDS = 180 (max duration in Phase 2)
 * - DRIVER_ACCEPT_TIMEOUT_SECONDS = 45 (driver response time)
 *
 * FLOW:
 * 1. Transporter confirms → Move to CONFIRMED (Phase 2)
 * 2. Lock trucks exclusively
 * 3. Notify drivers (each gets 45s to respond)
 * 4. Driver accepts → Truck confirmed, tracking starts
 * 5. Driver declines → Truck back to FLEX (Phase 1)
 * 6. 180s timeout → Hold expires, all trucks released
 *
 * @author Weelo Team
 * @version 1.0.0 (PRD 7777 Implementation)
 * =============================================================================
 */

import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prismaClient, withDbTimeout, HoldPhase, AssignmentStatus } from '../../shared/database/prisma.service';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { socketService, SocketEvent } from '../../shared/services/socket.service';
import { queueService } from '../../shared/services/queue.service';
import { holdExpiryCleanupService } from '../hold-expiry/hold-expiry-cleanup.service';
import { releaseVehicle } from '../../shared/services/vehicle-lifecycle.service';
import { HOLD_CONFIG } from '../../core/config/hold-config';
import { smartTimeoutService } from '../order-timeout/smart-timeout.service';
import { tryAutoRedispatch } from '../assignment/auto-redispatch.service';
import { validateActorEligibility, HoldEligibilityError } from './hold-eligibility';
import { metrics } from '../../shared/monitoring/metrics.service';
import { maskPhoneForExternal } from '../../shared/utils/pii.utils';
import { FLAGS, NUMERIC_FLAGS, isEnabled, getNumericFlag } from '../../shared/config/feature-flags';
import type { RoutePointRecord } from '../../shared/database/record-types';

// =============================================================================
// P6-E: buildTripAssignedDriverNotification — single-source-of-truth helper
// =============================================================================
// ADR A03-011/A03-012: All three trip_assigned emit paths (confirmed-hold,
// reassign-driver, cascade-dispatch) MUST call this helper so the socket and
// FCM payloads are byte-equal regardless of the code path that triggers the
// notification. Defined here to avoid the circular import that would arise if
// the helper lived in index.ts (index.ts re-exports confirmed-hold.service.ts,
// creating a cycle). reassign-driver and cascade-dispatch import this symbol
// directly from ./confirmed-hold.service — NOT through the barrel.
// =============================================================================

/** Maximum FCM data-field size before routePoints is truncated (bytes). */
const ROUTE_POINTS_FCM_BYTE_LIMIT = 4096;
/** Maximum number of route points kept when payload exceeds FCM limit. */
const ROUTE_POINTS_FCM_MAX_COUNT = 10;

/** Shape of the trip_assigned socket payload. */
export interface TripAssignedPayload {
  type: 'trip_assigned';
  assignmentId: string;
  tripId: string | null;
  orderId: string | null;
  bookingId: string | null;
  truckRequestId: string | null;
  pickup: Record<string, unknown>;
  drop: Record<string, unknown>;
  vehicleNumber: string;
  vehicleType: string;
  distanceKm: number;
  farePerTruck: number;
  customerName: string;
  customerPhone: string;
  assignedAt: string;
  expiresAt: string;
  /** Server-epoch ms anchor (A03-003): Captain offset-corrects countdown using this. */
  serverNowMs: number;
  /** Absolute ms deadline for driver accept window (A03-003). */
  deadlineMs: number;
  routePoints: RoutePointRecord[];
  message: string;
}

/** FCM data map — all values MUST be strings per FCM contract. */
export interface TripAssignedFcmData extends Record<string, string> {
  payload: string;
  type: string;
  assignmentId: string;
  tripId: string;
  orderId: string;
  truckRequestId: string;
  pickup: string;
  drop: string;
  pickupAddress: string;
  pickupCity: string;
  pickupLat: string;
  pickupLng: string;
  dropAddress: string;
  dropCity: string;
  dropLat: string;
  dropLng: string;
  vehicleNumber: string;
  farePerTruck: string;
  distanceKm: string;
  customerName: string;
  customerPhone: string;
  assignedAt: string;
  expiresAt: string;
  serverNowMs: string;
  deadlineMs: string;
  routePoints: string;
  routePointsTruncated: string;
}

/**
 * Build the canonical trip_assigned driver notification payload.
 *
 * Pure function (no side effects). All three emit paths call this so the
 * socket and FCM payloads are structurally identical (A03-011 / A03-012).
 *
 * P6-T09 contract: output always includes `routePoints`, `deadlineMs`, `serverNowMs`.
 *
 * @param order       - Order row with pickup/drop/distanceKm/customerName/customerPhone/routePoints.
 * @param farePerTruck - TruckRequest.pricePerTruck (0 fallback).
 * @param assignment  - Assignment fields for the payload.
 * @param deadlineMs  - Absolute server epoch-ms deadline for driver accept window.
 */
export function buildTripAssignedDriverNotification(
  order: {
    pickup: unknown;
    drop: unknown;
    distanceKm: number | null | undefined;
    customerName: string | null | undefined;
    customerPhone: string | null | undefined;
    routePoints?: unknown;
  } | null | undefined,
  farePerTruck: number,
  assignment: {
    id: string;
    tripId: string | null;
    orderId: string | null;
    bookingId: string | null;
    truckRequestId: string | null;
    vehicleNumber: string;
    vehicleType: string;
  },
  deadlineMs: number,
): { socketPayload: TripAssignedPayload; fcmData: TripAssignedFcmData } {
  const serverNowMs = Date.now();

  // Dual lat/lng + latitude/longitude keys for cross-convention client compat.
  const pickupRaw = (order?.pickup as Record<string, unknown>) || {};
  const dropRaw = (order?.drop as Record<string, unknown>) || {};

  const socketPickup: Record<string, unknown> = {
    ...pickupRaw,
    lat: pickupRaw.latitude ?? pickupRaw.lat ?? 0,
    lng: pickupRaw.longitude ?? pickupRaw.lng ?? 0,
  };
  const socketDrop: Record<string, unknown> = {
    ...dropRaw,
    lat: dropRaw.latitude ?? dropRaw.lat ?? 0,
    lng: dropRaw.longitude ?? dropRaw.lng ?? 0,
  };
  const fcmPickup = {
    address: (pickupRaw.address as string) ?? '',
    city: (pickupRaw.city as string) ?? '',
    latitude: (pickupRaw.latitude as number) ?? (pickupRaw.lat as number) ?? 0,
    longitude: (pickupRaw.longitude as number) ?? (pickupRaw.lng as number) ?? 0,
  };
  const fcmDrop = {
    address: (dropRaw.address as string) ?? '',
    city: (dropRaw.city as string) ?? '',
    latitude: (dropRaw.latitude as number) ?? (dropRaw.lat as number) ?? 0,
    longitude: (dropRaw.longitude as number) ?? (dropRaw.lng as number) ?? 0,
  };

  const expiresAtIso = new Date(deadlineMs).toISOString();
  const assignedAtIso = new Date(serverNowMs).toISOString();
  const maskedPhone = maskPhoneForExternal(order?.customerPhone || '');
  const distanceKm = Number(order?.distanceKm ?? 0);
  const customerName = order?.customerName ?? '';

  // P6-T36: zero-stop orders → emit [] not undefined.
  const rawRoutePoints: unknown = order?.routePoints;
  const routePoints: RoutePointRecord[] = Array.isArray(rawRoutePoints) ? rawRoutePoints : [];

  // P6-T37: truncate when JSON > 4 KB. Captain fetches full list via REST
  // when fcmData.routePointsTruncated === 'true'.
  let routePointsForFcm = routePoints;
  let routePointsTruncated = false;
  if (Buffer.byteLength(JSON.stringify(routePoints), 'utf8') > ROUTE_POINTS_FCM_BYTE_LIMIT) {
    routePointsForFcm = routePoints.slice(0, ROUTE_POINTS_FCM_MAX_COUNT);
    routePointsTruncated = true;
  }

  const message = `New trip assigned! ${fcmPickup.address || 'Pickup'} → ${fcmDrop.address || 'Drop'}`;

  const socketPayload: TripAssignedPayload = {
    type: 'trip_assigned',
    assignmentId: assignment.id,
    tripId: assignment.tripId,
    orderId: assignment.orderId,
    bookingId: assignment.bookingId,
    truckRequestId: assignment.truckRequestId,
    pickup: socketPickup,
    drop: socketDrop,
    vehicleNumber: assignment.vehicleNumber,
    vehicleType: assignment.vehicleType,
    distanceKm,
    farePerTruck,
    customerName,
    customerPhone: maskedPhone,
    assignedAt: assignedAtIso,
    expiresAt: expiresAtIso,
    serverNowMs,
    deadlineMs,
    routePoints,
    message,
  };

  const fcmPayloadObj = {
    type: 'trip_assigned',
    assignmentId: assignment.id,
    tripId: assignment.tripId,
    orderId: assignment.orderId,
    truckRequestId: assignment.truckRequestId ?? '',
    pickup: fcmPickup,
    drop: fcmDrop,
    vehicleNumber: assignment.vehicleNumber,
    farePerTruck,
    distanceKm,
    customerName,
    customerPhone: maskedPhone,
    assignedAt: assignedAtIso,
    expiresAt: expiresAtIso,
    serverNowMs,
    deadlineMs,
    message,
  };

  const fcmData: TripAssignedFcmData = {
    payload: JSON.stringify(fcmPayloadObj),
    type: 'trip_assigned',
    assignmentId: assignment.id,
    tripId: assignment.tripId ?? '',
    orderId: assignment.orderId ?? '',
    truckRequestId: assignment.truckRequestId ?? '',
    pickup: JSON.stringify(fcmPickup),
    drop: JSON.stringify(fcmDrop),
    pickupAddress: fcmPickup.address,
    pickupCity: fcmPickup.city,
    pickupLat: String(fcmPickup.latitude),
    pickupLng: String(fcmPickup.longitude),
    dropAddress: fcmDrop.address,
    dropCity: fcmDrop.city,
    dropLat: String(fcmDrop.latitude),
    dropLng: String(fcmDrop.longitude),
    vehicleNumber: assignment.vehicleNumber,
    farePerTruck: String(farePerTruck),
    distanceKm: String(distanceKm),
    customerName,
    customerPhone: maskedPhone,
    assignedAt: assignedAtIso,
    expiresAt: expiresAtIso,
    serverNowMs: String(serverNowMs),
    deadlineMs: String(deadlineMs),
    routePoints: JSON.stringify(routePointsForFcm),
    routePointsTruncated: routePointsTruncated ? 'true' : 'false',
  };

  return { socketPayload, fcmData };
}

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

/**
 * Confirmed hold configuration
 */
export interface ConfirmedHoldConfig {
  maxDurationSeconds: number;
  driverAcceptTimeoutSeconds: number;
}

/**
 * Confirmed hold state
 */
export interface ConfirmedHoldState {
  holdId: string;
  orderId: string;
  transporterId: string;
  phase: HoldPhase;
  confirmedAt: Date;
  confirmedExpiresAt: Date;
  remainingSeconds: number;
  trucksCount: number;
  trucksAccepted: number;
  trucksDeclined: number;
  trucksPending: number;
}

/**
 * Driver acceptance response
 */
export interface DriverAcceptResponse {
  success: boolean;
  assignmentId: string;
  accepted: boolean;
  declined: boolean;
  timeout: boolean;
  message: string;
  errorCode?: string;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

const DEFAULT_CONFIG: ConfirmedHoldConfig = {
  maxDurationSeconds: HOLD_CONFIG.confirmedHoldMaxSeconds,
  driverAcceptTimeoutSeconds: HOLD_CONFIG.driverAcceptTimeoutSeconds,
};

// Redis keys for distributed locking and state
const REDIS_KEYS = {
  // Standardized: lock: prefix for all distributed locks (added by acquireLock automatically)
  CONFIRMED_HOLD_LOCK: (holdId: string) => `confirmed-hold:${holdId}`,
  CONFIRMED_HOLD_STATE: (holdId: string) => `confirmed-hold:${holdId}:state`,
  DRIVER_ACCEPTANCE: (assignmentId: string) => `driver-acceptance:${assignmentId}`,
};

// =============================================================================
// NO-ACK SWEEP — 15-second transitional in-memory guard (P3-T27)
// =============================================================================
//
// TODO(Phase-6-migration): This in-memory sweep is a transitional pattern
// until the outbox substrate from Phase 6 lands.  When
// `notification-outbox.service.ts` or `vehicle-transition-outbox.service.ts`
// are available, migrate this to an outbox-backed durable sweep:
//   1. On socket emit success: write a `dispatch_ack_pending` outbox row with
//      a 15-second schedule window instead of registering a local setTimeout.
//   2. The outbox poller fires the sweep logic transactionally — no process-
//      restart data loss, no per-pod timer drift at scale.
//   3. Delete _pendingDispatches, _registerNoAckSweep, and
//      DISPATCH_NO_ACK_TIMEOUT_MS from this file once Phase 6 is live.
//      Keep the Redis insurance key (dispatch_ack_pending:{assignmentId})
//      because the outbox row replaces it functionally.

/**
 * How long (ms) to wait before declaring a dispatched trip_assigned as
 * timed-out with no ack.  Exported so tests can lower it to ~100ms without
 * relying on Jest fake timers (which interact poorly with .unref()).
 */
export let DISPATCH_NO_ACK_TIMEOUT_MS = 15_000;

/** Internal shape stored per pending dispatch. */
interface PendingDispatch {
  assignmentId: string;
  driverId: string;
  dispatchedAtMs: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
}

/**
 * Module-level Map keyed by assignmentId.  Entries are inserted after a
 * successful trip_assigned socket emit and removed either when
 * `acknowledgeDispatch` is called (ack received) or when the sweep fires.
 */
export const _pendingDispatches = new Map<string, PendingDispatch>();

/**
 * Called from `acknowledgeDispatch` (wired by the P3-F socket handler) when
 * the driver's client sends a dispatch_ack.  Clears the pending entry so the
 * 15-second sweep does NOT fire the timeout counter.
 */
export function acknowledgeDispatch(assignmentId: string): void {
  const entry = _pendingDispatches.get(assignmentId);
  if (!entry) return;
  clearTimeout(entry.cleanupTimer);
  _pendingDispatches.delete(assignmentId);
}

// =============================================================================
// CONFIRMED HOLD SERVICE
// =============================================================================

class ConfirmedHoldService {
  private config: ConfirmedHoldConfig;

  constructor(config: Partial<ConfirmedHoldConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize a confirmed hold (transition from FLEX)
   * FIX-6: Added transporterId parameter for ownership verification.
   * FIX-39: Uses a single `now` timestamp for all writes in this operation.
   */
  async initializeConfirmedHold(
    holdId: string,
    transporterId: string,
    assignments: Array<{
      assignmentId: string;
      driverId: string;
      truckRequestId: string;
    }>
  ): Promise<{
    success: boolean;
    message: string;
    confirmedExpiresAt?: Date;
    missingAssignmentIds?: string[];
    errorCode?: string;
    httpStatus?: number;
  }> {
    logger.info('[CONFIRMED HOLD] Initializing confirmed hold', {
      holdId,
      transporterId,
      assignmentsCount: assignments.length,
    });

    // P4 F2.2/F2.8/F2.NEW-1: scope assignment IDs + pessimistic lock on TruckRequest
    // rows + Serializable isolation all live inside withDbTimeout so the retry/timeout
    // wrapper at src/shared/database/prisma.service.ts:444 covers the whole critical
    // section. Returning cross-tenant rows or racing sibling flex-holds is no longer
    // possible because (a) the assignment findMany is now scoped by transporterId and
    // (b) the matching TruckRequest rows are SELECT ... FOR UPDATE locked inside the TX.
    const assignmentIds = assignments.map(a => a.assignmentId);
    const truckRequestIds = assignments
      .map(a => a.truckRequestId)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);

    try {
      // H-8 FIX: Wrap read-check-write in a Prisma $transaction with SELECT FOR UPDATE
      // to prevent TOCTOU race where two concurrent requests both read phase=FLEX
      // and both update to CONFIRMED.
      const txResult = await withDbTimeout(async (tx) => {
        // F-A-75: row-locked KYC+isActive re-check (same TX as the phase transition).
        await validateActorEligibility(tx, transporterId, 'confirmed_hold');

        // Lock the row with FOR UPDATE to prevent concurrent phase transitions
        const rows = await tx.$queryRaw<Array<{
          holdId: string;
          phase: string;
          transporterId: string;
          confirmedExpiresAt: Date | null;
        }>>`
          SELECT "holdId", "phase", "transporterId", "confirmedExpiresAt"
          FROM "TruckHoldLedger"
          WHERE "holdId" = ${holdId}
          FOR UPDATE
        `;
        const existing = rows[0];

        if (!existing) {
          return { success: false as const, message: 'Hold not found', errorCode: 'HOLD_NOT_FOUND', httpStatus: 404 };
        }

        // FIX-6: Ownership verification — only the transporter who created the hold can confirm it
        if (existing.transporterId !== transporterId) {
          logger.warn('[CONFIRMED HOLD] Ownership check failed for initializeConfirmedHold', {
            holdId,
            requestedBy: transporterId,
            ownedBy: existing.transporterId,
          });
          return { success: false as const, message: 'Not your hold', errorCode: 'FORBIDDEN', httpStatus: 403 };
        }

        if (existing.phase === HoldPhase.CONFIRMED) {
          logger.info('[CONFIRMED HOLD] Already initialized, returning existing', { holdId });
          return {
            success: true as const,
            message: 'Already in CONFIRMED phase (idempotent)',
            confirmedExpiresAt: existing.confirmedExpiresAt ?? undefined,
          };
        }

        if (existing.phase === HoldPhase.EXPIRED || existing.phase === HoldPhase.RELEASED) {
          return {
            success: false as const,
            message: `Hold has expired or been released (current phase: ${existing.phase})`,
            errorCode: 'HOLD_EXPIRED',
            httpStatus: 410,
          };
        }

        if (existing.phase !== HoldPhase.FLEX) {
          return {
            success: false as const,
            message: `Cannot move to CONFIRMED from ${existing.phase} -- must be FLEX`,
            errorCode: 'HOLD_ALREADY_CONFIRMED',
            httpStatus: 409,
          };
        }

        const now = new Date();
        const confirmedExpiresAt = new Date(
          now.getTime() + this.config.maxDurationSeconds * 1000
        );

        // P4 F2.8: Pessimistic lock the caller's TruckRequest rows INSIDE the tx.
        // Blocks sibling flex-hold/confirmed-hold operations on the same rows until
        // we commit, and — combined with the `heldById` filter — makes it impossible
        // to acquire a confirmed hold over rows owned by a different transporter.
        if (truckRequestIds.length > 0) {
          const lockedRows = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id
            FROM "TruckRequest"
            WHERE id = ANY(${truckRequestIds}::text[])
              AND "heldById" = ${transporterId}
            FOR UPDATE
          `;
          if (lockedRows.length !== truckRequestIds.length) {
            // Cross-tenant attempt OR caller submitted stale truck-request ids.
            // Surface as 403 FORBIDDEN_REQUEST — same shape as F2.2 throw below.
            throw new AppError(
              403,
              'FORBIDDEN_REQUEST',
              `Expected ${truckRequestIds.length} truck requests held by transporter ${transporterId}; found ${lockedRows.length}`,
            );
          }
        }

        // P4 F2.2: Scope the assignment fetch by transporterId BEFORE the phase flip
        // so an attacker cannot hand us another tenant's assignment IDs and have
        // this service leak their driver / vehicle / trip data via the fanout
        // payload below. Fetching inside the tx also closes the post-commit
        // TOCTOU window where an assignment could be reassigned between the
        // ledger flip and the findMany.
        const assignmentsData = await tx.assignment.findMany({
          where: {
            id: { in: assignmentIds },
            transporterId,
          },
          select: {
            id: true,
            driverId: true,
            driverName: true,
            transporterId: true,
            vehicleId: true,
            vehicleNumber: true,
            vehicleType: true,
            tripId: true,
            orderId: true,
            bookingId: true,
            truckRequestId: true,
            truckRequest: { select: { pricePerTruck: true } },
          },
        });
        if (assignmentsData.length !== assignmentIds.length) {
          throw new AppError(
            403,
            'FORBIDDEN_REQUEST',
            `Expected ${assignmentIds.length} assignments owned by transporter ${transporterId}; found ${assignmentsData.length}`,
          );
        }

        // Update hold to confirmed phase (within the same TX that holds the row lock)
        const updated = await tx.truckHoldLedger.update({
          where: { holdId },
          data: {
            phase: HoldPhase.CONFIRMED,
            phaseChangedAt: now,
            status: 'confirmed',
            confirmedAt: now,
            confirmedExpiresAt,
            expiresAt: confirmedExpiresAt,
            updatedAt: now,
          },
        });

        // P4 F2.1 + F2.NEW-2: durable post-commit coordination via OrderLifecycleOutbox.
        // The 45s driver-acceptance timer and fleet-cache invalidation used to run
        // fire-and-forget after commit — a process crash between commit and those
        // side effects leaves the hold uncleaned-up and the cache desynced. Writing
        // them as outbox rows INSIDE the tx means the poller replays them post-commit
        // transactionally-safely. Gated OFF by default for soak-safe rollout.
        if (isEnabled(FLAGS.ASSIGNMENT_TIMER_OUTBOX_ENABLED)) {
          const driverTimerScheduleAt = new Date(
            now.getTime() + this.config.driverAcceptTimeoutSeconds * 1000
          ).toISOString();
          const createdAtIso = now.toISOString();

          for (const assignment of assignmentsData) {
            const timerPayload = {
              type: 'assignment_timer_schedule',
              assignmentId: assignment.id,
              driverId: assignment.driverId,
              driverName: assignment.driverName,
              transporterId: assignment.transporterId,
              vehicleId: assignment.vehicleId,
              vehicleNumber: assignment.vehicleNumber,
              tripId: assignment.tripId,
              orderId: assignment.orderId ?? updated.orderId,
              bookingId: assignment.bookingId,
              truckRequestId: assignment.truckRequestId,
              scheduleAt: driverTimerScheduleAt,
              eventId: uuidv4(),
              eventVersion: 1,
              serverTimeMs: now.getTime(),
              createdAt: createdAtIso,
            };
            await tx.orderLifecycleOutbox.create({
              data: {
                id: uuidv4(),
                orderId: assignment.orderId ?? updated.orderId,
                eventType: 'assignment_timer_schedule',
                payload: timerPayload as unknown as Prisma.InputJsonValue,
                status: 'pending',
                attempts: 0,
                maxAttempts: 10,
                nextRetryAt: now,
              },
            });
          }

          const cachePayload = {
            type: 'assignment_cache_refresh',
            transporterId: updated.transporterId,
            vehicleIds: Array.from(
              new Set(
                assignmentsData
                  .map((a) => a.vehicleId)
                  .filter((v): v is string => typeof v === 'string' && v.length > 0)
              )
            ),
            assignmentIds: assignmentsData.map((a) => a.id),
            eventId: uuidv4(),
            serverTimeMs: now.getTime(),
          };
          await tx.orderLifecycleOutbox.create({
            data: {
              id: uuidv4(),
              orderId: updated.orderId,
              eventType: 'assignment_cache_refresh',
              payload: cachePayload as unknown as Prisma.InputJsonValue,
              status: 'pending',
              attempts: 0,
              maxAttempts: 10,
              nextRetryAt: now,
            },
          });
        }

        // W3 A03-004/A13-005: durable post-commit trip_assigned fan-out via
        // OrderLifecycleOutbox. When OFF, the legacy fire-and-forget fanout loop
        // (~line 472-577) runs post-commit unchanged. When ON, one row per driver
        // is written INSIDE this tx so a process crash between commit and the
        // fanout loop cannot silently drop driver notifications — the poller
        // replays via dispatchTripAssignedFanoutFromOutbox (W3-T07). Fast-path
        // success marks the rows 'dispatched' post-commit so the poller stays
        // idle unless a crash occurs. Gated OFF by default for soak-safe rollout.
        //
        // Outbox replay safety: /confirm-with-assignments now reads X-Idempotency-Key
        // (Phase 2 A01-006). Re-driven deliveries cannot double-create ledger rows.
        const fanoutOutboxIds: string[] = [];
        // P6-T29 (A09-006): Canary partition — deterministic across pods.
        // SHA-256 fallback (no murmurhash3 dep): hash(transporterId) % 100 < rolloutPercent.
        const _fanoutRolloutPct = getNumericFlag(NUMERIC_FLAGS.TRIP_ASSIGNED_FANOUT_OUTBOX_ROLLOUT_PCT);
        const _fanoutHashVal = createHash('sha256').update(updated.transporterId).digest().readUInt32BE(0) % 100;
        const _fanoutInCanary = _fanoutHashVal < _fanoutRolloutPct;
        if (isEnabled(FLAGS.TRIP_ASSIGNED_FANOUT_OUTBOX_ENABLED) && _fanoutInCanary) {
          // Fetch parent order's customer/pickup/drop context inside tx so the
          // outbox row carries all fields needed by the dispatcher replay
          // (see order-types.ts TripAssignedFanoutPayload). A tx-scoped fetch
          // is required because the post-commit parentOrder read at line ~454
          // runs AFTER the tx is already released — it cannot inform an
          // inside-tx write.
          const fanoutParentOrder = await tx.order.findUnique({
            where: { id: updated.orderId },
            select: {
              id: true,
              pickup: true,
              drop: true,
              distanceKm: true,
              customerName: true,
              customerPhone: true,
            },
          });
          const fanoutPickup = (fanoutParentOrder?.pickup as any) || {};
          const fanoutDrop = (fanoutParentOrder?.drop as any) || {};
          const fanoutExpiresAtIso = new Date(
            now.getTime() + this.config.driverAcceptTimeoutSeconds * 1000
          ).toISOString();
          const fanoutAssignedAtIso = now.toISOString();

          for (const assignment of assignmentsData) {
            const assignmentFare = assignment.truckRequest?.pricePerTruck ?? 0;
            const fanoutPayload = {
              type: 'trip_assigned_fanout' as const,
              orderId: assignment.orderId ?? updated.orderId,
              tripId: assignment.tripId,
              assignmentId: assignment.id,
              driverId: assignment.driverId,
              transporterId: assignment.transporterId,
              bookingId: assignment.bookingId,
              truckRequestId: assignment.truckRequestId,
              pickup: {
                latitude: Number(fanoutPickup?.latitude ?? fanoutPickup?.lat ?? 0) || 0,
                longitude: Number(fanoutPickup?.longitude ?? fanoutPickup?.lng ?? 0) || 0,
                address: typeof fanoutPickup?.address === 'string' ? fanoutPickup.address : '',
                city: typeof fanoutPickup?.city === 'string' ? fanoutPickup.city : undefined,
              },
              drop: {
                latitude: Number(fanoutDrop?.latitude ?? fanoutDrop?.lat ?? 0) || 0,
                longitude: Number(fanoutDrop?.longitude ?? fanoutDrop?.lng ?? 0) || 0,
                address: typeof fanoutDrop?.address === 'string' ? fanoutDrop.address : '',
                city: typeof fanoutDrop?.city === 'string' ? fanoutDrop.city : undefined,
              },
              farePerTruck: Number(assignmentFare ?? 0) || 0,
              distanceKm: typeof fanoutParentOrder?.distanceKm === 'number' ? fanoutParentOrder.distanceKm : null,
              vehicleNumber: assignment.vehicleNumber ?? null,
              vehicleType: assignment.vehicleType ?? null,
              customerName: fanoutParentOrder?.customerName ?? '',
              // MASK AT PRODUCER — parser does NOT re-mask. maskPhoneForExternal
              // is already imported in this file (line 46) and used by the
              // post-commit fanout loop below (line 519/573/599). Reuse here
              // so the persisted row is byte-identical to the fast-path emission.
              customerPhone: maskPhoneForExternal(fanoutParentOrder?.customerPhone || ''),
              assignedAt: fanoutAssignedAtIso,
              expiresAt: fanoutExpiresAtIso,
              message: `New trip assigned! ${fanoutPickup?.address ?? ''} → ${fanoutDrop?.address ?? ''}`,
              eventId: uuidv4(),
              eventVersion: 1,
              serverTimeMs: now.getTime(),
            };
            const outboxId = uuidv4();
            await tx.orderLifecycleOutbox.create({
              data: {
                id: outboxId,
                orderId: assignment.orderId ?? updated.orderId,
                eventType: 'trip_assigned_fanout',
                payload: fanoutPayload as unknown as Prisma.InputJsonValue,
                status: 'pending',
                attempts: 0,
                maxAttempts: 10,
                nextRetryAt: now,
              },
            });
            fanoutOutboxIds.push(outboxId);
          }
        }

        return { success: true as const, updated, now, confirmedExpiresAt, assignmentsData, fanoutOutboxIds };
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeoutMs: 10_000,
        site: 'confirmed_hold_init',
      });

      // Handle early-return cases from the transaction
      if (!txResult.success) {
        return {
          success: false,
          message: txResult.message,
          errorCode: (txResult as any).errorCode,
          httpStatus: (txResult as any).httpStatus,
        };
      }
      if (txResult.message) {
        // Idempotent return — already CONFIRMED
        return {
          success: true,
          message: txResult.message,
          confirmedExpiresAt: txResult.confirmedExpiresAt,
        };
      }

      // Transaction succeeded with a phase transition — extract results.
      // P4 F2.2: assignmentsData now flows out of the same tx that did the ledger
      // flip + truck-request FOR UPDATE, so fanout below always runs against the
      // transporter-scoped view the tx validated (no post-commit re-fetch leak).
      const { updated, now, confirmedExpiresAt, assignmentsData, fanoutOutboxIds } = txResult as {
        success: true;
        updated: { orderId: string; transporterId: string; quantity: number };
        now: Date;
        confirmedExpiresAt: Date;
        assignmentsData: Array<{
          id: string;
          driverId: string;
          driverName: string;
          transporterId: string;
          vehicleId: string;
          vehicleNumber: string;
          vehicleType: string;
          tripId: string | null;
          orderId: string | null;
          bookingId: string | null;
          truckRequestId: string | null;
          truckRequest: { pricePerTruck: number } | null;
        }>;
        // W3 A03-004/A13-005: ids of trip_assigned_fanout rows written inside tx
        // when FLAGS.TRIP_ASSIGNED_FANOUT_OUTBOX_ENABLED is ON. Empty when flag OFF.
        fanoutOutboxIds: string[];
      };

      // Cache state
      await this.cacheConfirmedHoldState(holdId, {
        holdId,
        orderId: updated.orderId,
        transporterId: updated.transporterId,
        phase: HoldPhase.CONFIRMED,
        confirmedAt: now,
        confirmedExpiresAt,
        remainingSeconds: this.config.maxDurationSeconds,
        trucksCount: updated.quantity,
        trucksAccepted: 0,
        trucksDeclined: 0,
        trucksPending: updated.quantity,
      });

      // Schedule expiry cleanup job (Layer 1).
      // P4 F2.1: When the assignment-timer outbox is enabled, the post-commit
      // scheduling becomes durable via OrderLifecycleOutbox (written inside the
      // tx above). Keep the legacy fire-and-forget call as the fallback path when
      // the flag is OFF so behavior is unchanged during the soak period.
      if (!isEnabled(FLAGS.ASSIGNMENT_TIMER_OUTBOX_ENABLED)) {
        await holdExpiryCleanupService.scheduleConfirmedHoldCleanup(holdId, confirmedExpiresAt);
        logger.debug('[CONFIRMED HOLD] Cleanup job scheduled', { holdId });
      } else {
        logger.debug('[CONFIRMED HOLD] Cleanup scheduling delegated to lifecycle outbox', { holdId });
      }

      // Create a map for quick lookup
      const assignmentMap = new Map(
        assignmentsData.map(a => [a.id, a])
      );

      // P2 F4.1: Fetch order/booking context for trip_assigned fanout.
      // Mirrors truck-hold.service.ts:1612-1678 payload shape so the captain app
      // receives the same data via socket + FCM as the legacy path.
      const parentOrder = await prismaClient.order.findUnique({
        where: { id: updated.orderId },
        select: {
          id: true,
          pickup: true,
          drop: true,
          distanceKm: true,
          customerName: true,
          customerPhone: true,
          // P6-T07 (A03-008): routePoints for trip_assigned driver notification.
          routePoints: true,
        },
      });
      const pickup = (parentOrder?.pickup as any) || {};
      const drop = (parentOrder?.drop as any) || {};
      // A03-003: server-authoritative epoch-ms anchor reused by deadlineMs below.
      // socketPickup/socketDrop removed — now built inside buildTripAssignedDriverNotification.
      const confirmedHoldDeadlineMs =
        now.getTime() + this.config.driverAcceptTimeoutSeconds * 1000;
      const expiresAtIso = new Date(confirmedHoldDeadlineMs).toISOString();

      // Schedule driver acceptance timeouts with full data AND
      // fan out per-driver socket emit + FCM enqueue (P2 F4.1).
      const missingIds: string[] = [];
      // P3-T28: record wall-clock start for confirmed_hold_fanout_duration_ms histogram.
      const fanoutT0 = Date.now();
      // W3 A13-005: confirmed-hold fanout observability (agent-13-scale-model.md F-05).
      // `expected` = intended per-driver notifications for this hold. `socket_ok`
      // and `fcm_ok` increment per successful channel delivery inside the loop.
      // Sustained socket_ok/expected < 0.99 or fcm_ok/expected < 0.99 signals
      // fast-path degradation; the A03-004 outbox covers durable replay when it
      // happens, but the counter is the alertable SLO signal.
      const expectedFanouts = assignments.length;
      let fanoutSocketSuccess = 0;
      let fanoutFcmSuccess = 0;
      metrics.incrementCounter('confirmed_hold_fanout_total', { outcome: 'expected' }, expectedFanouts);
      for (const assignment of assignments) {
        const fullData = assignmentMap.get(assignment.assignmentId);

        if (!fullData) {
          missingIds.push(assignment.assignmentId);
          continue;
        }

        // FIX-39: Pass the operation-level `now` timestamp for consistency.
        // P4 F2.1: When the outbox is enabled, the per-driver 45s timer is
        // replayed by the lifecycle-outbox poller from the row inserted in the
        // tx above — skip the fire-and-forget call here so the timer cannot be
        // scheduled twice. Fanout (socket + FCM below) is unaffected.
        if (!isEnabled(FLAGS.ASSIGNMENT_TIMER_OUTBOX_ENABLED)) {
          await this.scheduleDriverAcceptanceTimeout(
            assignment.assignmentId,
            fullData,
            this.config.driverAcceptTimeoutSeconds,
            now
          );
        }

        // P2 F4.1: per-driver try/catch so one failure never aborts the fanout.
        try {
          const farePerTruck = fullData.truckRequest?.pricePerTruck ?? 0;
          // P6-T08 (A03-008/A03-011): helper builds socket + FCM payloads as a
          // single unit — routePoints, serverNowMs, deadlineMs always present.
          // P6-T36: zero-stop orders emit routePoints=[] (handled in helper).
          // P6-T37: routePoints truncated to 10 pts + flag when JSON > 4 KB.
          const { socketPayload: driverNotification, fcmData } =
            buildTripAssignedDriverNotification(
              parentOrder,
              farePerTruck,
              {
                id: fullData.id,
                tripId: fullData.tripId,
                orderId: fullData.orderId,
                bookingId: fullData.bookingId,
                truckRequestId: fullData.truckRequestId,
                vehicleNumber: fullData.vehicleNumber,
                vehicleType: fullData.vehicleType,
              },
              confirmedHoldDeadlineMs,
            );

          // Socket emit
          try {
            await socketService.emitToUser(
              fullData.driverId,
              SocketEvent.TRIP_ASSIGNED,
              driverNotification
            );
            metrics.incrementCounter('new_assignment_socket_emit_total', { result: 'success' });
            // W3 A13-005: channel-granular fanout success counter.
            metrics.incrementCounter('confirmed_hold_fanout_total', { outcome: 'socket_ok' });
            fanoutSocketSuccess += 1;
          } catch (sockErr) {
            metrics.incrementCounter('new_assignment_socket_emit_total', { result: 'fail' });
            logger.warn('[CONFIRMED HOLD] socket emit trip_assigned failed', {
              assignmentId: fullData.id,
              driverId: fullData.driverId,
              error: sockErr instanceof Error ? sockErr.message : String(sockErr),
            });
          }

          // fcmData is built by buildTripAssignedDriverNotification above —
          // includes routePoints, serverNowMs, deadlineMs, and all legacy flat
          // keys (pickupLat/pickupLng/etc.) per A05-003 + A03-003 requirements.

          try {
            await queueService.queuePushNotification(fullData.driverId, {
              title: '🚛 New Trip Assigned!',
              body: `${pickup?.address ?? 'Pickup'} → ${drop?.address ?? 'Drop'}`,
              data: fcmData,
            });
            metrics.incrementCounter('new_assignment_fcm_enqueue_total', { result: 'success' });
            // W3 A13-005: channel-granular fanout success counter.
            metrics.incrementCounter('confirmed_hold_fanout_total', { outcome: 'fcm_ok' });
            fanoutFcmSuccess += 1;
          } catch (fcmErr) {
            metrics.incrementCounter('new_assignment_fcm_enqueue_total', { result: 'fail' });
            logger.warn('[CONFIRMED HOLD] FCM enqueue trip_assigned failed', {
              assignmentId: fullData.id,
              driverId: fullData.driverId,
              error: fcmErr instanceof Error ? fcmErr.message : String(fcmErr),
            });
          }
        } catch (perDriverErr) {
          logger.error('[CONFIRMED HOLD] per-driver dispatch failed', {
            assignmentId: fullData?.id,
            driverId: fullData?.driverId,
            error: perDriverErr instanceof Error ? perDriverErr.message : String(perDriverErr),
          });
        }
      }

      if (missingIds.length > 0) {
        logger.warn('[CONFIRMED HOLD] Some assignments not found', { missingIds });
      }
      // P3-T28: observe total fanout loop wall-clock duration.
      metrics.observeHistogram('confirmed_hold_fanout_duration_ms', Date.now() - fanoutT0);

      // W3 A03-004/A13-005: fast-path succeeded for all drivers — mark the
      // trip_assigned_fanout outbox rows as 'dispatched' so the poller stays
      // idle. On failure here, the rows remain 'pending' and the poller reclaims
      // after lockedAt staleness (120s), replaying via dispatchTripAssignedFanoutFromOutbox.
      // The updateMany itself is best-effort — failing to mark-dispatched means
      // the poller may emit a duplicate socket + FCM, but client-side dedup
      // (_seq ZSET for socket, collapseKey for FCM) absorbs that.
      if (fanoutOutboxIds.length > 0) {
        try {
          await prismaClient.orderLifecycleOutbox.updateMany({
            where: { id: { in: fanoutOutboxIds } },
            data: {
              status: 'dispatched',
              processedAt: new Date(),
              lockedAt: null,
            },
          });
        } catch (markErr: unknown) {
          const errorMessage = markErr instanceof Error ? markErr.message : String(markErr);
          logger.warn('[CONFIRMED HOLD] failed to mark trip_assigned_fanout rows dispatched (non-fatal; poller will reclaim)', {
            holdId,
            rowCount: fanoutOutboxIds.length,
            error: errorMessage,
          });
        }
      }

      logger.info('[CONFIRMED HOLD] Confirmed hold initialized', {
        holdId,
        confirmedExpiresAt,
        // W3 A13-005: fanout observability fields — makes SLO tracking possible
        // from a single log scan before the counter ratios are aggregated upstream.
        expectedFanouts,
        fanoutSocketSuccess,
        fanoutFcmSuccess,
        fanoutOutboxRows: fanoutOutboxIds.length,
      });

      // P2 F2.6: counter for confirmed-hold post-commit commits.
      metrics.incrementCounter('hold_confirmed_committed_total', { stage: 'post_commit' });

      return {
        success: true,
        message: 'Confirmed hold initialized',
        confirmedExpiresAt,
        missingAssignmentIds: missingIds.length > 0 ? missingIds : undefined,
      };
    } catch (error: any) {
      // F-A-75: map KYC/isActive ineligibility to 403 (not generic 500).
      if (error instanceof HoldEligibilityError) {
        logger.warn('[CONFIRMED HOLD] Eligibility denied', { code: error.code, transporterId, holdId });
        return { success: false, message: error.message, errorCode: error.code, httpStatus: 403 };
      }
      // P4 F2.2/F2.8/F2.NEW-1: surface cross-tenant FORBIDDEN_REQUEST and
      // TRANSACTION_CONFLICT (withDbTimeout wraps exhausted P2034 retries as 409)
      // with their intended HTTP status instead of collapsing to 500.
      if (error instanceof AppError) {
        logger.warn('[CONFIRMED HOLD] AppError from tx', {
          code: error.code,
          statusCode: error.statusCode,
          transporterId,
          holdId,
        });
        return {
          success: false,
          message: error.message,
          errorCode: error.code,
          httpStatus: error.statusCode,
        };
      }
      logger.error('[CONFIRMED HOLD] Failed to initialize confirmed hold', {
        error: error.message,
        holdId,
      });

      return {
        success: false,
        message: 'Failed to initialize confirmed hold',
        errorCode: 'INITIALIZE_FAILED',
        httpStatus: 500,
      };
    }
  }

  /**
   * Handle driver acceptance
   */
  async handleDriverAcceptance(
    assignmentId: string,
    driverId: string
  ): Promise<DriverAcceptResponse> {
    logger.info('[CONFIRMED HOLD] Handling driver acceptance', { assignmentId });

    try {
      const lockKey = REDIS_KEYS.DRIVER_ACCEPTANCE(assignmentId);
      const lockHolder = uuidv4();
      const lock = await redisService.acquireLock(lockKey, lockHolder, 10);

      if (!lock.acquired) {
        return {
          success: false,
          assignmentId,
          accepted: false,
          declined: false,
          timeout: false,
          message: 'Could not acquire lock for driver acceptance',
        };
      }

      try {
        // FIX-39: Single timestamp for the entire acceptance operation
        const now = new Date();
        const nowIso = now.toISOString();

        // F-A-75: CAS + driver-row KYC check run in the same TX (FOR UPDATE).
        const updated = await withDbTimeout(async (tx) => {
          await validateActorEligibility(tx, driverId, 'driver_accept');
          return tx.assignment.updateMany({
            where: { id: assignmentId, driverId, status: AssignmentStatus.pending },
            data: { status: AssignmentStatus.driver_accepted, driverAcceptedAt: nowIso },
          });
        }, { timeoutMs: 15_000, maxWait: 5_000, site: 'driver_accept_cas' });

        if (updated.count === 0) {
          // Assignment was already accepted/declined/cancelled/timed-out
          const current = await prismaClient.assignment.findUnique({
            where: { id: assignmentId },
            select: { status: true },
          });
          logger.warn('[CONFIRMED HOLD] Driver accept rejected -- assignment not in pending state', {
            assignmentId,
            currentStatus: current?.status,
          });
          return {
            success: false,
            assignmentId,
            accepted: false,
            declined: false,
            timeout: false,
            message: `Assignment is no longer pending (current: ${current?.status})`,
          };
        }

        // Fetch full assignment record for downstream side effects
        const assignment = await prismaClient.assignment.findUniqueOrThrow({
          where: { id: assignmentId },
        });

        // FIX A5#3: Apply post-accept side effects (Redis availability, tracking, GPS, notifications)
        // FIX M12: Pass bookingId and orderId separately so order-path customer lookup works
        try {
          const { applyPostAcceptSideEffects } = require('../assignment/post-accept.effects');
          await applyPostAcceptSideEffects({
            assignmentId,
            driverId: assignment.driverId,
            vehicleId: assignment.vehicleId,
            vehicleNumber: assignment.vehicleNumber,
            tripId: assignment.tripId,
            bookingId: assignment.bookingId,
            orderId: assignment.orderId,
            transporterId: assignment.transporterId,
            driverName: assignment.driverName || 'Driver',
          });
        } catch (effectsErr: any) {
          logger.warn('[CONFIRMED HOLD] Post-accept side effects failed (non-fatal)', {
            assignmentId, error: effectsErr?.message,
          });
        }

        // FIX #25 + F-L10: FK traversal via DRY helper
        const { orderId: resolvedOrderId } = await this.resolveAssignmentTruckRequest(assignmentId);

        if (resolvedOrderId) {
          // Find any hold ledger for this order
          const holdLedger = await prismaClient.truckHoldLedger.findFirst({
            where: { orderId: resolvedOrderId, phase: HoldPhase.CONFIRMED },
          });

          if (holdLedger) {
            // FIX #28: Atomic Redis counter with HINCRBY — prevents lost increments
            // under concurrent driver acceptances (was read-modify-write race).
            //
            // NOTE: If Redis is unavailable during accept/decline, the counter may drift.
            // The 5-minute reconciliation in live-availability.service.ts corrects this.
            // This is an intentional tradeoff: availability is best-effort, DB is truth.
            const holdKey = REDIS_KEYS.CONFIRMED_HOLD_STATE(holdLedger.holdId);
            const [newAccepted, newPending] = await Promise.all([
              redisService.hIncrBy(holdKey, 'trucksAccepted', 1),
              redisService.hIncrBy(holdKey, 'trucksPending', -1),
            ]);

            // Read full state for the socket event payload
            const state = await this.getConfirmedHoldState(holdLedger.holdId);
            const trucksCount = state?.trucksCount ?? (newAccepted + Math.max(0, newPending));

            // Emit progress update
            await socketService.emitToUser(holdLedger.transporterId, 'driver_accepted', {
              holdId: holdLedger.holdId,
              assignmentId,
              driverId: assignment.driverId,
              trucksAccepted: newAccepted,
              trucksPending: Math.max(0, newPending),
              message: `Driver accepted. ${newAccepted}/${trucksCount} confirmed.`,
            });

            // M10 FIX: Extend smart timeout when driver accepts in Phase 2.
            // First acceptance adds +60s, subsequent adds +30s.
            try {
              await smartTimeoutService.extendTimeout({
                orderId: resolvedOrderId,
                driverId: assignment.driverId,
                driverName: assignment.driverName || 'Driver',
                assignmentId,
                truckRequestId: assignment.truckRequestId ?? undefined,
                isFirstDriver: newAccepted === 1,
                reason: 'Driver accepted in confirmed hold (Phase 2)',
              });
            } catch (extErr: any) {
              logger.warn('[CONFIRMED HOLD] Smart timeout extension failed (non-fatal)', {
                assignmentId, orderId: resolvedOrderId, error: extErr?.message,
              });
            }
          }
        }

        logger.info('[CONFIRMED HOLD] Driver accepted', {
          assignmentId,
          driverId: assignment.driverId,
        });

        return {
          success: true,
          assignmentId,
          accepted: true,
          declined: false,
          timeout: false,
          message: 'Driver accepted successfully',
        };
      } finally {
        // P4 F2.3: surface Redis lock release failures so ops can spot a
        // stuck/misconfigured Redis before holds build up. Lock TTL still
        // bounds blast radius; we just refuse to silently swallow.
        await redisService.releaseLock(lockKey, lockHolder).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn('redis_lock_release_failed', {
            op: 'confirmed_hold_driver_accept',
            assignmentId,
            err: message,
          });
          metrics.incrementCounter('redis_lock_release_failed_total', {
            op: 'confirmed_hold_driver_accept',
          });
        });
      }
    } catch (error: any) {
      // F-A-75: surface driver KYC/isActive ineligibility so client can prompt re-verify.
      if (error instanceof HoldEligibilityError) {
        logger.warn('[CONFIRMED HOLD] Driver eligibility denied on accept', { code: error.code, driverId, assignmentId });
        return { success: false, assignmentId, accepted: false, declined: false, timeout: false, message: error.message, errorCode: error.code };
      }
      logger.error('[CONFIRMED HOLD] Failed to handle driver acceptance', {
        error: error.message,
        assignmentId,
      });

      return {
        success: false,
        assignmentId,
        accepted: false,
        declined: false,
        timeout: false,
        message: 'Failed to handle driver acceptance',
      };
    }
  }

  /**
   * Handle driver decline
   */
  async handleDriverDecline(
    assignmentId: string,
    driverId: string,
    reason: string = ''
  ): Promise<DriverAcceptResponse> {
    logger.info('[CONFIRMED HOLD] Handling driver decline', {
      assignmentId,
      reason,
    });

    try {
      const lockKey = REDIS_KEYS.DRIVER_ACCEPTANCE(assignmentId);
      const lockHolder = uuidv4();
      const lock = await redisService.acquireLock(lockKey, lockHolder, 10);

      if (!lock.acquired) {
        return {
          success: false,
          assignmentId,
          accepted: false,
          declined: false,
          timeout: false,
          message: 'Could not acquire lock for driver decline',
        };
      }

      try {
        // F-M14 FIX: Atomic decline — CAS assignment update + trucksFilled decrement in one TX.
        // Previously these were two standalone calls; if the decrement failed, trucksFilled drifted.
        let txCasMiss = false;
        let txOrderId: string | null = null;

        try {
          await withDbTimeout(async (tx) => {
            // CAS guard: only decline if assignment is still pending
            const updated = await tx.assignment.updateMany({
              where: {
                id: assignmentId,
                driverId,
                status: AssignmentStatus.pending,  // CAS precondition
              },
              data: {
                status: AssignmentStatus.driver_declined,
              },
            });

            if (updated.count === 0) {
              txCasMiss = true;
              return; // TX commits with no-op — handled below
            }

            // Fetch orderId inside TX so the decrement targets the correct row
            const asnForOrder = await tx.assignment.findUnique({
              where: { id: assignmentId },
              select: { orderId: true },
            });
            txOrderId = asnForOrder?.orderId ?? null;

            // Decrement trucksFilled atomically with the decline
            if (txOrderId) {
              await tx.$executeRaw`
                UPDATE "Order" SET "trucksFilled" = GREATEST(0, "trucksFilled" - 1), "updatedAt" = NOW()
                WHERE "id" = ${txOrderId}
              `;
            }
          }, { timeoutMs: 15_000, maxWait: 5_000, site: 'driver_decline_cas' });
        } catch (txErr: any) {
          logger.error('[CONFIRMED HOLD] Atomic decline TX failed', {
            assignmentId, error: txErr?.message,
          });
          throw txErr; // propagate — outer catch returns failure response
        }

        if (txCasMiss) {
          const current = await prismaClient.assignment.findUnique({
            where: { id: assignmentId },
            select: { status: true },
          });
          logger.warn('[CONFIRMED HOLD] Driver decline rejected -- assignment not in pending state', {
            assignmentId,
            currentStatus: current?.status,
          });
          return {
            success: false,
            assignmentId,
            accepted: false,
            declined: false,
            timeout: false,
            message: `Assignment is no longer pending (current: ${current?.status})`,
          };
        }

        // Fetch full assignment record for downstream side effects
        const assignment = await prismaClient.assignment.findUniqueOrThrow({
          where: { id: assignmentId },
        });

        // FIX #41 + F-L10: FK traversal via DRY helper
        const { truckRequest, orderId: resolvedOrderId } = await this.resolveAssignmentTruckRequest(assignmentId);

        if (truckRequest) {
          // FIX #41: Keep truck in transporter's exclusive hold on decline.
          // Was 'searching' which released to public pool, breaking Phase 2 exclusivity.
          await prismaClient.truckRequest.update({
            where: { id: truckRequest.id },
            data: {
              status: 'held',           // Stays in transporter's hold (was 'searching')
              heldById: assignment.transporterId,  // QA-4 fix: restore heldById so release/cleanup can find it
              assignedDriverId: null,
              assignedDriverName: null,
              assignedVehicleId: null,
              assignedVehicleNumber: null,
            },
          });
        }

        // Update confirmed hold state
        if (resolvedOrderId) {
          const holdLedger = await prismaClient.truckHoldLedger.findFirst({
            where: { orderId: resolvedOrderId, phase: HoldPhase.CONFIRMED },
          });

          if (holdLedger) {
            // FIX #36 (partial): Atomic Redis counter with HINCRBY for decline
            // (mirrors FIX #28 pattern from handleDriverAcceptance)
            //
            // NOTE: If Redis is unavailable during accept/decline, the counter may drift.
            // The 5-minute reconciliation in live-availability.service.ts corrects this.
            // This is an intentional tradeoff: availability is best-effort, DB is truth.
            const holdKey = REDIS_KEYS.CONFIRMED_HOLD_STATE(holdLedger.holdId);
            const [newDeclined, newPending] = await Promise.all([
              redisService.hIncrBy(holdKey, 'trucksDeclined', 1),
              redisService.hIncrBy(holdKey, 'trucksPending', -1),
            ]);

            // Read full state for the socket event payload
            const state = await this.getConfirmedHoldState(holdLedger.holdId);
            const trucksCount = state?.trucksCount ?? (newDeclined + Math.max(0, newPending));

            // Emit decline notification
            await socketService.emitToUser(holdLedger.transporterId, 'driver_declined', {
              holdId: holdLedger.holdId,
              assignmentId,
              driverId: assignment.driverId,
              reason,
              trucksDeclined: newDeclined,
              trucksPending: Math.max(0, newPending),
              message: `Driver declined. ${newDeclined}/${trucksCount} declined.`,
            });
          }
        }

        // P4 F2.NEW-4: durable vehicle release — fail-open with metric + queue
        // retry so a transient Redis/fleet-cache hiccup can't leave a vehicle
        // pinned in 'on_hold' forever. VEHICLE_RELEASE processor owns the
        // retry schedule (5 attempts, exp backoff) and ultimately DLQs if
        // still failing.
        if (assignment.vehicleId) {
          const vehicleIdForRelease = assignment.vehicleId;
          try {
            await releaseVehicle(vehicleIdForRelease, 'confirmedHoldDecline');
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn('vehicle_release_failed_inline', {
              op: 'confirmed_hold_driver_decline',
              vehicleId: vehicleIdForRelease,
              err: message,
            });
            metrics.incrementCounter('vehicle_release_failed_total', {
              reason: 'inline_throw',
            });
            try {
              await queueService.enqueue(
                'vehicle-release',
                { vehicleId: vehicleIdForRelease, context: 'confirmedHoldDecline' },
                { maxAttempts: 5 },
              );
            } catch (enqueueErr: unknown) {
              const enqueueMessage =
                enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr);
              logger.error('vehicle_release_enqueue_failed', {
                op: 'confirmed_hold_driver_decline',
                vehicleId: vehicleIdForRelease,
                err: enqueueMessage,
              });
              metrics.incrementCounter('vehicle_release_failed_total', {
                reason: 'enqueue_throw',
              });
            }
          }
        }

        // H9 FIX: Cascade auto-redispatch after decline (Grab/Uber pattern).
        // Wrapped in try/catch so cascade failure never breaks the decline flow.
        try {
          await tryAutoRedispatch({
            bookingId: assignment.bookingId ?? undefined,
            orderId: assignment.orderId ?? undefined,
            transporterId: assignment.transporterId,
            vehicleId: assignment.vehicleId,
            vehicleType: assignment.vehicleType,
            vehicleSubtype: assignment.vehicleSubtype ?? undefined,
            declinedDriverId: driverId,
            assignmentId,
          });
        } catch (redispatchErr: any) {
          logger.warn('[CONFIRMED HOLD] Auto-redispatch after decline failed (non-fatal)', {
            assignmentId,
            error: redispatchErr?.message,
          });
        }

        logger.info('[CONFIRMED HOLD] Driver declined', {
          assignmentId,
          driverId: assignment.driverId,
          reason,
        });

        return {
          success: true,
          assignmentId,
          accepted: false,
          declined: true,
          timeout: false,
          message: 'Driver declined successfully',
        };
      } finally {
        // P4 F2.3: surface Redis lock release failures on the decline path
        // for the same reasons as handleDriverAcceptance above.
        await redisService.releaseLock(lockKey, lockHolder).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn('redis_lock_release_failed', {
            op: 'confirmed_hold_driver_decline',
            assignmentId,
            err: message,
          });
          metrics.incrementCounter('redis_lock_release_failed_total', {
            op: 'confirmed_hold_driver_decline',
          });
        });
      }
    } catch (error: any) {
      logger.error('[CONFIRMED HOLD] Failed to handle driver decline', {
        error: error.message,
        assignmentId,
      });

      return {
        success: false,
        assignmentId,
        accepted: false,
        declined: false,
        timeout: false,
        message: 'Failed to handle driver decline',
      };
    }
  }

  /**
   * Handle driver timeout (no response)
   */
  async handleDriverTimeout(assignmentId: string): Promise<DriverAcceptResponse> {
    logger.info('[CONFIRMED HOLD] Handling driver timeout', { assignmentId });

    const assignment = await prismaClient.assignment.findUnique({
      where: { id: assignmentId },
      select: { driverId: true },
    });
    if (!assignment?.driverId) {
      return {
        success: false,
        assignmentId,
        accepted: false,
        declined: false,
        timeout: true,
        message: 'Assignment not found for timeout',
      };
    }

    return await this.handleDriverDecline(assignmentId, assignment.driverId, 'Driver timed out');
  }

  /**
   * Get confirmed hold state
   * FIX #28: Now reads from Redis Hash (HGETALL) instead of JSON blob (GET+parse).
   */
  async getConfirmedHoldState(
    holdId: string
  ): Promise<ConfirmedHoldState | null> {
    try {
      // Try Redis Hash first
      const hashData = await redisService.hGetAll(
        REDIS_KEYS.CONFIRMED_HOLD_STATE(holdId)
      );

      if (hashData && Object.keys(hashData).length > 0 && hashData.holdId) {
        const state: ConfirmedHoldState = {
          holdId: hashData.holdId,
          orderId: hashData.orderId,
          transporterId: hashData.transporterId,
          phase: hashData.phase as HoldPhase,
          confirmedAt: new Date(hashData.confirmedAt),
          confirmedExpiresAt: new Date(hashData.confirmedExpiresAt),
          remainingSeconds: parseInt(hashData.remainingSeconds || '0', 10),
          trucksCount: parseInt(hashData.trucksCount || '0', 10),
          trucksAccepted: parseInt(hashData.trucksAccepted || '0', 10),
          trucksDeclined: parseInt(hashData.trucksDeclined || '0', 10),
          trucksPending: parseInt(hashData.trucksPending || '0', 10),
        };
        return this.refreshRemainingSeconds(state);
      }

      // Fall back to database
      const holdLedger = await prismaClient.truckHoldLedger.findUnique({
        where: { holdId },
      });

      if (!holdLedger || holdLedger.phase !== HoldPhase.CONFIRMED) {
        return null;
      }

      // Get truck requests for this order
      const truckRequests = await prismaClient.truckRequest.findMany({
        where: {
          orderId: holdLedger.orderId,
          status: {
            in: ['assigned', 'accepted', 'in_progress'],
          },
        },
      });

      // Count declined assignments for this order (driver_declined lives on Assignment, not TruckRequest)
      const declinedCount = await prismaClient.assignment.count({
        where: {
          orderId: holdLedger.orderId,
          status: AssignmentStatus.driver_declined,
        },
      });

      const now = new Date();
      const expiresAt = holdLedger.confirmedExpiresAt || holdLedger.expiresAt;
      const remainingSeconds = Math.max(
        0,
        Math.floor((expiresAt.getTime() - now.getTime()) / 1000)
      );

      const state: ConfirmedHoldState = {
        holdId,
        orderId: holdLedger.orderId,
        transporterId: holdLedger.transporterId,
        phase: HoldPhase.CONFIRMED,
        confirmedAt: holdLedger.confirmedAt || now,
        confirmedExpiresAt: expiresAt,
        remainingSeconds,
        trucksCount: holdLedger.quantity,
        trucksAccepted: truckRequests.filter((tr) =>
          ['accepted', 'in_progress'].includes(tr.status)
        ).length,
        trucksDeclined: declinedCount,
        trucksPending: truckRequests.filter((tr) =>
          tr.status === 'assigned'
        ).length,
      };

      await this.cacheConfirmedHoldState(holdId, state);

      return state;
    } catch (error: any) {
      logger.error('[CONFIRMED HOLD] Failed to get confirmed hold state', {
        error: error.message,
        holdId,
      });
      return null;
    }
  }

  /**
   * Check if confirmed hold has expired
   */
  async checkExpiry(holdId: string): Promise<{ expired: boolean; state?: ConfirmedHoldState }> {
    const state = await this.getConfirmedHoldState(holdId);
    if (!state) {
      return { expired: true };
    }

    return { expired: state.remainingSeconds <= 0, state };
  }

  // =========================================================================
  // PRIVATE METHODS
  // =========================================================================

  /**
   * F-L10 FIX: DRY — extracted shared FK traversal for Assignment → TruckRequest.
   * Used by both handleDriverAcceptance and handleDriverDecline to resolve
   * the TruckRequest and orderId from an assignment's FK chain.
   */
  private async resolveAssignmentTruckRequest(assignmentId: string): Promise<{
    truckRequest: { id: string; orderId: string } | null;
    orderId: string | null;
  }> {
    const record = await prismaClient.assignment.findUnique({
      where: { id: assignmentId },
      select: { truckRequestId: true, orderId: true },
    });

    const truckRequest = record?.truckRequestId
      ? await prismaClient.truckRequest.findFirst({
          where: { id: record.truckRequestId },
          select: { id: true, orderId: true },
        })
      : null;

    return {
      truckRequest,
      orderId: truckRequest?.orderId ?? record?.orderId ?? null,
    };
  }

  /**
   * Cache confirmed hold state in Redis
   * FIX #28: Now writes to Redis Hash (HMSET + EXPIRE) instead of JSON blob (SET).
   * This enables atomic HINCRBY for counter fields (trucksAccepted, trucksPending, etc.).
   */
  private async cacheConfirmedHoldState(
    holdId: string,
    state: ConfirmedHoldState
  ): Promise<void> {
    const key = REDIS_KEYS.CONFIRMED_HOLD_STATE(holdId);
    const ttl = Math.max(1, state.remainingSeconds) + 10;

    // Serialize all fields to strings for Redis Hash storage
    const hashFields: Record<string, string> = {
      holdId: state.holdId,
      orderId: state.orderId,
      transporterId: state.transporterId,
      phase: String(state.phase),
      confirmedAt: state.confirmedAt instanceof Date
        ? state.confirmedAt.toISOString()
        : String(state.confirmedAt),
      confirmedExpiresAt: state.confirmedExpiresAt instanceof Date
        ? state.confirmedExpiresAt.toISOString()
        : String(state.confirmedExpiresAt),
      remainingSeconds: String(state.remainingSeconds),
      trucksCount: String(state.trucksCount),
      trucksAccepted: String(state.trucksAccepted),
      trucksDeclined: String(state.trucksDeclined),
      trucksPending: String(state.trucksPending),
    };

    await redisService.hMSet(key, hashFields);
    await redisService.expire(key, ttl);
  }

  /**
   * Refresh remaining seconds in cached state
   */
  private refreshRemainingSeconds(state: ConfirmedHoldState): ConfirmedHoldState {
    const now = new Date();
    const remainingSeconds = Math.max(
      0,
      Math.floor((state.confirmedExpiresAt.getTime() - now.getTime()) / 1000)
    );
    state.remainingSeconds = remainingSeconds;
    return state;
  }

  /**
   * Schedule driver acceptance timeout
   */
  private async scheduleDriverAcceptanceTimeout(
    assignmentId: string,
    assignmentData: {
      driverId: string;
      driverName: string;
      transporterId: string;
      vehicleId: string;
      vehicleNumber: string;
      tripId: string;
      orderId: string;
      truckRequestId?: string;
    },
    timeoutSeconds: number,
    now?: Date
  ): Promise<void> {
    // FIX-39: Use caller-provided timestamp or create one once for consistency
    const ts = now ?? new Date();
    await queueService.scheduleAssignmentTimeout({
      assignmentId,
      driverId: assignmentData.driverId,
      driverName: assignmentData.driverName,
      transporterId: assignmentData.transporterId,
      vehicleId: assignmentData.vehicleId,
      vehicleNumber: assignmentData.vehicleNumber,
      tripId: assignmentData.tripId,
      orderId: assignmentData.orderId,
      truckRequestId: assignmentData.truckRequestId,
      createdAt: ts.toISOString(),
    }, timeoutSeconds * 1000);

    logger.debug('[CONFIRMED HOLD] Driver acceptance timeout scheduled', {
      assignmentId,
      timeoutSeconds,
      driverId: assignmentData.driverId,
    });
  }

  /**
   * P3-T27 — Register a 15-second no-ack sweep entry for a dispatched
   * trip_assigned socket emit.
   *
   * After the fanout loop emits to a driver, this method:
   *   1. Sets a Redis key `dispatch_ack_pending:{assignmentId}` with a 20-second
   *      TTL as a durable insurance signal (visible cross-pod).
   *   2. Inserts an entry in the module-level _pendingDispatches Map.
   *   3. Schedules a `.unref()`'d 15-second timeout.  If the entry is still
   *      present when the timer fires (i.e., no ack was received via
   *      acknowledgeDispatch), it increments the timeout counter and cleans up.
   */
  _registerNoAckSweep(assignmentId: string, driverId: string): void {
    // Redis insurance key — 20s TTL, best-effort (non-blocking)
    redisService
      .set(`dispatch_ack_pending:${assignmentId}`, '1', 20)
      .catch((err: unknown) => {
        logger.warn('[CONFIRMED HOLD] Failed to set dispatch_ack_pending Redis key (non-fatal)', {
          assignmentId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    const timer = setTimeout(() => {
      if (_pendingDispatches.has(assignmentId)) {
        metrics.incrementCounter('driver_overlay_rendered_total', {
          type: 'trip_assigned',
          result: 'fail',
          reason: 'timeout',
        });
        logger.warn('[CONFIRMED HOLD] No dispatch_ack received within timeout window', {
          assignmentId,
          driverId,
          timeoutMs: DISPATCH_NO_ACK_TIMEOUT_MS,
        });
        _pendingDispatches.delete(assignmentId);
      }
    }, DISPATCH_NO_ACK_TIMEOUT_MS);

    // .unref() so this timer does not prevent the test process (or a graceful
    // server shutdown) from exiting when no other work is pending.
    timer.unref();

    _pendingDispatches.set(assignmentId, {
      assignmentId,
      driverId,
      dispatchedAtMs: Date.now(),
      cleanupTimer: timer,
    });
  }
}

// =============================================================================
// EXPORT SINGLETON
// =============================================================================

export const confirmedHoldService = new ConfirmedHoldService({
  maxDurationSeconds: HOLD_CONFIG.confirmedHoldMaxSeconds,
  driverAcceptTimeoutSeconds: HOLD_CONFIG.driverAcceptTimeoutSeconds,
});
