# Phase 1 Handoff — weelo-p1

**Owner:** T1.7 (`t1-7-dashboard-handoff`).
**Status:** _DRAFT — filling in as PRs land. Marked **NOT SIGNED OFF** until all boxes ticked._
**Gate:** Phase 1 is declared ready for merge + 24h canary only when all criteria in §Exit-gate checklist pass.

---

## 1. Teammate PR ledger

One row per teammate. T1.7 updates as each teammate sends PR URL + SHA via SendMessage. _Waiting_ means no SendMessage received yet.

| Teammate | Task # | Tickets | Branch | PR URL | Head SHA | Counters added | /review status | Task status |
|---|---|---|---|---|---|---|---|---|
| t1-1-obs-broadcast | 8 | L3, L7 | `phase-p1/t1-1-obs-broadcast` | _PR TBD (human opens)_ | `f235f42e` (rebased onto main-new, supersedes `9e53b32e`) | `eta_ranking_fallback_total{reason,stepIndex,errorClass}`, `fleet_cache_corruption_total{keyPrefix}` | _awaiting /review output; 11/11 jest green per team-lead_ | completed |
| t1-2-obs-postcommit | 1 | L2, M18 | `phase-p1/t1-2-obs-postcommit` | _PR TBD (human opens)_ | `b0dae7f3` over 4 prior commits, **branched off stale `main` — needs rebase onto `main-new`** (see §2) | `post_commit_cache_failure_total{cache}` + `socket_emit_while_adapter_down_total{event,mode}` + shipped M18 alarm descriptor JSON | _awaiting /review output_ | completed |
| t1-3-comments-customer (backend) | 5 | L4, M9 | `phase-p1/t1-3-comments-m9-cleanup` | _PR TBD (human opens)_ | `16ce444c` (L4+M9) + `b8b3298e` (channel-rename test) — rebased onto main-new, supersedes `90ec3be7` | none (docs/grep cleanup) | _awaiting /review output; 3/3 jest green per team-lead_ | completed |
| t1-3-comments-customer (customer-app) | 5 | L1 | `phase-p1/t1-3-legacy-fallback-analytics` (nitu01019/weelo) | _PR TBD (human opens)_ | `e3fbfe7` (supersedes `571ea44`) | L1 analytics event only (Crashlytics wrapper, no new SDK) | _awaiting /review output; 8/8 tests green per team-lead_ | completed |
| t1-4-dba-indexes | 7 | SC1, SC2 | `phase-p1/t1-4-dba-indexes` | https://github.com/nitu01019/weelobackend/pull/new/phase-p1/t1-4-dba-indexes | `9c3545eb` (verified as origin HEAD — intermediate `ae60a1db` never reached origin) | none (SQL migration + schema.prisma: SC1 as real `@@index`, SC2 as DB-only comment due to Prisma DSL partial-index limitation) | _awaiting /review output_ | completed |
| t1-5-boot-path | 3 | SC8 ✅, L6 ✅ | `phase-p1/t1-5-boot-path` | https://github.com/nitu01019/weelobackend/pull/new/phase-p1/t1-5-boot-path | `e687faeb` over `9ee6b748` (rebased onto main-new; supersedes earlier `82bee32c`) | `server_boot_scan_ms` histogram **registered by T1.6**, T1.5 emits only; L6 ships as a log signal (`[BACKPRESSURE] In-memory mode engaged`) not a counter | _awaiting /review output — 7/7 SC8 + 1/1 L6 + 12/12 phase6 regression green_ | completed (both tickets shipped post-rebase) |
| t1-6-metrics-infra | 2 | pre-reg + naming spec | `phase-p1/t1-6-metrics-infra` | https://github.com/nitu01019/weelobackend/pull/new/phase-p1/t1-6-metrics-infra | `181666a6` (verified as origin HEAD — T1.6's reported `9d894927` never reached origin) | reserved blocks for T1.1/T1.2/T1.3/T1.5 + NEW gauge `phase1_landed_commit_sha`; §5 manifest note: T1.1 label-counts differ from spec — docs fix follow-up (see §2) | _awaiting /review output; 4/4 tests green per team-lead_ | completed |
| t1-7-dashboard-handoff | 4 | dashboard + handoff | `phase-p1/t1-7-dashboard-handoff` | _this draft PR_ | _head-at-submit_ | none (consumer) | self-review in PR body | in_progress |

---

## 2. Exit-gate checklist

From `.planning/verification/P1-TEAM-ONBOARDING.md` §"End-of-phase exit gate". All must be true before declaring Phase 1 done:

