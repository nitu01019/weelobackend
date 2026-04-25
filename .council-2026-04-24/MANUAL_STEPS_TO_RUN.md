# Manual Steps to Run (post-hardening 2026-04-25)

All code is shipped. Steps 1+5 already done by team-lead. Steps 2+4 require your hands.

---

## ✅ Step 1 (DONE) — AUDIT_METADATA_STRICT flipped to true
Code-side flip done at `src/shared/config/feature-flags.ts:761` — `defaultValue: true`.
Production rollout: observe `audit_metadata_pii_stripped_total` Prometheus counter for 24h before raising in real prod (pre-prod is fine to flip immediately per your direction).

## ✅ Step 5 (NO-OP) — FF_CUSTOMER_PROGRESS_MIRROR already ON
`defaultValue: true` since W-0. Active. No env var change needed.

---

## ⏳ Step 2 — Run 4 SQL files on pre-prod DB

### Pre-flight
1. Get RDS host + credentials from AWS Secrets Manager.
2. Set environment variable for psql connection:
   ```bash
   export PGPASSWORD='<from-secrets-manager>'
   export PGHOST='<rds-host>.ap-south-1.rds.amazonaws.com'
   export PGUSER='<rds-user>'
   export PGDATABASE='weelo_db'
   ```

### Run (in order — A05-005 must run BEFORE A05-015 + E3 group)

```bash
cd /Users/nitishbhardwaj/Desktop/weelo-backend

# Step 1 — installId column + UNIQUE index (W-3 W4-SQL-2)
# Read the W-0 PREFLIGHT GATE section first; if it returns rows, run dedup commented section.
psql -f docs/ops/sql/A05-005-deviceToken-installId.sql

# Step 2 — appVersionCode column + check constraint + index (W-3 W4-SQL-1)
psql -f docs/ops/sql/A05-015-appVersionCode.sql

# Step 3 — StatusEvent table create (W-5 E3-2) — transactional, idempotent
psql -f docs/ops/sql/E3-statusevent-create-table.sql

# Step 4 — StatusEvent indexes CONCURRENTLY (W-5 E3-3) — autocommit, NO transaction
psql -f docs/ops/sql/E3-statusevent-indexes.sql
```

### Post-flight verification
```sql
-- Verify columns + indexes
\d "DeviceToken"     -- should show appVersionCode + installId columns
\d "StatusEvent"     -- should show 9 columns + 2 indexes

-- Verify no duplicates collapsed
SELECT "userId", "installId", COUNT(*) FROM "DeviceToken" GROUP BY 1,2 HAVING COUNT(*) > 1;
-- expect 0 rows
```

### Rollback (if anything goes wrong)
```sql
-- A05-015 rollback
ALTER TABLE "DeviceToken" DROP COLUMN IF EXISTS "appVersionCode";

-- A05-005 rollback (only if you need — run in autocommit, NOT inside BEGIN/COMMIT)
DROP INDEX CONCURRENTLY IF EXISTS "DeviceToken_userId_installId_idx";
DROP INDEX CONCURRENTLY IF EXISTS "DeviceToken_userId_lastSeenAt_idx";
ALTER TABLE "DeviceToken" DROP COLUMN IF EXISTS "installId";

-- E3 rollback
DROP TABLE IF EXISTS "StatusEvent";
```

### Post-rollback verification (expect zero rows for each)
```sql
-- A05-005 — installId index + column removal
SELECT indexname FROM pg_indexes WHERE tablename = 'DeviceToken' AND indexname LIKE '%installId%';
SELECT indexname FROM pg_indexes WHERE tablename = 'DeviceToken' AND indexname LIKE '%lastSeenAt%';

-- E3 — StatusEvent table + indexes removal
SELECT indexname FROM pg_indexes WHERE tablename = 'StatusEvent';
```

Full runbook with options: `.council-2026-04-24/w3_sql_runbook.md`

---

## ⏳ Step 4 — Raise MIN_SUPPORTED_APP_VERSION above 0

This is an environment variable in your ECS task definition (or local .env for pre-prod testing).

### Pre-prod (local)
Add to `.env`:
```
MIN_SUPPORTED_APP_VERSION=1
```
Restart server. Will start sending FCM_OLD_CLIENT_UPGRADE_REQUIRED to any device with `appVersionCode < 1` (i.e., none right now since no Captain build is reporting yet).

### AWS ECS production
1. AWS Console → ECS → Task Definitions → weelo-backend → New revision
2. Update `MIN_SUPPORTED_APP_VERSION` env var to `1` (or whichever Captain build code you ship)
3. Force-update service to deploy

### IMPORTANT — pre-condition
This step is SAFE to run NOW without Captain build shipping because:
- Devices that don't report `appVersionCode` (i.e., everyone today) get `appVersionCode = NULL` in DB
- The version-gate logic at `fcm-version-gate.ts` skips NULL → no upgrade FCM sent
- Effective behavior: no-op until Captain build with W-6 changes ships

Once Captain build ships AND devices upgrade, those that report old versions below MIN will get the upgrade banner via FCM.

---

## Step 3 — SKIPPED per user direction (Captain Play Store ship)

Captain build with W-6 Kotlin edits is committed locally at `/Users/nitishbhardwaj/Desktop/weelo captain` but NOT pushed to Play Store. Until Play Store rollout, no driver/transporter device will report `appVersionCode` or `networkClass`, and `flex_hold_superseded` listener won't be active client-side.

Backend code already accepts these fields gracefully (nullable optional in Zod schemas), so backend behavior is unaffected by deferred Play Store rollout.
