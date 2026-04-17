-- =============================================================================
-- M-007 — Outbox leader fencing token (F-A-56)
-- =============================================================================
--
-- Purpose: add a monotonic claim-token column to OrderDispatchOutbox so a
-- previously-stomped leader cannot emit duplicate dispatches. Paired with
-- the CAS leader-election helper (src/shared/services/leader-election.service.ts).
--
-- RISK: LOW (SCHEMA-ADD only; column is NULLABLE; index is partial).
--
-- PRE-CODE SAFE: this migration can land before the code that reads the
-- claim token. Existing code ignores the new column.
--
-- EXECUTION ORDER (do NOT run ahead of schedule):
--   1. Land this file in source control (PR merged).
--   2. Deploy the code behind FF_OUTBOX_LEADER_FENCING=false (default OFF).
--   3. Execute THIS migration on production DB via direct psql (see CLAUDE.md
--      — `_prisma_migrations` table does NOT exist on this DB; never run
--      `prisma migrate deploy`).
--   4. Flip FF_OUTBOX_LEADER_FENCING=true in canary → full rollout.
--   5. Monitor `outbox_leader_elections_total` + `outbox_leader_renewals_failed_total`.
--
-- DO NOT EXECUTE AS PART OF THIS PR. The file is author-of-record only; the
-- operator runs it once the code is deployed and the flag is ready.
--
-- ROLLBACK:
--   ALTER TABLE "OrderDispatchOutbox" DROP COLUMN IF EXISTS "claimToken";
--   DROP SEQUENCE IF EXISTS outbox_fence_seq;
--   DROP INDEX CONCURRENTLY IF EXISTS "idx_odoutbox_unprocessed_fence";
-- =============================================================================

BEGIN;

-- 1. Monotonic sequence — every claim call bumps this and writes it onto
-- the row. If a stomped leader retries after a new leader has advanced the
-- seq, its stale token will not match the row's current claimToken.
DO $$
BEGIN
  CREATE SEQUENCE IF NOT EXISTS outbox_fence_seq START 1 INCREMENT 1;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- 2. Column to carry the claim token. NULL for rows written before the
-- fencing code path is enabled — the code must treat NULL as "legacy, no
-- fence check" and fall back to the SKIP LOCKED guarantee alone.
ALTER TABLE "OrderDispatchOutbox"
  ADD COLUMN IF NOT EXISTS "claimToken" BIGINT NULL;

COMMIT;

-- 3. Partial index for the hot path (unprocessed rows, ordered by retry time).
-- Keep OUTSIDE the transaction because CREATE INDEX CONCURRENTLY cannot run
-- inside a transaction block.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_odoutbox_unprocessed_fence"
  ON "OrderDispatchOutbox" ("nextRetryAt", "claimToken")
  WHERE "processedAt" IS NULL;
