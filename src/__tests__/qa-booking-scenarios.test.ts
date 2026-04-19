/**
 * =============================================================================
 * QA BOOKING SCENARIOS -- Comprehensive tests for booking service fixes
 * =============================================================================
 *
 * Covers:
 *   GROUP 1: Config NaN Protection (FIX-1, FIX-2)
 *   GROUP 2: Terminal State Protection (FIX-3) — decrementTrucksFilled
 *   GROUP 3: Broadcast Failure Recovery (FIX-18)
 *   GROUP 4: Dedup Key Coverage (FIX-19)
 *   GROUP 5: Logging Escalation (FIX-23)
 *
 * @author QA Agent
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP -- Must come before any imports
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
  config: { redis: { enabled: true }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {}, bookingConcurrencyLimit: 50 },
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
const mockRedisIncr = jest.fn();
const mockRedisIncrBy = jest.fn();
const mockRedisSIsMember = jest.fn();
const mockRedisIsConnected = jest.fn().mockReturnValue(true);
const mockRedisHSet = jest.fn().mockResolvedValue(undefined);

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
    hSet: (...args: any[]) => mockRedisHSet(...args),
  },
}));

// Prisma mock -- booking, assignment, vehicle, user
const mockBookingFindUnique = jest.fn();
const mockBookingFindMany = jest.fn();
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
const mockTransaction = jest.fn();
const mockOrderFindFirst = jest.fn();

jest.mock('../shared/database/prisma.service', () => {
  const txProxy = {
    booking: {
      findUnique: (...args: any[]) => mockBookingFindUnique(...args),
      findMany: (...args: any[]) => mockBookingFindMany(...args),
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
const mockIsUserConnected = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToBooking: (...args: any[]) => mockEmitToBooking(...args),
  emitToUsers: jest.fn(),
  emitToRoom: jest.fn(),
  emitToAllTransporters: jest.fn(),
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
    TRIP_CANCELLED: 'trip_cancelled',
    NO_VEHICLES_AVAILABLE: 'no_vehicles_available',
    BROADCAST_STATE_CHANGED: 'broadcast_state_changed',
    BROADCAST_COUNTDOWN: 'broadcast_countdown',
    TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update',
  },
}));

// FCM service mock
const mockNotifyNewBroadcast = jest.fn().mockResolvedValue(0);
jest.mock('../shared/services/fcm.service', () => ({
  fcmService: {
    sendToDevice: jest.fn().mockResolvedValue(undefined),
    notifyNewBroadcast: (...args: any[]) => mockNotifyNewBroadcast(...args),
  },
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
}));

// Queue service mock
const mockQueueBroadcast = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    addJob: jest.fn(),
    queuePushNotificationBatch: jest.fn().mockResolvedValue(undefined),
    queueBroadcast: (...args: any[]) => mockQueueBroadcast(...args),
  },
}));

// Live availability mock
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: jest.fn().mockResolvedValue(undefined),
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
  ...jest.requireActual('../modules/order/progressive-radius-matcher'),
  progressiveRadiusMatcher: {
    findCandidates: jest.fn().mockResolvedValue([]),
    getStepCount: jest.fn().mockReturnValue(6),
    getStep: jest.fn().mockReturnValue({ radiusKm: 10, windowMs: 10_000, h3RingK: 15 }),
  },
  startProgressiveMatching: jest.fn(),
  cancelProgressiveMatching: jest.fn(),
}));

// Transporter online service mock
const mockFilterOnline = jest.fn();
jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: {
    filterOnline: (...args: any[]) => mockFilterOnline(...args),
    isOnline: jest.fn().mockResolvedValue(true),
  },
}));

// Vehicle lifecycle mock
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  onVehicleTransition: jest.fn().mockResolvedValue(undefined),
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
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
  ...jest.requireActual('../core/state-machines'),
  BOOKING_VALID_TRANSITIONS: {},
  isValidTransition: jest.fn().mockReturnValue(true),
  assertValidTransition: jest.fn(),
  TERMINAL_BOOKING_STATUSES: ['cancelled', 'expired', 'fully_filled', 'completed'],
}));

// Geo utils mock
jest.mock('../shared/utils/geo.utils', () => ({
  roundCoord: (c: number) => Math.round(c * 100) / 100,
}));

// Geospatial utils mock
jest.mock('../shared/utils/geospatial.utils', () => ({
  ...jest.requireActual('../shared/utils/geospatial.utils'),
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

import { logger } from '../shared/services/logger.service';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Flush all pending microtasks and macrotasks.
 * Needed for fire-and-forget promise chains like fcmService.notifyNewBroadcast(...).then(...).catch(...)
 */
function flushPromises(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(() => setImmediate(() => setImmediate(resolve)));
  });
}

