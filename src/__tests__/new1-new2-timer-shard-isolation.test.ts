/**
 * =============================================================================
 * NEW#1 + NEW#2 — TIMER SHARD ISOLATION + ORPHAN RECOVERY
 * =============================================================================
 * Aether (NEW#1): per-prefix shard ZSETs (timers:pending:{<prefix>}) — ZADD
 *                 routing in setTimer + ZRANGEBYSCORE in getExpiredTimers
 * Borealis (NEW#2): orphan-recovery scheduler scanning all 7 prefixes
 *
 * Includes T3 starvation regression test from §5.1 line 2359 — heavy traffic on
 * order-broadcast-step prefix MUST NOT block reads/writes on other prefixes.
 *
 * UNIQUE module-level mock var prefix: mockEval_new1n2, etc.
 * =============================================================================
 */

const mockEval_new1n2 = jest.fn();
const mockGet_new1n2 = jest.fn();
const mockDel_new1n2 = jest.fn();
const mockSAdd_new1n2 = jest.fn();
const mockZAdd_new1n2 = jest.fn();
const mockExpire_new1n2 = jest.fn();
const mockSet_new1n2 = jest.fn();

jest.mock('../shared/services/logger.service', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    recordHistogram: jest.fn(),
    observeHistogram: jest.fn(),
    setGauge: jest.fn(),
  },
}));

describe('NEW#1 — Per-prefix shard ZSET routing', () => {
  describe('timerShardZset() helper — prefix → shard mapping', () => {
    test.each([
      ['timer:order-expiry:abc',         'timers:pending:{order-expiry}'],
      ['timer:order-broadcast-step:abc', 'timers:pending:{order-broadcast-step}'],
      ['timer:assignment-timeout:abc',   'timers:pending:{assignment-timeout}'],
      ['timer:booking-order:abc',        'timers:pending:{booking-order}'],
      ['timer:booking:abc',              'timers:pending:{booking}'],
      ['timer:radius:abc',               'timers:pending:{radius}'],
      ['timer:rating-reminder:abc',      'timers:pending:{rating-reminder}'],
    ])('%s → %s', (timerKey, expectedShard) => {
      jest.isolateModules(() => {
        const { timerShardZset } = require('../shared/services/redis.service');
        expect(timerShardZset(timerKey)).toBe(expectedShard);
      });
    });

    test('unknown prefix routes to fallback shard', () => {
      jest.isolateModules(() => {
        const { timerShardZset } = require('../shared/services/redis.service');
        expect(timerShardZset('timer:unknown:abc')).toBe('timers:pending:{_misc}');
      });
    });
  });

  describe('timerShardPrefixTag() helper', () => {
    test.each([
      ['timer:order-expiry:abc', 'order-expiry'],
      ['timer:radius:abc',       'radius'],
      ['timer:unknown:abc',      '_misc'],
    ])('%s → %s', (timerKey, tag) => {
      jest.isolateModules(() => {
        const { timerShardPrefixTag } = require('../shared/services/redis.service');
        expect(timerShardPrefixTag(timerKey)).toBe(tag);
      });
    });
  });

  describe('timerPrefixToShardZset() — getExpiredTimers reverse lookup', () => {
    test('maps caller-supplied prefix to shard ZSET', () => {
      jest.isolateModules(() => {
        const { timerPrefixToShardZset } = require('../shared/services/redis.service');
        expect(timerPrefixToShardZset('timer:order-broadcast-step:'))
          .toBe('timers:pending:{order-broadcast-step}');
        expect(timerPrefixToShardZset('timer:rating-reminder:'))
          .toBe('timers:pending:{rating-reminder}');
      });
    });

    test('unknown prefix routes to fallback', () => {
      jest.isolateModules(() => {
        const { timerPrefixToShardZset } = require('../shared/services/redis.service');
        expect(timerPrefixToShardZset('timer:made-up:'))
          .toBe('timers:pending:{_misc}');
      });
    });
  });
});

