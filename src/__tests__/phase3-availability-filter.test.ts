/**
 * =============================================================================
 * PHASE 3 — AVAILABILITY FILTER (Online Check via smIsMembers)
 * =============================================================================
 *
 * Tests Issue #1 (CRITICAL): Verify that getAvailableTransportersWithDetails()
 * and getAvailableTransportersAsync() call smIsMembers to filter offline
 * transporters from broadcast candidates.
 *
 * Covers:
 * 1. Offline transporter NOT returned (smIsMembers returns false)
 * 2. Online transporter IS returned (smIsMembers returns true)
 * 3. Mix of online/offline — only online ones returned
 * 4. Redis-down: smIsMembers throws — fail-open (all candidates returned)
 * 5. Stale geo entry cleanup: offline transporter triggers geoRemove
 * 6. Empty transporter list — empty results, no crash
 * 7. All transporters offline — empty results
 *
 * Run: npx jest --testPathPattern="phase3-availability-filter" --forceExit
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
    recordHistogram: jest.fn(),
    observeHistogram: jest.fn(),
  },
}));

jest.mock('../config/environment', () => ({
  config: {
    redis: { enabled: true },
    isProduction: false,
    googleMaps: { apiKey: '' },
    otp: { expiryMinutes: 5 },
    sms: {},
  },
}));

// Redis mock functions
const mockGeoRadius = jest.fn();
const mockGeoRemove = jest.fn();
const mockSmIsMembers = jest.fn();
const mockHGetAllBatch = jest.fn();
const mockSRem = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(false),
    acquireLock: jest.fn().mockResolvedValue(true),
    releaseLock: jest.fn().mockResolvedValue(true),
    sMembers: jest.fn().mockResolvedValue([]),
    sAdd: jest.fn().mockResolvedValue(1),
    hGetAll: jest.fn().mockResolvedValue({}),
    hSet: jest.fn().mockResolvedValue(1),
    hDel: jest.fn().mockResolvedValue(1),
    sRem: (...args: any[]) => mockSRem(...args),
    hMSet: jest.fn().mockResolvedValue('OK'),
    eval: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(true),
    isConnected: jest.fn().mockReturnValue(true),
    isRedisEnabled: jest.fn().mockReturnValue(true),
    sCard: jest.fn().mockResolvedValue(0),
    sScan: jest.fn().mockResolvedValue(['0', []]),
    geoAdd: jest.fn().mockResolvedValue(1),
    geoRadius: (...args: any[]) => mockGeoRadius(...args),
    geoRemove: (...args: any[]) => mockGeoRemove(...args),
    smIsMembers: (...args: any[]) => mockSmIsMembers(...args),
    hGetAllBatch: (...args: any[]) => mockHGetAllBatch(...args),
    geoPos: jest.fn().mockResolvedValue(null),
    sIsMember: jest.fn().mockResolvedValue(false),
  },
}));

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    user: { findMany: jest.fn().mockResolvedValue([]) },
    vehicle: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (fn: any) => fn({})),
  },
}));

jest.mock('../shared/database/db', () => ({
  db: {
    getTransportersByVehicleKey: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../shared/services/h3-geo-index.service', () => ({
  h3GeoIndexService: {
    removeTransporter: jest.fn().mockResolvedValue(undefined),
    updateLocation: jest.fn().mockResolvedValue(undefined),
    getCandidates: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../shared/utils/geospatial.utils', () => ({
  haversineDistanceKm: jest.fn().mockReturnValue(5),
}));

// =============================================================================
// IMPORTS — after mocks
// =============================================================================

import { availabilityService } from '../shared/services/availability.service';
import { logger } from '../shared/services/logger.service';

// =============================================================================
// HELPERS
// =============================================================================

const VEHICLE_KEY = 'open_17ft';
const PICKUP_LAT = 28.6139;
const PICKUP_LNG = 77.209;

/** Build a GeoMember result as returned by geoRadius */
function geoMember(id: string, distance: number = 5.0) {
  return { member: id, distance };
}

