# SQL Pre-Prod Run — Operator Guide

**Audience:** Operator with AWS RDS credentials about to apply Items 4 + 6 (4 SQL files).
**Scope:** Pre-prod / production DB schema migration via direct psql.
**Authoritative inputs:**
- Driver script: `.council-2026-04-24/PSQL_COMMANDS_TO_RUN.sh`
- Companion doc: `.council-2026-04-24/MANUAL_STEPS_TO_RUN.md`
- SQL files: `docs/ops/sql/A05-005-deviceToken-installId.sql`, `docs/ops/sql/A05-015-appVersionCode.sql`, `docs/ops/sql/E3-statusevent-create-table.sql`, `docs/ops/sql/E3-statusevent-indexes.sql`
- Verdict: `.council-2026-04-26/verify_4_db.md` (READY-TO-RUN, 91% confidence)

**Execution time estimate:** 10–15 minutes including pre/post-flight.

---

## 0. Why this guide exists

The SQL changes are additive and idempotent, but two operational gaps require the operator to slow down at specific points:

1. **A05-005 dedup gate** — the preflight `SELECT` for duplicate `(userId, installId='legacy')` rows is in the same file as the `CONCURRENTLY` UNIQUE index creation. `psql -f` does not pause between them. The operator MUST run the dedup `SELECT` manually first and confirm zero rows before invoking the driver script.
2. **CLAUDE.md DB rule** — the production DB has no `_prisma_migrations` table and was set up via `prisma db push`. NEVER run `prisma migrate deploy` or `prisma db push`. All schema changes are direct SQL only.

---

## 1. Pre-flight: get RDS credentials

Per `CLAUDE.md` ("How to Connect to Production DB"), credentials live in AWS Secrets Manager.

### 1.1 Fetch the connection details

```bash
# Replace <secret-name> with the actual RDS secret in ap-south-1
aws secretsmanager get-secret-value \
  --secret-id <secret-name> \
  --region ap-south-1 \
  --query SecretString \
  --output text
```

The JSON contains `host`, `port`, `username`, `password`, `dbname`. Capture these in a scratch buffer (do NOT paste into a shared chat).

### 1.2 Set psql environment variables

```bash
export PGHOST='<rds-host>.ap-south-1.rds.amazonaws.com'
export PGUSER='<rds-username>'
export PGPASSWORD='<rds-password>'
export PGDATABASE='weelo_db'        # default in the script; override only if non-default
export PGPORT='5432'                # default; override only if non-standard
```

`PGPASSWORD` will leak into shell history if the line is run literally — prefer `read -s -p "PGPASSWORD: " PGPASSWORD; export PGPASSWORD` to avoid that.

### 1.3 Network access

RDS is currently publicly accessible (per `CLAUDE.md` §"DB SECURITY STATUS 2026-03-22"). If access has since been re-secured, the operator must connect via VPN / bastion. A connectivity smoke test is performed by the driver script's first `psql -c "SELECT current_database(), version();"`.

---

## 2. Pre-flight gate: A05-005 duplicate detection (MANUAL — required)

### Why this matters

A05-005 backfills every pre-existing `DeviceToken` row with `installId='legacy'`. If any user already has 2+ `DeviceToken` rows, the subsequent `CREATE UNIQUE INDEX CONCURRENTLY ... (userId, installId)` will fail and leave the index in an `INVALID` state. The migration would appear to succeed (psql exits cleanly because `IF NOT EXISTS` masks the conflict in `pg_index.indisvalid`).

### Run this BEFORE invoking the driver script

```bash
psql -c "
SELECT \"userId\", \"installId\", COUNT(*) AS dup_count
FROM \"DeviceToken\"
WHERE \"installId\" IS NULL OR \"installId\" = 'legacy'
GROUP BY \"userId\", \"installId\"
HAVING COUNT(*) > 1
ORDER BY dup_count DESC;
"
```

### Expected output: zero rows

> `(0 rows)` — proceed to Section 3.

### If non-zero rows: dedup before proceeding

