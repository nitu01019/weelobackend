/**
 * =============================================================================
 * TRUCK HOLD CLEANUP — Expired Hold Reconciliation & Idempotency Purge
 * =============================================================================
 *
 * Handles:
 * - startCleanupJob(): Start the periodic cleanup interval
 * - processExpiredHoldsOnce(): Reconcile expired holds + purge old idempotency rows
 * - stopCleanupJob(): Graceful shutdown of the cleanup interval
 */

import { prismaClient } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { metrics } from '../../shared/monitoring/metrics.service';
import {
  CONFIG,
  HOLD_DURATION_CONFIG,
  HOLD_IDEMPOTENCY_RETENTION_HOURS,
  HOLD_IDEMPOTENCY_PURGE_INTERVAL_MS,
  HOLD_CLEANUP_BATCH_SIZE,
} from './truck-hold.types';
import { releaseHold } from './truck-hold-release.service';
import { broadcastAvailabilityUpdate } from './truck-hold-query.service';

// DR-06: Absolute lifetime cap to prevent infinite hold extensions.
// After this absolute deadline (MAX_DURATION + 120s buffer), extensions
// are refused and the hold is released regardless of pending assignments.
const MAX_ABSOLUTE_LIFETIME_MS = (HOLD_DURATION_CONFIG.MAX_DURATION_SECONDS + 120) * 1000;

// =============================================================================
// CLEANUP STATE
// =============================================================================

let cleanupInterval: NodeJS.Timeout | null = null;

// =============================================================================
// START CLEANUP JOB
// =============================================================================

/**
 * Cleanup job - releases expired holds
 * Note: With Redis TTL, locks auto-expire. This is kept for any edge cases
 * and to clean up database state for trucks that were held but lock expired.
 */
export function startCleanupJob(): void {
  // FIX #8: Immediate catch-up on startup — process anything expired during downtime.
  // Fire-and-forget so it never blocks server startup.
  processExpiredHoldsOnce().catch(err =>
    logger.warn('[HOLD-CLEANUP] Startup catch-up failed', { error: err instanceof Error ? err.message : String(err) })
  );

  // Then start the regular interval
  cleanupInterval = setInterval(async () => {
    await processExpiredHoldsOnce();
  }, CONFIG.CLEANUP_INTERVAL_MS);

  logger.info(`[TruckHold] Cleanup job started (every ${CONFIG.CLEANUP_INTERVAL_MS / 1000}s)`);
}

// =============================================================================
// PROCESS EXPIRED HOLDS
// =============================================================================

/**
 * FIX #8: Extracted cleanup logic into a named method so it can be called
 * both on startup (immediate catch-up) and on each interval tick.
 */
