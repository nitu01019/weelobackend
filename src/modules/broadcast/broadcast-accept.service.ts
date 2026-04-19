/**
 * =============================================================================
 * BROADCAST ACCEPT SERVICE — Accept broadcast + related logic
 * =============================================================================
 * Extracted from broadcast.service.ts for modularity.
 * =============================================================================
 */

import { v4 as uuidv4 } from 'uuid';
import { Prisma, AssignmentStatus, BookingStatus } from '@prisma/client';
import { BookingRecord, AssignmentRecord } from '../../shared/database/db';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, emitToRoom, SocketEvent } from '../../shared/services/socket.service';
import { sendPushNotification } from '../../shared/services/fcm.service';
import { redisService } from '../../shared/services/redis.service';
import { prismaClient, withDbTimeout, VehicleStatus } from '../../shared/database/prisma.service';
import { queueService } from '../../shared/services/queue.service';
import { HOLD_CONFIG } from '../../core/config/hold-config';
import { RADIUS_KEYS } from '../booking/booking.types';
import { metrics } from '../../shared/monitoring/metrics.service';
import { assertValidTransition, BOOKING_VALID_TRANSITIONS } from '../../core/state-machines';

export interface AcceptBroadcastParams {
  driverId: string;
  vehicleId: string;
  estimatedArrival?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
  actorUserId: string;
  actorRole: string;
  idempotencyKey?: string;
}

export interface AcceptBroadcastResult {
  assignmentId: string;
  tripId: string;
  status: 'assigned';
  trucksConfirmed: number;
  totalTrucksNeeded: number;
  isFullyFilled: boolean;
  resultCode?: string;
  replayed?: boolean;
}

export interface DeclineBroadcastParams {
  actorId: string;
  reason: string;
  notes?: string;
}

const acceptMetrics = {
  attempts: 0,
  success: 0,
  idempotentReplay: 0,
  lockContention: 0
};

const acceptFailureMetrics: Record<string, number> = {};

// H-02 FIX: In-process fallback locks when Redis lock acquisition fails.
// Provides single-instance serialization when distributed lock is unavailable.
const inProcessLocks = new Map<string, Promise<void>>();

const ACCEPT_METRIC_MAP: Record<keyof typeof acceptMetrics, string> = {
  attempts: 'accept.attempts',
  success: 'accept.success',
  idempotentReplay: 'accept.idempotent_replay',
  lockContention: 'accept.lock_contention',
};

function incrementAcceptMetric(metric: keyof typeof acceptMetrics): void {
  acceptMetrics[metric] += 1;
  metrics.incrementCounter(ACCEPT_METRIC_MAP[metric]);
}

function incrementAcceptFailureMetric(code: string): void {
  acceptFailureMetrics[code] = (acceptFailureMetrics[code] || 0) + 1;
}

