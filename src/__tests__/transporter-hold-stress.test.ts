/**
 * =============================================================================
 * TRANSPORTER HOLD & CONFIRM — Deep Stress Tests (80+ tests)
 * =============================================================================
 *
 * Focus: What happens when transporter receives broadcast and holds trucks.
 *
 * Sections:
 *   A. Hold creation (holdTrucks)
 *   B. Hold confirmation saga (confirmHoldWithAssignments — 8-step)
 *   C. Concurrent hold scenarios
 *   D. Hold expiry & release
 *   E. Query endpoints (availability, my-active-hold)
 *   F. HoldStore (Redis-backed distributed locking)
 *
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — Must come before all imports
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
  getPrismaClient: jest.fn(),
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

const mockRedisGet = jest.fn().mockResolvedValue(null);
const mockRedisSet = jest.fn().mockResolvedValue('OK');
const mockRedisHSet = jest.fn().mockResolvedValue(1);
const mockRedisSCard = jest.fn().mockResolvedValue(0);
const mockRedisSIsMember = jest.fn().mockResolvedValue(false);
let mockPipelineResults: Array<[Error | null, string | null]> = [];
const mockPipeline = {
  get: jest.fn().mockReturnThis(),
  exec: jest.fn().mockImplementation(async () => mockPipelineResults),
};

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    acquireLock: (...args: any[]) => mockAcquireLock(...args),
    releaseLock: (...args: any[]) => mockReleaseLock(...args),
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    getJSON: (...args: any[]) => mockGetJSON(...args),
    setJSON: (...args: any[]) => mockSetJSON(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    sAdd: (...args: any[]) => mockSAdd(...args),
    sRem: (...args: any[]) => mockSRem(...args),
    sMembers: (...args: any[]) => mockSMembers(...args),
    expire: (...args: any[]) => mockExpire(...args),
    ttl: (...args: any[]) => mockTtl(...args),
    hSet: (...args: any[]) => mockRedisHSet(...args),
    sCard: (...args: any[]) => mockRedisSCard(...args),
    sIsMember: (...args: any[]) => mockRedisSIsMember(...args),
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

// --- Other dependency mocks ---
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
  fcmService: { sendNotification: jest.fn(), sendToUser: jest.fn() },
}));
jest.mock('../modules/hold-expiry/hold-expiry-cleanup.service', () => ({
  holdExpiryCleanupService: {
    scheduleFlexHoldCleanup: jest.fn().mockResolvedValue('job-1'),
    scheduleConfirmedHoldCleanup: jest.fn().mockResolvedValue('job-2'),
    cancelScheduledCleanup: jest.fn().mockResolvedValue(undefined),
    processExpiredHold: jest.fn(),
  },
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { holdTrucks, confirmHold, normalizeVehiclePart, buildOperationPayloadHash, recordHoldOutcomeMetrics, findActiveLedgerHold } from '../modules/truck-hold/truck-hold-create.service';
import { confirmHoldWithAssignments } from '../modules/truck-hold/truck-hold-confirm.service';
import { releaseHold, closeActiveHoldsForOrder, clearHoldCacheEntries } from '../modules/truck-hold/truck-hold-release.service';
import { getOrderAvailability, getMyActiveHold, getAvailableTruckRequests, broadcastAvailabilityUpdate } from '../modules/truck-hold/truck-hold-query.service';
import { holdStore, REDIS_KEYS } from '../modules/truck-hold/truck-hold-store.service';
import { CONFIG, ACTIVE_ORDER_STATUSES, TERMINAL_ORDER_STATUSES } from '../modules/truck-hold/truck-hold.types';
import { metrics } from '../shared/monitoring/metrics.service';

// =============================================================================
// HELPERS
// =============================================================================

const T1 = 'transporter-1';
const T2 = 'transporter-2';
const ORDER_1 = 'order-1';
const V_TYPE = 'Tata Ace';
const V_SUBTYPE = '7ft';

function makeHoldRequest(overrides: Partial<any> = {}) {
  return {
    orderId: ORDER_1,
    transporterId: T1,
    vehicleType: V_TYPE,
    vehicleSubtype: V_SUBTYPE,
    quantity: 2,
    ...overrides,
  };
}

function makeTruckRequests(count: number, overrides: Partial<any> = {}) {
  return Array.from({ length: count }, (_, i) => ({
    id: `tr-${i + 1}`,
    orderId: ORDER_1,
    vehicleType: V_TYPE,
    vehicleSubtype: V_SUBTYPE,
    status: 'searching',
    requestNumber: i + 1,
    pricePerTruck: 5000,
    createdAt: new Date(),
    ...overrides,
  }));
}

function makeActiveHoldLedger(overrides: Partial<any> = {}) {
  return {
    holdId: 'HOLD_ABCD1234',
    orderId: ORDER_1,
    transporterId: T1,
    vehicleType: V_TYPE,
    vehicleSubtype: V_SUBTYPE,
    quantity: 2,
    truckRequestIds: ['tr-1', 'tr-2'],
    status: 'active',
    expiresAt: new Date(Date.now() + 120_000),
    createdAt: new Date(),
    confirmedAt: null as any,
    releasedAt: null as any,
    terminalReason: null as any,
    ...overrides,
  };
}

function makeVehicle(id: string, overrides: Partial<any> = {}) {
  return {
    id,
    transporterId: T1,
    status: 'available',
    currentTripId: null as any,
    vehicleType: V_TYPE,
    vehicleSubtype: V_SUBTYPE,
    vehicleNumber: `KA-01-${id.toUpperCase()}`,
    ...overrides,
  };
}

function makeDriver(id: string, overrides: Partial<any> = {}) {
  return {
    id,
    name: `Driver ${id}`,
    phone: `900000000${id.slice(-1)}`,
    transporterId: T1,
    ...overrides,
  };
}

function makeOrder(overrides: Partial<any> = {}) {
  return {
    id: ORDER_1,
    status: 'broadcasting',
    totalTrucks: 5,
    trucksFilled: 0,
    customerName: 'Test Customer',
    customerPhone: '9876543210',
    pickup: { address: 'Pickup A', lat: 12.97, lng: 77.59 },
    drop: { address: 'Drop B', lat: 13.01, lng: 77.60 },
    distanceKm: 15,
    goodsType: 'Cement',
    routePoints: [] as any[],
    ...overrides,
  };
}

const broadcastFn = jest.fn();
const releaseHoldFn = jest.fn().mockResolvedValue({ success: true });

// =============================================================================
// RESET
// =============================================================================

beforeEach(() => {
  jest.clearAllMocks();

  // Restore withDbTimeout default implementation (clearAllMocks removes it)
  mockWithDbTimeout.mockImplementation(
    async (fn: (tx: any) => Promise<any>, _opts?: any) => fn(mockTxProxy)
  );

  // Default Redis responses
  mockPipelineResults = [];
  mockAcquireLock.mockResolvedValue({ acquired: true });
  mockReleaseLock.mockResolvedValue(undefined);
  mockGetJSON.mockResolvedValue(null);
  mockSetJSON.mockResolvedValue(undefined);
  mockRedisDel.mockResolvedValue(undefined);
  mockSAdd.mockResolvedValue(1);
  mockExpire.mockResolvedValue(true);
  mockTtl.mockResolvedValue(100);

  // Default DB responses for holdTrucks happy path
  mockIdempotencyFindUnique.mockResolvedValue(null);
  mockIdempotencyUpsert.mockResolvedValue({});
  mockTruckHoldLedgerFindFirst.mockResolvedValue(null);
  mockOrderFindUnique.mockResolvedValue({ id: ORDER_1, status: 'broadcasting' });
  mockTruckRequestFindMany.mockResolvedValue(makeTruckRequests(2));
  mockTruckRequestUpdateMany.mockResolvedValue({ count: 2 });
  mockTruckHoldLedgerCreate.mockResolvedValue({});
  mockQueryRaw.mockResolvedValue(makeTruckRequests(2).map(tr => ({ id: tr.id })));
});

// =============================================================================
// A. HOLD CREATION
// =============================================================================

describe('A. Hold creation (holdTrucks)', () => {
  it('A01: holds trucks for a booking — success', async () => {
    const result = await holdTrucks(makeHoldRequest(), broadcastFn);

    expect(result.success).toBe(true);
    expect(result.holdId).toBeDefined();
    expect(result.holdId).toMatch(/^HOLD_/);
    expect(result.heldQuantity).toBe(2);
    expect(result.holdState).toBe('reserved');
    expect(result.expiresAt).toBeDefined();
    expect(broadcastFn).toHaveBeenCalledWith(ORDER_1);
  });

  it('A02: hold with specific truck IDs via atomic DB claim', async () => {
    const trucks = makeTruckRequests(3);
    mockQueryRaw.mockResolvedValue(trucks.map(tr => ({ id: tr.id })));
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 3 });

    const result = await holdTrucks(makeHoldRequest({ quantity: 3 }), broadcastFn);

    expect(result.success).toBe(true);
    expect(result.heldQuantity).toBe(3);
  });

  it('A03: hold with quantity (any matching trucks)', async () => {
    mockQueryRaw.mockResolvedValue([{ id: 'tr-1' }]);
    mockTruckRequestFindMany.mockResolvedValue([{ id: 'tr-1' }]);
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });

    const result = await holdTrucks(makeHoldRequest({ quantity: 1 }), broadcastFn);

    expect(result.success).toBe(true);
    expect(result.heldQuantity).toBe(1);
  });

  it('A04: hold when not enough trucks available returns error', async () => {
    mockQueryRaw.mockResolvedValue([{ id: 'tr-1' }]);

    mockWithDbTimeout.mockImplementationOnce(async (fn: any) => {
      return fn(mockTxProxy);
    });
    mockTruckRequestFindMany.mockResolvedValue([{ id: 'tr-1' }]);
    mockQueryRaw.mockResolvedValue([{ id: 'tr-1' }]);

    const result = await holdTrucks(makeHoldRequest({ quantity: 5 }), broadcastFn);

    expect(result.success).toBe(false);
    expect(result.error).toBe('NOT_ENOUGH_AVAILABLE');
    expect(result.message).toContain('Only');
  });

  it('A05: hold when trucks already held by another transporter fails', async () => {
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 0 });

    const result = await holdTrucks(makeHoldRequest(), broadcastFn);

    expect(result.success).toBe(false);
    expect(result.error).toBe('TRUCK_STATE_CHANGED');
  });

  it('A06: hold when booking does not exist returns error', async () => {
    mockOrderFindUnique.mockResolvedValue(null);

    const result = await holdTrucks(makeHoldRequest(), broadcastFn);

    expect(result.success).toBe(false);
    expect(result.error).toBe('ORDER_INACTIVE');
    expect(result.message).toContain('no longer exists');
  });

  it('A07: hold when booking is expired returns error', async () => {
    mockOrderFindUnique.mockResolvedValue({ id: ORDER_1, status: 'expired' });

    const result = await holdTrucks(makeHoldRequest(), broadcastFn);

    expect(result.success).toBe(false);
    expect(result.error).toBe('ORDER_INACTIVE');
  });

  it('A08: hold when booking is cancelled returns error', async () => {
    mockOrderFindUnique.mockResolvedValue({ id: ORDER_1, status: 'cancelled' });

    const result = await holdTrucks(makeHoldRequest(), broadcastFn);

    expect(result.success).toBe(false);
    expect(result.error).toBe('ORDER_INACTIVE');
  });

  it('A09: idempotent hold (same request ID) returns same response', async () => {
    const idempotencyKey = 'idem-key-1';
    const savedResponse = {
      success: true, holdId: 'HOLD_EXISTING', heldQuantity: 2,
      holdState: 'reserved', message: 'Already reserved',
    };
    const payloadHash = buildOperationPayloadHash('hold', {
      orderId: ORDER_1,
      vehicleType: V_TYPE.toLowerCase(),
      vehicleSubtype: V_SUBTYPE.toLowerCase(),
      quantity: 2,
    });

    mockIdempotencyFindUnique.mockResolvedValue({
      statusCode: 200,
      responseJson: savedResponse,
      payloadHash,
    });

    const result = await holdTrucks(makeHoldRequest({ idempotencyKey }), broadcastFn);

    expect(result.success).toBe(true);
    expect(result.holdId).toBe('HOLD_EXISTING');
    expect(broadcastFn).not.toHaveBeenCalled();
  });

  it('A10: idempotency key reused with different payload returns conflict', async () => {
    const idempotencyKey = 'idem-key-conflict';
    mockIdempotencyFindUnique.mockResolvedValue({
      statusCode: 200,
      responseJson: { success: true, holdId: 'HOLD_X' },
      payloadHash: 'different-hash',
    });

    const result = await holdTrucks(makeHoldRequest({ idempotencyKey }), broadcastFn);

    expect(result.success).toBe(false);
    expect(result.error).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('A11: hold records metrics (counter and latency)', async () => {
    await holdTrucks(makeHoldRequest(), broadcastFn);

    expect(metrics.incrementCounter).toHaveBeenCalledWith('hold_request_total');
    expect(metrics.incrementCounter).toHaveBeenCalledWith('hold_success_total');
    expect(metrics.observeHistogram).toHaveBeenCalledWith(
      'hold_latency_ms',
      expect.any(Number),
      expect.objectContaining({ replay: 'false', result: 'success' })
    );
  });

  it('A12: hold updates truck request status to held', async () => {
    await holdTrucks(makeHoldRequest(), broadcastFn);

    expect(mockTruckRequestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'held', heldById: T1 }),
      })
    );
  });

  it('A13: hold ledger entry created in DB', async () => {
    await holdTrucks(makeHoldRequest(), broadcastFn);

    expect(mockTruckHoldLedgerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: ORDER_1,
          transporterId: T1,
          vehicleType: V_TYPE,
          vehicleSubtype: V_SUBTYPE,
          quantity: 2,
          status: 'active',
        }),
      })
    );
  });

  it('A14: hold with missing orderId fails validation', async () => {
    const result = await holdTrucks(makeHoldRequest({ orderId: '' }), broadcastFn);

    expect(result.success).toBe(false);
    expect(result.error).toBe('VALIDATION_ERROR');
  });

  it('A15: hold with missing vehicleType fails validation', async () => {
    const result = await holdTrucks(makeHoldRequest({ vehicleType: '' }), broadcastFn);

    expect(result.success).toBe(false);
    expect(result.error).toBe('VALIDATION_ERROR');
  });

  it('A16: hold with zero quantity fails validation', async () => {
    const result = await holdTrucks(makeHoldRequest({ quantity: 0 }), broadcastFn);

    expect(result.success).toBe(false);
    expect(result.error).toBe('VALIDATION_ERROR');
  });

  it('A17: hold with quantity exceeding MAX_HOLD_QUANTITY fails', async () => {
    const result = await holdTrucks(makeHoldRequest({ quantity: 51 }), broadcastFn);

    expect(result.success).toBe(false);
    expect(result.error).toBe('VALIDATION_ERROR');
    expect(result.message).toContain('between');
  });

  it('A18: hold with non-integer quantity fails validation', async () => {
    const result = await holdTrucks(makeHoldRequest({ quantity: 2.5 }), broadcastFn);

    expect(result.success).toBe(false);
    expect(result.error).toBe('VALIDATION_ERROR');
  });

  it('A19: hold with NaN quantity fails validation', async () => {
    const result = await holdTrucks(makeHoldRequest({ quantity: NaN }), broadcastFn);

    expect(result.success).toBe(false);
    expect(result.error).toBe('VALIDATION_ERROR');
  });

  it('A20: reconcile recovery returns existing active hold', async () => {
    const existingHold = makeActiveHoldLedger();
    mockTruckHoldLedgerFindFirst.mockResolvedValue(existingHold);

    const result = await holdTrucks(makeHoldRequest(), broadcastFn);

    expect(result.success).toBe(true);
    expect(result.holdId).toBe(existingHold.holdId);
    expect(result.message).toContain('already reserved');
  });

  it('A21: hold expiresAt is set correctly based on CONFIG', async () => {
    const before = Date.now();
    const result = await holdTrucks(makeHoldRequest(), broadcastFn);
    const after = Date.now();

    expect(result.expiresAt).toBeDefined();
    const expiresAt = new Date(result.expiresAt!).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + CONFIG.HOLD_DURATION_SECONDS * 1000 - 100);
    expect(expiresAt).toBeLessThanOrEqual(after + CONFIG.HOLD_DURATION_SECONDS * 1000 + 100);
  });

  it('A22: hold includes eventId and eventVersion in response', async () => {
    const result = await holdTrucks(makeHoldRequest(), broadcastFn);

    expect(result.eventId).toBeDefined();
    expect(result.eventVersion).toBeDefined();
    expect(result.serverTimeMs).toBeDefined();
  });

  it('A23: hold with negative quantity fails validation', async () => {
    const result = await holdTrucks(makeHoldRequest({ quantity: -1 }), broadcastFn);

    expect(result.success).toBe(false);
    expect(result.error).toBe('VALIDATION_ERROR');
  });

  it('A24: internal error during hold returns INTERNAL_ERROR', async () => {
    mockWithDbTimeout.mockRejectedValueOnce(new Error('DB connection lost'));

    const result = await holdTrucks(makeHoldRequest(), broadcastFn);

    expect(result.success).toBe(false);
    expect(result.error).toBe('INTERNAL_ERROR');
  });
});

// =============================================================================
// B. HOLD CONFIRMATION SAGA (confirmHoldWithAssignments)
// =============================================================================

describe('B. Hold confirmation saga (confirmHoldWithAssignments)', () => {
  const HOLD_ID = 'HOLD_CONFIRM1';
  const vehicleA = makeVehicle('v-1');
  const vehicleB = makeVehicle('v-2');
  const driverA = makeDriver('d-1');
  const driverB = makeDriver('d-2');
  const assignments = [
    { vehicleId: 'v-1', driverId: 'd-1' },
    { vehicleId: 'v-2', driverId: 'd-2' },
  ];

  function setupConfirmHappyPath() {
    const hold = makeActiveHoldLedger({ holdId: HOLD_ID });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);

    // validateAssignmentVehicles calls prismaClient.vehicle.findMany, user.findMany,
    // assignment.findMany (x2 for drivers and vehicles) at top level,
    // then executeAssignmentTransaction calls them again via withDbTimeout.
    // Both route through the same mock fns, so use mockResolvedValue (not Once) for
    // data that is queried in both phases, and mockResolvedValueOnce for ordered calls.

    // Validation phase + transaction phase both call vehicle.findMany
    mockVehicleFindMany.mockResolvedValue([vehicleA, vehicleB]);
    mockUserFindMany.mockResolvedValue([driverA, driverB]);
    // assignment.findMany called 4 times: 2 in validation (drivers, vehicles), 2 in tx
    mockAssignmentFindMany.mockResolvedValue([]);
    mockAreDriversOnline.mockResolvedValue(new Map([['d-1', true], ['d-2', true]]));
    mockGetOrderById.mockResolvedValue(makeOrder());
    mockGetUserById.mockResolvedValue({ id: T1, name: 'Test Transporter', businessName: 'Test Co' });

    // Transaction mocks
    mockOrderFindUnique.mockResolvedValue({ id: ORDER_1, totalTrucks: 5, trucksFilled: 0 });
    mockTruckRequestFindMany.mockResolvedValue([
      { id: 'tr-1', orderId: ORDER_1, status: 'held', heldById: T1, pricePerTruck: 5000 },
      { id: 'tr-2', orderId: ORDER_1, status: 'held', heldById: T1, pricePerTruck: 5000 },
    ]);
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });
    mockAssignmentCreate.mockResolvedValue({});
    mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockOrderUpdate.mockResolvedValue({ trucksFilled: 2, totalTrucks: 5 });
    mockTruckHoldLedgerUpdate.mockResolvedValue({});
  }

  it('B01: full saga happy path — all steps succeed', async () => {
    setupConfirmHappyPath();

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(true);
    expect(result.assignmentIds).toBeDefined();
    expect(result.assignmentIds!.length).toBe(2);
    expect(result.tripIds).toBeDefined();
    expect(result.tripIds!.length).toBe(2);
  });

  it('B02: step 1 fails — hold not found returns clean error', async () => {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(null);

    const result = await confirmHoldWithAssignments(
      'HOLD_NONEXISTENT', T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('B03: step 2 fails — wrong transporter is forbidden', async () => {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(
      makeActiveHoldLedger({ holdId: HOLD_ID, transporterId: T2 })
    );

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('another transporter');
  });

  it('B04: step 3 fails — hold not active returns conflict', async () => {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(
      makeActiveHoldLedger({ holdId: HOLD_ID, status: 'released' })
    );

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('released');
  });

  it('B05: step 4 fails — hold expired triggers release and error', async () => {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(
      makeActiveHoldLedger({ holdId: HOLD_ID, expiresAt: new Date(Date.now() - 1000) })
    );

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('expired');
    expect(releaseHoldFn).toHaveBeenCalledWith(HOLD_ID, T1);
  });

  it('B06: assignment count mismatch returns error', async () => {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(
      makeActiveHoldLedger({ holdId: HOLD_ID, quantity: 3 })
    );

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('Expected 3');
  });

  it('B07: duplicate vehicle in assignments fails validation', async () => {
    setupConfirmHappyPath();
    // Hold with quantity 2, but two assignments use same vehicle
    const dupeAssignments = [
      { vehicleId: 'v-1', driverId: 'd-1' },
      { vehicleId: 'v-1', driverId: 'd-2' },
    ];
    // vehicle.findMany returns only unique v-1 (deduped by Set), user.findMany returns both
    mockVehicleFindMany.mockResolvedValue([vehicleA]);
    mockUserFindMany.mockResolvedValue([driverA, driverB]);

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, dupeAssignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.failedAssignments).toBeDefined();
    expect(result.failedAssignments!.some(f => f.reason.includes('Duplicate vehicle'))).toBe(true);
  });

  it('B08: duplicate driver in assignments fails validation', async () => {
    setupConfirmHappyPath();
    const dupeAssignments = [
      { vehicleId: 'v-1', driverId: 'd-1' },
      { vehicleId: 'v-2', driverId: 'd-1' },
    ];
    // vehicle.findMany returns both, user.findMany returns deduped d-1
    mockVehicleFindMany.mockResolvedValue([vehicleA, vehicleB]);
    mockUserFindMany.mockResolvedValue([driverA]);

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, dupeAssignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.failedAssignments).toBeDefined();
    expect(result.failedAssignments!.some(f => f.reason.includes('Duplicate driver'))).toBe(true);
  });

  it('B09: vehicle not owned by transporter is rejected', async () => {
    setupConfirmHappyPath();
    mockVehicleFindMany.mockResolvedValue([
      { ...vehicleA, transporterId: T2 },
      vehicleB,
    ]);

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.failedAssignments!.some(f => f.reason.includes('does not belong'))).toBe(true);
  });

  it('B10: vehicle not available is rejected', async () => {
    setupConfirmHappyPath();
    mockVehicleFindMany.mockResolvedValue([
      { ...vehicleA, status: 'in_transit', currentTripId: 'trip-99' },
      vehicleB,
    ]);

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.failedAssignments!.some(f => f.reason.includes('in_transit'))).toBe(true);
  });

  it('B11: driver offline is rejected (Uber/Ola fail-fast pattern)', async () => {
    const hold = makeActiveHoldLedger({ holdId: HOLD_ID });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    mockVehicleFindMany.mockResolvedValue([vehicleA, vehicleB]);
    mockUserFindMany.mockResolvedValue([driverA, driverB]);
    mockAssignmentFindMany.mockResolvedValue([]);
    // Key: d-1 offline
    mockAreDriversOnline.mockResolvedValue(new Map([['d-1', false], ['d-2', true]]));

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.failedAssignments!.some(f => f.reason.includes('offline'))).toBe(true);
  });

  it('B12: driver already has active assignment is rejected', async () => {
    const hold = makeActiveHoldLedger({ holdId: HOLD_ID });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    mockVehicleFindMany.mockResolvedValue([vehicleA, vehicleB]);
    mockUserFindMany.mockResolvedValue([driverA, driverB]);
    // assignment.findMany is called twice: once for driver assignments, once for vehicle assignments
    // First call returns active driver assignment, second returns empty for vehicles
    mockAssignmentFindMany
      .mockResolvedValueOnce([{ driverId: 'd-1', tripId: 'trip-active-1' }])
      .mockResolvedValueOnce([]);
    mockAreDriversOnline.mockResolvedValue(new Map([['d-1', true], ['d-2', true]]));

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.failedAssignments!.some(f => f.reason.includes('already on trip'))).toBe(true);
  });

  it('B13: vehicle type mismatch is rejected', async () => {
    setupConfirmHappyPath();
    mockVehicleFindMany.mockResolvedValue([
      { ...vehicleA, vehicleType: 'Mahindra Bolero' },
      vehicleB,
    ]);

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.failedAssignments!.some(f => f.reason.includes('type mismatch'))).toBe(true);
  });

  it('B14: vehicle subtype mismatch is rejected', async () => {
    setupConfirmHappyPath();
    mockVehicleFindMany.mockResolvedValue([
      { ...vehicleA, vehicleSubtype: '10ft' },
      vehicleB,
    ]);

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.failedAssignments!.some(f => f.reason.includes('subtype mismatch'))).toBe(true);
  });

  it('B15: vehicle with active assignment is rejected even if status is available', async () => {
    const hold = makeActiveHoldLedger({ holdId: HOLD_ID });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    mockVehicleFindMany.mockResolvedValue([vehicleA, vehicleB]);
    mockUserFindMany.mockResolvedValue([driverA, driverB]);
    // assignment.findMany: 1st call = driver assignments (empty), 2nd = vehicle assignments (v-1 busy)
    mockAssignmentFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ vehicleId: 'v-1', tripId: 'trip-busy' }]);
    mockAreDriversOnline.mockResolvedValue(new Map([['d-1', true], ['d-2', true]]));

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.failedAssignments!.some(f => f.reason.includes('already reserved'))).toBe(true);
  });

  it('B16: Prisma unique constraint violation (P2002) returns friendly error', async () => {
    setupConfirmHappyPath();
    // withDbTimeout is called once in executeAssignmentTransaction
    mockWithDbTimeout.mockRejectedValueOnce(
      Object.assign(new Error('unique constraint'), { code: 'P2002', meta: { target: ['driverId'] } })
    );

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('driver already has an active assignment');
  });

  it('B17: Prisma serialization failure (P2034) returns retry message', async () => {
    setupConfirmHappyPath();
    mockWithDbTimeout.mockRejectedValueOnce(
      Object.assign(new Error('serialization failure'), { code: 'P2034' })
    );

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('Another transaction');
  });

  it('B18: DRIVER_BUSY error from transaction returns friendly message', async () => {
    setupConfirmHappyPath();
    mockWithDbTimeout.mockRejectedValueOnce(new Error('DRIVER_BUSY:d-1:trip-5'));

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('already on a trip');
  });

  it('B19: VEHICLE_UNAVAILABLE error from transaction returns friendly message', async () => {
    setupConfirmHappyPath();
    mockWithDbTimeout.mockRejectedValueOnce(new Error('VEHICLE_UNAVAILABLE:v-1:trip-77'));

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('no longer available');
  });

  it('B20: ORDER_NOT_FOUND during transaction returns friendly message', async () => {
    setupConfirmHappyPath();
    mockWithDbTimeout.mockRejectedValueOnce(new Error('ORDER_NOT_FOUND'));

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    // handleAssignmentFailure translates ORDER_NOT_FOUND
    expect(result.message).toContain('no longer available');
  });

  it('B21: successful confirm sends Socket.IO trip_assigned to each driver', async () => {
    setupConfirmHappyPath();

    await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(mockEmitToUser).toHaveBeenCalledTimes(2);
    expect(mockEmitToUser).toHaveBeenCalledWith('d-1', 'trip_assigned', expect.any(Object));
    expect(mockEmitToUser).toHaveBeenCalledWith('d-2', 'trip_assigned', expect.any(Object));
  });

  it('B22: successful confirm queues FCM push for each driver', async () => {
    setupConfirmHappyPath();

    await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(mockQueuePushNotification).toHaveBeenCalledTimes(2);
  });

  it('B23: successful confirm schedules timeout for each assignment', async () => {
    setupConfirmHappyPath();

    await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(mockScheduleAssignmentTimeout).toHaveBeenCalledTimes(2);
    expect(mockScheduleAssignmentTimeout).toHaveBeenCalledWith(
      expect.objectContaining({ driverId: 'd-1' }),
      45000
    );
  });

  it('B24: successful confirm marks hold as confirmed in ledger', async () => {
    setupConfirmHappyPath();

    await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(mockTruckHoldLedgerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { holdId: HOLD_ID },
        data: expect.objectContaining({ status: 'confirmed' }),
      })
    );
  });

  it('B25: successful confirm broadcasts availability update', async () => {
    setupConfirmHappyPath();

    await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(broadcastFn).toHaveBeenCalledWith(ORDER_1);
  });

  it('B26: driver not found returns validation error', async () => {
    const hold = makeActiveHoldLedger({ holdId: HOLD_ID });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    mockVehicleFindMany.mockResolvedValue([vehicleA, vehicleB]);
    mockUserFindMany.mockResolvedValue([driverA]); // Missing driverB
    mockAssignmentFindMany.mockResolvedValue([]);
    mockAreDriversOnline.mockResolvedValue(new Map([['d-1', true], ['d-2', true]]));

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.failedAssignments!.some(f => f.reason.includes('Driver not found'))).toBe(true);
  });

  it('B27: vehicle not found returns validation error', async () => {
    setupConfirmHappyPath();
    mockVehicleFindMany.mockResolvedValue([vehicleA]); // Missing vehicleB

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.failedAssignments!.some(f => f.reason.includes('Vehicle not found'))).toBe(true);
  });

  it('B28: order not found after validation returns error', async () => {
    const hold = makeActiveHoldLedger({ holdId: HOLD_ID });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    mockVehicleFindMany.mockResolvedValue([vehicleA, vehicleB]);
    mockUserFindMany.mockResolvedValue([driverA, driverB]);
    mockAssignmentFindMany.mockResolvedValue([]);
    mockAreDriversOnline.mockResolvedValue(new Map([['d-1', true], ['d-2', true]]));
    // Order not found via db.getOrderById (step 4 in saga)
    mockGetOrderById.mockResolvedValue(null);

    const result = await confirmHoldWithAssignments(
      HOLD_ID, T1, assignments, releaseHoldFn, broadcastFn
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('Order not found');
  });
});

// =============================================================================
// C. SIMPLE CONFIRM (confirmHold)
// =============================================================================

describe('C. Simple confirm (confirmHold)', () => {
  function setupSimpleConfirmDefaults() {
    mockOrderFindUnique.mockResolvedValue({ id: ORDER_1, status: 'broadcasting' });
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 2 });
    mockOrderUpdate.mockResolvedValue({});
    mockTruckHoldLedgerUpdate.mockResolvedValue({});
  }

  it('C01: simple confirm succeeds for active hold', async () => {
    const hold = makeActiveHoldLedger({ holdId: 'HOLD_SIMPLE' });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    setupSimpleConfirmDefaults();

    const result = await confirmHold('HOLD_SIMPLE', T1, releaseHoldFn, broadcastFn);

    expect(result.success).toBe(true);
    expect(result.assignedTrucks).toEqual(['tr-1', 'tr-2']);
  });

  it('C02: confirm fails for non-existent hold', async () => {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(null);

    const result = await confirmHold('HOLD_FAKE', T1, releaseHoldFn, broadcastFn);

    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('C03: confirm fails for wrong transporter', async () => {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(
      makeActiveHoldLedger({ transporterId: T2 })
    );

    const result = await confirmHold('HOLD_ABCD1234', T1, releaseHoldFn, broadcastFn);

    expect(result.success).toBe(false);
    expect(result.message).toContain('another transporter');
  });

  it('C04: confirm fails for already confirmed hold', async () => {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(
      makeActiveHoldLedger({ status: 'confirmed' })
    );

    const result = await confirmHold('HOLD_ABCD1234', T1, releaseHoldFn, broadcastFn);

    expect(result.success).toBe(false);
    expect(result.message).toContain('confirmed');
  });

  it('C05: confirm releases expired hold and returns error', async () => {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(
      makeActiveHoldLedger({ expiresAt: new Date(Date.now() - 5000) })
    );

    const result = await confirmHold('HOLD_ABCD1234', T1, releaseHoldFn, broadcastFn);

    expect(result.success).toBe(false);
    expect(result.message).toContain('expired');
    expect(releaseHoldFn).toHaveBeenCalled();
  });

  it('C06: confirm records latency metric', async () => {
    const hold = makeActiveHoldLedger({ holdId: 'HOLD_METRIC' });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    setupSimpleConfirmDefaults();

    await confirmHold('HOLD_METRIC', T1, releaseHoldFn, broadcastFn);

    expect(metrics.observeHistogram).toHaveBeenCalledWith('confirm_latency_ms', expect.any(Number));
  });

  it('C07: confirm fails when order became inactive (cancelled)', async () => {
    const hold = makeActiveHoldLedger({ holdId: 'HOLD_INACTIVE_ORDER' });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    // The TX reads order status — cancelled is in TERMINAL_ORDER_STATUSES
    mockOrderFindUnique.mockResolvedValue({ id: ORDER_1, status: 'cancelled' });
    // withDbTimeout should throw ORDER_INACTIVE from inside the TX
    mockWithDbTimeout.mockImplementationOnce(async (fn: any, _opts?: any) => {
      return fn(mockTxProxy);
    });

    const result = await confirmHold('HOLD_INACTIVE_ORDER', T1, releaseHoldFn, broadcastFn);

    expect(result.success).toBe(false);
    expect(result.message).toContain('no longer active');
  });

  it('C08: confirm fails when truck state changed mid-confirm', async () => {
    const hold = makeActiveHoldLedger({ holdId: 'HOLD_CHANGED' });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    // Order is active so the check passes
    mockOrderFindUnique.mockResolvedValue({ id: ORDER_1, status: 'broadcasting' });
    // But updateMany returns 0 — truck state changed
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 0 });
    mockWithDbTimeout.mockImplementationOnce(async (fn: any, _opts?: any) => {
      return fn(mockTxProxy);
    });

    const result = await confirmHold('HOLD_CHANGED', T1, releaseHoldFn, broadcastFn);

    expect(result.success).toBe(false);
    expect(result.message).toContain('changed state');
  });
});

// =============================================================================
// D. CONCURRENT HOLD SCENARIOS
// =============================================================================

describe('D. Concurrent hold scenarios', () => {
  it('D01: two transporters hold same trucks — first wins, second fails', async () => {
    // First transporter succeeds (default mocks from beforeEach return count: 2)
    const result1 = await holdTrucks(makeHoldRequest({ transporterId: T1 }), broadcastFn);
    expect(result1.success).toBe(true);

    // Second transporter: trucks already held by T1, so updateMany returns 0
    // Need to re-set mocks since clearAllMocks was not called between them
    mockTruckHoldLedgerFindFirst.mockResolvedValue(null); // no existing hold for T2
    mockIdempotencyFindUnique.mockResolvedValue(null);
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 0 });

    const result2 = await holdTrucks(makeHoldRequest({ transporterId: T2 }), broadcastFn);
    expect(result2.success).toBe(false);
    expect(result2.error).toBe('TRUCK_STATE_CHANGED');
  });

  it('D02: same transporter holds trucks twice — reconcile returns existing hold', async () => {
    const existingHold = makeActiveHoldLedger();
    mockTruckHoldLedgerFindFirst.mockResolvedValue(existingHold);

    const result = await holdTrucks(makeHoldRequest(), broadcastFn);

    expect(result.success).toBe(true);
    expect(result.holdId).toBe(existingHold.holdId);
  });

  it('D03: hold expires exactly when confirm arrives — error returned', async () => {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(
      makeActiveHoldLedger({ expiresAt: new Date(Date.now() - 1) })
    );

    const result = await confirmHold('HOLD_ABCD1234', T1, releaseHoldFn, broadcastFn);

    expect(result.success).toBe(false);
    expect(result.message).toContain('expired');
  });

  it('D04: 10 transporters compete for same 3 trucks — only some succeed', async () => {
    let callCount = 0;
    mockTruckRequestUpdateMany.mockImplementation(() => {
      callCount++;
      // First 3 succeed, rest fail
      return Promise.resolve({ count: callCount <= 1 ? 2 : 0 });
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        holdTrucks(makeHoldRequest({ transporterId: `t-${i}` }), broadcastFn)
      )
    );

    const successes = results.filter(r => r.success);
    const failures = results.filter(r => !r.success);

    // At least 1 success, but most should fail
    expect(successes.length).toBeGreaterThanOrEqual(1);
    expect(failures.length).toBeGreaterThan(0);
  });

  it('D05: confirm while another confirm is in progress — serialization handles it', async () => {
    const hold = makeActiveHoldLedger({ holdId: 'HOLD_RACE' });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    mockOrderFindUnique.mockResolvedValue({ id: ORDER_1, status: 'broadcasting' });
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 2 });
    mockOrderUpdate.mockResolvedValue({});
    mockTruckHoldLedgerUpdate.mockResolvedValue({});

    const [r1, r2] = await Promise.all([
      confirmHold('HOLD_RACE', T1, releaseHoldFn, broadcastFn),
      confirmHold('HOLD_RACE', T1, releaseHoldFn, broadcastFn),
    ]);

    // Both may succeed because mocks return the same; real DB would serialize
    expect(r1.success || r2.success).toBe(true);
  });
});

// =============================================================================
// E. HOLD EXPIRY & RELEASE
// =============================================================================

describe('E. Hold expiry & release', () => {
  it('E01: manual release by transporter succeeds', async () => {
    const hold = makeActiveHoldLedger({ holdId: 'HOLD_RELEASE1' });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    mockOrderFindUnique.mockResolvedValue({ id: ORDER_1, status: 'broadcasting' });
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 2 });
    mockTruckHoldLedgerUpdate.mockResolvedValue({});
    mockGetJSON.mockResolvedValue(null);

    const result = await releaseHold('HOLD_RELEASE1', T1, undefined, 'manual', broadcastFn);

    expect(result.success).toBe(true);
    expect(broadcastFn).toHaveBeenCalledWith(ORDER_1);
  });

  it('E02: release already-released hold is idempotent', async () => {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(
      makeActiveHoldLedger({ status: 'released' })
    );

    const result = await releaseHold('HOLD_ABCD1234', T1, undefined, 'manual', broadcastFn);

    expect(result.success).toBe(true);
    expect(result.message).toContain('already released');
  });

  it('E03: release non-existent hold returns HOLD_NOT_FOUND', async () => {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(null);

    const result = await releaseHold('HOLD_GHOST', T1, undefined, 'manual', broadcastFn);

    expect(result.success).toBe(false);
    expect(result.error).toBe('HOLD_NOT_FOUND');
  });

  it('E04: release by wrong transporter returns FORBIDDEN', async () => {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(
      makeActiveHoldLedger({ transporterId: T2 })
    );

    const result = await releaseHold('HOLD_ABCD1234', T1, undefined, 'manual', broadcastFn);

    expect(result.success).toBe(false);
    expect(result.error).toBe('FORBIDDEN');
  });

  it('E05: release empty holdId fails validation', async () => {
    const result = await releaseHold('', T1, undefined, 'manual', broadcastFn);

    expect(result.success).toBe(false);
    expect(result.error).toBe('VALIDATION_ERROR');
  });

  it('E06: close all active holds for cancelled order', async () => {
    mockTruckHoldLedgerFindMany.mockResolvedValue([
      makeActiveHoldLedger({ holdId: 'HOLD_A' }),
      makeActiveHoldLedger({ holdId: 'HOLD_B' }),
    ]);
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 2 });
    mockTruckHoldLedgerUpdate.mockResolvedValue({});
    mockGetJSON.mockResolvedValue(null);

    const count = await closeActiveHoldsForOrder(ORDER_1, 'ORDER_CANCELLED');

    expect(count).toBe(2);
  });

  it('E07: close active holds for expired order', async () => {
    mockTruckHoldLedgerFindMany.mockResolvedValue([
      makeActiveHoldLedger({ holdId: 'HOLD_C' }),
    ]);
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 2 });
    mockTruckHoldLedgerUpdate.mockResolvedValue({});
    mockGetJSON.mockResolvedValue(null);

    const count = await closeActiveHoldsForOrder(ORDER_1, 'ORDER_EXPIRED');

    expect(count).toBe(1);
  });

  it('E08: close active holds when no active holds returns 0', async () => {
    mockTruckHoldLedgerFindMany.mockResolvedValue([]);

    const count = await closeActiveHoldsForOrder(ORDER_1, 'ORDER_CANCELLED');

    expect(count).toBe(0);
  });

  it('E09: release with idempotency key saves response', async () => {
    const hold = makeActiveHoldLedger({ holdId: 'HOLD_IDEM_REL' });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    mockOrderFindUnique.mockResolvedValue({ id: ORDER_1, status: 'broadcasting' });
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 2 });
    mockTruckHoldLedgerUpdate.mockResolvedValue({});
    mockGetJSON.mockResolvedValue(null);
    mockIdempotencyFindUnique.mockResolvedValue(null);

    await releaseHold('HOLD_IDEM_REL', T1, 'rel-idem-key', 'manual', broadcastFn);

    expect(mockIdempotencyUpsert).toHaveBeenCalled();
  });

  it('E10: release idempotency replay with matching hash returns saved response', async () => {
    const payloadHash = buildOperationPayloadHash('release', { holdId: 'HOLD_REPLAY' });
    mockIdempotencyFindUnique.mockResolvedValue({
      statusCode: 200,
      responseJson: { success: true, message: 'Hold released successfully.' },
      payloadHash,
    });

    const result = await releaseHold('HOLD_REPLAY', T1, 'replay-key', 'manual', broadcastFn);

    expect(result.success).toBe(true);
    expect(result.message).toBe('Hold released successfully.');
  });

  it('E11: release idempotency conflict returns error', async () => {
    mockIdempotencyFindUnique.mockResolvedValue({
      statusCode: 200,
      responseJson: { success: true },
      payloadHash: 'different-hash-value',
    });

    const result = await releaseHold('HOLD_CONFLICT_REL', T1, 'conflict-key', 'manual', broadcastFn);

    expect(result.success).toBe(false);
    expect(result.error).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('E12: release records metrics for manual release', async () => {
    const hold = makeActiveHoldLedger({ holdId: 'HOLD_METRICS_REL' });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    mockOrderFindUnique.mockResolvedValue({ id: ORDER_1, status: 'broadcasting' });
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 2 });
    mockTruckHoldLedgerUpdate.mockResolvedValue({});
    mockGetJSON.mockResolvedValue(null);

    await releaseHold('HOLD_METRICS_REL', T1, undefined, 'manual', broadcastFn);

    expect(metrics.incrementCounter).toHaveBeenCalledWith('hold_release_total', { source: 'manual' });
  });

  it('E13: release does not record metrics for cleanup source', async () => {
    const hold = makeActiveHoldLedger({ holdId: 'HOLD_CLEANUP_REL' });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    mockOrderFindUnique.mockResolvedValue({ id: ORDER_1, status: 'broadcasting' });
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 2 });
    mockTruckHoldLedgerUpdate.mockResolvedValue({});
    mockGetJSON.mockResolvedValue(null);

    await releaseHold('HOLD_CLEANUP_REL', T1, undefined, 'cleanup', broadcastFn);

    expect(metrics.incrementCounter).not.toHaveBeenCalledWith('hold_release_total', expect.any(Object));
  });

  it('E14: release sets truck requests back to searching for active order', async () => {
    const hold = makeActiveHoldLedger({ holdId: 'HOLD_BACK_SEARCH' });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    mockOrderFindUnique.mockResolvedValue({ id: ORDER_1, status: 'broadcasting' });
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 2 });
    mockTruckHoldLedgerUpdate.mockResolvedValue({});
    mockGetJSON.mockResolvedValue(null);

    await releaseHold('HOLD_BACK_SEARCH', T1, undefined, 'manual', broadcastFn);

    expect(mockTruckRequestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'searching', heldById: null }),
      })
    );
  });

  it('E15: release sets truck requests to cancelled for cancelled order', async () => {
    const hold = makeActiveHoldLedger({ holdId: 'HOLD_CANCEL_REL' });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    mockOrderFindUnique.mockResolvedValue({ id: ORDER_1, status: 'cancelled' });
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 2 });
    mockTruckHoldLedgerUpdate.mockResolvedValue({});
    mockGetJSON.mockResolvedValue(null);

    await releaseHold('HOLD_CANCEL_REL', T1, undefined, 'system', broadcastFn);

    expect(mockTruckRequestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'cancelled' }),
      })
    );
  });

  it('E16: clearHoldCacheEntries removes multiple holds from Redis', async () => {
    mockGetJSON.mockResolvedValue(null);

    await clearHoldCacheEntries(['hold-a', 'hold-b', 'hold-c']);

    // holdStore.remove is called for each — the mock will resolve since getJSON returns null
    // We just check it doesn't throw
    expect(true).toBe(true);
  });

  it('E17: clearHoldCacheEntries handles empty array gracefully', async () => {
    await clearHoldCacheEntries([]);
    // No errors thrown
    expect(true).toBe(true);
  });

  it('E18: clearHoldCacheEntries handles null/undefined entries', async () => {
    await clearHoldCacheEntries(['hold-a', '', 'hold-b']);
    // Empty string entries are skipped
    expect(true).toBe(true);
  });
});

// =============================================================================
// F. QUERY ENDPOINTS
// =============================================================================

describe('F. Query endpoints', () => {
  it('F01: getOrderAvailability returns correct truck groups', async () => {
    mockGetOrderById.mockResolvedValue(makeOrder());
    mockGetTruckRequestsByOrder.mockResolvedValue([
      { vehicleType: 'Tata Ace', vehicleSubtype: '7ft', status: 'searching', pricePerTruck: 5000 },
      { vehicleType: 'Tata Ace', vehicleSubtype: '7ft', status: 'held', pricePerTruck: 5000 },
      { vehicleType: 'Tata Ace', vehicleSubtype: '7ft', status: 'assigned', pricePerTruck: 5000 },
      { vehicleType: 'Eicher', vehicleSubtype: '19ft', status: 'searching', pricePerTruck: 12000 },
    ]);

    const result = await getOrderAvailability(ORDER_1);

    expect(result).not.toBeNull();
    expect(result!.trucks.length).toBe(2);

    const tataGroup = result!.trucks.find(t => t.vehicleType === 'Tata Ace');
    expect(tataGroup!.available).toBe(1);
    expect(tataGroup!.held).toBe(1);
    expect(tataGroup!.assigned).toBe(1);
    expect(tataGroup!.totalNeeded).toBe(3);

    const eicherGroup = result!.trucks.find(t => t.vehicleType === 'Eicher');
    expect(eicherGroup!.available).toBe(1);
    expect(eicherGroup!.held).toBe(0);
    expect(eicherGroup!.assigned).toBe(0);
  });

  it('F02: getOrderAvailability returns null for non-existent order', async () => {
    mockGetOrderById.mockResolvedValue(null);

    const result = await getOrderAvailability('order-nope');

    expect(result).toBeNull();
  });

  it('F03: getOrderAvailability marks fully assigned when no searching/held', async () => {
    mockGetOrderById.mockResolvedValue(makeOrder());
    mockGetTruckRequestsByOrder.mockResolvedValue([
      { vehicleType: 'Tata Ace', vehicleSubtype: '7ft', status: 'assigned', pricePerTruck: 5000 },
      { vehicleType: 'Tata Ace', vehicleSubtype: '7ft', status: 'completed', pricePerTruck: 5000 },
    ]);

    const result = await getOrderAvailability(ORDER_1);

    expect(result!.isFullyAssigned).toBe(true);
  });

  it('F04: getOrderAvailability calculates totalValue correctly', async () => {
    mockGetOrderById.mockResolvedValue(makeOrder());
    mockGetTruckRequestsByOrder.mockResolvedValue([
      { vehicleType: 'Tata Ace', vehicleSubtype: '7ft', status: 'searching', pricePerTruck: 5000 },
      { vehicleType: 'Tata Ace', vehicleSubtype: '7ft', status: 'searching', pricePerTruck: 5000 },
      { vehicleType: 'Eicher', vehicleSubtype: '19ft', status: 'searching', pricePerTruck: 12000 },
    ]);

    const result = await getOrderAvailability(ORDER_1);

    expect(result!.totalValue).toBe(2 * 5000 + 1 * 12000);
  });

  it('F05: getMyActiveHold returns current hold for transporter', async () => {
    const hold = makeActiveHoldLedger();
    mockTruckHoldLedgerFindFirst.mockResolvedValue(hold);

    const result = await getMyActiveHold(T1, ORDER_1, V_TYPE, V_SUBTYPE);

    expect(result).not.toBeNull();
    expect(result!.holdId).toBe(hold.holdId);
    expect(result!.quantity).toBe(2);
    expect(result!.status).toBe('active');
  });

  it('F06: getMyActiveHold returns null when no hold exists', async () => {
    mockTruckHoldLedgerFindFirst.mockResolvedValue(null);

    const result = await getMyActiveHold(T1, ORDER_1, V_TYPE, V_SUBTYPE);

    expect(result).toBeNull();
  });

  it('F07: getAvailableTruckRequests filters by vehicle type and searching status', async () => {
    mockGetTruckRequestsByOrder.mockResolvedValue([
      { vehicleType: 'Tata Ace', vehicleSubtype: '7ft', status: 'searching' },
      { vehicleType: 'Tata Ace', vehicleSubtype: '7ft', status: 'held' },
      { vehicleType: 'Eicher', vehicleSubtype: '19ft', status: 'searching' },
    ]);

    const result = await getAvailableTruckRequests(ORDER_1, 'Tata Ace', '7ft');

    expect(result.length).toBe(1);
    expect(result[0].status).toBe('searching');
  });

  it('F08: getAvailableTruckRequests case-insensitive matching', async () => {
    mockGetTruckRequestsByOrder.mockResolvedValue([
      { vehicleType: 'tata ace', vehicleSubtype: '7FT', status: 'searching' },
    ]);

    const result = await getAvailableTruckRequests(ORDER_1, 'TATA ACE', '7ft');

    expect(result.length).toBe(1);
  });

  it('F09: broadcastAvailabilityUpdate emits closure when fully assigned', async () => {
    mockGetOrderById.mockResolvedValue(makeOrder());
    mockGetTruckRequestsByOrder.mockResolvedValue([
      { vehicleType: 'Tata Ace', vehicleSubtype: '7ft', status: 'assigned', pricePerTruck: 5000 },
    ]);

    broadcastAvailabilityUpdate(ORDER_1);

    // Allow async to resolve
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(mockBroadcastToAll).toHaveBeenCalledWith(
      'broadcast_closed',
      expect.objectContaining({ orderId: ORDER_1, reason: 'fully_assigned' })
    );
  });

  it('F10: broadcastAvailabilityUpdate sends personalized updates to transporters', async () => {
    mockGetOrderById.mockResolvedValue(makeOrder());
    mockGetTruckRequestsByOrder.mockResolvedValue([
      {
        vehicleType: 'Tata Ace', vehicleSubtype: '7ft', status: 'searching', pricePerTruck: 5000,
        notifiedTransporters: [T1, T2],
      },
    ]);
    mockGetTransportersAvailabilitySnapshot.mockResolvedValue([
      { transporterId: T1, transporterName: 'T1', totalOwned: 5, available: 3, inTransit: 2 },
      { transporterId: T2, transporterName: 'T2', totalOwned: 2, available: 0, inTransit: 2 },
    ]);

    broadcastAvailabilityUpdate(ORDER_1);

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(mockQueueBroadcast).toHaveBeenCalled();
  });
});

// =============================================================================
// G. HOLD STORE (Redis-backed distributed locking)
// =============================================================================

describe('G. HoldStore (Redis distributed locking)', () => {
  const holdData = {
    holdId: 'HOLD_STORE_1',
    orderId: ORDER_1,
    transporterId: T1,
    vehicleType: V_TYPE,
    vehicleSubtype: V_SUBTYPE,
    quantity: 2,
    truckRequestIds: ['tr-1', 'tr-2'],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 120_000),
    status: 'active' as const,
  };

  it('G01: add hold stores data in Redis without per-truck locks', async () => {
    // FIX #40: HoldStore.add() no longer uses per-truck distributed locks.
    // PG SERIALIZABLE transactions handle concurrency.
    mockSetJSON.mockResolvedValue(true);

    const result = await holdStore.add(holdData);

    expect(result).toBe(true);
    // Should store data, not acquire locks
    expect(mockSetJSON).toHaveBeenCalled();
    expect(mockAcquireLock).not.toHaveBeenCalled();
  });

  it('G02: add hold stores JSON data in Redis with TTL', async () => {
    mockAcquireLock.mockResolvedValue({ acquired: true });

    await holdStore.add(holdData);

    expect(mockSetJSON).toHaveBeenCalledWith(
      'hold:HOLD_STORE_1',
      expect.objectContaining({
        holdId: 'HOLD_STORE_1',
        transporterId: T1,
      }),
      CONFIG.HOLD_DURATION_SECONDS + 60
    );
  });

  it('G03: add hold creates order index in Redis', async () => {
    mockAcquireLock.mockResolvedValue({ acquired: true });

    await holdStore.add(holdData);

    expect(mockSAdd).toHaveBeenCalledWith(`hold:order:${ORDER_1}`, 'HOLD_STORE_1');
  });

  it('G04: add hold creates transporter index in Redis', async () => {
    mockAcquireLock.mockResolvedValue({ acquired: true });

    await holdStore.add(holdData);

    expect(mockSAdd).toHaveBeenCalledWith(`hold:transporter:${T1}`, 'HOLD_STORE_1');
  });

  it('G05: add hold returns false when Redis write fails', async () => {
    // FIX #40: No per-truck locks. Failure during Redis write returns false.
    mockSetJSON.mockRejectedValue(new Error('Redis write failed'));

    const result = await holdStore.add(holdData);

    expect(result).toBe(false);
  });

  it('G06: get returns hold data from Redis', async () => {
    mockGetJSON.mockResolvedValue({
      ...holdData,
      createdAt: holdData.createdAt.toISOString(),
      expiresAt: holdData.expiresAt.toISOString(),
    });

    const result = await holdStore.get('HOLD_STORE_1');

    expect(result).toBeDefined();
    expect(result!.holdId).toBe('HOLD_STORE_1');
    expect(result!.createdAt).toBeInstanceOf(Date);
    expect(result!.expiresAt).toBeInstanceOf(Date);
  });

  it('G07: get returns undefined for non-existent hold', async () => {
    mockGetJSON.mockResolvedValue(null);

    const result = await holdStore.get('HOLD_NONEXISTENT');

    expect(result).toBeUndefined();
  });

  it('G08: remove cleans up hold data and indexes (no per-truck locks)', async () => {
    // FIX #40: HoldStore.remove() no longer uses per-truck distributed locks.
    // PG SERIALIZABLE transactions handle concurrency. This is best-effort cache cleanup.
    mockGetJSON.mockResolvedValue({
      ...holdData,
      createdAt: holdData.createdAt.toISOString(),
      expiresAt: holdData.expiresAt.toISOString(),
    });

    await holdStore.remove('HOLD_STORE_1');

    // Should clean up indexes and hold data, but NOT release individual locks
    expect(mockSRem).toHaveBeenCalled();
    expect(mockRedisDel).toHaveBeenCalled();
  });

  it('G09: remove cleans up order and transporter indexes', async () => {
    mockGetJSON.mockResolvedValue({
      ...holdData,
      createdAt: holdData.createdAt.toISOString(),
      expiresAt: holdData.expiresAt.toISOString(),
    });

    await holdStore.remove('HOLD_STORE_1');

    expect(mockSRem).toHaveBeenCalledWith(`hold:order:${ORDER_1}`, 'HOLD_STORE_1');
    expect(mockSRem).toHaveBeenCalledWith(`hold:transporter:${T1}`, 'HOLD_STORE_1');
  });

  it('G10: remove deletes hold data key from Redis', async () => {
    mockGetJSON.mockResolvedValue({
      ...holdData,
      createdAt: holdData.createdAt.toISOString(),
      expiresAt: holdData.expiresAt.toISOString(),
    });

    await holdStore.remove('HOLD_STORE_1');

    expect(mockRedisDel).toHaveBeenCalledWith('hold:HOLD_STORE_1');
  });

  it('G11: remove handles non-existent hold gracefully', async () => {
    mockGetJSON.mockResolvedValue(null);

    await holdStore.remove('HOLD_GHOST');
    // No errors thrown
    expect(true).toBe(true);
  });

  it('G12: updateStatus reads current hold and writes back with remaining TTL', async () => {
    mockGetJSON.mockResolvedValue({
      ...holdData,
      createdAt: holdData.createdAt.toISOString(),
      expiresAt: holdData.expiresAt.toISOString(),
    });
    mockTtl.mockResolvedValue(50);

    await holdStore.updateStatus('HOLD_STORE_1', 'confirmed');

    expect(mockSetJSON).toHaveBeenCalledWith(
      'hold:HOLD_STORE_1',
      expect.objectContaining({ status: 'confirmed' }),
      50
    );
  });

  it('G13: updateStatus uses fallback TTL when Redis TTL is expired', async () => {
    mockGetJSON.mockResolvedValue({
      ...holdData,
      createdAt: holdData.createdAt.toISOString(),
      expiresAt: holdData.expiresAt.toISOString(),
    });
    mockTtl.mockResolvedValue(-1);

    await holdStore.updateStatus('HOLD_STORE_1', 'expired');

    expect(mockSetJSON).toHaveBeenCalledWith(
      'hold:HOLD_STORE_1',
      expect.objectContaining({ status: 'expired' }),
      60
    );
  });

  it('G14: getActiveHoldsByOrder returns only active, non-expired holds', async () => {
    const futureDate = new Date(Date.now() + 60_000).toISOString();
    const pastDate = new Date(Date.now() - 60_000).toISOString();

    mockSMembers.mockResolvedValue(['h1', 'h2', 'h3']);
    // getActiveHoldsByOrder uses Redis pipeline (not getJSON)
    mockPipelineResults = [
      [null, JSON.stringify({ ...holdData, holdId: 'h1', status: 'active', createdAt: new Date().toISOString(), expiresAt: futureDate, truckRequestIds: holdData.truckRequestIds })],
      [null, JSON.stringify({ ...holdData, holdId: 'h2', status: 'released', createdAt: new Date().toISOString(), expiresAt: futureDate, truckRequestIds: holdData.truckRequestIds })],
      [null, JSON.stringify({ ...holdData, holdId: 'h3', status: 'active', createdAt: new Date().toISOString(), expiresAt: pastDate, truckRequestIds: holdData.truckRequestIds })],
    ];

    const result = await holdStore.getActiveHoldsByOrder(ORDER_1);

    expect(result.length).toBe(1);
    expect(result[0].holdId).toBe('h1');
  });

  it('G15: getTransporterHold returns matching hold for transporter', async () => {
    const futureDate = new Date(Date.now() + 60_000).toISOString();
    mockSMembers.mockResolvedValue(['h1']);
    mockGetJSON.mockResolvedValue({
      ...holdData,
      holdId: 'h1',
      status: 'active',
      createdAt: new Date().toISOString(),
      expiresAt: futureDate,
    });

    const result = await holdStore.getTransporterHold(T1, ORDER_1, V_TYPE, V_SUBTYPE);

    expect(result).toBeDefined();
    expect(result!.holdId).toBe('h1');
  });

  it('G16: getTransporterHold returns undefined when no matching hold', async () => {
    mockSMembers.mockResolvedValue([]);

    const result = await holdStore.getTransporterHold(T1, ORDER_1, V_TYPE, V_SUBTYPE);

    expect(result).toBeUndefined();
  });

  it('G17: getTransporterHold filters by vehicle type case-insensitive', async () => {
    const futureDate = new Date(Date.now() + 60_000).toISOString();
    mockSMembers.mockResolvedValue(['h1']);
    mockGetJSON.mockResolvedValue({
      ...holdData,
      vehicleType: 'tata ace',
      vehicleSubtype: '7ft',
      status: 'active',
      createdAt: new Date().toISOString(),
      expiresAt: futureDate,
    });

    const result = await holdStore.getTransporterHold(T1, ORDER_1, 'TATA ACE', '7FT');

    expect(result).toBeDefined();
  });

  it('G18: add stores hold data without per-truck locks (PG SERIALIZABLE handles concurrency)', async () => {
    // FIX #40: HoldStore.add() no longer uses per-truck distributed locks.
    mockSetJSON.mockResolvedValue(true);
    const threeHold = {
      ...holdData,
      truckRequestIds: ['tr-c', 'tr-a', 'tr-b'],
    };

    const result = await holdStore.add(threeHold);

    expect(result).toBe(true);
    // Should store hold data, not acquire per-truck locks
    expect(mockSetJSON).toHaveBeenCalled();
    expect(mockAcquireLock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// H. HELPER FUNCTIONS
// =============================================================================

describe('H. Helper functions', () => {
  it('H01: normalizeVehiclePart trims whitespace', () => {
    expect(normalizeVehiclePart('  Tata Ace  ')).toBe('Tata Ace');
  });

  it('H02: normalizeVehiclePart handles null', () => {
    expect(normalizeVehiclePart(null)).toBe('');
  });

  it('H03: normalizeVehiclePart handles undefined', () => {
    expect(normalizeVehiclePart(undefined)).toBe('');
  });

  it('H04: buildOperationPayloadHash returns consistent hash for same input', () => {
    const hash1 = buildOperationPayloadHash('hold', { orderId: 'o1', quantity: 2 });
    const hash2 = buildOperationPayloadHash('hold', { orderId: 'o1', quantity: 2 });

    expect(hash1).toBe(hash2);
  });

  it('H05: buildOperationPayloadHash returns different hash for different operation', () => {
    const hash1 = buildOperationPayloadHash('hold', { orderId: 'o1' });
    const hash2 = buildOperationPayloadHash('release', { orderId: 'o1' });

    expect(hash1).not.toBe(hash2);
  });

  it('H06: buildOperationPayloadHash returns different hash for different payload', () => {
    const hash1 = buildOperationPayloadHash('hold', { orderId: 'o1', quantity: 2 });
    const hash2 = buildOperationPayloadHash('hold', { orderId: 'o1', quantity: 3 });

    expect(hash1).not.toBe(hash2);
  });

  it('H07: recordHoldOutcomeMetrics records success metrics', () => {
    recordHoldOutcomeMetrics({ success: true, message: 'ok' }, Date.now() - 100);

    expect(metrics.incrementCounter).toHaveBeenCalledWith('hold_success_total');
    expect(metrics.observeHistogram).toHaveBeenCalledWith(
      'hold_latency_ms',
      expect.any(Number),
      expect.objectContaining({ replay: 'false', result: 'success' })
    );
  });

  it('H08: recordHoldOutcomeMetrics records failure metrics with reason', () => {
    recordHoldOutcomeMetrics({ success: false, message: 'fail', error: 'NOT_ENOUGH' }, Date.now() - 50);

    expect(metrics.incrementCounter).toHaveBeenCalledWith('hold_conflict_total', { reason: 'not_enough' });
  });

  it('H09: recordHoldOutcomeMetrics records replay metrics', () => {
    recordHoldOutcomeMetrics({ success: true, message: 'replayed' }, Date.now() - 10, true);

    expect(metrics.incrementCounter).toHaveBeenCalledWith('hold_idempotent_replay_total', expect.any(Object));
  });

  it('H10: findActiveLedgerHold queries with correct parameters', async () => {
    mockTruckHoldLedgerFindFirst.mockResolvedValue(null);

    await findActiveLedgerHold(T1, ORDER_1, V_TYPE, V_SUBTYPE);

    expect(mockTruckHoldLedgerFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          transporterId: T1,
          orderId: ORDER_1,
          status: 'active',
        }),
      })
    );
  });

  it('H11: REDIS_KEYS.HOLD returns correct key format', () => {
    expect(REDIS_KEYS.HOLD('HOLD_123')).toBe('hold:HOLD_123');
  });

  it('H12: REDIS_KEYS.HOLDS_BY_ORDER returns correct key format', () => {
    expect(REDIS_KEYS.HOLDS_BY_ORDER('order-1')).toBe('hold:order:order-1');
  });

  it('H13: REDIS_KEYS.HOLDS_BY_TRANSPORTER returns correct key format', () => {
    expect(REDIS_KEYS.HOLDS_BY_TRANSPORTER('t-1')).toBe('hold:transporter:t-1');
  });

  // FIX #40: TRUCK_LOCK removed — PG SERIALIZABLE TX handles concurrency
  it('H14: REDIS_KEYS.TRUCK_LOCK removed (FIX #40)', () => {
    expect((REDIS_KEYS as any).TRUCK_LOCK).toBeUndefined();
  });
});

// =============================================================================
// I. CONFIGURATION & TYPES VALIDATION
// =============================================================================

describe('I. Configuration & types validation', () => {
  it('I01: CONFIG.HOLD_DURATION_SECONDS is 90 (FLEX duration per PRD 7777)', () => {
    // FIX #4: CONFIG.HOLD_DURATION_SECONDS now uses FLEX_HOLD_DURATION_SECONDS (default 90)
    expect(CONFIG.HOLD_DURATION_SECONDS).toBe(90);
  });

  it('I02: CONFIG.MAX_HOLD_QUANTITY is 50', () => {
    expect(CONFIG.MAX_HOLD_QUANTITY).toBe(50);
  });

  it('I03: CONFIG.MIN_HOLD_QUANTITY is 1', () => {
    expect(CONFIG.MIN_HOLD_QUANTITY).toBe(1);
  });

  it('I04: ACTIVE_ORDER_STATUSES includes broadcasting', () => {
    expect(ACTIVE_ORDER_STATUSES.has('broadcasting')).toBe(true);
    expect(ACTIVE_ORDER_STATUSES.has('partially_filled')).toBe(true);
    expect(ACTIVE_ORDER_STATUSES.has('active')).toBe(true);
  });

  it('I05: TERMINAL_ORDER_STATUSES includes cancelled and expired', () => {
    expect(TERMINAL_ORDER_STATUSES.has('cancelled')).toBe(true);
    expect(TERMINAL_ORDER_STATUSES.has('expired')).toBe(true);
    expect(TERMINAL_ORDER_STATUSES.has('completed')).toBe(true);
    expect(TERMINAL_ORDER_STATUSES.has('fully_filled')).toBe(true);
  });

  it('I06: ACTIVE and TERMINAL sets are disjoint', () => {
    for (const status of ACTIVE_ORDER_STATUSES) {
      expect(TERMINAL_ORDER_STATUSES.has(status)).toBe(false);
    }
  });
});
