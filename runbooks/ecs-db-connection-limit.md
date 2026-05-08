# Runbook: Set DB_CONNECTION_LIMIT=125 in ECS Task Definition

**Status:** Wk0 Blocker (Gate 0.4)
**Priority:** Must complete BEFORE Phase 2 Fix #2 worker ramp
**Est. execution time:** ~5 minutes + deployment stabilization (~3 min)

---

## Why

`DB_CONNECTION_LIMIT` is **not set** in the currently deployed ECS task definition environment. When absent, `prisma.service.ts:283` falls back to a hardcode default of **25 connections per pod**.

The capacity math per §1.2 Step 4 (lines 337–345) — recomputed in Round 6 with the corrected 224 BRPOP holders (16 broadcast workers × 11 default queues + 48 tracking workers × 1 tracking queue per `queue.service.ts:1405-1418`). **Per-pod conn = 125 Prisma + 224 BRPOP = 349 conn/pod**. The Prisma in-flight math alone underestimates total RDS load.

```
Per-pod = 125 Prisma (DB_CONNECTION_LIMIT) + 224 BRPOP holders = 349 conn/pod

Option A (recommended)  — db.r6g.xlarge (max_connections ≈ 3,201):
  HPA Max=5: 5 × 349 = 1,745 / 3,201 = 54.5% utilisation (45% headroom).
  70% SLO gate = 2,240 connections.

Option B (fallback)     — db.r6g.large + HPA Max=4 (max_connections ≈ 1,600):
  4 × 349 = 1,396 / 1,600 = 87% utilisation (13% headroom — no HPA surge).
  70% SLO gate = 1,120 connections.

NOT VIABLE — db.r6g.large + HPA Max=5: 5 × 349 = 1,745 / 1,600 = 109% OVER CAP
  (connection-refused on 5th pod under saturation).
```

At the **current** default of 25 per pod:

```
4 pods × 25 = 100 connections (Prisma only; BRPOP still ~224/pod)
Prisma in-flight demand alone = ~500 tx → severe pool starvation under load.
```

Without this fix, Phase 2 Fix #2's worker ramp will saturate the Prisma connection pool, causing cascading 503s and pool timeout errors (`DB_POOL_TIMEOUT` fires at 5 s, returning 503 to users). The `.env.production.example` line 31 documents the correct value as 125, but it was never injected into the task definition.

**Reference:** `index-20-validated.md` §1.2 Step 4 (lines 337–345) + §7C 0.4 (lines 2998–3028); `src/shared/database/prisma.service.ts:282–283`. The chosen Option (A/B) MUST be recorded in the deployment log and matched in `rds-upgrade.md` (RDS class) and `hpa-cap.md` (HPA MaxReplicas) before applying this runbook.

---

## Current State

Verify the variable is absent from the live task definition before executing:

```bash
export AWS_REGION="ap-south-1"
export TASK_FAMILY="<your-task-family-name>"   # e.g. weelo-backend

aws ecs describe-task-definition \
  --task-definition "$TASK_FAMILY" \
  --region "$AWS_REGION" \
  --query 'taskDefinition.containerDefinitions[].environment'
```

Expected output: a JSON array with **no entry whose `name` is `DB_CONNECTION_LIMIT`**. If you see `"value": "125"` already present, this runbook has already been applied — stop here.

---

## Execution

Run the following steps in order. All commands require AWS CLI v2 and `jq` installed.

```bash
export AWS_REGION="ap-south-1"
export ECS_CLUSTER="<your-cluster-name>"    # e.g. weelo-cluster
export ECS_SERVICE="<your-service-name>"    # e.g. weelo-backend-service
export TASK_FAMILY="<your-task-family-name>"

# Step 1: Capture current task definition (strips immutable fields)
aws ecs describe-task-definition \
  --task-definition "$TASK_FAMILY" \
  --region "$AWS_REGION" \
  --query 'taskDefinition' > /tmp/td-current.json

# Capture current revision number NOW — needed for rollback before Step 3 creates a new one
PREV_REVISION=$(aws ecs describe-task-definition \
  --task-definition "$TASK_FAMILY" \
  --region "$AWS_REGION" \
  --query 'taskDefinition.revision' \
  --output text)
echo "Previous revision (for rollback): ${TASK_FAMILY}:${PREV_REVISION}"

# Step 2: Inject DB_CONNECTION_LIMIT=125, removing any stale copy first
jq '
  del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
      .compatibilities, .registeredAt, .registeredBy)
  | .containerDefinitions[0].environment |=
      ( map(select(.name != "DB_CONNECTION_LIMIT"))
        + [{name: "DB_CONNECTION_LIMIT", value: "125"}] )
' /tmp/td-current.json > /tmp/td-new.json

# Step 3: Register the new revision
NEW_TD_ARN=$(aws ecs register-task-definition \
  --cli-input-json file:///tmp/td-new.json \
  --region "$AWS_REGION" \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)

echo "New task definition ARN: $NEW_TD_ARN"

# Step 4: Update the service to use the new revision
aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --task-definition "$NEW_TD_ARN" \
  --force-new-deployment \
  --region "$AWS_REGION"

# Step 5: Wait for deployment to stabilise
aws ecs wait services-stable \
  --cluster "$ECS_CLUSTER" \
  --services "$ECS_SERVICE" \
  --region "$AWS_REGION"
```

