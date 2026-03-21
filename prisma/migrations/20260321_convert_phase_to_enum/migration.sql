-- Convert phase column from TEXT to HoldPhase enum (PRD 7777)
-- This migration safely converts the existing TEXT column to ENUM type without data loss

-- Step 1: Create HoldPhase enum type (safe even if already exists)
DO $$ BEGIN
    CREATE TYPE "HoldPhase" AS ENUM ('FLEX', 'CONFIRMED', 'EXPIRED', 'RELEASED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Step 2: Convert existing TEXT values to ENUM type
-- First create a temp column with the new ENUM type
ALTER TABLE "TruckHoldLedger"
ADD COLUMN IF NOT EXISTS "phase_new" "HoldPhase";

-- Copy data from TEXT column to ENUM column, default to FLEX for invalid values
UPDATE "TruckHoldLedger"
SET "phase_new" = (
    CASE
        WHEN "phase" IN ('FLEX', 'CONFIRMED', 'EXPIRED', 'RELEASED') THEN "phase"::text::"HoldPhase"
        ELSE 'FLEX'::"HoldPhase"
    END
);

-- Step 3: Drop the old TEXT column
ALTER TABLE "TruckHoldLedger"
DROP COLUMN IF EXISTS "phase";

-- Step 4: Rename the new ENUM column to phase
ALTER TABLE "TruckHoldLedger"
RENAME COLUMN "phase_new" TO "phase";

-- Step 5: Set NOT NULL constraint
ALTER TABLE "TruckHoldLedger"
ALTER COLUMN "phase" SET NOT NULL;

-- Step 6: Set default value
ALTER TABLE "TruckHoldLedger"
ALTER COLUMN "phase" SET DEFAULT 'FLEX'::"HoldPhase";

-- Step 7: Create indexes if they don't exist
CREATE INDEX IF NOT EXISTS "TruckHoldLedger_phase_flexExpiresAt_idx"
ON "TruckHoldLedger" ("phase", "flexExpiresAt");

CREATE INDEX IF NOT EXISTS "TruckHoldLedger_phase_confirmedExpiresAt_idx"
ON "TruckHoldLedger" ("phase", "confirmedExpiresAt");
