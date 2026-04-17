# Phase 4 — Captain Phase-2 Hold Migration (F-C-25)

**Owner:** Wave 2 Agent W2-4 (planning only, no code)
**Generated:** 2026-04-17
**Duration:** 4 weeks (W1 dual-wire → W2 beta → W3 ramp → W4 cleanup)
**Scope:** Captain transporter-role hold flow only. Driver-role screens, customer app, and backend Phase-2 services are reference-only.

---

## 1. Goal

Migrate the captain transporter flow from legacy `holdTrucks` + `confirmHoldWithAssignments` (backend route `POST /truck-hold/hold` at `src/modules/truck-hold/truck-hold.routes.ts:105`) to PRD-7777 Phase-2 (`createFlexHold` → `initializeConfirmedHold` → driver `accept`/`decline`, implemented in `flex-hold.service.ts:163` and `confirmed-hold.service.ts`), with zero production incidents and a fully soaked 100% rollout.

---

## 2. Rationale (why Phase 3 deferred this)

Phase-3 plan (`/Users/nitishbhardwaj/Desktop/weelo-backend/.planning/phase3-to-100-plan.md:7`) marked F-C-25 as "1 correctly deferred". `CLAUDE.md` Phase-3 summary (§ "Deferred") lists it as "HIGH risk, 4-week soak required, blocked on dual-wire strangler + captain BuildConfig flag". The legacy path is currently wired at `VehicleHoldConfirmScreen.kt:126` (`RetrofitClient.truckHoldApi.holdTrucks(...)`) and `TruckHoldRepository.kt:103–161` — both are production-critical for every transporter dispatch. Phase-3 could not absorb the 4-week soak within its same-wave cadence (Wave 0 same-day → Wave 2 gated).

Three deferred-scope concerns drove this out of Phase 3:
1. **Version skew** — captain app ships via Google Play; long-tail users cannot be force-updated. Rollout must survive N, N-1, N-2, N-3 concurrent releases.
2. **Missing wire-up** — 7 Phase-2 endpoints are declared in `TruckHoldApiService.kt:100–142` with zero callers; building callers without a soak-compatible strangler risks hidden regression.
3. **State-machine divergence** — legacy `holdTrucks` returns a single `holdId`+`expiresAt` (90s TTL configured server-side). Phase-2 splits this into FLEX (90s, extendable to 130s) + CONFIRMED (180s) + per-driver 45s accept. Mixing the two mid-flight is a correctness hazard.

---

## 3. Prerequisites (must be green before Week 1 starts)

| # | Prerequisite | Verification | Source |
|---|---|---|---|
| P1 | F-A-76 split-delete soak clean (1-week prod) | No errors in CloudWatch referencing deleted split services; all split tests migrated | CLAUDE.md Phase-3 "Deferred" + `phase3-to-100-plan.md:932` |
| P2 | F-B-26 durable-emit flag flip soak clean (2-week staging) | `FF_DURABLE_EMIT_ENABLED=true` on prod with zero `socket_emit_drop_total` spikes | CLAUDE.md Phase-3 risk surface |
| P3 | Backend Phase-2 endpoints live in prod | `POST /truck-hold/flex-hold` returns 200 in prod logs; `truck-hold.routes.ts:479` + `:634` reachable | Backend already shipped — verify via staging smoke |
| P4 | Idempotency deadline flipped (F-A-02) | `ALLOW_MISSING_IDEMPOTENCY_KEY_UNTIL` removed from prod env; `missing_idempotency_key_total` = 0 for 7 consecutive days | CLAUDE.md Phase-4 follow-ups |
| P5 | Captain app min-supported-version bumped to vN-3 | Play Console force-update flag configured; analytics confirm ≥95% DAU on supported versions | Out-of-band mobile ops |
| P6 | BuildConfig flag pipe ready | `app/build.gradle.kts:40` already hosts `buildConfigField` for `MAPS_API_KEY` and `DRIVER_ACCEPT_TIMEOUT_SECONDS:45` — pattern proven | `app/build.gradle.kts:40,45` |
| P7 | `HoldPhase` enum forward-compat shipped (F-C-78) | `UNKNOWN` sentinel exists in `com.weelo.logistics.data.model.HoldPhase` per CLAUDE.md Phase-3 SHA `d84b21d` | CLAUDE.md Phase-3 commit table |
| P8 | `ServerDeadlineTimer` proven in ≥3 screens | Already used at `VehicleHoldConfirmScreen.kt:151,156,216` and referenced in `DriverAssignmentScreen.kt:36` | `phase3-to-100-plan.md:48` A9 |
| P9 | Mobile ops bandwidth booked for 4-week runway | Release manager committed; on-call rota set; rollback drill rehearsed | Out-of-band |
| P10 | Feature-flag observability dashboard | CloudWatch widget on `phase2_hold_enabled_total{outcome=...}` + `phase2_dual_wire_divergence_total` | Scaffolded in W1 |

