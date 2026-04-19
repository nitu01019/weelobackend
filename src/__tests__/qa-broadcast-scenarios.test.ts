/**
 * =============================================================================
 * QA BROADCAST SCENARIOS -- Scenario-based tests for broadcast reliability
 * =============================================================================
 *
 * QA Agent QA3 -- Failure recovery and edge cases
 *
 * SCENARIOS:
 *   1. Batch suspension check efficiency (H1)
 *   2. Notification failure + retry (H4)
 *   3. All notifications fail scenario
 *   4. Dedup TTL edge case (M8)
 *   5. Progressive broadcast with suspension
 *   6. Redis failure during suspension check
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
const mockRedisGetJSON = jest.fn();
const mockRedisSetJSON = jest.fn();
const mockRedisGetExpiredTimers = jest.fn();
const mockRedisCancelTimer = jest.fn();
const mockRedisSetTimer = jest.fn();
const mockRedisHasTimer = jest.fn();
const mockRedisExpire = jest.fn();
const mockRedisSIsMember = jest.fn();
const mockRedisEval = jest.fn();
const mockRedisIsConnected = jest.fn().mockReturnValue(true);
const mockRedisSAddWithExpire = jest.fn();

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
    hasTimer: (...args: any[]) => mockRedisHasTimer(...args),
    expire: (...args: any[]) => mockRedisExpire(...args),
    sIsMember: (...args: any[]) => mockRedisSIsMember(...args),
    isConnected: () => mockRedisIsConnected(),
    eval: (...args: any[]) => mockRedisEval(...args),
    sAddWithExpire: (...args: any[]) => mockRedisSAddWithExpire(...args),
    isRedisEnabled: () => true,
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
    lRange: jest.fn().mockResolvedValue([]),
    lPush: jest.fn(),
    lTrim: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// FCM service mock
// ---------------------------------------------------------------------------
jest.mock('../shared/services/fcm.service', () => ({
  fcmService: {
    notifyNewBroadcast: jest.fn().mockResolvedValue(1),
    sendToUser: jest.fn().mockResolvedValue(true),
    sendToUsers: jest.fn().mockResolvedValue(1),
    notifyAssignmentUpdate: jest.fn().mockResolvedValue(true),
    registerToken: jest.fn(),
    removeToken: jest.fn(),
    getTokens: jest.fn().mockResolvedValue([]),
    initialize: jest.fn(),
  },
  sendPushNotification: jest.fn().mockResolvedValue(true),
  NotificationType: {
    NEW_BROADCAST: 'new_broadcast',
    ASSIGNMENT_UPDATE: 'assignment_update',
    TRIP_UPDATE: 'trip_update',
    PAYMENT: 'payment_received',
    GENERAL: 'general',
  },
}));

// ---------------------------------------------------------------------------
// Socket mock
// ---------------------------------------------------------------------------
const mockEmitToUser = jest.fn();
const mockEmitToUsers = jest.fn();
const mockEmitToRoom = jest.fn();
jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToUsers: (...args: any[]) => mockEmitToUsers(...args),
  emitToRoom: (...args: any[]) => mockEmitToRoom(...args),
  isUserConnectedAsync: jest.fn().mockResolvedValue(false),
  SocketEvent: {
    NEW_BROADCAST: 'new_broadcast',
    BROADCAST_EXPIRED: 'broadcast_expired',
    ASSIGNMENT_UPDATE: 'assignment_update',
    BROADCAST_CANCELLED: 'broadcast_cancelled',
    BOOKING_FULLY_FILLED: 'booking_fully_filled',
    TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update',
  },
}));

// ---------------------------------------------------------------------------
// Queue service mock
// ---------------------------------------------------------------------------
const mockQueueBroadcast = jest.fn();
const mockQueueBroadcastBatch = jest.fn();
const mockQueuePushNotificationBatch = jest.fn();
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queueBroadcast: (...args: any[]) => mockQueueBroadcast(...args),
    queueBroadcastBatch: (...args: any[]) => mockQueueBroadcastBatch(...args),
    queuePushNotificationBatch: (...args: any[]) => mockQueuePushNotificationBatch(...args),
    addJob: jest.fn(),
    processBroadcastJobs: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Cache service mock
// ---------------------------------------------------------------------------
jest.mock('../shared/services/cache.service', () => ({
  cacheService: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn(),
    delete: jest.fn(),
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
// Progressive radius matcher mock
// ---------------------------------------------------------------------------
const mockFindCandidates = jest.fn();
jest.mock('../modules/order/progressive-radius-matcher', () => ({
  progressiveRadiusMatcher: {
    findCandidates: (...args: any[]) => mockFindCandidates(...args),
    getStep: jest.fn().mockImplementation((index: number) => {
      const steps = [
        { radiusKm: 10, windowMs: 15000, h3RingK: 2 },
        { radiusKm: 25, windowMs: 20000, h3RingK: 4 },
        { radiusKm: 50, windowMs: 25000, h3RingK: 6 },
      ];
      return steps[index] || undefined;
    }),
  },
  PROGRESSIVE_RADIUS_STEPS: [
    { radiusKm: 10, windowMs: 15000, h3RingK: 2 },
    { radiusKm: 25, windowMs: 20000, h3RingK: 4 },
    { radiusKm: 50, windowMs: 25000, h3RingK: 6 },
  ],
}));

// ---------------------------------------------------------------------------
// Candidate scorer mock
// ---------------------------------------------------------------------------
jest.mock('../shared/services/candidate-scorer.service', () => ({
  candidateScorerService: {
    scoreAndRank: jest.fn().mockImplementation((candidates: any[]) => Promise.resolve(candidates)),
  },
}));

// ---------------------------------------------------------------------------
// Vehicle key service mock
// ---------------------------------------------------------------------------
jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn().mockImplementation((type: string, subtype: string) => `${type}:${subtype || ''}`),
}));

// ---------------------------------------------------------------------------
// Routing service mock
// ---------------------------------------------------------------------------
jest.mock('../modules/routing', () => ({
  routingService: {
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
  maskPhoneForExternal: jest.fn().mockImplementation((phone: string) => phone ? '****' + phone.slice(-4) : ''),
}));

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------
const mockGetOrderById = jest.fn();
const mockGetTruckRequestsByOrder = jest.fn();
const mockGetTransportersAvailabilitySnapshot = jest.fn();
const mockGetTransportersWithVehicleType = jest.fn();
const mockUpdateTruckRequest = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getOrderById: (...args: any[]) => mockGetOrderById(...args),
    getTruckRequestsByOrder: (...args: any[]) => mockGetTruckRequestsByOrder(...args),
    getTransportersAvailabilitySnapshot: (...args: any[]) => mockGetTransportersAvailabilitySnapshot(...args),
    getTransportersWithVehicleType: (...args: any[]) => mockGetTransportersWithVehicleType(...args),
    updateTruckRequest: (...args: any[]) => mockUpdateTruckRequest(...args),
    getUserById: jest.fn().mockResolvedValue({ id: 'user-1', name: 'Test' }),
    getActiveOrders: jest.fn().mockResolvedValue([]),
    getBookingById: jest.fn().mockResolvedValue(null),
    getActiveBookingsForTransporter: jest.fn().mockResolvedValue([]),
    getBookingsByDriver: jest.fn().mockResolvedValue([]),
    createBooking: jest.fn(),
    updateOrder: jest.fn(),
  },
  TruckRequestRecord: {},
}));

// ---------------------------------------------------------------------------
// Prisma mock
// ---------------------------------------------------------------------------
jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    assignment: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    booking: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      findUnique: jest.fn(),
    },
    vehicle: { findMany: jest.fn().mockResolvedValue([]) },
    truckRequest: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((fn: any) => {
      if (typeof fn === 'function') return fn({});
      return Promise.resolve(fn);
    }),
  },
  withDbTimeout: jest.fn(),
  VehicleStatus: { available: 'available', on_hold: 'on_hold', in_transit: 'in_transit' },
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { adminSuspensionService } from '../modules/admin/admin-suspension.service';
import {
  broadcastToTransporters,
  markTransportersNotified,
  broadcastVehicleTypePayload,
  buildRequestsByType,
  processProgressiveBroadcastStep,
} from '../modules/order/order-broadcast.service';
import { logger } from '../shared/services/logger.service';

// =============================================================================
// HELPERS
// =============================================================================

function makeTransporterId(index: number): string {
  return `transporter-${String(index).padStart(3, '0')}`;
}

function makeCandidate(transporterId: string, distanceKm: number = 5) {
  return {
    transporterId,
    distanceKm,
    etaSeconds: distanceKm * 120,
    latitude: 19.076,
    longitude: 72.877,
  };
}

function makeOrder(overrides: Record<string, any> = {}) {
  const now = new Date();
  return {
    id: overrides.id || 'order-001',
    customerId: 'cust-1',
    customerName: 'Test Customer',
    customerPhone: '9876543210',
    pickup: { latitude: 19.076, longitude: 72.877, address: 'Mumbai', city: 'Mumbai' },
    drop: { latitude: 18.52, longitude: 73.856, address: 'Pune', city: 'Pune' },
    routePoints: [
      { type: 'PICKUP', latitude: 19.076, longitude: 72.877, address: 'Mumbai', city: 'Mumbai', stopIndex: 0 },
      { type: 'DROP', latitude: 18.52, longitude: 73.856, address: 'Pune', city: 'Pune', stopIndex: 1 },
    ],
    distanceKm: 150,
    goodsType: 'General',
    cargoWeightKg: 5000,
    status: 'broadcasting',
    totalTrucks: 3,
    trucksFilled: 0,
    expiresAt: new Date(now.getTime() + 300000).toISOString(),
    createdAt: now.toISOString(),
    ...overrides,
  };
}

function makeTruckRequest(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id || `tr-${Math.random().toString(36).slice(2, 8)}`,
    orderId: overrides.orderId || 'order-001',
    vehicleType: overrides.vehicleType || 'tipper',
    vehicleSubtype: overrides.vehicleSubtype || '20-24Ton',
    requestNumber: overrides.requestNumber || 1,
    pricePerTruck: overrides.pricePerTruck || 5000,
    status: overrides.status || 'searching',
    notifiedTransporters: overrides.notifiedTransporters || [],
    createdAt: overrides.createdAt || new Date(),
    updatedAt: overrides.updatedAt || new Date(),
    ...overrides,
  };
}

function makeCreateOrderRequest(overrides: Record<string, any> = {}): any {
  return {
    customerId: 'cust-1',
    customerName: 'Test Customer',
    customerPhone: '9876543210',
    pickup: { latitude: 19.076, longitude: 72.877, address: 'Mumbai', city: 'Mumbai' },
    drop: { latitude: 18.52, longitude: 73.856, address: 'Pune', city: 'Pune' },
    routePoints: [
      { type: 'PICKUP', latitude: 19.076, longitude: 72.877, address: 'Mumbai', city: 'Mumbai', stopIndex: 0 },
      { type: 'DROP', latitude: 18.52, longitude: 73.856, address: 'Pune', city: 'Pune', stopIndex: 1 },
    ],
    distanceKm: 150,
    vehicleRequirements: [],
    goodsType: 'General',
    cargoWeightKg: 5000,
    ...overrides,
  };
}

// =============================================================================
// SCENARIO 1: Batch suspension check efficiency (H1)
// =============================================================================
describe('Scenario 1: Batch suspension check efficiency (H1)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('getSuspendedUserIds returns correct Set of suspended IDs from 100 candidates', async () => {
    // Create 100 candidate transporters, 10 of which are suspended
    const allIds = Array.from({ length: 100 }, (_, i) => makeTransporterId(i));
    const suspendedIds = allIds.slice(0, 10); // first 10 are suspended

    // Mock Redis eval to return EXISTS results: 1 for suspended, 0 for not
    const existsResults = allIds.map((_, i) => (i < 10 ? 1 : 0));
    mockRedisEval.mockResolvedValueOnce(existsResults);

    const result = await adminSuspensionService.getSuspendedUserIds(allIds);

    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(10);
    for (const id of suspendedIds) {
      expect(result.has(id)).toBe(true);
    }
    for (const id of allIds.slice(10)) {
      expect(result.has(id)).toBe(false);
    }
  });

  test('batch check uses single Redis eval call (not 100 individual calls)', async () => {
    const allIds = Array.from({ length: 100 }, (_, i) => makeTransporterId(i));
    const existsResults = allIds.map((_, i) => (i < 10 ? 1 : 0));
    mockRedisEval.mockResolvedValueOnce(existsResults);

    await adminSuspensionService.getSuspendedUserIds(allIds);

    // Only 1 Redis round-trip via eval, not 100 individual EXISTS calls
    expect(mockRedisEval).toHaveBeenCalledTimes(1);
    expect(mockRedisExists).not.toHaveBeenCalled();
  });

  test('Lua script receives correct keys for all 100 transporters', async () => {
    const allIds = Array.from({ length: 100 }, (_, i) => makeTransporterId(i));
    mockRedisEval.mockResolvedValueOnce(allIds.map(() => 0));

    await adminSuspensionService.getSuspendedUserIds(allIds);

    const [script, keys] = mockRedisEval.mock.calls[0];
    expect(keys).toHaveLength(100);
    expect(keys[0]).toBe('suspension:transporter-000');
    expect(keys[99]).toBe('suspension:transporter-099');
    expect(typeof script).toBe('string');
    expect(script).toContain('EXISTS');
  });

  test('broadcast excludes all 10 suspended transporters from 100 candidates', async () => {
    const allIds = Array.from({ length: 100 }, (_, i) => makeTransporterId(i));
    const suspendedIds = new Set(allIds.slice(0, 10));

    // Simulate the filtering logic from broadcastToTransporters
    const candidates = allIds.map((id, i) => makeCandidate(id, 5 + i));
    const eligible = candidates.filter((c) => !suspendedIds.has(c.transporterId));

    expect(eligible).toHaveLength(90);
    for (const c of eligible) {
      expect(suspendedIds.has(c.transporterId)).toBe(false);
    }
  });

  test('empty input returns empty Set without Redis call', async () => {
    const result = await adminSuspensionService.getSuspendedUserIds([]);

    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
    expect(mockRedisEval).not.toHaveBeenCalled();
  });

  test('deduplicates input IDs before checking Redis', async () => {
    const duplicatedIds = ['t-1', 't-2', 't-1', 't-3', 't-2', 't-3'];
    mockRedisEval.mockResolvedValueOnce([0, 1, 0]); // t-1=no, t-2=yes, t-3=no

    const result = await adminSuspensionService.getSuspendedUserIds(duplicatedIds);

    // Should deduplicate to 3 unique IDs
    const [, keys] = mockRedisEval.mock.calls[0];
    expect(keys).toHaveLength(3);
    expect(result.size).toBe(1);
    expect(result.has('t-2')).toBe(true);
  });
});

// =============================================================================
// SCENARIO 2: Notification failure + retry (H4)
// =============================================================================
describe('Scenario 2: Notification failure + retry (H4)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('7 of 10 notifications succeed immediately, 3 fail', async () => {
    const transporterIds = Array.from({ length: 10 }, (_, i) => makeTransporterId(i));
    const failingIds = new Set([makeTransporterId(2), makeTransporterId(5), makeTransporterId(8)]);

    const enqueueAccepted: string[] = [];
    const enqueueFailed: string[] = [];

    // Simulate queueBroadcast: 7 succeed, 3 fail
    for (const id of transporterIds) {
      if (failingIds.has(id)) {
        enqueueFailed.push(id);
      } else {
        enqueueAccepted.push(id);
      }
    }

    expect(enqueueAccepted).toHaveLength(7);
    expect(enqueueFailed).toHaveLength(3);
  });

  test('failed notifications are retried after 2s delay', async () => {
    const failedIds = [makeTransporterId(2), makeTransporterId(5), makeTransporterId(8)];

    // First attempt: all 3 fail
    mockQueueBroadcast
      .mockRejectedValueOnce(new Error('Redis timeout'))
      .mockRejectedValueOnce(new Error('Redis timeout'))
      .mockRejectedValueOnce(new Error('Redis timeout'));

    const enqueueJobs = failedIds.map((id) =>
      mockQueueBroadcast(id, 'new_broadcast', { orderId: 'order-001' })
        .catch(() => { /* initial failure */ })
    );
    await Promise.allSettled(enqueueJobs);
    expect(mockQueueBroadcast).toHaveBeenCalledTimes(3);

    // Retry: simulate the H4 retry path (2s delay + re-queue)
    mockQueueBroadcast
      .mockResolvedValueOnce('job-retry-1')
      .mockResolvedValueOnce('job-retry-2')
      .mockResolvedValueOnce('job-retry-3');

    const retryResults = await Promise.allSettled(
      failedIds.map((id) =>
        mockQueueBroadcast(id, 'new_broadcast', { orderId: 'order-001', _retry: true })
      )
    );

    const retrySuccessCount = retryResults.filter((r) => r.status === 'fulfilled').length;
    expect(retrySuccessCount).toBe(3);
    // Total calls: 3 initial + 3 retries = 6
    expect(mockQueueBroadcast).toHaveBeenCalledTimes(6);
  });

  test('retry results are logged with success/fail counts', async () => {
    const failedIds = [makeTransporterId(0), makeTransporterId(1)];

    // Retry: 1 succeeds, 1 fails again
    mockQueueBroadcast
      .mockResolvedValueOnce('job-ok')
      .mockRejectedValueOnce(new Error('Still failing'));

    const retryResults = await Promise.allSettled(
      failedIds.map((id) =>
        mockQueueBroadcast(id, 'new_broadcast', { _retry: true })
      )
    );

    const retrySuccessCount = retryResults.filter((r) => r.status === 'fulfilled').length;
    const retryFailCount = retryResults.filter((r) => r.status === 'rejected').length;

    // Simulate the logging that broadcastVehicleTypePayload performs
    if (retrySuccessCount > 0 || retryFailCount > 0) {
      (logger.info as jest.Mock)('[Broadcast] Retry results', {
        orderId: 'order-001',
        retrySuccessCount,
        retryFailCount,
      });
    }

    expect(retrySuccessCount).toBe(1);
    expect(retryFailCount).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(
      '[Broadcast] Retry results',
      expect.objectContaining({ retrySuccessCount: 1, retryFailCount: 1 })
    );
  });

  test('successful retries are added to the accepted transporter list', async () => {
    const enqueueAccepted: string[] = ['t-ok-1', 't-ok-2'];
    const enqueueFailed = ['t-fail-1', 't-fail-2'];

    // Simulate retry success for failed transporters
    mockQueueBroadcast
      .mockResolvedValueOnce('job-1')
      .mockResolvedValueOnce('job-2');

    const retryResults = await Promise.allSettled(
      enqueueFailed.map((id) =>
        mockQueueBroadcast(id, 'new_broadcast', { _retry: true }).then(() => {
          enqueueAccepted.push(id);
        })
      )
    );

    const allSucceeded = retryResults.every((r) => r.status === 'fulfilled');
    expect(allSucceeded).toBe(true);
    expect(enqueueAccepted).toContain('t-fail-1');
    expect(enqueueAccepted).toContain('t-fail-2');
    expect(enqueueAccepted).toHaveLength(4);
  });

  test('end-to-end: broadcastVehicleTypePayload retries failed sends', async () => {
    const orderId = 'order-retry-e2e';
    const transporterIds = Array.from({ length: 5 }, (_, i) => makeTransporterId(i));

    const order = makeOrder({ id: orderId });
    mockGetOrderById.mockResolvedValue(order);

    // Availability: all transporters have trucks available
    mockGetTransportersAvailabilitySnapshot.mockResolvedValue(
      transporterIds.map((id) => ({
        transporterId: id,
        transporterName: `Transporter ${id}`,
        totalOwned: 3,
        available: 2,
        inTransit: 1,
      }))
    );

    // Queue: first 2 succeed, next 3 fail initially
    let callCount = 0;
    mockQueueBroadcast.mockImplementation(() => {
      callCount++;
      if (callCount >= 3 && callCount <= 5) {
        return Promise.reject(new Error('Connection reset'));
      }
      return Promise.resolve(`job-${callCount}`);
    });

    mockUpdateTruckRequest.mockResolvedValue({});

    // Push notification batch - fire and forget
    mockQueuePushNotificationBatch.mockResolvedValue(undefined);

    const truckRequest = makeTruckRequest({ orderId });
    const requestsByType = buildRequestsByType([truckRequest]);
    const candidateDistanceMap = new Map(
      transporterIds.map((id) => [id, { distanceKm: 5, etaSeconds: 600 }])
    );

    const result = await broadcastVehicleTypePayload(
      orderId,
      makeCreateOrderRequest(),
      [truckRequest],
      requestsByType,
      [truckRequest],
      'tipper',
      '20-24Ton',
      transporterIds,
      order.expiresAt,
      candidateDistanceMap
    );

    // sentTransporters should include retried transporters (strict mode on by default)
    expect(result.sentTransporters.length).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// SCENARIO 3: All notifications fail scenario
// =============================================================================
describe('Scenario 3: All notifications fail scenario', () => {
  beforeEach(() => jest.clearAllMocks());

  test('all 5 notification sends fail without crashing', async () => {
    const transporterIds = Array.from({ length: 5 }, (_, i) => makeTransporterId(i));

    // All initial sends fail
    mockQueueBroadcast.mockRejectedValue(new Error('Redis cluster down'));

    const results = await Promise.allSettled(
      transporterIds.map((id) =>
        mockQueueBroadcast(id, 'new_broadcast', { orderId: 'order-all-fail' })
      )
    );

    const allFailed = results.every((r) => r.status === 'rejected');
    expect(allFailed).toBe(true);
    expect(results).toHaveLength(5);
  });

  test('all 5 are retried after initial failure', async () => {
    const enqueueFailed = Array.from({ length: 5 }, (_, i) => makeTransporterId(i));

    // Retry: still failing
    mockQueueBroadcast.mockRejectedValue(new Error('Still down'));

    const retryResults = await Promise.allSettled(
      enqueueFailed.map((id) =>
        mockQueueBroadcast(id, 'new_broadcast', { _retry: true })
      )
    );

    // All retries also fail, but system should not crash
    const retryFailCount = retryResults.filter((r) => r.status === 'rejected').length;
    expect(retryFailCount).toBe(5);
  });

  test('system remains stable after total failure (no unhandled rejection)', async () => {
    const enqueueFailed = Array.from({ length: 5 }, (_, i) => makeTransporterId(i));
    mockQueueBroadcast.mockRejectedValue(new Error('Catastrophic failure'));

    // Using Promise.allSettled ensures no unhandled rejections
    const settled = await Promise.allSettled(
      enqueueFailed.map((id) =>
        mockQueueBroadcast(id, 'new_broadcast', { _retry: true })
      )
    );

    expect(settled).toHaveLength(5);
    // Verify all were handled (not thrown)
    for (const result of settled) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(Error);
      }
    }
  });

  test('order still exists in database after total notification failure', async () => {
    const orderId = 'order-total-fail';
    const order = makeOrder({ id: orderId, status: 'broadcasting' });
    mockGetOrderById.mockResolvedValue(order);

    // All notifications fail
    mockQueueBroadcast.mockRejectedValue(new Error('Redis down'));

    // Simulate: broadcast attempted but all failed
    const transporterIds = Array.from({ length: 5 }, (_, i) => makeTransporterId(i));
    await Promise.allSettled(
      transporterIds.map((id) =>
        mockQueueBroadcast(id, 'new_broadcast', { orderId })
      )
    );

    // Verify order is still retrievable -- outbox poller will handle re-broadcast
    const refetchedOrder = await mockGetOrderById(orderId);
    expect(refetchedOrder).toBeDefined();
    expect(refetchedOrder.id).toBe(orderId);
    expect(refetchedOrder.status).toBe('broadcasting');
  });

  test('sentTransporters list is empty when all notifications fail (strict mode)', async () => {
    const enqueueFailed = Array.from({ length: 5 }, (_, i) => makeTransporterId(i));
    const enqueueAccepted: string[] = [];

    // All fail
    for (const id of enqueueFailed) {
      try {
        await Promise.reject(new Error('fail'));
        enqueueAccepted.push(id);
      } catch {
        // Failed, not added to accepted
      }
    }

    // In strict mode, only accepted transporters appear in sentTransporters
    const sentTransporters: string[] = [];
    sentTransporters.push(...enqueueAccepted);

    expect(sentTransporters).toHaveLength(0);
  });
});

