# RDS Upgrade Runbook: db.t4g.micro → db.r6g.xlarge

**Status:** Operator-executed, DOC ONLY — no AWS commands are run by automation.
**Region:** ap-south-1
**Source:** index-20-validated.md §7C 0.3 (lines 2955–2996)

---

## Why

Fix §7C item 0.3 gates the Fix #2 worker ramp (HPA scale-out to MaxCapacity=5 pods).

At db.t4g.micro, max_connections ≈ 256. Each pod consumes up to 125 Prisma connections + 224
BRPOP connections = 349 per pod. Five pods at peak = 1,745 connections required. The micro class
cannot support this — the 5th pod hits connection-refused under saturation.

db.r6g.xlarge raises max_connections to ≈ 3,201 (AWS formula:
`LEAST(DBInstanceClassMemory/9531392, 5000)`). Peak utilization at HPA Max=5 is 1,745/3,201 =
54.5%, preserving 45% headroom for 500 RPS bursts.

**Do NOT use db.r6g.large** — at MaxCapacity=5 it runs at 109% utilization (connection-refused
on the 5th pod under saturation).

Hard gate 0.3 must pass before proceeding to §7C 0.4.

---

## Environment Variables (fill from AWS console / Secrets Manager — NOT in repo)

```bash
export RDS_INSTANCE_ID="<your-rds-instance-identifier>"
export ECS_CLUSTER="<your-ecs-cluster-name>"
export ECS_SERVICE="<your-ecs-service-name>"
export AWS_REGION="ap-south-1"
export TASK_FAMILY="weelobackendtask"
```

---

## Pre-Flight Checks

Run all of the following before touching the instance. These commands are read-only.

### 1. Confirm repo HEAD

```bash
git -C /Users/nitishbhardwaj/Downloads/weelo-backend rev-parse HEAD
# Expected: d97b59079f62e87f6662ba2d367a548c7f3ff2d1 (post-Phase 1+2+3 ship, build clean)
# Earlier audit drafts cited HEAD 8f400201 (pre-Phase ship); both contain the §1.2 spec
# referenced below. If HEAD is a later commit, run `git log --oneline 8f400201..HEAD --
# src/shared/database/prisma.service.ts` to confirm the §1.2 Step 3 URL guard is still
# in place before proceeding. If HEAD is unrelated, stop and consult the team lead.
```

### 2. Confirm current instance class and state

```bash
aws rds describe-db-instances \
  --db-instance-identifier "$RDS_INSTANCE_ID" \
  --region "$AWS_REGION" \
  --query 'DBInstances[0].{Class:DBInstanceClass,Status:DBInstanceStatus,MultiAZ:MultiAZ,Engine:Engine,EngineVersion:EngineVersion}' \
  --output table
# Expected: Class=db.t4g.micro, Status=available
# If Status != available, do NOT proceed.
# MultiAZ=False is expected per current architecture (5–15 min downtime on reboot).
```

### 3. Check current connection count

Connect via psql through the bastion/VPN:

```sql
SELECT count(*) AS active_connections FROM pg_stat_activity;
-- Schedule upgrade when this is lowest (off-peak; current production peak is 10–30 RPS).
```

### 4. Take a manual snapshot (safety net)

```bash
SNAPSHOT_ID="pre-r6g-upgrade-$(date +%Y%m%d-%H%M)"

aws rds create-db-snapshot \
  --db-instance-identifier "$RDS_INSTANCE_ID" \
  --db-snapshot-identifier "$SNAPSHOT_ID" \
  --region "$AWS_REGION"

aws rds wait db-snapshot-available \
  --db-snapshot-identifier "$SNAPSHOT_ID" \
  --region "$AWS_REGION"

echo "Snapshot ready: $SNAPSHOT_ID"
```

Wait for the snapshot to complete before moving to Execution. The `wait` command blocks until
the snapshot reaches status=available (typically 5–10 min).

---

## Execution

Run during a pre-agreed off-peak maintenance window. Notify the on-call engineer before starting.

### Step 1 — Trigger the class change

```bash
aws rds modify-db-instance \
  --db-instance-identifier "$RDS_INSTANCE_ID" \
  --db-instance-class db.r6g.xlarge \
  --apply-immediately \
  --region "$AWS_REGION"
