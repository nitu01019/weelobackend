/**
 * =============================================================================
 * PHASE 4 — FIX #5 — Atomic delay-promote Lua + awaitable stop()
 * =============================================================================
 *
 * Validates:
 *   (a) FF_DELAY_POLLER_ATOMIC_PROMOTE=true (default) → atomic Lua eval invoked
 *       with 5 KEYS (delayedKey + 4 priority lists) + 5 ARGV (now + 4 priority
 *       enum values), AND legacy zRangeByScore / lPush / zRemRangeByScore NOT
 *       invoked on the atomic path.
 *   (b) FF_DELAY_POLLER_ATOMIC_PROMOTE=false → legacy 3-RT path (zRangeByScore
 *       → for-loop lPush → zRemRangeByScore) invoked AND eval NOT invoked.
 *   (c) Priority routing — under FF=false the legacy path routes CRITICAL jobs
 *       to the :critical key, NORMAL to :normal etc. (Atomic-path routing is
 *       enforced inside Redis-side Lua and not directly observable here without
 *       a real Redis; the test verifies the KEYS array passed to eval contains
 *       :critical/:high/:normal/:low in the correct positions.)
 *   (d) stop() returns a Promise; awaiting it waits for the in-flight tick.
 *   (e) Empty ZSET on legacy path → no lPush, no zRemRangeByScore (and on
 *       atomic path Lua handles this internally — verified via eval still
 *       being called with the correct KEYS even when nothing promotes).
 * =============================================================================
 */

// ============================================================================
// MOCKS — must be declared before importing the module under test
// ============================================================================

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    observeHistogram: jest.fn(),
    recordHistogram: jest.fn(),
    setGauge: jest.fn(),
  },
}));

jest.mock('../config/environment', () => ({
  config: { redis: { enabled: false }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {} },
}));

const mockEval = jest.fn().mockResolvedValue(0);
const mockZRangeByScore = jest.fn().mockResolvedValue([]);
const mockZRemRangeByScore = jest.fn().mockResolvedValue(0);
const mockLPush = jest.fn().mockResolvedValue(1);

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    eval: mockEval,
    zRangeByScore: mockZRangeByScore,
    zRemRangeByScore: mockZRemRangeByScore,
    lPush: mockLPush,
    lTrim: jest.fn().mockResolvedValue('OK'),
    expire: jest.fn().mockResolvedValue(1),
    lLen: jest.fn().mockResolvedValue(0),
    lPushMany: jest.fn().mockResolvedValue(1),
    brPop: jest.fn().mockResolvedValue(null),
    hSet: jest.fn().mockResolvedValue(1),
    hDel: jest.fn().mockResolvedValue(1),
    hGetAll: jest.fn().mockResolvedValue({}),
    zAdd: jest.fn().mockResolvedValue(1),
    setTimer: jest.fn().mockResolvedValue(undefined),
    cancelTimer: jest.fn().mockResolvedValue(undefined),
    acquireLock: jest.fn().mockResolvedValue({ acquired: false }),
    releaseLock: jest.fn().mockResolvedValue(undefined),
    incr: jest.fn().mockResolvedValue(1),
    del: jest.fn().mockResolvedValue(1),
    getExpiredTimers: jest.fn().mockResolvedValue([]),
    isConnected: jest.fn().mockReturnValue(false),
  },
}));

jest.mock('../shared/services/tracking-stream-sink', () => ({
  createTrackingStreamSink: () => ({
    publishTrackingEvents: jest.fn().mockResolvedValue(undefined),
    flush: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    assignment: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
    booking: { findUnique: jest.fn() },
    vehicle: { updateMany: jest.fn() },
    order: { findUnique: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
  },
}));

jest.mock('firebase-admin', () => ({
  messaging: jest.fn(() => ({ sendMulticast: jest.fn() })),
}));

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: jest.fn(),
  SocketEvent: { VEHICLE_STATUS_CHANGED: 'vehicle_status_changed' },
}));

jest.mock('../shared/services/fcm.service', () => ({
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
  fcmService: { sendToTokens: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../shared/services/circuit-breaker.service', () => ({
  fcmCircuit: {
    tryWithFallback: jest.fn(async (fn: () => Promise<void>) => fn()),
  },
}));

jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: jest.fn().mockResolvedValue(undefined),
  },
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { MessagePriority } from '../shared/services/queue.service';

// ============================================================================
// Test helpers
// ============================================================================

