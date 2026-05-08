/**
 * =============================================================================
 * FIX #21 — setTimerIfAbsent atomic claim (closes hasTimer→setTimer TOCTOU)
 * =============================================================================
 * Aether: setTimerIfAbsent helper — single 2-key Lua (SET NX + ZADD + cap+DLQ)
 * Cinder: order-broadcast.service.ts:1215 → wired to setTimerIfAbsent
 *
 * UNIQUE module-level mock var prefix: mockEval_21, etc.
 * =============================================================================
 */

const mockEval_21 = jest.fn();
const mockGet_21 = jest.fn();
const mockExists_21 = jest.fn();
const mockSet_21 = jest.fn();
const mockDel_21 = jest.fn();

jest.mock('../shared/services/logger.service', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockIncrementCounter_21 = jest.fn();
jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: (...a: any[]) => mockIncrementCounter_21(...a),
    recordHistogram: jest.fn(),
    observeHistogram: jest.fn(),
    setGauge: jest.fn(),
  },
}));

describe('Fix #21 — setTimerIfAbsent atomic claim', () => {
  const ORIG_ENV = { ...process.env };
  beforeEach(() => {
    mockEval_21.mockReset();
    mockGet_21.mockReset();
    mockExists_21.mockReset();
    mockSet_21.mockReset();
    mockDel_21.mockReset();
    mockIncrementCounter_21.mockReset();
    process.env.FF_TIMER_LEGACY_ZSET_ENABLED = 'false';
  });
  afterEach(() => { process.env = { ...ORIG_ENV }; });

  function loadService() {
    let svc: any;
    jest.isolateModules(() => {
      const real = require('../shared/services/redis.service');
      svc = real.redisService;
      (svc as any).client = {
        eval: (...a: any[]) => mockEval_21(...a),
        get: (...a: any[]) => mockGet_21(...a),
        exists: (...a: any[]) => mockExists_21(...a),
        set: (...a: any[]) => mockSet_21(...a),
        del: (...a: any[]) => mockDel_21(...a),
        sAdd: jest.fn(),
        sRem: jest.fn(),
      };
    });
    return svc;
  }

  // ---------------------------------------------------------------------------
  // A. Atomic 2-key Lua contract (KEYS[1]=timerKey, KEYS[2]=shardZset, KEYS[3]=dlqZset)
  // ---------------------------------------------------------------------------
  describe('Lua script contract', () => {
    test('first caller wins → returns true', async () => {
      mockEval_21.mockResolvedValueOnce(1);  // SET NX succeeded
      const svc = loadService();

      const claimed = await svc.setTimerIfAbsent(
        'timer:order-broadcast-step:abc',
        { stepIndex: 0 },
        new Date(Date.now() + 60_000)
      );

      expect(claimed).toBe(true);
    });

    test('second caller loses → returns false (TOCTOU closed)', async () => {
      mockEval_21.mockResolvedValueOnce(0);  // SET NX failed (key exists)
      const svc = loadService();

      const claimed = await svc.setTimerIfAbsent(
        'timer:order-broadcast-step:abc',
        { stepIndex: 0 },
        new Date(Date.now() + 60_000)
      );

      expect(claimed).toBe(false);
    });

    test('passes [timerKey, shardZset, dlqZset] as KEYS in correct order', async () => {
      mockEval_21.mockResolvedValueOnce(1);
      const svc = loadService();

      await svc.setTimerIfAbsent(
        'timer:order-broadcast-step:foo',
        {},
        new Date(Date.now() + 60_000)
      );

      const luaCall = mockEval_21.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].includes("'SET'") && c[0].includes("'NX'")
      );
      expect(luaCall).toBeDefined();
      const keys = luaCall![1];
      expect(keys[0]).toBe('timer:order-broadcast-step:foo');
      expect(keys[1]).toBe('timers:pending:{order-broadcast-step}');
      expect(keys[2]).toBe('dlq:timers:evicted:{order-broadcast-step}');
    });

    test('Lua script contains overflow→DLQ branch with EXPIRE on KEYS[3]', async () => {
      mockEval_21.mockResolvedValueOnce(1);
      const svc = loadService();

      await svc.setTimerIfAbsent('timer:radius:abc', {}, new Date(Date.now() + 60_000));

      const luaCall = mockEval_21.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].includes("'SET'") && c[0].includes("'NX'")
      );
      const script: string = luaCall![0];
      expect(script).toMatch(/ZADD['"]?,\s*KEYS\[2\]/);
      expect(script).toMatch(/ZCARD['"]?,\s*KEYS\[2\]/);
      expect(script).toMatch(/ZADD['"]?,\s*KEYS\[3\]/);
      expect(script).toMatch(/EXPIRE['"]?,\s*KEYS\[3\]/);
    });

    test('emits timer_shard_set_total ONLY when claim succeeds', async () => {
      mockEval_21.mockResolvedValueOnce(0);  // claim failed
      const svc = loadService();

      await svc.setTimerIfAbsent('timer:order-expiry:abc', {}, new Date(Date.now() + 60_000));

      const setCounter = mockIncrementCounter_21.mock.calls.find(c => c[0] === 'timer_shard_set_total');
      expect(setCounter).toBeUndefined();
    });

    test('emits timer_shard_set_total when claim wins', async () => {
      mockEval_21.mockResolvedValueOnce(1);  // claim won
      const svc = loadService();

      await svc.setTimerIfAbsent('timer:order-expiry:abc', {}, new Date(Date.now() + 60_000));

      const setCounter = mockIncrementCounter_21.mock.calls.find(c => c[0] === 'timer_shard_set_total');
      expect(setCounter).toBeDefined();
      expect(setCounter![1]).toEqual({ prefix: 'order-expiry' });
    });
  });

  // ---------------------------------------------------------------------------
  // B. Race scenario — two pods racing the same step boundary
  // ---------------------------------------------------------------------------
  describe('Race scenario — two pods, same timer key', () => {
    test('exactly ONE caller observes claimed=true', async () => {
      // Pod A wins, pod B loses
      mockEval_21.mockResolvedValueOnce(1);
      mockEval_21.mockResolvedValueOnce(0);
      const svc = loadService();

      const expiresAt = new Date(Date.now() + 60_000);
      const [a, b] = await Promise.all([
        svc.setTimerIfAbsent('timer:order-broadcast-step:race', {}, expiresAt),
        svc.setTimerIfAbsent('timer:order-broadcast-step:race', {}, expiresAt),
      ]);

      expect([a, b].filter(x => x === true)).toHaveLength(1);
      expect([a, b].filter(x => x === false)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // C. Lua-failure fallback — non-atomic exists-then-set
  // ---------------------------------------------------------------------------
  describe('Fallback when Lua eval throws (in-memory client)', () => {
    test('falls back to exists() then setTimer() when Lua throws', async () => {
      mockEval_21.mockRejectedValueOnce(new Error('eval not supported'));
      // Subsequent calls (setTimer's own Lua) succeed
      mockEval_21.mockResolvedValue([]);
      mockExists_21.mockResolvedValueOnce(false);
      mockSet_21.mockResolvedValue('OK');

      const svc = loadService();

      const claimed = await svc.setTimerIfAbsent(
        'timer:booking:fallback',
        {},
        new Date(Date.now() + 60_000)
      );

      expect(mockExists_21).toHaveBeenCalledWith('timer:booking:fallback');
      expect(claimed).toBe(true);
    });

    test('fallback returns false if key already exists', async () => {
      mockEval_21.mockRejectedValueOnce(new Error('eval not supported'));
      mockExists_21.mockResolvedValueOnce(true);

      const svc = loadService();

      const claimed = await svc.setTimerIfAbsent(
        'timer:booking:exists',
        {},
        new Date(Date.now() + 60_000)
      );

      expect(claimed).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // D. Cinder's call-site source contract
  // ---------------------------------------------------------------------------
  describe('Cinder — order-broadcast.service.ts:1215 wired to setTimerIfAbsent', () => {
    const fs = require('fs');
    const path = require('path');
    const SRC_PATH = path.resolve(
      __dirname, '..', 'modules', 'order', 'order-broadcast.service.ts'
    );

    let src = '';
    beforeAll(() => {
      src = fs.readFileSync(SRC_PATH, 'utf8');
    });

    test('uses redisService.setTimerIfAbsent in scheduleNextProgressiveStep', () => {
      expect(src).toMatch(/redisService\.setTimerIfAbsent/);
    });

    test('does NOT use the legacy hasTimer→setTimer pattern', () => {
      // Old TOCTOU pattern: the call site at scheduleNextProgressiveStep must
      // not have a `hasTimer(...)` followed by an `if (!exists) setTimer(...)`.
      // We assert via word-boundary that hasTimer is gone from this function.
      // Find scheduleNextProgressiveStep block
      const match = src.match(/export\s+async\s+function\s+scheduleNextProgressiveStep[\s\S]*?\n\}/);
      expect(match).toBeTruthy();
      const fnBody = match![0];
      expect(fnBody).not.toMatch(/hasTimer/);
    });

    test('checks claimed result and short-circuits on false', () => {
      const match = src.match(/export\s+async\s+function\s+scheduleNextProgressiveStep[\s\S]*?\n\}/);
      const fnBody = match![0];
      expect(fnBody).toMatch(/claimed/);
      expect(fnBody).toMatch(/if\s*\(\s*!claimed\s*\)/);
    });
  });
});

export {};
