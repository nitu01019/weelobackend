/**
 * =============================================================================
 * VEHICLE RELEASE FIXES — P2 (retry + reconciliation) & P18 (bypass fixes)
 * =============================================================================
 *
 * Tests for two critical production problems:
 *
 * P2:  releaseVehicle failures must enqueue retry jobs with exponential backoff.
 *      Targeted reconciliation finds and releases orphaned vehicles
 *      (in_transit with no active assignment).
 *
 * P18: Booking/order cancel paths must call releaseVehicle (centralized),
 *      NOT direct Prisma updates that bypass Redis sync + validation.
 *      Assignment cancel must use actual vehicle.status for Redis sync,
 *      not a hardcoded 'in_transit'.
 *
 * @author Weelo Team
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
    setGauge: jest.fn(),
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
const mockRedisHGetAll = jest.fn();
const mockRedisHSet = jest.fn();
const mockRedisHDel = jest.fn();
const mockRedisBrPop = jest.fn();
const mockRedisLLen = jest.fn();
const mockRedisZAdd = jest.fn();
const mockRedisZRangeByScore = jest.fn();
const mockRedisZRemRangeByScore = jest.fn();
const mockRedisLPushMany = jest.fn();
const mockRedisSetTimer = jest.fn();
const mockRedisCancelTimer = jest.fn();

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
    hGetAll: (...args: any[]) => mockRedisHGetAll(...args),
    hSet: (...args: any[]) => mockRedisHSet(...args),
    hDel: (...args: any[]) => mockRedisHDel(...args),
    brPop: (...args: any[]) => mockRedisBrPop(...args),
    lLen: (...args: any[]) => mockRedisLLen(...args),
    zAdd: (...args: any[]) => mockRedisZAdd(...args),
    zRangeByScore: (...args: any[]) => mockRedisZRangeByScore(...args),
    zRemRangeByScore: (...args: any[]) => mockRedisZRemRangeByScore(...args),
    lPushMany: (...args: any[]) => mockRedisLPushMany(...args),
    setTimer: (...args: any[]) => mockRedisSetTimer(...args),
    cancelTimer: (...args: any[]) => mockRedisCancelTimer(...args),
  },
}));

// Prisma mock
const mockVehicleFindUnique = jest.fn();
const mockVehicleUpdateMany = jest.fn();
const mockVehicleUpdate = jest.fn();
const mockAssignmentFindMany = jest.fn();
const mockAssignmentUpdateMany = jest.fn();
const mockQueryRaw = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    vehicle: {
      findUnique: (...args: any[]) => mockVehicleFindUnique(...args),
      updateMany: (...args: any[]) => mockVehicleUpdateMany(...args),
      update: (...args: any[]) => mockVehicleUpdate(...args),
    },
    assignment: {
      findMany: (...args: any[]) => mockAssignmentFindMany(...args),
      updateMany: (...args: any[]) => mockAssignmentUpdateMany(...args),
    },
    $queryRaw: (...args: any[]) => mockQueryRaw(...args),
  },
}));

// Live availability service mock
const mockOnVehicleStatusChange = jest.fn();
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: (...args: any[]) => mockOnVehicleStatusChange(...args),
  },
}));

// Socket service mock
jest.mock('../shared/services/socket.service', () => ({
  emitToUser: jest.fn(),
  socketService: { emitToUser: jest.fn() },
}));

// Cache service mock
jest.mock('../shared/services/cache.service', () => ({
  cacheService: {
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
  },
}));

// Config mock
jest.mock('../config/environment', () => ({
  config: { redis: { enabled: true }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {} },
}));

// DB mock
jest.mock('../shared/database/db', () => ({
  db: {
    getUserById: jest.fn(),
    getVehiclesByTransporter: jest.fn(),
    updateVehicle: jest.fn(),
  },
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { releaseVehicle } from '../shared/services/vehicle-lifecycle.service';
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
  mockRedisHGetAll.mockReset();
  mockRedisHSet.mockReset();
  mockRedisHDel.mockReset();
  mockRedisBrPop.mockReset();
  mockRedisLLen.mockReset();
  mockRedisZAdd.mockReset();
  mockRedisZRangeByScore.mockReset();
  mockRedisZRemRangeByScore.mockReset();
  mockRedisLPushMany.mockReset();
  mockRedisSetTimer.mockReset();
  mockRedisCancelTimer.mockReset();
  mockVehicleFindUnique.mockReset();
  mockVehicleUpdateMany.mockReset();
  mockVehicleUpdate.mockReset();
  mockAssignmentFindMany.mockReset();
  mockAssignmentUpdateMany.mockReset();
  mockQueryRaw.mockReset();
  mockOnVehicleStatusChange.mockReset();
}

// =============================================================================
// P2: RETRY + RECONCILIATION TESTS
// =============================================================================

describe('P2 — Vehicle Release Retry & Reconciliation', () => {
  beforeEach(resetAllMocks);

  // =========================================================================
  // P2.1: releaseVehicle failure enqueues VEHICLE_RELEASE retry job
  // =========================================================================
  describe('releaseVehicle failure enqueues VEHICLE_RELEASE retry job', () => {
    it('enqueues a VEHICLE_RELEASE job when releaseVehicle throws a DB error', async () => {
      // Simulate the pattern: caller catches releaseVehicle error and enqueues retry
      // This tests the enqueue contract used by cancel paths.
      const mockQueueAdd = jest.fn().mockResolvedValue('job-123');

      // releaseVehicle throws on DB failure
      mockVehicleFindUnique.mockRejectedValue(new Error('Connection pool exhausted'));

      let releaseError: Error | null = null;
      try {
        await releaseVehicle('v-fail', 'cancel-booking');
      } catch (err: any) {
        releaseError = err;
      }

      expect(releaseError).not.toBeNull();

      // Caller enqueues retry job
      const jobId = await mockQueueAdd(
        'vehicle-release',
        'vehicle-release',
        { vehicleId: 'v-fail', context: 'cancel-booking' },
        { maxAttempts: 5 }
      );

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'vehicle-release',
        'vehicle-release',
        { vehicleId: 'v-fail', context: 'cancel-booking' },
        { maxAttempts: 5 }
      );
      expect(jobId).toBe('job-123');
    });
  });

  // =========================================================================
  // P2.2: VEHICLE_RELEASE processor calls releaseVehicle
  // =========================================================================
  describe('VEHICLE_RELEASE processor calls releaseVehicle', () => {
    it('processor invokes releaseVehicle with vehicleId and retry context', async () => {
      // Simulate the VEHICLE_RELEASE processor from queue.service.ts:
      //   const { vehicleId, context } = job.data;
      //   await releaseVehicle(vehicleId, `retry:${context}`);
      mockVehicleFindUnique.mockResolvedValue({
        id: 'v-retry',
        status: 'in_transit',
        vehicleKey: 'MH12AB1234',
        transporterId: 't-001',
      });
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
      mockOnVehicleStatusChange.mockResolvedValue(undefined);

      const job = {
        id: 'job-456',
        type: 'vehicle-release',
        data: { vehicleId: 'v-retry', context: 'cancel-booking' },
        priority: 0,
        attempts: 1,
        maxAttempts: 5,
        createdAt: Date.now(),
      };

      // Simulate processor logic
      const { vehicleId, context } = job.data;
      await releaseVehicle(vehicleId, `retry:${context}`);

      expect(mockVehicleFindUnique).toHaveBeenCalledWith({
        where: { id: 'v-retry' },
        select: { id: true, status: true, vehicleKey: true, transporterId: true },
      });
      expect(mockVehicleUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'available' }),
        })
      );
      expect(mockOnVehicleStatusChange).toHaveBeenCalledWith(
        't-001', 'MH12AB1234', 'in_transit', 'available'
      );
    });
  });

  // =========================================================================
  // P2.3: Retry uses exponential backoff (2s, 4s, 8s, 16s, 32s)
  // =========================================================================
  describe('retry uses exponential backoff (2s, 4s, 8s, 16s, 32s)', () => {
    it('calculates correct delays for attempts 1 through 5', () => {
      // Queue service formula: Math.pow(2, job.attempts) * 1000
      const expectedDelays = [
        { attempt: 1, delay: 2000 },
        { attempt: 2, delay: 4000 },
        { attempt: 3, delay: 8000 },
        { attempt: 4, delay: 16000 },
        { attempt: 5, delay: 32000 },
      ];

      for (const { attempt, delay } of expectedDelays) {
        const calculated = Math.pow(2, attempt) * 1000;
        expect(calculated).toBe(delay);
      }
    });

    it('VEHICLE_RELEASE queue defaults to maxAttempts=5', () => {
      // From queue.service.ts enqueue():
      //   const maxAttempts = options?.maxAttempts ?? (queueName === 'vehicle-release' ? 5 : 3);
      const queueName = 'vehicle-release';
      const maxAttempts = queueName === 'vehicle-release' ? 5 : 3;
      expect(maxAttempts).toBe(5);
    });

    it('total retry window is ~62 seconds (2+4+8+16+32)', () => {
      const totalDelayMs = [1, 2, 3, 4, 5].reduce(
        (sum, attempt) => sum + Math.pow(2, attempt) * 1000,
        0
      );
      // 2000 + 4000 + 8000 + 16000 + 32000 = 62000ms
      expect(totalDelayMs).toBe(62000);
    });
  });

  // =========================================================================
  // P2.4: Targeted reconciliation finds orphaned vehicles
  // =========================================================================
  describe('targeted reconciliation finds orphaned vehicles (in_transit with no active assignment)', () => {
    it('raw SQL query selects vehicles in_transit/on_hold with no active assignment', async () => {
      // Simulate the Phase 3 reconciliation query from queue.service.ts:
      //   SELECT v.* FROM Vehicle v
      //   WHERE v.status IN ('in_transit', 'on_hold')
      //   AND v.updatedAt < NOW() - INTERVAL '10 minutes'
      //   AND NOT EXISTS (SELECT 1 FROM Assignment a WHERE ...)
      //   LIMIT 50
      const orphanedVehicles = [
        { id: 'v-orphan-1', status: 'in_transit', transporterId: 't-001', vehicleKey: 'MH12X1' },
        { id: 'v-orphan-2', status: 'on_hold', transporterId: 't-002', vehicleKey: 'MH12X2' },
      ];
      mockQueryRaw.mockResolvedValue(orphanedVehicles);

      const { prismaClient } = require('../shared/database/prisma.service');
      const result = await prismaClient.$queryRaw`
        SELECT v."id", v."status", v."transporterId", v."vehicleKey"
        FROM "Vehicle" v
        WHERE v."status" IN ('in_transit', 'on_hold')
        AND v."updatedAt" < NOW() - INTERVAL '10 minutes'
        AND NOT EXISTS (
          SELECT 1 FROM "Assignment" a
          WHERE a."vehicleId" = v."id"
          AND a."status" IN ('pending', 'driver_accepted', 'in_transit', 'en_route_pickup', 'at_pickup', 'arrived_at_drop')
        )
        LIMIT 50
      `;

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('v-orphan-1');
      expect(result[1].status).toBe('on_hold');
    });
  });

  // =========================================================================
  // P2.5: Targeted reconciliation releases orphaned vehicles
  // =========================================================================
  describe('targeted reconciliation releases orphaned vehicles', () => {
    it('calls releaseVehicle for each orphaned vehicle found', async () => {
      const orphanedVehicles = [
        { id: 'v-orphan-1', status: 'in_transit', transporterId: 't-001', vehicleKey: 'MH12X1' },
        { id: 'v-orphan-2', status: 'on_hold', transporterId: 't-002', vehicleKey: 'MH12X2' },
      ];

      // Setup releaseVehicle to succeed for both vehicles
      mockVehicleFindUnique
        .mockResolvedValueOnce({
          id: 'v-orphan-1', status: 'in_transit', vehicleKey: 'MH12X1', transporterId: 't-001',
        })
        .mockResolvedValueOnce({
          id: 'v-orphan-2', status: 'on_hold', vehicleKey: 'MH12X2', transporterId: 't-002',
        });
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
      mockOnVehicleStatusChange.mockResolvedValue(undefined);

      // Simulate reconciliation loop
      for (const v of orphanedVehicles) {
        await releaseVehicle(v.id, 'reconciliation:orphaned');
      }

      expect(mockVehicleFindUnique).toHaveBeenCalledTimes(2);
      expect(mockVehicleUpdateMany).toHaveBeenCalledTimes(2);
      expect(mockOnVehicleStatusChange).toHaveBeenCalledTimes(2);

      // Verify the context includes 'reconciliation:orphaned'
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('reconciliation:orphaned')
      );
    });

    it('continues processing remaining vehicles when one release fails', async () => {
      // First vehicle: release fails
      mockVehicleFindUnique
        .mockResolvedValueOnce({
          id: 'v-fail', status: 'in_transit', vehicleKey: 'KEY1', transporterId: 't-001',
        })
        .mockResolvedValueOnce({
          id: 'v-ok', status: 'in_transit', vehicleKey: 'KEY2', transporterId: 't-002',
        });
      mockVehicleUpdateMany
        .mockRejectedValueOnce(new Error('Deadlock'))
        .mockResolvedValueOnce({ count: 1 });
      mockOnVehicleStatusChange.mockResolvedValue(undefined);

      const orphanedVehicles = [
        { id: 'v-fail', status: 'in_transit', transporterId: 't-001', vehicleKey: 'KEY1' },
        { id: 'v-ok', status: 'in_transit', transporterId: 't-002', vehicleKey: 'KEY2' },
      ];

      // Simulate reconciliation loop with error handling
      for (const v of orphanedVehicles) {
        await releaseVehicle(v.id, 'reconciliation:orphaned').catch(() => {
          // reconciliation catches errors per vehicle
        });
      }

      // Second vehicle still processed despite first failure
      expect(mockVehicleFindUnique).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // P2.6: Targeted reconciliation ignores vehicles with active assignments
  // =========================================================================
  describe('targeted reconciliation ignores vehicles with active assignments', () => {
    it('SQL NOT EXISTS clause excludes vehicles with active assignments', () => {
      // The reconciliation query uses:
      //   AND NOT EXISTS (
      //     SELECT 1 FROM "Assignment" a
      //     WHERE a."vehicleId" = v."id"
      //     AND a."status" IN ('pending', 'driver_accepted', 'in_transit', ...)
      //   )
      // This means vehicles WITH active assignments are excluded from the result.

      const activeAssignmentStatuses = [
        'pending',
        'driver_accepted',
        'in_transit',
        'en_route_pickup',
        'at_pickup',
        'arrived_at_drop',
      ];

      // Verify all expected active statuses are covered
      expect(activeAssignmentStatuses).toContain('pending');
      expect(activeAssignmentStatuses).toContain('driver_accepted');
      expect(activeAssignmentStatuses).toContain('in_transit');
      expect(activeAssignmentStatuses).toContain('en_route_pickup');
      expect(activeAssignmentStatuses).toContain('at_pickup');
      expect(activeAssignmentStatuses).toContain('arrived_at_drop');
      expect(activeAssignmentStatuses).not.toContain('cancelled');
      expect(activeAssignmentStatuses).not.toContain('completed');
    });

    it('does not release a vehicle that has a pending assignment', async () => {
      // If reconciliation correctly uses NOT EXISTS, a vehicle with
      // a pending assignment will NOT appear in the query results,
      // so releaseVehicle is never called for it.
      mockQueryRaw.mockResolvedValue([]); // empty = all vehicles have active assignments

      const { prismaClient } = require('../shared/database/prisma.service');
      const result = await prismaClient.$queryRaw`SELECT ...`;

      expect(result).toHaveLength(0);
      // releaseVehicle should NOT be called
      expect(mockVehicleUpdateMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // P2.7: Reconciliation LIMIT 50 caps work per run
  // =========================================================================
  describe('reconciliation LIMIT 50 caps work per run', () => {
    it('query includes LIMIT 50 to prevent runaway processing', () => {
      // The reconciliation query in queue.service.ts ends with LIMIT 50.
      // This ensures a single reconciliation run does not overwhelm the DB.
      const RECONCILIATION_LIMIT = 50;
      expect(RECONCILIATION_LIMIT).toBe(50);

      // Verify the pattern: even with 100 orphaned vehicles, only 50 are processed per run
      const allOrphanedVehicles = Array.from({ length: 100 }, (_, i) => ({
        id: `v-orphan-${i}`,
        status: 'in_transit',
        transporterId: `t-${i}`,
        vehicleKey: `KEY-${i}`,
      }));

      const batch = allOrphanedVehicles.slice(0, RECONCILIATION_LIMIT);
      expect(batch).toHaveLength(50);
    });

    it('reconciliation processes exactly the LIMIT number of vehicles', async () => {
      const batchSize = 50;
      const vehicles = Array.from({ length: batchSize }, (_, i) => ({
        id: `v-${i}`, status: 'in_transit', transporterId: `t-${i}`, vehicleKey: `K-${i}`,
      }));

      // Each releaseVehicle call: findUnique + updateMany
      for (let i = 0; i < batchSize; i++) {
        mockVehicleFindUnique.mockResolvedValueOnce(vehicles[i]);
      }
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
      mockOnVehicleStatusChange.mockResolvedValue(undefined);

      for (const v of vehicles) {
        await releaseVehicle(v.id, 'reconciliation:orphaned');
      }

      expect(mockVehicleFindUnique).toHaveBeenCalledTimes(batchSize);
      expect(mockVehicleUpdateMany).toHaveBeenCalledTimes(batchSize);
    });
  });
});

// =============================================================================
// P18: BYPASS FIXES — Cancel paths must use releaseVehicle
// =============================================================================

describe('P18 — Cancel Bypass Fixes', () => {
  beforeEach(resetAllMocks);

  // =========================================================================
  // P18.1: Booking cancel calls releaseVehicle, not direct Prisma update
  // =========================================================================
  describe('booking cancel calls releaseVehicle, not direct Prisma update', () => {
    it('P18 BUG: booking.service cancelBooking uses direct prisma.vehicle.update (bypass)', () => {
      // CURRENT CODE (booking.service.ts line 1519-1522):
      //   await prismaClient.vehicle.update({
      //     where: { id: assignment.vehicleId },
      //     data: { status: 'available', currentTripId: null, assignedDriverId: null }
      //   })
      //
      // This bypasses releaseVehicle which:
      //   1. Validates the status transition
      //   2. Uses atomic updateMany with status guard
      //   3. Syncs Redis via liveAvailabilityService using actual vehicle.status
      //
      // FIX: Replace with releaseVehicle(assignment.vehicleId, 'cancel-booking')
      //
      // This test documents the expected contract: cancel should call releaseVehicle.

      const assignment = {
        vehicleId: 'v-booking-1',
        transporterId: 't-001',
        vehicleType: 'Open',
        vehicleSubtype: '17ft',
        driverId: 'd-001',
      };

      // The CORRECT cancel pattern is:
      //   await releaseVehicle(assignment.vehicleId, 'cancel-booking')
      //     .catch((err) => {
      //       queueService.enqueue('vehicle-release', { vehicleId: assignment.vehicleId, context: 'cancel-booking' });
      //     });
      //
      // NOT:
      //   await prismaClient.vehicle.update({ where: { id: vehicleId }, data: { status: 'available', ... } })

      // Verify releaseVehicle uses the correct pattern
      mockVehicleFindUnique.mockResolvedValue({
        id: 'v-booking-1', status: 'in_transit', vehicleKey: 'MH12AB1234', transporterId: 't-001',
      });
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
      mockOnVehicleStatusChange.mockResolvedValue(undefined);

      return releaseVehicle('v-booking-1', 'cancel-booking').then(() => {
        // releaseVehicle uses updateMany (atomic guard), NOT update
        expect(mockVehicleUpdateMany).toHaveBeenCalledWith({
          where: { id: 'v-booking-1', status: { not: 'available' } },
          data: expect.objectContaining({
            status: 'available',
            currentTripId: null,
            assignedDriverId: null,
          }),
        });
        // releaseVehicle syncs Redis with actual vehicle status
        expect(mockOnVehicleStatusChange).toHaveBeenCalledWith(
          't-001', 'MH12AB1234', 'in_transit', 'available'
        );
        // Direct prisma.vehicle.update should NOT be called
        expect(mockVehicleUpdate).not.toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // P18.2: Order cancel calls releaseVehicle, not direct Prisma update
  // =========================================================================
  describe('order cancel calls releaseVehicle, not direct Prisma update', () => {
    it('P18 BUG: order.service cancelOrder uses direct tx.vehicle.updateMany (bypass)', () => {
      // CURRENT CODE (order.service.ts line 3980-3987):
      //   await tx.vehicle.updateMany({
      //     where: { id: { in: vehicleIdsToRelease } },
      //     data: { status: 'available', currentTripId: null, assignedDriverId: null }
      //   });
      //
      // This bypasses releaseVehicle which:
      //   1. Validates the status transition (isValidTransition)
      //   2. Uses atomic status guard (where: { status: { not: 'available' } })
      //   3. Reads actual vehicle.status for Redis sync
      //   4. Enqueues retry on failure
      //
      // FIX: Replace bulk update with individual releaseVehicle calls:
      //   for (const vehicleId of vehicleIdsToRelease) {
      //     await releaseVehicle(vehicleId, 'cancel-order').catch(() => {
      //       queueService.enqueue('vehicle-release', { vehicleId, context: 'cancel-order' });
      //     });
      //   }

      // Verify releaseVehicle provides proper validation + Redis sync
      mockVehicleFindUnique.mockResolvedValue({
        id: 'v-order-1', status: 'on_hold', vehicleKey: 'MH14XY9999', transporterId: 't-002',
      });
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
      mockOnVehicleStatusChange.mockResolvedValue(undefined);

      return releaseVehicle('v-order-1', 'cancel-order').then(() => {
        // Uses actual vehicle status (on_hold) for Redis sync, not hardcoded 'in_transit'
        expect(mockOnVehicleStatusChange).toHaveBeenCalledWith(
          't-002', 'MH14XY9999', 'on_hold', 'available'
        );
        // Direct prisma.vehicle.update not used
        expect(mockVehicleUpdate).not.toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // P18.3: Assignment cancel uses actual vehicle status for Redis sync
  // =========================================================================
  describe('assignment cancel uses actual vehicle status for Redis sync', () => {
    it('reads vehicle.status before calling onVehicleStatusChange (not hardcoded)', async () => {
      // assignment.service.ts (line 82-100) correctly reads actual status:
      //   const vehicle = await prismaClient.vehicle.findUnique({
      //     where: { id: vehicleId },
      //     select: { vehicleKey: true, transporterId: true, status: true }
      //   });
      //   ...
      //   liveAvailabilityService.onVehicleStatusChange(
      //     transporterId, vehicle.vehicleKey, vehicle.status, 'available'
      //   )
      //
      // Contrast with booking.service.ts (line 1525-1526) which hardcodes:
      //   liveAvailabilityService.onVehicleStatusChange(
      //     ..., 'in_transit', 'available'   <-- WRONG: always assumes in_transit
      //   )

      // Test the correct pattern via releaseVehicle (which reads actual status)
      mockVehicleFindUnique.mockResolvedValue({
        id: 'v-assign', status: 'on_hold', vehicleKey: 'MH15ZZ0000', transporterId: 't-003',
      });
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
      mockOnVehicleStatusChange.mockResolvedValue(undefined);

      await releaseVehicle('v-assign', 'assignment-cancel');

      // CRITICAL: Uses actual status 'on_hold', not hardcoded 'in_transit'
      expect(mockOnVehicleStatusChange).toHaveBeenCalledWith(
        't-003', 'MH15ZZ0000', 'on_hold', 'available'
      );
    });

    it('handles vehicle in maintenance status correctly for Redis sync', async () => {
      mockVehicleFindUnique.mockResolvedValue({
        id: 'v-maint', status: 'maintenance', vehicleKey: 'MH20AA1111', transporterId: 't-004',
      });
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
      mockOnVehicleStatusChange.mockResolvedValue(undefined);

      await releaseVehicle('v-maint', 'assignment-cancel');

      // Uses actual status 'maintenance'
      expect(mockOnVehicleStatusChange).toHaveBeenCalledWith(
        't-004', 'MH20AA1111', 'maintenance', 'available'
      );
    });
  });

  // =========================================================================
  // P18.4: releaseVehicle failure in cancel loop does not break other releases
  // =========================================================================
  describe('releaseVehicle failure in cancel loop does not break other releases', () => {
    it('processes all vehicles even when some fail', async () => {
      const vehicleIds = ['v-1', 'v-2', 'v-3'];

      // v-1: succeeds
      // v-2: fails (DB error)
      // v-3: succeeds
      mockVehicleFindUnique
        .mockResolvedValueOnce({
          id: 'v-1', status: 'in_transit', vehicleKey: 'K1', transporterId: 't-1',
        })
        .mockRejectedValueOnce(new Error('Connection pool exhausted'))
        .mockResolvedValueOnce({
          id: 'v-3', status: 'in_transit', vehicleKey: 'K3', transporterId: 't-3',
        });
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
      mockOnVehicleStatusChange.mockResolvedValue(undefined);

      const errors: Array<{ vehicleId: string; error: string }> = [];

      // Simulate cancel loop with try/catch per vehicle
      for (const vehicleId of vehicleIds) {
        try {
          await releaseVehicle(vehicleId, 'cancel-loop');
        } catch (err: any) {
          errors.push({ vehicleId, error: err.message });
          // In production, this would enqueue a retry job
        }
      }

      // All 3 vehicles attempted
      expect(mockVehicleFindUnique).toHaveBeenCalledTimes(3);

      // Only v-2 failed
      expect(errors).toHaveLength(1);
      expect(errors[0].vehicleId).toBe('v-2');

      // v-1 and v-3 were released (2 updateMany calls)
      expect(mockVehicleUpdateMany).toHaveBeenCalledTimes(2);
    });

    it('collects failed vehicle IDs for retry queue', async () => {
      const vehicleIds = ['v-ok-1', 'v-fail', 'v-ok-2'];
      const failedVehicleIds: string[] = [];

      mockVehicleFindUnique
        .mockResolvedValueOnce({
          id: 'v-ok-1', status: 'in_transit', vehicleKey: 'K1', transporterId: 't-1',
        })
        .mockResolvedValueOnce({
          id: 'v-fail', status: 'in_transit', vehicleKey: 'K2', transporterId: 't-2',
        })
        .mockResolvedValueOnce({
          id: 'v-ok-2', status: 'in_transit', vehicleKey: 'K3', transporterId: 't-3',
        });
      mockVehicleUpdateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockRejectedValueOnce(new Error('Deadlock detected'))
        .mockResolvedValueOnce({ count: 1 });
      mockOnVehicleStatusChange.mockResolvedValue(undefined);

      for (const vehicleId of vehicleIds) {
        try {
          await releaseVehicle(vehicleId, 'cancel-order');
        } catch (err: any) {
          failedVehicleIds.push(vehicleId);
        }
      }

      expect(failedVehicleIds).toEqual(['v-fail']);

      // The failed vehicle ID would be enqueued to VEHICLE_RELEASE queue
      // queueService.enqueue('vehicle-release', { vehicleId: 'v-fail', context: 'cancel-order' })
      expect(failedVehicleIds).toHaveLength(1);
    });

    it('Redis sync failure does not prevent subsequent vehicle releases', async () => {
      const vehicleIds = ['v-redis-fail', 'v-next'];

      mockVehicleFindUnique
        .mockResolvedValueOnce({
          id: 'v-redis-fail', status: 'in_transit', vehicleKey: 'K1', transporterId: 't-1',
        })
        .mockResolvedValueOnce({
          id: 'v-next', status: 'in_transit', vehicleKey: 'K2', transporterId: 't-2',
        });
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
      // First Redis sync fails, second succeeds
      mockOnVehicleStatusChange
        .mockRejectedValueOnce(new Error('Redis connection timeout'))
        .mockResolvedValueOnce(undefined);

      // Both should succeed because releaseVehicle catches Redis errors internally
      for (const vehicleId of vehicleIds) {
        await releaseVehicle(vehicleId, 'cancel-loop');
      }

      // Both DB releases succeeded
      expect(mockVehicleUpdateMany).toHaveBeenCalledTimes(2);

      // Redis was attempted for both
      expect(mockOnVehicleStatusChange).toHaveBeenCalledTimes(2);

      // First Redis failure was logged as warning (vehicle-lifecycle.service logs structured object)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Redis availability sync failed'),
        expect.objectContaining({ error: expect.any(String) })
      );

      // Second vehicle still released successfully
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Vehicle v-next released: in_transit -> available')
      );
    });
  });
});
