-- =========================================================================
-- PHASE 3.1: ONE-TIME DATABASE CLEANUP
-- =========================================================================
-- Purpose: Fix all currently stuck vehicles in production.
-- Safety:  Read-first, idempotent, uses status preconditions.
-- Run:     Execute ONCE after Phase 1 is deployed and stable.
--
-- IMPORTANT:
--   1. Run during LOW TRAFFIC HOURS
--   2. Take a DB snapshot BEFORE running
--   3. Run the SELECT queries FIRST to review what will be changed
--   4. Then run the UPDATE queries
-- =========================================================================

-- =========================================================================
-- STEP 1: AUDIT — See what's currently stuck (READ ONLY)
-- =========================================================================

-- 1a. Count vehicles in each status
SELECT status, COUNT(*) as count
FROM "Vehicle"
GROUP BY status
ORDER BY count DESC;

-- 1b. Find vehicles stuck as in_transit with NO corresponding active assignment
SELECT
  v.id,
  v."vehicleNumber",
  v.status,
  v."lastStatusChange",
  v."currentTripId",
  v."transporterId",
  a.id as assignment_id,
  a.status as assignment_status,
  a."assignedAt"
FROM "Vehicle" v
LEFT JOIN "Assignment" a 
  ON v.id = a."vehicleId" 
  AND a.status IN ('driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit')
WHERE v.status = 'in_transit'
  AND a.id IS NULL;

-- 1c. Find vehicles in_transit where the ONLY assignment is terminal (completed/cancelled/declined)
SELECT
  v.id,
  v."vehicleNumber",
  v.status,
  v."lastStatusChange",
  latest_a.id as latest_assignment_id,
  latest_a.status as latest_assignment_status,
  latest_a."assignedAt"
FROM "Vehicle" v
LEFT JOIN LATERAL (
  SELECT a.id, a.status, a."assignedAt"
  FROM "Assignment" a
  WHERE a."vehicleId" = v.id
  ORDER BY a."assignedAt" DESC
  LIMIT 1
) latest_a ON true
WHERE v.status = 'in_transit'
  AND (latest_a.id IS NULL OR latest_a.status IN ('pending', 'driver_declined', 'cancelled', 'completed'));

-- 1d. Find vehicles stuck as on_hold (should not exist pre-Phase 1, but just in case)
SELECT
  v.id,
  v."vehicleNumber",
  v.status,
  v."lastStatusChange"
FROM "Vehicle" v
WHERE v.status = 'on_hold';

-- =========================================================================
-- STEP 2: FIX — Release stuck vehicles (WRITE)
-- =========================================================================
-- Only run after reviewing STEP 1 results!

-- 2a. Release vehicles stuck as in_transit with NO active assignment
UPDATE "Vehicle"
SET
  status = 'available',
  "currentTripId" = NULL,
  "assignedDriverId" = NULL,
  "lastStatusChange" = NOW()::text
WHERE status = 'in_transit'
  AND id IN (
    SELECT v.id
    FROM "Vehicle" v
    LEFT JOIN "Assignment" a
      ON v.id = a."vehicleId"
      AND a.status IN ('driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit')
    WHERE v.status = 'in_transit'
      AND a.id IS NULL
  );

-- 2b. Release vehicles stuck as in_transit where only assignment is terminal
UPDATE "Vehicle"
SET
  status = 'available',
  "currentTripId" = NULL,
  "assignedDriverId" = NULL,
  "lastStatusChange" = NOW()::text
WHERE status = 'in_transit'
  AND id NOT IN (
    SELECT DISTINCT a."vehicleId"
    FROM "Assignment" a
    WHERE a.status IN ('driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit')
      AND a."vehicleId" IS NOT NULL
  );

-- 2c. Release any orphaned on_hold vehicles
UPDATE "Vehicle"
SET
  status = 'available',
  "currentTripId" = NULL,
  "assignedDriverId" = NULL,
  "lastStatusChange" = NOW()::text
WHERE status = 'on_hold'
  AND id NOT IN (
    SELECT DISTINCT a."vehicleId"
    FROM "Assignment" a
    WHERE a.status = 'pending'
      AND a."vehicleId" IS NOT NULL
  );

-- 2d. Cancel orphaned pending assignments (no active vehicle hold)
UPDATE "Assignment"
SET status = 'driver_declined'
WHERE status = 'pending'
  AND "assignedAt" < (NOW() - INTERVAL '5 minutes')::text;

-- =========================================================================
-- STEP 3: VERIFY — Confirm no stuck vehicles remain
-- =========================================================================

-- Should return 0 rows
SELECT
  v.id,
  v."vehicleNumber",
  v.status
FROM "Vehicle" v
LEFT JOIN "Assignment" a
  ON v.id = a."vehicleId"
  AND a.status IN ('driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit')
WHERE v.status = 'in_transit'
  AND a.id IS NULL;

-- Final status summary
SELECT status, COUNT(*) as count
FROM "Vehicle"
GROUP BY status
ORDER BY count DESC;
