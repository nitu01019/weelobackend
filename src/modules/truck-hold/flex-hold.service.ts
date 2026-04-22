/**
 * FLEX HOLD SERVICE — Phase 1 of two-phase hold system (CURRENT)
 *
 * Phase 1 (Flex): 90s base + up to 3 extensions of 30s (max 130s total)
 * Phase 2 (Confirmed): See confirmed-hold.service.ts (180s with driver windows)
 *
 * Used by: Order path (POST /truck-hold/flex-hold)
 * Industry pattern: BookMyShow seat hold (select -> pay)
 */

/**
 * =============================================================================
 * FLEX HOLD PHASE 1 SERVICE - Two-Phase Truck Hold System
 * =============================================================================
 *
 * PHASE 1 (FLEX) - PRD 7777:
 * - 90s base hold duration
 * - Auto-extend +30s per driver assignment (max 3 extensions)
 * - Max 130s total duration (90s + 3×30s but capped at 130s per PRD)
 * - Trucks reserved but not locked
 * - Can be released without penalty
 * - Transitions to CONFIRMED (Phase 2) on confirmation
 *
 * CONFIGURATION:
 * - FLEX_HOLD_DURATION_SECONDS = 90 (base time)
 * - FLEX_HOLD_EXTENSION_SECONDS = 30 (per driver assigned)
 * - FLEX_HOLD_MAX_DURATION_SECONDS = 130 (max total)
 * - FLEX_HOLD_MAX_EXTENSIONS = 3 (max number of extensions)
 *
 * FLOW:
 * 1. Transporter creates flex hold → 90s timer starts
 * 2. Transporter assigns driver → +30s extension, extension count++
 * 3. Transporter confirms → Move to CONFIRMED (Phase 2)
 * 4. Max extensions reached → No more extensions possible
 * 5. Timeout → Hold expires, trucks released
 *
 * @author Weelo Team
 * @version 1.0.0 (PRD 7777 Implementation)
 * =============================================================================
 */

import { v4 as uuidv4 } from 'uuid';
import { Prisma } from '@prisma/client';
import { prismaClient, withDbTimeout, HoldPhase } from '../../shared/database/prisma.service';
import { HOLD_CONFIG } from '../../core/config/hold-config';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { socketService } from '../../shared/services/socket.service';
import { holdExpiryCleanupService } from '../hold-expiry/hold-expiry-cleanup.service';
import { validateActorEligibility, HoldEligibilityError } from './hold-eligibility';
import { metrics } from '../../shared/monitoring/metrics.service';
import { guardedConfirmFlexToConfirmed } from './hold-state-machine';

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

/**
 * Flex hold configuration
 */
export interface FlexHoldConfig {
  baseDurationSeconds: number;
  extensionSeconds: number;
  maxDurationSeconds: number;
  maxExtensions: number;
}

/**
 * Flex hold state
 */
export interface FlexHoldState {
  holdId: string;
  orderId: string;
  transporterId: string;
  phase: HoldPhase;
  baseExpiresAt: Date;
  currentExpiresAt: Date;
  extendedCount: number;
  canExtend: boolean;
  totalDurationSeconds: number;
  remainingSeconds: number;
}

/**
 * Flex hold creation request
 */
export interface CreateFlexHoldRequest {
  orderId: string;
  transporterId: string;
  vehicleType: string;
  vehicleSubtype: string;
  quantity: number;
  truckRequestIds: string[];
}

/**
 * Flex hold creation response
 */
export interface FlexHoldResponse {
  success: boolean;
  holdId?: string;
  phase?: HoldPhase;
  expiresAt?: Date;
  remainingSeconds?: number;
  canExtend?: boolean;
  message: string;
  error?: string;
}

/**
 * Extend hold request
 */
export interface ExtendFlexHoldRequest {
  holdId: string;
  reason: string;
  driverId?: string;
  assignmentId?: string;
}

