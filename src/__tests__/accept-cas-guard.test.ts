/**
 * =============================================================================
 * ACCEPT CAS GUARD — Tests for FIX #4 and FIX #39 in order.service.ts
 * =============================================================================
 *
 * Validates the CAS (Compare-And-Swap) guard added to acceptTruckRequest:
 *   - status: { notIn: ['cancelled', 'expired', 'fully_filled'] }
 *   - expiresAt: { gt: new Date().toISOString() }
 *
 * These guards prevent accepting on terminal/expired orders and close the
 * cancel+accept race window.
 *
 * Tests:
 *   1.  Accept on active order (status=pending/searching)     → succeeds
 *   2.  Accept on cancelled order                              → CAS count=0, fails
 *   3.  Accept on expired order                                → CAS count=0, fails
 *   4.  Accept on fully_filled order                           → CAS count=0, fails
 *   5.  Accept on partially_filled order                       → succeeds
 *   6.  Accept when expiresAt is in the past                   → CAS count=0, fails
 *   7.  Accept when expiresAt is far in the future             → succeeds
 *   8.  Concurrent cancel + accept race                        → only one succeeds
 *   9.  Double-tap accept (same transporter)                   → idempotent handling
 *   10. Accept after CAS succeeds but downstream guard         → check assignment guard
 *
 * @author Weelo Team
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — Must precede all imports
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
const mockRedisGetJSON = jest.fn();
const mockRedisSetJSON = jest.fn();
const mockRedisGetExpiredTimers = jest.fn();
const mockRedisCancelTimer = jest.fn();
const mockRedisSetTimer = jest.fn();
const mockRedisExpire = jest.fn();
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
    sIsMember: (...args: any[]) => mockRedisSIsMember(...args),
    isConnected: () => mockRedisIsConnected(),
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
    // scanIterator returns an async iterable (used in clearProgressiveStepTimers)
    scanIterator: jest.fn().mockReturnValue((async function* () { /* yields nothing */ })()),
  },
}));

// ---------------------------------------------------------------------------
// Prisma mock — all models used by acceptTruckRequest
// ---------------------------------------------------------------------------
const mockTruckRequestFindUnique = jest.fn();
const mockTruckRequestUpdateMany = jest.fn();
const mockTruckRequestFindMany = jest.fn();
const mockOrderFindUnique = jest.fn();
const mockOrderUpdateMany = jest.fn();
const mockOrderUpdate = jest.fn();
const mockOrderFindFirst = jest.fn();
const mockUserFindUnique = jest.fn();
const mockVehicleFindUnique = jest.fn();
const mockVehicleUpdateMany = jest.fn();
const mockVehicleUpdate = jest.fn();
const mockAssignmentCreate = jest.fn();
const mockAssignmentFindFirst = jest.fn();
const mockAssignmentFindMany = jest.fn();
const mockAssignmentUpdateMany = jest.fn();
const mockBookingCreate = jest.fn();
const mockBookingFindFirst = jest.fn();
const mockBookingFindUnique = jest.fn();
const mockBookingUpdateMany = jest.fn();
const mockBookingUpdate = jest.fn();
const mockQueryRaw = jest.fn();
const mockTransaction = jest.fn();

// Build the transaction proxy used by withDbTimeout
function buildTxProxy() {
  return {
    truckRequest: {
      findUnique: (...a: any[]) => mockTruckRequestFindUnique(...a),
      updateMany: (...a: any[]) => mockTruckRequestUpdateMany(...a),
      findMany: (...a: any[]) => mockTruckRequestFindMany(...a),
    },
    order: {
      findUnique: (...a: any[]) => mockOrderFindUnique(...a),
      updateMany: (...a: any[]) => mockOrderUpdateMany(...a),
      update: (...a: any[]) => mockOrderUpdate(...a),
      findFirst: (...a: any[]) => mockOrderFindFirst(...a),
    },
    user: {
      findUnique: (...a: any[]) => mockUserFindUnique(...a),
    },
    vehicle: {
      findUnique: (...a: any[]) => mockVehicleFindUnique(...a),
      updateMany: (...a: any[]) => mockVehicleUpdateMany(...a),
      update: (...a: any[]) => mockVehicleUpdate(...a),
    },
    assignment: {
      create: (...a: any[]) => mockAssignmentCreate(...a),
      findFirst: (...a: any[]) => mockAssignmentFindFirst(...a),
      findMany: (...a: any[]) => mockAssignmentFindMany(...a),
      updateMany: (...a: any[]) => mockAssignmentUpdateMany(...a),
    },
    booking: {
      create: (...a: any[]) => mockBookingCreate(...a),
      findFirst: (...a: any[]) => mockBookingFindFirst(...a),
      findUnique: (...a: any[]) => mockBookingFindUnique(...a),
      updateMany: (...a: any[]) => mockBookingUpdateMany(...a),
      update: (...a: any[]) => mockBookingUpdate(...a),
    },
    $queryRaw: (...a: any[]) => mockQueryRaw(...a),
  };
}

