-- =============================================================================
-- M-009 — Hold-phase backfill (F-A-79, IRREVERSIBLE)
-- =============================================================================
--
-- Purpose:
--   Heal historical drift rows where `status='confirmed'` was written by the
--   legacy monolith confirm paths WITHOUT also flipping `phase` to CONFIRMED.
--   Downstream queries filter on `phase = 'CONFIRMED'` and silently miss these
--   rows — driver accept/decline flows diverge, stats under-report.
--
-- Ship gate:
--   Run ONLY after
--     1. F-A-79 helper + this PR shipped (monolith now writes phase aligned).
--     2. `FF_HOLD_GUARDED_TRANSITIONS=ON` for one full release (1-release soak).
--     3. Release-conductor has signed off on the pre-ship checklist
--        (.planning/phase4/INDEX.md Part 7 — F-A-79 entry).
--
--   DO NOT RUN AS PART OF THE F-A-79 DELIVERY PR. This file ships as
--   documentation + deploy-gated artefact only.
--
-- Pre-run verify (expect > 0 before the backfill):
--   SELECT count(*) FROM "TruckHoldLedger"
--    WHERE status = 'confirmed' AND phase = 'FLEX'::"HoldPhase";
--
-- Post-run verify (expect = 0 after commit):
--   SELECT count(*) FROM "TruckHoldLedger"
--    WHERE status = 'confirmed' AND phase = 'FLEX'::"HoldPhase";
--
-- Rollback:
--   IRREVERSIBLE at the row level — no pre-image captured. If rollback is
--   required, restore from the nightly RDS snapshot preceding the run.
--
-- =============================================================================

BEGIN;

  UPDATE "TruckHoldLedger"
     SET "phase"          = 'CONFIRMED'::"HoldPhase",
         "phaseChangedAt" = COALESCE("phaseChangedAt", "confirmedAt", now())
   WHERE "status" = 'confirmed'
     AND "phase"  = 'FLEX'::"HoldPhase";

  -- VERIFY INSIDE THE TX BEFORE COMMIT. Run this query manually:
  --   SELECT count(*) FROM "TruckHoldLedger"
  --    WHERE status = 'confirmed' AND phase = 'FLEX'::"HoldPhase";
  -- If the count is NOT 0, ROLLBACK; and open an incident.

COMMIT;
