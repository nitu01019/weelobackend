/**
 * =============================================================================
 * BROADCAST-MATCHING-TRIAD2 — Tests for Fix #16 and Fix #17
 * =============================================================================
 *
 * Fix #16: rebuildGeoFromDB() — availability.service.ts
 *   Rebuilds online:transporters SET from DB when Redis was restarted.
 *
 * Fix #17: sweepExpiredBookingsFromDB() — booking.service.ts
 *   DB-based fallback sweep for expired bookings missed by Redis timers.
 *
 * @author Weelo Team (LEO-TEST-2)
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
    googleMaps: { apiKey: 'test-key', enabled: false },
  },
}));

// Google Maps service mock
jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: {
    calculateRoute: jest.fn().mockResolvedValue({ distanceKm: 10, durationMin: 20, polyline: '' }),
    geocode: jest.fn().mockResolvedValue(null),
    reverseGeocode: jest.fn().mockResolvedValue(null),
  },
}));

// Cache service mock
jest.mock('../shared/services/cache.service', () => ({
  cacheService: { get: jest.fn(), set: jest.fn(), delete: jest.fn() },
}));

// Geo utils mock
jest.mock('../shared/utils/geo.utils', () => ({
  roundCoord: (c: number) => Math.round(c * 100) / 100,
}));

// Redis service mock
const mockRedisSCard = jest.fn();
const mockRedisSAdd = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisExists = jest.fn();
const mockRedisExpire = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisSMembers = jest.fn();
const mockRedisSRem = jest.fn();
const mockRedisSIsMember = jest.fn();
const mockRedisIsConnected = jest.fn().mockReturnValue(true);
const mockRedisIsRedisEnabled = jest.fn().mockReturnValue(true);
const mockRedisSetJSON = jest.fn();
const mockRedisGetJSON = jest.fn();
const mockRedisSetTimer = jest.fn();
const mockRedisGetExpiredTimers = jest.fn();
const mockRedisCancelTimer = jest.fn();
const mockRedisHSet = jest.fn();
const mockRedisHMSet = jest.fn();
const mockRedisHGet = jest.fn();
const mockRedisHGetAll = jest.fn();
const mockRedisHGetAllBatch = jest.fn();
const mockRedisGeoAdd = jest.fn();
const mockRedisGeoRadius = jest.fn();
const mockRedisGeoRemove = jest.fn();
const mockRedisPublish = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
    exists: mockRedisExists,
    expire: mockRedisExpire,
    acquireLock: mockRedisAcquireLock,
    releaseLock: mockRedisReleaseLock,
    sAdd: mockRedisSAdd,
    sRem: mockRedisSRem,
    sMembers: mockRedisSMembers,
    sCard: mockRedisSCard,
    sIsMember: mockRedisSIsMember,
    isConnected: mockRedisIsConnected,
    isRedisEnabled: mockRedisIsRedisEnabled,
    setJSON: mockRedisSetJSON,
    getJSON: mockRedisGetJSON,
    setTimer: mockRedisSetTimer,
    getExpiredTimers: mockRedisGetExpiredTimers,
    cancelTimer: mockRedisCancelTimer,
    hSet: mockRedisHSet,
    hMSet: mockRedisHMSet,
    hGet: mockRedisHGet,
    hGetAll: mockRedisHGetAll,
    hGetAllBatch: mockRedisHGetAllBatch,
    geoAdd: mockRedisGeoAdd,
    geoRadius: mockRedisGeoRadius,
    geoRemove: mockRedisGeoRemove,
    publish: mockRedisPublish,
    ttl: jest.fn().mockResolvedValue(120),
    isDegraded: false,
    initialize: jest.fn(),
  },
}));

// H3 geo index mock
jest.mock('../shared/services/h3-geo-index.service', () => ({
  h3GeoIndexService: {
    removeTransporter: jest.fn().mockResolvedValue(undefined),
    addTransporter: jest.fn().mockResolvedValue(undefined),
    findNearby: jest.fn().mockResolvedValue([]),
  },
}));

// Prisma mock — user, booking
const mockUserFindMany = jest.fn();
const mockBookingFindMany = jest.fn();

jest.mock('../shared/database/prisma.service', () => {
  const txProxy = {
    user: {
      findMany: (...args: any[]) => mockUserFindMany(...args),
    },
    booking: {
      findMany: (...args: any[]) => mockBookingFindMany(...args),
    },
  };
  return {
    prismaClient: {
      ...txProxy,
      $transaction: jest.fn(),
    },
    withDbTimeout: async (fn: (tx: any) => Promise<any>, _opts?: any) => fn(txProxy),
    VehicleStatus: {
      available: 'available',
      on_hold: 'on_hold',
      in_transit: 'in_transit',
      maintenance: 'maintenance',
      inactive: 'inactive',
    },
    BookingStatus: {
      created: 'created',
      broadcasting: 'broadcasting',
      active: 'active',
      partially_filled: 'partially_filled',
      fully_filled: 'fully_filled',
      cancelled: 'cancelled',
      expired: 'expired',
    },
    AssignmentStatus: {
      pending: 'pending',
      driver_accepted: 'driver_accepted',
      completed: 'completed',
      cancelled: 'cancelled',
    },
    Prisma: {
      TransactionIsolationLevel: { Serializable: 'Serializable' },
    },
  };
});

// DB mock
const mockGetBookingById = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getBookingById: (...args: any[]) => mockGetBookingById(...args),
    getUserById: jest.fn(),
    createBooking: jest.fn(),
    updateBooking: jest.fn(),
    getTransportersWithVehicleType: jest.fn(),
    getVehiclesByTransporter: jest.fn(),
    getActiveBookingsForTransporter: jest.fn(),
    getActiveOrders: jest.fn(),
    getBookingsByDriver: jest.fn(),
  },
}));

// Socket service mock
jest.mock('../shared/services/socket.service', () => ({
  emitToUser: jest.fn(),
  emitToBooking: jest.fn(),
  emitToUsers: jest.fn(),
  isUserConnected: jest.fn().mockReturnValue(true),
  SocketEvent: {
    BOOKING_EXPIRED: 'booking:expired',
    BOOKING_UPDATE: 'booking:update',
    BROADCAST_NEW: 'broadcast:new',
    BROADCAST_UPDATE: 'broadcast:update',
    BROADCAST_CANCEL: 'broadcast:cancel',
  },
}));

// FCM service mock
jest.mock('../shared/services/fcm.service', () => ({
  fcmService: {
    sendToUser: jest.fn().mockResolvedValue(undefined),
    sendToTokens: jest.fn().mockResolvedValue(undefined),
    sendToMultipleUsers: jest.fn().mockResolvedValue(undefined),
  },
}));

// Queue service mock
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    addJob: jest.fn(),
    removeJob: jest.fn(),
  },
}));

// Live availability mock
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    getAvailableTransporters: jest.fn().mockResolvedValue([]),
    updateAvailability: jest.fn(),
    markOffline: jest.fn(),
    getAvailableCount: jest.fn().mockResolvedValue(0),
  },
}));

// Transporter online service mock
jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: {
    isOnline: jest.fn().mockResolvedValue(true),
    getOnlineTransporters: jest.fn().mockResolvedValue([]),
  },
}));

// Vehicle key service mock
jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn().mockReturnValue('open_17ft'),
}));

// Progressive radius matcher mock
jest.mock('../modules/order/progressive-radius-matcher', () => ({
  ...jest.requireActual('../modules/order/progressive-radius-matcher'),
  progressiveRadiusMatcher: {
    startMatching: jest.fn(),
    stopMatching: jest.fn(),
    findCandidates: jest.fn().mockResolvedValue([]),
    getStepCount: jest.fn().mockReturnValue(6),
    getStep: jest.fn().mockReturnValue({ radiusKm: 10, windowMs: 10_000, h3RingK: 15 }),
  },
  startProgressiveMatching: jest.fn(),
  cancelProgressiveMatching: jest.fn(),
}));

// Distance matrix mock
jest.mock('../shared/services/distance-matrix.service', () => ({
  distanceMatrixService: {
    getDistance: jest.fn().mockResolvedValue({ distanceKm: 10, durationMin: 20 }),
  },
}));

// Vehicle lifecycle mock
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
}));

// Geospatial utils mock
jest.mock('../shared/utils/geospatial.utils', () => ({
  haversineDistanceKm: jest.fn().mockReturnValue(5),
}));

// State machine mock
jest.mock('../core/state-machines', () => ({
  assertValidTransition: jest.fn(),
  BOOKING_VALID_TRANSITIONS: {},
}));

// Constants mock
jest.mock('../core/constants', () => ({
  ErrorCode: {
    BOOKING_ALREADY_EXPIRED: 'BOOKING_ALREADY_EXPIRED',
    BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  },
}));

// Booking payload helper mock
jest.mock('../modules/booking/booking-payload.helper', () => ({
  buildBroadcastPayload: jest.fn().mockReturnValue({}),
  getRemainingTimeoutSeconds: jest.fn().mockReturnValue(300),
}));

// =============================================================================
// IMPORTS — After mocks
// =============================================================================

import { availabilityService } from '../shared/services/availability.service';
import { logger } from '../shared/services/logger.service';
import { prismaClient } from '../shared/database/prisma.service';

// =============================================================================
// FIX #16: rebuildGeoFromDB() — 5 tests
// =============================================================================

describe('Fix #16: rebuildGeoFromDB()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('when online SET is empty, queries DB and adds transporters', async () => {
    // Online set is empty (simulating Redis restart)
    mockRedisSCard.mockResolvedValue(0);

    // DB returns 3 active transporters
    mockUserFindMany.mockResolvedValue([
      { id: 'trans_1' },
      { id: 'trans_2' },
      { id: 'trans_3' },
    ]);

    mockRedisSAdd.mockResolvedValue(1);

    await availabilityService.rebuildGeoFromDB();

    // Should check online SET cardinality
    expect(mockRedisSCard).toHaveBeenCalledWith('online:transporters');

    // Should query DB for active transporters
    expect(mockUserFindMany).toHaveBeenCalledWith({
      where: {
        role: 'transporter',
        isAvailable: true,
        isActive: true,
      },
      select: { id: true },
      take: 500,
    });

    // Should add each transporter to the online SET
    expect(mockRedisSAdd).toHaveBeenCalledTimes(3);
    expect(mockRedisSAdd).toHaveBeenCalledWith('online:transporters', 'trans_1');
    expect(mockRedisSAdd).toHaveBeenCalledWith('online:transporters', 'trans_2');
    expect(mockRedisSAdd).toHaveBeenCalledWith('online:transporters', 'trans_3');

    // Should log the rebuild
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Redis geo index EMPTY')
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('added 3 transporters')
    );
  });

  test('when online SET has members, skips rebuild', async () => {
    // Online set already has members
    mockRedisSCard.mockResolvedValue(5);

    await availabilityService.rebuildGeoFromDB();

    // Should check cardinality
    expect(mockRedisSCard).toHaveBeenCalledWith('online:transporters');

    // Should NOT query DB
    expect(mockUserFindMany).not.toHaveBeenCalled();

    // Should NOT add anything to Redis
    expect(mockRedisSAdd).not.toHaveBeenCalled();

    // Should log that it skipped
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('skipping rebuild')
    );
  });

  test('when DB returns 0 transporters, logs and returns gracefully', async () => {
    // Online set is empty
    mockRedisSCard.mockResolvedValue(0);

    // DB returns no active transporters
    mockUserFindMany.mockResolvedValue([]);

    await availabilityService.rebuildGeoFromDB();

    // Should check cardinality
    expect(mockRedisSCard).toHaveBeenCalledWith('online:transporters');

    // Should query DB
    expect(mockUserFindMany).toHaveBeenCalled();

    // Should NOT add anything to Redis (no transporters to add)
    expect(mockRedisSAdd).not.toHaveBeenCalled();

    // Should log clean cold start
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('No active transporters in DB')
    );
  });

  test('when DB throws, error is caught (does not crash startup)', async () => {
    // Online set is empty
    mockRedisSCard.mockResolvedValue(0);

    // DB throws an error
    mockUserFindMany.mockRejectedValue(new Error('DB connection timeout'));

    // Should NOT throw — the method catches internally
    await expect(availabilityService.rebuildGeoFromDB()).resolves.toBeUndefined();

    // Should log the error
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('rebuildGeoFromDB failed')
    );
  });

  test('idempotency: calling rebuild twice produces same result (sAdd is idempotent)', async () => {
    // Online set is empty for both calls
    mockRedisSCard.mockResolvedValue(0);

    mockUserFindMany.mockResolvedValue([
      { id: 'trans_1' },
      { id: 'trans_2' },
    ]);

    mockRedisSAdd.mockResolvedValue(1);

    // First call
    await availabilityService.rebuildGeoFromDB();

    const firstCallSAddCount = mockRedisSAdd.mock.calls.length;
    expect(firstCallSAddCount).toBe(2);

    // Clear mocks but keep return values
    jest.clearAllMocks();
    mockRedisSCard.mockResolvedValue(0);
    mockUserFindMany.mockResolvedValue([
      { id: 'trans_1' },
      { id: 'trans_2' },
    ]);
    mockRedisSAdd.mockResolvedValue(0); // sAdd returns 0 when member already exists

    // Second call — idempotent
    await availabilityService.rebuildGeoFromDB();

    // Same sAdd calls made (Redis sAdd is naturally idempotent)
    expect(mockRedisSAdd).toHaveBeenCalledTimes(2);
    expect(mockRedisSAdd).toHaveBeenCalledWith('online:transporters', 'trans_1');
    expect(mockRedisSAdd).toHaveBeenCalledWith('online:transporters', 'trans_2');
  });
});

// =============================================================================
// FIX #17: sweepExpiredBookingsFromDB() — 7 tests
// =============================================================================

/**
 * sweepExpiredBookingsFromDB and the interval/counter logic are module-level
 * functions inside booking.service.ts. We test them by importing the module
 * and exercising the exported functions plus spying on bookingService methods.
 *
 * Strategy: Since sweepExpiredBookingsFromDB is not exported, we test the
 * behavior indirectly. For the interval-based tests we use real timers with a
 * short wait to let one tick fire, then verify the side-effects.
 *
 * For unit-level verification of the sweep logic (lock, DB query, handler calls),
 * we directly exercise the code paths by replacing setInterval with a captured
 * callback that we can invoke synchronously.
 */