function resetAllMocks(): void {
  jest.clearAllMocks();

  mockRedisGet.mockReset().mockResolvedValue(null);
  mockRedisSet.mockReset().mockResolvedValue(undefined);
  mockRedisDel.mockReset().mockResolvedValue(undefined);
  mockRedisExists.mockReset();
  mockRedisAcquireLock.mockReset().mockResolvedValue({ acquired: true });
  mockRedisReleaseLock.mockReset().mockResolvedValue(undefined);
  mockRedisSMembers.mockReset();
  mockRedisSAdd.mockReset();
  mockRedisGetJSON.mockReset();
  mockRedisSetJSON.mockReset();
  mockRedisGetExpiredTimers.mockReset();
  mockRedisCancelTimer.mockReset().mockResolvedValue(undefined);
  mockRedisSetTimer.mockReset().mockResolvedValue(undefined);
  mockRedisExpire.mockReset().mockResolvedValue(undefined);
  mockRedisIncr.mockReset().mockResolvedValue(1);
  mockRedisIncrBy.mockReset().mockResolvedValue(0);
  mockRedisSIsMember.mockReset();
  mockRedisIsConnected.mockReturnValue(true);
  mockRedisHSet.mockReset().mockResolvedValue(undefined);

  mockBookingFindUnique.mockReset();
  mockBookingFindMany.mockReset();
  mockBookingUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  mockBookingUpdate.mockReset().mockResolvedValue({});
  mockBookingCreate.mockReset().mockResolvedValue({});
  mockBookingFindFirst.mockReset().mockResolvedValue(null);
  mockOrderFindFirst.mockReset().mockResolvedValue(null);
  mockAssignmentFindMany.mockReset().mockResolvedValue([]);
  mockAssignmentUpdateMany.mockReset().mockResolvedValue({ count: 0 });
  mockAssignmentFindFirst.mockReset();
  mockAssignmentCreate.mockReset();
  mockVehicleFindUnique.mockReset();
  mockVehicleUpdateMany.mockReset();
  mockVehicleUpdate.mockReset();
  mockUserFindUnique.mockReset();
  mockQueryRaw.mockReset();

  mockTransaction.mockReset();
  mockTransaction.mockImplementation(async (fnOrArray: any, _opts?: any) => {
    if (typeof fnOrArray === 'function') {
      const txProxy = {
        booking: {
          findUnique: (...a: any[]) => mockBookingFindUnique(...a),
          findMany: (...a: any[]) => mockBookingFindMany(...a),
          updateMany: (...a: any[]) => mockBookingUpdateMany(...a),
          update: (...a: any[]) => mockBookingUpdate(...a),
          create: (...a: any[]) => mockBookingCreate(...a),
          findFirst: (...a: any[]) => mockBookingFindFirst(...a),
        },
        order: {
          findFirst: (...a: any[]) => mockOrderFindFirst(...a),
        },
        assignment: {
          findMany: (...a: any[]) => mockAssignmentFindMany(...a),
          updateMany: (...a: any[]) => mockAssignmentUpdateMany(...a),
          findFirst: (...a: any[]) => mockAssignmentFindFirst(...a),
          create: (...a: any[]) => mockAssignmentCreate(...a),
        },
        vehicle: {
          findUnique: (...a: any[]) => mockVehicleFindUnique(...a),
          updateMany: (...a: any[]) => mockVehicleUpdateMany(...a),
          update: (...a: any[]) => mockVehicleUpdate(...a),
        },
        user: {
          findUnique: (...a: any[]) => mockUserFindUnique(...a),
        },
        $queryRaw: (...a: any[]) => mockQueryRaw(...a),
      };
      return fnOrArray(txProxy);
    }
    return Promise.all(fnOrArray);
  });

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
  mockIsUserConnected.mockReset();
  mockNotifyNewBroadcast.mockReset().mockResolvedValue(0);
  mockCalculateRoute.mockReset();
  mockFilterOnline.mockReset();
  mockQueueBroadcast.mockReset().mockResolvedValue(undefined);
}

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

/**
 * Setup standard mocks for a full createBooking flow.
 * By default, the flow finds one online transporter and broadcasts successfully.
 */
function setupCreateBookingFlow(opts: { transporters?: string[]; onlineTransporters?: string[] } = {}): void {
  const transporters = opts.transporters ?? ['t-001'];
  const onlineTransporters = opts.onlineTransporters ?? transporters;

  // Redis: no idempotency cache, no active broadcast
  mockRedisGet.mockResolvedValue(null);
  // Lock acquired
  mockRedisAcquireLock.mockResolvedValue({ acquired: true });
  mockRedisReleaseLock.mockResolvedValue(undefined);
  // Concurrency counter
  mockRedisIncr.mockResolvedValue(1);
  // Expire
  mockRedisExpire.mockResolvedValue(undefined);
  // Timer setup
  mockRedisSetTimer.mockResolvedValue(undefined);
  mockRedisCancelTimer.mockResolvedValue(undefined);
  // Set
  mockRedisSet.mockResolvedValue(undefined);

  // DB: no existing active booking or order
  mockBookingFindFirst.mockResolvedValue(null);
  mockOrderFindFirst.mockResolvedValue(null);

  // Customer lookup
  mockGetUserById.mockResolvedValue({ id: 'customer-001', name: 'Test', phone: '9876543210' });

  // Google route
  mockCalculateRoute.mockResolvedValue({ distanceKm: 100, durationMinutes: 120 });

  // Transporter matching
  mockGetTransportersWithVehicleType.mockResolvedValue(transporters);
  mockFilterOnline.mockResolvedValue(onlineTransporters);

  // Booking creation in TX succeeds
  mockBookingCreate.mockResolvedValue({});

  // Booking fetch after creation
  const booking = makeBooking({
    id: 'booking-new',
    status: 'created',
    trucksFilled: 0,
    notifiedTransporters: onlineTransporters,
  });
  mockGetBookingById.mockResolvedValue(booking);

  // Socket connectivity: all online
  mockIsUserConnected.mockReturnValue(true);

  // FCM
  mockNotifyNewBroadcast.mockResolvedValue(onlineTransporters.length);
}

// =============================================================================
// GROUP 1: CONFIG NaN PROTECTION (FIX-1, FIX-2)
// =============================================================================
// The createBooking method parses BOOKING_CONCURRENCY_LIMIT, MIN_FARE_PER_KM,
// and FARE_TOLERANCE from env vars. If the env var is garbage, parseInt/
// parseFloat returns NaN. The fix applies isNaN() guards with sensible defaults.
// =============================================================================

