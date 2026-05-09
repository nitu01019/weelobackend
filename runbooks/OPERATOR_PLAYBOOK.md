# OPERATOR PLAYBOOK — End-to-End Ship Sequence (Phase 1 → Phase 2 → Phase 3)

**Source authority:**
- Ship plan: `/Users/nitishbhardwaj/Downloads/index-20-validated.md` §7C (executable plan), §7B (Round-6 ship plan), §1.3, §1.4, §1.5, §2.1.1, §4.1, §4.2, §4.4
- Final gate: [`SHIP_READY_CHECKLIST.md`](./SHIP_READY_CHECKLIST.md)

**Repo:** `/Users/nitishbhardwaj/Downloads/weelo-backend`

**Phase commits at playbook author time (2026-05-09):**

| Phase | Commit SHA | Subject |
|---|---|---|
| Phase 1 — outbox-hardening | `c3808abf` | `fix(outbox-hardening): Phase 1 — B-N-13 + #20 + #37 + #44 + #12 + M-007` |
| Phase 2 — timer-replay      | `0baa7955` | `fix(timer-replay): Phase 2 — #1 + #36 + NEW#1 + NEW#2 + #21 + #17 SADD + #31` |
| Phase 3 — cutover-cleanup   | `d97b5907` | `fix(cutover-cleanup): Phase 3 — #23 + #19c semantic + NEW#3 + #13 + skip audit` |

> **DOC-ONLY.** This playbook drives the operator end-to-end. No commands here execute automatically — every block is sourced + run manually after credentials are populated. Cross-reference the linked detail runbook for pre-flight, abort criteria, and per-step rollback.

> **Single rule above everything else:** before flipping any flag, confirm `git -C /Users/nitishbhardwaj/Downloads/weelo-backend rev-parse HEAD` matches the deployed task-def's image SHA. The three phase commits ship code; flag flips are independent operator steps that follow each phase's bake.

> **NO duplication of content.** Each step here is a thin pointer to the canonical runbook. If a discrepancy arises, the linked runbook wins, not this file.

---

## 0. Scope

This playbook covers **9 sections**, in execution order:

| § | Title | Outcome |
|---|---|---|
| 1 | Pre-flight (all phases) | HEAD verified, AWS creds sourced, bastion tested |
| 2 | Phase 1 deploy + M-007 SQL + outbox leader verify | `c3808abf` live, fence schema applied |
| 3 | Phase 2 deploy + 24h SADD bake clock starts | `0baa7955` live, SADD writes landing |
| 4 | Fix #2 worker ramp 1 → 4 → 8 → 16 | Workers at 16 with all 3 SLO gates green |
| 5 | Fix #6 flip `FF_BATCH_QUEUE_DEPTH_GUARD=true` | Depth-guard active + 30 min soak passed |
| 6 | Phase 3 deploy + verify changes live | `d97b5907` live |
| 7 | Fix #16 reaper leader-lock verify | Hard gate 5 met |
| 8 | Fix #17 flip `FF_CROSS_POD_ROOM_REPLAY=true` (after 24h SADD bake) | Cross-pod replay active, canary + full rollout |
| 9 | SHIP-COMPLETE gate (10 criteria) | All criteria green simultaneously |

**Total elapsed clock from §2 start to §9 complete:** approximately 30–35 hours (24 h dominated by the SADD bake; the rest is deploys + soaks).

---

## 1. Pre-flight — All Phases

Run sections 1.1 through 1.4 once at session start. None of these touch production.

### 1.1 — Verify repo HEAD = `d97b5907`

```bash
cd /Users/nitishbhardwaj/Downloads/weelo-backend
git rev-parse HEAD
# Expected: d97b59079f62e87f6662ba2d367a548c7f3ff2d1
```

**Abort if:** HEAD differs. Pull + verify before continuing — rolling out a different SHA is the leading cause of operator-side rework.

### 1.2 — Verify branch + working-tree state

```bash
git -C /Users/nitishbhardwaj/Downloads/weelo-backend status --short --branch
# Expected first line: ## fix/critical-broadcast-reliability-2026-04-21
# Working-tree may have unstaged changes (long-running WIP) — that's allowed.
# What matters: HEAD matches §1.1 above.

git log --oneline -5
# Expected top three commits in order: d97b5907, 0baa7955, c3808abf
```

**Abort if:** the three phase commits do not appear in that order at the tip of `HEAD~0..HEAD~2`. The playbook's deploy ladder will not work.

### 1.3 — Source AWS credentials + region

```bash
export AWS_REGION="ap-south-1"
export ECS_CLUSTER="<your-cluster-name>"        # e.g. weelo-cluster
export ECS_SERVICE="<your-service-name>"        # e.g. weelobackendservice
export TASK_FAMILY="weelobackendtask"
export RDS_INSTANCE_ID="<your-rds-instance-id>"
# AWS credentials: pull from secrets manager / SSO; do NOT hardcode

aws sts get-caller-identity --region "$AWS_REGION"
# Expected: JSON with Account/Arn/UserId. If 'Unable to locate credentials',
# re-source credentials before continuing.
```

**Abort if:** the call fails. No AWS step in this playbook can run without it.

### 1.4 — Verify bastion / VPN access to RDS + Redis

```bash
# Bastion / VPN must be active before §2.2 (M-007 SQL).
# Test psql reachability without running any SQL:
psql --host="$PGHOST" --port="$PGPORT" --dbname="$PGDATABASE" \
     --username="$PGUSER" --no-psqlrc -c "SELECT 1;"
# Expected: returns single row with value 1

# Test Redis reachability (used by §2.3, §3.3, §5, §7, §8):
redis-cli -h <prod-redis-host> -p 6379 PING
# Expected: PONG
```

**Abort if:** either fails. RDS is private-VPC per `m-007-outbox-leader-fencing-sql.md` §Connection Notes; you cannot reach it from a laptop without bastion/VPN. Resolve connectivity before continuing.

### 1.5 — Confirm Wk0 prerequisites are already complete

These are not in scope for this playbook but must be done first. Proceed to §2 only after each is verified.

