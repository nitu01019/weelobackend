/**
 * =============================================================================
 * EAGLE I1 — Tests for Fixes #34/#73, #74, #75, #78
 * =============================================================================
 *
 * Tests:
 *   Fix #34/#73: Backpressure double-decrement / counter drift prevention
 *   Fix #74:     Zero-notified order should NOT stay 'active'
 *   Fix #75:     assertValidTransition calls before CAS updateMany in booking-create
 *   Fix #78:     JSON.parse corrupted cache recovery in order idempotency
 *
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
const mockRedisIncrBy = jest.fn();
const mockRedisIncr = jest.fn();
const mockRedisExpire = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: unknown[]) => mockRedisGet(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
    incrBy: (...args: unknown[]) => mockRedisIncrBy(...args),
    incr: (...args: unknown[]) => mockRedisIncr(...args),
    expire: (...args: unknown[]) => mockRedisExpire(...args),
    acquireLock: (...args: unknown[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: unknown[]) => mockRedisReleaseLock(...args),
    isDegraded: false,
  },
}));

// ---------------------------------------------------------------------------
// Prisma mock
// ---------------------------------------------------------------------------
const mockOrderUpdateMany = jest.fn();
jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    order: {
      updateMany: (...args: unknown[]) => mockOrderUpdateMany(...args),
    },
  },
  withDbTimeout: jest.fn(),
  OrderStatus: { broadcasting: 'broadcasting', active: 'active', created: 'created', expired: 'expired' },
  BookingStatus: { created: 'created', broadcasting: 'broadcasting', expired: 'expired' },
}));

jest.mock('../shared/database/db', () => ({
  db: {
    getOrderById: jest.fn(),
    getBookingById: jest.fn(),
    getUserById: jest.fn(),
    getTransportersWithVehicleType: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../modules/pricing/pricing.service', () => ({
  pricingService: { calculateEstimate: jest.fn() },
}));

jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: { calculateRoute: jest.fn() },
}));

jest.mock('../shared/utils/geo.utils', () => ({
  roundCoord: (v: number) => Math.round(v * 1e5) / 1e5,
}));

jest.mock('../modules/booking/booking.types', () => ({
  BOOKING_CONFIG: { TIMEOUT_MS: 120000 },
  RADIUS_EXPANSION_CONFIG: { steps: [{ radiusKm: 10 }], maxTransportersPerStep: 50 },
  TERMINAL_STATUSES: ['cancelled', 'expired', 'completed'],
}));

jest.mock('../modules/order/order-broadcast.service', () => ({
  broadcastToTransporters: jest.fn(),
  emitBroadcastStateChanged: jest.fn(),
}));

jest.mock('../modules/order/order-timer.service', () => ({
  setOrderExpiryTimer: jest.fn(),
}));

jest.mock('../modules/order/order-dispatch-outbox.service', () => ({
  FF_ORDER_DISPATCH_OUTBOX: false,
}));

jest.mock('../modules/order/order-idempotency.service', () => ({
  getDbIdempotentResponse: jest.fn().mockResolvedValue(null),
  persistDbIdempotentResponse: jest.fn().mockResolvedValue(undefined),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import {
  acquireOrderBackpressure,
  releaseOrderBackpressure,
  checkOrderIdempotency,
  setupOrderExpiry,
} from '../modules/order/order-creation.service';

import type { OrderCreateContext } from '../modules/order/order-create-context';
import { assertValidTransition, BOOKING_VALID_TRANSITIONS } from '../core/state-machines';

// =============================================================================
// HELPERS
// =============================================================================

function makeMinimalOrderCtx(overrides: Partial<OrderCreateContext> = {}): OrderCreateContext {
  return {
    request: {
      customerId: 'cust-1',
      customerName: 'Test',
      customerPhone: '9999999999',
      vehicleRequirements: [{ vehicleType: 'open', vehicleSubtype: '14ft', quantity: 1, pricePerTruck: 5000 }],
      distanceKm: 100,
      routePoints: [
        { type: 'PICKUP', latitude: 12.9, longitude: 77.5, address: 'A' },
        { type: 'DROP', latitude: 13.0, longitude: 77.6, address: 'B' },
      ],
    } as any,
    backpressureKey: 'order:create:inflight',
    maxConcurrentOrders: 200,
    redisBackpressureIncremented: false,
    inMemoryBackpressureIncremented: false,
    requestPayloadHash: '',
    lockKey: 'lock:test',
    lockAcquired: false,
    dedupeKey: '',
    idempotencyHash: '',
    distanceSource: 'client_fallback',
    clientDistanceKm: 100,
    totalAmount: 5000,
    totalTrucks: 1,
    routePoints: [],
    pickup: { latitude: 12.9, longitude: 77.5, address: 'A' },
    drop: { latitude: 13.0, longitude: 77.6, address: 'B' },
    orderId: 'order-test-1',
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    truckRequests: [],
    responseRequests: [],
    dispatchState: 'dispatched',
    dispatchReasonCode: undefined,
    dispatchAttempts: 1,
    onlineCandidates: 5,
    notifiedTransporters: 3,
    orderResponse: null,
    earlyReturn: null,
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Fix #34/#73: Order backpressure double-decrement / counter drift', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('acquire -> release cycle increments then decrements Redis exactly once', async () => {
    // Redis INCR succeeds, inflight = 1 (under limit)
    mockRedisIncrBy.mockResolvedValue(1);
    mockRedisExpire.mockResolvedValue(true);

    const ctx = makeMinimalOrderCtx();
    expect(ctx.redisBackpressureIncremented).toBe(false);

    await acquireOrderBackpressure(ctx);
    expect(ctx.redisBackpressureIncremented).toBe(true);
    expect(ctx.inMemoryBackpressureIncremented).toBe(false);

    // Simulate the finally block
    await releaseOrderBackpressure(ctx);
    expect(ctx.redisBackpressureIncremented).toBe(false);

    // Should have called incrBy(key, 1) once for acquire, incrBy(key, -1) once for release
    const incrCalls = mockRedisIncrBy.mock.calls;
    expect(incrCalls.length).toBe(2);
    expect(incrCalls[0][1]).toBe(1);   // acquire: +1
    expect(incrCalls[1][1]).toBe(-1);  // release: -1
  });

  it('acquire rejection -> release does NOT double-decrement Redis', async () => {
    // Redis INCR returns value OVER limit
    mockRedisIncrBy
      .mockResolvedValueOnce(999)   // acquire: over limit
      .mockResolvedValueOnce(998);  // acquire's internal rollback decrement
    mockRedisExpire.mockResolvedValue(true);

    const ctx = makeMinimalOrderCtx({ maxConcurrentOrders: 10 });

    await expect(acquireOrderBackpressure(ctx)).rejects.toThrow('System is processing too many orders');
    // Flag should be reset since we decremented during rejection
    expect(ctx.redisBackpressureIncremented).toBe(false);

    // The finally block runs releaseOrderBackpressure
    await releaseOrderBackpressure(ctx);

    // Should NOT have called another decrement from release (only the one from rejection)
    const incrCalls = mockRedisIncrBy.mock.calls;
    // Two calls: acquire +1, rejection rollback -1. No release -1.
    expect(incrCalls.length).toBe(2);
    expect(incrCalls[0][1]).toBe(1);   // acquire: +1
    expect(incrCalls[1][1]).toBe(-1);  // rejection: -1
  });

  it('release with no prior acquire does NOT decrement (counter stays at 0)', async () => {
    const ctx = makeMinimalOrderCtx();
    // Neither flag is set
    expect(ctx.redisBackpressureIncremented).toBeFalsy();
    expect(ctx.inMemoryBackpressureIncremented).toBeFalsy();

    await releaseOrderBackpressure(ctx);

    // No Redis calls at all
    expect(mockRedisIncrBy).not.toHaveBeenCalled();
  });

  it('in-memory fallback: acquire -> reject -> release leaves counter at net-zero', async () => {
    // Redis fails on INCR, triggering in-memory fallback
    mockRedisIncrBy.mockRejectedValue(new Error('Redis down'));
    mockRedisExpire.mockRejectedValue(new Error('Redis down'));

    const ctx = makeMinimalOrderCtx({ maxConcurrentOrders: 4 }); // IN_MEMORY_MAX = ceil(4/4) = 1

    // First call: in-memory goes to 1, which is AT the limit (not over), so it succeeds
    await acquireOrderBackpressure(ctx);
    expect(ctx.inMemoryBackpressureIncremented).toBe(true);
    expect(ctx.redisBackpressureIncremented).toBeFalsy();

    // Release
    await releaseOrderBackpressure(ctx);
    expect(ctx.inMemoryBackpressureIncremented).toBe(false);
  });

  it('in-memory fallback: rejection does NOT leave stale flag', async () => {
    // Redis fails on INCR, triggering in-memory fallback
    mockRedisIncrBy.mockRejectedValue(new Error('Redis down'));

    // Set maxConcurrentOrders so IN_MEMORY_MAX = 0 (always rejects)
    // Actually ceil(0/4) = 0 which would always reject. Use maxConcurrentOrders = 1, IN_MEMORY_MAX = 1
    // Need to simulate already at limit:
    const ctx = makeMinimalOrderCtx({ maxConcurrentOrders: 0 }); // IN_MEMORY_MAX = ceil(0/4) = 0

    // First call: inMemoryInflight goes to 1 which is > 0 = IN_MEMORY_MAX, so rejects
    await expect(acquireOrderBackpressure(ctx)).rejects.toThrow('System is processing too many orders');
    expect(ctx.inMemoryBackpressureIncremented).toBe(false);

    // Release should not decrement
    await releaseOrderBackpressure(ctx);
    // No Redis calls for in-memory path
  });
});

describe('Fix #74: Zero-notified order should NOT transition to active', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOrderUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('dispatched with 0 notified transporters -> dispatch_failed + expired (not active)', async () => {
    const ctx = makeMinimalOrderCtx({
      notifiedTransporters: 0,
      onlineCandidates: 0,
      dispatchState: 'dispatched',
    });

    await setupOrderExpiry(ctx, 120000);

    // dispatchState should be downgraded
    expect(ctx.dispatchState).toBe('dispatch_failed');
    expect(ctx.dispatchReasonCode).toBe('NO_ONLINE_TRANSPORTERS');

    // DB update should use 'expired', not 'active'
    expect(mockOrderUpdateMany).toHaveBeenCalledTimes(1);
    const updateCall = mockOrderUpdateMany.mock.calls[0][0];
    expect(updateCall.data.status).toBe('expired');
  });

  it('dispatched with >0 notified transporters -> active (normal path)', async () => {
    const ctx = makeMinimalOrderCtx({
      notifiedTransporters: 5,
      onlineCandidates: 10,
      dispatchState: 'dispatched',
    });

    await setupOrderExpiry(ctx, 120000);

    // Should remain dispatched
    expect(ctx.dispatchState).toBe('dispatched');

    // DB update should use 'active'
    const updateCall = mockOrderUpdateMany.mock.calls[0][0];
    expect(updateCall.data.status).toBe('active');
  });

  it('dispatch_failed with 0 notified -> stays dispatch_failed + expired', async () => {
    const ctx = makeMinimalOrderCtx({
      notifiedTransporters: 0,
      onlineCandidates: 0,
      dispatchState: 'dispatch_failed',
      dispatchReasonCode: 'NO_ONLINE_TRANSPORTERS',
    });

    await setupOrderExpiry(ctx, 120000);

    // Should remain dispatch_failed (not overwritten to dispatched first)
    expect(ctx.dispatchState).toBe('dispatch_failed');

    // DB update should use 'expired'
    const updateCall = mockOrderUpdateMany.mock.calls[0][0];
    expect(updateCall.data.status).toBe('expired');
  });

  it('orderResponse reflects dispatch_failed and expired status', async () => {
    const ctx = makeMinimalOrderCtx({
      notifiedTransporters: 0,
      onlineCandidates: 0,
      dispatchState: 'dispatched',
    });

    await setupOrderExpiry(ctx, 120000);

    expect(ctx.orderResponse).not.toBeNull();
    expect(ctx.orderResponse!.dispatchState).toBe('dispatch_failed');
    expect(ctx.orderResponse!.notifiedTransporters).toBe(0);
  });
});

describe('Fix #78: Order idempotency JSON.parse corrupted cache recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('corrupted JSON cache is deleted and falls through to normal creation', async () => {
    // Redis returns invalid JSON
    mockRedisGet.mockResolvedValue('NOT_VALID_JSON{{{');
    mockRedisDel.mockResolvedValue(1);

    const ctx = makeMinimalOrderCtx({
      request: {
        customerId: 'cust-1',
        customerName: 'Test',
        customerPhone: '9999999999',
        idempotencyKey: 'idem-key-123',
        vehicleRequirements: [{ vehicleType: 'open', vehicleSubtype: '14ft', quantity: 1, pricePerTruck: 5000 }],
        distanceKm: 100,
        routePoints: [
          { type: 'PICKUP', latitude: 12.9, longitude: 77.5, address: 'A' },
          { type: 'DROP', latitude: 13.0, longitude: 77.6, address: 'B' },
        ],
      } as any,
    });

    const result = await checkOrderIdempotency(ctx);

    // Should return null (fall through to normal creation)
    expect(result).toBeNull();
    // Should have deleted the corrupted key
    expect(mockRedisDel).toHaveBeenCalledWith(
      expect.stringContaining('idempotency:cust-1:idem-key-123')
    );
  });

  it('valid JSON cache returns cached response (normal path unchanged)', async () => {
    const cachedOrder = {
      orderId: 'order-cached',
      totalTrucks: 1,
      totalAmount: 5000,
      dispatchState: 'dispatched',
      dispatchAttempts: 1,
      onlineCandidates: 5,
      notifiedTransporters: 3,
      serverTimeMs: Date.now(),
      truckRequests: [] as any[],
      expiresAt: new Date().toISOString(),
      expiresIn: 120,
    };
    mockRedisGet.mockResolvedValue(JSON.stringify(cachedOrder));

    const ctx = makeMinimalOrderCtx({
      request: {
        customerId: 'cust-1',
        customerName: 'Test',
        customerPhone: '9999999999',
        idempotencyKey: 'idem-key-456',
        vehicleRequirements: [{ vehicleType: 'open', vehicleSubtype: '14ft', quantity: 1, pricePerTruck: 5000 }],
        distanceKm: 100,
        routePoints: [
          { type: 'PICKUP', latitude: 12.9, longitude: 77.5, address: 'A' },
          { type: 'DROP', latitude: 13.0, longitude: 77.6, address: 'B' },
        ],
      } as any,
    });

    const result = await checkOrderIdempotency(ctx);

    // Should return the cached response
    expect(result).not.toBeNull();
    expect(result!.orderId).toBe('order-cached');
    // Should NOT delete the key
    expect(mockRedisDel).not.toHaveBeenCalled();
  });

  it('no idempotency key returns null immediately', async () => {
    // Default makeMinimalOrderCtx has no idempotencyKey on request
    const ctx = makeMinimalOrderCtx();

    const result = await checkOrderIdempotency(ctx);
    expect(result).toBeNull();
    expect(mockRedisGet).not.toHaveBeenCalled();
  });

  it('[object Object] string cache is recovered gracefully', async () => {
    // This is the actual production bug pattern
    mockRedisGet.mockResolvedValue('[object Object]');
    mockRedisDel.mockResolvedValue(1);

    const ctx = makeMinimalOrderCtx({
      request: {
        customerId: 'cust-1',
        customerName: 'Test',
        customerPhone: '9999999999',
        idempotencyKey: 'idem-key-789',
        vehicleRequirements: [{ vehicleType: 'open', vehicleSubtype: '14ft', quantity: 1, pricePerTruck: 5000 }],
        distanceKm: 100,
        routePoints: [
          { type: 'PICKUP', latitude: 12.9, longitude: 77.5, address: 'A' },
          { type: 'DROP', latitude: 13.0, longitude: 77.6, address: 'B' },
        ],
      } as any,
    });

    const result = await checkOrderIdempotency(ctx);

    expect(result).toBeNull();
    expect(mockRedisDel).toHaveBeenCalled();
  });
});

describe('Fix #75: assertValidTransition for booking state machine', () => {
  it('created -> broadcasting is valid', () => {
    expect(() => assertValidTransition('Booking', BOOKING_VALID_TRANSITIONS, 'created', 'broadcasting')).not.toThrow();
  });

  it('broadcasting -> expired is valid', () => {
    expect(() => assertValidTransition('Booking', BOOKING_VALID_TRANSITIONS, 'broadcasting', 'expired')).not.toThrow();
  });

  it('created -> expired is valid', () => {
    expect(() => assertValidTransition('Booking', BOOKING_VALID_TRANSITIONS, 'created', 'expired')).not.toThrow();
  });

  it('expired -> active is INVALID (terminal state)', () => {
    expect(() => assertValidTransition('Booking', BOOKING_VALID_TRANSITIONS, 'expired', 'active')).toThrow(/Invalid Booking transition/);
  });

  it('completed -> broadcasting is INVALID (terminal state)', () => {
    expect(() => assertValidTransition('Booking', BOOKING_VALID_TRANSITIONS, 'completed', 'broadcasting')).toThrow(/Invalid Booking transition/);
  });

  it('broadcasting -> active is valid', () => {
    expect(() => assertValidTransition('Booking', BOOKING_VALID_TRANSITIONS, 'broadcasting', 'active')).not.toThrow();
  });
});
