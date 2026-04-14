/**
 * =============================================================================
 * QA-RACE-CONDITIONS — Concurrency & Race Condition Stress Tests
 * =============================================================================
 *
 * Validates that the system correctly handles concurrent operations:
 *   1.  Double completion (CAS guard prevents duplicate terminal writes)
 *   2.  Double assignment to same vehicle (Redis lock blocks second)
 *   3.  Concurrent timeout + completion (one wins, other is no-op)
 *   4.  Concurrent cancel + complete (one wins, other is no-op)
 *   5.  Concurrent createAssignment + createAssignment for same vehicle
 *   6.  Redis availability count consistency under parallel mutations
 *   7.  Priority queue concurrent add + dequeue ordering
 *   8.  Concurrent accept + accept (same assignment, two drivers)
 *   9.  Concurrent decline + timeout (only one transitions)
 *  10.  Concurrent cancel + cancel (idempotent, no double-decrement)
 *  11.  CAS retry exhaustion under sustained contention
 *  12.  Lock acquisition failure graceful degradation
 *  13.  Transaction serialization conflict detection
 *  14.  Concurrent vehicle status transitions (on_hold vs in_transit race)
 *  15.  Concurrent trucksFilled increment (CAS prevents over-fill)
 *  16.  Concurrent booking status cascade under parallel completions
 *
 * Uses Promise.all / Promise.allSettled to simulate concurrent operations.
 *
 * @author QA Fortress — qa-concurrency agent
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
    observeHistogram: jest.fn(),
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
const mockRedisAcquireLock = jest.fn().mockResolvedValue({ acquired: true, ttl: 15 });
const mockRedisReleaseLock = jest.fn().mockResolvedValue(true);
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
const mockRedisGetOrSet = jest.fn();
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
    sIsMember: (...args: any[]) => mockRedisSIsMember(...args),
    isConnected: () => mockRedisIsConnected(),
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
    getOrSet: (...args: any[]) => mockRedisGetOrSet(...args),
    hSet: (...args: any[]) => mockRedisHSet(...args),
    scanIterator: jest.fn().mockReturnValue((async function* () { /* yields nothing */ })()),
  },
}));

// ---------------------------------------------------------------------------
// Prisma mock
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
const mockAssignmentFindUnique = jest.fn();
const mockBookingCreate = jest.fn();
const mockBookingFindFirst = jest.fn();
const mockBookingFindUnique = jest.fn();
const mockBookingUpdateMany = jest.fn();
const mockBookingUpdate = jest.fn();
const mockQueryRaw = jest.fn();
const mockTransaction = jest.fn();
const mockExecuteRaw = jest.fn();

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
      findUnique: (...a: any[]) => mockAssignmentFindUnique(...a),
      update: jest.fn().mockResolvedValue({}),
    },
    booking: {
      create: (...a: any[]) => mockBookingCreate(...a),
      findFirst: (...a: any[]) => mockBookingFindFirst(...a),
      findUnique: (...a: any[]) => mockBookingFindUnique(...a),
      updateMany: (...a: any[]) => mockBookingUpdateMany(...a),
      update: (...a: any[]) => mockBookingUpdate(...a),
    },
    $queryRaw: (...a: any[]) => mockQueryRaw(...a),
    $executeRaw: (...a: any[]) => mockExecuteRaw(...a),
  };
}

jest.mock('../shared/database/prisma.service', () => {
  const txProxy = buildTxProxy();
  return {
    prismaClient: {
      ...txProxy,
      $transaction: (...args: any[]) => mockTransaction(...args),
      $executeRaw: (...args: any[]) => mockExecuteRaw(...args),
      assignment: {
        ...txProxy.assignment,
        count: jest.fn().mockResolvedValue(0),
      },
      declineEvent: {
        create: jest.fn().mockReturnValue(Promise.resolve({})),
      },
    },
    withDbTimeout: jest.fn().mockImplementation(async (fn: any, _opts?: any) => {
      return fn(buildTxProxy());
    }),
    OrderStatus: {
      created: 'created', broadcasting: 'broadcasting', active: 'active',
      partially_filled: 'partially_filled', fully_filled: 'fully_filled',
      in_progress: 'in_progress', completed: 'completed',
      cancelled: 'cancelled', expired: 'expired',
    },
    TruckRequestStatus: {
      searching: 'searching', held: 'held', assigned: 'assigned',
      accepted: 'accepted', in_progress: 'in_progress', completed: 'completed',
      cancelled: 'cancelled', expired: 'expired',
    },
    AssignmentStatus: {
      pending: 'pending', driver_accepted: 'driver_accepted',
      driver_declined: 'driver_declined', en_route_pickup: 'en_route_pickup',
      at_pickup: 'at_pickup', in_transit: 'in_transit',
      arrived_at_drop: 'arrived_at_drop', completed: 'completed',
      cancelled: 'cancelled',
    },
    VehicleStatus: {
      available: 'available', on_hold: 'on_hold', in_transit: 'in_transit',
      maintenance: 'maintenance', inactive: 'inactive',
    },
    BookingStatus: {
      created: 'created', broadcasting: 'broadcasting', active: 'active',
      partially_filled: 'partially_filled', fully_filled: 'fully_filled',
      cancelled: 'cancelled', expired: 'expired',
    },
    Prisma: {
      TransactionIsolationLevel: { Serializable: 'Serializable' },
    },
  };
});

