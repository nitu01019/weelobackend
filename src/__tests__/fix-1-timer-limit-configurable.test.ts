/**
 * =============================================================================
 * FIX #1 — TIMER_BATCH_LIMIT clamp + ARGV LIMIT in Lua
 * =============================================================================
 * Aether: timerBatchLimit() helper (env-clamped) + ARGV LIMIT in
 *         getExpiredTimers' ZRANGEBYSCORE Lua
 * Yarrow: 11 callers wired through timerBatchLimit() across 8 files
 *
 * UNIQUE module-level mock var prefix: mockEval_1, mockGet_1, etc. — Pearl-safe.
 * =============================================================================
 */

const mockEval_1 = jest.fn();
const mockGet_1 = jest.fn();
const mockDel_1 = jest.fn();
const mockSAdd_1 = jest.fn();

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

describe('Fix #1 — TIMER_BATCH_LIMIT configurable + ARGV LIMIT', () => {
  const ORIG_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  // ---------------------------------------------------------------------------
  // A. timerBatchLimit() helper — clamp semantics
  // ---------------------------------------------------------------------------
  describe('timerBatchLimit() helper', () => {
    test('returns env default 100 when no explicit limit and no env override', () => {
      delete process.env.TIMER_BATCH_LIMIT;
      delete process.env.TIMER_BATCH_LIMIT_MAX;
      jest.isolateModules(() => {
        const { timerBatchLimit } = require('../shared/services/redis.service');
        expect(timerBatchLimit()).toBe(100);
      });
    });

    test('honors TIMER_BATCH_LIMIT env when no explicit limit passed', () => {
      process.env.TIMER_BATCH_LIMIT = '250';
      delete process.env.TIMER_BATCH_LIMIT_MAX;
      jest.isolateModules(() => {
        const { timerBatchLimit } = require('../shared/services/redis.service');
        expect(timerBatchLimit()).toBe(250);
      });
    });

    test('explicit limit overrides env default', () => {
      process.env.TIMER_BATCH_LIMIT = '50';
      delete process.env.TIMER_BATCH_LIMIT_MAX;
      jest.isolateModules(() => {
        const { timerBatchLimit } = require('../shared/services/redis.service');
        expect(timerBatchLimit(200)).toBe(200);
      });
    });

    test('clamps explicit limit at TIMER_BATCH_LIMIT_MAX (default 500)', () => {
      delete process.env.TIMER_BATCH_LIMIT;
      delete process.env.TIMER_BATCH_LIMIT_MAX;
      jest.isolateModules(() => {
        const { timerBatchLimit } = require('../shared/services/redis.service');
        expect(timerBatchLimit(10_000)).toBe(500);
      });
    });

    test('honors custom TIMER_BATCH_LIMIT_MAX', () => {
      delete process.env.TIMER_BATCH_LIMIT;
      process.env.TIMER_BATCH_LIMIT_MAX = '1000';
      jest.isolateModules(() => {
        const { timerBatchLimit } = require('../shared/services/redis.service');
        expect(timerBatchLimit(800)).toBe(800);
        expect(timerBatchLimit(1500)).toBe(1000);
      });
    });

    test('floors zero / NaN / negative explicit limit to env default (then floor 1)', () => {
      process.env.TIMER_BATCH_LIMIT = '100';
      delete process.env.TIMER_BATCH_LIMIT_MAX;
      jest.isolateModules(() => {
        const { timerBatchLimit } = require('../shared/services/redis.service');
        expect(timerBatchLimit(0)).toBe(100);
        expect(timerBatchLimit(NaN)).toBe(100);
        expect(timerBatchLimit(-5)).toBe(100);
      });
    });

    test('absolute floor of 1 even with garbage env values', () => {
      process.env.TIMER_BATCH_LIMIT = 'not-a-number';
      process.env.TIMER_BATCH_LIMIT_MAX = 'not-a-number';
      jest.isolateModules(() => {
        const { timerBatchLimit } = require('../shared/services/redis.service');
        // Falls back to numeric defaults internally
        expect(timerBatchLimit()).toBe(100);
        expect(timerBatchLimit(2000)).toBe(500);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // B. getExpiredTimers — ARGV LIMIT contract (Aether's Lua)
  // ---------------------------------------------------------------------------
  describe('getExpiredTimers() ARGV LIMIT contract', () => {
    beforeEach(() => {
      mockEval_1.mockReset();
      mockGet_1.mockReset();
      mockDel_1.mockReset();
      mockSAdd_1.mockReset();
      delete process.env.TIMER_BATCH_LIMIT;
      delete process.env.TIMER_BATCH_LIMIT_MAX;
      process.env.FF_TIMER_LEGACY_ZSET_ENABLED = 'false';
    });

    function loadServiceWithMock() {
      let svc: any;
      jest.isolateModules(() => {
        const real = require('../shared/services/redis.service');
        svc = real.redisService;
        // Replace the underlying client with one whose eval/get we control.
        (svc as any).client = {
          eval: (...a: any[]) => mockEval_1(...a),
          get: (...a: any[]) => mockGet_1(...a),
          del: (...a: any[]) => mockDel_1(...a),
          sAdd: (...a: any[]) => mockSAdd_1(...a),
          scanIterator: async function* () { /* nothing */ },
        };
      });
      return svc;
    }

    test('passes effective limit as ARGV[2] (Lua LIMIT slot)', async () => {
      mockEval_1.mockResolvedValue([]);  // empty ZRANGEBYSCORE
      const svc = loadServiceWithMock();

      await svc.getExpiredTimers('timer:order-broadcast-step:', 175);

      // Find the call that loaded the ZRANGEBYSCORE script (contains 'zrangebyscore')
      const zrCall = mockEval_1.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].toLowerCase().includes('zrangebyscore')
      );
      expect(zrCall).toBeDefined();
      // ARGV is 3rd argument (script, KEYS array, ARGV array).
      const argv = zrCall![2];
      expect(Array.isArray(argv)).toBe(true);
      // ARGV[0] = now, ARGV[1] = limit (since ARGV is 0-indexed in JS)
      expect(argv[1]).toBe('175');
    });

    test('clamps explicit limit > MAX before passing to Lua', async () => {
      mockEval_1.mockResolvedValue([]);
      const svc = loadServiceWithMock();

      await svc.getExpiredTimers('timer:order-broadcast-step:', 9999);

      const zrCall = mockEval_1.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].toLowerCase().includes('zrangebyscore')
      );
      const argv = zrCall![2];
      expect(argv[1]).toBe('500');  // clamped to default MAX
    });

    test('falls back to env default when no explicit limit passed', async () => {
      process.env.TIMER_BATCH_LIMIT = '77';
      mockEval_1.mockResolvedValue([]);
      const svc = loadServiceWithMock();

      await svc.getExpiredTimers('timer:order-broadcast-step:');

      const zrCall = mockEval_1.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].toLowerCase().includes('zrangebyscore')
      );
      const argv = zrCall![2];
      expect(argv[1]).toBe('77');
    });

    test('uses per-prefix shard ZSET as KEYS[1] (NEW#1 wiring)', async () => {
      mockEval_1.mockResolvedValue([]);
      const svc = loadServiceWithMock();

      await svc.getExpiredTimers('timer:assignment-timeout:', 50);

      const zrCall = mockEval_1.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].toLowerCase().includes('zrangebyscore')
      );
      const keys = zrCall![1];
      expect(Array.isArray(keys)).toBe(true);
      expect(keys[0]).toBe('timers:pending:{assignment-timeout}');
    });
  });

  // ---------------------------------------------------------------------------
  // C. Yarrow's caller updates — source contract (no behavioral test)
  // Validates that all 8 caller files import + invoke timerBatchLimit().
  // ---------------------------------------------------------------------------
  describe('Yarrow caller updates — source contract', () => {
    const fs = require('fs');
    const path = require('path');
    const ROOT = path.resolve(__dirname, '..');

    const expectedCallers = [
      'modules/order/order-timer.service.ts',
      'modules/booking/booking-timer.service.ts',
      'modules/booking/booking.service.ts',
      'modules/booking/order.service.ts',
      'modules/booking/legacy-order-expiry.service.ts',
      'modules/rating/rating-reminder.service.ts',
      'shared/queue-processors/assignment-timeout-poller.ts',
      'shared/services/queue.service.ts',
    ];

    test.each(expectedCallers)('%s imports timerBatchLimit', (rel) => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src).toMatch(/import\s*{[^}]*timerBatchLimit[^}]*}\s*from/);
    });

    test.each(expectedCallers)('%s invokes timerBatchLimit()', (rel) => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src).toMatch(/timerBatchLimit\s*\(/);
    });
  });
});

export {};
