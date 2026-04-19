/**
 * F-A-37 — Geocoding rate-limit Redis SSOT
 *
 * RED intent:
 *   Two in-process "ECS task" instances share a single Redis. 400 total hits
 *   (200 per task) from one IP.
 *   - Under the old in-memory Map (flag OFF), each task's Map runs
 *     independently → both reach 200 with no deny. The global deny count is 0
 *     and budget is effectively doubled.
 *   - Under FF_GEOCODE_RATELIMIT_REDIS=true, calls cap at `limit` across the
 *     shared Redis. The 201st aggregate call denies.
 *
 * These tests do NOT boot Express — they exercise the `rate-limit.service` and
 * a minimal in-test shim for the legacy Map path to prove the bug.
 */

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    observeHistogram: jest.fn(),
  },
}));

// Minimal simulated Redis — supports the exact Lua semantics used by the
// rate-limit service (INCRBY + EXPIRE + cap check). Shared state across both
// "task" instances, just like production ElastiCache.
function createSharedRedis() {
  const store = new Map<string, { value: number; expiresAt: number }>();
  const now = () => Date.now();

  function gc() {
    const t = now();
    for (const [k, v] of store.entries()) {
      if (v.expiresAt <= t) store.delete(k);
    }
  }

  return {
    store,
    eval: jest.fn(async (_script: string, keys: string[], args: string[]) => {
      gc();
      const key = keys[0];
      const cost = parseInt(args[0] ?? '1', 10);
      const limit = parseInt(args[1] ?? '0', 10);
      const ttlSec = parseInt(args[2] ?? '60', 10);

      const entry = store.get(key);
      const current = entry ? entry.value : 0;
      if (current + cost > limit) {
        return -1;
      }
      const next = current + cost;
      store.set(key, {
        value: next,
        expiresAt: entry ? entry.expiresAt : now() + ttlSec * 1000,
      });
      return next;
    }),
  };
}