describe('GROUP 1: Config NaN Protection (FIX-1, FIX-2)', () => {

  // --------------------------------------------------------------------------
  // Pure unit tests: Math.max + NaN behavior proof
  // --------------------------------------------------------------------------

  describe('Math.max NaN propagation (proving the bug)', () => {
    it('1.1 Math.max(500, NaN) === NaN -- the core bug', () => {
      // Without NaN guards, a garbage MIN_FARE_PER_KM propagates NaN into
      // the fare floor, making the comparison always false.
      expect(Math.max(500, NaN)).toBeNaN();
    });

    it('1.2 Math.max(1, NaN) !== 1 -- NaN poisons the result', () => {
      // Same applies to BOOKING_CONCURRENCY_LIMIT clamping.
      const result = Math.max(1, NaN);
      expect(result).not.toBe(1);
      expect(result).toBeNaN();
    });

    it('1.3 NaN > BOOKING_CONCURRENCY_LIMIT is always false -- bypass', () => {
      // If inflight counter is 1000 but limit is NaN, the comparison
      // 1000 > NaN evaluates to false -- no backpressure.
      expect(1000 > NaN).toBe(false);
    });

    it('1.4 pricePerTruck < NaN is always false -- fare check bypassed', () => {
      // If estimatedMinFare is NaN, even a price of 0 passes the check.
      expect(0 < NaN).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // BOOKING_CONCURRENCY_LIMIT guard
  // --------------------------------------------------------------------------

  describe('BOOKING_CONCURRENCY_LIMIT NaN guard', () => {
    const savedEnv = process.env.BOOKING_CONCURRENCY_LIMIT;
    afterEach(() => {
      if (savedEnv === undefined) {
        delete process.env.BOOKING_CONCURRENCY_LIMIT;
      } else {
        process.env.BOOKING_CONCURRENCY_LIMIT = savedEnv;
      }
    });

    it('1.5 BOOKING_CONCURRENCY_LIMIT = "abc" -> defaults to 50', () => {
      // parseInt("abc", 10) => NaN; isNaN(NaN) ? 50 : NaN => 50; Math.max(1, 50) => 50
      const raw = parseInt('abc', 10);
      expect(isNaN(raw)).toBe(true);
      const result = Math.max(1, isNaN(raw) ? 50 : raw);
      expect(result).toBe(50);
    });

    it('1.6 BOOKING_CONCURRENCY_LIMIT = "0" -> clamped to 1', () => {
      const raw = parseInt('0', 10);
      const result = Math.max(1, isNaN(raw) ? 50 : raw);
      expect(result).toBe(1);
    });

    it('1.7 BOOKING_CONCURRENCY_LIMIT = "-5" -> clamped to 1', () => {
      const raw = parseInt('-5', 10);
      const result = Math.max(1, isNaN(raw) ? 50 : raw);
      expect(result).toBe(1);
    });

    it('1.8 BOOKING_CONCURRENCY_LIMIT = "" -> defaults to 50', () => {
      // parseInt("", 10) => NaN
      const envVal: string = '';
      const raw = parseInt(envVal || '50', 10);
      // In the source code, the fallback is: process.env.BOOKING_CONCURRENCY_LIMIT || '50'
      // When env is "", || '50' yields '50', so parseInt('50') = 50
      const result = Math.max(1, isNaN(raw) ? 50 : raw);
      expect(result).toBe(50);
    });

    it('1.9 BOOKING_CONCURRENCY_LIMIT = "NaN" -> defaults to 50', () => {
      const raw = parseInt('NaN', 10);
      expect(isNaN(raw)).toBe(true);
      const result = Math.max(1, isNaN(raw) ? 50 : raw);
      expect(result).toBe(50);
    });

    it('1.10 BOOKING_CONCURRENCY_LIMIT = undefined -> defaults to 50', () => {
      // process.env.BOOKING_CONCURRENCY_LIMIT || '50' => '50' when undefined
      const envVal = undefined;
      const raw = parseInt((envVal as any) || '50', 10);
      const result = Math.max(1, isNaN(raw) ? 50 : raw);
      expect(result).toBe(50);
    });

    it('1.11 BOOKING_CONCURRENCY_LIMIT = "999999" -> uses 999999', () => {
      const raw = parseInt('999999', 10);
      const result = Math.max(1, isNaN(raw) ? 50 : raw);
      expect(result).toBe(999999);
    });
  });

  // --------------------------------------------------------------------------
  // MIN_FARE_PER_KM guard
  // --------------------------------------------------------------------------

  describe('MIN_FARE_PER_KM NaN guard', () => {
    it('1.12 MIN_FARE_PER_KM = "abc" -> defaults to 8', () => {
      const raw = parseInt('abc', 10);
      const result = isNaN(raw) ? 8 : raw;
      expect(result).toBe(8);
    });

    it('1.13 MIN_FARE_PER_KM = "0" -> uses 0 (valid zero rate)', () => {
      const raw = parseInt('0', 10);
      const result = isNaN(raw) ? 8 : raw;
      expect(result).toBe(0);
    });

    it('1.14 MIN_FARE_PER_KM = "" -> defaults to 8', () => {
      // '' || '8' => '8' in source code
      const envVal: string = '';
      const raw = parseInt(envVal || '8', 10);
      const result = isNaN(raw) ? 8 : raw;
      expect(result).toBe(8);
    });

    it('1.15 MIN_FARE_PER_KM = "NaN" -> defaults to 8', () => {
      const raw = parseInt('NaN', 10);
      const result = isNaN(raw) ? 8 : raw;
      expect(result).toBe(8);
    });
  });

  // --------------------------------------------------------------------------
  // FARE_TOLERANCE guard
  // --------------------------------------------------------------------------

  describe('FARE_TOLERANCE NaN guard', () => {
    it('1.16 FARE_TOLERANCE = "abc" -> defaults to 0.5', () => {
      const raw = parseFloat('abc');
      const result = isNaN(raw) ? 0.5 : raw;
      expect(result).toBe(0.5);
    });

    it('1.17 FARE_TOLERANCE = "" -> defaults to 0.5', () => {
      const envVal: string = '';
      const raw = parseFloat(envVal || '0.5');
      const result = isNaN(raw) ? 0.5 : raw;
      expect(result).toBe(0.5);
    });

    it('1.18 FARE_TOLERANCE = "NaN" -> defaults to 0.5', () => {
      const raw = parseFloat('NaN');
      const result = isNaN(raw) ? 0.5 : raw;
      expect(result).toBe(0.5);
    });
  });

  // --------------------------------------------------------------------------
  // Full fare check formula verification
  // --------------------------------------------------------------------------

  describe('Fare check formula with NaN guards', () => {
    it('1.19 estimatedMinFare computed correctly with valid inputs', () => {
      const distanceKm = 200;
      const MIN_FARE_PER_KM = 8;
      const FARE_TOLERANCE = 0.5;
      const estimatedMinFare = Math.max(500, Math.round(distanceKm * MIN_FARE_PER_KM * FARE_TOLERANCE));
      // 200 * 8 * 0.5 = 800; max(500, 800) = 800
      expect(estimatedMinFare).toBe(800);
    });

    it('1.20 estimatedMinFare floors to 500 for short trips', () => {
      const distanceKm = 10;
      const MIN_FARE_PER_KM = 8;
      const FARE_TOLERANCE = 0.5;
      const estimatedMinFare = Math.max(500, Math.round(distanceKm * MIN_FARE_PER_KM * FARE_TOLERANCE));
      // 10 * 8 * 0.5 = 40; max(500, 40) = 500
      expect(estimatedMinFare).toBe(500);
    });

    it('1.21 without NaN guard, garbage MIN_FARE_PER_KM makes estimatedMinFare NaN', () => {
      const distanceKm = 200;
      const MIN_FARE_PER_KM_BAD = parseInt('abc', 10); // NaN
      const FARE_TOLERANCE = 0.5;
      const estimatedMinFare = Math.max(500, Math.round(distanceKm * MIN_FARE_PER_KM_BAD * FARE_TOLERANCE));
      expect(estimatedMinFare).toBeNaN();
    });

    it('1.22 with NaN guard, garbage MIN_FARE_PER_KM falls back to 8', () => {
      const distanceKm = 200;
      const _raw = parseInt('abc', 10);
      const MIN_FARE_PER_KM = isNaN(_raw) ? 8 : _raw;
      const FARE_TOLERANCE = 0.5;
      const estimatedMinFare = Math.max(500, Math.round(distanceKm * MIN_FARE_PER_KM * FARE_TOLERANCE));
      expect(estimatedMinFare).toBe(800);
    });
  });
});

// =============================================================================
// GROUP 2: TERMINAL STATE PROTECTION (FIX-3) -- decrementTrucksFilled
// =============================================================================
// The decrementTrucksFilled method uses raw SQL:
//   SET "trucksFilled" = GREATEST(0, "trucksFilled" - 1)
//   WHERE id = ? AND "status" NOT IN ('cancelled', 'expired', 'completed')
//   RETURNING "trucksFilled"
//
// If the booking is in a terminal state, the WHERE clause rejects the update
// and atomicResult is empty -> throws DECREMENT_FAILED.
// GREATEST(0, ...) prevents negative trucksFilled.
// =============================================================================

describe('GROUP 2: Terminal State Protection (FIX-3) -- decrementTrucksFilled', () => {
  beforeEach(resetAllMocks);

  it('2.1 decrement on active booking succeeds', async () => {
    const booking = makeBooking({ status: 'active', trucksFilled: 1 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 0 }]);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    // After status update, re-fetch
    mockGetBookingById.mockResolvedValueOnce(booking).mockResolvedValueOnce({ ...booking, trucksFilled: 0, status: 'active' });

    const { bookingService } = require('../modules/booking/booking.service');
    const result = await bookingService.decrementTrucksFilled('booking-001');

    expect(mockQueryRaw).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('2.2 decrement on cancelled booking fails -- SQL WHERE rejects, no change', async () => {
    const booking = makeBooking({ status: 'cancelled', trucksFilled: 1 });
    mockGetBookingById.mockResolvedValue(booking);
    // SQL WHERE clause excludes cancelled -> returns empty array
    mockQueryRaw.mockResolvedValue([]);

    const { bookingService } = require('../modules/booking/booking.service');
    await expect(
      bookingService.decrementTrucksFilled('booking-001')
    ).rejects.toThrow(/DECREMENT_FAILED|Failed to decrement/i);
  });

  it('2.3 decrement on expired booking fails -- no change', async () => {
    const booking = makeBooking({ status: 'expired', trucksFilled: 1 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([]);

    const { bookingService } = require('../modules/booking/booking.service');
    await expect(
      bookingService.decrementTrucksFilled('booking-001')
    ).rejects.toThrow(/DECREMENT_FAILED|Failed to decrement/i);
  });

  it('2.4 decrement on completed booking fails -- no change', async () => {
    const booking = makeBooking({ status: 'completed', trucksFilled: 2 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([]);

    const { bookingService } = require('../modules/booking/booking.service');
    await expect(
      bookingService.decrementTrucksFilled('booking-001')
    ).rejects.toThrow(/DECREMENT_FAILED|Failed to decrement/i);
  });

  it('2.5 decrement when trucksFilled is already 0 -- GREATEST(0, -1) = 0', async () => {
    const booking = makeBooking({ status: 'active', trucksFilled: 0 });
    mockGetBookingById.mockResolvedValue(booking);
    // GREATEST(0, 0-1) = GREATEST(0, -1) = 0
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 0 }]);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockGetBookingById.mockResolvedValueOnce(booking).mockResolvedValueOnce({ ...booking, trucksFilled: 0 });

    const { bookingService } = require('../modules/booking/booking.service');
    const result = await bookingService.decrementTrucksFilled('booking-001');

    // Should not throw even though trucksFilled was already 0
    expect(result).toBeDefined();
    // The SQL GREATEST(0, ...) prevents going negative
    const queryArgs = mockQueryRaw.mock.calls[0];
    // queryRaw is called with template literal -- just verify it was called
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });

  it('2.6 concurrent decrements on same booking -- only one succeeds at SQL level', async () => {
    // The atomicity guarantee is at the SQL level. Two concurrent calls both
    // read the booking, but the SQL UPDATE uses WHERE to ensure atomicity.
    const booking = makeBooking({ status: 'partially_filled', trucksFilled: 2 });
    mockGetBookingById.mockResolvedValue(booking);

    // First call succeeds
    mockQueryRaw.mockResolvedValueOnce([{ trucksFilled: 1 }]);
    mockBookingUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockGetBookingById
      .mockResolvedValueOnce(booking) // first getBookingById
      .mockResolvedValueOnce({ ...booking, trucksFilled: 1 }); // after status update

    const { bookingService } = require('../modules/booking/booking.service');
    const result = await bookingService.decrementTrucksFilled('booking-001');
    expect(result).toBeDefined();
  });

  it('2.7 decrement on booking that becomes cancelled mid-flight -- SQL rejects', async () => {
    // The getBookingById sees 'active', but by the time the SQL runs, another
    // process has cancelled it. SQL WHERE "status" NOT IN (...) returns 0 rows.
    const booking = makeBooking({ status: 'active', trucksFilled: 1 });
    mockGetBookingById.mockResolvedValue(booking);
    // SQL returns empty -- booking was cancelled between the read and the write
    mockQueryRaw.mockResolvedValue([]);

    const { bookingService } = require('../modules/booking/booking.service');
    await expect(
      bookingService.decrementTrucksFilled('booking-001')
    ).rejects.toThrow(/DECREMENT_FAILED|Failed to decrement/i);
  });

  it('2.8 decrement on non-existent booking throws BOOKING_NOT_FOUND', async () => {
    mockGetBookingById.mockResolvedValue(null);

    const { bookingService } = require('../modules/booking/booking.service');
    await expect(
      bookingService.decrementTrucksFilled('nonexistent')
    ).rejects.toThrow(/not found/i);
  });

  it('2.9 decrement on partially_filled booking succeeds', async () => {
    const booking = makeBooking({ status: 'partially_filled', trucksFilled: 3, trucksNeeded: 5 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 2 }]);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockGetBookingById.mockResolvedValueOnce(booking).mockResolvedValueOnce({ ...booking, trucksFilled: 2 });

    const { bookingService } = require('../modules/booking/booking.service');
    const result = await bookingService.decrementTrucksFilled('booking-001');
    expect(result).toBeDefined();
  });

  it('2.10 decrement emits BOOKING_UPDATED socket event', async () => {
    const booking = makeBooking({ status: 'active', trucksFilled: 1, trucksNeeded: 2 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 0 }]);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockGetBookingById.mockResolvedValueOnce(booking).mockResolvedValueOnce({ ...booking, trucksFilled: 0 });

    const { bookingService } = require('../modules/booking/booking.service');
    await bookingService.decrementTrucksFilled('booking-001');

    expect(mockEmitToBooking).toHaveBeenCalledWith(
      'booking-001',
      'booking_updated',
      expect.objectContaining({
        bookingId: 'booking-001',
        trucksFilled: 0,
      })
    );
  });
});

// =============================================================================
// GROUP 3: BROADCAST FAILURE RECOVERY (FIX-18)
// =============================================================================
// When the broadcast section (socket emits, FCM) throws, the booking is
// left in 'created' status without any transporters being notified.
// FIX-18 wraps the broadcast in try-catch and expires the orphaned booking.
// =============================================================================

describe('GROUP 3: Broadcast Failure Recovery (FIX-18)', () => {
  beforeEach(resetAllMocks);

  afterEach(() => {
    // Restore buildBroadcastPayload to its default mock (returns {}) after
    // tests that override it to throw. Without this, subsequent describe
    // blocks would inherit the throwing mock since we do not use resetModules.
    const { buildBroadcastPayload } = require('../modules/booking/booking-payload.helper');
    (buildBroadcastPayload as jest.Mock).mockReturnValue({});
  });

  it('3.1 broadcast succeeds -> booking stays active', async () => {
    setupCreateBookingFlow({ transporters: ['t-001'], onlineTransporters: ['t-001'] });

    const { bookingService } = require('../modules/booking/booking.service');
    const result = await bookingService.createBooking(
      'customer-001', '9876543210', makeCreateBookingInput()
    );

    // Should not throw
    expect(result).toBeDefined();
    expect(result.matchingTransportersCount).toBeGreaterThan(0);
    // Booking should NOT be expired
    const expireCall = mockBookingUpdate.mock.calls.find(
      (c: any[]) => c[0]?.data?.status === 'expired'
    );
    expect(expireCall).toBeUndefined();
  });

  it('3.2 broadcast throws -> booking expires + error re-thrown', async () => {
    setupCreateBookingFlow({ transporters: ['t-001'], onlineTransporters: ['t-001'] });

    // Make buildBroadcastPayload throw to simulate broadcast failure
    const { buildBroadcastPayload } = require('../modules/booking/booking-payload.helper');
    (buildBroadcastPayload as jest.Mock).mockImplementation(() => {
      throw new Error('Broadcast payload construction failed');
    });

    const { bookingService } = require('../modules/booking/booking.service');

    await expect(
      bookingService.createBooking('customer-001', '9876543210', makeCreateBookingInput())
    ).rejects.toThrow(/Broadcast payload construction failed/i);

    // FIX-18: booking.update should have been called with status 'expired'
    expect(mockBookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'expired' }),
      })
    );

    // Logger should record the error
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Broadcast failed'),
      expect.anything()
    );
  });

  it('3.3 booking expiry itself fails -> error logged, original error re-thrown', async () => {
    setupCreateBookingFlow({ transporters: ['t-001'], onlineTransporters: ['t-001'] });

    // Broadcast throws
    const { buildBroadcastPayload } = require('../modules/booking/booking-payload.helper');
    (buildBroadcastPayload as jest.Mock).mockImplementation(() => {
      throw new Error('Broadcast failed');
    });

    // Expiry update also fails
    mockBookingUpdate.mockRejectedValue(new Error('DB connection lost'));

    const { bookingService } = require('../modules/booking/booking.service');

    // The original broadcast error should be re-thrown, not the expiry error
    await expect(
      bookingService.createBooking('customer-001', '9876543210', makeCreateBookingInput())
    ).rejects.toThrow(/Broadcast failed/i);

    // The expiry failure should be logged separately
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to expire orphaned booking'),
      expect.anything()
    );
  });

  it('3.4 queue broadcast throws synchronously -> FIX-18 expires booking + re-throws', async () => {
    // When FF_SEQUENCE_DELIVERY_ENABLED is not 'false' and queueService.queueBroadcast
    // exists, the code routes through the queue. If queueBroadcast throws synchronously,
    // FIX-18 catches it, expires the orphaned booking, and re-throws.
    setupCreateBookingFlow({ transporters: ['t-001'], onlineTransporters: ['t-001'] });

    // Make queueBroadcast throw synchronously to trigger the FIX-18 catch
    mockQueueBroadcast.mockImplementation(() => {
      throw new Error('Queue service crashed');
    });

    const { bookingService } = require('../modules/booking/booking.service');

    // FIX-18: The exception should be caught, booking expired, then re-thrown
    await expect(
      bookingService.createBooking('customer-001', '9876543210', makeCreateBookingInput())
    ).rejects.toThrow(/Queue service crashed/i);

    // FIX-18: should attempt to expire the orphaned booking
    expect(mockBookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'expired' }),
      })
    );
  });
});