If any of P1–P9 is red on the Monday of Week 1, the week slips by one calendar week. No exceptions.

---

## 4. Four-Week Timeline

### Week 1 — Dual-Wire Strangler (Fowler pattern)

**Goal:** Captain sends BOTH legacy and Phase-2 requests. Legacy response is what the UI consumes; Phase-2 response is logged + compared. Feature flag defaulted OFF.

**Captain changes (spec only — executed in Phase 4 code phase, not this plan):**
- Add `buildConfigField("boolean", "PHASE_2_HOLD_ENABLED", "false")` to `app/build.gradle.kts` (pattern: line 45).
- `TruckHoldRepository.kt:103` (`holdTrucks`) — after the legacy call succeeds, dual-fire `createFlexHold` on the same `(orderId, vehicleType, vehicleSubtype, quantity)` when `BuildConfig.PHASE_2_HOLD_ENABLED` is true. Capture both `holdId`s in a local diagnostic struct. UI still binds to legacy `holdId`.
- New repository method `createFlexHoldShadow(...)` — logs-only path; never throws up to the UI. Divergence is measured via Timber tag `PHASE2_SHADOW` + a lightweight Retrofit call to a new `/api/v1/metrics/captain-divergence` endpoint (or piggyback on existing analytics).
- `VehicleHoldConfirmScreen.kt` unchanged behaviorally; the shadow call is routed through the repo, not the screen.

**Backend changes (spec):**
- No route removal. `flex-hold.service.ts` is already live (`:163`).
- Add one observability counter `phase2_shadow_divergence_total{reason=...}` (ids mismatch, expiresAt drift, quantity mismatch).

**Deliverables:**
- Merged PR with the flag OFF, dual-wire wired, divergence metric wired.
- Staging soak: 48h on internal/dev cohort, flag=ON in staging `.env`. Zero divergence in `phase2_shadow_divergence_total`.
- Dashboard: CloudWatch widget on divergence counter live.

**Exit criteria:** Divergence = 0 for 48h in staging. Legacy path 100% unchanged semantically.

### Week 2 — Internal Beta

**Goal:** Flip `PHASE_2_HOLD_ENABLED=true` for captain Release Channel *Internal* (team devices) + 10% driver-pool cohort selected by transporter-ID hash (deterministic bucketing).

**Gating:**
- Flag is read both at build time (`BuildConfig.PHASE_2_HOLD_ENABLED`) AND overridden at runtime via a server-side allow-list (`/api/v1/flags/phase2` returning per-transporter bool). Runtime override wins. This lets mobile ops flip cohort membership without a Play release.
- When flag is ON, the repository calls `createFlexHold` as the PRIMARY and `holdTrucks` as the SHADOW (inverted polarity). UI binds to Phase-2 `holdId`; legacy `holdId` is released immediately after both return, so no orphaned legacy hold persists server-side.

**Monitoring (5 business days):**
- Socket: `flex_hold_started`, `flex_hold_extended`, `driver_accepted`, `driver_declined` event arrival rate matches legacy baseline ±5%.
- FCM: push-priority distribution (`fcm_push_priority_total{priority="high"}` from W0-4 canary) unchanged.
- Error rate: `hold_create_error_total` on the Phase-2 path stays below 1% of traffic.
- Timer accuracy: `ServerDeadlineTimer` drift metric (emit on screen dismiss) stays <2s p95.
- Driver accept/decline: ratio matches legacy baseline ±10%. Fallback — if a driver never responds, confirmed-hold expires at 45s, same as legacy timeout.

