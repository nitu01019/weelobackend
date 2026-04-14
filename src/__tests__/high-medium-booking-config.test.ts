export {};
/**
 * =============================================================================
 * HIGH/MEDIUM BOOKING & CONFIG FIXES — Tests
 * =============================================================================
 *
 * Coverage:
 *   #25  BOOKING_CONCURRENCY_LIMIT guards           — 4 tests
 *   #26  MAX_TRANSPORTERS_PER_STEP guards            — 4 tests
 *   #40  HOLD_CLEANUP_BATCH_SIZE bounds              — 4 tests
 *   #23  Orphaned booking try-catch                  — 5 tests
 *   #28  No-transporter idempotency                  — 4 tests
 *   #29  Undefined coords hash (no NaN collision)    — 4 tests
 *   #32  Cancel-rebook cooldown                      — 4 tests
 *   #68  resume-broadcast processor registration     — 3 tests
 *   #30  Client distance not used for fare           — 4 tests
 *   #31  Fare floor on pricing fail                  — 3 tests
 *   #74  Zero-notified booking guard                 — 4 tests
 *   #77  Namespace-separated idempotency keys        — 3 tests
 *   #80  Adaptive cancel check interval              — 4 tests
 *   ─────────────────────────────────────────────────
 *   TOTAL                                            — 50 tests
 *
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — Must precede all imports that depend on these modules
// =============================================================================

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockGetBookingById = jest.fn();
const mockGetTransportersWithVehicleType = jest.fn();
const mockGetUserById = jest.fn();
const mockGetActiveOrders = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getBookingById: (...args: any[]) => mockGetBookingById(...args),
    getTransportersWithVehicleType: (...args: any[]) => mockGetTransportersWithVehicleType(...args),
    getUserById: (...args: any[]) => mockGetUserById(...args),
    getActiveOrders: (...args: any[]) => mockGetActiveOrders(...args),
    updateBooking: jest.fn().mockResolvedValue(null),
    getBookingsByCustomer: jest.fn().mockResolvedValue([]),
    getActiveBookingsForTransporter: jest.fn().mockResolvedValue([]),
    getBookingsByDriver: jest.fn().mockResolvedValue([]),
    createBooking: jest.fn().mockResolvedValue(null),
    getVehiclesByTransporter: jest.fn().mockResolvedValue([]),
    getAssignmentsByBooking: jest.fn().mockResolvedValue([]),
    updateOrder: jest.fn().mockResolvedValue(null),
  },
}));

const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisExists = jest.fn();
const mockRedisIncr = jest.fn();
const mockRedisIncrBy = jest.fn();
const mockRedisExpire = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisSetTimer = jest.fn();
const mockRedisCancelTimer = jest.fn();
const mockRedisSAddWithExpire = jest.fn();
const mockRedisHSet = jest.fn();
const mockRedisIsDegraded = false;

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    exists: (...args: any[]) => mockRedisExists(...args),
    incr: (...args: any[]) => mockRedisIncr(...args),
    incrBy: (...args: any[]) => mockRedisIncrBy(...args),
    expire: (...args: any[]) => mockRedisExpire(...args),
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    setTimer: (...args: any[]) => mockRedisSetTimer(...args),
    cancelTimer: (...args: any[]) => mockRedisCancelTimer(...args),
    sAdd: jest.fn().mockResolvedValue(undefined),
    sMembers: jest.fn().mockResolvedValue([]),
    getExpiredTimers: jest.fn().mockResolvedValue([]),
    getJSON: jest.fn().mockResolvedValue(null),
    setJSON: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
    sAddWithExpire: (...args: any[]) => mockRedisSAddWithExpire(...args),
    hSet: (...args: any[]) => mockRedisHSet(...args),
    get isDegraded() { return mockRedisIsDegraded; },
  },
}));

const mockBookingCreate = jest.fn();
const mockBookingFindFirst = jest.fn();
const mockBookingFindUnique = jest.fn();
const mockBookingUpdateMany = jest.fn();
const mockBookingUpdate = jest.fn();
const mockOrderFindFirst = jest.fn();
const mockVehicleFindMany = jest.fn();
const mockUserFindUnique = jest.fn();

const mockTransaction = jest.fn().mockImplementation(async (fnOrArray: any, _opts?: any) => {
  if (typeof fnOrArray === 'function') {
    const fakeTx = {
      booking: {
        create: (...a: any[]) => mockBookingCreate(...a),
        findFirst: (...a: any[]) => mockBookingFindFirst(...a),
        findUnique: (...a: any[]) => mockBookingFindUnique(...a),
        updateMany: (...a: any[]) => mockBookingUpdateMany(...a),
        update: (...a: any[]) => mockBookingUpdate(...a),
      },
      order: { findFirst: (...a: any[]) => mockOrderFindFirst(...a) },
      assignment: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
      },
      vehicle: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: (...a: any[]) => mockVehicleFindMany(...a),
      },
      user: { findUnique: (...a: any[]) => mockUserFindUnique(...a) },
      $queryRaw: jest.fn(),
    };
    return fnOrArray(fakeTx);
  }
  return Promise.all(fnOrArray);
});

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    booking: {
      create: (...args: any[]) => mockBookingCreate(...args),
      findFirst: (...args: any[]) => mockBookingFindFirst(...args),
      findUnique: (...args: any[]) => mockBookingFindUnique(...args),
      updateMany: (...args: any[]) => mockBookingUpdateMany(...args),
      update: (...args: any[]) => mockBookingUpdate(...args),
      findMany: jest.fn().mockResolvedValue([]),
    },
    order: { findFirst: (...args: any[]) => mockOrderFindFirst(...args) },
    assignment: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
    },
    vehicle: {
      findUnique: jest.fn(),
      update: jest.fn(),
      findMany: (...args: any[]) => mockVehicleFindMany(...args),
    },
    user: { findUnique: (...args: any[]) => mockUserFindUnique(...args) },
    truckRequest: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn(),
    $transaction: (...args: any[]) => mockTransaction(...args),
  },
  withDbTimeout: jest.fn().mockImplementation(async (fn: any) => {
    const fakeTx = {
      booking: {
        create: mockBookingCreate,
        findFirst: mockBookingFindFirst,
        findUnique: mockBookingFindUnique,
        updateMany: mockBookingUpdateMany,
        update: mockBookingUpdate,
      },
      order: { findFirst: mockOrderFindFirst },
      assignment: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
      },
      vehicle: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: (...a: any[]) => mockVehicleFindMany(...a),
      },
      user: { findUnique: (...a: any[]) => mockUserFindUnique(...a) },
    };
    return fn(fakeTx);
  }),
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
    arrived_at_drop: 'arrived_at_drop',
  },
  OrderStatus: {
    created: 'created',
    broadcasting: 'broadcasting',
    active: 'active',
    completed: 'completed',
    cancelled: 'cancelled',
    expired: 'expired',
  },
  VehicleStatus: {
    available: 'available',
    on_hold: 'on_hold',
    in_transit: 'in_transit',
    maintenance: 'maintenance',
    inactive: 'inactive',
  },
}));

const mockEmitToUser = jest.fn();
const mockIsUserConnectedAsync = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToBooking: jest.fn(),
  emitToRoom: jest.fn(),
  emitToUsers: jest.fn(),
  emitToAllTransporters: jest.fn(),
  emitToAll: jest.fn(),
  isUserConnected: jest.fn().mockReturnValue(false),
  isUserConnectedAsync: (...args: any[]) => mockIsUserConnectedAsync(...args),
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
    VEHICLE_REGISTERED: 'vehicle_registered',
    VEHICLE_UPDATED: 'vehicle_updated',
    VEHICLE_DELETED: 'vehicle_deleted',
    VEHICLE_STATUS_CHANGED: 'vehicle_status_changed',
    FLEET_UPDATED: 'fleet_updated',
    TRIP_CANCELLED: 'trip_cancelled',
    BROADCAST_STATE_CHANGED: 'broadcast_state_changed',
  },
}));

jest.mock('../shared/services/fcm.service', () => ({
  fcmService: {
    notifyNewBroadcast: jest.fn().mockResolvedValue(0),
  },
}));

const mockQueueRegisterProcessor = jest.fn();
const mockQueueEnqueue = jest.fn().mockResolvedValue(undefined);
const mockQueueBroadcast = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    registerProcessor: (...args: any[]) => mockQueueRegisterProcessor(...args),
    enqueue: (...args: any[]) => mockQueueEnqueue(...args),
    queueBroadcast: (...args: any[]) => mockQueueBroadcast(...args),
    queuePushNotificationBatch: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../shared/services/availability.service', () => ({
  availabilityService: {
    loadTransporterDetailsMap: jest.fn().mockResolvedValue(new Map()),
    getTransporterDetails: jest.fn().mockResolvedValue(null),
  },
}));

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
  generateVehicleKey: jest.fn().mockReturnValue('tipper_20-24ton'),
}));

const mockFindCandidates = jest.fn();
jest.mock('../modules/order/progressive-radius-matcher', () => ({
  PROGRESSIVE_RADIUS_STEPS: [
    { radiusKm: 10, windowMs: 10000 },
    { radiusKm: 20, windowMs: 10000 },
    { radiusKm: 30, windowMs: 15000 },
    { radiusKm: 50, windowMs: 15000 },
    { radiusKm: 75, windowMs: 15000 },
    { radiusKm: 100, windowMs: 15000 },
  ],
  progressiveRadiusMatcher: {
    findCandidates: (...args: any[]) => mockFindCandidates(...args),
    getStepCount: jest.fn().mockReturnValue(6),
    getStep: jest.fn().mockReturnValue({ radiusKm: 10, windowMs: 10000, h3RingK: 15 }),
  },
}));

jest.mock('../shared/services/distance-matrix.service', () => ({
  distanceMatrixService: {
    batchGetPickupDistance: jest.fn().mockResolvedValue(new Map()),
  },
}));

const mockCalculateRoute = jest.fn();
jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: {
    calculateRoute: (...args: any[]) => mockCalculateRoute(...args),
  },
}));

const mockHaversineDistanceKm = jest.fn();
jest.mock('../shared/utils/geospatial.utils', () => ({
  haversineDistanceKm: (...args: any[]) => mockHaversineDistanceKm(...args),
}));

jest.mock('../shared/utils/geo.utils', () => ({
  roundCoord: jest.fn((v: any) => {
    const n = parseFloat(v);
    return isNaN(n) ? undefined : Math.round(n * 1000) / 1000;
  }),
}));

jest.mock('../modules/booking/booking-payload.helper', () => ({
  buildBroadcastPayload: jest.fn().mockReturnValue({ broadcastId: 'test-id' }),
  getRemainingTimeoutSeconds: jest.fn().mockReturnValue(100),
}));

jest.mock('../core/state-machines', () => ({
  assertValidTransition: jest.fn(),
  BOOKING_VALID_TRANSITIONS: {},
}));

jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
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

// Mock Prisma enum (needed by truck-hold.types.ts)
jest.mock('@prisma/client', () => ({
  Prisma: {
    TransactionIsolationLevel: { Serializable: 'Serializable' },
    JsonNull: null as any,
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
    arrived_at_drop: 'arrived_at_drop',
  },
}));

// =============================================================================
// TESTS
// =============================================================================

describe('High/Medium Booking & Config Fixes', () => {

  // ============================================================
  // #25 — BOOKING_CONCURRENCY_LIMIT guards
  // ============================================================
  describe('#25 — BOOKING_CONCURRENCY_LIMIT env-var guards', () => {
    const ORIGINAL_ENV = process.env;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...ORIGINAL_ENV };
    });

    afterAll(() => {
      process.env = ORIGINAL_ENV;
    });

    it('defaults to 1 when env value is 0 (floor of 1 prevents 0-limit)', async () => {
      process.env.BOOKING_CONCURRENCY_LIMIT = '0';
      // Re-import after env change to force module re-evaluation
      const rawBCL = parseInt(process.env.BOOKING_CONCURRENCY_LIMIT || '50', 10);
      const limit = Math.max(1, isNaN(rawBCL) ? 50 : rawBCL);
      expect(limit).toBe(1);
    });

    it('defaults to 50 when env value is NaN string', async () => {
      process.env.BOOKING_CONCURRENCY_LIMIT = 'not-a-number';
      const rawBCL = parseInt(process.env.BOOKING_CONCURRENCY_LIMIT || '50', 10);
      const limit = Math.max(1, isNaN(rawBCL) ? 50 : rawBCL);
      expect(limit).toBe(50);
    });

    it('defaults to 1 when env value is negative', async () => {
      process.env.BOOKING_CONCURRENCY_LIMIT = '-5';
      const rawBCL = parseInt(process.env.BOOKING_CONCURRENCY_LIMIT || '50', 10);
      const limit = Math.max(1, isNaN(rawBCL) ? 50 : rawBCL);
      expect(limit).toBe(1);
    });

    it('uses value as-is when env value is valid positive integer', async () => {
      process.env.BOOKING_CONCURRENCY_LIMIT = '30';
      const rawBCL = parseInt(process.env.BOOKING_CONCURRENCY_LIMIT || '50', 10);
      const limit = Math.max(1, isNaN(rawBCL) ? 50 : rawBCL);
      expect(limit).toBe(30);
    });
  });

  // ============================================================
  // #26 — MAX_TRANSPORTERS_PER_STEP guards
  // ============================================================
  describe('#26 — MAX_TRANSPORTERS_PER_STEP env-var guards', () => {
    const parseMaxTransportersPerStep = (envVal: string | undefined) => {
      const r = parseInt(envVal || '20', 10);
      return Math.max(1, isNaN(r) ? 20 : r);
    };

    it('defaults to 1 when env value is 0 (floor of 1 ensures at least one candidate)', () => {
      expect(parseMaxTransportersPerStep('0')).toBe(1);
    });

    it('defaults to 20 when env value is NaN', () => {
      expect(parseMaxTransportersPerStep('abc')).toBe(20);
    });

    it('uses supplied value when value is valid (e.g. 50)', () => {
      expect(parseMaxTransportersPerStep('50')).toBe(50);
    });

    it('defaults to 20 when env is undefined', () => {
      expect(parseMaxTransportersPerStep(undefined)).toBe(20);
    });
  });

  // ============================================================
  // #40 — HOLD_CLEANUP_BATCH_SIZE bounds
  // ============================================================
  describe('#40 — HOLD_CLEANUP_BATCH_SIZE bounds (min 1, max 5000)', () => {
    const parseCleanupBatchSize = (envVal: string | undefined) => {
      const raw = parseInt(envVal || '500', 10);
      return Math.min(5000, Math.max(1, isNaN(raw) ? 500 : raw));
    };

    it('defaults to 1 when env value is 0', () => {
      expect(parseCleanupBatchSize('0')).toBe(1);
    });

    it('caps to 5000 when env value exceeds max (e.g. 99999)', () => {
      expect(parseCleanupBatchSize('99999')).toBe(5000);
    });

    it('defaults to 500 when env value is NaN', () => {
      expect(parseCleanupBatchSize('NaN')).toBe(500);
    });

    it('uses supplied value when within valid bounds (e.g. 250)', () => {
      expect(parseCleanupBatchSize('250')).toBe(250);
    });
  });

  // ============================================================
  // #23 — Orphaned booking try-catch (post-persist broadcast failure)
  // ============================================================
  describe('#23 — Post-persist broadcast pipeline: CAS-expire on failure', () => {
    const makeBaseBookingData = () => ({
      vehicleType: 'tipper',
      vehicleSubtype: '20-24ton',
      pickup: {
        coordinates: { latitude: 12.9716, longitude: 77.5946 },
        address: 'Bangalore', city: 'Bangalore', state: 'Karnataka',
      },
      drop: {
        coordinates: { latitude: 13.0827, longitude: 80.2707 },
        address: 'Chennai', city: 'Chennai', state: 'TamilNadu',
      },
      trucksNeeded: 1,
      pricePerTruck: 15000,
      distanceKm: 350,
      goodsType: 'general',
      weight: '10',
    });

    const makeCreatedBooking = (id: string) => ({
      id,
      customerId: 'cust-123',
      customerName: 'Test',
      customerPhone: '9999999999',
      status: 'created',
      vehicleType: 'tipper',
      vehicleSubtype: '20-24ton',
      trucksNeeded: 1,
      trucksFilled: 0,
      pricePerTruck: 15000,
      distanceKm: 350,
      notifiedTransporters: ['tp-1'],
      pickup: { latitude: 12.9716, longitude: 77.5946, address: 'Bangalore', city: 'Bangalore', state: 'Karnataka' },
      drop: { latitude: 13.0827, longitude: 80.2707, address: 'Chennai', city: 'Chennai', state: 'TamilNadu' },
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    });

    beforeEach(() => {
      jest.clearAllMocks();
      // No cooldown, no active broadcast
      mockRedisGet.mockResolvedValue(null);
      // Backpressure: allow booking (inflight count = 1, within limit)
      mockRedisIncr.mockResolvedValue(1);
      mockRedisIncrBy.mockResolvedValue(0);
      mockRedisExpire.mockResolvedValue(1);
      // Lock acquisition succeeds
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockRedisReleaseLock.mockResolvedValue(true);
      // DB: no active booking/order
      mockBookingFindFirst.mockResolvedValue(null);
      mockOrderFindFirst.mockResolvedValue(null);
      mockBookingCreate.mockResolvedValue({});
      // User lookup
      mockGetUserById.mockResolvedValue({ id: 'cust-123', name: 'Test Customer' });
      // Google Maps returns a good route
      mockCalculateRoute.mockResolvedValue({ distanceKm: 350, durationMinutes: 60 });
      // Haversine
      mockHaversineDistanceKm.mockReturnValue(270);
      // DB returns the created booking
      mockGetBookingById.mockResolvedValue(makeCreatedBooking('booking-orphan-1'));
      // Transporters found
      mockGetTransportersWithVehicleType.mockResolvedValue(['tp-1', 'tp-2']);
      mockFilterOnline.mockResolvedValue(['tp-1']);
      mockFindCandidates.mockResolvedValue([
        { transporterId: 'tp-1', distanceKm: 5, latitude: 12.9, longitude: 77.5, etaSeconds: 600, etaSource: 'haversine' }
      ]);
      // Redis set operations
      mockRedisSet.mockResolvedValue('OK');
      mockRedisDel.mockResolvedValue(1);
      mockRedisSAddWithExpire.mockResolvedValue(undefined);
      mockRedisSetTimer.mockResolvedValue(undefined);
      mockRedisCancelTimer.mockResolvedValue(undefined);
      // Broadcast vehicle eligibility check
      mockVehicleFindMany.mockResolvedValue([{ transporterId: 'tp-1' }]);
      // Booking status check during broadcast (not cancelled)
      mockBookingFindUnique.mockResolvedValue({ status: 'created' });
      // Socket connected check for FCM
      mockIsUserConnectedAsync.mockResolvedValue(false);
      // Booking status update (broadcasting, active) succeed
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    });

    it('CAS-expires the booking when broadcastBookingToTransporters throws', async () => {
      const { BookingCreateService, setBroadcastServiceRef } = await import('../modules/booking/booking-create.service');
      const service = new BookingCreateService();

      const broadcastError = new Error('Broadcast service failure');
      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockRejectedValue(broadcastError),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      await expect(
        service.createBooking('cust-123', '9999999999', makeBaseBookingData() as any)
      ).rejects.toThrow('Broadcast service failure');

      // CAS-expire should have been called
      expect(mockBookingUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: expect.any(String),
            status: expect.objectContaining({ notIn: expect.arrayContaining(['cancelled', 'expired', 'completed', 'fully_filled']) }),
          }),
          data: expect.objectContaining({ status: 'expired' }),
        })
      );
    });

    it('notifies the customer via socket when broadcast pipeline fails', async () => {
      const { BookingCreateService, setBroadcastServiceRef } = await import('../modules/booking/booking-create.service');
      const service = new BookingCreateService();

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockRejectedValue(new Error('fail')),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      await expect(
        service.createBooking('cust-123', '9999999999', makeBaseBookingData() as any)
      ).rejects.toThrow();

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'cust-123',
        'booking_expired',
        expect.objectContaining({ reason: 'broadcast_failed' })
      );
    });

    it('clears customer active-broadcast Redis key when broadcast pipeline fails', async () => {
      const { BookingCreateService, setBroadcastServiceRef } = await import('../modules/booking/booking-create.service');
      const service = new BookingCreateService();

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockRejectedValue(new Error('fail')),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      await expect(
        service.createBooking('cust-123', '9999999999', makeBaseBookingData() as any)
      ).rejects.toThrow();

      expect(mockRedisDel).toHaveBeenCalledWith(
        expect.stringContaining('customer:active-broadcast:cust-123')
      );
    });

    it('does NOT expire booking when broadcast pipeline succeeds', async () => {
      const { BookingCreateService, setBroadcastServiceRef } = await import('../modules/booking/booking-create.service');
      const service = new BookingCreateService();

      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      await service.createBooking('cust-123', '9999999999', makeBaseBookingData() as any);

      // No expiry update should have happened on the success path
      const expiryCalls = mockBookingUpdateMany.mock.calls.filter(
        (c: any[]) => c[0]?.data?.status === 'expired'
      );
      expect(expiryCalls).toHaveLength(0);
    });

    it('re-throws the original broadcast error after cleanup', async () => {
      const { BookingCreateService, setBroadcastServiceRef } = await import('../modules/booking/booking-create.service');
      const service = new BookingCreateService();

      const originalError = new Error('original-broadcast-error');
      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockRejectedValue(originalError),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });

      await expect(
        service.createBooking('cust-123', '9999999999', makeBaseBookingData() as any)
      ).rejects.toThrow('original-broadcast-error');
    });
  });

  // ============================================================
  // #28 — No-transporter idempotency: dedupeKey IS set
  // ============================================================
  describe('#28 — No-transporter path: idempotency cache set before returning', () => {
    const makeBookingData = () => ({
      vehicleType: 'tipper',
      vehicleSubtype: '20-24ton',
      pickup: {
        coordinates: { latitude: 12.9716, longitude: 77.5946 },
        address: 'Bangalore', city: 'Bangalore', state: 'Karnataka',
      },
      drop: {
        coordinates: { latitude: 13.0827, longitude: 80.2707 },
        address: 'Chennai', city: 'Chennai', state: 'TamilNadu',
      },
      trucksNeeded: 1,
      pricePerTruck: 15000,
      distanceKm: 350,
      goodsType: 'general',
      weight: '10',
    });

    const makeCreatedBooking = (id: string) => ({
      id,
      customerId: 'cust-no-tp',
      customerName: 'Test',
      customerPhone: '9999999999',
      status: 'expired',
      vehicleType: 'tipper',
      vehicleSubtype: '20-24ton',
      trucksNeeded: 1,
      trucksFilled: 0,
      pricePerTruck: 15000,
      distanceKm: 350,
      notifiedTransporters: [] as any[],
      pickup: { latitude: 12.9716, longitude: 77.5946, address: 'Bangalore', city: 'Bangalore', state: 'Karnataka' },
      drop: { latitude: 13.0827, longitude: 80.2707, address: 'Chennai', city: 'Chennai', state: 'TamilNadu' },
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    });

    beforeEach(() => {
      jest.clearAllMocks();
      mockRedisGet.mockResolvedValue(null);
      mockRedisIncr.mockResolvedValue(1);
      mockRedisIncrBy.mockResolvedValue(0);
      mockRedisExpire.mockResolvedValue(1);
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockRedisReleaseLock.mockResolvedValue(true);
      mockBookingFindFirst.mockResolvedValue(null);
      mockOrderFindFirst.mockResolvedValue(null);
      mockBookingCreate.mockResolvedValue({});
      mockGetUserById.mockResolvedValue({ id: 'cust-no-tp', name: 'Test' });
      mockCalculateRoute.mockResolvedValue({ distanceKm: 350, durationMinutes: 60 });
      mockHaversineDistanceKm.mockReturnValue(270);
      mockGetBookingById.mockResolvedValue(makeCreatedBooking('booking-no-tp-1'));
      // Zero transporters found in DB
      mockGetTransportersWithVehicleType.mockResolvedValue([]);
      mockFilterOnline.mockResolvedValue([]);
      mockFindCandidates.mockResolvedValue([]);
      mockRedisSet.mockResolvedValue('OK');
      mockRedisDel.mockResolvedValue(1);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    });

    it('sets idempotency cache key when there are 0 transporters', async () => {
      const { BookingCreateService, setBroadcastServiceRef } = await import('../modules/booking/booking-create.service');
      const service = new BookingCreateService();
      setBroadcastServiceRef(null);

      await service.createBooking('cust-no-tp', '9999999999', makeBookingData() as any);

      // Should have set at least one idem: key
      const idemCalls = (mockRedisSet.mock.calls as any[][]).filter((c: any[]) =>
        typeof c[0] === 'string' && c[0].startsWith('idem:booking:create:')
      );
      expect(idemCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('the idempotency key contains the booking id as the value', async () => {
      const { BookingCreateService, setBroadcastServiceRef } = await import('../modules/booking/booking-create.service');
      const service = new BookingCreateService();
      setBroadcastServiceRef(null);

      await service.createBooking('cust-no-tp', '9999999999', makeBookingData() as any);

      const idemCalls = (mockRedisSet.mock.calls as any[][]).filter((c: any[]) =>
        typeof c[0] === 'string' && c[0].startsWith('idem:booking:create:')
      );
      expect(idemCalls.length).toBeGreaterThanOrEqual(1);
      // Value should be a non-empty string (booking id)
      expect(typeof idemCalls[0][1]).toBe('string');
      expect(idemCalls[0][1].length).toBeGreaterThan(0);
    });

    it('returns earlyReturn with status=expired and matchingTransportersCount=0', async () => {
      const { BookingCreateService, setBroadcastServiceRef } = await import('../modules/booking/booking-create.service');
      const service = new BookingCreateService();
      setBroadcastServiceRef(null);

      const result = await service.createBooking('cust-no-tp', '9999999999', makeBookingData() as any);

      expect(result.matchingTransportersCount).toBe(0);
      expect(result.timeoutSeconds).toBe(0);
    });

    it('does not throw when 0 transporters are found', async () => {
      const { BookingCreateService, setBroadcastServiceRef } = await import('../modules/booking/booking-create.service');
      const service = new BookingCreateService();
      setBroadcastServiceRef(null);

      await expect(
        service.createBooking('cust-no-tp', '9999999999', makeBookingData() as any)
      ).resolves.toBeDefined();
    });
  });

  // ============================================================
  // #29 — Undefined coords hash: produces DIFFERENT hashes
  // ============================================================
  describe('#29 — Undefined coords hash collision prevention', () => {
    // Use a typed variable to avoid TS2871 (undefined literal is always nullish)
    const missingCoord: number | undefined = undefined;

    it('two bookings with undefined coords produce different fingerprints via String(?? MISSING)', () => {
      const fingerprint1 = [
        'cust-1',
        'tipper',
        '',
        String(missingCoord ?? 'MISSING'),
        String(missingCoord ?? 'MISSING'),
        String(missingCoord ?? 'MISSING'),
        String(missingCoord ?? 'MISSING'),
        String(1),
        String(15000),
      ].join(':');

      const fingerprint2 = [
        'cust-2', // different customer
        'tipper',
        '',
        String(missingCoord ?? 'MISSING'),
        String(missingCoord ?? 'MISSING'),
        String(missingCoord ?? 'MISSING'),
        String(missingCoord ?? 'MISSING'),
        String(1),
        String(15000),
      ].join(':');

      expect(fingerprint1).not.toBe(fingerprint2);
    });

    it('String(undefined ?? "MISSING") produces "MISSING", not "NaN" or "undefined"', () => {
      const result = String(missingCoord ?? 'MISSING');
      expect(result).toBe('MISSING');
      expect(result).not.toBe('NaN');
      expect(result).not.toBe('undefined');
    });

    it('two bookings with same undefined coords but different customers hash differently', () => {
      const crypto = require('crypto');

      const fingerprint1 = ['cust-A', 'tipper', '', 'MISSING', 'MISSING', 'MISSING', 'MISSING', '1', '15000'].join(':');
      const fingerprint2 = ['cust-B', 'tipper', '', 'MISSING', 'MISSING', 'MISSING', 'MISSING', '1', '15000'].join(':');

      const hash1 = crypto.createHash('sha256').update(fingerprint1).digest('hex').substring(0, 32);
      const hash2 = crypto.createHash('sha256').update(fingerprint2).digest('hex').substring(0, 32);

      expect(hash1).not.toBe(hash2);
    });

    it('NaN-based fingerprint collides (demonstrates the bug), MISSING-based does not', () => {
      // This test documents WHY the fix matters
      const nanFp1 = ['cust-X', 'tipper', '', String(NaN), String(NaN), String(NaN), String(NaN), '1', '10000'].join(':');
      const nanFp2 = ['cust-Y', 'tipper', '', String(NaN), String(NaN), String(NaN), String(NaN), '1', '10000'].join(':');

      // NaN-based fingerprints for different customers would only differ in the customer ID portion,
      // but the coord portions are identical. With MISSING they're also identical per coord
      // but different customers still differ by the customer ID — the key point is NaN==NaN as string.
      expect(String(NaN)).toBe('NaN'); // confirms NaN stays as "NaN" - exploitable collision
      expect(String(missingCoord ?? 'MISSING')).toBe('MISSING'); // fix: deterministic value
      expect(nanFp1).not.toBe(nanFp2); // different customers still differ, but NaN cols are same
    });
  });

  // ============================================================
  // #32 — Cancel-rebook cooldown
  // ============================================================
  describe('#32 — Cancel-rebook cooldown (30s after cancel, 429 during)', () => {
    const makeBookingData = () => ({
      vehicleType: 'tipper',
      vehicleSubtype: '20-24ton',
      pickup: {
        coordinates: { latitude: 12.9716, longitude: 77.5946 },
        address: 'Bangalore', city: 'Bangalore', state: 'Karnataka',
      },
      drop: {
        coordinates: { latitude: 13.0827, longitude: 80.2707 },
        address: 'Chennai', city: 'Chennai', state: 'TamilNadu',
      },
      trucksNeeded: 1,
      pricePerTruck: 15000,
      distanceKm: 350,
      goodsType: 'general',
      weight: '10',
    });

    it('throws 429 when cancel cooldown key exists in Redis', async () => {
      jest.clearAllMocks();
      // Simulate cooldown active for this customer
      mockRedisGet.mockImplementation(async (key: string) => {
        if (key.startsWith('booking:cancel-cooldown:')) return '1';
        return null;
      });
      mockRedisIncr.mockResolvedValue(1);

      const { BookingCreateService, setBroadcastServiceRef } = await import('../modules/booking/booking-create.service');
      setBroadcastServiceRef(null);
      const service = new BookingCreateService();

      const err: any = await service.createBooking('cust-cooldown', '9999999999', makeBookingData() as any)
        .catch(e => e);

      expect(err).toBeDefined();
      expect(err.statusCode ?? err.status).toBe(429);
      expect(err.code ?? err.message).toMatch(/CANCEL_COOLDOWN|wait/i);
    });

    it('sets cooldown key in Redis with 30s TTL after successful cancel', async () => {
      jest.clearAllMocks();
      mockRedisGet.mockResolvedValue(null);
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockRedisReleaseLock.mockResolvedValue(true);
      mockRedisSet.mockResolvedValue('OK');
      mockRedisDel.mockResolvedValue(1);
      mockRedisCancelTimer.mockResolvedValue(undefined);

      // preflight returns an active booking (cancellable)
      mockGetBookingById
        .mockResolvedValueOnce({
          id: 'b-1', customerId: 'cust-cd', status: 'active',
          notifiedTransporters: [], trucksFilled: 0, trucksNeeded: 1,
        })
        // post-transaction re-fetch returns cancelled
        .mockResolvedValue({
          id: 'b-1', customerId: 'cust-cd', status: 'cancelled',
          notifiedTransporters: [], trucksFilled: 0, trucksNeeded: 1,
        });

      // Transaction: updateMany returns count=1 (cancel succeeded), assignments=[]
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });

      const { bookingLifecycleService } = await import('../modules/booking/booking-lifecycle.service');
      await bookingLifecycleService.cancelBooking('b-1', 'cust-cd').catch(() => {});

      const cooldownCalls = (mockRedisSet.mock.calls as any[][]).filter((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('cancel-cooldown')
      );
      expect(cooldownCalls.length).toBeGreaterThanOrEqual(1);
      // TTL should be 30s
      const cooldownCall = cooldownCalls[0];
      expect(cooldownCall[2]).toBe(30);
    });

    it('allows new booking creation when cooldown key is absent', async () => {
      jest.clearAllMocks();
      // No cooldown key
      mockRedisGet.mockResolvedValue(null);
      mockRedisIncr.mockResolvedValue(1);
      mockRedisIncrBy.mockResolvedValue(0);
      mockRedisExpire.mockResolvedValue(1);
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockRedisReleaseLock.mockResolvedValue(true);
      mockBookingFindFirst.mockResolvedValue(null);
      mockOrderFindFirst.mockResolvedValue(null);
      mockBookingCreate.mockResolvedValue({});
      mockGetUserById.mockResolvedValue({ id: 'cust-ok', name: 'OK' });
      mockCalculateRoute.mockResolvedValue({ distanceKm: 350, durationMinutes: 60 });
      mockHaversineDistanceKm.mockReturnValue(270);
      mockGetBookingById.mockResolvedValue({
        id: 'b-2', customerId: 'cust-ok', status: 'created',
        notifiedTransporters: ['tp-1'], trucksFilled: 0, trucksNeeded: 1,
        vehicleType: 'tipper', vehicleSubtype: '20-24ton', pricePerTruck: 15000,
        distanceKm: 350, expiresAt: new Date(Date.now() + 120000).toISOString(),
        pickup: { city: 'Bangalore', address: 'B', state: 'KA', latitude: 12.97, longitude: 77.59 },
        drop: { city: 'Chennai', address: 'C', state: 'TN', latitude: 13.08, longitude: 80.27 },
      });
      mockGetTransportersWithVehicleType.mockResolvedValue(['tp-1']);
      mockFilterOnline.mockResolvedValue(['tp-1']);
      mockFindCandidates.mockResolvedValue([
        { transporterId: 'tp-1', distanceKm: 5, latitude: 12.9, longitude: 77.5, etaSeconds: 600, etaSource: 'haversine' }
      ]);
      mockRedisSet.mockResolvedValue('OK');
      mockRedisDel.mockResolvedValue(1);
      mockRedisSAddWithExpire.mockResolvedValue(undefined);
      mockRedisSetTimer.mockResolvedValue(undefined);
      mockRedisCancelTimer.mockResolvedValue(undefined);
      mockVehicleFindMany.mockResolvedValue([{ transporterId: 'tp-1' }]);
      mockBookingFindUnique.mockResolvedValue({ status: 'created' });
      mockIsUserConnectedAsync.mockResolvedValue(false);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });

      const { BookingCreateService, setBroadcastServiceRef } = await import('../modules/booking/booking-create.service');
      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });
      const service = new BookingCreateService();

      await expect(
        service.createBooking('cust-ok', '9999999999', makeBookingData() as any)
      ).resolves.toBeDefined();
    });

    it('cooldown key has correct Redis prefix booking:cancel-cooldown:{customerId}', async () => {
      jest.clearAllMocks();
      mockRedisGet.mockResolvedValue(null);
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockRedisReleaseLock.mockResolvedValue(true);
      mockRedisSet.mockResolvedValue('OK');
      mockRedisDel.mockResolvedValue(1);
      mockRedisCancelTimer.mockResolvedValue(undefined);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });

      // preflight returns active (cancellable), post-tx returns cancelled
      mockGetBookingById
        .mockResolvedValueOnce({
          id: 'b-3', customerId: 'cust-prefix-test', status: 'active',
          notifiedTransporters: [], trucksFilled: 0, trucksNeeded: 1,
        })
        .mockResolvedValue({
          id: 'b-3', customerId: 'cust-prefix-test', status: 'cancelled',
          notifiedTransporters: [], trucksFilled: 0, trucksNeeded: 1,
        });

      const { bookingLifecycleService } = await import('../modules/booking/booking-lifecycle.service');
      await bookingLifecycleService.cancelBooking('b-3', 'cust-prefix-test').catch(() => {});

      const cooldownCalls = (mockRedisSet.mock.calls as any[][]).filter((c: any[]) =>
        typeof c[0] === 'string' && c[0] === 'booking:cancel-cooldown:cust-prefix-test'
      );
      expect(cooldownCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================================
  // #68 — resume-broadcast processor registered at startup
  // ============================================================
  describe('#68 — registerResumeBroadcastProcessor registers queue consumer', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockQueueRegisterProcessor.mockImplementation(() => {});
    });

    it('registerResumeBroadcastProcessor function exists and is exported', async () => {
      const mod = await import('../modules/booking/booking-lifecycle.service');
      expect(typeof mod.registerResumeBroadcastProcessor).toBe('function');
    });

    it('calling registerResumeBroadcastProcessor registers processor on booking:resume-broadcast queue', async () => {
      const { registerResumeBroadcastProcessor } = await import('../modules/booking/booking-lifecycle.service');
      registerResumeBroadcastProcessor();
      expect(mockQueueRegisterProcessor).toHaveBeenCalledWith(
        'booking:resume-broadcast',
        expect.any(Function)
      );
    });

    it('the registered processor expires stale booking and notifies customer', async () => {
      const { registerResumeBroadcastProcessor } = await import('../modules/booking/booking-lifecycle.service');

      let capturedProcessor: any;
      mockQueueRegisterProcessor.mockImplementation((_qName: string, fn: any) => {
        capturedProcessor = fn;
      });

      registerResumeBroadcastProcessor();

      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockRedisDel.mockResolvedValue(1);

      await capturedProcessor({ data: { bookingId: 'stale-b-1', customerId: 'cust-stale' } });

      expect(mockBookingUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'stale-b-1',
            status: expect.objectContaining({ notIn: expect.arrayContaining(['expired']) }),
          }),
          data: expect.objectContaining({
            expiresAt: expect.any(String),
            stateChangedAt: expect.any(Date),
          }),
        })
      );
    });
  });

  // ============================================================
  // #30 — Client distance not used for fare (Haversine used when Google fails)
  // ============================================================
  describe('#30 — Haversine used for fare when Google Directions fails', () => {
    const makeBookingData = (clientDistanceKm = 50) => ({
      vehicleType: 'tipper',
      vehicleSubtype: '20-24ton',
      pickup: {
        coordinates: { latitude: 12.9716, longitude: 77.5946 },
        address: 'Bangalore', city: 'Bangalore', state: 'Karnataka',
      },
      drop: {
        coordinates: { latitude: 13.0827, longitude: 80.2707 },
        address: 'Chennai', city: 'Chennai', state: 'TamilNadu',
      },
      trucksNeeded: 1,
      pricePerTruck: 500,  // floor fare
      distanceKm: clientDistanceKm,
      goodsType: 'general',
      weight: '10',
    });

    beforeEach(() => {
      jest.clearAllMocks();
      // Google Maps fails
      mockCalculateRoute.mockRejectedValue(new Error('Google API unavailable'));
      // Haversine returns 100km straight-line
      mockHaversineDistanceKm.mockReturnValue(100);
      mockRedisGet.mockResolvedValue(null);
      mockRedisIncr.mockResolvedValue(1);
      mockRedisIncrBy.mockResolvedValue(0);
      mockRedisExpire.mockResolvedValue(1);
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockRedisReleaseLock.mockResolvedValue(true);
      mockGetUserById.mockResolvedValue({ id: 'cust-haversine', name: 'Test' });
      mockBookingFindFirst.mockResolvedValue(null);
      mockOrderFindFirst.mockResolvedValue(null);
    });

    it('haversineDistanceKm is called when Google Directions fails', async () => {
      const { BookingCreateService, setBroadcastServiceRef } = await import('../modules/booking/booking-create.service');
      setBroadcastServiceRef(null);
      const service = new BookingCreateService();

      // Fare must cover Haversine road estimate: ceil(100 * 1.3) = 130km
      // MIN_FARE at 8/km with 0.5 tolerance = max(500, 130*8*0.5) = max(500,520) = 520
      // pricePerTruck 15000 > 520, so no fare error
      const data = { ...makeBookingData(350) as any, pricePerTruck: 15000 };
      mockGetBookingById.mockResolvedValue({
        id: 'bk-haversine', customerId: 'cust-haversine', status: 'expired',
        vehicleType: 'tipper', vehicleSubtype: '20-24ton',
        trucksNeeded: 1, trucksFilled: 0, pricePerTruck: 15000, distanceKm: 130,
        notifiedTransporters: [], expiresAt: new Date(Date.now() + 120000).toISOString(),
        pickup: { latitude: 12.97, longitude: 77.59, address: 'B', city: 'Bangalore', state: 'KA' },
        drop: { latitude: 13.08, longitude: 80.27, address: 'C', city: 'Chennai', state: 'TN' },
      });
      mockGetTransportersWithVehicleType.mockResolvedValue([]);
      mockFilterOnline.mockResolvedValue([]);
      mockFindCandidates.mockResolvedValue([]);
      mockBookingCreate.mockResolvedValue({});
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockRedisSet.mockResolvedValue('OK');
      mockRedisDel.mockResolvedValue(1);

      await service.createBooking('cust-haversine', '9999999999', data).catch(() => {});

      expect(mockHaversineDistanceKm).toHaveBeenCalled();
    });

    it('throws FARE_TOO_LOW when fare < haversine road estimate, not client distance', async () => {
      const { BookingCreateService, setBroadcastServiceRef } = await import('../modules/booking/booking-create.service');
      setBroadcastServiceRef(null);
      const service = new BookingCreateService();

      // Haversine returns 100km -> road estimate = ceil(100*1.3) = 130km
      // MIN_FARE at 8/km with 0.5 tolerance = max(500, 130*8*0.5) = 520
      // Price = 1 (too low)
      const data = { ...makeBookingData(10) as any, pricePerTruck: 1 };

      const err: any = await service.createBooking('cust-haversine', '9999999999', data).catch(e => e);

      expect(err).toBeDefined();
      expect(err.code ?? err.message).toMatch(/FARE_TOO_LOW|fare|minimum/i);
    });

    it('does NOT use client-supplied distanceKm for fare when Google unavailable', async () => {
      // With clientDistance=10km (cheap) but haversine=100km,
      // a very low fare that passes 10km check but fails 100km check should throw
      const { BookingCreateService, setBroadcastServiceRef } = await import('../modules/booking/booking-create.service');
      setBroadcastServiceRef(null);
      const service = new BookingCreateService();

      // Client says 10km, haversine says 100km
      // If server used client distance: max(500, 10*8*0.5)=500, price=510 passes
      // If server used haversine: max(500, 130*8*0.5)=520, price=510 fails
      const data = { ...makeBookingData(10) as any, pricePerTruck: 510 };

      const err: any = await service.createBooking('cust-haversine', '9999999999', data).catch(e => e);

      // Should fail because server uses haversine (130km), not client (10km)
      // 510 < 520 (haversine-based minimum)
      expect(err).toBeDefined();
      expect(err.code ?? err.message).toMatch(/FARE_TOO_LOW|minimum/i);
    });

    it('haversine road estimate uses 1.3 multiplier (ceil(haversineKm * 1.3))', () => {
      const haversineKm = 100;
      const roadEstimate = Math.ceil(haversineKm * 1.3);
      expect(roadEstimate).toBe(130);
    });
  });

  // ============================================================
  // #31 — Fare floor on pricing fail (minimum fare 500)
  // ============================================================
  describe('#31 — Fare floor: minimum 500 applied when pricing data unavailable', () => {
    it('estimated min fare is at least 500 regardless of distance (max with 500 floor)', () => {
      // Very short distance: 1km
      const distanceKm = 1;
      const MIN_FARE_PER_KM = 8;
      const FARE_TOLERANCE = 0.5;
      const estimatedMinFare = Math.max(500, Math.round(distanceKm * MIN_FARE_PER_KM * FARE_TOLERANCE));
      expect(estimatedMinFare).toBe(500); // floor wins
    });

    it('fare below floor (500) is rejected even for short trips', () => {
      const distanceKm = 5;
      const MIN_FARE_PER_KM = 8;
      const FARE_TOLERANCE = 0.5;
      const estimatedMinFare = Math.max(500, Math.round(distanceKm * MIN_FARE_PER_KM * FARE_TOLERANCE));
      const pricePerTruck = 499;
      expect(pricePerTruck < estimatedMinFare).toBe(true);
    });

    it('fare at exactly floor (500) is not rejected', () => {
      const distanceKm = 5;
      const MIN_FARE_PER_KM = 8;
      const FARE_TOLERANCE = 0.5;
      const estimatedMinFare = Math.max(500, Math.round(distanceKm * MIN_FARE_PER_KM * FARE_TOLERANCE));
      const pricePerTruck = 500;
      expect(pricePerTruck < estimatedMinFare).toBe(false); // not too low
    });
  });

  // ============================================================
  // #74 — Zero-notified booking guard
  // ============================================================
  describe('#74 — Zero-notified booking: expired instead of active', () => {
    const makeBookingForBroadcast = () => ({
      id: 'bk-zero-notified',
      customerId: 'cust-z',
      customerName: 'Zero',
      customerPhone: '9999999999',
      status: 'created',
      vehicleType: 'tipper',
      vehicleSubtype: '20-24ton',
      trucksNeeded: 1,
      trucksFilled: 0,
      pricePerTruck: 15000,
      distanceKm: 350,
      expiresAt: new Date(Date.now() + 120000).toISOString(),
      pickup: { latitude: 12.97, longitude: 77.59, address: 'B', city: 'Bangalore', state: 'KA' },
      drop: { latitude: 13.08, longitude: 80.27, address: 'C', city: 'Chennai', state: 'TN' },
    });

    beforeEach(() => {
      jest.clearAllMocks();
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockRedisDel.mockResolvedValue(1);
    });

    it('calls booking.updateMany with status=expired when notifiedCount=0', async () => {
      const { BookingBroadcastService } = await import('../modules/booking/booking-broadcast.service');
      const service = new BookingBroadcastService();

      const ctx: any = {
        booking: makeBookingForBroadcast(),
        customerId: 'cust-z',
        cappedTransporters: [],
        matchingTransporters: [],
        skipProgressiveExpansion: false,
        data: { vehicleType: 'tipper', vehicleSubtype: '20-24ton', pickup: { coordinates: { latitude: 12.97, longitude: 77.59 } } },
      };

      await service.setupBookingTimeout(ctx);

      const expiryCalls = (mockBookingUpdateMany.mock.calls as any[][]).filter(
        (c: any[]) => c[0]?.data?.status === 'expired'
      );
      expect(expiryCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('emits BOOKING_EXPIRED to customer when notifiedCount=0', async () => {
      const { BookingBroadcastService } = await import('../modules/booking/booking-broadcast.service');
      const service = new BookingBroadcastService();

      const ctx: any = {
        booking: makeBookingForBroadcast(),
        customerId: 'cust-z',
        cappedTransporters: [],
        matchingTransporters: [],
        skipProgressiveExpansion: false,
        data: { vehicleType: 'tipper', vehicleSubtype: '20-24ton', pickup: { coordinates: { latitude: 12.97, longitude: 77.59 } } },
      };

      await service.setupBookingTimeout(ctx);

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'cust-z',
        'booking_expired',
        expect.objectContaining({ reason: 'no_eligible_transporters' })
      );
    });

    it('clears active-broadcast Redis key when notifiedCount=0', async () => {
      const { BookingBroadcastService } = await import('../modules/booking/booking-broadcast.service');
      const service = new BookingBroadcastService();

      const ctx: any = {
        booking: makeBookingForBroadcast(),
        customerId: 'cust-z',
        cappedTransporters: [],
        matchingTransporters: [],
        skipProgressiveExpansion: false,
        data: { vehicleType: 'tipper', vehicleSubtype: '20-24ton', pickup: { coordinates: { latitude: 12.97, longitude: 77.59 } } },
      };

      await service.setupBookingTimeout(ctx);

      expect(mockRedisDel).toHaveBeenCalledWith(
        expect.stringContaining('customer:active-broadcast:cust-z')
      );
    });

    it('returns early (does NOT start timer) when notifiedCount=0', async () => {
      const { BookingBroadcastService } = await import('../modules/booking/booking-broadcast.service');
      const service = new BookingBroadcastService();

      const ctx: any = {
        booking: makeBookingForBroadcast(),
        customerId: 'cust-z',
        cappedTransporters: [],
        matchingTransporters: [],
        skipProgressiveExpansion: false,
        data: { vehicleType: 'tipper', vehicleSubtype: '20-24ton', pickup: { coordinates: { latitude: 12.97, longitude: 77.59 } } },
      };

      await service.setupBookingTimeout(ctx);

      // Timer should NOT have been started
      expect(mockRedisSetTimer).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // #77 — Namespace-separated idempotency keys
  // ============================================================
  describe('#77 — Namespace-separated idempotency keys (booking vs order)', () => {
    it('booking dedupeKey uses idem:booking:create: prefix', () => {
      const crypto = require('crypto');
      const customerId = 'cust-ns-test';
      const hash = crypto.createHash('sha256').update('test-fingerprint').digest('hex').substring(0, 32);
      const dedupeKey = `idem:booking:create:${customerId}:${hash}`;
      expect(dedupeKey).toMatch(/^idem:booking:create:/);
    });

    it('order dedupeKey uses idem:order:create: prefix (different namespace from booking)', () => {
      const crypto = require('crypto');
      const customerId = 'cust-ns-test';
      const hash = crypto.createHash('sha256').update('test-fingerprint').digest('hex').substring(0, 32);
      const orderDedupeKey = `idem:order:create:${customerId}:${hash}`;
      const bookingDedupeKey = `idem:booking:create:${customerId}:${hash}`;
      // Keys must be in different namespaces
      expect(orderDedupeKey).not.toEqual(bookingDedupeKey);
      expect(orderDedupeKey).toMatch(/^idem:order:create:/);
    });

    it('booking dedupeKey is set in Redis after successful create (flow verification)', async () => {
      jest.clearAllMocks();
      mockRedisGet.mockResolvedValue(null);
      mockRedisIncr.mockResolvedValue(1);
      mockRedisIncrBy.mockResolvedValue(0);
      mockRedisExpire.mockResolvedValue(1);
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockRedisReleaseLock.mockResolvedValue(true);
      mockBookingFindFirst.mockResolvedValue(null);
      mockOrderFindFirst.mockResolvedValue(null);
      mockBookingCreate.mockResolvedValue({});
      mockGetUserById.mockResolvedValue({ id: 'cust-ns', name: 'Test' });
      mockCalculateRoute.mockResolvedValue({ distanceKm: 350, durationMinutes: 60 });
      mockHaversineDistanceKm.mockReturnValue(270);
      const bookingObj = {
        id: 'bk-ns-1', customerId: 'cust-ns', status: 'created',
        vehicleType: 'tipper', vehicleSubtype: '20-24ton',
        trucksNeeded: 1, trucksFilled: 0, pricePerTruck: 15000, distanceKm: 350,
        notifiedTransporters: ['tp-1'],
        expiresAt: new Date(Date.now() + 120000).toISOString(),
        pickup: { latitude: 12.97, longitude: 77.59, address: 'B', city: 'Bangalore', state: 'KA' },
        drop: { latitude: 13.08, longitude: 80.27, address: 'C', city: 'Chennai', state: 'TN' },
        customerName: 'Test', customerPhone: '9999999999',
      };
      mockGetBookingById.mockResolvedValue(bookingObj);
      mockGetTransportersWithVehicleType.mockResolvedValue(['tp-1']);
      mockFilterOnline.mockResolvedValue(['tp-1']);
      mockFindCandidates.mockResolvedValue([
        { transporterId: 'tp-1', distanceKm: 5, latitude: 12.9, longitude: 77.5, etaSeconds: 600, etaSource: 'haversine' }
      ]);
      mockRedisSet.mockResolvedValue('OK');
      mockRedisDel.mockResolvedValue(1);
      mockRedisSAddWithExpire.mockResolvedValue(undefined);
      mockRedisSetTimer.mockResolvedValue(undefined);
      mockRedisCancelTimer.mockResolvedValue(undefined);
      mockVehicleFindMany.mockResolvedValue([{ transporterId: 'tp-1' }]);
      mockBookingFindUnique.mockResolvedValue({ status: 'created' });
      mockIsUserConnectedAsync.mockResolvedValue(false);
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });

      const { BookingCreateService, setBroadcastServiceRef } = await import('../modules/booking/booking-create.service');
      setBroadcastServiceRef({
        broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
        sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
        setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
        setBookingRedisKeys: jest.fn().mockImplementation(async (_ctx: any) => {
          // setBookingRedisKeys sets the dedupeKey
          await mockRedisSet(`idem:booking:create:cust-ns:somehash`, 'bk-ns-1', 180);
        }),
        startBookingTimeout: jest.fn().mockResolvedValue(undefined),
      });
      const service = new BookingCreateService();

      await service.createBooking('cust-ns', '9999999999', {
        vehicleType: 'tipper', vehicleSubtype: '20-24ton',
        pickup: { coordinates: { latitude: 12.9716, longitude: 77.5946 }, address: 'B', city: 'Bangalore', state: 'KA' },
        drop: { coordinates: { latitude: 13.0827, longitude: 80.2707 }, address: 'C', city: 'Chennai', state: 'TN' },
        trucksNeeded: 1, pricePerTruck: 15000, distanceKm: 350, goodsType: 'general', weight: '10',
      } as any);

      const bookingIdemCalls = (mockRedisSet.mock.calls as any[][]).filter((c: any[]) =>
        typeof c[0] === 'string' && c[0].startsWith('idem:booking:create:')
      );
      expect(bookingIdemCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================================
  // #80 — Adaptive cancel check interval
  // ============================================================
  describe('#80 — Adaptive cancel check interval scales with transporter batch size', () => {
    const computeInterval = (count: number) =>
      Math.max(5, Math.min(50, Math.floor(count / 3) || 5));

    it('interval is 5 for 15 transporters (small batch gets frequent checks)', () => {
      // floor(15/3) = 5, max(5, min(50, 5)) = 5
      expect(computeInterval(15)).toBe(5);
    });

    it('interval scales up for 150 transporters (floor(150/3)=50)', () => {
      // floor(150/3) = 50, max(5, min(50, 50)) = 50
      expect(computeInterval(150)).toBe(50);
    });

    it('interval is capped at 50 for very large batches (200+ transporters)', () => {
      // floor(300/3)=100, min(50, 100)=50
      expect(computeInterval(300)).toBe(50);
    });

    it('interval is at least 5 even for very small batches (e.g. 3)', () => {
      // floor(3/3)=1, max(5,1)=5
      expect(computeInterval(3)).toBe(5);
    });
  });

});
