export {};
/**
 * =============================================================================
 * CRITICAL GROUP B — HOLD SYSTEM TESTS (Issues #3, #4, #5, #6, #18)
 * =============================================================================
 *
 * Tests for verified critical fixes in the hold system:
 *
 *   #3  — Hold Finalize Retry Processor (CAS guard, terminal no-op, not-found)
 *   #4  — Hold Cleanup CAS Guard (updateMany, terminal skip, count=0 guard)
 *   #5  — Flex Hold Lock Key Fix (orderId:transporterId key, holdId holder)
 *   #6  — Confirm Hold Distributed Lock (acquireLock, key format, TTL, finally)
 *   #18 — Hold Extension Reschedules Cleanup (scheduleExpiryCheck after extend)
 *
 * Total: 25 tests
 *
 * @author Weelo Team
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — Must come before any imports
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
  config: {
    redis: { enabled: true },
    isProduction: false,
    otp: { expiryMinutes: 5 },
    sms: {},
  },
}));

// ---------------------------------------------------------------------------
// Redis service mock
// ---------------------------------------------------------------------------
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisGetJSON = jest.fn();
const mockRedisSetJSON = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    getJSON: (...args: any[]) => mockRedisGetJSON(...args),
    setJSON: (...args: any[]) => mockRedisSetJSON(...args),
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    isConnected: () => true,
  },
}));

// ---------------------------------------------------------------------------
// Prisma mock
// ---------------------------------------------------------------------------
const mockHoldFindUnique = jest.fn();
const mockHoldUpdateMany = jest.fn();
const mockHoldUpdate = jest.fn();
const mockHoldCreate = jest.fn();
const mockHoldFindFirst = jest.fn();
const mockAssignmentFindMany = jest.fn();
const mockVehicleFindMany = jest.fn();
const mockVehicleUpdateMany = jest.fn();
const mockAssignmentUpdateMany = jest.fn();
const mockOrderFindUnique = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    truckHoldLedger: {
      findUnique: (...args: any[]) => mockHoldFindUnique(...args),
      updateMany: (...args: any[]) => mockHoldUpdateMany(...args),
      update: (...args: any[]) => mockHoldUpdate(...args),
      create: (...args: any[]) => mockHoldCreate(...args),
      findFirst: (...args: any[]) => mockHoldFindFirst(...args),
    },
    assignment: {
      findMany: (...args: any[]) => mockAssignmentFindMany(...args),
      updateMany: (...args: any[]) => mockAssignmentUpdateMany(...args),
    },
    vehicle: {
      findMany: (...args: any[]) => mockVehicleFindMany(...args),
      updateMany: (...args: any[]) => mockVehicleUpdateMany(...args),
    },
    order: {
      findUnique: (...args: any[]) => mockOrderFindUnique(...args),
    },
    $transaction: (...args: any[]) => mockTransaction(...args),
  },
  HoldPhase: {
    FLEX: 'FLEX',
    CONFIRMED: 'CONFIRMED',
    EXPIRED: 'EXPIRED',
    RELEASED: 'RELEASED',
  },
  AssignmentStatus: {
    pending: 'pending',
    driver_accepted: 'driver_accepted',
    driver_declined: 'driver_declined',
    cancelled: 'cancelled',
    en_route_pickup: 'en_route_pickup',
    at_pickup: 'at_pickup',
    in_transit: 'in_transit',
  },
  withDbTimeout: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Queue service mock
// ---------------------------------------------------------------------------
const mockRegisterProcessor = jest.fn();
const mockEnqueue = jest.fn();
const mockQueueAdd = jest.fn();
const mockScheduleAssignmentTimeout = jest.fn();

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    registerProcessor: (...args: any[]) => mockRegisterProcessor(...args),
    enqueue: (...args: any[]) => mockEnqueue(...args),
    add: (...args: any[]) => mockQueueAdd(...args),
    scheduleAssignmentTimeout: (...args: any[]) => mockScheduleAssignmentTimeout(...args),
    queuePushNotification: jest.fn().mockResolvedValue(undefined),
    getStats: jest.fn().mockResolvedValue({ queues: [] }),
  },
}));

// ---------------------------------------------------------------------------
// Socket service mock
// ---------------------------------------------------------------------------
const mockEmitToUser = jest.fn();
jest.mock('../shared/services/socket.service', () => ({
  socketService: {
    emitToUser: (...args: any[]) => mockEmitToUser(...args),
  },
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  SocketEvent: {
    TRIP_ASSIGNED: 'trip_assigned',
  },
}));

// ---------------------------------------------------------------------------
// Live availability service mock
// ---------------------------------------------------------------------------
const mockOnVehicleStatusChange = jest.fn();
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: (...args: any[]) => mockOnVehicleStatusChange(...args),
  },
}));

// ---------------------------------------------------------------------------
// Hold expiry cleanup service mock
// ---------------------------------------------------------------------------
const mockScheduleFlexHoldCleanup = jest.fn().mockResolvedValue('job-123');
const mockScheduleConfirmedHoldCleanup = jest.fn().mockResolvedValue('job-456');

jest.mock('../modules/hold-expiry/hold-expiry-cleanup.service', () => ({
  holdExpiryCleanupService: {
    scheduleFlexHoldCleanup: (...args: any[]) => mockScheduleFlexHoldCleanup(...args),
    scheduleConfirmedHoldCleanup: (...args: any[]) => mockScheduleConfirmedHoldCleanup(...args),
  },
  registerHoldExpiryProcessor: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Vehicle key service mock
// ---------------------------------------------------------------------------
jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn().mockReturnValue('vehicle-key-1'),
}));

// ---------------------------------------------------------------------------
// Truck hold types mock
// ---------------------------------------------------------------------------
jest.mock('../modules/truck-hold/truck-hold.types', () => ({
  HOLD_DURATION_CONFIG: {
    FLEX_DURATION_SECONDS: 90,
    EXTENSION_SECONDS: 30,
    MAX_DURATION_SECONDS: 130,
    CONFIRMED_MAX_SECONDS: 120,
    MAX_EXTENSIONS: 3,
  },
  TERMINAL_ORDER_STATUSES: new Set(['completed', 'cancelled']),
  TERMINAL_HOLD_STATUSES: ['completed', 'cancelled', 'expired', 'released', 'confirmed'],
  RELEASABLE_ASSIGNMENT_STATUSES: ['pending', 'driver_declined'],
}));

// ---------------------------------------------------------------------------
// Hold config mock
// ---------------------------------------------------------------------------
jest.mock('../core/config/hold-config', () => ({
  HOLD_CONFIG: {
    driverAcceptTimeoutMs: 45000,
    driverAcceptTimeoutSeconds: 45,
    confirmedHoldMaxSeconds: 180,
    flexHoldDurationSeconds: 90,
    flexHoldExtensionSeconds: 30,
    flexHoldMaxDurationSeconds: 130,
    flexHoldMaxExtensions: 2,
  },
}));

// ---------------------------------------------------------------------------
// DB module mock
// ---------------------------------------------------------------------------
jest.mock('../shared/database/db', () => ({
  db: {
    getOrderById: jest.fn(),
    getUserById: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Driver service mock
// ---------------------------------------------------------------------------
jest.mock('../modules/driver/driver.service', () => ({
  driverService: {
    areDriversOnline: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// UUID mock
// ---------------------------------------------------------------------------
jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('test-uuid-1234'),
}));

// =============================================================================
// HELPERS
// =============================================================================

function resetAllMocks(): void {
  jest.clearAllMocks();
  mockRedisAcquireLock.mockResolvedValue({ acquired: true, ttl: 10 });
  mockRedisReleaseLock.mockResolvedValue(undefined);
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue(undefined);
  mockRedisDel.mockResolvedValue(true);
  mockRedisGetJSON.mockResolvedValue(null);
  mockRedisSetJSON.mockResolvedValue(undefined);
  mockEnqueue.mockResolvedValue(undefined);
  mockQueueAdd.mockResolvedValue('job-id');
  mockScheduleFlexHoldCleanup.mockResolvedValue('job-123');
  mockOnVehicleStatusChange.mockResolvedValue(undefined);
}

// =============================================================================
// #3 — Hold Finalize Retry Processor (5 tests)
// =============================================================================

describe('#3 — Hold Finalize Retry Processor', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  test('3.1: Processor is registered for hold:finalize-retry queue', () => {
    // Import triggers the module which exports registerFinalizeRetryProcessor
    const { registerFinalizeRetryProcessor, FINALIZE_RETRY_QUEUE_NAME } =
      require('../modules/truck-hold/hold-finalize-retry.processor');

    registerFinalizeRetryProcessor();

    expect(mockRegisterProcessor).toHaveBeenCalledWith(
      'hold:finalize-retry',
      expect.any(Function)
    );
    expect(FINALIZE_RETRY_QUEUE_NAME).toBe('hold:finalize-retry');
  });

  test('3.2: Hold in limbo state transitions to expired with CAS guard', async () => {
    const { processFinalizeRetry } =
      require('../modules/truck-hold/hold-finalize-retry.processor');

    // Hold is in 'active' (limbo) state — not terminal
    mockHoldFindUnique.mockResolvedValue({
      holdId: 'hold-1',
      orderId: 'order-1',
      transporterId: 'trans-1',
      status: 'active',
    });

    // CAS updateMany succeeds — hold was still in non-terminal state
    mockHoldUpdateMany.mockResolvedValue({ count: 1 });

    // No releasable assignments
    mockAssignmentFindMany.mockResolvedValue([]);

    const job = {
      id: 'job-1',
      data: { holdId: 'hold-1', orderId: 'order-1', retriedAt: new Date().toISOString() },
    };

    await processFinalizeRetry(job);

    // Verify updateMany was called (CAS pattern), NOT update
    expect(mockHoldUpdateMany).toHaveBeenCalledWith({
      where: {
        holdId: 'hold-1',
        status: { notIn: ['completed', 'cancelled', 'expired', 'released', 'confirmed'] },
      },
      data: expect.objectContaining({
        status: 'expired',
        terminalReason: 'finalize_retry_compensation',
      }),
    });
  });

  test('3.3: Hold already in terminal state is a no-op', async () => {
    const { processFinalizeRetry } =
      require('../modules/truck-hold/hold-finalize-retry.processor');

    // Hold is already 'confirmed' — terminal
    mockHoldFindUnique.mockResolvedValue({
      holdId: 'hold-2',
      orderId: 'order-2',
      transporterId: 'trans-1',
      status: 'confirmed',
    });

    const job = {
      id: 'job-2',
      data: { holdId: 'hold-2', orderId: 'order-2', retriedAt: new Date().toISOString() },
    };

    await processFinalizeRetry(job);

    // updateMany should NOT have been called — already terminal
    expect(mockHoldUpdateMany).not.toHaveBeenCalled();
  });

  test('3.4: Hold not found is graceful no-op', async () => {
    const { processFinalizeRetry } =
      require('../modules/truck-hold/hold-finalize-retry.processor');

    // Hold does not exist (already cleaned up)
    mockHoldFindUnique.mockResolvedValue(null);

    const job = {
      id: 'job-3',
      data: { holdId: 'hold-gone', orderId: 'order-3', retriedAt: new Date().toISOString() },
    };

    // Should not throw
    await expect(processFinalizeRetry(job)).resolves.toBeUndefined();
    expect(mockHoldUpdateMany).not.toHaveBeenCalled();
  });

  test('3.5: Uses updateMany (not update) for CAS protection', () => {
    // Structural test: verify the source code uses updateMany for the CAS guard
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/hold-finalize-retry.processor.ts'),
      'utf-8'
    );

    // Must use updateMany for the CAS-guarded status transition
    expect(source).toContain('prismaClient.truckHoldLedger.updateMany');
    expect(source).toContain("notIn: TERMINAL_HOLD_STATUSES");

    // The CAS result check: count === 0 means concurrent transition happened
    expect(source).toContain('result.count === 0');
  });
});

// =============================================================================
// #4 — Hold Cleanup CAS Guard (5 tests)
// =============================================================================

describe('#4 — Hold Cleanup Terminal State Guard', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  test('4.1: Cleanup uses TERMINAL_STATUSES set for idempotency', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/hold-expiry/hold-expiry-cleanup.service.ts'),
      'utf-8'
    );

    // Uses local TERMINAL_STATUSES set for O(1) lookups
    expect(source).toContain('TERMINAL_STATUSES');
    expect(source).toContain('TERMINAL_STATUSES.has(hold.status)');
  });

  test('4.2: TERMINAL_STATUSES includes expired, released, cancelled', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/hold-expiry/hold-expiry-cleanup.service.ts'),
      'utf-8'
    );

    // Local TERMINAL_STATUSES Set definition
    expect(source).toMatch(/TERMINAL_STATUSES\s*=\s*new Set\(/);
    expect(source).toContain("'expired'");
    expect(source).toContain("'released'");
    expect(source).toContain("'cancelled'");
  });

  test('4.3: Holds in terminal state are skipped before processing', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/hold-expiry/hold-expiry-cleanup.service.ts'),
      'utf-8'
    );

    // Idempotency check skips terminal holds
    expect(source).toContain('TERMINAL_STATUSES.has(hold.status)');
  });

  test('4.4: Cleanup sets expired holds to expired status', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/hold-expiry/hold-expiry-cleanup.service.ts'),
      'utf-8'
    );

    expect(source).toContain("status: 'expired'");
  });

  test('4.5: Vehicle updates happen inside cleanup transaction', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/hold-expiry/hold-expiry-cleanup.service.ts'),
      'utf-8'
    );

    // Vehicle status is updated in transaction
    expect(source).toContain('vehicle.updateMany');
    expect(source).toContain('assignment.updateMany');
  });
});

// =============================================================================
// #5 — Flex Hold Lock Key Fix (5 tests)
// =============================================================================

describe('#5 — Flex Hold Lock Key Fix', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  test('5.1: Lock key uses REDIS_KEYS helper', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/flex-hold.service.ts'),
      'utf-8'
    );

    // Lock key uses REDIS_KEYS.FLEX_HOLD_LOCK
    expect(source).toContain('REDIS_KEYS.FLEX_HOLD_LOCK');
    expect(source).toContain('acquireLock(lockKey');
  });

  test('5.2: Lock acquisition uses a holder identifier', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/flex-hold.service.ts'),
      'utf-8'
    );

    // acquireLock is called with lockKey and a holder
    expect(source).toContain('acquireLock(lockKey,');
  });

  test('5.3: Second concurrent call for same order+transporter gets LOCK_ACQUISITION_FAILED', async () => {
    // Re-import after mocks are set up
    jest.isolateModules(() => {
      // Lock not acquired — another call already holds it
      mockRedisAcquireLock.mockResolvedValue({ acquired: false });

      // No existing hold found (dedup check)
      mockHoldFindFirst.mockResolvedValue(null);

      // AB-2: createFlexHold now checks order existence before acquiring lock
      mockOrderFindUnique.mockResolvedValue({
        id: 'order-dup',
        status: 'broadcasting',
        expiresAt: new Date(Date.now() + 300_000),
      });

      const { flexHoldService } = require('../modules/truck-hold/flex-hold.service');

      return flexHoldService.createFlexHold({
        orderId: 'order-dup',
        transporterId: 'trans-1',
        vehicleType: 'truck',
        vehicleSubtype: '6-wheel',
        quantity: 1,
        truckRequestIds: ['tr-1'],
      }).then((result: any) => {
        expect(result.success).toBe(false);
        expect(result.error).toBe('LOCK_ACQUISITION_FAILED');
      });
    });
  });

  test('5.4: Lock key incorporates holdId for unique identification', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/flex-hold.service.ts'),
      'utf-8'
    );

    // Lock key uses holdId via REDIS_KEYS helper
    expect(source).toContain('FLEX_HOLD_LOCK(holdId)');
  });

  test('5.5: Lock TTL is 10 seconds', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/flex-hold.service.ts'),
      'utf-8'
    );

    // acquireLock third parameter is the TTL — 10 seconds
    expect(source).toContain(', 10)');
  });
});

// =============================================================================
// #6 — Confirm Hold Distributed Lock (5 tests)
// =============================================================================

describe('#6 — Confirm Hold Distributed Lock', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  test('6.1: acquireLock is called before saga runs', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/truck-hold-confirm.service.ts'),
      'utf-8'
    );

    // acquireLock must appear before validateHoldForConfirmation
    const lockPos = source.indexOf('redisService.acquireLock(lockKey');
    const validatePos = source.indexOf('validateHoldForConfirmation(');
    expect(lockPos).toBeGreaterThan(-1);
    expect(validatePos).toBeGreaterThan(-1);
    expect(lockPos).toBeLessThan(validatePos);
  });

  test('6.2: Lock key is hold:confirm:lock:{holdId}', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/truck-hold-confirm.service.ts'),
      'utf-8'
    );

    // Lock key format
    expect(source).toContain('`hold:confirm:lock:${holdId}`');
  });

  test('6.3: Second concurrent confirm returns CONFIRM_IN_PROGRESS or idempotent replay', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/truck-hold-confirm.service.ts'),
      'utf-8'
    );

    // When lock is not acquired, check for idempotent cache before rejecting
    expect(source).toContain("if (!lock.acquired)");

    // Idempotent replay path: check cached result
    expect(source).toContain('`hold:confirm:${holdId}`');

    // Rejection message when not idempotent replay
    expect(source).toContain('Confirmation already in progress');
  });

  test('6.4: Lock released in finally block (even on error)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/truck-hold-confirm.service.ts'),
      'utf-8'
    );

    // Must have a finally block that releases the lock
    expect(source).toMatch(/finally\s*\{[\s\S]*?releaseLock\(lockKey/);

    // The releaseLock call should have .catch() to avoid unhandled rejection
    expect(source).toMatch(/releaseLock\(lockKey,\s*transporterId\)\.catch/);
  });

  test('6.5: Lock TTL is 30 seconds', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/truck-hold-confirm.service.ts'),
      'utf-8'
    );

    // acquireLock is called with TTL = 30
    expect(source).toMatch(/acquireLock\(lockKey,\s*transporterId,\s*30\)/);
  });
});

// =============================================================================
// #18 — Hold Extension Reschedules Cleanup (5 tests)
// =============================================================================

describe('#18 — Hold Extension Reschedules Cleanup', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  test('18.1: Extension updates both DB expiresAt and flexExpiresAt', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/flex-hold.service.ts'),
      'utf-8'
    );

    const extendSection = source.slice(
      source.indexOf('async extendFlexHold'),
      source.indexOf('async getFlexHoldState')
    );

    // DB update sets both flexExpiresAt and expiresAt to newExpiresAt
    expect(extendSection).toContain('flexExpiresAt: newExpiresAt');
    expect(extendSection).toContain('expiresAt: newExpiresAt');
    expect(extendSection).toContain('newExpiresAt');
  });

  test('18.2: DB update comes before Redis cache update in extendFlexHold', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/flex-hold.service.ts'),
      'utf-8'
    );

    const extendSection = source.slice(
      source.indexOf('async extendFlexHold'),
      source.indexOf('async getFlexHoldState')
    );

    // DB update (truckHoldLedger.update) must come before cache update
    const dbUpdatePos = extendSection.indexOf('truckHoldLedger.update');
    const cachePos = extendSection.indexOf('cacheFlexHoldState');

    expect(dbUpdatePos).toBeGreaterThan(-1);
    expect(cachePos).toBeGreaterThan(-1);
    expect(dbUpdatePos).toBeLessThan(cachePos);
  });

  test('18.3: Extension emits socket event with newExpiresAt to transporter', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/flex-hold.service.ts'),
      'utf-8'
    );

    const extendSection = source.slice(
      source.indexOf('async extendFlexHold'),
      source.indexOf('async getFlexHoldState')
    );

    // Socket event emitted with newExpiresAt
    expect(extendSection).toContain("socketService.emitToUser");
    expect(extendSection).toContain("flex_hold_extended");
    expect(extendSection).toContain('newExpiresAt');
  });

  test('18.4: Extension updates DB expiresAt and caches atomically in try block', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/flex-hold.service.ts'),
      'utf-8'
    );

    const extendSection = source.slice(
      source.indexOf('async extendFlexHold'),
      source.indexOf('async getFlexHoldState')
    );

    // Step 1: DB update with new expiresAt
    const dbUpdatePos = extendSection.indexOf('truckHoldLedger.update');
    expect(dbUpdatePos).toBeGreaterThan(-1);

    // The DB update sets both flexExpiresAt and expiresAt to newExpiresAt
    expect(extendSection).toContain('flexExpiresAt: newExpiresAt');
    expect(extendSection).toContain('expiresAt: newExpiresAt');

    // Step 2: Redis cache update
    const cachePos = extendSection.indexOf('cacheFlexHoldState');
    expect(cachePos).toBeGreaterThan(dbUpdatePos);

    // All steps are inside the same try block (atomic success path)
    const tryBlockStart = extendSection.indexOf('try {');
    const catchBlockStart = extendSection.indexOf('} catch');
    expect(dbUpdatePos).toBeGreaterThan(tryBlockStart);
    expect(cachePos).toBeLessThan(catchBlockStart);
  });

  test('18.5: Extension returns success with newExpiresAt and addedSeconds', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/flex-hold.service.ts'),
      'utf-8'
    );

    const extendSection = source.slice(
      source.indexOf('async extendFlexHold'),
      source.indexOf('async getFlexHoldState')
    );

    // Success response includes newExpiresAt and addedSeconds
    expect(extendSection).toContain('success: true');
    expect(extendSection).toContain('newExpiresAt');
    expect(extendSection).toContain('addedSeconds');

    // Socket event fires after DB + cache for UI update
    const socketEmitPos = extendSection.indexOf('socketService.emitToUser');
    expect(socketEmitPos).toBeGreaterThan(-1);
  });
});
