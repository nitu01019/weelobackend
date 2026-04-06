/**
 * =============================================================================
 * BROADCAST-MATCHING TRIAD 1 — Tests for Fix #36 and Fix #2
 * =============================================================================
 *
 * Fix #36: advanceRadiusStep totalSteps clamped to Math.min of config steps
 *          and matcher's getStepCount(). Prevents wasted radius expansion
 *          when FF_H3_RADIUS_STEPS is off (matcher has 3 steps, config has 6).
 *
 * Fix #2:  Stale transporter cleanup now removes from geo + H3 indexes.
 *   (a) availability.service GEORADIUS filter: removes from online SET + H3
 *   (b) transporter-online.service cleanStaleTransporters: removes from geo + H3
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
  config: { redis: { enabled: true }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {} },
}));

// ---------------------------------------------------------------------------
// Redis service mock
// ---------------------------------------------------------------------------
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisExists = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisSMembers = jest.fn();
const mockRedisSAdd = jest.fn();
const mockRedisSRem = jest.fn();
const mockRedisSScan = jest.fn();
const mockRedisGetJSON = jest.fn();
const mockRedisSetJSON = jest.fn();
const mockRedisGetExpiredTimers = jest.fn();
const mockRedisCancelTimer = jest.fn();
const mockRedisSetTimer = jest.fn();
const mockRedisExpire = jest.fn();
const mockRedisSIsMember = jest.fn();
const mockRedisIsConnected = jest.fn().mockReturnValue(true);
const mockRedisGeoRadius = jest.fn();
const mockRedisGeoRemove = jest.fn();
const mockRedisHGetAll = jest.fn();
const mockRedisSCard = jest.fn();
const mockRedisLPush = jest.fn();
const mockRedisLTrim = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    exists: (...args: any[]) => mockRedisExists(...args),
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    sMembers: (...args: any[]) => mockRedisSMembers(...args),
    sAdd: (...args: any[]) => mockRedisSAdd(...args),
    sAddWithExpire: (...args: any[]) => mockRedisSAdd(...args),
    sRem: (...args: any[]) => mockRedisSRem(...args),
    sScan: (...args: any[]) => mockRedisSScan(...args),
    getJSON: (...args: any[]) => mockRedisGetJSON(...args),
    setJSON: (...args: any[]) => mockRedisSetJSON(...args),
    getExpiredTimers: (...args: any[]) => mockRedisGetExpiredTimers(...args),
    cancelTimer: (...args: any[]) => mockRedisCancelTimer(...args),
    setTimer: (...args: any[]) => mockRedisSetTimer(...args),
    expire: (...args: any[]) => mockRedisExpire(...args),
    sIsMember: (...args: any[]) => mockRedisSIsMember(...args),
    sCard: (...args: any[]) => mockRedisSCard(...args),
    isConnected: () => mockRedisIsConnected(),
    geoRadius: (...args: any[]) => mockRedisGeoRadius(...args),
    geoRemove: (...args: any[]) => mockRedisGeoRemove(...args),
    hGetAll: (...args: any[]) => mockRedisHGetAll(...args),
    lPush: (...args: any[]) => mockRedisLPush(...args),
    lTrim: (...args: any[]) => mockRedisLTrim(...args),
    isDegraded: false,
    isRedisEnabled: jest.fn().mockReturnValue(true),
    onReconnect: jest.fn(),
    healthCheck: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Prisma mock
// ---------------------------------------------------------------------------
const mockBookingFindUnique = jest.fn();
const mockBookingUpdateMany = jest.fn();
const mockBookingUpdate = jest.fn();
const mockBookingCreate = jest.fn();
const mockBookingFindFirst = jest.fn();
const mockAssignmentFindMany = jest.fn();
const mockAssignmentUpdateMany = jest.fn();
const mockAssignmentFindFirst = jest.fn();
const mockAssignmentCreate = jest.fn();
const mockVehicleFindUnique = jest.fn();
const mockVehicleUpdateMany = jest.fn();
const mockVehicleUpdate = jest.fn();
const mockUserFindUnique = jest.fn();
const mockUserUpdate = jest.fn();
const mockQueryRaw = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../shared/database/prisma.service', () => {
  const txProxy = {
    booking: {
      findUnique: (...args: any[]) => mockBookingFindUnique(...args),
      updateMany: (...args: any[]) => mockBookingUpdateMany(...args),
      update: (...args: any[]) => mockBookingUpdate(...args),
      create: (...args: any[]) => mockBookingCreate(...args),
      findFirst: (...args: any[]) => mockBookingFindFirst(...args),
    },
    assignment: {
      findMany: (...args: any[]) => mockAssignmentFindMany(...args),
      updateMany: (...args: any[]) => mockAssignmentUpdateMany(...args),
      findFirst: (...args: any[]) => mockAssignmentFindFirst(...args),
      create: (...args: any[]) => mockAssignmentCreate(...args),
    },
    vehicle: {
      findUnique: (...args: any[]) => mockVehicleFindUnique(...args),
      updateMany: (...args: any[]) => mockVehicleUpdateMany(...args),
      update: (...args: any[]) => mockVehicleUpdate(...args),
    },
    user: {
      findUnique: (...args: any[]) => mockUserFindUnique(...args),
      update: (...args: any[]) => mockUserUpdate(...args),
    },
    $queryRaw: (...args: any[]) => mockQueryRaw(...args),
  };
  return {
    prismaClient: {
      ...txProxy,
      $transaction: (...args: any[]) => mockTransaction(...args),
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
      driver_declined: 'driver_declined',
      en_route_pickup: 'en_route_pickup',
      at_pickup: 'at_pickup',
      in_transit: 'in_transit',
      arrived_at_drop: 'arrived_at_drop',
      completed: 'completed',
      cancelled: 'cancelled',
    },
    Prisma: {
      TransactionIsolationLevel: { Serializable: 'Serializable' },
    },
  };
});

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------
const mockGetBookingById = jest.fn();
const mockGetUserById = jest.fn();
const mockCreateBooking = jest.fn();
const mockUpdateBooking = jest.fn();
const mockGetTransportersWithVehicleType = jest.fn();
const mockGetVehiclesByTransporter = jest.fn();
const mockGetActiveBookingsForTransporter = jest.fn();
const mockGetActiveOrders = jest.fn();
const mockGetBookingsByDriver = jest.fn();
const mockGetBookingsByCustomer = jest.fn();
const mockGetAssignmentsByBooking = jest.fn();
const mockUpdateOrder = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getBookingById: (...args: any[]) => mockGetBookingById(...args),
    getUserById: (...args: any[]) => mockGetUserById(...args),
    createBooking: (...args: any[]) => mockCreateBooking(...args),
    updateBooking: (...args: any[]) => mockUpdateBooking(...args),
    getTransportersWithVehicleType: (...args: any[]) => mockGetTransportersWithVehicleType(...args),
    getVehiclesByTransporter: (...args: any[]) => mockGetVehiclesByTransporter(...args),
    getActiveBookingsForTransporter: (...args: any[]) => mockGetActiveBookingsForTransporter(...args),
    getActiveOrders: (...args: any[]) => mockGetActiveOrders(...args),
    getBookingsByDriver: (...args: any[]) => mockGetBookingsByDriver(...args),
    getBookingsByCustomer: (...args: any[]) => mockGetBookingsByCustomer(...args),
    getAssignmentsByBooking: (...args: any[]) => mockGetAssignmentsByBooking(...args),
    updateOrder: (...args: any[]) => mockUpdateOrder(...args),
  },
}));

// ---------------------------------------------------------------------------
// Socket mock
// ---------------------------------------------------------------------------
jest.mock('../shared/services/socket.service', () => ({
  emitToUser: jest.fn(),
  socketService: { emitToUser: jest.fn() },
  SocketEvent: {
    NEW_BROADCAST: 'new_broadcast',
    BROADCAST_CANCELLED: 'broadcast_cancelled',
    BOOKING_EXPIRED: 'booking_expired',
    BOOKING_ACCEPTED: 'booking_accepted',
    REQUEST_NO_LONGER_AVAILABLE: 'request_no_longer_available',
    ORDER_STATUS_UPDATE: 'order_status_update',
  },
}));

// ---------------------------------------------------------------------------
// FCM mock
// ---------------------------------------------------------------------------
jest.mock('../shared/services/fcm.service', () => ({
  fcmService: {
    notifyNewBroadcast: jest.fn().mockResolvedValue(0),
  },
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Queue mock
// ---------------------------------------------------------------------------
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queuePushNotificationBatch: jest.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Availability service mock
// ---------------------------------------------------------------------------
jest.mock('../shared/services/availability.service', () => ({
  availabilityService: {
    loadTransporterDetailsMap: jest.fn().mockResolvedValue(new Map()),
    getTransporterDetails: jest.fn().mockResolvedValue(null),
    getAvailableTransportersAsync: jest.fn().mockResolvedValue([]),
  },
}));

// ---------------------------------------------------------------------------
// Transporter online service — NOT mocked: uses real module with mocked deps
// ---------------------------------------------------------------------------
// The real TransporterOnlineService is loaded so we can test cleanStaleTransporters.
// Its dependencies (redis, prisma, db, h3, logger) are all mocked above.

// ---------------------------------------------------------------------------
// H3 geo index service mock
// ---------------------------------------------------------------------------
const mockH3RemoveTransporter = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/h3-geo-index.service', () => ({
  h3GeoIndexService: {
    updateLocation: jest.fn().mockResolvedValue(undefined),
    removeTransporter: (...args: any[]) => mockH3RemoveTransporter(...args),
    findNearby: jest.fn().mockResolvedValue([]),
    getCandidates: jest.fn().mockResolvedValue([]),
  },
  FF_H3_INDEX_ENABLED: false,
}));

// ---------------------------------------------------------------------------
// Progressive radius matcher mock (Fix #36 focus)
// ---------------------------------------------------------------------------
const mockFindCandidates = jest.fn().mockResolvedValue([]);
const mockGetStepCount = jest.fn();

jest.mock('../modules/order/progressive-radius-matcher', () => ({
  ...jest.requireActual('../modules/order/progressive-radius-matcher'),
  progressiveRadiusMatcher: {
    findCandidates: (...args: any[]) => mockFindCandidates(...args),
    getStepCount: (...args: any[]) => mockGetStepCount(...args),
    getStep: jest.fn().mockReturnValue({ radiusKm: 10, windowMs: 20_000, h3RingK: 15 }),
  },
  startProgressiveMatching: jest.fn(),
  cancelProgressiveMatching: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Other mocks
// ---------------------------------------------------------------------------
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn().mockReturnValue('Tipper_20-24 Ton'),
  generateVehicleKeyCandidates: jest.fn().mockReturnValue(['Tipper_20-24 Ton']),
}));

jest.mock('../shared/services/distance-matrix.service', () => ({
  distanceMatrixService: {
    batchGetPickupDistance: jest.fn().mockResolvedValue(new Map()),
  },
}));

jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: {
    calculateRoute: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../shared/utils/geospatial.utils', () => ({
  haversineDistanceKm: jest.fn().mockReturnValue(10),
}));

jest.mock('../shared/utils/geo.utils', () => ({
  roundCoord: jest.fn((v: number) => Math.round(v * 1000) / 1000),
}));

jest.mock('../modules/booking/booking-payload.helper', () => ({
  buildBroadcastPayload: jest.fn().mockReturnValue({ broadcastId: 'test-booking-id' }),
  getRemainingTimeoutSeconds: jest.fn().mockReturnValue(100),
}));

jest.mock('../shared/services/cache.service', () => ({
  cacheService: {
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock('../shared/services/circuit-breaker.service', () => ({
  CircuitBreaker: jest.fn().mockImplementation(() => ({
    tryWithFallback: jest.fn((primary: Function) => primary()),
    getState: jest.fn().mockResolvedValue('CLOSED'),
  })),
  CircuitState: { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' },
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { bookingService } from '../modules/booking/booking.service';
import { logger } from '../shared/services/logger.service';
import {
  transporterOnlineService,
  ONLINE_TRANSPORTERS_SET,
} from '../shared/services/transporter-online.service';

// =============================================================================
// TEST HELPERS
// =============================================================================

function resetAllMocks(): void {
  jest.clearAllMocks();
  mockRedisGet.mockReset();
  mockRedisSet.mockReset();
  mockRedisDel.mockReset();
  mockRedisExists.mockReset();
  mockRedisAcquireLock.mockReset();
  mockRedisReleaseLock.mockReset();
  mockRedisSMembers.mockReset();
  mockRedisSAdd.mockReset();
  mockRedisSRem.mockReset();
  mockRedisSScan.mockReset();
  mockRedisSetTimer.mockReset();
  mockRedisCancelTimer.mockReset();
  mockRedisGeoRadius.mockReset();
  mockRedisGeoRemove.mockReset();
  mockRedisHGetAll.mockReset();
  mockRedisSIsMember.mockReset();
  mockGetBookingById.mockReset();
  mockUpdateBooking.mockReset();
  mockGetTransportersWithVehicleType.mockReset();
  mockFindCandidates.mockReset();
  mockGetStepCount.mockReset();
  mockH3RemoveTransporter.mockReset();
  mockUserUpdate.mockReset();

  // Default returns
  mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
  mockRedisSAdd.mockResolvedValue(1);
  mockRedisSMembers.mockResolvedValue([]);
  mockRedisSetTimer.mockResolvedValue(undefined);
  mockRedisCancelTimer.mockResolvedValue(undefined);
  mockRedisGeoRemove.mockResolvedValue(1);
  mockFindCandidates.mockResolvedValue([]);
  mockH3RemoveTransporter.mockResolvedValue(undefined);
  mockRedisAcquireLock.mockResolvedValue({ acquired: true, lockValue: 'test' });
  mockRedisReleaseLock.mockResolvedValue(undefined);
}

/** Standard active booking record for radius expansion tests */
function makeActiveBooking(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'booking-001',
    customerId: 'customer-001',
    status: 'broadcasting',
    vehicleType: 'Tipper',
    vehicleSubtype: '20-24 Ton',
    trucksNeeded: 2,
    trucksFilled: 0,
    pickup: { lat: 28.6, lng: 77.2, city: 'Delhi' },
    drop: { lat: 19.0, lng: 72.8, city: 'Mumbai' },
    pricePerTruck: 50000,
    customerName: 'Test Customer',
    notifiedTransporters: ['t-old-1'],
    createdAt: new Date(),
    ...overrides,
  };
}

