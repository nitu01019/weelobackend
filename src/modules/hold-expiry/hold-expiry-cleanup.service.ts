/**
 * =============================================================================
 * HOLD EXPIRY CLEANUP SERVICE - Layer 1 Delayed Queue Cleanup
 * =============================================================================
 *
 * DUAL-LAYER DEFENSE PATTERN (Uber/Ola Standard):
 * - Layer 1: This service - Delayed queue jobs that persist in Redis across server restarts
 * - Layer 2: Hold reconciliation service - Periodic cleanup of stuck holds
 *
 * WHAT THIS DOES:
 * - Schedules delayed queue jobs for hold expiry
 * - Processes expired holds idempotently
 * - Releases vehicles on Phase 2 expiry
 * - Notifies transporters via socket
 *
 * QUEUE DETAILS:
 * - Queue name: 'hold-expiry'
 * - Job type for flex: 'flex_hold_expired'
 * - Job type for confirmed: 'confirmed_hold_expired'
 * - Max attempts: 3
 *
 * IDEMPOTENCY:
 * - Checks hold status before processing
 * - Skips if already expired/released/cancelled
 * - Safe to run multiple times on same hold
 *
 * @author Weelo Team
 * @version 1.0.0
 * =============================================================================
 */

import { HoldPhase } from '@prisma/client';
import { prismaClient } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { liveAvailabilityService } from '../../shared/services/live-availability.service';
import { queueService, QueueJob } from '../../shared/services/queue.service';
import { generateVehicleKey } from '../../shared/services/vehicle-key.service';

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

/**
 * Hold expiry job data
 */
interface HoldExpiryJobData {
  holdId: string;
  phase: HoldPhase;
  expiresAt: string;
}

/**
 * Hold expiry job types
 */
const JOB_TYPES = {
  FLEX_HOLD_EXPIRED: 'flex_hold_expired',
  CONFIRMED_HOLD_EXPIRED: 'confirmed_hold_expired',
} as const;

/**
 * Queue name for hold expiry jobs
 */
const QUEUE_NAME = 'hold-expiry';

/**
 * Terminal hold statuses (already processed)
 */
const TERMINAL_STATUSES = new Set(['expired', 'released', 'cancelled']);

/**
 * Assignment statuses that indicate vehicle should be released on expiry
 */
const RELEASE_ASSIGNMENT_STATUSES = ['pending', 'driver_accepted'] as const;

// =============================================================================
// HOLD EXPIRY CLEANUP SERVICE
// =============================================================================

class HoldExpiryCleanupService {
  private readonly queueName = QUEUE_NAME;
  private readonly maxAttempts = 3;

  // =============================================================================
  // PUBLIC METHODS
  // =============================================================================

  /**
   * Schedule a delayed queue job for Phase 1 (FLEX) hold expiry
   *
   * @param holdId - The hold ID
   * @param expiresAt - When the hold expires (ISO string or Date)
   * @returns Job ID
   */
  async scheduleFlexHoldCleanup(holdId: string, expiresAt: Date | string): Promise<string> {
    const expiresAtDate = typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt;
    const delayMs = Math.max(0, expiresAtDate.getTime() - Date.now());

    const jobId = await queueService.add<HoldExpiryJobData>(
      this.queueName,
      JOB_TYPES.FLEX_HOLD_EXPIRED,
      {
        holdId,
        phase: 'FLEX',
        expiresAt: expiresAtDate.toISOString(),
      },
      {
        delay: delayMs,
        maxAttempts: this.maxAttempts,
      }
    );

    logger.info(`[HoldExpiry] Scheduled flex hold cleanup`, {
      holdId,
      expiresAt: expiresAtDate.toISOString(),
      delayMs,
      jobId,
    });

    return jobId;
  }

