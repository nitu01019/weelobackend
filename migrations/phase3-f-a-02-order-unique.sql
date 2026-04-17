-- =============================================================================
-- F-A-02 — Idempotency Hard-Require + Belt-and-Suspenders Unique Index
-- =============================================================================
--
-- Purpose: mirror the OrderIdempotency(customerId, idempotencyKey) uniqueness
-- onto the Order table so that a race that slips past the Redis/DB idempotency
-- cache still cannot produce duplicate Order rows for the same key.
--
-- Industry references:
--   - Stripe Idempotency-Key (unique-key retry, 24h TTL)
--     https://docs.stripe.com/api/idempotent_requests
--   - IETF draft-ietf-httpapi-idempotency-key-header-07
--     https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-07
--
-- CLAUDE.md rule: direct SQL ONLY — do NOT run `prisma migrate deploy` or
-- `prisma db push`. Execute this file via psql during a maintenance window:
--
--     psql "$DATABASE_URL" -f migrations/phase3-f-a-02-order-unique.sql
--
-- Idempotency of this migration itself:
--   - `ADD COLUMN IF NOT EXISTS` -> safe to re-run, no-op on repeat.
--   - `CREATE UNIQUE INDEX IF NOT EXISTS` with partial predicate -> safe to re-run.
--   - Wrapped in BEGIN/COMMIT so a partial failure rolls back cleanly.
-- =============================================================================

BEGIN;

-- 1. Ensure the Order table has an idempotencyKey column the application layer
--    can populate when creating an order from a client-supplied header. The
--    column is nullable so the partial-unique index below ignores legacy rows
--    that predate the column and any server-generated flows that do not carry
--    a client key.
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

-- 2. Belt-and-suspenders: one-idempotency-key == at-most-one Order row.
--    Relies on the column added above; partial index skips NULLs cleanly.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_order_idempotency_key"
  ON "Order" ("idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

COMMIT;

-- Verification (run AFTER the COMMIT above, manually):
--   \d+ "Order"
-- Expected: idempotencyKey column present; idx_order_idempotency_key listed as
-- UNIQUE, partial (Predicate: "idempotencyKey" IS NOT NULL).
