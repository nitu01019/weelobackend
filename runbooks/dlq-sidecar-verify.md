# DLQ Broadcasts Depth Sidecar — Verification Runbook

> **Where this fits in the Fix #6 flip:** This runbook is **gate (d) saturation alarm in OK state** of the §2.1.1 pre-flight (lines 1487–1506). The sidecar is what causes `weelo-dlq-broadcasts-depth-warn` and `-saturation` to leave `INSUFFICIENT_DATA` — without a green datapoint stream the canonical `operator-ff-flips.md` § "Fix #6" pre-flight check 5 (saturation alarm = OK) cannot pass. Run this **before** the drainer-preflight checks if alarms are stuck in `INSUFFICIENT_DATA`.

## Why this sidecar exists

Phase 2 broadcast reliability (§7C 1.1 of index-20-validated.md) depends on the CloudWatch alarm
`weelo-dlq-broadcasts-depth-warn` being in an evaluable state before the `FF_BATCH_QUEUE_DEPTH_GUARD`
flag is flipped. Without the sidecar that alarm stays in `INSUFFICIENT_DATA` permanently because no
process ever calls `PutMetricData` for the `dlq_broadcasts_depth` metric. A stalled drainer plus a
flag flip would then silently saturate the DLQ — the `queue.service.ts:2433` `lTrim` drops the oldest
entries with no alarm firing.

The sidecar (`src/shared/services/dlq-broadcasts-depth-emitter.ts` at commit `22061b3f`) runs a 30 s
`setInterval` that:
1. Calls `LLEN` on `dlq:broadcasts`, `dlq:broadcasts:permanent`, and `dlq:broadcasts:inflight` via Redis.
2. Mirrors each value into the in-process Prometheus gauge (`metrics.setGauge`).
3. Calls `PutMetricData` for three metrics in namespace `Weelo/Backend` (env `CW_NAMESPACE`):
   - `dlq_broadcasts_depth` — active retry list
   - `dlq_broadcasts_permanent_depth` — dead-letter (attempt-exhausted entries)
   - `dlq_broadcasts_inflight_depth` — drainer in-flight window
4. Fires an immediate first tick on boot so the alarm exits `INSUFFICIENT_DATA` within the next
   60 s CloudWatch evaluation period.

The sidecar is **default-on**. It is wired in `server.ts` lines ~1117–1131 alongside the DLQ drainer.
Opt-out only: set `FF_DLQ_DEPTH_EMITTER_ENABLED=false`.

---

## Execution

Run the following checks in order after each ECS deployment.

### Step 1 — Confirm the feature flag is active

```bash
aws ecs describe-task-definition \
  --task-definition weelobackendtask \
  --region ap-south-1 \
  --query 'taskDefinition.containerDefinitions[0].environment[?name==`FF_DLQ_DEPTH_EMITTER_ENABLED`]'
```

Expected: empty array (default-on) OR `[{"name":"FF_DLQ_DEPTH_EMITTER_ENABLED","value":"true"}]`. If `"value": "false"`, remove the env var or set it to `true` and redeploy.

### Step 2 — Run the verification commands below to confirm sidecar is emitting

Work through the three verification commands in order. All three must pass before the sidecar is considered live.

**Hard gate:** Do not flip `FF_BATCH_QUEUE_DEPTH_GUARD=true` until the `weelo-dlq-broadcasts-depth-warn` alarm is NOT in `INSUFFICIENT_DATA`.

---

## Rollback

If the sidecar causes issues (excessive CloudWatch API calls, Redis connection errors, alarm false-positives):

```bash
# Disable sidecar: inject FF_DLQ_DEPTH_EMITTER_ENABLED=false into task-def + redeploy
aws ecs describe-task-definition \
  --task-definition weelobackendtask \
  --region ap-south-1 \
  --query 'taskDefinition' --output json \
  | jq 'del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
             .compatibilities, .registeredAt, .registeredBy)
        | .containerDefinitions[0].environment |=
            (map(select(.name != "FF_DLQ_DEPTH_EMITTER_ENABLED"))
             + [{name: "FF_DLQ_DEPTH_EMITTER_ENABLED", value: "false"}])' \
  > /tmp/td-sidecar-off.json

ROLLBACK_TD_ARN=$(aws ecs register-task-definition \
  --cli-input-json file:///tmp/td-sidecar-off.json \
  --region ap-south-1 \
  --query 'taskDefinition.taskDefinitionArn' --output text)

aws ecs update-service \
  --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" \
  --task-definition "$ROLLBACK_TD_ARN" \
  --force-new-deployment --region ap-south-1

aws ecs wait services-stable \
  --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" --region ap-south-1
```

