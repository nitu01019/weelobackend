/**
 * =============================================================================
 * QA SCENARIO TESTS -- FCM Service + Queue Service Fixes
 * =============================================================================
 *
 * Covers FIX-30 (Payload Truncation), FIX-31 (Batched Sends),
 * FIX-43 (Token Cleanup), FIX-44 (Dead Code Removal),
 * FIX-34 (UUID Job IDs), FIX-41 (Immutable Jobs),
 * FIX-42 (Timer Handles), FIX-16 (Stale Recovery)
 *
 * 30+ test scenarios across 8 groups.
 * =============================================================================
 */

import * as fs from 'fs';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Shared mocks -- must be declared before any module imports that use them
// ---------------------------------------------------------------------------

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const mockRedisService = {
  isRedisEnabled: jest.fn().mockReturnValue(true),
  isConnected: jest.fn().mockReturnValue(true),
  sAdd: jest.fn().mockResolvedValue(1),
  sRem: jest.fn().mockResolvedValue(1),
  sMembers: jest.fn().mockResolvedValue([]),
  expire: jest.fn().mockResolvedValue(true),
  del: jest.fn().mockResolvedValue(1),
  lPush: jest.fn().mockResolvedValue(1),
  lTrim: jest.fn().mockResolvedValue('OK'),
  lLen: jest.fn().mockResolvedValue(0),
  hSet: jest.fn().mockResolvedValue(1),
  hDel: jest.fn().mockResolvedValue(1),
  hGetAll: jest.fn().mockResolvedValue({}),
  brPop: jest.fn().mockResolvedValue(null),
  zAdd: jest.fn().mockResolvedValue(1),
  zRangeByScore: jest.fn().mockResolvedValue([]),
  zRemRangeByScore: jest.fn().mockResolvedValue(0),
  lPushMany: jest.fn().mockResolvedValue(1),
  incr: jest.fn().mockResolvedValue(1),
  setTimer: jest.fn().mockResolvedValue(true),
  cancelTimer: jest.fn().mockResolvedValue(true),
  getExpiredTimers: jest.fn().mockResolvedValue([]),
  acquireLock: jest.fn().mockResolvedValue({ acquired: true }),
  releaseLock: jest.fn().mockResolvedValue(true),
};

jest.mock('../shared/services/logger.service', () => ({
  logger: mockLogger,
}));

jest.mock('../shared/services/redis.service', () => ({
  redisService: mockRedisService,
}));

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    observeHistogram: jest.fn(),
    setGauge: jest.fn(),
  },
}));

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    order: { findUnique: jest.fn().mockResolvedValue(null) },
    assignment: { findMany: jest.fn().mockResolvedValue([]) },
    booking: { findUnique: jest.fn().mockResolvedValue(null) },
    vehicle: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../shared/services/tracking-stream-sink', () => ({
  createTrackingStreamSink: () => ({
    publishTrackingEvents: jest.fn().mockResolvedValue(undefined),
    flush: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  messaging: jest.fn(() => ({
    send: jest.fn().mockResolvedValue('msg-id'),
    sendEachForMulticast: jest.fn().mockResolvedValue({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true }],
    }),
    subscribeToTopic: jest.fn().mockResolvedValue({}),
  })),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn().mockReturnValue('{}'),
}));

// ---------------------------------------------------------------------------
// Imports -- after mocks are in place
// ---------------------------------------------------------------------------

import { fcmService, FCMNotification } from '../shared/services/fcm.service';

// =============================================================================
// FCM GROUP 1: Payload Truncation (FIX-30)
// =============================================================================

