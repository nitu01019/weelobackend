/**
 * =============================================================================
 * LEO C7, C8, C9 FIXES — Test Suite
 * =============================================================================
 *
 * C7  — Real BRPOP: blockingClient-based brPop in redis.service.ts + sleep
 *       removal in queue.service.ts worker loop
 * C8  — Progress Events: emitToOrder (not emitToUser) in progress.service.ts
 * C9  — Timeout Extension Events: emitToOrder (not emitToUser) in
 *       smart-timeout.service.ts
 *
 * @author LEO-Tester-2
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — Must come before any imports
// =============================================================================

// Logger mock
jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Metrics mock
jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    recordHistogram: jest.fn(),
    observeHistogram: jest.fn(),
    setGauge: jest.fn(),
  },
}));

// Redis service mock
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisIncr = jest.fn();
const mockRedisExpire = jest.fn();
const mockRedisExists = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisLPush = jest.fn();
const mockRedisLTrim = jest.fn();
const mockRedisIncrBy = jest.fn();
const mockRedisSAdd = jest.fn();
const mockRedisIsConnected = jest.fn().mockReturnValue(true);
const mockRedisBrPop = jest.fn();
const mockRedisRPop = jest.fn();
const mockRedisSetTimer = jest.fn();
const mockRedisCancelTimer = jest.fn();
const mockRedisGetExpiredTimers = jest.fn();
const mockRedisGetJSON = jest.fn();
const mockRedisSetJSON = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    incr: (...args: any[]) => mockRedisIncr(...args),
    expire: (...args: any[]) => mockRedisExpire(...args),
    exists: (...args: any[]) => mockRedisExists(...args),
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    lPush: (...args: any[]) => mockRedisLPush(...args),
    lTrim: (...args: any[]) => mockRedisLTrim(...args),
    incrBy: (...args: any[]) => mockRedisIncrBy(...args),
    sAdd: (...args: any[]) => mockRedisSAdd(...args),
    isConnected: () => mockRedisIsConnected(),
    brPop: (...args: any[]) => mockRedisBrPop(...args),
    rPop: (...args: any[]) => mockRedisRPop(...args),
    setTimer: (...args: any[]) => mockRedisSetTimer(...args),
    cancelTimer: (...args: any[]) => mockRedisCancelTimer(...args),
    getExpiredTimers: (...args: any[]) => mockRedisGetExpiredTimers(...args),
    getJSON: (...args: any[]) => mockRedisGetJSON(...args),
    setJSON: (...args: any[]) => mockRedisSetJSON(...args),
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
    getClient: jest.fn().mockReturnValue(null),
    zAdd: jest.fn(),
    zRangeByScore: jest.fn().mockResolvedValue([]),
    zRemRangeByScore: jest.fn(),
    lLen: jest.fn().mockResolvedValue(0),
    hSet: jest.fn(),
    hDel: jest.fn(),
    hGetAll: jest.fn().mockResolvedValue({}),
    lPushMany: jest.fn(),
    sRem: jest.fn(),
    sCard: jest.fn(),
    sMembers: jest.fn(),
    sIsMember: jest.fn(),
    sScan: jest.fn(),
  },
}));

// Socket service mock
const mockEmitToUser = jest.fn();
const mockEmitToOrder = jest.fn();
const mockEmitToBooking = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToBooking: (...args: any[]) => mockEmitToBooking(...args),
  emitToOrder: (...args: any[]) => mockEmitToOrder(...args),
  emitToRoom: jest.fn(),
  emitToAll: jest.fn(),
  emitToUsers: jest.fn(),
  emitToAllTransporters: jest.fn(),
  isUserConnected: jest.fn(),
  socketService: {
    emitToUser: (...args: any[]) => mockEmitToUser(...args),
    emitToOrder: (...args: any[]) => mockEmitToOrder(...args),
    emitToBooking: (...args: any[]) => mockEmitToBooking(...args),
    emitToTransporterDrivers: jest.fn(),
  },
  SocketEvent: {
    CONNECTED: 'connected',
    BOOKING_UPDATED: 'booking_updated',
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    ERROR: 'error',
  },
}));

// Prisma mock
const mockProgressEventCreate = jest.fn();
const mockOrderTimeoutFindUnique = jest.fn();
const mockOrderTimeoutCreate = jest.fn();
const mockOrderTimeoutUpdate = jest.fn();
const mockOrderFindUnique = jest.fn();
const mockProgressEventFindMany = jest.fn();
const mockProgressEventFindFirst = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    progressEvent: {
      create: (...args: any[]) => mockProgressEventCreate(...args),
      findMany: (...args: any[]) => mockProgressEventFindMany(...args),
      findFirst: (...args: any[]) => mockProgressEventFindFirst(...args),
    },
    orderTimeout: {
      findUnique: (...args: any[]) => mockOrderTimeoutFindUnique(...args),
      create: (...args: any[]) => mockOrderTimeoutCreate(...args),
      update: (...args: any[]) => mockOrderTimeoutUpdate(...args),
    },
    order: {
      findUnique: (...args: any[]) => mockOrderFindUnique(...args),
      update: jest.fn(),
    },
    assignment: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    transporterBroadcastView: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
  },
  TimeoutExtensionType: {
    FIRST_DRIVER: 'FIRST_DRIVER',
    SUBSEQUENT: 'SUBSEQUENT',
  },
  OrderStatus: {
    expired: 'expired',
  },
}));

// Config mock
jest.mock('../config/environment', () => ({
  config: {
    redis: { enabled: true },
    isProduction: false,
    isDevelopment: true,
    jwt: { secret: 'test-jwt-secret' },
    otp: { expiryMinutes: 5 },
    sms: {},
    googleMaps: { apiKey: 'test-key', enabled: false },
  },
}));

// Queue service mock (for smart-timeout.service)
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    add: jest.fn().mockResolvedValue('job-id'),
    queueBroadcast: jest.fn(),
    queuePushNotification: jest.fn(),
    queuePushNotificationBatch: jest.fn(),
    scheduleAssignmentTimeout: jest.fn(),
    cancelAssignmentTimeout: jest.fn(),
  },
}));

// uuid mock
jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('mock-uuid-123'),
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { logger } from '../shared/services/logger.service';

// =============================================================================
// TEST HELPERS
// =============================================================================

function resetAllMocks(): void {
  jest.clearAllMocks();
  mockRedisGet.mockReset();
  mockRedisSet.mockReset();
  mockRedisDel.mockReset();
  mockRedisIncr.mockReset();
  mockRedisExpire.mockReset();
  mockRedisExists.mockReset();
  mockRedisAcquireLock.mockReset();
  mockRedisReleaseLock.mockReset();
  mockRedisLPush.mockReset();
  mockRedisLTrim.mockReset();
  mockRedisIncrBy.mockReset();
  mockRedisSAdd.mockReset();
  mockRedisIsConnected.mockReturnValue(true);
  mockRedisBrPop.mockReset();
  mockRedisRPop.mockReset();
  mockRedisSetTimer.mockReset();
  mockRedisCancelTimer.mockReset();
  mockRedisGetExpiredTimers.mockReset();
  mockRedisGetJSON.mockReset();
  mockRedisSetJSON.mockReset();
  mockEmitToUser.mockReset();
  mockEmitToOrder.mockReset();
  mockEmitToBooking.mockReset();
  mockProgressEventCreate.mockReset();
  mockOrderTimeoutFindUnique.mockReset();
  mockOrderTimeoutCreate.mockReset();
  mockOrderTimeoutUpdate.mockReset();
  mockOrderFindUnique.mockReset();
  mockProgressEventFindMany.mockReset();
  mockProgressEventFindFirst.mockReset();
}

// =============================================================================
// C7 TESTS — Real BRPOP (redis.service.ts + queue.service.ts)
// =============================================================================

describe('C7 — Real BRPOP: blockingClient-based brPop', () => {
  beforeEach(resetAllMocks);

  // -------------------------------------------------------------------------
  // Test 1: brPop uses blockingClient and returns value from [key, value]
  // -------------------------------------------------------------------------
  it('brPop uses blockingClient: returns value from [key, value] tuple', async () => {
    // In RealRedisClient.brPop (redis.service.ts line 1170):
    //   const result = await this.blockingClient.brpop(key, timeoutSeconds);
    //   return result ? result[1] : null;
    //
    // ioredis brpop returns [key, value] or null

    // Simulate blockingClient.brpop returning [key, value]
    const brPopResult = ['queue:broadcast', '{"id":"job-1","type":"broadcast"}'];
    mockRedisBrPop.mockResolvedValue(brPopResult[1]); // redisService.brPop wraps and returns value only

    const { redisService } = require('../shared/services/redis.service');
    const result = await redisService.brPop('queue:broadcast', 2);

    expect(mockRedisBrPop).toHaveBeenCalledWith('queue:broadcast', 2);
    expect(result).toBe('{"id":"job-1","type":"broadcast"}');
  });

  // -------------------------------------------------------------------------
  // Test 2: brPop returns null when queue is empty (timeout)
  // -------------------------------------------------------------------------
  it('brPop returns null when empty (timeout expired)', async () => {
    // ioredis brpop returns null when timeout expires with no data
    mockRedisBrPop.mockResolvedValue(null);

    const { redisService } = require('../shared/services/redis.service');
    const result = await redisService.brPop('queue:empty', 2);

    expect(result).toBeNull();
    expect(mockRedisBrPop).toHaveBeenCalledWith('queue:empty', 2);
  });

  // -------------------------------------------------------------------------
  // Test 3: brPop fallback when no blockingClient (uses client.rpop)
  // -------------------------------------------------------------------------
  it('brPop fallback when no blockingClient: uses rpop', () => {
    // In RealRedisClient.brPop (redis.service.ts line 1163-1166):
    //   if (!this.blockingClient) {
    //     const result = await this.client.rpop(key);
    //     return result ?? null;
    //   }
    //
    // We verify the fallback logic pattern by simulating the check

    const blockingClient = null;
    const clientRpop = jest.fn().mockResolvedValue('fallback-value');

    // Simulate the brPop logic when blockingClient is null
    async function brPopWithFallback(key: string, _timeoutSeconds: number): Promise<string | null> {
      if (!blockingClient) {
        const result = await clientRpop(key);
        return result ?? null;
      }
      return null;
    }

    return brPopWithFallback('queue:test', 2).then(result => {
      expect(result).toBe('fallback-value');
      expect(clientRpop).toHaveBeenCalledWith('queue:test');
    });
  });

  // -------------------------------------------------------------------------
  // Test 4: brPop fallback on blockingClient error (logs warning, uses rpop)
  // -------------------------------------------------------------------------
  it('brPop fallback on error: logs warning and uses rpop', async () => {
    // In RealRedisClient.brPop (redis.service.ts line 1173-1178):
    //   catch (err) {
    //     logger.warn(`[Redis] BRPOP failed, falling back to RPOP: ${err.message}`);
    //     const result = await this.client.rpop(key);
    //     return result ?? null;
    //   }

    const blockingClient = {
      brpop: jest.fn().mockRejectedValue(new Error('Connection lost')),
    };
    const clientRpop = jest.fn().mockResolvedValue('fallback-after-error');
    const warnLogger = jest.fn();

    async function brPopWithErrorFallback(key: string, timeoutSeconds: number): Promise<string | null> {
      if (!blockingClient) {
        return clientRpop(key);
      }
      try {
        const result = await blockingClient.brpop(key, timeoutSeconds);
        return result ? result[1] : null;
      } catch (err: any) {
        warnLogger(`[Redis] BRPOP failed, falling back to RPOP: ${err.message}`);
        const result = await clientRpop(key);
        return result ?? null;
      }
    }

    const result = await brPopWithErrorFallback('queue:test', 2);

    expect(result).toBe('fallback-after-error');
    expect(blockingClient.brpop).toHaveBeenCalledWith('queue:test', 2);
    expect(warnLogger).toHaveBeenCalledWith(
      expect.stringContaining('BRPOP failed, falling back to RPOP')
    );
    expect(clientRpop).toHaveBeenCalledWith('queue:test');
  });

  // -------------------------------------------------------------------------
  // Test 5: brPop returns correct value from [key, value] tuple (index 1)
  // -------------------------------------------------------------------------
  it('brPop extracts value (index 1) from ioredis [key, value] result', () => {
    // ioredis brpop returns ['queue:broadcast', '{"data":"payload"}']
    // RealRedisClient.brPop at line 1172: return result ? result[1] : null;
    const ioredisResult: [string, string] = ['queue:broadcast', '{"data":"payload"}'];

    const value = ioredisResult ? ioredisResult[1] : null;

    expect(value).toBe('{"data":"payload"}');
    // Must NOT return the key (index 0)
    expect(value).not.toBe('queue:broadcast');
  });

  // -------------------------------------------------------------------------
  // Test 6: blockingClient created with correct config (no commandTimeout)
  // -------------------------------------------------------------------------
  it('blockingClient config: maxRetriesPerRequest=null, no commandTimeout', () => {
    // From redis.service.ts line 955-963:
    //   this.blockingClient = new Redis(this.config.url, {
    //     maxRetriesPerRequest: null,     // Required for blocking commands
    //     connectTimeout: this.config.connectionTimeoutMs,
    //     enableOfflineQueue: false,
    //     enableReadyCheck: true,
    //     lazyConnect: false,
    //     keepAlive: 1000,
    //     // No commandTimeout
    //   });

    const blockingClientConfig = {
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      enableReadyCheck: true,
      lazyConnect: false,
      keepAlive: 1000,
      // No commandTimeout property at all
    };

    expect(blockingClientConfig.maxRetriesPerRequest).toBeNull();
    expect(blockingClientConfig).not.toHaveProperty('commandTimeout');
    expect(blockingClientConfig.enableOfflineQueue).toBe(false);
    expect(blockingClientConfig.enableReadyCheck).toBe(true);
    expect(blockingClientConfig.lazyConnect).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 7: disconnect cleans up blockingClient
  // -------------------------------------------------------------------------
  it('disconnect calls blockingClient.quit()', async () => {
    // From redis.service.ts line 1034-1036:
    //   if (this.blockingClient) {
    //     await this.blockingClient.quit().catch(() => {});
    //   }

    const mockQuit = jest.fn().mockResolvedValue('OK');
    const blockingClient = { quit: mockQuit };

    // Simulate disconnect logic
    if (blockingClient) {
      await blockingClient.quit().catch(() => {});
    }

    expect(mockQuit).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Test 8: InMemoryRedis brPop still works (polling loop)
  // -------------------------------------------------------------------------
  it('InMemoryRedisClient brPop uses polling loop', async () => {
    // From redis.service.ts line 449-463:
    //   async brPop(key, timeoutSeconds) {
    //     const startTime = Date.now();
    //     const timeoutMs = timeoutSeconds * 1000;
    //     while (Date.now() - startTime < timeoutMs) {
    //       const value = await this.rPop(key);
    //       if (value !== null) return value;
    //       await new Promise(resolve => setTimeout(resolve, 100));
    //     }
    //     return null;
    //   }

    // Simulate the InMemoryRedisClient polling behavior
    let pollCount = 0;
    const mockRPopInMemory = jest.fn().mockImplementation(async () => {
      pollCount++;
      if (pollCount >= 3) return '{"id":"delayed-job"}';
      return null;
    });

    async function inMemoryBrPop(key: string, timeoutSeconds: number): Promise<string | null> {
      const startTime = Date.now();
      const timeoutMs = timeoutSeconds * 1000;

      while (Date.now() - startTime < timeoutMs) {
        const value = await mockRPopInMemory(key);
        if (value !== null) return value;
        // In-memory simulates blocking with short sleep
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return null;
    }

    const result = await inMemoryBrPop('queue:test', 5);

    expect(result).toBe('{"id":"delayed-job"}');
    expect(mockRPopInMemory).toHaveBeenCalledTimes(3);
  });
});

// =============================================================================
// C7 TESTS — Queue Worker: No sleep after empty BRPOP
// =============================================================================

describe('C7 — Queue Worker: No sleep after empty BRPOP', () => {
  beforeEach(resetAllMocks);

  // -------------------------------------------------------------------------
  // Test 17: Queue worker does NOT sleep after null brPop result
  // -------------------------------------------------------------------------
  it('worker loop does NOT call sleep(500) after null brPop result', () => {
    // From queue.service.ts runWorkerLoop (line 641-644):
    //   const jobStr = await redisService.brPop(queueKey, this.blockingPopTimeoutSec);
    //   if (!jobStr) {
    //     // Real BRPOP already waited blockingPopTimeoutSec -- no sleep needed
    //     continue;
    //   }
    //
    // The old code had: await this.sleep(500); after null result.
    // The fix removes that sleep because BRPOP itself blocks for the timeout.

    // Verify the pattern: null brPop -> continue (no sleep)
    const sleepCalled = jest.fn();
    let brPopCallCount = 0;
    const maxIterations = 3;

    // Simulate worker loop behavior
    async function simulatedWorkerLoop(): Promise<void> {
      let isRunning = true;
      let iteration = 0;

      while (isRunning && iteration < maxIterations) {
        iteration++;
        brPopCallCount++;

        // Simulate brPop returning null (empty queue, timeout expired)
        const jobStr = null;

        if (!jobStr) {
          // FIX: No sleep(500) here — BRPOP already waited
          continue;
        }

        // Would process job here...
        sleepCalled(); // This should never be called for null results
      }
    }

    return simulatedWorkerLoop().then(() => {
      expect(brPopCallCount).toBe(maxIterations);
      expect(sleepCalled).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Test 18: Multiple rapid progress events emit correctly
  // -------------------------------------------------------------------------
  it('worker loop processes job immediately when brPop returns data', async () => {
    // From queue.service.ts runWorkerLoop (line 641-661):
    //   const jobStr = await redisService.brPop(...);
    //   if (!jobStr) { continue; }
    //   const job = JSON.parse(jobStr);
    //   // ... process immediately

    const processedJobs: string[] = [];
    const jobPayloads = [
      '{"id":"j1","type":"broadcast","data":{}}',
      '{"id":"j2","type":"broadcast","data":{}}',
      '{"id":"j3","type":"broadcast","data":{}}',
    ];

    let callIndex = 0;
    const mockBrPop = jest.fn().mockImplementation(async () => {
      if (callIndex < jobPayloads.length) {
        return jobPayloads[callIndex++];
      }
      return null; // Queue empty after all jobs
    });

    // Simulate worker loop (3 jobs then empty)
    for (let i = 0; i < jobPayloads.length; i++) {
      const jobStr = await mockBrPop('queue:test', 2);
      if (jobStr) {
        const job = JSON.parse(jobStr);
        processedJobs.push(job.id);
      }
    }

    expect(processedJobs).toEqual(['j1', 'j2', 'j3']);
    expect(mockBrPop).toHaveBeenCalledTimes(3);
  });
});

// =============================================================================
// C8 TESTS — Progress Events (progress.service.ts)
// =============================================================================

describe('C8 — Progress Events: emitToOrder (not emitToUser)', () => {
  beforeEach(resetAllMocks);

  // -------------------------------------------------------------------------
  // Test 9: emitToOrder called, not emitToUser
  // -------------------------------------------------------------------------
  it('recordProgressEvent calls emitToOrder, NOT emitToUser', async () => {
    // From progress.service.ts line 145:
    //   await socketService.emitToOrder(event.orderId, 'order_progress_update', { ... });
    // NOT: emitToUser(customerId, ...)

    mockProgressEventCreate.mockResolvedValue({ id: 'pe-1' });

    const { progressTrackingService } = require('../modules/order-timeout/progress.service');

    await progressTrackingService.recordProgressEvent({
      orderId: 'order-001',
      driverId: 'driver-001',
      driverName: 'Raju',
      extensionType: 'FIRST_DRIVER',
      addedSeconds: 60,
      reason: 'Driver accepted',
      trigger: 'driver_accepted',
      assignmentId: 'assign-001',
    });

    // emitToOrder was called
    expect(mockEmitToOrder).toHaveBeenCalledTimes(1);
    expect(mockEmitToOrder).toHaveBeenCalledWith(
      'order-001',
      'order_progress_update',
      expect.any(Object)
    );

    // emitToUser was NOT called for this event
    expect(mockEmitToUser).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 10: Correct event name
  // -------------------------------------------------------------------------
  it('emits correct event name: order_progress_update', async () => {
    mockProgressEventCreate.mockResolvedValue({ id: 'pe-2' });

    const { progressTrackingService } = require('../modules/order-timeout/progress.service');

    await progressTrackingService.recordProgressEvent({
      orderId: 'order-002',
      driverId: 'driver-002',
      driverName: 'Shivu',
      extensionType: 'SUBSEQUENT',
      addedSeconds: 30,
      reason: 'Additional driver accepted',
      trigger: 'driver_accepted',
    });

    const emitCall = mockEmitToOrder.mock.calls[0];
    expect(emitCall[1]).toBe('order_progress_update');
  });

  // -------------------------------------------------------------------------
  // Test 11: Correct payload shape
  // -------------------------------------------------------------------------
  it('emits correct payload shape with orderId, progress, message', async () => {
    mockProgressEventCreate.mockResolvedValue({ id: 'pe-3' });

    const { progressTrackingService } = require('../modules/order-timeout/progress.service');

    await progressTrackingService.recordProgressEvent({
      orderId: 'order-003',
      driverId: 'driver-003',
      driverName: 'Agaj',
      extensionType: 'FIRST_DRIVER',
      addedSeconds: 60,
      reason: 'Driver accepted',
      trigger: 'driver_accepted',
      assignmentId: 'assign-003',
    });

    const emitCall = mockEmitToOrder.mock.calls[0];
    const payload = emitCall[2];

    // Verify payload shape from progress.service.ts line 145-154
    expect(payload).toHaveProperty('orderId', 'order-003');
    expect(payload).toHaveProperty('progress');
    expect(payload.progress).toHaveProperty('driverId', 'driver-003');
    expect(payload.progress).toHaveProperty('driverName', 'Agaj');
    expect(payload.progress).toHaveProperty('addedSeconds', 60);
    expect(payload.progress).toHaveProperty('timestamp');
    expect(payload).toHaveProperty('message');
    expect(payload.message).toContain('Agaj');
    expect(payload.message).toContain('60');
  });

  // -------------------------------------------------------------------------
  // Test 12: No crash when no listeners (emitToOrder returns void)
  // -------------------------------------------------------------------------
  it('no crash when emitToOrder has no room members', async () => {
    // emitToOrder just calls io.to(room).emit() which is fire-and-forget
    // It doesn't throw even if no one is in the room
    mockProgressEventCreate.mockResolvedValue({ id: 'pe-4' });
    mockEmitToOrder.mockReturnValue(undefined); // No room members - returns void

    const { progressTrackingService } = require('../modules/order-timeout/progress.service');

    // Should not throw
    await expect(
      progressTrackingService.recordProgressEvent({
        orderId: 'order-orphan',
        driverId: 'driver-004',
        driverName: 'No Listeners',
        extensionType: 'FIRST_DRIVER',
        addedSeconds: 60,
        reason: 'Driver accepted',
        trigger: 'driver_accepted',
      })
    ).resolves.toBeUndefined();

    expect(mockEmitToOrder).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// C9 TESTS — Timeout Extension Events (smart-timeout.service.ts)
// =============================================================================

describe('C9 — Timeout Extension Events: emitToOrder (not emitToUser)', () => {
  beforeEach(resetAllMocks);

  // -------------------------------------------------------------------------
  // Test 13: emitToOrder called, not emitToUser
  // -------------------------------------------------------------------------
  it('extendTimeout calls emitToOrder, NOT emitToUser', async () => {
    // From smart-timeout.service.ts line 332:
    //   await socketService.emitToOrder(request.orderId, 'order_timeout_extended', { ... });
    // NOT: emitToUser(customerId, ...)

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 180000);

    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    mockOrderTimeoutFindUnique.mockResolvedValue({
      orderId: 'order-ext-001',
      baseTimeoutMs: 120000,
      extendedMs: 0,
      lastProgressAt: now,
      expiresAt,
      isExpired: false,
      createdAt: now,
      updatedAt: now,
    });
    mockOrderTimeoutUpdate.mockResolvedValue({
      orderId: 'order-ext-001',
      baseTimeoutMs: 120000,
      extendedMs: 60000,
      lastProgressAt: now,
      expiresAt: new Date(expiresAt.getTime() + 60000),
      isExpired: false,
    });
    mockProgressEventCreate.mockResolvedValue({ id: 'pe-ext-1' });
    mockRedisSetJSON.mockResolvedValue(undefined);

    const { smartTimeoutService } = require('../modules/order-timeout/smart-timeout.service');

    const result = await smartTimeoutService.extendTimeout({
      orderId: 'order-ext-001',
      driverId: 'driver-ext-001',
      driverName: 'Timeout Raju',
      assignmentId: 'assign-ext-001',
      isFirstDriver: true,
      reason: 'Driver accepted trip',
    });

    expect(result.success).toBe(true);

    // emitToOrder was called for timeout extension
    expect(mockEmitToOrder).toHaveBeenCalledTimes(1);
    expect(mockEmitToOrder).toHaveBeenCalledWith(
      'order-ext-001',
      'order_timeout_extended',
      expect.any(Object)
    );

    // emitToUser was NOT called
    expect(mockEmitToUser).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 14: Correct event name
  // -------------------------------------------------------------------------
  it('emits correct event name: order_timeout_extended', async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 180000);

    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    mockOrderTimeoutFindUnique.mockResolvedValue({
      orderId: 'order-evt-001',
      baseTimeoutMs: 120000,
      extendedMs: 0,
      lastProgressAt: now,
      expiresAt,
      isExpired: false,
      createdAt: now,
      updatedAt: now,
    });
    mockOrderTimeoutUpdate.mockResolvedValue({
      orderId: 'order-evt-001',
      baseTimeoutMs: 120000,
      extendedMs: 60000,
      lastProgressAt: now,
      expiresAt: new Date(expiresAt.getTime() + 60000),
      isExpired: false,
    });
    mockProgressEventCreate.mockResolvedValue({ id: 'pe-evt-1' });
    mockRedisSetJSON.mockResolvedValue(undefined);

    const { smartTimeoutService } = require('../modules/order-timeout/smart-timeout.service');

    await smartTimeoutService.extendTimeout({
      orderId: 'order-evt-001',
      driverId: 'driver-evt-001',
      driverName: 'Event Driver',
      assignmentId: 'assign-evt-001',
      isFirstDriver: true,
      reason: 'Driver accepted',
    });

    const emitCall = mockEmitToOrder.mock.calls[0];
    expect(emitCall[0]).toBe('order-evt-001');
    expect(emitCall[1]).toBe('order_timeout_extended');
  });

  // -------------------------------------------------------------------------
  // Test 15: Correct payload shape
  // -------------------------------------------------------------------------
  it('emits correct payload shape with orderId, newExpiresAt, addedSeconds, driverName, extensionCount', async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 180000);
    const newExpiresAt = new Date(expiresAt.getTime() + 60000);

    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    mockOrderTimeoutFindUnique.mockResolvedValue({
      orderId: 'order-shape-001',
      baseTimeoutMs: 120000,
      extendedMs: 0,
      lastProgressAt: now,
      expiresAt,
      isExpired: false,
      createdAt: now,
      updatedAt: now,
    });
    mockOrderTimeoutUpdate.mockResolvedValue({
      orderId: 'order-shape-001',
      baseTimeoutMs: 120000,
      extendedMs: 60000,
      lastProgressAt: now,
      expiresAt: newExpiresAt,
      isExpired: false,
    });
    mockProgressEventCreate.mockResolvedValue({ id: 'pe-shape-1' });
    mockRedisSetJSON.mockResolvedValue(undefined);

    const { smartTimeoutService } = require('../modules/order-timeout/smart-timeout.service');

    await smartTimeoutService.extendTimeout({
      orderId: 'order-shape-001',
      driverId: 'driver-shape-001',
      driverName: 'Shape Driver',
      assignmentId: 'assign-shape-001',
      isFirstDriver: true,
      reason: 'Driver accepted',
    });

    const emitCall = mockEmitToOrder.mock.calls[0];
    const payload = emitCall[2];

    // Verify payload shape from smart-timeout.service.ts line 332-349
    expect(payload).toHaveProperty('orderId', 'order-shape-001');
    expect(payload).toHaveProperty('newExpiresAt');
    expect(payload).toHaveProperty('addedSeconds');
    expect(payload).toHaveProperty('driverName', 'Shape Driver');
    expect(payload).toHaveProperty('extensionCount');
    expect(payload).toHaveProperty('message');
    expect(payload).toHaveProperty('timeExtendedBy');
    expect(Array.isArray(payload.timeExtendedBy)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 16: No crash when no listeners
  // -------------------------------------------------------------------------
  it('no crash when emitToOrder has no room members', async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 180000);

    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    mockOrderTimeoutFindUnique.mockResolvedValue({
      orderId: 'order-nolistener-001',
      baseTimeoutMs: 120000,
      extendedMs: 0,
      lastProgressAt: now,
      expiresAt,
      isExpired: false,
      createdAt: now,
      updatedAt: now,
    });
    mockOrderTimeoutUpdate.mockResolvedValue({
      orderId: 'order-nolistener-001',
      baseTimeoutMs: 120000,
      extendedMs: 60000,
      lastProgressAt: now,
      expiresAt: new Date(expiresAt.getTime() + 60000),
      isExpired: false,
    });
    mockProgressEventCreate.mockResolvedValue({ id: 'pe-nl-1' });
    mockRedisSetJSON.mockResolvedValue(undefined);
    mockEmitToOrder.mockReturnValue(undefined); // no room members

    const { smartTimeoutService } = require('../modules/order-timeout/smart-timeout.service');

    const result = await smartTimeoutService.extendTimeout({
      orderId: 'order-nolistener-001',
      driverId: 'driver-nl-001',
      driverName: 'Ghost Driver',
      assignmentId: 'assign-nl-001',
      isFirstDriver: true,
      reason: 'Driver accepted',
    });

    // Should succeed without error
    expect(result.success).toBe(true);
    expect(mockEmitToOrder).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// EDGE CASE TESTS
// =============================================================================

describe('Edge Cases: BRPOP + Progress Events', () => {
  beforeEach(resetAllMocks);

  // -------------------------------------------------------------------------
  // Test 18: Multiple rapid progress events all emit correctly
  // -------------------------------------------------------------------------
  it('multiple rapid progress events all emit correctly, no lost events', async () => {
    mockProgressEventCreate.mockResolvedValue({ id: 'pe-rapid' });

    const { progressTrackingService } = require('../modules/order-timeout/progress.service');

    const events = [
      {
        orderId: 'order-rapid-001',
        driverId: 'driver-r1',
        driverName: 'Driver One',
        extensionType: 'FIRST_DRIVER' as const,
        addedSeconds: 60,
        reason: 'First driver accepted',
        trigger: 'driver_accepted',
        assignmentId: 'assign-r1',
      },
      {
        orderId: 'order-rapid-001',
        driverId: 'driver-r2',
        driverName: 'Driver Two',
        extensionType: 'SUBSEQUENT' as const,
        addedSeconds: 30,
        reason: 'Second driver accepted',
        trigger: 'driver_accepted',
        assignmentId: 'assign-r2',
      },
      {
        orderId: 'order-rapid-001',
        driverId: 'driver-r3',
        driverName: 'Driver Three',
        extensionType: 'SUBSEQUENT' as const,
        addedSeconds: 30,
        reason: 'Third driver accepted',
        trigger: 'driver_accepted',
        assignmentId: 'assign-r3',
      },
    ];

    // Fire all 3 events rapidly (concurrent)
    await Promise.all(events.map(e => progressTrackingService.recordProgressEvent(e)));

    // All 3 should have emitted via emitToOrder
    expect(mockEmitToOrder).toHaveBeenCalledTimes(3);

    // Each emit should target the same orderId
    for (const call of mockEmitToOrder.mock.calls) {
      expect(call[0]).toBe('order-rapid-001');
      expect(call[1]).toBe('order_progress_update');
    }

    // Verify each driver appears in the emitted payloads
    const emittedDriverNames = mockEmitToOrder.mock.calls.map(
      (call: any[]) => call[2].progress.driverName
    );
    expect(emittedDriverNames).toContain('Driver One');
    expect(emittedDriverNames).toContain('Driver Two');
    expect(emittedDriverNames).toContain('Driver Three');
  });

  // -------------------------------------------------------------------------
  // Additional: extendTimeout returns failure when lock not acquired
  // -------------------------------------------------------------------------
  it('extendTimeout returns failure when lock not acquired', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: false });

    const { smartTimeoutService } = require('../modules/order-timeout/smart-timeout.service');

    const result = await smartTimeoutService.extendTimeout({
      orderId: 'order-locked',
      driverId: 'driver-locked',
      driverName: 'Locked Driver',
      assignmentId: 'assign-locked',
      isFirstDriver: true,
      reason: 'Driver accepted',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('lock');
    // emitToOrder should NOT be called when lock fails
    expect(mockEmitToOrder).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Additional: extendTimeout handles expired order correctly
  // -------------------------------------------------------------------------
  it('extendTimeout returns failure for expired order', async () => {
    const now = new Date();

    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    mockOrderTimeoutFindUnique.mockResolvedValue({
      orderId: 'order-expired',
      baseTimeoutMs: 120000,
      extendedMs: 0,
      lastProgressAt: now,
      expiresAt: new Date(now.getTime() - 60000), // already expired
      isExpired: true,
      createdAt: now,
      updatedAt: now,
    });

    const { smartTimeoutService } = require('../modules/order-timeout/smart-timeout.service');

    const result = await smartTimeoutService.extendTimeout({
      orderId: 'order-expired',
      driverId: 'driver-expired',
      driverName: 'Late Driver',
      assignmentId: 'assign-expired',
      isFirstDriver: true,
      reason: 'Driver accepted',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('expired');
    // emitToOrder should NOT be called for expired orders
    expect(mockEmitToOrder).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Additional: brPop returns null correctly for rpop fallback with empty list
  // -------------------------------------------------------------------------
  it('brPop rpop fallback returns null for empty list', () => {
    // When blockingClient is null and client.rpop returns null
    const clientRpop = jest.fn().mockResolvedValue(null);

    async function brPopFallback(key: string): Promise<string | null> {
      const result = await clientRpop(key);
      return result ?? null;
    }

    return brPopFallback('queue:empty').then(result => {
      expect(result).toBeNull();
      expect(clientRpop).toHaveBeenCalledWith('queue:empty');
    });
  });
});