After rollback: the depth-tier alarms will return to `INSUFFICIENT_DATA`. Do NOT flip `FF_BATCH_QUEUE_DEPTH_GUARD` until the sidecar is re-enabled and alarms are back in `OK`.

---

## Verification commands (run after deploy)

### 1. Confirm the sidecar booted in ECS logs

```bash
# Substitute the correct log group / stream for your environment
LOG_GROUP="weelobackendtask"
STREAM=$(aws logs describe-log-streams \
  --log-group-name "$LOG_GROUP" \
  --order-by LastEventTime \
  --descending \
  --max-items 1 \
  --region ap-south-1 \
  --output json \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['logStreams'][0]['logStreamName'])")

aws logs get-log-events \
  --log-group-name "$LOG_GROUP" \
  --log-stream-name "$STREAM" \
  --limit 200 \
  --region ap-south-1 \
  --query 'events[*].message' \
  --output text | tr '\t' '\n' | grep "\[DLQSidecar\]\|\[DLQDepthEmitter\]"
```

**Expected output (one line per 30 s interval):**
```
[DLQDepthEmitter] started (every 30s, namespace=Weelo/Backend, region=ap-south-1)
[DLQDepthEmitter] started (every 30s, ...   # only once — subsequent lines are tick results
```

If the line is absent, check the failure-mode table below.

### 2. Confirm metrics reached CloudWatch

```bash
# Check the last 5 minutes for dlq_broadcasts_depth datapoints
END=$(date -u +%Y-%m-%dT%H:%M:%SZ)
START=$(date -u -v-5M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u --date='5 minutes ago' +%Y-%m-%dT%H:%M:%SZ)   # Linux fallback

aws cloudwatch get-metric-statistics \
  --namespace "Weelo/Backend" \
  --metric-name "dlq_broadcasts_depth" \
  --start-time "$START" \
  --end-time "$END" \
  --period 60 \
  --statistics Average \
  --region ap-south-1
```

**Expected output:** A `Datapoints` array containing at least one entry with a numeric `Average`
(value may be `0.0` if the DLQ is empty — that is correct). An empty `Datapoints` array means
the sidecar is not emitting.

Repeat the command for `dlq_broadcasts_permanent_depth` and `dlq_broadcasts_inflight_depth`.

### 3. Confirm the CloudWatch alarm is no longer INSUFFICIENT_DATA

```bash
aws cloudwatch describe-alarms \
  --alarm-names "weelo-dlq-broadcasts-depth-warn" \
  --region ap-south-1 \
  --query 'MetricAlarms[0].{State:StateValue,Reason:StateReason}'
```

**Expected:** `State` = `OK` (or `ALARM` if the DLQ is genuinely backed up). `INSUFFICIENT_DATA`
after > 2 minutes post-deploy means no datapoints arrived.

---

## Expected log cadence

| Time after boot | Expected log line |
|---|---|
| 0–5 s | `[DLQDepthEmitter] started (every 30s …)` |
| ~30 s | Second `PutMetricData` call completes (no log unless error) |
| Every 30 s thereafter | Silent (errors produce WARN-level lines only) |

A WARN line like `[DLQDepthEmitter] PutMetricData failed` is emitted for each CloudWatch error but
does NOT stop the loop — Prometheus gauges still update on every tick.

---

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| No `[DLQDepthEmitter] started` log | `FF_DLQ_DEPTH_EMITTER_ENABLED=false` is set in ECS task env | Remove the env var or set it to any value other than `false` |
| `[DLQDepthEmitter] @aws-sdk/client-cloudwatch unavailable` | SDK not in `node_modules` (dev image or stripped prod build) | Add `@aws-sdk/client-cloudwatch` to `dependencies` in `package.json` and rebuild image |
| `PutMetricData failed … AccessDenied` | ECS task role lacks `cloudwatch:PutMetricData` | Add `cloudwatch:PutMetricData` to the task IAM role for namespace `Weelo/Backend` |
| CloudWatch alarm stays `INSUFFICIENT_DATA` > 5 min | No datapoints in the namespace/metric name | Verify `CW_NAMESPACE` env var matches the alarm's namespace exactly (default `Weelo/Backend`) |
| `[DLQDepthEmitter] LLEN failed` in logs | Redis unavailable at emit time | Investigate Redis connectivity; sidecar will retry on next 30 s tick automatically |
| Duplicate `started` log lines | Multiple ECS tasks sharing the same Redis/CW — expected | Each task runs its own sidecar independently; alarm aggregates across tasks via `Sum` statistics |
