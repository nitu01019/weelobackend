-- =============================================================================
-- M-006 — F-A-64 VehicleTransitionOutbox (LOW RISK, SCHEMA-ADD)
-- =============================================================================
-- FILE ONLY — DO NOT EXECUTE. Run directly via psql when deploying.
--
-- Purpose:
--   Durable transactional outbox for Vehicle.status transitions. Replaces the
--   post-TX try/catch dual-write at order-accept.service.ts:486-500 where a
--   Redis failure during onVehicleTransition() silently left the DB at
--   'on_hold' while live-availability/fleet-cache kept the vehicle visible as
--   'available' — producing double-booking windows.
--
-- How it works:
--   1. Inside the main accept transaction we INSERT a row into this table
--      (part of the same commit as the Vehicle.status update).
--   2. A leader-elected poller (vehicle-transition-outbox.service.ts) picks up
--      unprocessed rows via SELECT ... FOR UPDATE SKIP LOCKED and calls
--      onVehicleTransition() with exponential back-off retry + DLQ after 5
--      attempts.
--   3. Successful rows have processedAt set; DLQ rows keep processedAt NULL
--      and lastError populated so they surface in monitoring.
--
-- Contract:
--   - vehicleId/transporterId/fromStatus/toStatus are always present.
--   - vehicleKey is optional because legacy vehicles may not have one; the
--     poller skips the liveAvailability side effect when vehicleKey is null.
--   - claimToken is reserved for future fencing if the poller is ever split
--     across multiple workers; today leader-election serializes access so it
--     is written but not enforced.
-- =============================================================================

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS "VehicleTransitionOutbox" (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "vehicleId" text NOT NULL,
    "vehicleKey" text,
    "transporterId" text NOT NULL,
    "fromStatus" text NOT NULL,
    "toStatus" text NOT NULL,
    "reason" text,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "processedAt" timestamptz,
    "attempts" int NOT NULL DEFAULT 0,
    "lastError" text,
    "claimToken" bigint
  );
EXCEPTION WHEN duplicate_table THEN NULL; END $$;

-- Partial index on unprocessed rows only — keeps the poller's
-- "WHERE processedAt IS NULL" scan O(unprocessed) rather than O(total).
-- CONCURRENTLY so index creation on a populated table does not block writers.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_vtoutbox_unprocessed"
  ON "VehicleTransitionOutbox" ("createdAt")
  WHERE "processedAt" IS NULL;
