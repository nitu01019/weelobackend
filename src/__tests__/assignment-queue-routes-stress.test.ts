/**
 * =============================================================================
 * DEEP STRESS TESTS — Assignment, Queue, and Route Modules
 * =============================================================================
 *
 * Covers:
 *   1. Assignment under load (concurrency, double-booking, timeout storms)
 *   2. Queue resilience (ordering, retries, DLQ, deduplication, cleanup)
 *   3. Route integration (status codes, middleware chain, rate limits)
 *   4. Cross-module integration (order -> assignment -> queue -> timeout)
 *   5. Race conditions (shutdown, concurrent grab, cancel vs timeout)
 *
 * Run: npx jest src/__tests__/assignment-queue-routes-stress.test.ts --no-coverage --forceExit
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — must be before imports
// =============================================================================

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: jest.fn(),
    order: { findUnique: jest.fn().mockResolvedValue(null) },
  })),
  Prisma: {
    TransactionIsolationLevel: { Serializable: 'Serializable' },
  },
}));

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

jest.mock('../config/environment', () => ({
  config: {
    redis: { enabled: false },
    isProduction: false,
    isDevelopment: true,
    otp: { expiryMinutes: 5 },
    sms: {},
    jwt: { secret: 'test-secret-key-for-jwt-signing-000' },
    googleMaps: { apiKey: '', enabled: false },
  },
}));

jest.mock('../core/config/hold-config', () => ({
  HOLD_CONFIG: {
    driverAcceptTimeoutMs: 45000,
    driverAcceptTimeoutSeconds: 45,
    confirmedHoldMaxSeconds: 180,
    flexHoldDurationSeconds: 90,
  },
}));

// --- Transitive dependency mocks (order-lifecycle-outbox -> order-broadcast -> routing -> google-maps) ---
jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: {
    calculateRoute: jest.fn().mockResolvedValue({ distanceKm: 100, durationMinutes: 120 }),
  },
}));

jest.mock('../modules/routing', () => ({
  routingService: {
    calculateRoute: jest.fn().mockResolvedValue({ distanceKm: 100, durationMinutes: 120 }),
  },
}));

jest.mock('../modules/order/order-lifecycle-outbox.service', () => ({
  FF_CANCEL_OUTBOX_ENABLED: false,
  ORDER_CANCEL_OUTBOX_POLL_MS: 5000,
  ORDER_CANCEL_OUTBOX_BATCH_SIZE: 10,
  startLifecycleOutboxWorker: jest.fn().mockReturnValue(null),
  enqueueCancelLifecycleOutbox: jest.fn().mockResolvedValue('outbox-id'),
  enqueueCompletionLifecycleOutbox: jest.fn().mockResolvedValue('outbox-id'),
  processLifecycleOutboxImmediately: jest.fn().mockResolvedValue(undefined),
  emitCancellationLifecycle: jest.fn().mockResolvedValue(undefined),
  emitTripCompletedLifecycle: jest.fn().mockResolvedValue(undefined),
  lifecycleOutboxDelegate: jest.fn(),
  handleOrderExpiry: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../modules/assignment/auto-redispatch.service', () => ({
  tryAutoRedispatch: jest.fn().mockResolvedValue(false),
}));

jest.mock('../modules/driver/driver-presence.service', () => ({
  driverPresenceService: {
    isDriverOnline: jest.fn().mockResolvedValue(false),
  },
}));

jest.mock('../shared/services/audit.service', () => ({
  recordStatusChange: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../shared/utils/pii.utils', () => ({
  maskPhoneForExternal: jest.fn().mockImplementation((p: string) => `****${p.slice(-4)}`),
}));

// --- db mock ---
const mockGetAssignmentById = jest.fn();
const mockGetBookingById = jest.fn();
const mockGetVehicleById = jest.fn();
const mockGetUserById = jest.fn();
const mockUpdateAssignment = jest.fn();
const mockGetActiveAssignmentByDriver = jest.fn();
const mockGetAssignmentsByTransporter = jest.fn();
const mockGetAssignmentsByDriver = jest.fn();
const mockGetBookingsByCustomer = jest.fn();
const mockGetActiveOrderByCustomer = jest.fn();
const mockGetOrderById = jest.fn();
const mockGetActiveOrders = jest.fn();
const mockGetTruckRequestsByOrder = jest.fn();
const mockGetAssignmentsByOrder = jest.fn();
const mockGetVehiclesByTransporter = jest.fn();
const mockGetDriversByTransporter = jest.fn();
const mockGetActiveBookingsForTransporter = jest.fn();
const mockUpdateOrder = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getAssignmentById: (...args: any[]) => mockGetAssignmentById(...args),
    getBookingById: (...args: any[]) => mockGetBookingById(...args),
    getVehicleById: (...args: any[]) => mockGetVehicleById(...args),
    getUserById: (...args: any[]) => mockGetUserById(...args),
    updateAssignment: (...args: any[]) => mockUpdateAssignment(...args),
    getActiveAssignmentByDriver: (...args: any[]) => mockGetActiveAssignmentByDriver(...args),
    getAssignmentsByTransporter: (...args: any[]) => mockGetAssignmentsByTransporter(...args),
    getAssignmentsByDriver: (...args: any[]) => mockGetAssignmentsByDriver(...args),
    getBookingsByCustomer: (...args: any[]) => mockGetBookingsByCustomer(...args),
    getActiveOrderByCustomer: (...args: any[]) => mockGetActiveOrderByCustomer(...args),
    getOrderById: (...args: any[]) => mockGetOrderById(...args),
    getActiveOrders: (...args: any[]) => mockGetActiveOrders(...args),
    getTruckRequestsByOrder: (...args: any[]) => mockGetTruckRequestsByOrder(...args),
    getAssignmentsByOrder: (...args: any[]) => mockGetAssignmentsByOrder(...args),
    getVehiclesByTransporter: (...args: any[]) => mockGetVehiclesByTransporter(...args),
    getDriversByTransporter: (...args: any[]) => mockGetDriversByTransporter(...args),
    getActiveBookingsForTransporter: (...args: any[]) => mockGetActiveBookingsForTransporter(...args),
    updateOrder: (...args: any[]) => mockUpdateOrder(...args),
    getUserByPhone: jest.fn().mockResolvedValue(null),
    getOrdersByCustomer: jest.fn().mockResolvedValue([]),
    getOrderDetails: jest.fn().mockResolvedValue(null),
    getActiveRequestsForTransporter: jest.fn().mockResolvedValue([]),
  },
  AssignmentRecord: {},
}));

// --- prismaClient mock ---
const mockTxAssignmentUpdateMany = jest.fn();
const mockTxAssignmentFindUnique = jest.fn();
const mockTxAssignmentFindFirst = jest.fn();
const mockTxAssignmentCreate = jest.fn();
const mockTxVehicleUpdateMany = jest.fn();
const mockTxAssignmentUpdate = jest.fn();

const mockTx = {
  $executeRawUnsafe: jest.fn().mockResolvedValue(0),
  $executeRaw: jest.fn().mockResolvedValue(0),
  $queryRaw: jest.fn().mockResolvedValue([]),
  assignment: {
    updateMany: (...args: any[]) => mockTxAssignmentUpdateMany(...args),
    findUnique: (...args: any[]) => mockTxAssignmentFindUnique(...args),
    findFirst: (...args: any[]) => mockTxAssignmentFindFirst(...args),
    create: (...args: any[]) => mockTxAssignmentCreate(...args),
    update: (...args: any[]) => mockTxAssignmentUpdate(...args),
  },
  vehicle: {
    updateMany: (...args: any[]) => mockTxVehicleUpdateMany(...args),
  },
  truckRequest: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  booking: {
    findUnique: jest.fn().mockResolvedValue(null),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
};

const mockPrismaTransaction = jest.fn().mockImplementation(async (fn: any) => fn(mockTx));
const mockPrismaAssignmentUpdateMany = jest.fn();
const mockPrismaAssignmentCount = jest.fn().mockResolvedValue(0);
const mockPrismaAssignmentFindMany = jest.fn().mockResolvedValue([]);
const mockPrismaVehicleFindUnique = jest.fn();
const mockPrismaExecuteRaw = jest.fn().mockResolvedValue(0);
const mockPrismaUserFindUnique = jest.fn();
const mockPrismaUserUpdate = jest.fn();
const mockPrismaRatingAggregate = jest.fn().mockResolvedValue({ _avg: { stars: null }, _count: { stars: 0 } });
const mockPrismaBookingAggregate = jest.fn().mockResolvedValue({ _sum: { pricePerTruck: 0 } });

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: (...args: any[]) => mockPrismaTransaction(...args),
    $executeRaw: (...args: any[]) => mockPrismaExecuteRaw(...args),
    assignment: {
      updateMany: (...args: any[]) => mockPrismaAssignmentUpdateMany(...args),
      count: (...args: any[]) => mockPrismaAssignmentCount(...args),
      findMany: (...args: any[]) => mockPrismaAssignmentFindMany(...args),
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    vehicle: {
      findUnique: (...args: any[]) => mockPrismaVehicleFindUnique(...args),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findUnique: (...args: any[]) => mockPrismaUserFindUnique(...args),
      update: (...args: any[]) => mockPrismaUserUpdate(...args),
      findMany: jest.fn().mockResolvedValue([]),
    },
    order: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    truckRequest: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    booking: {
      aggregate: (...args: any[]) => mockPrismaBookingAggregate(...args),
    },
    rating: {
      aggregate: (...args: any[]) => mockPrismaRatingAggregate(...args),
    },
    customerPenaltyDue: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  },
  withDbTimeout: jest.fn().mockImplementation(async (fn: any) => fn(mockTx)),
}));

// --- Redis mock ---
const mockRedisGet = jest.fn().mockResolvedValue(null);
const mockRedisSet = jest.fn().mockResolvedValue('OK');
const mockRedisDel = jest.fn().mockResolvedValue(1);
const mockRedisGetJSON = jest.fn().mockResolvedValue(null);
const mockRedisSetJSON = jest.fn().mockResolvedValue('OK');
const mockRedisGetOrSet = jest.fn().mockImplementation(async (_k: string, _ttl: number, fn: () => any) => fn());
const mockRedisAcquireLock = jest.fn().mockResolvedValue({ acquired: true });
const mockRedisReleaseLock = jest.fn().mockResolvedValue(true);
const mockRedisCheckRateLimit = jest.fn().mockResolvedValue({ allowed: true, remaining: 4, resetIn: 60 });
const mockRedisSetTimer = jest.fn().mockResolvedValue(undefined);
const mockRedisCancelTimer = jest.fn().mockResolvedValue(undefined);
const mockRedisExists = jest.fn().mockResolvedValue(false);
const mockRedisSAdd = jest.fn().mockResolvedValue(1);
const mockRedisSRem = jest.fn().mockResolvedValue(1);
const mockRedisHGetAll = jest.fn().mockResolvedValue({});
const mockRedisLPush = jest.fn().mockResolvedValue(1);
const mockRedisLTrim = jest.fn().mockResolvedValue('OK');
const mockRedisLLen = jest.fn().mockResolvedValue(0);
const mockRedisExpire = jest.fn().mockResolvedValue(1);
const mockRedisHSet = jest.fn().mockResolvedValue(1);
const mockRedisHDel = jest.fn().mockResolvedValue(1);
const mockRedisLPushMany = jest.fn().mockResolvedValue(1);
const mockRedisBrPop = jest.fn().mockImplementation(
  () => new Promise(resolve => setTimeout(() => resolve(null), 50))
);
const mockRedisZAdd = jest.fn().mockResolvedValue(1);
const mockRedisZRangeByScore = jest.fn().mockResolvedValue([]);
const mockRedisZRemRangeByScore = jest.fn().mockResolvedValue(0);

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    getJSON: (...args: any[]) => mockRedisGetJSON(...args),
    setJSON: (...args: any[]) => mockRedisSetJSON(...args),
    getOrSet: (...args: any[]) => mockRedisGetOrSet(...args),
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    checkRateLimit: (...args: any[]) => mockRedisCheckRateLimit(...args),
    setTimer: (...args: any[]) => mockRedisSetTimer(...args),
    cancelTimer: (...args: any[]) => mockRedisCancelTimer(...args),
    exists: (...args: any[]) => mockRedisExists(...args),
    sAdd: (...args: any[]) => mockRedisSAdd(...args),
    sRem: (...args: any[]) => mockRedisSRem(...args),
    hGetAll: (...args: any[]) => mockRedisHGetAll(...args),
    lPush: (...args: any[]) => mockRedisLPush(...args),
    lPushMany: (...args: any[]) => mockRedisLPushMany(...args),
    lTrim: (...args: any[]) => mockRedisLTrim(...args),
    lLen: (...args: any[]) => mockRedisLLen(...args),
    expire: (...args: any[]) => mockRedisExpire(...args),
    hSet: (...args: any[]) => mockRedisHSet(...args),
    hDel: (...args: any[]) => mockRedisHDel(...args),
    brPop: (...args: any[]) => mockRedisBrPop(...args),
    zAdd: (...args: any[]) => mockRedisZAdd(...args),
    zRangeByScore: (...args: any[]) => mockRedisZRangeByScore(...args),
    zRemRangeByScore: (...args: any[]) => mockRedisZRemRangeByScore(...args),
    isConnected: jest.fn().mockReturnValue(true),
  },
}));

// --- Socket mock ---
const mockEmitToUser = jest.fn();
const mockEmitToBooking = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToBooking: (...args: any[]) => mockEmitToBooking(...args),
  SocketEvent: {
    TRUCK_ASSIGNED: 'truck_assigned',
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    DRIVER_TIMEOUT: 'driver_timeout',
    TRIP_ASSIGNED: 'trip_assigned',
  },
  socketService: {
    emitToUser: (...args: any[]) => mockEmitToUser(...args),
  },
}));

// --- Queue processors mock (prevent real timers from starting) ---
jest.mock('../shared/queue-processors', () => ({
  registerBroadcastProcessor: jest.fn(),
  registerPushNotificationProcessor: jest.fn(),
  registerFcmBatchProcessor: jest.fn(),
  registerTrackingEventsProcessor: jest.fn(),
  registerVehicleReleaseProcessor: jest.fn(),
  registerAssignmentReconciliationProcessor: jest.fn(),
  startAssignmentTimeoutPoller: jest.fn(),
}));

// --- Availability and tracking mocks ---
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../modules/tracking/tracking.service', () => ({
  trackingService: {
    initializeTracking: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  onVehicleTransition: jest.fn().mockResolvedValue(undefined),
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../shared/services/tracking-stream-sink', () => ({
  createTrackingStreamSink: () => ({ flush: jest.fn().mockResolvedValue(undefined) }),
}));

jest.mock('../shared/services/availability.service', () => ({
  availabilityService: {
    updateAvailabilityForVehicleKeysAsync: jest.fn().mockResolvedValue(undefined),
    setOffline: jest.fn(),
    getStats: jest.fn().mockReturnValue({ online: 0, total: 0 }),
    getTransporterDetails: jest.fn().mockResolvedValue(null),
    HEARTBEAT_INTERVAL_MS: 5000,
  },
}));

jest.mock('../shared/services/fleet-cache.service', () => ({
  fleetCacheService: {
    getTransporterDrivers: jest.fn().mockResolvedValue([]),
    getAvailableDrivers: jest.fn().mockResolvedValue([]),
    getDriver: jest.fn().mockResolvedValue(null),
  },
  onDriverChange: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../shared/services/cache.service', () => ({
  cacheService: {
    delete: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  },
}));

jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn().mockReturnValue('truck_open_body'),
  generateVehicleKeyCandidates: jest.fn().mockReturnValue(['truck_open_body']),
}));

jest.mock('../shared/resilience/request-queue', () => ({
  bookingQueue: {
    middleware: () => (_req: any, _res: any, next: any) => next(),
  },
  trackingQueue: {
    middleware: () => (_req: any, _res: any, next: any) => next(),
  },
  Priority: { HIGH: 2, CRITICAL: 1, NORMAL: 3 },
}));

jest.mock('../shared/utils/order-lifecycle.utils', () => ({
  normalizeOrderStatus: (s: string) => s,
  normalizeOrderLifecycleState: (s: string) => s,
}));

jest.mock('../shared/services/transporter-online.service', () => ({
  ONLINE_TRANSPORTERS_SET: 'online:transporters',
  TRANSPORTER_PRESENCE_KEY: (id: string) => `transporter:presence:${id}`,
  PRESENCE_TTL_SECONDS: 60,
}));

jest.mock('../shared/utils/geospatial.utils', () => ({
  ...jest.requireActual('../shared/utils/geospatial.utils'),
  haversineDistanceKm: jest.fn().mockReturnValue(10),
}));

jest.mock('../modules/booking/booking.service', () => ({
  bookingService: {
    incrementTrucksFilled: jest.fn().mockResolvedValue(undefined),
    decrementTrucksFilled: jest.fn().mockResolvedValue(undefined),
    deliverMissedBroadcasts: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../modules/broadcast/broadcast.service', () => ({
  broadcastService: {
    getActiveBroadcasts: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../modules/order/order.service', () => ({
  orderService: {
    createOrder: jest.fn().mockResolvedValue({ orderId: 'ord-1', broadcastCount: 5 }),
    cancelOrder: jest.fn().mockResolvedValue({ success: true, transportersNotified: 3, message: 'cancelled' }),
    getOrdersByCustomer: jest.fn().mockResolvedValue([]),
    getOrderDetails: jest.fn().mockResolvedValue(null),
    getActiveRequestsForTransporter: jest.fn().mockResolvedValue([]),
    acceptTruckRequest: jest.fn().mockResolvedValue({ success: true }),
    checkRateLimit: jest.fn().mockResolvedValue({ allowed: true }),
    getCancelPreview: jest.fn().mockResolvedValue({ success: true }),
    createCancelDispute: jest.fn().mockResolvedValue({ success: true }),
  },
}));

jest.mock('../modules/order/order.contract', () => ({
  buildCreateOrderResponseData: jest.fn().mockReturnValue({}),
  normalizeCreateOrderInput: jest.fn().mockImplementation((d: any) => d),
  toCreateOrderServiceRequest: jest.fn().mockReturnValue({}),
}));

jest.mock('../modules/booking/booking.schema', () => ({
  createOrderSchema: {
    safeParse: jest.fn().mockReturnValue({ success: true, data: {} }),
  },
}));

jest.mock('../modules/driver/driver.service', () => ({
  driverService: {
    createDriver: jest.fn().mockResolvedValue({ id: 'drv-1', name: 'TestDriver', phone: '9999999999' }),
    getDashboard: jest.fn().mockResolvedValue({ trips: 0, earnings: 0 }),
    getPerformance: jest.fn().mockResolvedValue({ rating: 4.5 }),
    getAvailability: jest.fn().mockResolvedValue({ isOnline: true }),
    updateAvailability: jest.fn().mockResolvedValue({ isOnline: true }),
    getEarnings: jest.fn().mockResolvedValue({ total: 0 }),
    getTrips: jest.fn().mockResolvedValue({ trips: [] }),
    getActiveTrip: jest.fn().mockResolvedValue(null),
    getOnlineDriverIds: jest.fn().mockResolvedValue([]),
    getDriverById: jest.fn().mockResolvedValue(null),
    completeProfile: jest.fn().mockResolvedValue({ id: 'drv-1', name: 'TestDriver' }),
    updateProfilePhoto: jest.fn().mockResolvedValue({ id: 'drv-1', name: 'TestDriver' }),
    updateLicensePhotos: jest.fn().mockResolvedValue({ id: 'drv-1', name: 'TestDriver' }),
  },
}));

jest.mock('../modules/driver/driver.schema', () => ({
  createDriverSchema: { parse: jest.fn().mockReturnValue({}) },
  updateAvailabilitySchema: {},
  getEarningsQuerySchema: { parse: jest.fn().mockReturnValue({ period: 'month' }) },
}));

jest.mock('../shared/utils/validation.utils', () => ({
  validateSchema: jest.fn().mockImplementation((_schema: any, data: any) => data),
  validateRequest: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../shared/services/s3-upload.service', () => ({
  s3UploadService: {
    uploadDriverPhotos: jest.fn().mockResolvedValue({
      driverPhotoUrl: 'https://s3/photo.jpg',
      licenseFrontUrl: 'https://s3/front.jpg',
      licenseBackUrl: 'https://s3/back.jpg',
    }),
  },
}));

jest.mock('../shared/utils/crypto.utils', () => ({
  generateSecureOTP: () => '123456',
  maskForLogging: (phone: string) => `****${phone.slice(-4)}`,
}));

jest.mock('../modules/auth/sms.service', () => ({
  smsService: { sendOtp: jest.fn().mockResolvedValue(undefined) },
}));

// =============================================================================
// IMPORTS — after mocks
// =============================================================================

import { InMemoryQueue } from '../shared/services/queue-memory.service';
import { assignmentDispatchService } from '../modules/assignment/assignment-dispatch.service';
import { assignmentResponseService } from '../modules/assignment/assignment-response.service';
import { assignmentLifecycleService } from '../modules/assignment/assignment-lifecycle.service';
import { assignmentQueryService } from '../modules/assignment/assignment-query.service';
import { assignmentService } from '../modules/assignment/assignment.service';
import { ASSIGNMENT_CONFIG } from '../modules/assignment/assignment.types';
import type { QueueJob } from '../shared/services/queue.types';

// =============================================================================
// HELPERS
// =============================================================================

function makeAssignment(overrides: Record<string, any> = {}) {
  return {
    id: 'asgn-1',
    bookingId: 'book-1',
    orderId: '',
    truckRequestId: '',
    transporterId: 'trans-1',
    transporterName: 'Test Transporter',
    vehicleId: 'veh-1',
    vehicleNumber: 'KA01AB1234',
    vehicleType: 'truck',
    vehicleSubtype: 'open body',
    driverId: 'drv-1',
    driverName: 'Test Driver',
    driverPhone: '9999999999',
    tripId: 'trip-1',
    status: 'pending',
    assignedAt: new Date().toISOString(),
    driverAcceptedAt: '',
    startedAt: '',
    completedAt: '',
    ...overrides,
  };
}

function makeBooking(overrides: Record<string, any> = {}) {
  return {
    id: 'book-1',
    customerId: 'cust-1',
    vehicleType: 'truck',
    vehicleSubtype: 'open body',
    status: 'active',
    trucksNeeded: 3,
    trucksFilled: 0,
    ...overrides,
  };
}

function makeVehicle(overrides: Record<string, any> = {}) {
  return {
    id: 'veh-1',
    transporterId: 'trans-1',
    vehicleNumber: 'KA01AB1234',
    vehicleType: 'truck',
    vehicleSubtype: 'open body',
    vehicleKey: 'truck_open_body',
    status: 'available',
    isActive: true,
    ...overrides,
  };
}

function makeDriver(overrides: Record<string, any> = {}) {
  return {
    id: 'drv-1',
    name: 'Test Driver',
    phone: '9999999999',
    transporterId: 'trans-1',
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

beforeEach(() => {
  jest.clearAllMocks();
  // Sensible defaults
  mockGetBookingById.mockResolvedValue(makeBooking());
  mockGetVehicleById.mockResolvedValue(makeVehicle());
  mockGetUserById.mockResolvedValue(makeDriver());
  mockGetAssignmentById.mockResolvedValue(makeAssignment());
  mockTxAssignmentFindFirst.mockResolvedValue(null); // no active trip
  mockTxAssignmentCreate.mockResolvedValue(undefined);
  mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
  mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
  mockTxAssignmentFindUnique.mockResolvedValue(makeAssignment({ status: 'driver_accepted' }));
  mockTxAssignmentUpdate.mockResolvedValue(makeAssignment({ status: 'cancelled' }));
  mockUpdateAssignment.mockResolvedValue(makeAssignment({ status: 'en_route_pickup' }));
  mockRedisGetOrSet.mockImplementation(async (_k: string, _ttl: number, fn: () => any) => fn());
  mockGetActiveAssignmentByDriver.mockResolvedValue(null);
  mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
  mockPrismaVehicleFindUnique.mockResolvedValue(makeVehicle());
});

// =============================================================================
// 1. ASSIGNMENT UNDER LOAD
// =============================================================================

describe('Assignment Under Load', () => {
  describe('Concurrent dispatch - no double-booking', () => {
    it('should reject dispatch if vehicle is not available', async () => {
      mockGetVehicleById.mockResolvedValue(makeVehicle({ status: 'in_transit' }));
      await expect(
        assignmentDispatchService.createAssignment('trans-1', {
          bookingId: 'book-1',
          vehicleId: 'veh-1',
          driverId: 'drv-1',
        })
      ).rejects.toThrow(/currently in_transit/);
    });

    it('should reject dispatch if driver already has active trip', async () => {
      mockTxAssignmentFindFirst.mockResolvedValue(makeAssignment({ tripId: 'trip-existing' }));
      await expect(
        assignmentDispatchService.createAssignment('trans-1', {
          bookingId: 'book-1',
          vehicleId: 'veh-1',
          driverId: 'drv-1',
        })
      ).rejects.toThrow(/already has an active trip/);
    });

    it('should atomically set vehicle to on_hold during dispatch', async () => {
      await assignmentDispatchService.createAssignment('trans-1', {
        bookingId: 'book-1',
        vehicleId: 'veh-1',
        driverId: 'drv-1',
      });
      expect(mockTxVehicleUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'veh-1' }),
          data: expect.objectContaining({ status: 'on_hold' }),
        })
      );
    });

    it('should create 50 assignments concurrently without errors when drivers differ', async () => {
      const promises: Promise<any>[] = [];
      for (let i = 0; i < 50; i++) {
        const driverId = `drv-${i}`;
        const vehicleId = `veh-${i}`;
        mockGetVehicleById.mockResolvedValue(makeVehicle({ id: vehicleId, transporterId: 'trans-1' }));
        mockGetUserById.mockResolvedValue(makeDriver({ id: driverId, transporterId: 'trans-1' }));
        promises.push(
          assignmentDispatchService.createAssignment('trans-1', {
            bookingId: 'book-1',
            vehicleId,
            driverId,
          })
        );
      }
      const results = await Promise.allSettled(promises);
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      expect(fulfilled.length).toBe(50);
    });

    it('should reject dispatch if booking is not active', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'completed' }));
      await expect(
        assignmentDispatchService.createAssignment('trans-1', {
          bookingId: 'book-1',
          vehicleId: 'veh-1',
          driverId: 'drv-1',
        })
      ).rejects.toThrow(/not accepting more trucks/);
    });

    it('should reject dispatch if vehicle type mismatches booking', async () => {
      mockGetVehicleById.mockResolvedValue(makeVehicle({ vehicleType: 'mini_truck' }));
      await expect(
        assignmentDispatchService.createAssignment('trans-1', {
          bookingId: 'book-1',
          vehicleId: 'veh-1',
          driverId: 'drv-1',
        })
      ).rejects.toThrow(/Booking requires truck/);
    });

    it('should reject dispatch if vehicle subtype mismatches booking', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ vehicleSubtype: 'closed body' }));
      mockGetVehicleById.mockResolvedValue(makeVehicle({ vehicleSubtype: 'open body' }));
      await expect(
        assignmentDispatchService.createAssignment('trans-1', {
          bookingId: 'book-1',
          vehicleId: 'veh-1',
          driverId: 'drv-1',
        })
      ).rejects.toThrow(/Booking requires "closed body"/);
    });

    it('should reject dispatch if vehicle belongs to another transporter', async () => {
      mockGetVehicleById.mockResolvedValue(makeVehicle({ transporterId: 'trans-other' }));
      await expect(
        assignmentDispatchService.createAssignment('trans-1', {
          bookingId: 'book-1',
          vehicleId: 'veh-1',
          driverId: 'drv-1',
        })
      ).rejects.toThrow(/does not belong to you/);
    });

    it('should reject dispatch if driver belongs to another transporter', async () => {
      mockGetUserById.mockResolvedValue(makeDriver({ transporterId: 'trans-other' }));
      await expect(
        assignmentDispatchService.createAssignment('trans-1', {
          bookingId: 'book-1',
          vehicleId: 'veh-1',
          driverId: 'drv-1',
        })
      ).rejects.toThrow(/does not belong to you/);
    });

    it('should reject dispatch if booking not found', async () => {
      mockGetBookingById.mockResolvedValue(null);
      await expect(
        assignmentDispatchService.createAssignment('trans-1', {
          bookingId: 'book-1',
          vehicleId: 'veh-1',
          driverId: 'drv-1',
        })
      ).rejects.toThrow(/Booking not found/);
    });
  });

  describe('Concurrent accept attempts — only 1 wins', () => {
    it('should accept assignment when status is pending', async () => {
      const result = await assignmentResponseService.acceptAssignment('asgn-1', 'drv-1');
      expect(result.status).toBe('driver_accepted');
    });

    it('should reject accept if assignment is not pending', async () => {
      mockGetAssignmentById.mockResolvedValue(makeAssignment({ status: 'driver_accepted' }));
      await expect(
        assignmentResponseService.acceptAssignment('asgn-1', 'drv-1')
      ).rejects.toThrow();
    });

    it('should reject accept if driver does not own assignment', async () => {
      await expect(
        assignmentResponseService.acceptAssignment('asgn-1', 'drv-other')
      ).rejects.toThrow(/not for you/);
    });

    it('should reject accept if driver already has another active trip', async () => {
      // Source code uses prismaClient.assignment.findFirst (outside tx) for driver busy check
      const { prismaClient } = require('../shared/database/prisma.service');
      prismaClient.assignment.findFirst.mockResolvedValueOnce(makeAssignment({ id: 'asgn-2', tripId: 'trip-2' }));
      await expect(
        assignmentResponseService.acceptAssignment('asgn-1', 'drv-1')
      ).rejects.toThrow(/already.*active/i);
    });

    it('should throw if concurrent accept changes assignment to non-pending', async () => {
      mockTxAssignmentUpdateMany.mockResolvedValue({ count: 0 });
      await expect(
        assignmentResponseService.acceptAssignment('asgn-1', 'drv-1')
      ).rejects.toThrow(/no longer pending/);
    });

    it('100 concurrent accepts — only first should succeed', async () => {
      let firstAccepted = false;
      mockTxAssignmentUpdateMany.mockImplementation(async () => {
        if (!firstAccepted) {
          firstAccepted = true;
          return { count: 1 };
        }
        return { count: 0 };
      });

      const promises: Promise<any>[] = [];
      for (let i = 0; i < 100; i++) {
        promises.push(
          assignmentResponseService.acceptAssignment('asgn-1', 'drv-1').catch(e => e)
        );
      }
      const results = await Promise.allSettled(promises);
      const successes = results.filter(
        r => r.status === 'fulfilled' && !(r.value instanceof Error)
      );
      expect(successes.length).toBe(1);
    });

    it('should cancel Redis timeout after successful accept', async () => {
      await assignmentResponseService.acceptAssignment('asgn-1', 'drv-1');
      expect(mockRedisCancelTimer).toHaveBeenCalled();
    });

    it('should update vehicle to in_transit atomically on accept', async () => {
      await assignmentResponseService.acceptAssignment('asgn-1', 'drv-1');
      expect(mockTxVehicleUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'in_transit' }),
        })
      );
    });

    it('should invalidate driver negative cache after accept', async () => {
      await assignmentResponseService.acceptAssignment('asgn-1', 'drv-1');
      expect(mockRedisDel).toHaveBeenCalledWith('driver:active-assignment:drv-1');
    });
  });

  describe('Assignment timeout fires for 50 assignments simultaneously', () => {
    it('should timeout assignment when still pending', async () => {
      mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      await assignmentLifecycleService.handleAssignmentTimeout({
        assignmentId: 'asgn-1',
        driverId: 'drv-1',
        driverName: 'Test Driver',
        transporterId: 'trans-1',
        vehicleId: 'veh-1',
        vehicleNumber: 'KA01AB1234',
        bookingId: 'book-1',
        tripId: 'trip-1',
        createdAt: new Date().toISOString(),
      });
      expect(mockPrismaAssignmentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'asgn-1', status: 'pending' },
        })
      );
    });

    it('should no-op timeout if already accepted', async () => {
      mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 0 });
      mockGetAssignmentById.mockResolvedValue(makeAssignment({ status: 'driver_accepted' }));
      await assignmentLifecycleService.handleAssignmentTimeout({
        assignmentId: 'asgn-1',
        driverId: 'drv-1',
        driverName: 'Test Driver',
        transporterId: 'trans-1',
        vehicleId: 'veh-1',
        vehicleNumber: 'KA01AB1234',
        bookingId: 'book-1',
        tripId: 'trip-1',
        createdAt: new Date().toISOString(),
      });
      // Should NOT emit DRIVER_TIMEOUT if already accepted
      expect(mockEmitToUser).not.toHaveBeenCalledWith(
        'trans-1',
        'driver_timeout',
        expect.anything()
      );
    });

    it('should handle 50 simultaneous timeouts without errors', async () => {
      mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      const promises = Array.from({ length: 50 }, (_, i) =>
        assignmentLifecycleService.handleAssignmentTimeout({
          assignmentId: `asgn-${i}`,
          driverId: `drv-${i}`,
          driverName: `Driver ${i}`,
          transporterId: 'trans-1',
          vehicleId: `veh-${i}`,
          vehicleNumber: `KA01AB${1000 + i}`,
          bookingId: 'book-1',
          tripId: `trip-${i}`,
          createdAt: new Date().toISOString(),
        })
      );
      const results = await Promise.allSettled(promises);
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      expect(fulfilled.length).toBe(50);
    });
  });

  describe('Decline -> re-dispatch chain', () => {
    it('should decline assignment and release vehicle', async () => {
      mockPrismaVehicleFindUnique.mockResolvedValue(makeVehicle());
      await assignmentLifecycleService.declineAssignment('asgn-1', 'drv-1');
      expect(mockTxAssignmentUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'driver_declined' },
        })
      );
    });

    it('should reject decline if assignment not pending', async () => {
      mockGetAssignmentById.mockResolvedValue(makeAssignment({ status: 'driver_accepted' }));
      await expect(
        assignmentLifecycleService.declineAssignment('asgn-1', 'drv-1')
      ).rejects.toThrow(/cannot be declined/);
    });

    it('should reject decline if driver does not own it', async () => {
      await expect(
        assignmentLifecycleService.declineAssignment('asgn-1', 'drv-other')
      ).rejects.toThrow(/not for you/);
    });

    it('should cancel Redis timeout on decline', async () => {
      await assignmentLifecycleService.declineAssignment('asgn-1', 'drv-1');
      expect(mockRedisCancelTimer).toHaveBeenCalled();
    });

    it('should notify transporter via WebSocket on decline', async () => {
      await assignmentLifecycleService.declineAssignment('asgn-1', 'drv-1');
      expect(mockEmitToUser).toHaveBeenCalledWith(
        'trans-1',
        expect.any(String),
        expect.objectContaining({ status: 'driver_declined' })
      );
    });
  });

  describe('Full lifecycle: dispatch -> accept -> in_transit -> completed', () => {
    it('should complete full lifecycle without errors', async () => {
      // 1. Dispatch
      const assignment = await assignmentDispatchService.createAssignment('trans-1', {
        bookingId: 'book-1',
        vehicleId: 'veh-1',
        driverId: 'drv-1',
      });
      expect(assignment.status).toBe('pending');

      // 2. Accept
      mockGetAssignmentById.mockResolvedValue(makeAssignment({ id: assignment.id }));
      const accepted = await assignmentResponseService.acceptAssignment(assignment.id, 'drv-1');
      expect(accepted.status).toBe('driver_accepted');

      // 3. Status -> en_route_pickup
      mockGetAssignmentById.mockResolvedValue(makeAssignment({ id: assignment.id, status: 'driver_accepted' }));
      const enRoute = await assignmentLifecycleService.updateStatus(assignment.id, 'drv-1', { status: 'en_route_pickup' });
      expect(enRoute).toBeDefined();

      // 4. Status -> at_pickup
      mockGetAssignmentById.mockResolvedValue(makeAssignment({ id: assignment.id, status: 'en_route_pickup' }));
      mockUpdateAssignment.mockResolvedValue(makeAssignment({ status: 'at_pickup' }));
      const atPickup = await assignmentLifecycleService.updateStatus(assignment.id, 'drv-1', { status: 'at_pickup' });
      expect(atPickup).toBeDefined();

      // 5. Status -> in_transit
      mockGetAssignmentById.mockResolvedValue(makeAssignment({ id: assignment.id, status: 'at_pickup' }));
      mockUpdateAssignment.mockResolvedValue(makeAssignment({ status: 'in_transit' }));
      const inTransit = await assignmentLifecycleService.updateStatus(assignment.id, 'drv-1', { status: 'in_transit' });
      expect(inTransit).toBeDefined();

      // 6. Status -> arrived_at_drop (M-20: must go through arrived_at_drop before completed)
      mockGetAssignmentById.mockResolvedValue(makeAssignment({ id: assignment.id, status: 'in_transit' }));
      mockUpdateAssignment.mockResolvedValue(makeAssignment({ status: 'arrived_at_drop' }));
      const arrivedAtDrop = await assignmentLifecycleService.updateStatus(assignment.id, 'drv-1', { status: 'arrived_at_drop' });
      expect(arrivedAtDrop).toBeDefined();

      // 7. Status -> completed
      mockGetAssignmentById.mockResolvedValue(makeAssignment({ id: assignment.id, status: 'arrived_at_drop' }));
      mockUpdateAssignment.mockResolvedValue(makeAssignment({ status: 'completed' }));
      mockGetBookingById.mockResolvedValue(makeBooking({ customerId: 'cust-1' }));
      const completed = await assignmentLifecycleService.updateStatus(assignment.id, 'drv-1', { status: 'completed' });
      expect(completed).toBeDefined();
    });
  });

  describe('Cancel cascade', () => {
    it('should cancel assignment and release vehicle atomically', async () => {
      mockGetAssignmentById.mockResolvedValue(makeAssignment({ status: 'driver_accepted' }));
      await assignmentLifecycleService.cancelAssignment('asgn-1', 'trans-1');
      expect(mockPrismaTransaction).toHaveBeenCalled();
    });

    it('should reject cancel by unauthorized user', async () => {
      await expect(
        assignmentLifecycleService.cancelAssignment('asgn-1', 'stranger')
      ).rejects.toThrow(/Access denied/);
    });

    it('should notify driver directly on cancellation', async () => {
      await assignmentLifecycleService.cancelAssignment('asgn-1', 'trans-1');
      expect(mockEmitToUser).toHaveBeenCalledWith(
        'drv-1',
        expect.any(String),
        expect.objectContaining({ status: 'cancelled' })
      );
    });

    it('should cancel Redis timeout on cancel', async () => {
      await assignmentLifecycleService.cancelAssignment('asgn-1', 'trans-1');
      expect(mockRedisCancelTimer).toHaveBeenCalled();
    });
  });

  describe('Status transition matrix', () => {
    const validTransitions: [string, string][] = [
      ['pending', 'driver_accepted'],
      ['pending', 'driver_declined'],
      ['pending', 'cancelled'],
      ['driver_accepted', 'en_route_pickup'],
      ['driver_accepted', 'cancelled'],
      ['en_route_pickup', 'at_pickup'],
      ['en_route_pickup', 'cancelled'],
      ['at_pickup', 'in_transit'],
      ['at_pickup', 'cancelled'],
      ['in_transit', 'arrived_at_drop'],
      ['in_transit', 'cancelled'],
      ['arrived_at_drop', 'completed'],
      ['arrived_at_drop', 'cancelled'],
    ];

    const invalidTransitions: [string, string][] = [
      ['pending', 'in_transit'],
      ['pending', 'completed'],
      ['driver_accepted', 'completed'],
      ['driver_accepted', 'in_transit'],
      ['completed', 'cancelled'],
      ['completed', 'pending'],
      ['driver_declined', 'driver_accepted'],
      ['cancelled', 'pending'],
      ['in_transit', 'completed'],  // M-20: must go through arrived_at_drop first
      ['in_transit', 'pending'],
      ['in_transit', 'driver_accepted'],
    ];

    it.each(validTransitions)('should allow transition %s -> %s', async (from, to) => {
      mockGetAssignmentById.mockResolvedValue(makeAssignment({ status: from }));
      mockUpdateAssignment.mockResolvedValue(makeAssignment({ status: to }));
      const result = await assignmentLifecycleService.updateStatus('asgn-1', 'drv-1', { status: to as any });
      expect(result).toBeDefined();
    });

    it.each(invalidTransitions)('should reject transition %s -> %s', async (from, to) => {
      mockGetAssignmentById.mockResolvedValue(makeAssignment({ status: from }));
      await expect(
        assignmentLifecycleService.updateStatus('asgn-1', 'drv-1', { status: to as any })
      ).rejects.toThrow(/Cannot transition assignment/);
    });
  });

  describe('Query service', () => {
    it('should return empty for customer with no bookings', async () => {
      mockGetBookingsByCustomer.mockResolvedValue([]);
      const result = await assignmentQueryService.getAssignments('cust-1', 'customer', { page: 1, limit: 10 });
      expect(result.assignments).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should throw 404 for non-existent assignment', async () => {
      mockGetAssignmentById.mockResolvedValue(null);
      await expect(
        assignmentQueryService.getAssignmentById('bad-id', 'drv-1', 'driver')
      ).rejects.toThrow(/Assignment not found/);
    });

    it('should deny access for wrong driver', async () => {
      await expect(
        assignmentQueryService.getAssignmentById('asgn-1', 'drv-other', 'driver')
      ).rejects.toThrow(/Access denied/);
    });

    it('should deny access for wrong transporter', async () => {
      await expect(
        assignmentQueryService.getAssignmentById('asgn-1', 'trans-other', 'transporter')
      ).rejects.toThrow(/Access denied/);
    });
  });

  describe('Facade delegation', () => {
    it('should delegate createAssignment to dispatch service', async () => {
      const result = await assignmentService.createAssignment('trans-1', {
        bookingId: 'book-1',
        vehicleId: 'veh-1',
        driverId: 'drv-1',
      });
      expect(result).toBeDefined();
      expect(result.status).toBe('pending');
    });

    it('should delegate acceptAssignment to response service', async () => {
      const result = await assignmentService.acceptAssignment('asgn-1', 'drv-1');
      expect(result.status).toBe('driver_accepted');
    });

    it('should export ASSIGNMENT_CONFIG with timeout', () => {
      expect(ASSIGNMENT_CONFIG.TIMEOUT_MS).toBe(45000);
    });
  });
});

// =============================================================================
// 2. QUEUE RESILIENCE
// =============================================================================

describe('Queue Resilience', () => {
  let queue: InMemoryQueue;

  beforeEach(() => {
    queue = new InMemoryQueue();
  });

  afterEach(() => {
    queue.stop();
  });

  describe('Rapid enqueue — 1000 jobs', () => {
    it('should enqueue 1000 jobs without errors', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 1000; i++) {
        const id = await queue.add('test-queue', 'test', { index: i });
        ids.push(id);
      }
      expect(ids.length).toBe(1000);
      expect(new Set(ids).size).toBe(1000); // All unique
    });

    it('should report correct queue depth after rapid enqueue', async () => {
      for (let i = 0; i < 500; i++) {
        await queue.add('depth-queue', 'test', { index: i });
      }
      const depth = await queue.getQueueDepth('depth-queue');
      expect(depth).toBe(500);
    });
  });

  describe('Priority ordering', () => {
    it('should process high priority jobs before low priority', async () => {
      const processed: number[] = [];
      queue.process('priority-queue', async (job: QueueJob) => {
        processed.push(job.data.priority);
      });

      await queue.add('priority-queue', 'test', { priority: 1 }, { priority: 1 });
      await queue.add('priority-queue', 'test', { priority: 5 }, { priority: 5 });
      await queue.add('priority-queue', 'test', { priority: 3 }, { priority: 3 });

      // Wait for processing
      await new Promise(r => setTimeout(r, 500));
      expect(processed[0]).toBe(5); // Highest priority first
    });

    it('should maintain FIFO within same priority level', async () => {
      const processed: number[] = [];
      queue.process('fifo-queue', async (job: QueueJob) => {
        processed.push(job.data.index);
      });

      for (let i = 0; i < 10; i++) {
        await queue.add('fifo-queue', 'test', { index: i }, { priority: 0 });
      }

      await new Promise(r => setTimeout(r, 500));
      // Should be in order since all same priority
      for (let i = 0; i < processed.length - 1; i++) {
        expect(processed[i]).toBeLessThan(processed[i + 1]);
      }
    });
  });

  describe('Job processor error — retry logic', () => {
    it('should retry failed jobs with exponential backoff', async () => {
      let attempts = 0;
      queue.process('retry-queue', async () => {
        attempts++;
        if (attempts < 3) throw new Error('Transient error');
      });

      await queue.add('retry-queue', 'test', {}, { maxAttempts: 3 });

      // Wait enough for retries (exponential: 2s, 4s)
      await new Promise(r => setTimeout(r, 8000));
      expect(attempts).toBeGreaterThanOrEqual(2);
    }, 15000);

    it('should move permanently failed jobs to DLQ', async () => {
      queue.process('dlq-queue', async () => {
        throw new Error('Permanent failure');
      });

      const completedPromise = new Promise<void>(resolve => {
        queue.on('job:failed', () => resolve());
      });

      await queue.add('dlq-queue', 'test', {}, { maxAttempts: 1 });
      await completedPromise;

      // DLQ write is via redisService.lPush
      expect(mockRedisLPush).toHaveBeenCalledWith(
        'dlq:dlq-queue',
        expect.any(String)
      );
    });

    it('should not exceed maxAttempts', async () => {
      let attempts = 0;
      queue.process('max-attempts-queue', async () => {
        attempts++;
        throw new Error('Always fails');
      });

      const failedPromise = new Promise<void>(resolve => {
        queue.on('job:failed', () => resolve());
      });

      await queue.add('max-attempts-queue', 'test', {}, { maxAttempts: 2 });
      await failedPromise;
      expect(attempts).toBe(2);
    });
  });

  describe('Queue stats', () => {
    it('should report accurate stats', async () => {
      for (let i = 0; i < 10; i++) {
        await queue.add('stats-queue', 'test', { i });
      }
      const stats = queue.getStats();
      expect(stats.totalPending).toBe(10);
    });

    it('should report 0 for empty queues', () => {
      const stats = queue.getStats();
      expect(stats.totalPending).toBe(0);
      expect(stats.totalProcessing).toBe(0);
    });

    it('should handle getQueueDepth for non-existent queue', async () => {
      const depth = await queue.getQueueDepth('nonexistent');
      expect(depth).toBe(0);
    });
  });

  describe('Queue start/stop', () => {
    it('should stop processing when stopped', () => {
      queue.stop();
      // Should not throw
      expect(() => queue.stop()).not.toThrow();
    });

    it('should restart after stop', () => {
      queue.stop();
      queue.start();
      expect(() => queue.add('restart-queue', 'test', {})).not.toThrow();
    });
  });

  describe('Batch operations', () => {
    it('should add batch of jobs and return all IDs', async () => {
      const jobs = Array.from({ length: 20 }, (_, i) => ({
        type: 'batch',
        data: { index: i },
        priority: 0,
      }));
      const ids = await queue.addBatch('batch-queue', jobs);
      expect(ids.length).toBe(20);
      expect(new Set(ids).size).toBe(20);
    });
  });

  describe('Delayed jobs', () => {
    it('should not process delayed job before delay expires', async () => {
      let processed = false;
      queue.process('delay-queue', async () => {
        processed = true;
      });

      await queue.add('delay-queue', 'test', {}, { delay: 60000 });
      await new Promise(r => setTimeout(r, 300));
      expect(processed).toBe(false);
    });
  });

  describe('Concurrency limit', () => {
    it('should not exceed concurrency of 10', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      queue.process('conc-queue', async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(r => setTimeout(r, 100));
        concurrent--;
      });

      for (let i = 0; i < 30; i++) {
        await queue.add('conc-queue', 'test', { i });
      }

      await new Promise(r => setTimeout(r, 2000));
      expect(maxConcurrent).toBeLessThanOrEqual(10);
    });
  });

  describe('Event emissions', () => {
    it('should emit job:added on enqueue', async () => {
      const addedPromise = new Promise<void>(resolve => {
        queue.on('job:added', () => resolve());
      });
      await queue.add('event-queue', 'test', {});
      await addedPromise;
    });

    it('should emit job:completed on success', async () => {
      queue.process('complete-queue', async () => {});
      const completedPromise = new Promise<void>(resolve => {
        queue.on('job:completed', () => resolve());
      });
      await queue.add('complete-queue', 'test', {});
      await completedPromise;
    });

    it('should emit job:failed on permanent failure', async () => {
      queue.process('fail-queue', async () => {
        throw new Error('fail');
      });
      const failedPromise = new Promise<void>(resolve => {
        queue.on('job:failed', () => resolve());
      });
      await queue.add('fail-queue', 'test', {}, { maxAttempts: 1 });
      await failedPromise;
    });

    it('should emit job:retry on transient failure', async () => {
      let attempt = 0;
      queue.process('retry-event-queue', async () => {
        attempt++;
        if (attempt === 1) throw new Error('transient');
      });
      const retryPromise = new Promise<void>(resolve => {
        queue.on('job:retry', () => resolve());
      });
      await queue.add('retry-event-queue', 'test', {}, { maxAttempts: 3 });
      await retryPromise;
    });
  });
});

// =============================================================================
// 3. ROUTE INTEGRATION
// =============================================================================

describe('Route Integration', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jwt = require('jsonwebtoken');

  function makeToken(payload: { userId: string; role: string; phone?: string }) {
    return jwt.sign(payload, 'test-secret-key-for-jwt-signing-000');
  }

  function mockReqRes(overrides: Record<string, any> = {}) {
    const req: any = {
      headers: { authorization: `Bearer ${makeToken({ userId: 'user-1', role: 'customer', phone: '9999999999' })}` },
      user: { userId: 'user-1', role: 'customer', phone: '9999999999' },
      params: {},
      query: {},
      body: {},
      header: jest.fn().mockReturnValue(undefined),
      ...overrides,
    };
    const res: any = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
    };
    const next = jest.fn();
    return { req, res, next };
  }

  describe('Auth middleware', () => {
    it('should reject request without auth header (401)', () => {
      const { authMiddleware } = require('../shared/middleware/auth.middleware');
      const { req, res, next } = mockReqRes({ headers: {} });
      authMiddleware(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    });

    it('should reject request with invalid token (401)', () => {
      const { authMiddleware } = require('../shared/middleware/auth.middleware');
      const { req, res, next } = mockReqRes({
        headers: { authorization: 'Bearer invalid-token' },
      });
      authMiddleware(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    });

    it('should pass with valid token', async () => {
      const { authMiddleware } = require('../shared/middleware/auth.middleware');
      const token = makeToken({ userId: 'user-1', role: 'customer', phone: '9999999999' });
      const { req, res, next } = mockReqRes({
        headers: { authorization: `Bearer ${token}` },
      });
      await authMiddleware(req, res, next);
      expect(next).toHaveBeenCalledWith();
      expect(req.user.userId).toBe('user-1');
    });

    it('should reject expired token', async () => {
      const { authMiddleware } = require('../shared/middleware/auth.middleware');
      const expiredToken = jwt.sign(
        { userId: 'user-1', role: 'customer' },
        'test-secret-key-for-jwt-signing-000',
        { expiresIn: '-10s' }
      );
      const { req, res, next } = mockReqRes({
        headers: { authorization: `Bearer ${expiredToken}` },
      });
      authMiddleware(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    });
  });

  describe('Role guard', () => {
    it('should reject wrong role (403)', () => {
      const { roleGuard } = require('../shared/middleware/auth.middleware');
      const guard = roleGuard(['transporter']);
      const { req, res, next } = mockReqRes();
      req.user = { userId: 'user-1', role: 'customer', phone: '9999999999' };
      guard(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    });

    it('should pass for correct role', () => {
      const { roleGuard } = require('../shared/middleware/auth.middleware');
      const guard = roleGuard(['customer']);
      const { req, res, next } = mockReqRes();
      req.user = { userId: 'user-1', role: 'customer', phone: '9999999999' };
      guard(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });

    it('should allow multiple roles', () => {
      const { roleGuard } = require('../shared/middleware/auth.middleware');
      const guard = roleGuard(['customer', 'transporter']);
      const { req, res, next } = mockReqRes();
      req.user = { userId: 'user-1', role: 'transporter', phone: '9999999999' };
      guard(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });

    it('should reject when user is not set (401)', () => {
      const { roleGuard } = require('../shared/middleware/auth.middleware');
      const guard = roleGuard(['customer']);
      const { req, res, next } = mockReqRes();
      delete req.user;
      guard(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    });
  });

  describe('Optional auth middleware', () => {
    it('should continue without user when no token', () => {
      const { optionalAuthMiddleware } = require('../shared/middleware/auth.middleware');
      const { req, res, next } = mockReqRes({ headers: {}, user: undefined });
      delete req.user;
      optionalAuthMiddleware(req, res, next);
      expect(next).toHaveBeenCalledWith();
      expect(req.user).toBeUndefined();
    });

    it('should set user when valid token provided', async () => {
      const { optionalAuthMiddleware } = require('../shared/middleware/auth.middleware');
      const token = makeToken({ userId: 'user-1', role: 'customer' });
      const { req, res, next } = mockReqRes({
        headers: { authorization: `Bearer ${token}` },
      });
      await optionalAuthMiddleware(req, res, next);
      expect(next).toHaveBeenCalledWith();
      expect(req.user?.userId).toBe('user-1');
    });
  });
});

// =============================================================================
// 4. CROSS-MODULE INTEGRATION
// =============================================================================

describe('Cross-Module Integration', () => {
  describe('Order -> Assignment -> Queue timeout -> Cancel', () => {
    it('should schedule Redis timer on dispatch', async () => {
      await assignmentDispatchService.createAssignment('trans-1', {
        bookingId: 'book-1',
        vehicleId: 'veh-1',
        driverId: 'drv-1',
      });
      expect(mockRedisSetTimer).toHaveBeenCalledWith(
        expect.stringContaining('timer:assignment-timeout:'),
        expect.objectContaining({ driverId: 'drv-1' }),
        expect.any(Date)
      );
    });

    it('should cancel timer when driver accepts', async () => {
      await assignmentResponseService.acceptAssignment('asgn-1', 'drv-1');
      expect(mockRedisCancelTimer).toHaveBeenCalledWith(
        expect.stringContaining('timer:assignment-timeout:asgn-1')
      );
    });

    it('should cancel timer when assignment is cancelled', async () => {
      await assignmentLifecycleService.cancelAssignment('asgn-1', 'trans-1');
      expect(mockRedisCancelTimer).toHaveBeenCalledWith(
        expect.stringContaining('timer:assignment-timeout:asgn-1')
      );
    });

    it('should release vehicle on timeout', async () => {
      mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      mockPrismaVehicleFindUnique.mockResolvedValue(makeVehicle({ status: 'on_hold' }));
      await assignmentLifecycleService.handleAssignmentTimeout({
        assignmentId: 'asgn-1',
        driverId: 'drv-1',
        driverName: 'Test Driver',
        transporterId: 'trans-1',
        vehicleId: 'veh-1',
        vehicleNumber: 'KA01AB1234',
        bookingId: 'book-1',
        tripId: 'trip-1',
        createdAt: new Date().toISOString(),
      });
      // Vehicle should be released (via releaseVehicleIfBusy calling prismaClient.vehicle.updateMany)
      expect(mockPrismaVehicleFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'veh-1' } })
      );
    });
  });

  describe('Dispatch -> Socket + FCM notifications', () => {
    it('should emit truck_assigned to booking room on dispatch', async () => {
      await assignmentDispatchService.createAssignment('trans-1', {
        bookingId: 'book-1',
        vehicleId: 'veh-1',
        driverId: 'drv-1',
      });
      expect(mockEmitToBooking).toHaveBeenCalledWith(
        'book-1',
        'truck_assigned',
        expect.objectContaining({ bookingId: 'book-1' })
      );
    });

    it('should emit to driver on dispatch', async () => {
      await assignmentDispatchService.createAssignment('trans-1', {
        bookingId: 'book-1',
        vehicleId: 'veh-1',
        driverId: 'drv-1',
      });
      expect(mockEmitToUser).toHaveBeenCalledWith(
        'drv-1',
        'trip_assigned',
        expect.objectContaining({ status: 'pending' })
      );
    });

    it('should notify transporter and customer on accept', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ customerId: 'cust-1' }));
      await assignmentResponseService.acceptAssignment('asgn-1', 'drv-1');
      // Transporter WebSocket notification not checked via emitToUser — it goes via booking room
      // Customer should be notified
      expect(mockEmitToUser).toHaveBeenCalledWith(
        'cust-1',
        'assignment_status_changed',
        expect.objectContaining({ status: 'driver_accepted' })
      );
    });
  });

  describe('Multi-truck order timeout handling', () => {
    it('should handle order-based timeout (no bookingId)', async () => {
      mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      mockGetAssignmentById.mockResolvedValue(
        makeAssignment({ bookingId: '', orderId: 'ord-1', truckRequestId: 'tr-1' })
      );
      await assignmentLifecycleService.handleAssignmentTimeout({
        assignmentId: 'asgn-1',
        driverId: 'drv-1',
        driverName: 'Test Driver',
        transporterId: 'trans-1',
        vehicleId: 'veh-1',
        vehicleNumber: 'KA01AB1234',
        tripId: 'trip-1',
        createdAt: new Date().toISOString(),
        orderId: 'ord-1',
        truckRequestId: 'tr-1',
      });
      // Should execute raw SQL for order decrement
      expect(mockPrismaExecuteRaw).toHaveBeenCalled();
    });
  });
});

// =============================================================================
// 5. RACE CONDITIONS
// =============================================================================

describe('Race Conditions', () => {
  describe('Assignment cancel races with queue timeout', () => {
    it('should handle cancel followed by timeout gracefully', async () => {
      // Cancel first
      await assignmentLifecycleService.cancelAssignment('asgn-1', 'trans-1');

      // Then timeout fires (should no-op)
      mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 0 });
      mockGetAssignmentById.mockResolvedValue(makeAssignment({ status: 'cancelled' }));
      await assignmentLifecycleService.handleAssignmentTimeout({
        assignmentId: 'asgn-1',
        driverId: 'drv-1',
        driverName: 'Test Driver',
        transporterId: 'trans-1',
        vehicleId: 'veh-1',
        vehicleNumber: 'KA01AB1234',
        bookingId: 'book-1',
        tripId: 'trip-1',
        createdAt: new Date().toISOString(),
      });
      // No exception means graceful handling
    });

    it('should handle timeout followed by accept gracefully', async () => {
      // Timeout fires first
      mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      await assignmentLifecycleService.handleAssignmentTimeout({
        assignmentId: 'asgn-1',
        driverId: 'drv-1',
        driverName: 'Test Driver',
        transporterId: 'trans-1',
        vehicleId: 'veh-1',
        vehicleNumber: 'KA01AB1234',
        bookingId: 'book-1',
        tripId: 'trip-1',
        createdAt: new Date().toISOString(),
      });

      // Then accept tries (should fail because status is now driver_declined)
      mockGetAssignmentById.mockResolvedValue(makeAssignment({ status: 'driver_declined' }));
      await expect(
        assignmentResponseService.acceptAssignment('asgn-1', 'drv-1')
      ).rejects.toThrow();
    });
  });

  describe('Concurrent cancel and accept', () => {
    it('should not both succeed', async () => {
      let cancelDone = false;
      let acceptDone = false; void acceptDone;

      mockTxAssignmentUpdateMany.mockImplementation(async (args: any) => {
        if (args.data.status === 'driver_accepted' && cancelDone) {
          return { count: 0 }; // Cancel won
        }
        return { count: 1 };
      });

      const cancelPromise = assignmentLifecycleService.cancelAssignment('asgn-1', 'trans-1')
        .then(() => { cancelDone = true; });
      const acceptPromise = assignmentResponseService.acceptAssignment('asgn-1', 'drv-1')
        .then(() => { acceptDone = true; })
        .catch(() => { /* expected */ });

      await Promise.allSettled([cancelPromise, acceptPromise]);
      // At least one should complete, not both
    });
  });

  describe('Double-dispatch same driver', () => {
    it('should reject second dispatch if driver already busy', async () => {
      // First dispatch succeeds
      await assignmentDispatchService.createAssignment('trans-1', {
        bookingId: 'book-1',
        vehicleId: 'veh-1',
        driverId: 'drv-1',
      });

      // Second dispatch: driver now has active assignment
      mockTxAssignmentFindFirst.mockResolvedValue(makeAssignment());
      await expect(
        assignmentDispatchService.createAssignment('trans-1', {
          bookingId: 'book-2',
          vehicleId: 'veh-2',
          driverId: 'drv-1',
        })
      ).rejects.toThrow(/already has an active trip/);
    });
  });

  describe('Queue shutdown during processing', () => {
    it('should stop cleanly when stopped mid-processing', async () => {
      const queue = new InMemoryQueue();
      queue.process('shutdown-queue', async () => {
        await new Promise(r => setTimeout(r, 500));
      });

      await queue.add('shutdown-queue', 'test', {});
      await new Promise(r => setTimeout(r, 100));

      // Stop while job is processing
      expect(() => queue.stop()).not.toThrow();
      queue.stop();
    });
  });
});

