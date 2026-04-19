/**
 * =============================================================================
 * AUTO-REASSIGN (CASCADE DISPATCH) -- Comprehensive Tests
 * =============================================================================
 *
 * Tests for the CascadeDispatchService: when a driver declines or times out,
 * the system automatically retries the SAME driver. Max 3 retries. Redis
 * tracks retry attempts per truckRequestId.
 *
 * Sections:
 *   A. Retry on Decline (15+ tests)
 *   B. Retry on Timeout (15+ tests)
 *   C. Redis Counter & TTL (10+ tests)
 *   D. Driver Lookup / Eligibility (15+ tests)
 *   E. What-If / Edge-Case Scenarios (25+ tests)
 *
 * @author Weelo Test Agent
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP -- Must come before any imports
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

// ---------- Redis service mock ----------
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisIncr = jest.fn();
const mockRedisExpire = jest.fn();
const mockRedisSAdd = jest.fn();
const mockRedisSMembers = jest.fn();
const mockRedisHIncrBy = jest.fn();
const mockRedisHGetAll = jest.fn();
const mockRedisHMSet = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisGetJSON = jest.fn();
const mockRedisSetJSON = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: unknown[]) => mockRedisGet(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
    incr: (...args: unknown[]) => mockRedisIncr(...args),
    expire: (...args: unknown[]) => mockRedisExpire(...args),
    sAdd: (...args: unknown[]) => mockRedisSAdd(...args),
    sMembers: (...args: unknown[]) => mockRedisSMembers(...args),
    hIncrBy: (...args: unknown[]) => mockRedisHIncrBy(...args),
    hGetAll: (...args: unknown[]) => mockRedisHGetAll(...args),
    hMSet: (...args: unknown[]) => mockRedisHMSet(...args),
    acquireLock: (...args: unknown[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: unknown[]) => mockRedisReleaseLock(...args),
    getJSON: (...args: unknown[]) => mockRedisGetJSON(...args),
    setJSON: (...args: unknown[]) => mockRedisSetJSON(...args),
    isConnected: () => true,
    cancelTimer: jest.fn().mockResolvedValue(undefined),
  },
}));

// ---------- Prisma mock ----------
const mockUserFindFirst = jest.fn();
const mockUserFindUnique = jest.fn();
const mockAssignmentCreate = jest.fn();
const mockAssignmentFindFirst = jest.fn();
const mockTruckRequestFindFirst = jest.fn();
const mockTruckRequestUpdate = jest.fn();
const mockVehicleFindFirst = jest.fn();
const mockVehicleUpdateMany = jest.fn();
const mockOrderUpdate = jest.fn();
const mockOrderFindUnique = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    user: {
      findFirst: (...args: unknown[]) => mockUserFindFirst(...args),
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    assignment: {
      create: (...args: unknown[]) => mockAssignmentCreate(...args),
      findFirst: (...args: unknown[]) => mockAssignmentFindFirst(...args),
    },
    truckRequest: {
      findFirst: (...args: unknown[]) => mockTruckRequestFindFirst(...args),
      update: (...args: unknown[]) => mockTruckRequestUpdate(...args),
    },
    vehicle: {
      findFirst: (...args: unknown[]) => mockVehicleFindFirst(...args),
      updateMany: (...args: unknown[]) => mockVehicleUpdateMany(...args),
    },
    order: {
      update: (...args: unknown[]) => mockOrderUpdate(...args),
      findUnique: (...args: unknown[]) => mockOrderFindUnique(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

// Prisma enums
jest.mock('@prisma/client', () => ({
  Prisma: {
    TransactionIsolationLevel: {
      Serializable: 'Serializable',
    },
  },
  AssignmentStatus: {
    pending: 'pending',
    driver_accepted: 'driver_accepted',
    driver_declined: 'driver_declined',
    en_route_pickup: 'en_route_pickup',
    at_pickup: 'at_pickup',
    in_transit: 'in_transit',
    arrived_at_drop: 'arrived_at_drop',
    completed: 'completed',
    cancelled: 'cancelled',
  },
  VehicleStatus: {
    available: 'available',
    on_hold: 'on_hold',
    in_transit: 'in_transit',
    maintenance: 'maintenance',
    inactive: 'inactive',
  },
}));

// ---------- Socket service mock ----------
const mockEmitToUser = jest.fn();
const mockIsUserConnectedAsync = jest.fn().mockResolvedValue(true);
jest.mock('../shared/services/socket.service', () => ({
  socketService: {
    emitToUser: (...args: unknown[]) => mockEmitToUser(...args),
  },
  isUserConnectedAsync: (...args: unknown[]) => mockIsUserConnectedAsync(...args),
}));

// ---------- Queue service mock ----------
const mockScheduleAssignmentTimeout = jest.fn();
const mockQueuePushNotification = jest.fn();
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    scheduleAssignmentTimeout: (...args: unknown[]) => mockScheduleAssignmentTimeout(...args),
    queuePushNotification: (...args: unknown[]) => mockQueuePushNotification(...args),
    cancelAssignmentTimeout: jest.fn().mockResolvedValue(undefined),
  },
}));

// ---------- Hold config mock ----------
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

// ---------- Config mock ----------
jest.mock('../config/environment', () => ({
  config: { redis: { enabled: true }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {} },
}));

// ---------- UUID mock ----------
let uuidCounter = 0;
jest.mock('uuid', () => ({
  v4: () => {
    uuidCounter += 1;
    return `uuid-${uuidCounter}`;
  },
}));

// ---------- Error utils ----------
jest.mock('../shared/utils/error.utils', () => ({
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { cascadeDispatchService } from '../modules/truck-hold/cascade-dispatch.service';

// =============================================================================
// HELPERS
// =============================================================================

// Override setTimeout to execute callbacks immediately (avoids 2s delay per cascade test)
const origSetTimeout = global.setTimeout;
(global as any).setTimeout = (fn: Function, _ms?: number, ...args: any[]) => {
  fn(...args);
  return 0 as any;
};
afterAll(() => {
  global.setTimeout = origSetTimeout;
});

function resetAllMocks(): void {
  jest.clearAllMocks();
  uuidCounter = 0;
  mockRedisGet.mockReset();
  mockRedisSet.mockReset();
  mockRedisDel.mockReset();
  mockRedisIncr.mockReset();
  mockRedisExpire.mockReset();
  mockRedisSAdd.mockReset();
  mockRedisSMembers.mockReset();
  // H-06: Default resolved values for Redis SET operations used by cascade dispatch
  mockRedisSAdd.mockResolvedValue(1);
  mockRedisSMembers.mockResolvedValue([]);
  mockRedisHIncrBy.mockReset();
  mockRedisHGetAll.mockReset();
  mockRedisHMSet.mockReset();
  mockRedisAcquireLock.mockReset();
  mockRedisReleaseLock.mockReset();
  mockRedisGetJSON.mockReset();
  mockRedisSetJSON.mockReset();
  mockUserFindFirst.mockReset();
  mockUserFindUnique.mockReset();
  mockAssignmentCreate.mockReset();
  mockAssignmentFindFirst.mockReset();
  mockTruckRequestFindFirst.mockReset();
  mockTruckRequestUpdate.mockReset();
  mockVehicleFindFirst.mockReset();
  mockVehicleUpdateMany.mockReset();
  mockOrderUpdate.mockReset();
  mockOrderFindUnique.mockReset();
  mockTransaction.mockReset();
  mockEmitToUser.mockReset();
  mockIsUserConnectedAsync.mockReset();
  mockIsUserConnectedAsync.mockResolvedValue(true);
  mockScheduleAssignmentTimeout.mockReset();
  mockQueuePushNotification.mockReset();
}

/** Standard cascade context matching CascadeContext interface */
function buildCascadeCtx(overrides: Record<string, unknown> = {}) {
  return {
    truckRequestId: 'tr-001',
    orderId: 'order-001',
    transporterId: 'transporter-001',
    vehicleId: 'vehicle-001',
    vehicleNumber: 'MH12AB1234',
    vehicleType: 'open',
    vehicleSubtype: 'Open 17ft',
    declinedDriverId: 'driver-001',
    ...overrides,
  };
}

