-- =============================================================================
-- M-015 — P4 F2.NEW-3 Flex-hold dedup partial unique index (LOW RISK, SCHEMA-ADD)
-- =============================================================================
-- FILE ONLY — DO NOT EXECUTE. Run directly via psql when deploying.
--
-- Purpose:
--   Belt-and-suspenders DB-level partial unique index that makes it impossible
--   to have two non-terminal TruckHoldLedger rows for the same
--   (orderId, transporterId) pair, even if the app-level Redis lock + serializable
--   transaction in flex-hold.service.ts::createFlexHold() both fail (Redis outage,
--   isolation-level misconfig, or a future code path that bypasses the service).
--
-- How it works:
--   1. App-level defense (primary): P4 F2.5 acquires a Redis lock keyed by
--      (orderId, transporterId) BEFORE the dedup findFirst runs. P4 F2.NEW-3
--      wraps the findFirst+create in a Serializable tx with FOR UPDATE.
--   2. DB-level defense (this index): if both of the above somehow allow two
--      concurrent INSERTs through, PostgreSQL rejects the second with P2002.
--      The service handler catches P2002 and returns the winning row — so the
--      caller still gets an idempotent response.
--
-- Why partial (WHERE phase NOT IN ('EXPIRED', 'RELEASED')):
--   - EXPIRED / RELEASED holds are historical records and must be allowed to
--     coexist with a new active hold for the same pair.
--   - Only active / flex-active / confirmed rows need to be unique per pair.
--
-- Contract:
--   - Mirrors the in-app dedup predicate in createFlexHold().
--   - CONCURRENTLY so index creation on a populated table does not block writers.
--   - IF NOT EXISTS so re-running this file is a no-op.
-- =============================================================================

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "truck_hold_ledger_active_per_order_transporter_uniq"
  ON "TruckHoldLedger" ("orderId", "transporterId")
  WHERE "phase" NOT IN ('EXPIRED', 'RELEASED');
