# Runbook: Flip FF_BATCH_QUEUE_DEPTH_GUARD=true

> **DEPRECATED — see canonical runbook.**
> The authoritative Fix #6 procedure is **`runbooks/operator-ff-flips.md` § "Fix #6 — Flip `FF_BATCH_QUEUE_DEPTH_GUARD=true`"** (lines 25–166). It carries the full §2.1.1 pre-flight (drainer-registered log filter, leader-lock GET + PTTL, broadcast queue shard sum, saturation-alarm OK gate), the §2.1.1 line 1509 block-flip rule (24 h alarm history + LLEN ≥ 4500 in last 5 min), and both rollback paths (soft env flip preferred per §2.1.1 line 1515; hard task-def revision revert as fallback).
>
> This file is retained only to preserve the prerequisite chain (Iris → Juno → Kestrel) referenced by Phase 0 council notes. **Do not flip from this file.** Cross-walk to `operator-ff-flips.md` before executing any step below.
>
> Audited at HEAD `d97b5907` against `index-20-validated.md` §2.1.1 (lines 1437–1522) + §4.6 (lines 2244–2255). Selene 2026-05-09.

**Source:** `index-20-validated.md` §7C 1.3 (lines 3093–3101) — superseded by §2.1.1 (canonical).
**Est. execution:** ~5 min deploy + 30 min soak

---

## Prerequisites

All must be true before starting:

- Iris runbook done — `DB_CONNECTION_LIMIT=125` in task def, service stable
- Juno runbook done — RDS upgrade verified, `pool_wait_seconds` p99 ≤ 50 ms for ≥ 15 min
- Kestrel runbook done — `FF_DLQ_DRAINER_ENABLED=true` confirmed in task def
- All `weelo-` CloudWatch alarms **OK for ≥ 1 hour**
- **`runbooks/dlq-drainer-preflight.md` Checks 1–5 all PASS** (§4.6 hard gate)
- **`runbooks/dlq-sidecar-verify.md` confirms `dlq_broadcasts_depth` datapoints in CloudWatch** (§7C 1.1)

Verify alarms clear:
```bash
aws cloudwatch describe-alarms --alarm-name-prefix "weelo-" \
  --state-value ALARM --region ap-south-1 --query 'MetricAlarms[].AlarmName'
# Expected: []
```

---

## Pre-Flight

> **Run the §2.1.1 pre-flight checklist from `operator-ff-flips.md` lines 35–78 first** (drainer-registered log filter, leader-lock GET + PTTL, `LLEN dlq:broadcasts < 100`, broadcast-queue priority-shard sum vs cap, saturation alarm OK). The block-flip rule on line 80 of that file (depth alarm fired in last 24 h OR LLEN ≥ 4500 in any of previous 5 min) is binding here too — **do not flip if either condition is true**.

Then capture current revision for rollback:
```bash
PREV_REVISION=$(aws ecs describe-task-definition \
  --task-definition weelobackendtask --region ap-south-1 \
  --query 'taskDefinition.revision' --output text)
echo "PREV_REVISION=${PREV_REVISION}"   # save this
```

---

## Execution

```bash
# 1. Pull current task def
aws ecs describe-task-definition --task-definition weelobackendtask \
  --region ap-south-1 --query 'taskDefinition' > /tmp/td.json

# 2. Patch FF_BATCH_QUEUE_DEPTH_GUARD=true (via jq or Python), strip read-only fields
#    (taskDefinitionArn, revision, status, requiresAttributes, compatibilities,
#     registeredAt, registeredBy), write to /tmp/td-new.json

# 3. Register
NEW_REVISION=$(aws ecs register-task-definition \
  --cli-input-json file:///tmp/td-new.json --region ap-south-1 \
  --query 'taskDefinition.revision' --output text)

# 4. Rolling deploy
aws ecs update-service --cluster weelo-cluster \
  --service weelobackendservice \
  --task-definition weelobackendtask:${NEW_REVISION} --region ap-south-1

# 5. Wait
aws ecs wait services-stable --cluster weelo-cluster \
  --services weelobackendservice --region ap-south-1
```

---

## Post-Flip Soak (30 min)

Monitor every 5 min. All four must stay green:

| Signal | Pass threshold |
|---|---|
| `dlq_broadcasts_depth` | Near 0 at current 10–30 RPS |
| `dlq_broadcasts_depth-saturation` alarm | OK |
| `pool_wait_seconds` p99 | ≤ 50 ms |
| broadcast latency p99 | Within ±10% of pre-flip baseline |

**Hard gate 1.3 (§7C 1.3 line 3101):** 30-min soak passes all alarms + no broadcast SLO regression before proceeding to Fix #2 worker ramp.

---

## Auto-Rollback Triggers

Initiate rollback immediately if either:
- `hold_create_error_rate` > **2%** sustained ≥ 2 min
- broadcast p99 spikes > **2× pre-flip baseline**

Also rollback if `dlq_broadcasts_depth-saturation` fires at any point.

---

## Rollback

Two paths, in order of preference (per §2.1.1 line 1515):

### Path A — Soft rollback (preferred, env flip only)

Set `FF_BATCH_QUEUE_DEPTH_GUARD=false` in the task-def and redeploy. Same procedure as Execution above but with the env flipped back. In-flight DLQ entries continue draining via the 30 s drainer loop (drainer is independent of guard flag).

### Path B — Hard rollback (full task-def revision revert)

```bash
aws ecs update-service --cluster weelo-cluster \
  --service weelobackendservice \
  --task-definition weelobackendtask:${PREV_REVISION} --region ap-south-1

aws ecs wait services-stable --cluster weelo-cluster \
  --services weelobackendservice --region ap-south-1

echo "Rolled back to ${PREV_REVISION}"
# File incident note: PREV/NEW revisions, trigger fired, timestamp, CW screenshots
```

Do not re-attempt flip without root-cause review.
