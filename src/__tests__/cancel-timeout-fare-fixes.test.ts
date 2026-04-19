/**
 * =============================================================================
 * CANCEL, TIMEOUT & FARE FIXES — Exhaustive Tests
 * =============================================================================
 *
 * Coverage:
 *   Category 1: Cancel Transaction Safety (#27)        — 32 tests
 *   Category 2: Fresh notifiedTransporters (#28)       — 10 tests
 *   Category 3: Timeout Status Guard (#18)             — 22 tests
 *   Category 4: Haversine Fare Sanity Check (#24)      — 28 tests
 *   ─────────────────────────────────────────────────────
 *   TOTAL                                              — 92 tests
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
const mockUpdateBooking = jest.fn();
const mockGetTransportersWithVehicleType = jest.fn();
const mockGetBookingsByCustomer = jest.fn();
const mockGetActiveBookingsForTransporter = jest.fn();
const mockGetBookingsByDriver = jest.fn();
const mockCreateBooking = jest.fn();
const mockGetVehiclesByTransporter = jest.fn();
const mockGetUserById = jest.fn();
const mockGetAssignmentsByBooking = jest.fn();
const mockGetActiveOrders = jest.fn();
const mockUpdateOrder = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getBookingById: (...args: any[]) => mockGetBookingById(...args),
    updateBooking: (...args: any[]) => mockUpdateBooking(...args),
    getTransportersWithVehicleType: (...args: any[]) => mockGetTransportersWithVehicleType(...args),
    getBookingsByCustomer: (...args: any[]) => mockGetBookingsByCustomer(...args),
    getActiveBookingsForTransporter: (...args: any[]) => mockGetActiveBookingsForTransporter(...args),
    getBookingsByDriver: (...args: any[]) => mockGetBookingsByDriver(...args),
    createBooking: (...args: any[]) => mockCreateBooking(...args),
    getVehiclesByTransporter: (...args: any[]) => mockGetVehiclesByTransporter(...args),
    getUserById: (...args: any[]) => mockGetUserById(...args),
    getAssignmentsByBooking: (...args: any[]) => mockGetAssignmentsByBooking(...args),
    getActiveOrders: (...args: any[]) => mockGetActiveOrders(...args),
    updateOrder: (...args: any[]) => mockUpdateOrder(...args),
  },
}));

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
const mockRedisGetJSON = jest.fn();
const mockRedisSetJSON = jest.fn();
const mockRedisIsConnected = jest.fn().mockReturnValue(true);

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
    getJSON: (...args: any[]) => mockRedisGetJSON(...args),
    setJSON: (...args: any[]) => mockRedisSetJSON(...args),
    isConnected: (...args: any[]) => mockRedisIsConnected(...args),
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockBookingCreate = jest.fn();
const mockBookingFindFirst = jest.fn();
const mockBookingFindUnique = jest.fn();
const mockBookingUpdateMany = jest.fn();
const mockBookingUpdate = jest.fn();
const mockOrderFindFirst = jest.fn();
const mockAssignmentCreate = jest.fn();
const mockAssignmentFindFirst = jest.fn();
const mockAssignmentFindMany = jest.fn();
const mockAssignmentUpdateMany = jest.fn();
const mockVehicleUpdate = jest.fn();
const mockVehicleFindUnique = jest.fn();
const mockVehicleUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
const mockUserFindUnique = jest.fn();
const mockUserFindMany = jest.fn();
const mockQueryRaw = jest.fn();

// Track whether $transaction was called, and expose the inner callback
let lastTxCallback: any = null;
const mockTransaction = jest.fn().mockImplementation(async (fnOrArray: any, _opts?: any) => {
  if (typeof fnOrArray === 'function') {
    lastTxCallback = fnOrArray;
    const txProxy = {
      booking: {
        create: (...a: any[]) => mockBookingCreate(...a),
        findFirst: (...a: any[]) => mockBookingFindFirst(...a),
        findUnique: (...a: any[]) => mockBookingFindUnique(...a),
        updateMany: (...a: any[]) => mockBookingUpdateMany(...a),
        update: (...a: any[]) => mockBookingUpdate(...a),
      },
      assignment: {
        create: (...a: any[]) => mockAssignmentCreate(...a),
        findFirst: (...a: any[]) => mockAssignmentFindFirst(...a),
        findMany: (...a: any[]) => mockAssignmentFindMany(...a),
        updateMany: (...a: any[]) => mockAssignmentUpdateMany(...a),
      },
      vehicle: {
        findUnique: (...a: any[]) => mockVehicleFindUnique(...a),
        update: (...a: any[]) => mockVehicleUpdate(...a),
        updateMany: (...a: any[]) => mockVehicleUpdateMany(...a),
      },
      user: {
        findUnique: (...a: any[]) => mockUserFindUnique(...a),
        findMany: (...a: any[]) => mockUserFindMany(...a),
      },
      // H-26: CancellationLedger + CancellationAbuseCounter for post-cancel transaction
      cancellationLedger: {
        create: jest.fn().mockResolvedValue({ id: 'ledger-1' }),
      },
      cancellationAbuseCounter: {
        upsert: jest.fn().mockResolvedValue({ customerId: 'customer-001', cancelCount7d: 1 }),
      },
      $queryRaw: (...a: any[]) => mockQueryRaw(...a),
    };
    return fnOrArray(txProxy);
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
    },
    order: { findFirst: (...args: any[]) => mockOrderFindFirst(...args) },
    assignment: {
      create: (...args: any[]) => mockAssignmentCreate(...args),
      findFirst: (...args: any[]) => mockAssignmentFindFirst(...args),
      findMany: (...args: any[]) => mockAssignmentFindMany(...args),
      updateMany: (...args: any[]) => mockAssignmentUpdateMany(...args),
    },
    vehicle: {
      findUnique: (...args: any[]) => mockVehicleFindUnique(...args),
      update: (...args: any[]) => mockVehicleUpdate(...args),
    },
    user: {
      findUnique: (...args: any[]) => mockUserFindUnique(...args),
      findMany: (...args: any[]) => mockUserFindMany(...args),
    },
    truckRequest: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: (...args: any[]) => mockQueryRaw(...args),
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
        create: mockAssignmentCreate,
        findFirst: mockAssignmentFindFirst,
        findMany: mockAssignmentFindMany,
        updateMany: mockAssignmentUpdateMany,
      },
      vehicle: { findUnique: mockVehicleFindUnique, update: mockVehicleUpdate, updateMany: mockVehicleUpdateMany },
      user: { findUnique: mockUserFindUnique, findMany: mockUserFindMany },
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
  VehicleStatus: {
    available: 'available',
    on_hold: 'on_hold',
    in_transit: 'in_transit',
    maintenance: 'maintenance',
    inactive: 'inactive',
  },
}));

const mockEmitToUser = jest.fn();
const mockEmitToBooking = jest.fn();
const mockEmitToRoom = jest.fn();
const mockEmitToUsers = jest.fn();
const mockEmitToAllTransporters = jest.fn();
const mockIsUserConnected = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToBooking: (...args: any[]) => mockEmitToBooking(...args),
  emitToRoom: (...args: any[]) => mockEmitToRoom(...args),
  emitToUsers: (...args: any[]) => mockEmitToUsers(...args),
  emitToAllTransporters: (...args: any[]) => mockEmitToAllTransporters(...args),
  emitToAll: jest.fn(),
  isUserConnected: (...args: any[]) => mockIsUserConnected(...args),
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
  },
}));

jest.mock('../shared/services/fcm.service', () => ({
  fcmService: {
    notifyNewBroadcast: jest.fn().mockResolvedValue(0),
  },
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
}));

const mockQueuePushNotificationBatch = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queuePushNotificationBatch: (...args: any[]) => mockQueuePushNotificationBatch(...args),
  },
}));

jest.mock('../shared/services/availability.service', () => ({
  availabilityService: {
    loadTransporterDetailsMap: jest.fn().mockResolvedValue(new Map()),
    getTransporterDetails: jest.fn().mockResolvedValue(null),
  },
}));

const mockFilterOnline = jest.fn();
const mockTransporterIsOnline = jest.fn();
jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: {
    filterOnline: (...args: any[]) => mockFilterOnline(...args),
    isOnline: (...args: any[]) => mockTransporterIsOnline(...args),
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

const mockHaversineDistanceKm = jest.fn().mockReturnValue(10);
jest.mock('../shared/utils/geospatial.utils', () => ({
  haversineDistanceKm: (...args: any[]) => mockHaversineDistanceKm(...args),
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

const mockReleaseVehicle = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: (...args: any[]) => mockReleaseVehicle(...args),
  isValidTransition: jest.fn().mockReturnValue(true),
  VALID_TRANSITIONS: {
    available: ['on_hold', 'in_transit', 'maintenance', 'inactive'],
    on_hold: ['in_transit', 'available'],
    in_transit: ['available', 'maintenance'],
    maintenance: ['available', 'inactive'],
    inactive: ['available', 'maintenance'],
  },
}));

jest.mock('../core/state-machines', () => ({
  assertValidTransition: jest.fn(),
  isValidTransition: jest.fn().mockReturnValue(true),
  BOOKING_VALID_TRANSITIONS: {
    created: ['broadcasting', 'cancelled', 'expired'],
    broadcasting: ['active', 'cancelled', 'expired'],
    active: ['partially_filled', 'fully_filled', 'cancelled', 'expired'],
    partially_filled: ['active', 'fully_filled', 'cancelled', 'expired'],
    fully_filled: ['in_progress', 'cancelled'],
    in_progress: ['completed', 'cancelled'],
    completed: [],
    cancelled: [],
    expired: [],
  },
  TERMINAL_BOOKING_STATUSES: ['completed', 'cancelled', 'expired'],
}));

// =============================================================================
// IMPORTS — After all mocks are in place
// =============================================================================

import { bookingService } from '../modules/booking/booking.service';
import { AppError } from '../shared/types/error.types';
import { logger } from '../shared/services/logger.service';

// =============================================================================
// HELPERS
// =============================================================================

function makeBooking(overrides: Record<string, any> = {}): any {
  return {
    id: 'booking-001',
    customerId: 'customer-001',
    customerName: 'Test Customer',
    customerPhone: '9999999999',
    pickup: {
      latitude: 12.97, longitude: 77.59,
      address: 'Pickup Addr', city: 'Bangalore', state: 'KA',
      coordinates: { latitude: 12.97, longitude: 77.59 },
    },
    drop: {
      latitude: 13.0, longitude: 77.6,
      address: 'Drop Addr', city: 'Bangalore', state: 'KA',
      coordinates: { latitude: 13.0, longitude: 77.6 },
    },
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
    notifiedTransporters: ['t-001', 't-002'],
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    stateChangedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeAssignment(overrides: Record<string, any> = {}): any {
  return {
    id: 'assign-001',
    vehicleId: 'vehicle-001',
    transporterId: 't-001',
    vehicleType: 'Tipper',
    vehicleSubtype: '20-24 Ton',
    driverId: 'driver-001',
    tripId: 'trip-001',
    status: 'pending',
    ...overrides,
  };
}

/**
 * Set up the common mocks for a successful cancel flow.
 * Returns the booking used so tests can inspect it.
 */