  /**
   * Schedule a delayed queue job for Phase 2 (CONFIRMED) hold expiry
   *
   * @param holdId - The hold ID
   * @param expiresAt - When the hold expires (ISO string or Date)
   * @returns Job ID
   */
  async scheduleConfirmedHoldCleanup(holdId: string, expiresAt: Date | string): Promise<string> {
    const expiresAtDate = typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt;
    const delayMs = Math.max(0, expiresAtDate.getTime() - Date.now());

    const jobId = await queueService.add<HoldExpiryJobData>(
      this.queueName,
      JOB_TYPES.CONFIRMED_HOLD_EXPIRED,
      {
        holdId,
        phase: 'CONFIRMED',
        expiresAt: expiresAtDate.toISOString(),
      },
      {
        delay: delayMs,
        maxAttempts: this.maxAttempts,
      }
    );

    logger.info(`[HoldExpiry] Scheduled confirmed hold cleanup`, {
      holdId,
      expiresAt: expiresAtDate.toISOString(),
      delayMs,
      jobId,
    });

    return jobId;
  }

  /**
   * Idempotent processor for expired holds
   *
   * Steps:
   * 1. Get hold record from TruckHoldLedger
   * 2. Check if already processed (status: expired/released/cancelled)
   * 3. Update status to 'expired'
   * 4. If Phase 2, release vehicles and update Redis availability
   * 5. Notify transporter via socket
   *
   * @param job - The queue job
   */
  async processExpiredHold(job: QueueJob<HoldExpiryJobData>): Promise<void> {
    const { holdId, phase } = job.data;

    logger.info(`[HoldExpiry] Processing expired hold`, { holdId, phase, jobId: job.id });

    try {
      // Fetch hold record
      const hold = await prismaClient.truckHoldLedger.findUnique({
        where: { holdId },
      });

      if (!hold) {
        logger.warn(`[HoldExpiry] Hold not found`, { holdId });
        return;
      }

      // Idempotency check: skip if already in terminal state
      if (TERMINAL_STATUSES.has(hold.status)) {
        logger.info(`[HoldExpiry] Hold already in terminal state, skipping`, {
          holdId,
          status: hold.status,
        });
        return;
      }

      // Phase mismatch check (safety guard)
      if (hold.phase !== phase) {
        logger.warn(`[HoldExpiry] Phase mismatch, skipping`, {
          holdId,
          jobPhase: phase,
          holdPhase: hold.phase,
        });
        return;
      }

      // Update hold status to expired
      const updatedHold = await prismaClient.truckHoldLedger.update({
        where: { holdId },
        data: {
          status: 'expired',
          terminalReason: phase === 'FLEX' ? 'flex_hold_expired' : 'confirmed_hold_expired',
          releasedAt: new Date(),
        },
      });

      logger.info(`[HoldExpiry] Updated hold to expired`, { holdId, phase });

      // Phase 2 (CONFIRMED): Release vehicles
      if (phase === 'CONFIRMED') {
        await this.releaseConfirmedVehicles(hold);
      }

      // Notify transporter
      await this.notifyTransporterExpiry(updatedHold, phase);

      logger.info(`[HoldExpiry] Successfully processed expired hold`, { holdId, phase });

    } catch (error: any) {
      logger.error(`[HoldExpiry] Error processing expired hold`, {
        holdId,
        phase,
        error: error.message,
        stack: error.stack,
      });
      throw error; // Re-throw to trigger retry
    }
  }

