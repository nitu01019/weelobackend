-- =============================================================================
-- M-016: Assignment `superseded` enum value + `supersededAt` column (P4 F12.5)
-- =============================================================================
-- Adds the atomically-cancelled-sibling state introduced in Phase 4
-- (`assignment-response.service.ts` accept TX). When driver D accepts assignment
-- A on vehicle V, every other pending assignment for V is flipped to
-- `superseded` in the same TX so a second concurrent accept cannot race it.
--
-- Required before the new accept-TX code runs in production. Per CLAUDE.md this
-- DB was set up via `prisma db push` (no `_prisma_migrations` table), so this
-- migration is applied DIRECTLY via psql — do NOT run `prisma migrate deploy`.
--
-- The Prisma side (enum + field) lives in `prisma/schema.prisma`; regenerate
-- client types with `npx prisma generate` (safe — no DB writes).
--
-- SAFETY NOTES:
--   - ADD VALUE IF NOT EXISTS makes the enum change idempotent.
--   - ADD COLUMN IF NOT EXISTS makes the column add idempotent.
--   - Partial index scoped to status='pending' speeds the sibling-lookup
--     updateMany inside the accept TX without bloating the full index set.
-- =============================================================================

BEGIN;

-- Enum value: AssignmentStatus.superseded
DO $$
BEGIN
  ALTER TYPE "AssignmentStatus" ADD VALUE IF NOT EXISTS 'superseded';
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'enum value superseded already exists on AssignmentStatus';
END
$$;

-- Column: Assignment.supersededAt
ALTER TABLE "Assignment"
  ADD COLUMN IF NOT EXISTS "supersededAt" TIMESTAMP(3);

-- Index: supports the `WHERE vehicleId = $1 AND status = 'pending'` sibling
-- supersede inside the accept TX. Partial index keeps it cheap to maintain.
CREATE INDEX IF NOT EXISTS "assignment_vehicle_pending_idx"
  ON "Assignment" ("vehicleId")
  WHERE status = 'pending';

COMMIT;
