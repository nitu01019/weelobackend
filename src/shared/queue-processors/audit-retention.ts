/**
 * A12-019 — StatusEvent 90-day retention prune
 *
 * Link-to-VERIFICATION-doc: .planning/re-review-2026-04-23/VERIFICATION/A12-019.md
 * Kill-switch: FF_AUDIT_RETENTION_PRUNE (default false)
 * Rollback: FF_AUDIT_RETENTION_PRUNE=false
 *
 * Regulatory context:
 *   - DPDP Act 2023 §5(b) — purpose limitation: audit records must not persist
 *     longer than necessary for the declared purpose.
 *   - GDPR Art 5(1)(e) — storage limitation.
 *
 * Implementation notes:
 *   - Batched delete with pg_sleep(0.1) between batches to avoid long-lock +
 *     WAL spike on the large StatusEvent table at scale.
 *   - Scheduled off-peak (03:00 UTC) to minimise concurrent-query impact.
 *   - CloudWatch alarm: job runtime > 5 min triggers investigation.
 *
 * Appendix D.6 direct SQL (documented; run by this processor):
 *
 *     DO $$
 *     DECLARE deleted INTEGER := 1;
 *     BEGIN
 *       WHILE deleted > 0 LOOP
 *         WITH del AS (
 *           DELETE FROM "StatusEvent"
 *           WHERE "createdAt" < NOW() - INTERVAL '90 days'
 *           ORDER BY "createdAt" LIMIT 10000
 *           RETURNING 1
 *         )
 *         SELECT COUNT(*) INTO deleted FROM del;
 *         PERFORM pg_sleep(0.1);
 *       END LOOP;
 *     END $$;
 */

import { prismaClient } from '../database/prisma.service';
import { logger } from '../services/logger.service';
import { metrics as metricsService } from '../monitoring/metrics.service';
import { FLAGS, isEnabled } from '../config/feature-flags';
import { redisService } from '../services/redis.service';

const RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS ?? 90);
const BATCH_SIZE = Number(process.env.AUDIT_RETENTION_BATCH_SIZE ?? 10_000);
const SLEEP_BETWEEN_BATCHES_MS = Number(process.env.AUDIT_RETENTION_SLEEP_MS ?? 100);

