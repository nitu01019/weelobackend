-- =============================================================================
-- F-B-75 — KYC FSM: add kycStatus enum column on User + index + seed VERIFIED
-- =============================================================================
--
-- Purpose: add the `kycStatus` column so the broadcast filter at
-- `src/modules/order/order-broadcast.service.ts` can filter to VERIFIED
-- transporters only. Today the filter is cosmetic — it only checks `isActive`.
-- After this migration lands, the Prisma type-only regen + the broadcast filter
-- change together enforce a real KYC gate.
--
-- Pattern: KYC FSM (Finite State Machine) — Fernando Hermida + Ola + Uber
-- Rider Identity. KYC is modelled as an explicit enum column (never a
-- boolean), because the distinction between NOT_STARTED / UNDER_REVIEW /
-- VERIFIED / REJECTED / EXPIRED is load-bearing for audit + regulator
-- reporting.
--
-- Industry references:
--   - Fernando Hermida, "Simplifying Customer Onboarding with Finite State
--     Machines" — enum column, never a boolean.
--     https://www.fernandohermida.com/posts/simplifying-customer-onboarding-with-finite-state-machines
--   - Supabase, "Managing Enums in Postgres (idempotent migration)" — the
--     canonical `DO $$ BEGIN CREATE TYPE … EXCEPTION WHEN duplicate_object
--     THEN null; END $$` pattern.
--     https://supabase.com/docs/guides/database/postgres/enums
--   - KYC-Chain, "KYC verification process and common requirements" —
--     industry-standard enum states for logistics/fintech onboarding.
--     https://kyc-chain.com/kyc-verification-process-and-common-requirements/
--
-- CLAUDE.md rule: direct SQL ONLY — do NOT run `prisma migrate deploy` or
-- `prisma db push`. The prod DB was set up via `prisma db push` and has no
-- `_prisma_migrations` table; running `prisma migrate deploy` will fail or
-- corrupt the schema.
--
-- PENDING HUMAN ACTION — execute via psql during a maintenance window:
--
--     psql "$DATABASE_URL" -f migrations/phase3-f-b-75-kyc.sql
--
-- Idempotency of this migration itself:
--   - `CREATE TYPE … EXCEPTION WHEN duplicate_object THEN null` -> safe to
--     re-run, no-op on repeat.
--   - `ADD COLUMN IF NOT EXISTS` -> safe to re-run.
--   - `CREATE INDEX IF NOT EXISTS` -> safe to re-run.
--   - Seed `UPDATE` is restricted to already-trusted transporter rows
--     (role='transporter' AND isActive=true AND isVerified=true) and flips
--     only rows whose kycStatus is still the default — safe to re-run.
--   - Wrapped in BEGIN/COMMIT so a partial failure rolls back cleanly.
-- =============================================================================

BEGIN;

-- 1. Create KycStatus enum idempotently.
DO $$ BEGIN
    CREATE TYPE "KycStatus" AS ENUM ('NOT_STARTED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Add the column with a safe default so the filter is fail-secure: any
--    new or back-filled User is NOT_STARTED until an admin flips them.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "kycStatus" "KycStatus" NOT NULL DEFAULT 'NOT_STARTED';

-- 3. Seed existing trusted transporters (already `isActive` AND `isVerified`
--    per the legacy isVerified boolean) as VERIFIED — no broadcast
--    regression for the 1 prod transporter (Nitish) listed in CLAUDE.md.
--    Restricted to rows still at the default so the migration is
--    re-runnable without clobbering admin transitions.
UPDATE "User"
   SET "kycStatus" = 'VERIFIED'
 WHERE "role" = 'transporter'
   AND "isActive" = true
   AND "isVerified" = true
   AND "kycStatus" = 'NOT_STARTED';

-- 4. Composite index to support the broadcast filter
--    (role, isActive, kycStatus) — this is the access path every
--    broadcast hits via `order-broadcast.service.ts`.
CREATE INDEX IF NOT EXISTS "idx_user_role_active_kyc"
  ON "User" ("role", "isActive", "kycStatus");

COMMIT;

-- Verification (run AFTER the COMMIT above, manually):
--   \d+ "User"
--   SELECT "kycStatus", COUNT(*) FROM "User" GROUP BY 1;
-- Expected: new column kycStatus present (enum KycStatus NOT NULL DEFAULT
-- 'NOT_STARTED'); idx_user_role_active_kyc listed; existing trusted
-- transporter(s) VERIFIED, everyone else NOT_STARTED.