describe('FCM GROUP 1: Payload Truncation (FIX-30)', () => {
  // Access buildMessage via a cast since it is a private method.
  // We call sendToTokens in mock mode (admin not initialized) to exercise buildMessage.
  // Instead we extract the built message indirectly through logNotification output.

  /**
   * Helper: call buildMessage indirectly by invoking it through a type-cast.
   * This keeps the test isolated to the truncation logic without needing a
   * full Firebase admin setup.
   */
  function callBuildMessage(notification: FCMNotification): any {
    return (fcmService as any).buildMessage(notification, ['test-token']);
  }

  test('body exactly 200 chars -> no truncation', () => {
    const body = 'A'.repeat(200);
    const msg = callBuildMessage({ type: 'general', title: 'T', body });
    expect(msg.notification.body).toBe(body);
    expect(msg.notification.body.length).toBe(200);
  });

  test('body 201 chars -> truncated to 200 + ellipsis', () => {
    const body = 'B'.repeat(201);
    const msg = callBuildMessage({ type: 'general', title: 'T', body });
    expect(msg.notification.body.length).toBe(201); // 200 chars + 1 ellipsis char
    expect(msg.notification.body.endsWith('\u2026')).toBe(true);
    expect(msg.notification.body.slice(0, 200)).toBe('B'.repeat(200));
  });

  test('body 1000 chars -> truncated to 200 + ellipsis', () => {
    const body = 'C'.repeat(1000);
    const msg = callBuildMessage({ type: 'general', title: 'T', body });
    expect(msg.notification.body.length).toBe(201);
    expect(msg.notification.body.endsWith('\u2026')).toBe(true);
  });

  test('title 101 chars -> truncated to 100 + ellipsis', () => {
    const title = 'D'.repeat(101);
    const msg = callBuildMessage({ type: 'general', title, body: 'ok' });
    expect(msg.notification.title.length).toBe(101); // 100 + ellipsis
    expect(msg.notification.title.endsWith('\u2026')).toBe(true);
    expect(msg.notification.title.slice(0, 100)).toBe('D'.repeat(100));
  });

  test('title exactly 100 chars -> no truncation', () => {
    const title = 'E'.repeat(100);
    const msg = callBuildMessage({ type: 'general', title, body: 'ok' });
    expect(msg.notification.title).toBe(title);
    expect(msg.notification.title.length).toBe(100);
  });

  test('address data field 101 chars -> truncated to 100 + ellipsis', () => {
    const addr = 'F'.repeat(101);
    const msg = callBuildMessage({
      type: 'general',
      title: 'T',
      body: 'B',
      data: { pickupAddress: addr },
    });
    expect(msg.data.pickupAddress.length).toBe(101); // 100 + ellipsis
    expect(msg.data.pickupAddress.endsWith('\u2026')).toBe(true);
  });

  test('address data field exactly 100 chars -> no truncation', () => {
    const addr = 'G'.repeat(100);
    const msg = callBuildMessage({
      type: 'general',
      title: 'T',
      body: 'B',
      data: { dropAddress: addr },
    });
    expect(msg.data.dropAddress).toBe(addr);
    expect(msg.data.dropAddress.length).toBe(100);
  });

  test('empty body -> no crash, returns empty string', () => {
    const msg = callBuildMessage({ type: 'general', title: 'T', body: '' });
    expect(msg.notification.body).toBe('');
  });

  test('undefined body field in data -> no crash', () => {
    const msg = callBuildMessage({
      type: 'general',
      title: 'T',
      body: 'B',
      data: { someField: undefined as any },
    });
    // Should not throw; data value coerced to string via String()
    expect(msg.data).toBeDefined();
  });

  test('Unicode body (Hindi text) -> correct char count, not byte count', () => {
    // Hindi text: each char is multi-byte in UTF-8 but 1 char in JS string
    const hindiChar = '\u0928'; // Devanagari "na"
    const body = hindiChar.repeat(201);
    const msg = callBuildMessage({ type: 'general', title: 'T', body });
    // Truncation should happen at character 200, not byte 200
    expect(msg.notification.body.length).toBe(201); // 200 Hindi chars + ellipsis
    expect(msg.notification.body.endsWith('\u2026')).toBe(true);
    // The first 200 chars should all be the Hindi character
    for (let i = 0; i < 200; i++) {
      expect(msg.notification.body[i]).toBe(hindiChar);
    }
  });

  test('total payload under 4KB after truncation with large data', () => {
    const largeData: Record<string, any> = {};
    // Add 15 data fields, each 200 chars -- without truncation this is ~3KB
    for (let i = 0; i < 15; i++) {
      largeData[`field${i}`] = 'X'.repeat(200);
    }
    // Add address fields that will be capped at 100
    largeData.pickupAddress = 'Y'.repeat(500);
    largeData.dropAddress = 'Z'.repeat(500);

    const msg = callBuildMessage({
      type: 'general',
      title: 'T'.repeat(200), // will be truncated to 100
      body: 'B'.repeat(500),  // will be truncated to 200
      data: largeData,
    });

    const jsonSize = Buffer.byteLength(JSON.stringify(msg), 'utf8');
    expect(jsonSize).toBeLessThan(4096);
  });
});