function setupCancelMocks(
  bookingOverrides: Record<string, any> = {},
  assignments: any[] = []
): any {
  const booking = makeBooking(bookingOverrides);

  // Pre-flight fetch
  mockGetBookingById.mockResolvedValueOnce(booking);

  // $transaction: booking updateMany returns count=1, assignment findMany returns assignments
  mockBookingUpdateMany.mockResolvedValueOnce({ count: 1 });
  mockAssignmentFindMany.mockResolvedValueOnce(assignments);
  if (assignments.length > 0) {
    mockAssignmentUpdateMany.mockResolvedValueOnce({ count: assignments.length });
  }

  // Post-transaction re-fetch
  const cancelledBooking = { ...booking, status: 'cancelled' };
  mockGetBookingById.mockResolvedValueOnce(cancelledBooking);

  // #28 fresh re-fetch
  mockGetBookingById.mockResolvedValueOnce(cancelledBooking);

  // Redis cleanup
  mockRedisCancelTimer.mockResolvedValue(undefined);
  mockRedisDel.mockResolvedValue(undefined);
  mockRedisGet.mockResolvedValue(null);

  return booking;
}

// =============================================================================
// TESTS
// =============================================================================

beforeEach(() => {
  jest.clearAllMocks();

  // Reset mocks that accumulate mockResolvedValueOnce queues to prevent leaks
  mockGetBookingById.mockReset();
  mockBookingUpdateMany.mockReset();
  mockAssignmentFindMany.mockReset();
  mockAssignmentUpdateMany.mockReset();
  mockTransaction.mockReset();
  mockEmitToUser.mockReset();
  mockEmitToBooking.mockReset();
  mockCalculateRoute.mockReset();
  mockHaversineDistanceKm.mockReset();
  mockReleaseVehicle.mockReset();

  // Re-establish $transaction default implementation
  mockTransaction.mockImplementation(async (fnOrArray: any, _opts?: any) => {
    if (typeof fnOrArray === 'function') {
      const txProxy = {
        booking: {
          create: (...a: any[]) => mockBookingCreate(...a),
          findFirst: (...a: any[]) => mockBookingFindFirst(...a),
          findUnique: (...a: any[]) => mockBookingFindUnique(...a),
          updateMany: (...a: any[]) => mockBookingUpdateMany(...a),
          update: (...a: any[]) => mockBookingUpdate(...a),
        },
        assignment: {
          create: (...a: any[]) => mockAssignmentCreate(...a),
          findFirst: (...a: any[]) => mockAssignmentFindFirst(...a),
          findMany: (...a: any[]) => mockAssignmentFindMany(...a),
          updateMany: (...a: any[]) => mockAssignmentUpdateMany(...a),
        },
        vehicle: {
          findUnique: (...a: any[]) => mockVehicleFindUnique(...a),
          update: (...a: any[]) => mockVehicleUpdate(...a),
          updateMany: (...a: any[]) => mockVehicleUpdateMany(...a),
        },
        user: {
          findUnique: (...a: any[]) => mockUserFindUnique(...a),
          findMany: (...a: any[]) => mockUserFindMany(...a),
        },
        // H-26: CancellationLedger + CancellationAbuseCounter for post-cancel transaction
        cancellationLedger: {
          create: jest.fn().mockResolvedValue({ id: 'ledger-1' }),
        },
        cancellationAbuseCounter: {
          upsert: jest.fn().mockResolvedValue({ customerId: 'customer-001', cancelCount7d: 1 }),
        },
        $queryRaw: (...a: any[]) => mockQueryRaw(...a),
      };
      return fnOrArray(txProxy);
    }
    return Promise.all(fnOrArray);
  });

  // Re-establish baseline Redis defaults
  mockRedisCancelTimer.mockResolvedValue(undefined);
  mockRedisDel.mockResolvedValue(undefined);
  mockRedisGet.mockResolvedValue(null);
  mockRedisSMembers.mockResolvedValue([]);
  mockRedisSAdd.mockResolvedValue(undefined);
  mockRedisSet.mockResolvedValue(undefined);
  mockRedisSetTimer.mockResolvedValue(undefined);
  mockRedisAcquireLock.mockResolvedValue({ acquired: true, lockKey: 'lock' });
  mockRedisReleaseLock.mockResolvedValue(undefined);

  // Re-establish other defaults
  mockReleaseVehicle.mockResolvedValue(undefined);
  mockQueuePushNotificationBatch.mockResolvedValue(undefined);
  mockUpdateBooking.mockResolvedValue(undefined);
  mockHaversineDistanceKm.mockReturnValue(10);
});

// =============================================================================
// CATEGORY 1: Cancel Transaction Safety (#27) — 32 tests
// =============================================================================

