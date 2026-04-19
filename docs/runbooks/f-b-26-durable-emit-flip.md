# F-B-26 Durable Emit Flag Flip — Readiness Runbook (W2-2)

**Flag:** `FF_DURABLE_EMIT_ENABLED` — `src/shared/config/feature-flags.ts:245-249`
**Category:** `release` (implicit default = OFF) — `feature-flags.ts:373-384`
**Ships:** Phase 3 commits `c44bac1`, `2ca3c8e`. Currently OFF everywhere.

When ON, `LIFECYCLE_EMIT_EVENTS` (`socket.service.ts:1597-1628`) write a JSON envelope to `socket:unacked:{userId}` ZSET keyed by `socket:seq:{userId}` before fan-out (`socket.service.ts:1649-1685`). Envelope TTL = 600s (`DURABLE_EMIT_TTL_SECONDS`, `socket.service.ts:1633`). On reconnect with `auth.lastSeq`, replay handler (`socket.service.ts:1293-1326`) drains; `broadcast_ack` prunes by score (`:1329-1342`).

---

## 1. Pre-flip gate (14-day staging soak)

### 1.1 Observability gap — READ FIRST

Plan (`.planning/phase3-to-100-plan.md:752`) cites `socket_durable_emit_sent_total` / `socket_durable_emit_acked_total` — **these counters DO NOT exist** in `src/shared/monitoring/metrics-definitions.ts`. `durableEmit()` (`socket.service.ts:1649`) and `persistRoomEnvelopes()` (`:1716`) have no metric increments. Available emit-path counters are `broadcast_delivery_delivered{channel}`, `broadcast_delivery_failed{channel,reason}` (`queue.service.ts:1255,1291`), `socket_adapter_failure_total` (`socket.service.ts:1502`). Soak signal is primarily structured log + Redis keyspace probe. Register the missing counters in a Phase-4 prep commit before flipping.

### 1.2 Signals to watch

| Signal | Source | Healthy | Abort |
|---|---|---|---|
| `[durableEmit] ZSET write failed` warns | CloudWatch `weelobackendtask` (`socket.service.ts:1669,1733`) | ≤ 0.1%/min | ≥ 1% for 10m |
| `[durableEmit] Emit failed, circuit breaker recording` | CloudWatch (`:1679`) | 0 new/min | > 5/min sustained |
| `[Phase4] Replaying N unacked` | CloudWatch (`:1305`) | N ≤ 50 typical | N > 500 any user |
| `broadcast_delivery_failed{reason}` delta | Prometheus | Flat vs baseline | +25% sustained 1h |
| `socket_adapter_failure_total` delta | Prometheus | Flat | Rising |
| `KEYS socket:unacked:*` count | `redis-cli --scan --pattern 'socket:unacked:*' \| wc -l` | ≤ concurrent-user count | Unbounded 24h growth |
| `MEMORY USAGE socket:unacked:{any}` | `redis-cli MEMORY USAGE` | ≤ 50KB/user | ≥ 1MB/user |
| ACK/replay ratio | replay lines ÷ ZADDs | ≥ 0.999 (plan `:752`) | < 0.99 for 1h |

### 1.3 CloudWatch Insights queries

```
# p99 replay backlog
fields @timestamp, @message
| filter @message like /\[Phase4\] Replaying/
| parse @message /Replaying (?<n>\d+) unacked/
| stats pct(n, 99) by bin(5m)

# ZSET write failure rate
fields @timestamp, @message
| filter @message like /\[durableEmit\] ZSET write failed/
| stats count() as failures by bin(1m)
```

### 1.4 Abort signals (any = ROLLBACK)

ZSET warn ≥ 1%/min × 10min → Redis health. `broadcast_delivery_failed` +25% × 1h → fan-out regression. Unbounded `socket:unacked:*` > 24h → TTL/ACK broken. p99 replay > 500 → investigate ACK handler (`socket.service.ts:1329`).

### 1.5 Co-dependency check

`broadcast.processor.ts:203-221` still uses separate `FF_SEQUENCE_DELIVERY_ENABLED` flag writing to the same `socket:unacked:{userId}` key. Before flip, confirm no duplicate seq numbers in a staging sample.

---

## 2. Flip procedure

### 2.1 Staging (T−14d)

