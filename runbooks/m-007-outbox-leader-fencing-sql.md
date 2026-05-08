# M-007 Runbook: Outbox Leader Fencing — Direct psql SQL

**Status:** Operator-executed, DOC ONLY — no SQL is run by automation.
**Region:** ap-south-1 (RDS PostgreSQL)
**Source of truth (SQL):** `migrations/M-007-outbox-fence-seq.sql`
**Source of truth (sequence):** `index-20-validated.md` §4.1 step 4 (line 2187), §7B Week 2 (line 2814), B-N-9 (line 3334).

---

## Purpose

M-007 adds the schema needed by Fix #20 (outbox leader fail-CLOSED + leader fencing). Specifically:

1. A monotonic claim-token sequence `outbox_fence_seq`. Every leader claim bumps and writes this onto the row. A previously-stomped leader retrying after a new leader has advanced the seq fails the CAS.
2. A new column `OrderDispatchOutbox."claimToken" BIGINT NULL` carrying that token. NULL on legacy rows; the code treats NULL as "no fence check, fall back to SKIP LOCKED".
3. A partial index `idx_odoutbox_unprocessed_fence` on the hot poller path (`nextRetryAt`, `claimToken`) WHERE `processedAt IS NULL`.

Risk: **LOW** — schema-add only, column is nullable, index is partial. Existing code ignores the new column; new code falls back to SKIP LOCKED on NULL.

---

## Why direct psql, not `prisma migrate deploy`

The production database was bootstrapped with `prisma db push`, NOT `prisma migrate deploy`. **There is no `_prisma_migrations` table.** Running `prisma migrate deploy` will fail or corrupt the schema. Running `prisma db push` may silently drop or alter columns.

All schema changes on this DB are direct SQL via psql, with `ADD COLUMN IF NOT EXISTS` + `BEGIN`/`COMMIT` and `DO $$ BEGIN … EXCEPTION … END $$` blocks for idempotency. Reference: CLAUDE.md "CRITICAL RULES FOR THIS DB".

---

## Sequence Requirement (DO NOT RUN OUT OF ORDER)

Per index-20-validated.md §4.1, M-007 SQL must run **AFTER** Fix #20 catch-block code is deployed and stable, and **BEFORE** `FF_OUTBOX_LEADER_FENCING=true` is flipped:

1. Metric registration `outbox_leader_election_redis_error_total` deployed and baked one cycle.
2. B-N-13 split-key canonicalization landed.
3. Fix #20 catch-block fail-CLOSED change deployed; canary baked 30 min with metric flat.
4. **THIS RUNBOOK** — execute M-007 SQL via direct psql.
5. Flip `FF_OUTBOX_LEADER_FENCING=true` on canary; watch `outbox_leader_elections_total{result="acquired"}` 30 min.
6. Roll out to remaining tasks.

Running M-007 ahead of step 3 is harmless (column is nullable; legacy code ignores it). Running it *after* a flag flip is broken — the flag enables code that reads the column on a row where the column does not exist yet, producing 500s.

---

## Connection Notes

The production RDS instance is in a private VPC. Operators connect via:

- **VPN/bastion** (preferred) — operator workstation tunnels into the VPC, then psql connects to the RDS endpoint on port 5432.
- **AWS Session Manager** to a bastion EC2 host, with psql installed there.

Credentials and the RDS endpoint are stored in **AWS Secrets Manager**. Do not hardcode them in this runbook or in shell history. Pull them at runtime, e.g.:

```bash
# Operator-supplied — do NOT check values into source control.
export PGHOST="<rds-endpoint-from-secrets-manager>"
export PGPORT="5432"
export PGDATABASE="<dbname>"
export PGUSER="<admin-user>"
export PGPASSWORD="<from-secrets-manager>"   # consider `read -s` instead of export
```

If the RDS instance was secured per `Desktop/DB_SECURITY_CHANGES.md` (publicly accessible = false), the bastion/VPN path is mandatory; direct psql from a laptop will time out.

Open a single psql session for pre-flight, execution, and verification so the operator sees a coherent transcript:

```bash
psql --host="$PGHOST" --port="$PGPORT" --dbname="$PGDATABASE" --username="$PGUSER" --no-psqlrc
```

Keep the session open across the whole runbook — do **not** open three separate sessions.

---

## Pre-Flight (read-only)

All pre-flight checks must pass before executing the SQL.

### 1. Confirm repo state and source-of-truth file