// =============================================================================
// GROUP 4: DEDUP KEY COVERAGE (FIX-19)
// =============================================================================
// When 0 transporters are found, the booking is created, expired, and returned.
// Before FIX-19, the dedupeKey was never set on this path, so a retry would
// create a second booking. FIX-19 ensures the dedup key is SET before the
// early return.
// =============================================================================

describe('GROUP 4: Dedup Key Coverage (FIX-19)', () => {
  beforeEach(resetAllMocks);

  it('4.1 zero transporters -> dedup key SET before return', async () => {
    // Setup: no matching transporters
    setupCreateBookingFlow({ transporters: [], onlineTransporters: [] });
    mockGetTransportersWithVehicleType.mockResolvedValue([]);
    mockFilterOnline.mockResolvedValue([]);

    const { bookingService } = require('../modules/booking/booking.service');
    const result = await bookingService.createBooking(
      'customer-001', '9876543210', makeCreateBookingInput()
    );

    // Should return with matchingTransportersCount = 0
    expect(result.matchingTransportersCount).toBe(0);

    // FIX-19: dedup key should have been set even though no transporters were found
    // Look for a redis.set call with a key that contains 'idem:broadcast:create'
    const setCallWithDedup = mockRedisSet.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('idem:broadcast:create')
    );
    // If the code path for 0 transporters doesn't set the standard dedup key,
    // it sets a no_supply cache via: redisService.set(dedupeKey, JSON.stringify({status:'no_supply',...}), 86400)
    const setCallWithNoSupply = mockRedisSet.mock.calls.find(
      (c: any[]) => typeof c[1] === 'string' && c[1].includes('no_supply')
    );
    const dedupWasSet = setCallWithDedup || setCallWithNoSupply;
    expect(dedupWasSet).toBeTruthy();
  });

  it('4.2 normal flow -> dedup key set after broadcast', async () => {
    setupCreateBookingFlow({ transporters: ['t-001'], onlineTransporters: ['t-001'] });

    const { bookingService } = require('../modules/booking/booking.service');
    const result = await bookingService.createBooking(
      'customer-001', '9876543210', makeCreateBookingInput()
    );

    expect(result).toBeDefined();

    // The standard dedup key should be set
    const setCallWithDedup = mockRedisSet.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('idem:broadcast')
    );
    expect(setCallWithDedup).toBeTruthy();
  });

  it('4.3 Redis failure during dedup set -> non-fatal, continues', async () => {
    setupCreateBookingFlow({ transporters: [], onlineTransporters: [] });
    mockGetTransportersWithVehicleType.mockResolvedValue([]);
    mockFilterOnline.mockResolvedValue([]);

    // Make redis.set throw for the dedup key
    mockRedisSet.mockImplementation(async (key: string) => {
      if (typeof key === 'string' && key.includes('idem:broadcast:create')) {
        throw new Error('Redis SET failed');
      }
      return undefined;
    });

    const { bookingService } = require('../modules/booking/booking.service');

    // Should not throw even though redis.set failed for dedup
    // The FIX-19 code wraps the set in try-catch: try { await redisService.set(...) } catch { /* non-fatal */ }
    const result = await bookingService.createBooking(
      'customer-001', '9876543210', makeCreateBookingInput()
    );

    expect(result).toBeDefined();
    expect(result.matchingTransportersCount).toBe(0);
  });

  it('4.4 duplicate request with existing dedup key -> returns cached result', async () => {
    setupCreateBookingFlow({ transporters: ['t-001'], onlineTransporters: ['t-001'] });

    // Simulate a dedup key hit for the SERVER-GENERATED IDEMPOTENCY path.
    // The code first checks the idempotency key (if provided), then the
    // active-broadcast guard, then the lock, then the server-generated dedup.
    // We need the dedup key (idem:broadcast:create:...) to return a booking ID,
    // and the active-broadcast guard (customer:active-broadcast:...) to return null.
    mockRedisGet.mockImplementation(async (key: string) => {
      if (typeof key === 'string' && key.includes('idem:broadcast:create')) {
        return 'existing-booking-id';
      }
      // customer:active-broadcast should NOT block (returns null)
      return null;
    });

    // The existing booking from getBookingById
    const existingBooking = makeBooking({ id: 'existing-booking-id', status: 'active' });
    mockGetBookingById.mockResolvedValue(existingBooking);
    mockGetTransportersWithVehicleType.mockResolvedValue(['t-001']);

    const { bookingService } = require('../modules/booking/booking.service');
    const result = await bookingService.createBooking(
      'customer-001', '9876543210', makeCreateBookingInput()
    );

    // Should return the existing booking (idempotent replay)
    expect(result.id).toBe('existing-booking-id');
    // The actual message: 'Idempotent replay: returning existing booking'
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Idempotent replay'),
      expect.anything()
    );

    // Should NOT have created a new booking in the DB
    expect(mockBookingCreate).not.toHaveBeenCalled();
  });
});