jest.mock('../shared/database/prisma.service', () => {
  const txProxy = buildTxProxy();
  return {
    prismaClient: {
      ...txProxy,
      $transaction: (...args: any[]) => mockTransaction(...args),
    },
    withDbTimeout: jest.fn().mockImplementation(async (fn: any, _opts?: any) => {
      return fn(buildTxProxy());
    }),
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
    TruckRequestStatus: {
      searching: 'searching',
      held: 'held',
      assigned: 'assigned',
      accepted: 'accepted',
      in_progress: 'in_progress',
      completed: 'completed',
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
    Prisma: {
      TransactionIsolationLevel: { Serializable: 'Serializable' },
    },
  };
});

// ---------------------------------------------------------------------------
// DB service mock
// ---------------------------------------------------------------------------
jest.mock('../shared/database/db', () => ({
  db: {
    getBookingById: jest.fn(),
    getUserById: jest.fn(),
    createBooking: jest.fn(),
    updateBooking: jest.fn(),
    getTransportersWithVehicleType: jest.fn(),
    getVehiclesByTransporter: jest.fn(),
    getActiveBookingsForTransporter: jest.fn(),
    getActiveOrders: jest.fn(),
    getBookingsByDriver: jest.fn(),
    getTruckRequestsByOrder: jest.fn().mockResolvedValue([]),
    updateOrder: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Socket service mock
// ---------------------------------------------------------------------------
const mockEmitToUser = jest.fn();
const mockEmitToUsers = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToUsers: (...args: any[]) => mockEmitToUsers(...args),
  emitToBooking: jest.fn(),
  emitToRoom: jest.fn(),
  emitToAllTransporters: jest.fn(),
  emitToAll: jest.fn(),
  isUserConnected: jest.fn(),
  SocketEvent: {
    CONNECTED: 'connected',
    BOOKING_UPDATED: 'booking_updated',
    TRUCK_ASSIGNED: 'truck_assigned',
    TRIP_ASSIGNED: 'trip_assigned',
    TRUCK_CONFIRMED: 'truck_confirmed',
    BOOKING_EXPIRED: 'booking_expired',
    BOOKING_FULLY_FILLED: 'booking_fully_filled',
    BOOKING_PARTIALLY_FILLED: 'booking_partially_filled',
    NEW_BROADCAST: 'new_broadcast',
    TRUCK_REQUEST_ACCEPTED: 'truck_request_accepted',
    TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update',
    REQUEST_NO_LONGER_AVAILABLE: 'request_no_longer_available',
    ORDER_STATUS_UPDATE: 'order_status_update',
  },
}));

// ---------------------------------------------------------------------------
// FCM service mock
// ---------------------------------------------------------------------------
const mockSendPushNotification = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/fcm.service', () => ({
  fcmService: { sendToDevice: jest.fn().mockResolvedValue(undefined) },
  sendPushNotification: (...args: any[]) => mockSendPushNotification(...args),
}));

// ---------------------------------------------------------------------------
// Queue, availability, live-availability, vehicle-key mocks
// ---------------------------------------------------------------------------
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    addJob: jest.fn(),
    queuePushNotificationBatch: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../shared/services/availability.service', () => ({
  availabilityService: {
    loadTransporterDetailsMap: jest.fn().mockResolvedValue(new Map()),
    getTransporterDetails: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: (type: string, sub: string) => `${type}_${sub}`,
}));

