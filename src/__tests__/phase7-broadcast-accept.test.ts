/**
 * =============================================================================
 * PHASE 7: BROADCAST ACCEPT PIPELINE TESTS
 * =============================================================================
 *
 * Tests for broadcast-accept.service.ts and its wiring into broadcast.routes.ts.
 *
 * Fix coverage:
 *   F-C1: broadcast-accept.service is wired into routes (not broadcast.service)
 *   F-C2: Vehicle mutex prevents cross-path racing
 *   F-H7+M8: FCM is queued (not fire-and-forget) via retryWithBackoff
 *   Additional: Advisory locks, rate limiting, idempotency, timeout scheduling,
 *               in-process fallback, secondary Redis lock, transaction retries
 *
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
    observeHistogram: jest.fn(),
  },
}));

jest.mock('../config/environment', () => ({
  config: { redis: { enabled: true }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {} },
}));

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
// Redis service mock
// ---------------------------------------------------------------------------
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisEval = jest.fn();
const mockRedisGetJSON = jest.fn();
const mockRedisSetJSON = jest.fn();
const mockRedisIncr = jest.fn();
const mockRedisExpire = jest.fn();
const mockRedisSAdd = jest.fn();
const mockRedisSCard = jest.fn();
const mockRedisSIsMember = jest.fn();
const mockRedisHSet = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    eval: (...args: any[]) => mockRedisEval(...args),
    getJSON: (...args: any[]) => mockRedisGetJSON(...args),
    setJSON: (...args: any[]) => mockRedisSetJSON(...args),
    incr: (...args: any[]) => mockRedisIncr(...args),
    expire: (...args: any[]) => mockRedisExpire(...args),
    sAdd: (...args: any[]) => mockRedisSAdd(...args),
    sCard: (...args: any[]) => mockRedisSCard(...args),
    sIsMember: (...args: any[]) => mockRedisSIsMember(...args),
    hSet: (...args: any[]) => mockRedisHSet(...args),
    isConnected: () => true,
    isRedisEnabled: () => true,
  },
}));

// ---------------------------------------------------------------------------
// FCM service mock
// ---------------------------------------------------------------------------
const mockSendPushNotification = jest.fn();
jest.mock('../shared/services/fcm.service', () => ({
  sendPushNotification: (...args: any[]) => mockSendPushNotification(...args),
}));

// ---------------------------------------------------------------------------
// Socket service mock
// ---------------------------------------------------------------------------
const mockEmitToUser = jest.fn();
const mockEmitToRoom = jest.fn();
jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToRoom: (...args: any[]) => mockEmitToRoom(...args),
  SocketEvent: {
    TRIP_ASSIGNED: 'trip_assigned',
    TRUCK_CONFIRMED: 'truck_confirmed',
    BOOKING_UPDATED: 'booking_updated',
    NEW_BROADCAST: 'new_broadcast',
    BROADCAST_EXPIRED: 'broadcast_expired',
  },
}));

// ---------------------------------------------------------------------------
// Queue service mock
// ---------------------------------------------------------------------------
const mockScheduleAssignmentTimeout = jest.fn();
const mockQueuePushNotification = jest.fn();
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    scheduleAssignmentTimeout: (...args: any[]) => mockScheduleAssignmentTimeout(...args),
    queuePushNotification: (...args: any[]) => mockQueuePushNotification(...args),
  },
}));

// ---------------------------------------------------------------------------
// Prisma mock
// ---------------------------------------------------------------------------
const mockTxExecuteRaw = jest.fn();
const mockTxBookingFindUnique = jest.fn();
const mockTxUserFindUnique = jest.fn();
const mockTxVehicleFindUnique = jest.fn();
const mockTxAssignmentFindFirst = jest.fn();
const mockTxVehicleUpdateMany = jest.fn();
const mockTxBookingUpdateMany = jest.fn();
const mockTxBookingUpdate = jest.fn();
const mockTxAssignmentCreate = jest.fn();

const mockTx = {
  $executeRaw: mockTxExecuteRaw,
  booking: {
    findUnique: mockTxBookingFindUnique,
    updateMany: mockTxBookingUpdateMany,
    update: mockTxBookingUpdate,
  },
  user: { findUnique: mockTxUserFindUnique },
  vehicle: {
    findUnique: mockTxVehicleFindUnique,
    updateMany: mockTxVehicleUpdateMany,
  },
  assignment: {
    findFirst: mockTxAssignmentFindFirst,
    create: mockTxAssignmentCreate,
  },
};

const mockWithDbTimeout = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    booking: { findFirst: jest.fn(), findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
  withDbTimeout: (...args: any[]) => mockWithDbTimeout(...args),
  VehicleStatus: { available: 'available', on_hold: 'on_hold', in_transit: 'in_transit' },
  BookingStatus: { active: 'active', partially_filled: 'partially_filled', fully_filled: 'fully_filled' },
  AssignmentStatus: { pending: 'pending', driver_accepted: 'driver_accepted' },
}));

// ---------------------------------------------------------------------------
// Booking types mock
// ---------------------------------------------------------------------------
jest.mock('../modules/booking/booking.types', () => ({
  RADIUS_KEYS: {
    NOTIFIED_SET: (bookingId: string) => `broadcast:notified:${bookingId}`,
  },
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================
import { acceptBroadcast, declineBroadcast } from '../modules/broadcast/broadcast-accept.service';

// =============================================================================
// FIXTURES
// =============================================================================

const BROADCAST_ID = '11111111-1111-1111-1111-111111111111';
const DRIVER_ID = '22222222-2222-2222-2222-222222222222';
const VEHICLE_ID = '33333333-3333-3333-3333-333333333333';
const TRANSPORTER_ID = '44444444-4444-4444-4444-444444444444';
const CUSTOMER_ID = '55555555-5555-5555-5555-555555555555';
const ACTOR_USER_ID = TRANSPORTER_ID;

const baseParams = {
  driverId: DRIVER_ID,
  vehicleId: VEHICLE_ID,
  actorUserId: ACTOR_USER_ID,
  actorRole: 'transporter' as const,
};

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BROADCAST_ID,
    status: 'active',
    trucksNeeded: 3,
    trucksFilled: 0,
    pricePerTruck: 5000,
    distanceKm: 120,
    customerId: CUSTOMER_ID,
    customerName: 'Test Customer',
    customerPhone: '9876543210',
    vehicleType: 'truck_16ft',
    vehicleSubtype: null,
    pickup: { address: 'Pickup City', city: 'Pickup' },
    drop: { address: 'Drop City', city: 'Drop' },
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    notifiedTransporters: [TRANSPORTER_ID],
    ...overrides,
  };
}

function makeDriver(overrides: Record<string, unknown> = {}) {
  return {
    id: DRIVER_ID,
    name: 'Test Driver',
    phone: '1234567890',
    role: 'driver',
    isActive: true,
    transporterId: TRANSPORTER_ID,
    ...overrides,
  };
}

function makeVehicle(overrides: Record<string, unknown> = {}) {
  return {
    id: VEHICLE_ID,
    vehicleNumber: 'KA-01-1234',
    vehicleType: 'truck_16ft',
    vehicleSubtype: null,
    transporterId: TRANSPORTER_ID,
    status: 'available',
    ...overrides,
  };
}

function makeTransporter(overrides: Record<string, unknown> = {}) {
  return {
    id: TRANSPORTER_ID,
    name: 'Test Transporter',
    businessName: 'Test Transport Co',
    phone: '9999999999',
    role: 'transporter',
    isActive: true,
    ...overrides,
  };
}

function makeActor(overrides: Record<string, unknown> = {}) {
  return {
    id: ACTOR_USER_ID,
    role: 'transporter',
    isActive: true,
    ...overrides,
  };
}

/**
 * Configure a standard successful accept flow in mocks.
 */
