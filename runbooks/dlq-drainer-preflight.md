# DLQ Drainer Preflight Checklist

**Purpose:** Operator checklist that MUST pass before Lyra (or any operator) flips the batch
queue depth-guard (`FF_BATCH_QUEUE_DEPTH_GUARD`).

> **Where this fits in the flip:** This runbook is **gate (a) drainer registered + (b) leader-lock held + (c) LLEN < 100** of the §2.1.1 / §4.6 pre-flight. The full Fix #6 procedure (pre-flight → execution → 30 min soak → rollback) lives in `runbooks/operator-ff-flips.md` § "Fix #6". Run all 5 checks below first, then return to that runbook.

**Authority:** index-20-validated.md §4.6 ("Wrong order = outage") and §7C 1.1 (alarm
sidecar hard gate).

**Context:** The depth-guard pushes overflow to `dlq:broadcasts`. If the leader-elected
drainer is not running on at least one ECS pod, those entries pile up forever → Redis OOM
→ manual recovery required (§4.6 hazard). Complete every check below in order before
enabling the guard.

---

## Pre-conditions

- ECS service is healthy and at least one task is running.
- Redis is reachable from the bastion / ops host.
- You have read access to CloudWatch and ECS logs.

---

## Check 1 — Drainer is registered at boot

**What to look for:** Boot log line emitted by `src/server.ts:1086-1099` when
`FF_DLQ_DRAINER_ENABLED !== 'false'`.

```bash
# Pull from the most recent ECS log stream (ap-south-1)
STREAM=$(aws logs describe-log-streams \
  --log-group-name weelobackendtask \
  --order-by LastEventTime --descending --max-items 1 \
  --region ap-south-1 --output json \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['logStreams'][0]['logStreamName'])")

aws logs get-log-events \
  --log-group-name weelobackendtask \
  --log-stream-name "$STREAM" \
  --region ap-south-1 \
  --query 'events[*].message' --output text \
  | tr '\t' '\n' \
  | grep "\[DLQ\]"
```

**Expected output (pass):**
```
[DLQ] broadcast drainer registered (30s interval, leader-elected)
```

**Failure pattern:** Line absent, OR:
```
[DLQ] broadcast drainer disabled via FF_DLQ_DRAINER_ENABLED=false
[Startup] DLQ drainer failed to register (non-fatal): ...
```

If failed: check `FF_DLQ_DRAINER_ENABLED` in the ECS task definition env vars and confirm
the `replay-broadcast-dlq.ts` module compiled cleanly in the latest image.

---

## Check 2 — Exactly one pod holds the leader lock

The drainer uses `redisService.acquireLock('dlq:drainer:lock', holderId, 60)`.
Exactly one pod should hold this key; all others log "Peer is leader — exiting gracefully".

```bash
redis-cli GET dlq:drainer:lock
```

**Expected output (pass):** A non-empty UUID string. If the key is expired (nil) but pods
are running, the next 30s interval will re-acquire — wait up to 35s and retry.

**Failure pattern:** `nil` persists beyond 35s with pods running → drainer loop is not
firing. Restart the ECS task to force re-registration.

> Note: §4.6 uses the key name `dlq:broadcast:leader`; the implementation registers it as
> `dlq:drainer:lock` (see `scripts/replay-broadcast-dlq.ts:DRAINER_LOCK_KEY`). Both names
> refer to the same leader-election key.

---

## Check 3 — DLQ depth is zero or trending down

```bash
redis-cli LLEN dlq:broadcasts
# Wait 60s
redis-cli LLEN dlq:broadcasts
```

**Expected output (pass):** Zero, or the second reading is lower than the first.

**Failure pattern:** Non-zero and not decreasing over 60s — drainer is registering but not
successfully replaying. Inspect the inflight list:

```bash
redis-cli LLEN dlq:broadcasts:inflight
redis-cli LRANGE dlq:broadcasts:inflight 0 4    # sample first 5 entries
```

Failed entries are intentionally left in `dlq:broadcasts:inflight` (not removed via LREM)
for operator inspection. Each entry is moved via `LMOVE … RIGHT LEFT` before replay so a
crash mid-pass cannot lose data (crash-safe semantics, `scripts/replay-broadcast-dlq.ts`).

DO NOT enable the depth-guard if LLEN is non-zero and not decreasing (§4.6 explicit gate).

---

## Check 4 — Inject a canary entry and confirm drain

This is the live-fire verification required by §4.6 step 3.

```bash
# Push a synthetic (non-parsable) canary. The drainer will log a failed replay
# and leave it in inflight — that is the expected result for a canary.
redis-cli LPUSH dlq:broadcasts '{"transporterId":"TEST-OPS","event":"__preflight_canary__","data":{},"droppedAt":0}'

# Watch drain within 60s
redis-cli LLEN dlq:broadcasts   # should drop by 1

# Confirm it moved to inflight (replay fails gracefully for unknown events)
redis-cli LRANGE dlq:broadcasts:inflight 0 -1 | grep preflight_canary

# Clean up
redis-cli LREM dlq:broadcasts:inflight 0 '{"transporterId":"TEST-OPS","event":"__preflight_canary__","data":{},"droppedAt":0}'
```

**Expected output (pass):** LLEN drops by 1 within 60s; canary appears in inflight; manual
LREM cleans up without error.

**Failure pattern:** LLEN unchanged after 60s → return to Check 1 / Check 2.

---

## Check 5 — `dlq_broadcasts_depth` metric is emitting in CloudWatch

Per §7C 1.1, the alarm sidecar at
`src/shared/services/dlq-broadcasts-depth-emitter.ts` runs on every pod
(no leader election; CloudWatch de-duplication uses Statistic=Maximum).

```bash
aws cloudwatch list-metrics \
  --namespace Weelo/Backend \
  --metric-name dlq_broadcasts_depth \
  --region ap-south-1 \
  --output table
```

**Expected output (pass):** At least one row returned.

**Failure pattern:** No metrics returned → `@aws-sdk/client-cloudwatch` may not be
installed (§7C 1.1 hard gate: "MUST install `@aws-sdk/client-cloudwatch`" before this
step). Sidecar falls back to Prometheus-only when the package is absent.

```bash
# Verify package is present in the deployed image
cat /Users/nitishbhardwaj/Downloads/weelo-backend/package.json | grep client-cloudwatch
```

If absent: `npm install @aws-sdk/client-cloudwatch@^3.978.0 --save`, include in next
bundle PR, redeploy.

---

## Gate — Enable depth-guard

All 5 checks must pass. Then:

```bash
# ECS task definition — add or update env var
FF_BATCH_QUEUE_DEPTH_GUARD=true
```

Redeploy via the standard task-def update flow. Monitor `dlq:broadcasts` LLEN for 5
minutes after the new tasks are healthy to confirm the drainer is keeping pace.

---

## Rollback

If `dlq:broadcasts` LLEN climbs after enabling the guard:

1. Set `FF_BATCH_QUEUE_DEPTH_GUARD=false` and redeploy immediately.
2. The existing entries in `dlq:broadcasts` will drain via the 30s drainer loop.
3. Investigate queue throughput before re-enabling.

---

*References: index-20-validated.md §4.6 (depth-guard hazard) · §7C 1.1 (alarm sidecar hard gate) · scripts/replay-broadcast-dlq.ts · src/server.ts:1085-1110*