**Rollback trigger** (any ONE):
- Divergence counter > 1% of calls.
- Socket event drop >5%.
- Driver-accept ratio falls >15% from baseline.
- Any P0 ticket referencing "hold stuck" or "driver didn't get FCM".

Rollback = flip server allow-list to empty; no Play release needed. Legacy shadow path keeps working.

**Exit criteria:** 5 consecutive business days with zero rollback-trigger breaches.

### Week 3 — Gradual Rollout (25% → 50% → 100%)

**Goal:** Expand cohort using hash-bucketed allow-list.

| Day | Cohort | Duration | Gate |
|---|---|---|---|
| W3-Mon | 25% transporters | 48h | all Week-2 metrics green |
| W3-Wed | 50% transporters | 48h | still green + ops approval |
| W3-Fri | 100% transporters | 72h | still green |

At 100%, the allow-list flips to `*` (wildcard). Legacy path remains wired as shadow.

**Rollback trigger** (same as Week 2). Rollback granularity per cohort — step back to previous % without touching the build.

**Exit criteria:** 100% cohort running for ≥72h with zero rollback-trigger breaches.

### Week 4 — Legacy Deprecation

**Goal:** Remove captain-side calls to legacy `holdTrucks`, backend logs WARN on any remaining call, ship captain release with legacy path deleted.

**Captain changes (spec):**
- Delete `TruckHoldRepository.kt:103–161` `holdTrucks` + related idempotency key map entries at `cache.holdAttemptIdempotencyKeys` usages (lines 107, 120, 135, 144).
- Delete `VehicleHoldConfirmScreen.kt:126` legacy call; replace with direct `createFlexHold`. `HoldTrucksRequest` import at `VehicleHoldConfirmScreen.kt:24` removed.
- Update `DriverAssignmentScreen.kt:73` (`holdId` param) type doc to reference Phase-2 confirmed-hold id.
- Remove `buildConfigField("boolean", "PHASE_2_HOLD_ENABLED", ...)` — the code is now unconditionally Phase-2. Keep the server-side runtime flag for emergency kill switch until Week 4 + 1 week soak, then delete.

**Backend changes (spec):**
- `truck-hold.routes.ts:105` `POST /truck-hold/hold` handler adds `logger.warn('DEPRECATED: legacy holdTrucks called', { callerVersion, transporterId })` and increments `legacy_holdtrucks_deprecated_total`. Do NOT 410 the route — long-tail captain N-3 versions still call it.
- Keep the route alive for one additional release cycle (≈6 weeks) before the 410-Gone step, which is Phase-5 scope.

**Captain release:**
- Version bump, release notes: "Two-phase hold with extend +30s and driver accept/decline windows".
- Play Store staged rollout 10% → 50% → 100% over 3 days.

**Exit criteria:** Play Store 100% rollout complete, `legacy_holdtrucks_deprecated_total` stops growing from captain app (residual growth acceptable only from N-3 long-tail).

---

## 5. Architectural Decisions (captain-specific)

### 5.1 BuildConfig flag location
`app/build.gradle.kts:45` already hosts `buildConfigField("int", "DRIVER_ACCEPT_TIMEOUT_SECONDS", "45")`. Add a sibling boolean line inside the same `defaultConfig {}` block. Debug variant at line 50+ can override to `"true"` for always-on dev testing. **Decision:** build-time boolean + server-side runtime override. Runtime override wins; build-time is the kill switch.

### 5.2 Repository shape
**Recommend:** single `TruckHoldRepository` with a new `createFlexHoldAndAssign(...)` high-level method that composes `createFlexHold` + `initializeConfirmedHold`. **Reject:** separate `Phase2TruckHoldRepository`. Rationale — the existing repo already owns the idempotency-key caches (`cache.holdAttemptIdempotencyKeys` at `TruckHoldRepository.kt:107`, `confirmAttemptIdempotencyKeys` at `:171`, `releaseAttemptIdempotencyKeys` at `:217`). Splitting the repo forks that state and risks double-issuance of idempotency keys. Adding one method keeps the invariant "one key per `(order, vehicle, quantity)` attempt".