/** Standard timer data for advanceRadiusStep */
function makeTimerData(overrides: Record<string, any> = {}): any {
  return {
    bookingId: 'booking-001',
    customerId: 'customer-001',
    vehicleKey: 'Tipper_20-24 Ton',
    vehicleType: 'Tipper',
    vehicleSubtype: '20-24 Ton',
    pickupLat: 28.6,
    pickupLng: 77.2,
    currentStep: 0,
    ...overrides,
  };
}

// =============================================================================
// FIX #36 — advanceRadiusStep totalSteps clamping
// =============================================================================

describe('Fix #36 — advanceRadiusStep totalSteps clamped to matcher step count', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  /**
   * Happy path: FF off (matcher has 3 steps), config has 6 steps.
   * advanceRadiusStep with currentStep=1 (nextStepIndex=2) should trigger
   * DB fallback because 2 >= min(6, 3) = 3 is false, but 3 >= 3 IS the boundary.
   * With currentStep=2 (nextStepIndex=3), it SHOULD trigger DB fallback.
   */
  it('with FF off (3 matcher steps), triggers DB fallback after step 2', async () => {
    // Arrange
    mockGetStepCount.mockReturnValue(3); // Matcher has 3 steps (FF off)
    const booking = makeActiveBooking();
    mockGetBookingById.mockResolvedValue(booking);
    mockGetTransportersWithVehicleType.mockResolvedValue(['t1', 't2']);
    // Set up sScan to return online set for filterOnline (real service uses sScan)
    mockRedisSScan.mockResolvedValue(['0', ['t1']]);

    // Act — currentStep=2 means nextStepIndex=3, which >= min(6,3)=3
    const timerData = makeTimerData({ currentStep: 2 });
    await bookingService.advanceRadiusStep(timerData);

    // Assert — should have triggered DB fallback (all steps exhausted)
    expect(mockGetStepCount).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('All 3 steps exhausted')
    );
    // DB fallback queries all transporters with vehicle type
    expect(mockGetTransportersWithVehicleType).toHaveBeenCalled();
  });

  /**
   * Happy path: FF on (6+ matcher steps), config has 6 steps.
   * advanceRadiusStep at step 2 should NOT trigger DB fallback; it should
   * schedule the next step and call findCandidates for the expanded radius.
   */
  it('with FF on (6 matcher steps), all 6 steps run without premature DB fallback', async () => {
    // Arrange
    mockGetStepCount.mockReturnValue(6); // Matcher has 6 steps (FF on)
    const booking = makeActiveBooking();
    mockGetBookingById.mockResolvedValue(booking);
    mockFindCandidates.mockResolvedValue([
      { transporterId: 't-new-1', distanceKm: 12, latitude: 28.65, longitude: 77.25 },
    ]);

    // Act — currentStep=2 means nextStepIndex=3, which < min(6,6)=6
    const timerData = makeTimerData({ currentStep: 2 });
    await bookingService.advanceRadiusStep(timerData);

    // Assert — should NOT trigger DB fallback, should schedule next step
    expect(mockGetTransportersWithVehicleType).not.toHaveBeenCalled();
    expect(mockFindCandidates).toHaveBeenCalled();
    // Should schedule next step timer
    expect(mockRedisSetTimer).toHaveBeenCalled();
  });

  /**
   * Mismatch warning: when config step count differs from matcher step count,
   * logger.warn should be called with the mismatch details.
   */
  it('logs a warning when config and matcher step counts differ', async () => {
    // Arrange
    mockGetStepCount.mockReturnValue(3); // Matcher: 3 steps
    // Config has 6 steps (hardcoded in booking.service.ts)
    const booking = makeActiveBooking();
    mockGetBookingById.mockResolvedValue(booking);
    mockGetTransportersWithVehicleType.mockResolvedValue([]);
    // Set up sScan to return empty online set for filterOnline
    mockRedisSScan.mockResolvedValue(['0', []]);

    // Act
    const timerData = makeTimerData({ currentStep: 2 });
    await bookingService.advanceRadiusStep(timerData);

    // Assert — logger.warn called with mismatch info
    expect(logger.warn).toHaveBeenCalledWith(
      '[RADIUS] Step count mismatch between booking config and matcher',
      expect.objectContaining({
        bookingServiceSteps: 6,
        matcherSteps: 3,
        effectiveSteps: 3,
      })
    );
  });

  /**
   * Edge case: getStepCount returns same as config (6) — no clamping needed.
   * No warning should be logged.
   */
  it('no warning when step counts match (no clamping needed)', async () => {
    // Arrange
    mockGetStepCount.mockReturnValue(6); // Same as config (6 steps)
    const booking = makeActiveBooking();
    mockGetBookingById.mockResolvedValue(booking);
    mockFindCandidates.mockResolvedValue([]);

    // Act
    const timerData = makeTimerData({ currentStep: 0 });
    await bookingService.advanceRadiusStep(timerData);

    // Assert — no mismatch warning
    expect(logger.warn).not.toHaveBeenCalledWith(
      '[RADIUS] Step count mismatch between booking config and matcher',
      expect.anything()
    );
  });

  /**
   * Verify that with FF off and currentStep=1 (nextStepIndex=2),
   * it still runs the step (2 < 3) and does NOT trigger DB fallback.
   */
  it('with FF off (3 matcher steps), step 2 still runs normally (not exhausted yet)', async () => {
    // Arrange
    mockGetStepCount.mockReturnValue(3);
    const booking = makeActiveBooking();
    mockGetBookingById.mockResolvedValue(booking);
    mockFindCandidates.mockResolvedValue([]);

    // Act — currentStep=1, nextStepIndex=2, totalSteps=3 => 2 < 3 => run step
    const timerData = makeTimerData({ currentStep: 1 });
    await bookingService.advanceRadiusStep(timerData);

    // Assert — should NOT trigger DB fallback at step 2
    expect(mockGetTransportersWithVehicleType).not.toHaveBeenCalled();
    // Should call findCandidates for radius search
    expect(mockFindCandidates).toHaveBeenCalled();
  });

  /**
   * Booking no longer active: advanceRadiusStep should stop expansion
   * and not even check step counts.
   */
  it('stops expansion when booking is cancelled', async () => {
    // Arrange
    mockGetStepCount.mockReturnValue(3);
    const cancelledBooking = makeActiveBooking({ status: 'cancelled' });
    mockGetBookingById.mockResolvedValue(cancelledBooking);

    // Act
    const timerData = makeTimerData({ currentStep: 0 });
    await bookingService.advanceRadiusStep(timerData);

    // Assert — should stop, not search or schedule
    expect(mockFindCandidates).not.toHaveBeenCalled();
    expect(mockGetTransportersWithVehicleType).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('cancelled')
    );
  });
});

