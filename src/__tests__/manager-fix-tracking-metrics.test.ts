/**
 * =============================================================================
 * Tests for Manager Fix — Tracking Retry (#46) + Reconciliation Alerting (#59)
 * + Metrics Service Split
 * =============================================================================
 *
 * Covers:
 *   Issue #46: initializeTracking retry with backoff
 *   Issue #59: reconcileTrackingTrips orphan detection + alerting
 *   Metrics split: definitions load correctly, new counters registered
 *
 * Minimum 8 tests.
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP
// =============================================================================

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockMetricsIncrementCounter = jest.fn();
const mockMetricsObserveHistogram = jest.fn();

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: (...args: unknown[]) => mockMetricsIncrementCounter(...args),
    observeHistogram: (...args: unknown[]) => mockMetricsObserveHistogram(...args),
    incrementGauge: jest.fn(),
    decrementGauge: jest.fn(),
    setGauge: jest.fn(),
    startTimer: jest.fn().mockReturnValue(() => {}),
  },
}));

jest.mock('../config/environment', () => ({
  config: { redis: { enabled: true }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {} },
}));

// Redis
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisGetJSON = jest.fn();
const mockRedisSetJSON = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisExpire = jest.fn();
const mockRedisSAdd = jest.fn();
const mockRedisSRem = jest.fn();
const mockRedisSMembers = jest.fn();
const mockRedisSCard = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisScanIterator = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: unknown[]) => mockRedisGet(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
    getJSON: (...args: unknown[]) => mockRedisGetJSON(...args),
    setJSON: (...args: unknown[]) => mockRedisSetJSON(...args),
    expire: (...args: unknown[]) => mockRedisExpire(...args),
    sAdd: (...args: unknown[]) => mockRedisSAdd(...args),
    sRem: (...args: unknown[]) => mockRedisSRem(...args),
    sMembers: (...args: unknown[]) => mockRedisSMembers(...args),
    sCard: (...args: unknown[]) => mockRedisSCard(...args),
    acquireLock: (...args: unknown[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: unknown[]) => mockRedisReleaseLock(...args),
    isConnected: jest.fn().mockReturnValue(true),
    exists: jest.fn().mockResolvedValue(false),
    sIsMember: jest.fn().mockResolvedValue(false),
    scanIterator: (...args: unknown[]) => mockRedisScanIterator(...args),
    rPush: jest.fn().mockResolvedValue(undefined),
    lTrim: jest.fn().mockResolvedValue(undefined),
    lRange: jest.fn().mockResolvedValue([]),
  },
}));

// Socket
jest.mock('../shared/services/socket.service', () => ({
  emitToBooking: jest.fn(),
  emitToTrip: jest.fn(),
  emitToUser: jest.fn(),
  SocketEvent: {
    LOCATION_UPDATED: 'location_updated',
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    BOOKING_UPDATED: 'booking_updated',
    ORDER_STATUS_UPDATE: 'order_status_update',
  },
}));

// Queue
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queuePushNotification: jest.fn().mockResolvedValue(undefined),
    queueTrackingEvent: jest.fn().mockResolvedValue(undefined),
    enqueue: jest.fn().mockResolvedValue(undefined),
  },
}));

// Prisma
const mockPrismaAssignmentFindMany = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    assignment: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: (...args: unknown[]) => mockPrismaAssignmentFindMany(...args),
      update: jest.fn(),
    },
    order: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

// Google Maps
jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: { getETA: jest.fn() },
}));

// Vehicle lifecycle
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  onVehicleTransition: jest.fn().mockResolvedValue(undefined),
  releaseVehicle: jest.fn(),
}));

// Geospatial
jest.mock('../shared/utils/geospatial.utils', () => ({
  ...jest.requireActual('../shared/utils/geospatial.utils'),
  haversineDistanceMeters: jest.fn(),
}));

// safe-json
jest.mock('../shared/utils/safe-json.utils', () => ({
  safeJsonParse: jest.fn((str: string, fallback: unknown) => {
    try { return JSON.parse(str); } catch { return fallback; }
  }),
}));

// DB module (for checkBookingCompletion)
jest.mock('../shared/database/db', () => ({
  db: {
    getBookingById: jest.fn(),
    updateBooking: jest.fn(),
  },
}));

// =============================================================================
// IMPORTS (after all mocks)
// =============================================================================

import { trackingTripService } from '../modules/tracking/tracking-trip.service';
import { REDIS_KEYS, TTL } from '../modules/tracking/tracking.types';
import { logger } from '../shared/services/logger.service';

// =============================================================================
// HELPERS
// =============================================================================

const TRIP_ID = 'trip-001';
const DRIVER_ID = 'driver-001';
const BOOKING_ID = 'booking-001';
const TRANSPORTER_ID = 'transporter-001';
const VEHICLE_ID = 'vehicle-001';
const ORDER_ID = 'order-001';

function resetAllMocks(): void {
  jest.clearAllMocks();
  // Default Redis mocks for successful operations
  mockRedisSetJSON.mockResolvedValue(undefined);
  mockRedisSAdd.mockResolvedValue(1);
  mockRedisExpire.mockResolvedValue(undefined);
  mockRedisDel.mockResolvedValue(undefined);
  mockRedisGet.mockResolvedValue(null);
  mockRedisGetJSON.mockResolvedValue(null);
  mockRedisAcquireLock.mockResolvedValue({ acquired: true });
  mockRedisReleaseLock.mockResolvedValue(undefined);
}

// Async generator helper for scanIterator mock
async function* asyncGenerator(values: string[]): AsyncGenerator<string> {
  for (const v of values) {
    yield v;
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe('Issue #46 — Tracking initialization retry with backoff', () => {
  beforeEach(resetAllMocks);

  it('succeeds on first attempt and increments success counter', async () => {
    await trackingTripService.initializeTracking(
      TRIP_ID, DRIVER_ID, 'KA01AB1234', BOOKING_ID, TRANSPORTER_ID, VEHICLE_ID, ORDER_ID
    );

    // Verify Redis was called (tracking was initialized)
    expect(mockRedisSetJSON).toHaveBeenCalledWith(
      REDIS_KEYS.TRIP_LOCATION(TRIP_ID),
      expect.objectContaining({
        tripId: TRIP_ID,
        driverId: DRIVER_ID,
        status: 'pending',
      }),
      TTL.TRIP
    );

    // Verify success counter incremented
    expect(mockMetricsIncrementCounter).toHaveBeenCalledWith('tracking.init_success_total');

    // Verify no retry counter
    expect(mockMetricsIncrementCounter).not.toHaveBeenCalledWith(
      'tracking.init_failure_total'
    );
  });

  it('retries on failure and succeeds on second attempt', async () => {
    // First call fails, second succeeds
    mockRedisSetJSON
      .mockRejectedValueOnce(new Error('Redis connection refused'))
      .mockResolvedValue(undefined);

    await trackingTripService.initializeTracking(
      TRIP_ID, DRIVER_ID, 'KA01AB1234', BOOKING_ID, TRANSPORTER_ID
    );

    // setJSON called twice (1st fail + 2nd success)
    expect(mockRedisSetJSON).toHaveBeenCalledTimes(2);

    // Retry metric recorded for attempt 1
    expect(mockMetricsIncrementCounter).toHaveBeenCalledWith(
      'tracking.init_retry_total',
      { attempt: '1' }
    );

    // Eventually succeeded
    expect(mockMetricsIncrementCounter).toHaveBeenCalledWith('tracking.init_success_total');
  });

  it('logs CRITICAL after all 3 retries fail and increments failure counter', async () => {
    mockRedisSetJSON
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockRejectedValueOnce(new Error('fail 3'));

    // Should NOT throw — tracking init failure is non-fatal
    await trackingTripService.initializeTracking(
      TRIP_ID, DRIVER_ID, 'KA01AB1234', BOOKING_ID
    );

    // All 3 retries attempted
    expect(mockRedisSetJSON).toHaveBeenCalledTimes(3);

    // Failure counter incremented
    expect(mockMetricsIncrementCounter).toHaveBeenCalledWith('tracking.init_failure_total');

    // CRITICAL log emitted
    expect(logger.error).toHaveBeenCalledWith(
      'CRITICAL: Tracking initialization failed after all retries — customer will see accepted but no live tracking',
      expect.objectContaining({
        tripId: TRIP_ID,
        driverId: DRIVER_ID,
        bookingId: BOOKING_ID,
        maxRetries: 3,
      })
    );
  });

  it('does not throw even when all retries fail (non-fatal)', async () => {
    mockRedisSetJSON.mockRejectedValue(new Error('permanent failure'));

    // Should resolve without throwing
    await expect(
      trackingTripService.initializeTracking(TRIP_ID, DRIVER_ID, 'KA01AB1234', BOOKING_ID)
    ).resolves.toBeUndefined();
  });
});

describe('Issue #59 — Reconciliation alerting for orphaned tracking records', () => {
  beforeEach(resetAllMocks);

  it('returns zero orphans when no trip keys exist in Redis', async () => {
    mockRedisScanIterator.mockReturnValue(asyncGenerator([]));

    const result = await trackingTripService.reconcileTrackingTrips();

    expect(result).toEqual({ orphanedCount: 0, cleanedCount: 0 });
    expect(mockMetricsObserveHistogram).toHaveBeenCalledWith(
      'reconciliation.sweep_duration_ms',
      expect.any(Number),
      { type: 'tracking' }
    );
  });

  it('detects orphaned records and logs RECONCILIATION ALERT', async () => {
    const orphanedTripId = 'trip-orphan-001';
    const activeTrip = 'trip-active-001';

    // Redis has 2 trip keys
    mockRedisScanIterator.mockReturnValue(
      asyncGenerator([`driver:trip:${orphanedTripId}`, `driver:trip:${activeTrip}`])
    );

    // DB only has one active assignment
    mockPrismaAssignmentFindMany.mockResolvedValue([
      { tripId: activeTrip },
    ]);

    // Orphan location data (30 minutes old — should be cleaned)
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    mockRedisGetJSON.mockImplementation((key: string) => {
      if (key === `driver:trip:${orphanedTripId}`) {
        return Promise.resolve({
          tripId: orphanedTripId,
          driverId: 'driver-x',
          status: 'in_transit',
          lastUpdated: thirtyMinAgo,
        });
      }
      return Promise.resolve(null);
    });
    mockRedisDel.mockResolvedValue(undefined);

    const result = await trackingTripService.reconcileTrackingTrips();

    expect(result.orphanedCount).toBe(1);
    expect(result.cleanedCount).toBe(1);

    // RECONCILIATION ALERT logged
    expect(logger.error).toHaveBeenCalledWith(
      'RECONCILIATION ALERT: Orphaned tracking records found',
      expect.objectContaining({
        type: 'tracking',
        count: 1,
        ids: [orphanedTripId],
      })
    );

    // Metric counter incremented
    expect(mockMetricsIncrementCounter).toHaveBeenCalledWith(
      'reconciliation.orphaned_records_total',
      { type: 'tracking' },
      1
    );
    expect(mockMetricsIncrementCounter).toHaveBeenCalledWith(
      'reconciliation.tracking_orphans_total',
      {},
      1
    );
  });

  it('does not clean orphans younger than 10 minutes (race protection)', async () => {
    const recentOrphanTripId = 'trip-recent-orphan';

    mockRedisScanIterator.mockReturnValue(
      asyncGenerator([`driver:trip:${recentOrphanTripId}`])
    );

    // No active assignment
    mockPrismaAssignmentFindMany.mockResolvedValue([]);

    // Recent location data (2 minutes old)
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    mockRedisGetJSON.mockResolvedValue({
      tripId: recentOrphanTripId,
      driverId: 'driver-y',
      status: 'pending',
      lastUpdated: twoMinAgo,
    });

    const result = await trackingTripService.reconcileTrackingTrips();

    // Detected as orphan but not cleaned (too young)
    expect(result.orphanedCount).toBe(1);
    expect(result.cleanedCount).toBe(0);

    // Redis.del should NOT be called
    expect(mockRedisDel).not.toHaveBeenCalled();
  });

  it('handles reconciliation sweep errors gracefully', async () => {
    // Make scanIterator throw
    mockRedisScanIterator.mockImplementation(function* () {
      throw new Error('Redis scan failed');
    });

    // Should not throw
    const result = await trackingTripService.reconcileTrackingTrips();

    expect(result).toEqual({ orphanedCount: 0, cleanedCount: 0 });
    expect(logger.error).toHaveBeenCalledWith(
      '[RECONCILIATION] Tracking reconciliation sweep failed',
      expect.objectContaining({ error: expect.any(String) })
    );
  });
});

describe('Metrics definitions split', () => {
  it('metrics-definitions exports registration functions', () => {
    // Import the definitions module directly
    const defs = require('../shared/monitoring/metrics-definitions');

    expect(typeof defs.registerDefaultCounters).toBe('function');
    expect(typeof defs.registerDefaultGauges).toBe('function');
    expect(typeof defs.registerDefaultHistograms).toBe('function');
    expect(Array.isArray(defs.LATENCY_BUCKETS)).toBe(true);
  });

  it('registers reconciliation counters (Issue #59 metrics)', () => {
    const defs = require('../shared/monitoring/metrics-definitions');
    const counters = new Map();
    defs.registerDefaultCounters(counters);

    // Verify new reconciliation counters exist
    expect(counters.has('reconciliation.orphaned_records_total')).toBe(true);
    expect(counters.has('reconciliation.tracking_orphans_total')).toBe(true);
    expect(counters.has('reconciliation.hold_orphans_total')).toBe(true);

    // Verify new tracking init counters exist (Issue #46)
    expect(counters.has('tracking.init_retry_total')).toBe(true);
    expect(counters.has('tracking.init_failure_total')).toBe(true);
    expect(counters.has('tracking.init_success_total')).toBe(true);
  });

  it('registers reconciliation histogram for sweep duration', () => {
    const defs = require('../shared/monitoring/metrics-definitions');
    const histograms = new Map();
    defs.registerDefaultHistograms(histograms);

    expect(histograms.has('reconciliation.sweep_duration_ms')).toBe(true);
    const hist = histograms.get('reconciliation.sweep_duration_ms');
    expect(hist.name).toBe('reconciliation.sweep_duration_ms');
    expect(Array.isArray(hist.buckets)).toBe(true);
  });

  it('preserves all existing metric registrations after split', () => {
    const defs = require('../shared/monitoring/metrics-definitions');
    const counters = new Map();
    const gauges = new Map();
    const histograms = new Map();

    defs.registerDefaultCounters(counters);
    defs.registerDefaultGauges(gauges);
    defs.registerDefaultHistograms(histograms);

    // Verify key existing metrics still registered
    expect(counters.has('http_requests_total')).toBe(true);
    expect(counters.has('hold_request_total')).toBe(true);
    expect(counters.has('broadcast_fanout_total')).toBe(true);
    expect(gauges.has('websocket_connections')).toBe(true);
    expect(gauges.has('nodejs_memory_heap_used_bytes')).toBe(true);
    expect(histograms.has('http_request_duration_ms')).toBe(true);
    expect(histograms.has('hold_latency_ms')).toBe(true);
  });
});
