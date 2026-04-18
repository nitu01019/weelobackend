-- =============================================================================
-- Phase-P1 | T1.4 — SC1 + SC2 dispatch-hot-path indexes
-- =============================================================================
-- Tickets:
--   SC1 — idx_user_kyc_broadcast    : User(kycStatus, isVerified, isActive)
--   SC2 — idx_vehicle_key_avail     : Vehicle(vehicleKey, transporterId)
--                                     WHERE isActive = true AND status = 'available'
--
-- Target queries:
--   SC1 — src/modules/order/order-broadcast.service.ts:864-872 (KYC gate)
--         SELECT id FROM "User"
--          WHERE id IN (...)
--            AND "isActive" = true
--            AND "isVerified" = true
--            AND "kycStatus" = 'VERIFIED';
--
--   SC2 — src/shared/database/repositories/vehicle.repository.ts:144-153
--         SELECT "transporterId", "vehicleType", "vehicleSubtype" FROM "Vehicle"
--          WHERE "vehicleKey" IN (...)
--            AND "isActive" = true
--            AND "status"   = 'available';
--
-- DB rules (see CLAUDE.md §"CRITICAL RULES FOR THIS DB"):
--   - The production DB has NO _prisma_migrations table. Do NOT run
--     `prisma migrate deploy` or `prisma db push`. Apply THIS file directly
--     with psql under human-operator control.
--   - CREATE INDEX CONCURRENTLY requires that it NOT be run inside a
--     transaction block (Postgres limitation). Do NOT wrap in BEGIN/COMMIT.
--     IF NOT EXISTS makes each statement individually idempotent.
--   - Concurrent creation avoids an ACCESS EXCLUSIVE lock on the base table,
--     so the broadcast hot path continues serving reads/writes during build.
--
-- Rollback: see bottom of this file + PRODUCTION-INDEX-RUNBOOK-P1.md.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- SC1: idx_user_kyc_broadcast
--
-- Non-partial composite. Leading column kycStatus ('VERIFIED' subset) is
-- the narrowest predicate; isVerified + isActive are low-cardinality boolean
-- filters tacked on for planner confidence. Keeps the index usable for any
-- subset of the three leading-prefix columns (planner flexibility over the
-- smaller-but-stricter partial variant).
-- -----------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_user_kyc_broadcast"
    ON "User" ("kycStatus", "isVerified", "isActive");

-- -----------------------------------------------------------------------------
-- SC2: idx_vehicle_key_avail
--
-- Partial composite. The dispatch hot path ONLY reads rows where
-- isActive=true AND status='available' — excluding inactive/in_transit/
-- maintenance rows from the index keeps it 5-10x smaller and 2-3x faster
-- on the typed WHERE clause. transporterId is the second key column so the
-- planner can satisfy "distinct transporterId" roll-ups without a heap hit.
--
-- Distinct from existing Vehicle indexes:
--   - @@index([vehicleKey])                       (non-partial, single-col)
--   - @@index([status, isActive, vehicleType])    (wrong leading col)
--   - @@index([transporterId, status, isActive])  (wrong leading col)
--   No existing index covers vehicleKey IN (...) + hot-path predicate.
-- -----------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_vehicle_key_avail"
    ON "Vehicle" ("vehicleKey", "transporterId")
    WHERE "isActive" = true AND "status" = 'available';

-- =============================================================================
-- VERIFICATION — run these AFTER both CREATE statements complete.
-- Each query should return exactly one row. indisvalid MUST be true (t).
-- =============================================================================

-- 1. Both indexes exist and are valid (indisvalid=t).
--    If indisvalid=f, the CONCURRENTLY build aborted midway — DROP the
--    invalid index and retry. Do NOT query-plan against an invalid index.
SELECT  c.relname        AS indexname,
        n.nspname        AS schema,
        i.indisvalid     AS valid,
        pg_size_pretty(pg_relation_size(c.oid)) AS size
FROM    pg_index      i
JOIN    pg_class      c ON c.oid = i.indexrelid
JOIN    pg_namespace  n ON n.oid = c.relnamespace
WHERE   c.relname IN ('idx_user_kyc_broadcast', 'idx_vehicle_key_avail')
ORDER BY c.relname;

-- 2. Expected definitions match (partial predicate preserved for SC2).
SELECT indexname, indexdef
FROM   pg_indexes
WHERE  schemaname = 'public'
  AND  indexname IN ('idx_user_kyc_broadcast', 'idx_vehicle_key_avail')
ORDER BY indexname;

-- 3. Planner usage — EXPLAIN ANALYZE the two hot-path queries. The plan
--    lines should mention the new index by name. If you see "Seq Scan on
--    User" or "Seq Scan on Vehicle" at steady state (>30 min post-build),
--    statistics are stale — run ANALYZE "User"; ANALYZE "Vehicle";
--
--    SC1:
--    EXPLAIN (ANALYZE, BUFFERS)
--    SELECT id FROM "User"
--     WHERE id = ANY (ARRAY['<tid1>','<tid2>','<tid3>']::text[])
--       AND "isActive"   = true
--       AND "isVerified" = true
--       AND "kycStatus"  = 'VERIFIED';
--    -- Expected: "Index Scan using idx_user_kyc_broadcast" or the index
--    -- combined with the PK via BitmapAnd, depending on planner stats.
--
--    SC2:
--    EXPLAIN (ANALYZE, BUFFERS)
--    SELECT "transporterId", "vehicleType", "vehicleSubtype"
--      FROM "Vehicle"
--     WHERE "vehicleKey" IN ('open_17ft','open_17_ft_open')
--       AND "isActive"  = true
--       AND "status"    = 'available';
--    -- Expected: "Index Scan using idx_vehicle_key_avail"

-- 4. First-hour usage telemetry — after the director confirms app traffic
--    has exercised the broadcast + dispatch paths, idx_scan for both rows
--    should be >0. A sustained 0 at t+24h indicates the planner is
--    skipping the index; open an investigation ticket.
SELECT  indexrelname AS indexname,
        idx_scan,
        idx_tup_read,
        idx_tup_fetch
FROM    pg_stat_user_indexes
WHERE   indexrelname IN ('idx_user_kyc_broadcast', 'idx_vehicle_key_avail')
ORDER BY indexrelname;

-- =============================================================================
-- ROLLBACK (non-blocking; run as separate statements, NOT in a transaction):
--   DROP INDEX CONCURRENTLY IF EXISTS "idx_user_kyc_broadcast";
--   DROP INDEX CONCURRENTLY IF EXISTS "idx_vehicle_key_avail";
-- =============================================================================
