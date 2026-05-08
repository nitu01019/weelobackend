# SKIP_DECISIONS — Permanent Drops from the Broadcast-Reliability Bundle

| Field | Value |
|---|---|
| Date | 2026-05-09 |
| Branch | `fix/critical-broadcast-reliability-2026-04-21` |
| HEAD when authored | `0baa795500a3eb03d6cd0702b499ac20764ce348` |
| Source-of-truth | `/Users/nitishbhardwaj/Downloads/index-20-validated.md` (§3 lines 2120-2173, §2.1.2 lines 1523-1598) |
| Companion | `index-20-validated.md` Round-6 disposition table (lines 39-63), Round-7 stamp (lines 79-143) |

This file formalizes three items that were evaluated during the 7-team validation rounds and explicitly removed from the must-ship list. Each entry cites:
1. **Doc citation** — `index-20-validated.md` line range that justifies the skip.
2. **Prod-state evidence** — file:line at HEAD `0baa7955` that confirms the prod state the doc relied on.
3. **Reversal procedure** — concrete trigger and remediation steps if traffic pattern or env state changes.

A final `Confidence` section anchors each decision to the Round-6 / Round-7 stamps so future operators can trace the verdict back to the specialists who signed off.

---

## Skip #1 — Fix #4: H3 geo-indexing flag (`FF_H3_INDEX_ENABLED`)

**Decision: SKIP. No code change. Monitor only.**

### What Fix #4 originally asked for
Force-enable H3 cell-index routing in `progressive-radius-matcher.ts:137` by adding a code-level `defaultValue: true` to the `H3_INDEX_ENABLED` flag in `feature-flags.ts`, on the assumption that prod was still running the GEORADIUS fallback path.

### Why we are skipping
The flag is **already enabled in production** via the ECS task-definition env block (revision `:64`), so a code-level default would be redundant. Independently of that, at the current single-transporter / 7-vehicle density the H3 path is **slower** than GEORADIUS — adding a code default that hides the env-var override would make a future flip-back to GEORADIUS harder, not easier.

### Evidence
| Claim | Citation |
|---|---|
| Doc cites task-def `:64` already has `FF_H3_INDEX_ENABLED=true` | `index-20-validated.md:2124` |
| Cost-model penalty at our density: H3 ≈ (N+1)× Redis ops vs GEORADIUS = 1 op | `index-20-validated.md:2126` |
| Round-6 reconfirmation against HEAD `8f400201` | `index-20-validated.md:2130-2141` |
| Prod env file mirror at current HEAD | `.env.production:144` (`FF_H3_INDEX_ENABLED=true`) |
| Flag declaration at HEAD | `src/shared/config/feature-flags.ts:217-218` (registry entry, no `defaultValue`, env override `FF_H3_INDEX_ENABLED`) |

### Reversal procedure (when to revisit)
1. **Density crosses ~1K transporters** (Uber-scale GEORADIUS bottleneck): re-evaluate. Until then, stay on GEORADIUS in monitoring.
2. **Monitor signal**: instrument `broadcast_candidate_lookup_ms{algorithm="h3"}` p50/p99 against `algorithm="georadius"` baseline. If `h3.p99 > georadius.p99` for 3 consecutive days → set `FF_H3_INDEX_ENABLED=false` in task-def (NOT in code). The `h3Circuit.tryWithFallback` wrapper already provides graceful degrade.
3. **If task-def is rolled back below revision `:64`** and the env var disappears, the flag registry default (`false`, since `'release'` category has no `defaultValue` set) takes over and silently disables H3. At that point — and only at that point — adding `defaultValue: true` to `feature-flags.ts:217-218` becomes the correct fix.
4. **Long-term optimization** (only matters at scale): the per-candidate `redisService.exists('h3:pos:${id}')` loop at `progressive-radius-matcher.ts:250-258` can be batched into a single Lua / pipeline. Out of scope for the current ship plan.

### Confidence
- **Round-6 confirmation**: `index-20-validated.md:2130-2141` (Team A + Team B independent re-grep at HEAD `8f400201`).
- **Round-7 stamp**: `index-20-validated.md:91` — `DROP-CONFIRMED, 99%`.
- **Round-6 disposition table**: `index-20-validated.md:43` — `CONFIRMED + monitor recommended`.

---

## Skip #2 — Fix #25: `setTimer` past-`expiresAt` guard

**Decision: SKIP. No code change.**

### What Fix #25 originally asked for
Add a guard inside `redisService.setTimer(...)` that rejects calls with `expiresAt <= Date.now()` to prevent already-past timers from being written to Redis.

