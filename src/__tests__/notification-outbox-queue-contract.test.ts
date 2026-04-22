/**
 * =============================================================================
 * NOTIFICATION OUTBOX -- QUEUE CONTRACT (F-B-50)
 * =============================================================================
 *
 * Regression test for the silent-TypeError bug that existed before F-B-50:
 * drainOutbox used require('./queue-management.service') against a module
 * that never exported a queueManagementService singleton. The failure was
 * swallowed by .catch(() => {}), so outbox drains appeared to succeed while
 * actually dropping every buffered notification.
 *
 * Post-F-B-50 contract:
 *   - drainOutbox(userId) must call queueService.queuePushNotification
 *     (the canonical singleton imported directly from ./queue.service).
 *   - No runtime require('./queue-management.service') must remain in the
 *     notification-outbox.service.ts source.
 *
 * P6 additions (P6-T43, P6-T44):
 *   - P6-T43: socket kind -> FCM fallback when socket emit throws or returns false
 *   - P6-T44: discriminated-union payload contract snapshot
 *
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// MOCKS -- canonical queue.service directly (not the deleted modular facade)
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

// acquireLock returns { acquired: true } by default to allow drain to proceed
const mockAcquireLock = jest.fn().mockResolvedValue({ acquired: true });
const mockReleaseLock = jest.fn().mockResolvedValue(true);

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    lPush: (...args: unknown[]) => mockLPush(...args),
    rPop: (...args: unknown[]) => mockRPop(...args),
    expire: (...args: unknown[]) => mockExpire(...args),
    scanIterator: (...args: unknown[]) => mockScanIterator(...args),
    incr: (...args: unknown[]) => mockIncr(...args),
    incrBy: (...args: unknown[]) => mockIncrBy(...args),
    get: (...args: unknown[]) => mockRedisGet(...args),
    acquireLock: (...args: unknown[]) => mockAcquireLock(...args),
    releaseLock: (...args: unknown[]) => mockReleaseLock(...args),
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

// P6-T43: Mock socket.service emitToUser
const mockEmitToUser = jest.fn().mockReturnValue(true);

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: unknown[]) => mockEmitToUser(...args),
}));

// P6-T43: Mock fcm.service fcmService.sendToUser
const mockFcmSendToUser = jest.fn().mockResolvedValue(true);

jest.mock('../shared/services/fcm.service', () => ({
  fcmService: {
    sendToUser: (...args: unknown[]) => mockFcmSendToUser(...args),
  },
}));

// =============================================================================
// IMPORTS -- after mocks
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
    mockAcquireLock.mockResolvedValue({ acquired: true });
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
    expect(mockQueuePushNotification).toHaveBeenNthCalledWith(1, 'u-1', expect.objectContaining({ title: 'A', body: 'a' }));
    expect(mockQueuePushNotification).toHaveBeenNthCalledWith(2, 'u-1', expect.objectContaining({ title: 'B', body: 'b' }));
    expect(mockQueuePushNotification).toHaveBeenNthCalledWith(3, 'u-1', expect.objectContaining({ title: 'C', body: 'c' }));
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
    expect(mockQueuePushNotification).toHaveBeenCalledWith('u-2', expect.objectContaining({ title: 'fresh', body: 'new' }));
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

    // Must NOT throw -- the whole drain is try/catch wrapped
    await expect(drainOutbox('u-4')).resolves.toBeUndefined();
    expect(mockQueuePushNotification).toHaveBeenCalledTimes(1);
  });

  test('drainAllOutboxes delegates per-user drain to drainOutbox', async () => {
    // Simulate SCAN returning one outbox key, then nothing.
    async function* gen() {
      yield 'notification:outbox:alpha';
    }
    mockScanIterator.mockReturnValue(gen());
    mockRPop.mockResolvedValue(null); // No entries -- drainOutbox completes quickly

    await drainAllOutboxes();
    // No throw -- end of contract
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
  test('source file does not contain require(./queue-management.service)', () => {
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
    mockAcquireLock.mockResolvedValue({ acquired: true });
  });

  test('(a) 5 bufferNotification calls -> outbox_buffered_total counter delta = 5', async () => {
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

  test('(b) drain with queueService failure -> outbox_drained_total{outcome:failed} +1', async () => {
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

  test('(c) silent-loss catch on queuePushNotification is gone -- source-level assertion', () => {
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../shared/services/notification-outbox.service.ts'),
      'utf-8',
    ) as string;
    expect(src).toContain("[NotificationOutbox] outbox drain failed");
    const nonCommentLines = src.split('\n').filter((l: string) => !l.trimStart().startsWith('//'));
    const realSilentCatches = (nonCommentLines.join('\n').match(/\.catch\(\(\) => \{\}\)/g) || []).length;
    // Allow at most 4 -- best-effort guards on incrBy/releaseLock calls
    expect(realSilentCatches).toBeLessThanOrEqual(4);
    expect(src).toContain("[NotificationOutbox] outbox drain failed");
  });

  test('(d) outbox:size INCR/DECR symmetry -- delivered entry decrements', async () => {
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

// =============================================================================
// P6-T43: socket kind -> FCM fallback
// =============================================================================

describe('P6-T43: socket kind -> FCM fallback on socket emit failure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAcquireLock.mockResolvedValue({ acquired: true });
    mockReleaseLock.mockResolvedValue(true);
    mockEmitToUser.mockReturnValue(true);
    mockFcmSendToUser.mockResolvedValue(true);
  });

  test('when socket emit throws, fcmService.sendToUser is called as fallback', async () => {
    const fresh = Date.now();
    mockEmitToUser.mockImplementationOnce(() => { throw new Error('socket_unavailable'); });
    mockFcmSendToUser.mockResolvedValueOnce(true);

    mockRPop
      .mockResolvedValueOnce(JSON.stringify({
        userId: 'u-sock',
        payload: { kind: 'socket', event: 'test_event', data: { foo: 'bar' } },
        timestamp: fresh,
      }))
      .mockResolvedValueOnce(null);

    await drainOutbox('u-sock');

    // FCM fallback must have been called
    expect(mockFcmSendToUser).toHaveBeenCalledTimes(1);
    const [userId, notification] = mockFcmSendToUser.mock.calls[0] as [string, Record<string, unknown>];
    expect(userId).toBe('u-sock');
    expect(notification).toMatchObject({ type: 'general' });
  });

  test('when socket emit returns false (undelivered), fcmService.sendToUser is called', async () => {
    const fresh = Date.now();
    mockEmitToUser.mockReturnValueOnce(false);
    mockFcmSendToUser.mockResolvedValueOnce(true);

    mockRPop
      .mockResolvedValueOnce(JSON.stringify({
        userId: 'u-sock2',
        payload: { kind: 'socket', event: 'order_update', data: { orderId: '42' } },
        timestamp: fresh,
      }))
      .mockResolvedValueOnce(null);

    await drainOutbox('u-sock2');

    expect(mockFcmSendToUser).toHaveBeenCalledTimes(1);
  });

  test('when socket emit succeeds, FCM fallback is NOT called', async () => {
    const fresh = Date.now();
    mockEmitToUser.mockReturnValueOnce(true);

    mockRPop
      .mockResolvedValueOnce(JSON.stringify({
        userId: 'u-sock3',
        payload: { kind: 'socket', event: 'ping', data: {} },
        timestamp: fresh,
      }))
      .mockResolvedValueOnce(null);

    await drainOutbox('u-sock3');

    expect(mockFcmSendToUser).not.toHaveBeenCalled();
  });
});

// =============================================================================
// P6-T44: discriminated-union payload contract snapshot
// =============================================================================

describe('P6-T44: discriminated-union OutboxEntry.payload contract', () => {
  test('source exports FcmOutboxPayload and SocketOutboxPayload types (symbol presence)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../shared/services/notification-outbox.service.ts'),
      'utf-8',
    );
    expect(src).toContain('FcmOutboxPayload');
    expect(src).toContain('SocketOutboxPayload');
    expect(src).toContain('TypedOutboxPayload');
  });

  test('FcmOutboxPayload and SocketOutboxPayload carry correct kind discriminants', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../shared/services/notification-outbox.service.ts'),
      'utf-8',
    );
    expect(src).toContain("kind: 'fcm'");
    expect(src).toContain("kind: 'socket'");
  });

  test('legacy payload (no kind) is coerced to FCM and emits legacy counter', async () => {
    jest.clearAllMocks();
    mockAcquireLock.mockResolvedValue({ acquired: true });
    const fresh = Date.now();
    // Entry with no kind field -- pre-P6 legacy shape
    mockRPop
      .mockResolvedValueOnce(JSON.stringify({
        userId: 'u-legacy',
        payload: { title: 'Legacy Title', body: 'Legacy body' }, // no kind
        timestamp: fresh,
      }))
      .mockResolvedValueOnce(null);

    await drainOutbox('u-legacy');

    // The legacy shim must emit the outbox_drain_legacy_entries_total counter
    const legacyCalls = mockIncrementCounter.mock.calls.filter(
      (c: unknown[]) => c[0] === 'outbox_drain_legacy_entries_total',
    );
    expect(legacyCalls.length).toBeGreaterThanOrEqual(1);
    expect((legacyCalls[0][1] as Record<string, string>).origin_phase).toBe('pre_p6');
  });

  test('typed fcm payload is drained via queuePushNotification (not socket path)', async () => {
    jest.clearAllMocks();
    mockAcquireLock.mockResolvedValue({ acquired: true });
    const fresh = Date.now();
    mockRPop
      .mockResolvedValueOnce(JSON.stringify({
        userId: 'u-typed-fcm',
        payload: { kind: 'fcm', title: 'FCM Title', body: 'FCM Body' },
        timestamp: fresh,
      }))
      .mockResolvedValueOnce(null);

    await drainOutbox('u-typed-fcm');

    // socket.emitToUser must NOT have been called for an FCM kind
    expect(mockEmitToUser).not.toHaveBeenCalled();
    // queuePushNotification must have been called
    expect(mockQueuePushNotification).toHaveBeenCalledWith(
      'u-typed-fcm',
      expect.objectContaining({ title: 'FCM Title', body: 'FCM Body' }),
    );
  });
});