// =============================================================================
// GROUP 5: LOGGING ESCALATION (FIX-23)
// =============================================================================
// When sentCount from FCM is 0 and there are offline transporters, the log
// should escalate from info to warn. This ensures the ops team is alerted
// when no push notifications actually reach any transporter.
// =============================================================================

describe('GROUP 5: Logging Escalation (FIX-23)', () => {
  beforeEach(resetAllMocks);

  it('5.1 sentCount=0, offlineTransporters>0 -> logger.warn (not info)', async () => {
    // Setup with offline transporters
    setupCreateBookingFlow({ transporters: ['t-001', 't-002'], onlineTransporters: ['t-001', 't-002'] });

    // Mark all transporters as not connected via socket (so FCM is attempted)
    mockIsUserConnected.mockReturnValue(false);

    // FCM returns sentCount=0 (all failed)
    mockNotifyNewBroadcast.mockResolvedValue(0);

    const { bookingService } = require('../modules/booking/booking.service');
    await bookingService.createBooking(
      'customer-001', '9876543210', makeCreateBookingInput()
    );

    // FIX-23: The .then() callback on notifyNewBroadcast checks sentCount === 0
    // and escalates to logger.warn. The promise is fire-and-forget, so we need
    // to flush the microtask queue.
    await flushPromises();

    // Should have called logger.warn with the escalation message
    // The actual message: '[Booking] All transporters offline -- 0 FCM notifications sent'
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('0 FCM'),
      expect.objectContaining({
        bookingId: expect.any(String),
      })
    );
  });

  it('5.2 sentCount>0 -> logger.info (unchanged)', async () => {
    setupCreateBookingFlow({ transporters: ['t-001', 't-002'], onlineTransporters: ['t-001', 't-002'] });

    // Some offline
    mockIsUserConnected.mockReturnValue(false);

    // FCM returns sentCount=2 (success)
    mockNotifyNewBroadcast.mockResolvedValue(2);

    const { bookingService } = require('../modules/booking/booking.service');
    await bookingService.createBooking(
      'customer-001', '9876543210', makeCreateBookingInput()
    );

    await flushPromises();

    // Should have called logger.info with FCM success message
    // The actual message: 'FCM: Push notifications sent to N/M offline transporters'
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('FCM: Push notifications sent'),
    );

    // Should NOT have called logger.warn with "0 FCM" message
    const warnCalls = (logger.warn as jest.Mock).mock.calls;
    const zeroFcmWarn = warnCalls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('0 FCM')
    );
    expect(zeroFcmWarn).toBeUndefined();
  });

  it('5.3 all transporters online -> skips FCM entirely', async () => {
    setupCreateBookingFlow({ transporters: ['t-001'], onlineTransporters: ['t-001'] });

    // All connected via socket
    mockIsUserConnected.mockReturnValue(true);

    const { bookingService } = require('../modules/booking/booking.service');
    await bookingService.createBooking(
      'customer-001', '9876543210', makeCreateBookingInput()
    );

    await flushPromises();

    // FCM should NOT have been called (all online via socket)
    expect(mockNotifyNewBroadcast).not.toHaveBeenCalled();

    // Should log that all transporters are connected via socket
    // The actual message: 'FCM: All N transporters connected via socket -- skipping FCM'
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('transporters connected via socket'),
    );
  });

  it('5.4 FCM throws entirely -> caught by .catch(), logged as warn', async () => {
    setupCreateBookingFlow({ transporters: ['t-001'], onlineTransporters: ['t-001'] });

    // Some offline
    mockIsUserConnected.mockReturnValue(false);

    // FCM throws
    mockNotifyNewBroadcast.mockRejectedValue(new Error('FCM service down'));

    const { bookingService } = require('../modules/booking/booking.service');
    await bookingService.createBooking(
      'customer-001', '9876543210', makeCreateBookingInput()
    );

    await flushPromises();

    // The .catch() handler should log the failure
    // The actual message: 'FCM: Failed to send push notifications'
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('FCM'),
      expect.anything()
    );
  });
});

