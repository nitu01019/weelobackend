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

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    lPush: (...args: unknown[]) => mockLPush(...args),
    rPop: (...args: unknown[]) => mockRPop(...args),
    expire: (...args: unknown[]) => mockExpire(...args),
    scanIterator: (...args: unknown[]) => mockScanIterator(...args),
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