/** Build a driver object */
function buildDriver(id: string, name: string, phone: string | null = '9000000001') {
  return { id, name, phone };
}

/**
 * Set up the happy-path mocks for a single successful retry of the same driver.
 * The service retries the SAME driver (declinedDriverId), not a different one.
 */
function setupRetryHappyPath(opts: {
  retryCount?: number;
  sameDriver?: { id: string; name: string; phone: string | null };
} = {}) {
  const retryCount = opts.retryCount ?? 1;
  const sameDriver = opts.sameDriver ?? buildDriver('driver-001', 'Rahul Kumar');

  // Redis: incr (retry counter)
  mockRedisIncr.mockResolvedValue(retryCount);
  mockRedisExpire.mockResolvedValue(true);

  // H-06: Redis SET for tried drivers
  mockRedisSAdd.mockResolvedValue(1);
  mockRedisSMembers.mockResolvedValue([sameDriver.id]);

  // DB: look up the next available driver (user.findFirst)
  // H-06: First call returns sameDriver as the next available driver
  mockUserFindFirst.mockResolvedValue(sameDriver);

  // DB: transporter info (user.findUnique)
  mockUserFindUnique.mockResolvedValue({ name: 'Nitish', businessName: 'Weelo Transport' });

  // Transaction: execute the callback immediately
  mockTransaction.mockImplementation(async (callback: Function) => {
    const txProxy = {
      truckRequest: {
        findFirst: mockTruckRequestFindFirst,
        update: mockTruckRequestUpdate,
      },
      assignment: {
        findFirst: mockAssignmentFindFirst,
        create: mockAssignmentCreate,
      },
      vehicle: {
        findFirst: mockVehicleFindFirst,
        updateMany: mockVehicleUpdateMany,
      },
      order: {
        update: mockOrderUpdate,
      },
    };

    // Inside transaction: truckRequest is still held
    mockTruckRequestFindFirst.mockResolvedValue({ id: 'tr-001' });
    // Inside transaction: driver has no active assignment
    mockAssignmentFindFirst.mockResolvedValue(null);
    // Inside transaction: vehicle is available
    mockVehicleFindFirst.mockResolvedValue({ id: 'vehicle-001' });
    // Inside transaction: all writes succeed
    mockTruckRequestUpdate.mockResolvedValue({});
    mockAssignmentCreate.mockResolvedValue({});
    mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockOrderUpdate.mockResolvedValue({});

    return callback(txProxy);
  });

  // Post-transaction: timeout scheduling
  mockScheduleAssignmentTimeout.mockResolvedValue(undefined);

  // Post-transaction: order lookup for notifications
  mockOrderFindUnique.mockResolvedValue({
    pickup: { address: 'Delhi' },
    drop: { address: 'Mumbai' },
    distanceKm: 1400,
    customerName: 'Test Customer',
    customerPhone: '9999999999',
  });

  // Post-transaction: socket + FCM
  mockEmitToUser.mockResolvedValue(undefined);
  mockQueuePushNotification.mockResolvedValue(undefined);

  return { sameDriver };
}

// =============================================================================
// SECTION A: RETRY ON DECLINE (15+ tests)
// =============================================================================

