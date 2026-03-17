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
  maxDurationSeconds: 180,     // Max 180s in Phase 2
  driverAcceptTimeoutSeconds: 45, // Driver has 45s to respond
};

// Redis keys for distributed locking and state
const REDIS_KEYS = {
  CONFIRMED_HOLD_LOCK: (holdId: string) => `lock:confirmed-hold:${holdId}`,
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
   */
  async initializeConfirmedHold(
    holdId: string,
    assignments: Array<{
      assignmentId: string;
      driverId: string;
      truckRequestId: string;
    }>
  ): Promise<{ success: boolean; message: string; confirmedExpiresAt?: Date }> {
    logger.info('[CONFIRMED HOLD] Initializing confirmed hold', {
      holdId,
      assignmentsCount: assignments.length,
    });

    try {
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
      for (const assignment of assignments) {
        const fullData = assignmentMap.get(assignment.assignmentId);

        if (!fullData) {
          logger.warn('[CONFIRMED HOLD] Assignment not found in database', {
            assignmentId: assignment.assignmentId
          });
          continue;
        }

        await this.scheduleDriverAcceptanceTimeout(
          assignment.assignmentId,
          fullData,
          this.config.driverAcceptTimeoutSeconds
        );
      }

      logger.info('[CONFIRMED HOLD] Confirmed hold initialized', {
        holdId,
        confirmedExpiresAt,
      });

      return {
        success: true,
        message: 'Confirmed hold initialized',
        confirmedExpiresAt,
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
    assignmentId: string
  ): Promise<DriverAcceptResponse> {
    logger.info('[CONFIRMED HOLD] Handling driver acceptance', { assignmentId });

    try {
      const lockKey = REDIS_KEYS.DRIVER_ACCEPTANCE(assignmentId);
      const lock = await redisService.acquireLock(lockKey, 'driver-acceptance', 10);

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
        // Update assignment status
        const assignment = await prismaClient.assignment.update({
          where: { tripId: assignmentId },
          data: {
            status: AssignmentStatus.driver_accepted,
          },
        });

        // Update confirmed hold state
        const holdRecord = await prismaClient.truckRequest.findFirst({
          where: { tripId: assignmentId },
          select: {
            id: true,
            orderId: true,
          },
        });

        if (holdRecord) {
          // Find any hold ledger for this order
          const holdLedger = await prismaClient.truckHoldLedger.findFirst({
            where: { orderId: holdRecord.orderId, phase: HoldPhase.CONFIRMED },
          });

          if (holdLedger) {
            // Update truck accepted count
            const state = await this.getConfirmedHoldState(holdLedger.holdId);
            if (state) {
              state.trucksAccepted++;
              state.trucksPending--;
              await this.cacheConfirmedHoldState(holdLedger.holdId, state);

              // Emit progress update
              await socketService.emitToUser(holdLedger.transporterId, 'driver_accepted', {
                holdId: holdLedger.holdId,
                assignmentId,
                driverId: assignment.driverId,
                trucksAccepted: state.trucksAccepted,
                trucksPending: state.trucksPending,
                message: `Driver accepted. ${state.trucksAccepted}/${state.trucksCount} confirmed.`,
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
        await redisService.releaseLock(lockKey, 'driver-acceptance').catch(() => {});
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
    reason: string = ''
  ): Promise<DriverAcceptResponse> {
    logger.info('[CONFIRMED HOLD] Handling driver decline', {
      assignmentId,
      reason,
    });

    try {
      const lockKey = REDIS_KEYS.DRIVER_ACCEPTANCE(assignmentId);
      const lock = await redisService.acquireLock(lockKey, 'driver-decline', 10);

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
        // Update assignment status
        const assignment = await prismaClient.assignment.update({
          where: { tripId: assignmentId },
          data: {
            status: AssignmentStatus.driver_declined,
          },
        });

        // Update truck request to searching (back to pool)
        const truckRequest = await prismaClient.truckRequest.findFirst({
          where: { tripId: assignmentId },
        });

        if (truckRequest) {
          await prismaClient.truckRequest.update({
            where: { id: truckRequest.id },
            data: {
              status: 'searching', // Back to search pool
              assignedDriverId: null,
              assignedDriverName: null,
              assignedVehicleId: null,
              assignedVehicleNumber: null,
            },
          });
        }

        // Update confirmed hold state
        if (truckRequest) {
          const holdLedger = await prismaClient.truckHoldLedger.findFirst({
            where: { orderId: truckRequest.orderId, phase: HoldPhase.CONFIRMED },
          });

          if (holdLedger) {
            const state = await this.getConfirmedHoldState(holdLedger.holdId);
            if (state) {
              state.trucksDeclined++;
              state.trucksPending--;
              await this.cacheConfirmedHoldState(holdLedger.holdId, state);

              // Emit decline notification
              await socketService.emitToUser(holdLedger.transporterId, 'driver_declined', {
                holdId: holdLedger.holdId,
                assignmentId,
                driverId: assignment.driverId,
                reason,
                trucksDeclined: state.trucksDeclined,
                trucksPending: state.trucksPending,
                message: `Driver declined. ${state.trucksDeclined}/${state.trucksCount} declined.`,
              });
            }
          }
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
        await redisService.releaseLock(lockKey, 'driver-decline').catch(() => {});
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

    return await this.handleDriverDecline(assignmentId, 'Driver timed out');
  }

  /**
   * Get confirmed hold state
   */
  async getConfirmedHoldState(
    holdId: string
  ): Promise<ConfirmedHoldState | null> {
    try {
      // Try Redis first
      const cached = await redisService.getJSON<ConfirmedHoldState>(
        REDIS_KEYS.CONFIRMED_HOLD_STATE(holdId)
      );
      if (cached) {
        return this.refreshRemainingSeconds(cached);
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
        trucksDeclined: 0, // Need to track separately
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
   */
  private async cacheConfirmedHoldState(
    holdId: string,
    state: ConfirmedHoldState
  ): Promise<void> {
    const ttl = Math.max(1, state.remainingSeconds) + 10;
    await redisService.setJSON(
      REDIS_KEYS.CONFIRMED_HOLD_STATE(holdId),
      state,
      ttl
    );
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
    timeoutSeconds: number
  ): Promise<void> {
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
      createdAt: new Date().toISOString(),
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
  maxDurationSeconds: parseInt(process.env.CONFIRMED_HOLD_MAX_SECONDS || '180'),
  driverAcceptTimeoutSeconds: parseInt(
    process.env.DRIVER_ACCEPT_TIMEOUT_SECONDS || '45'
  ),
});