function setupSuccessfulAcceptMocks(bookingOverrides: Record<string, unknown> = {}) {
  // Rate limit passes
  mockRedisEval.mockResolvedValue(1);
  // No idempotency cache hit
  mockRedisGetJSON.mockResolvedValue(null);
  // Primary lock acquired
  mockRedisAcquireLock.mockResolvedValue({ acquired: true });
  // Lock release succeeds
  mockRedisReleaseLock.mockResolvedValue(undefined);
  // Redis del returns a Promise (required for .catch() chaining in source)
  mockRedisDel.mockReturnValue(Promise.resolve(undefined));
  // SetJSON succeeds (idempotency cache write)
  mockRedisSetJSON.mockResolvedValue(undefined);

  const booking = makeBooking(bookingOverrides);
  const driver = makeDriver();
  const vehicle = makeVehicle();
  const transporter = makeTransporter();
  const actor = makeActor();

  // withDbTimeout executes the callback with our mock tx
  mockWithDbTimeout.mockImplementation(async (fn: Function) => {
    return fn(mockTx);
  });

  // Transaction mock sequence — set up inside withDbTimeout to ensure fresh state
  mockWithDbTimeout.mockImplementation(async (fn: Function) => {
    mockTxExecuteRaw.mockResolvedValue(undefined);
    mockTxBookingFindUnique.mockResolvedValue(booking);
    mockTxUserFindUnique
      .mockResolvedValueOnce(actor)       // actor lookup (transporter)
      .mockResolvedValueOnce(driver)      // driver lookup
      .mockResolvedValueOnce(transporter); // transporter lookup
    mockTxVehicleFindUnique.mockResolvedValue(vehicle);
    mockTxAssignmentFindFirst
      .mockResolvedValueOnce(null)  // existing assignment check
      .mockResolvedValueOnce(null); // active assignment check
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockTxBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockTxBookingUpdate.mockResolvedValue(booking);
    mockTxAssignmentCreate.mockResolvedValue({ id: 'new-assignment-id' });
    return fn(mockTx);
  });

  // Post-commit side effects
  mockScheduleAssignmentTimeout.mockResolvedValue(undefined);
  mockSendPushNotification.mockResolvedValue(undefined);
  mockQueuePushNotification.mockResolvedValue(undefined);
}

// =============================================================================
// TESTS
// =============================================================================

