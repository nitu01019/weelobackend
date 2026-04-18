-- =============================================================================
-- M-001 — F-B-91 broadcast-expiry SQL pushdown (LOW RISK, SCHEMA-ADD)
-- =============================================================================
--
-- Purpose: partial index on Order.expiresAt for active-order statuses. The
-- F-B-91 broadcast-expiry reconciler queries rows where expiresAt <= NOW()
-- AND status IN ('broadcasting','active','partially_filled'); without this
-- index the scan is a sequential Order-table sweep every tick. With this
-- index the reconciler becomes an index-only range probe.
--
-- RISK: LOW (SCHEMA-ADD only; partial index; CONCURRENTLY avoids table lock).
--
-- PRE-CODE SAFE: No dependencies. Pre-code deploy safe — existing queries
-- that match the predicate will gain benefit immediately, and queries that
-- do not match are unaffected.
--
-- EXECUTION ORDER:
--   1. Land this file in source control (PR merged — this PR).
--   2. Operator runs THIS migration on production DB via direct psql, OUTSIDE
--      any BEGIN/COMMIT block (CREATE INDEX CONCURRENTLY cannot run inside
--      a transaction).
--   3. Verify: `\d "Order"` shows `idx_orders_active_expiry`.
--   4. F-B-91 P8 consumer code may land before or after — either order works.
--
-- DO NOT EXECUTE AS PART OF THIS PR. Files are author-of-record only;
-- operator runs them manually. Per CLAUDE.md, the production DB has no
-- `_prisma_migrations` table — never use `prisma migrate deploy`.
--
-- ROLLBACK:
--   DROP INDEX CONCURRENTLY IF EXISTS idx_orders_active_expiry;
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_active_expiry
  ON "Order" ("expiresAt")
  WHERE status IN ('broadcasting','active','partially_filled');
