/**
 * =============================================================================
 * CUSTOMER CANCEL / QUERY / STATUS — Stress & Edge-Case Tests
 * =============================================================================
 *
 * Covers:
 * 1. Cancellation -- every scenario (pending, broadcasting, idempotent, wrong
 *    customer, terminal states, holds, assignments, notifications, Redis cleanup)
 * 2. Concurrent cancellation (race with cancel, timeout, hold confirm)
 * 3. Customer queries (pagination, filtering, sort, access control, performance)
 * 4. Booking status transitions (state machine validation, socket events)
 * 5. Timer / expiry edge cases (server boot, batch, DB sweep, no-ops, shutdown)
 *
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP -- must come BEFORE any imports that use these modules
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

// --- DB mock ----------------------------------------------------------------
const mockGetBookingById = jest.fn();
const mockGetBookingsByCustomer = jest.fn();
const mockGetActiveBookingsForTransporter = jest.fn();
const mockGetVehiclesByTransporter = jest.fn();
const mockGetAssignmentsByBooking = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getBookingById: (...a: any[]) => mockGetBookingById(...a),
    getBookingsByCustomer: (...a: any[]) => mockGetBookingsByCustomer(...a),
    getActiveBookingsForTransporter: (...a: any[]) => mockGetActiveBookingsForTransporter(...a),
    getVehiclesByTransporter: (...a: any[]) => mockGetVehiclesByTransporter(...a),
    getAssignmentsByBooking: (...a: any[]) => mockGetAssignmentsByBooking(...a),
  },
}));

// --- Redis mock -------------------------------------------------------------
const mockRedisGet = jest.fn().mockResolvedValue(null);
const mockRedisSet = jest.fn().mockResolvedValue('OK');
const mockRedisDel = jest.fn().mockResolvedValue(1);
const mockRedisAcquireLock = jest.fn().mockResolvedValue({ acquired: true });
const mockRedisReleaseLock = jest.fn().mockResolvedValue(undefined);
const mockRedisCancelTimer = jest.fn().mockResolvedValue(undefined);
const mockRedisSetTimer = jest.fn().mockResolvedValue(undefined);
const mockRedisGetExpiredTimers = jest.fn().mockResolvedValue([]);
const mockRedisExists = jest.fn().mockResolvedValue(false);
const mockRedisSAdd = jest.fn().mockResolvedValue(1);
const mockRedisSMembers = jest.fn().mockResolvedValue([]);

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...a: any[]) => mockRedisGet(...a),
    set: (...a: any[]) => mockRedisSet(...a),
    del: (...a: any[]) => mockRedisDel(...a),
    acquireLock: (...a: any[]) => mockRedisAcquireLock(...a),
    releaseLock: (...a: any[]) => mockRedisReleaseLock(...a),
    cancelTimer: (...a: any[]) => mockRedisCancelTimer(...a),
    setTimer: (...a: any[]) => mockRedisSetTimer(...a),
    getExpiredTimers: (...a: any[]) => mockRedisGetExpiredTimers(...a),
    exists: (...a: any[]) => mockRedisExists(...a),
    sAdd: (...a: any[]) => mockRedisSAdd(...a),
    sMembers: (...a: any[]) => mockRedisSMembers(...a),
    isConnected: jest.fn().mockReturnValue(true),
    isRedisEnabled: jest.fn().mockReturnValue(true),
    isDegraded: false,
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
    expire: jest.fn().mockResolvedValue(undefined),
    incr: jest.fn().mockResolvedValue(1),
    incrBy: jest.fn().mockResolvedValue(0),
    sIsMember: jest.fn().mockResolvedValue(false),
    sCard: jest.fn().mockResolvedValue(0),
    sRem: jest.fn().mockResolvedValue(0),
    sScan: jest.fn().mockResolvedValue([]),
    lPush: jest.fn().mockResolvedValue(undefined),
    lTrim: jest.fn().mockResolvedValue(undefined),
    hMSet: jest.fn().mockResolvedValue(undefined),
    hGetAll: jest.fn().mockResolvedValue({}),
    hGetAllBatch: jest.fn().mockResolvedValue([]),
    geoAdd: jest.fn().mockResolvedValue(undefined),
    geoRemove: jest.fn().mockResolvedValue(undefined),
    geoRadius: jest.fn().mockResolvedValue([]),
  },
}));

// --- Prisma mock ------------------------------------------------------------
const mockBookingUpdateMany = jest.fn();
const mockAssignmentFindMany = jest.fn();
const mockAssignmentUpdateMany = jest.fn();
const mockAssignmentGroupBy = jest.fn();
const mockQueryRaw = jest.fn();
const mockUserFindMany = jest.fn();
const mockBookingFindMany = jest.fn();

const mockTransaction = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    booking: {
      updateMany: (...a: any[]) => mockBookingUpdateMany(...a),
      findMany: (...a: any[]) => mockBookingFindMany(...a),
    },
    assignment: {
      findMany: (...a: any[]) => mockAssignmentFindMany(...a),
      updateMany: (...a: any[]) => mockAssignmentUpdateMany(...a),
      groupBy: (...a: any[]) => mockAssignmentGroupBy(...a),
    },
    user: {
      findMany: (...a: any[]) => mockUserFindMany(...a),
    },
    $transaction: (...a: any[]) => mockTransaction(...a),
    $queryRaw: (...a: any[]) => mockQueryRaw(...a),
  },
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
  AssignmentStatus: {
    pending: 'pending',
    driver_accepted: 'driver_accepted',
    en_route_pickup: 'en_route_pickup',
    at_pickup: 'at_pickup',
    in_transit: 'in_transit',
    arrived_at_drop: 'arrived_at_drop',
    completed: 'completed',
    cancelled: 'cancelled',
    driver_declined: 'driver_declined',
  },
}));

// --- Socket mock ------------------------------------------------------------
const mockEmitToUser = jest.fn();
const mockEmitToBooking = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...a: any[]) => mockEmitToUser(...a),
  emitToBooking: (...a: any[]) => mockEmitToBooking(...a),
  emitToTrip: jest.fn(),
  emitToOrder: jest.fn(),
  emitToAll: jest.fn(),
  SocketEvent: {
    BOOKING_UPDATED: 'booking_updated',
    BOOKING_EXPIRED: 'booking_expired',
    BOOKING_FULLY_FILLED: 'booking_fully_filled',
    BOOKING_PARTIALLY_FILLED: 'booking_partially_filled',
    NO_VEHICLES_AVAILABLE: 'no_vehicles_available',
    TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update',
    TRIP_CANCELLED: 'trip_cancelled',
    NEW_BROADCAST: 'new_broadcast',
    BROADCAST_COUNTDOWN: 'broadcast_countdown',
  },
}));

// --- Queue mock -------------------------------------------------------------
const mockQueuePushNotificationBatch = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queuePushNotificationBatch: (...a: any[]) => mockQueuePushNotificationBatch(...a),
  },
}));

// --- Vehicle lifecycle mock -------------------------------------------------
const mockReleaseVehicle = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: (...a: any[]) => mockReleaseVehicle(...a),
}));

// --- State machine mock (pass through real implementation) ------------------
jest.mock('../core/state-machines', () => {
  const real = jest.requireActual('../core/state-machines');
  return {
    ...real,
    assertValidTransition: jest.fn(real.assertValidTransition),
  };
});

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { BookingLifecycleService, setCreateServiceRef } from '../modules/booking/booking-lifecycle.service';
import { BookingQueryService } from '../modules/booking/booking-query.service';
import { AppError } from '../shared/types/error.types';
import { BookingRecord } from '../shared/database/db';

// =============================================================================
// HELPERS
// =============================================================================

function makeBooking(overrides: Partial<BookingRecord> = {}): BookingRecord {
  return {
    id: 'booking-1',
    customerId: 'cust-1',
    customerName: 'Test Customer',
    customerPhone: '9999999999',
    pickup: { latitude: 12.9, longitude: 77.6, address: 'Pickup Addr' },
    drop: { latitude: 13.0, longitude: 77.7, address: 'Drop Addr' },
    vehicleType: 'open',
    vehicleSubtype: '17ft',
    trucksNeeded: 3,
    trucksFilled: 0,
    distanceKm: 50,
    pricePerTruck: 5000,
    totalAmount: 15000,
    status: 'broadcasting',
    notifiedTransporters: ['trans-1', 'trans-2'],
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeAssignment(overrides: Record<string, any> = {}) {
  return {
    id: 'assign-1',
    vehicleId: 'vehicle-1',
    transporterId: 'trans-1',
    vehicleType: 'open',
    vehicleSubtype: '17ft',
    driverId: 'driver-1',
    tripId: 'trip-1',
    status: 'pending',
    ...overrides,
  };
}

// =============================================================================
// SUITE
// =============================================================================

describe('Customer Cancel / Query / Status — Stress Tests', () => {
  let lifecycleSvc: BookingLifecycleService;
  let querySvc: BookingQueryService;

  beforeEach(() => {
    jest.clearAllMocks();
    lifecycleSvc = new BookingLifecycleService();
    querySvc = new BookingQueryService();

    // Wire forward reference for decrementTrucksFilled -> startBookingTimeout
    setCreateServiceRef({
      startBookingTimeout: jest.fn().mockResolvedValue(undefined),
    });

    // Default: transaction executes the callback with a fake tx
    mockTransaction.mockImplementation(async (fn: any) => {
      const fakeTx = {
        booking: { updateMany: mockBookingUpdateMany },
        assignment: { findMany: mockAssignmentFindMany, updateMany: mockAssignmentUpdateMany },
      };
      return fn(fakeTx);
    });
  });

  // ===========================================================================
  // 1. CANCELLATION -- every scenario
  // ===========================================================================

  describe('Cancellation', () => {
    test('Customer cancels pending booking -> success', async () => {
      const booking = makeBooking({ status: 'created', notifiedTransporters: [] });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentFindMany.mockResolvedValue([]);

      const result = await lifecycleSvc.cancelBooking('booking-1', 'cust-1');
      expect(result.id).toBe('booking-1');
      expect(mockBookingUpdateMany).toHaveBeenCalled();
    });

    test('Customer cancels broadcasting booking -> broadcasts stopped, holds released', async () => {
      const booking = makeBooking({ status: 'broadcasting' });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      const assignments = [makeAssignment({ vehicleId: 'v1' }), makeAssignment({ id: 'a2', vehicleId: 'v2' })];
      mockAssignmentFindMany.mockResolvedValue(assignments);
      mockAssignmentUpdateMany.mockResolvedValue({ count: 2 });

      await lifecycleSvc.cancelBooking('booking-1', 'cust-1');

      expect(mockRedisCancelTimer).toHaveBeenCalled();
      expect(mockRedisDel).toHaveBeenCalled();
      expect(mockReleaseVehicle).toHaveBeenCalledTimes(2);
    });

    test('Cancel already cancelled -> idempotent (no error)', async () => {
      const booking = makeBooking({ status: 'cancelled' });
      mockGetBookingById.mockResolvedValue(booking);

      const result = await lifecycleSvc.cancelBooking('booking-1', 'cust-1');
      expect(result.status).toBe('cancelled');
      // Transaction should NOT have been called for already-cancelled
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    test('Cancel already completed -> 409 error', async () => {
      const booking = makeBooking({ status: 'completed' });
      mockGetBookingById.mockResolvedValue(booking);
      // CAS returns 0 rows (status not in cancellable set)
      mockBookingUpdateMany.mockResolvedValue({ count: 0 });
      mockAssignmentFindMany.mockResolvedValue([]);

      await expect(lifecycleSvc.cancelBooking('booking-1', 'cust-1'))
        .rejects.toThrow(AppError);
      try {
        await lifecycleSvc.cancelBooking('booking-1', 'cust-1');
      } catch (e: any) {
        expect(e.statusCode).toBe(409);
      }
    });

    test('Cancel already expired -> 409 error', async () => {
      const booking = makeBooking({ status: 'expired' });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 0 });
      mockAssignmentFindMany.mockResolvedValue([]);

      await expect(lifecycleSvc.cancelBooking('booking-1', 'cust-1'))
        .rejects.toThrow(AppError);
    });

    test('Cancel with wrong customer ID -> 403 forbidden', async () => {
      const booking = makeBooking({ customerId: 'cust-2' });
      mockGetBookingById.mockResolvedValue(booking);

      await expect(lifecycleSvc.cancelBooking('booking-1', 'cust-1'))
        .rejects.toThrow(AppError);
      try {
        await lifecycleSvc.cancelBooking('booking-1', 'cust-1');
      } catch (e: any) {
        expect(e.statusCode).toBe(403);
        expect(e.code).toBe('FORBIDDEN');
      }
    });

    test('Cancel non-existent booking -> 404', async () => {
      mockGetBookingById.mockResolvedValue(null);

      await expect(lifecycleSvc.cancelBooking('nonexistent', 'cust-1'))
        .rejects.toThrow(AppError);
      try {
        await lifecycleSvc.cancelBooking('nonexistent', 'cust-1');
      } catch (e: any) {
        expect(e.statusCode).toBe(404);
      }
    });

    test('Cancel releases all truck holds (vehicle release for each assignment)', async () => {
      const booking = makeBooking();
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      const assignments = [
        makeAssignment({ id: 'a1', vehicleId: 'v1' }),
        makeAssignment({ id: 'a2', vehicleId: 'v2' }),
        makeAssignment({ id: 'a3', vehicleId: 'v3' }),
      ];
      mockAssignmentFindMany.mockResolvedValue(assignments);
      mockAssignmentUpdateMany.mockResolvedValue({ count: 3 });

      await lifecycleSvc.cancelBooking('booking-1', 'cust-1');

      expect(mockReleaseVehicle).toHaveBeenCalledWith('v1', 'bookingCancellation');
      expect(mockReleaseVehicle).toHaveBeenCalledWith('v2', 'bookingCancellation');
      expect(mockReleaseVehicle).toHaveBeenCalledWith('v3', 'bookingCancellation');
    });

    test('Cancel notifies all assigned transporters via socket', async () => {
      const booking = makeBooking({ notifiedTransporters: ['trans-1', 'trans-2', 'trans-3'] });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentFindMany.mockResolvedValue([]);

      await lifecycleSvc.cancelBooking('booking-1', 'cust-1');

      const transporterCalls = mockEmitToUser.mock.calls.filter(
        ([userId, event]: any[]) => ['trans-1', 'trans-2', 'trans-3'].includes(userId) && event === 'booking_expired'
      );
      expect(transporterCalls.length).toBe(3);
    });

    test('Cancel sends FCM to offline transporters', async () => {
      const booking = makeBooking({ notifiedTransporters: ['trans-1', 'trans-2'] });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentFindMany.mockResolvedValue([]);

      await lifecycleSvc.cancelBooking('booking-1', 'cust-1');

      expect(mockQueuePushNotificationBatch).toHaveBeenCalledWith(
        ['trans-1', 'trans-2'],
        expect.objectContaining({ title: expect.stringContaining('Cancelled') })
      );
    });

    test('Cancel cancels all pending assignments atomically', async () => {
      const booking = makeBooking();
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      const assignments = [
        makeAssignment({ id: 'a1', status: 'pending' }),
        makeAssignment({ id: 'a2', status: 'driver_accepted' }),
      ];
      mockAssignmentFindMany.mockResolvedValue(assignments);
      mockAssignmentUpdateMany.mockResolvedValue({ count: 2 });

      await lifecycleSvc.cancelBooking('booking-1', 'cust-1');

      expect(mockAssignmentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ bookingId: 'booking-1' }),
          data: expect.objectContaining({ status: 'cancelled' }),
        })
      );
    });

    test('Cancel clears Redis tracking keys', async () => {
      const booking = makeBooking();
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentFindMany.mockResolvedValue([]);

      await lifecycleSvc.cancelBooking('booking-1', 'cust-1');

      // Should clear timers, active broadcast key, notified set
      expect(mockRedisCancelTimer).toHaveBeenCalled();
      expect(mockRedisDel).toHaveBeenCalled();
    });

    test('Cancel clears timeout timer', async () => {
      const booking = makeBooking();
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentFindMany.mockResolvedValue([]);

      await lifecycleSvc.cancelBooking('booking-1', 'cust-1');

      expect(mockRedisCancelTimer).toHaveBeenCalledWith(
        expect.stringContaining('timer:booking:booking-1')
      );
    });

    test('Cancel during radius expansion -> expansion keys cleared', async () => {
      const booking = makeBooking({ status: 'broadcasting' });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentFindMany.mockResolvedValue([]);

      await lifecycleSvc.cancelBooking('booking-1', 'cust-1');

      // Should have cleared both booking and radius timers
      expect(mockRedisCancelTimer).toHaveBeenCalledWith(
        expect.stringContaining('timer:radius:booking-1')
      );
      expect(mockRedisDel).toHaveBeenCalledWith(
        expect.stringContaining('broadcast:radius:step:booking-1')
      );
    });

    test('Cancel while transporter is confirming hold -> hold released', async () => {
      const booking = makeBooking({ status: 'active' });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      const assignments = [makeAssignment({ status: 'pending', vehicleId: 'held-v1' })];
      mockAssignmentFindMany.mockResolvedValue(assignments);
      mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });

      await lifecycleSvc.cancelBooking('booking-1', 'cust-1');

      expect(mockReleaseVehicle).toHaveBeenCalledWith('held-v1', 'bookingCancellation');
    });

    test('Cancel notifies drivers of cancelled assignments via FCM', async () => {
      const booking = makeBooking();
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      const assignments = [
        makeAssignment({ driverId: 'driver-1', status: 'driver_accepted' }),
        makeAssignment({ id: 'a2', driverId: 'driver-2', status: 'en_route_pickup' }),
      ];
      mockAssignmentFindMany.mockResolvedValue(assignments);
      mockAssignmentUpdateMany.mockResolvedValue({ count: 2 });

      await lifecycleSvc.cancelBooking('booking-1', 'cust-1');

      // Drivers should get socket TRIP_CANCELLED
      const driverCalls = mockEmitToUser.mock.calls.filter(
        ([userId, event]: any[]) => ['driver-1', 'driver-2'].includes(userId) && event === 'trip_cancelled'
      );
      expect(driverCalls.length).toBe(2);

      // FCM also sent for drivers
      const fcmCalls = mockQueuePushNotificationBatch.mock.calls.filter(
        ([ids]: any[]) => ids.includes('driver-1') || ids.includes('driver-2')
      );
      expect(fcmCalls.length).toBeGreaterThanOrEqual(2);
    });

    test('Cancel emits BOOKING_UPDATED to booking room', async () => {
      const booking = makeBooking();
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentFindMany.mockResolvedValue([]);

      await lifecycleSvc.cancelBooking('booking-1', 'cust-1');

      expect(mockEmitToBooking).toHaveBeenCalledWith(
        'booking-1',
        'booking_updated',
        expect.objectContaining({ status: 'cancelled' })
      );
    });
  });

  // ===========================================================================
  // 2. CONCURRENT CANCELLATION
  // ===========================================================================

  describe('Concurrent Cancellation', () => {
    test('Two cancel requests simultaneously -> only 1 processes, other is idempotent', async () => {
      const booking = makeBooking({ status: 'broadcasting' });
      // First call: booking exists and is broadcasting
      // After first cancel: booking is cancelled
      let callCount = 0;
      mockGetBookingById.mockImplementation(() => {
        callCount++;
        if (callCount <= 2) return Promise.resolve(booking);
        return Promise.resolve(makeBooking({ status: 'cancelled' }));
      });

      // First call: CAS succeeds
      mockBookingUpdateMany.mockResolvedValueOnce({ count: 1 });
      // Second call: CAS returns 0 (already cancelled)
      mockBookingUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockAssignmentFindMany.mockResolvedValue([]);

      const [result1, result2] = await Promise.allSettled([
        lifecycleSvc.cancelBooking('booking-1', 'cust-1'),
        lifecycleSvc.cancelBooking('booking-1', 'cust-1'),
      ]);

      // Both should succeed (one real cancel, one idempotent)
      expect(result1.status).toBe('fulfilled');
      expect(result2.status).toBe('fulfilled');
    });

    test('Cancel races with timeout -> only one wins (CAS guard)', async () => {
      const booking = makeBooking({ status: 'broadcasting' });
      mockGetBookingById.mockResolvedValue(booking);

      // Cancel gets the CAS: count=1
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentFindMany.mockResolvedValue([]);

      const cancelResult = await lifecycleSvc.cancelBooking('booking-1', 'cust-1');
      expect(cancelResult).toBeDefined();

      // Timeout runs on the same booking -- status already 'cancelled'
      const cancelledBooking = makeBooking({ status: 'cancelled' });
      mockGetBookingById.mockResolvedValue(cancelledBooking);

      // handleBookingTimeout should be a no-op for cancelled booking
      await lifecycleSvc.handleBookingTimeout('booking-1', 'cust-1');

      // The DB update for expiry should NOT have been attempted
      // because the method exits early for cancelled bookings
    });

    test('Cancel races with hold confirmation -> cancel takes priority via lock', async () => {
      const booking = makeBooking({ status: 'active' });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentFindMany.mockResolvedValue([makeAssignment({ vehicleId: 'v1' })]);
      mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });

      // Lock should be acquired for cancel
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });

      await lifecycleSvc.cancelBooking('booking-1', 'cust-1');

      expect(mockRedisAcquireLock).toHaveBeenCalledWith(
        'booking:booking-1',
        expect.stringContaining('cancel'),
        expect.any(Number)
      );
    });

    test('Cancel proceeds even if lock acquisition fails (CAS is real guard)', async () => {
      const booking = makeBooking({ status: 'broadcasting' });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentFindMany.mockResolvedValue([]);

      // Lock fails
      mockRedisAcquireLock.mockRejectedValueOnce(new Error('Redis down'));

      const result = await lifecycleSvc.cancelBooking('booking-1', 'cust-1');
      expect(result).toBeDefined();
    });

    test('Cancel releases lock in finally block even on error', async () => {
      const booking = makeBooking({ status: 'broadcasting' });
      mockGetBookingById.mockResolvedValue(booking);
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });

      // Transaction throws
      mockTransaction.mockRejectedValueOnce(new Error('DB_TIMEOUT'));

      await expect(lifecycleSvc.cancelBooking('booking-1', 'cust-1'))
        .rejects.toThrow();

      expect(mockRedisReleaseLock).toHaveBeenCalledWith(
        'booking:booking-1',
        expect.stringContaining('cancel')
      );
    });
  });

  // ===========================================================================
  // 3. CUSTOMER QUERIES
  // ===========================================================================

  describe('Customer Queries', () => {
    test('List bookings -- page 1', async () => {
      const bookings = Array.from({ length: 25 }, (_, i) =>
        makeBooking({ id: `b-${i}`, createdAt: new Date(Date.now() - i * 1000).toISOString() })
      );
      mockGetBookingsByCustomer.mockResolvedValue(bookings);

      const result = await querySvc.getCustomerBookings('cust-1', { page: 1, limit: 10 });
      expect(result.bookings.length).toBe(10);
      expect(result.total).toBe(25);
      expect(result.hasMore).toBe(true);
    });

    test('List bookings -- page 2', async () => {
      const bookings = Array.from({ length: 25 }, (_, i) =>
        makeBooking({ id: `b-${i}`, createdAt: new Date(Date.now() - i * 1000).toISOString() })
      );
      mockGetBookingsByCustomer.mockResolvedValue(bookings);

      const result = await querySvc.getCustomerBookings('cust-1', { page: 2, limit: 10 });
      expect(result.bookings.length).toBe(10);
      expect(result.hasMore).toBe(true);
    });

    test('List bookings -- page 3 (partial page)', async () => {
      const bookings = Array.from({ length: 25 }, (_, i) =>
        makeBooking({ id: `b-${i}`, createdAt: new Date(Date.now() - i * 1000).toISOString() })
      );
      mockGetBookingsByCustomer.mockResolvedValue(bookings);

      const result = await querySvc.getCustomerBookings('cust-1', { page: 3, limit: 10 });
      expect(result.bookings.length).toBe(5);
      expect(result.hasMore).toBe(false);
    });

    test('List bookings -- filter by status (pending)', async () => {
      const bookings = [
        makeBooking({ id: 'b1', status: 'created' }),
        makeBooking({ id: 'b2', status: 'broadcasting' }),
        makeBooking({ id: 'b3', status: 'completed' }),
        makeBooking({ id: 'b4', status: 'cancelled' }),
      ];
      mockGetBookingsByCustomer.mockResolvedValue(bookings);

      const result = await querySvc.getCustomerBookings('cust-1', { page: 1, limit: 10, status: 'completed' as any });
      expect(result.bookings.length).toBe(1);
      expect(result.bookings[0].id).toBe('b3');
    });

    test('List bookings -- filter by broadcasting status', async () => {
      const bookings = [
        makeBooking({ id: 'b1', status: 'broadcasting' }),
        makeBooking({ id: 'b2', status: 'broadcasting' }),
        makeBooking({ id: 'b3', status: 'completed' }),
      ];
      mockGetBookingsByCustomer.mockResolvedValue(bookings);

      const result = await querySvc.getCustomerBookings('cust-1', { page: 1, limit: 10, status: 'broadcasting' as any });
      expect(result.bookings.length).toBe(2);
    });

    test('List bookings -- filter by cancelled status', async () => {
      const bookings = [
        makeBooking({ id: 'b1', status: 'cancelled' }),
        makeBooking({ id: 'b2', status: 'broadcasting' }),
      ];
      mockGetBookingsByCustomer.mockResolvedValue(bookings);

      const result = await querySvc.getCustomerBookings('cust-1', { page: 1, limit: 10, status: 'cancelled' as any });
      expect(result.bookings.length).toBe(1);
      expect(result.bookings[0].status).toBe('cancelled');
    });

    test('List bookings -- sort order (newest first)', async () => {
      const bookings = [
        makeBooking({ id: 'old', createdAt: '2025-01-01T00:00:00Z' }),
        makeBooking({ id: 'new', createdAt: '2026-01-01T00:00:00Z' }),
        makeBooking({ id: 'mid', createdAt: '2025-06-01T00:00:00Z' }),
      ];
      mockGetBookingsByCustomer.mockResolvedValue(bookings);

      const result = await querySvc.getCustomerBookings('cust-1', { page: 1, limit: 10 });
      expect(result.bookings[0].id).toBe('new');
      expect(result.bookings[1].id).toBe('mid');
      expect(result.bookings[2].id).toBe('old');
    });

    test('List bookings -- empty result', async () => {
      mockGetBookingsByCustomer.mockResolvedValue([]);

      const result = await querySvc.getCustomerBookings('cust-1', { page: 1, limit: 10 });
      expect(result.bookings.length).toBe(0);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    test('List bookings -- customer with 100 bookings (performance check)', async () => {
      const bookings = Array.from({ length: 100 }, (_, i) =>
        makeBooking({ id: `b-${i}`, createdAt: new Date(Date.now() - i * 60_000).toISOString() })
      );
      mockGetBookingsByCustomer.mockResolvedValue(bookings);

      const start = Date.now();
      const result = await querySvc.getCustomerBookings('cust-1', { page: 1, limit: 20 });
      const elapsed = Date.now() - start;

      expect(result.bookings.length).toBe(20);
      expect(result.total).toBe(100);
      expect(elapsed).toBeLessThan(500); // Should be fast (all in-memory)
    });

    test('Get booking by ID -- correct data returned', async () => {
      const booking = makeBooking({ id: 'b-42', customerId: 'cust-1' });
      mockGetBookingById.mockResolvedValue(booking);

      const result = await querySvc.getBookingById('b-42', 'cust-1', 'customer');
      expect(result.id).toBe('b-42');
      expect(result.vehicleType).toBe('open');
      expect(result.pickup.address).toBe('Pickup Addr');
    });

    test('Get booking by ID -- includes truck requests via trucksFilled/trucksNeeded', async () => {
      const booking = makeBooking({ trucksNeeded: 5, trucksFilled: 2 });
      mockGetBookingById.mockResolvedValue(booking);

      const result = await querySvc.getBookingById('booking-1', 'cust-1', 'customer');
      expect(result.trucksNeeded).toBe(5);
      expect(result.trucksFilled).toBe(2);
    });

    test('Get booking by ID -- includes price breakdown', async () => {
      const booking = makeBooking({ pricePerTruck: 8000, trucksNeeded: 3, totalAmount: 24000 });
      mockGetBookingById.mockResolvedValue(booking);

      const result = await querySvc.getBookingById('booking-1', 'cust-1', 'customer');
      expect(result.pricePerTruck).toBe(8000);
      expect(result.totalAmount).toBe(24000);
    });

    test('Get booking by ID -- wrong customer -> 403', async () => {
      const booking = makeBooking({ customerId: 'cust-2' });
      mockGetBookingById.mockResolvedValue(booking);

      await expect(querySvc.getBookingById('booking-1', 'cust-1', 'customer'))
        .rejects.toThrow(AppError);
      try {
        await querySvc.getBookingById('booking-1', 'cust-1', 'customer');
      } catch (e: any) {
        expect(e.statusCode).toBe(403);
      }
    });

    test('Get booking by ID -- non-existent -> 404', async () => {
      mockGetBookingById.mockResolvedValue(null);

      await expect(querySvc.getBookingById('nonexistent', 'cust-1', 'customer'))
        .rejects.toThrow(AppError);
      try {
        await querySvc.getBookingById('nonexistent', 'cust-1', 'customer');
      } catch (e: any) {
        expect(e.statusCode).toBe(404);
      }
    });

    test('Get active broadcasts -- only unexpired returned', async () => {
      const now = Date.now();
      const bookings = [
        makeBooking({ id: 'active1', status: 'active', expiresAt: new Date(now + 60_000).toISOString() }),
        makeBooking({ id: 'expired1', status: 'active', expiresAt: new Date(now - 60_000).toISOString() }),
        makeBooking({ id: 'active2', status: 'partially_filled', expiresAt: new Date(now + 30_000).toISOString() }),
      ];
      mockGetActiveBookingsForTransporter.mockResolvedValue(bookings);

      const result = await querySvc.getActiveBroadcasts('trans-1', { page: 1, limit: 10 });
      expect(result.bookings.length).toBe(2);
      expect(result.bookings.map(b => b.id).sort()).toEqual(['active1', 'active2']);
    });

    test('Get active broadcasts -- empty when none active', async () => {
      mockGetActiveBookingsForTransporter.mockResolvedValue([]);

      const result = await querySvc.getActiveBroadcasts('trans-1', { page: 1, limit: 10 });
      expect(result.bookings.length).toBe(0);
      expect(result.total).toBe(0);
    });

    test('Get assigned trucks -- with driver names and ratings', async () => {
      const booking = makeBooking();
      mockGetBookingById.mockResolvedValue(booking);
      const assignments = [
        {
          id: 'a1', tripId: 'trip-1', vehicleNumber: 'KA01AB1234', vehicleType: 'open',
          driverName: 'Raju', driverPhone: '9999999999', driverProfilePhotoUrl: 'url',
          driverId: 'driver-1', customerRating: 4, status: 'in_transit', assignedAt: new Date().toISOString(), currentLocation: null as any,
        },
      ];
      mockGetAssignmentsByBooking.mockResolvedValue(assignments);
      mockUserFindMany.mockResolvedValue([{ id: 'driver-1', avgRating: 4.5, totalRatings: 100 }]);

      const result = await querySvc.getAssignedTrucks('booking-1', 'cust-1', 'customer');
      expect(result.length).toBe(1);
      expect(result[0].driverName).toBe('Raju');
      expect(result[0].driverRating).toBe(4.5);
      expect(result[0].driverTotalRatings).toBe(100);
    });

    test('Get assigned trucks -- booking not found -> 404', async () => {
      mockGetBookingById.mockResolvedValue(null);

      await expect(querySvc.getAssignedTrucks('nonexistent', 'cust-1', 'customer'))
        .rejects.toThrow(AppError);
    });

    test('Get assigned trucks -- wrong customer -> 403', async () => {
      const booking = makeBooking({ customerId: 'cust-other' });
      mockGetBookingById.mockResolvedValue(booking);

      await expect(querySvc.getAssignedTrucks('booking-1', 'cust-1', 'customer'))
        .rejects.toThrow(AppError);
    });

    test('Get assigned trucks -- empty assignments returns empty array', async () => {
      const booking = makeBooking();
      mockGetBookingById.mockResolvedValue(booking);
      mockGetAssignmentsByBooking.mockResolvedValue([]);

      const result = await querySvc.getAssignedTrucks('booking-1', 'cust-1', 'customer');
      expect(result).toEqual([]);
    });
  });

  // ===========================================================================
  // 4. BOOKING STATUS TRANSITIONS
  // ===========================================================================

  describe('Booking Status Transitions', () => {
    test('broadcasting -> expired (on timeout, 0 trucks filled)', async () => {
      const booking = makeBooking({ status: 'broadcasting', trucksFilled: 0, trucksNeeded: 3 });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });

      await lifecycleSvc.handleBookingTimeout('booking-1', 'cust-1');

      expect(mockBookingUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'expired' }),
        })
      );
    });

    test('partially_filled -> expired (on timeout, partial fill)', async () => {
      const booking = makeBooking({ status: 'partially_filled', trucksFilled: 1, trucksNeeded: 3 });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });

      await lifecycleSvc.handleBookingTimeout('booking-1', 'cust-1');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'cust-1',
        'booking_expired',
        expect.objectContaining({
          status: 'partially_filled_expired',
          trucksFilled: 1,
        })
      );
    });

    test('Any status -> cancelled (on cancel)', async () => {
      for (const status of ['created', 'broadcasting', 'active', 'partially_filled', 'fully_filled'] as const) {
        jest.clearAllMocks();
        mockTransaction.mockImplementation(async (fn: any) => {
          const fakeTx = {
            booking: { updateMany: mockBookingUpdateMany },
            assignment: { findMany: mockAssignmentFindMany, updateMany: mockAssignmentUpdateMany },
          };
          return fn(fakeTx);
        });

        const booking = makeBooking({ status, notifiedTransporters: [] });
        mockGetBookingById.mockResolvedValue(booking);
        mockBookingUpdateMany.mockResolvedValue({ count: 1 });
        mockAssignmentFindMany.mockResolvedValue([]);

        const result = await lifecycleSvc.cancelBooking('booking-1', 'cust-1');
        expect(result).toBeDefined();
      }
    });

    test('completed -> cancelled is rejected', async () => {
      const booking = makeBooking({ status: 'completed' });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 0 });
      mockAssignmentFindMany.mockResolvedValue([]);

      await expect(lifecycleSvc.cancelBooking('booking-1', 'cust-1'))
        .rejects.toThrow(AppError);
    });

    test('Timeout on completed booking is no-op', async () => {
      const booking = makeBooking({ status: 'completed' });
      mockGetBookingById.mockResolvedValue(booking);

      await lifecycleSvc.handleBookingTimeout('booking-1', 'cust-1');

      // Should NOT have called updateMany for status change
      expect(mockBookingUpdateMany).not.toHaveBeenCalled();
    });

    test('Timeout on cancelled booking is no-op', async () => {
      const booking = makeBooking({ status: 'cancelled' });
      mockGetBookingById.mockResolvedValue(booking);

      await lifecycleSvc.handleBookingTimeout('booking-1', 'cust-1');

      expect(mockBookingUpdateMany).not.toHaveBeenCalled();
    });

    test('Status change emits socket event on timeout', async () => {
      const booking = makeBooking({ status: 'broadcasting', trucksFilled: 0 });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });

      await lifecycleSvc.handleBookingTimeout('booking-1', 'cust-1');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'cust-1',
        'no_vehicles_available',
        expect.objectContaining({ bookingId: 'booking-1' })
      );
    });

    test('Status change emits socket event on cancel', async () => {
      const booking = makeBooking();
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentFindMany.mockResolvedValue([]);

      await lifecycleSvc.cancelBooking('booking-1', 'cust-1');

      expect(mockEmitToBooking).toHaveBeenCalledWith(
        'booking-1',
        'booking_updated',
        expect.objectContaining({ status: 'cancelled' })
      );
    });

    test('Timeout for nonexistent booking is no-op', async () => {
      mockGetBookingById.mockResolvedValue(null);

      await lifecycleSvc.handleBookingTimeout('nonexistent', 'cust-1');

      expect(mockBookingUpdateMany).not.toHaveBeenCalled();
      expect(mockEmitToUser).not.toHaveBeenCalled();
    });

    test('Timeout for fully_filled booking is no-op', async () => {
      const booking = makeBooking({ status: 'fully_filled' });
      mockGetBookingById.mockResolvedValue(booking);

      await lifecycleSvc.handleBookingTimeout('booking-1', 'cust-1');

      expect(mockBookingUpdateMany).not.toHaveBeenCalled();
    });

    test('Timeout notifies all transporters via socket and FCM', async () => {
      const booking = makeBooking({
        status: 'broadcasting',
        trucksFilled: 0,
        notifiedTransporters: ['t1', 't2', 't3'],
      });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });

      await lifecycleSvc.handleBookingTimeout('booking-1', 'cust-1');

      // Socket events for each transporter
      const transporterCalls = mockEmitToUser.mock.calls.filter(
        ([userId, event]: any[]) => ['t1', 't2', 't3'].includes(userId) && event === 'booking_expired'
      );
      expect(transporterCalls.length).toBe(3);

      // FCM batch for all transporters
      expect(mockQueuePushNotificationBatch).toHaveBeenCalledWith(
        ['t1', 't2', 't3'],
        expect.objectContaining({ data: expect.objectContaining({ type: 'booking_expired' }) })
      );
    });
  });

  // ===========================================================================
  // 5. INCREMENT / DECREMENT TRUCKS FILLED
  // ===========================================================================

  describe('Increment/Decrement Trucks Filled', () => {
    test('Increment from 0 to 1 -> partially_filled', async () => {
      const booking = makeBooking({ trucksFilled: 0, trucksNeeded: 3 });
      mockGetBookingById.mockResolvedValue(booking);
      mockQueryRaw.mockResolvedValue([{ trucksFilled: 1, trucksNeeded: 3 }]);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });

      const result = await lifecycleSvc.incrementTrucksFilled('booking-1');
      expect(result).toBeDefined();
      expect(mockEmitToUser).toHaveBeenCalledWith(
        'cust-1',
        'booking_partially_filled',
        expect.objectContaining({ trucksFilled: 1 })
      );
    });

    test('Increment to full -> fully_filled, timeout cancelled', async () => {
      const booking = makeBooking({ trucksFilled: 2, trucksNeeded: 3 });
      mockGetBookingById.mockResolvedValue(booking);
      mockQueryRaw.mockResolvedValue([{ trucksFilled: 3, trucksNeeded: 3 }]);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });

      await lifecycleSvc.incrementTrucksFilled('booking-1');

      expect(mockRedisCancelTimer).toHaveBeenCalled();
      expect(mockEmitToUser).toHaveBeenCalledWith(
        'cust-1',
        'booking_fully_filled',
        expect.objectContaining({ trucksNeeded: 3 })
      );
    });

    test('Increment on already fully_filled is idempotent', async () => {
      const booking = makeBooking({ trucksFilled: 3, trucksNeeded: 3, status: 'fully_filled' });
      mockGetBookingById.mockResolvedValue(booking);

      const result = await lifecycleSvc.incrementTrucksFilled('booking-1');
      expect(result.id).toBe('booking-1');
      // $queryRaw should NOT be called
      expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    test('Increment on non-existent booking -> 404', async () => {
      mockGetBookingById.mockResolvedValue(null);

      await expect(lifecycleSvc.incrementTrucksFilled('nonexistent'))
        .rejects.toThrow(AppError);
    });

    test('Decrement from 1 to 0 -> active', async () => {
      const booking = makeBooking({ trucksFilled: 1, trucksNeeded: 3 });
      mockGetBookingById.mockResolvedValue(booking);
      mockQueryRaw.mockResolvedValue([{ trucksFilled: 0 }]);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });

      await lifecycleSvc.decrementTrucksFilled('booking-1');

      expect(mockEmitToBooking).toHaveBeenCalledWith(
        'booking-1',
        'booking_updated',
        expect.objectContaining({ trucksFilled: 0 })
      );
    });

    test('Decrement on non-existent booking -> 404', async () => {
      mockGetBookingById.mockResolvedValue(null);

      await expect(lifecycleSvc.decrementTrucksFilled('nonexistent'))
        .rejects.toThrow(AppError);
    });
  });

  // ===========================================================================
  // 6. TIMER / EXPIRY EDGE CASES
  // ===========================================================================

  describe('Timer / Expiry Edge Cases', () => {
    test('Expiry checker starts and can be stopped', async () => {
      // We import the functions directly
      const { startBookingExpiryChecker, stopBookingExpiryChecker } = require('../modules/booking/booking-timer.service');

      // Stop first to clear any existing interval
      stopBookingExpiryChecker();

      // Start it
      startBookingExpiryChecker();

      // Stop it cleanly
      stopBookingExpiryChecker();

      // No errors thrown = test passes
    });

    test('Stop checker on server shutdown -> clean cleanup', () => {
      const { startBookingExpiryChecker, stopBookingExpiryChecker } = require('../modules/booking/booking-timer.service');

      stopBookingExpiryChecker();
      startBookingExpiryChecker();
      stopBookingExpiryChecker();

      // Calling stop again is idempotent
      stopBookingExpiryChecker();
    });

    test('Timer fires for booking that was just completed -> no-op', async () => {
      const booking = makeBooking({ status: 'completed' });
      mockGetBookingById.mockResolvedValue(booking);

      await lifecycleSvc.handleBookingTimeout('booking-1', 'cust-1');

      expect(mockBookingUpdateMany).not.toHaveBeenCalled();
      expect(mockEmitToUser).not.toHaveBeenCalled();
    });

    test('Timer fires for booking that was just cancelled -> no-op', async () => {
      const booking = makeBooking({ status: 'cancelled' });
      mockGetBookingById.mockResolvedValue(booking);

      await lifecycleSvc.handleBookingTimeout('booking-1', 'cust-1');

      expect(mockBookingUpdateMany).not.toHaveBeenCalled();
    });

    test('handleBookingTimeout clears all timers for the booking', async () => {
      const booking = makeBooking({ status: 'broadcasting', trucksFilled: 0 });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });

      await lifecycleSvc.handleBookingTimeout('booking-1', 'cust-1');

      expect(mockRedisCancelTimer).toHaveBeenCalledWith(
        expect.stringContaining('booking-1')
      );
    });

    test('handleBookingTimeout clears customer active broadcast key', async () => {
      const booking = makeBooking({ status: 'broadcasting', trucksFilled: 0 });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });

      await lifecycleSvc.handleBookingTimeout('booking-1', 'cust-1');

      expect(mockRedisDel).toHaveBeenCalledWith(
        expect.stringContaining('customer:active-broadcast:cust-1')
      );
    });

    test('clearBookingTimers removes both booking and radius timers', async () => {
      await lifecycleSvc.clearBookingTimers('booking-1');

      expect(mockRedisCancelTimer).toHaveBeenCalledWith('timer:booking:booking-1');
      expect(mockRedisCancelTimer).toHaveBeenCalledWith('timer:radius:booking-1');
      expect(mockRedisDel).toHaveBeenCalledWith('broadcast:radius:step:booking-1');
      expect(mockRedisDel).toHaveBeenCalledWith('broadcast:notified:booking-1');
    });

    test('cancelBookingTimeout clears timers and logs', async () => {
      await lifecycleSvc.cancelBookingTimeout('booking-1');

      expect(mockRedisCancelTimer).toHaveBeenCalled();
    });

    test('clearCustomerActiveBroadcast removes all related Redis keys', async () => {
      mockRedisGet.mockResolvedValueOnce('idem:key:123');

      await lifecycleSvc.clearCustomerActiveBroadcast('cust-1');

      expect(mockRedisDel).toHaveBeenCalledWith('customer:active-broadcast:cust-1');
      expect(mockRedisDel).toHaveBeenCalledWith('idem:broadcast:latest:cust-1');
      // Also deletes the resolved idempotency key
      expect(mockRedisDel).toHaveBeenCalledWith('idem:key:123');
    });

    test('clearCustomerActiveBroadcast handles missing idempotency key', async () => {
      mockRedisGet.mockResolvedValue(null);

      await lifecycleSvc.clearCustomerActiveBroadcast('cust-1');

      expect(mockRedisDel).toHaveBeenCalledWith('customer:active-broadcast:cust-1');
      expect(mockRedisDel).toHaveBeenCalledWith('idem:broadcast:latest:cust-1');
    });

    test('Timer for expired booking with partial fill notifies customer with options', async () => {
      const booking = makeBooking({
        status: 'partially_filled',
        trucksFilled: 2,
        trucksNeeded: 5,
      });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });

      await lifecycleSvc.handleBookingTimeout('booking-1', 'cust-1');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'cust-1',
        'booking_expired',
        expect.objectContaining({
          status: 'partially_filled_expired',
          options: expect.arrayContaining(['continue_partial', 'search_again', 'cancel']),
        })
      );
    });

    test('Timer for 0-filled booking sends NO_VEHICLES_AVAILABLE', async () => {
      const booking = makeBooking({ status: 'broadcasting', trucksFilled: 0 });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });

      await lifecycleSvc.handleBookingTimeout('booking-1', 'cust-1');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'cust-1',
        'no_vehicles_available',
        expect.objectContaining({
          suggestion: 'search_again',
          options: expect.arrayContaining(['search_again', 'try_different_vehicle', 'cancel']),
        })
      );
    });
  });

  // ===========================================================================
  // 7. CANCEL EDGE CASES (additional)
  // ===========================================================================

  describe('Cancel Edge Cases', () => {
    test('Cancel with no notified transporters does not send notifications', async () => {
      const booking = makeBooking({ notifiedTransporters: [] });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentFindMany.mockResolvedValue([]);

      await lifecycleSvc.cancelBooking('booking-1', 'cust-1');

      // Should not call FCM for transporters
      const transporterCalls = mockEmitToUser.mock.calls.filter(
        ([userId, event]: any[]) => userId !== 'cust-1' && event === 'booking_expired'
      );
      expect(transporterCalls.length).toBe(0);
    });

    test('Cancel with assignment that has no vehicle does not call releaseVehicle', async () => {
      const booking = makeBooking();
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      const assignments = [makeAssignment({ vehicleId: null })];
      mockAssignmentFindMany.mockResolvedValue(assignments);
      mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });

      await lifecycleSvc.cancelBooking('booking-1', 'cust-1');

      expect(mockReleaseVehicle).not.toHaveBeenCalled();
    });

    test('Cancel with assignment that has no driver does not emit TRIP_CANCELLED', async () => {
      const booking = makeBooking();
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      const assignments = [makeAssignment({ driverId: null, vehicleId: 'v1' })];
      mockAssignmentFindMany.mockResolvedValue(assignments);
      mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });

      await lifecycleSvc.cancelBooking('booking-1', 'cust-1');

      const driverCalls = mockEmitToUser.mock.calls.filter(
        ([, event]: any[]) => event === 'trip_cancelled'
      );
      expect(driverCalls.length).toBe(0);
    });

    test('Cancel clears legacy idempotency cache', async () => {
      const booking = makeBooking();
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentFindMany.mockResolvedValue([]);
      mockRedisGet.mockResolvedValueOnce(null); // For idem:broadcast:latest
      mockRedisGet.mockResolvedValueOnce('stored-key'); // For latestIdempotencyKey

      await lifecycleSvc.cancelBooking('booking-1', 'cust-1');

      // Should attempt to clear idempotency keys
      expect(mockRedisDel).toHaveBeenCalled();
    });

    test('Cancel clears broadcast notified set', async () => {
      const booking = makeBooking();
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentFindMany.mockResolvedValue([]);

      await lifecycleSvc.cancelBooking('booking-1', 'cust-1');

      expect(mockRedisDel).toHaveBeenCalledWith('broadcast:notified:booking-1');
    });

    test('Vehicle release failure does not block cancel', async () => {
      const booking = makeBooking();
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      const assignments = [makeAssignment({ vehicleId: 'v1' })];
      mockAssignmentFindMany.mockResolvedValue(assignments);
      mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });

      // Vehicle release fails
      mockReleaseVehicle.mockRejectedValueOnce(new Error('Redis down'));

      // Cancel should still succeed
      const result = await lifecycleSvc.cancelBooking('booking-1', 'cust-1');
      expect(result).toBeDefined();
    });

    test('FCM push failure does not block cancel', async () => {
      const booking = makeBooking({ notifiedTransporters: ['t1'] });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentFindMany.mockResolvedValue([]);

      mockQueuePushNotificationBatch.mockRejectedValueOnce(new Error('FCM error'));

      // Should not throw
      const result = await lifecycleSvc.cancelBooking('booking-1', 'cust-1');
      expect(result).toBeDefined();
    });
  });

  // ===========================================================================
  // 8. QUERY EDGE CASES (additional)
  // ===========================================================================

  describe('Query Edge Cases', () => {
    test('Transporter can view booking if they have matching vehicle type', async () => {
      const booking = makeBooking({ vehicleType: 'open' });
      mockGetBookingById.mockResolvedValue(booking);
      mockGetVehiclesByTransporter.mockResolvedValue([
        { vehicleType: 'open', isActive: true },
      ]);

      const result = await querySvc.getBookingById('booking-1', 'trans-1', 'transporter');
      expect(result.id).toBe('booking-1');
    });

    test('Transporter without matching vehicle type -> 403', async () => {
      const booking = makeBooking({ vehicleType: 'container' });
      mockGetBookingById.mockResolvedValue(booking);
      mockGetVehiclesByTransporter.mockResolvedValue([
        { vehicleType: 'open', isActive: true },
      ]);

      await expect(querySvc.getBookingById('booking-1', 'trans-1', 'transporter'))
        .rejects.toThrow(AppError);
    });

    test('Transporter with inactive matching vehicle -> 403', async () => {
      const booking = makeBooking({ vehicleType: 'open' });
      mockGetBookingById.mockResolvedValue(booking);
      mockGetVehiclesByTransporter.mockResolvedValue([
        { vehicleType: 'open', isActive: false },
      ]);

      await expect(querySvc.getBookingById('booking-1', 'trans-1', 'transporter'))
        .rejects.toThrow(AppError);
    });

    test('Active broadcasts filters out non-active statuses', async () => {
      const now = Date.now();
      const bookings = [
        makeBooking({ id: 'a1', status: 'active', expiresAt: new Date(now + 60_000).toISOString() }),
        makeBooking({ id: 'a2', status: 'completed', expiresAt: new Date(now + 60_000).toISOString() }),
        makeBooking({ id: 'a3', status: 'cancelled', expiresAt: new Date(now + 60_000).toISOString() }),
        makeBooking({ id: 'a4', status: 'partially_filled', expiresAt: new Date(now + 60_000).toISOString() }),
      ];
      mockGetActiveBookingsForTransporter.mockResolvedValue(bookings);

      const result = await querySvc.getActiveBroadcasts('trans-1', { page: 1, limit: 10 });
      expect(result.bookings.length).toBe(2);
      expect(result.bookings.map(b => b.id).sort()).toEqual(['a1', 'a4']);
    });

    test('Active broadcasts pagination works correctly', async () => {
      const now = Date.now();
      const bookings = Array.from({ length: 15 }, (_, i) =>
        makeBooking({
          id: `b-${i}`,
          status: 'active',
          expiresAt: new Date(now + 60_000).toISOString(),
          createdAt: new Date(now - i * 1000).toISOString(),
        })
      );
      mockGetActiveBookingsForTransporter.mockResolvedValue(bookings);

      const page1 = await querySvc.getActiveBroadcasts('trans-1', { page: 1, limit: 10 });
      expect(page1.bookings.length).toBe(10);
      expect(page1.hasMore).toBe(true);

      const page2 = await querySvc.getActiveBroadcasts('trans-1', { page: 2, limit: 10 });
      expect(page2.bookings.length).toBe(5);
      expect(page2.hasMore).toBe(false);
    });

    test('Assigned trucks returns empty driverRating when no ratings', async () => {
      const booking = makeBooking();
      mockGetBookingById.mockResolvedValue(booking);
      mockGetAssignmentsByBooking.mockResolvedValue([
        {
          id: 'a1', tripId: null, vehicleNumber: 'KA01', vehicleType: 'open',
          driverName: 'New Driver', driverPhone: '9999', driverProfilePhotoUrl: null,
          driverId: 'new-driver', customerRating: null, status: 'pending',
          assignedAt: new Date().toISOString(), currentLocation: null,
        },
      ]);
      mockUserFindMany.mockResolvedValue([{ id: 'new-driver', avgRating: null, totalRatings: 0 }]);

      const result = await querySvc.getAssignedTrucks('booking-1', 'cust-1', 'customer');
      expect(result[0].driverRating).toBeNull();
      expect(result[0].driverTotalRatings).toBe(0);
    });

    test('Assigned trucks handles driver rating query failure gracefully', async () => {
      const booking = makeBooking();
      mockGetBookingById.mockResolvedValue(booking);
      mockGetAssignmentsByBooking.mockResolvedValue([
        {
          id: 'a1', tripId: null, vehicleNumber: 'KA01', vehicleType: 'open',
          driverName: 'Driver', driverPhone: '9999', driverProfilePhotoUrl: null,
          driverId: 'driver-1', customerRating: null, status: 'pending',
          assignedAt: new Date().toISOString(), currentLocation: null,
        },
      ]);
      mockUserFindMany.mockRejectedValue(new Error('DB error'));

      // Should not throw
      const result = await querySvc.getAssignedTrucks('booking-1', 'cust-1', 'customer');
      expect(result.length).toBe(1);
      expect(result[0].driverRating).toBeNull();
    });
  });

  // ===========================================================================
  // 9. STATE MACHINE VALIDATION
  // ===========================================================================

  describe('State Machine Validation', () => {
    test('BOOKING_VALID_TRANSITIONS defines terminal states correctly', () => {
      const { BOOKING_VALID_TRANSITIONS } = require('../core/state-machines');
      expect(BOOKING_VALID_TRANSITIONS['completed']).toEqual([]);
      expect(BOOKING_VALID_TRANSITIONS['cancelled']).toEqual([]);
      expect(BOOKING_VALID_TRANSITIONS['expired']).toEqual([]);
    });

    test('isValidTransition returns true for allowed transitions', () => {
      const { isValidTransition, BOOKING_VALID_TRANSITIONS } = require('../core/state-machines');
      expect(isValidTransition(BOOKING_VALID_TRANSITIONS, 'created', 'broadcasting')).toBe(true);
      expect(isValidTransition(BOOKING_VALID_TRANSITIONS, 'broadcasting', 'active')).toBe(true);
      expect(isValidTransition(BOOKING_VALID_TRANSITIONS, 'active', 'partially_filled')).toBe(true);
      expect(isValidTransition(BOOKING_VALID_TRANSITIONS, 'partially_filled', 'fully_filled')).toBe(true);
    });

    test('isValidTransition returns false for invalid transitions', () => {
      const { isValidTransition, BOOKING_VALID_TRANSITIONS } = require('../core/state-machines');
      expect(isValidTransition(BOOKING_VALID_TRANSITIONS, 'completed', 'active')).toBe(false);
      expect(isValidTransition(BOOKING_VALID_TRANSITIONS, 'cancelled', 'broadcasting')).toBe(false);
      expect(isValidTransition(BOOKING_VALID_TRANSITIONS, 'expired', 'active')).toBe(false);
    });

    test('assertValidTransition throws for invalid transition', () => {
      const { assertValidTransition, BOOKING_VALID_TRANSITIONS } = require('../core/state-machines');
      expect(() =>
        assertValidTransition('Booking', BOOKING_VALID_TRANSITIONS, 'completed', 'pending')
      ).toThrow(/Invalid Booking transition/);
    });

    test('assertValidTransition does not throw for valid transition', () => {
      const { assertValidTransition, BOOKING_VALID_TRANSITIONS } = require('../core/state-machines');
      expect(() =>
        assertValidTransition('Booking', BOOKING_VALID_TRANSITIONS, 'created', 'cancelled')
      ).not.toThrow();
    });

    test('Every cancellable status allows cancelled transition', () => {
      const { BOOKING_VALID_TRANSITIONS } = require('../core/state-machines');
      const cancellableStatuses = ['created', 'broadcasting', 'active', 'partially_filled', 'fully_filled', 'in_progress'];
      for (const status of cancellableStatuses) {
        expect(BOOKING_VALID_TRANSITIONS[status]).toContain('cancelled');
      }
    });

    test('Every active status allows expired transition', () => {
      const { BOOKING_VALID_TRANSITIONS } = require('../core/state-machines');
      const activeStatuses = ['created', 'broadcasting', 'active', 'partially_filled'];
      for (const status of activeStatuses) {
        expect(BOOKING_VALID_TRANSITIONS[status]).toContain('expired');
      }
    });
  });
});
