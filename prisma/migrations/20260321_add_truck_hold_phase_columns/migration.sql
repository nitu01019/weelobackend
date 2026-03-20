-- Add Two-Phase Truck Hold System Columns (PRD 7777)
-- This migration adds the missing columns for the two-phase hold system

-- 1. Add phase column (text, default FLEX for backward compatibility)
ALTER TABLE "TruckHoldLedger"
ADD COLUMN IF NOT EXISTS "phase" TEXT NOT NULL DEFAULT 'FLEX';

-- 2. Add phaseChangedAt column
ALTER TABLE "TruckLedger"
ADD COLUMN IF NOT EXISTS "phaseChangedAt" TIMESTAMPTZ;

-- 3. Add flexExpiresAt column (Phase 1 - FLEX hold expiry)
ALTER TABLE "TruckLedger"
ADD COLUMN IF NOT EXISTS "flexExpiresAt" TIMESTAMPTZ;

-- 4. Add flexExtendedCount column (default 0)
ALTER TABLE "TruckHoldLedger"
ADD COLUMN IF NOT EXISTS "flexExtendedCount" INTEGER NOT NULL DEFAULT 0;

-- 5. Add confirmedExpiresAt column (Phase 2 - CONFIRMED hold expiry)
ALTER TABLE "TruckLedger"
ADD COLUMN IF NOT EXISTS "confirmedExpiresAt" TIMESTAMPTZ;

-- Indexes for phase-based queries (creates if not exists)
CREATE INDEX IF NOT EXISTS "TruckHoldLedger_phase_flexExpiresAt_idx"
ON "TruckHoldLedger" ("phase", "flexExpiresAt");

CREATE INDEX IF NOT EXISTS "TruckHoldLedger_phase_confirmedExpiresAt_idx"
ON "TruckHoldLedger" ("phase", "confirmedExpiresAt");
