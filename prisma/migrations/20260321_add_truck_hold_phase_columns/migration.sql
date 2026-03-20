-- Add Two-Phase Truck Hold System Columns (PRD 7777)
-- This migration adds the missing columns for the two-phase hold system

-- 1. Add phase column (HoldPhase enum: FLEX, CONFIRMED, EXPIRED, RELEASED)
ALTER TABLE "TruckHoldLedger"
ADD COLUMN IF NOT EXISTS "phase" TEXT NOT NULL DEFAULT 'FLEX';

-- 2. Add phaseChangedAt column (tracks when phase last changed)
ALTER TABLE "TruckHoldLedger"
ADD COLUMN IF NOT EXISTS "phaseChangedAt" TIMESTAMP(3);

-- 3. Add flexExpiresAt column (Phase 1 - FLEX hold expiry)
ALTER TABLE "TruckHoldLedger"
ADD COLUMN IF NOT EXISTS "flexExpiresAt" TIMESTAMP(3);

-- 4. Add flexExtendedCount column (number of times hold was extended in Phase 1)
ALTER TABLE "TruckHoldLedger"
ADD COLUMN IF NOT EXISTS "flexExtendedCount" INTEGER NOT NULL DEFAULT 0;

-- 5. Add confirmedExpiresAt column (Phase 2 - CONFIRMED hold expiry)
ALTER TABLE "TruckHoldLedger"
ADD COLUMN IF NOT EXISTS "confirmedExpiresAt" TIMESTAMP(3);

-- Update existing records that might have holds
-- Set confirmedAtLegacy → confirmedAt for Phase 2 compatibility
UPDATE "TruckHoldLedger"
SET "confirmedAt" = "confirmedAtLegacy"
WHERE "confirmedAt" IS NULL AND "confirmedAtLegacy" IS NOT NULL;

-- 6. Add indexes for phase-based queries
CREATE INDEX IF NOT EXISTS "TruckHoldLedger_phase_flexExpiresAt_idx"
ON "TruckHoldLedger" ("phase", "flexExpiresAt");

CREATE INDEX IF NOT EXISTS "TruckHoldLedger_phase_confirmedExpiresAt_idx"
ON "TruckHoldLedger" ("phase", "confirmedExpiresAt");