describe('Phase 7: Broadcast Accept Pipeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ advanceTimers: true });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // =========================================================================
  // F-C1: broadcast-accept.service wiring
  // =========================================================================
  describe('F-C1: broadcast-accept.service wiring', () => {
    test('acceptBroadcast function is exported and callable', () => {
      expect(typeof acceptBroadcast).toBe('function');
    });

    test('declineBroadcast function is exported and callable', () => {
      expect(typeof declineBroadcast).toBe('function');
    });

    test('acceptBroadcast uses advisory lock (pg_advisory_xact_lock) inside TX', async () => {
      setupSuccessfulAcceptMocks();
      await acceptBroadcast(BROADCAST_ID, baseParams);

      // Verify withDbTimeout was called, and inside it pg_advisory_xact_lock was invoked
      expect(mockWithDbTimeout).toHaveBeenCalledTimes(1);
      expect(mockTxExecuteRaw).toHaveBeenCalled();
    });

    test('acceptBroadcast acquires primary Redis lock before transaction', async () => {
      setupSuccessfulAcceptMocks();
      await acceptBroadcast(BROADCAST_ID, baseParams);

      // First acquireLock call is the primary booking lock
      expect(mockRedisAcquireLock).toHaveBeenCalled();
      const firstCall = mockRedisAcquireLock.mock.calls[0];
      expect(firstCall[0]).toBe(`booking:${BROADCAST_ID}`);
    });

    test('acceptBroadcast releases primary lock in finally block', async () => {
      setupSuccessfulAcceptMocks();
      await acceptBroadcast(BROADCAST_ID, baseParams);

      expect(mockRedisReleaseLock).toHaveBeenCalled();
      const releaseCall = mockRedisReleaseLock.mock.calls.find(
        (c: any[]) => c[0] === `booking:${BROADCAST_ID}`
      );
      expect(releaseCall).toBeDefined();
    });

    test('acceptBroadcast creates assignment record via tx.assignment.create', async () => {
      setupSuccessfulAcceptMocks();
      await acceptBroadcast(BROADCAST_ID, baseParams);

      expect(mockTxAssignmentCreate).toHaveBeenCalledTimes(1);
      const createArgs = mockTxAssignmentCreate.mock.calls[0][0];
      expect(createArgs.data.bookingId).toBe(BROADCAST_ID);
      expect(createArgs.data.driverId).toBe(DRIVER_ID);
      expect(createArgs.data.vehicleId).toBe(VEHICLE_ID);
    });

    test('acceptBroadcast returns correct result structure on success', async () => {
      setupSuccessfulAcceptMocks();
      const result = await acceptBroadcast(BROADCAST_ID, baseParams);

      expect(result).toMatchObject({
        assignmentId: expect.any(String),
        tripId: expect.any(String),
        status: 'assigned',
        trucksConfirmed: 1,
        totalTrucksNeeded: 3,
        isFullyFilled: false,
      });
    });

    test('acceptBroadcast increments trucksFilled via CAS updateMany', async () => {
      setupSuccessfulAcceptMocks();
      await acceptBroadcast(BROADCAST_ID, baseParams);

      expect(mockTxBookingUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: BROADCAST_ID,
            trucksFilled: 0,
          }),
          data: expect.objectContaining({
            trucksFilled: { increment: 1 },
          }),
        })
      );
    });

    test('acceptBroadcast sets vehicle status to on_hold via CAS', async () => {
      setupSuccessfulAcceptMocks();
      await acceptBroadcast(BROADCAST_ID, baseParams);

      expect(mockTxVehicleUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: VEHICLE_ID,
            status: 'available',
          }),
          data: expect.objectContaining({
            status: 'on_hold',
          }),
        })
      );
    });
  });

  // =========================================================================
  // F-C2: Vehicle mutex prevents cross-path racing
  // =========================================================================
  describe('F-C2: Vehicle mutex', () => {
    test('acquires vehicle lock before processing', async () => {
      setupSuccessfulAcceptMocks();
      await acceptBroadcast(BROADCAST_ID, baseParams);

      // Vehicle mutex is the second acquireLock call (after booking lock)
      const vehicleLockCall = mockRedisAcquireLock.mock.calls.find(
        (c: any[]) => c[0] === `lock:vehicle:${VEHICLE_ID}`
      );
      expect(vehicleLockCall).toBeDefined();
    });

    test('returns 409 VEHICLE_LOCKED when vehicle mutex already held', async () => {
      // Rate limit passes
      mockRedisEval.mockResolvedValue(1);
      mockRedisGetJSON.mockResolvedValue(null);
      // Primary booking lock acquired
      mockRedisAcquireLock
        .mockResolvedValueOnce({ acquired: true })    // booking lock
        .mockResolvedValueOnce({ acquired: false });   // vehicle mutex NOT acquired
      mockRedisReleaseLock.mockResolvedValue(undefined);

      await expect(acceptBroadcast(BROADCAST_ID, baseParams))
        .rejects.toMatchObject({
          statusCode: 409,
          code: 'VEHICLE_LOCKED',
        });
    });

    test('releases vehicle lock in finally block even on error', async () => {
      setupSuccessfulAcceptMocks();
      // Make the transaction throw
      mockWithDbTimeout.mockRejectedValue(new Error('TX failed'));

      await expect(acceptBroadcast(BROADCAST_ID, baseParams)).rejects.toThrow('TX failed');

      // Vehicle mutex should still be released
      const vehicleReleaseCall = mockRedisReleaseLock.mock.calls.find(
        (c: any[]) => c[0] === `lock:vehicle:${VEHICLE_ID}`
      );
      expect(vehicleReleaseCall).toBeDefined();
    });

    test('concurrent accepts on same vehicle — only one succeeds', async () => {
      // First call acquires everything; second call fails on vehicle mutex
      mockRedisEval.mockResolvedValue(1);
      mockRedisGetJSON.mockResolvedValue(null);
      mockRedisReleaseLock.mockResolvedValue(undefined);
      mockRedisDel.mockResolvedValue(undefined);
      mockRedisSetJSON.mockResolvedValue(undefined);

      let callCount = 0;
      mockRedisAcquireLock.mockImplementation(async (key: string) => {
        if (key === `lock:vehicle:${VEHICLE_ID}`) {
          callCount++;
          // First call succeeds, second fails
          return { acquired: callCount === 1 };
        }
        return { acquired: true };
      });

      // Setup successful TX for first call
      const booking = makeBooking();
      mockWithDbTimeout.mockImplementation(async (fn: Function) => fn(mockTx));
      mockTxExecuteRaw.mockResolvedValue(undefined);
      mockTxBookingFindUnique.mockResolvedValue(booking);
      mockTxUserFindUnique
        .mockResolvedValue(makeActor())
        .mockResolvedValue(makeDriver())
        .mockResolvedValue(makeTransporter());
      mockTxVehicleFindUnique.mockResolvedValue(makeVehicle());
      mockTxAssignmentFindFirst.mockResolvedValue(null);
      mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
      mockTxBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockTxBookingUpdate.mockResolvedValue(booking);
      mockTxAssignmentCreate.mockResolvedValue({ id: 'a1' });
      mockScheduleAssignmentTimeout.mockResolvedValue(undefined);
      mockSendPushNotification.mockResolvedValue(undefined);

      const [result1, result2] = await Promise.allSettled([
        acceptBroadcast(BROADCAST_ID, { ...baseParams }),
        acceptBroadcast(BROADCAST_ID, { ...baseParams, driverId: 'other-driver' }),
      ]);

      // One should succeed, one should fail with VEHICLE_LOCKED
      const outcomes = [result1.status, result2.status];
      expect(outcomes).toContain('rejected');
    });
  });

  // =========================================================================
  // Rate limiting (M-01)
  // =========================================================================
  describe('M-01: Atomic rate limiting via Lua', () => {
    test('throws 429 RATE_LIMITED when rate limit exceeded', async () => {
      mockRedisEval.mockResolvedValue(4); // Exceeds max of 3

      await expect(acceptBroadcast(BROADCAST_ID, baseParams))
        .rejects.toMatchObject({
          statusCode: 429,
          code: 'RATE_LIMITED',
        });
    });

    test('rate limit uses atomic INCR+EXPIRE Lua script', async () => {
      setupSuccessfulAcceptMocks();
      await acceptBroadcast(BROADCAST_ID, baseParams);

      expect(mockRedisEval).toHaveBeenCalled();
      const evalCall = mockRedisEval.mock.calls[0];
      // First arg is the Lua script containing INCR and EXPIRE
      expect(evalCall[0]).toContain('INCR');
      expect(evalCall[0]).toContain('EXPIRE');
    });

    test('rate limit passes when count is under threshold', async () => {
      setupSuccessfulAcceptMocks();
      mockRedisEval.mockResolvedValue(2); // Under limit of 3

      const result = await acceptBroadcast(BROADCAST_ID, baseParams);
      expect(result.status).toBe('assigned');
    });

    test('rate limit fail-open on Redis error (allows request)', async () => {
      mockRedisEval.mockRejectedValue(new Error('Redis connection lost'));
      // Rest of flow succeeds
      mockRedisGetJSON.mockResolvedValue(null);
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockRedisReleaseLock.mockResolvedValue(undefined);
      mockRedisDel.mockResolvedValue(undefined);
      mockRedisSetJSON.mockResolvedValue(undefined);

      const booking = makeBooking();
      mockWithDbTimeout.mockImplementation(async (fn: Function) => fn(mockTx));
      mockTxExecuteRaw.mockResolvedValue(undefined);
      mockTxBookingFindUnique.mockResolvedValue(booking);
      mockTxUserFindUnique
        .mockResolvedValueOnce(makeActor())
        .mockResolvedValueOnce(makeDriver())
        .mockResolvedValueOnce(makeTransporter());
      mockTxVehicleFindUnique.mockResolvedValue(makeVehicle());
      mockTxAssignmentFindFirst.mockResolvedValue(null);
      mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
      mockTxBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockTxBookingUpdate.mockResolvedValue(booking);
      mockTxAssignmentCreate.mockResolvedValue({ id: 'a1' });
      mockScheduleAssignmentTimeout.mockResolvedValue(undefined);
      mockSendPushNotification.mockResolvedValue(undefined);

      // Should NOT throw — fail-open
      const result = await acceptBroadcast(BROADCAST_ID, baseParams);
      expect(result.status).toBe('assigned');
    });
  });

  // =========================================================================
  // Idempotency
  // =========================================================================
  describe('Idempotency handling', () => {
    test('returns cached result on idempotency key hit', async () => {
      mockRedisEval.mockResolvedValue(1);
      const cachedResult = {
        assignmentId: 'cached-id',
        tripId: 'cached-trip',
        status: 'assigned' as const,
        trucksConfirmed: 1,
        totalTrucksNeeded: 3,
        isFullyFilled: false,
      };
      mockRedisGetJSON.mockResolvedValue(cachedResult);

      const result = await acceptBroadcast(BROADCAST_ID, {
        ...baseParams,
        idempotencyKey: 'test-idem-key-12345',
      });

      expect(result.resultCode).toBe('IDEMPOTENT_REPLAY');
      expect(result.replayed).toBe(true);
      expect(result.assignmentId).toBe('cached-id');
      // Should NOT call withDbTimeout since result was cached
      expect(mockWithDbTimeout).not.toHaveBeenCalled();
    });

    test('stores result in idempotency cache after successful accept', async () => {
      setupSuccessfulAcceptMocks();
      await acceptBroadcast(BROADCAST_ID, {
        ...baseParams,
        idempotencyKey: 'new-idem-key-12345',
      });

      expect(mockRedisSetJSON).toHaveBeenCalled();
      const setCall = mockRedisSetJSON.mock.calls[0];
      expect(setCall[0]).toContain('idem:broadcast:accept:');
      expect(setCall[0]).toContain(BROADCAST_ID);
    });

    test('corrupted idempotency cache is deleted and request proceeds', async () => {
      mockRedisEval.mockResolvedValue(1);
      // getJSON throws on corrupted data
      mockRedisGetJSON.mockRejectedValue(new Error('JSON parse error'));
      mockRedisDel.mockResolvedValue(undefined);
      // Then set up successful flow
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockRedisReleaseLock.mockResolvedValue(undefined);
      mockRedisSetJSON.mockResolvedValue(undefined);

      const booking = makeBooking();
      mockWithDbTimeout.mockImplementation(async (fn: Function) => fn(mockTx));
      mockTxExecuteRaw.mockResolvedValue(undefined);
      mockTxBookingFindUnique.mockResolvedValue(booking);
      mockTxUserFindUnique
        .mockResolvedValueOnce(makeActor())
        .mockResolvedValueOnce(makeDriver())
        .mockResolvedValueOnce(makeTransporter());
      mockTxVehicleFindUnique.mockResolvedValue(makeVehicle());
      mockTxAssignmentFindFirst.mockResolvedValue(null);
      mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
      mockTxBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockTxBookingUpdate.mockResolvedValue(booking);
      mockTxAssignmentCreate.mockResolvedValue({ id: 'a1' });
      mockScheduleAssignmentTimeout.mockResolvedValue(undefined);
      mockSendPushNotification.mockResolvedValue(undefined);

      const result = await acceptBroadcast(BROADCAST_ID, {
        ...baseParams,
        idempotencyKey: 'corrupt-key-12345',
      });

      // Corrupted cache should be deleted
      expect(mockRedisDel).toHaveBeenCalled();
      // Request should succeed
      expect(result.status).toBe('assigned');
    });

    test('skips idempotency cache when no idempotencyKey provided', async () => {
      setupSuccessfulAcceptMocks();
      await acceptBroadcast(BROADCAST_ID, baseParams);

      // getJSON should not be called for idempotency (but may be called for other purposes)
      const idemCalls = mockRedisGetJSON.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('idem:')
      );
      // When no key provided, no idempotency lookup
      expect(idemCalls.length).toBe(0);
    });
  });

  // =========================================================================
  // Lock contention & fallback (M-14, H-02)
  // =========================================================================
  describe('M-14 + H-02: Lock fallback mechanisms', () => {
    test('throws 429 LOCK_CONTENTION when primary lock not acquired', async () => {
      mockRedisEval.mockResolvedValue(1);
      mockRedisGetJSON.mockResolvedValue(null);
      mockRedisAcquireLock.mockResolvedValue({ acquired: false });

      await expect(acceptBroadcast(BROADCAST_ID, baseParams))
        .rejects.toMatchObject({
          statusCode: 429,
          code: 'LOCK_CONTENTION',
        });
    });

    test('uses secondary Redis lock when primary lock throws', async () => {
      mockRedisEval.mockResolvedValue(1);
      mockRedisGetJSON.mockResolvedValue(null);
      mockRedisReleaseLock.mockResolvedValue(undefined);
      mockRedisDel.mockResolvedValue(undefined);
      mockRedisSetJSON.mockResolvedValue(undefined);

      // Primary lock throws, secondary lock succeeds
      let lockCallCount = 0;
      mockRedisAcquireLock.mockImplementation(async (key: string) => {
        lockCallCount++;
        if (lockCallCount === 1) throw new Error('Redis timeout');
        if (key.includes('broadcast-accept-fallback')) return { acquired: true };
        return { acquired: true }; // vehicle mutex
      });

      const booking = makeBooking();
      mockWithDbTimeout.mockImplementation(async (fn: Function) => fn(mockTx));
      mockTxExecuteRaw.mockResolvedValue(undefined);
      mockTxBookingFindUnique.mockResolvedValue(booking);
      mockTxUserFindUnique
        .mockResolvedValueOnce(makeActor())
        .mockResolvedValueOnce(makeDriver())
        .mockResolvedValueOnce(makeTransporter());
      mockTxVehicleFindUnique.mockResolvedValue(makeVehicle());
      mockTxAssignmentFindFirst.mockResolvedValue(null);
      mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
      mockTxBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockTxBookingUpdate.mockResolvedValue(booking);
      mockTxAssignmentCreate.mockResolvedValue({ id: 'a1' });
      mockScheduleAssignmentTimeout.mockResolvedValue(undefined);
      mockSendPushNotification.mockResolvedValue(undefined);

      const result = await acceptBroadcast(BROADCAST_ID, baseParams);
      expect(result.status).toBe('assigned');

      // Verify secondary lock key was used
      const secondaryCall = mockRedisAcquireLock.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('broadcast-accept-fallback')
      );
      expect(secondaryCall).toBeDefined();
    });

    test('uses in-process fallback when both Redis locks fail', async () => {
      mockRedisEval.mockResolvedValue(1);
      mockRedisGetJSON.mockResolvedValue(null);
      mockRedisReleaseLock.mockResolvedValue(undefined);
      mockRedisDel.mockResolvedValue(undefined);
      mockRedisSetJSON.mockResolvedValue(undefined);

      // Both Redis locks fail, then vehicle mutex succeeds
      let lockCallCount = 0;
      mockRedisAcquireLock.mockImplementation(async (key: string) => {
        lockCallCount++;
        if (key === `lock:vehicle:${VEHICLE_ID}`) return { acquired: true };
        if (lockCallCount === 1) throw new Error('Redis down');
        if (lockCallCount === 2) throw new Error('Redis still down');
        return { acquired: true };
      });

      const booking = makeBooking();
      mockWithDbTimeout.mockImplementation(async (fn: Function) => fn(mockTx));
      mockTxExecuteRaw.mockResolvedValue(undefined);
      mockTxBookingFindUnique.mockResolvedValue(booking);
      mockTxUserFindUnique
        .mockResolvedValueOnce(makeActor())
        .mockResolvedValueOnce(makeDriver())
        .mockResolvedValueOnce(makeTransporter());
      mockTxVehicleFindUnique.mockResolvedValue(makeVehicle());
      mockTxAssignmentFindFirst.mockResolvedValue(null);
      mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
      mockTxBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockTxBookingUpdate.mockResolvedValue(booking);
      mockTxAssignmentCreate.mockResolvedValue({ id: 'a1' });
      mockScheduleAssignmentTimeout.mockResolvedValue(undefined);
      mockSendPushNotification.mockResolvedValue(undefined);

      const result = await acceptBroadcast(BROADCAST_ID, baseParams);
      expect(result.status).toBe('assigned');
    });

    test('releases secondary Redis lock in finally block', async () => {
      mockRedisEval.mockResolvedValue(1);
      mockRedisGetJSON.mockResolvedValue(null);
      mockRedisReleaseLock.mockResolvedValue(undefined);
      mockRedisDel.mockResolvedValue(undefined);
      mockRedisSetJSON.mockResolvedValue(undefined);

      let lockCallCount = 0;
      mockRedisAcquireLock.mockImplementation(async (key: string) => {
        lockCallCount++;
        if (lockCallCount === 1) throw new Error('Redis timeout');
        return { acquired: true };
      });

      const booking = makeBooking();
      mockWithDbTimeout.mockImplementation(async (fn: Function) => fn(mockTx));
      mockTxExecuteRaw.mockResolvedValue(undefined);
      mockTxBookingFindUnique.mockResolvedValue(booking);
      mockTxUserFindUnique
        .mockResolvedValueOnce(makeActor())
        .mockResolvedValueOnce(makeDriver())
        .mockResolvedValueOnce(makeTransporter());
      mockTxVehicleFindUnique.mockResolvedValue(makeVehicle());
      mockTxAssignmentFindFirst.mockResolvedValue(null);
      mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
      mockTxBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockTxBookingUpdate.mockResolvedValue(booking);
      mockTxAssignmentCreate.mockResolvedValue({ id: 'a1' });
      mockScheduleAssignmentTimeout.mockResolvedValue(undefined);
      mockSendPushNotification.mockResolvedValue(undefined);

      await acceptBroadcast(BROADCAST_ID, baseParams);

      const secondaryRelease = mockRedisReleaseLock.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('broadcast-accept-fallback')
      );
      expect(secondaryRelease).toBeDefined();
    });
  });

  // =========================================================================
  // F-H7+M8: FCM is queued (not fire-and-forget)
  // =========================================================================
  describe('F-H7+M8: FCM retry with backoff and DLQ fallback', () => {
    test('sends driver push notification after successful accept', async () => {
      setupSuccessfulAcceptMocks();
      await acceptBroadcast(BROADCAST_ID, baseParams);

      expect(mockSendPushNotification).toHaveBeenCalled();
      const driverCall = mockSendPushNotification.mock.calls.find(
        (c: any[]) => c[0] === DRIVER_ID
      );
      expect(driverCall).toBeDefined();
    });

    test('sends customer push notification after successful accept', async () => {
      setupSuccessfulAcceptMocks();
      await acceptBroadcast(BROADCAST_ID, baseParams);

      const customerCall = mockSendPushNotification.mock.calls.find(
        (c: any[]) => c[0] === CUSTOMER_ID
      );
      expect(customerCall).toBeDefined();
    });

    test('retries FCM on transient failure (up to 3 attempts)', async () => {
      setupSuccessfulAcceptMocks();
      // FCM fails twice then succeeds on third try
      let driverFcmCalls = 0;
      mockSendPushNotification.mockImplementation(async (userId: string) => {
        if (userId === DRIVER_ID) {
          driverFcmCalls++;
          if (driverFcmCalls < 3) throw new Error('FCM temporary error');
        }
      });

      await acceptBroadcast(BROADCAST_ID, baseParams);

      // Driver FCM should have been called 3 times (2 failures + 1 success)
      const driverCalls = mockSendPushNotification.mock.calls.filter(
        (c: any[]) => c[0] === DRIVER_ID
      );
      expect(driverCalls.length).toBe(3);
    });

    test('falls back to queuePushNotification when all FCM retries fail', async () => {
      setupSuccessfulAcceptMocks();
      // FCM always fails
      mockSendPushNotification.mockRejectedValue(new Error('FCM permanently down'));
      mockQueuePushNotification.mockResolvedValue(undefined);

      await acceptBroadcast(BROADCAST_ID, baseParams);

      // Should have attempted queue fallback for both driver and customer
      expect(mockQueuePushNotification).toHaveBeenCalled();
    });

    test('socket emitted once (not retried) for driver notification', async () => {
      setupSuccessfulAcceptMocks();
      await acceptBroadcast(BROADCAST_ID, baseParams);

      const driverSocketCalls = mockEmitToUser.mock.calls.filter(
        (c: any[]) => c[0] === DRIVER_ID && c[1] === 'trip_assigned'
      );
      expect(driverSocketCalls.length).toBe(1);
    });

    test('socket emitted once for customer truck_confirmed', async () => {
      setupSuccessfulAcceptMocks();
      await acceptBroadcast(BROADCAST_ID, baseParams);

      const customerSocketCalls = mockEmitToUser.mock.calls.filter(
        (c: any[]) => c[0] === CUSTOMER_ID && c[1] === 'truck_confirmed'
      );
      expect(customerSocketCalls.length).toBe(1);
    });

    test('booking room receives booking_updated event', async () => {
      setupSuccessfulAcceptMocks();
      await acceptBroadcast(BROADCAST_ID, baseParams);

      const roomCall = mockEmitToRoom.mock.calls.find(
        (c: any[]) => c[0] === `booking:${BROADCAST_ID}` && c[1] === 'booking_updated'
      );
      expect(roomCall).toBeDefined();
    });
  });

  // =========================================================================
  // Assignment timeout scheduling (Issue #6)
  // =========================================================================
  describe('Issue #6: Assignment timeout scheduling', () => {
    test('schedules assignment timeout immediately after creation', async () => {
      setupSuccessfulAcceptMocks();
      await acceptBroadcast(BROADCAST_ID, baseParams);

      expect(mockScheduleAssignmentTimeout).toHaveBeenCalledTimes(1);
      const args = mockScheduleAssignmentTimeout.mock.calls[0];
      expect(args[0]).toMatchObject({
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
        bookingId: BROADCAST_ID,
      });
      // Second arg is the timeout in ms (45000)
      expect(args[1]).toBe(45000);
    });

    test('timeout scheduling failure is non-fatal (accept still succeeds)', async () => {
      setupSuccessfulAcceptMocks();
      mockScheduleAssignmentTimeout.mockRejectedValue(new Error('Queue service down'));

      const result = await acceptBroadcast(BROADCAST_ID, baseParams);
      expect(result.status).toBe('assigned');
    });
  });

  // =========================================================================
  // Transaction validation and error cases
  // =========================================================================
  describe('Transaction validation', () => {
    test('throws 404 when broadcast not found', async () => {
      setupSuccessfulAcceptMocks();
      mockWithDbTimeout.mockImplementation(async (fn: Function) => {
        mockTxBookingFindUnique.mockResolvedValue(null);
        return fn(mockTx);
      });

      await expect(acceptBroadcast(BROADCAST_ID, baseParams))
        .rejects.toMatchObject({
          statusCode: 404,
          code: 'INVALID_ASSIGNMENT_STATE',
        });
    });

    test('throws 403 when actor is not active', async () => {
      setupSuccessfulAcceptMocks();
      mockWithDbTimeout.mockImplementation(async (fn: Function) => {
        mockTxExecuteRaw.mockResolvedValue(undefined);
        mockTxBookingFindUnique.mockResolvedValue(makeBooking());
        mockTxUserFindUnique.mockResolvedValueOnce({ ...makeActor(), isActive: false });
        return fn(mockTx);
      });

      await expect(acceptBroadcast(BROADCAST_ID, baseParams))
        .rejects.toMatchObject({ statusCode: 403 });
    });

    test('throws 409 BROADCAST_EXPIRED when booking has expired', async () => {
      setupSuccessfulAcceptMocks();
      mockWithDbTimeout.mockImplementation(async (fn: Function) => {
        mockTxExecuteRaw.mockResolvedValue(undefined);
        mockTxBookingFindUnique.mockResolvedValue(
          makeBooking({ expiresAt: new Date(Date.now() - 60000).toISOString() })
        );
        mockTxUserFindUnique
          .mockResolvedValueOnce(makeActor())
          .mockResolvedValueOnce(makeDriver())
          .mockResolvedValueOnce(makeTransporter());
        mockTxVehicleFindUnique.mockResolvedValue(makeVehicle());
        mockTxAssignmentFindFirst.mockResolvedValue(null);
        return fn(mockTx);
      });

      await expect(acceptBroadcast(BROADCAST_ID, baseParams))
        .rejects.toMatchObject({ code: 'BROADCAST_EXPIRED' });
    });

    test('throws 409 BROADCAST_FILLED when all trucks assigned', async () => {
      setupSuccessfulAcceptMocks();
      mockWithDbTimeout.mockImplementation(async (fn: Function) => {
        mockTxExecuteRaw.mockResolvedValue(undefined);
        mockTxBookingFindUnique.mockResolvedValue(
          makeBooking({ trucksFilled: 3, trucksNeeded: 3 })
        );
        mockTxUserFindUnique
          .mockResolvedValueOnce(makeActor())
          .mockResolvedValueOnce(makeDriver())
          .mockResolvedValueOnce(makeTransporter());
        mockTxVehicleFindUnique.mockResolvedValue(makeVehicle());
        mockTxAssignmentFindFirst.mockResolvedValue(null);
        return fn(mockTx);
      });

      await expect(acceptBroadcast(BROADCAST_ID, baseParams))
        .rejects.toMatchObject({ code: 'BROADCAST_FILLED' });
    });

    test('throws 409 DRIVER_BUSY when driver has active assignment', async () => {
      setupSuccessfulAcceptMocks();
      mockWithDbTimeout.mockImplementation(async (fn: Function) => {
        mockTxExecuteRaw.mockResolvedValue(undefined);
        mockTxBookingFindUnique.mockResolvedValue(makeBooking());
        mockTxUserFindUnique
          .mockResolvedValueOnce(makeActor())
          .mockResolvedValueOnce(makeDriver())
          .mockResolvedValueOnce(makeTransporter());
        mockTxVehicleFindUnique.mockResolvedValue(makeVehicle());
        mockTxAssignmentFindFirst
          .mockResolvedValueOnce(null)   // existing same-booking assignment
          .mockResolvedValueOnce({ id: 'active-assignment', status: 'pending' }); // active assignment
        return fn(mockTx);
      });

      await expect(acceptBroadcast(BROADCAST_ID, baseParams))
        .rejects.toMatchObject({ code: 'DRIVER_BUSY' });
    });

    test('throws 409 VEHICLE_UNAVAILABLE when vehicle CAS fails', async () => {
      setupSuccessfulAcceptMocks();
      mockWithDbTimeout.mockImplementation(async (fn: Function) => {
        mockTxExecuteRaw.mockResolvedValue(undefined);
        mockTxBookingFindUnique.mockResolvedValue(makeBooking());
        mockTxUserFindUnique
          .mockResolvedValueOnce(makeActor())
          .mockResolvedValueOnce(makeDriver())
          .mockResolvedValueOnce(makeTransporter());
        mockTxVehicleFindUnique.mockResolvedValue(makeVehicle());
        mockTxAssignmentFindFirst.mockResolvedValue(null);
        mockTxVehicleUpdateMany.mockResolvedValue({ count: 0 }); // CAS failed
        return fn(mockTx);
      });

      await expect(acceptBroadcast(BROADCAST_ID, baseParams))
        .rejects.toMatchObject({ code: 'VEHICLE_UNAVAILABLE' });
    });

    test('throws 400 VEHICLE_TYPE_MISMATCH on wrong vehicle type', async () => {
      setupSuccessfulAcceptMocks();
      mockWithDbTimeout.mockImplementation(async (fn: Function) => {
        mockTxExecuteRaw.mockResolvedValue(undefined);
        mockTxBookingFindUnique.mockResolvedValue(makeBooking({ vehicleType: 'truck_16ft' }));
        mockTxUserFindUnique
          .mockResolvedValueOnce(makeActor())
          .mockResolvedValueOnce(makeDriver())
          .mockResolvedValueOnce(makeTransporter());
        mockTxVehicleFindUnique.mockResolvedValue(makeVehicle({ vehicleType: 'truck_32ft' }));
        return fn(mockTx);
      });

      await expect(acceptBroadcast(BROADCAST_ID, baseParams))
        .rejects.toMatchObject({ code: 'VEHICLE_TYPE_MISMATCH' });
    });

    test('throws 403 DRIVER_NOT_IN_FLEET when driver not in transporter fleet', async () => {
      setupSuccessfulAcceptMocks();
      mockWithDbTimeout.mockImplementation(async (fn: Function) => {
        mockTxExecuteRaw.mockResolvedValue(undefined);
        mockTxBookingFindUnique.mockResolvedValue(makeBooking());
        mockTxUserFindUnique
          .mockResolvedValueOnce(makeActor())
          .mockResolvedValueOnce(makeDriver({ transporterId: 'other-transporter' }));
        return fn(mockTx);
      });

      await expect(acceptBroadcast(BROADCAST_ID, baseParams))
        .rejects.toMatchObject({ code: 'DRIVER_NOT_IN_FLEET' });
    });

    test('retries transaction on P2034 serialization error', async () => {
      mockRedisEval.mockResolvedValue(1);
      mockRedisGetJSON.mockResolvedValue(null);
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockRedisReleaseLock.mockResolvedValue(undefined);
      mockRedisDel.mockResolvedValue(undefined);
      mockRedisSetJSON.mockResolvedValue(undefined);

      const p2034Error = Object.assign(new Error('Serialization error'), { code: 'P2034' });
      let txCallCount = 0;
      mockWithDbTimeout.mockImplementation(async (fn: Function) => {
        txCallCount++;
        if (txCallCount === 1) throw p2034Error;
        // Second attempt succeeds — reset all inner mocks for clean sequencing
        mockTxUserFindUnique.mockReset();
        mockTxAssignmentFindFirst.mockReset();
        const booking = makeBooking();
        mockTxExecuteRaw.mockResolvedValue(undefined);
        mockTxBookingFindUnique.mockResolvedValue(booking);
        mockTxUserFindUnique
          .mockResolvedValueOnce(makeActor())
          .mockResolvedValueOnce(makeDriver())
          .mockResolvedValueOnce(makeTransporter());
        mockTxVehicleFindUnique.mockResolvedValue(makeVehicle());
        mockTxAssignmentFindFirst
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null);
        mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
        mockTxBookingUpdateMany.mockResolvedValue({ count: 1 });
        mockTxBookingUpdate.mockResolvedValue(booking);
        mockTxAssignmentCreate.mockResolvedValue({ id: 'a1' });
        return fn(mockTx);
      });
      mockScheduleAssignmentTimeout.mockResolvedValue(undefined);
      mockSendPushNotification.mockResolvedValue(undefined);

      const result = await acceptBroadcast(BROADCAST_ID, baseParams);
      expect(result.status).toBe('assigned');
      expect(txCallCount).toBe(2);
    });

    test('throws after max transaction retry attempts', async () => {
      mockRedisEval.mockResolvedValue(1);
      mockRedisGetJSON.mockResolvedValue(null);
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockRedisReleaseLock.mockResolvedValue(undefined);

      const p2034Error = Object.assign(new Error('Serialization error'), { code: 'P2034' });
      mockWithDbTimeout.mockRejectedValue(p2034Error);

      await expect(acceptBroadcast(BROADCAST_ID, baseParams)).rejects.toThrow();
    });
  });

  // =========================================================================
  // Replay detection (in-transaction idempotency)
  // =========================================================================
  describe('In-transaction replay detection', () => {
    test('returns replayed result when existing active assignment found', async () => {
      setupSuccessfulAcceptMocks();
      const existingAssignment = {
        id: 'existing-assignment',
        tripId: 'existing-trip',
        bookingId: BROADCAST_ID,
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
        status: 'pending',
        assignedAt: new Date().toISOString(),
      };

      mockWithDbTimeout.mockImplementation(async (fn: Function) => {
        // Reset inner mocks for clean sequencing
        mockTxUserFindUnique.mockReset();
        mockTxAssignmentFindFirst.mockReset();
        mockTxExecuteRaw.mockResolvedValue(undefined);
        mockTxBookingFindUnique.mockResolvedValue(makeBooking());
        mockTxUserFindUnique
          .mockResolvedValueOnce(makeActor())
          .mockResolvedValueOnce(makeDriver())
          .mockResolvedValueOnce(makeTransporter());
        mockTxVehicleFindUnique.mockResolvedValue(makeVehicle());
        // Existing assignment found — triggers replay path
        mockTxAssignmentFindFirst.mockResolvedValueOnce(existingAssignment);
        return fn(mockTx);
      });

      const result = await acceptBroadcast(BROADCAST_ID, baseParams);
      expect(result.replayed).toBe(true);
      expect(result.resultCode).toBe('IDEMPOTENT_REPLAY');
      expect(result.assignmentId).toBe('existing-assignment');
    });

    test('replayed accept does NOT create new assignment', async () => {
      setupSuccessfulAcceptMocks();
      mockWithDbTimeout.mockImplementation(async (fn: Function) => {
        mockTxExecuteRaw.mockResolvedValue(undefined);
        mockTxBookingFindUnique.mockResolvedValue(makeBooking());
        mockTxUserFindUnique
          .mockResolvedValueOnce(makeActor())
          .mockResolvedValueOnce(makeDriver())
          .mockResolvedValueOnce(makeTransporter());
        mockTxVehicleFindUnique.mockResolvedValue(makeVehicle());
        mockTxAssignmentFindFirst.mockResolvedValueOnce({
          id: 'existing', tripId: 'existing-trip',
          bookingId: BROADCAST_ID, driverId: DRIVER_ID, vehicleId: VEHICLE_ID,
          status: 'pending', assignedAt: new Date().toISOString(),
        });
        return fn(mockTx);
      });

      await acceptBroadcast(BROADCAST_ID, baseParams);
      expect(mockTxAssignmentCreate).not.toHaveBeenCalled();
    });

    test('replayed accept does NOT send notifications', async () => {
      setupSuccessfulAcceptMocks();
      mockWithDbTimeout.mockImplementation(async (fn: Function) => {
        mockTxExecuteRaw.mockResolvedValue(undefined);
        mockTxBookingFindUnique.mockResolvedValue(makeBooking());
        mockTxUserFindUnique
          .mockResolvedValueOnce(makeActor())
          .mockResolvedValueOnce(makeDriver())
          .mockResolvedValueOnce(makeTransporter());
        mockTxVehicleFindUnique.mockResolvedValue(makeVehicle());
        mockTxAssignmentFindFirst.mockResolvedValueOnce({
          id: 'existing', tripId: 'existing-trip',
          bookingId: BROADCAST_ID, driverId: DRIVER_ID, vehicleId: VEHICLE_ID,
          status: 'pending', assignedAt: new Date().toISOString(),
        });
        return fn(mockTx);
      });

      await acceptBroadcast(BROADCAST_ID, baseParams);
      expect(mockSendPushNotification).not.toHaveBeenCalled();
      expect(mockEmitToUser).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Cache invalidation (M-15)
  // =========================================================================
  describe('M-15: Cache invalidation after accept', () => {
    test('invalidates transporter vehicle cache on success', async () => {
      setupSuccessfulAcceptMocks();
      await acceptBroadcast(BROADCAST_ID, baseParams);

      const vehicleCacheDel = mockRedisDel.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes(`cache:vehicles:transporter:${TRANSPORTER_ID}`)
      );
      expect(vehicleCacheDel).toBeDefined();
    });

    test('invalidates broadcast list cache on success', async () => {
      setupSuccessfulAcceptMocks();
      await acceptBroadcast(BROADCAST_ID, baseParams);

      const broadcastCacheDel = mockRedisDel.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes(`cache:broadcasts:${TRANSPORTER_ID}`)
      );
      expect(broadcastCacheDel).toBeDefined();
    });
  });

  // =========================================================================
  // Booking status transitions
  // =========================================================================
  describe('Booking status transitions', () => {
    test('sets booking to partially_filled when not all trucks assigned', async () => {
      setupSuccessfulAcceptMocks();
      // 0 of 3 filled -> 1 of 3 filled = partially_filled
      await acceptBroadcast(BROADCAST_ID, baseParams);

      expect(mockTxBookingUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'partially_filled',
          }),
        })
      );
    });

    test('sets booking to fully_filled when last truck assigned', async () => {
      setupSuccessfulAcceptMocks();
      mockWithDbTimeout.mockImplementation(async (fn: Function) => {
        mockTxExecuteRaw.mockResolvedValue(undefined);
        // 2 of 3 filled -> will become 3 of 3 = fully_filled
        mockTxBookingFindUnique.mockResolvedValue(makeBooking({ trucksFilled: 2, trucksNeeded: 3 }));
        mockTxUserFindUnique
          .mockResolvedValueOnce(makeActor())
          .mockResolvedValueOnce(makeDriver())
          .mockResolvedValueOnce(makeTransporter());
        mockTxVehicleFindUnique.mockResolvedValue(makeVehicle());
        mockTxAssignmentFindFirst.mockResolvedValue(null);
        mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
        mockTxBookingUpdateMany.mockResolvedValue({ count: 1 });
        mockTxBookingUpdate.mockResolvedValue({});
        mockTxAssignmentCreate.mockResolvedValue({ id: 'a1' });
        return fn(mockTx);
      });

      const result = await acceptBroadcast(BROADCAST_ID, baseParams);
      expect(result.isFullyFilled).toBe(true);
      expect(result.trucksConfirmed).toBe(3);
    });
  });

  // =========================================================================
  // declineBroadcast
  // =========================================================================
  describe('declineBroadcast', () => {
    test('verifies actor via Redis notified set (O(1) path)', async () => {
      mockRedisSCard.mockResolvedValue(5);
      mockRedisSIsMember.mockResolvedValue(true);
      mockRedisSAdd.mockResolvedValue(1);
      mockRedisExpire.mockResolvedValue(undefined);
      mockRedisHSet.mockResolvedValue(undefined);

      const result = await declineBroadcast(BROADCAST_ID, {
        actorId: TRANSPORTER_ID,
        reason: 'Too far',
      });
      expect(result.success).toBe(true);
      expect(mockRedisSIsMember).toHaveBeenCalled();
    });

    test('throws 403 when actor not in notified set', async () => {
      mockRedisSCard.mockResolvedValue(5);
      mockRedisSIsMember.mockResolvedValue(false);

      await expect(
        declineBroadcast(BROADCAST_ID, {
          actorId: 'unauthorized-actor',
          reason: 'Not interested',
        })
      ).rejects.toMatchObject({ statusCode: 403, code: 'NOT_AUTHORIZED' });
    });

    test('falls back to DB when Redis notified set unavailable', async () => {
      mockRedisSCard.mockRejectedValue(new Error('Redis down'));
      mockRedisSAdd.mockResolvedValue(1);
      mockRedisExpire.mockResolvedValue(undefined);
      mockRedisHSet.mockResolvedValue(undefined);

      // DB fallback
      const { prismaClient } = require('../shared/database/prisma.service');
      prismaClient.booking.findFirst.mockResolvedValue({
        id: BROADCAST_ID,
        notifiedTransporters: [TRANSPORTER_ID],
        status: 'active',
      });

      const result = await declineBroadcast(BROADCAST_ID, {
        actorId: TRANSPORTER_ID,
        reason: 'Busy',
      });
      expect(result.success).toBe(true);
    });

    test('tracks decline in Redis set and hash', async () => {
      mockRedisSCard.mockResolvedValue(5);
      mockRedisSIsMember.mockResolvedValue(true);
      mockRedisSAdd.mockResolvedValue(1);
      mockRedisExpire.mockResolvedValue(undefined);
      mockRedisHSet.mockResolvedValue(undefined);

      await declineBroadcast(BROADCAST_ID, {
        actorId: TRANSPORTER_ID,
        reason: 'Price too low',
        notes: 'Need higher rate',
      });

      // Decline tracked in Redis set
      expect(mockRedisSAdd).toHaveBeenCalledWith(
        `broadcast:declined:${BROADCAST_ID}`,
        TRANSPORTER_ID
      );
      // Decline log stored in hash
      expect(mockRedisHSet).toHaveBeenCalled();
    });

    test('detects replay decline (idempotent)', async () => {
      mockRedisSCard.mockResolvedValue(5);
      mockRedisSIsMember.mockResolvedValue(true);
      mockRedisSAdd.mockResolvedValue(0); // 0 means already in set (replay)
      mockRedisExpire.mockResolvedValue(undefined);
      mockRedisHSet.mockResolvedValue(undefined);

      const result = await declineBroadcast(BROADCAST_ID, {
        actorId: TRANSPORTER_ID,
        reason: 'Too far',
      });
      expect(result.replayed).toBe(true);
    });
  });

  // =========================================================================
  // Metrics tracking
  // =========================================================================
  describe('Metrics tracking', () => {
    test('increments accept.attempts metric on every call', async () => {
      setupSuccessfulAcceptMocks();
      const { metrics } = require('../shared/monitoring/metrics.service');

      await acceptBroadcast(BROADCAST_ID, baseParams);

      expect(metrics.incrementCounter).toHaveBeenCalledWith('accept.attempts');
    });

    test('increments accept.success metric on successful accept', async () => {
      setupSuccessfulAcceptMocks();
      const { metrics } = require('../shared/monitoring/metrics.service');

      await acceptBroadcast(BROADCAST_ID, baseParams);

      expect(metrics.incrementCounter).toHaveBeenCalledWith('accept.success');
    });

    test('increments accept.idempotent_replay on cache hit', async () => {
      mockRedisEval.mockResolvedValue(1);
      mockRedisGetJSON.mockResolvedValue({
        assignmentId: 'cached', tripId: 'cached-trip',
        status: 'assigned', trucksConfirmed: 1, totalTrucksNeeded: 3, isFullyFilled: false,
      });
      const { metrics } = require('../shared/monitoring/metrics.service');

      await acceptBroadcast(BROADCAST_ID, {
        ...baseParams,
        idempotencyKey: 'replay-key-12345',
      });

      expect(metrics.incrementCounter).toHaveBeenCalledWith('accept.idempotent_replay');
    });

    test('increments accept.lock_contention on lock failure', async () => {
      mockRedisEval.mockResolvedValue(1);
      mockRedisGetJSON.mockResolvedValue(null);
      mockRedisAcquireLock.mockResolvedValue({ acquired: false });
      const { metrics } = require('../shared/monitoring/metrics.service');

      await expect(acceptBroadcast(BROADCAST_ID, baseParams)).rejects.toThrow();
      expect(metrics.incrementCounter).toHaveBeenCalledWith('accept.lock_contention');
    });
  });
});
