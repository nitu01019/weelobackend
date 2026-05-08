/**
 * =============================================================================
 * FIX #36 — TIMER ZSET EVICTION → PER-PREFIX DLQ + 7-DAY EXPIRE
 * =============================================================================
 * Aether: setTimer Lua now redirects overflow members to
 *         dlq:timers:evicted:{<prefix>} with EXPIRE in same atomic script
 * Zephyr: scripts/replay-timer-evictions.ts drainer (7-prefix loop)
 *
 * UNIQUE module-level mock var prefix: mockEval_36, mockGet_36, etc.
 * =============================================================================
 */

const mockEval_36 = jest.fn();
const mockGet_36 = jest.fn();
const mockDel_36 = jest.fn();
const mockSAdd_36 = jest.fn();
const mockExpire_36 = jest.fn();

jest.mock('../shared/services/logger.service', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockIncrementCounter_36 = jest.fn();
jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: (...a: any[]) => mockIncrementCounter_36(...a),
    recordHistogram: jest.fn(),
    observeHistogram: jest.fn(),
    setGauge: jest.fn(),
  },
}));

describe('Fix #36 — Timer eviction redirected to per-prefix DLQ ZSET with 7-day EXPIRE', () => {
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    mockEval_36.mockReset();
    mockGet_36.mockReset();
    mockDel_36.mockReset();
    mockSAdd_36.mockReset();
    mockExpire_36.mockReset();
    mockIncrementCounter_36.mockReset();
    process.env.FF_TIMER_LEGACY_ZSET_ENABLED = 'false';
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  function loadService() {
    let svc: any;
    jest.isolateModules(() => {
      const real = require('../shared/services/redis.service');
      svc = real.redisService;
      (svc as any).client = {
        eval: (...a: any[]) => mockEval_36(...a),
        get: (...a: any[]) => mockGet_36(...a),
        del: (...a: any[]) => mockDel_36(...a),
        sAdd: (...a: any[]) => mockSAdd_36(...a),
        set: jest.fn().mockResolvedValue('OK'),
        expire: (...a: any[]) => mockExpire_36(...a),
      };
    });
    return svc;
  }

  // ---------------------------------------------------------------------------
  // A. setTimer eviction Lua — KEYS[2] is the per-prefix DLQ ZSET
  // ---------------------------------------------------------------------------
  describe('setTimer eviction → DLQ', () => {
    test('passes per-prefix DLQ ZSET as KEYS[2] (cluster-safe hash tag)', async () => {
      mockEval_36.mockResolvedValue([]);  // empty evicted array
      const svc = loadService();

      await svc.setTimer('timer:order-broadcast-step:abc', { v: 1 }, new Date(Date.now() + 60_000));

      const zaddCall = mockEval_36.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].includes('ZADD') && c[0].includes('ZCARD')
      );
      expect(zaddCall).toBeDefined();
      const keys = zaddCall![1];
      // KEYS[1] = shard zset, KEYS[2] = dlq zset
      expect(keys[0]).toBe('timers:pending:{order-broadcast-step}');
      expect(keys[1]).toBe('dlq:timers:evicted:{order-broadcast-step}');
    });

    test('eviction Lua contains EXPIRE on KEYS[2] (DLQ 7-day TTL)', async () => {
      mockEval_36.mockResolvedValue([]);
      const svc = loadService();

      await svc.setTimer('timer:radius:xyz', { v: 1 }, new Date(Date.now() + 60_000));

      const zaddCall = mockEval_36.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].includes('ZADD') && c[0].includes('ZCARD')
      );
      const script: string = zaddCall![0];
      expect(script).toMatch(/EXPIRE['"]?,\s*KEYS\[2\]/);
    });

    test('passes shard cap as ARGV[3] and DLQ EXPIRE seconds as ARGV[4]', async () => {
      process.env.TIMER_SHARD_MAX_LEN = '5000';
      process.env.TIMER_DLQ_EXPIRE_SECONDS = '604800';
      mockEval_36.mockResolvedValue([]);
      const svc = loadService();

      await svc.setTimer('timer:booking:xyz', { v: 1 }, new Date(Date.now() + 60_000));

      const zaddCall = mockEval_36.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].includes('ZADD') && c[0].includes('ZCARD')
      );
      const argv = zaddCall![2];
      expect(argv[2]).toBe('5000');     // shard cap
      expect(argv[3]).toBe('604800');   // DLQ 7-day expire
    });

    test('emits timer_evicted_to_dlq_total counter when Lua returns evicted members', async () => {
      // Simulate 2 evicted members: [member1, score1, member2, score2]
      mockEval_36.mockResolvedValue([
        'timer:order-expiry:OLD1', '111',
        'timer:order-expiry:OLD2', '222',
      ]);
      const svc = loadService();

      await svc.setTimer('timer:order-expiry:NEW', { v: 1 }, new Date(Date.now() + 60_000));

      const evictionCall = mockIncrementCounter_36.mock.calls.find(c => c[0] === 'timer_evicted_to_dlq_total');
      expect(evictionCall).toBeDefined();
      expect(evictionCall![1]).toEqual({ prefix: 'order-expiry' });
      expect(evictionCall![2]).toBe(2);  // 4 entries / 2 = 2 evicted
    });

    test('does NOT emit eviction counter when no overflow', async () => {
      mockEval_36.mockResolvedValue([]);  // Lua returns empty evicted array
      const svc = loadService();

      await svc.setTimer('timer:rating-reminder:abc', { v: 1 }, new Date(Date.now() + 60_000));

      const evictionCalls = mockIncrementCounter_36.mock.calls.filter(c => c[0] === 'timer_evicted_to_dlq_total');
      expect(evictionCalls).toHaveLength(0);
    });

    test('still records timer_shard_set_total on every successful ZADD', async () => {
      mockEval_36.mockResolvedValue([]);
      const svc = loadService();

      await svc.setTimer('timer:assignment-timeout:abc', { v: 1 }, new Date(Date.now() + 60_000));

      const setCall = mockIncrementCounter_36.mock.calls.find(c => c[0] === 'timer_shard_set_total');
      expect(setCall).toBeDefined();
      expect(setCall![1]).toEqual({ prefix: 'assignment-timeout' });
    });
  });

  // ---------------------------------------------------------------------------
  // B. timerDlqZset() helper
  // ---------------------------------------------------------------------------
  describe('timerDlqZset() helper', () => {
    test('wraps prefix tag in hash-tag braces for cluster slot pinning', () => {
      jest.isolateModules(() => {
        const { timerDlqZset } = require('../shared/services/redis.service');
        expect(timerDlqZset('order-expiry')).toBe('dlq:timers:evicted:{order-expiry}');
        expect(timerDlqZset('booking-order')).toBe('dlq:timers:evicted:{booking-order}');
      });
    });
  });

  // ---------------------------------------------------------------------------
  // C. Zephyr's drainer — source contract
  // ---------------------------------------------------------------------------
  describe('Zephyr scripts/replay-timer-evictions.ts — source contract', () => {
    const fs = require('fs');
    const path = require('path');
    const SCRIPT_PATH = path.resolve(__dirname, '..', '..', 'scripts', 'replay-timer-evictions.ts');

    let src = '';
    beforeAll(() => {
      src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    });

    test('lists all 7 timer prefix tags', () => {
      expect(src).toMatch(/'order-expiry'/);
      expect(src).toMatch(/'order-broadcast-step'/);
      expect(src).toMatch(/'assignment-timeout'/);
      expect(src).toMatch(/'booking-order'/);
      expect(src).toMatch(/'booking'/);
      expect(src).toMatch(/'radius'/);
      expect(src).toMatch(/'rating-reminder'/);
    });

    test('uses distinct lock namespace from broadcast drainer', () => {
      expect(src).toMatch(/timer-evictions:drainer:lock/);
      // Sanity — must NOT reuse the broadcast drainer's lock key
      expect(src).not.toMatch(/['"]dlq:drainer:lock['"]/);
    });

    test('emits timer_dlq_drained_total counter with per-outcome label', () => {
      expect(src).toMatch(/timer_dlq_drained_total/);
      expect(src).toMatch(/outcome/);
      expect(src).toMatch(/requeued/);
      expect(src).toMatch(/discarded/);
      expect(src).toMatch(/requeue_failed/);
    });

    test('exports drain() and startDaemon() entry points', () => {
      expect(src).toMatch(/export\s+(async\s+)?function\s+drain\b/);
      expect(src).toMatch(/export\s+function\s+startDaemon\b/);
    });

    test('ZREM is per-member (atomic) — no bulk ZREMRANGEBYSCORE call', () => {
      // Required by Zephyr's contract: ZREM after each terminal outcome,
      // not bulk ZREMRANGEBYSCORE which would race the score window.
      // Strip comments so a doc-string mention of ZREMRANGEBYSCORE doesn't fail us.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')   // strip block comments
        .replace(/\/\/.*$/gm, '');           // strip line comments
      expect(code).toMatch(/ZREM/);
      expect(code).not.toMatch(/ZREMRANGEBYSCORE/);
    });
  });

  // ---------------------------------------------------------------------------
  // D. Server boot wiring (Zephyr's server.ts hook)
  // ---------------------------------------------------------------------------
  describe('server.ts boot wiring', () => {
    const fs = require('fs');
    const path = require('path');
    const SERVER_PATH = path.resolve(__dirname, '..', 'server.ts');

    test('imports timer DLQ drainer and registers periodic drain', () => {
      const src = fs.readFileSync(SERVER_PATH, 'utf8');
      expect(src).toMatch(/replay-timer-evictions/);
      // Zephyr's wiring uses setInterval(drain) not startDaemon — both are valid
      expect(src).toMatch(/drain[A-Za-z]*\s*\(/);
      expect(src).toMatch(/FF_TIMER_DLQ_DRAINER_ENABLED/);
    });
  });
});

export {};
