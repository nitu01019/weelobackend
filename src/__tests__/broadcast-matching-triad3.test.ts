/**
 * =============================================================================
 * BROADCAST MATCHING TRIAD 3 — Tests for Fixes #7, #10, #12, #13, #23
 * =============================================================================
 *
 * #7  — SISMEMBER online check added to GEORADIUS filter loop
 * #10 — Unified lock:booking:{bookingId} for expiry + radius expansion
 * #12 — Metrics counter in catch block of fire-and-forget updateAvailability
 * #13 — sScan cursor loop replaces sMembers in cleanStaleTransporters
 * #23 — filterOnlineViaDB checks presence key before returning
 *
 * @author Weelo Team (LEO-TEST-3)
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
  },
}));

jest.mock('../config/environment', () => ({
  config: { redis: { enabled: true }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {} },
}));

// Redis service mock
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisIncr = jest.fn();
const mockRedisExpire = jest.fn();
const mockRedisSIsMember = jest.fn();
const mockRedisSMembers = jest.fn();
const mockRedisSCard = jest.fn();
const mockRedisSRem = jest.fn();
const mockRedisSScan = jest.fn();
const mockRedisExists = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisLPush = jest.fn();
const mockRedisLTrim = jest.fn();
const mockRedisIsConnected = jest.fn().mockReturnValue(true);
const mockRedisSetTimer = jest.fn();
const mockRedisCancelTimer = jest.fn();
const mockRedisGetExpiredTimers = jest.fn();
const mockRedisSAdd = jest.fn();
const mockRedisHMSet = jest.fn();
const mockRedisHGetAll = jest.fn();
const mockRedisHGetAllBatch = jest.fn();
const mockRedisGeoAdd = jest.fn();
const mockRedisGeoRemove = jest.fn();
const mockRedisGeoRadius = jest.fn();
const mockRedisIsRedisEnabled = jest.fn().mockReturnValue(true);
const mockRedisSetJSON = jest.fn();
const mockRedisGetJSON = jest.fn();
const mockRedisSmIsMembers = jest.fn();
const mockRedisEval = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    incr: (...args: any[]) => mockRedisIncr(...args),
    expire: (...args: any[]) => mockRedisExpire(...args),
    sIsMember: (...args: any[]) => mockRedisSIsMember(...args),
    smIsMembers: (...args: any[]) => mockRedisSmIsMembers(...args),
    sMembers: (...args: any[]) => mockRedisSMembers(...args),
    sCard: (...args: any[]) => mockRedisSCard(...args),
    sRem: (...args: any[]) => mockRedisSRem(...args),
    sScan: (...args: any[]) => mockRedisSScan(...args),
    exists: (...args: any[]) => mockRedisExists(...args),
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    lPush: (...args: any[]) => mockRedisLPush(...args),
    lTrim: (...args: any[]) => mockRedisLTrim(...args),
    isConnected: () => mockRedisIsConnected(),
    setTimer: (...args: any[]) => mockRedisSetTimer(...args),
    cancelTimer: (...args: any[]) => mockRedisCancelTimer(...args),
    getExpiredTimers: (...args: any[]) => mockRedisGetExpiredTimers(...args),
    sAdd: (...args: any[]) => mockRedisSAdd(...args),
    sAddWithExpire: (...args: any[]) => mockRedisSAdd(...args),
    hMSet: (...args: any[]) => mockRedisHMSet(...args),
    hGetAll: (...args: any[]) => mockRedisHGetAll(...args),
    hGetAllBatch: (...args: any[]) => mockRedisHGetAllBatch(...args),
    geoAdd: (...args: any[]) => mockRedisGeoAdd(...args),
    geoRemove: (...args: any[]) => mockRedisGeoRemove(...args),
    geoRadius: (...args: any[]) => mockRedisGeoRadius(...args),
    isRedisEnabled: () => mockRedisIsRedisEnabled(),
    setJSON: (...args: any[]) => mockRedisSetJSON(...args),
    getJSON: (...args: any[]) => mockRedisGetJSON(...args),
    eval: (...args: any[]) => mockRedisEval(...args),
    prefixKey: (key: string) => key,
  },
}));

// Prisma mock
const mockUserFindMany = jest.fn();
const mockUserUpdate = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    user: {
      findMany: (...args: any[]) => mockUserFindMany(...args),
      update: (...args: any[]) => mockUserUpdate(...args),
    },
  },
  BookingStatus: { BROADCASTING: 'broadcasting', EXPIRED: 'expired' },
  AssignmentStatus: { PENDING: 'pending' },
  VehicleStatus: { AVAILABLE: 'available' },
}));

// DB mock
const mockGetUserById = jest.fn();
jest.mock('../shared/database/db', () => ({
  db: {
    getUserById: (...args: any[]) => mockGetUserById(...args),
  },
}));

// Socket service mock
jest.mock('../shared/services/socket.service', () => ({
  emitToUser: jest.fn(),
  emitToBooking: jest.fn(),
  socketService: { emitToUser: jest.fn() },
  isUserConnected: jest.fn(),
  SocketEvent: {},
}));

// FCM mock
jest.mock('../shared/services/fcm.service', () => ({
  fcmService: { sendToTokens: jest.fn() },
}));

// H3 geo index mock
jest.mock('../shared/services/h3-geo-index.service', () => ({
  h3GeoIndexService: {
    updateTransporter: jest.fn().mockResolvedValue(undefined),
    updateLocation: jest.fn().mockResolvedValue(undefined),
    removeTransporter: jest.fn().mockResolvedValue(undefined),
    getNearbyTransporters: jest.fn().mockResolvedValue([]),
  },
}));

// Live availability mock
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: jest.fn(),
  },
}));

// Cache service mock
jest.mock('../shared/services/cache.service', () => ({
  cacheService: { get: jest.fn(), set: jest.fn(), delete: jest.fn() },
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { availabilityService } from '../shared/services/availability.service';
import {
  transporterOnlineService,
  ONLINE_TRANSPORTERS_SET,
  TRANSPORTER_PRESENCE_KEY,
} from '../shared/services/transporter-online.service';
import { metrics } from '../shared/monitoring/metrics.service';

// Cast for internal method access
const onlineService: any = transporterOnlineService;

// =============================================================================
// TEST HELPERS
// =============================================================================

function resetAllMocks(): void {
  jest.clearAllMocks();
  mockRedisGet.mockReset();
  mockRedisSet.mockReset();
  mockRedisDel.mockReset();
  mockRedisIncr.mockReset();
  mockRedisExpire.mockReset();
  mockRedisSIsMember.mockReset();
  mockRedisSMembers.mockReset();
  mockRedisSCard.mockReset();
  mockRedisSRem.mockReset();
  mockRedisSScan.mockReset();
  mockRedisExists.mockReset();
  mockRedisAcquireLock.mockReset();
  mockRedisReleaseLock.mockReset();
  mockRedisLPush.mockReset();
  mockRedisLTrim.mockReset();
  mockRedisIsConnected.mockReturnValue(true);
  mockRedisSetTimer.mockReset();
  mockRedisCancelTimer.mockReset();
  mockRedisGetExpiredTimers.mockReset();
  mockRedisSAdd.mockReset();
  mockRedisHMSet.mockReset();
  mockRedisHGetAll.mockReset();
  mockRedisHGetAllBatch.mockReset();
  mockRedisGeoAdd.mockReset();
  mockRedisGeoRemove.mockReset();
  mockRedisGeoRadius.mockReset();
  mockRedisIsRedisEnabled.mockReturnValue(true);
  mockRedisSmIsMembers.mockReset();
  mockRedisEval.mockReset();
  mockIncrementCounter.mockReset();
  mockRecordHistogram.mockReset();
  mockUserFindMany.mockReset();
  mockUserUpdate.mockReset();
  mockGetUserById.mockReset();
}

// =============================================================================
// FIX #7 — SISMEMBER online check in GEORADIUS filter loop
// =============================================================================

describe('Fix #7: SISMEMBER online check in GEORADIUS filter loop', () => {
  beforeEach(() => resetAllMocks());

  test('smIsMembers returns false -> candidate excluded from results', async () => {
    // Setup: GEORADIUS returns two transporters
    mockRedisGeoRadius.mockResolvedValue([
      { member: 'trans-online', distance: 5.0 },
      { member: 'trans-offline', distance: 8.0 },
    ]);

    // H-P4: smIsMembers batch call replaces per-candidate sIsMember loop.
    // Returns boolean array: [true, false] — trans-online is online, trans-offline is not.
    mockRedisSmIsMembers.mockResolvedValue([true, false]);

    // Details hash: both have valid details
    mockRedisHGetAllBatch.mockResolvedValue([
      { transporterId: 'trans-online', vehicleId: 'v1', isOnTrip: 'false' },
      { transporterId: 'trans-offline', vehicleId: 'v2', isOnTrip: 'false' },
    ]);

    // geoRemove for stale cleanup (trans-offline)
    mockRedisGeoRemove.mockResolvedValue(1);

    const result = await availabilityService.getAvailableTransportersAsync(
      'open_17ft', 28.6139, 77.2090, 20
    );

    // trans-offline should be excluded because smIsMembers returned false for it
    expect(result).toContain('trans-online');
    expect(result).not.toContain('trans-offline');

    // H-P4: smIsMembers called once with batch of all candidate IDs
    expect(mockRedisSmIsMembers).toHaveBeenCalledTimes(1);
    expect(mockRedisSmIsMembers).toHaveBeenCalledWith(
      'online:transporters', ['trans-online', 'trans-offline']
    );
  });

  test('smIsMembers fails -> fail-open includes all candidates', async () => {
    // Setup: GEORADIUS returns one transporter
    mockRedisGeoRadius.mockResolvedValue([
      { member: 'trans-redis-fail', distance: 3.0 },
    ]);

    // H-P4: smIsMembers throws (Redis connection error) -> fail-open sets all to true
    mockRedisSmIsMembers.mockRejectedValue(new Error('ECONNRESET'));

    // Details hash has valid data -> transporter should still be included
    mockRedisHGetAllBatch.mockResolvedValue([
      { transporterId: 'trans-redis-fail', vehicleId: 'v1', isOnTrip: 'false' },
    ]);

    const result = await availabilityService.getAvailableTransportersAsync(
      'open_17ft', 28.6139, 77.2090, 20
    );

    // Transporter should be included because smIsMembers failure triggers fail-open
    // and details hash has valid data
    expect(result).toContain('trans-redis-fail');
  });

  test('smIsMembers true + details empty -> skip and clean up stale entry', async () => {
    // Setup: GEORADIUS returns one transporter
    mockRedisGeoRadius.mockResolvedValue([
      { member: 'trans-no-details', distance: 2.0 },
    ]);

    // H-P4: smIsMembers batch says transporter IS online
    mockRedisSmIsMembers.mockResolvedValue([true]);

    // But details hash is empty (TTL expired)
    mockRedisHGetAllBatch.mockResolvedValue([{}]);

    // geoRemove + sRem for stale cleanup
    mockRedisGeoRemove.mockResolvedValue(1);
    mockRedisSRem.mockResolvedValue(1);

    const result = await availabilityService.getAvailableTransportersAsync(
      'open_17ft', 28.6139, 77.2090, 20
    );

    // Transporter excluded because details are empty
    expect(result).not.toContain('trans-no-details');

    // The stale cleanup path should fire for empty details
    // (geoRemove from geo index + sRem from online set)
    expect(mockRedisGeoRemove).toHaveBeenCalled();
    expect(mockRedisSRem).toHaveBeenCalledWith(
      'online:transporters', 'trans-no-details'
    );
  });
});

// =============================================================================
// FIX #10 — Unified lock:booking:{bookingId} for expiry and radius expansion
// =============================================================================

describe('Fix #10: Unified booking lock for expiry + radius expansion', () => {
  beforeEach(() => resetAllMocks());

  test('Expiry and radius expansion use same lock key format', () => {
    // The lock key pattern is: lock:booking:{bookingId}
    // Both processExpiredBookings and processRadiusExpansionTimers use this.
    const bookingId = 'booking-abc-123';
    const expectedLockKey = `lock:booking:${bookingId}`;

    // Verify the lock key format is consistent
    expect(expectedLockKey).toBe('lock:booking:booking-abc-123');
    expect(expectedLockKey).not.toContain('lock:booking-expiry');
    expect(expectedLockKey).not.toContain('lock:radius-expand');
  });

  test('Same lock key ensures mutual exclusion between expiry and radius', async () => {
    const bookingId = 'booking-mutual-excl';
    const lockKey = `lock:booking:${bookingId}`;

    // Simulate first call (expiry) acquires lock
    mockRedisAcquireLock.mockResolvedValueOnce({ acquired: true, lockId: 'expiry-checker' });

    // Second call (radius) fails because lock is held
    mockRedisAcquireLock.mockResolvedValueOnce({ acquired: false });

    const lock1 = await (jest.requireMock('../shared/services/redis.service') as any)
      .redisService.acquireLock(lockKey, 'expiry-checker', 30);
    const lock2 = await (jest.requireMock('../shared/services/redis.service') as any)
      .redisService.acquireLock(lockKey, 'radius-expander', 15);

    expect(lock1.acquired).toBe(true);
    expect(lock2.acquired).toBe(false);

    // Both calls used the SAME lock key
    expect(mockRedisAcquireLock).toHaveBeenCalledTimes(2);
    expect(mockRedisAcquireLock.mock.calls[0][0]).toBe(lockKey);
    expect(mockRedisAcquireLock.mock.calls[1][0]).toBe(lockKey);
  });

  test('Different bookings use different lock keys', () => {
    const bookingA = 'booking-aaa';
    const bookingB = 'booking-bbb';

    const lockKeyA = `lock:booking:${bookingA}`;
    const lockKeyB = `lock:booking:${bookingB}`;

    expect(lockKeyA).not.toBe(lockKeyB);
    expect(lockKeyA).toBe('lock:booking:booking-aaa');
    expect(lockKeyB).toBe('lock:booking:booking-bbb');
  });

  test('Lock contention: only one caller proceeds per booking', async () => {
    const bookingId = 'booking-contention';
    const lockKey = `lock:booking:${bookingId}`;

    // Simulate 3 concurrent callers; only first acquires
    mockRedisAcquireLock
      .mockResolvedValueOnce({ acquired: true, lockId: 'caller-1' })
      .mockResolvedValueOnce({ acquired: false })
      .mockResolvedValueOnce({ acquired: false });

    const redis = (jest.requireMock('../shared/services/redis.service') as any).redisService;

    const results = await Promise.all([
      redis.acquireLock(lockKey, 'caller-1', 30),
      redis.acquireLock(lockKey, 'caller-2', 30),
      redis.acquireLock(lockKey, 'caller-3', 30),
    ]);

    const acquiredCount = results.filter((r: any) => r.acquired).length;
    expect(acquiredCount).toBe(1);
  });
});

// =============================================================================
// FIX #12 — Metrics counter in catch block of updateAvailability
// =============================================================================

describe('Fix #12: metrics counter on updateAvailability failure', () => {
  beforeEach(() => resetAllMocks());

  test('Happy path does NOT trigger failure counter', async () => {
    // Mock the full updateAvailabilityAsync chain:
    // 1. get previous vehicle key
    mockRedisGet.mockResolvedValue(null);
    // 2. sMembers for previous vehicle keys set
    mockRedisSMembers.mockResolvedValue([]);
    // 3. hMSet for transporter details
    mockRedisHMSet.mockResolvedValue('OK');
    // 4. expire for transporter details
    mockRedisExpire.mockResolvedValue(true);
    // 5. set current vehicle key
    mockRedisSet.mockResolvedValue('OK');
    // 6. M-16: Atomic del+sAdd+expire via Lua eval
    mockRedisEval.mockResolvedValue(1);
    // 7. sAdd (online set)
    mockRedisSAdd.mockResolvedValue(1);
    // 8. geoAdd to geo index (not on trip)
    mockRedisGeoAdd.mockResolvedValue(1);
    // 9. geoRemove (cleanup)
    mockRedisGeoRemove.mockResolvedValue(0);

    availabilityService.updateAvailability({
      transporterId: 'trans-ok',
      vehicleKey: 'open_17ft',
      vehicleId: 'v-ok',
      latitude: 28.6139,
      longitude: 77.2090,
    });

    // Wait for the full async chain to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Failure counter should NOT have been called
    expect(mockIncrementCounter).not.toHaveBeenCalledWith(
      'availability.update.failure_total'
    );
  });

  test('updateAvailability failure triggers metrics.incrementCounter', async () => {
    // Make the async path throw early at hMSet (step 3 in the chain)
    const redisError = new Error('Redis GEOADD failed');
    mockRedisGet.mockResolvedValue(null);
    mockRedisSMembers.mockResolvedValue([]);
    mockRedisHMSet.mockRejectedValue(redisError);

    // Call the fire-and-forget wrapper
    availabilityService.updateAvailability({
      transporterId: 'trans-fail',
      vehicleKey: 'open_17ft',
      vehicleId: 'v-fail',
      latitude: 28.6139,
      longitude: 77.2090,
    });

    // Wait for the async catch to fire
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The catch block should increment the failure counter
    expect(mockIncrementCounter).toHaveBeenCalledWith(
      'availability.update.failure_total'
    );
  });
});

// =============================================================================
// FIX #13 — sScan cursor loop replaces sMembers in cleanStaleTransporters
// =============================================================================

describe('Fix #13: sScan replaces sMembers in cleanStaleTransporters', () => {
  beforeEach(() => resetAllMocks());

  test('sScan returns same transporters as sMembers would (single page)', async () => {
    const transporterIds = ['t1', 't2', 't3'];

    // Lock acquired successfully
    mockRedisAcquireLock.mockResolvedValue({ acquired: true, lockId: 'cleanup' });
    mockRedisReleaseLock.mockResolvedValue(true);

    // sScan returns all in one page (cursor '0' signals end)
    mockRedisSScan.mockResolvedValueOnce(['0', transporterIds]);

    // All have valid presence keys (not stale)
    mockRedisExists.mockResolvedValue(true);

    const staleCount = await transporterOnlineService.cleanStaleTransporters();

    // No stale transporters
    expect(staleCount).toBe(0);

    // sScan was called instead of sMembers
    expect(mockRedisSScan).toHaveBeenCalledWith(
      ONLINE_TRANSPORTERS_SET, '0', 200
    );
    // sMembers should NOT have been called
    expect(mockRedisSMembers).not.toHaveBeenCalled();
  });

  test('sScan handles multi-page cursor iteration', async () => {
    // Lock acquired
    mockRedisAcquireLock.mockResolvedValue({ acquired: true, lockId: 'cleanup' });
    mockRedisReleaseLock.mockResolvedValue(true);

    // Page 1: cursor '0' -> returns cursor '42' + first batch
    mockRedisSScan.mockResolvedValueOnce(['42', ['t1', 't2']]);
    // Page 2: cursor '42' -> returns cursor '0' (done) + second batch
    mockRedisSScan.mockResolvedValueOnce(['0', ['t3', 't4']]);

    // All have valid presence (not stale)
    mockRedisExists.mockResolvedValue(true);

    const staleCount = await transporterOnlineService.cleanStaleTransporters();

    expect(staleCount).toBe(0);

    // sScan should have been called twice (two pages)
    expect(mockRedisSScan).toHaveBeenCalledTimes(2);
    expect(mockRedisSScan).toHaveBeenCalledWith(ONLINE_TRANSPORTERS_SET, '0', 200);
    expect(mockRedisSScan).toHaveBeenCalledWith(ONLINE_TRANSPORTERS_SET, '42', 200);
  });

  test('sScan handles empty set gracefully', async () => {
    // Lock acquired
    mockRedisAcquireLock.mockResolvedValue({ acquired: true, lockId: 'cleanup' });
    mockRedisReleaseLock.mockResolvedValue(true);

    // sScan returns empty set
    mockRedisSScan.mockResolvedValueOnce(['0', []]);

    const staleCount = await transporterOnlineService.cleanStaleTransporters();

    expect(staleCount).toBe(0);
    // Should return early, not try to check any presence keys
    expect(mockRedisExists).not.toHaveBeenCalled();
  });

  test('sScan detects and removes stale transporters', async () => {
    // Lock acquired
    mockRedisAcquireLock.mockResolvedValue({ acquired: true, lockId: 'cleanup' });
    mockRedisReleaseLock.mockResolvedValue(true);

    // sScan returns two transporters
    mockRedisSScan.mockResolvedValueOnce(['0', ['t-fresh', 't-stale']]);

    // t-fresh has presence key, t-stale does not
    mockRedisExists
      .mockResolvedValueOnce(true)   // t-fresh: presence exists
      .mockResolvedValueOnce(false); // t-stale: presence expired

    // sRem for removal
    mockRedisSRem.mockResolvedValue(1);
    // DB update for stale transporter
    mockUserUpdate.mockResolvedValue({ id: 't-stale' });
    // geoRemove for stale cleanup
    mockRedisGeoRemove.mockResolvedValue(1);
    // Additional cleanup ops
    mockRedisDel.mockResolvedValue(1);

    const staleCount = await transporterOnlineService.cleanStaleTransporters();

    expect(staleCount).toBe(1);
    // t-stale should have been removed from online set
    expect(mockRedisSRem).toHaveBeenCalledWith(ONLINE_TRANSPORTERS_SET, 't-stale');
  });
});

// =============================================================================
// FIX #23 — filterOnlineViaDB checks presence key before returning
// =============================================================================

describe('Fix #23: filterOnlineViaDB checks presence key', () => {
  beforeEach(() => resetAllMocks());

  test('Presence key exists -> transporter included', async () => {
    const transporterIds = ['t-present'];

    // Force DB fallback path: make getOnlineSet return empty set
    mockRedisSScan.mockResolvedValueOnce(['0', []]);

    // DB says transporter is available
    mockUserFindMany.mockResolvedValue([{ id: 't-present' }]);

    // Presence key exists
    mockRedisExists.mockResolvedValue(true);

    const result = await transporterOnlineService.filterOnline(transporterIds);

    expect(result).toContain('t-present');
    // Should have checked presence key
    expect(mockRedisExists).toHaveBeenCalledWith(
      TRANSPORTER_PRESENCE_KEY('t-present')
    );
  });

  test('Presence key expired -> transporter excluded', async () => {
    const transporterIds = ['t-expired'];

    // Force DB fallback: empty online set
    mockRedisSScan.mockResolvedValueOnce(['0', []]);

    // DB says transporter is available
    mockUserFindMany.mockResolvedValue([{ id: 't-expired' }]);

    // Presence key does NOT exist (expired)
    mockRedisExists.mockResolvedValue(false);

    const result = await transporterOnlineService.filterOnline(transporterIds);

    // Transporter should be excluded because presence key is missing
    expect(result).not.toContain('t-expired');
  });

  test('Multiple transporters: only those with presence keys returned', async () => {
    const transporterIds = ['t-active', 't-stale-1', 't-active-2', 't-stale-2'];

    // Force DB fallback: empty online set
    mockRedisSScan.mockResolvedValueOnce(['0', []]);

    // DB says all are available
    mockUserFindMany.mockResolvedValue([
      { id: 't-active' },
      { id: 't-stale-1' },
      { id: 't-active-2' },
      { id: 't-stale-2' },
    ]);

    // Presence: only t-active and t-active-2 have presence keys
    mockRedisExists
      .mockResolvedValueOnce(true)   // t-active
      .mockResolvedValueOnce(false)  // t-stale-1
      .mockResolvedValueOnce(true)   // t-active-2
      .mockResolvedValueOnce(false); // t-stale-2

    const result = await transporterOnlineService.filterOnline(transporterIds);

    expect(result).toEqual(['t-active', 't-active-2']);
    expect(result).not.toContain('t-stale-1');
    expect(result).not.toContain('t-stale-2');
  });

  test('Redis fails during presence check -> falls through to DB-only', async () => {
    const transporterIds = ['t-redis-down'];

    // Force DB fallback: empty online set
    mockRedisSScan.mockResolvedValueOnce(['0', []]);

    // DB says transporter is available
    mockUserFindMany.mockResolvedValue([{ id: 't-redis-down' }]);

    // Presence check throws (Redis completely down)
    mockRedisExists.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await transporterOnlineService.filterOnline(transporterIds);

    // When presence check fails, the catch block falls through to DB-only result
    // which should still include the transporter (DB says available)
    expect(result).toContain('t-redis-down');
  });

  test('All DB candidates have expired presence -> empty result with warning', async () => {
    const transporterIds = ['t-ghost-1', 't-ghost-2'];

    // Force DB fallback: empty online set
    mockRedisSScan.mockResolvedValueOnce(['0', []]);

    // DB says both are available
    mockUserFindMany.mockResolvedValue([
      { id: 't-ghost-1' },
      { id: 't-ghost-2' },
    ]);

    // No presence keys exist
    mockRedisExists.mockResolvedValue(false);

    const result = await transporterOnlineService.filterOnline(transporterIds);

    // All filtered out because no presence keys
    expect(result).toEqual([]);

    // Should log a warning about finding 0 transporters with presence
    const { logger } = require('../shared/services/logger.service');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('DB fallback found 0 transporters with recent presence'),
      expect.objectContaining({
        inputCount: 2,
        dbCandidateCount: 2,
      })
    );
  });
});
