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
import { prismaClient, HoldPhase } from '../../shared/database/prisma.service';
import { HOLD_CONFIG } from '../../core/config/hold-config';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { socketService } from '../../shared/services/socket.service';
import { holdExpiryCleanupService } from '../hold-expiry/hold-expiry-cleanup.service';

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

    // M-22 FIX: Dedup — return existing active flex hold if one already exists
    // for this order+transporter combination. Makes the endpoint idempotent at the
    // service level (was only protected at the API/holdTrucks level).
    const existingHold = await prismaClient.truckHoldLedger.findFirst({
      where: {
        orderId: request.orderId,
        transporterId: request.transporterId,
        status: 'active',
        phase: HoldPhase.FLEX,
      },
    });

    if (existingHold) {
      const now = new Date();
      const remainingSeconds = Math.max(
        0,
        Math.floor((existingHold.expiresAt.getTime() - now.getTime()) / 1000)
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
        canExtend: (existingHold.flexExtendedCount || 0) < this.config.maxExtensions,
        message: `Existing flex hold returned. Expires in ${remainingSeconds} seconds.`,
      };
    }

    // AB-2 fix: Reject hold creation if the parent broadcast/order has expired.
    // Prevents stale broadcasts from locking trucks after expiry.
    // F-C-50: Also select customerId so we can mirror `flex_hold_started` to the customer room.
    const parentOrder = await prismaClient.order.findUnique({
      where: { id: request.orderId },
      select: { expiresAt: true, status: true, customerId: true },
    });
    if (!parentOrder) {
      return {
        success: false,
        message: 'Order not found. Cannot create hold for a non-existent order.',
        error: 'ORDER_NOT_FOUND',
      };
    }
    if (new Date(parentOrder.expiresAt).getTime() < Date.now()) {
      return {
        success: false,
        message: 'Cannot create hold — broadcast has expired.',
        error: 'BROADCAST_EXPIRED',
      };
    }
    if (parentOrder.status === 'cancelled' || parentOrder.status === 'expired' || parentOrder.status === 'completed') {
      return {
        success: false,
        message: `Cannot create hold — order is ${parentOrder.status}.`,
        error: 'ORDER_TERMINAL',
      };
    }

    const holdId = uuidv4();
    const now = new Date();
    const holdDurationMs = this.config.baseDurationSeconds * 1000;
    // AB3: Cap hold lifetime to broadcast/order remaining time.
    // A hold must never outlive its parent broadcast.
    const broadcastRemainingMs = new Date(parentOrder.expiresAt).getTime() - now.getTime();
    const cappedDurationMs = broadcastRemainingMs > 0
      ? Math.min(holdDurationMs, broadcastRemainingMs)
      : holdDurationMs;
    const baseExpiresAt = new Date(now.getTime() + cappedDurationMs);

    // Distributed lock to prevent race conditions
    const lockKey = REDIS_KEYS.FLEX_HOLD_LOCK(holdId);
    const lock = await redisService.acquireLock(lockKey, 'flex-hold-creation', 10);

    if (!lock.acquired) {
      return {
        success: false,
        message: 'Could not acquire lock for hold creation',
        error: 'LOCK_ACQUISITION_FAILED',
      };
    }

    try {
      // Create hold in database
      const holdLedger = await prismaClient.truckHoldLedger.create({
        data: {
          holdId,
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
      await socketService.emitToUser(request.transporterId, 'flex_hold_started', flexHoldStartedPayload);
      if (parentOrder.customerId) {
        await socketService.emitToUser(parentOrder.customerId, 'flex_hold_started', flexHoldStartedPayload);
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
      await redisService.releaseLock(lockKey, 'flex-hold-creation').catch(() => {});
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
      await redisService.releaseLock(lockKey, 'flex-hold-extension').catch(() => {});
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
      // F-M12 FIX: Atomic read-then-write in $transaction with phase guard
      const result = await prismaClient.$transaction(async (tx) => {
        const hold = await tx.truckHoldLedger.findUnique({ where: { holdId } });
        if (!hold) {
          return { success: false, message: 'Hold not found' };
        }
        if (hold.transporterId !== transporterId) {
          logger.warn('[FLEX HOLD] Ownership check failed for transitionToConfirmed', {
            holdId, requestedBy: transporterId, ownedBy: hold.transporterId,
          });
          return { success: false, message: 'Not your hold' };
        }
        // F-M12 FIX: Phase guard — only FLEX can transition to CONFIRMED
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

        await tx.truckHoldLedger.update({
          where: { holdId },
          data: {
            phase: HoldPhase.CONFIRMED,
            phaseChangedAt: now,
            status: 'confirmed',
            confirmedAt: now,
            confirmedExpiresAt,
            updatedAt: now,
          },
        });

        return { success: true, message: 'Hold transitioned to confirmed phase' };
      });

      if (!result.success) {
        return result;
      }

      // Redis clear stays OUTSIDE TX (cache, not source of truth)
      await redisService.del(REDIS_KEYS.FLEX_HOLD_STATE(holdId)).catch(() => {});

      // F-M13 FIX: Cancel the flex hold expiry cleanup since we transitioned to confirmed
      try {
        const { holdExpiryCleanupService } = await import('../hold-expiry/hold-expiry-cleanup.service');
        holdExpiryCleanupService.cancelScheduledCleanup(holdId, 'flex').catch(() => {});
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