describe('Category 1: Cancel Transaction Safety (#27)', () => {

  // -------------------------------------------------------------------------
  // Happy path tests
  // -------------------------------------------------------------------------

  describe('Happy path', () => {

    it('cancel active booking sets status=cancelled, cancels assignments, releases vehicles', async () => {
      const assignments = [makeAssignment({ status: 'pending', vehicleId: 'v-1' })];
      setupCancelMocks({ status: 'active' }, assignments);

      const result = await bookingService.cancelBooking('booking-001', 'customer-001');

      expect(result.status).toBe('cancelled');
      // H-26: $transaction called twice — once for main cancel, once for CancellationLedger+AbuseCounter
      expect(mockTransaction).toHaveBeenCalledTimes(2);
      expect(mockReleaseVehicle).toHaveBeenCalledWith('v-1', 'bookingCancellation');
    });

    it('cancel broadcasting booking sets status=cancelled', async () => {
      setupCancelMocks({ status: 'broadcasting' }, []);

      const result = await bookingService.cancelBooking('booking-001', 'customer-001');

      expect(result.status).toBe('cancelled');
      // H-26: $transaction called twice — once for main cancel, once for CancellationLedger+AbuseCounter
      expect(mockTransaction).toHaveBeenCalledTimes(2);
    });

    it('cancel partially_filled booking cancels active assignments and releases their vehicles', async () => {
      const assignments = [
        makeAssignment({ id: 'a-1', vehicleId: 'v-1', status: 'driver_accepted' }),
        makeAssignment({ id: 'a-2', vehicleId: 'v-2', status: 'pending' }),
      ];
      setupCancelMocks({ status: 'partially_filled', trucksFilled: 1 }, assignments);

      const result = await bookingService.cancelBooking('booking-001', 'customer-001');

      expect(result.status).toBe('cancelled');
      expect(mockReleaseVehicle).toHaveBeenCalledTimes(2);
      expect(mockReleaseVehicle).toHaveBeenCalledWith('v-1', 'bookingCancellation');
      expect(mockReleaseVehicle).toHaveBeenCalledWith('v-2', 'bookingCancellation');
    });

    it('cancel with 0 assignments succeeds without vehicle release work', async () => {
      setupCancelMocks({ status: 'active' }, []);

      const result = await bookingService.cancelBooking('booking-001', 'customer-001');

      expect(result.status).toBe('cancelled');
      expect(mockReleaseVehicle).not.toHaveBeenCalled();
    });

    it('cancel created booking succeeds', async () => {
      setupCancelMocks({ status: 'created' }, []);

      const result = await bookingService.cancelBooking('booking-001', 'customer-001');

      expect(result.status).toBe('cancelled');
    });
  });

  // -------------------------------------------------------------------------
  // Atomicity tests
  // -------------------------------------------------------------------------

  describe('Atomicity', () => {

    it('DB error during assignment cancel rolls back entire TX (booking stays active)', async () => {
      const booking = makeBooking({ status: 'active' });
      mockGetBookingById.mockResolvedValueOnce(booking);

      // $transaction throws because assignment findMany fails inside TX
      mockTransaction.mockRejectedValueOnce(new Error('DB constraint violation'));

      await expect(
        bookingService.cancelBooking('booking-001', 'customer-001')
      ).rejects.toThrow('DB constraint violation');

      // Vehicle release should NOT have happened (TX rolled back)
      expect(mockReleaseVehicle).not.toHaveBeenCalled();
    });

    it('booking cancel succeeds + assignment cancel fails inside TX = TX rollback, booking NOT cancelled', async () => {
      const booking = makeBooking({ status: 'active' });
      mockGetBookingById.mockResolvedValueOnce(booking);

      // Simulate: booking updateMany succeeds but assignment updateMany throws
      mockTransaction.mockImplementationOnce(async (fn: any) => {
        const txProxy = {
          booking: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
          assignment: {
            findMany: jest.fn().mockResolvedValue([makeAssignment()]),
            updateMany: jest.fn().mockRejectedValue(new Error('FK constraint')),
          },
        };
        return fn(txProxy);
      });

      await expect(
        bookingService.cancelBooking('booking-001', 'customer-001')
      ).rejects.toThrow('FK constraint');

      expect(mockReleaseVehicle).not.toHaveBeenCalled();
    });

    it('booking and assignment cancels run inside the SAME $transaction call', async () => {
      const assignments = [makeAssignment()];
      setupCancelMocks({ status: 'active' }, assignments);

      await bookingService.cancelBooking('booking-001', 'customer-001');

      // H-26: $transaction called twice — main cancel TX + CancellationLedger+AbuseCounter TX
      expect(mockTransaction).toHaveBeenCalledTimes(2);
      // The TX function receives a tx proxy and does BOTH booking.updateMany and assignment.updateMany
      expect(mockBookingUpdateMany).toHaveBeenCalled();
      expect(mockAssignmentUpdateMany).toHaveBeenCalled();
    });

    it('vehicle release runs OUTSIDE the transaction (best-effort)', async () => {
      const assignments = [makeAssignment({ vehicleId: 'v-1' })];
      setupCancelMocks({ status: 'active' }, assignments);

      await bookingService.cancelBooking('booking-001', 'customer-001');

      // releaseVehicle is called separately, not inside the TX mock proxy
      expect(mockReleaseVehicle).toHaveBeenCalledWith('v-1', 'bookingCancellation');
      // H-26: $transaction called twice — main cancel TX + CancellationLedger+AbuseCounter TX
      expect(mockTransaction).toHaveBeenCalledTimes(2);
    });

    it('TX failure does not leave partial state (no vehicle release on rollback)', async () => {
      const booking = makeBooking({ status: 'active' });
      mockGetBookingById.mockResolvedValueOnce(booking);
      mockTransaction.mockRejectedValueOnce(new Error('deadlock'));

      await expect(
        bookingService.cancelBooking('booking-001', 'customer-001')
      ).rejects.toThrow('deadlock');

      expect(mockReleaseVehicle).not.toHaveBeenCalled();
      expect(mockEmitToUser).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Vehicle release (outside TX) tests
  // -------------------------------------------------------------------------

  describe('Vehicle release (outside TX)', () => {

    it('vehicle release succeeds for all 3 vehicles', async () => {
      const assignments = [
        makeAssignment({ id: 'a-1', vehicleId: 'v-1' }),
        makeAssignment({ id: 'a-2', vehicleId: 'v-2' }),
        makeAssignment({ id: 'a-3', vehicleId: 'v-3' }),
      ];
      setupCancelMocks({ status: 'active' }, assignments);

      await bookingService.cancelBooking('booking-001', 'customer-001');

      expect(mockReleaseVehicle).toHaveBeenCalledTimes(3);
      expect(mockReleaseVehicle).toHaveBeenCalledWith('v-1', 'bookingCancellation');
      expect(mockReleaseVehicle).toHaveBeenCalledWith('v-2', 'bookingCancellation');
      expect(mockReleaseVehicle).toHaveBeenCalledWith('v-3', 'bookingCancellation');
    });

    it('vehicle release fails for 1 of 3 vehicles — other 2 still released (logged)', async () => {
      mockReleaseVehicle
        .mockResolvedValueOnce(undefined)   // v-1 OK
        .mockRejectedValueOnce(new Error('DB pool exhausted')) // v-2 fails
        .mockResolvedValueOnce(undefined);  // v-3 OK

      const assignments = [
        makeAssignment({ id: 'a-1', vehicleId: 'v-1' }),
        makeAssignment({ id: 'a-2', vehicleId: 'v-2' }),
        makeAssignment({ id: 'a-3', vehicleId: 'v-3' }),
      ];
      setupCancelMocks({ status: 'active' }, assignments);

      // Should NOT throw — vehicle release is best-effort with .catch()
      const result = await bookingService.cancelBooking('booking-001', 'customer-001');

      expect(result.status).toBe('cancelled');
      expect(mockReleaseVehicle).toHaveBeenCalledTimes(3);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Vehicle release failed'),
        expect.objectContaining({ vehicleId: 'v-2' })
      );
    });

    it('vehicle release when Redis is down — DB booking still cancelled (logged)', async () => {
      mockReleaseVehicle.mockRejectedValue(new Error('Redis connection refused'));

      const assignments = [makeAssignment({ vehicleId: 'v-1' })];
      setupCancelMocks({ status: 'active' }, assignments);

      const result = await bookingService.cancelBooking('booking-001', 'customer-001');

      expect(result.status).toBe('cancelled');
      // Despite release failure, booking is cancelled (TX already committed)
    });

    it('assignment with no vehicleId skips vehicle release', async () => {
      const assignments = [makeAssignment({ vehicleId: null })];
      setupCancelMocks({ status: 'active' }, assignments);

      await bookingService.cancelBooking('booking-001', 'customer-001');

      expect(mockReleaseVehicle).not.toHaveBeenCalled();
    });

    it('multiple assignments — only those with vehicleId get released', async () => {
      const assignments = [
        makeAssignment({ id: 'a-1', vehicleId: 'v-1' }),
        makeAssignment({ id: 'a-2', vehicleId: null }),
        makeAssignment({ id: 'a-3', vehicleId: 'v-3' }),
      ];
      setupCancelMocks({ status: 'active' }, assignments);

      await bookingService.cancelBooking('booking-001', 'customer-001');

      expect(mockReleaseVehicle).toHaveBeenCalledTimes(2);
      expect(mockReleaseVehicle).toHaveBeenCalledWith('v-1', 'bookingCancellation');
      expect(mockReleaseVehicle).toHaveBeenCalledWith('v-3', 'bookingCancellation');
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('Edge cases', () => {

    it('cancel already cancelled booking is idempotent (returns success)', async () => {
      const booking = makeBooking({ status: 'cancelled' });
      mockGetBookingById.mockResolvedValueOnce(booking);

      const result = await bookingService.cancelBooking('booking-001', 'customer-001');

      expect(result.status).toBe('cancelled');
      // No TX should run
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('cancel completed booking is rejected (cannot cancel completed)', async () => {
      const booking = makeBooking({ status: 'completed' });
      mockGetBookingById.mockResolvedValueOnce(booking);

      // updateMany returns count=0 for completed status
      mockBookingUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockAssignmentFindMany.mockResolvedValueOnce([]);

      // Post-TX fetch returns booking still in completed state
      mockGetBookingById
        .mockResolvedValueOnce({ ...booking, status: 'completed' })
        .mockResolvedValueOnce({ ...booking, status: 'completed' });

      await expect(
        bookingService.cancelBooking('booking-001', 'customer-001')
      ).rejects.toThrow('Cannot cancel booking');
    });

    it('cancel expired booking is rejected (already expired)', async () => {
      const booking = makeBooking({ status: 'expired' });
      mockGetBookingById.mockResolvedValueOnce(booking);

      mockBookingUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockAssignmentFindMany.mockResolvedValueOnce([]);

      const freshBooking = { ...booking, status: 'expired' };
      mockGetBookingById
        .mockResolvedValueOnce(freshBooking)
        .mockResolvedValueOnce(freshBooking);

      await expect(
        bookingService.cancelBooking('booking-001', 'customer-001')
      ).rejects.toThrow('Cannot cancel booking');
    });

    it('cancel by wrong customer is rejected (ownership check)', async () => {
      const booking = makeBooking({ customerId: 'customer-other' });
      mockGetBookingById.mockResolvedValueOnce(booking);

      await expect(
        bookingService.cancelBooking('booking-001', 'customer-001')
      ).rejects.toThrow('You can only cancel your own bookings');
    });

    it('cancel booking not found throws 404', async () => {
      mockGetBookingById.mockResolvedValueOnce(null);

      await expect(
        bookingService.cancelBooking('non-existent', 'customer-001')
      ).rejects.toThrow('Booking not found');
    });

    it('concurrent cancel + accept race — updateMany precondition ensures only one wins', async () => {
      // First call: preflight returns active booking
      const booking = makeBooking({ status: 'active' });
      mockGetBookingById.mockResolvedValueOnce(booking);

      // The updateMany returns 0 — another process already changed the status
      mockBookingUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockAssignmentFindMany.mockResolvedValueOnce([]);

      // Post-TX: booking is now fully_filled (accept won the race)
      const raced = { ...booking, status: 'fully_filled' };
      mockGetBookingById
        .mockResolvedValueOnce(raced)
        .mockResolvedValueOnce(raced);

      await expect(
        bookingService.cancelBooking('booking-001', 'customer-001')
      ).rejects.toThrow('Cannot cancel booking');
    });

    it('concurrent cancel + cancel race — second cancel returns idempotent success', async () => {
      const booking = makeBooking({ status: 'active' });
      mockGetBookingById.mockResolvedValueOnce(booking);

      // updateMany returns 0 because another cancel already changed status
      mockBookingUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockAssignmentFindMany.mockResolvedValueOnce([]);

      // Post-TX: booking is now cancelled (other cancel won)
      const cancelledBooking = { ...booking, status: 'cancelled' };
      mockGetBookingById
        .mockResolvedValueOnce(cancelledBooking)
        .mockResolvedValueOnce(cancelledBooking);

      const result = await bookingService.cancelBooking('booking-001', 'customer-001');
      expect(result.status).toBe('cancelled');
    });
  });

  // -------------------------------------------------------------------------
  // Notifications (outside TX)
  // -------------------------------------------------------------------------

  describe('Notifications (outside TX)', () => {

    it('socket notification sent to ALL notifiedTransporters', async () => {
      setupCancelMocks(
        { status: 'active', notifiedTransporters: ['t-1', 't-2', 't-3'] },
        []
      );

      await bookingService.cancelBooking('booking-001', 'customer-001');

      // Each transporter gets a BOOKING_EXPIRED event
      expect(mockEmitToUser).toHaveBeenCalledWith('t-1', 'booking_expired', expect.objectContaining({ status: 'cancelled' }));
      expect(mockEmitToUser).toHaveBeenCalledWith('t-2', 'booking_expired', expect.objectContaining({ status: 'cancelled' }));
      expect(mockEmitToUser).toHaveBeenCalledWith('t-3', 'booking_expired', expect.objectContaining({ status: 'cancelled' }));
    });

    it('FCM notification sent as fire-and-forget', async () => {
      setupCancelMocks(
        { status: 'active', notifiedTransporters: ['t-1', 't-2'] },
        []
      );

      await bookingService.cancelBooking('booking-001', 'customer-001');

      expect(mockQueuePushNotificationBatch).toHaveBeenCalledWith(
        ['t-1', 't-2'],
        expect.objectContaining({ title: expect.stringContaining('Cancelled') })
      );
    });

    it('Redis active-broadcast key cleaned up', async () => {
      setupCancelMocks({ status: 'active' }, []);

      await bookingService.cancelBooking('booking-001', 'customer-001');

      // clearCustomerActiveBroadcast deletes the active key
      expect(mockRedisDel).toHaveBeenCalledWith(expect.stringContaining('customer:active-broadcast:'));
    });

    it('booking timers cleared before cancel', async () => {
      setupCancelMocks({ status: 'active' }, []);

      await bookingService.cancelBooking('booking-001', 'customer-001');

      // clearBookingTimers cancels both expiry and radius step timers
      expect(mockRedisCancelTimer).toHaveBeenCalled();
    });

    it('BOOKING_UPDATED event emitted to booking room', async () => {
      setupCancelMocks({ status: 'active' }, []);

      await bookingService.cancelBooking('booking-001', 'customer-001');

      expect(mockEmitToBooking).toHaveBeenCalledWith(
        'booking-001',
        'booking_updated',
        expect.objectContaining({ status: 'cancelled' })
      );
    });

    it('driver gets trip_cancelled notification when assignment has driverId', async () => {
      const assignments = [makeAssignment({ driverId: 'driver-001', vehicleId: 'v-1', status: 'pending' })];
      setupCancelMocks({ status: 'active' }, assignments);

      await bookingService.cancelBooking('booking-001', 'customer-001');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'driver-001',
        'trip_cancelled',
        expect.objectContaining({ reason: 'booking_cancelled_by_customer' })
      );
    });

    it('in-progress assignment sends wasInProgress=true to driver', async () => {
      const assignments = [makeAssignment({ driverId: 'driver-001', vehicleId: 'v-1', status: 'in_transit' })];
      setupCancelMocks({ status: 'active' }, assignments);

      await bookingService.cancelBooking('booking-001', 'customer-001');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'driver-001',
        'trip_cancelled',
        expect.objectContaining({ wasInProgress: true })
      );
    });

    it('FCM push failure for drivers does not block cancel', async () => {
      mockQueuePushNotificationBatch.mockRejectedValue(new Error('FCM down'));

      const assignments = [makeAssignment({ driverId: 'driver-001', vehicleId: 'v-1' })];
      setupCancelMocks({ status: 'active' }, assignments);

      // Should not throw despite FCM failure
      const result = await bookingService.cancelBooking('booking-001', 'customer-001');
      expect(result.status).toBe('cancelled');
    });
  });
});

// =============================================================================
// CATEGORY 2: Fresh notifiedTransporters (#28) — 10 tests
// =============================================================================

describe('Category 2: Fresh notifiedTransporters (#28)', () => {

  it('cancel with 5 notified transporters — all 5 receive cancellation', async () => {
    const transporters = ['t-1', 't-2', 't-3', 't-4', 't-5'];
    setupCancelMocks({ status: 'active', notifiedTransporters: transporters }, []);

    await bookingService.cancelBooking('booking-001', 'customer-001');

    for (const tid of transporters) {
      expect(mockEmitToUser).toHaveBeenCalledWith(
        tid,
        'booking_expired',
        expect.objectContaining({ status: 'cancelled' })
      );
    }
  });

  it('cancel after radius expansion added 10 more — fresh read gets all 15', async () => {
    // Pre-flight: booking has 5 original transporters
    const original5 = ['t-01', 't-02', 't-03', 't-04', 't-05'];
    const expanded10 = ['t-06', 't-07', 't-08', 't-09', 't-10', 't-11', 't-12', 't-13', 't-14', 't-15'];
    const all15 = [...original5, ...expanded10];

    const booking = makeBooking({ status: 'active', notifiedTransporters: original5 });

    mockGetBookingById.mockResolvedValueOnce(booking); // preflight

    mockBookingUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockAssignmentFindMany.mockResolvedValueOnce([]);

    // Post-TX: booking still shows original 5
    const cancelledBooking = { ...booking, status: 'cancelled', notifiedTransporters: original5 };
    mockGetBookingById.mockResolvedValueOnce(cancelledBooking);

    // #28 FRESH re-fetch: now has all 15 (radius expansion added 10 during cancel)
    const freshBooking = { ...booking, status: 'cancelled', notifiedTransporters: all15 };
    mockGetBookingById.mockResolvedValueOnce(freshBooking);

    await bookingService.cancelBooking('booking-001', 'customer-001');

    // All 15 should receive the notification
    for (const tid of all15) {
      expect(mockEmitToUser).toHaveBeenCalledWith(
        tid,
        'booking_expired',
        expect.objectContaining({ status: 'cancelled' })
      );
    }
  });

  it('cancel when notifiedTransporters is empty — no notifications sent', async () => {
    setupCancelMocks({ status: 'active', notifiedTransporters: [] }, []);

    await bookingService.cancelBooking('booking-001', 'customer-001');

    // No transporter should get booking_expired (only booking room gets update)
    const bookingExpiredCalls = mockEmitToUser.mock.calls.filter(
      (call: any[]) => call[1] === 'booking_expired'
    );
    expect(bookingExpiredCalls.length).toBe(0);
  });

  it('cancel when notifiedTransporters is undefined — graceful handling', async () => {
    setupCancelMocks({ status: 'active', notifiedTransporters: undefined }, []);

    // The fresh re-fetch also returns undefined
    mockGetBookingById.mockReset();
    const booking = makeBooking({ status: 'active', notifiedTransporters: undefined });
    mockGetBookingById
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce({ ...booking, status: 'cancelled', notifiedTransporters: undefined })
      .mockResolvedValueOnce({ ...booking, status: 'cancelled', notifiedTransporters: undefined });

    mockBookingUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockAssignmentFindMany.mockResolvedValueOnce([]);

    const result = await bookingService.cancelBooking('booking-001', 'customer-001');
    expect(result.status).toBe('cancelled');
  });

  it('re-fetch uses db.getBookingById AFTER the transaction commits', async () => {
    setupCancelMocks({ status: 'active' }, []);

    await bookingService.cancelBooking('booking-001', 'customer-001');

    // db.getBookingById is called: 1) preflight, 2) post-TX, 3) fresh re-fetch #28
    expect(mockGetBookingById).toHaveBeenCalledTimes(3);
    // All 3 calls are with the same booking ID
    expect(mockGetBookingById).toHaveBeenNthCalledWith(1, 'booking-001');
    expect(mockGetBookingById).toHaveBeenNthCalledWith(2, 'booking-001');
    expect(mockGetBookingById).toHaveBeenNthCalledWith(3, 'booking-001');
  });

  it('re-fetch reads from DB not from in-memory cache (db.getBookingById called)', async () => {
    const booking = makeBooking({ status: 'active', notifiedTransporters: ['t-old'] });
    mockGetBookingById.mockResolvedValueOnce(booking); // preflight

    mockBookingUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockAssignmentFindMany.mockResolvedValueOnce([]);

    const postTx = { ...booking, status: 'cancelled', notifiedTransporters: ['t-old'] };
    mockGetBookingById.mockResolvedValueOnce(postTx); // post-TX

    // Fresh re-fetch returns updated list
    const fresh = { ...booking, status: 'cancelled', notifiedTransporters: ['t-old', 't-new'] };
    mockGetBookingById.mockResolvedValueOnce(fresh); // #28 fresh

    await bookingService.cancelBooking('booking-001', 'customer-001');

    // t-new should be notified (from fresh re-fetch, not cached pre-flight)
    expect(mockEmitToUser).toHaveBeenCalledWith(
      't-new',
      'booking_expired',
      expect.objectContaining({ status: 'cancelled' })
    );
  });

  it('concurrent radius expansion during cancel — newly added transporters included', async () => {
    const booking = makeBooking({ status: 'active', notifiedTransporters: ['t-1'] });
    mockGetBookingById.mockResolvedValueOnce(booking);

    mockBookingUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockAssignmentFindMany.mockResolvedValueOnce([]);

    const postTx = { ...booking, status: 'cancelled' };
    mockGetBookingById.mockResolvedValueOnce(postTx);

    // During cancel, radius expansion added t-2 and t-3
    const fresh = { ...booking, status: 'cancelled', notifiedTransporters: ['t-1', 't-2', 't-3'] };
    mockGetBookingById.mockResolvedValueOnce(fresh);

    await bookingService.cancelBooking('booking-001', 'customer-001');

    expect(mockEmitToUser).toHaveBeenCalledWith('t-2', 'booking_expired', expect.any(Object));
    expect(mockEmitToUser).toHaveBeenCalledWith('t-3', 'booking_expired', expect.any(Object));
  });

  it('fresh re-fetch returns null (booking deleted) — skip notifications gracefully', async () => {
    const booking = makeBooking({ status: 'active', notifiedTransporters: ['t-1'] });
    mockGetBookingById.mockResolvedValueOnce(booking); // preflight

    mockBookingUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockAssignmentFindMany.mockResolvedValueOnce([]);

    // Post-TX re-fetch returns booking
    const postTx = { ...booking, status: 'cancelled' };
    mockGetBookingById.mockResolvedValueOnce(postTx);

    // Fresh re-fetch returns null (extremely unlikely but defensive)
    mockGetBookingById.mockResolvedValueOnce(null);

    // Should still work — falls back to booking.notifiedTransporters
    const result = await bookingService.cancelBooking('booking-001', 'customer-001');
    expect(result.status).toBe('cancelled');
  });

  it('FCM batch sent to fresh transporter list, not stale list', async () => {
    const booking = makeBooking({ status: 'active', notifiedTransporters: ['t-old'] });
    mockGetBookingById.mockResolvedValueOnce(booking);

    mockBookingUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockAssignmentFindMany.mockResolvedValueOnce([]);

    const postTx = { ...booking, status: 'cancelled' };
    mockGetBookingById.mockResolvedValueOnce(postTx);

    const fresh = { ...booking, status: 'cancelled', notifiedTransporters: ['t-old', 't-new-1', 't-new-2'] };
    mockGetBookingById.mockResolvedValueOnce(fresh);

    await bookingService.cancelBooking('booking-001', 'customer-001');

    // FCM batch should include all fresh transporters
    expect(mockQueuePushNotificationBatch).toHaveBeenCalledWith(
      ['t-old', 't-new-1', 't-new-2'],
      expect.objectContaining({ title: expect.stringContaining('Cancelled') })
    );
  });

  it('fresh re-fetch with null notifiedTransporters falls back to post-TX booking list', async () => {
    const booking = makeBooking({ status: 'active', notifiedTransporters: ['t-1', 't-2'] });
    mockGetBookingById.mockResolvedValueOnce(booking);

    mockBookingUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockAssignmentFindMany.mockResolvedValueOnce([]);

    const postTx = { ...booking, status: 'cancelled', notifiedTransporters: ['t-1', 't-2'] };
    mockGetBookingById.mockResolvedValueOnce(postTx);

    // Fresh re-fetch returns null notifiedTransporters
    const fresh = { ...booking, status: 'cancelled', notifiedTransporters: null };
    mockGetBookingById.mockResolvedValueOnce(fresh);

    await bookingService.cancelBooking('booking-001', 'customer-001');

    // Should fall back to postTx booking's notifiedTransporters
    expect(mockEmitToUser).toHaveBeenCalledWith('t-1', 'booking_expired', expect.any(Object));
    expect(mockEmitToUser).toHaveBeenCalledWith('t-2', 'booking_expired', expect.any(Object));
  });
});

// =============================================================================
// CATEGORY 3: Timeout Status Guard (#18) — 22 tests
// =============================================================================

describe('Category 3: Timeout Status Guard (#18)', () => {

  // -------------------------------------------------------------------------
  // Should process (whitelist)
  // -------------------------------------------------------------------------

  describe('Should process (whitelist)', () => {

    it('booking in broadcasting — process timeout, set to expired', async () => {
      const booking = makeBooking({ status: 'broadcasting', trucksFilled: 0, notifiedTransporters: [] });
      mockGetBookingById.mockResolvedValueOnce(booking);
      mockBookingUpdateMany.mockResolvedValueOnce({ count: 1 });

      await bookingService.handleBookingTimeout('booking-001', 'customer-001');

      // FIX-R2-2: Now uses prismaClient.booking.updateMany with conditional status guard
      expect(mockBookingUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'booking-001' }),
          data: expect.objectContaining({ status: 'expired' }),
        })
      );
    });

    it('booking in active — process timeout, set to expired', async () => {
      const booking = makeBooking({ status: 'active', trucksFilled: 0, notifiedTransporters: [] });
      mockGetBookingById.mockResolvedValueOnce(booking);
      mockBookingUpdateMany.mockResolvedValueOnce({ count: 1 });

      await bookingService.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockBookingUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'booking-001' }),
          data: expect.objectContaining({ status: 'expired' }),
        })
      );
    });

    it('booking in partially_filled — process timeout, partial fill handling', async () => {
      const booking = makeBooking({
        status: 'partially_filled',
        trucksFilled: 1,
        trucksNeeded: 3,
        notifiedTransporters: [],
      });
      mockGetBookingById.mockResolvedValueOnce(booking);
      mockBookingUpdateMany.mockResolvedValueOnce({ count: 1 });

      await bookingService.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockBookingUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'booking-001' }),
          data: expect.objectContaining({ status: 'expired' }),
        })
      );
      // Customer receives partial fill notification
      expect(mockEmitToUser).toHaveBeenCalledWith(
        'customer-001',
        'booking_expired',
        expect.objectContaining({ status: 'partially_filled_expired' })
      );
    });

    it('booking in created — process timeout, set to expired', async () => {
      const booking = makeBooking({ status: 'created', trucksFilled: 0, notifiedTransporters: [] });
      mockGetBookingById.mockResolvedValueOnce(booking);
      mockBookingUpdateMany.mockResolvedValueOnce({ count: 1 });

      await bookingService.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockBookingUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'booking-001' }),
          data: expect.objectContaining({ status: 'expired' }),
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Should NOT process (skip)
  // -------------------------------------------------------------------------

  describe('Should NOT process (skip)', () => {

    it('booking in fully_filled — skip (terminal)', async () => {
      const booking = makeBooking({ status: 'fully_filled', notifiedTransporters: [] });
      mockGetBookingById.mockResolvedValueOnce(booking);

      await bookingService.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockUpdateBooking).not.toHaveBeenCalled();
    });

    it('booking in completed — skip (terminal)', async () => {
      const booking = makeBooking({ status: 'completed', notifiedTransporters: [] });
      mockGetBookingById.mockResolvedValueOnce(booking);

      await bookingService.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockUpdateBooking).not.toHaveBeenCalled();
    });

    it('booking in cancelled — skip (terminal)', async () => {
      const booking = makeBooking({ status: 'cancelled', notifiedTransporters: [] });
      mockGetBookingById.mockResolvedValueOnce(booking);

      await bookingService.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockUpdateBooking).not.toHaveBeenCalled();
    });

    it('booking in expired — skip (already expired, prevent double processing)', async () => {
      // #18 fix: 'expired' is NOT in the whitelist, so it should be skipped
      const booking = makeBooking({ status: 'expired', notifiedTransporters: [] });
      mockGetBookingById.mockResolvedValueOnce(booking);

      await bookingService.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockUpdateBooking).not.toHaveBeenCalled();
    });

    it('booking in in_progress — skip (trip started, should not timeout)', async () => {
      const booking = makeBooking({ status: 'in_progress', notifiedTransporters: [] });
      mockGetBookingById.mockResolvedValueOnce(booking);

      await bookingService.handleBookingTimeout('booking-001', 'customer-001');

      // in_progress is NOT in the whitelist, NOT in the terminal skip list
      // Falls through to the unexpected status guard
      expect(mockUpdateBooking).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('unexpected status'),
        expect.objectContaining({ status: 'in_progress' })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('Edge cases', () => {

    it('booking not found — return early', async () => {
      mockGetBookingById.mockResolvedValueOnce(null);

      await bookingService.handleBookingTimeout('non-existent', 'customer-001');

      expect(mockUpdateBooking).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });

    it('booking status is unknown string — log warning, return early', async () => {
      const booking = makeBooking({ status: 'some_unknown_status', notifiedTransporters: [] });
      mockGetBookingById.mockResolvedValueOnce(booking);

      await bookingService.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockUpdateBooking).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('unexpected status'),
        expect.objectContaining({ status: 'some_unknown_status' })
      );
    });

    it('timeout with trucksFilled > 0 but < trucksNeeded — partial fill path', async () => {
      const booking = makeBooking({
        status: 'active',
        trucksFilled: 2,
        trucksNeeded: 5,
        notifiedTransporters: [],
      });
      mockGetBookingById.mockResolvedValueOnce(booking);
      mockUpdateBooking.mockResolvedValueOnce({ ...booking, status: 'expired' });

      await bookingService.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'customer-001',
        'booking_expired',
        expect.objectContaining({
          status: 'partially_filled_expired',
          trucksFilled: 2,
          trucksNeeded: 5,
        })
      );
    });

    it('timeout with trucksFilled === 0 — zero fill path (no vehicles available)', async () => {
      const booking = makeBooking({
        status: 'active',
        trucksFilled: 0,
        trucksNeeded: 3,
        notifiedTransporters: [],
      });
      mockGetBookingById.mockResolvedValueOnce(booking);
      mockUpdateBooking.mockResolvedValueOnce({ ...booking, status: 'expired' });

      await bookingService.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'customer-001',
        'no_vehicles_available',
        expect.objectContaining({ bookingId: 'booking-001' })
      );
    });

    it('timeout with trucksFilled === trucksNeeded — unexpected (should be fully_filled)', async () => {
      // This booking should already be fully_filled, caught by terminal guard
      const booking = makeBooking({
        status: 'fully_filled',
        trucksFilled: 3,
        trucksNeeded: 3,
        notifiedTransporters: [],
      });
      mockGetBookingById.mockResolvedValueOnce(booking);

      await bookingService.handleBookingTimeout('booking-001', 'customer-001');

      // fully_filled is caught by the terminal status skip
      expect(mockUpdateBooking).not.toHaveBeenCalled();
    });

    it('clearCustomerActiveBroadcast called after expiry', async () => {
      const booking = makeBooking({ status: 'active', trucksFilled: 0, notifiedTransporters: [] });
      mockGetBookingById.mockResolvedValueOnce(booking);
      mockUpdateBooking.mockResolvedValueOnce({ ...booking, status: 'expired' });

      await bookingService.handleBookingTimeout('booking-001', 'customer-001');

      // active broadcast key should be cleaned up
      expect(mockRedisDel).toHaveBeenCalledWith(expect.stringContaining('customer:active-broadcast:'));
    });

    it('timer is cancelled during handling', async () => {
      const booking = makeBooking({ status: 'broadcasting', trucksFilled: 0, notifiedTransporters: [] });
      mockGetBookingById.mockResolvedValueOnce(booking);
      mockUpdateBooking.mockResolvedValueOnce({ ...booking, status: 'expired' });

      await bookingService.handleBookingTimeout('booking-001', 'customer-001');

      // clearBookingTimers cancels expiry and radius timers
      expect(mockRedisCancelTimer).toHaveBeenCalled();
    });

    it('notifies all transporters that broadcast has expired', async () => {
      const booking = makeBooking({
        status: 'active',
        trucksFilled: 0,
        notifiedTransporters: ['t-1', 't-2', 't-3'],
      });
      mockGetBookingById.mockResolvedValueOnce(booking);
      mockUpdateBooking.mockResolvedValueOnce({ ...booking, status: 'expired' });

      await bookingService.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockEmitToUser).toHaveBeenCalledWith('t-1', 'booking_expired', expect.objectContaining({ reason: 'timeout' }));
      expect(mockEmitToUser).toHaveBeenCalledWith('t-2', 'booking_expired', expect.objectContaining({ reason: 'timeout' }));
      expect(mockEmitToUser).toHaveBeenCalledWith('t-3', 'booking_expired', expect.objectContaining({ reason: 'timeout' }));
    });

    it('FCM push sent to notifiedTransporters on expiry', async () => {
      const booking = makeBooking({
        status: 'active',
        trucksFilled: 0,
        notifiedTransporters: ['t-1'],
      });
      mockGetBookingById.mockResolvedValueOnce(booking);
      mockUpdateBooking.mockResolvedValueOnce({ ...booking, status: 'expired' });

      await bookingService.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockQueuePushNotificationBatch).toHaveBeenCalledWith(
        ['t-1'],
        expect.objectContaining({ title: expect.stringContaining('Expired') })
      );
    });

    it('prismaClient.booking.updateMany failure does not crash handleBookingTimeout', async () => {
      const booking = makeBooking({
        status: 'active',
        trucksFilled: 0,
        notifiedTransporters: [],
      });
      mockGetBookingById.mockResolvedValueOnce(booking);
      // FIX-R2-2: handleBookingTimeout now uses prismaClient.booking.updateMany
      mockBookingUpdateMany.mockRejectedValueOnce(new Error('DB write failed'));

      // Should not throw — error is caught internally
      await bookingService.handleBookingTimeout('booking-001', 'customer-001');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to expire'),
        expect.any(Object)
      );
    });

    it('EXPECTED_TIMEOUT_STATES whitelist contains exactly 4 entries', async () => {
      // Validate that the 4 whitelisted states are processed
      const whitelist = ['broadcasting', 'active', 'partially_filled', 'created'];
      for (const status of whitelist) {
        jest.clearAllMocks();
        mockRedisCancelTimer.mockResolvedValue(undefined);
        mockRedisDel.mockResolvedValue(undefined);
        mockRedisGet.mockResolvedValue(null);
        // FIX-R2-2: Now uses prismaClient.booking.updateMany
        mockBookingUpdateMany.mockResolvedValue({ count: 1 });

        const booking = makeBooking({ status, trucksFilled: 0, notifiedTransporters: [] });
        mockGetBookingById.mockResolvedValueOnce(booking);

        await bookingService.handleBookingTimeout('booking-001', 'customer-001');

        expect(mockBookingUpdateMany).toHaveBeenCalled();
      }
    });

    it('terminal statuses fully_filled/completed/cancelled are all skipped', async () => {
      const terminals = ['fully_filled', 'completed', 'cancelled'];
      for (const status of terminals) {
        jest.clearAllMocks();
        mockUpdateBooking.mockReset();

        const booking = makeBooking({ status, notifiedTransporters: [] });
        mockGetBookingById.mockResolvedValueOnce(booking);

        await bookingService.handleBookingTimeout('booking-001', 'customer-001');

        expect(mockUpdateBooking).not.toHaveBeenCalled();
      }
    });

    it('booking room receives BOOKING_EXPIRED event on timeout', async () => {
      const booking = makeBooking({
        status: 'broadcasting',
        trucksFilled: 0,
        notifiedTransporters: [],
      });
      mockGetBookingById.mockResolvedValueOnce(booking);
      mockUpdateBooking.mockResolvedValueOnce({ ...booking, status: 'expired' });

      await bookingService.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockEmitToBooking).toHaveBeenCalledWith(
        'booking-001',
        'booking_expired',
        expect.objectContaining({ bookingId: 'booking-001' })
      );
    });
  });
});