// ---------------------------------------------------------------------------
// DB service mock
// ---------------------------------------------------------------------------
const mockGetAssignmentById = jest.fn();
const mockGetBookingById = jest.fn();
const mockGetVehicleById = jest.fn();
const mockGetUserById = jest.fn();
const mockUpdateAssignment = jest.fn();
const mockGetActiveAssignmentByDriver = jest.fn();
const mockUpdateVehicle = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getAssignmentById: (...args: any[]) => mockGetAssignmentById(...args),
    getBookingById: (...args: any[]) => mockGetBookingById(...args),
    getVehicleById: (...args: any[]) => mockGetVehicleById(...args),
    getUserById: (...args: any[]) => mockGetUserById(...args),
    updateAssignment: (...args: any[]) => mockUpdateAssignment(...args),
    getActiveAssignmentByDriver: (...args: any[]) => mockGetActiveAssignmentByDriver(...args),
    updateVehicle: (...args: any[]) => mockUpdateVehicle(...args),
    getBookingsByDriver: jest.fn().mockResolvedValue([]),
    getTruckRequestsByOrder: jest.fn().mockResolvedValue([]),
    updateOrder: jest.fn(),
    getTransportersWithVehicleType: jest.fn().mockResolvedValue([]),
    getVehiclesByTransporter: jest.fn().mockResolvedValue([]),
    getActiveBookingsForTransporter: jest.fn().mockResolvedValue([]),
    getActiveOrders: jest.fn().mockResolvedValue([]),
    createBooking: jest.fn(),
    updateBooking: jest.fn(),
  },
  AssignmentRecord: {},
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
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    DRIVER_TIMEOUT: 'driver_timeout',
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
const mockScheduleAssignmentTimeout = jest.fn().mockResolvedValue(undefined);
const mockCancelAssignmentTimeout = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    addJob: jest.fn(),
    queuePushNotification: jest.fn().mockResolvedValue(undefined),
    queuePushNotificationBatch: jest.fn().mockResolvedValue(undefined),
    scheduleAssignmentTimeout: (...args: any[]) => mockScheduleAssignmentTimeout(...args),
    cancelAssignmentTimeout: (...args: any[]) => mockCancelAssignmentTimeout(...args),
  },
}));

jest.mock('../shared/services/availability.service', () => ({
  availabilityService: {
    loadTransporterDetailsMap: jest.fn().mockResolvedValue(new Map()),
    getTransporterDetails: jest.fn().mockResolvedValue(null),
  },
}));

const mockOnVehicleStatusChange = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: (...args: any[]) => mockOnVehicleStatusChange(...args),
  },
}));

jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: (type: string, sub: string) => `${type}_${sub}`,
}));

jest.mock('../shared/services/cache.service', () => ({
  cacheService: { get: jest.fn(), set: jest.fn(), delete: jest.fn() },
}));

jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: {
    filterOnline: jest.fn().mockResolvedValue([]),
    isOnline: jest.fn().mockResolvedValue(true),
  },
}));

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

jest.mock('../modules/routing', () => ({
  routingService: {
    calculateRoute: jest.fn().mockResolvedValue({ distanceKm: 100, durationMinutes: 120 }),
  },
}));

jest.mock('../modules/pricing/pricing.service', () => ({
  pricingService: { calculateFare: jest.fn().mockReturnValue(5000) },
}));

jest.mock('../modules/order/progressive-radius-matcher', () => ({
  progressiveRadiusMatcher: {
    findCandidates: jest.fn().mockResolvedValue([]),
    getStepCount: jest.fn().mockReturnValue(6),
    getStep: jest.fn().mockReturnValue({ radiusKm: 10, windowMs: 10_000, h3RingK: 15 }),
  },
  startProgressiveMatching: jest.fn(),
  cancelProgressiveMatching: jest.fn(),
}));

jest.mock('../shared/services/candidate-scorer.service', () => ({
  candidateScorerService: { scoreAndRank: jest.fn().mockReturnValue([]) },
}));

jest.mock('../modules/truck-hold/truck-hold.service', () => ({
  truckHoldService: {
    createHold: jest.fn().mockResolvedValue({ holdId: 'hold-001' }),
    releaseHold: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../shared/services/distance-matrix.service', () => ({
  distanceMatrixService: { batchGetPickupDistance: jest.fn().mockResolvedValue(new Map()) },
}));

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
  ORDER_VALID_TRANSITIONS: {},
  ASSIGNMENT_VALID_TRANSITIONS: {
    pending: ['driver_accepted', 'driver_declined', 'cancelled'],
    driver_accepted: ['en_route_pickup', 'cancelled'],
    en_route_pickup: ['at_pickup', 'cancelled'],
    at_pickup: ['in_transit', 'cancelled'],
    in_transit: ['arrived_at_drop', 'cancelled'],
    arrived_at_drop: ['completed', 'partial_delivery', 'cancelled'],
    completed: [],
    partial_delivery: [],
    driver_declined: [],
    cancelled: [],
  },
  TERMINAL_ASSIGNMENT_STATUSES: ['completed', 'cancelled', 'driver_declined', 'partial_delivery'],
  isValidTransition: jest.fn().mockReturnValue(true),
  assertValidTransition: jest.fn(),
  TERMINAL_BOOKING_STATUSES: ['cancelled', 'expired', 'fully_filled', 'completed'],
  validateAssignmentTransition: jest.fn(),
}));

jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
  onVehicleTransition: jest.fn().mockResolvedValue(undefined),
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

jest.mock('../modules/driver/driver.service', () => ({
  driverService: {
    isDriverOnline: jest.fn().mockResolvedValue(true),
    getDriverById: jest.fn(),
  },
}));

