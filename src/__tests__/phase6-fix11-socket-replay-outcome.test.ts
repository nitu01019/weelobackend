/**
 * =============================================================================
 * Phase 6 / Fix #11 — socket_reconnect_replay_total SLI counter + 5 call sites
 * =============================================================================
 *
 * Validates the four expectations from the validated source doc:
 *   (a) Phase4 replay success path increments the success counter (verified
 *       via source-code-string wire-up assertion + counter registration).
 *   (b) Phase4 replay failure path increments the failure counter (verified
 *       via source-code-string wire-up assertion).
 *   (c) Compile-test claim: `recordReplayOutcome('badsource', ...)` fails tsc
 *       because the helper's `source` parameter is the literal-union derived
 *       from a const-asserted tuple. Validated by parsing the helper's typed
 *       signature out of the source file.
 *   (d) Wire-up coverage: assert helper is invoked at all 5 swallow sites
 *       (booking_active, order_active, customer_state_sync, phase4 success,
 *       phase4 failure) via a grep-style regex scan of socket.service.ts.
 *
 * `recordReplayOutcome` is a module-private helper scoped inside the
 * `initializeSocketIO` initializer closure, so it is not directly importable.
 * The tests therefore inspect the source file content for control-flow
 * placement + count of call sites. This is sufficient because:
 *   - counter registration is tested independently in metrics-definitions.ts;
 *   - call-site placement (immediately inside catch / inside the success
 *     branch) is what the SLI's correctness depends on.
 * =============================================================================
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { registerDefaultCounters } from '../shared/monitoring/metrics-definitions';
import type { CounterMetric } from '../shared/monitoring/metrics.service';

const SOCKET_SERVICE_PATH = join(__dirname, '..', 'shared', 'services', 'socket.service.ts');
const METRICS_DEFS_PATH = join(__dirname, '..', 'shared', 'monitoring', 'metrics-definitions.ts');

describe('Phase 6 — Fix #11 socket_reconnect_replay_total SLI', () => {
  let socketSource: string;
  let metricsDefsSource: string;

  beforeAll(() => {
    socketSource = readFileSync(SOCKET_SERVICE_PATH, 'utf8');
    metricsDefsSource = readFileSync(METRICS_DEFS_PATH, 'utf8');
  });

  // -----------------------------------------------------------------------
  // (counter registration) — both new counters present in default registry
  // -----------------------------------------------------------------------
  describe('counter registration in metrics-definitions.ts', () => {
    it('registers socket_reconnect_replay_total in registerDefaultCounters', () => {
      const counters = new Map<string, CounterMetric>();
      registerDefaultCounters(counters);
      const total = counters.get('socket_reconnect_replay_total');
      expect(total).toBeDefined();
      expect(total?.help).toMatch(/outcome.*role.*source/i);
    });

    it('registers socket_reconnect_replay_messages_total in registerDefaultCounters', () => {
      const counters = new Map<string, CounterMetric>();
      registerDefaultCounters(counters);
      const messages = counters.get('socket_reconnect_replay_messages_total');
      expect(messages).toBeDefined();
      expect(messages?.help).toMatch(/messages replayed/i);
    });
  });

  // -----------------------------------------------------------------------
  // (a) Phase4 success path — counter call site present
  // -----------------------------------------------------------------------
  it("(a) Phase4 success branch invokes recordReplayOutcome('phase4', ..., 'success', N)", () => {
    // Expect: a single-line invocation with source=phase4, outcome=success and
    // a messageCount argument (4th positional arg).
    expect(socketSource).toMatch(
      /recordReplayOutcome\('phase4',\s*role[^,]*,\s*'success',\s*messages\.length\)/
    );
  });

  // -----------------------------------------------------------------------
  // (b) Phase4 failure path — counter call site present in catch block
  // -----------------------------------------------------------------------
  it("(b) Phase4 catch block invokes recordReplayOutcome('phase4', ..., 'failure')", () => {
    // The failure call must be inside the catch handler that follows the
    // [Phase4] Sequence replay failed log line — assert that ordering.
    const idx = socketSource.indexOf('[Phase4] Sequence replay failed');
    expect(idx).toBeGreaterThan(0);
    const afterCatch = socketSource.slice(idx, idx + 400);
    expect(afterCatch).toMatch(
      /recordReplayOutcome\('phase4',\s*role[^,]*,\s*'failure'\)/
    );
  });

  // -----------------------------------------------------------------------
  // (c) Compile-test claim: helper's `source` parameter type is the const-
  // asserted literal union — `'badsource'` (uncast) MUST be rejected by tsc.
  // We can't actually run tsc on a synthetic snippet inside Jest, but we can
  // assert the literal-union machinery is in place: the `as const` tuple +
  // the `typeof [...][number]` derivation. That is what makes a stray
  // string literal a tsc error.
  // -----------------------------------------------------------------------
  it("(c) helper uses const-asserted tuples for ReplaySource and ReplayOutcome", () => {
    expect(socketSource).toMatch(
      /const REPLAY_OUTCOMES\s*=\s*\['success',\s*'failure',\s*'empty'\]\s*as const/
    );
    expect(socketSource).toMatch(
      /const REPLAY_SOURCES\s*=\s*\['phase4',\s*'booking_active',\s*'order_active',\s*'customer_state_sync'\]\s*as const/
    );
    expect(socketSource).toMatch(
      /type ReplaySource\s*=\s*typeof REPLAY_SOURCES\[number\]/
    );
    expect(socketSource).toMatch(
      /type ReplayOutcome\s*=\s*typeof REPLAY_OUTCOMES\[number\]/
    );
  });

  // -----------------------------------------------------------------------
  // (d) Wire-up coverage — assert all 4 sources appear AND every source has
  // a 'failure' branch.
  // -----------------------------------------------------------------------
  it('(d) all 4 sources are wired with both success/empty and failure', () => {
    const sources = ['phase4', 'booking_active', 'order_active', 'customer_state_sync'] as const;
    for (const source of sources) {
      // success or empty branch
      const successOrEmpty = new RegExp(
        `recordReplayOutcome\\('${source}',[^,]+,\\s*'(success|empty)'`
      );
      expect(socketSource).toMatch(successOrEmpty);
      // failure branch
      const failure = new RegExp(
        `recordReplayOutcome\\('${source}',[^,]+,\\s*'failure'\\)`
      );
      expect(socketSource).toMatch(failure);
    }
  });

  it('(d.1) total recordReplayOutcome call sites is >= 5', () => {
    // 4 sources × (success+failure) = 8 minimum (some also have empty).
    // The Solution wires booking/order/customer success+empty+failure (3 each
    // = 9) and phase4 success+empty+failure (3) = 12 total. Floor at 5 is the
    // doc's grep-test threshold.
    const matches = socketSource.match(/recordReplayOutcome\(/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(5);
  });

  it('(d.2) helper definition is present in socket.service.ts', () => {
    expect(socketSource).toMatch(
      /function recordReplayOutcome\(\s*source:\s*ReplaySource,\s*role:\s*string,\s*outcome:\s*ReplayOutcome/
    );
  });

  it('(d.3) helper increments socket_reconnect_replay_total inside try/catch', () => {
    expect(socketSource).toMatch(
      /metrics\.incrementCounter\('socket_reconnect_replay_total',\s*\{\s*outcome,\s*role,\s*source\s*\}\)/
    );
  });

  it('(d.4) helper increments socket_reconnect_replay_messages_total only on success>0', () => {
    expect(socketSource).toMatch(
      /metrics\.incrementCounter\('socket_reconnect_replay_messages_total',\s*\{\s*role,\s*source\s*\},\s*messageCount\)/
    );
    expect(socketSource).toMatch(
      /if\s*\(\s*outcome === 'success' && messageCount > 0\s*\)/
    );
  });

  it('(d.5) metrics definitions file documents the new counters with cardinality bound comment', () => {
    expect(metricsDefsSource).toMatch(/Fix #11/);
    expect(metricsDefsSource).toMatch(/socket_reconnect_replay_total/);
    expect(metricsDefsSource).toMatch(/socket_reconnect_replay_messages_total/);
  });
});