jest.mock('../shared/services/cache.service', () => ({
  cacheService: { get: jest.fn(), set: jest.fn(), delete: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Transporter online mock
// ---------------------------------------------------------------------------
jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: {
    filterOnline: jest.fn().mockResolvedValue([]),
    isOnline: jest.fn().mockResolvedValue(true),
  },
}));

// ---------------------------------------------------------------------------
// Google Maps / geo / geospatial
// ---------------------------------------------------------------------------
jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: {
    calculateRoute: jest.fn().mockResolvedValue({ distanceKm: 100, durationMinutes: 120 }),
  },
}));

jest.mock('../shared/utils/geo.utils', () => ({
  roundCoord: (c: number) => Math.round(c * 100) / 100,
}));

jest.mock('../shared/utils/geospatial.utils', () => ({
  haversineDistanceKm: jest.fn().mockReturnValue(10),
}));

// ---------------------------------------------------------------------------
// Routing, pricing, progressive-radius, candidate-scorer, truck-hold, distance-matrix
// ---------------------------------------------------------------------------
jest.mock('../modules/routing', () => ({
  routingService: {
    calculateRoute: jest.fn().mockResolvedValue({ distanceKm: 100, durationMinutes: 120 }),
  },
}));

jest.mock('../modules/pricing/pricing.service', () => ({
  pricingService: {
    calculateFare: jest.fn().mockReturnValue(5000),
  },
}));

jest.mock('../modules/order/progressive-radius-matcher', () => ({
  ...jest.requireActual('../modules/order/progressive-radius-matcher'),
  progressiveRadiusMatcher: {
    findCandidates: jest.fn().mockResolvedValue([]),
    getStepCount: jest.fn().mockReturnValue(6),
    getStep: jest.fn().mockReturnValue({ radiusKm: 10, windowMs: 10_000, h3RingK: 15 }),
  },
  startProgressiveMatching: jest.fn(),
  cancelProgressiveMatching: jest.fn(),
}));

jest.mock('../shared/services/candidate-scorer.service', () => ({
  candidateScorerService: {
    scoreAndRank: jest.fn().mockReturnValue([]),
  },
}));

jest.mock('../modules/truck-hold/truck-hold.service', () => ({
  truckHoldService: {
    createHold: jest.fn().mockResolvedValue({ holdId: 'hold-001' }),
    releaseHold: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../shared/services/distance-matrix.service', () => ({
  distanceMatrixService: {
    batchGetPickupDistance: jest.fn().mockResolvedValue(new Map()),
  },
}));

// ---------------------------------------------------------------------------
// Booking payload helper, constants, state-machines, audit, vehicle-lifecycle
// ---------------------------------------------------------------------------
jest.mock('../modules/booking/booking-payload.helper', () => ({
  buildBroadcastPayload: jest.fn().mockReturnValue({}),
  getRemainingTimeoutSeconds: jest.fn().mockReturnValue(60),
}));

jest.mock('../core/constants', () => ({
  ErrorCode: {
    BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
    FARE_TOO_LOW: 'FARE_TOO_LOW',
    VEHICLE_INSUFFICIENT: 'VEHICLE_INSUFFICIENT',
  },
}));

jest.mock('../core/state-machines', () => ({
  BOOKING_VALID_TRANSITIONS: {},
  isValidTransition: jest.fn().mockReturnValue(true),
  assertValidTransition: jest.fn(),
  TERMINAL_BOOKING_STATUSES: ['cancelled', 'expired', 'fully_filled', 'completed'],
}));

jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../shared/services/audit.service', () => ({
  recordStatusChange: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../modules/pricing/vehicle-catalog', () => ({
  getSubtypeConfig: jest.fn().mockReturnValue({ capacityKg: 5000, minTonnage: 1, maxTonnage: 5 }),
}));

jest.mock('../shared/utils/safe-json.utils', () => ({
  safeJsonParse: (str: string, fallback: any) => {
    try { return JSON.parse(str); } catch { return fallback; }
  },
}));

// Dynamic require for driverService inside acceptTruckRequest
jest.mock('../modules/driver/driver.service', () => ({
  driverService: {
    isDriverOnline: jest.fn().mockResolvedValue(true),
    getDriverById: jest.fn(),
  },
}));

// =============================================================================
// IMPORTS — After all mocks
// =============================================================================

import { orderService } from '../modules/order/order.service';
import { logger } from '../shared/services/logger.service';

// =============================================================================
// TEST HELPERS
// =============================================================================

