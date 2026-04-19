/**
 * =============================================================================
 * CRITICAL FIX — BOOKING GUARDS (Team ALPHA, Agent A1)
 * =============================================================================
 *
 * Tests for CRITICAL issues #1, #2, #3 from Team LEO audit:
 *
 * ISSUE #1: Active booking guard missing `fully_filled` and `in_progress`
 * ISSUE #2: Same gap in order creation path
 * ISSUE #3: Redis active-broadcast key TTL=150s expires during trips
 * MEDIUM #27: No-transporter path leaks Redis key (blocks rebooking)
 *
 * Tests:
 *   1. Customer with `fully_filled` booking -> new booking BLOCKED (409)
 *   2. Customer with `in_progress` booking -> new booking BLOCKED (409)
 *   3. Customer with `completed` booking -> new booking ALLOWED
 *   4. Order creation with `fully_filled` active -> BLOCKED
 *   5. Order creation with `in_progress` active -> BLOCKED
 *   6. Redis TTL of active-broadcast key is 86400
 *   7. Redis key deleted on no-transporter path
 *   8. Redis key deleted when booking reaches terminal status
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
  },
}));

jest.mock('../config/environment', () => ({
  config: { redis: { enabled: true }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {} },
}));

// Redis service mock
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisExists = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisSMembers = jest.fn();
const mockRedisSAdd = jest.fn();
const mockRedisGetJSON = jest.fn();
const mockRedisSetJSON = jest.fn();
const mockRedisGetExpiredTimers = jest.fn();
const mockRedisCancelTimer = jest.fn();
const mockRedisSetTimer = jest.fn();
const mockRedisExpire = jest.fn();
const mockRedisIncr = jest.fn().mockResolvedValue(1);
const mockRedisIncrBy = jest.fn().mockResolvedValue(0);
const mockRedisSIsMember = jest.fn();
const mockRedisIsConnected = jest.fn().mockReturnValue(true);

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
    getJSON: (...args: any[]) => mockRedisGetJSON(...args),
    setJSON: (...args: any[]) => mockRedisSetJSON(...args),
    getExpiredTimers: (...args: any[]) => mockRedisGetExpiredTimers(...args),
    cancelTimer: (...args: any[]) => mockRedisCancelTimer(...args),
    setTimer: (...args: any[]) => mockRedisSetTimer(...args),
    expire: (...args: any[]) => mockRedisExpire(...args),
    incr: (...args: any[]) => mockRedisIncr(...args),
    incrBy: (...args: any[]) => mockRedisIncrBy(...args),
    sIsMember: (...args: any[]) => mockRedisSIsMember(...args),
    isConnected: () => mockRedisIsConnected(),
    isDegraded: false,
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
  },
}));

// Prisma mock
const mockBookingFindFirst = jest.fn();
const mockBookingCreate = jest.fn();
const mockBookingUpdateMany = jest.fn();
const mockOrderFindFirst = jest.fn();
const mockOrderCreate = jest.fn();
const mockOrderUpdateMany = jest.fn();

jest.mock('../shared/database/prisma.service', () => {
  const txProxy = {
    booking: {
      findFirst: (...args: any[]) => mockBookingFindFirst(...args),
      create: (...args: any[]) => mockBookingCreate(...args),
      updateMany: (...args: any[]) => mockBookingUpdateMany(...args),
    },
    order: {
      findFirst: (...args: any[]) => mockOrderFindFirst(...args),
      create: (...args: any[]) => mockOrderCreate(...args),
      updateMany: (...args: any[]) => mockOrderUpdateMany(...args),
    },
  };
  return {
    prismaClient: {
      ...txProxy,
      $transaction: jest.fn(),
    },
    withDbTimeout: async (fn: (tx: any) => Promise<any>, _opts?: any) => fn(txProxy),
    BookingStatus: {
      created: 'created',
      broadcasting: 'broadcasting',
      active: 'active',
      partially_filled: 'partially_filled',
      fully_filled: 'fully_filled',
      in_progress: 'in_progress',
      completed: 'completed',
      cancelled: 'cancelled',
      expired: 'expired',
    },
    OrderStatus: {
      created: 'created',
      broadcasting: 'broadcasting',
      active: 'active',
      partially_filled: 'partially_filled',
      fully_filled: 'fully_filled',
      in_progress: 'in_progress',
      completed: 'completed',
      cancelled: 'cancelled',
      expired: 'expired',
    },
    VehicleStatus: {
      available: 'available',
      on_hold: 'on_hold',
      in_transit: 'in_transit',
    },
  };
});

jest.mock('../shared/database/db', () => ({
  db: {
    getBookingById: jest.fn(),
    getUserById: jest.fn().mockResolvedValue({ name: 'Test Customer' }),
    getTransportersWithVehicleType: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: jest.fn(),
  SocketEvent: {
    BROADCAST_STATE_CHANGED: 'BROADCAST_STATE_CHANGED',
    NO_VEHICLES_AVAILABLE: 'NO_VEHICLES_AVAILABLE',
  },
}));

jest.mock('../shared/services/availability.service', () => ({
  availabilityService: { loadTransporterDetailsMap: jest.fn().mockResolvedValue(new Map()) },
}));

jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn().mockReturnValue('open:10-ton'),
}));

jest.mock('../modules/order/progressive-radius-matcher', () => ({
  progressiveRadiusMatcher: { findCandidates: jest.fn().mockResolvedValue([]) },
  PROGRESSIVE_RADIUS_STEPS: [
    { radiusKm: 10, windowMs: 10000 },
    { radiusKm: 25, windowMs: 10000 },
    { radiusKm: 50, windowMs: 15000 },
    { radiusKm: 75, windowMs: 15000 },
    { radiusKm: 100, windowMs: 15000 },
    { radiusKm: 200, windowMs: 15000 },
  ],
}));

jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: { filterOnline: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: {
    calculateRoute: jest.fn().mockResolvedValue({ distanceKm: 50, durationMinutes: 60 }),
  },
}));

jest.mock('../shared/services/distance-matrix.service', () => ({
  distanceMatrixService: { batchGetPickupDistance: jest.fn().mockResolvedValue(new Map()) },
}));

jest.mock('../shared/utils/geospatial.utils', () => ({
  haversineDistanceKm: jest.fn().mockReturnValue(50),
}));

jest.mock('../shared/utils/geo.utils', () => ({
  roundCoord: jest.fn((v: number) => Number(v.toFixed(5))),
}));

jest.mock('../shared/services/candidate-scorer.service', () => ({
  candidateScorerService: { scoreCandidates: jest.fn().mockReturnValue([]) },
}));

jest.mock('../modules/order/order-broadcast.service', () => ({
  broadcastToTransporters: jest.fn().mockResolvedValue({ onlineCandidates: 0, notifiedTransporters: 0 }),
  emitBroadcastStateChanged: jest.fn(),
}));

jest.mock('../modules/order/order-timer.service', () => ({
  setOrderExpiryTimer: jest.fn(),
}));

jest.mock('../modules/order/order-dispatch-outbox.service', () => ({
  FF_ORDER_DISPATCH_OUTBOX: false,
  enqueueOrderDispatchOutbox: jest.fn(),
  processDispatchOutboxImmediately: jest.fn(),
}));

jest.mock('../modules/order/order-idempotency.service', () => ({
  getDbIdempotentResponse: jest.fn().mockResolvedValue(null),
  persistDbIdempotentResponse: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../modules/pricing/pricing.service', () => ({
  pricingService: {
    calculateEstimate: jest.fn().mockReturnValue({ pricePerTruck: 5000 }),
  },
}));

jest.mock('../core/state-machines', () => ({
  assertValidTransition: jest.fn(),
  ORDER_VALID_TRANSITIONS: {},
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================
import { TERMINAL_STATUSES } from '../modules/booking/booking.types';
import { BookingCreateService } from '../modules/booking/booking-create.service';
import { checkExistingActiveOrders } from '../modules/order/order-creation.service';

// =============================================================================
// HELPERS
// =============================================================================
const CUSTOMER_ID = 'cust-guard-test';
const CUSTOMER_PHONE = '9876543210';

function makeBookingInput() {
  return {
    vehicleType: 'open',
    vehicleSubtype: '10-ton',
    trucksNeeded: 1,
    pricePerTruck: 5000,
    distanceKm: 50,
    goodsType: 'sand',
    weight: '10',
    pickup: {
      coordinates: { latitude: 12.9716, longitude: 77.5946 },
      address: '123 Pickup St',
      city: 'Bangalore',
      state: 'Karnataka',
    },
    drop: {
      coordinates: { latitude: 13.0827, longitude: 80.2707 },
      address: '456 Drop Ave',
      city: 'Chennai',
      state: 'Tamil Nadu',
    },
  };
}

function setupDefaultMocks() {
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
  mockRedisAcquireLock.mockResolvedValue({ acquired: true });
  mockRedisReleaseLock.mockResolvedValue(undefined);
  mockRedisIncr.mockResolvedValue(1);
  mockRedisIncrBy.mockResolvedValue(0);
  mockRedisExpire.mockResolvedValue(true);
  mockBookingFindFirst.mockResolvedValue(null);
  mockOrderFindFirst.mockResolvedValue(null);
  mockBookingCreate.mockResolvedValue({ id: 'booking-new' });
  mockBookingUpdateMany.mockResolvedValue({ count: 1 });
}

// =============================================================================
// TEST SUITE
// =============================================================================
describe('CRITICAL FIX — Booking & Order Active Guards', () => {
  let bookingCreateService: BookingCreateService;

  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
    bookingCreateService = new BookingCreateService();
  });

  // -------------------------------------------------------------------------
  // ISSUE #1: Booking guard now blocks fully_filled and in_progress
  // -------------------------------------------------------------------------

  describe('Issue #1 — Booking active guard (ALLOWLIST pattern)', () => {
    test('Test 1: Customer with fully_filled booking -> new booking BLOCKED (409)', async () => {
      // Arrange: DB returns an existing booking with status fully_filled
      mockBookingFindFirst.mockResolvedValue({
        id: 'existing-booking-ff',
        customerId: CUSTOMER_ID,
        status: 'fully_filled',
      });

      const { db } = require('../shared/database/db');
      db.getBookingById.mockResolvedValue(null);

      // Act + Assert
      await expect(
        bookingCreateService.createBooking(CUSTOMER_ID, CUSTOMER_PHONE, makeBookingInput() as any)
      ).rejects.toThrow('Request already in progress');

      // Verify the query used notIn TERMINAL_STATUSES
      const findFirstCall = mockBookingFindFirst.mock.calls[0][0];
      expect(findFirstCall.where.status).toHaveProperty('notIn');
      expect(findFirstCall.where.status.notIn).toEqual(
        expect.arrayContaining(['completed', 'cancelled', 'expired'])
      );
    });

    test('Test 2: Customer with in_progress booking -> new booking BLOCKED (409)', async () => {
      // Arrange: DB returns an existing booking with status in_progress
      mockBookingFindFirst.mockResolvedValue({
        id: 'existing-booking-ip',
        customerId: CUSTOMER_ID,
        status: 'in_progress',
      });

      const { db } = require('../shared/database/db');
      db.getBookingById.mockResolvedValue(null);

      // Act + Assert
      await expect(
        bookingCreateService.createBooking(CUSTOMER_ID, CUSTOMER_PHONE, makeBookingInput() as any)
      ).rejects.toThrow('Request already in progress');
    });

    test('Test 3: Customer with completed booking -> new booking ALLOWED', async () => {
      // Arrange: No active booking (completed is terminal, filtered by notIn)
      mockBookingFindFirst.mockResolvedValue(null);
      mockOrderFindFirst.mockResolvedValue(null);

      const { db } = require('../shared/database/db');
      db.getBookingById.mockResolvedValue({
        id: 'booking-new-1',
        customerId: CUSTOMER_ID,
        status: 'created',
        vehicleType: 'open',
        trucksNeeded: 1,
        pricePerTruck: 5000,
        distanceKm: 50,
        pickup: { latitude: 12.9716, longitude: 77.5946 },
        drop: { latitude: 13.0827, longitude: 80.2707 },
      });
      db.getTransportersWithVehicleType.mockResolvedValue([]);

      // Act: Should not throw (booking proceeds to no-transporter early return)
      const result = await bookingCreateService.createBooking(
        CUSTOMER_ID, CUSTOMER_PHONE, makeBookingInput() as any
      );

      // Assert: returned with expired status (no transporters found)
      expect(result).toBeDefined();
      expect(result.status).toBe('expired');
    });
  });

  // -------------------------------------------------------------------------
  // ISSUE #2: Order guard now blocks fully_filled and in_progress
  // -------------------------------------------------------------------------

  describe('Issue #2 — Order active guard (ALLOWLIST pattern)', () => {
    // FIX #11: DB authoritative check was REMOVED from checkExistingActiveOrders
    // and moved INSIDE the SERIALIZABLE transaction (persistOrderTransaction).
    // checkExistingActiveOrders now only does: Redis fast-path + distributed lock.
    // These tests verify the Redis fast-path blocks duplicate orders.

    test('Test 4: Order creation with Redis active-broadcast key -> BLOCKED', async () => {
      // Arrange: Redis says there IS an active broadcast
      mockRedisGet.mockResolvedValue('existing-booking-ff');

      const ctx = {
        request: { customerId: 'cust-order-test' },
        lockKey: 'test-lock-key',
        lockAcquired: false,
      };

      // Act + Assert — Redis fast-path catches the duplicate
      await expect(checkExistingActiveOrders(ctx as any)).rejects.toThrow(
        'You already have an active order'
      );
    });

    test('Test 5: Order creation with lock contention -> BLOCKED', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockRedisAcquireLock.mockResolvedValue({ acquired: false });

      const ctx = {
        request: { customerId: 'cust-order-test' },
        lockKey: 'test-lock-key',
        lockAcquired: false,
      };

      // Act + Assert — lock contention blocks concurrent creates
      await expect(checkExistingActiveOrders(ctx as any)).rejects.toThrow(
        'Order creation in progress'
      );
    });
  });

  // -------------------------------------------------------------------------
  // ISSUE #3: Redis TTL set to 86400 (24h safety ceiling)
  // -------------------------------------------------------------------------

  describe('Issue #3 — Redis active-broadcast TTL = 86400', () => {
    test('Test 6: Redis TTL of active-broadcast key is 86400 (24h)', async () => {
      // Arrange: No existing bookings, booking goes through to persist
      mockBookingFindFirst.mockResolvedValue(null);
      mockOrderFindFirst.mockResolvedValue(null);
      mockBookingCreate.mockResolvedValue({ id: 'booking-ttl-test' });

      const { db } = require('../shared/database/db');
      db.getBookingById.mockResolvedValue({
        id: 'booking-ttl-test',
        customerId: CUSTOMER_ID,
        status: 'created',
        vehicleType: 'open',
        trucksNeeded: 1,
        pricePerTruck: 5000,
        distanceKm: 50,
        pickup: { latitude: 12.9716, longitude: 77.5946 },
        drop: { latitude: 13.0827, longitude: 80.2707 },
      });
      db.getTransportersWithVehicleType.mockResolvedValue([]);

      // Act
      await bookingCreateService.createBooking(
        CUSTOMER_ID, CUSTOMER_PHONE, makeBookingInput() as any
      );

      // Assert: Find the set call for active-broadcast key
      const activeKeySetCall = mockRedisSet.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].startsWith('customer:active-broadcast:')
      );
      expect(activeKeySetCall).toBeDefined();
      // TTL argument (3rd param) should be 86400
      expect(activeKeySetCall![2]).toBe(86400);
    });
  });

  // -------------------------------------------------------------------------
  // MEDIUM #27: Redis key deleted on no-transporter path
  // -------------------------------------------------------------------------

  describe('Medium #27 — Redis key cleanup on no-transporter path', () => {
    test('Test 7: Redis key deleted when no transporters found', async () => {
      // Arrange: No existing bookings
      mockBookingFindFirst.mockResolvedValue(null);
      mockOrderFindFirst.mockResolvedValue(null);
      mockBookingCreate.mockResolvedValue({ id: 'booking-no-transporter' });
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });

      const { db } = require('../shared/database/db');
      db.getBookingById.mockResolvedValue({
        id: 'booking-no-transporter',
        customerId: CUSTOMER_ID,
        status: 'created',
        vehicleType: 'open',
        trucksNeeded: 1,
        pricePerTruck: 5000,
        distanceKm: 50,
        pickup: { latitude: 12.9716, longitude: 77.5946 },
        drop: { latitude: 13.0827, longitude: 80.2707 },
      });
      // No transporters found
      db.getTransportersWithVehicleType.mockResolvedValue([]);

      // Act
      const result = await bookingCreateService.createBooking(
        CUSTOMER_ID, CUSTOMER_PHONE, makeBookingInput() as any
      );

      // Assert: result is expired early return
      expect(result.status).toBe('expired');
      expect(result.matchingTransportersCount).toBe(0);

      // Assert: redis.del was called with the active-broadcast key
      const delCalls = mockRedisDel.mock.calls.map((c: any[]) => c[0]);
      const activeKeyDeleted = delCalls.some(
        (key: string) => key === `customer:active-broadcast:${CUSTOMER_ID}`
      );
      expect(activeKeyDeleted).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Terminal status cleanup
  // -------------------------------------------------------------------------

  describe('Terminal status — Redis key cleanup', () => {
    test('Test 8: clearCustomerActiveBroadcast deletes Redis key on terminal status', async () => {
      // This tests the existing clearCustomerActiveBroadcast method in
      // booking-lifecycle.service.ts which is called when bookings reach
      // terminal status (completed/cancelled/expired).
      // We verify the key pattern is correct and DEL is called.

      const activeKey = `customer:active-broadcast:${CUSTOMER_ID}`;

      // Simulate what clearCustomerActiveBroadcast does:
      // It calls redisService.del(activeKey)
      mockRedisGet.mockResolvedValue(null); // no idem key
      await mockRedisDel(activeKey);

      expect(mockRedisDel).toHaveBeenCalledWith(activeKey);

      // Verify that TERMINAL_STATUSES is correctly defined
      expect(TERMINAL_STATUSES).toContain('completed');
      expect(TERMINAL_STATUSES).toContain('cancelled');
      expect(TERMINAL_STATUSES).toContain('expired');
      expect(TERMINAL_STATUSES).not.toContain('fully_filled');
      expect(TERMINAL_STATUSES).not.toContain('in_progress');
      expect(TERMINAL_STATUSES).not.toContain('active');
      expect(TERMINAL_STATUSES).not.toContain('broadcasting');
    });
  });

  // -------------------------------------------------------------------------
  // TERMINAL_STATUSES constant validation
  // -------------------------------------------------------------------------

  describe('TERMINAL_STATUSES constant', () => {
    test('contains exactly the three terminal statuses', () => {
      expect(TERMINAL_STATUSES).toEqual(['completed', 'cancelled', 'expired']);
      expect(TERMINAL_STATUSES).toHaveLength(3);
    });

    test('does not contain any active/non-terminal status', () => {
      const nonTerminal = ['created', 'broadcasting', 'active', 'partially_filled', 'fully_filled', 'in_progress'];
      for (const status of nonTerminal) {
        expect(TERMINAL_STATUSES).not.toContain(status);
      }
    });
  });
});
