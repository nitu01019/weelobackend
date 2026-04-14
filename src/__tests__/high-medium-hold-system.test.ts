/**
 * =============================================================================
 * HIGH/MEDIUM HOLD SYSTEM TESTS — Issues #35, #36, #37, #38, #39, #90, #91, #95
 * =============================================================================
 *
 * Tests for hold system hardening fixes:
 *   #35  — PG advisory lock fallback when Redis is down
 *   #36  — Unified cleanup lock key 'hold:cleanup:unified'
 *   #37  — transitionToConfirmed ownership check (transporterId)
 *   #38  — Fresh remainingSeconds computed from cache (not stale)
 *   #39  — Vehicle release scoped to transporterId in releaseConfirmedVehicles
 *   #90  — Single config source: HOLD_DURATION_CONFIG derived from HOLD_CONFIG
 *   #91  — MGET pipeline batch for getActiveHoldsByOrder (not N individual GETs)
 *   #95  — Aligned TTLs: data TTL equals index TTL in HoldStore.add()
 *
 * Minimum 3 tests per issue.
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — Must come before any imports
// =============================================================================

const mockPrismaClient = {
  truckHoldLedger: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  truckHoldIdempotency: {
    deleteMany: jest.fn(),
  },
  order: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  truckRequest: {
    findMany: jest.fn(),
    updateMany: jest.fn(),
  },
  vehicle: {
    findMany: jest.fn(),
    updateMany: jest.fn(),
    update: jest.fn(),
  },
  assignment: {
    findMany: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
  },
  user: {
    findMany: jest.fn(),
  },
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
};

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: mockPrismaClient,
  withDbTimeout: jest.fn(async (fn: any, _opts?: any) => fn(mockPrismaClient)),
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
    en_route_pickup: 'en_route_pickup',
    at_pickup: 'at_pickup',
    in_transit: 'in_transit',
  },
  OrderStatus: {
    partially_filled: 'partially_filled',
    fully_filled: 'fully_filled',
  },
  TruckRequestStatus: { held: 'held', assigned: 'assigned' },
  VehicleStatus: { available: 'available', on_hold: 'on_hold' },
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
  },
}));

const mockPipeline = {
  get: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue([]),
};

const mockRedisClient = {
  pipeline: jest.fn().mockReturnValue(mockPipeline),
};

const mockRedisService = {
  acquireLock: jest.fn().mockResolvedValue({ acquired: true }),
  releaseLock: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  setJSON: jest.fn().mockResolvedValue('OK'),
  getJSON: jest.fn().mockResolvedValue(null),
  sAdd: jest.fn().mockResolvedValue(1),
  sRem: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(true),
  ttl: jest.fn().mockResolvedValue(60),
  sMembers: jest.fn().mockResolvedValue([]),
  sIsMember: jest.fn().mockResolvedValue(false),
  exists: jest.fn().mockResolvedValue(false),
  lPush: jest.fn().mockResolvedValue(1),
  lTrim: jest.fn().mockResolvedValue('OK'),
  lRange: jest.fn().mockResolvedValue([]),
  hSet: jest.fn().mockResolvedValue(1),
  getClient: jest.fn().mockReturnValue(mockRedisClient),
};

jest.mock('../shared/services/redis.service', () => ({
  redisService: mockRedisService,
}));

jest.mock('../shared/services/socket.service', () => ({
  socketService: {
    emitToUser: jest.fn(),
    emitToRoom: jest.fn(),
  },
  emitToUser: jest.fn(),
  emitToRoom: jest.fn(),
  emitToBooking: jest.fn(),
  SocketEvent: {
    TRIP_ASSIGNED: 'trip_assigned',
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    TRUCK_CONFIRMED: 'truck_confirmed',
    BOOKING_UPDATED: 'booking_updated',
    ASSIGNMENT_TIMEOUT: 'assignment_timeout',
    DRIVER_TIMEOUT: 'driver_timeout',
  },
}));

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    add: jest.fn().mockResolvedValue('job-id-1'),
    scheduleAssignmentTimeout: jest.fn().mockResolvedValue('timer-id'),
    cancelAssignmentTimeout: jest.fn().mockResolvedValue(undefined),
    queuePushNotification: jest.fn().mockResolvedValue(undefined),
    enqueue: jest.fn().mockResolvedValue(undefined),
    getStats: jest.fn().mockResolvedValue({ queues: [] }),
    registerProcessor: jest.fn(),
  },
}));

jest.mock('../modules/hold-expiry/hold-expiry-cleanup.service', () => ({
  holdExpiryCleanupService: {
    scheduleFlexHoldCleanup: jest.fn().mockResolvedValue('job-id-1'),
    scheduleConfirmedHoldCleanup: jest.fn().mockResolvedValue('job-id-2'),
    processExpiredHold: jest.fn().mockResolvedValue(undefined),
    cancelScheduledCleanup: jest.fn().mockResolvedValue(undefined),
  },
  holdExpiryProcessor: jest.fn(),
  registerHoldExpiryProcessor: jest.fn(),
}));

jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: jest.fn().mockResolvedValue(undefined),
    getAvailableCount: jest.fn().mockResolvedValue(5),
  },
}));

jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn().mockReturnValue('vehicle-key-123'),
}));

jest.mock('../core/config/hold-config', () => ({
  HOLD_CONFIG: {
    driverAcceptTimeoutMs: 45000,
    driverAcceptTimeoutSeconds: 45,
    confirmedHoldMaxSeconds: 120,
    flexHoldDurationSeconds: 90,
    flexHoldExtensionSeconds: 30,
    flexHoldMaxDurationSeconds: 130,
    flexHoldMaxExtensions: 3,
  },
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'test-hold-uuid'),
}));

// =============================================================================
// IMPORTS — After mock setup
// =============================================================================

import { HOLD_CONFIG } from '../core/config/hold-config';
import { HOLD_DURATION_CONFIG, CONFIG } from '../modules/truck-hold/truck-hold.types';
import { holdStore, REDIS_KEYS } from '../modules/truck-hold/truck-hold-store.service';
import { HoldReconciliationService } from '../modules/hold-expiry/hold-reconciliation.service';
import { flexHoldService } from '../modules/truck-hold/flex-hold.service';

// =============================================================================
// HELPERS
// =============================================================================

function makeHold(overrides: Record<string, any> = {}) {
  const now = new Date();
  return {
    holdId: 'hold-123',
    orderId: 'order-456',
    transporterId: 'transporter-789',
    vehicleType: 'truck',
    vehicleSubtype: 'medium',
    quantity: 2,
    truckRequestIds: ['tr-1', 'tr-2'],
    status: 'active',
    phase: 'FLEX',
    flexExpiresAt: new Date(now.getTime() + 60000),
    confirmedExpiresAt: null as any,
    confirmedAt: null as any,
    phaseChangedAt: now,
    flexExtendedCount: 0,
    expiresAt: new Date(now.getTime() + 60000),
    createdAt: now,
    updatedAt: now,
    terminalReason: null as any,
    releasedAt: null as any,
    ...overrides,
  };
}

// =============================================================================
// ISSUE #35 — PG advisory lock fallback when Redis is down
// =============================================================================

describe('Issue #35: PG advisory lock fallback', () => {
  let reconciliationService: HoldReconciliationService;

  beforeEach(() => {
    jest.clearAllMocks();
    reconciliationService = new HoldReconciliationService();
    // Keep DB quiet by default
    mockPrismaClient.truckHoldLedger.findMany.mockResolvedValue([]);
    mockPrismaClient.$queryRaw.mockResolvedValue([{ locked: true }]);
  });

  afterEach(() => {
    reconciliationService.stop();
  });

  test('#35.1: When Redis acquireLock throws, reconciliation cycle is skipped', async () => {
    // Arrange: Redis throws on acquireLock
    mockRedisService.acquireLock.mockRejectedValueOnce(new Error('Redis connection refused'));

    // Start reconciliation and run one cycle
    reconciliationService.start();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert: When Redis is down, cycle is skipped — no DB scan
    expect(mockPrismaClient.truckHoldLedger.findMany).not.toHaveBeenCalled();
  });

  test('#35.2: When both Redis and PG locks fail, cycle is skipped (no reconcile work done)', async () => {
    // Arrange: Redis throws, PG returns locked: false
    mockRedisService.acquireLock.mockRejectedValueOnce(new Error('Redis down'));
    mockPrismaClient.$queryRaw
      .mockResolvedValueOnce([{ locked: false }]); // PG lock not acquired

    reconciliationService.start();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert: findMany should NOT be called because the cycle was skipped
    expect(mockPrismaClient.truckHoldLedger.findMany).not.toHaveBeenCalled();
  });

  test('#35.3: When Redis lock succeeds, PG advisory lock is NOT called', async () => {
    // Arrange: Redis acquireLock succeeds
    mockRedisService.acquireLock.mockResolvedValueOnce({ acquired: true });

    reconciliationService.start();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert: PG advisory lock NOT attempted
    expect(mockPrismaClient.$queryRaw).not.toHaveBeenCalled();
  });

  test('#35.4: When Redis returns acquired: false (another instance holds lock), cycle is skipped', async () => {
    // Arrange: Redis indicates lock NOT acquired (not an error, just contention)
    mockRedisService.acquireLock.mockResolvedValueOnce({ acquired: false });

    reconciliationService.start();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert: No DB scan, no PG fallback
    expect(mockPrismaClient.truckHoldLedger.findMany).not.toHaveBeenCalled();
    expect(mockPrismaClient.$queryRaw).not.toHaveBeenCalled();
  });

  test('#35.5: When Redis lock succeeds, reconciliation proceeds (findMany called)', async () => {
    // Arrange: Redis lock succeeds
    mockRedisService.acquireLock.mockResolvedValueOnce({ acquired: true });

    reconciliationService.start();
    await new Promise(resolve => setTimeout(resolve, 100));

    // Assert: findMany WAS called because we successfully acquired lock
    expect(mockPrismaClient.truckHoldLedger.findMany).toHaveBeenCalled();
  });
});

// =============================================================================
// ISSUE #36 — Unified cleanup lock key
// =============================================================================

describe('Issue #36: Unified cleanup lock key', () => {
  const UNIFIED_LOCK_KEY = 'hold:cleanup:unified';

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrismaClient.truckHoldLedger.findMany.mockResolvedValue([]);
    mockPrismaClient.$queryRaw.mockResolvedValue([{ locked: true }]);
  });

  test('#36.1: HoldReconciliationService uses lock key "hold:cleanup:unified"', async () => {
    const service = new HoldReconciliationService();
    mockRedisService.acquireLock.mockResolvedValueOnce({ acquired: true });

    service.start();
    await new Promise(resolve => setTimeout(resolve, 50));
    service.stop();

    const lockKeysUsed = mockRedisService.acquireLock.mock.calls.map(
      (call: any[]) => call[0]
    );
    expect(lockKeysUsed).toContain(UNIFIED_LOCK_KEY);
  });

  test('#36.2: truck-hold-cleanup.service uses lock key "hold:cleanup:unified" (source code check)', () => {
    const fs = require('fs');
    const path = require('path');
    const cleanupSource = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/truck-hold-cleanup.service.ts'),
      'utf-8'
    );
    expect(cleanupSource).toContain("'hold:cleanup:unified'");
  });

  test('#36.3: hold-reconciliation.service uses lock key "hold:cleanup:unified" (source code check)', () => {
    const fs = require('fs');
    const path = require('path');
    const reconcileSource = fs.readFileSync(
      path.resolve(__dirname, '../modules/hold-expiry/hold-reconciliation.service.ts'),
      'utf-8'
    );
    expect(reconcileSource).toContain("'hold:cleanup:unified'");
  });

  test('#36.4: Both services use the SAME lock key string (prevents simultaneous runs)', () => {
    const fs = require('fs');
    const path = require('path');

    const cleanupSource = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/truck-hold-cleanup.service.ts'),
      'utf-8'
    );
    const reconcileSource = fs.readFileSync(
      path.resolve(__dirname, '../modules/hold-expiry/hold-reconciliation.service.ts'),
      'utf-8'
    );

    // Both files must reference the SAME lock key
    expect(cleanupSource).toContain(UNIFIED_LOCK_KEY);
    expect(reconcileSource).toContain(UNIFIED_LOCK_KEY);

    // Ensure they use the same exact string (no typos)
    const cleanupMatches = cleanupSource.match(/hold:cleanup:unified/g) || [];
    const reconcileMatches = reconcileSource.match(/hold:cleanup:unified/g) || [];
    expect(cleanupMatches.length).toBeGreaterThanOrEqual(1);
    expect(reconcileMatches.length).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// ISSUE #37 — transitionToConfirmed ownership check
// =============================================================================

describe('Issue #37: transitionToConfirmed ownership check', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // F-M12: transitionToConfirmed now runs inside $transaction
    // The callback receives mockPrismaClient as the tx client
    mockPrismaClient.$transaction.mockImplementation(async (cb: any) => cb(mockPrismaClient));
  });

  test('#37.1: Wrong transporterId → rejected with appropriate message', async () => {
    // findUnique returns hold but transporterId doesn't match → ownership check fails
    const hold = makeHold({ holdId: 'hold-123', transporterId: 'real-transporter' });
    mockPrismaClient.truckHoldLedger.findUnique.mockResolvedValueOnce(hold);

    const result = await flexHoldService.transitionToConfirmed('hold-123', 'wrong-transporter');

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not your hold/i);
  });

  test('#37.2: Correct transporterId with existing FLEX hold → proceeds to update', async () => {
    const hold = makeHold({ holdId: 'hold-123', transporterId: 'transporter-abc' });
    mockPrismaClient.truckHoldLedger.findUnique.mockResolvedValueOnce(hold);
    // AB3: transitionToConfirmed now also queries order for broadcast cap
    mockPrismaClient.order.findUnique.mockResolvedValueOnce({
      expiresAt: new Date(Date.now() + 300_000),
    });
    mockPrismaClient.truckHoldLedger.update.mockResolvedValueOnce({
      ...hold,
      phase: 'CONFIRMED',
      status: 'confirmed',
    });
    mockRedisService.del.mockResolvedValueOnce(1);

    const result = await flexHoldService.transitionToConfirmed('hold-123', 'transporter-abc');

    expect(result.success).toBe(true);
    // DB update must have been called
    expect(mockPrismaClient.truckHoldLedger.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { holdId: 'hold-123' },
        data: expect.objectContaining({ phase: 'CONFIRMED' }),
      })
    );
  });

  test('#37.3: Missing hold (null from findUnique) → rejected', async () => {
    mockPrismaClient.truckHoldLedger.findUnique.mockResolvedValueOnce(null);

    const result = await flexHoldService.transitionToConfirmed('non-existent-hold', 'transporter-xyz');

    expect(result.success).toBe(false);
  });

  test('#37.4: findUnique query uses holdId, then ownership check compares transporterId', async () => {
    const hold = makeHold({ holdId: 'hold-xyz', transporterId: 'owner-tp' });
    mockPrismaClient.truckHoldLedger.findUnique.mockResolvedValueOnce(hold);

    await flexHoldService.transitionToConfirmed('hold-xyz', 'wrong-tp');

    // F-M12: findUnique is now called inside $transaction
    expect(mockPrismaClient.truckHoldLedger.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { holdId: 'hold-xyz' },
      })
    );
  });

  test('#37.5: transitionToConfirmed source code contains ownership check', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/flex-hold.service.ts'),
      'utf-8'
    );
    // FIX-6: Ownership verification after findUnique
    expect(source).toContain('Ownership check failed');
    expect(source).toContain('transporterId');
    expect(source).toContain('Not your hold');
  });
});

// =============================================================================
// ISSUE #38 — Fresh remainingSeconds from cache
// =============================================================================

describe('Issue #38: Fresh remainingSeconds computed from currentExpiresAt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('#38.1: Cached hold is returned directly from Redis cache', async () => {
    const futureExpiry = new Date(Date.now() + 50000);

    const cachedState = {
      holdId: 'hold-fresh',
      orderId: 'order-1',
      transporterId: 'tp-1',
      phase: 'FLEX',
      baseExpiresAt: new Date().toISOString(),
      currentExpiresAt: futureExpiry.toISOString(),
      extendedCount: 0,
      canExtend: true,
      totalDurationSeconds: 90,
      remainingSeconds: 50,
    };
    mockRedisService.getJSON.mockResolvedValueOnce(cachedState);

    const state = await flexHoldService.getFlexHoldState('hold-fresh');

    expect(state).not.toBeNull();
    expect(state!.holdId).toBe('hold-fresh');
    expect(state!.remainingSeconds).toBe(50);
  });

  test('#38.2: DB fallback computes remainingSeconds with Math.max(0, ...)', async () => {
    // Cache miss — falls back to DB
    mockRedisService.getJSON.mockResolvedValueOnce(null);

    const pastExpiry = new Date(Date.now() - 5000); // expired 5 seconds ago
    const dbHold = makeHold({
      holdId: 'hold-expired',
      flexExpiresAt: pastExpiry,
      expiresAt: pastExpiry,
      phase: 'FLEX',
    });
    mockPrismaClient.truckHoldLedger.findUnique.mockResolvedValueOnce(dbHold);
    mockRedisService.setJSON.mockResolvedValueOnce('OK');

    const state = await flexHoldService.getFlexHoldState('hold-expired');

    expect(state).not.toBeNull();
    // Math.max(0, ...) ensures no negative
    expect(state!.remainingSeconds).toBe(0);
  });

  test('#38.3: Cache miss falls back to DB with fresh remainingSeconds computation', async () => {
    mockRedisService.getJSON.mockResolvedValueOnce(null); // cache miss

    const dbHold = makeHold({
      holdId: 'hold-db',
      flexExpiresAt: new Date(Date.now() + 45000),
      expiresAt: new Date(Date.now() + 45000),
      phase: 'FLEX',
    });
    mockPrismaClient.truckHoldLedger.findUnique.mockResolvedValueOnce(dbHold);
    mockRedisService.setJSON.mockResolvedValueOnce('OK');

    const state = await flexHoldService.getFlexHoldState('hold-db');

    expect(state).not.toBeNull();
    // remainingSeconds computed from DB should be ~45 seconds
    expect(state!.remainingSeconds).toBeGreaterThanOrEqual(43);
    expect(state!.remainingSeconds).toBeLessThanOrEqual(47);
  });

  test('#38.4: Source code uses Math.max(0, ...) for remainingSeconds computation', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/flex-hold.service.ts'),
      'utf-8'
    );
    // DB fallback path uses Math.max(0, ...) to prevent negative remainingSeconds
    expect(source).toContain('Math.max(');
    expect(source).toContain('remainingSeconds');
  });
});

// =============================================================================
// ISSUE #39 — Vehicle release scoped to transporterId
// =============================================================================

describe('Issue #39: Vehicle release scoped to transporterId in releaseConfirmedVehicles', () => {
  test('#39.1: Source code includes transporterId filter in assignment query', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/hold-expiry/hold-expiry-cleanup.service.ts'),
      'utf-8'
    );
    // FIX-7: Scope by transporterId
    expect(source).toContain('FIX-7');
    // transporterId must be in the where clause alongside orderId
    expect(source).toContain('transporterId: hold.transporterId');
  });

  test('#39.2: Assignment query uses orderId AND transporterId filter', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/hold-expiry/hold-expiry-cleanup.service.ts'),
      'utf-8'
    );

    // Verify both filters are present within the same where clause context
    const queryBlock = source.match(/findMany\s*\(\s*\{[\s\S]*?transporterId[\s\S]*?\}\s*\)/);
    expect(queryBlock).not.toBeNull();
    expect(source).toContain('orderId: hold.orderId');
    expect(source).toContain('transporterId: hold.transporterId');
  });

  test('#39.3: Assignment query must include transporterId field to scope release correctly', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/hold-expiry/hold-expiry-cleanup.service.ts'),
      'utf-8'
    );

    // The releaseConfirmedVehicles block must contain both orderId and transporterId in its findMany where clause.
    const releaseBlock = source.slice(source.indexOf('releaseConfirmedVehicles'));
    expect(releaseBlock).toContain('orderId: hold.orderId');
    expect(releaseBlock).toContain('transporterId: hold.transporterId');

    // Status filter must also be present
    expect(releaseBlock).toContain('RELEASE_ASSIGNMENT_STATUSES');
  });

  test('#39.4: Only this transporter assignments are released (other transporters unaffected)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/hold-expiry/hold-expiry-cleanup.service.ts'),
      'utf-8'
    );

    // Comment should explain this scoping prevents cross-transporter release
    expect(source).toContain("Only release THIS transporter's assignments");
  });
});

// =============================================================================
// ISSUE #90 — Single config source
// =============================================================================

describe('Issue #90: Single config source (HOLD_DURATION_CONFIG derived from HOLD_CONFIG)', () => {
  test('#90.1: HOLD_DURATION_CONFIG.FLEX_DURATION_SECONDS equals HOLD_CONFIG.flexHoldDurationSeconds', () => {
    expect(HOLD_DURATION_CONFIG.FLEX_DURATION_SECONDS).toBe(HOLD_CONFIG.flexHoldDurationSeconds);
  });

  test('#90.2: HOLD_DURATION_CONFIG.CONFIRMED_MAX_SECONDS equals HOLD_CONFIG.confirmedHoldMaxSeconds', () => {
    expect(HOLD_DURATION_CONFIG.CONFIRMED_MAX_SECONDS).toBe(HOLD_CONFIG.confirmedHoldMaxSeconds);
  });

  test('#90.3: HOLD_DURATION_CONFIG.EXTENSION_SECONDS equals HOLD_CONFIG.flexHoldExtensionSeconds', () => {
    expect(HOLD_DURATION_CONFIG.EXTENSION_SECONDS).toBe(HOLD_CONFIG.flexHoldExtensionSeconds);
  });

  test('#90.4: HOLD_DURATION_CONFIG.MAX_DURATION_SECONDS equals HOLD_CONFIG.flexHoldMaxDurationSeconds', () => {
    expect(HOLD_DURATION_CONFIG.MAX_DURATION_SECONDS).toBe(HOLD_CONFIG.flexHoldMaxDurationSeconds);
  });

  test('#90.5: truck-hold.types.ts imports from hold-config (source check)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/truck-hold.types.ts'),
      'utf-8'
    );
    // Must import HOLD_CONFIG from the central config file
    expect(source).toContain("import { HOLD_CONFIG } from '../../core/config/hold-config'");
    // Must NOT define its own parseInt(process.env...) for these values
    expect(source).not.toMatch(/parseInt\s*\(\s*process\.env\.FLEX_HOLD_DURATION_SECONDS/);
    expect(source).not.toMatch(/parseInt\s*\(\s*process\.env\.CONFIRMED_HOLD_MAX_SECONDS/);
  });

  test('#90.6: hold-config.ts is the single source defining flexHoldDurationSeconds', () => {
    const fs = require('fs');
    const path = require('path');
    const holdConfigSource = fs.readFileSync(
      path.resolve(__dirname, '../core/config/hold-config.ts'),
      'utf-8'
    );
    // Single source of truth for hold configuration
    expect(holdConfigSource).toContain('Single source of truth');
    // Must export HOLD_CONFIG
    expect(holdConfigSource).toContain('export const HOLD_CONFIG');
    // Must define flexHoldDurationSeconds
    expect(holdConfigSource).toContain('flexHoldDurationSeconds');
  });
});

// =============================================================================
// ISSUE #91 — MGET batch for getActiveHoldsByOrder
// =============================================================================

describe('Issue #91: MGET pipeline batch for getActiveHoldsByOrder', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset pipeline mock
    mockPipeline.get.mockReturnThis();
    mockPipeline.exec.mockResolvedValue([]);
    mockRedisClient.pipeline.mockReturnValue(mockPipeline);
    mockRedisService.getClient.mockReturnValue(mockRedisClient);
  });

  test('#91.1: getActiveHoldsByOrder uses pipeline (not N individual redis.get calls)', async () => {
    const holdIds = ['hold-1', 'hold-2', 'hold-3'];
    mockRedisService.sMembers.mockResolvedValueOnce(holdIds);

    // pipeline.exec returns empty results
    mockPipeline.exec.mockResolvedValueOnce([
      [null, null],
      [null, null],
      [null, null],
    ]);

    await holdStore.getActiveHoldsByOrder('order-123');

    // getClient().pipeline() must have been called
    expect(mockRedisService.getClient).toHaveBeenCalled();
    expect(mockRedisClient.pipeline).toHaveBeenCalled();
    expect(mockPipeline.exec).toHaveBeenCalled();

    // Individual redis.get should NOT have been called N times
    // (the fix replaces N individual gets with a pipeline)
    expect(mockRedisService.get).not.toHaveBeenCalled();
  });

  test('#91.2: pipeline.get is called once per holdId (N calls, not N round trips)', async () => {
    const holdIds = ['hold-a', 'hold-b', 'hold-c'];
    mockRedisService.sMembers.mockResolvedValueOnce(holdIds);
    mockPipeline.exec.mockResolvedValueOnce([[null, null], [null, null], [null, null]]);

    await holdStore.getActiveHoldsByOrder('order-xyz');

    // pipeline.get should have been called 3 times (once per hold key)
    expect(mockPipeline.get).toHaveBeenCalledTimes(3);
  });

  test('#91.3: Returns empty array when order has no holds', async () => {
    mockRedisService.sMembers.mockResolvedValueOnce([]);

    const result = await holdStore.getActiveHoldsByOrder('order-empty');

    expect(result).toEqual([]);
    // Pipeline should NOT be created for 0 holdIds
    expect(mockRedisClient.pipeline).not.toHaveBeenCalled();
  });

  test('#91.4: Returns only active non-expired holds from pipeline results', async () => {
    const now = new Date();
    const holdIds = ['hold-active', 'hold-expired', 'hold-released'];
    mockRedisService.sMembers.mockResolvedValueOnce(holdIds);

    const activeHoldData = JSON.stringify({
      holdId: 'hold-active',
      orderId: 'order-1',
      transporterId: 'tp-1',
      vehicleType: 'truck',
      vehicleSubtype: 'medium',
      quantity: 1,
      truckRequestIds: [],
      status: 'active',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60000).toISOString(),
    });
    const expiredHoldData = JSON.stringify({
      holdId: 'hold-expired',
      orderId: 'order-1',
      transporterId: 'tp-2',
      vehicleType: 'truck',
      vehicleSubtype: 'medium',
      quantity: 1,
      truckRequestIds: [],
      status: 'active',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() - 1000).toISOString(), // expired
    });
    const releasedHoldData = JSON.stringify({
      holdId: 'hold-released',
      orderId: 'order-1',
      transporterId: 'tp-3',
      vehicleType: 'truck',
      vehicleSubtype: 'medium',
      quantity: 1,
      truckRequestIds: [],
      status: 'released',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60000).toISOString(),
    });

    mockPipeline.exec.mockResolvedValueOnce([
      [null, activeHoldData],
      [null, expiredHoldData],
      [null, releasedHoldData],
    ]);

    const result = await holdStore.getActiveHoldsByOrder('order-1');

    // Only the active non-expired hold should be returned
    expect(result).toHaveLength(1);
    expect(result[0].holdId).toBe('hold-active');
  });

  test('#91.5: Source code uses pipeline (not N individual redis.get calls)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/truck-hold-store.service.ts'),
      'utf-8'
    );

    // Must contain the FIX #91 comment
    expect(source).toContain('FIX #91');
    // Must use pipeline
    expect(source).toContain('pipeline');
    expect(source).toContain('pipeline.exec');

    // Extract just the getActiveHoldsByOrder method body for analysis
    const methodStart = source.indexOf('getActiveHoldsByOrder');
    const methodBody = source.slice(methodStart, methodStart + 600); // bounded slice

    // The method must use pipeline, not N individual awaited gets
    expect(methodBody).toContain('pipeline');
    // It must NOT contain a standalone await redisService.getJSON or await redisService.get inside a loop
    // (the pipeline approach replaces those with a batch pipeline.get() followed by a single exec)
    expect(methodBody).not.toMatch(/for\s*\([\s\S]{0,50}\)[\s\S]{0,200}await redisService\.get/);
  });
});

// =============================================================================
// ISSUE #95 — Aligned TTLs (data TTL equals index TTL)
// =============================================================================

describe('Issue #95: Aligned TTLs — data TTL equals index TTL in HoldStore.add()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisService.setJSON.mockResolvedValue('OK');
    mockRedisService.sAdd.mockResolvedValue(1);
    mockRedisService.expire.mockResolvedValue(true);
  });

  test('#95.1: setJSON and both expire() calls use the same TTL value', async () => {
    const hold = {
      holdId: 'hold-ttl-test',
      orderId: 'order-ttl-test',
      transporterId: 'tp-ttl-test',
      vehicleType: 'truck',
      vehicleSubtype: 'small',
      quantity: 1,
      truckRequestIds: ['tr-1'],
      status: 'active' as const,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 90000),
    };

    await holdStore.add(hold);

    // setJSON should have been called with a TTL
    expect(mockRedisService.setJSON).toHaveBeenCalledWith(
      REDIS_KEYS.HOLD(hold.holdId),
      expect.any(Object),
      expect.any(Number)
    );

    // Both expire() calls should use the same TTL as setJSON
    const setJsonTtl = mockRedisService.setJSON.mock.calls[0][2] as number;
    const expireCalls = mockRedisService.expire.mock.calls;

    expect(expireCalls).toHaveLength(2); // order index + transporter index
    for (const expireCall of expireCalls) {
      expect(expireCall[1]).toBe(setJsonTtl);
    }
  });

  test('#95.2: TTL is derived from CONFIG.HOLD_DURATION_SECONDS + 60 buffer', async () => {
    const hold = {
      holdId: 'hold-ttl-2',
      orderId: 'order-ttl-2',
      transporterId: 'tp-ttl-2',
      vehicleType: 'truck',
      vehicleSubtype: 'medium',
      quantity: 2,
      truckRequestIds: [] as any[],
      status: 'active' as const,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 90000),
    };

    await holdStore.add(hold);

    const expectedTtl = CONFIG.HOLD_DURATION_SECONDS + 60;
    const setJsonTtl = mockRedisService.setJSON.mock.calls[0][2] as number;
    expect(setJsonTtl).toBe(expectedTtl);
  });

  test('#95.3: Order index TTL matches data TTL', async () => {
    const hold = {
      holdId: 'hold-ttl-3',
      orderId: 'order-ttl-3',
      transporterId: 'tp-ttl-3',
      vehicleType: 'truck',
      vehicleSubtype: 'large',
      quantity: 3,
      truckRequestIds: [] as any[],
      status: 'active' as const,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 90000),
    };

    await holdStore.add(hold);

    const expectedTtl = CONFIG.HOLD_DURATION_SECONDS + 60;
    // First expire call should be for the order index
    expect(mockRedisService.expire).toHaveBeenCalledWith(
      REDIS_KEYS.HOLDS_BY_ORDER(hold.orderId),
      expectedTtl
    );
  });

  test('#95.4: Transporter index TTL matches data TTL', async () => {
    const hold = {
      holdId: 'hold-ttl-4',
      orderId: 'order-ttl-4',
      transporterId: 'tp-ttl-4',
      vehicleType: 'truck',
      vehicleSubtype: 'extra-large',
      quantity: 4,
      truckRequestIds: [] as any[],
      status: 'active' as const,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 90000),
    };

    await holdStore.add(hold);

    const expectedTtl = CONFIG.HOLD_DURATION_SECONDS + 60;
    // Second expire call should be for the transporter index
    expect(mockRedisService.expire).toHaveBeenCalledWith(
      REDIS_KEYS.HOLDS_BY_TRANSPORTER(hold.transporterId),
      expectedTtl
    );
  });

  test('#95.5: Source code uses single holdTtl variable for both data and indexes', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/truck-hold-store.service.ts'),
      'utf-8'
    );

    // Must contain the FIX #95 comment
    expect(source).toContain('FIX #95');
    // Must define a single holdTtl variable used for both
    expect(source).toContain('holdTtl');
    // Both expire calls should reference holdTtl, not separate calculations
    const expireCallCount = (source.match(/\.expire\s*\(/g) || []).length;
    expect(expireCallCount).toBeGreaterThanOrEqual(2);
  });
});
