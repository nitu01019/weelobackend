/**
 * Phase 3 / Fix #23 — acquireLock retry + Full-Jitter + deadline + AbortSignal tests.
 *
 * Verifies the new opt-in retry/jitter wrapper in src/shared/services/redis.service.ts:
 *   (a) retries=0 default — calls acquireLockOnce exactly once; no sleep; no jitter overhead
 *   (b) retries=3 + first attempt succeeds — calls acquireLockOnce once; no sleep
 *   (c) retries=3 + first 2 fail then 3rd succeeds — 3 acquire calls, 2 sleeps with jitter
 *   (d) retries=3 + all fail within deadline — returns last failed result after retries+1 attempts
 *   (e) AbortSignal aborts mid-backoff — returns {acquired:false}; AbortError handled
 *   (f) deadline exhausts before retries — final attempt skipped when remainingMs - acquireBudgetMs <= 0
 *   (g) retries>0 + no deadlineMs → throws Error('acquireLock: deadlineMs required when retries > 0')
 *   (h) AWS Full Jitter formula validated: delay = random()*min(cap, base*2^attempt)
 *   (i) AbortError from node:timers/promises caught → {acquired:false}; other errors rethrow
 *
 * Strategy: mock the private `acquireLockOnce` via `jest.spyOn(redisService as any, ...)`
 * to control per-attempt LockResult; inject `random`, `now`, `sleep` via opts so we
 * deterministically assert the AWS Full Jitter formula.
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

type LockResult = { acquired: boolean; ttl?: number };

afterEach(() => {
  jest.restoreAllMocks();
  incrementCounter.mockClear();
});

// ---------------------------------------------------------------------------
// (a) retries=0 default — fast-path
// ---------------------------------------------------------------------------

describe('redisService.acquireLock — retries=0 fast-path', () => {
  test('(a) retries=0 default calls acquireLockOnce exactly once, returns its result, no sleep', async () => {
    const expected: LockResult = { acquired: true, ttl: 30 };
    const onceSpy = jest
      .spyOn(redisService as unknown as { acquireLockOnce: (...args: unknown[]) => Promise<LockResult> }, 'acquireLockOnce')
      .mockResolvedValueOnce(expected);
    const sleep = jest.fn().mockResolvedValue(undefined);

    const result = await redisService.acquireLock('truck:1', 'holder-A', 30, {
      // no retries; sleep seam present to assert non-invocation
      sleep,
    });

    expect(result).toEqual(expected);
    expect(onceSpy).toHaveBeenCalledTimes(1);
    expect(onceSpy).toHaveBeenCalledWith('truck:1', 'holder-A', 30);
    expect(sleep).not.toHaveBeenCalled();
  });

  test('(a.bare) no opts passed at all hits retries=0 path and returns once', async () => {
    const expected: LockResult = { acquired: false };
    const onceSpy = jest
      .spyOn(redisService as unknown as { acquireLockOnce: (...args: unknown[]) => Promise<LockResult> }, 'acquireLockOnce')
      .mockResolvedValueOnce(expected);

    const result = await redisService.acquireLock('truck:2', 'holder-B', 15);

    expect(result).toEqual(expected);
    expect(onceSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// (b) retries=3 first-attempt success
// ---------------------------------------------------------------------------

describe('redisService.acquireLock — first-attempt success on retry path', () => {
  test('(b) retries=3 with first attempt acquired → 1 onceSpy call, no sleep', async () => {
    const expected: LockResult = { acquired: true, ttl: 30 };
    const onceSpy = jest
      .spyOn(redisService as unknown as { acquireLockOnce: (...args: unknown[]) => Promise<LockResult> }, 'acquireLockOnce')
      .mockResolvedValueOnce(expected);
    const sleep = jest.fn().mockResolvedValue(undefined);
    const now = jest.fn().mockReturnValue(0);

    const result = await redisService.acquireLock('truck:3', 'holder-A', 30, {
      retries: 3,
      baseDelayMs: 25,
      maxDelayMs: 250,
      deadlineMs: 500,
      random: () => 0.5,
      now,
      sleep,
    });

    expect(result).toEqual(expected);
    expect(onceSpy).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (c) + (h) retries=3, first 2 fail then 3rd succeeds — assert Full Jitter formula
// ---------------------------------------------------------------------------

describe('redisService.acquireLock — Full Jitter formula', () => {
  test('(c)+(h) random=0.5 + base=25 + cap=250 + 3 contention misses then ack → sleeps [12.5, 25]', async () => {
    const fail: LockResult = { acquired: false };
    const ok: LockResult = { acquired: true, ttl: 30 };
    const onceSpy = jest
      .spyOn(redisService as unknown as { acquireLockOnce: (...args: unknown[]) => Promise<LockResult> }, 'acquireLockOnce')
      .mockResolvedValueOnce(fail)
      .mockResolvedValueOnce(fail)
      .mockResolvedValueOnce(ok);
    const sleep = jest.fn().mockResolvedValue(undefined);
    // Step monotonically; each call advances by 1ms — far inside the 500ms deadline.
    let t = 0;
    const now = jest.fn(() => t++);

    const result = await redisService.acquireLock('truck:c', 'holder-A', 30, {
      retries: 3,
      baseDelayMs: 25,
      maxDelayMs: 250,
      deadlineMs: 500,
      acquireBudgetMs: 50,
      random: () => 0.5,
      now,
      sleep,
    });

    expect(result).toEqual(ok);
    expect(onceSpy).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    // AWS Full Jitter: delay = random()*min(cap, base*2^attempt)
    // attempt=0: 0.5 * min(250, 25)  = 12.5
    // attempt=1: 0.5 * min(250, 50)  = 25
    expect(sleep.mock.calls[0][0]).toBeCloseTo(12.5, 5);
    expect(sleep.mock.calls[1][0]).toBeCloseTo(25, 5);
  });

  test('(h.cap) random=0.5 + baseDelayMs that overflows cap → clamped to cap', async () => {
    const fail: LockResult = { acquired: false };
    const onceSpy = jest
      .spyOn(redisService as unknown as { acquireLockOnce: (...args: unknown[]) => Promise<LockResult> }, 'acquireLockOnce')
      .mockResolvedValue(fail);
    const sleep = jest.fn().mockResolvedValue(undefined);
    let t = 0;
    const now = jest.fn(() => t++);

    await redisService.acquireLock('truck:h', 'holder-A', 30, {
      retries: 2,
      baseDelayMs: 200, // base*2^2 = 800 > cap 250 — clamps to cap
      maxDelayMs: 250,
      deadlineMs: 100000,
      acquireBudgetMs: 50,
      random: () => 0.5,
      now,
      sleep,
    });

    // attempt 0: min(250, 200) = 200 → 0.5 * 200 = 100
    // attempt 1: min(250, 400) = 250 → 0.5 * 250 = 125
    expect(onceSpy).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls[0][0]).toBeCloseTo(100, 5);
    expect(sleep.mock.calls[1][0]).toBeCloseTo(125, 5);
  });
});

// ---------------------------------------------------------------------------
// (d) all fail within deadline
// ---------------------------------------------------------------------------

describe('redisService.acquireLock — all attempts fail', () => {
  test('(d) retries=3 + all contention misses → 4 acquire calls, returns last failed result', async () => {
    const fail: LockResult = { acquired: false };
    const onceSpy = jest
      .spyOn(redisService as unknown as { acquireLockOnce: (...args: unknown[]) => Promise<LockResult> }, 'acquireLockOnce')
      .mockResolvedValue(fail);
    const sleep = jest.fn().mockResolvedValue(undefined);
    let t = 0;
    const now = jest.fn(() => t++);

    const result = await redisService.acquireLock('truck:d', 'holder-A', 30, {
      retries: 3,
      baseDelayMs: 25,
      maxDelayMs: 250,
      deadlineMs: 100000,
      acquireBudgetMs: 50,
      random: () => 0.5,
      now,
      sleep,
    });

    expect(result).toEqual(fail);
    expect(onceSpy).toHaveBeenCalledTimes(4); // retries+1
    expect(sleep).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// (e) + (i) AbortSignal mid-backoff
// ---------------------------------------------------------------------------

describe('redisService.acquireLock — AbortSignal', () => {
  test('(e) signal already aborted at loop top → returns {acquired:false} without calling acquireLockOnce', async () => {
    const onceSpy = jest
      .spyOn(redisService as unknown as { acquireLockOnce: (...args: unknown[]) => Promise<LockResult> }, 'acquireLockOnce')
      .mockResolvedValue({ acquired: false });
    const sleep = jest.fn().mockResolvedValue(undefined);
    const controller = new AbortController();
    controller.abort();

    const result = await redisService.acquireLock('truck:e1', 'holder-A', 30, {
      retries: 3,
      baseDelayMs: 25,
      maxDelayMs: 250,
      deadlineMs: 500,
      signal: controller.signal,
      random: () => 0.5,
      now: () => 0,
      sleep,
    });

    expect(result).toEqual({ acquired: false });
    expect(onceSpy).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  test('(i) sleep throws AbortError mid-backoff → returns {acquired:false}', async () => {
    const fail: LockResult = { acquired: false };
    const onceSpy = jest
      .spyOn(redisService as unknown as { acquireLockOnce: (...args: unknown[]) => Promise<LockResult> }, 'acquireLockOnce')
      .mockResolvedValueOnce(fail);
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const sleep = jest.fn().mockRejectedValueOnce(abortErr);
    let t = 0;
    const now = jest.fn(() => t++);

    const result = await redisService.acquireLock('truck:e2', 'holder-A', 30, {
      retries: 3,
      baseDelayMs: 25,
      maxDelayMs: 250,
      deadlineMs: 500,
      random: () => 0.5,
      now,
      sleep,
    });

    expect(result).toEqual({ acquired: false });
    expect(onceSpy).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  test('(i.other) sleep throws non-AbortError → rethrows', async () => {
    const fail: LockResult = { acquired: false };
    jest
      .spyOn(redisService as unknown as { acquireLockOnce: (...args: unknown[]) => Promise<LockResult> }, 'acquireLockOnce')
      .mockResolvedValueOnce(fail);
    const otherErr = new Error('boom');
    const sleep = jest.fn().mockRejectedValueOnce(otherErr);
    let t = 0;
    const now = jest.fn(() => t++);

    await expect(
      redisService.acquireLock('truck:e3', 'holder-A', 30, {
        retries: 3,
        baseDelayMs: 25,
        maxDelayMs: 250,
        deadlineMs: 500,
        random: () => 0.5,
        now,
        sleep,
      })
    ).rejects.toThrow('boom');
  });
});

// ---------------------------------------------------------------------------
// (f) deadline-clamp skips final attempt's sleep when no budget left
// ---------------------------------------------------------------------------

describe('redisService.acquireLock — deadline clamp', () => {
  test('(f) remainingMs - acquireBudgetMs <= 0 → sleepMs<=0 → return lastResult without sleeping', async () => {
    const fail: LockResult = { acquired: false };
    const onceSpy = jest
      .spyOn(redisService as unknown as { acquireLockOnce: (...args: unknown[]) => Promise<LockResult> }, 'acquireLockOnce')
      .mockResolvedValue(fail);
    const sleep = jest.fn().mockResolvedValue(undefined);
    // Force "remaining-deadline-minus-budget" <= 0 on the very first iteration.
    // Sequence per loop iter: startedAt=now() (call 1=0); attempt 0 starts; then `now()` is
    // consulted twice — once for deadline check (call 2), once for remainingMs (call 3).
    // Return 0 first (startedAt), 60 second (deadline-check 60<500 keeps looping),
    // 470 third (remainingMs = 500-470 = 30; sleepMs = min(jittered, max(0, 30-50)) = 0).
    const seq = [0, 60, 470];
    const now = jest.fn(() => seq.shift() ?? 999);

    const result = await redisService.acquireLock('truck:f', 'holder-A', 30, {
      retries: 3,
      baseDelayMs: 25,
      maxDelayMs: 250,
      deadlineMs: 500,
      acquireBudgetMs: 50,
      random: () => 1.0,
      now,
      sleep,
    });

    expect(result).toEqual(fail);
    expect(onceSpy).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test('(f.deadline-exceeded) deadlineMs already exceeded after first attempt → bail without sleep', async () => {
    const fail: LockResult = { acquired: false };
    const onceSpy = jest
      .spyOn(redisService as unknown as { acquireLockOnce: (...args: unknown[]) => Promise<LockResult> }, 'acquireLockOnce')
      .mockResolvedValue(fail);
    const sleep = jest.fn().mockResolvedValue(undefined);
    // startedAt=0, then attempt 0 done; deadline check now=600 (>=500) → bail.
    const seq = [0, 600];
    const now = jest.fn(() => seq.shift() ?? 999);

    const result = await redisService.acquireLock('truck:f2', 'holder-A', 30, {
      retries: 3,
      baseDelayMs: 25,
      maxDelayMs: 250,
      deadlineMs: 500,
      acquireBudgetMs: 50,
      random: () => 0.5,
      now,
      sleep,
    });

    expect(result).toEqual(fail);
    expect(onceSpy).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (g) runtime assertion: retries>0 without deadlineMs
// ---------------------------------------------------------------------------

describe('redisService.acquireLock — runtime assertions', () => {
  test('(g) retries>0 without deadlineMs throws', async () => {
    const onceSpy = jest
      .spyOn(redisService as unknown as { acquireLockOnce: (...args: unknown[]) => Promise<LockResult> }, 'acquireLockOnce')
      .mockResolvedValue({ acquired: false });

    await expect(
      redisService.acquireLock('truck:g', 'holder-A', 30, {
        retries: 3,
        baseDelayMs: 25,
        maxDelayMs: 250,
      })
    ).rejects.toThrow('acquireLock: deadlineMs required when retries > 0');
    expect(onceSpy).not.toHaveBeenCalled();
  });
});
