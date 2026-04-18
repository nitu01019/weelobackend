/**
 * =============================================================================
 * F-B-06 — redis-coordination fail-closed semantics
 * =============================================================================
 *
 * Asserts the invariants that make the split safe:
 *
 *   1. Default (flag OFF): markCoordinationLost() logs + flips readinessBlocked
 *      but does NOT call process.exit(). redisCoordination.isReady() still
 *      returns whatever redisService.isConnected() returns — legacy path.
 *
 *   2. Production + FF_REDIS_FAIL_CLOSED=true: markCoordinationLost() logs
 *      .error, flips readinessBlocked=true, schedules process.exit(1) AFTER a
 *      grace window, and redisCoordination.isReady() returns false IMMEDIATELY
 *      so /health/ready emits 503 and ALB drains the task.
 *
 *   3. Idempotency: repeat calls don't schedule a second exit timer.
 *
 *   4. Non-production (NODE_ENV!=production) + flag ON still never exits —
 *      enables local/CI testing of readinessBlocked without killing the test
 *      runner.
 * =============================================================================
 */

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    isConnected: jest.fn(() => true),
    get: jest.fn(), set: jest.fn(), del: jest.fn(),
    exists: jest.fn(), expire: jest.fn(), incr: jest.fn(), incrBy: jest.fn(),
    eval: jest.fn(), acquireLock: jest.fn(), releaseLock: jest.fn(),
  },
}));

jest.mock('../shared/services/logger.service', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: { incrementCounter: jest.fn() },
}));

describe('F-B-06 redis-coordination fail-closed', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    originalEnv = { ...process.env };
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((_code?: number) => undefined) as never);
    jest.useFakeTimers();
  });

  afterEach(() => {
    process.env = originalEnv;
    exitSpy.mockRestore();
    jest.useRealTimers();
  });

  it('legacy (flag OFF): flips readinessBlocked but never calls process.exit', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.FF_REDIS_FAIL_CLOSED;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../shared/services/redis-coordination.service');
    mod.__resetForTests();

    mod.markCoordinationLost('connect_failed');

    // Legacy semantics: readinessBlocked flipped, but gated by flag in isReady()
    expect(mod.readinessBlocked).toBe(true);
    // Because flag is OFF, isReady() falls through to redisService.isConnected()
    expect(mod.redisCoordination.isReady()).toBe(true);

    jest.advanceTimersByTime(10_000);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('production + FF_REDIS_FAIL_CLOSED=true: isReady()=false immediately + exit(1) after 5s', () => {
    process.env.NODE_ENV = 'production';
    process.env.FF_REDIS_FAIL_CLOSED = 'true';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../shared/services/redis-coordination.service');
    mod.__resetForTests();

    mod.markCoordinationLost('connect_failed');

    // Readiness must flip IMMEDIATELY so ALB routes drain before exit
    expect(mod.readinessBlocked).toBe(true);
    expect(mod.redisCoordination.isReady()).toBe(false);

    // Exit is scheduled but not immediate
    expect(exitSpy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(5_000);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('idempotent: multiple markCoordinationLost calls schedule exactly one exit', () => {
    process.env.NODE_ENV = 'production';
    process.env.FF_REDIS_FAIL_CLOSED = 'true';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../shared/services/redis-coordination.service');
    mod.__resetForTests();

    mod.markCoordinationLost('first');
    mod.markCoordinationLost('second');
    mod.markCoordinationLost('third');

    jest.advanceTimersByTime(6_000);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('non-production (NODE_ENV=test) + flag ON: never exits (keeps test runners alive)', () => {
    process.env.NODE_ENV = 'test';
    process.env.FF_REDIS_FAIL_CLOSED = 'true';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../shared/services/redis-coordination.service');
    mod.__resetForTests();

    mod.markCoordinationLost('connect_failed');

    expect(mod.readinessBlocked).toBe(true);
    jest.advanceTimersByTime(10_000);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('delegated coordination primitives pass through to redisService', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { redisService } = require('../shared/services/redis.service');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../shared/services/redis-coordination.service');
    mod.__resetForTests();

    (redisService.acquireLock as jest.Mock).mockResolvedValue({ acquired: true });
    const result = await mod.redisCoordination.acquireLock('k', 'h', 30);

    expect(redisService.acquireLock).toHaveBeenCalledWith('k', 'h', 30);
    expect(result).toEqual({ acquired: true });
  });

  it('all other delegate methods pass through to redisService', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { redisService } = require('../shared/services/redis.service');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../shared/services/redis-coordination.service');
    mod.__resetForTests();

    (redisService.get as jest.Mock).mockResolvedValue('v');
    (redisService.set as jest.Mock).mockResolvedValue(undefined);
    (redisService.del as jest.Mock).mockResolvedValue(true);
    (redisService.exists as jest.Mock).mockResolvedValue(true);
    (redisService.expire as jest.Mock).mockResolvedValue(true);
    (redisService.incr as jest.Mock).mockResolvedValue(1);
    (redisService.incrBy as jest.Mock).mockResolvedValue(10);
    (redisService.eval as jest.Mock).mockResolvedValue(7);
    (redisService.releaseLock as jest.Mock).mockResolvedValue(true);

    await mod.redisCoordination.get('k');
    await mod.redisCoordination.set('k', 'v', 5);
    await mod.redisCoordination.del('k');
    await mod.redisCoordination.exists('k');
    await mod.redisCoordination.expire('k', 30);
    await mod.redisCoordination.incr('k');
    await mod.redisCoordination.incrBy('k', 10);
    await mod.redisCoordination.eval('script', ['k1'], ['a1']);
    await mod.redisCoordination.releaseLock('k', 'h');

    expect(redisService.get).toHaveBeenCalledWith('k');
    expect(redisService.set).toHaveBeenCalledWith('k', 'v', 5);
    expect(redisService.del).toHaveBeenCalledWith('k');
    expect(redisService.exists).toHaveBeenCalledWith('k');
    expect(redisService.expire).toHaveBeenCalledWith('k', 30);
    expect(redisService.incr).toHaveBeenCalledWith('k');
    expect(redisService.incrBy).toHaveBeenCalledWith('k', 10);
    expect(redisService.eval).toHaveBeenCalledWith('script', ['k1'], ['a1']);
    expect(redisService.releaseLock).toHaveBeenCalledWith('k', 'h');
  });
});