/**
 * Retry a function with exponential backoff.
 * FIX Issue #7: Post-commit notifications must not be fire-and-forget.
 * Industry standard (Stripe): post-TX side effects get retry + DLQ.
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('retryWithBackoff: unreachable');
}

export async function acceptBroadcast(broadcastId: string, params: AcceptBroadcastParams): Promise<AcceptBroadcastResult> {
  const { driverId, vehicleId, idempotencyKey, actorUserId, actorRole, metadata } = params;
  // C-04 FIX: Use same lock key pattern as cancelBooking (`booking:${bookingId}`)
  // so accept and cancel serialize against each other. broadcastId === bookingId.
  // Note: acquireLock() prepends `lock:` automatically, so final key = `lock:booking:${id}`
  const lockKey = `booking:${broadcastId}`;
  const lockHolder = `${driverId}:${vehicleId}:${Date.now()}`;
  const idempotencyCacheKey = idempotencyKey
    ? `idem:broadcast:accept:${broadcastId}:${driverId}:${vehicleId}:${idempotencyKey}`
    : null;
  let lockAcquired = false;
  let secondaryLockAcquired = false;
  let resolveInProcessLock: (() => void) | undefined;

  incrementAcceptMetric('attempts');
  logger.info('[BroadcastAccept] Attempt', {
    broadcastId, vehicleId, driverId, actorUserId, actorRole,
    metadataKeys: metadata ? Object.keys(metadata) : [],
    idempotencyKey: idempotencyKey || null
  });

  // #86: Per-transporter rate limit — max 3 accept attempts per 5-second window
  // M-01 FIX: Atomic INCR+EXPIRE via Lua script — prevents orphaned keys without TTL
  const rateKey = `rl:accept:${driverId}`;
  try {
    const count = await redisService.eval(
      `local c = redis.call("INCR", KEYS[1]); if c == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end; return c`,
      [rateKey], ['5']
    );
    if (typeof count === 'number' && count > 3) {
      throw new AppError(429, 'RATE_LIMITED', 'Too many accept requests — please wait a moment before retrying');
    }
  } catch (err: unknown) {
    if (err instanceof AppError) throw err;
    // Redis failure: skip rate limit check (fail-open for availability)
    logger.warn('[BroadcastAccept] Rate limit check failed, proceeding', {
      broadcastId, driverId, error: err instanceof Error ? err.message : String(err),
    });
  }

  if (idempotencyCacheKey) {
    try {
      const cached = await redisService.getJSON<AcceptBroadcastResult>(idempotencyCacheKey);
      if (cached) {
        incrementAcceptMetric('idempotentReplay');
        logger.info('[BroadcastAccept] Idempotent replay from cache', { broadcastId, vehicleId, driverId, resultCode: 'IDEMPOTENT_REPLAY' });
        return { ...cached, resultCode: 'IDEMPOTENT_REPLAY', replayed: true };
      }
    } catch (error: unknown) {
      // #78: Corrupted idempotency cache entry — delete it so the request can proceed cleanly
      logger.warn('[BroadcastAccept] Corrupted idempotency cache — deleting', {
        key: idempotencyCacheKey, broadcastId, vehicleId, driverId,
        error: error instanceof Error ? error.message : String(error),
      });
      await redisService.del(idempotencyCacheKey).catch(() => {});
    }
  }

  try {
    const lock = await redisService.acquireLock(lockKey, lockHolder, 20);
    lockAcquired = lock.acquired;
    if (!lockAcquired) {
      incrementAcceptMetric('lockContention');
      logger.warn('[BroadcastAccept] Lock contention -- returning 429', { broadcastId, vehicleId, driverId });
      throw new AppError(429, 'LOCK_CONTENTION', 'Another accept is being processed for this broadcast. Please retry in 2 seconds.');
    }
  } catch (error: unknown) {
    if (error instanceof AppError) throw error;
    const lockMsg = error instanceof Error ? error.message : String(error);
    logger.warn('[BroadcastAccept] Primary lock failed, trying secondary Redis lock', { broadcastId, vehicleId, driverId, error: lockMsg });
    // M-14 FIX: Try a secondary Redis lock with a different key pattern before falling
    // back to in-process Map. This provides distributed serialization even when the
    // primary lock mechanism throws (e.g., transient Redis error on first attempt).
    try {
      const secondaryLockKey = `broadcast-accept-fallback:${broadcastId}`;
      const secondaryLock = await redisService.acquireLock(secondaryLockKey, lockHolder, 20);
      if (secondaryLock.acquired) {
        secondaryLockAcquired = true;
        logger.info('[BroadcastAccept] Secondary Redis lock acquired', { broadcastId, vehicleId, driverId });
      } else {
        throw new Error('Secondary lock not acquired');
      }
    } catch (secondaryErr: unknown) {
      // C19 FIX: Lock architecture documentation
      // Layer 1: Redis primary lock (distributed, preferred)
      // Layer 2: Redis secondary lock (distributed, fallback)
      // Layer 3: In-process Map lock (single-instance only — NOT effective on multi-ECS)
      // Layer 4: PostgreSQL advisory lock (pg_advisory_xact_lock) — unconditional inside TX
      // The advisory lock at Layer 4 is the REAL distributed safety net.
      // If both Redis layers fail, Layer 3 provides no cross-instance protection,
      // but Layer 4 always fires regardless.
      logger.warn('[BroadcastAccept] Both Redis lock layers failed — falling back to in-process lock (no cross-instance protection). Advisory lock (Layer 4) inside TX is the safety net.', {
        broadcastId, vehicleId, driverId,
        error: secondaryErr instanceof Error ? secondaryErr.message : String(secondaryErr),
      });
      // H-02 FIX: In-process fallback — wait for any competing operation on the same key
      const pending = inProcessLocks.get(lockKey);
      if (pending) await pending;
      inProcessLocks.set(lockKey, new Promise<void>(r => { resolveInProcessLock = r; }));
    }
  }

  // Cross-path vehicle mutex (H-11 fix): Acquire a distributed lock on vehicleId
  // before entering the accept flow. This prevents the same vehicle from being
  // concurrently assigned via broadcast-accept AND order-accept paths.
  const vehicleMutexKey = `lock:vehicle:${vehicleId}`;
  const vehicleMutexHolder = `broadcast:${Date.now()}:${process.pid}`;
  const vehicleMutex = await redisService.acquireLock(vehicleMutexKey, vehicleMutexHolder, 15);
  if (!vehicleMutex.acquired) {
    throw new AppError(409, 'VEHICLE_LOCKED', 'Vehicle is being assigned in another operation');
  }

  try {
    const activeStatuses: AssignmentStatus[] = ['pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit'];
    const maxTransactionAttempts = 3;
    let txResult: {
      replayed: boolean;
      assignmentId: string;
      tripId: string;
      trucksConfirmed: number;
      totalTrucksNeeded: number;
      isFullyFilled: boolean;
      booking: {
        trucksFilled: number;
        status: BookingRecord['status'];
        trucksNeeded: number;
        pricePerTruck: number;
        distanceKm: number;
        customerId: string;
        customerName: string;
        customerPhone: string;
        vehicleType: string;
        vehicleSubtype?: string;
        pickup?: unknown;
        drop?: unknown;
        [key: string]: unknown;
      };
      driver: { name?: string | null; phone?: string | null; transporterId?: string | null; [key: string]: unknown };
      vehicle: { vehicleNumber?: string | null; vehicleType?: string | null; vehicleSubtype?: string | null; [key: string]: unknown };
      transporter: { name?: string | null; businessName?: string | null; phone?: string | null; [key: string]: unknown };
    } | null = null;

    for (let attempt = 1; attempt <= maxTransactionAttempts; attempt += 1) {
      try {
        txResult = await withDbTimeout(async (tx) => {
          // H-20 FIX: Advisory lock serializes per-booking accepts at ReadCommitted level.
          // The existing CAS (updateMany WHERE) provides correctness; advisory lock prevents
          // retryable serialization errors, reducing P2034 contention.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${broadcastId}))`;
          const booking = await tx.booking.findUnique({ where: { id: broadcastId } });
          if (!booking) throw new AppError(404, 'INVALID_ASSIGNMENT_STATE', 'Broadcast not found');

          const actor = await tx.user.findUnique({ where: { id: actorUserId } });
          if (!actor || !actor.isActive) throw new AppError(403, 'INVALID_ASSIGNMENT_STATE', 'Assignment actor is not active');
          if (actorRole !== 'driver' && actorRole !== 'transporter') throw new AppError(403, 'INVALID_ASSIGNMENT_STATE', 'Unsupported actor role for assignment');
          if (actorRole === 'driver' && actor.id !== driverId) throw new AppError(403, 'DRIVER_NOT_IN_FLEET', 'Drivers can only assign themselves');
          if (actorRole === 'transporter' && actor.role === 'transporter' && actor.id === driverId) throw new AppError(409, 'INVALID_ASSIGNMENT_STATE', 'Transporter must provide a fleet driver for assignment');

          const driver = await tx.user.findUnique({ where: { id: driverId } });
          if (!driver || driver.role !== 'driver' || !driver.transporterId) throw new AppError(403, 'DRIVER_NOT_IN_FLEET', 'Driver is not eligible for this assignment');
          if (actorRole === 'transporter' && actor.id !== driver.transporterId) throw new AppError(403, 'DRIVER_NOT_IN_FLEET', 'Driver does not belong to this transporter');

          const vehicle = await tx.vehicle.findUnique({ where: { id: vehicleId } });
          if (!vehicle) throw new AppError(403, 'VEHICLE_NOT_IN_FLEET', 'Vehicle is not eligible for this assignment');
          if (vehicle.transporterId !== driver.transporterId) throw new AppError(403, 'VEHICLE_NOT_IN_FLEET', 'Vehicle does not belong to the same fleet as driver');
          if (actorRole === 'transporter' && actor.id !== vehicle.transporterId) throw new AppError(403, 'VEHICLE_NOT_IN_FLEET', 'Vehicle does not belong to this transporter');

          // CRITICAL #20: Validate vehicle type matches booking requirement
          if (vehicle.vehicleType && booking.vehicleType && vehicle.vehicleType !== booking.vehicleType) {
            throw new AppError(400, 'VEHICLE_TYPE_MISMATCH',
              `Booking requires ${booking.vehicleType} but vehicle is ${vehicle.vehicleType}`);
          }
          if (booking.vehicleSubtype && vehicle.vehicleSubtype && vehicle.vehicleSubtype !== booking.vehicleSubtype) {
            throw new AppError(400, 'VEHICLE_SUBTYPE_MISMATCH',
              `Booking requires ${booking.vehicleSubtype} but vehicle is ${vehicle.vehicleSubtype}`);
          }

          const transporter = await tx.user.findUnique({ where: { id: driver.transporterId } });
          if (!transporter) throw new AppError(409, 'INVALID_ASSIGNMENT_STATE', 'Transporter context missing for assignment');

          const existingAssignment = await tx.assignment.findFirst({
            where: { bookingId: broadcastId, driverId, vehicleId, status: { in: activeStatuses } },
            orderBy: { assignedAt: 'desc' }
          });

          if (existingAssignment) {
            return {
              replayed: true, assignmentId: existingAssignment.id, tripId: existingAssignment.tripId,
              trucksConfirmed: booking.trucksFilled, totalTrucksNeeded: booking.trucksNeeded,
              isFullyFilled: booking.trucksFilled >= booking.trucksNeeded,
              booking, driver, vehicle, transporter
            };
          }

          if (new Date(booking.expiresAt).getTime() < Date.now()) throw new AppError(409, 'BROADCAST_EXPIRED', 'Broadcast has expired');
          if (booking.trucksFilled >= booking.trucksNeeded) throw new AppError(409, 'BROADCAST_FILLED', 'Broadcast already filled');
          if (booking.status !== 'active' && booking.status !== 'partially_filled') throw new AppError(409, 'INVALID_ASSIGNMENT_STATE', 'Broadcast is not accepting assignments');

          const activeAssignment = await tx.assignment.findFirst({
            where: { driverId, status: { in: activeStatuses } },
            orderBy: { assignedAt: 'desc' }
          });
          if (activeAssignment) throw new AppError(409, 'DRIVER_BUSY', 'Driver already has an active trip. Assign a different driver.');

          const vehicleLock = await tx.vehicle.updateMany({
            where: { id: vehicleId, status: VehicleStatus.available },
            data: { status: VehicleStatus.on_hold }
          });
          if (vehicleLock.count === 0) throw new AppError(409, 'VEHICLE_UNAVAILABLE', 'Vehicle is no longer available');

          const bookingUpdate = await tx.booking.updateMany({
            where: { id: broadcastId, trucksFilled: booking.trucksFilled },
            data: { trucksFilled: { increment: 1 } }
          });
          if (bookingUpdate.count !== 1) {
            const latestBooking = await tx.booking.findUnique({
              where: { id: broadcastId },
              select: { expiresAt: true, status: true, trucksFilled: true, trucksNeeded: true }
            });
            if (!latestBooking) throw new AppError(404, 'INVALID_ASSIGNMENT_STATE', 'Broadcast not found');
            if (new Date(latestBooking.expiresAt).getTime() < Date.now()) throw new AppError(409, 'BROADCAST_EXPIRED', 'Broadcast has expired');
            if (latestBooking.trucksFilled >= latestBooking.trucksNeeded || latestBooking.status === 'fully_filled') throw new AppError(409, 'BROADCAST_FILLED', 'Broadcast already filled');
            throw new AppError(409, 'INVALID_ASSIGNMENT_STATE', 'Broadcast state changed. Retry assignment.');
          }

          const newTrucksFilled = booking.trucksFilled + 1;
          const newStatus: BookingRecord['status'] = newTrucksFilled >= booking.trucksNeeded ? 'fully_filled' : 'partially_filled';

          // STATE-MACHINE GUARD: Validate booking transition inside $transaction
          // (Prisma $use middleware cannot fire inside interactive transactions)
          // LOG-ONLY for now — matches middleware rollout strategy
          try {
            assertValidTransition('Booking', BOOKING_VALID_TRANSITIONS, booking.status, newStatus);
          } catch (smErr) {
            logger.warn('[BroadcastAccept] State machine violation (log-only)', {
              broadcastId, from: booking.status, to: newStatus,
              error: smErr instanceof Error ? smErr.message : String(smErr),
            });
          }

          await tx.booking.update({ where: { id: broadcastId }, data: { status: newStatus as BookingStatus } });

          const now = new Date().toISOString();
          const assignmentId = uuidv4();
          const tripId = uuidv4();
          const assignment: AssignmentRecord = {
            id: assignmentId, bookingId: broadcastId, tripId,
            transporterId: driver.transporterId,
            transporterName: transporter.name || transporter.businessName || 'Transporter',
            driverId, driverName: driver.name || 'Driver', driverPhone: driver.phone || '',
            vehicleId, vehicleNumber: vehicle.vehicleNumber || '',
            vehicleType: vehicle.vehicleType || booking.vehicleType,
            vehicleSubtype: vehicle.vehicleSubtype || booking.vehicleSubtype || '',
            status: 'pending', assignedAt: now
          };
          await tx.assignment.create({ data: { ...assignment, status: assignment.status as AssignmentStatus } });

          return {
            replayed: false, assignmentId, tripId, trucksConfirmed: newTrucksFilled,
            totalTrucksNeeded: booking.trucksNeeded,
            isFullyFilled: newTrucksFilled >= booking.trucksNeeded,
            booking: { ...booking, trucksFilled: newTrucksFilled, status: newStatus },
            driver, vehicle, transporter
          };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeoutMs: 8000 });
        break;
      } catch (transactionError: unknown) {
        const txCode = transactionError instanceof Error && 'code' in transactionError
          ? (transactionError as { code?: string }).code : undefined;
        const isRetryableContention = txCode === 'P2034' || txCode === '40001';
        if (!isRetryableContention || attempt >= maxTransactionAttempts) throw transactionError;
        incrementAcceptMetric('lockContention');
        logger.warn('[BroadcastAccept] Contention retry', { broadcastId, vehicleId, driverId, attempt, maxAttempts: maxTransactionAttempts, code: txCode });
      }
    }

    if (!txResult) throw new AppError(409, 'INVALID_ASSIGNMENT_STATE', 'Unable to finalize assignment after retries');

    const result: AcceptBroadcastResult = {
      assignmentId: txResult.assignmentId, tripId: txResult.tripId, status: 'assigned',
      trucksConfirmed: txResult.trucksConfirmed, totalTrucksNeeded: txResult.totalTrucksNeeded,
      isFullyFilled: txResult.isFullyFilled,
      resultCode: txResult.replayed ? 'IDEMPOTENT_REPLAY' : 'ASSIGNED',
      replayed: txResult.replayed
    };

    if (txResult.replayed) {
      incrementAcceptMetric('idempotentReplay');
      logger.info('[BroadcastAccept] Replay detected in transaction', { broadcastId, vehicleId, driverId, resultCode: 'IDEMPOTENT_REPLAY' });
    } else {
      incrementAcceptMetric('success');
      const booking = txResult.booking;
      const driver = txResult.driver;
      const vehicle = txResult.vehicle;
      const transporter = txResult.transporter;
      // #96: Capture timestamp once and reuse for DB write and notification payload
      // to ensure both reference the same instant — prevents timestamp drift.
      const eventTimestamp = new Date();
      const now = eventTimestamp.toISOString();
      const pickup = (booking.pickup || {}) as Record<string, unknown>;
      const drop = (booking.drop || {}) as Record<string, unknown>;

      if (driver?.transporterId) {
        redisService.del(`cache:vehicles:transporter:${driver.transporterId}`).catch(() => {});
        // M-15 FIX: Invalidate broadcast list cache so next poll reflects the new truck count.
        // Key pattern matches getActiveBroadcasts() cache: `cache:broadcasts:${transporterId}`
        redisService.del(`cache:broadcasts:${driver.transporterId}`).catch(() => {});
      }

      logger.info('[BroadcastAccept] Success', { broadcastId, vehicleId, driverId, assignmentId: result.assignmentId, tripId: result.tripId, trucksConfirmed: result.trucksConfirmed, totalTrucksNeeded: result.totalTrucksNeeded, resultCode: result.resultCode });

      // =====================================================================
      // FIX Issue #6: Schedule assignment timeout immediately after creation.
      // Industry standard (Uber): Every assignment gets immediate timeout
      // scheduling. Without this, vehicles stay stuck up to 3.5 min until
      // the DB reconciliation catches it.
      // =====================================================================
      try {
        const timeoutMs = HOLD_CONFIG.driverAcceptTimeoutMs;
        await queueService.scheduleAssignmentTimeout({
          assignmentId: result.assignmentId,
          driverId,
          driverName: driver?.name || 'Driver',
          transporterId: driver?.transporterId || '',
          vehicleId,
          vehicleNumber: vehicle?.vehicleNumber || '',
          bookingId: broadcastId,
          tripId: result.tripId,
          createdAt: now,
        }, timeoutMs);
        logger.info('[BroadcastAccept] Assignment timeout scheduled', {
          assignmentId: result.assignmentId,
          timeoutSeconds: timeoutMs / 1000,
        });
      } catch (err) {
        // Non-fatal: L3 DB reconciliation will catch within 2 minutes
        logger.error('[BroadcastAccept] Failed to schedule assignment timeout', {
          assignmentId: result.assignmentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // =====================================================================
      // FIX Issue #7: Wrap post-commit notifications in retry with backoff.
      // Industry standard (Stripe): Post-TX side effects get retry + DLQ.
      // Never fire-and-forget for critical notifications.
      // =====================================================================

      // --- Driver notification (Socket.IO + FCM) with retry ---
      const driverNotification = {
        type: 'trip_assigned', assignmentId: result.assignmentId, tripId: result.tripId,
        bookingId: broadcastId, pickup, drop, vehicleNumber: vehicle?.vehicleNumber || '',
        farePerTruck: booking.pricePerTruck, distanceKm: booking.distanceKm,
        customerName: booking.customerName, customerPhone: booking.customerPhone ? 'X'.repeat(Math.max(0, String(booking.customerPhone).length - 4)) + String(booking.customerPhone).slice(-4) : '',
        assignedAt: now, message: `New trip assigned! ${pickup.address || 'Pickup'} → ${drop.address || 'Drop'}`
      };

      // M-03 FIX: Socket.IO emitted once (best-effort, no retry) to avoid duplicate events.
      // Only FCM is retried — push notifications are idempotent by design.
      emitToUser(driverId, SocketEvent.TRIP_ASSIGNED, driverNotification);
      try {
        await retryWithBackoff(async () => {
          await sendPushNotification(driverId, {
            title: 'New Trip Assigned!',
            body: `${pickup.city || pickup.address || 'Pickup'} → ${drop.city || drop.address || 'Drop'}`,
            data: { type: 'trip_assigned', tripId: result.tripId, assignmentId: result.assignmentId, bookingId: broadcastId, driverName: driver?.name || '', vehicleNumber: vehicle?.vehicleNumber || '', vehicleType: vehicle?.vehicleType || '', status: 'trip_assigned' }
          });
        }, 3, 500);
      } catch (err) {
        logger.error('[BroadcastAccept] All driver notification retries failed', {
          assignmentId: result.assignmentId,
          driverId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Queue for later retry if queue service is available
        try {
          queueService.queuePushNotification(driverId, {
            title: 'New Trip Assigned!',
            body: `${pickup.city || pickup.address || 'Pickup'} → ${drop.city || drop.address || 'Drop'}`,
            priority: 'high', // W0-1: top-level priority drives FCM android.priority; data.priority retained for Android-side client compat.
            data: { type: 'trip_assigned', priority: 'high', tripId: result.tripId, assignmentId: result.assignmentId, bookingId: broadcastId, driverName: driver?.name || '', vehicleNumber: vehicle?.vehicleNumber || '', vehicleType: vehicle?.vehicleType || '', status: 'trip_assigned' }
          }).catch((err) => { logger.warn('[BroadcastAccept] Driver push notification queue failed', { driverId, assignmentId: result.assignmentId, error: err instanceof Error ? err.message : String(err) }); });
        } catch (_queueErr) {
          // Best effort — timeout handler will surface the assignment to the driver
        }
      }

      // --- Customer notification (Socket.IO + FCM) with retry ---
      // #83: This is the SINGLE OWNER of customer acceptance notifications.
      // booking-lifecycle.service.ts incrementTrucksFilled sends BOOKING_UPDATED/FULLY_FILLED
      // which are distinct events (not duplicates). Do NOT add acceptance notifications elsewhere.
      const customerNotification = {
        type: 'truck_confirmed', bookingId: broadcastId, assignmentId: result.assignmentId,
        truckNumber: result.trucksConfirmed, totalTrucksNeeded: booking.trucksNeeded,
        trucksConfirmed: result.trucksConfirmed, remainingTrucks: booking.trucksNeeded - result.trucksConfirmed,
        isFullyFilled: result.isFullyFilled,
        driver: { name: driver?.name || 'Driver', phone: driver?.phone || '' },
        vehicle: { number: vehicle?.vehicleNumber || '', type: vehicle?.vehicleType || booking.vehicleType, subtype: vehicle?.vehicleSubtype || booking.vehicleSubtype },
        transporter: { name: transporter?.name || transporter?.businessName || '', phone: transporter?.phone || '' },
        message: `Truck ${result.trucksConfirmed}/${booking.trucksNeeded} confirmed! ${vehicle?.vehicleNumber || 'Vehicle'} assigned.`
      };

      // M-03 FIX: Socket.IO emitted once (best-effort, no retry) to avoid duplicate events.
      emitToUser(booking.customerId, SocketEvent.TRUCK_CONFIRMED, customerNotification);
      emitToRoom(`booking:${broadcastId}`, SocketEvent.BOOKING_UPDATED, {
        bookingId: broadcastId, status: booking.status,
        trucksFilled: result.trucksConfirmed, trucksNeeded: booking.trucksNeeded,
      });
      try {
        await retryWithBackoff(async () => {
          await sendPushNotification(booking.customerId, {
            title: `Truck ${result.trucksConfirmed}/${booking.trucksNeeded} Confirmed!`,
            body: `${vehicle?.vehicleNumber || 'Vehicle'} (${driver?.name || 'Driver'}) assigned to your booking`,
            data: { type: 'truck_confirmed', bookingId: broadcastId, trucksConfirmed: result.trucksConfirmed, totalTrucks: booking.trucksNeeded }
          });
        }, 3, 500);
      } catch (err) {
        logger.error('[BroadcastAccept] All customer notification retries failed', {
          assignmentId: result.assignmentId,
          customerId: booking.customerId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Queue for later retry if queue service is available
        try {
          queueService.queuePushNotification(booking.customerId, {
            title: `Truck ${result.trucksConfirmed}/${booking.trucksNeeded} Confirmed!`,
            body: `${vehicle?.vehicleNumber || 'Vehicle'} (${driver?.name || 'Driver'}) assigned to your booking`,
            data: { type: 'truck_confirmed', bookingId: broadcastId, trucksConfirmed: String(result.trucksConfirmed), totalTrucks: String(booking.trucksNeeded) }
          }).catch((err) => { logger.warn('[BroadcastAccept] Customer push notification queue failed', { customerId: booking.customerId, bookingId: broadcastId, error: err instanceof Error ? err.message : String(err) }); });
        } catch (_queueErr) {
          // Best effort — customer will see the assignment on next app open
        }
      }
    }

    if (idempotencyCacheKey) {
      try {
        const cachePayload: AcceptBroadcastResult = {
          assignmentId: result.assignmentId, tripId: result.tripId, status: result.status,
          trucksConfirmed: result.trucksConfirmed, totalTrucksNeeded: result.totalTrucksNeeded, isFullyFilled: result.isFullyFilled
        };
        const ACCEPT_IDEMPOTENCY_TTL = parseInt(process.env.ACCEPT_IDEMPOTENCY_TTL || '3600', 10);
        await redisService.setJSON(idempotencyCacheKey, cachePayload, ACCEPT_IDEMPOTENCY_TTL);
      } catch (error: unknown) {
        logger.warn('[BroadcastAccept] Idempotency cache write failed', { broadcastId, vehicleId, driverId, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return result;
  } catch (error: unknown) {
    const code = error instanceof AppError ? error.code : 'INVALID_ASSIGNMENT_STATE';
    incrementAcceptFailureMetric(code);
    logger.warn('[BroadcastAccept] Failed', { broadcastId, vehicleId, driverId, resultCode: code, message: error instanceof Error ? error.message : 'Unknown error' });
    throw error;
  } finally {
    // H-11: Always release the vehicle mutex
    await redisService.releaseLock(vehicleMutexKey, vehicleMutexHolder).catch(() => {});
    if (lockAcquired) {
      try { await redisService.releaseLock(lockKey, lockHolder); }
      catch (error: unknown) { logger.warn('[BroadcastAccept] Lock release failed', { broadcastId, vehicleId, driverId, error: error instanceof Error ? error.message : String(error) }); }
    }
    // M-14 FIX: Release secondary Redis fallback lock
    if (secondaryLockAcquired) {
      const secondaryLockKey = `broadcast-accept-fallback:${broadcastId}`;
      try { await redisService.releaseLock(secondaryLockKey, lockHolder); }
      catch (error: unknown) { logger.warn('[BroadcastAccept] Secondary lock release failed', { broadcastId, error: error instanceof Error ? error.message : String(error) }); }
    }
    // H-02 FIX: Release in-process fallback lock
    if (resolveInProcessLock) {
      inProcessLocks.delete(lockKey);
      resolveInProcessLock();
    }
  }
}

export async function declineBroadcast(broadcastId: string, params: DeclineBroadcastParams) {
  const { actorId, reason, notes } = params;

  // CRITICAL #21: Verify the broadcast exists and actor was notified.
  // Performance optimization: the broadcast system already maintains a Redis set
  // `broadcast:notified:{bookingId}` via sAddWithExpire during dispatch. Use O(1)
  // sIsMember to avoid a DB round-trip on every decline. Fall back to DB only
  // when the Redis key is missing (expired or Redis unavailable).
  let actorVerified = false;
  let broadcastVerified = false;

  const notifiedSetKey = RADIUS_KEYS.NOTIFIED_SET(broadcastId);
  try {
    const setSize = await redisService.sCard(notifiedSetKey);
    if (setSize > 0) {
      // Redis set exists and is populated -- use O(1) membership check
      actorVerified = await redisService.sIsMember(notifiedSetKey, actorId);
      broadcastVerified = true; // Set exists means broadcast was dispatched
      if (!actorVerified) {
        logger.warn(`[Broadcast] Decline attempt by non-notified actor ${actorId} for broadcast ${broadcastId}`);
        throw new AppError(403, 'NOT_AUTHORIZED', 'You were not notified for this broadcast');
      }
    }
  } catch (err: unknown) {
    if (err instanceof AppError) throw err;
    // Redis unavailable or key expired -- fall through to DB
    logger.warn('[declineBroadcast] Redis notified-set check failed, falling back to DB', {
      broadcastId, actorId, error: err instanceof Error ? err.message : String(err),
    });
  }

  // DB fallback: Redis set expired or unavailable
  if (!broadcastVerified) {
    const booking = await prismaClient.booking.findFirst({
      where: { id: broadcastId },
      select: { id: true, notifiedTransporters: true, status: true },
    });

    if (!booking) {
      throw new AppError(404, 'BROADCAST_NOT_FOUND', 'Broadcast does not exist');
    }

    // M-02 FIX: Short-circuit if booking is already in a terminal state — no work to do
    if (['cancelled', 'expired', 'completed', 'fully_filled'].includes(booking.status)) {
      return { success: true, replayed: false, alreadyTerminal: true };
    }

    // Verify actor was in the notified list (skip check if list is empty for backward compat)
    const notified = Array.isArray(booking.notifiedTransporters) ? booking.notifiedTransporters : [];
    if (notified.length > 0 && !notified.includes(actorId)) {
      logger.warn(`[Broadcast] Decline attempt by non-notified actor ${actorId} for broadcast ${broadcastId}`);
      throw new AppError(403, 'NOT_AUTHORIZED', 'You were not notified for this broadcast');
    }
  }

  const declineKey = `broadcast:declined:${broadcastId}`;
  let isReplay = false;
  try {
    const added = await redisService.sAdd(declineKey, actorId);
    isReplay = added === 0;
  } catch (err: unknown) {
    logger.warn('[declineBroadcast] Redis sAdd failed', { broadcastId, actorId, error: err instanceof Error ? err.message : String(err) });
  }
  await redisService.expire(declineKey, 3600).catch(() => {});

  try {
    const declineHashKey = `broadcast:decline_log:${broadcastId}`;
    const declineEntry = JSON.stringify({
      transporterId: actorId, reason, notes: notes || null, declinedAt: new Date().toISOString(),
    });
    await redisService.hSet(declineHashKey, actorId, declineEntry);
    await redisService.expire(declineHashKey, 86400);
  } catch (dbErr: unknown) {
    logger.warn('[Broadcast] Decline durable persist failed', { broadcastId, transporterId: actorId, error: dbErr instanceof Error ? dbErr.message : String(dbErr) });
  }

  logger.info(`Broadcast ${broadcastId} declined by ${actorId}. Reason: ${reason}`, { notes, declineTracked: true, replayed: isReplay });
  return { success: true, replayed: isReplay };
}