// E3-4 / hardening_E §2.3: scheduler tunables.
const SCHEDULE_INTERVAL_MS = Number(process.env.AUDIT_RETENTION_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
const LEADER_LOCK_KEY = 'audit-retention-lead';
const LEADER_LOCK_HOLDER = 'audit-retention-scheduler';
const LEADER_LOCK_TTL_SECONDS = Number(process.env.AUDIT_RETENTION_LOCK_TTL_S ?? 300);

/**
 * One-shot prune executor. Returns the number of rows deleted this run.
 * Idempotent — the WHERE clause is time-based.
 */
export async function pruneExpiredStatusEvents(): Promise<number> {
  if (!isEnabled(FLAGS.AUDIT_RETENTION_PRUNE)) {
    logger.debug('[audit-retention] FF_AUDIT_RETENTION_PRUNE=false; skipping prune');
    return 0;
  }

  const startedAt = Date.now();
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let totalDeleted = 0;

  try {
    // Loop batched deletes until a batch returns zero rows.
    // Using raw SQL because we want ORDER BY + LIMIT inside DELETE;
    // Prisma's deleteMany does not support LIMIT on Postgres.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await prismaClient.$executeRaw`
        WITH del AS (
          DELETE FROM "StatusEvent"
          WHERE "createdAt" < ${cutoff}
          AND id IN (
            SELECT id FROM "StatusEvent"
            WHERE "createdAt" < ${cutoff}
            ORDER BY "createdAt" ASC
            LIMIT ${BATCH_SIZE}
          )
          RETURNING 1
        )
        SELECT COUNT(*) FROM del;
      `;
      // Prisma $executeRaw returns rowCount
      const deletedThisBatch = Number(result) || 0;
      totalDeleted += deletedThisBatch;

      if (deletedThisBatch === 0) break;

      // pg_sleep equivalent — yield event loop + relieve WAL pressure
      await new Promise((r) => setTimeout(r, SLEEP_BETWEEN_BATCHES_MS));
    }

    const elapsedMs = Date.now() - startedAt;
    logger.info('[audit-retention] StatusEvent prune complete', {
      totalDeleted,
      elapsedMs,
      retentionDays: RETENTION_DAYS,
    });

    try {
      metricsService.incrementCounter('audit_retention_pruned_total', {}, totalDeleted);
    } catch {
      // Counter may not be registered in some bootstrap paths; treat as observability-only.
    }

    return totalDeleted;
  } catch (err: unknown) {
    logger.error('[audit-retention] Prune failed', {
      error: err instanceof Error ? err.message : String(err),
      totalDeletedBeforeFailure: totalDeleted,
    });
    try {
      metricsService.incrementCounter('audit_retention_failed_total');
    } catch {
      // noop
    }
    throw err;
  }
}

// =============================================================================
// E3-4 (OAD-3 FOLD) — Audit-retention scheduler
// -----------------------------------------------------------------------------
// Appends to audit-retention.ts (single-file precedent: delay-poller.ts).
// Behaviour contract:
//   1. Pre-boot table-presence preflight (E-01) — if `StatusEvent` is missing,
//      skip registration and return without scheduling.
//   2. Boot-time flag gate (E-01 preserve-OFF) — if FF_AUDIT_RETENTION_PRUNE
//      is OFF at boot, skip registration. (Restart re-evaluates.)
//   3. Runtime-tick gate (V4-E1 / E-03) — every interval fire re-reads the
//      flag inside the worker. Flipping `FF_AUDIT_RETENTION_PRUNE=false` at
//      runtime takes effect on the next tick (≤ SCHEDULE_INTERVAL_MS).
//      `pruneExpiredStatusEvents()` already early-returns when OFF.
//   4. Leader lock (E-03) — `redisService.acquireLock('audit-retention-lead',
//      ...)` ensures only one ECS instance prunes per tick. TTL covers the
//      worst-case run (CloudWatch alarm at 5 min).
//
// Irreversible row-loss warning (V4 §14 / E-05): flag ON begins permanent
// row deletion. Flipping OFF stops future deletions but does NOT recover
// pruned rows. DPDP Act 2023 §5(b) / GDPR Art 5(1)(e) one-way door.
// =============================================================================

let auditRetentionInterval: ReturnType<typeof setInterval> | null = null;

async function statusEventTablePresent(): Promise<boolean> {
  try {
    await prismaClient.$queryRaw`SELECT 1 FROM "StatusEvent" LIMIT 1`;
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[audit-retention] StatusEvent table missing — skipping scheduler registration: ${msg}`);
    return false;
  }
}

/**
 * One scheduler tick: leader-locked invocation of the prune. Re-reads the
 * feature flag every fire so runtime kill-switch takes effect without redeploy.
 */
async function runScheduledPrune(): Promise<void> {
  // Runtime tick gate — flag may have been flipped since boot.
  if (!isEnabled(FLAGS.AUDIT_RETENTION_PRUNE)) {
    logger.debug('[audit-retention] tick skipped: FF_AUDIT_RETENTION_PRUNE=false');
    return;
  }

  let lockHeld = false;
  try {
    const lockResult = await redisService.acquireLock(
      LEADER_LOCK_KEY,
      LEADER_LOCK_HOLDER,
      LEADER_LOCK_TTL_SECONDS
    );
    lockHeld = lockResult.acquired;
    if (!lockHeld) {
      logger.debug('[audit-retention] tick skipped: another instance holds leader lock');
      return;
    }
  } catch (lockErr: unknown) {
    const lockMsg = lockErr instanceof Error ? lockErr.message : String(lockErr);
    logger.warn(`[audit-retention] leader lock acquire failed (skipping tick): ${lockMsg}`);
    return;
  }

  try {
    await pruneExpiredStatusEvents();
  } catch (err: unknown) {
    // pruneExpiredStatusEvents already logs + increments audit_retention_failed_total.
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[audit-retention] tick failed (non-fatal, will retry next interval): ${msg}`);
  } finally {
    if (lockHeld) {
      try {
        await redisService.releaseLock(LEADER_LOCK_KEY, LEADER_LOCK_HOLDER);
      } catch {
        // Lock auto-expires at LEADER_LOCK_TTL_SECONDS; release-failure is non-fatal.
      }
    }
  }
}

/**
 * Register the audit-retention prune scheduler. Idempotent — repeated calls
 * are no-ops once the interval is registered. Safe to call from server.ts
 * boot. Does NOT throw; logs and returns on any setup error so the rest of
 * the boot sequence is unaffected.
 *
 * Skip conditions (no-op return):
 *   - FF_AUDIT_RETENTION_PRUNE OFF at boot (preserve-OFF invariant).
 *   - StatusEvent table missing (E-01 preflight; SQL not yet applied).
 */
export async function registerAuditRetentionSchedule(): Promise<void> {
  if (auditRetentionInterval) {
    logger.debug('[audit-retention] scheduler already registered; skipping');
    return;
  }

  if (!isEnabled(FLAGS.AUDIT_RETENTION_PRUNE)) {
    logger.info('[audit-retention] FF_AUDIT_RETENTION_PRUNE=false at boot; scheduler not registered');
    return;
  }

  const tablePresent = await statusEventTablePresent();
  if (!tablePresent) {
    return;
  }

  auditRetentionInterval = setInterval(() => {
    runScheduledPrune().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[audit-retention] scheduled tick crashed: ${msg}`);
    });
  }, SCHEDULE_INTERVAL_MS);
  auditRetentionInterval.unref();

  logger.info(
    `[audit-retention] scheduler registered (interval=${SCHEDULE_INTERVAL_MS}ms, retention=${RETENTION_DAYS}d, batch=${BATCH_SIZE})`
  );
}

/**
 * Stop the scheduler (graceful shutdown / test cleanup).
 */
export function unregisterAuditRetentionSchedule(): void {
  if (auditRetentionInterval) {
    clearInterval(auditRetentionInterval);
    auditRetentionInterval = null;
    logger.info('[audit-retention] scheduler unregistered');
  }
}
