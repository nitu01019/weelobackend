# Reaper Leader-Lock — Post-Deploy Verification (Fix #16)

Source: `index-20-validated.md` §1.3 (lines 373–513) / §7C Step 5.

> **Canonical procedure lives in `runbooks/operator-ff-flips.md` §Fix #16.** This file is the
> structured soak-gate checklist + automated rollback companion to that procedure. The four
> verification steps below mirror the four §1.3 Pillar 4 checks; do NOT diverge — if you need
> to amend a step, edit `operator-ff-flips.md` first, then mirror here.

## When to run this

After the broadcast-reliability bundle PR merges to main and ECS deploys stabilize.
At HEAD `d97b5907` the reaper IS committed (`queue.service.ts:1261-1361`); the leader-lock
surface is live as soon as the bundle PR deploys.

Operator action at deploy time = none. `FF_PROCESSING_REAPER_LEADER_LOCK` defaults to `true`
(`feature-flags.ts:689-694`). This runbook is a soak-gate verification only.

**Companion-edit pre-flight (§1.3 line 407):** `REAPER_PROCESSING_CAP=500` (NOT 10_000) so
the worst-case body fits inside the 10 s lock TTL with 50 % slack:

```bash
git show HEAD:src/shared/services/queue.service.ts | grep -nE "REAPER_PROCESSING_CAP\s*=\s*500"
# Expected: single match at queue.service.ts:512
# If 10_000 / 1_000: STOP — peer pod can acquire mid-tick → double-LPUSH race.
```

---

## Hard Gate 5 Pass Criteria (§1.3 Pillar 4 / §7C Step 5 lines 405–410)

All four conditions must be true after a 30 min soak before declaring Fix #16 green:

1. `[Queue] Reaper re-queued` or `[ProcessingReaper]` log line appears on at least one pod (leader is executing).
2. `processing_reaper_lock_miss_total{queue=...}` is **non-zero on at least one follower pod** (proves leader election is running, not every pod winning).
3. Redis `lock:processing-reaper:${queue}` returns non-nil UUID at least once during a 5-sample 6 s spot-check window.
4. Broadcast dedup metrics show **no spike** (within ±10 % of pre-deploy baseline).

---

## Step 1 — Confirm reaper started (leader pod logs)

Wait 60s after deploy stabilizes, then:

```bash
export LOG_GROUP=weelobackendtask
export REGION=ap-south-1

# Filter for reaper boot and lock-acquired traces
aws logs filter-log-events \
  --log-group-name "$LOG_GROUP" \
  --filter-pattern '"ProcessingReaper"' \
  --start-time "$(date -u -v-5M +%s000 2>/dev/null || date -u -d '5 minutes ago' +%s000)" \
  --region "$REGION" \
  --output json \
  | python3 -c "import json,sys; [print(e['message']) for s in json.load(sys.stdin)['events'] for e in [s]]" 2>/dev/null \
  | grep -iE "ProcessingReaper|Reaper re-queued|acquireLock.*processing-reaper"
```

**Expected on leader pod:** Lines containing `[Queue] Reaper re-queued N stale entries for ${queue}` (only when stale entries exist) and/or `[ProcessingReaper]` traces.
**Expected on follower pods:** `[ProcessingReaper] acquireLock failed` OR silent skip — they back off because the lock is held; the lock-miss counter increments instead (verified in Step 2).

If zero lines appear, the reaper has not fired yet (30 s interval). Wait one more tick.

---

## Step 2 — Confirm lock-miss counter is non-zero on followers

> **`processing_reaper_lock_miss_total` is auto-registered Prometheus-only at HEAD `d97b5907`** —
> it is incremented at `queue.service.ts:1293` via `metrics.incrementCounter` (auto-create at
> `metrics.service.ts:513-522`) and exposed on the in-process `/metrics` endpoint, but is **not**
> pushed to CloudWatch (no `PutMetricData` publisher exists outside `dlq-broadcasts-depth-emitter.ts`).
> Verify via `/metrics` curl, NOT `aws cloudwatch get-metric-statistics`. If a CW pipeline is added
> later (EMF, prometheus-pushgateway, cloudwatch-agent), restore the CW path here.

