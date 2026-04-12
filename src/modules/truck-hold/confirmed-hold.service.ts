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
import { prismaClient, HoldPhase, AssignmentStatus } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { socketService } from '../../shared/services/socket.service';
import { queueService } from '../../shared/services/queue.service';
import { holdExpiryCleanupService } from '../hold-expiry/hold-expiry-cleanup.service';
import { releaseVehicle } from '../../shared/services/vehicle-lifecycle.service';
import { HOLD_CONFIG } from '../../core/config/hold-config';

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
  ): Promise<{ success: boolean; message: string; confirmedExpiresAt?: Date; missingAssignmentIds?: string[] }> {
    logger.info('[CONFIRMED HOLD] Initializing confirmed hold', {
      holdId,
      transporterId,
      assignmentsCount: assignments.length,
    });

    try {
      // Fix M-8: Phase guard -- prevent double initialization
      // FIX-6: Also fetch transporterId for ownership check
      const existing = await prismaClient.truckHoldLedger.findUnique({
        where: { holdId },
        select: { phase: true, confirmedExpiresAt: true, transporterId: true }
      });

      if (!existing) {
        return { success: false, message: 'Hold not found' };
      }

      // FIX-6: Ownership verification — only the transporter who created the hold can confirm it
      if (existing.transporterId !== transporterId) {
        logger.warn('[CONFIRMED HOLD] Ownership check failed for initializeConfirmedHold', {
          holdId,
          requestedBy: transporterId,
          ownedBy: existing.transporterId,
        });
        return { success: false, message: 'Not your hold' };
      }

      if (existing.phase === HoldPhase.CONFIRMED) {
        logger.info('[CONFIRMED HOLD] Already initialized, returning existing', { holdId });
        return {
          success: true,
          message: 'Already in CONFIRMED phase (idempotent)',
          confirmedExpiresAt: existing.confirmedExpiresAt ?? undefined,
        };
      }

      if (existing.phase !== HoldPhase.FLEX) {
        return {
          success: false,
          message: `Cannot move to CONFIRMED from ${existing.phase} -- must be FLEX`
        };
      }

      const now = new Date();
      const confirmedExpiresAt = new Date(
        now.getTime() + this.config.maxDurationSeconds * 1000
      );

      // Update hold to confirmed phase
      const updated = await prismaClient.truckHoldLedger.update({
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

      // Schedule expiry cleanup job (Layer 1)
      await holdExpiryCleanupService.scheduleConfirmedHoldCleanup(holdId, confirmedExpiresAt);
      logger.debug('[CONFIRMED HOLD] Cleanup job scheduled', { holdId });

      // ================================================================
      // FIX #3: Fetch full assignment data with driver and vehicle info
      // ================================================================
      const assignmentIds = assignments.map(a => a.assignmentId);

      const assignmentsData = await prismaClient.assignment.findMany({
        where: {
          id: { in: assignmentIds }
        },
        select: {
          id: true,
          driverId: true,
          driverName: true,
          transporterId: true,
          vehicleId: true,
          vehicleNumber: true,
          tripId: true,
          orderId: true,
          truckRequestId: true,
        }
      });

      // Create a map for quick lookup
      const assignmentMap = new Map(
        assignmentsData.map(a => [a.id, a])
      );

      // Schedule driver acceptance timeouts with full data
      const missingIds: string[] = [];
      for (const assignment of assignments) {
        const fullData = assignmentMap.get(assignment.assignmentId);

        if (!fullData) {
          missingIds.push(assignment.assignmentId);
          continue;
        }

        // FIX-39: Pass the operation-level `now` timestamp for consistency
        await this.scheduleDriverAcceptanceTimeout(
          assignment.assignmentId,
          fullData,
          this.config.driverAcceptTimeoutSeconds,
          now
        );
      }

      if (missingIds.length > 0) {
        logger.warn('[CONFIRMED HOLD] Some assignments not found', { missingIds });
      }

      logger.info('[CONFIRMED HOLD] Confirmed hold initialized', {
        holdId,
        confirmedExpiresAt,
      });

      return {
        success: true,
        message: 'Confirmed hold initialized',
        confirmedExpiresAt,
        missingAssignmentIds: missingIds.length > 0 ? missingIds : undefined,
      };
    } catch (error: any) {
      logger.error('[CONFIRMED HOLD] Failed to initialize confirmed hold', {
        error: error.message,
        holdId,
      });

      return {
        success: false,
        message: 'Failed to initialize confirmed hold',
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

        // CAS guard: only accept if assignment is still pending
        const updated = await prismaClient.assignment.updateMany({
          where: {
            id: assignmentId,
            driverId,
            status: AssignmentStatus.pending,  // CAS precondition
          },
          data: {
            status: AssignmentStatus.driver_accepted,
            driverAcceptedAt: nowIso,
          },
        });

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
        try {
          const { applyPostAcceptSideEffects } = require('../assignment/post-accept.effects');
          await applyPostAcceptSideEffects({
            assignmentId,
            driverId: assignment.driverId,
            vehicleId: assignment.vehicleId,
            vehicleNumber: assignment.vehicleNumber,
            tripId: assignment.tripId,
            bookingId: assignment.orderId, // TruckRequest.bookingId maps to orderId in the Order system (legacy naming)
            transporterId: assignment.transporterId,
            driverName: assignment.driverName || 'Driver',
          });
        } catch (effectsErr: any) {
          logger.warn('[CONFIRMED HOLD] Post-accept side effects failed (non-fatal)', {
            assignmentId, error: effectsErr?.message,
          });
        }

        // FIX #25: FK traversal — resolve Assignment → TruckRequest relationship
        // Previously queried truckRequest.id = assignmentId (wrong entity), always returned null.
        // Now we first find the Assignment's truckRequestId, then look up the TruckRequest.
        const assignmentRecord = await prismaClient.assignment.findUnique({
          where: { id: assignmentId },
          select: { truckRequestId: true, orderId: true },
        });

        const holdRecord = assignmentRecord?.truckRequestId
          ? await prismaClient.truckRequest.findFirst({
              where: { id: assignmentRecord.truckRequestId },
              select: { id: true, orderId: true },
            })
          : null;

        // Determine the orderId from holdRecord or directly from the assignment
        const resolvedOrderId = holdRecord?.orderId ?? assignmentRecord?.orderId;

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
        await redisService.releaseLock(lockKey, lockHolder).catch(() => {});
      }
    } catch (error: any) {
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
        // CAS guard: only decline if assignment is still pending
        const updated = await prismaClient.assignment.updateMany({
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

        // FIX #41 + FK traversal: Resolve Assignment → TruckRequest via FK chain
        // (mirrors FIX #25 pattern from handleDriverAcceptance)
        const assignmentRecord = await prismaClient.assignment.findUnique({
          where: { id: assignmentId },
          select: { truckRequestId: true, orderId: true },
        });

        const truckRequest = assignmentRecord?.truckRequestId
          ? await prismaClient.truckRequest.findFirst({
              where: { id: assignmentRecord.truckRequestId },
              select: { id: true, orderId: true },
            })
          : null;

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

        // Update confirmed hold state — resolve orderId from FK chain
        const resolvedOrderId = truckRequest?.orderId ?? assignmentRecord?.orderId;

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

        // P6 fix: Release vehicle back to available (Saga compensation)
        if (assignment.vehicleId) {
          await releaseVehicle(assignment.vehicleId, 'confirmedHoldDecline').catch((err: any) => {
            logger.warn('[CONFIRMED HOLD] Vehicle release on decline failed (non-fatal)', {
              vehicleId: assignment.vehicleId, error: err?.message,
            });
          });
        }

        // P6 fix: Decrement trucksFilled with floor at 0
        if (assignment.orderId) {
          await prismaClient.$executeRaw`
            UPDATE "Order" SET "trucksFilled" = GREATEST(0, "trucksFilled" - 1), "updatedAt" = NOW()
            WHERE "id" = ${assignment.orderId}
          `.catch((err: any) => {
            logger.warn('[CONFIRMED HOLD] trucksFilled decrement on decline failed (non-fatal)', {
              orderId: assignment.orderId, error: err?.message,
            });
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
        await redisService.releaseLock(lockKey, lockHolder).catch(() => {});
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
}

// =============================================================================
// EXPORT SINGLETON
// =============================================================================

export const confirmedHoldService = new ConfirmedHoldService({
  maxDurationSeconds: HOLD_CONFIG.confirmedHoldMaxSeconds,
  driverAcceptTimeoutSeconds: HOLD_CONFIG.driverAcceptTimeoutSeconds,
});