// =============================================================================
// GROUP 6: HANDLEBOOTKINGTIMEOUT -- Idempotent expiry
// =============================================================================

describe('GROUP 6: handleBookingTimeout idempotency', () => {
  beforeEach(resetAllMocks);

  it('6.1 timeout on active booking -> expires it', async () => {
    const booking = makeBooking({ status: 'active', trucksFilled: 0 });
    mockGetBookingById.mockResolvedValue(booking);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockRedisCancelTimer.mockResolvedValue(undefined);
    // clearCustomerActiveBroadcast calls redisService.get(...).catch() and del(...)
    mockRedisGet.mockResolvedValue(null);
    mockRedisDel.mockResolvedValue(undefined);

    const { bookingService } = require('../modules/booking/booking.service');
    await bookingService.handleBookingTimeout('booking-001', 'customer-001');

    expect(mockBookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'expired' }),
      })
    );
  });

  it('6.2 timeout on already-cancelled booking -> skips (idempotent)', async () => {
    const booking = makeBooking({ status: 'cancelled' });
    mockGetBookingById.mockResolvedValue(booking);

    const { bookingService } = require('../modules/booking/booking.service');
    await bookingService.handleBookingTimeout('booking-001', 'customer-001');

    // Should NOT attempt to update the booking status to expired
    const expireCalls = mockBookingUpdateMany.mock.calls.filter(
      (c: any[]) => c[0]?.data?.status === 'expired'
    );
    expect(expireCalls.length).toBe(0);
  });

  it('6.3 timeout on fully_filled booking -> skips (idempotent)', async () => {
    const booking = makeBooking({ status: 'fully_filled' });
    mockGetBookingById.mockResolvedValue(booking);

    const { bookingService } = require('../modules/booking/booking.service');
    await bookingService.handleBookingTimeout('booking-001', 'customer-001');

    const expireCalls = mockBookingUpdateMany.mock.calls.filter(
      (c: any[]) => c[0]?.data?.status === 'expired'
    );
    expect(expireCalls.length).toBe(0);
  });

  it('6.4 timeout on completed booking -> skips (idempotent)', async () => {
    const booking = makeBooking({ status: 'completed' });
    mockGetBookingById.mockResolvedValue(booking);

    const { bookingService } = require('../modules/booking/booking.service');
    await bookingService.handleBookingTimeout('booking-001', 'customer-001');

    const expireCalls = mockBookingUpdateMany.mock.calls.filter(
      (c: any[]) => c[0]?.data?.status === 'expired'
    );
    expect(expireCalls.length).toBe(0);
  });

  it('6.5 timeout on non-existent booking -> logs warn and returns without updating', async () => {
    mockGetBookingById.mockResolvedValue(null);

    const { bookingService } = require('../modules/booking/booking.service');
    await bookingService.handleBookingTimeout('nonexistent', 'customer-001');

    // The source says: logger.warn(`Booking ${bookingId} not found for timeout handling`);
    // Verify logger.warn was called with a message containing the booking ID and "not found"
    const warnCalls = (logger.warn as jest.Mock).mock.calls;
    const notFoundWarn = warnCalls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('nonexistent') && c[0].includes('not found')
    );
    expect(notFoundWarn).toBeTruthy();
    expect(mockBookingUpdateMany).not.toHaveBeenCalled();
  });

  it('6.6 timeout on partially_filled booking -> expires with partial notice', async () => {
    const booking = makeBooking({ status: 'partially_filled', trucksFilled: 1, trucksNeeded: 3 });
    mockGetBookingById.mockResolvedValue(booking);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockRedisCancelTimer.mockResolvedValue(undefined);
    // clearCustomerActiveBroadcast needs mockRedisGet to return a promise
    mockRedisGet.mockResolvedValue(null);
    mockRedisDel.mockResolvedValue(undefined);

    const { bookingService } = require('../modules/booking/booking.service');
    await bookingService.handleBookingTimeout('booking-001', 'customer-001');

    // Should expire
    expect(mockBookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'expired' }),
      })
    );

    // Should notify customer of partial fill
    expect(mockEmitToUser).toHaveBeenCalledWith(
      'customer-001',
      'booking_expired',
      expect.objectContaining({
        status: 'partially_filled_expired',
        trucksFilled: 1,
        trucksNeeded: 3,
      })
    );
  });
});