/** Future ISO timestamp (2 minutes from now) */
function futureIso(ms = 120_000): string {
  return new Date(Date.now() + ms).toISOString();
}

/** Past ISO timestamp (2 minutes ago) */
function pastIso(ms = 120_000): string {
  return new Date(Date.now() - ms).toISOString();
}

/** Build a minimal truck request record */
function makeTruckRequest(overrides: Record<string, any> = {}): any {
  return {
    id: 'treq-001',
    orderId: 'order-001',
    vehicleType: 'Open',
    vehicleSubtype: '17ft',
    pricePerTruck: 5000,
    status: 'searching',
    ...overrides,
  };
}

/** Build a minimal order record for the CAS tests */
function makeOrder(overrides: Record<string, any> = {}): any {
  return {
    id: 'order-001',
    customerId: 'customer-001',
    customerName: 'Test Customer',
    customerPhone: '9876543210',
    totalTrucks: 3,
    trucksFilled: 1,
    distanceKm: 100,
    status: 'active',
    pickup: JSON.stringify({ latitude: 19.0, longitude: 72.8, address: 'Mumbai', city: 'Mumbai', state: 'MH' }),
    drop: JSON.stringify({ latitude: 18.5, longitude: 73.8, address: 'Pune', city: 'Pune', state: 'MH' }),
    expiresAt: futureIso(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Build a vehicle record */
function makeVehicle(overrides: Record<string, any> = {}): any {
  return {
    id: 'vehicle-001',
    transporterId: 'transporter-001',
    vehicleNumber: 'MH12AB1234',
    vehicleType: 'Open',
    vehicleSubtype: '17ft',
    status: 'available',
    currentTripId: null,
    ...overrides,
  };
}

/** Build a transporter user record */
function makeTransporter(overrides: Record<string, any> = {}): any {
  return {
    id: 'transporter-001',
    name: 'Fleet Co',
    businessName: 'Fleet Co',
    phone: '0000000000',
    role: 'transporter',
    isActive: true,
    ...overrides,
  };
}

/** Build a driver user record */
function makeDriver(overrides: Record<string, any> = {}): any {
  return {
    id: 'driver-001',
    name: 'Driver One',
    phone: '1234567890',
    role: 'driver',
    transporterId: 'transporter-001',
    ...overrides,
  };
}

/**
 * Set up all standard mocks for a successful accept flow.
 * Override individual mocks after calling this to test specific scenarios.
 *
 * Uses mockResolvedValue (not Once) so mocks survive retry loops.
 * For sequential-only scenarios, callers can chain mockResolvedValueOnce after.
 */
function setupSuccessfulAcceptMocks(orderOverrides: Record<string, any> = {}): void {
  const truckRequest = makeTruckRequest();
  const order = makeOrder(orderOverrides);
  const transporter = makeTransporter();
  const vehicle = makeVehicle();
  const driver = makeDriver();

  // truckRequest.findUnique is called twice per attempt: initial read + re-fetch after update
  // Use mockImplementation to always return the right thing based on call sequence
  let truckRequestCallCount = 0;
  mockTruckRequestFindUnique.mockImplementation(() => {
    truckRequestCallCount++;
    // Odd calls = initial read, Even calls = re-fetch after update
    if (truckRequestCallCount % 2 === 0) {
      return Promise.resolve({ ...truckRequest, status: 'assigned', tripId: 'trip-generated-' + truckRequestCallCount });
    }
    return Promise.resolve(truckRequest);
  });

  mockOrderFindUnique.mockResolvedValue(order);

  // user.findUnique is called twice per attempt: transporter, then driver
  let userCallCount = 0;
  mockUserFindUnique.mockImplementation(() => {
    userCallCount++;
    // Odd calls = transporter, Even calls = driver
    if (userCallCount % 2 === 1) {
      return Promise.resolve(transporter);
    }
    return Promise.resolve(driver);
  });

  mockVehicleFindUnique.mockResolvedValue(vehicle);
  mockAssignmentFindFirst.mockResolvedValue(null); // no existing assignment for driver
  mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 }); // CAS on truck request succeeds
  mockAssignmentCreate.mockResolvedValue({});
  mockOrderUpdateMany.mockResolvedValue({ count: 1 }); // CAS on order succeeds
  mockOrderUpdate.mockResolvedValue({});
  mockSendPushNotification.mockResolvedValue(undefined);

  // Redis cancelTimer must return a thenable (code calls .catch() on the result)
  mockRedisCancelTimer.mockResolvedValue(undefined);
  mockRedisDel.mockResolvedValue(undefined);
  mockRedisGet.mockResolvedValue(null);
}

function resetAllMocks(): void {
  jest.clearAllMocks();
  mockTruckRequestFindUnique.mockReset();
  mockTruckRequestUpdateMany.mockReset();
  mockTruckRequestFindMany.mockReset();
  mockOrderFindUnique.mockReset();
  mockOrderUpdateMany.mockReset();
  mockOrderUpdate.mockReset();
  mockOrderFindFirst.mockReset();
  mockUserFindUnique.mockReset();
  mockVehicleFindUnique.mockReset();
  mockVehicleUpdateMany.mockReset();
  mockVehicleUpdate.mockReset();
  mockAssignmentCreate.mockReset();
  mockAssignmentFindFirst.mockReset();
  mockAssignmentFindMany.mockReset();
  mockAssignmentUpdateMany.mockReset();
  mockBookingCreate.mockReset();
  mockBookingFindFirst.mockReset();
  mockBookingFindUnique.mockReset();
  mockBookingUpdateMany.mockReset();
  mockBookingUpdate.mockReset();
  mockQueryRaw.mockReset();
  mockTransaction.mockReset();
  mockEmitToUser.mockReset();
  mockEmitToUsers.mockReset();
  mockSendPushNotification.mockReset();
  mockSendPushNotification.mockResolvedValue(undefined);
  mockRedisGet.mockReset();
  mockRedisSet.mockReset();
  mockRedisDel.mockReset();
}

// =============================================================================
// TEST SUITES
// =============================================================================

describe('CAS Guard in acceptTruckRequest — FIX #4 + FIX #39', () => {
  beforeEach(resetAllMocks);

  // =========================================================================
  // TEST 1: Accept on active order succeeds
  // =========================================================================
  describe('Accept on active order (status=active, searching request)', () => {
    it('succeeds and increments trucksFilled', async () => {
      setupSuccessfulAcceptMocks({ status: 'active' });

      const result = await orderService.acceptTruckRequest(
        'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
      );

      expect(result.success).toBe(true);
      expect(result.assignmentId).toBeDefined();
      expect(result.tripId).toBeDefined();

      // Verify CAS on order.updateMany was called with the correct WHERE clause
      expect(mockOrderUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'order-001',
            trucksFilled: 1,
            status: { notIn: ['cancelled', 'expired', 'fully_filled'] },
            expiresAt: { gt: expect.any(String) },
          }),
          data: {
            trucksFilled: { increment: 1 },
          },
        })
      );
    });

    // Fix B8: Status write now uses updateMany with CAS guard
    it('sets order status to partially_filled when not all trucks are filled', async () => {
      setupSuccessfulAcceptMocks({ status: 'active', trucksFilled: 1, totalTrucks: 3 });

      const result = await orderService.acceptTruckRequest(
        'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
      );

      expect(result.success).toBe(true);
      // After trucksFilled goes from 1 to 2 (out of 3), status = partially_filled
      expect(mockOrderUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'partially_filled',
          }),
        })
      );
    });

    // Fix B8: Status write now uses updateMany with CAS guard
    it('sets order status to fully_filled when last truck is filled', async () => {
      setupSuccessfulAcceptMocks({ status: 'active', trucksFilled: 2, totalTrucks: 3 });

      const result = await orderService.acceptTruckRequest(
        'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
      );

      expect(result.success).toBe(true);
      // After trucksFilled goes from 2 to 3 (totalTrucks=3), status = fully_filled
      expect(mockOrderUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'fully_filled',
          }),
        })
      );
    });
  });

  // =========================================================================
  // TEST 2: Accept on cancelled order fails
  // =========================================================================
  describe('Accept on cancelled order', () => {
    it('CAS returns count=0, retry discovers cancellation, returns failure', async () => {
      setupSuccessfulAcceptMocks({ status: 'cancelled' });
      // The CAS WHERE includes status: { notIn: ['cancelled', ...] }
      // so updateMany returns count=0, triggering RETRY
      mockOrderUpdateMany.mockResolvedValue({ count: 0 });

      // On retry, the order will be re-read and found as cancelled
      // The CAS will continue to return count=0 on subsequent attempts
      // After MAX_RETRIES(3), it throws
      await expect(
        orderService.acceptTruckRequest(
          'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
        )
      ).rejects.toThrow(/Order state changed concurrently/);

      // CAS was attempted (up to MAX_RETRIES times)
      expect(mockOrderUpdateMany).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // TEST 3: Accept on expired order fails
  // =========================================================================
  describe('Accept on expired order', () => {
    it('CAS returns count=0 for expired status, fails gracefully', async () => {
      setupSuccessfulAcceptMocks({ status: 'expired' });
      mockOrderUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        orderService.acceptTruckRequest(
          'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
        )
      ).rejects.toThrow(/Order state changed concurrently/);

      expect(mockOrderUpdateMany).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // TEST 4: Accept on fully_filled order fails
  // =========================================================================
  describe('Accept on fully_filled order', () => {
    it('CAS returns count=0 since fully_filled is in notIn list', async () => {
      setupSuccessfulAcceptMocks({ status: 'fully_filled', trucksFilled: 3, totalTrucks: 3 });
      mockOrderUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        orderService.acceptTruckRequest(
          'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
        )
      ).rejects.toThrow(/Order state changed concurrently/);

      expect(mockOrderUpdateMany).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // TEST 5: Accept on partially_filled order succeeds
  // =========================================================================
  describe('Accept on partially_filled order', () => {
    it('succeeds because partially_filled is NOT in the notIn list', async () => {
      setupSuccessfulAcceptMocks({ status: 'partially_filled', trucksFilled: 1, totalTrucks: 3 });

      const result = await orderService.acceptTruckRequest(
        'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
      );

      expect(result.success).toBe(true);
      expect(result.assignmentId).toBeDefined();

      // Verify the CAS WHERE clause does NOT exclude partially_filled
      expect(mockOrderUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { notIn: ['cancelled', 'expired', 'fully_filled'] },
          }),
        })
      );
    });
  });

  // =========================================================================
  // TEST 6: Accept when expiresAt is in the past
  // =========================================================================
  describe('Accept when expiresAt is in the past', () => {
    it('CAS returns count=0 due to expiresAt guard, fails', async () => {
      setupSuccessfulAcceptMocks({
        status: 'active',
        expiresAt: pastIso(), // 2 minutes ago
      });
      // The expiresAt: { gt: new Date().toISOString() } clause will exclude this
      mockOrderUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        orderService.acceptTruckRequest(
          'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
        )
      ).rejects.toThrow(/Order state changed concurrently/);

      expect(mockOrderUpdateMany).toHaveBeenCalled();
    });

    it('CAS where clause includes expiresAt guard', async () => {
      setupSuccessfulAcceptMocks({ status: 'active', expiresAt: pastIso() });
      mockOrderUpdateMany.mockResolvedValue({ count: 0 });

      try {
        await orderService.acceptTruckRequest(
          'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
        );
      } catch {
        // expected
      }

      // Verify the expiresAt guard is present in the CAS WHERE clause
      const casCall = mockOrderUpdateMany.mock.calls[0]?.[0];
      expect(casCall).toBeDefined();
      expect(casCall.where.expiresAt).toEqual({ gt: expect.any(String) });
    });
  });

  // =========================================================================
  // TEST 7: Accept when expiresAt is far in the future
  // =========================================================================
  describe('Accept when expiresAt is far in the future', () => {
    it('succeeds because expiresAt guard passes', async () => {
      setupSuccessfulAcceptMocks({
        status: 'active',
        expiresAt: futureIso(600_000), // 10 minutes from now
      });

      const result = await orderService.acceptTruckRequest(
        'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
      );

      expect(result.success).toBe(true);
      expect(mockOrderUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            expiresAt: { gt: expect.any(String) },
          }),
        })
      );
    });
  });

  // =========================================================================
  // TEST 8: Concurrent cancel + accept race
  // =========================================================================
  describe('Concurrent cancel + accept race', () => {
    it('accept fails when order is concurrently cancelled (CAS prevents ghost assignment)', async () => {
      // Simulate: order is active when read, but cancelled by the time CAS runs
      setupSuccessfulAcceptMocks({ status: 'active' });

      // The CAS returns count=0 (order was cancelled concurrently)
      mockOrderUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        orderService.acceptTruckRequest(
          'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
        )
      ).rejects.toThrow(/Order state changed concurrently/);

      // Assignment was created inside TX, but CAS failure causes TX rollback
      // (the thrown error rolls back the withDbTimeout transaction)
    });

    it('CAS atomically rejects accept if trucksFilled changed concurrently', async () => {
      setupSuccessfulAcceptMocks({ status: 'active', trucksFilled: 1, totalTrucks: 3 });

      // Simulate another transporter accepted at the same time, changing trucksFilled from 1 to 2
      // Our CAS expects trucksFilled=1 but DB has trucksFilled=2 now => count=0
      mockOrderUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        orderService.acceptTruckRequest(
          'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
        )
      ).rejects.toThrow(/Order state changed concurrently/);

      // Verify CAS used the original trucksFilled value in WHERE
      expect(mockOrderUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            trucksFilled: 1,
          }),
        })
      );
    });
  });

  // =========================================================================
  // TEST 9: Double-tap accept (same transporter)
  // =========================================================================
  describe('Double-tap accept (same transporter submits twice)', () => {
    it('second attempt fails at truck request CAS (already assigned)', async () => {
      // First accept: truck request is 'searching'
      setupSuccessfulAcceptMocks({ status: 'active' });

      const result1 = await orderService.acceptTruckRequest(
        'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
      );
      expect(result1.success).toBe(true);

      // Second accept: truck request is now 'assigned', not 'searching'
      resetAllMocks();
      const truckRequest = makeTruckRequest({ status: 'assigned' });
      mockTruckRequestFindUnique.mockResolvedValue(truckRequest);
      mockOrderFindUnique.mockResolvedValue(makeOrder({ status: 'partially_filled' }));
      mockUserFindUnique.mockResolvedValue(makeTransporter());
      mockVehicleFindUnique.mockResolvedValue(makeVehicle());

      const result2 = await orderService.acceptTruckRequest(
        'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
      );

      // Should get an EARLY_RETURN indicating request is no longer searching
      expect(result2.success).toBe(false);
      expect(result2.message).toMatch(/already assigned/i);
    });
  });

  // =========================================================================
  // TEST 10: Assignment creation guard — downstream check
  // =========================================================================
  describe('Accept after CAS succeeds but driver already has active assignment', () => {
    it('blocks at driver-busy guard before reaching order CAS', async () => {
      setupSuccessfulAcceptMocks({ status: 'active' });

      // Driver already has an active assignment
      mockAssignmentFindFirst.mockResolvedValue({
        id: 'existing-assign-001',
        tripId: 'existing-trip-001',
        orderId: 'other-order-001',
        status: 'in_transit',
      });

      const result = await orderService.acceptTruckRequest(
        'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/already assigned/i);

      // Order CAS should NOT have been called — blocked earlier
      expect(mockOrderUpdateMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // CAS WHERE clause structural verification
  // =========================================================================
  describe('CAS WHERE clause structural verification', () => {
    it('includes all three guards: trucksFilled, status notIn, expiresAt gt', async () => {
      setupSuccessfulAcceptMocks({ status: 'active', trucksFilled: 0, totalTrucks: 3 });

      await orderService.acceptTruckRequest(
        'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
      );

      const casCall = mockOrderUpdateMany.mock.calls[0]?.[0];
      expect(casCall).toBeDefined();

      // Guard 1: trucksFilled equality check (optimistic lock)
      expect(casCall.where.trucksFilled).toBe(0);

      // Guard 2: status not in terminal states (FIX #4)
      expect(casCall.where.status).toEqual({
        notIn: ['cancelled', 'expired', 'fully_filled'],
      });

      // Guard 3: expiresAt must be in the future (FIX #39)
      expect(casCall.where.expiresAt).toEqual({
        gt: expect.any(String),
      });

      // Guard 3 continued: the gt value must be a valid ISO date string
      const expiresAtValue = casCall.where.expiresAt.gt;
      const parsed = new Date(expiresAtValue);
      expect(parsed.getTime()).not.toBeNaN();
    });

    it('expiresAt guard value is close to current time (not stale)', async () => {
      const beforeCall = new Date().toISOString();

      setupSuccessfulAcceptMocks({ status: 'active' });
      await orderService.acceptTruckRequest(
        'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
      );

      const afterCall = new Date().toISOString();
      const casCall = mockOrderUpdateMany.mock.calls[0]?.[0];
      const expiresAtGt = casCall.where.expiresAt.gt;

      // The generated ISO timestamp should be between beforeCall and afterCall
      expect(expiresAtGt >= beforeCall).toBe(true);
      expect(expiresAtGt <= afterCall).toBe(true);
    });
  });

  // =========================================================================
  // Edge case: vehicle busy guard
  // =========================================================================
  describe('Vehicle status guard (pre-CAS validation)', () => {
    it('rejects accept if vehicle is not available', async () => {
      setupSuccessfulAcceptMocks({ status: 'active' });
      mockVehicleFindUnique.mockResolvedValue(makeVehicle({ status: 'in_transit' }));

      const result = await orderService.acceptTruckRequest(
        'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/currently in_transit/i);
      expect(mockOrderUpdateMany).not.toHaveBeenCalled();
    });

    it('rejects accept if vehicle has a currentTripId', async () => {
      setupSuccessfulAcceptMocks({ status: 'active' });
      mockVehicleFindUnique.mockResolvedValue(
        makeVehicle({ status: 'available', currentTripId: 'some-trip-999' })
      );

      const result = await orderService.acceptTruckRequest(
        'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/already on trip/i);
      expect(mockOrderUpdateMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Edge case: vehicle type mismatch guard
  // =========================================================================
  describe('Vehicle type mismatch guard (pre-CAS validation)', () => {
    it('rejects accept if vehicleType does not match request', async () => {
      setupSuccessfulAcceptMocks({ status: 'active' });
      mockVehicleFindUnique.mockResolvedValue(makeVehicle({ vehicleType: 'Tipper' }));

      const result = await orderService.acceptTruckRequest(
        'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Vehicle type mismatch/i);
      expect(mockOrderUpdateMany).not.toHaveBeenCalled();
    });

    it('rejects accept if vehicleSubtype does not match request', async () => {
      setupSuccessfulAcceptMocks({ status: 'active' });
      mockVehicleFindUnique.mockResolvedValue(makeVehicle({ vehicleSubtype: '20ft' }));

      const result = await orderService.acceptTruckRequest(
        'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Vehicle subtype mismatch/i);
      expect(mockOrderUpdateMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Retry behavior verification
  // =========================================================================
  describe('Retry behavior on CAS failure', () => {
    it('retries up to MAX_RETRIES (3) on RETRY errors', async () => {
      setupSuccessfulAcceptMocks({ status: 'active' });
      // CAS fails every time
      mockOrderUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        orderService.acceptTruckRequest(
          'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
        )
      ).rejects.toThrow(/Order state changed/);

      // withDbTimeout is called via the mocked implementation,
      // and the order.updateMany was called 3 times (once per retry)
      expect(mockOrderUpdateMany).toHaveBeenCalledTimes(3);
    });
  });

  // =========================================================================
  // Notification verification (on success path)
  // =========================================================================
  describe('Post-accept notifications', () => {
    it('emits trip_assigned socket event to driver on success', async () => {
      setupSuccessfulAcceptMocks({ status: 'active' });

      await orderService.acceptTruckRequest(
        'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
      );

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'driver-001',
        'trip_assigned',
        expect.objectContaining({
          type: 'trip_assigned',
          orderId: 'order-001',
          truckRequestId: 'treq-001',
        })
      );
    });

    it('sends push notification to driver on success', async () => {
      setupSuccessfulAcceptMocks({ status: 'active' });

      await orderService.acceptTruckRequest(
        'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
      );

      expect(mockSendPushNotification).toHaveBeenCalledWith(
        'driver-001',
        expect.objectContaining({
          title: 'New Trip Assigned!',
          data: expect.objectContaining({
            type: 'trip_assigned',
            orderId: 'order-001',
          }),
        })
      );
    });

    it('does NOT send notifications when CAS fails', async () => {
      setupSuccessfulAcceptMocks({ status: 'cancelled' });
      mockOrderUpdateMany.mockResolvedValue({ count: 0 });

      try {
        await orderService.acceptTruckRequest(
          'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
        );
      } catch {
        // expected
      }

      // No socket events or push notifications should be sent
      expect(mockEmitToUser).not.toHaveBeenCalled();
      expect(mockSendPushNotification).not.toHaveBeenCalled();
    });
  });
});
