-- =============================================================================
-- M-010 — DeviceToken table (H15)
-- =============================================================================
-- Production DB: apply via psql directly.
-- CRITICAL: do NOT run `prisma migrate deploy` or `prisma db push` on prod
-- (there is no `_prisma_migrations` table; those commands will fail or corrupt).
--
-- Purpose: persistence for FCM device tokens. Used by fcm.service.ts
-- (upsert/deleteMany/findMany on prismaClient.deviceToken).
--
-- Apply order: BEFORE code merge. Safe to re-run (idempotent).
-- =============================================================================

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS "DeviceToken" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'android',
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
  );
EXCEPTION WHEN duplicate_table THEN NULL; END $$;

-- Indexes must be CONCURRENT and OUTSIDE any transaction block.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "DeviceToken_userId_token_key"
  ON "DeviceToken"("userId", "token");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "DeviceToken_userId_idx"
  ON "DeviceToken"("userId");

-- Verify:
--   \d+ "DeviceToken"
--   SELECT c.relname, i.indisvalid FROM pg_index i
--     JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname IN ('DeviceToken_userId_token_key','DeviceToken_userId_idx');
