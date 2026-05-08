# Worker Ramp Steps 2 & 3: 4 → 8 → 16

**Depends on:** Marlow's Step 1 (1 → 4) 1-hour soak passing all three SLO gates.
**Source authority:** §7C Fix #2 + §4.4 (index-20-validated.md).
**Prerequisite:** `rds-upgrade.md` must be complete (RDS instance must be db.r6g.xlarge with max_connections=3201).

## Shell Variables (set these before executing any step)

```bash
export AWS_REGION="ap-south-1"
export ECS_CLUSTER="<your-cluster-name>"
export ECS_SERVICE="<your-service-name>"
export RDS_INSTANCE_ID="<your-rds-instance-id>"

# STEP1_TD_ARN: the task definition ARN that completed the Step 1 soak (WORKERS=4)
# Fetch from the currently running service after Step 1 completes:
STEP1_TD_ARN=$(aws ecs describe-services \
  --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" \
  --region "$AWS_REGION" \
  --query 'services[0].taskDefinition' --output text)
echo "Step 1 baseline ARN: $STEP1_TD_ARN"

# NEW_TD_ARN_8 is set immediately after registering the Step 2 task definition:
# (run this after the register-task-definition command in Step 2.1)
NEW_TD_ARN_8=$(aws ecs describe-task-definition \
  --task-definition weelobackendtask \
  --region "$AWS_REGION" \
  --query 'taskDefinition.taskDefinitionArn' --output text)
echo "Step 2 task def ARN: $NEW_TD_ARN_8"

# STEP2_TD_ARN is set the same way after Step 3's register command:
# NEW_TD_ARN_16 / STEP2_TD_ARN follow the same pattern for Step 3
```

---

## Pre-flight (run before either step)

Confirm the task-definition already carries `REDIS_QUEUE_WORKERS=4` after Step 1, and that Step 1's soak was green on all three gates below. Do not proceed if any gate was amber or red during the Step 1 soak.

Verify live worker count:

```bash
aws ecs describe-task-definition \
  --task-definition "$NEW_TD_ARN" \
  --region "$AWS_REGION" \
  --query 'taskDefinition.containerDefinitions[0].environment[?name==`REDIS_QUEUE_WORKERS`].value' \
  --output text
# Expected: "4"
```

Verify Prisma connection limit on a running pod:

```bash
# On a running container (ECS exec or equivalent)
echo $DB_CONNECTION_LIMIT
# Expected: 125
```

---

## SLO Gates (identical for both steps)

All three must hold for the **full 1-hour soak** before advancing. Per §1.2 Step 5 + §4.4 Step 2,
`pool_wait_seconds` p99 ≤ 50 ms is the **primary** gate — it is the leading indicator of Prisma
pool saturation that the ramp ladder is specifically designed to avoid.

| Gate | Threshold | Source |
|------|-----------|--------|
| `pool_wait_seconds` p99 | ≤ **50 ms** (primary) | §4.4 line 2221, 2227 |
| RDS `CPUUtilization` | ≤ 70% | §1.2 Step 5 line 347 |
| RDS `DatabaseConnections` | ≤ 70% of `max_connections` — depends on §1.2 Step 4 sizing option | §1.2 Step 4 lines 337-345 |

**RDS DatabaseConnections threshold by option:**

| §1.2 Step 4 option | RDS class | max_connections | 70% gate | Peak utilisation |
|---|---|---|---|---|
| A (recommended) | db.r6g.xlarge | ≈3,201 | **≤ 2,240** | HPA Max=5: 1745/3201 = 54.5% |
| B (fallback) | db.r6g.large + HPA Max=4 | ≈1,600 | **≤ 1,120** | 4 × 349 = 1396 = 87% |

Per §1.2 Step 4: per-pod conn = 125 Prisma + 224 BRPOP holders = **349 conn/pod** (16 broadcast workers × 11 default queues + 48 tracking workers × 1 tracking queue). HPA Max=5 on db.r6g.large = 1745/1600 = **109% — OVER CAP, not viable**; cap MaxReplicas at 4 (Option B) or upgrade to r6g.xlarge (Option A) before stepping past WORKERS=8.

Monitoring commands (repeat throughout each soak window):

```bash
# RDS CPU
aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS --metric-name CPUUtilization \
  --dimensions Name=DBInstanceIdentifier,Value="$RDS_INSTANCE_ID" \
  --statistics Average --period 60 \
  --start-time "$(date -u -v-30M +%FT%TZ 2>/dev/null || date -u -d '30 minutes ago' +%FT%TZ)" \
  --end-time "$(date -u +%FT%TZ)" \
  --region "$AWS_REGION"

# RDS Connections
aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS --metric-name DatabaseConnections \
  --dimensions Name=DBInstanceIdentifier,Value="$RDS_INSTANCE_ID" \
  --statistics Maximum --period 60 \
  --start-time "$(date -u -v-30M +%FT%TZ 2>/dev/null || date -u -d '30 minutes ago' +%FT%TZ)" \
  --end-time "$(date -u +%FT%TZ)" \
  --region "$AWS_REGION"
```

