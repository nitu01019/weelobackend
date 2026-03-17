import { prismaClient } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';

export class HoldReconciliationService {
  private isRunning = false;
  private pollIntervalMs = 30000; // 30 seconds
  private intervalId: NodeJS.Timeout | null = null;

  /**
   * Start the reconciliation worker
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('[RECONCILIATION] Worker already running');
      return;
    }

    this.isRunning = true;
    logger.info('[RECONCILIATION] Starting periodic worker', {
      interval: `${this.pollIntervalMs}ms`
    });

    this.intervalId = setInterval(() => this.reconcileExpiredHolds(), this.pollIntervalMs);

    // Run immediately on startup to catch any stale records
    this.reconcileExpiredHolds().catch(err => {
      logger.error('[RECONCILIATION] Initial run failed', err);
    });
  }

  /**
   * Reconcile expired holds that weren't cleaned by Layer 1
   * Acts as defense-in-depth backup
   */
  private async reconcileExpiredHolds(): Promise<void> {
    const startTime = Date.now();
    const now = new Date();

    try {
      logger.debug('[RECONCILIATION] Scanning for expired holds');

      // Find expired flex holds
      const expiredFlexHolds = await prismaClient.truckHoldLedger.findMany({
        where: {
          phase: 'FLEX',
          flexExpiresAt: { lt: now },
          status: {
            notIn: ['expired', 'released', 'cancelled']
          }
        },
        select: {
          holdId: true,
          orderId: true,
          transporterId: true,
          flexExpiresAt: true
        },
        take: 100
      });

      // Find expired confirmed holds
      const expiredConfirmedHolds = await prismaClient.truckHoldLedger.findMany({
        where: {
          phase: 'CONFIRMED',
          confirmedExpiresAt: { lt: now },
          status: {
            notIn: ['expired', 'released', 'cancelled']
          }
        },
        select: {
          holdId: true,
          orderId: true,
          transporterId: true,
          confirmedExpiresAt: true
        },
        take: 100
      });

      const allExpired = [...expiredFlexHolds, ...expiredConfirmedHolds];

      if (allExpired.length > 0) {
        logger.info('[RECONCILIATION] Found expired holds', {
          count: allExpired.length,
          flex: expiredFlexHolds.length,
          confirmed: expiredConfirmedHolds.length
        });

        for (const hold of allExpired) {
          await this.processExpiredHold(hold.holdId);
        }
      }

      const elapsedMs = Date.now() - startTime;
      logger.debug('[RECONCILIATION] Scan complete', { elapsedMs });

    } catch (error: any) {
      logger.error('[RECONCILIATION] Scan failed', {
        error: error.message,
        elapsedMs: Date.now() - startTime
      });
    }
  }

  /**
   * Process expired hold
   */
  private async processExpiredHold(holdId: string): Promise<void> {
    try {
      const { holdExpiryCleanupService } = await import('./hold-expiry-cleanup.service');

      const hold = await prismaClient.truckHoldLedger.findUnique({
        where: { holdId },
        select: { phase: true, transporterId: true, orderId: true }
      });

      if (!hold) return;

      // Phase is already 'flex' or 'confirmed' from database
      const phaseLower = (hold.phase as string).toLowerCase();
      const phaseType = phaseLower === 'confirmed' ? 'confirmed' : 'flex';

      await holdExpiryCleanupService.processExpiredHold({
        id: `reconcile-${holdId}`,
        type: phaseType,
        data: { holdId, phase: phaseType },
        priority: 0,
        attempts: 0,
        maxAttempts: 3,
        createdAt: Date.now()
      });
    } catch (error: any) {
      logger.error('[RECONCILIATION] Failed to process', {
        holdId,
        error: error.message
      });
    }
  }

  stop(): void {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info('[RECONCILIATION] Worker stopped');
  }
}

export const holdReconciliationService = new HoldReconciliationService();
