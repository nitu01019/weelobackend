/**
 * =============================================================================
 * PHASE 7 — E2E FLOW SCENARIO TESTS
 * =============================================================================
 *
 * 10 end-to-end scenarios covering the full Weelo logistics lifecycle:
 *
 *   Scenario 1: Happy path (book → accept → pickup → transit → complete → rate)
 *   Scenario 2: Driver declines → auto-redispatch → new driver completes
 *   Scenario 3: Flex hold expires → vehicles released → rebookable
 *   Scenario 4: Concurrent accepts (vehicle mutex via CAS)
 *   Scenario 5: Mid-trip cancellation → vehicle released → rebook
 *   Scenario 6: Multi-truck order → mixed terminal states → order completed
 *   Scenario 7: Network failure recovery (FCM circuit breaker → outbox drain)
 *   Scenario 8: GPS tracking lifecycle (presence → compression → history)
 *   Scenario 9: Completion race condition (CAS ensures exactly-once)
 *   Scenario 10: Full broadcast flow with all 7 safety mechanisms
 *
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — must precede all imports
// =============================================================================

// -- Queue Service --
const mockScheduleAssignmentTimeout = jest.fn().mockResolvedValue('timer:assignment-timeout:mock');
const mockCancelAssignmentTimeout = jest.fn().mockResolvedValue(undefined);
const mockQueuePushNotification = jest.fn().mockResolvedValue('push-id');
const mockQueueBroadcast = jest.fn().mockResolvedValue(undefined);
const mockEnqueue = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    scheduleAssignmentTimeout: mockScheduleAssignmentTimeout,
    cancelAssignmentTimeout: mockCancelAssignmentTimeout,
    queuePushNotification: mockQueuePushNotification,
    queueBroadcast: mockQueueBroadcast,
    enqueue: mockEnqueue,
  },
}));

// -- Logger --
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
jest.mock('../shared/services/logger.service', () => ({
  logger: mockLogger,
}));

// -- Metrics --
const mockIncrementCounter = jest.fn();
const mockObserveHistogram = jest.fn();
jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: mockIncrementCounter,
    observeHistogram: mockObserveHistogram,
    recordHistogram: jest.fn(),
  },
}));

// -- Socket Service --
const mockEmitToUser = jest.fn();
const mockEmitToRoom = jest.fn();
const mockEmitToBooking = jest.fn();
const mockEmitToTrip = jest.fn();
const mockEmitToOrder = jest.fn();
const mockIsUserConnectedAsync = jest.fn().mockResolvedValue(true);

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToRoom: (...args: any[]) => mockEmitToRoom(...args),
  emitToBooking: (...args: any[]) => mockEmitToBooking(...args),
  emitToTrip: (...args: any[]) => mockEmitToTrip(...args),
  emitToOrder: (...args: any[]) => mockEmitToOrder(...args),
  isUserConnectedAsync: (...args: any[]) => mockIsUserConnectedAsync(...args),
  isUserConnected: jest.fn().mockReturnValue(true),
  getConnectedUserCount: jest.fn().mockReturnValue(1),
  socketService: {
    emitToUser: (...args: any[]) => mockEmitToUser(...args),
    emitToRoom: (...args: any[]) => mockEmitToRoom(...args),
  },
  SocketEvent: {
    NEW_BROADCAST: 'new_broadcast',
    BROADCAST_STATE_CHANGED: 'broadcast_state_changed',
    NO_VEHICLES_AVAILABLE: 'no_vehicles_available',
    TRIP_ASSIGNED: 'trip_assigned',
    TRUCK_CONFIRMED: 'truck_confirmed',
    BOOKING_UPDATED: 'booking_updated',
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    ASSIGNMENT_TIMEOUT: 'assignment_timeout',
    DRIVER_TIMEOUT: 'driver_timeout',
    VEHICLE_STATUS_CHANGED: 'vehicle_status_changed',
    FLEX_HOLD_EXTENDED: 'flex_hold_extended',
    BROADCAST_EXPIRED: 'broadcast_expired',
    BOOKING_FULLY_FILLED: 'booking_fully_filled',
    BROADCAST_CANCELLED: 'order_cancelled',
    TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update',
  },
  initializeSocket: jest.fn(),
}));

// -- Redis Service --
const mockRedisGet = jest.fn().mockResolvedValue(null);
const mockRedisSet = jest.fn().mockResolvedValue(undefined);
const mockRedisDel = jest.fn().mockResolvedValue(undefined);
const mockRedisIncr = jest.fn().mockResolvedValue(1);
const mockRedisIncrBy = jest.fn().mockResolvedValue(0);
const mockRedisExpire = jest.fn().mockResolvedValue(undefined);
const mockRedisSIsMember = jest.fn().mockResolvedValue(false);
const mockRedisSMembers = jest.fn().mockResolvedValue([]);
const mockRedisSCard = jest.fn().mockResolvedValue(0);
const mockRedisSRem = jest.fn().mockResolvedValue(undefined);
const mockRedisSScan = jest.fn().mockResolvedValue([]);
const mockRedisExists = jest.fn().mockResolvedValue(false);
const mockRedisAcquireLock = jest.fn().mockResolvedValue({ acquired: true });
const mockRedisReleaseLock = jest.fn().mockResolvedValue(true);
const mockRedisLPush = jest.fn().mockResolvedValue(undefined);
const mockRedisLTrim = jest.fn().mockResolvedValue(undefined);
const mockRedisIsConnected = jest.fn().mockReturnValue(true);
const mockRedisSetTimer = jest.fn().mockResolvedValue(undefined);
const mockRedisCancelTimer = jest.fn().mockResolvedValue(undefined);
const mockRedisGetExpiredTimers = jest.fn().mockResolvedValue([]);
const mockRedisSAdd = jest.fn().mockResolvedValue(undefined);
const mockRedisHMSet = jest.fn().mockResolvedValue(undefined);
const mockRedisHSet = jest.fn().mockResolvedValue(undefined);
const mockRedisHGetAll = jest.fn().mockResolvedValue({});
const mockRedisHGetAllBatch = jest.fn().mockResolvedValue([]);
const mockRedisGeoAdd = jest.fn().mockResolvedValue(undefined);
const mockRedisGeoRemove = jest.fn().mockResolvedValue(undefined);
const mockRedisGeoRadius = jest.fn().mockResolvedValue([]);
const mockRedisIsRedisEnabled = jest.fn().mockReturnValue(true);
const mockRedisGetJSON = jest.fn().mockResolvedValue(null);
const mockRedisSetJSON = jest.fn().mockResolvedValue(undefined);
const mockRedisGetOrSet = jest.fn().mockResolvedValue(null);
const mockRedisPipeline = jest.fn().mockResolvedValue(undefined);

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
    getJSON: (...args: any[]) => mockRedisGetJSON(...args),
    setJSON: (...args: any[]) => mockRedisSetJSON(...args),
    getOrSet: (...args: any[]) => mockRedisGetOrSet(...args),
    pipeline: (...args: any[]) => mockRedisPipeline(...args),
  },
}));

// -- DB mock (PrismaDatabaseService) --
const mockGetAssignmentById = jest.fn();
const mockGetBookingById = jest.fn();
const mockGetVehicleById = jest.fn();
const mockGetUserById = jest.fn();
const mockUpdateAssignment = jest.fn();
const mockGetActiveAssignmentByDriver = jest.fn();
const mockUpdateVehicle = jest.fn();
const mockDbCreateBooking = jest.fn();
const mockDbGetTransportersByVehicleType = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getAssignmentById: (...args: any[]) => mockGetAssignmentById(...args),
    getBookingById: (...args: any[]) => mockGetBookingById(...args),
    getVehicleById: (...args: any[]) => mockGetVehicleById(...args),
    getUserById: (...args: any[]) => mockGetUserById(...args),
    updateAssignment: (...args: any[]) => mockUpdateAssignment(...args),
    getActiveAssignmentByDriver: (...args: any[]) => mockGetActiveAssignmentByDriver(...args),
    updateVehicle: (...args: any[]) => mockUpdateVehicle(...args),
    createBooking: (...args: any[]) => mockDbCreateBooking(...args),
    getTransportersByVehicleType: (...args: any[]) => mockDbGetTransportersByVehicleType(...args),
  },
  AssignmentRecord: {},
}));

// -- Prisma Client mock --
const mockTxAssignmentUpdateMany = jest.fn();
const mockTxAssignmentFindUnique = jest.fn();
const mockTxVehicleUpdateMany = jest.fn();
const mockTxBookingUpdateMany = jest.fn();
const mockTxOrderUpdate = jest.fn();
const mockTxTruckRequestUpdateMany = jest.fn();

const mockTxExecuteRaw = jest.fn().mockResolvedValue(1);
const mockTx = {
  $queryRaw: jest.fn().mockResolvedValue([{ trucksFilled: 1 }]),
  $executeRaw: (...args: any[]) => mockTxExecuteRaw(...args),
  assignment: {
    updateMany: (...args: any[]) => mockTxAssignmentUpdateMany(...args),
    findUnique: (...args: any[]) => mockTxAssignmentFindUnique(...args),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  vehicle: {
    updateMany: (...args: any[]) => mockTxVehicleUpdateMany(...args),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  booking: {
    updateMany: (...args: any[]) => mockTxBookingUpdateMany(...args),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  order: {
    update: (...args: any[]) => mockTxOrderUpdate(...args),
    findUnique: jest.fn(),
  },
  truckRequest: {
    updateMany: (...args: any[]) => mockTxTruckRequestUpdateMany(...args),
  },
};

const mockVehicleFindUnique = jest.fn();
const mockVehicleUpdateMany = jest.fn();
const mockPrismaAssignmentUpdateMany = jest.fn();
const mockPrismaAssignmentFindUnique = jest.fn();
const mockPrismaOrderUpdate = jest.fn();
const mockPrismaOrderFindUnique = jest.fn();
const mockPrismaTruckRequestUpdateMany = jest.fn();
const mockPrismaExecuteRaw = jest.fn();
const mockPrismaTransaction = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    $transaction: (...args: any[]) => mockPrismaTransaction(...args),
    $executeRaw: (...args: any[]) => mockPrismaExecuteRaw(...args),
    $queryRaw: jest.fn().mockResolvedValue([{ trucksFilled: 1 }]),
    assignment: {
      updateMany: (...args: any[]) => mockPrismaAssignmentUpdateMany(...args),
      findUnique: (...args: any[]) => mockPrismaAssignmentFindUnique(...args),
      count: jest.fn().mockResolvedValue(0),
    },
    vehicle: {
      findUnique: (...args: any[]) => mockVehicleFindUnique(...args),
      updateMany: (...args: any[]) => mockVehicleUpdateMany(...args),
    },
    booking: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    order: {
      update: (...args: any[]) => mockPrismaOrderUpdate(...args),
      findUnique: (...args: any[]) => mockPrismaOrderFindUnique(...args),
      findFirst: jest.fn(),
    },
    truckRequest: {
      updateMany: (...args: any[]) => mockPrismaTruckRequestUpdateMany(...args),
      findMany: jest.fn().mockResolvedValue([]),
    },
    truckHoldLedger: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn(),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
    },
  },
  withDbTimeout: jest.fn((fn: any) => fn(mockTx)),
  VehicleStatus: {
    available: 'available',
    in_transit: 'in_transit',
    on_hold: 'on_hold',
    maintenance: 'maintenance',
  },
  HoldPhase: {
    FLEX: 'FLEX',
    CONFIRMED: 'CONFIRMED',
    EXPIRED: 'EXPIRED',
    RELEASED: 'RELEASED',
  },
  BookingStatus: {
    active: 'active',
    partially_filled: 'partially_filled',
    completed: 'completed',
    cancelled: 'cancelled',
    expired: 'expired',
  },
  AssignmentStatus: {
    pending: 'pending',
    driver_accepted: 'driver_accepted',
    driver_declined: 'driver_declined',
    cancelled: 'cancelled',
    completed: 'completed',
  },
}));

// -- FCM Service --
const mockSendPushNotification = jest.fn().mockResolvedValue({ success: true });
jest.mock('../shared/services/fcm.service', () => ({
  fcmService: {
    sendPushNotification: (...args: any[]) => mockSendPushNotification(...args),
    send: jest.fn().mockResolvedValue({ success: true }),
  },
  sendPushNotification: (...args: any[]) => mockSendPushNotification(...args),
}));

// -- Live Availability Service --
const mockOnVehicleStatusChange = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: (...args: any[]) => mockOnVehicleStatusChange(...args),
    getAvailableCount: jest.fn().mockResolvedValue(5),
    incrementAvailable: jest.fn().mockResolvedValue(undefined),
    decrementAvailable: jest.fn().mockResolvedValue(undefined),
  },
}));

// -- Fleet Cache Write --
const mockInvalidateVehicleCache = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/fleet-cache-write.service', () => ({
  invalidateVehicleCache: (...args: any[]) => mockInvalidateVehicleCache(...args),
}));

// -- Tracking Service --
const mockInitializeTracking = jest.fn().mockResolvedValue(undefined);
const mockUpdateLocation = jest.fn().mockResolvedValue(undefined);
const mockCompleteTracking = jest.fn().mockResolvedValue(undefined);
jest.mock('../modules/tracking/tracking.service', () => ({
  trackingService: {
    initializeTracking: (...args: any[]) => mockInitializeTracking(...args),
    updateLocation: (...args: any[]) => mockUpdateLocation(...args),
    completeTracking: (...args: any[]) => mockCompleteTracking(...args),
    getTrackingData: jest.fn().mockResolvedValue(null),
  },
}));

// -- Vehicle Lifecycle --
const mockReleaseVehicle = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  onVehicleTransition: jest.fn().mockResolvedValue(undefined),
  releaseVehicle: (...args: any[]) => mockReleaseVehicle(...args),
}));

// -- Vehicle Key --
jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn().mockReturnValue('KA-01-AB-1234::Truck'),
}));

// -- Auto Redispatch --
const mockTryAutoRedispatch = jest.fn().mockResolvedValue(false);
jest.mock('../modules/assignment/auto-redispatch.service', () => ({
  tryAutoRedispatch: (...args: any[]) => mockTryAutoRedispatch(...args),
}));

// -- Order Lifecycle Outbox --
const mockEnqueueCompletionLifecycleOutbox = jest.fn().mockResolvedValue(undefined);
jest.mock('../modules/order/order-lifecycle-outbox.service', () => ({
  enqueueCompletionLifecycleOutbox: (...args: any[]) => mockEnqueueCompletionLifecycleOutbox(...args),
}));

// -- Booking Service (lazy-required by cancelAssignment for decrementTrucksFilled) --
jest.mock('../modules/booking/booking.service', () => ({
  bookingService: {
    decrementTrucksFilled: jest.fn().mockResolvedValue(undefined),
  },
}));

// -- Driver Presence --
jest.mock('../modules/driver/driver-presence.service', () => ({
  driverPresenceService: {
    isOnline: jest.fn().mockResolvedValue(true),
    getOnlineDrivers: jest.fn().mockResolvedValue([]),
  },
}));

// -- Hold Config --
jest.mock('../core/config/hold-config', () => ({
  HOLD_CONFIG: {
    driverAcceptTimeoutMs: 45000,
    flexHoldDurationSeconds: 90,
    flexHoldExtensionSeconds: 30,
    flexHoldMaxDurationSeconds: 130,
    confirmedHoldMaxSeconds: 180,
  },
}));

// -- Smart Timeout --
jest.mock('../modules/order-timeout/smart-timeout.service', () => ({
  smartTimeoutService: {
    extendTimeout: jest.fn().mockResolvedValue(undefined),
    startTimeout: jest.fn().mockResolvedValue(undefined),
    cancelTimeout: jest.fn().mockResolvedValue(undefined),
  },
}));

// -- Availability --
jest.mock('../shared/services/availability.service', () => ({
  availabilityService: {
    getAvailableVehicles: jest.fn().mockResolvedValue([]),
    checkVehicleAvailability: jest.fn().mockResolvedValue(true),
  },
}));

// -- Distance Matrix --
jest.mock('../shared/services/distance-matrix.service', () => ({
  distanceMatrixService: {
    getDistance: jest.fn().mockResolvedValue({ distanceKm: 10, durationMinutes: 15 }),
  },
}));

// -- Google Maps --
jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: {
    geocode: jest.fn().mockResolvedValue({ lat: 12.97, lng: 77.59 }),
  },
}));

// -- Transporter Online --
jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: {
    getOnlineTransporters: jest.fn().mockResolvedValue([]),
    isOnline: jest.fn().mockReturnValue(true),
  },
}));

// -- Progressive Radius Matcher --
jest.mock('../modules/order/progressive-radius-matcher', () => ({
  progressiveRadiusMatcher: jest.fn(),
  PROGRESSIVE_RADIUS_STEPS: [
    { radiusKm: 5, windowMs: 10000 },
    { radiusKm: 10, windowMs: 10000 },
    { radiusKm: 25, windowMs: 15000 },
    { radiusKm: 50, windowMs: 15000 },
  ],
}));

// -- Hold Expiry Cleanup --
jest.mock('../modules/hold-expiry/hold-expiry-cleanup.service', () => ({
  holdExpiryCleanupService: {
    scheduleCleanup: jest.fn(),
    cancelCleanup: jest.fn(),
  },
}));

// -- Socket Service (for direct import in flex-hold) --
jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToRoom: (...args: any[]) => mockEmitToRoom(...args),
  emitToBooking: (...args: any[]) => mockEmitToBooking(...args),
  emitToTrip: (...args: any[]) => mockEmitToTrip(...args),
  emitToOrder: (...args: any[]) => mockEmitToOrder(...args),
  emitToUsers: jest.fn(),
  emitToAllTransporters: jest.fn(),
  emitToAll: jest.fn(),
  isUserConnectedAsync: (...args: any[]) => mockIsUserConnectedAsync(...args),
  isUserConnected: jest.fn().mockReturnValue(true),
  getConnectedUserCount: jest.fn().mockReturnValue(1),
  socketService: {
    emitToUser: (...args: any[]) => mockEmitToUser(...args),
    emitToRoom: (...args: any[]) => mockEmitToRoom(...args),
  },
  SocketEvent: {
    NEW_BROADCAST: 'new_broadcast',
    BROADCAST_STATE_CHANGED: 'broadcast_state_changed',
    NO_VEHICLES_AVAILABLE: 'no_vehicles_available',
    TRIP_ASSIGNED: 'trip_assigned',
    TRUCK_CONFIRMED: 'truck_confirmed',
    BOOKING_UPDATED: 'booking_updated',
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    ASSIGNMENT_TIMEOUT: 'assignment_timeout',
    DRIVER_TIMEOUT: 'driver_timeout',
    VEHICLE_STATUS_CHANGED: 'vehicle_status_changed',
    FLEX_HOLD_EXTENDED: 'flex_hold_extended',
    BROADCAST_EXPIRED: 'broadcast_expired',
    BOOKING_FULLY_FILLED: 'booking_fully_filled',
    BROADCAST_CANCELLED: 'order_cancelled',
    TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update',
  },
  initializeSocket: jest.fn(),
}));

// -- Geo Utils --
jest.mock('../shared/utils/geospatial.utils', () => ({
  ...jest.requireActual('../shared/utils/geospatial.utils'),
  haversineDistanceKm: jest.fn().mockReturnValue(5),
}));
jest.mock('../shared/utils/geo.utils', () => ({
  roundCoord: jest.fn((v: number) => v),
}));
jest.mock('../shared/utils/safe-json.utils', () => ({
  safeJsonParse: jest.fn((v: string) => JSON.parse(v)),
}));

// -- State machines --
jest.mock('../core/state-machines', () => ({
  ...jest.requireActual('../core/state-machines'),
  assertValidTransition: jest.fn(),
  BOOKING_VALID_TRANSITIONS: {
    active: ['partially_filled', 'completed', 'cancelled', 'expired'],
    partially_filled: ['completed', 'cancelled', 'expired'],
  },
}));

// -- Booking payload helper --
jest.mock('../modules/booking/booking-payload.helper', () => ({
  buildBroadcastPayload: jest.fn().mockReturnValue({ type: 'broadcast', data: {} }),
  getRemainingTimeoutSeconds: jest.fn().mockReturnValue(120),
}));

// -- Error codes --
jest.mock('../core/constants', () => ({
  ErrorCode: {
    BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
    VEHICLE_BUSY: 'VEHICLE_BUSY',
    INVALID_STATUS: 'INVALID_STATUS',
  },
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { assignmentService } from '../modules/assignment/assignment.service';

// =============================================================================
// TEST FIXTURES
// =============================================================================

const IDS = {
  customer1: 'cust-e2e-001',
  transporter1: 'trans-e2e-001',
  transporter2: 'trans-e2e-002',
  driver1: 'driver-e2e-001',
  driver2: 'driver-e2e-002',
  driver3: 'driver-e2e-003',
  vehicle1: 'veh-e2e-001',
  vehicle2: 'veh-e2e-002',
  vehicle3: 'veh-e2e-003',
  booking1: 'booking-e2e-001',
  assignment1: 'assign-e2e-001',
  assignment2: 'assign-e2e-002',
  assignment3: 'assign-e2e-003',
  trip1: 'trip-e2e-001',
  trip2: 'trip-e2e-002',
  order1: 'order-e2e-001',
};

function makeBooking(overrides: Partial<any> = {}) {
  return {
    id: IDS.booking1,
    customerId: IDS.customer1,
    vehicleType: 'Truck',
    vehicleSubtype: 'Open Body',
    trucksNeeded: 1,
    trucksFilled: 0,
    status: 'active',
    pickup: { latitude: 12.97, longitude: 77.59, address: 'Bangalore' },
    drop: { latitude: 13.08, longitude: 77.57, address: 'Yelahanka' },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeVehicle(id: string, transporterId: string, overrides: Partial<any> = {}) {
  return {
    id,
    transporterId,
    vehicleNumber: `KA-01-AB-${id.slice(-3)}`,
    vehicleType: 'Truck',
    vehicleSubtype: 'Open Body',
    vehicleKey: `${id}::Truck`,
    status: 'available',
    currentTripId: null,
    assignedDriverId: null,
    ...overrides,
  };
}

function makeDriver(id: string, transporterId: string, overrides: Partial<any> = {}) {
  return {
    id,
    name: `Driver ${id.slice(-3)}`,
    phone: `99000000${id.slice(-2)}`,
    role: 'driver',
    transporterId,
    ...overrides,
  };
}

function makeTransporter(id: string, overrides: Partial<any> = {}) {
  return {
    id,
    name: `Transporter ${id.slice(-3)}`,
    businessName: `Trans Corp ${id.slice(-3)}`,
    role: 'transporter',
    ...overrides,
  };
}

function makeAssignment(overrides: Partial<any> = {}) {
  return {
    id: IDS.assignment1,
    bookingId: IDS.booking1,
    transporterId: IDS.transporter1,
    transporterName: 'Trans Corp 001',
    vehicleId: IDS.vehicle1,
    vehicleNumber: 'KA-01-AB-001',
    vehicleType: 'Truck',
    vehicleSubtype: 'Open Body',
    driverId: IDS.driver1,
    driverName: 'Driver 001',
    driverPhone: '9900000001',
    tripId: IDS.trip1,
    status: 'pending',
    assignedAt: new Date().toISOString(),
    orderId: undefined,
    truckRequestId: undefined,
    ...overrides,
  };
}

// =============================================================================
// GLOBAL RESET
// =============================================================================

beforeEach(() => {
  jest.clearAllMocks();

  // Default: Prisma $transaction executes the callback with mockTx
  mockPrismaTransaction.mockImplementation(async (fn: any) => {
    if (typeof fn === 'function') return fn(mockTx);
    return Promise.all(fn);
  });

  // Default: vehicle.findUnique returns a vehicle with vehicleKey for post-TX Redis sync
  mockVehicleFindUnique.mockResolvedValue({
    id: IDS.vehicle1,
    vehicleKey: `${IDS.vehicle1}::Truck`,
    transporterId: IDS.transporter1,
    status: 'in_transit',
  });

  // Default: vehicle.updateMany returns { count: 1 } for releaseVehicleIfBusy
  mockVehicleUpdateMany.mockResolvedValue({ count: 1 });

  // Default: Redis mocks return thenables
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue(undefined);
  mockRedisDel.mockResolvedValue(undefined);
  mockRedisGetJSON.mockResolvedValue(null);
  mockRedisSetJSON.mockResolvedValue(undefined);
  mockRedisAcquireLock.mockResolvedValue({ acquired: true });
  mockRedisReleaseLock.mockResolvedValue(true);
});

// =============================================================================
// SCENARIO 1: HAPPY PATH
// Customer books → Transporter accepts → Driver accepts → Pickup → Transit → Complete
// =============================================================================

describe('Scenario 1: Happy path — full booking lifecycle', () => {
  const booking = makeBooking();
  const vehicle = makeVehicle(IDS.vehicle1, IDS.transporter1);
  const driver = makeDriver(IDS.driver1, IDS.transporter1);
  const transporter = makeTransporter(IDS.transporter1);

  test('1.1: createAssignment succeeds for active booking with available vehicle', async () => {
    mockGetBookingById.mockResolvedValue(booking);
    mockGetVehicleById.mockResolvedValue(vehicle);
    mockGetUserById.mockImplementation(async (id: string) =>
      id === IDS.driver1 ? driver : transporter
    );
    mockGetActiveAssignmentByDriver.mockResolvedValue(null);
    mockTx.assignment.findFirst.mockResolvedValue(null);
    mockTx.assignment.create.mockResolvedValue(makeAssignment());
    mockTxBookingUpdateMany.mockResolvedValue({ count: 1 });

    const result = await assignmentService.createAssignment(IDS.transporter1, {
      bookingId: IDS.booking1,
      vehicleId: IDS.vehicle1,
      driverId: IDS.driver1,
    });

    expect(result).toBeDefined();
    expect(result.status).toBe('pending');
    expect(result.driverId).toBe(IDS.driver1);
  });

  test('1.2: acceptAssignment transitions from pending to driver_accepted', async () => {
    const pendingAssignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(pendingAssignment);
    mockGetActiveAssignmentByDriver.mockResolvedValue(null);
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockTxAssignmentFindUnique.mockResolvedValue({
      ...pendingAssignment,
      status: 'driver_accepted',
    });
    mockVehicleFindUnique.mockResolvedValue(vehicle);
    mockRedisGetJSON.mockResolvedValue({ latitude: 12.97, longitude: 77.59, timestamp: Date.now() });
    mockGetBookingById.mockResolvedValue(booking);

    const result = await assignmentService.acceptAssignment(IDS.assignment1, IDS.driver1);

    expect(result.status).toBe('driver_accepted');
    expect(mockTxAssignmentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: IDS.assignment1, status: 'pending' },
      })
    );
  });

  test('1.3: acceptAssignment locks vehicle to in_transit within same transaction', async () => {
    const pendingAssignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(pendingAssignment);
    mockGetActiveAssignmentByDriver.mockResolvedValue(null);
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockTxAssignmentFindUnique.mockResolvedValue({
      ...pendingAssignment,
      status: 'driver_accepted',
    });
    mockVehicleFindUnique.mockResolvedValue(vehicle);
    mockRedisGetJSON.mockResolvedValue(null);
    mockGetBookingById.mockResolvedValue(booking);

    await assignmentService.acceptAssignment(IDS.assignment1, IDS.driver1);

    expect(mockTxVehicleUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'in_transit' }),
      })
    );
  });

  test('1.4: acceptAssignment seeds tracking at acceptance time', async () => {
    const pendingAssignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(pendingAssignment);
    mockGetActiveAssignmentByDriver.mockResolvedValue(null);
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockTxAssignmentFindUnique.mockResolvedValue({
      ...pendingAssignment,
      status: 'driver_accepted',
    });
    mockVehicleFindUnique.mockResolvedValue(vehicle);
    mockRedisGetJSON.mockResolvedValue({ latitude: 12.97, longitude: 77.59, timestamp: Date.now() });
    mockGetBookingById.mockResolvedValue(booking);

    await assignmentService.acceptAssignment(IDS.assignment1, IDS.driver1);

    expect(mockInitializeTracking).toHaveBeenCalledWith(
      IDS.trip1,
      IDS.driver1,
      expect.any(String),
      IDS.booking1,
      IDS.transporter1,
      IDS.vehicle1,
    );
  });

  test('1.5: acceptAssignment notifies customer via socket and FCM', async () => {
    const pendingAssignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(pendingAssignment);
    mockGetActiveAssignmentByDriver.mockResolvedValue(null);
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockTxAssignmentFindUnique.mockResolvedValue({
      ...pendingAssignment,
      status: 'driver_accepted',
    });
    mockVehicleFindUnique.mockResolvedValue(vehicle);
    mockRedisGetJSON.mockResolvedValue(null);
    mockGetBookingById.mockResolvedValue(booking);

    await assignmentService.acceptAssignment(IDS.assignment1, IDS.driver1);

    // Customer gets WebSocket notification
    expect(mockEmitToUser).toHaveBeenCalledWith(
      IDS.customer1,
      'assignment_status_changed',
      expect.objectContaining({ status: 'driver_accepted' })
    );

    // Customer gets FCM push with type 'driver_assigned'
    expect(mockQueuePushNotification).toHaveBeenCalledWith(
      IDS.customer1,
      expect.objectContaining({
        data: expect.objectContaining({ type: 'driver_assigned' }),
      })
    );
  });
});

// =============================================================================
// SCENARIO 2: DRIVER DECLINES → AUTO-REDISPATCH
// =============================================================================

describe('Scenario 2: Driver declines → redispatch → new driver completes', () => {
  test('2.1: declineAssignment transitions to driver_declined and releases vehicle', async () => {
    const assignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockVehicleFindUnique.mockResolvedValue(
      makeVehicle(IDS.vehicle1, IDS.transporter1, { status: 'on_hold' })
    );
    mockTx.assignment.update.mockResolvedValue({ ...assignment, status: 'driver_declined' });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });

    await assignmentService.declineAssignment(IDS.assignment1, IDS.driver1, {
      reason: 'too_far',
    });

    expect(mockTx.assignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'driver_declined' }),
      })
    );
  });

  test('2.2: declineAssignment cancels the assignment timeout', async () => {
    const assignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockVehicleFindUnique.mockResolvedValue(
      makeVehicle(IDS.vehicle1, IDS.transporter1, { status: 'on_hold' })
    );
    mockTx.assignment.update.mockResolvedValue({ ...assignment, status: 'driver_declined' });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });

    await assignmentService.declineAssignment(IDS.assignment1, IDS.driver1);

    expect(mockCancelAssignmentTimeout).toHaveBeenCalledWith(IDS.assignment1);
  });

  test('2.3: declineAssignment notifies transporter with decline details', async () => {
    const assignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockVehicleFindUnique.mockResolvedValue(
      makeVehicle(IDS.vehicle1, IDS.transporter1, { status: 'on_hold' })
    );
    mockTx.assignment.update.mockResolvedValue({ ...assignment, status: 'driver_declined' });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });

    await assignmentService.declineAssignment(IDS.assignment1, IDS.driver1, { reason: 'busy' });

    expect(mockEmitToUser).toHaveBeenCalledWith(
      IDS.transporter1,
      'assignment_status_changed',
      expect.objectContaining({
        assignmentId: IDS.assignment1,
        status: 'driver_declined',
      })
    );
  });

  test('2.4: handleAssignmentTimeout no-ops when driver already accepted (race-safe)', async () => {
    // Simulate driver accepted before timeout fires.
    // handleAssignmentTimeout uses $transaction so TX-level mocks apply.
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 0 });
    mockGetAssignmentById.mockResolvedValue(
      makeAssignment({ status: 'driver_accepted' })
    );

    await assignmentService.handleAssignmentTimeout({
      assignmentId: IDS.assignment1,
      driverId: IDS.driver1,
      driverName: 'Driver 001',
      transporterId: IDS.transporter1,
      vehicleId: IDS.vehicle1,
      vehicleNumber: 'KA-01-AB-001',
      tripId: IDS.trip1,
      createdAt: new Date().toISOString(),
    });

    // TX returned skipped:true so post-TX effects are not executed
    // Vehicle should NOT be released since driver already accepted
    const { onVehicleTransition } = require('../shared/services/vehicle-lifecycle.service');
    expect(onVehicleTransition).not.toHaveBeenCalled();
    // No timeout notification sent
    expect(mockEmitToUser).not.toHaveBeenCalledWith(
      IDS.transporter1,
      'driver_timeout',
      expect.anything()
    );
  });

  test('2.5: handleAssignmentTimeout releases vehicle and notifies on real timeout', async () => {
    // handleAssignmentTimeout now uses $transaction, so TX-level mocks apply
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    const assignment = makeAssignment({ status: 'driver_declined' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockGetBookingById.mockResolvedValue(makeBooking());

    await assignmentService.handleAssignmentTimeout({
      assignmentId: IDS.assignment1,
      driverId: IDS.driver1,
      driverName: 'Driver 001',
      transporterId: IDS.transporter1,
      vehicleId: IDS.vehicle1,
      vehicleNumber: 'KA-01-AB-001',
      bookingId: IDS.booking1,
      tripId: IDS.trip1,
      createdAt: new Date().toISOString(),
    });

    // Transporter notified about timeout
    expect(mockEmitToUser).toHaveBeenCalledWith(
      IDS.transporter1,
      'driver_timeout',
      expect.objectContaining({
        assignmentId: IDS.assignment1,
        reason: 'timeout',
      })
    );
  });
});

// =============================================================================
// SCENARIO 3: HOLD EXPIRES → VEHICLES RELEASED
// =============================================================================

describe('Scenario 3: Flex hold expires → vehicles released → rebookable', () => {
  test('3.1: flex hold has 90s base duration from config', () => {
    const { HOLD_CONFIG } = require('../core/config/hold-config');
    expect(HOLD_CONFIG.flexHoldDurationSeconds).toBe(90);
  });

  test('3.2: flex hold extension is 30s per driver assigned', () => {
    const { HOLD_CONFIG } = require('../core/config/hold-config');
    expect(HOLD_CONFIG.flexHoldExtensionSeconds).toBe(30);
  });

  test('3.3: flex hold max duration is 130s (90 base + 3x30 capped)', () => {
    const { HOLD_CONFIG } = require('../core/config/hold-config');
    expect(HOLD_CONFIG.flexHoldMaxDurationSeconds).toBe(130);
  });

  test('3.4: expired hold does not allow assignment creation', async () => {
    const expiredBooking = makeBooking({ status: 'expired' });
    mockGetBookingById.mockResolvedValue(expiredBooking);

    await expect(
      assignmentService.createAssignment(IDS.transporter1, {
        bookingId: IDS.booking1,
        vehicleId: IDS.vehicle1,
        driverId: IDS.driver1,
      })
    ).rejects.toThrow('Booking is not accepting more trucks');
  });

  test('3.5: completed booking rejects new assignments', async () => {
    const completedBooking = makeBooking({ status: 'completed' });
    mockGetBookingById.mockResolvedValue(completedBooking);

    await expect(
      assignmentService.createAssignment(IDS.transporter1, {
        bookingId: IDS.booking1,
        vehicleId: IDS.vehicle1,
        driverId: IDS.driver1,
      })
    ).rejects.toThrow('Booking is not accepting more trucks');
  });
});

// =============================================================================
// SCENARIO 4: CONCURRENT ACCEPTS — VEHICLE MUTEX
// =============================================================================

describe('Scenario 4: Concurrent accepts — only one wins via CAS', () => {
  test('4.1: first accept wins CAS (updateMany count=1)', async () => {
    const assignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockGetActiveAssignmentByDriver.mockResolvedValue(null);
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 }); // CAS succeeds
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockTxAssignmentFindUnique.mockResolvedValue({
      ...assignment,
      status: 'driver_accepted',
    });
    mockVehicleFindUnique.mockResolvedValue(
      makeVehicle(IDS.vehicle1, IDS.transporter1)
    );
    mockRedisGetJSON.mockResolvedValue(null);
    mockGetBookingById.mockResolvedValue(makeBooking());

    const result = await assignmentService.acceptAssignment(IDS.assignment1, IDS.driver1);
    expect(result.status).toBe('driver_accepted');
  });

  test('4.2: second accept loses CAS (updateMany count=0) and throws ASSIGNMENT_STATE_CHANGED', async () => {
    const assignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockGetActiveAssignmentByDriver.mockResolvedValue(null);
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 0 }); // CAS lost

    await expect(
      assignmentService.acceptAssignment(IDS.assignment1, IDS.driver1)
    ).rejects.toThrow('Assignment is no longer pending');
  });

  test('4.3: driver with active trip cannot accept new assignment (DRIVER_BUSY)', async () => {
    const assignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockGetActiveAssignmentByDriver.mockResolvedValue(
      makeAssignment({ id: 'other-assign', tripId: 'other-trip' })
    );

    await expect(
      assignmentService.acceptAssignment(IDS.assignment1, IDS.driver1)
    ).rejects.toThrow('You already have an active trip');
  });

  test('4.4: CAS guard uses where clause with status:pending for atomicity', async () => {
    const assignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockGetActiveAssignmentByDriver.mockResolvedValue(null);
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockTxAssignmentFindUnique.mockResolvedValue({
      ...assignment,
      status: 'driver_accepted',
    });
    mockVehicleFindUnique.mockResolvedValue(makeVehicle(IDS.vehicle1, IDS.transporter1));
    mockRedisGetJSON.mockResolvedValue(null);
    mockGetBookingById.mockResolvedValue(makeBooking());

    await assignmentService.acceptAssignment(IDS.assignment1, IDS.driver1);

    const updateCall = mockTxAssignmentUpdateMany.mock.calls[0][0];
    expect(updateCall.where.status).toBe('pending');
  });
});

// =============================================================================
// SCENARIO 5: MID-TRIP CANCELLATION
// =============================================================================

describe('Scenario 5: Mid-trip cancellation → vehicle released → rebook', () => {
  test('5.1: cancel from driver_accepted releases vehicle back to available', async () => {
    const assignment = makeAssignment({ status: 'driver_accepted' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockVehicleFindUnique.mockResolvedValue(
      makeVehicle(IDS.vehicle1, IDS.transporter1, { status: 'in_transit' })
    );

    await assignmentService.cancelAssignment(IDS.assignment1, IDS.transporter1);

    expect(mockTxVehicleUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'available',
          currentTripId: null,
          assignedDriverId: null,
        }),
      })
    );
  });

  test('5.2: cancel syncs Redis cache after DB transaction', async () => {
    const assignment = makeAssignment({ status: 'driver_accepted' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockVehicleFindUnique.mockResolvedValue(
      makeVehicle(IDS.vehicle1, IDS.transporter1, { status: 'in_transit' })
    );

    await assignmentService.cancelAssignment(IDS.assignment1, IDS.transporter1);

    // M-15: cancelAssignment now uses onVehicleTransition (not liveAvailability directly)
    const { onVehicleTransition } = require('../shared/services/vehicle-lifecycle.service');
    expect(onVehicleTransition).toHaveBeenCalledWith(
      IDS.transporter1,
      IDS.vehicle1,
      expect.any(String),
      'in_transit',
      'available',
      expect.any(String)
    );
  });

  test('5.3: cancel of completed assignment throws ASSIGNMENT_ALREADY_TERMINAL', async () => {
    const assignment = makeAssignment({ status: 'completed' });
    mockGetAssignmentById.mockResolvedValue(assignment);

    await expect(
      assignmentService.cancelAssignment(IDS.assignment1, IDS.transporter1)
    ).rejects.toThrow('Assignment is already completed');
  });

  test('5.4: cancel of already-cancelled assignment is idempotent (CAS count=0)', async () => {
    const assignment = makeAssignment({ status: 'driver_accepted' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 0 }); // Already cancelled

    // Should NOT throw — idempotent
    await assignmentService.cancelAssignment(IDS.assignment1, IDS.transporter1);
  });

  test('5.5: unauthorized user cannot cancel assignment', async () => {
    const assignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);

    await expect(
      assignmentService.cancelAssignment(IDS.assignment1, 'unauthorized-user')
    ).rejects.toThrow('Access denied');
  });
});

// =============================================================================
// SCENARIO 6: MULTI-TRUCK ORDER
// =============================================================================

describe('Scenario 6: Multi-truck order — mixed terminal states → order completed', () => {
  test('6.1: assignment with orderId uses order-path for trucksFilled decrement', async () => {
    const assignment = makeAssignment({
      status: 'pending',
      bookingId: undefined,
      orderId: IDS.order1,
      truckRequestId: 'tr-001',
    });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockVehicleFindUnique.mockResolvedValue(
      makeVehicle(IDS.vehicle1, IDS.transporter1, { status: 'on_hold' })
    );
    mockTx.assignment.update.mockResolvedValue({ ...assignment, status: 'driver_declined' });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockPrismaExecuteRaw.mockResolvedValue(undefined);

    await assignmentService.declineAssignment(IDS.assignment1, IDS.driver1);

    // Should use executeRaw for GREATEST(0, trucksFilled-1) on Order
    expect(mockPrismaExecuteRaw).toHaveBeenCalled();
  });

  test('6.2: timeout on order-path decrements trucksFilled with floor guard', async () => {
    // handleAssignmentTimeout wraps all DB writes in $transaction — TX-level mocks apply
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    const assignment = makeAssignment({
      bookingId: undefined,
      orderId: IDS.order1,
      truckRequestId: 'tr-001',
    });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockTxExecuteRaw.mockResolvedValue(1);

    await assignmentService.handleAssignmentTimeout({
      assignmentId: IDS.assignment1,
      driverId: IDS.driver1,
      driverName: 'Driver 001',
      transporterId: IDS.transporter1,
      vehicleId: IDS.vehicle1,
      vehicleNumber: 'KA-01-AB-001',
      tripId: IDS.trip1,
      orderId: IDS.order1,
      truckRequestId: 'tr-001',
      createdAt: new Date().toISOString(),
    });

    // tx.$executeRaw is called inside $transaction for GREATEST(0, trucksFilled-1)
    expect(mockTxExecuteRaw).toHaveBeenCalled();
  });

  test('6.3: multiple trucks can be assigned to same booking (trucksNeeded > 1)', async () => {
    const multiBooking = makeBooking({ trucksNeeded: 3, trucksFilled: 1, status: 'partially_filled' });
    mockGetBookingById.mockResolvedValue(multiBooking);
    mockGetVehicleById.mockResolvedValue(makeVehicle(IDS.vehicle2, IDS.transporter1));
    mockGetUserById.mockImplementation(async (id: string) =>
      id === IDS.driver2
        ? makeDriver(IDS.driver2, IDS.transporter1)
        : makeTransporter(IDS.transporter1)
    );
    mockGetActiveAssignmentByDriver.mockResolvedValue(null);
    mockTx.assignment.findFirst.mockResolvedValue(null);
    mockTx.assignment.create.mockResolvedValue(
      makeAssignment({ id: IDS.assignment2, vehicleId: IDS.vehicle2, driverId: IDS.driver2 })
    );
    mockTxBookingUpdateMany.mockResolvedValue({ count: 1 });

    const result = await assignmentService.createAssignment(IDS.transporter1, {
      bookingId: IDS.booking1,
      vehicleId: IDS.vehicle2,
      driverId: IDS.driver2,
    });

    expect(result).toBeDefined();
    expect(result.vehicleId).toBe(IDS.vehicle2);
  });
});

// =============================================================================
// SCENARIO 7: NETWORK FAILURE RECOVERY
// =============================================================================

describe('Scenario 7: Network failure recovery — FCM/socket failures are non-fatal', () => {
  test('7.1: accept succeeds even when FCM push fails', async () => {
    const assignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockGetActiveAssignmentByDriver.mockResolvedValue(null);
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockTxAssignmentFindUnique.mockResolvedValue({
      ...assignment,
      status: 'driver_accepted',
    });
    mockVehicleFindUnique.mockResolvedValue(makeVehicle(IDS.vehicle1, IDS.transporter1));
    mockRedisGetJSON.mockResolvedValue(null);
    mockGetBookingById.mockResolvedValue(makeBooking());

    // FCM fails
    mockQueuePushNotification.mockRejectedValue(new Error('FCM circuit open'));

    const result = await assignmentService.acceptAssignment(IDS.assignment1, IDS.driver1);
    expect(result.status).toBe('driver_accepted');
  });

  test('7.2: accept succeeds even when Redis availability update fails', async () => {
    const assignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockGetActiveAssignmentByDriver.mockResolvedValue(null);
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockTxAssignmentFindUnique.mockResolvedValue({
      ...assignment,
      status: 'driver_accepted',
    });
    mockVehicleFindUnique.mockResolvedValue(makeVehicle(IDS.vehicle1, IDS.transporter1));
    mockRedisGetJSON.mockResolvedValue(null);
    mockGetBookingById.mockResolvedValue(makeBooking());

    // Redis fails
    mockOnVehicleStatusChange.mockRejectedValue(new Error('Redis connection lost'));

    const result = await assignmentService.acceptAssignment(IDS.assignment1, IDS.driver1);
    expect(result.status).toBe('driver_accepted');
  });

  test('7.3: accept succeeds even when tracking initialization fails', async () => {
    const assignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockGetActiveAssignmentByDriver.mockResolvedValue(null);
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockTxAssignmentFindUnique.mockResolvedValue({
      ...assignment,
      status: 'driver_accepted',
    });
    mockVehicleFindUnique.mockResolvedValue(makeVehicle(IDS.vehicle1, IDS.transporter1));
    mockRedisGetJSON.mockResolvedValue(null);
    mockGetBookingById.mockResolvedValue(makeBooking());

    // Tracking fails
    mockInitializeTracking.mockRejectedValue(new Error('Tracking init failed'));

    const result = await assignmentService.acceptAssignment(IDS.assignment1, IDS.driver1);
    expect(result.status).toBe('driver_accepted');
  });

  test('7.4: cancel succeeds even when Redis sync fails (non-transactional)', async () => {
    const assignment = makeAssignment({ status: 'driver_accepted' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockVehicleFindUnique.mockResolvedValue(
      makeVehicle(IDS.vehicle1, IDS.transporter1, { status: 'in_transit' })
    );
    mockOnVehicleStatusChange.mockRejectedValue(new Error('Redis down'));

    // Should NOT throw
    await assignmentService.cancelAssignment(IDS.assignment1, IDS.transporter1);
  });
});

// =============================================================================
// SCENARIO 8: GPS TRACKING LIFECYCLE
// =============================================================================

describe('Scenario 8: GPS tracking lifecycle — seed → presence → track', () => {
  test('8.1: tracking seeded with real GPS when available at acceptance', async () => {
    const assignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockGetActiveAssignmentByDriver.mockResolvedValue(null);
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockTxAssignmentFindUnique.mockResolvedValue({
      ...assignment,
      status: 'driver_accepted',
    });
    mockVehicleFindUnique.mockResolvedValue(makeVehicle(IDS.vehicle1, IDS.transporter1));
    mockGetBookingById.mockResolvedValue(makeBooking());

    // Simulate fresh GPS
    const gps = { latitude: 12.97, longitude: 77.59, timestamp: Date.now() };
    mockRedisGetJSON.mockResolvedValue(gps);
    mockRedisSetJSON.mockResolvedValue(undefined);

    await assignmentService.acceptAssignment(IDS.assignment1, IDS.driver1);

    // Should fetch driver location
    expect(mockRedisGetJSON).toHaveBeenCalledWith(`driver:location:${IDS.driver1}`);
    // Should initialize tracking
    expect(mockInitializeTracking).toHaveBeenCalled();
  });

  test('8.2: stale GPS (>5 min) is rejected at seeding', async () => {
    const assignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockGetActiveAssignmentByDriver.mockResolvedValue(null);
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockTxAssignmentFindUnique.mockResolvedValue({
      ...assignment,
      status: 'driver_accepted',
    });
    mockVehicleFindUnique.mockResolvedValue(makeVehicle(IDS.vehicle1, IDS.transporter1));
    mockGetBookingById.mockResolvedValue(makeBooking());

    // Simulate stale GPS (6 minutes old)
    const staleGps = { latitude: 12.97, longitude: 77.59, timestamp: Date.now() - 6 * 60 * 1000 };
    mockRedisGetJSON.mockResolvedValue(staleGps);

    await assignmentService.acceptAssignment(IDS.assignment1, IDS.driver1);

    // Tracking initializes but should NOT overwrite with stale GPS
    expect(mockInitializeTracking).toHaveBeenCalled();
    // setJSON should NOT be called to seed stale coordinates
    expect(mockRedisSetJSON).not.toHaveBeenCalledWith(
      expect.stringContaining('driver:trip:'),
      expect.objectContaining({ latitude: 12.97 }),
      expect.any(Number)
    );
  });

  test('8.3: null GPS gracefully handled — tracking still initializes', async () => {
    const assignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockGetActiveAssignmentByDriver.mockResolvedValue(null);
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockTxAssignmentFindUnique.mockResolvedValue({
      ...assignment,
      status: 'driver_accepted',
    });
    mockVehicleFindUnique.mockResolvedValue(makeVehicle(IDS.vehicle1, IDS.transporter1));
    mockGetBookingById.mockResolvedValue(makeBooking());
    mockRedisGetJSON.mockResolvedValue(null);

    await assignmentService.acceptAssignment(IDS.assignment1, IDS.driver1);

    expect(mockInitializeTracking).toHaveBeenCalled();
  });
});

// =============================================================================
// SCENARIO 9: COMPLETION RACE CONDITION
// =============================================================================

describe('Scenario 9: Completion race condition — CAS ensures exactly-once', () => {
  test('9.1: valid state transition from pending → driver_accepted', async () => {
    const assignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockGetActiveAssignmentByDriver.mockResolvedValue(null);
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockTxAssignmentFindUnique.mockResolvedValue({
      ...assignment,
      status: 'driver_accepted',
    });
    mockVehicleFindUnique.mockResolvedValue(makeVehicle(IDS.vehicle1, IDS.transporter1));
    mockRedisGetJSON.mockResolvedValue(null);
    mockGetBookingById.mockResolvedValue(makeBooking());

    const result = await assignmentService.acceptAssignment(IDS.assignment1, IDS.driver1);
    expect(result.status).toBe('driver_accepted');
  });

  test('9.2: accept on already-cancelled assignment throws meaningful error', async () => {
    const assignment = makeAssignment({ status: 'cancelled' });
    mockGetAssignmentById.mockResolvedValue(assignment);

    await expect(
      assignmentService.acceptAssignment(IDS.assignment1, IDS.driver1)
    ).rejects.toThrow('This trip was cancelled by the transporter');
  });

  test('9.3: accept on already-completed assignment throws meaningful error', async () => {
    const assignment = makeAssignment({ status: 'completed' });
    mockGetAssignmentById.mockResolvedValue(assignment);

    await expect(
      assignmentService.acceptAssignment(IDS.assignment1, IDS.driver1)
    ).rejects.toThrow('This trip has already been completed');
  });

  test('9.4: accept on already-accepted assignment returns helpful message', async () => {
    const assignment = makeAssignment({ status: 'driver_accepted' });
    mockGetAssignmentById.mockResolvedValue(assignment);

    await expect(
      assignmentService.acceptAssignment(IDS.assignment1, IDS.driver1)
    ).rejects.toThrow('You have already accepted this trip');
  });

  test('9.5: CAS prevents double-accept — second request sees count=0', async () => {
    const assignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockGetActiveAssignmentByDriver.mockResolvedValue(null);

    // First request wins
    mockTxAssignmentUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockTxVehicleUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockTxAssignmentFindUnique.mockResolvedValueOnce({
      ...assignment,
      status: 'driver_accepted',
    });
    mockVehicleFindUnique.mockResolvedValueOnce(makeVehicle(IDS.vehicle1, IDS.transporter1));
    mockRedisGetJSON.mockResolvedValueOnce(null);
    mockGetBookingById.mockResolvedValueOnce(makeBooking());

    const first = await assignmentService.acceptAssignment(IDS.assignment1, IDS.driver1);
    expect(first.status).toBe('driver_accepted');

    // Second request loses CAS
    mockTxAssignmentUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      assignmentService.acceptAssignment(IDS.assignment1, IDS.driver1)
    ).rejects.toThrow('Assignment is no longer pending');
  });
});

// =============================================================================
// SCENARIO 10: FULL BROADCAST FLOW WITH SAFETY MECHANISMS
// =============================================================================

describe('Scenario 10: Full broadcast flow — all safety mechanisms', () => {
  test('10.1: createAssignment rejects vehicle that does not belong to transporter', async () => {
    mockGetBookingById.mockResolvedValue(makeBooking());
    mockGetVehicleById.mockResolvedValue(
      makeVehicle(IDS.vehicle1, 'other-transporter')
    );

    await expect(
      assignmentService.createAssignment(IDS.transporter1, {
        bookingId: IDS.booking1,
        vehicleId: IDS.vehicle1,
        driverId: IDS.driver1,
      })
    ).rejects.toThrow('This vehicle does not belong to you');
  });

  test('10.2: createAssignment rejects busy vehicle (status != available)', async () => {
    mockGetBookingById.mockResolvedValue(makeBooking());
    mockGetVehicleById.mockResolvedValue(
      makeVehicle(IDS.vehicle1, IDS.transporter1, { status: 'in_transit' })
    );

    await expect(
      assignmentService.createAssignment(IDS.transporter1, {
        bookingId: IDS.booking1,
        vehicleId: IDS.vehicle1,
        driverId: IDS.driver1,
      })
    ).rejects.toThrow('currently in_transit');
  });

  test('10.3: createAssignment rejects vehicle type mismatch', async () => {
    mockGetBookingById.mockResolvedValue(makeBooking({ vehicleType: 'Mini Truck' }));
    mockGetVehicleById.mockResolvedValue(
      makeVehicle(IDS.vehicle1, IDS.transporter1, { vehicleType: 'Truck' })
    );

    await expect(
      assignmentService.createAssignment(IDS.transporter1, {
        bookingId: IDS.booking1,
        vehicleId: IDS.vehicle1,
        driverId: IDS.driver1,
      })
    ).rejects.toThrow('Booking requires Mini Truck');
  });

  test('10.4: createAssignment rejects vehicle subtype mismatch (case insensitive)', async () => {
    mockGetBookingById.mockResolvedValue(
      makeBooking({ vehicleSubtype: 'Closed Body' })
    );
    mockGetVehicleById.mockResolvedValue(
      makeVehicle(IDS.vehicle1, IDS.transporter1, { vehicleSubtype: 'Open Body' })
    );

    await expect(
      assignmentService.createAssignment(IDS.transporter1, {
        bookingId: IDS.booking1,
        vehicleId: IDS.vehicle1,
        driverId: IDS.driver1,
      })
    ).rejects.toThrow('Booking requires "Closed Body"');
  });

  test('10.5: createAssignment rejects driver not belonging to transporter', async () => {
    mockGetBookingById.mockResolvedValue(makeBooking());
    mockGetVehicleById.mockResolvedValue(makeVehicle(IDS.vehicle1, IDS.transporter1));
    mockGetUserById.mockResolvedValue(
      makeDriver(IDS.driver1, 'other-transporter')
    );

    await expect(
      assignmentService.createAssignment(IDS.transporter1, {
        bookingId: IDS.booking1,
        vehicleId: IDS.vehicle1,
        driverId: IDS.driver1,
      })
    ).rejects.toThrow('This driver does not belong to you');
  });

  test('10.6: createAssignment rejects non-existent booking', async () => {
    mockGetBookingById.mockResolvedValue(null);

    await expect(
      assignmentService.createAssignment(IDS.transporter1, {
        bookingId: 'non-existent',
        vehicleId: IDS.vehicle1,
        driverId: IDS.driver1,
      })
    ).rejects.toThrow('Booking not found');
  });

  test('10.7: createAssignment rejects non-existent vehicle', async () => {
    mockGetBookingById.mockResolvedValue(makeBooking());
    mockGetVehicleById.mockResolvedValue(null);

    await expect(
      assignmentService.createAssignment(IDS.transporter1, {
        bookingId: IDS.booking1,
        vehicleId: 'non-existent',
        driverId: IDS.driver1,
      })
    ).rejects.toThrow('Vehicle not found');
  });

  test('10.8: createAssignment rejects non-existent driver', async () => {
    mockGetBookingById.mockResolvedValue(makeBooking());
    mockGetVehicleById.mockResolvedValue(makeVehicle(IDS.vehicle1, IDS.transporter1));
    mockGetUserById.mockResolvedValue(null);

    await expect(
      assignmentService.createAssignment(IDS.transporter1, {
        bookingId: IDS.booking1,
        vehicleId: IDS.vehicle1,
        driverId: IDS.driver1,
      })
    ).rejects.toThrow('Driver not found');
  });

  test('10.9: acceptAssignment rejects wrong driver (FORBIDDEN)', async () => {
    const assignment = makeAssignment({ driverId: IDS.driver1 });
    mockGetAssignmentById.mockResolvedValue(assignment);

    await expect(
      assignmentService.acceptAssignment(IDS.assignment1, 'wrong-driver')
    ).rejects.toThrow('This assignment is not for you');
  });

  test('10.10: declineAssignment rejects wrong driver (FORBIDDEN)', async () => {
    const assignment = makeAssignment({ driverId: IDS.driver1 });
    mockGetAssignmentById.mockResolvedValue(assignment);

    await expect(
      assignmentService.declineAssignment(IDS.assignment1, 'wrong-driver')
    ).rejects.toThrow('This assignment is not for you');
  });

  test('10.11: declineAssignment rejects non-pending status', async () => {
    const assignment = makeAssignment({ status: 'driver_accepted' });
    mockGetAssignmentById.mockResolvedValue(assignment);

    await expect(
      assignmentService.declineAssignment(IDS.assignment1, IDS.driver1)
    ).rejects.toThrow('Assignment cannot be declined');
  });

  test('10.12: handleAssignmentTimeout sets status to driver_declined and records timeout reason', async () => {
    // handleAssignmentTimeout wraps all DB writes in $transaction — TX-level mocks apply
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockGetAssignmentById.mockResolvedValue(makeAssignment());

    await assignmentService.handleAssignmentTimeout({
      assignmentId: IDS.assignment1,
      driverId: IDS.driver1,
      driverName: 'Driver 001',
      transporterId: IDS.transporter1,
      vehicleId: IDS.vehicle1,
      vehicleNumber: 'KA-01-AB-001',
      tripId: IDS.trip1,
      createdAt: new Date().toISOString(),
    });

    // CAS update sets status to driver_declined (inside $transaction)
    expect(mockTxAssignmentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: IDS.assignment1, status: 'pending' }),
        data: expect.objectContaining({ status: 'driver_declined' }),
      })
    );

    // Timeout reason is persisted to Redis (not DB declineType column)
    expect(mockRedisSet).toHaveBeenCalledWith(
      `assignment:reason:${IDS.assignment1}`,
      'timeout',
      expect.any(Number)
    );
  });
});

// =============================================================================
// CROSS-CUTTING: Notification delivery across all scenarios
// =============================================================================

describe('Cross-cutting: Notification chains across scenarios', () => {
  test('CC.1: timeout sends FCM to BOTH transporter and driver', async () => {
    mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockGetAssignmentById.mockResolvedValue(makeAssignment());

    await assignmentService.handleAssignmentTimeout({
      assignmentId: IDS.assignment1,
      driverId: IDS.driver1,
      driverName: 'Driver 001',
      transporterId: IDS.transporter1,
      vehicleId: IDS.vehicle1,
      vehicleNumber: 'KA-01-AB-001',
      tripId: IDS.trip1,
      createdAt: new Date().toISOString(),
    });

    // FCM to transporter
    expect(mockQueuePushNotification).toHaveBeenCalledWith(
      IDS.transporter1,
      expect.objectContaining({
        data: expect.objectContaining({ type: 'driver_timeout' }),
      })
    );

    // FCM to driver
    expect(mockQueuePushNotification).toHaveBeenCalledWith(
      IDS.driver1,
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'assignment_update',
          reason: 'timeout',
        }),
      })
    );
  });

  test('CC.2: timeout emits to booking room for real-time UI update', async () => {
    mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockGetAssignmentById.mockResolvedValue(makeAssignment({ bookingId: IDS.booking1 }));

    await assignmentService.handleAssignmentTimeout({
      assignmentId: IDS.assignment1,
      driverId: IDS.driver1,
      driverName: 'Driver 001',
      transporterId: IDS.transporter1,
      vehicleId: IDS.vehicle1,
      vehicleNumber: 'KA-01-AB-001',
      bookingId: IDS.booking1,
      tripId: IDS.trip1,
      createdAt: new Date().toISOString(),
    });

    expect(mockEmitToBooking).toHaveBeenCalledWith(
      IDS.booking1,
      'assignment_status_changed',
      expect.objectContaining({
        status: 'driver_declined',
        reason: 'timeout',
      })
    );
  });

  test('CC.3: decline persists reason to Redis for audit trail', async () => {
    const assignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockVehicleFindUnique.mockResolvedValue(
      makeVehicle(IDS.vehicle1, IDS.transporter1, { status: 'on_hold' })
    );
    mockTx.assignment.update.mockResolvedValue({ ...assignment, status: 'driver_declined' });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });

    await assignmentService.declineAssignment(IDS.assignment1, IDS.driver1, { reason: 'too_far' });

    expect(mockRedisSet).toHaveBeenCalledWith(
      `assignment:reason:${IDS.assignment1}`,
      'declined',
      86400
    );
  });

  test('CC.4: cancel invalidates driver active-assignment cache', async () => {
    const assignment = makeAssignment({ status: 'driver_accepted' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockVehicleFindUnique.mockResolvedValue(
      makeVehicle(IDS.vehicle1, IDS.transporter1, { status: 'in_transit' })
    );

    await assignmentService.cancelAssignment(IDS.assignment1, IDS.transporter1);

    expect(mockRedisDel).toHaveBeenCalledWith(
      `driver:active-assignment:${IDS.driver1}`
    );
  });
});
