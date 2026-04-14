/**
 * =============================================================================
 * PHASE 3 — ORDER VALIDATION TESTS
 * =============================================================================
 *
 * Issue #12: Vehicle quantity upper bound (totalTrucks > 50)
 * Issue #5:  Redis lock fallback metric (order_create_lock_fallback_total)
 *
 * Tests the createOrder method in order.service.ts for:
 * - Server-side validation of truck quantity caps
 * - Metric instrumentation when Redis lock acquisition fails
 *
 * @author beta-order-qa
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

const mockIncrementCounter = jest.fn();
const mockRecordHistogram = jest.fn();

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: (...args: any[]) => mockIncrementCounter(...args),
    recordHistogram: (...args: any[]) => mockRecordHistogram(...args),
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
const mockRedisIncr = jest.fn().mockResolvedValue(1);
const mockRedisIncrBy = jest.fn().mockResolvedValue(1);
const mockRedisSIsMember = jest.fn();
const mockRedisIsConnected = jest.fn().mockReturnValue(true);
const mockRedisCheckRateLimit = jest.fn();

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
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
    checkRateLimit: (...args: any[]) => mockRedisCheckRateLimit(...args),
  },
}));

// ---------------------------------------------------------------------------
// Prisma mock
// ---------------------------------------------------------------------------
const mockBookingFindFirst = jest.fn();
const mockOrderFindFirst = jest.fn();
const mockOrderCreate = jest.fn();
const mockOrderUpdate = jest.fn();
const mockOrderUpdateMany = jest.fn();
const mockTruckRequestCreateMany = jest.fn();
const mockTransaction = jest.fn();
const mockOrderIdempotencyFindUnique = jest.fn();
const mockOrderIdempotencyCreate = jest.fn();

jest.mock('../shared/database/prisma.service', () => {
  const txProxy = {
    booking: {
      findFirst: (...args: any[]) => mockBookingFindFirst(...args),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    order: {
      findFirst: (...args: any[]) => mockOrderFindFirst(...args),
      create: (...args: any[]) => mockOrderCreate(...args),
      update: (...args: any[]) => mockOrderUpdate(...args),
      updateMany: (...args: any[]) => mockOrderUpdateMany(...args),
    },
    truckRequest: {
      createMany: (...args: any[]) => mockTruckRequestCreateMany(...args),
    },
    assignment: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    vehicle: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    orderIdempotency: {
      findUnique: (...args: any[]) => mockOrderIdempotencyFindUnique(...args),
      create: (...args: any[]) => mockOrderIdempotencyCreate(...args),
    },
    $queryRaw: jest.fn(),
  };
  return {
    prismaClient: {
      ...txProxy,
      $transaction: (...args: any[]) => mockTransaction(...args),
    },
    withDbTimeout: async (fn: (tx: any) => Promise<any>, _opts?: any) => fn(txProxy),
    OrderStatus: {
      created: 'created',
      broadcasting: 'broadcasting',
      active: 'active',
      partially_filled: 'partially_filled',
      fully_filled: 'fully_filled',
      cancelled: 'cancelled',
      expired: 'expired',
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
    TruckRequestStatus: {
      searching: 'searching',
      assigned: 'assigned',
      cancelled: 'cancelled',
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

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------
jest.mock('../shared/database/db', () => ({
  db: {
    getBookingById: jest.fn(),
    getUserById: jest.fn(),
    createBooking: jest.fn(),
    updateBooking: jest.fn(),
    getTransportersWithVehicleType: jest.fn().mockResolvedValue([]),
    getVehiclesByTransporter: jest.fn(),
    getActiveBookingsForTransporter: jest.fn(),
    getActiveOrders: jest.fn(),
    getBookingsByDriver: jest.fn(),
    getOrderById: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Socket service mock
// ---------------------------------------------------------------------------
jest.mock('../shared/services/socket.service', () => ({
  emitToUser: jest.fn(),
  emitToBooking: jest.fn(),
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
  },
}));

// ---------------------------------------------------------------------------
// FCM, Queue, Live Availability mocks
// ---------------------------------------------------------------------------
jest.mock('../shared/services/fcm.service', () => ({
  fcmService: { sendToDevice: jest.fn().mockResolvedValue(undefined) },
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    addJob: jest.fn(),
    queuePushNotificationBatch: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: jest.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Google Maps, pricing, geo mocks
// ---------------------------------------------------------------------------
jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: {
    calculateRoute: jest.fn().mockResolvedValue({ distanceKm: 50, durationMinutes: 60, polyline: '' }),
  },
}));

jest.mock('../modules/pricing/pricing.service', () => ({
  pricingService: {
    calculateEstimate: jest.fn().mockReturnValue({ pricePerTruck: 5000 }),
    calculateFare: jest.fn().mockReturnValue(5000),
  },
}));

jest.mock('../shared/utils/geo.utils', () => ({
  roundCoord: (c: number) => Math.round(c * 100) / 100,
}));

jest.mock('../shared/utils/geospatial.utils', () => ({
  haversineDistanceKm: jest.fn().mockReturnValue(10),
}));

// ---------------------------------------------------------------------------
// Distance matrix, availability, progressive radius, transporter online
// ---------------------------------------------------------------------------
jest.mock('../shared/services/distance-matrix.service', () => ({
  distanceMatrixService: {
    batchGetPickupDistance: jest.fn().mockResolvedValue(new Map()),
  },
}));

jest.mock('../shared/services/availability.service', () => ({
  availabilityService: {
    loadTransporterDetailsMap: jest.fn().mockResolvedValue(new Map()),
  },
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

jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: {
    filterOnline: jest.fn().mockResolvedValue([]),
    isOnline: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// State machines, vehicle lifecycle, vehicle key, cache, audit, etc.
// ---------------------------------------------------------------------------
jest.mock('../core/state-machines', () => ({
  BOOKING_VALID_TRANSITIONS: {},
  ORDER_VALID_TRANSITIONS: {},
  isValidTransition: jest.fn().mockReturnValue(true),
  assertValidTransition: jest.fn(),
  TERMINAL_BOOKING_STATUSES: ['cancelled', 'expired', 'fully_filled', 'completed'],
}));

jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: (type: string, sub: string) => `${type}_${sub}`,
}));

jest.mock('../shared/services/cache.service', () => ({
  cacheService: { get: jest.fn(), set: jest.fn(), delete: jest.fn() },
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

jest.mock('../shared/services/candidate-scorer.service', () => ({
  candidateScorer: {
    score: jest.fn().mockReturnValue([]),
    rankCandidates: jest.fn().mockResolvedValue([]),
  },
}));

// ---------------------------------------------------------------------------
// Order sub-module mocks
// ---------------------------------------------------------------------------
jest.mock('../modules/order/order-broadcast.service', () => ({
  broadcastToTransporters: jest.fn().mockResolvedValue({ onlineCandidates: 5, notifiedTransporters: 3 }),
  emitBroadcastStateChanged: jest.fn(),
  emitToTransportersWithAdaptiveFanout: jest.fn().mockResolvedValue(undefined),
  emitDriverCancellationEvents: jest.fn(),
  buildRequestsByType: jest.fn().mockReturnValue(new Map()),
  getNotifiedTransporters: jest.fn().mockResolvedValue(new Set()),
  markTransportersNotified: jest.fn().mockResolvedValue(undefined),
  notifiedTransportersKey: jest.fn().mockReturnValue('notified-key'),
  makeVehicleGroupKey: jest.fn().mockImplementation((t: string, s: string) => `${t}::${s}`),
  parseVehicleGroupKey: jest.fn().mockReturnValue({ vehicleType: 'tipper', vehicleSubtype: '20-24 Ton' }),
  getTransportersByVehicleCached: jest.fn().mockResolvedValue([]),
  invalidateTransporterCache: jest.fn().mockResolvedValue(undefined),
  withEventMeta: jest.fn().mockImplementation((payload: any) => ({ ...payload, eventId: 'evt-1', emittedAt: new Date().toISOString() })),
  clearCustomerActiveBroadcast: jest.fn().mockResolvedValue(undefined),
  processProgressiveBroadcastStep: jest.fn().mockResolvedValue(undefined),
  broadcastVehicleTypePayload: jest.fn().mockResolvedValue({ sentTransporters: [], skippedNoAvailable: 0 }),
  scheduleNextProgressiveStep: jest.fn().mockResolvedValue(undefined),
  orderBroadcastStepTimerKey: jest.fn().mockReturnValue('step-timer-key'),
  FF_BROADCAST_STRICT_SENT_ACCOUNTING: false,
}));

jest.mock('../modules/order/order-timer.service', () => ({
  orderExpiryTimerKey: jest.fn().mockReturnValue('timer:order:test-id'),
  setOrderExpiryTimer: jest.fn(),
  clearProgressiveStepTimers: jest.fn().mockResolvedValue(undefined),
  processExpiredTimers: jest.fn().mockResolvedValue(undefined),
  processExpiredOrderTimers: jest.fn().mockResolvedValue(undefined),
  processExpiredBroadcastStepTimers: jest.fn().mockResolvedValue(undefined),
  startOrderTimerChecker: jest.fn(),
  stopOrderTimerChecker: jest.fn(),
  ORDER_EXPIRY_TIMER_PREFIX: 'timer:order:',
  ORDER_STEP_TIMER_PREFIX: 'timer:step:',
  ORDER_STEP_TIMER_LOCK_PREFIX: 'timer:step:lock:',
}));

jest.mock('../modules/order/order-dispatch-outbox.service', () => ({
  FF_ORDER_DISPATCH_OUTBOX: false,
  FF_ORDER_DISPATCH_STATUS_EVENTS: false,
  ORDER_DISPATCH_OUTBOX_POLL_MS: 5000,
  ORDER_DISPATCH_OUTBOX_BATCH_SIZE: 10,
  startDispatchOutboxWorker: jest.fn().mockReturnValue(null),
  enqueueOrderDispatchOutbox: jest.fn().mockResolvedValue(undefined),
  processDispatchOutboxImmediately: jest.fn().mockResolvedValue(null),
  calculateDispatchRetryDelayMs: jest.fn().mockReturnValue(1000),
  parseDispatchOutboxPayload: jest.fn(),
  orderDispatchOutboxDelegate: jest.fn(),
  claimDispatchOutboxByOrderId: jest.fn(),
  claimReadyDispatchOutboxRows: jest.fn(),
  buildDispatchAttemptContext: jest.fn(),
  persistOrderDispatchSnapshot: jest.fn(),
  processDispatchOutboxRow: jest.fn(),
  processDispatchOutboxBatch: jest.fn(),
}));

jest.mock('../modules/order/order-lifecycle-outbox.service', () => ({
  FF_CANCEL_OUTBOX_ENABLED: false,
  ORDER_CANCEL_OUTBOX_POLL_MS: 5000,
  ORDER_CANCEL_OUTBOX_BATCH_SIZE: 10,
  startLifecycleOutboxWorker: jest.fn().mockReturnValue(null),
  enqueueCancelLifecycleOutbox: jest.fn().mockResolvedValue('outbox-id'),
  processLifecycleOutboxImmediately: jest.fn().mockResolvedValue(undefined),
  emitCancellationLifecycle: jest.fn().mockResolvedValue(undefined),
  handleOrderExpiry: jest.fn().mockResolvedValue(undefined),
  lifecycleOutboxDelegate: jest.fn(),
  parseLifecycleOutboxPayload: jest.fn(),
  calculateLifecycleRetryDelayMs: jest.fn(),
  claimLifecycleOutboxById: jest.fn(),
  claimReadyLifecycleOutboxRows: jest.fn(),
  processLifecycleOutboxRow: jest.fn(),
  processLifecycleOutboxBatch: jest.fn(),
}));

jest.mock('../modules/order/order-cancel.service', () => ({
  FF_CANCEL_EVENT_VERSION_ENFORCED: false,
  FF_CANCEL_REBOOK_CHURN_GUARD: false,
  FF_CANCEL_DEFERRED_SETTLEMENT: false,
  FF_CANCEL_IDEMPOTENCY_REQUIRED: false,
  cancelOrder: jest.fn().mockResolvedValue({ success: true, message: 'cancelled', transportersNotified: 1 }),
  buildCancelPayloadHash: jest.fn().mockReturnValue('cancel-hash'),
  getCancelIdempotentResponse: jest.fn().mockResolvedValue(null),
  persistCancelIdempotentResponse: jest.fn().mockResolvedValue(undefined),
  registerCancelRebookChurn: jest.fn().mockResolvedValue(undefined),
  enforceCancelRebookCooldown: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../modules/order/order-cancel-policy.service', () => ({
  deriveTruckCancelStage: jest.fn().mockReturnValue('SEARCHING'),
  calculateWaitingCharges: jest.fn().mockReturnValue(0),
  createMoneyBreakdown: jest.fn().mockReturnValue({ baseCancellationFee: 0, waitingCharges: 0, percentageFareComponent: 0, driverMinimumGuarantee: 0, finalAmount: 0 }),
  evaluateTruckCancelPolicy: jest.fn().mockReturnValue({
    stage: 'SEARCHING', decision: 'allowed', reasonRequired: false, reasonCode: 'FREE_CANCEL',
    penaltyBreakdown: { baseCancellationFee: 0, waitingCharges: 0, percentageFareComponent: 0, driverMinimumGuarantee: 0, finalAmount: 0 },
    driverCompensationBreakdown: { baseCancellationFee: 0, waitingCharges: 0, percentageFareComponent: 0, driverMinimumGuarantee: 0, finalAmount: 0 },
    settlementState: 'waived', pendingPenaltyAmount: 0,
  }),
  getCancelPreview: jest.fn().mockResolvedValue({ success: true, message: 'preview', transportersNotified: 0 }),
  createCancelDispute: jest.fn().mockResolvedValue({ success: true, disputeId: 'dispute-1', message: 'created' }),
}));

jest.mock('../modules/order/order-accept.service', () => ({
  acceptTruckRequest: jest.fn().mockResolvedValue({ success: true, assignmentId: 'asgn-1', tripId: 'trip-1', message: 'assigned' }),
}));

jest.mock('../modules/order/order-query.service', () => ({
  getOrderDetailsQuery: jest.fn().mockResolvedValue(null),
  getActiveRequestsForTransporterQuery: jest.fn().mockResolvedValue([]),
  getOrdersByCustomerQuery: jest.fn().mockResolvedValue([]),
  getOrderWithRequestsQuery: jest.fn().mockResolvedValue(null),
  getActiveTruckRequestsForTransporterQuery: jest.fn().mockResolvedValue([]),
  getCustomerOrdersQuery: jest.fn().mockResolvedValue({ orders: [], total: 0 }),
  ActiveTruckRequestOrderGroup: {},
}));

jest.mock('../modules/truck-hold/truck-hold.service', () => ({
  truckHoldService: {
    releaseAllHoldsForOrder: jest.fn().mockResolvedValue(undefined),
  },
}));

// =============================================================================
// IMPORTS (after all mocks)
// =============================================================================

import { orderService } from '../modules/order/order.service';
import { AppError } from '../shared/types/error.types';

// =============================================================================
// HELPERS
// =============================================================================

function makeBaseRequest(overrides: Record<string, any> = {}) {
  return {
    customerId: 'cust-1',
    customerName: 'Test User',
    customerPhone: '9876543210',
    routePoints: [
      { type: 'PICKUP', latitude: 12.97, longitude: 77.59, address: 'Bangalore Pickup' },
      { type: 'DROP', latitude: 13.01, longitude: 77.65, address: 'Bangalore Drop' },
    ],
    distanceKm: 50,
    vehicleRequirements: [
      { vehicleType: 'tipper', vehicleSubtype: '20-24 Ton', quantity: 2, pricePerTruck: 5000 },
    ],
    goodsType: 'sand',
    cargoWeightKg: 20000,
    ...overrides,
  };
}

// =============================================================================
// RESET
// =============================================================================

beforeEach(() => {
  jest.clearAllMocks();

  // Default Redis happy path
  mockRedisIncrBy.mockResolvedValue(1);
  mockRedisExpire.mockResolvedValue(undefined);
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockRedisAcquireLock.mockResolvedValue({ acquired: true });
  mockRedisReleaseLock.mockResolvedValue(undefined);
  mockRedisCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetIn: 0 });

  // Default Prisma — no existing bookings
  mockBookingFindFirst.mockResolvedValue(null);
  mockOrderFindFirst.mockResolvedValue(null);
  mockOrderIdempotencyFindUnique.mockResolvedValue(null);
});

// =============================================================================
// ISSUE #12 — VEHICLE QUANTITY UPPER BOUND (totalTrucks > 50)
// =============================================================================

describe('Issue #12: Vehicle quantity upper bound (totalTrucks > 50)', () => {
  it('rejects quantity = 51 with 400 VALIDATION_ERROR', async () => {
    const request = makeBaseRequest({
      vehicleRequirements: [
        { vehicleType: 'tipper', vehicleSubtype: '20-24 Ton', quantity: 51, pricePerTruck: 5000 },
      ],
    });

    await expect(orderService.createOrder(request as any)).rejects.toThrow(AppError);
    await expect(orderService.createOrder(request as any)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Maximum 50 trucks per order',
    });
  });

  it('rejects quantity = 100 (far above limit)', async () => {
    const request = makeBaseRequest({
      vehicleRequirements: [
        { vehicleType: 'open', vehicleSubtype: '17ft', quantity: 100, pricePerTruck: 3000 },
      ],
    });

    await expect(orderService.createOrder(request as any)).rejects.toThrow(AppError);
    await expect(orderService.createOrder(request as any)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Maximum 50 trucks per order',
    });
  });

  it('rejects multiple vehicle requirements totaling > 50', async () => {
    const request = makeBaseRequest({
      vehicleRequirements: [
        { vehicleType: 'tipper', vehicleSubtype: '20-24 Ton', quantity: 30, pricePerTruck: 5000 },
        { vehicleType: 'open', vehicleSubtype: '17ft', quantity: 21, pricePerTruck: 3000 },
      ],
    });

    await expect(orderService.createOrder(request as any)).rejects.toThrow(AppError);
    await expect(orderService.createOrder(request as any)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Maximum 50 trucks per order',
    });
  });

  it('accepts quantity = 50 (boundary)', async () => {
    const request = makeBaseRequest({
      vehicleRequirements: [
        { vehicleType: 'tipper', vehicleSubtype: '20-24 Ton', quantity: 50, pricePerTruck: 5000 },
      ],
    });

    // Should NOT throw the "Maximum 50 trucks" error.
    // It may throw a different error downstream (e.g., debounce, lock, DB),
    // but it should NOT throw the quantity validation error.
    try {
      await orderService.createOrder(request as any);
    } catch (err: any) {
      expect(err.message).not.toBe('Maximum 50 trucks per order');
    }
  });

  it('accepts multiple vehicle requirements totaling exactly 50', async () => {
    const request = makeBaseRequest({
      vehicleRequirements: [
        { vehicleType: 'tipper', vehicleSubtype: '20-24 Ton', quantity: 25, pricePerTruck: 5000 },
        { vehicleType: 'open', vehicleSubtype: '17ft', quantity: 25, pricePerTruck: 3000 },
      ],
    });

    try {
      await orderService.createOrder(request as any);
    } catch (err: any) {
      expect(err.message).not.toBe('Maximum 50 trucks per order');
    }
  });

  it('accepts quantity = 1 (minimum valid)', async () => {
    const request = makeBaseRequest({
      vehicleRequirements: [
        { vehicleType: 'tipper', vehicleSubtype: '20-24 Ton', quantity: 1, pricePerTruck: 5000 },
      ],
    });

    try {
      await orderService.createOrder(request as any);
    } catch (err: any) {
      expect(err.message).not.toBe('Maximum 50 trucks per order');
    }
  });

  it('rejects quantity = 0 (existing validation)', async () => {
    const request = makeBaseRequest({
      vehicleRequirements: [
        { vehicleType: 'tipper', vehicleSubtype: '20-24 Ton', quantity: 0, pricePerTruck: 5000 },
      ],
    });

    await expect(orderService.createOrder(request as any)).rejects.toThrow(AppError);
    await expect(orderService.createOrder(request as any)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Truck quantity must be greater than zero',
    });
  });

  it('rejects negative quantity', async () => {
    const request = makeBaseRequest({
      vehicleRequirements: [
        { vehicleType: 'tipper', vehicleSubtype: '20-24 Ton', quantity: -5, pricePerTruck: 5000 },
      ],
    });

    await expect(orderService.createOrder(request as any)).rejects.toThrow(AppError);
    await expect(orderService.createOrder(request as any)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Truck quantity must be greater than zero',
    });
  });

  it('rejects empty vehicleRequirements array', async () => {
    const request = makeBaseRequest({
      vehicleRequirements: [],
    });

    await expect(orderService.createOrder(request as any)).rejects.toThrow(AppError);
    await expect(orderService.createOrder(request as any)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'At least one truck requirement is required',
    });
  });

  it('rejects three vehicle types totaling 51', async () => {
    const request = makeBaseRequest({
      vehicleRequirements: [
        { vehicleType: 'tipper', vehicleSubtype: '20-24 Ton', quantity: 17, pricePerTruck: 5000 },
        { vehicleType: 'open', vehicleSubtype: '17ft', quantity: 17, pricePerTruck: 3000 },
        { vehicleType: 'container', vehicleSubtype: '20ft', quantity: 17, pricePerTruck: 8000 },
      ],
    });

    await expect(orderService.createOrder(request as any)).rejects.toThrow(AppError);
    await expect(orderService.createOrder(request as any)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Maximum 50 trucks per order',
    });
  });
});

// =============================================================================
// ISSUE #5 — REDIS LOCK FALLBACK METRIC
// =============================================================================

describe('Issue #5: Redis lock fallback metric (order_create_lock_fallback_total)', () => {
  it('increments metric when Redis lock acquisition fails', async () => {
    // Set up Redis lock to throw an error
    mockRedisAcquireLock.mockRejectedValueOnce(new Error('Redis connection refused'));

    const request = makeBaseRequest();

    // The call may succeed or fail downstream, but the metric should be recorded
    try {
      await orderService.createOrder(request as any);
    } catch {
      // Downstream errors are expected — we only care about the metric
    }

    expect(mockIncrementCounter).toHaveBeenCalledWith('order_create_lock_fallback_total');
  });

  it('does NOT increment metric when Redis lock succeeds', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });

    const request = makeBaseRequest();

    try {
      await orderService.createOrder(request as any);
    } catch {
      // Downstream errors are expected
    }

    // Verify the lock fallback metric was NOT called
    const lockFallbackCalls = mockIncrementCounter.mock.calls.filter(
      (call: any[]) => call[0] === 'order_create_lock_fallback_total'
    );
    expect(lockFallbackCalls).toHaveLength(0);
  });

  it('proceeds with order creation even when lock fails (fallback path)', async () => {
    mockRedisAcquireLock.mockRejectedValueOnce(new Error('Redis timeout'));
    // Make sure downstream doesn't throw an active-order error
    mockRedisGet.mockResolvedValue(null);
    mockBookingFindFirst.mockResolvedValue(null);

    const request = makeBaseRequest();

    // The order should NOT throw a lock contention error
    try {
      await orderService.createOrder(request as any);
    } catch (err: any) {
      expect(err.code).not.toBe('LOCK_CONTENTION');
    }

    // Verify the fallback metric was recorded
    expect(mockIncrementCounter).toHaveBeenCalledWith('order_create_lock_fallback_total');
  });

  it('throws LOCK_CONTENTION when lock is already held (not a failure)', async () => {
    // Lock not acquired (someone else holds it) — not a Redis failure
    mockRedisAcquireLock.mockResolvedValue({ acquired: false });

    const request = makeBaseRequest();

    await expect(orderService.createOrder(request as any)).rejects.toMatchObject({
      statusCode: 409,
      code: 'LOCK_CONTENTION',
    });

    // The fallback metric should NOT be incremented (lock worked, just wasn't available)
    const lockFallbackCalls = mockIncrementCounter.mock.calls.filter(
      (call: any[]) => call[0] === 'order_create_lock_fallback_total'
    );
    expect(lockFallbackCalls).toHaveLength(0);
  });
});