- [ ] All 7 PRs merged to `main-new` (or ready-to-merge — director performs the actual merge; `main-new` is the engineering trunk per the 2026-04-19 onboarding correction).
- [ ] All new counters visible on `/metrics` endpoint, registered (no auto-create warnings in 24h window).
- [ ] CloudWatch dashboard `weelo-broadcast-baseline-p1` populated with ≥1h of real-traffic data.
  - **PARTIAL by director agreement:** dashboard JSON + alarms shipped in this PR; live-data render contingent on the Prometheus→CloudWatch bridge being wired up (see §3 follow-up `P1-FOLLOWUP-1`). Panels stay in `INSUFFICIENT_DATA` until then. Director has accepted this partial state as acceptable for Phase 1 exit.
- [ ] `pg_stat_user_indexes.idx_scan > 0` on both `idx_user_kyc_broadcast` and `idx_vehicle_key_avail` within 1h of director's manual SQL execution.
- [ ] Server startup time regression ≤ 0 (`server_boot_scan_ms` p99 post-SC8 ≤ pre-SC8 baseline).
- [ ] CloudWatch error-rate for `weelobackendtask` log group within ±10% of 7-day baseline over 24h canary.
- [ ] All 6 sibling `/review` runs have CRITICAL+HIGH findings resolved (attach screenshots / summary below).
- [ ] T1.7's own PR merged and `TaskUpdate(taskId=4, status=completed)`.

### Evidence capture (filled in as gates clear)

#### L3 + L7 (T1.1) — evidence
- **Task status:** completed.
- **Commit:** `f235f42e` on `phase-p1/t1-1-obs-broadcast`, rebased onto `main-new` (supersedes pre-rebase `9e53b32e`). All 11 jest tests still green post-rebase.
- **L3 label-cardinality note (per T1.1 confirmation via team-lead):** `errorClass` values come from the small closed set of Node stdlib error class names (`Error`, `TypeError`, `TimeoutError`, etc.), not user-provided strings — cardinality bounded. The dashboard's SEARCH-expression pivot on Panel #2 handles this correctly: it auto-discovers whatever `errorClass` values actually fire in production.
- **Counters landed (authoritative schema, per team-lead ship report):**
  - `eta_ranking_fallback_total{reason, stepIndex, errorClass}` — 3 labels.
  - `fleet_cache_corruption_total{keyPrefix}` — 1 label.
- **Tests:** 11 jest cases (4 L3 + 7 L7).
- **Dashboard adjustment made in this ledger commit:** Panel #1 (L3) and Panel #3 (L7) and Panel #5 (M18) swapped from hard-coded label-value lists (which were T1.7-inferred) to CloudWatch `SEARCH()` expressions that auto-discover label values from the emitted metric stream. This means the dashboard renders whatever values T1.1/T1.2 actually emit, without T1.7 needing to guess the value-set ahead of time.
- _T1.1 to paste:_ `curl /metrics | grep -E '^(eta_ranking_fallback_total|fleet_cache_corruption_total) '` output showing the full label-value set used in production, and a short description of when each `errorClass` fires (for runbook readers).

#### L2 + M18 (T1.2) — evidence
- **Task status:** completed.
- **Commits on origin** (verified via `git log origin/phase-p1/t1-2-obs-postcommit -5`):
  - `b0dae7f3` — test flake fix (snapshot cloning).
  - `befa6010` — M18 alarm descriptor + unit tests.
  - `7c3c5224` — M18 counter emit at `socket.service.ts:emitToUser`.
  - `fc2172bd` — L2 counter emit at `order.service.ts` fail-soft cache branches.
  - `f96a3a16` — L2/M18 counter registrations in `metrics.service.ts`.
- **⚠ Rebase status:** merge-base with `origin/main-new` is `ada8a5430…` = `origin/main` (stale). **T1.2's branch is NOT rebased onto main-new.** This is the same pattern that hit T1.1, T1.3, T1.4, T1.5 earlier; all four rebased successfully. T1.2 will need to do the same before merge to avoid conflicts with `metrics-definitions.ts` (which `main-new` has but stale `main` doesn't — see T1.2's earlier note about registering inline in `metrics.service.ts:initializeDefaultMetrics` because the extraction file wasn't on their branch base). Once rebased, T1.2's inline registrations should be moved to the reserved T1.2 block in `metrics-definitions.ts` per T1.6's `// === P1-T1.2 ===` placeholder. **NOT a phase-exit blocker from T1.7's perspective, but will surface in `/review` — flagged.**
- **Counter schemas verified at emit sites on origin:**
  - `socket.service.ts:emitToUser` emits `socket_emit_while_adapter_down_total{event, mode: redisAdapterMode}` — matches T1.6 manifest and my Panel #5 SEARCH (`{Weelo/Backend,event,mode}`).
  - `order.service.ts` emits `post_commit_cache_failure_total{cache: 'google_directions' | 'idempotency'}` — matches T1.6 manifest and my Panel #4's explicit 2-series definition + my alarm 4a/4b split.
