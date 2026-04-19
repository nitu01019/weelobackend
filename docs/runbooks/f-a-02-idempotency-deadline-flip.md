# F-A-02 — Idempotency Deadline Flip Runbook

**Owner:** Backend SRE
**Target flip date:** 2026-05-01
**Risk tier:** HIGH (Play-Store long-tail; breaks legacy clients that don't send `x-idempotency-key`)
**Wave tag:** Phase 3 / W2-3 prep
**Last updated:** 2026-04-17

---

## 1. What is being flipped

At Phase 3 close (commit `9726e46`, `src/modules/order/order.routes.ts:196-235`) the server added a grace window for clients that don't yet send `x-idempotency-key` on `POST /api/v1/orders`. The gate is controlled by the env var `ALLOW_MISSING_IDEMPOTENCY_KEY_UNTIL=2026-05-01` added in `/Users/nitishbhardwaj/Desktop/weelo-backend/.env.example:275-282`.

```
src/modules/order/order.routes.ts:207
  const graceUntilRaw = process.env.ALLOW_MISSING_IDEMPOTENCY_KEY_UNTIL;
  const graceUntilMs = graceUntilRaw ? Date.parse(graceUntilRaw) : NaN;
  const inGraceWindow = Number.isFinite(graceUntilMs) && Date.now() < graceUntilMs;

src/modules/order/order.routes.ts:215-224
  } else if (inGraceWindow) {
    // server-generates a UUID so legacy clients keep working, logs a WARN
    ...
```

When the deadline passes, the `else` branch falls through to `reject_400` at `src/modules/order/order.routes.ts:226-234` and returns:

```json
HTTP 400
{ "success": false, "error": { "code": "MISSING_IDEMPOTENCY_KEY",
  "message": "x-idempotency-key header is required for order creation and must be a UUID v4" }}
```

The flip consists of **removing the grace-window branch entirely** (4-line diff documented in `docs/runbooks/f-a-02-flip-pr-draft.md`), plus removing the env var from the example file.

---

## 2. Plan-flagged biggest risk (verbatim)

From `.planning/phase3-to-100-plan.md:84`:

> F-A-02 deadline removal (W2-3) prep runs too early and breaks in-flight captain app versions → W2-3 must explicitly wait until `missing_idempotency_key_total` hits 0 for 7 consecutive days.

From `.planning/phase3-to-100-plan.md:981` (Risk R6):

> Play Store cannot force captain app upgrade; version skew stays | HIGH | HIGH | W2-3 verification grid MUST confirm LATEST released app (not latest committed) sends idempotency key | W2-3

This runbook drives to that go/no-go decision.

---

## 3. Pre-flip investigation — app release verification

### 3.1 Captain app (`/Users/nitishbhardwaj/Desktop/weelo captain`)

**Finding: Captain does NOT POST /api/v1/orders.** Grep for `@POST(` in `app/src/main/java/com/weelo/logistics/data/api/*.kt` returns only `truck-hold/order-timeout/initialize` (captain `TruckHoldApiService.kt:149`). The captain app is not a caller of the hard-required route and therefore cannot be broken by the 2026-05-01 flip.

**Evidence:**
- `app/src/main/java/com/weelo/logistics/data/api/TruckHoldApiService.kt:31,62,72,104` — hold routes only, idempotency header is declared but those routes are not the F-A-02-gated route (F-A-02 applies exclusively to `POST /api/v1/orders`).
- `app/src/main/java/com/weelo/logistics/data/api/BroadcastApiService.kt:144` — broadcast accept, also not order creation.

**Conclusion for captain:** NO release-verification risk.

### 3.2 Customer app (`/Users/nitishbhardwaj/Desktop/Weelo`)

**This is the only caller at risk.** The `POST /api/v1/orders` endpoint is reached via two Retrofit methods, both declared with nullable headers:

```
app/src/main/java/com/weelo/logistics/data/remote/api/WeeloApiService.kt:131-136
  @POST("bookings/orders")
  suspend fun createOrderViaBookings(
    ...
    @Header("X-Idempotency-Key") idempotencyKey: String? = null   // ← nullable
  )

app/src/main/java/com/weelo/logistics/data/remote/api/WeeloApiService.kt:142-147
  @POST("orders")
  suspend fun createOrder(
    ...
    @Header("X-Idempotency-Key") idempotencyKey: String? = null   // ← nullable
  )
```

**However, the repository layer enforces a fallback at** `app/src/main/java/com/weelo/logistics/data/repository/BookingApiRepository.kt:461-462`:

```kotlin
val effectiveIdempotencyKey = idempotencyKey?.takeIf { it.isNotBlank() }
    ?: java.util.UUID.randomUUID().toString()
```

Every production call path funnels through `BookingApiRepository.createOrder(...)` before reaching Retrofit, so the header is always non-null at the wire:

1. `presentation/pricing/PricingViewModel.kt:239` → repo.createOrder
2. `presentation/booking/BookingConfirmationViewModel.kt:157` → repo.createOrder
3. `ui/dialogs/SearchingVehiclesDialog.kt:1438` → repo.createOrder
4. `data/sync/SyncManager.kt:259,270` → apiService.createOrderViaBookings with pre-supplied `effectiveIdempotencyKey` from repo

**Header commit introduction:** `47fb10b` (2026-02-28, "order create reliability: payload-hash idempotency and queued retries") — confirmed via `git log --all -S"X-Idempotency-Key"` in the customer repo.

**Versioning:** `app/build.gradle` shows `versionCode 5`, `versionName "1.0.4-search-fix"`. No git tags exist (`git tag` returns empty on both apps), so there is no canonical "latest released to Play Store production track" marker in the repo.

### 3.3 GAP — Play Store release-channel data

**We cannot prove Play Store production track is on `versionCode>=5` from the repo alone.** This runbook requires the operator to manually answer:

- What is the current Play Store production-track `versionCode` for `com.weelo.logistics` (customer)?
- What is the 30-day install-base distribution across active `versionCode`s (needs Google Play Console → Statistics → "App versions")?
- What percentage of active installs are on `versionCode < 5` (pre-`47fb10b`, no header)?

**Source of truth:** Google Play Console → `com.weelo.logistics` → Release → Production → Track status.

**Acceptable thresholds (proposed):**

| Scenario | Action |
|---|---|
| ≥99% of 30-day active installs on versionCode ≥ 5 AND the metric is 0 for 7 days | GO on 2026-05-01 |
| 95-99% on versionCode ≥ 5 | Extend deadline by 30 days, ship reminder push to older versions |
| <95% on versionCode ≥ 5 | Extend deadline by 60-90 days, force-upgrade banner in-app |

---

## 4. Monitoring gap — `missing_idempotency_key_total` does NOT exist

**GAP (confirmed by grep):** The metric `missing_idempotency_key_total` that the plan (`.planning/phase3-to-100-plan.md:84,776,780,796,915`) and CLAUDE.md (Phase 3 "Remaining risk surface" § F-B-76) assume will exist **does not exist in the current codebase**.

Evidence:

```
$ grep -R "missing_idempotency" src/shared/monitoring/
(no matches)

$ grep -R "missing_idempotency_key_total" src/
(no matches)
```

Only a `logger.warn` line exists at `src/modules/order/order.routes.ts:221-224`:

```
logger.warn(
  '[Orders] POST / - Missing/invalid x-idempotency-key within grace window. Server-generated key has no dedup value.',
  { userId: user.userId, graceUntil: graceUntilRaw }
);
```

**Counter registered today (closest match):** `hold_idempotency_purged_total` in `src/shared/monitoring/metrics-definitions.ts:87` — this is for HOLD idempotency purges, not the order-creation missing-header signal.

**W2-3 recommendation (follow-up, NOT executed by W2-3):**

Before the 2026-05-01 deadline, a separate 1-file PR should register a counter in `src/shared/monitoring/metrics-definitions.ts` alongside the existing hold counter and increment it at `src/modules/order/order.routes.ts:215` (the `inGraceWindow` branch) and at `order.routes.ts:225` (the reject branch, during test windows). Suggested definition:

```ts
counter(
  'missing_idempotency_key_total',
  'POST /orders requests arriving without a valid x-idempotency-key (labelled by gate_outcome: grace|reject)',
  ['gate_outcome']
)
```

Without this counter, the go/no-go decision in §6 is degraded to log-grep-based estimation (see §5.3).

---

## 5. Monitoring period (2 weeks before 2026-05-01 deadline)

### 5.1 Target start: 2026-04-17 (today, upon landing this runbook)
### 5.2 Target end: 2026-05-01T00:00Z (deadline)

### 5.3 Degraded monitoring path (until the counter lands)

CloudWatch query against the `weelobackendtask` log group (pattern from CLAUDE.md §"How to Check CloudWatch Logs"):

```bash
aws logs filter-log-events \
  --log-group-name weelobackendtask \
  --filter-pattern "[Orders] POST / - Missing/invalid x-idempotency-key" \
  --start-time $(date -d '24 hours ago' +%s000) \
  --region ap-south-1 \
  --query 'events[*].[timestamp,message]' \
  --output text | wc -l
```

Record the 24-hour count daily in a spreadsheet (date, count, rolling-7-day-avg). Go/no-go needs **7 consecutive days of 0** before 2026-05-01.

### 5.4 Preferred monitoring path (after the counter is added)

Prometheus query (assuming default metrics scrape at `/metrics`):

```promql
sum(rate(missing_idempotency_key_total[1d])) * 86400
```

Daily threshold: `0 for 7 consecutive 24-hour windows`.

---

## 6. Go / no-go decision tree (to be evaluated on 2026-04-29)

```
1. Is the metric/log count == 0 for the last 7 consecutive days?
   NO  → NO-GO. Extend deadline by 30 days. Re-evaluate weekly.
   YES → proceed to step 2.

2. Is the Play Store production-track active-install distribution at
   ≥99% on versionCode ≥ 5 (has header)?
   UNKNOWN → NO-GO. Pull distribution from Play Console before deciding.
   NO      → NO-GO. Extend deadline by 30-60 days; consider force-upgrade banner.
   YES     → proceed to step 3.

3. Has the customer app shipped a release that REMOVES the repo-layer
   UUID fallback at BookingApiRepository.kt:461-462 (so the wire call
   would fail without client-generated key)?
   YES → GO. The fallback is no longer masking missing-header cases.
   NO  → GO WITH CAUTION. Repo-layer fallback is a safety net; flipping
         the server is safe but does not exercise the client contract.
         Log a Phase 4 follow-up to remove the fallback in the next
         customer release.

4. Is staging canary clean? Run docs/runbooks/f-a-02-flip-pr-draft.md
   against staging for 24h, watch for unexpected 400s from
   `POST /api/v1/orders` in CloudWatch.
   NO  → NO-GO. Fix the regression source.
   YES → GO. Proceed with §7 (flip procedure).
```

---

## 7. Flip procedure (day-of: 2026-05-01)

### 7.1 Preconditions (verify BEFORE flipping)

- [ ] `missing_idempotency_key_total` (or log-based proxy) == 0 for 7 consecutive days.
- [ ] Play Store production-track ≥99% install-base on versionCode ≥ 5.
- [ ] Staging has run with `ALLOW_MISSING_IDEMPOTENCY_KEY_UNTIL` unset for ≥48h with zero anomalies.
- [ ] `docs/runbooks/f-a-02-flip-pr-draft.md` has been reviewed by 2 engineers.
- [ ] PagerDuty rotation for the flip window is assigned.
- [ ] Customer + Support team notified (potential 400 spike if monitoring was wrong).

### 7.2 Flip steps

1. **Production env var removal (preferred path — keep code intact for 1 week):**
   ```bash
   # Remove env var from ECS task-definition or whatever secret store is in use.
   # The route code will fall through to reject_400 automatically because
   # graceUntilMs becomes NaN and inGraceWindow becomes false (see
   # src/modules/order/order.routes.ts:207-209).
   aws ecs update-service --cluster weelo-backend --service weelobackend \
     --force-new-deployment --region ap-south-1
   ```
   Monitor `POST /api/v1/orders` 400 rate for 1 hour.

2. **After 1-week prod soak with env var removed, apply the code diff in `f-a-02-flip-pr-draft.md`** to eliminate dead code.

### 7.3 Post-flip validation (T+15min, T+1h, T+24h)

```bash
# CloudWatch — confirm 400 rate is within steady-state noise
aws logs filter-log-events \
  --log-group-name weelobackendtask \
  --filter-pattern "MISSING_IDEMPOTENCY_KEY" \
  --start-time $(date -d '15 minutes ago' +%s000) \
  --region ap-south-1 \
  --output text | wc -l
# Target: < 5 hits in 15 minutes.
```

---

## 8. Rollback procedure

If post-flip 400 rate spikes (>1% of `POST /api/v1/orders` returning MISSING_IDEMPOTENCY_KEY):

1. **Immediate (within 5 minutes):**
   ```bash
   # Re-add env var to push the grace deadline forward
   aws ssm put-parameter --name /weelo/backend/ALLOW_MISSING_IDEMPOTENCY_KEY_UNTIL \
     --value "2026-06-01" --type String --overwrite --region ap-south-1
   aws ecs update-service --cluster weelo-backend --service weelobackend \
     --force-new-deployment --region ap-south-1
   ```
   Grace window reinstated; clients keep working.

2. **Revert PR** (if the flip-diff was already merged per §7.2 step 2) — git revert, re-deploy.

3. **Post-mortem** in `/Users/nitishbhardwaj/Desktop/weelo-backend/.planning/phase3-f-a-02-rollback-postmortem.md` (doc to be created on incident only).

---

## 9. References

- Plan: `.planning/phase3-to-100-plan.md:770-808`
- Risk R6: `.planning/phase3-to-100-plan.md:981`
- Phase 3 commit: `9726e46` (`fix(idempotency): hard-require Idempotency-Key header + payload fingerprint + unique index`)
- Code: `src/modules/order/order.routes.ts:196-235`
- Env: `.env.example:275-282`
- Tests: `src/__tests__/idempotency-hard-require.test.ts:51-80`
- Customer header-introduction commit: `47fb10b` (customer repo, 2026-02-28)
- Customer repo-layer fallback: `app/src/main/java/com/weelo/logistics/data/repository/BookingApiRepository.kt:461-462`
- Stripe pattern: Idempotency-Key header, 24h dedup
- IETF reference: `draft-ietf-httpapi-idempotency-key-header-07` §2 (payload-fingerprint 409)
- CLAUDE.md Phase 3 summary: §"Remaining risk surface" + §"Phase 4 follow-ups" entry "Idempotency deadline flip"

---

## 10. Decision log (fill on 2026-04-29 review)

| Checkpoint | Owner | Date | Status | Notes |
|---|---|---|---|---|
| Counter landed | | | | |
| 7-day zero streak achieved | | | | |
| Play Store distribution pulled | | | | |
| Go/No-go decision | | | | |
| Flip executed | | | | |
| T+24h post-flip clean | | | | |
