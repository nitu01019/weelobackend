-- =============================================================================
-- Recommended indexes for Weelo Backend 8-Phase Fix Pipeline
-- Run via psql on production. DO NOT use prisma migrate.
-- Each index uses IF NOT EXISTS for idempotency.
-- Use CONCURRENTLY to avoid table locks in production.
-- =============================================================================
--
-- EXISTING INDEXES (already in schema.prisma, do NOT re-create):
--   Assignment: bookingId, truckRequestId, orderId, transporterId, driverId,
--               status, (driverId,status), (transporterId,status), (vehicleId,status)
--   TruckHoldLedger: (orderId,status,expiresAt), (transporterId,status,expiresAt),
--                    (phase,flexExpiresAt), (phase,confirmedExpiresAt)
--
-- The indexes below target query patterns introduced by the fix pipeline
-- and are NOT covered by any existing index.
-- =============================================================================

-- C-7, C-8: Optimize driver earnings and performance queries
-- Queries filter by driverId + status + completedAt for earnings aggregation.
-- Partial index on completed-only rows keeps the index small and fast.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assignment_driver_completed_at
ON "Assignment" ("driverId", "status", "completedAt" DESC)
WHERE "status" = 'completed';

-- H-6: Optimize hold reconciliation expired hold queries
-- Reconciliation cron scans for active holds past their expiresAt.
-- Partial index on FLEX/CONFIRMED phases avoids scanning terminal rows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_truck_hold_ledger_phase_expires
ON "TruckHoldLedger" ("phase", "expiresAt")
WHERE "phase" IN ('FLEX', 'CONFIRMED');

-- C-10: Optimize booking completion check
-- Completion logic counts assignments per bookingId filtered by status.
-- Partial index excludes rows with NULL bookingId (order-based assignments).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assignment_booking_status
ON "Assignment" ("bookingId", "status")
WHERE "bookingId" IS NOT NULL;
