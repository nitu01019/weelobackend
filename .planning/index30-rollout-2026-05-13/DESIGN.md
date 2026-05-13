# DESIGN — Ship 29 Fixes from `index-30-validated.md` (Phased Rollout)

**Date:** 2026-05-13
**Author:** Lead (Opus 4.7, 1M context) with user direction
**Source:** `/Users/nitishbhardwaj/Downloads/index-30-validated.md` (10,320 lines, 9 rounds of validation, 89 attestations)
**Baseline HEAD:** `a43aebea5d4712ddae47075f31f80f5f0372cced` (verified unmoved at design time)
**Trunk branch:** `fix/critical-broadcast-reliability-2026-04-21`
**Total work:** 28 actionable DOs + 1 pre-flight phase = 8 commits / 8 PRs

> **Note on count.** Source doc's Lead Action Ledger says **29 DO**. Round-4-A's empirical h3-js v4.4.0 reproduction (Sophie verified) drops **#16** because `compactCells(gridRingUnsafe(...))` = **1.00× on ring shape** — no compaction, the matcher uses rings not disks. Net rollout: **28 DOs**. If you want #16 included anyway, fold it into Phase 7 (becomes 5 fixes in that phase) — say the word before Phase 0 starts.

---

## §0 — Scope & Out-of-Scope

### IN SCOPE — 28 DO items shipped across 7 phases

`#1, #2, #3, #5, #6, #7, #8, #9, #10, #11, #12, #13, #14, #15, #18, #19, #20, #21, #22, #23, #24b, #25, #25b, #26, #27, #28, #29, #30`

### OUT OF SCOPE — documented in Phase 0, no code change

| # | Verdict | Reason |
|---|---|---|
| #4 | FALSE-POSITIVE | Node project, not Ruby. `progressive-radius-matcher.ts:70-77` already 6 checkpointed steps each ≤15s. |
| #16 | DROPPED by Round-4-A | Empirically proven via h3-js v4.4.0: `compactCells(gridRingUnsafe(...))` = 1.00× on rings. Matcher uses `gridRingUnsafe` not `gridDisk`. |
| #17 | WAIT — re-eval trigger | Re-eval when `redis_sunion_command_duration_p99` > 50ms @ >1.2K RPS sustained 5 min, OR pre-Diwali. |
| #24 | ALREADY-DONE | 4 idempotency tables exist at schema.prisma:472,535,597,788. Locks ≠ idempotency — both needed. |

### Decisions baked in (from user Q&A 2026-05-13)

- ✅ **Approach C** — 1 team of 8 per phase + lead-driven Codex/red-team/tests
- ✅ **FE-tolerant additive** — backend ships now, no FE pause; all changes are additive headers/fields/events
- ✅ **Separate Phase 0** — lead-only pre-flight (no team)
- ✅ **One PR per phase** — 8 PRs total (Phase 0 + 7), sequential merge

---

## §1 — The 7-Phase Plan

| Phase | Theme | Fixes (4 each) | Sequencing chain | Time est. |
|:--:|---|---|---|:--:|
| **0** | Pre-flight (lead-only) | Dockerfile.production aws-cli · Lua whitespace `#3↔#22` · SKIP/WAIT register | — | ~1h |
| **1** | P1 + Ops guardrails | **#21**, #26, #25b, #28 | — | ~2h |
| **2** | Migration chain | #25, #30, #27, #24b | #26→#25→#30 | ~2.5h |
| **3** | Lock primitives | #22, #23, #3, #2 | #22→#23; #2 needs #22 | ~3h |
| **4** | Queue durability | **#5**, #1, #10, #9 | — | ~3h |
| **5** | Backpressure + idempotency | #7, #6, #8, #29 | — | ~2.5h |
| **6** | Observability + logging | #19, #20, #18, #11 | #19→#20 | ~2.5h |
| **7** | Socket + AsyncAPI + Geo | #14, #12, #13, #15 | #14→#12 | ~3h |

**Total realistic:** 2-3 working days end-to-end.

### Phase grouping rationale

