# Phase 3 Wave 2 — F-A-76 Test Migration Enumeration & BLOCKER Report

**Agent:** W2-1
**Date:** 2026-04-17
**Task:** Migrate tests that `fs.readFileSync(<split-hold-file>)` to read the monolith `truck-hold.service.ts` so that Phase 4 can delete the 5 split files.
**Outcome:** **FULL HALT — all 14 candidate test files are BLOCKERS. Zero migrations performed.**

---

## 1. Enumeration — 14 test files that read split-hold source

Discovery command:
```bash
grep -rln "fs\.readFileSync" src/__tests__/ | xargs grep -l \
  "truck-hold-create\|truck-hold-confirm\|truck-hold-release\|truck-hold-cleanup\|truck-hold-crud"
```

| # | Test file | readFileSync refs | require/jest.mock refs | Split targets |
|---|---|---|---|---|
| 1 | `src/__tests__/critical-22-hold-system.test.ts` | 5 | 0 | confirm |
| 2 | `src/__tests__/critical-fix-hold-system.test.ts` | 8 | 0 | confirm, cleanup |
| 3 | `src/__tests__/tiger-hold-hardening.test.ts` | 21 | 3 | confirm, cleanup, store (non-delete) |
| 4 | `src/__tests__/tiger-assignment-hardening.test.ts` | 2 | 0 | confirm |
| 5 | `src/__tests__/high-medium-notif-quality.test.ts` | 3 | 0 | cleanup |
| 6 | `src/__tests__/high-medium-hold-system.test.ts` | 3 | 0 | cleanup, store (non-delete) |
| 7 | `src/__tests__/fix-phone-masking-other.test.ts` | 5 | 0 | confirm |
| 8 | `src/__tests__/falcon-fi6-error-handling.test.ts` | 1 | 0 | cleanup |
| 9 | `src/__tests__/medium-fix-hold-assignment.test.ts` | 5 | 4 | confirm, cleanup, release, store |
| 10 | `src/__tests__/eagle-i7-hold-system.test.ts` | 6 | 3 | create, release, cleanup, store |
| 11 | `src/__tests__/qa-phone-masking-comprehensive.test.ts` | 6 | 0 | confirm |
| 12 | `src/__tests__/qa-endpoint-contracts.test.ts` | 1 | 1 | crud |
| 13 | `src/__tests__/critical-fixes-locks.test.ts` | 1 | 0 | create |
| 14 | `src/__tests__/critical-12-rio-fixes.test.ts` | 4 | 0 | cleanup |

Note: `src/__tests__/truck-hold-single-surface-wrapper.test.ts` is the legitimate F-A-76 thin-wrap GUARD (28 tests all green) — **not** migrated by design, since it exists specifically to validate the strangler intermediate state and will be deleted alongside the split files in Phase 4.

Count: **14 test files** (matches CLAUDE.md estimate).

---

## 2. BLOCKER Matrix — Fix markers present in split files but MISSING from monolith

The W2-1 protocol requires: *"If pattern X exists ONLY in the split file (wrapper-specific marker), document the discrepancy and REPORT instead of migrating — it means the split file has unique content the monolith doesn't cover. That's a Phase-4 blocker to flag."*

### 2.1 Confirm-hold saga markers — ONLY in `truck-hold-confirm.service.ts`

| Pattern | Monolith | Split (confirm) | Migration feasible? |
|---------|----------|-----------------|---------------------|
| `hold:confirm:lock:${holdId}` | 0 | 1 | NO |
| `if (!lock.acquired)` | 0 | 1 | NO |
| `hold:confirm:${holdId}` (idempotency cache key) | 0 | 2 | NO |
| `Confirmation already in progress` | 0 | 1 | NO |
| `acquireLock(lockKey, transporterId, 30)` | 0 | 1 | NO |
| `releaseLock(lockKey, transporterId).catch` | 0 | 1 | NO |
| `FINALIZE_RETRY_DELAYS_MS` | 0 | 6 | NO |
| `const FINALIZE_RETRY_DELAYS_MS = [500, 1000, 2000]` | 0 | 1 | NO |
| `setTimeout(resolve, FINALIZE_RETRY_DELAYS_MS[attempt])` | 0 | 1 | NO |
| `terminalReason: 'NEEDS_FINALIZATION'` | 0 | 1 | NO |
| `queueService.enqueue('hold:finalize-retry'` | 0 | 1 | NO |
| `TERMINAL_ORDER_STATUSES.has(currentOrder.status)` | 0 | 1 | NO |
| `throw new Error(\`ORDER_TERMINAL:${currentOrder.status}\`)` | 0 | 1 | NO |
| `msg.startsWith('ORDER_TERMINAL:')` | 0 | 1 | NO |
| `cancelled or completed` | 0 | 1 | NO |
| `await redisService.set(idemKey, JSON.stringify(result)` | 0 | 1 | NO |
| `Assignment timeout scheduling FAILED` | 0 | 1 | NO |
| `Non-fatal: L3 DB reconciliation will catch` | 0 | 1 | NO |
| `validateHoldForConfirmation(` (helper saga step) | 0 | 3 | NO |

