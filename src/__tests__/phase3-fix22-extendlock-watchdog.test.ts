/**
 * Phase 3 / Fix #22 — PEXPIRE watchdog tests.
 *
 * Verifies:
 *   (a) extendLock returns true on holder match (Redis Lua path = 1)
 *   (b) extendLock returns false on holder mismatch (Lua path = 0)
 *   (c) extendLock with ttlMs=0 returns false + emits invalid_ttl
 *   (d) extendLock with ttlMs=NaN returns false + emits invalid_ttl
 *   (e) withWatchdog auto-renews lock at TTL/3 cadence during a long critical section
 *   (f) withWatchdog cleanup on fn success: interval cleared, releaseLock called
 *   (g) withWatchdog cleanup on fn throw: interval cleared, releaseLock called, error rethrown
 *
 * Strategy: swap `(redisService as any).client` for a controllable mock that lets
 * each test dictate Lua eval return values (1, 0, null, or BigInt for ioredis
 * cluster-mode parity).
 */

const incrementCounter = jest.fn();
jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter,
    observeHistogram: jest.fn(),
    setGauge: jest.fn(),
  },
}));

import { redisService } from '../shared/services/redis.service';

type LuaResult = number | bigint | null;

interface MockClient {
  eval: jest.Mock;
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
  expire: jest.Mock;
  exists: jest.Mock;
}

function buildMockClient(): MockClient {
  return {
    eval: jest.fn(),
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(true),
    expire: jest.fn().mockResolvedValue(true),
    exists: jest.fn(),
  };
}

const ORIGINAL_CLIENT = (redisService as unknown as { client: unknown }).client;

function installMockClient(mock: MockClient): void {
  (redisService as unknown as { client: MockClient }).client = mock;
}

function restoreClient(): void {
  (redisService as unknown as { client: unknown }).client = ORIGINAL_CLIENT;
}

