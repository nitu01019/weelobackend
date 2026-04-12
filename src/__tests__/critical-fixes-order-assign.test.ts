/**
 * =============================================================================
 * CRITICAL FIXES — C-04, C-09, C-11 (Phase 3 Testing)
 * =============================================================================
 *
 * Tests for three verified critical issues from VERIFIED-CRITICAL-SOLUTIONS.md:
 *
 * C-09: Transporter validation in order accept
 *   1. Null transporter throws EARLY_RETURN error
 *   2. Suspended transporter (isActive: false) throws EARLY_RETURN error
 *   3. Valid transporter proceeds without error
 *
 * C-04: Vehicle set to on_hold inside transaction
 *   4. Vehicle status changes to on_hold via tx.vehicle.updateMany
 *   5. Vehicle CAS guard fails gracefully when count=0
 *
 * C-11: Side-effect idempotency guard in acceptAssignment
 *   6. First accept triggers side effects (FCM, tracking, Redis)
 *   7. Duplicate accept skips side effects but returns assignment
 *
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
const mockRedisDel = jest.fn().mockResolvedValue(undefined);
const mockRedisExists = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn().mockResolvedValue(undefined);
const mockRedisSMembers = jest.fn();
const mockRedisSAdd = jest.fn();
const mockRedisGetJSON = jest.fn();
const mockRedisSetJSON = jest.fn();
const mockRedisGetExpiredTimers = jest.fn();
const mockRedisCancelTimer = jest.fn().mockResolvedValue(undefined);
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
    scanIterator: jest.fn().mockReturnValue((async function* () { /* yields nothing */ })()),
  },
}));

// ---------------------------------------------------------------------------
// Prisma mock — all models used by acceptTruckRequest + acceptAssignment
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
  return {
    prismaClient: {
      ...buildTxProxy(),
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
const mockGetAssignmentById = jest.fn();
const mockGetActiveAssignmentByDriver = jest.fn();
const mockGetBookingById = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getBookingById: (...args: any[]) => mockGetBookingById(...args),
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
    getAssignmentById: (...args: any[]) => mockGetAssignmentById(...args),
    getActiveAssignmentByDriver: (...args: any[]) => mockGetActiveAssignmentByDriver(...args),
  },
}));

// ---------------------------------------------------------------------------
// Socket service mock
// ---------------------------------------------------------------------------
const mockEmitToUser = jest.fn();
const mockEmitToBooking = jest.fn();
const mockEmitToUsers = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToBooking: (...args: any[]) => mockEmitToBooking(...args),
  emitToUsers: (...args: any[]) => mockEmitToUsers(...args),
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
    TRIP_CANCELLED: 'trip_cancelled',
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
// Queue service mock
// ---------------------------------------------------------------------------
const mockQueuePushNotification = jest.fn().mockResolvedValue(undefined);
const mockCancelAssignmentTimeout = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    addJob: jest.fn(),
    queuePushNotificationBatch: jest.fn().mockResolvedValue(undefined),
    queuePushNotification: (...args: any[]) => mockQueuePushNotification(...args),
    cancelAssignmentTimeout: (...args: any[]) => mockCancelAssignmentTimeout(...args),
    scheduleAssignmentTimeout: jest.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Live availability mock
// ---------------------------------------------------------------------------
const mockOnVehicleStatusChange = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: (...args: any[]) => mockOnVehicleStatusChange(...args),
  },
}));

// ---------------------------------------------------------------------------
// Tracking service mock
// ---------------------------------------------------------------------------
const mockInitializeTracking = jest.fn().mockResolvedValue(undefined);
jest.mock('../modules/tracking/tracking.service', () => ({
  trackingService: {
    initializeTracking: (...args: any[]) => mockInitializeTracking(...args),
  },
}));