### Why we are skipping
1. **The scenario is impossible** at the current architecture. All in-process producers compute `expiresAt = Date.now() + positive_delta` synchronously; no path reads `expiresAt` from DB or another machine and feeds it back.
2. **Even if it occurred, behavior is benign**: the existing `setTimer` clamps `ttlSeconds = Math.max(1, …)` and uses `expiresAt.getTime()` as the ZSET score, which makes the entry immediately due — the 30s reconciliation poll picks it up on next cycle, fires the handler, removes the entry. No leak, no memory growth.
3. **A guard would be net-negative**: silent rejection would mask any future regression that produced a past timestamp (e.g. someone subtracts instead of adds), turning a loud "fired immediately" signal into a swallowed bug.

### Evidence
| Claim | Citation |
|---|---|
| All 15 setTimer producers compute `expiresAt = Date.now() + positive_delta` in-process | `index-20-validated.md:2145` |
| No producer reads `expiresAt` from DB / RPC / other machine | `index-20-validated.md:2146` |
| Benign-immediate-fire behavior detail (ZADD score in past → next-poll-due, no leak) | `index-20-validated.md:2147` |
| Sequential step chains anchor each `setTimer` to a fresh `Date.now()` inside step N's handler | `index-20-validated.md:2148` |
| Why the guard is harmful (masks regressions) | `index-20-validated.md:2149-2151` |
| Round-6 reconfirmation: 8 producers cited explicitly + 8 others, all confirm in-process delta | `index-20-validated.md:2153-2162` |
| `setTimer` signature + TTL clamp at HEAD | `src/shared/services/redis.service.ts:2617` (`async setTimer<T>(timerKey: string, data: T, expiresAt: Date): Promise<void>`) and `:2620` (`Math.max(1, Math.ceil(...))`) |
| `setTimerIfAbsent` companion (also no past-guard) | `src/shared/services/redis.service.ts:2848` |

### Reversal procedure (when to revisit)
1. **A new out-of-process producer** is introduced (migration script, separate worker, replay script) that derives `expiresAt` from a stale DB timestamp. At that point a counter, not a guard, is the right shape.
2. **Counter-only, no-guard** detection pattern (per `index-20-validated.md:2164-2170`):
   ```typescript
   if (delta_ms <= 0) {
     metrics.incrementCounter('setTimer_late_schedule_count', { delta_ms_below: '0' });
     // DO NOT reject — let the entry fire immediately as today
   }
   ```
3. Ship the counter only as a separate ticket if observability is genuinely needed; do **not** bundle into the 20-fix audit.

### Confidence
- **Round-6 confirmation**: `index-20-validated.md:2153-2162` (15 producers re-audited at HEAD `8f400201`).
- **Round-7 stamp**: `index-20-validated.md:103` — `DROP-CONFIRMED, 99%`. Note: Round-7 corrected producer count from 18 to 15 (no change in verdict).
- **Round-6 disposition table**: `index-20-validated.md:55` — `CONFIRMED (see §3 Drop #2)`.

---

## Skip #3 — Fix #8: Server-side dedup SADD before emit (`FF_SEQUENCE_DELIVERY_ENABLED`)

**Decision: SKIP. Prefer flag canonicalization (already in place).**

### What Fix #8 originally asked for
Add a Redis `SADD dedup:emit:<userId> <messageId>` gate in front of every emit in `queue.service.ts:1238-1314, 1457` so that reaper-redelivered duplicates within the 30s window between reaper-TTL (60s) and `MESSAGE_TTL_MS new_broadcast` (90s) cannot survive.

### Why we are skipping
The decision matrix in §2.1.2 explicitly says: when `FF_SEQUENCE_DELIVERY_ENABLED=true` in the target env, **skip this fix**. The per-user monotonic-seq + `socket:unacked:{userId}` ZSET path already dedups by score; adding SADD on top is redundant overhead with no observable correctness benefit.

Production has the flag ON: `.env.production:140` sets `FF_SEQUENCE_DELIVERY_ENABLED=true`, and the ECS task-definition mirrors this. The 7 production reader files (`queue.service.ts:86`, `socket.service.ts:336/:1452`, `broadcast.processor.ts:45`, `booking-radius.service.ts:240/:486`, `booking-broadcast.service.ts:102`, `booking.service.ts:861/:1472/:1634`, `booking-rebroadcast.service.ts:195`) collectively guarantee the sequence-delivery code path is active end-to-end.

The `queue.types.ts:85` `FF_SEQUENCE_DELIVERY_ENABLED` constant is a **phantom export** (zero non-test importers at HEAD `0baa7955`), confirmed by `grep -rn "from.*queue\.types" src --include="*.ts" | grep -v "__tests__\|\.test\."` returning no results. Deletion of that phantom is bundled with §2.2.1 Fix #13 dead-code cleanup, not part of this skip.

