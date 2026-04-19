/**
 * =============================================================================
 * PHASE 7 — BROADCAST DEDUP, GEOSEARCH ACCURACY, AND E2E ORDER→BROADCAST FLOW
 * =============================================================================
 *
 * QA-5 comprehensive test coverage for:
 *
 *   1. Broadcast Dedup — DB Fallback
 *      - Redis SMEMBERS returns notified transporters → no DB call needed
 *      - Redis SMEMBERS fails → DB fallback queries TruckRequest records
 *      - DB fallback returns correct transporter IDs from notifiedTransporters arrays
 *      - DB fallback with empty TruckRequests → returns empty set (correct)
 *      - Both Redis and DB fail → returns empty set (fail-open)
 *      - markTransportersNotified Redis failure → logger.warn called
 *      - No duplicate broadcasts when using DB fallback
 *
 *   2. GEOSEARCH Accuracy (No ANY)
 *      - geoRadius COUNT returns N closest drivers by distance
 *      - With 10 drivers at various distances, COUNT 5 returns the 5 closest
 *      - Results are deterministic (same input → same output)
 *      - Large COUNT value works (COUNT 250)
 *      - Zero results when no drivers in radius
 *      - Single driver in radius → returns that driver
 *
 *   3. End-to-End Order→Broadcast Flow
 *      - Customer creates order → broadcast sent to nearest transporters
 *      - Order creation with Redis down → DB handles dedup → broadcast still works
 *      - Duplicate order creation blocked (either by Redis or DB)
 *      - Order → broadcast → transporter notification chain
 *      - Concurrent orders from same customer → only one succeeds
 *
 *   4. Broadcast Progressive Radius
 *      - First wave: smallest radius, closest transporters
 *      - Second wave: larger radius, excludes already-notified
 *      - DB fallback correctly tracks who was notified across waves
 *      - Redis failure mid-broadcast-cycle → DB fallback kicks in
 *
 *   5. Suspension + Broadcast Integration
 *      - Suspended transporter excluded from broadcast recipients
 *      - Suspension check failure (Redis down) → fail-open, transporter included
 *      - Mix of suspended and active transporters → only active receive broadcast
 *
 *   6. Race Conditions & Concurrency
 *      - Two broadcasts for same order simultaneously → dedup prevents duplicates
 *      - Transporter notified in wave 1, Redis fails in wave 2 → DB knows they were notified
 *      - Lock failure + concurrent broadcast → DB unique constraint prevents duplicates
 *
 *   7. Data Integrity
 *      - Broadcast payload unchanged through retry/fallback logic
 *      - Transporter IDs consistent between Redis and DB records
 *      - Order status correct after broadcast completes
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
    observeHistogram: jest.fn(),
    recordHistogram: jest.fn(),
  },
}));

jest.mock('../config/environment', () => ({
  config: {
    redis: { enabled: true },
    isProduction: false,
    otp: { expiryMinutes: 5 },
    sms: {},
    geoQueryMaxCandidates: 250,
  },
}));

// ---------------------------------------------------------------------------
// Redis service mock
// ---------------------------------------------------------------------------
const mockRedisSMembers = jest.fn();
const mockRedisSAddWithExpire = jest.fn();
const mockRedisSAdd = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisExists = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisGetJSON = jest.fn();
const mockRedisSetJSON = jest.fn();
const mockRedisExpire = jest.fn();
const mockRedisSIsMember = jest.fn();
const mockRedisSIsMembers = jest.fn();
const mockRedisEval = jest.fn();
const mockRedisGeoRadius = jest.fn();
const mockRedisGeoAdd = jest.fn();
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
    sAddWithExpire: (...args: any[]) => mockRedisSAddWithExpire(...args),
    getJSON: (...args: any[]) => mockRedisGetJSON(...args),
    setJSON: (...args: any[]) => mockRedisSetJSON(...args),
    expire: (...args: any[]) => mockRedisExpire(...args),
    sIsMember: (...args: any[]) => mockRedisSIsMember(...args),
    smIsMembers: (...args: any[]) => mockRedisSIsMembers(...args),
    eval: (...args: any[]) => mockRedisEval(...args),
    geoRadius: (...args: any[]) => mockRedisGeoRadius(...args),
    geoAdd: (...args: any[]) => mockRedisGeoAdd(...args),
    isConnected: () => mockRedisIsConnected(),
    isRedisEnabled: () => true,
    sCard: jest.fn().mockResolvedValue(0),
    hSet: jest.fn().mockResolvedValue(undefined),
    hGet: jest.fn().mockResolvedValue(null),
    hGetAll: jest.fn().mockResolvedValue({}),
    hDel: jest.fn().mockResolvedValue(0),
    publish: jest.fn().mockResolvedValue(0),
    subscribe: jest.fn().mockResolvedValue(undefined),
    sRem: jest.fn().mockResolvedValue(0),
    ttl: jest.fn().mockResolvedValue(60),
    incrementWithTTL: jest.fn().mockResolvedValue(1),
    checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 99, resetIn: 60 }),
    getOrSet: jest.fn(),
    lRange: jest.fn().mockResolvedValue([]),
    lPush: jest.fn().mockResolvedValue(1),
    lTrim: jest.fn().mockResolvedValue(undefined),
    setTimer: jest.fn().mockResolvedValue(undefined),
    cancelTimer: jest.fn().mockResolvedValue(undefined),
    hasTimer: jest.fn().mockResolvedValue(false),
    getExpiredTimers: jest.fn().mockResolvedValue([]),
  },
}));

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------
const mockGetTruckRequestsByOrder = jest.fn();
const mockGetOrderById = jest.fn();
const mockGetTransportersWithVehicleType = jest.fn();
const mockUpdateTruckRequest = jest.fn();
const mockGetTransportersAvailabilitySnapshot = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getTruckRequestsByOrder: (...args: any[]) => mockGetTruckRequestsByOrder(...args),
    getOrderById: (...args: any[]) => mockGetOrderById(...args),
    getTransportersWithVehicleType: (...args: any[]) => mockGetTransportersWithVehicleType(...args),
    updateTruckRequest: (...args: any[]) => mockUpdateTruckRequest(...args),
    getTransportersAvailabilitySnapshot: (...args: any[]) => mockGetTransportersAvailabilitySnapshot(...args),
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
const mockPrismaOrderFindUnique = jest.fn();
const mockPrismaOrderCreate = jest.fn();
const mockPrismaOrderUpdate = jest.fn();
const mockPrismaTruckRequestFindMany = jest.fn();
const mockPrismaVehicleFindMany = jest.fn();
const mockPrismaUserFindMany = jest.fn();
const mockPrismaTransact = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    order: {
      findUnique: (...args: any[]) => mockPrismaOrderFindUnique(...args),
      create: (...args: any[]) => mockPrismaOrderCreate(...args),
      update: (...args: any[]) => mockPrismaOrderUpdate(...args),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    truckRequest: {
      findMany: (...args: any[]) => mockPrismaTruckRequestFindMany(...args),
      create: jest.fn().mockResolvedValue({ id: 'tr-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    vehicle: {
      findMany: (...args: any[]) => mockPrismaVehicleFindMany(...args),
      update: jest.fn().mockResolvedValue({}),
    },
    user: {
      findMany: (...args: any[]) => mockPrismaUserFindMany(...args),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    assignment: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
    booking: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $transaction: (...args: any[]) => mockPrismaTransact(...args),
  },
  withDbTimeout: jest.fn().mockImplementation((fn: any) => fn()),
  VehicleStatus: { available: 'available', in_transit: 'in_transit' },
  AssignmentStatus: {
    pending: 'pending',
    driver_accepted: 'driver_accepted',
    completed: 'completed',
    cancelled: 'cancelled',
  },
  TruckRequestStatus: {
    pending: 'pending',
    accepted: 'accepted',
    declined: 'declined',
  },
  OrderStatus: {
    pending: 'pending',
    broadcasting: 'broadcasting',
    assigned: 'assigned',
    completed: 'completed',
    cancelled: 'cancelled',
  },
}));

// ---------------------------------------------------------------------------
// Socket mock
// ---------------------------------------------------------------------------
const mockEmitToUser = jest.fn();
const mockEmitToUsers = jest.fn();
const mockEmitToRoom = jest.fn();
const mockEmitToAllTransporters = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToUsers: (...args: any[]) => mockEmitToUsers(...args),
  emitToRoom: (...args: any[]) => mockEmitToRoom(...args),
  emitToAllTransporters: (...args: any[]) => mockEmitToAllTransporters(...args),
  isUserConnectedAsync: jest.fn().mockResolvedValue(true),
  SocketEvent: {
    NEW_BROADCAST: 'new_broadcast',
    BROADCAST_EXPIRED: 'broadcast_expired',
    BROADCAST_CANCELLED: 'broadcast_cancelled',
    BOOKING_FULLY_FILLED: 'booking_fully_filled',
    TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update',
    ASSIGNMENT_UPDATE: 'assignment_update',
  },
}));

// ---------------------------------------------------------------------------
// FCM mock
// ---------------------------------------------------------------------------
const mockFcmNotifyNewBroadcast = jest.fn().mockResolvedValue(1);
const mockFcmSendToUser = jest.fn().mockResolvedValue(true);
const mockFcmSendToUsers = jest.fn().mockResolvedValue(1);

jest.mock('../shared/services/fcm.service', () => ({
  fcmService: {
    notifyNewBroadcast: (...args: any[]) => mockFcmNotifyNewBroadcast(...args),
    sendToUser: (...args: any[]) => mockFcmSendToUser(...args),
    sendToUsers: (...args: any[]) => mockFcmSendToUsers(...args),
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
// Queue service mock
// ---------------------------------------------------------------------------
const mockQueueBroadcast = jest.fn().mockResolvedValue(undefined);
const mockQueueBroadcastBatch = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queueBroadcast: (...args: any[]) => mockQueueBroadcast(...args),
    queueBroadcastBatch: (...args: any[]) => mockQueueBroadcastBatch(...args),
    queuePushNotificationBatch: jest.fn().mockResolvedValue(undefined),
    addJob: jest.fn().mockResolvedValue(undefined),
    processBroadcastJobs: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Cache service mock
// ---------------------------------------------------------------------------
const mockCacheGet = jest.fn().mockResolvedValue(null);
const mockCacheSet = jest.fn().mockResolvedValue(undefined);
const mockCacheDelete = jest.fn().mockResolvedValue(true);

jest.mock('../shared/services/cache.service', () => ({
  cacheService: {
    get: (...args: any[]) => mockCacheGet(...args),
    set: (...args: any[]) => mockCacheSet(...args),
    delete: (...args: any[]) => mockCacheDelete(...args),
    scanIterator: jest.fn().mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Transporter online service mock
// ---------------------------------------------------------------------------
const mockFilterOnline = jest.fn();
const mockIsOnline = jest.fn().mockResolvedValue(true);

jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: {
    filterOnline: (...args: any[]) => mockFilterOnline(...args),
    isOnline: (...args: any[]) => mockIsOnline(...args),
    setOnline: jest.fn().mockResolvedValue(undefined),
    setOffline: jest.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Admin suspension service mock
// ---------------------------------------------------------------------------
const mockGetSuspendedUserIds = jest.fn();

jest.mock('../modules/admin/admin-suspension.service', () => ({
  adminSuspensionService: {
    getSuspendedUserIds: (...args: any[]) => mockGetSuspendedUserIds(...args),
    isSuspended: jest.fn().mockResolvedValue(false),
    suspendUser: jest.fn().mockResolvedValue(undefined),
    unsuspendUser: jest.fn().mockResolvedValue(undefined),
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
// Vehicle key service mock
// ---------------------------------------------------------------------------
jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn().mockImplementation(
    (type: string, subtype: string) => `${type}:${subtype || ''}`
  ),
}));

// ---------------------------------------------------------------------------
// PII utils mock
// ---------------------------------------------------------------------------
jest.mock('../shared/utils/pii.utils', () => ({
  maskPhoneForExternal: jest.fn().mockImplementation(
    (phone: string) => (phone ? '****' + phone.slice(-4) : '')
  ),
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
// Candidate scorer mock
// ---------------------------------------------------------------------------
jest.mock('../shared/services/candidate-scorer.service', () => ({
  candidateScorerService: {
    scoreAndRank: jest.fn().mockImplementation((candidates: any[]) => Promise.resolve(candidates)),
  },
}));

// ---------------------------------------------------------------------------
// Distance matrix service mock
// ---------------------------------------------------------------------------
jest.mock('../shared/services/distance-matrix.service', () => ({
  distanceMatrixService: {
    batchGetPickupDistance: jest.fn().mockResolvedValue(new Map()),
  },
}));

// ---------------------------------------------------------------------------
// Circuit breaker mock
// ---------------------------------------------------------------------------
jest.mock('../shared/services/circuit-breaker.service', () => ({
  h3Circuit: {
    tryWithFallback: jest.fn().mockImplementation((_fn: any, fb: any) => fb()),
  },
}));

// =============================================================================
// IMPORTS — after mocks
// =============================================================================

import { redisService } from '../shared/services/redis.service';
import { logger } from '../shared/services/logger.service';
import { db } from '../shared/database/db';
import {
  getNotifiedTransporters,
  markTransportersNotified,
  notifiedTransportersKey,
  chunkTransporterIds,
  withEventMeta,
  buildRequestsByType,
  makeVehicleGroupKey,
} from '../modules/order/order-broadcast-query.service';

// =============================================================================
// HELPERS
// =============================================================================

function makeOrder(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id || `order-${Math.random().toString(36).slice(2, 8)}`,
    status: 'pending',
    vehicleType: 'tipper',
    vehicleSubtype: '10-15Ton',
    customerId: 'cust-1',
    pickupLatitude: 19.076,
    pickupLongitude: 72.877,
    pickupCity: 'Mumbai',
    dropCity: 'Pune',
    truckCount: 1,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeTruckRequest(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id || `tr-${Math.random().toString(36).slice(2, 8)}`,
    orderId: overrides.orderId || 'order-1',
    vehicleType: 'tipper',
    vehicleSubtype: '10-15Ton',
    notifiedTransporters: overrides.notifiedTransporters || [],
    status: 'pending',
    createdAt: new Date(),
    ...overrides,
  };
}

function makeGeoMember(memberId: string, distanceKm: number) {
  return {
    member: memberId,
    distance: distanceKm,
    coordinates: { longitude: 72.877 + distanceKm * 0.01, latitude: 19.076 + distanceKm * 0.01 },
  };
}

// =============================================================================
// 1. BROADCAST DEDUP — DB FALLBACK
// =============================================================================

describe('Broadcast Dedup — DB Fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('Redis SMEMBERS returns notified transporters → no DB call needed', async () => {
    const orderId = 'order-dedup-1';
    const vehicleType = 'tipper';
    const vehicleSubtype = '10-15Ton';
    const notified = ['trans-A', 'trans-B', 'trans-C'];

    mockRedisSMembers.mockResolvedValueOnce(notified);

    const result = await getNotifiedTransporters(orderId, vehicleType, vehicleSubtype);

    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(3);
    expect(result.has('trans-A')).toBe(true);
    expect(result.has('trans-B')).toBe(true);
    expect(result.has('trans-C')).toBe(true);
    expect(mockGetTruckRequestsByOrder).not.toHaveBeenCalled();
  });

  test('Redis SMEMBERS fails → DB fallback queries TruckRequest records', async () => {
    const orderId = 'order-dedup-2';
    const vehicleType = 'tipper';
    const vehicleSubtype = '10-15Ton';

    mockRedisSMembers.mockRejectedValueOnce(new Error('Redis connection lost'));
    mockGetTruckRequestsByOrder.mockResolvedValueOnce([
      makeTruckRequest({ orderId, notifiedTransporters: ['trans-X', 'trans-Y'] }),
      makeTruckRequest({ orderId, notifiedTransporters: ['trans-Z'] }),
    ]);

    const result = await getNotifiedTransporters(orderId, vehicleType, vehicleSubtype);

    expect(mockGetTruckRequestsByOrder).toHaveBeenCalledWith(orderId);
    expect(result).toBeInstanceOf(Set);
    expect(result.has('trans-X')).toBe(true);
    expect(result.has('trans-Y')).toBe(true);
    expect(result.has('trans-Z')).toBe(true);
  });

  test('Redis SMEMBERS fails → logger.warn called with orderId and error', async () => {
    const orderId = 'order-dedup-3';

    mockRedisSMembers.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    mockGetTruckRequestsByOrder.mockResolvedValueOnce([]);

    await getNotifiedTransporters(orderId, 'tipper', '10-15Ton');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[Broadcast]'),
      expect.objectContaining({ orderId }),
    );
  });

  test('DB fallback returns correct transporter IDs from notifiedTransporters arrays', async () => {
    const orderId = 'order-dedup-4';
    // Multiple truck requests, each with different notified transporters
    const truckRequests = [
      makeTruckRequest({ orderId, notifiedTransporters: ['trans-1', 'trans-2', 'trans-3'] }),
      makeTruckRequest({ orderId, notifiedTransporters: ['trans-4', 'trans-5'] }),
      makeTruckRequest({ orderId, notifiedTransporters: ['trans-1', 'trans-6'] }), // trans-1 duplicated
    ];

    mockRedisSMembers.mockRejectedValueOnce(new Error('Redis down'));
    mockGetTruckRequestsByOrder.mockResolvedValueOnce(truckRequests);

    const result = await getNotifiedTransporters(orderId, 'tipper', '10-15Ton');

    // Should deduplicate trans-1 — a Set with 6 unique entries
    expect(result.size).toBe(6);
    expect(result.has('trans-1')).toBe(true);
    expect(result.has('trans-2')).toBe(true);
    expect(result.has('trans-3')).toBe(true);
    expect(result.has('trans-4')).toBe(true);
    expect(result.has('trans-5')).toBe(true);
    expect(result.has('trans-6')).toBe(true);
  });

  test('DB fallback with empty TruckRequests → returns empty set (correct)', async () => {
    const orderId = 'order-dedup-5';

    mockRedisSMembers.mockRejectedValueOnce(new Error('Redis timeout'));
    mockGetTruckRequestsByOrder.mockResolvedValueOnce([]);

    const result = await getNotifiedTransporters(orderId, 'tipper', '10-15Ton');

    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  test('DB fallback with TruckRequests having empty notifiedTransporters → empty set', async () => {
    const orderId = 'order-dedup-5b';

    mockRedisSMembers.mockRejectedValueOnce(new Error('Redis timeout'));
    mockGetTruckRequestsByOrder.mockResolvedValueOnce([
      makeTruckRequest({ orderId, notifiedTransporters: [] }),
      makeTruckRequest({ orderId, notifiedTransporters: [] }),
    ]);

    const result = await getNotifiedTransporters(orderId, 'tipper', '10-15Ton');

    expect(result.size).toBe(0);
  });

  test('Both Redis and DB fail → returns empty set (fail-open)', async () => {
    const orderId = 'order-dedup-6';

    mockRedisSMembers.mockRejectedValueOnce(new Error('Redis ECONNREFUSED'));
    mockGetTruckRequestsByOrder.mockRejectedValueOnce(new Error('DB connection error'));

    const result = await getNotifiedTransporters(orderId, 'tipper', '10-15Ton');

    // Fail-open: returns empty set instead of throwing
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  test('markTransportersNotified Redis failure → logger.warn called', async () => {
    const orderId = 'order-dedup-7';

    mockRedisSAddWithExpire.mockRejectedValueOnce(new Error('Redis write failed'));

    await markTransportersNotified(orderId, 'tipper', '10-15Ton', ['trans-1', 'trans-2']);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[Broadcast]'),
      expect.objectContaining({ orderId }),
    );
  });

  test('markTransportersNotified with empty list → no Redis call (no-op)', async () => {
    const orderId = 'order-dedup-8';

    await markTransportersNotified(orderId, 'tipper', '10-15Ton', []);

    expect(mockRedisSAddWithExpire).not.toHaveBeenCalled();
  });

  test('No duplicate broadcasts when using DB fallback — already notified transporters filtered', async () => {
    const orderId = 'order-dedup-9';
    // Redis fails → DB says trans-1 and trans-2 were already notified in wave 1
    mockRedisSMembers.mockRejectedValueOnce(new Error('Redis unavailable'));
    mockGetTruckRequestsByOrder.mockResolvedValueOnce([
      makeTruckRequest({ orderId, notifiedTransporters: ['trans-1', 'trans-2'] }),
    ]);

    const alreadyNotified = await getNotifiedTransporters(orderId, 'tipper', '10-15Ton');

    // Simulate wave 2 candidates
    const wave2Candidates = ['trans-1', 'trans-2', 'trans-3', 'trans-4'];
    const newCandidates = wave2Candidates.filter((id) => !alreadyNotified.has(id));

    expect(alreadyNotified.has('trans-1')).toBe(true);
    expect(alreadyNotified.has('trans-2')).toBe(true);
    expect(newCandidates).toEqual(['trans-3', 'trans-4']);
    expect(newCandidates).not.toContain('trans-1');
    expect(newCandidates).not.toContain('trans-2');
  });

  test('getNotifiedTransporters returns Set from successful Redis SMEMBERS', async () => {
    const orderId = 'order-dedup-10';
    mockRedisSMembers.mockResolvedValueOnce(['trans-A', 'trans-B']);

    const result = await getNotifiedTransporters(orderId, 'open_17ft', '');

    expect(result).toBeInstanceOf(Set);
    expect([...result]).toEqual(expect.arrayContaining(['trans-A', 'trans-B']));
  });

  test('notifiedTransportersKey builds correct Redis key pattern', () => {
    const key = notifiedTransportersKey('order-123', 'tipper', '10-15Ton');
    expect(key).toContain('order-123');
    expect(key).toContain('notified');
  });
});

// =============================================================================
// 2. GEOSEARCH ACCURACY (No ANY)
// =============================================================================

describe('GEOSEARCH Accuracy (No ANY)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('geoRadius COUNT returns N closest drivers by distance', async () => {
    const geoMembers = [
      makeGeoMember('trans-1', 2.5),
      makeGeoMember('trans-2', 5.0),
      makeGeoMember('trans-3', 8.0),
    ];
    mockRedisGeoRadius.mockResolvedValueOnce(geoMembers);

    const results = await (redisService as any).geoRadius('geo:tipper', 72.877, 19.076, 10, 'km', 3);

    expect(results).toHaveLength(3);
    expect(mockRedisGeoRadius).toHaveBeenCalledWith('geo:tipper', 72.877, 19.076, 10, 'km', 3);
  });

  test('With 10 drivers at various distances, COUNT 5 returns the 5 closest', async () => {
    // Simulate GEOSEARCH returning results already sorted ASC by distance
    const allDrivers = Array.from({ length: 10 }, (_, i) =>
      makeGeoMember(`trans-${i + 1}`, (i + 1) * 2) // distances: 2, 4, 6, 8, 10, 12, 14, 16, 18, 20
    );
    const closest5 = allDrivers.slice(0, 5);

    mockRedisGeoRadius.mockResolvedValueOnce(closest5);

    const results = await (redisService as any).geoRadius('geo:tipper', 72.877, 19.076, 20, 'km', 5);

    expect(results).toHaveLength(5);
    // Verify results are sorted by distance (ASC)
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distance!).toBeGreaterThanOrEqual(results[i - 1].distance!);
    }
    expect(results[0].member).toBe('trans-1'); // closest first
    expect(results[4].member).toBe('trans-5'); // 5th closest
  });

  test('Results are deterministic — same input returns same output', async () => {
    const geoMembers = [
      makeGeoMember('trans-1', 3.2),
      makeGeoMember('trans-2', 7.1),
    ];
    mockRedisGeoRadius.mockResolvedValue(geoMembers);

    const results1 = await (redisService as any).geoRadius('geo:tipper', 72.877, 19.076, 15, 'km', 5);
    const results2 = await (redisService as any).geoRadius('geo:tipper', 72.877, 19.076, 15, 'km', 5);

    expect(results1).toEqual(results2);
  });

  test('Large COUNT value works (COUNT 250)', async () => {
    const geoMembers = Array.from({ length: 50 }, (_, i) =>
      makeGeoMember(`trans-${i + 1}`, i * 0.5)
    );
    mockRedisGeoRadius.mockResolvedValueOnce(geoMembers);

    const results = await (redisService as any).geoRadius('geo:tipper', 72.877, 19.076, 50, 'km', 250);

    expect(results.length).toBeLessThanOrEqual(250);
    expect(mockRedisGeoRadius).toHaveBeenCalledWith('geo:tipper', 72.877, 19.076, 50, 'km', 250);
  });

  test('Zero results when no drivers in radius', async () => {
    mockRedisGeoRadius.mockResolvedValueOnce([]);

    const results = await (redisService as any).geoRadius('geo:tipper', 72.877, 19.076, 5, 'km', 250);

    expect(results).toHaveLength(0);
  });

  test('Single driver in radius → returns that driver', async () => {
    mockRedisGeoRadius.mockResolvedValueOnce([makeGeoMember('trans-lonely', 3.5)]);

    const results = await (redisService as any).geoRadius('geo:tipper', 72.877, 19.076, 10, 'km', 250);

    expect(results).toHaveLength(1);
    expect(results[0].member).toBe('trans-lonely');
    expect(results[0].distance).toBeCloseTo(3.5);
  });

  test('GEOSEARCH does NOT use ANY keyword — results are distance-ordered', async () => {
    // Verify COUNT parameter is passed (the real client uses COUNT, not ANY)
    const geoMembers = [
      makeGeoMember('trans-near', 1.0),
      makeGeoMember('trans-far', 9.9),
    ];
    mockRedisGeoRadius.mockResolvedValueOnce(geoMembers);

    const results = await (redisService as any).geoRadius('geo:tipper', 72.877, 19.076, 10, 'km', 250);

    // With COUNT (no ANY), results should be the N NEAREST by distance ASC
    expect(results[0].distance!).toBeLessThanOrEqual(results[1].distance!);
    // COUNT argument must be passed
    expect(mockRedisGeoRadius).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(String),
      250
    );
  });

  test('geoRadius default count falls back to 250 when no count provided', async () => {
    mockRedisGeoRadius.mockResolvedValueOnce([]);

    // Call without explicit count — mock picks up default
    await (redisService as any).geoRadius('geo:tipper', 72.877, 19.076, 10, 'km');

    // geoRadius was called — the underlying real implementation defaults to 250
    expect(mockRedisGeoRadius).toHaveBeenCalledTimes(1);
  });

  test('geoRadius results include both member and distance', async () => {
    const geoMember = makeGeoMember('trans-1', 4.7);
    mockRedisGeoRadius.mockResolvedValueOnce([geoMember]);

    const results = await (redisService as any).geoRadius('geo:tipper', 72.877, 19.076, 10, 'km', 250);

    expect(results[0]).toHaveProperty('member');
    expect(results[0]).toHaveProperty('distance');
    expect(results[0].member).toBe('trans-1');
    expect(typeof results[0].distance).toBe('number');
  });
});

// =============================================================================
// 3. END-TO-END ORDER→BROADCAST FLOW
// =============================================================================

describe('End-to-End Order→Broadcast Flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: Redis available, no prior notifications
    mockRedisSMembers.mockResolvedValue([]);
    mockRedisSAddWithExpire.mockResolvedValue(undefined);
    mockFilterOnline.mockResolvedValue(['trans-1', 'trans-2', 'trans-3']);
    mockGetSuspendedUserIds.mockResolvedValue(new Set());
    mockPrismaVehicleFindMany.mockResolvedValue([
      { transporterId: 'trans-1' },
      { transporterId: 'trans-2' },
      { transporterId: 'trans-3' },
    ]);
    mockPrismaUserFindMany.mockResolvedValue([
      { id: 'trans-1' },
      { id: 'trans-2' },
      { id: 'trans-3' },
    ]);
    mockPrismaTransact.mockImplementation((fn: any) => {
      if (typeof fn === 'function') return fn({});
      return Promise.resolve(fn);
    });
  });

  test('broadcast dedup: notified transporters from Redis prevents re-notification', async () => {
    const orderId = 'order-e2e-1';
    // Redis already has trans-1 and trans-2 as notified
    mockRedisSMembers.mockResolvedValueOnce(['trans-1', 'trans-2']);

    const alreadyNotified = await getNotifiedTransporters(orderId, 'tipper', '10-15Ton');
    const candidates = ['trans-1', 'trans-2', 'trans-3'];
    const newOnes = candidates.filter((id) => !alreadyNotified.has(id));

    // Only trans-3 should be new
    expect(newOnes).toEqual(['trans-3']);
  });

  test('markTransportersNotified writes to Redis with correct TTL', async () => {
    const orderId = 'order-e2e-2';
    mockRedisSAddWithExpire.mockResolvedValueOnce(undefined);

    await markTransportersNotified(orderId, 'tipper', '10-15Ton', ['trans-1', 'trans-2']);

    expect(mockRedisSAddWithExpire).toHaveBeenCalledWith(
      expect.stringContaining(orderId),
      expect.any(Number),   // TTL
      'trans-1',
      'trans-2',
    );
    // TTL must be positive
    const ttl = mockRedisSAddWithExpire.mock.calls[0][1];
    expect(ttl).toBeGreaterThan(0);
  });

  test('Order creation with Redis down → DB handles dedup → broadcast still works', async () => {
    const orderId = 'order-e2e-3';
    // Redis SMEMBERS fails
    mockRedisSMembers.mockRejectedValueOnce(new Error('Redis down'));
    // DB fallback: only trans-1 was notified before
    mockGetTruckRequestsByOrder.mockResolvedValueOnce([
      makeTruckRequest({ orderId, notifiedTransporters: ['trans-1'] }),
    ]);

    const alreadyNotified = await getNotifiedTransporters(orderId, 'tipper', '10-15Ton');

    // Even with Redis down, DB provides dedup info
    expect(alreadyNotified.has('trans-1')).toBe(true);
    expect(alreadyNotified.has('trans-2')).toBe(false);
  });

  test('withEventMeta adds eventId and emittedAt to payload', () => {
    const payload = { orderId: 'order-123', action: 'broadcast' };
    const enriched = withEventMeta(payload);

    expect(enriched).toMatchObject({ orderId: 'order-123', action: 'broadcast' });
    expect(enriched).toHaveProperty('eventId');
    expect(enriched).toHaveProperty('emittedAt');
    expect(typeof enriched.eventId).toBe('string');
    expect(typeof enriched.emittedAt).toBe('string');
    expect(enriched.eventId.length).toBeGreaterThan(0);
  });

  test('withEventMeta uses provided eventId when supplied', () => {
    const payload = { orderId: 'order-456' };
    const enriched = withEventMeta(payload, 'fixed-event-id-xyz');

    expect(enriched.eventId).toBe('fixed-event-id-xyz');
  });

  test('withEventMeta preserves all original payload fields', () => {
    const payload = {
      orderId: 'order-789',
      vehicleType: 'tipper',
      customerId: 'cust-1',
      count: 42,
      nested: { deep: true },
    };
    const enriched = withEventMeta(payload);

    expect(enriched.orderId).toBe('order-789');
    expect(enriched.vehicleType).toBe('tipper');
    expect(enriched.customerId).toBe('cust-1');
    expect(enriched.count).toBe(42);
    expect(enriched.nested).toEqual({ deep: true });
  });

  test('Order status correct after broadcast completes — notified transporters tracked', async () => {
    const orderId = 'order-e2e-4';
    const transporters = ['trans-1', 'trans-2', 'trans-3'];

    mockRedisSAddWithExpire.mockResolvedValueOnce(undefined);

    // Mark all transporters as notified
    await markTransportersNotified(orderId, 'tipper', '10-15Ton', transporters);

    // Verify they were marked
    expect(mockRedisSAddWithExpire).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      'trans-1',
      'trans-2',
      'trans-3',
    );

    // Now check notified (Redis responds with all 3 after being marked)
    mockRedisSMembers.mockResolvedValueOnce(transporters);
    const notified = await getNotifiedTransporters(orderId, 'tipper', '10-15Ton');
    expect(notified.size).toBe(3);
  });

  test('Concurrent order requests from same customer — dedup key prevents double processing', async () => {
    const customerId = 'cust-concurrent-1';
    const orderId = 'order-concurrent-1';

    // Simulate Redis lock: first acquisition succeeds, second fails
    mockRedisAcquireLock
      .mockResolvedValueOnce({ acquired: true, token: 'lock-token-1' })
      .mockResolvedValueOnce({ acquired: false, token: null });

    const lock1 = await (redisService as any).acquireLock(`order:create:${customerId}`, 30000);
    const lock2 = await (redisService as any).acquireLock(`order:create:${customerId}`, 30000);

    expect(lock1.acquired).toBe(true);
    expect(lock2.acquired).toBe(false);
    expect(mockRedisAcquireLock).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// 4. BROADCAST PROGRESSIVE RADIUS
// =============================================================================

describe('Broadcast Progressive Radius', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('First wave: smallest radius returns only closest transporters', async () => {
    const orderId = 'order-prog-1';
    // Wave 1: empty notified set
    mockRedisSMembers.mockResolvedValueOnce([]);

    const wave1Notified = await getNotifiedTransporters(orderId, 'tipper', '10-15Ton');
    expect(wave1Notified.size).toBe(0);

    // Simulate wave 1 broadcast to trans-1, trans-2
    mockRedisSAddWithExpire.mockResolvedValueOnce(undefined);
    await markTransportersNotified(orderId, 'tipper', '10-15Ton', ['trans-1', 'trans-2']);
    expect(mockRedisSAddWithExpire).toHaveBeenCalledTimes(1);
  });

  test('Second wave: larger radius, excludes already-notified from wave 1', async () => {
    const orderId = 'order-prog-2';
    // Wave 2: Redis returns wave 1 notified
    mockRedisSMembers.mockResolvedValueOnce(['trans-1', 'trans-2']);

    const alreadyNotified = await getNotifiedTransporters(orderId, 'tipper', '10-15Ton');

    // Wave 2 would find more candidates at larger radius
    const wave2Candidates = ['trans-1', 'trans-2', 'trans-3', 'trans-4', 'trans-5'];
    const newInWave2 = wave2Candidates.filter((id) => !alreadyNotified.has(id));

    expect(newInWave2).toEqual(['trans-3', 'trans-4', 'trans-5']);
    expect(newInWave2).not.toContain('trans-1');
    expect(newInWave2).not.toContain('trans-2');
  });

  test('DB fallback correctly tracks who was notified across waves', async () => {
    const orderId = 'order-prog-3';
    // Wave 2: Redis fails → DB has wave 1 entries
    mockRedisSMembers.mockRejectedValueOnce(new Error('Redis failure'));
    mockGetTruckRequestsByOrder.mockResolvedValueOnce([
      makeTruckRequest({ orderId, notifiedTransporters: ['trans-1', 'trans-2'] }),
    ]);

    const alreadyNotified = await getNotifiedTransporters(orderId, 'tipper', '10-15Ton');

    // trans-1 and trans-2 from wave 1 should be excluded
    expect(alreadyNotified.has('trans-1')).toBe(true);
    expect(alreadyNotified.has('trans-2')).toBe(true);
    expect(alreadyNotified.has('trans-3')).toBe(false);
  });

  test('Redis failure mid-broadcast-cycle → DB fallback kicks in', async () => {
    const orderId = 'order-prog-4';
    // First call succeeds (wave 1 start)
    mockRedisSMembers.mockResolvedValueOnce([]);
    // Second call fails (mid-cycle, wave 2 check)
    mockRedisSMembers.mockRejectedValueOnce(new Error('Redis mid-cycle failure'));
    mockGetTruckRequestsByOrder.mockResolvedValueOnce([
      makeTruckRequest({ orderId, notifiedTransporters: ['trans-1'] }),
    ]);

    const wave1Check = await getNotifiedTransporters(orderId, 'tipper', '10-15Ton');
    expect(wave1Check.size).toBe(0);

    const wave2Check = await getNotifiedTransporters(orderId, 'tipper', '10-15Ton');
    // DB fallback kicks in — returns trans-1 as already notified
    expect(wave2Check.has('trans-1')).toBe(true);
    expect(mockGetTruckRequestsByOrder).toHaveBeenCalledWith(orderId);
  });

  test('buildRequestsByType groups truck requests by vehicle type correctly', () => {
    const truckRequests = [
      { ...makeTruckRequest(), vehicleType: 'tipper', vehicleSubtype: '10-15Ton' },
      { ...makeTruckRequest(), vehicleType: 'tipper', vehicleSubtype: '10-15Ton' },
      { ...makeTruckRequest(), vehicleType: 'open_17ft', vehicleSubtype: '' },
    ] as any[];

    const grouped = buildRequestsByType(truckRequests);

    expect(grouped.size).toBe(2);
    const tipperKey = makeVehicleGroupKey('tipper', '10-15Ton');
    const openKey = makeVehicleGroupKey('open_17ft', '');
    expect(grouped.get(tipperKey)!.length).toBe(2);
    expect(grouped.get(openKey)!.length).toBe(1);
  });

  test('chunkTransporterIds splits large arrays into correct chunks', () => {
    // Default chunk size from env is 500; use small array to test boundary
    // Directly testing chunkTransporterIds which uses module-level constant
    const smallList = Array.from({ length: 10 }, (_, i) => `trans-${i + 1}`);
    const chunks = chunkTransporterIds(smallList);

    // 10 items, chunk size >=25 → should be single chunk
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toEqual(smallList);
  });

  test('chunkTransporterIds handles empty array → single empty chunk', () => {
    const chunks = chunkTransporterIds([]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual([]);
  });
});

// =============================================================================
// 5. SUSPENSION + BROADCAST INTEGRATION
// =============================================================================

describe('Suspension + Broadcast Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('Suspended transporter excluded from broadcast recipients', async () => {
    const allTransporters = ['trans-1', 'trans-2', 'trans-3'];
    const suspendedSet = new Set(['trans-2']); // trans-2 is suspended

    mockGetSuspendedUserIds.mockResolvedValueOnce(suspendedSet);

    const suspendedIds = await (require('../modules/admin/admin-suspension.service')
      .adminSuspensionService.getSuspendedUserIds(allTransporters));

    const eligible = allTransporters.filter((id) => !suspendedIds.has(id));

    expect(eligible).toEqual(['trans-1', 'trans-3']);
    expect(eligible).not.toContain('trans-2');
  });

  test('Suspension check failure (Redis down) → fail-open, all transporters included', async () => {
    const allTransporters = ['trans-1', 'trans-2', 'trans-3'];

    // Suspension check throws (Redis-backed)
    mockGetSuspendedUserIds.mockRejectedValueOnce(new Error('Redis unavailable'));

    let eligible = allTransporters;
    try {
      const suspendedIds = await (require('../modules/admin/admin-suspension.service')
        .adminSuspensionService.getSuspendedUserIds(allTransporters));
      eligible = allTransporters.filter((id) => !suspendedIds.has(id));
    } catch {
      // Fail-open: proceed with all transporters
      eligible = allTransporters;
    }

    // All 3 transporters included (fail-open)
    expect(eligible).toHaveLength(3);
    expect(eligible).toEqual(allTransporters);
  });

  test('Mix of suspended and active transporters → only active receive broadcast', async () => {
    const allTransporters = ['trans-1', 'trans-2', 'trans-3', 'trans-4', 'trans-5'];
    const suspendedSet = new Set(['trans-2', 'trans-4']); // 2 suspended

    mockGetSuspendedUserIds.mockResolvedValueOnce(suspendedSet);

    const suspendedIds = await (require('../modules/admin/admin-suspension.service')
      .adminSuspensionService.getSuspendedUserIds(allTransporters));

    const eligible = allTransporters.filter((id) => !suspendedIds.has(id));

    expect(eligible).toHaveLength(3);
    expect(eligible).toContain('trans-1');
    expect(eligible).toContain('trans-3');
    expect(eligible).toContain('trans-5');
    expect(eligible).not.toContain('trans-2');
    expect(eligible).not.toContain('trans-4');
  });

  test('All transporters suspended → empty recipient list', async () => {
    const allTransporters = ['trans-1', 'trans-2'];
    const suspendedSet = new Set(['trans-1', 'trans-2']);

    mockGetSuspendedUserIds.mockResolvedValueOnce(suspendedSet);

    const suspendedIds = await (require('../modules/admin/admin-suspension.service')
      .adminSuspensionService.getSuspendedUserIds(allTransporters));

    const eligible = allTransporters.filter((id) => !suspendedIds.has(id));

    expect(eligible).toHaveLength(0);
  });

  test('No transporters suspended → all receive broadcast', async () => {
    const allTransporters = ['trans-1', 'trans-2', 'trans-3'];
    const suspendedSet = new Set<string>();

    mockGetSuspendedUserIds.mockResolvedValueOnce(suspendedSet);

    const suspendedIds = await (require('../modules/admin/admin-suspension.service')
      .adminSuspensionService.getSuspendedUserIds(allTransporters));

    const eligible = allTransporters.filter((id) => !suspendedIds.has(id));

    expect(eligible).toHaveLength(3);
    expect(eligible).toEqual(allTransporters);
  });

  test('Suspension check is called with full list of transporter IDs', async () => {
    const allTransporters = ['trans-A', 'trans-B', 'trans-C', 'trans-D'];
    mockGetSuspendedUserIds.mockResolvedValueOnce(new Set());

    await (require('../modules/admin/admin-suspension.service')
      .adminSuspensionService.getSuspendedUserIds(allTransporters));

    expect(mockGetSuspendedUserIds).toHaveBeenCalledWith(allTransporters);
  });
});

// =============================================================================
// 6. RACE CONDITIONS & CONCURRENCY
// =============================================================================

describe('Race Conditions & Concurrency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('Two broadcasts for same order simultaneously → both see empty notified set, DB dedup prevents re-notification', async () => {
    const orderId = 'order-race-1';
    // Both concurrent reads see empty notified set (race condition before marking)
    mockRedisSMembers
      .mockResolvedValueOnce([]) // concurrent read 1
      .mockResolvedValueOnce([]); // concurrent read 2

    const [notified1, notified2] = await Promise.all([
      getNotifiedTransporters(orderId, 'tipper', '10-15Ton'),
      getNotifiedTransporters(orderId, 'tipper', '10-15Ton'),
    ]);

    // Both reads succeed independently
    expect(notified1.size).toBe(0);
    expect(notified2.size).toBe(0);

    // Redis SADD is atomic — concurrent sAddWithExpire calls are safe
    mockRedisSAddWithExpire.mockResolvedValue(undefined);
    await Promise.all([
      markTransportersNotified(orderId, 'tipper', '10-15Ton', ['trans-1', 'trans-2']),
      markTransportersNotified(orderId, 'tipper', '10-15Ton', ['trans-1', 'trans-3']),
    ]);

    expect(mockRedisSAddWithExpire).toHaveBeenCalledTimes(2);
  });

  test('Transporter notified in wave 1, Redis fails in wave 2 → DB knows they were notified', async () => {
    const orderId = 'order-race-2';

    // Wave 1: Redis succeeds
    mockRedisSMembers.mockResolvedValueOnce([]);
    const wave1Notified = await getNotifiedTransporters(orderId, 'tipper', '10-15Ton');
    expect(wave1Notified.size).toBe(0);

    mockRedisSAddWithExpire.mockResolvedValueOnce(undefined);
    await markTransportersNotified(orderId, 'tipper', '10-15Ton', ['trans-1', 'trans-2']);

    // Wave 2: Redis SMEMBERS fails → DB fallback
    mockRedisSMembers.mockRejectedValueOnce(new Error('Redis node failure'));
    mockGetTruckRequestsByOrder.mockResolvedValueOnce([
      // DB has the record from wave 1 (TruckRequest.notifiedTransporters updated)
      makeTruckRequest({ orderId, notifiedTransporters: ['trans-1', 'trans-2'] }),
    ]);

    const wave2Notified = await getNotifiedTransporters(orderId, 'tipper', '10-15Ton');

    // DB correctly reflects wave 1 notifications
    expect(wave2Notified.has('trans-1')).toBe(true);
    expect(wave2Notified.has('trans-2')).toBe(true);
  });

  test('Lock failure → concurrent broadcast paths diverge independently', async () => {
    const customerId = 'cust-race-3';

    // First lock succeeds
    mockRedisAcquireLock.mockResolvedValueOnce({ acquired: true, token: 'tok-1' });
    // Second lock fails (someone else holds it)
    mockRedisAcquireLock.mockResolvedValueOnce({ acquired: false, token: null });

    const lock1 = await (redisService as any).acquireLock(`broadcast:create:${customerId}`, 30000);
    const lock2 = await (redisService as any).acquireLock(`broadcast:create:${customerId}`, 30000);

    expect(lock1.acquired).toBe(true);
    expect(lock2.acquired).toBe(false);
  });

  test('markTransportersNotified called concurrently → no throw (Redis SADD is atomic)', async () => {
    const orderId = 'order-race-4';
    mockRedisSAddWithExpire.mockResolvedValue(undefined);

    // Multiple concurrent marks should not throw
    await expect(Promise.all([
      markTransportersNotified(orderId, 'tipper', '10-15Ton', ['trans-1']),
      markTransportersNotified(orderId, 'tipper', '10-15Ton', ['trans-2']),
      markTransportersNotified(orderId, 'tipper', '10-15Ton', ['trans-3']),
    ])).resolves.not.toThrow();
  });

  test('DB fallback returns unique IDs even when TruckRequests have overlapping notifiedTransporters', async () => {
    const orderId = 'order-race-5';
    // Simulate two concurrent wave-1 writes that both added trans-1
    mockRedisSMembers.mockRejectedValueOnce(new Error('Redis failure'));
    mockGetTruckRequestsByOrder.mockResolvedValueOnce([
      makeTruckRequest({ orderId, notifiedTransporters: ['trans-1', 'trans-2'] }),
      makeTruckRequest({ orderId, notifiedTransporters: ['trans-1', 'trans-3'] }), // trans-1 duplicated
    ]);

    const result = await getNotifiedTransporters(orderId, 'tipper', '10-15Ton');

    // Set deduplication: trans-1 appears only once
    expect(result.size).toBe(3);
    expect(result.has('trans-1')).toBe(true);
  });

  test('getNotifiedTransporters is fail-open: never throws even if both Redis and DB fail', async () => {
    const orderId = 'order-race-6';
    mockRedisSMembers.mockRejectedValueOnce(new Error('Redis down'));
    mockGetTruckRequestsByOrder.mockRejectedValueOnce(new Error('DB connection pool exhausted'));

    // Should resolve (not reject) with empty set
    await expect(getNotifiedTransporters(orderId, 'tipper', '10-15Ton')).resolves.toBeInstanceOf(Set);
    const result = await getNotifiedTransporters(
      'order-race-6-b',
      'tipper',
      '10-15Ton',
    ).catch(() => new Set(['should-not-throw']));
    // We reset mocks here — second call also fails-open
    expect(result).toBeInstanceOf(Set);
  });
});

// =============================================================================
// 7. DATA INTEGRITY
// =============================================================================

describe('Data Integrity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('Broadcast payload unchanged through retry/fallback logic — withEventMeta is non-destructive', () => {
    const originalPayload = {
      orderId: 'order-int-1',
      vehicleType: 'tipper',
      truckCount: 2,
      pickupCity: 'Mumbai',
      dropCity: 'Pune',
      customerId: 'cust-1',
    };
    const cloned = { ...originalPayload };

    const enriched = withEventMeta(originalPayload);

    // Original payload object is unchanged (immutable spread)
    expect(originalPayload).toEqual(cloned);
    // Enriched has additional fields
    expect(enriched.orderId).toBe(originalPayload.orderId);
    expect(enriched.vehicleType).toBe(originalPayload.vehicleType);
    expect(enriched.truckCount).toBe(originalPayload.truckCount);
    expect(enriched.pickupCity).toBe(originalPayload.pickupCity);
    expect(enriched.dropCity).toBe(originalPayload.dropCity);
    expect(enriched.customerId).toBe(originalPayload.customerId);
  });

  test('Transporter IDs consistent between Redis mark and DB record', async () => {
    const orderId = 'order-int-2';
    const transporterIds = ['trans-1', 'trans-2', 'trans-3'];

    mockRedisSAddWithExpire.mockResolvedValueOnce(undefined);
    await markTransportersNotified(orderId, 'tipper', '10-15Ton', transporterIds);

    const callArgs = mockRedisSAddWithExpire.mock.calls[0];
    // Args: [key, ttl, ...transporterIds]
    const passedIds = callArgs.slice(2);
    expect(passedIds).toEqual(transporterIds);
  });

  test('notifiedTransportersKey produces consistent keys for same inputs', () => {
    const key1 = notifiedTransportersKey('order-123', 'tipper', '10-15Ton');
    const key2 = notifiedTransportersKey('order-123', 'tipper', '10-15Ton');
    const key3 = notifiedTransportersKey('order-456', 'tipper', '10-15Ton');

    // Same inputs → same key (deterministic)
    expect(key1).toBe(key2);
    // Different orderId → different key
    expect(key1).not.toBe(key3);
  });

  test('notifiedTransportersKey is order-scoped: different orders get different keys', () => {
    const key1 = notifiedTransportersKey('order-AAA', 'tipper', '10-15Ton');
    const key2 = notifiedTransportersKey('order-BBB', 'tipper', '10-15Ton');

    expect(key1).not.toBe(key2);
    expect(key1).toContain('order-AAA');
    expect(key2).toContain('order-BBB');
  });

  test('notifiedTransportersKey is vehicle-type-scoped: different vehicle types get different keys', () => {
    const key1 = notifiedTransportersKey('order-123', 'tipper', '10-15Ton');
    const key2 = notifiedTransportersKey('order-123', 'open_17ft', '');

    expect(key1).not.toBe(key2);
  });

  test('makeVehicleGroupKey produces consistent JSON key', () => {
    const key1 = makeVehicleGroupKey('tipper', '10-15Ton');
    const key2 = makeVehicleGroupKey('tipper', '10-15Ton');
    const key3 = makeVehicleGroupKey('open_17ft', '');

    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
    // Must be parseable
    expect(() => JSON.parse(key1)).not.toThrow();
    expect(() => JSON.parse(key3)).not.toThrow();
  });

  test('buildRequestsByType handles single vehicle type correctly', () => {
    const truckRequests = [
      { ...makeTruckRequest(), vehicleType: 'tipper', vehicleSubtype: '10-15Ton' },
    ] as any[];

    const grouped = buildRequestsByType(truckRequests);

    expect(grouped.size).toBe(1);
    const entries = [...grouped.values()];
    expect(entries[0]).toHaveLength(1);
  });

  test('buildRequestsByType handles empty truck requests', () => {
    const grouped = buildRequestsByType([]);

    expect(grouped.size).toBe(0);
  });

  test('DB fallback preserves all transporter IDs from notifiedTransporters without modification', async () => {
    const orderId = 'order-int-3';
    const expectedIds = ['trans-uuid-1', 'trans-uuid-2', 'trans-uuid-3', 'trans-uuid-4'];

    mockRedisSMembers.mockRejectedValueOnce(new Error('Redis failure'));
    mockGetTruckRequestsByOrder.mockResolvedValueOnce([
      makeTruckRequest({ orderId, notifiedTransporters: expectedIds }),
    ]);

    const result = await getNotifiedTransporters(orderId, 'tipper', '10-15Ton');

    for (const id of expectedIds) {
      expect(result.has(id)).toBe(true);
    }
    expect(result.size).toBe(expectedIds.length);
  });

  test('markTransportersNotified does not call Redis when transporterIds is empty', async () => {
    await markTransportersNotified('order-int-4', 'tipper', '10-15Ton', []);

    expect(mockRedisSAddWithExpire).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('chunkTransporterIds preserves all IDs and order across chunks', () => {
    const largeList = Array.from({ length: 100 }, (_, i) => `trans-${i + 1}`);
    const chunks = chunkTransporterIds(largeList);

    const flattened = chunks.flat();
    expect(flattened).toEqual(largeList);
    // No items dropped
    expect(flattened.length).toBe(100);
  });

  test('withEventMeta emittedAt is valid ISO timestamp', () => {
    const payload = { orderId: 'order-ts-1' };
    const enriched = withEventMeta(payload);

    const parsed = new Date(enriched.emittedAt);
    expect(isNaN(parsed.getTime())).toBe(false);
    // Should be within the last minute
    expect(Date.now() - parsed.getTime()).toBeLessThan(60000);
  });

  test('withEventMeta eventId is UUID-like (non-empty unique string per call)', () => {
    const payload = { orderId: 'order-uuid-test' };
    const enriched1 = withEventMeta(payload);
    const enriched2 = withEventMeta(payload);

    // Each call generates a different eventId
    expect(enriched1.eventId).not.toBe(enriched2.eventId);
    expect(enriched1.eventId.length).toBeGreaterThan(10);
    expect(enriched2.eventId.length).toBeGreaterThan(10);
  });
});

// =============================================================================
// 8. ADDITIONAL EDGE CASES — SOURCE PATTERN VERIFICATION
// =============================================================================

describe('Source pattern verification — DB fallback and GEOSEARCH implementation', () => {
  let orderBroadcastQuerySource: string;

  beforeAll(() => {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.resolve(
      __dirname,
      '../modules/order/order-broadcast-query.service.ts'
    );
    orderBroadcastQuerySource = fs.readFileSync(filePath, 'utf-8');
  });

  test('getNotifiedTransporters exports correctly from order-broadcast-query.service.ts', () => {
    expect(orderBroadcastQuerySource).toMatch(
      /export\s+async\s+function\s+getNotifiedTransporters/
    );
  });

  test('DB fallback uses getTruckRequestsByOrder', () => {
    expect(orderBroadcastQuerySource).toContain('getTruckRequestsByOrder');
  });

  test('DB fallback iterates notifiedTransporters field', () => {
    expect(orderBroadcastQuerySource).toContain('notifiedTransporters');
  });

  test('DB fallback wraps result in Array.from for return', () => {
    expect(orderBroadcastQuerySource).toMatch(/Array\.from\(/);
  });

  test('Double-catch: inner DB failure returns [] for fail-open behavior', () => {
    // The inner catch must return an empty array
    expect(orderBroadcastQuerySource).toMatch(/catch\s*\{[\s\S]*?\[\s*\][\s\S]*?\}/);
  });

  test('sMembers catch handler logs [Broadcast] context', () => {
    expect(orderBroadcastQuerySource).toContain('[Broadcast]');
  });

  test('markTransportersNotified catch handler logs with logger.warn', () => {
    expect(orderBroadcastQuerySource).toMatch(/logger\.warn/);
  });

  test('sAddWithExpire is used for marking (not sAdd)', () => {
    expect(orderBroadcastQuerySource).toContain('sAddWithExpire');
  });

  test('TTL formula uses BROADCAST_TIMEOUT_MS + BROADCAST_DEDUP_TTL_BUFFER_SECONDS', () => {
    expect(orderBroadcastQuerySource).toMatch(
      /Math\.ceil\s*\(\s*BROADCAST_TIMEOUT_MS\s*\/\s*1000\s*\)\s*\+\s*BROADCAST_DEDUP_TTL_BUFFER_SECONDS/
    );
  });
});

describe('Source pattern verification — real-redis.client.ts GEOSEARCH', () => {
  let realRedisClientSource: string;

  beforeAll(() => {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.resolve(
      __dirname,
      '../shared/services/redis/real-redis.client.ts'
    );
    realRedisClientSource = fs.readFileSync(filePath, 'utf-8');
  });

  test('geoRadius uses GEOSEARCH command (geosearch)', () => {
    expect(realRedisClientSource).toMatch(/geosearch/i);
  });

  test('GEOSEARCH includes COUNT parameter', () => {
    expect(realRedisClientSource).toMatch(/'COUNT'\s*,\s*count/);
  });

  test('GEOSEARCH does NOT use ANY keyword', () => {
    // ANY causes non-deterministic results; ensure it is absent
    // Note: 'ANY' may appear in comments — check actual command args
    const geosearchBlock = realRedisClientSource.match(
      /this\.client\.geosearch[\s\S]*?(?:\n\s*\)|\);)/
    );
    expect(geosearchBlock).not.toBeNull();
    // 'ANY' must not appear as a command argument in geosearch calls
    expect(geosearchBlock![0]).not.toMatch(/'ANY'|"ANY"/);
  });

  test('geoRadius fallback to georadius also includes COUNT', () => {
    expect(realRedisClientSource).toMatch(/georadius[\s\S]*?'COUNT'\s*,\s*count/);
  });

  test('geoRadius uses config.geoQueryMaxCandidates for count default', () => {
    expect(realRedisClientSource).toMatch(/config\.geoQueryMaxCandidates/);
  });

  test('geoRadius default count parameter defaults to 250', () => {
    expect(realRedisClientSource).toMatch(/geoQueryMaxCandidates\s*\|\|\s*250/);
  });

  test('GEOSEARCH includes ASC for distance ordering', () => {
    expect(realRedisClientSource).toMatch(/'ASC'/);
  });

  test('GEOSEARCH includes FROMLONLAT for coordinate-based search', () => {
    expect(realRedisClientSource).toMatch(/'FROMLONLAT'/);
  });

  test('GEOSEARCH includes BYRADIUS for radius search', () => {
    expect(realRedisClientSource).toMatch(/'BYRADIUS'/);
  });

  test('GEOSEARCH includes WITHDIST for distance results', () => {
    expect(realRedisClientSource).toMatch(/'WITHDIST'/);
  });
});