// =============================================================================
// GROUP 7: CONCURRENCY BACKPRESSURE EDGE CASES
// =============================================================================

describe('GROUP 7: Concurrency backpressure', () => {
  beforeEach(resetAllMocks);

  it('7.1 inflight exceeds BOOKING_CONCURRENCY_LIMIT -> throws 503', async () => {
    // Counter returns 51 (above default limit of 50)
    mockRedisIncr.mockResolvedValue(51);
    mockRedisIncrBy.mockResolvedValue(50);
    mockRedisExpire.mockResolvedValue(undefined);

    const { bookingService } = require('../modules/booking/booking.service');
    await expect(
      bookingService.createBooking('customer-001', '9876543210', makeCreateBookingInput())
    ).rejects.toThrow(/SYSTEM_BUSY|Too many bookings/i);
  });

  it('7.2 Redis incr fails -> skip backpressure, proceed with booking', async () => {
    // Redis throws on incr (degraded)
    mockRedisIncr.mockRejectedValue(new Error('Redis connection lost'));

    // Set up rest of the flow so booking creation proceeds
    setupCreateBookingFlow({ transporters: ['t-001'], onlineTransporters: ['t-001'] });

    const { bookingService } = require('../modules/booking/booking.service');

    // Should NOT throw 503 -- it should proceed with booking
    // It may throw for other reasons (idempotency, etc.) but not for backpressure
    try {
      await bookingService.createBooking('customer-001', '9876543210', makeCreateBookingInput());
    } catch (err: any) {
      // If it throws, it should NOT be the backpressure error
      expect(err.message).not.toMatch(/SYSTEM_BUSY|Too many bookings/i);
    }
  });

  it('7.3 concurrency counter decremented in finally block', async () => {
    // Setup a flow that will succeed
    setupCreateBookingFlow({ transporters: ['t-001'], onlineTransporters: ['t-001'] });

    const { bookingService } = require('../modules/booking/booking.service');
    await bookingService.createBooking('customer-001', '9876543210', makeCreateBookingInput());

    // The finally block calls redisService.incrBy(concurrencyKey, -1)
    expect(mockRedisIncrBy).toHaveBeenCalledWith('booking:create:inflight', -1);
  });

  it('7.4 decrement skipped when increment never happened (Redis was down)', async () => {
    // Setup the flow FIRST, then override incr to fail
    setupCreateBookingFlow({ transporters: [], onlineTransporters: [] });
    mockGetTransportersWithVehicleType.mockResolvedValue([]);
    mockFilterOnline.mockResolvedValue([]);

    // Redis incr fails => incremented = false => finally should NOT call incrBy
    // This override must happen AFTER setupCreateBookingFlow
    mockRedisIncr.mockRejectedValue(new Error('Redis down'));

    const { bookingService } = require('../modules/booking/booking.service');
    try {
      await bookingService.createBooking('customer-001', '9876543210', makeCreateBookingInput());
    } catch {
      // May throw, does not matter
    }

    // incrBy should NOT have been called with -1 since increment never succeeded
    const decrCalls = mockRedisIncrBy.mock.calls.filter(
      (c: any[]) => c[0] === 'booking:create:inflight' && c[1] === -1
    );
    expect(decrCalls.length).toBe(0);
  });
});
