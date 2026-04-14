import * as crypto from 'crypto';
import { prismaClient } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';

export class HoldReconciliationService {
  private isRunning = false;
  private pollIntervalMs = 30000; // 30 seconds
  private intervalId: NodeJS.Timeout | null = null;
  // L-04 FIX: Stable per-instance ID for distributed lock ownership
  private readonly instanceId = process.env.HOSTNAME || crypto.randomUUID();

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

    // H-15 FIX: .unref() so this interval doesn't prevent Node.js from exiting during shutdown
    this.intervalId = setInterval(() => this.reconcileExpiredHolds(), this.pollIntervalMs);
    this.intervalId.unref();

    // Run immediately on startup to catch any stale records
    this.reconcileExpiredHolds().catch(err => {
      logger.error('[RECONCILIATION] Initial run failed', err);
    });
  }

  /**
   * Reconcile expired holds that weren't cleaned by Layer 1
   * Acts as defense-in-depth backup
   *
   * FIX-21: Acquires distributed lock so only one ECS instance runs cleanup at a time.
   */
  private async reconcileExpiredHolds(): Promise<void> {
    const startTime = Date.now();

    // FIX-21: Acquire distributed lock — only one instance runs cleanup
    const lockKey = 'hold:cleanup:unified';
    const instanceId = this.instanceId; // L-04 FIX: Use stable per-instance ID
    let lockResult: { acquired: boolean };
    try {
      lockResult = await redisService.acquireLock(lockKey, instanceId, 35);
    } catch {
      // Redis unavailable — skip this cycle, next interval will retry
      logger.warn('[RECONCILIATION] Could not reach Redis for lock — skipping cycle');
      return;
    }
    if (!lockResult.acquired) {
      logger.debug('[RECONCILIATION] Another instance holds the lock — skipping');
      return;
    }

    try {
      const now = new Date();
      logger.debug('[RECONCILIATION] Scanning for expired holds');

      // H-18 FIX: Increased batch size from 100 to 500 to prevent backlog
      // accumulation under high load. Previous cap of 100 could leave expired
      // holds unprocessed across multiple cycles.
      const BATCH_SIZE = 500;

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
        take: BATCH_SIZE
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
        take: BATCH_SIZE
      });

      // H-6 FIX: Tag holds with known phase from initial queries to avoid
      // N+1 re-query inside processExpiredHoldById
      const allExpired = [
        ...expiredFlexHolds.map(h => ({ ...h, phase: 'FLEX' as const })),
        ...expiredConfirmedHolds.map(h => ({ ...h, phase: 'CONFIRMED' as const }))
      ];
      let totalProcessed = 0;

      if (allExpired.length > 0) {
        logger.info('[RECONCILIATION] Found expired holds', {
          count: allExpired.length,
          flex: expiredFlexHolds.length,
          confirmed: expiredConfirmedHolds.length
        });

        // H-6 FIX: Bounded concurrency (5 at a time) instead of sequential loop
        const CONCURRENCY = 5;
        for (let i = 0; i < allExpired.length; i += CONCURRENCY) {
          const batch = allExpired.slice(i, i + CONCURRENCY);
          await Promise.all(batch.map(h => this.processExpiredHoldById(h.holdId, h.phase)));
          totalProcessed += batch.length;
        }
      }

      // H-18 FIX: Query remaining backlog so operators know if the batch
      // size is insufficient. Emits a WARN when expired holds remain after
      // this cycle, signaling the need to increase BATCH_SIZE or run frequency.
      const remainingBacklog = await prismaClient.truckHoldLedger.count({
        where: {
          status: { notIn: ['expired', 'released', 'cancelled'] },
          OR: [
            { phase: 'FLEX', flexExpiresAt: { lt: now } },
            { phase: 'CONFIRMED', confirmedExpiresAt: { lt: now } }
          ]
        }
      });
      if (remainingBacklog > 0) {
        logger.warn('[RECONCILIATION] Backlog remains', { remaining: remainingBacklog, processed: totalProcessed });
      }

      const elapsedMs = Date.now() - startTime;
      logger.debug('[RECONCILIATION] Scan complete', { elapsedMs, processed: totalProcessed, backlog: remainingBacklog });

    } catch (error: any) {
      logger.error('[RECONCILIATION] Scan failed', {
        error: error.message,
        elapsedMs: Date.now() - startTime
      });
    } finally {
      // FIX-21: Always release lock
      await redisService.releaseLock(lockKey, instanceId).catch(() => {});
    }
  }

  /**
   * FIX-37: Process an expired hold directly by ID and phase, without
   * constructing a fake QueueJob shape.
   *
   * Delegates to holdExpiryCleanupService.processExpiredHold with a
   * minimal conforming QueueJob object. The QueueJob interface is a
   * lightweight data bag (id, type, data, priority, attempts,
   * maxAttempts, createdAt) -- constructing it is intentional here
   * because processExpiredHold is the canonical entry point that
   * handles idempotency, phase-mismatch guards, and notifications.
   *
   * A future refactor could extract the core logic into a separate
   * method, but for now this keeps the change minimal and safe.
   */
  async processExpiredHoldById(holdId: string, phaseOverride?: string): Promise<void> {
    try {
      const { holdExpiryCleanupService } = await import('./hold-expiry-cleanup.service');

      // If phase is provided, use it; otherwise look it up
      let phaseType: 'flex' | 'confirmed';
      if (phaseOverride) {
        phaseType = phaseOverride === 'confirmed' ? 'confirmed' : 'flex';
      } else {
        const hold = await prismaClient.truckHoldLedger.findUnique({
          where: { holdId },
          select: { phase: true }
        });

        if (!hold) return;

        const phaseLower = (hold.phase as string).toLowerCase();
        phaseType = phaseLower === 'confirmed' ? 'confirmed' : 'flex';
      }

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