```bash
# /metrics is gated by HEALTH_ADMIN_TOKEN (header x-health-token) per
# src/shared/routes/health.routes.ts:140-150,416. Pull pod IPs from ECS and curl each one.
TOKEN="${HEALTH_ADMIN_TOKEN:?set HEALTH_ADMIN_TOKEN}"
CLUSTER="${ECS_CLUSTER:?set ECS_CLUSTER}"
SERVICE="${ECS_SERVICE:?set ECS_SERVICE}"

TASK_IPS=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" --region ap-south-1 \
  --query 'taskArns' --output text \
  | xargs -n1 -I{} aws ecs describe-tasks --cluster "$CLUSTER" --tasks {} --region ap-south-1 \
  --query 'tasks[].attachments[].details[?name==`privateIPv4Address`].value' --output text)

for ip in $TASK_IPS; do
  echo "=== pod $ip ==="
  curl -sS -H "x-health-token: $TOKEN" "http://${ip}:3000/metrics" \
    | grep -E '^processing_reaper_lock_miss_total\{' \
    || echo "  (no samples — pod may be the leader for this queue)"
done
```

**Expected across the fleet:** at least N-1 of N pods report `processing_reaper_lock_miss_total{queue="..."}` > 0; one pod (the leader for that queue) may report no samples. A Sum of 0 across **all** pods after 5+ min means either only one pod is running (check ECS desired count) or `FF_PROCESSING_REAPER_LEADER_LOCK` is off.

---

## Step 3 — Spot-check Redis lock keys directly

`acquireLock('processing-reaper:${queue}', workerId, 10)` stores the key with a `lock:`
prefix applied by `redis.service.ts:2887`. Verify each of the three registered queues
(`booking:resume-broadcast`, `hold:finalize-retry`, `hold-expiry`):

```bash
REDIS_HOST=<prod-redis-host>
REDIS_PORT=6379

# 5-sample 6 s spot-check window per queue (interval=30s, TTL=10s — at least one
# of the 5 samples must land inside an active tick body).
for queue in 'booking:resume-broadcast' 'hold:finalize-retry' 'hold-expiry'; do
  echo "=== queue $queue ==="
  for i in 1 2 3 4 5; do
    GETV=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" GET "lock:processing-reaper:${queue}")
    PTTL=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" PTTL "lock:processing-reaper:${queue}")
    echo "sample$i  GET=${GETV:-nil}  PTTL=${PTTL}"
    sleep 6
  done
done
```

