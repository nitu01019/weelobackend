# Phase 3 SQL Migrations — Production Runbook (W0-2)

**Status:** PENDING HUMAN EXECUTION
**Migrations to run:**

1. `migrations/phase3-f-a-02-order-unique.sql` — adds `Order.idempotencyKey` + partial-unique index.
2. `migrations/phase3-f-b-75-kyc.sql` — adds `KycStatus` enum, `User.kycStatus` column, composite index, seeds trusted transporters.

> ### 🚨 CRITICAL / FIRST PRIORITY — F-B-75 dispatch-break risk
>
> **If Phase 3 backend is already deployed and `migrations/phase3-f-b-75-kyc.sql` has NOT yet run, dispatch is SILENTLY BROKEN.**
>
> Mechanism: `src/modules/order/order-broadcast.service.ts:864-869` filters drivers by `kycStatus='VERIFIED'`. Prisma will throw "unknown column" → F-B-76 fail-closed catch (lines 884-907) → `verifiedTransporters = []` → zero-broadcast → no driver receives the order. Users see their ride request hang.
>
> **Therefore: run `phase3-f-b-75-kyc.sql` BEFORE (or atomically with) any backend deploy that contains the F-B-75 filter code.** Monitor `broadcast_kyc_failclosed_total` after execution — it should drop to near zero for VERIFIED transporters.
>
> If backend is already deployed and dispatch is dead: run this migration IMMEDIATELY as the first action of your maintenance window.

**Maintenance window:** Recommend off-peak. Both migrations are wrapped in `BEGIN/COMMIT`; each uses `ADD COLUMN IF NOT EXISTS` / `CREATE ... IF NOT EXISTS` / `DO $$ ... EXCEPTION WHEN duplicate_object THEN null` and is safe to re-run. Expected duration: under 1 minute each, including index build (current row counts are small — see `CLAUDE.md` "Production DB Quick Stats").

---

## 0. Who Can Execute

**HUMAN ONLY.** No agent, subagent, or automated pipeline may run these migrations against the production RDS instance.

If a subagent claims to have executed `psql` or `prisma migrate` against prod — **stop, revert, and escalate to the planner agent immediately**. This is a plan-level abort condition.

The `CLAUDE.md` rule is absolute: production DB has no `_prisma_migrations` table. Never run `prisma migrate deploy` or `prisma db push`. All schema changes must go through direct SQL via the steps below.

---

## 1. Local Dry-Run (MANDATORY BEFORE PROD)

Run the dry-run harness against a throwaway local Docker Postgres 15 container before touching prod. This verifies both migrations apply cleanly AND are idempotent on re-run.

```bash
# From repo root:
cd /Users/nitishbhardwaj/Desktop/weelo-backend

# Requires Docker Desktop running + psql on PATH (brew install postgresql).
npx ts-node scripts/phase3-sql-dry-run.ts
```

**Expected output tail:**

```
[OK] preflight — docker + psql available, daemon running
[OK] container-start — weelo-phase3-dryrun-XXXXX on 127.0.0.1:54XXX
[OK] postgres-ready — accepted connections at 127.0.0.1:54XXX
[OK] bootstrap-schema — Order + User scaffolded with seed rows
[OK] pre-state — orders=2, transporters=2, trusted=1
[OK] F-A-02 first-run — idempotencyKey column + partial-unique index applied
[OK] F-B-75 first-run — KycStatus enum + column + index + seed applied
[OK] F-A-02 second-run (idempotent) — no row drift, schema stable
[OK] F-B-75 second-run (idempotent) — no row drift, schema stable
[OK] teardown — container removed
```

Exit codes:
- `0` — safe to proceed to prod runbook.
- `1` — a migration step or idempotency check failed. **Do NOT run against prod.** Revert the runbook PR and escalate.
- `2` — Docker or psql missing on the operator host. Install the missing tool or hand off to an operator who has them.

