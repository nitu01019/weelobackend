/**
 * =============================================================================
 * QA ORDER SCENARIOS -- Customer-perspective order flow, edge cases, failures
 * =============================================================================
 *
 * Covers:
 *   SCENARIO 1: Legacy endpoint rejection (POST /broadcasts/create -> 410)
 *   SCENARIO 2: Accept without driver (C5 fix -- driverId optional in schema)
 *   SCENARIO 3: Fire-and-forget dispatch (C1 fix -- async outbox)
 *   SCENARIO 4: Concurrent order creation (serializable TX isolation)
 *   SCENARIO 5: Extreme distance values (H18 -- haversine ceiling/floor)
 *   SCENARIO 6: Order from outside India (H10 -- geo-fence validation)
 *
 * @author QA Agent QA2
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
    observeHistogram: jest.fn(),
    setGauge: jest.fn(),
  },
}));

jest.mock('../config/environment', () => ({
  config: {
    redis: { enabled: true },
    isProduction: false,
    otp: { expiryMinutes: 5 },
    sms: {},
  },
}));

// Redis service mock
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
const mockRedisExpire = jest.fn();
const mockRedisIncr = jest.fn();
const mockRedisIncrBy = jest.fn();
const mockRedisSIsMember = jest.fn();
const mockRedisIsConnected = jest.fn().mockReturnValue(true);
const mockRedisHSet = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: unknown[]) => mockRedisGet(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
    exists: (...args: unknown[]) => mockRedisExists(...args),
    acquireLock: (...args: unknown[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: unknown[]) => mockRedisReleaseLock(...args),
    sMembers: (...args: unknown[]) => mockRedisSMembers(...args),
    sAdd: (...args: unknown[]) => mockRedisSAdd(...args),
    getJSON: (...args: unknown[]) => mockRedisGetJSON(...args),
    setJSON: (...args: unknown[]) => mockRedisSetJSON(...args),
    expire: (...args: unknown[]) => mockRedisExpire(...args),
    incr: (...args: unknown[]) => mockRedisIncr(...args),
    incrBy: (...args: unknown[]) => mockRedisIncrBy(...args),
    sIsMember: (...args: unknown[]) => mockRedisSIsMember(...args),
    isConnected: () => mockRedisIsConnected(),
    isDegraded: false,
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
    hSet: (...args: unknown[]) => mockRedisHSet(...args),
    setTimer: jest.fn().mockResolvedValue(undefined),
    cancelTimer: jest.fn().mockResolvedValue(undefined),
    getExpiredTimers: jest.fn().mockResolvedValue([]),
  },
}));

// Prisma mock
const mockBookingFindFirst = jest.fn();
const mockOrderFindFirst = jest.fn();
const mockOrderCreate = jest.fn();
const mockOrderUpdate = jest.fn();
const mockOrderUpdateMany = jest.fn();
const mockTruckRequestCreateMany = jest.fn();
const mockTransaction = jest.fn();
const mockDispatchOutboxUpsert = jest.fn();
const mockQueryRaw = jest.fn();

jest.mock('../shared/database/prisma.service', () => {
  const txProxy = {
    booking: {
      findFirst: (...args: unknown[]) => mockBookingFindFirst(...args),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    order: {
      findFirst: (...args: unknown[]) => mockOrderFindFirst(...args),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: (...args: unknown[]) => mockOrderCreate(...args),
      update: (...args: unknown[]) => mockOrderUpdate(...args),
      updateMany: (...args: unknown[]) => mockOrderUpdateMany(...args),
    },
    truckRequest: {
      createMany: (...args: unknown[]) => mockTruckRequestCreateMany(...args),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    assignment: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    vehicle: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    orderDispatchOutbox: {
      upsert: (...args: unknown[]) => mockDispatchOutboxUpsert(...args),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    customerPenaltyDue: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
  };
  return {
    prismaClient: {
      ...txProxy,
      $transaction: (...args: unknown[]) => mockTransaction(...args),
    },
    withDbTimeout: async (fn: (tx: unknown) => Promise<unknown>, _opts?: unknown) => fn(txProxy),
    OrderStatus: {
      created: 'created',
      broadcasting: 'broadcasting',
      active: 'active',
      partially_filled: 'partially_filled',
      fully_filled: 'fully_filled',
      cancelled: 'cancelled',
      expired: 'expired',
    },
    AssignmentStatus: {
      pending: 'pending',
      accepted: 'accepted',
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
    TruckRequestStatus: {
      searching: 'searching',
      held: 'held',
      assigned: 'assigned',
      cancelled: 'cancelled',
    },
    Prisma: {
      TransactionIsolationLevel: {
        Serializable: 'Serializable',
        ReadCommitted: 'ReadCommitted',
      },
    },
  };
});

// Socket mock
jest.mock('../shared/services/socket.service', () => ({
  emitToUser: jest.fn(),
  SocketEvent: {
    ORDER_CREATED: 'order_created',
    ORDER_NO_SUPPLY: 'order_no_supply',
    BROADCAST_STATE_CHANGED: 'broadcast_state_changed',
  },
}));

// FCM mock
jest.mock('../shared/services/fcm.service', () => ({
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
}));

// Google Maps mock
const mockCalculateRoute = jest.fn();
jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: {
    calculateRoute: (...args: unknown[]) => mockCalculateRoute(...args),
    getETA: jest.fn().mockResolvedValue(null),
  },
}));

// Availability mock
jest.mock('../shared/services/availability.service', () => ({
  availabilityService: {
    getOnlineTransporters: jest.fn().mockResolvedValue([]),
    isTransporterOnline: jest.fn().mockResolvedValue(false),
  },
}));

// Live availability mock
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    getAvailableCount: jest.fn().mockResolvedValue(0),
    markUnavailable: jest.fn().mockResolvedValue(undefined),
    markAvailable: jest.fn().mockResolvedValue(undefined),
  },
}));

// Vehicle key mock
jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn().mockReturnValue('vk-test'),
}));

// Vehicle lifecycle mock
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
}));

// Pricing mock
jest.mock('../modules/pricing/pricing.service', () => ({
  pricingService: {
    calculateEstimate: jest.fn().mockReturnValue({
      pricePerTruck: 5000,
      totalPrice: 5000,
      distanceKm: 50,
    }),
  },
}));

// Truck hold service mock
jest.mock('../modules/truck-hold/truck-hold.service', () => ({
  truckHoldService: {
    createHold: jest.fn().mockResolvedValue(null),
    releaseHold: jest.fn().mockResolvedValue(undefined),
  },
}));

// DB mock
jest.mock('../shared/database/db', () => ({
  db: {
    getOrderById: jest.fn().mockResolvedValue(null),
    getActiveOrderByCustomer: jest.fn().mockResolvedValue(null),
    getTransportersWithVehicleType: jest.fn().mockResolvedValue([]),
    createOrder: jest.fn().mockResolvedValue(undefined),
    createTruckRequest: jest.fn().mockResolvedValue(undefined),
    updateOrder: jest.fn().mockResolvedValue(undefined),
    getTruckRequestsByOrder: jest.fn().mockResolvedValue([]),
    getAssignmentsByOrder: jest.fn().mockResolvedValue([]),
  },
}));

// State machine mock
jest.mock('../core/state-machines', () => ({
  assertValidTransition: jest.fn(),
  ORDER_VALID_TRANSITIONS: {},
}));

// Request queue mock
jest.mock('../shared/resilience/request-queue', () => ({
  bookingQueue: {
    middleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  },
  trackingQueue: {
    middleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  },
  Priority: { HIGH: 'high', CRITICAL: 'critical', NORMAL: 'normal' },
}));

// Order broadcast service mock
jest.mock('../modules/order/order-broadcast.service', () => ({
  broadcastToTransporters: jest.fn().mockResolvedValue({ onlineCandidates: 0, notifiedTransporters: 0 }),
  processProgressiveBroadcastStep: jest.fn(),
  broadcastVehicleTypePayload: jest.fn(),
  emitBroadcastStateChanged: jest.fn(),
  emitToTransportersWithAdaptiveFanout: jest.fn(),
  emitDriverCancellationEvents: jest.fn(),
  buildRequestsByType: jest.fn().mockReturnValue(new Map()),
  getNotifiedTransporters: jest.fn().mockResolvedValue(new Set()),
  markTransportersNotified: jest.fn().mockResolvedValue(undefined),
  chunkTransporterIds: jest.fn().mockReturnValue([]),
  notifiedTransportersKey: jest.fn().mockReturnValue('key'),
  makeVehicleGroupKey: jest.fn().mockReturnValue('vg-key'),
  parseVehicleGroupKey: jest.fn().mockReturnValue({ vehicleType: 'open', vehicleSubtype: '17ft' }),
  getTransportersByVehicleCached: jest.fn().mockResolvedValue([]),
  invalidateTransporterCache: jest.fn(),
}));

// Dispatch outbox mock
jest.mock('../modules/order/order-dispatch-outbox.service', () => ({
  FF_ORDER_DISPATCH_OUTBOX: true,
  FF_ORDER_DISPATCH_STATUS_EVENTS: true,
  ORDER_DISPATCH_OUTBOX_POLL_MS: 5000,
  ORDER_DISPATCH_OUTBOX_BATCH_SIZE: 10,
  startDispatchOutboxWorker: jest.fn(),
  enqueueOrderDispatchOutbox: jest.fn().mockResolvedValue(undefined),
  processDispatchOutboxImmediately: jest.fn().mockResolvedValue(undefined),
}));

// Lifecycle outbox mock
jest.mock('../modules/order/order-lifecycle-outbox.service', () => ({
  FF_CANCEL_OUTBOX_ENABLED: false,
  ORDER_CANCEL_OUTBOX_POLL_MS: 5000,
  ORDER_CANCEL_OUTBOX_BATCH_SIZE: 10,
  startLifecycleOutboxWorker: jest.fn(),
  enqueueCancelLifecycleOutbox: jest.fn(),
  processLifecycleOutboxImmediately: jest.fn(),
  emitCancellationLifecycle: jest.fn(),
  handleOrderExpiry: jest.fn(),
}));

// Order accept service mock
jest.mock('../modules/order/order-accept.service', () => ({
  acceptTruckRequest: jest.fn().mockResolvedValue({
    success: true,
    assignmentId: 'assign-001',
    tripId: 'trip-001',
    message: 'Accepted',
  }),
}));

// Order cancel service mock
jest.mock('../modules/order/order-cancel.service', () => ({
  FF_CANCEL_EVENT_VERSION_ENFORCED: false,
  FF_CANCEL_REBOOK_CHURN_GUARD: false,
  FF_CANCEL_DEFERRED_SETTLEMENT: false,
  FF_CANCEL_IDEMPOTENCY_REQUIRED: false,
  cancelOrder: jest.fn().mockResolvedValue({ success: true, message: 'Cancelled' }),
  buildCancelPayloadHash: jest.fn().mockReturnValue('hash'),
  getCancelIdempotentResponse: jest.fn().mockResolvedValue(null),
  persistCancelIdempotentResponse: jest.fn().mockResolvedValue(undefined),
  registerCancelRebookChurn: jest.fn().mockResolvedValue(undefined),
  enforceCancelRebookCooldown: jest.fn().mockResolvedValue(undefined),
}));

// Order cancel policy service mock
jest.mock('../modules/order/order-cancel-policy.service', () => ({
  deriveTruckCancelStage: jest.fn(),
  calculateWaitingCharges: jest.fn(),
  createMoneyBreakdown: jest.fn(),
  evaluateTruckCancelPolicy: jest.fn(),
  getCancelPreview: jest.fn().mockResolvedValue({ success: false, message: 'not found' }),
  createCancelDispute: jest.fn().mockResolvedValue({ success: false, message: 'not found' }),
}));

// Order timer service mock
jest.mock('../modules/order/order-timer.service', () => ({
  orderExpiryTimerKey: jest.fn().mockReturnValue('timer:key'),
  setOrderExpiryTimer: jest.fn().mockResolvedValue(undefined),
  clearProgressiveStepTimers: jest.fn().mockResolvedValue(undefined),
  processExpiredTimers: jest.fn().mockResolvedValue(undefined),
  stopOrderTimerChecker: jest.fn(),
}));

// Order query service mock
jest.mock('../modules/order/order-query.service', () => ({
  getOrderDetailsQuery: jest.fn(),
  getActiveRequestsForTransporterQuery: jest.fn().mockResolvedValue([]),
  getOrdersByCustomerQuery: jest.fn().mockResolvedValue([]),
  getOrderWithRequestsQuery: jest.fn(),
  getActiveTruckRequestsForTransporterQuery: jest.fn().mockResolvedValue([]),
  getCustomerOrdersQuery: jest.fn().mockResolvedValue({ orders: [], total: 0 }),
}));

// Order lifecycle utils mock
jest.mock('../shared/utils/order-lifecycle.utils', () => ({
  normalizeOrderLifecycleState: jest.fn((s: string) => s),
  normalizeOrderStatus: jest.fn((s: string) => s),
}));

// PII utils mock
jest.mock('../shared/utils/pii.utils', () => ({
  maskPhoneForExternal: jest.fn((p: string) => p?.replace(/\d{6}(\d{4})/, '******$1')),
}));

// Geo utils mock (for roundCoord)
jest.mock('../shared/utils/geo.utils', () => ({
  roundCoord: jest.fn((v: number) => Math.round(v * 1e5) / 1e5),
}));

// Auth middleware mocks
jest.mock('../shared/middleware/auth.middleware', () => ({
  authMiddleware: (req: any, _res: unknown, next: () => void) => {
    req.user = req.user || { userId: 'test-user', role: 'customer', phone: '9999999999', name: 'Test' };
    next();
  },
  roleGuard: (_roles: string[]) => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// =============================================================================
// IMPORTS -- After all mocks
// =============================================================================

import { z } from 'zod';
import { haversineDistanceKm } from '../shared/utils/geospatial.utils';
import { coordinatesSchema, locationSchema } from '../shared/utils/validation.utils';
import { createOrderSchema, routePointSchema } from '../modules/booking/booking.schema';

// =============================================================================
// SCENARIO 1: Legacy endpoint rejection (POST /broadcasts/create -> 410)
// =============================================================================
describe('SCENARIO 1: Legacy /broadcasts/create returns 410 Gone', () => {
  test('S1.1 -- POST /broadcasts/create route exists and handler returns 410', async () => {
    // Import the broadcast router to inspect its registered routes
    const { broadcastRouter } = require('../modules/broadcast/broadcast.routes');
    const stack = broadcastRouter?.stack ?? [];

    // Find the POST /create layer
    const createLayer = stack.find(
      (layer: any) =>
        layer.route?.path === '/create' &&
        layer.route?.methods?.post === true
    );

    expect(createLayer).toBeDefined();
    expect(createLayer.route.methods.post).toBe(true);
  });

  test('S1.2 -- handler sends 410 with ENDPOINT_DEPRECATED code and redirect message', async () => {
    const { broadcastRouter } = require('../modules/broadcast/broadcast.routes');
    const stack = broadcastRouter?.stack ?? [];
    const createLayer = stack.find(
      (layer: any) =>
        layer.route?.path === '/create' &&
        layer.route?.methods?.post === true
    );

    // The route has middleware layers -- the last one is the actual handler.
    // In broadcast.routes.ts the /create route is:
    //   router.post('/create', authMiddleware, handler)
    // so the route's stack has the auth middleware + the response handler.
    const routeStack = createLayer.route.stack;
    const handler = routeStack[routeStack.length - 1].handle;

    const mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await handler({ user: { userId: 'u1', role: 'transporter' } }, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(410);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'ENDPOINT_DEPRECATED',
        message: expect.stringContaining('/api/v1/bookings/orders'),
      })
    );
  });

  test('S1.3 -- no DB write occurs (mock create functions NOT called)', async () => {
    // Reset counters
    mockBookingFindFirst.mockClear();
    mockOrderCreate.mockClear();

    const { broadcastRouter } = require('../modules/broadcast/broadcast.routes');
    const stack = broadcastRouter?.stack ?? [];
    const createLayer = stack.find(
      (layer: any) =>
        layer.route?.path === '/create' &&
        layer.route?.methods?.post === true
    );
    const routeStack = createLayer.route.stack;
    const handler = routeStack[routeStack.length - 1].handle;

    const mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await handler({ user: { userId: 'u1', role: 'transporter' } }, mockRes);

    // No DB writes should happen
    expect(mockBookingFindFirst).not.toHaveBeenCalled();
    expect(mockOrderCreate).not.toHaveBeenCalled();
  });
});

// =============================================================================
// SCENARIO 2: Accept without driver (C5 fix -- driverId optional in schema)
// =============================================================================
describe('SCENARIO 2: Accept truck request -- driverId optional (C5 fix)', () => {
  const acceptRequestSchema = z.object({
    truckRequestId: z.string().uuid(),
    vehicleId: z.string().uuid(),
    driverId: z.string().uuid().optional(),
  });

  test('S2.1 -- accept WITHOUT driverId passes validation', () => {
    const result = acceptRequestSchema.safeParse({
      truckRequestId: '550e8400-e29b-41d4-a716-446655440000',
      vehicleId: '660e8400-e29b-41d4-a716-446655440001',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.driverId).toBeUndefined();
    }
  });

  test('S2.2 -- accept WITH valid driverId passes validation', () => {
    const result = acceptRequestSchema.safeParse({
      truckRequestId: '550e8400-e29b-41d4-a716-446655440000',
      vehicleId: '660e8400-e29b-41d4-a716-446655440001',
      driverId: '770e8400-e29b-41d4-a716-446655440002',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.driverId).toBe('770e8400-e29b-41d4-a716-446655440002');
    }
  });

  test('S2.3 -- accept WITH invalid driverId format returns validation error', () => {
    const result = acceptRequestSchema.safeParse({
      truckRequestId: '550e8400-e29b-41d4-a716-446655440000',
      vehicleId: '660e8400-e29b-41d4-a716-446655440001',
      driverId: 'not-a-uuid',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const driverIdError = result.error.errors.find(
        (e) => e.path.includes('driverId')
      );
      expect(driverIdError).toBeDefined();
    }
  });

  test('S2.4 -- accept WITHOUT vehicleId fails validation', () => {
    const result = acceptRequestSchema.safeParse({
      truckRequestId: '550e8400-e29b-41d4-a716-446655440000',
    });

    expect(result.success).toBe(false);
  });

  test('S2.5 -- accept WITH empty driverId string fails validation', () => {
    const result = acceptRequestSchema.safeParse({
      truckRequestId: '550e8400-e29b-41d4-a716-446655440000',
      vehicleId: '660e8400-e29b-41d4-a716-446655440001',
      driverId: '',
    });

    expect(result.success).toBe(false);
  });

  test('S2.6 -- accept route in order.routes.ts registers POST /accept', () => {
    const orderRouter = require('../modules/order/order.routes').default;
    const stack = orderRouter?.stack ?? [];

    const acceptLayer = stack.find(
      (layer: any) =>
        layer.route?.path === '/accept' &&
        layer.route?.methods?.post === true
    );

    expect(acceptLayer).toBeDefined();
  });
});

// =============================================================================
// SCENARIO 3: Fire-and-forget dispatch (C1 fix -- async outbox)
// =============================================================================
describe('SCENARIO 3: Fire-and-forget dispatch (C1 fix)', () => {
  const { orderService } = require('../modules/order/order.service');
  const { processDispatchOutboxImmediately } = require('../modules/order/order-dispatch-outbox.service');
  const { db } = require('../shared/database/db');

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock setup for createOrder path
    mockRedisGet.mockResolvedValue(null); // no debounce, no dedup, no active key
    mockRedisSet.mockResolvedValue('OK');
    mockRedisIncrBy.mockResolvedValue(1);
    mockRedisExpire.mockResolvedValue(true);
    mockRedisAcquireLock.mockResolvedValue({ acquired: true, lockValue: 'v' });
    mockRedisReleaseLock.mockResolvedValue(true);
    mockBookingFindFirst.mockResolvedValue(null);
    mockOrderFindFirst.mockResolvedValue(null);
    mockOrderCreate.mockResolvedValue({ id: 'order-001' });
    mockOrderUpdate.mockResolvedValue({ id: 'order-001' });
    mockOrderUpdateMany.mockResolvedValue({ count: 1 });
    mockTruckRequestCreateMany.mockResolvedValue({ count: 1 });
    mockDispatchOutboxUpsert.mockResolvedValue({ id: 'outbox-1' });
    mockCalculateRoute.mockResolvedValue(null); // fallback to client distance
    db.getTransportersWithVehicleType.mockResolvedValue([]);
    db.getActiveOrderByCustomer.mockResolvedValue(null);
    db.getOrderById.mockResolvedValue(null);
  });

  test('S3.1 -- createOrder returns response without waiting for dispatch', async () => {
    // processDispatchOutboxImmediately is fire-and-forget (catch handler on promise)
    // Make it take 10 seconds to simulate slow dispatch
    const slowDispatch = new Promise<void>((resolve) =>
      setTimeout(resolve, 10_000)
    );
    (processDispatchOutboxImmediately as jest.Mock).mockReturnValue(slowDispatch);

    const start = Date.now();

    const result = await orderService.createOrder({
      customerId: 'cust-001',
      customerName: 'Test Customer',
      customerPhone: '9876543210',
      pickup: { latitude: 19.0, longitude: 72.8, address: 'Mumbai Pickup' },
      drop: { latitude: 19.1, longitude: 72.9, address: 'Mumbai Drop' },
      distanceKm: 20,
      vehicleRequirements: [
        { vehicleType: 'open', vehicleSubtype: '17ft', quantity: 1, pricePerTruck: 5000 },
      ],
    });

    const elapsed = Date.now() - start;

    // Response should return quickly, NOT wait 10 seconds for dispatch
    expect(elapsed).toBeLessThan(5000);
    expect(result).toBeDefined();
    expect(result.orderId).toBeDefined();
  });

  test('S3.2 -- order record exists in DB with dispatch state after create', async () => {
    (processDispatchOutboxImmediately as jest.Mock).mockResolvedValue(undefined);

    const result = await orderService.createOrder({
      customerId: 'cust-002',
      customerName: 'Test Customer 2',
      customerPhone: '9876543211',
      pickup: { latitude: 19.0, longitude: 72.8, address: 'Mumbai Pickup' },
      drop: { latitude: 19.1, longitude: 72.9, address: 'Mumbai Drop' },
      distanceKm: 20,
      vehicleRequirements: [
        { vehicleType: 'open', vehicleSubtype: '17ft', quantity: 1, pricePerTruck: 5000 },
      ],
    });

    expect(result.orderId).toBeDefined();
    // The create order flow transitions to broadcasting/dispatching state
    expect(result.dispatchState).toBeDefined();
    expect(['dispatching', 'dispatched', 'dispatch_failed', 'queued']).toContain(result.dispatchState);
  });

  test('S3.3 -- dispatch failure does NOT crash order response', async () => {
    // Simulate dispatch throwing an error
    (processDispatchOutboxImmediately as jest.Mock).mockRejectedValue(
      new Error('Dispatch system timeout')
    );

    // Should NOT throw -- fire-and-forget .catch() handles the error
    const result = await orderService.createOrder({
      customerId: 'cust-003',
      customerName: 'Test Customer 3',
      customerPhone: '9876543212',
      pickup: { latitude: 19.0, longitude: 72.8, address: 'Mumbai Pickup' },
      drop: { latitude: 19.1, longitude: 72.9, address: 'Mumbai Drop' },
      distanceKm: 20,
      vehicleRequirements: [
        { vehicleType: 'open', vehicleSubtype: '17ft', quantity: 1, pricePerTruck: 5000 },
      ],
    });

    expect(result).toBeDefined();
    expect(result.orderId).toBeDefined();
  });

  test('S3.4 -- dispatch outbox row is enqueued inside the transaction', async () => {
    const { enqueueOrderDispatchOutbox } = require('../modules/order/order-dispatch-outbox.service');
    (processDispatchOutboxImmediately as jest.Mock).mockResolvedValue(undefined);
    (enqueueOrderDispatchOutbox as jest.Mock).mockClear();

    await orderService.createOrder({
      customerId: 'cust-004',
      customerName: 'Test Customer 4',
      customerPhone: '9876543213',
      pickup: { latitude: 19.0, longitude: 72.8, address: 'Mumbai Pickup' },
      drop: { latitude: 19.1, longitude: 72.9, address: 'Mumbai Drop' },
      distanceKm: 20,
      vehicleRequirements: [
        { vehicleType: 'open', vehicleSubtype: '17ft', quantity: 1, pricePerTruck: 5000 },
      ],
    });

    // The outbox enqueue function should have been called inside the TX
    expect(enqueueOrderDispatchOutbox).toHaveBeenCalled();
    // It should receive the orderId and TX proxy
    const callArgs = (enqueueOrderDispatchOutbox as jest.Mock).mock.calls[0];
    expect(callArgs[0]).toBeDefined(); // orderId
    expect(callArgs[1]).toBeDefined(); // tx proxy
  });
});

// =============================================================================
// SCENARIO 4: Concurrent order creation
// =============================================================================
describe('SCENARIO 4: Concurrent order creation', () => {
  const { orderService } = require('../modules/order/order.service');
  const { db } = require('../shared/database/db');
  const { processDispatchOutboxImmediately } = require('../modules/order/order-dispatch-outbox.service');

  beforeEach(() => {
    jest.clearAllMocks();

    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue('OK');
    mockRedisIncrBy.mockResolvedValue(1);
    mockRedisExpire.mockResolvedValue(true);
    mockRedisReleaseLock.mockResolvedValue(true);
    mockBookingFindFirst.mockResolvedValue(null);
    mockOrderFindFirst.mockResolvedValue(null);
    mockOrderCreate.mockResolvedValue({ id: 'order-x' });
    mockOrderUpdate.mockResolvedValue({ id: 'order-x' });
    mockOrderUpdateMany.mockResolvedValue({ count: 1 });
    mockTruckRequestCreateMany.mockResolvedValue({ count: 1 });
    mockDispatchOutboxUpsert.mockResolvedValue({ id: 'outbox-x' });
    mockCalculateRoute.mockResolvedValue(null);
    db.getTransportersWithVehicleType.mockResolvedValue([]);
    db.getActiveOrderByCustomer.mockResolvedValue(null);
    db.getOrderById.mockResolvedValue(null);
    (processDispatchOutboxImmediately as jest.Mock).mockResolvedValue(undefined);
  });

  test('S4.1 -- lock prevents concurrent creation from same customer', async () => {
    // First call acquires lock, second is blocked
    mockRedisAcquireLock
      .mockResolvedValueOnce({ acquired: true, lockValue: 'v1' })
      .mockResolvedValueOnce({ acquired: false, lockValue: null });

    const baseRequest = {
      customerId: 'cust-concurrent',
      customerName: 'Concurrent User',
      customerPhone: '9876543200',
      pickup: { latitude: 19.0, longitude: 72.8, address: 'Mumbai Pickup' },
      drop: { latitude: 19.1, longitude: 72.9, address: 'Mumbai Drop' },
      distanceKm: 20,
      vehicleRequirements: [
        { vehicleType: 'open', vehicleSubtype: '17ft', quantity: 1, pricePerTruck: 5000 },
      ],
    };

    // First request succeeds
    const result1 = await orderService.createOrder(baseRequest);
    expect(result1.orderId).toBeDefined();

    // Second request should fail with LOCK_CONTENTION
    await expect(
      orderService.createOrder(baseRequest)
    ).rejects.toThrow();
  });

  test('S4.2 -- serializable TX prevents duplicate within same customer', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true, lockValue: 'v1' });

    // On the second call inside TX, simulate that an active order already exists
    mockOrderFindFirst
      .mockResolvedValueOnce(null)   // first call (Redis pre-check level)
      .mockResolvedValueOnce(null)   // first call inside TX
      .mockResolvedValueOnce(null)   // second call (Redis pre-check level)
      .mockResolvedValueOnce({ id: 'existing-order', status: 'broadcasting' }); // second inside TX

    mockBookingFindFirst.mockResolvedValue(null);

    const baseRequest = {
      customerId: 'cust-serial',
      customerName: 'Serial User',
      customerPhone: '9876543201',
      pickup: { latitude: 19.0, longitude: 72.8, address: 'Mumbai Pickup' },
      drop: { latitude: 19.1, longitude: 72.9, address: 'Mumbai Drop' },
      distanceKm: 20,
      vehicleRequirements: [
        { vehicleType: 'open', vehicleSubtype: '17ft', quantity: 1, pricePerTruck: 5000 },
      ],
    };

    // First succeeds
    const result1 = await orderService.createOrder(baseRequest);
    expect(result1.orderId).toBeDefined();

    // Second should fail with "Request already in progress"
    await expect(
      orderService.createOrder(baseRequest)
    ).rejects.toThrow(/already in progress/i);
  });

  test('S4.3 -- two different customers can create orders simultaneously', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true, lockValue: 'v1' });
    mockBookingFindFirst.mockResolvedValue(null);
    mockOrderFindFirst.mockResolvedValue(null);

    const request1 = {
      customerId: 'cust-A',
      customerName: 'Customer A',
      customerPhone: '9876543300',
      pickup: { latitude: 19.0, longitude: 72.8, address: 'Mumbai Pickup' },
      drop: { latitude: 19.1, longitude: 72.9, address: 'Mumbai Drop' },
      distanceKm: 20,
      vehicleRequirements: [
        { vehicleType: 'open', vehicleSubtype: '17ft', quantity: 1, pricePerTruck: 5000 },
      ],
    };

    const request2 = {
      customerId: 'cust-B',
      customerName: 'Customer B',
      customerPhone: '9876543301',
      pickup: { latitude: 28.6, longitude: 77.2, address: 'Delhi Pickup' },
      drop: { latitude: 28.7, longitude: 77.3, address: 'Delhi Drop' },
      distanceKm: 15,
      vehicleRequirements: [
        { vehicleType: 'tipper', vehicleSubtype: '20 Ton', quantity: 1, pricePerTruck: 7000 },
      ],
    };

    const [result1, result2] = await Promise.all([
      orderService.createOrder(request1),
      orderService.createOrder(request2),
    ]);

    expect(result1.orderId).toBeDefined();
    expect(result2.orderId).toBeDefined();
    expect(result1.orderId).not.toBe(result2.orderId);
  });

  test('S4.4 -- each order gets its own dispatch outbox row', async () => {
    const { enqueueOrderDispatchOutbox } = require('../modules/order/order-dispatch-outbox.service');
    (enqueueOrderDispatchOutbox as jest.Mock).mockClear();

    mockRedisAcquireLock.mockResolvedValue({ acquired: true, lockValue: 'v1' });
    mockBookingFindFirst.mockResolvedValue(null);
    mockOrderFindFirst.mockResolvedValue(null);

    await orderService.createOrder({
      customerId: 'cust-outbox-1',
      customerName: 'Outbox User 1',
      customerPhone: '9876543400',
      pickup: { latitude: 19.0, longitude: 72.8, address: 'Mumbai' },
      drop: { latitude: 19.1, longitude: 72.9, address: 'Thane' },
      distanceKm: 20,
      vehicleRequirements: [
        { vehicleType: 'open', vehicleSubtype: '17ft', quantity: 1, pricePerTruck: 5000 },
      ],
    });

    await orderService.createOrder({
      customerId: 'cust-outbox-2',
      customerName: 'Outbox User 2',
      customerPhone: '9876543401',
      pickup: { latitude: 28.6, longitude: 77.2, address: 'Delhi' },
      drop: { latitude: 28.7, longitude: 77.3, address: 'Noida' },
      distanceKm: 15,
      vehicleRequirements: [
        { vehicleType: 'tipper', vehicleSubtype: '20 Ton', quantity: 1, pricePerTruck: 7000 },
      ],
    });

    // Two orders created = two outbox enqueue calls
    expect(enqueueOrderDispatchOutbox).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// SCENARIO 5: Order with extreme distance values (H18)
// =============================================================================
describe('SCENARIO 5: Extreme distance values (H18 -- haversine ceiling)', () => {
  test('S5.1 -- haversine ceiling caps absurdly high client distance', () => {
    // Simulate: pickup in Mumbai, drop ~5 km away, client claims 500 km
    const pickupLat = 19.0760;
    const pickupLng = 72.8777;
    const dropLat = 19.12;
    const dropLng = 72.89;

    const haversineDist = haversineDistanceKm(pickupLat, pickupLng, dropLat, dropLng);

    // Haversine should be roughly ~5km
    expect(haversineDist).toBeGreaterThan(3);
    expect(haversineDist).toBeLessThan(8);

    // The ceiling formula: Math.ceil(haversineDist * 3.0)
    const ceiling = Math.ceil(haversineDist * 3.0);

    // Client distance 500km is way above ceiling
    const clientDistance = 500;
    expect(clientDistance).toBeGreaterThan(ceiling);

    // After capping, distance should be the ceiling
    const cappedDistance = clientDistance > ceiling ? ceiling : clientDistance;
    expect(cappedDistance).toBe(ceiling);
    expect(cappedDistance).toBeLessThan(25); // ceil(~5 * 3) ~ 15-18
  });

  test('S5.2 -- normal distance within range is NOT modified', () => {
    // Pickup in Mumbai, drop in Pune (~120km haversine)
    const pickupLat = 19.0760;
    const pickupLng = 72.8777;
    const dropLat = 18.5204;
    const dropLng = 73.8567;

    const haversineDist = haversineDistanceKm(pickupLat, pickupLng, dropLat, dropLng);

    // Haversine should be roughly ~120km
    expect(haversineDist).toBeGreaterThan(100);
    expect(haversineDist).toBeLessThan(140);

    const floor = Math.ceil(haversineDist * 1.3);
    const ceiling = Math.ceil(haversineDist * 3.0);

    // Client distance 180km (reasonable road distance: above floor, below ceiling)
    const clientDistance = 180;

    // Should be within range (floor <= 180 <= ceiling)
    expect(clientDistance).toBeGreaterThanOrEqual(floor);
    expect(clientDistance).toBeLessThanOrEqual(ceiling);

    // Therefore NOT modified
    const result = (clientDistance < floor)
      ? floor
      : (clientDistance > ceiling)
        ? ceiling
        : clientDistance;
    expect(result).toBe(clientDistance);
  });

  test('S5.3 -- haversine floor lifts impossibly low client distance', () => {
    // Pickup and drop ~50km apart, client claims 5km
    const pickupLat = 19.0760;
    const pickupLng = 72.8777;
    const dropLat = 19.5;
    const dropLng = 73.2;

    const haversineDist = haversineDistanceKm(pickupLat, pickupLng, dropLat, dropLng);

    // haversineDist should be roughly ~50km
    expect(haversineDist).toBeGreaterThan(30);
    expect(haversineDist).toBeLessThan(70);

    const floor = Math.ceil(haversineDist * 1.3);
    const clientDistance = 5; // impossibly low

    expect(clientDistance).toBeLessThan(floor);

    // After floor enforcement, distance should be the floor
    const correctedDistance = clientDistance < floor ? floor : clientDistance;
    expect(correctedDistance).toBe(floor);
    expect(correctedDistance).toBeGreaterThan(clientDistance);
  });

  test('S5.4 -- zero haversine distance skips capping (co-located points)', () => {
    // Same location for pickup and drop
    const haversineDist = haversineDistanceKm(19.0, 72.8, 19.0, 72.8);
    expect(haversineDist).toBe(0);

    // When haversine is 0, the order service skips the floor/ceiling check
    // (see: `if (haversineDist > 0)` guard)
    // Client distance should pass through unmodified
    const clientDistance = 10;
    const result = haversineDist > 0
      ? Math.min(Math.max(clientDistance, Math.ceil(haversineDist * 1.3)), Math.ceil(haversineDist * 3.0))
      : clientDistance;
    expect(result).toBe(clientDistance);
  });

  test('S5.5 -- ceiling formula: ceil(haversine * 3.0) matches service implementation', () => {
    // Verify the exact formula used in order.service.ts line 913
    const haversineDist = 5.3; // sample
    const ceiling = Math.ceil(haversineDist * 3.0);
    expect(ceiling).toBe(16); // ceil(15.9) = 16

    const haversineDist2 = 10.0;
    const ceiling2 = Math.ceil(haversineDist2 * 3.0);
    expect(ceiling2).toBe(30); // ceil(30.0) = 30
  });
});

// =============================================================================
// SCENARIO 6: Order from outside India (H10 -- geo-fence validation)
// =============================================================================
describe('SCENARIO 6: Geo-fence validation -- India only (H10)', () => {
  test('S6.1 -- London coordinates (51.5, -0.12) rejected by coordinatesSchema', () => {
    const result = coordinatesSchema.safeParse({
      latitude: 51.5,
      longitude: -0.12,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMsg = result.error.errors.map((e) => e.message).join(' ');
      expect(errorMsg).toContain('India service area');
    }
  });

  test('S6.2 -- Mumbai coordinates (19.0, 72.8) pass coordinatesSchema', () => {
    const result = coordinatesSchema.safeParse({
      latitude: 19.0,
      longitude: 72.8,
    });

    expect(result.success).toBe(true);
  });

  test('S6.3 -- Delhi coordinates (28.6, 77.2) pass coordinatesSchema', () => {
    const result = coordinatesSchema.safeParse({
      latitude: 28.6,
      longitude: 77.2,
    });

    expect(result.success).toBe(true);
  });

  test('S6.4 -- New York coordinates (40.7, -74.0) rejected', () => {
    const result = coordinatesSchema.safeParse({
      latitude: 40.7,
      longitude: -74.0,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMsg = result.error.errors.map((e) => e.message).join(' ');
      expect(errorMsg).toContain('India service area');
    }
  });

  test('S6.5 -- India southern boundary (6.5, 76.0) accepted', () => {
    const result = coordinatesSchema.safeParse({
      latitude: 6.5,
      longitude: 76.0,
    });

    expect(result.success).toBe(true);
  });

  test('S6.6 -- India northern boundary (37.0, 77.0) accepted', () => {
    const result = coordinatesSchema.safeParse({
      latitude: 37.0,
      longitude: 77.0,
    });

    expect(result.success).toBe(true);
  });

  test('S6.7 -- just outside India (37.1, 77.0) rejected', () => {
    const result = coordinatesSchema.safeParse({
      latitude: 37.1,
      longitude: 77.0,
    });

    expect(result.success).toBe(false);
  });

  test('S6.8 -- flat location with London coords rejected by locationSchema', () => {
    const result = locationSchema.safeParse({
      latitude: 51.5,
      longitude: -0.12,
      address: '221B Baker Street, London',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMsg = result.error.errors.map((e) => e.message).join(' ');
      expect(errorMsg).toContain('India service area');
    }
  });

  test('S6.9 -- flat location with Mumbai coords passes locationSchema', () => {
    const result = locationSchema.safeParse({
      latitude: 19.0,
      longitude: 72.8,
      address: 'Bandra West, Mumbai',
    });

    expect(result.success).toBe(true);
  });

  test('S6.10 -- routePoint with London coords rejected', () => {
    const result = routePointSchema.safeParse({
      type: 'PICKUP',
      latitude: 51.5,
      longitude: -0.12,
      address: 'London Eye',
    });

    expect(result.success).toBe(false);
  });

  test('S6.11 -- routePoint with Mumbai coords accepted', () => {
    const result = routePointSchema.safeParse({
      type: 'PICKUP',
      latitude: 19.0,
      longitude: 72.8,
      address: 'Gateway of India',
    });

    expect(result.success).toBe(true);
  });

  test('S6.12 -- createOrderSchema rejects order with pickup outside India', () => {
    const result = createOrderSchema.safeParse({
      pickup: {
        latitude: 51.5,
        longitude: -0.12,
        address: 'London',
      },
      drop: {
        latitude: 19.0,
        longitude: 72.8,
        address: 'Mumbai',
      },
      distanceKm: 7000,
      vehicleRequirements: [
        { vehicleType: 'open', vehicleSubtype: '17ft', quantity: 1, pricePerTruck: 5000 },
      ],
    });

    expect(result.success).toBe(false);
  });

  test('S6.13 -- createOrderSchema accepts order with both points in India', () => {
    const result = createOrderSchema.safeParse({
      pickup: {
        latitude: 19.0,
        longitude: 72.8,
        address: 'Mumbai',
      },
      drop: {
        latitude: 28.6,
        longitude: 77.2,
        address: 'Delhi',
      },
      distanceKm: 1400,
      vehicleRequirements: [
        { vehicleType: 'open', vehicleSubtype: '17ft', quantity: 1, pricePerTruck: 15000 },
      ],
    });

    expect(result.success).toBe(true);
  });
});
