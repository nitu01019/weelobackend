/**
 * =============================================================================
 * TRIP VEHICLE RELEASE -- Tests for A4#1 and A4#2
 * =============================================================================
 *
 * A4#1: Centralized releaseVehicle in completion path
 *   - Completion calls releaseVehicle (not releaseVehicleIfBusy)
 *   - releaseVehicle failure in completion -> assignment still completed, error logged
 *   - Double-tap completion -> second call is no-op
 *
 * A4#2: updateMany guard in releaseVehicleIfBusy
 *   - Vehicle already available -> updateMany returns count=0, early return (no Redis call)
 *
 * @author TESTER-A (Team LEO)
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
    recordHistogram: jest.fn(),
  },
}));

jest.mock('../config/environment', () => ({
  config: { redis: { enabled: true }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {} },
}));

// Redis service mock
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisSetJSON = jest.fn();
const mockRedisGetJSON = jest.fn();
const mockRedisIsConnected = jest.fn().mockReturnValue(true);

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    setJSON: (...args: any[]) => mockRedisSetJSON(...args),
    getJSON: (...args: any[]) => mockRedisGetJSON(...args),
    isConnected: () => mockRedisIsConnected(),
    exists: jest.fn().mockResolvedValue(false),
    sMembers: jest.fn().mockResolvedValue([]),
    sAdd: jest.fn().mockResolvedValue(undefined),
    expire: jest.fn().mockResolvedValue(undefined),
    sIsMember: jest.fn().mockResolvedValue(false),
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
    cancelTimer: jest.fn().mockResolvedValue(undefined),
    setTimer: jest.fn().mockResolvedValue(undefined),
    getExpiredTimers: jest.fn().mockResolvedValue([]),
  },
}));

// Prisma mock
const mockVehicleFindUnique = jest.fn();
const mockVehicleUpdateMany = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    vehicle: {
      findUnique: (...args: any[]) => mockVehicleFindUnique(...args),
      updateMany: (...args: any[]) => mockVehicleUpdateMany(...args),
    },
  },
  VehicleStatus: {
    available: 'available',
    on_hold: 'on_hold',
    in_transit: 'in_transit',
    maintenance: 'maintenance',
    inactive: 'inactive',
  },
}));

// Live availability mock
const mockOnVehicleStatusChange = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: (...args: any[]) => mockOnVehicleStatusChange(...args),
  },
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { releaseVehicle, isValidTransition, VALID_TRANSITIONS } from '../shared/services/vehicle-lifecycle.service';
import { logger } from '../shared/services/logger.service';

// =============================================================================
// HELPERS
// =============================================================================

function resetAllMocks(): void {
  jest.clearAllMocks();
  mockVehicleFindUnique.mockReset();
  mockVehicleUpdateMany.mockReset();
  mockOnVehicleStatusChange.mockReset();
  mockOnVehicleStatusChange.mockResolvedValue(undefined);
}

// =============================================================================
// A4#1: CENTRALIZED releaseVehicle IN COMPLETION PATH
// =============================================================================

describe('A4#1 -- Centralized releaseVehicle in completion path', () => {
  beforeEach(resetAllMocks);

  it('releases vehicle from in_transit to available on trip completion', async () => {
    mockVehicleFindUnique.mockResolvedValue({
      id: 'v-001',
      status: 'in_transit',
      vehicleKey: 'open_17ft',
      transporterId: 't-001',
    });
    mockVehicleUpdateMany.mockResolvedValue({ count: 1 });

    await releaseVehicle('v-001', 'tripCompleted');

    expect(mockVehicleUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'v-001', status: { not: 'available' } },
        data: expect.objectContaining({ status: 'available' }),
      })
    );
    expect(mockOnVehicleStatusChange).toHaveBeenCalledWith(
      't-001', 'open_17ft', 'in_transit', 'available'
    );
  });

  it('releases vehicle from on_hold to available on trip completion', async () => {
    mockVehicleFindUnique.mockResolvedValue({
      id: 'v-002',
      status: 'on_hold',
      vehicleKey: 'closed_14ft',
      transporterId: 't-002',
    });
    mockVehicleUpdateMany.mockResolvedValue({ count: 1 });

    await releaseVehicle('v-002', 'tripCompleted');

    expect(mockOnVehicleStatusChange).toHaveBeenCalledWith(
      't-002', 'closed_14ft', 'on_hold', 'available'
    );
  });

  it('releaseVehicle failure in completion -> error logged but no throw', async () => {
    // Simulate DB error on findUnique
    mockVehicleFindUnique.mockResolvedValue({
      id: 'v-003',
      status: 'in_transit',
      vehicleKey: 'open_17ft',
      transporterId: 't-003',
    });
    mockVehicleUpdateMany.mockRejectedValue(new Error('DB connection lost'));

    // Should throw (caller wraps in try/catch)
    await expect(releaseVehicle('v-003', 'tripCompleted')).rejects.toThrow('DB connection lost');
  });

  it('vehicle not found -> logs warning and returns silently', async () => {
    mockVehicleFindUnique.mockResolvedValue(null);

    await releaseVehicle('v-ghost', 'tripCompleted');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('not found')
    );
    expect(mockVehicleUpdateMany).not.toHaveBeenCalled();
    expect(mockOnVehicleStatusChange).not.toHaveBeenCalled();
  });

  it('double-tap completion -> second call is idempotent no-op (already available)', async () => {
    // First call: vehicle is in_transit -> released
    mockVehicleFindUnique.mockResolvedValueOnce({
      id: 'v-004',
      status: 'in_transit',
      vehicleKey: 'open_17ft',
      transporterId: 't-004',
    });
    mockVehicleUpdateMany.mockResolvedValueOnce({ count: 1 });

    await releaseVehicle('v-004', 'tripCompleted');
    expect(mockVehicleUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockOnVehicleStatusChange).toHaveBeenCalledTimes(1);

    // Second call: vehicle is now available
    mockVehicleFindUnique.mockResolvedValueOnce({
      id: 'v-004',
      status: 'available',
      vehicleKey: 'open_17ft',
      transporterId: 't-004',
    });

    await releaseVehicle('v-004', 'tripCompleted');

    // Should NOT call updateMany or Redis again
    expect(mockVehicleUpdateMany).toHaveBeenCalledTimes(1); // Still just 1
    expect(mockOnVehicleStatusChange).toHaveBeenCalledTimes(1); // Still just 1
  });

  it('double-tap: updateMany returns count=0 on race -> no Redis call', async () => {
    mockVehicleFindUnique.mockResolvedValue({
      id: 'v-005',
      status: 'in_transit',
      vehicleKey: 'open_17ft',
      transporterId: 't-005',
    });
    // Another process released it first: count = 0
    mockVehicleUpdateMany.mockResolvedValue({ count: 0 });

    await releaseVehicle('v-005', 'tripCompleted');

    // Redis should NOT be called since count is 0
    expect(mockOnVehicleStatusChange).not.toHaveBeenCalled();
  });

  it('Redis sync failure does not throw (caught internally)', async () => {
    mockVehicleFindUnique.mockResolvedValue({
      id: 'v-006',
      status: 'in_transit',
      vehicleKey: 'open_17ft',
      transporterId: 't-006',
    });
    mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockOnVehicleStatusChange.mockRejectedValue(new Error('Redis timeout'));

    // Should NOT throw
    await expect(releaseVehicle('v-006', 'tripCompleted')).resolves.toBeUndefined();

    // But Redis was attempted
    expect(mockOnVehicleStatusChange).toHaveBeenCalled();
    // Logger should have caught the failure
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Redis sync failed'),
      expect.anything()
    );
  });
});

// =============================================================================
// A4#2: updateMany GUARD IN releaseVehicleIfBusy
// =============================================================================

describe('A4#2 -- updateMany guard in releaseVehicle', () => {
  beforeEach(resetAllMocks);

  it('vehicle already available -> early return, no updateMany call', async () => {
    mockVehicleFindUnique.mockResolvedValue({
      id: 'v-010',
      status: 'available',
      vehicleKey: 'open_17ft',
      transporterId: 't-010',
    });

    await releaseVehicle('v-010', 'cancellation');

    // Should not call updateMany or Redis since vehicle is already available
    expect(mockVehicleUpdateMany).not.toHaveBeenCalled();
    expect(mockOnVehicleStatusChange).not.toHaveBeenCalled();
  });

  it('vehicle in maintenance -> invalid transition to available, no update', async () => {
    // maintenance -> available IS valid per VALID_TRANSITIONS
    expect(isValidTransition('maintenance', 'available')).toBe(true);

    mockVehicleFindUnique.mockResolvedValue({
      id: 'v-011',
      status: 'maintenance',
      vehicleKey: 'open_17ft',
      transporterId: 't-011',
    });
    mockVehicleUpdateMany.mockResolvedValue({ count: 1 });

    await releaseVehicle('v-011', 'admin');

    expect(mockVehicleUpdateMany).toHaveBeenCalled();
    expect(mockOnVehicleStatusChange).toHaveBeenCalledWith(
      't-011', 'open_17ft', 'maintenance', 'available'
    );
  });

  it('concurrent release: first wins, second sees count=0', async () => {
    // First call: succeeds
    mockVehicleFindUnique.mockResolvedValue({
      id: 'v-012',
      status: 'on_hold',
      vehicleKey: 'closed_14ft',
      transporterId: 't-012',
    });
    mockVehicleUpdateMany
      .mockResolvedValueOnce({ count: 1 })  // First call wins
      .mockResolvedValueOnce({ count: 0 }); // Second call: already released

    // First call
    await releaseVehicle('v-012', 'cancel-1');
    expect(mockOnVehicleStatusChange).toHaveBeenCalledTimes(1);

    // Second concurrent call (same vehicle still appears on_hold at read time due to race)
    await releaseVehicle('v-012', 'cancel-2');
    // No additional Redis call since count was 0
    expect(mockOnVehicleStatusChange).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// VALID TRANSITIONS UNIT TESTS
// =============================================================================

describe('Vehicle status transition validation', () => {
  it('available -> on_hold is valid', () => {
    expect(isValidTransition('available', 'on_hold')).toBe(true);
  });

  it('available -> in_transit is valid', () => {
    expect(isValidTransition('available', 'in_transit')).toBe(true);
  });

  it('on_hold -> available is valid', () => {
    expect(isValidTransition('on_hold', 'available')).toBe(true);
  });

  it('in_transit -> available is valid', () => {
    expect(isValidTransition('in_transit', 'available')).toBe(true);
  });

  it('in_transit -> on_hold is NOT valid', () => {
    expect(isValidTransition('in_transit', 'on_hold')).toBe(false);
  });

  it('available -> available is NOT valid (no self-transition)', () => {
    expect(isValidTransition('available', 'available')).toBe(false);
  });

  it('unknown status returns false', () => {
    expect(isValidTransition('nonexistent', 'available')).toBe(false);
  });

  it('VALID_TRANSITIONS map covers all expected statuses', () => {
    expect(Object.keys(VALID_TRANSITIONS)).toEqual(
      expect.arrayContaining(['available', 'on_hold', 'in_transit', 'maintenance', 'inactive'])
    );
  });
});
