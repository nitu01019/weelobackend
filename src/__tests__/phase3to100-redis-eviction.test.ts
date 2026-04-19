/**
 * =============================================================================
 * PHASE 3 -> 100% — W0-3: Redis Eviction Policy Runtime Assertion
 * =============================================================================
 *
 * These tests cover the runtime startup check that reads Redis
 * `CONFIG GET maxmemory-policy` and halts boot if it's not `noeviction`.
 *
 * The assertion MUST:
 *   1. Let boot succeed when policy = `noeviction`.
 *   2. Throw `RedisEvictionPolicyError` (with remediation text) when policy
 *      is anything else (e.g. `allkeys-lru`) — Redis under memory pressure
 *      will silently evict keys, corrupting BullMQ delayed-jobs + distributed
 *      locks + durable hold expiry (F-A-77 regression risk).
 *   3. Gracefully skip (WARN + counter) when `CONFIG GET` is denied by the
 *      managed Redis provider (e.g. AWS ElastiCache returns `NOPERM`) — we
 *      MUST NOT halt boot in that case; this is the whole reason the
 *      ElastiCache escape hatch exists.
 *
 * Related: F-A-77 durable HOLD_EXPIRY queue, `.env.example` documents
 * REDIS_MAXMEMORY_POLICY=noeviction requirement.
 * =============================================================================
 */

// ---------------------------------------------------------------------------
// MOCK SETUP — must come before any imports of the module under test
// ---------------------------------------------------------------------------

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
    recordHistogram: jest.fn(),
    setGauge: jest.fn(),
    observeHistogram: jest.fn(),
  },
}));

import {
  assertRedisEvictionPolicy,
  RedisEvictionPolicyError,
} from '../shared/monitoring/redis-eviction-assertion';
import { logger } from '../shared/services/logger.service';
import { metrics } from '../shared/monitoring/metrics.service';

// ---------------------------------------------------------------------------
// Helper: build a minimal ioredis-like stub that only implements `call`
// ---------------------------------------------------------------------------

interface StubClient {
  call: jest.Mock;
}

function makeClient(impl: (...args: unknown[]) => Promise<unknown>): StubClient {
  return {
    call: jest.fn().mockImplementation(impl),
  };
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe('W0-3 — assertRedisEvictionPolicy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // CASE 1 — Happy path: `noeviction` → boot continues, no error thrown
  // -----------------------------------------------------------------------
  test('resolves when maxmemory-policy is noeviction (boot continues)', async () => {
    // ioredis returns `['maxmemory-policy', 'noeviction']` for CONFIG GET
    const client = makeClient(async (cmd, sub, key) => {
      expect(cmd).toBe('CONFIG');
      expect(sub).toBe('GET');
      expect(key).toBe('maxmemory-policy');
      return ['maxmemory-policy', 'noeviction'];
    });

    await expect(assertRedisEvictionPolicy(client as any)).resolves.toBeUndefined();

    expect(client.call).toHaveBeenCalledWith('CONFIG', 'GET', 'maxmemory-policy');
    // Info log confirms passing state — no counter increment for skip path
    expect(metrics.incrementCounter).not.toHaveBeenCalledWith(
      'redis_eviction_check_skipped_total',
      expect.anything()
    );
  });

  // -----------------------------------------------------------------------
  // CASE 2 — Bad policy (allkeys-lru) → throws with remediation
  // -----------------------------------------------------------------------
  test('throws RedisEvictionPolicyError when policy is allkeys-lru (halts boot)', async () => {
    const client = makeClient(async () => ['maxmemory-policy', 'allkeys-lru']);

    await expect(assertRedisEvictionPolicy(client as any)).rejects.toThrow(
      RedisEvictionPolicyError
    );

    // Verify the error carries the policy value and remediation text
    try {
      await assertRedisEvictionPolicy(client as any);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RedisEvictionPolicyError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/allkeys-lru/);
      expect(msg).toMatch(/noeviction/);
      // Remediation / log code must be present so ops can grep CloudWatch
      expect(msg).toMatch(/REDIS_EVICTION_POLICY_INVALID/);
      expect((err as RedisEvictionPolicyError).policy).toBe('allkeys-lru');
    }
  });

  // -----------------------------------------------------------------------
  // CASE 3 — NOPERM (ElastiCache restricts CONFIG) → WARN + counter,
  // DO NOT halt boot.  Without this escape hatch the app would brick
  // in production on every managed-Redis deployment.
  // -----------------------------------------------------------------------
  test('on NOPERM error: WARN + skipped-counter, does NOT halt', async () => {
    const nopermErr = Object.assign(new Error("NOPERM this user has no permissions to run the 'config|get' command"), {
      // ioredis sets .message with "NOPERM ..." and sometimes a code.
      // We match on either the string or a `.code` property.
      code: 'NOPERM',
    });
    const client = makeClient(async () => { throw nopermErr; });

    await expect(assertRedisEvictionPolicy(client as any)).resolves.toBeUndefined();

    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'redis_eviction_check_skipped_total',
      expect.objectContaining({ reason: 'noperm' })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/REDIS_EVICTION_POLICY_CHECK_SKIPPED/),
      expect.anything()
    );
  });
});
