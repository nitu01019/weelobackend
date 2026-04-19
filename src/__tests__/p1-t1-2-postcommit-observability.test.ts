/**
 * P1 — T1.2 post-commit observability tests.
 *
 * Covers:
 *   L2  — `post_commit_cache_failure_total{cache}` increments on the two
 *         fail-soft cache catch branches in `order.service.ts`.
 *   M18 — `socket_emit_while_adapter_down_total{event, mode}` increments
 *         from `emitToUser` when `redisPubSubInitialized === false`.
 *
 * The tests deliberately stay out of `orderService.createOrder`'s full
 * dependency graph (DB, Redis, geo services). They:
 *   - assert the counters are pre-registered and label cleanly,
 *   - assert the call sites still wire the counter (source-scan guard),
 *   - exercise `emitToUser` against a real in-process Socket.IO server
 *     running in single-instance mode so `redisPubSubInitialized` is
 *     guaranteed `false`.
 */

import { readFileSync } from 'fs';
import path from 'path';
import http from 'http';

import { metrics } from '../shared/monitoring/metrics.service';
import { logger } from '../shared/services/logger.service';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type CountersSnapshot = Record<string, number>;

function countersFor(name: string): CountersSnapshot {
  const json = metrics.getMetricsJSON();
  const counters = json.counters as Record<string, CountersSnapshot>;
  // getMetricsJSON returns the live label map by reference — clone so
  // snapshots taken before and after an action are truly independent.
  return { ...(counters[name] ?? {}) };
}

function readSource(relPath: string): string {
  return readFileSync(path.resolve(__dirname, '..', relPath), 'utf8');
}

function someStringCallIncludes(
  spy: jest.SpyInstance,
  needle: string
): boolean {
  return spy.mock.calls.some((call: unknown[]) => {
    const first = call[0];
    return typeof first === 'string' && first.includes(needle);
  });
}

// -----------------------------------------------------------------------------
// L2 — post_commit_cache_failure_total
// -----------------------------------------------------------------------------

describe('P1-T1.2 L2 — post_commit_cache_failure_total', () => {
  it('counter is pre-registered (no auto-create warn on first increment)', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
    metrics.incrementCounter('post_commit_cache_failure_total', {
      cache: 'google_directions'
    });
    expect(someStringCallIncludes(warnSpy, 'post_commit_cache_failure_total')).toBe(false);
    warnSpy.mockRestore();
  });

  it('increments with {cache: "google_directions"} label', () => {
    const before =
      countersFor('post_commit_cache_failure_total')['cache="google_directions"'] ?? 0;
    metrics.incrementCounter('post_commit_cache_failure_total', {
      cache: 'google_directions'
    });
    const after =
      countersFor('post_commit_cache_failure_total')['cache="google_directions"'] ?? 0;
    expect(after - before).toBe(1);
  });

  it('increments with {cache: "idempotency"} label, independent of google_directions', () => {
    const beforeIdem =
      countersFor('post_commit_cache_failure_total')['cache="idempotency"'] ?? 0;
    const beforeGoogle =
      countersFor('post_commit_cache_failure_total')['cache="google_directions"'] ?? 0;
    metrics.incrementCounter('post_commit_cache_failure_total', { cache: 'idempotency' });
    metrics.incrementCounter('post_commit_cache_failure_total', { cache: 'idempotency' });
    const afterIdem =
      countersFor('post_commit_cache_failure_total')['cache="idempotency"'] ?? 0;
    const afterGoogle =
      countersFor('post_commit_cache_failure_total')['cache="google_directions"'] ?? 0;
    expect(afterIdem - beforeIdem).toBe(2);
    expect(afterGoogle - beforeGoogle).toBe(0);
  });

  it('Prometheus export surfaces the counter', () => {
    metrics.incrementCounter('post_commit_cache_failure_total', {
      cache: 'google_directions'
    });
    const output = metrics.getPrometheusMetrics();
    expect(output).toContain('post_commit_cache_failure_total');
  });

  it('order.service.ts wires both fail-soft catch branches to the counter', () => {
    // Guardrail: if a future refactor removes or relocates the instrumentation,
    // this test fails loudly. These strings mirror the exact calls added by P1-T1.2.
    const source = readSource('modules/order/order.service.ts');

    expect(source).toContain(
      "metrics.incrementCounter('post_commit_cache_failure_total', { cache: 'google_directions' })"
    );
    expect(source).toContain(
      "metrics.incrementCounter('post_commit_cache_failure_total', { cache: 'idempotency' })"
    );
  });
});

