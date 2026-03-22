-- =============================================================================
-- MIGRATION: Two-Phase Truck Hold System (PRD 7777)
-- =============================================================================
-- Industry-standard idempotent migration — safe to run multiple times.
-- Handles ALL states: column missing, column TEXT, column already ENUM.
-- Uses DO $$ blocks so partial failures don't leave DB in broken state.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Step 1: Create HoldPhase ENUM type (safe if already exists)
-- -----------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE "HoldPhase" AS ENUM ('FLEX', 'CONFIRMED', 'EXPIRED', 'RELEASED');
EXCEPTION
    WHEN duplicate_object THEN null;  -- Already exists, skip silently
END $$;

-- -----------------------------------------------------------------------------
-- Step 2: Add phase column OR convert existing TEXT → ENUM (handles both)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    phase_exists    BOOLEAN;
    phase_is_enum   BOOLEAN;
BEGIN
    -- Check if phase column exists
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'TruckHoldLedger' AND column_name = 'phase'
    ) INTO phase_exists;

    IF phase_exists THEN
        -- Check if it's already the correct ENUM type
        SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'TruckHoldLedger'
              AND column_name = 'phase'
              AND udt_name = 'HoldPhase'
        ) INTO phase_is_enum;

        IF NOT phase_is_enum THEN
            -- Column is TEXT — convert safely with default fallback
            -- Drop default first (required by Postgres before type change)
            ALTER TABLE "TruckHoldLedger" ALTER COLUMN "phase" DROP DEFAULT;
            -- Convert TEXT → ENUM, invalid values default to FLEX
            ALTER TABLE "TruckHoldLedger"
                ALTER COLUMN "phase" TYPE "HoldPhase"
                USING CASE
                    WHEN "phase" IN ('FLEX', 'CONFIRMED', 'EXPIRED', 'RELEASED')
                        THEN "phase"::"HoldPhase"
                    ELSE 'FLEX'::"HoldPhase"
                END;
            -- Restore default
            ALTER TABLE "TruckHoldLedger"
                ALTER COLUMN "phase" SET DEFAULT 'FLEX'::"HoldPhase";
        END IF;
        -- else: already ENUM, nothing to do ✅
    ELSE
        -- Column doesn't exist at all — add as ENUM directly
        ALTER TABLE "TruckHoldLedger"
            ADD COLUMN "phase" "HoldPhase" NOT NULL DEFAULT 'FLEX'::"HoldPhase";
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Step 3: Add optional timestamp + counter columns (safe if already exist)
-- -----------------------------------------------------------------------------
DO $$ BEGIN
    ALTER TABLE "TruckHoldLedger" ADD COLUMN "phaseChangedAt" TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE "TruckHoldLedger" ADD COLUMN "flexExpiresAt" TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE "TruckHoldLedger" ADD COLUMN "flexExtendedCount" INTEGER NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE "TruckHoldLedger" ADD COLUMN "confirmedExpiresAt" TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN null; END $$;

-- -----------------------------------------------------------------------------
-- Step 4: Create indexes (safe if already exist)
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "TruckHoldLedger_phase_flexExpiresAt_idx"
    ON "TruckHoldLedger" ("phase", "flexExpiresAt");

CREATE INDEX IF NOT EXISTS "TruckHoldLedger_phase_confirmedExpiresAt_idx"
    ON "TruckHoldLedger" ("phase", "confirmedExpiresAt");

-- =============================================================================
-- END OF MIGRATION
-- Expected outcome:
--   ✅ HoldPhase ENUM exists in DB
--   ✅ phase column = HoldPhase ENUM, NOT NULL, DEFAULT 'FLEX'
--   ✅ phaseChangedAt, flexExpiresAt, flexExtendedCount, confirmedExpiresAt exist
--   ✅ Both indexes exist
--   ✅ All existing rows preserved (invalid TEXT values defaulted to FLEX)
-- =============================================================================