describe('F-A-37 geocoding rate-limit SSOT', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.FF_GEOCODE_RATELIMIT_REDIS = 'false';
  });

  afterEach(() => {
    delete process.env.FF_GEOCODE_RATELIMIT_REDIS;
  });

  /**
   * Legacy path — simulates two ECS tasks each with their own Map-backed
   * counter. Doubled budget is the bug F-A-37 fixes.
   */
  it('RED (legacy Map): two task instances each hit limit=200 independently → total 400 allowed', () => {
    type IpBudget = { search: number; date: string };

    function makeLegacyTask() {
      const ipBudgetMap = new Map<string, IpBudget>();
      const LIMIT = 200;
      return function checkIpBudget(ip: string): boolean {
        const today = new Date().toDateString();
        let b = ipBudgetMap.get(ip);
        if (!b || b.date !== today) {
          b = { search: 0, date: today };
          ipBudgetMap.set(ip, b);
        }
        if (b.search >= LIMIT) return false;
        b.search++;
        return true;
      };
    }

    const task1 = makeLegacyTask();
    const task2 = makeLegacyTask();

    let allowed = 0;
    let denied = 0;
    for (let i = 0; i < 200; i++) {
      if (task1('1.2.3.4')) allowed++;
      else denied++;
    }
    for (let i = 0; i < 200; i++) {
      if (task2('1.2.3.4')) allowed++;
      else denied++;
    }

    // Buggy behavior: both tasks happily approve 200 hits each.
    expect(allowed).toBe(400);
    expect(denied).toBe(0);
  });

  /**
   * GREEN path — both task instances share one Redis. The 201st aggregate
   * call from a single IP must deny.
   */
  it('GREEN (Redis): two task instances sharing one Redis deny the 201st aggregate hit', async () => {
    process.env.FF_GEOCODE_RATELIMIT_REDIS = 'true';

    const sharedRedis = createSharedRedis();

    // Inject shared redis into a fresh module instance for "task 1".
    jest.doMock('../shared/services/redis.service', () => ({
      redisService: { eval: sharedRedis.eval, getRawClient: () => null },
    }));
    const task1 = require('../shared/services/rate-limit.service');

    jest.resetModules();
    // Second require returns a NEW module instance (separate script-cache state,
    // fresh singletons, fresh "process") — but still points at sharedRedis.
    jest.doMock('../shared/services/redis.service', () => ({
      redisService: { eval: sharedRedis.eval, getRawClient: () => null },
    }));
    const task2 = require('../shared/services/rate-limit.service');

    expect(task1).not.toBe(task2); // truly distinct module instances

    const endpoint = 'geocode:search';
    const ip = '1.2.3.4';
    const limit = 200;
    const windowSec = 86400;

    let allowed = 0;
    let denied = 0;

    // Alternate hits across tasks.
    for (let i = 0; i < 200; i++) {
      const r = await task1.checkAndIncrementIpBudget({
        endpoint,
        ip,
        costUnits: 1,
        windowSec,
        limit,
      });
      if (r.allowed) allowed++;
      else denied++;
    }
    for (let i = 0; i < 5; i++) {
      const r = await task2.checkAndIncrementIpBudget({
        endpoint,
        ip,
        costUnits: 1,
        windowSec,
        limit,
      });
      if (r.allowed) allowed++;
      else denied++;
    }

    // Shared Redis caps the IP globally at 200.
    expect(allowed).toBe(200);
    expect(denied).toBe(5);
  });

  it('fail-open on Redis error — returns allowed + fallopen metric', async () => {
    process.env.FF_GEOCODE_RATELIMIT_REDIS = 'true';

    const metricsMod = require('../shared/monitoring/metrics.service');
    (metricsMod.metrics.incrementCounter as jest.Mock).mockClear();

    jest.doMock('../shared/services/redis.service', () => ({
      redisService: {
        eval: jest.fn(async () => {
          throw new Error('NOSCRIPT backend down');
        }),
        getRawClient: () => null,
      },
    }));

    const svc = require('../shared/services/rate-limit.service');
    const r = await svc.checkAndIncrementIpBudget({
      endpoint: 'geocode:search',
      ip: '1.2.3.4',
      costUnits: 1,
      windowSec: 86400,
      limit: 200,
    });
    expect(r.allowed).toBe(true);
    expect(r.fallopen).toBe(true);

    const calls = (metricsMod.metrics.incrementCounter as jest.Mock).mock.calls;
    const fallopenCalled = calls.some(
      (c: any[]) => c[0] === 'geocode_ratelimit_fallopen_total',
    );
    expect(fallopenCalled).toBe(true);
  });

  it('increments allowed/denied counters with endpoint label', async () => {
    process.env.FF_GEOCODE_RATELIMIT_REDIS = 'true';

    const metricsMod = require('../shared/monitoring/metrics.service');
    (metricsMod.metrics.incrementCounter as jest.Mock).mockClear();

    const sharedRedis = createSharedRedis();
    jest.doMock('../shared/services/redis.service', () => ({
      redisService: { eval: sharedRedis.eval, getRawClient: () => null },
    }));

    const svc = require('../shared/services/rate-limit.service');
    const first = await svc.checkAndIncrementIpBudget({
      endpoint: 'geocode:search',
      ip: '9.9.9.9',
      costUnits: 1,
      windowSec: 60,
      limit: 1,
    });
    const second = await svc.checkAndIncrementIpBudget({
      endpoint: 'geocode:search',
      ip: '9.9.9.9',
      costUnits: 1,
      windowSec: 60,
      limit: 1,
    });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);

    const calls = (metricsMod.metrics.incrementCounter as jest.Mock).mock.calls;
    const names = calls.map((c: any[]) => c[0]);
    expect(names).toContain('geocode_ratelimit_allowed_total');
    expect(names).toContain('geocode_ratelimit_denied_total');
  });

  it('null/undefined result from eval → fail-open', async () => {
    process.env.FF_GEOCODE_RATELIMIT_REDIS = 'true';

    const metricsMod = require('../shared/monitoring/metrics.service');
    (metricsMod.metrics.incrementCounter as jest.Mock).mockClear();

    jest.doMock('../shared/services/redis.service', () => ({
      redisService: {
        eval: jest.fn(async () => null), // in-memory fallback returns null
        getRawClient: () => null,
      },
    }));

    const svc = require('../shared/services/rate-limit.service');
    const r = await svc.checkAndIncrementIpBudget({
      endpoint: 'geocode:search',
      ip: '2.2.2.2',
      costUnits: 1,
      windowSec: 60,
      limit: 5,
    });
    expect(r.allowed).toBe(true);
    expect(r.fallopen).toBe(true);

    const names = (metricsMod.metrics.incrementCounter as jest.Mock).mock.calls.map(
      (c: any[]) => c[0],
    );
    expect(names).toContain('geocode_ratelimit_fallopen_total');
  });

  it('EVALSHA happy path — uses cached SHA and skips plain EVAL', async () => {
    process.env.FF_GEOCODE_RATELIMIT_REDIS = 'true';

    const scriptLoad = jest.fn(async () => 'abc123sha');
    const evalsha = jest.fn(async () => 7);
    const plainEval = jest.fn(async () => {
      throw new Error('plain eval should not be called when EVALSHA works');
    });

    jest.doMock('../shared/services/redis.service', () => ({
      redisService: {
        eval: plainEval,
        getRawClient: () => ({
          evalsha,
          script: scriptLoad,
        }),
      },
    }));

    const svc = require('../shared/services/rate-limit.service');
    const r1 = await svc.checkAndIncrementIpBudget({
      endpoint: 'geocode:search',
      ip: '3.3.3.3',
      costUnits: 1,
      windowSec: 60,
      limit: 10,
    });
    const r2 = await svc.checkAndIncrementIpBudget({
      endpoint: 'geocode:search',
      ip: '3.3.3.3',
      costUnits: 1,
      windowSec: 60,
      limit: 10,
    });

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    // SCRIPT LOAD runs once, EVALSHA runs twice.
    expect(scriptLoad).toHaveBeenCalledTimes(1);
    expect(evalsha).toHaveBeenCalledTimes(2);
    expect(plainEval).not.toHaveBeenCalled();
  });

  it('EVALSHA NOSCRIPT fallback — reloads + retries via plain EVAL', async () => {
    process.env.FF_GEOCODE_RATELIMIT_REDIS = 'true';

    const scriptLoad = jest.fn(async () => 'abc123sha');
    const evalsha = jest.fn(async () => {
      const err = new Error('NOSCRIPT No matching script. Please use EVAL.');
      throw err;
    });
    const plainEval = jest.fn(async () => 1);

    jest.doMock('../shared/services/redis.service', () => ({
      redisService: {
        eval: plainEval,
        getRawClient: () => ({ evalsha, script: scriptLoad }),
      },
    }));

    const svc = require('../shared/services/rate-limit.service');
    const r = await svc.checkAndIncrementIpBudget({
      endpoint: 'geocode:search',
      ip: '4.4.4.4',
      costUnits: 1,
      windowSec: 60,
      limit: 10,
    });
    expect(r.allowed).toBe(true);
    expect(evalsha).toHaveBeenCalledTimes(1);
    expect(plainEval).toHaveBeenCalledTimes(1);
  });

  it('EVALSHA non-NOSCRIPT error bubbles → service fails open', async () => {
    process.env.FF_GEOCODE_RATELIMIT_REDIS = 'true';

    const scriptLoad = jest.fn(async () => 'abc123sha');
    const evalsha = jest.fn(async () => {
      throw new Error('READONLY You can not write against a read only replica.');
    });
    const plainEval = jest.fn(async () => {
      throw new Error('plain eval too');
    });

    jest.doMock('../shared/services/redis.service', () => ({
      redisService: {
        eval: plainEval,
        getRawClient: () => ({ evalsha, script: scriptLoad }),
      },
    }));

    const svc = require('../shared/services/rate-limit.service');
    const r = await svc.checkAndIncrementIpBudget({
      endpoint: 'geocode:search',
      ip: '5.5.5.5',
      costUnits: 1,
      windowSec: 60,
      limit: 10,
    });
    // Any evalsha-path failure falls through to plain EVAL; when that also
    // throws we return fail-open for safety.
    expect(r.allowed).toBe(true);
    expect(r.fallopen).toBe(true);
  });

  it('SCRIPT LOAD failure → falls back to plain EVAL', async () => {
    process.env.FF_GEOCODE_RATELIMIT_REDIS = 'true';

    const scriptLoad = jest.fn(async () => {
      throw new Error('boom');
    });
    const evalsha = jest.fn(async () => 999);
    const plainEval = jest.fn(async () => 3);

    jest.doMock('../shared/services/redis.service', () => ({
      redisService: {
        eval: plainEval,
        getRawClient: () => ({ evalsha, script: scriptLoad }),
      },
    }));

    const svc = require('../shared/services/rate-limit.service');
    const r = await svc.checkAndIncrementIpBudget({
      endpoint: 'geocode:search',
      ip: '6.6.6.6',
      costUnits: 1,
      windowSec: 60,
      limit: 10,
    });
    expect(r.allowed).toBe(true);
    expect(scriptLoad).toHaveBeenCalledTimes(1);
    // SCRIPT LOAD threw → cachedSha stays null → EVALSHA skipped → plain EVAL.
    expect(evalsha).not.toHaveBeenCalled();
    expect(plainEval).toHaveBeenCalledTimes(1);
  });

  it('__resetScriptCache clears cache without error', () => {
    const svc = require('../shared/services/rate-limit.service');
    expect(() => svc.__resetScriptCache()).not.toThrow();
  });

  it('exports the Lua cap-and-incr script', () => {
    const svc = require('../shared/services/rate-limit.service');
    expect(typeof svc.LUA_RATELIMIT_INCR_CAP).toBe('string');
    expect(svc.LUA_RATELIMIT_INCR_CAP).toContain('INCRBY');
    expect(svc.LUA_RATELIMIT_INCR_CAP).toContain('EXPIRE');
  });
});
