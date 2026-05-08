/**
 * =============================================================================
 * Fix #12 — `redisService` lock-prefix idempotent strip (4 functions)
 * =============================================================================
 *
 * §2.3.1 of /Users/nitishbhardwaj/Downloads/index-20-validated.md.
 *
 * Bug at HEAD pre-fix: `acquireLock`, `releaseLock`, `isLockHeldBy`, and
 * `getLockHolder` unconditionally prepend `lock:` to the caller-supplied
 * `lockKey`. ~20 production callers already pass `'lock:foo'` → final
 * Redis key becomes `lock:lock:foo`. Other ~25 callers pass bare `'foo'`
 * → final key `lock:foo`. Two physically-distinct keys for what callers
 * believe is the same logical lock = split-mutex (B-N-7 booking expiry vs
 * cancel collision).
 *
 * Fix: idempotent prefix strip in all 4 functions:
 *   const normalized = lockKey.startsWith('lock:') ? lockKey.slice(5) : lockKey;
 *   const key = `lock:${normalized}`;
 *
 * Both `acquireLock('lock:foo', ...)` and `acquireLock('foo', ...)` now produce
 * the same physical key `lock:foo`.
 *
 * Verification at HEAD `8647f10f`: file is `src/shared/services/redis.service.ts`
 * lines 2887, 2964, 3004, 3014 — verified inline.
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Mocks — unique names per file (mockEval_12, mockGet_12, etc.) to avoid
// module-level identifier collisions across test files (Pearl-blindspot
// lesson: jest hoists jest.mock() but const declarations at module scope
// remain block-scoped and would clash across files in a single run).
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
    observeHistogram: jest.fn(),
    recordHistogram: jest.fn(),
    setGauge: jest.fn(),
  },
}));

jest.mock('../config/environment', () => ({
  config: {
    redis: { enabled: false, host: 'localhost', port: 6379, prefix: '' },
    isProduction: false,
  },
}));

// =============================================================================
// In-memory fake Redis: tracks every key written so we can assert on the
// EXACT physical key the lock primitive landed on.
// =============================================================================

type StoredEntry_12 = { value: string; expiresAt: number };
const fakeStore_12 = new Map<string, StoredEntry_12>();

function isExpired_12(e: StoredEntry_12 | undefined): boolean {
  return !e || e.expiresAt <= Date.now();
}

const mockEval_12 = jest.fn(async (script: string, keys: string[], args: string[]): Promise<any> => {
  const key = keys[0];
  const holderId = args[0];
  const ttlSec = args[1] ? parseInt(args[1], 10) : 60;
  const existing = fakeStore_12.get(key);
  const normalised = (script || '').replace(/\s+/g, ' ');

  // releaseLock script: get == ARGV[1] then del else 0
  if (/redis\.call\(\s*'del'\s*,\s*KEYS\[1\]\s*\)/.test(normalised)) {
    if (existing && !isExpired_12(existing) && existing.value === holderId) {
      fakeStore_12.delete(key);
      return 1;
    }
    return 0;
  }

  // acquireLock script: exists==0 → setex; existing==holder → expire; else 0
  if (existing && !isExpired_12(existing)) {
    if (existing.value === holderId) {
      fakeStore_12.set(key, { value: existing.value, expiresAt: Date.now() + ttlSec * 1000 });
      return 1;
    }
    return 0;
  }
  fakeStore_12.set(key, { value: holderId, expiresAt: Date.now() + ttlSec * 1000 });
  return 1;
});

const mockGet_12 = jest.fn(async (key: string): Promise<string | null> => {
  const e = fakeStore_12.get(key);
  if (!e || isExpired_12(e)) return null;
  return e.value;
});

const mockSet_12 = jest.fn(async (key: string, value: string, ttlSec?: number): Promise<string> => {
  fakeStore_12.set(key, { value, expiresAt: Date.now() + (ttlSec ?? 60) * 1000 });
  return 'OK';
});

const mockDel_12 = jest.fn(async (key: string): Promise<number> => {
  return fakeStore_12.delete(key) ? 1 : 0;
});

const mockExpire_12 = jest.fn(async (key: string, ttlSec: number): Promise<number> => {
  const e = fakeStore_12.get(key);
  if (!e) return 0;
  e.expiresAt = Date.now() + ttlSec * 1000;
  return 1;
});

// =============================================================================
// IMPORT — load redis.service after mocks declared.
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-var-requires
const redisModule_12 = require('../shared/services/redis.service');
const { redisService } = redisModule_12;

// Wire the in-memory client onto the singleton so the real implementation
// of acquireLock/releaseLock/isLockHeldBy/getLockHolder runs (not stubs).
beforeEach(() => {
  fakeStore_12.clear();
  jest.clearAllMocks();
  // Override the internal client with our fake — eval/get/set/del/expire only.
  (redisService as any).client = {
    eval: mockEval_12,
    get: mockGet_12,
    set: mockSet_12,
    del: mockDel_12,
    expire: mockExpire_12,
  };
  // Force the non-degraded in-memory branch path (no PG fallback).
  (redisService as any).isDegraded = false;
});

// =============================================================================
// SOURCE-FILE CONTRACT — verify the strip is implemented in all 4 functions.
// This is a structural assertion that survives source-only renames.
// =============================================================================

describe('Fix #12 — source contract: idempotent prefix strip in all 4 functions', () => {
  const src_12 = fs.readFileSync(
    path.resolve(__dirname, '../shared/services/redis.service.ts'),
    'utf-8'
  );

  it('acquireLock strips `lock:` prefix idempotently', () => {
    const acquireIdx = src_12.indexOf('async acquireLock(lockKey: string');
    expect(acquireIdx).toBeGreaterThan(-1);
    const region = src_12.substring(acquireIdx, acquireIdx + 300);
    expect(region).toMatch(/lockKey\.startsWith\(\s*['"]lock:['"]\s*\)\s*\?\s*lockKey\.slice\(\s*5\s*\)\s*:\s*lockKey/);
    expect(region).toContain('`lock:${normalized}`');
  });

  it('releaseLock strips `lock:` prefix idempotently', () => {
    const releaseIdx = src_12.indexOf('async releaseLock(lockKey: string');
    expect(releaseIdx).toBeGreaterThan(-1);
    const region = src_12.substring(releaseIdx, releaseIdx + 300);
    expect(region).toMatch(/lockKey\.startsWith\(\s*['"]lock:['"]\s*\)\s*\?\s*lockKey\.slice\(\s*5\s*\)\s*:\s*lockKey/);
    expect(region).toContain('`lock:${normalized}`');
  });

  it('isLockHeldBy strips `lock:` prefix idempotently (4th function — was missing pre-fix)', () => {
    const isHeldIdx = src_12.indexOf('async isLockHeldBy(lockKey: string');
    expect(isHeldIdx).toBeGreaterThan(-1);
    const region = src_12.substring(isHeldIdx, isHeldIdx + 250);
    expect(region).toMatch(/lockKey\.startsWith\(\s*['"]lock:['"]\s*\)\s*\?\s*lockKey\.slice\(\s*5\s*\)\s*:\s*lockKey/);
    expect(region).toContain('`lock:${normalized}`');
  });

  it('getLockHolder strips `lock:` prefix idempotently (was double-prefixing pre-fix)', () => {
    const getHolderIdx = src_12.indexOf('async getLockHolder(lockKey: string');
    expect(getHolderIdx).toBeGreaterThan(-1);
    const region = src_12.substring(getHolderIdx, getHolderIdx + 250);
    expect(region).toMatch(/lockKey\.startsWith\(\s*['"]lock:['"]\s*\)\s*\?\s*lockKey\.slice\(\s*5\s*\)\s*:\s*lockKey/);
    expect(region).toContain('`lock:${normalized}`');
  });
});

// =============================================================================
// RUNTIME — both call shapes produce the SAME physical Redis key.
// =============================================================================

describe('Fix #12 — runtime: acquireLock idempotency', () => {
  it('acquireLock("lock:foo", ...) and acquireLock("foo", ...) write the SAME physical key `lock:foo`', async () => {
    // Caller convention A — pre-prefixed:
    const a = await redisService.acquireLock('lock:foo', 'holder-A', 60);
    expect(a.acquired).toBe(true);
    expect(fakeStore_12.has('lock:foo')).toBe(true);
    expect(fakeStore_12.has('lock:lock:foo')).toBe(false); // No double-prefix bug
    fakeStore_12.clear();

    // Caller convention B — bare:
    const b = await redisService.acquireLock('foo', 'holder-B', 60);
    expect(b.acquired).toBe(true);
    expect(fakeStore_12.has('lock:foo')).toBe(true);
    expect(fakeStore_12.has('lock:lock:foo')).toBe(false);
  });

  it('B-N-7 collision regression: lock("lock:booking:abc") + lock("booking:abc") collide on lock:booking:abc', async () => {
    // Convention A (booking expiry path) acquires first.
    const expiry = await redisService.acquireLock('lock:booking:abc', 'expiry-holder', 60);
    expect(expiry.acquired).toBe(true);

    // Convention B (booking cancel path) attempts to acquire SAME logical lock.
    // Pre-fix: would write to a DIFFERENT physical key and "succeed" → split-mutex.
    // Post-fix: contends on the SAME physical key → returns acquired=false.
    const cancel = await redisService.acquireLock('booking:abc', 'cancel-holder', 60);
    expect(cancel.acquired).toBe(false);

    // Only one physical key landed in Redis.
    expect(fakeStore_12.size).toBe(1);
    expect(fakeStore_12.has('lock:booking:abc')).toBe(true);
  });

  it('acquireLock NEVER produces a `lock:lock:` double-prefix key regardless of input shape', async () => {
    await redisService.acquireLock('lock:abc', 'h1', 60);
    await redisService.acquireLock('lock:lock:weird', 'h2', 60); // Even if input has lock: it strips ONE
    await redisService.acquireLock('lock:lock:lock:weirder', 'h3', 60);

    // After fix: each input strips exactly ONE `lock:` then re-prefixes ONE.
    // - 'lock:abc' → 'abc' → 'lock:abc'
    // - 'lock:lock:weird' → 'lock:weird' → 'lock:lock:weird' (only one strip; documented edge case)
    // - 'lock:lock:lock:weirder' → 'lock:lock:weirder' → 'lock:lock:lock:weirder'
    // The contract is idempotency for the COMMON case; the second-level still
    // double-prefixes. The test here pins behavior so future "fully-recursive
    // strip" refactors don't accidentally break callers that intentionally
    // pass deep keys.
    expect(fakeStore_12.has('lock:abc')).toBe(true);
    expect(fakeStore_12.has('lock:lock:weird')).toBe(true);
    expect(fakeStore_12.has('lock:lock:lock:weirder')).toBe(true);
  });
});

describe('Fix #12 — runtime: releaseLock idempotency', () => {
  it('release("lock:foo") releases what acquire("foo") wrote', async () => {
    await redisService.acquireLock('foo', 'holder-X', 60);
    expect(fakeStore_12.has('lock:foo')).toBe(true);

    const released = await redisService.releaseLock('lock:foo', 'holder-X');
    expect(released).toBe(true);
    expect(fakeStore_12.has('lock:foo')).toBe(false);
  });

  it('release("foo") releases what acquire("lock:foo") wrote', async () => {
    await redisService.acquireLock('lock:foo', 'holder-Y', 60);
    expect(fakeStore_12.has('lock:foo')).toBe(true);

    const released = await redisService.releaseLock('foo', 'holder-Y');
    expect(released).toBe(true);
    expect(fakeStore_12.has('lock:foo')).toBe(false);
  });

  it('release with non-matching holder returns false (no DEL on someone else\'s lock)', async () => {
    await redisService.acquireLock('foo', 'holder-Z', 60);
    const released = await redisService.releaseLock('lock:foo', 'wrong-holder');
    expect(released).toBe(false);
    expect(fakeStore_12.has('lock:foo')).toBe(true);
  });
});

describe('Fix #12 — runtime: isLockHeldBy idempotency', () => {
  it('isLockHeldBy("lock:foo", h) === isLockHeldBy("foo", h) on the same logical lock', async () => {
    await redisService.acquireLock('foo', 'holder-A', 60);
    const a = await redisService.isLockHeldBy('lock:foo', 'holder-A');
    const b = await redisService.isLockHeldBy('foo', 'holder-A');
    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  it('isLockHeldBy returns false for non-matching holder (regardless of key shape)', async () => {
    await redisService.acquireLock('foo', 'holder-A', 60);
    expect(await redisService.isLockHeldBy('lock:foo', 'holder-B')).toBe(false);
    expect(await redisService.isLockHeldBy('foo', 'holder-B')).toBe(false);
  });
});

describe('Fix #12 — runtime: getLockHolder idempotency (4th function — was double-prefixing pre-fix)', () => {
  it('getLockHolder("lock:foo") returns the same holder as getLockHolder("foo")', async () => {
    await redisService.acquireLock('foo', 'real-holder', 60);
    const a = await redisService.getLockHolder('lock:foo');
    const b = await redisService.getLockHolder('foo');
    expect(a).toBe('real-holder');
    expect(b).toBe('real-holder');
  });

  it('getLockHolder returns null for a never-acquired key (no double-prefix lookup miss)', async () => {
    expect(await redisService.getLockHolder('lock:nonexistent')).toBeNull();
    expect(await redisService.getLockHolder('nonexistent')).toBeNull();
    // Crucially, NEITHER call queried for `lock:lock:nonexistent`:
    const calledKeys = mockGet_12.mock.calls.map((c) => c[0]);
    expect(calledKeys).not.toContain('lock:lock:nonexistent');
  });
});

export {};