### 2.2 Cleanup service markers — ONLY in `truck-hold-cleanup.service.ts`

| Pattern | Monolith | Split (cleanup) | Migration feasible? |
|---------|----------|-----------------|---------------------|
| `CLEANUP_GRACE_PERIOD_MS = 5000` | 0 | 1 | NO |
| `expiresAt: { lt: graceCutoff }` | 0 | 1 | NO |
| `terminalReason: null,` | 0 | 1 | NO |
| `async function processExpiredHoldsOnce()` | 0 (monolith has method, not top-level function) | 1 | NO |
| `last_purge_ts` | 0 | 2 | NO |

### 2.3 Create service markers — ONLY in `truck-hold-create.service.ts`

| Pattern | Monolith | Split (create) | Migration feasible? |
|---------|----------|----------------|---------------------|
| `saveIdempotentOperationResponse` (top-level export) | 0 | — | NO — tests `require(...truck-hold-create.service)` at runtime |

### 2.4 CRUD routes markers — ONLY in `truck-hold-crud.routes.ts`

| Pattern | Monolith (service) | Split (crud routes) | Migration feasible? |
|---------|--------------------|--------------------|---------------------|
| `truckHoldCrudRouter` Express router | n/a (monolith is service, not routes) | 1 | NO — no equivalent in service file |

### 2.5 Markers that DO exist in monolith (migration-compatible subset)

A small subset of patterns is mirrored in both:

| Pattern | Monolith | Split | Migration possible (isolated)? |
|---------|----------|-------|-------------------------------|
| `status: 'confirmed'` | 2 | 1 | Yes, but bundled with non-migratable markers above |
| `truckHoldLedger.findFirst` | 2 | 2 (create) | Yes, but same test block also asserts `FLEX_HOLD_CONFLICT` in split |
| `FLEX_HOLD_CONFLICT` | 1 | 1 (create) | Yes, but same test block also asserts create-only markers |
| `hold:cleanup:unified` | 2 | 2 (cleanup) | Yes, but same test block asserts cleanup-only constants |
| `TERMINAL_ORDER_STATUSES.has` | 2 | 1 (confirm) | Yes (for tests that only check this marker) |

None of the 14 files contain an assertion block that uses ONLY patterns from 2.5 — every block mixes migratable and non-migratable markers. Partial migration would leave mixed `fs.readFileSync` targets in the same test file, which violates the "atomic migration" principle and would confuse a Phase-4 delete sweep.

---

## 3. Root cause analysis

The split files are **NOT thin-wrap stubs** despite the header comment claiming "Strangler Fig thin-wrap". They still carry the FULL production implementations:

| File | Line count | Header claim | Reality |
|------|------------|--------------|---------|
| `truck-hold-confirm.service.ts` | 836 | "DEPRECATED thin-wrap" | Full saga: validate → build → execute → notify → finalize → retry (8 steps) |
| `truck-hold-create.service.ts` | 568 | "DEPRECATED thin-wrap" | Full createFlexHold / saveIdempotentOperationResponse logic |
| `truck-hold-release.service.ts` | 272 | "DEPRECATED thin-wrap" | Full release with CAS guard |
| `truck-hold-cleanup.service.ts` | 252 | "DEPRECATED thin-wrap" | Full cleanup with unified lock + grace period + purge |
| `truck-hold-crud.routes.ts` | 244 | "DEPRECATED thin-wrap" | Full Express router with controller wiring |

The monolith `truck-hold.service.ts` (2432 lines) carries a **different, older** implementation of some of these paths (e.g., it has its own `confirmHoldWithAssignments` at line 1106) that does NOT include the Phase 3 hardening fixes (FINALIZE_RETRY_DELAYS_MS, hold:confirm:lock lock key, NEEDS_FINALIZATION compensation, PG serializable ORDER_TERMINAL guard, etc.).

Per Phase 3 commit `edfbbeb` ("refactor(hold): mark 5 split hold services as F-A-76 thin-wrap (Phase 4 delete target)"): only the **headers** were marked deprecated. The **implementations** were not moved into the monolith.

---

## 4. What Phase 4 must do BEFORE it can delete the split files

The original Phase-4 delete-after-soak plan is incomplete. Before deletion, one of the following **code migrations** must happen:

### Option A — Port all production fixes into the monolith (Recommended)

For each of the 5 split files, copy the hardened implementation into the monolith, overwriting the older monolith version. Specifically:

1. `truck-hold-confirm.service.ts` → replace `truckHoldService.confirmHoldWithAssignments` in monolith with split file's saga, preserving:
   - `FINALIZE_RETRY_DELAYS_MS` retry loop
   - `hold:confirm:lock:${holdId}` distributed lock (with 30s TTL, finally-block release)
   - `hold:confirm:${holdId}` idempotency cache (with `saveIdempotentOperationResponse`)
   - `NEEDS_FINALIZATION` compensation + `queueService.enqueue('hold:finalize-retry', ...)`
   - `TERMINAL_ORDER_STATUSES.has(currentOrder.status)` PG-serializable guard
   - `Assignment timeout scheduling FAILED` non-fatal try/catch for `scheduleAssignmentTimeout`

2. `truck-hold-create.service.ts` → replace `truckHoldService.holdTrucks` in monolith, preserving:
   - `FLEX_HOLD_CONFLICT` dedup check via `truckHoldLedger.findFirst`
   - `saveIdempotentOperationResponse` + `tryGetIdempotentResponse`

3. `truck-hold-cleanup.service.ts` → replace `startCleanupJob` logic in monolith, preserving:
   - `CLEANUP_GRACE_PERIOD_MS = 5000` grace window
   - `expiresAt: { lt: graceCutoff }` timing guard
   - `last_purge_ts` Redis key (with `HOLD_IDEMPOTENCY_PURGE_INTERVAL_MS` + `hold-idempotency-purge` lock)
   - `processExpiredHoldsOnce()` top-level function shape (currently the monolith uses a method)
   - `terminalReason: null,` reset on reconciliation

4. `truck-hold-release.service.ts` → replace `truckHoldService.releaseHold` in monolith.

5. `truck-hold-crud.routes.ts` → mount its Express router alongside the existing `truck-hold.routes.ts` — or delete after verifying the monolith routes file covers the same surface.

**Scope:** ~2 100 lines of port work + full test re-run. Treat as a Phase-4 coding slice, not a deletion sweep.

### Option B — Keep split files permanently

Revert the "thin-wrap" deprecation markers and accept the split layout as the canonical structure. This abandons the F-A-76 cleanup goal but is the safest option if time budget is tight.

### Option C — Rewrite tests to use behavioral assertions, not source-text assertions

Replace `fs.readFileSync(...).toContain(marker)` with runtime behavior tests (e.g., spy on `queueService.enqueue`, assert call args include `'hold:finalize-retry'`). This makes tests agnostic to which source file implements the logic. Scope: ~200 source-text assertions across 14 files → high effort, high value.

---

## 5. Phase 4 merge gate

Do NOT open a PR that deletes the 5 split files until ONE of the following is true:

1. **Option A complete** — all fix markers from §2.1–2.4 grep-verified in `truck-hold.service.ts`, all 14 listed tests still green after repointing, AND `truck-hold-single-surface-wrapper.test.ts` deleted together.
2. **Option C complete** — `grep -rn "fs.readFileSync.*truck-hold-" src/__tests__/` returns zero hits AND all behavior tests green.

Merge-gate SHA check: `git log --oneline -- src/modules/truck-hold/truck-hold.service.ts | grep "port.*F-A-76"` must show the port commit before the delete commit.

---

## 6. Actions Taken by W2-1

- Enumerated 14 test files (§1).
- Extracted ~40 unique fix markers from `fs.readFileSync(...).toContain(...)` assertions.
- Cross-referenced each marker against `truck-hold.service.ts` and the 5 split files.
- Found ≥19 markers that exist ONLY in split files.
- **Zero** migrations performed. **Zero** source files edited. **Zero** split files deleted.
- Baseline test `src/__tests__/truck-hold-single-surface-wrapper.test.ts`: 28 pass, 0 fail.
- Pre-existing `tsc --noEmit`: 9 errors (unchanged by this task).

---

## 7. Recommendation

**HOLD Phase 4 split-delete.** Open a Phase-4 predecessor slice: "F-A-76 Port — consolidate 5 split-file fix markers into monolith". Only after that slice merges and soaks should the delete sweep execute.

If Phase 4 proceeds to delete the split files without porting the fixes:
- 14 existing tests will fail to load (ENOENT on readFileSync) OR be silently skipped.
- 3 tests that `require('...truck-hold-confirm.service')` at runtime will crash.
- Production code that currently routes through the split files will lose fix coverage (PRs landed between 2026-03-22 and 2026-04-17).

**Signed-off:** W2-1 agent, 2026-04-17.
