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
| t1-2-obs-postcommit | 1 | L2, M18 | `phase-p1/t1-2-obs-postcommit` | _waiting_ | _waiting_ | _waiting_ | _waiting_ | in_progress |
| t1-3-comments-customer (backend) | 5 | L4, M9 | `phase-p1/t1-3-comments-m9-cleanup` | _PR TBD (human opens)_ | `16ce444c` (L4+M9) + `b8b3298e` (channel-rename test) — rebased onto main-new, supersedes `90ec3be7` | none (docs/grep cleanup) | _awaiting /review output; 3/3 jest green per team-lead_ | completed |
| t1-3-comments-customer (customer-app) | 5 | L1 | `phase-p1/t1-3-legacy-fallback-analytics` (nitu01019/weelo) | _PR TBD (human opens)_ | `e3fbfe7` (supersedes `571ea44`) | L1 analytics event only (Crashlytics wrapper, no new SDK) | _awaiting /review output; 8/8 tests green per team-lead_ | completed |
| t1-4-dba-indexes | 7 | SC1, SC2 | `phase-p1/t1-4-dba-indexes` | https://github.com/nitu01019/weelobackend/pull/new/phase-p1/t1-4-dba-indexes | `ae60a1db` (supersedes earlier `9c3545eb`) | none (SQL migration + schema.prisma annotation comments only, no `@@index` additions) | _awaiting /review output_ | completed |
| t1-5-boot-path | 3 | SC8, L6 | `phase-p1/t1-5-boot-path` | _PR TBD (human opens)_ | `9ee6b748` | `server_boot_scan_ms` (+ L6 log line) | _awaiting /review output — 12/12 regression green per T1.5 handoff_ | completed |
| t1-6-metrics-infra | 2 | pre-reg + naming spec | `phase-p1/t1-6-metrics-infra` | _PR TBD (human opens)_ | `181666a6` (rebased onto main-new) | shared `metrics-definitions.ts` (additive — main-new already has the delegation refactor) | _awaiting /review output; 4/4 tests green per team-lead_ | completed |
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
_T1.2 to paste:_ Post-commit wrapper grep, M18 simulation output, `alarm-m18-adapter-down.json` path.
_[pending]_

#### L1 + L4 + M9 (T1.3) — evidence
- **Task status:** completed.
- **Two separate PRs (one backend, one customer-app):**
  - **Backend** (L4, M9): branch `phase-p1/t1-3-comments-m9-cleanup`, **rebased onto `main-new`.** Commits: `16ce444c` (L4 + M9 primary) + `b8b3298e` (channel-rename test). Supersedes the pre-rebase SHA `90ec3be7`. Tests: 3/3 jest green. M9 scope: `clickAction: 'FLUTTER_NOTIFICATION_CLICK'` removed at **two** `fcm.service.ts` sites (lines `:449` and `:730`) per T1.3's plan dump; grep verification under `src/` shows zero remaining `FLUTTER_NOTIFICATION_CLICK` matches. Rebase preserved `main-new`'s richer `fcm.service.ts` `buildMessage` visibility conditional during 3-way conflict resolution. L4 scope: comment rewrites at `progressive-radius-matcher.ts:66-68` and `h3-geo-index.service.ts:414` + `:418` (flat-direction step ~0.798 km; 0.461 km is the circumradius).
  - **Customer-app** (L1): branch `phase-p1/t1-3-legacy-fallback-analytics` in `nitu01019/weelo`, top-of-branch `e3fbfe7` (supersedes earlier `571ea44`). Tests: 8/8 green. Implementation notes: analytics event emitted via the existing Crashlytics wrapper (`FirebaseCrashlytics.getInstance().log` + `setCustomKey`) per T1.3's plan — app has no `firebase-analytics` dependency in `build.gradle`. Event fires only in the `createOrder` fallback branch (plan cited line 587-590) when the primary response is 400/404/422/501. No new SDK, no new permissions.
- **Follow-ups flagged by T1.3 (tracked but NOT phase-exit blockers):**
  1. Stale peer tests — documented follow-up; detail awaiting T1.3 paste.
  2. M9 spec contradiction — documented follow-up; detail awaiting T1.3 paste.
- _T1.3 to paste:_ Firebase Analytics event screenshot/URL, L4 comment-cleanup diff summary, the full M9 grep command used, and the two follow-up items above in full.

#### SC1 + SC2 (T1.4) — evidence
- **Task status:** completed.
- **Commit:** `ae60a1db` on `phase-p1/t1-4-dba-indexes`. (Supersedes earlier `9c3545eb` — T1.4 advanced their branch after that initial SHA was reported.)
- **Index names (authoritative):**
  - `idx_user_kyc_broadcast` (SC1) — non-partial composite on `User`.
  - `idx_vehicle_key_avail` (SC2) — **partial** index on `Vehicle WHERE isActive AND status='available'`.