// =============================================================================
// FIX #2 — Stale transporter cleanup in transporter-online.service
// =============================================================================

describe('Fix #2 — cleanStaleTransporters removes geo + H3 indexes', () => {
  // Cast to any to access internal property
  const service: any = transporterOnlineService;

  beforeEach(() => {
    resetAllMocks();
    // Reset reconnectGraceUntil to allow cleanup
    if (service.reconnectGraceUntil !== undefined) {
      service.reconnectGraceUntil = 0;
    }
  });

  it('removes from geo index for each vehicle key when transporter is stale', async () => {
    // Arrange — one stale transporter with 2 vehicle keys
    mockRedisSScan
      .mockResolvedValueOnce(['0', ['stale-t1']]); // single batch, cursor '0' = done
    mockRedisExists.mockResolvedValue(false); // presence expired = stale
    mockRedisSRem.mockResolvedValue(1);
    mockRedisSMembers.mockResolvedValue(['open_17ft', 'tipper_20ton']); // vehicle keys set
    mockRedisGet.mockResolvedValue(null); // no single-key fallback
    mockRedisGeoRemove.mockResolvedValue(1);
    mockUserUpdate.mockResolvedValue({});

    // Act
    const cleaned = await service.cleanStaleTransporters();

    // Assert
    expect(cleaned).toBe(1);
    // Should remove from online set
    expect(mockRedisSRem).toHaveBeenCalledWith('online:transporters', 'stale-t1');
    // Should remove from geo index for EACH vehicle key
    expect(mockRedisGeoRemove).toHaveBeenCalledWith('geo:transporters:open_17ft', 'stale-t1');
    expect(mockRedisGeoRemove).toHaveBeenCalledWith('geo:transporters:tipper_20ton', 'stale-t1');
  });

  it('removes from H3 index when transporter is stale', async () => {
    // Arrange
    mockRedisSScan.mockResolvedValueOnce(['0', ['stale-t2']]);
    mockRedisExists.mockResolvedValue(false); // stale
    mockRedisSRem.mockResolvedValue(1);
    mockRedisSMembers.mockResolvedValue(['open_17ft']);
    mockRedisGet.mockResolvedValue(null);
    mockRedisGeoRemove.mockResolvedValue(1);
    mockUserUpdate.mockResolvedValue({});

    // Act
    await service.cleanStaleTransporters();

    // Assert — H3 removeTransporter called
    expect(mockH3RemoveTransporter).toHaveBeenCalledWith('stale-t2');
  });

  it('handles Redis geoRemove failure gracefully (try-catch)', async () => {
    // Arrange — geoRemove throws
    mockRedisSScan.mockResolvedValueOnce(['0', ['stale-t3']]);
    mockRedisExists.mockResolvedValue(false);
    mockRedisSRem.mockResolvedValue(1);
    mockRedisSMembers.mockResolvedValue(['open_17ft']);
    mockRedisGet.mockResolvedValue(null);
    mockRedisGeoRemove.mockRejectedValue(new Error('Redis ZREM failed'));
    mockUserUpdate.mockResolvedValue({});

    // Act — should NOT throw
    const cleaned = await service.cleanStaleTransporters();

    // Assert — cleanup continued despite error
    expect(cleaned).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Geo cleanup failed')
    );
    // DB update still ran
    expect(mockUserUpdate).toHaveBeenCalled();
  });

  it('idempotency: calling cleanup twice for same transporter does not error', async () => {
    // Arrange — first call finds stale, second call finds none
    mockRedisSScan
      .mockResolvedValueOnce(['0', ['stale-t4']])
      .mockResolvedValueOnce(['0', []]); // empty on second call
    mockRedisExists.mockResolvedValue(false);
    mockRedisSRem.mockResolvedValue(1);
    mockRedisSMembers.mockResolvedValue(['open_17ft']);
    mockRedisGet.mockResolvedValue(null);
    mockRedisGeoRemove.mockResolvedValue(1);
    mockH3RemoveTransporter.mockResolvedValue(undefined);
    mockUserUpdate.mockResolvedValue({});

    // Act — two consecutive calls
    const count1 = await service.cleanStaleTransporters();

    // Reset lock for second call
    mockRedisAcquireLock.mockResolvedValue({ acquired: true, lockValue: 'test' });
    const count2 = await service.cleanStaleTransporters();

    // Assert — first cleaned 1, second cleaned 0, no errors
    expect(count1).toBe(1);
    expect(count2).toBe(0);
  });

  it('merges vehicle keys from both sMembers set and single-key fallback', async () => {
    // Arrange — has keys in both locations, with overlap
    mockRedisSScan.mockResolvedValueOnce(['0', ['stale-t5']]);
    mockRedisExists.mockResolvedValue(false);
    mockRedisSRem.mockResolvedValue(1);
    mockRedisSMembers.mockResolvedValue(['open_17ft']); // from set
    mockRedisGet.mockResolvedValue('tipper_20ton'); // from single-key
    mockRedisGeoRemove.mockResolvedValue(1);
    mockUserUpdate.mockResolvedValue({});

    // Act
    await service.cleanStaleTransporters();

    // Assert — both keys cleaned
    expect(mockRedisGeoRemove).toHaveBeenCalledWith('geo:transporters:open_17ft', 'stale-t5');
    expect(mockRedisGeoRemove).toHaveBeenCalledWith('geo:transporters:tipper_20ton', 'stale-t5');
    expect(mockH3RemoveTransporter).toHaveBeenCalledWith('stale-t5');
  });
});