/**
 * Extend hold response
 */
export interface ExtendHoldHoldResponse {
  success: boolean;
  newExpiresAt?: Date;
  addedSeconds?: number;
  extendedCount?: number;
  canExtend?: boolean;
  message: string;
  error?: string;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

const DEFAULT_CONFIG: FlexHoldConfig = {
  baseDurationSeconds: HOLD_CONFIG.flexHoldDurationSeconds,
  extensionSeconds: HOLD_CONFIG.flexHoldExtensionSeconds,
  maxDurationSeconds: HOLD_CONFIG.flexHoldMaxDurationSeconds,
  maxExtensions: HOLD_CONFIG.flexHoldMaxExtensions,
};

// Redis keys for distributed locking
const REDIS_KEYS = {
  // Standardized: lock: prefix for all distributed locks (added by acquireLock automatically)
  FLEX_HOLD_LOCK: (holdId: string) => `flex-hold:${holdId}`,
  // P4 F2.5: Stable per-(order,transporter) create lock — acquired BEFORE the dedup
  // findFirst so two concurrent create-flex-hold requests for the same pair serialize
  // at the lock boundary rather than both seeing "no existing hold" and racing to create.
  FLEX_HOLD_CREATE_LOCK: (orderId: string, transporterId: string) =>
    `flex-hold:create:${orderId}:${transporterId}`,
  FLEX_HOLD_STATE: (holdId: string) => `flex-hold:${holdId}:state`,
  FLEX_HOLD_EXTENSIONS: (holdId: string) => `flex-hold:${holdId}:extensions`,
};

// =============================================================================
// FLEX HOLD SERVICE
// =============================================================================

class FlexHoldService {
  private config: FlexHoldConfig;

