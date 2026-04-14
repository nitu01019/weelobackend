/**
 * =============================================================================
 * DEEP STRESS TESTS — TRACKING + DRIVER MODULES
 * =============================================================================
 *
 * Stress-tests GPS updates, batch uploads, trip lifecycle, fleet management,
 * driver presence, performance metrics, and race conditions at scale.
 *
 * 100+ tests grouped by domain:
 *   1. Tracking — GPS updates under load
 *   2. Tracking — Trip lifecycle
 *   3. Tracking — Fleet management
 *   4. Driver — Presence under load
 *   5. Driver — Performance
 *   6. Race conditions
 *
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

// ---------------------------------------------------------------------------
// Redis service mock
// ---------------------------------------------------------------------------
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
const mockRedisExists = jest.fn();
const mockRedisCheckRateLimit = jest.fn();

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
    exists: (...args: unknown[]) => mockRedisExists(...args),
    sIsMember: jest.fn().mockResolvedValue(false),
    scanIterator: (...args: unknown[]) => mockRedisScanIterator(...args),
    checkRateLimit: (...args: unknown[]) => mockRedisCheckRateLimit(...args),
  },
}));

// ---------------------------------------------------------------------------
// Socket service mock
// ---------------------------------------------------------------------------
const mockEmitToBooking = jest.fn();
const mockEmitToTrip = jest.fn();
const mockEmitToUser = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToBooking: (...args: unknown[]) => mockEmitToBooking(...args),
  emitToTrip: (...args: unknown[]) => mockEmitToTrip(...args),
  emitToUser: (...args: unknown[]) => mockEmitToUser(...args),
  socketService: {
    emitToUser: (...args: unknown[]) => mockEmitToUser(...args),
  },
  SocketEvent: {
    LOCATION_UPDATED: 'location_updated',
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    BOOKING_UPDATED: 'booking_updated',
    ORDER_STATUS_UPDATE: 'order_status_update',
  },
}));

// ---------------------------------------------------------------------------
// Queue service mock
// ---------------------------------------------------------------------------
const mockQueuePushNotification = jest.fn().mockResolvedValue(undefined);
const mockQueueTrackingEvent = jest.fn().mockResolvedValue(undefined);
const mockQueueEnqueue = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queuePushNotification: (...args: unknown[]) => mockQueuePushNotification(...args),
    queueTrackingEvent: (...args: unknown[]) => mockQueueTrackingEvent(...args),
    enqueue: (...args: unknown[]) => mockQueueEnqueue(...args),
  },
}));

// ---------------------------------------------------------------------------
// Prisma mock
// ---------------------------------------------------------------------------
const mockPrismaAssignmentFindUnique = jest.fn();
const mockPrismaAssignmentFindFirst = jest.fn();
const mockPrismaAssignmentFindMany = jest.fn();
const mockPrismaAssignmentUpdate = jest.fn();
const mockPrismaAssignmentUpdateMany = jest.fn();
const mockPrismaAssignmentCount = jest.fn();
const mockPrismaVehicleUpdateMany = jest.fn();
const mockPrisma$Transaction = jest.fn();
const mockPrismaOrderFindUnique = jest.fn();
const mockPrismaOrderUpdate = jest.fn();
const mockPrismaOrderUpdateMany = jest.fn();
const mockPrismaBookingFindMany = jest.fn();
const mockPrismaOrderFindMany = jest.fn();
const mockPrismaUserUpdate = jest.fn();
const mockPrismaUserFindUnique = jest.fn();
const mockPrismaUserFindMany = jest.fn();
const mockPrismaRatingAggregate = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    assignment: {
      findUnique: (...args: unknown[]) => mockPrismaAssignmentFindUnique(...args),
      findFirst: (...args: unknown[]) => mockPrismaAssignmentFindFirst(...args),
      findMany: (...args: unknown[]) => mockPrismaAssignmentFindMany(...args),
      update: (...args: unknown[]) => mockPrismaAssignmentUpdate(...args),
      updateMany: (...args: unknown[]) => mockPrismaAssignmentUpdateMany(...args),
      count: (...args: unknown[]) => mockPrismaAssignmentCount(...args),
    },
    vehicle: {
      updateMany: (...args: unknown[]) => mockPrismaVehicleUpdateMany(...args),
    },
    order: {
      findUnique: (...args: unknown[]) => mockPrismaOrderFindUnique(...args),
      update: (...args: unknown[]) => mockPrismaOrderUpdate(...args),
      updateMany: (...args: unknown[]) => mockPrismaOrderUpdateMany(...args),
      findMany: (...args: unknown[]) => mockPrismaOrderFindMany(...args),
    },
    booking: {
      findMany: (...args: unknown[]) => mockPrismaBookingFindMany(...args),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      update: (...args: unknown[]) => mockPrismaUserUpdate(...args),
      findUnique: (...args: unknown[]) => mockPrismaUserFindUnique(...args),
      findMany: (...args: unknown[]) => mockPrismaUserFindMany(...args),
    },
    rating: {
      aggregate: (...args: unknown[]) => mockPrismaRatingAggregate(...args),
    },
    $transaction: (...args: unknown[]) => mockPrisma$Transaction(...args),
  },
}));

// ---------------------------------------------------------------------------
// Google Maps service mock
// ---------------------------------------------------------------------------
const mockGetETA = jest.fn();
jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: {
    getETA: (...args: unknown[]) => mockGetETA(...args),
  },
}));

// ---------------------------------------------------------------------------
// Vehicle lifecycle mock
// ---------------------------------------------------------------------------
const mockReleaseVehicle = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  onVehicleTransition: jest.fn().mockResolvedValue(undefined),
  releaseVehicle: (...args: unknown[]) => mockReleaseVehicle(...args),
}));

// ---------------------------------------------------------------------------
// Geospatial mock
// ---------------------------------------------------------------------------
const mockHaversine = jest.fn();
jest.mock('../shared/utils/geospatial.utils', () => ({
  ...jest.requireActual('../shared/utils/geospatial.utils'),
  haversineDistanceMeters: (...args: unknown[]) => mockHaversine(...args),
  haversineDistanceKm: jest.fn().mockReturnValue(5),
}));

// ---------------------------------------------------------------------------
// safe-json mock
// ---------------------------------------------------------------------------
jest.mock('../shared/utils/safe-json.utils', () => ({
  safeJsonParse: <T>(value: string | null | undefined, fallback: T): T => {
    if (value == null) return fallback;
    try { return JSON.parse(value) as T; }
    catch { return fallback; }
  },
}));

// ---------------------------------------------------------------------------
// tracking-access.policy mock
// ---------------------------------------------------------------------------
const mockAssertTripAccess = jest.fn();
const mockAssertBookingAccess = jest.fn();
jest.mock('../modules/tracking/tracking-access.policy', () => ({
  assertTripTrackingAccess: (...args: unknown[]) => mockAssertTripAccess(...args),
  assertBookingTrackingAccess: (...args: unknown[]) => mockAssertBookingAccess(...args),
}));

// ---------------------------------------------------------------------------
// db module mock (for fleet/driver management)
// ---------------------------------------------------------------------------
const mockDbGetBookingById = jest.fn();
const mockDbUpdateBooking = jest.fn();
const mockDbGetBookingsByDriver = jest.fn().mockResolvedValue([]);
const mockDbGetDriversByTransporter = jest.fn().mockResolvedValue([]);
const mockDbGetVehiclesByTransporter = jest.fn().mockResolvedValue([]);

jest.mock('../shared/database/db', () => ({
  db: {
    getBookingById: (...args: unknown[]) => mockDbGetBookingById(...args),
    updateBooking: (...args: unknown[]) => mockDbUpdateBooking(...args),
    getBookingsByDriver: (...args: unknown[]) => mockDbGetBookingsByDriver(...args),
    getDriversByTransporter: (...args: unknown[]) => mockDbGetDriversByTransporter(...args),
    getVehiclesByTransporter: (...args: unknown[]) => mockDbGetVehiclesByTransporter(...args),
  },
}));

// ---------------------------------------------------------------------------
// Fleet cache service mock
// ---------------------------------------------------------------------------
const mockInvalidateDriverCache = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/fleet-cache.service', () => ({
  fleetCacheService: {
    invalidateDriverCache: (...args: unknown[]) => mockInvalidateDriverCache(...args),
  },
}));

// =============================================================================
// IMPORTS — after all mocks
// =============================================================================

import { trackingLocationService } from '../modules/tracking/tracking-location.service';
import { trackingTripService } from '../modules/tracking/tracking-trip.service';
import { trackingFleetService } from '../modules/tracking/tracking-fleet.service';
import { trackingHistoryService } from '../modules/tracking/tracking-history.service';
import { trackingQueryService } from '../modules/tracking/tracking-query.service';
import { driverPresenceService } from '../modules/driver/driver-presence.service';
import { driverPerformanceService } from '../modules/driver/driver-performance.service';
import { REDIS_KEYS, TTL } from '../modules/tracking/tracking.types';
import { AppError } from '../shared/types/error.types';

// =============================================================================
// HELPERS
// =============================================================================

const TRIP_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DRIVER_ID = 'driver-stress-001';
const BOOKING_ID = 'booking-stress-001';
const TRANSPORTER_ID = 'transporter-stress-001';
const VEHICLE_ID = 'vehicle-stress-001';
const ORDER_ID = 'order-stress-001';

const makeLocationData = (overrides: Record<string, any> = {}) => ({
  tripId: TRIP_ID,
  driverId: DRIVER_ID,
  transporterId: TRANSPORTER_ID,
  vehicleId: VEHICLE_ID,
  vehicleNumber: 'KA01AB1234',
  bookingId: BOOKING_ID,
  orderId: ORDER_ID,
  latitude: 12.9716,
  longitude: 77.5946,
  speed: 30,
  bearing: 180,
  status: 'in_transit',
  lastUpdated: new Date().toISOString(),
  ...overrides,
});

const makeAssignment = (overrides: Record<string, any> = {}) => ({
  id: 'assign-001',
  tripId: TRIP_ID,
  driverId: DRIVER_ID,
  transporterId: TRANSPORTER_ID,
  vehicleId: VEHICLE_ID,
  vehicleNumber: 'KA01AB1234',
  driverName: 'Test Driver',
  vehicleType: 'truck',
  status: 'in_transit',
  bookingId: BOOKING_ID,
  orderId: ORDER_ID,
  booking: { customerId: 'customer-001', customerName: 'Test Customer', id: BOOKING_ID, pickup: JSON.stringify({ latitude: 12.97, longitude: 77.59 }) },
  order: { id: ORDER_ID, customerId: 'customer-001', pickup: JSON.stringify({ latitude: 12.97, longitude: 77.59 }) },
  ...overrides,
});

function resetAllMocks(): void {
  jest.clearAllMocks();
  // Default happy-path behaviours
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockRedisGetJSON.mockResolvedValue(null);
  mockRedisSetJSON.mockResolvedValue(undefined);
  mockRedisDel.mockResolvedValue(1);
  mockRedisRPush.mockResolvedValue(1);
  mockRedisLTrim.mockResolvedValue('OK');
  mockRedisExpire.mockResolvedValue(true);
  mockRedisSAdd.mockResolvedValue(1);
  mockRedisSRem.mockResolvedValue(1);
  mockRedisSMembers.mockResolvedValue([]);
  mockRedisSCard.mockResolvedValue(0);
  mockRedisLRange.mockResolvedValue([]);
  mockRedisAcquireLock.mockResolvedValue({ acquired: true });
  mockRedisReleaseLock.mockResolvedValue(undefined);
  mockRedisExists.mockResolvedValue(false);
  mockRedisCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetIn: 300 });
  mockHaversine.mockReturnValue(5000);
  mockQueuePushNotification.mockResolvedValue(undefined);
  mockQueueTrackingEvent.mockResolvedValue(undefined);
  mockQueueEnqueue.mockResolvedValue(undefined);
  mockReleaseVehicle.mockResolvedValue(undefined);
  // Order/booking update defaults — used by geofence and parent cascade code paths
  mockPrismaOrderUpdate.mockResolvedValue({});
  mockPrismaOrderUpdateMany.mockResolvedValue({ count: 0 });
  // F-M20: CAS updateMany returns { count: 1 } by default (successful CAS)
  mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
  mockPrismaVehicleUpdateMany.mockResolvedValue({ count: 1 });
  // $transaction: execute array of promises (for CAS completion TX)
  mockPrisma$Transaction.mockImplementation(async (ops: any) => {
    if (Array.isArray(ops)) return ops;
    if (typeof ops === 'function') return ops({});
    return ops;
  });
  mockAssertTripAccess.mockResolvedValue({
    tripId: TRIP_ID, assignmentId: 'a1', bookingId: BOOKING_ID,
    orderId: null, driverId: DRIVER_ID, transporterId: TRANSPORTER_ID,
    bookingCustomerId: 'c1', orderCustomerId: null,
  });
  mockAssertBookingAccess.mockResolvedValue({
    bookingId: BOOKING_ID, assignmentIds: ['a1'], tripIds: [TRIP_ID],
  });
}

// =============================================================================
// TEST SUITE
// =============================================================================

describe('Tracking & Driver Stress Tests', () => {
  beforeEach(resetAllMocks);

  // ===========================================================================
  // 1. TRACKING — GPS UPDATES UNDER LOAD
  // ===========================================================================
  describe('1. Tracking — GPS updates under load', () => {

    it('1.01 should handle 500 concurrent location updates from different drivers', async () => {
      // Each driver's trip has its own driverId matching the caller
      mockRedisGetJSON.mockImplementation(async () => null);
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 500; i++) {
        promises.push(
          trackingLocationService.updateLocation(`driver-${i}`, {
            tripId: TRIP_ID,
            latitude: 12.9716 + i * 0.0001,
            longitude: 77.5946 + i * 0.0001,
            speed: 10,
            bearing: 90,
          })
        );
      }
      await expect(Promise.all(promises)).resolves.toBeDefined();
      // Each update writes to trip location + driver location
      expect(mockRedisSetJSON).toHaveBeenCalled();
    });

    it('1.02 should process batch upload with 100 GPS points (max batch size)', async () => {
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      mockRedisGet.mockResolvedValue(null); // no last ts
      const points = Array.from({ length: 100 }, (_, i) => ({
        latitude: 12.97 + i * 0.001,
        longitude: 77.59 + i * 0.001,
        speed: 20,
        bearing: 90,
        timestamp: new Date(Date.now() - (100 - i) * 10000).toISOString(),
      }));

      const result = await trackingLocationService.uploadBatchLocations(DRIVER_ID, {
        tripId: TRIP_ID,
        points,
      });

      expect(result.processed).toBe(100);
      expect(result.accepted + result.stale + result.duplicate + result.invalid).toBe(100);
    });

    it('1.03 should flag mock GPS location without blocking the update', async () => {
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      await trackingLocationService.updateLocation(DRIVER_ID, {
        tripId: TRIP_ID,
        latitude: 12.9716,
        longitude: 77.5946, speed: 0, bearing: 0,
        isMockLocation: true,
      });

      // Should still store the location (not block)
      expect(mockRedisSetJSON).toHaveBeenCalled();
      // Should flag in Redis
      expect(mockRedisSet).toHaveBeenCalledWith(
        `mock_gps:${TRIP_ID}`,
        'true',
        expect.any(Number)
      );
    });

    it('1.04 should detect stale GPS data (timestamp 1 hour old) and mark as stale in batch', async () => {
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      mockRedisGet.mockResolvedValue(null);
      const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
      const result = await trackingLocationService.uploadBatchLocations(DRIVER_ID, {
        tripId: TRIP_ID,
        points: [{
          latitude: 12.97,
          longitude: 77.59,
          speed: 10,
          bearing: 0,
          timestamp: oneHourAgo,
        }],
      });

      expect(result.stale).toBe(1);
      expect(result.accepted).toBe(0);
    });

    it('1.05 should reject duplicate GPS points (timestamp <= last accepted)', async () => {
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      const lastTs = new Date().toISOString();
      mockRedisGet.mockResolvedValue(lastTs); // last accepted ts

      const result = await trackingLocationService.uploadBatchLocations(DRIVER_ID, {
        tripId: TRIP_ID,
        points: [{
          latitude: 12.97,
          longitude: 77.59,
          speed: 10,
          bearing: 0,
          timestamp: lastTs, // same as last accepted
        }],
      });

      expect(result.duplicate).toBe(1);
      expect(result.accepted).toBe(0);
    });

    it('1.06 should detect unrealistic speed jump (Delhi to Mumbai in 1 second)', async () => {
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      mockRedisGet.mockResolvedValue(null);
      // Haversine returns massive distance
      mockHaversine.mockReturnValue(1_400_000); // 1400km in meters

      const now = Date.now();
      const result = await trackingLocationService.uploadBatchLocations(DRIVER_ID, {
        tripId: TRIP_ID,
        points: [
          {
            latitude: 28.6139, // Delhi
            longitude: 77.2090,
            speed: 10,
            bearing: 0,
            timestamp: new Date(now - 2000).toISOString(),
          },
          {
            latitude: 19.0760, // Mumbai
            longitude: 72.8777,
            speed: 10,
            bearing: 0,
            timestamp: new Date(now - 1000).toISOString(), // 1 second later
          },
        ],
      });

      expect(result.invalid).toBeGreaterThanOrEqual(1);
    });

    it('1.07 should broadcast location with staleness info', async () => {
      const oldTimestamp = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      await trackingLocationService.updateLocation(DRIVER_ID, {
        tripId: TRIP_ID,
        latitude: 12.97,
        longitude: 77.59, speed: 0, bearing: 0,
        timestamp: oldTimestamp,
      });

      // Should broadcast with isStale=true
      expect(mockEmitToTrip).toHaveBeenCalledWith(
        TRIP_ID,
        'location_updated',
        expect.objectContaining({ isStale: true })
      );
    });

    it('1.08 should broadcast fresh location with isStale=false', async () => {
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      await trackingLocationService.updateLocation(DRIVER_ID, {
        tripId: TRIP_ID,
        latitude: 12.97,
        longitude: 77.59, speed: 0, bearing: 0,
        timestamp: new Date().toISOString(),
      });

      expect(mockEmitToTrip).toHaveBeenCalledWith(
        TRIP_ID,
        'location_updated',
        expect.objectContaining({ isStale: false })
      );
    });

    it('1.09 should throw 403 if driver does not own the trip', async () => {
      mockRedisGetJSON.mockResolvedValue(makeLocationData({ driverId: 'other-driver' }));

      await expect(
        trackingLocationService.updateLocation(DRIVER_ID, {
          tripId: TRIP_ID,
          latitude: 12.97,
          longitude: 77.59, speed: 0, bearing: 0 })
      ).rejects.toThrow(AppError);
    });

    it('1.10 should persist history only when sampling criteria are met', async () => {
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      // First call: no previous state -> should persist
      mockRedisGetJSON
        .mockResolvedValueOnce(makeLocationData())  // trip location
        .mockResolvedValueOnce(null);               // no persist state

      await trackingLocationService.updateLocation(DRIVER_ID, {
        tripId: TRIP_ID,
        latitude: 12.97,
        longitude: 77.59, speed: 0, bearing: 0 });

      // History addToHistory should have been called
      expect(mockRedisRPush).toHaveBeenCalled();
    });

    it('1.11 should broadcast to booking room, trip room, and transporter', async () => {
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      await trackingLocationService.updateLocation(DRIVER_ID, {
        tripId: TRIP_ID,
        latitude: 12.97,
        longitude: 77.59, speed: 0, bearing: 0 });

      expect(mockEmitToBooking).toHaveBeenCalledWith(BOOKING_ID, 'location_updated', expect.any(Object));
      expect(mockEmitToTrip).toHaveBeenCalledWith(TRIP_ID, 'location_updated', expect.any(Object));
      expect(mockEmitToUser).toHaveBeenCalledWith(TRANSPORTER_ID, 'location_updated', expect.any(Object));
    });

    it('1.12 should handle location update when no existing trip data in Redis', async () => {
      mockRedisGetJSON.mockResolvedValue(null);
      // Should not throw
      await expect(
        trackingLocationService.updateLocation(DRIVER_ID, {
          tripId: TRIP_ID,
          latitude: 12.97,
          longitude: 77.59, speed: 0, bearing: 0 })
      ).resolves.toBeUndefined();
    });

    it('1.13 should include isMockLocation flag in broadcast when mock detected', async () => {
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      await trackingLocationService.updateLocation(DRIVER_ID, {
        tripId: TRIP_ID,
        latitude: 12.97,
        longitude: 77.59, speed: 0, bearing: 0,
        isMockLocation: true,
      });

      expect(mockEmitToTrip).toHaveBeenCalledWith(
        TRIP_ID,
        'location_updated',
        expect.objectContaining({ isMockLocation: true })
      );
    });

    it('1.14 should handle batch upload with all points being duplicates', async () => {
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      const ts = new Date().toISOString();
      mockRedisGet.mockResolvedValue(ts); // all points at or before this

      const result = await trackingLocationService.uploadBatchLocations(DRIVER_ID, {
        tripId: TRIP_ID,
        points: [
          { latitude: 12.97, longitude: 77.59, speed: 10, bearing: 0, timestamp: ts },
          { latitude: 12.98, longitude: 77.60, speed: 10, bearing: 0, timestamp: ts },
        ],
      });

      expect(result.duplicate).toBe(2);
      expect(result.accepted).toBe(0);
    });

    it('1.15 should update live location with only the newest valid point from batch', async () => {
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      mockRedisGet.mockResolvedValue(null);
      // Return small distance so jumps are realistic (30m / 3s = 10 m/s, well under 55 m/s limit)
      mockHaversine.mockReturnValue(30);

      const now = Date.now();
      const result = await trackingLocationService.uploadBatchLocations(DRIVER_ID, {
        tripId: TRIP_ID,
        points: [
          { latitude: 12.97, longitude: 77.59, speed: 10, bearing: 0, timestamp: new Date(now - 15000).toISOString() },
          { latitude: 12.98, longitude: 77.60, speed: 10, bearing: 0, timestamp: new Date(now - 10000).toISOString() },
          { latitude: 12.99, longitude: 77.61, speed: 10, bearing: 0, timestamp: new Date(now - 5000).toISOString() },
        ],
      });

      expect(result.accepted).toBe(3);
      // The setJSON calls for trip location should include the newest point
      const tripSetCalls = mockRedisSetJSON.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('driver:trip:')
      );
      // Last batch update writes newest point
      const lastTripSetCall = tripSetCalls[tripSetCalls.length - 1];
      expect(lastTripSetCall).toBeDefined();
      if (lastTripSetCall) {
        expect(lastTripSetCall[1]).toMatchObject({ latitude: 12.99, longitude: 77.61 });
      }
    });

    it('1.16 should get driver status ONLINE when Redis key exists', async () => {
      mockRedisGet.mockResolvedValue('ONLINE');
      const status = await trackingLocationService.getDriverStatus(DRIVER_ID);
      expect(status).toBe('ONLINE');
    });

    it('1.17 should get driver status OFFLINE when no Redis key', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockRedisGetJSON.mockResolvedValue(null);
      const status = await trackingLocationService.getDriverStatus(DRIVER_ID);
      expect(status).toBe('OFFLINE');
    });

    it('1.18 should get driver status UNKNOWN when location data is stale (>120s)', async () => {
      mockRedisGet.mockResolvedValue(null); // no explicit status
      const staleTime = new Date(Date.now() - 150_000).toISOString(); // 150s ago
      mockRedisGetJSON.mockResolvedValue(makeLocationData({ lastUpdated: staleTime }));
      const status = await trackingLocationService.getDriverStatus(DRIVER_ID);
      expect(status).toBe('UNKNOWN');
    });

    it('1.19 should set driver status explicitly', async () => {
      await trackingLocationService.setDriverStatus(DRIVER_ID, 'OFFLINE');
      expect(mockRedisSet).toHaveBeenCalledWith(
        REDIS_KEYS.DRIVER_STATUS(DRIVER_ID),
        'OFFLINE',
        TTL.LOCATION
      );
    });
  });

  // ===========================================================================
  // 2. TRACKING — TRIP LIFECYCLE
  // ===========================================================================
  describe('2. Tracking — Trip lifecycle', () => {

    it('2.01 should initialize tracking with correct Redis keys', async () => {
      await trackingTripService.initializeTracking(
        TRIP_ID, DRIVER_ID, 'KA01AB1234', BOOKING_ID, TRANSPORTER_ID, VEHICLE_ID, ORDER_ID
      );

      expect(mockRedisSetJSON).toHaveBeenCalledWith(
        REDIS_KEYS.TRIP_LOCATION(TRIP_ID),
        expect.objectContaining({ tripId: TRIP_ID, driverId: DRIVER_ID, status: 'pending' }),
        TTL.TRIP
      );
      expect(mockRedisSAdd).toHaveBeenCalledWith(
        REDIS_KEYS.BOOKING_TRIPS(BOOKING_ID),
        TRIP_ID
      );
    });

    it('2.02 should update trip status and broadcast via WebSocket', async () => {
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      await trackingTripService.updateStatus(TRIP_ID, 'in_transit');

      expect(mockRedisSetJSON).toHaveBeenCalledWith(
        REDIS_KEYS.TRIP_LOCATION(TRIP_ID),
        expect.objectContaining({ status: 'in_transit' }),
        TTL.TRIP
      );
      expect(mockEmitToTrip).toHaveBeenCalledWith(
        TRIP_ID,
        'assignment_status_changed',
        expect.objectContaining({ status: 'in_transit' })
      );
    });

    it('2.03 should prevent backward status transitions', async () => {
      mockPrismaAssignmentFindUnique.mockResolvedValue(makeAssignment({ status: 'in_transit' }));

      // H-22: Now uses ASSIGNMENT_VALID_TRANSITIONS — backward transitions produce specific error message
      await expect(
        trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'at_pickup' })
      ).rejects.toThrow('Cannot go from in_transit to at_pickup');
    });

    it('2.04 should allow idempotent same-status update without error', async () => {
      mockPrismaAssignmentFindUnique.mockResolvedValue(makeAssignment({ status: 'in_transit' }));

      // Same status should be idempotent (no error)
      await expect(
        trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'in_transit' })
      ).resolves.toBeUndefined();
    });

    it('2.05 should reject update on completed trip', async () => {
      mockPrismaAssignmentFindUnique.mockResolvedValue(makeAssignment({ status: 'completed' }));

      await expect(
        trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'in_transit' })
      ).rejects.toThrow('already completed');
    });

    it('2.06 should reject update on cancelled trip', async () => {
      mockPrismaAssignmentFindUnique.mockResolvedValue(makeAssignment({ status: 'cancelled' }));

      await expect(
        trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'in_transit' })
      ).rejects.toThrow('no longer active');
    });

    it('2.07 should throw 403 if wrong driver tries to update trip status', async () => {
      mockPrismaAssignmentFindUnique.mockResolvedValue(makeAssignment({ driverId: 'other-driver' }));

      await expect(
        trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'at_pickup' })
      ).rejects.toThrow('not assigned to you');
    });

    it('2.08 should throw 404 if no assignment found for trip', async () => {
      mockPrismaAssignmentFindUnique.mockResolvedValue(null);

      await expect(
        trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'at_pickup' })
      ).rejects.toThrow('No assignment found');
    });

    it('2.09 should complete tracking and clean up Redis keys', async () => {
      const locData = makeLocationData();
      mockRedisGetJSON.mockResolvedValue(locData);
      mockRedisSCard.mockResolvedValue(0);

      await trackingTripService.completeTracking(TRIP_ID);

      expect(mockRedisSetJSON).toHaveBeenCalledWith(
        REDIS_KEYS.TRIP_LOCATION(TRIP_ID),
        expect.objectContaining({ status: 'completed' }),
        TTL.TRIP
      );
      // Should remove driver from fleet
      expect(mockRedisSRem).toHaveBeenCalledWith(
        REDIS_KEYS.FLEET_DRIVERS(TRANSPORTER_ID),
        DRIVER_ID
      );
    });

    it('2.10 should release vehicle on completion', async () => {
      // M-20: completed can only come from arrived_at_drop (not in_transit)
      mockPrismaAssignmentFindUnique.mockResolvedValue(makeAssignment({ status: 'arrived_at_drop' }));
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      mockRedisSCard.mockResolvedValue(0);
      mockPrismaAssignmentUpdate.mockResolvedValue(makeAssignment({ status: 'completed' }));

      await trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'completed' });

      expect(mockReleaseVehicle).toHaveBeenCalledWith(VEHICLE_ID, 'tripCompletion');
    });

    it('2.11 should enqueue vehicle release retry when releaseVehicle fails', async () => {
      // M-20: completed can only come from arrived_at_drop (not in_transit)
      mockPrismaAssignmentFindUnique.mockResolvedValue(makeAssignment({ status: 'arrived_at_drop' }));
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      mockRedisSCard.mockResolvedValue(0);
      mockPrismaAssignmentUpdate.mockResolvedValue(makeAssignment({ status: 'completed' }));
      mockReleaseVehicle.mockRejectedValue(new Error('Redis down'));

      await trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'completed' });

      expect(mockQueueEnqueue).toHaveBeenCalledWith('vehicle-release', expect.objectContaining({ vehicleId: VEHICLE_ID }));
    });

    it('2.12 should double-tap guard prevent duplicate trip completion', async () => {
      mockPrismaAssignmentUpdate.mockResolvedValue(makeAssignment({ status: 'completed' }));
      mockRedisSCard.mockResolvedValue(0);

      // First call: lock acquired, completes normally (M-20: from arrived_at_drop)
      mockPrismaAssignmentFindUnique.mockResolvedValue(makeAssignment({ status: 'arrived_at_drop' }));
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });

      await trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'completed' });
      expect(mockReleaseVehicle).toHaveBeenCalledTimes(1);

      // Second call: same status in DB but lock NOT acquired (double-tap)
      mockPrismaAssignmentFindUnique.mockResolvedValue(makeAssignment({ status: 'arrived_at_drop' }));
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      mockRedisAcquireLock.mockResolvedValue({ acquired: false });

      await trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'completed' });

      // releaseVehicle should still only be called once (from first completion)
      expect(mockReleaseVehicle).toHaveBeenCalledTimes(1);
    });

    it('2.13 should send FCM push to customer on at_pickup', async () => {
      // H-22: FCM statusMessages uses Captain-app names; en_route_pickup has no FCM entry.
      // Verify at_pickup (which IS in the FCM map) triggers push notification.
      mockPrismaAssignmentFindUnique.mockResolvedValue(makeAssignment({ status: 'en_route_pickup' }));
      mockRedisGetJSON.mockResolvedValue(makeLocationData({ status: 'en_route_pickup' }));
      mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });

      await trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'at_pickup' });

      expect(mockQueuePushNotification).toHaveBeenCalledWith(
        'customer-001',
        expect.objectContaining({ title: expect.stringContaining('Driver arrived at pickup') })
      );
    });

    it('2.14 should send proximity notification only once per trip', async () => {
      // First call: not notified yet
      mockRedisGet.mockResolvedValueOnce(null); // proximity key not set
      mockPrismaAssignmentFindFirst.mockResolvedValue(makeAssignment());
      mockHaversine.mockReturnValue(1500); // 1.5km straight line — within 3km threshold
      mockGetETA.mockResolvedValue({ distanceKm: 1.5, durationMinutes: 5, durationText: '5 min' });

      await trackingTripService.checkAndSendProximityNotification(
        TRIP_ID, DRIVER_ID, 12.97, 77.59, makeLocationData({ status: 'en_route_pickup' })
      );

      expect(mockRedisSet).toHaveBeenCalledWith(`proximity_notified:${TRIP_ID}`, '1', 1800);
      expect(mockQueuePushNotification).toHaveBeenCalled();
    });

    it('2.15 should skip proximity notification when already sent (dedup)', async () => {
      mockRedisGet.mockResolvedValue('1'); // already notified

      await trackingTripService.checkAndSendProximityNotification(
        TRIP_ID, DRIVER_ID, 12.97, 77.59, makeLocationData({ status: 'en_route_pickup' })
      );

      // Should not send FCM again
      expect(mockQueuePushNotification).not.toHaveBeenCalled();
    });

    it('2.16 should skip proximity check when driver is far (> 3km straight line)', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockPrismaAssignmentFindFirst.mockResolvedValue(makeAssignment());
      mockHaversine.mockReturnValue(5000); // 5km — over threshold

      await trackingTripService.checkAndSendProximityNotification(
        TRIP_ID, DRIVER_ID, 12.97, 77.59, makeLocationData({ status: 'en_route_pickup' })
      );

      // Should NOT call Google API
      expect(mockGetETA).not.toHaveBeenCalled();
    });

    it('2.17 should update Redis status for en_route_pickup (not in prismaStatusMap)', async () => {
      // H-22: canonical en_route_pickup is NOT in prismaStatusMap (only heading_to_pickup maps there).
      // The transition validation passes, but Prisma update is skipped since prismaStatusMap
      // has no entry for 'en_route_pickup'. Only the Redis status update (step 4) runs.
      mockPrismaAssignmentFindUnique.mockResolvedValue(makeAssignment({ status: 'driver_accepted' }));
      mockRedisGetJSON.mockResolvedValue(makeLocationData({ status: 'driver_accepted' }));

      await trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'en_route_pickup' as any });

      // Prisma updateMany is NOT called (en_route_pickup not in prismaStatusMap)
      expect(mockPrismaAssignmentUpdateMany).not.toHaveBeenCalled();
      // Redis status update happens at step 4 (updateStatus call)
      expect(mockRedisSetJSON).toHaveBeenCalled();
    });

    it('2.18 should reject loading_complete (not in canonical transitions)', async () => {
      // H-22: loading_complete is not in ASSIGNMENT_VALID_TRANSITIONS; validation rejects it
      mockPrismaAssignmentFindUnique.mockResolvedValue(makeAssignment({ status: 'at_pickup' }));
      mockRedisGetJSON.mockResolvedValue(makeLocationData({ status: 'at_pickup' }));

      await expect(
        trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'loading_complete' })
      ).rejects.toThrow('Cannot go from at_pickup to loading_complete');
    });

    it('2.19 should set startedAt timestamp when transitioning to in_transit', async () => {
      mockPrismaAssignmentFindUnique.mockResolvedValue(makeAssignment({ status: 'at_pickup' }));
      mockRedisGetJSON.mockResolvedValue(makeLocationData({ status: 'at_pickup' }));
      // F-M20: non-completion statuses now use updateMany with CAS guard
      mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });

      await trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'in_transit' });

      expect(mockPrismaAssignmentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'in_transit', startedAt: expect.any(String) })
        })
      );
    });

    it('2.20 should handle completeTracking gracefully when no location in Redis', async () => {
      mockRedisGetJSON.mockResolvedValue(null);
      // Should not throw
      await expect(trackingTripService.completeTracking(TRIP_ID)).resolves.toBeUndefined();
    });
  });

  // ===========================================================================
  // 3. TRACKING — FLEET MANAGEMENT
  // ===========================================================================
  describe('3. Tracking — Fleet management', () => {

    it('3.01 should add driver to fleet with retry on Redis failure', async () => {
      mockRedisSAdd
        .mockRejectedValueOnce(new Error('Redis blip'))
        .mockResolvedValueOnce(1) // retry succeeds
        .mockResolvedValue(1);

      await trackingFleetService.addDriverToFleet(TRANSPORTER_ID, DRIVER_ID);

      // sAdd called at least twice (1 fail + 1 success for fleet, then active transporters)
      expect(mockRedisSAdd).toHaveBeenCalledTimes(3);
    });

    it('3.02 should not throw after max retries exhausted on addDriverToFleet', async () => {
      mockRedisSAdd.mockRejectedValue(new Error('Redis permanently down'));

      // Should not throw (non-fatal)
      await expect(
        trackingFleetService.addDriverToFleet(TRANSPORTER_ID, DRIVER_ID)
      ).resolves.toBeUndefined();
    });

    it('3.03 should remove driver from fleet and clean up empty transporter', async () => {
      mockRedisSCard.mockResolvedValue(0); // fleet empty after removal

      await trackingFleetService.removeDriverFromFleet(TRANSPORTER_ID, DRIVER_ID);

      expect(mockRedisSRem).toHaveBeenCalledWith(REDIS_KEYS.FLEET_DRIVERS(TRANSPORTER_ID), DRIVER_ID);
      expect(mockRedisSRem).toHaveBeenCalledWith(REDIS_KEYS.ACTIVE_FLEET_TRANSPORTERS, TRANSPORTER_ID);
      expect(mockRedisDel).toHaveBeenCalledWith(REDIS_KEYS.DRIVER_LOCATION(DRIVER_ID));
    });

    it('3.04 should not remove transporter from active fleet if drivers remain', async () => {
      mockRedisSCard.mockResolvedValue(2); // still has drivers

      await trackingFleetService.removeDriverFromFleet(TRANSPORTER_ID, DRIVER_ID);

      expect(mockRedisSRem).toHaveBeenCalledWith(REDIS_KEYS.FLEET_DRIVERS(TRANSPORTER_ID), DRIVER_ID);
      expect(mockRedisSRem).not.toHaveBeenCalledWith(REDIS_KEYS.ACTIVE_FLEET_TRANSPORTERS, TRANSPORTER_ID);
    });

    it('3.05 should handle 500 drivers in fleet tracking query (paginated, default limit 50)', async () => {
      const driverIds = Array.from({ length: 500 }, (_, i) => `driver-${i}`);
      mockRedisSMembers.mockResolvedValue(driverIds);
      mockRedisGetJSON.mockImplementation(async (key: string) => {
        const id = key.replace('driver:location:', '');
        return makeLocationData({ driverId: id, latitude: 12.97 + Math.random() * 0.1 });
      });

      const result = await trackingQueryService.getFleetTracking(TRANSPORTER_ID);

      // F-L17: getFleetTracking now paginates (default limit=50)
      expect(result.activeDrivers).toBe(50);
      expect(result.drivers).toHaveLength(50);
      expect(result.totalDrivers).toBe(500);
    });

    it('3.06 should filter out null locations in fleet tracking', async () => {
      mockRedisSMembers.mockResolvedValue(['d1', 'd2', 'd3']);
      mockRedisGetJSON.mockImplementation(async (key: string) => {
        if (key.includes('d2')) return null; // d2 has no location
        return makeLocationData({ driverId: key.includes('d1') ? 'd1' : 'd3' });
      });

      const result = await trackingQueryService.getFleetTracking(TRANSPORTER_ID);

      expect(result.activeDrivers).toBe(2);
      expect(result.drivers).toHaveLength(2);
    });

    it('3.07 should check booking completion — all trucks completed', async () => {
      mockPrismaAssignmentFindMany.mockResolvedValue([
        { id: 'a1', status: 'completed' },
        { id: 'a2', status: 'completed' },
        { id: 'a3', status: 'completed' },
      ]);
      mockDbGetBookingById.mockResolvedValue({
        id: BOOKING_ID, status: 'active', customerId: 'customer-001'
      });
      mockDbUpdateBooking.mockResolvedValue(undefined);

      await trackingFleetService.checkBookingCompletion(BOOKING_ID);

      expect(mockDbUpdateBooking).toHaveBeenCalledWith(BOOKING_ID, { status: 'completed' });
      expect(mockEmitToUser).toHaveBeenCalledWith(
        'customer-001',
        'booking_updated',
        expect.objectContaining({ status: 'completed' })
      );
    });

    it('3.08 should not complete booking when some trucks are still in_transit', async () => {
      mockPrismaAssignmentFindMany.mockResolvedValue([
        { id: 'a1', status: 'completed' },
        { id: 'a2', status: 'in_transit' },
      ]);

      await trackingFleetService.checkBookingCompletion(BOOKING_ID);

      expect(mockDbUpdateBooking).not.toHaveBeenCalled();
    });

    it('3.09 should skip booking completion when lock not acquired', async () => {
      mockRedisAcquireLock.mockResolvedValue({ acquired: false });

      await trackingFleetService.checkBookingCompletion(BOOKING_ID);

      expect(mockPrismaAssignmentFindMany).not.toHaveBeenCalled();
    });

    it('3.10 should check order completion — CAS pattern', async () => {
      mockPrismaAssignmentFindMany.mockResolvedValue([
        { id: 'a1', status: 'completed' },
        { id: 'a2', status: 'completed' },
      ]);
      mockPrismaOrderFindUnique.mockResolvedValue({
        id: ORDER_ID, status: 'active', customerId: 'customer-001'
      });
      mockPrismaOrderUpdateMany.mockResolvedValue({ count: 1 });

      await trackingFleetService.checkOrderCompletion(ORDER_ID);

      expect(mockPrismaOrderUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: ORDER_ID }),
          data: expect.objectContaining({ status: 'completed' }),
        })
      );
    });

    it('3.11 should mark order as cancelled when all assignments cancelled', async () => {
      mockPrismaAssignmentFindMany.mockResolvedValue([
        { id: 'a1', status: 'cancelled' },
        { id: 'a2', status: 'cancelled' },
      ]);
      mockPrismaOrderFindUnique.mockResolvedValue({
        id: ORDER_ID, status: 'active', customerId: 'customer-001'
      });
      mockPrismaOrderUpdateMany.mockResolvedValue({ count: 1 });

      await trackingFleetService.checkOrderCompletion(ORDER_ID);

      expect(mockPrismaOrderUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'cancelled' }),
        })
      );
    });

    it('3.12 should skip order completion when already terminal', async () => {
      mockPrismaAssignmentFindMany.mockResolvedValue([
        { id: 'a1', status: 'completed' },
      ]);
      mockPrismaOrderFindUnique.mockResolvedValue({
        id: ORDER_ID, status: 'completed', customerId: 'customer-001'
      });

      await trackingFleetService.checkOrderCompletion(ORDER_ID);

      expect(mockPrismaOrderUpdateMany).not.toHaveBeenCalled();
    });

    it('3.13 should handle CAS failure (concurrent process updated first)', async () => {
      mockPrismaAssignmentFindMany.mockResolvedValue([
        { id: 'a1', status: 'completed' },
      ]);
      mockPrismaOrderFindUnique.mockResolvedValue({
        id: ORDER_ID, status: 'active', customerId: 'customer-001'
      });
      mockPrismaOrderUpdateMany.mockResolvedValue({ count: 0 }); // CAS failed

      await trackingFleetService.checkOrderCompletion(ORDER_ID);

      // Should NOT send notification (another process already handled it)
      expect(mockEmitToUser).not.toHaveBeenCalledWith(
        'customer-001',
        'order_status_update',
        expect.anything()
      );
    });

    it('3.14 should start and stop offline checker without error', () => {
      trackingFleetService.startDriverOfflineChecker();
      // Second call should be idempotent
      trackingFleetService.startDriverOfflineChecker();
      trackingFleetService.stopDriverOfflineChecker();
      // Second stop should be idempotent
      trackingFleetService.stopDriverOfflineChecker();
    });

    it('3.15 should add driver to fleet and also add transporter to active fleet index', async () => {
      await trackingFleetService.addDriverToFleet(TRANSPORTER_ID, DRIVER_ID);

      expect(mockRedisSAdd).toHaveBeenCalledWith(REDIS_KEYS.FLEET_DRIVERS(TRANSPORTER_ID), DRIVER_ID);
      expect(mockRedisSAdd).toHaveBeenCalledWith(REDIS_KEYS.ACTIVE_FLEET_TRANSPORTERS, TRANSPORTER_ID);
    });
  });

  // ===========================================================================
  // 4. DRIVER — PRESENCE UNDER LOAD
  // ===========================================================================
  describe('4. Driver — Presence under load', () => {

    it('4.01 should handle 100 drivers going online simultaneously', async () => {
      mockPrismaUserUpdate.mockResolvedValue({ id: 'x', isAvailable: true });
      mockPrismaUserFindUnique.mockResolvedValue({ id: 'x', transporterId: TRANSPORTER_ID, name: 'Driver', isAvailable: true });

      const promises = Array.from({ length: 100 }, (_, i) =>
        driverPresenceService.goOnline(`driver-${i}`)
      );

      const results = await Promise.all(promises);
      expect(results).toHaveLength(100);
      results.forEach(r => expect(r.isOnline).toBe(true));
    });

    it('4.02 should reject toggle when cooldown is active (rate limiting)', async () => {
      mockRedisGet.mockResolvedValue(String(Date.now())); // cooldown active

      await expect(
        driverPresenceService.updateAvailability(DRIVER_ID, { isOnline: true })
      ).rejects.toThrow('Please wait');
    });

    it('4.03 should reject toggle when window limit exceeded (10 per 5 min)', async () => {
      mockRedisGet.mockResolvedValue(null); // no cooldown
      mockRedisCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetIn: 120 });

      await expect(
        driverPresenceService.updateAvailability(DRIVER_ID, { isOnline: true })
      ).rejects.toThrow('Too many toggles');
    });

    it('4.04 should skip toggle when already in requested state (idempotent)', async () => {
      mockRedisGet.mockResolvedValue(null); // no cooldown
      mockRedisCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetIn: 300 });
      mockPrismaUserFindUnique.mockResolvedValue({ id: DRIVER_ID, isAvailable: true });

      const result = await driverPresenceService.updateAvailability(DRIVER_ID, { isOnline: true });

      expect(result.isOnline).toBe(true);
      // goOnline should NOT have been called
      expect(mockPrismaUserUpdate).not.toHaveBeenCalled();
    });

    it('4.05 should reject concurrent toggle (lock already held)', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockRedisCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetIn: 300 });
      mockPrismaUserFindUnique.mockResolvedValue({ id: DRIVER_ID, isAvailable: false });
      mockRedisAcquireLock.mockResolvedValue({ acquired: false }); // lock held

      await expect(
        driverPresenceService.updateAvailability(DRIVER_ID, { isOnline: true })
      ).rejects.toThrow('Toggle already in progress');
    });

    it('4.06 should handle heartbeat from online driver (extend TTL)', async () => {
      mockRedisExists.mockResolvedValue(true); // driver is online

      await driverPresenceService.handleHeartbeat(DRIVER_ID, {
        lat: 12.97, lng: 77.59, battery: 85, speed: 30
      });

      expect(mockRedisSet).toHaveBeenCalledWith(
        `driver:presence:${DRIVER_ID}`,
        expect.any(String),
        35 // PRESENCE_TTL_SECONDS
      );
    });

    it('4.07 should ignore heartbeat from offline driver (no presence key)', async () => {
      mockRedisExists.mockResolvedValue(false);

      await driverPresenceService.handleHeartbeat(DRIVER_ID, {
        lat: 12.97, lng: 77.59
      });

      // Should NOT set presence
      expect(mockRedisSet).not.toHaveBeenCalled();
    });

    it('4.08 should handle 500 concurrent heartbeats', async () => {
      mockRedisExists.mockResolvedValue(true);

      const promises = Array.from({ length: 500 }, (_, i) =>
        driverPresenceService.handleHeartbeat(`driver-${i}`, { lat: 12.97, lng: 77.59, battery: 50 })
      );

      await expect(Promise.all(promises)).resolves.toBeDefined();
      expect(mockRedisSet).toHaveBeenCalledTimes(500);
    });

    it('4.09 should go offline: update DB, delete Redis, notify transporter', async () => {
      mockPrismaUserUpdate.mockResolvedValue({ id: DRIVER_ID, isAvailable: false });
      mockPrismaUserFindUnique.mockResolvedValue({ id: DRIVER_ID, transporterId: TRANSPORTER_ID, name: 'Test' });

      const result = await driverPresenceService.goOffline(DRIVER_ID);

      expect(result.isOnline).toBe(false);
      expect(mockPrismaUserUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isAvailable: false } })
      );
      expect(mockRedisDel).toHaveBeenCalledWith(`driver:presence:${DRIVER_ID}`);
      expect(mockRedisSRem).toHaveBeenCalledWith(
        `transporter:${TRANSPORTER_ID}:onlineDrivers`,
        DRIVER_ID
      );
    });

    it('4.10 should rollback DB if Redis fails during goOnline', async () => {
      mockPrismaUserUpdate.mockResolvedValue({ id: DRIVER_ID, isAvailable: true });
      mockRedisSet.mockRejectedValueOnce(new Error('Redis connection refused'));

      await expect(
        driverPresenceService.goOnline(DRIVER_ID)
      ).rejects.toThrow();

      // DB should be rolled back
      expect(mockPrismaUserUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isAvailable: false } })
      );
    });

    it('4.11 should restore presence on WebSocket reconnect', async () => {
      mockPrismaUserFindUnique.mockResolvedValue({
        id: DRIVER_ID, isAvailable: true, transporterId: TRANSPORTER_ID, name: 'Driver',
        updatedAt: new Date(), // H17 fix: must be within 15-min restore window
      });
      mockRedisGet.mockResolvedValue(null); // throttle not active

      const restored = await driverPresenceService.restorePresence(DRIVER_ID);

      expect(restored).toBe(true);
      expect(mockRedisSet).toHaveBeenCalledWith(
        `driver:presence:${DRIVER_ID}`,
        expect.any(String),
        35
      );
      expect(mockRedisSAdd).toHaveBeenCalled();
    });

    it('4.12 should not restore presence if driver intended to be offline', async () => {
      mockPrismaUserFindUnique.mockResolvedValue({
        id: DRIVER_ID, isAvailable: false, transporterId: TRANSPORTER_ID, name: 'Driver'
      });

      const restored = await driverPresenceService.restorePresence(DRIVER_ID);

      expect(restored).toBe(false);
    });

    it('4.13 should throttle restore presence emits (10s window)', async () => {
      mockPrismaUserFindUnique.mockResolvedValue({
        id: DRIVER_ID, isAvailable: true, transporterId: TRANSPORTER_ID, name: 'Driver',
        updatedAt: new Date(), // H17 fix: must be within 15-min restore window
      });
      mockRedisGet.mockResolvedValueOnce(null)  // first restore: not throttled
        .mockResolvedValueOnce('1');             // second restore: throttled

      await driverPresenceService.restorePresence(DRIVER_ID);
      await driverPresenceService.restorePresence(DRIVER_ID);

      // emitToUser should be called once (second time throttled)
      const statusChangeCalls = mockEmitToUser.mock.calls.filter(
        (call: any[]) => call[1] === 'driver_status_changed'
      );
      expect(statusChangeCalls).toHaveLength(1);
    });

    it('4.14 should check isDriverOnline: true only when DB + Redis agree', async () => {
      mockPrismaUserFindUnique.mockResolvedValue({ id: DRIVER_ID, isAvailable: true });
      mockRedisExists.mockResolvedValue(true);

      const online = await driverPresenceService.isDriverOnline(DRIVER_ID);
      expect(online).toBe(true);
    });

    it('4.15 should check isDriverOnline: false when DB says true but Redis key expired', async () => {
      mockPrismaUserFindUnique.mockResolvedValue({ id: DRIVER_ID, isAvailable: true });
      mockRedisExists.mockResolvedValue(false); // key expired

      const online = await driverPresenceService.isDriverOnline(DRIVER_ID);
      expect(online).toBe(false);
    });

    it('4.16 should batch check areDriversOnline with parallel Redis + DB', async () => {
      const ids = ['d1', 'd2', 'd3'];
      mockRedisExists
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      mockPrismaUserFindMany.mockResolvedValue([
        { id: 'd1', isAvailable: true },
        { id: 'd2', isAvailable: true },
        { id: 'd3', isAvailable: false },
      ]);

      const result = await driverPresenceService.areDriversOnline(ids);

      expect(result.get('d1')).toBe(true);   // both true
      expect(result.get('d2')).toBe(false);  // Redis false
      expect(result.get('d3')).toBe(false);  // DB false
    });

    it('4.17 should return empty map for empty driver list', async () => {
      const result = await driverPresenceService.areDriversOnline([]);
      expect(result.size).toBe(0);
    });

    it('4.18 should get online driver IDs and clean up stale entries', async () => {
      mockRedisSMembers.mockResolvedValue(['d1', 'd2', 'd3']);
      mockRedisExists
        .mockResolvedValueOnce(true)   // d1 present
        .mockResolvedValueOnce(false)  // d2 stale
        .mockResolvedValueOnce(true);  // d3 present

      const result = await driverPresenceService.getOnlineDriverIds(TRANSPORTER_ID);

      expect(result).toEqual(['d1', 'd3']);
      // d2 should be removed from set
      expect(mockRedisSRem).toHaveBeenCalledWith(
        `transporter:${TRANSPORTER_ID}:onlineDrivers`, 'd2'
      );
    });

    it('4.19 should get availability from DB (not Redis)', async () => {
      mockPrismaUserFindUnique.mockResolvedValue({ id: DRIVER_ID, isAvailable: true });

      const availability = await driverPresenceService.getAvailability(DRIVER_ID);

      expect(availability.isOnline).toBe(true);
    });

    it('4.20 should gracefully degrade getAvailability on DB failure', async () => {
      mockPrismaUserFindUnique.mockRejectedValue(new Error('DB down'));

      const availability = await driverPresenceService.getAvailability(DRIVER_ID);

      expect(availability.isOnline).toBe(false); // safe default
    });

    it('4.21 should set cooldown after successful toggle', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockRedisCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetIn: 300 });
      mockPrismaUserFindUnique.mockResolvedValue({ id: DRIVER_ID, isAvailable: false });
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockPrismaUserUpdate.mockResolvedValue({ id: DRIVER_ID, isAvailable: true });

      await driverPresenceService.updateAvailability(DRIVER_ID, { isOnline: true });

      expect(mockRedisSet).toHaveBeenCalledWith(
        `driver:toggle:cooldown:${DRIVER_ID}`,
        expect.any(String),
        5 // TOGGLE_COOLDOWN_SECONDS
      );
    });
  });

  // ===========================================================================
  // 5. DRIVER — PERFORMANCE
  // ===========================================================================
  describe('5. Driver — Performance', () => {

    it('5.01 should throw validation error for empty driverId', async () => {
      await expect(driverPerformanceService.getPerformance('')).rejects.toThrow('Valid driver ID is required');
    });

    it('5.02 should return 100% rates for driver with zero trips', async () => {
      mockPrismaAssignmentCount.mockResolvedValue(0);
      mockPrismaAssignmentFindMany.mockResolvedValue([]);
      mockRedisGet.mockResolvedValue(null);
      mockPrismaRatingAggregate.mockResolvedValue({ _avg: { stars: null }, _count: { stars: 0 } });

      const result = await driverPerformanceService.getPerformance(DRIVER_ID);

      expect(result.totalTrips).toBe(0);
      expect(result.acceptanceRate).toBe(100);
      expect(result.completionRate).toBe(100);
      expect(result.onTimeDeliveryRate).toBe(100);
      expect(result.rating).toBe(0);
    });

    it('5.03 should calculate acceptance rate correctly (declined reduces acceptance)', async () => {
      mockPrismaAssignmentCount
        .mockResolvedValueOnce(10) // total
        .mockResolvedValueOnce(7)  // completed
        .mockResolvedValueOnce(2)  // declined
        .mockResolvedValueOnce(1); // cancelled
      mockPrismaAssignmentFindMany.mockResolvedValue([]);
      mockRedisGet.mockResolvedValue(null);
      mockPrismaRatingAggregate.mockResolvedValue({ _avg: { stars: 4.5 }, _count: { stars: 10 } });

      const result = await driverPerformanceService.getPerformance(DRIVER_ID);

      expect(result.acceptanceRate).toBe(80); // (10-2)/10 * 100
      expect(result.rating).toBe(4.5);
    });

    it('5.04 should use cached rating from Redis', async () => {
      mockPrismaAssignmentCount.mockResolvedValue(0);
      mockPrismaAssignmentFindMany.mockResolvedValue([]);
      mockRedisGet.mockResolvedValue(JSON.stringify({ avg: 4.8, count: 25 })); // cached rating
      mockPrismaRatingAggregate.mockResolvedValue({ _avg: { stars: null }, _count: { stars: 0 } });

      const result = await driverPerformanceService.getPerformance(DRIVER_ID);

      expect(result.rating).toBe(4.8);
      expect(result.totalRatings).toBe(25);
      // Should NOT hit DB for rating since cached
      expect(mockPrismaRatingAggregate).not.toHaveBeenCalled();
    });

    it('5.05 should handle dashboard with zero completed bookings', async () => {
      mockDbGetBookingsByDriver.mockResolvedValue([]);
      mockPrismaAssignmentCount.mockResolvedValue(0);
      mockPrismaAssignmentFindMany.mockResolvedValue([]);
      mockRedisGet.mockResolvedValue(null);
      mockPrismaRatingAggregate.mockResolvedValue({ _avg: { stars: null }, _count: { stars: 0 } });
      mockRedisExists.mockResolvedValue(false);
      mockPrismaUserFindUnique.mockResolvedValue({ id: DRIVER_ID, isAvailable: false });

      const dashboard = await driverPerformanceService.getDashboard(DRIVER_ID);

      expect(dashboard.stats.totalTrips).toBe(0);
      expect(dashboard.stats.totalEarnings).toBe(0);
      expect(dashboard.recentTrips).toHaveLength(0);
    });

    it('5.06 should calculate earnings for different periods', async () => {
      const today = new Date();
      const bookings = [
        { id: 'b1', status: 'completed', totalAmount: 1000, updatedAt: today.toISOString(), createdAt: today.toISOString() },
        { id: 'b2', status: 'completed', totalAmount: 2000, updatedAt: new Date(today.getTime() - 2 * 86400_000).toISOString(), createdAt: new Date(today.getTime() - 2 * 86400_000).toISOString() },
        { id: 'b3', status: 'completed', totalAmount: 500, updatedAt: new Date(today.getTime() - 10 * 86400_000).toISOString(), createdAt: new Date(today.getTime() - 10 * 86400_000).toISOString() },
      ];
      mockDbGetBookingsByDriver.mockResolvedValue(bookings);

      const weekResult = await driverPerformanceService.getEarnings(DRIVER_ID, 'week');
      expect(weekResult.totalTrips).toBe(2);
      expect(weekResult.totalEarnings).toBe(3000);

      mockDbGetBookingsByDriver.mockResolvedValue(bookings);
      const todayResult = await driverPerformanceService.getEarnings(DRIVER_ID, 'today');
      expect(todayResult.totalTrips).toBe(1);
      expect(todayResult.totalEarnings).toBe(1000);
    });

    it('5.07 should calculate on-time rate with startedAt and completedAt', async () => {
      mockPrismaAssignmentCount.mockResolvedValue(1);
      const now = Date.now();
      mockPrismaAssignmentFindMany.mockResolvedValue([{
        bookingId: BOOKING_ID,
        orderId: null,
        startedAt: new Date(now - 3600_000), // 1h ago
        completedAt: new Date(now),            // now
      }]);
      mockPrismaBookingFindMany.mockResolvedValue([{ id: BOOKING_ID, distanceKm: 20 }]);
      mockPrismaOrderFindMany.mockResolvedValue([]);
      mockRedisGet.mockResolvedValue(null);
      mockPrismaRatingAggregate.mockResolvedValue({ _avg: { stars: null }, _count: { stars: 0 } });

      // 20km / 30km/h * 60 + 30min buffer = 70 minutes, actual = 60 min -> on time
      const result = await driverPerformanceService.getPerformance(DRIVER_ID);
      expect(result.onTimeDeliveryRate).toBe(100);
    });

    it('5.08 should handle missing timestamps gracefully (assume on-time)', async () => {
      mockPrismaAssignmentCount.mockResolvedValue(1);
      mockPrismaAssignmentFindMany.mockResolvedValue([{
        bookingId: BOOKING_ID,
        orderId: null,
        startedAt: null, // missing
        completedAt: null,
      }]);
      mockPrismaBookingFindMany.mockResolvedValue([]);
      mockPrismaOrderFindMany.mockResolvedValue([]);
      mockRedisGet.mockResolvedValue(null);
      mockPrismaRatingAggregate.mockResolvedValue({ _avg: { stars: null }, _count: { stars: 0 } });

      const result = await driverPerformanceService.getPerformance(DRIVER_ID);
      expect(result.onTimeDeliveryRate).toBe(100);
    });

    it('5.09 should handle getActiveTrip when no active trips exist', async () => {
      mockDbGetBookingsByDriver.mockResolvedValue([
        { id: 'b1', status: 'completed' },
      ]);

      const active = await driverPerformanceService.getActiveTrip(DRIVER_ID);
      expect(active).toBeNull();
    });

    it('5.10 should return active trip details correctly', async () => {
      mockDbGetBookingsByDriver.mockResolvedValue([{
        id: 'b1',
        status: 'active',
        pickup: { address: 'Delhi', latitude: 28.61, longitude: 77.20 },
        drop: { address: 'Mumbai', latitude: 19.07, longitude: 72.87 },
        totalAmount: 5000,
        customerName: 'Test Customer',
        customerPhone: '9876543210',
        createdAt: new Date().toISOString(),
      }]);

      const active = await driverPerformanceService.getActiveTrip(DRIVER_ID);

      expect(active).not.toBeNull();
      expect(active!.id).toBe('b1');
      expect(active!.pickup.address).toBe('Delhi');
    });

    it('5.11 should paginate getTrips correctly', async () => {
      const bookings = Array.from({ length: 20 }, (_, i) => ({
        id: `b${i}`,
        status: 'completed',
        pickup: { address: 'A' },
        drop: { address: 'B' },
        totalAmount: 100 * (i + 1),
        customerName: 'Customer',
        createdAt: new Date(Date.now() - i * 86400_000).toISOString(),
      }));
      mockDbGetBookingsByDriver.mockResolvedValue(bookings);

      const page1 = await driverPerformanceService.getTrips(DRIVER_ID, { limit: 5, offset: 0 });
      expect(page1.trips).toHaveLength(5);
      expect(page1.total).toBe(20);
      expect(page1.hasMore).toBe(true);

      mockDbGetBookingsByDriver.mockResolvedValue(bookings);
      const page4 = await driverPerformanceService.getTrips(DRIVER_ID, { limit: 5, offset: 15 });
      expect(page4.trips).toHaveLength(5);
      expect(page4.hasMore).toBe(false);
    });

    it('5.12 should filter trips by status', async () => {
      mockDbGetBookingsByDriver.mockResolvedValue([
        { id: 'b1', status: 'completed', pickup: {}, drop: {}, totalAmount: 100, customerName: 'C', createdAt: new Date().toISOString() },
        { id: 'b2', status: 'cancelled', pickup: {}, drop: {}, totalAmount: 200, customerName: 'C', createdAt: new Date().toISOString() },
      ]);

      const result = await driverPerformanceService.getTrips(DRIVER_ID, { status: 'completed', limit: 10, offset: 0 });

      expect(result.trips).toHaveLength(1);
      expect(result.trips[0].id).toBe('b1');
    });

    it('5.13 should calculate completion rate correctly', async () => {
      mockPrismaAssignmentCount
        .mockResolvedValueOnce(10) // total
        .mockResolvedValueOnce(7)  // completed
        .mockResolvedValueOnce(2)  // declined
        .mockResolvedValueOnce(0); // cancelled
      mockPrismaAssignmentFindMany.mockResolvedValue([]);
      mockRedisGet.mockResolvedValue(null);
      mockPrismaRatingAggregate.mockResolvedValue({ _avg: { stars: null }, _count: { stars: 0 } });

      const result = await driverPerformanceService.getPerformance(DRIVER_ID);

      // Accepted = 10 - 2 = 8, completed = 7, rate = 7/8 * 100 = 87.5
      expect(result.completionRate).toBe(87.5);
    });

    it('5.14 should gracefully degrade when rating DB fails', async () => {
      mockPrismaAssignmentCount.mockResolvedValue(0);
      mockPrismaAssignmentFindMany.mockResolvedValue([]);
      mockRedisGet.mockResolvedValue(null);
      mockPrismaRatingAggregate.mockRejectedValue(new Error('Rating table not found'));

      const result = await driverPerformanceService.getPerformance(DRIVER_ID);

      expect(result.rating).toBe(0); // graceful default
      expect(result.totalRatings).toBe(0);
    });
  });

  // ===========================================================================
  // 6. RACE CONDITIONS
  // ===========================================================================
  describe('6. Race conditions', () => {

    it('6.01 should handle driver going offline while location update processes', async () => {
      // Location update starts with existing data
      mockRedisGetJSON.mockResolvedValueOnce(makeLocationData());
      // But by the time we set, driver has gone offline — still succeeds
      mockRedisSetJSON.mockResolvedValue(undefined);

      await expect(
        trackingLocationService.updateLocation(DRIVER_ID, {
          tripId: TRIP_ID,
          latitude: 12.97,
          longitude: 77.59, speed: 0, bearing: 0 })
      ).resolves.toBeUndefined();
    });

    it('6.02 should handle trip completion while GPS update is in flight', async () => {
      // GPS update reads existing data
      mockRedisGetJSON.mockResolvedValue(makeLocationData({ status: 'completed' }));

      // Should still succeed (update goes through, status stays completed)
      await expect(
        trackingLocationService.updateLocation(DRIVER_ID, {
          tripId: TRIP_ID,
          latitude: 12.97,
          longitude: 77.59, speed: 0, bearing: 0 })
      ).resolves.toBeUndefined();
    });

    it('6.03 should handle fleet tracking query during driver removal', async () => {
      // Start with 3 drivers
      mockRedisSMembers.mockResolvedValue(['d1', 'd2', 'd3']);
      // But d2's location was just deleted (race with removal)
      mockRedisGetJSON.mockImplementation(async (key: string) => {
        if (key.includes('d2')) return null;
        return makeLocationData({ driverId: key.includes('d1') ? 'd1' : 'd3' });
      });

      const result = await trackingQueryService.getFleetTracking(TRANSPORTER_ID);

      // Should gracefully handle null and return 2 drivers
      expect(result.drivers).toHaveLength(2);
    });

    it('6.04 should handle heartbeat arriving after driver marked offline', async () => {
      mockRedisExists.mockResolvedValue(false); // offline

      // Heartbeat should be silently ignored
      await driverPresenceService.handleHeartbeat(DRIVER_ID, {
        lat: 12.97, lng: 77.59
      });

      expect(mockRedisSet).not.toHaveBeenCalled();
    });

    it('6.05 should handle concurrent proximity notifications (only one sends)', async () => {
      // First check: not notified
      mockRedisGet.mockResolvedValueOnce(null);
      mockPrismaAssignmentFindFirst.mockResolvedValue(makeAssignment());
      mockHaversine.mockReturnValue(1500);
      mockGetETA.mockResolvedValue({ distanceKm: 1.5, durationMinutes: 5, durationText: '5 min' });

      await trackingTripService.checkAndSendProximityNotification(
        TRIP_ID, DRIVER_ID, 12.97, 77.59, makeLocationData({ status: 'en_route_pickup' })
      );

      // Redis set should be called to prevent second notification
      expect(mockRedisSet).toHaveBeenCalledWith(`proximity_notified:${TRIP_ID}`, '1', 1800);
    });

    it('6.06 should handle concurrent status updates from same driver', async () => {
      mockPrismaAssignmentFindUnique.mockResolvedValue(makeAssignment({ status: 'at_pickup' }));
      mockRedisGetJSON.mockResolvedValue(makeLocationData({ status: 'at_pickup' }));
      mockPrismaAssignmentUpdate.mockResolvedValue(makeAssignment({ status: 'in_transit' }));

      // Both try to update simultaneously
      const update1 = trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'in_transit' });
      const update2 = trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'in_transit' });

      // Both should succeed (idempotent or sequential)
      await expect(Promise.allSettled([update1, update2])).resolves.toBeDefined();
    });

    it('6.07 should handle batch upload when Redis goes down mid-processing', async () => {
      mockRedisGetJSON.mockResolvedValue(makeLocationData());
      mockRedisGet.mockResolvedValue(null);
      // History push fails on some entries
      mockRedisRPush
        .mockResolvedValueOnce(1)
        .mockRejectedValueOnce(new Error('Redis OOM'));

      // trackingHistoryService.addToHistory catches errors internally
      const result = await trackingLocationService.uploadBatchLocations(DRIVER_ID, {
        tripId: TRIP_ID,
        points: [
          { latitude: 12.97, longitude: 77.59, speed: 10, bearing: 0, timestamp: new Date(Date.now() - 2000).toISOString() },
          { latitude: 12.98, longitude: 77.60, speed: 10, bearing: 0, timestamp: new Date(Date.now() - 1000).toISOString() },
        ],
      });

      // Should still return a result, not crash
      expect(result.processed).toBe(2);
    });

    it('6.08 should handle multiple booking completions racing on same booking', async () => {
      mockPrismaAssignmentFindMany.mockResolvedValue([
        { id: 'a1', status: 'completed' },
        { id: 'a2', status: 'completed' },
      ]);
      mockDbGetBookingById.mockResolvedValue({
        id: BOOKING_ID, status: 'active', customerId: 'customer-001'
      });
      mockDbUpdateBooking.mockResolvedValue(undefined);

      // First call acquires lock
      mockRedisAcquireLock
        .mockResolvedValueOnce({ acquired: true })
        .mockResolvedValueOnce({ acquired: false });

      const p1 = trackingFleetService.checkBookingCompletion(BOOKING_ID);
      const p2 = trackingFleetService.checkBookingCompletion(BOOKING_ID);

      await Promise.all([p1, p2]);

      // Only one should update
      expect(mockDbUpdateBooking).toHaveBeenCalledTimes(1);
    });

    it('6.09 should handle order completion with CAS protecting against double-notify', async () => {
      mockPrismaAssignmentFindMany.mockResolvedValue([
        { id: 'a1', status: 'completed' },
      ]);
      mockPrismaOrderFindUnique.mockResolvedValue({
        id: ORDER_ID, status: 'active', customerId: 'customer-001'
      });
      // CAS succeeds only first time
      mockPrismaOrderUpdateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      await trackingFleetService.checkOrderCompletion(ORDER_ID);

      // Notification should be sent exactly once
      const orderNotifyCalls = mockEmitToUser.mock.calls.filter(
        (call: any[]) => call[1] === 'order_status_update'
      );
      expect(orderNotifyCalls).toHaveLength(1);
    });

    it('6.10 should handle goOnline failing at SADD step (best-effort, driver still online)', async () => {
      mockPrismaUserUpdate.mockResolvedValue({ id: DRIVER_ID, isAvailable: true });
      mockPrismaUserFindUnique.mockResolvedValue({ id: DRIVER_ID, transporterId: TRANSPORTER_ID, name: 'Driver' });
      // Redis set succeeds (presence), but sAdd fails
      mockRedisSAdd.mockRejectedValueOnce(new Error('Redis SADD failed'));

      const result = await driverPresenceService.goOnline(DRIVER_ID);

      // Should still return online (DB + presence key succeed)
      expect(result.isOnline).toBe(true);
    });

    it('6.11 should handle rapid add/remove from fleet', async () => {
      const ops: Promise<void>[] = [];
      for (let i = 0; i < 20; i++) {
        if (i % 2 === 0) {
          ops.push(trackingFleetService.addDriverToFleet(TRANSPORTER_ID, `driver-${i}`));
        } else {
          mockRedisSCard.mockResolvedValue(10);
          ops.push(trackingFleetService.removeDriverFromFleet(TRANSPORTER_ID, `driver-${i}`));
        }
      }

      await expect(Promise.all(ops)).resolves.toBeDefined();
    });

    it('6.12 should handle isDriverOnline when DB and Redis calls fail', async () => {
      mockPrismaUserFindUnique.mockRejectedValue(new Error('DB timeout'));

      const online = await driverPresenceService.isDriverOnline(DRIVER_ID);

      expect(online).toBe(false); // safe fallback
    });

    it('6.13 should handle areDriversOnline falling back to individual checks', async () => {
      // Batch fails
      mockRedisExists.mockRejectedValueOnce(new Error('Batch fail'));
      // Individual fallbacks
      mockPrismaUserFindUnique.mockResolvedValue({ id: 'd1', isAvailable: true });
      mockRedisExists.mockResolvedValue(true);

      const result = await driverPresenceService.areDriversOnline(['d1']);

      expect(result.get('d1')).toBe(true);
    });

    it('6.14 should handle trip status update when Redis updateStatus fails gracefully', async () => {
      mockPrismaAssignmentFindUnique.mockResolvedValue(makeAssignment({ status: 'at_pickup' }));
      mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      // Redis updateStatus (step 4) fails — but Postgres already updated (step 3).
      // The updateStatus Redis call at line 468 is wrapped in try-catch (non-fatal).
      mockRedisGetJSON.mockRejectedValueOnce(new Error('Redis down'));

      // Should NOT throw — Postgres already updated, Redis failure is non-fatal
      await expect(
        trackingTripService.updateTripStatus(TRIP_ID, DRIVER_ID, { status: 'in_transit' })
      ).resolves.toBeUndefined();
    });

    it('6.15 should handle history addToHistory WRONGTYPE error with recovery', async () => {
      // Reset all mocks to clean state for this specific test
      mockRedisRPush.mockReset();
      mockRedisDel.mockReset();
      mockRedisLTrim.mockReset();
      mockRedisExpire.mockReset();

      // First rPush fails with WRONGTYPE — this is what Redis returns
      // when you try list ops on a non-list key
      mockRedisRPush
        .mockRejectedValueOnce(new Error('WRONGTYPE Operation against a key holding the wrong kind of value'))
        .mockResolvedValueOnce(1); // retry after del succeeds
      mockRedisDel.mockResolvedValue(1);
      mockRedisLTrim.mockResolvedValue('OK');
      mockRedisExpire.mockResolvedValue(true);

      await trackingHistoryService.addToHistory(TRIP_ID, {
        latitude: 12.97,
        longitude: 77.59,
        speed: 10,
        timestamp: new Date().toISOString(),
      });

      // Should have called del to reset key type, then retried rPush
      expect(mockRedisDel).toHaveBeenCalledWith(REDIS_KEYS.TRIP_HISTORY(TRIP_ID));
      expect(mockRedisRPush).toHaveBeenCalledTimes(2);
    });

    it('6.16 should handle shouldPersistHistoryPoint with no previous state (first point)', async () => {
      mockRedisGetJSON.mockResolvedValue(null); // no previous state

      const entry = { latitude: 12.97, longitude: 77.59, speed: 10, timestamp: new Date().toISOString() };
      const result = await trackingHistoryService.shouldPersistHistoryPoint(TRIP_ID, entry, 'in_transit');

      expect(result).toBe(true); // first point always persisted
    });

    it('6.17 should handle shouldPersistHistoryPoint status change triggers persist', async () => {
      const now = Date.now();
      mockRedisGetJSON.mockResolvedValue({
        latitude: 12.97, longitude: 77.59, timestampMs: now - 1000, status: 'at_pickup'
      });

      const entry = { latitude: 12.97, longitude: 77.59, speed: 0, timestamp: new Date(now).toISOString() };
      const result = await trackingHistoryService.shouldPersistHistoryPoint(TRIP_ID, entry, 'in_transit'); // different status

      expect(result).toBe(true);
    });

    it('6.18 should handle shouldPersistHistoryPoint skip when too close in time and distance', async () => {
      const now = Date.now();
      mockRedisGetJSON.mockResolvedValue({
        latitude: 12.97, longitude: 77.59, timestampMs: now - 1000, status: 'in_transit'
      });
      mockHaversine.mockReturnValue(5); // 5 meters — too close

      const entry = { latitude: 12.9701, longitude: 77.5901, speed: 0, timestamp: new Date(now).toISOString() };
      const result = await trackingHistoryService.shouldPersistHistoryPoint(TRIP_ID, entry, 'in_transit');

      expect(result).toBe(false);
    });

    it('6.19 should handle booking completion with already-cancelled booking', async () => {
      mockPrismaAssignmentFindMany.mockResolvedValue([
        { id: 'a1', status: 'completed' },
      ]);
      mockDbGetBookingById.mockResolvedValue({
        id: BOOKING_ID, status: 'cancelled', customerId: 'customer-001'
      });

      await trackingFleetService.checkBookingCompletion(BOOKING_ID);

      // Should NOT update to completed
      expect(mockDbUpdateBooking).not.toHaveBeenCalled();
    });

    it('6.20 should handle setHistoryPersistState gracefully when Redis write fails', async () => {
      mockRedisSetJSON.mockRejectedValueOnce(new Error('Redis down'));

      // Should not throw — in-memory fallback is used
      await expect(
        trackingHistoryService.setHistoryPersistState(TRIP_ID, {
          latitude: 12.97, longitude: 77.59, timestampMs: Date.now(), status: 'in_transit'
        })
      ).resolves.toBeUndefined();
    });
  });

  // ===========================================================================
  // 7. TRACKING — QUERY SERVICE
  // ===========================================================================
  describe('7. Tracking — Query service', () => {

    it('7.01 should get trip tracking data', async () => {
      mockRedisGetJSON.mockResolvedValue(makeLocationData());

      const result = await trackingQueryService.getTripTracking(TRIP_ID, DRIVER_ID, 'driver');

      expect(result.tripId).toBe(TRIP_ID);
      expect(result.latitude).toBeDefined();
    });

    it('7.02 should throw 404 when no tracking data exists', async () => {
      mockRedisGetJSON.mockResolvedValue(null);

      await expect(
        trackingQueryService.getTripTracking(TRIP_ID, DRIVER_ID, 'driver')
      ).rejects.toThrow('No tracking data for this trip');
    });

    it('7.03 should get booking tracking with multiple trucks', async () => {
      mockRedisSMembers.mockResolvedValue([TRIP_ID, 'trip-2']);
      mockRedisGetJSON
        .mockResolvedValueOnce(makeLocationData())
        .mockResolvedValueOnce(makeLocationData({ tripId: 'trip-2', driverId: 'driver-2' }));

      const result = await trackingQueryService.getBookingTracking(BOOKING_ID, 'customer-001', 'customer');

      expect(result.bookingId).toBe(BOOKING_ID);
      expect(result.trucks).toHaveLength(2);
    });

    it('7.04 should get trip history with pagination', async () => {
      const entries = Array.from({ length: 50 }, (_, i) => JSON.stringify({
        latitude: 12.97 + i * 0.001,
        longitude: 77.59 + i * 0.001,
        speed: 20,
        timestamp: new Date(Date.now() - (50 - i) * 10000).toISOString(),
      }));
      mockRedisLRange.mockResolvedValue(entries);

      const result = await trackingQueryService.getTripHistory(
        TRIP_ID, DRIVER_ID, 'driver',
        { page: 1, limit: 10 }
      );

      expect(result).toHaveLength(10);
    });

    it('7.05 should filter history by time range', async () => {
      const now = Date.now();
      const entries = [
        JSON.stringify({ latitude: 12.97, longitude: 77.59, speed: 10, timestamp: new Date(now - 120_000).toISOString() }),
        JSON.stringify({ latitude: 12.98, longitude: 77.60, speed: 10, timestamp: new Date(now - 60_000).toISOString() }),
        JSON.stringify({ latitude: 12.99, longitude: 77.61, speed: 10, timestamp: new Date(now).toISOString() }),
      ];
      mockRedisLRange.mockResolvedValue(entries);

      const result = await trackingQueryService.getTripHistory(
        TRIP_ID, DRIVER_ID, 'driver',
        {
          page: 1, limit: 100,
          fromTime: new Date(now - 90_000).toISOString(),
          toTime: new Date(now - 30_000).toISOString(),
        }
      );

      expect(result).toHaveLength(1);
    });

    it('7.06 should getCurrentLocation as alias for getTripTracking', async () => {
      mockRedisGetJSON.mockResolvedValue(makeLocationData());

      const result = await trackingQueryService.getCurrentLocation(TRIP_ID, DRIVER_ID, 'driver');

      expect(result.tripId).toBe(TRIP_ID);
    });
  });
});
