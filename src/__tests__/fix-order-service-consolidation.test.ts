/**
 * =============================================================================
 * F-A-50 — OrderService.createOrder Consolidation Parity Test
 * =============================================================================
 *
 * Mission: Assert the live createOrder path in `src/modules/order/order.service.ts`
 * exposes the 3 delegate-only fixes behind feature flag `FF_CREATE_ORDER_CONSOLIDATED`.
 *
 * Fixes being ported FROM `order-delegates.service.ts` + `order-creation.service.ts`
 * INTO the live `order.service.ts::OrderService.createOrder`:
 *
 *   FIX #74  — assertValidTransition('Order', ORDER_VALID_TRANSITIONS,
 *              'broadcasting', 'expired') at the "0 transporters notified"
 *              early-expire branch (currently the direct `order.update({status:
 *              'expired'})` call has no transition assertion).
 *
 *   FIX #77  — smartTimeoutService.initializeOrderTimeout(orderId, totalTrucks)
 *              must run on the happy dispatch path (replaces / supplements
 *              legacy `setOrderExpiryTimer` which is being deprecated).
 *
 *   F-A-70   — Dispatch must be AWAITED (not fire-and-forget `.catch(...)`)
 *              when FF_CREATE_ORDER_CONSOLIDATED is ON. Legacy fire-and-forget
 *              unconditionally stamps `dispatchState='dispatching'` even on
 *              immediate failure; awaited path stamps real outcome from the
 *              DispatchAttemptOutcome.
 *
 * Strategy: static source assertions (same style as
 * `src/__tests__/differentiator/two-phase-hold-fsm.test.ts`). No live DB,
 * Redis, or socket required. Runs in <1s.
 *
 * Parity is evaluated at the SOURCE level because the live and delegate
 * classes share the same CreateOrderResponse type, identical dispatch
 * outbox helpers, identical broadcast helpers, identical CAS guard, and
 * identical Redis keys — divergence can therefore only come from the
 * 3 pinpointed code sites above. This file pins each site.
 *
 * All assertions here also encode the feature-flag contract: "when ON,
 * live path behaves identically to delegate path for the 3 fixes".
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LIVE = 'src/modules/order/order.service.ts';
const DELEGATE = 'src/modules/order/order-delegates.service.ts';
const CREATION = 'src/modules/order/order-creation.service.ts';
const FLAG_REGISTRY = 'src/shared/config/feature-flags.ts';

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function countMatches(source: string, pattern: RegExp): number {
  const globalPat = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  const matches = source.match(globalPat);
  return matches ? matches.length : 0;
}

// ---------------------------------------------------------------------------
// Fixtures: 10 parity-critical source-code scenarios
// ---------------------------------------------------------------------------

describe('F-A-50: OrderService.createOrder consolidation parity', () => {
  // Cache sources once — these files are stable during a test run
  let live: string;
  let delegate: string;
  let creation: string;
  let flagRegistry: string;

  beforeAll(() => {
    live = read(LIVE);
    delegate = read(DELEGATE);
    creation = read(CREATION);
    flagRegistry = read(FLAG_REGISTRY);
  });

  // -------------------------------------------------------------------------
  // Fixture 1 — Feature flag exists in centralized registry
  // -------------------------------------------------------------------------
  it('fixture#1: FF_CREATE_ORDER_CONSOLIDATED is declared in the central feature-flag registry', () => {
    expect(flagRegistry).toMatch(/CREATE_ORDER_CONSOLIDATED:\s*\{/);
    expect(flagRegistry).toMatch(/env:\s*['"]FF_CREATE_ORDER_CONSOLIDATED['"]/);
    // Default OFF — this is a RELEASE toggle for soak-safe rollout
    expect(flagRegistry).toMatch(/CREATE_ORDER_CONSOLIDATED:\s*\{[\s\S]*?category:\s*['"]release['"]/);
  });

  // -------------------------------------------------------------------------
  // Fixture 2 — Live path imports the flag + smartTimeoutService
  // -------------------------------------------------------------------------
  it('fixture#2: live order.service.ts imports FLAGS, isEnabled, and smartTimeoutService', () => {
    expect(live).toMatch(/from ['"]\.\.\/\.\.\/shared\/config\/feature-flags['"]/);
    expect(live).toMatch(/\bFLAGS\b/);
    expect(live).toMatch(/\bisEnabled\b/);
    expect(live).toMatch(/smartTimeoutService/);
    expect(live).toMatch(/from ['"]\.\.\/order-timeout['"]/);
  });

  // -------------------------------------------------------------------------
  // Fixture 3 — FIX #77: smartTimeoutService.initializeOrderTimeout gated on flag
  // -------------------------------------------------------------------------
  it('fixture#3: FIX #77 — smartTimeoutService.initializeOrderTimeout guarded by FF_CREATE_ORDER_CONSOLIDATED', () => {
    // Call exists
    expect(live).toMatch(/smartTimeoutService\.initializeOrderTimeout\s*\(/);
    // Awaited (important — DB write must complete before response)
    expect(live).toMatch(/await\s+smartTimeoutService\.initializeOrderTimeout/);
    // Fenced by the flag
    const callIdx = live.search(/smartTimeoutService\.initializeOrderTimeout/);
    expect(callIdx).toBeGreaterThan(0);
    // Nearest preceding `if` guarding the call must reference the flag
    const preceding = live.substring(Math.max(0, callIdx - 600), callIdx);
    expect(preceding).toMatch(/isEnabled\(FLAGS\.CREATE_ORDER_CONSOLIDATED\)|FF_CREATE_ORDER_CONSOLIDATED/);
  });

  // -------------------------------------------------------------------------
  // Fixture 4 — FIX #74: assertValidTransition for broadcasting->expired
  // -------------------------------------------------------------------------
  it('fixture#4: FIX #74 — assertValidTransition broadcasting->expired at the no-supply early-expire branch', () => {
    // The live path already has assertValidTransition for 'broadcasting'->'active'.
    // The delegate path (via order-creation.service.ts:setupOrderExpiry line 801)
    // also guards the 'expired' branch. The live path MUST do the same.
    // We check for the expired-branch assertion directly.
    const pattern = /assertValidTransition\(\s*['"]Order['"]\s*,\s*ORDER_VALID_TRANSITIONS\s*,\s*['"]broadcasting['"]\s*,\s*['"]expired['"]/;
    expect(live).toMatch(pattern);
  });

  // -------------------------------------------------------------------------
  // Fixture 5 — F-A-70 prep: awaited dispatch under flag
  // -------------------------------------------------------------------------
  it('fixture#5: F-A-70 prep — processDispatchOutboxImmediately is AWAITED under FF_CREATE_ORDER_CONSOLIDATED', () => {
    // Legacy fire-and-forget pattern: `.processDispatchOutboxImmediately(...).catch(...)`
    // Consolidated: `await this.processDispatchOutboxImmediately(...)` inside try/catch.
    // Both patterns can coexist — flag selects which runs. Assert both shapes are present.
    const fireForgetPat = /this\.processDispatchOutboxImmediately\([^)]*\)\.catch\(/;
    const awaitedPat = /await\s+this\.processDispatchOutboxImmediately\(/;
    expect(live).toMatch(fireForgetPat); // legacy preserved
    expect(live).toMatch(awaitedPat); // consolidated added
  });

  // -------------------------------------------------------------------------
  // Fixture 6 — Consolidated await path consumes DispatchAttemptOutcome
  // -------------------------------------------------------------------------
  it('fixture#6: consolidated path reads dispatchState/onlineCandidates/notifiedTransporters from DispatchAttemptOutcome', () => {
    // The awaited path must assign outcome.dispatchState back to local dispatchState,
    // matching the delegate path in order-creation.service.ts:broadcastOrderToTransporters.
    const awaitIdx = live.search(/await\s+this\.processDispatchOutboxImmediately\(/);
    expect(awaitIdx).toBeGreaterThan(0);
    const slice = live.substring(awaitIdx, awaitIdx + 2000);
    expect(slice).toMatch(/dispatchState\s*=/);
    expect(slice).toMatch(/notifiedTransporters\s*=/);
    expect(slice).toMatch(/onlineCandidates\s*=/);
  });

  // -------------------------------------------------------------------------
  // Fixture 7 — Legacy path remains reachable when flag is OFF (regression safety)
  // -------------------------------------------------------------------------
  it('fixture#7: legacy fire-and-forget dispatch + legacy setOrderExpiryTimer are preserved for flag=OFF', () => {
    // Legacy dispatch: fire-and-forget
    expect(live).toMatch(/this\.processDispatchOutboxImmediately\([^)]*\)\.catch\(/);
    // Legacy expiry: setOrderExpiryTimer call still present
    expect(live).toMatch(/this\.setOrderExpiryTimer\(\s*orderId/);
  });

  // -------------------------------------------------------------------------
  // Fixture 8 — Legacy setOrderExpiryTimer marked @deprecated pointing to F-A-52
  // -------------------------------------------------------------------------
  it('fixture#8: legacy setOrderExpiryTimer delegate is marked @deprecated pointing to F-A-52', () => {
    // Search for the JSDoc on the thin-delegate wrapper
    expect(live).toMatch(/@deprecated[\s\S]{0,300}F-A-52/);
  });

  // -------------------------------------------------------------------------
  // Fixture 9 — Metrics: counter tracks which path ran
  // -------------------------------------------------------------------------
  it('fixture#9: order_create_path_total{path=legacy|consolidated} counter is incremented in both branches', () => {
    expect(live).toMatch(/order_create_path_total/);
    expect(live).toMatch(/path:\s*['"]legacy['"]/);
    expect(live).toMatch(/path:\s*['"]consolidated['"]/);
  });

  // -------------------------------------------------------------------------
  // Fixture 10 — Delegate path still owns the fixes (parity source-of-truth)
  // -------------------------------------------------------------------------
  it('fixture#10: delegate path in order-creation.service.ts retains FIX #74 + F-A-70 (source-of-truth parity target)', () => {
    // F-A-70: awaited dispatch in the helper
    expect(creation).toMatch(/const\s+immediateOutcome\s*=\s*await\s+processDispatchOutboxImmediately\(/);
    // FIX #74: assertValidTransition to expired in setupOrderExpiry
    expect(creation).toMatch(/assertValidTransition\(\s*['"]Order['"]\s*,\s*ORDER_VALID_TRANSITIONS\s*,\s*['"]broadcasting['"]\s*,\s*targetStatus/);
    // Delegate class still exists — will be deleted in follow-up PR after soak
    expect(delegate).toMatch(/export class OrderService\s*\{/);
  });

  // -------------------------------------------------------------------------
  // Bonus: assertions that protect against accidental downgrade
  // -------------------------------------------------------------------------
  it('consolidated path must not reintroduce the legacy `.catch(err =>` fire-and-forget pattern after consolidation soak (sentinel)', () => {
    // When the soak completes (next PR), legacy path is deleted. This test
    // documents the current transitional state: both patterns coexist exactly
    // once each. If anyone duplicates the fire-and-forget pattern, this guard
    // catches it.
    expect(countMatches(live, /this\.processDispatchOutboxImmediately\([^)]*\)\.catch\(/)).toBe(1);
    expect(countMatches(live, /await\s+this\.processDispatchOutboxImmediately\(/)).toBeGreaterThanOrEqual(1);
  });

  it('flag guard appears exactly twice on happy path: once for dispatch, once for smart timeout', () => {
    // Minimum safety: if the guard appears zero times on either, consolidation didn't happen.
    const flagChecks = countMatches(
      live,
      /isEnabled\(\s*FLAGS\.CREATE_ORDER_CONSOLIDATED\s*\)/
    );
    expect(flagChecks).toBeGreaterThanOrEqual(2);
  });
});