  constructor(config: Partial<FlexHoldConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Create a new flex hold (Phase 1)
   */
  async createFlexHold(request: CreateFlexHoldRequest): Promise<FlexHoldResponse> {
    logger.info('[FLEX HOLD] Creating flex hold', {
      orderId: request.orderId,
      transporterId: request.transporterId,
      quantity: request.quantity,
    });

    // P4 F2.5: Acquire per-(order,transporter) distributed lock BEFORE the dedup
    // findFirst to close the TOCTOU window where two concurrent requests both
    // observed "no existing hold" and raced to create duplicate ledger rows.
    // Lock key is stable across the request (does NOT depend on the not-yet-
    // generated holdId) so concurrent callers actually contend on the same key.
    const createLockKey = REDIS_KEYS.FLEX_HOLD_CREATE_LOCK(
      request.orderId,
      request.transporterId,
    );
    const createLockHolder = `flex-hold-create:${uuidv4()}`;
    const createLock = await redisService.acquireLock(createLockKey, createLockHolder, 30);
    if (!createLock.acquired) {
      return {
        success: false,
        message: 'Another flex-hold request is in flight for this order+transporter. Retry shortly.',
        error: 'LOCK_ACQUISITION_FAILED',
      };
    }

    try {
      // P4 F2.NEW-3: Dedup findFirst + create inside a Serializable tx with a
      // pessimistic FOR UPDATE on any non-terminal hold for this (orderId,
      // transporterId) pair. Combined with the DB-level partial unique index
      // (migrations/M-015-flex-hold-dedup-partial-index.sql), concurrent creates
      // are impossible even if the Redis create lock above fails.
      const dedupOrCreate = await withDbTimeout(async (tx) => {
        // P4 F2.NEW-3: pessimistic lock on any existing non-terminal hold for
        // this (orderId, transporterId) — a no-op on first-creator but blocks
        // any sibling tx from racing past this point.
        await tx.$queryRaw`
          SELECT "holdId" FROM "TruckHoldLedger"
          WHERE "orderId" = ${request.orderId}
            AND "transporterId" = ${request.transporterId}
            AND "phase" NOT IN ('EXPIRED', 'RELEASED')
          FOR UPDATE
        `;

        // M-22 FIX (hardened by F2.NEW-3): Dedup — return existing active flex
        // hold if one already exists for this order+transporter combination.
        // Now runs INSIDE the serializable tx with the FOR UPDATE above so the
        // read is pessimistically consistent.
        const existingHold = await tx.truckHoldLedger.findFirst({
          where: {
            orderId: request.orderId,
            transporterId: request.transporterId,
            status: 'active',
            phase: HoldPhase.FLEX,
          },
        });

        if (existingHold) {
          return { kind: 'existing' as const, hold: existingHold };
        }

        // AB-2 fix: Reject hold creation if the parent broadcast/order has expired.
        // Prevents stale broadcasts from locking trucks after expiry.
        // F-C-50: Also select customerId so we can mirror `flex_hold_started` to the customer room.
        const parentOrder = await tx.order.findUnique({
          where: { id: request.orderId },
          select: { expiresAt: true, status: true, customerId: true },
        });
        if (!parentOrder) {
          return {
            kind: 'error' as const,
            message: 'Order not found. Cannot create hold for a non-existent order.',
            errorCode: 'ORDER_NOT_FOUND',
          };
        }
        if (new Date(parentOrder.expiresAt).getTime() < Date.now()) {
          return {
            kind: 'error' as const,
            message: 'Cannot create hold — broadcast has expired.',
            errorCode: 'BROADCAST_EXPIRED',
          };
        }
        if (
          parentOrder.status === 'cancelled' ||
          parentOrder.status === 'expired' ||
          parentOrder.status === 'completed'
        ) {
          return {
            kind: 'error' as const,
            message: `Cannot create hold — order is ${parentOrder.status}.`,
            errorCode: 'ORDER_TERMINAL',
          };
        }

        // F-A-75: KYC+isActive re-check uses SELECT ... FOR UPDATE on the User
        // row (inside validateActorEligibility) so admin revoke/suspend serializes
        // against this path.
        await validateActorEligibility(tx, request.transporterId, 'flex_hold');

        const now = new Date();
        const holdDurationMs = this.config.baseDurationSeconds * 1000;
        // AB3: Cap hold lifetime to broadcast/order remaining time.
        // A hold must never outlive its parent broadcast.
        const broadcastRemainingMs =
          new Date(parentOrder.expiresAt).getTime() - now.getTime();
        const cappedDurationMs =
          broadcastRemainingMs > 0
            ? Math.min(holdDurationMs, broadcastRemainingMs)
            : holdDurationMs;
        const baseExpiresAt = new Date(now.getTime() + cappedDurationMs);
        const newHoldId = uuidv4();

        const created = await tx.truckHoldLedger.create({
          data: {
            holdId: newHoldId,
            orderId: request.orderId,
            transporterId: request.transporterId,
            vehicleType: request.vehicleType,
            vehicleSubtype: request.vehicleSubtype,
            quantity: request.quantity,
            truckRequestIds: request.truckRequestIds,
            status: 'active',
            phase: HoldPhase.FLEX,
            phaseChangedAt: now,
            flexExpiresAt: baseExpiresAt,
            flexExtendedCount: 0,
            expiresAt: baseExpiresAt,
            createdAt: now,
          },
        });

        return {
          kind: 'created' as const,
          hold: created,
          now,
          baseExpiresAt,
          customerId: parentOrder.customerId,
        };
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeoutMs: 5_000,
        site: 'flex_hold_create',
      });

      if (dedupOrCreate.kind === 'existing') {
        const existingHold = dedupOrCreate.hold;
        const remainingSeconds = Math.max(
          0,
          Math.floor((existingHold.expiresAt.getTime() - Date.now()) / 1000),
        );
        logger.info('[FLEX HOLD] Returning existing active hold (dedup)', {
          holdId: existingHold.holdId,
          orderId: request.orderId,
          transporterId: request.transporterId,
        });
        return {
          success: true,
          holdId: existingHold.holdId,
          phase: HoldPhase.FLEX,
          expiresAt: existingHold.expiresAt,
          remainingSeconds,
          canExtend:
            (existingHold.flexExtendedCount || 0) < this.config.maxExtensions,
          message: `Existing flex hold returned. Expires in ${remainingSeconds} seconds.`,
        };
      }

      if (dedupOrCreate.kind === 'error') {
        return {
          success: false,
          message: dedupOrCreate.message,
          error: dedupOrCreate.errorCode,
        };
      }

      const { hold, baseExpiresAt, customerId } = dedupOrCreate;
      const holdId = hold.holdId;

      // Cache state in Redis for fast access
      await this.cacheFlexHoldState(holdId, {
        holdId,
        orderId: request.orderId,
        transporterId: request.transporterId,
        phase: HoldPhase.FLEX,
        baseExpiresAt,
        currentExpiresAt: baseExpiresAt,
        extendedCount: 0,
        canExtend: true,
        totalDurationSeconds: this.config.baseDurationSeconds,
        remainingSeconds: this.config.baseDurationSeconds,
      });

      // Schedule expiry cleanup
      await this.scheduleExpiryCheck(holdId, baseExpiresAt);

      logger.info('[FLEX HOLD] Flex hold created', {
        holdId,
        expiresAt: baseExpiresAt,
      });

      // F-C-50: Emit `flex_hold_started` to transporter so captain UI has a
      // reliable kick-off signal (REST-only today means a lost HTTP response
      // leaves the UI stuck). Mirror to customer room for lifecycle parity
      // with the existing `flex_hold_extended` emit pattern.
      const flexHoldStartedPayload = {
        holdId,
        orderId: request.orderId,
        phase: 'FLEX' as const,
        expiresAt: baseExpiresAt.toISOString(),
        baseDurationSeconds: this.config.baseDurationSeconds,
        canExtend: true,
        maxExtensions: this.config.maxExtensions,
      };
      await socketService.emitToUser(
        request.transporterId,
        'flex_hold_started',
        flexHoldStartedPayload,
      );
      if (customerId) {
        await socketService.emitToUser(
          customerId,
          'flex_hold_started',
          flexHoldStartedPayload,
        );
      }

      return {
        success: true,
        holdId,
        phase: HoldPhase.FLEX,
        expiresAt: baseExpiresAt,
        remainingSeconds: this.config.baseDurationSeconds,
        canExtend: true,
        message: `Flex hold created. Expires in ${this.config.baseDurationSeconds} seconds.`,
      };
    } catch (error: any) {
      // F-A-75: bubble KYC / isActive eligibility failures with a distinct error code.
      if (error instanceof HoldEligibilityError) {
        logger.warn('[FLEX HOLD] Eligibility denied', {
          code: error.code,
          transporterId: request.transporterId,
          orderId: request.orderId,
        });
        return {
          success: false,
          message: error.message,
          error: error.code,
        };
      }
      // P4 F2.NEW-3: Unique-violation on the partial unique index means a concurrent
      // writer won the create race. Treat as idempotent — return the winning row.
      if (error?.code === 'P2002') {
        logger.info('[FLEX HOLD] Unique-violation on create race — returning winning hold', {
          orderId: request.orderId,
          transporterId: request.transporterId,
        });
        const winner = await prismaClient.truckHoldLedger.findFirst({
          where: {
            orderId: request.orderId,
            transporterId: request.transporterId,
            status: 'active',
            phase: HoldPhase.FLEX,
          },
        });
        if (winner) {
          const remainingSeconds = Math.max(
            0,
            Math.floor((winner.expiresAt.getTime() - Date.now()) / 1000),
          );
          return {
            success: true,
            holdId: winner.holdId,
            phase: HoldPhase.FLEX,
            expiresAt: winner.expiresAt,
            remainingSeconds,
            canExtend:
              (winner.flexExtendedCount || 0) < this.config.maxExtensions,
            message: `Existing flex hold returned. Expires in ${remainingSeconds} seconds.`,
          };
        }
      }
      logger.error('[FLEX HOLD] Failed to create flex hold', {
        error: error.message,
        orderId: request.orderId,
      });

      return {
        success: false,
        message: 'Failed to create flex hold',
        error: error.message,
      };
    } finally {
      await redisService
        .releaseLock(createLockKey, createLockHolder)
        .catch(() => {});
    }
  }

  /**
   * Extend flex hold (called when driver is assigned)
   */
  async extendFlexHold(request: ExtendFlexHoldRequest): Promise<ExtendHoldHoldResponse> {
    logger.info('[FLEX HOLD] Extending flex hold', {
      holdId: request.holdId,
      reason: request.reason,
    });

    const lockKey = REDIS_KEYS.FLEX_HOLD_LOCK(request.holdId);
    const lock = await redisService.acquireLock(lockKey, 'flex-hold-extension', 10);

    if (!lock.acquired) {
      return {
        success: false,
        message: 'Could not acquire lock for hold extension',
        error: 'LOCK_ACQUISITION_FAILED',
      };
    }

    try {
      // Get current hold state
      const holdLedger = await prismaClient.truckHoldLedger.findUnique({
        where: { holdId: request.holdId },
      });

      if (!holdLedger) {
        return {
          success: false,
          message: 'Hold not found',
          error: 'HOLD_NOT_FOUND',
        };
      }

      // Check if in FLEX phase
      if (holdLedger.phase !== HoldPhase.FLEX) {
        return {
          success: false,
          message: `Hold is in ${holdLedger.phase} phase, cannot extend`,
          error: 'INVALID_PHASE',
        };
      }

      // Check if flex hold has expired
      if (holdLedger.flexExpiresAt && new Date() > holdLedger.flexExpiresAt) {
        return {
          success: false,
          message: 'Flex hold has expired',
          error: 'HOLD_EXPIRED',
        };
      }

      // Check if max extensions reached
      const currentExtendedCount = holdLedger.flexExtendedCount || 0;
      if (currentExtendedCount >= this.config.maxExtensions) {
        return {
          success: false,
          message: 'Maximum extensions reached',
          error: 'MAX_EXTENSIONS_REACHED',
        };
      }

      // Calculate new expiry time
      const now = new Date();
      const currentExpiry = holdLedger.flexExpiresAt || holdLedger.expiresAt;

      // Calculate new expiry, ensuring it doesn't exceed max duration
      const creationTime = holdLedger.createdAt;
      const elapsedTime = (now.getTime() - creationTime.getTime()) / 1000;
      const newTotalDuration = Math.min(
        elapsedTime + this.config.extensionSeconds,
        this.config.maxDurationSeconds
      );

      let newExpiresAt = new Date(creationTime.getTime() + newTotalDuration * 1000);

      // AB3: Cap extended hold lifetime to broadcast/order remaining time.
      const parentOrder = await prismaClient.order.findUnique({
        where: { id: holdLedger.orderId },
        select: { expiresAt: true },
      });
      if (parentOrder) {
        const broadcastExpiresAtMs = new Date(parentOrder.expiresAt).getTime();
        if (newExpiresAt.getTime() > broadcastExpiresAtMs) {
          newExpiresAt = new Date(broadcastExpiresAtMs);
        }
      }
      const addedSeconds = Math.floor(newExpiresAt.getTime() - currentExpiry.getTime()) / 1000;

      // FIX #40: Floor guard — if extension would add 0 seconds (hold already at max), return explicit failure
      // instead of misleading success with addedSeconds: 0.
      if (addedSeconds <= 0) {
        return {
          success: false,
          message: 'Hold is already at maximum duration',
          error: 'MAX_DURATION_REACHED',
        };
      }

      // Calculate total duration for logging
      const totalDurationSeconds = Math.floor((newExpiresAt.getTime() - creationTime.getTime()) / 1000);

      // Update hold in database
      const updatedHold = await prismaClient.truckHoldLedger.update({
        where: { holdId: request.holdId },
        data: {
          flexExpiresAt: newExpiresAt,
          flexExtendedCount: currentExtendedCount + 1,
          expiresAt: newExpiresAt,
          updatedAt: now,
        },
      });

      // Update Redis cache
      await this.cacheFlexHoldState(request.holdId, {
        holdId: request.holdId,
        orderId: holdLedger.orderId,
        transporterId: holdLedger.transporterId,
        phase: HoldPhase.FLEX,
        baseExpiresAt: creationTime,
        currentExpiresAt: newExpiresAt,
        extendedCount: currentExtendedCount + 1,
        canExtend: currentExtendedCount + 1 < this.config.maxExtensions,
        totalDurationSeconds,
        remainingSeconds: Math.floor((newExpiresAt.getTime() - now.getTime()) / 1000),
      });

      // Emit socket event to transporter for UI transparency
      const totalRemainingSeconds = Math.ceil((newExpiresAt.getTime() - now.getTime()) / 1000);
      await socketService.emitToUser(holdLedger.transporterId, 'flex_hold_extended', {
        holdId: request.holdId,
        orderId: holdLedger.orderId,
        newExpiresAt: newExpiresAt.toISOString(),
        totalRemainingSeconds,                       // PRIMARY: absolute remaining time
        extendedCount: currentExtendedCount + 1,     // Total extensions so far
        addedSeconds,                                // DEPRECATED: delta — use totalRemainingSeconds
        maxExtensions: this.config.maxExtensions,
        canExtend: currentExtendedCount + 1 < this.config.maxExtensions,
        message: `${addedSeconds}s added to hold timer`,
        reason: request.reason,
        driverId: request.driverId,
        assignmentId: request.assignmentId,
      });

      logger.info('[FLEX HOLD] Flex hold extended', {
        holdId: request.holdId,
        addedSeconds,
        extendedCount: currentExtendedCount + 1,
        newExpiresAt,
      });

      return {
        success: true,
        newExpiresAt,
        addedSeconds,
        extendedCount: currentExtendedCount + 1,
        canExtend: currentExtendedCount + 1 < this.config.maxExtensions,
        message: `Hold extended by ${addedSeconds}s. New expiry: ${newExpiresAt.toISOString()}`,
      };
    } catch (error: any) {
      logger.error('[FLEX HOLD] Failed to extend flex hold', {
        error: error.message,
        holdId: request.holdId,
      });

      return {
        success: false,
        message: 'Failed to extend flex hold',
        error: error.message,
      };
    } finally {
      // P4 F2.3: surface Redis lock release failures instead of silently swallowing.
      // Lock will expire via TTL, but invisible failures mask Redis connectivity issues.
      await redisService
        .releaseLock(lockKey, 'flex-hold-extension')
        .catch((err: unknown) => {
          logger.warn('redis_lock_release_failed', {
            op: 'flex_hold_extend',
            err: err instanceof Error ? err.message : String(err),
          });
          metrics.incrementCounter('redis_lock_release_failed_total', {
            op: 'flex_hold_extend',
          });
        });
    }
  }

  /**
   * Get flex hold state
   */
  async getFlexHoldState(holdId: string): Promise<FlexHoldState | null> {
    try {
      // Try Redis first (fast path)
      const cached = await redisService.getJSON<FlexHoldState>(
        REDIS_KEYS.FLEX_HOLD_STATE(holdId)
      );
      if (cached) {
        return cached;
      }

      // Fall back to database
      const holdLedger = await prismaClient.truckHoldLedger.findUnique({
        where: { holdId },
      });

      if (!holdLedger || holdLedger.phase !== HoldPhase.FLEX) {
        return null;
      }

      const now = new Date();
      const expiresAt = holdLedger.flexExpiresAt || holdLedger.expiresAt;
      const remainingSeconds = Math.max(
        0,
        Math.floor((expiresAt.getTime() - now.getTime()) / 1000)
      );
      const totalDurationSeconds = Math.floor(
        (expiresAt.getTime() - holdLedger.createdAt.getTime()) / 1000
      );

      const state: FlexHoldState = {
        holdId,
        orderId: holdLedger.orderId,
        transporterId: holdLedger.transporterId,
        phase: HoldPhase.FLEX,
        baseExpiresAt: holdLedger.flexExpiresAt || holdLedger.expiresAt,
        currentExpiresAt: holdLedger.flexExpiresAt || holdLedger.expiresAt,
        extendedCount: holdLedger.flexExtendedCount || 0,
        canExtend: (holdLedger.flexExtendedCount || 0) < this.config.maxExtensions,
        totalDurationSeconds,
        remainingSeconds,
      };

      // Cache for future queries
      await this.cacheFlexHoldState(holdId, state);

      return state;
    } catch (error: any) {
      logger.error('[FLEX HOLD] Failed to get flex hold state', {
        error: error.message,
        holdId,
      });
      return null;
    }
  }

  /**
   * Check if flex hold can be extended
   */
  async canExtendFlexHold(holdId: string): Promise<boolean> {
    const state = await this.getFlexHoldState(holdId);
    return state ? state.canExtend : false;
  }

  /**
   * Transition flex hold to confirmed (Phase 2)
   * FIX-6: Added transporterId ownership check to prevent another transporter
   * from confirming a hold they don't own.
   */
  async transitionToConfirmed(holdId: string, transporterId: string): Promise<{ success: boolean; message: string }> {
    logger.info('[FLEX HOLD] Transitioning to confirmed phase', { holdId, transporterId });

    try {
      // A10-005 + A02-001: withDbTimeout (Serializable, bounded wait) + FOR UPDATE row-lock
      // serialises concurrent transitioners, and guardedConfirmFlexToConfirmed CAS ensures
      // exactly one winner on the phase flip — eliminates the double-confirm race.
      const result = await withDbTimeout(async (tx) => {
        const rows = await tx.$queryRaw<Array<{
          holdId: string; phase: string; transporterId: string; orderId: string;
        }>>`
          SELECT "holdId", "phase", "transporterId", "orderId"
          FROM "TruckHoldLedger"
          WHERE "holdId" = ${holdId}
          FOR UPDATE
        `;
        const hold = rows[0];
        if (!hold) {
          return { success: false, message: 'Hold not found' };
        }
        if (hold.transporterId !== transporterId) {
          logger.warn('[FLEX HOLD] Ownership check failed for transitionToConfirmed', {
            holdId, requestedBy: transporterId, ownedBy: hold.transporterId,
          });
          return { success: false, message: 'Not your hold' };
        }
        // Phase guard — only FLEX can transition to CONFIRMED
        if (hold.phase !== HoldPhase.FLEX) {
          logger.warn('[FLEX HOLD] Phase guard — cannot transition from non-FLEX phase', {
            holdId, currentPhase: hold.phase,
          });
          return { success: false, message: `Hold is in ${hold.phase} phase, not FLEX` };
        }

        const now = new Date();

        // AB3: Cap confirmed hold lifetime to broadcast/order remaining time.
        const parentOrder = await tx.order.findUnique({
          where: { id: hold.orderId },
          select: { expiresAt: true },
        });
        const confirmedDurationMs = HOLD_CONFIG.confirmedHoldMaxSeconds * 1000;
        let confirmedExpiresAt = new Date(now.getTime() + confirmedDurationMs);
        if (parentOrder) {
          const broadcastExpiresAtMs = new Date(parentOrder.expiresAt).getTime();
          if (confirmedExpiresAt.getTime() > broadcastExpiresAtMs) {
            confirmedExpiresAt = new Date(broadcastExpiresAtMs);
          }
        }

        const flip = await guardedConfirmFlexToConfirmed(tx, holdId, {
          confirmedExpiresAt,
          confirmedAt: now,
          phaseChangedAt: now,
        });
        if (!flip.updated) {
          return {
            success: false,
            message: 'Hold state changed — already confirmed, expired or released',
          };
        }

        return { success: true, message: 'Hold transitioned to confirmed phase' };
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeoutMs: 8000,
        maxWait: 5_000,
        site: 'flex_transition_to_confirmed',
      });

      if (!result.success) {
        return result;
      }

      // Redis clear stays OUTSIDE TX (cache, not source of truth)
      // P4 F2.3: surface cache delete failures — stale cache is recoverable but masks Redis issues
      await redisService.del(REDIS_KEYS.FLEX_HOLD_STATE(holdId)).catch((err: unknown) => {
        logger.warn('flex_hold_cache_clear_failed', {
          op: 'flex_hold_transition_to_confirmed',
          holdId,
          err: err instanceof Error ? err.message : String(err),
        });
      });

      // F-M13 FIX: Cancel the flex hold expiry cleanup since we transitioned to confirmed
      // P4 F2.3: surface cleanup-cancel failures — stale FLEX expiry jobs have phase-mismatch guard
      // (so still non-fatal), but we want the signal instead of a silent swallow
      try {
        const { holdExpiryCleanupService } = await import('../hold-expiry/hold-expiry-cleanup.service');
        holdExpiryCleanupService.cancelScheduledCleanup(holdId, 'flex').catch((err: unknown) => {
          logger.warn('flex_hold_expiry_cancel_failed', {
            op: 'flex_hold_transition_to_confirmed',
            holdId,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      } catch (_) {
        // Non-fatal — stale FLEX expiry jobs have phase-mismatch guard
      }

      logger.info('[FLEX HOLD] Transitioned to confirmed phase', { holdId });

      return {
        success: true,
        message: 'Hold transitioned to confirmed phase',
      };
    } catch (error: any) {
      logger.error('[FLEX HOLD] Failed to transition to confirmed', {
        error: error.message,
        holdId,
      });

      return {
        success: false,
        message: 'Failed to transition to confirmed phase',
      };
    }
  }

  // =========================================================================
  // PRIVATE METHODS
  // =========================================================================

  /**
   * Cache flex hold state in Redis
   */
  private async cacheFlexHoldState(
    holdId: string,
    state: FlexHoldState
  ): Promise<void> {
    const ttl = Math.floor(state.remainingSeconds) + 60; // Cache for remaining + 60s
    await redisService.setJSON(
      REDIS_KEYS.FLEX_HOLD_STATE(holdId),
      state,
      ttl
    );
  }

  /**
   * Schedule expiry cleanup for flex hold (Layer 1)
   * Uses delayed queue job that persists across server restarts
   */
  private async scheduleExpiryCheck(holdId: string, expiresAt: Date): Promise<void> {
    // Schedule delayed queue job for expiry cleanup
    await holdExpiryCleanupService.scheduleFlexHoldCleanup(holdId, expiresAt);
  }
}

// =============================================================================
// EXPORT SINGLETON
// =============================================================================

export const flexHoldService = new FlexHoldService({
  baseDurationSeconds: HOLD_CONFIG.flexHoldDurationSeconds,
  extensionSeconds: HOLD_CONFIG.flexHoldExtensionSeconds,
  maxDurationSeconds: HOLD_CONFIG.flexHoldMaxDurationSeconds,
  maxExtensions: HOLD_CONFIG.flexHoldMaxExtensions,
});
