-- =============================================================================
-- M-013 — AssignmentStatus.partial_delivery enum value (L-17)
-- =============================================================================
-- Production DB: apply via psql directly.
-- CRITICAL: do NOT run `prisma migrate deploy` or `prisma db push` on prod.
--
-- IMPORTANT: `ALTER TYPE ... ADD VALUE` CANNOT run inside a transaction block.
-- Do NOT wrap this file in BEGIN/COMMIT. Run each statement standalone.
--
-- Purpose: adds `partial_delivery` to the AssignmentStatus enum so the
-- driver-side "partial delivery" terminal state written by state-machines.ts
-- (arrived_at_drop -> partial_delivery) can be persisted without error.
--
-- Apply order: BEFORE code merge. `IF NOT EXISTS` makes this idempotent on
-- PostgreSQL 12+.
-- =============================================================================

ALTER TYPE "AssignmentStatus" ADD VALUE IF NOT EXISTS 'partial_delivery';

-- Verify:
--   SELECT enum_range(NULL::"AssignmentStatus");
--   -- Expected to include: ..., 'completed', 'partial_delivery', 'cancelled', ...
