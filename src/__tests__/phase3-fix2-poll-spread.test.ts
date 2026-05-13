/**
 * =============================================================================
 * PHASE 3 — FIX #2 — Per-pod poll-spread coordination for getExpiredTimers
 * =============================================================================
 *
 * Validates that `redisService.getExpiredTimers` is gated by a per-shard
 * acquireLock leader-elect so that at N pods only one runs the
 * ZRANGEBYSCORE+MGET+pipelined-ZREM body per tick. Losers return [] and
 * peer-pods retry on the next tick.
 *
 * Test cases (per task brief):
 *   (a) FF_TIMER_POLLER_LEADER_LOCK=true + acquireLock returns acquired=false →
 *       returns [], emits timer_poller_lock_miss_total{prefix}, NO ZRANGEBYSCORE
 *   (b) FF=true + acquireLock returns acquired=true → runs body + finally releases lock
 *   (c) FF_TIMER_POLLER_LEADER_LOCK=false → bypasses lock entirely
 *   (d) acquireLock throws → WARN log + runs without lock (fail-open)
 *   (e) MGET batched (single network call) — verified via spy on rawClient.mget
 *   (f) Pipelined ZREM on filtered keys — verified via single pipeline.exec call
 *   (g) Corrupt JSON keys queued for DEL in the pipeline
 *
 * =============================================================================
 */

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockIncrementCounter = jest.fn();
jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: (...args: unknown[]) => mockIncrementCounter(...args),
    observeHistogram: jest.fn(),
    recordHistogram: jest.fn(),
  },
}));

jest.mock('../config/environment', () => ({
  config: {
    redis: { enabled: true },
    isProduction: false,
    otp: { expiryMinutes: 5 },
    sms: {},
  },
}));

// -------------------------------------------------------------------------
// Helper: build a fake ioredis-shaped client we can inject onto the
// redisService singleton.
// -------------------------------------------------------------------------
function buildFakeClient(opts: {
  zrangebyscoreResult?: string[];
  mgetResult?: Array<string | null>;
  pipelineExecResult?: unknown;
}) {
  const evalSpy = jest.fn(async (script: string) => {
    if (script.includes('zrangebyscore')) return opts.zrangebyscoreResult ?? [];
    if (script.includes('zrem')) return 1;
    return null;
  });
  const mgetSpy = jest.fn(async (..._keys: string[]) => opts.mgetResult ?? []);
  const pipelineExecSpy = jest.fn(async () => opts.pipelineExecResult ?? [[null, 1]]);
  const pipelineFactory = jest.fn(() => {
    const pipe: {
      zrem: jest.Mock;
      del: jest.Mock;
      exec: jest.Mock;
    } = {
      zrem: jest.fn().mockReturnThis(),
      del: jest.fn().mockReturnThis(),
      exec: pipelineExecSpy,
    };
    return pipe;
  });

  return {
    eval: evalSpy,
    mget: mgetSpy,
    pipeline: pipelineFactory,
    pipelineExecSpy,
    get: jest.fn(async () => null),
    del: jest.fn(async () => true),
    isConnected: () => true,
  };
}

type ServiceInternals = {
  acquireLock: (...args: unknown[]) => Promise<{ acquired: boolean; ttl?: number }>;
  releaseLock: (...args: unknown[]) => Promise<boolean>;
  client: ReturnType<typeof buildFakeClient>;
  getExpiredTimers: <T>(prefix: string) => Promise<Array<{ key: string; data: T; expiresAt: string }>>;
};

