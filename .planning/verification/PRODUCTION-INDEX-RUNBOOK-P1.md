# Phase-P1 Production Index Runbook — SC1 + SC2

**Owner:** T1.4 (DBA / Index Owner)
**Ticket IDs:** SC1, SC2
**SQL file:** `prisma/manual-migrations/phase-p1-sc1-sc2-indexes.sql`
**Target environment:** AWS RDS `weelobackend` production (ap-south-1)
**Executor:** Human director ONLY. No agent may run `psql` against prod (see `CLAUDE.md` §"CRITICAL RULES FOR THIS DB" + `scripts/phase3-sql-dry-run.ts:19`).

---

## TL;DR

```bash
# (After RDS snapshot — see Step 1)
psql "$PROD_DATABASE_URL" -f prisma/manual-migrations/phase-p1-sc1-sc2-indexes.sql
```

Expected duration on current row counts (User ~13, Vehicle ~7 per `CLAUDE.md` §"PRODUCTION DB QUICK STATS"): **under 2 seconds total**, both indexes.

---

## Why these indexes

| Ticket | Index | Target query |
|---|---|---|
| SC1 | `idx_user_kyc_broadcast` — `(kycStatus, isVerified, isActive)` | Broadcast KYC gate: `User WHERE id IN (...) AND isActive AND isVerified AND kycStatus='VERIFIED'` |
| SC2 | `idx_vehicle_key_avail` — partial `(vehicleKey, transporterId) WHERE isActive=true AND status='available'` | Dispatch lookup: `Vehicle WHERE vehicleKey IN (...) AND isActive AND status='available'` |

### Why partial for SC2, not SC1?

- SC2's hot path is always gated by `isActive=true AND status='available'` — the vast majority of `Vehicle` rows fail that filter (on_hold / in_transit / maintenance / inactive). A partial index on just the 'available' slice is **5–10× smaller** and **2–3× faster** for the hot path. Other query shapes are covered by existing `@@index([status, isActive, vehicleType])` and `@@index([transporterId, status, isActive])`.
- SC1's call sites read `kycStatus` in several shapes (admin dashboards filter on `UNDER_REVIEW`/`REJECTED` too). A non-partial composite keeps the index useful for more than just the `VERIFIED` subset.

### Does SC2 conflict with existing `(isActive, vehicleKey, status)` composite?

No. The existing broader index (if/when applied) starts with `isActive` (low cardinality) then `vehicleKey` — good for `isActive=true` scans. `idx_vehicle_key_avail` is **more selective** because the `WHERE` predicate filters ~95% of rows before the index is consulted. The planner will prefer the partial index when the query matches the exact predicate. Both can coexist — Postgres scores index selection per-query.

---

## Dependency — SC1 requires F-B-75

SC1 references the `kycStatus` column, which is added by ticket F-B-75 (`migrations/phase3-f-b-75-kyc.sql`). The director must confirm **F-B-75 has landed in prod** before running this runbook. If the column does not exist, the SC1 `CREATE INDEX` will fail with `column "kycStatus" of relation "User" does not exist`.

Pre-flight check:
```sql
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'User' AND column_name = 'kycStatus';
-- Must return one row: kycStatus | USER-DEFINED (KycStatus enum).
```

If the column is missing, STOP and run F-B-75 first.

SC2 has no schema dependency — the `Vehicle.vehicleKey`, `isActive`, `status` columns all exist on `main`.

---

## Step 1 — RDS snapshot (MANDATORY)

Before any schema change, take an RDS snapshot. This is the universal rollback tier.

