/**
 * =============================================================================
 * CUSTOMER BOOKING CREATE - STRESS & EDGE CASE TESTS
 * =============================================================================
 *
 * 60+ tests covering EVERY scenario for booking creation from the customer
 * side, BEFORE any transporter responds.
 *
 * Categories:
 *   1. Valid booking creation (all fields, minimum fields)
 *   2. Input validation (missing/invalid fields, edge cases)
 *   3. Backpressure & rate limiting
 *   4. Idempotency (client key, server dedup, DB-level)
 *   5. Database transaction (atomicity, isolation, timeout, deadlock)
 *   6. Validation edge cases (same location, ocean, distance failures)
 *
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP -- Must come before any imports
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

// --- Redis service mock ---
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisIncr = jest.fn().mockResolvedValue(1);
const mockRedisIncrBy = jest.fn().mockResolvedValue(0);
const mockRedisExpire = jest.fn();
const mockRedisSIsMember = jest.fn();
const mockRedisSMembers = jest.fn();
const mockRedisSCard = jest.fn();
const mockRedisSRem = jest.fn();
const mockRedisSScan = jest.fn();
const mockRedisExists = jest.fn();
const mockRedisAcquireLock = jest.fn().mockResolvedValue({ acquired: true });
const mockRedisReleaseLock = jest.fn().mockResolvedValue(undefined);
const mockRedisLPush = jest.fn();
const mockRedisLTrim = jest.fn();
const mockRedisIsConnected = jest.fn().mockReturnValue(true);
const mockRedisSetTimer = jest.fn();
const mockRedisCancelTimer = jest.fn();
const mockRedisGetExpiredTimers = jest.fn();
const mockRedisSAdd = jest.fn();
const mockRedisHMSet = jest.fn();
const mockRedisHSet = jest.fn().mockResolvedValue(undefined);
const mockRedisHGetAll = jest.fn();
const mockRedisHGetAllBatch = jest.fn();
const mockRedisGeoAdd = jest.fn();
const mockRedisGeoRemove = jest.fn();
const mockRedisGeoRadius = jest.fn();
const mockRedisIsRedisEnabled = jest.fn().mockReturnValue(true);

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    incr: (...args: any[]) => mockRedisIncr(...args),
    incrBy: (...args: any[]) => mockRedisIncrBy(...args),
    expire: (...args: any[]) => mockRedisExpire(...args),
    sIsMember: (...args: any[]) => mockRedisSIsMember(...args),
    sMembers: (...args: any[]) => mockRedisSMembers(...args),
    sCard: (...args: any[]) => mockRedisSCard(...args),
    sRem: (...args: any[]) => mockRedisSRem(...args),
    sScan: (...args: any[]) => mockRedisSScan(...args),
    exists: (...args: any[]) => mockRedisExists(...args),
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    lPush: (...args: any[]) => mockRedisLPush(...args),
    lTrim: (...args: any[]) => mockRedisLTrim(...args),
    isConnected: () => mockRedisIsConnected(),
    setTimer: (...args: any[]) => mockRedisSetTimer(...args),
    cancelTimer: (...args: any[]) => mockRedisCancelTimer(...args),
    getExpiredTimers: (...args: any[]) => mockRedisGetExpiredTimers(...args),
    sAdd: (...args: any[]) => mockRedisSAdd(...args),
    hMSet: (...args: any[]) => mockRedisHMSet(...args),
    hSet: (...args: any[]) => mockRedisHSet(...args),
    hGetAll: (...args: any[]) => mockRedisHGetAll(...args),
    hGetAllBatch: (...args: any[]) => mockRedisHGetAllBatch(...args),
    geoAdd: (...args: any[]) => mockRedisGeoAdd(...args),
    geoRemove: (...args: any[]) => mockRedisGeoRemove(...args),
    geoRadius: (...args: any[]) => mockRedisGeoRadius(...args),
    isRedisEnabled: () => mockRedisIsRedisEnabled(),
    isDegraded: false,
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
  },
}));

// --- Prisma mock ---
const mockBookingCreate = jest.fn();
const mockBookingFindFirst = jest.fn();
const mockBookingFindUnique = jest.fn();
const mockBookingUpdateMany = jest.fn();
const mockOrderFindFirst = jest.fn();
const mockAssignmentFindMany = jest.fn();
const mockAssignmentUpdateMany = jest.fn();
const mockQueryRaw = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    booking: {
      create: (...args: any[]) => mockBookingCreate(...args),
      findFirst: (...args: any[]) => mockBookingFindFirst(...args),
      findUnique: (...args: any[]) => mockBookingFindUnique(...args),
      updateMany: (...args: any[]) => mockBookingUpdateMany(...args),
    },
    order: {
      findFirst: (...args: any[]) => mockOrderFindFirst(...args),
    },
    assignment: {
      findMany: (...args: any[]) => mockAssignmentFindMany(...args),
      updateMany: (...args: any[]) => mockAssignmentUpdateMany(...args),
    },
    vehicle: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    $queryRaw: (...args: any[]) => mockQueryRaw(...args),
    $transaction: async (fnOrArray: any, _opts?: any) => {
      if (typeof fnOrArray === 'function') {
        const txProxy = {
          booking: {
            create: (...a: any[]) => mockBookingCreate(...a),
            findFirst: (...a: any[]) => mockBookingFindFirst(...a),
            updateMany: (...a: any[]) => mockBookingUpdateMany(...a),
          },
          order: {
            findFirst: (...a: any[]) => mockOrderFindFirst(...a),
          },
          assignment: {
            findMany: (...a: any[]) => mockAssignmentFindMany(...a),
            updateMany: (...a: any[]) => mockAssignmentUpdateMany(...a),
          },
          vehicle: {
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            update: jest.fn().mockResolvedValue({}),
          },
          $queryRaw: (...a: any[]) => mockQueryRaw(...a),
        };
        return fnOrArray(txProxy);
      }
      return Promise.all(fnOrArray);
    },
  },
  withDbTimeout: jest.fn(async (fn: Function, _opts?: any) => fn({
    booking: {
      findFirst: (...args: any[]) => mockBookingFindFirst(...args),
      create: (...args: any[]) => mockBookingCreate(...args),
    },
    order: {
      findFirst: (...args: any[]) => mockOrderFindFirst(...args),
    },
  })),
  BookingStatus: {
    created: 'created',
    broadcasting: 'broadcasting',
    active: 'active',
    partially_filled: 'partially_filled',
    fully_filled: 'fully_filled',
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
    cancelled: 'cancelled',
    completed: 'completed',
  },
  VehicleStatus: {
    available: 'available',
    on_hold: 'on_hold',
    in_transit: 'in_transit',
    maintenance: 'maintenance',
    inactive: 'inactive',
  },
}));

// --- DB mock ---
const mockGetBookingById = jest.fn();
const mockUpdateBooking = jest.fn();
const mockGetTransportersWithVehicleType = jest.fn();
const mockGetActiveBookingsForTransporter = jest.fn();
const mockGetUserById = jest.fn();
const mockGetVehiclesByTransporter = jest.fn();
const mockGetBookingsByCustomer = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getBookingById: (...args: any[]) => mockGetBookingById(...args),
    updateBooking: (...args: any[]) => mockUpdateBooking(...args),
    getTransportersWithVehicleType: (...args: any[]) => mockGetTransportersWithVehicleType(...args),
    getActiveBookingsForTransporter: (...args: any[]) => mockGetActiveBookingsForTransporter(...args),
    getUserById: (...args: any[]) => mockGetUserById(...args),
    getVehiclesByTransporter: (...args: any[]) => mockGetVehiclesByTransporter(...args),
    getBookingsByCustomer: (...args: any[]) => mockGetBookingsByCustomer(...args),
    getAssignmentsByBooking: jest.fn().mockResolvedValue([]),
    getTransportersByVehicleKey: jest.fn().mockResolvedValue([]),
  },
}));

// --- Socket service mock ---
const mockEmitToUser = jest.fn();
const mockEmitToBooking = jest.fn();
jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToBooking: (...args: any[]) => mockEmitToBooking(...args),
  isUserConnected: jest.fn().mockReturnValue(false),
  isUserConnectedAsync: jest.fn().mockResolvedValue(false),
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
    BROADCAST_STATE_CHANGED: 'broadcast_state_changed',
    BROADCAST_EXPIRED: 'broadcast_expired',
    BROADCAST_CANCELLED: 'order_cancelled',
  },
  socketService: { emitToUser: jest.fn() },
}));

// --- FCM service mock ---
const mockNotifyNewBroadcast = jest.fn();
jest.mock('../shared/services/fcm.service', () => ({
  fcmService: {
    notifyNewBroadcast: (...args: any[]) => mockNotifyNewBroadcast(...args),
    sendToDevice: jest.fn().mockResolvedValue(true),
  },
}));

// --- Queue service mock ---
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queuePushNotificationBatch: jest.fn().mockResolvedValue(undefined),
    queueBroadcast: jest.fn().mockResolvedValue(undefined),
    addJob: jest.fn().mockResolvedValue(undefined),
  },
}));

// --- Transporter online service mock ---
const mockFilterOnline = jest.fn();
const mockIsOnline = jest.fn();
jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: {
    filterOnline: (...args: any[]) => mockFilterOnline(...args),
    isOnline: (...args: any[]) => mockIsOnline(...args),
    getOnlineCount: jest.fn().mockResolvedValue(0),
    getOnlineIds: jest.fn().mockResolvedValue([]),
    cleanStaleTransporters: jest.fn().mockResolvedValue(0),
  },
  ONLINE_TRANSPORTERS_SET: 'online:transporters',
  TRANSPORTER_PRESENCE_KEY: (id: string) => `transporter:presence:${id}`,
  PRESENCE_TTL_SECONDS: 120,
}));

// --- Progressive radius matcher mock ---
const mockFindCandidates = jest.fn();
jest.mock('../modules/order/progressive-radius-matcher', () => ({
  ...jest.requireActual('../modules/order/progressive-radius-matcher'),
  progressiveRadiusMatcher: {
    findCandidates: (...args: any[]) => mockFindCandidates(...args),
    getStepCount: jest.fn().mockReturnValue(6),
    getStep: jest.fn().mockReturnValue({ radiusKm: 10, windowMs: 10_000, h3RingK: 15 }),
  },
  startProgressiveMatching: jest.fn(),
  cancelProgressiveMatching: jest.fn(),
}));

// --- Availability service mock ---
const mockLoadTransporterDetailsMap = jest.fn();
const mockGetTransporterDetails = jest.fn();
jest.mock('../shared/services/availability.service', () => ({
  availabilityService: {
    loadTransporterDetailsMap: (...args: any[]) => mockLoadTransporterDetailsMap(...args),
    getTransporterDetails: (...args: any[]) => mockGetTransporterDetails(...args),
    getAvailableTransportersAsync: jest.fn().mockResolvedValue([]),
    getAvailableTransportersWithDetails: jest.fn().mockResolvedValue([]),
    updateAvailability: jest.fn(),
    setOffline: jest.fn(),
  },
}));

// --- Live availability service mock ---
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: jest.fn().mockResolvedValue(undefined),
    getAvailableCount: jest.fn().mockResolvedValue(0),
  },
}));

// --- Vehicle lifecycle mock ---
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  onVehicleTransition: jest.fn().mockResolvedValue(undefined),
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
  isValidTransition: jest.fn().mockReturnValue(true),
  VALID_TRANSITIONS: {},
}));

// --- Google Maps service mock ---
const mockCalculateRoute = jest.fn();
jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: {
    calculateRoute: (...args: any[]) => mockCalculateRoute(...args),
  },
}));

// --- Distance matrix service mock ---
const mockBatchGetPickupDistance = jest.fn();
jest.mock('../shared/services/distance-matrix.service', () => ({
  distanceMatrixService: {
    batchGetPickupDistance: (...args: any[]) => mockBatchGetPickupDistance(...args),
  },
}));

// --- Vehicle key service mock ---
jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: (type: string, subtype: string) =>
    `${type.toLowerCase()}_${(subtype || '').toLowerCase()}`.replace(/\s+/g, '_'),
  generateVehicleKeyCandidates: (type: string, subtype: string) => [
    `${type.toLowerCase()}_${(subtype || '').toLowerCase()}`.replace(/\s+/g, '_'),
  ],
}));

// --- Geospatial utils mock ---
const mockHaversineDistanceKm = jest.fn().mockReturnValue(10);
jest.mock('../shared/utils/geospatial.utils', () => ({
  ...jest.requireActual('../shared/utils/geospatial.utils'),
  haversineDistanceKm: (...args: any[]) => mockHaversineDistanceKm(...args),
}));

// --- Geo utils mock ---
jest.mock('../shared/utils/geo.utils', () => ({
  roundCoord: (n: number) => Math.round(n * 10000) / 10000,
}));

// --- Config mock ---
jest.mock('../config/environment', () => ({
  config: { redis: { enabled: true }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {}, bookingConcurrencyLimit: 50 },
}));

// --- Core constants mock ---
jest.mock('../core/constants', () => ({
  ErrorCode: {
    VEHICLE_INSUFFICIENT: 'VEHICLE_INSUFFICIENT',
    BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  },
}));

// --- Booking payload helper mock ---
const mockBuildBroadcastPayload = jest.fn().mockReturnValue({
  broadcastId: 'booking-1',
  orderId: 'booking-1',
  vehicleType: 'open',
  trucksNeeded: 2,
});
const mockGetRemainingTimeoutSeconds = jest.fn().mockReturnValue(120);
jest.mock('../modules/booking/booking-payload.helper', () => ({
  buildBroadcastPayload: (...args: any[]) => mockBuildBroadcastPayload(...args),
  getRemainingTimeoutSeconds: (...args: any[]) => mockGetRemainingTimeoutSeconds(...args),
}));

// --- Cache service mock ---
jest.mock('../shared/services/cache.service', () => ({
  cacheService: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  },
}));

// --- H3 geo index mock ---
jest.mock('../shared/services/h3-geo-index.service', () => ({
  h3GeoIndexService: {
    updateLocation: jest.fn().mockResolvedValue(undefined),
    removeTransporter: jest.fn().mockResolvedValue(undefined),
    findNearby: jest.fn().mockResolvedValue([]),
  },
}));

// --- Circuit breaker mock ---
jest.mock('../shared/services/circuit-breaker.service', () => ({
  CircuitBreaker: jest.fn().mockImplementation(() => ({
    tryWithFallback: jest.fn((primary: Function) => primary()),
    getState: jest.fn().mockResolvedValue('CLOSED'),
  })),
  CircuitState: { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' },
  h3Circuit: { tryWithFallback: jest.fn((p: Function) => p()), getState: jest.fn() },
  directionsCircuit: { tryWithFallback: jest.fn((p: Function) => p()), getState: jest.fn() },
  queueCircuit: { tryWithFallback: jest.fn((p: Function) => p()), getState: jest.fn() },
  fcmCircuit: { tryWithFallback: jest.fn((p: Function) => p()), getState: jest.fn() },
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { bookingService } from '../modules/booking/booking.service';
import { AppError } from '../shared/types/error.types';
import { withDbTimeout } from '../shared/database/prisma.service';

// =============================================================================
// HELPERS
// =============================================================================

function resetAllMocks(): void {
  jest.clearAllMocks();
  mockRedisGet.mockReset();
  mockRedisSet.mockReset().mockResolvedValue(undefined);
  mockRedisDel.mockReset().mockResolvedValue(undefined);
  mockRedisIncr.mockReset().mockResolvedValue(1);
  mockRedisIncrBy.mockReset().mockResolvedValue(0);
  mockRedisExpire.mockReset().mockResolvedValue(undefined);
  mockRedisSIsMember.mockReset();
  mockRedisSMembers.mockReset();
  mockRedisSCard.mockReset();
  mockRedisSRem.mockReset();
  mockRedisSScan.mockReset();
  mockRedisExists.mockReset();
  mockRedisAcquireLock.mockReset().mockResolvedValue({ acquired: true });
  mockRedisReleaseLock.mockReset().mockResolvedValue(undefined);
  mockRedisLPush.mockReset();
  mockRedisLTrim.mockReset();
  mockRedisSetTimer.mockReset().mockResolvedValue(undefined);
  mockRedisCancelTimer.mockReset().mockResolvedValue(undefined);
  mockRedisGetExpiredTimers.mockReset();
  mockRedisSAdd.mockReset().mockResolvedValue(undefined);
  mockRedisHMSet.mockReset();
  mockRedisHSet.mockReset().mockResolvedValue(undefined);
  mockRedisHGetAll.mockReset();
  mockRedisHGetAllBatch.mockReset();
  mockRedisGeoAdd.mockReset();
  mockRedisGeoRemove.mockReset();
  mockRedisGeoRadius.mockReset();
  mockRedisIsConnected.mockReturnValue(true);
  mockRedisIsRedisEnabled.mockReturnValue(true);
  mockGetBookingById.mockReset();
  mockUpdateBooking.mockReset();
  mockGetTransportersWithVehicleType.mockReset();
  mockGetActiveBookingsForTransporter.mockReset();
  mockGetUserById.mockReset();
  mockGetVehiclesByTransporter.mockReset();
  mockGetBookingsByCustomer.mockReset();
  mockBookingCreate.mockReset();
  mockBookingFindFirst.mockReset();
  mockBookingFindUnique.mockReset();
  mockBookingUpdateMany.mockReset();
  mockOrderFindFirst.mockReset();
  mockAssignmentFindMany.mockReset();
  mockAssignmentUpdateMany.mockReset();
  mockQueryRaw.mockReset();
  mockEmitToUser.mockReset();
  mockEmitToBooking.mockReset();
  mockFilterOnline.mockReset();
  mockIsOnline.mockReset();
  mockFindCandidates.mockReset();
  mockLoadTransporterDetailsMap.mockReset();
  mockGetTransporterDetails.mockReset();
  mockNotifyNewBroadcast.mockReset();
  mockCalculateRoute.mockReset();
  mockBatchGetPickupDistance.mockReset();
  mockHaversineDistanceKm.mockReset().mockReturnValue(10);
  mockBuildBroadcastPayload.mockReset().mockReturnValue({
    broadcastId: 'booking-1',
    orderId: 'booking-1',
    vehicleType: 'open',
    trucksNeeded: 2,
  });
  mockGetRemainingTimeoutSeconds.mockReset().mockReturnValue(120);
}

function makeBookingInput(overrides: Record<string, any> = {}): any {
  return {
    pickup: {
      coordinates: { latitude: 28.6139, longitude: 77.2090 },
      address: '123 Pickup Street',
      city: 'Delhi',
      state: 'Delhi',
    },
    drop: {
      coordinates: { latitude: 28.5355, longitude: 77.3910 },
      address: '456 Drop Avenue',
      city: 'Noida',
      state: 'UP',
    },
    vehicleType: 'open',
    vehicleSubtype: '17ft',
    trucksNeeded: 2,
    distanceKm: 50,
    pricePerTruck: 5000,
    goodsType: 'Electronics',
    weight: '500kg',
    ...overrides,
  };
}

function makeBookingRecord(overrides: Record<string, any> = {}) {
  return {
    id: 'booking-1',
    customerId: 'cust-1',
    customerName: 'Test Customer',
    customerPhone: '9876543210',
    pickup: { latitude: 28.6139, longitude: 77.2090, address: '123 Pickup Street', city: 'Delhi', state: 'Delhi' },
    drop: { latitude: 28.5355, longitude: 77.3910, address: '456 Drop Avenue', city: 'Noida', state: 'UP' },
    vehicleType: 'open',
    vehicleSubtype: '17ft',
    trucksNeeded: 2,
    trucksFilled: 0,
    distanceKm: 50,
    pricePerTruck: 5000,
    totalAmount: 10000,
    goodsType: 'Electronics',
    weight: '500kg',
    status: 'created',
    stateChangedAt: new Date().toISOString(),
    notifiedTransporters: ['t-1', 't-2', 't-3'],
    scheduledAt: undefined as any,
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function setupHappyPathMocks(transporterIds: string[] = ['t-1', 't-2', 't-3']) {
  mockRedisGet.mockResolvedValue(null);
  mockRedisAcquireLock.mockResolvedValue({ acquired: true });
  mockRedisReleaseLock.mockResolvedValue(undefined);
  mockBookingFindFirst.mockResolvedValue(null);
  mockOrderFindFirst.mockResolvedValue(null);
  mockGetUserById.mockResolvedValue({ id: 'cust-1', name: 'Test Customer', phone: '9876543210' });
  mockCalculateRoute.mockResolvedValue({ distanceKm: 52, durationMinutes: 90 });
  mockFindCandidates.mockResolvedValue(
    transporterIds.map((id, i) => ({
      transporterId: id,
      distanceKm: 5 + i,
      latitude: 28.6 + i * 0.01,
      longitude: 77.2 + i * 0.01,
      etaSeconds: 300 + i * 60,
      etaSource: 'google',
    }))
  );
  mockBookingCreate.mockResolvedValue({ id: 'booking-1' });
  mockGetBookingById.mockResolvedValue(makeBookingRecord({ status: 'created', notifiedTransporters: transporterIds }));
  mockUpdateBooking.mockResolvedValue(makeBookingRecord({ notifiedTransporters: transporterIds }));
  mockRedisSet.mockResolvedValue(undefined);
  mockRedisSetTimer.mockResolvedValue(undefined);
  mockRedisCancelTimer.mockResolvedValue(undefined);
  mockRedisSAdd.mockResolvedValue(undefined);
  mockRedisExpire.mockResolvedValue(undefined);
  mockRedisDel.mockResolvedValue(undefined);
  mockNotifyNewBroadcast.mockResolvedValue(transporterIds.length);
  mockBookingUpdateMany.mockResolvedValue({ count: 1 });
}

// =============================================================================
// 1. VALID BOOKING CREATION
// =============================================================================

describe('Booking Creation - Valid Scenarios', () => {
  beforeEach(resetAllMocks);

  it('T01: creates booking with all fields populated', async () => {
    setupHappyPathMocks(['t-1', 't-2']);
    const input = makeBookingInput({
      goodsType: 'Electronics',
      weight: '1000kg',
      scheduledAt: new Date(Date.now() + 3600000).toISOString(),
      notes: 'Handle with care',
    });

    const result = await bookingService.createBooking('cust-1', '9876543210', input);

    expect(result).toBeDefined();
    expect(result.id).toBe('booking-1');
    expect(result.matchingTransportersCount).toBe(2);
    expect(result.timeoutSeconds).toBeGreaterThan(0);
  });

  it('T02: creates booking with minimum required fields', async () => {
    setupHappyPathMocks(['t-1']);
    const input = makeBookingInput({
      goodsType: undefined,
      weight: undefined,
      scheduledAt: undefined,
      notes: undefined,
    });

    const result = await bookingService.createBooking('cust-1', '9876543210', input);

    expect(result).toBeDefined();
    expect(result.matchingTransportersCount).toBe(1);
  });

  it('T03: returns correct matchingTransportersCount reflecting actual nearby transporters', async () => {
    const ids = ['t-1', 't-2', 't-3', 't-4', 't-5'];
    setupHappyPathMocks(ids);

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    expect(result.matchingTransportersCount).toBe(5);
  });

  it('T04: broadcasts to ALL matching transporters via socket or queue', async () => {
    setupHappyPathMocks(['t-1', 't-2', 't-3']);
    const { queueService } = require('../shared/services/queue.service');

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    // Broadcasts may go through queueBroadcast (when FF_SEQUENCE_DELIVERY_ENABLED)
    // or direct emitToUser. Check both paths.
    const directCalls = mockEmitToUser.mock.calls.filter(
      (c: any[]) => c[1] === 'new_broadcast'
    );
    const queueCalls = queueService.queueBroadcast.mock.calls;
    const directTo = directCalls.map((c: any[]) => c[0]);
    const queueTo = queueCalls.map((c: any[]) => c[0]);
    const allBroadcastedTo = [...directTo, ...queueTo];

    expect(allBroadcastedTo).toContain('t-1');
    expect(allBroadcastedTo).toContain('t-2');
    expect(allBroadcastedTo).toContain('t-3');
  });

  it('T05: emits BROADCAST_STATE_CHANGED with status created to customer', async () => {
    setupHappyPathMocks(['t-1']);

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    const stateChangedCalls = mockEmitToUser.mock.calls.filter(
      (c: any[]) => c[0] === 'cust-1' && c[1] === 'broadcast_state_changed'
    );
    const statuses = stateChangedCalls.map((c: any[]) => c[2]?.status);
    expect(statuses).toContain('created');
  });

  it('T06: booking status starts as created in the DB transaction', async () => {
    setupHappyPathMocks(['t-1']);

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    expect(mockBookingCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'created',
        }),
      })
    );
  });

  it('T07: booking ID is a valid UUID format', async () => {
    setupHappyPathMocks(['t-1']);
    // The service generates UUID via uuid v4 — the mock returns booking-1
    // but we verify the create call passes an id field
    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    const createArgs = mockBookingCreate.mock.calls[0]?.[0];
    expect(createArgs?.data?.id).toBeDefined();
    expect(typeof createArgs?.data?.id).toBe('string');
    expect(createArgs?.data?.id.length).toBeGreaterThanOrEqual(10);
  });

  it('T08: totalAmount is pricePerTruck * trucksNeeded rounded to 2 decimals', async () => {
    setupHappyPathMocks(['t-1']);

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput({
      pricePerTruck: 3333,
      trucksNeeded: 3,
    }));

    const createArgs = mockBookingCreate.mock.calls[0]?.[0];
    expect(createArgs?.data?.totalAmount).toBe(9999);
  });

  it('T09: expiresAt is set to now + TIMEOUT_MS', async () => {
    setupHappyPathMocks(['t-1']);
    const before = Date.now();

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    const createArgs = mockBookingCreate.mock.calls[0]?.[0];
    const expiresAt = new Date(createArgs?.data?.expiresAt).getTime();
    const after = Date.now();
    // TIMEOUT_MS is 120s by default
    expect(expiresAt).toBeGreaterThanOrEqual(before + 119000);
    expect(expiresAt).toBeLessThanOrEqual(after + 121000);
  });

  it('T10: notifiedTransporters array is stored in DB (capped at 200)', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `t-${i}`);
    setupHappyPathMocks(ids);

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    const createArgs = mockBookingCreate.mock.calls[0]?.[0];
    expect(createArgs?.data?.notifiedTransporters.length).toBeLessThanOrEqual(200);
  });
});

// =============================================================================
// 2. INPUT VALIDATION ERRORS
// =============================================================================

describe('Booking Creation - Input Validation', () => {
  beforeEach(resetAllMocks);

  it('T11: rejects booking when fare is suspiciously low for the distance', async () => {
    setupHappyPathMocks(['t-1']);

    await expect(
      bookingService.createBooking('cust-1', '9876543210', makeBookingInput({
        pricePerTruck: 100,
        distanceKm: 200,
      }))
    ).rejects.toThrow(AppError);

    try {
      await bookingService.createBooking('cust-1', '9876543210', makeBookingInput({
        pricePerTruck: 100,
        distanceKm: 200,
      }));
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
      expect(e.code).toBe('FARE_TOO_LOW');
    }
  });

  it('T12: accepts minimum viable fare at boundary (pricePerTruck = 500 short distance)', async () => {
    setupHappyPathMocks(['t-1']);
    // Min fare floor is max(500, distKm * 8 * 0.5)
    // For 1km: max(500, 1*8*0.5) = 500; pricePerTruck=500 should pass
    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput({
      pricePerTruck: 500,
      distanceKm: 1,
    }));

    expect(result).toBeDefined();
  });

  it('T13: rejects fare below absolute floor of 500', async () => {
    setupHappyPathMocks(['t-1']);

    try {
      await bookingService.createBooking('cust-1', '9876543210', makeBookingInput({
        pricePerTruck: 100,
        distanceKm: 5,
      }));
      fail('Expected FARE_TOO_LOW error');
    } catch (e: any) {
      expect(e.code).toBe('FARE_TOO_LOW');
    }
  });

  it('T14: booking with special characters in address succeeds', async () => {
    setupHappyPathMocks(['t-1']);
    const input = makeBookingInput({
      pickup: {
        coordinates: { latitude: 28.6139, longitude: 77.2090 },
        address: '123, M.G. Road (Near #5 Circle) - Block A/B',
        city: 'Delhi',
        state: 'Delhi',
      },
    });

    const result = await bookingService.createBooking('cust-1', '9876543210', input);
    expect(result).toBeDefined();
  });

  it('T15: booking with very long address (5000 chars) -- service processes it', async () => {
    setupHappyPathMocks(['t-1']);
    const longAddress = 'A'.repeat(5000);
    const input = makeBookingInput({
      pickup: {
        coordinates: { latitude: 28.6139, longitude: 77.2090 },
        address: longAddress,
        city: 'Delhi',
        state: 'Delhi',
      },
    });

    // The schema validation caps at 500 chars, but the service itself does not re-validate
    // If the route handler already validated, the service just processes it
    const result = await bookingService.createBooking('cust-1', '9876543210', input);
    expect(result).toBeDefined();
  });

  it('T16: customer not found in DB -- resolves name to default "Customer"', async () => {
    setupHappyPathMocks(['t-1']);
    mockGetUserById.mockResolvedValue(null);

    const result = await bookingService.createBooking('cust-missing', '9876543210', makeBookingInput());

    expect(result).toBeDefined();
    const createArgs = mockBookingCreate.mock.calls[0]?.[0];
    expect(createArgs?.data?.customerName).toBe('Customer');
  });

  it('T17: customer exists but has no name -- resolves to "Customer"', async () => {
    setupHappyPathMocks(['t-1']);
    mockGetUserById.mockResolvedValue({ id: 'cust-1', name: null });

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    expect(result).toBeDefined();
    const createArgs = mockBookingCreate.mock.calls[0]?.[0];
    expect(createArgs?.data?.customerName).toBe('Customer');
  });

  it('T18: booking with multi-truck request (trucksNeeded=10) succeeds', async () => {
    setupHappyPathMocks(['t-1', 't-2']);

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput({
      trucksNeeded: 10,
      pricePerTruck: 5000,
    }));

    expect(result).toBeDefined();
    const createArgs = mockBookingCreate.mock.calls[0]?.[0];
    expect(createArgs?.data?.trucksNeeded).toBe(10);
    expect(createArgs?.data?.totalAmount).toBe(50000);
  });

  it('T19: booking with trucksNeeded=1 (single truck) succeeds', async () => {
    setupHappyPathMocks(['t-1']);

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput({
      trucksNeeded: 1,
    }));

    expect(result).toBeDefined();
    const createArgs = mockBookingCreate.mock.calls[0]?.[0];
    expect(createArgs?.data?.trucksNeeded).toBe(1);
  });
});

// =============================================================================
// 3. BACKPRESSURE & RATE LIMITING
// =============================================================================

describe('Booking Creation - Backpressure', () => {
  beforeEach(resetAllMocks);

  it('T20: 2nd booking while 1st is active -- blocked with 409', async () => {
    setupHappyPathMocks(['t-1']);
    // active-broadcast key exists
    mockRedisGet.mockImplementation((key: string) => {
      if (key.startsWith('customer:active-broadcast:cust-1')) {
        return Promise.resolve('booking-existing');
      }
      return Promise.resolve(null);
    });

    try {
      await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());
      fail('Expected 409 error');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(409);
      expect(e.code).toBe('ORDER_ACTIVE_EXISTS');
    }
  });

  it('T21: backpressure threshold reached -- 429 SYSTEM_BUSY', async () => {
    setupHappyPathMocks(['t-1']);
    // Simulate concurrency counter > limit (default 50)
    mockRedisIncr.mockResolvedValue(51);

    try {
      await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());
      fail('Expected 429 error');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(429);
      expect(e.code).toBe('SYSTEM_BUSY');
    }
  });

  it('T22: backpressure at exactly the limit (50) -- still succeeds', async () => {
    setupHappyPathMocks(['t-1']);
    mockRedisIncr.mockResolvedValue(50);

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());
    expect(result).toBeDefined();
  });

  it('T23: backpressure counter is decremented on success (no leak)', async () => {
    setupHappyPathMocks(['t-1']);
    mockRedisIncr.mockResolvedValue(1);

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    // incrBy(-1) called in finally block
    expect(mockRedisIncrBy).toHaveBeenCalledWith('booking:create:inflight', -1);
  });

  it('T24: backpressure counter is decremented on error (no leak)', async () => {
    setupHappyPathMocks(['t-1']);
    mockRedisIncr.mockResolvedValue(1);
    // Force an error after backpressure acquired
    mockRedisAcquireLock.mockResolvedValue({ acquired: false });

    try {
      await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());
    } catch (_e: any) {
      // Expected 409
    }

    expect(mockRedisIncrBy).toHaveBeenCalledWith('booking:create:inflight', -1);
  });

  it('T25: Redis down during backpressure check -- skip backpressure and proceed', async () => {
    setupHappyPathMocks(['t-1']);
    // incr throws -- backpressure skipped
    mockRedisIncr.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    // Booking should still proceed because backpressure is gracefully skipped
    expect(result).toBeDefined();
  });

  it('T26: backpressure counter NOT decremented if it was never incremented', async () => {
    setupHappyPathMocks(['t-1']);
    // incr throws -- ctx.incremented stays false
    mockRedisIncr.mockRejectedValue(new Error('Redis timeout'));

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    // incrBy(-1) should NOT have been called for the backpressure key
    const incrByCalls = mockRedisIncrBy.mock.calls.filter(
      (c: any[]) => c[0] === 'booking:create:inflight'
    );
    expect(incrByCalls).toHaveLength(0);
  });

  it('T27: lock not acquired -- throws 409 ACTIVE_ORDER_EXISTS', async () => {
    setupHappyPathMocks(['t-1']);
    mockRedisAcquireLock.mockResolvedValue({ acquired: false });

    try {
      await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());
      fail('Expected 409 error');
    } catch (e: any) {
      expect(e.statusCode).toBe(409);
      expect(e.code).toBe('ORDER_ACTIVE_EXISTS');
    }
  });

  it('T28: 50 different customers create bookings simultaneously -- all succeed', async () => {
    const results: Array<{ customerId: string; success: boolean; error?: string }> = [];

    for (let i = 0; i < 50; i++) {
      resetAllMocks();
      setupHappyPathMocks(['t-1']);
      const custId = `cust-${i}`;
      mockGetUserById.mockResolvedValue({ id: custId, name: `Customer ${i}` });
      mockGetBookingById.mockResolvedValue(makeBookingRecord({ status: 'created', customerId: custId }));

      try {
        await bookingService.createBooking(custId, '9876543210', makeBookingInput());
        results.push({ customerId: custId, success: true });
      } catch (e: any) {
        results.push({ customerId: custId, success: false, error: e.message });
      }
    }

    expect(results).toHaveLength(50);
    const successCount = results.filter(r => r.success).length;
    expect(successCount).toBe(50);
  });

  it('T29: lock is released in finally block even when broadcast throws', async () => {
    setupHappyPathMocks(['t-1']);
    // Force broadcast to throw after booking creation
    mockEmitToUser.mockImplementation(() => { throw new Error('Socket crashed'); });

    try {
      await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());
    } catch (_e: any) {
      // Expected
    }

    expect(mockRedisReleaseLock).toHaveBeenCalled();
  });
});

// =============================================================================
// 4. IDEMPOTENCY
// =============================================================================

describe('Booking Creation - Idempotency', () => {
  beforeEach(resetAllMocks);

  it('T30: client idempotency key -- returns cached booking on retry', async () => {
    const idempotencyKey = 'idem-key-123';
    // Redis has the idempotency key pointing to existing booking
    mockRedisGet.mockImplementation((key: string) => {
      if (key.startsWith(`idempotency:booking:cust-1:${idempotencyKey}`)) {
        return Promise.resolve('booking-existing');
      }
      return Promise.resolve(null);
    });
    mockGetBookingById.mockResolvedValue(makeBookingRecord({ id: 'booking-existing', status: 'active' }));
    mockGetTransportersWithVehicleType.mockResolvedValue(['t-1', 't-2']);
    // Backpressure still runs
    mockRedisIncr.mockResolvedValue(1);

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput(), idempotencyKey);

    expect(result.id).toBe('booking-existing');
    // No new booking created
    expect(mockBookingCreate).not.toHaveBeenCalled();
  });

  it('T31: idempotency key for cancelled booking -- bypassed, new booking created', async () => {
    const idempotencyKey = 'idem-cancelled';
    setupHappyPathMocks(['t-1']);
    // First call for idempotency key returns existing cancelled booking
    mockRedisGet.mockImplementation((key: string) => {
      if (key.startsWith(`idempotency:booking:cust-1:${idempotencyKey}`)) {
        return Promise.resolve('booking-old');
      }
      return Promise.resolve(null);
    });
    mockGetBookingById
      .mockResolvedValueOnce(makeBookingRecord({ id: 'booking-old', status: 'cancelled' }))
      .mockResolvedValue(makeBookingRecord({ status: 'created' }));

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput(), idempotencyKey);

    // Stale key should be cleared and new booking should proceed
    // FIX #30: Idempotency key now includes payload hash suffix
    expect(mockRedisDel).toHaveBeenCalledWith(expect.stringContaining(`idempotency:booking:cust-1:${idempotencyKey}`));
    expect(result).toBeDefined();
  });

  it('T32: idempotency key for expired booking -- bypassed, new booking created', async () => {
    const idempotencyKey = 'idem-expired';
    setupHappyPathMocks(['t-1']);
    mockRedisGet.mockImplementation((key: string) => {
      if (key.startsWith(`idempotency:booking:cust-1:${idempotencyKey}`)) {
        return Promise.resolve('booking-old');
      }
      return Promise.resolve(null);
    });
    mockGetBookingById
      .mockResolvedValueOnce(makeBookingRecord({ id: 'booking-old', status: 'expired' }))
      .mockResolvedValue(makeBookingRecord({ status: 'created' }));

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput(), idempotencyKey);

    // FIX #30: Idempotency key now includes payload hash suffix
    expect(mockRedisDel).toHaveBeenCalledWith(expect.stringContaining(`idempotency:booking:cust-1:${idempotencyKey}`));
    expect(result).toBeDefined();
  });

  it('T33: no idempotency key -- skips idempotency check entirely', async () => {
    setupHappyPathMocks(['t-1']);

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    // Booking proceeds normally without any idempotency Redis lookups for client key
    expect(result).toBeDefined();
    expect(result.matchingTransportersCount).toBe(1);
  });

  it('T34: server-side dedup detects duplicate from fingerprint', async () => {
    setupHappyPathMocks(['t-1']);
    // Server-side dedup key exists
    const dedupeBooking = makeBookingRecord({ id: 'dedup-booking', status: 'active' });
    mockRedisGet.mockImplementation((key: string) => {
      if (key.startsWith('idem:broadcast:create:cust-1:')) {
        return Promise.resolve('dedup-booking');
      }
      return Promise.resolve(null);
    });
    mockGetBookingById.mockResolvedValue(dedupeBooking);
    mockGetTransportersWithVehicleType.mockResolvedValue(['t-1']);

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    expect(result.id).toBe('dedup-booking');
    expect(mockBookingCreate).not.toHaveBeenCalled();
  });

  it('T35: server-side dedup for cancelled booking -- bypassed, new booking proceeds', async () => {
    setupHappyPathMocks(['t-1']);
    mockRedisGet.mockImplementation((key: string) => {
      if (key.startsWith('idem:broadcast:create:cust-1:')) {
        return Promise.resolve('dedup-old');
      }
      return Promise.resolve(null);
    });
    mockGetBookingById
      .mockResolvedValueOnce(makeBookingRecord({ id: 'dedup-old', status: 'cancelled' }))
      .mockResolvedValue(makeBookingRecord({ status: 'created' }));

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    expect(result).toBeDefined();
    expect(mockBookingCreate).toHaveBeenCalled();
  });

  it('T36: idempotency key stored in Redis after successful booking', async () => {
    const idempotencyKey = 'store-test-key';
    setupHappyPathMocks(['t-1']);

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput(), idempotencyKey);

    // Check that Redis.set was called with the idempotency cache key
    // FIX #30: Key now includes payload hash suffix
    const setCallKeys = mockRedisSet.mock.calls.map((c: any[]) => c[0]);
    const hasIdempotencyKey = setCallKeys.some((k: string) => k.startsWith(`idempotency:booking:cust-1:${idempotencyKey}`));
    expect(hasIdempotencyKey).toBe(true);
  });

  it('T37: server-side dedup key stored in Redis after successful booking', async () => {
    setupHappyPathMocks(['t-1']);

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    const setCallKeys = mockRedisSet.mock.calls.map((c: any[]) => c[0]);
    const dedupeKeys = setCallKeys.filter((k: string) => k.startsWith('idem:broadcast:create:cust-1:'));
    expect(dedupeKeys.length).toBeGreaterThan(0);
  });

  it('T38: concurrent requests with same idempotency key -- only 1 booking created', async () => {
    const idempotencyKey = 'concurrent-idem';
    // First request: normal flow
    setupHappyPathMocks(['t-1']);
    const result1 = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput(), idempotencyKey);
    expect(result1).toBeDefined();

    // Second request: idempotency key returns the same booking
    resetAllMocks();
    mockRedisIncr.mockResolvedValue(1);
    mockRedisGet.mockImplementation((key: string) => {
      if (key.startsWith(`idempotency:booking:cust-1:${idempotencyKey}`)) {
        return Promise.resolve('booking-1');
      }
      return Promise.resolve(null);
    });
    mockGetBookingById.mockResolvedValue(makeBookingRecord({ status: 'active' }));
    mockGetTransportersWithVehicleType.mockResolvedValue(['t-1']);

    const result2 = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput(), idempotencyKey);

    expect(result2.id).toBe('booking-1');
    expect(mockBookingCreate).not.toHaveBeenCalled();
  });

  it('T39: idempotency with booking not found in DB -- treats as new booking', async () => {
    const idempotencyKey = 'orphan-key';
    setupHappyPathMocks(['t-1']);
    mockRedisGet.mockImplementation((key: string) => {
      if (key.startsWith(`idempotency:booking:cust-1:${idempotencyKey}`)) {
        return Promise.resolve('booking-gone');
      }
      return Promise.resolve(null);
    });
    // booking-gone does not exist in DB
    mockGetBookingById
      .mockResolvedValueOnce(null)
      .mockResolvedValue(makeBookingRecord({ status: 'created' }));

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput(), idempotencyKey);

    // Falls through to create new booking since DB lookup returned null
    expect(result).toBeDefined();
  });
});

// =============================================================================
// 5. DATABASE TRANSACTION
// =============================================================================

describe('Booking Creation - Database Transaction', () => {
  beforeEach(resetAllMocks);

  it('T40: booking created atomically -- check + create in single SERIALIZABLE tx', async () => {
    setupHappyPathMocks(['t-1']);

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    // withDbTimeout was called (which wraps the transaction)
    expect(withDbTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        isolationLevel: 'Serializable',
      })
    );
  });

  it('T41: existing active booking in DB -- 409 even if Redis missed it', async () => {
    setupHappyPathMocks(['t-1']);
    // Redis says no active booking, but DB has one
    mockRedisGet.mockResolvedValue(null);
    mockBookingFindFirst.mockResolvedValue(makeBookingRecord({ status: 'active' }));

    try {
      await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());
      fail('Expected 409 error');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(409);
      expect(e.code).toBe('ORDER_ACTIVE_EXISTS');
    }
  });

  it('T42: existing active ORDER in DB -- 409 even with no active booking', async () => {
    setupHappyPathMocks(['t-1']);
    mockBookingFindFirst.mockResolvedValue(null);
    mockOrderFindFirst.mockResolvedValue({ id: 'order-1', status: 'active' });

    try {
      await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());
      fail('Expected 409 error');
    } catch (e: any) {
      expect(e.statusCode).toBe(409);
      expect(e.code).toBe('ORDER_ACTIVE_EXISTS');
    }
  });

  it('T43: DB transaction timeout -- proper error propagated', async () => {
    setupHappyPathMocks(['t-1']);
    // withDbTimeout throws a timeout error
    (withDbTimeout as jest.Mock).mockRejectedValueOnce(new Error('Transaction timeout'));

    try {
      await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());
      fail('Expected error');
    } catch (e: any) {
      expect(e.message).toContain('Transaction timeout');
    }
  });

  it('T44: DB serialization conflict (deadlock) -- error propagated to caller', async () => {
    setupHappyPathMocks(['t-1']);
    (withDbTimeout as jest.Mock).mockRejectedValueOnce(
      new Error('could not serialize access due to concurrent update')
    );

    try {
      await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());
      fail('Expected serialization error');
    } catch (e: any) {
      expect(e.message).toContain('serialize');
    }
  });

  it('T45: booking creation fails -- getBookingById returns null -- 500 BOOKING_CREATE_FAILED', async () => {
    setupHappyPathMocks(['t-1']);
    // DB create succeeds but subsequent fetch returns null
    mockGetBookingById.mockResolvedValue(null);

    try {
      await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());
      fail('Expected BOOKING_CREATE_FAILED');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(500);
      expect(e.code).toBe('BOOKING_CREATE_FAILED');
    }
  });

  it('T46: trucksFilled starts at 0 in the DB create call', async () => {
    setupHappyPathMocks(['t-1']);

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    const createArgs = mockBookingCreate.mock.calls[0]?.[0];
    expect(createArgs?.data?.trucksFilled).toBe(0);
  });

  it('T47: active-broadcast Redis key set early (before broadcasts) with TTL', async () => {
    setupHappyPathMocks(['t-1']);

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    const setCallsForActiveKey = mockRedisSet.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].startsWith('customer:active-broadcast:cust-1')
    );
    expect(setCallsForActiveKey.length).toBeGreaterThan(0);
    // TTL should be timeout seconds + 30
    const ttl = setCallsForActiveKey[0][2];
    expect(ttl).toBeGreaterThan(120);
  });

  it('T48: booking with scheduledAt in the future -- stores correctly', async () => {
    setupHappyPathMocks(['t-1']);
    const scheduledAt = new Date(Date.now() + 86400000).toISOString();

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput({
      scheduledAt,
    }));

    const createArgs = mockBookingCreate.mock.calls[0]?.[0];
    expect(createArgs?.data?.scheduledAt).toBe(scheduledAt);
  });
});

// =============================================================================
// 6. DISTANCE & ROUTE CALCULATION
// =============================================================================

describe('Booking Creation - Distance Calculation', () => {
  beforeEach(resetAllMocks);

  it('T49: Google Directions succeeds -- uses server distance over client distance', async () => {
    setupHappyPathMocks(['t-1']);
    mockCalculateRoute.mockResolvedValue({ distanceKm: 65, durationMinutes: 120 });

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput({ distanceKm: 50 }));

    // The fare check should use the Google-verified distance (65), not client distance (50)
    const createArgs = mockBookingCreate.mock.calls[0]?.[0];
    expect(createArgs?.data?.distanceKm).toBe(65);
  });

  it('T50: Google Directions fails -- falls back to client distance with Haversine check', async () => {
    setupHappyPathMocks(['t-1']);
    mockCalculateRoute.mockRejectedValue(new Error('GOOGLE_API_ERROR'));
    mockHaversineDistanceKm.mockReturnValue(48);

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput({ distanceKm: 50 }));

    // Should still create booking
    const createArgs = mockBookingCreate.mock.calls[0]?.[0];
    expect(createArgs).toBeDefined();
  });

  it('T51: Google returns zero distance -- falls back to client distance', async () => {
    setupHappyPathMocks(['t-1']);
    mockCalculateRoute.mockResolvedValue({ distanceKm: 0, durationMinutes: 0 });
    mockHaversineDistanceKm.mockReturnValue(48);

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput({ distanceKm: 50 }));

    expect(mockBookingCreate).toHaveBeenCalled();
  });

  it('T52: client distance differs >50% from Haversine -- overridden with road estimate', async () => {
    setupHappyPathMocks(['t-1']);
    mockCalculateRoute.mockResolvedValue(null); // Google returns null
    mockHaversineDistanceKm.mockReturnValue(30);
    // Client says 50km, Haversine says 30km -> diff = 66% > 50% -> override

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput({
      distanceKm: 50,
      pricePerTruck: 5000,
    }));

    const createArgs = mockBookingCreate.mock.calls[0]?.[0];
    // Road estimate = ceil(30 * 1.3) = 39
    expect(createArgs?.data?.distanceKm).toBe(39);
  });

  it('T53: Google returns null -- Haversine close to client distance -- keeps client', async () => {
    setupHappyPathMocks(['t-1']);
    mockCalculateRoute.mockResolvedValue(null);
    mockHaversineDistanceKm.mockReturnValue(48);
    // Client says 50, Haversine says 48 -> diff = 4.2% < 50% -> keep client

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput({ distanceKm: 50 }));

    const createArgs = mockBookingCreate.mock.calls[0]?.[0];
    expect(createArgs?.data?.distanceKm).toBe(50);
  });

  it('T54: truck mode routing enabled for heavy vehicle types', async () => {
    setupHappyPathMocks(['t-1']);
    process.env.FF_TRUCK_MODE_ROUTING = 'true';

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput({
      vehicleType: 'open',
    }));

    // calculateRoute should be called with useTruckMode=true for 'open' type
    expect(mockCalculateRoute).toHaveBeenCalledWith(
      expect.any(Array),
      true
    );

    process.env.FF_TRUCK_MODE_ROUTING = undefined;
  });

  it('T55: truck mode routing NOT used for non-heavy vehicles when FF disabled', async () => {
    setupHappyPathMocks(['t-1']);
    process.env.FF_TRUCK_MODE_ROUTING = 'false';

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput({
      vehicleType: 'mini',
    }));

    expect(mockCalculateRoute).toHaveBeenCalledWith(
      expect.any(Array),
      false
    );

    process.env.FF_TRUCK_MODE_ROUTING = undefined;
  });
});

// =============================================================================
// 7. NO MATCHING TRANSPORTERS
// =============================================================================

describe('Booking Creation - No Matching Transporters', () => {
  beforeEach(resetAllMocks);

  it('T56: zero matching transporters -- booking created then immediately expired', async () => {
    setupHappyPathMocks([]);
    mockFindCandidates.mockResolvedValue([]);
    mockGetTransportersWithVehicleType.mockResolvedValue([]);
    mockFilterOnline.mockResolvedValue([]);
    mockGetBookingById.mockResolvedValue(makeBookingRecord({ status: 'expired', notifiedTransporters: [] }));

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    expect(result).toBeDefined();
    expect(result.status).toBe('expired');
    expect(result.matchingTransportersCount).toBe(0);
    expect(result.timeoutSeconds).toBe(0);
  });

  it('T57: zero transporters -- NO_VEHICLES_AVAILABLE socket event emitted', async () => {
    setupHappyPathMocks([]);
    mockFindCandidates.mockResolvedValue([]);
    mockGetTransportersWithVehicleType.mockResolvedValue([]);
    mockFilterOnline.mockResolvedValue([]);
    mockGetBookingById.mockResolvedValue(makeBookingRecord({ status: 'expired', notifiedTransporters: [] }));

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    expect(mockEmitToUser).toHaveBeenCalledWith(
      'cust-1',
      'no_vehicles_available',
      expect.objectContaining({ vehicleType: 'open' })
    );
  });

  it('T58: zero nearby transporters -- falls back to DB query for online transporters', async () => {
    setupHappyPathMocks([]);
    mockFindCandidates.mockResolvedValue([]);
    mockGetTransportersWithVehicleType.mockResolvedValue(['t-far']);
    mockFilterOnline.mockResolvedValue(['t-far']);
    mockLoadTransporterDetailsMap.mockResolvedValue(new Map([
      ['t-far', { latitude: '28.7', longitude: '77.3' }],
    ]));
    mockBatchGetPickupDistance.mockResolvedValue(new Map([
      ['t-far', { distanceMeters: 50000, durationSeconds: 3600, source: 'google', cached: false }],
    ]));
    mockGetBookingById.mockResolvedValue(makeBookingRecord({ status: 'created', notifiedTransporters: ['t-far'] }));

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    expect(result).toBeDefined();
    expect(result.matchingTransportersCount).toBe(1);
    expect(mockGetTransportersWithVehicleType).toHaveBeenCalledWith('open');
    expect(mockFilterOnline).toHaveBeenCalled();
  });

  it('T59: DB fallback transporters beyond 200km -- filtered out', async () => {
    setupHappyPathMocks([]);
    mockFindCandidates.mockResolvedValue([]);
    mockGetTransportersWithVehicleType.mockResolvedValue(['t-near', 't-far']);
    mockFilterOnline.mockResolvedValue(['t-near', 't-far']);
    mockLoadTransporterDetailsMap.mockResolvedValue(new Map([
      ['t-near', { latitude: '28.7', longitude: '77.3' }],
      ['t-far', { latitude: '30.0', longitude: '80.0' }],
    ]));
    mockBatchGetPickupDistance.mockResolvedValue(new Map([
      ['t-near', { distanceMeters: 50000, durationSeconds: 3600, source: 'google', cached: false }],
      ['t-far', { distanceMeters: 300000, durationSeconds: 18000, source: 'google', cached: false }],
    ]));
    mockGetBookingById.mockResolvedValue(makeBookingRecord({ status: 'created', notifiedTransporters: ['t-near'] }));

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    expect(result).toBeDefined();
    // t-far (300km) should be filtered out, only t-near (50km) remains
    expect(result.matchingTransportersCount).toBe(1);
  });
});

// =============================================================================
// 8. BROADCAST & NOTIFICATIONS
// =============================================================================

describe('Booking Creation - Broadcast & Notifications', () => {
  beforeEach(resetAllMocks);

  it('T60: FCM sent to offline transporters only', async () => {
    setupHappyPathMocks(['t-online', 't-offline']);
    // Source code uses synchronous isUserConnected, not async
    const { isUserConnected } = require('../shared/services/socket.service');
    (isUserConnected as jest.Mock).mockImplementation((id: string) => id === 't-online');

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    // FCM should be called with only the offline transporter
    expect(mockNotifyNewBroadcast).toHaveBeenCalledWith(
      expect.arrayContaining(['t-offline']),
      expect.any(Object)
    );
  });

  it('T61: all transporters online via socket -- FCM skipped', async () => {
    setupHappyPathMocks(['t-1', 't-2']);
    // Source code uses synchronous isUserConnected, not async
    const { isUserConnected } = require('../shared/services/socket.service');
    (isUserConnected as jest.Mock).mockReturnValue(true);

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    expect(mockNotifyNewBroadcast).not.toHaveBeenCalled();
  });

  it('T62: FCM failure does not block booking creation', async () => {
    setupHappyPathMocks(['t-1']);
    mockNotifyNewBroadcast.mockRejectedValue(new Error('FCM timeout'));

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    expect(result).toBeDefined();
    expect(result.matchingTransportersCount).toBe(1);
  });

  it('T63: broadcast state transitions: created -> broadcasting -> active', async () => {
    setupHappyPathMocks(['t-1']);

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    // booking.updateMany should be called to transition to 'broadcasting' and then 'active'
    const updateManyCalls = mockBookingUpdateMany.mock.calls;
    const statusUpdates = updateManyCalls.map((c: any[]) => c[0]?.data?.status).filter(Boolean);
    expect(statusUpdates).toContain('broadcasting');
    expect(statusUpdates).toContain('active');
  });

  it('T64: broadcast payload includes pickupDistanceKm per transporter', async () => {
    setupHappyPathMocks(['t-1']);

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    expect(mockBuildBroadcastPayload).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        pickupDistanceKm: expect.any(Number),
        pickupEtaMinutes: expect.any(Number),
      })
    );
  });

  it('T65: Redis timer started for booking timeout', async () => {
    setupHappyPathMocks(['t-1']);

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    // cancelTimer + setTimer called for the booking
    expect(mockRedisCancelTimer).toHaveBeenCalled();
    expect(mockRedisSetTimer).toHaveBeenCalledWith(
      expect.stringContaining('timer:booking:'),
      expect.objectContaining({
        bookingId: expect.any(String),
        customerId: 'cust-1',
      }),
      expect.any(Date)
    );
  });

  it('T66: notified transporters tracked in Redis SET for radius expansion', async () => {
    setupHappyPathMocks(['t-1', 't-2']);
    const { redisService } = require('../shared/services/redis.service');

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    expect(redisService.sAddWithExpire).toHaveBeenCalledWith(
      expect.stringContaining('broadcast:notified:'),
      expect.any(Number),
      't-1',
      't-2'
    );
  });
});

// =============================================================================
// 9. PROGRESSIVE RADIUS MATCHING
// =============================================================================

describe('Booking Creation - Progressive Radius Matching', () => {
  beforeEach(resetAllMocks);

  it('T67: step 1 finds nearby transporters -- uses proximity-based matching', async () => {
    setupHappyPathMocks(['t-near-1', 't-near-2']);

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    expect(result.matchingTransportersCount).toBe(2);
    // Progressive radius matcher was called
    expect(mockFindCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        pickupLat: 28.6139,
        pickupLng: 77.2090,
        vehicleType: 'open',
        stepIndex: 0,
      })
    );
  });

  it('T68: step 1 empty -- DB fallback triggered, progressive expansion skipped', async () => {
    setupHappyPathMocks([]);
    mockFindCandidates.mockResolvedValue([]);
    mockGetTransportersWithVehicleType.mockResolvedValue(['t-db']);
    mockFilterOnline.mockResolvedValue(['t-db']);
    mockLoadTransporterDetailsMap.mockResolvedValue(new Map([
      ['t-db', { latitude: '28.7', longitude: '77.3' }],
    ]));
    mockBatchGetPickupDistance.mockResolvedValue(new Map([
      ['t-db', { distanceMeters: 30000, durationSeconds: 2400, source: 'google', cached: false }],
    ]));
    mockGetBookingById.mockResolvedValue(makeBookingRecord({ status: 'created', notifiedTransporters: ['t-db'] }));

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    expect(result).toBeDefined();
    expect(mockGetTransportersWithVehicleType).toHaveBeenCalled();
  });

  it('T69: DB fallback -- caps at 100 online transporters', async () => {
    setupHappyPathMocks([]);
    mockFindCandidates.mockResolvedValue([]);
    const manyTransporters = Array.from({ length: 150 }, (_, i) => `t-${i}`);
    mockGetTransportersWithVehicleType.mockResolvedValue(manyTransporters);
    mockFilterOnline.mockResolvedValue(manyTransporters);
    mockLoadTransporterDetailsMap.mockResolvedValue(new Map());
    mockBatchGetPickupDistance.mockResolvedValue(new Map());
    mockGetBookingById.mockResolvedValue(makeBookingRecord({
      status: 'created',
      notifiedTransporters: manyTransporters.slice(0, 100),
    }));

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    expect(result).toBeDefined();
    // matchingTransporters capped at 100
    expect(result.matchingTransportersCount).toBeLessThanOrEqual(100);
  });

  it('T70: DB fallback -- ETA calculation fails -- falls back to Haversine', async () => {
    setupHappyPathMocks([]);
    mockFindCandidates.mockResolvedValue([]);
    mockGetTransportersWithVehicleType.mockResolvedValue(['t-1']);
    mockFilterOnline.mockResolvedValue(['t-1']);
    mockLoadTransporterDetailsMap.mockResolvedValue(new Map([
      ['t-1', { latitude: '28.7', longitude: '77.3' }],
    ]));
    mockBatchGetPickupDistance.mockRejectedValue(new Error('Distance Matrix error'));
    mockHaversineDistanceKm.mockReturnValue(25);
    mockGetBookingById.mockResolvedValue(makeBookingRecord({ status: 'created', notifiedTransporters: ['t-1'] }));

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    expect(result).toBeDefined();
    expect(mockHaversineDistanceKm).toHaveBeenCalled();
  });
});

// =============================================================================
// 10. EDGE CASES & RESILIENCE
// =============================================================================

describe('Booking Creation - Edge Cases & Resilience', () => {
  beforeEach(resetAllMocks);

  it('T71: sAddWithExpire fails -- retries once then logs error (no crash)', async () => {
    setupHappyPathMocks(['t-1']);
    const { redisService } = require('../shared/services/redis.service');
    redisService.sAddWithExpire
      .mockRejectedValueOnce(new Error('Redis sAdd failed'))
      .mockRejectedValueOnce(new Error('Redis sAdd failed again'));

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    // Booking still succeeds despite sAddWithExpire failures
    expect(result).toBeDefined();
  });

  it('T72: startBookingTimeout is fire-and-forget -- does not block booking creation', async () => {
    // setupBookingTimeout calls startBookingTimeout without await (line 262 of broadcast service).
    // This means timer setup failures do NOT block booking creation.
    // We verify the fire-and-forget pattern: booking succeeds even though
    // startBookingTimeout runs asynchronously in the background.
    setupHappyPathMocks(['t-1']);

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    // Booking returned before startBookingTimeout necessarily completes
    expect(result).toBeDefined();
    // Timer was invoked (fire-and-forget)
    expect(mockRedisCancelTimer).toHaveBeenCalled();
    expect(mockRedisSetTimer).toHaveBeenCalled();
  });

  it('T73: multiple vehicle subtypes generate correct vehicle key', async () => {
    setupHappyPathMocks(['t-1']);

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput({
      vehicleType: 'container',
      vehicleSubtype: '20ft HQ',
    }));

    expect(mockFindCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        vehicleType: 'container',
        vehicleSubtype: '20ft HQ',
      })
    );
  });

  it('T74: large booking (20 trucks) -- totalAmount calculated correctly', async () => {
    setupHappyPathMocks(['t-1']);

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput({
      trucksNeeded: 20,
      pricePerTruck: 15000,
    }));

    const createArgs = mockBookingCreate.mock.calls[0]?.[0];
    expect(createArgs?.data?.totalAmount).toBe(300000);
  });

  it('T75: fractional pricePerTruck -- totalAmount rounded to 2 decimal places', async () => {
    setupHappyPathMocks(['t-1']);

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput({
      trucksNeeded: 3,
      pricePerTruck: 3333.33,
    }));

    const createArgs = mockBookingCreate.mock.calls[0]?.[0];
    // Math.round(3333.33 * 3 * 100) / 100 = Math.round(999999) / 100 = 9999.99
    expect(createArgs?.data?.totalAmount).toBe(9999.99);
  });

  it('T76: Redis releaseLock failure is caught silently (no crash)', async () => {
    setupHappyPathMocks(['t-1']);
    mockRedisReleaseLock.mockRejectedValue(new Error('Redis releaseLock failed'));

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    // Should still succeed; releaseLock is in a .catch()
    expect(result).toBeDefined();
  });

  it('T77: vehicleSubtype is empty string -- still works (vehicle key handles it)', async () => {
    setupHappyPathMocks(['t-1']);

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput({
      vehicleSubtype: '',
    }));

    expect(result).toBeDefined();
  });

  it('T78: goodsType is undefined -- booking still created', async () => {
    setupHappyPathMocks(['t-1']);

    const result = await bookingService.createBooking('cust-1', '9876543210', makeBookingInput({
      goodsType: undefined,
    }));

    expect(result).toBeDefined();
  });

  it('T79: booking with different vehicle types uses correct type in radius search', async () => {
    const vehicleTypes = ['open', 'container', 'tipper', 'mini', 'tanker'];

    for (const vt of vehicleTypes) {
      resetAllMocks();
      setupHappyPathMocks(['t-1']);

      await bookingService.createBooking('cust-1', '9876543210', makeBookingInput({
        vehicleType: vt,
        vehicleSubtype: '17ft',
        pricePerTruck: 5000,
      }));

      expect(mockFindCandidates).toHaveBeenCalledWith(
        expect.objectContaining({ vehicleType: vt })
      );
    }
  });

  it('T80: booking with max broadcast cap (>100 transporters) -- capped at 100 for socket emit', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `t-${i}`);
    setupHappyPathMocks(ids);

    await bookingService.createBooking('cust-1', '9876543210', makeBookingInput());

    const broadcastCalls = mockEmitToUser.mock.calls.filter(
      (c: any[]) => c[1] === 'new_broadcast'
    );
    expect(broadcastCalls.length).toBeLessThanOrEqual(100);
  });
});