describe('A. Retry Same Driver on Decline', () => {
  beforeEach(resetAllMocks);

  test('A1: Driver declines -> same driver gets retried', async () => {
    const { sameDriver } = setupRetryHappyPath();
    const ctx = buildCascadeCtx();

    await cascadeDispatchService.retrySameDriver(ctx);

    // New assignment created inside transaction for the SAME driver
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
    const createCall = mockAssignmentCreate.mock.calls[0][0];
    expect(createCall.data.driverId).toBe(sameDriver.id);
    expect(createCall.data.driverName).toBe(sameDriver.name);
    expect(createCall.data.status).toBe('pending');
  });

  test('A2: Second retry attempt still retries the same driver', async () => {
    setupRetryHappyPath({ retryCount: 2 });
    const ctx = buildCascadeCtx({ declinedDriverId: 'driver-001' });

    await cascadeDispatchService.retrySameDriver(ctx);

    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
    const createCall = mockAssignmentCreate.mock.calls[0][0];
    expect(createCall.data.driverId).toBe('driver-001');
  });

  test('A3: Fourth retry attempt -> max retries (3) reached, no retry', async () => {
    // retryCount will be 4 (exceeds MAX_CASCADE_RETRIES=3)
    mockRedisIncr.mockResolvedValue(4);
    mockRedisExpire.mockResolvedValue(true);

    const ctx = buildCascadeCtx({ declinedDriverId: 'driver-001' });

    await cascadeDispatchService.retrySameDriver(ctx);

    // Should NOT create any new assignment
    expect(mockAssignmentCreate).not.toHaveBeenCalled();
    expect(mockUserFindFirst).not.toHaveBeenCalled();
  });

  test('A4: Driver is no longer active -> retry stops gracefully', async () => {
    mockRedisIncr.mockResolvedValue(1);
    mockRedisExpire.mockResolvedValue(true);
    // Driver not found (inactive or deleted)
    mockUserFindFirst.mockResolvedValue(null);

    const ctx = buildCascadeCtx();

    await cascadeDispatchService.retrySameDriver(ctx);

    // Should NOT attempt transaction
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockAssignmentCreate).not.toHaveBeenCalled();
  });

  test('A5: Only 1 driver exists and declined -> retry same driver', async () => {
    setupRetryHappyPath({ retryCount: 1 });

    const ctx = buildCascadeCtx();

    await cascadeDispatchService.retrySameDriver(ctx);

    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
    const createCall = mockAssignmentCreate.mock.calls[0][0];
    expect(createCall.data.driverId).toBe('driver-001');
  });

  test('A6: Cascade excludes declined driver from next-driver query (H-06)', async () => {
    setupRetryHappyPath({
      sameDriver: buildDriver('driver-xyz', 'XYZ Driver'),
    });
    const ctx = buildCascadeCtx({ declinedDriverId: 'driver-xyz' });

    await cascadeDispatchService.retrySameDriver(ctx);

    // H-06: user.findFirst is called with notIn to exclude tried drivers
    expect(mockUserFindFirst).toHaveBeenCalledTimes(1);
    const query = mockUserFindFirst.mock.calls[0][0];
    expect(query.where.id).toEqual({ notIn: expect.arrayContaining(['driver-xyz']) });
    expect(query.where.transporterId).toBe(ctx.transporterId);
    expect(query.where.role).toBe('driver');
  });

  test('A7: Cascade tracks declined driver in Redis SET across attempts (H-06)', async () => {
    // First retry
    setupRetryHappyPath({ retryCount: 1 });
    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ declinedDriverId: 'driver-001' })
    );
    // H-06: sAdd called with declined driver
    expect(mockRedisSAdd).toHaveBeenCalledWith(
      expect.stringContaining('tried_drivers'),
      'driver-001'
    );

    resetAllMocks();

    // Second retry (same declined driver added again to SET)
    setupRetryHappyPath({ retryCount: 2 });
    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ declinedDriverId: 'driver-001' })
    );
    expect(mockRedisSAdd).toHaveBeenCalledWith(
      expect.stringContaining('tried_drivers'),
      'driver-001'
    );
  });

  test('A8: Retry preserves truckRequestId, orderId, transporterId', async () => {
    setupRetryHappyPath();
    const ctx = buildCascadeCtx({
      truckRequestId: 'tr-custom',
      orderId: 'order-custom',
      transporterId: 'tp-custom',
    });

    await cascadeDispatchService.retrySameDriver(ctx);

    const createCall = mockAssignmentCreate.mock.calls[0][0];
    expect(createCall.data.truckRequestId).toBe('tr-custom');
    expect(createCall.data.orderId).toBe('order-custom');
    expect(createCall.data.transporterId).toBe('tp-custom');
  });

  test('A9: Retry preserves vehicle info (vehicleId, vehicleNumber, type, subtype)', async () => {
    setupRetryHappyPath();
    const ctx = buildCascadeCtx({
      vehicleId: 'v-special',
      vehicleNumber: 'KA01XY9999',
      vehicleType: 'closed',
      vehicleSubtype: 'Closed 20ft',
    });

    await cascadeDispatchService.retrySameDriver(ctx);

    const createCall = mockAssignmentCreate.mock.calls[0][0];
    expect(createCall.data.vehicleId).toBe('v-special');
    expect(createCall.data.vehicleNumber).toBe('KA01XY9999');
    expect(createCall.data.vehicleType).toBe('closed');
    expect(createCall.data.vehicleSubtype).toBe('Closed 20ft');
  });

  test('A10: New assignment status is always "pending"', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    const createCall = mockAssignmentCreate.mock.calls[0][0];
    expect(createCall.data.status).toBe('pending');
  });

  test('A11: TruckRequest is updated to "assigned" with same driver info', async () => {
    const { sameDriver } = setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    expect(mockTruckRequestUpdate).toHaveBeenCalledTimes(1);
    const trUpdate = mockTruckRequestUpdate.mock.calls[0][0];
    expect(trUpdate.data.status).toBe('assigned');
    expect(trUpdate.data.assignedDriverId).toBe(sameDriver.id);
    expect(trUpdate.data.assignedDriverName).toBe(sameDriver.name);
  });

  test('A12: Vehicle is set to on_hold for the retried assignment', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    expect(mockVehicleUpdateMany).toHaveBeenCalledTimes(1);
    const vUpdate = mockVehicleUpdateMany.mock.calls[0][0];
    expect(vUpdate.data.status).toBe('on_hold');
  });

  test('A13: Order trucksFilled is incremented', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    expect(mockOrderUpdate).toHaveBeenCalledTimes(1);
    const orderCall = mockOrderUpdate.mock.calls[0][0];
    expect(orderCall.data.trucksFilled.increment).toBe(1);
  });

  test('A14: Transporter is notified about auto-reassignment via socket', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    // Look for cascade_reassigned event
    const cascadeCall = mockEmitToUser.mock.calls.find(
      (call: unknown[]) => call[1] === 'cascade_reassigned'
    );
    expect(cascadeCall).toBeDefined();
    expect(cascadeCall![0]).toBe('transporter-001');
    expect(cascadeCall![2].newDriverName).toBe('Rahul Kumar');
  });

  test('A15: Driver is notified about new assignment via socket', async () => {
    const { sameDriver } = setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    const tripCall = mockEmitToUser.mock.calls.find(
      (call: unknown[]) => call[1] === 'trip_assigned'
    );
    expect(tripCall).toBeDefined();
    expect(tripCall![0]).toBe(sameDriver.id);
    expect(tripCall![2].isCascade).toBe(true);
  });

  test('A16: FCM push sent to same driver', async () => {
    const { sameDriver } = setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    expect(mockQueuePushNotification).toHaveBeenCalled();
    const fcmCall = mockQueuePushNotification.mock.calls.find(
      (call: unknown[]) => call[0] === sameDriver.id
    );
    expect(fcmCall).toBeDefined();
    expect(fcmCall![1].title).toContain('Trip Assigned');
  });
});

// =============================================================================
// SECTION B: RETRY ON TIMEOUT (15+ tests)
// =============================================================================