```bash
git -C /Users/nitishbhardwaj/Downloads/weelo-backend rev-parse HEAD
# Record HEAD in the deploy log.

cat /Users/nitishbhardwaj/Downloads/weelo-backend/migrations/M-007-outbox-fence-seq.sql
# Confirm the SQL the operator is about to run matches what is in this runbook.
# If they diverge, STOP and consult the team lead — the migration file wins.
```

### 2. Confirm Fix #20 code is live and metric is flat

Per §4.1 step 3, the fail-CLOSED change must be deployed and stable before this runbook runs. Spot-check:

```bash
# Counter exists and is registered (zero or low value is the success signal).
# Use whatever metrics surface your platform exposes — Prometheus, CloudWatch, etc.
# Required: outbox_leader_election_redis_error_total{path="legacy"} flat for 30 min.
```

### 3. Confirm flag is OFF

The flag flip happens **after** this runbook. Confirm the canary task definition does not yet have `FF_OUTBOX_LEADER_FENCING=true`:

```bash
aws ecs describe-task-definition \
  --task-definition weelobackendtask \
  --region ap-south-1 \
  --query 'taskDefinition.containerDefinitions[0].environment[?name==`FF_OUTBOX_LEADER_FENCING`].value' \
  --output text
# Expected: empty, or "false". If "true" appears, STOP — sequence is broken.
```

### 4. Confirm columns / sequence / index DO NOT yet exist

In psql:

```sql
\d "OrderDispatchOutbox"
-- Required: column "claimToken" is NOT in the column list yet.
-- If it is already present, the SQL has likely been run before — skip Execute, proceed to Verify.

SELECT 1
FROM pg_class
WHERE relkind = 'S' AND relname = 'outbox_fence_seq';
-- Required: zero rows. If one row, sequence already exists — Execute is still safe (CREATE SEQUENCE IF NOT EXISTS).

SELECT 1
FROM pg_class
WHERE relkind = 'i' AND relname = 'idx_odoutbox_unprocessed_fence';
-- Required: zero rows. If one row, index already exists — Execute is still safe (CREATE INDEX CONCURRENTLY IF NOT EXISTS).
```

### 5. Confirm DB load is light

```sql
SELECT count(*) AS active_connections FROM pg_stat_activity;
SELECT count(*) AS unprocessed_outbox
FROM "OrderDispatchOutbox"
WHERE "processedAt" IS NULL;
```

The partial index is created with `CONCURRENTLY` (no exclusive lock), so it is safe under load. Still prefer an off-peak window if `unprocessed_outbox` is unusually large — index build time scales with row count.

---

## The SQL

The transactional portion (sequence + column) is run inside `BEGIN`/`COMMIT`. The `CREATE INDEX CONCURRENTLY` step **must run outside any transaction** — Postgres rejects `CONCURRENTLY` inside a transaction block. Run the two blocks in this order, in the same psql session.

### Block 1 — Sequence + Column (transactional)

```sql
BEGIN;

-- Monotonic claim-token sequence.
DO $$
BEGIN
  CREATE SEQUENCE IF NOT EXISTS outbox_fence_seq START 1 INCREMENT 1;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- Nullable claim-token column on the outbox table.
ALTER TABLE "OrderDispatchOutbox"
  ADD COLUMN IF NOT EXISTS "claimToken" BIGINT NULL;

COMMIT;
```

Before issuing `COMMIT`, run a sanity probe in the same transaction (open a second psql to inspect, OR use `\d` after a brief pause). If anything looks wrong, `ROLLBACK` instead of `COMMIT` — the transaction is fully reversible up to that point.

### Block 2 — Partial index (NON-transactional)

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_odoutbox_unprocessed_fence"
  ON "OrderDispatchOutbox" ("nextRetryAt", "claimToken")
  WHERE "processedAt" IS NULL;
```

`CONCURRENTLY` does not block readers/writers. If the build fails (e.g., interrupted), Postgres leaves an INVALID index behind — use `\d "OrderDispatchOutbox"` to spot it (suffix `INVALID`), then drop and retry:

```sql
DROP INDEX IF EXISTS "idx_odoutbox_unprocessed_fence";
-- then re-run the CREATE INDEX CONCURRENTLY above.
```

---

## Post-Run Verify

All three checks must pass.

### Check 1 — Column exists, NULLABLE, BIGINT

```sql
\d "OrderDispatchOutbox"
-- Required: a row reading
--   "claimToken" | bigint |  |  |
-- (column name | type | collation | nullable | default — nullable column is blank under "Nullable" because the printer omits it; explicit check below.)

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'OrderDispatchOutbox'
  AND column_name = 'claimToken';