// =============================================================================
// T3 STARVATION REGRESSION (§5.1 line 2359)
// =============================================================================
// Pre-NEW#1: a single global `timers:pending` ZSET meant ZRANGEBYSCORE LIMIT 100
// could be saturated by one busy prefix (order-broadcast-step at 300+ RPS),
// starving order-expiry / booking / etc.
// Post-NEW#1: each prefix has its own ZSET; one prefix's overflow cannot
// shadow another prefix's ready-to-fire timers.
// =============================================================================
describe('T3 STARVATION REGRESSION (§5.1) — heavy prefix MUST NOT block other prefixes', () => {
  const ORIG_ENV = { ...process.env };
  beforeEach(() => {
    mockEval_new1n2.mockReset();
    mockGet_new1n2.mockReset();
    mockDel_new1n2.mockReset();
    process.env.FF_TIMER_LEGACY_ZSET_ENABLED = 'false';
  });
  afterEach(() => { process.env = { ...ORIG_ENV }; });

  function loadService() {
    let svc: any;
    jest.isolateModules(() => {
      const real = require('../shared/services/redis.service');
      svc = real.redisService;
      (svc as any).client = {
        eval: (...a: any[]) => mockEval_new1n2(...a),
        get: (...a: any[]) => mockGet_new1n2(...a),
        del: (...a: any[]) => mockDel_new1n2(...a),
        sAdd: (...a: any[]) => mockSAdd_new1n2(...a),
        scanIterator: async function* () { /* nothing */ },
      };
    });
    return svc;
  }

  test('reads from busy prefix do not touch other prefixes shard ZSET', async () => {
    mockEval_new1n2.mockResolvedValue([]);  // busy prefix: empty (already drained)
    const svc = loadService();

    await svc.getExpiredTimers('timer:order-broadcast-step:', 100);

    const zrCalls = mockEval_new1n2.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].toLowerCase().includes('zrangebyscore')
    );
    expect(zrCalls.length).toBeGreaterThanOrEqual(1);
    // Every ZRANGEBYSCORE invocation must target ONLY the busy prefix's shard
    for (const call of zrCalls) {
      const keys = call[1];
      expect(keys[0]).toBe('timers:pending:{order-broadcast-step}');
      expect(keys[0]).not.toBe('timers:pending');  // legacy global is gone
      expect(keys[0]).not.toBe('timers:pending:{order-expiry}');
    }
  });

  test('order-expiry reads target their own shard, never global', async () => {
    mockEval_new1n2.mockResolvedValue([]);
    const svc = loadService();

    await svc.getExpiredTimers('timer:order-expiry:', 100);

    const zrCalls = mockEval_new1n2.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].toLowerCase().includes('zrangebyscore')
    );
    for (const call of zrCalls) {
      expect(call[1][0]).toBe('timers:pending:{order-expiry}');
    }
  });

  test('two prefixes concurrently use distinct shard ZSETs', async () => {
    mockEval_new1n2.mockResolvedValue([]);
    const svc = loadService();

    await Promise.all([
      svc.getExpiredTimers('timer:order-broadcast-step:', 100),
      svc.getExpiredTimers('timer:order-expiry:', 100),
      svc.getExpiredTimers('timer:assignment-timeout:', 100),
    ]);

    const zrCalls = mockEval_new1n2.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].toLowerCase().includes('zrangebyscore')
    );
    const shardKeys = new Set(zrCalls.map(c => c[1][0]));
    // Three distinct shards in a single batch — proves no shared global ZSET
    expect(shardKeys.has('timers:pending:{order-broadcast-step}')).toBe(true);
    expect(shardKeys.has('timers:pending:{order-expiry}')).toBe(true);
    expect(shardKeys.has('timers:pending:{assignment-timeout}')).toBe(true);
  });

  test('LIMIT applies INDEPENDENTLY per prefix (not globally)', async () => {
    mockEval_new1n2.mockResolvedValue([]);
    const svc = loadService();

    await Promise.all([
      svc.getExpiredTimers('timer:order-broadcast-step:', 50),
      svc.getExpiredTimers('timer:rating-reminder:', 25),
    ]);

    const zrCalls = mockEval_new1n2.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].toLowerCase().includes('zrangebyscore')
    );
    const limitsByShard: Record<string, string> = {};
    for (const call of zrCalls) {
      limitsByShard[call[1][0]] = call[2][1];
    }
    expect(limitsByShard['timers:pending:{order-broadcast-step}']).toBe('50');
    expect(limitsByShard['timers:pending:{rating-reminder}']).toBe('25');
  });
});

// =============================================================================
// NEW#2 — orphan recovery scheduler
// =============================================================================
describe('NEW#2 — Orphan recovery across all 7 prefixes', () => {
  const fs = require('fs');
  const path = require('path');
  const ORDER_TIMER_PATH = path.resolve(__dirname, '..', 'modules', 'order', 'order-timer.service.ts');
  const SERVER_PATH = path.resolve(__dirname, '..', 'server.ts');

  let src = '';
  beforeAll(() => {
    src = fs.readFileSync(ORDER_TIMER_PATH, 'utf8');
  });

  test('ALL_TIMER_PREFIXES covers all 7 timer prefix segments', () => {
    expect(src).toMatch(/ALL_TIMER_PREFIXES/);
    expect(src).toMatch(/'timer:order-broadcast-step:'/);
    expect(src).toMatch(/'timer:order-expiry:'/);
    expect(src).toMatch(/'timer:assignment-timeout:'/);
    expect(src).toMatch(/'timer:booking-order:'/);
    expect(src).toMatch(/'timer:booking:'/);
    expect(src).toMatch(/'timer:radius:'/);
    expect(src).toMatch(/'timer:rating-reminder:'/);
  });

  test('exports recoverOrphanedStepTimers and startOrphanRecovery', () => {
    expect(src).toMatch(/export\s+(async\s+)?function\s+recoverOrphanedStepTimers\b/);
    expect(src).toMatch(/export\s+function\s+startOrphanRecovery\b/);
  });

  test('startOrphanRecovery uses setInterval with .unref() for safe shutdown', () => {
    expect(src).toMatch(/setInterval/);
    expect(src).toMatch(/\.unref\(\)/);
  });

  test('startOrphanRecovery is idempotent (guards against double-start)', () => {
    // Implementation guards via `if (orphanRecoveryInterval) return;`
    expect(src).toMatch(/if\s*\(\s*orphanRecoveryInterval\s*\)\s*return/);
  });

  test('interval is configurable via TIMER_ORPHAN_RECOVERY_INTERVAL_MS env', () => {
    expect(src).toMatch(/TIMER_ORPHAN_RECOVERY_INTERVAL_MS/);
  });

  test('server.ts imports + invokes startOrphanRecovery during boot', () => {
    const server = fs.readFileSync(SERVER_PATH, 'utf8');
    expect(server).toMatch(/startOrphanRecovery/);
  });
});

export {};
