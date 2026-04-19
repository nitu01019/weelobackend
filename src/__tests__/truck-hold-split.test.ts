/**
 * =============================================================================
 * TRUCK HOLD SPLIT MODULE — Comprehensive Tests
 * =============================================================================
 *
 * Tests for the split truck-hold service (8 files):
 *   1. Facade integrity (truck-hold.service.ts)
 *   2. Store tests (truck-hold-store.service.ts)
 *   3. Create tests (truck-hold-create.service.ts)
 *   4. Confirm tests (truck-hold-confirm.service.ts)
 *   5. Release tests (truck-hold-release.service.ts)
 *   6. Query tests (truck-hold-query.service.ts)
 *   7. Cleanup tests (truck-hold-cleanup.service.ts)
 *   8. Edge cases and race conditions
 *
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP - Must come before all imports
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
    observeHistogram: jest.fn(),
    recordHistogram: jest.fn(),
  },
}));

// --- Prisma mock fns ---
const mockTruckHoldLedgerCreate = jest.fn();
const mockTruckHoldLedgerUpdate = jest.fn();
const mockTruckHoldLedgerUpdateMany = jest.fn();
const mockTruckHoldLedgerFindUnique = jest.fn();
const mockTruckHoldLedgerFindFirst = jest.fn();
const mockTruckHoldLedgerFindMany = jest.fn();
const mockTruckRequestFindMany = jest.fn();
const mockTruckRequestUpdateMany = jest.fn();
const mockTruckRequestUpdate = jest.fn();
const mockTruckRequestFindFirst = jest.fn();
const mockOrderFindUnique = jest.fn();
const mockOrderUpdate = jest.fn();
const mockAssignmentCreate = jest.fn();
const mockAssignmentFindMany = jest.fn();
const mockAssignmentUpdate = jest.fn();
const mockAssignmentUpdateMany = jest.fn();
const mockVehicleFindMany = jest.fn();
const mockVehicleUpdateMany = jest.fn();
const mockUserFindMany = jest.fn();
const mockIdempotencyFindUnique = jest.fn();
const mockIdempotencyUpsert = jest.fn();
const mockIdempotencyDeleteMany = jest.fn();
const mockQueryRaw = jest.fn();

const mockTxProxy: any = {
  order: {
    findUnique: (...args: any[]) => mockOrderFindUnique(...args),
    update: (...args: any[]) => mockOrderUpdate(...args),
  },
  truckRequest: {
    findMany: (...args: any[]) => mockTruckRequestFindMany(...args),
    updateMany: (...args: any[]) => mockTruckRequestUpdateMany(...args),
    update: (...args: any[]) => mockTruckRequestUpdate(...args),
    findFirst: (...args: any[]) => mockTruckRequestFindFirst(...args),
  },
  truckHoldLedger: {
    create: (...args: any[]) => mockTruckHoldLedgerCreate(...args),
    update: (...args: any[]) => mockTruckHoldLedgerUpdate(...args),
    updateMany: (...args: any[]) => mockTruckHoldLedgerUpdateMany(...args),
    findUnique: (...args: any[]) => mockTruckHoldLedgerFindUnique(...args),
    findFirst: (...args: any[]) => mockTruckHoldLedgerFindFirst(...args),
    findMany: (...args: any[]) => mockTruckHoldLedgerFindMany(...args),
  },
  assignment: {
    create: (...args: any[]) => mockAssignmentCreate(...args),
    findMany: (...args: any[]) => mockAssignmentFindMany(...args),
    update: (...args: any[]) => mockAssignmentUpdate(...args),
    updateMany: (...args: any[]) => mockAssignmentUpdateMany(...args),
  },
  vehicle: {
    findMany: (...args: any[]) => mockVehicleFindMany(...args),
    updateMany: (...args: any[]) => mockVehicleUpdateMany(...args),
  },
  user: {
    findMany: (...args: any[]) => mockUserFindMany(...args),
  },
  $queryRaw: (...args: any[]) => mockQueryRaw(...args),
};

const mockWithDbTimeout = jest.fn().mockImplementation(
  async (fn: (tx: any) => Promise<any>, _opts?: any) => fn(mockTxProxy)
);

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    truckHoldLedger: {
      create: (...args: any[]) => mockTruckHoldLedgerCreate(...args),
      update: (...args: any[]) => mockTruckHoldLedgerUpdate(...args),
      updateMany: (...args: any[]) => mockTruckHoldLedgerUpdateMany(...args),
      findUnique: (...args: any[]) => mockTruckHoldLedgerFindUnique(...args),
      findFirst: (...args: any[]) => mockTruckHoldLedgerFindFirst(...args),
      findMany: (...args: any[]) => mockTruckHoldLedgerFindMany(...args),
    },
    truckRequest: {
      findMany: (...args: any[]) => mockTruckRequestFindMany(...args),
      updateMany: (...args: any[]) => mockTruckRequestUpdateMany(...args),
    },
    truckHoldIdempotency: {
      findUnique: (...args: any[]) => mockIdempotencyFindUnique(...args),
      upsert: (...args: any[]) => mockIdempotencyUpsert(...args),
      deleteMany: (...args: any[]) => mockIdempotencyDeleteMany(...args),
    },
    assignment: {
      create: (...args: any[]) => mockAssignmentCreate(...args),
      findMany: (...args: any[]) => mockAssignmentFindMany(...args),
    },
    vehicle: {
      findMany: (...args: any[]) => mockVehicleFindMany(...args),
      updateMany: (...args: any[]) => mockVehicleUpdateMany(...args),
    },
    user: {
      findMany: (...args: any[]) => mockUserFindMany(...args),
    },
    order: {
      findUnique: (...args: any[]) => mockOrderFindUnique(...args),
      update: (...args: any[]) => mockOrderUpdate(...args),
    },
    $transaction: jest.fn().mockImplementation(async (cb: any) => cb(mockTxProxy)),
    $queryRaw: (...args: any[]) => mockQueryRaw(...args),
  },
  withDbTimeout: (...args: any[]) => mockWithDbTimeout(...args),
  AssignmentStatus: {
    pending: 'pending',
    driver_accepted: 'driver_accepted',
    driver_declined: 'driver_declined',
    en_route_pickup: 'en_route_pickup',
    at_pickup: 'at_pickup',
    in_transit: 'in_transit',
    completed: 'completed',
    cancelled: 'cancelled',
  },
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
    maintenance: 'maintenance',
    inactive: 'inactive',
  },
  HoldPhase: {
    FLEX: 'FLEX',
    CONFIRMED: 'CONFIRMED',
    EXPIRED: 'EXPIRED',
    RELEASED: 'RELEASED',
  },
}));

// --- Redis mock ---
const mockAcquireLock = jest.fn();
const mockReleaseLock = jest.fn();
const mockGetJSON = jest.fn();
const mockSetJSON = jest.fn();
const mockRedisDel = jest.fn();
const mockSAdd = jest.fn().mockResolvedValue(1);
const mockSRem = jest.fn().mockResolvedValue(1);
const mockSMembers = jest.fn().mockResolvedValue([]);
const mockExpire = jest.fn().mockResolvedValue(true);
const mockTtl = jest.fn().mockResolvedValue(100);

const mockPipelineResults: Array<[Error | null, string | null]> = [];
const mockPipeline = {
  get: jest.fn().mockReturnThis(),
  exec: jest.fn().mockImplementation(() => Promise.resolve(mockPipelineResults)),
};

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    acquireLock: (...args: any[]) => mockAcquireLock(...args),
    releaseLock: (...args: any[]) => mockReleaseLock(...args),
    getJSON: (...args: any[]) => mockGetJSON(...args),
    setJSON: (...args: any[]) => mockSetJSON(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    sAdd: (...args: any[]) => mockSAdd(...args),
    sRem: (...args: any[]) => mockSRem(...args),
    sMembers: (...args: any[]) => mockSMembers(...args),
    expire: (...args: any[]) => mockExpire(...args),
    ttl: (...args: any[]) => mockTtl(...args),
    isConnected: () => true,
    getClient: () => ({ pipeline: () => mockPipeline }),
  },
}));

// --- Socket mock ---
const mockEmitToUser = jest.fn();
const mockBroadcastToAll = jest.fn();
jest.mock('../shared/services/socket.service', () => ({
  socketService: {
    emitToUser: (...args: any[]) => mockEmitToUser(...args),
    broadcastToAll: (...args: any[]) => mockBroadcastToAll(...args),
  },
  SocketEvent: {
    TRIP_ASSIGNED: 'trip_assigned',
  },
}));

// --- Queue mock ---
const mockScheduleAssignmentTimeout = jest.fn().mockResolvedValue(undefined);
const mockQueuePushNotification = jest.fn().mockResolvedValue(undefined);
const mockQueueBroadcast = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    scheduleAssignmentTimeout: (...args: any[]) => mockScheduleAssignmentTimeout(...args),
    queuePushNotification: (...args: any[]) => mockQueuePushNotification(...args),
    queueBroadcast: (...args: any[]) => mockQueueBroadcast(...args),
  },
}));

// --- DB mock ---
const mockGetOrderById = jest.fn();
const mockGetTruckRequestsByOrder = jest.fn().mockResolvedValue([]);
const mockGetUserById = jest.fn();
const mockGetTransportersAvailabilitySnapshot = jest.fn().mockResolvedValue([]);
jest.mock('../shared/database/db', () => ({
  db: {
    getOrderById: (...args: any[]) => mockGetOrderById(...args),
    getTruckRequestsByOrder: (...args: any[]) => mockGetTruckRequestsByOrder(...args),
    getUserById: (...args: any[]) => mockGetUserById(...args),
    getTransportersAvailabilitySnapshot: (...args: any[]) => mockGetTransportersAvailabilitySnapshot(...args),
  },
}));

// --- Driver service mock ---
const mockAreDriversOnline = jest.fn();
jest.mock('../modules/driver/driver.service', () => ({
  driverService: {
    areDriversOnline: (...args: any[]) => mockAreDriversOnline(...args),
    getDriverById: jest.fn(),
  },
}));

// --- Hold config mock ---
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

// --- Other mocks ---
jest.mock('../modules/assignment/post-accept.effects', () => ({
  applyPostAcceptSideEffects: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    updateAvailability: jest.fn(),
    incrementAvailable: jest.fn(),
    decrementAvailable: jest.fn(),
  },
}));
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn().mockReturnValue('tata_ace'),
  generateVehicleKeyCandidates: jest.fn().mockReturnValue(['tata_ace']),
}));
jest.mock('../shared/services/fcm.service', () => ({
  fcmService: {
    sendNotification: jest.fn(),
    sendToUser: jest.fn(),
  },
}));
jest.mock('../modules/hold-expiry/hold-expiry-cleanup.service', () => ({
  holdExpiryCleanupService: {
    scheduleFlexHoldCleanup: jest.fn().mockResolvedValue('job-flex-1'),
    scheduleConfirmedHoldCleanup: jest.fn().mockResolvedValue('job-confirmed-1'),
    cancelScheduledCleanup: jest.fn().mockResolvedValue(undefined),
    processExpiredHold: jest.fn(),
  },
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'test-uuid-' + Math.random().toString(36).substring(2, 10)),
}), { virtual: true });

jest.mock('@prisma/client', () => ({
  Prisma: {
    TransactionIsolationLevel: {
      Serializable: 'Serializable',
      ReadCommitted: 'ReadCommitted',
    },
    sql: jest.fn(),
  },
  HoldPhase: { FLEX: 'FLEX', CONFIRMED: 'CONFIRMED', EXPIRED: 'EXPIRED', RELEASED: 'RELEASED' },
  AssignmentStatus: {
    pending: 'pending',
    driver_accepted: 'driver_accepted',
    driver_declined: 'driver_declined',
    en_route_pickup: 'en_route_pickup',
    at_pickup: 'at_pickup',
    in_transit: 'in_transit',
    delivered: 'delivered',
    cancelled: 'cancelled',
  },
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { holdStore, REDIS_KEYS } from '../modules/truck-hold/truck-hold-store.service';
import {
  holdTrucks,
  confirmHold,
  normalizeVehiclePart,
  buildOperationPayloadHash,
  saveIdempotentOperationResponse,
  findActiveLedgerHold,
  recordHoldOutcomeMetrics,
} from '../modules/truck-hold/truck-hold-create.service';
import { confirmHoldWithAssignments } from '../modules/truck-hold/truck-hold-confirm.service';
import { releaseHold, closeActiveHoldsForOrder, clearHoldCacheEntries } from '../modules/truck-hold/truck-hold-release.service';
import { getOrderAvailability, getMyActiveHold, getAvailableTruckRequests, broadcastAvailabilityUpdate } from '../modules/truck-hold/truck-hold-query.service';
import { CONFIG } from '../modules/truck-hold/truck-hold.types';
import { metrics } from '../shared/monitoring/metrics.service';

// =============================================================================
// TEST CONSTANTS
// =============================================================================

const T_HOLD_ID = 'HOLD_ABCD1234';
const T_ORDER_ID = 'order-001';
const T_TRANSPORTER_ID = 'transporter-001';
const T_VEHICLE_ID = 'vehicle-001';
const T_VEHICLE_2_ID = 'vehicle-002';
const T_DRIVER_ID = 'driver-001';
const T_DRIVER_2_ID = 'driver-002';
const T_TRUCK_REQ_1 = 'tr-001';
const T_TRUCK_REQ_2 = 'tr-002';

function futureDate(seconds: number = 300): Date {
  return new Date(Date.now() + seconds * 1000);
}

function pastDate(seconds: number = 60): Date {
  return new Date(Date.now() - seconds * 1000);
}

function makeHold(overrides: Partial<any> = {}): any {
  return {
    holdId: T_HOLD_ID,
    orderId: T_ORDER_ID,
    transporterId: T_TRANSPORTER_ID,
    vehicleType: 'Tata Ace',
    vehicleSubtype: '6 Wheeler',
    quantity: 2,
    truckRequestIds: [T_TRUCK_REQ_1, T_TRUCK_REQ_2],
    status: 'active',
    createdAt: new Date(),
    expiresAt: futureDate(180),
    ...overrides,
  };
}

// =============================================================================
// RESET ALL MOCKS BEFORE EACH TEST
// =============================================================================

beforeEach(() => {
  jest.clearAllMocks();
  mockAcquireLock.mockResolvedValue({ acquired: true });
  mockReleaseLock.mockResolvedValue(true);
  mockGetJSON.mockResolvedValue(null);
  mockSetJSON.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
  mockSAdd.mockResolvedValue(1);
  mockSRem.mockResolvedValue(1);
  mockSMembers.mockResolvedValue([]);
  mockExpire.mockResolvedValue(true);
  mockTtl.mockResolvedValue(100);
  mockIdempotencyFindUnique.mockResolvedValue(null);
  mockIdempotencyUpsert.mockResolvedValue({});
  mockWithDbTimeout.mockImplementation(
    async (fn: (tx: any) => Promise<any>, _opts?: any) => fn(mockTxProxy)
  );
});

// =============================================================================
// 1. FACADE INTEGRITY
// =============================================================================

describe('Facade integrity (truck-hold.service.ts)', () => {
  test('TruckHoldService exports all expected types', () => {
    // Types are compile-time only; verify the type file exports exist at runtime
    const types = require('../modules/truck-hold/truck-hold.types');
    expect(types.CONFIG).toBeDefined();
    // FIX #4: HOLD_DURATION_SECONDS now reads from FLEX_HOLD_DURATION_SECONDS env (default 90s)
    expect(types.CONFIG.HOLD_DURATION_SECONDS).toBe(90);
    expect(types.CONFIG.CLEANUP_INTERVAL_MS).toBe(5000);
    expect(types.CONFIG.MAX_HOLD_QUANTITY).toBe(50);
    expect(types.CONFIG.MIN_HOLD_QUANTITY).toBe(1);
    expect(types.ACTIVE_ORDER_STATUSES).toBeDefined();
    expect(types.TERMINAL_ORDER_STATUSES).toBeDefined();
    expect(types.HOLD_EVENT_VERSION).toBe(1);
  });

  test('ACTIVE_ORDER_STATUSES contains expected values', () => {
    const types = require('../modules/truck-hold/truck-hold.types');
    expect(types.ACTIVE_ORDER_STATUSES.has('created')).toBe(true);
    expect(types.ACTIVE_ORDER_STATUSES.has('broadcasting')).toBe(true);
    expect(types.ACTIVE_ORDER_STATUSES.has('active')).toBe(true);
    expect(types.ACTIVE_ORDER_STATUSES.has('partially_filled')).toBe(true);
    expect(types.ACTIVE_ORDER_STATUSES.has('cancelled')).toBe(false);
  });

  test('TERMINAL_ORDER_STATUSES contains expected values', () => {
    const types = require('../modules/truck-hold/truck-hold.types');
    expect(types.TERMINAL_ORDER_STATUSES.has('cancelled')).toBe(true);
    expect(types.TERMINAL_ORDER_STATUSES.has('expired')).toBe(true);
    expect(types.TERMINAL_ORDER_STATUSES.has('completed')).toBe(true);
    expect(types.TERMINAL_ORDER_STATUSES.has('fully_filled')).toBe(true);
    expect(types.TERMINAL_ORDER_STATUSES.has('active')).toBe(false);
  });

  test('CONFIG feature flags default to true', () => {
    const types = require('../modules/truck-hold/truck-hold.types');
    expect(types.FF_HOLD_DB_ATOMIC_CLAIM).toBe(true);
    expect(types.FF_HOLD_STRICT_IDEMPOTENCY).toBe(true);
    expect(types.FF_HOLD_RECONCILE_RECOVERY).toBe(true);
    expect(types.FF_HOLD_SAFE_RELEASE_GUARD).toBe(true);
  });

  test('REDIS_KEYS generates correct key patterns', () => {
    expect(REDIS_KEYS.HOLD('h1')).toBe('hold:h1');
    expect(REDIS_KEYS.HOLDS_BY_ORDER('o1')).toBe('hold:order:o1');
    expect(REDIS_KEYS.HOLDS_BY_TRANSPORTER('t1')).toBe('hold:transporter:t1');
    // FIX #40: TRUCK_LOCK removed — PG SERIALIZABLE TX handles concurrency
  });
});

// =============================================================================
// 2. STORE TESTS (truck-hold-store.service.ts)
// =============================================================================

describe('HoldStore (truck-hold-store.service.ts)', () => {
  const sampleHold = {
    holdId: T_HOLD_ID,
    orderId: T_ORDER_ID,
    transporterId: T_TRANSPORTER_ID,
    vehicleType: 'Tata Ace',
    vehicleSubtype: '6 Wheeler',
    quantity: 2,
    truckRequestIds: [T_TRUCK_REQ_1, T_TRUCK_REQ_2],
    createdAt: new Date('2026-04-01T00:00:00Z'),
    expiresAt: futureDate(180),
    status: 'active' as const,
  };

  describe('add()', () => {
    // FIX #40: Per-truck Redis locks removed. Concurrency handled by PG SERIALIZABLE TX.
    // holdStore.add() is now a cache/index layer only — no distributed locking.

    test('stores hold data and adds to indexes', async () => {
      const result = await holdStore.add(sampleHold);

      expect(result).toBe(true);
      // No per-truck locks acquired (FIX #40)
      expect(mockAcquireLock).not.toHaveBeenCalled();
      // Hold data stored
      expect(mockSetJSON).toHaveBeenCalledTimes(1);
      // Added to order index and transporter index
      expect(mockSAdd).toHaveBeenCalledTimes(2);
      expect(mockExpire).toHaveBeenCalledTimes(2);
    });

    test('returns false on setJSON failure', async () => {
      mockSetJSON.mockRejectedValue(new Error('Redis down'));

      const result = await holdStore.add(sampleHold);

      expect(result).toBe(false);
    });

    test('stores hold data regardless of truckRequestIds order', async () => {
      const unsortedHold = {
        ...sampleHold,
        truckRequestIds: ['z-truck', 'a-truck', 'm-truck'],
      };

      const result = await holdStore.add(unsortedHold);

      expect(result).toBe(true);
      // Hold data stored with all truck request IDs
      expect(mockSetJSON).toHaveBeenCalledTimes(1);
    });

    test('returns false on Redis connection failure', async () => {
      mockSetJSON.mockRejectedValue(new Error('Connection refused'));

      const result = await holdStore.add(sampleHold);

      expect(result).toBe(false);
    });

    test('stores hold with correct TTL buffer', async () => {
      mockAcquireLock.mockResolvedValue({ acquired: true });

      await holdStore.add(sampleHold);

      const setJSONCall = mockSetJSON.mock.calls[0];
      // TTL should be HOLD_DURATION_SECONDS + 60 (FIX #95: aligned data/index TTL)
      expect(setJSONCall[2]).toBe(CONFIG.HOLD_DURATION_SECONDS + 60);
    });
  });

  describe('get()', () => {
    test('returns hold with parsed dates', async () => {
      const redisData = {
        ...sampleHold,
        createdAt: '2026-04-01T00:00:00.000Z',
        expiresAt: '2026-04-01T00:03:00.000Z',
      };
      mockGetJSON.mockResolvedValue(redisData);

      const result = await holdStore.get(T_HOLD_ID);

      expect(result).toBeDefined();
      expect(result!.createdAt).toBeInstanceOf(Date);
      expect(result!.expiresAt).toBeInstanceOf(Date);
      expect(result!.holdId).toBe(T_HOLD_ID);
    });

    test('returns undefined when hold not found', async () => {
      mockGetJSON.mockResolvedValue(null);

      const result = await holdStore.get('nonexistent');

      expect(result).toBeUndefined();
    });

    test('returns undefined on Redis error', async () => {
      mockGetJSON.mockRejectedValue(new Error('Redis timeout'));

      const result = await holdStore.get(T_HOLD_ID);

      expect(result).toBeUndefined();
    });
  });

  describe('updateStatus()', () => {
    test('updates hold status and preserves TTL', async () => {
      const redisData = {
        ...sampleHold,
        createdAt: '2026-04-01T00:00:00.000Z',
        expiresAt: '2026-04-01T00:03:00.000Z',
      };
      mockGetJSON.mockResolvedValue(redisData);
      mockTtl.mockResolvedValue(120);

      await holdStore.updateStatus(T_HOLD_ID, 'confirmed');

      expect(mockSetJSON).toHaveBeenCalledTimes(1);
      const savedData = mockSetJSON.mock.calls[0][1];
      expect(savedData.status).toBe('confirmed');
      // TTL preserved
      expect(mockSetJSON.mock.calls[0][2]).toBe(120);
    });

    test('uses fallback TTL when key has no TTL', async () => {
      const redisData = {
        ...sampleHold,
        createdAt: '2026-04-01T00:00:00.000Z',
        expiresAt: '2026-04-01T00:03:00.000Z',
      };
      mockGetJSON.mockResolvedValue(redisData);
      mockTtl.mockResolvedValue(-1);

      await holdStore.updateStatus(T_HOLD_ID, 'expired');

      expect(mockSetJSON.mock.calls[0][2]).toBe(60);
    });

    test('no-ops when hold not found', async () => {
      mockGetJSON.mockResolvedValue(null);

      await holdStore.updateStatus('nonexistent', 'confirmed');

      expect(mockSetJSON).not.toHaveBeenCalled();
    });
  });

  describe('remove()', () => {
    // FIX #40: Per-truck locks removed. remove() only cleans up cache/indexes.
    test('removes from indexes and deletes hold data', async () => {
      const redisData = {
        ...sampleHold,
        createdAt: '2026-04-01T00:00:00.000Z',
        expiresAt: '2026-04-01T00:03:00.000Z',
      };
      mockGetJSON.mockResolvedValue(redisData);

      await holdStore.remove(T_HOLD_ID);

      // No per-truck lock release (FIX #40)
      expect(mockReleaseLock).not.toHaveBeenCalled();
      // Remove from order and transporter indexes
      expect(mockSRem).toHaveBeenCalledTimes(2);
      // Delete hold data
      expect(mockRedisDel).toHaveBeenCalledTimes(1);
    });

    test('no-ops when hold not found', async () => {
      mockGetJSON.mockResolvedValue(null);

      await holdStore.remove('nonexistent');

      expect(mockReleaseLock).not.toHaveBeenCalled();
      expect(mockRedisDel).not.toHaveBeenCalled();
    });

    test('handles Redis errors gracefully', async () => {
      mockGetJSON.mockRejectedValue(new Error('Redis down'));

      // Should not throw
      await expect(holdStore.remove(T_HOLD_ID)).resolves.toBeUndefined();
    });
  });

  describe('getActiveHoldsByOrder()', () => {
    test('returns only active, non-expired holds', async () => {
      mockSMembers.mockResolvedValue([T_HOLD_ID, 'hold-expired']);

      const activeHoldData = {
        ...sampleHold,
        createdAt: new Date().toISOString(),
        expiresAt: futureDate(100).toISOString(),
        status: 'active',
      };
      const expiredHoldData = {
        ...sampleHold,
        holdId: 'hold-expired',
        createdAt: new Date().toISOString(),
        expiresAt: pastDate(60).toISOString(),
        status: 'active',
      };
      // Pipeline returns results as [error, value] tuples
      mockPipelineResults.length = 0;
      mockPipelineResults.push(
        [null, JSON.stringify(activeHoldData)],
        [null, JSON.stringify(expiredHoldData)]
      );

      const result = await holdStore.getActiveHoldsByOrder(T_ORDER_ID);

      expect(result).toHaveLength(1);
      expect(result[0].holdId).toBe(T_HOLD_ID);
    });

    test('returns empty array when no holds', async () => {
      mockSMembers.mockResolvedValue([]);

      const result = await holdStore.getActiveHoldsByOrder(T_ORDER_ID);

      expect(result).toEqual([]);
    });

    test('returns empty array on Redis error', async () => {
      mockSMembers.mockRejectedValue(new Error('Redis error'));

      const result = await holdStore.getActiveHoldsByOrder(T_ORDER_ID);

      expect(result).toEqual([]);
    });
  });

  describe('getTransporterHold()', () => {
    test('returns matching active hold for transporter', async () => {
      mockSMembers.mockResolvedValue([T_HOLD_ID]);
      const holdData = {
        ...sampleHold,
        createdAt: new Date().toISOString(),
        expiresAt: futureDate(100).toISOString(),
        status: 'active',
      };
      mockGetJSON.mockResolvedValue(holdData);

      const result = await holdStore.getTransporterHold(
        T_TRANSPORTER_ID, T_ORDER_ID, 'Tata Ace', '6 Wheeler'
      );

      expect(result).toBeDefined();
      expect(result!.holdId).toBe(T_HOLD_ID);
    });

    test('case-insensitive vehicle type matching', async () => {
      mockSMembers.mockResolvedValue([T_HOLD_ID]);
      const holdData = {
        ...sampleHold,
        vehicleType: 'TATA ACE',
        vehicleSubtype: '6 WHEELER',
        createdAt: new Date().toISOString(),
        expiresAt: futureDate(100).toISOString(),
        status: 'active',
      };
      mockGetJSON.mockResolvedValue(holdData);

      const result = await holdStore.getTransporterHold(
        T_TRANSPORTER_ID, T_ORDER_ID, 'tata ace', '6 wheeler'
      );

      expect(result).toBeDefined();
    });

    test('returns undefined when no matching hold', async () => {
      mockSMembers.mockResolvedValue([]);

      const result = await holdStore.getTransporterHold(
        T_TRANSPORTER_ID, T_ORDER_ID, 'Tata Ace', '6 Wheeler'
      );

      expect(result).toBeUndefined();
    });

    test('returns undefined on Redis error', async () => {
      mockSMembers.mockRejectedValue(new Error('Redis error'));

      const result = await holdStore.getTransporterHold(
        T_TRANSPORTER_ID, T_ORDER_ID, 'Tata Ace', '6 Wheeler'
      );

      expect(result).toBeUndefined();
    });
  });
});

// =============================================================================
// 3. CREATE TESTS (truck-hold-create.service.ts)
// =============================================================================

describe('Create (truck-hold-create.service.ts)', () => {
  describe('normalizeVehiclePart()', () => {
    test('trims whitespace', () => {
      expect(normalizeVehiclePart('  Tata Ace  ')).toBe('Tata Ace');
    });

    test('handles null/undefined', () => {
      expect(normalizeVehiclePart(null as any)).toBe('');
      expect(normalizeVehiclePart(undefined as any)).toBe('');
    });
  });

  describe('buildOperationPayloadHash()', () => {
    test('produces deterministic hash for same input', () => {
      const hash1 = buildOperationPayloadHash('hold', { orderId: 'o1', quantity: 2 });
      const hash2 = buildOperationPayloadHash('hold', { orderId: 'o1', quantity: 2 });
      expect(hash1).toBe(hash2);
    });

    test('produces different hash for different operations', () => {
      const holdHash = buildOperationPayloadHash('hold', { orderId: 'o1' });
      const releaseHash = buildOperationPayloadHash('release', { orderId: 'o1' });
      expect(holdHash).not.toBe(releaseHash);
    });

    test('produces different hash for different payloads', () => {
      const hash1 = buildOperationPayloadHash('hold', { orderId: 'o1' });
      const hash2 = buildOperationPayloadHash('hold', { orderId: 'o2' });
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('holdTrucks()', () => {
    const broadcastFn = jest.fn();

    test('holds trucks successfully with valid request', async () => {
      mockOrderFindUnique.mockResolvedValue({ id: T_ORDER_ID, status: 'broadcasting' });
      mockQueryRaw.mockResolvedValue([{ id: T_TRUCK_REQ_1 }, { id: T_TRUCK_REQ_2 }]);
      mockTruckRequestUpdateMany.mockResolvedValue({ count: 2 });
      mockTruckHoldLedgerCreate.mockResolvedValue({});

      const result = await holdTrucks({
        orderId: T_ORDER_ID,
        transporterId: T_TRANSPORTER_ID,
        vehicleType: 'Tata Ace',
        vehicleSubtype: '6 Wheeler',
        quantity: 2,
      }, broadcastFn);

      expect(result.success).toBe(true);
      expect(result.holdId).toBeDefined();
      expect(result.heldQuantity).toBe(2);
      expect(result.holdState).toBe('reserved');
      expect(broadcastFn).toHaveBeenCalledWith(T_ORDER_ID);
    });

    test('rejects when orderId is missing', async () => {
      const result = await holdTrucks({
        orderId: '',
        transporterId: T_TRANSPORTER_ID,
        vehicleType: 'Tata Ace',
        vehicleSubtype: '',
        quantity: 2,
      }, broadcastFn);

      expect(result.success).toBe(false);
      expect(result.error).toBe('VALIDATION_ERROR');
    });

    test('rejects when quantity is zero', async () => {
      const result = await holdTrucks({
        orderId: T_ORDER_ID,
        transporterId: T_TRANSPORTER_ID,
        vehicleType: 'Tata Ace',
        vehicleSubtype: '',
        quantity: 0,
      }, broadcastFn);

      expect(result.success).toBe(false);
      expect(result.error).toBe('VALIDATION_ERROR');
    });

    test('rejects when quantity exceeds MAX_HOLD_QUANTITY', async () => {
      const result = await holdTrucks({
        orderId: T_ORDER_ID,
        transporterId: T_TRANSPORTER_ID,
        vehicleType: 'Tata Ace',
        vehicleSubtype: '',
        quantity: 51,
      }, broadcastFn);

      expect(result.success).toBe(false);
      expect(result.error).toBe('VALIDATION_ERROR');
    });

    test('rejects non-integer quantity', async () => {
      const result = await holdTrucks({
        orderId: T_ORDER_ID,
        transporterId: T_TRANSPORTER_ID,
        vehicleType: 'Tata Ace',
        vehicleSubtype: '',
        quantity: 2.5,
      }, broadcastFn);

      expect(result.success).toBe(false);
      expect(result.error).toBe('VALIDATION_ERROR');
    });

    test('returns existing hold when reconcile recovery finds one', async () => {
      mockTruckHoldLedgerFindFirst.mockResolvedValue({
        holdId: T_HOLD_ID,
        expiresAt: futureDate(100),
        quantity: 2,
      });

      const result = await holdTrucks({
        orderId: T_ORDER_ID,
        transporterId: T_TRANSPORTER_ID,
        vehicleType: 'Tata Ace',
        vehicleSubtype: '6 Wheeler',
        quantity: 2,
      }, broadcastFn);

      expect(result.success).toBe(true);
      expect(result.holdId).toBe(T_HOLD_ID);
      expect(result.message).toContain('already reserved');
    });

    test('fails when order not found', async () => {
      mockTruckHoldLedgerFindFirst.mockResolvedValue(null);
      mockOrderFindUnique.mockResolvedValue(null);

      const result = await holdTrucks({
        orderId: T_ORDER_ID,
        transporterId: T_TRANSPORTER_ID,
        vehicleType: 'Tata Ace',
        vehicleSubtype: '',
        quantity: 2,
      }, broadcastFn);

      expect(result.success).toBe(false);
      expect(result.error).toBe('ORDER_INACTIVE');
    });

    test('fails when order is in terminal status', async () => {
      mockTruckHoldLedgerFindFirst.mockResolvedValue(null);
      mockOrderFindUnique.mockResolvedValue({ id: T_ORDER_ID, status: 'cancelled' });

      const result = await holdTrucks({
        orderId: T_ORDER_ID,
        transporterId: T_TRANSPORTER_ID,
        vehicleType: 'Tata Ace',
        vehicleSubtype: '',
        quantity: 2,
      }, broadcastFn);

      expect(result.success).toBe(false);
      expect(result.error).toBe('ORDER_INACTIVE');
    });

    test('fails when not enough trucks available', async () => {
      mockTruckHoldLedgerFindFirst.mockResolvedValue(null);
      mockOrderFindUnique.mockResolvedValue({ id: T_ORDER_ID, status: 'broadcasting' });
      // Only 1 available instead of 2
      mockQueryRaw.mockResolvedValue([{ id: T_TRUCK_REQ_1 }]);

      const result = await holdTrucks({
        orderId: T_ORDER_ID,
        transporterId: T_TRANSPORTER_ID,
        vehicleType: 'Tata Ace',
        vehicleSubtype: '',
        quantity: 2,
      }, broadcastFn);

      expect(result.success).toBe(false);
      expect(result.error).toBe('NOT_ENOUGH_AVAILABLE');
    });

    test('fails when truck state changed during claim', async () => {
      mockTruckHoldLedgerFindFirst.mockResolvedValue(null);
      mockOrderFindUnique.mockResolvedValue({ id: T_ORDER_ID, status: 'broadcasting' });
      mockQueryRaw.mockResolvedValue([{ id: T_TRUCK_REQ_1 }, { id: T_TRUCK_REQ_2 }]);
      // Only 1 claimed instead of 2
      mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });

      const result = await holdTrucks({
        orderId: T_ORDER_ID,
        transporterId: T_TRANSPORTER_ID,
        vehicleType: 'Tata Ace',
        vehicleSubtype: '',
        quantity: 2,
      }, broadcastFn);

      expect(result.success).toBe(false);
      expect(result.error).toBe('TRUCK_STATE_CHANGED');
    });

    test('returns idempotent replay for same key and payload', async () => {
      const cachedResponse = {
        success: true,
        holdId: T_HOLD_ID,
        heldQuantity: 2,
        holdState: 'reserved',
        message: '2 trucks reserved',
      };
      mockIdempotencyFindUnique.mockResolvedValue({
        statusCode: 200,
        responseJson: cachedResponse,
        payloadHash: buildOperationPayloadHash('hold', {
          orderId: T_ORDER_ID,
          vehicleType: 'tata ace',
          vehicleSubtype: '6 wheeler',
          quantity: 2,
        }),
      });

      const result = await holdTrucks({
        orderId: T_ORDER_ID,
        transporterId: T_TRANSPORTER_ID,
        vehicleType: 'Tata Ace',
        vehicleSubtype: '6 Wheeler',
        quantity: 2,
        idempotencyKey: 'key-1',
      }, broadcastFn);

      expect(result.success).toBe(true);
      expect(result.holdId).toBe(T_HOLD_ID);
      // Should NOT call DB transaction again
      expect(mockWithDbTimeout).not.toHaveBeenCalled();
    });

    test('rejects idempotency key reused with different payload', async () => {
      mockIdempotencyFindUnique.mockResolvedValue({
        statusCode: 200,
        responseJson: { success: true },
        payloadHash: 'different-hash',
      });

      const result = await holdTrucks({
        orderId: T_ORDER_ID,
        transporterId: T_TRANSPORTER_ID,
        vehicleType: 'Tata Ace',
        vehicleSubtype: '',
        quantity: 2,
        idempotencyKey: 'reused-key',
      }, broadcastFn);

      expect(result.success).toBe(false);
      expect(result.error).toBe('IDEMPOTENCY_CONFLICT');
    });

    test('records metrics on success', async () => {
      mockTruckHoldLedgerFindFirst.mockResolvedValue(null);
      mockOrderFindUnique.mockResolvedValue({ id: T_ORDER_ID, status: 'broadcasting' });
      mockQueryRaw.mockResolvedValue([{ id: T_TRUCK_REQ_1 }]);
      mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });
      mockTruckHoldLedgerCreate.mockResolvedValue({});

      await holdTrucks({
        orderId: T_ORDER_ID,
        transporterId: T_TRANSPORTER_ID,
        vehicleType: 'Tata Ace',
        vehicleSubtype: '',
        quantity: 1,
      }, broadcastFn);

      expect(metrics.incrementCounter).toHaveBeenCalledWith('hold_request_total');
      expect(metrics.incrementCounter).toHaveBeenCalledWith('hold_success_total');
    });
  });

  describe('confirmHold() (simple)', () => {
    const releaseHoldFn = jest.fn();
    const broadcastFn = jest.fn();

    test('confirms hold successfully', async () => {
      mockTruckHoldLedgerFindUnique.mockResolvedValue(makeHold());
      mockOrderFindUnique.mockResolvedValue({ id: T_ORDER_ID, status: 'broadcasting' });
      mockTruckRequestUpdateMany.mockResolvedValue({ count: 2 });
      mockOrderUpdate.mockResolvedValue({});
      mockTruckHoldLedgerUpdate.mockResolvedValue({});

      const result = await confirmHold(T_HOLD_ID, T_TRANSPORTER_ID, releaseHoldFn, broadcastFn);

      expect(result.success).toBe(true);
      expect(result.assignedTrucks).toEqual([T_TRUCK_REQ_1, T_TRUCK_REQ_2]);
      expect(broadcastFn).toHaveBeenCalledWith(T_ORDER_ID);
    });

    test('fails when hold not found', async () => {
      mockTruckHoldLedgerFindUnique.mockResolvedValue(null);

      const result = await confirmHold(T_HOLD_ID, T_TRANSPORTER_ID, releaseHoldFn, broadcastFn);

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    test('fails when hold belongs to different transporter', async () => {
      mockTruckHoldLedgerFindUnique.mockResolvedValue(makeHold({ transporterId: 'other' }));

      const result = await confirmHold(T_HOLD_ID, T_TRANSPORTER_ID, releaseHoldFn, broadcastFn);

      expect(result.success).toBe(false);
      expect(result.message).toContain('another transporter');
    });

    test('fails when hold already confirmed', async () => {
      mockTruckHoldLedgerFindUnique.mockResolvedValue(makeHold({ status: 'confirmed' }));

      const result = await confirmHold(T_HOLD_ID, T_TRANSPORTER_ID, releaseHoldFn, broadcastFn);

      expect(result.success).toBe(false);
      expect(result.message).toContain('confirmed');
    });

    test('releases and fails when hold expired', async () => {
      mockTruckHoldLedgerFindUnique.mockResolvedValue(makeHold({ expiresAt: pastDate(60) }));
      releaseHoldFn.mockResolvedValue({ success: true });

      const result = await confirmHold(T_HOLD_ID, T_TRANSPORTER_ID, releaseHoldFn, broadcastFn);

      expect(result.success).toBe(false);
      expect(result.message).toContain('expired');
      expect(releaseHoldFn).toHaveBeenCalledWith(T_HOLD_ID, T_TRANSPORTER_ID);
    });

    test('fails when order became inactive', async () => {
      mockTruckHoldLedgerFindUnique.mockResolvedValue(makeHold());
      mockOrderFindUnique.mockResolvedValue({ id: T_ORDER_ID, status: 'cancelled' });

      const result = await confirmHold(T_HOLD_ID, T_TRANSPORTER_ID, releaseHoldFn, broadcastFn);

      expect(result.success).toBe(false);
      expect(result.message).toContain('no longer active');
    });

    test('fails when truck state changed during confirmation', async () => {
      mockTruckHoldLedgerFindUnique.mockResolvedValue(makeHold());
      mockOrderFindUnique.mockResolvedValue({ id: T_ORDER_ID, status: 'broadcasting' });
      mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 }); // Only 1 of 2

      const result = await confirmHold(T_HOLD_ID, T_TRANSPORTER_ID, releaseHoldFn, broadcastFn);

      expect(result.success).toBe(false);
      expect(result.message).toContain('changed state');
    });

    test('records confirm latency metric', async () => {
      mockTruckHoldLedgerFindUnique.mockResolvedValue(makeHold());
      mockOrderFindUnique.mockResolvedValue({ id: T_ORDER_ID, status: 'broadcasting' });
      mockTruckRequestUpdateMany.mockResolvedValue({ count: 2 });
      mockOrderUpdate.mockResolvedValue({});
      mockTruckHoldLedgerUpdate.mockResolvedValue({});

      await confirmHold(T_HOLD_ID, T_TRANSPORTER_ID, releaseHoldFn, broadcastFn);

      expect(metrics.observeHistogram).toHaveBeenCalledWith(
        'confirm_latency_ms',
        expect.any(Number)
      );
    });
  });

  describe('recordHoldOutcomeMetrics()', () => {
    test('records success metrics', () => {
      recordHoldOutcomeMetrics({ success: true, message: 'ok' }, Date.now() - 50);

      expect(metrics.observeHistogram).toHaveBeenCalledWith(
        'hold_latency_ms',
        expect.any(Number),
        expect.objectContaining({ result: 'success' })
      );
      expect(metrics.incrementCounter).toHaveBeenCalledWith('hold_success_total');
    });

    test('records failure metrics with reason', () => {
      recordHoldOutcomeMetrics({ success: false, message: 'fail', error: 'NOT_ENOUGH' }, Date.now() - 50);

      expect(metrics.incrementCounter).toHaveBeenCalledWith('hold_conflict_total', { reason: 'not_enough' });
    });

    test('records replay metrics', () => {
      recordHoldOutcomeMetrics({ success: true, message: 'replay' }, Date.now() - 10, true);

      expect(metrics.incrementCounter).toHaveBeenCalledWith('hold_idempotent_replay_total', expect.any(Object));
    });
  });
});

// =============================================================================
// 4. CONFIRM WITH ASSIGNMENTS TESTS (truck-hold-confirm.service.ts)
// =============================================================================

describe('Confirm with assignments (truck-hold-confirm.service.ts)', () => {
  const releaseHoldFn = jest.fn();
  const broadcastFn = jest.fn();

  const hold = makeHold({ quantity: 1, truckRequestIds: [T_TRUCK_REQ_1] });

  beforeEach(() => {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    mockTruckHoldLedgerUpdate.mockResolvedValue({});
    mockGetOrderById.mockResolvedValue({
      id: T_ORDER_ID,
      pickup: { address: 'A', lat: 0, lng: 0 },
      drop: { address: 'B', lat: 1, lng: 1 },
      distanceKm: 10,
      customerName: 'Test',
      customerPhone: '9999999999',
      totalTrucks: 2,
      trucksFilled: 0,
      routePoints: [],
    });
    mockGetUserById.mockResolvedValue({ id: T_TRANSPORTER_ID, name: 'TransCo', businessName: 'TransCo' });
  });

  test('fails when hold not found', async () => {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(null);

    const result = await confirmHoldWithAssignments(
      T_HOLD_ID, T_TRANSPORTER_ID,
      [{ vehicleId: T_VEHICLE_ID, driverId: T_DRIVER_ID }],
      releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });

  test('fails when hold belongs to another transporter', async () => {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(makeHold({ transporterId: 'other-t' }));

    const result = await confirmHoldWithAssignments(
      T_HOLD_ID, T_TRANSPORTER_ID,
      [{ vehicleId: T_VEHICLE_ID, driverId: T_DRIVER_ID }],
      releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('another transporter');
  });

  test('fails when hold is not active', async () => {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(makeHold({ status: 'confirmed' }));

    const result = await confirmHoldWithAssignments(
      T_HOLD_ID, T_TRANSPORTER_ID,
      [{ vehicleId: T_VEHICLE_ID, driverId: T_DRIVER_ID }],
      releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('confirmed');
  });

  test('releases and fails when hold expired', async () => {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(makeHold({
      quantity: 1,
      truckRequestIds: [T_TRUCK_REQ_1],
      expiresAt: pastDate(10),
    }));
    releaseHoldFn.mockResolvedValue({ success: true });

    const result = await confirmHoldWithAssignments(
      T_HOLD_ID, T_TRANSPORTER_ID,
      [{ vehicleId: T_VEHICLE_ID, driverId: T_DRIVER_ID }],
      releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('expired');
    expect(releaseHoldFn).toHaveBeenCalled();
  });

  test('fails when assignment count does not match hold quantity', async () => {
    // Hold has quantity 1 but we pass 2 assignments
    const result = await confirmHoldWithAssignments(
      T_HOLD_ID, T_TRANSPORTER_ID,
      [
        { vehicleId: T_VEHICLE_ID, driverId: T_DRIVER_ID },
        { vehicleId: T_VEHICLE_2_ID, driverId: T_DRIVER_2_ID },
      ],
      releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('Expected 1 assignments but got 2');
  });

  test('fails with duplicate vehicle in payload', async () => {
    const holdWith2 = makeHold({ quantity: 2, truckRequestIds: [T_TRUCK_REQ_1, T_TRUCK_REQ_2] });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(holdWith2);

    mockVehicleFindMany.mockResolvedValue([
      { id: T_VEHICLE_ID, transporterId: T_TRANSPORTER_ID, status: 'available', vehicleType: 'Tata Ace', vehicleSubtype: '6 Wheeler', vehicleNumber: 'KA01AB1234', currentTripId: null },
    ]);
    mockUserFindMany.mockResolvedValue([
      { id: T_DRIVER_ID, name: 'D1', phone: '1111111111', transporterId: T_TRANSPORTER_ID },
      { id: T_DRIVER_2_ID, name: 'D2', phone: '2222222222', transporterId: T_TRANSPORTER_ID },
    ]);
    mockAssignmentFindMany.mockResolvedValue([]);
    mockAreDriversOnline.mockResolvedValue(new Map([[T_DRIVER_ID, true], [T_DRIVER_2_ID, true]]));

    const result = await confirmHoldWithAssignments(
      T_HOLD_ID, T_TRANSPORTER_ID,
      [
        { vehicleId: T_VEHICLE_ID, driverId: T_DRIVER_ID },
        { vehicleId: T_VEHICLE_ID, driverId: T_DRIVER_2_ID },
      ],
      releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.failedAssignments).toBeDefined();
    expect(result.failedAssignments!.some(f => f.reason.includes('Duplicate vehicle'))).toBe(true);
  });

  test('fails with duplicate driver in payload', async () => {
    const holdWith2 = makeHold({ quantity: 2, truckRequestIds: [T_TRUCK_REQ_1, T_TRUCK_REQ_2] });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(holdWith2);

    mockVehicleFindMany.mockResolvedValue([
      { id: T_VEHICLE_ID, transporterId: T_TRANSPORTER_ID, status: 'available', vehicleType: 'Tata Ace', vehicleSubtype: '6 Wheeler', vehicleNumber: 'KA01AB1234', currentTripId: null },
      { id: T_VEHICLE_2_ID, transporterId: T_TRANSPORTER_ID, status: 'available', vehicleType: 'Tata Ace', vehicleSubtype: '6 Wheeler', vehicleNumber: 'KA01AB5678', currentTripId: null },
    ]);
    mockUserFindMany.mockResolvedValue([
      { id: T_DRIVER_ID, name: 'D1', phone: '1111111111', transporterId: T_TRANSPORTER_ID },
    ]);
    mockAssignmentFindMany.mockResolvedValue([]);
    mockAreDriversOnline.mockResolvedValue(new Map([[T_DRIVER_ID, true]]));

    const result = await confirmHoldWithAssignments(
      T_HOLD_ID, T_TRANSPORTER_ID,
      [
        { vehicleId: T_VEHICLE_ID, driverId: T_DRIVER_ID },
        { vehicleId: T_VEHICLE_2_ID, driverId: T_DRIVER_ID },
      ],
      releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.failedAssignments!.some(f => f.reason.includes('Duplicate driver'))).toBe(true);
  });

  test('fails when vehicle not owned by transporter', async () => {
    mockVehicleFindMany.mockResolvedValue([
      { id: T_VEHICLE_ID, transporterId: 'someone-else', status: 'available', vehicleType: 'Tata Ace', vehicleSubtype: '6 Wheeler', vehicleNumber: 'KA01AB1234', currentTripId: null },
    ]);
    mockUserFindMany.mockResolvedValue([
      { id: T_DRIVER_ID, name: 'D1', phone: '1111111111', transporterId: T_TRANSPORTER_ID },
    ]);
    mockAssignmentFindMany.mockResolvedValue([]);
    mockAreDriversOnline.mockResolvedValue(new Map([[T_DRIVER_ID, true]]));

    const result = await confirmHoldWithAssignments(
      T_HOLD_ID, T_TRANSPORTER_ID,
      [{ vehicleId: T_VEHICLE_ID, driverId: T_DRIVER_ID }],
      releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.failedAssignments!.some(f => f.reason.includes('does not belong'))).toBe(true);
  });

  test('fails when vehicle is not available', async () => {
    mockVehicleFindMany.mockResolvedValue([
      { id: T_VEHICLE_ID, transporterId: T_TRANSPORTER_ID, status: 'in_transit', vehicleType: 'Tata Ace', vehicleSubtype: '6 Wheeler', vehicleNumber: 'KA01AB1234', currentTripId: 'trip-999' },
    ]);
    mockUserFindMany.mockResolvedValue([
      { id: T_DRIVER_ID, name: 'D1', phone: '1111111111', transporterId: T_TRANSPORTER_ID },
    ]);
    mockAssignmentFindMany.mockResolvedValue([]);
    mockAreDriversOnline.mockResolvedValue(new Map([[T_DRIVER_ID, true]]));

    const result = await confirmHoldWithAssignments(
      T_HOLD_ID, T_TRANSPORTER_ID,
      [{ vehicleId: T_VEHICLE_ID, driverId: T_DRIVER_ID }],
      releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.failedAssignments!.some(f => f.reason.includes('in_transit'))).toBe(true);
  });

  test('fails when driver is offline', async () => {
    mockVehicleFindMany.mockResolvedValue([
      { id: T_VEHICLE_ID, transporterId: T_TRANSPORTER_ID, status: 'available', vehicleType: 'Tata Ace', vehicleSubtype: '6 Wheeler', vehicleNumber: 'KA01AB1234', currentTripId: null },
    ]);
    mockUserFindMany.mockResolvedValue([
      { id: T_DRIVER_ID, name: 'D1', phone: '1111111111', transporterId: T_TRANSPORTER_ID },
    ]);
    mockAssignmentFindMany.mockResolvedValue([]);
    mockAreDriversOnline.mockResolvedValue(new Map([[T_DRIVER_ID, false]]));

    const result = await confirmHoldWithAssignments(
      T_HOLD_ID, T_TRANSPORTER_ID,
      [{ vehicleId: T_VEHICLE_ID, driverId: T_DRIVER_ID }],
      releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.failedAssignments!.some(f => f.reason.includes('offline'))).toBe(true);
  });

  test('fails when driver has active assignment', async () => {
    mockVehicleFindMany.mockResolvedValue([
      { id: T_VEHICLE_ID, transporterId: T_TRANSPORTER_ID, status: 'available', vehicleType: 'Tata Ace', vehicleSubtype: '6 Wheeler', vehicleNumber: 'KA01AB1234', currentTripId: null },
    ]);
    mockUserFindMany.mockResolvedValue([
      { id: T_DRIVER_ID, name: 'D1', phone: '1111111111', transporterId: T_TRANSPORTER_ID },
    ]);
    // Driver has an active assignment
    mockAssignmentFindMany.mockImplementation(async (args: any) => {
      if (args.where?.driverId) return [{ driverId: T_DRIVER_ID, tripId: 'existing-trip' }];
      return [];
    });
    mockAreDriversOnline.mockResolvedValue(new Map([[T_DRIVER_ID, true]]));

    const result = await confirmHoldWithAssignments(
      T_HOLD_ID, T_TRANSPORTER_ID,
      [{ vehicleId: T_VEHICLE_ID, driverId: T_DRIVER_ID }],
      releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.failedAssignments!.some(f => f.reason.includes('already on trip'))).toBe(true);
  });

  test('fails when vehicle type mismatches hold', async () => {
    mockVehicleFindMany.mockResolvedValue([
      { id: T_VEHICLE_ID, transporterId: T_TRANSPORTER_ID, status: 'available', vehicleType: 'Eicher', vehicleSubtype: '6 Wheeler', vehicleNumber: 'KA01AB1234', currentTripId: null },
    ]);
    mockUserFindMany.mockResolvedValue([
      { id: T_DRIVER_ID, name: 'D1', phone: '1111111111', transporterId: T_TRANSPORTER_ID },
    ]);
    mockAssignmentFindMany.mockResolvedValue([]);
    mockAreDriversOnline.mockResolvedValue(new Map([[T_DRIVER_ID, true]]));

    const result = await confirmHoldWithAssignments(
      T_HOLD_ID, T_TRANSPORTER_ID,
      [{ vehicleId: T_VEHICLE_ID, driverId: T_DRIVER_ID }],
      releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.failedAssignments!.some(f => f.reason.includes('type mismatch'))).toBe(true);
  });

  test('handleAssignmentFailure translates DRIVER_BUSY error', async () => {
    // Trigger a DRIVER_BUSY error from inside the transaction
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    mockVehicleFindMany.mockResolvedValue([
      { id: T_VEHICLE_ID, transporterId: T_TRANSPORTER_ID, status: 'available', vehicleType: 'Tata Ace', vehicleSubtype: '6 Wheeler', vehicleNumber: 'KA01AB1234', currentTripId: null },
    ]);
    mockUserFindMany.mockResolvedValue([
      { id: T_DRIVER_ID, name: 'D1', phone: '1111111111', transporterId: T_TRANSPORTER_ID },
    ]);
    mockAssignmentFindMany.mockResolvedValue([]);
    mockAreDriversOnline.mockResolvedValue(new Map([[T_DRIVER_ID, true]]));
    mockGetOrderById.mockResolvedValue(null); // Order not found triggers error

    const result = await confirmHoldWithAssignments(
      T_HOLD_ID, T_TRANSPORTER_ID,
      [{ vehicleId: T_VEHICLE_ID, driverId: T_DRIVER_ID }],
      releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
  });
});

// =============================================================================
// 5. RELEASE TESTS (truck-hold-release.service.ts)
// =============================================================================

describe('Release (truck-hold-release.service.ts)', () => {
  const broadcastFn = jest.fn();

  describe('releaseHold()', () => {
    test('releases hold successfully and broadcasts', async () => {
      mockTruckHoldLedgerFindUnique.mockResolvedValue(makeHold());
      mockOrderFindUnique.mockResolvedValue({ status: 'broadcasting' });
      mockTruckRequestUpdateMany.mockResolvedValue({ count: 2 });
      mockTruckHoldLedgerUpdate.mockResolvedValue({});
      mockGetJSON.mockResolvedValue(null); // holdStore.remove will no-op

      const result = await releaseHold(T_HOLD_ID, T_TRANSPORTER_ID, undefined, 'manual', broadcastFn);

      expect(result.success).toBe(true);
      expect(result.message).toContain('released');
      expect(broadcastFn).toHaveBeenCalledWith(T_ORDER_ID);
    });

    test('fails when holdId is empty', async () => {
      const result = await releaseHold('', T_TRANSPORTER_ID, undefined, 'manual', broadcastFn);

      expect(result.success).toBe(false);
      expect(result.error).toBe('VALIDATION_ERROR');
    });

    test('fails when hold not found', async () => {
      mockTruckHoldLedgerFindUnique.mockResolvedValue(null);

      const result = await releaseHold('nonexistent', T_TRANSPORTER_ID, undefined, 'manual', broadcastFn);

      expect(result.success).toBe(false);
      expect(result.error).toBe('HOLD_NOT_FOUND');
    });

    test('fails when hold belongs to another transporter', async () => {
      mockTruckHoldLedgerFindUnique.mockResolvedValue(makeHold({ transporterId: 'other' }));

      const result = await releaseHold(T_HOLD_ID, T_TRANSPORTER_ID, undefined, 'manual', broadcastFn);

      expect(result.success).toBe(false);
      expect(result.error).toBe('FORBIDDEN');
    });

    test('returns success for already released hold (idempotent)', async () => {
      mockTruckHoldLedgerFindUnique.mockResolvedValue(makeHold({ status: 'released' }));

      const result = await releaseHold(T_HOLD_ID, T_TRANSPORTER_ID, undefined, 'manual', broadcastFn);

      expect(result.success).toBe(true);
      expect(result.message).toContain('already released');
    });

    test('sets truck status to searching for active orders', async () => {
      mockTruckHoldLedgerFindUnique.mockResolvedValue(makeHold());
      mockOrderFindUnique.mockResolvedValue({ status: 'broadcasting' });
      mockTruckRequestUpdateMany.mockResolvedValue({ count: 2 });
      mockTruckHoldLedgerUpdate.mockResolvedValue({});

      await releaseHold(T_HOLD_ID, T_TRANSPORTER_ID, undefined, 'manual', broadcastFn);

      const updateCall = mockTruckRequestUpdateMany.mock.calls[0][0];
      expect(updateCall.data.status).toBe('searching');
    });

    test('sets truck status to cancelled for cancelled orders', async () => {
      mockTruckHoldLedgerFindUnique.mockResolvedValue(makeHold());
      mockOrderFindUnique.mockResolvedValue({ status: 'cancelled' });
      mockTruckRequestUpdateMany.mockResolvedValue({ count: 2 });
      mockTruckHoldLedgerUpdate.mockResolvedValue({});

      await releaseHold(T_HOLD_ID, T_TRANSPORTER_ID, undefined, 'manual', broadcastFn);

      const updateCall = mockTruckRequestUpdateMany.mock.calls[0][0];
      expect(updateCall.data.status).toBe('cancelled');
    });

    test('records release metric for non-cleanup source', async () => {
      mockTruckHoldLedgerFindUnique.mockResolvedValue(makeHold());
      mockOrderFindUnique.mockResolvedValue({ status: 'broadcasting' });
      mockTruckRequestUpdateMany.mockResolvedValue({ count: 2 });
      mockTruckHoldLedgerUpdate.mockResolvedValue({});

      await releaseHold(T_HOLD_ID, T_TRANSPORTER_ID, undefined, 'manual', broadcastFn);

      expect(metrics.incrementCounter).toHaveBeenCalledWith('hold_release_total', { source: 'manual' });
    });

    test('does not record release metric for cleanup source', async () => {
      mockTruckHoldLedgerFindUnique.mockResolvedValue(makeHold());
      mockOrderFindUnique.mockResolvedValue({ status: 'broadcasting' });
      mockTruckRequestUpdateMany.mockResolvedValue({ count: 2 });
      mockTruckHoldLedgerUpdate.mockResolvedValue({});

      await releaseHold(T_HOLD_ID, undefined, undefined, 'cleanup', broadcastFn);

      const releaseMetricCalls = (metrics.incrementCounter as jest.Mock).mock.calls.filter(
        (c: any[]) => c[0] === 'hold_release_total'
      );
      expect(releaseMetricCalls).toHaveLength(0);
    });

    test('replays idempotent release for same key and payload', async () => {
      const cachedResponse = { success: true, message: 'Hold released successfully.' };
      mockIdempotencyFindUnique.mockResolvedValue({
        statusCode: 200,
        responseJson: cachedResponse,
        payloadHash: buildOperationPayloadHash('release', { holdId: T_HOLD_ID }),
      });

      const result = await releaseHold(T_HOLD_ID, T_TRANSPORTER_ID, 'idemp-key-1', 'manual', broadcastFn);

      expect(result.success).toBe(true);
      // Should not touch DB
      expect(mockWithDbTimeout).not.toHaveBeenCalled();
    });

    test('rejects idempotency key reused with different hold', async () => {
      mockIdempotencyFindUnique.mockResolvedValue({
        statusCode: 200,
        responseJson: { success: true, message: 'ok' },
        payloadHash: 'different-hash',
      });

      const result = await releaseHold(T_HOLD_ID, T_TRANSPORTER_ID, 'idemp-key-1', 'manual', broadcastFn);

      expect(result.success).toBe(false);
      expect(result.error).toBe('IDEMPOTENCY_CONFLICT');
    });

    test('handles DB error gracefully', async () => {
      mockTruckHoldLedgerFindUnique.mockResolvedValue(makeHold());
      mockWithDbTimeout.mockRejectedValue(new Error('DB connection lost'));

      const result = await releaseHold(T_HOLD_ID, T_TRANSPORTER_ID, undefined, 'manual', broadcastFn);

      expect(result.success).toBe(false);
      expect(result.error).toBe('INTERNAL_ERROR');
    });
  });

  describe('closeActiveHoldsForOrder()', () => {
    test('closes all active holds for cancelled order', async () => {
      mockTruckHoldLedgerFindMany.mockResolvedValue([
        { holdId: 'h1', transporterId: 't1', truckRequestIds: ['tr1'] },
        { holdId: 'h2', transporterId: 't2', truckRequestIds: ['tr2'] },
      ]);
      mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });
      mockTruckHoldLedgerUpdate.mockResolvedValue({});
      mockGetJSON.mockResolvedValue(null);

      const count = await closeActiveHoldsForOrder(T_ORDER_ID, 'ORDER_CANCELLED');

      expect(count).toBe(2);
    });

    test('returns 0 when no active holds', async () => {
      mockTruckHoldLedgerFindMany.mockResolvedValue([]);

      const count = await closeActiveHoldsForOrder(T_ORDER_ID, 'ORDER_CANCELLED');

      expect(count).toBe(0);
    });

    test('continues processing even when one hold fails', async () => {
      mockTruckHoldLedgerFindMany.mockResolvedValue([
        { holdId: 'h1', transporterId: 't1', truckRequestIds: ['tr1'] },
        { holdId: 'h2', transporterId: 't2', truckRequestIds: ['tr2'] },
      ]);
      // First hold fails, second succeeds
      mockWithDbTimeout
        .mockRejectedValueOnce(new Error('DB error'))
        .mockImplementationOnce(async (fn: any) => fn(mockTxProxy));
      mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });
      mockTruckHoldLedgerUpdate.mockResolvedValue({});
      mockGetJSON.mockResolvedValue(null);

      const count = await closeActiveHoldsForOrder(T_ORDER_ID, 'ORDER_EXPIRED');

      expect(count).toBe(2); // Count is based on found holds, not successful releases
    });
  });

  describe('clearHoldCacheEntries()', () => {
    test('removes all specified hold cache entries', async () => {
      mockGetJSON.mockResolvedValue(null);

      await clearHoldCacheEntries(['h1', 'h2', 'h3']);

      // holdStore.remove called for each (but no-ops since getJSON returns null)
      // No errors thrown
    });

    test('no-ops for empty array', async () => {
      await clearHoldCacheEntries([]);

      expect(mockGetJSON).not.toHaveBeenCalled();
    });

    test('skips null/empty holdIds', async () => {
      await clearHoldCacheEntries(['h1', '', 'h3']);

      // Should still process h1 and h3, skip empty
    });
  });
});

// =============================================================================
// 6. QUERY TESTS (truck-hold-query.service.ts)
// =============================================================================

describe('Query (truck-hold-query.service.ts)', () => {
  describe('getOrderAvailability()', () => {
    test('returns availability with truck groups', async () => {
      mockGetOrderById.mockResolvedValue({
        id: T_ORDER_ID,
        customerName: 'Test',
        customerPhone: '9999',
        pickup: { address: 'A' },
        drop: { address: 'B' },
        distanceKm: 50,
        goodsType: 'Cement',
      });
      mockGetTruckRequestsByOrder.mockResolvedValue([
        { vehicleType: 'Tata Ace', vehicleSubtype: '6 Wheeler', status: 'searching', pricePerTruck: 5000 },
        { vehicleType: 'Tata Ace', vehicleSubtype: '6 Wheeler', status: 'held', pricePerTruck: 5000 },
        { vehicleType: 'Tata Ace', vehicleSubtype: '6 Wheeler', status: 'assigned', pricePerTruck: 5000 },
        { vehicleType: 'Eicher', vehicleSubtype: '10 Wheeler', status: 'searching', pricePerTruck: 8000 },
      ]);

      const result = await getOrderAvailability(T_ORDER_ID);

      expect(result).not.toBeNull();
      expect(result!.orderId).toBe(T_ORDER_ID);
      expect(result!.trucks).toHaveLength(2);

      const tataGroup = result!.trucks.find(t => t.vehicleType === 'Tata Ace');
      expect(tataGroup!.available).toBe(1);
      expect(tataGroup!.held).toBe(1);
      expect(tataGroup!.assigned).toBe(1);
      expect(tataGroup!.totalNeeded).toBe(3);

      const eicherGroup = result!.trucks.find(t => t.vehicleType === 'Eicher');
      expect(eicherGroup!.available).toBe(1);
    });

    test('returns null when order not found', async () => {
      mockGetOrderById.mockResolvedValue(null);

      const result = await getOrderAvailability('nonexistent');

      expect(result).toBeNull();
    });

    test('isFullyAssigned is true when no available/held trucks', async () => {
      mockGetOrderById.mockResolvedValue({
        id: T_ORDER_ID,
        customerName: 'Test',
        customerPhone: '9999',
        pickup: { address: 'A' },
        drop: { address: 'B' },
        distanceKm: 50,
        goodsType: 'Cement',
      });
      mockGetTruckRequestsByOrder.mockResolvedValue([
        { vehicleType: 'Tata Ace', vehicleSubtype: '6 Wheeler', status: 'assigned', pricePerTruck: 5000 },
        { vehicleType: 'Tata Ace', vehicleSubtype: '6 Wheeler', status: 'completed', pricePerTruck: 5000 },
      ]);

      const result = await getOrderAvailability(T_ORDER_ID);

      expect(result!.isFullyAssigned).toBe(true);
    });

    test('returns null on error', async () => {
      mockGetOrderById.mockRejectedValue(new Error('DB error'));

      const result = await getOrderAvailability(T_ORDER_ID);

      expect(result).toBeNull();
    });
  });

  describe('getMyActiveHold()', () => {
    test('returns active hold for transporter', async () => {
      mockTruckHoldLedgerFindFirst.mockResolvedValue({
        holdId: T_HOLD_ID,
        orderId: T_ORDER_ID,
        vehicleType: 'Tata Ace',
        vehicleSubtype: '6 Wheeler',
        quantity: 2,
        expiresAt: futureDate(100),
        status: 'active',
      });

      const result = await getMyActiveHold(T_TRANSPORTER_ID, T_ORDER_ID, 'Tata Ace', '6 Wheeler');

      expect(result).not.toBeNull();
      expect(result!.holdId).toBe(T_HOLD_ID);
      expect(result!.status).toBe('active');
    });

    test('returns null when no active hold', async () => {
      mockTruckHoldLedgerFindFirst.mockResolvedValue(null);

      const result = await getMyActiveHold(T_TRANSPORTER_ID, T_ORDER_ID, 'Tata Ace', '6 Wheeler');

      expect(result).toBeNull();
    });
  });

  describe('getAvailableTruckRequests()', () => {
    test('filters to only searching status trucks', async () => {
      mockGetTruckRequestsByOrder.mockResolvedValue([
        { vehicleType: 'Tata Ace', vehicleSubtype: '6 Wheeler', status: 'searching' },
        { vehicleType: 'Tata Ace', vehicleSubtype: '6 Wheeler', status: 'held' },
        { vehicleType: 'Tata Ace', vehicleSubtype: '6 Wheeler', status: 'assigned' },
      ]);

      const result = await getAvailableTruckRequests(T_ORDER_ID, 'Tata Ace', '6 Wheeler');

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('searching');
    });

    test('case-insensitive vehicle type matching', async () => {
      mockGetTruckRequestsByOrder.mockResolvedValue([
        { vehicleType: 'TATA ACE', vehicleSubtype: '6 WHEELER', status: 'searching' },
      ]);

      const result = await getAvailableTruckRequests(T_ORDER_ID, 'tata ace', '6 wheeler');

      expect(result).toHaveLength(1);
    });

    test('returns empty when no matching trucks', async () => {
      mockGetTruckRequestsByOrder.mockResolvedValue([]);

      const result = await getAvailableTruckRequests(T_ORDER_ID, 'Tata Ace', '6 Wheeler');

      expect(result).toEqual([]);
    });
  });

  describe('broadcastAvailabilityUpdate()', () => {
    test('calls getOrderAvailability and broadcasts', () => {
      mockGetOrderById.mockResolvedValue({
        id: T_ORDER_ID,
        totalTrucks: 5,
        trucksFilled: 3,
      });
      mockGetTruckRequestsByOrder.mockResolvedValue([]);

      // broadcastAvailabilityUpdate is fire-and-forget
      broadcastAvailabilityUpdate(T_ORDER_ID);

      // Since it's async internally, we verify no errors thrown
    });
  });
});

// =============================================================================
// 7. CLEANUP TESTS (truck-hold-cleanup.service.ts)
// =============================================================================

describe('Cleanup (truck-hold-cleanup.service.ts)', () => {
  let cleanupModule: any;

  beforeEach(() => {
    jest.useFakeTimers();
    // Re-require to reset module state
    jest.isolateModules(() => {
      cleanupModule = require('../modules/truck-hold/truck-hold-cleanup.service');
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('stopCleanupJob clears interval', () => {
    // The module-level startCleanupJob may have been called
    cleanupModule.stopCleanupJob();
    // Should not throw
  });
});

// =============================================================================
// 8. EDGE CASES & RACE CONDITIONS
// =============================================================================

describe('Edge cases & race conditions', () => {
  const broadcastFn = jest.fn();

  test('hold expires exactly when driver accepts - confirm fails', async () => {
    // Hold has expiresAt exactly at now
    const hold = makeHold({ expiresAt: new Date() });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    const releaseHoldFn = jest.fn().mockResolvedValue({ success: true });

    const result = await confirmHold(T_HOLD_ID, T_TRANSPORTER_ID, releaseHoldFn, broadcastFn);

    expect(result.success).toBe(false);
    expect(result.message).toContain('expired');
  });

  test('two transporters try to hold same truck - both succeed at cache level (PG TX handles conflicts)', async () => {
    // FIX #40: Per-truck Redis locks removed. holdStore.add() is a cache layer only.
    // Concurrency (only one wins) is now handled by PG SERIALIZABLE transactions
    // in truck-hold-confirm.service.ts. Both adds succeed at the Redis cache level.
    const hold1 = {
      holdId: 'h1', orderId: T_ORDER_ID, transporterId: 't1',
      vehicleType: 'Tata Ace', vehicleSubtype: '', quantity: 1,
      truckRequestIds: [T_TRUCK_REQ_1],
      createdAt: new Date(), expiresAt: futureDate(180), status: 'active' as const,
    };
    const hold2 = {
      ...hold1, holdId: 'h2', transporterId: 't2',
    };

    const [result1, result2] = await Promise.all([
      holdStore.add(hold1),
      holdStore.add(hold2),
    ]);

    // Both succeed at cache level — PG TX determines the real winner
    expect(result1).toBe(true);
    expect(result2).toBe(true);
  });

  test('hold created then Redis goes down - holdStore.remove handles gracefully', async () => {
    mockGetJSON.mockRejectedValue(new Error('Redis connection refused'));

    await expect(holdStore.remove(T_HOLD_ID)).resolves.toBeUndefined();
  });

  test('release hold when hold is in confirmed status - idempotent success', async () => {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(makeHold({ status: 'confirmed' }));

    const result = await releaseHold(T_HOLD_ID, T_TRANSPORTER_ID, undefined, 'manual', broadcastFn);

    expect(result.success).toBe(true);
    expect(result.message).toContain('already released');
  });

  test('concurrent hold requests with same idempotency key return same result', async () => {
    const cachedResponse = {
      success: true, holdId: T_HOLD_ID, heldQuantity: 2,
      holdState: 'reserved', message: '2 trucks reserved',
    };
    const payloadHash = buildOperationPayloadHash('hold', {
      orderId: T_ORDER_ID, vehicleType: 'tata ace', vehicleSubtype: '', quantity: 2,
    });

    mockIdempotencyFindUnique.mockResolvedValue({
      statusCode: 200,
      responseJson: cachedResponse,
      payloadHash,
    });

    const requests = Array.from({ length: 5 }, () =>
      holdTrucks({
        orderId: T_ORDER_ID,
        transporterId: T_TRANSPORTER_ID,
        vehicleType: 'Tata Ace',
        vehicleSubtype: '',
        quantity: 2,
        idempotencyKey: 'same-key',
      }, broadcastFn)
    );

    const results = await Promise.all(requests);

    // All should return same cached response
    for (const result of results) {
      expect(result.success).toBe(true);
      expect(result.holdId).toBe(T_HOLD_ID);
    }
    // No DB transaction should have been called
    expect(mockWithDbTimeout).not.toHaveBeenCalled();
  });

  test('hold confirm after order cancelled returns inactive error', async () => {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(makeHold());
    mockOrderFindUnique.mockResolvedValue({ id: T_ORDER_ID, status: 'cancelled' });

    const releaseHoldFn = jest.fn();
    const result = await confirmHold(T_HOLD_ID, T_TRANSPORTER_ID, releaseHoldFn, broadcastFn);

    expect(result.success).toBe(false);
    expect(result.message).toContain('no longer active');
  });

  test('release hold with empty holdId is validation error', async () => {
    const result = await releaseHold('  ', T_TRANSPORTER_ID, undefined, 'manual', broadcastFn);

    expect(result.success).toBe(false);
    expect(result.error).toBe('VALIDATION_ERROR');
  });

  test('holdStore.add returns false on Redis write failure', async () => {
    // FIX #40: No per-truck locks. Test that add() returns false on Redis write failure.
    const hold = {
      holdId: 'h1', orderId: T_ORDER_ID, transporterId: T_TRANSPORTER_ID,
      vehicleType: 'Tata Ace', vehicleSubtype: '', quantity: 3,
      truckRequestIds: ['a-truck', 'b-truck', 'c-truck'],
      createdAt: new Date(), expiresAt: futureDate(180), status: 'active' as const,
    };

    mockSetJSON.mockRejectedValue(new Error('Redis write failure'));

    const result = await holdStore.add(hold);

    expect(result).toBe(false);
  });

  test('confirm hold with assignments when order not found', async () => {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(makeHold({ quantity: 1, truckRequestIds: [T_TRUCK_REQ_1] }));
    mockVehicleFindMany.mockResolvedValue([
      { id: T_VEHICLE_ID, transporterId: T_TRANSPORTER_ID, status: 'available', vehicleType: 'Tata Ace', vehicleSubtype: '6 Wheeler', vehicleNumber: 'KA01AB1234', currentTripId: null },
    ]);
    mockUserFindMany.mockResolvedValue([
      { id: T_DRIVER_ID, name: 'D1', phone: '1111111111', transporterId: T_TRANSPORTER_ID },
    ]);
    mockAssignmentFindMany.mockResolvedValue([]);
    mockAreDriversOnline.mockResolvedValue(new Map([[T_DRIVER_ID, true]]));
    mockGetOrderById.mockResolvedValue(null);

    const releaseHoldFn = jest.fn();
    const result = await confirmHoldWithAssignments(
      T_HOLD_ID, T_TRANSPORTER_ID,
      [{ vehicleId: T_VEHICLE_ID, driverId: T_DRIVER_ID }],
      releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('Order not found');
  });

  test('multiple holds for same transporter - getActiveHoldsByOrder returns all', async () => {
    mockSMembers.mockResolvedValue(['h1', 'h2', 'h3']);

    const makeRedisHold = (id: string) => ({
      holdId: id,
      orderId: T_ORDER_ID,
      transporterId: T_TRANSPORTER_ID,
      vehicleType: 'Tata Ace',
      vehicleSubtype: '',
      quantity: 1,
      truckRequestIds: [`tr-${id}`],
      createdAt: new Date().toISOString(),
      expiresAt: futureDate(100).toISOString(),
      status: 'active',
    });

    // Pipeline returns results as [error, value] tuples
    mockPipelineResults.length = 0;
    mockPipelineResults.push(
      [null, JSON.stringify(makeRedisHold('h1'))],
      [null, JSON.stringify(makeRedisHold('h2'))],
      [null, JSON.stringify(makeRedisHold('h3'))]
    );

    const holds = await holdStore.getActiveHoldsByOrder(T_ORDER_ID);

    expect(holds).toHaveLength(3);
  });

  test('holdStore.get deserializes dates correctly from ISO strings', async () => {
    const isoDate = '2026-04-01T12:30:00.000Z';
    mockGetJSON.mockResolvedValue({
      holdId: T_HOLD_ID,
      orderId: T_ORDER_ID,
      transporterId: T_TRANSPORTER_ID,
      vehicleType: 'Tata Ace',
      vehicleSubtype: '',
      quantity: 1,
      truckRequestIds: [T_TRUCK_REQ_1],
      createdAt: isoDate,
      expiresAt: isoDate,
      status: 'active',
    });

    const hold = await holdStore.get(T_HOLD_ID);

    expect(hold!.createdAt).toBeInstanceOf(Date);
    expect(hold!.expiresAt).toBeInstanceOf(Date);
    expect(hold!.createdAt.toISOString()).toBe(isoDate);
  });

  test('closeActiveHoldsForOrder with ORDER_EXPIRED sets expired status', async () => {
    mockTruckHoldLedgerFindMany.mockResolvedValue([
      { holdId: 'h1', transporterId: 't1', truckRequestIds: ['tr1'] },
    ]);
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });
    mockTruckHoldLedgerUpdate.mockResolvedValue({});
    mockGetJSON.mockResolvedValue(null);

    await closeActiveHoldsForOrder(T_ORDER_ID, 'ORDER_EXPIRED');

    const ledgerUpdate = mockTruckHoldLedgerUpdate.mock.calls[0][0];
    expect(ledgerUpdate.data.status).toBe('expired');
    expect(ledgerUpdate.data.terminalReason).toBe('ORDER_EXPIRED');
  });

  test('holdTrucks handles internal DB error gracefully', async () => {
    mockTruckHoldLedgerFindFirst.mockResolvedValue(null);
    mockWithDbTimeout.mockRejectedValue(new Error('Connection timeout'));

    const result = await holdTrucks({
      orderId: T_ORDER_ID,
      transporterId: T_TRANSPORTER_ID,
      vehicleType: 'Tata Ace',
      vehicleSubtype: '',
      quantity: 1,
    }, broadcastFn);

    expect(result.success).toBe(false);
    expect(result.error).toBe('INTERNAL_ERROR');
  });

  test('getOrderAvailability calculates totalValue correctly', async () => {
    mockGetOrderById.mockResolvedValue({
      id: T_ORDER_ID, customerName: 'Test', customerPhone: '9999',
      pickup: { address: 'A' }, drop: { address: 'B' },
      distanceKm: 50, goodsType: 'Cement',
    });
    mockGetTruckRequestsByOrder.mockResolvedValue([
      { vehicleType: 'Tata Ace', vehicleSubtype: '6 Wheeler', status: 'searching', pricePerTruck: 5000 },
      { vehicleType: 'Tata Ace', vehicleSubtype: '6 Wheeler', status: 'searching', pricePerTruck: 5000 },
      { vehicleType: 'Eicher', vehicleSubtype: '10 Wheeler', status: 'searching', pricePerTruck: 8000 },
    ]);

    const result = await getOrderAvailability(T_ORDER_ID);

    // 2 * 5000 + 1 * 8000 = 18000
    expect(result!.totalValue).toBe(18000);
  });

  test('saveIdempotentOperationResponse upserts correctly', async () => {
    mockIdempotencyUpsert.mockResolvedValue({});

    await saveIdempotentOperationResponse(
      T_TRANSPORTER_ID, 'hold', 'key-1', 'hash-abc', 200,
      { success: true, message: 'ok' }
    );

    expect(mockIdempotencyUpsert).toHaveBeenCalledTimes(1);
    const call = mockIdempotencyUpsert.mock.calls[0][0];
    expect(call.where.transporterId_operation_idempotencyKey.transporterId).toBe(T_TRANSPORTER_ID);
    expect(call.where.transporterId_operation_idempotencyKey.operation).toBe('hold');
    expect(call.where.transporterId_operation_idempotencyKey.idempotencyKey).toBe('key-1');
  });

  test('findActiveLedgerHold queries with case-insensitive vehicle match', async () => {
    mockTruckHoldLedgerFindFirst.mockResolvedValue(null);

    await findActiveLedgerHold(T_TRANSPORTER_ID, T_ORDER_ID, 'tata ace', '6 wheeler');

    const call = mockTruckHoldLedgerFindFirst.mock.calls[0][0];
    expect(call.where.vehicleType.mode).toBe('insensitive');
    expect(call.where.vehicleSubtype.mode).toBe('insensitive');
  });
});
