# Phase 4 — F-A-26 H3 Cell Surge Rollout Plan (W2-5)

**Status:** DOCUMENTATION ONLY. No code changes in this PR.
**Scope:** Close the remaining F-A-26 gap so every surge decision is segmented by geographic cell, not just by 5-minute bucket.
**Predecessor:** Phase 3 commit `c44bac1` — co-landed F-A-26 (surge determinism + HMAC quote token) with F-B-26.

---

## 1. Current state

- `resolveSurgeDecision` is deterministic per 5-minute bucket and hashes `cellId` into `ruleId` (`src/modules/pricing/pricing.service.ts:105-151`).
- `PriceEstimateRequest.cellId` is **optional** (`src/modules/pricing/pricing.service.ts:210`). When callers omit it, `resolveSurgeDecision` hashes `cellId: null` into the rule ID (`pricing.service.ts:136`), which means all of India shares one surge rule per bucket.
- The Zod request schema does NOT accept a `cellId` at all (`src/modules/pricing/pricing.schema.ts:45-59`); `validateRequest` strips unknown keys, so the field is effectively unreachable from every HTTP caller.
- `h3-js@^4.4.0` is already a dependency (`package.json:44`) — no new install required.
- The 4 production callsites all pass `cellId: undefined`:
  1. `src/modules/pricing/pricing.routes.ts:57` — `POST /pricing/estimate` (customer quote).
  2. `src/modules/vehicle/vehicle.routes.ts:103` — `GET /vehicles/pricing` (unauth public quote).
  3. `src/modules/order/order.service.ts:959` — server re-price in order creation (legacy path).
  4. `src/modules/order/order-creation.service.ts:445` — server re-price fallback when HMAC verify fails.
- Net effect: determinism holds **per time**, but two customers in Bangalore vs Delhi booking in the same 5-min window share one surge multiplier. The geographic leg of F-A-26's "Uber H3 × 5-min" design is inert.

---

## 2. Goal

Every `calculateEstimate` caller passes an H3 `cellId` derived from pickup lat/lng; the quote token is only honoured if its `cellId` matches the pickup cell at order-creation time. Surge multipliers vary by cell within the same 5-minute bucket, so (Bangalore peak, Delhi off-peak) stop sharing a rule.

**Non-goals:** per-cell surge heat-map, demand-based dynamic surge (stays on the fixed `peakHours`/`nightHours` table from `pricing.service.ts:35-41`). Geo segmentation only.

---

## 3. H3 library choice

**Recommend `h3-js@4.x`** (already pinned in `package.json:44`).

- Official Uber H3 JS binding; matches the reference pipeline cited in F-A-26's design banner (`pricing.service.ts:49-51`).
- Pure-JS WASM, no native deps — ECS- and Lambda-friendly per `pricing.service.ts:4-7`.
- 4.x API stable since Jan 2022; `latLngToCell`, `cellToLatLng`, `cellToBoundary` are as specced.

Native `uber-h3` would break Lambda portability; rolling our own hex grid re-invents the aperture-7 math.

---

## 4. H3 resolution choice

**Recommend resolution 7** (avg hex edge ~1.2 km, area ~5.16 km²).

Rationale for Indian-city use case:
- Weelo pickups cluster inside dense urban zones (Bengaluru, Delhi, Mumbai, Hyderabad, Pune, Chennai). Ride-hailing surge segmentation conventionally uses r7 for city-scale and r8 for hot-spot zoom; Uber's public surge map renders r7 tiles.
- At r7, a mid-size city (say Bengaluru ~741 km²) maps to ~140 cells — enough to distinguish Whitefield vs Koramangala without exploding the surge-rule key space.
- At r8 (~0.74 km²) we'd get ~1000 cells per city — over-segmented for fixed-time surge (no demand signal), and cardinality hurts the future surge-heatmap Redis key budget.
- r9 (~0.1 km²) is strictly worse: rule-ID churn per booking would bust any cache and offer zero visible fairness benefit for the current fixed surge table.

**Ladder documented for future work:** if/when demand-based surge lands (Phase 5+), we can drop to r8 or r9 for a heatmap overlay while keeping r7 as the decision cell. `h3-js` supports cheap parent/child lookup (`cellToParent`, `cellToChildren`) so this is forward-compatible.