/** Build a transporter details hash as stored in Redis */
function transporterDetails(
  id: string,
  overrides: Record<string, string> = {}
): Record<string, string> {
  return {
    transporterId: id,
    vehicleKey: VEHICLE_KEY,
    vehicleId: `v_${id}`,
    latitude: '28.6200',
    longitude: '77.2100',
    lastSeen: String(Date.now()),
    isOnTrip: 'false',
    ...overrides,
  };
}

// =============================================================================
// TESTS — getAvailableTransportersWithDetails (class method on AvailabilityService)
// =============================================================================

describe('Phase 3 — Availability Online Filter (Issue #1 CRITICAL)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGeoRemove.mockResolvedValue(1);
    mockSRem.mockResolvedValue(1);
  });

  // =========================================================================
  // getAvailableTransportersWithDetails
  // =========================================================================
  describe('getAvailableTransportersWithDetails — smIsMembers online check', () => {

    it('should NOT return offline transporters (smIsMembers returns false)', async () => {
      // Arrange: 1 transporter in geo, but offline
      mockGeoRadius.mockResolvedValue([geoMember('t_offline')]);
      mockHGetAllBatch.mockResolvedValue([transporterDetails('t_offline')]);
      mockSmIsMembers.mockResolvedValue([false]); // offline

      // Act
      const result = await availabilityService.getAvailableTransportersWithDetails(
        VEHICLE_KEY, PICKUP_LAT, PICKUP_LNG
      );

      // Assert
      expect(result).toHaveLength(0);
      expect(mockSmIsMembers).toHaveBeenCalledTimes(1);
      expect(mockSmIsMembers).toHaveBeenCalledWith(
        'online:transporters',
        ['t_offline']
      );
    });

    it('should return online transporters (smIsMembers returns true)', async () => {
      // Arrange: 1 transporter in geo, online
      mockGeoRadius.mockResolvedValue([geoMember('t_online', 3.2)]);
      mockHGetAllBatch.mockResolvedValue([transporterDetails('t_online')]);
      mockSmIsMembers.mockResolvedValue([true]); // online

      // Act
      const result = await availabilityService.getAvailableTransportersWithDetails(
        VEHICLE_KEY, PICKUP_LAT, PICKUP_LNG
      );

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].transporterId).toBe('t_online');
      expect(result[0].distance).toBe(3.2);
    });

    it('should return ONLY online transporters from a mixed set', async () => {
      // Arrange: 3 transporters — 2 online, 1 offline
      mockGeoRadius.mockResolvedValue([
        geoMember('t_on1', 2.0),
        geoMember('t_off1', 3.0),
        geoMember('t_on2', 5.0),
      ]);
      mockHGetAllBatch.mockResolvedValue([
        transporterDetails('t_on1'),
        transporterDetails('t_off1'),
        transporterDetails('t_on2'),
      ]);
      mockSmIsMembers.mockResolvedValue([true, false, true]);

      // Act
      const result = await availabilityService.getAvailableTransportersWithDetails(
        VEHICLE_KEY, PICKUP_LAT, PICKUP_LNG
      );

      // Assert
      expect(result).toHaveLength(2);
      expect(result.map(r => r.transporterId)).toEqual(['t_on1', 't_on2']);
    });

    it('should fail-open when smIsMembers throws (Redis down) — all candidates returned', async () => {
      // Arrange: 2 transporters in geo, smIsMembers throws
      mockGeoRadius.mockResolvedValue([
        geoMember('t_a', 1.0),
        geoMember('t_b', 2.0),
      ]);
      mockHGetAllBatch.mockResolvedValue([
        transporterDetails('t_a'),
        transporterDetails('t_b'),
      ]);
      mockSmIsMembers.mockRejectedValue(new Error('Redis connection lost'));

      // Act
      const result = await availabilityService.getAvailableTransportersWithDetails(
        VEHICLE_KEY, PICKUP_LAT, PICKUP_LNG
      );

      // Assert: fail-open — both returned
      expect(result).toHaveLength(2);
      expect(result.map(r => r.transporterId)).toEqual(['t_a', 't_b']);

      // Assert: warning logged
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Online filter failed'),
        expect.objectContaining({
          error: 'Redis connection lost',
          candidateCount: 2,
        })
      );
    });

    it('should call geoRemove for offline transporter (stale geo cleanup)', async () => {
      // Arrange: offline transporter
      mockGeoRadius.mockResolvedValue([geoMember('t_stale')]);
      mockHGetAllBatch.mockResolvedValue([transporterDetails('t_stale')]);
      mockSmIsMembers.mockResolvedValue([false]); // offline

      // Act
      await availabilityService.getAvailableTransportersWithDetails(
        VEHICLE_KEY, PICKUP_LAT, PICKUP_LNG
      );

      // Assert: geoRemove called to clean up stale geo entry
      expect(mockGeoRemove).toHaveBeenCalledWith(
        `geo:transporters:${VEHICLE_KEY}`,
        't_stale'
      );
    });

    it('should return empty results for empty transporter list (no crash)', async () => {
      // Arrange: no transporters in geo index
      mockGeoRadius.mockResolvedValue([]);
      mockHGetAllBatch.mockResolvedValue([]);
      mockSmIsMembers.mockResolvedValue([]);

      // Act
      const result = await availabilityService.getAvailableTransportersWithDetails(
        VEHICLE_KEY, PICKUP_LAT, PICKUP_LNG
      );

      // Assert
      expect(result).toHaveLength(0);
      // smIsMembers called with empty array
      expect(mockSmIsMembers).toHaveBeenCalledWith('online:transporters', []);
    });

    it('should return empty when ALL transporters are offline', async () => {
      // Arrange: 3 transporters, all offline
      mockGeoRadius.mockResolvedValue([
        geoMember('t_1'),
        geoMember('t_2'),
        geoMember('t_3'),
      ]);
      mockHGetAllBatch.mockResolvedValue([
        transporterDetails('t_1'),
        transporterDetails('t_2'),
        transporterDetails('t_3'),
      ]);
      mockSmIsMembers.mockResolvedValue([false, false, false]);

      // Act
      const result = await availabilityService.getAvailableTransportersWithDetails(
        VEHICLE_KEY, PICKUP_LAT, PICKUP_LNG
      );

      // Assert
      expect(result).toHaveLength(0);
      // geoRemove called for each offline transporter
      expect(mockGeoRemove).toHaveBeenCalledTimes(3);
    });
  });

  // =========================================================================
  // getAvailableTransportersAsync (returns string[] of IDs)
  // =========================================================================
  describe('getAvailableTransportersAsync — smIsMembers online check', () => {

    it('should filter out offline transporters', async () => {
      mockGeoRadius.mockResolvedValue([
        geoMember('t_online', 1.5),
        geoMember('t_offline', 4.0),
      ]);
      mockHGetAllBatch.mockResolvedValue([
        transporterDetails('t_online'),
        transporterDetails('t_offline'),
      ]);
      mockSmIsMembers.mockResolvedValue([true, false]);

      const result = await availabilityService.getAvailableTransportersAsync(
        VEHICLE_KEY, PICKUP_LAT, PICKUP_LNG
      );

      expect(result).toEqual(['t_online']);
      expect(mockSmIsMembers).toHaveBeenCalledWith(
        'online:transporters',
        ['t_online', 't_offline']
      );
    });

    it('should fail-open when smIsMembers throws', async () => {
      mockGeoRadius.mockResolvedValue([geoMember('t_x', 2.0)]);
      mockHGetAllBatch.mockResolvedValue([transporterDetails('t_x')]);
      mockSmIsMembers.mockRejectedValue(new Error('READONLY'));

      const result = await availabilityService.getAvailableTransportersAsync(
        VEHICLE_KEY, PICKUP_LAT, PICKUP_LNG
      );

      // fail-open: transporter returned despite Redis error
      expect(result).toEqual(['t_x']);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('smIsMembers failed'),
        expect.objectContaining({ candidateCount: 1 })
      );
    });

    it('should call geoRemove for offline transporter and clean stale entries', async () => {
      mockGeoRadius.mockResolvedValue([geoMember('t_dead')]);
      mockHGetAllBatch.mockResolvedValue([transporterDetails('t_dead')]);
      mockSmIsMembers.mockResolvedValue([false]);

      await availabilityService.getAvailableTransportersAsync(
        VEHICLE_KEY, PICKUP_LAT, PICKUP_LNG
      );

      expect(mockGeoRemove).toHaveBeenCalledWith(
        `geo:transporters:${VEHICLE_KEY}`,
        't_dead'
      );
    });

    it('should skip on-trip transporters even if online', async () => {
      mockGeoRadius.mockResolvedValue([
        geoMember('t_free', 1.0),
        geoMember('t_busy', 2.0),
      ]);
      mockHGetAllBatch.mockResolvedValue([
        transporterDetails('t_free'),
        transporterDetails('t_busy', { isOnTrip: 'true' }),
      ]);
      mockSmIsMembers.mockResolvedValue([true, true]); // both online

      const result = await availabilityService.getAvailableTransportersAsync(
        VEHICLE_KEY, PICKUP_LAT, PICKUP_LNG
      );

      expect(result).toEqual(['t_free']);
    });

    it('should skip transporters with empty details (TTL expired)', async () => {
      mockGeoRadius.mockResolvedValue([
        geoMember('t_live', 1.0),
        geoMember('t_expired', 2.0),
      ]);
      mockHGetAllBatch.mockResolvedValue([
        transporterDetails('t_live'),
        {}, // empty — TTL expired
      ]);
      mockSmIsMembers.mockResolvedValue([true, true]);

      const result = await availabilityService.getAvailableTransportersAsync(
        VEHICLE_KEY, PICKUP_LAT, PICKUP_LNG
      );

      expect(result).toEqual(['t_live']);
    });

    it('should return empty array when geoRadius returns nothing', async () => {
      mockGeoRadius.mockResolvedValue([]);
      mockHGetAllBatch.mockResolvedValue([]);
      mockSmIsMembers.mockResolvedValue([]);

      const result = await availabilityService.getAvailableTransportersAsync(
        VEHICLE_KEY, PICKUP_LAT, PICKUP_LNG
      );

      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  describe('Edge cases', () => {

    it('should respect limit parameter', async () => {
      // Arrange: 5 online transporters, limit=2
      const members = Array.from({ length: 5 }, (_, i) => geoMember(`t_${i}`, i + 1));
      const details = Array.from({ length: 5 }, (_, i) => transporterDetails(`t_${i}`));
      mockGeoRadius.mockResolvedValue(members);
      mockHGetAllBatch.mockResolvedValue(details);
      mockSmIsMembers.mockResolvedValue(members.map(() => true));

      const result = await availabilityService.getAvailableTransportersWithDetails(
        VEHICLE_KEY, PICKUP_LAT, PICKUP_LNG, 2
      );

      expect(result).toHaveLength(2);
      expect(result[0].transporterId).toBe('t_0');
      expect(result[1].transporterId).toBe('t_1');
    });

    it('should handle geoRadius failure gracefully (returns empty or fallback)', async () => {
      mockGeoRadius.mockRejectedValue(new Error('CLUSTERDOWN'));

      const result = await availabilityService.getAvailableTransportersWithDetails(
        VEHICLE_KEY, PICKUP_LAT, PICKUP_LNG
      );

      // Should not throw — returns empty or fallback
      expect(Array.isArray(result)).toBe(true);
    });

    it('should clean stale entry from online SET when details are empty', async () => {
      // Transporter in geo but details hash expired
      mockGeoRadius.mockResolvedValue([geoMember('t_ghost')]);
      mockHGetAllBatch.mockResolvedValue([{}]); // empty details
      mockSmIsMembers.mockResolvedValue([true]); // still in online set

      await availabilityService.getAvailableTransportersAsync(
        VEHICLE_KEY, PICKUP_LAT, PICKUP_LNG
      );

      // Should clean up: remove from geo AND online SET
      expect(mockGeoRemove).toHaveBeenCalledWith(
        `geo:transporters:${VEHICLE_KEY}`,
        't_ghost'
      );
      expect(mockSRem).toHaveBeenCalledWith('online:transporters', 't_ghost');
    });
  });
});
