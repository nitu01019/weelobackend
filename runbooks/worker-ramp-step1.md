# Worker Ramp Step 1: REDIS_QUEUE_WORKERS 1 → 4

**Source authority:** §7C Fix #2 (ramp ladder) + §4.4 (hazard — wrong order = outage)

---

## Why

`REDIS_QUEUE_WORKERS` controls how many concurrent Bull queue workers each ECS pod runs.
The ramp ladder (1 → 4 → 8 → 16) is necessary because jumping 1 → 16 in a single deploy
exhausts the Prisma connection pool (`ConnectionPoolTimeoutError` on every queue) when
`connection_limit` is still at its default of 10. This document covers **Step 1 only: 1 → 4**.

Each stage bakes for 1 hour under three SLO gates before the next step is permitted.

---

## Prerequisites

All five must be verified before executing this runbook:

| # | Prerequisite | How to verify |
|---|---|---|
| 1 | RDS sizing decision documented (§1.2 Step 4 lines 337-345) — Option A db.r6g.xlarge (HPA Max=5, 54.5% util) or Option B db.r6g.large + HPA Max=4 (87% util). Option C (per-pod budget < 125) only with explicit load-test sign-off. | Decision recorded in deployment log; cross-check `rds-upgrade.md` and `hpa-cap.md` for matching class+cap. |
| 2 | RDS upgrade to chosen class complete | `aws rds describe-db-instances --db-instance-identifier $RDS_INSTANCE_ID --query 'DBInstances[0].DBInstanceClass'` → must return `"db.r6g.xlarge"` (Option A) or `"db.r6g.large"` (Option B) per the §1.2 Step 4 sizing decision recorded above. |
| 3 | `DB_CONNECTION_LIMIT=125` on running task-def | `aws ecs describe-task-definition --task-definition weelobackendtask --region $AWS_REGION --query 'taskDefinition.containerDefinitions[0].environment[?name==\`DB_CONNECTION_LIMIT\`].value' --output text` → must return `"125"` |
| 4 | `prisma.service.ts:295-305` URL guard patch shipped (§1.2 Step 3) — extends the existing `hasConnectTimeout`/`hasSocketTimeout` guard to all four params (`connection_limit`, `pool_timeout`, `connect_timeout`, `socket_timeout`) so DATABASE_URL pre-set values aren't double-appended. **At HEAD `d97b5907` only `connect_timeout`/`socket_timeout` are guarded; `connection_limit`/`pool_timeout` are still appended unconditionally — patch must ship before Step 1.** | `git show HEAD:src/shared/database/prisma.service.ts \| sed -n '295,310p'` must show all four params via the guarded `params = [...includes('connection_limit=') ? [] : ...]` ladder, not the current 2-of-4 guard. |
| 5 | `FF_BATCH_QUEUE_DEPTH_GUARD=true` on running task-def | Same describe-task-definition query for `FF_BATCH_QUEUE_DEPTH_GUARD` → must return `"true"` |

Do not proceed if any prerequisite is unmet. Resolve blockers via their respective runbooks
(`rds-upgrade.md`, `ecs-db-connection-limit.md`, `hpa-cap.md`).

---

## Pre-flight Check — MANDATORY (§4.4 Step 0)

Read the **live** value of `REDIS_QUEUE_WORKERS` from the currently active task definition:

```bash
aws ecs describe-task-definition \
  --task-definition weelobackendtask \
  --region "$AWS_REGION" \
  --query 'taskDefinition.containerDefinitions[0].environment[?name==`REDIS_QUEUE_WORKERS`].value' \
  --output text
```

### Decision gate

| Result | Action |
|---|---|
| Output = `"16"` | **SKIP THIS ENTIRE RUNBOOK + SKIP STEPS 2-3 in `worker-ramp-step2-3.md` (per §4.4 line 2227).** Run the 30-min verification soak described in §4.4 Step 0 instead — watch `pool_wait_seconds` p99 ≤ 50ms and RDS CPU ≤ 70%. If clean, declare stable. If p99 spikes, deploy load-shedding before scaling RPS further. NEVER downgrade live=16 → 1 to "restart" the ramp (see HAZARD below). |
| Output < `"16"` (e.g. `"1"`, `"4"`, `"8"`) | Continue to Execution below — start the ramp from the live value, not from `1`. |

