/**
 * =============================================================================
 * CRITICAL FIXES — C-03 (Auto-Redispatch) + C-18 (Payment Trigger Outbox)
 * =============================================================================
 *
 * C-03 Tests:
 *   1. tryAutoRedispatch finds and assigns next driver
 *   2. tryAutoRedispatch skips when max attempts reached
 *   3. tryAutoRedispatch skips declined driver
 *   4. tryAutoRedispatch gracefully handles no candidates
 *   5. declineAssignment calls tryAutoRedispatch (integration check)
 *
 * C-18 Tests:
 *   6. Completion writes trip_completed outbox row
 *   7. Outbox handler emits payment_pending socket event
 *   8. Outbox handler calls fcmService.notifyPayment
 *   9. Outbox write failure does not break completion
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

// ---------- Redis service mock ----------
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisIncr = jest.fn().mockResolvedValue(1);
const mockRedisExpire = jest.fn().mockResolvedValue(undefined);
const mockRedisExists = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisSMembers = jest.fn();
const mockRedisSAdd = jest.fn();
const mockRedisGetJSON = jest.fn();
const mockRedisSetJSON = jest.fn();
const mockRedisCancelTimer = jest.fn();
const mockRedisSetTimer = jest.fn();
const mockRedisIncrBy = jest.fn().mockResolvedValue(0);
const mockRedisSIsMember = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: unknown[]) => mockRedisGet(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
    incr: (...args: unknown[]) => mockRedisIncr(...args),
    expire: (...args: unknown[]) => mockRedisExpire(...args),
    exists: (...args: unknown[]) => mockRedisExists(...args),
    acquireLock: (...args: unknown[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: unknown[]) => mockRedisReleaseLock(...args),
    sMembers: (...args: unknown[]) => mockRedisSMembers(...args),
    sAdd: (...args: unknown[]) => mockRedisSAdd(...args),
    getJSON: (...args: unknown[]) => mockRedisGetJSON(...args),
    setJSON: (...args: unknown[]) => mockRedisSetJSON(...args),
    cancelTimer: (...args: unknown[]) => mockRedisCancelTimer(...args),
    setTimer: (...args: unknown[]) => mockRedisSetTimer(...args),
    incrBy: (...args: unknown[]) => mockRedisIncrBy(...args),
    sIsMember: (...args: unknown[]) => mockRedisSIsMember(...args),
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
    isConnected: () => true,
  },
}));

// ---------- Prisma mock ----------
const mockUserFindMany = jest.fn();
const mockUserFindUnique = jest.fn();
const mockAssignmentCreate = jest.fn();
const mockAssignmentFindFirst = jest.fn();
const mockAssignmentFindMany = jest.fn();
const mockAssignmentUpdate = jest.fn();
const mockAssignmentUpdateMany = jest.fn();
const mockVehicleFindUnique = jest.fn();
const mockVehicleUpdateMany = jest.fn();
const mockVehicleUpdate = jest.fn();
const mockBookingFindUnique = jest.fn();
const mockBookingUpdate = jest.fn();
const mockBookingUpdateMany = jest.fn();
const mockOrderFindUnique = jest.fn();
const mockOrderFindFirst = jest.fn();
const mockTransaction = jest.fn();
const mockQueryRaw = jest.fn();
const mockExecuteRaw = jest.fn();
const mockOutboxCreate = jest.fn();
const mockOutboxUpdate = jest.fn();
const mockOutboxUpdateMany = jest.fn();
const mockOutboxFindUnique = jest.fn();

jest.mock('../shared/database/prisma.service', () => {
  const txProxy = {
    user: {
      findMany: (...args: unknown[]) => mockUserFindMany(...args),
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    assignment: {
      create: (...args: unknown[]) => mockAssignmentCreate(...args),
      findFirst: (...args: unknown[]) => mockAssignmentFindFirst(...args),
      findMany: (...args: unknown[]) => mockAssignmentFindMany(...args),
      update: (...args: unknown[]) => mockAssignmentUpdate(...args),
      updateMany: (...args: unknown[]) => mockAssignmentUpdateMany(...args),
    },
    vehicle: {
      findUnique: (...args: unknown[]) => mockVehicleFindUnique(...args),
      updateMany: (...args: unknown[]) => mockVehicleUpdateMany(...args),
      update: (...args: unknown[]) => mockVehicleUpdate(...args),
    },
    booking: {
      findUnique: (...args: unknown[]) => mockBookingFindUnique(...args),
      update: (...args: unknown[]) => mockBookingUpdate(...args),
      updateMany: (...args: unknown[]) => mockBookingUpdateMany(...args),
    },
    order: {
      findUnique: (...args: unknown[]) => mockOrderFindUnique(...args),
      findFirst: (...args: unknown[]) => mockOrderFindFirst(...args),
    },
    orderLifecycleOutbox: {
      create: (...args: unknown[]) => mockOutboxCreate(...args),
      update: (...args: unknown[]) => mockOutboxUpdate(...args),
      updateMany: (...args: unknown[]) => mockOutboxUpdateMany(...args),
      findUnique: (...args: unknown[]) => mockOutboxFindUnique(...args),
    },
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    $executeRaw: (...args: unknown[]) => mockExecuteRaw(...args),
  };
  return {
    prismaClient: {
      ...txProxy,
      $transaction: (...args: unknown[]) => mockTransaction(...args),
    },
    withDbTimeout: async (fn: (tx: any) => Promise<any>, _opts?: any) => fn(txProxy),
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
      driver_declined: 'driver_declined',
      en_route_pickup: 'en_route_pickup',
      at_pickup: 'at_pickup',
      in_transit: 'in_transit',
      arrived_at_drop: 'arrived_at_drop',
      completed: 'completed',
      cancelled: 'cancelled',
    },
    OrderStatus: {
      active: 'active',
      cancelled: 'cancelled',
      completed: 'completed',
      expired: 'expired',
      fully_filled: 'fully_filled',
    },
    Prisma: {
      TransactionIsolationLevel: { Serializable: 'Serializable' },
    },
  };
});

// ---------- DB mock ----------
const mockGetAssignmentById = jest.fn();
const mockUpdateAssignment = jest.fn();
const mockGetBookingById = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getAssignmentById: (...args: unknown[]) => mockGetAssignmentById(...args),
    updateAssignment: (...args: unknown[]) => mockUpdateAssignment(...args),
    getBookingById: (...args: unknown[]) => mockGetBookingById(...args),
    getUserById: jest.fn(),
    getOrderById: jest.fn(),
    getVehiclesByTransporter: jest.fn().mockResolvedValue([]),
    getTransportersWithVehicleType: jest.fn().mockResolvedValue([]),
    getActiveBookingsForTransporter: jest.fn().mockResolvedValue([]),
    getActiveOrders: jest.fn().mockResolvedValue([]),
    getBookingsByDriver: jest.fn().mockResolvedValue([]),
  },
}));

// ---------- Socket service mock ----------
const mockEmitToUser = jest.fn();
const mockEmitToBooking = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: unknown[]) => mockEmitToUser(...args),
  emitToBooking: (...args: unknown[]) => mockEmitToBooking(...args),
  emitToUsers: jest.fn(),
  emitToRoom: jest.fn(),
  emitToAllTransporters: jest.fn(),
  emitToAll: jest.fn(),
  isUserConnected: jest.fn(),
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
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
  },
}));

// ---------- FCM service mock ----------
const mockNotifyPayment = jest.fn().mockResolvedValue(true);
const mockSendPushNotification = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/fcm.service', () => ({
  fcmService: {
    sendToDevice: jest.fn().mockResolvedValue(undefined),
    notifyPayment: (...args: unknown[]) => mockNotifyPayment(...args),
  },
  sendPushNotification: (...args: unknown[]) => mockSendPushNotification(...args),
}));

// ---------- Queue service mock ----------
const mockQueuePushNotification = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    addJob: jest.fn(),
    queuePushNotification: (...args: unknown[]) => mockQueuePushNotification(...args),
    queuePushNotificationBatch: jest.fn().mockResolvedValue(undefined),
    cancelAssignmentTimeout: jest.fn().mockResolvedValue(undefined),
    scheduleAssignmentTimeout: jest.fn().mockResolvedValue(undefined),
  },
}));

// ---------- Live availability mock ----------
const mockOnVehicleStatusChange = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: (...args: unknown[]) => mockOnVehicleStatusChange(...args),
  },
}));

// ---------- Driver presence mock ----------
const mockIsDriverOnline = jest.fn();
jest.mock('../modules/driver/driver-presence.service', () => ({
  driverPresenceService: {
    isDriverOnline: (...args: unknown[]) => mockIsDriverOnline(...args),
  },
}));

// ---------- Tracking service mock ----------
jest.mock('../modules/tracking/tracking.service', () => ({
  trackingService: {
    initializeTracking: jest.fn().mockResolvedValue(undefined),
  },
}));

// ---------- Vehicle lifecycle mock ----------
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
}));

// ---------- Vehicle key mock ----------
jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: (type: string, sub: string) => `${type}_${sub}`,
}));

// ---------- Hold config mock ----------
jest.mock('../core/config/hold-config', () => ({
  HOLD_CONFIG: {
    driverAcceptTimeoutMs: 45000,
    flexHoldDurationSeconds: 90,
  },
}));

// ---------- Order lifecycle outbox mock (for C-03 tests; C-18 tests import the real module) ----------
// We need a controlled mock for enqueueCompletionLifecycleOutbox used in assignment.service
const mockEnqueueCompletionLifecycleOutbox = jest.fn().mockResolvedValue('outbox-id-1');
jest.mock('../modules/order/order-lifecycle-outbox.service', () => ({
  enqueueCompletionLifecycleOutbox: (...args: unknown[]) => mockEnqueueCompletionLifecycleOutbox(...args),
  emitTripCompletedLifecycle: jest.requireActual('../modules/order/order-lifecycle-outbox.service').emitTripCompletedLifecycle,
  parseLifecycleOutboxPayload: jest.requireActual('../modules/order/order-lifecycle-outbox.service').parseLifecycleOutboxPayload,
  processLifecycleOutboxRow: jest.requireActual('../modules/order/order-lifecycle-outbox.service').processLifecycleOutboxRow,
  lifecycleOutboxDelegate: () => ({
    create: (...args: unknown[]) => mockOutboxCreate(...args),
    update: (...args: unknown[]) => mockOutboxUpdate(...args),
    updateMany: (...args: unknown[]) => mockOutboxUpdateMany(...args),
    findUnique: (...args: unknown[]) => mockOutboxFindUnique(...args),
  }),
}));

// ---------- Order broadcast service mock ----------
jest.mock('../modules/order/order-broadcast.service', () => ({
  emitToTransportersWithAdaptiveFanout: jest.fn().mockResolvedValue(undefined),
  emitDriverCancellationEvents: jest.fn(),
  withEventMeta: (obj: any) => obj,
  clearCustomerActiveBroadcast: jest.fn().mockResolvedValue(undefined),
}));

// ---------- Order timer service mock ----------
jest.mock('../modules/order/order-timer.service', () => ({
  orderExpiryTimerKey: (id: string) => `timer:order:${id}`,
  clearProgressiveStepTimers: jest.fn().mockResolvedValue(undefined),
}));

// ---------- Smart timeout mock ----------
jest.mock('../modules/order-timeout/smart-timeout.service', () => ({
  smartTimeoutService: {
    extendTimeout: jest.fn().mockResolvedValue(undefined),
  },
}));

// ---------- Audit, geo, pricing, cache, state-machines ----------
jest.mock('../shared/services/audit.service', () => ({
  recordStatusChange: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../shared/utils/geo.utils', () => ({
  roundCoord: (c: number) => Math.round(c * 100) / 100,
}));
jest.mock('../shared/utils/geospatial.utils', () => ({
  haversineDistanceKm: jest.fn().mockReturnValue(10),
}));
jest.mock('../modules/pricing/vehicle-catalog', () => ({
  getSubtypeConfig: jest.fn().mockReturnValue({ capacityKg: 5000, minTonnage: 1, maxTonnage: 5 }),
}));
jest.mock('../shared/services/cache.service', () => ({
  cacheService: { get: jest.fn(), set: jest.fn(), delete: jest.fn() },
}));
jest.mock('../core/state-machines', () => ({
  BOOKING_VALID_TRANSITIONS: {},
  isValidTransition: jest.fn().mockReturnValue(true),
  assertValidTransition: jest.fn(),
  TERMINAL_BOOKING_STATUSES: ['cancelled', 'expired', 'fully_filled', 'completed'],
}));
jest.mock('../shared/utils/safe-json.utils', () => ({
  safeJsonParse: (str: string, fallback: any) => {
    try { return JSON.parse(str); } catch { return fallback; }
  },
}));
jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: { calculateRoute: jest.fn() },
}));
jest.mock('../shared/services/distance-matrix.service', () => ({
  distanceMatrixService: { batchGetPickupDistance: jest.fn().mockResolvedValue(new Map()) },
}));
jest.mock('../shared/services/availability.service', () => ({
  availabilityService: { loadTransporterDetailsMap: jest.fn().mockResolvedValue(new Map()) },
}));
jest.mock('../modules/order/progressive-radius-matcher', () => ({
  progressiveRadiusMatcher: {
    findCandidates: jest.fn().mockResolvedValue([]),
    getStepCount: jest.fn().mockReturnValue(6),
    getStep: jest.fn().mockReturnValue({ radiusKm: 10, windowMs: 10000, h3RingK: 15 }),
  },
  startProgressiveMatching: jest.fn(),
  cancelProgressiveMatching: jest.fn(),
}));
jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: {
    filterOnline: jest.fn().mockResolvedValue([]),
    isOnline: jest.fn().mockResolvedValue(true),
  },
}));
jest.mock('../modules/booking/booking-payload.helper', () => ({
  buildBroadcastPayload: jest.fn().mockReturnValue({}),
  getRemainingTimeoutSeconds: jest.fn().mockReturnValue(60),
}));
jest.mock('../core/constants', () => ({
  ErrorCode: {
    BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
    FARE_TOO_LOW: 'FARE_TOO_LOW',
  },
}));
jest.mock('../shared/utils/pii.utils', () => ({
  maskPhoneForExternal: (phone: string) => phone ? `****${phone.slice(-4)}` : '',
}));
jest.mock('../modules/truck-hold/truck-hold.service', () => ({
  truckHoldService: { closeActiveHoldsForOrder: jest.fn().mockResolvedValue(0) },
}));

// ---------- Booking service mock (lazy require in assignment.service) ----------
jest.mock('../modules/booking/booking.service', () => ({
  bookingService: {
    decrementTrucksFilled: jest.fn().mockResolvedValue({}),
    getActiveBroadcasts: jest.fn().mockResolvedValue({ bookings: [], total: 0, hasMore: false }),
  },
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { tryAutoRedispatch } from '../modules/assignment/auto-redispatch.service';
import type { AutoRedispatchParams } from '../modules/assignment/auto-redispatch.service';
import {
  emitTripCompletedLifecycle,
  parseLifecycleOutboxPayload,
  processLifecycleOutboxRow,
} from '../modules/order/order-lifecycle-outbox.service';
import type { TripCompletedOutboxPayload } from '../modules/order/order-types';

// =============================================================================
// TEST HELPERS
// =============================================================================

function resetAllMocks(): void {
  jest.clearAllMocks();
  mockRedisGet.mockReset();
  mockRedisSet.mockReset();
  mockRedisDel.mockReset().mockResolvedValue(undefined);
  mockRedisIncr.mockReset().mockResolvedValue(1);
  mockRedisExpire.mockReset().mockResolvedValue(undefined);
  mockRedisExists.mockReset();
  mockRedisAcquireLock.mockReset().mockResolvedValue({ acquired: true });
  mockRedisReleaseLock.mockReset().mockResolvedValue(undefined);
  mockRedisSMembers.mockReset();
  mockRedisSAdd.mockReset();
  mockRedisGetJSON.mockReset();
  mockRedisSetJSON.mockReset();
  mockRedisCancelTimer.mockReset().mockResolvedValue(undefined);
  mockRedisSetTimer.mockReset();
  mockRedisIncrBy.mockReset().mockResolvedValue(0);
  mockRedisSIsMember.mockReset();

  mockUserFindMany.mockReset();
  mockUserFindUnique.mockReset();
  mockAssignmentCreate.mockReset();
  mockAssignmentFindFirst.mockReset();
  mockAssignmentFindMany.mockReset();
  mockAssignmentUpdate.mockReset();
  mockAssignmentUpdateMany.mockReset();
  mockVehicleFindUnique.mockReset();
  mockVehicleUpdateMany.mockReset();
  mockVehicleUpdate.mockReset();
  mockBookingFindUnique.mockReset();
  mockBookingUpdate.mockReset();
  mockBookingUpdateMany.mockReset();
  mockOrderFindUnique.mockReset();
  mockOrderFindFirst.mockReset();
  mockTransaction.mockReset();
  mockQueryRaw.mockReset();
  mockExecuteRaw.mockReset();
  mockOutboxCreate.mockReset().mockResolvedValue({ id: 'outbox-id-1' });
  mockOutboxUpdate.mockReset().mockResolvedValue({});
  mockOutboxUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  mockOutboxFindUnique.mockReset();
  mockGetAssignmentById.mockReset();
  mockUpdateAssignment.mockReset();
  mockGetBookingById.mockReset();

  mockEmitToUser.mockReset();
  mockEmitToBooking.mockReset();
  mockSendPushNotification.mockReset().mockResolvedValue(undefined);
  mockNotifyPayment.mockReset().mockResolvedValue(true);
  mockQueuePushNotification.mockReset().mockResolvedValue(undefined);
  mockOnVehicleStatusChange.mockReset().mockResolvedValue(undefined);
  mockIsDriverOnline.mockReset();
  mockEnqueueCompletionLifecycleOutbox.mockReset().mockResolvedValue('outbox-id-1');

  mockTransaction.mockImplementation(async (fnOrArray: any, _opts?: any) => {
    if (typeof fnOrArray === 'function') {
      const txProxy = {
        assignment: {
          create: (...a: unknown[]) => mockAssignmentCreate(...a),
          findFirst: (...a: unknown[]) => mockAssignmentFindFirst(...a),
          findMany: (...a: unknown[]) => mockAssignmentFindMany(...a),
          update: (...a: unknown[]) => mockAssignmentUpdate(...a),
          updateMany: (...a: unknown[]) => mockAssignmentUpdateMany(...a),
        },
        vehicle: {
          findUnique: (...a: unknown[]) => mockVehicleFindUnique(...a),
          updateMany: (...a: unknown[]) => mockVehicleUpdateMany(...a),
          update: (...a: unknown[]) => mockVehicleUpdate(...a),
        },
        booking: {
          findUnique: (...a: unknown[]) => mockBookingFindUnique(...a),
          update: (...a: unknown[]) => mockBookingUpdate(...a),
          updateMany: (...a: unknown[]) => mockBookingUpdateMany(...a),
        },
        order: {
          findUnique: (...a: unknown[]) => mockOrderFindUnique(...a),
          findFirst: (...a: unknown[]) => mockOrderFindFirst(...a),
        },
        user: {
          findUnique: (...a: unknown[]) => mockUserFindUnique(...a),
        },
        $queryRaw: (...a: unknown[]) => mockQueryRaw(...a),
      };
      return fnOrArray(txProxy);
    }
    return Promise.all(fnOrArray);
  });
}

function makeRedispatchParams(overrides?: Partial<AutoRedispatchParams>): AutoRedispatchParams {
  return {
    bookingId: 'booking-001',
    orderId: undefined,
    transporterId: 'transporter-001',
    vehicleId: 'vehicle-001',
    vehicleType: 'Open',
    vehicleSubtype: '17ft',
    declinedDriverId: 'driver-declined',
    assignmentId: 'assignment-001',
    ...overrides,
  };
}

function makeTripCompletedPayload(overrides?: Partial<TripCompletedOutboxPayload>): TripCompletedOutboxPayload {
  return {
    type: 'trip_completed',
    assignmentId: 'assignment-001',
    tripId: 'trip-001',
    bookingId: 'booking-001',
    orderId: '',
    vehicleId: 'vehicle-001',
    transporterId: 'transporter-001',
    driverId: 'driver-001',
    customerId: 'customer-001',
    completedAt: new Date().toISOString(),
    eventId: 'event-001',
    eventVersion: 1,
    serverTimeMs: Date.now(),
    ...overrides,
  };
}

// =============================================================================
// C-03 TESTS — Auto Re-dispatch After Driver Decline
// =============================================================================

describe('C-03: Auto Re-dispatch (tryAutoRedispatch)', () => {
  beforeEach(resetAllMocks);

  // -----------------------------------------------------------------------
  // Test 1: tryAutoRedispatch finds and assigns next driver
  // -----------------------------------------------------------------------
  it('finds an available online driver and creates a new assignment', async () => {
    // Redis counter = 0 (no prior attempts)
    mockRedisGet.mockResolvedValue(null);

    // Fleet query returns one candidate (not the declined driver)
    mockUserFindMany.mockResolvedValue([
      { id: 'driver-next', name: 'Next Driver', phone: '9999900001' },
    ]);

    // Candidate is online
    mockIsDriverOnline.mockResolvedValue(true);

    // Candidate has no active assignment
    mockAssignmentFindFirst.mockResolvedValue(null);

    // assignmentService.createAssignment is called via lazy require inside
    // auto-redispatch. The booking.service mock covers decrementTrucksFilled.
    // Mock createAssignment on the assignmentService singleton:
    const { assignmentService } = require('../modules/assignment/assignment.service');
    const mockCreateAssignment = jest.spyOn(assignmentService, 'createAssignment')
      .mockResolvedValue({ id: 'new-assignment-1' });

    const result = await tryAutoRedispatch(makeRedispatchParams());

    expect(result).toBe(true);

    // Verify createAssignment was called with the new driver
    expect(mockCreateAssignment).toHaveBeenCalledWith(
      'transporter-001',
      expect.objectContaining({
        bookingId: 'booking-001',
        vehicleId: 'vehicle-001',
        driverId: 'driver-next',
      })
    );

    // Verify Redis counter was incremented
    expect(mockRedisIncr).toHaveBeenCalledWith('redispatch:count:booking-001');

    // Verify the declined driver was excluded in the query
    expect(mockUserFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { not: 'driver-declined' },
          transporterId: 'transporter-001',
          role: 'driver',
          isActive: true,
        }),
      })
    );

    mockCreateAssignment.mockRestore();
  });

  // -----------------------------------------------------------------------
  // Test 2: tryAutoRedispatch skips when max attempts reached
  // -----------------------------------------------------------------------
  it('returns false when max redispatch attempts (2) are reached', async () => {
    // Redis counter = 2 (max reached)
    mockRedisGet.mockResolvedValue('2');

    const result = await tryAutoRedispatch(makeRedispatchParams());

    expect(result).toBe(false);

    // Should never query fleet
    expect(mockUserFindMany).not.toHaveBeenCalled();
    // Should never increment counter
    expect(mockRedisIncr).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 3: tryAutoRedispatch skips declined driver
  // -----------------------------------------------------------------------
  it('excludes the declined driver from the fleet query', async () => {
    mockRedisGet.mockResolvedValue(null);

    // Fleet returns no candidates (only the declined driver would match,
    // but the query excludes them)
    mockUserFindMany.mockResolvedValue([]);

    const result = await tryAutoRedispatch(
      makeRedispatchParams({ declinedDriverId: 'driver-should-skip' })
    );

    expect(result).toBe(false);

    // Verify the where clause excludes the declined driver
    expect(mockUserFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { not: 'driver-should-skip' },
        }),
      })
    );
  });

  // -----------------------------------------------------------------------
  // Test 4: tryAutoRedispatch gracefully handles no candidates
  // -----------------------------------------------------------------------
  it('returns false when fleet has no other drivers', async () => {
    mockRedisGet.mockResolvedValue(null);
    mockUserFindMany.mockResolvedValue([]);

    const result = await tryAutoRedispatch(makeRedispatchParams());

    expect(result).toBe(false);
    // No error thrown, no assignment created
    expect(mockRedisIncr).not.toHaveBeenCalled();
  });

  it('returns false when all candidates are offline', async () => {
    mockRedisGet.mockResolvedValue(null);
    mockUserFindMany.mockResolvedValue([
      { id: 'driver-a', name: 'A', phone: '1111' },
      { id: 'driver-b', name: 'B', phone: '2222' },
    ]);
    // All drivers offline
    mockIsDriverOnline.mockResolvedValue(false);

    const result = await tryAutoRedispatch(makeRedispatchParams());

    expect(result).toBe(false);
    expect(mockIsDriverOnline).toHaveBeenCalledTimes(2);
  });

  it('returns false when all candidates have active assignments', async () => {
    mockRedisGet.mockResolvedValue(null);
    mockUserFindMany.mockResolvedValue([
      { id: 'driver-busy', name: 'Busy', phone: '3333' },
    ]);
    mockIsDriverOnline.mockResolvedValue(true);
    // Driver has an active assignment
    mockAssignmentFindFirst.mockResolvedValue({ id: 'existing-assignment' });

    const result = await tryAutoRedispatch(makeRedispatchParams());

    expect(result).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 5: declineAssignment calls tryAutoRedispatch (integration)
  // -----------------------------------------------------------------------
  it('declineAssignment invokes tryAutoRedispatch after decline', async () => {
    // Setup: assignment to be declined
    const assignment = {
      id: 'assignment-decline-test',
      driverId: 'driver-dec',
      transporterId: 'transporter-001',
      vehicleId: 'vehicle-001',
      vehicleType: 'Open',
      vehicleSubtype: '17ft',
      vehicleNumber: 'MH12AB1234',
      tripId: 'trip-001',
      bookingId: 'booking-001',
      orderId: null,
      status: 'pending',
      driverName: 'Dec Driver',
      truckRequestId: null,
    };
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockVehicleFindUnique.mockResolvedValue({ status: 'on_hold', vehicleKey: 'Open_17ft', transporterId: 'transporter-001' });
    mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockAssignmentUpdate.mockResolvedValue({ ...assignment, status: 'driver_declined' });
    mockBookingFindUnique.mockResolvedValue({ customerId: 'customer-001' });
    mockRedisSet.mockResolvedValue(undefined);

    // Redis: no prior redispatch attempts
    mockRedisGet.mockResolvedValue(null);
    // Fleet: one candidate driver
    mockUserFindMany.mockResolvedValue([
      { id: 'driver-next', name: 'Next', phone: '4444' },
    ]);
    mockIsDriverOnline.mockResolvedValue(true);
    mockAssignmentFindFirst.mockResolvedValue(null);

    // The assignmentService.createAssignment will be called by auto-redispatch
    // through lazy require. Spy on it to prevent actually executing and to verify call.
    const { assignmentService } = require('../modules/assignment/assignment.service');
    const mockCreateAssignment = jest.spyOn(assignmentService, 'createAssignment')
      .mockResolvedValue({ id: 'new-assignment-auto' });

    await assignmentService.declineAssignment('assignment-decline-test', 'driver-dec');

    // Verify fleet query was made (proves tryAutoRedispatch was called)
    expect(mockUserFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          transporterId: 'transporter-001',
          id: { not: 'driver-dec' },
        }),
      })
    );

    // Verify createAssignment was called with the next candidate
    expect(mockCreateAssignment).toHaveBeenCalledWith(
      'transporter-001',
      expect.objectContaining({
        driverId: 'driver-next',
      })
    );

    mockCreateAssignment.mockRestore();
  });
});

// =============================================================================
// C-18 TESTS — Payment Trigger via Transactional Outbox
// =============================================================================

describe('C-18: Payment Trigger Outbox', () => {
  beforeEach(resetAllMocks);

  // -----------------------------------------------------------------------
  // Test 6: Completion writes trip_completed outbox row
  // -----------------------------------------------------------------------
  it('updateStatus("completed") enqueues a trip_completed outbox row', async () => {
    const assignment = {
      id: 'assignment-complete',
      driverId: 'driver-001',
      transporterId: 'transporter-001',
      vehicleId: 'vehicle-001',
      vehicleType: 'Open',
      vehicleSubtype: '17ft',
      vehicleNumber: 'MH12AB1234',
      tripId: 'trip-001',
      bookingId: 'booking-001',
      orderId: null,
      status: 'in_transit',
      driverName: 'Test Driver',
      truckRequestId: null,
    };
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockVehicleFindUnique
      .mockResolvedValueOnce({ status: 'in_transit' }) // pre-TX read
      .mockResolvedValueOnce({ vehicleKey: 'Open_17ft', transporterId: 'transporter-001' }); // post-TX Redis sync
    mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockAssignmentUpdate.mockResolvedValue({ ...assignment, status: 'completed' });
    mockBookingFindUnique.mockResolvedValue({ customerId: 'customer-001' });
    mockUpdateAssignment.mockResolvedValue({ ...assignment, status: 'completed' });
    mockGetAssignmentById
      .mockResolvedValueOnce(assignment) // first call (initial fetch)
      .mockResolvedValueOnce({ ...assignment, status: 'completed' }); // re-fetch after TX

    const { assignmentService } = require('../modules/assignment/assignment.service');

    await assignmentService.updateStatus('assignment-complete', 'driver-001', {
      status: 'completed',
    });

    // Verify enqueueCompletionLifecycleOutbox was called
    expect(mockEnqueueCompletionLifecycleOutbox).toHaveBeenCalledTimes(1);

    const payload = mockEnqueueCompletionLifecycleOutbox.mock.calls[0][0];
    expect(payload.type).toBe('trip_completed');
    expect(payload.assignmentId).toBe('assignment-complete');
    expect(payload.tripId).toBe('trip-001');
    expect(payload.driverId).toBe('driver-001');
    expect(payload.transporterId).toBe('transporter-001');
    expect(payload.bookingId).toBe('booking-001');
    expect(payload.customerId).toBe('customer-001');
    expect(payload.completedAt).toBeDefined();
    expect(payload.eventId).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Test 7: Outbox handler emits payment_pending socket event
  // -----------------------------------------------------------------------
  it('emitTripCompletedLifecycle emits payment_pending to booking room and users', async () => {
    const payload = makeTripCompletedPayload();

    await emitTripCompletedLifecycle(payload);

    // Should emit to booking room
    expect(mockEmitToBooking).toHaveBeenCalledWith(
      'booking-001',
      'payment_pending',
      expect.objectContaining({
        type: 'trip_completed',
        assignmentId: 'assignment-001',
        tripId: 'trip-001',
      })
    );

    // Should emit directly to customer
    expect(mockEmitToUser).toHaveBeenCalledWith(
      'customer-001',
      'payment_pending',
      expect.objectContaining({
        type: 'trip_completed',
        customerId: 'customer-001',
      })
    );

    // Should emit directly to transporter
    expect(mockEmitToUser).toHaveBeenCalledWith(
      'transporter-001',
      'payment_pending',
      expect.objectContaining({
        type: 'trip_completed',
        transporterId: 'transporter-001',
      })
    );
  });

  // -----------------------------------------------------------------------
  // Test 8: Outbox handler calls fcmService.notifyPayment
  // -----------------------------------------------------------------------
  it('emitTripCompletedLifecycle calls fcmService.notifyPayment for customer and transporter', async () => {
    const payload = makeTripCompletedPayload();

    await emitTripCompletedLifecycle(payload);

    // FCM to customer
    expect(mockNotifyPayment).toHaveBeenCalledWith('customer-001', {
      amount: 0,
      tripId: 'trip-001',
      status: 'pending',
    });

    // FCM to transporter
    expect(mockNotifyPayment).toHaveBeenCalledWith('transporter-001', {
      amount: 0,
      tripId: 'trip-001',
      status: 'pending',
    });

    expect(mockNotifyPayment).toHaveBeenCalledTimes(2);
  });

  it('emitTripCompletedLifecycle gracefully handles FCM failure without throwing', async () => {
    mockNotifyPayment.mockRejectedValue(new Error('FCM service unavailable'));

    const payload = makeTripCompletedPayload();

    // Should not throw
    await expect(emitTripCompletedLifecycle(payload)).resolves.toBeUndefined();

    // FCM was still attempted
    expect(mockNotifyPayment).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 9: Outbox write failure does not break completion
  // -----------------------------------------------------------------------
  it('updateStatus("completed") succeeds even when outbox write throws', async () => {
    // Make the outbox write fail
    mockEnqueueCompletionLifecycleOutbox.mockRejectedValue(
      new Error('DB connection lost during outbox write')
    );

    const assignment = {
      id: 'assignment-outbox-fail',
      driverId: 'driver-001',
      transporterId: 'transporter-001',
      vehicleId: 'vehicle-001',
      vehicleType: 'Open',
      vehicleSubtype: '17ft',
      vehicleNumber: 'MH12AB1234',
      tripId: 'trip-002',
      bookingId: 'booking-002',
      orderId: null,
      status: 'in_transit',
      driverName: 'Test Driver',
      truckRequestId: null,
    };
    mockGetAssignmentById
      .mockResolvedValueOnce(assignment) // initial fetch
      .mockResolvedValueOnce({ ...assignment, status: 'completed' }); // re-fetch after TX
    mockVehicleFindUnique
      .mockResolvedValueOnce({ status: 'in_transit' })
      .mockResolvedValueOnce({ vehicleKey: 'Open_17ft', transporterId: 'transporter-001' });
    mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockAssignmentUpdate.mockResolvedValue({ ...assignment, status: 'completed' });
    mockBookingFindUnique.mockResolvedValue({ customerId: 'customer-002' });

    const { assignmentService } = require('../modules/assignment/assignment.service');

    // Trip completion should NOT throw even though outbox write failed
    const result = await assignmentService.updateStatus(
      'assignment-outbox-fail',
      'driver-001',
      { status: 'completed' }
    );

    // Completion succeeded
    expect(result).toBeDefined();
    expect(result.status).toBe('completed');

    // Outbox write was attempted
    expect(mockEnqueueCompletionLifecycleOutbox).toHaveBeenCalled();
  });
});

// =============================================================================
// C-18 SUPPLEMENTARY — Outbox row processing dispatches correctly
// =============================================================================

describe('C-18: Outbox row processing', () => {
  beforeEach(resetAllMocks);

  it('processLifecycleOutboxRow dispatches trip_completed to emitTripCompletedLifecycle', async () => {
    const payload = makeTripCompletedPayload();
    const row = {
      id: 'outbox-row-1',
      orderId: 'booking-001',
      eventType: 'trip_completed',
      payload: payload as any,
      status: 'processing' as const,
      attempts: 0,
      maxAttempts: 10,
      nextRetryAt: new Date(),
      lockedAt: new Date(),
    };

    mockOutboxUpdate.mockResolvedValue({});

    await processLifecycleOutboxRow(row);

    // Verify the outbox row was marked as dispatched
    expect(mockOutboxUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'outbox-row-1' },
        data: expect.objectContaining({
          status: 'dispatched',
        }),
      })
    );

    // Verify payment_pending was emitted (via emitTripCompletedLifecycle)
    expect(mockEmitToBooking).toHaveBeenCalledWith(
      'booking-001',
      'payment_pending',
      expect.objectContaining({ type: 'trip_completed' })
    );
  });

  it('parseLifecycleOutboxPayload correctly parses trip_completed type', () => {
    const raw = {
      type: 'trip_completed',
      assignmentId: 'a-1',
      tripId: 't-1',
      bookingId: 'b-1',
      orderId: '',
      vehicleId: 'v-1',
      transporterId: 'tr-1',
      driverId: 'd-1',
      customerId: 'c-1',
      completedAt: '2026-04-13T00:00:00Z',
      eventId: 'e-1',
      eventVersion: 1,
      serverTimeMs: 1000,
    };

    const parsed = parseLifecycleOutboxPayload(raw);

    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe('trip_completed');
    expect((parsed as TripCompletedOutboxPayload).assignmentId).toBe('a-1');
    expect((parsed as TripCompletedOutboxPayload).driverId).toBe('d-1');
    expect((parsed as TripCompletedOutboxPayload).customerId).toBe('c-1');
  });

  it('parseLifecycleOutboxPayload returns null for invalid trip_completed (missing required fields)', () => {
    const raw = {
      type: 'trip_completed',
      assignmentId: '',
      tripId: '',
      driverId: '',
      transporterId: '',
    };

    const parsed = parseLifecycleOutboxPayload(raw);
    expect(parsed).toBeNull();
  });
});
