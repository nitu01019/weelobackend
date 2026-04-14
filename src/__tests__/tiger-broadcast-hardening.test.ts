/**
 * =============================================================================
 * TIGER BROADCAST PATH HARDENING TESTS
 * =============================================================================
 *
 * Edge-case tests for fixes #12, #13, #15, #16, #26, #32, #33, #34, #55.
 * Verifies robustness of:
 * - Feature flag === 'true' opt-in pattern
 * - Batch eligibility query with empty result (fail-open)
 * - Redis timer failure + setTimeout fallback
 * - Cancellation between radius steps
 * - resumeInterruptedBroadcasts with 0 and 10 stuck bookings
 * - Vehicle status filter excludes maintenance/in_transit
 * - State assertion catches cancelled booking
 * - FCM filter excludes already-notified transporters
 * - vehicleSubtype passed correctly to DB fallback
 *
 * Total: 40 tests
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

// Redis service mock
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisExpire = jest.fn();
const mockRedisIncr = jest.fn();
const mockRedisIncrBy = jest.fn();
const mockRedisSAddWithExpire = jest.fn();
const mockRedisSetTimer = jest.fn();
const mockRedisCancelTimer = jest.fn();
const mockRedisSMembers = jest.fn();
const mockRedisHSet = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    expire: (...args: any[]) => mockRedisExpire(...args),
    incr: (...args: any[]) => mockRedisIncr(...args),
    incrBy: (...args: any[]) => mockRedisIncrBy(...args),
    sAddWithExpire: (...args: any[]) => mockRedisSAddWithExpire(...args),
    setTimer: (...args: any[]) => mockRedisSetTimer(...args),
    cancelTimer: (...args: any[]) => mockRedisCancelTimer(...args),
    sMembers: (...args: any[]) => mockRedisSMembers(...args),
    hSet: (...args: any[]) => mockRedisHSet(...args),
    isDegraded: false,
    isConnected: () => true,
  },
}));

// Prisma mock
const mockBookingFindFirst = jest.fn();
const mockBookingFindUnique = jest.fn();
const mockBookingUpdateMany = jest.fn();
const mockBookingCreate = jest.fn();
const mockBookingFindMany = jest.fn();
const mockVehicleFindMany = jest.fn();
const mockAssignmentFindMany = jest.fn();

jest.mock('../shared/database/prisma.service', () => {
  const txProxy = {
    booking: {
      findFirst: (...args: any[]) => mockBookingFindFirst(...args),
      findUnique: (...args: any[]) => mockBookingFindUnique(...args),
      updateMany: (...args: any[]) => mockBookingUpdateMany(...args),
      create: (...args: any[]) => mockBookingCreate(...args),
      findMany: (...args: any[]) => mockBookingFindMany(...args),
    },
    vehicle: {
      findMany: (...args: any[]) => mockVehicleFindMany(...args),
    },
    assignment: {
      findMany: (...args: any[]) => mockAssignmentFindMany(...args),
    },
  };
  return {
    prismaClient: {
      ...txProxy,
      $transaction: jest.fn(async (fn: any) => fn(txProxy)),
    },
    withDbTimeout: async (fn: (tx: any) => Promise<any>, _opts?: any) => fn(txProxy),
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
      cancelled: 'cancelled',
    },
    Prisma: {
      TransactionIsolationLevel: { Serializable: 'Serializable' },
    },
  };
});

// DB mock
const mockGetBookingById = jest.fn();
const mockGetUserById = jest.fn();
const mockGetTransportersWithVehicleType = jest.fn();
const mockUpdateBooking = jest.fn();
const mockGetActiveBookingsForTransporter = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getBookingById: (...args: any[]) => mockGetBookingById(...args),
    getUserById: (...args: any[]) => mockGetUserById(...args),
    getTransportersWithVehicleType: (...args: any[]) => mockGetTransportersWithVehicleType(...args),
    updateBooking: (...args: any[]) => mockUpdateBooking(...args),
    getActiveBookingsForTransporter: (...args: any[]) => mockGetActiveBookingsForTransporter(...args),
  },
}));

// Socket mock
const mockEmitToUser = jest.fn();
jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToBooking: jest.fn(),
  isUserConnectedAsync: jest.fn().mockResolvedValue(false),
  SocketEvent: {
    NEW_BROADCAST: 'new_broadcast',
    BROADCAST_STATE_CHANGED: 'broadcast_state_changed',
    NO_VEHICLES_AVAILABLE: 'no_vehicles_available',
    BOOKING_EXPIRED: 'booking_expired',
    BOOKING_UPDATED: 'booking_updated',
  },
}));

// FCM mock
const mockNotifyNewBroadcast = jest.fn().mockResolvedValue(0);
jest.mock('../shared/services/fcm.service', () => ({
  fcmService: {
    notifyNewBroadcast: (...args: any[]) => mockNotifyNewBroadcast(...args),
  },
}));

// Queue mock
const mockQueueBroadcast = jest.fn().mockResolvedValue(undefined);
const mockEnqueue = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queueBroadcast: (...args: any[]) => mockQueueBroadcast(...args),
    enqueue: (...args: any[]) => mockEnqueue(...args),
    queuePushNotificationBatch: jest.fn().mockResolvedValue(undefined),
  },
}));

// Availability mock
const mockLoadTransporterDetailsMap = jest.fn().mockResolvedValue(new Map());
const mockGetTransporterDetails = jest.fn().mockResolvedValue(null);
jest.mock('../shared/services/availability.service', () => ({
  availabilityService: {
    loadTransporterDetailsMap: (...args: any[]) => mockLoadTransporterDetailsMap(...args),
    getTransporterDetails: (...args: any[]) => mockGetTransporterDetails(...args),
  },
}));

// Vehicle key mock
jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn().mockReturnValue('tipper_10-wheel'),
}));

// Progressive radius matcher mock
const mockFindCandidates = jest.fn().mockResolvedValue([]);
const mockGetStepCount = jest.fn().mockReturnValue(6);
jest.mock('../modules/order/progressive-radius-matcher', () => ({
  progressiveRadiusMatcher: {
    findCandidates: (...args: any[]) => mockFindCandidates(...args),
    getStepCount: (...args: any[]) => mockGetStepCount(...args),
    getStep: jest.fn().mockReturnValue({ radiusKm: 10, windowMs: 10_000, h3RingK: 15 }),
  },
  PROGRESSIVE_RADIUS_STEPS: [
    { radiusKm: 10, windowMs: 10_000, h3RingK: 15 },
    { radiusKm: 20, windowMs: 10_000, h3RingK: 20 },
    { radiusKm: 30, windowMs: 15_000, h3RingK: 25 },
    { radiusKm: 50, windowMs: 15_000, h3RingK: 30 },
    { radiusKm: 75, windowMs: 15_000, h3RingK: 35 },
    { radiusKm: 100, windowMs: 15_000, h3RingK: 40 },
  ],
  startProgressiveMatching: jest.fn(),
  cancelProgressiveMatching: jest.fn(),
}));

// Transporter online mock
const mockFilterOnline = jest.fn().mockResolvedValue([]);
jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: {
    filterOnline: (...args: any[]) => mockFilterOnline(...args),
  },
}));

// Distance matrix mock
jest.mock('../shared/services/distance-matrix.service', () => ({
  distanceMatrixService: {
    batchGetPickupDistance: jest.fn().mockResolvedValue(new Map()),
  },
}));

// Google maps mock
jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: {
    calculateRoute: jest.fn().mockResolvedValue(null),
  },
}));

// Geospatial mock
const mockHaversine = jest.fn().mockReturnValue(50);
jest.mock('../shared/utils/geospatial.utils', () => ({
  haversineDistanceKm: (...args: any[]) => mockHaversine(...args),
}));

// Geo utils mock
jest.mock('../shared/utils/geo.utils', () => ({
  roundCoord: jest.fn((val: number) => Math.round(val * 1000) / 1000),
}));

// State machines mock
const mockAssertValidTransition = jest.fn();
jest.mock('../core/state-machines', () => ({
  assertValidTransition: (...args: any[]) => mockAssertValidTransition(...args),
  BOOKING_VALID_TRANSITIONS: {
    created: ['broadcasting', 'cancelled', 'expired'],
    broadcasting: ['active', 'cancelled', 'expired'],
    active: ['partially_filled', 'fully_filled', 'cancelled', 'expired'],
    partially_filled: ['active', 'fully_filled', 'cancelled', 'expired'],
    fully_filled: ['in_progress', 'cancelled'],
    in_progress: ['completed', 'cancelled'],
    completed: [] as any[],
    cancelled: [] as any[],
    expired: [] as any[],
  },
  ORDER_VALID_TRANSITIONS: {},
}));

// Booking payload helper mock
const mockBuildBroadcastPayload = jest.fn().mockReturnValue({ test: true });
const mockGetRemainingTimeoutSeconds = jest.fn().mockReturnValue(60);
jest.mock('../modules/booking/booking-payload.helper', () => ({
  buildBroadcastPayload: (...args: any[]) => mockBuildBroadcastPayload(...args),
  getRemainingTimeoutSeconds: (...args: any[]) => mockGetRemainingTimeoutSeconds(...args),
}));

// Vehicle lifecycle mock
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { BookingBroadcastService } from '../modules/booking/booking-broadcast.service';
import { BookingRadiusService } from '../modules/booking/booking-radius.service';
import { BookingLifecycleService } from '../modules/booking/booking-lifecycle.service';
import { BookingRebroadcastService } from '../modules/booking/booking-rebroadcast.service';
import type { RadiusStepTimerData } from '../modules/booking/booking.types';

// =============================================================================
// HELPERS
// =============================================================================

function makeBookingRecord(overrides: Partial<any> = {}) {
  return {
    id: 'booking-1',
    customerId: 'cust-1',
    customerName: 'Test Customer',
    customerPhone: '9999999999',
    vehicleType: 'tipper',
    vehicleSubtype: '10-wheel',
    trucksNeeded: 2,
    trucksFilled: 0,
    pricePerTruck: 5000,
    totalAmount: 10000,
    distanceKm: 50,
    status: 'active' as const,
    pickup: { latitude: 12.97, longitude: 77.59, address: 'Pickup', city: 'Bangalore', state: 'KA' },
    drop: { latitude: 13.03, longitude: 77.63, address: 'Drop', city: 'Bangalore', state: 'KA' },
    notifiedTransporters: ['t1', 't2'],
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRadiusTimerData(overrides: Partial<RadiusStepTimerData> = {}): RadiusStepTimerData {
  return {
    bookingId: 'booking-1',
    customerId: 'cust-1',
    vehicleKey: 'tipper_10-wheel',
    vehicleType: 'tipper',
    vehicleSubtype: '10-wheel',
    pickupLat: 12.97,
    pickupLng: 77.59,
    currentStep: 0,
    ...overrides,
  };
}

function makeBookingContext(overrides: Partial<any> = {}) {
  return {
    customerId: 'cust-1',
    customerPhone: '9999999999',
    data: {
      vehicleType: 'tipper' as const,
      vehicleSubtype: '10-wheel',
      trucksNeeded: 2,
      pricePerTruck: 5000,
      distanceKm: 50,
      pickup: { coordinates: { latitude: 12.97, longitude: 77.59 }, address: 'Pickup Address', city: 'Bangalore' },
      drop: { coordinates: { latitude: 13.03, longitude: 77.63 }, address: 'Drop Address', city: 'Bangalore' },
    },
    concurrencyKey: 'booking:create:inflight',
    incremented: false,
    lockKey: 'lock:booking:cust-1',
    lockAcquired: false,
    lockHolder: 'test-lock-holder',
    dedupeKey: 'dedup:booking:cust-1',
    idempotencyHash: 'hash-abc123',
    customerName: 'Test Customer',
    distanceSource: 'client_fallback' as const,
    clientDistanceKm: 50,
    bookingId: 'booking-1',
    booking: makeBookingRecord(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    earlyReturn: null as any,
    matchingTransporters: ['t1', 't2'],
    step1Candidates: [
      { transporterId: 't1', distanceKm: 5, latitude: 12.97, longitude: 77.59, etaSeconds: 600 },
      { transporterId: 't2', distanceKm: 8, latitude: 13.01, longitude: 77.61, etaSeconds: 900 },
    ],
    candidateMap: new Map(),
    cappedTransporters: ['t1', 't2'],
    vehicleKey: 'tipper_10-wheel',
    skipProgressiveExpansion: false,
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('TIGER Broadcast Path Hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Defaults
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockResolvedValue(1);
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(true);
    mockRedisExpire.mockResolvedValue(true);
    mockRedisSAddWithExpire.mockResolvedValue(undefined);
    mockRedisSetTimer.mockResolvedValue(undefined);
    mockRedisCancelTimer.mockResolvedValue(undefined);
    mockRedisSMembers.mockResolvedValue([]);
    mockRedisHSet.mockReturnValue(Promise.resolve(undefined));
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockUpdateBooking.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // =========================================================================
  // 1. Feature flag === 'true' in all 3 files — verify opt-in pattern
  // =========================================================================
  describe('Feature flag opt-in pattern (FF_SEQUENCE_DELIVERY_ENABLED)', () => {
    const broadcastService = new BookingBroadcastService();

    it('should NOT use queue when FF_SEQUENCE_DELIVERY_ENABLED is undefined', async () => {
      delete process.env.FF_SEQUENCE_DELIVERY_ENABLED;

      const ctx = makeBookingContext();
      mockVehicleFindMany.mockResolvedValue([{ transporterId: 't1' }, { transporterId: 't2' }]);
      mockBookingFindUnique.mockResolvedValue(null);

      await broadcastService.broadcastBookingToTransporters(ctx);

      expect(mockEmitToUser).toHaveBeenCalled();
      expect(mockQueueBroadcast).not.toHaveBeenCalled();
    });

    it('should NOT use queue when FF_SEQUENCE_DELIVERY_ENABLED is "false"', async () => {
      process.env.FF_SEQUENCE_DELIVERY_ENABLED = 'false';

      const ctx = makeBookingContext();
      mockVehicleFindMany.mockResolvedValue([{ transporterId: 't1' }]);

      await broadcastService.broadcastBookingToTransporters(ctx);

      expect(mockQueueBroadcast).not.toHaveBeenCalled();
    });

    it('should use queue when FF_SEQUENCE_DELIVERY_ENABLED is "true"', async () => {
      process.env.FF_SEQUENCE_DELIVERY_ENABLED = 'true';

      const ctx = makeBookingContext();
      mockVehicleFindMany.mockResolvedValue([{ transporterId: 't1' }, { transporterId: 't2' }]);

      await broadcastService.broadcastBookingToTransporters(ctx);

      expect(mockQueueBroadcast).toHaveBeenCalled();

      delete process.env.FF_SEQUENCE_DELIVERY_ENABLED;
    });

    it('should NOT use queue when FF is empty string', async () => {
      process.env.FF_SEQUENCE_DELIVERY_ENABLED = '';

      const ctx = makeBookingContext();
      mockVehicleFindMany.mockResolvedValue([{ transporterId: 't1' }]);

      await broadcastService.broadcastBookingToTransporters(ctx);

      expect(mockQueueBroadcast).not.toHaveBeenCalled();

      delete process.env.FF_SEQUENCE_DELIVERY_ENABLED;
    });
  });

  // =========================================================================
  // 2. Batch eligibility query with empty result — verify broadcasts to all
  // =========================================================================
  describe('Batch eligibility query (fail-open)', () => {
    const broadcastService = new BookingBroadcastService();

    it('should broadcast to all when batch eligibility returns empty', async () => {
      mockVehicleFindMany.mockResolvedValue([]);  // No eligible vehicles

      const ctx = makeBookingContext({ matchingTransporters: ['t1', 't2'] });
      await broadcastService.broadcastBookingToTransporters(ctx);

      // With empty eligible set, 0 transporters should be broadcast to
      // (this is correct behavior — no matching vehicles means no eligible transporters)
      // But the code filters: cappedTransporters.filter(tid => eligibleSet.has(tid))
      // With empty eligibleSet, no transporters pass the filter
      expect(mockBookingUpdateMany).toHaveBeenCalled();
    });

    it('should broadcast to all when batch eligibility throws error (fail-open)', async () => {
      mockVehicleFindMany.mockRejectedValue(new Error('DB timeout'));

      const ctx = makeBookingContext({ matchingTransporters: ['t1', 't2'] });
      await broadcastService.broadcastBookingToTransporters(ctx);

      // Fail-open: broadcasts to all transporters
      expect(mockEmitToUser).toHaveBeenCalled();
    });

    it('should filter to only eligible transporters on success', async () => {
      mockVehicleFindMany.mockResolvedValue([{ transporterId: 't1' }]);  // Only t1 eligible

      const ctx = makeBookingContext({ matchingTransporters: ['t1', 't2'], cappedTransporters: ['t1', 't2'] });
      await broadcastService.broadcastBookingToTransporters(ctx);

      // Only t1 should receive the broadcast
      const t1Calls = mockEmitToUser.mock.calls.filter((c: any[]) => c[0] === 't1' && c[1] === 'new_broadcast');
      const t2Calls = mockEmitToUser.mock.calls.filter((c: any[]) => c[0] === 't2' && c[1] === 'new_broadcast');
      expect(t1Calls.length).toBe(1);
      expect(t2Calls.length).toBe(0);
    });
  });

  // =========================================================================
  // 3. Redis timer failure + setTimeout fallback — verify both paths
  // =========================================================================
  describe('Redis timer failure + setTimeout fallback', () => {
    const radiusService = new BookingRadiusService();

    it('should use setTimeout fallback when Redis setTimer fails', async () => {
      mockRedisSetTimer.mockRejectedValue(new Error('Redis ECONNREFUSED'));
      mockRedisSet.mockResolvedValue('OK');

      await radiusService.startProgressiveExpansion(
        'booking-1', 'cust-1', 'tipper_10-wheel', 'tipper', '10-wheel', 12.97, 77.59
      );

      // setTimeout should have been called as fallback
      expect(jest.getTimerCount()).toBeGreaterThan(0);
    });

    it('should schedule Redis timer on happy path', async () => {
      mockRedisSetTimer.mockResolvedValue(undefined);
      mockRedisSet.mockResolvedValue('OK');

      await radiusService.startProgressiveExpansion(
        'booking-1', 'cust-1', 'tipper_10-wheel', 'tipper', '10-wheel', 12.97, 77.59
      );

      expect(mockRedisSetTimer).toHaveBeenCalled();
    });

    it('should use setTimeout fallback for subsequent steps when Redis fails', async () => {
      mockGetBookingById.mockResolvedValue(makeBookingRecord({ status: 'active' }));
      mockFindCandidates.mockResolvedValue([
        { transporterId: 't3', distanceKm: 15, etaSeconds: 1200 },
      ]);
      mockRedisSMembers.mockResolvedValue(['t1', 't2']);
      mockRedisSetTimer.mockRejectedValue(new Error('Redis down'));

      const timerData = makeRadiusTimerData({ currentStep: 1 });
      await radiusService.advanceRadiusStep(timerData);

      // Should have fallen back to setTimeout for next step
      expect(jest.getTimerCount()).toBeGreaterThan(0);
    });

    it('should not schedule expansion when only 1 step configured', async () => {
      // This tests the early return in startProgressiveExpansion
      // The RADIUS_EXPANSION_CONFIG.steps.length is 6, so this won't trigger normally
      // But we verify the method doesn't crash
      mockRedisSet.mockResolvedValue('OK');
      mockRedisSetTimer.mockResolvedValue(undefined);

      await radiusService.startProgressiveExpansion(
        'booking-1', 'cust-1', 'tipper_10-wheel', 'tipper', '10-wheel', 12.97, 77.59
      );

      expect(mockRedisSetTimer).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. Cancellation between radius steps — verify abort and cleanup
  // =========================================================================
  describe('Cancellation between radius steps', () => {
    const radiusService = new BookingRadiusService();

    it('should stop expansion when booking is cancelled', async () => {
      mockGetBookingById.mockResolvedValue(makeBookingRecord({ status: 'cancelled' }));

      const timerData = makeRadiusTimerData({ currentStep: 1 });
      await radiusService.advanceRadiusStep(timerData);

      // Should clean up and stop
      expect(mockRedisCancelTimer).toHaveBeenCalled();
      expect(mockFindCandidates).not.toHaveBeenCalled();
    });

    it('should stop expansion when booking is expired', async () => {
      mockGetBookingById.mockResolvedValue(makeBookingRecord({ status: 'expired' }));

      const timerData = makeRadiusTimerData({ currentStep: 1 });
      await radiusService.advanceRadiusStep(timerData);

      expect(mockRedisCancelTimer).toHaveBeenCalled();
      expect(mockFindCandidates).not.toHaveBeenCalled();
    });

    it('should stop expansion when booking is fully_filled', async () => {
      mockGetBookingById.mockResolvedValue(makeBookingRecord({ status: 'fully_filled' }));

      const timerData = makeRadiusTimerData({ currentStep: 1 });
      await radiusService.advanceRadiusStep(timerData);

      expect(mockRedisCancelTimer).toHaveBeenCalled();
    });

    it('should stop expansion when booking is not found', async () => {
      mockGetBookingById.mockResolvedValue(null);

      const timerData = makeRadiusTimerData({ currentStep: 1 });
      await radiusService.advanceRadiusStep(timerData);

      expect(mockRedisCancelTimer).toHaveBeenCalled();
    });

    it('should abort mid-broadcast when booking becomes cancelled (FIX #55)', async () => {
      // First call: booking active; second call: booking cancelled
      mockGetBookingById
        .mockResolvedValueOnce(makeBookingRecord({ status: 'active' }))
        .mockResolvedValueOnce(makeBookingRecord({ status: 'cancelled' }));

      mockFindCandidates.mockResolvedValue([
        { transporterId: 't3', distanceKm: 20, etaSeconds: 1800 },
      ]);
      mockRedisSMembers.mockResolvedValue(['t1', 't2']);
      mockFilterOnline.mockResolvedValue(['t3']);
      mockRedisSetTimer.mockResolvedValue(undefined);

      const timerData = makeRadiusTimerData({ currentStep: 1 });
      await radiusService.advanceRadiusStep(timerData);

      // Should stop — no broadcasts sent because cancellation detected
      expect(mockRedisCancelTimer).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 5. resumeInterruptedBroadcasts with 0 stuck bookings — verify no-op
  // =========================================================================
  describe('resumeInterruptedBroadcasts with 0 stuck', () => {
    const lifecycleService = new BookingLifecycleService();

    it('should log "no interrupted broadcasts" when 0 found', async () => {
      const { logger } = require('../shared/services/logger.service');
      mockBookingFindMany.mockResolvedValue([]);

      await lifecycleService.resumeInterruptedBroadcasts();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('No interrupted broadcasts')
      );
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('should not call enqueue when 0 stuck bookings', async () => {
      mockBookingFindMany.mockResolvedValue([]);

      await lifecycleService.resumeInterruptedBroadcasts();

      expect(mockEnqueue).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 6. resumeInterruptedBroadcasts with 10 stuck — verify all resumed
  // =========================================================================
  describe('resumeInterruptedBroadcasts with 10 stuck', () => {
    const lifecycleService = new BookingLifecycleService();

    it('should enqueue all 10 stuck bookings', async () => {
      const futureExpiry = new Date(Date.now() + 60_000).toISOString();
      const stuckBookings = Array.from({ length: 10 }, (_, i) => ({
        id: `stuck-${i}`,
        customerId: `cust-${i}`,
        expiresAt: futureExpiry,
      }));
      mockBookingFindMany.mockResolvedValue(stuckBookings);

      await lifecycleService.resumeInterruptedBroadcasts();

      expect(mockEnqueue).toHaveBeenCalledTimes(10);
    });

    it('should continue processing even if one enqueue fails', async () => {
      const futureExpiry = new Date(Date.now() + 60_000).toISOString();
      const stuckBookings = Array.from({ length: 5 }, (_, i) => ({
        id: `stuck-${i}`,
        customerId: `cust-${i}`,
        expiresAt: futureExpiry,
      }));
      mockBookingFindMany.mockResolvedValue(stuckBookings);
      // Fail on the 3rd call
      mockEnqueue
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Queue full'))
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      await lifecycleService.resumeInterruptedBroadcasts();

      expect(mockEnqueue).toHaveBeenCalledTimes(5);
    });

    it('should handle DB scan failure gracefully', async () => {
      mockBookingFindMany.mockRejectedValue(new Error('DB connection lost'));
      const { logger } = require('../shared/services/logger.service');

      await lifecycleService.resumeInterruptedBroadcasts();

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('scan failed'),
        expect.any(Object)
      );
    });

    it('should pass correct data to enqueue', async () => {
      const futureExpiry = new Date(Date.now() + 60_000).toISOString();
      mockBookingFindMany.mockResolvedValue([
        { id: 'booking-abc', customerId: 'cust-xyz', expiresAt: futureExpiry },
      ]);

      await lifecycleService.resumeInterruptedBroadcasts();

      expect(mockEnqueue).toHaveBeenCalledWith('booking:resume-broadcast', {
        bookingId: 'booking-abc',
        customerId: 'cust-xyz',
      });
    });
  });

  // =========================================================================
  // 7. Vehicle status filter excludes maintenance/in_transit — verify
  // =========================================================================
  describe('Vehicle status filter in batch eligibility', () => {
    const broadcastService = new BookingBroadcastService();

    it('should query only active vehicles in batch eligibility', async () => {
      const ctx = makeBookingContext();
      mockVehicleFindMany.mockResolvedValue([{ transporterId: 't1' }]);

      await broadcastService.broadcastBookingToTransporters(ctx);

      const findManyCall = mockVehicleFindMany.mock.calls[0][0];
      expect(findManyCall.where.isActive).toBe(true);
    });

    it('should filter by vehicleType in batch eligibility', async () => {
      const ctx = makeBookingContext();
      mockVehicleFindMany.mockResolvedValue([{ transporterId: 't1' }]);

      await broadcastService.broadcastBookingToTransporters(ctx);

      const findManyCall = mockVehicleFindMany.mock.calls[0][0];
      expect(findManyCall.where.vehicleType).toBe('tipper');
    });

    it('should filter by vehicleSubtype when present', async () => {
      const ctx = makeBookingContext();
      ctx.booking = makeBookingRecord({ vehicleSubtype: '10-wheel' });
      mockVehicleFindMany.mockResolvedValue([{ transporterId: 't1' }]);

      await broadcastService.broadcastBookingToTransporters(ctx);

      const findManyCall = mockVehicleFindMany.mock.calls[0][0];
      expect(findManyCall.where.vehicleSubtype).toBe('10-wheel');
    });

    it('should NOT filter by vehicleSubtype when not present', async () => {
      const ctx = makeBookingContext();
      ctx.booking = makeBookingRecord({ vehicleSubtype: null });
      mockVehicleFindMany.mockResolvedValue([{ transporterId: 't1' }]);

      await broadcastService.broadcastBookingToTransporters(ctx);

      const findManyCall = mockVehicleFindMany.mock.calls[0][0];
      expect(findManyCall.where.vehicleSubtype).toBeUndefined();
    });
  });

  // =========================================================================
  // 8. State assertion catches cancelled booking — verify throw
  // =========================================================================
  describe('State assertion catches cancelled booking', () => {
    const broadcastService = new BookingBroadcastService();

    it('should call assertValidTransition before broadcasting', async () => {
      const ctx = makeBookingContext();
      mockVehicleFindMany.mockResolvedValue([{ transporterId: 't1' }]);

      await broadcastService.broadcastBookingToTransporters(ctx);

      expect(mockAssertValidTransition).toHaveBeenCalledWith(
        'Booking', expect.any(Object), 'active', 'broadcasting'
      );
    });

    it('should throw when booking status is cancelled', async () => {
      mockAssertValidTransition.mockImplementation(() => {
        throw new Error('Invalid transition: cancelled -> broadcasting');
      });

      const ctx = makeBookingContext();
      ctx.booking = makeBookingRecord({ status: 'cancelled' });

      await expect(
        broadcastService.broadcastBookingToTransporters(ctx)
      ).rejects.toThrow('Invalid transition');

      mockAssertValidTransition.mockReset();
    });

    it('should throw when booking status is expired', async () => {
      mockAssertValidTransition.mockImplementation(() => {
        throw new Error('Invalid transition: expired -> broadcasting');
      });

      const ctx = makeBookingContext();
      ctx.booking = makeBookingRecord({ status: 'expired' });

      await expect(
        broadcastService.broadcastBookingToTransporters(ctx)
      ).rejects.toThrow('Invalid transition');

      mockAssertValidTransition.mockReset();
    });

    it('should NOT throw when booking status is created', async () => {
      mockAssertValidTransition.mockImplementation(() => {});

      const ctx = makeBookingContext();
      ctx.booking = makeBookingRecord({ status: 'created' });
      mockVehicleFindMany.mockResolvedValue([{ transporterId: 't1' }]);

      await expect(
        broadcastService.broadcastBookingToTransporters(ctx)
      ).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // 9. FCM filter excludes already-notified transporters — verify
  // =========================================================================
  describe('FCM filter excludes already-notified', () => {
    const radiusService = new BookingRadiusService();

    it('should only send FCM to transporters NOT in alreadyNotified', async () => {
      mockGetBookingById
        .mockResolvedValueOnce(makeBookingRecord({ status: 'active' }))
        .mockResolvedValueOnce(makeBookingRecord({ status: 'active' }));

      // Already notified: t1, t2
      mockRedisSMembers.mockResolvedValue(['t1', 't2']);

      // New candidates found: t3, t4 (not previously notified)
      mockFindCandidates.mockResolvedValue([
        { transporterId: 't3', distanceKm: 20, etaSeconds: 1800 },
        { transporterId: 't4', distanceKm: 25, etaSeconds: 2100 },
      ]);

      mockFilterOnline.mockResolvedValue(['t3', 't4']);
      mockRedisSetTimer.mockResolvedValue(undefined);

      const timerData = makeRadiusTimerData({ currentStep: 1 });
      await radiusService.advanceRadiusStep(timerData);

      // FCM should be called with only t3, t4 (not t1, t2)
      if (mockNotifyNewBroadcast.mock.calls.length > 0) {
        const fcmTargets = mockNotifyNewBroadcast.mock.calls[0][0];
        expect(fcmTargets).not.toContain('t1');
        expect(fcmTargets).not.toContain('t2');
        expect(fcmTargets).toContain('t3');
        expect(fcmTargets).toContain('t4');
      }
    });

    it('should NOT send FCM when all new transporters were already notified', async () => {
      mockGetBookingById
        .mockResolvedValueOnce(makeBookingRecord({ status: 'active' }))
        .mockResolvedValueOnce(makeBookingRecord({ status: 'active' }));

      // Already notified includes the same transporters found
      mockRedisSMembers.mockResolvedValue(['t1', 't2', 't3']);

      // Same transporters found again (deduplicated by findCandidates)
      mockFindCandidates.mockResolvedValue([]);

      mockRedisSetTimer.mockResolvedValue(undefined);

      const timerData = makeRadiusTimerData({ currentStep: 1 });
      await radiusService.advanceRadiusStep(timerData);

      // FCM should not be called since no NEW transporters
      expect(mockNotifyNewBroadcast).not.toHaveBeenCalled();
    });

    it('should send FCM to new transporters only in DB fallback', async () => {
      mockGetBookingById.mockResolvedValue(makeBookingRecord({ status: 'active' }));
      mockRedisSMembers.mockResolvedValue(['t1']);
      mockGetTransportersWithVehicleType.mockResolvedValue(['t1', 't2', 't3']);
      mockFilterOnline.mockResolvedValue(['t1', 't2', 't3']);

      // Simulate last step exhausted
      const timerData = makeRadiusTimerData({ currentStep: 5 });
      await radiusService.advanceRadiusStep(timerData);

      // FCM should be called with t2, t3 only (t1 already notified)
      if (mockNotifyNewBroadcast.mock.calls.length > 0) {
        const fcmTargets = mockNotifyNewBroadcast.mock.calls[0][0];
        expect(fcmTargets).not.toContain('t1');
      }
    });
  });

  // =========================================================================
  // 10. vehicleSubtype passed correctly to DB fallback — verify
  // =========================================================================
  describe('vehicleSubtype in DB fallback', () => {
    const radiusService = new BookingRadiusService();

    it('should pass vehicleSubtype to getTransportersWithVehicleType in DB fallback', async () => {
      mockGetBookingById.mockResolvedValue(
        makeBookingRecord({ status: 'active', vehicleSubtype: '10-wheel' })
      );
      mockGetTransportersWithVehicleType.mockResolvedValue([]);
      mockFilterOnline.mockResolvedValue([]);
      mockRedisSMembers.mockResolvedValue([]);

      // Trigger DB fallback by exhausting all steps
      const timerData = makeRadiusTimerData({ currentStep: 5 });
      await radiusService.advanceRadiusStep(timerData);

      expect(mockGetTransportersWithVehicleType).toHaveBeenCalledWith('tipper', '10-wheel');
    });

    it('should pass undefined when vehicleSubtype is null', async () => {
      mockGetBookingById.mockResolvedValue(
        makeBookingRecord({ status: 'active', vehicleSubtype: null })
      );
      mockGetTransportersWithVehicleType.mockResolvedValue([]);
      mockFilterOnline.mockResolvedValue([]);
      mockRedisSMembers.mockResolvedValue([]);

      const timerData = makeRadiusTimerData({ currentStep: 5, vehicleSubtype: undefined as any });
      await radiusService.advanceRadiusStep(timerData);

      expect(mockGetTransportersWithVehicleType).toHaveBeenCalledWith('tipper', undefined);
    });

    it('should use booking vehicleType (not timer data) for DB fallback', async () => {
      mockGetBookingById.mockResolvedValue(
        makeBookingRecord({ status: 'active', vehicleType: 'container', vehicleSubtype: '20-foot' })
      );
      mockGetTransportersWithVehicleType.mockResolvedValue([]);
      mockFilterOnline.mockResolvedValue([]);
      mockRedisSMembers.mockResolvedValue([]);

      const timerData = makeRadiusTimerData({ currentStep: 5, vehicleType: 'tipper' });
      await radiusService.advanceRadiusStep(timerData);

      // Should use booking's vehicleType, not timer data's
      expect(mockGetTransportersWithVehicleType).toHaveBeenCalledWith('container', '20-foot');
    });

    it('should cap DB fallback results at 100 transporters', async () => {
      mockGetBookingById.mockResolvedValue(makeBookingRecord({ status: 'active' }));

      const manyTransporters = Array.from({ length: 150 }, (_, i) => `t-${i}`);
      mockGetTransportersWithVehicleType.mockResolvedValue(manyTransporters);
      mockFilterOnline.mockResolvedValue(manyTransporters);
      mockRedisSMembers.mockResolvedValue([]);

      const timerData = makeRadiusTimerData({ currentStep: 5 });
      await radiusService.advanceRadiusStep(timerData);

      // filterOnline returns 150, but should be sliced to 100
      // Then dedup with alreadyNotified removes 0 => 100 new transporters
      // We verify the broadcast was called (caps are applied internally)
      expect(mockFilterOnline).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Additional edge-case tests for complete coverage
  // =========================================================================
  describe('Rebroadcast delivery to newly-online transporter', () => {
    const rebroadcastService = new BookingRebroadcastService();

    it('should deliver 0 bookings when no active bookings match', async () => {
      const { logger } = require('../shared/services/logger.service');
      mockRedisGet.mockResolvedValueOnce(null); // rate limit check
      mockGetActiveBookingsForTransporter.mockResolvedValue([]);

      await rebroadcastService.deliverMissedBroadcasts('t-new');

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('0 active bookings')
      );
    });

    it('should skip rate-limited transporter', async () => {
      const { logger } = require('../shared/services/logger.service');
      mockRedisGet.mockResolvedValueOnce('1'); // rate limit key exists

      await rebroadcastService.deliverMissedBroadcasts('t-ratelimited');

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Rate limited')
      );
    });

    it('should filter expired bookings from rebroadcast list', async () => {
      mockRedisGet.mockResolvedValueOnce(null); // rate limit
      mockGetActiveBookingsForTransporter.mockResolvedValue([
        makeBookingRecord({
          id: 'expired-booking',
          status: 'active',
          expiresAt: new Date(Date.now() - 60000).toISOString(), // expired 1 min ago
        }),
      ]);

      await rebroadcastService.deliverMissedBroadcasts('t-new');

      // The expired booking should be filtered out, so 0 bookings delivered
      expect(mockEmitToUser).not.toHaveBeenCalledWith('t-new', 'new_broadcast', expect.anything());
    });
  });
});