---

## !! HAZARD — NEVER DOWNGRADE 16 → 1 !! (§4.4)

**If the live value is already `16`, do NOT deploy `REDIS_QUEUE_WORKERS=1` or any lower value
to "restart" the ramp.** Downgrading from 16 to 1 on a live cluster causes a 16× queue drain
collapse — all in-flight jobs stall, hold timeouts cascade, and order assignment fails cluster-wide.

This is a **one-way ramp**. If you need to rollback under an active incident, follow incident
command procedures; do not treat a lower value as a safe default.

---

## Execution

### 1. Register a new task-definition revision with `REDIS_QUEUE_WORKERS=4`

Retrieve the current task-definition JSON, patch the environment variable, and register:

```bash
# Export current task-def (strip read-only fields)
aws ecs describe-task-definition \
  --task-definition weelobackendtask \
  --region "$AWS_REGION" \
  --query 'taskDefinition' \
  --output json \
  | jq 'del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
             .compatibilities, .registeredAt, .registeredBy)
        | (.containerDefinitions[0].environment[] |
           select(.name == "REDIS_QUEUE_WORKERS")).value = "4"' \
  > /tmp/task-def-workers4.json

# Register new revision
NEW_TD_ARN=$(aws ecs register-task-definition \
  --region "$AWS_REGION" \
  --cli-input-json file:///tmp/task-def-workers4.json \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)

echo "New task-def ARN: $NEW_TD_ARN"
```

### 2. Deploy with force-new-deployment

```bash
aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --task-definition "$NEW_TD_ARN" \
  --force-new-deployment \
  --region "$AWS_REGION"
```

### 3. Confirm deployment is stable

Wait for the service to reach a steady state (all old tasks replaced):

```bash
aws ecs wait services-stable \
  --cluster "$ECS_CLUSTER" \
  --services "$ECS_SERVICE" \
  --region "$AWS_REGION"
echo "Service stable."
```

---

## 1-Hour Soak Window

Start the soak clock **after `services-stable` returns**. All three SLO gates must remain green
for the full 60 minutes before advancing to Step 2.

### SLO Gate A — RDS DatabaseConnections ≤ 70% capacity (§1.2 Step 5)

Threshold depends on the §1.2 Step 4 sizing option:

| Option | RDS class | max_connections | 70% gate | Rationale |
|---|---|---|---|---|
| A (recommended) | db.r6g.xlarge | ≈3,201 | **≤ 2,240** | HPA Max=5: 1745/3201 = 54.5% steady, 70% leaves 15% headroom over peak |
| B (fallback) | db.r6g.large + HPA Max=4 | ≈1,600 | **≤ 1,120** | 4 × 349 = 1396 = 87% peak; 70% gate tighter — lower CPU only |

The expected per-pod connection footprint = 125 Prisma + 224 BRPOP holders = **349 conn/pod** (per §1.2 Step 4: 16 broadcast workers × 11 default queues + 48 tracking workers × 1 tracking queue = 224 BRPOP holders).

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS \
  --metric-name DatabaseConnections \
  --dimensions Name=DBInstanceIdentifier,Value="$RDS_INSTANCE_ID" \
  --statistics Maximum \
  --period 60 \
  --start-time "$(date -u -v-30M +%FT%TZ 2>/dev/null || date -u -d '30 minutes ago' +%FT%TZ)" \
  --end-time "$(date -u +%FT%TZ)" \
  --region "$AWS_REGION"