---

## Verification

After `services-stable` returns, confirm the variable is live:

```bash
# Check env in the new task definition
aws ecs describe-task-definition \
  --task-definition "$NEW_TD_ARN" \
  --region "$AWS_REGION" \
  --query 'taskDefinition.containerDefinitions[0].environment[?name==`DB_CONNECTION_LIMIT`]'
```

Expected output:
```json
[
  {
    "name": "DB_CONNECTION_LIMIT",
    "value": "125"
  }
]
```

Also verify deployment is healthy:

```bash
aws ecs describe-services \
  --cluster "$ECS_CLUSTER" \
  --services "$ECS_SERVICE" \
  --region "$AWS_REGION" \
  --query 'services[0].{status:status,runningCount:runningCount,desiredCount:desiredCount,deployments:deployments[*].{id:id,status:status,runningCount:runningCount}}'
```

Pass criteria: `deployments` shows one entry with `status=PRIMARY` and `runningCount == desiredCount`.

Gate 0.4 is satisfied when both checks above pass.

---

## Rollback

If the deployment becomes unhealthy, revert to the previous revision immediately:

```bash
# PREV_REVISION was captured in Step 1 above, before the new revision was registered.
PREV_TD_ARN="${TASK_FAMILY}:${PREV_REVISION}"

aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --task-definition "$PREV_TD_ARN" \
  --force-new-deployment \
  --region "$AWS_REGION"

aws ecs wait services-stable \
  --cluster "$ECS_CLUSTER" \
  --services "$ECS_SERVICE" \
  --region "$AWS_REGION"
```

After rollback: investigate CloudWatch logs for root cause before retrying.

```bash
# Quick error check (see CLAUDE.md §SESSION 2026-03-22 for full log pattern)
STREAM=$(aws logs describe-log-streams \
  --log-group-name weelobackendtask \
  --order-by LastEventTime --descending --max-items 1 \
  --region "$AWS_REGION" \
  --query 'logStreams[0].logStreamName' --output text)

aws logs get-log-events \
  --log-group-name weelobackendtask \
  --log-stream-name "$STREAM" \
  --limit 100 --region "$AWS_REGION" \
  --query 'events[*].message' --output text | tr '\t' '\n' \
  | grep -i "error\|warn\|failed\|connection" | tail -30
```

---

## Coordination

| Dependency | Detail |
|---|---|
| **Must complete BEFORE** | Phase 2 Fix #2 worker ramp (ECS desired-count increase + any concurrency scaling) |
| **Must complete AFTER** | Nothing — this is a Wk0 blocker that gates all Phase 2 scale-out work |
| **Notify** | Team lead + whoever owns Phase 2 Fix #2 when Gate 0.4 is confirmed passed |

**Staging note:** Staging intentionally keeps `DB_CONNECTION_LIMIT=25` to match the `db.t4g.micro` budget (87 max_connections). Do NOT apply `value: "125"` to the staging task definition; the math only holds for production's `db.r6g.xlarge` (3,201 max_connections). See `prisma.service.ts:277–283`.

**Companion runbooks:**
- `rds-upgrade.md` — must run first to upgrade to db.r6g.xlarge (provides the 3,201 max_connections)
- `hpa-cap.md` — companion: HPA MaxReplicas must be set to 5 (Option A) or 4 (Option B) to match the per-pod connection math above
- `worker-ramp-step1.md` — this runbook must be verified complete before starting the worker ramp