AWS Console (recommended — leaves a screenshot for the handoff):
1. Navigate to RDS → Databases → `weelobackend`.
2. Actions → Take snapshot.
3. Snapshot identifier: `pre-phase-p1-sc1-sc2-<YYYYMMDD-HHMM>`.
4. Wait for status `available` (typically 2–5 min for this DB's size).
5. Screenshot the snapshot row and attach to the T1.7 P1 handoff.

AWS CLI alternative:
```bash
SNAPSHOT_ID="pre-phase-p1-sc1-sc2-$(date +%Y%m%d-%H%M)"
aws rds create-db-snapshot \
  --db-instance-identifier weelobackend \
  --db-snapshot-identifier "$SNAPSHOT_ID" \
  --region ap-south-1

aws rds wait db-snapshot-available \
  --db-snapshot-identifier "$SNAPSHOT_ID" \
  --region ap-south-1

echo "Snapshot ready: $SNAPSHOT_ID"
```

---

## Step 2 — Connect + apply

```bash
# Export the connection string from AWS Secrets Manager (never commit it).
export PROD_DATABASE_URL="$(aws secretsmanager get-secret-value \
  --secret-id weelobackend/database-url \
  --region ap-south-1 \
  --query SecretString \
  --output text)"

# Apply the migration. psql runs each statement in its own implicit
# transaction because the file contains CREATE INDEX CONCURRENTLY,
# which Postgres forbids inside BEGIN/COMMIT. IF NOT EXISTS makes each
# statement idempotent.
psql "$PROD_DATABASE_URL" -f prisma/manual-migrations/phase-p1-sc1-sc2-indexes.sql
```

`psql` will echo the EXPLAIN + verification SQL comments, then print the rows for the verification queries at the bottom of the file.

---

## Step 3 — Expected duration

| Row count (prod today) | Expected duration per index |
|---|---|
| `User` ≈ 13 rows | < 500 ms |
| `Vehicle` ≈ 7 rows | < 500 ms |

CREATE INDEX CONCURRENTLY has a multi-phase scan (two passes + validate). On a DB this small, the total wall-clock is dominated by connection + parse overhead, not the scan — expect the whole file to complete in under 2 seconds.

At steady-state growth (10× current) the SC1 scan on `User` will still be sub-second; SC2 partial will remain the fastest dispatch-path index regardless.

---

## Step 4 — Post-execution verification

The SQL file itself emits the canonical verification queries. For the handoff, capture the output of:

```sql
-- 1. Both indexes valid.
SELECT  c.relname        AS indexname,
        i.indisvalid     AS valid,
        pg_size_pretty(pg_relation_size(c.oid)) AS size
  FROM  pg_index      i
  JOIN  pg_class      c ON c.oid = i.indexrelid
  JOIN  pg_namespace  n ON n.oid = c.relnamespace
 WHERE  c.relname IN ('idx_user_kyc_broadcast', 'idx_vehicle_key_avail')
 ORDER BY c.relname;
-- Expect 2 rows. valid=t (true) for both. If valid=f on either, see Step 6.

-- 2. Definitions match.
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND indexname IN ('idx_user_kyc_broadcast', 'idx_vehicle_key_avail')
 ORDER BY indexname;
-- Expect:
--   idx_user_kyc_broadcast — CREATE INDEX ... ON public."User" ("kycStatus","isVerified","isActive")
--   idx_vehicle_key_avail — CREATE INDEX ... ON public."Vehicle" ("vehicleKey","transporterId") WHERE ...

-- 3. After ≥1h of real traffic, idx_scan > 0.
SELECT indexrelname AS indexname, idx_scan, idx_tup_read, idx_tup_fetch
  FROM pg_stat_user_indexes
 WHERE indexrelname IN ('idx_user_kyc_broadcast', 'idx_vehicle_key_avail')
 ORDER BY indexrelname;
-- At t+1h: idx_scan > 0 on both. If still 0 at t+24h, see Step 6.
```

### Optional — push idx_scan to CloudWatch (for T1.7's dashboard panel)

T1.7 may wire a CloudWatch custom metric so the P1 dashboard shows live index usage. The director runs (not this agent):

```bash
# Run ONCE after ~1h of live traffic. Feed each index's idx_scan as its own metric.
SC1_SCANS=$(psql "$PROD_DATABASE_URL" -Atc \
  "SELECT idx_scan FROM pg_stat_user_indexes WHERE indexrelname='idx_user_kyc_broadcast';")
SC2_SCANS=$(psql "$PROD_DATABASE_URL" -Atc \
  "SELECT idx_scan FROM pg_stat_user_indexes WHERE indexrelname='idx_vehicle_key_avail';")

aws cloudwatch put-metric-data \
  --namespace Weelo/Database \
  --region ap-south-1 \
  --metric-data \
    MetricName=PgIndexScans,Value="$SC1_SCANS",Unit=Count,Dimensions=IndexName=idx_user_kyc_broadcast \
    MetricName=PgIndexScans,Value="$SC2_SCANS",Unit=Count,Dimensions=IndexName=idx_vehicle_key_avail
```

For continuous population, wrap this in a CloudWatch-scheduled Lambda (out of scope for P1; flagged for T1.7's Phase-2 backlog).

---

## Step 5 — Rollback

Both drops are non-blocking. Run as separate statements, NOT in a transaction:

```sql
DROP INDEX CONCURRENTLY IF EXISTS "idx_user_kyc_broadcast";
DROP INDEX CONCURRENTLY IF EXISTS "idx_vehicle_key_avail";
```

Rollback expected duration: same envelope as creation (under 2 seconds at current scale).

Full restore (only if catastrophic — snapshot from Step 1):
```bash
# STOP application traffic first.
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier weelobackend-restored \
  --db-snapshot-identifier "$SNAPSHOT_ID" \
  --region ap-south-1
# Then swap DNS / Secrets Manager to point at the restored instance.
```

---

## Step 6 — Go / no-go criteria

Execute ONLY if ALL are true:

- [ ] F-B-75 has landed (pre-flight SQL in "Dependency" section returns 1 row).
- [ ] RDS snapshot `pre-phase-p1-sc1-sc2-*` is in `available` state.
- [ ] Director has reviewed the SQL file + this runbook and has confirmed the branch SHA in the PR body.
- [ ] No other DBA work is in-flight on prod (avoid concurrent `CREATE INDEX CONCURRENTLY` contention).
- [ ] `scripts/phase-p1-sc1-sc2-dry-run.ts` has been run locally (Docker) with exit code 0 AND indexes reported `valid=true`. If Docker was unavailable, the director confirms the SQL has been read line-by-line and the `IF NOT EXISTS` guards verified.

Stop and escalate if:

- `indisvalid=f` after the CREATE — the CONCURRENTLY build aborted. Drop the invalid index (`DROP INDEX CONCURRENTLY IF EXISTS idx_...`) and investigate before retrying.
- `idx_scan=0` at t+24h — either the planner is ignoring the index (stats stale; `ANALYZE "User"; ANALYZE "Vehicle";`) or no production traffic has exercised the target query.
- `idx_scan` on other indexes drops unexpectedly — a new index can occasionally cause the planner to mis-route. Compare `pg_stat_user_indexes` before/after; if `idx_user_isActive_role_idx` (or similar hot indexes) sees a sustained drop, roll back.

---

## Appendix A — Expected EXPLAIN plan shape

On prod row counts (User ~13, Vehicle ~7) the planner will likely choose **Seq Scan** for both queries because the table is small enough that the seq scan is cheaper than the index lookup. This is the correct decision at this scale. The indexes are a **forward-investment** for when the tables grow (thousands of transporters, tens of thousands of vehicles). Verification that the index is used should be performed on a **row-count-scaled staging DB**, not on current prod.

At staging scale (`User` ≈ 10k rows, `Vehicle` ≈ 10k rows) the expected plans are:

```text
-- SC1:
Bitmap Heap Scan on "User"
  Recheck Cond: (("kycStatus" = 'VERIFIED'::"KycStatus") AND "isVerified" AND "isActive")
  ->  Bitmap Index Scan on idx_user_kyc_broadcast
        Index Cond: ...

-- SC2:
Bitmap Heap Scan on "Vehicle"
  Recheck Cond: ("vehicleKey" = ANY (...))
  ->  Bitmap Index Scan on idx_vehicle_key_avail
        Index Cond: ...
```

If instead the plan shows `Seq Scan` at staging scale, run `ANALYZE "User"; ANALYZE "Vehicle";` and re-verify. If still `Seq Scan`, escalate — the indexes are not being used and the cost needs re-evaluation.

---

## Appendix B — Why CREATE INDEX CONCURRENTLY

Non-concurrent `CREATE INDEX` takes an `ACCESS EXCLUSIVE` lock on the table, blocking all reads and writes until the scan finishes. On a broadcast DB that takes dispatch writes every few seconds, this is unacceptable. `CONCURRENTLY` performs two heap scans, builds the index in the background, and validates — at the cost of ~2× longer wall-clock. For this DB's size the trade-off is negligible; at 100k+ rows the concurrent variant prevents a multi-second outage.

Postgres restriction: `CONCURRENTLY` cannot run inside `BEGIN/COMMIT`. The migration file intentionally omits transaction wrappers — each statement is implicitly its own transaction under psql's default mode.

---

## Appendix C — References

- SC1 spec: `.planning/verification/ISSUES-AND-SOLUTIONS.md` §"SC1 — Missing User composite index (kycStatus, isVerified, isActive)" (line 2612).
- SC2 spec: `.planning/verification/ISSUES-AND-SOLUTIONS.md` §"SC2 — Missing Vehicle composite index for vehicleKey IN (...) + isActive + status" (line 2708).
- Phase-1 onboarding: `.planning/verification/P1-TEAM-ONBOARDING.md`.
- DB rules: `CLAUDE.md` §"CRITICAL RULES FOR THIS DB" + §"KNOWN REMAINING ISSUES".
- Postgres docs: [Multicolumn Indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html), [Partial Indexes](https://www.postgresql.org/docs/current/indexes-partial.html), [CREATE INDEX CONCURRENTLY](https://www.postgresql.org/docs/current/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY).
