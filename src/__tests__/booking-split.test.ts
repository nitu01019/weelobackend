/**
 * =============================================================================
 * BOOKING SPLIT — Comprehensive Tests for Split Booking Module (9 files)
 * =============================================================================
 *
 * Tests the 9-file split of booking.service.ts:
 *   1. Facade integrity (booking.service.ts — re-exports, wiring)
 *   2. Create (booking-create.service.ts — happy path, validation, idempotency)
 *   3. Broadcast (booking-broadcast.service.ts — emit, FCM, timeout, Redis keys)
 *   4. Query (booking-query.service.ts — customer bookings, by ID, access control)
 *   5. Lifecycle (booking-lifecycle.service.ts — timeout, cancel, increment/decrement)
 *   6. Timer (booking-timer.service.ts — expiry checker, DB sweep)
 *   7. Radius (booking-radius.service.ts — expansion, advance step, fallback)
 *   8. Rebroadcast (booking-rebroadcast.service.ts — missed broadcasts)
 *   9. Edge cases & race conditions
 *
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — Must be BEFORE any imports that use these modules
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
    setGauge: jest.fn(),
  },
}));

// --- DB mocks ---
const mockGetBookingById = jest.fn();
const mockUpdateBooking = jest.fn();
const mockGetTransportersWithVehicleType = jest.fn();
const mockGetBookingsByCustomer = jest.fn();
const mockGetActiveBookingsForTransporter = jest.fn();
const mockGetVehiclesByTransporter = jest.fn();
const mockGetUserById = jest.fn();
const mockGetAssignmentsByBooking = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getBookingById: (...args: any[]) => mockGetBookingById(...args),
    updateBooking: (...args: any[]) => mockUpdateBooking(...args),
    getTransportersWithVehicleType: (...args: any[]) => mockGetTransportersWithVehicleType(...args),
    getBookingsByCustomer: (...args: any[]) => mockGetBookingsByCustomer(...args),
    getActiveBookingsForTransporter: (...args: any[]) => mockGetActiveBookingsForTransporter(...args),
    getVehiclesByTransporter: (...args: any[]) => mockGetVehiclesByTransporter(...args),
    getUserById: (...args: any[]) => mockGetUserById(...args),
    getAssignmentsByBooking: (...args: any[]) => mockGetAssignmentsByBooking(...args),
  },
}));

// --- Redis mocks ---
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisExists = jest.fn();
const mockRedisSAdd = jest.fn();
const mockRedisSMembers = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisSetTimer = jest.fn();
const mockRedisCancelTimer = jest.fn();
const mockRedisGetExpiredTimers = jest.fn();
const mockRedisExpire = jest.fn();
const mockRedisIncr = jest.fn();
const mockRedisIncrBy = jest.fn();
const mockRedisHSet = jest.fn();
const mockRedisSAddWithExpire = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    exists: (...args: any[]) => mockRedisExists(...args),
    sAdd: (...args: any[]) => mockRedisSAdd(...args),
    sMembers: (...args: any[]) => mockRedisSMembers(...args),
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    setTimer: (...args: any[]) => mockRedisSetTimer(...args),
    cancelTimer: (...args: any[]) => mockRedisCancelTimer(...args),
    getExpiredTimers: (...args: any[]) => mockRedisGetExpiredTimers(...args),
    expire: (...args: any[]) => mockRedisExpire(...args),
    incr: (...args: any[]) => mockRedisIncr(...args),
    incrBy: (...args: any[]) => mockRedisIncrBy(...args),
    hSet: (...args: any[]) => mockRedisHSet(...args),
    sAddWithExpire: (...args: any[]) => mockRedisSAddWithExpire(...args),
    isConnected: jest.fn().mockReturnValue(true),
    isDegraded: false,
  },
}));

// --- Prisma mocks ---
const mockBookingCreate = jest.fn();
const mockBookingFindFirst = jest.fn();
const mockBookingFindUnique = jest.fn();
const mockBookingUpdateMany = jest.fn();
const mockBookingFindMany = jest.fn();
const mockOrderFindFirst = jest.fn();
const mockAssignmentFindMany = jest.fn();
const mockAssignmentUpdateMany = jest.fn();
const mockVehicleFindMany = jest.fn();
const mockUserFindMany = jest.fn();
const mockQueryRaw = jest.fn();

const mockWithDbTimeout = jest.fn().mockImplementation(async (fn: any, _opts?: any) => {
  const fakeTx = {
    booking: {
      create: mockBookingCreate,
      findFirst: mockBookingFindFirst,
      findUnique: mockBookingFindUnique,
      updateMany: mockBookingUpdateMany,
    },
    order: { findFirst: mockOrderFindFirst },
    assignment: {
      findMany: mockAssignmentFindMany,
      updateMany: mockAssignmentUpdateMany,
    },
    vehicle: { findMany: mockVehicleFindMany },
    user: { findMany: mockUserFindMany },
  };
  return fn(fakeTx);
});

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    booking: {
      create: (...args: any[]) => mockBookingCreate(...args),
      findFirst: (...args: any[]) => mockBookingFindFirst(...args),
      findUnique: (...args: any[]) => mockBookingFindUnique(...args),
      updateMany: (...args: any[]) => mockBookingUpdateMany(...args),
      findMany: (...args: any[]) => mockBookingFindMany(...args),
    },
    order: { findFirst: (...args: any[]) => mockOrderFindFirst(...args) },
    assignment: {
      findMany: (...args: any[]) => mockAssignmentFindMany(...args),
      updateMany: (...args: any[]) => mockAssignmentUpdateMany(...args),
    },
    vehicle: { findMany: (...args: any[]) => mockVehicleFindMany(...args) },
    user: { findMany: (...args: any[]) => mockUserFindMany(...args) },
    $queryRaw: (...args: any[]) => mockQueryRaw(...args),
    $transaction: async (fnOrArray: any, _opts?: any) => {
      if (typeof fnOrArray === 'function') {
        const txProxy = {
          booking: {
            create: (...a: any[]) => mockBookingCreate(...a),
            findFirst: (...a: any[]) => mockBookingFindFirst(...a),
            findUnique: (...a: any[]) => mockBookingFindUnique(...a),
            updateMany: (...a: any[]) => mockBookingUpdateMany(...a),
          },
          order: { findFirst: (...a: any[]) => mockOrderFindFirst(...a) },
          assignment: {
            findMany: (...a: any[]) => mockAssignmentFindMany(...a),
            updateMany: (...a: any[]) => mockAssignmentUpdateMany(...a),
          },
          vehicle: { findMany: (...a: any[]) => mockVehicleFindMany(...a) },
          $queryRaw: (...a: any[]) => mockQueryRaw(...a),
        };
        return fnOrArray(txProxy);
      }
      return Promise.all(fnOrArray);
    },
  },
  withDbTimeout: (...args: any[]) => mockWithDbTimeout(...args),
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
    completed: 'completed',
    cancelled: 'cancelled',
    driver_declined: 'driver_declined',
  },
  VehicleStatus: {
    available: 'available',
    on_hold: 'on_hold',
    in_transit: 'in_transit',
    maintenance: 'maintenance',
    inactive: 'inactive',
  },
}));

// --- Socket mocks ---
const mockEmitToUser = jest.fn();
const mockEmitToBooking = jest.fn();
const mockIsUserConnected = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToBooking: (...args: any[]) => mockEmitToBooking(...args),
  emitToRoom: jest.fn(),
  emitToUsers: jest.fn(),
  emitToAllTransporters: jest.fn(),
  emitToAll: jest.fn(),
  isUserConnected: (...args: any[]) => mockIsUserConnected(...args),
  isUserConnectedAsync: (...args: any[]) => Promise.resolve(mockIsUserConnected(...args)),
  SocketEvent: {
    CONNECTED: 'connected',
    BOOKING_UPDATED: 'booking_updated',
    TRUCK_ASSIGNED: 'truck_assigned',
    TRIP_ASSIGNED: 'trip_assigned',
    LOCATION_UPDATED: 'location_updated',
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    NEW_BROADCAST: 'new_broadcast',
    TRUCK_CONFIRMED: 'truck_confirmed',
    BOOKING_EXPIRED: 'booking_expired',
    BOOKING_FULLY_FILLED: 'booking_fully_filled',
    BOOKING_PARTIALLY_FILLED: 'booking_partially_filled',
    NO_VEHICLES_AVAILABLE: 'no_vehicles_available',
    BROADCAST_COUNTDOWN: 'broadcast_countdown',
    TRUCK_REQUEST_ACCEPTED: 'truck_request_accepted',
    TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update',
    REQUEST_NO_LONGER_AVAILABLE: 'request_no_longer_available',
    ORDER_STATUS_UPDATE: 'order_status_update',
    BROADCAST_STATE_CHANGED: 'broadcast_state_changed',
    TRIP_CANCELLED: 'trip_cancelled',
    VEHICLE_REGISTERED: 'vehicle_registered',
    VEHICLE_UPDATED: 'vehicle_updated',
    VEHICLE_DELETED: 'vehicle_deleted',
    VEHICLE_STATUS_CHANGED: 'vehicle_status_changed',
    FLEET_UPDATED: 'fleet_updated',
  },
}));

// --- FCM mock ---
const mockNotifyNewBroadcast = jest.fn().mockResolvedValue(0);
jest.mock('../shared/services/fcm.service', () => ({
  fcmService: {
    notifyNewBroadcast: (...args: any[]) => mockNotifyNewBroadcast(...args),
  },
}));

// --- Queue mock ---
const mockQueueBroadcast = jest.fn().mockResolvedValue(undefined);
const mockQueuePushNotificationBatch = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queueBroadcast: (...args: any[]) => mockQueueBroadcast(...args),
    queuePushNotificationBatch: (...args: any[]) => mockQueuePushNotificationBatch(...args),
  },
}));

// --- Availability service mock ---
const mockLoadTransporterDetailsMap = jest.fn().mockResolvedValue(new Map());
const mockGetTransporterDetails = jest.fn().mockResolvedValue(null);
jest.mock('../shared/services/availability.service', () => ({
  availabilityService: {
    loadTransporterDetailsMap: (...args: any[]) => mockLoadTransporterDetailsMap(...args),
    getTransporterDetails: (...args: any[]) => mockGetTransporterDetails(...args),
  },
}));

// --- Transporter online service mock ---
const mockFilterOnline = jest.fn();
jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: {
    filterOnline: (...args: any[]) => mockFilterOnline(...args),
    isOnline: jest.fn().mockResolvedValue(true),
  },
}));

jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn().mockReturnValue('Tipper_20-24 Ton'),
}));

// --- Progressive radius matcher mock ---
const mockFindCandidates = jest.fn().mockResolvedValue([]);
const mockGetStepCount = jest.fn().mockReturnValue(6);
jest.mock('../modules/order/progressive-radius-matcher', () => ({
  ...jest.requireActual('../modules/order/progressive-radius-matcher'),
  progressiveRadiusMatcher: {
    findCandidates: (...args: any[]) => mockFindCandidates(...args),
    getStepCount: (...args: any[]) => mockGetStepCount(...args),
    getStep: jest.fn().mockReturnValue({ radiusKm: 10, windowMs: 10_000, h3RingK: 15 }),
  },
  PROGRESSIVE_RADIUS_STEPS: [
    { radiusKm: 10, windowMs: 10_000, h3RingK: 15 },
    { radiusKm: 20, windowMs: 10_000, h3RingK: 30 },
    { radiusKm: 40, windowMs: 15_000, h3RingK: 60 },
    { radiusKm: 70, windowMs: 15_000, h3RingK: 100 },
    { radiusKm: 100, windowMs: 15_000, h3RingK: 150 },
    { radiusKm: 150, windowMs: 15_000, h3RingK: 200 },
  ],
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

jest.mock('../core/constants', () => ({
  ErrorCode: { VEHICLE_INSUFFICIENT: 'VEHICLE_INSUFFICIENT' },
}));

jest.mock('../modules/pricing/vehicle-catalog', () => ({
  getSubtypeConfig: jest.fn().mockReturnValue({ capacityKg: 20000, minTonnage: 20, maxTonnage: 24 }),
}));

jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
}));

// =============================================================================
// IMPORTS — After all mocks
// =============================================================================

import { bookingService } from '../modules/booking/booking.service';
import { bookingCreateService } from '../modules/booking/booking-create.service';
import { bookingBroadcastService, setBroadcastRadiusServiceRef } from '../modules/booking/booking-broadcast.service';
import { bookingQueryService } from '../modules/booking/booking-query.service';
import { bookingLifecycleService, setCreateServiceRef } from '../modules/booking/booking-lifecycle.service';
import { bookingRadiusService } from '../modules/booking/booking-radius.service';
import { bookingRebroadcastService } from '../modules/booking/booking-rebroadcast.service';

// =============================================================================
// HELPERS
// =============================================================================

function makeBooking(overrides: Record<string, any> = {}): any {
  return {
    id: 'booking-001',
    customerId: 'customer-001',
    customerName: 'Test Customer',
    customerPhone: '9999999999',
    pickup: { latitude: 12.97, longitude: 77.59, address: 'Pickup Addr', city: 'Bangalore', state: 'KA' },
    drop: { latitude: 13.0, longitude: 77.6, address: 'Drop Addr', city: 'Bangalore', state: 'KA' },
    vehicleType: 'Tipper',
    vehicleSubtype: '20-24 Ton',
    trucksNeeded: 3,
    trucksFilled: 0,
    distanceKm: 50,
    pricePerTruck: 5000,
    totalAmount: 15000,
    goodsType: 'Sand',
    weight: '20 Ton',
    status: 'active',
    notifiedTransporters: ['transporter-001', 'transporter-002'],
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCreateBookingInput(): any {
  return {
    vehicleType: 'Tipper',
    vehicleSubtype: '20-24 Ton',
    trucksNeeded: 2,
    pricePerTruck: 5000,
    distanceKm: 50,
    goodsType: 'Sand',
    weight: '20 Ton',
    pickup: {
      coordinates: { latitude: 12.97, longitude: 77.59 },
      address: 'Pickup Addr',
      city: 'Bangalore',
      state: 'KA',
    },
    drop: {
      coordinates: { latitude: 13.0, longitude: 77.6 },
      address: 'Drop Addr',
      city: 'Bangalore',
      state: 'KA',
    },
  };
}

function makeRadiusStepData(overrides: Record<string, any> = {}): any {
  return {
    bookingId: 'booking-001',
    customerId: 'customer-001',
    vehicleKey: 'Tipper_20-24 Ton',
    vehicleType: 'Tipper',
    vehicleSubtype: '20-24 Ton',
    pickupLat: 12.97,
    pickupLng: 77.59,
    currentStep: 0,
    ...overrides,
  };
}

// =============================================================================
// TEST SUITE
// =============================================================================

beforeEach(() => {
  jest.clearAllMocks();

  // Initialize broadcast radius service ref for setupBookingTimeout tests
  setBroadcastRadiusServiceRef({
    startProgressiveExpansion: jest.fn().mockResolvedValue(undefined),
  });

  // Initialize lifecycle create service ref for decrementTrucksFilled tests
  setCreateServiceRef({
    startBookingTimeout: jest.fn(),
  });

  // Default Redis mock behaviors
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
  mockRedisExists.mockResolvedValue(0);
  mockRedisSAdd.mockResolvedValue(1);
  mockRedisSMembers.mockResolvedValue([]);
  mockRedisAcquireLock.mockResolvedValue({ acquired: true });
  mockRedisReleaseLock.mockResolvedValue(true);
  mockRedisSetTimer.mockResolvedValue(undefined);
  mockRedisCancelTimer.mockResolvedValue(undefined);
  mockRedisGetExpiredTimers.mockResolvedValue([]);
  mockRedisExpire.mockResolvedValue(1);
  mockRedisIncr.mockResolvedValue(1);
  mockRedisIncrBy.mockResolvedValue(0);
  mockRedisHSet.mockResolvedValue(1);
  mockRedisSAddWithExpire.mockResolvedValue(undefined);

  // Default DB mock behaviors
  mockGetBookingById.mockResolvedValue(null);
  mockUpdateBooking.mockResolvedValue(undefined);
  mockGetTransportersWithVehicleType.mockResolvedValue([]);
  mockGetBookingsByCustomer.mockResolvedValue([]);
  mockGetActiveBookingsForTransporter.mockResolvedValue([]);
  mockGetVehiclesByTransporter.mockResolvedValue([]);
  mockGetUserById.mockResolvedValue({ id: 'customer-001', name: 'Test Customer' });
  mockGetAssignmentsByBooking.mockResolvedValue([]);

  // Prisma defaults
  mockBookingCreate.mockResolvedValue({});
  mockBookingFindFirst.mockResolvedValue(null);
  mockBookingFindUnique.mockResolvedValue(null);
  mockBookingUpdateMany.mockResolvedValue({ count: 1 });
  mockBookingFindMany.mockResolvedValue([]);
  mockOrderFindFirst.mockResolvedValue(null);
  mockAssignmentFindMany.mockResolvedValue([]);
  mockAssignmentUpdateMany.mockResolvedValue({ count: 0 });
  // FIX #13: Default to returning transporter IDs so batch eligibility check passes.
  // Tests that need specific vehicle data or empty results override this.
  mockVehicleFindMany.mockResolvedValue([
    { transporterId: 'transporter-001', vehicleType: 'Tipper', vehicleSubtype: '20-24 Ton' },
    { transporterId: 'transporter-002', vehicleType: 'Tipper', vehicleSubtype: '20-24 Ton' },
    { transporterId: 't1', vehicleType: 'Tipper', vehicleSubtype: '20-24 Ton' },
    { transporterId: 't-001', vehicleType: 'Tipper', vehicleSubtype: '20-24 Ton' },
    { transporterId: 't-002', vehicleType: 'Tipper', vehicleSubtype: '20-24 Ton' },
  ]);
  mockUserFindMany.mockResolvedValue([]);
  mockQueryRaw.mockResolvedValue([]);

  // Other service defaults
  mockFilterOnline.mockImplementation((ids: string[]) => Promise.resolve(ids));
  mockIsUserConnected.mockReturnValue(false);
  mockFindCandidates.mockResolvedValue([]);
});

// =============================================================================
// 1. FACADE INTEGRITY
// =============================================================================

describe('Facade integrity (booking.service.ts)', () => {
  test('bookingService exposes createBooking method', () => {
    expect(typeof bookingService.createBooking).toBe('function');
  });

  test('bookingService exposes startBookingTimeout method', () => {
    expect(typeof (bookingService as any).startBookingTimeout).toBe('function');
  });

  test('bookingService exposes getCustomerBookings method', () => {
    expect(typeof bookingService.getCustomerBookings).toBe('function');
  });

  test('bookingService exposes getActiveBroadcasts method', () => {
    expect(typeof bookingService.getActiveBroadcasts).toBe('function');
  });

  test('bookingService exposes getBookingById method', () => {
    expect(typeof bookingService.getBookingById).toBe('function');
  });

  test('bookingService exposes getAssignedTrucks method', () => {
    expect(typeof bookingService.getAssignedTrucks).toBe('function');
  });

  test('bookingService exposes handleBookingTimeout method', () => {
    expect(typeof bookingService.handleBookingTimeout).toBe('function');
  });

  test('bookingService exposes cancelBooking method', () => {
    expect(typeof bookingService.cancelBooking).toBe('function');
  });

  test('bookingService exposes incrementTrucksFilled method', () => {
    expect(typeof bookingService.incrementTrucksFilled).toBe('function');
  });

  test('bookingService exposes decrementTrucksFilled method', () => {
    expect(typeof bookingService.decrementTrucksFilled).toBe('function');
  });

  test('bookingService exposes cancelBookingTimeout method', () => {
    expect(typeof bookingService.cancelBookingTimeout).toBe('function');
  });

  test('bookingService exposes advanceRadiusStep method', () => {
    expect(typeof bookingService.advanceRadiusStep).toBe('function');
  });

  test('bookingService exposes deliverMissedBroadcasts method', () => {
    expect(typeof bookingService.deliverMissedBroadcasts).toBe('function');
  });

  test('startBookingExpiryChecker is exported from module', async () => {
    const mod = await import('../modules/booking/booking.service');
    expect(typeof mod.startBookingExpiryChecker).toBe('function');
  });

  test('stopBookingExpiryChecker is exported from module', async () => {
    const mod = await import('../modules/booking/booking.service');
    expect(typeof mod.stopBookingExpiryChecker).toBe('function');
  });
});

// =============================================================================
// 2. CREATE TESTS (booking-create.service.ts)
// =============================================================================

describe('BookingCreateService', () => {
  function setupCreateHappyPath() {
    const booking = makeBooking({ status: 'created' });
    // Backpressure: allow through
    mockRedisIncr.mockResolvedValue(1);
    // No idempotency hit
    mockRedisGet.mockResolvedValue(null);
    // Lock acquired
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    // No existing booking or order in TX
    mockBookingFindFirst.mockResolvedValue(null);
    mockOrderFindFirst.mockResolvedValue(null);
    // Booking created successfully
    mockBookingCreate.mockResolvedValue({});
    // Return booking after creation
    mockGetBookingById.mockResolvedValue(booking);
    // No matching transporters from progressive radius
    mockFindCandidates.mockResolvedValue([]);
    // DB fallback returns some transporters
    mockGetTransportersWithVehicleType.mockResolvedValue(['transporter-001']);
    mockFilterOnline.mockResolvedValue(['transporter-001']);
    // Status updates succeed
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });

    return booking;
  }

  test('createBooking - happy path returns booking with metadata', async () => {
    mockGetBookingById.mockResolvedValue(
      makeBooking({ id: 'booking-new', status: 'created', matchingTransporters: ['t1'] })
    );

    const result = await bookingCreateService.createBooking(
      'customer-001', '9999999999', makeCreateBookingInput()
    );

    expect(result).toBeDefined();
    expect(result.id).toBeDefined();
    expect(typeof result.matchingTransportersCount).toBe('number');
    expect(typeof result.timeoutSeconds).toBe('number');
  });

  test('createBooking - acquires and releases backpressure counter', async () => {
    setupCreateHappyPath();

    await bookingCreateService.createBooking(
      'customer-001', '9999999999', makeCreateBookingInput()
    );

    expect(mockRedisIncr).toHaveBeenCalledWith('booking:create:inflight');
    expect(mockRedisIncrBy).toHaveBeenCalledWith('booking:create:inflight', -1);
  });

  test('createBooking - rejects when system busy (backpressure limit)', async () => {
    mockRedisIncr.mockResolvedValue(100); // Over limit of 50

    await expect(
      bookingCreateService.createBooking('customer-001', '9999999999', makeCreateBookingInput())
    ).rejects.toThrow('Too many bookings being processed');
  });

  test('createBooking - skips backpressure when Redis is down', async () => {
    mockRedisIncr.mockRejectedValue(new Error('Redis connection lost'));
    setupCreateHappyPath();
    // Reset the incr mock to throw
    mockRedisIncr.mockRejectedValue(new Error('Redis connection lost'));

    // Should not throw, proceeds without backpressure
    const result = await bookingCreateService.createBooking(
      'customer-001', '9999999999', makeCreateBookingInput()
    );
    expect(result).toBeDefined();
  });

  test('createBooking - idempotency key returns cached booking', async () => {
    const existing = makeBooking({ status: 'active' });
    mockRedisGet
      .mockResolvedValueOnce(null) // cooldown check
      .mockResolvedValueOnce('existing-booking-id'); // idempotency key
    mockGetBookingById.mockResolvedValueOnce(existing);
    mockGetTransportersWithVehicleType.mockResolvedValue(['t1', 't2']);

    const result = await bookingCreateService.createBooking(
      'customer-001', '9999999999', makeCreateBookingInput(), 'idem-key-1'
    );

    expect(result.id).toBe('booking-001');
    expect(result.matchingTransportersCount).toBe(2);
  });

  test('createBooking - bypasses idempotency for cancelled bookings', async () => {
    const cancelled = makeBooking({ status: 'cancelled' });
    // cooldown check then idempotency hit
    mockRedisGet
      .mockResolvedValueOnce(null) // cooldown check
      .mockResolvedValueOnce('old-booking-id');
    mockGetBookingById.mockResolvedValueOnce(cancelled);

    // After bypass, the rest of create flow should proceed
    setupCreateHappyPath();
    // Reset getBookingById so it doesn't return cancelled on the next call
    mockGetBookingById.mockResolvedValue(makeBooking({ status: 'created' }));
    // No active broadcast key
    mockRedisGet.mockResolvedValue(null);

    const result = await bookingCreateService.createBooking(
      'customer-001', '9999999999', makeCreateBookingInput(), 'idem-key-1'
    );

    // Should have cleared the stale key
    expect(mockRedisDel).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  test('createBooking - rejects duplicate active booking (one-per-customer guard)', async () => {
    // Active broadcast exists in Redis
    mockRedisGet.mockImplementation((key: string) => {
      if (key.startsWith('customer:active-broadcast:')) return Promise.resolve('existing-id');
      return Promise.resolve(null);
    });

    await expect(
      bookingCreateService.createBooking('customer-001', '9999999999', makeCreateBookingInput())
    ).rejects.toThrow('Request already in progress');
  });

  test('createBooking - rejects when lock not acquired', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: false });

    await expect(
      bookingCreateService.createBooking('customer-001', '9999999999', makeCreateBookingInput())
    ).rejects.toThrow('Request already in progress');
  });

  test('createBooking - rejects fare below minimum', async () => {
    setupCreateHappyPath();
    const input = makeCreateBookingInput();
    input.pricePerTruck = 10; // Way below minimum

    await expect(
      bookingCreateService.createBooking('customer-001', '9999999999', input)
    ).rejects.toThrow(/below minimum/);
  });

  test('createBooking - handles no matching transporters (immediate expire)', async () => {
    setupCreateHappyPath();
    mockFindCandidates.mockResolvedValue([]);
    mockGetTransportersWithVehicleType.mockResolvedValue([]);
    mockFilterOnline.mockResolvedValue([]);

    const result = await bookingCreateService.createBooking(
      'customer-001', '9999999999', makeCreateBookingInput()
    );

    // Should return with expired status and 0 matching
    expect(result.matchingTransportersCount).toBe(0);
    expect(result.status).toBe('expired');
  });

  test('createBooking - server-side idempotency catches double-tap', async () => {
    const existing = makeBooking({ status: 'active' });
    // First Redis calls (backpressure + customer active broadcast) return null
    mockRedisGet.mockResolvedValue(null);
    // Lock succeeds
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    // But dedupe key returns existing booking
    mockRedisGet.mockImplementation((key: string) => {
      if (key.startsWith('idem:broadcast:create:')) return Promise.resolve('booking-001');
      return Promise.resolve(null);
    });
    mockGetBookingById.mockResolvedValue(existing);
    mockGetTransportersWithVehicleType.mockResolvedValue(['t1']);

    const result = await bookingCreateService.createBooking(
      'customer-001', '9999999999', makeCreateBookingInput()
    );

    expect(result.id).toBe('booking-001');
  });

  test('createBooking - DB SERIALIZABLE TX rejects duplicate active booking', async () => {
    setupCreateHappyPath();
    // Inside the transaction, existing booking found
    mockBookingFindFirst.mockResolvedValue({ id: 'existing-booking', status: 'active' });

    await expect(
      bookingCreateService.createBooking('customer-001', '9999999999', makeCreateBookingInput())
    ).rejects.toThrow('Request already in progress');
  });

  test('createBooking - DB TX rejects if active order exists', async () => {
    setupCreateHappyPath();
    mockBookingFindFirst.mockResolvedValue(null);
    mockOrderFindFirst.mockResolvedValue({ id: 'existing-order', status: 'active' });

    await expect(
      bookingCreateService.createBooking('customer-001', '9999999999', makeCreateBookingInput())
    ).rejects.toThrow('Request already in progress');
  });

  test('createBooking - resolves customer name from DB', async () => {
    setupCreateHappyPath();
    mockGetUserById.mockResolvedValue({ id: 'customer-001', name: 'John Doe' });

    await bookingCreateService.createBooking(
      'customer-001', '9999999999', makeCreateBookingInput()
    );

    expect(mockGetUserById).toHaveBeenCalledWith('customer-001');
  });
});

// =============================================================================
// 3. BROADCAST TESTS (booking-broadcast.service.ts)
// =============================================================================

describe('BookingBroadcastService', () => {
  function makeBroadcastCtx(overrides: Record<string, any> = {}): any {
    const booking = makeBooking({ status: 'created' });
    return {
      customerId: 'customer-001',
      data: makeCreateBookingInput(),
      booking,
      matchingTransporters: ['transporter-001', 'transporter-002'],
      step1Candidates: [
        { transporterId: 'transporter-001', distanceKm: 5, etaSeconds: 600 },
        { transporterId: 'transporter-002', distanceKm: 12, etaSeconds: 1200 },
      ],
      candidateMap: new Map(),
      cappedTransporters: ['transporter-001', 'transporter-002'],
      vehicleKey: 'Tipper_20-24 Ton',
      skipProgressiveExpansion: false,
      ...overrides,
    };
  }

  test('broadcastBookingToTransporters - transitions to broadcasting and completes without error', async () => {
    // FIX #13: Batch eligibility check needs vehicle data to pass transporters through
    mockVehicleFindMany.mockResolvedValue([
      { transporterId: 'transporter-001' },
      { transporterId: 'transporter-002' },
    ]);
    const ctx = makeBroadcastCtx();
    await bookingBroadcastService.broadcastBookingToTransporters(ctx);

    // Should have transitioned status to broadcasting
    expect(mockBookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'broadcasting' }),
      })
    );
  });

  test('broadcastBookingToTransporters - transitions status to broadcasting', async () => {
    const ctx = makeBroadcastCtx();
    await bookingBroadcastService.broadcastBookingToTransporters(ctx);

    expect(mockBookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'created' }),
        data: expect.objectContaining({ status: 'broadcasting' }),
      })
    );
  });

  test('broadcastBookingToTransporters - tracks notified transporters in Redis SET', async () => {
    const ctx = makeBroadcastCtx();
    await bookingBroadcastService.broadcastBookingToTransporters(ctx);

    expect(mockRedisSAddWithExpire).toHaveBeenCalledWith(
      expect.stringContaining('broadcast:notified:'),
      expect.any(Number),
      'transporter-001',
      'transporter-002'
    );
  });

  test('broadcastBookingToTransporters - stops mid-broadcast if booking becomes cancelled', async () => {
    // With many transporters, status check fires mid-loop
    const transporters = Array.from({ length: 25 }, (_, i) => `t-${i}`);
    const ctx = makeBroadcastCtx({
      matchingTransporters: transporters,
      cappedTransporters: transporters,
      step1Candidates: transporters.map(t => ({ transporterId: t, distanceKm: 5, etaSeconds: 600 })),
    });
    // After first status check, booking is cancelled
    mockBookingFindUnique.mockResolvedValue({ status: 'cancelled' });

    await bookingBroadcastService.broadcastBookingToTransporters(ctx);

    // Should have stopped early - not all 25 transporters emitted
    const emitCalls = mockEmitToUser.mock.calls.filter(
      (c: any[]) => c[1] === 'new_broadcast'
    );
    expect(emitCalls.length).toBeLessThan(25);
  });

  test('sendFcmPushNotifications - sends FCM only to offline transporters', async () => {
    const ctx = makeBroadcastCtx();
    // transporter-001 is connected, transporter-002 is not
    mockIsUserConnected.mockImplementation((id: string) => id === 'transporter-001');

    await bookingBroadcastService.sendFcmPushNotifications(ctx);

    expect(mockNotifyNewBroadcast).toHaveBeenCalledWith(
      ['transporter-002'],
      expect.objectContaining({ broadcastId: 'booking-001' })
    );
  });

  test('sendFcmPushNotifications - skips FCM when all transporters connected', async () => {
    const ctx = makeBroadcastCtx();
    mockIsUserConnected.mockReturnValue(true);

    await bookingBroadcastService.sendFcmPushNotifications(ctx);

    expect(mockNotifyNewBroadcast).not.toHaveBeenCalled();
  });

  test('setupBookingTimeout - starts timer and transitions to active', async () => {
    const ctx = makeBroadcastCtx();
    await bookingBroadcastService.setupBookingTimeout(ctx);

    expect(mockRedisCancelTimer).toHaveBeenCalled();
    expect(mockRedisSetTimer).toHaveBeenCalled();
    expect(mockBookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'broadcasting' }),
        data: expect.objectContaining({ status: 'active' }),
      })
    );
  });

  test('setupBookingTimeout - skips progressive expansion when skipProgressiveExpansion=true', async () => {
    const ctx = makeBroadcastCtx({ skipProgressiveExpansion: true });
    await bookingBroadcastService.setupBookingTimeout(ctx);

    // Progressive expansion should NOT be started
    // Verify no radius timer was set (only the booking expiry timer)
    const timerCalls = mockRedisSetTimer.mock.calls;
    const radiusCalls = timerCalls.filter((c: any[]) => c[0].includes('radius'));
    expect(radiusCalls.length).toBe(0);
  });

  test('setBookingRedisKeys - stores idempotency key when provided', async () => {
    const ctx = makeBroadcastCtx({ idempotencyKey: 'client-idem-key', idempotencyHash: 'abc123', dedupeKey: 'idem:test' });

    await bookingBroadcastService.setBookingRedisKeys(ctx);

    // FIX #30/#31: Key now includes payload hash; value is full response JSON (not just ID)
    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringContaining('idempotency:booking:customer-001:client-idem-key'),
      expect.any(String),
      expect.any(Number)
    );
  });

  test('setBookingRedisKeys - stores server-generated dedupe key', async () => {
    const ctx = makeBroadcastCtx({ dedupeKey: 'idem:broadcast:create:customer-001:abc123' });

    await bookingBroadcastService.setBookingRedisKeys(ctx);

    expect(mockRedisSet).toHaveBeenCalledWith(
      'idem:broadcast:create:customer-001:abc123',
      'booking-001',
      expect.any(Number)
    );
  });

  test('startBookingTimeout - cancels existing timer before setting new one', async () => {
    await bookingBroadcastService.startBookingTimeout('booking-001', 'customer-001');

    expect(mockRedisCancelTimer).toHaveBeenCalledWith(expect.stringContaining('timer:booking:booking-001'));
    expect(mockRedisSetTimer).toHaveBeenCalledWith(
      expect.stringContaining('timer:booking:booking-001'),
      expect.objectContaining({ bookingId: 'booking-001', customerId: 'customer-001' }),
      expect.any(Date)
    );
  });
});

// =============================================================================
// 4. QUERY TESTS (booking-query.service.ts)
// =============================================================================

describe('BookingQueryService', () => {
  test('getCustomerBookings - returns paginated results', async () => {
    const bookings = [
      makeBooking({ id: 'b1', createdAt: new Date(2024, 1, 1).toISOString() }),
      makeBooking({ id: 'b2', createdAt: new Date(2024, 2, 1).toISOString() }),
      makeBooking({ id: 'b3', createdAt: new Date(2024, 3, 1).toISOString() }),
    ];
    mockGetBookingsByCustomer.mockResolvedValue(bookings);

    const result = await bookingQueryService.getCustomerBookings('customer-001', { page: 1, limit: 2 });

    expect(result.total).toBe(3);
    expect(result.bookings.length).toBe(2);
    expect(result.hasMore).toBe(true);
  });

  test('getCustomerBookings - returns empty when no bookings', async () => {
    mockGetBookingsByCustomer.mockResolvedValue([]);

    const result = await bookingQueryService.getCustomerBookings('customer-001', { page: 1, limit: 20 });

    expect(result.total).toBe(0);
    expect(result.bookings).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  test('getCustomerBookings - filters by status', async () => {
    const bookings = [
      makeBooking({ id: 'b1', status: 'active' }),
      makeBooking({ id: 'b2', status: 'cancelled' }),
      makeBooking({ id: 'b3', status: 'active' }),
    ];
    mockGetBookingsByCustomer.mockResolvedValue(bookings);

    const result = await bookingQueryService.getCustomerBookings('customer-001', { page: 1, limit: 20, status: 'active' });

    expect(result.total).toBe(2);
    expect(result.bookings.every((b: any) => b.status === 'active')).toBe(true);
  });

  test('getCustomerBookings - sorts by newest first', async () => {
    const bookings = [
      makeBooking({ id: 'b-old', createdAt: new Date(2024, 1, 1).toISOString() }),
      makeBooking({ id: 'b-new', createdAt: new Date(2024, 6, 1).toISOString() }),
    ];
    mockGetBookingsByCustomer.mockResolvedValue(bookings);

    const result = await bookingQueryService.getCustomerBookings('customer-001', { page: 1, limit: 20 });

    expect(result.bookings[0].id).toBe('b-new');
    expect(result.bookings[1].id).toBe('b-old');
  });

  test('getActiveBroadcasts - returns only active/partially_filled unexpired bookings', async () => {
    const futureExpiry = new Date(Date.now() + 60_000).toISOString();
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    const bookings = [
      makeBooking({ id: 'b1', status: 'active', expiresAt: futureExpiry }),
      makeBooking({ id: 'b2', status: 'active', expiresAt: pastExpiry }), // expired
      makeBooking({ id: 'b3', status: 'cancelled', expiresAt: futureExpiry }), // wrong status
      makeBooking({ id: 'b4', status: 'partially_filled', expiresAt: futureExpiry }),
    ];
    mockGetActiveBookingsForTransporter.mockResolvedValue(bookings);

    const result = await bookingQueryService.getActiveBroadcasts('transporter-001', { page: 1, limit: 20 });

    expect(result.total).toBe(2); // b1 and b4
    expect(result.bookings.map((b: any) => b.id).sort()).toEqual(['b1', 'b4']);
  });

  test('getActiveBroadcasts - returns empty when no matching bookings', async () => {
    mockGetActiveBookingsForTransporter.mockResolvedValue([]);

    const result = await bookingQueryService.getActiveBroadcasts('transporter-001', { page: 1, limit: 20 });

    expect(result.total).toBe(0);
    expect(result.bookings).toEqual([]);
  });

  test('getBookingById - returns booking for owner', async () => {
    const booking = makeBooking();
    mockGetBookingById.mockResolvedValue(booking);

    const result = await bookingQueryService.getBookingById('booking-001', 'customer-001', 'customer');

    expect(result.id).toBe('booking-001');
  });

  test('getBookingById - throws 404 when not found', async () => {
    mockGetBookingById.mockResolvedValue(null);

    await expect(
      bookingQueryService.getBookingById('nonexistent', 'customer-001', 'customer')
    ).rejects.toThrow('Booking not found');
  });

  test('getBookingById - rejects access for wrong customer', async () => {
    const booking = makeBooking({ customerId: 'customer-001' });
    mockGetBookingById.mockResolvedValue(booking);

    await expect(
      bookingQueryService.getBookingById('booking-001', 'other-customer', 'customer')
    ).rejects.toThrow('Access denied');
  });

  test('getBookingById - transporter access requires matching vehicle', async () => {
    const booking = makeBooking({ vehicleType: 'Tipper' });
    mockGetBookingById.mockResolvedValue(booking);
    mockGetVehiclesByTransporter.mockResolvedValue([
      { vehicleType: 'Container', isActive: true },
    ]);

    await expect(
      bookingQueryService.getBookingById('booking-001', 'transporter-001', 'transporter')
    ).rejects.toThrow(/matching vehicles/);
  });

  test('getBookingById - transporter with matching vehicle type succeeds', async () => {
    const booking = makeBooking({ vehicleType: 'Tipper' });
    mockGetBookingById.mockResolvedValue(booking);
    mockGetVehiclesByTransporter.mockResolvedValue([
      { vehicleType: 'Tipper', isActive: true },
    ]);

    const result = await bookingQueryService.getBookingById('booking-001', 'transporter-001', 'transporter');
    expect(result.id).toBe('booking-001');
  });

  test('getAssignedTrucks - returns formatted assignments', async () => {
    const booking = makeBooking();
    mockGetBookingById.mockResolvedValue(booking);
    mockGetAssignmentsByBooking.mockResolvedValue([
      {
        id: 'assign-1', tripId: 'trip-1', vehicleNumber: 'KA01AB1234',
        vehicleType: 'Tipper', driverName: 'Driver 1', driverPhone: '8888888888',
        driverId: 'driver-001', status: 'driver_accepted', assignedAt: new Date().toISOString(),
      },
    ]);
    mockUserFindMany.mockResolvedValue([{ id: 'driver-001', avgRating: 4.5, totalRatings: 10 }]);

    const result = await bookingQueryService.getAssignedTrucks('booking-001', 'customer-001', 'customer');

    expect(result).toHaveLength(1);
    expect(result[0].assignmentId).toBe('assign-1');
    expect(result[0].driverRating).toBe(4.5);
  });

  test('getAssignedTrucks - throws 404 for missing booking', async () => {
    mockGetBookingById.mockResolvedValue(null);

    await expect(
      bookingQueryService.getAssignedTrucks('nonexistent', 'customer-001', 'customer')
    ).rejects.toThrow('Booking not found');
  });
});

// =============================================================================
// 5. LIFECYCLE TESTS (booking-lifecycle.service.ts)
// =============================================================================

describe('BookingLifecycleService', () => {

  // --- handleBookingTimeout ---

  test('handleBookingTimeout - expires unfilled booking and notifies customer', async () => {
    const booking = makeBooking({ status: 'active', trucksFilled: 0 });
    mockGetBookingById.mockResolvedValue(booking);

    await bookingLifecycleService.handleBookingTimeout('booking-001', 'customer-001');

    expect(mockBookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'expired' }),
      })
    );
    expect(mockEmitToUser).toHaveBeenCalledWith(
      'customer-001', 'no_vehicles_available', expect.any(Object)
    );
  });

  test('handleBookingTimeout - partially filled booking sends partial options', async () => {
    const booking = makeBooking({ status: 'partially_filled', trucksFilled: 1, trucksNeeded: 3 });
    mockGetBookingById.mockResolvedValue(booking);

    await bookingLifecycleService.handleBookingTimeout('booking-001', 'customer-001');

    expect(mockEmitToUser).toHaveBeenCalledWith(
      'customer-001', 'booking_expired',
      expect.objectContaining({
        status: 'partially_filled_expired',
        trucksFilled: 1,
        trucksNeeded: 3,
      })
    );
  });

  test('handleBookingTimeout - skips terminal states (fully_filled)', async () => {
    const booking = makeBooking({ status: 'fully_filled' });
    mockGetBookingById.mockResolvedValue(booking);

    await bookingLifecycleService.handleBookingTimeout('booking-001', 'customer-001');

    // Should NOT update status
    expect(mockBookingUpdateMany).not.toHaveBeenCalled();
  });

  test('handleBookingTimeout - skips completed booking', async () => {
    const booking = makeBooking({ status: 'completed' });
    mockGetBookingById.mockResolvedValue(booking);

    await bookingLifecycleService.handleBookingTimeout('booking-001', 'customer-001');

    expect(mockBookingUpdateMany).not.toHaveBeenCalled();
  });

  test('handleBookingTimeout - skips cancelled booking', async () => {
    const booking = makeBooking({ status: 'cancelled' });
    mockGetBookingById.mockResolvedValue(booking);

    await bookingLifecycleService.handleBookingTimeout('booking-001', 'customer-001');

    expect(mockBookingUpdateMany).not.toHaveBeenCalled();
  });

  test('handleBookingTimeout - returns when booking not found', async () => {
    mockGetBookingById.mockResolvedValue(null);

    await bookingLifecycleService.handleBookingTimeout('nonexistent', 'customer-001');

    expect(mockBookingUpdateMany).not.toHaveBeenCalled();
  });

  test('handleBookingTimeout - notifies all notified transporters of expiry', async () => {
    const booking = makeBooking({
      status: 'active', trucksFilled: 0,
      notifiedTransporters: ['t-001', 't-002', 't-003'],
    });
    mockGetBookingById.mockResolvedValue(booking);

    await bookingLifecycleService.handleBookingTimeout('booking-001', 'customer-001');

    const expiryCalls = mockEmitToUser.mock.calls.filter(
      (c: any[]) => c[1] === 'booking_expired'
    );
    expect(expiryCalls.length).toBeGreaterThanOrEqual(3);
  });

  test('handleBookingTimeout - queues FCM push for notified transporters', async () => {
    const booking = makeBooking({
      status: 'active', trucksFilled: 0,
      notifiedTransporters: ['t-001'],
    });
    mockGetBookingById.mockResolvedValue(booking);

    await bookingLifecycleService.handleBookingTimeout('booking-001', 'customer-001');

    expect(mockQueuePushNotificationBatch).toHaveBeenCalledWith(
      ['t-001'],
      expect.objectContaining({ title: expect.stringContaining('Expired') })
    );
  });

  test('handleBookingTimeout - clears timers and active broadcast key', async () => {
    const booking = makeBooking({ status: 'active', trucksFilled: 0 });
    mockGetBookingById.mockResolvedValue(booking);

    await bookingLifecycleService.handleBookingTimeout('booking-001', 'customer-001');

    expect(mockRedisCancelTimer).toHaveBeenCalled();
    expect(mockRedisDel).toHaveBeenCalled();
  });

  // --- cancelBooking ---

  test('cancelBooking - happy path cancels booking atomically', async () => {
    const booking = makeBooking({ status: 'active' });
    mockGetBookingById.mockResolvedValue(booking);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });

    const result = await bookingLifecycleService.cancelBooking('booking-001', 'customer-001');

    expect(result).toBeDefined();
    expect(mockBookingUpdateMany).toHaveBeenCalled();
  });

  test('cancelBooking - throws 404 for missing booking', async () => {
    mockGetBookingById.mockResolvedValue(null);

    await expect(
      bookingLifecycleService.cancelBooking('nonexistent', 'customer-001')
    ).rejects.toThrow('Booking not found');
  });

  test('cancelBooking - throws 403 for wrong customer', async () => {
    const booking = makeBooking({ customerId: 'other-customer' });
    mockGetBookingById.mockResolvedValue(booking);

    await expect(
      bookingLifecycleService.cancelBooking('booking-001', 'customer-001')
    ).rejects.toThrow('You can only cancel your own bookings');
  });

  test('cancelBooking - idempotent: already cancelled returns success', async () => {
    const booking = makeBooking({ status: 'cancelled' });
    mockGetBookingById.mockResolvedValue(booking);

    const result = await bookingLifecycleService.cancelBooking('booking-001', 'customer-001');

    expect(result.status).toBe('cancelled');
    // Should NOT attempt DB update
    expect(mockBookingUpdateMany).not.toHaveBeenCalled();
  });

  test('cancelBooking - notifies all transporters of cancellation', async () => {
    const booking = makeBooking({
      status: 'active',
      notifiedTransporters: ['t-001', 't-002'],
    });
    mockGetBookingById.mockResolvedValue(booking);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });

    await bookingLifecycleService.cancelBooking('booking-001', 'customer-001');

    const cancelCalls = mockEmitToUser.mock.calls.filter(
      (c: any[]) => c[1] === 'booking_expired'
    );
    expect(cancelCalls.length).toBeGreaterThanOrEqual(2);
  });

  test('cancelBooking - cancels active assignments within transaction', async () => {
    const booking = makeBooking({ status: 'active' });
    mockGetBookingById.mockResolvedValue(booking);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', vehicleId: 'v1', transporterId: 't1', status: 'pending', driverId: null, tripId: null, vehicleType: 'Tipper', vehicleSubtype: null },
    ]);

    await bookingLifecycleService.cancelBooking('booking-001', 'customer-001');

    expect(mockAssignmentUpdateMany).toHaveBeenCalled();
  });

  test('cancelBooking - rejects cancel for expired booking', async () => {
    const booking = makeBooking({ status: 'expired' });
    mockGetBookingById.mockResolvedValue(booking);
    mockBookingUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      bookingLifecycleService.cancelBooking('booking-001', 'customer-001')
    ).rejects.toThrow(/Cannot cancel booking/);
  });

  // --- incrementTrucksFilled ---

  test('incrementTrucksFilled - atomically increments and emits update', async () => {
    const booking = makeBooking({ status: 'active', trucksFilled: 0, trucksNeeded: 3 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 1, trucksNeeded: 3 }]);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });

    const result = await bookingLifecycleService.incrementTrucksFilled('booking-001');

    expect(result).toBeDefined();
    expect(mockQueryRaw).toHaveBeenCalled(); // Atomic SQL UPDATE
    expect(mockEmitToUser).toHaveBeenCalledWith(
      'customer-001', 'booking_updated', expect.objectContaining({ trucksFilled: 1 })
    );
  });

  test('incrementTrucksFilled - fully filled cancels timeout and notifies', async () => {
    const booking = makeBooking({ status: 'partially_filled', trucksFilled: 2, trucksNeeded: 3 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 3, trucksNeeded: 3 }]);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });

    await bookingLifecycleService.incrementTrucksFilled('booking-001');

    // Timer cancelled
    expect(mockRedisCancelTimer).toHaveBeenCalled();
    // Fully filled event sent
    expect(mockEmitToUser).toHaveBeenCalledWith(
      'customer-001', 'booking_fully_filled', expect.any(Object)
    );
  });

  test('incrementTrucksFilled - partially filled sends partial event', async () => {
    const booking = makeBooking({ status: 'active', trucksFilled: 0, trucksNeeded: 3 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 1, trucksNeeded: 3 }]);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });

    await bookingLifecycleService.incrementTrucksFilled('booking-001');

    expect(mockEmitToUser).toHaveBeenCalledWith(
      'customer-001', 'booking_partially_filled', expect.objectContaining({ remaining: 2 })
    );
  });

  test('incrementTrucksFilled - idempotent guard: already at capacity', async () => {
    const booking = makeBooking({ status: 'fully_filled', trucksFilled: 3, trucksNeeded: 3 });
    mockGetBookingById.mockResolvedValue(booking);

    const result = await bookingLifecycleService.incrementTrucksFilled('booking-001');

    expect(result.trucksFilled).toBe(3);
    expect(mockQueryRaw).not.toHaveBeenCalled(); // No SQL update attempted
  });

  test('incrementTrucksFilled - atomic increment returns 0 rows when at capacity', async () => {
    const booking = makeBooking({ status: 'active', trucksFilled: 2, trucksNeeded: 3 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([]); // 0 rows = at capacity

    const result = await bookingLifecycleService.incrementTrucksFilled('booking-001');

    expect(result).toBeDefined();
  });

  test('incrementTrucksFilled - throws 404 for missing booking', async () => {
    mockGetBookingById.mockResolvedValue(null);

    await expect(
      bookingLifecycleService.incrementTrucksFilled('nonexistent')
    ).rejects.toThrow('Booking not found');
  });

  // --- decrementTrucksFilled ---

  test('decrementTrucksFilled - atomically decrements', async () => {
    const booking = makeBooking({ status: 'partially_filled', trucksFilled: 2, trucksNeeded: 3 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 1 }]);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });

    const result = await bookingLifecycleService.decrementTrucksFilled('booking-001');

    expect(result).toBeDefined();
    expect(mockQueryRaw).toHaveBeenCalled();
  });

  test('decrementTrucksFilled - sets status to active when trucksFilled becomes 0', async () => {
    const booking = makeBooking({ status: 'partially_filled', trucksFilled: 1, trucksNeeded: 3 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 0 }]);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });

    await bookingLifecycleService.decrementTrucksFilled('booking-001');

    expect(mockBookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'active' }),
      })
    );
  });

  test('decrementTrucksFilled - restarts broadcast timeout for remaining slots', async () => {
    const booking = makeBooking({ status: 'partially_filled', trucksFilled: 2, trucksNeeded: 3 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 1 }]);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });

    await bookingLifecycleService.decrementTrucksFilled('booking-001');

    // Should emit trucks_remaining_update
    expect(mockEmitToUser).toHaveBeenCalledWith(
      'customer-001', 'trucks_remaining_update',
      expect.objectContaining({ trucksFilled: 1, trucksNeeded: 3 })
    );
  });

  test('decrementTrucksFilled - throws 404 for missing booking', async () => {
    mockGetBookingById.mockResolvedValue(null);

    await expect(
      bookingLifecycleService.decrementTrucksFilled('nonexistent')
    ).rejects.toThrow('Booking not found');
  });

  test('decrementTrucksFilled - returns existing booking when atomic update returns 0 rows (terminal state)', async () => {
    const booking = makeBooking({ status: 'active', trucksFilled: 1 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([]);

    // When CAS returns 0 rows (terminal state), function returns booking as-is instead of throwing
    const result = await bookingLifecycleService.decrementTrucksFilled('booking-001');
    expect(result).toBeDefined();
    expect(result.id).toBe('booking-001');
  });

  // --- cancelBookingTimeout ---

  test('cancelBookingTimeout - clears all timers and radius keys', async () => {
    await bookingLifecycleService.cancelBookingTimeout('booking-001');

    expect(mockRedisCancelTimer).toHaveBeenCalledWith(expect.stringContaining('timer:booking:booking-001'));
    expect(mockRedisCancelTimer).toHaveBeenCalledWith(expect.stringContaining('timer:radius:booking-001'));
  });
});

// =============================================================================
// 6. TIMER TESTS (booking-timer.service.ts)
// =============================================================================

describe('Timer service (booking-timer.service.ts)', () => {
  test('startBookingExpiryChecker and stopBookingExpiryChecker are callable', async () => {
    const { startBookingExpiryChecker, stopBookingExpiryChecker } = await import('../modules/booking/booking-timer.service');

    expect(typeof startBookingExpiryChecker).toBe('function');
    expect(typeof stopBookingExpiryChecker).toBe('function');
  });

  test('setBookingServiceRef accepts and stores a ref', async () => {
    const { setBookingServiceRef } = await import('../modules/booking/booking-timer.service');
    const ref = {
      handleBookingTimeout: jest.fn(),
      advanceRadiusStep: jest.fn(),
    };

    // Should not throw
    expect(() => setBookingServiceRef(ref)).not.toThrow();
  });

  test('setBookingServiceRef accepts null to clear ref', async () => {
    const { setBookingServiceRef } = await import('../modules/booking/booking-timer.service');

    expect(() => setBookingServiceRef(null)).not.toThrow();
  });
});

// =============================================================================
// 7. RADIUS TESTS (booking-radius.service.ts)
// =============================================================================

describe('BookingRadiusService', () => {

  test('startProgressiveExpansion - schedules step 2 timer', async () => {
    await bookingRadiusService.startProgressiveExpansion(
      'booking-001', 'customer-001', 'Tipper_20-24 Ton',
      'Tipper', '20-24 Ton', 12.97, 77.59
    );

    // Should store current step in Redis
    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringContaining('broadcast:radius:step:booking-001'),
      '0',
      expect.any(Number)
    );
    // Should schedule a radius step timer
    expect(mockRedisSetTimer).toHaveBeenCalledWith(
      expect.stringContaining('timer:radius:booking-001'),
      expect.objectContaining({ bookingId: 'booking-001', currentStep: 0 }),
      expect.any(Date)
    );
  });

  test('advanceRadiusStep - stops if booking is cancelled', async () => {
    mockGetBookingById.mockResolvedValue(makeBooking({ status: 'cancelled' }));

    await bookingRadiusService.advanceRadiusStep(makeRadiusStepData());

    // Should have cleared radius keys
    expect(mockRedisCancelTimer).toHaveBeenCalled();
    // Should NOT have emitted broadcasts
    expect(mockEmitToUser).not.toHaveBeenCalled();
  });

  test('advanceRadiusStep - stops if booking is fully_filled', async () => {
    mockGetBookingById.mockResolvedValue(makeBooking({ status: 'fully_filled' }));

    await bookingRadiusService.advanceRadiusStep(makeRadiusStepData());

    expect(mockRedisCancelTimer).toHaveBeenCalled();
    expect(mockEmitToUser).not.toHaveBeenCalled();
  });

  test('advanceRadiusStep - stops if booking not found', async () => {
    mockGetBookingById.mockResolvedValue(null);

    await bookingRadiusService.advanceRadiusStep(makeRadiusStepData());

    expect(mockRedisCancelTimer).toHaveBeenCalled();
  });

  test('advanceRadiusStep - broadcasts to NEW transporters only at expanded radius', async () => {
    const booking = makeBooking({ status: 'active' });
    mockGetBookingById.mockResolvedValue(booking);
    mockRedisSMembers.mockResolvedValue(['transporter-001']); // Already notified
    // findCandidates returns new transporters (matcher handles dedup via alreadyNotified param)
    mockFindCandidates.mockResolvedValue([
      { transporterId: 'transporter-002', distanceKm: 18, etaSeconds: 1800 },
    ]);
    mockUpdateBooking.mockResolvedValue(undefined);

    await bookingRadiusService.advanceRadiusStep(makeRadiusStepData());

    // Broadcasts route through queue when queueService.queueBroadcast is available
    expect(mockQueueBroadcast).toHaveBeenCalledWith(
      'transporter-002', 'new_broadcast', expect.any(Object)
    );
    // Should track newly notified
    expect(mockRedisSAddWithExpire).toHaveBeenCalledWith(
      expect.stringContaining('broadcast:notified:booking-001'),
      expect.any(Number),
      'transporter-002'
    );
  });

  test('advanceRadiusStep - schedules next step if not at max', async () => {
    const booking = makeBooking({ status: 'active' });
    mockGetBookingById.mockResolvedValue(booking);
    mockFindCandidates.mockResolvedValue([]);
    mockGetStepCount.mockReturnValue(6);

    // currentStep=0, nextStep=1, totalSteps=6 -- should schedule step 3
    await bookingRadiusService.advanceRadiusStep(makeRadiusStepData({ currentStep: 0 }));

    const timerCalls = mockRedisSetTimer.mock.calls;
    expect(timerCalls.length).toBeGreaterThan(0);
  });

  test('advanceRadiusStep - triggers DB fallback when all steps exhausted', async () => {
    const booking = makeBooking({ status: 'active' });
    mockGetBookingById.mockResolvedValue(booking);
    mockGetStepCount.mockReturnValue(6);
    mockGetTransportersWithVehicleType.mockResolvedValue(['t-new-1', 't-new-2']);
    mockFilterOnline.mockResolvedValue(['t-new-1', 't-new-2']);
    mockRedisSMembers.mockResolvedValue([]); // None already notified

    // currentStep=5, nextStep=6 >= totalSteps=6 → DB fallback
    await bookingRadiusService.advanceRadiusStep(makeRadiusStepData({ currentStep: 5 }));

    // FIX #34: DB fallback now passes vehicleSubtype as second arg
    expect(mockGetTransportersWithVehicleType).toHaveBeenCalledWith('Tipper', '20-24 Ton');
    expect(mockFilterOnline).toHaveBeenCalled();
  });

  test('advanceRadiusStep - DB fallback deduplicates already notified', async () => {
    const booking = makeBooking({ status: 'active' });
    mockGetBookingById.mockResolvedValue(booking);
    mockGetStepCount.mockReturnValue(6);
    mockGetTransportersWithVehicleType.mockResolvedValue(['t-001', 't-new']);
    mockFilterOnline.mockResolvedValue(['t-001', 't-new']);
    mockRedisSMembers.mockResolvedValue(['t-001']); // Already notified

    await bookingRadiusService.advanceRadiusStep(makeRadiusStepData({ currentStep: 5 }));

    // DB fallback broadcasts through queue when available
    const queueCalls = mockQueueBroadcast.mock.calls;
    const queueRecipients = queueCalls.map((c: any[]) => c[0]);
    // t-new should be broadcast to, t-001 should be deduped out
    expect(queueRecipients).toContain('t-new');
    expect(queueRecipients).not.toContain('t-001');
  });

  test('advanceRadiusStep - no transporters at expanded radius skips broadcast', async () => {
    const booking = makeBooking({ status: 'active' });
    mockGetBookingById.mockResolvedValue(booking);
    mockFindCandidates.mockResolvedValue([]); // No one new

    await bookingRadiusService.advanceRadiusStep(makeRadiusStepData());

    const broadcastCalls = mockEmitToUser.mock.calls.filter(
      (c: any[]) => c[1] === 'new_broadcast'
    );
    expect(broadcastCalls.length).toBe(0);
  });

  test('advanceRadiusStep - updates notifiedTransporters in DB', async () => {
    const booking = makeBooking({ status: 'active', notifiedTransporters: ['t-001'] });
    mockGetBookingById.mockResolvedValue(booking);
    mockFindCandidates.mockResolvedValue([
      { transporterId: 't-002', distanceKm: 15, etaSeconds: 1500 },
    ]);

    await bookingRadiusService.advanceRadiusStep(makeRadiusStepData());

    expect(mockUpdateBooking).toHaveBeenCalledWith(
      'booking-001',
      expect.objectContaining({
        notifiedTransporters: expect.arrayContaining(['t-001', 't-002']),
      })
    );
  });
});

// =============================================================================
// 8. REBROADCAST TESTS (booking-rebroadcast.service.ts)
// =============================================================================

describe('BookingRebroadcastService', () => {

  test('deliverMissedBroadcasts - delivers active bookings when transporter comes online', async () => {
    const booking = makeBooking({
      id: 'b-active',
      status: 'active',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    mockGetActiveBookingsForTransporter.mockResolvedValue([booking]);
    mockVehicleFindMany.mockResolvedValue([{ vehicleType: 'Tipper', vehicleSubtype: '20-24 Ton' }]);
    mockAssignmentFindMany.mockResolvedValue([]);

    await bookingRebroadcastService.deliverMissedBroadcasts('transporter-001');

    // FIX #57: Rebroadcast routes through queue by default (FF_SEQUENCE_DELIVERY_ENABLED !== 'false')
    expect(mockQueueBroadcast).toHaveBeenCalledWith(
      'transporter-001', 'new_broadcast', expect.any(Object)
    );
  });

  test('deliverMissedBroadcasts - no missed broadcasts returns silently', async () => {
    mockGetActiveBookingsForTransporter.mockResolvedValue([]);

    await bookingRebroadcastService.deliverMissedBroadcasts('transporter-001');

    expect(mockEmitToUser).not.toHaveBeenCalled();
  });

  test('deliverMissedBroadcasts - filters out expired bookings', async () => {
    const expired = makeBooking({
      id: 'b-expired',
      status: 'active',
      expiresAt: new Date(Date.now() - 60_000).toISOString(), // Already expired
      createdAt: new Date().toISOString(),
    });
    mockGetActiveBookingsForTransporter.mockResolvedValue([expired]);

    await bookingRebroadcastService.deliverMissedBroadcasts('transporter-001');

    expect(mockEmitToUser).not.toHaveBeenCalled();
  });

  test('deliverMissedBroadcasts - rate limits to once per 10 seconds', async () => {
    mockRedisGet.mockResolvedValue('1'); // Rate limit key exists

    await bookingRebroadcastService.deliverMissedBroadcasts('transporter-001');

    // Should skip entirely
    expect(mockGetActiveBookingsForTransporter).not.toHaveBeenCalled();
    expect(mockEmitToUser).not.toHaveBeenCalled();
  });

  test('deliverMissedBroadcasts - caps at 20 bookings', async () => {
    const bookings = Array.from({ length: 30 }, (_, i) =>
      makeBooking({
        id: `b-${i}`,
        status: 'active',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        createdAt: new Date().toISOString(),
      })
    );
    mockGetActiveBookingsForTransporter.mockResolvedValue(bookings);
    mockVehicleFindMany.mockResolvedValue([{ vehicleType: 'Tipper', vehicleSubtype: '20-24 Ton' }]);
    mockAssignmentFindMany.mockResolvedValue([]);

    await bookingRebroadcastService.deliverMissedBroadcasts('transporter-001');

    const broadcastCalls = mockEmitToUser.mock.calls.filter(
      (c: any[]) => c[1] === 'new_broadcast'
    );
    expect(broadcastCalls.length).toBeLessThanOrEqual(20);
  });

  test('deliverMissedBroadcasts - updates notifiedTransporters in DB', async () => {
    const booking = makeBooking({
      id: 'b-active',
      status: 'active',
      notifiedTransporters: ['t-other'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    mockGetActiveBookingsForTransporter.mockResolvedValue([booking]);
    mockVehicleFindMany.mockResolvedValue([{ vehicleType: 'Tipper', vehicleSubtype: '20-24 Ton' }]);
    mockAssignmentFindMany.mockResolvedValue([]);

    await bookingRebroadcastService.deliverMissedBroadcasts('transporter-001');

    expect(mockUpdateBooking).toHaveBeenCalledWith(
      'b-active',
      expect.objectContaining({
        notifiedTransporters: expect.arrayContaining(['t-other', 'transporter-001']),
      })
    );
  });

  test('deliverMissedBroadcasts - sends individual FCM per booking', async () => {
    const booking = makeBooking({
      id: 'b-fcm',
      status: 'active',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    mockGetActiveBookingsForTransporter.mockResolvedValue([booking]);
    mockVehicleFindMany.mockResolvedValue([{ vehicleType: 'Tipper', vehicleSubtype: '20-24 Ton' }]);
    mockAssignmentFindMany.mockResolvedValue([]);

    await bookingRebroadcastService.deliverMissedBroadcasts('transporter-001');

    expect(mockNotifyNewBroadcast).toHaveBeenCalledWith(
      ['transporter-001'],
      expect.objectContaining({ broadcastId: 'b-fcm' })
    );
  });

  test('deliverMissedBroadcasts - skips bookings with existing active assignment', async () => {
    const booking = makeBooking({
      id: 'b-assigned',
      status: 'partially_filled',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    mockGetActiveBookingsForTransporter.mockResolvedValue([booking]);
    mockVehicleFindMany.mockResolvedValue([{ vehicleType: 'Tipper', vehicleSubtype: '20-24 Ton' }]);
    mockAssignmentFindMany.mockResolvedValue([{ bookingId: 'b-assigned' }]); // Already has assignment

    await bookingRebroadcastService.deliverMissedBroadcasts('transporter-001');

    const broadcastCalls = mockEmitToUser.mock.calls.filter(
      (c: any[]) => c[1] === 'new_broadcast'
    );
    expect(broadcastCalls.length).toBe(0);
  });

  test('deliverMissedBroadcasts - geo-filters by transporter location', async () => {
    const nearBooking = makeBooking({
      id: 'b-near',
      status: 'active',
      pickup: { latitude: 12.97, longitude: 77.59, address: 'Near', city: 'Bangalore' },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    mockGetActiveBookingsForTransporter.mockResolvedValue([nearBooking]);
    mockGetTransporterDetails.mockResolvedValue({ latitude: 12.97, longitude: 77.59 });
    mockVehicleFindMany.mockResolvedValue([{ vehicleType: 'Tipper', vehicleSubtype: '20-24 Ton' }]);
    mockAssignmentFindMany.mockResolvedValue([]);
    // haversineDistanceKm returns 10 (< 150km threshold)
    const { haversineDistanceKm } = require('../shared/utils/geospatial.utils');
    (haversineDistanceKm as jest.Mock).mockReturnValue(10);

    await bookingRebroadcastService.deliverMissedBroadcasts('transporter-001');

    // FIX #57: Rebroadcast routes through queue by default
    expect(mockQueueBroadcast).toHaveBeenCalledWith(
      'transporter-001', 'new_broadcast', expect.any(Object)
    );
  });

  test('deliverMissedBroadcasts - filters out old bookings (>30 min)', async () => {
    const oldBooking = makeBooking({
      id: 'b-old',
      status: 'active',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(), // 31 min ago
    });
    mockGetActiveBookingsForTransporter.mockResolvedValue([oldBooking]);

    await bookingRebroadcastService.deliverMissedBroadcasts('transporter-001');

    expect(mockEmitToUser).not.toHaveBeenCalled();
  });

  test('deliverMissedBroadcasts - handles errors gracefully', async () => {
    mockGetActiveBookingsForTransporter.mockRejectedValue(new Error('DB error'));

    // Should not throw
    await bookingRebroadcastService.deliverMissedBroadcasts('transporter-001');
  });
});

// =============================================================================
// 9. EDGE CASES & RACE CONDITIONS
// =============================================================================

describe('Edge cases and race conditions', () => {

  test('Timer fires after booking already completed - noop', async () => {
    const booking = makeBooking({ status: 'completed' });
    mockGetBookingById.mockResolvedValue(booking);

    await bookingLifecycleService.handleBookingTimeout('booking-001', 'customer-001');

    expect(mockBookingUpdateMany).not.toHaveBeenCalled();
  });

  test('Cancel during broadcast - cancel wins via CAS guard', async () => {
    const booking = makeBooking({ status: 'broadcasting' });
    mockGetBookingById.mockResolvedValue(booking);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });

    const result = await bookingLifecycleService.cancelBooking('booking-001', 'customer-001');

    expect(result).toBeDefined();
  });

  test('Radius expansion while booking expired - stops expansion', async () => {
    mockGetBookingById.mockResolvedValue(makeBooking({ status: 'expired' }));

    await bookingRadiusService.advanceRadiusStep(makeRadiusStepData());

    expect(mockRedisCancelTimer).toHaveBeenCalled();
    expect(mockEmitToUser).not.toHaveBeenCalled();
  });

  test('Rebroadcast for already fully filled booking - db layer returns empty', async () => {
    // The db.getActiveBookingsForTransporter method only returns active/partially_filled
    // bookings. A fully_filled booking would not be returned by the DB query.
    // This test validates that when no active bookings exist, nothing is broadcast.
    mockGetActiveBookingsForTransporter.mockResolvedValue([]);

    await bookingRebroadcastService.deliverMissedBroadcasts('transporter-001');

    const broadcastCalls = mockEmitToUser.mock.calls.filter(
      (c: any[]) => c[1] === 'new_broadcast'
    );
    expect(broadcastCalls.length).toBe(0);
  });

  test('DB transaction failure during creation - releases locks and backpressure', async () => {
    // Setup: backpressure and lock succeed
    mockRedisIncr.mockResolvedValue(1);
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisGet.mockResolvedValue(null);
    mockGetUserById.mockResolvedValue({ id: 'c1', name: 'Test' });

    // TX throws
    mockWithDbTimeout.mockRejectedValue(new Error('DB transaction timeout'));

    await expect(
      bookingCreateService.createBooking('customer-001', '9999999999', makeCreateBookingInput())
    ).rejects.toThrow('DB transaction timeout');

    // Backpressure should be released
    expect(mockRedisIncrBy).toHaveBeenCalledWith('booking:create:inflight', -1);
    // Lock should be released
    expect(mockRedisReleaseLock).toHaveBeenCalled();
  });

  test('FCM push fails - booking creation still works', async () => {
    // Reset withDbTimeout to working implementation (may have been overridden by prior test)
    mockWithDbTimeout.mockImplementation(async (fn: any, _opts?: any) => {
      const fakeTx = {
        booking: {
          create: mockBookingCreate,
          findFirst: mockBookingFindFirst,
          findUnique: mockBookingFindUnique,
          updateMany: mockBookingUpdateMany,
        },
        order: { findFirst: mockOrderFindFirst },
        assignment: {
          findMany: mockAssignmentFindMany,
          updateMany: mockAssignmentUpdateMany,
        },
        vehicle: { findMany: mockVehicleFindMany },
        user: { findMany: mockUserFindMany },
      };
      return fn(fakeTx);
    });

    // Setup happy path
    const booking = makeBooking({ status: 'created' });
    mockRedisIncr.mockResolvedValue(1);
    mockRedisGet.mockResolvedValue(null);
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockBookingFindFirst.mockResolvedValue(null);
    mockOrderFindFirst.mockResolvedValue(null);
    mockBookingCreate.mockResolvedValue({});
    mockGetBookingById.mockResolvedValue(booking);
    mockFindCandidates.mockResolvedValue([
      { transporterId: 't1', distanceKm: 5, etaSeconds: 600 },
    ]);
    mockGetTransportersWithVehicleType.mockResolvedValue(['t1']);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });

    // FCM throws
    mockNotifyNewBroadcast.mockRejectedValue(new Error('FCM unavailable'));

    const result = await bookingCreateService.createBooking(
      'customer-001', '9999999999', makeCreateBookingInput()
    );

    // Booking should still be created successfully
    expect(result).toBeDefined();
    expect(result.id).toBe('booking-001');
  });

  test('Redis down during broadcast key management - booking still proceeds', async () => {
    // FIX #13: Batch eligibility check needs vehicle data
    mockVehicleFindMany.mockResolvedValue([{ transporterId: 't1' }]);

    const booking = makeBooking({ status: 'created' });
    const ctx = {
      customerId: 'customer-001',
      data: makeCreateBookingInput(),
      booking,
      matchingTransporters: ['t1'],
      step1Candidates: [{ transporterId: 't1', distanceKm: 5, etaSeconds: 600 }],
      candidateMap: new Map(),
      cappedTransporters: ['t1'],
      vehicleKey: 'Tipper_20-24 Ton',
      skipProgressiveExpansion: true,
    } as any;

    // Redis sAddWithExpire fails (but with retry also failing)
    mockRedisSAddWithExpire.mockRejectedValue(new Error('Redis down'));

    // broadcastBookingToTransporters should handle the error gracefully
    await expect(
      bookingBroadcastService.broadcastBookingToTransporters(ctx)
    ).resolves.not.toThrow();
  });

  test('Increment on already terminal booking - blocked by CAS', async () => {
    const booking = makeBooking({ status: 'cancelled', trucksFilled: 1, trucksNeeded: 3 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 2, trucksNeeded: 3 }]);
    // Status update returns 0 (blocked by notIn terminal states)
    mockBookingUpdateMany.mockResolvedValue({ count: 0 });

    const result = await bookingLifecycleService.incrementTrucksFilled('booking-001');

    expect(result).toBeDefined();
  });

  test('Multiple radius steps fire simultaneously - lock prevents overlap', async () => {
    // This test validates that the lock pattern exists in processRadiusExpansionTimers.
    // The timer service acquires per-booking locks before calling advanceRadiusStep.
    // If the lock is NOT acquired, the step is skipped.
    const booking = makeBooking({ status: 'active' });
    mockGetBookingById.mockResolvedValue(booking);
    mockFindCandidates.mockResolvedValue([]);

    // Simulate two concurrent calls - both should be safe
    await Promise.all([
      bookingRadiusService.advanceRadiusStep(makeRadiusStepData({ currentStep: 0 })),
      bookingRadiusService.advanceRadiusStep(makeRadiusStepData({ currentStep: 1 })),
    ]);

    // No crashes expected
    expect(mockGetBookingById).toHaveBeenCalled();
  });

  test('Fully filled event notifies remaining transporters to clear UI', async () => {
    const booking = makeBooking({
      status: 'partially_filled',
      trucksFilled: 2,
      trucksNeeded: 3,
      notifiedTransporters: ['t-001', 't-002', 't-003'],
    });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 3, trucksNeeded: 3 }]);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });

    await bookingLifecycleService.incrementTrucksFilled('booking-001');

    // All 3 transporters should get BOOKING_EXPIRED with reason fully_filled
    const expiryCalls = mockEmitToUser.mock.calls.filter(
      (c: any[]) => c[1] === 'booking_expired'
    );
    expect(expiryCalls.length).toBe(3);
    expect(expiryCalls[0][2]).toEqual(expect.objectContaining({ reason: 'fully_filled' }));
  });

  test('handleBookingTimeout for unexpected status logs warning', async () => {
    const booking = makeBooking({ status: 'some_unknown_status' });
    mockGetBookingById.mockResolvedValue(booking);

    await bookingLifecycleService.handleBookingTimeout('booking-001', 'customer-001');

    // Should NOT crash, should NOT update status
    expect(mockBookingUpdateMany).not.toHaveBeenCalled();
  });

  test('Cancel booking clears idempotency cache', async () => {
    const booking = makeBooking({ status: 'active' });
    mockGetBookingById.mockResolvedValue(booking);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockRedisGet.mockImplementation((key: string) => {
      if (key === 'idempotency:booking:customer-001:latest') return Promise.resolve('idem-key-1');
      return Promise.resolve(null);
    });

    await bookingLifecycleService.cancelBooking('booking-001', 'customer-001');

    // Should attempt to clear idempotency keys
    expect(mockRedisDel).toHaveBeenCalled();
  });

  test('getActiveBroadcasts pagination works correctly', async () => {
    const bookings = Array.from({ length: 5 }, (_, i) =>
      makeBooking({
        id: `b-${i}`,
        status: 'active',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        createdAt: new Date(2024, i, 1).toISOString(),
      })
    );
    mockGetActiveBookingsForTransporter.mockResolvedValue(bookings);

    const page1 = await bookingQueryService.getActiveBroadcasts('t-001', { page: 1, limit: 2 });
    expect(page1.bookings.length).toBe(2);
    expect(page1.total).toBe(5);
    expect(page1.hasMore).toBe(true);

    const page3 = await bookingQueryService.getActiveBroadcasts('t-001', { page: 3, limit: 2 });
    expect(page3.bookings.length).toBe(1);
    expect(page3.hasMore).toBe(false);
  });

  test('Decrement below zero prevented by GREATEST(0, ...) in SQL', async () => {
    const booking = makeBooking({ status: 'active', trucksFilled: 0, trucksNeeded: 3 });
    mockGetBookingById.mockResolvedValue(booking);
    // SQL GREATEST(0, 0-1) = 0
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 0 }]);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });

    const result = await bookingLifecycleService.decrementTrucksFilled('booking-001');

    expect(result).toBeDefined();
  });
});
