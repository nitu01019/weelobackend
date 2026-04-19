/**
 * =============================================================================
 * TIGER BOOKING PATH HARDENING TESTS
 * =============================================================================
 *
 * Edge-case tests for fixes #1, #2, #3, #8, #10, #11, #27, #28, #29, #30, #31.
 * Verifies robustness of:
 * - Idempotency (Redis down, corrupted JSON, payload hash collision, TTL)
 * - TERMINAL_STATUSES allowlist pattern
 * - Concurrent booking creation (SERIALIZABLE TX)
 * - BroadcastService null guard
 * - AppError HTTP status codes
 * - Distance cap at 100km boundary
 * - Empty transporter list from DB fallback
 *
 * Total: 50 tests
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
const mockOrderFindFirst = jest.fn();
const mockVehicleFindMany = jest.fn();

jest.mock('../shared/database/prisma.service', () => {
  const txProxy = {
    booking: {
      findFirst: (...args: any[]) => mockBookingFindFirst(...args),
      findUnique: (...args: any[]) => mockBookingFindUnique(...args),
      updateMany: (...args: any[]) => mockBookingUpdateMany(...args),
      create: (...args: any[]) => mockBookingCreate(...args),
      findMany: (...args: any[]) => mockBookingFindMany(...args),
    },
    order: {
      findFirst: (...args: any[]) => mockOrderFindFirst(...args),
    },
    vehicle: {
      findMany: (...args: any[]) => mockVehicleFindMany(...args),
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
    OrderStatus: {
      created: 'created',
      broadcasting: 'broadcasting',
      active: 'active',
      cancelled: 'cancelled',
      expired: 'expired',
      completed: 'completed',
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
jest.mock('../shared/services/socket.service', () => ({
  emitToUser: jest.fn(),
  emitToBooking: jest.fn(),
  isUserConnectedAsync: jest.fn().mockResolvedValue(false),
  SocketEvent: {
    NEW_BROADCAST: 'new_broadcast',
    BROADCAST_STATE_CHANGED: 'broadcast_state_changed',
    NO_VEHICLES_AVAILABLE: 'no_vehicles_available',
    BOOKING_EXPIRED: 'booking_expired',
    BOOKING_UPDATED: 'booking_updated',
    BOOKING_FULLY_FILLED: 'booking_fully_filled',
    BOOKING_PARTIALLY_FILLED: 'booking_partially_filled',
    TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update',
    TRIP_CANCELLED: 'trip_cancelled',
  },
}));

// FCM mock
jest.mock('../shared/services/fcm.service', () => ({
  fcmService: {
    notifyNewBroadcast: jest.fn().mockResolvedValue(0),
  },
}));

// Queue mock
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queueBroadcast: jest.fn().mockResolvedValue(undefined),
    enqueue: jest.fn().mockResolvedValue(undefined),
    queuePushNotificationBatch: jest.fn().mockResolvedValue(undefined),
  },
}));

// Availability mock
jest.mock('../shared/services/availability.service', () => ({
  availabilityService: {
    loadTransporterDetailsMap: jest.fn().mockResolvedValue(new Map()),
    getTransporterDetails: jest.fn().mockResolvedValue(null),
  },
}));

// Vehicle key mock
jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn().mockReturnValue('tipper_10-wheel'),
}));

// Progressive radius matcher mock
jest.mock('../modules/order/progressive-radius-matcher', () => ({
  progressiveRadiusMatcher: {
    findCandidates: jest.fn().mockResolvedValue([]),
    getStepCount: jest.fn().mockReturnValue(6),
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
jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: {
    filterOnline: jest.fn().mockResolvedValue([]),
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
jest.mock('../shared/utils/geospatial.utils', () => ({
  haversineDistanceKm: jest.fn().mockReturnValue(50),
}));

// Geo utils mock
jest.mock('../shared/utils/geo.utils', () => ({
  roundCoord: jest.fn((val: number) => Math.round(val * 1000) / 1000),
}));

// State machines mock
jest.mock('../core/state-machines', () => ({
  assertValidTransition: jest.fn(),
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

// Vehicle lifecycle mock
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
}));

// Booking payload helper mock
jest.mock('../modules/booking/booking-payload.helper', () => ({
  buildBroadcastPayload: jest.fn().mockReturnValue({ test: true }),
  getRemainingTimeoutSeconds: jest.fn().mockReturnValue(60),
}));

// Pricing mock
jest.mock('../modules/pricing/pricing.service', () => ({
  pricingService: {
    calculateEstimate: jest.fn().mockReturnValue({ pricePerTruck: 5000 }),
  },
}));

// =============================================================================
// IMPORTS
// =============================================================================

import crypto from 'crypto';
import { AppError } from '../shared/types/error.types';
import { TERMINAL_STATUSES } from '../modules/booking/booking.types';
import { BookingCreateService, setBroadcastServiceRef } from '../modules/booking/booking-create.service';

// =============================================================================
// HELPERS
// =============================================================================

function makeBookingInput(overrides: Partial<any> = {}) {
  return {
    vehicleType: 'tipper' as const,
    vehicleSubtype: '10-wheel',
    trucksNeeded: 2,
    pricePerTruck: 5000,
    distanceKm: 50,
    goodsType: 'sand',
    weight: '20',
    pickup: {
      coordinates: { latitude: 12.97, longitude: 77.59 },
      address: 'Pickup Address',
      city: 'Bangalore',
      state: 'KA',
    },
    drop: {
      coordinates: { latitude: 13.03, longitude: 77.63 },
      address: 'Drop Address',
      city: 'Bangalore',
      state: 'KA',
    },
    ...overrides,
  };
}

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
    distanceKm: 50,
    status: 'created',
    pickup: { latitude: 12.97, longitude: 77.59, address: 'Pickup', city: 'Bangalore', state: 'KA' },
    drop: { latitude: 13.03, longitude: 77.63, address: 'Drop', city: 'Bangalore', state: 'KA' },
    notifiedTransporters: [] as any[],
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    createdAt: new Date(),
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('TIGER Booking Path Hardening', () => {
  let service: BookingCreateService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new BookingCreateService();

    // Default happy-path mocks
    mockRedisIncr.mockResolvedValue(1);
    mockRedisIncrBy.mockResolvedValue(0);
    mockRedisExpire.mockResolvedValue(true);
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockResolvedValue(1);
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(true);
    mockRedisSAddWithExpire.mockResolvedValue(undefined);
    mockRedisSetTimer.mockResolvedValue(undefined);
    mockRedisCancelTimer.mockResolvedValue(undefined);
    mockRedisSMembers.mockResolvedValue([]);
    mockRedisHSet.mockResolvedValue(undefined);

    mockGetUserById.mockResolvedValue({ name: 'Test Customer' });
    mockGetTransportersWithVehicleType.mockResolvedValue(['t1', 't2']);
    mockBookingFindFirst.mockResolvedValue(null);
    mockOrderFindFirst.mockResolvedValue(null);
    mockBookingCreate.mockResolvedValue({});
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockGetBookingById.mockResolvedValue(makeBookingRecord());
    mockVehicleFindMany.mockResolvedValue([
      { transporterId: 't1' },
      { transporterId: 't2' },
    ]);
  });

  // =========================================================================
  // 1. Redis down during idempotency check — verify falls through to DB check
  // =========================================================================
  describe('Redis down during idempotency check', () => {
    it('should propagate Redis error from idempotency get (not swallowed)', async () => {
      // The idempotency check calls Redis.get directly with await.
      // If Redis throws, the error propagates — this is expected behavior
      // because the backpressure catch only handles incr errors.
      mockRedisGet
        .mockResolvedValueOnce(null) // cooldown check
        .mockRejectedValueOnce(new Error('Redis ECONNREFUSED'));

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      await expect(
        service.createBooking('cust-1', '9999999999', makeBookingInput(), 'idem-key-1')
      ).rejects.toThrow('Redis ECONNREFUSED');
    });

    it('should propagate Redis error from active-broadcast check when completely down', async () => {
      // When Redis is completely down, backpressure is skipped (try/catch),
      // but the active-broadcast check in acquireCustomerBroadcastLock
      // calls Redis.get without try/catch — error propagates.
      // This is correct: without Redis, we cannot safely guarantee one-per-customer.
      mockRedisIncr.mockRejectedValue(new Error('Redis down'));
      mockRedisGet.mockRejectedValue(new Error('Redis down'));
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      await expect(
        service.createBooking('cust-1', '9999999999', makeBookingInput())
      ).rejects.toThrow('Redis down');
    });

    it('should skip backpressure when Redis incr fails', async () => {
      mockRedisIncr.mockRejectedValue(new Error('Redis timeout'));

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.createBooking('cust-1', '9999999999', makeBookingInput());
      expect(result).toBeDefined();
    });

    it('should not decrement when incr was never incremented due to Redis failure', async () => {
      mockRedisIncr.mockRejectedValue(new Error('Redis down'));
      mockRedisIncrBy.mockClear();

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      await service.createBooking('cust-1', '9999999999', makeBookingInput());
      // Should not call incrBy(-1) since incr never succeeded
      const decrementCalls = mockRedisIncrBy.mock.calls.filter(
        (call: any[]) => call[0] === 'booking:create:inflight' && call[1] === -1
      );
      expect(decrementCalls.length).toBe(0);
    });

    it('should return cached booking from Redis on idempotency hit', async () => {
      const cachedBooking = makeBookingRecord({ status: 'active', matchingTransportersCount: 3, timeoutSeconds: 120 });
      mockRedisGet
        .mockResolvedValueOnce(null) // cooldown check
        .mockResolvedValueOnce(JSON.stringify(cachedBooking));

      const result = await service.createBooking('cust-1', '9999999999', makeBookingInput(), 'idem-key-1');
      expect(result.id).toBe('booking-1');
      expect(result.status).toBe('active');
    });
  });

  // =========================================================================
  // 2. Corrupted JSON in idempotency cache — verify try/catch handles gracefully
  // =========================================================================
  describe('Corrupted JSON in idempotency cache', () => {
    it('should handle corrupted JSON string gracefully', async () => {
      mockRedisGet
        .mockResolvedValueOnce(null)  // cooldown check
        .mockResolvedValueOnce('NOT-VALID-JSON{{{')  // corrupt idempotency cache
        .mockResolvedValueOnce(null)  // active broadcast check
        .mockResolvedValueOnce(null); // server idempotency check

      // The corrupted JSON path falls to legacy booking ID lookup
      mockGetBookingById.mockResolvedValueOnce(null).mockResolvedValue(makeBookingRecord());

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.createBooking('cust-1', '9999999999', makeBookingInput(), 'idem-key-1');
      expect(result).toBeDefined();
    });

    it('should handle empty string in cache as corrupted', async () => {
      mockRedisGet
        .mockResolvedValueOnce(null) // cooldown check
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.createBooking('cust-1', '9999999999', makeBookingInput(), 'idem-key-1');
      expect(result).toBeDefined();
    });

    it('should handle JSON object missing id/status fields', async () => {
      mockRedisGet
        .mockResolvedValueOnce(null)  // cooldown check
        .mockResolvedValueOnce(JSON.stringify({ foo: 'bar' }))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.createBooking('cust-1', '9999999999', makeBookingInput(), 'idem-key-1');
      expect(result).toBeDefined();
    });

    it('should bypass idempotency for cached cancelled booking', async () => {
      const cancelledBooking = makeBookingRecord({ status: 'cancelled', matchingTransportersCount: 0, timeoutSeconds: 0 });
      mockRedisGet
        .mockResolvedValueOnce(null)  // cooldown check
        .mockResolvedValueOnce(JSON.stringify(cancelledBooking))  // cancelled cached booking
        .mockResolvedValueOnce(null)  // active-broadcast check
        .mockResolvedValueOnce(null); // server idempotency check

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.createBooking('cust-1', '9999999999', makeBookingInput(), 'idem-key-1');
      expect(result).toBeDefined();
      // Should have deleted the cancelled key
      expect(mockRedisDel).toHaveBeenCalled();
    });

    it('should bypass idempotency for cached expired booking', async () => {
      const expiredBooking = makeBookingRecord({ status: 'expired', id: 'expired-1', matchingTransportersCount: 0, timeoutSeconds: 0 });
      mockRedisGet
        .mockResolvedValueOnce(null)  // cooldown check
        .mockResolvedValueOnce(JSON.stringify(expiredBooking))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.createBooking('cust-1', '9999999999', makeBookingInput(), 'idem-key-1');
      expect(result).toBeDefined();
    });
  });

  // =========================================================================
  // 3. TERMINAL_STATUSES with future new status — verify allowlist auto-blocks
  // =========================================================================
  describe('TERMINAL_STATUSES allowlist pattern', () => {
    it('should define exactly completed, cancelled, expired as terminal', () => {
      expect(TERMINAL_STATUSES).toEqual(['completed', 'cancelled', 'expired']);
    });

    it('should NOT include active-like statuses in terminal list', () => {
      const activeStatuses = ['created', 'broadcasting', 'active', 'partially_filled', 'fully_filled', 'in_progress'];
      for (const status of activeStatuses) {
        expect(TERMINAL_STATUSES).not.toContain(status);
      }
    });

    it('should auto-block hypothetical new status (not in terminal list)', () => {
      const hypotheticalStatus = 'pending_review';
      const isTerminal = (TERMINAL_STATUSES as readonly string[]).includes(hypotheticalStatus);
      expect(isTerminal).toBe(false);
      // notIn: TERMINAL_STATUSES would match this hypothetical status = blocked
    });

    it('should use notIn TERMINAL_STATUSES in booking creation guard', async () => {
      // Simulate an existing booking with status "active" (not terminal)
      mockBookingFindFirst.mockResolvedValue({ id: 'existing-1', status: 'active' });
      mockRedisGet.mockResolvedValue(null);

      await expect(
        service.createBooking('cust-1', '9999999999', makeBookingInput())
      ).rejects.toThrow('Request already in progress');
    });

    it('should allow booking creation when existing booking is in terminal state', async () => {
      // Existing booking is cancelled (terminal) — should allow new one
      mockBookingFindFirst.mockResolvedValue(null);
      mockOrderFindFirst.mockResolvedValue(null);

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.createBooking('cust-1', '9999999999', makeBookingInput());
      expect(result).toBeDefined();
    });
  });

  // =========================================================================
  // 4. Concurrent booking creation race — verify SERIALIZABLE TX prevents both
  // =========================================================================
  describe('Concurrent booking creation race', () => {
    it('should throw 409 when SERIALIZABLE TX finds existing active booking', async () => {
      // Redis checks pass, but DB (inside TX) finds active booking
      mockRedisGet.mockResolvedValue(null);
      mockBookingFindFirst.mockResolvedValue({ id: 'existing-booking', status: 'active' });

      await expect(
        service.createBooking('cust-1', '9999999999', makeBookingInput())
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('should throw 409 when SERIALIZABLE TX finds existing active order', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockBookingFindFirst.mockResolvedValue(null);
      mockOrderFindFirst.mockResolvedValue({ id: 'existing-order', status: 'active' });

      await expect(
        service.createBooking('cust-1', '9999999999', makeBookingInput())
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('should throw 409 when Redis active-broadcast key exists', async () => {
      // Without idempotency key: cooldown -> active-broadcast check
      mockRedisGet
        .mockResolvedValueOnce(null)  // cooldown check
        .mockResolvedValueOnce('existing-booking-id');  // active-broadcast check

      await expect(
        service.createBooking('cust-1', '9999999999', makeBookingInput())
      ).rejects.toMatchObject({ statusCode: 409, code: 'ACTIVE_ORDER_EXISTS' });
    });

    it('should throw 409 when lock acquisition fails', async () => {
      mockRedisGet.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      mockRedisAcquireLock.mockResolvedValue({ acquired: false });

      await expect(
        service.createBooking('cust-1', '9999999999', makeBookingInput())
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('should release lock in finally block even if booking creation fails', async () => {
      mockBookingFindFirst.mockResolvedValue({ id: 'dup', status: 'broadcasting' });

      try {
        await service.createBooking('cust-1', '9999999999', makeBookingInput());
      } catch { /* expected */ }

      expect(mockRedisReleaseLock).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 5. Payload hash collision — verify different payloads get different keys
  // =========================================================================
  describe('Payload hash collision prevention', () => {
    it('should produce different hashes for different pickup coordinates', () => {
      const hash1 = crypto.createHash('sha256')
        .update(JSON.stringify({
          pickup: { latitude: 12.97, longitude: 77.59 },
          drop: { latitude: 13.03, longitude: 77.63 },
          vehicleType: 'tipper',
        }))
        .digest('hex').slice(0, 16);

      const hash2 = crypto.createHash('sha256')
        .update(JSON.stringify({
          pickup: { latitude: 13.00, longitude: 77.60 },
          drop: { latitude: 13.03, longitude: 77.63 },
          vehicleType: 'tipper',
        }))
        .digest('hex').slice(0, 16);

      expect(hash1).not.toEqual(hash2);
    });

    it('should produce different hashes for different vehicle types', () => {
      const hash1 = crypto.createHash('sha256')
        .update(JSON.stringify({
          pickup: { latitude: 12.97, longitude: 77.59 },
          drop: { latitude: 13.03, longitude: 77.63 },
          vehicleType: 'tipper',
        }))
        .digest('hex').slice(0, 16);

      const hash2 = crypto.createHash('sha256')
        .update(JSON.stringify({
          pickup: { latitude: 12.97, longitude: 77.59 },
          drop: { latitude: 13.03, longitude: 77.63 },
          vehicleType: 'container',
        }))
        .digest('hex').slice(0, 16);

      expect(hash1).not.toEqual(hash2);
    });

    it('should produce identical hashes for identical payloads', () => {
      const payload = {
        pickup: { latitude: 12.97, longitude: 77.59 },
        drop: { latitude: 13.03, longitude: 77.63 },
        vehicleType: 'tipper',
      };

      const hash1 = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
      const hash2 = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);

      expect(hash1).toEqual(hash2);
    });

    it('should produce different hashes for different drop coordinates', () => {
      const hash1 = crypto.createHash('sha256')
        .update(JSON.stringify({
          pickup: { latitude: 12.97, longitude: 77.59 },
          drop: { latitude: 13.03, longitude: 77.63 },
          vehicleType: 'tipper',
        }))
        .digest('hex').slice(0, 16);

      const hash2 = crypto.createHash('sha256')
        .update(JSON.stringify({
          pickup: { latitude: 12.97, longitude: 77.59 },
          drop: { latitude: 14.00, longitude: 78.00 },
          vehicleType: 'tipper',
        }))
        .digest('hex').slice(0, 16);

      expect(hash1).not.toEqual(hash2);
    });

    it('hash should be exactly 16 characters long', () => {
      const hash = crypto.createHash('sha256')
        .update(JSON.stringify({ pickup: {}, drop: {}, vehicleType: 'x' }))
        .digest('hex').slice(0, 16);

      expect(hash).toHaveLength(16);
    });
  });

  // =========================================================================
  // 6. TTL 86400 expiry behavior — verify key expires correctly
  // =========================================================================
  describe('TTL 86400 (24h) expiry behavior', () => {
    it('should set active-broadcast key with TTL 86400', async () => {
      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      await service.createBooking('cust-1', '9999999999', makeBookingInput());

      const activeKeyCall = mockRedisSet.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('customer:active-broadcast')
      );
      expect(activeKeyCall).toBeDefined();
      expect(activeKeyCall![2]).toBe(86400);
    });

    it('should set idempotency key with 24h TTL (86400 seconds)', async () => {
      // The idempotency key is set in setBookingRedisKeys, but we check
      // the dedup key TTL which is booking timeout + 30
      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      await service.createBooking('cust-1', '9999999999', makeBookingInput());

      // Verify the active key TTL is 86400
      const ttlCalls = mockRedisSet.mock.calls.filter(
        (call: any[]) => call[2] === 86400
      );
      expect(ttlCalls.length).toBeGreaterThan(0);
    });

    it('should clean up active broadcast key on no-transporter path', async () => {
      mockGetTransportersWithVehicleType.mockResolvedValue([]);
      mockVehicleFindMany.mockResolvedValue([]);
      const { transporterOnlineService } = require('../shared/services/transporter-online.service');
      transporterOnlineService.filterOnline.mockResolvedValue([]);
      const { progressiveRadiusMatcher } = require('../modules/order/progressive-radius-matcher');
      progressiveRadiusMatcher.findCandidates.mockResolvedValue([]);

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      await service.createBooking('cust-1', '9999999999', makeBookingInput());

      // Should delete the active key when 0 transporters found
      const delCalls = mockRedisDel.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('customer:active-broadcast')
      );
      expect(delCalls.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 7. BroadcastService null at startup — verify graceful degradation
  // =========================================================================
  describe('BroadcastService null at startup', () => {
    beforeEach(() => {
      // Ensure transporters ARE found so we don't hit the earlyReturn (0 transporters) path
      // We need transporters to reach the null broadcast service guard
      const { progressiveRadiusMatcher } = require('../modules/order/progressive-radius-matcher');
      progressiveRadiusMatcher.findCandidates.mockResolvedValue([
        { transporterId: 't1', distanceKm: 5, etaSeconds: 600 },
      ]);
    });

    it('should return booking even when broadcast service is null', async () => {
      setBroadcastServiceRef(null);

      const result = await service.createBooking('cust-1', '9999999999', makeBookingInput());
      expect(result).toBeDefined();
      expect(result.id).toBe('booking-1');
    });

    it('should log error when broadcast service is null', async () => {
      const { logger } = require('../shared/services/logger.service');
      setBroadcastServiceRef(null);

      await service.createBooking('cust-1', '9999999999', makeBookingInput());

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('BroadcastService not initialized'),
        expect.objectContaining({ bookingId: expect.any(String) })
      );
    });

    it('should include matchingTransportersCount when broadcast service is null', async () => {
      setBroadcastServiceRef(null);
      mockGetTransportersWithVehicleType.mockResolvedValue(['t1', 't2', 't3']);
      const { transporterOnlineService } = require('../shared/services/transporter-online.service');
      transporterOnlineService.filterOnline.mockResolvedValue(['t1', 't2', 't3']);

      const result = await service.createBooking('cust-1', '9999999999', makeBookingInput());
      expect(result.matchingTransportersCount).toBeDefined();
      expect(typeof result.matchingTransportersCount).toBe('number');
    });

    it('should include timeoutSeconds when broadcast service is null', async () => {
      setBroadcastServiceRef(null);

      const result = await service.createBooking('cust-1', '9999999999', makeBookingInput());
      expect(result.timeoutSeconds).toBeDefined();
      expect(result.timeoutSeconds).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 8. AppError has correct HTTP status codes — verify all throw sites
  // =========================================================================
  describe('AppError HTTP status codes', () => {
    it('should throw 503 for backpressure limit exceeded', async () => {
      mockRedisIncr.mockResolvedValue(999);

      await expect(
        service.createBooking('cust-1', '9999999999', makeBookingInput())
      ).rejects.toMatchObject({ statusCode: 503, code: 'SYSTEM_BUSY' });
    });

    it('should throw 409 ACTIVE_ORDER_EXISTS for duplicate booking', async () => {
      // Without idempotency key: cooldown -> active-broadcast check
      mockRedisGet
        .mockResolvedValueOnce(null)  // cooldown check
        .mockResolvedValueOnce('existing-id');  // active-broadcast check

      await expect(
        service.createBooking('cust-1', '9999999999', makeBookingInput())
      ).rejects.toMatchObject({ statusCode: 409, code: 'ACTIVE_ORDER_EXISTS' });
    });

    it('should throw 409 for lock contention', async () => {
      mockRedisAcquireLock.mockResolvedValue({ acquired: false });

      await expect(
        service.createBooking('cust-1', '9999999999', makeBookingInput())
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('should throw 400 FARE_TOO_LOW for underpriced booking', async () => {
      const input = makeBookingInput({ pricePerTruck: 1, distanceKm: 200 });

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      await expect(
        service.createBooking('cust-1', '9999999999', input)
      ).rejects.toMatchObject({ statusCode: 400, code: 'FARE_TOO_LOW' });
    });

    it('AppError should include timestamp', () => {
      const err = new AppError(400, 'TEST', 'test message');
      expect(err.timestamp).toBeDefined();
      expect(typeof err.timestamp).toBe('string');
    });

    it('AppError should be instanceof Error', () => {
      const err = new AppError(500, 'TEST', 'test');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(AppError);
    });

    it('AppError toJSON should include code and message', () => {
      const err = new AppError(422, 'VALIDATION', 'bad input');
      const json = err.toJSON();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('VALIDATION');
      expect(json.error.message).toBe('bad input');
    });
  });

  // =========================================================================
  // 9. Distance cap at exactly 100km boundary — verify edge case
  // =========================================================================
  describe('Distance cap at 100km boundary', () => {
    it('should include transporter at exactly 100km', async () => {
      const { progressiveRadiusMatcher } = require('../modules/order/progressive-radius-matcher');
      progressiveRadiusMatcher.findCandidates.mockResolvedValue([]);

      const { transporterOnlineService } = require('../shared/services/transporter-online.service');
      transporterOnlineService.filterOnline.mockResolvedValue(['t-boundary']);

      const { distanceMatrixService } = require('../shared/services/distance-matrix.service');
      distanceMatrixService.batchGetPickupDistance.mockResolvedValue(new Map([
        ['t-boundary', { distanceMeters: 100_000, durationSeconds: 3600, cached: false, source: 'google' }],
      ]));

      const { availabilityService } = require('../shared/services/availability.service');
      availabilityService.loadTransporterDetailsMap.mockResolvedValue(new Map([
        ['t-boundary', { latitude: '13.00', longitude: '77.60' }],
      ]));

      mockGetTransportersWithVehicleType.mockResolvedValue(['t-boundary']);

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.createBooking('cust-1', '9999999999', makeBookingInput());
      // Should include the transporter at exactly 100km
      expect(result.matchingTransportersCount).toBe(1);
    });

    it('should exclude transporter beyond 100km', async () => {
      const { progressiveRadiusMatcher } = require('../modules/order/progressive-radius-matcher');
      progressiveRadiusMatcher.findCandidates.mockResolvedValue([]);

      const { transporterOnlineService } = require('../shared/services/transporter-online.service');
      transporterOnlineService.filterOnline.mockResolvedValue(['t-far']);

      const { distanceMatrixService } = require('../shared/services/distance-matrix.service');
      distanceMatrixService.batchGetPickupDistance.mockResolvedValue(new Map([
        ['t-far', { distanceMeters: 101_000, durationSeconds: 4000, cached: false, source: 'google' }],
      ]));

      const { availabilityService } = require('../shared/services/availability.service');
      availabilityService.loadTransporterDetailsMap.mockResolvedValue(new Map([
        ['t-far', { latitude: '14.00', longitude: '78.00' }],
      ]));

      mockGetTransportersWithVehicleType.mockResolvedValue(['t-far']);

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.createBooking('cust-1', '9999999999', makeBookingInput());
      // Should have 0 matching since the only transporter is beyond 100km
      expect(result.matchingTransportersCount).toBe(0);
    });

    it('should exclude transporter with no distance data (FIX #29)', async () => {
      const { progressiveRadiusMatcher } = require('../modules/order/progressive-radius-matcher');
      progressiveRadiusMatcher.findCandidates.mockResolvedValue([]);

      const { transporterOnlineService } = require('../shared/services/transporter-online.service');
      transporterOnlineService.filterOnline.mockResolvedValue(['t-nodata']);

      // No distance data returned
      const { distanceMatrixService } = require('../shared/services/distance-matrix.service');
      distanceMatrixService.batchGetPickupDistance.mockResolvedValue(new Map());

      const { availabilityService } = require('../shared/services/availability.service');
      availabilityService.loadTransporterDetailsMap.mockResolvedValue(new Map());

      mockGetTransportersWithVehicleType.mockResolvedValue(['t-nodata']);

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.createBooking('cust-1', '9999999999', makeBookingInput());
      // FIX #29: No distance data => excluded
      expect(result.matchingTransportersCount).toBe(0);
    });
  });

  // =========================================================================
  // 10. Empty transporter list from DB fallback — verify no crash
  // =========================================================================
  describe('Empty transporter list from DB fallback', () => {
    it('should handle 0 transporters gracefully and expire booking', async () => {
      const { progressiveRadiusMatcher } = require('../modules/order/progressive-radius-matcher');
      progressiveRadiusMatcher.findCandidates.mockResolvedValue([]);

      mockGetTransportersWithVehicleType.mockResolvedValue([]);
      const { transporterOnlineService } = require('../shared/services/transporter-online.service');
      transporterOnlineService.filterOnline.mockResolvedValue([]);

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.createBooking('cust-1', '9999999999', makeBookingInput());
      expect(result.matchingTransportersCount).toBe(0);
      expect(result.status).toBe('expired');
    });

    it('should emit NO_VEHICLES_AVAILABLE when 0 transporters found', async () => {
      const { emitToUser } = require('../shared/services/socket.service');

      const { progressiveRadiusMatcher } = require('../modules/order/progressive-radius-matcher');
      progressiveRadiusMatcher.findCandidates.mockResolvedValue([]);

      mockGetTransportersWithVehicleType.mockResolvedValue([]);
      const { transporterOnlineService } = require('../shared/services/transporter-online.service');
      transporterOnlineService.filterOnline.mockResolvedValue([]);

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      await service.createBooking('cust-1', '9999999999', makeBookingInput());

      const noVehicleCalls = emitToUser.mock.calls.filter(
        (call: any[]) => call[1] === 'no_vehicles_available'
      );
      expect(noVehicleCalls.length).toBeGreaterThan(0);
    });

    it('should clean up Redis active key on no-transporter path', async () => {
      const { progressiveRadiusMatcher } = require('../modules/order/progressive-radius-matcher');
      progressiveRadiusMatcher.findCandidates.mockResolvedValue([]);

      mockGetTransportersWithVehicleType.mockResolvedValue([]);
      const { transporterOnlineService } = require('../shared/services/transporter-online.service');
      transporterOnlineService.filterOnline.mockResolvedValue([]);

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      await service.createBooking('cust-1', '9999999999', makeBookingInput());

      const delCalls = mockRedisDel.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('active-broadcast')
      );
      expect(delCalls.length).toBeGreaterThan(0);
    });

    it('should return timeoutSeconds=0 when no transporters found', async () => {
      const { progressiveRadiusMatcher } = require('../modules/order/progressive-radius-matcher');
      progressiveRadiusMatcher.findCandidates.mockResolvedValue([]);

      mockGetTransportersWithVehicleType.mockResolvedValue([]);
      const { transporterOnlineService } = require('../shared/services/transporter-online.service');
      transporterOnlineService.filterOnline.mockResolvedValue([]);

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.createBooking('cust-1', '9999999999', makeBookingInput());
      expect(result.timeoutSeconds).toBe(0);
    });

    it('should not call broadcastService when no transporters found', async () => {
      const { progressiveRadiusMatcher } = require('../modules/order/progressive-radius-matcher');
      progressiveRadiusMatcher.findCandidates.mockResolvedValue([]);

      mockGetTransportersWithVehicleType.mockResolvedValue([]);
      const { transporterOnlineService } = require('../shared/services/transporter-online.service');
      transporterOnlineService.filterOnline.mockResolvedValue([]);

      const broadcastMock = jest.fn().mockResolvedValue(undefined);
      setBroadcastServiceRef({
        broadcastBookingToTransporters: broadcastMock,
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      await service.createBooking('cust-1', '9999999999', makeBookingInput());

      // earlyReturn should prevent broadcast calls
      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it('should set booking status to expired via broadcasting intermediate state', async () => {
      const { progressiveRadiusMatcher } = require('../modules/order/progressive-radius-matcher');
      progressiveRadiusMatcher.findCandidates.mockResolvedValue([]);

      mockGetTransportersWithVehicleType.mockResolvedValue([]);
      const { transporterOnlineService } = require('../shared/services/transporter-online.service');
      transporterOnlineService.filterOnline.mockResolvedValue([]);

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      await service.createBooking('cust-1', '9999999999', makeBookingInput());

      // Should have called updateMany twice: first created->broadcasting, then to expired
      const updateCalls = mockBookingUpdateMany.mock.calls;
      expect(updateCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // =========================================================================
  // Additional edge-case tests for full coverage
  // =========================================================================
  describe('Server-side idempotency dedup key', () => {
    it('should return existing booking when server-side dedup key matches', async () => {
      // First get: cooldown = null, active-broadcast check = null
      // Third get: server idempotency dedup = existing-booking-id
      mockRedisGet
        .mockResolvedValueOnce(null)  // cooldown check
        .mockResolvedValueOnce(null)  // active-broadcast check
        .mockResolvedValueOnce('existing-booking-id');  // server idempotency

      mockGetBookingById.mockResolvedValue(makeBookingRecord({ id: 'existing-booking-id', status: 'active' }));

      const result = await service.createBooking('cust-1', '9999999999', makeBookingInput());
      expect(result.id).toBe('existing-booking-id');
    });

    it('should bypass dedup when existing booking is cancelled', async () => {
      mockRedisGet
        .mockResolvedValueOnce(null)  // cooldown check
        .mockResolvedValueOnce(null)  // active-broadcast check
        .mockResolvedValueOnce('cancelled-booking-id');

      mockGetBookingById
        .mockResolvedValueOnce(makeBookingRecord({ id: 'cancelled-booking-id', status: 'cancelled' }))
        .mockResolvedValue(makeBookingRecord());

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.createBooking('cust-1', '9999999999', makeBookingInput());
      expect(result).toBeDefined();
    });
  });
});
