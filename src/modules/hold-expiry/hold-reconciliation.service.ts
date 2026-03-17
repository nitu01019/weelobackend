/**
 * =============================================================================
 * HOLD RECONCILIATION SERVICE - Layer 2 Periodic Cleanup
 * =============================================================================
 *
 * DUAL-LAYER DEFENSE PATTERN (Uber/Ola Standard):
 * - Layer 1: holdExpiryCleanupService - Delayed queue jobs that persist in Redis
 * - Layer 2: This service - Periodic cleanup of stuck holds
 *
 * WHAT THIS DOES:
 * - Runs every 30 seconds as a safety net
 * - Scans database for expired holds not cleaned by Layer 1
 * - Defends against queue failures, server restarts, missed jobs
 * - Reuses Layer 1 cleanup logic (idempotent)
 *
 * WHEN THIS RUNS:
 * - Periodically every 30 seconds
 * - Processes up to 100 expired holds per run
 * - Runs immediately on startup to catch stale records
 *
 * IDEMPOTENCY:
 * - All operations reuse Layer 1 idempotent logic
 * - Safe to run multiple times in parallel
 * - Skips holds already in terminal state
 *
 * @author Weelo Team
 * @version 1.0.0
 * =============================================================================
 */

import { HoldPhase } from '@prisma/client';
import { prismaClient } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { holdExpiryCleanupService } from './hold-expiry-cleanup.service';

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

/**
 * Terminal hold statuses (already processed, should not be cleaned again)
 */
const TERMINAL_STATUSES = new Set(['expired', 'released', 'cancelled']) as Set<string>;

/**
 * Queue job data structure for Layer 1 cleanup
 */
interface HoldExpiryJobData {
  holdId: string;
  phase: HoldPhase;
  expiresAt: string;
}

/**
 * Queue job interface (minimal version for Layer 1 integration)
 */
interface ReconciliationJob {
  id: string;
  type: string;
  data: HoldExpiryJobData;
  priority: number;
  attempts: number;
}

// =============================================================================
// HOLD RECONCILIATION SERVICE
// =============================================================================

class HoldReconciliationService {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private readonly intervalMs = 30000; // 30 seconds
  private readonly maxRecordsPerRun = 100;
  private readonly jobIdPrefix = 'reconciliation-';

  // =============================================================================
  // PUBLIC METHODS
  // =============================================================================

  /**
   * Start the periodic reconciliation worker
   *
   * - Checks if already running
   * - Sets interval to run every 30 seconds
   * - Runs immediately on startup to catch stale records
   */
  start(): void {
    if (this.isRunning) {
      logger.warn(`[HoldReconciliation] Already running, skipping start`);
      return;
    }

    logger.info(`[HoldReconciliation] Starting periodic worker`, {
      intervalMs: this.intervalMs,
      maxRecordsPerRun: this.maxRecordsPerRun,
    });

    this.isRunning = true;

    // Run immediately on startup to catch stale records
    this.runOnce().catch((error) => {
      logger.error(`[HoldReconciliation] Error in initial run`, {
        error: error.message,
        stack: error.stack,
      });
    });

    // Set up periodic interval
    this.intervalId = setInterval(() => {
      this.runOnce().catch((error) => {
        logger.error(`[HoldReconciliation] Error in periodic run`, {
          error: error.message,
          stack: error.stack,
        });
      });
    }, this.intervalMs);

    logger.info(`[HoldReconciliation] Worker started, scheduled every ${this.intervalMs}ms`);
  }

  /**
   * Stop the reconciliation worker
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    logger.info(`[HoldReconciliation] Stopping worker`);

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.isRunning = false;

    logger.info(`[HoldReconciliation] Worker stopped`);
  }

  /**
   * Check if the worker is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  // =============================================================================
  // PRIVATE METHODS
  // =============================================================================

  /**
   * Run a single reconciliation pass
   */
  private async runOnce(): Promise<void> {
    const now = new Date();

    logger.info(`[HoldReconciliation] Starting reconciliation pass`, {
      timestamp: now.toISOString(),
    });

    try {
      const stats = await this.reconcileExpiredHolds(now);

      logger.info(`[HoldReconciliation] Reconciliation pass completed`, stats);

    } catch (error: any) {
      logger.error(`[HoldReconciliation] Error in reconciliation pass`, {
        error: error.message,
        stack: error.stack,
      });
      throw error; // Re-throw for logging in caller
    }
  }

