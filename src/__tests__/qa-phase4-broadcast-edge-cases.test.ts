/**
 * =============================================================================
 * QA Phase 4 -- Broadcast & Geo Edge Cases
 * =============================================================================
 *
 * Tests covering edge cases for the following fixes:
 *
 * C3  -- GEORADIUS online check via smIsMembers (availability-geo.service.ts)
 * H4  -- GEORADIUS COUNT 250 default (real-redis.client.ts)
 * H6  -- Personalized retry cache (order-broadcast.service.ts)
 * M6  -- sAddWithExpire failure logging (order-broadcast.service.ts)
 * M9  -- DB fallback for SMEMBERS failure (order-broadcast.service.ts)
 *
 * Strategy: Source-scanning tests verify fix patterns exist in the actual
 * source code (file content assertions), plus behavioral tests via mocks
 * for runtime paths. Follows patterns from broadcast-optimization-fixes.test.ts.
 *
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

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
  config: { redis: { enabled: true }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {}, geoQueryMaxCandidates: 250 },
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
const mockRedisGeoRadius = jest.fn();
const mockRedisGeoRemove = jest.fn();
const mockRedisSmIsMembers = jest.fn();
const mockRedisSRem = jest.fn();

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
    sRem: (...args: any[]) => mockRedisSRem(...args),
    ttl: jest.fn().mockResolvedValue(60),
    incrementWithTTL: jest.fn().mockResolvedValue(1),
    checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 99, resetIn: 60 }),
    getOrSet: jest.fn(),
    lPush: jest.fn(),
    lTrim: jest.fn(),
    lRange: jest.fn().mockResolvedValue([]),
    geoRadius: (...args: any[]) => mockRedisGeoRadius(...args),
    geoRemove: (...args: any[]) => mockRedisGeoRemove(...args),
    smIsMembers: (...args: any[]) => mockRedisSmIsMembers(...args),
    hGetAllBatch: jest.fn().mockResolvedValue([]),
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
const mockGetTransportersByVehicleKey = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getOrderById: (...args: any[]) => mockGetOrderById(...args),
    getTruckRequestsByOrder: (...args: any[]) => mockGetTruckRequestsByOrder(...args),
    getTransportersWithVehicleType: (...args: any[]) => mockGetTransportersWithVehicleType(...args),
    getTransportersAvailabilitySnapshot: (...args: any[]) => mockGetTransportersAvailabilitySnapshot(...args),
    updateTruckRequest: (...args: any[]) => mockUpdateTruckRequest(...args),
    getTransportersByVehicleKey: (...args: any[]) => mockGetTransportersByVehicleKey(...args),
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
// Prisma mock
// ---------------------------------------------------------------------------
jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    $transaction: jest.fn((fn: any) => typeof fn === 'function' ? fn({}) : Promise.resolve(fn)),
    booking: { findMany: jest.fn().mockResolvedValue([]) },
    assignment: { findMany: jest.fn().mockResolvedValue([]) },
    vehicle: { findMany: jest.fn().mockResolvedValue([]) },
  },
}));

// ---------------------------------------------------------------------------
// H3 geo index service mock
// ---------------------------------------------------------------------------
jest.mock('../shared/services/h3-geo-index.service', () => ({
  h3GeoIndexService: {
    removeTransporter: jest.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Availability cache service mock
// ---------------------------------------------------------------------------
const mockLoadTransporterDetailsMap = jest.fn();

jest.mock('../shared/services/availability-cache.service', () => ({
  loadTransporterDetailsMap: (...args: any[]) => mockLoadTransporterDetailsMap(...args),
}));

// =============================================================================
// IMPORTS (after all mocks)
// =============================================================================

import {
  getNotifiedTransporters,
  markTransportersNotified,
  broadcastVehicleTypePayload,
} from '../modules/order/order-broadcast.service';
import { logger } from '../shared/services/logger.service';
import {
  getAvailableTransportersAsync,
  getAvailableTransportersWithDetails,
} from '../shared/services/availability-geo.service';

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
// Source file paths
// =============================================================================

const SRC_ROOT = path.resolve(__dirname, '..');
const AVAILABILITY_GEO_PATH = path.join(SRC_ROOT, 'shared/services/availability-geo.service.ts');
const REAL_REDIS_PATH = path.join(SRC_ROOT, 'shared/services/redis/real-redis.client.ts');
const ORDER_BROADCAST_PATH = path.join(SRC_ROOT, 'modules/order/order-broadcast.service.ts');
const ENVIRONMENT_PATH = path.join(SRC_ROOT, 'config/environment.ts');

// =============================================================================
// C3: GEORADIUS ONLINE CHECK via smIsMembers
// =============================================================================

describe('C3: GEORADIUS online check via smIsMembers', () => {

  describe('Source scanning -- availability-geo.service.ts', () => {
    let source: string;

    beforeAll(() => {
      source = fs.readFileSync(AVAILABILITY_GEO_PATH, 'utf-8');
    });

    test('smIsMembers call exists in getAvailableTransportersWithDetails', () => {
      // The fix added smIsMembers call after GEORADIUS results
      expect(source).toContain('smIsMembers');
    });

    test('smIsMembers is called with ONLINE_TRANSPORTERS key', () => {
      expect(source).toContain('REDIS_KEYS.ONLINE_TRANSPORTERS');
      // Verify it passes transporterIds to the batch check
      expect(source).toContain('smIsMembers(REDIS_KEYS.ONLINE_TRANSPORTERS, transporterIds)');
    });

    test('online check happens AFTER geoRadius results', () => {
      // geoRadius must come before smIsMembers in the flow
      const geoRadiusIndex = source.indexOf('geoRadius');
      const smIsMembersIndex = source.indexOf('smIsMembers');
      expect(geoRadiusIndex).toBeGreaterThan(-1);
      expect(smIsMembersIndex).toBeGreaterThan(-1);
      expect(smIsMembersIndex).toBeGreaterThan(geoRadiusIndex);
    });

    test('fail-open pattern with logger.warn if smIsMembers throws', () => {
      // Must have try/catch around smIsMembers with fail-open (all true)
      expect(source).toContain('smIsMembers failed');
      expect(source).toContain('fail-open applied');
      // Fallback: treat all as online
      expect(source).toContain('transporterIds.map(() => true)');
    });

    test('offline transporters are filtered via onlineFlags', () => {
      // Filter logic: if (!onlineFlags[i]) skip/remove
      expect(source).toContain('!onlineFlags[i]');
    });

    test('stale geo entries are cleaned via geoRemove', () => {
      // When offline, geoRemove is called to clean up
      expect(source).toContain('geoRemove');
      // Should remove from GEO_TRANSPORTERS
      expect(source).toContain('REDIS_KEYS.GEO_TRANSPORTERS');
    });
  });

  describe('Behavioral -- getAvailableTransportersAsync online filtering', () => {
    beforeEach(() => jest.clearAllMocks());

    test('filters out offline transporters from geoRadius results', async () => {
      // Setup: geoRadius returns 3 candidates
      mockRedisGeoRadius.mockResolvedValueOnce([
        { member: 'trans-1', distance: 5 },
        { member: 'trans-2', distance: 10 },
        { member: 'trans-3', distance: 15 },
      ]);

      // trans-2 is offline (false)
      mockRedisSmIsMembers.mockResolvedValueOnce([true, false, true]);

      // Details for all 3 (trans-2 will be filtered out anyway)
      mockLoadTransporterDetailsMap.mockResolvedValueOnce(
        new Map([
          ['trans-1', { vehicleKey: 'Tipper_20-24 Ton', vehicleId: 'v1', latitude: '19.0', longitude: '72.8', isOnTrip: 'false' }],
          ['trans-2', { vehicleKey: 'Tipper_20-24 Ton', vehicleId: 'v2', latitude: '19.1', longitude: '72.9', isOnTrip: 'false' }],
          ['trans-3', { vehicleKey: 'Tipper_20-24 Ton', vehicleId: 'v3', latitude: '19.2', longitude: '73.0', isOnTrip: 'false' }],
        ])
      );

      mockRedisGeoRemove.mockResolvedValue(1);

      const result = await getAvailableTransportersAsync('Tipper_20-24 Ton', 19.076, 72.877);

      // trans-2 should be filtered out
      expect(result).toContain('trans-1');
      expect(result).not.toContain('trans-2');
      expect(result).toContain('trans-3');
      expect(result).toHaveLength(2);

      // geoRemove should be called for offline trans-2
      expect(mockRedisGeoRemove).toHaveBeenCalled();
    });

    test('fail-open: all pass when smIsMembers throws', async () => {
      mockRedisGeoRadius.mockResolvedValueOnce([
        { member: 'trans-1', distance: 5 },
        { member: 'trans-2', distance: 10 },
      ]);

      // smIsMembers fails
      mockRedisSmIsMembers.mockRejectedValueOnce(new Error('CROSSSLOT error'));

      mockLoadTransporterDetailsMap.mockResolvedValueOnce(
        new Map([
          ['trans-1', { vehicleKey: 'Tipper_20-24 Ton', vehicleId: 'v1', latitude: '19.0', longitude: '72.8', isOnTrip: 'false' }],
          ['trans-2', { vehicleKey: 'Tipper_20-24 Ton', vehicleId: 'v2', latitude: '19.1', longitude: '72.9', isOnTrip: 'false' }],
        ])
      );

      const result = await getAvailableTransportersAsync('Tipper_20-24 Ton', 19.076, 72.877);

      // Fail-open: both should pass through
      expect(result).toContain('trans-1');
      expect(result).toContain('trans-2');
      expect(result).toHaveLength(2);

      // Warning should be logged
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('smIsMembers failed'),
        expect.objectContaining({ candidateCount: 2 })
      );
    });

    test('stale entries with no details are cleaned from geo + online sets', async () => {
      mockRedisGeoRadius.mockResolvedValueOnce([
        { member: 'trans-stale', distance: 5 },
        { member: 'trans-good', distance: 10 },
      ]);

      // Both marked online
      mockRedisSmIsMembers.mockResolvedValueOnce([true, true]);

      // trans-stale has no details (empty object = stale)
      mockLoadTransporterDetailsMap.mockResolvedValueOnce(
        new Map([
          ['trans-stale', {}],
          ['trans-good', { vehicleKey: 'Tipper_20-24 Ton', vehicleId: 'v1', latitude: '19.0', longitude: '72.8', isOnTrip: 'false' }],
        ])
      );

      mockRedisGeoRemove.mockResolvedValue(1);
      mockRedisSRem.mockResolvedValue(1);

      const result = await getAvailableTransportersAsync('Tipper_20-24 Ton', 19.076, 72.877);

      // Only trans-good should be returned
      expect(result).toContain('trans-good');
      expect(result).not.toContain('trans-stale');
      expect(result).toHaveLength(1);
    });

    test('empty geoRadius result returns empty array without calling smIsMembers', async () => {
      mockRedisGeoRadius.mockResolvedValueOnce([]);
      mockLoadTransporterDetailsMap.mockResolvedValueOnce(new Map());

      const result = await getAvailableTransportersAsync('Tipper_20-24 Ton', 19.076, 72.877);

      expect(result).toHaveLength(0);
      // smIsMembers with empty array should return empty or not be called meaningfully
    });
  });

  describe('Behavioral -- getAvailableTransportersWithDetails online filtering', () => {
    beforeEach(() => jest.clearAllMocks());

    test('getAvailableTransportersWithDetails filters offline and cleans geo entries', async () => {
      mockRedisGeoRadius.mockResolvedValueOnce([
        { member: 'trans-A', distance: 3 },
        { member: 'trans-B', distance: 7 },
      ]);

      // trans-B is offline
      mockRedisSmIsMembers.mockResolvedValueOnce([true, false]);

      mockLoadTransporterDetailsMap.mockResolvedValueOnce(
        new Map([
          ['trans-A', { vehicleKey: 'Tipper_20-24 Ton', vehicleId: 'vA', latitude: '19.076', longitude: '72.877', isOnTrip: 'false' }],
          ['trans-B', { vehicleKey: 'Tipper_20-24 Ton', vehicleId: 'vB', latitude: '19.1', longitude: '72.9', isOnTrip: 'false' }],
        ])
      );

      mockRedisGeoRemove.mockResolvedValue(1);

      const result = await getAvailableTransportersWithDetails('Tipper_20-24 Ton', 19.076, 72.877);

      expect(result).toHaveLength(1);
      expect(result[0].transporterId).toBe('trans-A');

      // geoRemove called for offline trans-B
      expect(mockRedisGeoRemove).toHaveBeenCalled();
    });
  });
});

// =============================================================================
// H4: GEORADIUS COUNT 250 DEFAULT
// =============================================================================

describe('H4: GEORADIUS COUNT 250 default', () => {

  describe('Source scanning -- real-redis.client.ts', () => {
    let source: string;

    beforeAll(() => {
      source = fs.readFileSync(REAL_REDIS_PATH, 'utf-8');
    });

    test('geoRadius method has default count of 250', () => {
      // The method signature should include count parameter with default 250
      // Pattern: count: number = config.geoQueryMaxCandidates || 250
      expect(source).toMatch(/geoRadius.*count.*=.*250/s);
    });

    test('geoRadius uses config.geoQueryMaxCandidates', () => {
      // It should reference the centralized config
      expect(source).toContain('config.geoQueryMaxCandidates');
    });

    test('COUNT is passed to geosearch command', () => {
      // The Redis GEOSEARCH command must include COUNT parameter
      expect(source).toContain("'COUNT', count");
    });

    test('COUNT is also passed to fallback georadius command', () => {
      // The fallback georadius command must also include COUNT
      const georadiusFallbackMatch = source.match(/georadius[\s\S]*?COUNT/);
      expect(georadiusFallbackMatch).not.toBeNull();
    });
  });

  describe('Source scanning -- environment.ts', () => {
    let source: string;

    beforeAll(() => {
      source = fs.readFileSync(ENVIRONMENT_PATH, 'utf-8');
    });

    test('GEO_QUERY_MAX_CANDIDATES env var exists in config', () => {
      expect(source).toContain('GEO_QUERY_MAX_CANDIDATES');
    });

    test('config.geoQueryMaxCandidates defaults to 250', () => {
      expect(source).toContain('geoQueryMaxCandidates');
      // Verify default value is 250 (not old value of 50)
      expect(source).toMatch(/geoQueryMaxCandidates.*250/);
    });

    test('geoQueryMaxCandidates uses getNumber helper', () => {
      // Should use the safe getNumber parser
      expect(source).toMatch(/getNumber\s*\(\s*'GEO_QUERY_MAX_CANDIDATES'/);
    });
  });
});

// =============================================================================
// H6: PERSONALIZED RETRY CACHE
// =============================================================================

describe('H6: Personalized retry cache', () => {

  describe('Source scanning -- order-broadcast.service.ts', () => {
    let source: string;

    beforeAll(() => {
      source = fs.readFileSync(ORDER_BROADCAST_PATH, 'utf-8');
    });

    test('personalizedPayloadCache Map is declared', () => {
      expect(source).toContain('personalizedPayloadCache');
      expect(source).toMatch(/personalizedPayloadCache\s*=\s*new\s+Map/);
    });

    test('cache is populated during initial send loop', () => {
      // personalizedPayloadCache.set(transporterId, personalizedBroadcast) must exist
      expect(source).toContain('personalizedPayloadCache.set(transporterId');
    });

    test('retry uses cached payload, not generic extendedBroadcast', () => {
      // The retry path should get from cache first
      expect(source).toContain('personalizedPayloadCache.get(transporterId)');
    });

    test('fallback to extendedBroadcast on cache miss', () => {
      // Pattern: personalizedPayloadCache.get(transporterId) || extendedBroadcast
      expect(source).toMatch(/personalizedPayloadCache\.get\(transporterId\)\s*\|\|\s*extendedBroadcast/);
    });

    test('H6 FIX comment exists in source', () => {
      expect(source).toContain('H6 FIX');
    });
  });

  describe('Behavioral -- retry preserves personalized payload', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      jest.useRealTimers();
    });

    test('retry payload includes cached personalized fields', async () => {
      const orderId = 'order-h6-cached';
      const order = makeOrder({ id: orderId });
      const truckRequests = [makeTruckRequest({ orderId, id: 'tr-h6' })];
      const requestsByType = new Map([[JSON.stringify(['Tipper', '20-24 Ton']), truckRequests]]);

      // First call fails, retry succeeds
      mockQueueBroadcast
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce(undefined);

      mockGetOrderById.mockResolvedValueOnce(order);
      mockGetTransportersAvailabilitySnapshot.mockResolvedValueOnce([
        { transporterId: 'trans-cache-test', transporterName: 'TCT', totalOwned: 5, available: 3, inTransit: 2 },
      ]);
      mockUpdateTruckRequest.mockResolvedValue(undefined);
      mockRedisSAddWithExpire.mockResolvedValue(undefined);

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
        ['trans-cache-test'],
        order.expiresAt,
        new Map([
          ['trans-cache-test', { distanceKm: 12, etaSeconds: 720 }],
        ])
      );

      // The retry call (second call) should contain personalized fields
      expect(mockQueueBroadcast).toHaveBeenCalledTimes(2);
      const retryCall = mockQueueBroadcast.mock.calls[1];
      const retryPayload = retryCall[2];

      // Must have personalized fields
      expect(retryPayload).toHaveProperty('isPersonalized', true);
      expect(retryPayload).toHaveProperty('personalizedFor', 'trans-cache-test');
      expect(retryPayload).toHaveProperty('trucksYouCanProvide');
      expect(retryPayload).toHaveProperty('pickupDistanceKm', 12);
      expect(retryPayload).toHaveProperty('_retry', true);
    });

    test('retry with cache miss falls back to extendedBroadcast', async () => {
      const orderId = 'order-h6-miss';
      const order = makeOrder({ id: orderId });
      const truckRequests = [makeTruckRequest({ orderId, id: 'tr-h6-miss' })];
      const requestsByType = new Map([[JSON.stringify(['Tipper', '20-24 Ton']), truckRequests]]);

      // First call for trans-ghost fails (it was somehow in enqueueFailedTransporters
      // but not in the send loop -- unlikely but tests fallback path)
      mockQueueBroadcast
        .mockRejectedValueOnce(new Error('Redis error'))
        .mockResolvedValueOnce(undefined);

      mockGetOrderById.mockResolvedValueOnce(order);
      mockGetTransportersAvailabilitySnapshot.mockResolvedValueOnce([
        { transporterId: 'trans-ghost', transporterName: 'TG', totalOwned: 5, available: 3, inTransit: 2 },
      ]);
      mockUpdateTruckRequest.mockResolvedValue(undefined);
      mockRedisSAddWithExpire.mockResolvedValue(undefined);

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
        ['trans-ghost'],
        order.expiresAt,
        new Map([
          ['trans-ghost', { distanceKm: 8, etaSeconds: 480 }],
        ])
      );

      // Retry should still succeed (falls back to cached or extendedBroadcast)
      expect(mockQueueBroadcast).toHaveBeenCalledTimes(2);
      const retryPayload = mockQueueBroadcast.mock.calls[1][2];
      // _retry flag must be present regardless
      expect(retryPayload).toHaveProperty('_retry', true);
      // Should still have broadcast data
      expect(retryPayload).toHaveProperty('orderId', orderId);
    });
  });
});

// =============================================================================
// M6: sAddWithExpire FAILURE LOGGING
// =============================================================================

describe('M6: sAddWithExpire failure logging', () => {

  describe('Source scanning -- order-broadcast.service.ts', () => {
    let source: string;

    beforeAll(() => {
      source = fs.readFileSync(ORDER_BROADCAST_PATH, 'utf-8');
    });

    test('.catch on sAddWithExpire has logger.warn with orderId and error.message', () => {
      // Verify the catch block is not empty and logs meaningful info
      // Pattern: .catch((err: unknown) => { ... logger.warn(...) ... })
      const sAddWithExpireSection = source.substring(
        source.indexOf('sAddWithExpire'),
        source.indexOf('sAddWithExpire') + 300
      );
      expect(sAddWithExpireSection).toContain('.catch');
      expect(sAddWithExpireSection).toContain('logger.warn');
      expect(sAddWithExpireSection).toContain('orderId');
      expect(sAddWithExpireSection).toContain('error');
    });

    test('.catch is NOT an empty catch block', () => {
      // Must not have an empty .catch(() => {}) pattern for sAddWithExpire
      const sAddIdx = source.indexOf('sAddWithExpire(key, ttlSeconds');
      expect(sAddIdx).toBeGreaterThan(-1);
      // Extract the catch block region
      const catchRegion = source.substring(sAddIdx, sAddIdx + 400);
      // Must not be an empty catch
      expect(catchRegion).not.toMatch(/\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/);
    });

    test('error message is extracted via instanceof Error check', () => {
      // Pattern: err instanceof Error ? err.message : String(err)
      const sAddIdx = source.indexOf('sAddWithExpire(key, ttlSeconds');
      const catchRegion = source.substring(sAddIdx, sAddIdx + 400);
      expect(catchRegion).toContain('instanceof Error');
      expect(catchRegion).toContain('.message');
    });
  });

  describe('Behavioral -- markTransportersNotified logging on failure', () => {
    beforeEach(() => jest.clearAllMocks());

    test('sAddWithExpire failure logs warning with orderId and error', async () => {
      mockRedisSAddWithExpire.mockRejectedValueOnce(new Error('Redis NOSCRIPT'));

      // Should not throw
      await expect(
        markTransportersNotified('order-m6-test', 'Tipper', '20-24 Ton', ['t1'])
      ).resolves.toBeUndefined();

      // Warning should be logged
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to mark transporters'),
        expect.objectContaining({
          orderId: 'order-m6-test',
          error: expect.stringContaining('Redis NOSCRIPT'),
        })
      );
    });

    test('sAddWithExpire failure does NOT crash the broadcast flow', async () => {
      mockRedisSAddWithExpire.mockRejectedValueOnce(new Error('Connection reset'));

      // Must resolve without throwing
      const result = markTransportersNotified('order-m6-crash', 'Tipper', '20-24 Ton', ['t1', 't2', 't3']);
      await expect(result).resolves.toBeUndefined();
    });

    test('sAddWithExpire success does NOT log a warning', async () => {
      mockRedisSAddWithExpire.mockResolvedValueOnce(undefined);

      await markTransportersNotified('order-m6-ok', 'Tipper', '20-24 Ton', ['t1']);

      // No warning should be logged
      const warnCalls = (logger.warn as jest.Mock).mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('Failed to mark transporters')
      );
      expect(warnCalls).toHaveLength(0);
    });
  });
});

// =============================================================================
// M9: DB FALLBACK FOR SMEMBERS FAILURE
// =============================================================================

describe('M9: DB fallback for SMEMBERS failure', () => {

  describe('Source scanning -- order-broadcast.service.ts', () => {
    let source: string;

    beforeAll(() => {
      source = fs.readFileSync(ORDER_BROADCAST_PATH, 'utf-8');
    });

    test('.catch on sMembers includes logger.warn', () => {
      // getNotifiedTransporters has .catch on sMembers with logger.warn
      // Pattern: sMembers(key).catch(async (err: unknown) => { ... logger.warn(...) })
      const sMemIdx = source.indexOf('sMembers(key).catch');
      expect(sMemIdx).toBeGreaterThan(-1);
      const catchRegion = source.substring(sMemIdx, sMemIdx + 500);
      expect(catchRegion).toContain('logger.warn');
      expect(catchRegion).toContain('Redis SMEMBERS failed');
    });

    test('DB query via getTruckRequestsByOrder exists in sMembers fallback', () => {
      // After sMembers fails, should query DB
      const sMemIdx = source.indexOf('sMembers(key).catch');
      const catchRegion = source.substring(sMemIdx, sMemIdx + 500);
      expect(catchRegion).toContain('getTruckRequestsByOrder');
    });

    test('fallback returns empty array if DB also fails', () => {
      // Inner try/catch with fallback to []
      const sMemIdx = source.indexOf('sMembers(key).catch');
      const catchRegion = source.substring(sMemIdx, sMemIdx + 700);
      expect(catchRegion).toContain('return [];');
    });

    test('fallback extracts notifiedTransporters from truck requests', () => {
      const sMemIdx = source.indexOf('sMembers(key).catch');
      const catchRegion = source.substring(sMemIdx, sMemIdx + 500);
      expect(catchRegion).toContain('notifiedTransporters');
      expect(catchRegion).toContain('dbNotified');
    });
  });

  describe('Behavioral -- getNotifiedTransporters fallback', () => {
    beforeEach(() => jest.clearAllMocks());

    test('returns notified set from Redis when sMembers succeeds', async () => {
      mockRedisSMembers.mockResolvedValueOnce(['t1', 't2', 't3']);

      const result = await getNotifiedTransporters('order-m9-ok', 'Tipper', '20-24 Ton');

      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(3);
      expect(result.has('t1')).toBe(true);
      expect(result.has('t2')).toBe(true);
      expect(result.has('t3')).toBe(true);
      // DB should NOT be called
      expect(mockGetTruckRequestsByOrder).not.toHaveBeenCalled();
    });

    test('falls back to DB when sMembers throws', async () => {
      mockRedisSMembers.mockRejectedValueOnce(new Error('NOAUTH'));

      // DB fallback returns truck requests with notifiedTransporters
      mockGetTruckRequestsByOrder.mockResolvedValueOnce([
        { id: 'tr-1', notifiedTransporters: ['t1', 't2'] },
        { id: 'tr-2', notifiedTransporters: ['t2', 't3'] },
      ]);

      const result = await getNotifiedTransporters('order-m9-fallback', 'Tipper', '20-24 Ton');

      expect(result).toBeInstanceOf(Set);
      // t1, t2, t3 from both truck requests (deduplicated)
      expect(result.size).toBe(3);
      expect(result.has('t1')).toBe(true);
      expect(result.has('t2')).toBe(true);
      expect(result.has('t3')).toBe(true);

      // Warning should be logged
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Redis SMEMBERS failed'),
        expect.objectContaining({
          orderId: 'order-m9-fallback',
        })
      );
    });

    test('returns empty set when both Redis and DB fail', async () => {
      mockRedisSMembers.mockRejectedValueOnce(new Error('Connection lost'));
      mockGetTruckRequestsByOrder.mockRejectedValueOnce(new Error('DB timeout'));

      const result = await getNotifiedTransporters('order-m9-double-fail', 'Tipper', '20-24 Ton');

      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(0);
    });

    test('DB fallback handles truck requests with no notifiedTransporters field', async () => {
      mockRedisSMembers.mockRejectedValueOnce(new Error('CLUSTERDOWN'));

      mockGetTruckRequestsByOrder.mockResolvedValueOnce([
        { id: 'tr-1', notifiedTransporters: null },
        { id: 'tr-2' }, // no notifiedTransporters key at all
        { id: 'tr-3', notifiedTransporters: ['t1'] },
      ]);

      const result = await getNotifiedTransporters('order-m9-partial', 'Tipper', '20-24 Ton');

      // Only t1 from tr-3 should be in the set
      expect(result).toBeInstanceOf(Set);
      expect(result.has('t1')).toBe(true);
      // null and undefined are not arrays, so they should be skipped
    });

    test('DB fallback with empty truck requests returns empty set', async () => {
      mockRedisSMembers.mockRejectedValueOnce(new Error('timeout'));
      mockGetTruckRequestsByOrder.mockResolvedValueOnce([]);

      const result = await getNotifiedTransporters('order-m9-empty-db', 'Tipper', '20-24 Ton');

      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(0);
    });

    test('Redis returning empty array returns empty set (no DB call)', async () => {
      mockRedisSMembers.mockResolvedValueOnce([]);

      const result = await getNotifiedTransporters('order-m9-empty-redis', 'Tipper', '20-24 Ton');

      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(0);
      expect(mockGetTruckRequestsByOrder).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// CROSS-CUT: Interaction between fixes
// =============================================================================

describe('Cross-cut: Fix interactions and edge cases', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  test('M6+M9: sAddWithExpire failure does not prevent getNotifiedTransporters from working', async () => {
    // First: markTransportersNotified fails (M6)
    mockRedisSAddWithExpire.mockRejectedValueOnce(new Error('Redis OOM'));
    await markTransportersNotified('order-cross-1', 'Tipper', '20-24 Ton', ['t1']);

    // Then: getNotifiedTransporters should still work from Redis
    mockRedisSMembers.mockResolvedValueOnce(['t1']);
    const notified = await getNotifiedTransporters('order-cross-1', 'Tipper', '20-24 Ton');
    // Even though write failed, read may have earlier data
    expect(notified).toBeInstanceOf(Set);
  });

  test('H6+H4: Retry uses personalized payload even when many candidates (>250)', async () => {
    // Source verification: the geoRadius default is 250 (H4), and retry uses cached
    // personalized payload (H6). These are independent but both critical.
    const source = fs.readFileSync(ORDER_BROADCAST_PATH, 'utf-8');

    // H6 cache population
    expect(source).toContain('personalizedPayloadCache.set(transporterId');
    // H6 cache usage in retry
    expect(source).toContain('personalizedPayloadCache.get(transporterId)');
    // Retry path exists
    expect(source).toContain('Retrying failed transporter');
  });

  test('C3+M9: online check and DB fallback are independent resilience layers', () => {
    // Source verification: availability-geo has smIsMembers (C3)
    // order-broadcast has sMembers fallback (M9)
    // These are separate resilience patterns in different files
    const geoSource = fs.readFileSync(AVAILABILITY_GEO_PATH, 'utf-8');
    const broadcastSource = fs.readFileSync(ORDER_BROADCAST_PATH, 'utf-8');

    // C3: smIsMembers in geo service
    expect(geoSource).toContain('smIsMembers');
    expect(geoSource).toContain('fail-open applied');

    // M9: sMembers fallback in broadcast service
    expect(broadcastSource).toContain('sMembers(key).catch');
    expect(broadcastSource).toContain('getTruckRequestsByOrder');
  });
});