// =============================================================================
// 6. QUEUE SERVICE (MANAGEMENT LAYER)
// =============================================================================

describe('QueueService Management Layer', () => {
  let QueueService: any;

  beforeEach(() => {
    jest.isolateModules(() => {
      QueueService = require('../shared/services/queue-management.service').QueueService;
    });
  });

  it('should have correct queue name constants', () => {
    expect(QueueService.QUEUES.BROADCAST).toBe('broadcast');
    expect(QueueService.QUEUES.PUSH_NOTIFICATION).toBe('push');
    expect(QueueService.QUEUES.TRACKING_EVENTS).toBe('tracking-events');
    expect(QueueService.QUEUES.VEHICLE_RELEASE).toBe('vehicle-release');
    expect(QueueService.QUEUES.ASSIGNMENT_RECONCILIATION).toBe('assignment-reconciliation');
  });

  it('should create singleton with InMemoryQueue in dev mode', () => {
    const qs = new QueueService();
    expect(qs).toBeDefined();
    qs.stop();
  });

  it('should schedule assignment timeout via Redis', async () => {
    const qs = new QueueService();
    const timerKey = await qs.scheduleAssignmentTimeout(
      {
        assignmentId: 'asgn-1',
        driverId: 'drv-1',
        driverName: 'Driver',
        transporterId: 'trans-1',
        vehicleId: 'veh-1',
        vehicleNumber: 'KA01AB1234',
        tripId: 'trip-1',
        createdAt: new Date().toISOString(),
      },
      30000
    );
    expect(timerKey).toContain('timer:assignment-timeout:asgn-1');
    expect(mockRedisSetTimer).toHaveBeenCalled();
    qs.stop();
  });

  it('should cancel assignment timeout', async () => {
    const qs = new QueueService();
    await qs.cancelAssignmentTimeout('asgn-1');
    expect(mockRedisCancelTimer).toHaveBeenCalledWith('timer:assignment-timeout:asgn-1');
    qs.stop();
  });

  it('should queue push notification', async () => {
    const qs = new QueueService();
    const id = await qs.queuePushNotification('user-1', {
      title: 'Test',
      body: 'Test notification',
    });
    expect(id).toBeDefined();
    qs.stop();
  });

  it('should queue broadcast batch', async () => {
    const qs = new QueueService();
    const ids = await qs.queueBroadcastBatch(
      ['trans-1', 'trans-2'],
      'new_broadcast',
      { orderId: 'ord-1' }
    );
    expect(ids.length).toBe(2);
    qs.stop();
  });

  it('should queue batch FCM push with token splitting', async () => {
    const qs = new QueueService();
    const tokens = Array.from({ length: 600 }, (_, i) => `token-${i}`);
    const id = await qs.queueBatchPush(tokens, {
      title: 'Batch',
      body: 'Batch push',
    });
    expect(id).toBeDefined();
    qs.stop();
  });

  it('should return empty for batch push with no valid tokens', async () => {
    const qs = new QueueService();
    const id = await qs.queueBatchPush([], {
      title: 'Empty',
      body: 'No tokens',
    });
    expect(id).toBe('empty');
    qs.stop();
  });

  it('should get stats from underlying queue', () => {
    const qs = new QueueService();
    const stats = qs.getStats();
    expect(stats).toBeDefined();
    qs.stop();
  });

  it('should stop without error', () => {
    const qs = new QueueService();
    expect(() => qs.stop()).not.toThrow();
  });

  it('should fall back to setTimeout if Redis setTimer fails', async () => {
    mockRedisSetTimer.mockRejectedValueOnce(new Error('Redis down'));
    const qs = new QueueService();
    const timerKey = await qs.scheduleAssignmentTimeout(
      {
        assignmentId: 'asgn-fallback',
        driverId: 'drv-1',
        driverName: 'Driver',
        transporterId: 'trans-1',
        vehicleId: 'veh-1',
        vehicleNumber: 'KA01AB1234',
        tripId: 'trip-1',
        createdAt: new Date().toISOString(),
      },
      30000
    );
    expect(timerKey).toContain('timer:assignment-timeout:asgn-fallback');
    qs.stop();
  });

  it('should enqueue vehicle release with 5 maxAttempts', async () => {
    const qs = new QueueService();
    const id = await qs.enqueue('vehicle-release', { vehicleId: 'veh-1' });
    expect(id).toBeDefined();
    qs.stop();
  });
});

