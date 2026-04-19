-- =============================================================================
-- M-011 — TripRoutePoint table (H-23)
-- =============================================================================
-- Production DB: apply via psql directly.
-- CRITICAL: do NOT run `prisma migrate deploy` or `prisma db push` on prod.
--
-- Purpose: GPS breadcrumb buffer. Used by tracking-history.service.ts and
-- tracking-trip.service.ts (prismaClient.tripRoutePoint.createMany) to flush
-- per-trip location history from Redis to PostgreSQL.
--
-- Apply order: BEFORE code merge. Safe to re-run (idempotent).
-- =============================================================================

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS "TripRoutePoint" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "tripId" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "speed" DOUBLE PRECISION,
    "heading" DOUBLE PRECISION,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TripRoutePoint_pkey" PRIMARY KEY ("id")
  );
EXCEPTION WHEN duplicate_table THEN NULL; END $$;

-- Indexes must be CONCURRENT and OUTSIDE any transaction block.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TripRoutePoint_tripId_timestamp_idx"
  ON "TripRoutePoint"("tripId", "timestamp");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TripRoutePoint_tripId_idx"
  ON "TripRoutePoint"("tripId");

-- Verify:
--   \d+ "TripRoutePoint"
--   SELECT c.relname, i.indisvalid FROM pg_index i
--     JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname IN ('TripRoutePoint_tripId_timestamp_idx','TripRoutePoint_tripId_idx');