describe('Fix #2 — getExpiredTimers per-pod poll-spread', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockIncrementCounter.mockClear();
    process.env = { ...ORIGINAL_ENV };
    process.env.HOSTNAME = 'pod-test-1';
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  // ------------------------------------------------------------------------
  // (a) Leader-gate ON + lock NOT acquired → returns [] without reading ZSET
  // ------------------------------------------------------------------------
  test('(a) lock-miss returns [] and emits timer_poller_lock_miss_total', async () => {
    process.env.FF_TIMER_POLLER_LEADER_LOCK = 'true';

    const { redisService } = await import('../shared/services/redis.service');
    const svc = redisService as unknown as ServiceInternals;

    const fake = buildFakeClient({});
    svc.client = fake;
    const acquireSpy = jest.fn(async () => ({ acquired: false }));
    const releaseSpy = jest.fn(async () => true);
    svc.acquireLock = acquireSpy;
    svc.releaseLock = releaseSpy;

    const result = await svc.getExpiredTimers<{ orderId: string }>('timer:booking:');

    expect(result).toEqual([]);
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(acquireSpy).toHaveBeenCalledWith(
      'timer-poller:timers:pending',
      'pod-test-1',
      15
    );
    expect(fake.eval).not.toHaveBeenCalled();
    expect(mockIncrementCounter).toHaveBeenCalledWith(
      'timer_poller_lock_miss_total',
      { prefix: 'timer:booking:' }
    );
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------------
  // (b) Leader-gate ON + lock acquired → body runs + releaseLock on finally
  // ------------------------------------------------------------------------
  test('(b) lock acquired runs body and releases on finally', async () => {
    process.env.FF_TIMER_POLLER_LEADER_LOCK = 'true';

    const { redisService } = await import('../shared/services/redis.service');
    const svc = redisService as unknown as ServiceInternals;

    const fake = buildFakeClient({
      zrangebyscoreResult: ['timer:booking:abc'],
      mgetResult: [JSON.stringify({ expiresAt: new Date(Date.now() - 1000).toISOString(), data: { orderId: 'O1' } })],
    });
    svc.client = fake;
    const acquireSpy = jest.fn(async () => ({ acquired: true, ttl: 15 }));
    const releaseSpy = jest.fn(async () => true);
    svc.acquireLock = acquireSpy;
    svc.releaseLock = releaseSpy;

    const result = await svc.getExpiredTimers<{ orderId: string }>('timer:booking:');

    expect(result).toHaveLength(1);
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledWith('timer-poller:timers:pending', 'pod-test-1');
    expect(fake.eval).toHaveBeenCalledTimes(1); // ZRANGEBYSCORE only — ZREM moved to pipeline
  });

  // ------------------------------------------------------------------------
  // (c) FF off → bypasses lock entirely
  // ------------------------------------------------------------------------
  test('(c) FF_TIMER_POLLER_LEADER_LOCK=false bypasses lock', async () => {
    process.env.FF_TIMER_POLLER_LEADER_LOCK = 'false';

    const { redisService } = await import('../shared/services/redis.service');
    const svc = redisService as unknown as ServiceInternals;

    const fake = buildFakeClient({ zrangebyscoreResult: [] });
    svc.client = fake;
    const acquireSpy = jest.fn(async () => ({ acquired: false }));
    const releaseSpy = jest.fn(async () => true);
    svc.acquireLock = acquireSpy;
    svc.releaseLock = releaseSpy;

    const result = await svc.getExpiredTimers<{ orderId: string }>('timer:booking:');

    expect(result).toEqual([]);
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(fake.eval).toHaveBeenCalledTimes(1); // ZRANGEBYSCORE still ran
  });

  // ------------------------------------------------------------------------
  // (d) acquireLock throws → fail-open WARN + runs without lock
  // ------------------------------------------------------------------------
  test('(d) acquireLock throw is fail-open — WARN + runs without lock', async () => {
    process.env.FF_TIMER_POLLER_LEADER_LOCK = 'true';

    const { logger } = await import('../shared/services/logger.service');
    const { redisService } = await import('../shared/services/redis.service');
    const svc = redisService as unknown as ServiceInternals;

    const fake = buildFakeClient({ zrangebyscoreResult: [] });
    svc.client = fake;
    const acquireSpy = jest.fn(async () => { throw new Error('redis blip'); });
    const releaseSpy = jest.fn(async () => true);
    svc.acquireLock = acquireSpy;
    svc.releaseLock = releaseSpy;

    const result = await svc.getExpiredTimers<{ orderId: string }>('timer:booking:');

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
    expect((logger.warn as jest.Mock).mock.calls.some(c =>
      String(c[0]).includes('fail-open')
    )).toBe(true);
    expect(fake.eval).toHaveBeenCalledTimes(1); // body ran without lock
    expect(releaseSpy).not.toHaveBeenCalled(); // no lock was held
  });

  // ------------------------------------------------------------------------
  // (e) MGET batched — single network round-trip
  // ------------------------------------------------------------------------
  test('(e) MGET batches all filtered keys in one round-trip', async () => {
    process.env.FF_TIMER_POLLER_LEADER_LOCK = 'true';

    const { redisService } = await import('../shared/services/redis.service');
    const svc = redisService as unknown as ServiceInternals;

    const keys = [
      'timer:booking:k1',
      'timer:booking:k2',
      'timer:booking:k3',
      'timer:other:k4', // should be filtered out
    ];
    const expiredTs = new Date(Date.now() - 1000).toISOString();
    const fake = buildFakeClient({
      zrangebyscoreResult: keys,
      mgetResult: [
        JSON.stringify({ expiresAt: expiredTs, data: { a: 1 } }),
        JSON.stringify({ expiresAt: expiredTs, data: { a: 2 } }),
        JSON.stringify({ expiresAt: expiredTs, data: { a: 3 } }),
      ],
    });
    svc.client = fake;
    svc.acquireLock = jest.fn(async () => ({ acquired: true, ttl: 15 }));
    svc.releaseLock = jest.fn(async () => true);

    const result = await svc.getExpiredTimers<{ a: number }>('timer:booking:');

    expect(fake.mget).toHaveBeenCalledTimes(1); // single batched call
    expect(fake.mget).toHaveBeenCalledWith(
      'timer:booking:k1',
      'timer:booking:k2',
      'timer:booking:k3'
    );
    expect(result).toHaveLength(3);
  });

  // ------------------------------------------------------------------------
  // (f) Pipelined ZREM on filtered keys — exactly one pipeline.exec call
  // ------------------------------------------------------------------------
  test('(f) pipelined ZREM executes exactly once for the batch', async () => {
    process.env.FF_TIMER_POLLER_LEADER_LOCK = 'true';

    const { redisService } = await import('../shared/services/redis.service');
    const svc = redisService as unknown as ServiceInternals;

    const expiredTs = new Date(Date.now() - 1000).toISOString();
    const fake = buildFakeClient({
      zrangebyscoreResult: ['timer:booking:k1', 'timer:booking:k2'],
      mgetResult: [
        JSON.stringify({ expiresAt: expiredTs, data: { a: 1 } }),
        JSON.stringify({ expiresAt: expiredTs, data: { a: 2 } }),
      ],
    });
    svc.client = fake;
    svc.acquireLock = jest.fn(async () => ({ acquired: true, ttl: 15 }));
    svc.releaseLock = jest.fn(async () => true);

    await svc.getExpiredTimers<{ a: number }>('timer:booking:');

    expect(fake.pipeline).toHaveBeenCalledTimes(1);
    expect(fake.pipelineExecSpy).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------------
  // (g) Corrupt JSON keys are queued for DEL in the pipeline
  // ------------------------------------------------------------------------
  test('(g) corrupt JSON keys are DELed via the pipeline', async () => {
    process.env.FF_TIMER_POLLER_LEADER_LOCK = 'true';

    const { redisService } = await import('../shared/services/redis.service');
    const svc = redisService as unknown as ServiceInternals;

    const fake = buildFakeClient({
      zrangebyscoreResult: ['timer:booking:good', 'timer:booking:bad'],
      mgetResult: [
        JSON.stringify({ expiresAt: new Date(Date.now() - 1000).toISOString(), data: { a: 1 } }),
        '{{not valid json',
      ],
    });
    svc.client = fake;
    svc.acquireLock = jest.fn(async () => ({ acquired: true, ttl: 15 }));
    svc.releaseLock = jest.fn(async () => true);

    const result = await svc.getExpiredTimers<{ a: number }>('timer:booking:');

    expect(result).toHaveLength(1); // only the good one
    expect(fake.pipeline).toHaveBeenCalledTimes(1);
    const pipeInstance = fake.pipeline.mock.results[0].value as {
      zrem: jest.Mock;
      del: jest.Mock;
    };
    expect(pipeInstance.del).toHaveBeenCalledWith('timer:booking:bad');
    // Both keys should be ZREMed (good + bad)
    expect(pipeInstance.zrem).toHaveBeenCalledTimes(2);
  });
});