### 5.3 Timer wiring
`ServerDeadlineTimer` is already used at `VehicleHoldConfirmScreen.kt:151` (`deadlineElapsedFromServerExpiry`) and `:156` (`remainingSecondsFromDeadline`). Phase-2 `FlexHoldResponse.data.expiresAt` (declared at `TruckHoldApiService.kt:494`) and `ConfirmedHoldResponse.data.expiresAt` (declared at `:510`) are both ISO-8601 strings, so the existing `Instant.parse(expiresAtStr)` path at `VehicleHoldConfirmScreen.kt:147` works unchanged. The extend-button countdown refresh already exists at `:297–309` (shipped under F-C-26, commit `5cc4304`). **No new timer code required.**

### 5.4 Driver accept/decline UI
`DriverAssignmentScreen.kt` already exists (transporter-view — selects drivers). The *driver-side* accept/decline screen (separate role) is out of this plan's scope — it is covered by F-C-77 (`BuildConfig.DRIVER_ACCEPT_TIMEOUT_SECONDS=45`, shipped) and the `driverAcceptAssignment`/`driverDeclineAssignment` endpoints at `TruckHoldApiService.kt:121,127`. This plan assumes the driver-side UI is already functional. If it is not, that work blocks Week 2 and must be added as a preamble.

### 5.5 UI copy
Phase label becomes user-visible because FLEX + CONFIRMED have different semantics. Proposed copy in `strings.xml` (new keys):
- `hold_phase_flex_banner` — "Hold is flexible — 90s to assign drivers (extend +30s available)".
- `hold_phase_confirmed_banner` — "Hold confirmed — drivers have 45s to accept".
- `hold_phase_extend_disabled_max` — "Maximum hold time reached (130s)".

All string keys live in `app/src/main/res/values/strings.xml` and get localized via Crowdin before Week 2 beta.

---

## 6. Test Strategy

| Layer | Scope | Owner | Gate |
|---|---|---|---|
| **Unit** | Repository divergence logic; flag precedence (runtime over build); idempotency-key reuse across phases | Captain dev | Week 1 merge |
| **Integration** | Retrofit mock server returning Phase-2 responses; assert `Instant.parse` survives `Z`-suffix, `+00:00`, and milliseconds variants | Captain dev | Week 1 merge |
| **Instrumented (Android)** | `VehicleHoldConfirmScreen` rendering with mocked repo — FLEX banner, CONFIRMED banner, extend-button visibility gate (`remainingSeconds in 1..29` at `:555`), timer accuracy across doze simulation via `SystemClock.sleep` + `advanceTimeBy` | Captain dev | Week 1 merge |
| **Backend contract** | Run existing `src/__tests__/critical-22-hold-system.test.ts` + peers against the dual-wire path (expect both shadows to succeed) | Backend dev | Week 1 merge |
| **Play Store internal track** | Full captain beta cohort on internal track for 5 business days | Mobile ops | Week 2 exit |
| **Soak (prod)** | Cohort monitoring per Week 2 metrics table | SRE | Week 2 and Week 3 exit |
| **Regression — legacy N-3** | Old captain builds kept in rotation (emulator farm) still hit `POST /truck-hold/hold` and succeed | QA | Week 4 exit |

---

## 7. Rollback Protocol (per week)

| Week | Rollback action | Time-to-rollback |
|---|---|---|
| W1 | Revert merge PR; flag was OFF, no user impact | 10 min |
| W2 | Set server allow-list empty; repo reverts to legacy primary | 2 min |
| W3 | Step allow-list back to previous cohort % | 2 min per step |
| W4 (pre-release) | Halt Play Store staged rollout from Play Console | 15 min (Google propagation) |
| W4 (post-release) | Push a hotfix build with legacy path re-wired + flag forced OFF; in parallel, server allow-list forces Phase-2 off via runtime override. Legacy still live on backend, so in-flight users self-heal | 24h (Play hotfix) + immediate runtime override |

Every week's rollback is drill-rehearsed on Monday of that week before Tuesday traffic ramps.

---

## 8. Success Criteria

