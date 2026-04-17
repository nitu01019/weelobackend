/**
 * =============================================================================
 * QUEUE SINGLE SURFACE — F-B-50 invariants
 * =============================================================================
 *
 * Following the deletion of the modular queue facade
 *   - queue-management.service.ts (712 LOC)
 *   - queue-redis.service.ts (533 LOC)
 *   - queue-memory.service.ts (297 LOC)
 * the canonical queue surface is the single file `queue.service.ts`, which
 * exports `InMemoryQueue`, `RedisQueue`, `QueueService`, and the singleton
 * `queueService`.
 *
 * This suite migrates the invariants from the old `queue-split.test.ts` to run
 * against the canonical file and adds single-surface CI guards:
 *   - exactly one `export class QueueService` in `src/`
 *   - exactly one `export const queueService` in `src/`
 *   - no production import of the deleted modular paths
 *
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — Must come before any imports
// =============================================================================

// Block @prisma/client from loading (generated module causes OOM in jest).
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
    observeHistogram: jest.fn(),
    setGauge: jest.fn(),
  },
}));

jest.mock('../config/environment', () => ({
  config: { redis: { enabled: false }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {} },
}));

// Redis service mock — all methods used by the queue module.
const mockRedisLPush = jest.fn().mockResolvedValue(1);
const mockRedisLPushMany = jest.fn().mockResolvedValue(1);
const mockRedisLLen = jest.fn().mockResolvedValue(0);
const mockRedisLTrim = jest.fn().mockResolvedValue('OK');
// brPop default: small delay simulates blocking pop so the worker loop does not
// tight-spin into an OOM-inducing microtask queue during tests.
const mockRedisBrPop = jest.fn().mockImplementation(
  () => new Promise(resolve => setTimeout(() => resolve(null), 50)),
);
const mockRedisZAdd = jest.fn().mockResolvedValue(1);
const mockRedisZRangeByScore = jest.fn().mockResolvedValue([]);
const mockRedisZRemRangeByScore = jest.fn().mockResolvedValue(0);
const mockRedisZRem = jest.fn().mockResolvedValue(1);
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
    lPush: (...args: unknown[]) => mockRedisLPush(...args),
    lPushMany: (...args: unknown[]) => mockRedisLPushMany(...args),
    lLen: (...args: unknown[]) => mockRedisLLen(...args),
    lTrim: (...args: unknown[]) => mockRedisLTrim(...args),
    brPop: (...args: unknown[]) => mockRedisBrPop(...args),
    zAdd: (...args: unknown[]) => mockRedisZAdd(...args),
    zRangeByScore: (...args: unknown[]) => mockRedisZRangeByScore(...args),
    zRemRangeByScore: (...args: unknown[]) => mockRedisZRemRangeByScore(...args),
    zRem: (...args: unknown[]) => mockRedisZRem(...args),
    hSet: (...args: unknown[]) => mockRedisHSet(...args),
    hGetAll: (...args: unknown[]) => mockRedisHGetAll(...args),
    hDel: (...args: unknown[]) => mockRedisHDel(...args),
    expire: (...args: unknown[]) => mockRedisExpire(...args),
    setTimer: (...args: unknown[]) => mockRedisSetTimer(...args),
    cancelTimer: (...args: unknown[]) => mockRedisCancelTimer(...args),
    get: (...args: unknown[]) => mockRedisGet(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
    isConnected: () => mockRedisIsConnected(),
    isRedisEnabled: jest.fn().mockReturnValue(true),
    moveDelayedJobsAtomic: (...args: unknown[]) => mockRedisMoveDelayedJobsAtomic(...args),
  },
  RedisService: jest.fn(),
  InMemoryRedisClient: jest.fn(),
  RealRedisClient: jest.fn(),
}));

// Prisma mock — order-status lookups inside QueueService.
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

jest.mock('../shared/database/prisma-client', () => ({
  getPrismaClient: jest.fn(),
  withDbTimeout: jest.fn(),
  getReadReplicaClient: jest.fn(),
  sanitizeDbError: jest.fn((e: unknown) => e),
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
  DB_POOL_CONFIG: {},
}));

jest.mock('../shared/services/tracking-stream-sink', () => ({
  createTrackingStreamSink: () => ({
    publishTrackingEvents: jest.fn().mockResolvedValue(undefined),
    flush: jest.fn().mockResolvedValue(undefined),
  }),
}));

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
import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// SECTION 1: CANONICAL FILE EXPORT INTEGRITY (was "facade integrity")
// =============================================================================

describe('queue.service.ts — canonical surface export integrity', () => {
  let canonicalModule: Record<string, unknown>;

  beforeAll(() => {
    canonicalModule = require('../shared/services/queue.service');
  });

  test('exports TRACKING_QUEUE_HARD_LIMIT constant', () => {
    expect(typeof canonicalModule.TRACKING_QUEUE_HARD_LIMIT).toBe('number');
    expect(canonicalModule.TRACKING_QUEUE_HARD_LIMIT as number).toBeGreaterThanOrEqual(1000);
  });

  test('exports DLQ_MAX_SIZE constant', () => {
    expect(typeof canonicalModule.DLQ_MAX_SIZE).toBe('number');
    expect(canonicalModule.DLQ_MAX_SIZE as number).toBeGreaterThanOrEqual(100);
  });

  test('exports TRACKING_QUEUE_DEPTH_SAMPLE_MS constant', () => {
    expect(typeof canonicalModule.TRACKING_QUEUE_DEPTH_SAMPLE_MS).toBe('number');
  });

  test('exports feature flag constants', () => {
    expect(typeof canonicalModule.FF_CANCELLED_ORDER_QUEUE_GUARD).toBe('boolean');
    expect(typeof canonicalModule.FF_CANCELLED_ORDER_QUEUE_GUARD_FAIL_OPEN).toBe('boolean');
    expect(typeof canonicalModule.CANCELLED_ORDER_QUEUE_GUARD_CACHE_TTL_MS).toBe('number');
    expect(typeof canonicalModule.FF_SEQUENCE_DELIVERY_ENABLED).toBe('boolean');
    expect(typeof canonicalModule.FF_DUAL_CHANNEL_DELIVERY).toBe('boolean');
    expect(typeof canonicalModule.FF_MESSAGE_TTL_ENABLED).toBe('boolean');
    expect(typeof canonicalModule.FF_MESSAGE_PRIORITY_ENABLED).toBe('boolean');
  });

  test('exports UNACKED_QUEUE_TTL_SECONDS constant', () => {
    expect(canonicalModule.UNACKED_QUEUE_TTL_SECONDS).toBe(600);
  });

  test('exports MESSAGE_TTL_MS mapping', () => {
    const mapping = canonicalModule.MESSAGE_TTL_MS as Record<string, number>;
    expect(typeof mapping).toBe('object');
    expect(mapping.new_broadcast).toBe(90_000);
    expect(mapping.order_cancelled).toBe(300_000);
  });

  test('exports DEFAULT_MESSAGE_TTL_MS constant', () => {
    expect(canonicalModule.DEFAULT_MESSAGE_TTL_MS).toBe(120_000);
  });

  test('exports MessagePriority object', () => {
    const priority = canonicalModule.MessagePriority as Record<string, number>;
    expect(priority.CRITICAL).toBe(1);
    expect(priority.HIGH).toBe(2);
    expect(priority.NORMAL).toBe(3);
    expect(priority.LOW).toBe(4);
  });

  test('exports EVENT_PRIORITY mapping', () => {
    const ev = canonicalModule.EVENT_PRIORITY as Record<string, number>;
    expect(ev.order_cancelled).toBe(1);
    expect(ev.accept_confirmation).toBe(2);
    expect(ev.new_broadcast).toBe(3);
    expect(ev.trucks_remaining_update).toBe(4);
  });

  test('exports FF_QUEUE_DEPTH_CAP constant', () => {
    expect(typeof canonicalModule.FF_QUEUE_DEPTH_CAP).toBe('number');
    expect(canonicalModule.FF_QUEUE_DEPTH_CAP as number).toBeGreaterThanOrEqual(100);
  });

  test('exports InMemoryQueue class', () => {
    expect(typeof canonicalModule.InMemoryQueue).toBe('function');
  });

  test('exports RedisQueue class', () => {
    expect(typeof canonicalModule.RedisQueue).toBe('function');
  });

  test('exports QueueService class', () => {
    expect(typeof canonicalModule.QueueService).toBe('function');
  });

  test('exports queueService singleton instance', () => {
    expect(canonicalModule.queueService).toBeDefined();
    expect(canonicalModule.queueService).toBeInstanceOf(canonicalModule.QueueService as any);
  });

  test('queueService singleton is stable across multiple imports', () => {
    const secondImport = require('../shared/services/queue.service');
    expect(secondImport.queueService).toBe(canonicalModule.queueService);
  });
});

// =============================================================================
// SECTION 2: SINGLE-SURFACE CI GUARDS
// =============================================================================

describe('F-B-50: single queue surface invariants', () => {
  const srcRoot = path.resolve(__dirname, '..');

  function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, acc);
      else if (entry.isFile() && full.endsWith('.ts')) acc.push(full);
    }
    return acc;
  }

  const allTsFiles = walk(srcRoot);
  const productionFiles = allTsFiles.filter(f => !f.includes(`${path.sep}__tests__${path.sep}`));

  test('exactly one `export class QueueService` exists in src/', () => {
    const matches: string[] = [];
    for (const f of productionFiles) {
      const src = fs.readFileSync(f, 'utf-8');
      if (/\bexport\s+class\s+QueueService\b/.test(src)) matches.push(f);
    }
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatch(/queue\.service\.ts$/);
  });

  test('exactly one `export const queueService` singleton exists in src/', () => {
    const matches: string[] = [];
    for (const f of productionFiles) {
      const src = fs.readFileSync(f, 'utf-8');
      if (/\bexport\s+const\s+queueService\s*=/.test(src)) matches.push(f);
    }
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatch(/queue\.service\.ts$/);
  });

  test('no production file imports the deleted modular paths', () => {
    const forbiddenPatterns = [
      /from\s+['"][^'"]*\/queue-management\.service['"]/,
      /from\s+['"][^'"]*\/queue-redis\.service['"]/,
      /from\s+['"][^'"]*\/queue-memory\.service['"]/,
      /require\(['"][^'"]*\/queue-management\.service['"]\)/,
      /require\(['"][^'"]*\/queue-redis\.service['"]\)/,
      /require\(['"][^'"]*\/queue-memory\.service['"]\)/,
    ];
    const offenders: Array<{ file: string; match: string }> = [];
    for (const f of productionFiles) {
      const src = fs.readFileSync(f, 'utf-8');
      for (const pattern of forbiddenPatterns) {
        const m = src.match(pattern);
        if (m) offenders.push({ file: f, match: m[0] });
      }
    }
    expect(offenders).toEqual([]);
  });

  test('deleted modular files do not exist on disk', () => {
    const deleted = [
      path.resolve(__dirname, '../shared/services/queue-management.service.ts'),
      path.resolve(__dirname, '../shared/services/queue-redis.service.ts'),
      path.resolve(__dirname, '../shared/services/queue-memory.service.ts'),
    ];
    for (const filePath of deleted) {
      expect(fs.existsSync(filePath)).toBe(false);
    }
  });

  test('DLQ_MAX_SIZE single source of truth lives in queue.types.ts', () => {
    const typesPath = path.resolve(__dirname, '../shared/services/queue.types.ts');
    const src = fs.readFileSync(typesPath, 'utf-8');
    expect(src).toMatch(/export const DLQ_MAX_SIZE\s*=\s*Math\.max\(100,\s*parseInt\(process\.env\.DLQ_MAX_SIZE\s*\|\|\s*'5000'/);
  });
});

// =============================================================================
// SECTION 3: InMemoryQueue behaviour (canonical)
// =============================================================================

describe('InMemoryQueue — canonical behaviour', () => {
  let InMemoryQueue: new () => {
    add: (...args: unknown[]) => Promise<string>;
    addBatch: (queueName: string, jobs: Array<{ type: string; data: unknown }>) => Promise<string[]>;
    process: (queueName: string, processor: JobProcessor) => void;
    start: () => void;
    stop: () => void;
    getStats: () => { queues: Array<{ name: string; pending: number }>; totalPending: number; totalProcessing: number };
    getQueueDepth: (queueName: string) => Promise<number>;
    on: (event: string, handler: (...args: unknown[]) => void) => void;
  };
  let queue: InstanceType<typeof InMemoryQueue>;

  beforeEach(() => {
    jest.clearAllMocks();
    ({ InMemoryQueue } = require('../shared/services/queue.service'));
    queue = new InMemoryQueue();
  });

  afterEach(() => {
    queue.stop();
  });

  test('add() returns a string job ID', async () => {
    const id = await queue.add('test-q', 'my-type', { foo: 1 });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  test('multiple add() calls increase queue depth', async () => {
    await queue.add('q1', 'type', { n: 1 });
    await queue.add('q1', 'type', { n: 2 });
    await queue.add('q1', 'type', { n: 3 });
    expect(await queue.getQueueDepth('q1')).toBe(3);
  });

  test('process() registers a processor and jobs get processed', async () => {
    const processed: unknown[] = [];
    queue.process('work', async (job: QueueJob) => {
      processed.push(job.data);
    });
    await queue.add('work', 'task', { value: 42 });
    await new Promise(r => setTimeout(r, 300));
    expect(processed).toHaveLength(1);
    expect((processed[0] as { value: number }).value).toBe(42);
  });

  test('processed job is removed from queue', async () => {
    queue.process('remove-test', async () => { /* noop */ });
    await queue.add('remove-test', 'type', { n: 1 });
    await new Promise(r => setTimeout(r, 300));
    expect(await queue.getQueueDepth('remove-test')).toBe(0);
  });

  test('addBatch() enqueues multiple jobs and returns IDs', async () => {
    const ids = await queue.addBatch('batch-q', [
      { type: 'a', data: { n: 1 } },
      { type: 'b', data: { n: 2 } },
      { type: 'c', data: { n: 3 } },
    ]);
    expect(ids).toHaveLength(3);
    ids.forEach(id => expect(typeof id).toBe('string'));
    expect(await queue.getQueueDepth('batch-q')).toBe(3);
  });

  test('permanently failed job is pushed to Redis DLQ', async () => {
    queue.process('dlq-test', async () => {
      throw new Error('fatal');
    });
    await queue.add('dlq-test', 'type', { payload: 'important' }, { maxAttempts: 1 });
    await new Promise(r => setTimeout(r, 400));

    expect(mockRedisLPush).toHaveBeenCalledWith(
      'dlq:dlq-test',
      expect.stringContaining('important'),
    );
    expect(mockRedisLTrim).toHaveBeenCalled();
    expect(mockRedisExpire).toHaveBeenCalledWith('dlq:dlq-test', 7 * 24 * 60 * 60);
  });

  test('getStats() returns correct structure', async () => {
    await queue.add('stat-q1', 'type', {});
    await queue.add('stat-q1', 'type', {});
    await queue.add('stat-q2', 'type', {});
    const stats = queue.getStats();
    expect(stats.totalPending).toBe(3);
    expect(stats.queues).toHaveLength(2);
    expect(stats.queues.find(q => q.name === 'stat-q1')?.pending).toBe(2);
  });
});

