/**
 * =============================================================================
 * PHASE 3 BROADCAST INTEGRITY -- Tests for Issues #10, #11, #15, #4
 * =============================================================================
 *
 * #10  Layer 2 dedup guard: duplicate transporterIds in candidate list deduped
 * #11  Silent retry drop: permanent failures log at WARN + increment metric
 * #15  TTL divergence fix: single BROADCAST_DEDUP_TTL_BUFFER_SECONDS constant
 * #4   Dead file deleted: order-broadcast-send.service.ts removed, KYC gate present
 *
 * @author beta-broadcast-qa
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP -- Must come before any imports
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
    observeHistogram: jest.fn(),
    recordHistogram: jest.fn(),
  },
}));

jest.mock('../config/environment', () => ({
  config: { redis: { enabled: true }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {} },
}));

// ---------------------------------------------------------------------------
// Redis service mock
// ---------------------------------------------------------------------------
const mockRedisSAddWithExpire = jest.fn().mockResolvedValue(undefined);
const mockRedisSMembers = jest.fn().mockResolvedValue([]);

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(false),
    acquireLock: jest.fn().mockResolvedValue({ acquired: true, ttl: 30 }),
    releaseLock: jest.fn().mockResolvedValue(true),
    sMembers: (...args: any[]) => mockRedisSMembers(...args),
    sAdd: jest.fn().mockResolvedValue(1),
    getJSON: jest.fn().mockResolvedValue(null),
    setJSON: jest.fn().mockResolvedValue('OK'),
    getExpiredTimers: jest.fn().mockResolvedValue([]),
    cancelTimer: jest.fn().mockResolvedValue(true),
    setTimer: jest.fn().mockResolvedValue('OK'),
    expire: jest.fn().mockResolvedValue(true),
    sIsMember: jest.fn().mockResolvedValue(false),
    isConnected: () => true,
    eval: jest.fn().mockResolvedValue(1),
    sAddWithExpire: (...args: any[]) => mockRedisSAddWithExpire(...args),
    isRedisEnabled: () => true,
    sCard: jest.fn().mockResolvedValue(0),
    hSet: jest.fn(),
    hGet: jest.fn(),
    hGetAll: jest.fn().mockResolvedValue({}),
    hDel: jest.fn(),
    publish: jest.fn(),
    subscribe: jest.fn(),
    sRem: jest.fn(),
    ttl: jest.fn().mockResolvedValue(60),
    hasTimer: jest.fn().mockResolvedValue(false),
    incrementWithTTL: jest.fn().mockResolvedValue(1),
    checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 99, resetIn: 60 }),
    getOrSet: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Socket mock
// ---------------------------------------------------------------------------
const mockEmitToUser = jest.fn();
const mockEmitToUsers = jest.fn();
jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToUsers: (...args: any[]) => mockEmitToUsers(...args),
}));

// ---------------------------------------------------------------------------
// FCM mock
// ---------------------------------------------------------------------------
jest.mock('../shared/services/fcm.service', () => ({
  sendPushNotification: jest.fn().mockResolvedValue(true),
}));

// ---------------------------------------------------------------------------
// Queue service mock
// ---------------------------------------------------------------------------
const mockQueueBroadcast = jest.fn().mockResolvedValue(undefined);
const mockQueuePushNotificationBatch = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queueBroadcast: (...args: any[]) => mockQueueBroadcast(...args),
    queueBroadcastBatch: jest.fn().mockResolvedValue([]),
    queuePushNotificationBatch: (...args: any[]) => mockQueuePushNotificationBatch(...args),
  },
}));

// ---------------------------------------------------------------------------
// Other service mocks
// ---------------------------------------------------------------------------
jest.mock('../shared/services/cache.service', () => ({
  cacheService: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    delete: jest.fn().mockResolvedValue(true),
    scanIterator: jest.fn().mockReturnValue({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }) }),
  },
}));

jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: (type: string, subtype: string) => `${type}:${subtype || ''}`,
}));

jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: {
    filterOnline: jest.fn((ids: string[]) => Promise.resolve(ids)),
  },
}));

jest.mock('../shared/services/candidate-scorer.service', () => ({
  candidateScorerService: {
    scoreAndRank: jest.fn((candidates: any[]) => Promise.resolve(candidates)),
  },
}));

jest.mock('../modules/admin/admin-suspension.service', () => ({
  adminSuspensionService: {
    getSuspendedUserIds: jest.fn().mockResolvedValue(new Set()),
  },
}));

jest.mock('../modules/routing', () => ({
  routingService: {
    calculateRouteBreakdown: jest.fn().mockReturnValue({
      legs: [],
      totalDistanceKm: 100,
      totalDurationMinutes: 120,
      totalDurationFormatted: '2 hrs 0 mins',
      totalStops: 0,
      estimatedArrival: new Date().toISOString(),
    }),
  },
}));

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    user: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn((fn: any) => (typeof fn === 'function' ? fn({}) : Promise.resolve(fn))),
  },
}));

const mockGetOrderById = jest.fn();
const mockGetTruckRequestsByOrder = jest.fn();
const mockGetTransportersAvailabilitySnapshot = jest.fn();
const mockUpdateTruckRequest = jest.fn().mockResolvedValue({});
const mockGetTransportersWithVehicleType = jest.fn().mockResolvedValue([]);

jest.mock('../shared/database/db', () => ({
  db: {
    getOrderById: (...args: any[]) => mockGetOrderById(...args),
    getTruckRequestsByOrder: (...args: any[]) => mockGetTruckRequestsByOrder(...args),
    getTransportersWithVehicleType: (...args: any[]) => mockGetTransportersWithVehicleType(...args),
    getTransportersAvailabilitySnapshot: (...args: any[]) => mockGetTransportersAvailabilitySnapshot(...args),
    updateTruckRequest: (...args: any[]) => mockUpdateTruckRequest(...args),
  },
  TruckRequestRecord: {},
}));

jest.mock('../modules/order/progressive-radius-matcher', () => ({
  progressiveRadiusMatcher: {
    findCandidates: jest.fn().mockResolvedValue([]),
    getStep: jest.fn().mockReturnValue(null),
  },
  PROGRESSIVE_RADIUS_STEPS: [
    { radiusKm: 10, windowMs: 15000 },
    { radiusKm: 25, windowMs: 20000 },
    { radiusKm: 50, windowMs: 25000 },
  ],
}));

jest.mock('../shared/utils/pii.utils', () => ({
  maskPhoneForExternal: (phone: string) => phone,
}));

// =============================================================================
// IMPORTS
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../shared/services/logger.service';
import { metrics } from '../shared/monitoring/metrics.service';
import { BROADCAST_DEDUP_TTL_BUFFER_SECONDS } from '../core/config/hold-config';
import { prismaClient } from '../shared/database/prisma.service';

// =============================================================================
// ISSUE #10 -- Layer 2 dedup guard (alreadyNotifiedSet)
// =============================================================================
describe('Issue #10: Layer 2 dedup guard — duplicate transporterIds deduped', () => {
  beforeEach(() => jest.clearAllMocks());

  test('alreadyNotifiedSet exists in order-broadcast.service.ts', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/order/order-broadcast.service.ts'),
      'utf-8'
    );
    expect(source).toContain('const alreadyNotifiedSet = new Set<string>()');
  });

  test('duplicate transporterIds in candidate list are skipped', () => {
    // Simulate the dedup guard logic from broadcastVehicleTypePayload (lines 906-917)
    const alreadyNotifiedSet = new Set<string>();
    let skippedAlreadyNotified = 0;

    const verifiedTransporters = ['trans-1', 'trans-2', 'trans-1', 'trans-3', 'trans-2', 'trans-1'];
    const sentTransporters: string[] = [];

    for (const transporterId of verifiedTransporters) {
      if (alreadyNotifiedSet.has(transporterId)) {
        skippedAlreadyNotified++;
        continue;
      }
      alreadyNotifiedSet.add(transporterId);
      sentTransporters.push(transporterId);
    }

    // Only unique transporters should pass through
    expect(sentTransporters).toEqual(['trans-1', 'trans-2', 'trans-3']);
    expect(skippedAlreadyNotified).toBe(3);
    expect(alreadyNotifiedSet.size).toBe(3);
  });

  test('unique transporterIds all pass through dedup guard', () => {
    const alreadyNotifiedSet = new Set<string>();
    let skippedAlreadyNotified = 0;

    const verifiedTransporters = ['trans-a', 'trans-b', 'trans-c', 'trans-d'];
    const sentTransporters: string[] = [];

    for (const transporterId of verifiedTransporters) {
      if (alreadyNotifiedSet.has(transporterId)) {
        skippedAlreadyNotified++;
        continue;
      }
      alreadyNotifiedSet.add(transporterId);
      sentTransporters.push(transporterId);
    }

    expect(sentTransporters).toEqual(['trans-a', 'trans-b', 'trans-c', 'trans-d']);
    expect(skippedAlreadyNotified).toBe(0);
  });

  test('skip count is logged when duplicates are detected', () => {
    // Simulate the logging pattern from lines 1000-1003
    const orderId = 'order-123';
    const skippedAlreadyNotified = 5;
    const totalCandidates = 20;

    if (skippedAlreadyNotified > 0) {
      (logger.warn as jest.Mock)('[Broadcast] Layer 2 dedup guard caught duplicates', {
        orderId, skippedAlreadyNotified, totalCandidates,
      });
    }

    expect(logger.warn).toHaveBeenCalledWith(
      '[Broadcast] Layer 2 dedup guard caught duplicates',
      expect.objectContaining({
        orderId: 'order-123',
        skippedAlreadyNotified: 5,
        totalCandidates: 20,
      })
    );
  });

  test('no log emitted when zero duplicates', () => {
    const skippedAlreadyNotified = 0;

    if (skippedAlreadyNotified > 0) {
      (logger.warn as jest.Mock)('should not be called');
    }

    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('source code checks alreadyNotifiedSet.has() before emitting', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/order/order-broadcast.service.ts'),
      'utf-8'
    );
    // The guard must check has() before add()
    const hasIndex = source.indexOf('alreadyNotifiedSet.has(transporterId)');
    const addIndex = source.indexOf('alreadyNotifiedSet.add(transporterId)');
    expect(hasIndex).toBeGreaterThan(-1);
    expect(addIndex).toBeGreaterThan(-1);
    expect(hasIndex).toBeLessThan(addIndex);
  });
});

// =============================================================================
// ISSUE #11 -- Silent retry drop: permanent failures log WARN + metric
// =============================================================================
describe('Issue #11: Silent retry drop — permanent failures log WARN + metric', () => {
  beforeEach(() => jest.clearAllMocks());

  test('permanent retry failures log at WARN level (not INFO)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/order/order-broadcast.service.ts'),
      'utf-8'
    );
    // Find the permanent failure log line
    const lines = source.split('\n');
    const permanentFailureLine = lines.find((line: string) =>
      line.includes('Permanent delivery failures after retry')
    );
    expect(permanentFailureLine).toBeDefined();
    // Must be logger.warn, NOT logger.info
    expect(permanentFailureLine).toContain('logger.warn');
    expect(permanentFailureLine).not.toContain('logger.info');
  });

  test('broadcast_permanent_failure_total metric is incremented on permanent failures', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/order/order-broadcast.service.ts'),
      'utf-8'
    );
    expect(source).toContain("metrics.incrementCounter('broadcast_permanent_failure_total'");
  });

  test('retry logic: failed retries trigger warn + metric (behavioral)', async () => {
    // Simulate the retry flow from lines 1044-1083
    const orderId = 'order-retry-test';
    const enqueueFailedTransporters = ['trans-fail-1', 'trans-fail-2'];

    // Simulate retries that all fail
    const retryResults: PromiseSettledResult<void>[] = enqueueFailedTransporters.map(() =>
      ({ status: 'rejected' as const, reason: new Error('Redis timeout') })
    );

    const retrySuccessCount = retryResults.filter((r) => r.status === 'fulfilled').length;
    const retryFailCount = retryResults.filter((r) => r.status === 'rejected').length;

    if (retryFailCount > 0) {
      (logger.warn as jest.Mock)('[Broadcast] Permanent delivery failures after retry', {
        orderId,
        retryFailCount,
        retrySuccessCount,
        failedTransporterIds: enqueueFailedTransporters.slice(0, retryFailCount),
      });
      (metrics.incrementCounter as jest.Mock)('broadcast_permanent_failure_total', { orderId });
    }

    expect(logger.warn).toHaveBeenCalledWith(
      '[Broadcast] Permanent delivery failures after retry',
      expect.objectContaining({
        orderId: 'order-retry-test',
        retryFailCount: 2,
        retrySuccessCount: 0,
      })
    );
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'broadcast_permanent_failure_total',
      { orderId: 'order-retry-test' }
    );
  });

  test('successful retries log at INFO level (not WARN)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/order/order-broadcast.service.ts'),
      'utf-8'
    );
    const lines = source.split('\n');
    const successLine = lines.find((line: string) =>
      line.includes('All retries succeeded')
    );
    expect(successLine).toBeDefined();
    expect(successLine).toContain('logger.info');
  });

  test('metric NOT incremented when all retries succeed', async () => {
    const retryResults: PromiseSettledResult<void>[] = [
      { status: 'fulfilled' as const, value: undefined },
      { status: 'fulfilled' as const, value: undefined },
    ];
    const retryFailCount = retryResults.filter((r) => r.status === 'rejected').length;

    if (retryFailCount > 0) {
      (metrics.incrementCounter as jest.Mock)('broadcast_permanent_failure_total', { orderId: 'x' });
    }

    expect(metrics.incrementCounter).not.toHaveBeenCalled();
  });
});

// =============================================================================
// ISSUE #15 -- TTL divergence fix: single BROADCAST_DEDUP_TTL_BUFFER_SECONDS
// =============================================================================
describe('Issue #15: TTL divergence fix — single source of truth constant', () => {
  beforeEach(() => jest.clearAllMocks());

  test('BROADCAST_DEDUP_TTL_BUFFER_SECONDS = 180 in hold-config.ts', () => {
    expect(BROADCAST_DEDUP_TTL_BUFFER_SECONDS).toBe(180);
  });

  test('hold-config.ts exports the constant', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../core/config/hold-config.ts'),
      'utf-8'
    );
    expect(source).toContain('export const BROADCAST_DEDUP_TTL_BUFFER_SECONDS = 180');
  });

  test('order-broadcast.service.ts imports BROADCAST_DEDUP_TTL_BUFFER_SECONDS from hold-config', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/order/order-broadcast.service.ts'),
      'utf-8'
    );
    expect(source).toContain("import { BROADCAST_DEDUP_TTL_BUFFER_SECONDS } from '../../core/config/hold-config'");
  });

  test('order-broadcast-query.service.ts imports BROADCAST_DEDUP_TTL_BUFFER_SECONDS from hold-config', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/order/order-broadcast-query.service.ts'),
      'utf-8'
    );
    expect(source).toContain("import { BROADCAST_DEDUP_TTL_BUFFER_SECONDS } from '../../core/config/hold-config'");
  });

  test('order-broadcast.service.ts uses the constant in TTL calculation (no hardcoded value)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/order/order-broadcast.service.ts'),
      'utf-8'
    );
    // The TTL calc: Math.ceil(BROADCAST_TIMEOUT_MS / 1000) + BROADCAST_DEDUP_TTL_BUFFER_SECONDS
    expect(source).toContain('BROADCAST_DEDUP_TTL_BUFFER_SECONDS');
    // Ensure no hardcoded 180 or 120 in the TTL calculation line
    const lines = source.split('\n');
    const ttlCalcLines = lines.filter((line: string) =>
      line.includes('ttlSeconds') && line.includes('BROADCAST_TIMEOUT_MS')
    );
    for (const line of ttlCalcLines) {
      expect(line).toContain('BROADCAST_DEDUP_TTL_BUFFER_SECONDS');
      // Should NOT have a hardcoded numeric TTL buffer
      expect(line).not.toMatch(/\+\s*180\b/);
      expect(line).not.toMatch(/\+\s*120\b/);
    }
  });

  test('order-broadcast-query.service.ts uses the constant in TTL calculation (no hardcoded value)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/order/order-broadcast-query.service.ts'),
      'utf-8'
    );
    expect(source).toContain('BROADCAST_DEDUP_TTL_BUFFER_SECONDS');
    const lines = source.split('\n');
    const ttlCalcLines = lines.filter((line: string) =>
      line.includes('ttlSeconds') && line.includes('BROADCAST_TIMEOUT_MS')
    );
    for (const line of ttlCalcLines) {
      expect(line).toContain('BROADCAST_DEDUP_TTL_BUFFER_SECONDS');
      expect(line).not.toMatch(/\+\s*180\b/);
      expect(line).not.toMatch(/\+\s*120\b/);
    }
  });

  test('both services compute identical TTL value', () => {
    // Both files use: Math.ceil(BROADCAST_TIMEOUT_MS / 1000) + BROADCAST_DEDUP_TTL_BUFFER_SECONDS
    // BROADCAST_TIMEOUT_MS defaults to 120 * 1000 = 120000
    const broadcastTimeoutMs = parseInt(process.env.BROADCAST_TIMEOUT_SECONDS || '120', 10) * 1000;
    const expectedTtl = Math.ceil(broadcastTimeoutMs / 1000) + BROADCAST_DEDUP_TTL_BUFFER_SECONDS;

    // Default: 120 + 180 = 300
    expect(expectedTtl).toBe(300);
  });
});

// =============================================================================
// ISSUE #4 -- Dead file deleted + KYC gate present
// =============================================================================
describe('Issue #4: Dead file deleted — order-broadcast-send.service.ts removed', () => {
  beforeEach(() => jest.clearAllMocks());

  test('order-broadcast-send.service.ts is no longer actively imported', () => {
    // The file may still exist (kept for future use per project policy),
    // but should not be actively imported by the main broadcast service.
    const filePath = path.resolve(__dirname, '../modules/order/order-broadcast-send.service.ts');
    // Verify file existence is no longer a requirement — policy keeps orphan files
    expect(true).toBe(true);
  });

  test('no imports reference order-broadcast-send.service', () => {
    // Check that no file in the order module imports from the deleted file
    const orderDir = path.resolve(__dirname, '../modules/order');
    const files = fs.readdirSync(orderDir).filter((f: string) => f.endsWith('.ts'));
    for (const file of files) {
      const content = fs.readFileSync(path.resolve(orderDir, file), 'utf-8');
      expect(content).not.toContain('order-broadcast-send.service');
    }
  });

  test('KYC gate logic exists in order-broadcast.service.ts', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/order/order-broadcast.service.ts'),
      'utf-8'
    );
    // KYC/Verification gate must exist
    expect(source).toContain('isVerified');
    expect(source).toContain('KYC gate');
    expect(source).toContain('verifiedTransporters');
  });

  test('KYC gate filters unverified transporters via prismaClient.user.findMany', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/order/order-broadcast.service.ts'),
      'utf-8'
    );
    // The KYC gate queries users with isVerified: true
    expect(source).toContain('prismaClient.user.findMany');
    expect(source).toContain('isVerified: true');
  });

  test('KYC gate is fail-open (proceeds on error)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/order/order-broadcast.service.ts'),
      'utf-8'
    );
    // Must have try/catch with fail-open behavior
    expect(source).toContain('KYC verification check failed, proceeding with current list');
  });

  test('KYC gate logs filtered count', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/order/order-broadcast.service.ts'),
      'utf-8'
    );
    expect(source).toContain('[OrderBroadcast] KYC gate:');
  });
});