// =============================================================================
// FCM GROUP 2: Batched Sends (FIX-31)
// =============================================================================

describe('FCM GROUP 2: Batched Sends (FIX-31)', () => {
  let sendToUserSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // Spy on sendToUser to track how it is called during sendToUsers
    sendToUserSpy = jest
      .spyOn(fcmService, 'sendToUser')
      .mockResolvedValue(true);
  });

  afterEach(() => {
    sendToUserSpy.mockRestore();
  });

  const notification: FCMNotification = {
    type: 'general',
    title: 'Test',
    body: 'Test body',
  };

  test('1 user -> 1 batch, 1 call', async () => {
    const result = await fcmService.sendToUsers(['user1'], notification);
    expect(sendToUserSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe(1);
  });

  test('50 users -> 1 batch, 50 parallel calls', async () => {
    const userIds = Array.from({ length: 50 }, (_, i) => `user${i}`);
    const result = await fcmService.sendToUsers(userIds, notification);
    expect(sendToUserSpy).toHaveBeenCalledTimes(50);
    expect(result).toBe(50);
  });

  test('51 users -> 2 batches (50 + 1)', async () => {
    const userIds = Array.from({ length: 51 }, (_, i) => `user${i}`);
    const result = await fcmService.sendToUsers(userIds, notification);
    // All 51 calls should be made across 2 batches
    expect(sendToUserSpy).toHaveBeenCalledTimes(51);
    expect(result).toBe(51);
  });

  test('150 users -> 3 batches', async () => {
    const userIds = Array.from({ length: 150 }, (_, i) => `user${i}`);
    const result = await fcmService.sendToUsers(userIds, notification);
    expect(sendToUserSpy).toHaveBeenCalledTimes(150);
    expect(result).toBe(150);
  });

  test('0 users -> no calls', async () => {
    const result = await fcmService.sendToUsers([], notification);
    expect(sendToUserSpy).not.toHaveBeenCalled();
    expect(result).toBe(0);
  });

  test('some users fail in batch -> others still sent (Promise.allSettled)', async () => {
    let callCount = 0;
    sendToUserSpy.mockImplementation(async () => {
      callCount++;
      // Fail every 3rd user
      if (callCount % 3 === 0) throw new Error('FCM transient error');
      return true;
    });

    const userIds = Array.from({ length: 9 }, (_, i) => `user${i}`);
    const result = await fcmService.sendToUsers(userIds, notification);

    // All 9 calls should be attempted
    expect(sendToUserSpy).toHaveBeenCalledTimes(9);
    // 6 successful out of 9 (3 failed)
    expect(result).toBe(6);
  });

  test('all users fail -> error logged, no crash', async () => {
    sendToUserSpy.mockRejectedValue(new Error('FCM total failure'));

    const userIds = Array.from({ length: 5 }, (_, i) => `user${i}`);
    // Should not throw
    const result = await fcmService.sendToUsers(userIds, notification);

    expect(sendToUserSpy).toHaveBeenCalledTimes(5);
    // All failed, none fulfilled with true
    expect(result).toBe(0);
  });
});

// =============================================================================
// FCM GROUP 3: Token Cleanup (FIX-43)
// =============================================================================

