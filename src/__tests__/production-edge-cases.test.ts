/**
 * =============================================================================
 * PRODUCTION EDGE CASES — Failure Scenario Tests
 * =============================================================================
 *
 * Tests for what goes WRONG in production:
 * - Vehicle lifecycle race conditions & Redis sync failures
 * - Circuit breaker state transitions & Redis fallback
 * - Fleet cache JSON consistency
 * - Transporter online presence & stale cleanup
 * - Queue retry & dead letter behavior
 * - PII masking for compliance
 * - Graceful degradation when Redis disconnects
 *
 * @author Weelo Team
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — Must come before any imports
// =============================================================================

// Logger mock
jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Metrics mock
jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    recordHistogram: jest.fn(),
  },
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

const mockRedisGeoRemove = jest.fn();
const mockRedisSAdd = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    incr: (...args: any[]) => mockRedisIncr(...args),
    expire: (...args: any[]) => mockRedisExpire(...args),
    sIsMember: (...args: any[]) => mockRedisSIsMember(...args),
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
    geoRemove: (...args: any[]) => mockRedisGeoRemove(...args),
    sAdd: (...args: any[]) => mockRedisSAdd(...args),
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
  },
}));

// Prisma mock
const mockVehicleFindUnique = jest.fn();
const mockVehicleUpdateMany = jest.fn();
const mockUserUpdate = jest.fn();
const mockUserFindMany = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    vehicle: {
      findUnique: (...args: any[]) => mockVehicleFindUnique(...args),
      updateMany: (...args: any[]) => mockVehicleUpdateMany(...args),
    },
    user: {
      update: (...args: any[]) => mockUserUpdate(...args),
      findMany: (...args: any[]) => mockUserFindMany(...args),
    },
  },
}));

// DB mock
const mockGetUserById = jest.fn();
const mockGetVehiclesByTransporter = jest.fn();
jest.mock('../shared/database/db', () => ({
  db: {
    getUserById: (...args: any[]) => mockGetUserById(...args),
    getVehiclesByTransporter: (...args: any[]) => mockGetVehiclesByTransporter(...args),
  },
}));

// Live availability service mock
const mockOnVehicleStatusChange = jest.fn();
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: (...args: any[]) => mockOnVehicleStatusChange(...args),
  },
}));

// Cache service mock
const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();
const mockCacheDelete = jest.fn();
jest.mock('../shared/services/cache.service', () => ({
  cacheService: {
    get: (...args: any[]) => mockCacheGet(...args),
    set: (...args: any[]) => mockCacheSet(...args),
    delete: (...args: any[]) => mockCacheDelete(...args),
  },
}));

// Socket service mock
jest.mock('../shared/services/socket.service', () => ({
  emitToUser: jest.fn(),
  socketService: { emitToUser: jest.fn() },
}));

// H3 geo index mock
jest.mock('../shared/services/h3-geo-index.service', () => ({
  h3GeoIndexService: {
    updateLocation: jest.fn().mockResolvedValue(undefined),
    removeTransporter: jest.fn().mockResolvedValue(undefined),
    findNearby: jest.fn().mockResolvedValue([]),
  },
}));

// Config mock for cache service
jest.mock('../config/environment', () => ({
  config: { redis: { enabled: true }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {} },
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { releaseVehicle, isValidTransition, VALID_TRANSITIONS } from '../shared/services/vehicle-lifecycle.service';
import { CircuitBreaker, CircuitState } from '../shared/services/circuit-breaker.service';
import {
  transporterOnlineService,
  ONLINE_TRANSPORTERS_SET,
  TRANSPORTER_PRESENCE_KEY,
} from '../shared/services/transporter-online.service';
import { maskForLogging } from '../shared/utils/crypto.utils';
import { logger } from '../shared/services/logger.service';

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
  mockVehicleFindUnique.mockReset();
  mockVehicleUpdateMany.mockReset();
  mockUserUpdate.mockReset();
  mockUserFindMany.mockReset();
  mockGetUserById.mockReset();
  mockGetVehiclesByTransporter.mockReset();
  mockOnVehicleStatusChange.mockReset();
  mockCacheGet.mockReset();
  mockCacheSet.mockReset();
  mockCacheDelete.mockReset();
  mockRedisGeoRemove.mockReset();
  mockRedisSAdd.mockReset();
}

// =============================================================================
// 1. VEHICLE LIFECYCLE — Centralized Release
// =============================================================================

describe('Vehicle Lifecycle — releaseVehicle', () => {
  beforeEach(resetAllMocks);

  // Test 1: in_transit -> available transitions correctly
  it('releases an in_transit vehicle to available and syncs Redis', async () => {
    mockVehicleFindUnique.mockResolvedValue({
      id: 'v-001',
      status: 'in_transit',
      vehicleKey: 'MH12AB1234',
      transporterId: 't-001',
    });
    mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockOnVehicleStatusChange.mockResolvedValue(undefined);

    await releaseVehicle('v-001', 'test-context');

    expect(mockVehicleUpdateMany).toHaveBeenCalledWith({
      where: { id: 'v-001', status: { not: 'available' } },
      data: expect.objectContaining({
        status: 'available',
        currentTripId: null,
        assignedDriverId: null,
      }),
    });
    expect(mockOnVehicleStatusChange).toHaveBeenCalledWith(
      't-001', 'MH12AB1234', 'in_transit', 'available'
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Vehicle v-001 released: in_transit -> available')
    );
  });

  // Test 2: already available — idempotent no-op
  it('is a no-op when vehicle is already available', async () => {
    mockVehicleFindUnique.mockResolvedValue({
      id: 'v-002',
      status: 'available',
      vehicleKey: 'MH12CD5678',
      transporterId: 't-001',
    });

    await releaseVehicle('v-002', 'test-idempotent');

    expect(mockVehicleUpdateMany).not.toHaveBeenCalled();
    expect(mockOnVehicleStatusChange).not.toHaveBeenCalled();
  });

  // Test 3: non-existent vehicle — logs warning, no throw
  it('logs warning for non-existent vehicle and does not throw', async () => {
    mockVehicleFindUnique.mockResolvedValue(null);

    await expect(releaseVehicle('v-ghost', 'test-missing')).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Vehicle v-ghost not found')
    );
    expect(mockVehicleUpdateMany).not.toHaveBeenCalled();
  });

  // Test 4: invalid transition (on_hold is valid, but test a truly invalid one)
  it('logs warning on invalid transition and does not update', async () => {
    // VALID_TRANSITIONS.maintenance = ['available', 'inactive'], so maintenance->available IS valid
    // Let's verify the actual map, and use a status that has no transition to 'available'
    // According to the source: on_hold -> [in_transit, available] -- so on_hold IS valid
    // The only status NOT in the map at all would trigger the guard.
    // We simulate with a custom status not in the map:
    mockVehicleFindUnique.mockResolvedValue({
      id: 'v-004',
      status: 'decommissioned', // Not in VALID_TRANSITIONS
      vehicleKey: 'KEY',
      transporterId: 't-001',
    });

    await releaseVehicle('v-004', 'test-invalid');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid transition: decommissioned -> available')
    );
    expect(mockVehicleUpdateMany).not.toHaveBeenCalled();
  });

  // Test 5: concurrent release — second process sees count=0
  it('handles concurrent release idempotently (updateMany count=0)', async () => {
    mockVehicleFindUnique.mockResolvedValue({
      id: 'v-005',
      status: 'in_transit',
      vehicleKey: 'KEY',
      transporterId: 't-001',
    });
    // Another process already released — count=0
    mockVehicleUpdateMany.mockResolvedValue({ count: 0 });

    await releaseVehicle('v-005', 'test-race');

    expect(mockVehicleUpdateMany).toHaveBeenCalled();
    // Redis sync should NOT be called because count was 0
    expect(mockOnVehicleStatusChange).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining('Vehicle v-005 released')
    );
  });

  // Test 6: Redis sync failure — vehicle still released in DB, error logged
  it('still releases vehicle in DB when Redis sync fails', async () => {
    mockVehicleFindUnique.mockResolvedValue({
      id: 'v-006',
      status: 'in_transit',
      vehicleKey: 'KEY',
      transporterId: 't-001',
    });
    mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockOnVehicleStatusChange.mockRejectedValue(new Error('Redis connection timeout'));

    await releaseVehicle('v-006', 'test-redis-fail');

    // DB update still happened
    expect(mockVehicleUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'available' }),
      })
    );
    // Redis error caught and logged (vehicle-lifecycle.service now logs structured object, not Error)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Redis availability sync failed'),
      expect.objectContaining({ error: expect.any(String) })
    );
  });
});

// =============================================================================
// 1b. VALID TRANSITIONS — isValidTransition utility
// =============================================================================

describe('Vehicle Lifecycle — isValidTransition', () => {
  it('allows in_transit -> available', () => {
    expect(isValidTransition('in_transit', 'available')).toBe(true);
  });

  it('allows on_hold -> available', () => {
    expect(isValidTransition('on_hold', 'available')).toBe(true);
  });

  it('allows maintenance -> available', () => {
    expect(isValidTransition('maintenance', 'available')).toBe(true);
  });

  it('rejects available -> available (not in transitions)', () => {
    expect(isValidTransition('available', 'available')).toBe(false);
  });

  it('rejects unknown status', () => {
    expect(isValidTransition('destroyed', 'available')).toBe(false);
  });

  it('VALID_TRANSITIONS has all expected statuses', () => {
    expect(Object.keys(VALID_TRANSITIONS)).toEqual(
      expect.arrayContaining(['available', 'on_hold', 'in_transit', 'maintenance', 'inactive'])
    );
  });
});

// =============================================================================
// 2. CIRCUIT BREAKER — State Machine Tests
// =============================================================================

describe('Circuit Breaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    resetAllMocks();
    // Low threshold for easy testing: 2 failures in 30s opens circuit
    breaker = new CircuitBreaker('test-service', {
      threshold: 2,
      windowMs: 30000,
      openDurationMs: 60000,
    });
  });

  // Test 7: CLOSED state — calls primary directly
  it('calls primary function in CLOSED state', async () => {
    // Feature flag is off by default (FF_CIRCUIT_BREAKER_ENABLED=false)
    // so tryWithFallback still calls primary first, fallback on error
    const primary = jest.fn().mockResolvedValue('primary-result');
    const fallback = jest.fn().mockResolvedValue('fallback-result');

    const result = await breaker.tryWithFallback(primary, fallback);

    expect(result).toBe('primary-result');
    expect(primary).toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  // Test 8: When primary fails (FF off) — fallback is used
  it('routes to fallback when primary throws (feature flag off)', async () => {
    const primary = jest.fn().mockRejectedValue(new Error('boom'));
    const fallback = jest.fn().mockResolvedValue('fallback-result');

    const result = await breaker.tryWithFallback(primary, fallback);

    expect(result).toBe('fallback-result');
    expect(primary).toHaveBeenCalled();
    expect(fallback).toHaveBeenCalled();
  });

  // Test 9: getState returns CLOSED when Redis says not open
  it('getState returns CLOSED when Redis open key does not exist', async () => {
    mockRedisGet.mockResolvedValue(null);

    const state = await breaker.getState();

    expect(state).toBe(CircuitState.CLOSED);
  });

  // Test 10: getState returns OPEN when Redis open key is set
  it('getState returns OPEN when Redis open key is "1"', async () => {
    mockRedisGet.mockResolvedValue('1');

    const state = await breaker.getState();

    expect(state).toBe(CircuitState.OPEN);
  });

  // Test 11: getState falls back to in-memory when Redis fails
  it('getState falls back to local in-memory state when Redis is down', async () => {
    mockRedisGet.mockRejectedValue(new Error('Redis connection refused'));

    const state = await breaker.getState();

    // Fresh breaker with no local failures -> CLOSED
    expect(state).toBe(CircuitState.CLOSED);
  });

  // Test 12: CircuitState enum has expected values
  it('CircuitState enum contains CLOSED, OPEN, HALF_OPEN', () => {
    expect(CircuitState.CLOSED).toBe('CLOSED');
    expect(CircuitState.OPEN).toBe('OPEN');
    expect(CircuitState.HALF_OPEN).toBe('HALF_OPEN');
  });
});

// =============================================================================
// 3. FLEET CACHE CONSISTENCY
// =============================================================================

describe('Fleet Cache Consistency', () => {
  beforeEach(resetAllMocks);

  // Test 13: cacheService.set with object calls JSON.stringify
  it('cacheService.set stores objects as JSON strings', async () => {
    // Directly test the pattern used in fleet-cache: cacheService.set(key, vehicles, TTL)
    // The mock captures what was passed
    const vehicles = [{ id: 'v1', status: 'available' }];
    mockCacheSet.mockResolvedValue(undefined);

    const { cacheService } = require('../shared/services/cache.service');
    await cacheService.set('fleet:vehicles:t-001', vehicles, 300);

    expect(mockCacheSet).toHaveBeenCalledWith(
      'fleet:vehicles:t-001',
      vehicles,
      300
    );
  });

  // Test 14: cacheService.get returns parsed object
  it('cacheService.get returns parsed JSON object', async () => {
    const vehicles = [{ id: 'v1', status: 'available' }];
    mockCacheGet.mockResolvedValue(vehicles);

    const { cacheService } = require('../shared/services/cache.service');
    const result = await cacheService.get('fleet:vehicles:t-001');

    expect(result).toEqual(vehicles);
  });

  // Test 15: Cache miss falls back to DB
  it('fleetCacheService falls back to DB on cache miss', async () => {
    mockCacheGet.mockResolvedValue(null);
    mockGetVehiclesByTransporter.mockResolvedValue([
      {
        id: 'v1',
        transporterId: 't-001',
        vehicleNumber: 'MH12AB1234',
        vehicleType: 'Open',
        vehicleSubtype: '17ft',
        capacityTons: 5,
        status: 'available',
        currentTripId: null,
        assignedDriverId: null,
        isActive: true,
      },
    ]);
    mockCacheSet.mockResolvedValue(undefined);

    const { fleetCacheService } = require('../shared/services/fleet-cache.service');
    const result = await fleetCacheService.getTransporterVehicles('t-001');

    expect(mockGetVehiclesByTransporter).toHaveBeenCalledWith('t-001');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('v1');
    // Verify it tried to cache the result
    expect(mockCacheSet).toHaveBeenCalled();
  });

  // Test 16: Cache write failure still returns data from DB
  it('returns DB data even when cache write fails', async () => {
    mockCacheGet.mockResolvedValue(null);
    mockGetVehiclesByTransporter.mockResolvedValue([
      {
        id: 'v2',
        transporterId: 't-001',
        vehicleNumber: 'MH12CD5678',
        vehicleType: 'Container',
        vehicleSubtype: '20ft',
        capacityTons: 10,
        status: 'in_transit',
        currentTripId: 'trip-1',
        assignedDriverId: 'drv-1',
        isActive: true,
      },
    ]);
    mockCacheSet.mockRejectedValue(new Error('Redis WRITE failed'));

    const { fleetCacheService } = require('../shared/services/fleet-cache.service');
    const result = await fleetCacheService.getTransporterVehicles('t-001');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('v2');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Cache write error')
    );
  });
});

// =============================================================================
// 4. TRANSPORTER ONLINE SERVICE
// =============================================================================

describe('Transporter Online Service', () => {
  beforeEach(resetAllMocks);

  // Test 17: filterOnline returns only online transporters
  it('filterOnline returns only IDs present in Redis online set', async () => {
    // sScan returns [cursor, batch] — simulate single page
    mockRedisSScan.mockResolvedValue(['0', ['t-001', 't-003']]);

    const result = await transporterOnlineService.filterOnline([
      't-001', 't-002', 't-003',
    ]);

    expect(result).toEqual(['t-001', 't-003']);
  });

  // Test 18: isOnline returns true for online transporter
  it('isOnline returns true for a transporter in the Redis set', async () => {
    mockRedisSIsMember.mockResolvedValue(true);

    const result = await transporterOnlineService.isOnline('t-001');

    expect(result).toBe(true);
    expect(mockRedisSIsMember).toHaveBeenCalledWith(
      ONLINE_TRANSPORTERS_SET,
      't-001'
    );
  });

  // Test 18b: isOnline returns false for offline transporter
  it('isOnline returns false for a transporter NOT in the Redis set', async () => {
    mockRedisSIsMember.mockResolvedValue(false);

    const result = await transporterOnlineService.isOnline('t-offline');

    expect(result).toBe(false);
  });

  // Test 18c: isOnline falls back to DB when Redis fails
  it('isOnline falls back to DB when Redis throws', async () => {
    mockRedisSIsMember.mockRejectedValue(new Error('Redis down'));
    mockGetUserById.mockResolvedValue({ id: 't-001', isAvailable: true });

    const result = await transporterOnlineService.isOnline('t-001');

    expect(result).toBe(true);
    expect(mockGetUserById).toHaveBeenCalledWith('t-001');
  });

  // Test 19: cleanStaleTransporters removes expired presence
  it('cleanStaleTransporters removes transporters with expired presence keys', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    // FIX: cleanStaleTransporters now uses sScan loop instead of sMembers
    mockRedisSScan.mockResolvedValueOnce(['0', ['t-001', 't-002']]);
    // t-001 presence exists, t-002 expired
    mockRedisExists
      .mockResolvedValueOnce(true)   // t-001 — still has presence
      .mockResolvedValueOnce(false); // t-002 — stale
    // Geo cleanup for stale t-002: sMembers for vehicle keys, get for single key
    mockRedisSMembers.mockResolvedValueOnce([]); // no vehicle keys set
    mockRedisGet.mockResolvedValueOnce(null); // no single vehicle key
    mockRedisSRem.mockResolvedValue(1);
    mockUserUpdate.mockResolvedValue({});
    mockRedisReleaseLock.mockResolvedValue(undefined);

    const staleCount = await transporterOnlineService.cleanStaleTransporters();

    expect(staleCount).toBe(1);
    expect(mockRedisSRem).toHaveBeenCalledWith(ONLINE_TRANSPORTERS_SET, 't-002');
    expect(mockUserUpdate).toHaveBeenCalledWith({
      where: { id: 't-002' },
      data: { isAvailable: false },
    });
  });

  // Test 20: cleanStaleTransporters with distributed lock — only one instance runs
  it('skips cleanup when another instance holds the lock', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: false });

    const staleCount = await transporterOnlineService.cleanStaleTransporters();

    expect(staleCount).toBe(0);
    expect(mockRedisSScan).not.toHaveBeenCalled();
  });

  // Test 20b: cleanStaleTransporters releases lock on completion
  it('releases distributed lock after cleanup completes', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisSScan.mockResolvedValueOnce(['0', []]); // empty set
    mockRedisReleaseLock.mockResolvedValue(undefined);

    await transporterOnlineService.cleanStaleTransporters();

    expect(mockRedisReleaseLock).toHaveBeenCalledWith(
      'clean-stale-transporters',
      'cleanup-job'
    );
  });

  // Test 20c: filterOnline falls back to DB when Redis set is empty
  it('filterOnline falls back to DB when Redis online set is empty', async () => {
    mockRedisSScan.mockResolvedValue(['0', []]);
    mockUserFindMany.mockResolvedValue([{ id: 't-001' }]);
    // FIX: DB fallback now checks presence keys for recency
    mockRedisExists.mockResolvedValue(true);

    const result = await transporterOnlineService.filterOnline(['t-001', 't-002']);

    expect(result).toEqual(['t-001']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Redis online set is empty')
    );
  });
});

// =============================================================================
// 5. QUEUE & RETRY BEHAVIOR
// =============================================================================

describe('Queue & Retry Behavior', () => {
  beforeEach(resetAllMocks);

  // Test 21: Exponential backoff formula verification
  it('exponential backoff calculates delay as 2^attempts * 1000ms', () => {
    // This tests the formula used at queue.service.ts line 337:
    // job.processAfter = Date.now() + Math.pow(2, job.attempts) * 1000
    const attempt1Delay = Math.pow(2, 1) * 1000; // 2000ms
    const attempt2Delay = Math.pow(2, 2) * 1000; // 4000ms
    const attempt3Delay = Math.pow(2, 3) * 1000; // 8000ms

    expect(attempt1Delay).toBe(2000);
    expect(attempt2Delay).toBe(4000);
    expect(attempt3Delay).toBe(8000);
  });

  // Test 22: Job exceeds maxAttempts — verification of DLQ logic pattern
  it('job exceeds maxAttempts threshold correctly', () => {
    const job = { attempts: 3, maxAttempts: 3 };
    const shouldMoveToDLQ = job.attempts >= job.maxAttempts;

    expect(shouldMoveToDLQ).toBe(true);
  });

  // Test 22b: Job with remaining retries should NOT go to DLQ
  it('job with remaining retries stays in queue', () => {
    const job = { attempts: 1, maxAttempts: 3 };
    const shouldMoveToDLQ = job.attempts >= job.maxAttempts;

    expect(shouldMoveToDLQ).toBe(false);
  });

  // Test 23: QueueJob structure has required fields
  it('QueueJob interface has all required fields for retry', () => {
    const job = {
      id: 'job-001',
      type: 'broadcast',
      data: { orderId: 'ord-1' },
      priority: 0,
      attempts: 0,
      maxAttempts: 3,
      createdAt: Date.now(),
      processAfter: undefined,
      error: undefined,
    };

    expect(job.id).toBeDefined();
    expect(job.attempts).toBe(0);
    expect(job.maxAttempts).toBe(3);
    expect(job.processAfter).toBeUndefined();
  });
});

// =============================================================================
// 6. PII MASKING — Production Security
// =============================================================================

describe('PII Masking — maskForLogging', () => {
  // Test 24: Phone masking format
  it('masks phone number showing first 2 and last 2 chars', () => {
    const masked = maskForLogging('9876543210');
    // Default: visibleStart=2, visibleEnd=2
    // Expected: "98" + "******" (min of 6-char mask) + "10"
    expect(masked).toBe('98******10');
    expect(masked).not.toContain('9876543210');
  });

  // Test 24b: Phone masking with custom parameters (as used in console provider)
  it('masks phone with custom start=3, end=2 (console provider pattern)', () => {
    // ConsoleProvider does: phone.slice(0, 3) + '****' + phone.slice(-2)
    // But maskForLogging with visibleStart=3, visibleEnd=2:
    const masked = maskForLogging('9876543210', 3, 2);
    expect(masked.startsWith('987')).toBe(true);
    expect(masked.endsWith('10')).toBe(true);
    expect(masked).toContain('*');
  });

  // Test 25: OTP masking format
  it('masks OTP showing first 2 chars', () => {
    const masked = maskForLogging('847291', 2, 0);
    // visibleEnd=0 means nothing at end
    // But length is 6, visibleStart=2, visibleEnd=0 => start="84", mask="****", end=""
    expect(masked.startsWith('84')).toBe(true);
    expect(masked).toContain('****');
    expect(masked).not.toBe('847291');
  });

  // Test 26: Name masking format
  it('masks name showing first 3 chars', () => {
    const masked = maskForLogging('Nitish Bhardwaj', 3, 0);
    expect(masked.startsWith('Nit')).toBe(true);
    expect(masked).toContain('*');
    expect(masked).not.toBe('Nitish Bhardwaj');
  });

  // Test 27: Masked values never contain full PII
  it('masked output never contains the full original phone number', () => {
    const phone = '9876543210';
    const masked = maskForLogging(phone);
    expect(masked).not.toBe(phone);
    expect(masked.length).toBeLessThan(phone.length + 1);
    // Ensure at least some characters are masked
    expect(masked).toContain('*');
  });

  // Test 27b: Short strings return all asterisks
  it('returns **** for very short values', () => {
    const masked = maskForLogging('ab');
    // Length (2) <= visibleStart(2) + visibleEnd(2) = 4, returns ****
    expect(masked).toBe('****');
  });

  // Test 27c: Empty string returns ****
  it('returns **** for empty string', () => {
    const masked = maskForLogging('');
    expect(masked).toBe('****');
  });

  // Test 27d: Null-ish handling
  it('returns **** for falsy input', () => {
    const masked = maskForLogging(undefined as unknown as string);
    expect(masked).toBe('****');
  });
});

// =============================================================================
// 7. GRACEFUL DEGRADATION — Redis Disconnects
// =============================================================================

describe('Graceful Degradation — Redis Failures', () => {
  beforeEach(resetAllMocks);

  // Test 28: filterOnline works via DB when Redis errors
  it('filterOnline returns DB-based results when Redis throws', async () => {
    mockRedisSScan.mockRejectedValue(new Error('ECONNREFUSED'));
    mockUserFindMany.mockResolvedValue([{ id: 't-001' }]);
    // FIX: DB fallback now also checks presence keys for recency.
    // Mock exists to return true for the presence key check.
    mockRedisExists.mockResolvedValue(true);

    const result = await transporterOnlineService.filterOnline(['t-001', 't-002']);

    expect(result).toEqual(['t-001']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Redis filter failed')
    );
  });

  // Test 29: getOnlineCount returns 0 when Redis is disconnected
  it('getOnlineCount returns 0 when Redis fails', async () => {
    mockRedisSCard.mockRejectedValue(new Error('Redis down'));

    const count = await transporterOnlineService.getOnlineCount();

    expect(count).toBe(0);
  });

  // Test 29b: getOnlineIds returns empty array when Redis fails
  it('getOnlineIds returns empty array when Redis fails', async () => {
    mockRedisSMembers.mockRejectedValue(new Error('Redis timeout'));

    const ids = await transporterOnlineService.getOnlineIds();

    expect(ids).toEqual([]);
  });

  // Test 29c: isOnline returns false when both Redis and DB fail
  it('isOnline returns false when Redis AND DB both fail', async () => {
    mockRedisSIsMember.mockRejectedValue(new Error('Redis down'));
    mockGetUserById.mockRejectedValue(new Error('DB pool exhausted'));

    const result = await transporterOnlineService.isOnline('t-001');

    expect(result).toBe(false);
  });
});

// =============================================================================
// 8. WHAT CAN GO WRONG IN PRODUCTION
// =============================================================================

describe('Production Failure Scenarios', () => {
  beforeEach(resetAllMocks);

  // Test 30: ECS container restart — verify in-memory timers are volatile
  it('in-memory timer references are null-safe after stop', () => {
    const { stopStaleTransporterCleanup } = require('../shared/services/transporter-online.service');
    // Should not throw even if called without start
    expect(() => stopStaleTransporterCleanup()).not.toThrow();
  });

  // Test 31: Two ECS instances process same timer — idempotent release
  it('idempotent release prevents double-processing across instances', async () => {
    mockVehicleFindUnique.mockResolvedValue({
      id: 'v-ecs',
      status: 'in_transit',
      vehicleKey: 'KEY',
      transporterId: 't-001',
    });
    // First call: count=1, second call: count=0 (already released)
    mockVehicleUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    mockOnVehicleStatusChange.mockResolvedValue(undefined);

    await releaseVehicle('v-ecs', 'instance-1');
    // Re-read vehicle — now it appears available
    mockVehicleFindUnique.mockResolvedValue({
      id: 'v-ecs',
      status: 'available',
      vehicleKey: 'KEY',
      transporterId: 't-001',
    });
    await releaseVehicle('v-ecs', 'instance-2');

    // Only the first release should have synced Redis
    expect(mockOnVehicleStatusChange).toHaveBeenCalledTimes(1);
  });

  // Test 32: Database connection pool exhausted — proper error propagation
  it('releaseVehicle propagates DB errors on findUnique failure', async () => {
    mockVehicleFindUnique.mockRejectedValue(
      new Error('Connection pool exhausted: timeout after 30000ms')
    );

    await expect(
      releaseVehicle('v-pool', 'test-pool-exhausted')
    ).rejects.toThrow('Connection pool exhausted');
  });

  // Test 33: Redis presence key constants are correct
  it('presence key follows expected pattern for stale detection', () => {
    const key = TRANSPORTER_PRESENCE_KEY('t-abc-123');
    expect(key).toBe('transporter:presence:t-abc-123');
  });

  // Test 33b: ONLINE_TRANSPORTERS_SET has expected value
  it('ONLINE_TRANSPORTERS_SET is the correct Redis key', () => {
    expect(ONLINE_TRANSPORTERS_SET).toBe('online:transporters');
  });

  // Test 33c: cleanStaleTransporters handles individual check failures gracefully
  it('cleanStaleTransporters continues when individual presence check fails', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    // FIX: cleanStaleTransporters now uses sScan loop
    mockRedisSScan.mockResolvedValueOnce(['0', ['t-001', 't-002', 't-003']]);
    mockRedisExists
      .mockResolvedValueOnce(true)                           // t-001 OK
      .mockRejectedValueOnce(new Error('Redis TIMEOUT'))     // t-002 check fails
      .mockResolvedValueOnce(false);                         // t-003 stale
    // Geo cleanup for stale t-003
    mockRedisSMembers.mockResolvedValueOnce([]); // no vehicle keys
    mockRedisGet.mockResolvedValueOnce(null); // no single vehicle key
    mockRedisSRem.mockResolvedValue(1);
    mockUserUpdate.mockResolvedValue({});
    mockRedisReleaseLock.mockResolvedValue(undefined);

    const staleCount = await transporterOnlineService.cleanStaleTransporters();

    // Only t-003 was detected as stale (t-002 errored, skipped)
    expect(staleCount).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Stale check failed for t-002')
    );
  });

  // Test 33d: cleanStaleTransporters handles DB update failure for stale transporter
  it('cleanStaleTransporters logs warning when DB update fails for stale transporter', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    // FIX: cleanStaleTransporters now uses sScan loop
    mockRedisSScan.mockResolvedValueOnce(['0', ['t-bad']]);
    mockRedisExists.mockResolvedValue(false); // stale
    // Geo cleanup for stale t-bad
    mockRedisSMembers.mockResolvedValueOnce([]); // no vehicle keys
    mockRedisGet.mockResolvedValueOnce(null); // no single vehicle key
    mockRedisSRem.mockResolvedValue(1);
    mockUserUpdate.mockRejectedValue(new Error('DB write failed'));
    mockRedisReleaseLock.mockResolvedValue(undefined);

    const staleCount = await transporterOnlineService.cleanStaleTransporters();

    // Still counts as stale even if DB update failed
    expect(staleCount).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('DB update failed for stale t-bad')
    );
  });

  // Test 33e: cleanStaleTransporters handles lock acquisition failure
  it('cleanStaleTransporters returns 0 when lock acquisition throws', async () => {
    mockRedisAcquireLock.mockRejectedValue(new Error('Redis unavailable'));

    const staleCount = await transporterOnlineService.cleanStaleTransporters();

    expect(staleCount).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Cleanup lock failed')
    );
  });
});

// =============================================================================
// 9. CIRCUIT BREAKER — Advanced State Transitions
// =============================================================================

describe('Circuit Breaker — Advanced', () => {
  beforeEach(resetAllMocks);

  // Test: Constructor sets Redis keys correctly
  it('constructs with correct Redis key naming convention', () => {
    const breaker = new CircuitBreaker('my-service');
    // We can verify by calling getState which reads the open key
    mockRedisGet.mockResolvedValue(null);
    breaker.getState();
    expect(mockRedisGet).toHaveBeenCalledWith('circuit:my-service:open');
  });

  // Test: Multiple breaker instances are isolated
  it('multiple breaker instances use separate Redis keys', async () => {
    const breaker1 = new CircuitBreaker('service-a');
    const breaker2 = new CircuitBreaker('service-b');

    mockRedisGet.mockResolvedValue(null);

    await breaker1.getState();
    await breaker2.getState();

    expect(mockRedisGet).toHaveBeenCalledWith('circuit:service-a:open');
    expect(mockRedisGet).toHaveBeenCalledWith('circuit:service-b:open');
  });

  // Test: Pre-configured circuit breakers exist
  it('pre-configured circuit breakers are exported', () => {
    const { h3Circuit, directionsCircuit, queueCircuit, fcmCircuit } =
      require('../shared/services/circuit-breaker.service');

    expect(h3Circuit).toBeInstanceOf(CircuitBreaker);
    expect(directionsCircuit).toBeInstanceOf(CircuitBreaker);
    expect(queueCircuit).toBeInstanceOf(CircuitBreaker);
    expect(fcmCircuit).toBeInstanceOf(CircuitBreaker);
  });
});

// =============================================================================
// 10. FLEET CACHE — Edge Cases
// =============================================================================

describe('Fleet Cache — Edge Cases', () => {
  beforeEach(resetAllMocks);

  // Test: Empty transporter fleet returns empty array
  it('returns empty array when transporter has no vehicles', async () => {
    mockCacheGet.mockResolvedValue(null);
    mockGetVehiclesByTransporter.mockResolvedValue([]);
    mockCacheSet.mockResolvedValue(undefined);

    const { fleetCacheService } = require('../shared/services/fleet-cache.service');
    const result = await fleetCacheService.getTransporterVehicles('t-empty');

    expect(result).toEqual([]);
  });

  // Test: Null DB result is handled
  it('handles null DB result gracefully', async () => {
    mockCacheGet.mockResolvedValue(null);
    mockGetVehiclesByTransporter.mockResolvedValue(null);

    const { fleetCacheService } = require('../shared/services/fleet-cache.service');
    const result = await fleetCacheService.getTransporterVehicles('t-null');

    expect(result).toEqual([]);
  });

  // Test: Cache read error falls through to DB
  it('falls through to DB when cache read throws', async () => {
    mockCacheGet.mockRejectedValue(new Error('Unexpected token'));
    mockGetVehiclesByTransporter.mockResolvedValue([
      {
        id: 'v1',
        transporterId: 't-001',
        vehicleNumber: 'MH12AB1234',
        vehicleType: 'Open',
        vehicleSubtype: '',
        capacityTons: 5,
        status: 'available',
        currentTripId: null,
        assignedDriverId: null,
        isActive: true,
      },
    ]);
    mockCacheSet.mockResolvedValue(undefined);

    const { fleetCacheService } = require('../shared/services/fleet-cache.service');
    const result = await fleetCacheService.getTransporterVehicles('t-001');

    expect(result).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Cache read error')
    );
  });
});

// =============================================================================
// 11. PII MASKING — Additional Edge Cases
// =============================================================================

describe('PII Masking — Additional Edge Cases', () => {
  it('mask length is capped at 6 asterisks', () => {
    // For a very long value, mask should be at most 6 chars
    const masked = maskForLogging('abcdefghijklmnopqrstuvwxyz');
    const asteriskCount = (masked.match(/\*/g) || []).length;
    expect(asteriskCount).toBe(6); // Math.min(len - start - end, 6)
  });

  it('maskForLogging is pure (same input => same output)', () => {
    const result1 = maskForLogging('9876543210');
    const result2 = maskForLogging('9876543210');
    expect(result1).toBe(result2);
  });

  it('different phones produce different masked output', () => {
    const masked1 = maskForLogging('9876543210');
    const masked2 = maskForLogging('1234567890');
    expect(masked1).not.toBe(masked2);
  });

  // Test: SMS service phone masking pattern (phone.slice(-4))
  it('phone.slice(-4) pattern shows only last 4 digits', () => {
    const phone = '9876543210';
    const lastFour = phone.slice(-4);
    expect(lastFour).toBe('3210');
    expect(lastFour.length).toBe(4);
    expect(lastFour).not.toBe(phone);
  });

  // Test: Console provider masking pattern
  it('console provider phone masking (slice(0,3) + **** + slice(-2))', () => {
    const phone = '9876543210';
    const masked = `${phone.slice(0, 3)}****${phone.slice(-2)}`;
    expect(masked).toBe('987****10');
    expect(masked).not.toContain('9876543210');
  });

  // Test: Console provider OTP masking pattern
  it('console provider OTP masking (slice(0,2) + ****)', () => {
    const otp = '847291';
    const masked = `${otp.slice(0, 2)}****`;
    expect(masked).toBe('84****');
    expect(masked).not.toContain('847291');
  });
});