// ---------------------------------------------------------------------------
// Other required mocks
// ---------------------------------------------------------------------------
jest.mock('../shared/services/availability.service', () => ({
  availabilityService: {
    loadTransporterDetailsMap: jest.fn().mockResolvedValue(new Map()),
    getTransporterDetails: jest.fn().mockResolvedValue(null),
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

jest.mock('../modules/driver/driver.service', () => ({
  driverService: {
    isDriverOnline: jest.fn().mockResolvedValue(true),
    getDriverById: jest.fn(),
  },
}));

jest.mock('../modules/order/order-lifecycle-outbox.service', () => ({
  enqueueCompletionLifecycleOutbox: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../modules/assignment/auto-redispatch.service', () => ({
  tryAutoRedispatch: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../shared/utils/pii.utils', () => ({
  maskPhoneForExternal: (phone: string) => phone ? `${phone.slice(0, 2)}****${phone.slice(-2)}` : '',
}));

// =============================================================================
// IMPORTS — After all mocks
// =============================================================================

import { acceptTruckRequest } from '../modules/order/order-accept.service';
import { assignmentService } from '../modules/assignment/assignment.service';

// =============================================================================
// TEST HELPERS
// =============================================================================

function futureIso(ms = 120_000): string {
  return new Date(Date.now() + ms).toISOString();
}

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

function makeVehicle(overrides: Record<string, any> = {}): any {
  return {
    id: 'vehicle-001',
    transporterId: 'transporter-001',
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
    id: 'transporter-001',
    name: 'Fleet Co',
    businessName: 'Fleet Co',
    phone: '0000000000',
    role: 'transporter',
    isActive: true,
    ...overrides,
  };
}

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

function makeAssignment(overrides: Record<string, any> = {}): any {
  return {
    id: 'assignment-001',
    bookingId: 'booking-001',
    orderId: 'order-001',
    truckRequestId: 'treq-001',
    transporterId: 'transporter-001',
    transporterName: 'Fleet Co',
    vehicleId: 'vehicle-001',
    vehicleNumber: 'MH12AB1234',
    vehicleType: 'Open',
    vehicleSubtype: '17ft',
    driverId: 'driver-001',
    driverName: 'Driver One',
    driverPhone: '1234567890',
    tripId: 'trip-001',
    status: 'pending',
    assignedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Set up mocks for a successful acceptTruckRequest flow.
 * Override individual mocks after calling this to test specific scenarios.
 */
function setupAcceptTruckRequestMocks(orderOverrides: Record<string, any> = {}): void {
  const truckRequest = makeTruckRequest();
  const order = makeOrder(orderOverrides);
  const transporter = makeTransporter();
  const vehicle = makeVehicle();
  const driver = makeDriver();

  // truckRequest.findUnique is called twice: initial read + re-fetch after update
  let truckRequestCallCount = 0;
  mockTruckRequestFindUnique.mockImplementation(() => {
    truckRequestCallCount++;
    if (truckRequestCallCount % 2 === 0) {
      return Promise.resolve({ ...truckRequest, status: 'assigned', tripId: 'trip-generated' });
    }
    return Promise.resolve(truckRequest);
  });

  mockOrderFindUnique.mockResolvedValue(order);

  // user.findUnique: transporter (1st), then driver (2nd)
  let userCallCount = 0;
  mockUserFindUnique.mockImplementation(() => {
    userCallCount++;
    if (userCallCount % 2 === 1) {
      return Promise.resolve(transporter);
    }
    return Promise.resolve(driver);
  });

  mockVehicleFindUnique.mockResolvedValue(vehicle);
  mockAssignmentFindFirst.mockResolvedValue(null);
  mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });
  mockAssignmentCreate.mockResolvedValue({});
  mockOrderUpdateMany.mockResolvedValue({ count: 1 });
  mockOrderUpdate.mockResolvedValue({});
  mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
  mockSendPushNotification.mockResolvedValue(undefined);
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
  mockAssignmentFindUnique.mockReset();
  mockBookingCreate.mockReset();
  mockBookingFindFirst.mockReset();
  mockBookingFindUnique.mockReset();
  mockBookingUpdateMany.mockReset();
  mockBookingUpdate.mockReset();
  mockQueryRaw.mockReset();
  mockTransaction.mockReset();
  mockEmitToUser.mockReset();
  mockEmitToBooking.mockReset();
  mockEmitToUsers.mockReset();
  mockSendPushNotification.mockReset().mockResolvedValue(undefined);
  mockOnVehicleStatusChange.mockReset().mockResolvedValue(undefined);
  mockInitializeTracking.mockReset().mockResolvedValue(undefined);
  mockGetAssignmentById.mockReset();
  mockGetActiveAssignmentByDriver.mockReset();
  mockGetBookingById.mockReset();
  mockQueuePushNotification.mockReset().mockResolvedValue(undefined);
  mockCancelAssignmentTimeout.mockReset().mockResolvedValue(undefined);
  mockRedisGet.mockReset();
  mockRedisSet.mockReset();
  mockRedisDel.mockReset().mockResolvedValue(undefined);
  mockRedisExists.mockReset();
  mockRedisAcquireLock.mockReset();
  mockRedisReleaseLock.mockReset().mockResolvedValue(undefined);
  mockRedisGetJSON.mockReset();
  mockRedisSetJSON.mockReset();
  mockRedisCancelTimer.mockReset().mockResolvedValue(undefined);
}

// =============================================================================
// C-09 TESTS — Transporter validation in order accept
// =============================================================================

describe('C-09: Transporter validation in acceptTruckRequest', () => {
  beforeEach(resetAllMocks);

  // -------------------------------------------------------------------------
  // Test 1: Null transporter throws error
  // -------------------------------------------------------------------------
  it('returns failure when transporter is not found (null)', async () => {
    setupAcceptTruckRequestMocks();

    // Override: user.findUnique returns null for transporter
    mockUserFindUnique.mockReset();
    mockUserFindUnique.mockResolvedValue(null);

    const result = await acceptTruckRequest(
      'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Transporter account not found/i);

    // Assignment should NOT have been created
    expect(mockAssignmentCreate).not.toHaveBeenCalled();
    // Order CAS should NOT have been attempted
    expect(mockOrderUpdateMany).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 2: Suspended transporter (isActive: false) throws error
  // -------------------------------------------------------------------------
  it('returns failure when transporter is suspended (isActive: false)', async () => {
    setupAcceptTruckRequestMocks();

    // Override: transporter exists but is suspended
    const suspendedTransporter = makeTransporter({ isActive: false });
    const driver = makeDriver();

    mockUserFindUnique.mockReset();
    let userCallCount = 0;
    mockUserFindUnique.mockImplementation(() => {
      userCallCount++;
      if (userCallCount % 2 === 1) {
        return Promise.resolve(suspendedTransporter);
      }
      return Promise.resolve(driver);
    });

    const result = await acceptTruckRequest(
      'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/suspended/i);

    // Verify metrics counter was incremented for suspension block
    const { metrics } = require('../shared/monitoring/metrics.service');
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'assignment_blocked_total',
      { reason: 'transporter_suspended' }
    );

    // Assignment should NOT have been created
    expect(mockAssignmentCreate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 3: Non-transporter role throws error
  // -------------------------------------------------------------------------
  it('returns failure when user role is not transporter', async () => {
    setupAcceptTruckRequestMocks();

    // Override: user exists but is a customer, not transporter
    const customerUser = makeTransporter({ role: 'customer' });
    mockUserFindUnique.mockReset();
    mockUserFindUnique.mockResolvedValue(customerUser);

    const result = await acceptTruckRequest(
      'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Only transporters can accept/i);
    expect(mockAssignmentCreate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 4: Valid transporter proceeds without error
  // -------------------------------------------------------------------------
  it('succeeds when transporter is valid and active', async () => {
    setupAcceptTruckRequestMocks();

    const result = await acceptTruckRequest(
      'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
    );

    expect(result.success).toBe(true);
    expect(result.assignmentId).toBeDefined();
    expect(result.tripId).toBeDefined();

    // Verify transporter was queried with correct fields
    expect(mockUserFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'transporter-001' },
        select: expect.objectContaining({
          id: true,
          role: true,
          isActive: true,
        }),
      })
    );
  });
});

// =============================================================================
// C-04 TESTS — Vehicle set to on_hold in transaction
// =============================================================================

describe('C-04: Vehicle status set to on_hold during order accept', () => {
  beforeEach(resetAllMocks);

  // -------------------------------------------------------------------------
  // Test 5: Vehicle status changes to on_hold in transaction
  // -------------------------------------------------------------------------
  it('calls tx.vehicle.updateMany with status on_hold and CAS guard', async () => {
    setupAcceptTruckRequestMocks();

    const result = await acceptTruckRequest(
      'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
    );

    expect(result.success).toBe(true);

    // Verify vehicle.updateMany was called with on_hold status
    expect(mockVehicleUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'vehicle-001',
          status: 'available',  // CAS guard: only if still available
        }),
        data: expect.objectContaining({
          status: 'on_hold',
          assignedDriverId: 'driver-001',
        }),
      })
    );

    // Verify tripId is set on the vehicle
    const vehicleUpdateCall = mockVehicleUpdateMany.mock.calls.find(
      (call: any[]) => call[0]?.data?.status === 'on_hold'
    );
    expect(vehicleUpdateCall).toBeDefined();
    expect(vehicleUpdateCall![0].data.currentTripId).toBeDefined();
    expect(vehicleUpdateCall![0].data.lastStatusChange).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Test 6: Redis sync fires after vehicle on_hold
  // -------------------------------------------------------------------------
  it('syncs vehicle status to Redis after on_hold in transaction', async () => {
    setupAcceptTruckRequestMocks();

    const result = await acceptTruckRequest(
      'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
    );

    expect(result.success).toBe(true);

    // Verify liveAvailabilityService.onVehicleStatusChange was called
    expect(mockOnVehicleStatusChange).toHaveBeenCalledWith(
      'transporter-001',
      expect.any(String),       // vehicleKey
      'available',              // old status
      'on_hold'                 // new status
    );
  });

  // -------------------------------------------------------------------------
  // Test 7: Vehicle CAS guard returning count=0 does not break the flow
  // -------------------------------------------------------------------------
  it('accept still succeeds even if vehicle CAS returns count=0', async () => {
    setupAcceptTruckRequestMocks();

    // Vehicle CAS returns 0 (vehicle was already held by another process)
    // The current implementation does not throw on vehicle CAS failure --
    // it proceeds because the assignment is the primary record and the
    // vehicle status is a secondary concern (defense-in-depth).
    mockVehicleUpdateMany.mockResolvedValue({ count: 0 });

    const result = await acceptTruckRequest(
      'treq-001', 'transporter-001', 'vehicle-001', 'driver-001'
    );

    // Accept should still succeed -- vehicle CAS is best-effort inside TX
    expect(result.success).toBe(true);

    // Vehicle CAS was attempted
    expect(mockVehicleUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'vehicle-001',
          status: 'available',
        }),
      })
    );
  });
});

// =============================================================================
// C-11 TESTS — Side-effect idempotency guard in acceptAssignment
// =============================================================================

describe('C-11: Side-effect idempotency guard in acceptAssignment', () => {
  beforeEach(resetAllMocks);

  /**
   * Set up mocks for a successful acceptAssignment flow.
   */
  function setupAcceptAssignmentMocks(): void {
    const assignment = makeAssignment();

    mockGetAssignmentById.mockResolvedValue(assignment);
    mockGetActiveAssignmentByDriver.mockResolvedValue(null);

    // TX: assignment CAS update succeeds
    mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    // TX: vehicle update
    mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
    // TX: return updated assignment
    const updatedAssignment = { ...assignment, status: 'driver_accepted' };
    mockAssignmentFindUnique.mockResolvedValue(updatedAssignment);

    // Redis mocks for tracking seed
    mockRedisGetJSON.mockResolvedValue(null);
    mockRedisSetJSON.mockResolvedValue(undefined);

    // Booking lookup for customer notification
    mockGetBookingById.mockResolvedValue({
      id: 'booking-001',
      customerId: 'customer-001',
    });

    // Vehicle lookup for Redis sync
    mockVehicleFindUnique.mockResolvedValue({
      vehicleKey: 'Open_17ft',
      transporterId: 'transporter-001',
    });
  }

  // -------------------------------------------------------------------------
  // Test 8: First accept triggers side effects
  // -------------------------------------------------------------------------
  it('fires FCM, tracking, and Redis side effects when lock is acquired', async () => {
    setupAcceptAssignmentMocks();

    // Side-effect lock acquired (first call)
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });

    const result = await assignmentService.acceptAssignment('assignment-001', 'driver-001');

    expect(result).toBeDefined();
    expect(result.status).toBe('driver_accepted');

    // Verify side-effect lock was requested with correct key
    expect(mockRedisAcquireLock).toHaveBeenCalledWith(
      'side-effect:accept:assignment-001',
      'accept-guard',
      300
    );

    // Verify tracking was initialized
    expect(mockInitializeTracking).toHaveBeenCalledWith(
      'trip-001',           // tripId
      'driver-001',         // driverId
      'MH12AB1234',         // vehicleNumber
      'booking-001',        // bookingId
      'transporter-001',    // transporterId
      'vehicle-001'         // vehicleId
    );

    // Verify Redis availability sync fires (vehicle on_hold -> in_transit)
    expect(mockOnVehicleStatusChange).toHaveBeenCalledWith(
      'transporter-001',
      'Open_17ft',
      'on_hold',
      'in_transit'
    );

    // Verify FCM push notification to transporter
    expect(mockQueuePushNotification).toHaveBeenCalledWith(
      'transporter-001',
      expect.objectContaining({
        title: expect.stringContaining('Driver Accepted'),
        data: expect.objectContaining({
          assignmentId: 'assignment-001',
          status: 'driver_accepted',
        }),
      })
    );

    // Verify socket event to booking room
    expect(mockEmitToBooking).toHaveBeenCalledWith(
      expect.any(String),
      'assignment_status_changed',
      expect.objectContaining({
        assignmentId: 'assignment-001',
        status: 'driver_accepted',
      })
    );
  });

  // -------------------------------------------------------------------------
  // Test 9: Duplicate accept skips side effects
  // -------------------------------------------------------------------------
  it('skips side effects but returns assignment when lock is not acquired', async () => {
    setupAcceptAssignmentMocks();

    // Side-effect lock NOT acquired (duplicate call)
    mockRedisAcquireLock.mockResolvedValue({ acquired: false });

    const result = await assignmentService.acceptAssignment('assignment-001', 'driver-001');

    // Assignment is still returned successfully
    expect(result).toBeDefined();
    expect(result.status).toBe('driver_accepted');

    // Verify side-effect lock was checked
    expect(mockRedisAcquireLock).toHaveBeenCalledWith(
      'side-effect:accept:assignment-001',
      'accept-guard',
      300
    );

    // Verify tracking was NOT initialized (side effects skipped)
    expect(mockInitializeTracking).not.toHaveBeenCalled();

    // Verify Redis availability sync was NOT called (side effects skipped)
    expect(mockOnVehicleStatusChange).not.toHaveBeenCalled();

    // Verify FCM push was NOT sent (side effects skipped)
    expect(mockQueuePushNotification).not.toHaveBeenCalled();

    // Verify socket event to booking was NOT emitted (side effects skipped)
    expect(mockEmitToBooking).not.toHaveBeenCalled();

    // But the assignment timeout WAS cancelled (happens before the guard)
    expect(mockCancelAssignmentTimeout).toHaveBeenCalledWith('assignment-001');
  });
});