1. Add `FF_DURABLE_EMIT_ENABLED=true` to staging ECS task def. (Also add to `.env.example` — currently missing.)
2. `aws ecs update-service --cluster weelo-staging --service backend --force-new-deployment`.
3. Soak 14 days. GO/NO-GO check at D+3, D+7, D+14 per §1.2.

### 2.2 Prod (T0, after staging GO)

**Rollout model:** ECS rolling deploy only. `isEnabled()` is a binary `process.env` check (`feature-flags.ts:373-384`) — percentage-based rollout NOT supported without a userId-hash sampler. Do NOT attempt partial rollout.

Single rolling deploy off-peak (02:00 IST), 1 task at a time, 15-min watch between batches:

1. Announce `#ops-release`: "F-B-26 flip T0+15m window".
2. Update prod task def: `FF_DURABLE_EMIT_ENABLED=true`.
3. `aws ecs update-service --cluster weelo-prod --service backend --force-new-deployment --deployment-configuration maximumPercent=150,minimumHealthyPercent=100`.
4. Side-by-side CloudWatch Insights (§1.3) + ECS deployment events.
5. After 30 min all-green (§4), announce done.

---

## 3. Rollback (< 2 min)

**Triggers:** any §1.4 signal, prod-facing error spike, sustained warn rate.

```bash
aws ecs describe-task-definition --task-definition weelo-backend \
  | jq '.taskDefinition.containerDefinitions[0].environment |= map(
        if .name == "FF_DURABLE_EMIT_ENABLED" then .value = "false" else . end)' \
  > /tmp/rb-taskdef.json
aws ecs register-task-definition --cli-input-json file:///tmp/rb-taskdef.json
aws ecs update-service --cluster weelo-prod --service backend --force-new-deployment
```

Fallback path = pre-Phase-3 behavior (global `_seq` stamp, no ZADD) — `socket.service.ts:1843-1853`. Existing `socket:unacked:*` keys TTL out ≤600s; no manual cleanup.

---

## 4. Post-flip validation (first 30 min)

1. **No new warn spike** — CloudWatch 10-min window: zero new `[durableEmit] ZSET write failed` / `Emit failed` beyond baseline.
2. **ZADD activity visible** — `redis-cli --scan --pattern 'socket:seq:*' | wc -l` must increase from pre-flip baseline.
3. **Reconnect replay working** — force captain app reconnect (airplane toggle); verify `[Phase4] Replaying N unacked messages` with N ≥ 1 for a test user who received events during disconnect.
4. **ACK pruning working** — after replay, `redis-cli ZCARD socket:unacked:{testUserId}` drops to 0 within 60s (handler `socket.service.ts:1329-1342`).
5. **No unacked-set balloon** — `KEYS socket:unacked:*` count within ±10% of `getConnectedUserCount()` (`socket.service.ts:1934`).
6. **Delivery counters steady** — `broadcast_delivery_delivered{channel=socket}` rate unchanged vs pre-flip 30-min baseline.

Any step fails → rollback §3.

---

## 5. Open questions for the operator

1. **Register missing counters first?** `socket_durable_emit_sent_total` / `_acked_total` / `_failed_total` do not exist. Current observability is log-only. Recommend: ship counters in a Phase-4 prep commit before flipping.
2. **`.env.example` gap** — flag is undocumented (unlike `REDIS_MAXMEMORY_POLICY` at `.env.example:344`). Add entry before operators are expected to flip it.
3. **Redis eviction policy** — confirm prod Redis has `maxmemory-policy noeviction` (`redis-eviction-assertion.ts:49`). `allkeys-lru` would evict unacked envelopes mid-flight and defeat the fix.
4. **Dual ZADD conflict** — `FF_SEQUENCE_DELIVERY_ENABLED` (`broadcast.processor.ts:203`) writes same keys. Stays ON alongside F-B-26, or deprecate after flip?
5. **Room-emit coverage gap** — `enumerateRoomUserIds()` (`socket.service.ts:1698-1708`) only persists for LOCAL room members. Cross-instance users in the same room get live emit via Redis adapter but unacked ZSET is not populated on the emitting instance. Acceptable for 2-instance prod or must be closed first?
6. **Canary not possible today** — partial rollout needs a sampler wrapper over `isEnabled()`. Ship in Phase 4 if future release flags need canary.

---

**Status:** DOCUMENTATION ONLY — do not merge env changes from this runbook.
**Next gate:** 14-day staging soak kickoff + counter-registration prep PR.
