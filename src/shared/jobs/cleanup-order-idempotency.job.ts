/**
 * ORDER IDEMPOTENCY CLEANUP JOB (Issue #14)
 *
 * Deletes stale OrderIdempotency and OrderCancelIdempotency rows older than
 * RETENTION_DAYS to prevent unbounded table growth. The idempotency window
 * for duplicate POSTs is minutes-to-hours, so rows older than 7 days are
 * safe to delete (clients can no longer replay them).
 *
 * Runs every 1 hour with a Redis distributed lock so only one ECS instance
 * processes at a time. Deletes in batches of 1000 by id to avoid long-running
 * transactions that would hold locks.
 *
 * Follows the pattern of cleanup-status-events.job.ts.
 */
import { logger } from '../services/logger.service';
import { prismaClient as prisma } from '../database/prisma.service';
import { redisService } from '../services/redis.service';

const RETENTION_DAYS = Math.max(
  1,
  parseInt(process.env.ORDER_IDEMPOTENCY_RETENTION_DAYS || '7', 10) || 7
);

const DELETE_BATCH_SIZE = 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const LOCK_TTL_SECONDS = 120;
const LOCK_KEY = 'cleanup-order-idempotency';
const LOCK_HOLDER = 'order-idempotency-cleanup';

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

async function deleteStaleOrderIdempotency(cutoffDate: Date): Promise<number> {
  let totalDeleted = 0;
  let hasMore = true;

  while (hasMore) {
    const stale = await prisma.orderIdempotency.findMany({
      where: { createdAt: { lt: cutoffDate } },
      select: { id: true },
      take: DELETE_BATCH_SIZE,
      orderBy: { createdAt: 'asc' },
    });

    if (stale.length === 0) {
      hasMore = false;
      break;
    }

    const ids = stale.map((r) => r.id);
    const { count } = await prisma.orderIdempotency.deleteMany({
      where: { id: { in: ids } },
    });
    totalDeleted += count;

    if (stale.length < DELETE_BATCH_SIZE) {
      hasMore = false;
    }
  }

  return totalDeleted;
}

async function deleteStaleOrderCancelIdempotency(cutoffDate: Date): Promise<number> {
  let totalDeleted = 0;
  let hasMore = true;

  while (hasMore) {
    const stale = await prisma.orderCancelIdempotency.findMany({
      where: { createdAt: { lt: cutoffDate } },
      select: { id: true },
      take: DELETE_BATCH_SIZE,
      orderBy: { createdAt: 'asc' },
    });

    if (stale.length === 0) {
      hasMore = false;
      break;
    }

    const ids = stale.map((r) => r.id);
    const { count } = await prisma.orderCancelIdempotency.deleteMany({
      where: { id: { in: ids } },
    });
    totalDeleted += count;

    if (stale.length < DELETE_BATCH_SIZE) {
      hasMore = false;
    }
  }

  return totalDeleted;
}

/**
 * Core cleanup logic. Acquires a distributed lock, then deletes old
 * OrderIdempotency and OrderCancelIdempotency rows in batches.
 */
async function cleanupOrderIdempotency(): Promise<void> {
  let lockAcquired = false;

  try {
    const lockResult = await redisService.acquireLock(
      LOCK_KEY,
      LOCK_HOLDER,
      LOCK_TTL_SECONDS
    );
    lockAcquired = lockResult.acquired;
    if (!lockAcquired) {
      // Another instance is already running this job
      return;
    }
  } catch (lockErr: unknown) {
    // Redis down -- proceed without lock (better to double-process than skip)
    logger.warn(
      `[ORDER_IDEMPOTENCY_CLEANUP] Lock acquisition failed, proceeding without lock: ${
        lockErr instanceof Error ? lockErr.message : String(lockErr)
      }`
    );
  }

  try {
    const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    logger.info(
      `[ORDER_IDEMPOTENCY_CLEANUP] Starting cleanup of rows older than ${RETENTION_DAYS} days (cutoff: ${cutoffDate.toISOString()})`
    );

    const deletedCreate = await deleteStaleOrderIdempotency(cutoffDate);
    const deletedCancel = await deleteStaleOrderCancelIdempotency(cutoffDate);

    logger.info(
      `[ORDER_IDEMPOTENCY_CLEANUP] Deleted ${deletedCreate} OrderIdempotency + ${deletedCancel} OrderCancelIdempotency rows older than ${RETENTION_DAYS} days`
    );
  } catch (error: unknown) {
    logger.error(
      `[ORDER_IDEMPOTENCY_CLEANUP] Error during cleanup: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    if (lockAcquired) {
      try {
        await redisService.releaseLock(LOCK_KEY, LOCK_HOLDER);
      } catch (_) {
        // Lock will auto-expire in LOCK_TTL_SECONDS anyway
      }
    }
  }
}

/**
 * Start the periodic cleanup job (every 1 hour).
 * Safe to call multiple times -- only one interval will be created.
 */
export function startIdempotencyCleanupJob(): void {
  if (cleanupInterval) return;

  logger.info(
    `[ORDER_IDEMPOTENCY_CLEANUP] Starting automated cleanup job (every 1 hour, retention=${RETENTION_DAYS} days)`
  );

  // Run once on startup
  cleanupOrderIdempotency().catch((err: unknown) => {
    logger.error('[ORDER_IDEMPOTENCY_CLEANUP] Initial run failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  cleanupInterval = setInterval(() => {
    cleanupOrderIdempotency().catch((err: unknown) => {
      logger.error('[ORDER_IDEMPOTENCY_CLEANUP] Scheduled run failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, ONE_HOUR_MS);
  cleanupInterval.unref();
}

/**
 * Stop the cleanup job (for graceful shutdown / tests).
 */
export function stopIdempotencyCleanupJob(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    logger.info('[ORDER_IDEMPOTENCY_CLEANUP] Cleanup job stopped');
  }
}