```

### SLO Gate B — `pool_wait_seconds` p99 ≤ 50 ms (§4.4 line 2221, 2227)

This is the **primary** ramp gate per spec §1.2 Step 5 + §4.4 Step 0/Step 2. Pool wait is the
canonical Prisma pool-saturation signal — it spikes long before throughput-side metrics like
`queue_process_time` move. Monitor via CloudWatch custom metrics emitted from
`metrics-definitions.ts:1210` (registration at HEAD `d97b5907`; spec §1.2 cited `:1153` against
the older HEAD `8f400201`).

If p99 exceeds **50 ms** for two consecutive 5-minute windows, treat as gate failure and roll back.

```bash
aws cloudwatch get-metric-statistics \
  --namespace Weelo/Backend \
  --metric-name pool_wait_seconds \
  --extended-statistics p99 \
  --period 300 \
  --start-time "$(date -u -v-30M +%FT%TZ 2>/dev/null || date -u -d '30 minutes ago' +%FT%TZ)" \
  --end-time "$(date -u +%FT%TZ)" \
  --region "$AWS_REGION"
```

> **Why this metric (not `queue_process_time_p99`):** §4.4 line 2221 mandates `pool_wait_seconds` p99 ≤ 50ms. Earlier audit drafts used `queue_process_time_p99 < 200 ms`, but the pool-wait metric fires before queue throughput degrades — it is the leading indicator of Prisma pool saturation that the ramp ladder is specifically designed to avoid.

### SLO Gate C — hold_cas_conflict_total stable (no >2x spike vs pre-ramp baseline)

Record the pre-ramp value of `hold_cas_conflict_total` before deployment, then compare
at T+30m and T+60m. A >2x spike indicates lock contention pressure from the additional workers.

```bash
# Pre-ramp: capture baseline counter value from your metrics endpoint or CloudWatch
# During soak: compare current value; delta > 2x baseline delta = gate failure
aws cloudwatch get-metric-statistics \
  --namespace Weelo/Backend \
  --metric-name hold_cas_conflict_total \
  --statistics Sum \
  --period 300 \
  --start-time "$(date -u -v-60M +%FT%TZ 2>/dev/null || date -u -d '60 minutes ago' +%FT%TZ)" \
  --end-time "$(date -u +%FT%TZ)" \
  --region "$AWS_REGION"
```

---

## Gate Outcomes

| All 3 gates green for full 60 min | Action |
|---|---|
| Yes | Proceed to Step 2 (`worker-ramp-step2.md`): ramp to `REDIS_QUEUE_WORKERS=8` |
| Any gate red | **STOP. Do not advance.** Rollback env to previous task-def revision: |

### Rollback (if any gate fails)

```bash
# Find previous task-def revision (the one before NEW_TD_ARN)
PREV_REVISION=$(( $(echo "$NEW_TD_ARN" | grep -o '[0-9]*$') - 1 ))
PREV_TD_ARN="${NEW_TD_ARN%:*}:${PREV_REVISION}"

aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --task-definition "$PREV_TD_ARN" \
  --force-new-deployment \
  --region "$AWS_REGION"
```

Investigate the breaching metric before re-attempting the ramp.

---

## Environment Variables Required

```bash
export AWS_REGION="ap-south-1"
export ECS_CLUSTER="<your-cluster-name>"
export ECS_SERVICE="<your-service-name>"
export RDS_INSTANCE_ID="<your-rds-instance-id>"
```

These values can be found in the ECS console or the task-def environment block.

---

## Companion Runbooks

- **Prerequisite:** `rds-upgrade.md` — RDS instance must be upgraded before starting this runbook
- **Prerequisite:** `ecs-db-connection-limit.md` — DB_CONNECTION_LIMIT=125 must be set in ECS task-def
- **Prerequisite:** `hpa-cap.md` — HPA MaxReplicas must match the §1.2 Step 4 sizing option
- **Monitor during soak:** `worker-ramp-soak-dashboard.md` — import CloudWatch dashboard before starting the soak
- **Next:** `worker-ramp-step2-3.md` — proceed to Steps 2 and 3 (4→8→16) after this soak passes all three gates