- **Phase 1 (P1 + Ops):** Isolates the only true P1 (#21 — 17-LOC delete). Pairs with low-coupling Ops items (#26 alias lockdown, #25b GIN CONCURRENTLY, #28 stale-flag).
- **Phase 2 (Migration chain):** Nexus sequence `#26→#25→#30`. #26 alias lockdown landed in Phase 1, so this phase ships #25 + #30 (same shell wrapper) + #27 + #24b.
- **Phase 3 (Lock primitives):** Bridge sequence `#22→#23`. #2 depends on #22's watchdog. #3 wires EVALSHA which #22's extendLock uses.
- **Phase 4 (Queue durability):** R2-flipped #5 (durability bug — 3 non-atomic Redis RTs). #1 autoscaler ties to broadcast_queue_depth. #9/#10 cron-style siblings.
- **Phase 5 (Backpressure + idempotency):** All FE-tolerant additive headers/fields. #29 enables future versioning.
- **Phase 6 (Observability + logging):** Lattice2 sequence `#19→#20` — errorCode taxonomy MUST precede 365d retention or PII retained 365d.
- **Phase 7 (Socket + AsyncAPI + Geo):** FE-coord cluster last. #14 CSR baseline before #12 drain (Sofia). #13 dual-channel needs backend eventId stamp.

---

## §2 — Phase 0 (Pre-Flight, Lead-Only, ~1h)

| Step | Action | Files | Verify |
|---|---|---|---|
| 0.1 | Apply `apk add aws-cli` to **both** `Dockerfile` AND `Dockerfile.production` (Codex-Delta BLOCK; entrypoint:L25 `aws s3 cp` also fixed) | `Dockerfile`, `Dockerfile.production` | `grep -n "aws-cli" Dockerfile Dockerfile.production` |
| 0.2 | Append "SKIP/WAIT register" section to `index-30-validated.md` with explicit log of #4/#16/#17/#24 reasons | `index-30-validated.md` | Section visible at bottom |
| 0.3 | Baseline snapshot: `npm run build`, `npm test`, `npm run lint` — record pre-state | — | Output captured to `.planning/index30-rollout-2026-05-13/baseline.txt` |
| 0.4 | Commit Phase 0: `fix(phase-0): pre-flight — Dockerfile.production aws-cli + SKIP/WAIT register` | — | `git log -1` |
| 0.5 | Push, open PR #1 | — | PR URL captured |

> **Lua whitespace fix for `extendLockLua` (Beacon FLAG)** — deferred to **Phase 3** when #22 wiring lands. Captured here so we don't lose track; the actual file edit happens in Phase 3 alongside #22's `withWatchdog`/`extendLock` helper.

**Phase 0 success criteria:** Both Dockerfiles have aws-cli, baseline tests green or known-yellow logged, SKIP/WAIT section appended, commit on branch, PR open.

---

## §3 — Per-Phase Pipeline (7 Gates)

Every Phase 1-7 follows this exact sequence. Total per-phase time: ~2-3 hours.

### Gate 1 — Team Spawn (1 team of 8)

Per `~/.claude/AGENT_TEAMS_GUIDE.md`:

| Member | Role | Model | Subagent type |
|---|---|---|---|
| `spec-pN-1` | Builder-1 (owns Fix A) | opus | general-purpose |
| `spec-pN-2` | Builder-2 (owns Fix B) | opus | general-purpose |
| `spec-pN-3` | Builder-3 (owns Fix C) | opus | general-purpose |
| `spec-pN-4` | Builder-4 (owns Fix D) | opus | general-purpose |
| `spec-pN-5` | TS-Reviewer | opus | typescript-reviewer |
| `spec-pN-6` | Code-Reviewer | opus | code-reviewer |
| `spec-pN-7` | Sec-Reviewer | opus | security-reviewer |
| `spec-pN-8` | TDD-Watcher | opus | tdd-guide |

Workflow:
1. `TeamCreate(team_name="phase-N-build", description="...")`.
2. `TaskCreate × 4` (one per fix) with descriptive subjects (not IDs — per memory `feedback_taskcreate_id_scramble`, specialists search by subject).
3. Builders self-claim, follow Anchor-Based Pasting Protocol (§4), apply Edit + write tests, SendMessage to lead.
4. Reviewers wait for builders' done-messages, then run their agent on cumulative diff.
5. TDD-Watcher reads each new test file, confirms it exercises the new code path (not a tautology).
6. Lead consolidates results, `TeamDelete`.

Hard rules (in every builder prompt):
- Use `model=opus` (per memory `feedback_model_opus_only`).
- NEVER edit `packages/contracts/` without `FRONTEND-COORDINATION-REQUIRED` flag.
- Out-of-scope files listed per-phase — do not read/touch.
- Cite file:line for every claim. Verify at `git show HEAD:`.
- No source edits in attestation prose; only Solution code goes to `src/`.

### Gate 2 — Codex Review (independent model voice)

After `TeamDelete`:
1. **`codex review`** on cumulative diff — pass/fail. Codex sees the diff fresh; no echo chamber.
2. **`codex challenge`** on diff — adversarial mode tries to break it with ≥3 concrete scenarios.

If FAIL or CHALLENGE finds bug: fix locally via Edit, re-run only the failed Codex pass (don't re-spawn team).

**Why both modes:** Round-9 Phase 4 — Codex-Delta caught the `#30 Dockerfile.production` BLOCK that all 4 Claude rounds missed. Different model lineage = different blind spots.

### Gate 3 — Red-Team (4 parallel Agent dispatches, lead-driven)

| Attacker | Lens | Sample scenarios |
|---|---|---|
| **Race-condition** | 300-500 RPS concurrent burst | Two pods write same idempotency key 0.5ms apart; double-dispatch via ZSET race; replay storm during reconnect |
| **Pod-restart** | SIGTERM/SIGKILL mid-operation | In-memory queue lost on restart; drain-marker SET fails silently; mid-Lua exit |
| **Redis-failover** | Cluster failover, NOSCRIPT cascade | EVALSHA after SCRIPT FLUSH; lock-extend at failover moment; pub/sub buffer overflow |
| **Cross-fix interaction** | Does this phase break prior phase's fix? | #12×#14 alarm storm; #3↔#22 Lua SHA divergence; #1+#2+#3 bandwidth math |

Each attacker returns: `VERDICT (PASS/NEEDS-FIX) + scenarios + file:line defeats`. If any NEEDS-FIX, lead Edits locally before commit.

Dispatched in a single message with 4 parallel `Agent` tool calls (per dispatching-parallel-agents discipline).

### Gate 4 — Full Local Test Suite

Lead runs sequentially:
1. `npm run build` (= `tsc` per package.json)
2. `npm test` (= `jest`)
3. `npm run lint` (= `eslint src/**/*.ts`)
4. Each Solution's "How to verify" command — run individually

All must pass. **No `it.skip()`, no `// @ts-ignore`** to mask failures (per memory `feedback_pearl_stash_blindspot`).

### Gate 5 — Manual Line-Drift Check

Lead reads each Edit'd file at HEAD:
- Anchor still matches the Solution's "What's there now"
- No semicolon collisions, no dup imports
- No dup function definitions (single source of truth)
- Imports resolve (no `Cannot find module`)

### Gate 6 — Commit

```bash
git add <touched files only — explicit listing, never -A or .>
git commit -m "fix(phase-N): <theme> — fixes #<list>

<one-line per fix bullet>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

Conventional commit format. Specific file paths to `git add` — never `git add -A` or `.` (per CLAUDE.md global rule).

### Gate 7 — Post-Commit Verification

Per memory `feedback_pearl_stash_blindspot`:
1. **Re-run tsc + jest at POST-commit HEAD** (NOT `git stash`; real HEAD).
2. Push branch (no `--force`).
3. Open PR with conventional title + body listing fixes + test plan.
4. Append "Phase N applied — HEAD `<sha>`" stamp to `index-30-validated.md`.

---

## §4 — Anchor-Based Pasting Protocol (Builder Discipline)

Every builder MUST follow this 6-step protocol for each fix:

1. **Read the Solution block in `index-30-validated.md`** (the `Solution:` code block inside the fix's section).
2. **Extract a unique anchor** — function signature, distinctive comment, full method header. Not raw line number.
3. **`grep -n "anchor text" path/to/file.ts`** — get the current line number at HEAD.
4. **Read 30-60 lines around the match.**
5. **Compare to the Solution's "What's there now" section.** If pre-state matches → proceed. If mismatch → STOP, send drift report to lead, do NOT Edit.
6. **Apply Edit** with exact `old_string`/`new_string` from the Solution block. Then write the "How to verify" test.

**Hard rule:** if a Solution targets a deprecated file (Mara's #6 catch — Round-9), the builder MUST verify the file is actively imported (`grep -rn "from.*<filename>" src/`) before Edit. If file is dead → flag to lead.

---

## §5 — Red-Team Attacker Prompts (Lead-Driven)

Each of the 4 red-team agents gets a self-contained prompt. Sample (Race-condition attacker):

```
You are the Race-Condition Adversarial Attacker for Phase N of the index-30
rollout. The phase commit is at <sha>, touching files <list>.

YOUR LENS: 300-500 RPS concurrent burst. Try to break the change with
real-world race scenarios. Specifically:

  - Two pods executing the new code path 0.5ms apart on the same key.
  - A reconnect storm during the new code's critical section.
  - A double-fire of the new event under socket recovery.

METHOD:
  1. Read each touched file in the commit (git show <sha> --stat).
  2. For each, construct a concrete scenario with timestamps.
  3. For each scenario, identify the file:line that DEFEATS the scenario
     (atomic Lua, distributed lock, idempotency table, etc.).
  4. If you find a scenario that ISN'T defeated, that's a NEEDS-FIX.

OUTPUT:
  VERDICT: PASS | NEEDS-FIX
  Scenarios attempted: <N>
  Defeats: <list file:line>
  NEEDS-FIX (if any): <description + suggested patch>

HARD RULES:
  - Cite file:line at HEAD <sha>. No hallucination.
  - Stay in scope: <touched files only>.
  - model=opus.
  - Terse output. Single structured message.
```

The other 3 attackers (pod-restart, Redis-failover, cross-fix) get analogous prompts with their specific lenses.

---

## §6 — Codex Integration

Codex CLI v0.125.0 (`/opt/homebrew/bin/codex`).

| Mode | When | Command (conceptual) |
|---|---|---|
| `codex review` | Gate 2a — independent diff review | `codex review <diff>` → PASS/FAIL gate |
| `codex challenge` | Gate 2b — adversarial mode | `codex challenge <diff>` → ≥3 scenarios |
| `codex consult` | Gate 2c (optional) — cross-fix Q&A | `codex consult "does Phase N's #X break Phase N-1's #Y?"` |

Actual invocation per gstack `/codex` skill conventions (lead invokes via Bash with appropriate args).

**Why Codex matters here:** Round-9 Phase 4 added 4 Codex independent verifications (Alpha/Beta/Gamma/Delta). Codex-Delta alone caught a HIGH cross-fix BLOCK that all Claude rounds missed. Independent model lineage breaks the echo chamber.

---

## §7 — Failure & Rollback Protocol

| Gate failure | Action |
|---|---|
| Gate 1 (builder drift) | Lead updates Solution in doc; re-dispatches builder |
| Gate 2 (Codex FAIL/CHALLENGE) | Fix locally; re-run only Codex |
| Gate 3 (red-team NEEDS-FIX) | Fix locally; re-run only failing attacker |
| Gate 4 (test/tsc fail) | Fix ROOT CAUSE; never `it.skip()` / `// @ts-ignore` |
| Gate 5 (line drift / dup import) | Manual Edit; re-run Gate 4 |
| Gate 6/7 (post-commit issue) | `git revert <commit>`; root-cause; new commit |

**Phase rollback:** Each phase = one commit. `git revert <phase-N-sha>` cleanly undoes phase without touching others.

**Hard rule (from CLAUDE.md global):** Never `git reset --hard` on a pushed branch. Never `git push --force` on a shared branch.

---

## §8 — Frontend Coordination Strategy

Per user decision: **Ship backend now, FE-tolerant additive**.

| Fix | Additive shape | FE adopts when |
|---|---|---|
| #6 | New `Idempotent-Replayed: true` response header; old clients ignore | Customer Android iter 2 |
| #7 | 503 + `Retry-After` on backpressure; old clients treat 503 as error (current behavior) | Captain Android retry-layer |
| #12 | New `server_drain_pending` socket event; Socket.IO default = old clients ignore unknown events | Captain/Customer reconnect logic |
| #13 | New `eventId` field on existing socket payloads; Moshi/Codable default = ignore unknown fields | Customer dedup ring-buffer |
| #29 | New `Accept-Version` header support; header optional, absence = latest version | Captain Android version-pinning |

**FE notification:** Gate 7 writes a comment on each FE-coord PR @mentioning the FE team owners.

---

## §9 — Master Verification Matrix (Phase 8, post-rollout)

After all 7 phases land, lead runs a Phase 8 verification round (lead-only, no team, ~1h):

| Verification | Method |
|---|---|
| All 28 DOs landed | `git log --oneline a43aebea..HEAD` shows 8 commits |
| All Solutions' "How to verify" pass | Run each verification command from Solution blocks |
| Cumulative tsc/jest/lint green | Full suite at final HEAD |
| Codex final sweep | `codex review` on `git diff a43aebea..HEAD` |
| index-30-validated.md updated | All 7 phase-applied stamps present at bottom |
| Memory updated | New `project_index30_shipped` memory pointing to final HEAD |

---

## §10 — Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Solution targets deprecated file (Mara's #6 catch) | Builder's anchor protocol step 6: verify file actively imported before Edit |
| Phase N breaks Phase N-1's fix | Gate 3 cross-fix attacker; Gate 4 runs FULL suite (not just new tests) |
| One specialist dominates context | TaskCreate up-front with 4 distinct task subjects; specialists self-claim by subject (per memory `feedback_taskcreate_id_scramble`) |
| Synthesis-stamp hallucination (memory) | Lead verifies after every gate independently; never trusts "PASS" without file:line evidence |
| Long phase → context exhaustion | Each phase = fresh team (independent context); lead's session stays gate-focused |
| Time blow-up | Phases 0/1/5/6 short; Phases 3/4/7 heavy. Realistic 2-3 working days. |
| Working-tree vs HEAD trap (memory) | All builders use `git show HEAD:` for line citations, never working-tree reads |
| Jest isolateModules async footgun (memory) | TDD-Watcher checks new tests use `jest.isolateModulesAsync` if async cb |

---

## §11 — Skills & Tools per Gate

| Gate | Skills/tools |
|---|---|
| Phase planning | `superpowers:brainstorming` (this doc) → `superpowers:writing-plans` → `superpowers:executing-plans` |
| Gate 1 (team) | `TeamCreate`, `TaskCreate`, `Agent` with `team_name`+`name`+`subagent_type="general-purpose"`, `SendMessage`, `TaskUpdate`, `TeamDelete` |
| Gate 2 (Codex) | `/codex` skill (gstack), `codex review`, `codex challenge` |
| Gate 3 (red-team) | `Agent` parallel dispatch with `general-purpose` subagent_type |
| Gate 4 (tests) | `Bash` for `npm test`, `npm run build`, `npm run lint` |
| Gate 5 (line drift) | `Read`, `Grep` |
| Gate 6 (commit) | `Bash` for `git add` / `git commit` with HEREDOC |
| Gate 7 (post-commit) | `Bash` for `git push`, `gh pr create`; `Edit` for `index-30-validated.md` stamp |

---

## §12 — Open Questions Resolved

- ✅ Pipeline shape → Approach C (1 team + lead-driven gates)
- ✅ FE strategy → ship backend now, FE-tolerant additive
- ✅ Phase 0 separation → yes, lead-only
- ✅ PR strategy → one PR per phase (8 total)
- ✅ Codex usage → review + challenge per phase, post-team-completion
- ✅ Red-team usage → 4 parallel adversarial Agent dispatches per phase
- ✅ Line-drift handling → anchor-based grep + 30-60 line context read
- ✅ Out-of-scope items → Phase 0 documents #4/#16/#17/#24 with reasons

---

## §13 — Acceptance Criteria

The rollout is **DONE** when:

1. 8 commits on `fix/critical-broadcast-reliability-2026-04-21` (Phase 0 + 7).
2. 8 PRs opened (1 per phase), each labeled `phase-N`.
3. `git log --oneline a43aebea..HEAD | wc -l` = 8.
4. `npm run build && npm test && npm run lint` all green at final HEAD.
5. Each Solution's "How to verify" command passes.
6. `codex review` on `git diff a43aebea..HEAD` returns PASS.
7. `index-30-validated.md` has 7 "Phase N applied" stamps.
8. SKIP/WAIT register section appended (Phase 0).
9. Both `Dockerfile` and `Dockerfile.production` contain `apk add aws-cli`.
10. New memory `project_index30_shipped` written with final HEAD SHA.

---

**Next step:** Self-review this spec, then ask user to review the written file, then invoke `superpowers:writing-plans` to expand this design into a step-by-step implementation plan.
