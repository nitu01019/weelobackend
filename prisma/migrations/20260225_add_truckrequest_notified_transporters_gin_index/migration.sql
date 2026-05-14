-- Phase 2 Fix #25 NOTE: the `SET LOCAL lock_timeout / statement_timeout` headers
-- prepended to the other 6 migration.sql files are OMITTED here because this file
-- is `-- prisma:no-transaction` (L24, required for CREATE INDEX CONCURRENTLY).
-- `SET LOCAL` is transaction-scoped and would be a silent no-op outside a transaction.
-- Operator runbook PATH A at L13 below already uses session-level `SET lock_timeout`
-- (not SET LOCAL) for the manual psql application path. CREATE INDEX CONCURRENTLY
-- uses SHARE UPDATE EXCLUSIVE lock (non-blocking) so the ACCESS EXCLUSIVE timeout
-- protection from the headers isn't required for this migration.

-- HEAD a43aebea: this file currently contains a NON-CONCURRENT CREATE INDEX. At 400-500 RPS
-- with TruckRequest as a hot dispatch-path table, building a non-concurrent GIN index acquires
-- SHARE lock and blocks all writes until the build finishes — multi-second stall = deploy outage.
--
-- Per CLAUDE.md L477-485 the prod DB has no _prisma_migrations table, so `prisma migrate deploy`
-- never actually runs this file at HEAD. The fix is future-proofing for two paths:
--
--   PATH A (current state): operator applies this index manually via psql under weelo_migrator
--     role — see scripts/bootstrap-prisma-migrations.sh / runbooks/M-007. Steps:
--       1. psql "$DATABASE_URL" -c 'SET lock_timeout = "3s";'
--       2. psql "$DATABASE_URL" -c 'CREATE INDEX CONCURRENTLY IF NOT EXISTS
--              "TruckRequest_notifiedTransporters_gin_idx" ON "TruckRequest"
--              USING GIN ("notifiedTransporters");'
--       3. Verify: psql -c '\d "TruckRequest"' shows the index as VALID (not INVALID).
--
--   PATH B (post-Bootstrap PR-0, after _prisma_migrations exists and migrate deploy is wired):
--     The `-- prisma:no-transaction` marker below tells Prisma 5.x to skip the implicit BEGIN/COMMIT,
--     which is REQUIRED because CREATE INDEX CONCURRENTLY cannot run inside a transaction
--     (Postgres docs: https://www.postgresql.org/docs/current/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY).

-- prisma:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TruckRequest_notifiedTransporters_gin_idx"
ON "TruckRequest"
USING GIN ("notifiedTransporters");

-- Operator runbook addition (M-007, append after existing steps):
-- If a previous attempt failed mid-build, the index is left in INVALID state.
-- Verify and recover:
--   psql "$DATABASE_URL" -c "SELECT indexrelid::regclass, indisvalid FROM pg_index
--                            WHERE indexrelid::regclass::text LIKE '%notifiedTransporters_gin%';"
-- If indisvalid = false, drop and recreate:
--   psql "$DATABASE_URL" -c "DROP INDEX CONCURRENTLY IF EXISTS \"TruckRequest_notifiedTransporters_gin_idx\";"
-- Then re-run the CREATE INDEX CONCURRENTLY above.

-- SPLIT requirement: CREATE INDEX CONCURRENTLY is the ONLY DDL statement in this migration file.
-- Do not add additional DDL — Postgres rejects CONCURRENTLY mixed with other statements in the
-- same implicit transaction. Future TruckRequest schema changes must land in a separate file.