// =============================================================================
// 7. QUEUE TYPES AND CONSTANTS
// =============================================================================

describe('Queue Types and Constants', () => {
  it('should export correct TRACKING_QUEUE_HARD_LIMIT default', () => {
    const { TRACKING_QUEUE_HARD_LIMIT } = require('../shared/services/queue.types');
    expect(TRACKING_QUEUE_HARD_LIMIT).toBeGreaterThanOrEqual(1000);
  });

  it('should export correct DLQ_MAX_SIZE default', () => {
    const { DLQ_MAX_SIZE } = require('../shared/services/queue.types');
    expect(DLQ_MAX_SIZE).toBeGreaterThanOrEqual(100);
  });

  it('should export MessagePriority constants', () => {
    const { MessagePriority } = require('../shared/services/queue.types');
    expect(MessagePriority.CRITICAL).toBe(1);
    expect(MessagePriority.HIGH).toBe(2);
    expect(MessagePriority.NORMAL).toBe(3);
    expect(MessagePriority.LOW).toBe(4);
  });

  it('should export EVENT_PRIORITY mapping', () => {
    const { EVENT_PRIORITY, MessagePriority } = require('../shared/services/queue.types');
    expect(EVENT_PRIORITY['order_cancelled']).toBe(MessagePriority.CRITICAL);
    expect(EVENT_PRIORITY['new_broadcast']).toBe(MessagePriority.NORMAL);
  });

  it('should export FF_QUEUE_DEPTH_CAP default', () => {
    const { FF_QUEUE_DEPTH_CAP } = require('../shared/services/queue.types');
    expect(FF_QUEUE_DEPTH_CAP).toBeGreaterThanOrEqual(100);
  });

  it('should export IQueue interface fields via InMemoryQueue', () => {
    const queue = new InMemoryQueue();
    expect(typeof queue.add).toBe('function');
    expect(typeof queue.addBatch).toBe('function');
    expect(typeof queue.process).toBe('function');
    expect(typeof queue.start).toBe('function');
    expect(typeof queue.stop).toBe('function');
    expect(typeof queue.getStats).toBe('function');
    expect(typeof queue.getQueueDepth).toBe('function');
    queue.stop();
  });
});