### Evidence
| Claim | Citation |
|---|---|
| Decision-matrix rule "skip when flag is true" | `index-20-validated.md:1527-1531` |
| Pre-flight check is `aws ecs describe-task-definition ... FF_SEQUENCE_DELIVERY_ENABLED` BEFORE writing any code | `index-20-validated.md:1530` |
| 7 production reader files enumerated at HEAD `8f400201` | `index-20-validated.md:1535-1545` |
| Phantom export confirmation (zero non-test importers) | `index-20-validated.md:1547-1548` |
| `.env.production:140` already has `FF_SEQUENCE_DELIVERY_ENABLED=true` | `index-20-validated.md:1550` |
| Layer-1/2/3 canonicalization plan (preferred over SADD impl) | `index-20-validated.md:1554-1580` |
| Round-8 retraction explicitly reaffirms DROP because `.env.production:140=true` makes SADD redundant | `index-20-validated.md:93` |
| Prod env mirror at current HEAD | `.env.production:140` (`FF_SEQUENCE_DELIVERY_ENABLED=true`) |
| Flag declaration | `src/shared/config/feature-flags.ts:245-246` (registry entry, env override `FF_SEQUENCE_DELIVERY_ENABLED`) |
| Phantom export at HEAD | `src/shared/services/queue.types.ts:85` (`export const FF_SEQUENCE_DELIVERY_ENABLED = isEnabled(FLAGS.SEQUENCE_DELIVERY_ENABLED);`) — zero non-test importers verified |

### Reversal procedure (when to revisit)
1. **`FF_SEQUENCE_DELIVERY_ENABLED` is rolled back to `false`** in production AND duplicate-delivery bugs are observed → at that point, restore the flag is the correct first move (sequence-based dedup is more robust than SADD per `index-20-validated.md:1529`).
2. **Non-JS client (e.g. Android native socket consumer)** is introduced that does not implement client-side seq dedup → revisit server-side SADD as a backstop. Until then, the seq-ZSET in `socket:unacked:{userId}` is sufficient.
3. **Flag canonicalization (Layer 1-3)** in `index-20-validated.md:1554-1580` is the preferred path if any ambiguity arises in non-prod environments. That work is doc-grade only; no SADD code is involved.
4. **Pre-flight any reversal**: re-run `grep "FF_SEQUENCE_DELIVERY_ENABLED" .env.production` AND `aws ecs describe-task-definition --task-definition weelobackendtask --region ap-south-1 --query 'taskDefinition.containerDefinitions[0].environment[?name==\`FF_SEQUENCE_DELIVERY_ENABLED\`]'` before declaring the prod state changed.

### Confidence
- **Round-6 confirmation**: `index-20-validated.md:1533-1597` (7-way reader-file split-brain audit, 12 raw call sites enumerated, phantom export verified).
- **Round-7 stamp**: `index-20-validated.md:93` — `DROP-CONFIRMED, 99%`. Includes Round-8 retraction (2026-05-08) reaffirming the verdict against any earlier "Reader count: 4" framing.
- **Round-6 disposition table**: `index-20-validated.md:45` — `CONFIRMED — FF canonicalize`.
- **Ship-plan revision #5 (b-spec-8)**: `index-20-validated.md:121` — `Wk3: DROP #8 entirely … §4.7 line 2123-2129 explicitly says SKIP`.

---

## Aggregate Confidence

| Skip | Round-6 disposition | Round-7 verdict | Round-7 confidence |
|---|---|---|---|
| #1 — Fix #4 H3 flag | `CONFIRMED + monitor recommended` (line 43) | `DROP-CONFIRMED` (line 91) | 99% |
| #2 — Fix #25 setTimer guard | `CONFIRMED (see §3 Drop #2)` (line 55) | `DROP-CONFIRMED` (line 103) | 99% |
| #3 — Fix #8 server-side SADD | `CONFIRMED — FF canonicalize` (line 45) | `DROP-CONFIRMED` (line 93) | 99% |

All three skips were independently re-validated by Team A + Team B (17 specialists, Round 6) and by Team B's 8 senior backend logic validators (Round 7) against HEAD `8f4002013e676721eb8e32e906379c4631d79a69`. The current HEAD `0baa795500a3eb03d6cd0702b499ac20764ce348` re-verifies the prod-state evidence cited above:

- `.env.production:140` `FF_SEQUENCE_DELIVERY_ENABLED=true` ✓
- `.env.production:144` `FF_H3_INDEX_ENABLED=true` ✓
- `redis.service.ts:2617` `setTimer` signature uses `ttlSeconds = Math.max(1, …)` with no past-guard ✓
- `queue.types.ts:85` phantom export, zero non-test importers ✓

**Bottom line**: 23 fixes total in the validated bundle = 17 ACTIONABLE + 3 SKIPS (these) + 3 already-deleted-from-list. The 3 skips above are the ones that needed formal documentation because each defends an "obvious to fix" item that is actually correct as-is. Treat any future request to "just add the SADD / past-guard / H3 default" as a request to revisit the reversal procedure — never as net-new work.