  /**
   * Scan database for expired holds and process them
   *
   * Finds:
   * 1. TruckHoldLedger with phase='FLEX', flexExpiresAt < now, status not in [expired, released, cancelled]
   * 2. TruckHoldLedger with phase='CONFIRMED', confirmedExpiresAt < now, status not in [expired, released, cancelled]
   *
   * Processes each expired hold by delegating to Layer 1 cleanup logic
   *
   * @param now - Current date for comparison
   * @returns Statistics about the reconciliation run
   */
  async reconcileExpiredHolds(now: Date = new Date()): Promise<{
    totalProcessed: number;
    flexExpired: number;
    confirmedExpired: number;
    skipped: number;
    errors: number;
  }> {
    const stats = {
      totalProcessed: 0,
      flexExpired: 0,
      confirmedExpired: 0,
      skipped: 0,
      errors: 0,
    };

    // 1. Find expired FLEX holds
    const expiredFlexHolds = await prismaClient.truckHoldLedger.findMany({
      where: {
        phase: 'FLEX',
        flexExpiresAt: {
          lt: now,
        },
        status: {
          notIn: Array.from(TERMINAL_STATUSES),
        },
      },
      select: {
        holdId: true,
      },
      take: this.maxRecordsPerRun,
    });

    logger.info(`[HoldReconciliation] Found expired FLEX holds`, {
      count: expiredFlexHolds.length,
    });

    for (const { holdId } of expiredFlexHolds) {
      try {
        await this.processExpiredHold(holdId);
        stats.flexExpired++;
        stats.totalProcessed++;
      } catch (error: any) {
        stats.errors++;
        logger.error(`[HoldReconciliation] Error processing FLEX hold`, {
          holdId,
          error: error.message,
        });
      }
    }

    // 2. Find expired CONFIRMED holds
    const expiredConfirmedHolds = await prismaClient.truckHoldLedger.findMany({
      where: {
        phase: 'CONFIRMED',
        confirmedExpiresAt: {
          lt: now,
        },
        status: {
          notIn: Array.from(TERMINAL_STATUSES),
        },
      },
      select: {
        holdId: true,
      },
      take: this.maxRecordsPerRun,
    });

    logger.info(`[HoldReconciliation] Found expired CONFIRMED holds`, {
      count: expiredConfirmedHolds.length,
    });

    for (const { holdId } of expiredConfirmedHolds) {
      try {
        await this.processExpiredHold(holdId);
        stats.confirmedExpired++;
        stats.totalProcessed++;
      } catch (error: any) {
        stats.errors++;
        logger.error(`[HoldReconciliation] Error processing CONFIRMED hold`, {
          holdId,
          error: error.message,
        });
      }
    }

    // 3. Find holds with legacy expiresAt expired (backward compatibility)
    const expiredLegacyHolds = await prismaClient.truckHoldLedger.findMany({
      where: {
        expiresAt: {
          lt: now,
        },
        status: {
          notIn: Array.from(TERMINAL_STATUSES),
        },
      },
      select: {
        holdId: true,
      },
      take: this.maxRecordsPerRun,
    });

    logger.info(`[HoldReconciliation] Found expired legacy holds`, {
      count: expiredLegacyHolds.length,
    });

    for (const { holdId } of expiredLegacyHolds) {
      try {
        await this.processExpiredHold(holdId);
        stats.skipped++; // Count these separately as they're legacy
        stats.totalProcessed++;
      } catch (error: any) {
        stats.errors++;
        logger.error(`[HoldReconciliation] Error processing legacy hold`, {
          holdId,
          error: error.message,
        });
      }
    }

    return stats;
  }

  /**
   * Process a single expired hold
   *
   * Reuses Layer 1 cleanup logic (idempotent):
   * 1. Fetch the hold record to get phase
   * 2. Create a minimal QueueJob structure
   * 3. Call holdExpiryCleanupService.processExpiredHold()
   *
   * @param holdId - The hold ID to process
   */
  async processExpiredHold(holdId: string): Promise<void> {
    logger.info(`[HoldReconciliation] Processing expired hold`, { holdId });

    // Fetch hold record to get phase
    const hold = await prismaClient.truckHoldLedger.findUnique({
      where: { holdId },
      select: {
        holdId: true,
        phase: true,
        flexExpiresAt: true,
        confirmedExpiresAt: true,
      },
    });

    if (!hold) {
      logger.warn(`[HoldReconciliation] Hold not found`, { holdId });
      return;
    }

    // Determine which expiry field to use
    const expiresAt = hold.phase === 'FLEX' && hold.flexExpiresAt
      ? hold.flexExpiresAt
      : hold.confirmedExpiresAt || new Date();

    // Create a minimal QueueJob structure for Layer 1 integration
    const job: ReconciliationJob = {
      id: `${this.jobIdPrefix}${holdId}`,
      type: hold.phase === 'FLEX' ? 'flex_hold_expired' : 'confirmed_hold_expired',
      data: {
        holdId,
        phase: hold.phase,
        expiresAt: expiresAt.toISOString(),
      },
      priority: 1,
      attempts: 1,
    };

    // Invoke Layer 1 cleanup logic
    await holdExpiryCleanupService.processExpiredHold(job as any);

    logger.info(`[HoldReconciliation] Successfully processed expired hold`, {
      holdId,
      phase: hold.phase,
    });
  }

  /**
   * Get reconciliation stats (useful for monitoring)
   */
  async getStats(): Promise<{
    isActive: boolean;
    intervalMs: number;
    maxRecordsPerRun: number;
  }> {
    return {
      isActive: this.isRunning,
      intervalMs: this.intervalMs,
      maxRecordsPerRun: this.maxRecordsPerRun,
    };
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

/**
 * Singleton instance
 */
export const holdReconciliationService = new HoldReconciliationService();