-- Required: one row, data_type = 'bigint', is_nullable = 'YES'.
```

### Check 2 — Sequence exists and starts at 1

```sql
SELECT sequence_name, start_value, increment, last_value
FROM information_schema.sequences s
JOIN pg_sequences ps ON ps.sequencename = s.sequence_name
WHERE s.sequence_name = 'outbox_fence_seq';
-- Required: one row, start_value = 1, increment = 1.
-- last_value may be 1 (if nextval has been called) or NULL/unset (if not).
```

### Check 3 — Partial index exists and is VALID

```sql
SELECT
  i.indexname,
  i.indexdef,
  pg_get_indexdef(c.oid)         AS def,
  ix.indisvalid                   AS is_valid
FROM pg_indexes i
JOIN pg_class c ON c.relname = i.indexname
JOIN pg_index ix ON ix.indexrelid = c.oid
WHERE i.indexname = 'idx_odoutbox_unprocessed_fence';
-- Required: one row, is_valid = true,
-- indexdef contains: ON public."OrderDispatchOutbox" ("nextRetryAt", "claimToken")
-- AND: WHERE ("processedAt" IS NULL)
```

If `is_valid = false`, the CONCURRENTLY build was interrupted — drop and rebuild as shown in Block 2.

### Check 4 — Existing rows are unaffected

```sql
SELECT count(*) AS total_rows,
       count("claimToken") AS rows_with_token,
       count(*) - count("claimToken") AS rows_with_null_token
FROM "OrderDispatchOutbox";
-- Required: rows_with_token = 0 immediately after the migration; rows_with_null_token = total_rows.
-- This will change once the flag is flipped — at that point the new poller path begins writing tokens.
```

If all four checks pass, M-007 is complete. Document the timestamp, HEAD SHA, and the post-run verification output in the deploy log before proceeding to step 5 of §4.1 (flag flip on canary).

---

## Rollback SQL

Rollback is supported but should only be used if a defect is discovered post-execution and pre-flag-flip. Once `FF_OUTBOX_LEADER_FENCING=true` has run for any meaningful duration, a rollback drops the column the live code is reading and writing — **flip the flag back to OFF first**, bake one minute, then run rollback.

### Block R1 — Drop the partial index (NON-transactional)

```sql
DROP INDEX CONCURRENTLY IF EXISTS "idx_odoutbox_unprocessed_fence";
```

`CONCURRENTLY` so writes/reads continue. As with `CREATE`, this cannot run inside a transaction.

### Block R2 — Drop column + sequence (transactional)

```sql
BEGIN;

ALTER TABLE "OrderDispatchOutbox"
  DROP COLUMN IF EXISTS "claimToken";

DO $$
BEGIN
  DROP SEQUENCE IF EXISTS outbox_fence_seq;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$$;

COMMIT;
```

After rollback:

```sql
\d "OrderDispatchOutbox"
-- Required: no "claimToken" column.

SELECT 1 FROM pg_class
WHERE relkind = 'S' AND relname = 'outbox_fence_seq';
-- Required: zero rows.

SELECT 1 FROM pg_class
WHERE relkind = 'i' AND relname = 'idx_odoutbox_unprocessed_fence';
-- Required: zero rows.
```

---

## Hard Rules — Direct SQL on This Production DB

Per CLAUDE.md "CRITICAL RULES FOR THIS DB":

1. **NEVER run `prisma migrate deploy`** on production — `_prisma_migrations` does not exist; it will fail.
2. **NEVER run `prisma db push`** on production — it may drop/alter columns without warning.
3. **All schema changes = direct SQL** via the psql connection above.
4. **Always use `ADD COLUMN IF NOT EXISTS`** and `DO $$ BEGIN … EXCEPTION … END $$` for safety.
5. **Always wrap in `BEGIN`/`COMMIT`** transactions and verify before committing. `CONCURRENTLY` operations are the documented exception.

This runbook applies regardless of what migration files exist in the repo. The `migrations/` directory in source control is documentation/author-of-record, not an execution log.

---

## References

- `migrations/M-007-outbox-fence-seq.sql` — author-of-record SQL (this runbook is its psql operator wrapper).
- `index-20-validated.md` §4.1 step 4 (line 2187) — sequence requirement.
- `index-20-validated.md` §7B Week 2 (line 2814) — total Week-2 LOC + SQL inventory.
- `index-20-validated.md` B-N-9 (line 3334) — operator state tracking gap.
- `CLAUDE.md` "CRITICAL RULES FOR THIS DB" — direct psql mandate.
- `runbooks/rds-upgrade.md` — sibling runbook, same connection/operator pattern.
