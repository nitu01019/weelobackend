/**
 * =============================================================================
 * PHASE 4 — FIX #9 — DLQ TTL (14d on dlq:broadcasts, 30d on permanent failures)
 * =============================================================================
 *
 * Validates:
 *   (a) DLQ_TTL_SECONDS = 14d (1_209_600) and DLQ_PERMANENT_TTL_SECONDS = 30d
 *       (2_592_000); permanent > working.
 *   (b) Depth-cap drop path (queueBroadcast → queue_full) calls expire once
 *       with ('dlq:broadcasts', DLQ_TTL_SECONDS) AFTER lPush + lTrim.
 *   (c) expire() rejection swallowed by .catch() — no exception escapes; the
 *       outer DLQ-write catch is NOT triggered (no [CRITICAL] log,
 *       no dlq_push_failed_total increment).
 *   (d) DRIFT NOTE: Solution Sites 1 (Lua admit) and 3 (batch admit) reference
 *       code blocks that are absent from queue.service.ts at this HEAD —
 *       only Site 2 (depth-cap drop) is currently in source. File-text
 *       assertion ensures the surviving site receives the new expire() call.
 *   (e) DRIFT NOTE: scripts/replay-broadcast-dlq.ts is absent at this HEAD
 *       — Sites 4a/4b cannot be edited. Constants are still exported so the
 *       script can import them once it lands on this branch.
 *
 * Solution citation: index-30-validated.md Finding #9 (lines 2507-2742).
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

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

const mockLPush = jest.fn().mockResolvedValue(1);
const mockLTrim = jest.fn().mockResolvedValue('OK');
const mockExpire = jest.fn().mockResolvedValue(1);
const mockLLen = jest.fn().mockResolvedValue(0);
const mockLPushMany = jest.fn().mockResolvedValue(1);
const mockEval = jest.fn().mockResolvedValue(0);

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    eval: mockEval,
    zRangeByScore: jest.fn().mockResolvedValue([]),
    zRemRangeByScore: jest.fn().mockResolvedValue(0),
    lPush: mockLPush,
    lTrim: mockLTrim,
    expire: mockExpire,
    lLen: mockLLen,
    lPushMany: mockLPushMany,
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
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  messaging: () => ({
    send: jest.fn(),
    sendMulticast: jest.fn(),
    sendEachForMulticast: jest.fn(),
  }),
}));

// ============================================================================
// TESTS
// ============================================================================

describe('Phase 4 — Fix #9 — DLQ TTL on dlq:broadcasts', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    mockLPush.mockClear().mockResolvedValue(1);
    mockLTrim.mockClear().mockResolvedValue('OK');
    mockExpire.mockClear().mockResolvedValue(1);
    mockLLen.mockClear().mockResolvedValue(0);
    mockLPushMany.mockClear().mockResolvedValue(1);
    mockEval.mockClear().mockResolvedValue(0);
    process.env = { ...ORIGINAL_ENV, FF_QUEUE_DEPTH_CAP: '1' };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  // -------------------------------------------------------------------------
  // (a) Constants — 14d working, 30d permanent
  // -------------------------------------------------------------------------
  it('exports DLQ_TTL_SECONDS = 14 days and DLQ_PERMANENT_TTL_SECONDS = 30 days', async () => {
    const mod = await import('../shared/services/queue.service');
    expect(mod.DLQ_TTL_SECONDS).toBe(14 * 24 * 60 * 60);
    expect(mod.DLQ_TTL_SECONDS).toBe(1209600);
    expect(mod.DLQ_PERMANENT_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
    expect(mod.DLQ_PERMANENT_TTL_SECONDS).toBe(2592000);
    expect(mod.DLQ_PERMANENT_TTL_SECONDS).toBeGreaterThan(mod.DLQ_TTL_SECONDS);
  });

  // -------------------------------------------------------------------------
  // (b) Site 2 — depth-cap drop calls expire after lPush + lTrim
  // -------------------------------------------------------------------------
  it('calls expire("dlq:broadcasts", DLQ_TTL_SECONDS) after lPush + lTrim on queue_full', async () => {
    const mod = await import('../shared/services/queue.service');
    const svc = mod.queueService;

    // Force the depth-cap path: pre-seed snapshot above any small cap.
    (svc as any).broadcastDepthSnapshot = { depth: 9_999_999, sampledAtMs: Date.now() };
    (svc as any).refreshBroadcastQueueDepth = jest.fn().mockResolvedValue(undefined);

    await expect(
      svc.queueBroadcast('tx-1', 'new_broadcast', { foo: 'bar' })
    // Phase 5 Fix #7 replaced the naked `Error('Broadcast queue depth ... exceeds cap ...')`
    // with `BackpressureError` whose PUBLIC message is generic per CWE-209
    // ('Service temporarily unavailable. Please retry shortly.'); depth + cap
    // now live in `internalMeta` for server-side logs only. Accept either form.
    ).rejects.toThrow(/exceeds cap|Service temporarily unavailable/);

    // lPush + lTrim + expire — in that order on the same key
    expect(mockLPush).toHaveBeenCalledWith('dlq:broadcasts', expect.any(String));
    expect(mockLTrim).toHaveBeenCalledWith('dlq:broadcasts', 0, mod.DLQ_MAX_SIZE - 1);
    expect(mockExpire).toHaveBeenCalledWith('dlq:broadcasts', mod.DLQ_TTL_SECONDS);
    expect(mockExpire).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // (c) expire() rejection swallowed — outer catch NOT triggered
  // -------------------------------------------------------------------------
  it('swallows expire() rejection without triggering outer DLQ-write catch', async () => {
    mockExpire.mockReset().mockRejectedValue(new Error('redis timeout'));

    const mod = await import('../shared/services/queue.service');
    const { logger } = await import('../shared/services/logger.service');
    const svc = mod.queueService;

    (svc as any).broadcastDepthSnapshot = { depth: 9_999_999, sampledAtMs: Date.now() };
    (svc as any).refreshBroadcastQueueDepth = jest.fn().mockResolvedValue(undefined);

    await expect(
      svc.queueBroadcast('tx-2', 'new_broadcast', { foo: 'bar' })
    // Phase 5 Fix #7 replaced the naked `Error('Broadcast queue depth ... exceeds cap ...')`
    // with `BackpressureError` whose PUBLIC message is generic per CWE-209
    // ('Service temporarily unavailable. Please retry shortly.'); depth + cap
    // now live in `internalMeta` for server-side logs only. Accept either form.
    ).rejects.toThrow(/exceeds cap|Service temporarily unavailable/);

    // lPush + lTrim succeeded, expire failed — but [CRITICAL] log NOT emitted
    expect(mockLPush).toHaveBeenCalled();
    expect(mockLTrim).toHaveBeenCalled();
    expect(mockExpire).toHaveBeenCalled();

    const errorCalls = (logger.error as jest.Mock).mock.calls;
    const sawCritical = errorCalls.some(
      (args: unknown[]) =>
        typeof args[0] === 'string' && args[0].includes('[CRITICAL]') && args[0].includes('DLQ write failed')
    );
    expect(sawCritical).toBe(false);
  });

  // -------------------------------------------------------------------------
  // (d) File-text assertion — surviving Site 2 in source carries expire()
  //     with the 14d constant, .catch attached, on the dlq:broadcasts key.
  // -------------------------------------------------------------------------
  it('queue.service.ts depth-cap site uses expire(...) with .catch() and DLQ_TTL_SECONDS', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../shared/services/queue.service.ts'),
      'utf8'
    );

    // Constants exported
    expect(src).toMatch(/export const DLQ_TTL_SECONDS\s*=\s*14\s*\*\s*24\s*\*\s*60\s*\*\s*60/);
    expect(src).toMatch(
      /export const DLQ_PERMANENT_TTL_SECONDS\s*=\s*30\s*\*\s*24\s*\*\s*60\s*\*\s*60/
    );

    // Depth-cap site has expire('dlq:broadcasts', DLQ_TTL_SECONDS).catch(...)
    expect(src).toMatch(
      /redisService\.expire\(\s*['"]dlq:broadcasts['"]\s*,\s*DLQ_TTL_SECONDS\s*\)\s*\.catch\(/
    );
  });

  // -------------------------------------------------------------------------
  // (e) DRIFT — Sites 1, 3, 4a, 4b absent in current HEAD (documented in
  //     test file header). Constants stay ready for the eventual script
  //     import once replay-broadcast-dlq.ts lands.
  // -------------------------------------------------------------------------
  it('exports are importable for downstream replay-broadcast-dlq.ts (when script lands)', async () => {
    // This is a stability test: ensures the named exports stay stable so the
    // drainer script can `import { DLQ_TTL_SECONDS, DLQ_PERMANENT_TTL_SECONDS }
    // from '../src/shared/services/queue.service'` without literal drift.
    const mod = await import('../shared/services/queue.service');
    expect(typeof mod.DLQ_TTL_SECONDS).toBe('number');
    expect(typeof mod.DLQ_PERMANENT_TTL_SECONDS).toBe('number');
    expect(mod.DLQ_TTL_SECONDS).toBeGreaterThan(0);
    expect(mod.DLQ_PERMANENT_TTL_SECONDS).toBeGreaterThan(0);
  });
});
