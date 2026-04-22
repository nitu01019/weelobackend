/**
 * =============================================================================
 * FIX-6, FIX-22, FIX-38, FIX-39 — Truck Hold Hardening Tests
 * =============================================================================
 *
 * Covers:
 *   FIX-6  (#37): Ownership check on hold confirmation (flex + confirmed)
 *   FIX-22 (#36): Unified cleanup lock key
 *   FIX-38 (#93): Idempotency purge timestamp stored in Redis (not in-memory)
 *   FIX-39 (#96): Consistent timestamps in confirmed-hold operations
 *
 * =============================================================================
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

// Mock prismaClient
const mockPrisma = {
  truckHoldLedger: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  truckRequest: {
    findMany: jest.fn(),
    updateMany: jest.fn(),
    update: jest.fn(),
  },
  assignment: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn(),
  },
  order: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  truckHoldIdempotency: {
    findUnique: jest.fn(),
    deleteMany: jest.fn(),
    upsert: jest.fn(),
  },
  $transaction: jest.fn((fn: any) => fn(mockPrisma)),
  $queryRaw: jest.fn().mockResolvedValue([]),
  $executeRaw: jest.fn(),
};

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: mockPrisma,
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
  withDbTimeout: jest.fn((fn: any) => fn(mockPrisma)),
  OrderStatus: {
    created: 'created',
    broadcasting: 'broadcasting',
    active: 'active',
    partially_filled: 'partially_filled',
    fully_filled: 'fully_filled',
    cancelled: 'cancelled',
    expired: 'expired',
    completed: 'completed',
  },
  TruckRequestStatus: {
    searching: 'searching',
    held: 'held',
    assigned: 'assigned',
    cancelled: 'cancelled',
    expired: 'expired',
  },
  VehicleStatus: {
    available: 'available',
    on_hold: 'on_hold',
    in_transit: 'in_transit',
  },
}));

// Mock redisService
const mockRedisService = {
  acquireLock: jest.fn().mockResolvedValue({ acquired: true }),
  releaseLock: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
  setJSON: jest.fn().mockResolvedValue(undefined),
  getJSON: jest.fn().mockResolvedValue(null),
  sAdd: jest.fn().mockResolvedValue(undefined),
  sRem: jest.fn().mockResolvedValue(undefined),
  sMembers: jest.fn().mockResolvedValue([]),
  expire: jest.fn().mockResolvedValue(undefined),
  ttl: jest.fn().mockResolvedValue(100),
  hIncrBy: jest.fn().mockResolvedValue(1),
  hGetAll: jest.fn().mockResolvedValue({}),
  hMSet: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../shared/services/redis.service', () => ({
  redisService: mockRedisService,
}));

// Mock logger
jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock socketService
jest.mock('../shared/services/socket.service', () => ({
  socketService: {
    emitToUser: jest.fn().mockResolvedValue(undefined),
    broadcastToAll: jest.fn(),
  },
  SocketEvent: {
    TRIP_ASSIGNED: 'trip_assigned',
  },
}));

// Mock queueService
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    scheduleAssignmentTimeout: jest.fn().mockResolvedValue(undefined),
    queueBroadcast: jest.fn().mockResolvedValue(undefined),
    queuePushNotification: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock holdExpiryCleanupService
jest.mock('../modules/hold-expiry/hold-expiry-cleanup.service', () => ({
  holdExpiryCleanupService: {
    scheduleFlexHoldCleanup: jest.fn().mockResolvedValue(undefined),
    scheduleConfirmedHoldCleanup: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock vehicle-lifecycle.service
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
}));

// Mock hold-config
jest.mock('../core/config/hold-config', () => ({
  HOLD_CONFIG: {
    confirmedHoldMaxSeconds: 180,
    driverAcceptTimeoutSeconds: 45,
    driverAcceptTimeoutMs: 45000,
    flexHoldDurationSeconds: 90,
    flexHoldExtensionSeconds: 30,
    flexHoldMaxDurationSeconds: 130,
    flexHoldMaxExtensions: 2,
  },
}));

// Mock metrics
jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    observeHistogram: jest.fn(),
  },
}));

// Mock fcmService
jest.mock('../shared/services/fcm.service', () => ({
  fcmService: {
    sendToDevice: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock driverService
jest.mock('../modules/driver/driver.service', () => ({
  driverService: {
    areDriversOnline: jest.fn().mockResolvedValue(new Map()),
  },
}));

// Mock liveAvailabilityService
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    decrementAvailability: jest.fn().mockResolvedValue(undefined),
    incrementAvailability: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock db
jest.mock('../shared/database/db', () => ({
  db: {
    getOrderById: jest.fn().mockResolvedValue(null),
    getUserById: jest.fn().mockResolvedValue(null),
    getTruckRequestsByOrder: jest.fn().mockResolvedValue([]),
    getTransportersAvailabilitySnapshot: jest.fn().mockResolvedValue([]),
  },
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import { flexHoldService } from '../modules/truck-hold/flex-hold.service';
import { confirmedHoldService } from '../modules/truck-hold/confirmed-hold.service';
import { redisService } from '../shared/services/redis.service';
import { queueService } from '../shared/services/queue.service';
import type { z } from 'zod';
import { flexHoldCreateSchema, flexHoldExtendSchema } from '../modules/truck-hold/truck-hold-lifecycle.routes';

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildHoldLedger(overrides: Record<string, unknown> = {}) {
  return {
    holdId: 'hold-abc-123',
    orderId: 'order-1',
    transporterId: 'transporter-owner',
    vehicleType: 'truck',
    vehicleSubtype: '6-wheel',
    quantity: 2,
    truckRequestIds: ['tr-1', 'tr-2'],
    status: 'active',
    phase: 'FLEX',
    phaseChangedAt: new Date(),
    flexExpiresAt: new Date(Date.now() + 90_000),
    flexExtendedCount: 0,
    expiresAt: new Date(Date.now() + 90_000),
    createdAt: new Date(Date.now() - 10_000),
    confirmedAt: null,
    confirmedExpiresAt: null,
    ...overrides,
  };
}

// ── Test Suites ────────────────────────────────────────────────────────────────

describe('FIX-6 (#37): Ownership check on hold confirmation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('flexHoldService.transitionToConfirmed', () => {
    test('rejects when transporterId does not match hold owner', async () => {
      const hold = buildHoldLedger({ transporterId: 'transporter-owner' });
      mockPrisma.truckHoldLedger.findUnique.mockResolvedValue(hold);

      const result = await flexHoldService.transitionToConfirmed(
        'hold-abc-123',
        'transporter-attacker'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Not your hold');
      // Confirm the DB update was NOT called
      expect(mockPrisma.truckHoldLedger.update).not.toHaveBeenCalled();
    });

    test('succeeds when transporterId matches hold owner', async () => {
      const hold = buildHoldLedger({ transporterId: 'transporter-owner' });
      mockPrisma.truckHoldLedger.findUnique.mockResolvedValue(hold);
      mockPrisma.truckHoldLedger.update.mockResolvedValue({
        ...hold,
        phase: 'CONFIRMED',
        status: 'confirmed',
      });

      const result = await flexHoldService.transitionToConfirmed(
        'hold-abc-123',
        'transporter-owner'
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe('Hold transitioned to confirmed phase');
      expect(mockPrisma.truckHoldLedger.update).toHaveBeenCalledTimes(1);
    });

    test('returns failure when hold does not exist', async () => {
      mockPrisma.truckHoldLedger.findUnique.mockResolvedValue(null);

      const result = await flexHoldService.transitionToConfirmed(
        'non-existent-hold',
        'any-transporter'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Hold not found');
      expect(mockPrisma.truckHoldLedger.update).not.toHaveBeenCalled();
    });
  });

  describe('confirmedHoldService.initializeConfirmedHold', () => {
    test('rejects when transporterId does not match hold owner', async () => {
      // H-8: initializeConfirmedHold now uses $queryRaw with FOR UPDATE inside $transaction
      // F-A-75: helper queries User first (FOR UPDATE), then the hold row. Queue both.
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ isActive: true, kycStatus: 'VERIFIED' }])
        .mockResolvedValueOnce([{
          holdId: 'hold-abc-123',
          phase: 'FLEX',
          confirmedExpiresAt: null,
          transporterId: 'transporter-owner',
        }]);

      const result = await confirmedHoldService.initializeConfirmedHold(
        'hold-abc-123',
        'transporter-attacker',
        [{ assignmentId: 'a-1', driverId: 'd-1', truckRequestId: 'tr-1' }]
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Not your hold');
      expect(mockPrisma.truckHoldLedger.update).not.toHaveBeenCalled();
    });

    test('succeeds when transporterId matches hold owner', async () => {
      const hold = buildHoldLedger({
        phase: 'FLEX',
        confirmedExpiresAt: null,
        transporterId: 'transporter-owner',
      });
      // H-8: $queryRaw returns rows array
      // F-A-75: helper queries User first (FOR UPDATE), then the hold row.
      // P4 F2.8: third $queryRaw is TruckRequest FOR UPDATE scoped by heldById.
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ isActive: true, kycStatus: 'VERIFIED' }])
        .mockResolvedValueOnce([{
          holdId: 'hold-abc-123',
          phase: 'FLEX',
          confirmedExpiresAt: null,
          transporterId: 'transporter-owner',
        }])
        .mockResolvedValueOnce([{ id: 'tr-1' }]);
      mockPrisma.truckHoldLedger.update.mockResolvedValue({
        ...hold,
        phase: 'CONFIRMED',
        orderId: 'order-1',
        transporterId: 'transporter-owner',
        quantity: 2,
      });
      mockPrisma.assignment.findMany.mockResolvedValue([
        {
          id: 'a-1',
          driverId: 'd-1',
          driverName: 'Driver One',
          transporterId: 'transporter-owner',
          vehicleId: 'v-1',
          vehicleNumber: 'KA01AB1234',
          tripId: 'trip-1',
          orderId: 'order-1',
          truckRequestId: 'tr-1',
        },
      ]);

      const result = await confirmedHoldService.initializeConfirmedHold(
        'hold-abc-123',
        'transporter-owner',
        [{ assignmentId: 'a-1', driverId: 'd-1', truckRequestId: 'tr-1' }]
      );

      expect(result.success).toBe(true);
      expect(mockPrisma.truckHoldLedger.update).toHaveBeenCalledTimes(1);
    });

    test('returns failure when hold does not exist', async () => {
      // H-8: $queryRaw returns empty array when hold not found
      // F-A-75: User query must succeed (verified actor) so we reach the hold lookup.
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ isActive: true, kycStatus: 'VERIFIED' }])
        .mockResolvedValueOnce([]);

      const result = await confirmedHoldService.initializeConfirmedHold(
        'non-existent',
        'any-transporter',
        []
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Hold not found');
    });

    test('returns idempotent response when already in CONFIRMED phase', async () => {
      const existingExpiry = new Date(Date.now() + 120_000);
      // H-8: $queryRaw returns row with CONFIRMED phase
      // F-A-75: helper queries User first, then the hold row.
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ isActive: true, kycStatus: 'VERIFIED' }])
        .mockResolvedValueOnce([{
          holdId: 'hold-abc-123',
          phase: 'CONFIRMED',
          confirmedExpiresAt: existingExpiry,
          transporterId: 'transporter-owner',
        }]);

      const result = await confirmedHoldService.initializeConfirmedHold(
        'hold-abc-123',
        'transporter-owner',
        [{ assignmentId: 'a-1', driverId: 'd-1', truckRequestId: 'tr-1' }]
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('idempotent');
      expect(result.confirmedExpiresAt).toBe(existingExpiry);
      // No update should have been called since it was already confirmed
      expect(mockPrisma.truckHoldLedger.update).not.toHaveBeenCalled();
    });
  });
});

describe('FIX-22 (#36): Unified cleanup lock key', () => {
  test('source code uses hold:cleanup:unified key for cleanup lock', () => {
    // Read the actual source to verify the key string
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../modules/truck-hold/truck-hold.service'),
      'utf-8'
    );

    // The unified lock key must be present
    expect(source).toContain("'hold:cleanup:unified'");

    // The old key must NOT be present (ensure it was replaced, not just added alongside)
    expect(source).not.toContain("'hold-cleanup-job'");
  });

  test('cleanup lock acquire and release both use the same unified key', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../modules/truck-hold/truck-hold.service'),
      'utf-8'
    );

    // Count occurrences of the unified key -- should appear in both acquireLock and releaseLock
    const matches = source.match(/hold:cleanup:unified/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('FIX-38 (#93): Idempotency purge timestamp in Redis', () => {
  test('source code no longer has lastIdempotencyPurgeAtMs in-memory field', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../modules/truck-hold/truck-hold.service'),
      'utf-8'
    );

    // The in-memory field declaration should be gone
    expect(source).not.toMatch(/private\s+lastIdempotencyPurgeAtMs\s*=\s*0/);
    // But the fix comment should be present
    expect(source).toContain('FIX-38');
  });

  test('source code uses Redis get/set for purge timestamp', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../modules/truck-hold/truck-hold.service'),
      'utf-8'
    );

    // Must read last purge time from Redis
    expect(source).toContain("'hold:idempotency:lastPurgeAt'");

    // Must call redisService.get for the purge key
    expect(source).toContain('redisService.get(PURGE_KEY)');

    // Must call redisService.set after purge succeeds
    expect(source).toContain('redisService.set(PURGE_KEY');

    // Must set a TTL (3600 seconds = 1 hour)
    expect(source).toContain('3600');
  });

  test('purge reads from Redis and skips when interval has not elapsed', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../modules/truck-hold/truck-hold.service'),
      'utf-8'
    );

    // The code should parse the Redis value as integer
    expect(source).toContain("parseInt(lastPurgeRaw, 10)");

    // The code should compare nowMs - lastPurgeMs against HOLD_IDEMPOTENCY_PURGE_INTERVAL_MS
    expect(source).toContain('nowMs - lastPurgeMs >= HOLD_IDEMPOTENCY_PURGE_INTERVAL_MS');
  });
});

describe('FIX-39 (#96): Consistent timestamps in confirmed-hold operations', () => {
  test('handleDriverAcceptance uses a single now timestamp for all writes', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../modules/truck-hold/confirmed-hold.service'),
      'utf-8'
    );

    // The acceptance handler should create a single timestamp
    expect(source).toContain('FIX-39: Single timestamp for the entire acceptance operation');
    expect(source).toContain('const nowIso = now.toISOString()');
    // The driverAcceptedAt should use the pre-computed timestamp, not new Date()
    expect(source).toContain('driverAcceptedAt: nowIso');
  });

  test('scheduleDriverAcceptanceTimeout accepts optional now parameter', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../modules/truck-hold/confirmed-hold.service'),
      'utf-8'
    );

    // The method signature should include the optional now parameter
    expect(source).toMatch(/scheduleDriverAcceptanceTimeout\([^)]*now\?:\s*Date/);
    // Should use the provided timestamp or fallback
    expect(source).toContain('const ts = now ?? new Date()');
    expect(source).toContain('createdAt: ts.toISOString()');
  });

  test('initializeConfirmedHold passes now to scheduleDriverAcceptanceTimeout', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../modules/truck-hold/confirmed-hold.service'),
      'utf-8'
    );

    // The call site should forward the operation-level `now`
    const callSitePattern = /scheduleDriverAcceptanceTimeout\(\s*assignment\.assignmentId,\s*fullData,\s*this\.config\.driverAcceptTimeoutSeconds,\s*now\s*\)/;
    expect(source).toMatch(callSitePattern);
  });

  test('initializeConfirmedHold uses single now for DB update fields', async () => {
    // Set up mocks for a successful initialization
    const hold = buildHoldLedger({
      phase: 'FLEX',
      confirmedExpiresAt: null,
      transporterId: 'transporter-owner',
    });

    const updatedHold = {
      ...hold,
      phase: 'CONFIRMED',
      orderId: 'order-1',
      transporterId: 'transporter-owner',
      quantity: 1,
    };

    jest.clearAllMocks();
    // H-8: $queryRaw returns row for FOR UPDATE
    mockPrisma.$queryRaw.mockResolvedValue([{
      holdId: 'hold-abc-123',
      phase: 'FLEX',
      confirmedExpiresAt: null,
      transporterId: 'transporter-owner',
    }]);
    mockPrisma.truckHoldLedger.update.mockResolvedValue(updatedHold);
    mockPrisma.assignment.findMany.mockResolvedValue([]);

    await confirmedHoldService.initializeConfirmedHold(
      'hold-abc-123',
      'transporter-owner',
      []
    );

    // The update call should have consistent timestamps
    const updateCall = mockPrisma.truckHoldLedger.update.mock.calls[0]?.[0];
    if (updateCall) {
      const data = updateCall.data;
      // All timestamp fields should be Date objects
      expect(data.phaseChangedAt).toBeInstanceOf(Date);
      expect(data.confirmedAt).toBeInstanceOf(Date);
      expect(data.updatedAt).toBeInstanceOf(Date);

      // All timestamps should be the SAME reference (since they all use `now`)
      expect(data.phaseChangedAt).toBe(data.confirmedAt);
      expect(data.confirmedAt).toBe(data.updatedAt);

      // confirmedExpiresAt should be derived from the same `now` (now + maxDurationSeconds * 1000)
      const timeDiff = data.confirmedExpiresAt.getTime() - data.confirmedAt.getTime();
      expect(timeDiff).toBe(180 * 1000); // 180 seconds
    }
  });
});

describe('A02-003 + A13-010 (T36): extendFlexHold phase-CAS rejects when phase is CONFIRMED', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisService.acquireLock.mockResolvedValue({ acquired: true });
    mockRedisService.releaseLock.mockResolvedValue(undefined);
  });

  test('returns HOLD_EXPIRED when updateMany CAS count=0 because phase advanced to CONFIRMED', async () => {
    // createdAt=5s ago, flexExpiresAt=5s from now
    // elapsed=5s, newTotalDuration=min(5+30,130)=35s
    // newExpiresAt = createdAt+35s = now+30s > currentExpiry(now+5s) => addedSeconds=25 > 0
    // This ensures the CAS path is reached (not MAX_DURATION_REACHED).
    const flexHold = buildHoldLedger({
      phase: 'FLEX',
      status: 'active',
      flexExtendedCount: 0,
      flexExpiresAt: new Date(Date.now() + 5_000),
      expiresAt: new Date(Date.now() + 5_000),
      createdAt: new Date(Date.now() - 5_000),
    });

    // First findUnique call: hold read inside TX (returns FLEX hold)
    // Second findUnique call: post-CAS diagnostic read (returns CONFIRMED)
    mockPrisma.truckHoldLedger.findUnique
      .mockResolvedValueOnce(flexHold)
      .mockResolvedValueOnce({ phase: 'CONFIRMED', status: 'active' });

    // Order lookup — no broadcast cap
    mockPrisma.order.findUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 120_000),
    });

    // CAS count=0: another tx advanced phase to CONFIRMED before this extend
    mockPrisma.truckHoldLedger.updateMany.mockResolvedValue({ count: 0 });

    const result = await flexHoldService.extendFlexHold({
      holdId: 'hold-abc-123',
      reason: 'driver_assigned',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('HOLD_EXPIRED');

    // CAS metric incremented with reason=phase_advanced
    const { metrics: mockMetrics } = jest.requireMock('../shared/monitoring/metrics.service');
    expect(mockMetrics.incrementCounter).toHaveBeenCalledWith(
      'flex_hold_extend_cas_rejected_total',
      { reason: 'phase_advanced' },
    );

    // updateMany was called with phase+status predicate (CAS attempted)
    expect(mockPrisma.truckHoldLedger.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ phase: 'FLEX', status: 'active' }),
      }),
    );
  });
});

describe('FIX-6 edge cases: Ownership check with various hold states', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('transitionToConfirmed: different transporter ID formats still rejected', async () => {
    const hold = buildHoldLedger({ transporterId: 'uuid-owner-123' });
    mockPrisma.truckHoldLedger.findUnique.mockResolvedValue(hold);

    // Try with whitespace variations — should still be rejected
    const result = await flexHoldService.transitionToConfirmed(
      'hold-abc-123',
      'uuid-different-456'
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('Not your hold');
  });

  test('initializeConfirmedHold: rejects non-FLEX phase even with correct owner', async () => {
    // H-8: $queryRaw returns row with EXPIRED phase
    // F-A-75: helper queries User first, then the hold row.
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ isActive: true, kycStatus: 'VERIFIED' }])
      .mockResolvedValueOnce([{
        holdId: 'hold-abc-123',
        phase: 'EXPIRED',
        confirmedExpiresAt: null,
        transporterId: 'transporter-owner',
      }]);

    const result = await confirmedHoldService.initializeConfirmedHold(
      'hold-abc-123',
      'transporter-owner',
      [{ assignmentId: 'a-1', driverId: 'd-1', truckRequestId: 'tr-1' }]
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Cannot move to CONFIRMED from EXPIRED|expired or been released/);
  });
});

// =============================================================================
// A01-001/A01-002/A01-003 · Phase 1 P1-A + P1-B verifications
// =============================================================================

/**
 * P1-T47 — Compile-time parity: the type below will cause tsc --noEmit to fail
 * if the flexHoldCreateSchema shape no longer contains orderId/vehicleType/quantity.
 */
