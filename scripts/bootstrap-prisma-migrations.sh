#!/bin/sh
# =============================================================================
# Bootstrap PR-0 — backfill _prisma_migrations table on production DB
# =============================================================================
# RUNBOOK ONLY: operator-invoked, one-shot. DO NOT auto-run from entrypoint.
#
# Per CLAUDE.md L477-485, the production DB was set up with `prisma db push`,
# NOT `prisma migrate deploy` — so the `_prisma_migrations` table does not exist.
# `prisma migrate deploy` against this DB fails with P3005 regardless of retry
# logic. This script idempotently creates the table and back-baselines the 7
# already-applied migrations via `prisma migrate resolve --applied`.
#
# Sequencing (per Fix #25 Mandatory #3):
#   1. Run this script ONCE against staging, verify SELECT COUNT(*) >= 7
#   2. Run this script ONCE against production, verify SELECT COUNT(*) >= 7
#   3. THEN flip FF_MIGRATION_RETRY_HARNESS_ENABLED=true in ECS task-def
# =============================================================================

set -euo pipefail

psql "$DATABASE_URL" <<'SQL'
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  id VARCHAR(36) PRIMARY KEY,
  checksum VARCHAR(64) NOT NULL,
  finished_at TIMESTAMPTZ,
  migration_name VARCHAR(255) NOT NULL,
  logs TEXT,
  rolled_back_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_steps_count INT NOT NULL DEFAULT 0
);
SQL

for m in 20260219_add_broadcast_lifecycle_states \
         20260225_add_truckrequest_notified_transporters_gin_index \
         20260228_phase2_reliability_core \
         20260228_phase4_hold_reliability \
         20260228_phase5_cancel_reliability \
         20260321_hold_phase_system \
         20260329_add_on_hold_status_and_vehicle_index; do
  npx prisma migrate resolve --applied "$m"
done

psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM _prisma_migrations;"   # expect >= 7
