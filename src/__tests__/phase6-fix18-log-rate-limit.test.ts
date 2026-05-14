/**
 * =============================================================================
 * Phase 6 / Fix #18 — log rate-limiting / sampling for hot-path errors
 * =============================================================================
 *
 * Validates the three behavioral expectations from the validated source doc
 * (index-30-validated.md "How to verify" stanza):
 *
 *   (a) First call to `logErrorThrottled(key, ...)` emits exactly one
 *       `logger.error(...)` call; subsequent calls within `windowMs` are
 *       suppressed and increment the internal suppressed counter; a call
 *       AFTER the window elapses re-emits with `suppressedCount=N`.
 *
 *   (b) Different `key` values are throttled independently — two keys can
 *       both emit at t=0 without interfering with each other.
 *
 *   (c) Two `createLogThrottle` factory instances share NO state — emitting
 *       on instance #1 does NOT suppress an immediate emit on instance #2.
 *
 * Plus two additional invariants the spec implies but does not test:
 *
 *   (d) The `suppressedCount` reported on the post-window re-emit equals the
 *       exact number of calls that were suppressed during the prior window.
 *
 *   (e) MAX_KEYS=256 dynamic-key OOM guard. In `'test'` NODE_ENV the dev-throw
 *       branch fires when distinct-key count exceeds the sentinel.
 *
 * The factory + DI clock shape lets every test instantiate a fresh closure
 * with a controllable `now()` — no jest.useFakeTimers() / module-scope state
 * leak / brittle setTimeout dance.
 * =============================================================================
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { createLogThrottle, type ThrottleLogger } from '../shared/utils/log-throttle';

interface RecordedCall {
  message: string;
  meta: Record<string, unknown>;
}

function makeRecorder(): { logger: ThrottleLogger; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const logger: ThrottleLogger = {
    error: (message, meta) => {
      calls.push({ message, meta: { ...(meta ?? {}) } });
    },
  };
  return { logger, calls };
}

describe('Phase 6 — Fix #18 log rate-limiting (createLogThrottle behavior)', () => {
  // ---------------------------------------------------------------------
  // (a) within-window suppression + post-window re-emit
  // ---------------------------------------------------------------------
  describe('(a) within-window suppression + post-window re-emit', () => {
    it('first call emits exactly one logger.error', () => {
      const { logger, calls } = makeRecorder();
      const t = 1_000_000;
      const log = createLogThrottle({ now: () => t, logger });

      log('redis_down', '[RateLimit] Redis error', { foo: 'bar' });

      expect(calls).toHaveLength(1);
      expect(calls[0].message).toBe('[RateLimit] Redis error');
      expect(calls[0].meta).toMatchObject({
        foo: 'bar',
        throttleKey: 'redis_down',
        suppressedCount: 0,
        throttleWindowMs: 10_000,
      });
    });

    it('second call within window does NOT call logger.error', () => {
      const { logger, calls } = makeRecorder();
      let t = 1_000_000;
      const log = createLogThrottle({ now: () => t, logger });

      log('redis_down', 'msg', {});
      t += 5_000; // halfway through default 10s window
      log('redis_down', 'msg', {});

      expect(calls).toHaveLength(1);
    });

    it('call after windowMs elapses re-emits with suppressedCount=N', () => {
      const { logger, calls } = makeRecorder();
      let t = 1_000_000;
      const log = createLogThrottle({ now: () => t, logger });

      log('redis_down', 'msg', {}); // emit #1
      t += 1_000;
      log('redis_down', 'msg', {}); // suppressed
      t += 1_000;
      log('redis_down', 'msg', {}); // suppressed
      t += 1_000;
      log('redis_down', 'msg', {}); // suppressed
      t += 10_001; // past window
      log('redis_down', 'msg', {}); // emit #2 with suppressedCount=3

      expect(calls).toHaveLength(2);
      expect(calls[1].meta.suppressedCount).toBe(3);
    });

    it('respects per-call windowMs override (custom window)', () => {
      const { logger, calls } = makeRecorder();
      let t = 1_000_000;
      const log = createLogThrottle({ now: () => t, logger });

      log('k', 'msg', {}, 500);
      t += 100;
      log('k', 'msg', {}, 500); // suppressed (within 500ms)
      t += 500; // now at +600 → past 500ms window
      log('k', 'msg', {}, 500); // emit #2

      expect(calls).toHaveLength(2);
      expect(calls[1].meta.suppressedCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------
  // (b) keys throttled independently
  // ---------------------------------------------------------------------
  describe('(b) different keys throttled independently', () => {
    it('two distinct keys both emit at t=0', () => {
      const { logger, calls } = makeRecorder();
      const log = createLogThrottle({ now: () => 1_000_000, logger });

      log('redis_down', 'redis msg', {});
      log('db_down', 'db msg', {});

      expect(calls).toHaveLength(2);
      expect(calls[0].meta.throttleKey).toBe('redis_down');
      expect(calls[1].meta.throttleKey).toBe('db_down');
    });

    it('suppression on one key does NOT affect another key', () => {
      const { logger, calls } = makeRecorder();
      let t = 1_000_000;
      const log = createLogThrottle({ now: () => t, logger });

      log('a', 'msg', {});
      log('b', 'msg', {});
      t += 1_000;
      log('a', 'msg', {}); // suppressed
      log('b', 'msg', {}); // suppressed

      expect(calls).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------
  // (c) factory instances are isolated
  // ---------------------------------------------------------------------
  describe('(c) factory instances do not share state', () => {
    it('emitting on instance #1 does not suppress immediate emit on instance #2', () => {
      const rec1 = makeRecorder();
      const rec2 = makeRecorder();
      const t = 1_000_000;
      const log1 = createLogThrottle({ now: () => t, logger: rec1.logger });
      const log2 = createLogThrottle({ now: () => t, logger: rec2.logger });

      log1('redis_down', 'msg', {});
      log2('redis_down', 'msg', {});

      expect(rec1.calls).toHaveLength(1);
      expect(rec2.calls).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------
  // (d) suppressedCount math is exact
  // ---------------------------------------------------------------------
  describe('(d) suppressedCount is exact across multiple windows', () => {
    it('counter resets to zero after each emit', () => {
      const { logger, calls } = makeRecorder();
      let t = 1_000_000;
      const log = createLogThrottle({ now: () => t, logger });

      // Window 1: 1 emit + 5 suppressed
      log('k', 'msg', {});
      for (let i = 0; i < 5; i++) {
        t += 100;
        log('k', 'msg', {});
      }
      // Cross window
      t += 10_001;
      log('k', 'msg', {}); // emit #2 with suppressedCount=5
      // Window 2: 0 suppressed
      t += 10_001;
      log('k', 'msg', {}); // emit #3 with suppressedCount=0

      expect(calls).toHaveLength(3);
      expect(calls[0].meta.suppressedCount).toBe(0);
      expect(calls[1].meta.suppressedCount).toBe(5);
      expect(calls[2].meta.suppressedCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // (e) dynamic-key OOM guard (MAX_KEYS=256, dev-throw branch in test env)
  // ---------------------------------------------------------------------
  describe('(e) MAX_KEYS dynamic-key OOM guard', () => {
    it('throws in test NODE_ENV when distinct keys exceed MAX_KEYS=256', () => {
      const { logger } = makeRecorder();
      const log = createLogThrottle({ now: () => 1_000_000, logger });

      // NODE_ENV is 'test' under Jest by default → opt-in dev-throw fires.
      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';
      try {
        for (let i = 0; i < 256; i++) {
          log(`dyn_${i}`, 'msg', {});
        }
        expect(() => log('dyn_overflow', 'msg', {})).toThrow(
          /too many distinct keys/i,
        );
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    });

    it('does NOT throw in production NODE_ENV when MAX_KEYS exceeded', () => {
      const { logger } = makeRecorder();
      const log = createLogThrottle({ now: () => 1_000_000, logger });

      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        for (let i = 0; i < 256; i++) {
          log(`dyn_${i}`, 'msg', {});
        }
        // Should NOT throw; emits log for new key (after evicting oldest).
        expect(() => log('dyn_overflow', 'msg', {})).not.toThrow();
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    });

    it('does NOT throw when NODE_ENV is undefined (unset ECS misconfig path)', () => {
      const { logger } = makeRecorder();
      const log = createLogThrottle({ now: () => 1_000_000, logger });

      const prevEnv = process.env.NODE_ENV;
      delete process.env.NODE_ENV;
      try {
        for (let i = 0; i < 256; i++) {
          log(`dyn_${i}`, 'msg', {});
        }
        expect(() => log('dyn_overflow', 'msg', {})).not.toThrow();
      } finally {
        if (prevEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = prevEnv;
        }
      }
    });
  });
});

// ===========================================================================
// Caller-wire-up coverage — assert all 5 flood sites in the doc actually
// import + invoke logErrorThrottled at HEAD. Source-string assertions: cheap
// regression guard so a future refactor cannot silently revert the swap.
// ===========================================================================
const TRANSPORTER_RL_PATH = join(
  __dirname,
  '..',
  'shared',
  'middleware',
  'transporter-rate-limit.middleware.ts',
);
const AUTH_PATH = join(__dirname, '..', 'shared', 'middleware', 'auth.middleware.ts');
const RL_PATH = join(__dirname, '..', 'shared', 'middleware', 'rate-limiter.middleware.ts');

describe('Phase 6 — Fix #18 wire-up: 5 flood call sites', () => {
  it('transporter-rate-limit.middleware.ts uses logErrorThrottled with ratelimit_redis_down key', () => {
    const src = readFileSync(TRANSPORTER_RL_PATH, 'utf8');
    expect(src).toMatch(/import\s*{\s*logErrorThrottled\s*}\s*from\s*['"]\.\.\/utils\/log-throttle['"]/);
    expect(src).toMatch(/logErrorThrottled\(\s*['"]ratelimit_redis_down['"]/);
  });

  it('auth.middleware.ts uses logErrorThrottled with auth_redis_unavailable key (twice — both fail-closed sites)', () => {
    const src = readFileSync(AUTH_PATH, 'utf8');
    expect(src).toMatch(/import\s*{\s*logErrorThrottled\s*}\s*from\s*['"]\.\.\/utils\/log-throttle['"]/);
    const matches = src.match(/logErrorThrottled\(\s*['"]auth_redis_unavailable['"]/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('rate-limiter.middleware.ts uses logErrorThrottled with rate_limiter_redis_failopen key (3 emitters)', () => {
    const src = readFileSync(RL_PATH, 'utf8');
    expect(src).toMatch(/import\s*{\s*logErrorThrottled\s*}\s*from\s*['"]\.\.\/utils\/log-throttle['"]/);
    const matches = src.match(/logErrorThrottled\(\s*['"]rate_limiter_redis_failopen['"]/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});