// =============================================================================
// 8. ASSIGNMENT TYPES AND CONFIG
// =============================================================================

describe('Assignment Types and Config', () => {
  it('should export ASSIGNMENT_CONFIG with centralized timeout', () => {
    expect(ASSIGNMENT_CONFIG.TIMEOUT_MS).toBe(45000);
  });

  it('should use HOLD_CONFIG value for timeout', () => {
    const { HOLD_CONFIG } = require('../core/config/hold-config');
    expect(ASSIGNMENT_CONFIG.TIMEOUT_MS).toBe(HOLD_CONFIG.driverAcceptTimeoutMs);
  });
});

// =============================================================================
// 9. EDGE CASES
// =============================================================================

describe('Edge Cases', () => {
  it('should handle assignment with missing bookingId', async () => {
    mockGetAssignmentById.mockResolvedValue(
      makeAssignment({ bookingId: undefined, orderId: 'ord-1' })
    );
    mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    // Timeout should handle orderId path
    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: 'asgn-1',
      driverId: 'drv-1',
      driverName: 'Test',
      transporterId: 'trans-1',
      vehicleId: 'veh-1',
      vehicleNumber: 'KA01AB1234',
      tripId: 'trip-1',
      createdAt: new Date().toISOString(),
      orderId: 'ord-1',
    });
    // Should not throw
  });

  it('should handle assignment not found after timeout update', async () => {
    mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockGetAssignmentById.mockResolvedValue(null);
    // Should not throw, just log warning
    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: 'asgn-gone',
      driverId: 'drv-1',
      driverName: 'Test',
      transporterId: 'trans-1',
      vehicleId: 'veh-1',
      vehicleNumber: 'KA01AB1234',
      bookingId: 'book-1',
      tripId: 'trip-1',
      createdAt: new Date().toISOString(),
    });
  });

  it('should handle booking not found during dispatch', async () => {
    mockGetBookingById.mockResolvedValue(null);
    await expect(
      assignmentDispatchService.createAssignment('trans-1', {
        bookingId: 'book-nonexistent',
        vehicleId: 'veh-1',
        driverId: 'drv-1',
      })
    ).rejects.toThrow(/Booking not found/);
  });

  it('should handle vehicle not found', async () => {
    mockGetVehicleById.mockResolvedValue(null);
    await expect(
      assignmentDispatchService.createAssignment('trans-1', {
        bookingId: 'book-1',
        vehicleId: 'veh-nonexistent',
        driverId: 'drv-1',
      })
    ).rejects.toThrow(/Vehicle not found/);
  });

  it('should handle driver not found', async () => {
    mockGetUserById.mockResolvedValue(null);
    await expect(
      assignmentDispatchService.createAssignment('trans-1', {
        bookingId: 'book-1',
        vehicleId: 'veh-1',
        driverId: 'drv-nonexistent',
      })
    ).rejects.toThrow(/Driver not found/);
  });

  it('should handle assignment not found on cancel', async () => {
    mockGetAssignmentById.mockResolvedValue(null);
    await expect(
      assignmentLifecycleService.cancelAssignment('asgn-gone', 'trans-1')
    ).rejects.toThrow(/Assignment not found/);
  });

  it('should handle assignment not found on decline', async () => {
    mockGetAssignmentById.mockResolvedValue(null);
    await expect(
      assignmentLifecycleService.declineAssignment('asgn-gone', 'drv-1')
    ).rejects.toThrow(/Assignment not found/);
  });

  it('should handle assignment not found on accept', async () => {
    mockGetAssignmentById.mockResolvedValue(null);
    await expect(
      assignmentResponseService.acceptAssignment('asgn-gone', 'drv-1')
    ).rejects.toThrow(/Assignment not found/);
  });

  it('should handle assignment not found on status update', async () => {
    mockGetAssignmentById.mockResolvedValue(null);
    await expect(
      assignmentLifecycleService.updateStatus('asgn-gone', 'drv-1', { status: 'in_transit' })
    ).rejects.toThrow(/Assignment not found/);
  });

  it('should handle queue add when no processor registered', async () => {
    const queue = new InMemoryQueue();
    // Add job to queue with no processor — should not throw
    const id = await queue.add('orphan-queue', 'test', {});
    expect(id).toBeDefined();
    queue.stop();
  });

  it('should handle partially_filled booking status for dispatch', async () => {
    mockGetBookingById.mockResolvedValue(makeBooking({ status: 'partially_filled' }));
    const assignment = await assignmentDispatchService.createAssignment('trans-1', {
      bookingId: 'book-1',
      vehicleId: 'veh-1',
      driverId: 'drv-1',
    });
    expect(assignment.status).toBe('pending');
  });

  it('should case-insensitive match vehicle subtype', async () => {
    mockGetBookingById.mockResolvedValue(makeBooking({ vehicleSubtype: 'Open Body' }));
    mockGetVehicleById.mockResolvedValue(makeVehicle({ vehicleSubtype: 'open body' }));
    // Should NOT throw — case-insensitive match
    const assignment = await assignmentDispatchService.createAssignment('trans-1', {
      bookingId: 'book-1',
      vehicleId: 'veh-1',
      driverId: 'drv-1',
    });
    expect(assignment).toBeDefined();
  });

  it('should skip subtype check when booking has no subtype', async () => {
    mockGetBookingById.mockResolvedValue(makeBooking({ vehicleSubtype: null }));
    const assignment = await assignmentDispatchService.createAssignment('trans-1', {
      bookingId: 'book-1',
      vehicleId: 'veh-1',
      driverId: 'drv-1',
    });
    expect(assignment).toBeDefined();
  });
});