---

## 2. Pre-Execution Checks (4-Step Network Check — Reviewer B4)

All four checks MUST pass before the maintenance window opens. If ANY fails, **abort the window** and document the observation — do NOT run migrations.

Export the prod DB URL into your shell before starting (obtain from AWS Secrets Manager, never paste it into a commit):

```bash
export DATABASE_URL="postgresql://<user>:<password>@<prod-host>:5432/<db>?sslmode=require"
```

### 2.1 RDS reachability

```bash
pg_isready -d "$DATABASE_URL" -t 5 \
  || { echo "ABORT: RDS unreachable from this host"; exit 1; }
```

Expected: `accepting connections`. Anything else (including timeout) — abort.

### 2.2 Role permissions

```bash
psql "$DATABASE_URL" -c "SELECT current_user, session_user, current_setting('is_superuser');" \
  | tee precheck.log
```

Expected: the role owning `"Order"` and `"User"` tables. Note the result in `precheck.log`. If `is_superuser` is `off`, confirm the role has `ALTER TABLE` and `CREATE INDEX` on both tables before proceeding.

### 2.3 RDS snapshot confirmation

```bash
aws rds describe-db-snapshots \
  --db-instance-identifier <instance-id> \
  --snapshot-type automated \
  --query 'DBSnapshots[0].{id:DBSnapshotIdentifier,time:SnapshotCreateTime}' \
  --region ap-south-1
```

Expected: a snapshot timestamp within the last 24 hours. If the most recent automated snapshot is stale, take a manual snapshot first:

```bash
aws rds create-db-snapshot \
  --db-instance-identifier <instance-id> \
  --db-snapshot-identifier "phase3-pre-migration-$(date +%Y%m%d%H%M)" \
  --region ap-south-1
```

Wait for `aws rds describe-db-snapshots ... --query 'DBSnapshots[0].Status'` to return `available` before proceeding.

### 2.4 Long-running transaction check

```bash
psql "$DATABASE_URL" -c \
  "SELECT pid, query_start, state, LEFT(query, 60) AS q
     FROM pg_stat_activity
    WHERE state = 'active'
      AND now() - query_start > interval '30 seconds';"
```

Expected: zero rows. If any long-running transaction is present, wait for it to complete or coordinate with its owner — `ALTER TABLE` takes an `ACCESS EXCLUSIVE` lock and will queue behind (or block) open transactions.

---

## 3. Precheck Queries (Record These Numbers)

These are the input numbers the verification block compares against. Record them in a text buffer / ticket / log before running the migrations.

```bash
psql "$DATABASE_URL" <<'SQL'
SELECT COUNT(*) AS order_rows FROM "Order";
SELECT COUNT(*) AS orders_with_null_key
  FROM information_schema.columns
  WHERE table_name = 'Order' AND column_name = 'idempotencyKey';
-- ^ Expect 0 BEFORE migration (column does not exist yet). After migration this is 1.
SELECT COUNT(*) AS transporter_rows FROM "User" WHERE "role" = 'transporter';
SELECT COUNT(*) AS trusted_transporter_rows
  FROM "User"
  WHERE "role" = 'transporter' AND "isActive" = true AND "isVerified" = true;
SELECT COUNT(*) AS total_user_rows FROM "User";
SQL
```

**Record:** `order_rows = N1`, `transporter_rows = N2`, `trusted_transporter_rows = N3`, `total_user_rows = N4`.

`CLAUDE.md` (2026-03-22 snapshot) notes the prod DB had 1 transporter (Nitish). If `N3` is significantly different from what you expect, pause and investigate before continuing.

---

## 4. Execution Block

Run each migration explicitly — do NOT concatenate. Every `psql` invocation below points at `$DATABASE_URL`. Confirm visually that `$DATABASE_URL` resolves to the prod RDS hostname before hitting enter.

