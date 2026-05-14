/**
 * =============================================================================
 * PHASE 3 — FIX #23 EDIT 3.E — Truck-Hold Opt-In Full-Jitter Retry
 * =============================================================================
 *
 * Validates that the per-truck acquireLock call inside
 * `truck-hold.service.ts::HoldStore.add` is invoked with the Estela #23 EDIT
 * 3.E opt-in retry options:
 *
 *   retries:        3   (4 acquire attempts total)
 *   baseDelayMs:    25
 *   maxDelayMs:     250
 *   deadlineMs:     400 (per task brief — 4G mobile budget)
 *   acquireBudgetMs: 50 (Eris R7 — reserve for final RTT)
 *
 * The cleanup-then-return-false path remains intact (per-truck retries do
 * NOT solve multi-truck atomicity), and the hardcoded 50ms sleep at L317
 * is removed — Full-Jitter retries replace it.
 *
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

describe('Fix #23 EDIT 3.E — truck-hold opt-in retry call shape', () => {
  const sourcePath = path.resolve(
    __dirname,
    '../modules/truck-hold/truck-hold.service.ts'
  );
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(sourcePath, 'utf-8');
  });

  // ------------------------------------------------------------------------
  // (1) The opt-in retry options object MUST be passed to acquireLock inside
  //     the per-truck loop. Verifying via source-text match so that the call
  //     signature is preserved across refactors.
  // ------------------------------------------------------------------------
  test('(1) per-truck acquireLock uses retries=3 + Full-Jitter opts', () => {
    // Anchor on the per-truck-loop acquireLock invocation. Tolerate optional
    // whitespace/newlines between fields by matching each property in order
    // with `\s*,\s*` between them.
    const expectedFields = [
      /retries\s*:\s*3/,
      /baseDelayMs\s*:\s*25/,
      /maxDelayMs\s*:\s*250/,
      /deadlineMs\s*:\s*400/,
      /acquireBudgetMs\s*:\s*50/,
    ];
    for (const re of expectedFields) {
      expect(source).toMatch(re);
    }
  });

  // ------------------------------------------------------------------------
  // (2) The hardcoded `setTimeout(resolve, 50)` MUST be removed — the
  //     Full-Jitter retries above replace the prior backoff.
  // ------------------------------------------------------------------------
  test('(2) hardcoded 50ms backoff is removed from the per-truck loop', () => {
    // Find the HoldStore.add method window and assert the 50ms sleep is gone.
    const methodStart = source.indexOf('async add(hold: TruckHold)');
    expect(methodStart).toBeGreaterThan(-1);
    const methodEnd = source.indexOf('async ', methodStart + 100);
    const methodWindow = source.substring(methodStart, methodEnd);

    expect(methodWindow).not.toMatch(/setTimeout\(\s*resolve\s*,\s*50\s*\)/);
  });

  // ------------------------------------------------------------------------
  // (3) Cleanup-then-return-false path MUST still release prior locks —
  //     per-truck retries do NOT solve multi-truck atomicity. The for-loop
  //     iterating `lockResults.length - 1` and calling releaseLock must
  //     remain. This is the multi-truck cleanup invariant.
  // ------------------------------------------------------------------------
  test('(3) cleanup-then-return-false path retained for multi-truck atomicity', () => {
    const methodStart = source.indexOf('async add(hold: TruckHold)');
    const methodEnd = source.indexOf('async ', methodStart + 100);
    const methodWindow = source.substring(methodStart, methodEnd);

    expect(methodWindow).toMatch(/for\s*\(\s*let\s+i\s*=\s*0;\s*i\s*<\s*lockResults\.length\s*-\s*1/);
    expect(methodWindow).toMatch(/releaseLock\(\s*\n?\s*REDIS_KEYS\.TRUCK_LOCK\(sortedTruckIds\[i\]\)/);
    expect(methodWindow).toMatch(/return false/);
  });

  // ------------------------------------------------------------------------
  // (4) The opt-in retry opts are passed as the 4th argument to acquireLock
  //     (NOT a separate call). Verify the call shape:
  //     acquireLock(lockKey, hold.transporterId, CONFIG.HOLD_DURATION_SECONDS, { ... })
  // ------------------------------------------------------------------------
  test('(4) acquireLock 4-arg call shape with opts as the 4th arg', () => {
    // Match: acquireLock( ... , ... , CONFIG.HOLD_DURATION_SECONDS , { retries: 3, ...
    const callShape = /acquireLock\([\s\S]*?CONFIG\.HOLD_DURATION_SECONDS,\s*\{\s*retries:\s*3/;
    expect(source).toMatch(callShape);
  });
});