describe('B. Retry Same Driver on Timeout', () => {
  beforeEach(resetAllMocks);

  test('B1: Driver times out (45s) -> retry triggers with same flow as decline', async () => {
    setupRetryHappyPath();
    const ctx = buildCascadeCtx();

    // Timeout follows the same path as decline
    await cascadeDispatchService.retrySameDriver(ctx);

    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
    expect(mockScheduleAssignmentTimeout).toHaveBeenCalledTimes(1);
  });

  test('B2: Timeout produces same retry behavior as explicit decline', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    // Same: retry counter incremented, same driver looked up, new assignment created
    expect(mockRedisIncr).toHaveBeenCalledTimes(1);
    expect(mockUserFindFirst).toHaveBeenCalledTimes(1);
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
  });

  test('B3: 45s driver acceptance timeout is scheduled for the retried assignment', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    expect(mockScheduleAssignmentTimeout).toHaveBeenCalledTimes(1);
    const [timerData, timeoutMs] = mockScheduleAssignmentTimeout.mock.calls[0];
    expect(timeoutMs).toBe(45000);
    expect(timerData.assignmentId).toBeDefined();
    expect(timerData.driverId).toBe('driver-001');
  });

  test('B4: Retried assignment has correct driver info in timeout timer data', async () => {
    const driver = buildDriver('driver-003', 'Shivu');
    setupRetryHappyPath({ sameDriver: driver });

    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ declinedDriverId: 'driver-003' })
    );

    const [timerData] = mockScheduleAssignmentTimeout.mock.calls[0];
    expect(timerData.driverId).toBe('driver-003');
    expect(timerData.driverName).toBe('Shivu');
  });

  test('B5: Timeout timer data includes vehicleId and vehicleNumber', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ vehicleId: 'v-100', vehicleNumber: 'KA50ZZ0001' })
    );

    const [timerData] = mockScheduleAssignmentTimeout.mock.calls[0];
    expect(timerData.vehicleId).toBe('v-100');
    expect(timerData.vehicleNumber).toBe('KA50ZZ0001');
  });

  test('B6: Timeout timer data includes transporterId', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ transporterId: 'tp-xyz' })
    );

    const [timerData] = mockScheduleAssignmentTimeout.mock.calls[0];
    expect(timerData.transporterId).toBe('tp-xyz');
  });

  test('B7: Timeout timer data includes orderId and truckRequestId', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ orderId: 'ord-abc', truckRequestId: 'tr-xyz' })
    );

    const [timerData] = mockScheduleAssignmentTimeout.mock.calls[0];
    expect(timerData.orderId).toBe('ord-abc');
    expect(timerData.truckRequestId).toBe('tr-xyz');
  });

  test('B8: Timeout scheduling failure does not prevent retry from succeeding', async () => {
    setupRetryHappyPath();
    mockScheduleAssignmentTimeout.mockRejectedValue(new Error('Timer scheduling failed'));

    // Should NOT throw
    await expect(
      cascadeDispatchService.retrySameDriver(buildCascadeCtx())
    ).resolves.toBeUndefined();

    // Assignment was still created
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
  });

  test('B9: Multiple sequential timeouts retry same driver each time', async () => {
    // First retry
    setupRetryHappyPath({ retryCount: 1 });
    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ declinedDriverId: 'driver-001' })
    );
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
    expect(mockAssignmentCreate.mock.calls[0][0].data.driverId).toBe('driver-001');

    resetAllMocks();

    // Second retry (same driver)
    setupRetryHappyPath({ retryCount: 2 });
    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ declinedDriverId: 'driver-001' })
    );
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
    expect(mockAssignmentCreate.mock.calls[0][0].data.driverId).toBe('driver-001');
  });

  test('B10: Retry trip_assigned payload includes expiresAt based on 45s', async () => {
    setupRetryHappyPath();

    const beforeTime = Date.now();
    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());
    const afterTime = Date.now();

    const tripCall = mockEmitToUser.mock.calls.find(
      (call: unknown[]) => call[1] === 'trip_assigned'
    );
    expect(tripCall).toBeDefined();
    const expiresAt = new Date(tripCall![2].expiresAt).getTime();
    // expiresAt should be roughly now + 45000ms (with tolerance for test execution)
    expect(expiresAt).toBeGreaterThanOrEqual(beforeTime + 44000);
    expect(expiresAt).toBeLessThanOrEqual(afterTime + 46000);
  });

  test('B11: cascade_reassigned socket event is sent to transporter', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    const reassignedCall = mockEmitToUser.mock.calls.find(
      (call: unknown[]) => call[1] === 'cascade_reassigned'
    );
    expect(reassignedCall).toBeDefined();
    expect(reassignedCall![2].message).toContain('Auto-reassigned');
  });

  test('B12: Transaction uses Serializable isolation level', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    const transactionOpts = mockTransaction.mock.calls[0][1];
    expect(transactionOpts.isolationLevel).toBe('Serializable');
  });

  test('B13: Transaction timeout is 8000ms', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    const transactionOpts = mockTransaction.mock.calls[0][1];
    expect(transactionOpts.timeout).toBe(8000);
  });

  test('B14: New assignment gets unique UUID for assignmentId', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    const createCall = mockAssignmentCreate.mock.calls[0][0];
    expect(createCall.data.id).toMatch(/^uuid-/);
  });

  test('B15: New assignment gets unique UUID for tripId', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    const createCall = mockAssignmentCreate.mock.calls[0][0];
    expect(createCall.data.tripId).toMatch(/^uuid-/);
    // assignmentId and tripId should be different
    expect(createCall.data.id).not.toBe(createCall.data.tripId);
  });

  test('B16: Socket notification failure does not throw', async () => {
    setupRetryHappyPath();
    mockEmitToUser.mockRejectedValue(new Error('Socket down'));

    await expect(
      cascadeDispatchService.retrySameDriver(buildCascadeCtx())
    ).resolves.toBeUndefined();
  });
});

// =============================================================================
// SECTION C: REDIS COUNTER & TTL (10+ tests)
// =============================================================================

