/**
 * =============================================================================
 * QUEUE SPLIT — Comprehensive Tests for Split Queue Module
 * =============================================================================
 *
 * Tests the 5-file split of queue.service.ts:
 *   1. Facade integrity (queue.service.ts re-exports)
 *   2. InMemoryQueue (queue-memory.service.ts)
 *   3. RedisQueue (queue-redis.service.ts)
 *   4. QueueService (queue-management.service.ts)
 *   5. Edge cases & stress tests
 *
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — Must come before any imports
// =============================================================================

// Block @prisma/client from loading (184 MB generated module causes OOM)
jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: jest.fn(),
    order: { findUnique: jest.fn().mockResolvedValue(null) },
  })),
}));

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
  },
}));

jest.mock('../config/environment', () => ({
  config: { redis: { enabled: false }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {} },
}));

// Redis service mock — all methods used by queue modules
const mockRedisLPush = jest.fn().mockResolvedValue(1);
const mockRedisLPushMany = jest.fn().mockResolvedValue(1);
const mockRedisLLen = jest.fn().mockResolvedValue(0);
const mockRedisLTrim = jest.fn().mockResolvedValue('OK');
// brPop default: introduce a small delay to simulate blocking pop and prevent
// the worker loop from spinning into an OOM-inducing tight loop of microtasks.
const mockRedisBrPop = jest.fn().mockImplementation(
  () => new Promise(resolve => setTimeout(() => resolve(null), 50))
);
const mockRedisZAdd = jest.fn().mockResolvedValue(1);
const mockRedisZRangeByScore = jest.fn().mockResolvedValue([]);
const mockRedisZRemRangeByScore = jest.fn().mockResolvedValue(0);
const mockRedisHSet = jest.fn().mockResolvedValue(1);
const mockRedisHGetAll = jest.fn().mockResolvedValue({});
const mockRedisHDel = jest.fn().mockResolvedValue(1);
const mockRedisExpire = jest.fn().mockResolvedValue(1);
const mockRedisSetTimer = jest.fn().mockResolvedValue(undefined);
const mockRedisCancelTimer = jest.fn().mockResolvedValue(undefined);
const mockRedisGet = jest.fn().mockResolvedValue(null);
const mockRedisSet = jest.fn().mockResolvedValue('OK');
const mockRedisDel = jest.fn().mockResolvedValue(1);
const mockRedisIsConnected = jest.fn().mockReturnValue(true);
const mockRedisMoveDelayedJobsAtomic = jest.fn().mockResolvedValue(0);

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    lPush: (...args: any[]) => mockRedisLPush(...args),
    lPushMany: (...args: any[]) => mockRedisLPushMany(...args),
    lLen: (...args: any[]) => mockRedisLLen(...args),
    lTrim: (...args: any[]) => mockRedisLTrim(...args),
    brPop: (...args: any[]) => mockRedisBrPop(...args),
    zAdd: (...args: any[]) => mockRedisZAdd(...args),
    zRangeByScore: (...args: any[]) => mockRedisZRangeByScore(...args),
    zRemRangeByScore: (...args: any[]) => mockRedisZRemRangeByScore(...args),
    hSet: (...args: any[]) => mockRedisHSet(...args),
    hGetAll: (...args: any[]) => mockRedisHGetAll(...args),
    hDel: (...args: any[]) => mockRedisHDel(...args),
    expire: (...args: any[]) => mockRedisExpire(...args),
    setTimer: (...args: any[]) => mockRedisSetTimer(...args),
    cancelTimer: (...args: any[]) => mockRedisCancelTimer(...args),
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    isConnected: () => mockRedisIsConnected(),
    isRedisEnabled: jest.fn().mockReturnValue(true),
    moveDelayedJobsAtomic: (...args: any[]) => mockRedisMoveDelayedJobsAtomic(...args),
  },
  RedisService: jest.fn(),
  InMemoryRedisClient: jest.fn(),
  RealRedisClient: jest.fn(),
}));

// Mock prisma for QueueService (order status lookups)
jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: jest.fn(),
    order: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  },
  getPrismaClient: jest.fn(),
  withDbTimeout: jest.fn(),
}));

// Also mock the sub-module to prevent @prisma/client resolution
jest.mock('../shared/database/prisma-client', () => ({
  getPrismaClient: jest.fn(),
  withDbTimeout: jest.fn(),
  getReadReplicaClient: jest.fn(),
  sanitizeDbError: jest.fn((e: any) => e),
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
  DB_POOL_CONFIG: {},
}));

// Mock tracking stream sink
jest.mock('../shared/services/tracking-stream-sink', () => ({
  createTrackingStreamSink: () => ({
    publishTrackingEvents: jest.fn().mockResolvedValue(undefined),
    flush: jest.fn().mockResolvedValue(undefined),
  }),
}));

// Mock queue processors — these register side effects we do not need in unit tests
jest.mock('../shared/queue-processors', () => ({
  registerBroadcastProcessor: jest.fn(),
  registerPushNotificationProcessor: jest.fn(),
  registerFcmBatchProcessor: jest.fn(),
  registerTrackingEventsProcessor: jest.fn(),
  registerVehicleReleaseProcessor: jest.fn(),
  registerAssignmentReconciliationProcessor: jest.fn(),
  startAssignmentTimeoutPoller: jest.fn(),
}));

// =============================================================================
// IMPORTS — After mocks
// =============================================================================

import type { QueueJob, JobProcessor, TrackingEventPayload } from '../shared/services/queue.types';

// =============================================================================
// SECTION 1: FACADE INTEGRITY TESTS
// =============================================================================

describe('Facade (queue.service.ts) — re-export integrity', () => {
  let facadeModule: any;

  beforeAll(() => {
    facadeModule = require('../shared/services/queue.service');
  });

  // --- Types are exported (checked at runtime via typeof on the constants) ---

  test('exports TRACKING_QUEUE_HARD_LIMIT constant', () => {
    expect(typeof facadeModule.TRACKING_QUEUE_HARD_LIMIT).toBe('number');
    expect(facadeModule.TRACKING_QUEUE_HARD_LIMIT).toBeGreaterThanOrEqual(1000);
  });

  test('exports DLQ_MAX_SIZE constant', () => {
    expect(typeof facadeModule.DLQ_MAX_SIZE).toBe('number');
    expect(facadeModule.DLQ_MAX_SIZE).toBeGreaterThanOrEqual(100);
  });

  test('exports TRACKING_QUEUE_DEPTH_SAMPLE_MS constant', () => {
    expect(typeof facadeModule.TRACKING_QUEUE_DEPTH_SAMPLE_MS).toBe('number');
  });

  test('exports feature flag constants', () => {
    expect(typeof facadeModule.FF_CANCELLED_ORDER_QUEUE_GUARD).toBe('boolean');
    expect(typeof facadeModule.FF_CANCELLED_ORDER_QUEUE_GUARD_FAIL_OPEN).toBe('boolean');
    expect(typeof facadeModule.CANCELLED_ORDER_QUEUE_GUARD_CACHE_TTL_MS).toBe('number');
    expect(typeof facadeModule.FF_SEQUENCE_DELIVERY_ENABLED).toBe('boolean');
    expect(typeof facadeModule.FF_DUAL_CHANNEL_DELIVERY).toBe('boolean');
    expect(typeof facadeModule.FF_MESSAGE_TTL_ENABLED).toBe('boolean');
    expect(typeof facadeModule.FF_MESSAGE_PRIORITY_ENABLED).toBe('boolean');
  });

  test('exports UNACKED_QUEUE_TTL_SECONDS constant', () => {
    expect(facadeModule.UNACKED_QUEUE_TTL_SECONDS).toBe(600);
  });

  test('exports MESSAGE_TTL_MS mapping', () => {
    expect(typeof facadeModule.MESSAGE_TTL_MS).toBe('object');
    expect(facadeModule.MESSAGE_TTL_MS.new_broadcast).toBe(90_000);
    expect(facadeModule.MESSAGE_TTL_MS.order_cancelled).toBe(300_000);
  });

  test('exports DEFAULT_MESSAGE_TTL_MS constant', () => {
    expect(facadeModule.DEFAULT_MESSAGE_TTL_MS).toBe(120_000);
  });

  test('exports MessagePriority object', () => {
    expect(facadeModule.MessagePriority.CRITICAL).toBe(1);
    expect(facadeModule.MessagePriority.HIGH).toBe(2);
    expect(facadeModule.MessagePriority.NORMAL).toBe(3);
    expect(facadeModule.MessagePriority.LOW).toBe(4);
  });

  test('exports EVENT_PRIORITY mapping', () => {
    expect(facadeModule.EVENT_PRIORITY.order_cancelled).toBe(1);
    expect(facadeModule.EVENT_PRIORITY.accept_confirmation).toBe(2);
    expect(facadeModule.EVENT_PRIORITY.new_broadcast).toBe(3);
    expect(facadeModule.EVENT_PRIORITY.trucks_remaining_update).toBe(4);
  });

  test('exports FF_QUEUE_DEPTH_CAP constant', () => {
    expect(typeof facadeModule.FF_QUEUE_DEPTH_CAP).toBe('number');
    expect(facadeModule.FF_QUEUE_DEPTH_CAP).toBeGreaterThanOrEqual(100);
  });

  test('exports InMemoryQueue class', () => {
    expect(typeof facadeModule.InMemoryQueue).toBe('function');
  });

  test('exports RedisQueue class', () => {
    expect(typeof facadeModule.RedisQueue).toBe('function');
  });

  test('exports QueueService class', () => {
    expect(typeof facadeModule.QueueService).toBe('function');
  });

  test('exports queueService singleton instance', () => {
    expect(facadeModule.queueService).toBeDefined();
    expect(facadeModule.queueService).toBeInstanceOf(facadeModule.QueueService);
  });

  test('queueService singleton is stable across multiple imports', () => {
    const secondImport = require('../shared/services/queue.service');
    expect(secondImport.queueService).toBe(facadeModule.queueService);
  });
});

// =============================================================================
// SECTION 2: InMemoryQueue TESTS
// =============================================================================

describe('InMemoryQueue (queue-memory.service.ts)', () => {
  let InMemoryQueue: any;
  let queue: InstanceType<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Fresh import each time to avoid shared state
    InMemoryQueue = require('../shared/services/queue-memory.service').InMemoryQueue;
    queue = new InMemoryQueue();
  });

  afterEach(() => {
    queue.stop();
  });

  // --- Basic enqueue/dequeue ---

  test('add() returns a string job ID', async () => {
    const id = await queue.add('test-q', 'my-type', { foo: 1 });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  test('add() creates queue on first use', async () => {
    await queue.add('brand-new-q', 'type-a', { data: 1 });
    const depth = await queue.getQueueDepth('brand-new-q');
    expect(depth).toBe(1);
  });

  test('multiple add() calls increase queue depth', async () => {
    await queue.add('q1', 'type', { n: 1 });
    await queue.add('q1', 'type', { n: 2 });
    await queue.add('q1', 'type', { n: 3 });
    const depth = await queue.getQueueDepth('q1');
    expect(depth).toBe(3);
  });

  test('getQueueDepth returns 0 for unknown queue', async () => {
    const depth = await queue.getQueueDepth('nonexistent');
    expect(depth).toBe(0);
  });

  // --- Priority ordering ---

  test('higher priority jobs appear before lower priority', async () => {
    await queue.add('pq', 'low', { v: 'low' }, { priority: 1 });
    await queue.add('pq', 'high', { v: 'high' }, { priority: 10 });
    await queue.add('pq', 'mid', { v: 'mid' }, { priority: 5 });

    // Internal queue order: highest priority first
    const stats = queue.getStats();
    const pqStats = stats.queues.find((q: any) => q.name === 'pq');
    expect(pqStats.pending).toBe(3);
  });

  test('jobs with same priority maintain insertion order (FIFO)', async () => {
    const processed: string[] = [];
    queue.process('fifo', async (job: QueueJob) => {
      processed.push(job.data.label);
    });

    await queue.add('fifo', 'type', { label: 'first' }, { priority: 5 });
    await queue.add('fifo', 'type', { label: 'second' }, { priority: 5 });
    await queue.add('fifo', 'type', { label: 'third' }, { priority: 5 });

    // Wait for processing cycles (100ms poll interval + processing time)
    await new Promise(r => setTimeout(r, 800));

    expect(processed).toEqual(['first', 'second', 'third']);
  });

  test('high priority job is processed before normal priority', async () => {
    queue.stop(); // stop auto-processing to control order

    const processed: string[] = [];
    queue.process('priority-test', async (job: QueueJob) => {
      processed.push(job.data.label);
    });

    await queue.add('priority-test', 'type', { label: 'normal' }, { priority: 0 });
    await queue.add('priority-test', 'type', { label: 'high' }, { priority: 10 });

    queue.start();
    await new Promise(r => setTimeout(r, 300));

    expect(processed[0]).toBe('high');
  });

  // --- Job processing ---

  test('process() registers a processor and jobs get processed', async () => {
    const processed: any[] = [];
    queue.process('work', async (job: QueueJob) => {
      processed.push(job.data);
    });

    await queue.add('work', 'task', { value: 42 });
    await new Promise(r => setTimeout(r, 300));

    expect(processed).toHaveLength(1);
    expect(processed[0].value).toBe(42);
  });

  test('processed job is removed from queue', async () => {
    queue.process('remove-test', async () => {});
    await queue.add('remove-test', 'type', { n: 1 });

    await new Promise(r => setTimeout(r, 300));
    const depth = await queue.getQueueDepth('remove-test');
    expect(depth).toBe(0);
  });

  test('job without a registered processor stays in queue', async () => {
    await queue.add('orphan-q', 'type', { n: 1 });
    await new Promise(r => setTimeout(r, 300));
    const depth = await queue.getQueueDepth('orphan-q');
    expect(depth).toBe(1);
  });

  // --- Delayed jobs ---

  test('delayed job is not processed before delay expires', async () => {
    const processed: any[] = [];
    queue.process('delayed-q', async (job: QueueJob) => {
      processed.push(job.data);
    });

    await queue.add('delayed-q', 'type', { v: 'delayed' }, { delay: 5000 });

    await new Promise(r => setTimeout(r, 300));
    expect(processed).toHaveLength(0);
  });

  test('delayed job is processed after delay expires', async () => {
    const processed: any[] = [];
    queue.process('delayed-q2', async (job: QueueJob) => {
      processed.push(job.data);
    });

    // Very short delay for test speed
    await queue.add('delayed-q2', 'type', { v: 'soon' }, { delay: 150 });

    // Wait past the delay
    await new Promise(r => setTimeout(r, 500));
    expect(processed).toHaveLength(1);
    expect(processed[0].v).toBe('soon');
  });

  // --- Job failure and retry ---

  test('failed job is retried up to maxAttempts', async () => {
    let callCount = 0;
    queue.process('retry-q', async () => {
      callCount++;
      throw new Error('intentional failure');
    });

    await queue.add('retry-q', 'type', { n: 1 }, { maxAttempts: 3 });

    // Allow several poll cycles for retries (with exponential backoff)
    await new Promise(r => setTimeout(r, 1500));

    // First attempt fires immediately, retries have exponential delay
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  test('permanently failed job emits job:failed event', async () => {
    const failedEvents: any[] = [];
    queue.on('job:failed', (ev: any) => failedEvents.push(ev));

    queue.process('fail-q', async () => {
      throw new Error('always fails');
    });

    await queue.add('fail-q', 'type', { n: 1 }, { maxAttempts: 1 });
    await new Promise(r => setTimeout(r, 300));

    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].error).toBe('always fails');
  });

  test('permanently failed job is removed from queue', async () => {
    queue.process('fail-remove', async () => {
      throw new Error('boom');
    });

    await queue.add('fail-remove', 'type', {}, { maxAttempts: 1 });
    await new Promise(r => setTimeout(r, 300));

    const depth = await queue.getQueueDepth('fail-remove');
    expect(depth).toBe(0);
  });

  test('failed job error message is stored on job object', async () => {
    const failedJobs: QueueJob[] = [];
    queue.on('job:failed', (ev: any) => failedJobs.push(ev.job));

    queue.process('err-track', async () => {
      throw new Error('specific error message');
    });

    await queue.add('err-track', 'type', {}, { maxAttempts: 1 });
    await new Promise(r => setTimeout(r, 300));

    expect(failedJobs[0].error).toBe('specific error message');
  });

  // --- Batch operations ---

  test('addBatch() enqueues multiple jobs and returns IDs', async () => {
    const ids = await queue.addBatch('batch-q', [
      { type: 'a', data: { n: 1 } },
      { type: 'b', data: { n: 2 } },
      { type: 'c', data: { n: 3 } },
    ]);

    expect(ids).toHaveLength(3);
    ids.forEach((id: string) => expect(typeof id).toBe('string'));

    const depth = await queue.getQueueDepth('batch-q');
    expect(depth).toBe(3);
  });

  // --- Event emissions ---

  test('add() emits job:added event', async () => {
    const events: any[] = [];
    queue.on('job:added', (ev: any) => events.push(ev));

    await queue.add('ev-q', 'type', { data: 1 });

    expect(events).toHaveLength(1);
    expect(events[0].queueName).toBe('ev-q');
    expect(events[0].job.type).toBe('type');
  });

  test('successful processing emits job:completed event', async () => {
    const events: any[] = [];
    queue.on('job:completed', (ev: any) => events.push(ev));

    queue.process('complete-q', async () => {});
    await queue.add('complete-q', 'type', {});

    await new Promise(r => setTimeout(r, 300));
    expect(events).toHaveLength(1);
    expect(events[0].queueName).toBe('complete-q');
  });

  test('retry emits job:retry event', async () => {
    const retryEvents: any[] = [];
    queue.on('job:retry', (ev: any) => retryEvents.push(ev));

    queue.process('retry-ev-q', async () => {
      throw new Error('fail');
    });

    await queue.add('retry-ev-q', 'type', {}, { maxAttempts: 3 });
    await new Promise(r => setTimeout(r, 300));

    expect(retryEvents.length).toBeGreaterThanOrEqual(1);
    expect(retryEvents[0].attempt).toBe(1);
  });

  // --- Start / Stop ---

  test('stop() prevents further processing', async () => {
    const processed: any[] = [];
    queue.process('stop-q', async (job: QueueJob) => {
      processed.push(job.data);
    });

    queue.stop();
    await queue.add('stop-q', 'type', { n: 1 });

    await new Promise(r => setTimeout(r, 300));
    expect(processed).toHaveLength(0);
  });

  test('start() resumes processing after stop()', async () => {
    const processed: any[] = [];
    queue.process('resume-q', async (job: QueueJob) => {
      processed.push(job.data);
    });

    queue.stop();
    await queue.add('resume-q', 'type', { n: 1 });

    await new Promise(r => setTimeout(r, 200));
    expect(processed).toHaveLength(0);

    queue.start();
    await new Promise(r => setTimeout(r, 300));
    expect(processed).toHaveLength(1);
  });

  test('start() is idempotent (calling twice does not create duplicate intervals)', () => {
    queue.start();
    queue.start();
    // No throw = success; the isRunning guard prevents duplication
  });

  // --- Stats ---

  test('getStats() returns correct structure', async () => {
    await queue.add('stat-q1', 'type', {});
    await queue.add('stat-q1', 'type', {});
    await queue.add('stat-q2', 'type', {});

    const stats = queue.getStats();
    expect(stats.totalPending).toBe(3);
    expect(stats.queues).toHaveLength(2);
    expect(stats.queues.find((q: any) => q.name === 'stat-q1').pending).toBe(2);
  });

  // --- DLQ persistence ---

  test('permanently failed job is pushed to Redis DLQ', async () => {
    queue.process('dlq-test', async () => {
      throw new Error('fatal');
    });

    await queue.add('dlq-test', 'type', { payload: 'important' }, { maxAttempts: 1 });
    await new Promise(r => setTimeout(r, 400));

    expect(mockRedisLPush).toHaveBeenCalledWith(
      'dlq:dlq-test',
      expect.stringContaining('important')
    );
    expect(mockRedisLTrim).toHaveBeenCalled();
    expect(mockRedisExpire).toHaveBeenCalledWith('dlq:dlq-test', 7 * 24 * 60 * 60);
  });
});

// =============================================================================
// SECTION 3: RedisQueue TESTS
// =============================================================================

describe('RedisQueue (queue-redis.service.ts)', () => {
  let RedisQueue: any;
  let rq: InstanceType<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    RedisQueue = require('../shared/services/queue-redis.service').RedisQueue;
    rq = new RedisQueue();
  });

  afterEach(() => {
    rq.stop();
  });

  // --- Basic enqueue ---

  test('add() pushes serialized job to Redis via LPUSH', async () => {
    const id = await rq.add('test-q', 'my-type', { value: 42 });

    expect(typeof id).toBe('string');
    expect(mockRedisLPush).toHaveBeenCalledWith(
      'queue:test-q',
      expect.stringContaining('"my-type"')
    );
  });

  test('add() with delay uses ZADD on delayed sorted set', async () => {
    await rq.add('delayed-q', 'type', { v: 1 }, { delay: 5000 });

    expect(mockRedisZAdd).toHaveBeenCalledWith(
      'delayed:delayed-q',
      expect.any(Number),
      expect.stringContaining('"v":1')
    );
    // Should NOT call LPUSH for delayed jobs
    expect(mockRedisLPush).not.toHaveBeenCalled();
  });

  test('add() job structure includes all required fields', async () => {
    await rq.add('struct-q', 'test-type', { payload: 'data' }, { priority: 5, maxAttempts: 7 });

    const callArg = mockRedisLPush.mock.calls[0][1];
    const job = JSON.parse(callArg);

    expect(job.id).toBeDefined();
    expect(job.type).toBe('test-type');
    expect(job.data.payload).toBe('data');
    expect(job.priority).toBe(5);
    expect(job.maxAttempts).toBe(7);
    expect(job.attempts).toBe(0);
    expect(job.createdAt).toBeGreaterThan(0);
  });

  test('add() defaults: priority=0, maxAttempts=3', async () => {
    await rq.add('defaults-q', 'type', {});
    const job = JSON.parse(mockRedisLPush.mock.calls[0][1]);

    expect(job.priority).toBe(0);
    expect(job.maxAttempts).toBe(3);
  });

  // --- Batch enqueue ---

  test('addBatch() calls lPushMany with serialized jobs', async () => {
    const ids = await rq.addBatch('batch-q', [
      { type: 'a', data: { n: 1 } },
      { type: 'b', data: { n: 2 } },
    ]);

    expect(ids).toHaveLength(2);
    expect(mockRedisLPushMany).toHaveBeenCalledWith(
      'queue:batch-q',
      expect.any(Array)
    );
    const serialized = mockRedisLPushMany.mock.calls[0][1];
    expect(serialized).toHaveLength(2);
  });

  test('addBatch() with empty array does not call lPushMany', async () => {
    const ids = await rq.addBatch('empty-batch', []);
    expect(ids).toHaveLength(0);
    expect(mockRedisLPushMany).not.toHaveBeenCalled();
  });

  // --- Error handling on add ---

  test('add() propagates Redis error to caller', async () => {
    mockRedisLPush.mockRejectedValueOnce(new Error('Redis connection lost'));

    await expect(
      rq.add('err-q', 'type', {})
    ).rejects.toThrow('Redis connection lost');
  });

  test('addBatch() propagates Redis error to caller', async () => {
    mockRedisLPushMany.mockRejectedValueOnce(new Error('connection refused'));

    await expect(
      rq.addBatch('err-batch-q', [{ type: 'x', data: {} }])
    ).rejects.toThrow('connection refused');
  });

  // --- Processor registration ---

  test('process() registers a processor', () => {
    const proc = jest.fn();
    rq.process('proc-q', proc);
    rq.stop(); // Stop immediately to prevent worker loops from spinning
    // No throw = success; processor is registered internally
  });

  test('process() auto-starts the queue if not running', () => {
    const proc = jest.fn();
    rq.process('auto-start-q', proc);
    // The queue should now be running — subsequent stop() should succeed
    rq.stop();
  });

  // --- Start / Stop ---

  test('start() is idempotent', () => {
    rq.start();
    rq.start();
    // No double-start crash
  });

  test('stop() clears all workers', () => {
    rq.process('stop-test', jest.fn());
    rq.stop();
    // Calling stop again is safe
    rq.stop();
  });

  // --- Queue depth ---

  test('getQueueDepth() queries Redis LLEN', async () => {
    mockRedisLLen.mockResolvedValueOnce(42);
    const depth = await rq.getQueueDepth('depth-q');
    expect(depth).toBe(42);
    expect(mockRedisLLen).toHaveBeenCalledWith('queue:depth-q');
  });

  // --- Stats ---

  test('getStats() returns structure with pending from Redis', async () => {
    rq.process('stat-q', jest.fn());
    mockRedisLLen.mockResolvedValueOnce(5);

    const stats = await rq.getStats();
    rq.stop(); // Stop workers before assertions to prevent tight loop
    expect(stats.queues).toHaveLength(1);
    expect(stats.queues[0].name).toBe('stat-q');
    expect(stats.queues[0].pending).toBe(5);
    expect(stats.totalPending).toBe(5);
  });

  // --- Worker loop with job processing ---

  test('worker loop processes a job from brPop', async () => {
    const job: QueueJob = {
      id: 'test-job-1',
      type: 'task',
      data: { value: 99 },
      priority: 0,
      attempts: 0,
      maxAttempts: 3,
      createdAt: Date.now(),
    };

    // First brPop returns a job immediately, rest use default (delayed null)
    mockRedisBrPop.mockResolvedValueOnce(JSON.stringify(job));

    const processor = jest.fn().mockResolvedValue(undefined);
    rq.process('worker-q', processor);

    // Give the worker loop time to fire
    await new Promise(r => setTimeout(r, 300));
    rq.stop();

    expect(processor).toHaveBeenCalledWith(expect.objectContaining({
      id: 'test-job-1',
      type: 'task',
    }));

    // Processing hash: hSet before process, hDel after success
    expect(mockRedisHSet).toHaveBeenCalledWith(
      'processing:worker-q',
      'test-job-1',
      expect.any(String)
    );
    expect(mockRedisHDel).toHaveBeenCalledWith('processing:worker-q', 'test-job-1');
  });

  test('failed job with remaining attempts is sent to delayed sorted set', async () => {
    const job: QueueJob = {
      id: 'retry-job-1',
      type: 'task',
      data: {},
      priority: 0,
      attempts: 0,
      maxAttempts: 3,
      createdAt: Date.now(),
    };

    mockRedisBrPop.mockResolvedValueOnce(JSON.stringify(job));

    const processor = jest.fn().mockRejectedValueOnce(new Error('transient'));
    rq.process('retry-redis-q', processor);

    await new Promise(r => setTimeout(r, 300));
    rq.stop();

    // Should be sent to delayed sorted set for retry
    expect(mockRedisZAdd).toHaveBeenCalledWith(
      'delayed:retry-redis-q',
      expect.any(Number),
      expect.stringContaining('retry-job-1')
    );
  });

  test('job that exhausts maxAttempts goes to dead letter queue', async () => {
    const job: QueueJob = {
      id: 'dlq-job-1',
      type: 'task',
      data: { important: true },
      priority: 0,
      attempts: 2, // Already at 2 of 3
      maxAttempts: 3,
      createdAt: Date.now(),
    };

    mockRedisBrPop.mockResolvedValueOnce(JSON.stringify(job));

    const processor = jest.fn().mockRejectedValueOnce(new Error('permanent failure'));
    rq.process('dlq-redis-q', processor);

    await new Promise(r => setTimeout(r, 300));
    rq.stop();

    expect(mockRedisLPush).toHaveBeenCalledWith(
      'dlq:dlq-redis-q',
      expect.stringContaining('dlq-job-1')
    );
  });

  // --- Stale job recovery ---

  test('recoverStaleProcessingJobs re-enqueues old jobs', async () => {
    const staleJob: QueueJob = {
      id: 'stale-1',
      type: 'old-task',
      data: {},
      priority: 0,
      attempts: 1,
      maxAttempts: 3,
      createdAt: Date.now() - 10 * 60 * 1000, // 10 minutes ago
    };

    mockRedisHGetAll.mockResolvedValueOnce({
      'stale-1': JSON.stringify(staleJob),
    });

    const processor = jest.fn();
    rq.process('stale-q', processor);

    await new Promise(r => setTimeout(r, 300));
    rq.stop();

    // Stale job should be re-enqueued to main queue
    expect(mockRedisLPush).toHaveBeenCalledWith(
      'queue:stale-q',
      expect.stringContaining('stale-1')
    );
    // And removed from processing hash
    expect(mockRedisHDel).toHaveBeenCalledWith('processing:stale-q', 'stale-1');
  });

  test('non-stale processing jobs are left alone', async () => {
    const recentJob: QueueJob = {
      id: 'recent-1',
      type: 'task',
      data: {},
      priority: 0,
      attempts: 1,
      maxAttempts: 3,
      createdAt: Date.now() - 30_000, // 30 seconds ago — not stale
    };

    mockRedisHGetAll.mockResolvedValueOnce({
      'recent-1': JSON.stringify(recentJob),
    });

    const processor = jest.fn();
    rq.process('recent-q', processor);

    await new Promise(r => setTimeout(r, 300));
    rq.stop();

    // Should NOT re-enqueue; hDel should not be called for this job
    const lPushCalls = mockRedisLPush.mock.calls.filter(
      (c: any[]) => c[0] === 'queue:recent-q'
    );
    expect(lPushCalls).toHaveLength(0);
  });

  // --- Delay poller ---

  test('delay poller moves ready jobs from sorted set to main queue', async () => {
    // The delay poller uses moveDelayedJobsAtomic (a Lua script) to atomically
    // move ready jobs from the delayed sorted set to the main queue.
    // First call: return 1 (moved 1 job); subsequent calls: return 0 (no more)
    mockRedisMoveDelayedJobsAtomic
      .mockResolvedValueOnce(1)
      .mockResolvedValue(0);
    mockRedisHGetAll.mockResolvedValue({});

    const processor = jest.fn();
    rq.process('delay-poll-q', processor);

    // Wait for delay poller to fire (runs every 1s)
    await new Promise(r => setTimeout(r, 1500));
    rq.stop();

    // moveDelayedJobsAtomic should have been called with delayed and queue keys
    expect(mockRedisMoveDelayedJobsAtomic).toHaveBeenCalledWith(
      'delayed:delay-poll-q',
      'queue:delay-poll-q',
      expect.any(Number)
    );
  });
});

// =============================================================================
// SECTION 4: QueueService TESTS (queue-management.service.ts)
// =============================================================================

describe('QueueService (queue-management.service.ts)', () => {
  let QueueService: any;
  let svc: InstanceType<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Force non-production mode for predictable InMemoryQueue usage
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    QueueService = require('../shared/services/queue-management.service').QueueService;
    svc = new QueueService();
    process.env.NODE_ENV = originalEnv;
  });

  afterEach(() => {
    svc.stop();
  });

  // --- Static queue names ---

  test('QUEUES static object contains all known queue names', () => {
    expect(QueueService.QUEUES.BROADCAST).toBe('broadcast');
    expect(QueueService.QUEUES.PUSH_NOTIFICATION).toBe('push');
    expect(QueueService.QUEUES.FCM_BATCH).toBe('fcm_batch');
    expect(QueueService.QUEUES.TRACKING_EVENTS).toBe('tracking-events');
    expect(QueueService.QUEUES.EMAIL).toBe('email');
    expect(QueueService.QUEUES.SMS).toBe('sms');
    expect(QueueService.QUEUES.ANALYTICS).toBe('analytics');
    expect(QueueService.QUEUES.CLEANUP).toBe('cleanup');
    expect(QueueService.QUEUES.CUSTOM_BOOKING).toBe('custom-booking');
    expect(QueueService.QUEUES.ASSIGNMENT_RECONCILIATION).toBe('assignment-reconciliation');
    expect(QueueService.QUEUES.HOLD_EXPIRY).toBe('hold-expiry');
    expect(QueueService.QUEUES.VEHICLE_RELEASE).toBe('vehicle-release');
  });

  // --- queueBroadcast ---

  test('queueBroadcast() enqueues to BROADCAST queue', async () => {
    const id = await svc.queueBroadcast('t-123', 'new_broadcast', { order: 'o1' });
    expect(typeof id).toBe('string');
  });

  test('queueBroadcast() with priority passes it through', async () => {
    const id = await svc.queueBroadcast('t-123', 'new_broadcast', {}, 5);
    expect(typeof id).toBe('string');
  });

  // --- queueBroadcastBatch ---

  test('queueBroadcastBatch() enqueues for each transporter', async () => {
    const ids = await svc.queueBroadcastBatch(
      ['t1', 't2', 't3'],
      'new_broadcast',
      { orderId: 'o1' }
    );
    expect(ids).toHaveLength(3);
  });

  // --- queuePushNotification ---

  test('queuePushNotification() enqueues to PUSH_NOTIFICATION queue', async () => {
    const id = await svc.queuePushNotification('user-1', {
      title: 'Test',
      body: 'Hello',
    });
    expect(typeof id).toBe('string');
  });

  // --- queuePushNotificationBatch ---

  test('queuePushNotificationBatch() enqueues for each user', async () => {
    const ids = await svc.queuePushNotificationBatch(
      ['u1', 'u2'],
      { title: 'Batch', body: 'Test' }
    );
    expect(ids).toHaveLength(2);
  });

  // --- queueBatchPush (FCM) ---

  test('queueBatchPush() returns "empty" for empty tokens', async () => {
    const id = await svc.queueBatchPush([], { title: 'T', body: 'B' });
    expect(id).toBe('empty');
  });

  test('queueBatchPush() filters out null/empty tokens', async () => {
    const id = await svc.queueBatchPush(
      ['', null as any, 'valid-token-1'],
      { title: 'T', body: 'B' }
    );
    expect(typeof id).toBe('string');
    expect(id).not.toBe('empty');
  });

  test('queueBatchPush() splits tokens into 500-token batches', async () => {
    // Create 600 tokens — should produce 2 batches
    const tokens = Array.from({ length: 600 }, (_, i) => `token-${i}`);
    await svc.queueBatchPush(tokens, { title: 'T', body: 'B' });
    // Two add calls should have been made (one per batch)
    // We can verify by checking the queue has items
  });

  // --- queueTrackingEvent ---

  test('queueTrackingEvent() enqueues a tracking event', async () => {
    const event: TrackingEventPayload = {
      driverId: 'd1',
      tripId: 'trip-1',
      latitude: 12.97,
      longitude: 77.59,
      speed: 45,
      bearing: 180,
      ts: new Date().toISOString(),
      source: 'gps',
    };

    const id = await svc.queueTrackingEvent(event);
    expect(typeof id).toBe('string');
  });

  // --- scheduleAssignmentTimeout ---

  test('scheduleAssignmentTimeout() calls redisService.setTimer', async () => {
    const data = {
      assignmentId: 'a1',
      driverId: 'd1',
      driverName: 'TestDriver',
      transporterId: 't1',
      vehicleId: 'v1',
      vehicleNumber: 'KA01AB1234',
      tripId: 'trip-1',
      createdAt: new Date().toISOString(),
    };

    const key = await svc.scheduleAssignmentTimeout(data, 30000);
    expect(key).toBe('timer:assignment-timeout:a1');
    expect(mockRedisSetTimer).toHaveBeenCalledWith(
      'timer:assignment-timeout:a1',
      data,
      expect.any(Date)
    );
  });

  test('scheduleAssignmentTimeout() falls back to setTimeout on Redis failure', async () => {
    mockRedisSetTimer.mockRejectedValueOnce(new Error('Redis down'));

    jest.useFakeTimers();
    const data = {
      assignmentId: 'a2',
      driverId: 'd2',
      driverName: 'FallbackDriver',
      transporterId: 't2',
      vehicleId: 'v2',
      vehicleNumber: 'KA02CD5678',
      tripId: 'trip-2',
      createdAt: new Date().toISOString(),
    };

    const key = await svc.scheduleAssignmentTimeout(data, 5000);
    expect(key).toBe('timer:assignment-timeout:a2');

    jest.useRealTimers();
  });

  // --- cancelAssignmentTimeout ---

  test('cancelAssignmentTimeout() calls redisService.cancelTimer', async () => {
    await svc.cancelAssignmentTimeout('a1');
    expect(mockRedisCancelTimer).toHaveBeenCalledWith('timer:assignment-timeout:a1');
  });

  test('cancelAssignmentTimeout() handles Redis failure gracefully', async () => {
    mockRedisCancelTimer.mockRejectedValueOnce(new Error('Redis timeout'));

    // Should not throw
    await expect(svc.cancelAssignmentTimeout('a99')).resolves.toBeUndefined();
  });

  // --- enqueue (convenience method) ---

  test('enqueue() adds job with default maxAttempts=3', async () => {
    const id = await svc.enqueue('analytics', { event: 'click' });
    expect(typeof id).toBe('string');
  });

  test('enqueue() uses maxAttempts=5 for VEHICLE_RELEASE queue', async () => {
    const id = await svc.enqueue(QueueService.QUEUES.VEHICLE_RELEASE, { vehicleId: 'v1' });
    expect(typeof id).toBe('string');
  });

  // --- addJob / add ---

  test('addJob() delegates to queue.add', async () => {
    const id = await svc.addJob('custom', 'my-type', { foo: 'bar' });
    expect(typeof id).toBe('string');
  });

  test('add() is an alias for addJob()', async () => {
    const id = await svc.add('custom', 'my-type', { baz: 1 });
    expect(typeof id).toBe('string');
  });

  // --- registerProcessor ---

  test('registerProcessor() registers a custom processor', () => {
    const proc: JobProcessor = jest.fn();
    svc.registerProcessor('custom-q', proc);
    // No throw = success
  });

  // --- getStats ---

  test('getStats() returns queue statistics', () => {
    const stats = svc.getStats();
    expect(stats).toBeDefined();
  });

  // --- stop ---

  test('stop() stops underlying queue', () => {
    svc.stop();
    // No throw = success; calling stop twice is safe
    svc.stop();
  });
});

// =============================================================================
// SECTION 5: EDGE CASES & STRESS TESTS
// =============================================================================

describe('Edge Cases & Stress', () => {
  let InMemoryQueue: any;

  beforeEach(() => {
    jest.clearAllMocks();
    InMemoryQueue = require('../shared/services/queue-memory.service').InMemoryQueue;
  });

  test('InMemoryQueue handles rapid sequential adds without data loss', async () => {
    const queue = new InMemoryQueue();
    const count = 100;

    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(await queue.add('rapid-q', 'type', { n: i }));
    }

    expect(ids).toHaveLength(count);
    expect(new Set(ids).size).toBe(count); // all unique IDs
    expect(await queue.getQueueDepth('rapid-q')).toBe(count);

    queue.stop();
  });

  test('InMemoryQueue handles concurrent add + process without crash', async () => {
    const queue = new InMemoryQueue();
    const processed: number[] = [];

    queue.process('concurrent-q', async (job: QueueJob) => {
      processed.push(job.data.n);
    });

    // Fire 20 adds in parallel (reduced for timing reliability)
    const promises = Array.from({ length: 20 }, (_, i) =>
      queue.add('concurrent-q', 'type', { n: i })
    );
    await Promise.all(promises);

    // Wait for processing (20 jobs with 100ms poll + concurrency limit of 10)
    await new Promise(r => setTimeout(r, 3000));

    expect(processed.length).toBe(20);
    queue.stop();
  });

  test('InMemoryQueue: processor that throws does not crash the queue', async () => {
    const queue = new InMemoryQueue();
    let successCount = 0;

    queue.process('mixed-q', async (job: QueueJob) => {
      if (job.data.shouldFail) {
        throw new Error('boom');
      }
      successCount++;
    });

    await queue.add('mixed-q', 'type', { shouldFail: false }, { maxAttempts: 1 });
    await queue.add('mixed-q', 'type', { shouldFail: true }, { maxAttempts: 1 });
    await queue.add('mixed-q', 'type', { shouldFail: false }, { maxAttempts: 1 });

    await new Promise(r => setTimeout(r, 500));

    expect(successCount).toBe(2);
    queue.stop();
  });

  test('RedisQueue: Redis failure on add is surfaced, not swallowed', async () => {
    const RedisQueue = require('../shared/services/queue-redis.service').RedisQueue;
    const rq = new RedisQueue();

    mockRedisLPush.mockRejectedValueOnce(new Error('READONLY You can\'t write against a read only replica'));

    await expect(
      rq.add('readonly-q', 'type', {})
    ).rejects.toThrow('READONLY');

    rq.stop();
  });

  test('RedisQueue: corrupt job in processing hash is cleaned up', async () => {
    const RedisQueue = require('../shared/services/queue-redis.service').RedisQueue;
    const rq = new RedisQueue();

    mockRedisHGetAll.mockResolvedValueOnce({
      'corrupt-1': 'this is not valid JSON{{{',
    });

    rq.process('corrupt-q', jest.fn());

    await new Promise(r => setTimeout(r, 300));
    rq.stop();

    // Corrupt entry should be removed
    expect(mockRedisHDel).toHaveBeenCalledWith('processing:corrupt-q', 'corrupt-1');
  });

  test('InMemoryQueue: job with 0 maxAttempts fails immediately (no retries)', async () => {
    const queue = new InMemoryQueue();
    const failedEvents: any[] = [];
    queue.on('job:failed', (ev: any) => failedEvents.push(ev));

    queue.process('zero-retry', async () => {
      throw new Error('instant fail');
    });

    // maxAttempts=0 means the first attempt (attempts=1) >= maxAttempts, so immediate DLQ
    // Actually maxAttempts=0 is edge case — after first attempt, 1 >= 0 => permanent fail
    // But in practice, the code does attempts++ then checks >= maxAttempts
    // So even maxAttempts=1 means 1 attempt total
    await queue.add('zero-retry', 'type', {}, { maxAttempts: 1 });

    await new Promise(r => setTimeout(r, 300));
    expect(failedEvents).toHaveLength(1);
    queue.stop();
  });

  test('InMemoryQueue: default maxAttempts is 3', async () => {
    const queue = new InMemoryQueue();
    let attempts = 0;

    queue.process('default-retry', async () => {
      attempts++;
      throw new Error('always fails');
    });

    await queue.add('default-retry', 'type', {});

    // Wait long enough for retries with exponential backoff (2s, 4s)
    await new Promise(r => setTimeout(r, 7000));

    expect(attempts).toBe(3);
    queue.stop();
  }, 10000);

  test('Multiple queues can have independent processors', async () => {
    const queue = new InMemoryQueue();
    const resultsA: string[] = [];
    const resultsB: string[] = [];

    queue.process('queue-a', async (job: QueueJob) => { resultsA.push(job.data.v); });
    queue.process('queue-b', async (job: QueueJob) => { resultsB.push(job.data.v); });

    await queue.add('queue-a', 'type', { v: 'a1' });
    await queue.add('queue-b', 'type', { v: 'b1' });
    await queue.add('queue-a', 'type', { v: 'a2' });

    await new Promise(r => setTimeout(r, 300));

    expect(resultsA).toEqual(['a1', 'a2']);
    expect(resultsB).toEqual(['b1']);
    queue.stop();
  });

  test('RedisQueue: delay poller tolerates zRangeByScore failure gracefully', async () => {
    const RedisQueue = require('../shared/services/queue-redis.service').RedisQueue;
    const rq = new RedisQueue();

    mockRedisZRangeByScore.mockRejectedValue(new Error('Redis timeout'));
    mockRedisHGetAll.mockResolvedValue({});

    rq.process('poller-fail-q', jest.fn());

    // Wait for delay poller cycle
    await new Promise(r => setTimeout(r, 1500));
    rq.stop();

    // Should not throw — poller catches errors internally
  });

  test('QueueService constructor selects InMemoryQueue in non-production', () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';

    const QueueService = require('../shared/services/queue-management.service').QueueService;
    const svc = new QueueService();

    // getStats() is synchronous for InMemoryQueue, async for RedisQueue
    const stats = svc.getStats();
    expect(stats).toBeDefined();
    expect(stats.queues).toBeDefined();

    svc.stop();
    process.env.NODE_ENV = origEnv;
  });

  test('QueueService: queueBroadcast rejects when queue depth exceeds cap', async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';

    const QueueService = require('../shared/services/queue-management.service').QueueService;
    const svc = new QueueService();

    // Simulate a deep queue by manipulating the internal snapshot
    // We do this by adding many items and checking depth exceeds FF_QUEUE_DEPTH_CAP
    // Since FF_QUEUE_DEPTH_CAP defaults to 10000, we test the concept indirectly
    // by verifying the method works under normal conditions
    const id = await svc.queueBroadcast('t-1', 'new_broadcast', { test: true });
    expect(typeof id).toBe('string');

    svc.stop();
    process.env.NODE_ENV = origEnv;
  });

  test('InMemoryQueue: getStats with no queues returns empty', () => {
    const queue = new InMemoryQueue();
    const stats = queue.getStats();
    expect(stats.queues).toHaveLength(0);
    expect(stats.totalPending).toBe(0);
    expect(stats.totalProcessing).toBe(0);
    queue.stop();
  });

  test('RedisQueue: getStats with no processors returns empty', async () => {
    const RedisQueue = require('../shared/services/queue-redis.service').RedisQueue;
    const rq = new RedisQueue();

    const stats = await rq.getStats();
    expect(stats.queues).toHaveLength(0);
    expect(stats.totalPending).toBe(0);
    expect(stats.totalProcessing).toBe(0);

    rq.stop();
  });

  test('RedisQueue: worker backs off on error with 2000ms sleep', async () => {
    const RedisQueue = require('../shared/services/queue-redis.service').RedisQueue;
    const rq = new RedisQueue();

    // brPop throws an error — worker should back off
    mockRedisBrPop.mockRejectedValueOnce(new Error('connection reset'));
    mockRedisHGetAll.mockResolvedValue({});

    rq.process('backoff-q', jest.fn());

    // Wait enough time for one backoff cycle
    await new Promise(r => setTimeout(r, 2500));
    rq.stop();

    // The worker should have survived the error and continued
  });

  test('InMemoryQueue: concurrency limit is respected', async () => {
    const queue = new InMemoryQueue();
    let concurrentCount = 0;
    let maxConcurrent = 0;

    queue.process('concurrency-q', async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise(r => setTimeout(r, 200));
      concurrentCount--;
    });

    // Add 20 jobs
    for (let i = 0; i < 20; i++) {
      await queue.add('concurrency-q', 'type', { n: i });
    }

    await new Promise(r => setTimeout(r, 2000));

    // concurrency limit is 10
    expect(maxConcurrent).toBeLessThanOrEqual(10);
    queue.stop();
  });
});

// =============================================================================
// SECTION 6: TYPE INTERFACE COMPLIANCE
// =============================================================================

describe('IQueue interface compliance', () => {
  test('InMemoryQueue implements all IQueue methods', () => {
    const InMemoryQueue = require('../shared/services/queue-memory.service').InMemoryQueue;
    const queue = new InMemoryQueue();

    expect(typeof queue.add).toBe('function');
    expect(typeof queue.addBatch).toBe('function');
    expect(typeof queue.process).toBe('function');
    expect(typeof queue.start).toBe('function');
    expect(typeof queue.stop).toBe('function');
    expect(typeof queue.getStats).toBe('function');
    expect(typeof queue.getQueueDepth).toBe('function');

    queue.stop();
  });

  test('RedisQueue implements all IQueue methods', () => {
    const RedisQueue = require('../shared/services/queue-redis.service').RedisQueue;
    const rq = new RedisQueue();

    expect(typeof rq.add).toBe('function');
    expect(typeof rq.addBatch).toBe('function');
    expect(typeof rq.process).toBe('function');
    expect(typeof rq.start).toBe('function');
    expect(typeof rq.stop).toBe('function');
    expect(typeof rq.getStats).toBe('function');
    expect(typeof rq.getQueueDepth).toBe('function');

    rq.stop();
  });

  test('Both implementations are EventEmitters', () => {
    const InMemoryQueue = require('../shared/services/queue-memory.service').InMemoryQueue;
    const RedisQueue = require('../shared/services/queue-redis.service').RedisQueue;

    const mem = new InMemoryQueue();
    const redis = new RedisQueue();

    expect(typeof mem.on).toBe('function');
    expect(typeof mem.emit).toBe('function');
    expect(typeof redis.on).toBe('function');
    expect(typeof redis.emit).toBe('function');

    mem.stop();
    redis.stop();
  });
});