The dedup UPDATE is in `docs/ops/sql/A05-005-deviceToken-installId.sql` lines 51-61 (commented). Strategy: suffix duplicates with `'legacy-<id>'` so each `(userId, installId)` pair becomes unique, keep the oldest row unchanged.

```sql
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY "userId", "installId"
    ORDER BY "createdAt"
  ) AS rn
  FROM "DeviceToken"
  WHERE "installId" = 'legacy'
)
UPDATE "DeviceToken"
SET "installId" = 'legacy-' || id::text
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
```

After running, re-run the dup-check `SELECT` from this section. Re-confirm zero rows. Only then proceed.

> CLAUDE.md prod stats (2026-03-22): 1 transporter, 3 drivers, 9 customers — duplicates are unlikely on this DB. But the gate is mandatory regardless of expected size.

---

## 3. Apply the migration

### 3.1 Run the driver script

```bash
cd /Users/nitishbhardwaj/Desktop/weelo-backend
bash .council-2026-04-24/PSQL_COMMANDS_TO_RUN.sh
```

The script:
- Verifies env vars are set (aborts with clear message if missing).
- Runs a connectivity check (`SELECT current_database(), version();`).
- Captures pre-migration row counts + dup-pair count.
- Pauses with `read -p "Continue? (y/N): "` before each of the 4 SQL files.
- Executes 4 files in order: A05-005 → A05-015 → E3-create-table → E3-indexes.
- Runs post-flight verification at the end.

### 3.2 Answer each gate

Type `y` (lowercase, exactly one character) to proceed at each gate. Anything else aborts.

| Gate | When | What you're confirming |
|---|---|---|
| #1 (line 44) | Before A05-005 | Section 2 dedup gate returned zero rows |
| #2 (line 50) | Before A05-015 | A05-005 just succeeded with no errors in stderr |
| #3 (line 56) | Before E3-create-table | A05-015 just succeeded |
| #4 (line 62) | Before E3-indexes | E3-create-table just succeeded; `\d "StatusEvent"` shows the table |

### 3.3 What to watch for during execution

- `NOTICE:  relation "DeviceToken_xxx_idx" already exists, skipping` — benign (idempotent re-run).
- `ERROR:  could not create unique index "DeviceToken_userId_installId_idx" Key (...) is duplicated.` — A05-005 dedup gate was skipped or new dups were inserted between the gate run and the migration. Abort, re-run dedup, retry.
- `ERROR:  relation "StatusEvent" does not exist` during E3-indexes — E3-create-table did not commit. Re-run E3-create-table, then retry E3-indexes.
- `WARNING:  there is no transaction in progress` during E3-indexes — benign; CONCURRENTLY runs in autocommit and psql sometimes emits this.

---

## 4. Post-flight verification

The driver script's tail (lines 67-75) runs the canonical post-flight queries. Re-run these manually if you want to double-check:

### 4.1 Schema confirmation

```sql
\d "DeviceToken"
```

Expect to see at least these new fields/indexes:
- Column `installId` text NOT NULL DEFAULT 'legacy'
- Column `appVersionCode` integer NULL
- Constraint `DeviceToken_appVersionCode_range_chk` (CHECK)
- Index `DeviceToken_userId_installId_idx` UNIQUE (userId, installId)
- Index `DeviceToken_userId_lastSeenAt_idx` (userId, lastSeenAt DESC)
- Index `DeviceToken_appVersion_idx` (appVersionCode)

```sql
\d "StatusEvent"
```

Expect 9 columns + 2 indexes:
- `id` text PRIMARY KEY
- `entityType` text NOT NULL
- `entityId` text NOT NULL
- `fromStatus` text
- `toStatus` text
- `triggeredBy` text
- `triggerReason` text
- `metadata` jsonb
- `createdAt` timestamp(3) NOT NULL DEFAULT now()
- Index `StatusEvent_createdAt_idx` (createdAt)
- Index `StatusEvent_entityType_entityId_createdAt_idx` (entityType, entityId, createdAt)

### 4.2 Integrity checks