/**
 * Reach into the RedisQueue private members. We do this rather than using
 * the public surface because the delay-poller setInterval is unref'd and
 * fires asynchronously — directly invoking the tick body keeps tests
 * deterministic and avoids real-timer flakes.
 */
function makeRedisQueue(): any {
  // Bypass the QueueService singleton (which selects implementation by env).
  // Import the RedisQueue class directly via require to avoid TS export shape
  // concerns (RedisQueue is exported as a class).
  const mod = require('../shared/services/queue.service');
  // The module exports RedisQueue as a named class.
  return new mod.RedisQueue();
}

/**
 * Drive ONE delay-poller iteration deterministically by:
 *   1. Registering a processor (so the for-loop has a queueName to iterate).
 *   2. Setting isRunning=true.
 *   3. Calling the private startDelayPoller() which sets up setInterval.
 *   4. Manually invoking the per-tick body via direct field access on
 *      this.processors / this.inflightTickPromise.
 *
 * Simpler: we just register a processor, set isRunning=true, then call
 * start() and immediately advance time using jest fake timers.
 */
async function tickOnce(rq: any, queueName: string): Promise<void> {
  rq.processors.set(queueName, async () => {});
  rq.isRunning = true;
  // Manually invoke the same body as the setInterval callback by calling
  // startDelayPoller and then waiting for inflightTickPromise. Use fake
  // timers to flush exactly one 1s interval tick.
  jest.useFakeTimers();
  rq.startDelayPoller();
  // Fire the first interval tick
  jest.advanceTimersByTime(1000);
  // Wait for the in-flight microtasks to complete
  await Promise.resolve();
  if (rq.inflightTickPromise) {
    await rq.inflightTickPromise;
  }
  jest.useRealTimers();
}

// ============================================================================
// Tests
// ============================================================================