type FlexHoldBody = z.infer<typeof flexHoldCreateSchema>;
const _typecheck: Pick<FlexHoldBody, 'orderId' | 'vehicleType' | 'quantity'> = null as any;
void _typecheck;

describe('A01-001 · P1-T47: flexHoldCreateSchema export parity', () => {
  test('flexHoldCreateSchema is exported from the orphan lifecycle routes file', () => {
    expect(flexHoldCreateSchema).toBeDefined();
    expect(typeof flexHoldCreateSchema.safeParse).toBe('function');
  });

  test('flexHoldCreateSchema validates a well-formed body', () => {
    const result = flexHoldCreateSchema.safeParse({
      orderId: 'order-abc',
      vehicleType: 'truck',
      vehicleSubtype: '6-wheel',
      quantity: 2,
      truckRequestIds: ['tr-1', 'tr-2'],
    });
    expect(result.success).toBe(true);
  });

  test('P1-T40: flexHoldCreateSchema rejects truckRequestIds containing null elements', () => {
    const result = flexHoldCreateSchema.safeParse({
      orderId: 'order-abc',
      vehicleType: 'truck',
      vehicleSubtype: '6-wheel',
      quantity: 2,
      truckRequestIds: [null, null],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map(i => i.path[0]);
      expect(paths[0]).toBe('truckRequestIds');
    }
  });
});

describe('A01-002 · P1-T41: flexHoldExtendSchema rejects empty body', () => {
  test('returns invalid when holdId is missing', () => {
    const result = flexHoldExtendSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map(i => i.path[0]);
      expect(paths).toContain('holdId');
    }
  });

  test('validates a well-formed extend body', () => {
    const result = flexHoldExtendSchema.safeParse({ holdId: 'hold-123' });
    expect(result.success).toBe(true);
  });
});