  /**
   * Release vehicles for confirmed hold expiry
   *
   * Finds assignments with status in ['pending', 'driver_accepted']
   * and updates vehicle status to 'available'.
   *
   * @param hold - The hold record
   */
  private async releaseConfirmedVehicles(hold: any): Promise<void> {
    const { holdId, truckRequestIds, transporterId } = hold;

    logger.info(`[HoldExpiry] Releasing vehicles for confirmed hold`, { holdId, transporterId });

    try {
      // Find assignments for this hold with pending/accepted status
      const assignments = await prismaClient.assignment.findMany({
        where: {
          orderId: holdId,
          status: {
            in: Array.from(RELEASE_ASSIGNMENT_STATUSES),
          },
        },
        include: {
          vehicle: true,
        },
      });

      logger.info(`[HoldExpiry] Found ${assignments.length} assignments to release`, { holdId });

      // Release each assignment's vehicle
      for (const assignment of assignments) {
        const vehicle = assignment.vehicle;
        if (!vehicle) continue;

        const oldStatus = vehicle.status;

        // Update vehicle to available
        await prismaClient.vehicle.update({
          where: { id: vehicle.id },
          data: {
            status: 'available',
            currentTripId: null,
            assignedDriverId: null,
            lastStatusChange: new Date().toISOString(),
          },
        });

        // Update assignment status to cancelled (expired via hold)
        await prismaClient.assignment.update({
          where: { id: assignment.id },
          data: {
            status: 'cancelled',
          },
        });

        // Update Redis availability
        if (vehicle.vehicleKey) {
          await liveAvailabilityService.onVehicleStatusChange(
            transporterId,
            vehicle.vehicleKey,
            oldStatus as string,
            'available'
          );
        }

        logger.info(`[HoldExpiry] Released vehicle`, {
          holdId,
          assignmentId: assignment.id,
          vehicleId: vehicle.id,
          vehicleNumber: vehicle.vehicleNumber,
          oldStatus,
          newStatus: 'available',
        });
      }

      logger.info(`[HoldExpiry] Released ${assignments.length} vehicles`, { holdId });

    } catch (error: any) {
      logger.error(`[HoldExpiry] Error releasing vehicles`, {
        holdId,
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  /**
   * Notify transporter about hold expiry via socket
   *
   * @param hold - The hold record
   * @param phase - The phase that expired
   */
  private async notifyTransporterExpiry(hold: any, phase: HoldPhase): Promise<void> {
    const { emitToUser } = await import('../../shared/services/socket.service');

    const eventName = phase === 'FLEX' ? 'flex_hold_expired' : 'confirmed_hold_expired';

    emitToUser(hold.transporterId, eventName, {
      holdId: hold.holdId,
      orderId: hold.orderId,
      phase: hold.phase,
      status: 'expired',
      reason: phase === 'FLEX' ? 'flex_hold_expired' : 'confirmed_hold_expired',
      vehicleType: hold.vehicleType,
      vehicleSubtype: hold.vehicleSubtype,
      quantity: hold.quantity,
      expiredAt: new Date().toISOString(),
    });

    logger.info(`[HoldExpiry] Notified transporter of expiry`, {
      transporterId: hold.transporterId,
      eventName,
      holdId: hold.holdId,
    });
  }

  /**
   * Remove scheduled cleanup job for a hold
   * Useful when hold is confirmed or cancelled before expiry
   *
   * Note: Currently the queue doesn't support direct job cancellation.
   * The idempotent nature of processExpiredHold will handle duplicate processing.
   *
   * @param holdId - The hold ID
   * @param phase - The phase of the hold
   */
  async cancelScheduledCleanup(holdId: string, phase: HoldPhase): Promise<void> {
    const jobType = phase === 'FLEX' ? JOB_TYPES.FLEX_HOLD_EXPIRED : JOB_TYPES.CONFIRMED_HOLD_EXPIRED;

    logger.info(`[HoldExpiry] Cancel requested for hold cleanup (will be skipped idempotently)`, {
      holdId,
      phase,
      jobType,
    });
  }

  // =============================================================================
  // UTILITY METHODS
  // =============================================================================

  /**
   * Get queue stats for hold expiry
   */
  async getStats(): Promise<{ pending: number; processing?: number }> {
    try {
      const stats = await queueService.getStats();
      const holdExpiryQueue = stats.queues?.find((q: any) => q.name === QUEUE_NAME);
      return {
        pending: holdExpiryQueue?.pending || 0,
        processing: holdExpiryQueue?.processing || 0,
      };
    } catch {
      return { pending: 0, processing: 0 };
    }
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

/**
 * Singleton instance
 */
export const holdExpiryCleanupService = new HoldExpiryCleanupService();

/**
 * Queue processor function
 * Call queueService.registerProcessor('hold-expiry', holdExpiryProcessor)
 * during application initialization
 */
export const holdExpiryProcessor = (job: QueueJob<HoldExpiryJobData>) => {
  return holdExpiryCleanupService.processExpiredHold(job);
};

/**
 * Static registration method
 * Call this during app initialization: registerHoldExpiryProcessor()
 */
export const registerHoldExpiryProcessor = () => {
  queueService.registerProcessor(QUEUE_NAME, holdExpiryProcessor);
  logger.info(`[HoldExpiry] Processor registered for queue: ${QUEUE_NAME}`);
};

/**
 * Types
 */
export type { HoldExpiryJobData };
export { JOB_TYPES, QUEUE_NAME };
export { HoldExpiryCleanupService };
