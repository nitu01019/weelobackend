# Phase 4 — Tier-3 Accept Atomicity — Verification Gate

**Date:** 2026-04-21
**Branch:** `phase-p1/t1-2-obs-postcommit`
**Pre-P4 baseline:** `pre-phase4-accept-atomicity` → `acfd26a3`
**Post-P4 + cleanup HEAD:** `312242f3`
**P5 baseline tag:** `pre-phase5-queue-timer-idempotency` → `312242f3`

---

## Verdict

**PASS (with 1 deferred item)** — Phase 4 delivers all 18 findings. All 12 P4-caused test regressions are fixed. Total failing-test count (76) is now **lower** than the pre-P4 baseline (85) — we beat the exit condition by 9 tests / 4 suites.

The one deferred item is device/hardware E2E which cannot be run from this host (no ADB device). User will sign off on phone during staging canary.

---

## P4 commits (18 total — 11 feature/refactor + 7 test-cleanup)

### Phase-4 feature/refactor commits (code changes)

| SHA | Subject |
|-----|---------|
| `967ffc0d` | feat(confirmed-hold): P4 F2.2+F2.8+F2.NEW-1 — transporter-scoped + FOR UPDATE + serializable |
| `7ac108cb` | test(confirmed-hold): P4 F2.2+F2.8+F2.NEW-1 — sync existing tests to withDbTimeout |
| `e237ebcc` | feat(flex-hold): P4 F2.5+F2.NEW-3 — lock before dedup + serializable tx + partial unique |
| `4af3eb1f` | feat(confirmed-hold): P4 F2.1+F2.NEW-2 — lifecycle-outbox post-commit timer + cache coordination |
| `4458ae3d` | fix(confirmed-hold): P4 F2.3+F2.NEW-4 — explicit lock-release warnings + durable vehicle release |
| `f0cc56de` | feat(routes): P4 F2.7 — X-Idempotency-Key on /confirmed-hold/initialize |
| `7702f6f4` | feat(assignment-response): P4 F12.1+F12.2 — VehicleTransitionOutbox INSERT + CAS fail-closed |
| `aeca566a` | feat(assignment-response): P4 F12.4+F12.6 — serializable tx + active-trip check inside tx |
| `483f81e0` | feat(assignment-response): P4 F12.3+F12.5 — guarded ledger flip + sibling supersede inside tx |
| `fa5a21b8` | refactor(accept): P4 F12.7 — unify accept-path lock lifecycle with acquireAcceptLock helper |
| `041a523b` | test(accept): P4 F12.7 follow-up — add HoldPhase to prisma mocks |

### Phase-4 test-cleanup commits (this session)

| SHA | Subject |
|-----|---------|
| `bfbf041e` | test(p4): sync medium-fix-hold-assignment assertion to F12.4 in-tx findFirst |
| `76c08769` | test(p4): sync assignment-queue-routes-stress mockTx to F12.1+F12.3 shape + add 10-parallel VEHICLE_STATE_CHANGED regression |
| `cf7c0e93` | test(p4): sync tiger-assignment-hardening Fix #22 grep to events.generated.ts |
| `1adecf00` | test(p4): add concurrency regressions — cross-tenant (F2.2+F2.8), 5-parallel flex-hold (F2.5), idempotency-key replay (F2.7) |
| `4709427a` | test(p4): add HoldPhase mock + sync C-11 acquireAcceptLock in 3 suites (F12.7 follow-up continuation) |
| `037db247` | test(p4): sync source-grep + tx-wiring assertions in 7 suites to new F2.x/F12.x shape |
| `312242f3` | test(p4): explicit FF_DURABLE_EMIT_ENABLED=false for off-baseline after 4af3eb1f defaultValue flip |

---

## Findings closed — 18 of 18