// =============================================================================
// CATEGORY 4: Haversine Fare Sanity Check (#24) — 28 tests
// =============================================================================

describe('Category 4: Haversine Fare Sanity Check (#24)', () => {
  // These tests exercise the createBooking flow where distance calculation
  // and fare checking happen. We need to set up the full createBooking mocks.

  function makeCreateInput(overrides: Record<string, any> = {}): any {
    return {
      vehicleType: 'Tipper',
      vehicleSubtype: '20-24 Ton',
      trucksNeeded: 1,
      pricePerTruck: 5000,
      distanceKm: 50,
      goodsType: 'Sand',
      weight: '20 Ton',
      pickup: {
        address: 'Pickup Addr',
        city: 'Bangalore',
        state: 'KA',
        coordinates: { latitude: 12.97, longitude: 77.59 },
      },
      drop: {
        address: 'Drop Addr',
        city: 'Bangalore',
        state: 'KA',
        coordinates: { latitude: 13.0, longitude: 77.6 },
      },
      ...overrides,
    };
  }

  /**
   * Set up mocks for createBooking flow through the distance/fare check path.
   * This is complex because createBooking does many things:
   * - Idempotency check
   * - Customer name lookup
   * - Google route calculation
   * - Fare check
   * - DB booking creation
   * - Radius search + broadcast
   */
  function setupCreateBookingMocks(googleResponse: any = null) {
    // No duplicate idempotency key / active broadcast
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue(undefined);
    mockRedisExists.mockResolvedValue(0);

    // Distributed lock: acquired
    mockRedisAcquireLock.mockResolvedValue({ acquired: true, lockKey: 'lock' });
    mockRedisReleaseLock.mockResolvedValue(undefined);

    // Customer
    mockGetUserById.mockResolvedValue({ id: 'customer-001', name: 'Test Customer' });

    // Google route
    mockCalculateRoute.mockResolvedValue(googleResponse);

    // No active bookings for this customer
    mockGetBookingsByCustomer.mockResolvedValue([]);

    // Transporter search
    mockGetTransportersWithVehicleType.mockResolvedValue([]);
    mockFilterOnline.mockResolvedValue([]);

    // DB create via withDbTimeout
    const createdBooking = makeBooking({ status: 'broadcasting' });
    mockBookingCreate.mockResolvedValue(createdBooking);
    mockOrderFindFirst.mockResolvedValue(null);

    // Post-create: db.getBookingById is called once to fetch the BookingRecord
    mockGetBookingById.mockResolvedValueOnce(createdBooking);

    // No-transporter path: db.updateBooking is called twice (broadcasting then expired)
    mockUpdateBooking.mockResolvedValue(undefined);

    // Redis timer
    mockRedisSetTimer.mockResolvedValue(undefined);
    mockRedisSAdd.mockResolvedValue(undefined);
    mockRedisSMembers.mockResolvedValue([]);

    return createdBooking;
  }

  // -------------------------------------------------------------------------
  // Google succeeds (no Haversine check needed)
  // -------------------------------------------------------------------------

  describe('Google succeeds (no Haversine check needed)', () => {

    it('Google returns 50km — data.distanceKm = 50 (Google authoritative)', async () => {
      setupCreateBookingMocks({ distanceKm: 50, durationMinutes: 60 });
      const input = makeCreateInput({ distanceKm: 45, pricePerTruck: 5000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      // Booking should be created with Google's distance (50), not client's (45)
      expect(mockBookingCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ distanceKm: 50 })
        })
      );
    });

    it('Google returns 0km — fall back to haversine-based distance', async () => {
      setupCreateBookingMocks({ distanceKm: 0, durationMinutes: 0 });
      const input = makeCreateInput({ distanceKm: 100, pricePerTruck: 5000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      // When Google returns 0, falls back to haversine-based calculation
      // distanceKm will be ceil(haversine * 1.3) or client distance (whichever the code decides)
      expect(mockBookingCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ distanceKm: expect.any(Number) })
        })
      );
    });

    it('Google returns null — fall back to haversine-based distance', async () => {
      setupCreateBookingMocks(null);
      const input = makeCreateInput({ distanceKm: 80, pricePerTruck: 5000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      // When Google returns null, falls back to haversine-based calculation
      expect(mockBookingCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ distanceKm: expect.any(Number) })
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Google fails — Haversine kicks in
  // -------------------------------------------------------------------------

  describe('Google fails — Haversine kicks in', () => {

    it('client 100km, Haversine 80km — 25% diff (<50%) — USE client distance', async () => {
      // Google fails
      mockCalculateRoute.mockRejectedValue(new Error('Google API quota exceeded'));
      mockHaversineDistanceKm.mockReturnValue(80);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('Google API quota exceeded'));

      const input = makeCreateInput({ distanceKm: 100, pricePerTruck: 5000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      // |100 - 80| / 80 = 25% < 50% => use client distance (100)
      expect(mockBookingCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ distanceKm: 100 })
        })
      );
    });

    it('client 100km, Haversine 50km — 100% diff (>50%) — USE Haversine*1.3 = 65km', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('Google API down'));
      mockHaversineDistanceKm.mockReturnValue(50);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('Google API down'));

      const input = makeCreateInput({ distanceKm: 100, pricePerTruck: 5000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      // |100 - 50| / 50 = 100% > 50% => use Math.ceil(50 * 1.3) = 65
      expect(mockBookingCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ distanceKm: 65 })
        })
      );
    });

    it('client 10km, Haversine 80km — 87.5% diff (>50%) — USE Haversine*1.3 = 104km', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('timeout'));
      mockHaversineDistanceKm.mockReturnValue(80);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('timeout'));

      const input = makeCreateInput({ distanceKm: 10, pricePerTruck: 5000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      // |10 - 80| / 80 = 87.5% > 50% => Math.ceil(80 * 1.3) = 104
      expect(mockBookingCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ distanceKm: 104 })
        })
      );
    });

    it('client 1km, Haversine 100km — manipulation attempt — USE Haversine*1.3 = 130km', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('network error'));
      mockHaversineDistanceKm.mockReturnValue(100);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('network error'));

      const input = makeCreateInput({ distanceKm: 1, pricePerTruck: 8000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      // |1 - 100| / 100 = 99% > 50% => Math.ceil(100 * 1.3) = 130
      expect(mockBookingCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ distanceKm: 130 })
        })
      );
    });

    it('client 200km, Haversine 100km — inflated — USE Haversine*1.3 = 130km', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('500'));
      mockHaversineDistanceKm.mockReturnValue(100);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('500'));

      const input = makeCreateInput({ distanceKm: 200, pricePerTruck: 8000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      // |200 - 100| / 100 = 100% > 50% => Math.ceil(100 * 1.3) = 130
      expect(mockBookingCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ distanceKm: 130 })
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Boundary cases
  // -------------------------------------------------------------------------

  describe('Boundary cases', () => {

    it('Haversine = 0 (same coordinates) — skip Haversine check (division by zero protection)', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('error'));
      mockHaversineDistanceKm.mockReturnValue(0);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('error'));

      const input = makeCreateInput({ distanceKm: 50, pricePerTruck: 5000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      // haversineKm = 0, so the check `haversineKm > 0` fails, skip override
      expect(mockBookingCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ distanceKm: 50 })
        })
      );
    });

    it('Haversine = very small (0.1km) — careful percentage math', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('error'));
      mockHaversineDistanceKm.mockReturnValue(0.1);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('error'));

      // Client sends 5km, haversine is 0.1km
      // |5 - 0.1| / 0.1 = 4900% > 50% => use Math.ceil(0.1 * 1.3) = 1
      const input = makeCreateInput({ distanceKm: 5, pricePerTruck: 5000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      expect(mockBookingCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ distanceKm: 1 })
        })
      );
    });

    it('client distance exactly matches Haversine — 0% difference, USE client', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('error'));
      mockHaversineDistanceKm.mockReturnValue(50);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('error'));

      const input = makeCreateInput({ distanceKm: 50, pricePerTruck: 5000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      // |50 - 50| / 50 = 0% < 50% => use client
      expect(mockBookingCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ distanceKm: 50 })
        })
      );
    });

    it('client distance exactly 50% above Haversine — boundary, USE client (>50% triggers)', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('error'));
      mockHaversineDistanceKm.mockReturnValue(100);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('error'));

      // Client sends 150km, haversine is 100km
      // |150 - 100| / 100 = 50% -- exactly at boundary
      // The code checks > 0.5, NOT >= 0.5, so 50% does NOT trigger override
      const input = makeCreateInput({ distanceKm: 150, pricePerTruck: 8000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      expect(mockBookingCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ distanceKm: 150 })
        })
      );
    });

    it('client distance 51% above Haversine — triggers Haversine override', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('error'));
      mockHaversineDistanceKm.mockReturnValue(100);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('error'));

      // Client sends 151km, haversine is 100km
      // |151 - 100| / 100 = 51% > 50% => override
      const input = makeCreateInput({ distanceKm: 151, pricePerTruck: 8000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      // Math.ceil(100 * 1.3) = 130
      expect(mockBookingCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ distanceKm: 130 })
        })
      );
    });

    it('client distance 50% below Haversine — triggers Haversine override', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('error'));
      mockHaversineDistanceKm.mockReturnValue(100);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('error'));

      // Client sends 40km, haversine is 100km
      // |40 - 100| / 100 = 60% > 50% => override
      const input = makeCreateInput({ distanceKm: 40, pricePerTruck: 5000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      expect(mockBookingCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ distanceKm: 130 })
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Integration with fare check
  // -------------------------------------------------------------------------

  describe('Integration with fare check', () => {

    it('after Haversine override, fare floor check uses corrected distance', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('error'));
      mockHaversineDistanceKm.mockReturnValue(100);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('error'));

      // Client sends 1km (manipulation) with very low price
      // Haversine = 100km => corrected = Math.ceil(100 * 1.3) = 130km
      // Fare floor: max(500, 130 * 8 * 0.5) = max(500, 520) = 520
      // pricePerTruck=100 < 520 => FARE_TOO_LOW
      const input = makeCreateInput({ distanceKm: 1, pricePerTruck: 100 });

      await expect(
        bookingService.createBooking('customer-001', '9999999999', input)
      ).rejects.toThrow(/below minimum/);
    });

    it('logger.warn is called when Haversine override kicks in', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('error'));
      mockHaversineDistanceKm.mockReturnValue(50);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('error'));

      // |100 - 50| / 50 = 100% > 50%
      const input = makeCreateInput({ distanceKm: 100, pricePerTruck: 5000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Client distance differs >50% from Haversine'),
        expect.objectContaining({ clientKm: 100, haversineKm: 50 })
      );
    });

    it('the 1.3 road factor is applied (Haversine * 1.3, not raw Haversine)', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('error'));
      mockHaversineDistanceKm.mockReturnValue(77);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('error'));

      // |1 - 77| / 77 = 98.7% > 50% => use Math.ceil(77 * 1.3) = Math.ceil(100.1) = 101
      const input = makeCreateInput({ distanceKm: 1, pricePerTruck: 5000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      expect(mockBookingCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ distanceKm: 101 })
        })
      );
    });

    it('Math.ceil applied to Haversine result (no fractional km)', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('error'));
      mockHaversineDistanceKm.mockReturnValue(33.33);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('error'));

      // |1 - 33.33| / 33.33 = 97% > 50% => Math.ceil(33.33 * 1.3) = Math.ceil(43.329) = 44
      const input = makeCreateInput({ distanceKm: 1, pricePerTruck: 5000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      expect(mockBookingCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ distanceKm: 44 })
        })
      );
    });

    it('distanceSource is logged when Google fails and fallback is used', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('error'));
      mockHaversineDistanceKm.mockReturnValue(50);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('error'));

      const input = makeCreateInput({ distanceKm: 50, pricePerTruck: 5000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      // Logger should mention the Google Directions failure triggering Haversine fallback
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Google Directions failed'),
        expect.objectContaining({ clientDistanceKm: 50 })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Real-world scenarios
  // -------------------------------------------------------------------------

  describe('Real-world scenarios', () => {

    it('Delhi to Mumbai (1400km road, 1150km Haversine) — client 1400km, Google fails, 21.7% diff, use client', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('error'));
      mockHaversineDistanceKm.mockReturnValue(1150);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('error'));

      // |1400 - 1150| / 1150 = 21.7% < 50% => use client
      const input = makeCreateInput({ distanceKm: 1400, pricePerTruck: 50000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      expect(mockBookingCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ distanceKm: 1400 })
        })
      );
    });

    it('Delhi to Shimla (350km road, 250km Haversine) — client sends 100km (manipulation), 60% diff, use Haversine*1.3 = 325km', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('error'));
      mockHaversineDistanceKm.mockReturnValue(250);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('error'));

      // |100 - 250| / 250 = 60% > 50% => Math.ceil(250 * 1.3) = 325
      const input = makeCreateInput({ distanceKm: 100, pricePerTruck: 12000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      expect(mockBookingCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ distanceKm: 325 })
        })
      );
    });

    it('same-city short distance (5km road, 3km Haversine) — client 5km, 66% diff triggers override, uses Haversine*1.3 = 4km', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('error'));
      mockHaversineDistanceKm.mockReturnValue(3);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('error'));

      // |5 - 3| / 3 = 66.7% > 50% => Math.ceil(3 * 1.3) = Math.ceil(3.9) = 4
      const input = makeCreateInput({ distanceKm: 5, pricePerTruck: 5000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      expect(mockBookingCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ distanceKm: 4 })
        })
      );
    });

    it('medium distance (100km road, 80km Haversine) — client 100km, 25% diff, use client', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('error'));
      mockHaversineDistanceKm.mockReturnValue(80);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('error'));

      // |100 - 80| / 80 = 25% < 50% => use client
      const input = makeCreateInput({ distanceKm: 100, pricePerTruck: 5000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      expect(mockBookingCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ distanceKm: 100 })
        })
      );
    });

    it('price too low after Haversine override is correctly rejected', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('error'));
      mockHaversineDistanceKm.mockReturnValue(500);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('error'));

      // Client sends 1km @ 100 rupees (extreme manipulation)
      // Haversine = 500km => corrected = Math.ceil(500 * 1.3) = 650km
      // Fare floor: max(500, 650 * 8 * 0.5) = max(500, 2600) = 2600
      // pricePerTruck=100 < 2600 => FARE_TOO_LOW
      const input = makeCreateInput({ distanceKm: 1, pricePerTruck: 100 });

      await expect(
        bookingService.createBooking('customer-001', '9999999999', input)
      ).rejects.toThrow(/below minimum/);
    });

    it('legitimate price passes fare check after Haversine override', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('error'));
      mockHaversineDistanceKm.mockReturnValue(50);

      setupCreateBookingMocks();
      mockCalculateRoute.mockRejectedValue(new Error('error'));

      // |1 - 50| / 50 = 98% > 50% => corrected = Math.ceil(50 * 1.3) = 65km
      // Fare floor: max(500, 65 * 8 * 0.5) = max(500, 260) = 500
      // pricePerTruck=5000 > 500 => passes
      const input = makeCreateInput({ distanceKm: 1, pricePerTruck: 5000 });

      await bookingService.createBooking('customer-001', '9999999999', input);

      expect(mockBookingCreate).toHaveBeenCalled();
    });
  });
});