// =============================================================================
// SECTION 4: QueueService behaviour (canonical)
// =============================================================================

describe('QueueService — canonical behaviour', () => {
  let QueueService: new () => {
    stop: () => void;
    queueBroadcast: (transporterId: string, type: string, data: unknown, priority?: number) => Promise<string>;
    queueBroadcastBatch: (transporterIds: string[], type: string, data: unknown) => Promise<string[]>;
    queuePushNotification: (userId: string, notification: { title: string; body: string }) => Promise<string>;
    queuePushNotificationBatch: (userIds: string[], notification: { title: string; body: string }) => Promise<string[]>;
    queueBatchPush: (tokens: Array<string | null>, notification: { title: string; body: string }) => Promise<string>;
    queueTrackingEvent: (event: TrackingEventPayload) => Promise<string>;
    scheduleAssignmentTimeout: (data: Record<string, unknown>, delayMs: number) => Promise<string>;
    cancelAssignmentTimeout: (assignmentId: string) => Promise<void>;
    enqueue: (queueName: string, data: unknown) => Promise<string>;
    addJob: (queueName: string, type: string, data: unknown) => Promise<string>;
    add: (queueName: string, type: string, data: unknown) => Promise<string>;
    registerProcessor: (queueName: string, processor: JobProcessor) => void;
    getStats: () => unknown;
  };
  let svc: InstanceType<typeof QueueService>;

  beforeEach(() => {
    jest.clearAllMocks();
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    ({ QueueService } = require('../shared/services/queue.service'));
    svc = new QueueService();
    process.env.NODE_ENV = originalEnv;
  });

  afterEach(() => {
    svc.stop();
  });

  test('QUEUES static object contains all known queue names', () => {
    const Q = (QueueService as any).QUEUES;
    expect(Q.BROADCAST).toBe('broadcast');
    expect(Q.PUSH_NOTIFICATION).toBe('push');
    expect(Q.FCM_BATCH).toBe('fcm_batch');
    expect(Q.TRACKING_EVENTS).toBe('tracking-events');
    expect(Q.EMAIL).toBe('email');
    expect(Q.SMS).toBe('sms');
    expect(Q.ANALYTICS).toBe('analytics');
    expect(Q.CLEANUP).toBe('cleanup');
    expect(Q.CUSTOM_BOOKING).toBe('custom-booking');
    expect(Q.ASSIGNMENT_RECONCILIATION).toBe('assignment-reconciliation');
    expect(Q.HOLD_EXPIRY).toBe('hold-expiry');
    expect(Q.VEHICLE_RELEASE).toBe('vehicle-release');
  });

  test('queueBroadcast() enqueues to BROADCAST queue', async () => {
    const id = await svc.queueBroadcast('t-123', 'new_broadcast', { order: 'o1' });
    expect(typeof id).toBe('string');
  });

  test('queueBroadcastBatch() enqueues for each transporter', async () => {
    const ids = await svc.queueBroadcastBatch(['t1', 't2', 't3'], 'new_broadcast', { orderId: 'o1' });
    expect(ids).toHaveLength(3);
  });

  test('queuePushNotification() enqueues to PUSH_NOTIFICATION queue', async () => {
    const id = await svc.queuePushNotification('user-1', { title: 'Test', body: 'Hello' });
    expect(typeof id).toBe('string');
  });

  test('queuePushNotificationBatch() enqueues for each user', async () => {
    const ids = await svc.queuePushNotificationBatch(['u1', 'u2'], { title: 'Batch', body: 'Test' });
    expect(ids).toHaveLength(2);
  });

  test('queueBatchPush() returns "empty" for empty tokens', async () => {
    const id = await svc.queueBatchPush([], { title: 'T', body: 'B' });
    expect(id).toBe('empty');
  });

  test('queueBatchPush() filters out null/empty tokens', async () => {
    const id = await svc.queueBatchPush(['', null, 'valid-token-1'], { title: 'T', body: 'B' });
    expect(typeof id).toBe('string');
    expect(id).not.toBe('empty');
  });

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

  test('enqueue() adds job to arbitrary queue', async () => {
    const id = await svc.enqueue('analytics', { event: 'click' });
    expect(typeof id).toBe('string');
  });

  test('enqueue() works for VEHICLE_RELEASE queue', async () => {
    const id = await svc.enqueue((QueueService as any).QUEUES.VEHICLE_RELEASE, { vehicleId: 'v1' });
    expect(typeof id).toBe('string');
  });

  test('addJob() delegates to queue.add', async () => {
    const id = await svc.addJob('custom', 'my-type', { foo: 'bar' });
    expect(typeof id).toBe('string');
  });

  test('add() is an alias for addJob()', async () => {
    const id = await svc.add('custom', 'my-type', { baz: 1 });
    expect(typeof id).toBe('string');
  });

  test('registerProcessor() registers a custom processor', () => {
    const proc: JobProcessor = jest.fn() as unknown as JobProcessor;
    svc.registerProcessor('custom-q', proc);
    // No throw = success
  });

  test('getStats() returns queue statistics', () => {
    const stats = svc.getStats();
    expect(stats).toBeDefined();
  });

  test('stop() is idempotent', () => {
    svc.stop();
    svc.stop();
    // No throw = success
  });
});