describe('Phase 4 — Fix #5: atomic delay-promote Lua + awaitable stop()', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    mockEval.mockReset();
    mockEval.mockResolvedValue(0);
    mockZRangeByScore.mockReset();
    mockZRangeByScore.mockResolvedValue([]);
    mockZRemRangeByScore.mockReset();
    mockZRemRangeByScore.mockResolvedValue(0);
    mockLPush.mockReset();
    mockLPush.mockResolvedValue(1);
    process.env = { ...originalEnv, NODE_ENV: 'test' };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // (a) Atomic path — default ON
  // -------------------------------------------------------------------------
  describe('(a) FF_DELAY_POLLER_ATOMIC_PROMOTE default ON', () => {
    it('invokes eval() once with 5 KEYS (delayed + 4 priority lists) and 5 ARGV (now + 4 priority enum values)', async () => {
      delete process.env.FF_DELAY_POLLER_ATOMIC_PROMOTE; // default ON
      const rq = makeRedisQueue();
      await tickOnce(rq, 'broadcasts');
      await rq.stop();

      expect(mockEval).toHaveBeenCalled();
      const [script, keys, args] = mockEval.mock.calls[0];

      expect(typeof script).toBe('string');
      expect(script).toContain('ZRANGEBYSCORE');
      expect(script).toContain('LPUSH');
      expect(script).toContain('ZREMRANGEBYSCORE');

      expect(keys).toHaveLength(5);
      expect(keys[0]).toBe('delayed:broadcasts');
      expect(keys[1]).toBe('queue:broadcasts:critical');
      expect(keys[2]).toBe('queue:broadcasts:high');
      expect(keys[3]).toBe('queue:broadcasts:normal');
      expect(keys[4]).toBe('queue:broadcasts:low');

      expect(args).toHaveLength(5);
      // ARGV[1] = now (numeric string)
      expect(args[0]).toMatch(/^\d+$/);
      // ARGV[2..5] = priority enum values
      expect(args[1]).toBe(String(MessagePriority.CRITICAL));
      expect(args[2]).toBe(String(MessagePriority.HIGH));
      expect(args[3]).toBe(String(MessagePriority.NORMAL));
      expect(args[4]).toBe(String(MessagePriority.LOW));
    });

    it('does NOT invoke legacy zRangeByScore/lPush/zRemRangeByScore on the atomic path', async () => {
      delete process.env.FF_DELAY_POLLER_ATOMIC_PROMOTE;
      const rq = makeRedisQueue();
      await tickOnce(rq, 'broadcasts');
      await rq.stop();

      expect(mockZRangeByScore).not.toHaveBeenCalled();
      expect(mockLPush).not.toHaveBeenCalled();
      expect(mockZRemRangeByScore).not.toHaveBeenCalled();
    });

    it('does not call eval when isRunning is false (defensive)', async () => {
      delete process.env.FF_DELAY_POLLER_ATOMIC_PROMOTE;
      const rq = makeRedisQueue();
      rq.isRunning = false;
      rq.processors.set('broadcasts', async () => {});
      jest.useFakeTimers();
      rq.startDelayPoller();
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      jest.useRealTimers();
      await rq.stop();
      expect(mockEval).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // (b) Legacy path — FF=false
  // -------------------------------------------------------------------------
  describe('(b) FF_DELAY_POLLER_ATOMIC_PROMOTE=false → legacy 3-RT path', () => {
    it('invokes zRangeByScore + (per-job) lPush + zRemRangeByScore, and does NOT invoke eval', async () => {
      process.env.FF_DELAY_POLLER_ATOMIC_PROMOTE = 'false';
      mockZRangeByScore.mockResolvedValueOnce([
        JSON.stringify({ id: 'j1', type: 'new_broadcast', data: {}, priority: MessagePriority.NORMAL }),
        JSON.stringify({ id: 'j2', type: 'order_cancelled', data: {}, priority: MessagePriority.CRITICAL }),
      ]);

      const rq = makeRedisQueue();
      await tickOnce(rq, 'broadcasts');
      await rq.stop();

      expect(mockEval).not.toHaveBeenCalled();
      expect(mockZRangeByScore).toHaveBeenCalledTimes(1);
      expect(mockLPush).toHaveBeenCalledTimes(2);
      expect(mockZRemRangeByScore).toHaveBeenCalledTimes(1);
    });

    it('returns early when zRangeByScore yields empty result (no lPush, no zRemRangeByScore)', async () => {
      process.env.FF_DELAY_POLLER_ATOMIC_PROMOTE = 'false';
      mockZRangeByScore.mockResolvedValueOnce([]);

      const rq = makeRedisQueue();
      await tickOnce(rq, 'broadcasts');
      await rq.stop();

      expect(mockEval).not.toHaveBeenCalled();
      expect(mockZRangeByScore).toHaveBeenCalledTimes(1);
      expect(mockLPush).not.toHaveBeenCalled();
      expect(mockZRemRangeByScore).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // (c) Priority routing — legacy path
  // -------------------------------------------------------------------------
  describe('(c) Priority routing (legacy path — atomic routing happens server-side in Redis Lua)', () => {
    it('routes CRITICAL → queue:<name>:critical, HIGH → :high, NORMAL → :normal, LOW → :low', async () => {
      process.env.FF_DELAY_POLLER_ATOMIC_PROMOTE = 'false';
      mockZRangeByScore.mockResolvedValueOnce([
        JSON.stringify({ id: 'jc', type: 'order_cancelled', data: {}, priority: MessagePriority.CRITICAL }),
        JSON.stringify({ id: 'jh', type: 'trip_assigned', data: {}, priority: MessagePriority.HIGH }),
        JSON.stringify({ id: 'jn', type: 'new_broadcast', data: {}, priority: MessagePriority.NORMAL }),
        JSON.stringify({ id: 'jl', type: 'telemetry', data: {}, priority: MessagePriority.LOW }),
      ]);

      const rq = makeRedisQueue();
      await tickOnce(rq, 'broadcasts');
      await rq.stop();

      const targetKeys = mockLPush.mock.calls.map(c => c[0]);
      expect(targetKeys).toEqual(
        expect.arrayContaining([
          'queue:broadcasts:critical',
          'queue:broadcasts:high',
          'queue:broadcasts:normal',
          'queue:broadcasts:low',
        ]),
      );
      // 4 jobs → 4 lPush calls
      expect(mockLPush).toHaveBeenCalledTimes(4);
    });

    it('routes job with no priority field to :normal (default)', async () => {
      process.env.FF_DELAY_POLLER_ATOMIC_PROMOTE = 'false';
      mockZRangeByScore.mockResolvedValueOnce([
        JSON.stringify({ id: 'jx', type: 'unknown', data: {} }), // no priority
      ]);

      const rq = makeRedisQueue();
      await tickOnce(rq, 'broadcasts');
      await rq.stop();

      expect(mockLPush).toHaveBeenCalledTimes(1);
      expect(mockLPush.mock.calls[0][0]).toBe('queue:broadcasts:normal');
    });
  });

  // -------------------------------------------------------------------------
  // (d) stop() is async + awaitable + waits for in-flight tick
  // -------------------------------------------------------------------------
  describe('(d) async stop() awaits in-flight tick', () => {
    it('returns a Promise', () => {
      const rq = makeRedisQueue();
      const ret = rq.stop();
      expect(ret).toBeInstanceOf(Promise);
      return ret; // settle it so the test doesn't leak a pending promise
    });

    it('awaits in-flight delay-poller tick before resolving (Lua mid-flight scenario)', async () => {
      delete process.env.FF_DELAY_POLLER_ATOMIC_PROMOTE;
      let resolveLua: (v: number) => void = () => {};
      const luaPromise = new Promise<number>(r => { resolveLua = r; });
      mockEval.mockReturnValue(luaPromise);

      const rq = makeRedisQueue();
      rq.processors.set('broadcasts', async () => {});
      rq.isRunning = true;
      jest.useFakeTimers();
      rq.startDelayPoller();
      jest.advanceTimersByTime(1000);
      // microtasks for the inflight tick wrapper to publish onto rq
      await Promise.resolve();
      jest.useRealTimers();

      // At this point eval is in-flight; stop() must await it.
      let stopResolved = false;
      const stopPromise = rq.stop().then(() => { stopResolved = true; });

      // Yield microtasks — stop() should still be waiting on inflightTickPromise.
      await new Promise(r => setTimeout(r, 10));
      expect(stopResolved).toBe(false);

      // Unblock the Lua promise → inflight tick resolves → stop() resolves.
      resolveLua(0);
      await stopPromise;
      expect(stopResolved).toBe(true);
    });

    it('honors QUEUE_SHUTDOWN_TICK_TIMEOUT_MS bound (does not hang forever if in-flight tick hangs)', async () => {
      delete process.env.FF_DELAY_POLLER_ATOMIC_PROMOTE;
      process.env.QUEUE_SHUTDOWN_TICK_TIMEOUT_MS = '1000'; // 1s bound

      // Never-resolving eval simulates a hung Redis
      mockEval.mockReturnValue(new Promise<number>(() => { /* never */ }));

      const rq = makeRedisQueue();
      rq.processors.set('broadcasts', async () => {});
      rq.isRunning = true;
      jest.useFakeTimers();
      rq.startDelayPoller();
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      jest.useRealTimers();

      const t0 = Date.now();
      await rq.stop();
      const elapsed = Date.now() - t0;
      // Bounded — must complete within ~2s (1s timeout + slack), not hang forever.
      expect(elapsed).toBeLessThan(2000);
    }, 5000);
  });

  // -------------------------------------------------------------------------
  // (e) Empty ZSET on atomic path → Lua still called (server-side returns 0)
  // -------------------------------------------------------------------------
  describe('(e) Empty ZSET — atomic path delegates to Lua (server-side no-op)', () => {
    it('still calls eval() with the full KEYS array; Lua return value 0 → no metric emission', async () => {
      delete process.env.FF_DELAY_POLLER_ATOMIC_PROMOTE;
      mockEval.mockResolvedValue(0); // Lua returns 0 = nothing promoted

      const { metrics: metricsMock } = require('../shared/monitoring/metrics.service');
      (metricsMock.incrementCounter as jest.Mock).mockClear();

      const rq = makeRedisQueue();
      await tickOnce(rq, 'broadcasts');
      await rq.stop();

      expect(mockEval).toHaveBeenCalledTimes(1);
      // No promotion-counter increment when promoted === 0
      const counterCalls = (metricsMock.incrementCounter as jest.Mock).mock.calls
        .filter(c => c[0] === 'delay_promotion_atomic_total');
      expect(counterCalls).toHaveLength(0);
    });

    it('increments delay_promotion_atomic_total when Lua returns > 0', async () => {
      delete process.env.FF_DELAY_POLLER_ATOMIC_PROMOTE;
      mockEval.mockResolvedValue(3); // Lua returns 3 promoted jobs

      const { metrics: metricsMock } = require('../shared/monitoring/metrics.service');
      (metricsMock.incrementCounter as jest.Mock).mockClear();

      const rq = makeRedisQueue();
      await tickOnce(rq, 'broadcasts');
      await rq.stop();

      const counterCalls = (metricsMock.incrementCounter as jest.Mock).mock.calls
        .filter(c => c[0] === 'delay_promotion_atomic_total');
      expect(counterCalls).toHaveLength(1);
      expect(counterCalls[0][1]).toEqual({ queue: 'broadcasts' });
      expect(counterCalls[0][2]).toBe(3);
    });
  });
});
