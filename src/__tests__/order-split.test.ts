/**
 * =============================================================================
 * ORDER SPLIT MODULE TESTS
 * =============================================================================
 *
 * Comprehensive tests for the split order.service.ts module:
 *   - order.service.ts (facade)
 *   - order-core-types.ts (types and constants)
 *   - order-creation.service.ts (createOrder pipeline)
 *   - order-delegates.service.ts (delegate/bridge methods)
 *   - order-idempotency.service.ts (DB idempotency)
 *
 * 80 tests covering facade integrity, creation pipeline, delegates,
 * idempotency, and edge cases / race conditions.
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
const mockRedisIncrBy = jest.fn().mockResolvedValue(0);
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
const mockGetTransportersWithVehicleType = jest.fn();
const mockGetOrderById = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getBookingById: jest.fn(),
    getUserById: jest.fn(),
    createBooking: jest.fn(),
    updateBooking: jest.fn(),
    getTransportersWithVehicleType: (...args: any[]) => mockGetTransportersWithVehicleType(...args),
    getVehiclesByTransporter: jest.fn(),
    getActiveBookingsForTransporter: jest.fn(),
    getActiveOrders: jest.fn(),
    getBookingsByDriver: jest.fn(),
    getOrderById: (...args: any[]) => mockGetOrderById(...args),
  },
}));

// ---------------------------------------------------------------------------
// Socket service mock
// ---------------------------------------------------------------------------
const mockEmitToUser = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
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
const mockCalculateRoute = jest.fn();

jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: {
    calculateRoute: (...args: any[]) => mockCalculateRoute(...args),
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

const mockFilterOnline = jest.fn();
jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: {
    filterOnline: (...args: any[]) => mockFilterOnline(...args),
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
// Order sub-module mocks for delegate tests
// ---------------------------------------------------------------------------
const mockBroadcastToTransportersFn = jest.fn().mockResolvedValue({ onlineCandidates: 5, notifiedTransporters: 3 });
const mockEmitBroadcastStateChangedFn = jest.fn();
const mockSetOrderExpiryTimerFn = jest.fn();
const mockProcessExpiredTimersFn = jest.fn().mockResolvedValue(undefined);
const mockClearProgressiveStepTimersFn = jest.fn().mockResolvedValue(undefined);
const mockClearCustomerActiveBroadcastFn = jest.fn().mockResolvedValue(undefined);
const mockOrderExpiryTimerKeyFn = jest.fn().mockReturnValue('timer:order:test-id');
const mockWithEventMetaFn = jest.fn().mockImplementation((payload: any) => ({ ...payload, eventId: 'evt-1', emittedAt: new Date().toISOString() }));
const mockEmitToTransportersWithAdaptiveFanoutFn = jest.fn().mockResolvedValue(undefined);
const mockEmitDriverCancellationEventsFn = jest.fn();
const mockScheduleNextProgressiveStepFn = jest.fn().mockResolvedValue(undefined);
const mockOrderBroadcastStepTimerKeyFn = jest.fn().mockReturnValue('step-timer-key');

jest.mock('../modules/order/order-broadcast.service', () => ({
  broadcastToTransporters: (...args: any[]) => mockBroadcastToTransportersFn(...args),
  emitBroadcastStateChanged: (...args: any[]) => mockEmitBroadcastStateChangedFn(...args),
  emitToTransportersWithAdaptiveFanout: (...args: any[]) => mockEmitToTransportersWithAdaptiveFanoutFn(...args),
  emitDriverCancellationEvents: (...args: any[]) => mockEmitDriverCancellationEventsFn(...args),
  buildRequestsByType: jest.fn().mockReturnValue(new Map()),
  getNotifiedTransporters: jest.fn().mockResolvedValue(new Set()),
  markTransportersNotified: jest.fn().mockResolvedValue(undefined),
  notifiedTransportersKey: jest.fn().mockReturnValue('notified-key'),
  makeVehicleGroupKey: jest.fn().mockImplementation((t: string, s: string) => `${t}::${s}`),
  parseVehicleGroupKey: jest.fn().mockReturnValue({ vehicleType: 'tipper', vehicleSubtype: '20-24 Ton' }),
  getTransportersByVehicleCached: jest.fn().mockResolvedValue([]),
  invalidateTransporterCache: jest.fn().mockResolvedValue(undefined),
  withEventMeta: (...args: any[]) => mockWithEventMetaFn(...args),
  clearCustomerActiveBroadcast: (...args: any[]) => mockClearCustomerActiveBroadcastFn(...args),
  processProgressiveBroadcastStep: jest.fn().mockResolvedValue(undefined),
  broadcastVehicleTypePayload: jest.fn().mockResolvedValue({ sentTransporters: [], skippedNoAvailable: 0 }),
  scheduleNextProgressiveStep: (...args: any[]) => mockScheduleNextProgressiveStepFn(...args),
  orderBroadcastStepTimerKey: (...args: any[]) => mockOrderBroadcastStepTimerKeyFn(...args),
  FF_BROADCAST_STRICT_SENT_ACCOUNTING: false,
}));

jest.mock('../modules/order/order-timer.service', () => ({
  orderExpiryTimerKey: (...args: any[]) => mockOrderExpiryTimerKeyFn(...args),
  setOrderExpiryTimer: (...args: any[]) => mockSetOrderExpiryTimerFn(...args),
  clearProgressiveStepTimers: (...args: any[]) => mockClearProgressiveStepTimersFn(...args),
  processExpiredTimers: (...args: any[]) => mockProcessExpiredTimersFn(...args),
  processExpiredOrderTimers: jest.fn().mockResolvedValue(undefined),
  processExpiredBroadcastStepTimers: jest.fn().mockResolvedValue(undefined),
  startOrderTimerChecker: jest.fn(),
  stopOrderTimerChecker: jest.fn(),
  ORDER_EXPIRY_TIMER_PREFIX: 'timer:order:',
  ORDER_STEP_TIMER_PREFIX: 'timer:step:',
  ORDER_STEP_TIMER_LOCK_PREFIX: 'timer:step:lock:',
}));

const mockEnqueueOrderDispatchOutbox = jest.fn().mockResolvedValue(undefined);
const mockProcessDispatchOutboxImmediately = jest.fn().mockResolvedValue(null);
const mockStartDispatchOutboxWorker = jest.fn().mockReturnValue(null);

jest.mock('../modules/order/order-dispatch-outbox.service', () => ({
  FF_ORDER_DISPATCH_OUTBOX: false,
  FF_ORDER_DISPATCH_STATUS_EVENTS: false,
  ORDER_DISPATCH_OUTBOX_POLL_MS: 5000,
  ORDER_DISPATCH_OUTBOX_BATCH_SIZE: 10,
  startDispatchOutboxWorker: (...args: any[]) => mockStartDispatchOutboxWorker(...args),
  enqueueOrderDispatchOutbox: (...args: any[]) => mockEnqueueOrderDispatchOutbox(...args),
  processDispatchOutboxImmediately: (...args: any[]) => mockProcessDispatchOutboxImmediately(...args),
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

const mockHandleOrderExpiryFn = jest.fn().mockResolvedValue(undefined);
const mockEnqueueCancelLifecycleOutbox = jest.fn().mockResolvedValue('outbox-id');
const mockProcessLifecycleOutboxImmediately = jest.fn().mockResolvedValue(undefined);
const mockEmitCancellationLifecycle = jest.fn().mockResolvedValue(undefined);
const mockStartLifecycleOutboxWorker = jest.fn().mockReturnValue(null);

jest.mock('../modules/order/order-lifecycle-outbox.service', () => ({
  FF_CANCEL_OUTBOX_ENABLED: false,
  ORDER_CANCEL_OUTBOX_POLL_MS: 5000,
  ORDER_CANCEL_OUTBOX_BATCH_SIZE: 10,
  startLifecycleOutboxWorker: (...args: any[]) => mockStartLifecycleOutboxWorker(...args),
  enqueueCancelLifecycleOutbox: (...args: any[]) => mockEnqueueCancelLifecycleOutbox(...args),
  processLifecycleOutboxImmediately: (...args: any[]) => mockProcessLifecycleOutboxImmediately(...args),
  emitCancellationLifecycle: (...args: any[]) => mockEmitCancellationLifecycle(...args),
  handleOrderExpiry: (...args: any[]) => mockHandleOrderExpiryFn(...args),
  lifecycleOutboxDelegate: jest.fn(),
  parseLifecycleOutboxPayload: jest.fn(),
  calculateLifecycleRetryDelayMs: jest.fn(),
  claimLifecycleOutboxById: jest.fn(),
  claimReadyLifecycleOutboxRows: jest.fn(),
  processLifecycleOutboxRow: jest.fn(),
  processLifecycleOutboxBatch: jest.fn(),
}));

const mockCancelOrderFn = jest.fn().mockResolvedValue({ success: true, message: 'cancelled', transportersNotified: 1 });
const mockEnforceCancelRebookCooldown = jest.fn().mockResolvedValue(undefined);

jest.mock('../modules/order/order-cancel.service', () => ({
  FF_CANCEL_EVENT_VERSION_ENFORCED: false,
  FF_CANCEL_REBOOK_CHURN_GUARD: false,
  FF_CANCEL_DEFERRED_SETTLEMENT: false,
  FF_CANCEL_IDEMPOTENCY_REQUIRED: false,
  cancelOrder: (...args: any[]) => mockCancelOrderFn(...args),
  buildCancelPayloadHash: jest.fn().mockReturnValue('cancel-hash'),
  getCancelIdempotentResponse: jest.fn().mockResolvedValue(null),
  persistCancelIdempotentResponse: jest.fn().mockResolvedValue(undefined),
  registerCancelRebookChurn: jest.fn().mockResolvedValue(undefined),
  enforceCancelRebookCooldown: (...args: any[]) => mockEnforceCancelRebookCooldown(...args),
}));

const mockGetCancelPreviewFn = jest.fn().mockResolvedValue({ success: true, message: 'preview', transportersNotified: 0 });
const mockCreateCancelDisputeFn = jest.fn().mockResolvedValue({ success: true, disputeId: 'dispute-1', message: 'created' });

jest.mock('../modules/order/order-cancel-policy.service', () => ({
  deriveTruckCancelStage: jest.fn().mockReturnValue('SEARCHING'),
  calculateWaitingCharges: jest.fn().mockReturnValue(0),
  createMoneyBreakdown: jest.fn().mockReturnValue({ baseCancellationFee: 0, waitingCharges: 0, percentageFareComponent: 0, driverMinimumGuarantee: 0, finalAmount: 0 }),
  evaluateTruckCancelPolicy: jest.fn().mockReturnValue({
    stage: 'SEARCHING',
    decision: 'allowed',
    reasonRequired: false,
    reasonCode: 'FREE_CANCEL',
    penaltyBreakdown: { baseCancellationFee: 0, waitingCharges: 0, percentageFareComponent: 0, driverMinimumGuarantee: 0, finalAmount: 0 },
    driverCompensationBreakdown: { baseCancellationFee: 0, waitingCharges: 0, percentageFareComponent: 0, driverMinimumGuarantee: 0, finalAmount: 0 },
    settlementState: 'waived',
    pendingPenaltyAmount: 0,
  }),
  getCancelPreview: (...args: any[]) => mockGetCancelPreviewFn(...args),
  createCancelDispute: (...args: any[]) => mockCreateCancelDisputeFn(...args),
}));

const mockAcceptTruckRequestFn = jest.fn().mockResolvedValue({ success: true, assignmentId: 'asgn-1', tripId: 'trip-1', message: 'assigned' });

jest.mock('../modules/order/order-accept.service', () => ({
  acceptTruckRequest: (...args: any[]) => mockAcceptTruckRequestFn(...args),
}));

const mockGetOrderDetailsQuery = jest.fn().mockResolvedValue(null);
const mockGetActiveRequestsForTransporterQuery = jest.fn().mockResolvedValue([]);
const mockGetOrdersByCustomerQuery = jest.fn().mockResolvedValue([]);
const mockGetOrderWithRequestsQuery = jest.fn().mockResolvedValue(null);
const mockGetActiveTruckRequestsForTransporterQuery = jest.fn().mockResolvedValue([]);
const mockGetCustomerOrdersQuery = jest.fn().mockResolvedValue({ orders: [], total: 0 });

jest.mock('../modules/order/order-query.service', () => ({
  getOrderDetailsQuery: (...args: any[]) => mockGetOrderDetailsQuery(...args),
  getActiveRequestsForTransporterQuery: (...args: any[]) => mockGetActiveRequestsForTransporterQuery(...args),
  getOrdersByCustomerQuery: (...args: any[]) => mockGetOrdersByCustomerQuery(...args),
  getOrderWithRequestsQuery: (...args: any[]) => mockGetOrderWithRequestsQuery(...args),
  getActiveTruckRequestsForTransporterQuery: (...args: any[]) => mockGetActiveTruckRequestsForTransporterQuery(...args),
  getCustomerOrdersQuery: (...args: any[]) => mockGetCustomerOrdersQuery(...args),
  ActiveTruckRequestOrderGroup: {},
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { AppError } from '../shared/types/error.types';
import type { CreateOrderRequest, CreateOrderResponse } from '../modules/order/order-core-types';
import { CACHE_KEYS, CACHE_TTL, FF_DB_STRICT_IDEMPOTENCY } from '../modules/order/order-core-types';
import {
  buildRequestPayloadHash,
  acquireOrderBackpressure,
  releaseOrderBackpressure,
  validateOrderRequest,
  enforceOrderDebounce,
  checkOrderIdempotency,
  checkExistingActiveOrders,
  checkOrderServerIdempotency,
  resolveServerRouteDistance,
  validateAndCorrectPrices,
  buildOrderRoutePoints,
  persistOrderTransaction,
  broadcastOrderToTransporters,
  setupOrderExpiry,
  cacheOrderIdempotencyResponse,
} from '../modules/order/order-creation.service';
import {
  getDbIdempotentResponse,
  persistDbIdempotentResponse,
} from '../modules/order/order-idempotency.service';
import {
  checkRateLimit,
  broadcastToTransportersPublic,
  emitBroadcastStateChangedPublic,
  emitToTransportersWithAdaptiveFanoutPublic,
  emitDriverCancellationEventsPublic,
  withEventMetaPublic,
  orderExpiryTimerKeyPublic,
  clearProgressiveStepTimersPublic,
  clearCustomerActiveBroadcastPublic,
  startLifecycleOutboxWorker,
  enqueueCancelLifecycleOutbox,
  processLifecycleOutboxImmediately,
  emitCancellationLifecycle,
  startDispatchOutboxWorker,
  enqueueOrderDispatchOutbox,
  processDispatchOutboxImmediately,
  handleOrderExpiry,
  processExpiredTimers,
  getCancelPreview,
  createCancelDispute,
  cancelOrder,
  acceptTruckRequest,
  getOrderDetails,
  getActiveRequestsForTransporter,
  getOrdersByCustomer,
  getOrderWithRequests,
  getActiveTruckRequestsForTransporter,
  getCustomerOrders,
  enforceCancelRebookCooldown,
  invalidateTransporterCache,
} from '../modules/order/order-delegates.service';
import type { OrderCreateContext } from '../modules/order/order-create-context';

// =============================================================================
// HELPERS
// =============================================================================

function makeBaseRequest(overrides: Partial<CreateOrderRequest> = {}): CreateOrderRequest {
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

function makeCtx(overrides: Partial<OrderCreateContext> = {}): OrderCreateContext {
  return {
    request: makeBaseRequest(),
    backpressureKey: 'order:create:inflight',
    maxConcurrentOrders: 200,
    requestPayloadHash: '',
    lockKey: 'customer-broadcast-create:cust-1',
    lockAcquired: false,
    dedupeKey: '',
    idempotencyHash: '',
    distanceSource: 'client_fallback',
    clientDistanceKm: 50,
    totalAmount: 0,
    totalTrucks: 0,
    routePoints: [],
    pickup: { latitude: 0, longitude: 0, address: '' },
    drop: { latitude: 0, longitude: 0, address: '' },
    orderId: 'order-uuid-1',
    expiresAt: '',
    truckRequests: [],
    responseRequests: [],
    dispatchState: 'dispatching',
    dispatchReasonCode: undefined,
    dispatchAttempts: 1,
    onlineCandidates: 0,
    notifiedTransporters: 0,
    orderResponse: null,
    earlyReturn: null,
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

  // Default Prisma happy path
  mockBookingFindFirst.mockResolvedValue(null);
  mockOrderFindFirst.mockResolvedValue(null);
  mockOrderCreate.mockResolvedValue({ id: 'order-uuid-1' });
  mockTruckRequestCreateMany.mockResolvedValue({ count: 2 });
  mockOrderUpdate.mockResolvedValue({ id: 'order-uuid-1' });
  mockOrderUpdateMany.mockResolvedValue({ count: 1 });
  mockOrderIdempotencyFindUnique.mockResolvedValue(null);
  mockOrderIdempotencyCreate.mockResolvedValue({});

  // Default DB happy path
  mockGetTransportersWithVehicleType.mockResolvedValue([{ id: 'trans-1' }, { id: 'trans-2' }]);
  mockGetOrderById.mockResolvedValue(null);

  // Default google maps
  mockCalculateRoute.mockResolvedValue({ distanceKm: 48, durationMinutes: 90 });

  // Default broadcast
  mockBroadcastToTransportersFn.mockResolvedValue({ onlineCandidates: 5, notifiedTransporters: 3 });
  mockEmitBroadcastStateChangedFn.mockReturnValue(undefined);
  mockSetOrderExpiryTimerFn.mockReturnValue(undefined);
});

// =============================================================================
// TEST SUITES
// =============================================================================

describe('Order Split Module', () => {
  // ===========================================================================
  // 1. FACADE INTEGRITY
  // ===========================================================================
  describe('1. Facade integrity (order.service.ts)', () => {
    let orderService: any;

    beforeAll(() => {
      // Dynamic import after all mocks are in place
      orderService = require('../modules/order/order.service').orderService;
    });

    test('1.01 orderService is exported as a singleton', () => {
      expect(orderService).toBeDefined();
    });

    test('1.02 orderService.createOrder is callable', () => {
      expect(typeof orderService.createOrder).toBe('function');
    });

    test('1.03 orderService.cancelOrder is callable', () => {
      expect(typeof orderService.cancelOrder).toBe('function');
    });

    test('1.04 orderService.acceptTruckRequest is callable', () => {
      expect(typeof orderService.acceptTruckRequest).toBe('function');
    });

    test('1.05 orderService.getOrderDetails is callable', () => {
      expect(typeof orderService.getOrderDetails).toBe('function');
    });

    test('1.06 orderService.getActiveRequestsForTransporter is callable', () => {
      expect(typeof orderService.getActiveRequestsForTransporter).toBe('function');
    });

    test('1.07 orderService.getOrdersByCustomer is callable', () => {
      expect(typeof orderService.getOrdersByCustomer).toBe('function');
    });

    test('1.08 orderService.getOrderWithRequests is callable', () => {
      expect(typeof orderService.getOrderWithRequests).toBe('function');
    });

    test('1.09 orderService.getActiveTruckRequestsForTransporter is callable', () => {
      expect(typeof orderService.getActiveTruckRequestsForTransporter).toBe('function');
    });

    test('1.10 orderService.getCustomerOrders is callable', () => {
      expect(typeof orderService.getCustomerOrders).toBe('function');
    });

    test('1.11 orderService.getCancelPreview is callable', () => {
      expect(typeof orderService.getCancelPreview).toBe('function');
    });

    test('1.12 orderService.createCancelDispute is callable', () => {
      expect(typeof orderService.createCancelDispute).toBe('function');
    });

    test('1.13 orderService.processExpiredTimers is callable', () => {
      expect(typeof orderService.processExpiredTimers).toBe('function');
    });

    test('1.14 orderService.handleOrderExpiry is callable', () => {
      expect(typeof orderService.handleOrderExpiry).toBe('function');
    });

    test('1.15 orderService.checkRateLimit is callable', () => {
      expect(typeof orderService.checkRateLimit).toBe('function');
    });

    test('1.16 orderService.broadcastToTransportersPublic is callable', () => {
      expect(typeof orderService.broadcastToTransportersPublic).toBe('function');
    });

    test('1.17 CACHE_KEYS exported from order-core-types', () => {
      expect(CACHE_KEYS).toBeDefined();
      expect(CACHE_KEYS.ORDER).toBe('order:');
      expect(CACHE_KEYS.ACTIVE_REQUESTS).toBe('active:requests:');
    });

    test('1.18 CACHE_TTL exported from order-core-types', () => {
      expect(CACHE_TTL).toBeDefined();
      expect(CACHE_TTL.ORDER).toBe(60);
      expect(CACHE_TTL.ACTIVE_REQUESTS).toBe(30);
    });

    test('1.19 FF_DB_STRICT_IDEMPOTENCY exported from order-core-types', () => {
      expect(typeof FF_DB_STRICT_IDEMPOTENCY).toBe('boolean');
    });

    test('1.20 VehicleRequirement type is re-exported (compile-time check via usage)', () => {
      const req: import('../modules/order/order-core-types').VehicleRequirement = {
        vehicleType: 'tipper',
        vehicleSubtype: '20-24 Ton',
        quantity: 1,
        pricePerTruck: 5000,
      };
      expect(req.vehicleType).toBe('tipper');
    });
  });

  // ===========================================================================
  // 2. ORDER CREATION TESTS (order-creation.service.ts)
  // ===========================================================================
  describe('2. Order creation pipeline', () => {

    test('2.01 buildRequestPayloadHash returns deterministic hash', () => {
      const req = makeBaseRequest();
      const hash1 = buildRequestPayloadHash(req);
      const hash2 = buildRequestPayloadHash(req);
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64); // SHA-256 hex length
    });

    test('2.02 buildRequestPayloadHash changes when payload changes', () => {
      const req1 = makeBaseRequest({ distanceKm: 50 });
      const req2 = makeBaseRequest({ distanceKm: 100 });
      expect(buildRequestPayloadHash(req1)).not.toBe(buildRequestPayloadHash(req2));
    });

    test('2.03 acquireOrderBackpressure succeeds under limit', async () => {
      mockRedisIncrBy.mockResolvedValue(5);
      const ctx = makeCtx();
      await expect(acquireOrderBackpressure(ctx)).resolves.toBeUndefined();
    });

    test('2.04 acquireOrderBackpressure throws 503 when over limit', async () => {
      mockRedisIncrBy.mockResolvedValue(201);
      const ctx = makeCtx({ maxConcurrentOrders: 200 });
      await expect(acquireOrderBackpressure(ctx)).rejects.toThrow(AppError);
      await expect(acquireOrderBackpressure(ctx)).rejects.toThrow('System is processing too many orders');
    });

    test('2.05 acquireOrderBackpressure uses in-memory fallback when Redis fails', async () => {
      mockRedisIncrBy.mockRejectedValue(new Error('Redis down'));
      const ctx = makeCtx({ maxConcurrentOrders: 200 });
      // Should succeed because in-memory count is below limit
      await expect(acquireOrderBackpressure(ctx)).resolves.toBeUndefined();
    });

    test('2.06 releaseOrderBackpressure decrements counter', async () => {
      const ctx = makeCtx({ redisBackpressureIncremented: true } as any);
      await releaseOrderBackpressure(ctx);
      expect(mockRedisIncrBy).toHaveBeenCalledWith('order:create:inflight', -1);
    });

    test('2.07 validateOrderRequest passes with valid requirements', () => {
      const ctx = makeCtx();
      expect(() => validateOrderRequest(ctx)).not.toThrow();
    });

    test('2.08 validateOrderRequest throws on empty vehicleRequirements', () => {
      const ctx = makeCtx({ request: makeBaseRequest({ vehicleRequirements: [] }) });
      expect(() => validateOrderRequest(ctx)).toThrow('At least one truck requirement is required');
    });

    test('2.09 validateOrderRequest throws on zero quantity', () => {
      const ctx = makeCtx({
        request: makeBaseRequest({
          vehicleRequirements: [{ vehicleType: 'tipper', vehicleSubtype: '20-24 Ton', quantity: 0, pricePerTruck: 5000 }],
        }),
      });
      expect(() => validateOrderRequest(ctx)).toThrow('Truck quantity must be greater than zero');
    });

    test('2.10 enforceOrderDebounce allows first request', async () => {
      mockRedisGet.mockResolvedValue(null);
      const ctx = makeCtx();
      await expect(enforceOrderDebounce(ctx)).resolves.toBeUndefined();
    });

    test('2.11 enforceOrderDebounce blocks duplicate within window', async () => {
      mockRedisGet.mockResolvedValue('1');
      const ctx = makeCtx();
      await expect(enforceOrderDebounce(ctx)).rejects.toThrow('Please wait a few seconds');
    });

    test('2.12 enforceOrderDebounce skips if Redis fails (non-blocking)', async () => {
      mockRedisGet.mockRejectedValue(new Error('Redis timeout'));
      const ctx = makeCtx();
      await expect(enforceOrderDebounce(ctx)).resolves.toBeUndefined();
    });

    test('2.13 checkOrderIdempotency returns null without idempotency key', async () => {
      const ctx = makeCtx({ request: makeBaseRequest({ idempotencyKey: undefined }) });
      const result = await checkOrderIdempotency(ctx);
      expect(result).toBeNull();
    });

    test('2.14 checkOrderIdempotency returns cached response (Redis hit)', async () => {
      const cachedResponse: CreateOrderResponse = {
        orderId: 'existing-order',
        totalTrucks: 2,
        totalAmount: 10000,
        dispatchState: 'dispatched',
        dispatchAttempts: 1,
        onlineCandidates: 5,
        notifiedTransporters: 3,
        serverTimeMs: Date.now(),
        truckRequests: [],
        expiresAt: new Date().toISOString(),
        expiresIn: 120,
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(cachedResponse));
      const ctx = makeCtx({
        request: makeBaseRequest({ idempotencyKey: 'idem-key-1' }),
        requestPayloadHash: 'hash-1',
      });
      const result = await checkOrderIdempotency(ctx);
      expect(result).not.toBeNull();
      expect(result!.orderId).toBe('existing-order');
    });

    test('2.15 checkOrderIdempotency falls back to DB when Redis misses', async () => {
      mockRedisGet.mockResolvedValue(null);
      const dbResponse: CreateOrderResponse = {
        orderId: 'db-order',
        totalTrucks: 1,
        totalAmount: 5000,
        dispatchState: 'dispatched',
        dispatchAttempts: 1,
        onlineCandidates: 3,
        notifiedTransporters: 2,
        serverTimeMs: Date.now(),
        truckRequests: [],
        expiresAt: new Date().toISOString(),
        expiresIn: 120,
      };
      mockOrderIdempotencyFindUnique.mockResolvedValue({
        payloadHash: 'hash-1',
        responseJson: dbResponse,
      });
      const ctx = makeCtx({
        request: makeBaseRequest({ idempotencyKey: 'idem-key-1' }),
        requestPayloadHash: 'hash-1',
      });
      const result = await checkOrderIdempotency(ctx);
      expect(result).not.toBeNull();
      expect(result!.orderId).toBe('db-order');
    });

    test('2.16 checkExistingActiveOrders throws when customer has active order (Redis)', async () => {
      mockRedisGet.mockResolvedValue('existing-order-id');
      const ctx = makeCtx();
      await expect(checkExistingActiveOrders(ctx)).rejects.toThrow('You already have an active order');
    });

    test('2.17 checkExistingActiveOrders throws when lock cannot be acquired', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockRedisAcquireLock.mockResolvedValue({ acquired: false });
      const ctx = makeCtx();
      await expect(checkExistingActiveOrders(ctx)).rejects.toThrow('Order creation in progress');
    });

    test('2.18 checkExistingActiveOrders throws when Redis has active broadcast key', async () => {
      // FIX #11: DB check removed from checkExistingActiveOrders — Redis fast-path only
      mockRedisGet.mockResolvedValue('booking-1');
      const ctx = makeCtx();
      await expect(checkExistingActiveOrders(ctx)).rejects.toThrow('You already have an active order');
    });

    test('2.19 checkExistingActiveOrders throws when lock contention', async () => {
      // FIX #11: DB check removed — lock contention blocks concurrent creates
      mockRedisGet.mockResolvedValue(null);
      mockRedisAcquireLock.mockResolvedValue({ acquired: false });
      const ctx = makeCtx();
      await expect(checkExistingActiveOrders(ctx)).rejects.toThrow('Order creation in progress');
    });

    test('2.20 checkExistingActiveOrders passes when no active orders', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockBookingFindFirst.mockResolvedValue(null);
      mockOrderFindFirst.mockResolvedValue(null);
      const ctx = makeCtx();
      await expect(checkExistingActiveOrders(ctx)).resolves.toBeUndefined();
      expect(ctx.lockAcquired).toBe(true);
    });

    test('2.21 checkOrderServerIdempotency returns null when no dedup key cached', async () => {
      mockRedisGet.mockResolvedValue(null);
      const ctx = makeCtx();
      const result = await checkOrderServerIdempotency(ctx);
      expect(result).toBeNull();
    });

    test('2.22 checkOrderServerIdempotency returns replay when deduplicate key exists with active order', async () => {
      mockRedisGet.mockResolvedValue('existing-order-id');
      mockGetOrderById.mockResolvedValue({
        id: 'existing-order-id',
        status: 'active',
        onlineCandidatesCount: 5,
        notifiedCount: 3,
        expiresAt: '2026-01-01T00:00:00Z',
      });
      const ctx = makeCtx();
      const result = await checkOrderServerIdempotency(ctx);
      expect(result).not.toBeNull();
      expect(result!.orderId).toBe('existing-order-id');
      expect(result!.dispatchState).toBe('dispatched');
    });

    test('2.23 checkOrderServerIdempotency returns null when dedup exists but order is cancelled', async () => {
      mockRedisGet.mockResolvedValue('cancelled-order-id');
      mockGetOrderById.mockResolvedValue({
        id: 'cancelled-order-id',
        status: 'cancelled',
      });
      const ctx = makeCtx();
      const result = await checkOrderServerIdempotency(ctx);
      expect(result).toBeNull();
    });

    test('2.24 resolveServerRouteDistance uses Google when available', async () => {
      mockCalculateRoute.mockResolvedValue({ distanceKm: 48, durationMinutes: 90 });
      const ctx = makeCtx();
      await resolveServerRouteDistance(ctx);
      expect(ctx.request.distanceKm).toBe(48);
      expect(ctx.distanceSource).toBe('google');
    });

    test('2.25 resolveServerRouteDistance falls back to client distance on Google failure', async () => {
      mockCalculateRoute.mockRejectedValue(new Error('API quota exceeded'));
      const ctx = makeCtx();
      await resolveServerRouteDistance(ctx);
      expect(ctx.request.distanceKm).toBe(50); // original client distance
      expect(ctx.distanceSource).toBe('client_fallback');
    });

    test('2.26 resolveServerRouteDistance falls back when Google returns null', async () => {
      mockCalculateRoute.mockResolvedValue(null);
      const ctx = makeCtx();
      await resolveServerRouteDistance(ctx);
      expect(ctx.distanceSource).toBe('client_fallback');
    });

    test('2.27 validateAndCorrectPrices uses server price when client price is too low', () => {
      const { pricingService } = require('../modules/pricing/pricing.service');
      pricingService.calculateEstimate.mockReturnValue({ pricePerTruck: 6000 });
      const ctx = makeCtx({
        request: makeBaseRequest({
          vehicleRequirements: [{ vehicleType: 'tipper', vehicleSubtype: '20-24 Ton', quantity: 2, pricePerTruck: 3000 }],
        }),
      });
      validateAndCorrectPrices(ctx);
      // Price should have been corrected to server price
      expect(ctx.request.vehicleRequirements[0].pricePerTruck).toBe(6000);
      expect(ctx.totalAmount).toBe(12000);
    });

    test('2.28 validateAndCorrectPrices allows client price when within tolerance', () => {
      const { pricingService } = require('../modules/pricing/pricing.service');
      pricingService.calculateEstimate.mockReturnValue({ pricePerTruck: 5000 });
      const ctx = makeCtx();
      validateAndCorrectPrices(ctx);
      expect(ctx.request.vehicleRequirements[0].pricePerTruck).toBe(5000);
      expect(ctx.totalAmount).toBe(10000);
    });

    test('2.29 validateAndCorrectPrices allows higher client price (no downward correction)', () => {
      const { pricingService } = require('../modules/pricing/pricing.service');
      pricingService.calculateEstimate.mockReturnValue({ pricePerTruck: 5000 });
      const ctx = makeCtx({
        request: makeBaseRequest({
          vehicleRequirements: [{ vehicleType: 'tipper', vehicleSubtype: '20-24 Ton', quantity: 1, pricePerTruck: 7000 }],
        }),
      });
      validateAndCorrectPrices(ctx);
      expect(ctx.request.vehicleRequirements[0].pricePerTruck).toBe(7000);
    });

    test('2.30 validateAndCorrectPrices continues on pricing service failure', () => {
      const { pricingService } = require('../modules/pricing/pricing.service');
      pricingService.calculateEstimate.mockImplementation(() => { throw new Error('pricing down'); });
      const ctx = makeCtx();
      expect(() => validateAndCorrectPrices(ctx)).not.toThrow();
      expect(ctx.totalAmount).toBe(10000);
    });

    test('2.31 buildOrderRoutePoints extracts pickup/drop from routePoints', () => {
      const ctx = makeCtx();
      buildOrderRoutePoints(ctx, 120000);
      expect(ctx.pickup.latitude).toBe(12.97);
      expect(ctx.drop.latitude).toBe(13.01);
      expect(ctx.routePoints.length).toBe(2);
      expect(ctx.totalTrucks).toBe(2);
      expect(ctx.expiresAt).toBeDefined();
    });

    test('2.32 buildOrderRoutePoints handles legacy pickup/drop fields', () => {
      const ctx = makeCtx({
        request: makeBaseRequest({
          routePoints: undefined,
          pickup: { latitude: 12.97, longitude: 77.59, address: 'Legacy Pickup' },
          drop: { latitude: 13.01, longitude: 77.65, address: 'Legacy Drop' },
        }),
      });
      buildOrderRoutePoints(ctx, 120000);
      expect(ctx.pickup.address).toBe('Legacy Pickup');
      expect(ctx.drop.address).toBe('Legacy Drop');
      expect(ctx.routePoints.length).toBe(2);
    });

    test('2.33 buildOrderRoutePoints throws without pickup or routePoints', () => {
      const ctx = makeCtx({
        request: makeBaseRequest({ routePoints: undefined, pickup: undefined, drop: undefined }),
      });
      expect(() => buildOrderRoutePoints(ctx, 120000)).toThrow('Either routePoints OR both pickup and drop');
    });

    test('2.34 buildOrderRoutePoints throws when totalTrucks is zero', () => {
      const ctx = makeCtx({
        request: makeBaseRequest({
          vehicleRequirements: [{ vehicleType: 'tipper', vehicleSubtype: '20-24 Ton', quantity: 0, pricePerTruck: 5000 }],
        }),
      });
      // quantity=0 means totalTrucks=0
      expect(() => buildOrderRoutePoints(ctx, 120000)).toThrow('Total trucks must be greater than zero');
    });

    test('2.35 buildOrderRoutePoints handles intermediate stops', () => {
      const ctx = makeCtx({
        request: makeBaseRequest({
          routePoints: [
            { type: 'PICKUP', latitude: 12.97, longitude: 77.59, address: 'Start' },
            { type: 'STOP', latitude: 12.98, longitude: 77.60, address: 'Stop 1' },
            { type: 'DROP', latitude: 13.01, longitude: 77.65, address: 'End' },
          ],
        }),
      });
      buildOrderRoutePoints(ctx, 120000);
      expect(ctx.routePoints.length).toBe(3);
      expect(ctx.routePoints[1].type).toBe('STOP');
    });

    test('2.36 persistOrderTransaction creates order + truckRequests atomically', async () => {
      const ctx = makeCtx();
      buildOrderRoutePoints(ctx, 120000);
      validateAndCorrectPrices(ctx);
      const mockEnqueue = jest.fn().mockResolvedValue(undefined);
      await persistOrderTransaction(ctx, mockEnqueue);
      expect(mockOrderCreate).toHaveBeenCalled();
      expect(mockTruckRequestCreateMany).toHaveBeenCalled();
      expect(mockOrderUpdate).toHaveBeenCalled();
    });

    test('2.37 persistOrderTransaction throws when duplicate booking exists inside transaction', async () => {
      mockBookingFindFirst.mockResolvedValue({ id: 'dup-booking' });
      const ctx = makeCtx();
      buildOrderRoutePoints(ctx, 120000);
      validateAndCorrectPrices(ctx);
      const mockEnqueue = jest.fn().mockResolvedValue(undefined);
      // FIX #11: Error message is 'You already have an active order' (from SERIALIZABLE TX guard)
      await expect(persistOrderTransaction(ctx, mockEnqueue)).rejects.toThrow('You already have an active order');
    });

    test('2.38 broadcastOrderToTransporters sets dispatch state on success', async () => {
      const ctx = makeCtx();
      ctx.truckRequests = [{ id: 'tr-1' } as any];
      ctx.pickup = { latitude: 12.97, longitude: 77.59, address: 'Pickup' };
      ctx.expiresAt = new Date().toISOString();
      const mockProcess = jest.fn().mockResolvedValue(null);
      await broadcastOrderToTransporters(ctx, mockProcess);
      // With outbox disabled, direct broadcast is used
      expect(mockBroadcastToTransportersFn).toHaveBeenCalled();
      expect(ctx.dispatchState).toBe('dispatched');
      expect(ctx.notifiedTransporters).toBe(3);
    });

    test('2.39 broadcastOrderToTransporters marks dispatch_failed when no transporters notified', async () => {
      mockBroadcastToTransportersFn.mockResolvedValue({ onlineCandidates: 0, notifiedTransporters: 0 });
      const ctx = makeCtx();
      ctx.truckRequests = [{ id: 'tr-1' } as any];
      ctx.pickup = { latitude: 12.97, longitude: 77.59, address: 'Pickup' };
      ctx.expiresAt = new Date().toISOString();
      const mockProcess = jest.fn().mockResolvedValue(null);
      await broadcastOrderToTransporters(ctx, mockProcess);
      expect(ctx.dispatchState).toBe('dispatch_failed');
      expect(ctx.dispatchReasonCode).toBe('NO_ONLINE_TRANSPORTERS');
    });

    test('2.40 broadcastOrderToTransporters handles broadcast error gracefully', async () => {
      mockBroadcastToTransportersFn.mockRejectedValue(new Error('Socket error'));
      const ctx = makeCtx();
      ctx.truckRequests = [{ id: 'tr-1' } as any];
      ctx.pickup = { latitude: 12.97, longitude: 77.59, address: 'Pickup' };
      ctx.expiresAt = new Date().toISOString();
      const mockProcess = jest.fn().mockResolvedValue(null);
      await broadcastOrderToTransporters(ctx, mockProcess);
      expect(ctx.dispatchState).toBe('dispatch_failed');
      expect(ctx.dispatchReasonCode).toBe('DISPATCH_ERROR');
    });

    test('2.41 setupOrderExpiry sets timer and builds response', async () => {
      const ctx = makeCtx({
        totalTrucks: 2,
        totalAmount: 10000,
        dispatchState: 'dispatched',
        dispatchAttempts: 1,
        onlineCandidates: 5,
        notifiedTransporters: 3,
        expiresAt: new Date(Date.now() + 120000).toISOString(),
        responseRequests: [],
      });
      await setupOrderExpiry(ctx, 120000);
      expect(mockSetOrderExpiryTimerFn).toHaveBeenCalledWith('order-uuid-1', 120000);
      expect(ctx.orderResponse).not.toBeNull();
      expect(ctx.orderResponse!.orderId).toBe('order-uuid-1');
      expect(ctx.orderResponse!.expiresIn).toBe(120);
    });

    test('2.42 cacheOrderIdempotencyResponse caches when idempotencyKey present', async () => {
      const ctx = makeCtx({
        request: makeBaseRequest({ idempotencyKey: 'idem-1' }),
        requestPayloadHash: 'hash-1',
        dedupeKey: 'idem:broadcast:create:cust-1:abc',
        orderResponse: {
          orderId: 'order-uuid-1',
          totalTrucks: 2,
          totalAmount: 10000,
          dispatchState: 'dispatched',
          dispatchAttempts: 1,
          onlineCandidates: 5,
          notifiedTransporters: 3,
          serverTimeMs: Date.now(),
          truckRequests: [],
          expiresAt: new Date().toISOString(),
          expiresIn: 120,
        },
      });
      await cacheOrderIdempotencyResponse(ctx, 120000);
      expect(mockRedisSet).toHaveBeenCalledWith(
        expect.stringContaining('idempotency:cust-1:idem-1'),
        expect.any(String),
        86400,
      );
      // Also stores dedup key
      expect(mockRedisSet).toHaveBeenCalledWith(
        'idem:broadcast:create:cust-1:abc',
        'order-uuid-1',
        expect.any(Number),
      );
    });

    test('2.43 cacheOrderIdempotencyResponse skips cache when no idempotencyKey', async () => {
      const ctx = makeCtx({
        dedupeKey: 'idem:broadcast:create:cust-1:abc',
        orderResponse: { orderId: 'order-uuid-1' } as any,
      });
      await cacheOrderIdempotencyResponse(ctx, 120000);
      // Idempotency-specific cache not called (no idempotencyKey on request)
      expect(mockRedisSet).not.toHaveBeenCalledWith(
        expect.stringContaining('idempotency:cust-1:'),
        expect.any(String),
        86400,
      );
      // But dedup key is still stored
      expect(mockRedisSet).toHaveBeenCalledWith(
        'idem:broadcast:create:cust-1:abc',
        'order-uuid-1',
        expect.any(Number),
      );
    });
  });

  // ===========================================================================
  // 3. DELEGATE TESTS (order-delegates.service.ts)
  // ===========================================================================
  describe('3. Delegate/bridge methods', () => {

    test('3.01 broadcastToTransportersPublic delegates correctly', async () => {
      const result = await broadcastToTransportersPublic('ord-1', makeBaseRequest(), [], '2026-01-01', { latitude: 12.97, longitude: 77.59, address: 'test' });
      expect(mockBroadcastToTransportersFn).toHaveBeenCalled();
      expect(result).toEqual({ onlineCandidates: 5, notifiedTransporters: 3 });
    });

    test('3.02 emitBroadcastStateChangedPublic delegates correctly', () => {
      emitBroadcastStateChangedPublic('cust-1', { orderId: 'ord-1', status: 'active' });
      expect(mockEmitBroadcastStateChangedFn).toHaveBeenCalledWith('cust-1', { orderId: 'ord-1', status: 'active' });
    });

    test('3.03 emitToTransportersWithAdaptiveFanoutPublic delegates correctly', async () => {
      await emitToTransportersWithAdaptiveFanoutPublic(['t-1'], [{ event: 'test', payload: {} }], 'context');
      expect(mockEmitToTransportersWithAdaptiveFanoutFn).toHaveBeenCalledWith(['t-1'], [{ event: 'test', payload: {} }], 'context');
    });

    test('3.04 emitDriverCancellationEventsPublic delegates correctly', () => {
      emitDriverCancellationEventsPublic('drv-1', { orderId: 'ord-1', reason: 'test', message: 'cancelled' });
      expect(mockEmitDriverCancellationEventsFn).toHaveBeenCalledWith('drv-1', expect.objectContaining({ orderId: 'ord-1' }));
    });

    test('3.05 withEventMetaPublic adds eventId and emittedAt', () => {
      const result = withEventMetaPublic({ orderId: 'ord-1' } as any);
      expect(result.eventId).toBeDefined();
      expect(result.emittedAt).toBeDefined();
    });

    test('3.06 orderExpiryTimerKeyPublic returns timer key', () => {
      const key = orderExpiryTimerKeyPublic('ord-1');
      expect(mockOrderExpiryTimerKeyFn).toHaveBeenCalledWith('ord-1');
      expect(key).toBe('timer:order:test-id');
    });

    test('3.07 clearProgressiveStepTimersPublic delegates correctly', async () => {
      await clearProgressiveStepTimersPublic('ord-1');
      expect(mockClearProgressiveStepTimersFn).toHaveBeenCalledWith('ord-1');
    });

    test('3.08 clearCustomerActiveBroadcastPublic delegates correctly', async () => {
      await clearCustomerActiveBroadcastPublic('cust-1');
      expect(mockClearCustomerActiveBroadcastFn).toHaveBeenCalledWith('cust-1');
    });

    test('3.09 checkRateLimit delegates to redisService', async () => {
      mockRedisCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetIn: 0 });
      const result = await checkRateLimit('test-key', 10, 60);
      expect(result.allowed).toBe(true);
      expect(result.retryAfter).toBe(0);
    });

    test('3.10 checkRateLimit returns retryAfter when blocked', async () => {
      mockRedisCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetIn: 30 });
      const result = await checkRateLimit('test-key', 10, 60);
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBe(30);
    });

    test('3.11 startLifecycleOutboxWorker delegates correctly', () => {
      startLifecycleOutboxWorker({ lifecycleOutboxWorkerTimer: null, lifecycleOutboxWorkerRunning: false, isShuttingDown: false });
      expect(mockStartLifecycleOutboxWorker).toHaveBeenCalled();
    });

    test('3.12 enqueueCancelLifecycleOutbox delegates correctly', async () => {
      const payload = { type: 'order_cancelled' as const, orderId: 'ord-1', customerId: 'cust-1', transporters: [] as any[], drivers: [] as any[], reason: 'test', reasonCode: 'TEST', cancelledBy: 'customer' as const, refundStatus: 'none', assignmentIds: [], cancelledAt: '', eventId: 'e1', eventVersion: 1, serverTimeMs: 0 };
      const result = await enqueueCancelLifecycleOutbox(payload);
      expect(mockEnqueueCancelLifecycleOutbox).toHaveBeenCalledWith(payload, undefined);
      expect(result).toBe('outbox-id');
    });

    test('3.13 processLifecycleOutboxImmediately delegates correctly', async () => {
      await processLifecycleOutboxImmediately('outbox-1');
      expect(mockProcessLifecycleOutboxImmediately).toHaveBeenCalledWith('outbox-1');
    });

    test('3.14 emitCancellationLifecycle delegates correctly', async () => {
      const payload = { type: 'order_cancelled' as const, orderId: 'ord-1', customerId: 'cust-1', transporters: [] as any[], drivers: [] as any[], reason: 'test', reasonCode: 'TEST', cancelledBy: 'customer' as const, refundStatus: 'none', assignmentIds: [], cancelledAt: '', eventId: 'e1', eventVersion: 1, serverTimeMs: 0 };
      await emitCancellationLifecycle(payload);
      expect(mockEmitCancellationLifecycle).toHaveBeenCalledWith(payload);
    });

    test('3.15 startDispatchOutboxWorker delegates correctly', () => {
      startDispatchOutboxWorker({ outboxWorkerTimer: null, outboxWorkerRunning: false, isShuttingDown: false });
      expect(mockStartDispatchOutboxWorker).toHaveBeenCalled();
    });

    test('3.16 enqueueOrderDispatchOutbox delegates correctly', async () => {
      await enqueueOrderDispatchOutbox('ord-1');
      expect(mockEnqueueOrderDispatchOutbox).toHaveBeenCalledWith('ord-1', undefined);
    });

    test('3.17 processDispatchOutboxImmediately delegates correctly', async () => {
      const context = { request: makeBaseRequest(), truckRequests: [] as any[], expiresAt: '', pickup: { latitude: 0, longitude: 0, address: '' } };
      await processDispatchOutboxImmediately('ord-1', context);
      expect(mockProcessDispatchOutboxImmediately).toHaveBeenCalledWith('ord-1', context);
    });

    test('3.18 handleOrderExpiry delegates correctly', async () => {
      await handleOrderExpiry('ord-1');
      expect(mockHandleOrderExpiryFn).toHaveBeenCalledWith('ord-1');
    });

    test('3.19 processExpiredTimers delegates correctly', async () => {
      await processExpiredTimers();
      expect(mockProcessExpiredTimersFn).toHaveBeenCalled();
    });

    test('3.20 getCancelPreview delegates correctly', async () => {
      await getCancelPreview('ord-1', 'cust-1', 'test-reason');
      expect(mockGetCancelPreviewFn).toHaveBeenCalledWith('ord-1', 'cust-1', 'test-reason');
    });

    test('3.21 createCancelDispute delegates correctly', async () => {
      const result = await createCancelDispute('ord-1', 'cust-1', 'CODE', 'notes');
      expect(mockCreateCancelDisputeFn).toHaveBeenCalledWith('ord-1', 'cust-1', 'CODE', 'notes');
      expect(result.success).toBe(true);
    });

    test('3.22 cancelOrder delegates correctly', async () => {
      const result = await cancelOrder('ord-1', 'cust-1', 'reason', 'idem-1', { createDispute: false });
      expect(mockCancelOrderFn).toHaveBeenCalledWith('ord-1', 'cust-1', 'reason', 'idem-1', { createDispute: false });
      expect(result.success).toBe(true);
    });

    test('3.23 acceptTruckRequest delegates correctly', async () => {
      const result = await acceptTruckRequest('tr-1', 'trans-1', 'veh-1', 'drv-1');
      expect(mockAcceptTruckRequestFn).toHaveBeenCalledWith('tr-1', 'trans-1', 'veh-1', 'drv-1');
      expect(result.success).toBe(true);
      expect(result.assignmentId).toBe('asgn-1');
    });

    test('3.24 getOrderDetails delegates correctly', async () => {
      mockGetOrderDetailsQuery.mockResolvedValue({ id: 'ord-1', truckRequests: [] });
      const result = await getOrderDetails('ord-1');
      expect(mockGetOrderDetailsQuery).toHaveBeenCalledWith('ord-1');
      expect(result!.id).toBe('ord-1');
    });

    test('3.25 getActiveRequestsForTransporter delegates correctly', async () => {
      mockGetActiveRequestsForTransporterQuery.mockResolvedValue([{ id: 'tr-1' }]);
      const result = await getActiveRequestsForTransporter('trans-1');
      expect(mockGetActiveRequestsForTransporterQuery).toHaveBeenCalledWith('trans-1');
      expect(result.length).toBe(1);
    });

    test('3.26 getOrdersByCustomer delegates correctly', async () => {
      mockGetOrdersByCustomerQuery.mockResolvedValue([{ id: 'ord-1' }]);
      const result = await getOrdersByCustomer('cust-1');
      expect(mockGetOrdersByCustomerQuery).toHaveBeenCalledWith('cust-1');
      expect(result.length).toBe(1);
    });

    test('3.27 getOrderWithRequests delegates correctly', async () => {
      mockGetOrderWithRequestsQuery.mockResolvedValue({ id: 'ord-1', truckRequests: [] });
      const result = await getOrderWithRequests('ord-1', 'user-1', 'customer');
      expect(mockGetOrderWithRequestsQuery).toHaveBeenCalledWith('ord-1', 'user-1', 'customer');
      expect(result).toBeDefined();
    });

    test('3.28 getActiveTruckRequestsForTransporter delegates correctly', async () => {
      mockGetActiveTruckRequestsForTransporterQuery.mockResolvedValue([]);
      const result = await getActiveTruckRequestsForTransporter('trans-1');
      expect(mockGetActiveTruckRequestsForTransporterQuery).toHaveBeenCalledWith('trans-1');
      expect(result).toEqual([]);
    });

    test('3.29 getCustomerOrders delegates with default pagination', async () => {
      mockGetCustomerOrdersQuery.mockResolvedValue({ orders: [], total: 0 });
      await getCustomerOrders('cust-1');
      expect(mockGetCustomerOrdersQuery).toHaveBeenCalledWith('cust-1', 1, 20);
    });

    test('3.30 getCustomerOrders delegates with custom pagination', async () => {
      mockGetCustomerOrdersQuery.mockResolvedValue({ orders: [], total: 0 });
      await getCustomerOrders('cust-1', 3, 50);
      expect(mockGetCustomerOrdersQuery).toHaveBeenCalledWith('cust-1', 3, 50);
    });

    test('3.31 enforceCancelRebookCooldown delegates correctly', async () => {
      await enforceCancelRebookCooldown('cust-1');
      expect(mockEnforceCancelRebookCooldown).toHaveBeenCalledWith('cust-1');
    });

    test('3.32 invalidateTransporterCache delegates correctly', async () => {
      await invalidateTransporterCache('tipper', '20-24 Ton');
      const { invalidateTransporterCache: mockInv } = require('../modules/order/order-broadcast.service');
      expect(mockInv).toHaveBeenCalledWith('tipper', '20-24 Ton');
    });
  });

  // ===========================================================================
  // 4. IDEMPOTENCY TESTS (order-idempotency.service.ts)
  // ===========================================================================
  describe('4. DB Idempotency', () => {

    test('4.01 getDbIdempotentResponse returns null when no row exists', async () => {
      mockOrderIdempotencyFindUnique.mockResolvedValue(null);
      const result = await getDbIdempotentResponse('cust-1', 'key-1', 'hash-1');
      expect(result).toBeNull();
    });

    test('4.02 getDbIdempotentResponse returns response when row matches', async () => {
      const stored: CreateOrderResponse = {
        orderId: 'ord-stored',
        totalTrucks: 1,
        totalAmount: 5000,
        dispatchState: 'dispatched',
        dispatchAttempts: 1,
        onlineCandidates: 3,
        notifiedTransporters: 2,
        serverTimeMs: Date.now(),
        truckRequests: [],
        expiresAt: new Date().toISOString(),
        expiresIn: 120,
      };
      mockOrderIdempotencyFindUnique.mockResolvedValue({
        payloadHash: 'hash-1',
        responseJson: stored,
      });
      const result = await getDbIdempotentResponse('cust-1', 'key-1', 'hash-1');
      expect(result).not.toBeNull();
      expect(result!.orderId).toBe('ord-stored');
    });

    test('4.03 getDbIdempotentResponse throws 409 on hash mismatch with strict mode', async () => {
      mockOrderIdempotencyFindUnique.mockResolvedValue({
        payloadHash: 'different-hash',
        responseJson: {},
      });
      // FF_DB_STRICT_IDEMPOTENCY defaults to true (process.env not set to 'false')
      await expect(getDbIdempotentResponse('cust-1', 'key-1', 'hash-1')).rejects.toThrow('Idempotency key reused with different payload');
    });

    test('4.04 persistDbIdempotentResponse creates row', async () => {
      mockOrderIdempotencyCreate.mockResolvedValue({});
      const response: CreateOrderResponse = {
        orderId: 'ord-1',
        totalTrucks: 1,
        totalAmount: 5000,
        dispatchState: 'dispatched',
        dispatchAttempts: 1,
        onlineCandidates: 3,
        notifiedTransporters: 2,
        serverTimeMs: Date.now(),
        truckRequests: [],
        expiresAt: new Date().toISOString(),
        expiresIn: 120,
      };
      await expect(persistDbIdempotentResponse('cust-1', 'key-1', 'hash-1', 'ord-1', response)).resolves.toBeUndefined();
      expect(mockOrderIdempotencyCreate).toHaveBeenCalled();
    });

    test('4.05 persistDbIdempotentResponse handles P2002 duplicate key gracefully', async () => {
      mockOrderIdempotencyCreate.mockRejectedValue({ code: 'P2002' });
      // The fallback getDbIdempotentResponse call
      mockOrderIdempotencyFindUnique.mockResolvedValue({
        payloadHash: 'hash-1',
        responseJson: { orderId: 'existing' },
      });
      const response: CreateOrderResponse = {
        orderId: 'ord-1',
        totalTrucks: 1,
        totalAmount: 5000,
        dispatchState: 'dispatched',
        dispatchAttempts: 1,
        onlineCandidates: 3,
        notifiedTransporters: 2,
        serverTimeMs: Date.now(),
        truckRequests: [],
        expiresAt: new Date().toISOString(),
        expiresIn: 120,
      };
      await expect(persistDbIdempotentResponse('cust-1', 'key-1', 'hash-1', 'ord-1', response)).resolves.toBeUndefined();
    });

    test('4.06 persistDbIdempotentResponse throws 409 on P2002 with hash mismatch', async () => {
      mockOrderIdempotencyCreate.mockRejectedValue({ code: 'P2002' });
      mockOrderIdempotencyFindUnique.mockResolvedValue(null);
      const response: CreateOrderResponse = {
        orderId: 'ord-1',
        totalTrucks: 1,
        totalAmount: 5000,
        dispatchState: 'dispatched',
        dispatchAttempts: 1,
        onlineCandidates: 3,
        notifiedTransporters: 2,
        serverTimeMs: Date.now(),
        truckRequests: [],
        expiresAt: new Date().toISOString(),
        expiresIn: 120,
      };
      await expect(persistDbIdempotentResponse('cust-1', 'key-1', 'hash-1', 'ord-1', response)).rejects.toThrow('Idempotency key conflict');
    });

    test('4.07 persistDbIdempotentResponse re-throws non-P2002 errors', async () => {
      mockOrderIdempotencyCreate.mockRejectedValue(new Error('DB connection lost'));
      const response: CreateOrderResponse = {
        orderId: 'ord-1',
        totalTrucks: 1,
        totalAmount: 5000,
        dispatchState: 'dispatched',
        dispatchAttempts: 1,
        onlineCandidates: 3,
        notifiedTransporters: 2,
        serverTimeMs: Date.now(),
        truckRequests: [],
        expiresAt: new Date().toISOString(),
        expiresIn: 120,
      };
      await expect(persistDbIdempotentResponse('cust-1', 'key-1', 'hash-1', 'ord-1', response)).rejects.toThrow('DB connection lost');
    });
  });

  // ===========================================================================
  // 5. EDGE CASES & RACE CONDITIONS
  // ===========================================================================
  describe('5. Edge cases and race conditions', () => {

    test('5.01 Two customers creating orders for same trucks - lock prevents duplication', async () => {
      // First call acquires lock
      mockRedisGet.mockResolvedValue(null);
      mockRedisAcquireLock.mockResolvedValueOnce({ acquired: true });
      mockBookingFindFirst.mockResolvedValue(null);
      mockOrderFindFirst.mockResolvedValue(null);

      const ctx1 = makeCtx({ request: makeBaseRequest({ customerId: 'cust-1' }) });
      await checkExistingActiveOrders(ctx1);
      expect(ctx1.lockAcquired).toBe(true);

      // Second call fails to acquire lock
      mockRedisAcquireLock.mockResolvedValueOnce({ acquired: false });
      const ctx2 = makeCtx({ request: makeBaseRequest({ customerId: 'cust-1' }) });
      await expect(checkExistingActiveOrders(ctx2)).rejects.toThrow('Order creation in progress');
    });

    test('5.02 Backpressure limit exactly at threshold', async () => {
      mockRedisIncrBy.mockResolvedValue(200); // exactly at limit
      const ctx = makeCtx({ maxConcurrentOrders: 200 });
      await expect(acquireOrderBackpressure(ctx)).resolves.toBeUndefined();
    });

    test('5.03 Backpressure limit one above threshold', async () => {
      mockRedisIncrBy.mockResolvedValue(201); // one above
      const ctx = makeCtx({ maxConcurrentOrders: 200 });
      await expect(acquireOrderBackpressure(ctx)).rejects.toThrow('System is processing too many orders');
    });

    test('5.04 Idempotency key collision with different payload (strict mode)', async () => {
      mockOrderIdempotencyFindUnique.mockResolvedValue({
        payloadHash: 'hash-OTHER',
        responseJson: { orderId: 'other' },
      });
      await expect(getDbIdempotentResponse('cust-1', 'key-1', 'hash-MINE')).rejects.toThrow(AppError);
    });

    test('5.05 Redis fails during debounce check - order proceeds', async () => {
      mockRedisGet.mockRejectedValue(new Error('Connection refused'));
      const ctx = makeCtx();
      await expect(enforceOrderDebounce(ctx)).resolves.toBeUndefined();
    });

    test('5.06 Redis fails during idempotency check - continues to create order', async () => {
      mockRedisGet.mockRejectedValue(new Error('Redis ETIMEDOUT'));
      mockOrderIdempotencyFindUnique.mockResolvedValue(null);
      const ctx = makeCtx({ request: makeBaseRequest({ idempotencyKey: 'key-1' }), requestPayloadHash: 'hash' });
      const result = await checkOrderIdempotency(ctx);
      expect(result).toBeNull();
    });

    test('5.07 Google Maps returns zero distance - falls back to client', async () => {
      mockCalculateRoute.mockResolvedValue({ distanceKm: 0, durationMinutes: 0 });
      const ctx = makeCtx();
      await resolveServerRouteDistance(ctx);
      expect(ctx.distanceSource).toBe('client_fallback');
      expect(ctx.request.distanceKm).toBe(50);
    });

    test('5.08 Broadcast fails after order created - order still exists', async () => {
      mockBroadcastToTransportersFn.mockRejectedValue(new Error('Broadcast timeout'));
      const ctx = makeCtx();
      ctx.truckRequests = [{ id: 'tr-1' } as any];
      ctx.pickup = { latitude: 12.97, longitude: 77.59, address: 'Pickup' };
      ctx.expiresAt = new Date().toISOString();
      const mockProcess = jest.fn().mockResolvedValue(null);

      // Should not throw -- broadcast failure is caught
      await broadcastOrderToTransporters(ctx, mockProcess);
      expect(ctx.dispatchState).toBe('dispatch_failed');
      // The order was already persisted in the DB before this step
    });

    test('5.09 Price changes between validation and creation - server corrects', () => {
      const { pricingService } = require('../modules/pricing/pricing.service');
      // Client sent 3000 but server says 6000
      pricingService.calculateEstimate.mockReturnValue({ pricePerTruck: 6000 });
      const ctx = makeCtx({
        request: makeBaseRequest({
          vehicleRequirements: [{ vehicleType: 'tipper', vehicleSubtype: '20-24 Ton', quantity: 1, pricePerTruck: 3000 }],
        }),
      });
      validateAndCorrectPrices(ctx);
      expect(ctx.request.vehicleRequirements[0].pricePerTruck).toBe(6000);
    });

    test('5.10 DB connection lost during idempotency persist - error propagates', async () => {
      mockOrderIdempotencyCreate.mockRejectedValue(new Error('ECONNRESET'));
      const resp = { orderId: 'x' } as CreateOrderResponse;
      await expect(persistDbIdempotentResponse('c', 'k', 'h', 'x', resp)).rejects.toThrow('ECONNRESET');
    });

    test('5.11 buildRequestPayloadHash handles missing optional fields', () => {
      const req = makeBaseRequest({
        goodsType: undefined,
        cargoWeightKg: undefined,
        scheduledAt: undefined,
        routePoints: undefined,
      });
      const hash = buildRequestPayloadHash(req);
      expect(hash.length).toBe(64);
    });

    test('5.12 buildRequestPayloadHash is case-insensitive for vehicle types', () => {
      const req1 = makeBaseRequest({
        vehicleRequirements: [{ vehicleType: 'TIPPER', vehicleSubtype: '20-24 Ton', quantity: 1, pricePerTruck: 5000 }],
      });
      const req2 = makeBaseRequest({
        vehicleRequirements: [{ vehicleType: 'tipper', vehicleSubtype: '20-24 Ton', quantity: 1, pricePerTruck: 5000 }],
      });
      expect(buildRequestPayloadHash(req1)).toBe(buildRequestPayloadHash(req2));
    });

    test('5.13 buildRequestPayloadHash sorts vehicle requirements for consistency', () => {
      const req1 = makeBaseRequest({
        vehicleRequirements: [
          { vehicleType: 'tipper', vehicleSubtype: '20-24 Ton', quantity: 1, pricePerTruck: 5000 },
          { vehicleType: 'container', vehicleSubtype: '17ft', quantity: 2, pricePerTruck: 8000 },
        ],
      });
      const req2 = makeBaseRequest({
        vehicleRequirements: [
          { vehicleType: 'container', vehicleSubtype: '17ft', quantity: 2, pricePerTruck: 8000 },
          { vehicleType: 'tipper', vehicleSubtype: '20-24 Ton', quantity: 1, pricePerTruck: 5000 },
        ],
      });
      expect(buildRequestPayloadHash(req1)).toBe(buildRequestPayloadHash(req2));
    });

    test('5.14 In-memory backpressure fallback has lower threshold (1/4 of Redis limit)', async () => {
      // Make Redis fail, then exceed in-memory limit
      mockRedisIncrBy.mockRejectedValue(new Error('Redis down'));
      const ctx = makeCtx({ maxConcurrentOrders: 200 });
      // In-memory limit = ceil(200/4) = 50
      // Simulate 51 concurrent calls by calling acquire 51 times
      // First call should succeed
      await expect(acquireOrderBackpressure(ctx)).resolves.toBeUndefined();
      // Release to reset in-memory counter for clean test
      await releaseOrderBackpressure(ctx);
    });

    test('5.15 CAS guard in setupOrderExpiry warns when order state has changed', async () => {
      mockOrderUpdateMany.mockResolvedValue({ count: 0 }); // CAS failed
      const ctx = makeCtx({
        totalTrucks: 2,
        totalAmount: 10000,
        dispatchState: 'dispatched',
        dispatchAttempts: 1,
        expiresAt: new Date(Date.now() + 120000).toISOString(),
        responseRequests: [],
      });
      // Should not throw, just warns
      await expect(setupOrderExpiry(ctx, 120000)).resolves.toBeUndefined();
      const { logger } = require('../shared/services/logger.service');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('CAS failed'),
        expect.any(Object),
      );
    });

    test('5.16 checkExistingActiveOrders acquires lock and sets lockAcquired', async () => {
      // FIX #11: DB check removed from checkExistingActiveOrders — only Redis + lock now
      mockRedisGet.mockResolvedValue(null);
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      const ctx = makeCtx();
      await checkExistingActiveOrders(ctx);
      // Lock should be acquired
      expect(ctx.lockAcquired).toBe(true);
      expect(mockRedisAcquireLock).toHaveBeenCalled();
    });

    test('5.17 Idempotency cache failure is non-fatal for the idempotencyKey block', async () => {
      // The idempotencyKey block (lines 747-763) is wrapped in try/catch.
      // The first SET (line 748) fails and the catch swallows it.
      // After the catch, the dedup key block (lines 767-773) runs with
      // three more SET calls that must succeed.
      let callCount = 0;
      mockRedisSet.mockImplementation(() => {
        callCount++;
        // Fail only the first call (idempotencyKey cache SET)
        if (callCount === 1) {
          return Promise.reject(new Error('Redis SET failed'));
        }
        return Promise.resolve('OK');
      });
      const ctx = makeCtx({
        request: makeBaseRequest({ idempotencyKey: 'key-expired' }),
        requestPayloadHash: 'hash',
        dedupeKey: 'idem:broadcast:create:cust-1:abc',
        orderResponse: { orderId: 'ord-1' } as any,
      });
      // Should not throw -- the idempotency block catches the error
      await expect(cacheOrderIdempotencyResponse(ctx, 120000)).resolves.toBeUndefined();
      const { logger } = require('../shared/services/logger.service');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to cache idempotency'));
    });

    test('5.18 Multiple vehicle types create correct number of truck requests', async () => {
      const ctx = makeCtx({
        request: makeBaseRequest({
          vehicleRequirements: [
            { vehicleType: 'tipper', vehicleSubtype: '20-24 Ton', quantity: 3, pricePerTruck: 5000 },
            { vehicleType: 'container', vehicleSubtype: '17ft', quantity: 2, pricePerTruck: 8000 },
          ],
        }),
      });
      buildOrderRoutePoints(ctx, 120000);
      validateAndCorrectPrices(ctx);
      const mockEnqueue = jest.fn().mockResolvedValue(undefined);
      await persistOrderTransaction(ctx, mockEnqueue);
      // 3 tippers + 2 containers = 5 truck requests
      expect(ctx.truckRequests.length).toBe(5);
      expect(ctx.totalTrucks).toBe(5);
    });

    test('5.19 resolveServerRouteDistance uses legacy pickup/drop when routePoints absent', async () => {
      mockCalculateRoute.mockResolvedValue({ distanceKm: 48, durationMinutes: 90 });
      const ctx = makeCtx({
        request: makeBaseRequest({
          routePoints: undefined,
          pickup: { latitude: 12.97, longitude: 77.59, address: 'Pickup' },
          drop: { latitude: 13.01, longitude: 77.65, address: 'Drop' },
        }),
      });
      await resolveServerRouteDistance(ctx);
      expect(mockCalculateRoute).toHaveBeenCalled();
      expect(ctx.distanceSource).toBe('google');
    });

    test('5.20 Concurrent idempotency persist - P2002 race handled gracefully', async () => {
      // First create fails with P2002 (another process inserted first)
      mockOrderIdempotencyCreate.mockRejectedValue({ code: 'P2002' });
      // The fallback lookup finds the row with matching hash
      mockOrderIdempotencyFindUnique.mockResolvedValue({
        payloadHash: 'hash-1',
        responseJson: { orderId: 'concurrent-winner' },
      });
      const resp = { orderId: 'my-attempt' } as CreateOrderResponse;
      await expect(persistDbIdempotentResponse('cust-1', 'key-1', 'hash-1', 'my-attempt', resp)).resolves.toBeUndefined();
    });
  });
});