```sql
-- No duplicate installId pairs
SELECT "userId", "installId", COUNT(*) FROM "DeviceToken" GROUP BY 1, 2 HAVING COUNT(*) > 1;
-- Expect 0 rows.

-- No NULL installId rows
SELECT COUNT(*) FROM "DeviceToken" WHERE "installId" IS NULL;
-- Expect 0.

-- No INVALID indexes anywhere on the DB (catches mid-build CONCURRENTLY failures)
SELECT indexrelid::regclass, indisvalid FROM pg_index WHERE NOT indisvalid;
-- Expect 0 rows.

-- StatusEvent table is empty on first migration (writer guarded; no data yet)
SELECT COUNT(*) FROM "StatusEvent";
-- Expect 0 (or low number if something already started writing).
```

---

## 5. Smoke test (live application)

After SQL applies cleanly, validate the live app respects the new schema:

```bash
# Replace HOST/JWT with the pre-prod backend host + a valid JWT
curl -s -X POST 'https://<pre-prod-host>/api/v1/notifications/register-token' \
  -H "Authorization: Bearer <JWT>" \
  -H 'Content-Type: application/json' \
  -d '{
    "token": "smoketest-fcm-token-1",
    "platform": "android",
    "installId": "smoke-install-001",
    "appVersionCode": 1
  }'
```

Expect `200 OK` with the device-token registration payload. Then verify in psql:

```sql
SELECT "userId", "installId", "appVersionCode", "createdAt"
FROM "DeviceToken"
WHERE "installId" = 'smoke-install-001'
ORDER BY "createdAt" DESC LIMIT 1;
```

Expect 1 row with the right `installId` + `appVersionCode`. Re-running the same `curl` should NOT create a second row — the UPSERT on `(userId, installId)` reuses the existing row (verify `createdAt` is unchanged on second call). Cleanup:

```sql
DELETE FROM "DeviceToken" WHERE "installId" = 'smoke-install-001';
```

---

## 6. Rollback drill (rare — only on incident)

Per `MANUAL_STEPS_TO_RUN.md` §"Rollback (if anything goes wrong)" (now corrected per Item 6 fix). Do NOT run unless an active incident requires it.

```sql
-- A05-015 rollback (transactional-safe)
ALTER TABLE "DeviceToken" DROP COLUMN IF EXISTS "appVersionCode";

-- A05-005 rollback (autocommit — DO NOT wrap in BEGIN/COMMIT)
DROP INDEX CONCURRENTLY IF EXISTS "DeviceToken_userId_installId_idx";
DROP INDEX CONCURRENTLY IF EXISTS "DeviceToken_userId_lastSeenAt_idx";
ALTER TABLE "DeviceToken" DROP COLUMN IF EXISTS "installId";

-- E3 rollback
DROP TABLE IF EXISTS "StatusEvent";
```

### Post-rollback verification (expect zero rows for each)

```sql
SELECT indexname FROM pg_indexes WHERE tablename = 'DeviceToken' AND indexname LIKE '%installId%';
SELECT indexname FROM pg_indexes WHERE tablename = 'DeviceToken' AND indexname LIKE '%lastSeenAt%';
SELECT indexname FROM pg_indexes WHERE tablename = 'StatusEvent';
```

Any non-zero result means the rollback silently no-oped (most commonly because `IF EXISTS` swallowed a wrong index name). Stop and investigate before retrying.

> Index name verification: the names above match `prisma/schema.prisma:1505` (`map: "DeviceToken_userId_installId_idx"`) and `docs/ops/sql/A05-005-deviceToken-installId.sql` lines 71-72, 76-77. Verified by `verify_B4_sql_rollback_fix.md`.

---

## 7. Confidence checks (last sanity pass)

Run these `\d` commands and visually confirm before declaring success:

| Command | Confirms |
|---|---|
| `\d "DeviceToken"` | 2 new columns (`installId`, `appVersionCode`) + 3 new indexes (installId UNIQUE, lastSeenAt, appVersion) + 1 CHECK constraint |
| `\d "StatusEvent"` | Table exists with 9 columns + 2 indexes |
| `SELECT * FROM pg_index WHERE NOT indisvalid;` | 0 rows (all CONCURRENTLY builds completed) |
| `SELECT COUNT(*) FROM "DeviceToken";` | Same count as the pre-flight capture (no row loss) |

