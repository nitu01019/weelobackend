/**
 * =============================================================================
 * SMART TIMEOUT CRITICAL FIXES — C-05 & C-06 Verification Tests
 * =============================================================================
 *
 * C-06: `||` changed to `&&` in checkAndMarkExpired()
 *   - Order with recent progress should NOT be expired
 *   - Order without recent progress AND past threshold SHOULD be expired
 *   - Order with recent progress AND past threshold should NOT be expired
 *
 * C-05: Swallowed DB failure in initializeOrderTimeout()
 *   - DB failure returns { success: false }
 *   - DB success returns { success: true, expiresAt: Date }
 *
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — Must precede all imports
// =============================================================================

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
  },
}));

jest.mock('../config/environment', () => ({
  config: { redis: { enabled: true }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {} },
}));

// ----- Redis mock -----
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisSetJSON = jest.fn();
const mockRedisGetJSON = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    getJSON: (...args: any[]) => mockRedisGetJSON(...args),
    setJSON: (...args: any[]) => mockRedisSetJSON(...args),
    exists: jest.fn().mockResolvedValue(false),
    isConnected: jest.fn().mockReturnValue(true),
    getExpiredTimers: jest.fn().mockResolvedValue([]),
    setTimer: jest.fn().mockResolvedValue(undefined),
    cancelTimer: jest.fn().mockResolvedValue(undefined),
    sAdd: jest.fn().mockResolvedValue(undefined),
    sMembers: jest.fn().mockResolvedValue([]),
    expire: jest.fn().mockResolvedValue(undefined),
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
  },
}));

// ----- Prisma mock -----
const mockOrderTimeoutCreate = jest.fn();
const mockOrderTimeoutFindUnique = jest.fn();
const mockOrderTimeoutFindMany = jest.fn();
const mockOrderTimeoutUpdate = jest.fn();
const mockOrderUpdate = jest.fn();
const mockProgressEventFindFirst = jest.fn();
const mockProgressEventCreate = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    orderTimeout: {
      create: (...args: any[]) => mockOrderTimeoutCreate(...args),
      findUnique: (...args: any[]) => mockOrderTimeoutFindUnique(...args),
      findMany: (...args: any[]) => mockOrderTimeoutFindMany(...args),
      update: (...args: any[]) => mockOrderTimeoutUpdate(...args),
    },
    order: {
      findUnique: jest.fn(),
      update: (...args: any[]) => mockOrderUpdate(...args),
    },
    progressEvent: {
      findFirst: (...args: any[]) => mockProgressEventFindFirst(...args),
      findMany: jest.fn().mockResolvedValue([]),
      create: (...args: any[]) => mockProgressEventCreate(...args),
    },
  },
  TimeoutExtensionType: {
    FIRST_DRIVER: 'first_driver',
    SUBSEQUENT: 'subsequent',
  },
  OrderStatus: {
    expired: 'expired',
    searching: 'searching',
    fully_filled: 'fully_filled',
    cancelled: 'cancelled',
    completed: 'completed',
  },
}));

// ----- Socket mock -----
jest.mock('../shared/services/socket.service', () => ({
  socketService: {
    emitToUser: jest.fn(),
    emitToOrder: jest.fn(),
  },
}));

// ----- Queue service mock -----
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    add: jest.fn().mockResolvedValue('job-id-123'),
    registerProcessor: jest.fn(),
    getStats: jest.fn().mockResolvedValue({ queues: [] }),
  },
  QueueJob: {},
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { smartTimeoutService } from '../modules/order-timeout/smart-timeout.service';

// =============================================================================
// HELPERS
// =============================================================================

// The singleton uses env vars with defaults: 120/60/30/120 — matches test expectations.

function makeOrderTimeout(overrides: Record<string, any> = {}) {
  const now = new Date();
  return {
    orderId: overrides.orderId || 'order-001',
    baseTimeoutMs: overrides.baseTimeoutMs ?? 120000,
    extendedMs: overrides.extendedMs ?? 0,
    lastProgressAt: overrides.lastProgressAt ?? now,
    expiresAt: overrides.expiresAt ?? new Date(now.getTime() - 60000), // Default: expired 60s ago
    isExpired: overrides.isExpired ?? false,
    expiredAt: overrides.expiredAt ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

beforeEach(() => {
  jest.clearAllMocks();
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue(undefined);
  mockRedisDel.mockResolvedValue(undefined);
  mockRedisSetJSON.mockResolvedValue(undefined);
  mockRedisGetJSON.mockResolvedValue(null);
});

// =============================================================================
// C-06: `||` changed to `&&` in checkAndMarkExpired()
// =============================================================================

describe('C-06: checkAndMarkExpired() — && logic (not ||)', () => {

  it('C-06-1: order with recent progress should NOT be expired', async () => {
    const now = new Date();
    // Order expired 10s ago (past expiresAt)
    const orderTimeout = makeOrderTimeout({
      orderId: 'order-with-progress',
      expiresAt: new Date(now.getTime() - 10_000),
    });

    // findMany returns this order as a candidate (expiresAt < now, isExpired = false)
    mockOrderTimeoutFindMany.mockResolvedValue([orderTimeout]);

    // There IS recent progress (within the noProgressTimeoutSeconds window)
    const recentProgressEvent = {
      id: 'progress-001',
      orderId: 'order-with-progress',
      driverId: 'driver-001',
      timestamp: new Date(now.getTime() - 30_000), // 30s ago, within 120s threshold
    };
    mockProgressEventFindFirst.mockResolvedValue(recentProgressEvent);

    const markedCount = await smartTimeoutService.checkAndMarkExpired();

    // With && logic: recentProgress exists, so (!recentProgress && ...) is false.
    // Order should NOT be expired.
    expect(markedCount).toBe(0);
    expect(mockOrderTimeoutUpdate).not.toHaveBeenCalled();
    expect(mockOrderUpdate).not.toHaveBeenCalled();
  });

  it('C-06-2: order without recent progress AND past threshold SHOULD be expired', async () => {
    const now = new Date();
    // Order expired 3 minutes ago — well past the noProgressTimeoutSeconds (120s)
    const expiresAt = new Date(now.getTime() - 180_000);
    const orderTimeout = makeOrderTimeout({
      orderId: 'order-stale',
      expiresAt,
    });

    mockOrderTimeoutFindMany.mockResolvedValue([orderTimeout]);

    // No recent progress at all
    mockProgressEventFindFirst.mockResolvedValue(null);

    // Allow the update calls
    mockOrderTimeoutUpdate.mockResolvedValue({ ...orderTimeout, isExpired: true });
    mockOrderUpdate.mockResolvedValue({ id: 'order-stale', status: 'expired' });

    const markedCount = await smartTimeoutService.checkAndMarkExpired();

    // With && logic: !recentProgress is true, and expiresAt (3min ago) < noProgressThreshold (2min ago) is true.
    // Both conditions met, so order IS expired.
    expect(markedCount).toBe(1);
    expect(mockOrderTimeoutUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: 'order-stale' },
        data: expect.objectContaining({ isExpired: true }),
      })
    );
    expect(mockOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-stale' },
        data: { status: 'expired' },
      })
    );
  });

  it('C-06-3: order with recent progress AND past threshold should NOT be expired', async () => {
    const now = new Date();
    // Order expired 3 minutes ago — past the noProgressThreshold
    const expiresAt = new Date(now.getTime() - 180_000);
    const orderTimeout = makeOrderTimeout({
      orderId: 'order-active-progress',
      expiresAt,
    });

    mockOrderTimeoutFindMany.mockResolvedValue([orderTimeout]);

    // There IS recent progress (driver accepted 30s ago, well within 120s window)
    const recentProgressEvent = {
      id: 'progress-002',
      orderId: 'order-active-progress',
      driverId: 'driver-002',
      timestamp: new Date(now.getTime() - 30_000),
    };
    mockProgressEventFindFirst.mockResolvedValue(recentProgressEvent);

    const markedCount = await smartTimeoutService.checkAndMarkExpired();

    // With && logic: recentProgress exists, so !recentProgress is false.
    // Even though expiresAt < noProgressThreshold is true, && short-circuits.
    // This is the critical fix: with || this order WOULD have been killed.
    expect(markedCount).toBe(0);
    expect(mockOrderTimeoutUpdate).not.toHaveBeenCalled();
    expect(mockOrderUpdate).not.toHaveBeenCalled();
  });

  it('C-06-4: order barely past expiresAt but within noProgressThreshold is NOT expired even without progress', async () => {
    const now = new Date();
    // Order expired just 10s ago — NOT past noProgressThreshold (120s)
    const expiresAt = new Date(now.getTime() - 10_000);
    const orderTimeout = makeOrderTimeout({
      orderId: 'order-barely-expired',
      expiresAt,
    });

    mockOrderTimeoutFindMany.mockResolvedValue([orderTimeout]);

    // No recent progress
    mockProgressEventFindFirst.mockResolvedValue(null);

    const markedCount = await smartTimeoutService.checkAndMarkExpired();

    // !recentProgress is true, but expiresAt (10s ago) < noProgressThreshold (120s ago) is FALSE
    // because 10s ago is AFTER 120s ago (more recent).
    // So the && fails and order is spared.
    expect(markedCount).toBe(0);
    expect(mockOrderTimeoutUpdate).not.toHaveBeenCalled();
  });

  it('C-06-5: multiple orders — only those meeting both conditions are expired', async () => {
    const now = new Date();

    // Order A: no progress, well past threshold — should expire
    const orderA = makeOrderTimeout({
      orderId: 'order-A',
      expiresAt: new Date(now.getTime() - 200_000),
    });

    // Order B: has recent progress — should NOT expire
    const orderB = makeOrderTimeout({
      orderId: 'order-B',
      expiresAt: new Date(now.getTime() - 200_000),
    });

    mockOrderTimeoutFindMany.mockResolvedValue([orderA, orderB]);

    // Order A: no progress, Order B: has progress
    mockProgressEventFindFirst
      .mockResolvedValueOnce(null) // order-A: no progress
      .mockResolvedValueOnce({     // order-B: has progress
        id: 'progress-B',
        orderId: 'order-B',
        driverId: 'driver-B',
        timestamp: new Date(now.getTime() - 30_000),
      });

    mockOrderTimeoutUpdate.mockResolvedValue({});
    mockOrderUpdate.mockResolvedValue({});

    const markedCount = await smartTimeoutService.checkAndMarkExpired();

    // Only order A should be expired
    expect(markedCount).toBe(1);
    expect(mockOrderTimeoutUpdate).toHaveBeenCalledTimes(1);
    expect(mockOrderTimeoutUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: 'order-A' },
      })
    );
  });

  it('C-06-6: checkAndMarkExpired returns 0 when no orders are candidates', async () => {
    mockOrderTimeoutFindMany.mockResolvedValue([]);

    const markedCount = await smartTimeoutService.checkAndMarkExpired();

    expect(markedCount).toBe(0);
    expect(mockProgressEventFindFirst).not.toHaveBeenCalled();
    expect(mockOrderTimeoutUpdate).not.toHaveBeenCalled();
  });

  it('C-06-7: DB error in checkAndMarkExpired returns 0 (graceful failure)', async () => {
    mockOrderTimeoutFindMany.mockRejectedValue(new Error('DB connection lost'));

    const markedCount = await smartTimeoutService.checkAndMarkExpired();

    expect(markedCount).toBe(0);
  });
});

// =============================================================================
// C-05: initializeOrderTimeout() — DB failure returns { success: false }
// =============================================================================

describe('C-05: initializeOrderTimeout() — fail-closed on DB error', () => {

  it('C-05-1: DB failure returns { success: false }', async () => {
    // Simulate prisma create throwing
    mockOrderTimeoutCreate.mockRejectedValue(new Error('unique constraint violated'));

    const result = await smartTimeoutService.initializeOrderTimeout('order-fail', 3);

    expect(result.success).toBe(false);
    expect(result.expiresAt).toBeUndefined();
  });

  it('C-05-2: DB success returns { success: true, expiresAt: Date }', async () => {
    const now = new Date();
    const expectedExpiresAt = new Date(now.getTime() + 120_000);

    mockOrderTimeoutCreate.mockResolvedValue({
      orderId: 'order-ok',
      baseTimeoutMs: 120000,
      extendedMs: 0,
      lastProgressAt: now,
      expiresAt: expectedExpiresAt,
      isExpired: false,
      createdAt: now,
      updatedAt: now,
    });

    // Redis calls for caching state and setting extension count
    mockRedisSetJSON.mockResolvedValue(undefined);
    mockRedisSet.mockResolvedValue(undefined);

    const result = await smartTimeoutService.initializeOrderTimeout('order-ok', 3);

    expect(result.success).toBe(true);
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.expiresAt!.getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it('C-05-3: DB timeout error returns { success: false }', async () => {
    mockOrderTimeoutCreate.mockRejectedValue(new Error('Query timeout after 30000ms'));

    const result = await smartTimeoutService.initializeOrderTimeout('order-timeout-err', 5);

    expect(result.success).toBe(false);
    expect(result.expiresAt).toBeUndefined();
  });

  it('C-05-4: DB connection refused returns { success: false }', async () => {
    mockOrderTimeoutCreate.mockRejectedValue(new Error('Connection refused'));

    const result = await smartTimeoutService.initializeOrderTimeout('order-conn-err', 2);

    expect(result.success).toBe(false);
    expect(result.expiresAt).toBeUndefined();
  });

  it('C-05-5: successful initialization caches state in Redis', async () => {
    mockOrderTimeoutCreate.mockResolvedValue({
      orderId: 'order-cache-test',
      baseTimeoutMs: 120000,
      extendedMs: 0,
      lastProgressAt: new Date(),
      expiresAt: new Date(Date.now() + 120000),
      isExpired: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await smartTimeoutService.initializeOrderTimeout('order-cache-test', 3);

    // Verify Redis state caching was called (setJSON for timeout state)
    expect(mockRedisSetJSON).toHaveBeenCalledWith(
      'order-timeout:order-cache-test:state',
      expect.objectContaining({
        orderId: 'order-cache-test',
        isExpired: false,
        extensionCount: 0,
      }),
      expect.any(Number),
    );
  });

  it('C-05-6: successful initialization sets extension count to 0', async () => {
    mockOrderTimeoutCreate.mockResolvedValue({
      orderId: 'order-ext-count',
      baseTimeoutMs: 120000,
      extendedMs: 0,
      lastProgressAt: new Date(),
      expiresAt: new Date(Date.now() + 120000),
      isExpired: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await smartTimeoutService.initializeOrderTimeout('order-ext-count', 3);

    // Verify extension count set to 0 in Redis
    expect(mockRedisSet).toHaveBeenCalledWith(
      'order:ext:count:order-ext-count',
      '0',
      3600, // 1 hour TTL
    );
  });

  it('C-05-7: failed initialization does NOT cache state or set extension count', async () => {
    mockOrderTimeoutCreate.mockRejectedValue(new Error('DB down'));

    await smartTimeoutService.initializeOrderTimeout('order-no-cache', 3);

    // Redis caching should NOT have been called
    expect(mockRedisSetJSON).not.toHaveBeenCalled();
    // Extension count should NOT have been set
    expect(mockRedisSet).not.toHaveBeenCalledWith(
      'order:ext:count:order-no-cache',
      expect.any(String),
      expect.any(Number),
    );
  });

  it('C-05-8: error is logged when DB fails', async () => {
    const { logger } = require('../shared/services/logger.service');
    mockOrderTimeoutCreate.mockRejectedValue(new Error('Disk full'));

    await smartTimeoutService.initializeOrderTimeout('order-log-test', 3);

    expect(logger.error).toHaveBeenCalledWith(
      '[SMART TIMEOUT] Failed to initialize order timeout',
      expect.objectContaining({
        error: 'Disk full',
        orderId: 'order-log-test',
      }),
    );
  });
});
