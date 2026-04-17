# F-A-02 — Idempotency Deadline Flip PR (DRAFT — DO NOT APPLY BEFORE 2026-05-01)

**Status:** DRAFT — this is a read-only template. Do NOT merge before the go/no-go gate in `f-a-02-idempotency-deadline-flip.md` §6 is passed.
**Linked runbook:** `docs/runbooks/f-a-02-idempotency-deadline-flip.md`
**Target apply date:** 2026-05-08 (1 week AFTER env var is removed on 2026-05-01, per staged rollout in runbook §7.2)

---

## Rationale

After the 2-week grace window ends and the runbook §6 decision tree returns GO, the code branch that handles the grace window becomes dead. This PR removes the dead branch so future readers are not confused about whether the gate is enforced.

The env-var-removal step (runbook §7.2 step 1) is already sufficient to enforce 400 at the route level — this PR is the **second step**: a clean-up that eliminates dead code and the env entry in `.env.example`.

---

## Proposed diff

### File 1: `src/modules/order/order.routes.ts`

Current state at `src/modules/order/order.routes.ts:196-235` (as of commit `9726e46`):

```typescript
      // F-A-02 FIX: Idempotency-Key header hard-required (Stripe + IETF
      // draft-ietf-httpapi-idempotency-key-header-07). The previous
      // REQUIRE_IDEMPOTENCY_KEY=false branch silently fabricated a UUID
      // server-side, which gave zero dedup protection on retry. We now reject
      // missing/invalid keys outright, with a short 2-week dual-mode grace
      // window gated by ALLOW_MISSING_IDEMPOTENCY_KEY_UNTIL so already-deployed
      // clients that pre-date the header roll-out keep working until the
      // deadline passes.
      const clientKey = (req.headers['x-idempotency-key'] as string | undefined)?.trim();
      const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      const graceUntilRaw = process.env.ALLOW_MISSING_IDEMPOTENCY_KEY_UNTIL;
      const graceUntilMs = graceUntilRaw ? Date.parse(graceUntilRaw) : NaN;
      const inGraceWindow = Number.isFinite(graceUntilMs) && Date.now() < graceUntilMs;

      let idempotencyKey: string;
      if (clientKey && UUID_REGEX.test(clientKey)) {
        idempotencyKey = clientKey;
        logger.debug(`[Orders] Idempotency key from client: ${idempotencyKey.substring(0, 8)}...`);
      } else if (inGraceWindow) {
        // Grace-window fallback: server-generates a UUID so legacy clients
        // keep working, but logs a warn so SRE can track the remaining
        // population of header-missing callers before the deadline flips.
        const { v4: uuidv4 } = require('uuid');
        idempotencyKey = uuidv4();
        logger.warn(
          '[Orders] POST / - Missing/invalid x-idempotency-key within grace window. Server-generated key has no dedup value.',
          { userId: user.userId, graceUntil: graceUntilRaw }
        );
      } else {
        res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_IDEMPOTENCY_KEY',
            message:
              'x-idempotency-key header is required for order creation and must be a UUID v4',
          },
        });
        return;
      }
```

Post-flip state (proposed):

```typescript
      // F-A-02 FIX (post-flip, 2026-05): Idempotency-Key header hard-required
      // (Stripe + IETF draft-ietf-httpapi-idempotency-key-header-07). The
      // 2-week grace window governed by ALLOW_MISSING_IDEMPOTENCY_KEY_UNTIL
      // ended on 2026-05-01. All callers MUST now send a valid UUID v4.
      const clientKey = (req.headers['x-idempotency-key'] as string | undefined)?.trim();
      const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (!clientKey || !UUID_REGEX.test(clientKey)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_IDEMPOTENCY_KEY',
            message:
              'x-idempotency-key header is required for order creation and must be a UUID v4',
          },
        });
        return;
      }
      const idempotencyKey: string = clientKey;
      logger.debug(`[Orders] Idempotency key from client: ${idempotencyKey.substring(0, 8)}...`);
```

**Net change:** ~20 lines removed (the `graceUntilRaw` parsing, the `else if (inGraceWindow)` branch, and the `require('uuid')` import removed from this function scope). Logic that remains: reject-on-missing-or-invalid + accept-on-valid-UUID.

### File 2: `.env.example`

Current state at `.env.example:275-282`:

```
# F-A-02 — idempotency hard-require (Phase 3)
# During the 2-week grace window, legacy clients without an x-idempotency-key
# header still succeed (server fabricates a UUID) so the rollout does not
# break already-shipped customer/captain builds. After the deadline the
# route returns 400 MISSING_IDEMPOTENCY_KEY per Stripe / IETF
# draft-ietf-httpapi-idempotency-key-header-07. Flip by deleting the var
# (or setting a past date) once both mobile apps always send a UUID v4.
ALLOW_MISSING_IDEMPOTENCY_KEY_UNTIL=2026-05-01
```