**Expected:** at least one sample per queue shows a non-nil UUID (the leader pod's `HOSTNAME`) AND PTTL between 1000 and 10000 ms (TTL=10s, refreshed each tick body).
**Fail:** nil across all 5 samples means the lock expired between ticks (reaper interval = 30 s, lock TTL = 10 s — lock is NOT held between ticks by design; it is acquired and released within each tick body). Fall back to Step 1 log evidence.

---

## Step 4 — Confirm no duplicate broadcast spike

`broadcast_dedup_total` is also auto-registered Prometheus-only at HEAD; query via `/metrics`
unless a CW publisher has been added since.

```bash
# Same fleet-wide /metrics scrape as Step 2 — sum across pods, compare to baseline.
for ip in $TASK_IPS; do
  curl -sS -H "x-health-token: $TOKEN" "http://${ip}:3000/metrics" \
    | grep -E '^broadcast_dedup_total\{' || true
done
# Optional fallback: if CW pipeline exists, the original CW query is correct:
#   aws cloudwatch get-metric-statistics --namespace Weelo/Backend \
#     --metric-name broadcast_dedup_total --statistics Sum --period 300 ...
```

**Expected:** rate flat vs pre-deploy baseline (within ±10 %). A 2–6× spike means the leader-lock is NOT preventing duplicate reaps — proceed to rollback (try Option A first).

---

## Pass Verdict

Declare Hard Gate 5 green when ALL of the following hold after a 30 min soak:

- [ ] Step 1: `[Queue] Reaper re-queued` or `[ProcessingReaper]` log line on at least one pod (leader executing)
- [ ] Step 2: `processing_reaper_lock_miss_total{queue=...}` Sum > 0 on at least one follower pod
- [ ] Step 3: Redis `lock:processing-reaper:${queue}` returns non-nil UUID at least once across the 5-sample window per queue
- [ ] Step 4: `broadcast_dedup_total` rate flat (within ±10 %) vs baseline

---

## Rollback (3-tier per §1.3 lines 230–240)

Source: `index-20-validated.md` §1.3 (lines 230–240, 503). Try A → B → C only as needed.

### Option A — Disable leader lock (reaper runs unlocked; safe only at pod count ≤ 2)

Pull current task-def, patch `FF_PROCESSING_REAPER_LEADER_LOCK=false`, register, update-service:

```bash
CLUSTER=<ecs-cluster>
SERVICE=<ecs-service>
REGION=ap-south-1

TD_ARN=$(aws ecs describe-services \
  --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
  --query 'services[0].taskDefinition' --output text)

aws ecs describe-task-definition --task-definition "$TD_ARN" --region "$REGION" \
  | python3 -c "
import json, sys
td = json.load(sys.stdin)['taskDefinition']
for c in td.get('containerDefinitions', []):
    env = c.get('environment', [])
    env = [e for e in env if e['name'] != 'FF_PROCESSING_REAPER_LEADER_LOCK']
    env.append({'name': 'FF_PROCESSING_REAPER_LEADER_LOCK', 'value': 'false'})
    c['environment'] = env
keep = ['family','containerDefinitions','volumes','placementConstraints','requiresCompatibilities','cpu','memory','executionRoleArn','taskRoleArn','networkMode']
print(json.dumps({k: td[k] for k in keep if k in td}))
" > /tmp/td-reaper-rollback.json

NEW_TD=$(aws ecs register-task-definition \
  --cli-input-json file:///tmp/td-reaper-rollback.json \
  --region "$REGION" \
  --query 'taskDefinition.taskDefinitionArn' --output text)

aws ecs update-service \
  --cluster "$CLUSTER" --service "$SERVICE" \
  --task-definition "$NEW_TD" --force-new-deployment --region "$REGION"

aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION"
echo "Rolled back to unlocked reaper. New TD: $NEW_TD"
```

### Option B — Disable BLMOVE branch entirely (safest; reverts to legacy BRPOP path)

Same procedure as Option A but set `FF_QUEUE_BLMOVE_DEQUEUE=false`.
This disables the entire BLMOVE dequeue branch — no reaper runs, no `:processing-list` is
written. Jobs use the legacy BRPOP path. Stale entries from the BLMOVE window will be
drained by `recoverStaleProcessingJobs` at next boot.

### Option C — Full task-def revert (last resort)

```bash
# List recent task-def revisions
aws ecs describe-services \
  --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
  --query 'services[0].deployments[*].{Status:status,Td:taskDefinition,UpdatedAt:updatedAt}' \
  --output table

# Revert to PREVIOUS_TD_ARN
aws ecs update-service \
  --cluster "$CLUSTER" --service "$SERVICE" \
  --task-definition "$PREVIOUS_TD_ARN" --force-new-deployment --region "$REGION"
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION"
```

---

## Reference

| Item | Value |
|---|---|
| Feature flag | `FF_PROCESSING_REAPER_LEADER_LOCK` (defaultValue=true) |
| Flag file | `src/shared/config/feature-flags.ts:689-694` (HEAD `d97b5907`) |
| Reaper implementation | `src/shared/services/queue.service.ts:1261-1361` (`startProcessingReaper`) |
| Lock key pattern | `lock:processing-reaper:${queueName}` (after `acquireLock` normalization at `redis.service.ts:2887`) |
| Lock TTL | 10 s per tick (`acquireLock(..., 10)` at `queue.service.ts:1289`) |
| Reaper tick interval | 30 s (`REAPER_INTERVAL_MS` at `queue.service.ts:506`) |
| Stale entry age threshold | 60 s (`REAPER_MAX_AGE_MS` at `queue.service.ts:505`) |
| Per-tick batch cap | **500** (`REAPER_PROCESSING_CAP` at `queue.service.ts:512`) — companion edit per §1.3 line 407 |
| Lock-miss metric | `processing_reaper_lock_miss_total` (label: `queue`) — incremented at `queue.service.ts:1293` |
| Metric publication | Auto-registered Prometheus-only at HEAD `d97b5907`. **NOT** pushed to CloudWatch — verify via `/metrics` curl, gated by `HEALTH_ADMIN_TOKEN` (`health.routes.ts:140-150,416`). |
| Canonical procedure | `runbooks/operator-ff-flips.md` §Fix #16 |
| Registered queues | `booking:resume-broadcast` (`booking-lifecycle.service.ts:903`), `hold:finalize-retry` (`hold-finalize-retry.processor.ts:42,208`), `hold-expiry` (`hold-expiry-cleanup.service.ts:66,539`) |
| Source authority | `index-20-validated.md` §1.3 (lines 373–513), §7C Step 5 |