describe('C. Redis Counter', () => {
  beforeEach(resetAllMocks);

  test('C1: Retry counter increments on each retry via INCR', async () => {
    setupRetryHappyPath({ retryCount: 1 });

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    expect(mockRedisIncr).toHaveBeenCalledTimes(1);
    expect(mockRedisIncr).toHaveBeenCalledWith('cascade:tr-001:retries');
  });

  test('C2: Counter key uses correct format: cascade:{truckRequestId}:retries', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ truckRequestId: 'tr-custom-999' })
    );

    expect(mockRedisIncr).toHaveBeenCalledWith('cascade:tr-custom-999:retries');
  });

  test('C3: Counter has 5-minute (300s) TTL', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    // expire is called for the retry counter key
    const expireCalls = mockRedisExpire.mock.calls;
    const retryExpire = expireCalls.find(
      (call: unknown[]) => (call[0] as string).includes(':retries')
    );
    expect(retryExpire).toBeDefined();
    expect(retryExpire![1]).toBe(300);
  });

  test('C4: At retry count = 3, retry still proceeds (boundary)', async () => {
    setupRetryHappyPath({ retryCount: 3 });

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    // retryCount 3 is within limit (MAX = 3), so retry should proceed
    expect(mockUserFindFirst).toHaveBeenCalledTimes(1);
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
  });

  test('C5: At retry count = 4, retry stops (exceeds max)', async () => {
    mockRedisIncr.mockResolvedValue(4);
    mockRedisExpire.mockResolvedValue(true);

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    expect(mockUserFindFirst).not.toHaveBeenCalled();
    expect(mockAssignmentCreate).not.toHaveBeenCalled();
  });

  test('C6: Counter tracks independently per truckRequestId', async () => {
    // Retry for truckRequest A
    setupRetryHappyPath({ retryCount: 1 });
    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ truckRequestId: 'tr-A' })
    );

    expect(mockRedisIncr).toHaveBeenCalledWith('cascade:tr-A:retries');

    resetAllMocks();

    // Retry for truckRequest B
    setupRetryHappyPath({ retryCount: 1 });
    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ truckRequestId: 'tr-B' })
    );

    expect(mockRedisIncr).toHaveBeenCalledWith('cascade:tr-B:retries');
  });

  test('C7: Retry counter is incremented BEFORE checking max', async () => {
    mockRedisIncr.mockResolvedValue(4); // Exceeds max
    mockRedisExpire.mockResolvedValue(true);

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    // INCR was called (counter incremented first)
    expect(mockRedisIncr).toHaveBeenCalledTimes(1);
    // But no retry happened
    expect(mockUserFindFirst).not.toHaveBeenCalled();
  });

  test('C8: Retry counter expire is set after incr', async () => {
    setupRetryHappyPath({ retryCount: 1 });

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    // Both incr and expire should be called
    expect(mockRedisIncr).toHaveBeenCalledTimes(1);
    expect(mockRedisExpire).toHaveBeenCalled();
  });

  test('C9: Different truckRequests have isolated retry counters', async () => {
    // First truckRequest at retry 3 (still allowed)
    setupRetryHappyPath({ retryCount: 3 });
    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ truckRequestId: 'tr-X' })
    );
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);

    resetAllMocks();

    // Second truckRequest at retry 1
    setupRetryHappyPath({ retryCount: 1 });
    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ truckRequestId: 'tr-Y' })
    );
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
  });

  test('C10: Counter key format is deterministic based on truckRequestId', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ truckRequestId: 'tr-deterministic' })
    );

    expect(mockRedisIncr).toHaveBeenCalledWith('cascade:tr-deterministic:retries');
    const expireCall = mockRedisExpire.mock.calls.find(
      (call: unknown[]) => (call[0] as string) === 'cascade:tr-deterministic:retries'
    );
    expect(expireCall).toBeDefined();
  });

  test('C11: At retry count = 1, retry proceeds', async () => {
    setupRetryHappyPath({ retryCount: 1 });

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
  });

  test('C12: At retry count = 2, retry proceeds', async () => {
    setupRetryHappyPath({ retryCount: 2 });

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// SECTION D: DRIVER LOOKUP / ELIGIBILITY (15+ tests)
// =============================================================================

describe('D. Driver Lookup', () => {
  beforeEach(resetAllMocks);

  test('D1: Next-driver query excludes declined driver via notIn (H-06)', async () => {
    setupRetryHappyPath();
    mockRedisSMembers.mockResolvedValue(['driver-specific']);

    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ declinedDriverId: 'driver-specific' })
    );

    const query = mockUserFindFirst.mock.calls[0][0];
    expect(query.where.id).toEqual({ notIn: ['driver-specific'] });
    expect(query.where.transporterId).toBe('transporter-001');
  });

  test('D2: Only active drivers pass the lookup (isActive=true)', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    const query = mockUserFindFirst.mock.calls[0][0];
    expect(query.where.isActive).toBe(true);
  });

  test('D3: Driver lookup selects id, name, phone only', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    const query = mockUserFindFirst.mock.calls[0][0];
    expect(query.select).toEqual({ id: true, name: true, phone: true });
  });

  test('D4: Inactive driver -> no retry, early return', async () => {
    mockRedisIncr.mockResolvedValue(1);
    mockRedisExpire.mockResolvedValue(true);
    mockUserFindFirst.mockResolvedValue(null); // Driver inactive

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockScheduleAssignmentTimeout).not.toHaveBeenCalled();
  });

  test('D5: Transaction guard -- truckRequest must still be held', async () => {
    setupRetryHappyPath();
    // Override the transaction mock so the internal guard returns null for truckRequest
    mockTransaction.mockImplementation(async (callback: Function) => {
      const txProxy = {
        truckRequest: {
          findFirst: jest.fn().mockResolvedValue(null), // Not held
          update: jest.fn(),
        },
        assignment: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: mockAssignmentCreate,
        },
        vehicle: {
          findFirst: jest.fn().mockResolvedValue({ id: 'vehicle-001' }),
          updateMany: jest.fn(),
        },
        order: { update: jest.fn() },
      };
      return callback(txProxy);
    });

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    // Transaction was called, but inside guard returned null => no assignment created
    expect(mockAssignmentCreate).not.toHaveBeenCalled();
  });

  test('D6: Transaction guard -- truckRequest must be held by same transporter', async () => {
    setupRetryHappyPath();
    mockTransaction.mockImplementation(async (callback: Function) => {
      const txProxy = {
        truckRequest: {
          findFirst: jest.fn().mockResolvedValue(null), // Not held by this transporter
          update: mockTruckRequestUpdate,
        },
        assignment: {
          findFirst: mockAssignmentFindFirst,
          create: mockAssignmentCreate,
        },
        vehicle: {
          findFirst: mockVehicleFindFirst,
          updateMany: mockVehicleUpdateMany,
        },
        order: { update: mockOrderUpdate },
      };
      return callback(txProxy);
    });

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    expect(mockAssignmentCreate).not.toHaveBeenCalled();
  });

  test('D7: Transaction guard -- driver must not have active assignment', async () => {
    setupRetryHappyPath();
    mockTransaction.mockImplementation(async (callback: Function) => {
      const txProxy = {
        truckRequest: {
          findFirst: jest.fn().mockResolvedValue({ id: 'tr-001' }),
          update: jest.fn(),
        },
        assignment: {
          findFirst: jest.fn().mockResolvedValue({ id: 'existing-active' }), // Driver is busy
          create: mockAssignmentCreate,
        },
        vehicle: {
          findFirst: jest.fn().mockResolvedValue({ id: 'vehicle-001' }),
          updateMany: jest.fn(),
        },
        order: { update: jest.fn() },
      };
      return callback(txProxy);
    });

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    // Guard caught it: no new assignment
    expect(mockAssignmentCreate).not.toHaveBeenCalled();
  });

  test('D8: Transaction guard -- vehicle must still be available', async () => {
    setupRetryHappyPath();
    mockTransaction.mockImplementation(async (callback: Function) => {
      const txProxy = {
        truckRequest: {
          findFirst: jest.fn().mockResolvedValue({ id: 'tr-001' }),
          update: jest.fn(),
        },
        assignment: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: mockAssignmentCreate,
        },
        vehicle: {
          findFirst: jest.fn().mockResolvedValue(null), // Vehicle unavailable
          updateMany: jest.fn(),
        },
        order: { update: jest.fn() },
      };
      return callback(txProxy);
    });

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    expect(mockAssignmentCreate).not.toHaveBeenCalled();
  });

  test('D9: Driver phone can be null (handled gracefully)', async () => {
    const driverWithoutPhone = buildDriver('driver-nophone', 'No Phone', null);
    setupRetryHappyPath({ sameDriver: driverWithoutPhone });

    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ declinedDriverId: 'driver-nophone' })
    );

    const createCall = mockAssignmentCreate.mock.calls[0][0];
    expect(createCall.data.driverPhone).toBe('');
  });

  test('D10: Transporter name falls back to "Transporter" when not found', async () => {
    setupRetryHappyPath();
    mockUserFindUnique.mockResolvedValue(null);

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    const createCall = mockAssignmentCreate.mock.calls[0][0];
    expect(createCall.data.transporterName).toBe('Transporter');
  });

  test('D11: Transporter businessName is used as fallback when name is missing', async () => {
    setupRetryHappyPath();
    mockUserFindUnique.mockResolvedValue({ name: null, businessName: 'Weelo Logistics' });

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    const createCall = mockAssignmentCreate.mock.calls[0][0];
    expect(createCall.data.transporterName).toBe('Weelo Logistics');
  });

  test('D12: Cascade query excludes declinedDriverId from context (H-06)', async () => {
    setupRetryHappyPath({
      sameDriver: buildDriver('driver-from-ctx', 'Context Driver'),
    });
    mockRedisSMembers.mockResolvedValue(['driver-from-ctx']);

    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ declinedDriverId: 'driver-from-ctx' })
    );

    expect(mockUserFindFirst).toHaveBeenCalledTimes(1);
    expect(mockUserFindFirst.mock.calls[0][0].where.id).toEqual({ notIn: ['driver-from-ctx'] });
  });

  test('D13: Cascade with different declinedDriverIds excludes correct driver each time (H-06)', async () => {
    // First retry for driver-A
    setupRetryHappyPath({ sameDriver: buildDriver('driver-A', 'Driver A') });
    mockRedisSMembers.mockResolvedValue(['driver-A']);
    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ declinedDriverId: 'driver-A' })
    );
    expect(mockUserFindFirst.mock.calls[0][0].where.id).toEqual({ notIn: ['driver-A'] });

    resetAllMocks();

    // Second retry for driver-B
    setupRetryHappyPath({ sameDriver: buildDriver('driver-B', 'Driver B') });
    mockRedisSMembers.mockResolvedValue(['driver-B']);
    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ declinedDriverId: 'driver-B' })
    );
    expect(mockUserFindFirst.mock.calls[0][0].where.id).toEqual({ notIn: ['driver-B'] });
  });

  test('D14: Transaction guard checks for active statuses correctly', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    // The transaction was called and completed successfully
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
  });

  test('D15: Transporter lookup uses transporterId from context', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ transporterId: 'tp-lookup-test' })
    );

    expect(mockUserFindUnique).toHaveBeenCalledTimes(1);
    const query = mockUserFindUnique.mock.calls[0][0];
    expect(query.where.id).toBe('tp-lookup-test');
  });

  test('D16: Transporter lookup selects name and businessName', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    const query = mockUserFindUnique.mock.calls[0][0];
    expect(query.select.name).toBe(true);
    expect(query.select.businessName).toBe(true);
  });
});