```

`--apply-immediately` causes an instance reboot. Expect 5–15 minutes of downtime while the
instance restarts into the new class (Multi-AZ=False; no failover available).

### Step 2 — Wait for instance to become available

```bash
aws rds wait db-instance-available \
  --db-instance-identifier "$RDS_INSTANCE_ID" \
  --region "$AWS_REGION"

echo "Instance is available."
```

The `wait` command polls every 30 seconds and exits when status=available, or errors after
40 attempts (~20 min). If it times out, check the RDS Events console before retrying.

---

## Verification (Hard Gate 0.3)

All three checks must pass before advancing to §7C 0.4.

### Check 1 — Confirm new instance class and status

```bash
aws rds describe-db-instances \
  --db-instance-identifier "$RDS_INSTANCE_ID" \
  --region "$AWS_REGION" \
  --query 'DBInstances[0].{Class:DBInstanceClass,Status:DBInstanceStatus,MultiAZ:MultiAZ}' \
  --output table
# Required: Class=db.r6g.xlarge, Status=available
```

### Check 2 — Confirm max_connections >= 3,000

Connect via psql through bastion/VPN:

```sql
SELECT setting::int AS max_connections
FROM pg_settings
WHERE name = 'max_connections';
-- Required: value between 3,000 and 3,201
-- AWS formula: LEAST(DBInstanceClassMemory/9531392, 5000)
```

### Check 3 — Confirm basic connectivity

```sql
SELECT 1;
-- Must succeed without error.
```

If all three pass, gate 0.3 is cleared. Document the actual max_connections value and timestamp
in the deployment log before proceeding.

---

## Rollback

If any verification check fails or the instance does not recover within 20 minutes:

### Revert to db.t4g.micro

```bash
aws rds modify-db-instance \
  --db-instance-identifier "$RDS_INSTANCE_ID" \
  --db-instance-class db.t4g.micro \
  --apply-immediately \
  --region "$AWS_REGION"

aws rds wait db-instance-available \
  --db-instance-identifier "$RDS_INSTANCE_ID" \
  --region "$AWS_REGION"
```

### Restore from snapshot (data loss scenario only)

Use only if the instance itself is corrupt and revert above is not viable:

```bash
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier "${RDS_INSTANCE_ID}-restored" \
  --db-snapshot-identifier "$SNAPSHOT_ID" \
  --db-instance-class db.t4g.micro \
  --region "$AWS_REGION"
```

Update the application's DB connection string to point to the restored instance, then verify
with Check 3 above. Note: rows written after the snapshot was taken will be lost.

---

## Downtime Window

| Item | Detail |
|---|---|
| Expected duration | 5–15 minutes |
| Multi-AZ | False (no automatic failover) |
| Best time | Off-peak; current production peak is 10–30 RPS |
| Suggested window | 02:00–04:00 IST on a weekday |
| Who pages | On-call engineer must be notified before Step 1 |
| Customer impact | API unavailable during reboot; ECS tasks will reconnect automatically on instance restore |

ECS tasks reconnect automatically once the DB is available — no ECS restart required unless
CloudWatch logs show persistent connection errors after the instance returns.

---

## Hard Rule — Schema Changes on This Production DB

**NEVER run `prisma migrate deploy` on production.**

The production database was bootstrapped with `prisma db push`, NOT `prisma migrate deploy`.
There is no `_prisma_migrations` table. Running `prisma migrate deploy` will fail or corrupt
the schema. Running `prisma db push` may silently drop or alter columns.

All schema changes on this production DB must be applied as direct SQL via psql:

- Use `ADD COLUMN IF NOT EXISTS` for new columns.
- Wrap DDL in `DO $$ BEGIN ... EXCEPTION WHEN duplicate_column THEN NULL; END $$` for safety.
- Wrap every change in `BEGIN; ... COMMIT;` and verify before committing.
- Never use `DROP COLUMN` without an explicit backup and team-lead sign-off.

This rule applies regardless of what migration files exist in the repo. The repo migration
files have never run on production and should be treated as documentation only.

Reference: CLAUDE.md section "CRITICAL RULES FOR THIS DB" (lines 510–514).