If any gate breaks mid-soak: **STOP immediately. Do not advance. Execute the rollback for this step** (see Rollback section).

---

## Step 2 — Ramp 4 → 8

**Gate to enter:** Step 1 soak (WORKERS=4) was green for a full 60 minutes.

### 2.1 Deploy new task-definition revision

Update the ECS task-definition environment to `REDIS_QUEUE_WORKERS=8`. Use the same task-def-revision procedure applied in Step 1 (register new revision → update service → wait for deployment to stabilise).

```bash
# After updating the task-def JSON locally:
aws ecs register-task-definition \
  --cli-input-json file://task-def-workers-8.json \
  --region "$AWS_REGION"

aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --task-definition "$NEW_TD_ARN_8" \
  --region "$AWS_REGION"

# Wait for deployment to complete
aws ecs wait services-stable \
  --cluster "$ECS_CLUSTER" \
  --services "$ECS_SERVICE" \
  --region "$AWS_REGION"
```

### 2.2 Soak — 60 minutes

Start a 60-minute timer. Sample all three SLO gates every ~5 minutes. All three must be green for the entire window before proceeding to Step 3.

### 2.3 Pass criteria

WORKERS=8 soak green for 60 continuous minutes → proceed to Step 3.

### 2.4 Rollback (Step 2 failure)

Roll back to WORKERS=4 (the previous stable step). Do **not** roll back to 1.

```bash
aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --task-definition "$STEP1_TD_ARN" \
  --region "$AWS_REGION"
```

Investigate gate breach before retrying.

---

## Step 3 — Ramp 8 → 16

**Gate to enter:** Step 2 soak (WORKERS=8) was green for a full 60 minutes.

### 3.1 Deploy new task-definition revision

Same procedure as Step 2, with `REDIS_QUEUE_WORKERS=16`.

```bash
aws ecs register-task-definition \
  --cli-input-json file://task-def-workers-16.json \
  --region "$AWS_REGION"

aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --task-definition "$NEW_TD_ARN_16" \
  --region "$AWS_REGION"

aws ecs wait services-stable \
  --cluster "$ECS_CLUSTER" \
  --services "$ECS_SERVICE" \
  --region "$AWS_REGION"
```

### 3.2 Soak — 60 minutes

Same monitoring procedure as Step 2. All three SLO gates must be green for 60 continuous minutes.

### 3.3 Pass criteria

WORKERS=16 soak green for 60 continuous minutes → proceed to Final Verification.

### 3.4 Rollback (Step 3 failure)

Roll back to WORKERS=8 (the previous stable step). Do **not** roll back to 4 or 1.

```bash
aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --task-definition "$STEP2_TD_ARN" \
  --region "$AWS_REGION"
```

---

## Final Verification — at WORKERS=16

After Step 3 soak passes, run the connection-count sanity check directly on RDS:

```bash
# On the RDS instance (via psql or bastion)
SELECT count(*) FROM pg_stat_activity;

# Must be below 2,240 (70% of 3,201 max_connections on r6g.xlarge)
```

Confirm via CloudWatch that `DatabaseConnections` maximum over the soak window is below 2,240. If it is, the ramp is complete and WORKERS=16 is declared stable.

---

## Aggregate Timeline

| Clock offset | Action |
|---|---|
| T+0 h | Marlow's Step 1 (1 → 4) deploy begins (handled by Marlow) |
| T+0 h | Step 1 soak begins |
| T+1 h | Step 1 soak window closes — gate check |
| T+1 h | Step 2 (4 → 8) deploy |
| T+1 h | Step 2 soak begins |
| T+2 h | Step 2 soak window closes — gate check |
| T+2 h | Step 3 (8 → 16) deploy |
| T+2 h | Step 3 soak begins |
| T+3 h | Step 3 soak window closes — gate check + final verification |
| **T+3 h** | **WORKERS=16 declared stable** |

Total elapsed time from first deploy to 16 workers: **~3 hours** (dominated by three 1-hour soaks).

---

## HAZARD — §4.4 Step 0

> **Never downgrade 16 → 1 mid-soak or as a "reset" before ramping.**
> Dropping from a live high-worker count to 1 causes a 16× queue-drain collapse — all in-flight jobs pile onto a single worker and connection-pool saturation spikes immediately. This is the failure mode §4.4 was written to prevent.

Rollback direction is always **one step back**, never to baseline:

- Step 3 fails → roll back to 8 (not 4, not 1)
- Step 2 fails → roll back to 4 (not 1)
- Step 1 (Marlow) fails → roll back to current live value, escalate to incident command before any further action

Downgrading to 1 from any live state ≥ 4 requires explicit incident-command authorisation.

---

## Companion Runbooks

- **Prerequisite:** `rds-upgrade.md` — RDS instance must be upgraded to db.r6g.xlarge before starting this runbook
- **Prerequisite:** `worker-ramp-step1.md` — Step 1 (1→4) soak must be complete and green
- **Monitor during soak:** `worker-ramp-soak-dashboard.md` — import CloudWatch dashboard before starting soaks
- **After final verification:** `ecs-db-connection-limit.md` — confirm DB_CONNECTION_LIMIT=125 is still set post-ramp