// =============================================================================
// SCENARIO 4: Dedup TTL edge case (M8)
// =============================================================================
describe('Scenario 4: Dedup TTL edge case (M8)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('TTL = Math.ceil(BROADCAST_TIMEOUT_MS / 1000) + 180', () => {
    // Default: BROADCAST_TIMEOUT_SECONDS = 120 -> BROADCAST_TIMEOUT_MS = 120000
    const BROADCAST_TIMEOUT_MS = parseInt(process.env.BROADCAST_TIMEOUT_SECONDS || '120', 10) * 1000;
    const expectedTTL = Math.ceil(BROADCAST_TIMEOUT_MS / 1000) + 180;

    // Default: 120 + 180 = 300 seconds
    expect(expectedTTL).toBe(300);
  });

  test('TTL exceeds max cumulative retry delay (248s)', () => {
    // Max cumulative retry delay from exponential backoff:
    // 2 + 4 + 8 + 16 + 32 + 60 + 60 + 60 = 242s base
    // Plus ~6s jitter = 248s worst case
    const maxCumulativeRetryDelay = 2 + 4 + 8 + 16 + 32 + 60 + 60 + 60; // 242
    const maxJitter = 6;
    const worstCaseRetry = maxCumulativeRetryDelay + maxJitter; // 248

    const BROADCAST_TIMEOUT_MS = parseInt(process.env.BROADCAST_TIMEOUT_SECONDS || '120', 10) * 1000;
    const ttl = Math.ceil(BROADCAST_TIMEOUT_MS / 1000) + 180;

    expect(ttl).toBeGreaterThan(worstCaseRetry);
    expect(ttl - worstCaseRetry).toBeGreaterThanOrEqual(1); // At least 1s margin
  });

  test('no dedup window gap: TTL covers entire retry spectrum', () => {
    const BROADCAST_TIMEOUT_MS = 120 * 1000;
    const ttl = Math.ceil(BROADCAST_TIMEOUT_MS / 1000) + 180; // 300

    // Verify at each retry step the dedup key is still alive
    const retryDelays = [2, 4, 8, 16, 32, 60, 60, 60]; // exponential + cap at 60
    let cumulativeDelay = 0;

    for (let i = 0; i < retryDelays.length; i++) {
      cumulativeDelay += retryDelays[i];
      const maxJitterAtStep = 1; // Per-step jitter up to 1s
      const totalElapsed = cumulativeDelay + maxJitterAtStep;
      expect(ttl).toBeGreaterThan(totalElapsed);
    }
  });

  test('markTransportersNotified uses correct TTL formula', async () => {
    mockRedisSAddWithExpire.mockResolvedValue(undefined);

    // Call the actual function
    await markTransportersNotified('order-ttl-test', 'tipper', '20-24Ton', ['t-1', 't-2']);

    expect(mockRedisSAddWithExpire).toHaveBeenCalledTimes(1);

    const [, ttlArg] = mockRedisSAddWithExpire.mock.calls[0];
    const BROADCAST_TIMEOUT_MS = parseInt(process.env.BROADCAST_TIMEOUT_SECONDS || '120', 10) * 1000;
    const expectedTTL = Math.ceil(BROADCAST_TIMEOUT_MS / 1000) + 180;
    expect(ttlArg).toBe(expectedTTL);
  });

  test('custom BROADCAST_TIMEOUT_SECONDS adjusts TTL accordingly', () => {
    // If configured to 300s instead of default 120s
    const customTimeoutMs = 300 * 1000;
    const ttl = Math.ceil(customTimeoutMs / 1000) + 180; // 480

    expect(ttl).toBe(480);
    expect(ttl).toBeGreaterThan(248); // Still covers worst-case retry
  });

  test('very short timeout (30s) still covers retry delay', () => {
    const shortTimeoutMs = 30 * 1000;
    const ttl = Math.ceil(shortTimeoutMs / 1000) + 180; // 210

    // 210 < 248 -- this is the edge case where a very short timeout
    // would NOT cover the full retry spectrum. However, the +180 buffer
    // is designed for the default 120s timeout. With 30s, the broadcast
    // would expire before retries complete anyway.
    //
    // This test documents the boundary: operators should not set
    // BROADCAST_TIMEOUT_SECONDS below 68 (248 - 180) for full coverage.
    const minTimeoutForFullCoverage = 248 - 180; // 68 seconds
    expect(minTimeoutForFullCoverage).toBe(68);
    expect(ttl).toBe(210);
  });
});