---

## 5. Callsite audit — **4 callsites need cellId**

| # | Callsite | file:line | Current `cellId` | Lat/lng source |
|---|----------|-----------|------------------|-----------------|
| 1 | Customer fare estimate endpoint | `src/modules/pricing/pricing.routes.ts:57` | NULL (not in schema) | Must add `pickupLatitude`, `pickupLongitude` to `priceEstimateSchema` (`pricing.schema.ts:45`) |
| 2 | Public vehicle pricing endpoint | `src/modules/vehicle/vehicle.routes.ts:103` | NULL (not in schema) | Must add lat/lng to `vehiclePricingQuerySchema` (`vehicle.routes.ts:75-80`) |
| 3 | Legacy order-creation re-price | `src/modules/order/order.service.ts:959` | NULL | Read from `request.pickup.latitude/longitude` (persisted JSON per `prisma/schema.prisma:356`) |
| 4 | HMAC-fallback re-price | `src/modules/order/order-creation.service.ts:445` | NULL | Same `ctx.request.pickup` payload |

Additionally the internal recursive callsite at `pricing.service.ts:494` (`getSuggestions` → `calculateEstimate`) inherits the cellId from its request; add a passthrough in `SuggestionsRequest`.

Test-only mocks (`src/__tests__/**`) do not need cellId but their fixtures should set it so the new schema doesn't break them; treat that as part of Step 3.

---

## 6. Implementation steps

### Step 1 — dependency (no-op)
`h3-js@^4.4.0` already installed (`package.json:44`). Verify `npm ls h3-js` and lockfile integrity before touching any import.

### Step 2 — compute `cellId` at the edges
Introduce a thin helper `src/modules/pricing/h3.util.ts` exporting:
```
deriveCellId(lat: number, lng: number): string   // wraps h3.latLngToCell(lat, lng, 7)
assertCellMatches(cellId, lat, lng): void        // throws if derived ≠ supplied
```
Every HTTP handler that already has lat/lng (callsites 1, 2) computes `cellId` in the handler and passes it into `calculateEstimate`. Order re-price paths (3, 4) read from `ctx.request.pickup.latitude/longitude`.

### Step 3 — thread `cellId` into `calculateEstimate`
- Extend `priceEstimateSchema` (`pricing.schema.ts:45`) and `vehiclePricingQuerySchema` (`vehicle.routes.ts:75`) with optional `pickupLatitude: number`, `pickupLongitude: number`. Keep optional during the dual-mode phase (Step 6) so old clients keep working.
- Extend `SuggestionsRequest` (`pricing.service.ts:272-278`) with `pickupLatitude/pickupLongitude` and forward them into the internal `calculateEstimate` call at `pricing.service.ts:494`.
- `calculateEstimate` (`pricing.service.ts:300`) continues to accept `cellId?: string` — no signature break — and its fallback (`calculateWithDefaults` at `pricing.service.ts:411`) also forwards.

### Step 4 — validate on order-creation replay
In `validateAndCorrectPrices` (`order-creation.service.ts:401`), after the HMAC check passes, recompute `expectedCell = deriveCellId(pickup.lat, pickup.lng)` and require `expectedCell === <cell encoded in surgeRuleId>`. Since `surgeRuleId` already hashes `cellId` (`pricing.service.ts:136`), publish the raw `cellId` as a sibling response field (`pricing.service.ts:400-404` — add `cellId?: string`) and to the order-creation request shape (`order-core-types.ts:39` comment block) so the verifier can re-derive without SHA-reversal.

### Step 5 — migration for in-flight tokens
Old tokens have no `cellId` sibling. For a 15-minute cutover window (3× the 5-min quote TTL at `pricing.service.ts:397`), accept tokens where `cellId` is absent AND log `dispatch.surge.cellless_token_total` counter. After the window: hard-reject. Operationally this means the rollout flip must be timed for low-traffic (use the standard 02:00 IST maintenance slot).

---

## 7. Test strategy