async function processExpiredHoldsOnce(): Promise<void> {
  try {
    // FIX #36: Use unified lock key so cleanup and reconciliation cannot run simultaneously.
    // Distributed lock: only ONE instance runs cleanup per interval
    const cleanupLock = await redisService.acquireLock(
      'hold:cleanup:unified',
      `cleanup-${process.pid}`,
      60  // 60s lock TTL — cleanup should complete well within this
    );
    if (!cleanupLock.acquired) {
      return; // Another instance is handling cleanup
    }

    try {
      // FIX #37: Add 5-second grace period to avoid race between cleanup and
      // confirm saga that may be running right at hold expiry. Without this,
      // cleanup can release a hold that confirmHoldWithAssignments is actively
      // processing, causing a SERIALIZABLE conflict or orphaned assignments.
      const CLEANUP_GRACE_PERIOD_MS = 5000;
      const graceCutoff = new Date(Date.now() - CLEANUP_GRACE_PERIOD_MS);
      let cleanupReleasedCount = 0;

      // H-19 FIX: Drain loop — process up to MAX_BATCHES batches per tick
      // instead of a single batch. Prevents expired holds from accumulating
      // when expiry rate exceeds single-batch throughput.
      const MAX_BATCHES = 10;
      for (let batchIdx = 0; batchIdx < MAX_BATCHES; batchIdx++) {
        const expiredHolds = await prismaClient.truckHoldLedger.findMany({
          where: {
            status: 'active',
            expiresAt: { lt: graceCutoff }
          },
          take: HOLD_CLEANUP_BATCH_SIZE,
          orderBy: { expiresAt: 'asc' },
          select: { holdId: true, orderId: true, createdAt: true }
        });

        if (expiredHolds.length === 0) break;

        for (const hold of expiredHolds) {
          // FIX C-12b: Before releasing an expired hold, check for pending/accepted
          // assignments. If drivers are still responding, extend the hold by 30s
          // instead of releasing — prevents race where cleanup expires a hold
          // while a driver acceptance is in progress.
          const pendingAssignments = await prismaClient.assignment.count({
            where: {
              orderId: hold.orderId,
              status: { in: ['pending', 'driver_accepted'] },
            },
          });
          if (pendingAssignments > 0) {
            // DR-06: Refuse extension if hold has exceeded its absolute lifetime cap.
            // This prevents infinite extensions when pending assignments never resolve.
            const holdCreatedAtMs = hold.createdAt instanceof Date
              ? hold.createdAt.getTime()
              : new Date(hold.createdAt).getTime();
            if (Date.now() + 30_000 > holdCreatedAtMs + MAX_ABSOLUTE_LIFETIME_MS) {
              logger.warn(`[TruckHold] Hold ${hold.holdId} reached absolute lifetime cap — releasing despite ${pendingAssignments} pending assignments`, {
                holdId: hold.holdId,
                createdAt: hold.createdAt,
                maxAbsoluteLifetimeMs: MAX_ABSOLUTE_LIFETIME_MS,
              });
              // Fall through to release below
            } else {
              await prismaClient.truckHoldLedger.updateMany({
                where: {
                  holdId: hold.holdId,
                  status: 'active',
                },
                data: {
                  expiresAt: new Date(Date.now() + 30_000),
                },
              });
              logger.info(`[TruckHold] Extended hold ${hold.holdId} by 30s — ${pendingAssignments} pending assignments`);
              continue; // skip this hold's release
            }
          }

          logger.info(`[TruckHold] Auto-releasing expired hold: ${hold.holdId}`);
          const releaseResult = await releaseHold(hold.holdId, undefined, undefined, 'cleanup', broadcastAvailabilityUpdate);
          if (releaseResult.success) {
            cleanupReleasedCount++;
          }
          // FIX #29: Guard against overwriting terminal states.
          // Only mark as expired if hold is still in a non-terminal state.
          // FIX #39: Only set terminalReason if not already set — prevents
          // overwriting a more specific reason (e.g. 'confirm_timeout') with
          // 'HOLD_TTL_EXPIRED' when two cleanup paths run concurrently.
          await prismaClient.truckHoldLedger.updateMany({
            where: {
              holdId: hold.holdId,
              status: { notIn: ['completed', 'cancelled', 'released', 'expired'] },
              terminalReason: null,
            },
            data: {
              status: 'expired',
              terminalReason: 'HOLD_TTL_EXPIRED',
              releasedAt: new Date()
            }
          }).catch((err) => { logger.warn('[TruckHoldCleanup] Failed to expire hold ledger row', { holdId: hold.holdId, error: err instanceof Error ? err.message : String(err) }); });
        }

        if (expiredHolds.length > 0) {
          logger.info(`[TruckHold] Cleanup: Reconciled ${expiredHolds.length} expired holds (batch ${batchIdx + 1})`);
        }

        if (expiredHolds.length < HOLD_CLEANUP_BATCH_SIZE) break; // last partial batch
      }

      if (cleanupReleasedCount > 0) {
        // Emit explicit cleanup metric at job level for release-gate visibility.
        metrics.incrementCounter('hold_cleanup_released_total', { source: 'cleanup_job' }, cleanupReleasedCount);
      }

      const nowMs = Date.now();
      // FIX #93: Use Redis-based purge timestamp instead of in-memory (shared across ECS instances)
      const lastPurgeStr = await redisService.get('hold:idempotency:last_purge_ts').catch((): null => null);
      const lastPurgeMs = lastPurgeStr ? parseInt(lastPurgeStr, 10) : 0;
      if (nowMs - lastPurgeMs >= HOLD_IDEMPOTENCY_PURGE_INTERVAL_MS) {
        // Distributed lock: only ONE instance runs purge per interval
        const purgeLock = await redisService.acquireLock(
          'hold-idempotency-purge',
          `purge-${process.pid}`,
          30  // 30s lock TTL — purge should complete well within this
        );
        if (!purgeLock.acquired) {
          // Another instance is handling purge — skip
        } else {
          try {
            await redisService.set('hold:idempotency:last_purge_ts', String(nowMs), HOLD_IDEMPOTENCY_PURGE_INTERVAL_MS / 1000 + 60).catch(() => {});
            const cutoff = new Date(nowMs - (HOLD_IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000));
            const purged = await prismaClient.truckHoldIdempotency.deleteMany({
              where: {
                createdAt: { lt: cutoff }
              }
            });
            if (purged.count > 0) {
              logger.info(`[TruckHold] Purged ${purged.count} old hold idempotency row(s)`);
              metrics.incrementCounter('hold_idempotency_purged_total', {}, purged.count);
            }
          } finally {
            await redisService.releaseLock('hold-idempotency-purge', `purge-${process.pid}`).catch(() => {});
          }
        }
      }
    } finally {
      // Release the cleanup lock (auto-expires after 60s if we crash)
      await redisService.releaseLock('hold:cleanup:unified', `cleanup-${process.pid}`).catch(() => {});
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[TruckHold] Cleanup job error: ${message}`);
  }
}

// =============================================================================
// STOP CLEANUP JOB
// =============================================================================

/**
 * Stop cleanup job (for graceful shutdown)
 */
export function stopCleanupJob(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    logger.info('[TruckHold] Cleanup job stopped');
  }
}