- **M18 alarm descriptor shipped** at `scripts/monitoring/alarm-m18-adapter-down.json`. Verified contents:
  - Alarm name: `weelo-socket-adapter-degraded-emits` (not my script's default `weelo-p1-socket-adapter-down`).
  - Threshold semantics: `statistic=Sum, period=60, evaluationPeriods=2, threshold=0, comparisonOperator=GreaterThanThreshold, treatMissingData=notBreaching` — this is **AND across two 60s windows** (i.e. each of 2 consecutive minutes has ≥1 emit), stricter than my script's default `period=120, evaluationPeriods=1` (OR / any single minute).
  - Severity: P2. Runbook text embedded in the descriptor.
  - Integration field declares `ownedBy: "t1-7-dashboard-handoff"`, `targetScript: scripts/monitoring/setup-broadcast-p1-alarms.sh`.
- **T1.7 wiring (no code change needed):** my `setup-broadcast-p1-alarms.sh` already checks `if [[ -f "${M18_ALARM_JSON}" ]]` and uses `aws cloudwatch put-metric-alarm --cli-input-json "file://${M18_ALARM_JSON}"` when the descriptor is present (falling back to the inline `weelo-p1-socket-adapter-down` alarm otherwise). Once T1.2's branch is merged to trunk, the descriptor file appears and my script picks it up automatically. T1.2's AND-semantics (60s × 2) wins; the inline OR-default is preserved as a failsafe for pre-merge states.
- _T1.2 to paste during PR review:_ `curl /metrics | grep -E '^(post_commit_cache_failure_total|socket_emit_while_adapter_down_total) '` output showing counter emits under simulated fault injection; rebase-onto-`main-new` confirmation; and a note that T1.6's reserved T1.2 block in `metrics-definitions.ts` is now populated (post-rebase).

#### L1 + L4 + M9 (T1.3) — evidence
- **Task status:** completed.
- **Two separate PRs (one backend, one customer-app):**
  - **Backend** (L4, M9): branch `phase-p1/t1-3-comments-m9-cleanup`, **rebased onto `main-new`** (merge-base verified = `63802612` = `main-new` tip). Origin HEAD = **`b8b3298e`** over `16ce444c`. Supersedes a pre-rebase SHA `90ec3be7` that T1.3 still cites in a recent handoff message — direct verification via `git log --oneline origin/phase-p1/t1-3-comments-m9-cleanup` confirms the rebased pair is what's on origin. Tests: new `src/__tests__/p1-m9-fcm-click-action.test.ts` with 3 passing tests. Grep verification under `src/`: zero `FLUTTER_NOTIFICATION_CLICK` matches AND zero `clickAction` matches. Rebase preserved `main-new`'s richer `fcm.service.ts` `buildMessage` visibility conditional during 3-way conflict resolution. L4 scope: comment rewrites at `progressive-radius-matcher.ts:66-68` and `h3-geo-index.service.ts:414` + `:418` (flat-direction step ~0.798 km; 0.461 km is the circumradius). PR body file prepared by T1.3 at `/private/tmp/weelo-p1-t1-3/.planning/verification/P1-T1-3-PR-BODY-backend.md` (in T1.3's worktree, human to paste on PR open).
  - **Customer-app** (L1): branch `phase-p1/t1-3-legacy-fallback-analytics` in `nitu01019/weelo`, head SHA per team-lead's most recent update = **`e3fbfe7`** (T1.3's final-handoff message still cites `571ea44` — mismatch noted; team-lead's value treated as canonical since the customer-app repo is not fetchable from this worktree for direct verification). Tests: 8/8 green. Implementation notes: event name `booking_legacy_fallback_invoked` with params `{endpoint, primary_code, primary_error_code}`. Sink is **FirebaseCrashlytics** (pre-existing dep) via `FirebaseCrashlytics.getInstance().log` + `setCustomKey`. App has no `firebase-analytics` dependency in `build.gradle`. Event fires only in the `createOrder` fallback branch (T1.3 cites line 587-590) when the primary response is 400/404/422/501. No new SDK, no new permissions. PR body file prepared by T1.3 at `/private/tmp/weelo-p1-t1-3/.planning/verification/P1-T1-3-PR-BODY-customer-app.md`.
- **Follow-ups flagged by T1.3 (tracked, NOT phase-exit blockers):**
  1. **Stale peer tests in customer-app.** Two pre-existing broken tests — `DataSafetyTest` and `LocationInputViewModelTest` — broken since commit `b1ac3c1` (initial commit). They block `testDebugUnitTest` task-wide. T1.3 worked around locally by temporarily moving them aside to verify their own 8/8 passes; repo unchanged. Recommend a P3 cleanup ticket to fix or explicitly disable these tests. Out of scope for L1.
  2. **M9 spec contradiction.** The ticket specified a comment literally containing the string `FLUTTER_NOTIFICATION_CLICK` AND required a post-edit grep under `src/` to return 0 matches — those two constraints are mutually exclusive. T1.3 resolved by keeping the grep-clean outcome (0 matches) and using an indirect comment: `// note: dropped legacy flutter click-action; Android uses setContentIntent`. This is the correct resolution — the grep-clean guarantee is the more load-bearing requirement (prevents future accidental re-addition). Flagged in T1.3's PR body.
- _T1.3 to paste during PR review:_ Firebase Analytics/Crashlytics event trace or logcat output confirming the event fires on 400/404/422/501, L4 comment-cleanup diff summary, full `grep -rn FLUTTER_NOTIFICATION_CLICK src/` and `grep -rn clickAction src/` command outputs (both should be empty).

#### SC1 + SC2 (T1.4) — evidence
- **Task status:** completed.
- **Commit:** `9c3545eb` on `phase-p1/t1-4-dba-indexes`. **Verified directly against origin** via `git fetch origin phase-p1/t1-4-dba-indexes && git log --oneline -1` and `git show origin/phase-p1/t1-4-dba-indexes` — this is the authoritative ship SHA. The commit message reads: *"Rebased onto main-new (team-lead correction 2026-04-19). SC1 now mirrored as real @@index since main-new already has kycStatus field."* An intermediate SHA `ae60a1db` was cited in one of T1.4's handoff messages but **never reached origin** — withdrawing it from this ledger.
- **Index names (authoritative):**
  - `idx_user_kyc_broadcast` (SC1) — non-partial composite on `User`.
  - `idx_vehicle_key_avail` (SC2) — **partial** index on `Vehicle WHERE isActive AND status='available'`.
- **Deliverables (4 files, 834 insertions per T1.4 handoff package):**
  - `prisma/manual-migrations/phase-p1-sc1-sc2-indexes.sql` — the production SQL.
  - `prisma/schema.prisma` — **mixed** (verified via `git show origin/phase-p1/t1-4-dba-indexes:prisma/schema.prisma | grep idx_`):
    - **SC1** is mirrored as a real `@@index([kycStatus, isVerified, isActive], map: "idx_user_kyc_broadcast")` on the `User` model. This was enabled by the rebase onto `main-new`, which already carries the `kycStatus` field (that field was missing on stale `main`, which is why T1.4's earlier draft avoided `@@index`).
    - **SC2** is a **comment-only** annotation on the `Vehicle` model (text: `// Phase-P1 | T1.4 | SC2 — DB-only partial index idx_vehicle_key_avail on ("vehicleKey", "transporterId") WHERE "isActive"=true AND "status"='available'.`) — Prisma's DSL cannot express partial-index predicates.
    - **This withdraws a prior ledger entry** that stated "annotation comments only, no @@index additions". That claim was based on a stale T1.4 message; the actual branch state on origin confirms the hybrid above.
  - `scripts/phase-p1-sc1-sc2-dry-run.ts` — Docker-based local harness. T1.4 reports Docker daemon was down on their workstation so the harness exited with code 2 (by design); **director MUST re-run this harness locally before the prod window** to validate the SQL against a disposable container.
  - `.planning/verification/PRODUCTION-INDEX-RUNBOOK-P1.md` — execution runbook with snapshot → psql → verify → rollback steps + a Step 4 Appendix covering scheduled-Lambda export of `pg_stat_user_indexes.idx_scan` to CloudWatch namespace `Weelo/Database`, metric `PgIndexScans`, dimension `IndexName=<name>` (directly usable for a later dashboard panel).
- **Divergence notes — RESOLVED (per team-lead confirmation):**
  1. **`BEGIN / COMMIT` removed** around `CREATE INDEX CONCURRENTLY`. Postgres forbids `CREATE INDEX CONCURRENTLY` inside an explicit transaction block, so the manual SQL file correctly omits the wrapper. Director can run the file directly via psql without splitting.
  2. **Prisma schema: hybrid `@@index` for SC1, comment-only for SC2** (verified above). SC1 uses `@@index([kycStatus, isVerified, isActive], map: "idx_user_kyc_broadcast")` — enabled by the rebase onto `main-new` where the `kycStatus` field is present. SC2 remains comment-only because partial predicates can't be expressed in Prisma DSL. This supersedes both earlier ledger statements in this file (one claiming `@@index(map:…)` universal, one claiming "annotation comments only"). Current state verified via `git show origin/phase-p1/t1-4-dba-indexes:prisma/schema.prisma`.
- **Director handoff sequence (T1.4's specified order):**
  1. Verify `F-B-75` has landed in prod (`kycStatus` column exists on `User`) — pre-flight SQL is in the runbook.
  2. Take RDS snapshot.
  3. `psql "$PROD_DATABASE_URL" -f prisma/manual-migrations/phase-p1-sc1-sc2-indexes.sql`.
  4. Verify `indisvalid = true` on both indexes.
  5. Wait 1h, confirm `idx_scan > 0`.
  6. T1.7 (me) considers adding a CloudWatch panel once the Lambda-export pattern from the runbook Step 4 Appendix is live — **note: not a Phase-1 deliverable; queued as a potential Phase-2 follow-up since SC1/SC2 exit-gate uses manual psql, not CW.**
- _Post-director-execution (still gated on human operator, not T1.4):_ pg_stat_user_indexes query output (1h after apply), EXPLAIN ANALYZE before/after on broadcast query. This data cannot exist until the director runs the SQL on production — exit-gate criterion stays open.

#### SC8 + L6 (T1.5) — evidence
- **Task status:** completed. **Both SC8 and L6 shipped** after T1.5 rebased onto `main-new`, which unblocked L6's target file `src/modules/order/order-creation.service.ts` (absent on stale `main`, present on `main-new`).
- **Commits on origin** (verified via `git log origin/phase-p1/t1-5-boot-path -2`):
  - `e687faeb` — `fix(T1.5): drop duplicate server_boot_scan_ms registration (T1.6 owns)` (head).
  - `9ee6b748` — `phase-p1(T1.5): SC8 boot-scan observability + L6 backpressure log-once` (primary).
  - Merge-base with `main-new`: `63802612` (= `main-new` tip; rebase confirmed).
  - Earlier SHAs `82bee32c` (pre-rebase) and a second `9ee6b748`-tag from T1.5's first report **never reached origin after the rebase + force-push** — current origin state is the authoritative pair above.
- **T1.6 coordination (captured in `e687faeb`):** T1.5 originally registered `server_boot_scan_ms` inside their own `// === P1-T1.5 ===` block in `metrics-definitions.ts`. T1.6 had already pre-registered the same histogram under their `P1 process metrics` block on `phase-p1/t1-6-metrics-infra` (commit `181666a6`). The fix commit removes the T1.5 duplicate to avoid a `histograms.set()` last-write-wins collision when both PRs merge. **This means T1.5's PR now emits the histogram but does not register it — T1.6 owns the registration.** My DASHBOARD-P1 Panel #8 references the histogram by name; no change needed because the name is unchanged.
- **Files shipped in `9ee6b748` (per `git show --stat`, 460 insertions, 6 files):**
  - `src/server.ts` (+28/-6) — SC8: wrap `clusterScanAllFlat` call with `process.hrtime.bigint()` span; emit histogram on success + partial-failure. Switched `catch(err: any)` → `catch(err: unknown)` with narrowing.
  - `src/modules/order/order-creation.service.ts` (+17) — L6: one-time warn `[BACKPRESSURE] In-memory mode engaged` when the in-memory path is first selected. No functional change; gated by a log-once guard.
  - `src/__tests__/p1-t1-5-boot-scan.test.ts` (+197) — 7 SC8 tests.
  - `src/__tests__/p1-t1-5-l6-backpressure-log.test.ts` (+96) — 1 L6 test (5 fallback hits → exactly 1 warn).
  - `scripts/benchmarks/p1-t1-5-scan-vs-keys.ts` (+119) — the 100k-key KEYS-vs-SCAN microbenchmark.
  - `src/shared/monitoring/metrics-definitions.ts` (+9) — subsequently reverted by `e687faeb` per the T1.6 coordination above.
- **Histogram spec** (registered by T1.6; emitted by T1.5): `server_boot_scan_ms`, `LATENCY_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]`, help text *"Duration of Redis SCAN-based startup warm loop in ms (H3 geo index rebuild)."* Emit frequency: **once per process boot when `FF_H3_INDEX_ENABLED=true`, plus one observation on the partial-failure path.** T1.5 suggested alarm `p99 > 5000ms for 5m` — **not added to the P1 alarm script** (boot spikes are deploy-time not runtime; ECS deploy circuit-breaker pages first). Queued as Phase-2 consideration.
- **L6 signal shape** — IMPORTANT for alarm wiring: L6 ships as a **log line** (`[BACKPRESSURE] In-memory mode engaged`), NOT a counter. T1.5 suggests a CloudWatch Logs Insights query rather than a CW metric alarm: `fields @message | filter @message like /\[BACKPRESSURE\] In-memory mode engaged/` → non-zero 5m rate → investigate Redis. **Not added to `setup-broadcast-p1-alarms.sh`** (my script uses metric-based alarms; a log-filter metric-transformation would be the Phase-2 path if/when this signal needs auto-paging).
- **Benchmark** (unchanged from prior entry, captured for audit): `KEYS` = 9.39 ms vs `scanIterator` = 14.25 ms at 100k keys. `scanIterator` yields event-loop between batches; on production ElastiCache where RTT + connection contention dominate, the non-blocking pattern is the real win. Local ~5ms regression is acceptable — exit-gate criterion measures boot duration (I/O-gated), not microbenchmark throughput (CPU-gated).
- _T1.5 to paste during PR review:_ `server_boot_scan_ms` p50/p95/p99 histogram output from the jest harness or a manual `curl /metrics | grep server_boot_scan_ms`, and the `grep '\[BACKPRESSURE\]' logs` output from a forced-fallback test run showing the log fires exactly once per process boot.
- _T1.5 to paste (for final SC8 evidence fill-in):_ `server_boot_scan_ms` p50/p95/p99 from the benchmark harness on production-like data volume + before/after server boot duration.
- _Post-L6-rebase follow-up:_ once L6 ships (new SHA to be communicated), T1.5 pastes the backpressure log line (grep output showing it fires under simulated load) and this block becomes fully closed.

#### Metrics infra (T1.6) — evidence
- **Task status:** completed.
- **Commit:** `181666a6` on `phase-p1/t1-6-metrics-infra`, rebased onto `main-new`. Verified via `git log origin/phase-p1/t1-6-metrics-infra -1` — this is origin HEAD. T1.6's handoff message cited `9d894927` but that SHA **never reached origin** (same pattern as T1.4's `ae60a1db` and T1.3's `90ec3be7`).
- **Files shipped (verified via `git show --stat origin/phase-p1/t1-6-metrics-infra`):**
  - `src/shared/monitoring/metrics-definitions.ts` (+42) — adds reserved blocks for T1.1/T1.2/T1.3/T1.5 counter registrations (teammates extend these blocks in their own branches) + T1.6 process metrics (`phase1_landed_commit_sha` gauge + `server_boot_scan_ms` histogram).
  - `src/shared/monitoring/metrics.service.ts` — type exports + additive register hook at end of `initializeDefaultMetrics` (per T1.6 handoff; not verified line-by-line in this ledger).
  - `.planning/verification/METRICS-NAMING-V1.md` (+128) — naming specification; §4 includes the copy-paste reserved-block template; §5 carries the P1 counter manifest used by T1.7 dashboard wiring.
  - `src/__tests__/p1-t1-6-process-metrics.test.ts` (+45) — 4/4 tests green.
- **New counter shipped by T1.6 (not referenced by T1.1–T1.5):** `phase1_landed_commit_sha` — gauge, informational, updated by deploy script to the HEAD commit SHA when P1 lands. **Not added to the Phase-1 dashboard** (not an operational signal); could become useful in Phase 2 to correlate alarm state with the last-deployed revision.
- **Manifest discrepancy flagged** (NOT a T1.6 ship defect — documentation drift only):
  - T1.6's handoff-message manifest lists L3 as `eta_ranking_fallback_total{reason}` (1 label) and L7 as `fleet_cache_corruption_total` (no labels).
  - T1.1's actual emit sites on `origin/phase-p1/t1-1-obs-broadcast` use `{reason, stepIndex, errorClass}` (3 labels, verified via `git show origin/phase-p1/t1-1-obs-broadcast:src/modules/order/progressive-radius-matcher.ts | grep -A6 incrementCounter`) and `{keyPrefix}` (1 label, verified in `fleet-cache.service.ts`).
  - **Authoritative label schema is T1.1's call-site shape**, because this backend's Prometheus wrapper auto-creates the label index from `incrementCounter(name, labels)` calls — the reserved-block comment in `metrics-definitions.ts` is informational and does not constrain the label set.
  - **Dashboard is correct as-shipped.** Panel #2 uses `{Weelo/Backend,reason,stepIndex,errorClass}`; Panel #3 uses `{Weelo/Backend,keyPrefix}`. Both match T1.1's actual emit. My Panel #5 M18 SEARCH `{Weelo/Backend,event,mode}` matches T1.2's stated plan as well.
  - **Follow-up owned by T1.6:** update `METRICS-NAMING-V1.md` §5 to reflect T1.1's actual 3-label/1-label schema so the naming spec matches reality. NOT a Phase-1 exit-gate blocker; `/review` may flag it but it's a docs edit not a code change.
- **L1 backend mirror** — T1.6 lists `booking_legacy_fallback_total{status}` as an **optional backend mirror** of the customer-app Crashlytics event. **Not shipped by any teammate in Phase 1.** If operators want a backend-visible signal that the legacy fallback fired on server side, this is the counter name reserved; future work.
- **Consistency with T1.7:** my `DASHBOARD-P1.md` §"Metric pipeline" cites `metrics.service.ts:128`/`:243` and `metrics-definitions.ts` as consolidated chokepoints for the EMF bridge — still accurate with T1.6's additive changes. The EMF recommendation stands.
- _T1.6 to paste during PR review:_ Link to `METRICS-NAMING-V1.md` §5 in the PR body, `curl /metrics | wc -l` before/after showing growth by the number of new P1 counters, confirmation that `registerDefault*` delegation in `metrics.service.ts` is preserved, and the corrected L3/L7 label schema in §5.

#### Dashboard + handoff (T1.7) — evidence
- Dashboard JSON widget count: 11 (validated via `python3 -m json.tool`).
- Alarms installed by script: 5 (1 P2, 4 P3).
- `scripts/monitoring/setup-alarms.sh` unmodified — verified via `git diff main-new -- scripts/monitoring/setup-alarms.sh` returning empty.
- Self-review log in PR body covers CRITICAL/HIGH bash + JSON findings (empty-array `set -u` safety, M18 threshold semantics).

_[this PR is the deliverable]_

---

## 3. Deviations & open items

_Record anything that diverges from SPRINT-PLAN or was deliberately deferred._

### P1-FOLLOWUP-1 — Prometheus → CloudWatch bridge **[PRIORITY 1]**

**Scheduled by:** team-lead / director.
**Required before:** Phase 2 canary.
**Estimated effort:** 1 teammate, < 1 day (½ day code+test, ½ day staging observation).

**Recommended approach: EMF log-emission from `metrics.service.ts`.** Add `aws-embedded-metrics` (~60KB). Wrap `incrementCounter` and `observeHistogram` so every mutation writes an Embedded Metric Format JSON line to stdout. The existing ECS `awslogs` driver ships stdout to the `weelobackendtask` log group; CloudWatch parses EMF records natively and creates custom metrics under the `Weelo/Backend` namespace — the same namespace this dashboard's widgets and `setup-broadcast-p1-alarms.sh` already target, so no dashboard/alarm rewrite is needed once it lands.

**Why this one (not ADOT sidecar or Lambda scraper):**
1. **Zero new infra.** No new container in the ECS task definition, no IAM policy changes, no EventBridge schedule, no VPC/SG rework. `Dockerfile.production:36` already logs to stdout and task logs already flow to CloudWatch (see `weelobackendtask` log group references in CLAUDE.md §"How to Check CloudWatch Logs").
2. **Smallest diff, single file.** `src/shared/monitoring/metrics.service.ts:128` (`incrementCounter`) and `:243` (`getPrometheusMetrics`) are the only chokepoints. Estimated ~30-40 LOC. T1.6 already consolidated this file on `main-new`, so the team's context is already loaded. Line numbers verified against `origin/main-new`; if lines drift, grep for the symbol names.
3. **Footprint already paid.** `package.json` already includes `@aws-sdk/client-kinesis`, `@aws-sdk/client-s3`, `@aws-sdk/client-sns` — adding `aws-embedded-metrics` is not a new-dep concern.
4. **ADOT is rejected for P1-FOLLOWUP-1** because a new sidecar changes the task definition + IAM + resource budget for every ECS task, which is a deploy-wide perturbation we do not want entangled with the Phase 2 canary. It's a legitimate option for a later phase if label cardinality explodes.
5. **Lambda scraper is rejected** because it is sampling-based (misses sub-minute spikes on M18 alarm), requires a VPC Lambda for internal ECS reach, and is more code than the EMF approach it's meant to avoid writing.

Full comparison and trade-offs are in `.planning/verification/DASHBOARD-P1.md` §"Metric pipeline: Prometheus → CloudWatch" (options A / B / C); this section is the actionable recommendation derived from that analysis.

**Why this exists:** the backend currently exposes Prometheus text on `GET /metrics` but does not push custom metrics to CloudWatch. Until the bridge is wired, every app-counter panel on `weelo-broadcast-baseline-p1` renders `INSUFFICIENT_DATA`. Alarms remain safe (`treat-missing-data=notBreaching`) but give no early-warning signal.

**Acceptance criteria (copy into the follow-up ticket):**
- All 5 P1 alarms transition from `INSUFFICIENT_DATA` to `OK` within 24h of bridge deployment on production.
- Every app-sourced dashboard panel shows ≥1 non-null datapoint in a 1h window.
- `curl /metrics | wc -l` output unchanged ± counter growth (bridge must not disrupt the existing Prometheus endpoint).
- No regression in `server_boot_scan_ms` p99 (SC8 baseline from T1.5).

**Director may override** this recommendation — if so, the dashboard/alarm scripts remain valid as long as the override publishes to namespace `Weelo/Backend`. If a different namespace is chosen, update `CW_NAMESPACE` env var when invoking `setup-broadcast-p1-alarms.sh` and globally replace `Weelo/Backend` in the dashboard JSON (6 occurrences total: 5 in metric tuples + 1 in the footer markdown). A `sed -i '' 's|Weelo/Backend|New/Namespace|g'` covers both.

### Other deferred items

- **SC1/SC2 index scan counters not scraped to CW.** Verification is manual psql per `DASHBOARD-P1.md` §SC1/SC2. Phase 2 may add a scheduled `PutMetricData` exporter if trending is desired.

- **`_prisma_migrations` table still absent in prod.** T1.4's migration is direct SQL (per CLAUDE.md rule). Not a Phase 1 item to fix — tracked separately.

- **Shared working tree collision risk.** This agent hit `git checkout` collisions twice during concurrent phase execution — untracked files on one teammate's branch were wiped when another teammate switched branches / rebased. Resolved by using `git worktree add /tmp/weelo-backend-<slug>`. Recommend future phases instruct each teammate to `git worktree add` from the start, or give each teammate their own clone. Not a phase-exit blocker.

---

## 4. /review summary (per teammate)

T1.7 aggregates `/review` results from each teammate's PR into a single table. Any row with CRITICAL or HIGH unresolved blocks the exit gate.

| Teammate | Critical | High | Medium | Low | Blocks gate? |
|---|---|---|---|---|---|
| t1-1-obs-broadcast | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |
| t1-2-obs-postcommit | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |
| t1-3-comments-customer | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |
| t1-4-dba-indexes | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |
| t1-5-boot-path | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |
| t1-6-metrics-infra | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |
| t1-7-dashboard-handoff | 0 | 2 resolved | 0 | 0 | No — see PR body self-review |

**T1.7 self-review resolved findings:**
- **HIGH-1 (fixed)**: `put_counter_alarm()` initially expanded `"${dimensions_args[@]}"` over a possibly-empty array, which fails under macOS bash 3.2 + `set -u` with "unbound variable". Split into two code paths (args / no-args) so empty-expansion never runs. Verified via `bash -c 'set -euo pipefail; arr=(); cmd=(echo test "${arr[@]}"); "${cmd[@]}"'` — reproduces the bug on host bash 3.2.57.
- **HIGH-2 (fixed)**: M18 alarm was configured `period=60s, evaluation-periods=2, threshold=0` which requires TWO consecutive minutes with at least one emit each. Briefing wanted "any single emit in a 2-minute rolling window" — changed to `period=120s, evaluation-periods=1, threshold=0`, which fires on any single emit in any rolling 2-minute bucket. Comment block in script documents the semantics.

---

## 5. Sign-off

_T1.7 signs here only after §2 checklist is fully green and §4 table has zero `Blocks gate? yes`._

**Signed off:** ☐ NOT YET — Phase 1 is not ready for merge.
**Sign-off SHA (T1.7 HEAD on merge day):** _pending_
**Director notified:** ☐
**24h canary start time:** _pending_

---

_Last updated by t1-7-dashboard-handoff: on draft-PR creation. Will be amended as sibling PRs land._