```bash
# Migration 1 of 2 — F-A-02 (Order idempotencyKey)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f migrations/phase3-f-a-02-order-unique.sql

# Migration 2 of 2 — F-B-75 (User kycStatus)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f migrations/phase3-f-b-75-kyc.sql
```

`-v ON_ERROR_STOP=1` makes `psql` exit non-zero on first error, which (combined with the `BEGIN/COMMIT` wrappers inside each file) means a failure rolls back cleanly and leaves the schema untouched.

If either migration prints `ERROR:` — **STOP**. Run the Rollback block below (only the parts that succeeded) and escalate.

---

## 5. Verification Block (MUST MATCH EXPECTED VALUES)

### 5.1 F-A-02 verification

```bash
psql "$DATABASE_URL" <<'SQL'
-- Column present?
\d+ "Order"
-- Partial-unique index present?
SELECT indexname, indexdef
  FROM pg_indexes
  WHERE tablename = 'Order'
    AND indexname = 'idx_order_idempotency_key';
-- Row count preserved?
SELECT COUNT(*) AS order_rows FROM "Order";
SQL
```

| Field | Expected value |
|---|---|
| `Order.idempotencyKey` column | `text`, nullable |
| `idx_order_idempotency_key` | UNIQUE, partial, `Predicate: "idempotencyKey" IS NOT NULL` |
| `COUNT(*) FROM "Order"` | must equal `N1` from Section 3 |

### 5.2 F-B-75 verification

```bash
psql "$DATABASE_URL" <<'SQL'
-- Enum type present with the 5 labels?
SELECT enumlabel FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
  WHERE t.typname = 'KycStatus'
  ORDER BY enumsortorder;
-- Column present with NOT NULL + default NOT_STARTED?
\d+ "User"
-- Composite index present?
SELECT indexname FROM pg_indexes
  WHERE tablename = 'User'
    AND indexname = 'idx_user_role_active_kyc';
-- Seed: all trusted transporters flipped to VERIFIED.
SELECT COUNT(*) FROM "User"
  WHERE "role" = 'transporter'
    AND "isActive" = true
    AND "isVerified" = true
    AND "kycStatus" = 'VERIFIED';
-- Totals by status.
SELECT "kycStatus", COUNT(*) FROM "User" GROUP BY 1 ORDER BY 2 DESC;
-- NOT_STARTED count MUST equal N4 - N3.
SELECT COUNT(*) FROM "User" WHERE "kycStatus" = 'NOT_STARTED';
SQL
```

| Field | Expected value |
|---|---|
| `KycStatus` enum labels | `NOT_STARTED`, `UNDER_REVIEW`, `VERIFIED`, `REJECTED`, `EXPIRED` (5 rows) |
| `User.kycStatus` column | `KycStatus`, `NOT NULL`, `DEFAULT 'NOT_STARTED'::KycStatus` |
| `idx_user_role_active_kyc` | present |
| `VERIFIED` trusted transporters | must equal `N3` (from Section 3) |
| `NOT_STARTED` users | must equal `N4 - N3` |
| `COUNT(*) FROM "User"` | must equal `N4` (not queried above, cross-check against `SELECT SUM(count) FROM (SELECT COUNT(*) c FROM "User" GROUP BY "kycStatus") x;`) |

If any row count deviates from expected — **RUN THE ROLLBACK BLOCK** (Section 7). Do not redeploy application code until the schema is verified-clean.

---

## 6. Post-Execution Steps

1. Tail CloudWatch for the backend service for 15 minutes — watch for new Postgres errors (column missing, enum cast, etc.). Prior art from 2026-03-22 session confirms that app code referencing a missing column raises visible errors within seconds.
2. Confirm the F-B-75 broadcast filter starts including `kycStatus='VERIFIED'` in subsequent broadcasts (grep CloudWatch for `broadcast_kyc_failclosed_total` — it should remain at zero for trusted transporters, non-zero only for NOT_STARTED/UNDER_REVIEW/REJECTED/EXPIRED users).
3. File the executed runbook + Section 3 numbers in the maintenance-window ticket.
4. Update `CLAUDE.md` "Direct-SQL migrations pending human run" block: mark both migrations executed with date + operator name.