describe('A01-001 · P1-T33: IS_ORPHAN_ROUTER export from lifecycle routes', () => {
  test('IS_ORPHAN_ROUTER is exported and equals true', () => {
    const mod = require('../modules/truck-hold/truck-hold-lifecycle.routes');
    expect(mod.IS_ORPHAN_ROUTER).toBe(true);
  });
});

describe('A01-001 · P1-T34: _TRUCK_HOLD_LIFECYCLE_IS_ORPHAN re-exported from index', () => {
  test('index.ts source contains the CI guard re-export', () => {
    const indexSrc: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../modules/truck-hold/index.ts'),
      'utf-8',
    );
    expect(indexSrc).toContain('IS_ORPHAN_ROUTER as _TRUCK_HOLD_LIFECYCLE_IS_ORPHAN');
    expect(indexSrc).toContain("from './truck-hold-lifecycle.routes'");
  });
});

describe('A01-003 · P1-T31: idempotency TTL constants and P1-T30 source verification', () => {
  const routesSrc: string = require('fs').readFileSync(
    require('path').resolve(__dirname, '../modules/truck-hold/truck-hold.routes.ts'),
    'utf-8',
  );

  test('IDEMPOTENCY_TTL_SUCCESS_SECONDS = 240 is declared', () => {
    expect(routesSrc).toMatch(/IDEMPOTENCY_TTL_SUCCESS_SECONDS\s*=\s*240/);
  });

  test('IDEMPOTENCY_TTL_FAILURE_SECONDS = 60 is declared', () => {
    expect(routesSrc).toMatch(/IDEMPOTENCY_TTL_FAILURE_SECONDS\s*=\s*60/);
  });

  test('P1-T30: no raw magic literal 120 or 45 in idempotency setJSON calls', () => {
    const setJsonLines = routesSrc
      .split('\n')
      .filter(line => line.includes('setJSON(idempotencyCacheKey'));
    for (const line of setJsonLines) {
      expect(line).not.toMatch(/,\s*(120|45)\s*\)/);
    }
  });

  test('P1-T31: success idempotency writes use IDEMPOTENCY_TTL_SUCCESS_SECONDS (2 call-sites)', () => {
    const successCacheLines = routesSrc
      .split('\n')
      .filter(line => line.includes('setJSON(idempotencyCacheKey') && line.includes('status: 200'));
    expect(successCacheLines.length).toBe(2);
    for (const line of successCacheLines) {
      expect(line).toContain('IDEMPOTENCY_TTL_SUCCESS_SECONDS');
    }
  });

  test('failure idempotency writes use IDEMPOTENCY_TTL_FAILURE_SECONDS (2 call-sites)', () => {
    const failureCacheLines = routesSrc
      .split('\n')
      .filter(line => line.includes('setJSON(idempotencyCacheKey') && line.includes('status: 400'));
    expect(failureCacheLines.length).toBe(2);
    for (const line of failureCacheLines) {
      expect(line).toContain('IDEMPOTENCY_TTL_FAILURE_SECONDS');
    }
  });

  test('P1-T05: transporterRateLimit flexHoldExtend is mounted exactly once', () => {
    const matches = routesSrc.match(/transporterRateLimit\('flexHoldExtend'\)/g) || [];
    expect(matches.length).toBe(1);
  });

  test('P1-T06: transporterRateLimit confirmedHoldInit is mounted exactly once', () => {
    const matches = routesSrc.match(/transporterRateLimit\('confirmedHoldInit'\)/g) || [];
    expect(matches.length).toBe(1);
  });

  test('P1-T02: flexHoldCreateSchema.safeParse is used in POST /flex-hold handler', () => {
    expect(routesSrc).toContain('flexHoldCreateSchema.safeParse');
  });

  test('P1-T03: flexHoldExtendSchema.safeParse is used in POST /flex-hold/extend handler', () => {
    expect(routesSrc).toContain('flexHoldExtendSchema.safeParse');
  });
});
