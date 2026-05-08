# SHIP-READY CHECKLIST — 3-Phase Bundle Roll-Out

**Source authority:** `/Users/nitishbhardwaj/Downloads/index-20-validated.md` §7C (today's executable plan), §7B (Round-6 ship plan), §1.3, §1.4, §1.5, §2.1.1, §4.1, §4.2.

**Repo:** `/Users/nitishbhardwaj/Downloads/weelo-backend`

**Phase commits at audit time (2026-05-09):**

| Phase | Commit SHA | Subject |
|---|---|---|
| Phase 1 — outbox-hardening | `c3808abf` | `fix(outbox-hardening): Phase 1 — B-N-13 + #20 + #37 + #44 + #12 + M-007` |
| Phase 2 — timer-replay | `0baa7955` | `fix(timer-replay): Phase 2 — #1 + #36 + NEW#1 + NEW#2 + #21 + #17 SADD + #31` |
| Phase 3 — broadcast-correctness | (in flight) | `fix(broadcast-correctness): Phase 3 — #23 + #13 + #19c follow-up + NEW#3 + #17 reader + final tests` |

> **DOC-ONLY.** This file is the operator runbook index. No commands here execute automatically. Each step links to the detail runbook that supplies pre-flight checks, exact commands, soak gates, and per-step rollback.

> **Hard rule before flipping ANY flag:** confirm `git -C /Users/nitishbhardwaj/Downloads/weelo-backend rev-parse HEAD` matches the deployed task-def's image SHA. Phase commits are NOT cumulative env-flag changes — each phase ships code; flag flips are separate operator steps.

---

## Phase 1 — Outbox Hardening (deployed at SHA `c3808abf`)

Phase 1 ships the outbox leader-fencing infra and four behavioral-day-one safety fixes. **No env-flag flip is on the operator's critical path at deploy time.** The flag flip (`FF_OUTBOX_LEADER_FENCING=true`) gates the *new* fenced leader-election path; until the flip, the code defaults to the legacy single-key `outbox:leader` path with B-N-13 canonicalization + Fix #20 fail-CLOSED in both branches.

### Phase 1 → Operator steps post-deploy

| # | Step | Runbook |
|---|---|---|
| P1-1 | **(Wk-0 prerequisite)** RDS upgrade `db.t4g.micro → db.r6g.xlarge`. Hard gate: `max_connections ≥ 3000`. | [`rds-upgrade.md`](./rds-upgrade.md) |
| P1-2 | **(Wk-0 prerequisite)** Set `DB_CONNECTION_LIMIT=125` on ECS task-def. Hard gate: deployment status=PRIMARY, runningCount=desiredCount. | [`ecs-db-connection-limit.md`](./ecs-db-connection-limit.md) |
| P1-3 | **(Wk-0 prerequisite)** Apply HPA cap: Min=2 / Max=5 on r6g.xlarge. | [`hpa-cap.md`](./hpa-cap.md) |
| P1-4 | Run M-007 SQL via direct psql (sequence + `claimToken` column + partial index). **Sequence rule:** AFTER Phase 1 deploy stable AND Fix #20 metric flat for 30 min; BEFORE flag flip. | [`m-007-outbox-leader-fencing-sql.md`](./m-007-outbox-leader-fencing-sql.md) |
| P1-5 | Flip `FF_OUTBOX_LEADER_FENCING=true` on canary (1 task), bake 30 min, then full rollout. Monitor `outbox_leader_elections_total{result="acquired"}`. | §4.1 step 5 (no standalone runbook — uses §4.1 sequence) |

**Phase 1 SHIP-READY pass criteria:**

- All 4 prerequisite runbooks (P1-1 → P1-3 → P1-4) complete and verified.
- `FF_OUTBOX_LEADER_FENCING=true` deployed across all tasks; `outbox_leader_election_redis_error_total` flat for 60 min.
- `dispatchedAt` write rate matches pre-flip baseline ±10% (no leadership-flapping signature).

**Phase 1 known limits:**

- M-007 must be re-run if the DB is ever restored from a pre-Phase-1 snapshot. The runbook is idempotent (`CREATE SEQUENCE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX CONCURRENTLY IF NOT EXISTS`).
- Per CLAUDE.md "CRITICAL RULES FOR THIS DB" — never run `prisma migrate deploy`. There is no `_prisma_migrations` table.

---

## Phase 2 — Timer + Replay (deployed at SHA `0baa7955`)

Phase 2 ships seven fixes including the **room-membership SADD writers (Fix #17 Phase 2)**. The Phase 3 reader is gated by `FF_CROSS_POD_ROOM_REPLAY` and does not yet read from `room:members:*` at HEAD `0baa7955`.

> **CRITICAL TIMING — 24 h SADD BAKE CLOCK STARTS AT PHASE 2 DEPLOY.** The clock for flipping `FF_CROSS_POD_ROOM_REPLAY=true` begins at the moment Phase 2 stabilizes, NOT at Phase 3 deploy. If Phase 3 ships ≥24 h after Phase 2, the bake is already satisfied; if <24 h, hold the Phase 3 flag flip until 24 h+ has elapsed since Phase 2 stable. Authority: `index-20-validated.md` lines 2199, 2725, 2821 ("ship SADD code FIRST, bake 24h, THEN flip flag").

### Phase 2 → Operator steps post-deploy

| # | Step | Runbook |
|---|---|---|
| P2-1 | Verify DLQ depth sidecar emitting (`dlq_broadcasts_depth` / `permanent_depth` / `inflight_depth`). Hard gate: `aws cloudwatch list-metrics --namespace Weelo/Backend --metric-name dlq_broadcasts_depth` returns ≥ 1 row. | [`dlq-sidecar-verify.md`](./dlq-sidecar-verify.md) |
| P2-2 | Apply 4 DLQ alarms via `scripts/monitoring/setup-broadcast-p1-alarms.sh` (`-warn` `>100`, `-crit` `>500`, `-saturation` `≥4500`, `-permanent-depth-warn` `>0`). Hard gate: all 4 alarms in `OK` state — NOT `INSUFFICIENT_DATA`. | [`cloudwatch-dlq-alarms.md`](./cloudwatch-dlq-alarms.md) (see GAP NOTES below) |
| P2-3 | Run DLQ drainer pre-flight (5 checks). Hard gate: drainer registered, leader-lock held, depth=0 trending, canary entry drains, `dlq_broadcasts_depth` metric live. | [`dlq-drainer-preflight.md`](./dlq-drainer-preflight.md) |
| P2-4 | Flip `FF_BATCH_QUEUE_DEPTH_GUARD=true` (Fix #6) AND confirm `FF_DLQ_DRAINER_ENABLED=true` (default-on). Soak 30 min. Hard gate 1.3: depth near 0, saturation alarm OK, `pool_wait_seconds` p99 ≤ 50 ms, broadcast latency p99 ±10% baseline. | [`operator-ff-flips.md`](./operator-ff-flips.md) §Fix #6 + [`ff-depth-guard-flip.md`](./ff-depth-guard-flip.md) |
| P2-5 | Verify Fix #16 reaper leader-lock active (`FF_PROCESSING_REAPER_LEADER_LOCK=true` is code-default). No flip needed; verification only. Hard gate 5: `processing_reaper_lock_miss_total` Sum > 0 on followers; broadcast dedup metrics flat vs baseline. | [`reaper-leader-verify.md`](./reaper-leader-verify.md) |
| P2-6 | (Optional, after Fix #6 soak passes) Worker ramp Step 1: `REDIS_QUEUE_WORKERS 1 → 4`. **HAZARD:** never downgrade 16 → 1; ramp is one-way. Soak 1 h. SLO gates: pool wait p99 ≤50ms, RDS CPU ≤70%, RDS conn ≤70%. | [`worker-ramp-step1.md`](./worker-ramp-step1.md) |
| P2-7 | Worker ramp Step 2 (`4 → 8`) and Step 3 (`8 → 16`), each soaking 1 h. | [`worker-ramp-step2-3.md`](./worker-ramp-step2-3.md) + [`worker-ramp-soak-dashboard.md`](./worker-ramp-soak-dashboard.md) |
| P2-8 | **Start the 24 h SADD bake clock NOW** (clock-stamp = `services-stable` timestamp post-Phase 2 deploy). Sample `room:members:*` keys hourly; SCARD must converge with local pod adapter room size (±2). | [`operator-ff-flips.md`](./operator-ff-flips.md) §Fix #17 Phase 1 + Phase 2 |

**Phase 2 SHIP-READY pass criteria:**

- DLQ depth alarms OK for ≥ 1 h continuous after `FF_BATCH_QUEUE_DEPTH_GUARD=true` flip.
- `processing_reaper_lock_miss_total` non-zero on follower pods (Fix #16 leader-lock active).
- `room:members:*` SCARD vs local-pod adapter convergence within ±2 for ≥ 50% of sampled active rooms.
- (Optional, if worker ramp run) `REDIS_QUEUE_WORKERS=16` soak green for 1 h continuous; RDS connections ≤2,240.

**GAP NOTES on Phase 2 alarms** *(must be reconciled before P2-2)*:

- `cloudwatch-dlq-alarms.md` documents alarms named `weelo-dlq-broadcasts-depth-high` (`≥1000` / 10 m), `weelo-dlq-drainer-last-success-age`, `weelo-dlq-drainer-leader-lock-missing` (composite), `weelo-dlq-drainer-error-rate`. The actual deployed setup script (`scripts/monitoring/setup-broadcast-p1-alarms.sh` at HEAD `0baa7955`) creates four DIFFERENT alarms: `weelo-dlq-broadcasts-depth-warn` (`>100`/2m), `-crit` (`>500`/5m), `-saturation` (`≥4500`/1m), `-permanent-depth-warn` (`>0`/5m). **Operators should run the setup script first** (those names are what the §1.3 hard gate references). The `-high`, `-last-success-age`, `-leader-lock-missing`, `-error-rate` alarms in `cloudwatch-dlq-alarms.md` are an *additive optional layer* the operator may add separately — but two metrics they reference (`dlq_drainer_last_success_ts`, `dlq_drainer_errors_total`) **do not exist in code at HEAD `0baa7955`**. Either (a) skip those two alarms until the metrics are added in a future commit, or (b) implement the Lambda-derived `dlq_drainer_staleness_seconds` fallback documented inside `cloudwatch-dlq-alarms.md` as an alternative.
- The drainer at `scripts/replay-broadcast-dlq.ts` emits `broadcast_dlq_depth` (line 150) and `broadcast_dlq_replayed_total` / `broadcast_dlq_replay_failed_total`. The sidecar at `dlq-broadcasts-depth-emitter.ts` emits `dlq_broadcasts_depth`. Alarms target the sidecar's name. This is correct; it surfaces a naming-drift trap but is not a bug.

---

## Phase 3 — Broadcast Correctness + #17 Reader Flip (in flight)

Phase 3 ships the remaining correctness fixes (#23 skip-emit, #13 dead-code delete, #19c drainer DLQ semantic, NEW#3 FCM phantom-key, #31 atomic Lua sweep) and **introduces the consumer side of `FF_CROSS_POD_ROOM_REPLAY`**. The flag is the single shippable lever in this phase that gates a behavior change.

### Phase 3 → Operator steps post-deploy

| # | Step | Runbook |
|---|---|---|
| P3-1 | Verify Phase 3 deploy is healthy. ECS service stable, task health passing, `tsc --noEmit` was green pre-merge. No flag flip required for #23/#13/#19c-followup/NEW#3/#31 — these are correctness-day-one. | (no standalone runbook — `services-stable` + smoke check) |
| P3-2 | **24 h SADD BAKE GATE** — confirm clock since Phase 2 deploy is ≥ 24 h. Sample 10 active `room:members:booking:*` keys: SCARD must match local-pod adapter room size (±2). If <50% of sampled rooms are populated → SADD writes not landing → **DO NOT FLIP**. | [`operator-ff-flips.md`](./operator-ff-flips.md) §Fix #17 Phase 2 |
| P3-3 | Canary flip `FF_CROSS_POD_ROOM_REPLAY=true` on 1 ECS task. Watch 1 h: `socket_emit_while_adapter_down_total` near zero, broadcast P50/P99 no regression, captain reconnect-replay metrics show replay events on disconnect. | [`operator-ff-flips.md`](./operator-ff-flips.md) §Fix #17 Phase 3 |
| P3-4 | After canary 1 h green, full rollout: register task-def with `FF_CROSS_POD_ROOM_REPLAY=true` across all tasks, deploy, `services-stable`. Continue monitoring 1 h. | [`operator-ff-flips.md`](./operator-ff-flips.md) §Fix #17 Phase 3 |

**Phase 3 SHIP-READY pass criteria:**

- ≥ 24 h has elapsed since Phase 2 deploy (`0baa7955`) `services-stable` timestamp. (48 h conservative.)
- `room:members:*` populated key count ≥ 50% of expected active rooms; sampled SCARD convergence within ±2.
- Canary task with `FF_CROSS_POD_ROOM_REPLAY=true` ran 1 h green: no broadcast P99 regression, no `socket_emit_while_adapter_down_total` spike.
- Full-rollout 1 h post-flip: broadcast delivery rate matches pre-flip baseline ±5%.

---

## Final SHIP-READY Gate Criteria

The bundle is **SHIP-READY** when all the following are simultaneously true:

| # | Gate | Verification |
|---|---|---|
| 1 | Phase 1, 2, 3 commits all deployed | `aws ecs describe-task-definition` image SHA matches Phase 3 commit; `aws ecs describe-services` shows deployment `status=PRIMARY`, `runningCount == desiredCount`. |
| 2 | All Wk-0 prerequisites complete | RDS `db.r6g.xlarge` available; `DB_CONNECTION_LIMIT=125` in env; HPA Min=2/Max=5 registered. |
| 3 | M-007 SQL applied | psql `\d "OrderDispatchOutbox"` shows `claimToken bigint`; sequence `outbox_fence_seq` exists; partial index `idx_odoutbox_unprocessed_fence` is `is_valid=true`. |
| 4 | `FF_OUTBOX_LEADER_FENCING=true` flipped | Task-def env shows the value; `outbox_leader_election_redis_error_total` flat for ≥ 60 min. |
| 5 | `FF_BATCH_QUEUE_DEPTH_GUARD=true` flipped | DLQ `-saturation` alarm OK for ≥ 60 min; `dlq_broadcasts_depth` near 0 at current load. |
| 6 | Fix #16 reaper leader-lock active | `processing_reaper_lock_miss_total` non-zero on followers; broadcast dedup metrics flat. |
| 7 | `FF_CROSS_POD_ROOM_REPLAY=true` flipped post-bake | Phase 2 → Phase 3 flip clock ≥ 24 h; canary 1 h green; full-rollout 1 h green. |
| 8 | (Optional) Worker ramp at `REDIS_QUEUE_WORKERS=16` | All three SLO gates green for ≥ 1 h continuous; RDS connections ≤ 2,240 (70% of 3,201). |
| 9 | All `weelo-` CloudWatch alarms in `OK` | `aws cloudwatch describe-alarms --alarm-name-prefix weelo- --state-value ALARM` returns `[]` for ≥ 60 min. |
| 10 | No P1/P2 incidents open | Operations log clean; no rollback levers pulled in last 60 min. |

When all 10 are green simultaneously, log the timestamp + Phase 3 commit SHA + ECS task-def revision in the deployment journal. The bundle is SHIP-READY.

---

## Rollback Decision Tree

Use the lowest-blast-radius rollback that resolves the symptom. Escalate only if the lower-impact rollback fails to clear the alarm.

### Tree A — `FF_BATCH_QUEUE_DEPTH_GUARD` flip went bad (Phase 2 P2-4)

```
Symptom: dlq:broadcasts saturation alarm fires, OR pool_wait p99 > 100 ms, OR broadcast p99 > 2× baseline
│
├─ FIRST: set FF_BATCH_QUEUE_DEPTH_GUARD=false in task-def, redeploy
│        → Drainer continues (FF_DLQ_DRAINER_ENABLED=true is independent)
│        → In-flight DLQ entries drain over next ~5 min at 30 s drainer interval
│        → If saturation clears within 10 min: STOP. Diagnose offline.
│
├─ IF still saturated: set FF_DLQ_DRAINER_ENABLED=false to stop further DLQ growth
│        (LRANGE dlq:broadcasts 0 9 to inspect; manual LREM if a poison pill)
│
└─ LAST RESORT: revert task-def to PREV_REVISION (full env rollback)
         (Documented in operator-ff-flips.md §Fix #6 "Hard rollback")
```

### Tree B — `FF_PROCESSING_REAPER_LEADER_LOCK` causing duplicate broadcasts (Phase 2 P2-5)

```
Symptom: broadcast_dispatched_total spikes 2-6× pre-deploy baseline
│
├─ Option A: FF_PROCESSING_REAPER_LEADER_LOCK=false
│        → Reaper runs unlocked. Safe at pod count ≤ 2 (e.g. early ramp).
│        → Risky at HPA Max=5 (8-10 dup broadcasts/sec at 400-500 RPS per §1.3)
│
├─ Option B: FF_QUEUE_BLMOVE_DEQUEUE=false
│        → Disables the BLMOVE branch entirely; reverts to legacy BRPOP
│        → No reaper runs; recoverStaleProcessingJobs sweeps at next boot
│
└─ Option C: Full task-def revert
         (Documented in reaper-leader-verify.md §Rollback Option C)
```

### Tree C — `FF_OUTBOX_LEADER_FENCING` causing leadership flapping (Phase 1 P1-5)

```
Symptom: outbox_leader_election_redis_error_total spikes; dispatchedAt rate diverges from baseline
│
├─ FIRST: FF_OUTBOX_LEADER_FENCING=false in task-def, redeploy
│        → Reverts to legacy single-key outbox:leader path (B-N-13 canonicalized + Fix #20 fail-CLOSED active in BOTH branches)
│        → Re-flip clock: bake fix in lower env first
│
└─ IF column read errors appear: M-007 schema rollback
         (Documented in m-007-outbox-leader-fencing-sql.md §Rollback)
         BUT: flag MUST be off ≥ 1 min before column drop (live code reads claimToken when flag is on)
```

### Tree D — `FF_CROSS_POD_ROOM_REPLAY` causing missed broadcasts (Phase 3 P3-3 / P3-4)

```
Symptom: ~95% broadcast loss observed (per §4.2 hazard); user reports of missed updates
│
├─ FIRST: FF_CROSS_POD_ROOM_REPLAY=false in task-def, redeploy
│        → Reverts to local-pod enumerateRoomUserIds path
│        → No data loss; room:members:* sets remain populated (24 h TTL sweeps over time)
│
└─ Re-flip clock: bake another 24 h+ minimum, sample wider room set, re-canary
         (Documented in operator-ff-flips.md §Fix #17 §Rollback)
```

### Tree E — Worker ramp gate breach (Phase 2 P2-6 / P2-7)

```
Symptom: pool_wait p99 > 50 ms, OR RDS CPU > 70%, OR RDS connections > 70% of max_connections
│
├─ Roll back ONE STEP only — never to baseline:
│   - Step 3 (16) breach → roll back to 8
│   - Step 2 (8) breach → roll back to 4
│   - Step 1 (4) breach → escalate to incident command before rollback
│
└─ HAZARD: NEVER deploy REDIS_QUEUE_WORKERS=1 from a live state ≥ 4
         → 16× drain collapse, all in-flight jobs pile on a single worker
         (Documented in worker-ramp-step1.md §HAZARD + worker-ramp-step2-3.md §HAZARD)
```

### Tree F — Catastrophic incident (any phase) — full task-def revert

```
Use ONLY if Trees A–E fail to clear the alarm within 10 min, or a P1 alarm fires that
no per-flag rollback can address.
│
└─ aws ecs update-service --task-definition weelobackendtask:${PREV_REVISION} --force-new-deployment
         → Reverts ALL flags + image SHA simultaneously
         → ECS performs rolling task replacement (~3-5 min)
         → After services-stable: file post-mortem, do NOT re-attempt forward deploy
            without root-cause review and signed-off remediation plan
```

---

## Cross-References to Detail Runbooks

| Runbook | Covers | Lines covered |
|---|---|---|
| [`rds-upgrade.md`](./rds-upgrade.md) | Wk-0 RDS class change with snapshot + verify | All Phase 1 prereq |
| [`ecs-db-connection-limit.md`](./ecs-db-connection-limit.md) | `DB_CONNECTION_LIMIT=125` in task-def | All Phase 1 prereq |
| [`hpa-cap.md`](./hpa-cap.md) | `MaxCapacity=5` on r6g.xlarge | All Phase 1 prereq |
| [`m-007-outbox-leader-fencing-sql.md`](./m-007-outbox-leader-fencing-sql.md) | Direct psql sequence + column + index | Phase 1 P1-4 |
| [`dlq-sidecar-verify.md`](./dlq-sidecar-verify.md) | Verify CloudWatch metrics emitting | Phase 2 P2-1 |
| [`cloudwatch-dlq-alarms.md`](./cloudwatch-dlq-alarms.md) | Optional supplementary alarms (see GAP NOTES) | Phase 2 P2-2 supplementary |
| [`dlq-drainer-preflight.md`](./dlq-drainer-preflight.md) | 5 pre-flight checks before depth-guard flip | Phase 2 P2-3 |
| [`ff-depth-guard-flip.md`](./ff-depth-guard-flip.md) | Standalone Fix #6 flip (mirrors operator-ff-flips.md §Fix #6) | Phase 2 P2-4 |
| [`operator-ff-flips.md`](./operator-ff-flips.md) | All 3 flag flips (Fix #6, Fix #16, Fix #17) | Phase 1, 2, 3 |
| [`reaper-leader-verify.md`](./reaper-leader-verify.md) | Fix #16 leader-lock post-deploy verify | Phase 2 P2-5 |
| [`worker-ramp-step1.md`](./worker-ramp-step1.md) | `REDIS_QUEUE_WORKERS 1 → 4` | Phase 2 P2-6 |
| [`worker-ramp-step2-3.md`](./worker-ramp-step2-3.md) | `4 → 8 → 16` | Phase 2 P2-7 |
| [`worker-ramp-soak-dashboard.md`](./worker-ramp-soak-dashboard.md) | CloudWatch dashboard JSON for soak | Phase 2 P2-6/7 |
| [`SKIP_DECISIONS.md`](./SKIP_DECISIONS.md) | Permanent drops (Fix #4, #25, #8) — not part of this checklist | (reference only) |

---

## Audit Notes (Lapis, 2026-05-09)

**Edits made to existing runbooks:**

- `operator-ff-flips.md` §Fix #17 — corrected SADD-bake duration: source-of-truth `index-20-validated.md` lines 2199, 2725, 2821 mandate **24 h+** as the floor, with 48 h appearing only once in §4.2's summary table as a conservative ceiling. Updated runbook to lead with 24 h floor / 48 h conservative recommendation. Updated stale grep claim ("13 SADD write sites") to reflect Phase 2's actual 19-site unified `trackRoomMembership()` helper at `socket.service.ts:105-113`. Updated Phase 2/3 day labels accordingly.

**Identified gaps not edited (operational discretion required):**

1. `cloudwatch-dlq-alarms.md` documents 4 alarm names that do not match the 4 alarms produced by `scripts/monitoring/setup-broadcast-p1-alarms.sh`. Two of the alarms in the doc target metrics (`dlq_drainer_last_success_ts`, `dlq_drainer_errors_total`) that **do not exist in code at HEAD `0baa7955`**. Documented in this file's GAP NOTES under Phase 2 P2-2. Reconciliation requires either: (a) flagging the doc as supplementary-optional (recommended), (b) adding the missing metrics in a Phase 3 follow-up, or (c) implementing the Lambda-derived `dlq_drainer_staleness_seconds` fallback already documented inside `cloudwatch-dlq-alarms.md`.
2. `dlq-drainer-preflight.md` Check 5 references `dlq_broadcasts_depth` (correct — emitted by sidecar). The drainer's own gauge name is `broadcast_dlq_depth` (without underscore). Both are real; alarms target the former. No action required, but operators should not be confused by `aws cloudwatch list-metrics` showing two names.
3. `ff-depth-guard-flip.md` and `operator-ff-flips.md` §Fix #6 are near-duplicates. The standalone file is fine for operators who want a single-page card; the consolidated file is preferred for the bundle context. No edit — both are valid.

**No edits made to:**

- `m-007-outbox-leader-fencing-sql.md` — complete with all four post-run checks, idempotent SQL, and a documented rollback path that respects flag-off-before-column-drop sequence. PASS.
- `rds-upgrade.md` / `ecs-db-connection-limit.md` / `hpa-cap.md` — pre-flight, exec, verify, rollback all present and matched to source-of-truth §7C 0.3, 0.4, 0.5. PASS.
- `worker-ramp-*.md` — three runbooks form a coherent ladder with explicit one-step-back rollback rule. PASS.
- `dlq-sidecar-verify.md` — verification cmds, expected log cadence, failure-mode table all present. PASS.
- `dlq-drainer-preflight.md` — 5 checks + canary inject + cleanup. PASS.
- `reaper-leader-verify.md` — 4 verification steps + 3-tier rollback. PASS.
- `SKIP_DECISIONS.md` — out of scope for this audit (covers DROPs, not ship items).
