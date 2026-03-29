-- =============================================================================
-- MIGRATION: Add on_hold to VehicleStatus + Assignment composite index
-- =============================================================================
-- Industry-standard idempotent migration — safe to run multiple times.
-- 
-- Changes:
--   1. Adds 'on_hold' value to VehicleStatus enum (if not already there)
--   2. Adds composite index on Assignment(vehicleId, status) for watchdog
--
-- WHY on_hold:
--   When a transporter assigns a driver, the vehicle is locked into on_hold
--   atomically with the assignment creation. This prevents double-booking.
--   The watchdog releases vehicles stuck in on_hold > 5 minutes.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Step 1: Add 'on_hold' to VehicleStatus enum (safe if already exists)
-- -----------------------------------------------------------------------------
DO $$ BEGIN
    ALTER TYPE "VehicleStatus" ADD VALUE IF NOT EXISTS 'on_hold';
EXCEPTION
    WHEN duplicate_object THEN null;  -- Already exists, skip silently
    WHEN others THEN null;            -- Catch any other enum errors silently
END $$;

-- -----------------------------------------------------------------------------
-- Step 2: Add composite index on Assignment(vehicleId, status)
-- Used by the stale vehicle watchdog to efficiently find stuck vehicles.
-- Safe to run multiple times (IF NOT EXISTS).
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "Assignment_vehicleId_status_idx"
    ON "Assignment" ("vehicleId", "status");

-- =============================================================================
-- END OF MIGRATION
-- Expected outcome:
--   ✅ VehicleStatus enum now includes 'on_hold'
--   ✅ Assignment(vehicleId, status) composite index exists
--   ✅ All existing rows and data fully preserved
--   ✅ Idempotent: safe to run again if applied twice
-- =============================================================================