| # | Finding ID | Title | Commit(s) |
|---|----|-------|--------|
| 1 | F2.1 | Lifecycle-outbox post-commit timer | `4af3eb1f` |
| 2 | F2.2 | Transporter-scoped assignment fetch on confirmed-hold init | `967ffc0d` |
| 3 | F2.3 | Explicit lock-release warnings when releaseLock fails | `4458ae3d` |
| 4 | F2.5 | Lock-before-dedup ordering in createFlexHold | `e237ebcc` |
| 5 | F2.6 | FCM + socket emit on assignment transition | `967ffc0d` (spans earlier work) |
| 6 | F2.7 | X-Idempotency-Key on /confirmed-hold/initialize | `f0cc56de` |
| 7 | F2.8 | FOR UPDATE scope on TruckRequest via heldById | `967ffc0d` |
| 8 | F2.NEW-1 | Phase-guard — only FLEX can init confirmed | `967ffc0d` |
| 9 | F2.NEW-2 | Cache coordination on outbox timer | `4af3eb1f` |
| 10 | F2.NEW-3 | Partial unique index for flex-hold dedup | `e237ebcc` + `migrations/M-015-flex-hold-dedup-partial-index.sql` |
| 11 | F2.NEW-4 | Durable vehicle release (outbox-backed) | `4458ae3d` |
| 12 | F12.1 | VehicleTransitionOutbox INSERT inside tx | `7702f6f4` |
| 13 | F12.2 | Vehicle CAS fail-closed (409 VEHICLE_STATE_CHANGED) | `7702f6f4` |
| 14 | F12.3 | Guarded FLEX→CONFIRMED ledger flip | `483f81e0` |
| 15 | F12.4 | Driver-busy precheck inside Serializable tx | `aeca566a` |
| 16 | F12.5 | Sibling-pending assignment supersede inside tx | `483f81e0` + `migrations/M-016-assignment-superseded.sql` |
| 17 | F12.6 | Active-trip check inside same tx | `aeca566a` |
| 18 | F12.7 | Unified accept-lock via acquireAcceptLock helper | `fa5a21b8` + `041a523b` + `4709427a` |

**Untouched (FALSE findings per audit):** F4.7, F11.10 — confirmed via `git diff` (empty for both files between `pre-phase4-accept-atomicity` and `312242f3`).

---

## Test-failure delta

### Measurements (all at branch HEAD + working tree of the time)

| Snapshot | Failing suites | Failing tests | Passing tests | Total |
|----|----|----|----|----|
| Pre-P4 baseline (tag `pre-phase4-accept-atomicity`) | 32 | 85 | 11,764 | 11,853 |
| Post-P4 code, pre-test-cleanup (commit `041a523b`) | 39 | 102 | 11,754 | 11,860 |
| **Post-P4 + this session's cleanup (HEAD `312242f3`)** | **28** | **76** | **11,780** | **11,860** |

**Delta vs pre-P4 baseline:** -4 suites (-9 tests) — we now have **fewer** failing suites than before P4 started. Net 7 new test cases added (4 concurrency regressions + 3 supporting assertions) and all pass.

### Failing suites after cleanup (28) — none are P4-caused

All 28 remaining failures pre-date P4 or are jest-worker ordering flakes orthogonal to the accept-atomicity work. Complete list:

```
assignment-split.test.ts                   (flake — PASSES 120/120 in isolation; intermittent in full-suite only)
broadcast-canonicality.test.ts
broadcast-optimization-fixes.test.ts
cache-geo-dedup.test.ts
critical-22-security-redis.test.ts
critical-fixes-5-8.test.ts
critical-fixes-dispatch-payment.test.ts
critical-fixes-tx-fcm.test.ts
fix-metrics-service-hardening.test.ts
fleet-cache-constants-parity.test.ts
high-fix-booking-path.test.ts
high-fix-broadcast-hold.test.ts
high-medium-notif-quality.test.ts
leo-c1c3-c2-fixes.test.ts
low-priority-fixes-bravo.test.ts
phase3-auth-security.test.ts
phase3-broadcast-integrity.test.ts
phase3-wave1-fixes.test.ts
phase4-wave2-fixes.test.ts
phase7-e2e-flows.test.ts
phase7-events-notifications.test.ts
qa-auth-scenarios.test.ts
qa-booking-scenarios.test.ts
qa-broadcast-scenarios.test.ts
qa-completion-e2e.test.ts
qa-order-metrics-scenarios.test.ts
qa-phase4-broadcast-edge-cases.test.ts
qa-source-audit.test.ts
```

### Suites FIXED by this session (12 P4-caused + 5 bonus)

All 12 P4-caused regressions resolved:

| Suite | Category | Root cause | Commit |
|-------|----------|------------|--------|
| medium-fix-hold-assignment | C (stale source-grep) | F12.4 moved findFirst INTO tx; test grepped old H-17 comment | `bfbf041e` |
| assignment-queue-routes-stress | B (missing new-tx mocks) + B (concurrency regression) | F12.1/F12.3/F12.5 added tx.vehicle.findUnique, tx.truckHoldLedger.*, tx.$executeRaw | `76c08769` |
| tiger-assignment-hardening | C (grep on wrong file) | SocketEvent extracted to packages/contracts/events.generated.ts | `cf7c0e93` |
| flex-hold-started-emit | B (added concurrency test) | F2.5 + F2.NEW-3 concurrency regression | `1adecf00` |
| phase7-state-machine-holds | B (added cross-tenant tests) | F2.2 + F2.8 403 regressions | `1adecf00` |
| phase8-scalability-error-fixes | B (added idempotency tests) | F2.7 replay-cache | `1adecf00` |
| critical-fixes-order-assign | B (HoldPhase + C-11 acquireAcceptLock) | F12.7 dynamic holder + TTL change | `4709427a` |
| e2e-integration-stress | B (HoldPhase) | F12.7 hold-state-machine.ts import needs HoldPhase at module-init | `4709427a` |
| qa-vehicle-redis | B (HoldPhase) | same as above | `4709427a` |
| critical-22-hold-system | C (stale source-grep) | F2.5 split FLEX_HOLD_LOCK into create-lock + extend-lock | `037db247` |
| critical-fixes-locks | C (source-window too small) | F2.NEW-4 grew handleDriverDecline beyond 8k window | `037db247` |
| phase5-wave3-fixes | C (stale errorCode vs error key) | F2.NEW-3 moved checks INTO tx; dedupOrCreate now uses errorCode: | `037db247` |
| hawk-e2e-flow-stress | A/B (mock wiring) | F2.NEW-3 moved findFirst/create INSIDE tx; test's withDbTimeout mock lacked truckHoldLedger + orderLifecycleOutbox + $queryRaw + $executeRaw | `037db247` |
| hold-kyc-second-gate | C (tx-wrapping construct change) | F2.5+F2.NEW-3 uses withDbTimeout instead of prismaClient.$transaction | `037db247` |
| qa-hold-system-scenarios | A/B (mock tx proxy missing keys) | validateActorEligibility in F-A-75 needs $queryRaw in tx proxy to reach ownership guard | `037db247` |
| qa-timeout-hold-cancel | A/B (withDbTimeout mock not re-pointed) | existing setupTxWithQueryRaw only re-pointed $transaction, not withDbTimeout | `037db247` |
| durable-emit-contract | D (intentional defaultValue flip) | 4af3eb1f set DURABLE_EMIT_ENABLED.defaultValue=true; tests assumed env-unset → off. Fix: explicit env='false'. | `312242f3` |
| durable-emit-per-user-seq | D (intentional defaultValue flip) | same as above | `312242f3` |

**Bonus fixes** (suites we fixed that were failing in pre-P4 baseline, not directly P4-related): `booking-split`, `booking-stress`, `phase8-state-machine-fixes`, `env.validation.tracking-stream`, `tiger-assignment-hardening`.

---

## Concurrency / cross-tenant / idempotency regression tests added

Per Phase 4 shared task list item #16, these 4 regressions are now pinned:

1. **10 parallel accepts → 1 success + 9× 409 VEHICLE_STATE_CHANGED** — `assignment-queue-routes-stress.test.ts:828-867` (F12.2 fail-closed CAS).
2. **Cross-tenant confirmed-hold init → 403 FORBIDDEN_REQUEST** (F2.2 assignment-scope + F2.8 truckRequest-heldBy guard) — `phase7-state-machine-holds.test.ts:1240-1300`.
3. **5 parallel flex-hold creates → exactly 1 ledger.create** — `flex-hold-started-emit.test.ts:291-337` (F2.5 + F2.NEW-3).
4. **Idempotency-key replay → cached 200 body without service re-invocation** — `phase8-scalability-error-fixes.test.ts:272-410` (F2.7, both contract + behavioral).

---

## Safety gate — all green