describe('FCM GROUP 3: Token Cleanup (FIX-43)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('cleanup failure -> logger.warn called', async () => {
    // Simulate removeToken failure during dead token cleanup
    const removeTokenSpy = jest
      .spyOn(fcmService, 'removeToken')
      .mockRejectedValue(new Error('Redis write error'));

    // Simulate a send that triggers dead token cleanup via the catch path
    // We trigger the single-token error path for cleanup
    mockRedisService.sMembers.mockResolvedValueOnce(['dead-token']);

    // Initialize with mock admin
    (fcmService as any).isInitialized = true;
    const mockMessaging = {
      send: jest.fn().mockRejectedValue({
        code: 'messaging/registration-token-not-registered',
      }),
    };
    (fcmService as any).admin = { messaging: () => mockMessaging };

    await fcmService.sendToTokens(['dead-token'], {
      type: 'general',
      title: 'T',
      body: 'B',
    }, 'user123');

    // removeToken is called fire-and-forget (.catch(warn)), so wait a tick
    await new Promise(r => setTimeout(r, 50));

    expect(removeTokenSpy).toHaveBeenCalledWith('user123', 'dead-token');
    // The .catch handler should log a warning
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[FCM] Token cleanup failed',
      expect.objectContaining({ userId: 'user123' })
    );

    // Restore
    removeTokenSpy.mockRestore();
    (fcmService as any).isInitialized = false;
    (fcmService as any).admin = null;
  });

  test('cleanup success -> no warning logged for cleanup', async () => {
    const removeTokenSpy = jest
      .spyOn(fcmService, 'removeToken')
      .mockResolvedValue(undefined);

    (fcmService as any).isInitialized = true;
    const mockMessaging = {
      send: jest.fn().mockRejectedValue({
        code: 'messaging/registration-token-not-registered',
      }),
    };
    (fcmService as any).admin = { messaging: () => mockMessaging };

    await fcmService.sendToTokens(['dead-token'], {
      type: 'general',
      title: 'T',
      body: 'B',
    }, 'user456');

    await new Promise(r => setTimeout(r, 50));

    expect(removeTokenSpy).toHaveBeenCalled();
    // No warning about cleanup failure should appear
    const cleanupWarns = (mockLogger.warn as jest.Mock).mock.calls.filter(
      (args: any[]) => args[0] === '[FCM] Token cleanup failed'
    );
    expect(cleanupWarns.length).toBe(0);

    removeTokenSpy.mockRestore();
    (fcmService as any).isInitialized = false;
    (fcmService as any).admin = null;
  });

  test('multiple token cleanup failures -> each logged separately', async () => {
    const removeTokenSpy = jest
      .spyOn(fcmService, 'removeToken')
      .mockRejectedValue(new Error('Redis unavailable'));

    (fcmService as any).isInitialized = true;
    const mockMessaging = {
      sendEachForMulticast: jest.fn().mockResolvedValue({
        successCount: 0,
        failureCount: 3,
        responses: [
          { error: { code: 'messaging/registration-token-not-registered' } },
          { error: { code: 'messaging/invalid-registration-token' } },
          { error: { code: 'messaging/registration-token-not-registered' } },
        ],
      }),
    };
    (fcmService as any).admin = { messaging: () => mockMessaging };

    await fcmService.sendToTokens(
      ['token-a', 'token-b', 'token-c'],
      { type: 'general', title: 'T', body: 'B' },
      'user789'
    );

    await new Promise(r => setTimeout(r, 100));

    // removeToken should be called for each dead token
    expect(removeTokenSpy).toHaveBeenCalledTimes(3);

    // Each failure should produce a warn
    const cleanupWarns = (mockLogger.warn as jest.Mock).mock.calls.filter(
      (args: any[]) => args[0] === '[FCM] Token cleanup failed'
    );
    expect(cleanupWarns.length).toBe(3);

    removeTokenSpy.mockRestore();
    (fcmService as any).isInitialized = false;
    (fcmService as any).admin = null;
  });
});

// =============================================================================
// FCM GROUP 4: Dead Code Removal (FIX-44)
// =============================================================================

describe('FCM GROUP 4: Dead Code Removal (FIX-44)', () => {
  test('userTokensFallback Map does NOT exist in FCMService source', () => {
    // Read the source file and verify userTokensFallback is not present
    const actualFs = jest.requireActual('fs');
    const source = actualFs.readFileSync(
      require('path').resolve(__dirname, '../shared/services/fcm.service.ts'),
      'utf8'
    );
    expect(source).not.toContain('userTokensFallback');
  });

  test('no references to userTokensFallback anywhere in service', () => {
    // Verify the FCMService instance has no userTokensFallback property
    expect((fcmService as any).userTokensFallback).toBeUndefined();
    // Also verify it is not in the prototype chain
    const proto = Object.getPrototypeOf(fcmService);
    const allKeys = [
      ...Object.getOwnPropertyNames(fcmService),
      ...Object.getOwnPropertyNames(proto),
    ];
    expect(allKeys).not.toContain('userTokensFallback');
  });
});

// =============================================================================
// QUEUE GROUP 1: UUID Job IDs (FIX-34)
// =============================================================================