- **Unit** — new `pricing.h3.test.ts`:
  - `deriveCellId(12.9716, 77.5946)` returns the same value across three consecutive calls.
  - Bengaluru MG Road vs Bengaluru Whitefield produce DIFFERENT r7 cells; MG Road Bengaluru vs Connaught Place Delhi produce DIFFERENT cells.
  - Two points within ~500 m of each other collapse to the SAME r7 cell (regression guard against accidentally switching to r8).
- **Regression** — extend `src/__tests__/pricing-determinism-and-quote-token.test.ts` with a "same 5-min bucket, same cell → same ruleId" assertion and a "same bucket, different cell → different ruleId" assertion.
- **Integration** — add `cellId` sibling to existing order-creation tests that mock `calculateEstimate` (listed at `src/__tests__/fix-order-service-hardening.test.ts:68`, `hawk-booking-stress.test.ts:284`, `order-split.test.ts:277`, `tiger-booking-hardening.test.ts:278`, `order-truckhold-stress.test.ts:365`, `medium-fix-booking-improvements.test.ts:272`, `phase3-order-validation.test.ts:273`, `qa-order-scenarios.test.ts:260`, `eagle-i1-booking-creation.test.ts:90`, `phase7-redis-failure-scenarios.test.ts:133`). Verify jest passes with `cellId: '87283082bffffff'` (an r7 Bengaluru cell) in fixtures.

---

## 8. Ops implications

- Surge multiplier now varies by cell within one bucket. Customer-support scripts / FAQ ("why is my price different from my friend's?") need an update: "Surge is priced per 5-minute × neighbourhood". Coordinate with the CS playbook owner.
- New CloudWatch metrics: `pricing_surge_null_cell_total` (should trend to 0 during Step 5), `pricing_surge_cell_mismatch_total` (token `cellId` ≠ pickup re-derived cell — indicates tampering or a stale quote crossed into a different region).
- Redis/key-space impact: surge rule IDs are already hashed; cardinality goes from `~24 rules/day` to `~24 × N_active_cells/day`. With r7 and ~500 active Indian pickup cells, expect ~12 K rule IDs/day — trivial for the existing `rulehash:*` key prefix.
- No Prisma schema change needed; `cellId` is a derived value, never persisted.

---

## 9. Rollout plan

Single feature-flag branch `FF_SURGE_H3_ENABLED` (default OFF), four gates:

| Gate | Duration | What's live |
|------|----------|-------------|
| **G0 — Shadow** | 7 days | Code computes `cellId` everywhere, logs `pricing.surge.cell_computed_total`, but passes `undefined` into `calculateEstimate`. Zero behavioural change. Goal: prove callsites (§5) all receive valid lat/lng. |
| **G1 — 1% dual-mode** | 7 days | With `FF_SURGE_H3_ENABLED=true` on 1% of requests (hash on `customerId`), cellId goes into `calculateEstimate`. HMAC quote tokens include `cellId` sibling. Old tokens without `cellId` still accepted (grace per §6 step 5). Monitor `pricing_surge_cell_mismatch_total` — must stay at 0. |
| **G2 — Full dual-mode** | 14 days | Flip to 100% traffic. Keep the 15-min token grace. |
| **G3 — Hard cutover** | T + 14d | Remove the grace: tokens without `cellId` are rejected with `QUOTE_MISSING_CELL_ID`. Delete the fallback branch. |

Rollback at any gate: flip `FF_SURGE_H3_ENABLED=false`; pricing reverts to today's bucket-only determinism. Signed tokens without `cellId` remain valid (same shape as today), so no customer-visible 4xx storm.

---

## 10. Success criteria

- 100% of quote tokens emitted in the 48 h after G2 carry a non-null `cellId`.
- `pricing_surge_null_cell_total` == 0 in the 48 h window.
- `pricing_surge_cell_mismatch_total` < 5 / day (signal ceiling — anything higher implies a real tamper attempt or a client-side geo drift bug to triage).
- Zero P0/P1 pricing incidents during G0 → G3.
- Soak-sign-off: after G3, the `validForMinutes` of 5 (`pricing.service.ts:398`) still matches the bucket size, and two back-to-back `calculateEstimate` calls with the same (lat, lng, vehicle, trucks, cargo) produce identical `quoteToken` values — verified by the regression test added in §7.

---

**Rollback policy:** delete this file and the `FF_SURGE_H3_ENABLED` flag; no schema or persisted state has changed.
