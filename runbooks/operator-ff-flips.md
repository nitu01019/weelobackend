# Operator Handoff — Feature-Flag Flips: Fix #6, Fix #16, Fix #17

**Source authority:** `index-20-validated.md` §2.1.1 (Fix #6), §1.3 (Fix #16), §4.2 (Fix #17), §7C 1.3 / §7C 5 / §7B Wk3\
**Region:** `ap-south-1` (override with `AWS_REGION`)\
**ECS cluster / service:** set `ECS_CLUSTER` and `ECS_SERVICE` before running any block below.

> **DOC-ONLY.** No AWS or Redis commands execute automatically. Run each block manually after sourcing credentials.

---

## Sequencing rule

These three flags are independent but have hard ordering constraints within the broader §7C plan:

```
Fix #6  (FF_BATCH_QUEUE_DEPTH_GUARD)   ← §7C Step 1.3 — after Wk0 ops + DLQ alarms OK
Fix #16 (FF_PROCESSING_REAPER_LEADER_LOCK) ← ships defaulted ON with the bundle PR; no operator flip needed
Fix #17 (FF_CROSS_POD_ROOM_REPLAY)     ← §7B Wk3 — after ≥24h SADD bake (canonical) / 48h conservative
```

Do NOT flip Fix #17 before Fix #6 is stable. Do NOT flip Fix #17 before the SADD bake gate passes.

---

## Fix #6 — Flip `FF_BATCH_QUEUE_DEPTH_GUARD=true`

**What it does:** Enables the broadcast queue depth cap (5000 entries). Overflow is routed to `dlq:broadcasts` for leader-elected drainer replay instead of being admitted and causing latency spikes. (`queue.service.ts:172`, `:2367–2434`)

**Hard dependencies before flipping:**
- Wk0 steps 0.1–0.5 complete (RDS upgraded, DB_CONNECTION_LIMIT=125, bundle PR merged)
- DLQ depth sidecar emitting (`dlq-sidecar-verify.md` runbook passed)
- All 4 `weelo-dlq-*` CloudWatch alarms in OK state (`cloudwatch-dlq-alarms.md` runbook complete + `setup-broadcast-p1-alarms.sh` run)
- Drainer pre-flight checks below pass

### Pre-flight checklist (§2.1.1 — run in order; stop if any fails)

```bash
# 1. Confirm drainer registered on at least one pod within the last hour
aws logs filter-log-events \
  --log-group-name weelobackendtask \
  --filter-pattern '"[DLQ] broadcast drainer registered"' \
  --start-time $(($(date +%s) - 3600))000 \
  --region ap-south-1 \
  --query 'events[].message' --output text | wc -l
# Expected: ≥ 1

# 2. Confirm leader lock is currently held (renewed every 30 s; TTL 60 s)
redis-cli -h <prod-redis-host> -p 6379 GET 'lock:dlq:drainer:lock'
# Expected: non-nil UUID string

redis-cli -h <prod-redis-host> -p 6379 PTTL 'lock:dlq:drainer:lock'
# Expected: 30000–60000 ms

# 3. DLQ depth must be small before flip
redis-cli -h <prod-redis-host> -p 6379 LLEN 'dlq:broadcasts'
# Expected: < 100
# If approaching 5000: drainer is overwhelmed — DO NOT FLIP. Investigate first.

# 4. Sum broadcast queue depth across all priority shards
TOTAL=0
for suffix in critical high normal low; do
  COUNT=$(redis-cli -h <prod-redis-host> -p 6379 LLEN "queue:broadcast:$suffix")
  echo "queue:broadcast:$suffix = $COUNT"
  TOTAL=$((TOTAL + COUNT))
done
LEGACY=$(redis-cli -h <prod-redis-host> -p 6379 LLEN queue:broadcast)
echo "queue:broadcast (legacy) = $LEGACY"
TOTAL=$((TOTAL + LEGACY))
echo "Total across all shards = $TOTAL (cap=5000)"
# Block flip if total approaches 5000.

# 5. Saturation alarm must be in OK state (not ALARM or INSUFFICIENT_DATA)
aws cloudwatch describe-alarms \
  --alarm-names "weelo-dlq-broadcasts-depth-saturation" \
  --region ap-south-1 \
  --query 'MetricAlarms[0].{State:StateValue,Reason:StateReason}'
# Expected: State = "OK"
```

**Block-flip rule** (§2.1.1): if the depth alarm has fired in the last 24 h OR `LLEN dlq:broadcasts` returned ≥ 4500 in any of the previous 5 minutes → **DO NOT FLIP**. Check `dlq_drained_total` rate vs `dlq_pushed_total` rate; drained must ≥ pushed.

### Execution

```bash
# 1. Capture current revision for rollback
PREV_REVISION=$(aws ecs describe-task-definition \
  --task-definition weelobackendtask --region ap-south-1 \
  --query 'taskDefinition.revision' --output text)
echo "PREV_REVISION=${PREV_REVISION}"   # save this

# 2. Pull current task-def
aws ecs describe-task-definition \
  --task-definition weelobackendtask \
  --region ap-south-1 \
  --query 'taskDefinition' > /tmp/td.json

# 3. Patch env vars (jq or Python), strip read-only fields, write to /tmp/td-new.json
#    Set FF_BATCH_QUEUE_DEPTH_GUARD=true and FF_DLQ_DRAINER_ENABLED=true
#    Strip: taskDefinitionArn, revision, status, requiresAttributes,
#           compatibilities, registeredAt, registeredBy

# 4. Register new revision
NEW_REVISION=$(aws ecs register-task-definition \
  --cli-input-json file:///tmp/td-new.json \
  --region ap-south-1 \
  --query 'taskDefinition.revision' --output text)
echo "NEW_REVISION=${NEW_REVISION}"

# 5. Rolling deploy
aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --task-definition "weelobackendtask:${NEW_REVISION}" \
  --region ap-south-1

# 6. Wait for stable
aws ecs wait services-stable \
  --cluster "$ECS_CLUSTER" \
  --services "$ECS_SERVICE" \
  --region ap-south-1
```

### Post-flip soak (30 min — §7C 1.3 hard gate)

Monitor every 5 min. All four must stay green:

| Signal | Pass threshold |
|---|---|
| `dlq_broadcasts_depth` (CloudWatch) | Near 0 at current 10–30 RPS |
| `weelo-dlq-broadcasts-depth-saturation` alarm | OK |
| `pool_wait_seconds` p99 | ≤ 50 ms |
| broadcast latency p99 | Within ±10% of pre-flip baseline |

```bash
# Check dlq depth trend (run every 5 min)
redis-cli -h <prod-redis-host> -p 6379 LLEN 'dlq:broadcasts'

# Check alarm state
aws cloudwatch describe-alarms \
  --alarm-name-prefix "weelo-dlq-" \
  --region ap-south-1 \
  --query 'MetricAlarms[*].{Name:AlarmName,State:StateValue}'
```

**Hard gate 1.3**: 30-min soak passes all signals → proceed to Fix #2 worker ramp.

### Rollback

```bash
# Soft rollback (env flip only — fastest)
# Set FF_BATCH_QUEUE_DEPTH_GUARD=false in task-def and redeploy (same procedure as execution above)

# Hard rollback (revert entire task-def revision)
aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --task-definition "weelobackendtask:${PREV_REVISION}" \
  --force-new-deployment \
  --region ap-south-1
aws ecs wait services-stable \
  --cluster "$ECS_CLUSTER" \
  --services "$ECS_SERVICE" \
  --region ap-south-1
echo "Rolled back to revision ${PREV_REVISION}"
# Note: in-flight DLQ entries continue to drain after rollback (drainer is independent of guard flag)
```

---

## Fix #16 — Verify reaper single-leader post-deploy

**What it does:** The BLMOVE processing-reaper (`queue.service.ts:startProcessingReaper()`) is protected by `acquireLock('processing-reaper:${queue}', workerId, 10)` gated by `FF_PROCESSING_REAPER_LEADER_LOCK` (defaultValue=true). Without this lock, HPA Max=6 pods race → ~8–10 duplicate broadcasts/sec at 400–500 RPS.

**Operator action at deploy time: NONE.** The flag defaults ON in the bundle PR. This section is verification only — confirm leader election is working after the bundle PR lands.

**Source:** §7C Step 5 / §1.3. At HEAD `8f400201` the reaper does not exist; risk surface opens the moment the bundle PR merges.

### Post-deploy verification (§7C hard gate 5)

Run within 5 min of the bundle PR deploy stabilising:

```bash
# 1. Confirm reaper leader-lock traces appear in logs (leader pod)
STREAM=$(aws logs describe-log-streams \
  --log-group-name weelobackendtask \
  --order-by LastEventTime --descending --max-items 1 \
  --region ap-south-1 --output json \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['logStreams'][0]['logStreamName'])")

aws logs get-log-events \
  --log-group-name weelobackendtask \
  --log-stream-name "$STREAM" \
  --region ap-south-1 \
  --query 'events[*].message' --output text \
  | tr '\t' '\n' \
  | grep -i "processing-reaper\|reaper.*leader\|acquireLock.*processing-reaper"
# Expected: at least one "acquired" lock line per 30 s interval on the leader pod

# 2. Confirm follower pods skip (lock-miss counter is non-zero)
aws cloudwatch get-metric-statistics \
  --namespace "Weelo/Backend" \
  --metric-name "processing_reaper_lock_miss_total" \
  --statistics Sum \
  --period 300 \
  --start-time "$(date -u -v-30M +%FT%TZ 2>/dev/null || date -u --date='30 minutes ago' +%FT%TZ)" \
  --end-time "$(date -u +%FT%TZ)" \
  --region ap-south-1
# Expected: Sum > 0 (follower pods are correctly skipping)

# 3. Confirm no broadcast dedup spike
aws cloudwatch get-metric-statistics \
  --namespace "Weelo/Backend" \
  --metric-name "broadcast_dedup_total" \
  --statistics Sum \
  --period 300 \
  --start-time "$(date -u -v-30M +%FT%TZ 2>/dev/null || date -u --date='30 minutes ago' +%FT%TZ)" \
  --end-time "$(date -u +%FT%TZ)" \
  --region ap-south-1
# Expected: flat or near-zero compared to pre-deploy baseline

# 4. Spot-check Redis leader key directly
# acquireLock('processing-reaper:${queue}') stores key as lock:processing-reaper:${queue}
# Check all 3 registered queues:
redis-cli -h <prod-redis-host> -p 6379 GET 'lock:processing-reaper:booking:resume-broadcast'
redis-cli -h <prod-redis-host> -p 6379 GET 'lock:processing-reaper:hold:finalize-retry'
redis-cli -h <prod-redis-host> -p 6379 GET 'lock:processing-reaper:hold-expiry'
# Expected: non-nil on each (one pod holds the lock per queue)
redis-cli -h <prod-redis-host> -p 6379 PTTL 'lock:processing-reaper:booking:resume-broadcast'
# Expected: 1000–10000 (key live, TTL=10s, refreshed each tick)
```

**Pass criteria (hard gate 5):** `processing_reaper_lock_miss_total` is non-zero on follower pods, reaper is draining stale `:processing-list` entries on the leader, and broadcast dedup metrics show no spike vs baseline.

### Rollback (if duplicate broadcasts detected)

```bash
# Option A — disable leader lock only (reaper runs unlocked; safe at low pod count)
# Set FF_PROCESSING_REAPER_LEADER_LOCK=false in task-def and redeploy

# Option B — disable BLMOVE branch entirely
# Set FF_QUEUE_BLMOVE_DEQUEUE=false in task-def and redeploy

# Option C — full task-def rollback (same procedure as Fix #6 hard rollback above)
```

---

## Fix #17 — Flip `FF_CROSS_POD_ROOM_REPLAY=true` after 24h+ SADD bake

**What it does:** Enables cross-pod socket replay using Redis `room:members:*` sets. When a pod receives a broadcast for a room it does not hold locally, it reads the set and fans out directly. Requires membership sets to be populated before the flag is on.

**Wrong order = ~95% broadcast loss** (§4.2): flipping before SADD writes are landing means sets are empty → replay misses every user not connected to the receiving pod.

**Minimum bake: 24 h after Phase 2 SADD code deploys** (per `index-20-validated.md` lines 2199, 2725, 2821 — the canonical sequence). Recommended: extend to 48 h (2× the 24 h `room:members:*` TTL) when peak-hour traffic is light, to give one missed-refresh slack window for long-lived sockets. The 24 h floor is the SHIP-READY gate; 48 h is the conservative ceiling.

### Phase 1 — SADD code deployed (Day 0 = Phase 2 deploy at HEAD `0baa7955`)

Phase 2's commit (`0baa7955` — `fix(timer-replay): Phase 2 — #1 + #36 + NEW#1 + NEW#2 + #21 + #17 SADD + #31`) ships the unified `trackRoomMembership(roomKey, userId)` helper at `src/shared/services/socket.service.ts:105-113` invoked from **19 socket.join sites** in the connection / join handler (lines 449, 451, 458, 461, 465, 469, 496, 500, 515, 528, 555, 623, 667, 1086, 1158, 1229, plus 3 emit-paths inside `emitToRoom`/`emitToAllTransporters`/`emitToTransporterDrivers`). Each write applies a 24 h TTL via `EXPIRE`. The Phase 3 reader is gated by `FF_CROSS_POD_ROOM_REPLAY` (referenced at `socket.service.ts:100` and `:2525`) which is **not yet wired to a `process.env` read** at HEAD `0baa7955` — Phase 3's PR introduces the consumer.

```bash
# Verify SADD writes are landing in deployed code (count includes helper + emit-fn writes).
git -C /Users/nitishbhardwaj/Downloads/weelo-backend show 0baa7955:src/shared/services/socket.service.ts \
  | grep -cE "trackRoomMembership\(|sAdd\(memberSet"
# Expected: ≥ 19 (Phase 2 unified helper at :105-113 + 19 callers + 2 emit-fn explicit writes)

# Confirm sets are populating (within 5 min of deploy)
redis-cli -h <prod-redis-host> -p 6379 --scan --pattern 'room:members:*' | head -20
# Expected: non-empty list of keys

# Sample one active booking room — SCARD must match local pod's adapter room size (within ±2)
redis-cli -h <prod-redis-host> -p 6379 SCARD 'room:members:booking:<active-booking-id>'
# Cross-check: grep booking room size from pod logs or via socket.io admin

# Verify TTL is set (sets without TTL leak forever)
redis-cli -h <prod-redis-host> -p 6379 TTL 'room:members:booking:<active-booking-id>'
# Expected: 86000–86400 (24 h TTL)
```

### Phase 2 — Bake monitoring (Day 0 → Day 1 minimum, Day 2 conservative)

```bash
# Day 0 + 15 min: TTL should bump back toward 86400 each time an emit fires
redis-cli -h <prod-redis-host> -p 6379 TTL 'room:members:transporter:<X>'
# Expected: 86000±200 after a recent broadcast to that room

# Day 1 (24 h check): sample 10 active rooms; all must be populated
for room_key in $(redis-cli -h <prod-redis-host> -p 6379 --scan --pattern 'room:members:booking:*' | head -10); do
  SCARD=$(redis-cli -h <prod-redis-host> -p 6379 SCARD "$room_key")
  TTL=$(redis-cli -h <prod-redis-host> -p 6379 TTL "$room_key")
  echo "$room_key: members=$SCARD ttl=$TTL"
done
# Pass: SCARD > 0 for active rooms, TTL > 43200 (at least 12h remaining)

# Day 1 pre-flip (24 h floor): populated keys must be ≥ 50% of active rooms
TOTAL_KEYS=$(redis-cli -h <prod-redis-host> -p 6379 --scan --pattern 'room:members:*' | wc -l)
echo "Total room:members:* keys = $TOTAL_KEYS"
# If < 50% of expected active rooms: SADD writes are not landing — DO NOT FLIP
```

**Block-flip rule** (§4.2): `populated keys < 50% of active rooms` → SADD writes are not landing → **DO NOT FLIP**. Investigate SADD call sites vs actual socket join paths.

### Phase 3 — Canary flip (Day 1+ after 24h bake passes; Day 2+ recommended)

```bash
# 1. Final pre-flight: confirm membership convergence
#    SCARD of 10 active booking rooms must match pod-local adapter.rooms size (within ±2)
redis-cli -h <prod-redis-host> -p 6379 --scan --pattern 'room:members:booking:*' \
  | xargs -I{} redis-cli -h <prod-redis-host> -p 6379 SCARD {} | sort -n | tail -20

# 2. Canary: flip on 1 ECS task only
#    Pull task-def, set FF_CROSS_POD_ROOM_REPLAY=true, register, update-service with --desired-count 1
#    (or use a separate canary task-def targeting 1 task)

# 3. Watch canary for 1 h:
#    - socket_emit_while_adapter_down_total  — should be near zero (no missed local-pod emits)
#    - broadcast P50/P99                     — no regression vs pre-flip baseline
#    - captain reconnect-replay metrics      — should show replay events if captains reconnect

# 4. Full rollout after 1h green canary
#    Register task-def with FF_CROSS_POD_ROOM_REPLAY=true across all tasks
aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --task-definition "weelobackendtask:${NEW_REVISION}" \
  --region ap-south-1
aws ecs wait services-stable \
  --cluster "$ECS_CLUSTER" \
  --services "$ECS_SERVICE" \
  --region ap-south-1
```

### Rollback

```bash
# Soft rollback — set FF_CROSS_POD_ROOM_REPLAY=false in task-def and redeploy
# The room:members:* sets remain populated (24h TTL sweeps them over time)
# Code reverts to local-pod enumerateRoomUserIds — no data loss

# Hard rollback — full task-def revision revert (same procedure as Fix #6 hard rollback)
```

---

## Flag reference table

| Flag | Default | Effect | Flip condition |
|---|---|---|---|
| `FF_BATCH_QUEUE_DEPTH_GUARD` | false (prod) | Enables depth cap + DLQ overflow | §7C Step 1.3: DLQ alarms OK, drainer running, LLEN < 100 |
| `FF_DLQ_DRAINER_ENABLED` | true (code default) | Leader-elected 30s drainer for `dlq:broadcasts` | Ships ON; only set false to disable entirely |
| `FF_PROCESSING_REAPER_LEADER_LOCK` | true (code default) | Leader-locks BLMOVE processing-reaper per queue | Ships ON with bundle PR; rollback to false if dup broadcasts |
| `FF_QUEUE_BLMOVE_DEQUEUE` | (see feature-flags.ts) | Enables BLMOVE dequeue branch | Ships with bundle PR; rollback to false disables BLMOVE entirely |
| `FF_CROSS_POD_ROOM_REPLAY` | false (Phase 3 ships consumer) | Cross-pod socket replay via room:members:* sets | §7B Wk3 / lines 2199, 2725, 2821: **24h+ SADD bake** (48h conservative) + convergence gate + 1h canary |
| `FF_DLQ_DEPTH_EMITTER_ENABLED` | true | 30s CW PutMetricData sidecar | Ships ON; set false to disable sidecar without touching drainer |
