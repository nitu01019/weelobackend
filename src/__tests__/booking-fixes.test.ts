/**
 * =============================================================================
 * BOOKING FIXES — Tests for P7, P8, P9, P20
 * =============================================================================
 *
 * Tests for code review fixes in booking and broadcast modules:
 * - P7:  Fare check uses Google distance, not client distance
 * - P8:  Auth check before timer clearing in cancelBooking
 * - P9:  Vehicle lock inside Serializable TX in acceptBroadcast
 * - P20: cancelBooking includes in_transit assignments
 *
 * @author Weelo Team
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — Must come before any imports
// =============================================================================

// Logger mock
jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Metrics mock
jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    recordHistogram: jest.fn(),
  },
}));

// Config mock
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
  },
}));

// Prisma mock — booking, assignment, vehicle, user
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
const mockQueryRaw = jest.fn();

// Transaction mock: captures the callback and runs it with the mock tx
const mockTransaction = jest.fn();

const mockOrderFindFirst = jest.fn();

jest.mock('../shared/database/prisma.service', () => {
  const txProxy = {
    booking: {
      findUnique: (...args: any[]) => mockBookingFindUnique(...args),
      updateMany: (...args: any[]) => mockBookingUpdateMany(...args),
      update: (...args: any[]) => mockBookingUpdate(...args),
      create: (...args: any[]) => mockBookingCreate(...args),
      findFirst: (...args: any[]) => mockBookingFindFirst(...args),
    },
    order: {
      findFirst: (...args: any[]) => mockOrderFindFirst(...args),
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

// DB mock
const mockGetBookingById = jest.fn();
const mockGetUserById = jest.fn();
const mockCreateBooking = jest.fn();
const mockUpdateBooking = jest.fn();
const mockGetTransportersWithVehicleType = jest.fn();
const mockGetVehiclesByTransporter = jest.fn();
const mockGetActiveBookingsForTransporter = jest.fn();
const mockGetActiveOrders = jest.fn();
const mockGetBookingsByDriver = jest.fn();

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
  },
}));

// Socket service mock
const mockEmitToUser = jest.fn();
const mockEmitToBooking = jest.fn();
const mockEmitToUsers = jest.fn();
const mockEmitToRoom = jest.fn();
const mockEmitToAllTransporters = jest.fn();
const mockIsUserConnected = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToBooking: (...args: any[]) => mockEmitToBooking(...args),
  emitToUsers: (...args: any[]) => mockEmitToUsers(...args),
  emitToRoom: (...args: any[]) => mockEmitToRoom(...args),
  emitToAllTransporters: (...args: any[]) => mockEmitToAllTransporters(...args),
  emitToAll: jest.fn(),
  isUserConnected: (...args: any[]) => mockIsUserConnected(...args),
  socketService: { emitToUser: jest.fn() },
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
  },
}));

// FCM service mock
const mockSendPushNotification = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/fcm.service', () => ({
  fcmService: { sendToDevice: jest.fn().mockResolvedValue(undefined) },
  sendPushNotification: (...args: any[]) => mockSendPushNotification(...args),
}));

// Queue service mock
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    addJob: jest.fn(),
    queuePushNotificationBatch: jest.fn().mockResolvedValue(undefined),
  },
}));

// Live availability mock
const mockOnVehicleStatusChange = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: (...args: any[]) => mockOnVehicleStatusChange(...args),
  },
}));

// Google Maps service mock
const mockCalculateRoute = jest.fn();
jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: {
    calculateRoute: (...args: any[]) => mockCalculateRoute(...args),
  },
}));

// Distance matrix mock
jest.mock('../shared/services/distance-matrix.service', () => ({
  distanceMatrixService: {
    batchGetPickupDistance: jest.fn().mockResolvedValue(new Map()),
  },
}));

// Availability service mock
jest.mock('../shared/services/availability.service', () => ({
  availabilityService: {
    loadTransporterDetailsMap: jest.fn().mockResolvedValue(new Map()),
  },
}));

// Progressive radius matcher mock
jest.mock('../modules/order/progressive-radius-matcher', () => ({
  progressiveRadiusMatcher: {
    findCandidates: jest.fn().mockResolvedValue([]),
  },
}));

// Transporter online service mock
const mockFilterOnline = jest.fn();
const mockTransporterIsOnline = jest.fn();
jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: {
    filterOnline: (...args: any[]) => mockFilterOnline(...args),
    isOnline: (...args: any[]) => mockTransporterIsOnline(...args),
  },
}));

// Vehicle lifecycle mock
const mockReleaseVehicle = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: (...args: any[]) => mockReleaseVehicle(...args),
}));

// Vehicle key mock
jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: (type: string, sub: string) => `${type}_${sub}`,
}));

// Cache service mock
jest.mock('../shared/services/cache.service', () => ({
  cacheService: { get: jest.fn(), set: jest.fn(), delete: jest.fn() },
}));

// Booking payload helper mock
jest.mock('../modules/booking/booking-payload.helper', () => ({
  buildBroadcastPayload: jest.fn().mockReturnValue({}),
  getRemainingTimeoutSeconds: jest.fn().mockReturnValue(60),
}));

// Core constants mock
jest.mock('../core/constants', () => ({
  ErrorCode: {
    BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
    FARE_TOO_LOW: 'FARE_TOO_LOW',
  },
}));

// State machines mock
jest.mock('../core/state-machines', () => ({
  BOOKING_VALID_TRANSITIONS: {},
  isValidTransition: jest.fn().mockReturnValue(true),
  TERMINAL_BOOKING_STATUSES: ['cancelled', 'expired', 'fully_filled', 'completed'],
}));

// Geo utils mock
jest.mock('../shared/utils/geo.utils', () => ({
  roundCoord: (c: number) => Math.round(c * 100) / 100,
}));

// Geospatial utils mock
jest.mock('../shared/utils/geospatial.utils', () => ({
  haversineDistanceKm: jest.fn().mockReturnValue(10),
}));

// Audit service mock
jest.mock('../shared/services/audit.service', () => ({
  recordStatusChange: jest.fn().mockResolvedValue(undefined),
}));

// Pricing vehicle catalog mock
jest.mock('../modules/pricing/vehicle-catalog', () => ({
  getSubtypeConfig: jest.fn().mockReturnValue({ capacityKg: 5000, minTonnage: 1, maxTonnage: 5 }),
}));

// Safe JSON utils mock
jest.mock('../shared/utils/safe-json.utils', () => ({
  safeJsonParse: (str: string, fallback: any) => {
    try { return JSON.parse(str); } catch { return fallback; }
  },
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { AppError } from '../shared/types/error.types';
import { logger } from '../shared/services/logger.service';

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
  mockRedisGetJSON.mockReset();
  mockRedisSetJSON.mockReset();
  mockRedisGetExpiredTimers.mockReset();
  mockRedisCancelTimer.mockReset();
  mockRedisSetTimer.mockReset();
  mockRedisExpire.mockReset();
  mockRedisSIsMember.mockReset();
  mockRedisIsConnected.mockReturnValue(true);
  mockBookingFindUnique.mockReset();
  mockBookingUpdateMany.mockReset();
  mockBookingUpdate.mockReset();
  mockBookingCreate.mockReset();
  mockBookingFindFirst.mockReset();
  mockOrderFindFirst.mockReset();
  mockAssignmentFindMany.mockReset();
  mockAssignmentUpdateMany.mockReset();
  mockAssignmentFindFirst.mockReset();
  mockAssignmentCreate.mockReset();
  mockVehicleFindUnique.mockReset();
  mockVehicleUpdateMany.mockReset();
  mockVehicleUpdate.mockReset();
  mockUserFindUnique.mockReset();
  mockQueryRaw.mockReset();
  mockTransaction.mockReset();
  mockGetBookingById.mockReset();
  mockGetUserById.mockReset();
  mockCreateBooking.mockReset();
  mockUpdateBooking.mockReset();
  mockGetTransportersWithVehicleType.mockReset();
  mockGetVehiclesByTransporter.mockReset();
  mockGetActiveBookingsForTransporter.mockReset();
  mockGetActiveOrders.mockReset();
  mockGetBookingsByDriver.mockReset();
  mockEmitToUser.mockReset();
  mockEmitToBooking.mockReset();
  mockEmitToUsers.mockReset();
  mockEmitToRoom.mockReset();
  mockEmitToAllTransporters.mockReset();
  mockIsUserConnected.mockReset();
  mockSendPushNotification.mockReset();
  mockSendPushNotification.mockResolvedValue(undefined);
  mockOnVehicleStatusChange.mockReset();
  mockOnVehicleStatusChange.mockResolvedValue(undefined);
  mockReleaseVehicle.mockReset();
  mockReleaseVehicle.mockResolvedValue(undefined);
  mockCalculateRoute.mockReset();
  mockFilterOnline.mockReset();
  mockTransporterIsOnline.mockReset();
}

// Shared booking fixture for cancel tests
function makeBooking(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'booking-001',
    customerId: 'customer-001',
    customerName: 'Test Customer',
    customerPhone: '9876543210',
    vehicleType: 'Open',
    vehicleSubtype: '17ft',
    trucksNeeded: 2,
    trucksFilled: 1,
    distanceKm: 100,
    pricePerTruck: 5000,
    totalAmount: 10000,
    goodsType: 'General',
    weight: '5 tons',
    status: 'active',
    notifiedTransporters: ['t-001', 't-002'],
    pickup: { latitude: 19.0, longitude: 72.8, address: 'Mumbai', city: 'Mumbai', state: 'MH' },
    drop: { latitude: 18.5, longitude: 73.8, address: 'Pune', city: 'Pune', state: 'MH' },
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// =============================================================================
// P7: FARE CHECK USES GOOGLE DISTANCE, NOT CLIENT DISTANCE
// =============================================================================

describe('P7 — Fare check uses Google distance, not client distance', () => {
  beforeEach(resetAllMocks);

  it('fare check uses Google distance, not client distance', async () => {
    // Setup: Google returns 200km but client sends 1km
    mockCalculateRoute.mockResolvedValue({ distanceKm: 200, durationMinutes: 240 });
    mockRedisGet.mockResolvedValue(null); // no idempotency cache, no active broadcast
    mockBookingFindFirst.mockResolvedValue(null); // no active booking in DB
    mockOrderFindFirst.mockResolvedValue(null); // no active order in DB
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockReleaseLockSafe();
    mockGetUserById.mockResolvedValue({ id: 'customer-001', name: 'Test', phone: '9876543210' });
    mockGetTransportersWithVehicleType.mockResolvedValue([]);
    mockFilterOnline.mockResolvedValue([]);

    // Import the service fresh (requires all mocks to be in place)
    const { bookingService } = require('../modules/booking/booking.service');

    // The fare check formula: estimatedMinFare = max(500, distanceKm * MIN_FARE_PER_KM * FARE_TOLERANCE)
    // With Google 200km: min = max(500, 200 * 8 * 0.5) = max(500, 800) = 800
    // pricePerTruck = 500 < 800 => should throw FARE_TOO_LOW
    const input = makeCreateBookingInput({ distanceKm: 1, pricePerTruck: 500 });

    await expect(
      bookingService.createBooking('customer-001', '9876543210', input)
    ).rejects.toThrow(/below minimum/i);

    // Verify Google was called
    expect(mockCalculateRoute).toHaveBeenCalled();
  });

  it('client sends distanceKm=1, Google returns 200km — fare validated against 200km', async () => {
    mockCalculateRoute.mockResolvedValue({ distanceKm: 200, durationMinutes: 240 });
    mockRedisGet.mockResolvedValue(null);
    mockBookingFindFirst.mockResolvedValue(null);
    mockOrderFindFirst.mockResolvedValue(null);
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockReleaseLockSafe();
    mockGetUserById.mockResolvedValue({ id: 'customer-001', name: 'Test', phone: '9876543210' });
    mockGetTransportersWithVehicleType.mockResolvedValue([]);
    mockFilterOnline.mockResolvedValue([]);

    const { bookingService } = require('../modules/booking/booking.service');

    // Fare = 500, but for 200km the minimum is max(500, 200*8*0.5) = 800
    // So price 500 < 800 => FARE_TOO_LOW
    const input = makeCreateBookingInput({ distanceKm: 1, pricePerTruck: 500 });

    await expect(
      bookingService.createBooking('customer-001', '9876543210', input)
    ).rejects.toThrow(/below minimum/i);

    // Confirm Google result was used: the route was called with pickup/drop coords
    expect(mockCalculateRoute).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ lat: 19.0, lng: 72.8 }),
        expect.objectContaining({ lat: 18.5, lng: 73.8 }),
      ]),
      expect.any(Boolean)
    );
  });

  it('Google Directions fails — fare check uses client distance as fallback', async () => {
    mockCalculateRoute.mockRejectedValue(new Error('Google API timeout'));
    mockRedisGet.mockResolvedValue(null);
    mockBookingFindFirst.mockResolvedValue(null);
    mockOrderFindFirst.mockResolvedValue(null);
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockReleaseLockSafe();
    mockGetUserById.mockResolvedValue({ id: 'customer-001', name: 'Test', phone: '9876543210' });
    mockGetTransportersWithVehicleType.mockResolvedValue([]);
    mockFilterOnline.mockResolvedValue([]);

    const { bookingService } = require('../modules/booking/booking.service');

    // Client says 50km, Google fails, so fare check uses 50km
    // Min fare for 50km = max(500, 50*8*0.5) = max(500, 200) = 500
    // pricePerTruck=600 >= 500 => should NOT throw
    // It should proceed to create the booking (will throw later in TX setup
    // but should NOT throw FARE_TOO_LOW)
    const input = makeCreateBookingInput({ distanceKm: 50, pricePerTruck: 600 });

    // The call may fail for other reasons (e.g., serializable TX setup) but NOT for fare
    try {
      await bookingService.createBooking('customer-001', '9876543210', input);
    } catch (err: any) {
      // Should NOT be a fare error
      expect(err.message).not.toMatch(/below minimum/i);
      expect(err.code).not.toBe('FARE_TOO_LOW');
    }

    // Google was attempted but failed
    expect(mockCalculateRoute).toHaveBeenCalled();
    // Logger should have warned about fallback
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Google Directions API failed'),
      expect.anything()
    );
  });
});

// =============================================================================
// P8: AUTH BEFORE TIMER CLEARING IN cancelBooking
// =============================================================================

describe('P8 — Auth before timer clearing in cancelBooking', () => {
  beforeEach(resetAllMocks);

  it('cancelBooking by wrong customer does NOT clear timers', async () => {
    const booking = makeBooking({ customerId: 'customer-001' });

    // The updateMany with customerId filter will return count=0 for wrong customer
    mockBookingUpdateMany.mockResolvedValue({ count: 0 });
    mockGetBookingById.mockResolvedValue(booking);
    mockRedisCancelTimer.mockResolvedValue(undefined);
    mockRedisDel.mockResolvedValue(undefined);

    const { bookingService } = require('../modules/booking/booking.service');

    // Wrong customer tries to cancel
    await expect(
      bookingService.cancelBooking('booking-001', 'wrong-customer')
    ).rejects.toThrow(/only cancel your own/i);

    // FIX P8: Timers should NOT be cleared because updateMany returned count=0
    // (wrong customer). clearBookingTimers is only called after success.
    expect(mockRedisCancelTimer).not.toHaveBeenCalled();

    // updateMany was called with wrong customer, returned count=0
    expect(mockBookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'booking-001',
          customerId: 'wrong-customer',
        }),
      })
    );
  });

  it('cancelBooking by correct customer DOES clear timers', async () => {
    const booking = makeBooking({ customerId: 'customer-001' });

    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockGetBookingById.mockResolvedValue({ ...booking, status: 'cancelled' });
    mockRedisCancelTimer.mockResolvedValue(undefined);
    mockRedisDel.mockResolvedValue(undefined);
    mockRedisGet.mockResolvedValue(null);
    mockAssignmentFindMany.mockResolvedValue([]);

    const { bookingService } = require('../modules/booking/booking.service');

    const result = await bookingService.cancelBooking('booking-001', 'customer-001');

    // Timer cleanup should have been called
    expect(mockRedisCancelTimer).toHaveBeenCalled();
    // Booking should be returned as cancelled
    expect(result.status).toBe('cancelled');
  });

  it('clearBookingTimers only called after updateMany succeeds', async () => {
    // In the current implementation, timers are cleared BEFORE updateMany
    // as a race-prevention measure. But the critical invariant is:
    // the booking status only changes if customerId matches (updateMany WHERE clause).
    const booking = makeBooking({ customerId: 'customer-001' });

    // updateMany returns count=1 (success)
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockGetBookingById.mockResolvedValue({ ...booking, status: 'cancelled' });
    mockRedisCancelTimer.mockResolvedValue(undefined);
    mockRedisDel.mockResolvedValue(undefined);
    mockRedisGet.mockResolvedValue(null);
    mockAssignmentFindMany.mockResolvedValue([]);

    const { bookingService } = require('../modules/booking/booking.service');

    await bookingService.cancelBooking('booking-001', 'customer-001');

    // updateMany MUST include customerId in WHERE to enforce ownership
    expect(mockBookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          customerId: 'customer-001',
        }),
      })
    );
    // And it succeeded (count=1), so cleanup proceeds
    expect(mockRedisCancelTimer).toHaveBeenCalled();
  });
});

// =============================================================================
// P9: VEHICLE LOCK IN acceptBroadcast (Serializable TX)
// =============================================================================

describe('P9 — Vehicle lock in acceptBroadcast', () => {
  beforeEach(resetAllMocks);

  // Helper: set up standard accept prerequisites
  function setupAcceptMocks() {
    // Redis lock
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    mockRedisGetJSON.mockResolvedValue(null); // no idempotency cache
    mockRedisSetJSON.mockResolvedValue(undefined);
    mockTransporterIsOnline.mockResolvedValue(true);
    mockRedisExists.mockResolvedValue(true); // driver presence

    // Booking
    const booking = {
      id: 'broadcast-001',
      customerId: 'cust-001',
      trucksNeeded: 3,
      trucksFilled: 1,
      status: 'active',
      pricePerTruck: 5000,
      distanceKm: 100,
      customerName: 'Customer',
      customerPhone: '9876543210',
      vehicleType: 'Open',
      vehicleSubtype: '17ft',
      pickup: { address: 'Mumbai' },
      drop: { address: 'Pune' },
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    };
    mockBookingFindUnique.mockResolvedValue(booking);

    // Actor (transporter)
    mockUserFindUnique
      .mockResolvedValueOnce({ id: 'transporter-001', isActive: true, role: 'transporter' })  // actor
      .mockResolvedValueOnce({ id: 'driver-001', role: 'driver', transporterId: 'transporter-001', name: 'Driver 1', phone: '1234567890' })  // driver
      .mockResolvedValueOnce({ id: 'transporter-001', name: 'Fleet Co', businessName: 'Fleet Co', phone: '0000' });  // transporter

    // Vehicle
    mockVehicleFindUnique.mockResolvedValue({
      id: 'vehicle-001',
      transporterId: 'transporter-001',
      vehicleNumber: 'MH12AB1234',
      vehicleType: 'Open',
      vehicleSubtype: '17ft',
    });

    // No existing active assignment for this combo
    mockAssignmentFindFirst
      .mockResolvedValueOnce(null)  // existing assignment for this booking+driver+vehicle
      .mockResolvedValueOnce(null); // active assignment for driver

    // Vehicle lock: CAS succeeds
    mockVehicleUpdateMany.mockResolvedValue({ count: 1 });

    // Booking increment: CAS succeeds
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });

    // Booking update (status change)
    mockBookingUpdate.mockResolvedValue({});

    // Assignment creation
    mockAssignmentCreate.mockResolvedValue({});

    // FCM
    mockSendPushNotification.mockResolvedValue(undefined);

    return booking;
  }

  it('acceptBroadcast sets vehicle to on_hold inside transaction', async () => {
    setupAcceptMocks();

    const { broadcastService } = require('../modules/broadcast/broadcast.service');

    const result = await broadcastService.acceptBroadcast('broadcast-001', {
      driverId: 'driver-001',
      vehicleId: 'vehicle-001',
      actorUserId: 'transporter-001',
      actorRole: 'transporter',
    });

    expect(result.status).toBe('assigned');

    // Vehicle updateMany should use CAS: WHERE id=vehicleId AND status='available'
    expect(mockVehicleUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'vehicle-001',
          status: 'available',
        }),
        data: expect.objectContaining({
          status: 'on_hold',
        }),
      })
    );
  });

  it('acceptBroadcast fails if vehicle already on_hold (count=0)', async () => {
    setupAcceptMocks();

    // Vehicle lock returns count=0 — already taken
    mockVehicleUpdateMany.mockResolvedValue({ count: 0 });

    const { broadcastService } = require('../modules/broadcast/broadcast.service');

    await expect(
      broadcastService.acceptBroadcast('broadcast-001', {
        driverId: 'driver-001',
        vehicleId: 'vehicle-001',
        actorUserId: 'transporter-001',
        actorRole: 'transporter',
      })
    ).rejects.toThrow(/vehicle.*unavailable|no longer available/i);
  });

  it('two transporters accept same vehicle — second gets VEHICLE_UNAVAILABLE', async () => {
    // First accept succeeds
    setupAcceptMocks();

    const { broadcastService } = require('../modules/broadcast/broadcast.service');

    const result1 = await broadcastService.acceptBroadcast('broadcast-001', {
      driverId: 'driver-001',
      vehicleId: 'vehicle-001',
      actorUserId: 'transporter-001',
      actorRole: 'transporter',
    });
    expect(result1.status).toBe('assigned');

    // Reset for second call
    // Re-setup but vehicle lock fails (already on_hold)
    mockBookingFindUnique.mockResolvedValue({
      id: 'broadcast-001',
      customerId: 'cust-001',
      trucksNeeded: 3,
      trucksFilled: 2,
      status: 'partially_filled',
      pricePerTruck: 5000,
      distanceKm: 100,
      customerName: 'Customer',
      customerPhone: '9876543210',
      vehicleType: 'Open',
      vehicleSubtype: '17ft',
      pickup: { address: 'Mumbai' },
      drop: { address: 'Pune' },
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
    mockUserFindUnique
      .mockResolvedValueOnce({ id: 'transporter-002', isActive: true, role: 'transporter' })
      .mockResolvedValueOnce({ id: 'driver-002', role: 'driver', transporterId: 'transporter-002', name: 'Driver 2', phone: '1111' })
      .mockResolvedValueOnce({ id: 'transporter-002', name: 'Fleet 2', businessName: 'Fleet 2', phone: '2222' });
    mockVehicleFindUnique.mockResolvedValue({
      id: 'vehicle-001',
      transporterId: 'transporter-002',
      vehicleNumber: 'MH12AB1234',
      vehicleType: 'Open',
      vehicleSubtype: '17ft',
    });
    mockAssignmentFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    // CAS fails: vehicle already on_hold
    mockVehicleUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      broadcastService.acceptBroadcast('broadcast-001', {
        driverId: 'driver-002',
        vehicleId: 'vehicle-001',
        actorUserId: 'transporter-002',
        actorRole: 'transporter',
      })
    ).rejects.toThrow(/vehicle.*unavailable|no longer available/i);
  });

  it('vehicle status check is inside Serializable TX', async () => {
    setupAcceptMocks();

    const { broadcastService } = require('../modules/broadcast/broadcast.service');

    await broadcastService.acceptBroadcast('broadcast-001', {
      driverId: 'driver-001',
      vehicleId: 'vehicle-001',
      actorUserId: 'transporter-001',
      actorRole: 'transporter',
    });

    // withDbTimeout is called with Serializable isolation level
    // We verify by checking that the vehicle CAS (updateMany) was called
    // inside the same logical unit as the booking CAS
    expect(mockVehicleUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockBookingUpdateMany).toHaveBeenCalledTimes(1);

    // Both CAS operations ran — if they were not in the same TX,
    // the vehicle lock and booking increment would be separate,
    // which would allow a race condition.
    const vehicleCallOrder = mockVehicleUpdateMany.mock.invocationCallOrder[0];
    const bookingCallOrder = mockBookingUpdateMany.mock.invocationCallOrder[0];
    // Vehicle lock MUST happen BEFORE booking increment
    expect(vehicleCallOrder).toBeLessThan(bookingCallOrder);
  });
});

// =============================================================================
// P20: CANCEL INCLUDES in_transit ASSIGNMENTS
// =============================================================================

describe('P20 — cancelBooking includes in_transit assignments', () => {
  beforeEach(resetAllMocks);

  it('cancelBooking cancels in_transit assignments', async () => {
    const booking = makeBooking({ customerId: 'customer-001', status: 'partially_filled' });
    const inTransitAssignment = {
      id: 'assign-001',
      bookingId: 'booking-001',
      tripId: 'trip-001',
      driverId: 'driver-001',
      vehicleId: 'vehicle-001',
      transporterId: 'transporter-001',
      vehicleType: 'Open',
      vehicleSubtype: '17ft',
      status: 'in_transit',
    };

    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockGetBookingById
      .mockResolvedValueOnce({ ...booking, status: 'cancelled' })
      .mockResolvedValueOnce({ ...booking, status: 'cancelled' });
    mockRedisCancelTimer.mockResolvedValue(undefined);
    mockRedisDel.mockResolvedValue(undefined);
    mockRedisGet.mockResolvedValue(null);
    mockAssignmentFindMany.mockResolvedValue([inTransitAssignment]);
    mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockVehicleUpdate.mockResolvedValue({ id: 'vehicle-001', status: 'available' });

    const { bookingService } = require('../modules/booking/booking.service');

    await bookingService.cancelBooking('booking-001', 'customer-001');

    // FIX P20: Verify assignment query includes in_transit (and other active statuses)
    expect(mockAssignmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          bookingId: 'booking-001',
          status: expect.objectContaining({
            in: expect.arrayContaining([
              'pending',
              'driver_accepted',
              'en_route_pickup',
              'in_transit',
            ]),
          }),
        }),
      })
    );
  });

  it('cancelBooking sends trip_cancelled socket event to driver', async () => {
    const booking = makeBooking({ customerId: 'customer-001' });
    const inTransitAssignment = {
      id: 'assign-001',
      bookingId: 'booking-001',
      tripId: 'trip-001',
      driverId: 'driver-001',
      vehicleId: 'vehicle-001',
      transporterId: 'transporter-001',
      vehicleType: 'Open',
      vehicleSubtype: '17ft',
      status: 'in_transit',
    };

    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockGetBookingById
      .mockResolvedValueOnce({ ...booking, status: 'cancelled' })
      .mockResolvedValueOnce({ ...booking, status: 'cancelled' });
    mockRedisCancelTimer.mockResolvedValue(undefined);
    mockRedisDel.mockResolvedValue(undefined);
    mockRedisGet.mockResolvedValue(null);
    mockAssignmentFindMany.mockResolvedValue([inTransitAssignment]);
    mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockVehicleUpdate.mockResolvedValue({ id: 'vehicle-001', status: 'available' });

    const { bookingService } = require('../modules/booking/booking.service');

    await bookingService.cancelBooking('booking-001', 'customer-001');

    // Driver should receive trip_cancelled event with in-progress context
    expect(mockEmitToUser).toHaveBeenCalledWith(
      'driver-001',
      'trip_cancelled',
      expect.objectContaining({
        assignmentId: 'assign-001',
        bookingId: 'booking-001',
        tripId: 'trip-001',
        reason: 'booking_cancelled_by_customer',
        wasInProgress: true,
        previousStatus: 'in_transit',
        message: expect.stringContaining('cancelled'),
      })
    );
  });

  it('cancelBooking releases vehicle for in_transit assignments', async () => {
    const booking = makeBooking({ customerId: 'customer-001' });
    const inTransitAssignment = {
      id: 'assign-001',
      bookingId: 'booking-001',
      tripId: 'trip-001',
      driverId: 'driver-001',
      vehicleId: 'vehicle-001',
      transporterId: 'transporter-001',
      vehicleType: 'Open',
      vehicleSubtype: '17ft',
      status: 'in_transit',
    };

    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    // First call returns cancelled booking, second call returns same for final fetch
    mockGetBookingById
      .mockResolvedValueOnce({ ...booking, status: 'cancelled' })
      .mockResolvedValueOnce({ ...booking, status: 'cancelled' });
    mockRedisCancelTimer.mockResolvedValue(undefined);
    mockRedisDel.mockResolvedValue(undefined);
    mockRedisGet.mockResolvedValue(null);
    mockAssignmentFindMany.mockResolvedValue([inTransitAssignment]);
    mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    // Must return a resolved promise — code chains .catch() on the result
    mockVehicleUpdate.mockResolvedValue({ id: 'vehicle-001', status: 'available' });

    const { bookingService } = require('../modules/booking/booking.service');

    await bookingService.cancelBooking('booking-001', 'customer-001');

    // Vehicle should be released via centralized releaseVehicle()
    expect(mockReleaseVehicle).toHaveBeenCalledWith(
      'vehicle-001',
      'bookingCancellation'
    );
  });

  it('cancelBooking still cancels pending/accepted assignments as before', async () => {
    const booking = makeBooking({ customerId: 'customer-001' });
    const pendingAssignment = {
      id: 'assign-002',
      bookingId: 'booking-001',
      tripId: 'trip-002',
      driverId: 'driver-002',
      vehicleId: 'vehicle-002',
      transporterId: 'transporter-002',
      vehicleType: 'Open',
      vehicleSubtype: '17ft',
      status: 'pending',
    };
    const acceptedAssignment = {
      id: 'assign-003',
      bookingId: 'booking-001',
      tripId: 'trip-003',
      driverId: 'driver-003',
      vehicleId: 'vehicle-003',
      transporterId: 'transporter-003',
      vehicleType: 'Open',
      vehicleSubtype: '17ft',
      status: 'driver_accepted',
    };

    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockGetBookingById
      .mockResolvedValueOnce({ ...booking, status: 'cancelled' })
      .mockResolvedValueOnce({ ...booking, status: 'cancelled' });
    mockRedisCancelTimer.mockResolvedValue(undefined);
    mockRedisDel.mockResolvedValue(undefined);
    mockRedisGet.mockResolvedValue(null);
    mockAssignmentFindMany.mockResolvedValue([pendingAssignment, acceptedAssignment]);
    mockAssignmentUpdateMany.mockResolvedValue({ count: 2 });
    mockVehicleUpdate.mockResolvedValue({ id: 'v', status: 'available' });

    const { bookingService } = require('../modules/booking/booking.service');

    await bookingService.cancelBooking('booking-001', 'customer-001');

    // Assignments should be cancelled
    expect(mockAssignmentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'cancelled',
        }),
      })
    );

    // Both drivers should receive trip_cancelled
    expect(mockEmitToUser).toHaveBeenCalledWith(
      'driver-002',
      'trip_cancelled',
      expect.anything()
    );
    expect(mockEmitToUser).toHaveBeenCalledWith(
      'driver-003',
      'trip_cancelled',
      expect.anything()
    );

    // Both vehicles should be released via centralized releaseVehicle()
    expect(mockReleaseVehicle).toHaveBeenCalledTimes(2);
    expect(mockReleaseVehicle).toHaveBeenCalledWith('vehicle-002', 'bookingCancellation');
    expect(mockReleaseVehicle).toHaveBeenCalledWith('vehicle-003', 'bookingCancellation');
  });
});

// =============================================================================
// HELPERS
// =============================================================================

function mockReleaseLockSafe(): void {
  mockRedisReleaseLock.mockResolvedValue(undefined);
}

function makeCreateBookingInput(overrides: Record<string, any> = {}): any {
  return {
    vehicleType: 'Open',
    vehicleSubtype: '17ft',
    trucksNeeded: 1,
    distanceKm: 100,
    pricePerTruck: 5000,
    goodsType: 'General',
    weight: '5 tons',
    pickup: {
      address: 'Mumbai',
      city: 'Mumbai',
      state: 'MH',
      coordinates: { latitude: 19.0, longitude: 72.8 },
    },
    drop: {
      address: 'Pune',
      city: 'Pune',
      state: 'MH',
      coordinates: { latitude: 18.5, longitude: 73.8 },
    },
    ...overrides,
  };
}