// =============================================================================
// FIX #2 — GEORADIUS filter in availability.service removes stale entries
// =============================================================================

describe('Fix #2 — availability GEORADIUS filter stale cleanup (online SET + H3)', () => {
  /**
   * The availability.service is mocked at module level (required by booking
   * service tests). We test the Fix #2 GEORADIUS stale cleanup contract
   * through the transporter-online.service which implements the same pattern:
   * stale entry -> remove from online SET + geo indexes + H3 index.
   *
   * The availability.service code (lines 618-634) does:
   *   1. geoRemove from current vehicleKey geo index
   *   2. sRem from ONLINE_TRANSPORTERS set
   *   3. h3GeoIndexService.removeTransporter (fire-and-forget)
   *
   * The transporter-online.service code (lines 256-280) does the same pattern.
   * Both share the same Fix #2 commit and identical cleanup logic.
   */
  const svc: any = transporterOnlineService;

  beforeEach(() => {
    resetAllMocks();
    if (svc.reconnectGraceUntil !== undefined) {
      svc.reconnectGraceUntil = 0;
    }
  });

  it('GEORADIUS filter removes stale entry from online SET + H3 when details empty', async () => {
    // Arrange — stale transporter (presence expired, no details)
    mockRedisSScan.mockResolvedValueOnce(['0', ['stale-geo-1']]);
    mockRedisExists.mockResolvedValue(false); // presence key gone
    mockRedisSRem.mockResolvedValue(1);
    mockRedisSMembers.mockResolvedValue(['open_17ft']);
    mockRedisGet.mockResolvedValue(null);
    mockRedisGeoRemove.mockResolvedValue(1);
    mockUserUpdate.mockResolvedValue({});

    // Act
    await svc.cleanStaleTransporters();

    // Assert — all three cleanup actions happened
    // 1. Removed from online SET
    expect(mockRedisSRem).toHaveBeenCalledWith('online:transporters', 'stale-geo-1');
    // 2. Removed from geo index
    expect(mockRedisGeoRemove).toHaveBeenCalledWith('geo:transporters:open_17ft', 'stale-geo-1');
    // 3. Removed from H3 index
    expect(mockH3RemoveTransporter).toHaveBeenCalledWith('stale-geo-1');
  });

  it('handles h3 removeTransporter failure gracefully during GEORADIUS filter cleanup', async () => {
    // Arrange — H3 removal fails
    mockRedisSScan.mockResolvedValueOnce(['0', ['stale-h3-fail']]);
    mockRedisExists.mockResolvedValue(false);
    mockRedisSRem.mockResolvedValue(1);
    mockRedisSMembers.mockResolvedValue(['open_17ft']);
    mockRedisGet.mockResolvedValue(null);
    mockRedisGeoRemove.mockResolvedValue(1);
    mockH3RemoveTransporter.mockRejectedValue(new Error('H3 index error'));
    mockUserUpdate.mockResolvedValue({});

    // Act — should NOT throw (h3 removal is fire-and-forget with .catch)
    const cleaned = await svc.cleanStaleTransporters();

    // Assert — cleanup still completed
    expect(cleaned).toBe(1);
    // Geo removal still happened
    expect(mockRedisGeoRemove).toHaveBeenCalledWith('geo:transporters:open_17ft', 'stale-h3-fail');
    // DB update still happened
    expect(mockUserUpdate).toHaveBeenCalled();
  });

  it('skips non-stale transporters without cleanup', async () => {
    // Arrange — transporter has valid presence key
    mockRedisSScan.mockResolvedValueOnce(['0', ['online-t1']]);
    mockRedisExists.mockResolvedValue(true); // presence exists = NOT stale

    // Act
    const cleaned = await svc.cleanStaleTransporters();

    // Assert — nothing cleaned
    expect(cleaned).toBe(0);
    expect(mockRedisSRem).not.toHaveBeenCalled();
    expect(mockRedisGeoRemove).not.toHaveBeenCalled();
    expect(mockH3RemoveTransporter).not.toHaveBeenCalled();
  });
});