- **Deliverables (4 files, 836 insertions per T1.4 ship report):**
  - `prisma/manual-migrations/phase-p1-sc1-sc2-indexes.sql` — the production SQL.
  - `prisma/schema.prisma` — **annotation comments only, no `@@index` additions.** Two reasons per T1.4: (a) SC1 needs `F-B-75`'s `kycStatus` field which may not yet be in the schema on `main`; (b) SC2 is a partial index and Prisma's DSL cannot express the partial predicate. Correcting a prior ledger claim that stated `@@index(map:…)` was present — that was wrong.
  - `scripts/phase-p1-sc1-sc2-dry-run.ts` — Docker-based local harness. T1.4 reports Docker daemon was down on their workstation so the harness exited with code 2 (by design); **director MUST re-run this harness locally before the prod window** to validate the SQL against a disposable container.
  - `.planning/verification/PRODUCTION-INDEX-RUNBOOK-P1.md` — execution runbook with snapshot → psql → verify → rollback steps + a Step 4 Appendix covering scheduled-Lambda export of `pg_stat_user_indexes.idx_scan` to CloudWatch namespace `Weelo/Database`, metric `PgIndexScans`, dimension `IndexName=<name>` (directly usable for a later dashboard panel).
- **Divergence notes — RESOLVED (per team-lead confirmation):**
  1. **`BEGIN / COMMIT` removed** around `CREATE INDEX CONCURRENTLY`. Postgres forbids `CREATE INDEX CONCURRENTLY` inside an explicit transaction block, so the manual SQL file correctly omits the wrapper. Director can run the file directly via psql without splitting.
  2. **No `@@index` additions in schema.prisma** (corrected above). Prior ledger entry claiming `@@index(map: "idx_…")` is withdrawn as inaccurate — T1.4 chose annotation comments instead for the two reasons listed under Deliverables.
- **Director handoff sequence (T1.4's specified order):**
  1. Verify `F-B-75` has landed in prod (`kycStatus` column exists on `User`) — pre-flight SQL is in the runbook.
  2. Take RDS snapshot.
  3. `psql "$PROD_DATABASE_URL" -f prisma/manual-migrations/phase-p1-sc1-sc2-indexes.sql`.
  4. Verify `indisvalid = true` on both indexes.
  5. Wait 1h, confirm `idx_scan > 0`.
  6. T1.7 (me) considers adding a CloudWatch panel once the Lambda-export pattern from the runbook Step 4 Appendix is live — **note: not a Phase-1 deliverable; queued as a potential Phase-2 follow-up since SC1/SC2 exit-gate uses manual psql, not CW.**
- _Post-director-execution (still gated on human operator, not T1.4):_ pg_stat_user_indexes query output (1h after apply), EXPLAIN ANALYZE before/after on broadcast query. This data cannot exist until the director runs the SQL on production — exit-gate criterion stays open.

#### SC8 + L6 (T1.5) — evidence
- **Task status:** completed.
- **Commit:** `9ee6b748` on `phase-p1/t1-5-boot-path`.
- **Tests:** 8 new tests added (7 SC8 + 1 L6). `phase6-observability` regression suite: 12/12 green. `tsc` clean.
- **Benchmark (100k keys, per team-lead handoff):** `KEYS` = **9.39 ms**; `scanIterator` = **14.25 ms**. Local microbenchmark shows `KEYS` faster, BUT: `scanIterator` yields to the event loop between batches, so on production ElastiCache (where network RTT + connection contention dominate) the non-blocking pattern is the real win. Accepting the ~5 ms local regression is correct — the exit-gate criterion ("server_boot_scan_ms p99 post-SC8 ≤ pre-SC8 baseline") measures boot duration, not microbenchmark throughput, and boot is gated on I/O not CPU.
- _T1.5 to paste (for final evidence fill-in):_ `server_boot_scan_ms` p50/p95/p99 from the benchmark harness on production-like data volume, before/after server boot duration, and the L6 backpressure log line (grep output showing it fires under simulated load).

#### Metrics infra (T1.6) — evidence
- **Task status:** completed.
- **Commit:** `181666a6` on `phase-p1/t1-6-metrics-infra`, rebased onto `main-new`.
- **Files shipped (per team-lead ledger):**
  - `src/shared/monitoring/metrics-definitions.ts` (+42) — additive; `main-new` already had the consolidation refactor, so this commit only adds the new P1 counter registrations.
  - `.planning/verification/METRICS-NAMING-V1.md` (+128) — naming specification; §4 includes the copy-paste reserved-block template teammates use for their per-ticket registrations.
  - `src/__tests__/p1-t1-6-process-metrics.test.ts` (+45) — 4/4 tests green.
- **Consistency with T1.7:** my `DASHBOARD-P1.md` §"Metric pipeline" cites `metrics.service.ts:128`/`:243` and `metrics-definitions.ts` as consolidated chokepoints for the EMF bridge — still accurate with T1.6's additive changes on top.
- _T1.6 to paste:_ Link to `METRICS-NAMING-V1.md` in the PR body, `curl /metrics | wc -l` before/after (should grow by Σ new P1 counters), and confirmation that `registerDefault*` delegation in `metrics.service.ts` is untouched.

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
