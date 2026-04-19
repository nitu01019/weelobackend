// @ts-nocheck
/**
 * STATUS EVENT CLEANUP JOB
 *
 * Deletes StatusEvent rows older than RETENTION_DAYS to prevent
 * unbounded table growth. Runs every 6 hours with a distributed lock
 * so only one ECS instance processes at a time.
 *
 * Follows the same pattern as cleanup-expired-orders.job.ts.
 */

import { logger } from '../services/logger.service';
import { prismaClient as prisma } from '../database/prisma.service';
import { redisService } from '../services/redis.service';

const RETENTION_DAYS = Math.max(
  1,
  parseInt(process.env.STATUS_EVENT_RETENTION_DAYS || '90', 10) || 90
);

const DELETE_BATCH_SIZE = 1000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const LOCK_TTL_SECONDS = 120;

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Core cleanup logic. Acquires a distributed lock, then deletes old
 * StatusEvent rows in batches of 1000 until none remain.
 */
async function cleanupStatusEvents(): Promise<void> {
  // Standardized: lock: prefix for all distributed locks (added by acquireLock automatically)
  const lockKey = 'cleanup-status-events';
  let lockAcquired = false;

  try {
    const lockResult = await redisService.acquireLock(lockKey, 'status-event-cleanup', LOCK_TTL_SECONDS);
    lockAcquired = lockResult.acquired;
    if (!lockAcquired) {
      // Another instance is already running this job
      return;
    }
  } catch (lockErr: unknown) {
    // Redis down -- proceed without lock (better to double-process than skip)
    logger.warn(`[STATUS_EVENT_CLEANUP] Lock acquisition failed, proceeding without lock: ${lockErr instanceof Error ? lockErr.message : String(lockErr)}`);
  }

  try {
    const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    let totalDeleted = 0;

    logger.info(`[STATUS_EVENT_CLEANUP] Starting cleanup of events older than ${RETENTION_DAYS} days (cutoff: ${cutoffDate.toISOString()})`);

    // Delete in batches: find IDs first, then deleteMany by IDs
    // (Prisma deleteMany does not support `take`)
    let hasMore = true;
    while (hasMore) {
      const staleEvents = await prisma.statusEvent.findMany({
        where: { createdAt: { lt: cutoffDate } },
        select: { id: true },
        take: DELETE_BATCH_SIZE,
        orderBy: { createdAt: 'asc' },
      });

      if (staleEvents.length === 0) {
        hasMore = false;
        break;
      }

      const ids = staleEvents.map((e) => e.id);
      const { count } = await prisma.statusEvent.deleteMany({
        where: { id: { in: ids } },
      });

      totalDeleted += count;

      // If we got fewer than the batch size, there are no more rows to delete
      if (staleEvents.length < DELETE_BATCH_SIZE) {
        hasMore = false;
      }
    }

    logger.info(`[STATUS_EVENT_CLEANUP] Deleted ${totalDeleted} events older than ${RETENTION_DAYS} days`);
  } catch (error: unknown) {
    logger.error(`[STATUS_EVENT_CLEANUP] Error during cleanup: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (lockAcquired) {
      try {
        await redisService.releaseLock(lockKey, 'status-event-cleanup');
      } catch (_) {
        // Lock will auto-expire in LOCK_TTL_SECONDS anyway
      }
    }
  }
}

/**
 * Start the periodic cleanup job (every 6 hours).
 * Safe to call multiple times -- only one interval will be created.
 */
export function startStatusEventCleanup(): void {
  if (cleanupInterval) return;

  logger.info(`[STATUS_EVENT_CLEANUP] Starting automated cleanup job (every 6 hours, retention=${RETENTION_DAYS} days)`);

  // Run once on startup
  cleanupStatusEvents().catch((err: unknown) => {
    logger.error('[STATUS_EVENT_CLEANUP] Initial run failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Then every 6 hours
  cleanupInterval = setInterval(() => {
    cleanupStatusEvents().catch((err: unknown) => {
      logger.error('[STATUS_EVENT_CLEANUP] Scheduled run failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, SIX_HOURS_MS);
  cleanupInterval.unref();
}

/**
 * Stop the cleanup job (for graceful shutdown).
 */
export function stopStatusEventCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    logger.info('[STATUS_EVENT_CLEANUP] Cleanup job stopped');
  }
}
