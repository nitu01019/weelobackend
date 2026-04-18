/**
 * =============================================================================
 * F-A-70 — Dispatch-outbox outcome capture (RED tests)
 * =============================================================================
 *
 * The P1-T2 consolidation (FF_CREATE_ORDER_CONSOLIDATED) already ported the
 * awaited pattern into `order.service.ts::createOrder` — when the flag is ON,
 * `processDispatchOutboxImmediately(...)` is awaited and its
 * DispatchAttemptOutcome is written back into local `dispatchState`,
 * `onlineCandidates`, and `notifiedTransporters`. When OFF, the legacy
 * fire-and-forget `.catch(...)` runs.
 *
 * F-A-70 completes the loop by adding two observability metrics so we can
 * tell from Grafana which path captured the outcome and detect stale
 * `dispatching` state that never advanced (e.g., if the poller lagged):
 *
 *   order_dispatch_outcome_captured_total{source="immediate"|"poller"}  counter
 *   order_stale_dispatching_state                                        gauge
 *
 * RED assertions are SOURCE-LEVEL. They encode the contract that:
 *   1. Both metric names appear in order.service.ts.
 *   2. The counter is labelled with source=immediate in the awaited branch.
 *   3. The gauge is registered in the central metrics-definitions registry.
 *   4. The awaited path still consumes DispatchAttemptOutcome (idempotent with
 *      F-A-50 — guards against accidental regression).
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LIVE = 'src/modules/order/order.service.ts';
const METRICS_DEFS = 'src/shared/monitoring/metrics-definitions.ts';

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('F-A-70 — dispatch-outbox outcome capture + metric wiring', () => {
  let live: string;
  let defs: string;

  beforeAll(() => {
    live = read(LIVE);
    defs = read(METRICS_DEFS);
  });

  it('fixture#1: order_dispatch_outcome_captured_total counter is emitted with source=immediate in the awaited branch', () => {
    // Consolidated branch awaits the immediate outcome and must record it.
    expect(live).toMatch(/order_dispatch_outcome_captured_total/);
    expect(live).toMatch(/source:\s*['"]immediate['"]/);
  });

  it('fixture#2: order_stale_dispatching_state gauge is referenced in live code (set or reset)', () => {
    expect(live).toMatch(/order_stale_dispatching_state/);
  });

  it('fixture#3: order_dispatch_outcome_captured_total is registered in metrics-definitions.ts', () => {
    expect(defs).toMatch(/order_dispatch_outcome_captured_total/);
  });

  it('fixture#4: order_stale_dispatching_state gauge is registered in metrics-definitions.ts', () => {
    expect(defs).toMatch(/order_stale_dispatching_state/);
  });

  it('fixture#5: awaited dispatch still consumes DispatchAttemptOutcome (regression guard for F-A-50 port)', () => {
    // Mirrors fix-order-service-consolidation.test.ts fixture#6 — pins that
    // the F-A-70 metric wiring did not accidentally remove the outcome handling.
    const awaitIdx = live.search(/await\s+this\.processDispatchOutboxImmediately\(/);
    expect(awaitIdx).toBeGreaterThan(0);
    const slice = live.substring(awaitIdx, awaitIdx + 2000);
    expect(slice).toMatch(/dispatchState\s*=/);
    expect(slice).toMatch(/notifiedTransporters\s*=/);
    expect(slice).toMatch(/onlineCandidates\s*=/);
  });

  it('fixture#6: counter and gauge coexist (both wired, not one dropped)', () => {
    // Sentinel — anyone removing one of the two pair should trip the
    // combined fixture so the outcome-capture contract stays whole.
    const counterCount = (live.match(/order_dispatch_outcome_captured_total/g) || []).length;
    const gaugeCount = (live.match(/order_stale_dispatching_state/g) || []).length;
    expect(counterCount).toBeGreaterThanOrEqual(1);
    expect(gaugeCount).toBeGreaterThanOrEqual(1);
  });
});
