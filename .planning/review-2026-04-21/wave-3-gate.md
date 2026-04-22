# Wave-3 Gate — reviewer-gate (2026-04-22)

Branch under review: `fix/critical-broadcast-reliability-2026-04-21`
Base for Wave-3 scope: `e8011b96` (Wave-2 T13 finalizer)
Reviewer: reviewer-gate (Wave-3 review role per CRITICAL_FIX_PLAN.md §7.3.5)

## Commits (chronological, 30 total; 17 fix + 13 docs/chore)

| SHA | Subject |
|-----|---------|
| 76ff0566 | fix(critical): A12-002 — drop driverName; mask driverPhone; extend SENSITIVE_FIELDS |
| 8128d634 | fix(critical): A01-004 — confirmed-hold/initialize per-item validation for assignmentId/driverId/truckRequestId |
| b34c4a77 | fix(critical): A09-001 — remove customerName from broadcast-accept trip_assigned pre-accept payload; keep masked phone |
| 9be33c0b | fix(critical): A03-003 — withSocketMeta + durableEmit carry serverNowMs + optional deadlineMs |
| 49d3c2aa | fix(critical): A12-008 — order-accept removes customerName pre-accept; masks phone via maskPhoneForExternal |
| a610cdf0 | docs(critical): create FIXES_APPLIED.md with A03-003 W3-T01 row (WRONG-PATH — see Deviation #1) |
| 1951c677 | docs(critical): FIXES_APPLIED rows for Wave-3 pii-logs-owner (A12-002 A09-001 A12-008 A01-004) |
| abf34cd8 | fix(critical): A03-003 — flex-hold emit sites pass deadlineMs |
| f593e744 | fix(critical): A04-003 — observability warn + socket_adapter_no_pel_reclaim_total on adapter init |
| 00be6a3e | docs(fixes): A04-003 W3-T13 — append FIXES_APPLIED row for adapter-init observability |
| 3d712c59 | fix(critical): A03-003 — reassign + cascade emit sites pass deadlineMs |
| 13e1da5c | fix(critical): A03-003 — confirmed-hold emit sites pass deadlineMs |
| b689cd5e | docs(critical): append A03-003 W3-T02/T03/T04 FIXES_APPLIED rows (WRONG-PATH — see Deviation #1) |
| f713c2a8 | fix(critical): A03-003 — gate deadlineMs stamp behind FF_SERVER_CLOCK_ANCHOR |
| fc8e86e1 | fix(critical): A03-004 A13-005 — add TripAssignedFanoutPayload type + union member |
| 75972fe5 | docs(critical): append A03-003 W3-T05 FIXES_APPLIED row (WRONG-PATH — see Deviation #1) |
| 09723577 | docs(fixes): W3-T06 — append A03-004 + A13-005 rows for TripAssignedFanoutPayload (sha fc8e86e1) |
| adb24fc6 | fix(critical): A03-004 A13-005 — lifecycle outbox parses and dispatches trip_assigned_fanout |
| 0a12a353 | fix(critical): A09-002 A12-009 — role-scoped durable-emit ZSET Phase 1 (ATOMIC MULTI/EXEC dual-write old + new keys, read old only) (Arch 1B amendment) |
| 28f58b47 | docs(fixes): W3-T07 — append A03-004 + A13-005 rows for trip_assigned_fanout dispatcher (sha adb24fc6) |
| 636d70f4 | docs(fixes): A09-002 A12-009 W3-T10 — append FIXES_APPLIED rows for role-scoped ZSET Phase 1 |
| a160177d | fix(critical): A09-002 A12-009 — port Phase-1 atomicity tests into durable-emit-contract.test.ts per Guard Rail #1 |
| b2b9342d | fix(critical): A03-004 A13-005 - confirmed-hold writes trip_assigned_fanout outbox rows inside tx |
| b86625ab | docs(fixes): A09-002 A12-009 — append Guard Rail #1 remediation note referencing commit a160177d |
| 437986b1 | docs(fixes): W3-T08 - append A03-004 + A13-005 rows for confirmed-hold inside-tx fanout write (sha b2b9342d) |
| a256f7e5 | fix(critical): A13-005 - add confirmed_hold_fanout_total counter + structured fanout log fields |
| 3f9e410b | docs(fixes): W3-T09 - append A13-005 row for confirmed_hold_fanout_total counter + log fields (sha a256f7e5) |
| 50cd7756 | fix(critical): A09-002 A12-009 — role-scoped durable-emit ZSET Phase 2 (read from new key; keep dual-write for rollback) |
| 9351d6ef | docs(fixes): A09-002 A12-009 W3-T11 - append FIXES_APPLIED rows for Phase-2 reader flip (sha 50cd7756) |
| 58a62a37 | docs(fixes): A09-002 T12 Phase 3 - record DEFERRAL per plan section 13 bullet 5 (24h staging soak gate) |

Count vs expected: 30 (17 source-code fix commits + 13 docs/chore FIXES_APPLIED.md appends). Plan §7.3 targets 19 source-code commits for Wave-3; actual 17 is below target because T12 (Phase 3 cutover) was DEFERRED per plan §13 bullet 5 (24 h staging-soak gate) and the Captain-half tasks (W3-T18 + W3-T19) are per Arch 1C amendment spawned by lead as subagents OUTSIDE the agent-teams roster (not counted in this wave's commits). One extra `fix(critical)` (a160177d) is a Guard-Rail #1 fix-forward remediation of 0a12a353 (see Deviation #2). The 13 docs commits are append-only `FIXES_APPLIED.md` companions per plan §12 Guard Rail #6.

## Findings Resolved (10 of 10)

| Finding | Commit(s) | Status |
|---------|-----------|--------|
| A03-003 | 9be33c0b (T01) + abf34cd8 (T02) + 3d712c59 (T03) + 13e1da5c (T04) + f713c2a8 (T05) | APPLIED (5 commits, flag-gated default OFF) |
| A03-004 | fc8e86e1 (T06 type) + adb24fc6 (T07 dispatcher) + b2b9342d (T08 producer, flag-gated default OFF) | APPLIED (3 commits, flag-gated default OFF) |
| A13-005 | fc8e86e1 + adb24fc6 + b2b9342d + a256f7e5 (T09 observability) | APPLIED (synthesis — 4 commits covering type + dispatcher + producer + metric) |
| A09-001 | b34c4a77 (T15) | APPLIED |
| A12-008 | 49d3c2aa (T16) | APPLIED |
| A12-002 | 76ff0566 (T14) | APPLIED |
| A09-002 | 0a12a353 (T10 Phase 1) + 50cd7756 (T11 Phase 2) + a160177d (Guard Rail #1 remediation) | APPLIED (Phase 1 + Phase 2 landed; Phase 3 DEFERRED per plan §13 bullet 5) |
| A12-009 | 0a12a353 + 50cd7756 + a160177d (consolidated with A09-002 per master-file) | APPLIED (same 3-phase rollout, Phase 3 DEFERRED) |
| A01-004 | 8128d634 (T17 backend route guard) | APPLIED (backend half; Captain half T18/T19 deferred to lead subagent spawn per Arch 1C) |
| A04-003 | f593e744 (T13) | APPLIED (observability-only; PARTIAL verdict preserved — true XAUTOCLAIM reclaim requires library fork, out of scope) |

Note: A09-002 / A12-009 Phase 3 cutover (W3-T12) DEFERRED per plan §13 bullet 5 (24 h staging-soak gate). Landed documentation row (58a62a37) records deferral status; Phase 1 + Phase 2 state is production-safe (dual-write preserved for rollback).

## File-ownership table

| Commit | Files touched | Scope match |
|--------|---------------|-------------|
| 76ff0566 | src/modules/order/order-accept.service.ts + src/shared/services/logger.service.ts | EXACT (T14) |
| 8128d634 | src/modules/truck-hold/truck-hold.routes.ts | EXACT (T17) |
| b34c4a77 | src/modules/broadcast/broadcast-accept.service.ts | EXACT (T15) |
| 9be33c0b | src/shared/services/socket.service.ts | EXACT (T01 — withSocketMeta + durableEmit signature) |
| 49d3c2aa | src/modules/order/order-accept.service.ts | EXACT (T16) |
| a610cdf0 | FIXES_APPLIED.md (top-level) | WRONG-PATH — see Deviation #1 |
| 1951c677 | .planning/review-2026-04-21/FIXES_APPLIED.md | EXACT (Guard Rail #6) |
| abf34cd8 | src/modules/truck-hold/flex-hold.service.ts | EXACT (T02) |
| f593e744 | src/shared/services/socket.service.ts + src/shared/monitoring/metrics-definitions.ts | EXACT (T13 — observability warn + counter registration) |
| 00be6a3e | .planning/review-2026-04-21/FIXES_APPLIED.md | EXACT (Guard Rail #6) |
| 3d712c59 | src/modules/truck-hold/reassign-driver.service.ts + src/modules/truck-hold/cascade-dispatch.service.ts | EXACT (T03) |
| 13e1da5c | src/modules/truck-hold/confirmed-hold.service.ts | EXACT (T04 — disjoint from outbox-fanout-owner's T08 block + Wave-2 socket block) |
| b689cd5e | FIXES_APPLIED.md (top-level) | WRONG-PATH — see Deviation #1 |
| f713c2a8 | src/shared/config/feature-flags.ts + src/shared/services/socket.service.ts | EXACT (T05 — flag add + gated branch) |
| fc8e86e1 | src/modules/order/order-types.ts | EXACT (T06 — type + union extension) |
| 75972fe5 | FIXES_APPLIED.md (top-level) | WRONG-PATH — see Deviation #1 |
| 09723577 | .planning/review-2026-04-21/FIXES_APPLIED.md | EXACT (Guard Rail #6) |
| adb24fc6 | src/modules/order/order-lifecycle-outbox.service.ts | EXACT (T07 — parser + dispatcher branches) |
| 0a12a353 | src/shared/services/socket.service.ts + src/shared/services/redis.service.ts + src/shared/config/feature-flags.ts + src/shared/monitoring/metrics-definitions.ts + src/__tests__/role-scoped-zset-phase1-atomicity.test.ts (NEW — Guard Rail #1 violation, remediated in a160177d) | PARTIAL — see Deviation #2 |
| 28f58b47 | .planning/review-2026-04-21/FIXES_APPLIED.md | EXACT (Guard Rail #6) |
| 636d70f4 | .planning/review-2026-04-21/FIXES_APPLIED.md | EXACT (Guard Rail #6) |
| a160177d | src/__tests__/durable-emit-contract.test.ts + src/__tests__/role-scoped-zset-phase1-atomicity.test.ts (git rm) | EXACT — Guard Rail #1 remediation |
| b2b9342d | src/shared/config/feature-flags.ts + src/modules/truck-hold/confirmed-hold.service.ts | EXACT (T08 — tx producer write + flag) |
| b86625ab | .planning/review-2026-04-21/FIXES_APPLIED.md | EXACT (Guard Rail #6) |
| 437986b1 | .planning/review-2026-04-21/FIXES_APPLIED.md | EXACT (Guard Rail #6) |
| a256f7e5 | src/shared/monitoring/metrics-definitions.ts + src/modules/truck-hold/confirmed-hold.service.ts | EXACT (T09 — counter + 3 emit sites; disjoint from T08's hunk range) |
| 3f9e410b | .planning/review-2026-04-21/FIXES_APPLIED.md | EXACT (Guard Rail #6) |
| 50cd7756 | src/shared/services/socket.service.ts + src/shared/queue-processors/broadcast.processor.ts + src/shared/services/queue.service.ts + src/__tests__/durable-emit-contract.test.ts | EXACT (T11 — Phase 2 reader flip + DPDP replay filter + seq key role-scoping) |
| 9351d6ef | .planning/review-2026-04-21/FIXES_APPLIED.md | EXACT (Guard Rail #6) |
| 58a62a37 | .planning/review-2026-04-21/FIXES_APPLIED.md | EXACT (Guard Rail #6 — T12 DEFERRAL audit row per plan §13 bullet 5) |

### Frequency check (duplicate-file surface)

- `src/shared/services/socket.service.ts` appears in 5 commits (9be33c0b T01, f593e744 T13, f713c2a8 T05, 0a12a353 T10, 50cd7756 T11) — DISJOINT hunks per plan §7.3.1 acknowledged deviation. Serial ordering honoured: clock-anchor-owner landed T01 first (9be33c0b — withSocketMeta signature), then role-scoped-zset-owner T13 observability (f593e744 — adapter-init warn), then clock-anchor-owner T05 flag gate (f713c2a8 — deadlineMs flag-gated), then role-scoped-zset-owner T10 Phase 1 dual-write (0a12a353), finally T11 Phase 2 reader flip (50cd7756). Two-owner ordering mitigation per plan §7.3.1 acknowledged file-overlap rule.
- `src/modules/truck-hold/confirmed-hold.service.ts` appears in 3 commits (13e1da5c T04 clock-anchor, b2b9342d T08 outbox-fanout-owner, a256f7e5 T09 outbox-fanout-owner) — DISJOINT line ranges per plan §7.3.1 (T04 ~472-525 socket emit, T08 ~260-370 tx block + 472-577 fanout loop, T09 fanout-loop observability additives). Serial ordering honoured: T04 landed first (13e1da5c); T08 rebased (b2b9342d); T09 additive observability (a256f7e5).
- `src/shared/config/feature-flags.ts` appears in 3 commits (f713c2a8 T05 FF_SERVER_CLOCK_ANCHOR + FLAG registration, 0a12a353 T10 FF_ROLE_SCOPED_DURABLE_EMIT, b2b9342d T08 FF_TRIP_ASSIGNED_FANOUT_OUTBOX_ENABLED) — DISJOINT hunks (three separate FLAG entries) acknowledged deviation, content-correct and non-conflicting.
- `src/shared/monitoring/metrics-definitions.ts` appears in 3 commits (f593e744 T13 socket_adapter_no_pel_reclaim_total, 0a12a353 T10 socket_unacked_key_version + socket_unacked_dual_write_fail_total, a256f7e5 T09 confirmed_hold_fanout_total) — DISJOINT hunks (4 separate counter registrations appended to `registerDefaultCounters`), content-correct.
- `src/modules/order/order-accept.service.ts` appears in 2 commits (76ff0566 T14 line 476 log, 49d3c2aa T16 lines 531-548 socket payload) — DISJOINT hunks (log call vs. socket payload literal).
- `src/__tests__/durable-emit-contract.test.ts` appears in 2 commits (a160177d Guard Rail #1 remediation + 50cd7756 T11 Phase 2 test cases) — DISJOINT additions (5 Phase-1 atomicity cases in a160177d, 3 Phase-2 seq-key cases in 50cd7756).
- `src/__tests__/role-scoped-zset-phase1-atomicity.test.ts` appears in 2 commits (0a12a353 CREATE — Guard Rail #1 violation, a160177d GIT RM remediation) — net-zero filesystem effect; see Deviation #2.
- `.planning/review-2026-04-21/FIXES_APPLIED.md` appears in 10 commits — expected per plan §12 Guard Rail #6 (append-only).
- Top-level `FIXES_APPLIED.md` appears in 3 commits (a610cdf0 + b689cd5e + 75972fe5) — see Deviation #1. File still present on disk (1041 B) as of T20 sign-off; canonical-path file at `.planning/review-2026-04-21/FIXES_APPLIED.md` (44 rows) carries the authoritative record.

## Contamination checks

### Check 4 — Customer-app contamination (must be empty)

Command: `git log --name-only fix/critical-broadcast-reliability-2026-04-21 ^e8011b96 | grep -iE "weelo.captain|/Weelo/|/weelo/(app|Weelo)"`

Result: EMPTY — PASS

### Check 5 — Review-artifact contamination (only FIXES_APPLIED.md allowed)

Command: `git log --pretty=format: --name-only fix/critical-broadcast-reliability-2026-04-21 ^e8011b96 | grep -v '^$' | grep ".planning/review-2026-04-21/" | grep -v "FIXES_APPLIED.md"`

Result: EMPTY — PASS

### Check 6 — AWS/infra contamination (must be empty)

Command: `git log --pretty=format: --name-only fix/critical-broadcast-reliability-2026-04-21 ^e8011b96 | grep -v '^$' | grep -E '\.tf$|\.hcl$|docker-compose|ecs-task-definition|cdk|/deploy/'`

Result: EMPTY — PASS

## All-new-flags-default-OFF assertion (per lead directive — Wave-3 required item #2)

Verified by direct file read at `src/shared/config/feature-flags.ts`:

| Flag | Env | Line | Category | `defaultValue` |
|------|-----|------|----------|----------------|
| `FCM_DATA_ONLY_FULLSCREEN` | `FF_FCM_DATA_ONLY_FULLSCREEN` | 310-315 | `release` | `false` (landed Wave-2 d2832c31) |
| `SERVER_CLOCK_ANCHOR` | `FF_SERVER_CLOCK_ANCHOR` | 324-329 | `release` | `false` (landed f713c2a8 T05) |
| `ROLE_SCOPED_DURABLE_EMIT` | `FF_ROLE_SCOPED_DURABLE_EMIT` | 343-348 | `release` | `false` (landed 0a12a353 T10) |
| `TRIP_ASSIGNED_FANOUT_OUTBOX_ENABLED` | `FF_TRIP_ASSIGNED_FANOUT_OUTBOX_ENABLED` | 546-551 | `release` | `false` (landed b2b9342d T08) |

Verdict: **PASS** — all four new flags default OFF. Invariant assertions in `src/__tests__/dual-channel-default-true.test.ts` to be added under T22.

## Commit-body compliance check (per lead directive — Wave-3 required item #3)

Wave-2 had a commit-body format lapse (T10 58459176 + T11 7990ea77 landed subject-line-only, mitigated in Wave-2 gate §Deviations #3). For Wave-3, I ran:

```
for sha in <17 fix SHAs>; do
  body=$(git log --format="%b" -1 $sha)
  Evidence=$(echo "$body" | grep -ciE "evidence:")
  Rollback=$(echo "$body" | grep -ciE "rollback:")
done
```

Results:

| SHA | Evidence | Rollback |
|-----|----------|----------|
| 50cd7756 (T11 Phase 2) | ✅ | ✅ |
| a256f7e5 (T09 observability) | ✅ | ✅ |
| b2b9342d (T08 tx producer write) | ✅ | ✅ |
| a160177d (Guard Rail #1 remediation) | ❌ | ❌ |
| 0a12a353 (T10 Phase 1) | ✅ | ✅ (2 Rollback lines) |
| adb24fc6 (T07 dispatcher) | ✅ | ✅ |
| fc8e86e1 (T06 type) | ✅ | ✅ |
| f713c2a8 (T05 flag gate) | ✅ | ✅ |
| 13e1da5c (T04 confirmed-hold emit) | ✅ | ✅ |
| 3d712c59 (T03 reassign+cascade) | ✅ | ✅ |
| f593e744 (T13 observability) | ✅ | ✅ |
| abf34cd8 (T02 flex-hold emit) | ✅ | ✅ |
| 49d3c2aa (T16 order-accept pre-accept) | ✅ | ✅ |
| 9be33c0b (T01 withSocketMeta) | ✅ | ✅ |
| b34c4a77 (T15 broadcast-accept pre-accept) | ✅ | ✅ |
| 8128d634 (T17 route guard) | ✅ | ✅ |
| 76ff0566 (T14 driverName log) | ✅ | ✅ |

Compliance ratio: **16/17 (94 %)** — substantial improvement over Wave-2 (9/11 = 82 %). Only exception is a160177d (Guard Rail #1 fix-forward remediation), which lacks the `Evidence:` / `Rollback:` headers but provides a detailed prose explanation of the fix-forward reasoning (plan §2 Guard Rail #1 violation, lead-approved Option A, 5 test cases ported, git rm of new file). Since the commit is a test-file relocation (no runtime code change), the missing template headers are non-blocking — the decision rationale is adequately captured.

Verdict: **PASS** (commit-body compliance materially better than Wave-2).

## W3-T18 / W3-T19 (Captain Kotlin) + T22 (invariants test) — still-pending items at T21 green-gate (per lead directive — Wave-3 required item #4)

Per plan §7.3.1 Arch 1C amendment, the Captain Kotlin edits (W3-T18 `TruckHoldApiService.kt` data class addition + W3-T19 `./gradlew :app:assembleDebug` verify) are **NOT in the Agent-Teams roster** — they are spawned by the team lead as subagents via the `Agent` tool AFTER the Wave-3 green-gate (§7.3.5 step 2). As of this T20 sign-off, neither task has been started. Status:

- **W3-T18 (Captain data class)**: PENDING — awaiting lead subagent spawn post-T21 cleanup. Captain repo path: `/Users/nitishbhardwaj/Desktop/weelo captain` (literal space). Target file: `app/src/main/java/com/weelo/logistics/data/api/TruckHoldApiService.kt`. Backend route guard (T17 8128d634) is in place, so Captain commit may land any time; no dependency on wave cleanup other than subagent mechanics.
- **W3-T19 (Captain Gradle build)**: PENDING — depends on T18.
- **W3-T22 (invariants test extension)**: PENDING — blocked by T21 (green-gate run), which in turn is blocked by this T20 sign-off. T22 deliverable: extend `src/__tests__/dual-channel-default-true.test.ts` with 4 flag-default-OFF invariants for `FF_FCM_DATA_ONLY_FULLSCREEN`, `FF_SERVER_CLOCK_ANCHOR`, `FF_TRIP_ASSIGNED_FANOUT_OUTBOX_ENABLED`, `FF_ROLE_SCOPED_DURABLE_EMIT`. `npx jest src/__tests__/dual-channel-default-true.test.ts` to pass.

Together these three items represent the remaining Wave-3 tail. Plan §7.3.5 step 10 cleanup is gated on T21 (§7.3.5 step 8 — green-gate) + T22 (invariants test) completing in-session; T18 + T19 happen in a fresh lead-driven subagent session after cleanup.

## T12 Phase 3 deferral documentation (per lead directive — Wave-3 required item #1)

Plan §13 bullet 5 explicitly acknowledges the 3-phase ZSET rollout may span multiple sessions when the 24 h staging soak intrudes. Per plan `W3-T12` (Phase 3 cutover — remove old-key write) is authorisable only after 24 h staging soak evidence that no readers still hit `socket:unacked:{userId}` (old key). Observed outcome:

- Phase 1 landed in 0a12a353 (2026-04-22): atomic MULTI/EXEC dual-write to OLD + NEW keys; reader + ACK purger still on OLD key.
- Phase 2 landed in 50cd7756 (2026-04-22): reader + ACK purger flip to NEW key; dual-write preserved for rollback; replay DPDP filter drops cross-role envelopes.
- Phase 3 (W3-T12) explicitly DEFERRED via commit 58a62a37 documentation row in `.planning/review-2026-04-21/FIXES_APPLIED.md` line 44: *"Phase 3 cutover (remove old-key write) DEFERRED to a separate single-teammate session per plan §13 bullet 5. Requires 24 h staging soak evidence that no readers still hit socket:unacked:{userId}. Phase 1 (0a12a353) + Phase 2 (50cd7756) dual-write + reader-flip state is production-safe as landed."*

This is the plan-authorised deferral pattern, NOT a deviation. The current state (Phase 1 + Phase 2 landed, Phase 3 deferred) is production-safe because:
1. `FF_ROLE_SCOPED_DURABLE_EMIT` defaults OFF — no behavioural change until ops flips it.
2. With flag ON, reader uses NEW key (`socket:unacked:{userId}:{role}`); dual-write keeps OLD key populated for instant rollback by flipping flag OFF.
3. Staging soak window provides operational confidence before Phase 3 cutover removes the OLD-key write.

Verdict: PLAN-AUTHORISED DEFERRAL, not a Wave-3 deviation.

## Deviations (per plan §13)

### Deviation #1 — FIXES_APPLIED.md rows written to top-level path (3 commits, not self-corrected)

- Plan intent (Guard Rail #6): append-only edits must go to `.planning/review-2026-04-21/FIXES_APPLIED.md`.
- Observed: 3 commits by clock-anchor-owner wrote rows to top-level `FIXES_APPLIED.md` at repo root:
  - a610cdf0 (docs: "create FIXES_APPLIED.md with A03-003 W3-T01 row") — 13 lines
  - b689cd5e (docs: "append A03-003 W3-T02/T03/T04 FIXES_APPLIED rows") — 3 lines
  - 75972fe5 (docs: "append A03-003 W3-T05 FIXES_APPLIED row") — 1 line
- Content check: `ls -la /Users/nitishbhardwaj/Desktop/weelo-backend/FIXES_APPLIED.md` → file exists (1041 B, 14 lines — 5 A03-003 rows + 9 lines of header/framing). Content is byte-consistent with what was eventually appended to the canonical path file (rows visible in canonical-path file lines 13-45 verify the same findings are captured at both locations).
- Severity: This differs from Wave-2 Deviation #2 (which self-corrected via revert within 3 commits) — Wave-3's wrong-path writes were NOT reverted. The top-level file remains on disk at T20 sign-off. The canonical-path file at `.planning/review-2026-04-21/FIXES_APPLIED.md` carries the authoritative 44-row record (including the 5 A03-003 rows that were duplicated at the wrong path).
- Mitigation: Subsequent docs commits (1951c677 pii-logs-owner pack, 00be6a3e T13 adapter row, 09723577 T06, 28f58b47 T07, 636d70f4 T10, b86625ab Guard Rail remediation, 437986b1 T08, 3f9e410b T09, 9351d6ef T11, 58a62a37 T12 deferral) all correctly target the canonical `.planning/review-2026-04-21/FIXES_APPLIED.md` path. Net information is preserved at the correct location.
- Recommended follow-up (non-blocking for T21): a cleanup commit removing the duplicate top-level `FIXES_APPLIED.md` and keeping only the canonical-path file. Can be deferred to T21 green-gate or a separate housekeeping task.
- Verdict: PATH deviation; content-preserved at canonical path; duplicate residue on disk. Non-blocking. Documented as a cautionary repeat of Wave-2 Deviation #2 — the Wave-1/Wave-2 lesson ("use `git commit -- <pathspec>`") did not fully propagate to clock-anchor-owner's first three Wave-3 docs commits.

### Deviation #2 — Guard Rail #1 violation: new test file created in 0a12a353, then remediated via fix-forward in a160177d

- Plan intent (§2 Guard Rail #1): the ONLY new file permitted in the entire 3-wave plan is `migrations/M-017-truck-hold-ledger-active-find-index.sql` (landed in Wave-1). All other tests must extend existing files.
- Observed: role-scoped-zset-owner's T10 Phase-1 commit 0a12a353 included `src/__tests__/role-scoped-zset-phase1-atomicity.test.ts` as a NEW file — 5 Arch 1B atomicity test cases covering MULTI/EXEC pipeline abort semantics, error throwing from `durableEmit`, counter increment, and key-version metric non-increment on abort. This violates Guard Rail #1.
- Detection + remediation: Reviewer or role-scoped-zset-owner (commit body + b86625ab docs note attribute discovery) identified the violation. Lead-approved fix-forward Option A: port the 5 cases verbatim into existing `src/__tests__/durable-emit-contract.test.ts`, extend the existing mock harness (mockIncrementCounter spy, mockRedisMulti, mockZSets, mockMultiExecImpl), and `git rm` the disallowed file. Commit a160177d executes this remediation with detailed commit body documenting the rationale.
- Content check: post-remediation, `ls src/__tests__/role-scoped-zset-phase1-atomicity.test.ts` → no file on disk. `grep -n "Phase 1 role-scoped ZSET atomicity" src/__tests__/durable-emit-contract.test.ts` → hit present (per commit body describe block). `npx jest --testPathPattern=durable-emit-contract` → 21 tests (16 original + 5 ported) expected to pass per commit-body claim.
- Mitigation: 0a12a353 runtime code (socket.service.ts, redis.service.ts, feature-flags.ts, metrics-definitions.ts) is untouched by the remediation — it remains correct and deployed. Only the test-file location changed. b86625ab FIXES_APPLIED.md row explicitly names the Guard Rail #1 violation and the remediation commit.
- Verdict: GUARD RAIL violation; fix-forward executed within the same session; no runtime risk; audit trail preserved via 3 commits (0a12a353 violation + a160177d remediation + b86625ab docs). Non-blocking, but the initial violation is a material process deviation — the eng-review's plan-approval gate for W3-T10 (plan §7.3.4 Wave-3 gates) should have caught the `NEW file` in the 10-line plan before commit; presumably the teammate's plan listed the new file and the lead approved under time pressure.

### Deviation #3 — a160177d lacks Evidence/Rollback template headers (16/17 compliance, material improvement vs Wave-2)

- Plan intent (§12): every `fix(critical): ...` commit body must carry Evidence + Rollback sections per the template.
- Observed: commit a160177d is a `fix(critical): A09-002 A12-009 — port Phase-1 atomicity tests into durable-emit-contract.test.ts per Guard Rail #1` with a detailed prose body describing the fix-forward rationale, but no formal `Evidence:` / `Rollback:` headers. All other 16 fix commits comply with the template.
- Mitigation: commit body text describes what was ported (5 atomicity cases), why (plan §2 Guard Rail #1), and the test count impact (21 pass = 16 original + 5 ported). Rollback implied: `git revert a160177d` restores the disallowed new file — but the runtime code is unchanged by this commit, so there is no operational rollback concern. b86625ab FIXES_APPLIED.md row provides further audit context.
- Verdict: Non-blocking format deviation on a single test-file-relocation commit; Wave-3 compliance (16/17 = 94 %) materially better than Wave-2 (9/11 = 82 %). Documented for final retrospective.

### Deviation #4 — W3-T18 + W3-T19 (Captain Kotlin) PENDING at T20 sign-off (plan-authorised, not a scope deviation)

- Plan intent (§7.3.1 Arch 1C amendment): Captain Kotlin edits are spawned by the lead as subagents via the `Agent` tool AFTER the Wave-3 team green-gate completes. They are NOT part of the Wave-3 Agent-Teams roster and NOT counted toward the team cleanup.
- Observed: As of this T20 sign-off, W3-T18 + W3-T19 have not been started. This is **expected** per plan §7.3.5 step 2 (lead runs `./gradlew :app:assembleDebug` AFTER T22 invariants test and before cleanup).
- Verdict: PLAN-AUTHORISED DEFERRAL (not a deviation).

### Note on plan §13 acknowledged deviations — file-overlap on `socket.service.ts` + `confirmed-hold.service.ts` + `feature-flags.ts` + `metrics-definitions.ts`

Per plan §13 bullet 1, `socket.service.ts` and `confirmed-hold.service.ts` are **planned** file-overlaps with serial-ordering mitigation. Additionally, `feature-flags.ts` and `metrics-definitions.ts` are aggregation files naturally edited by multiple teammates adding disjoint entries (new FLAG constants, new counter registrations). Observed serialisation on `socket.service.ts`:

1. clock-anchor-owner T01 (9be33c0b) — withSocketMeta + durableEmit signature (lines ~1480-1494 + ~1571-1588 + ~1597).
2. role-scoped-zset-owner T13 (f593e744) — setupRedisAdapter observability (line ~1397-1416).
3. clock-anchor-owner T05 (f713c2a8) — flag-gate deadlineMs stamp inside withSocketMeta.
4. role-scoped-zset-owner T10 (0a12a353) — Phase 1 dual-write on durableEmit (lines ~1205, 1241, 1575, 1584, 1661, 1669 disjoint from 1480-1494).
5. role-scoped-zset-owner T11 (50cd7756) — Phase 2 reader flip + ACK purger + seq key role-scoping.

All line ranges disjoint per plan §7.3.1 acknowledged multi-owner pattern. Similarly for `confirmed-hold.service.ts` (3 commits, disjoint hunks) and the 2 aggregation files (`feature-flags.ts`, `metrics-definitions.ts` — each teammate appends disjoint FLAG/counter entries).

## Verdict

**PASS** — with 3 non-blocking deviations (1 PATH issue not self-corrected but content-preserved, 1 Guard-Rail #1 violation remediated via fix-forward, 1 minor commit-body format lapse on the remediation commit itself), 1 plan-authorised deferral (W3-T18 + W3-T19 Captain Kotlin), 1 plan-authorised phase deferral (W3-T12 Phase 3 cutover — 24 h staging-soak gate), and zero contamination findings.

All 10 Wave-3 findings (A03-003, A03-004, A13-005, A09-001, A12-008, A12-002, A09-002, A12-009, A01-004, A04-003) have landing commits with traceable attribution; no customer-app / review-artifact / AWS-infra contamination; file-ownership is either exact, content-equivalent, or falls under the plan §7.3.1 acknowledged multi-owner serial-ordering rule for `socket.service.ts` and `confirmed-hold.service.ts`; all four new feature flags default OFF verified by direct file read.

Ready for T21 green-gate.

---