describe('Fix #17: sweepExpiredBookingsFromDB()', () => {
  let bookingServiceModule: any;
  let handleBookingTimeoutSpy: jest.SpyInstance;
  // Captured setInterval callback for direct invocation
  let capturedIntervalCallback: (() => Promise<void>) | null = null;
  let originalSetInterval: typeof setInterval;

  beforeAll(async () => {
    // Save original setInterval
    originalSetInterval = global.setInterval;

    // Import the module after all mocks are in place
    bookingServiceModule = await import('../modules/booking/booking.service');

    // Spy on handleBookingTimeout to track calls without running actual logic
    handleBookingTimeoutSpy = jest
      .spyOn(bookingServiceModule.bookingService, 'handleBookingTimeout')
      .mockResolvedValue(undefined);
  });

  afterAll(() => {
    global.setInterval = originalSetInterval;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    handleBookingTimeoutSpy.mockResolvedValue(undefined);
    capturedIntervalCallback = null;
    // Ensure checker is stopped so each test can start fresh
    bookingServiceModule.stopBookingExpiryChecker();

    // Intercept setInterval to capture the callback
    global.setInterval = ((fn: any, ms: any) => {
      capturedIntervalCallback = fn;
      // Return a fake timer ID (we control execution manually)
      return originalSetInterval(() => {}, 999999) as any;
    }) as any;
  });

  afterEach(() => {
    bookingServiceModule.stopBookingExpiryChecker();
  });

  /**
   * Helper: simulate N ticks of the interval by calling the captured callback
   * N times. This lets the dbSweepCounter increment naturally.
   */
  async function simulateTicks(n: number): Promise<void> {
    if (!capturedIntervalCallback) {
      throw new Error('startBookingExpiryChecker was not called or callback not captured');
    }
    for (let i = 0; i < n; i++) {
      await capturedIntervalCallback();
    }
  }

  test('finds expired bookings and calls handleBookingTimeout for each', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true, token: 'db-sweep' });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    mockRedisGetExpiredTimers.mockResolvedValue([]);

    // DB returns 3 expired bookings
    mockBookingFindMany.mockResolvedValue([
      { id: 'booking_1', customerId: 'cust_1' },
      { id: 'booking_2', customerId: 'cust_2' },
      { id: 'booking_3', customerId: 'cust_3' },
    ]);

    bookingServiceModule.startBookingExpiryChecker();

    // Simulate 12 ticks to trigger the DB sweep (counter % 12 === 0)
    await simulateTicks(12);

    // Verify that acquireLock was called with the sweep lock key
    const sweepLockCalls = mockRedisAcquireLock.mock.calls.filter(
      (call: any[]) => call[0] === 'lock:booking-db-sweep'
    );
    expect(sweepLockCalls.length).toBeGreaterThanOrEqual(1);

    // Verify booking.findMany was called to find expired bookings
    expect(mockBookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['broadcasting', 'active', 'partially_filled', 'created'] },
        }),
        select: { id: true, customerId: true },
        take: 50,
      })
    );

    // Verify handleBookingTimeout was called for each expired booking
    expect(handleBookingTimeoutSpy).toHaveBeenCalledWith('booking_1', 'cust_1');
    expect(handleBookingTimeoutSpy).toHaveBeenCalledWith('booking_2', 'cust_2');
    expect(handleBookingTimeoutSpy).toHaveBeenCalledWith('booking_3', 'cust_3');
  });

  test('distributed lock prevents multi-instance duplicate', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true, token: 'db-sweep' });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    mockBookingFindMany.mockResolvedValue([]);
    mockRedisGetExpiredTimers.mockResolvedValue([]);

    bookingServiceModule.startBookingExpiryChecker();

    await simulateTicks(12);

    // Verify acquireLock was called with correct lock key and TTL (55s)
    const sweepLockCalls = mockRedisAcquireLock.mock.calls.filter(
      (call: any[]) => call[0] === 'lock:booking-db-sweep'
    );
    expect(sweepLockCalls.length).toBeGreaterThanOrEqual(1);
    // Lock params: key, owner, ttl
    expect(sweepLockCalls[0]).toEqual(['lock:booking-db-sweep', 'db-sweep', 55]);
  });

  test('lock not acquired -> silent skip', async () => {
    // Lock NOT acquired (another instance holds it)
    mockRedisAcquireLock.mockResolvedValue({ acquired: false });
    mockRedisGetExpiredTimers.mockResolvedValue([]);

    bookingServiceModule.startBookingExpiryChecker();

    await simulateTicks(12);

    // Should NOT query DB when lock is not acquired
    expect(mockBookingFindMany).not.toHaveBeenCalled();

    // Should NOT call handleBookingTimeout
    expect(handleBookingTimeoutSpy).not.toHaveBeenCalled();
  });

  test('empty result from DB -> no processing', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true, token: 'db-sweep' });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    mockBookingFindMany.mockResolvedValue([]);
    mockRedisGetExpiredTimers.mockResolvedValue([]);

    bookingServiceModule.startBookingExpiryChecker();

    await simulateTicks(12);

    // DB sweep lock was requested
    const sweepLockCalls = mockRedisAcquireLock.mock.calls.filter(
      (call: any[]) => call[0] === 'lock:booking-db-sweep'
    );
    expect(sweepLockCalls.length).toBeGreaterThanOrEqual(1);

    // handleBookingTimeout was NOT called (no expired bookings)
    expect(handleBookingTimeoutSpy).not.toHaveBeenCalled();

    // No warning logged (empty result returns early before logger.warn)
    const warnCalls = (logger.warn as jest.Mock).mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('[DB-SWEEP]')
    );
    expect(warnCalls.length).toBe(0);
  });

  test('one booking fails -> others still processed', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true, token: 'db-sweep' });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    mockRedisGetExpiredTimers.mockResolvedValue([]);

    mockBookingFindMany.mockResolvedValue([
      { id: 'booking_ok_1', customerId: 'cust_1' },
      { id: 'booking_fail', customerId: 'cust_2' },
      { id: 'booking_ok_2', customerId: 'cust_3' },
    ]);

    // Second booking throws, others succeed
    handleBookingTimeoutSpy
      .mockResolvedValueOnce(undefined)  // booking_ok_1 succeeds
      .mockRejectedValueOnce(new Error('Timeout processing failed'))  // booking_fail throws
      .mockResolvedValueOnce(undefined); // booking_ok_2 succeeds

    bookingServiceModule.startBookingExpiryChecker();

    await simulateTicks(12);

    // All 3 bookings should have been attempted
    expect(handleBookingTimeoutSpy).toHaveBeenCalledWith('booking_ok_1', 'cust_1');
    expect(handleBookingTimeoutSpy).toHaveBeenCalledWith('booking_fail', 'cust_2');
    expect(handleBookingTimeoutSpy).toHaveBeenCalledWith('booking_ok_2', 'cust_3');

    // Error for the failed one should be logged
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('booking_fail')
    );
  });

  test('handles already-expired booking (idempotent via handleBookingTimeout)', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true, token: 'db-sweep' });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    mockRedisGetExpiredTimers.mockResolvedValue([]);

    // DB finds a booking that was already expired (handler is idempotent)
    mockBookingFindMany.mockResolvedValue([
      { id: 'booking_already_expired', customerId: 'cust_1' },
    ]);

    // handleBookingTimeout resolves successfully even for already-expired booking
    // (it checks status internally and skips terminal states)
    handleBookingTimeoutSpy.mockResolvedValue(undefined);

    bookingServiceModule.startBookingExpiryChecker();

    await simulateTicks(12);

    // handleBookingTimeout was called -- it handles idempotency internally
    expect(handleBookingTimeoutSpy).toHaveBeenCalledWith(
      'booking_already_expired',
      'cust_1'
    );

    // No error logged (handler succeeded gracefully)
    const errorCalls = (logger.error as jest.Mock).mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('[DB-SWEEP] Failed')
    );
    expect(errorCalls.length).toBe(0);
  });

  test('counter: dbSweepCounter increments correctly, sweep fires on 12th tick', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true, token: 'db-sweep' });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    mockBookingFindMany.mockResolvedValue([]);
    mockRedisGetExpiredTimers.mockResolvedValue([]);

    bookingServiceModule.startBookingExpiryChecker();

    // Advance 11 ticks -- sweep should NOT have fired yet
    await simulateTicks(11);

    const sweepCallsBefore = mockRedisAcquireLock.mock.calls.filter(
      (call: any[]) => call[0] === 'lock:booking-db-sweep'
    ).length;

    // Clear only call tracking, keep mock implementations
    mockRedisAcquireLock.mockClear();
    mockRedisReleaseLock.mockClear();
    mockBookingFindMany.mockClear();
    mockRedisGetExpiredTimers.mockClear();

    // Re-set return values after clear
    mockRedisAcquireLock.mockResolvedValue({ acquired: true, token: 'db-sweep' });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    mockBookingFindMany.mockResolvedValue([]);
    mockRedisGetExpiredTimers.mockResolvedValue([]);

    // Advance 1 more tick (tick 12) -- sweep SHOULD fire
    await simulateTicks(1);

    // After 12th tick, the sweep lock should be requested
    const sweepCallsAfter = mockRedisAcquireLock.mock.calls.filter(
      (call: any[]) => call[0] === 'lock:booking-db-sweep'
    ).length;

    // Before tick 12, no sweep lock calls were made
    expect(sweepCallsBefore).toBe(0);
    // After tick 12, exactly 1 sweep lock call
    expect(sweepCallsAfter).toBeGreaterThanOrEqual(1);
  });
});