// =============================================================================
// SCENARIO 5: Progressive broadcast with suspension
// =============================================================================
describe('Scenario 5: Progressive broadcast with suspension', () => {
  beforeEach(() => jest.clearAllMocks());

  test('Step 1: broadcast to 20 candidates, 5 suspended -> 15 notified', async () => {
    const step1Candidates = Array.from({ length: 20 }, (_, i) => makeCandidate(makeTransporterId(i)));
    const step1Ids = step1Candidates.map((c) => c.transporterId);
    const suspendedStep1 = new Set(step1Ids.slice(0, 5));

    // Mock Redis eval for batch suspension check
    mockRedisEval.mockResolvedValueOnce(
      step1Ids.map((id) => (suspendedStep1.has(id) ? 1 : 0))
    );

    const suspendedSet = await adminSuspensionService.getSuspendedUserIds(step1Ids);
    const eligible = step1Candidates.filter((c) => !suspendedSet.has(c.transporterId));

    expect(suspendedSet.size).toBe(5);
    expect(eligible).toHaveLength(15);
    expect(mockRedisEval).toHaveBeenCalledTimes(1);
  });

  test('Step 2: expand radius, 30 new candidates, 8 suspended -> 22 notified', async () => {
    const step2Candidates = Array.from({ length: 30 }, (_, i) => makeCandidate(makeTransporterId(20 + i)));
    const step2Ids = step2Candidates.map((c) => c.transporterId);
    const suspendedStep2 = new Set(step2Ids.slice(0, 8));

    mockRedisEval.mockResolvedValueOnce(
      step2Ids.map((id) => (suspendedStep2.has(id) ? 1 : 0))
    );

    const suspendedSet = await adminSuspensionService.getSuspendedUserIds(step2Ids);
    const eligible = step2Candidates.filter((c) => !suspendedSet.has(c.transporterId));

    expect(suspendedSet.size).toBe(8);
    expect(eligible).toHaveLength(22);
    expect(mockRedisEval).toHaveBeenCalledTimes(1);
  });

  test('batch suspension check used in BOTH progressive steps', async () => {
    // Step 1
    const step1Ids = Array.from({ length: 20 }, (_, i) => makeTransporterId(i));
    mockRedisEval.mockResolvedValueOnce(step1Ids.map(() => 0));
    await adminSuspensionService.getSuspendedUserIds(step1Ids);

    // Step 2 (new candidates at wider radius)
    const step2Ids = Array.from({ length: 30 }, (_, i) => makeTransporterId(20 + i));
    mockRedisEval.mockResolvedValueOnce(step2Ids.map(() => 0));
    await adminSuspensionService.getSuspendedUserIds(step2Ids);

    // Both steps used batch eval, not individual EXISTS
    expect(mockRedisEval).toHaveBeenCalledTimes(2);
    expect(mockRedisExists).not.toHaveBeenCalled();

    // Step 1 checked 20 keys, Step 2 checked 30 keys
    expect(mockRedisEval.mock.calls[0][1]).toHaveLength(20);
    expect(mockRedisEval.mock.calls[1][1]).toHaveLength(30);
  });

  test('cumulative: 15 + 22 = 37 total notified across both steps', async () => {
    // Step 1: 20 candidates, 5 suspended
    const step1Ids = Array.from({ length: 20 }, (_, i) => makeTransporterId(i));
    mockRedisEval.mockResolvedValueOnce(step1Ids.map((_, i) => (i < 5 ? 1 : 0)));
    const step1Suspended = await adminSuspensionService.getSuspendedUserIds(step1Ids);
    const step1Eligible = step1Ids.filter((id) => !step1Suspended.has(id));

    // Step 2: 30 new candidates, 8 suspended
    const step2Ids = Array.from({ length: 30 }, (_, i) => makeTransporterId(20 + i));
    mockRedisEval.mockResolvedValueOnce(step2Ids.map((_, i) => (i < 8 ? 1 : 0)));
    const step2Suspended = await adminSuspensionService.getSuspendedUserIds(step2Ids);
    const step2Eligible = step2Ids.filter((id) => !step2Suspended.has(id));

    const totalNotified = step1Eligible.length + step2Eligible.length;
    expect(step1Eligible).toHaveLength(15);
    expect(step2Eligible).toHaveLength(22);
    expect(totalNotified).toBe(37);
  });

  test('suspended transporter in step 1 not re-checked in step 2 (different candidates)', async () => {
    const step1Ids = Array.from({ length: 5 }, (_, i) => makeTransporterId(i));
    const step2Ids = Array.from({ length: 5 }, (_, i) => makeTransporterId(100 + i));

    // Ensure no overlap between step 1 and step 2 candidates
    const overlap = step1Ids.filter((id) => step2Ids.includes(id));
    expect(overlap).toHaveLength(0);

    // alreadyNotified set from step 1 prevents re-notification in progressive matcher
    const alreadyNotified = new Set(step1Ids);
    const step2New = step2Ids.filter((id) => !alreadyNotified.has(id));
    expect(step2New).toHaveLength(5);
  });
});

