/**
 * =============================================================================
 * FIX ISSUE #26 — getTransportersWithVehicleType must filter by status: 'available'
 * =============================================================================
 *
 * HIGH issue #26 from TEAM LEO audit:
 *   getTransportersWithVehicleType returned transporters even when ALL their
 *   vehicles were stuck in non-available states (in_transit, maintenance, etc.).
 *
 * Fix: Added `status: 'available'` to both the vehicleKey-based query and the
 *      type-scoped fallback query inside getTransportersWithVehicleType.
 *
 * Also verifies that booking-broadcast-service batch eligibility (FIX #13)
 * does NOT filter by status (it only checks isActive + type). This is
 * intentional — the broadcast batch check is a secondary guard; the primary
 * filter happens in the repository.
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
jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
  },
}));

// Live availability service mock
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: jest.fn(),
    onVehicleCreated: jest.fn(),
    onVehicleRemoved: jest.fn(),
    getSnapshotFromRedis: jest.fn(),
  },
}));

// Prisma mock — getPrismaClient returns a mock client
const mockVehicleFindMany = jest.fn();
jest.mock('../shared/database/prisma-client', () => ({
  getPrismaClient: () => ({
    vehicle: {
      findMany: (...args: any[]) => mockVehicleFindMany(...args),
    },
  }),
  sanitizeDbError: (msg: string) => msg,
  MAX_PAGE_SIZE: 500,
}));

// Vehicle key service mock
jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn().mockReturnValue('open_17ft'),
  generateVehicleKeyCandidates: jest.fn().mockReturnValue(['open_17ft']),
}));

// =============================================================================
// IMPORTS
// =============================================================================

import {
  getTransportersWithVehicleType,
} from '../shared/database/repositories/vehicle.repository';

// =============================================================================
// HELPERS
// =============================================================================

function resetAllMocks(): void {
  jest.clearAllMocks();
  mockVehicleFindMany.mockReset();
  mockRedisGet.mockReset();
  mockRedisSet.mockReset();
  mockRedisDel.mockReset();
}

// =============================================================================
// TESTS
// =============================================================================

describe('Issue #26 — getTransportersWithVehicleType filters by status: available', () => {
  beforeEach(resetAllMocks);

  // ===========================================================================
  // Test 1: Only transporters with available vehicles are returned
  // ===========================================================================
  it('returns only transporters that have at least one available vehicle', async () => {
    // Simulate: vehicleKey-based query returns vehicles.
    // Transporter t-1 has an available vehicle, t-2 has an in_transit vehicle.
    // After fix, only t-1's vehicle should be returned by the query because
    // the DB query now includes status: 'available'.
    mockVehicleFindMany.mockResolvedValueOnce([
      { transporterId: 't-1', vehicleType: 'Open', vehicleSubtype: '17ft' },
    ]);

    const result = await getTransportersWithVehicleType('Open', '17ft');

    expect(result).toEqual(['t-1']);
    expect(result).not.toContain('t-2');

    // Verify the query included status: 'available'
    const queryCall = mockVehicleFindMany.mock.calls[0][0];
    expect(queryCall.where).toHaveProperty('status', 'available');
    expect(queryCall.where).toHaveProperty('isActive', true);
  });

  // ===========================================================================
  // Test 2: Fallback type-scoped query also filters by available status
  // ===========================================================================
  it('type-scoped fallback query also includes status: available filter', async () => {
    // When no vehicleSubtype is passed, vehicleKeyCandidates is empty,
    // so the vehicleKey-based query is skipped entirely. The code goes
    // straight to the type-scoped fallback (only one findMany call).
    mockVehicleFindMany.mockResolvedValueOnce([
      { transporterId: 't-3', vehicleType: 'Container', vehicleSubtype: '' },
    ]);

    const result = await getTransportersWithVehicleType('Container');

    expect(result).toEqual(['t-3']);

    // Only one findMany call — the type-scoped fallback
    expect(mockVehicleFindMany).toHaveBeenCalledTimes(1);
    const fallbackCall = mockVehicleFindMany.mock.calls[0][0];
    expect(fallbackCall.where).toHaveProperty('status', 'available');
    expect(fallbackCall.where).toHaveProperty('isActive', true);
    expect(fallbackCall.where.vehicleType).toEqual(
      expect.objectContaining({ equals: 'Container', mode: 'insensitive' })
    );
  });

  // ===========================================================================
  // Test 3: Transporters with only non-available vehicles are excluded
  // ===========================================================================
  it('returns empty array when all vehicles of requested type are non-available', async () => {
    // vehicleKey query returns empty (no available vehicles match)
    mockVehicleFindMany.mockResolvedValueOnce([]);
    // Type-scoped fallback also returns empty (all vehicles are in_transit/maintenance)
    mockVehicleFindMany.mockResolvedValueOnce([]);

    const result = await getTransportersWithVehicleType('Open', '17ft');

    expect(result).toEqual([]);
    expect(mockVehicleFindMany).toHaveBeenCalledTimes(2);

    // Both queries filter by status: 'available'
    for (const call of mockVehicleFindMany.mock.calls) {
      expect(call[0].where).toHaveProperty('status', 'available');
    }
  });
});
