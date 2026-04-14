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
import { onVehicleTransition } from '../../shared/services/vehicle-lifecycle.service';
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
  phase: 'flex' | 'confirmed';
  expiresAt?: string;
  orderId?: string;
  transporterId?: string;
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
        phase: 'flex',
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
        phase: 'confirmed',
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

      // M-8 FIX: Check if cleanup was cancelled (hold confirmed/released before expiry)
      try {
        const cancelKey = `hold:cleanup:cancelled:${holdId}`;
        const cancelled = await redisService.get(cancelKey);
        if (cancelled) {
          logger.debug(`[HoldExpiry] Skipping cancelled cleanup for ${holdId}`);
          await redisService.del(cancelKey).catch(() => {});
          return;
        }
      } catch {
        // Redis unavailable — fall through to process (idempotency guard above is the safety net)
      }

      // Phase mismatch check (safety guard)
      const holdPhase = (hold.phase as string).toLowerCase();
      if (holdPhase !== phase) {
        logger.warn(`[HoldExpiry] Phase mismatch, skipping`, {
          holdId,
          jobPhase: phase,
          holdPhase: holdPhase,
        });
        return;
      }

      // Update hold status to expired
      const updatedHold = await prismaClient.truckHoldLedger.update({
        where: { holdId },
        data: {
          status: 'expired',
          terminalReason: phase === 'flex' ? 'flex_hold_expired' : 'confirmed_hold_expired',
          releasedAt: new Date(),
        },
      });

      logger.info(`[HoldExpiry] Updated hold to expired`, { holdId, phase });

      // Phase 2 (CONFIRMED): Release vehicles
      if (phase === 'confirmed') {
        await this.releaseConfirmedVehicles(hold);
      }

      // Notify transporter
      await this.notifyTransporterExpiry(updatedHold, phase);

      // H-16 FIX: Notify customer when transporter's hold expires
      // so customer app can update UI (e.g. "trucks returned to search pool")
      await this.notifyCustomerHoldExpiry(updatedHold, phase);

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
      // Safety check: hold must have an orderId to find its assignments
      if (!hold.orderId) {
        logger.error('[HoldExpiry] CRITICAL: Hold has no orderId, cannot release vehicles', {
          holdId,
          transporterId,
        });
        return;
      }

      // Find assignments for this hold's ORDER with pending/accepted status
      // FIX-7: Scope by transporterId to prevent cancelling other transporters' valid assignments
      const assignments = await prismaClient.assignment.findMany({
        where: {
          orderId: hold.orderId,   // FIX C1: Use hold.orderId (Order PK), not holdId (Hold PK)
          transporterId: hold.transporterId,  // FIX-7: Only release THIS transporter's assignments
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

        // FIX C3+QA: Wrap CAS cancel + vehicle release in a transaction.
        // Without this, a crash between assignment cancel and vehicle release
        // would leave the vehicle stuck in 'on_hold' with a cancelled assignment.
        const [cancelResult, vehicleUpdated] = await prismaClient.$transaction(async (tx) => {
          // CAS guard -- only cancel assignments in releasable states.
          // Whitelist approach: only cancel 'pending' and 'driver_declined' assignments.
          // 'driver_accepted' assignments are NOT cancelled -- the driver has committed.
          const txCancelResult = await tx.assignment.updateMany({
            where: {
              id: assignment.id,
              status: { in: ['pending', 'driver_declined'] },
            },
            data: { status: 'cancelled' },
          });

          if (txCancelResult.count === 0) {
            // Assignment was already accepted or in another terminal state -- skip vehicle release
            return [txCancelResult, { count: 0 }];
          }

          // Update vehicle to available — with status guard to prevent double-release
          const txVehicleUpdated = await tx.vehicle.updateMany({
            where: { id: vehicle.id, status: { not: 'available' } },
            data: {
              status: 'available',
              currentTripId: null,
              assignedDriverId: null,
              lastStatusChange: new Date().toISOString(),
            },
          });

          return [txCancelResult, txVehicleUpdated];
        });

        if (cancelResult.count === 0) {
          // Assignment was already accepted or in another terminal state -- skip vehicle release
          logger.info('[HoldExpiry] Assignment not cancelled -- driver may have already accepted', {
            holdId,
            assignmentId: assignment.id,
          });
          continue;  // DO NOT release this vehicle -- driver has it
        }

        if (vehicleUpdated.count === 0) {
          logger.info(`[HoldExpiry] Vehicle already available, skipping release`, {
            holdId,
            vehicleId: vehicle.id,
          });
        }

        // Redis + fleet cache sync (outside transaction -- Redis is not transactional)
        if (vehicleUpdated.count > 0) {
          await onVehicleTransition(
            transporterId,
            vehicle.id,
            vehicle.vehicleKey,
            oldStatus as string,
            'available',
            'holdExpiry'
          );
        }

        logger.info(`[HoldExpiry] Released vehicle`, {
          holdId,
          assignmentId: assignment.id,
          vehicleId: vehicle.id,
          vehicleNumber: vehicle.vehicleNumber,
          oldStatus,
          newStatus: vehicleUpdated.count > 0 ? 'available' : oldStatus,
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
  private async notifyTransporterExpiry(hold: any, phase: 'flex' | 'confirmed'): Promise<void> {
    const { emitToUser } = await import('../../shared/services/socket.service');

    const eventName = phase === 'flex' ? 'flex_hold_expired' : 'confirmed_hold_expired';

    emitToUser(hold.transporterId, eventName, {
      holdId: hold.holdId,
      orderId: hold.orderId,
      phase: phase,
      status: 'expired',
      reason: phase === 'flex' ? 'flex_hold_expired' : 'confirmed_hold_expired',
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
   * H-16 FIX: Notify customer when a transporter's hold expires
   * so the customer app can reflect that trucks are back in the search pool.
   *
   * Fail-open: errors are logged but never crash the hold expiry flow.
   *
   * @param hold - The expired hold record
   * @param phase - The phase that expired
   */
  private async notifyCustomerHoldExpiry(hold: any, phase: 'flex' | 'confirmed'): Promise<void> {
    try {
      if (!hold.orderId) {
        logger.debug('[HoldExpiry] No orderId on hold — skipping customer notification', { holdId: hold.holdId });
        return;
      }

      const order = await prismaClient.order.findUnique({
        where: { id: hold.orderId },
        select: { customerId: true },
      });

      if (!order?.customerId) {
        logger.debug('[HoldExpiry] Order not found or no customerId — skipping customer notification', {
          holdId: hold.holdId,
          orderId: hold.orderId,
        });
        return;
      }

      const { emitToUser } = await import('../../shared/services/socket.service');
      emitToUser(order.customerId, 'hold_expired', {
        orderId: hold.orderId,
        transporterId: hold.transporterId,
        phase,
        message: "A transporter's hold has expired. Trucks are back in the search pool.",
        expiredAt: new Date().toISOString(),
      });

      logger.info('[HoldExpiry] Notified customer of hold expiry', {
        customerId: order.customerId,
        holdId: hold.holdId,
        orderId: hold.orderId,
        phase,
      });
    } catch (notifyErr: any) {
      // Fail-open: never crash the hold expiry flow for a notification failure
      logger.warn('[HoldExpiry] Failed to notify customer of hold expiry', {
        holdId: hold.holdId,
        error: notifyErr?.message,
      });
    }
  }

  /**
   * M-8 FIX: Mark hold cleanup as cancelled via Redis so the processor skips it.
   *
   * The queue service does not support direct job cancellation. Instead of a
   * true no-op, we write a short-lived Redis marker. When the cleanup job
   * fires, processExpiredHold checks for this marker and skips processing.
   * This is more reliable than trying to cancel queue jobs and keeps the
   * existing idempotency guarantee as a safety net.
   *
   * @param holdId - The hold ID
   * @param phase - The phase of the hold
   */
  async cancelScheduledCleanup(holdId: string, phase: 'flex' | 'confirmed'): Promise<void> {
    try {
      // 5-minute TTL — well beyond any cleanup job delay
      await redisService.set(`hold:cleanup:cancelled:${holdId}`, '1', 300);
      logger.debug(`[HoldExpiry] Marked hold ${holdId} for cleanup skip`, { holdId, phase });
    } catch (err: any) {
      // Fail-open: the existing idempotency check (TERMINAL_STATUSES) is the safety net
      logger.warn(`[HoldExpiry] Failed to mark cleanup skip for ${holdId}`, { error: err?.message });
    }
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