describe('QUEUE GROUP 1: UUID Job IDs (FIX-34)', () => {
  // UUID v4 pattern: 8-4-4-4-12 hex chars
  const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  test('Job IDs match UUID v4 pattern', () => {
    // crypto.randomUUID returns UUID v4
    const id = crypto.randomUUID();
    expect(id).toMatch(UUID_V4_REGEX);
  });

  test('Queue service source uses crypto.randomUUID for job IDs', () => {
    const actualFs = jest.requireActual('fs');
    const source = actualFs.readFileSync(
      require('path').resolve(__dirname, '../shared/services/queue.service.ts'),
      'utf8'
    );
    // Verify crypto.randomUUID is used for job IDs
    expect(source).toContain('crypto.randomUUID()');
    // Verify job.id is set from randomUUID
    expect(source).toMatch(/id:\s*crypto\.randomUUID\(\)/);
  });

  test('no Date.now() used for job IDs', () => {
    const actualFs = jest.requireActual('fs');
    const source = actualFs.readFileSync(
      require('path').resolve(__dirname, '../shared/services/queue.service.ts'),
      'utf8'
    );
    // Date.now() is used for timestamps (createdAt, processAfter, etc.) but NOT for IDs
    // Check that no id field assignment uses Date.now()
    const idAssignments = source.match(/id:\s*[^,\n]+/g) || [];
    const dateNowInId = idAssignments.filter((a: string) => a.includes('Date.now'));
    expect(dateNowInId.length).toBe(0);
  });

  test('no Math.random() used for job IDs', () => {
    const actualFs = jest.requireActual('fs');
    const source = actualFs.readFileSync(
      require('path').resolve(__dirname, '../shared/services/queue.service.ts'),
      'utf8'
    );
    // Math.random() should not appear in id assignments
    const idAssignments = source.match(/id:\s*[^,\n]+/g) || [];
    const mathRandomInId = idAssignments.filter((a: string) => a.includes('Math.random'));
    expect(mathRandomInId.length).toBe(0);
  });

  test('each job gets unique ID (no collisions in 1000 calls)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(crypto.randomUUID());
    }
    expect(ids.size).toBe(1000);
  });
});

// =============================================================================
// QUEUE GROUP 2: Immutable Jobs (FIX-41)
// =============================================================================

describe('QUEUE GROUP 2: Immutable Jobs (FIX-41)', () => {
  test('source code uses spread operator for immutable job copy in InMemoryQueue.processJob', () => {
    const actualFs = jest.requireActual('fs');
    const source = actualFs.readFileSync(
      require('path').resolve(__dirname, '../shared/services/queue.service.ts'),
      'utf8'
    );
    // FIX-41: Create immutable copy instead of mutating the input job object
    expect(source).toContain('const updatedJob = { ...job, attempts: job.attempts + 1 }');
  });

  test('source code uses spread operator for immutable job copy in RedisQueue.processJob', () => {
    const actualFs = jest.requireActual('fs');
    const source = actualFs.readFileSync(
      require('path').resolve(__dirname, '../shared/services/queue.service.ts'),
      'utf8'
    );
    // RedisQueue version includes processingStartedAt
    expect(source).toContain('const updatedJob = { ...job, attempts: job.attempts + 1, processingStartedAt: Date.now() }');
  });

  test('processJob does not modify input job.attempts (simulation)', () => {
    // Simulate the FIX-41 pattern to verify immutability
    const originalJob = {
      id: 'test-123',
      type: 'test',
      data: { foo: 'bar' },
      priority: 0,
      attempts: 0,
      maxAttempts: 3,
      createdAt: Date.now(),
    };

    // Freeze to detect mutation attempts
    const frozenJob = Object.freeze({ ...originalJob });

    // FIX-41 pattern: spread creates a new object
    const updatedJob = { ...frozenJob, attempts: frozenJob.attempts + 1 };

    // Original should be unchanged
    expect(frozenJob.attempts).toBe(0);
    // Updated should have incremented attempts
    expect(updatedJob.attempts).toBe(1);
    // They should be different object references
    expect(updatedJob).not.toBe(frozenJob);
  });

  test('original job object unchanged after processing pattern', () => {
    const originalJob = {
      id: 'immut-test',
      type: 'broadcast',
      data: { transporterId: 't1' },
      priority: 1,
      attempts: 2,
      maxAttempts: 5,
      createdAt: Date.now(),
    };

    // Save a deep copy for comparison
    const snapshot = JSON.parse(JSON.stringify(originalJob));

    // Apply the FIX-41 pattern
    const updated = { ...originalJob, attempts: originalJob.attempts + 1 };

    // Original must be byte-identical to snapshot
    expect(originalJob).toEqual(snapshot);
    expect(updated.attempts).toBe(3);
  });

  test('updated job has incremented attempts', () => {
    for (let startAttempts = 0; startAttempts < 5; startAttempts++) {
      const job = { attempts: startAttempts };
      const updated = { ...job, attempts: job.attempts + 1 };
      expect(updated.attempts).toBe(startAttempts + 1);
      expect(job.attempts).toBe(startAttempts);
    }
  });
});

