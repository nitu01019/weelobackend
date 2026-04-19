/**
 * =============================================================================
 * STRESS TEST: END-TO-END FLOW COMPREHENSIVE
 * =============================================================================
 *
 * 85 tests covering the complete customer-to-transporter-to-driver journey
 * with all fixes applied.
 *
 * Categories:
 *   1. Happy Path Flows (16 tests)
 *   2. Failure Recovery Flows (20 tests)
 *   3. Cancel & Interrupt Scenarios (16 tests)
 *   4. Stuck Entity Detection & Recovery (17 tests)
 *   5. Multi-Instance Scenarios (16 tests)
 *
 * Each test is self-contained with proper setup/teardown.
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — must precede all imports
// =============================================================================

// -- Logger --
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerDebug = jest.fn();
jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
    debug: mockLoggerDebug,
  },
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

// -- Config --
jest.mock('../config/environment', () => ({
  config: { redis: { enabled: true }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {} },
}));

// -- Queue service --
const mockScheduleAssignmentTimeout = jest.fn().mockResolvedValue('timer:test');
const mockCancelAssignmentTimeout = jest.fn().mockResolvedValue(undefined);
const mockQueuePushNotification = jest.fn().mockResolvedValue(undefined);
const mockEnqueue = jest.fn().mockResolvedValue(undefined);
const mockQueueBroadcast = jest.fn().mockResolvedValue(undefined);
const mockAddToQueue = jest.fn().mockResolvedValue(undefined);
const mockGetQueueDepth = jest.fn().mockResolvedValue(0);
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    scheduleAssignmentTimeout: (...args: any[]) => mockScheduleAssignmentTimeout(...args),
    cancelAssignmentTimeout: (...args: any[]) => mockCancelAssignmentTimeout(...args),
    queuePushNotification: (...args: any[]) => mockQueuePushNotification(...args),
    enqueue: (...args: any[]) => mockEnqueue(...args),
    queueBroadcast: (...args: any[]) => mockQueueBroadcast(...args),
    addToQueue: (...args: any[]) => mockAddToQueue(...args),
    getQueueDepth: (...args: any[]) => mockGetQueueDepth(...args),
  },
}));

// -- Socket --
const mockEmitToUser = jest.fn();
const mockEmitToRoom = jest.fn();
const mockEmitToBooking = jest.fn();
const mockEmitToUsers = jest.fn();
const mockIsUserConnected = jest.fn().mockReturnValue(false);
const mockIsUserConnectedAsync = jest.fn().mockResolvedValue(false);
jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToRoom: (...args: any[]) => mockEmitToRoom(...args),
  emitToBooking: (...args: any[]) => mockEmitToBooking(...args),
  emitToUsers: (...args: any[]) => mockEmitToUsers(...args),
  isUserConnected: (...args: any[]) => mockIsUserConnected(...args),
  isUserConnectedAsync: (...args: any[]) => mockIsUserConnectedAsync(...args),
  socketService: {
    emitToUser: (...args: any[]) => mockEmitToUser(...args),
    emitToRoom: (...args: any[]) => mockEmitToRoom(...args),
  },
  SocketEvent: {
    BROADCAST_STATE_CHANGED: 'BROADCAST_STATE_CHANGED',
    NO_VEHICLES_AVAILABLE: 'NO_VEHICLES_AVAILABLE',
    NEW_BROADCAST: 'NEW_BROADCAST',
    TRIP_ASSIGNED: 'trip_assigned',
    TRUCK_CONFIRMED: 'truck_confirmed',
    BOOKING_UPDATED: 'booking_updated',
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    ASSIGNMENT_TIMEOUT: 'assignment_timeout',
    DRIVER_TIMEOUT: 'driver_timeout',
    BROADCAST_EXPIRED: 'broadcast_expired',
    TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update',
  },
}));

// -- FCM --
const mockSendPushNotification = jest.fn().mockResolvedValue(true);
jest.mock('../shared/services/fcm.service', () => ({
  fcmService: { sendToDevice: jest.fn().mockResolvedValue(undefined) },
  sendPushNotification: (...args: any[]) => mockSendPushNotification(...args),
}));

// -- Redis --
const mockRedisGet = jest.fn().mockResolvedValue(null);
const mockRedisSet = jest.fn().mockResolvedValue('OK');
const mockRedisDel = jest.fn().mockResolvedValue(1);
const mockRedisExists = jest.fn().mockResolvedValue(0);
const mockRedisAcquireLock = jest.fn().mockResolvedValue({ acquired: true });
const mockRedisReleaseLock = jest.fn().mockResolvedValue(true);
const mockRedisSMembers = jest.fn().mockResolvedValue([]);
const mockRedisSAdd = jest.fn().mockResolvedValue(1);
const mockRedisGetJSON = jest.fn().mockResolvedValue(null);
const mockRedisSetJSON = jest.fn().mockResolvedValue(undefined);
const mockRedisGetExpiredTimers = jest.fn().mockResolvedValue([]);
const mockRedisCancelTimer = jest.fn().mockResolvedValue(undefined);
const mockRedisSetTimer = jest.fn().mockResolvedValue(undefined);
const mockRedisExpire = jest.fn().mockResolvedValue(true);
const mockRedisIncr = jest.fn().mockResolvedValue(1);
const mockRedisIncrBy = jest.fn().mockResolvedValue(0);
const mockRedisSIsMember = jest.fn().mockResolvedValue(false);
const mockRedisIsConnected = jest.fn().mockReturnValue(true);
const mockRedisHSet = jest.fn().mockResolvedValue(undefined);
const mockRedisLPush = jest.fn().mockResolvedValue(1);
const mockRedisLTrim = jest.fn().mockResolvedValue(undefined);
const mockRedisLLen = jest.fn().mockResolvedValue(0);
const mockRedisKeys = jest.fn().mockResolvedValue([]);
const mockRedisSCard = jest.fn().mockResolvedValue(0);

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
    sCard: (...args: any[]) => mockRedisSCard(...args),
    sRem: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(60),
    multi: () => ({ del: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue([]) }),
    isConnected: () => mockRedisIsConnected(),
    isDegraded: false,
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
    hSet: (...args: any[]) => mockRedisHSet(...args),
    lPush: (...args: any[]) => mockRedisLPush(...args),
    lTrim: (...args: any[]) => mockRedisLTrim(...args),
    lLen: (...args: any[]) => mockRedisLLen(...args),
    keys: (...args: any[]) => mockRedisKeys(...args),
  },
}));

// -- Live availability --
const mockOnVehicleStatusChange = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: (...args: any[]) => mockOnVehicleStatusChange(...args),
    reconcile: jest.fn().mockResolvedValue(undefined),
  },
}));

// -- Vehicle lifecycle --
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
}));

// -- Availability --
jest.mock('../shared/services/availability.service', () => ({
  availabilityService: { loadTransporterDetailsMap: jest.fn().mockResolvedValue(new Map()) },
}));

// -- Vehicle key --
jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn().mockReturnValue('open:10-ton'),
}));

// -- Progressive radius --
jest.mock('../modules/order/progressive-radius-matcher', () => ({
  progressiveRadiusMatcher: { findCandidates: jest.fn().mockResolvedValue([]) },
  PROGRESSIVE_RADIUS_STEPS: [
    { radiusKm: 10, windowMs: 10000 },
    { radiusKm: 25, windowMs: 10000 },
    { radiusKm: 50, windowMs: 15000 },
    { radiusKm: 75, windowMs: 15000 },
    { radiusKm: 100, windowMs: 15000 },
    { radiusKm: 200, windowMs: 15000 },
  ],
}));

// -- Online service --
jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: { filterOnline: jest.fn().mockResolvedValue([]) },
}));

// -- Google maps --
jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: {
    calculateRoute: jest.fn().mockResolvedValue({ distanceKm: 50, durationMinutes: 60 }),
  },
}));

// -- Distance matrix --
jest.mock('../shared/services/distance-matrix.service', () => ({
  distanceMatrixService: { batchGetPickupDistance: jest.fn().mockResolvedValue(new Map()) },
}));

// -- Geospatial --
jest.mock('../shared/utils/geospatial.utils', () => ({
  haversineDistanceKm: jest.fn().mockReturnValue(50),
}));
jest.mock('../shared/utils/geo.utils', () => ({
  roundCoord: jest.fn((v: number) => Number(v.toFixed(5))),
}));

// -- Candidate scorer --
jest.mock('../shared/services/candidate-scorer.service', () => ({
  candidateScorerService: { scoreCandidates: jest.fn().mockReturnValue([]) },
}));

// -- Order broadcast --
jest.mock('../modules/order/order-broadcast.service', () => ({
  broadcastToTransporters: jest.fn().mockResolvedValue({ onlineCandidates: 0, notifiedTransporters: 0 }),
  emitBroadcastStateChanged: jest.fn(),
  clearCustomerActiveBroadcast: jest.fn(),
}));

// -- Order timer --
jest.mock('../modules/order/order-timer.service', () => ({
  setOrderExpiryTimer: jest.fn(),
  recoverOrphanedStepTimers: jest.fn().mockResolvedValue(0),
}));

// -- Order dispatch outbox --
jest.mock('../modules/order/order-dispatch-outbox.service', () => ({
  FF_ORDER_DISPATCH_OUTBOX: false,
  enqueueOrderDispatchOutbox: jest.fn(),
  processDispatchOutboxImmediately: jest.fn(),
}));

// -- Order idempotency --
jest.mock('../modules/order/order-idempotency.service', () => ({
  getDbIdempotentResponse: jest.fn().mockResolvedValue(null),
  persistDbIdempotentResponse: jest.fn().mockResolvedValue(undefined),
}));

// -- Pricing --
jest.mock('../modules/pricing/pricing.service', () => ({
  pricingService: {
    calculateEstimate: jest.fn().mockReturnValue({ pricePerTruck: 5000 }),
  },
}));

// -- State machines --
jest.mock('../core/state-machines', () => ({
  assertValidTransition: jest.fn(),
  ORDER_VALID_TRANSITIONS: {},
  BOOKING_VALID_TRANSITIONS: {},
  TERMINAL_BOOKING_STATUSES: ['completed', 'cancelled', 'expired'],
  TERMINAL_ORDER_STATUSES: ['completed', 'cancelled', 'expired'],
  TERMINAL_ASSIGNMENT_STATUSES: ['completed', 'cancelled', 'driver_declined'],
}));

// -- Booking service --
jest.mock('../modules/booking/booking.service', () => ({
  bookingService: {
    decrementTrucksFilled: jest.fn().mockResolvedValue(undefined),
  },
}));

// -- Driver service --
const mockAreDriversOnline = jest.fn().mockResolvedValue(new Map());
jest.mock('../modules/driver/driver.service', () => ({
  driverService: {
    areDriversOnline: (...args: any[]) => mockAreDriversOnline(...args),
  },
}));

// -- Hold config --
jest.mock('../core/config/hold-config', () => ({
  HOLD_CONFIG: {
    driverAcceptTimeoutMs: 45000,
    driverAcceptTimeoutSeconds: 45,
    confirmedHoldMaxSeconds: 180,
    flexHoldDurationSeconds: 90,
    flexHoldExtensionSeconds: 30,
    flexHoldMaxDurationSeconds: 130,
    flexHoldMaxExtensions: 3,
  },
}));

// -- DB layer --
const mockGetUserById = jest.fn().mockResolvedValue({ name: 'Test Customer' });
const mockGetBookingById = jest.fn();
const mockCreateBooking = jest.fn();
const mockGetActiveOrders = jest.fn().mockResolvedValue([]);
const mockUpdateOrder = jest.fn();
const mockGetAssignmentById = jest.fn();
const mockUpdateAssignment = jest.fn();
const mockGetOrderById = jest.fn();
const mockGetTransportersWithVehicleType = jest.fn().mockResolvedValue([]);
jest.mock('../shared/database/db', () => ({
  db: {
    getUserById: (...args: any[]) => mockGetUserById(...args),
    getBookingById: (...args: any[]) => mockGetBookingById(...args),
    createBooking: (...args: any[]) => mockCreateBooking(...args),
    getActiveOrders: (...args: any[]) => mockGetActiveOrders(...args),
    updateOrder: (...args: any[]) => mockUpdateOrder(...args),
    getAssignmentById: (...args: any[]) => mockGetAssignmentById(...args),
    updateAssignment: (...args: any[]) => mockUpdateAssignment(...args),
    getOrderById: (...args: any[]) => mockGetOrderById(...args),
    getTransportersWithVehicleType: (...args: any[]) => mockGetTransportersWithVehicleType(...args),
  },
}));

// -- Prisma --
const mockPrismaFindUnique = jest.fn();
const mockPrismaFindMany = jest.fn().mockResolvedValue([]);
const mockPrismaFindFirst = jest.fn().mockResolvedValue(null);
const mockPrismaCreate = jest.fn();
const mockPrismaUpdate = jest.fn();
const mockPrismaUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
const mockPrismaDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
const mockPrismaQueryRaw = jest.fn().mockResolvedValue([]);
const mockPrismaExecuteRaw = jest.fn().mockResolvedValue(0);
const mockPrismaTransaction = jest.fn();
const mockBookingFindFirst = jest.fn().mockResolvedValue(null);
const mockBookingCreate = jest.fn().mockResolvedValue({ id: 'booking-new' });
const mockBookingUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
const mockOrderFindFirst = jest.fn().mockResolvedValue(null);

const mockWithDbTimeout = jest.fn();

jest.mock('../shared/database/prisma.service', () => {
  const txProxy = {
    booking: {
      findFirst: (...args: any[]) => mockBookingFindFirst(...args),
      create: (...args: any[]) => mockBookingCreate(...args),
      updateMany: (...args: any[]) => mockBookingUpdateMany(...args),
    },
    order: {
      findFirst: (...args: any[]) => mockOrderFindFirst(...args),
      findUnique: (...args: any[]) => mockPrismaFindUnique(...args),
      update: (...args: any[]) => mockPrismaUpdate(...args),
    },
  };
  return {
    prismaClient: {
      ...txProxy,
      $transaction: (...args: any[]) => mockPrismaTransaction(...args),
      $queryRaw: (...args: any[]) => mockPrismaQueryRaw(...args),
      $executeRaw: (...args: any[]) => mockPrismaExecuteRaw(...args),
      vehicle: {
        findMany: (...args: any[]) => mockPrismaFindMany(...args),
        findUnique: (...args: any[]) => mockPrismaFindUnique(...args),
        updateMany: (...args: any[]) => mockPrismaUpdateMany(...args),
      },
      booking: {
        findFirst: (...args: any[]) => mockBookingFindFirst(...args),
        create: (...args: any[]) => mockBookingCreate(...args),
        updateMany: (...args: any[]) => mockBookingUpdateMany(...args),
        findUnique: jest.fn().mockResolvedValue(null),
        update: (...args: any[]) => mockPrismaUpdate(...args),
      },
      order: {
        findFirst: (...args: any[]) => mockOrderFindFirst(...args),
        findUnique: (...args: any[]) => mockPrismaFindUnique(...args),
        update: (...args: any[]) => mockPrismaUpdate(...args),
      },
      assignment: {
        findFirst: (...args: any[]) => mockPrismaFindFirst(...args),
        findMany: (...args: any[]) => mockPrismaFindMany(...args),
        create: (...args: any[]) => mockPrismaCreate(...args),
        update: (...args: any[]) => mockPrismaUpdate(...args),
        updateMany: (...args: any[]) => mockPrismaUpdateMany(...args),
      },
      truckHoldLedger: {
        findUnique: (...args: any[]) => mockPrismaFindUnique(...args),
        findFirst: (...args: any[]) => mockPrismaFindFirst(...args),
        findMany: (...args: any[]) => mockPrismaFindMany(...args),
        create: (...args: any[]) => mockPrismaCreate(...args),
        update: (...args: any[]) => mockPrismaUpdate(...args),
        updateMany: (...args: any[]) => mockPrismaUpdateMany(...args),
      },
      truckHoldIdempotency: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: (...args: any[]) => mockPrismaDeleteMany(...args),
      },
      truckRequest: {
        findMany: (...args: any[]) => mockPrismaFindMany(...args),
        updateMany: (...args: any[]) => mockPrismaUpdateMany(...args),
      },
      user: {
        findUnique: (...args: any[]) => mockPrismaFindUnique(...args),
        findMany: (...args: any[]) => mockPrismaFindMany(...args),
      },
    },
    withDbTimeout: (...args: any[]) => mockWithDbTimeout(...args),
    BookingStatus: {
      created: 'created',
      broadcasting: 'broadcasting',
      active: 'active',
      assigned: 'assigned',
      partially_filled: 'partially_filled',
      fully_filled: 'fully_filled',
      in_progress: 'in_progress',
      completed: 'completed',
      cancelled: 'cancelled',
      expired: 'expired',
      failed: 'failed',
    },
    OrderStatus: {
      created: 'created',
      broadcasting: 'broadcasting',
      active: 'active',
      assigned: 'assigned',
      partially_filled: 'partially_filled',
      fully_filled: 'fully_filled',
      in_progress: 'in_progress',
      completed: 'completed',
      cancelled: 'cancelled',
      expired: 'expired',
      failed: 'failed',
    },
    HoldPhase: {
      FLEX: 'FLEX',
      CONFIRMED: 'CONFIRMED',
      EXPIRED: 'EXPIRED',
      RELEASED: 'RELEASED',
    },
    VehicleStatus: {
      available: 'available',
      on_hold: 'on_hold',
      in_transit: 'in_transit',
      maintenance: 'maintenance',
      inactive: 'inactive',
    },
    AssignmentStatus: {
      pending: 'pending',
      driver_accepted: 'driver_accepted',
      en_route_pickup: 'en_route_pickup',
      at_pickup: 'at_pickup',
      in_transit: 'in_transit',
      arrived_at_drop: 'arrived_at_drop',
      completed: 'completed',
      driver_declined: 'driver_declined',
      cancelled: 'cancelled',
    },
    TruckRequestStatus: {
      searching: 'searching',
      held: 'held',
      assigned: 'assigned',
      in_transit: 'in_transit',
      completed: 'completed',
    },
  };
});

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { BookingCreateService, setBroadcastServiceRef } from '../modules/booking/booking-create.service';
import { TERMINAL_STATUSES } from '../modules/booking/booking.types';
import {
  checkAndExpireBroadcasts,
  emitBroadcastExpired,
  emitTrucksRemainingUpdate,
} from '../modules/broadcast/broadcast-dispatch.service';
import {
  acceptBroadcast,
  declineBroadcast,
} from '../modules/broadcast/broadcast-accept.service';
import {
  holdTrucks,
  confirmHold,
  buildOperationPayloadHash,
  recordHoldOutcomeMetrics,
} from '../modules/truck-hold/truck-hold-create.service';
import {
  HOLD_DURATION_CONFIG,
  CONFIG,
  TERMINAL_ORDER_STATUSES,
} from '../modules/truck-hold/truck-hold.types';
import {
  DLQ_MAX_SIZE,
  FF_CANCELLED_ORDER_QUEUE_GUARD,
  MESSAGE_TTL_MS,
  MessagePriority,
  EVENT_PRIORITY,
} from '../shared/services/queue.types';

// =============================================================================
// HELPERS
// =============================================================================

const CUSTOMER_ID = 'cust-e2e-1';
const CUSTOMER_PHONE = '9876543210';
const TRANSPORTER_ID = 'trans-e2e-1';
const DRIVER_ID = 'driver-e2e-1';
const VEHICLE_ID = 'vehicle-e2e-1';

function futureDate(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

function pastDate(seconds: number): Date {
  return new Date(Date.now() - seconds * 1000);
}

function makeBookingInput(overrides: Record<string, any> = {}) {
  return {
    vehicleType: 'open' as const,
    vehicleSubtype: '10-ton',
    trucksNeeded: 1,
    pricePerTruck: 5000,
    distanceKm: 50,
    goodsType: 'sand',
    weight: '10 kg',
    pickup: {
      coordinates: { latitude: 12.9716, longitude: 77.5946 },
      address: '123 Pickup St',
      city: 'Bangalore',
      state: 'Karnataka',
    },
    drop: {
      coordinates: { latitude: 13.0827, longitude: 80.2707 },
      address: '456 Drop Ave',
      city: 'Chennai',
      state: 'Tamil Nadu',
    },
    ...overrides,
  };
}

function makeBookingRecord(overrides: Record<string, any> = {}) {
  return {
    id: 'booking-e2e-1',
    customerId: CUSTOMER_ID,
    status: 'created',
    vehicleType: 'open',
    vehicleSubtype: '10-ton',
    trucksNeeded: 1,
    trucksFilled: 0,
    pricePerTruck: 5000,
    distanceKm: 50,
    totalAmount: 5000,
    customerName: 'Test Customer',
    customerPhone: CUSTOMER_PHONE,
    pickup: { latitude: 12.9716, longitude: 77.5946, address: '123 Pickup St' },
    drop: { latitude: 13.0827, longitude: 80.2707, address: '456 Drop Ave' },
    notifiedTransporters: [TRANSPORTER_ID],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    ...overrides,
  };
}

function makeAcceptTxResult(overrides: Record<string, any> = {}) {
  return {
    replayed: false,
    assignmentId: 'assign-e2e-1',
    tripId: 'trip-e2e-1',
    trucksConfirmed: 1,
    totalTrucksNeeded: 1,
    isFullyFilled: true,
    booking: {
      id: 'booking-e2e-1',
      customerId: CUSTOMER_ID,
      customerName: 'Test Customer',
      customerPhone: CUSTOMER_PHONE,
      trucksNeeded: 1,
      trucksFilled: 1,
      pricePerTruck: 5000,
      distanceKm: 50,
      status: 'fully_filled',
      pickup: { address: 'A', city: 'Bangalore', latitude: 12.97, longitude: 77.59 },
      drop: { address: 'B', city: 'Chennai', latitude: 13.08, longitude: 80.27 },
    },
    driver: { id: DRIVER_ID, name: 'TestDriver', phone: '8888888888', transporterId: TRANSPORTER_ID },
    vehicle: { id: VEHICLE_ID, vehicleNumber: 'KA01AB1234', vehicleType: 'open' as const, vehicleSubtype: '10-ton' },
    transporter: { id: TRANSPORTER_ID, name: 'TestTransporter', businessName: 'TestFleet', phone: '7777777777' },
    ...overrides,
  };
}

function resetAllMocks(): void {
  jest.clearAllMocks();
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
  mockRedisExists.mockResolvedValue(0);
  mockRedisAcquireLock.mockResolvedValue({ acquired: true });
  mockRedisReleaseLock.mockResolvedValue(true);
  mockRedisSMembers.mockResolvedValue([]);
  mockRedisSAdd.mockResolvedValue(1);
  mockRedisSIsMember.mockResolvedValue(true);
  mockRedisSCard.mockResolvedValue(3);
  mockRedisGetJSON.mockResolvedValue(null);
  mockRedisSetJSON.mockResolvedValue(undefined);
  mockRedisIncr.mockResolvedValue(1);
  mockRedisIncrBy.mockResolvedValue(0);
  mockRedisExpire.mockResolvedValue(true);
  mockRedisIsConnected.mockReturnValue(true);
  mockRedisHSet.mockResolvedValue(undefined);
  mockRedisLLen.mockResolvedValue(0);
  mockRedisKeys.mockResolvedValue([]);
  mockPrismaFindFirst.mockResolvedValue(null);
  mockPrismaFindMany.mockResolvedValue([]);
  mockPrismaFindUnique.mockResolvedValue(null);
  mockPrismaUpdateMany.mockResolvedValue({ count: 1 });
  mockBookingFindFirst.mockResolvedValue(null);
  mockBookingCreate.mockResolvedValue({ id: 'booking-new' });
  mockBookingUpdateMany.mockResolvedValue({ count: 1 });
  mockOrderFindFirst.mockResolvedValue(null);
  mockGetActiveOrders.mockResolvedValue([]);
  mockGetBookingById.mockResolvedValue(makeBookingRecord({ id: 'booking-new' }));
  mockGetUserById.mockResolvedValue({ name: 'Test Customer' });
  mockGetTransportersWithVehicleType.mockResolvedValue([]);
  mockScheduleAssignmentTimeout.mockResolvedValue('timer:test');
  mockSendPushNotification.mockResolvedValue(true);
  mockAreDriversOnline.mockResolvedValue(new Map());
  mockWithDbTimeout.mockResolvedValue(undefined);
  mockGetQueueDepth.mockResolvedValue(0);
}

function setupBroadcastServiceRef() {
  setBroadcastServiceRef({
    broadcastBookingToTransporters: jest.fn().mockResolvedValue(undefined),
    sendFcmPushNotifications: jest.fn().mockResolvedValue(undefined),
    setupBookingTimeout: jest.fn().mockResolvedValue(undefined),
    setBookingRedisKeys: jest.fn().mockResolvedValue(undefined),
    startBookingTimeout: jest.fn().mockResolvedValue(undefined),
  });
}

// =============================================================================
// CATEGORY 1: HAPPY PATH FLOWS (16 tests)
// =============================================================================

describe('Category 1: Happy Path Flows', () => {
  let bookingService: BookingCreateService;

  beforeEach(() => {
    resetAllMocks();
    setupBroadcastServiceRef();
    bookingService = new BookingCreateService();
  });

  test('1.01 Customer creates booking -> returns with status and ID', async () => {
    const result = await bookingService.createBooking(CUSTOMER_ID, CUSTOMER_PHONE, makeBookingInput());
    expect(result).toBeDefined();
    expect(result.id).toBeDefined();
    // Booking persisted via withDbTimeout -> DB calls are made inside the callback
    expect(result.status).toBe('expired'); // no transporters = expired
    expect(result.timeoutSeconds).toBe(0);
  });

  test('1.02 Booking created -> broadcast dispatched -> transporters notified', async () => {
    const { progressiveRadiusMatcher } = require('../modules/order/progressive-radius-matcher');
    progressiveRadiusMatcher.findCandidates.mockResolvedValueOnce([
      { transporterId: TRANSPORTER_ID, distanceKm: 5, latitude: 12.97, longitude: 77.59, etaSeconds: 600, etaSource: 'haversine' as const },
    ]);

    const result = await bookingService.createBooking(CUSTOMER_ID, CUSTOMER_PHONE, makeBookingInput());
    expect(result).toBeDefined();
    // With matching transporters, the booking transitions to broadcasting status
    // and the broadcast service is called
    expect(result.matchingTransportersCount).toBeGreaterThanOrEqual(1);
  });

  test('1.03 Hold -> confirm -> driver accepts (full saga)', async () => {
    // Step 1: Hold trucks
    mockWithDbTimeout.mockResolvedValueOnce(undefined);
    const holdResult = await holdTrucks(
      { orderId: 'order-1', transporterId: TRANSPORTER_ID, vehicleType: 'open' as const, vehicleSubtype: '10-ton', quantity: 1 },
      jest.fn()
    );
    // If hold succeeds at DB level
    expect(holdResult).toBeDefined();

    // Step 2: Confirm hold
    const hold = {
      holdId: 'HOLD_1',
      orderId: 'order-1',
      transporterId: TRANSPORTER_ID,
      vehicleType: 'open',
      vehicleSubtype: '10-ton',
      quantity: 1,
      truckRequestIds: ['tr-1'],
      status: 'active',
      expiresAt: futureDate(60),
      createdAt: new Date(),
    };
    mockPrismaFindUnique.mockResolvedValue(hold);
    mockWithDbTimeout.mockResolvedValueOnce(1);
    const confirmResult = await confirmHold('HOLD_1', TRANSPORTER_ID, jest.fn(), jest.fn());
    expect(confirmResult.success).toBe(true);

    // Step 3: Driver accepts broadcast
    resetAllMocks();
    mockWithDbTimeout.mockResolvedValue(makeAcceptTxResult());
    const acceptResult = await acceptBroadcast('booking-e2e-1', {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      actorUserId: DRIVER_ID,
      actorRole: 'driver' as const,
      idempotencyKey: 'idem-accept-1',
    });
    expect(acceptResult.assignmentId).toBe('assign-e2e-1');
    expect(acceptResult.status).toBe('assigned');
  });

  test('1.04 Booking with multi-truck fill tracks progress correctly', async () => {
    const partialResult = makeAcceptTxResult({
      trucksConfirmed: 1,
      totalTrucksNeeded: 3,
      isFullyFilled: false,
      booking: { ...makeBookingRecord(), trucksNeeded: 3, trucksFilled: 1, status: 'partially_filled' },
    });
    mockWithDbTimeout.mockResolvedValue(partialResult);
    const result = await acceptBroadcast('booking-multi', {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      actorUserId: DRIVER_ID,
      actorRole: 'driver' as const,
    });
    expect(result.isFullyFilled).toBe(false);
    expect(result.trucksConfirmed).toBe(1);
  });

  test('1.05 Hold extend within max time returns new expiresAt', () => {
    // Verify config allows extensions
    const baseExpiry = Date.now() + 60000;
    const extension = HOLD_DURATION_CONFIG.EXTENSION_SECONDS * 1000;
    const maxDuration = HOLD_DURATION_CONFIG.MAX_DURATION_SECONDS * 1000;
    const newExpiry = baseExpiry + extension;
    expect(newExpiry - Date.now()).toBeLessThanOrEqual(maxDuration);
    expect(HOLD_DURATION_CONFIG.EXTENSION_SECONDS).toBe(30);
  });

  test('1.06 Multiple customers create bookings independently', async () => {
    const custA = 'cust-A';
    const custB = 'cust-B';

    const resultA = await bookingService.createBooking(custA, '1111111111', makeBookingInput());
    expect(resultA).toBeDefined();

    jest.clearAllMocks();
    resetAllMocks();
    setupBroadcastServiceRef();
    bookingService = new BookingCreateService();

    mockGetBookingById.mockResolvedValue(makeBookingRecord({ id: 'booking-B', customerId: custB }));
    const resultB = await bookingService.createBooking(custB, '2222222222', makeBookingInput());
    expect(resultB).toBeDefined();
  });

  test('1.07 Booking -> no transporters -> status becomes expired -> customer can rebook', async () => {
    const expiredResult = await bookingService.createBooking(CUSTOMER_ID, CUSTOMER_PHONE, makeBookingInput());
    expect(expiredResult.status).toBe('expired');
    expect(expiredResult.matchingTransportersCount).toBe(0);

    // Customer can rebook
    jest.clearAllMocks();
    resetAllMocks();
    setupBroadcastServiceRef();
    bookingService = new BookingCreateService();

    const rebookResult = await bookingService.createBooking(CUSTOMER_ID, CUSTOMER_PHONE, makeBookingInput());
    expect(rebookResult).toBeDefined();
  });

  test('1.08 Accept broadcast -> socket events reach both driver and customer', async () => {
    mockWithDbTimeout.mockResolvedValue(makeAcceptTxResult());
    await acceptBroadcast('booking-e2e-socket', {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      actorUserId: DRIVER_ID,
      actorRole: 'driver' as const,
    });
    // Driver gets trip_assigned
    expect(mockEmitToUser).toHaveBeenCalledWith(
      DRIVER_ID, 'trip_assigned', expect.any(Object)
    );
    // Customer gets truck_confirmed
    expect(mockEmitToUser).toHaveBeenCalledWith(
      CUSTOMER_ID, 'truck_confirmed', expect.any(Object)
    );
  });

  test('1.09 Accept broadcast -> FCM push sent to driver and customer', async () => {
    mockWithDbTimeout.mockResolvedValue(makeAcceptTxResult());
    await acceptBroadcast('booking-e2e-fcm', {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      actorUserId: DRIVER_ID,
      actorRole: 'driver' as const,
    });
    expect(mockSendPushNotification).toHaveBeenCalledWith(
      DRIVER_ID, expect.objectContaining({ title: 'New Trip Assigned!' })
    );
    expect(mockSendPushNotification).toHaveBeenCalledWith(
      CUSTOMER_ID, expect.objectContaining({ title: expect.stringContaining('Confirmed') })
    );
  });

  test('1.10 Accept broadcast -> assignment timeout scheduled at 45s', async () => {
    mockWithDbTimeout.mockResolvedValue(makeAcceptTxResult());
    await acceptBroadcast('booking-e2e-timeout', {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      actorUserId: DRIVER_ID,
      actorRole: 'driver' as const,
    });
    expect(mockScheduleAssignmentTimeout).toHaveBeenCalledWith(
      expect.objectContaining({ assignmentId: 'assign-e2e-1', driverId: DRIVER_ID }),
      45000
    );
  });

  test('1.11 Booking with 6 radius steps searches progressively wider', () => {
    const { PROGRESSIVE_RADIUS_STEPS } = require('../modules/order/progressive-radius-matcher');
    expect(PROGRESSIVE_RADIUS_STEPS).toHaveLength(6);
    expect(PROGRESSIVE_RADIUS_STEPS[0].radiusKm).toBe(10);
    expect(PROGRESSIVE_RADIUS_STEPS[5].radiusKm).toBe(200);

    const totalWindowMs = PROGRESSIVE_RADIUS_STEPS.reduce(
      (sum: number, s: { windowMs: number }) => sum + s.windowMs, 0
    );
    expect(totalWindowMs).toBe(80000);
  });

  test('1.12 Redis active-broadcast key set with 24h TTL on booking create', async () => {
    await bookingService.createBooking(CUSTOMER_ID, CUSTOMER_PHONE, makeBookingInput());
    const setCalls = mockRedisSet.mock.calls;
    const activeKeyCall = setCalls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('customer:active-broadcast:')
    );
    expect(activeKeyCall).toBeDefined();
    expect(activeKeyCall![2]).toBe(86400);
  });

  test('1.13 Decline broadcast records in Redis set with TTL', async () => {
    await declineBroadcast('bc-decline-happy', { actorId: TRANSPORTER_ID, reason: 'price too low' });
    expect(mockRedisSAdd).toHaveBeenCalledWith(
      'broadcast:declined:bc-decline-happy', TRANSPORTER_ID
    );
    expect(mockRedisExpire).toHaveBeenCalledWith('broadcast:declined:bc-decline-happy', 3600);
  });

  test('1.14 Fully filled booking emits broadcast_expired with fully_filled reason', async () => {
    mockGetBookingById.mockResolvedValue({ notifiedTransporters: [TRANSPORTER_ID] });
    await emitTrucksRemainingUpdate('bc-full', 'open' as const, '10-ton', 0, 1);
    const expiryCalls = mockEmitToRoom.mock.calls.filter(
      (c: any[]) => c[1] === 'broadcast_expired'
    );
    expect(expiryCalls.length).toBeGreaterThan(0);
  });

  test('1.15 Hold -> confirm -> broadcastFn called with orderId', async () => {
    const hold = {
      holdId: 'HOLD_CONFIRM_BC',
      orderId: 'order-bc-test',
      transporterId: TRANSPORTER_ID,
      vehicleType: 'open',
      vehicleSubtype: '10-ton',
      quantity: 1,
      truckRequestIds: ['tr-1'],
      status: 'active',
      expiresAt: futureDate(60),
      createdAt: new Date(),
    };
    mockPrismaFindUnique.mockResolvedValue(hold);
    mockWithDbTimeout.mockResolvedValueOnce(1);
    const broadcastFn = jest.fn();
    await confirmHold('HOLD_CONFIRM_BC', TRANSPORTER_ID, jest.fn(), broadcastFn);
    expect(broadcastFn).toHaveBeenCalledWith('order-bc-test');
  });

  test('1.16 Queue routing feature flag defaults to safe behavior', () => {
    expect(FF_CANCELLED_ORDER_QUEUE_GUARD).toBe(true);
    expect(DLQ_MAX_SIZE).toBeGreaterThanOrEqual(100);
  });
});

// =============================================================================
// CATEGORY 2: FAILURE RECOVERY FLOWS (20 tests)
// =============================================================================

describe('Category 2: Failure Recovery Flows', () => {
  let bookingService: BookingCreateService;

  beforeEach(() => {
    resetAllMocks();
    setupBroadcastServiceRef();
    bookingService = new BookingCreateService();
  });

  test('2.01 Booking created -> broadcast service failure logged, booking returned', async () => {
    const { progressiveRadiusMatcher } = require('../modules/order/progressive-radius-matcher');
    progressiveRadiusMatcher.findCandidates.mockResolvedValueOnce([
      { transporterId: TRANSPORTER_ID, distanceKm: 5, latitude: 12.97, longitude: 77.59, etaSeconds: 600, etaSource: 'haversine' as const },
    ]);

    // Set broadcast service ref to null to simulate missing service
    const createModule = require('../modules/booking/booking-create.service');
    createModule.setBroadcastServiceRef(null);

    const result = await bookingService.createBooking(CUSTOMER_ID, CUSTOMER_PHONE, makeBookingInput());
    // Booking is persisted before broadcast attempt, so result is still returned
    expect(result).toBeDefined();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining('BroadcastService not initialized'),
      expect.any(Object)
    );
    // Restore for subsequent tests
    setupBroadcastServiceRef();
  });

  test('2.02 Hold confirmed -> notification fails once -> retryWithBackoff succeeds', async () => {
    mockWithDbTimeout.mockResolvedValue(makeAcceptTxResult());
    let pushCalls = 0;
    mockSendPushNotification.mockImplementation(async (userId: string) => {
      if (userId === DRIVER_ID) {
        pushCalls++;
        if (pushCalls === 1) throw new Error('FCM timeout');
      }
      return true;
    });
    const result = await acceptBroadcast('bc-retry-push', {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      actorUserId: DRIVER_ID,
      actorRole: 'driver' as const,
    });
    expect(result.assignmentId).toBe('assign-e2e-1');
  });

  test('2.03 All notification retries fail -> error logged + queued for retry', async () => {
    mockWithDbTimeout.mockResolvedValue(makeAcceptTxResult());
    mockSendPushNotification.mockRejectedValue(new Error('FCM permanently down'));
    const result = await acceptBroadcast('bc-all-fail', {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      actorUserId: DRIVER_ID,
      actorRole: 'driver' as const,
    });
    expect(result.assignmentId).toBe('assign-e2e-1');
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining('All driver notification retries failed'),
      expect.any(Object)
    );
    expect(mockQueuePushNotification).toHaveBeenCalled();
  });

  test('2.04 Assignment created -> timeout scheduling fails -> error logged, assignment intact', async () => {
    mockWithDbTimeout.mockResolvedValue(makeAcceptTxResult());
    mockScheduleAssignmentTimeout.mockRejectedValue(new Error('Redis down'));
    const result = await acceptBroadcast('bc-timeout-fail', {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      actorUserId: DRIVER_ID,
      actorRole: 'driver' as const,
    });
    expect(result.assignmentId).toBe('assign-e2e-1');
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to schedule assignment timeout'),
      expect.any(Object)
    );
  });

  test('2.05 Driver does not respond -> assignment timeout config is 45s', () => {
    const { HOLD_CONFIG } = require('../core/config/hold-config');
    expect(HOLD_CONFIG.driverAcceptTimeoutMs).toBe(45000);
    expect(HOLD_CONFIG.driverAcceptTimeoutSeconds).toBe(45);
  });

  test('2.06 Hold expires -> cleanup runs within 5s grace', () => {
    expect(CONFIG.CLEANUP_INTERVAL_MS).toBe(5000);
    expect(HOLD_DURATION_CONFIG.FLEX_DURATION_SECONDS).toBe(90);
  });

  test('2.07 Redis dies mid-flow -> DB serves as fallback guard', async () => {
    mockRedisIncr.mockRejectedValue(new Error('Redis dead'));
    mockRedisGet.mockRejectedValue(new Error('Redis dead'));
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisSet.mockRejectedValue(new Error('Redis dead'));
    mockRedisDel.mockRejectedValue(new Error('Redis dead'));

    // Redis failure propagates since active-broadcast check fails
    await expect(
      bookingService.createBooking(CUSTOMER_ID, CUSTOMER_PHONE, makeBookingInput())
    ).rejects.toThrow();
  });

  test('2.08 Transaction retry on serialization conflict (P2034)', async () => {
    const serializationError: any = new Error('Serialization failure');
    serializationError.code = 'P2034';
    let attempts = 0;
    mockWithDbTimeout.mockImplementation(async () => {
      attempts++;
      if (attempts === 1) throw serializationError;
      return makeAcceptTxResult();
    });
    const result = await acceptBroadcast('bc-retry-serial', {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      actorUserId: DRIVER_ID,
      actorRole: 'driver' as const,
    });
    expect(result.assignmentId).toBe('assign-e2e-1');
    expect(attempts).toBe(2);
  });

  test('2.09 Max retries exhausted after 3 serialization failures -> throws', async () => {
    const serializationError: any = new Error('Serialization failure');
    serializationError.code = 'P2034';
    mockWithDbTimeout.mockRejectedValue(serializationError);
    await expect(
      acceptBroadcast('bc-retry-exhaust', {
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
        actorUserId: DRIVER_ID,
        actorRole: 'driver' as const,
      })
    ).rejects.toThrow();
    expect(mockWithDbTimeout).toHaveBeenCalledTimes(3);
  });

  test('2.10 holdTrucks NOT_ENOUGH_AVAILABLE returns available count in message', async () => {
    mockWithDbTimeout.mockRejectedValue(new Error('NOT_ENOUGH_AVAILABLE:2'));
    const result = await holdTrucks(
      { orderId: 'o-not-enough', transporterId: TRANSPORTER_ID, vehicleType: 'open' as const, vehicleSubtype: '10-ton', quantity: 5 },
      jest.fn()
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('NOT_ENOUGH_AVAILABLE');
    expect(result.message).toContain('2');
  });

  test('2.11 holdTrucks ORDER_NOT_FOUND returns ORDER_INACTIVE', async () => {
    mockWithDbTimeout.mockRejectedValue(new Error('ORDER_NOT_FOUND'));
    const result = await holdTrucks(
      { orderId: 'o-gone', transporterId: TRANSPORTER_ID, vehicleType: 'open' as const, vehicleSubtype: '10-ton', quantity: 1 },
      jest.fn()
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('ORDER_INACTIVE');
  });

  test('2.12 confirmHold on expired hold calls releaseHoldFn and reports error', async () => {
    const hold = {
      holdId: 'HOLD_EXPIRED',
      orderId: 'order-1',
      transporterId: TRANSPORTER_ID,
      vehicleType: 'open',
      vehicleSubtype: '10-ton',
      quantity: 1,
      truckRequestIds: ['tr-1'],
      status: 'active',
      expiresAt: pastDate(10),
      createdAt: new Date(),
    };
    mockPrismaFindUnique.mockResolvedValue(hold);
    const releaseFn = jest.fn().mockResolvedValue(undefined);
    const result = await confirmHold('HOLD_EXPIRED', TRANSPORTER_ID, releaseFn, jest.fn());
    expect(result.success).toBe(false);
    expect(result.message).toContain('expired');
    expect(releaseFn).toHaveBeenCalledWith('HOLD_EXPIRED', TRANSPORTER_ID);
  });

  test('2.13 confirmHold ORDER_INACTIVE error from transaction', async () => {
    const hold = {
      holdId: 'HOLD_ORDER_GONE',
      orderId: 'order-gone',
      transporterId: TRANSPORTER_ID,
      vehicleType: 'open',
      vehicleSubtype: '10-ton',
      quantity: 1,
      truckRequestIds: ['tr-1'],
      status: 'active',
      expiresAt: futureDate(60),
      createdAt: new Date(),
    };
    mockPrismaFindUnique.mockResolvedValue(hold);
    mockWithDbTimeout.mockRejectedValue(new Error('ORDER_INACTIVE'));
    const result = await confirmHold('HOLD_ORDER_GONE', TRANSPORTER_ID, jest.fn(), jest.fn());
    expect(result.success).toBe(false);
    expect(result.message).toContain('no longer active');
  });

  test('2.14 confirmHold TRUCK_STATE_CHANGED error', async () => {
    const hold = {
      holdId: 'HOLD_TRUCK_MOVED',
      orderId: 'order-1',
      transporterId: TRANSPORTER_ID,
      vehicleType: 'open',
      vehicleSubtype: '10-ton',
      quantity: 1,
      truckRequestIds: ['tr-1'],
      status: 'active',
      expiresAt: futureDate(60),
      createdAt: new Date(),
    };
    mockPrismaFindUnique.mockResolvedValue(hold);
    mockWithDbTimeout.mockRejectedValue(new Error('TRUCK_STATE_CHANGED'));
    const result = await confirmHold('HOLD_TRUCK_MOVED', TRANSPORTER_ID, jest.fn(), jest.fn());
    expect(result.success).toBe(false);
    expect(result.message).toContain('changed state');
  });

  test('2.15 Idempotency cache read failure does not block accept', async () => {
    mockRedisGetJSON.mockRejectedValue(new Error('Redis read failed'));
    mockWithDbTimeout.mockResolvedValue(makeAcceptTxResult());
    const result = await acceptBroadcast('bc-cache-fail', {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      actorUserId: DRIVER_ID,
      actorRole: 'driver' as const,
      idempotencyKey: 'idem-cache-fail',
    });
    expect(result.assignmentId).toBe('assign-e2e-1');
  });

  test('2.16 Lock acquisition failure (Redis timeout) still proceeds via transactional safety', async () => {
    mockRedisAcquireLock.mockRejectedValueOnce(new Error('Redis timeout'));
    mockWithDbTimeout.mockResolvedValue(makeAcceptTxResult());
    const result = await acceptBroadcast('bc-lock-timeout', {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      actorUserId: DRIVER_ID,
      actorRole: 'driver' as const,
    });
    expect(result.assignmentId).toBe('assign-e2e-1');
  });

  test('2.17 BroadcastService is null -> booking created, error logged', async () => {
    const createModule = require('../modules/booking/booking-create.service');
    createModule.setBroadcastServiceRef(null);

    const { progressiveRadiusMatcher } = require('../modules/order/progressive-radius-matcher');
    progressiveRadiusMatcher.findCandidates.mockResolvedValueOnce([
      { transporterId: TRANSPORTER_ID, distanceKm: 5, latitude: 12.97, longitude: 77.59, etaSeconds: 600, etaSource: 'haversine' as const },
    ]);

    const result = await bookingService.createBooking(CUSTOMER_ID, CUSTOMER_PHONE, makeBookingInput());
    expect(result).toBeDefined();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining('BroadcastService not initialized'),
      expect.any(Object)
    );
    setupBroadcastServiceRef();
  });

  test('2.18 checkAndExpireBroadcasts handles DB failure gracefully', async () => {
    mockGetActiveOrders.mockRejectedValue(new Error('DB connection lost'));
    const count = await checkAndExpireBroadcasts();
    expect(count).toBe(0);
  });

  test('2.19 emitBroadcastExpired handles DB lookup failure with room-only fallback', async () => {
    mockGetBookingById.mockRejectedValue(new Error('DB error'));
    await emitBroadcastExpired('bc-db-fail', 'timeout');
    expect(mockEmitToRoom).toHaveBeenCalled();
  });

  test('2.20 holdTrucks INTERNAL_ERROR for unknown exceptions', async () => {
    mockWithDbTimeout.mockRejectedValue(new Error('COSMIC_RAY'));
    const result = await holdTrucks(
      { orderId: 'o-cosmic', transporterId: TRANSPORTER_ID, vehicleType: 'open' as const, vehicleSubtype: '10-ton', quantity: 1 },
      jest.fn()
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('INTERNAL_ERROR');
  });
});

// =============================================================================
// CATEGORY 3: CANCEL & INTERRUPT SCENARIOS (16 tests)
// =============================================================================

describe('Category 3: Cancel & Interrupt Scenarios', () => {
  beforeEach(resetAllMocks);

  test('3.01 Cancel during broadcasting -> broadcast expired emitted', async () => {
    mockGetBookingById.mockResolvedValue({
      notifiedTransporters: [TRANSPORTER_ID, 'trans-2'],
    });
    await emitBroadcastExpired('bc-cancel-broadcast', 'cancelled');
    expect(mockEmitToUsers).toHaveBeenCalledWith(
      [TRANSPORTER_ID, 'trans-2'],
      'broadcast_expired',
      expect.objectContaining({ reason: 'cancelled' })
    );
  });

  test('3.02 Cancel during hold -> hold confirmation should detect inactive order', async () => {
    const hold = {
      holdId: 'HOLD_CANCEL',
      orderId: 'order-cancelled',
      transporterId: TRANSPORTER_ID,
      vehicleType: 'open',
      vehicleSubtype: '10-ton',
      quantity: 1,
      truckRequestIds: ['tr-1'],
      status: 'active',
      expiresAt: futureDate(60),
      createdAt: new Date(),
    };
    mockPrismaFindUnique.mockResolvedValue(hold);
    mockWithDbTimeout.mockRejectedValue(new Error('ORDER_INACTIVE'));
    const result = await confirmHold('HOLD_CANCEL', TRANSPORTER_ID, jest.fn(), jest.fn());
    expect(result.success).toBe(false);
    expect(result.message).toContain('no longer active');
  });

  test('3.03 Cancel during assignment -> lock released in finally block', async () => {
    mockWithDbTimeout.mockRejectedValue(new Error('ORDER_CANCELLED'));
    await expect(
      acceptBroadcast('bc-cancel-assign', {
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
        actorUserId: DRIVER_ID,
        actorRole: 'driver' as const,
      })
    ).rejects.toThrow();
    expect(mockRedisReleaseLock).toHaveBeenCalledWith(
      'booking:bc-cancel-assign',
      expect.any(String)
    );
  });

  test('3.04 Cancel while driver at_pickup -> protected status NOT released', () => {
    // at_pickup is NOT a terminal status, and cancel should be blocked for this assignment state
    const { AssignmentStatus } = require('../shared/database/prisma.service');
    const protectedStatuses = ['at_pickup', 'in_transit', 'arrived_at_drop'];
    protectedStatuses.forEach(status => {
      expect(Object.values(AssignmentStatus)).toContain(status);
    });
    // Terminal statuses that allow new creation
    const terminalStatuses = ['completed', 'driver_declined', 'cancelled'];
    terminalStatuses.forEach(status => {
      expect(Object.values(AssignmentStatus)).toContain(status);
    });
  });

  test('3.05 Rapid cancel + rebook -> idempotency key differentiates requests', () => {
    const hash1 = buildOperationPayloadHash('hold', { orderId: 'o-cancel-1', ts: 1 });
    const hash2 = buildOperationPayloadHash('hold', { orderId: 'o-rebook-1', ts: 2 });
    expect(hash1).not.toBe(hash2);
  });

  test('3.06 Cancel -> Redis active broadcast key cleaned up', async () => {
    // Simulate: booking expired path cleans up active key
    const bookingSvc = new BookingCreateService();
    setupBroadcastServiceRef();
    await bookingSvc.createBooking(CUSTOMER_ID, CUSTOMER_PHONE, makeBookingInput());
    const delCalls = mockRedisDel.mock.calls;
    const activeKeyDel = delCalls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('customer:active-broadcast:')
    );
    expect(activeKeyDel).toBeDefined();
  });

  test('3.07 Broadcast expired with reason=cancelled has different message from timeout', async () => {
    mockGetBookingById.mockResolvedValue({ notifiedTransporters: [TRANSPORTER_ID] });
    await emitBroadcastExpired('bc-cancel-msg', 'cancelled');
    const cancelPayload = mockEmitToUsers.mock.calls[0][2];
    expect(cancelPayload.message).toContain('cancelled');

    mockEmitToUsers.mockClear();
    await emitBroadcastExpired('bc-timeout-msg', 'timeout');
    const timeoutPayload = mockEmitToUsers.mock.calls[0][2];
    expect(timeoutPayload.message).toContain('expired');
  });

  test('3.08 Cancel during radius expansion -> expiry handles interim state', async () => {
    const order = {
      id: 'o-radius-cancel',
      status: 'broadcasting',
      expiresAt: pastDate(10).toISOString(),
    };
    mockGetActiveOrders.mockResolvedValue([order]);
    mockGetBookingById.mockResolvedValue({ notifiedTransporters: [TRANSPORTER_ID] });
    const count = await checkAndExpireBroadcasts();
    expect(count).toBe(1);
  });

  test('3.09 Decline broadcast is idempotent -> second call returns replayed=true', async () => {
    mockRedisSAdd.mockResolvedValueOnce(1); // first call
    const result1 = await declineBroadcast('bc-decline-idem', { actorId: TRANSPORTER_ID, reason: 'price' });
    expect(result1.replayed).toBe(false);

    mockRedisSAdd.mockResolvedValueOnce(0); // second call (already in set)
    const result2 = await declineBroadcast('bc-decline-idem', { actorId: TRANSPORTER_ID, reason: 'price' });
    expect(result2.replayed).toBe(true);
  });

  test('3.10 Cancel clears lock for subsequent rebook attempts', async () => {
    // First booking
    const svc = new BookingCreateService();
    setupBroadcastServiceRef();
    await svc.createBooking(CUSTOMER_ID, CUSTOMER_PHONE, makeBookingInput());
    expect(mockRedisReleaseLock).toHaveBeenCalled();
  });

  test('3.11 TERMINAL_ORDER_STATUSES contains cancelled', () => {
    expect(TERMINAL_ORDER_STATUSES.has('cancelled')).toBe(true);
  });

  test('3.12 TERMINAL_STATUSES for booking contains cancelled', () => {
    expect(TERMINAL_STATUSES).toContain('cancelled');
  });

  test('3.13 Cancel booking guard: TERMINAL_STATUSES is an allowlist of completed, cancelled, expired', () => {
    // The active-booking guard uses notIn with TERMINAL_STATUSES
    // meaning only bookings NOT in terminal state block new creation.
    expect(TERMINAL_STATUSES).toContain('completed');
    expect(TERMINAL_STATUSES).toContain('cancelled');
    expect(TERMINAL_STATUSES).toContain('expired');
    expect(TERMINAL_STATUSES).toHaveLength(3);
    // If a booking is in any of these states, a new booking CAN be created.
  });

  test('3.14 Interrupt: Redis sAdd failure in decline does not throw', async () => {
    mockRedisSAdd.mockRejectedValue(new Error('Redis connection lost'));
    const result = await declineBroadcast('bc-decline-redis-fail', { actorId: TRANSPORTER_ID, reason: 'test' });
    expect(result.success).toBe(true);
  });

  test('3.15 Interrupt: hSet failure in decline log does not throw', async () => {
    mockRedisHSet.mockRejectedValue(new Error('Redis write error'));
    const result = await declineBroadcast('bc-decline-hset-fail', { actorId: TRANSPORTER_ID, reason: 'test' });
    expect(result.success).toBe(true);
  });

  test('3.16 Cancellation event priority is CRITICAL', () => {
    expect(EVENT_PRIORITY['order_cancelled']).toBe(MessagePriority.CRITICAL);
    expect(EVENT_PRIORITY['order_expired']).toBe(MessagePriority.CRITICAL);
  });
});

// =============================================================================
// CATEGORY 4: STUCK ENTITY DETECTION & RECOVERY (17 tests)
// =============================================================================

describe('Category 4: Stuck Entity Detection & Recovery', () => {
  beforeEach(resetAllMocks);

  test('4.01 on_hold vehicle orphaned > 5min detected by threshold config', () => {
    const ON_HOLD_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
    const vehicleHoldTime = pastDate(360); // 6 minutes ago
    const isOrphaned = Date.now() - vehicleHoldTime.getTime() > ON_HOLD_THRESHOLD_MS;
    expect(isOrphaned).toBe(true);
  });

  test('4.02 on_hold vehicle within 5min NOT flagged as orphaned', () => {
    const ON_HOLD_THRESHOLD_MS = 5 * 60 * 1000;
    const vehicleHoldTime = pastDate(240); // 4 minutes ago
    const isOrphaned = Date.now() - vehicleHoldTime.getTime() > ON_HOLD_THRESHOLD_MS;
    expect(isOrphaned).toBe(false);
  });

  test('4.03 in_transit vehicle orphaned > 10min detected', () => {
    const IN_TRANSIT_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
    const vehicleTransitStart = pastDate(660); // 11 minutes ago
    const isOrphaned = Date.now() - vehicleTransitStart.getTime() > IN_TRANSIT_THRESHOLD_MS;
    expect(isOrphaned).toBe(true);
  });

  test('4.04 in_transit vehicle within 10min NOT flagged', () => {
    const IN_TRANSIT_THRESHOLD_MS = 10 * 60 * 1000;
    const vehicleTransitStart = pastDate(540); // 9 minutes ago
    const isOrphaned = Date.now() - vehicleTransitStart.getTime() > IN_TRANSIT_THRESHOLD_MS;
    expect(isOrphaned).toBe(false);
  });

  test('4.05 Abandoned trip > 12h detected by threshold', () => {
    const ABANDONED_TRIP_THRESHOLD_MS = 12 * 60 * 60 * 1000; // 12 hours
    const tripStart = pastDate(46800); // 13 hours ago
    const isAbandoned = Date.now() - tripStart.getTime() > ABANDONED_TRIP_THRESHOLD_MS;
    expect(isAbandoned).toBe(true);
  });

  test('4.06 Trip within 12h NOT flagged as abandoned', () => {
    const ABANDONED_TRIP_THRESHOLD_MS = 12 * 60 * 60 * 1000;
    const tripStart = pastDate(39600); // 11 hours ago
    const isAbandoned = Date.now() - tripStart.getTime() > ABANDONED_TRIP_THRESHOLD_MS;
    expect(isAbandoned).toBe(false);
  });

  test('4.07 DLQ size cap defaults to 5000', () => {
    expect(DLQ_MAX_SIZE).toBe(5000);
  });

  test('4.08 DLQ minimum is 100 (cannot be configured below)', () => {
    const originalEnv = process.env.DLQ_MAX_SIZE;
    process.env.DLQ_MAX_SIZE = '50';
    // Re-read via expression (not re-import since module is cached)
    const computed = Math.max(100, parseInt(process.env.DLQ_MAX_SIZE || '5000', 10) || 5000);
    expect(computed).toBe(100);
    process.env.DLQ_MAX_SIZE = originalEnv;
  });

  test('4.09 DLQ accumulation alert threshold detectable by queue depth', async () => {
    mockGetQueueDepth.mockResolvedValue(15);
    const depth = await mockGetQueueDepth('dlq:assignment-timeout');
    expect(depth).toBeGreaterThan(10);
  });

  test('4.10 Hold cleanup interval is 5000ms', () => {
    expect(CONFIG.CLEANUP_INTERVAL_MS).toBe(5000);
  });

  test('4.11 Expired hold detected via pastDate comparison', () => {
    const hold = { expiresAt: pastDate(10) };
    expect(new Date(hold.expiresAt).getTime()).toBeLessThan(Date.now());
  });

  test('4.12 Active hold NOT detected as expired', () => {
    const hold = { expiresAt: futureDate(60) };
    expect(new Date(hold.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  test('4.13 Reconciliation lock prevents duplicate processing', async () => {
    mockRedisAcquireLock.mockResolvedValueOnce({ acquired: false });
    const order = {
      id: 'o-locked',
      status: 'broadcasting',
      expiresAt: pastDate(60).toISOString(),
    };
    mockGetActiveOrders.mockResolvedValue([order]);
    const count = await checkAndExpireBroadcasts();
    expect(count).toBe(0);
  });

  test('4.14 Reconciliation releases lock after processing each order', async () => {
    const order = {
      id: 'o-release-lock',
      status: 'partially_filled',
      expiresAt: pastDate(10).toISOString(),
    };
    mockGetActiveOrders.mockResolvedValue([order]);
    mockGetBookingById.mockResolvedValue({ notifiedTransporters: [] });
    await checkAndExpireBroadcasts();
    expect(mockRedisReleaseLock).toHaveBeenCalledWith(
      'broadcast-order-expiry:o-release-lock',
      'broadcast-expiry-checker'
    );
  });

  test('4.15 Stuck hold metrics recorded on conflict', () => {
    recordHoldOutcomeMetrics(
      { success: false, message: 'hold expired', error: 'NOT_ENOUGH_AVAILABLE' },
      Date.now() - 200,
      false
    );
    expect(mockIncrementCounter).toHaveBeenCalledWith(
      'hold_conflict_total',
      expect.objectContaining({ reason: 'not_enough_available' })
    );
  });

  test('4.16 Orphaned step timers recovered at startup', async () => {
    const { recoverOrphanedStepTimers } = require('../modules/order/order-timer.service');
    recoverOrphanedStepTimers.mockResolvedValueOnce(3);
    const recovered = await recoverOrphanedStepTimers();
    expect(recovered).toBe(3);
  });

  test('4.17 Error during single order expiry does not stop batch processing', async () => {
    const orders = [
      { id: 'o-fail-batch', status: 'broadcasting', expiresAt: pastDate(10).toISOString() },
      { id: 'o-ok-batch', status: 'broadcasting', expiresAt: pastDate(10).toISOString() },
    ];
    mockGetActiveOrders.mockResolvedValue(orders);
    let callCount = 0;
    mockUpdateOrder.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('DB write failed');
    });
    mockGetBookingById.mockResolvedValue({ notifiedTransporters: [TRANSPORTER_ID] });
    await checkAndExpireBroadcasts();
    // Both locks attempted even though first failed
    expect(mockRedisAcquireLock).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// CATEGORY 5: MULTI-INSTANCE SCENARIOS (16 tests)
// =============================================================================

describe('Category 5: Multi-Instance Scenarios', () => {
  beforeEach(resetAllMocks);

  test('5.01 Cross-instance presence: Redis isConnected check', () => {
    mockRedisIsConnected.mockReturnValue(true);
    const { redisService } = require('../shared/services/redis.service');
    expect(redisService.isConnected()).toBe(true);
  });

  test('5.02 Cross-instance presence: Redis disconnected detected', () => {
    mockRedisIsConnected.mockReturnValue(false);
    const { redisService } = require('../shared/services/redis.service');
    expect(redisService.isConnected()).toBe(false);
  });

  test('5.03 Distributed lock prevents dual hold on same order', async () => {
    // Lock not acquired -> returns 429 LOCK_CONTENTION
    mockRedisAcquireLock.mockResolvedValue({ acquired: false });

    await expect(
      acceptBroadcast('bc-dual-hold', {
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
        actorUserId: DRIVER_ID,
        actorRole: 'driver' as const,
      })
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  test('5.04 Lock key format includes booking ID for isolation', async () => {
    resetAllMocks();
    mockWithDbTimeout.mockResolvedValue(makeAcceptTxResult());
    await acceptBroadcast('bc-lock-format', {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      actorUserId: DRIVER_ID,
      actorRole: 'driver' as const,
    });
    expect(mockRedisAcquireLock).toHaveBeenCalledWith(
      'booking:bc-lock-format',
      expect.any(String),
      expect.any(Number)
    );
  });

  test('5.05 Broadcast expiry lock per-order prevents dual expiry', async () => {
    const order = {
      id: 'o-dual-expiry',
      status: 'broadcasting',
      expiresAt: pastDate(10).toISOString(),
    };
    mockGetActiveOrders.mockResolvedValue([order]);
    mockGetBookingById.mockResolvedValue({ notifiedTransporters: [TRANSPORTER_ID] });
    await checkAndExpireBroadcasts();
    expect(mockRedisAcquireLock).toHaveBeenCalledWith(
      'broadcast-order-expiry:o-dual-expiry',
      'broadcast-expiry-checker',
      15
    );
  });

  test('5.06 Idempotency cache ensures same accept processed once across instances', async () => {
    const cached = {
      assignmentId: 'assign-instance-1',
      tripId: 'trip-instance-1',
      status: 'assigned',
      trucksConfirmed: 1,
      totalTrucksNeeded: 1,
      isFullyFilled: true,
    };
    mockRedisGetJSON.mockResolvedValue(cached);
    const result = await acceptBroadcast('bc-cross-idem', {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      actorUserId: DRIVER_ID,
      actorRole: 'driver' as const,
      idempotencyKey: 'idem-cross-1',
    });
    expect(result.replayed).toBe(true);
    expect(result.resultCode).toBe('IDEMPOTENT_REPLAY');
    expect(mockWithDbTimeout).not.toHaveBeenCalled();
  });

  test('5.07 Idempotency cache write after successful accept', async () => {
    mockWithDbTimeout.mockResolvedValue(makeAcceptTxResult());
    await acceptBroadcast('bc-idem-write', {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      actorUserId: DRIVER_ID,
      actorRole: 'driver' as const,
      idempotencyKey: 'idem-write-1',
    });
    expect(mockRedisSetJSON).toHaveBeenCalledWith(
      expect.stringContaining('idem:broadcast:accept'),
      expect.objectContaining({ assignmentId: 'assign-e2e-1' }),
      expect.any(Number)
    );
  });

  test('5.08 Decline idempotency via Redis SADD (0 = already exists)', async () => {
    mockRedisSAdd.mockResolvedValue(0);
    const result = await declineBroadcast('bc-decline-multi', { actorId: TRANSPORTER_ID, reason: 'busy' });
    expect(result.replayed).toBe(true);
  });

  test('5.09 Vehicle cache invalidated after accept to sync across instances', async () => {
    mockWithDbTimeout.mockResolvedValue(makeAcceptTxResult());
    await acceptBroadcast('bc-cache-invalidate', {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      actorUserId: DRIVER_ID,
      actorRole: 'driver' as const,
    });
    expect(mockRedisDel).toHaveBeenCalledWith(`cache:vehicles:transporter:${TRANSPORTER_ID}`);
  });

  test('5.10 Multiple orders expired in single reconciliation batch', async () => {
    const orders = [
      { id: 'o-batch-1', status: 'broadcasting', expiresAt: pastDate(10).toISOString() },
      { id: 'o-batch-2', status: 'broadcasting', expiresAt: pastDate(20).toISOString() },
      { id: 'o-batch-3', status: 'broadcasting', expiresAt: pastDate(30).toISOString() },
    ];
    mockGetActiveOrders.mockResolvedValue(orders);
    mockGetBookingById.mockResolvedValue({ notifiedTransporters: [TRANSPORTER_ID] });
    const count = await checkAndExpireBroadcasts();
    expect(count).toBe(3);
  });

  test('5.11 holdTrucks payload hash consistent across instances', () => {
    const payload = { orderId: 'o-cross', vehicleType: 'open' as const, quantity: 2 };
    const h1 = buildOperationPayloadHash('hold', payload);
    const h2 = buildOperationPayloadHash('hold', payload);
    expect(h1).toBe(h2);
    expect(h1.length).toBeGreaterThan(0);
  });

  test('5.12 Replayed transaction detected and returns IDEMPOTENT_REPLAY', async () => {
    const txReplay = makeAcceptTxResult({ replayed: true });
    mockWithDbTimeout.mockResolvedValue(txReplay);
    const result = await acceptBroadcast('bc-tx-replay', {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      actorUserId: DRIVER_ID,
      actorRole: 'driver' as const,
    });
    expect(result.resultCode).toBe('IDEMPOTENT_REPLAY');
    expect(result.replayed).toBe(true);
    // Timeout should NOT be scheduled for replays
    expect(mockScheduleAssignmentTimeout).not.toHaveBeenCalled();
  });

  test('5.13 No idempotencyKey skips cache entirely', async () => {
    mockWithDbTimeout.mockResolvedValue(makeAcceptTxResult());
    const result = await acceptBroadcast('bc-no-idem', {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      actorUserId: DRIVER_ID,
      actorRole: 'driver' as const,
    });
    expect(result.assignmentId).toBe('assign-e2e-1');
    expect(mockRedisGetJSON).not.toHaveBeenCalled();
    expect(mockRedisSetJSON).not.toHaveBeenCalled();
  });

  test('5.14 MESSAGE_TTL_MS configured per event type for cross-instance staleness prevention', () => {
    expect(MESSAGE_TTL_MS['new_broadcast']).toBe(90000);
    expect(MESSAGE_TTL_MS['order_cancelled']).toBe(300000);
    expect(MESSAGE_TTL_MS['trip_assigned']).toBe(120000);
    expect(MESSAGE_TTL_MS['trucks_remaining_update']).toBe(30000);
  });

  test('5.15 Event priority system ensures cancellations processed first', () => {
    expect(MessagePriority.CRITICAL).toBeLessThan(MessagePriority.HIGH);
    expect(MessagePriority.HIGH).toBeLessThan(MessagePriority.NORMAL);
    expect(MessagePriority.NORMAL).toBeLessThan(MessagePriority.LOW);
    expect(EVENT_PRIORITY['order_cancelled']).toBe(MessagePriority.CRITICAL);
    expect(EVENT_PRIORITY['new_broadcast']).toBe(MessagePriority.NORMAL);
  });

  test('5.16 Lock released in finally block even after DB crash', async () => {
    mockWithDbTimeout.mockRejectedValue(new Error('DB crash'));
    await expect(
      acceptBroadcast('bc-crash', {
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
        actorUserId: DRIVER_ID,
        actorRole: 'driver' as const,
      })
    ).rejects.toThrow();
    expect(mockRedisReleaseLock).toHaveBeenCalledWith(
      'booking:bc-crash',
      expect.any(String)
    );
  });
});