Post-flip state (proposed): remove all 8 lines. Nothing replaces them.

### File 3: `src/__tests__/idempotency-hard-require.test.ts`

Current tests at `src/__tests__/idempotency-hard-require.test.ts:51-80` cover:

- `rejects missing header AFTER grace deadline` — KEEP (still the default behavior)
- `rejects invalid (non-UUID) header AFTER grace deadline` — KEEP
- `tolerates missing header DURING grace window via server-generated key` — **REMOVE** (grace window no longer exists)
- `tolerates missing header when ALLOW_MISSING_IDEMPOTENCY_KEY_UNTIL is unset (== no grace, reject)` — **UPDATE** — rename to `rejects missing header always (grace window removed 2026-05-01)` and drop the `undefined` env-var parameter from the helper signature.
- `accepts valid UUID v4 client key regardless of grace deadline` — KEEP, simplify (drop the PAST_DATE/FUTURE_DATE matrix).

The helper function signature at `idempotency-hard-require.test.ts:37-41` also simplifies:

```ts
// Before
function decideIdempotencyOutcome(
  clientKey: string | undefined,
  nowMs: number,
  graceUntilRaw: string | undefined
): 'accept_client_key' | 'server_generate_grace' | 'reject_400' { ... }

// After
function decideIdempotencyOutcome(
  clientKey: string | undefined
): 'accept_client_key' | 'reject_400' { ... }
```

---

## Validator / lint guard

The env-lint CI job added in Phase 3 (F-C-75, `.github/workflows/env-lint.yml` per plan line 1024) likely references `ALLOW_MISSING_IDEMPOTENCY_KEY_UNTIL`. Verify and, if so, remove the reference — the var should no longer be required nor warned-about in CI.

Suggested grep at flip time:
```bash
grep -Rn "ALLOW_MISSING_IDEMPOTENCY_KEY_UNTIL" . --exclude-dir=node_modules --exclude-dir=.git
# Expected post-flip: zero matches outside /docs/runbooks/ and this PR draft.
```

---

## Commit message to use (copy-paste on flip day)

```
fix(idempotency): remove ALLOW_MISSING_IDEMPOTENCY_KEY_UNTIL grace window (F-A-02 post-flip)

The 2-week dual-mode grace window ended on 2026-05-01 and the production
env var was already removed (see docs/runbooks/f-a-02-idempotency-deadline-flip.md
step 7.2.1). This commit eliminates the now-dead grace-window branch and
simplifies the route to reject-or-accept.

- Remove `inGraceWindow` branch from src/modules/order/order.routes.ts
  (~20 LOC, no behavior change — env var was unset in prod for 1 week)
- Remove ALLOW_MISSING_IDEMPOTENCY_KEY_UNTIL from .env.example
- Update src/__tests__/idempotency-hard-require.test.ts to drop grace-window
  cases (3 tests removed/simplified, 2 kept)

Pattern: Stripe Idempotency-Key (hard-required), IETF
draft-ietf-httpapi-idempotency-key-header-07 §2

Risk: LOW — env var has been unset in prod for 1 week; this is dead-code
removal, not behavior change. CloudWatch `MISSING_IDEMPOTENCY_KEY` count
has been 0 for 7+ consecutive days per runbook §6 gate.

Refs: Phase 3 commit 9726e46, runbook
docs/runbooks/f-a-02-idempotency-deadline-flip.md
```

---

## Verification (apply only AFTER merge)

```bash
# Staging smoke
curl -X POST https://staging.weelo.api/api/v1/orders \
  -H "Authorization: Bearer <test-token>" \
  -H "Content-Type: application/json" \
  -d '{"pickup":{...},"drop":{...},"vehicleRequirements":[]}'
# Expected: HTTP 400 { "error": { "code": "MISSING_IDEMPOTENCY_KEY" }}

curl -X POST https://staging.weelo.api/api/v1/orders \
  -H "Authorization: Bearer <test-token>" \
  -H "x-idempotency-key: 550e8400-e29b-41d4-a716-446655440000" \
  -H "Content-Type: application/json" \
  -d '{"pickup":{...},"drop":{...},"vehicleRequirements":[]}'
# Expected: HTTP 201 with order payload
```

---

## Do NOT apply this PR if ANY of the following is true

- Runbook §6 go/no-go has not passed.
- Env var `ALLOW_MISSING_IDEMPOTENCY_KEY_UNTIL` has not been removed from production for ≥ 1 week.
- `missing_idempotency_key_total` (or log-based proxy) is non-zero over the last 7 days.
- Play Store production-track distribution < 99% on versionCode ≥ 5.
- Any open incidents touching `POST /api/v1/orders`.
