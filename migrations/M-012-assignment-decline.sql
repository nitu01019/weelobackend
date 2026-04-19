-- =============================================================================
-- M-012 — Assignment decline tracking columns (H11)
-- =============================================================================
-- Production DB: apply via psql directly.
-- CRITICAL: do NOT run `prisma migrate deploy` or `prisma db push` on prod.
--
-- Purpose: track why/how an Assignment was declined.
-- Written by vehicle.routes.ts (transporter force-release) and by timeout /
-- auto-reassign paths tagged declineType='timeout' | 'explicit' | 'auto_system'.
--
-- Apply order: BEFORE code merge. All 3 columns are nullable -> safe to add
-- ahead of the deploying code.
-- =============================================================================

BEGIN;

ALTER TABLE "Assignment"
  ADD COLUMN IF NOT EXISTS "declineReason" TEXT,
  ADD COLUMN IF NOT EXISTS "declineType"   TEXT,
  ADD COLUMN IF NOT EXISTS "declinedAt"    TIMESTAMP(3);

COMMIT;

-- Verify:
--   \d+ "Assignment"
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'Assignment'
--      AND column_name IN ('declineReason','declineType','declinedAt');