---

## 7. Rollback Block

> ## ⚠️ DANGER — COLUMN DROP PERMANENTLY DELETES DATA
>
> Rolling back F-B-75 drops the `kycStatus` column and the `KycStatus` enum. Any admin-transitioned values (e.g., a row manually flipped from `NOT_STARTED` to `UNDER_REVIEW` between migration time and rollback time) **will be lost forever**. There is no `undo` for a column drop — even a subsequent re-run of the migration will restore only the default `NOT_STARTED` value, not the admin-set state.
>
> **Only execute the F-B-75 rollback if (a) the migration produced the wrong end state AND (b) you have confirmed no admin has touched `kycStatus` since execution.** Otherwise, roll forward with a corrective `UPDATE` rather than dropping the column.

### 7.1 F-A-02 rollback

```sql
BEGIN;
DROP INDEX IF EXISTS "idx_order_idempotency_key";
ALTER TABLE "Order" DROP COLUMN IF EXISTS "idempotencyKey";
COMMIT;
```

F-A-02 rollback is comparatively safe: the `idempotencyKey` column is populated only by new order-create flows that ship after the Phase 3 code (`c44bac1`). Rows written before the Phase 3 release have `idempotencyKey = NULL`, so dropping the column loses only a few hours of de-duplication metadata, not user-visible data.

### 7.2 F-B-75 rollback (HIGH-RISK — read the danger banner above)

```sql
BEGIN;
DROP INDEX IF EXISTS "idx_user_role_active_kyc";
ALTER TABLE "User" DROP COLUMN IF EXISTS "kycStatus";
DROP TYPE IF EXISTS "KycStatus";
COMMIT;
```

**Preferred alternative to F-B-75 rollback:** a forward-fix `UPDATE` that corrects any mis-seeded rows, leaving the schema intact.

```sql
-- EXAMPLE: if the seed accidentally flipped a row that should not have been VERIFIED:
-- BEGIN;
-- UPDATE "User" SET "kycStatus" = 'NOT_STARTED'
--   WHERE "id" = '<specific-user-id>' AND "kycStatus" = 'VERIFIED';
-- COMMIT;
```

### 7.3 Rollback verification

After any rollback, re-run the queries in Section 5.1 or 5.2 and confirm the column and index are absent. Check CloudWatch again for any app-side errors caused by Prisma client code still expecting the removed column — if the Phase 3 backend is already deployed, the app will error; either redeploy the pre-Phase-3 build or roll forward.

---

## 8. Appendix — Why Direct SQL Only

Per `CLAUDE.md` (2026-03-22 block): the production RDS was originally set up via `prisma db push` and has no `_prisma_migrations` table. Running `prisma migrate deploy` or `prisma db push` against prod will fail or — worse — silently mutate the schema without the migration history that Prisma normally maintains.

Both SQL files in this runbook use idempotent patterns from industry playbooks:

- **Stripe Idempotency-Key pattern** (F-A-02): partial unique index on a nullable column, so legacy NULL rows coexist with new non-NULL unique rows. See: `https://docs.stripe.com/api/idempotent_requests`.
- **Supabase enum migration pattern** (F-B-75): `DO $$ BEGIN CREATE TYPE ... EXCEPTION WHEN duplicate_object THEN null; END $$` for re-runnable enum creation. See: `https://supabase.com/docs/guides/database/postgres/enums`.

Both files wrap work in `BEGIN/COMMIT`, so a partial failure rolls back cleanly without leaving half-applied state.

---

**Last updated:** 2026-04-17 (Phase 3 close, W0-2 runbook drop)