1. **100% transporter cohort** on Phase-2 for ≥72h at Week 3 exit.
2. **Zero P0/P1 incidents** attributable to this migration during Weeks 1–4.
3. **Captain release** with legacy call-sites deleted ships to Play Store with ≥99% crash-free sessions over 7-day window.
4. **Backend `legacy_holdtrucks_deprecated_total`** from current-version captain app = 0 at Week 4 exit (residual N-1/N-2/N-3 traffic only).
5. **Divergence metric** `phase2_shadow_divergence_total` remains <0.1% of traffic during Weeks 1–2.
6. **Timer drift** p95 stays <2s across the whole migration.

---

## 9. Risks and Mitigations

| # | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Play Store version skew — N-3 users keep calling legacy `holdTrucks` for months | High | Medium | Keep legacy route live; don't 410 until Phase 5; min-supported-version ladder (P5). |
| R2 | **Mid-hold flag flip** — cohort user is running with flag ON, allow-list revoked mid-flow, creating a hold on Phase-2 that cannot be confirmed via legacy. **NOT mentioned in Phase-3 plan.** | Medium | High | Flag state captured at screen-entry into `rememberSaveable` state, and the ENTIRE hold lifecycle (create → confirm/release) uses that captured value. Runtime override only affects NEW holds. Document this invariant in `VehicleHoldConfirmScreen.kt` comments. |
| R3 | Divergence between legacy `holdId` and Phase-2 `holdId` leaks to UI | Medium | High | Week-1 unit test asserts `UI.holdId === legacy.holdId` under shadow mode, `UI.holdId === phase2.holdId` under primary mode. |
| R4 | Backend rate limits trip on doubled traffic during dual-wire | Medium | Medium | `transporterRateLimit('holdTrucks')` at `truck-hold.routes.ts:105` — coordinate bump of rate limit with backend team for Weeks 1–4; revert at W4 exit. |
| R5 | `HoldPhase` enum deserialization fails on unknown backend value (e.g., new phase added mid-migration) | Low | High | `UNKNOWN` sentinel shipped in F-C-78 (CLAUDE.md SHA `d84b21d`). |
| R6 | Idempotency collision — legacy shadow and Phase-2 primary both accept the same key but produce different hold records | Low | High | Idempotency keys are scoped per-endpoint server-side (F-A-02 unique index). Each path generates its own UUID from `cache.holdAttemptIdempotencyKeys` (legacy) vs new `cache.flexHoldAttemptIdempotencyKeys` (Phase-2). Distinct map → distinct keys. |
| R7 | Long-tail Play rollout halt mid-Week-4 leaves some users on legacy-deleted build with broken deep-links | Low | Medium | Release notes + in-app upsell; soft prompt to update at app start. Keep the legacy backend route alive 6 weeks post-W4. |
| R8 | Extend-button at `VehicleHoldConfirmScreen.kt:555` is gated `remainingSeconds in 1..29` — during dual-wire Week 1, the shadow Phase-2 expiresAt may differ by 1–2s from legacy, flickering the button | Low | Low | Bind visibility to the PRIMARY path's timer only. Shadow timer is never bound to UI state. |
| R9 | Driver-side FCM priority regression (F-C-54 / F-B-53) recurs on Phase-2 path | Low | High | W0-4 canary metric `fcm_push_priority_total` stays wired through Phase 4. Alert on `priority="normal", type="ASSIGNMENT_UPDATE"`. |

---

## 10. Out-of-Scope

- Customer-app Phase-2 UI (separate plan).
- Driver-role accept/decline screen work (covered by F-C-77, assumed live per §5.4).
- Backend split-delete of `holdTrucks` (Phase 5 — 6 weeks after W4 exit).
- H3 surge rollout (F-A-26, separate Phase-4 plan).

---

## 11. Sign-off Checklist

- [ ] All prerequisites P1–P10 green on W1 Monday.
- [ ] Week 1 merge + 48h staging soak clean.
- [ ] Week 2 beta — 5 consecutive green business days.
- [ ] Week 3 — 25% / 50% / 100% steps clean.
- [ ] Week 4 Play Store 100% rollout, `legacy_holdtrucks_deprecated_total` at floor.
- [ ] Post-migration retrospective filed under `.planning/phases/04-captain-phase2-migration/RETRO.md`.

---

**End of plan — ~2,100 words, no code.**