| # | Prereq | Verification | Runbook |
|---|---|---|---|
| 1.5.1 | RDS upgraded to `db.r6g.xlarge`, `max_connections >= 3000` | `aws rds describe-db-instances --db-instance-identifier "$RDS_INSTANCE_ID" --query 'DBInstances[0].DBInstanceClass'` returns `"db.r6g.xlarge"` | [`rds-upgrade.md`](./rds-upgrade.md) |
| 1.5.2 | `DB_CONNECTION_LIMIT=125` on running task-def | `aws ecs describe-task-definition --task-definition "$TASK_FAMILY" --query 'taskDefinition.containerDefinitions[0].environment[?name==\`DB_CONNECTION_LIMIT\`].value' --output text` returns `"125"` | [`ecs-db-connection-limit.md`](./ecs-db-connection-limit.md) |
| 1.5.3 | HPA Min=2 / Max=5 registered | `aws application-autoscaling describe-scalable-targets --service-namespace ecs --resource-ids "service/${ECS_CLUSTER}/${ECS_SERVICE}" --query 'ScalableTargets[0].{Min:MinCapacity,Max:MaxCapacity}'` returns `{"Min":2,"Max":5}` | [`hpa-cap.md`](./hpa-cap.md) |

**Abort if:** any of the three is unmet. The Wk0 floor is the headroom budget for everything that follows; deploying onto an under-spec'd RDS will collapse Phase 2's worker ramp.

---

## 2. Phase 1 Deploy (commit `c3808abf`)

**What ships:** B-N-13 + Fix #20 + Fix #37 + Fix #44 + Fix #12 + M-007 runbook (six outbox-track fixes; behavioral day-one in BOTH legacy + fenced branches).

**Operator critical path:** push image → rolling deploy → run M-007 SQL → verify outbox single-leader.

### 2.1 ECS push + rolling deploy of `c3808abf`

```bash
# 2.1.1 — Capture rollback revision FIRST
PREV_REVISION_PHASE1=$(aws ecs describe-task-definition \
  --task-definition "$TASK_FAMILY" --region "$AWS_REGION" \
  --query 'taskDefinition.revision' --output text)
echo "PREV_REVISION_PHASE1=${PREV_REVISION_PHASE1}"   # SAVE THIS — needed for §2.4 rollback

# 2.1.2 — Build + push image (CI is the source of truth; replicate locally only if CI is not the deploy mechanism)
# Image SHA must match git rev-parse HEAD = c3808abf
# Reference: your CI's standard build pipeline pushes to ECR. After push, register a
# new task-definition revision pointing at the c3808abf image digest.

# 2.1.3 — Pull current task-def, swap image, register new revision
aws ecs describe-task-definition \
  --task-definition "$TASK_FAMILY" --region "$AWS_REGION" \
  --query 'taskDefinition' > /tmp/td-phase1.json

# Patch (jq or python): set containerDefinitions[0].image to ECR repo @ digest for c3808abf.
# Strip read-only fields: taskDefinitionArn, revision, status, requiresAttributes,
# compatibilities, registeredAt, registeredBy.
# Write to /tmp/td-phase1-new.json

NEW_REVISION_PHASE1=$(aws ecs register-task-definition \
  --cli-input-json file:///tmp/td-phase1-new.json --region "$AWS_REGION" \
  --query 'taskDefinition.revision' --output text)
echo "NEW_REVISION_PHASE1=${NEW_REVISION_PHASE1}"

# 2.1.4 — Rolling deploy
aws ecs update-service \
  --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" \
  --task-definition "${TASK_FAMILY}:${NEW_REVISION_PHASE1}" \
  --region "$AWS_REGION"

# 2.1.5 — Wait for stable
aws ecs wait services-stable \
  --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" \
  --region "$AWS_REGION"
echo "Phase 1 services-stable at $(date -u +%FT%TZ)"
```

**Expected output:** `services-stable` returns within ~3–5 min. `runningCount == desiredCount`.

**Abort criteria:**
- `services-stable` times out after 10 min → roll back to `${TASK_FAMILY}:${PREV_REVISION_PHASE1}` (§2.4) and investigate via CloudWatch logs.
- New tasks crash-loop → roll back immediately, do not proceed to §2.2.

### 2.2 Run M-007 SQL via direct psql

**Sequence rule (per `index-20-validated.md` §4.1 step 4):** AFTER Phase 1 deploy stable AND `outbox_leader_election_redis_error_total{path="legacy"}` flat for **30 min**; BEFORE the `FF_OUTBOX_LEADER_FENCING=true` flip.

Authority + complete steps: [`m-007-outbox-leader-fencing-sql.md`](./m-007-outbox-leader-fencing-sql.md)