afterEach(() => {
  restoreClient();
  incrementCounter.mockClear();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// extendLock tests
// ---------------------------------------------------------------------------

describe('redisService.extendLock', () => {
  test('(a) returns true when Lua eval reports holder match (result === 1)', async () => {
    const client = buildMockClient();
    client.eval.mockResolvedValueOnce(1 as LuaResult);
    installMockClient(client);

    const ok = await redisService.extendLock('truck:42', 'holder-A', 5000);

    expect(ok).toBe(true);
    expect(client.eval).toHaveBeenCalledTimes(1);
    const [script, keys, args] = client.eval.mock.calls[0];
    expect(script).toMatch(/pexpire/);
    expect(keys).toEqual(['lock:truck:42']);
    expect(args).toEqual(['holder-A', '5000']);
    // No failure counter on success path.
    expect(incrementCounter).not.toHaveBeenCalledWith(
      'redis_lock_extend_failed_total',
      expect.anything()
    );
  });

  test('(a.bigint) handles ioredis cluster-mode BigInt(1) return', async () => {
    const client = buildMockClient();
    client.eval.mockResolvedValueOnce(BigInt(1) as LuaResult);
    installMockClient(client);

    const ok = await redisService.extendLock('truck:99', 'holder-B', 1500);
    expect(ok).toBe(true);
  });

  test('(b) returns false when Lua eval reports holder mismatch (result === 0) and emits not_held', async () => {
    const client = buildMockClient();
    client.eval.mockResolvedValueOnce(0 as LuaResult);
    installMockClient(client);

    const ok = await redisService.extendLock('truck:42', 'holder-A', 5000);

    expect(ok).toBe(false);
    expect(incrementCounter).toHaveBeenCalledWith(
      'redis_lock_extend_failed_total',
      { reason: 'not_held' }
    );
  });

  test('(c) ttlMs=0 returns false + emits invalid_ttl + never calls eval (PEXPIRE 0 = DELETE footgun)', async () => {
    const client = buildMockClient();
    installMockClient(client);

    const ok = await redisService.extendLock('truck:42', 'holder-A', 0);

    expect(ok).toBe(false);
    expect(client.eval).not.toHaveBeenCalled();
    expect(incrementCounter).toHaveBeenCalledWith(
      'redis_lock_extend_failed_total',
      { reason: 'invalid_ttl' }
    );
  });

  test('(c.neg) negative ttlMs returns false + invalid_ttl', async () => {
    const client = buildMockClient();
    installMockClient(client);

    const ok = await redisService.extendLock('truck:42', 'holder-A', -100);

    expect(ok).toBe(false);
    expect(client.eval).not.toHaveBeenCalled();
    expect(incrementCounter).toHaveBeenCalledWith(
      'redis_lock_extend_failed_total',
      { reason: 'invalid_ttl' }
    );
  });

  test('(d) ttlMs=NaN returns false + emits invalid_ttl', async () => {
    const client = buildMockClient();
    installMockClient(client);

    const ok = await redisService.extendLock('truck:42', 'holder-A', Number.NaN);

    expect(ok).toBe(false);
    expect(client.eval).not.toHaveBeenCalled();
    expect(incrementCounter).toHaveBeenCalledWith(
      'redis_lock_extend_failed_total',
      { reason: 'invalid_ttl' }
    );
  });

  test('(d.inf) ttlMs=Infinity returns false + emits invalid_ttl (Number.isFinite bonus coverage)', async () => {
    const client = buildMockClient();
    installMockClient(client);

    const ok = await redisService.extendLock('truck:42', 'holder-A', Number.POSITIVE_INFINITY);

    expect(ok).toBe(false);
    expect(incrementCounter).toHaveBeenCalledWith(
      'redis_lock_extend_failed_total',
      { reason: 'invalid_ttl' }
    );
  });

  test('(b.null) Lua eval returns null + in-memory fallback holder matches → returns true via expire', async () => {
    const client = buildMockClient();
    client.eval.mockResolvedValueOnce(null);
    client.get.mockResolvedValueOnce('holder-A');
    installMockClient(client);

    const ok = await redisService.extendLock('truck:42', 'holder-A', 5000);

    expect(ok).toBe(true);
    expect(client.expire).toHaveBeenCalledWith('lock:truck:42', 5); // ceil(5000/1000)
  });

  test('(b.null-mismatch) Lua eval null + in-memory fallback holder mismatch → returns false + fallback_not_held', async () => {
    const client = buildMockClient();
    client.eval.mockResolvedValueOnce(null);
    client.get.mockResolvedValueOnce('holder-OTHER');
    installMockClient(client);

    const ok = await redisService.extendLock('truck:42', 'holder-A', 5000);

    expect(ok).toBe(false);
    expect(incrementCounter).toHaveBeenCalledWith(
      'redis_lock_extend_failed_total',
      { reason: 'fallback_not_held' }
    );
  });

  test('(prefix) double-prefix lock key emits redis_double_prefix_lock_hits_total', async () => {
    const client = buildMockClient();
    client.eval.mockResolvedValueOnce(1 as LuaResult);
    installMockClient(client);

    await redisService.extendLock('lock:truck:42', 'holder-A', 5000);

    expect(incrementCounter).toHaveBeenCalledWith(
      'redis_double_prefix_lock_hits_total',
      { method: 'extendLock' }
    );
    // Key was normalized — eval still receives `lock:truck:42` (single prefix).
    expect(client.eval.mock.calls[0][1]).toEqual(['lock:truck:42']);
  });
});

// ---------------------------------------------------------------------------
// withWatchdog tests
// ---------------------------------------------------------------------------

describe('redisService.withWatchdog', () => {
  test('(e) auto-renews lock during long critical section (extendLock fires multiple times)', async () => {
    const client = buildMockClient();
    // acquireLock → Lua eval returns 1.
    // Subsequent extendLock invocations → Lua eval returns 1 each time.
    client.eval.mockResolvedValue(1 as LuaResult);
    installMockClient(client);

    jest.useFakeTimers();

    // ttlSeconds=2 ⇒ ttlMs=2000 ⇒ renewMs = max(1000, floor(2000/3)) = 1000.
    // We run fn for ~5s of fake time → expect ≥4 renewals during the run.
    const fnStarted: { count: number } = { count: 0 };
    let resolveFn!: () => void;
    const fnDone = new Promise<void>((r) => (resolveFn = r));
    const watchdogPromise = redisService.withWatchdog<string>(
      'orphan-recovery',
      'worker-1',
      2,
      async () => {
        fnStarted.count++;
        await fnDone;
        return 'ok';
      }
    );

    // Yield so withWatchdog's `await this.acquireLock(...)` resolves and the
    // interval is registered. Fix #3 added the `weeloAcquireLockOrFallback`
    // wrapper layer, which inserts one additional `await` between the test and
    // acquireLockOnce's mock client.eval — drain four microtask flushes.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fnStarted.count).toBe(1);

    // Advance 5 seconds of fake time so the renewer fires ~5 times (every 1000ms).
    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(1000);
      // Drain microtasks queued by the renewer's async callback.
      await Promise.resolve();
      await Promise.resolve();
    }

    resolveFn();
    jest.useRealTimers();
    const result = await watchdogPromise;

    expect(result).toEqual({ acquired: true, result: 'ok' });

    // Count PEXPIRE-script invocations (renewals), excluding the initial acquireLock script.
    const pexpireCalls = client.eval.mock.calls.filter((c) => /pexpire/.test(c[0]));
    expect(pexpireCalls.length).toBeGreaterThanOrEqual(4);
    // All renewals targeted the prefixed key with correct holder + ttlMs.
    for (const call of pexpireCalls) {
      expect(call[1]).toEqual(['lock:orphan-recovery']);
      expect(call[2]).toEqual(['worker-1', '2000']);
    }
  });

  test('(f) cleanup on fn success: interval cleared, releaseLock called once', async () => {
    const client = buildMockClient();
    client.eval.mockResolvedValue(1 as LuaResult);
    installMockClient(client);

    const clearSpy = jest.spyOn(global, 'clearInterval');

    const result = await redisService.withWatchdog('hot-key', 'h1', 30, async () => 42);
    expect(result).toEqual({ acquired: true, result: 42 });

    // Last Lua eval is the releaseLock DEL script (CAS-then-del shape).
    const releaseCall = client.eval.mock.calls.find((c) => /\bdel\b/.test(c[0]));
    expect(releaseCall).toBeDefined();

    // clearInterval was called at least once for our renewer.
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  test('(g) cleanup on fn throw: interval cleared, releaseLock called, error rethrown', async () => {
    const client = buildMockClient();
    client.eval.mockResolvedValue(1 as LuaResult);
    installMockClient(client);

    const clearSpy = jest.spyOn(global, 'clearInterval');
    const boom = new Error('boom');

    await expect(
      redisService.withWatchdog('hot-key', 'h1', 30, async () => {
        throw boom;
      })
    ).rejects.toBe(boom);

    // Release still called even on throw.
    const releaseCall = client.eval.mock.calls.find((c) => /\bdel\b/.test(c[0]));
    expect(releaseCall).toBeDefined();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  test('(g.acq-fail) acquireLock rejection → withWatchdog returns {acquired:false} without running fn', async () => {
    const client = buildMockClient();
    // First eval (acquireLock) returns 0 → not acquired. No renewer should fire.
    client.eval.mockResolvedValueOnce(0 as LuaResult);
    installMockClient(client);

    const fn = jest.fn().mockResolvedValue('should-never-run');
    const result = await redisService.withWatchdog('hot-key', 'h1', 30, fn);

    expect(result).toEqual({ acquired: false });
    expect(fn).not.toHaveBeenCalled();
  });

  test('(g.lost) renewer that fails to extend emits redis_lock_watchdog_lost_total with prefix label', async () => {
    const client = buildMockClient();
    // acquireLock → 1 (success); first extendLock call → 0 (peer takeover).
    // For releaseLock at finally{} we also need a deterministic return — re-arm 0
    // after the renewal so the DEL Lua eval just returns 0 (not-held).
    client.eval.mockResolvedValueOnce(1 as LuaResult); // acquire
    client.eval.mockResolvedValue(0 as LuaResult); // renewals + release: peer-held
    installMockClient(client);

    jest.useFakeTimers();
    let resolveFn!: () => void;
    const fnDone = new Promise<void>((r) => (resolveFn = r));
    const watchdogPromise = redisService.withWatchdog(
      'truck:1234',
      'holder-A',
      2,
      async () => {
        await fnDone;
        return 'done';
      }
    );

    // Drain microtasks so acquireLock resolves and the renewer interval registers.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Fire the renewer at least twice and drain microtasks between ticks. The
    // renewer is an async callback whose body chains 4 microtask hops:
    //   setInterval → await extendLock → await client.eval → numeric branch →
    //   return false → renewer if(!extended) → metric increment.
    // A single advance+await pair is not enough; loop drives the chain to completion.
    for (let tick = 0; tick < 2; tick++) {
      jest.advanceTimersByTime(1100);
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }

    resolveFn();
    jest.useRealTimers();
    await watchdogPromise;

    // Watchdog-lost counter incremented with stripped prefix label.
    expect(incrementCounter).toHaveBeenCalledWith(
      'redis_lock_watchdog_lost_total',
      { prefix: 'truck' }
    );
  });
});