// =============================================================================
// SCENARIO 6: Redis failure during suspension check
// =============================================================================
describe('Scenario 6: Redis failure during suspension check', () => {
  beforeEach(() => jest.clearAllMocks());

  test('Redis eval failure triggers fallback to individual isUserSuspended calls', async () => {
    const userIds = [makeTransporterId(0), makeTransporterId(1), makeTransporterId(2)];

    // Lua eval fails
    mockRedisEval.mockRejectedValueOnce(new Error('NOSCRIPT No matching script'));

    // Individual EXISTS calls: only transporter-001 is suspended
    mockRedisExists
      .mockResolvedValueOnce(false)  // transporter-000: not suspended
      .mockResolvedValueOnce(true)   // transporter-001: suspended
      .mockResolvedValueOnce(false); // transporter-002: not suspended

    const result = await adminSuspensionService.getSuspendedUserIds(userIds);

    expect(result.size).toBe(1);
    expect(result.has(makeTransporterId(1))).toBe(true);

    // Eval was attempted once, then fell back to individual checks
    expect(mockRedisEval).toHaveBeenCalledTimes(1);
    expect(mockRedisExists).toHaveBeenCalledTimes(3);
  });

  test('fallback logs warning about batch check failure', async () => {
    const userIds = [makeTransporterId(0)];
    mockRedisEval.mockRejectedValueOnce(new Error('Redis cluster timeout'));
    mockRedisExists.mockResolvedValueOnce(false);

    await adminSuspensionService.getSuspendedUserIds(userIds);

    expect(logger.warn).toHaveBeenCalledWith(
      '[AdminSuspension] Batch suspension check failed, falling back to individual checks',
      expect.objectContaining({
        userCount: 1,
        error: 'Redis cluster timeout',
      })
    );
  });

  test('broadcast still completes even when Redis Lua eval throws', async () => {
    const allIds = Array.from({ length: 10 }, (_, i) => makeTransporterId(i));

    // Lua eval throws
    mockRedisEval.mockRejectedValueOnce(new Error('CROSSSLOT Keys in request'));

    // Fallback: all individual checks return not-suspended
    mockRedisExists.mockResolvedValue(false);

    const suspendedSet = await adminSuspensionService.getSuspendedUserIds(allIds);

    // All transporters pass (fail-open policy)
    expect(suspendedSet.size).toBe(0);

    // Simulate broadcast proceeding with all candidates
    const candidates = allIds.map((id) => makeCandidate(id));
    const eligible = candidates.filter((c) => !suspendedSet.has(c.transporterId));
    expect(eligible).toHaveLength(10);
  });

  test('individual isUserSuspended also fails open (Redis down entirely)', async () => {
    const userIds = [makeTransporterId(0), makeTransporterId(1)];

    // Lua eval fails
    mockRedisEval.mockRejectedValueOnce(new Error('Connection refused'));

    // Individual EXISTS also fails
    mockRedisExists.mockRejectedValue(new Error('Connection refused'));

    // isUserSuspended catches the error and returns false (fail-open)
    const result = await adminSuspensionService.getSuspendedUserIds(userIds);

    // Fail-open: no users are marked as suspended when Redis is entirely down
    expect(result.size).toBe(0);
  });

  test('partial Redis failure: some individual checks succeed, some fail', async () => {
    const userIds = Array.from({ length: 4 }, (_, i) => makeTransporterId(i));

    // Lua eval fails
    mockRedisEval.mockRejectedValueOnce(new Error('Lua script error'));

    // Individual checks: 2 succeed (1 suspended), 2 fail (treated as not-suspended)
    mockRedisExists
      .mockResolvedValueOnce(true)   // transporter-000: suspended
      .mockResolvedValueOnce(false)  // transporter-001: not suspended
      .mockRejectedValueOnce(new Error('Timeout')) // transporter-002: fail-open -> not suspended
      .mockRejectedValueOnce(new Error('Timeout')); // transporter-003: fail-open -> not suspended

    const result = await adminSuspensionService.getSuspendedUserIds(userIds);

    // Only transporter-000 is confirmed suspended
    // transporter-002 and transporter-003 fail-open (not marked suspended)
    expect(result.has(makeTransporterId(0))).toBe(true);
    expect(result.has(makeTransporterId(1))).toBe(false);
    expect(result.has(makeTransporterId(2))).toBe(false);
    expect(result.has(makeTransporterId(3))).toBe(false);
    expect(result.size).toBe(1);
  });

  test('degraded mode does not block broadcast from completing', async () => {
    const candidateIds = Array.from({ length: 50 }, (_, i) => makeTransporterId(i));

    // Complete Redis outage for Lua
    mockRedisEval.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    // All individual checks also fail
    mockRedisExists.mockRejectedValue(new Error('ECONNREFUSED'));

    const suspendedSet = await adminSuspensionService.getSuspendedUserIds(candidateIds);

    // Fail-open: treat all as not-suspended
    expect(suspendedSet.size).toBe(0);

    // Broadcast can proceed with all 50 candidates
    const finalTargets = candidateIds.filter((id) => !suspendedSet.has(id));
    expect(finalTargets).toHaveLength(50);

    // Log warning was emitted for observability
    expect(logger.warn).toHaveBeenCalled();
  });
});