| Check | Result |
|-------|--------|
| `git diff --name-status pre-phase4-accept-atomicity..HEAD \| grep "^A"` returns only `migrations/M-NNN-*.sql` | ✅ 2 files added: `M-015-flex-hold-dedup-partial-index.sql`, `M-016-assignment-superseded.sql` — both allowed by prompt |
| `git diff --name-status pre-phase4-accept-atomicity..HEAD \| grep "^D"` returns 0 lines | ✅ 0 deletions |
| `src/modules/assignment/post-accept.effects.ts` untouched (F4.7) | ✅ empty diff |
| `src/modules/truck-hold/truck-hold-lifecycle.routes.ts` untouched (F11.10) | ✅ empty diff |
| Customer app untouched (`/Users/nitishbhardwaj/Desktop/Weelo`) | ✅ not touched |
| Captain repo untouched (this phase is backend-only) | ✅ not touched |
| No `.ts`/`.kt` new files | ✅ only `.sql` migrations added |
| No `.skip`/`xit`/`test.todo` added | ✅ grep confirmed |
| No `prisma migrate deploy` / `prisma db push` | ✅ not run; user must apply M-015 + M-016 via direct psql per CLAUDE.md |
| No `--no-verify` / `--no-gpg-sign` | ✅ not used |
| `npx tsc --noEmit` returns only pre-existing errors | ✅ `cleanup-order-idempotency.job`, `@sentry/node`, `@opentelemetry/*` — all pre-date P4 |

---

## Deferred items

1. **Device-Doze E2E (captain app)** — host has no ADB device. Deferred to staging canary; user will validate on phone with real FCM/WorkManager doze-bucket behavior.
2. **CloudWatch metric push for new counters** — `tx_serializable_conflict_total{site,outcome,code}`, `redis_lock_release_failed_total{op}`, `vehicle_release_failed_total{reason}`, `assignment_sibling_superseded_total{count_bucket}` are all registered via P1's registry; CloudWatch dashboard wiring deferred to P13 (Capacity + 150K load test) per master plan phase ownership.
3. **150K-concurrent-driver load test** — not in P4 scope; deferred to P13.
4. **Database migrations M-015 + M-016 application** — files staged in `migrations/`; user must apply via direct psql per CLAUDE.md rules (NEVER `prisma migrate deploy` on this DB). Apply to production before first traffic that exercises F2.5 dedup or F12.5 sibling-supersede.
5. **`assignment-split` intermittent full-suite flake** — passes 120/120 in isolation (`npx jest --forceExit src/__tests__/assignment-split.test.ts`). Failure at 5.18 only reproduces when run concurrently with other suites via jest workers. Root cause is open-handle in `TruckHoldService.startCleanupJob` (`setInterval` not cleaned up in test env — existed pre-P4). Deferred to P14 dead-code / test-hygiene lane.

---

## New feature flags added by P4 (all default OFF — do not flip until staging smoke)

| Flag | Source | Purpose |
|------|--------|---------|
| `FLAGS.ASSIGNMENT_TIMER_OUTBOX_ENABLED` | `4af3eb1f` (F2.1 + F2.NEW-2) | Post-commit timer via VehicleTransitionOutbox instead of in-memory `setTimeout` |
| `FLAGS.VEHICLE_TRANSITION_OUTBOX` | pre-P4 (F-A-64) — reused by `7702f6f4` (F12.1) | Vehicle status transition events via outbox (replay for cache/Redis sync) |
| `FLAGS.DURABLE_EMIT_ENABLED` | pre-P4 — **default flipped to `true`** by `4af3eb1f` | Per-user seq + socket:unacked ZSET for durable emit. This flip is the intentional Phase-1 C-2 rollout; tests were updated to explicitly set env=false for the "off-baseline" branch. |

---

## How to validate this gate yourself

```bash
cd /Users/nitishbhardwaj/Desktop/weelo-backend
git checkout phase-p1/t1-2-obs-postcommit
git log --oneline pre-phase4-accept-atomicity..HEAD | wc -l  # expect 18
npm test 2>&1 | grep -E "Tests:|Test Suites:" | tail -2
# Expect: Test Suites: 28 failed, 273 passed, 301 total
# Expect: Tests:       76 failed, 4 skipped, 11780 passed, 11860 total
```

---

## Hand-off to Phase 5

Phase 5 (Tier-3 Queue / Timer / Idempotency) starts from tag `pre-phase5-queue-timer-idempotency` at commit `312242f3`. Phase is backend-only (zero captain / zero customer edits). Scope: F7.1-F7.11 (queue atomic Lua; durable timer; queue-at-most-once) + F11.1, F11.2, F11.3, F11.5, F11.7, F11.9 (idempotency across the accept path, timer-fire key, hold-release key, booking-side key).

Phase 5 spec file (`phase-05-queue-timer-idempotency.md`) not found at the expected path and needs to be provided by the user before the 10-agent team can be spawned.