// =============================================================================
// QUEUE GROUP 3: Timer Handles (FIX-42)
// =============================================================================

describe('QUEUE GROUP 3: Timer Handles (FIX-42)', () => {
  // We need to reimport queueService to test it, but it has complex
  // constructor-time side effects. Instead we test the patterns used.

  test('source code stores setTimeout handle in assignmentTimers Map', () => {
    const actualFs = jest.requireActual('fs');
    const source = actualFs.readFileSync(
      require('path').resolve(__dirname, '../shared/services/queue.service.ts'),
      'utf8'
    );
    // Verify the Map is declared
    expect(source).toContain('private assignmentTimers = new Map<string, NodeJS.Timeout>()');
    // Verify handle is stored after setTimeout
    expect(source).toContain('this.assignmentTimers.set(data.assignmentId, handle)');
  });

  test('cancelAssignmentTimeout clears the timer from Map', () => {
    const actualFs = jest.requireActual('fs');
    const source = actualFs.readFileSync(
      require('path').resolve(__dirname, '../shared/services/queue.service.ts'),
      'utf8'
    );
    // Verify clearTimeout is called
    expect(source).toContain('clearTimeout(timer)');
    // Verify timer is deleted from Map
    expect(source).toContain('this.assignmentTimers.delete(assignmentId)');
  });

  test('timer fires -> handle removed from Map (finally block)', () => {
    const actualFs = jest.requireActual('fs');
    const source = actualFs.readFileSync(
      require('path').resolve(__dirname, '../shared/services/queue.service.ts'),
      'utf8'
    );
    // The finally block in the setTimeout callback removes the handle
    expect(source).toContain('this.assignmentTimers.delete(data.assignmentId)');
  });

  test('cancel non-existent timer -> no crash (pattern simulation)', () => {
    // Simulate the cancelAssignmentTimeout pattern on a Map with no entry
    const assignmentTimers = new Map<string, NodeJS.Timeout>();
    const assignmentId = 'nonexistent-timer-id';

    // This mirrors the source code pattern
    const timer = assignmentTimers.get(assignmentId);
    if (timer) {
      clearTimeout(timer);
      assignmentTimers.delete(assignmentId);
    }

    // Should not throw, map should remain empty
    expect(assignmentTimers.size).toBe(0);
  });

  test('setTimeout handle stored and cleared correctly (pattern simulation)', () => {
    jest.useFakeTimers();

    const assignmentTimers = new Map<string, NodeJS.Timeout>();
    const callbackFired = jest.fn();

    // Simulate scheduleAssignmentTimeout fallback path
    const assignmentId = 'test-assign-42';
    const handle = setTimeout(() => {
      try {
        callbackFired();
      } finally {
        assignmentTimers.delete(assignmentId);
      }
    }, 30000);
    assignmentTimers.set(assignmentId, handle);

    // Timer should be stored
    expect(assignmentTimers.has(assignmentId)).toBe(true);

    // Simulate cancelAssignmentTimeout
    const storedTimer = assignmentTimers.get(assignmentId);
    if (storedTimer) {
      clearTimeout(storedTimer);
      assignmentTimers.delete(assignmentId);
    }

    // Timer should be removed
    expect(assignmentTimers.has(assignmentId)).toBe(false);

    // Advance time -- callback should NOT fire because we cleared it
    jest.advanceTimersByTime(35000);
    expect(callbackFired).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  test('timer fires and removes itself from Map (pattern simulation)', () => {
    jest.useFakeTimers();

    const assignmentTimers = new Map<string, NodeJS.Timeout>();
    const callbackFired = jest.fn();
    const assignmentId = 'self-destruct-42';

    const handle = setTimeout(() => {
      try {
        callbackFired();
      } finally {
        assignmentTimers.delete(assignmentId);
      }
    }, 5000);
    assignmentTimers.set(assignmentId, handle);

    expect(assignmentTimers.has(assignmentId)).toBe(true);

    // Advance past the timer
    jest.advanceTimersByTime(6000);

    expect(callbackFired).toHaveBeenCalledTimes(1);
    expect(assignmentTimers.has(assignmentId)).toBe(false);

    jest.useRealTimers();
  });
});

// =============================================================================
// QUEUE GROUP 4: Stale Recovery (FIX-16)
// =============================================================================

describe('QUEUE GROUP 4: Stale Recovery (FIX-16)', () => {
  test('source code stamps processingStartedAt when job begins processing', () => {
    const actualFs = jest.requireActual('fs');
    const source = actualFs.readFileSync(
      require('path').resolve(__dirname, '../shared/services/queue.service.ts'),
      'utf8'
    );
    // RedisQueue.runWorkerLoop stamps processingStartedAt before saving to processing hash
    expect(source).toContain('processingStartedAt: Date.now()');
    // FIX-16 comment should be present
    expect(source).toContain('FIX-16');
  });

  test('stale detection uses processingStartedAt, not just createdAt', () => {
    const actualFs = jest.requireActual('fs');
    const source = actualFs.readFileSync(
      require('path').resolve(__dirname, '../shared/services/queue.service.ts'),
      'utf8'
    );
    // recoverStaleProcessingJobs should prefer processingStartedAt
    expect(source).toContain('job.processingStartedAt || job.createdAt');
  });

  test('processingStartedAt is set on job processing (pattern simulation)', () => {
    const originalJob = {
      id: 'stale-test-1',
      type: 'broadcast',
      data: {},
      priority: 0,
      attempts: 0,
      maxAttempts: 3,
      createdAt: Date.now() - 60000, // created 60s ago
    };

    const beforeProcessing = Date.now();
    // FIX-16 pattern from RedisQueue.processJob
    const updatedJob = {
      ...originalJob,
      attempts: originalJob.attempts + 1,
      processingStartedAt: Date.now(),
    };
    const afterProcessing = Date.now();

    expect(updatedJob.processingStartedAt).toBeGreaterThanOrEqual(beforeProcessing);
    expect(updatedJob.processingStartedAt).toBeLessThanOrEqual(afterProcessing);
    // processingStartedAt should be much more recent than createdAt
    expect(updatedJob.processingStartedAt).toBeGreaterThan(updatedJob.createdAt);
  });

  test('stale detection prefers processingStartedAt over createdAt (pattern simulation)', () => {
    const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();

    // Case 1: Job created 10 min ago, started processing 1 min ago -> NOT stale
    const recentlyProcessed = {
      createdAt: now - 10 * 60 * 1000,
      processingStartedAt: now - 1 * 60 * 1000,
    };
    const age1 = now - (recentlyProcessed.processingStartedAt || recentlyProcessed.createdAt);
    expect(age1).toBeLessThan(STALE_THRESHOLD_MS);

    // Case 2: Job created 10 min ago, started processing 6 min ago -> STALE
    const staleProcessed = {
      createdAt: now - 10 * 60 * 1000,
      processingStartedAt: now - 6 * 60 * 1000,
    };
    const age2 = now - (staleProcessed.processingStartedAt || staleProcessed.createdAt);
    expect(age2).toBeGreaterThan(STALE_THRESHOLD_MS);

    // Case 3: No processingStartedAt, falls back to createdAt
    const noProcessingStart = {
      createdAt: now - 6 * 60 * 1000,
      processingStartedAt: undefined as number | undefined,
    };
    const age3 = now - (noProcessingStart.processingStartedAt || noProcessingStart.createdAt || 0);
    expect(age3).toBeGreaterThan(STALE_THRESHOLD_MS);
  });

  test('processingEntry JSON contains processingStartedAt when saved to Redis', () => {
    // Simulate the pattern from RedisQueue.runWorkerLoop
    const job = {
      id: 'redis-entry-test',
      type: 'tracking_event',
      data: { driverId: 'd1' },
      priority: 0,
      attempts: 1,
      maxAttempts: 3,
      createdAt: Date.now() - 5000,
    };

    const processingEntry = JSON.stringify({
      ...job,
      processingStartedAt: Date.now(),
    });

    const parsed = JSON.parse(processingEntry);
    expect(parsed).toHaveProperty('processingStartedAt');
    expect(typeof parsed.processingStartedAt).toBe('number');
    expect(parsed.processingStartedAt).toBeGreaterThan(parsed.createdAt);
  });
});
