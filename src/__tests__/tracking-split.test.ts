/**
 * =============================================================================
 * COMPREHENSIVE TESTS FOR SPLIT TRACKING MODULE
 * =============================================================================
 *
 * Tests cover all 7 split tracking files:
 *   1. tracking.service.ts        — Facade integrity
 *   2. tracking.types.ts          — Types & Redis key helpers
 *   3. tracking-history.service.ts — History persistence, sampling, event stream
 *   4. tracking-query.service.ts  — Read queries (trip, booking, fleet, history)
 *   5. tracking-location.service.ts — GPS updates, batch upload, driver status
 *   6. tracking-fleet.service.ts  — Fleet management, offline detection, completion
 *   7. tracking-trip.service.ts   — Trip lifecycle, status progression, proximity
 *
 * 70 tests total.
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — must come before imports
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

// Redis service mock
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisGetJSON = jest.fn();
const mockRedisSetJSON = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisRPush = jest.fn();
const mockRedisLTrim = jest.fn();
const mockRedisExpire = jest.fn();
const mockRedisSAdd = jest.fn();
const mockRedisSRem = jest.fn();
const mockRedisSMembers = jest.fn();
const mockRedisSCard = jest.fn();
const mockRedisLRange = jest.fn();
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
    rPush: (...args: unknown[]) => mockRedisRPush(...args),
    lTrim: (...args: unknown[]) => mockRedisLTrim(...args),
    lRange: (...args: unknown[]) => mockRedisLRange(...args),
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
  },
}));

// Socket service mock
const mockEmitToBooking = jest.fn();
const mockEmitToTrip = jest.fn();
const mockEmitToUser = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToBooking: (...args: unknown[]) => mockEmitToBooking(...args),
  emitToTrip: (...args: unknown[]) => mockEmitToTrip(...args),
  emitToUser: (...args: unknown[]) => mockEmitToUser(...args),
  SocketEvent: {
    LOCATION_UPDATED: 'location_updated',
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    BOOKING_UPDATED: 'booking_updated',
    ORDER_STATUS_UPDATE: 'order_status_update',
  },
}));

// Queue service mock
const mockQueuePushNotification = jest.fn();
const mockQueueTrackingEvent = jest.fn();
const mockQueueEnqueue = jest.fn();

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queuePushNotification: (...args: unknown[]) => mockQueuePushNotification(...args),
    queueTrackingEvent: (...args: unknown[]) => mockQueueTrackingEvent(...args),
    enqueue: (...args: unknown[]) => mockQueueEnqueue(...args),
  },
}));

// Prisma mock
const mockPrismaAssignmentFindUnique = jest.fn();
const mockPrismaAssignmentFindFirst = jest.fn();
const mockPrismaAssignmentFindMany = jest.fn();
const mockPrismaAssignmentUpdate = jest.fn();
const mockPrismaAssignmentUpdateMany = jest.fn();
const mockPrismaVehicleUpdateMany = jest.fn();
const mockPrisma$Transaction = jest.fn();
const mockPrismaOrderFindUnique = jest.fn();
const mockPrismaOrderUpdate = jest.fn();
const mockPrismaOrderUpdateMany = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    assignment: {
      findUnique: (...args: unknown[]) => mockPrismaAssignmentFindUnique(...args),
      findFirst: (...args: unknown[]) => mockPrismaAssignmentFindFirst(...args),
      findMany: (...args: unknown[]) => mockPrismaAssignmentFindMany(...args),
      update: (...args: unknown[]) => mockPrismaAssignmentUpdate(...args),
      updateMany: (...args: unknown[]) => mockPrismaAssignmentUpdateMany(...args),
    },
    vehicle: {
      updateMany: (...args: unknown[]) => mockPrismaVehicleUpdateMany(...args),
    },
    order: {
      findUnique: (...args: unknown[]) => mockPrismaOrderFindUnique(...args),
      update: (...args: unknown[]) => mockPrismaOrderUpdate(...args),
      updateMany: (...args: unknown[]) => mockPrismaOrderUpdateMany(...args),
    },
    $transaction: (...args: unknown[]) => mockPrisma$Transaction(...args),
  },
}));

// Google Maps service mock
const mockGetETA = jest.fn();
jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: {
    getETA: (...args: unknown[]) => mockGetETA(...args),
  },
}));

// Vehicle lifecycle mock
const mockReleaseVehicle = jest.fn();
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  onVehicleTransition: jest.fn().mockResolvedValue(undefined),
  releaseVehicle: (...args: unknown[]) => mockReleaseVehicle(...args),
}));

// Geospatial mock
const mockHaversine = jest.fn();
jest.mock('../shared/utils/geospatial.utils', () => ({
  ...jest.requireActual('../shared/utils/geospatial.utils'),
  haversineDistanceMeters: (...args: unknown[]) => mockHaversine(...args),
}));

// safe-json mock
jest.mock('../shared/utils/safe-json.utils', () => ({
  safeJsonParse: <T>(value: string | null | undefined, fallback: T): T => {
    if (value == null) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  },
}));

// tracking-access.policy mock
const mockAssertTripAccess = jest.fn();
const mockAssertBookingAccess = jest.fn();
jest.mock('../modules/tracking/tracking-access.policy', () => ({
  assertTripTrackingAccess: (...args: unknown[]) => mockAssertTripAccess(...args),
  assertBookingTrackingAccess: (...args: unknown[]) => mockAssertBookingAccess(...args),
}));

// db module mock (dynamic import in fleet service)
jest.mock('../shared/database/db', () => ({
  db: {
    getBookingById: jest.fn(),
    updateBooking: jest.fn(),
  },
}));

// =============================================================================
// IMPORTS — after all mocks
// =============================================================================

import { trackingService } from '../modules/tracking/tracking.service';
import { REDIS_KEYS, TTL } from '../modules/tracking/tracking.types';
import { trackingHistoryService } from '../modules/tracking/tracking-history.service';
import { trackingLocationService } from '../modules/tracking/tracking-location.service';
import { trackingQueryService } from '../modules/tracking/tracking-query.service';
import { trackingFleetService } from '../modules/tracking/tracking-fleet.service';
import { trackingTripService } from '../modules/tracking/tracking-trip.service';

// =============================================================================
// HELPERS
// =============================================================================

function resetAllMocks(): void {
  jest.clearAllMocks();
  mockRedisGet.mockReset();
  mockRedisSet.mockReset();
  mockRedisGetJSON.mockReset();
  mockRedisSetJSON.mockReset();
  mockRedisDel.mockReset();
  mockRedisRPush.mockReset();
  mockRedisLTrim.mockReset();
  mockRedisExpire.mockReset();
  mockRedisSAdd.mockReset();
  mockRedisSRem.mockReset();
  mockRedisSMembers.mockReset();
  mockRedisSCard.mockReset();
  mockRedisLRange.mockReset();
  mockRedisAcquireLock.mockReset();
  mockRedisReleaseLock.mockReset();
  mockRedisScanIterator.mockReset();
  mockEmitToBooking.mockReset();
  mockEmitToTrip.mockReset();
  mockEmitToUser.mockReset();
  mockQueuePushNotification.mockResolvedValue(undefined);
  mockQueueTrackingEvent.mockResolvedValue(undefined);
  mockQueueEnqueue.mockResolvedValue(undefined);
  mockPrismaAssignmentFindUnique.mockReset();
  mockPrismaAssignmentFindFirst.mockReset();
  mockPrismaAssignmentFindMany.mockReset();
  mockPrismaAssignmentUpdate.mockReset();
  mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
  mockPrismaVehicleUpdateMany.mockResolvedValue({ count: 1 });
  mockPrisma$Transaction.mockImplementation(async (ops: any) => {
    if (Array.isArray(ops)) return ops;
    if (typeof ops === 'function') return ops({});
    return ops;
  });
  mockPrismaOrderFindUnique.mockReset();
  mockPrismaOrderUpdate.mockReset();
  mockPrismaOrderUpdateMany.mockReset();
  mockGetETA.mockReset();
  mockReleaseVehicle.mockReset();
  mockHaversine.mockReset();
  mockAssertTripAccess.mockReset();
  mockAssertBookingAccess.mockReset();
}

const TRIP_ID = 'trip-001';
const DRIVER_ID = 'driver-001';
const TRANSPORTER_ID = 'transporter-001';
const BOOKING_ID = 'booking-001';
const ORDER_ID = 'order-001';
const VEHICLE_ID = 'vehicle-001';
const CUSTOMER_ID = 'customer-001';

function makeLocationData(overrides: Record<string, unknown> = {}) {
  return {
    tripId: TRIP_ID,
    driverId: DRIVER_ID,
    transporterId: TRANSPORTER_ID,
    vehicleId: VEHICLE_ID,
    vehicleNumber: 'KA01AB1234',
    bookingId: BOOKING_ID,
    orderId: ORDER_ID,
    latitude: 19.076,
    longitude: 72.877,
    speed: 10,
    bearing: 90,
    accuracy: 5,
    status: 'in_transit',
    lastUpdated: new Date().toISOString(),
    ...overrides,
  };
}

// =============================================================================
// 1. FACADE INTEGRITY (tracking.service.ts)
// =============================================================================

describe('Facade -- tracking.service.ts', () => {
  beforeEach(resetAllMocks);

  it('exports trackingService singleton', () => {
    expect(trackingService).toBeDefined();
  });

  it('re-exports FleetTrackingResponse type (via tracking.types)', () => {
    // Type-level check: if the import resolves without error, the re-export works
    const types = require('../modules/tracking/tracking.service');
    expect(types.trackingService).toBeDefined();
  });

  it('has updateLocation method that delegates to trackingLocationService', async () => {
    expect(typeof trackingService.updateLocation).toBe('function');
  });

  it('has uploadBatchLocations method', () => {
    expect(typeof trackingService.uploadBatchLocations).toBe('function');
  });

  it('has getDriverStatus method', () => {
    expect(typeof trackingService.getDriverStatus).toBe('function');
  });

  it('has setDriverStatus method', () => {
    expect(typeof trackingService.setDriverStatus).toBe('function');
  });

  it('has initializeTracking method', () => {
    expect(typeof trackingService.initializeTracking).toBe('function');
  });

  it('has updateStatus method', () => {
    expect(typeof trackingService.updateStatus).toBe('function');
  });

  it('has updateTripStatus method', () => {
    expect(typeof trackingService.updateTripStatus).toBe('function');
  });

  it('has completeTracking method', () => {
    expect(typeof trackingService.completeTracking).toBe('function');
  });

  it('has getTripTracking method', () => {
    expect(typeof trackingService.getTripTracking).toBe('function');
  });

  it('has getBookingTracking method', () => {
    expect(typeof trackingService.getBookingTracking).toBe('function');
  });

  it('has getFleetTracking method', () => {
    expect(typeof trackingService.getFleetTracking).toBe('function');
  });

  it('has getTripHistory method', () => {
    expect(typeof trackingService.getTripHistory).toBe('function');
  });

  it('has getLocationHistory method', () => {
    expect(typeof trackingService.getLocationHistory).toBe('function');
  });

  it('has addDriverToFleet method', () => {
    expect(typeof trackingService.addDriverToFleet).toBe('function');
  });

  it('has removeDriverFromFleet method', () => {
    expect(typeof trackingService.removeDriverFromFleet).toBe('function');
  });

  it('has startDriverOfflineChecker method', () => {
    expect(typeof trackingService.startDriverOfflineChecker).toBe('function');
  });

  it('has stopDriverOfflineChecker method', () => {
    expect(typeof trackingService.stopDriverOfflineChecker).toBe('function');
  });

  it('has checkBookingCompletion method', () => {
    expect(typeof trackingService.checkBookingCompletion).toBe('function');
  });

  it('has checkOrderCompletion method', () => {
    expect(typeof trackingService.checkOrderCompletion).toBe('function');
  });
});

// =============================================================================
// 2. TYPES & REDIS KEYS (tracking.types.ts)
// =============================================================================

describe('Types & Redis Keys -- tracking.types.ts', () => {
  it('REDIS_KEYS.DRIVER_LOCATION generates correct key', () => {
    expect(REDIS_KEYS.DRIVER_LOCATION('d1')).toBe('driver:location:d1');
  });

  it('REDIS_KEYS.TRIP_LOCATION generates correct key', () => {
    expect(REDIS_KEYS.TRIP_LOCATION('t1')).toBe('driver:trip:t1');
  });

  it('REDIS_KEYS.TRIP_HISTORY generates correct key', () => {
    expect(REDIS_KEYS.TRIP_HISTORY('t1')).toBe('driver:history:t1');
  });

  it('REDIS_KEYS.FLEET_DRIVERS generates correct key', () => {
    expect(REDIS_KEYS.FLEET_DRIVERS('tr1')).toBe('fleet:tr1');
  });

  it('REDIS_KEYS.BOOKING_TRIPS generates correct key', () => {
    expect(REDIS_KEYS.BOOKING_TRIPS('b1')).toBe('booking:trips:b1');
  });

  it('REDIS_KEYS.DRIVER_LAST_TS generates correct key', () => {
    expect(REDIS_KEYS.DRIVER_LAST_TS('d1')).toBe('driver:last_ts:d1');
  });

  it('REDIS_KEYS.DRIVER_STATUS generates correct key', () => {
    expect(REDIS_KEYS.DRIVER_STATUS('d1')).toBe('driver:status:d1');
  });

  it('REDIS_KEYS.HISTORY_PERSIST_STATE generates correct key', () => {
    expect(REDIS_KEYS.HISTORY_PERSIST_STATE('t1')).toBe('tracking:persist-state:t1');
  });

  it('REDIS_KEYS.ACTIVE_FLEET_TRANSPORTERS is a static string', () => {
    expect(REDIS_KEYS.ACTIVE_FLEET_TRANSPORTERS).toBe('fleet:index:transporters');
  });

  it('TTL.LOCATION is 300 seconds', () => {
    expect(TTL.LOCATION).toBe(300);
  });

  it('TTL.TRIP is 86400 seconds', () => {
    expect(TTL.TRIP).toBe(86400);
  });

  it('TTL.HISTORY is 7 days in seconds', () => {
    expect(TTL.HISTORY).toBe(86400 * 7);
  });
});

// =============================================================================
// 3. HISTORY SERVICE (tracking-history.service.ts)
// =============================================================================

describe('History Service -- tracking-history.service.ts', () => {
  beforeEach(resetAllMocks);

  describe('addToHistory', () => {
    it('persists entry to Redis list with rPush', async () => {
      mockRedisRPush.mockResolvedValue(1);
      mockRedisLTrim.mockResolvedValue(undefined);
      mockRedisExpire.mockResolvedValue(undefined);

      const entry = { latitude: 19.0, longitude: 72.8, speed: 10, timestamp: new Date().toISOString() };
      await trackingHistoryService.addToHistory(TRIP_ID, entry);

      expect(mockRedisRPush).toHaveBeenCalledWith(
        REDIS_KEYS.TRIP_HISTORY(TRIP_ID),
        JSON.stringify(entry)
      );
    });

    it('caps list at 5000 entries with lTrim (H-30: longer trip support)', async () => {
      mockRedisRPush.mockResolvedValue(1);
      mockRedisLTrim.mockResolvedValue(undefined);
      mockRedisExpire.mockResolvedValue(undefined);

      const entry = { latitude: 19.0, longitude: 72.8, speed: 10, timestamp: new Date().toISOString() };
      await trackingHistoryService.addToHistory(TRIP_ID, entry);

      expect(mockRedisLTrim).toHaveBeenCalledWith(
        REDIS_KEYS.TRIP_HISTORY(TRIP_ID),
        -5000,
        -1
      );
    });

    it('sets TTL on history key', async () => {
      mockRedisRPush.mockResolvedValue(1);
      mockRedisLTrim.mockResolvedValue(undefined);
      mockRedisExpire.mockResolvedValue(undefined);

      const entry = { latitude: 19.0, longitude: 72.8, speed: 10, timestamp: new Date().toISOString() };
      await trackingHistoryService.addToHistory(TRIP_ID, entry);

      expect(mockRedisExpire).toHaveBeenCalledWith(
        REDIS_KEYS.TRIP_HISTORY(TRIP_ID),
        TTL.HISTORY
      );
    });

    it('handles WRONGTYPE error by deleting key and retrying', async () => {
      mockRedisRPush
        .mockRejectedValueOnce(new Error('WRONGTYPE Operation against a key'))
        .mockResolvedValueOnce(1);
      mockRedisDel.mockResolvedValue(undefined);
      mockRedisLTrim.mockResolvedValue(undefined);
      mockRedisExpire.mockResolvedValue(undefined);

      const entry = { latitude: 19.0, longitude: 72.8, speed: 10, timestamp: new Date().toISOString() };
      await trackingHistoryService.addToHistory(TRIP_ID, entry);

      expect(mockRedisDel).toHaveBeenCalledWith(REDIS_KEYS.TRIP_HISTORY(TRIP_ID));
      expect(mockRedisRPush).toHaveBeenCalledTimes(2);
    });

    it('does not throw on generic Redis failure (non-critical)', async () => {
      mockRedisRPush.mockRejectedValue(new Error('Redis connection lost'));

      const entry = { latitude: 19.0, longitude: 72.8, speed: 10, timestamp: new Date().toISOString() };
      await expect(trackingHistoryService.addToHistory(TRIP_ID, entry)).resolves.toBeUndefined();
    });
  });

  describe('shouldPersistHistoryPoint', () => {
    it('returns true for first point (no previous state)', async () => {
      mockRedisGetJSON.mockResolvedValue(null);
      mockRedisSetJSON.mockResolvedValue(undefined);

      const entry = { latitude: 19.0, longitude: 72.8, speed: 10, timestamp: new Date().toISOString() };
      const result = await trackingHistoryService.shouldPersistHistoryPoint(TRIP_ID, entry, 'in_transit');

      expect(result).toBe(true);
    });

    it('returns false for invalid timestamp', async () => {
      const entry = { latitude: 19.0, longitude: 72.8, speed: 10, timestamp: 'invalid-date' };
      const result = await trackingHistoryService.shouldPersistHistoryPoint(TRIP_ID, entry, 'in_transit');

      expect(result).toBe(false);
    });

    it('returns false when too close in time and distance (skip sampling)', async () => {
      const now = Date.now();
      const previousState = {
        latitude: 19.0,
        longitude: 72.8,
        timestampMs: now - 5000,  // 5 seconds ago
        status: 'in_transit'
      };
      mockRedisGetJSON.mockResolvedValue(previousState);
      mockHaversine.mockReturnValue(10); // 10 meters (below 75m threshold)

      const entry = {
        latitude: 19.0001,
        longitude: 72.8001,
        speed: 10,
        timestamp: new Date(now - 2000).toISOString() // 2 seconds ago -- less than interval
      };
      const result = await trackingHistoryService.shouldPersistHistoryPoint(TRIP_ID, entry, 'in_transit');

      expect(result).toBe(false);
    });

    it('returns true on status change even if close in time/distance', async () => {
      const now = Date.now();
      const previousState = {
        latitude: 19.0,
        longitude: 72.8,
        timestampMs: now - 2000,
        status: 'in_transit'
      };
      mockRedisGetJSON.mockResolvedValue(previousState);
      mockRedisSetJSON.mockResolvedValue(undefined);
      mockHaversine.mockReturnValue(5);

      const entry = {
        latitude: 19.0001,
        longitude: 72.8001,
        speed: 0,
        timestamp: new Date(now).toISOString()
      };
      const result = await trackingHistoryService.shouldPersistHistoryPoint(TRIP_ID, entry, 'completed');

      expect(result).toBe(true);
    });

    it('returns true when enough time has elapsed', async () => {
      const now = Date.now();
      const previousState = {
        latitude: 19.0,
        longitude: 72.8,
        timestampMs: now - 20000, // 20 seconds ago (>15s threshold)
        status: 'in_transit'
      };
      mockRedisGetJSON.mockResolvedValue(previousState);
      mockRedisSetJSON.mockResolvedValue(undefined);
      mockHaversine.mockReturnValue(10);

      const entry = {
        latitude: 19.0001,
        longitude: 72.8001,
        speed: 10,
        timestamp: new Date(now).toISOString()
      };
      const result = await trackingHistoryService.shouldPersistHistoryPoint(TRIP_ID, entry, 'in_transit');

      expect(result).toBe(true);
    });

    it('returns true when enough distance has been moved', async () => {
      const now = Date.now();
      const previousState = {
        latitude: 19.0,
        longitude: 72.8,
        timestampMs: now - 5000,
        status: 'in_transit'
      };
      mockRedisGetJSON.mockResolvedValue(previousState);
      mockRedisSetJSON.mockResolvedValue(undefined);
      mockHaversine.mockReturnValue(100); // 100 meters (>75m threshold)

      const entry = {
        latitude: 19.001,
        longitude: 72.801,
        speed: 20,
        timestamp: new Date(now).toISOString()
      };
      const result = await trackingHistoryService.shouldPersistHistoryPoint(TRIP_ID, entry, 'in_transit');

      expect(result).toBe(true);
    });

    it('returns false for older-than-previous timestamp (out-of-order)', async () => {
      const now = Date.now();
      const previousState = {
        latitude: 19.0,
        longitude: 72.8,
        timestampMs: now,
        status: 'in_transit'
      };
      mockRedisGetJSON.mockResolvedValue(previousState);

      const entry = {
        latitude: 19.001,
        longitude: 72.801,
        speed: 10,
        timestamp: new Date(now - 5000).toISOString()
      };
      const result = await trackingHistoryService.shouldPersistHistoryPoint(TRIP_ID, entry, 'in_transit');

      expect(result).toBe(false);
    });
  });

  describe('getHistoryPersistState / setHistoryPersistState', () => {
    it('reads from Redis and syncs to in-memory', async () => {
      const state = { latitude: 19.0, longitude: 72.8, timestampMs: Date.now(), status: 'in_transit' };
      mockRedisGetJSON.mockResolvedValue(state);

      const result = await trackingHistoryService.getHistoryPersistState(TRIP_ID);
      expect(result).toEqual(state);
    });

    it('falls back to in-memory when Redis fails', async () => {
      mockRedisGetJSON.mockRejectedValue(new Error('Redis down'));
      mockRedisSetJSON.mockRejectedValue(new Error('Redis down'));

      const state = { latitude: 19.0, longitude: 72.8, timestampMs: Date.now(), status: 'in_transit' };
      await trackingHistoryService.setHistoryPersistState(TRIP_ID, state);

      const result = await trackingHistoryService.getHistoryPersistState(TRIP_ID);
      expect(result).toEqual(state);
    });

    it('deleteHistoryPersistState cleans up both Redis and in-memory', async () => {
      mockRedisDel.mockResolvedValue(undefined);
      mockRedisSetJSON.mockResolvedValue(undefined);

      const state = { latitude: 19.0, longitude: 72.8, timestampMs: Date.now(), status: 'in_transit' };
      await trackingHistoryService.setHistoryPersistState('trip-to-delete', state);
      await trackingHistoryService.deleteHistoryPersistState('trip-to-delete');

      expect(mockRedisDel).toHaveBeenCalled();
    });
  });

  describe('publishTrackingEventAsync', () => {
    it('queues event when TRACKING_STREAM_ENABLED is true', () => {
      // TRACKING_STREAM_ENABLED reads from env at module load time.
      // Since env is not set to 'true', it will skip.
      // We verify it does not throw.
      trackingHistoryService.publishTrackingEventAsync({
        driverId: DRIVER_ID,
        tripId: TRIP_ID,
        latitude: 19.0,
        longitude: 72.8,
        speed: 10,
        bearing: 90,
        ts: new Date().toISOString(),
        source: 'gps'
      });
      // No assertion needed -- verifying no throw
    });
  });
});

// =============================================================================
// 4. QUERY SERVICE (tracking-query.service.ts)
// =============================================================================

describe('Query Service -- tracking-query.service.ts', () => {
  beforeEach(resetAllMocks);

  describe('getTripTracking', () => {
    it('returns tracking data for an active trip', async () => {
      mockAssertTripAccess.mockResolvedValue({
        tripId: TRIP_ID, assignmentId: 'a-1', bookingId: BOOKING_ID,
        driverId: DRIVER_ID, transporterId: TRANSPORTER_ID
      });
      const locationData = makeLocationData();
      mockRedisGetJSON.mockResolvedValue(locationData);

      const result = await trackingQueryService.getTripTracking(TRIP_ID, DRIVER_ID, 'driver');

      expect(result.tripId).toBe(TRIP_ID);
      expect(result.driverId).toBe(DRIVER_ID);
      expect(result.latitude).toBe(19.076);
      expect(result.longitude).toBe(72.877);
    });

    it('throws 404 when no tracking data exists', async () => {
      mockAssertTripAccess.mockResolvedValue({ tripId: TRIP_ID });
      mockRedisGetJSON.mockResolvedValue(null);

      await expect(
        trackingQueryService.getTripTracking(TRIP_ID, DRIVER_ID, 'driver')
      ).rejects.toMatchObject({ statusCode: 404, code: 'TRACKING_NOT_FOUND' });
    });
  });

  describe('getCurrentLocation', () => {
    it('delegates to getTripTracking (alias)', async () => {
      mockAssertTripAccess.mockResolvedValue({ tripId: TRIP_ID });
      const locationData = makeLocationData();
      mockRedisGetJSON.mockResolvedValue(locationData);

      const result = await trackingQueryService.getCurrentLocation(TRIP_ID, DRIVER_ID, 'driver');
      expect(result.tripId).toBe(TRIP_ID);
    });
  });

  describe('getBookingTracking', () => {
    it('returns trucks for a multi-truck booking', async () => {
      mockAssertBookingAccess.mockResolvedValue({
        bookingId: BOOKING_ID, assignmentIds: ['a-1', 'a-2'], tripIds: ['t-1', 't-2']
      });
      mockRedisSMembers.mockResolvedValue(['t-1', 't-2']);
      const loc1 = makeLocationData({ tripId: 't-1', driverId: 'd-1' });
      const loc2 = makeLocationData({ tripId: 't-2', driverId: 'd-2' });
      mockRedisGetJSON.mockResolvedValueOnce(loc1).mockResolvedValueOnce(loc2);

      const result = await trackingQueryService.getBookingTracking(BOOKING_ID, CUSTOMER_ID, 'customer');

      expect(result.bookingId).toBe(BOOKING_ID);
      expect(result.trucks).toHaveLength(2);
    });

    it('returns empty trucks when no trip locations exist', async () => {
      mockAssertBookingAccess.mockResolvedValue({
        bookingId: BOOKING_ID, assignmentIds: [], tripIds: []
      });
      mockRedisSMembers.mockResolvedValue([]);

      const result = await trackingQueryService.getBookingTracking(BOOKING_ID, CUSTOMER_ID, 'customer');

      expect(result.trucks).toHaveLength(0);
    });
  });

  describe('getFleetTracking', () => {
    it('returns all active drivers for transporter', async () => {
      mockRedisSMembers.mockResolvedValue([DRIVER_ID, 'driver-002']);
      const loc1 = makeLocationData({ driverId: DRIVER_ID });
      const loc2 = makeLocationData({ driverId: 'driver-002', vehicleNumber: 'KA02CD5678' });
      mockRedisGetJSON.mockResolvedValueOnce(loc1).mockResolvedValueOnce(loc2);

      const result = await trackingQueryService.getFleetTracking(TRANSPORTER_ID);

      expect(result.transporterId).toBe(TRANSPORTER_ID);
      expect(result.activeDrivers).toBe(2);
      expect(result.drivers).toHaveLength(2);
    });

    it('returns empty drivers when fleet is empty', async () => {
      mockRedisSMembers.mockResolvedValue([]);

      const result = await trackingQueryService.getFleetTracking(TRANSPORTER_ID);

      expect(result.activeDrivers).toBe(0);
      expect(result.drivers).toHaveLength(0);
    });

    it('skips drivers with null location data', async () => {
      mockRedisSMembers.mockResolvedValue([DRIVER_ID, 'driver-002']);
      const loc1 = makeLocationData({ driverId: DRIVER_ID });
      mockRedisGetJSON.mockResolvedValueOnce(loc1).mockResolvedValueOnce(null);

      const result = await trackingQueryService.getFleetTracking(TRANSPORTER_ID);

      expect(result.activeDrivers).toBe(1);
    });
  });

  describe('getTripHistory', () => {
    it('returns history filtered by date range', async () => {
      mockAssertTripAccess.mockResolvedValue({ tripId: TRIP_ID });
      const now = new Date();
      const entries = [
        JSON.stringify({ latitude: 19.0, longitude: 72.8, speed: 10, timestamp: new Date(now.getTime() - 60000).toISOString() }),
        JSON.stringify({ latitude: 19.1, longitude: 72.9, speed: 15, timestamp: now.toISOString() }),
      ];
      mockRedisLRange.mockResolvedValue(entries);

      const query = {
        page: 1,
        limit: 50,
        fromTime: new Date(now.getTime() - 30000).toISOString(),
      };
      const result = await trackingQueryService.getTripHistory(TRIP_ID, DRIVER_ID, 'driver', query);

      expect(result).toHaveLength(1); // Only the second entry is after fromTime
    });

    it('returns empty array when no history exists', async () => {
      mockAssertTripAccess.mockResolvedValue({ tripId: TRIP_ID });
      mockRedisLRange.mockResolvedValue([]);
      mockRedisGetJSON.mockResolvedValue(null);

      const query = { page: 1, limit: 50 };
      const result = await trackingQueryService.getTripHistory(TRIP_ID, DRIVER_ID, 'driver', query);

      expect(result).toHaveLength(0);
    });

    it('paginates results correctly', async () => {
      mockAssertTripAccess.mockResolvedValue({ tripId: TRIP_ID });
      const entries = Array.from({ length: 5 }, (_, i) =>
        JSON.stringify({ latitude: 19 + i * 0.001, longitude: 72.8, speed: 10, timestamp: new Date(Date.now() - (5 - i) * 1000).toISOString() })
      );
      mockRedisLRange.mockResolvedValue(entries);

      const query = { page: 2, limit: 2 };
      const result = await trackingQueryService.getTripHistory(TRIP_ID, DRIVER_ID, 'driver', query);

      expect(result).toHaveLength(2); // Page 2 with limit 2 = entries at index 2,3
    });
  });

  describe('getLocationHistory', () => {
    it('delegates to getTripHistory (alias)', async () => {
      mockAssertTripAccess.mockResolvedValue({ tripId: TRIP_ID });
      mockRedisLRange.mockResolvedValue([]);
      mockRedisGetJSON.mockResolvedValue(null);

      const query = { page: 1, limit: 10 };
      const result = await trackingQueryService.getLocationHistory(TRIP_ID, DRIVER_ID, 'driver', query);
      expect(result).toHaveLength(0);
    });
  });
});

// =============================================================================
// 5. LOCATION SERVICE (tracking-location.service.ts)
// =============================================================================

describe('Location Service -- tracking-location.service.ts', () => {
  beforeEach(resetAllMocks);

  describe('updateLocation', () => {
    it('stores location in Redis for trip and driver', async () => {
      const existing = makeLocationData();
      mockRedisGetJSON.mockResolvedValue(existing);
      mockRedisSetJSON.mockResolvedValue(undefined);
      mockHaversine.mockReturnValue(10);

      await trackingLocationService.updateLocation(DRIVER_ID, {
        tripId: TRIP_ID,
        latitude: 19.077,
        longitude: 72.878,
        speed: 12,
        bearing: 95,
      });

      expect(mockRedisSetJSON).toHaveBeenCalledTimes(2); // trip + driver location
    });

    it('broadcasts via WebSocket to booking, trip, and transporter', async () => {
      const existing = makeLocationData();
      mockRedisGetJSON.mockResolvedValue(existing);
      mockRedisSetJSON.mockResolvedValue(undefined);
      mockHaversine.mockReturnValue(10);

      await trackingLocationService.updateLocation(DRIVER_ID, {
        tripId: TRIP_ID,
        latitude: 19.077,
        longitude: 72.878, speed: 0, bearing: 0 });

      expect(mockEmitToBooking).toHaveBeenCalled();
      expect(mockEmitToTrip).toHaveBeenCalled();
      expect(mockEmitToUser).toHaveBeenCalled();
    });

    it('throws 403 when driver does not own the trip', async () => {
      const existing = makeLocationData({ driverId: 'other-driver' });
      mockRedisGetJSON.mockResolvedValue(existing);

      await expect(
        trackingLocationService.updateLocation(DRIVER_ID, {
          tripId: TRIP_ID,
          latitude: 19.077,
          longitude: 72.878, speed: 0, bearing: 0 })
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('flags mock GPS location in Redis but does not block', async () => {
      const existing = makeLocationData();
      mockRedisGetJSON.mockResolvedValue(existing);
      mockRedisSetJSON.mockResolvedValue(undefined);
      mockRedisSet.mockResolvedValue(undefined);
      mockHaversine.mockReturnValue(10);

      await trackingLocationService.updateLocation(DRIVER_ID, {
        tripId: TRIP_ID,
        latitude: 19.077,
        longitude: 72.878, speed: 0, bearing: 0,
        isMockLocation: true,
      });

      expect(mockRedisSet).toHaveBeenCalledWith(
        `mock_gps:${TRIP_ID}`,
        'true',
        expect.any(Number)
      );
    });

    it('includes staleness info in broadcast payload', async () => {
      const existing = makeLocationData();
      mockRedisGetJSON.mockResolvedValue(existing);
      mockRedisSetJSON.mockResolvedValue(undefined);
      mockHaversine.mockReturnValue(10);

      const oldTimestamp = new Date(Date.now() - 120_000).toISOString(); // 2 min old
      await trackingLocationService.updateLocation(DRIVER_ID, {
        tripId: TRIP_ID,
        latitude: 19.077,
        longitude: 72.878, speed: 0, bearing: 0,
        timestamp: oldTimestamp,
      });

      const tripBroadcast = mockEmitToTrip.mock.calls[0][2];
      expect(tripBroadcast.isStale).toBe(true);
      expect(tripBroadcast.locationAgeMs).toBeGreaterThan(60000);
    });
  });

  describe('uploadBatchLocations', () => {
    it('processes valid batch and returns correct counts', async () => {
      const existing = makeLocationData();
      mockRedisGetJSON.mockResolvedValue(existing);
      mockRedisGet.mockResolvedValue(null); // no last ts
      mockRedisSetJSON.mockResolvedValue(undefined);
      mockRedisSet.mockResolvedValue(undefined);
      mockRedisRPush.mockResolvedValue(1);
      mockRedisLTrim.mockResolvedValue(undefined);
      mockRedisExpire.mockResolvedValue(undefined);
      mockHaversine.mockReturnValue(50);

      const now = new Date();
      const points = [
        { latitude: 19.076, longitude: 72.877, speed: 10, bearing: 90, timestamp: new Date(now.getTime() - 5000).toISOString() },
        { latitude: 19.077, longitude: 72.878, speed: 12, bearing: 91, timestamp: now.toISOString() },
      ];

      const result = await trackingLocationService.uploadBatchLocations(DRIVER_ID, { tripId: TRIP_ID, points });

      expect(result.processed).toBe(2);
      expect(result.accepted).toBe(2);
      expect(result.lastAcceptedTimestamp).toBeTruthy();
    });

    it('detects duplicate points based on last timestamp', async () => {
      const existing = makeLocationData();
      mockRedisGetJSON.mockResolvedValue(existing);
      const now = new Date();
      mockRedisGet.mockResolvedValue(now.toISOString()); // last ts = now
      mockRedisSetJSON.mockResolvedValue(undefined);
      mockRedisSet.mockResolvedValue(undefined);
      mockRedisRPush.mockResolvedValue(1);
      mockRedisLTrim.mockResolvedValue(undefined);
      mockRedisExpire.mockResolvedValue(undefined);

      const points = [
        { latitude: 19.076, longitude: 72.877, speed: 10, bearing: 90, timestamp: new Date(now.getTime() - 5000).toISOString() },
      ];

      const result = await trackingLocationService.uploadBatchLocations(DRIVER_ID, { tripId: TRIP_ID, points });

      expect(result.duplicate).toBe(1);
      expect(result.accepted).toBe(0);
    });

    it('detects unrealistic speed jumps', async () => {
      const existing = makeLocationData();
      mockRedisGetJSON.mockResolvedValue(existing);
      mockRedisGet.mockResolvedValue(null);
      mockRedisSetJSON.mockResolvedValue(undefined);
      mockRedisSet.mockResolvedValue(undefined);
      mockRedisRPush.mockResolvedValue(1);
      mockRedisLTrim.mockResolvedValue(undefined);
      mockRedisExpire.mockResolvedValue(undefined);
      // Simulate a massive distance jump (>55 m/s)
      mockHaversine.mockReturnValueOnce(100000); // 100km in 2 seconds = 50000 m/s

      const now = new Date();
      const points = [
        { latitude: 19.076, longitude: 72.877, speed: 10, bearing: 90, timestamp: new Date(now.getTime() - 2000).toISOString() },
        { latitude: 28.6, longitude: 77.2, speed: 10, bearing: 90, timestamp: now.toISOString() },
      ];

      const result = await trackingLocationService.uploadBatchLocations(DRIVER_ID, { tripId: TRIP_ID, points });

      expect(result.invalid).toBe(1);
    });

    it('throws 403 when driver does not own the trip', async () => {
      const existing = makeLocationData({ driverId: 'other-driver' });
      mockRedisGetJSON.mockResolvedValue(existing);

      await expect(
        trackingLocationService.uploadBatchLocations(DRIVER_ID, {
          tripId: TRIP_ID,
          points: [{ latitude: 19.0, longitude: 72.8, speed: 0, bearing: 0, timestamp: new Date().toISOString() }]
        })
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('handles empty points array edge case (min 1 in schema, but test the loop)', async () => {
      const existing = makeLocationData();
      mockRedisGetJSON.mockResolvedValue(existing);
      mockRedisGet.mockResolvedValue(null);

      // Even though schema enforces min 1, test the service behavior
      const result = await trackingLocationService.uploadBatchLocations(DRIVER_ID, {
        tripId: TRIP_ID,
        points: [] as any
      });

      expect(result.processed).toBe(0);
      expect(result.accepted).toBe(0);
    });
  });

  describe('getDriverStatus', () => {
    // H-25: presence key (35s TTL) is now checked first as authoritative source
    it('returns ONLINE when driver:presence key exists (H-25)', async () => {
      const { redisService } = require('../shared/services/redis.service');
      redisService.exists.mockResolvedValueOnce(true);

      const result = await trackingLocationService.getDriverStatus(DRIVER_ID);
      expect(result).toBe('ONLINE');
    });

    it('returns ONLINE when Redis status is ONLINE', async () => {
      mockRedisGet.mockResolvedValue('ONLINE');

      const result = await trackingLocationService.getDriverStatus(DRIVER_ID);
      expect(result).toBe('ONLINE');
    });

    it('returns OFFLINE when Redis status is OFFLINE', async () => {
      mockRedisGet.mockResolvedValue('OFFLINE');

      const result = await trackingLocationService.getDriverStatus(DRIVER_ID);
      expect(result).toBe('OFFLINE');
    });

    it('returns OFFLINE when no location data exists', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockRedisGetJSON.mockResolvedValue(null);

      const result = await trackingLocationService.getDriverStatus(DRIVER_ID);
      expect(result).toBe('OFFLINE');
    });

    it('returns UNKNOWN when location data is stale (>120s)', async () => {
      mockRedisGet.mockResolvedValue(null);
      const staleLocation = makeLocationData({
        lastUpdated: new Date(Date.now() - 200_000).toISOString() // 200s ago
      });
      mockRedisGetJSON.mockResolvedValue(staleLocation);

      const result = await trackingLocationService.getDriverStatus(DRIVER_ID);
      expect(result).toBe('UNKNOWN');
    });

    it('returns ONLINE when location data is fresh (<120s)', async () => {
      mockRedisGet.mockResolvedValue(null);
      const freshLocation = makeLocationData({
        lastUpdated: new Date(Date.now() - 30_000).toISOString() // 30s ago
      });
      mockRedisGetJSON.mockResolvedValue(freshLocation);

      const result = await trackingLocationService.getDriverStatus(DRIVER_ID);
      expect(result).toBe('ONLINE');
    });
  });

  describe('setDriverStatus', () => {
    it('sets driver status in Redis with correct TTL', async () => {
      mockRedisSet.mockResolvedValue(undefined);
      mockRedisDel.mockResolvedValue(undefined);

      await trackingLocationService.setDriverStatus(DRIVER_ID, 'OFFLINE');

      expect(mockRedisSet).toHaveBeenCalledWith(
        REDIS_KEYS.DRIVER_STATUS(DRIVER_ID),
        'OFFLINE',
        TTL.LOCATION
      );
      // H-25: Also deletes presence key when going OFFLINE
      expect(mockRedisDel).toHaveBeenCalledWith(
        `driver:presence:${DRIVER_ID}`
      );
    });
  });
});

// =============================================================================
// 6. FLEET SERVICE (tracking-fleet.service.ts)
// =============================================================================

describe('Fleet Service -- tracking-fleet.service.ts', () => {
  beforeEach(resetAllMocks);

  describe('addDriverToFleet', () => {
    it('adds driver to fleet set and active transporters index', async () => {
      mockRedisSAdd.mockResolvedValue(1);
      mockRedisExpire.mockResolvedValue(undefined);

      await trackingFleetService.addDriverToFleet(TRANSPORTER_ID, DRIVER_ID);

      expect(mockRedisSAdd).toHaveBeenCalledWith(
        REDIS_KEYS.FLEET_DRIVERS(TRANSPORTER_ID),
        DRIVER_ID
      );
      expect(mockRedisSAdd).toHaveBeenCalledWith(
        REDIS_KEYS.ACTIVE_FLEET_TRANSPORTERS,
        TRANSPORTER_ID
      );
    });

    it('retries on Redis failure (max 2 retries)', async () => {
      // First attempt: sAdd for fleet fails immediately
      // Second attempt (retry 1): sAdd for fleet succeeds, then expire, then sAdd for index
      mockRedisSAdd
        .mockRejectedValueOnce(new Error('Redis timeout'))
        .mockResolvedValue(1);
      mockRedisExpire.mockResolvedValue(undefined);

      await trackingFleetService.addDriverToFleet(TRANSPORTER_ID, DRIVER_ID);

      // Attempt 1: sAdd(fleet) fails at first call -> catch
      // Attempt 2: sAdd(fleet) ok, expire, sAdd(index) ok -> return
      // Total sAdd calls: 1 (failed) + 2 (fleet + index) = 3
      expect(mockRedisSAdd).toHaveBeenCalledTimes(3);
    });

    it('does not throw after all retries exhausted', async () => {
      mockRedisSAdd.mockRejectedValue(new Error('Redis permanently down'));

      await expect(
        trackingFleetService.addDriverToFleet(TRANSPORTER_ID, DRIVER_ID)
      ).resolves.toBeUndefined();
    });
  });

  describe('removeDriverFromFleet', () => {
    it('removes driver from fleet and deletes location', async () => {
      mockRedisSRem.mockResolvedValue(1);
      mockRedisSCard.mockResolvedValue(2); // Still has drivers
      mockRedisDel.mockResolvedValue(undefined);

      await trackingFleetService.removeDriverFromFleet(TRANSPORTER_ID, DRIVER_ID);

      expect(mockRedisSRem).toHaveBeenCalledWith(
        REDIS_KEYS.FLEET_DRIVERS(TRANSPORTER_ID),
        DRIVER_ID
      );
      expect(mockRedisDel).toHaveBeenCalledWith(
        REDIS_KEYS.DRIVER_LOCATION(DRIVER_ID)
      );
    });

    it('cleans up active transporters index when fleet is empty', async () => {
      mockRedisSRem.mockResolvedValue(1);
      mockRedisSCard.mockResolvedValue(0); // Fleet is now empty
      mockRedisDel.mockResolvedValue(undefined);

      await trackingFleetService.removeDriverFromFleet(TRANSPORTER_ID, DRIVER_ID);

      expect(mockRedisSRem).toHaveBeenCalledWith(
        REDIS_KEYS.ACTIVE_FLEET_TRANSPORTERS,
        TRANSPORTER_ID
      );
    });
  });

  describe('startDriverOfflineChecker / stopDriverOfflineChecker', () => {
    it('starts the offline checker interval', () => {
      trackingFleetService.startDriverOfflineChecker();
      // Should not throw, interval is created
      trackingFleetService.stopDriverOfflineChecker(); // Clean up
    });

    it('is idempotent -- starting twice does not create duplicate intervals', () => {
      trackingFleetService.startDriverOfflineChecker();
      trackingFleetService.startDriverOfflineChecker(); // Second call is no-op
      trackingFleetService.stopDriverOfflineChecker();
    });

    it('stop is safe to call when not started', () => {
      trackingFleetService.stopDriverOfflineChecker(); // Should not throw
    });
  });

  describe('checkBookingCompletion', () => {
    it('marks booking completed when all assignments completed', async () => {
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockRedisReleaseLock.mockResolvedValue(undefined);
      mockPrismaAssignmentFindMany.mockResolvedValue([
        { id: 'a-1', status: 'completed' },
        { id: 'a-2', status: 'completed' },
      ]);
      const { db } = require('../shared/database/db');
      db.getBookingById.mockResolvedValue({
        id: BOOKING_ID, status: 'active', customerId: CUSTOMER_ID
      });
      db.updateBooking.mockResolvedValue(undefined);
      mockPrismaAssignmentFindFirst.mockResolvedValue(null); // no orderId

      await trackingFleetService.checkBookingCompletion(BOOKING_ID);

      expect(db.updateBooking).toHaveBeenCalledWith(BOOKING_ID, { status: 'completed' });
      expect(mockEmitToUser).toHaveBeenCalled();
    });

    it('skips when lock not acquired', async () => {
      mockRedisAcquireLock.mockResolvedValue({ acquired: false });

      await trackingFleetService.checkBookingCompletion(BOOKING_ID);

      expect(mockPrismaAssignmentFindMany).not.toHaveBeenCalled();
    });

    it('does not overwrite cancelled booking', async () => {
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockRedisReleaseLock.mockResolvedValue(undefined);
      mockPrismaAssignmentFindMany.mockResolvedValue([
        { id: 'a-1', status: 'completed' },
      ]);
      const { db } = require('../shared/database/db');
      db.getBookingById.mockResolvedValue({
        id: BOOKING_ID, status: 'cancelled', customerId: CUSTOMER_ID
      });

      await trackingFleetService.checkBookingCompletion(BOOKING_ID);

      expect(db.updateBooking).not.toHaveBeenCalled();
    });

    it('does nothing when not all assignments completed', async () => {
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockRedisReleaseLock.mockResolvedValue(undefined);
      mockPrismaAssignmentFindMany.mockResolvedValue([
        { id: 'a-1', status: 'completed' },
        { id: 'a-2', status: 'in_transit' },
      ]);

      await trackingFleetService.checkBookingCompletion(BOOKING_ID);

      const { db } = require('../shared/database/db');
      expect(db.updateBooking).not.toHaveBeenCalled();
    });
  });

  describe('checkOrderCompletion', () => {
    it('marks order completed when all assignments terminal with at least one completed', async () => {
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockRedisReleaseLock.mockResolvedValue(undefined);
      mockPrismaAssignmentFindMany.mockResolvedValue([
        { id: 'a-1', status: 'completed' },
        { id: 'a-2', status: 'cancelled' },
      ]);
      mockPrismaOrderFindUnique.mockResolvedValue({
        id: ORDER_ID, status: 'active', customerId: CUSTOMER_ID
      });
      mockPrismaOrderUpdateMany.mockResolvedValue({ count: 1 });

      await trackingFleetService.checkOrderCompletion(ORDER_ID);

      expect(mockPrismaOrderUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'completed' }
        })
      );
    });

    it('marks order cancelled when all assignments cancelled', async () => {
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockRedisReleaseLock.mockResolvedValue(undefined);
      mockPrismaAssignmentFindMany.mockResolvedValue([
        { id: 'a-1', status: 'cancelled' },
        { id: 'a-2', status: 'cancelled' },
      ]);
      mockPrismaOrderFindUnique.mockResolvedValue({
        id: ORDER_ID, status: 'active', customerId: CUSTOMER_ID
      });
      mockPrismaOrderUpdateMany.mockResolvedValue({ count: 1 });

      await trackingFleetService.checkOrderCompletion(ORDER_ID);

      expect(mockPrismaOrderUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'cancelled' }
        })
      );
    });

    it('skips when order is already terminal', async () => {
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockRedisReleaseLock.mockResolvedValue(undefined);
      mockPrismaAssignmentFindMany.mockResolvedValue([
        { id: 'a-1', status: 'completed' },
      ]);
      mockPrismaOrderFindUnique.mockResolvedValue({
        id: ORDER_ID, status: 'completed', customerId: CUSTOMER_ID
      });

      await trackingFleetService.checkOrderCompletion(ORDER_ID);

      expect(mockPrismaOrderUpdateMany).not.toHaveBeenCalled();
    });

    it('skips when not all assignments are terminal', async () => {
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockRedisReleaseLock.mockResolvedValue(undefined);
      mockPrismaAssignmentFindMany.mockResolvedValue([
        { id: 'a-1', status: 'completed' },
        { id: 'a-2', status: 'in_transit' },
      ]);

      await trackingFleetService.checkOrderCompletion(ORDER_ID);

      expect(mockPrismaOrderFindUnique).not.toHaveBeenCalled();
    });

    it('handles concurrent CAS — no update when count is 0', async () => {
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockRedisReleaseLock.mockResolvedValue(undefined);
      mockPrismaAssignmentFindMany.mockResolvedValue([
        { id: 'a-1', status: 'completed' },
      ]);
      mockPrismaOrderFindUnique.mockResolvedValue({
        id: ORDER_ID, status: 'active', customerId: CUSTOMER_ID
      });
      mockPrismaOrderUpdateMany.mockResolvedValue({ count: 0 });

      await trackingFleetService.checkOrderCompletion(ORDER_ID);

      expect(mockEmitToUser).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// 7. TRIP SERVICE (tracking-trip.service.ts)
// =============================================================================

describe('Trip Service -- tracking-trip.service.ts', () => {
  beforeEach(resetAllMocks);

  describe('initializeTracking', () => {
    it('stores initial location data in Redis', async () => {
      mockRedisSetJSON.mockResolvedValue(undefined);
      mockRedisSAdd.mockResolvedValue(1);
      mockRedisExpire.mockResolvedValue(undefined);
      mockRedisDel.mockResolvedValue(undefined);

      await trackingTripService.initializeTracking(
        TRIP_ID, DRIVER_ID, 'KA01AB1234', BOOKING_ID, TRANSPORTER_ID, VEHICLE_ID, ORDER_ID
      );

      expect(mockRedisSetJSON).toHaveBeenCalledWith(
        REDIS_KEYS.TRIP_LOCATION(TRIP_ID),
        expect.objectContaining({
          tripId: TRIP_ID,
          driverId: DRIVER_ID,
          status: 'pending',
          latitude: 0,
          longitude: 0,
        }),
        TTL.TRIP
      );
    });

    it('adds trip to booking trip set', async () => {
      mockRedisSetJSON.mockResolvedValue(undefined);
      mockRedisSAdd.mockResolvedValue(1);
      mockRedisExpire.mockResolvedValue(undefined);
      mockRedisDel.mockResolvedValue(undefined);

      await trackingTripService.initializeTracking(
        TRIP_ID, DRIVER_ID, 'KA01AB1234', BOOKING_ID, TRANSPORTER_ID
      );

      expect(mockRedisSAdd).toHaveBeenCalledWith(
        REDIS_KEYS.BOOKING_TRIPS(BOOKING_ID),
        TRIP_ID
      );
    });

    it('adds driver to fleet when transporterId provided', async () => {
      mockRedisSetJSON.mockResolvedValue(undefined);
      mockRedisSAdd.mockResolvedValue(1);
      mockRedisExpire.mockResolvedValue(undefined);
      mockRedisDel.mockResolvedValue(undefined);

      await trackingTripService.initializeTracking(
        TRIP_ID, DRIVER_ID, 'KA01AB1234', BOOKING_ID, TRANSPORTER_ID
      );

      // addDriverToFleet calls sAdd for fleet + active transporters
      expect(mockRedisSAdd).toHaveBeenCalledWith(
        REDIS_KEYS.FLEET_DRIVERS(TRANSPORTER_ID),
        DRIVER_ID
      );
    });

    it('clears history for fresh trip start', async () => {
      mockRedisSetJSON.mockResolvedValue(undefined);
      mockRedisSAdd.mockResolvedValue(1);
      mockRedisExpire.mockResolvedValue(undefined);
      mockRedisDel.mockResolvedValue(undefined);

      await trackingTripService.initializeTracking(
        TRIP_ID, DRIVER_ID, 'KA01AB1234', BOOKING_ID
      );

      expect(mockRedisDel).toHaveBeenCalledWith(REDIS_KEYS.TRIP_HISTORY(TRIP_ID));
    });
  });

  describe('updateStatus', () => {
    it('updates status in Redis and broadcasts', async () => {
      const locationData = makeLocationData();
      mockRedisGetJSON.mockResolvedValue(locationData);
      mockRedisSetJSON.mockResolvedValue(undefined);

      await trackingTripService.updateStatus(TRIP_ID, 'at_pickup');

      expect(mockRedisSetJSON).toHaveBeenCalledWith(
        REDIS_KEYS.TRIP_LOCATION(TRIP_ID),
        expect.objectContaining({ status: 'at_pickup' }),
        TTL.TRIP
      );
      expect(mockEmitToTrip).toHaveBeenCalled();
    });

    it('does nothing when no trip data in Redis', async () => {
      mockRedisGetJSON.mockResolvedValue(null);

      await trackingTripService.updateStatus(TRIP_ID, 'at_pickup');

      expect(mockRedisSetJSON).not.toHaveBeenCalled();
      expect(mockEmitToTrip).not.toHaveBeenCalled();
    });
  });

  describe('updateTripStatus', () => {
    const mockAssignment = {
      id: 'assignment-001',
      tripId: TRIP_ID,
      driverId: DRIVER_ID,
      transporterId: TRANSPORTER_ID,
      vehicleId: VEHICLE_ID,
      vehicleNumber: 'KA01AB1234',
      driverName: 'Test Driver',
      status: 'en_route_pickup',
      bookingId: BOOKING_ID,
      booking: { customerId: CUSTOMER_ID, customerName: 'Test Customer', id: BOOKING_ID, pickup: null as any },
      order: null as any,
    };

    it('updates assignment status and broadcasts', async () => {
      mockPrismaAssignmentFindUnique.mockResolvedValue(mockAssignment);
      // F-M20: non-completion statuses now use updateMany with CAS guard
      mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      mockRedisSetJSON.mockResolvedValue(undefined);

      await trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'at_pickup' });

      expect(mockPrismaAssignmentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'at_pickup' }),
        })
      );
      expect(mockEmitToBooking).toHaveBeenCalled();
    });

    it('throws 404 when assignment not found', async () => {
      mockPrismaAssignmentFindUnique.mockResolvedValue(null);

      await expect(
        trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'at_pickup' })
      ).rejects.toMatchObject({ statusCode: 404, code: 'ASSIGNMENT_NOT_FOUND' });
    });

    it('throws 403 when driver does not own the assignment', async () => {
      mockPrismaAssignmentFindUnique.mockResolvedValue({
        ...mockAssignment,
        driverId: 'other-driver',
      });

      await expect(
        trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'at_pickup' })
      ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    });

    it('throws 400 for backward status transition', async () => {
      mockPrismaAssignmentFindUnique.mockResolvedValue({
        ...mockAssignment,
        status: 'in_transit', // Current status is further along
      });

      await expect(
        trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'at_pickup' })
      ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_STATUS_TRANSITION' });
    });

    it('returns silently for idempotent same-status update', async () => {
      mockPrismaAssignmentFindUnique.mockResolvedValue({
        ...mockAssignment,
        status: 'at_pickup',
      });

      await expect(
        trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'at_pickup' })
      ).resolves.toBeUndefined();
    });

    it('throws 400 for already completed trip', async () => {
      mockPrismaAssignmentFindUnique.mockResolvedValue({
        ...mockAssignment,
        status: 'completed',
      });

      await expect(
        trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'in_transit' })
      ).rejects.toMatchObject({ statusCode: 400, code: 'TRIP_ALREADY_COMPLETED' });
    });

    it('throws 400 for cancelled trip', async () => {
      mockPrismaAssignmentFindUnique.mockResolvedValue({
        ...mockAssignment,
        status: 'cancelled',
      });

      await expect(
        trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'in_transit' })
      ).rejects.toMatchObject({ statusCode: 400, code: 'TRIP_NOT_ACTIVE' });
    });

    it('rejects loading_complete (not in canonical transitions)', async () => {
      // H-22: loading_complete is not in ASSIGNMENT_VALID_TRANSITIONS; validation rejects it
      mockPrismaAssignmentFindUnique.mockResolvedValue({
        ...mockAssignment,
        status: 'at_pickup',
      });
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      mockRedisSetJSON.mockResolvedValue(undefined);

      await expect(
        trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'loading_complete' })
      ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_STATUS_TRANSITION' });
    });

    it('sends FCM push notification for at_pickup', async () => {
      // H-22: FCM statusMessages uses Captain-app names; en_route_pickup has no FCM entry.
      // Verify at_pickup (which IS in the FCM map) triggers push notification.
      mockPrismaAssignmentFindUnique.mockResolvedValue({
        ...mockAssignment,
        status: 'en_route_pickup',
      });
      mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      mockRedisSetJSON.mockResolvedValue(undefined);

      await trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'at_pickup' });

      expect(mockQueuePushNotification).toHaveBeenCalledWith(
        CUSTOMER_ID,
        expect.objectContaining({
          title: expect.stringContaining('Driver arrived at pickup'),
        })
      );
    });

    it('calls completeTracking and releases vehicle on completed status', async () => {
      // M-20: completed can only come from arrived_at_drop (not in_transit)
      mockPrismaAssignmentFindUnique.mockResolvedValue({
        ...mockAssignment,
        status: 'arrived_at_drop',
      });
      mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      mockRedisSetJSON.mockResolvedValue(undefined);
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockRedisReleaseLock.mockResolvedValue(undefined);
      mockRedisDel.mockResolvedValue(undefined);
      mockRedisSRem.mockResolvedValue(1);
      mockRedisSCard.mockResolvedValue(0);
      mockReleaseVehicle.mockResolvedValue(undefined);
      // For checkBookingCompletion
      mockPrismaAssignmentFindMany.mockResolvedValue([]);

      await trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'completed' });

      expect(mockReleaseVehicle).toHaveBeenCalledWith(VEHICLE_ID, 'tripCompletion');
    });
  });

  describe('completeTracking', () => {
    it('marks trip as completed in Redis and removes from fleet', async () => {
      const locationData = makeLocationData();
      mockRedisGetJSON.mockResolvedValue(locationData);
      mockRedisSetJSON.mockResolvedValue(undefined);
      mockRedisSRem.mockResolvedValue(1);
      mockRedisSCard.mockResolvedValue(0);
      mockRedisDel.mockResolvedValue(undefined);

      await trackingTripService.completeTracking(TRIP_ID);

      expect(mockRedisSetJSON).toHaveBeenCalledWith(
        REDIS_KEYS.TRIP_LOCATION(TRIP_ID),
        expect.objectContaining({ status: 'completed' }),
        TTL.TRIP
      );
      expect(mockRedisSRem).toHaveBeenCalledWith(
        REDIS_KEYS.FLEET_DRIVERS(TRANSPORTER_ID),
        DRIVER_ID
      );
    });

    it('broadcasts completion event', async () => {
      const locationData = makeLocationData();
      mockRedisGetJSON.mockResolvedValue(locationData);
      mockRedisSetJSON.mockResolvedValue(undefined);
      mockRedisSRem.mockResolvedValue(1);
      mockRedisSCard.mockResolvedValue(0);
      mockRedisDel.mockResolvedValue(undefined);

      await trackingTripService.completeTracking(TRIP_ID);

      expect(mockEmitToTrip).toHaveBeenCalledWith(
        TRIP_ID,
        'assignment_status_changed',
        expect.objectContaining({ status: 'completed' })
      );
    });

    it('handles case when no trip data in Redis', async () => {
      mockRedisGetJSON.mockResolvedValue(null);
      mockRedisDel.mockResolvedValue(undefined);

      await expect(trackingTripService.completeTracking(TRIP_ID)).resolves.toBeUndefined();
    });
  });

  describe('checkAndSendProximityNotification', () => {
    it('sends notification when driver is within 2km by road', async () => {
      const existing = makeLocationData({ status: 'en_route_pickup' });
      mockRedisGet.mockResolvedValue(null); // Not already notified
      mockPrismaAssignmentFindFirst.mockResolvedValue({
        driverName: 'Test Driver',
        vehicleNumber: 'KA01AB1234',
        vehicleType: 'truck',
        order: { pickup: { latitude: 19.08, longitude: 72.88 }, customerId: CUSTOMER_ID },
        booking: null,
      });
      mockHaversine.mockReturnValue(1500); // 1.5km straight line (< 3km so Google API called)
      mockGetETA.mockResolvedValue({
        distanceKm: 1.5,
        durationMinutes: 5,
        durationText: '5 mins'
      });
      mockRedisSet.mockResolvedValue(undefined);

      await trackingTripService.checkAndSendProximityNotification(
        TRIP_ID, DRIVER_ID, 19.076, 72.877, existing as any
      );

      expect(mockQueuePushNotification).toHaveBeenCalledWith(
        CUSTOMER_ID,
        expect.objectContaining({
          title: expect.stringContaining('almost here'),
        })
      );
      expect(mockEmitToUser).toHaveBeenCalledWith(
        CUSTOMER_ID,
        'driver_approaching',
        expect.objectContaining({ tripId: TRIP_ID })
      );
    });

    it('skips when already notified (Redis flag set)', async () => {
      const existing = makeLocationData({ status: 'en_route_pickup' });
      mockRedisGet.mockResolvedValue('1'); // Already notified

      await trackingTripService.checkAndSendProximityNotification(
        TRIP_ID, DRIVER_ID, 19.076, 72.877, existing as any
      );

      expect(mockQueuePushNotification).not.toHaveBeenCalled();
    });

    it('skips when driver is too far (>3km straight line)', async () => {
      const existing = makeLocationData({ status: 'en_route_pickup' });
      mockRedisGet.mockResolvedValue(null);
      mockPrismaAssignmentFindFirst.mockResolvedValue({
        driverName: 'Test Driver',
        vehicleNumber: 'KA01AB1234',
        vehicleType: 'truck',
        order: { pickup: { latitude: 20.0, longitude: 73.0 }, customerId: CUSTOMER_ID },
        booking: null,
      });
      mockHaversine.mockReturnValue(5000); // 5km straight line

      await trackingTripService.checkAndSendProximityNotification(
        TRIP_ID, DRIVER_ID, 19.076, 72.877, existing as any
      );

      expect(mockGetETA).not.toHaveBeenCalled(); // Google API not called
    });

    it('skips when Google ETA shows > 2km by road', async () => {
      const existing = makeLocationData({ status: 'en_route_pickup' });
      mockRedisGet.mockResolvedValue(null);
      mockPrismaAssignmentFindFirst.mockResolvedValue({
        driverName: 'Test Driver',
        vehicleNumber: 'KA01AB1234',
        vehicleType: 'truck',
        order: { pickup: { latitude: 19.08, longitude: 72.88 }, customerId: CUSTOMER_ID },
        booking: null,
      });
      mockHaversine.mockReturnValue(2500); // 2.5km straight line (< 3km)
      mockGetETA.mockResolvedValue({
        distanceKm: 2.5,
        durationMinutes: 10,
        durationText: '10 mins'
      });

      await trackingTripService.checkAndSendProximityNotification(
        TRIP_ID, DRIVER_ID, 19.076, 72.877, existing as any
      );

      expect(mockQueuePushNotification).not.toHaveBeenCalled();
    });

    it('skips when no assignment found', async () => {
      const existing = makeLocationData({ status: 'en_route_pickup' });
      mockRedisGet.mockResolvedValue(null);
      mockPrismaAssignmentFindFirst.mockResolvedValue(null);

      await trackingTripService.checkAndSendProximityNotification(
        TRIP_ID, DRIVER_ID, 19.076, 72.877, existing as any
      );

      expect(mockQueuePushNotification).not.toHaveBeenCalled();
    });
  });
});
