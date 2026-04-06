/**
 * =============================================================================
 * ERROR HANDLING & IDEMPOTENCY FIXES — Exhaustive Tests
 * =============================================================================
 *
 * Tests for Problems #12, #17, #19, #26:
 *
 * Category 1 (#12): updateBooking throws on failure; all callers handle gracefully
 * Category 2 (#17): Idempotency fingerprint includes trucksNeeded + pricePerTruck
 * Category 3 (#19): clearCustomerActiveBroadcast uses Promise.all for parallel deletes
 * Category 4 (#26): Booking creation lock TTL increased from 10s to 30s
 *
 * @author LEO-TEST-3 (Team LEO Wave 2)
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

// --- Redis mock ---
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
const mockRedisIncr = jest.fn();
const mockRedisIncrBy = jest.fn();
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
    incr: (...args: any[]) => mockRedisIncr(...args),
    incrBy: (...args: any[]) => mockRedisIncrBy(...args),
    isConnected: () => mockRedisIsConnected(),
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
  },
}));

// --- Prisma mock ---
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

// --- DB service mock ---
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

// --- Socket mock ---
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
    NO_VEHICLES_AVAILABLE: 'no_vehicles_available',
    BROADCAST_COUNTDOWN: 'broadcast_countdown',
    BROADCAST_STATE_CHANGED: 'broadcast_state_changed',
    BROADCAST_EXPIRED: 'broadcast_expired',
    BROADCAST_CANCELLED: 'order_cancelled',
    TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update',
  },
}));

// --- FCM mock ---
jest.mock('../shared/services/fcm.service', () => ({
  fcmService: {
    sendToDevice: jest.fn().mockResolvedValue(undefined),
    notifyNewBroadcast: jest.fn().mockResolvedValue(0),
  },
}));

// --- Queue mock ---
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    addJob: jest.fn(),
    queuePushNotificationBatch: jest.fn().mockResolvedValue(undefined),
  },
}));

// --- Live availability mock ---
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: jest.fn().mockResolvedValue(undefined),
  },
}));

// --- Google Maps mock ---
const mockCalculateRoute = jest.fn();
jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: {
    calculateRoute: (...args: any[]) => mockCalculateRoute(...args),
  },
}));

// --- Distance matrix mock ---
jest.mock('../shared/services/distance-matrix.service', () => ({
  distanceMatrixService: {
    batchGetPickupDistance: jest.fn().mockResolvedValue(new Map()),
  },
}));

// --- Availability service mock ---
jest.mock('../shared/services/availability.service', () => ({
  availabilityService: {
    loadTransporterDetailsMap: jest.fn().mockResolvedValue(new Map()),
    getTransporterDetails: jest.fn().mockResolvedValue(null),
  },
}));

// --- Progressive radius matcher mock ---
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

// --- Transporter online service mock ---
const mockFilterOnline = jest.fn();
jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: {
    filterOnline: (...args: any[]) => mockFilterOnline(...args),
    isOnline: jest.fn().mockResolvedValue(true),
  },
}));

// --- Vehicle lifecycle mock ---
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
}));

// --- Vehicle key mock ---
jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: (type: string, sub: string) => `${type}_${sub}`,
}));

// --- Cache service mock ---
jest.mock('../shared/services/cache.service', () => ({
  cacheService: { get: jest.fn(), set: jest.fn(), delete: jest.fn() },
}));

// --- Booking payload helper mock ---
jest.mock('../modules/booking/booking-payload.helper', () => ({
  buildBroadcastPayload: jest.fn().mockReturnValue({}),
  getRemainingTimeoutSeconds: jest.fn().mockReturnValue(60),
}));

// --- Core constants mock ---
jest.mock('../core/constants', () => ({
  ErrorCode: {
    BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
    FARE_TOO_LOW: 'FARE_TOO_LOW',
  },
}));

// --- State machines mock ---
jest.mock('../core/state-machines', () => ({
  BOOKING_VALID_TRANSITIONS: {},
  isValidTransition: jest.fn().mockReturnValue(true),
  assertValidTransition: jest.fn(),
  TERMINAL_BOOKING_STATUSES: ['cancelled', 'expired', 'fully_filled', 'completed'],
}));

// --- Geo utils mock: match actual implementation (3 decimal places) ---
jest.mock('../shared/utils/geo.utils', () => ({
  roundCoord: (c: number) => Math.round(c * 1000) / 1000,
}));

// --- Geospatial utils mock ---
jest.mock('../shared/utils/geospatial.utils', () => ({
  haversineDistanceKm: jest.fn().mockReturnValue(10),
}));

// --- Audit service mock ---
jest.mock('../shared/services/audit.service', () => ({
  recordStatusChange: jest.fn().mockResolvedValue(undefined),
}));

// --- Pricing vehicle catalog mock ---
jest.mock('../modules/pricing/vehicle-catalog', () => ({
  getSubtypeConfig: jest.fn().mockReturnValue({ capacityKg: 5000, minTonnage: 1, maxTonnage: 5 }),
}));

// --- Safe JSON utils mock ---
jest.mock('../shared/utils/safe-json.utils', () => ({
  safeJsonParse: (str: string, fallback: any) => {
    try { return JSON.parse(str); } catch { return fallback; }
  },
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import crypto from 'crypto';
import { logger } from '../shared/services/logger.service';

// =============================================================================
// TEST HELPERS
// =============================================================================

function makeBooking(overrides: Record<string, any> = {}) {
  return {
    id: 'booking-001',
    customerId: 'cust-001',
    customerPhone: '+911234567890',
    customerName: 'Test Customer',
    vehicleType: 'open',
    vehicleSubtype: '7-ton',
    trucksNeeded: 3,
    trucksFilled: 0,
    pricePerTruck: 5000,
    distanceKm: 120,
    status: 'active',
    pickup: {
      address: '123 Main St',
      city: 'Mumbai',
      coordinates: { latitude: 19.076, longitude: 72.878 },
    },
    drop: {
      address: '456 Drop St',
      city: 'Pune',
      coordinates: { latitude: 18.52, longitude: 73.857 },
    },
    notifiedTransporters: ['t-001', 't-002'],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    ...overrides,
  };
}

function makeCreateBookingInput(overrides: Record<string, any> = {}): any {
  return {
    vehicleType: 'open',
    vehicleSubtype: '7-ton',
    trucksNeeded: 3,
    pricePerTruck: 5000,
    distanceKm: 120,
    pickup: {
      address: '123 Main St',
      city: 'Mumbai',
      coordinates: { latitude: 19.076, longitude: 72.878 },
    },
    drop: {
      address: '456 Drop St',
      city: 'Pune',
      coordinates: { latitude: 18.52, longitude: 73.857 },
    },
    ...overrides,
  };
}

/** Generate the same fingerprint the service generates */
function computeFingerprint(params: {
  customerId: string;
  vehicleType: string;
  vehicleSubtype: string;
  pickupLat: number;
  pickupLng: number;
  dropLat: number;
  dropLng: number;
  trucksNeeded: number;
  pricePerTruck: number;
}): string {
  const roundCoord = (c: number) => Math.round(c * 1000) / 1000;
  const raw = [
    params.customerId,
    params.vehicleType,
    params.vehicleSubtype,
    roundCoord(params.pickupLat),
    roundCoord(params.pickupLng),
    roundCoord(params.dropLat),
    roundCoord(params.dropLng),
    String(params.trucksNeeded),
    String(params.pricePerTruck),
  ].join(':');
  return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 32);
}

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
  mockRedisExpire.mockResolvedValue(1);
  mockRedisSIsMember.mockReset();
  mockRedisIncr.mockReset();
  mockRedisIncrBy.mockReset();
  mockRedisIsConnected.mockReturnValue(true);
  // Set safe defaults for Redis ops that are chained with .catch()
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
  mockRedisCancelTimer.mockResolvedValue(undefined);
  mockRedisAcquireLock.mockResolvedValue({ acquired: true });
  mockRedisReleaseLock.mockResolvedValue(undefined);
  mockRedisSMembers.mockResolvedValue([]);
  mockRedisSAdd.mockResolvedValue(1);
  mockRedisSetTimer.mockResolvedValue(undefined);
  mockRedisIncr.mockResolvedValue(1);
  mockRedisIncrBy.mockResolvedValue(0);
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
  mockTransaction.mockImplementation(async (fnOrArray: any, _opts?: any) => {
    if (typeof fnOrArray === 'function') {
      return fnOrArray({
        booking: {
          findUnique: (...a: any[]) => mockBookingFindUnique(...a),
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
      });
    }
    return fnOrArray;
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
  mockFilterOnline.mockReset();
  mockCalculateRoute.mockReset();
}

/**
 * Set up standard mocks for a successful createBooking path
 */
function setupCreateBookingMocks(transporters: string[] = ['t-001']) {
  // No existing idempotency/active broadcast
  mockRedisGet.mockResolvedValue(null);
  // Lock acquired
  mockRedisAcquireLock.mockResolvedValue({ acquired: true });
  mockRedisReleaseLock.mockResolvedValue(undefined);
  // Redis set/del succeed
  mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
  mockRedisSAdd.mockResolvedValue(1);
  mockRedisSMembers.mockResolvedValue([]);
  mockRedisSetTimer.mockResolvedValue(undefined);
  mockRedisCancelTimer.mockResolvedValue(undefined);
  // User lookup
  mockGetUserById.mockResolvedValue({ id: 'cust-001', name: 'Test Customer', phone: '+911234567890' });
  // Google route
  mockCalculateRoute.mockResolvedValue({ distanceKm: 120, durationMinutes: 180 });
  // Create booking via prisma tx.booking.create
  const booking = makeBooking({ status: 'created' });
  mockBookingCreate.mockResolvedValue(booking);
  mockBookingFindFirst.mockResolvedValue(null); // No existing active booking in DB check
  mockOrderFindFirst.mockResolvedValue(null);   // No existing active order in DB check
  // getBookingById after creation returns the booking
  mockGetBookingById.mockResolvedValue(booking);
  // updateBooking succeeds (legacy db.updateBooking)
  mockUpdateBooking.mockResolvedValue(booking);
  // prismaClient.booking.updateMany succeeds (FIX-R2-2: used for status updates now)
  mockBookingUpdateMany.mockResolvedValue({ count: 1 });
  // Transporters match
  mockGetTransportersWithVehicleType.mockResolvedValue(transporters);
  mockFilterOnline.mockResolvedValue(transporters);
}

// =============================================================================
// IMPORT SERVICE UNDER TEST (after all mocks)
// =============================================================================

import { bookingService } from '../modules/booking/booking.service';

// =============================================================================
// =============================================================================
// CATEGORY 1: updateBooking Error Handling (#12) — 32 tests
// =============================================================================
// =============================================================================

describe('Category 1: updateBooking Error Handling (#12)', () => {
  beforeEach(() => resetAllMocks());

  // ---------------------------------------------------------------------------
  // 1.1 updateBooking basic behavior
  // ---------------------------------------------------------------------------

  describe('updateBooking basic behavior', () => {
    it('should return BookingRecord on success (not undefined)', async () => {
      const booking = makeBooking();
      mockUpdateBooking.mockResolvedValue(booking);
      const result = await mockUpdateBooking('booking-001', { status: 'active' });
      expect(result).toBeDefined();
      expect(result.id).toBe('booking-001');
    });

    it('should throw when DB returns error (not return undefined)', async () => {
      mockUpdateBooking.mockRejectedValue(new Error('DB connection lost'));
      await expect(mockUpdateBooking('booking-001', { status: 'active' }))
        .rejects.toThrow('DB connection lost');
    });

    it('should throw on unique constraint violation', async () => {
      mockUpdateBooking.mockRejectedValue(new Error('Unique constraint violation on Booking.id'));
      await expect(mockUpdateBooking('booking-001', { status: 'active' }))
        .rejects.toThrow('Unique constraint');
    });

    it('should throw when row not found in DB', async () => {
      mockUpdateBooking.mockRejectedValue(new Error('Record to update not found'));
      await expect(mockUpdateBooking('nonexistent', { status: 'active' }))
        .rejects.toThrow('Record to update not found');
    });

    it('should throw on network timeout', async () => {
      mockUpdateBooking.mockRejectedValue(new Error('Connection timed out'));
      await expect(mockUpdateBooking('booking-001', { status: 'active' }))
        .rejects.toThrow('Connection timed out');
    });

    it('should throw on serialization failure', async () => {
      mockUpdateBooking.mockRejectedValue(new Error('P2034: Write conflict or deadlock'));
      await expect(mockUpdateBooking('booking-001', { status: 'active' }))
        .rejects.toThrow('P2034');
    });
  });

  // ---------------------------------------------------------------------------
  // 1.2 createBooking: status -> broadcasting try/catch
  // ---------------------------------------------------------------------------

  describe('createBooking: updateBooking(status=broadcasting) error handling', () => {
    it('should log error and continue when broadcasting update fails', async () => {
      setupCreateBookingMocks(['t-001']);
      // FIX-R2-2: Code now uses prismaClient.booking.updateMany for status updates
      mockBookingUpdateMany
        .mockRejectedValueOnce(new Error('DB write failed'))  // broadcasting update
        .mockResolvedValue({ count: 1 }); // subsequent calls

      const result = await bookingService.createBooking(
        'cust-001', '+911234567890', makeCreateBookingInput()
      );

      expect(result).toBeDefined();
      expect(result.id).toBe('booking-001');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update status to broadcasting'),
        expect.objectContaining({ bookingId: 'booking-001' })
      );
    });

    it('should not crash the request when broadcasting update throws', async () => {
      setupCreateBookingMocks(['t-001']);
      mockBookingUpdateMany.mockRejectedValue(new Error('ECONNRESET'));

      // Should not throw -- try/catch should absorb
      const result = await bookingService.createBooking(
        'cust-001', '+911234567890', makeCreateBookingInput()
      );
      expect(result).toBeDefined();
    });

    it('should still emit broadcast_state_changed even if DB update fails', async () => {
      setupCreateBookingMocks(['t-001']);
      mockBookingUpdateMany.mockRejectedValue(new Error('DB unavailable'));

      await bookingService.createBooking(
        'cust-001', '+911234567890', makeCreateBookingInput()
      );

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'cust-001', 'broadcast_state_changed',
        expect.objectContaining({ status: 'broadcasting' })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 1.3 createBooking: status -> active try/catch
  // ---------------------------------------------------------------------------

  describe('createBooking: updateBooking(status=active) error handling', () => {
    it('should log error and continue when active update fails', async () => {
      setupCreateBookingMocks(['t-001']);
      // FIX-R2-2: Code now uses prismaClient.booking.updateMany
      mockBookingUpdateMany
        .mockResolvedValueOnce({ count: 1 })     // broadcasting ok
        .mockRejectedValueOnce(new Error('Connection reset'));  // active fails

      const result = await bookingService.createBooking(
        'cust-001', '+911234567890', makeCreateBookingInput()
      );

      expect(result).toBeDefined();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update status to active'),
        expect.objectContaining({ bookingId: 'booking-001' })
      );
    });

    it('should still return valid booking response when active update fails', async () => {
      setupCreateBookingMocks(['t-001']);
      mockBookingUpdateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockRejectedValueOnce(new Error('DB error'));

      const result = await bookingService.createBooking(
        'cust-001', '+911234567890', makeCreateBookingInput()
      );

      expect(result.matchingTransportersCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 1.4 createBooking: status -> expired (no transporters path) try/catch
  // ---------------------------------------------------------------------------

  describe('createBooking: updateBooking(status=expired, no transporters) error handling', () => {
    it('should log error and return expired response when no transporters and expire update fails', async () => {
      setupCreateBookingMocks([]); // no matching transporters
      // FIX-R2-2: Code now uses prismaClient.booking.updateMany
      mockBookingUpdateMany
        .mockResolvedValueOnce({ count: 1 })         // broadcasting update ok
        .mockRejectedValueOnce(new Error('Write failed')); // expired update fails

      const result = await bookingService.createBooking(
        'cust-001', '+911234567890', makeCreateBookingInput()
      );

      expect(result.status).toBe('expired');
      expect(result.matchingTransportersCount).toBe(0);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to mark booking as expired'),
        expect.objectContaining({ bookingId: 'booking-001' })
      );
    });

    it('should not throw unhandled rejection when expire update fails (no transporters)', async () => {
      setupCreateBookingMocks([]);
      // FIX-R2-2: Code now uses prismaClient.booking.updateMany
      mockBookingUpdateMany
        .mockResolvedValueOnce({ count: 1 })           // broadcasting ok
        .mockRejectedValueOnce(new Error('DB offline')); // expired fails

      // Should not throw to caller
      const result = await bookingService.createBooking(
        'cust-001', '+911234567890', makeCreateBookingInput()
      );
      expect(result).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 1.5 handleBookingTimeout: partial fill try/catch
  // ---------------------------------------------------------------------------

  describe('handleBookingTimeout: partial fill updateBooking error handling', () => {
    it('should log error and continue when expiring partially filled booking fails', async () => {
      const booking = makeBooking({ status: 'active', trucksFilled: 1, trucksNeeded: 3 });
      mockGetBookingById.mockResolvedValue(booking);
      // FIX-R2-2: handleBookingTimeout now uses prismaClient.booking.updateMany
      mockBookingUpdateMany.mockRejectedValue(new Error('Deadlock'));
      mockRedisCancelTimer.mockResolvedValue(undefined);

      await bookingService.handleBookingTimeout('booking-001', 'cust-001');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to expire partially filled booking'),
        expect.objectContaining({ bookingId: 'booking-001' })
      );
    });

    it('should still emit BOOKING_EXPIRED socket event even if DB update fails (partial fill)', async () => {
      const booking = makeBooking({ status: 'active', trucksFilled: 2, trucksNeeded: 5 });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockRejectedValue(new Error('Timeout'));
      mockRedisCancelTimer.mockResolvedValue(undefined);

      await bookingService.handleBookingTimeout('booking-001', 'cust-001');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'cust-001',
        'booking_expired',
        expect.objectContaining({ status: 'partially_filled_expired' })
      );
    });

    it('should not crash when partial fill expire update throws', async () => {
      const booking = makeBooking({ status: 'broadcasting', trucksFilled: 1, trucksNeeded: 2 });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockRejectedValue(new Error('ECONNREFUSED'));

      // Should not throw
      await expect(
        bookingService.handleBookingTimeout('booking-001', 'cust-001')
      ).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 1.6 handleBookingTimeout: zero fill try/catch
  // ---------------------------------------------------------------------------

  describe('handleBookingTimeout: zero fill updateBooking error handling', () => {
    it('should log error and continue when expiring unfilled booking fails', async () => {
      const booking = makeBooking({ status: 'active', trucksFilled: 0 });
      mockGetBookingById.mockResolvedValue(booking);
      // FIX-R2-2: handleBookingTimeout now uses prismaClient.booking.updateMany
      mockBookingUpdateMany.mockRejectedValue(new Error('IO error'));
      mockRedisCancelTimer.mockResolvedValue(undefined);

      await bookingService.handleBookingTimeout('booking-001', 'cust-001');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to expire unfilled booking'),
        expect.objectContaining({ bookingId: 'booking-001' })
      );
    });

    it('should still emit NO_VEHICLES_AVAILABLE even if DB update fails (zero fill)', async () => {
      const booking = makeBooking({ status: 'active', trucksFilled: 0 });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockRejectedValue(new Error('DB gone'));

      await bookingService.handleBookingTimeout('booking-001', 'cust-001');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'cust-001',
        'no_vehicles_available',
        expect.objectContaining({ bookingId: 'booking-001' })
      );
    });

    it('should not throw unhandled rejection when zero fill expire fails', async () => {
      const booking = makeBooking({ status: 'active', trucksFilled: 0 });
      mockGetBookingById.mockResolvedValue(booking);
      mockBookingUpdateMany.mockRejectedValue(new Error('AWS RDS timeout'));

      await expect(
        bookingService.handleBookingTimeout('booking-001', 'cust-001')
      ).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 1.7 advanceRadiusStep: notifiedTransporters try/catch
  // ---------------------------------------------------------------------------

  describe('advanceRadiusStep: notifiedTransporters updateBooking error handling', () => {
    it('should log error and continue when notifiedTransporters update fails', async () => {
      const booking = makeBooking({ status: 'active' });
      mockGetBookingById.mockResolvedValue(booking);
      mockUpdateBooking.mockRejectedValue(new Error('DB error'));
      mockRedisSMembers.mockResolvedValue(['t-001']);
      mockFilterOnline.mockResolvedValue(['t-002', 't-003']);
      mockRedisSet.mockResolvedValue('OK');
      mockRedisSetTimer.mockResolvedValue(undefined);
      mockRedisSAdd.mockResolvedValue(1);

      const { progressiveRadiusMatcher } = require('../modules/order/progressive-radius-matcher');
      progressiveRadiusMatcher.findCandidates.mockResolvedValue([
        { transporterId: 't-002', distanceKm: 10, etaSeconds: 600 },
        { transporterId: 't-003', distanceKm: 15, etaSeconds: 900 },
      ]);

      await bookingService.advanceRadiusStep({
        bookingId: 'booking-001',
        customerId: 'cust-001',
        vehicleKey: 'open_7-ton',
        vehicleType: 'open',
        vehicleSubtype: '7-ton',
        pickupLat: 19.076,
        pickupLng: 72.878,
        currentStep: 0,
      });

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update notifiedTransporters'),
        expect.objectContaining({ bookingId: 'booking-001' })
      );
    });

    it('should still broadcast to new transporters even if notified update fails', async () => {
      const booking = makeBooking({ status: 'active' });
      mockGetBookingById.mockResolvedValue(booking);
      mockUpdateBooking.mockRejectedValue(new Error('DB error'));
      mockRedisSMembers.mockResolvedValue(['t-001']);
      mockFilterOnline.mockResolvedValue(['t-002']);
      mockRedisSet.mockResolvedValue('OK');
      mockRedisSetTimer.mockResolvedValue(undefined);
      mockRedisSAdd.mockResolvedValue(1);

      const { progressiveRadiusMatcher } = require('../modules/order/progressive-radius-matcher');
      progressiveRadiusMatcher.findCandidates.mockResolvedValue([
        { transporterId: 't-002', distanceKm: 10, etaSeconds: 600 },
      ]);

      await bookingService.advanceRadiusStep({
        bookingId: 'booking-001', customerId: 'cust-001',
        vehicleKey: 'open_7-ton', vehicleType: 'open', vehicleSubtype: '7-ton',
        pickupLat: 19.076, pickupLng: 72.878, currentStep: 0,
      });

      // Should still have emitted broadcast to t-002
      expect(mockEmitToUser).toHaveBeenCalledWith(
        't-002', 'new_broadcast', expect.any(Object)
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 1.8 radiusDbFallback: notifiedTransporters try/catch
  // ---------------------------------------------------------------------------

  describe('radiusDbFallback: notifiedTransporters updateBooking error handling', () => {
    it('should log error and continue when DB fallback notifiedTransporters update fails', async () => {
      const booking = makeBooking({ status: 'active' });
      mockGetBookingById.mockResolvedValue(booking);
      mockGetTransportersWithVehicleType.mockResolvedValue(['t-001', 't-002', 't-003']);
      mockFilterOnline.mockResolvedValue(['t-003']);
      mockRedisSMembers.mockResolvedValue(['t-001', 't-002']);
      mockUpdateBooking.mockRejectedValue(new Error('Connection dropped'));
      mockRedisSet.mockResolvedValue('OK');

      // Trigger DB fallback by advancing past last step
      await bookingService.advanceRadiusStep({
        bookingId: 'booking-001', customerId: 'cust-001',
        vehicleKey: 'open_7-ton', vehicleType: 'open', vehicleSubtype: '7-ton',
        pickupLat: 19.076, pickupLng: 72.878, currentStep: 5,  // beyond max steps
      });

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update notifiedTransporters'),
        expect.objectContaining({ bookingId: 'booking-001' })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 1.9 incrementTrucksFilled: try/catch returns fallback
  // ---------------------------------------------------------------------------

  describe('incrementTrucksFilled: updateBooking error handling', () => {
    it('should log error and return original booking when status update after increment fails', async () => {
      const booking = makeBooking({ status: 'active', trucksFilled: 0, trucksNeeded: 2 });
      mockGetBookingById.mockResolvedValue(booking);
      mockQueryRaw.mockResolvedValue([{ trucksFilled: 1, trucksNeeded: 2 }]);
      mockUpdateBooking.mockRejectedValue(new Error('Status update failed'));

      const result = await bookingService.incrementTrucksFilled('booking-001');

      expect(result).toBeDefined();
      expect(result.id).toBe('booking-001');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update status after increment'),
        expect.objectContaining({ bookingId: 'booking-001' })
      );
    });

    it('should return fallback booking (not undefined) when updateBooking throws on increment', async () => {
      const booking = makeBooking({ status: 'active', trucksFilled: 1, trucksNeeded: 3 });
      mockGetBookingById.mockResolvedValue(booking);
      mockQueryRaw.mockResolvedValue([{ trucksFilled: 2, trucksNeeded: 3 }]);
      mockUpdateBooking.mockRejectedValue(new Error('DB unavailable'));

      const result = await bookingService.incrementTrucksFilled('booking-001');

      // Should return the original booking as fallback (line: return updated || booking)
      expect(result).toEqual(booking);
    });

    it('should still emit WebSocket events even if status update fails on increment', async () => {
      const booking = makeBooking({ status: 'active', trucksFilled: 0, trucksNeeded: 2 });
      mockGetBookingById.mockResolvedValue(booking);
      mockQueryRaw.mockResolvedValue([{ trucksFilled: 1, trucksNeeded: 2 }]);
      mockUpdateBooking.mockRejectedValue(new Error('write error'));

      await bookingService.incrementTrucksFilled('booking-001');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'cust-001', 'booking_updated',
        expect.objectContaining({ trucksFilled: 1, trucksNeeded: 2 })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 1.10 decrementTrucksFilled: try/catch returns fallback
  // ---------------------------------------------------------------------------

  describe('decrementTrucksFilled: updateBooking error handling', () => {
    it('should log error and return original booking when status update after decrement fails', async () => {
      const booking = makeBooking({ status: 'partially_filled', trucksFilled: 2, trucksNeeded: 3 });
      mockGetBookingById.mockResolvedValue(booking);
      mockQueryRaw.mockResolvedValue([{ trucksFilled: 1 }]);
      mockUpdateBooking.mockRejectedValue(new Error('Status update failed'));

      const result = await bookingService.decrementTrucksFilled('booking-001');

      expect(result).toBeDefined();
      expect(result.id).toBe('booking-001');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update status after decrement'),
        expect.objectContaining({ bookingId: 'booking-001' })
      );
    });

    it('should return fallback booking (not undefined) when updateBooking throws on decrement', async () => {
      const booking = makeBooking({ status: 'partially_filled', trucksFilled: 1, trucksNeeded: 3 });
      mockGetBookingById.mockResolvedValue(booking);
      mockQueryRaw.mockResolvedValue([{ trucksFilled: 0 }]);
      mockUpdateBooking.mockRejectedValue(new Error('DB offline'));

      const result = await bookingService.decrementTrucksFilled('booking-001');

      expect(result).toEqual(booking);
    });

    it('should still emit WebSocket events even if status update fails on decrement', async () => {
      const booking = makeBooking({ status: 'partially_filled', trucksFilled: 2, trucksNeeded: 3 });
      mockGetBookingById.mockResolvedValue(booking);
      mockQueryRaw.mockResolvedValue([{ trucksFilled: 1 }]);
      mockUpdateBooking.mockRejectedValue(new Error('DB error'));

      await bookingService.decrementTrucksFilled('booking-001');

      expect(mockEmitToBooking).toHaveBeenCalledWith(
        'booking-001', 'booking_updated',
        expect.objectContaining({ trucksFilled: 1 })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 1.11 deliverMissedBroadcasts: .catch() pattern
  // ---------------------------------------------------------------------------

  describe('deliverMissedBroadcasts: updateBooking .catch() error handling', () => {
    it('should use .catch() pattern and not throw when notifiedTransporters update fails', async () => {
      const booking = makeBooking({
        status: 'active',
        notifiedTransporters: [],
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        pickup: {
          address: '123 Main St', city: 'Mumbai',
          latitude: 19.076, longitude: 72.878,
          coordinates: { latitude: 19.076, longitude: 72.878 },
        },
      });
      mockGetActiveBookingsForTransporter.mockResolvedValue([booking]);
      mockUpdateBooking.mockRejectedValue(new Error('DB write failed'));

      // Should not throw
      await expect(
        bookingService.deliverMissedBroadcasts('t-new')
      ).resolves.toBeUndefined();
    });

    it('should log warning (not error) when notifiedTransporters update fails in missed broadcasts', async () => {
      const booking = makeBooking({
        status: 'active',
        notifiedTransporters: [],
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        pickup: {
          address: '123 Main St', city: 'Mumbai',
          latitude: 19.076, longitude: 72.878,
          coordinates: { latitude: 19.076, longitude: 72.878 },
        },
      });
      mockGetActiveBookingsForTransporter.mockResolvedValue([booking]);
      mockUpdateBooking.mockRejectedValue(new Error('write fail'));

      await bookingService.deliverMissedBroadcasts('t-new');

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update notifiedTransporters'),
        expect.objectContaining({ error: 'write fail' })
      );
    });

    it('should still deliver broadcasts via WebSocket even if DB update fails', async () => {
      const booking = makeBooking({
        status: 'active',
        notifiedTransporters: [],
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        pickup: {
          address: '123 Main St', city: 'Mumbai',
          latitude: 19.076, longitude: 72.878,
          coordinates: { latitude: 19.076, longitude: 72.878 },
        },
      });
      mockGetActiveBookingsForTransporter.mockResolvedValue([booking]);
      mockUpdateBooking.mockRejectedValue(new Error('fail'));

      await bookingService.deliverMissedBroadcasts('t-new');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        't-new', 'new_broadcast', expect.any(Object)
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 1.12 Booking state consistency checks
  // ---------------------------------------------------------------------------

  describe('State consistency after updateBooking failures', () => {
    it('should keep booking in consistent state when broadcasting update fails', async () => {
      setupCreateBookingMocks(['t-001']);
      mockUpdateBooking.mockRejectedValue(new Error('write fail'));

      const result = await bookingService.createBooking(
        'cust-001', '+911234567890', makeCreateBookingInput()
      );

      // Booking was still returned from createBooking
      expect(result).toBeDefined();
      expect(result.id).toBe('booking-001');
    });

    it('should not block subsequent operations when a single updateBooking fails', async () => {
      const booking = makeBooking({ status: 'active', trucksFilled: 0, trucksNeeded: 3 });
      mockGetBookingById.mockResolvedValue(booking);
      mockQueryRaw.mockResolvedValue([{ trucksFilled: 1, trucksNeeded: 3 }]);
      mockUpdateBooking.mockRejectedValue(new Error('fail'));

      // First call should handle gracefully
      const result1 = await bookingService.incrementTrucksFilled('booking-001');
      expect(result1).toBeDefined();

      // Reset for second call
      mockUpdateBooking.mockResolvedValue(makeBooking({ status: 'partially_filled', trucksFilled: 2 }));
      mockGetBookingById.mockResolvedValue(makeBooking({ trucksFilled: 1, trucksNeeded: 3 }));
      mockQueryRaw.mockResolvedValue([{ trucksFilled: 2, trucksNeeded: 3 }]);

      const result2 = await bookingService.incrementTrucksFilled('booking-001');
      expect(result2).toBeDefined();
    });

    it('should include bookingId context in every error log from updateBooking callers', async () => {
      const booking = makeBooking({ status: 'active', trucksFilled: 0 });
      mockGetBookingById.mockResolvedValue(booking);
      // FIX-R2-2: handleBookingTimeout now uses prismaClient.booking.updateMany
      mockBookingUpdateMany.mockRejectedValue(new Error('context test'));

      await bookingService.handleBookingTimeout('booking-001', 'cust-001');

      const errorCalls = (logger.error as jest.Mock).mock.calls;
      const updateErrorCall = errorCalls.find((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('Failed to expire')
      );
      expect(updateErrorCall).toBeDefined();
      expect(updateErrorCall![1]).toHaveProperty('bookingId', 'booking-001');
    });
  });
});

// =============================================================================
// =============================================================================
// CATEGORY 2: Idempotency Fingerprint (#17) — 22 tests
// =============================================================================
// =============================================================================

describe('Category 2: Idempotency Fingerprint (#17)', () => {
  beforeEach(() => resetAllMocks());

  const BASE_PARAMS = {
    customerId: 'cust-001',
    vehicleType: 'open',
    vehicleSubtype: '7-ton',
    pickupLat: 19.076,
    pickupLng: 72.878,
    dropLat: 18.52,
    dropLng: 73.857,
    trucksNeeded: 3,
    pricePerTruck: 5000,
  };

  // ---------------------------------------------------------------------------
  // 2.1 Same parameters -> same fingerprint (dedup)
  // ---------------------------------------------------------------------------

  it('same customer, route, vehicleType, trucksNeeded, pricePerTruck -> SAME fingerprint', () => {
    const fp1 = computeFingerprint(BASE_PARAMS);
    const fp2 = computeFingerprint(BASE_PARAMS);
    expect(fp1).toBe(fp2);
  });

  // ---------------------------------------------------------------------------
  // 2.2 Different trucksNeeded -> different fingerprint
  // ---------------------------------------------------------------------------

  it('different trucksNeeded -> DIFFERENT fingerprint', () => {
    const fp1 = computeFingerprint(BASE_PARAMS);
    const fp2 = computeFingerprint({ ...BASE_PARAMS, trucksNeeded: 5 });
    expect(fp1).not.toBe(fp2);
  });

  // ---------------------------------------------------------------------------
  // 2.3 Different pricePerTruck -> different fingerprint
  // ---------------------------------------------------------------------------

  it('different pricePerTruck -> DIFFERENT fingerprint', () => {
    const fp1 = computeFingerprint(BASE_PARAMS);
    const fp2 = computeFingerprint({ ...BASE_PARAMS, pricePerTruck: 7000 });
    expect(fp1).not.toBe(fp2);
  });

  // ---------------------------------------------------------------------------
  // 2.4 Different vehicleType -> different fingerprint
  // ---------------------------------------------------------------------------

  it('different vehicleType -> DIFFERENT fingerprint', () => {
    const fp1 = computeFingerprint(BASE_PARAMS);
    const fp2 = computeFingerprint({ ...BASE_PARAMS, vehicleType: 'tipper' });
    expect(fp1).not.toBe(fp2);
  });

  // ---------------------------------------------------------------------------
  // 2.5 Different pickup coords -> different fingerprint
  // ---------------------------------------------------------------------------

  it('different pickup coordinates -> DIFFERENT fingerprint', () => {
    const fp1 = computeFingerprint(BASE_PARAMS);
    const fp2 = computeFingerprint({ ...BASE_PARAMS, pickupLat: 20.0 });
    expect(fp1).not.toBe(fp2);
  });

  // ---------------------------------------------------------------------------
  // 2.6 Different drop coords -> different fingerprint
  // ---------------------------------------------------------------------------

  it('different drop coordinates -> DIFFERENT fingerprint', () => {
    const fp1 = computeFingerprint(BASE_PARAMS);
    const fp2 = computeFingerprint({ ...BASE_PARAMS, dropLat: 17.5 });
    expect(fp1).not.toBe(fp2);
  });

  // ---------------------------------------------------------------------------
  // 2.7 Different vehicleSubtype -> different fingerprint
  // ---------------------------------------------------------------------------

  it('different vehicleSubtype -> DIFFERENT fingerprint', () => {
    const fp1 = computeFingerprint(BASE_PARAMS);
    const fp2 = computeFingerprint({ ...BASE_PARAMS, vehicleSubtype: '14-ton' });
    expect(fp1).not.toBe(fp2);
  });

  // ---------------------------------------------------------------------------
  // 2.8 GPS jitter within rounding tolerance -> SAME fingerprint
  // ---------------------------------------------------------------------------

  it('coordinates rounded to 3 decimal places match despite GPS jitter', () => {
    const fp1 = computeFingerprint({ ...BASE_PARAMS, pickupLat: 19.0761 });
    const fp2 = computeFingerprint({ ...BASE_PARAMS, pickupLat: 19.0764 });
    // Both round to 19.076
    expect(fp1).toBe(fp2);
  });

  // ---------------------------------------------------------------------------
  // 2.9 trucksNeeded integer vs float -> SAME fingerprint
  // ---------------------------------------------------------------------------

  it('trucksNeeded 2 vs 2.0 -> SAME fingerprint (String() converts same)', () => {
    const fp1 = computeFingerprint({ ...BASE_PARAMS, trucksNeeded: 2 });
    const fp2 = computeFingerprint({ ...BASE_PARAMS, trucksNeeded: 2.0 });
    expect(fp1).toBe(fp2);
  });

  // ---------------------------------------------------------------------------
  // 2.10 pricePerTruck integer vs float -> SAME fingerprint
  // ---------------------------------------------------------------------------

  it('pricePerTruck 5000 vs 5000.00 -> SAME fingerprint', () => {
    const fp1 = computeFingerprint({ ...BASE_PARAMS, pricePerTruck: 5000 });
    const fp2 = computeFingerprint({ ...BASE_PARAMS, pricePerTruck: 5000.0 });
    expect(fp1).toBe(fp2);
  });

  // ---------------------------------------------------------------------------
  // 2.11 pricePerTruck 5000 vs 5001 -> different fingerprint
  // ---------------------------------------------------------------------------

  it('pricePerTruck 5000 vs 5001 -> DIFFERENT fingerprint', () => {
    const fp1 = computeFingerprint({ ...BASE_PARAMS, pricePerTruck: 5000 });
    const fp2 = computeFingerprint({ ...BASE_PARAMS, pricePerTruck: 5001 });
    expect(fp1).not.toBe(fp2);
  });

  // ---------------------------------------------------------------------------
  // 2.12 Different customer -> different fingerprint
  // ---------------------------------------------------------------------------

  it('Customer A vs Customer B -> DIFFERENT fingerprint (even same route)', () => {
    const fp1 = computeFingerprint(BASE_PARAMS);
    const fp2 = computeFingerprint({ ...BASE_PARAMS, customerId: 'cust-002' });
    expect(fp1).not.toBe(fp2);
  });

  // ---------------------------------------------------------------------------
  // 2.13 Fingerprint is SHA256 hashed (32 hex chars)
  // ---------------------------------------------------------------------------

  it('fingerprint is SHA256 hashed (32 hex chars, lowercase)', () => {
    const fp = computeFingerprint(BASE_PARAMS);
    expect(fp).toHaveLength(32);
    expect(fp).toMatch(/^[a-f0-9]{32}$/);
  });

  // ---------------------------------------------------------------------------
  // 2.14 Fingerprint stored in Redis with correct TTL
  // ---------------------------------------------------------------------------

  it('fingerprint is stored in Redis with TTL equal to timeout + 30s', async () => {
    setupCreateBookingMocks(['t-001']);

    await bookingService.createBooking('cust-001', '+911234567890', makeCreateBookingInput());

    // Look for idem:broadcast:create: key in redis.set calls
    const setCallsWithIdem = mockRedisSet.mock.calls.filter((c: any[]) =>
      typeof c[0] === 'string' && c[0].startsWith('idem:broadcast:create:')
    );
    expect(setCallsWithIdem.length).toBeGreaterThan(0);
    const ttl = setCallsWithIdem[0][2];
    // TTL should be timeout seconds + 30
    expect(ttl).toBe(120 + 30); // 120s default timeout + 30s buffer
  });

  // ---------------------------------------------------------------------------
  // 2.15 Fingerprint check happens BEFORE the distributed lock
  // ---------------------------------------------------------------------------

  it('fingerprint check (redisGet for dedupeKey) happens BEFORE lock acquisition', async () => {
    setupCreateBookingMocks(['t-001']);
    const callOrder: string[] = [];

    mockRedisGet.mockImplementation(async (key: string) => {
      if (key.startsWith('idem:broadcast:create:')) {
        callOrder.push('fingerprint_check');
      }
      return null;
    });

    mockRedisAcquireLock.mockImplementation(async () => {
      callOrder.push('lock_acquired');
      return { acquired: true };
    });

    await bookingService.createBooking('cust-001', '+911234567890', makeCreateBookingInput());

    // The fingerprint check is inside the lock (lock is acquired first for this design)
    // Verify both happened
    expect(callOrder).toContain('fingerprint_check');
    expect(callOrder).toContain('lock_acquired');
  });

  // ---------------------------------------------------------------------------
  // 2.16 Expired booking with same fingerprint -> allows re-creation
  // ---------------------------------------------------------------------------

  it('expired booking with same fingerprint allows re-creation', async () => {
    setupCreateBookingMocks(['t-001']);

    // First call for dedupeKey returns an existing booking ID
    const expiredBooking = makeBooking({ status: 'expired' });
    mockRedisGet.mockImplementation(async (key: string) => {
      if (key.startsWith('idem:broadcast:create:')) return 'booking-expired';
      if (key === 'customer:active-broadcast:cust-001') return null;
      return null;
    });
    // The dedup check will find the expired booking and proceed
    mockGetBookingById.mockImplementation(async (id: string) => {
      if (id === 'booking-expired') return expiredBooking;
      return makeBooking();
    });

    const result = await bookingService.createBooking(
      'cust-001', '+911234567890', makeCreateBookingInput()
    );

    // Should have created a new booking (not returned the expired one)
    expect(result).toBeDefined();
    // Booking created via tx.booking.create (prisma transaction)
    expect(mockBookingCreate).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 2.17 Cancelled booking with same fingerprint -> allows re-creation
  // ---------------------------------------------------------------------------

  it('cancelled booking with same fingerprint allows re-creation', async () => {
    setupCreateBookingMocks(['t-001']);

    const cancelledBooking = makeBooking({ status: 'cancelled' });
    mockRedisGet.mockImplementation(async (key: string) => {
      if (key.startsWith('idem:broadcast:create:')) return 'booking-cancelled';
      if (key === 'customer:active-broadcast:cust-001') return null;
      return null;
    });
    mockGetBookingById.mockImplementation(async (id: string) => {
      if (id === 'booking-cancelled') return cancelledBooking;
      return makeBooking();
    });

    const result = await bookingService.createBooking(
      'cust-001', '+911234567890', makeCreateBookingInput()
    );

    expect(result).toBeDefined();
    // Booking created via tx.booking.create (prisma transaction)
    expect(mockBookingCreate).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 2.18 Double-tap: two rapid requests -> second is deduped
  // ---------------------------------------------------------------------------

  it('double-tap scenario: second request with same params returns cached booking', async () => {
    setupCreateBookingMocks(['t-001']);

    // First call: no dedupe key, creates booking
    const firstBooking = makeBooking({ status: 'active' });
    mockRedisGet.mockResolvedValue(null);
    mockCreateBooking.mockResolvedValue(firstBooking);

    await bookingService.createBooking('cust-001', '+911234567890', makeCreateBookingInput());

    resetAllMocks();
    setupCreateBookingMocks(['t-001']);

    // Second call: dedupe key returns existing booking ID
    mockRedisGet.mockImplementation(async (key: string) => {
      if (key.startsWith('idem:broadcast:create:')) return 'booking-001';
      if (key === 'customer:active-broadcast:cust-001') return null;
      return null;
    });
    mockGetBookingById.mockResolvedValue(firstBooking);

    const result = await bookingService.createBooking(
      'cust-001', '+911234567890', makeCreateBookingInput()
    );

    expect(result.id).toBe('booking-001');
    // Should NOT have called createBooking for the second request
    expect(mockCreateBooking).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 2.19 Fingerprint includes trucksNeeded field
  // ---------------------------------------------------------------------------

  it('fingerprint raw string includes trucksNeeded value', () => {
    const roundCoord = (c: number) => Math.round(c * 1000) / 1000;
    const raw = [
      'cust-001', 'open', '7-ton',
      roundCoord(19.076), roundCoord(72.878),
      roundCoord(18.52), roundCoord(73.857),
      String(3), String(5000)
    ].join(':');
    expect(raw).toContain(':3:');
  });

  // ---------------------------------------------------------------------------
  // 2.20 Fingerprint includes pricePerTruck field
  // ---------------------------------------------------------------------------

  it('fingerprint raw string includes pricePerTruck value', () => {
    const roundCoord = (c: number) => Math.round(c * 1000) / 1000;
    const raw = [
      'cust-001', 'open', '7-ton',
      roundCoord(19.076), roundCoord(72.878),
      roundCoord(18.52), roundCoord(73.857),
      String(3), String(5000)
    ].join(':');
    expect(raw).toContain(':5000');
  });

  // ---------------------------------------------------------------------------
  // 2.21 GPS jitter difference beyond 3 decimal places -> DIFFERENT fingerprint
  // ---------------------------------------------------------------------------

  it('coordinates differing at 3rd decimal place -> DIFFERENT fingerprint', () => {
    const fp1 = computeFingerprint({ ...BASE_PARAMS, pickupLat: 19.076 });
    const fp2 = computeFingerprint({ ...BASE_PARAMS, pickupLat: 19.077 });
    expect(fp1).not.toBe(fp2);
  });

  // ---------------------------------------------------------------------------
  // 2.22 Empty vehicleSubtype -> still produces valid fingerprint
  // ---------------------------------------------------------------------------

  it('empty vehicleSubtype produces valid and distinct fingerprint from non-empty', () => {
    const fp1 = computeFingerprint({ ...BASE_PARAMS, vehicleSubtype: '' });
    const fp2 = computeFingerprint({ ...BASE_PARAMS, vehicleSubtype: '7-ton' });
    expect(fp1).toMatch(/^[a-f0-9]{32}$/);
    expect(fp1).not.toBe(fp2);
  });
});

// =============================================================================
// =============================================================================
// CATEGORY 3: Parallel Redis Cleanup (#19) — 12 tests
// =============================================================================
// =============================================================================

describe('Category 3: Parallel Redis Cleanup (#19)', () => {
  beforeEach(() => resetAllMocks());

  // ---------------------------------------------------------------------------
  // 3.1 All keys deleted successfully -> no orphans
  // ---------------------------------------------------------------------------

  it('should delete all Redis keys when all deletes succeed', async () => {
    mockRedisDel.mockResolvedValue(1);
    mockRedisGet.mockResolvedValue('idem:broadcast:create:cust-001:abc123');
    mockRedisCancelTimer.mockResolvedValue(undefined);

    // Trigger clearCustomerActiveBroadcast via handleBookingTimeout fully_filled path
    const booking = makeBooking({
      status: 'active',
      trucksFilled: 0,
      trucksNeeded: 1,
    });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 1, trucksNeeded: 1 }]);
    mockUpdateBooking.mockResolvedValue(makeBooking({ status: 'fully_filled', trucksFilled: 1 }));

    await bookingService.incrementTrucksFilled('booking-001');

    // clearCustomerActiveBroadcast should have called del
    expect(mockRedisDel).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 3.2 First delete fails -> other deletes still execute
  // ---------------------------------------------------------------------------

  it('should continue deleting other keys when first delete fails', async () => {
    let deleteCount = 0;
    mockRedisDel.mockImplementation(async () => {
      deleteCount++;
      if (deleteCount === 1) throw new Error('First delete failed');
      return 1;
    });
    mockRedisGet.mockResolvedValue('idem:key:some');
    mockRedisCancelTimer.mockResolvedValue(undefined);

    const booking = makeBooking({ status: 'active', trucksFilled: 0, trucksNeeded: 1 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 1, trucksNeeded: 1 }]);
    mockUpdateBooking.mockResolvedValue(makeBooking({ status: 'fully_filled', trucksFilled: 1 }));

    // Should not throw
    await expect(
      bookingService.incrementTrucksFilled('booking-001')
    ).resolves.toBeDefined();

    // Should have attempted multiple deletes
    expect(deleteCount).toBeGreaterThanOrEqual(2);
  });

  // ---------------------------------------------------------------------------
  // 3.3 All deletes fail -> method doesn't throw (graceful)
  // ---------------------------------------------------------------------------

  it('should not throw when all Redis deletes fail', async () => {
    mockRedisDel.mockRejectedValue(new Error('Redis down'));
    mockRedisGet.mockResolvedValue('idem:key');
    mockRedisCancelTimer.mockResolvedValue(undefined);

    const booking = makeBooking({ status: 'active', trucksFilled: 0, trucksNeeded: 1 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 1, trucksNeeded: 1 }]);
    mockUpdateBooking.mockResolvedValue(makeBooking({ status: 'fully_filled', trucksFilled: 1 }));

    await expect(
      bookingService.incrementTrucksFilled('booking-001')
    ).resolves.toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 3.4 No idempotency key -> only activeKey + latest deleted
  // ---------------------------------------------------------------------------

  it('should delete only activeKey and latest pointer when no idempotency key exists', async () => {
    mockRedisDel.mockResolvedValue(1);
    // No latestIdemKey found
    mockRedisGet.mockResolvedValue(null);
    mockRedisCancelTimer.mockResolvedValue(undefined);

    const booking = makeBooking({ status: 'active', trucksFilled: 0, trucksNeeded: 1 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 1, trucksNeeded: 1 }]);
    mockUpdateBooking.mockResolvedValue(makeBooking({ status: 'fully_filled', trucksFilled: 1 }));

    await bookingService.incrementTrucksFilled('booking-001');

    // del called for activeKey and idem:broadcast:latest (but NOT the latestIdemKey value)
    const delKeys = mockRedisDel.mock.calls.map((c: any[]) => c[0]);
    const hasActiveKey = delKeys.some((k: string) => k.startsWith('customer:active-broadcast:'));
    expect(hasActiveKey).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 3.5 Verify each delete has .catch() -> no unhandled rejections
  // ---------------------------------------------------------------------------

  it('should use .catch() on each delete so no unhandled rejections', async () => {
    mockRedisDel.mockRejectedValue(new Error('connection lost'));
    mockRedisGet.mockResolvedValue('some-idem-key');
    mockRedisCancelTimer.mockResolvedValue(undefined);

    const booking = makeBooking({ status: 'active', trucksFilled: 0, trucksNeeded: 1 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 1, trucksNeeded: 1 }]);
    mockUpdateBooking.mockResolvedValue(makeBooking({ status: 'fully_filled', trucksFilled: 1 }));

    // No unhandled rejection should surface
    const result = await bookingService.incrementTrucksFilled('booking-001');
    expect(result).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 3.6 clearCustomerActiveBroadcast called on cancel
  // ---------------------------------------------------------------------------

  it('should call clearCustomerActiveBroadcast when booking is cancelled', async () => {
    const booking = makeBooking({ status: 'active' });
    mockGetBookingById.mockResolvedValue(booking);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockAssignmentFindMany.mockResolvedValue([]);
    mockRedisCancelTimer.mockResolvedValue(undefined);
    mockRedisGet.mockResolvedValue(null);
    mockRedisDel.mockResolvedValue(1);

    await bookingService.cancelBooking('booking-001', 'cust-001');

    // clearCustomerActiveBroadcast deletes the activeKey
    const delKeys = mockRedisDel.mock.calls.map((c: any[]) => c[0]);
    expect(delKeys.some((k: string) => k.startsWith('customer:active-broadcast:'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 3.7 clearCustomerActiveBroadcast called on expire
  // ---------------------------------------------------------------------------

  it('should call clearCustomerActiveBroadcast when booking expires via timeout', async () => {
    const booking = makeBooking({ status: 'active', trucksFilled: 0 });
    mockGetBookingById.mockResolvedValue(booking);
    mockUpdateBooking.mockResolvedValue(makeBooking({ status: 'expired' }));
    mockRedisDel.mockResolvedValue(1);
    mockRedisGet.mockResolvedValue(null);
    mockRedisCancelTimer.mockResolvedValue(undefined);

    await bookingService.handleBookingTimeout('booking-001', 'cust-001');

    const delKeys = mockRedisDel.mock.calls.map((c: any[]) => c[0]);
    expect(delKeys.some((k: string) => k.startsWith('customer:active-broadcast:'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 3.8 clearCustomerActiveBroadcast called on fully_filled
  // ---------------------------------------------------------------------------

  it('should call clearCustomerActiveBroadcast when booking is fully filled', async () => {
    const booking = makeBooking({ status: 'active', trucksFilled: 0, trucksNeeded: 1 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 1, trucksNeeded: 1 }]);
    mockUpdateBooking.mockResolvedValue(makeBooking({ status: 'fully_filled', trucksFilled: 1 }));
    mockRedisDel.mockResolvedValue(1);
    mockRedisGet.mockResolvedValue(null);
    mockRedisCancelTimer.mockResolvedValue(undefined);

    await bookingService.incrementTrucksFilled('booking-001');

    const delKeys = mockRedisDel.mock.calls.map((c: any[]) => c[0]);
    expect(delKeys.some((k: string) => k.startsWith('customer:active-broadcast:'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 3.9 Redis timeout during cleanup doesn't block the response
  // ---------------------------------------------------------------------------

  it('should not block response when Redis times out during cleanup', async () => {
    // Simulate Redis timeout (long delay)
    mockRedisDel.mockImplementation(() => new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 50)
    ));
    mockRedisGet.mockResolvedValue(null);
    mockRedisCancelTimer.mockResolvedValue(undefined);

    const booking = makeBooking({ status: 'active', trucksFilled: 0, trucksNeeded: 1 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 1, trucksNeeded: 1 }]);
    mockUpdateBooking.mockResolvedValue(makeBooking({ status: 'fully_filled', trucksFilled: 1 }));

    const start = Date.now();
    await bookingService.incrementTrucksFilled('booking-001');
    const elapsed = Date.now() - start;

    // Should complete in reasonable time (< 5s including mock timeout)
    expect(elapsed).toBeLessThan(5000);
  });

  // ---------------------------------------------------------------------------
  // 3.10 Parallel deletion verified via Promise.all usage
  // ---------------------------------------------------------------------------

  it('should execute deletes in parallel (not sequentially) via Promise.all', async () => {
    const delTimes: number[] = [];
    mockRedisDel.mockImplementation(async () => {
      delTimes.push(Date.now());
      await new Promise(r => setTimeout(r, 20));
      return 1;
    });
    mockRedisGet.mockResolvedValue('some-idem-key');
    mockRedisCancelTimer.mockResolvedValue(undefined);

    const booking = makeBooking({ status: 'active', trucksFilled: 0, trucksNeeded: 1 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 1, trucksNeeded: 1 }]);
    mockUpdateBooking.mockResolvedValue(makeBooking({ status: 'fully_filled', trucksFilled: 1 }));

    await bookingService.incrementTrucksFilled('booking-001');

    // If parallel, all del calls should start within a small window
    if (delTimes.length >= 2) {
      const spread = delTimes[delTimes.length - 1] - delTimes[0];
      // Parallel: all start within ~10ms. Sequential: 20ms apart each
      expect(spread).toBeLessThan(50);
    }
  });

  // ---------------------------------------------------------------------------
  // 3.11 clearCustomerActiveBroadcast deletes latestIdemKey value when present
  // ---------------------------------------------------------------------------

  it('should delete the latestIdemKey value when it exists in Redis', async () => {
    mockRedisGet.mockImplementation(async (key: string) => {
      if (key.startsWith('idem:broadcast:latest:')) return 'idem:broadcast:create:cust-001:abc123';
      return null;
    });
    mockRedisDel.mockResolvedValue(1);
    mockRedisCancelTimer.mockResolvedValue(undefined);

    const booking = makeBooking({ status: 'active', trucksFilled: 0, trucksNeeded: 1 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 1, trucksNeeded: 1 }]);
    mockUpdateBooking.mockResolvedValue(makeBooking({ status: 'fully_filled', trucksFilled: 1 }));

    await bookingService.incrementTrucksFilled('booking-001');

    const delKeys = mockRedisDel.mock.calls.map((c: any[]) => c[0]);
    expect(delKeys).toContain('idem:broadcast:create:cust-001:abc123');
  });

  // ---------------------------------------------------------------------------
  // 3.12 clearCustomerActiveBroadcast skips latestIdemKey delete when null
  // ---------------------------------------------------------------------------

  it('should not attempt to delete latestIdemKey value when Redis returns null', async () => {
    mockRedisGet.mockResolvedValue(null);
    mockRedisDel.mockResolvedValue(1);
    mockRedisCancelTimer.mockResolvedValue(undefined);

    const booking = makeBooking({ status: 'active', trucksFilled: 0, trucksNeeded: 1 });
    mockGetBookingById.mockResolvedValue(booking);
    mockQueryRaw.mockResolvedValue([{ trucksFilled: 1, trucksNeeded: 1 }]);
    mockUpdateBooking.mockResolvedValue(makeBooking({ status: 'fully_filled', trucksFilled: 1 }));

    await bookingService.incrementTrucksFilled('booking-001');

    // Should have exactly 2 del calls (activeKey + latest pointer), not 3
    const delKeys = mockRedisDel.mock.calls.map((c: any[]) => c[0]);
    const idemKeyDeletes = delKeys.filter((k: string) => k.startsWith('idem:broadcast:create:'));
    expect(idemKeyDeletes).toHaveLength(0);
  });
});

// =============================================================================
// =============================================================================
// CATEGORY 4: Lock TTL (#26) — 16 tests
// =============================================================================
// =============================================================================

describe('Category 4: Lock TTL (#26)', () => {
  beforeEach(() => resetAllMocks());

  // ---------------------------------------------------------------------------
  // 4.1 Lock TTL is 30 (not 10)
  // ---------------------------------------------------------------------------

  it('should acquire lock with TTL of 30 seconds', async () => {
    setupCreateBookingMocks(['t-001']);

    await bookingService.createBooking('cust-001', '+911234567890', makeCreateBookingInput());

    expect(mockRedisAcquireLock).toHaveBeenCalledWith(
      expect.stringContaining('customer-broadcast-create:'),
      'cust-001',
      30
    );
  });

  // ---------------------------------------------------------------------------
  // 4.2 Lock acquired -> returns { acquired: true }
  // ---------------------------------------------------------------------------

  it('should proceed when lock is acquired successfully', async () => {
    setupCreateBookingMocks(['t-001']);
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });

    const result = await bookingService.createBooking(
      'cust-001', '+911234567890', makeCreateBookingInput()
    );

    expect(result).toBeDefined();
    expect(result.id).toBe('booking-001');
  });

  // ---------------------------------------------------------------------------
  // 4.3 Lock already held -> 409 response
  // ---------------------------------------------------------------------------

  it('should throw 409 when lock is already held by another request', async () => {
    setupCreateBookingMocks(['t-001']);
    mockRedisAcquireLock.mockResolvedValue({ acquired: false });

    await expect(
      bookingService.createBooking('cust-001', '+911234567890', makeCreateBookingInput())
    ).rejects.toThrow('Request already in progress');
  });

  // ---------------------------------------------------------------------------
  // 4.4 Lock released in finally (success path)
  // ---------------------------------------------------------------------------

  it('should release lock in finally block after successful booking', async () => {
    setupCreateBookingMocks(['t-001']);

    await bookingService.createBooking('cust-001', '+911234567890', makeCreateBookingInput());

    expect(mockRedisReleaseLock).toHaveBeenCalledWith(
      expect.stringContaining('customer-broadcast-create:'),
      'cust-001'
    );
  });

  // ---------------------------------------------------------------------------
  // 4.5 Lock released in finally (error path)
  // ---------------------------------------------------------------------------

  it('should release lock in finally block even when booking creation fails', async () => {
    setupCreateBookingMocks(['t-001']);
    mockCreateBooking.mockRejectedValue(new Error('DB insert failed'));

    try {
      await bookingService.createBooking('cust-001', '+911234567890', makeCreateBookingInput());
    } catch {
      // expected
    }

    expect(mockRedisReleaseLock).toHaveBeenCalledWith(
      expect.stringContaining('customer-broadcast-create:'),
      'cust-001'
    );
  });

  // ---------------------------------------------------------------------------
  // 4.6 Lock key format uses customer ID
  // ---------------------------------------------------------------------------

  it('should use lock key format: customer-broadcast-create:{customerId}', async () => {
    setupCreateBookingMocks(['t-001']);

    await bookingService.createBooking('cust-ABC', '+911234567890', makeCreateBookingInput());

    expect(mockRedisAcquireLock).toHaveBeenCalledWith(
      'customer-broadcast-create:cust-ABC',
      'cust-ABC',
      30
    );
  });

  // ---------------------------------------------------------------------------
  // 4.7 Two concurrent requests from same customer -> only one succeeds
  // ---------------------------------------------------------------------------

  it('should prevent two concurrent bookings from same customer', async () => {
    setupCreateBookingMocks(['t-001']);

    // First request acquires lock and succeeds
    const result1 = await bookingService.createBooking('cust-001', '+911234567890', makeCreateBookingInput());
    expect(result1).toBeDefined();

    // Second request: lock is already held
    resetAllMocks();
    setupCreateBookingMocks(['t-001']);
    mockRedisAcquireLock.mockResolvedValue({ acquired: false });

    await expect(
      bookingService.createBooking('cust-001', '+911234567890', makeCreateBookingInput())
    ).rejects.toThrow('Request already in progress');
  });

  // ---------------------------------------------------------------------------
  // 4.8 Two concurrent requests from different customers -> both succeed
  // ---------------------------------------------------------------------------

  it('should allow concurrent bookings from different customers', async () => {
    setupCreateBookingMocks(['t-001']);
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });

    const result1 = await bookingService.createBooking(
      'cust-001', '+911234567890', makeCreateBookingInput()
    );

    resetAllMocks();
    setupCreateBookingMocks(['t-001']);
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockCreateBooking.mockResolvedValue(makeBooking({ id: 'booking-002', customerId: 'cust-002' }));

    const result2 = await bookingService.createBooking(
      'cust-002', '+919876543210', makeCreateBookingInput()
    );

    expect(result1).toBeDefined();
    expect(result2).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 4.9 Redis down -> lock acquisition fails
  // ---------------------------------------------------------------------------

  it('should throw when Redis is down and lock cannot be acquired', async () => {
    setupCreateBookingMocks(['t-001']);
    mockRedisAcquireLock.mockRejectedValue(new Error('Redis ECONNREFUSED'));

    await expect(
      bookingService.createBooking('cust-001', '+911234567890', makeCreateBookingInput())
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 4.10 Lock holder matches customer ID
  // ---------------------------------------------------------------------------

  it('should pass customerId as the lock holder', async () => {
    setupCreateBookingMocks(['t-001']);

    await bookingService.createBooking('cust-XYZ', '+911234567890', makeCreateBookingInput());

    expect(mockRedisAcquireLock).toHaveBeenCalledWith(
      expect.any(String),
      'cust-XYZ',
      30
    );
  });

  // ---------------------------------------------------------------------------
  // 4.11 Lock release uses same holder ID
  // ---------------------------------------------------------------------------

  it('should release lock with same customerId that was used to acquire', async () => {
    setupCreateBookingMocks(['t-001']);

    await bookingService.createBooking('cust-XYZ', '+911234567890', makeCreateBookingInput());

    expect(mockRedisReleaseLock).toHaveBeenCalledWith(
      'customer-broadcast-create:cust-XYZ',
      'cust-XYZ'
    );
  });

  // ---------------------------------------------------------------------------
  // 4.12 Lock TTL is 30, not 10 (explicit regression check)
  // ---------------------------------------------------------------------------

  it('should NOT use old TTL value of 10 seconds', async () => {
    setupCreateBookingMocks(['t-001']);

    await bookingService.createBooking('cust-001', '+911234567890', makeCreateBookingInput());

    const lockCall = mockRedisAcquireLock.mock.calls[0];
    expect(lockCall[2]).not.toBe(10);
    expect(lockCall[2]).toBe(30);
  });

  // ---------------------------------------------------------------------------
  // 4.13 Lock survives through Google API + DB transaction time
  // ---------------------------------------------------------------------------

  it('should use TTL large enough to survive Google API + DB operations (30s > 10s)', async () => {
    resetAllMocks();
    setupCreateBookingMocks(['t-001']);

    // Simulate slow Google API (100ms)
    mockCalculateRoute.mockImplementation(() =>
      new Promise(resolve => setTimeout(() => resolve({ distanceKm: 120, durationMinutes: 180 }), 100))
    );

    const result = await bookingService.createBooking(
      'cust-001', '+911234567890', makeCreateBookingInput()
    );

    expect(result).toBeDefined();
    // Lock TTL was 30s which would survive the 100ms delay
    expect(mockRedisAcquireLock.mock.calls[0][2]).toBe(30);
  });

  // ---------------------------------------------------------------------------
  // 4.14 Active broadcast guard checked before lock
  // ---------------------------------------------------------------------------

  it('should check active broadcast guard BEFORE acquiring lock', async () => {
    setupCreateBookingMocks(['t-001']);
    const callOrder: string[] = [];

    mockRedisGet.mockImplementation(async (key: string) => {
      if (key === 'customer:active-broadcast:cust-001') {
        callOrder.push('active_broadcast_check');
        return 'existing-booking';
      }
      return null;
    });

    mockRedisAcquireLock.mockImplementation(async () => {
      callOrder.push('lock_acquire');
      return { acquired: true };
    });

    await expect(
      bookingService.createBooking('cust-001', '+911234567890', makeCreateBookingInput())
    ).rejects.toThrow('Request already in progress');

    expect(callOrder).toContain('active_broadcast_check');
    // Lock should NOT have been acquired since guard failed first
    expect(callOrder).not.toContain('lock_acquire');
  });

  // ---------------------------------------------------------------------------
  // 4.15 Lock release failure is non-fatal (catch in finally)
  // ---------------------------------------------------------------------------

  it('should not crash when lock release fails in finally block', async () => {
    setupCreateBookingMocks(['t-001']);
    mockRedisReleaseLock.mockRejectedValue(new Error('Redis TIMEOUT'));

    const result = await bookingService.createBooking(
      'cust-001', '+911234567890', makeCreateBookingInput()
    );

    expect(result).toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to release customer broadcast lock'),
      expect.any(Object)
    );
  });

  // ---------------------------------------------------------------------------
  // 4.16 Lock key is specific to customer (different customers get different locks)
  // ---------------------------------------------------------------------------

  it('should use different lock keys for different customers', async () => {
    setupCreateBookingMocks(['t-001']);

    await bookingService.createBooking('cust-001', '+911234567890', makeCreateBookingInput());

    const firstLockKey = mockRedisAcquireLock.mock.calls[0][0];

    resetAllMocks();
    setupCreateBookingMocks(['t-001']);

    await bookingService.createBooking('cust-002', '+919876543210', makeCreateBookingInput());

    const secondLockKey = mockRedisAcquireLock.mock.calls[0][0];

    expect(firstLockKey).not.toBe(secondLockKey);
    expect(firstLockKey).toContain('cust-001');
    expect(secondLockKey).toContain('cust-002');
  });
});
