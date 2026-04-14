/**
 * =============================================================================
 * BROADCAST OPTIMIZATION FIXES -- Tests for H1, H4, M8
 * =============================================================================
 *
 * H1: Batch suspension check (replaces N+1 Redis calls)
 *   - adminSuspensionService.getSuspendedUserIds() uses Lua script for O(1)
 *   - order-broadcast.service uses batch call instead of per-candidate loop
 *
 * H4: Failed transporter notifications are retried after 2s backoff
 *   - Promise.allSettled collects failures, retries once
 *
 * M8: Dedup TTL increased by 60s buffer (120 -> 180)
 *   - markTransportersNotified sets TTL = ceil(BROADCAST_TIMEOUT_MS / 1000) + 180
 *
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
    observeHistogram: jest.fn(),
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
const mockRedisSetTimer = jest.fn();
const mockRedisCancelTimer = jest.fn();
const mockRedisExpire = jest.fn();
const mockRedisEval = jest.fn();
const mockRedisHasTimer = jest.fn();
const mockRedisSAddWithExpire = jest.fn();
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
    setTimer: (...args: any[]) => mockRedisSetTimer(...args),
    cancelTimer: (...args: any[]) => mockRedisCancelTimer(...args),
    hasTimer: (...args: any[]) => mockRedisHasTimer(...args),
    expire: (...args: any[]) => mockRedisExpire(...args),
    eval: (...args: any[]) => mockRedisEval(...args),
    sAddWithExpire: (...args: any[]) => mockRedisSAddWithExpire(...args),
    isConnected: () => mockRedisIsConnected(),
    isRedisEnabled: () => true,
    getJSON: jest.fn(),
    setJSON: jest.fn(),
    getExpiredTimers: jest.fn().mockResolvedValue([]),
    sCard: jest.fn().mockResolvedValue(0),
    hSet: jest.fn(),
    hGet: jest.fn(),
    hGetAll: jest.fn().mockResolvedValue({}),
    hDel: jest.fn(),
    publish: jest.fn(),
    subscribe: jest.fn(),
    sRem: jest.fn(),
    ttl: jest.fn().mockResolvedValue(60),
    incrementWithTTL: jest.fn().mockResolvedValue(1),
    checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 99, resetIn: 60 }),
    getOrSet: jest.fn(),
    lPush: jest.fn(),
    lTrim: jest.fn(),
    lRange: jest.fn().mockResolvedValue([]),
  },
}));

// ---------------------------------------------------------------------------
// Database mock
// ---------------------------------------------------------------------------
const mockGetOrderById = jest.fn();
const mockGetTruckRequestsByOrder = jest.fn();
const mockGetTransportersWithVehicleType = jest.fn();
const mockGetTransportersAvailabilitySnapshot = jest.fn();
const mockUpdateTruckRequest = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getOrderById: (...args: any[]) => mockGetOrderById(...args),
    getTruckRequestsByOrder: (...args: any[]) => mockGetTruckRequestsByOrder(...args),
    getTransportersWithVehicleType: (...args: any[]) => mockGetTransportersWithVehicleType(...args),
    getTransportersAvailabilitySnapshot: (...args: any[]) => mockGetTransportersAvailabilitySnapshot(...args),
    updateTruckRequest: (...args: any[]) => mockUpdateTruckRequest(...args),
    getBookingById: jest.fn(),
    updateBooking: jest.fn(),
    getUserById: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Socket mock
// ---------------------------------------------------------------------------
const mockEmitToUser = jest.fn();
const mockEmitToUsers = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToUsers: (...args: any[]) => mockEmitToUsers(...args),
  isUserConnectedAsync: jest.fn().mockResolvedValue(false),
  SocketEvent: {
    NEW_BROADCAST: 'new_broadcast',
    BROADCAST_STATE_CHANGED: 'broadcast_state_changed',
  },
}));

// ---------------------------------------------------------------------------
// FCM mock
// ---------------------------------------------------------------------------
jest.mock('../shared/services/fcm.service', () => ({
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
  fcmService: {
    notifyNewBroadcast: jest.fn().mockResolvedValue(0),
    sendToUser: jest.fn().mockResolvedValue(true),
  },
}));

// ---------------------------------------------------------------------------
// Queue service mock
// ---------------------------------------------------------------------------
const mockQueueBroadcast = jest.fn();
const mockQueuePushNotificationBatch = jest.fn().mockResolvedValue(undefined);
const mockQueueBroadcastBatch = jest.fn().mockResolvedValue([]);

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queueBroadcast: (...args: any[]) => mockQueueBroadcast(...args),
    queuePushNotificationBatch: (...args: any[]) => mockQueuePushNotificationBatch(...args),
    queueBroadcastBatch: (...args: any[]) => mockQueueBroadcastBatch(...args),
  },
}));

// ---------------------------------------------------------------------------
// Cache service mock
// ---------------------------------------------------------------------------
jest.mock('../shared/services/cache.service', () => ({
  cacheService: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    scanIterator: jest.fn().mockReturnValue({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }) }),
  },
}));

// ---------------------------------------------------------------------------
// Transporter online service mock
// ---------------------------------------------------------------------------
const mockFilterOnline = jest.fn();

jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: {
    filterOnline: (...args: any[]) => mockFilterOnline(...args),
    isOnline: jest.fn().mockResolvedValue(true),
  },
}));

// ---------------------------------------------------------------------------
// Vehicle key service mock
// ---------------------------------------------------------------------------
jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn().mockReturnValue('Tipper_20-24 Ton'),
}));

// ---------------------------------------------------------------------------
// Progressive radius matcher mock
// ---------------------------------------------------------------------------
const mockFindCandidates = jest.fn().mockResolvedValue([]);

jest.mock('../modules/order/progressive-radius-matcher', () => ({
  PROGRESSIVE_RADIUS_STEPS: [
    { radiusKm: 10, windowMs: 10_000, h3RingK: 15 },
    { radiusKm: 25, windowMs: 15_000, h3RingK: 30 },
    { radiusKm: 50, windowMs: 20_000, h3RingK: 50 },
  ],
  progressiveRadiusMatcher: {
    findCandidates: (...args: any[]) => mockFindCandidates(...args),
    getStepCount: jest.fn().mockReturnValue(3),
    getStep: jest.fn().mockReturnValue({ radiusKm: 10, windowMs: 10_000, h3RingK: 15 }),
  },
}));

// ---------------------------------------------------------------------------
// Candidate scorer mock
// ---------------------------------------------------------------------------
const mockScoreAndRank = jest.fn();

jest.mock('../shared/services/candidate-scorer.service', () => ({
  candidateScorerService: {
    scoreAndRank: (...args: any[]) => mockScoreAndRank(...args),
  },
}));

// ---------------------------------------------------------------------------
// Routing service mock
// ---------------------------------------------------------------------------
jest.mock('../modules/routing', () => ({
  routingService: {
    calculateRoute: jest.fn().mockResolvedValue({ distanceKm: 100, durationMinutes: 120 }),
    calculateRouteBreakdown: jest.fn().mockReturnValue({
      legs: [],
      totalDistanceKm: 100,
      totalDurationMinutes: 120,
      totalDurationFormatted: '2 hrs 0 mins',
      totalStops: 0,
      estimatedArrival: new Date().toISOString(),
    }),
  },
}));

// ---------------------------------------------------------------------------
// PII utils mock
// ---------------------------------------------------------------------------
jest.mock('../shared/utils/pii.utils', () => ({
  maskPhoneForExternal: jest.fn((phone: string) => phone ? `***${phone.slice(-4)}` : '***'),
}));

// ---------------------------------------------------------------------------
// Prisma mock (needed for transitive imports)
// ---------------------------------------------------------------------------
jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    $transaction: jest.fn((fn: any) => typeof fn === 'function' ? fn({}) : Promise.resolve(fn)),
    booking: { findMany: jest.fn().mockResolvedValue([]) },
    assignment: { findMany: jest.fn().mockResolvedValue([]) },
    vehicle: { findMany: jest.fn().mockResolvedValue([]) },
  },
}));

// =============================================================================
// IMPORTS (after all mocks)
// =============================================================================

import { adminSuspensionService } from '../modules/admin/admin-suspension.service';
import {
  broadcastVehicleTypePayload,
  markTransportersNotified,
  broadcastToTransporters,
} from '../modules/order/order-broadcast.service';
import { logger } from '../shared/services/logger.service';

// =============================================================================
// HELPERS
// =============================================================================

function makeTruckRequest(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id || `tr-${Math.random().toString(36).slice(2, 8)}`,
    orderId: overrides.orderId || 'order-1',
    vehicleType: overrides.vehicleType || 'Tipper',
    vehicleSubtype: overrides.vehicleSubtype || '20-24 Ton',
    status: overrides.status || 'searching',
    requestNumber: overrides.requestNumber || 1,
    pricePerTruck: overrides.pricePerTruck || 5000,
    notifiedTransporters: overrides.notifiedTransporters || [],
    createdAt: overrides.createdAt || new Date(),
    updatedAt: overrides.updatedAt || new Date(),
    ...overrides,
  };
}

function makeOrder(overrides: Record<string, any> = {}) {
  const now = new Date();
  return {
    id: overrides.id || 'order-1',
    customerId: overrides.customerId || 'cust-1',
    customerName: overrides.customerName || 'Test Customer',
    customerPhone: overrides.customerPhone || '9876543210',
    status: overrides.status || 'broadcasting',
    pickup: overrides.pickup || { latitude: 19.076, longitude: 72.877, address: 'Mumbai', city: 'Mumbai' },
    drop: overrides.drop || { latitude: 18.52, longitude: 73.856, address: 'Pune', city: 'Pune' },
    routePoints: overrides.routePoints || [
      { type: 'PICKUP', latitude: 19.076, longitude: 72.877, address: 'Mumbai', city: 'Mumbai', stopIndex: 0 },
      { type: 'DROP', latitude: 18.52, longitude: 73.856, address: 'Pune', city: 'Pune', stopIndex: 1 },
    ],
    distanceKm: overrides.distanceKm || 150,
    goodsType: overrides.goodsType || 'construction',
    cargoWeightKg: overrides.cargoWeightKg || 20000,
    expiresAt: overrides.expiresAt || new Date(now.getTime() + 120000).toISOString(),
    createdAt: overrides.createdAt || now.toISOString(),
    ...overrides,
  };
}

// =============================================================================
// H1: BATCH SUSPENSION CHECK (replaces N+1 Redis calls)
// =============================================================================

describe('H1: Batch suspension check via getSuspendedUserIds', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns correct Set for mix of suspended and non-suspended users', async () => {
    // user-1 and user-3 are suspended (EXISTS returns 1); user-2 is not (EXISTS returns 0)
    mockRedisEval.mockResolvedValueOnce([1, 0, 1]);

    const result = await adminSuspensionService.getSuspendedUserIds([
      'user-1', 'user-2', 'user-3',
    ]);

    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(2);
    expect(result.has('user-1')).toBe(true);
    expect(result.has('user-2')).toBe(false);
    expect(result.has('user-3')).toBe(true);
  });

  test('empty userIds array returns empty Set without Redis call', async () => {
    const result = await adminSuspensionService.getSuspendedUserIds([]);

    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
    expect(mockRedisEval).not.toHaveBeenCalled();
  });

  test('single suspended user returns Set with that user', async () => {
    mockRedisEval.mockResolvedValueOnce([1]);

    const result = await adminSuspensionService.getSuspendedUserIds(['user-only']);

    expect(result.size).toBe(1);
    expect(result.has('user-only')).toBe(true);
  });

  test('single non-suspended user returns empty Set', async () => {
    mockRedisEval.mockResolvedValueOnce([0]);

    const result = await adminSuspensionService.getSuspendedUserIds(['user-clean']);

    expect(result.size).toBe(0);
    expect(result.has('user-clean')).toBe(false);
  });

  test('deduplicates userIds before calling Redis', async () => {
    mockRedisEval.mockResolvedValueOnce([1, 0]);

    const result = await adminSuspensionService.getSuspendedUserIds([
      'user-a', 'user-b', 'user-a', 'user-b', 'user-a',
    ]);

    // Should only send 2 unique keys to Redis, not 5
    expect(mockRedisEval).toHaveBeenCalledTimes(1);
    const [, keys] = mockRedisEval.mock.calls[0];
    expect(keys).toHaveLength(2);
    expect(keys).toEqual([
      'suspension:user-a',
      'suspension:user-b',
    ]);
    expect(result.size).toBe(1);
    expect(result.has('user-a')).toBe(true);
  });

  test('Lua script passes correct keys (suspension:{userId} format)', async () => {
    mockRedisEval.mockResolvedValueOnce([0, 0, 0]);

    await adminSuspensionService.getSuspendedUserIds(['t-1', 't-2', 't-3']);

    expect(mockRedisEval).toHaveBeenCalledTimes(1);
    const [script, keys, args] = mockRedisEval.mock.calls[0];
    expect(keys).toEqual(['suspension:t-1', 'suspension:t-2', 'suspension:t-3']);
    expect(args).toEqual([]);
    expect(script).toContain('EXISTS');
    expect(script).toContain('KEYS');
  });

  test('Redis eval failure falls back to individual isUserSuspended checks (fail-open)', async () => {
    // First call (eval) fails
    mockRedisEval.mockRejectedValueOnce(new Error('CROSSSLOT keys in different hash slots'));
    // Individual fallback calls: user-1 is suspended, user-2 is not
    mockRedisExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await adminSuspensionService.getSuspendedUserIds(['user-1', 'user-2']);

    expect(result.size).toBe(1);
    expect(result.has('user-1')).toBe(true);
    expect(result.has('user-2')).toBe(false);
    // Verify fallback logged a warning
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Batch suspension check failed'),
      expect.objectContaining({ userCount: 2 })
    );
  });

  test('Redis eval failure + individual fallback also fails -> returns empty Set (fail-open)', async () => {
    // eval fails
    mockRedisEval.mockRejectedValueOnce(new Error('Redis connection lost'));
    // Individual checks also fail but isUserSuspended catches and returns false
    mockRedisExists.mockRejectedValueOnce(new Error('timeout'));

    const result = await adminSuspensionService.getSuspendedUserIds(['user-1']);

    // Fail-open: isUserSuspended catches the error and returns false
    expect(result.size).toBe(0);
  });

  test('all users suspended returns full Set', async () => {
    mockRedisEval.mockResolvedValueOnce([1, 1, 1, 1]);

    const result = await adminSuspensionService.getSuspendedUserIds([
      'u1', 'u2', 'u3', 'u4',
    ]);

    expect(result.size).toBe(4);
    expect(result.has('u1')).toBe(true);
    expect(result.has('u2')).toBe(true);
    expect(result.has('u3')).toBe(true);
    expect(result.has('u4')).toBe(true);
  });

  test('no users suspended returns empty Set', async () => {
    mockRedisEval.mockResolvedValueOnce([0, 0, 0]);

    const result = await adminSuspensionService.getSuspendedUserIds(['a', 'b', 'c']);

    expect(result.size).toBe(0);
  });

  test('batch is O(1) Redis round-trip (single eval call for N users)', async () => {
    const manyUsers = Array.from({ length: 50 }, (_, i) => `user-${i}`);
    mockRedisEval.mockResolvedValueOnce(manyUsers.map(() => 0));

    await adminSuspensionService.getSuspendedUserIds(manyUsers);

    // Exactly 1 Redis call regardless of user count
    expect(mockRedisEval).toHaveBeenCalledTimes(1);
    // All 50 keys in a single call
    const [, keys] = mockRedisEval.mock.calls[0];
    expect(keys).toHaveLength(50);
  });
});

// =============================================================================
// H1 (continued): Broadcast filtering correctly excludes suspended transporters
// =============================================================================

describe('H1: Broadcast filtering excludes suspended transporters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset timers
    jest.useRealTimers();
  });

  test('suspended transporters are excluded from broadcast candidate list', async () => {
    const orderId = 'order-broadcast-h1';
    const truckRequests = [makeTruckRequest({ orderId, id: 'tr-1' })];
    const order = makeOrder({ id: orderId });

    // Setup: 3 candidates found, but user-2 is suspended
    mockFindCandidates.mockResolvedValueOnce([
      { transporterId: 'user-1', distanceKm: 5, etaSeconds: 300 },
      { transporterId: 'user-2', distanceKm: 8, etaSeconds: 500 },
      { transporterId: 'user-3', distanceKm: 12, etaSeconds: 700 },
    ]);
    mockScoreAndRank.mockResolvedValueOnce([
      { transporterId: 'user-1', distanceKm: 5, etaSeconds: 300 },
      { transporterId: 'user-2', distanceKm: 8, etaSeconds: 500 },
      { transporterId: 'user-3', distanceKm: 12, etaSeconds: 700 },
    ]);
    // H1 batch check: user-2 is suspended
    mockRedisEval.mockResolvedValueOnce([0, 1, 0]);

    mockRedisSMembers.mockResolvedValueOnce([]); // no previously notified
    mockRedisHasTimer.mockResolvedValueOnce(false);
    mockRedisSetTimer.mockResolvedValueOnce(undefined);
    mockRedisSAddWithExpire.mockResolvedValueOnce(undefined);

    // Availability: all have trucks
    mockGetTransportersAvailabilitySnapshot.mockResolvedValueOnce([
      { transporterId: 'user-1', transporterName: 'T1', totalOwned: 5, available: 3, inTransit: 2 },
      { transporterId: 'user-3', transporterName: 'T3', totalOwned: 4, available: 2, inTransit: 2 },
    ]);
    mockGetOrderById.mockResolvedValueOnce(order);
    mockQueueBroadcast.mockResolvedValue(undefined);
    mockUpdateTruckRequest.mockResolvedValue(undefined);

    const result = await broadcastToTransporters(
      orderId,
      {
        customerId: 'cust-1',
        customerName: 'Test',
        customerPhone: '9876543210',
        routePoints: order.routePoints,
        pickup: order.pickup,
        drop: order.drop,
        distanceKm: 150,
        vehicleRequirements: [],
        goodsType: 'construction',
        cargoWeightKg: 20000,
      },
      truckRequests,
      order.expiresAt,
      { latitude: 19.076, longitude: 72.877, address: 'Mumbai' }
    );

    // user-2 should have been filtered out -- only user-1 and user-3 should be candidates
    expect(result.onlineCandidates).toBe(2);
    // Verify batch suspension check was called with all 3 transporter IDs
    expect(mockRedisEval).toHaveBeenCalledTimes(1);
    const [, keys] = mockRedisEval.mock.calls[0];
    expect(keys).toContain('suspension:user-1');
    expect(keys).toContain('suspension:user-2');
    expect(keys).toContain('suspension:user-3');

    // Log should indicate suspended transporter was filtered
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Filtered suspended transporters'),
      expect.objectContaining({ suspendedCount: 1, remainingCount: 2 })
    );
  });
});

// =============================================================================
// H4: FAILED TRANSPORTER NOTIFICATIONS ARE RETRIED
// =============================================================================

describe('H4: Failed transporter notifications are retried', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('successful notifications are NOT retried', async () => {
    const orderId = 'order-h4-success';
    const order = makeOrder({ id: orderId });
    const truckRequests = [makeTruckRequest({ orderId, id: 'tr-h4' })];
    const requestsByType = new Map([[JSON.stringify(['Tipper', '20-24 Ton']), truckRequests]]);

    // ALL enqueues succeed
    mockQueueBroadcast.mockResolvedValue(undefined);
    mockGetOrderById.mockResolvedValueOnce(order);
    mockGetTransportersAvailabilitySnapshot.mockResolvedValueOnce([
      { transporterId: 'trans-ok-1', transporterName: 'T1', totalOwned: 5, available: 3, inTransit: 2 },
      { transporterId: 'trans-ok-2', transporterName: 'T2', totalOwned: 4, available: 2, inTransit: 2 },
    ]);
    mockUpdateTruckRequest.mockResolvedValue(undefined);
    mockRedisSAddWithExpire.mockResolvedValue(undefined);

    // Use real timers for this test since we need Promise.allSettled to resolve
    jest.useRealTimers();

    const result = await broadcastVehicleTypePayload(
      orderId,
      {
        customerId: 'cust-1',
        customerName: 'Test',
        customerPhone: '9876543210',
        routePoints: order.routePoints,
        pickup: order.pickup,
        drop: order.drop,
        distanceKm: 150,
        vehicleRequirements: [],
        goodsType: 'construction',
        cargoWeightKg: 20000,
      },
      truckRequests,
      requestsByType,
      truckRequests,
      'Tipper',
      '20-24 Ton',
      ['trans-ok-1', 'trans-ok-2'],
      order.expiresAt,
      new Map([
        ['trans-ok-1', { distanceKm: 5, etaSeconds: 300 }],
        ['trans-ok-2', { distanceKm: 8, etaSeconds: 500 }],
      ])
    );

    // No retry warning should be logged -- all succeeded
    const retryCalls = (logger.warn as jest.Mock).mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('Retrying failed transporter')
    );
    expect(retryCalls).toHaveLength(0);

    // Both transporters should be in the sent list
    expect(result.sentTransporters).toContain('trans-ok-1');
    expect(result.sentTransporters).toContain('trans-ok-2');
  });

  test('failed notifications trigger retry (logged, not thrown)', async () => {
    const orderId = 'order-h4-retry';
    const order = makeOrder({ id: orderId });
    const truckRequests = [makeTruckRequest({ orderId, id: 'tr-h4-retry' })];
    const requestsByType = new Map([[JSON.stringify(['Tipper', '20-24 Ton']), truckRequests]]);

    // First call fails for trans-fail, succeeds for trans-ok
    mockQueueBroadcast
      .mockRejectedValueOnce(new Error('Redis connection timeout'))  // trans-fail
      .mockResolvedValueOnce(undefined)                               // trans-ok
      .mockResolvedValueOnce(undefined);                              // retry for trans-fail

    mockGetOrderById.mockResolvedValueOnce(order);
    mockGetTransportersAvailabilitySnapshot.mockResolvedValueOnce([
      { transporterId: 'trans-fail', transporterName: 'TFail', totalOwned: 5, available: 3, inTransit: 2 },
      { transporterId: 'trans-ok', transporterName: 'TOK', totalOwned: 4, available: 2, inTransit: 2 },
    ]);
    mockUpdateTruckRequest.mockResolvedValue(undefined);
    mockRedisSAddWithExpire.mockResolvedValue(undefined);

    jest.useRealTimers();

    const result = await broadcastVehicleTypePayload(
      orderId,
      {
        customerId: 'cust-1',
        customerName: 'Test',
        customerPhone: '9876543210',
        routePoints: order.routePoints,
        pickup: order.pickup,
        drop: order.drop,
        distanceKm: 150,
        vehicleRequirements: [],
        goodsType: 'construction',
        cargoWeightKg: 20000,
      },
      truckRequests,
      requestsByType,
      truckRequests,
      'Tipper',
      '20-24 Ton',
      ['trans-fail', 'trans-ok'],
      order.expiresAt,
      new Map([
        ['trans-fail', { distanceKm: 5, etaSeconds: 300 }],
        ['trans-ok', { distanceKm: 8, etaSeconds: 500 }],
      ])
    );

    // Retry warning should have been logged
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Retrying failed transporter'),
      expect.objectContaining({
        orderId,
        count: 1,
        transporterIds: ['trans-fail'],
      })
    );

    // After retry, trans-fail should be in the accepted list too
    expect(result.sentTransporters).toContain('trans-fail');
    expect(result.sentTransporters).toContain('trans-ok');
  });

  test('retry failure is logged, not thrown (does not crash broadcast)', async () => {
    const orderId = 'order-h4-retry-fail';
    const order = makeOrder({ id: orderId });
    const truckRequests = [makeTruckRequest({ orderId, id: 'tr-h4-rf' })];
    const requestsByType = new Map([[JSON.stringify(['Tipper', '20-24 Ton']), truckRequests]]);

    // First call fails, retry also fails
    mockQueueBroadcast
      .mockRejectedValueOnce(new Error('Redis down'))
      .mockRejectedValueOnce(new Error('Redis still down'));

    mockGetOrderById.mockResolvedValueOnce(order);
    mockGetTransportersAvailabilitySnapshot.mockResolvedValueOnce([
      { transporterId: 'trans-doomed', transporterName: 'TDoomed', totalOwned: 5, available: 3, inTransit: 2 },
    ]);
    mockUpdateTruckRequest.mockResolvedValue(undefined);
    mockRedisSAddWithExpire.mockResolvedValue(undefined);

    jest.useRealTimers();

    // Should NOT throw even when retry fails
    const result = await broadcastVehicleTypePayload(
      orderId,
      {
        customerId: 'cust-1',
        customerName: 'Test',
        customerPhone: '9876543210',
        routePoints: order.routePoints,
        pickup: order.pickup,
        drop: order.drop,
        distanceKm: 150,
        vehicleRequirements: [],
        goodsType: 'construction',
        cargoWeightKg: 20000,
      },
      truckRequests,
      requestsByType,
      truckRequests,
      'Tipper',
      '20-24 Ton',
      ['trans-doomed'],
      order.expiresAt,
      new Map([
        ['trans-doomed', { distanceKm: 5, etaSeconds: 300 }],
      ])
    );

    // Retry log should exist
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Permanent delivery failures after retry'),
      expect.objectContaining({ retryFailCount: 1 })
    );

    // trans-doomed should NOT be in the sent list (both attempts failed)
    expect(result.sentTransporters).not.toContain('trans-doomed');
  });

  test('mix of success + failure: only failures are retried', async () => {
    const orderId = 'order-h4-mix';
    const order = makeOrder({ id: orderId });
    const truckRequests = [makeTruckRequest({ orderId, id: 'tr-h4-mix' })];
    const requestsByType = new Map([[JSON.stringify(['Tipper', '20-24 Ton']), truckRequests]]);

    // 3 transporters: 2 succeed, 1 fails on first attempt but succeeds on retry
    const transBCallCount: Record<string, number> = {};
    mockQueueBroadcast.mockImplementation(async (transporterId: string) => {
      transBCallCount[transporterId] = (transBCallCount[transporterId] || 0) + 1;
      if (transporterId === 'trans-b' && transBCallCount[transporterId] === 1) {
        throw new Error('Queue full');
      }
      return undefined;
    });

    mockGetOrderById.mockResolvedValueOnce(order);
    mockGetTransportersAvailabilitySnapshot.mockResolvedValueOnce([
      { transporterId: 'trans-a', transporterName: 'TA', totalOwned: 5, available: 3, inTransit: 2 },
      { transporterId: 'trans-b', transporterName: 'TB', totalOwned: 4, available: 2, inTransit: 2 },
      { transporterId: 'trans-c', transporterName: 'TC', totalOwned: 3, available: 1, inTransit: 2 },
    ]);
    mockUpdateTruckRequest.mockResolvedValue(undefined);
    mockRedisSAddWithExpire.mockResolvedValue(undefined);

    jest.useRealTimers();

    const result = await broadcastVehicleTypePayload(
      orderId,
      {
        customerId: 'cust-1',
        customerName: 'Test',
        customerPhone: '9876543210',
        routePoints: order.routePoints,
        pickup: order.pickup,
        drop: order.drop,
        distanceKm: 150,
        vehicleRequirements: [],
        goodsType: 'construction',
        cargoWeightKg: 20000,
      },
      truckRequests,
      requestsByType,
      truckRequests,
      'Tipper',
      '20-24 Ton',
      ['trans-a', 'trans-b', 'trans-c'],
      order.expiresAt,
      new Map([
        ['trans-a', { distanceKm: 5, etaSeconds: 300 }],
        ['trans-b', { distanceKm: 8, etaSeconds: 500 }],
        ['trans-c', { distanceKm: 12, etaSeconds: 700 }],
      ])
    );

    // Retry should only target trans-b
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Retrying failed transporter'),
      expect.objectContaining({
        count: 1,
        transporterIds: ['trans-b'],
      })
    );

    // All three should end up in sent list (trans-b succeeds on retry)
    expect(result.sentTransporters).toContain('trans-a');
    expect(result.sentTransporters).toContain('trans-b');
    expect(result.sentTransporters).toContain('trans-c');
  });

  test('retry payload includes _retry flag', async () => {
    const orderId = 'order-h4-flag';
    const order = makeOrder({ id: orderId });
    const truckRequests = [makeTruckRequest({ orderId, id: 'tr-h4-flag' })];
    const requestsByType = new Map([[JSON.stringify(['Tipper', '20-24 Ton']), truckRequests]]);

    // First call fails, retry succeeds
    mockQueueBroadcast
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(undefined);

    mockGetOrderById.mockResolvedValueOnce(order);
    mockGetTransportersAvailabilitySnapshot.mockResolvedValueOnce([
      { transporterId: 'trans-flag', transporterName: 'TFlag', totalOwned: 5, available: 3, inTransit: 2 },
    ]);
    mockUpdateTruckRequest.mockResolvedValue(undefined);
    mockRedisSAddWithExpire.mockResolvedValue(undefined);

    jest.useRealTimers();

    await broadcastVehicleTypePayload(
      orderId,
      {
        customerId: 'cust-1',
        customerName: 'Test',
        customerPhone: '9876543210',
        routePoints: order.routePoints,
        pickup: order.pickup,
        drop: order.drop,
        distanceKm: 150,
        vehicleRequirements: [],
        goodsType: 'construction',
        cargoWeightKg: 20000,
      },
      truckRequests,
      requestsByType,
      truckRequests,
      'Tipper',
      '20-24 Ton',
      ['trans-flag'],
      order.expiresAt,
      new Map([
        ['trans-flag', { distanceKm: 5, etaSeconds: 300 }],
      ])
    );

    // The retry call should have _retry: true in the payload
    const retryCalls = mockQueueBroadcast.mock.calls.filter(
      (call: any[]) => call[2]?._retry === true
    );
    expect(retryCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// M8: DEDUP TTL INCREASED BY 60s BUFFER (120 -> 180)
// =============================================================================

describe('M8: Dedup TTL increased by 60s buffer', () => {
  beforeEach(() => jest.clearAllMocks());

  test('TTL is Math.ceil(BROADCAST_TIMEOUT_MS / 1000) + 180', async () => {
    // Default BROADCAST_TIMEOUT_SECONDS = 120 -> BROADCAST_TIMEOUT_MS = 120000
    // Expected TTL = Math.ceil(120000 / 1000) + 180 = 120 + 180 = 300
    mockRedisSAddWithExpire.mockResolvedValueOnce(undefined);

    await markTransportersNotified('order-m8', 'Tipper', '20-24 Ton', ['t1', 't2']);

    expect(mockRedisSAddWithExpire).toHaveBeenCalledTimes(1);
    const [, ttl] = mockRedisSAddWithExpire.mock.calls[0];
    expect(ttl).toBe(300);
  });

  test('TTL uses +180 buffer (not old +120)', async () => {
    mockRedisSAddWithExpire.mockResolvedValueOnce(undefined);

    await markTransportersNotified('order-m8-check', 'Tipper', '20-24 Ton', ['t1']);

    const [, ttl] = mockRedisSAddWithExpire.mock.calls[0];
    // Must NOT be 240 (old formula: 120 + 120)
    expect(ttl).not.toBe(240);
    // Must be 300 (new formula: 120 + 180)
    expect(ttl).toBe(300);
  });

  test('TTL exceeds maximum cumulative retry delay (~248s)', async () => {
    // The maximum cumulative retry delay with progressive steps is approximately
    // 248 seconds. The TTL must exceed this to prevent premature dedup key expiry.
    // With default config: TTL = 300 > 248
    mockRedisSAddWithExpire.mockResolvedValueOnce(undefined);

    await markTransportersNotified('order-m8-exceed', 'Tipper', '20-24 Ton', ['t1']);

    const [, ttl] = mockRedisSAddWithExpire.mock.calls[0];
    const MAX_CUMULATIVE_RETRY_DELAY_SECONDS = 248;
    expect(ttl).toBeGreaterThan(MAX_CUMULATIVE_RETRY_DELAY_SECONDS);
  });

  test('empty transporterIds array does not call Redis', async () => {
    await markTransportersNotified('order-m8-empty', 'Tipper', '20-24 Ton', []);

    expect(mockRedisSAddWithExpire).not.toHaveBeenCalled();
  });

  test('TTL is passed as second argument to sAddWithExpire', async () => {
    mockRedisSAddWithExpire.mockResolvedValueOnce(undefined);

    await markTransportersNotified('order-m8-args', 'Tipper', '20-24 Ton', ['t1', 't2', 't3']);

    expect(mockRedisSAddWithExpire).toHaveBeenCalledTimes(1);
    const callArgs = mockRedisSAddWithExpire.mock.calls[0];
    // [key, ttl, ...memberIds]
    expect(typeof callArgs[0]).toBe('string'); // key
    expect(callArgs[1]).toBe(300);             // TTL
    expect(callArgs[2]).toBe('t1');            // first member
    expect(callArgs[3]).toBe('t2');            // second member
    expect(callArgs[4]).toBe('t3');            // third member
  });

  test('sAddWithExpire failure is swallowed (does not throw)', async () => {
    mockRedisSAddWithExpire.mockRejectedValueOnce(new Error('Redis down'));

    // Should not throw
    await expect(
      markTransportersNotified('order-m8-fail', 'Tipper', '20-24 Ton', ['t1'])
    ).resolves.toBeUndefined();
  });
});