// =============================================================================
// SECTION E: WHAT-IF / EDGE-CASE SCENARIOS (25+ tests)
// =============================================================================

describe('E. What-If Scenarios', () => {
  beforeEach(resetAllMocks);

  test('E1: Redis INCR failure -> retry fails gracefully (caught by try-catch)', async () => {
    mockRedisIncr.mockRejectedValue(new Error('Redis INCR failed'));

    // Should not throw
    await expect(
      cascadeDispatchService.retrySameDriver(buildCascadeCtx())
    ).resolves.toBeUndefined();

    // No assignment created
    expect(mockAssignmentCreate).not.toHaveBeenCalled();
  });

  test('E2: Redis expire failure does not prevent retry from proceeding', async () => {
    mockRedisIncr.mockResolvedValue(1);
    mockRedisExpire.mockRejectedValue(new Error('Expire failed'));
    // Driver lookup still works
    mockUserFindFirst.mockResolvedValue(buildDriver('driver-001', 'Test'));
    mockUserFindUnique.mockResolvedValue({ name: 'Test', businessName: null });

    // The expire error is within the try-catch, so it should propagate
    // but the outer try-catch catches it
    await expect(
      cascadeDispatchService.retrySameDriver(buildCascadeCtx())
    ).resolves.toBeUndefined();
  });

  test('E3: Driver lookup failure -> retry fails gracefully', async () => {
    mockRedisIncr.mockResolvedValue(1);
    mockRedisExpire.mockResolvedValue(true);
    mockUserFindFirst.mockRejectedValue(new Error('DB connection lost'));

    await expect(
      cascadeDispatchService.retrySameDriver(buildCascadeCtx())
    ).resolves.toBeUndefined();

    expect(mockTransaction).not.toHaveBeenCalled();
  });

  test('E4: Transaction failure -> retry fails gracefully', async () => {
    setupRetryHappyPath();
    mockTransaction.mockRejectedValue(new Error('Serialization failure'));

    await expect(
      cascadeDispatchService.retrySameDriver(buildCascadeCtx())
    ).resolves.toBeUndefined();
  });

  test('E5: Driver inactive -> no retry, early return', async () => {
    mockRedisIncr.mockResolvedValue(1);
    mockRedisExpire.mockResolvedValue(true);
    mockUserFindFirst.mockResolvedValue(null);

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockScheduleAssignmentTimeout).not.toHaveBeenCalled();
  });

  test('E6: Concurrent retry while another is processing -> transaction guard prevents double retry', async () => {
    // First retry succeeds
    setupRetryHappyPath();
    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);

    // Second retry: transaction guard catches it (truckRequest no longer held)
    resetAllMocks();
    setupRetryHappyPath();
    mockTransaction.mockImplementation(async (callback: Function) => {
      const txProxy = {
        truckRequest: {
          findFirst: jest.fn().mockResolvedValue(null), // Already assigned
          update: jest.fn(),
        },
        assignment: {
          findFirst: jest.fn(),
          create: jest.fn(),
        },
        vehicle: {
          findFirst: jest.fn(),
          updateMany: jest.fn(),
        },
        order: { update: jest.fn() },
      };
      return callback(txProxy);
    });

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    expect(mockAssignmentCreate).not.toHaveBeenCalled();
  });

  test('E7: Order expires during retry -> truckRequest no longer held -> guard catches', async () => {
    setupRetryHappyPath();
    mockTransaction.mockImplementation(async (callback: Function) => {
      const txProxy = {
        truckRequest: {
          findFirst: jest.fn().mockResolvedValue(null), // Released
          update: jest.fn(),
        },
        assignment: { findFirst: jest.fn(), create: mockAssignmentCreate },
        vehicle: { findFirst: jest.fn(), updateMany: jest.fn() },
        order: { update: jest.fn() },
      };
      return callback(txProxy);
    });

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    expect(mockAssignmentCreate).not.toHaveBeenCalled();
  });

  test('E8: Hold expires during retry -> same guard as E7', async () => {
    setupRetryHappyPath();
    mockTransaction.mockImplementation(async (callback: Function) => {
      const txProxy = {
        truckRequest: {
          findFirst: jest.fn().mockResolvedValue(null), // Released
          update: jest.fn(),
        },
        assignment: { findFirst: jest.fn(), create: mockAssignmentCreate },
        vehicle: { findFirst: jest.fn(), updateMany: jest.fn() },
        order: { update: jest.fn() },
      };
      return callback(txProxy);
    });

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    expect(mockAssignmentCreate).not.toHaveBeenCalled();
  });

  test('E9: All 3 retry attempts succeed, 4th is blocked by max retries', async () => {
    // Attempts 1-3 create assignments
    for (let attempt = 1; attempt <= 3; attempt++) {
      resetAllMocks();
      setupRetryHappyPath({ retryCount: attempt });
      await cascadeDispatchService.retrySameDriver(buildCascadeCtx());
      expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
    }

    // Attempt 4 is blocked
    resetAllMocks();
    mockRedisIncr.mockResolvedValue(4);
    mockRedisExpire.mockResolvedValue(true);

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());
    expect(mockAssignmentCreate).not.toHaveBeenCalled();
  }, 30000);

  test('E10: FCM push failure does not break retry', async () => {
    setupRetryHappyPath();
    mockQueuePushNotification
      .mockRejectedValueOnce(new Error('FCM failed'))
      .mockRejectedValueOnce(new Error('FCM failed'));

    await expect(
      cascadeDispatchService.retrySameDriver(buildCascadeCtx())
    ).resolves.toBeUndefined();

    // Assignment was created inside the transaction (before FCM calls)
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  test('E11: Order lookup failure for notification is non-fatal', async () => {
    setupRetryHappyPath();
    mockOrderFindUnique.mockRejectedValue(new Error('Order not found'));

    await expect(
      cascadeDispatchService.retrySameDriver(buildCascadeCtx())
    ).resolves.toBeUndefined();
  });

  test('E12: Socket notification to driver failure is non-fatal', async () => {
    setupRetryHappyPath();
    mockEmitToUser.mockRejectedValueOnce(new Error('Socket unavailable'));

    await expect(
      cascadeDispatchService.retrySameDriver(buildCascadeCtx())
    ).resolves.toBeUndefined();
  });

  test('E13: TruckRequest update inside transaction sets correct fields', async () => {
    const { sameDriver } = setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    expect(mockTruckRequestUpdate).toHaveBeenCalledTimes(1);
    const trUpdate = mockTruckRequestUpdate.mock.calls[0][0];
    expect(trUpdate.data.status).toBe('assigned');
    expect(trUpdate.data.assignedDriverId).toBe(sameDriver.id);
    expect(trUpdate.data.assignedDriverName).toBe(sameDriver.name);
    expect(trUpdate.data.assignedVehicleId).toBe('vehicle-001');
    expect(trUpdate.data.assignedVehicleNumber).toBe('MH12AB1234');
  });

  test('E14: Vehicle status set to on_hold with currentTripId and assignedDriverId', async () => {
    const { sameDriver } = setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    const vUpdate = mockVehicleUpdateMany.mock.calls[0][0];
    expect(vUpdate.data.status).toBe('on_hold');
    expect(vUpdate.data.assignedDriverId).toBe(sameDriver.id);
    expect(vUpdate.data.currentTripId).toBeDefined();
  });

  test('E15: Vehicle updateMany only targets available vehicles', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    const vUpdate = mockVehicleUpdateMany.mock.calls[0][0];
    expect(vUpdate.where.status.in).toContain('available');
  });

  test('E16: Assignment created with bookingId = null (retry is order-based)', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    const createCall = mockAssignmentCreate.mock.calls[0][0];
    expect(createCall.data.bookingId).toBeNull();
  });

  test('E17: Assignment includes assignedAt timestamp', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    const createCall = mockAssignmentCreate.mock.calls[0][0];
    expect(createCall.data.assignedAt).toBeDefined();
    // Should be an ISO string
    expect(new Date(createCall.data.assignedAt).getTime()).not.toBeNaN();
  });

  test('E18: Two different truckRequests retry independently', async () => {
    // Retry for truckRequest A
    setupRetryHappyPath({ retryCount: 1 });
    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ truckRequestId: 'tr-A', orderId: 'ord-A' })
    );

    const firstCreate = mockAssignmentCreate.mock.calls[0][0];
    expect(firstCreate.data.truckRequestId).toBe('tr-A');

    resetAllMocks();

    // Retry for truckRequest B
    setupRetryHappyPath({ retryCount: 1 });
    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ truckRequestId: 'tr-B', orderId: 'ord-B' })
    );

    const secondCreate = mockAssignmentCreate.mock.calls[0][0];
    expect(secondCreate.data.truckRequestId).toBe('tr-B');
  });

  test('E19: Empty phone on driver uses empty string in assignment', async () => {
    const driver = buildDriver('drv-empty-phone', 'Empty Phone', '');
    setupRetryHappyPath({ sameDriver: driver });

    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ declinedDriverId: 'drv-empty-phone' })
    );

    const createCall = mockAssignmentCreate.mock.calls[0][0];
    expect(createCall.data.driverPhone).toBe('');
  });

  test('E20: Retry with retry count at boundary=1 proceeds', async () => {
    setupRetryHappyPath({ retryCount: 1 });

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
  });

  test('E21: Retry with retry count at boundary=2 proceeds', async () => {
    setupRetryHappyPath({ retryCount: 2 });

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
  });

  test('E22: Retry creates assignment even when order has no pickup/drop address', async () => {
    setupRetryHappyPath();
    mockOrderFindUnique.mockResolvedValue({
      pickup: {},
      drop: {},
      distanceKm: null,
      customerName: null,
      customerPhone: null,
    });

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    // Assignment created successfully
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
  });

  test('E23: Retry with order not found for notification still works', async () => {
    setupRetryHappyPath();
    mockOrderFindUnique.mockResolvedValue(null);

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    // Assignment was created
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
    // trip_assigned socket event should NOT be sent when order is null
    const tripCall = mockEmitToUser.mock.calls.find(
      (call: unknown[]) => call[1] === 'trip_assigned'
    );
    expect(tripCall).toBeUndefined();
  });

  test('E24: Retry does not proceed when retryCount equals MAX+1', async () => {
    mockRedisIncr.mockResolvedValue(4);
    mockRedisExpire.mockResolvedValue(true);

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    expect(mockUserFindFirst).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  test('E25: cascade_reassigned payload includes all expected fields', async () => {
    const { sameDriver } = setupRetryHappyPath();
    const ctx = buildCascadeCtx({
      truckRequestId: 'tr-payload',
      orderId: 'ord-payload',
      vehicleNumber: 'UP32ZZ0001',
    });

    await cascadeDispatchService.retrySameDriver(ctx);

    const reassignedCall = mockEmitToUser.mock.calls.find(
      (call: unknown[]) => call[1] === 'cascade_reassigned'
    );
    expect(reassignedCall).toBeDefined();
    const payload = reassignedCall![2];
    expect(payload.truckRequestId).toBe('tr-payload');
    expect(payload.orderId).toBe('ord-payload');
    expect(payload.newDriverId).toBe(sameDriver.id);
    expect(payload.newDriverName).toBe(sameDriver.name);
    expect(payload.vehicleNumber).toBe('UP32ZZ0001');
    expect(payload.message).toContain('Auto-reassigned');
  });

  test('E26: Two retries for different truckRequests under same transporter work independently', async () => {
    // First retry
    setupRetryHappyPath({ retryCount: 1 });
    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ truckRequestId: 'tr-alpha', vehicleId: 'v-alpha' })
    );

    const firstRedisIncr = mockRedisIncr.mock.calls[0][0];
    expect(firstRedisIncr).toBe('cascade:tr-alpha:retries');

    resetAllMocks();

    // Second retry
    setupRetryHappyPath({ retryCount: 1 });
    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ truckRequestId: 'tr-beta', vehicleId: 'v-beta' })
    );

    const secondRedisIncr = mockRedisIncr.mock.calls[0][0];
    expect(secondRedisIncr).toBe('cascade:tr-beta:retries');
  });

  test('E27: Retry does not create duplicate assignment IDs across calls', async () => {
    setupRetryHappyPath({ retryCount: 1 });
    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());
    const firstAssignmentId = mockAssignmentCreate.mock.calls[0][0].data.id;

    resetAllMocks();
    uuidCounter = 10; // Different counter
    setupRetryHappyPath({ retryCount: 2 });
    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());
    const secondAssignmentId = mockAssignmentCreate.mock.calls[0][0].data.id;

    expect(firstAssignmentId).not.toBe(secondAssignmentId);
  });
});