The runbook covers:
- §Connection Notes — bastion/VPN psql session setup
- §Pre-Flight — 5 read-only checks (HEAD, Fix #20 metric, flag OFF, columns absent, DB load)
- §The SQL — Block 1 transactional (sequence + nullable column), Block 2 `CREATE INDEX CONCURRENTLY` (non-transactional)
- §Post-Run Verify — 4 checks (column type, sequence, index validity, existing rows untouched)
- §Rollback SQL — flag-OFF first, then drop index/column/sequence

Do NOT deviate from the runbook's sequence; the linked runbook is canonical. Document timestamp + HEAD SHA + verify output in your deploy log when done.

**Expected output (final state):**
- `\d "OrderDispatchOutbox"` shows `claimToken bigint` nullable
- `outbox_fence_seq` exists with `start_value=1`, `increment=1`
- Partial index `idx_odoutbox_unprocessed_fence` is `is_valid=true`

**Abort criteria:**
- Pre-flight check 2 fails (Fix #20 metric not flat for 30 min) → wait, do not run SQL
- Block 2 `CREATE INDEX CONCURRENTLY` leaves an `INVALID` index → drop and retry per runbook §Block 2
- Any post-verify check fails → run §Rollback SQL Blocks R1+R2, file incident note

### 2.3 Verify outbox leader single-key (canonical `outbox:leader`) post-deploy

Confirm that the deployed Phase 1 code is still on the canonical-key path. The B-N-13 fix at `order-dispatch-outbox.service.ts:540` makes both branches converge on the raw key `outbox:leader`; this is the hard pre-condition before any future fenced-leader flag flip.

```bash
# 2.3.1 — Confirm legacy (current) leader key is held by exactly one pod
redis-cli -h <prod-redis-host> -p 6379 GET 'outbox:leader'
# Expected: non-nil string (HOSTNAME / pod identifier of the elected leader)
# Pass criteria: exactly one non-nil key; no split-key shadows under
# 'lock:outbox:leader' or similar (B-N-13 eliminated those).

# 2.3.2 — Spot-check there is no split-key shadow
redis-cli -h <prod-redis-host> -p 6379 GET 'lock:outbox:leader'
# Expected: nil. The canonical path uses 'outbox:leader' directly via acquireLeader().
# A non-nil here would indicate B-N-13 did not deploy — STOP and reconfirm image SHA.

# 2.3.3 — Confirm Fix #20 fail-CLOSED counter is registered + flat
aws cloudwatch get-metric-statistics \
  --namespace "Weelo/Backend" \
  --metric-name "outbox_leader_election_redis_error_total" \
  --statistics Sum --period 300 \
  --start-time "$(date -u -v-30M +%FT%TZ 2>/dev/null || date -u --date='30 minutes ago' +%FT%TZ)" \
  --end-time   "$(date -u +%FT%TZ)" \
  --region "$AWS_REGION"
# Expected: Sum == 0 (or near-zero) over the past 30 min.
# Non-zero values mean Redis is failing redis-acquire calls; the catch-block
# now fail-CLOSEs (correct), but you must investigate before proceeding.
```

**Pass criteria:** `outbox:leader` non-nil + single, `lock:outbox:leader` nil, fail-CLOSED counter flat for 30 min.

**Abort criteria:** any of the three checks fails → roll back Phase 1 (§2.4) and file incident.

### 2.4 Phase 1 rollback (only if §2.1, §2.2, or §2.3 fails before §3)

```bash
aws ecs update-service \
  --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" \
  --task-definition "${TASK_FAMILY}:${PREV_REVISION_PHASE1}" \
  --force-new-deployment --region "$AWS_REGION"
aws ecs wait services-stable \
  --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" \
  --region "$AWS_REGION"
```

If M-007 SQL was already applied: keep the schema in place; legacy code ignores `claimToken` (NULL on every row). Only run M-007 §Rollback SQL if forensics rule out the schema as a contributing factor and the column must come back out — and ALWAYS confirm `FF_OUTBOX_LEADER_FENCING=false` first (per the runbook's flag-off-before-drop rule).

---

## 3. Phase 2 Deploy (commit `0baa7955`)

**What ships:** Fix #1 (timer scan LIMIT) + Fix #36 (timer DLQ ZSET) + NEW#1 (prefix-shard timer ZSETs) + NEW#2 (orphan recovery scheduler) + Fix #21 + Fix #17 SADD writers + Fix #31 (atomic Lua sweep).

**Operator critical path:** push image → rolling deploy → record SADD-bake clock-start → sample SCARD hourly to confirm SADD writes landing.

### 3.1 ECS push + rolling deploy of `0baa7955`

Procedure mirrors §2.1, with `PREV_REVISION_PHASE2`, `NEW_REVISION_PHASE2`, image SHA = `0baa7955`. Save `PREV_REVISION_PHASE2` for §3.4 rollback.

```bash
PREV_REVISION_PHASE2=$(aws ecs describe-task-definition \
  --task-definition "$TASK_FAMILY" --region "$AWS_REGION" \
  --query 'taskDefinition.revision' --output text)
echo "PREV_REVISION_PHASE2=${PREV_REVISION_PHASE2}"

# Repeat 2.1.2–2.1.5 substituting image digest for 0baa7955.
# Stable target: c3808abf was the previous revision (which is also Phase 1's NEW_REVISION_PHASE1).
```

**Expected output:** `services-stable` within ~3–5 min. `runningCount == desiredCount`.

**Abort criteria:** same as §2.1; on failure, revert to `${TASK_FAMILY}:${PREV_REVISION_PHASE2}` (which is Phase 1's revision, not Wk0). Do **not** roll back farther than one phase.

### 3.2 — Record the 24h SADD bake clock start

> **CRITICAL TIMING.** The 24h SADD bake clock begins at the moment Phase 2 stabilizes (`services-stable` from §3.1.5), NOT at Phase 3 deploy. Authority: `index-20-validated.md` lines 2199, 2725, 2821 ("ship SADD code FIRST, bake 24h, THEN flip flag").

```bash
# Record the timestamp in UTC; copy to your deploy log.
PHASE2_STABLE_TS=$(date -u +%FT%TZ)
echo "Phase 2 services-stable timestamp = ${PHASE2_STABLE_TS}"

# Compute the earliest legal flip time for FF_CROSS_POD_ROOM_REPLAY (§8.x).
date -u -v+24H +%FT%TZ 2>/dev/null \
  || date -u --date='24 hours' +%FT%TZ
# This is the earliest moment §8 may proceed (24h floor, 48h conservative).
```

Document `PHASE2_STABLE_TS` and the 24h-target in the deploy journal alongside Phase 2's task-def revision.

### 3.3 Sample `SCARD room:members:booking:*` hourly to confirm SADD writes landing

Authority + full procedure: [`operator-ff-flips.md`](./operator-ff-flips.md) §Fix #17 Phase 1 + Phase 2.

```bash
# 3.3.1 — Boot-time sanity check (within 5 min of Phase 2 stable)
redis-cli -h <prod-redis-host> -p 6379 --scan --pattern 'room:members:*' | head -20
# Expected: at least one room:members:* key per active booking room

# 3.3.2 — Verify TTL is set (sets without TTL leak forever — Fix #17's safety belt)
redis-cli -h <prod-redis-host> -p 6379 TTL 'room:members:booking:<active-booking-id>'
# Expected: 86000–86400 (24h TTL)

# 3.3.3 — Hourly SCARD convergence sample (loop this every 60 min during the bake window)
for room_key in $(redis-cli -h <prod-redis-host> -p 6379 --scan --pattern 'room:members:booking:*' | head -10); do
  SCARD=$(redis-cli -h <prod-redis-host> -p 6379 SCARD "$room_key")
  TTL=$(redis-cli -h <prod-redis-host> -p 6379 TTL "$room_key")
  echo "$room_key: members=$SCARD ttl=$TTL"
done
# Pass criteria: SCARD > 0 for active rooms, TTL > 43200 (>= 12h remaining)
# These are the hourly samples that gate §8 (Fix #17 flip).
```

**Block-flip rule (per `operator-ff-flips.md` §Fix #17):** if `populated keys < 50% of active rooms` at any hourly sample → SADD writes are not landing → log the gap and DO NOT FLIP §8 when the 24h timer expires; investigate first.

**Abort criteria:**
- §3.3.1 returns zero keys at 5 min post-deploy → SADD code is not running. Roll back Phase 2 (§3.4); do not proceed to §4.
- TTL returns `-1` (no expiry) → safety-belt regression; roll back Phase 2.

### 3.4 Phase 2 rollback (only if §3.1, §3.2, or §3.3 fails before §4)

```bash
aws ecs update-service \
  --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" \
  --task-definition "${TASK_FAMILY}:${PREV_REVISION_PHASE2}" \
  --force-new-deployment --region "$AWS_REGION"
aws ecs wait services-stable \
  --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" \
  --region "$AWS_REGION"
```

The `room:members:*` sets remain populated after rollback (24h TTL sweeps them). No data loss. Code reverts to local-pod `enumerateRoomUserIds`.

---

## 4. Fix #2 — Worker Ramp (1 → 4 → 8 → 16)

**Total elapsed:** ~3 hours (three 1-hour soaks + three deploys).

> **HAZARD (§4.4):** Never downgrade `REDIS_QUEUE_WORKERS` from a live value ≥ 4 back to 1 — 16× drain collapse, all in-flight jobs pile on a single worker, connection-pool saturation. Rollback is always **one step back** (16 → 8, 8 → 4), never to baseline.

### 4.1 — STEP 0 (mandatory): verify-live-state

Before §4.2: read the **live** `REDIS_QUEUE_WORKERS` value off the deployed task-def. If it is already `"16"`, **skip §4.2/§4.3/§4.4 entirely** and move to a 30-min verification soak per [`worker-ramp-step1.md`](./worker-ramp-step1.md) §HAZARD §4.4 Step 0.

```bash
aws ecs describe-task-definition \
  --task-definition "$TASK_FAMILY" --region "$AWS_REGION" \
  --query 'taskDefinition.containerDefinitions[0].environment[?name==`REDIS_QUEUE_WORKERS`].value' \
  --output text
# Decision gate:
#   "16" → SKIP §4.2/§4.3/§4.4; run 30-min verification soak only.
#   "1" / "4" / "8" / unset → continue with §4.2.
```

### 4.2 — Step 1: 1 → 4

Authority + full procedure: [`worker-ramp-step1.md`](./worker-ramp-step1.md)

The runbook covers:
- §Prerequisites — RDS r6g.xlarge, `DB_CONNECTION_LIMIT=125`, `FF_BATCH_QUEUE_DEPTH_GUARD=true` (note: in this playbook the guard flips in §5, AFTER worker ramp; per the bundle's §1.3 hard-gate sequence the runbook's pre-condition is achievable by a single ramp-after-flip ordering — verify with team-lead if you flip §5 before §4)
- §Pre-flight Check (§4.4 Step 0) — same as §4.1 above
- §Execution — register task-def with `REDIS_QUEUE_WORKERS=4`, deploy, `services-stable`
- §1-Hour Soak Window — three SLO gates (RDS connections < 80%, queue p99 < 200ms, hold_cas_conflict no >2× spike)
- §Rollback — single-step back

> **Bundle-context note:** the bundle's hard-gate ordering (§7C 1.3) places `FF_BATCH_QUEUE_DEPTH_GUARD=true` before the worker ramp. In this playbook §5 (depth-guard flip) follows §4 (worker ramp) because both depend on Phase 2 being stable, and the depth-guard's 30-min soak is shorter than the cumulative 3-hour ramp. If your ops team prefers to align with the §7C order, swap §4 and §5; both orders are safe given the dependency hard-gates listed in each step's pre-conditions.

**Soak duration:** 60 minutes after `services-stable` returns. All three SLO gates must stay green for the full window.

**Pass criteria:** all three SLO gates green for full 60 min → proceed to §4.3.

**Abort criteria:** any gate red → rollback to previous task-def revision per [`worker-ramp-step1.md`](./worker-ramp-step1.md) §Rollback.

### 4.3 — Step 2 (4 → 8) and Step 3 (8 → 16)

Authority + full procedure: [`worker-ramp-step2-3.md`](./worker-ramp-step2-3.md)

The runbook covers:
- §Pre-flight — confirm Step 1 was 60 min green; verify live `REDIS_QUEUE_WORKERS=4`
- §SLO Gates — `pool_wait_seconds` p99 ≤ 50 ms, RDS CPU ≤ 70%, RDS connections ≤ 70% of 3,201 (= 2,240)
- §Step 2 (4 → 8) — register task-def, deploy, 60-min soak
- §Step 3 (8 → 16) — same procedure, 60-min soak
- §Rollback — one step back per failed step (Step 3 fails → 8; Step 2 fails → 4; Step 1 fails → escalate)
- §Final Verification — `SELECT count(*) FROM pg_stat_activity` < 2,240 on RDS at WORKERS=16

### 4.4 — Soak dashboard

Authority: [`worker-ramp-soak-dashboard.md`](./worker-ramp-soak-dashboard.md)

Import the CloudWatch dashboard JSON from that runbook **before** §4.2 starts. The dashboard surfaces RDS connections, queue p99, hold_cas_conflict, and pool wait p99 in a single view; it is the operator's primary monitoring surface during the three 1-hour soaks.

### 4.5 — Pass criteria for §4 as a whole

- `REDIS_QUEUE_WORKERS=16` deployed across all tasks
- All three SLO gates green for ≥ 1 h continuous at WORKERS=16
- `SELECT count(*) FROM pg_stat_activity` ≤ 2,240 on RDS

When green, proceed to §5.

---

## 5. Fix #6 — Flip `FF_BATCH_QUEUE_DEPTH_GUARD=true`

Authority: [`operator-ff-flips.md`](./operator-ff-flips.md) §Fix #6 (canonical) + [`ff-depth-guard-flip.md`](./ff-depth-guard-flip.md) (single-page card; same content)

### 5.1 — Pre-flight gate (§2.1.1, run in order, stop if any fails)

Mandatory pre-conditions before flipping:
- §1.5 Wk0 prerequisites all complete
- DLQ depth sidecar emitting → run [`dlq-sidecar-verify.md`](./dlq-sidecar-verify.md) §1, §2, §3 first (start, datapoints reaching CW, alarm not INSUFFICIENT_DATA)
- All four `weelo-dlq-*` CloudWatch alarms in `OK` state (created via `scripts/monitoring/setup-broadcast-p1-alarms.sh`)
- Drainer pre-flight checks pass → run [`dlq-drainer-preflight.md`](./dlq-drainer-preflight.md) §Check 1 through §Check 5

The 5-block pre-flight sequence (drainer registered, leader-lock held, DLQ depth small, queue total below cap, saturation alarm OK) is fully scripted in [`operator-ff-flips.md`](./operator-ff-flips.md) §Fix #6 §Pre-flight checklist. Do not execute §5.2 until all five blocks pass.

**Block-flip rule (§2.1.1):** if depth alarm fired in last 24h OR `LLEN dlq:broadcasts` ≥ 4500 in any of the previous 5 minutes → DO NOT FLIP. Verify `dlq_drained_total` rate ≥ `dlq_pushed_total` rate.

### 5.2 — Execute the flip

```bash
# Capture rollback revision FIRST
PREV_REVISION_FF6=$(aws ecs describe-task-definition \
  --task-definition "$TASK_FAMILY" --region "$AWS_REGION" \
  --query 'taskDefinition.revision' --output text)
echo "PREV_REVISION_FF6=${PREV_REVISION_FF6}"
```

Then follow [`operator-ff-flips.md`](./operator-ff-flips.md) §Fix #6 §Execution exactly:
- Pull task-def → patch `FF_BATCH_QUEUE_DEPTH_GUARD=true` and confirm `FF_DLQ_DRAINER_ENABLED=true` → register → `update-service` → `wait services-stable`.

### 5.3 — Post-flip soak (30 min — §7C 1.3 hard gate)

Monitor every 5 min. All four signals must stay green for the full 30 min:

| Signal | Pass threshold |
|---|---|
| `dlq_broadcasts_depth` (CloudWatch) | Near 0 at current 10–30 RPS |
| `weelo-dlq-broadcasts-depth-saturation` alarm | OK |
| `pool_wait_seconds` p99 | ≤ 50 ms |
| broadcast latency p99 | ±10% of pre-flip baseline |

Auto-rollback triggers (per [`ff-depth-guard-flip.md`](./ff-depth-guard-flip.md) §Auto-Rollback):
- `hold_create_error_rate` > 2% sustained ≥ 2 min
- broadcast p99 > 2× pre-flip baseline
- `dlq_broadcasts_depth-saturation` fires at any point

### 5.4 — Rollback

Soft rollback (preferred, fastest): set `FF_BATCH_QUEUE_DEPTH_GUARD=false` in the task-def and redeploy via the same Execution procedure. Drainer continues independently (`FF_DLQ_DRAINER_ENABLED=true`); in-flight DLQ entries drain over ~5 min at 30s intervals.

Hard rollback (if soft fails to clear within 10 min):

```bash
aws ecs update-service \
  --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" \
  --task-definition "${TASK_FAMILY}:${PREV_REVISION_FF6}" \
  --force-new-deployment --region "$AWS_REGION"
aws ecs wait services-stable \
  --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" \
  --region "$AWS_REGION"
```

Pass criteria: 30-min soak green on all 4 signals → proceed to §6.

---

## 6. Phase 3 Deploy (commit `d97b5907`)

**What ships:** Fix #23 (skip emit when pickupData missing) + Fix #19c semantic (dlq_pushed_total counter for guard-lookup-error path) + NEW#3 (FCM phantom-key surgery, dual-payload consumer) + Fix #13 (delete 568 LOC dead `acceptBroadcast` method) + Skip-decision audit. **Introduces** the consumer side of `FF_CROSS_POD_ROOM_REPLAY` (the §8 flag).

**Operator critical path:** push image → rolling deploy → smoke-verify changes live. **No flag flips at deploy time.**

### 6.1 ECS push + rolling deploy of `d97b5907`

Procedure mirrors §2.1, with `PREV_REVISION_PHASE3`, `NEW_REVISION_PHASE3`, image SHA = `d97b5907`. Save `PREV_REVISION_PHASE3` for §6.4 rollback.

```bash
PREV_REVISION_PHASE3=$(aws ecs describe-task-definition \
  --task-definition "$TASK_FAMILY" --region "$AWS_REGION" \
  --query 'taskDefinition.revision' --output text)
echo "PREV_REVISION_PHASE3=${PREV_REVISION_PHASE3}"

# Repeat 2.1.2–2.1.5 substituting image digest for d97b5907.
```

### 6.2 — Verify Phase 3 changes live

Smoke-checks; no behavior change should appear yet (the cross-pod replay flag is still off).

```bash
# 6.2.1 — Confirm new revision is the active deployment
aws ecs describe-services \
  --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" \
  --region "$AWS_REGION" \
  --query 'services[0].deployments[*].{Status:status,Td:taskDefinition,Running:runningCount,Desired:desiredCount}'
# Expected: one deployment status=PRIMARY with the d97b5907 task-def, runningCount==desiredCount

# 6.2.2 — Confirm dlq_pushed_total counter exists for guard-lookup path (Fix #19c semantic)
aws cloudwatch list-metrics \
  --namespace "Weelo/Backend" \
  --metric-name "dlq_pushed_total" \
  --region "$AWS_REGION" --output table
# Expected: at least one row. The Fix #19c counter should appear in the metric registry
# once the bound queue label is observed at runtime.

# 6.2.3 — Confirm Fix #23 skip-emit is active (no broadcasts with all-zero pickup distance)
aws logs filter-log-events \
  --log-group-name weelobackendtask \
  --filter-pattern '"pickupDistanceKm: 0" "pickupEtaMinutes: 0"' \
  --start-time "$(($(date +%s) - 600))000" \
  --region "$AWS_REGION" \
  --query 'events[].message' --output text | wc -l
# Expected: 0 over the 10-min window post-deploy.
# A non-zero count indicates Fix #23's skip-guard did not deploy.

# 6.2.4 — Confirm Fix #13 dead code is gone (broadcast.service.ts:388-900 removed)
git -C /Users/nitishbhardwaj/Downloads/weelo-backend show d97b5907:src/modules/broadcast/services/broadcast.service.ts \
  | sed -n '380,420p' | grep -c "acceptBroadcast"
# Expected: 0 (the method's name no longer appears in that line range).

# 6.2.5 — Health check: ECS task health endpoint
# Use whatever your platform exposes (ALB target health, /health endpoint).
aws elbv2 describe-target-health \
  --target-group-arn "<your-target-group-arn>" \
  --region "$AWS_REGION" \
  --query 'TargetHealthDescriptions[*].{Target:Target.Id,State:TargetHealth.State}'
# Expected: all targets State=healthy.
```

### 6.3 — Pass criteria for §6

- Active deployment is `${TASK_FAMILY}:${NEW_REVISION_PHASE3}` (or equivalent ARN); `runningCount == desiredCount`
- §6.2.3 returns 0 (no all-zero pickup-distance broadcasts in last 10 min)
- §6.2.4 returns 0 (Fix #13 dead code is gone in deployed source)
- §6.2.5 reports all targets healthy

When green, proceed to §7.

### 6.4 — Phase 3 rollback (only if §6.1 or §6.2 fails)

```bash
aws ecs update-service \
  --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" \
  --task-definition "${TASK_FAMILY}:${PREV_REVISION_PHASE3}" \
  --force-new-deployment --region "$AWS_REGION"
aws ecs wait services-stable \
  --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" \
  --region "$AWS_REGION"
```

After rollback: investigate via CloudWatch logs; Phase 2 remains live (`FF_CROSS_POD_ROOM_REPLAY` was never on, so reverting Phase 3 has no behavioral cliff).

---

## 7. Fix #16 — Reaper Leader-Lock Verification

**Operator action at deploy time: NONE.** `FF_PROCESSING_REAPER_LEADER_LOCK` defaults to `true` in code (`feature-flags.ts:689`). This section is verification only — confirm leader election is working post-Phase-2 deploy.

Authority + full procedure: [`reaper-leader-verify.md`](./reaper-leader-verify.md)

The runbook covers (Hard Gate 5):
- §Step 1 — Confirm `[ProcessingReaper]` traces appear on at least one pod (leader executing)
- §Step 2 — `processing_reaper_lock_miss_total` Sum > 0 on followers (proves leader election running, not all pods winning)
- §Step 3 — Spot-check Redis lock keys directly (`lock:processing-reaper:{queue}`) on all 3 registered queues: `booking:resume-broadcast`, `hold:finalize-retry`, `hold-expiry`
- §Step 4 — Confirm no broadcast dedup spike (`broadcast_dispatched_total` flat vs pre-deploy baseline)
- §Pass Verdict — declare Hard Gate 5 green after 30-min soak with all four checks green
- §Rollback — Option A (`FF_PROCESSING_REAPER_LEADER_LOCK=false`), Option B (`FF_QUEUE_BLMOVE_DEQUEUE=false`), Option C (full task-def revert)

**Pass criteria:** all four Step checks green for 30-min soak.

**Abort criteria:** broadcast dedup spike (2–6× pre-deploy baseline) → execute Option A or Option B per the runbook §Rollback.

> Run §7 in parallel with §4 (worker ramp) to save wall-clock — both observe Phase 2 code, both have independent abort criteria.

---

## 8. Fix #17 — Flip `FF_CROSS_POD_ROOM_REPLAY=true` (after 24h SADD bake)

> **Hard timing precondition (per `index-20-validated.md` lines 2199, 2725, 2821):** at least **24 hours** must have elapsed since `PHASE2_STABLE_TS` recorded in §3.2. **Recommended: 48 hours** (2× the 24h `room:members:*` TTL) for a missed-refresh slack window. Flipping before the bake = ~95% broadcast loss (§4.2 hazard).

Authority + full procedure: [`operator-ff-flips.md`](./operator-ff-flips.md) §Fix #17 (Phases 1, 2, 3 + Rollback)

### 8.1 — 24h SADD bake gate (mandatory)

```bash
# 8.1.1 — Compute elapsed time since Phase 2 stable
NOW_TS=$(date -u +%s)
PHASE2_TS=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "${PHASE2_STABLE_TS}" +%s 2>/dev/null \
  || date -u --date="${PHASE2_STABLE_TS}" +%s)
ELAPSED_HOURS=$(( (NOW_TS - PHASE2_TS) / 3600 ))
echo "Elapsed since Phase 2 stable: ${ELAPSED_HOURS}h"
# Block-flip rule: ELAPSED_HOURS < 24 → DO NOT FLIP.

# 8.1.2 — Sample 10 active room:members:booking:* keys; SCARD must match
# pod-local adapter.rooms (within ±2). Authority: operator-ff-flips.md §Fix #17 Phase 2.
for room_key in $(redis-cli -h <prod-redis-host> -p 6379 --scan --pattern 'room:members:booking:*' | head -10); do
  SCARD=$(redis-cli -h <prod-redis-host> -p 6379 SCARD "$room_key")
  TTL=$(redis-cli -h <prod-redis-host> -p 6379 TTL "$room_key")
  echo "$room_key: members=$SCARD ttl=$TTL"
done

# 8.1.3 — Populated-key ratio check
TOTAL_KEYS=$(redis-cli -h <prod-redis-host> -p 6379 --scan --pattern 'room:members:*' | wc -l)
echo "Total room:members:* keys = $TOTAL_KEYS"
# Block-flip rule: populated < 50% of expected active rooms → DO NOT FLIP.
```

**Pass criteria:** ELAPSED_HOURS ≥ 24, sampled SCARD convergence within ±2 vs adapter, populated keys ≥ 50% of expected active rooms.

**Abort criteria:** any of the three fails → re-bake; rerun §3.3 hourly samples; do not flip until next 24h target. If populated keys < 50% persists, investigate `trackRoomMembership()` call sites (`socket.service.ts:105-113`, 19 callers).

### 8.2 — Canary flip (1 ECS task, 1h soak)

Procedure: [`operator-ff-flips.md`](./operator-ff-flips.md) §Fix #17 Phase 3

```bash
# Capture rollback revision FIRST
PREV_REVISION_FF17=$(aws ecs describe-task-definition \
  --task-definition "$TASK_FAMILY" --region "$AWS_REGION" \
  --query 'taskDefinition.revision' --output text)
echo "PREV_REVISION_FF17=${PREV_REVISION_FF17}"
```

Then follow the runbook §Phase 3:
- Pull task-def → patch `FF_CROSS_POD_ROOM_REPLAY=true` → register canary task-def → deploy on 1 task only.
- Watch 1 h: `socket_emit_while_adapter_down_total` near zero, broadcast P50/P99 no regression, captain reconnect-replay metrics show replay events on disconnect.

### 8.3 — Full rollout (after canary 1h green)

Update full service to canary task-def revision; `services-stable`; continue monitoring 1 h.

```bash
aws ecs update-service \
  --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" \
  --task-definition "${TASK_FAMILY}:<canary_revision>" \
  --region "$AWS_REGION"
aws ecs wait services-stable \
  --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" \
  --region "$AWS_REGION"
```

### 8.4 — Pass criteria for §8

- ≥ 24h since `PHASE2_STABLE_TS` (48h conservative)
- 50%+ of `room:members:*` keys populated; ±2 SCARD convergence on sampled rooms
- Canary 1 h green: no broadcast P99 regression, no `socket_emit_while_adapter_down_total` spike
- Full-rollout 1 h green: broadcast delivery rate ±5% of pre-flip baseline

### 8.5 — Rollback

Soft rollback: set `FF_CROSS_POD_ROOM_REPLAY=false` and redeploy. Code reverts to local-pod `enumerateRoomUserIds`; `room:members:*` sets remain populated (24h TTL sweeps over time). No data loss.

Hard rollback:

```bash
aws ecs update-service \
  --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" \
  --task-definition "${TASK_FAMILY}:${PREV_REVISION_FF17}" \
  --force-new-deployment --region "$AWS_REGION"
```

Re-flip clock: bake another ≥ 24h, sample wider room set, re-canary.

---

## 9. SHIP-COMPLETE Gate (10 criteria)

Authority: [`SHIP_READY_CHECKLIST.md`](./SHIP_READY_CHECKLIST.md) §Final SHIP-READY Gate Criteria

The bundle is **SHIP-READY** when all the following are simultaneously true. Re-verify each before declaring complete; any single red criterion blocks the ship.

| # | Gate | Verification command |
|---|---|---|
| 1 | Phase 1, 2, 3 commits all deployed | `aws ecs describe-task-definition` image SHA matches `d97b5907`; `aws ecs describe-services` shows deployment `status=PRIMARY`, `runningCount == desiredCount`. |
| 2 | All Wk-0 prerequisites complete | RDS `db.r6g.xlarge` available (§1.5.1); `DB_CONNECTION_LIMIT=125` in env (§1.5.2); HPA Min=2/Max=5 registered (§1.5.3). |
| 3 | M-007 SQL applied | psql `\d "OrderDispatchOutbox"` shows `claimToken bigint`; sequence `outbox_fence_seq` exists; partial index `idx_odoutbox_unprocessed_fence` is `is_valid=true` (§2.2). |
| 4 | `FF_OUTBOX_LEADER_FENCING=true` flipped | (Out of scope of this playbook — see [`SHIP_READY_CHECKLIST.md`](./SHIP_READY_CHECKLIST.md) Phase 1 P1-5 + [`m-007-outbox-leader-fencing-sql.md`](./m-007-outbox-leader-fencing-sql.md) §Sequence step 5.) Task-def env shows the value; `outbox_leader_election_redis_error_total` flat for ≥ 60 min. |
| 5 | `FF_BATCH_QUEUE_DEPTH_GUARD=true` flipped | Task-def env shows the value (§5.2); DLQ `-saturation` alarm OK for ≥ 60 min; `dlq_broadcasts_depth` near 0 at current load. |
| 6 | Fix #16 reaper leader-lock active | `processing_reaper_lock_miss_total` non-zero on followers (§7); broadcast dedup metrics flat. |
| 7 | `FF_CROSS_POD_ROOM_REPLAY=true` flipped post-bake | Phase 2 → Phase 3 flip clock ≥ 24h (§8.1.1); canary 1 h green (§8.2); full-rollout 1 h green (§8.3). |
| 8 | (Optional) Worker ramp at `REDIS_QUEUE_WORKERS=16` | All three SLO gates green for ≥ 1 h continuous (§4.5); RDS connections ≤ 2,240 (70% of 3,201). |
| 9 | All `weelo-` CloudWatch alarms in `OK` | `aws cloudwatch describe-alarms --alarm-name-prefix weelo- --state-value ALARM --region "$AWS_REGION" --query 'MetricAlarms[*].AlarmName'` returns `[]` for ≥ 60 min. |
| 10 | No P1/P2 incidents open | Operations log clean; no rollback levers pulled in last 60 min. |

When all 10 are green simultaneously, log the timestamp + Phase 3 commit SHA (`d97b5907`) + active ECS task-def revision in the deployment journal. The bundle is **SHIP-COMPLETE**.

```bash
# Final attestation block — paste into deploy log
echo "SHIP-COMPLETE attestation"
echo "  timestamp_utc:       $(date -u +%FT%TZ)"
echo "  head_sha:            $(git -C /Users/nitishbhardwaj/Downloads/weelo-backend rev-parse HEAD)"
echo "  ecs_task_definition: $(aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" --region "$AWS_REGION" --query 'services[0].taskDefinition' --output text)"
echo "  alarms_in_alarm:     $(aws cloudwatch describe-alarms --alarm-name-prefix weelo- --state-value ALARM --region "$AWS_REGION" --query 'length(MetricAlarms)' --output text)"
```

Pass criteria: `head_sha == d97b59079f62e87f6662ba2d367a548c7f3ff2d1`, `alarms_in_alarm == 0`, all 10 criteria above attested green in the journal.

---

## Appendix A — Cross-References to Detail Runbooks

| Runbook | Used in playbook section |
|---|---|
| [`SHIP_READY_CHECKLIST.md`](./SHIP_READY_CHECKLIST.md) | §9 (final gate authority) |
| [`rds-upgrade.md`](./rds-upgrade.md) | §1.5.1 (Wk-0 prereq) |
| [`ecs-db-connection-limit.md`](./ecs-db-connection-limit.md) | §1.5.2 (Wk-0 prereq) |
| [`hpa-cap.md`](./hpa-cap.md) | §1.5.3 (Wk-0 prereq) |
| [`m-007-outbox-leader-fencing-sql.md`](./m-007-outbox-leader-fencing-sql.md) | §2.2 (M-007 SQL) |
| [`dlq-sidecar-verify.md`](./dlq-sidecar-verify.md) | §5.1 (Fix #6 pre-flight) |
| [`cloudwatch-dlq-alarms.md`](./cloudwatch-dlq-alarms.md) | §5.1 (Fix #6 pre-flight; supplementary alarms — see SHIP_READY_CHECKLIST §GAP NOTES before using) |
| [`dlq-drainer-preflight.md`](./dlq-drainer-preflight.md) | §5.1 (Fix #6 pre-flight) |
| [`ff-depth-guard-flip.md`](./ff-depth-guard-flip.md) | §5 (Fix #6 single-page card; mirrors operator-ff-flips.md §Fix #6) |
| [`operator-ff-flips.md`](./operator-ff-flips.md) | §3.3 (Fix #17 Phase 1+2), §5 (Fix #6 canonical), §8 (Fix #17 Phase 3) |
| [`reaper-leader-verify.md`](./reaper-leader-verify.md) | §7 (Fix #16 verify) |
| [`worker-ramp-step1.md`](./worker-ramp-step1.md) | §4.2 (Step 1 ramp) |
| [`worker-ramp-step2-3.md`](./worker-ramp-step2-3.md) | §4.3 (Steps 2+3 ramp) |
| [`worker-ramp-soak-dashboard.md`](./worker-ramp-soak-dashboard.md) | §4.4 (CloudWatch dashboard) |
| [`SKIP_DECISIONS.md`](./SKIP_DECISIONS.md) | (Reference only — Fix #4, #25, #8 permanent drops; not part of any §) |
| [`PHASE3_FRONTEND_IMPACT.md`](./PHASE3_FRONTEND_IMPACT.md) | (Reference only — frontend coordination notes for Phase 3) |

---

## Appendix B — Hazard Reminders (highest-blast-radius pitfalls)

| Hazard | Section guarding it | Reference |
|---|---|---|
| Flipping `FF_OUTBOX_LEADER_FENCING=true` before M-007 SQL → 500s on column read | §2.2 sequence rule | [`m-007-outbox-leader-fencing-sql.md`](./m-007-outbox-leader-fencing-sql.md) §Sequence Requirement |
| Flipping `FF_CROSS_POD_ROOM_REPLAY=true` before 24h SADD bake → ~95% broadcast loss | §8.1 24h gate | [`operator-ff-flips.md`](./operator-ff-flips.md) §Fix #17 §Wrong order |
| Downgrading `REDIS_QUEUE_WORKERS` from 16 → 1 → 16× drain collapse, all in-flight jobs pile on a single worker | §4.1 Step 0; §4.5 one-step rollback rule | [`worker-ramp-step1.md`](./worker-ramp-step1.md) §HAZARD; [`worker-ramp-step2-3.md`](./worker-ramp-step2-3.md) §HAZARD §4.4 |
| Running `prisma migrate deploy` or `prisma db push` on production → schema corruption (no `_prisma_migrations` table) | §2.2 (M-007 via direct psql only) | `CLAUDE.md` "CRITICAL RULES FOR THIS DB"; [`m-007-outbox-leader-fencing-sql.md`](./m-007-outbox-leader-fencing-sql.md) §Hard Rules |
| Flipping `FF_BATCH_QUEUE_DEPTH_GUARD=true` while `LLEN dlq:broadcasts ≥ 4500` → drainer cannot keep up; DLQ saturates → `lTrim` drops oldest → silent data loss | §5.1 block-flip rule | [`operator-ff-flips.md`](./operator-ff-flips.md) §Fix #6 §Block-flip rule; [`dlq-drainer-preflight.md`](./dlq-drainer-preflight.md) §Check 3 |
| Flipping any flag against a task-def whose image SHA does not match `git rev-parse HEAD` → unknown code is live | §1.1 + every §x.1 PREV_REVISION capture step | `SHIP_READY_CHECKLIST.md` "Hard rule before flipping ANY flag" |

---

## Appendix C — Decision Tree (Tree A–F → which playbook section)

When triaging an incident, the rollback tree in `SHIP_READY_CHECKLIST.md` §Rollback Decision Tree is the canonical reference. Mapping back to this playbook:

| Tree | Trigger | Playbook section |
|---|---|---|
| A | `FF_BATCH_QUEUE_DEPTH_GUARD` flip went bad | §5.4 |
| B | `FF_PROCESSING_REAPER_LEADER_LOCK` causing duplicate broadcasts | §7 (rollback options A/B/C) |
| C | `FF_OUTBOX_LEADER_FENCING` causing leadership flapping | (out of scope — see [`SHIP_READY_CHECKLIST.md`](./SHIP_READY_CHECKLIST.md) Tree C) |
| D | `FF_CROSS_POD_ROOM_REPLAY` causing missed broadcasts | §8.5 |
| E | Worker ramp gate breach | §4.2/§4.3 (one-step-back rollback) |
| F | Catastrophic incident — full task-def revert | §2.4, §3.4, §6.4 (one-phase-back) or `SHIP_READY_CHECKLIST.md` Tree F (multi-phase) |

Use the lowest-blast-radius rollback that resolves the symptom. Escalate only if the lower-impact rollback fails to clear the alarm within 10 min.