---

## 8. Failure modes and recovery

| Failure | Symptom | Recovery |
|---|---|---|
| Dedup gate skipped, A05-005 fails on UNIQUE | `ERROR: could not create unique index ... is duplicated` | Run dedup UPDATE (Section 2), then `REINDEX INDEX CONCURRENTLY "DeviceToken_userId_installId_idx"` if it was created INVALID, otherwise re-run the script |
| Connectivity drop mid-CONCURRENTLY | `WARNING: index ... is invalid` in `\d` | `DROP INDEX CONCURRENTLY IF EXISTS "<name>"` then re-run the failing CREATE |
| E3-indexes runs before E3-create-table | `ERROR: relation "StatusEvent" does not exist` | Run E3-create-table, then E3-indexes |
| `appVersionCode` boot-assertion fires | Server boot logs `BootAssertionError` | Confirm A05-015 column ADD ran. The assertion only fires when `MIN_SUPPORTED_APP_VERSION > 0` (currently 0, dormant) |
| `installId` upsert errors at runtime (`ERROR 42703: column "installId" does not exist`) | 500 on `POST /api/v1/notifications/register-token` | A05-005 column ADD didn't run. Re-run A05-005 (its `IF NOT EXISTS` guards make it safe) |

---

## 9. Sign-off

After Sections 2–7 pass:

- [ ] Dedup gate (Section 2) returned zero rows pre-migration.
- [ ] All four `read -p` gates answered with `y`.
- [ ] Post-flight `\d "DeviceToken"` shows the 2 new columns + 3 new indexes.
- [ ] Post-flight `\d "StatusEvent"` shows the table + 2 indexes.
- [ ] `SELECT * FROM pg_index WHERE NOT indisvalid;` returned 0 rows.
- [ ] Smoke test (Section 5) registered a token and the row was visible in psql; second call was idempotent.
- [ ] Pre/post `COUNT(*)` on `DeviceToken` matched (no row loss).

If all checked, declare migration complete. Notify team-lead via SendMessage.

---

## Appendix A — File index

| File | Purpose | Transactional? | CONCURRENTLY? |
|---|---|---|---|
| `docs/ops/sql/A05-005-deviceToken-installId.sql` | Add `installId` column + UNIQUE index + lastSeenAt index | Step 1: yes (DO $$ BEGIN). Steps 2-3: autocommit (CONCURRENTLY). | YES (lines 71, 76) |
| `docs/ops/sql/A05-015-appVersionCode.sql` | Add `appVersionCode` column + range CHECK + index | Step 1: yes. Step 2: autocommit. | YES (line 48) |
| `docs/ops/sql/E3-statusevent-create-table.sql` | Create `StatusEvent` table (9 columns) | YES — wrapped in `BEGIN; ... COMMIT;` | NO |
| `docs/ops/sql/E3-statusevent-indexes.sql` | Create `StatusEvent_createdAt_idx` + composite index | NO — autocommit required | YES (lines 20, 23) |

## Appendix B — Index name authoritative table

| Index | Source (prisma + sql) | Match |
|---|---|---|
| `DeviceToken_userId_installId_idx` | `prisma/schema.prisma:1505` `map:` directive + A05-005 line 71-72 | EXACT |
| `DeviceToken_userId_lastSeenAt_idx` | A05-005 line 76-77 (no Prisma map; SQL-only) | N/A |
| `DeviceToken_appVersion_idx` | A05-015 line 48-49 (no Prisma map; SQL-only) | N/A |
| `StatusEvent_createdAt_idx` | `prisma/schema.prisma` StatusEvent map + E3-indexes line 20 | EXACT |
| `StatusEvent_entityType_entityId_createdAt_idx` | `prisma/schema.prisma` StatusEvent map + E3-indexes line 23 | EXACT |

Source for verification: `.council-2026-04-26/verify_B4_sql_rollback_fix.md`.