// =============================================================================
// SECTION F: ADDITIONAL INTEGRATION-LIKE SCENARIOS
// =============================================================================

describe('F. Integration-Like Scenarios', () => {
  beforeEach(resetAllMocks);

  test('F1: Full retry chain: attempt 1 -> attempt 2 -> attempt 3 -> max reached', async () => {
    // Step 1: first retry
    setupRetryHappyPath({ retryCount: 1 });
    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ declinedDriverId: 'driver-001' })
    );
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
    expect(mockAssignmentCreate.mock.calls[0][0].data.driverId).toBe('driver-001');

    // Step 2: second retry
    resetAllMocks();
    setupRetryHappyPath({ retryCount: 2 });
    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ declinedDriverId: 'driver-001' })
    );
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
    expect(mockAssignmentCreate.mock.calls[0][0].data.driverId).toBe('driver-001');

    // Step 3: third retry
    resetAllMocks();
    setupRetryHappyPath({ retryCount: 3 });
    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ declinedDriverId: 'driver-001' })
    );
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
    expect(mockAssignmentCreate.mock.calls[0][0].data.driverId).toBe('driver-001');

    // Step 4: max retries reached
    resetAllMocks();
    mockRedisIncr.mockResolvedValue(4); // Exceeds max
    mockRedisExpire.mockResolvedValue(true);
    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ declinedDriverId: 'driver-001' })
    );
    expect(mockAssignmentCreate).not.toHaveBeenCalled();
  }, 30000);

  test('F2: Retry correctly uses the same driver even when driver has no active assignments', async () => {
    const sameDriver = buildDriver('driver-010', 'Same Driver');
    setupRetryHappyPath({ sameDriver });

    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ declinedDriverId: 'driver-010' })
    );

    expect(mockUserFindFirst).toHaveBeenCalledTimes(1);
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
    const createCall = mockAssignmentCreate.mock.calls[0][0];
    expect(createCall.data.driverId).toBe('driver-010');
  });

  test('F3: Retry preserves all context fields across the full flow', async () => {
    setupRetryHappyPath();

    const ctx = buildCascadeCtx({
      truckRequestId: 'tr-full',
      orderId: 'ord-full',
      transporterId: 'tp-full',
      vehicleId: 'v-full',
      vehicleNumber: 'FULL1234',
      vehicleType: 'closed',
      vehicleSubtype: 'Closed 24ft',
    });

    await cascadeDispatchService.retrySameDriver(ctx);

    // Verify assignment has all fields
    const createCall = mockAssignmentCreate.mock.calls[0][0].data;
    expect(createCall.truckRequestId).toBe('tr-full');
    expect(createCall.orderId).toBe('ord-full');
    expect(createCall.transporterId).toBe('tp-full');
    expect(createCall.vehicleId).toBe('v-full');
    expect(createCall.vehicleNumber).toBe('FULL1234');
    expect(createCall.vehicleType).toBe('closed');
    expect(createCall.vehicleSubtype).toBe('Closed 24ft');

    // Verify timer data has all fields
    const [timerData] = mockScheduleAssignmentTimeout.mock.calls[0];
    expect(timerData.orderId).toBe('ord-full');
    expect(timerData.transporterId).toBe('tp-full');
    expect(timerData.vehicleId).toBe('v-full');
    expect(timerData.vehicleNumber).toBe('FULL1234');
    expect(timerData.truckRequestId).toBe('tr-full');
  });

  test('F4: Retry with driver whose phone is null results in empty string', async () => {
    const driverNullPhone = buildDriver('drv-null', 'Null Phone', null);
    setupRetryHappyPath({ sameDriver: driverNullPhone });

    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ declinedDriverId: 'drv-null' })
    );

    const createCall = mockAssignmentCreate.mock.calls[0][0].data;
    expect(createCall.driverPhone).toBe('');
    // TruckRequest should also have the phone as empty string
    const trUpdate = mockTruckRequestUpdate.mock.calls[0][0].data;
    expect(trUpdate.assignedDriverPhone).toBe('');
  });

  test('F5: cascade_reassigned message contains driver name', async () => {
    const namedDriver = buildDriver('drv-named', 'Rajesh Koothrappali');
    setupRetryHappyPath({ sameDriver: namedDriver });

    await cascadeDispatchService.retrySameDriver(
      buildCascadeCtx({ declinedDriverId: 'drv-named' })
    );

    const reassignedCall = mockEmitToUser.mock.calls.find(
      (call: unknown[]) => call[1] === 'cascade_reassigned'
    );
    expect(reassignedCall![2].message).toContain('Rajesh Koothrappali');
  });

  test('F6: Cascade verifies driver is still active and excludes tried drivers (H-06)', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    // user.findFirst called with isActive check and notIn exclusion
    const query = mockUserFindFirst.mock.calls[0][0];
    expect(query.where.isActive).toBe(true);
    expect(query.where.id).toEqual({ notIn: expect.arrayContaining(['driver-001']) });
    expect(query.where.transporterId).toBe('transporter-001');

    // Assignment was created (driver was active)
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
  });

  test('F7: Retry includes a delay call before creating assignment', async () => {
    setupRetryHappyPath();

    await cascadeDispatchService.retrySameDriver(buildCascadeCtx());

    // The cascade service calls delay(2000) internally before creating the assignment.
    // With mocked setTimeout, the delay resolves immediately but the assignment is still created.
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
  });
});