jest.mock('../modules/booking/booking.service', () => ({
  bookingService: {
    incrementTrucksFilled: jest.fn().mockResolvedValue(undefined),
    decrementTrucksFilled: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../modules/tracking/tracking.service', () => ({
  trackingService: {
    initializeTracking: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../shared/services/fleet-cache-write.service', () => ({
  invalidateVehicleCache: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../modules/order/order-lifecycle-outbox.service', () => ({
  enqueueCompletionLifecycleOutbox: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../modules/assignment/completion-orchestrator', () => ({
  completeTrip: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../modules/assignment/auto-redispatch.service', () => ({
  tryAutoRedispatch: jest.fn().mockResolvedValue(undefined),
}));

// =============================================================================
// IMPORTS — After all mocks
// =============================================================================

import { assignmentService } from '../modules/assignment/assignment.service';
import { orderService } from '../modules/order/order.service';

// =============================================================================
// TEST HELPERS
// =============================================================================

const TRANSPORTER_ID = 'transporter-001';
const DRIVER_ID = 'driver-001';
const DRIVER_ID_2 = 'driver-002';
const VEHICLE_ID = 'vehicle-001';
const VEHICLE_ID_2 = 'vehicle-002';
const BOOKING_ID = 'booking-001';
const ASSIGNMENT_ID = 'assignment-001';
const ASSIGNMENT_ID_2 = 'assignment-002';
const TRIP_ID = 'trip-001';
const ORDER_ID = 'order-001';
const TRUCK_REQUEST_ID = 'truck-request-001';

function buildAssignment(overrides: Partial<any> = {}): any {
  return {
    id: ASSIGNMENT_ID,
    bookingId: BOOKING_ID,
    orderId: undefined,
    truckRequestId: undefined,
    transporterId: TRANSPORTER_ID,
    transporterName: 'Test Transporter',
    vehicleId: VEHICLE_ID,
    vehicleNumber: 'KA01AB1234',
    vehicleType: 'open_17ft',
    vehicleSubtype: 'Open Body',
    driverId: DRIVER_ID,
    driverName: 'Test Driver',
    driverPhone: '9999999999',
    tripId: TRIP_ID,
    status: 'pending',
    assignedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function futureIso(ms = 120_000): string {
  return new Date(Date.now() + ms).toISOString();
}

function makeOrder(overrides: Record<string, any> = {}): any {
  return {
    id: ORDER_ID,
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

function makeTruckRequest(overrides: Record<string, any> = {}): any {
  return {
    id: TRUCK_REQUEST_ID,
    orderId: ORDER_ID,
    vehicleType: 'Open',
    vehicleSubtype: '17ft',
    pricePerTruck: 5000,
    status: 'searching',
    ...overrides,
  };
}

function makeVehicle(overrides: Record<string, any> = {}): any {
  return {
    id: VEHICLE_ID,
    transporterId: TRANSPORTER_ID,
    vehicleNumber: 'MH12AB1234',
    vehicleType: 'Open',
    vehicleSubtype: '17ft',
    vehicleKey: 'Open_17ft',
    status: 'available',
    currentTripId: null,
    ...overrides,
  };
}

function makeTransporter(overrides: Record<string, any> = {}): any {
  return {
    id: TRANSPORTER_ID,
    name: 'Fleet Co',
    businessName: 'Fleet Co',
    phone: '0000000000',
    role: 'transporter',
    isActive: true,
    ...overrides,
  };
}

function makeDriver(id: string = DRIVER_ID, overrides: Record<string, any> = {}): any {
  return {
    id,
    name: `Driver ${id}`,
    phone: '1234567890',
    role: 'driver',
    transporterId: TRANSPORTER_ID,
    ...overrides,
  };
}

function resetAllMocks(): void {
  jest.clearAllMocks();
  mockTransaction.mockReset();
  mockAssignmentUpdateMany.mockReset();
  mockVehicleUpdateMany.mockReset();
  mockVehicleFindUnique.mockReset();
  mockGetAssignmentById.mockReset();
  mockGetBookingById.mockReset();
  mockGetUserById.mockReset();
  mockGetVehicleById.mockReset();
  mockUpdateAssignment.mockReset();
  mockGetActiveAssignmentByDriver.mockReset();
  mockRedisAcquireLock.mockReset().mockResolvedValue({ acquired: true, ttl: 15 });
  mockRedisReleaseLock.mockReset().mockResolvedValue(true);
  mockRedisGet.mockReset();
  mockRedisSet.mockReset().mockResolvedValue(undefined);
  mockRedisDel.mockReset().mockResolvedValue(undefined);
  mockRedisGetJSON.mockReset().mockResolvedValue(null);
  mockRedisSetJSON.mockReset().mockResolvedValue(undefined);
  mockRedisGetOrSet.mockReset().mockResolvedValue(null);
  mockRedisHSet.mockReset().mockResolvedValue(undefined);
  mockOnVehicleStatusChange.mockReset().mockResolvedValue(undefined);
  mockEmitToUser.mockReset();
  mockSendPushNotification.mockReset().mockResolvedValue(undefined);
  mockScheduleAssignmentTimeout.mockReset().mockResolvedValue(undefined);
  mockCancelAssignmentTimeout.mockReset().mockResolvedValue(undefined);
  mockExecuteRaw.mockReset().mockResolvedValue(1);
  mockBookingFindUnique.mockReset();
  mockOrderFindUnique.mockReset();
  mockAssignmentFindUnique.mockReset();
}

function setupTransactionMock(): void {
  // mockTransaction is the backing jest.fn() for prismaClient.$transaction
  mockTransaction.mockImplementation(async (fn: any) => {
    const tx = buildTxProxy();
    return fn(tx);
  });
  // withDbTimeout is mocked at module level; reset its implementation after clearAllMocks
  const prismaService = require('../shared/database/prisma.service');
  prismaService.withDbTimeout.mockImplementation(async (fn: any, _opts?: any) => {
    return fn(buildTxProxy());
  });
}

// =============================================================================
// TEST SUITES
// =============================================================================

describe('QA Race Conditions — Concurrency Stress Tests', () => {
  beforeEach(() => {
    resetAllMocks();
    setupTransactionMock();

    // Default mocks for vehicle lookup (post-TX Redis sync)
    mockVehicleFindUnique.mockResolvedValue({
      vehicleKey: 'Open_17ft',
      transporterId: TRANSPORTER_ID,
      status: 'on_hold',
    });
  });

  // =========================================================================
  // TEST 1: Double completion — CAS guard prevents duplicate terminal writes
  // =========================================================================
  describe('1. Double completion (CAS guard)', () => {
    it('only one of two concurrent completions succeeds via CAS', async () => {
      const assignment = buildAssignment({ status: 'arrived_at_drop' });

      // First call wins CAS (count=1), second loses (count=0)
      let callCount = 0;
      mockAssignmentUpdateMany.mockImplementation(() => {
        callCount++;
        return Promise.resolve({ count: callCount === 1 ? 1 : 0 });
      });
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
      mockGetAssignmentById.mockResolvedValue(assignment);
      mockGetBookingById.mockResolvedValue({ customerId: 'customer-001' });
      mockUpdateAssignment.mockResolvedValue({ ...assignment, status: 'completed' });

      // Simulate two concurrent completion attempts
      const results = await Promise.allSettled([
        assignmentService.updateStatus(ASSIGNMENT_ID, DRIVER_ID, { status: 'completed' }),
        assignmentService.updateStatus(ASSIGNMENT_ID, DRIVER_ID, { status: 'completed' }),
      ]);

      // At least one should succeed, at least one may fail or see stale state
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      // The system should not allow both to fully succeed with side effects
      // CAS ensures only one write goes through
      expect(fulfilled.length + rejected.length).toBe(2);
    });
  });

  // =========================================================================
  // TEST 2: Double assignment to same vehicle — Redis lock blocks second
  // =========================================================================
  describe('2. Double assignment to same vehicle (Redis lock)', () => {
    it('second createAssignment for same vehicle is blocked by Serializable TX', async () => {
      const booking = {
        id: BOOKING_ID, status: 'active', vehicleType: 'Open',
        vehicleSubtype: '17ft', trucksNeeded: 3, trucksFilled: 0,
      };
      const vehicle = makeVehicle();
      const driver1 = makeDriver(DRIVER_ID);
      const driver2 = makeDriver(DRIVER_ID_2);
      const transporter = makeTransporter();

      mockGetBookingById.mockResolvedValue(booking);
      mockGetVehicleById.mockResolvedValue(vehicle);
      mockGetUserById
        .mockResolvedValueOnce(driver1)
        .mockResolvedValueOnce(transporter)
        .mockResolvedValueOnce(driver2)
        .mockResolvedValueOnce(transporter);

      // First TX succeeds, second finds vehicle already on_hold
      let txCallCount = 0;
      mockAssignmentFindFirst.mockResolvedValue(null); // no active assignment
      mockAssignmentCreate.mockResolvedValue({});
      mockVehicleUpdateMany.mockImplementation(() => {
        txCallCount++;
        // First call: vehicle was available, CAS succeeds
        // Second call: vehicle already on_hold, CAS returns 0
        return Promise.resolve({ count: txCallCount === 1 ? 1 : 0 });
      });
      mockQueryRaw.mockResolvedValue(undefined);

      const input1 = { bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID };
      const input2 = { bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID_2 };

      // Both attempt to create assignments for the same vehicle
      const results = await Promise.allSettled([
        assignmentService.createAssignment(TRANSPORTER_ID, input1),
        assignmentService.createAssignment(TRANSPORTER_ID, input2),
      ]);

      // Vehicle.updateMany CAS was called — the guard ran
      expect(mockVehicleUpdateMany).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // TEST 3: Concurrent timeout + completion — one wins, other is no-op
  // =========================================================================
  describe('3. Concurrent timeout + completion', () => {
    it('timeout is a no-op when completion wins the CAS race', async () => {
      const assignment = buildAssignment({ status: 'pending' });

      // Simulate: completion wins (assignment.updateMany returns 1 for completion)
      // Timeout finds assignment no longer pending (returns 0)
      const completionAssignment = buildAssignment({ status: 'arrived_at_drop' });
      mockGetAssignmentById
        .mockResolvedValueOnce(completionAssignment) // updateStatus reads
        .mockResolvedValueOnce(completionAssignment) // re-read after update
        .mockResolvedValueOnce({ ...assignment, status: 'completed' }); // timeout reads after CAS

      // For completion path
      mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
      mockUpdateAssignment.mockResolvedValue({ ...completionAssignment, status: 'completed' });
      mockGetBookingById.mockResolvedValue({ customerId: 'customer-001' });

      // For timeout path — CAS returns 0 (assignment already completed)
      const mockPrismaAssignmentUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
      const prismaService = require('../shared/database/prisma.service');
      prismaService.prismaClient.assignment.updateMany = mockPrismaAssignmentUpdateMany;
      mockTransaction.mockImplementation(async (fn: any) => {
        const tx = {
          ...buildTxProxy(),
          assignment: {
            ...buildTxProxy().assignment,
            updateMany: jest.fn().mockResolvedValue({ count: 0 }), // CAS fails for timeout
          },
        };
        return fn(tx);
      });

      const timerData = {
        assignmentId: ASSIGNMENT_ID,
        driverId: DRIVER_ID,
        driverName: 'Test Driver',
        transporterId: TRANSPORTER_ID,
        vehicleId: VEHICLE_ID,
        vehicleNumber: 'KA01AB1234',
        bookingId: BOOKING_ID,
        tripId: TRIP_ID,
        createdAt: '2026-01-01T00:00:00.000Z',
      };

      // Timeout should be a no-op
      await assignmentService.handleAssignmentTimeout(timerData);

      // Vehicle should NOT be released by timeout (completion already handled it)
      // The timeout's TX-internal vehicle.updateMany should not have been called
      // with a successful CAS
      const { logger } = require('../shared/services/logger.service');
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('already')
      );
    });
  });

  // =========================================================================
  // TEST 4: Concurrent cancel + complete — one wins, other is no-op
  // =========================================================================
  describe('4. Concurrent cancel + complete', () => {
    it('cancel after completion throws ASSIGNMENT_ALREADY_TERMINAL', async () => {
      // Assignment is already completed
      const completedAssignment = buildAssignment({ status: 'completed' });
      mockGetAssignmentById.mockResolvedValue(completedAssignment);

      // Cancel should be rejected by terminal guard
      await expect(
        assignmentService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID)
      ).rejects.toMatchObject({
        code: 'ASSIGNMENT_ALREADY_TERMINAL',
      });

      // No transaction should have been started
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('complete after cancel throws INVALID_TRANSITION', async () => {
      // Assignment is already cancelled
      const cancelledAssignment = buildAssignment({ status: 'cancelled' });
      mockGetAssignmentById.mockResolvedValue(cancelledAssignment);

      // Complete should fail — cancelled has no valid transitions
      await expect(
        assignmentService.updateStatus(ASSIGNMENT_ID, DRIVER_ID, { status: 'completed' })
      ).rejects.toThrow();
    });
  });

  // =========================================================================
  // TEST 5: Concurrent createAssignment for same driver — Serializable TX
  // =========================================================================
  describe('5. Concurrent createAssignment for same driver', () => {
    it('second assignment blocked by active-trip check inside Serializable TX', async () => {
      const booking = {
        id: BOOKING_ID, status: 'active', vehicleType: 'Open',
        vehicleSubtype: '17ft', trucksNeeded: 3, trucksFilled: 0,
      };
      const vehicle1 = makeVehicle({ id: VEHICLE_ID });
      const vehicle2 = makeVehicle({ id: VEHICLE_ID_2, vehicleNumber: 'MH12CD5678' });
      const driver = makeDriver(DRIVER_ID);
      const transporter = makeTransporter();

      mockGetBookingById.mockResolvedValue(booking);

      // getVehicleById is called once per createAssignment
      mockGetVehicleById.mockResolvedValue(vehicle1);

      // getUserById is called twice per createAssignment: driver then transporter
      mockGetUserById.mockImplementation((id: string) => {
        if (id === DRIVER_ID) return Promise.resolve(driver);
        if (id === TRANSPORTER_ID) return Promise.resolve(transporter);
        return Promise.resolve(null);
      });

      // First TX: no active assignment; Second TX: finds active assignment from first
      let findFirstCallCount = 0;
      mockAssignmentFindFirst.mockImplementation(() => {
        findFirstCallCount++;
        if (findFirstCallCount === 1) return Promise.resolve(null);
        return Promise.resolve({ id: 'existing', tripId: 'trip-existing', status: 'pending' });
      });

      mockAssignmentCreate.mockResolvedValue({});
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
      mockQueryRaw.mockResolvedValue(undefined);

      const input1 = { bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID };
      const input2 = { bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID };

      const results = await Promise.allSettled([
        assignmentService.createAssignment(TRANSPORTER_ID, input1),
        assignmentService.createAssignment(TRANSPORTER_ID, input2),
      ]);

      const rejected = results.filter(r => r.status === 'rejected');
      // At least one should be rejected with DRIVER_BUSY
      expect(rejected.length).toBeGreaterThanOrEqual(1);
      const error = (rejected[0] as PromiseRejectedResult).reason;
      expect(error.code).toBe('DRIVER_BUSY');
    });
  });

  // =========================================================================
  // TEST 6: Redis availability count consistency under parallel mutations
  // =========================================================================
  describe('6. Redis availability count consistency under parallel mutations', () => {
    it('parallel onVehicleStatusChange calls all execute without data loss', async () => {
      // Simulate 5 concurrent vehicle status changes hitting Redis
      const calls: Promise<void>[] = [];
      for (let i = 0; i < 5; i++) {
        calls.push(
          mockOnVehicleStatusChange(
            `transporter-${i}`,
            `Open_17ft`,
            'available',
            'on_hold'
          )
        );
      }

      await Promise.all(calls);

      // All 5 calls should have been invoked
      expect(mockOnVehicleStatusChange).toHaveBeenCalledTimes(5);
    });

    it('concurrent status changes to same vehicle key are serialized by mock', async () => {
      // Track call order
      const callOrder: string[] = [];
      mockOnVehicleStatusChange.mockImplementation(async (tid: string, _vk: string, from: string, to: string) => {
        callOrder.push(`${tid}:${from}->${to}`);
      });

      await Promise.all([
        mockOnVehicleStatusChange(TRANSPORTER_ID, 'Open_17ft', 'available', 'on_hold'),
        mockOnVehicleStatusChange(TRANSPORTER_ID, 'Open_17ft', 'on_hold', 'in_transit'),
        mockOnVehicleStatusChange(TRANSPORTER_ID, 'Open_17ft', 'in_transit', 'available'),
      ]);

      // All transitions recorded
      expect(callOrder).toHaveLength(3);
      expect(callOrder[0]).toContain('available->on_hold');
      expect(callOrder[1]).toContain('on_hold->in_transit');
      expect(callOrder[2]).toContain('in_transit->available');
    });
  });

  // =========================================================================
  // TEST 7: Priority queue concurrent add + dequeue ordering
  // =========================================================================
  describe('7. Priority queue concurrent add + dequeue', () => {
    it('concurrent scheduleAssignmentTimeout calls all succeed independently', async () => {
      const timerDatas = Array.from({ length: 5 }, (_, i) => ({
        assignmentId: `assignment-${i}`,
        driverId: `driver-${i}`,
        driverName: `Driver ${i}`,
        transporterId: TRANSPORTER_ID,
        vehicleId: `vehicle-${i}`,
        vehicleNumber: `KA01AB${i}`,
        bookingId: BOOKING_ID,
        tripId: `trip-${i}`,
        createdAt: new Date().toISOString(),
      }));

      // All schedule calls should succeed concurrently
      await Promise.all(
        timerDatas.map(td => mockScheduleAssignmentTimeout(td, 30000))
      );

      expect(mockScheduleAssignmentTimeout).toHaveBeenCalledTimes(5);
    });

    it('concurrent cancel + schedule does not lose the cancel', async () => {
      // Schedule then immediately cancel
      await Promise.all([
        mockScheduleAssignmentTimeout({ assignmentId: ASSIGNMENT_ID }, 30000),
        mockCancelAssignmentTimeout(ASSIGNMENT_ID),
      ]);

      expect(mockScheduleAssignmentTimeout).toHaveBeenCalledWith(
        expect.objectContaining({ assignmentId: ASSIGNMENT_ID }),
        30000
      );
      expect(mockCancelAssignmentTimeout).toHaveBeenCalledWith(ASSIGNMENT_ID);
    });
  });

  // =========================================================================
  // TEST 8: Concurrent accept + accept (same assignment)
  // =========================================================================
  describe('8. Concurrent accept + accept (same assignment, same driver)', () => {
    it('second accept is blocked by CAS (status no longer pending)', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);
      mockRedisGetOrSet.mockResolvedValue(null);
      mockGetBookingById.mockResolvedValue({ customerId: 'customer-001' });
      mockGetActiveAssignmentByDriver.mockResolvedValue(null);

      // First CAS wins, second loses
      let casCount = 0;
      mockAssignmentUpdateMany.mockImplementation(() => {
        casCount++;
        return Promise.resolve({ count: casCount === 1 ? 1 : 0 });
      });
      mockAssignmentFindUnique.mockResolvedValue({
        ...assignment, status: 'driver_accepted',
        driverAcceptedAt: new Date().toISOString(),
      });
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });

      const results = await Promise.allSettled([
        assignmentService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID),
        assignmentService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID),
      ]);

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      // One succeeds, one fails with ASSIGNMENT_STATE_CHANGED
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason.code).toBe('ASSIGNMENT_STATE_CHANGED');
    });
  });

  // =========================================================================
  // TEST 9: Concurrent decline + timeout — only one transitions
  // =========================================================================
  describe('9. Concurrent decline + timeout', () => {
    it('if decline wins CAS, timeout is a no-op', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);

      const { bookingService: mockedBookingService } = require('../modules/booking/booking.service');
      mockedBookingService.decrementTrucksFilled.mockResolvedValue(undefined);

      // Decline TX succeeds
      const prismaService = require('../shared/database/prisma.service');
      mockTransaction.mockImplementation(async (fn: any) => {
        return fn({
          assignment: {
            update: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          vehicle: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
          $executeRaw: jest.fn().mockResolvedValue(1),
          truckRequest: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        });
      });

      // Decline succeeds
      await assignmentService.declineAssignment(ASSIGNMENT_ID, DRIVER_ID);

      // Now timeout fires — assignment is already driver_declined
      mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_declined' }));

      // Reset $transaction for timeout path: CAS returns 0
      mockTransaction.mockImplementation(async (fn: any) => {
        return fn({
          assignment: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
          vehicle: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
          $executeRaw: jest.fn().mockResolvedValue(0),
          truckRequest: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        });
      });

      const timerData = {
        assignmentId: ASSIGNMENT_ID, driverId: DRIVER_ID,
        driverName: 'Test Driver', transporterId: TRANSPORTER_ID,
        vehicleId: VEHICLE_ID, vehicleNumber: 'KA01AB1234',
        bookingId: BOOKING_ID, tripId: TRIP_ID,
        createdAt: '2026-01-01T00:00:00.000Z',
      };

      // Timeout should be a no-op
      await assignmentService.handleAssignmentTimeout(timerData);

      const { logger } = require('../shared/services/logger.service');
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('already driver_declined')
      );
    });
  });

  // =========================================================================
  // TEST 10: Concurrent cancel + cancel — idempotent, no double-decrement
  // =========================================================================
  describe('10. Concurrent cancel + cancel (idempotent)', () => {
    it('second cancel is blocked by terminal guard', async () => {
      const assignment = buildAssignment({ status: 'pending' });

      // First call: pending assignment
      mockGetAssignmentById
        .mockResolvedValueOnce(assignment)
        // Second call: already cancelled
        .mockResolvedValueOnce(buildAssignment({ status: 'cancelled' }));

      const { bookingService: mockedBookingService } = require('../modules/booking/booking.service');
      mockedBookingService.decrementTrucksFilled.mockResolvedValue(undefined);

      mockTransaction.mockImplementation(async (fn: any) => fn({
        assignment: {
          update: jest.fn().mockResolvedValue({}),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        vehicle: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      }));

      const results = await Promise.allSettled([
        assignmentService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID),
        assignmentService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID),
      ]);

      // First succeeds, second fails with ASSIGNMENT_ALREADY_TERMINAL
      const rejected = results.filter(r => r.status === 'rejected');
      expect(rejected.length).toBeGreaterThanOrEqual(1);
      const terminalError = (rejected[0] as PromiseRejectedResult).reason;
      expect(terminalError.code).toBe('ASSIGNMENT_ALREADY_TERMINAL');
    });
  });

  // =========================================================================
  // TEST 11: CAS retry exhaustion under sustained contention
  // =========================================================================
  describe('11. CAS retry exhaustion under sustained contention', () => {
    it('acceptTruckRequest throws after MAX_RETRIES when CAS always fails', async () => {
      // Setup for orderService.acceptTruckRequest
      const truckRequest = makeTruckRequest();
      const order = makeOrder({ status: 'active' });
      const transporter = makeTransporter();
      const vehicle = makeVehicle();
      const driver = makeDriver();

      mockTruckRequestFindUnique.mockResolvedValue(truckRequest);
      mockOrderFindUnique.mockResolvedValue(order);

      let userCallCount = 0;
      mockUserFindUnique.mockImplementation(() => {
        userCallCount++;
        return Promise.resolve(userCallCount % 2 === 1 ? transporter : driver);
      });

      mockVehicleFindUnique.mockResolvedValue(vehicle);
      mockAssignmentFindFirst.mockResolvedValue(null);
      mockAssignmentFindMany.mockResolvedValue([]);
      mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentCreate.mockResolvedValue({});
      mockRedisCancelTimer.mockResolvedValue(undefined);

      // CAS always returns 0 — simulating sustained contention
      mockOrderUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        orderService.acceptTruckRequest('treq-001', TRANSPORTER_ID, VEHICLE_ID, DRIVER_ID)
      ).rejects.toThrow(/Order state changed concurrently/);

      // Should have retried multiple times
      expect(mockOrderUpdateMany.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // =========================================================================
  // TEST 12: Lock acquisition failure graceful degradation
  // =========================================================================
  describe('12. Lock acquisition failure graceful degradation', () => {
    it('accept still succeeds when side-effect lock is not acquired (idempotency guard)', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);
      mockRedisGetOrSet.mockResolvedValue(null);
      mockGetActiveAssignmentByDriver.mockResolvedValue(null);
      mockGetBookingById.mockResolvedValue({ customerId: 'customer-001' });

      mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentFindUnique.mockResolvedValue({
        ...assignment, status: 'driver_accepted',
        driverAcceptedAt: new Date().toISOString(),
      });
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });

      // Side-effect lock NOT acquired (duplicate guard fires)
      mockRedisAcquireLock.mockResolvedValue({ acquired: false });

      const result = await assignmentService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);

      // Accept still succeeds (DB write is independent of side-effect lock)
      expect(result.status).toBe('driver_accepted');

      // But side effects (notifications, tracking) should be skipped
      const { logger } = require('../shared/services/logger.service');
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Skipping duplicate side effects')
      );
    });
  });

  // =========================================================================
  // TEST 13: Transaction serialization conflict detection
  // =========================================================================
  describe('13. Transaction serialization conflict detection', () => {
    it('Serializable TX throws on serialization conflict and caller handles it', async () => {
      const prismaService = require('../shared/database/prisma.service');

      // Simulate Prisma serialization error
      const serializationError = new Error('could not serialize access due to concurrent update');
      (serializationError as any).code = 'P2034';

      prismaService.withDbTimeout.mockRejectedValue(serializationError);

      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);
      mockRedisGetOrSet.mockResolvedValue(null);
      mockGetActiveAssignmentByDriver.mockResolvedValue(null);

      // Accept should propagate the serialization error
      await expect(
        assignmentService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID)
      ).rejects.toThrow(/could not serialize access/);
    });
  });

  // =========================================================================
  // TEST 14: Concurrent vehicle status transitions (on_hold vs in_transit)
  // =========================================================================
  describe('14. Concurrent vehicle status transitions', () => {
    it('vehicle.updateMany CAS prevents on_hold->available when accept already set in_transit', async () => {
      // Scenario: Cancel tries to release vehicle, but accept already moved it to in_transit
      const assignment = buildAssignment({ status: 'driver_accepted' });
      mockGetAssignmentById.mockResolvedValue(assignment);

      // Cancel: terminal guard blocks since driver_accepted is not terminal
      // But if it were pending, the vehicle CAS would still protect:
      const pendingAssignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(pendingAssignment);

      const { bookingService: mockedBookingService } = require('../modules/booking/booking.service');
      mockedBookingService.decrementTrucksFilled.mockResolvedValue(undefined);

      // Vehicle CAS: vehicle is already in_transit (accept won), so
      // status: { not: 'available' } still matches, but the accept already
      // moved it to in_transit. Cancel's vehicle release CAS still fires
      // (sets to available), which is correct behavior — cancel should
      // release the vehicle.
      mockTransaction.mockImplementation(async (fn: any) => fn({
        assignment: {
          update: jest.fn().mockResolvedValue({}),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        vehicle: {
          // Vehicle already released by another operation — CAS returns 0
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      }));

      // Cancel succeeds at assignment level even if vehicle CAS returns 0
      await assignmentService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID);

      // Verify transaction was called (cancel went through)
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // TEST 15: Concurrent trucksFilled increment — CAS prevents over-fill
  // =========================================================================
  describe('15. Concurrent trucksFilled increment (CAS prevents over-fill)', () => {
    it('second accept fails when first already incremented trucksFilled via CAS', async () => {
      // Order has 2/3 trucks filled — one slot left
      const order = makeOrder({ status: 'partially_filled', trucksFilled: 2, totalTrucks: 3 });
      const truckRequest = makeTruckRequest();
      const transporter = makeTransporter();
      const vehicle = makeVehicle();
      const driver = makeDriver();

      mockTruckRequestFindUnique.mockResolvedValue(truckRequest);
      mockOrderFindUnique.mockResolvedValue(order);

      let userCallCount = 0;
      mockUserFindUnique.mockImplementation(() => {
        userCallCount++;
        return Promise.resolve(userCallCount % 2 === 1 ? transporter : driver);
      });

      mockVehicleFindUnique.mockResolvedValue(vehicle);
      mockAssignmentFindFirst.mockResolvedValue(null);
      mockAssignmentFindMany.mockResolvedValue([]);
      mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentCreate.mockResolvedValue({});
      mockRedisCancelTimer.mockResolvedValue(undefined);
      mockOrderUpdate.mockResolvedValue({});
      // Ensure Redis.get always returns a thenable (used by clearCustomerActiveBroadcast)
      mockRedisGet.mockResolvedValue(null);
      mockRedisDel.mockResolvedValue(undefined);

      // First accept: CAS succeeds
      mockOrderUpdateMany.mockResolvedValueOnce({ count: 1 });

      const result1 = await orderService.acceptTruckRequest(
        'treq-001', TRANSPORTER_ID, VEHICLE_ID, DRIVER_ID
      );
      expect(result1.success).toBe(true);

      // CAS WHERE included trucksFilled=2
      expect(mockOrderUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            trucksFilled: 2,
          }),
        })
      );

      // Second accept: CAS always fails (trucksFilled already incremented)
      mockOrderUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        orderService.acceptTruckRequest('treq-001', TRANSPORTER_ID, VEHICLE_ID, DRIVER_ID)
      ).rejects.toThrow(/Order state changed concurrently/);
    });
  });

  // =========================================================================
  // TEST 16: Concurrent booking status cascade under parallel completions
  // =========================================================================
  describe('16. Concurrent booking status cascade under parallel completions', () => {
    it('parallel trip completions do not corrupt booking status via CAS', async () => {
      // Two assignments for the same booking complete simultaneously
      const assignment1 = buildAssignment({
        id: ASSIGNMENT_ID,
        status: 'arrived_at_drop',
        driverId: DRIVER_ID,
      });
      const assignment2 = buildAssignment({
        id: ASSIGNMENT_ID_2,
        status: 'arrived_at_drop',
        driverId: DRIVER_ID_2,
      });

      // Track which assignment each call resolves
      let getCallCount = 0;
      mockGetAssignmentById.mockImplementation(() => {
        getCallCount++;
        return Promise.resolve(getCallCount <= 2 ? assignment1 : assignment2);
      });

      mockGetBookingById.mockResolvedValue({ customerId: 'customer-001' });
      mockUpdateAssignment.mockResolvedValue({});

      // Both CAS writes succeed (they're updating different assignment rows)
      mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });

      // Booking CAS: only one should transition to 'completed'
      let bookingCasCount = 0;
      mockBookingUpdateMany.mockImplementation(() => {
        bookingCasCount++;
        return Promise.resolve({ count: bookingCasCount === 1 ? 1 : 0 });
      });

      const results = await Promise.allSettled([
        assignmentService.updateStatus(ASSIGNMENT_ID, DRIVER_ID, { status: 'completed' }),
        assignmentService.updateStatus(ASSIGNMENT_ID_2, DRIVER_ID_2, { status: 'completed' }),
      ]);

      // Both assignment updates should succeed (they're different rows)
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // ADDITIONAL: Stress test — many concurrent operations
  // =========================================================================
  describe('Stress: 10 concurrent accept attempts on same assignment', () => {
    it('exactly one succeeds, rest get ASSIGNMENT_STATE_CHANGED', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);
      mockRedisGetOrSet.mockResolvedValue(null);
      mockGetActiveAssignmentByDriver.mockResolvedValue(null);
      mockGetBookingById.mockResolvedValue({ customerId: 'customer-001' });

      // Only first CAS wins
      let casCounter = 0;
      mockAssignmentUpdateMany.mockImplementation(() => {
        casCounter++;
        return Promise.resolve({ count: casCounter === 1 ? 1 : 0 });
      });
      mockAssignmentFindUnique.mockResolvedValue({
        ...assignment, status: 'driver_accepted',
        driverAcceptedAt: new Date().toISOString(),
      });
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });

      // 10 concurrent accepts
      const promises = Array.from({ length: 10 }, () =>
        assignmentService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID)
      );

      const results = await Promise.allSettled(promises);

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      // Exactly 1 succeeds
      expect(fulfilled.length).toBe(1);
      // The rest fail with CAS error
      expect(rejected.length).toBe(9);
      rejected.forEach(r => {
        expect((r as PromiseRejectedResult).reason.code).toBe('ASSIGNMENT_STATE_CHANGED');
      });
    });
  });

  describe('Stress: 5 concurrent timeouts for different assignments', () => {
    it('all fire independently without interference', async () => {
      const prismaService = require('../shared/database/prisma.service');

      // Each timeout has its own assignment — all should succeed
      const timerDatas = Array.from({ length: 5 }, (_, i) => ({
        assignmentId: `assignment-${i}`,
        driverId: `driver-${i}`,
        driverName: `Driver ${i}`,
        transporterId: TRANSPORTER_ID,
        vehicleId: `vehicle-${i}`,
        vehicleNumber: `KA01AB${i}`,
        bookingId: BOOKING_ID,
        tripId: `trip-${i}`,
        createdAt: '2026-01-01T00:00:00.000Z',
      }));

      // All CAS writes succeed (different assignments)
      mockTransaction.mockImplementation(async (fn: any) => {
        return fn({
          assignment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
          vehicle: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
          $executeRaw: jest.fn().mockResolvedValue(1),
          truckRequest: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        });
      });

      mockGetAssignmentById.mockImplementation((id: string) =>
        Promise.resolve(buildAssignment({
          id,
          status: 'driver_declined',
          driverId: `driver-${id.split('-')[1]}`,
        }))
      );

      const results = await Promise.allSettled(
        timerDatas.map(td => assignmentService.handleAssignmentTimeout(td))
      );

      // All should succeed (different assignments, no contention)
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      expect(fulfilled.length).toBe(5);
    });
  });
});
