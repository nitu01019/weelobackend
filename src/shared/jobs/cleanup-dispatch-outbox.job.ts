/**
 * DISPATCH OUTBOX CLEANUP JOB (Fix #10)
 *
 * Deletes `OrderDispatchOutbox` rows where status='dispatched' AND
 * processedAt < cutoff. Prevents @@index([status, nextRetryAt, createdAt])
 * bloat as dispatched rows accumulate.
 *
 * Correctness invariants:
 *  - status='dispatched' is DISJOINT from the live dispatch poller workset
 *    (which selects status IN ('pending','retrying') per
 *    order-dispatch-outbox.service.ts:171). No starvation by design.
 *  - FOR UPDATE SKIP LOCKED (PG 9.5+) — if a row is locked, skip rather
 *    than block. Cleanup picks it up on the next iteration.
 *  - SET LOCAL statement_timeout=10s per DELETE — bounds the per-batch
 *    blast radius if PG ever blocks (e.g., autovacuum overlap).
 *  - MAX_ITERATIONS × DELETE_BATCH_LIMIT = 100K rows/run hard cap.
 */

import type { PrismaClient } from '@prisma/client';
import { prismaClient } from '../database/prisma.service';
import { logger as defaultLogger } from '../services/logger.service';
import { redisService } from '../services/redis.service';

const RETENTION_DAYS = Math.max(
  1,
  parseInt(process.env.DISPATCH_OUTBOX_RETENTION_DAYS || '7', 10) || 7
);
const DELETE_BATCH_LIMIT = 5000;
const MAX_ITERATIONS = 20; // hard cap: 20 × 5000 = 100K rows/run
const RUN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const LOCK_KEY = 'cleanup:dispatch-outbox';
const LOCK_TTL_SECONDS = 60;
const PER_DELETE_TIMEOUT_MS = 10_000;

export interface OutboxCleanupDeps {
  now: () => Date;
  lock: {
    acquire: (key: string, holder: string, ttl: number) => Promise<{ acquired: boolean }>;
    release: (key: string, holder: string) => Promise<boolean>;
  };
  prisma: Pick<PrismaClient, '$transaction'>;
  logger: {
    info: (msg: string, meta?: object) => void;
    warn: (msg: string, meta?: object) => void;
  };
  workerId: string;
}

export interface OutboxCleanupResult {
  deleted: number;
  iterations: number;
  skipped: boolean;
}

export function defaultDeps(): OutboxCleanupDeps {
  return {
    now: () => new Date(),
    lock: {
      acquire: (k, h, ttl) => redisService.acquireLock(k, h, ttl),
      release: (k, h) => redisService.releaseLock(k, h),
    },
    prisma: prismaClient,
    logger: defaultLogger,
    workerId: process.env.HOSTNAME || `cleanup-${process.pid}`,
  };
}

export async function runOnce(
  deps: OutboxCleanupDeps = defaultDeps()
): Promise<OutboxCleanupResult> {
  const lockResult = await deps.lock.acquire(LOCK_KEY, deps.workerId, LOCK_TTL_SECONDS);
  if (!lockResult.acquired) {
    return { deleted: 0, iterations: 0, skipped: true };
  }

  let total = 0;
  let iterations = 0;
  try {
    const cutoff = new Date(deps.now().getTime() - RETENTION_DAYS * 86_400_000);
    deps.logger.info('[OutboxCleanup:Dispatch] Starting', {
      cutoffIso: cutoff.toISOString(),
      retentionDays: RETENTION_DAYS,
      batchLimit: DELETE_BATCH_LIMIT,
      maxIterations: MAX_ITERATIONS,
    });

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      iterations = i + 1;
      // $executeRaw returns PrismaPromise<number> per .prisma/client/index.d.ts:386
      const deletedThisIter: number = await deps.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `SET LOCAL statement_timeout = ${PER_DELETE_TIMEOUT_MS}`
          );
          const rows: number = await tx.$executeRaw`
            DELETE FROM "OrderDispatchOutbox"
            WHERE id IN (
              SELECT id FROM "OrderDispatchOutbox"
              WHERE "status" = 'dispatched'
                AND "processedAt" IS NOT NULL
                AND "processedAt" < ${cutoff}
              ORDER BY "processedAt" ASC
              LIMIT ${DELETE_BATCH_LIMIT}
              FOR UPDATE SKIP LOCKED
            )
          `;
          return rows;
        },
        {
          timeout: PER_DELETE_TIMEOUT_MS + 2_000,
          maxWait: 5_000,
        }
      );

      total += deletedThisIter;
      if (deletedThisIter < DELETE_BATCH_LIMIT) break;
    }

    deps.logger.info('[OutboxCleanup:Dispatch] Done', {
      deleted: total,
      iterations,
      cappedAtMaxIterations:
        iterations === MAX_ITERATIONS &&
        total >= MAX_ITERATIONS * DELETE_BATCH_LIMIT,
    });
    return { deleted: total, iterations, skipped: false };
  } catch (err: unknown) {
    deps.logger.warn('[OutboxCleanup:Dispatch] Run failed', {
      error: err instanceof Error ? err.message : String(err),
      deletedBeforeError: total,
      iterations,
    });
    return { deleted: total, iterations, skipped: false };
  } finally {
    await deps.lock.release(LOCK_KEY, deps.workerId).catch((relErr: unknown) => {
      deps.logger.warn('[OutboxCleanup:Dispatch] Lock release failed (non-fatal)', {
        error: relErr instanceof Error ? relErr.message : String(relErr),
      });
    });
  }
}

export function startCleanupDispatchOutbox(): NodeJS.Timeout {
  const timer = setInterval(() => {
    runOnce().catch((err: unknown) => {
      defaultLogger.warn('[OutboxCleanup:Dispatch] Tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, RUN_INTERVAL_MS);
  timer.unref();
  return timer;
}