// -----------------------------------------------------------------------------
// M18 — socket_emit_while_adapter_down_total
// -----------------------------------------------------------------------------

describe('P1-T1.2 M18 — socket_emit_while_adapter_down_total', () => {
  let httpServer: http.Server | null = null;
  let socketModule: typeof import('../shared/services/socket.service') | null = null;

  // Force single-instance mode BEFORE importing socket.service so that
  // `setupRedisAdapter` early-returns and leaves `redisPubSubInitialized = false`.
  //
  // NOTE: we intentionally do NOT call `jest.resetModules()` here — that would
  // cause `require('../monitoring/metrics.service')` inside socket.service to
  // load a fresh singleton that our top-level `metrics` import doesn't see,
  // and the counter increment would be invisible to the test.
  beforeAll(async () => {
    process.env.REDIS_ENABLED = 'false';

    socketModule = require('../shared/services/socket.service') as typeof import('../shared/services/socket.service');

    httpServer = http.createServer();
    await new Promise<void>(resolve => httpServer!.listen(0, () => resolve()));
    socketModule.initializeSocket(httpServer);
    // Let setupRedisAdapter's early-return logger.info path settle.
    await new Promise(resolve => setImmediate(resolve));
  });

  afterAll(async () => {
    if (httpServer) {
      await new Promise<void>(resolve => httpServer!.close(() => resolve()));
    }
  });

  it('counter is pre-registered (no auto-create warn on first increment)', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
    metrics.incrementCounter('socket_emit_while_adapter_down_total', {
      event: 'test_event',
      mode: 'disabled'
    });
    expect(someStringCallIncludes(warnSpy, 'socket_emit_while_adapter_down_total')).toBe(false);
    warnSpy.mockRestore();
  });

  it('adapter-down state is correctly reported by getRedisAdapterStatus', () => {
    const status = socketModule!.getRedisAdapterStatus();
    expect(status.enabled).toBe(false);
    expect(['disabled', 'disabled_by_config', 'disabled_by_capability', 'failed']).toContain(
      status.mode
    );
  });

  it('emitToUser increments counter with {event, mode} when adapter is down', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
    const before = countersFor('socket_emit_while_adapter_down_total');

    socketModule!.emitToUser('user-xyz', 'booking_new', { bookingId: 'b-1' });

    const after = countersFor('socket_emit_while_adapter_down_total');
    // labelsToKey sorts alphabetically → `event="booking_new",mode="<...>"`.
    const matchingKey = Object.keys(after).find(
      k => k.includes('event="booking_new"') && k.includes('mode=')
    );
    expect(matchingKey).toBeDefined();
    const beforeValue = before[matchingKey!] ?? 0;
    expect(after[matchingKey!]).toBe(beforeValue + 1);

    expect(someStringCallIncludes(warnSpy, 'Redis adapter down')).toBe(true);
    warnSpy.mockRestore();
  });

  it('Prometheus export surfaces the counter', () => {
    const output = metrics.getPrometheusMetrics();
    expect(output).toContain('socket_emit_while_adapter_down_total');
  });

  it('socket.service.ts wires the counter inside the adapter-down branch', () => {
    const source = readSource('shared/services/socket.service.ts');
    expect(source).toContain("'socket_emit_while_adapter_down_total'");
    expect(source).toContain('Redis adapter down — broadcasting to local instance only');
  });
});
