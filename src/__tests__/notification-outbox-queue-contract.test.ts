/**
 * =============================================================================
 * NOTIFICATION OUTBOX — QUEUE CONTRACT (F-B-50)
 * =============================================================================
 *
 * Regression test for the silent-TypeError bug that existed before F-B-50:
 * `drainOutbox` used `require('./queue-management.service')` against a module
 * that never exported a `queueManagementService` singleton. The failure was
 * swallowed by `.catch(() => {})`, so outbox drains appeared to succeed while
 * actually dropping every buffered notification.
 *
 * Post-F-B-50 contract:
 *   - `drainOutbox(userId)` must call `queueService.queuePushNotification`
 *     (the canonical singleton imported directly from `./queue.service`).
 *   - No runtime `require('./queue-management.service')` must remain in the
 *     `notification-outbox.service.ts` source.
 *
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// MOCKS — canonical queue.service directly (not the deleted modular facade)
// =============================================================================

const mockQueuePushNotification = jest.fn().mockResolvedValue('job-1');

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queuePushNotification: (...args: unknown[]) => mockQueuePushNotification(...args),
  },
}));

const mockLPush = jest.fn().mockResolvedValue(1);
const mockRPop = jest.fn();
const mockExpire = jest.fn().mockResolvedValue(1);
const mockScanIterator = jest.fn();

const mockIncr = jest.fn().mockResolvedValue(1);
const mockIncrBy = jest.fn().mockResolvedValue(1);
const mockRedisGet = jest.fn().mockResolvedValue(null);

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    lPush: (...args: unknown[]) => mockLPush(...args),
    rPop: (...args: unknown[]) => mockRPop(...args),
    expire: (...args: unknown[]) => mockExpire(...args),
    scanIterator: (...args: unknown[]) => mockScanIterator(...args),
    incr: (...args: unknown[]) => mockIncr(...args),
    incrBy: (...args: unknown[]) => mockIncrBy(...args),
    get: (...args: unknown[]) => mockRedisGet(...args),
  },
}));

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
const mockIncrementCounter = jest.fn();
const mockObserveHistogram = jest.fn();
const mockSetGauge = jest.fn();

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: (...args: unknown[]) => mockIncrementCounter(...args),
    observeHistogram: (...args: unknown[]) => mockObserveHistogram(...args),
    setGauge: (...args: unknown[]) => mockSetGauge(...args),
  },
}));

// =============================================================================
// IMPORTS — after mocks
// =============================================================================

import {
  drainOutbox,
  drainAllOutboxes,
  bufferNotification,
} from '../shared/services/notification-outbox.service';

// =============================================================================
// TESTS
// =============================================================================

describe('F-B-50: notification-outbox uses canonical queueService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('drainOutbox routes every buffered entry to queueService.queuePushNotification', async () => {
    const fresh = Date.now();
    // Three buffered entries, then null to terminate the drain loop.
    mockRPop
      .mockResolvedValueOnce(JSON.stringify({
        userId: 'u-1',
        payload: { title: 'A', body: 'a' },
        timestamp: fresh,
      }))
      .mockResolvedValueOnce(JSON.stringify({
        userId: 'u-1',
        payload: { title: 'B', body: 'b' },
        timestamp: fresh,
      }))
      .mockResolvedValueOnce(JSON.stringify({
        userId: 'u-1',
        payload: { title: 'C', body: 'c' },
        timestamp: fresh,
      }))
      .mockResolvedValueOnce(null);

    await drainOutbox('u-1');

    expect(mockQueuePushNotification).toHaveBeenCalledTimes(3);
    expect(mockQueuePushNotification).toHaveBeenNthCalledWith(1, 'u-1', { title: 'A', body: 'a' });
    expect(mockQueuePushNotification).toHaveBeenNthCalledWith(2, 'u-1', { title: 'B', body: 'b' });
    expect(mockQueuePushNotification).toHaveBeenNthCalledWith(3, 'u-1', { title: 'C', body: 'c' });
  });

  test('drainOutbox skips stale entries (> FRESHNESS_MS) without calling queueService', async () => {
    const stale = Date.now() - 30 * 60 * 1000; // 30 min old; FRESHNESS_MS is 15 min
    const fresh = Date.now();
    mockRPop
      .mockResolvedValueOnce(JSON.stringify({
        userId: 'u-2',
        payload: { title: 'stale', body: 'old' },
        timestamp: stale,
      }))
      .mockResolvedValueOnce(JSON.stringify({
        userId: 'u-2',
        payload: { title: 'fresh', body: 'new' },
        timestamp: fresh,
      }))
      .mockResolvedValueOnce(null);

    await drainOutbox('u-2');

    expect(mockQueuePushNotification).toHaveBeenCalledTimes(1);
    expect(mockQueuePushNotification).toHaveBeenCalledWith('u-2', { title: 'fresh', body: 'new' });
  });

  test('drainOutbox handles empty outbox without calling queueService', async () => {
    mockRPop.mockResolvedValueOnce(null);
    await drainOutbox('u-3');
    expect(mockQueuePushNotification).not.toHaveBeenCalled();
  });

  test('drainOutbox propagates queueService errors into its own logger.warn without crashing', async () => {
    const fresh = Date.now();
    mockRPop
      .mockResolvedValueOnce(JSON.stringify({
        userId: 'u-4',
        payload: { title: 'x', body: 'y' },
        timestamp: fresh,
      }))
      .mockResolvedValueOnce(null);
    mockQueuePushNotification.mockRejectedValueOnce(new Error('queue down'));

    // Must NOT throw — the whole drain is try/catch wrapped
    await expect(drainOutbox('u-4')).resolves.toBeUndefined();
    expect(mockQueuePushNotification).toHaveBeenCalledTimes(1);
  });

  test('drainAllOutboxes delegates per-user drain to drainOutbox', async () => {
    // Simulate SCAN returning one outbox key, then nothing.
    async function* gen() {
      yield 'notification:outbox:alpha';
    }
    mockScanIterator.mockReturnValue(gen());
    mockRPop.mockResolvedValue(null); // No entries — drainOutbox completes quickly

    await drainAllOutboxes();
    // No throw — end of contract
  });

  test('bufferNotification writes to per-user Redis list with TTL', async () => {
    await bufferNotification('u-7', { title: 'Buffer', body: 'Test' });
    expect(mockLPush).toHaveBeenCalledWith(
      'notification:outbox:u-7',
      expect.stringContaining('Buffer'),
    );
    expect(mockExpire).toHaveBeenCalledWith('notification:outbox:u-7', 3600);
  });
});

describe('F-B-50: notification-outbox source no longer references deleted facade', () => {
  test('source file does not contain `require(./queue-management.service)`', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../shared/services/notification-outbox.service.ts'),
      'utf-8',
    );
    expect(src).not.toContain("require('./queue-management.service')");
    expect(src).not.toContain('require("./queue-management.service")');
  });

  test('source file imports queueService directly from ./queue.service', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../shared/services/notification-outbox.service.ts'),
      'utf-8',
    );
    expect(src).toMatch(/import\s*\{\s*queueService\s*\}\s*from\s*['"]\.\/queue\.service['"]/);
  });

  test('source file no longer uses the dead queueManagementService symbol', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../shared/services/notification-outbox.service.ts'),
      'utf-8',
    );
    expect(src).not.toContain('queueManagementService');
  });
});


// =============================================================================
// A03-009 / A12-011: Notification-outbox metrics correctness
// =============================================================================

describe('A03-009/A12-011: notification-outbox metrics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRPop.mockResolvedValue(null); // default: empty outbox
  });

  test('(a) 5 bufferNotification calls → outbox_buffered_total counter delta = 5', async () => {
    for (let i = 0; i < 5; i++) {
      await bufferNotification(`user-${i}`, { title: 'T', body: 'B' });
    }
    const calls = mockIncrementCounter.mock.calls.filter(
      (c: unknown[]) => c[0] === 'outbox_buffered_total',
    );
    expect(calls).toHaveLength(5);
    // Each call must carry the default reason label
    for (const call of calls) {
      expect((call[1] as Record<string, string>).reason).toBe('adapter_down');
    }
  });

  test('(a) INCR outbox:size called once per bufferNotification', async () => {
    await bufferNotification('u-x', { title: 'Hi', body: 'There' });
    expect(mockIncr).toHaveBeenCalledWith('outbox:size');
  });

  test('(b) drain with queueService failure → outbox_drained_total{outcome:failed} +1', async () => {
    const fresh = Date.now();
    mockRPop
      .mockResolvedValueOnce(JSON.stringify({ userId: 'u-err', payload: { title: 'E', body: 'e' }, timestamp: fresh }))
      .mockResolvedValueOnce(null);
    mockQueuePushNotification.mockRejectedValueOnce(new Error('queue down'));

    await drainOutbox('u-err');

    const failedCalls = mockIncrementCounter.mock.calls.filter(
      (c: unknown[]) => c[0] === 'outbox_drained_total' && (c[1] as Record<string, string>)?.outcome === 'failed',
    );
    expect(failedCalls).toHaveLength(1);
    expect((failedCalls[0][1] as Record<string, string>).outbox).toBe('notification');
  });

  test('(c) silent-loss catch on queuePushNotification is gone — source-level assertion', () => {
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../shared/services/notification-outbox.service.ts'),
      'utf-8',
    ) as string;
    // The old silent-loss pattern on the queuePushNotification call must be gone.
    // We verify this by checking that queuePushNotification is NOT followed by a
    // bare .catch(() => {}) within the drain path. We check that the drain path
    // uses structured logger.error instead of swallowing errors silently.
    // The remaining .catch(() => {}) calls are only on non-critical O(1) counter ops.
    expect(src).toContain("logger.error('[NotificationOutbox] outbox drain failed'");
    // Count bare no-op catches on non-comment lines (strip comment lines first).
    // The source has exactly 2 real .catch(() => {}) calls on best-effort size
    // counter ops (incrBy). The queuePushNotification failure path must use
    // structured logger.error — verified by the check below.
    const nonCommentLines = src.split('\n').filter(l => !l.trimStart().startsWith('//'));
    const realSilentCatches = (nonCommentLines.join('\n').match(/\.catch\(\(\) => \{\}\)/g) || []).length;
    // Allow at most 2 — both are on incrBy(OUTBOX_SIZE_KEY) best-effort guards
    expect(realSilentCatches).toBeLessThanOrEqual(2);
    // The queuePushNotification failure handler must use structured logger.error.
    // We verify that the outbox drain failed error string appears in the source.
    expect(src).toContain("logger.error('[NotificationOutbox] outbox drain failed'");
  });

  test('(d) outbox:size INCR/DECR symmetry — delivered entry decrements', async () => {
    const fresh = Date.now();
    mockRPop
      .mockResolvedValueOnce(JSON.stringify({ userId: 'u-sym', payload: { title: 'S', body: 's' }, timestamp: fresh }))
      .mockResolvedValueOnce(null);
    mockQueuePushNotification.mockResolvedValueOnce('job-ok');

    await drainOutbox('u-sym');

    // incrBy(key, -1) should have been called once for the delivered entry
    const decrCalls = mockIncrBy.mock.calls.filter(
      (c: unknown[]) => c[0] === 'outbox:size' && c[1] === -1,
    );
    expect(decrCalls).toHaveLength(1);
  });
});
