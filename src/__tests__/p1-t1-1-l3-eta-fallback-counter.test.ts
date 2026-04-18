/**
 * =============================================================================
 * P1-T1.1 L3 — `eta_ranking_fallback_total` counter
 * =============================================================================
 *
 * Verifies that the progressive-radius matcher emits
 * `eta_ranking_fallback_total` with labels (reason, stepIndex, errorClass)
 * BEFORE falling back to the Haversine-ordered candidate list when Google
 * Distance Matrix throws.
 *
 * Run: npx jest src/__tests__/p1-t1-1-l3-eta-fallback-counter.test.ts --forceExit
 * =============================================================================
 */

// -----------------------------------------------------------------------------
// Mocks (must be declared before importing the module under test)
// -----------------------------------------------------------------------------
// NOTE: wrapped in `export {}` at EOF so this file is treated as a module and
// its `const` identifiers don't collide with sibling test files at type-check
// time (TS6200).

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const l3MockIncrementCounter = jest.fn();
const l3MockObserveHistogram = jest.fn();

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: (...args: unknown[]) => l3MockIncrementCounter(...args),
    observeHistogram: (...args: unknown[]) => l3MockObserveHistogram(...args),
    recordHistogram: jest.fn(),
    setGauge: jest.fn(),
  },
}));

const l3MockSmIsMembers = jest.fn();
const l3MockExists = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    smIsMembers: (...a: unknown[]) => l3MockSmIsMembers(...a),
    exists: (...a: unknown[]) => l3MockExists(...a),
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    sMembers: jest.fn(),
    sAdd: jest.fn(),
    sRem: jest.fn(),
    sUnion: jest.fn(),
    hGetAll: jest.fn(),
    hGetAllBatch: jest.fn().mockResolvedValue([]),
    expire: jest.fn(),
    isConnected: jest.fn().mockReturnValue(true),
  },
}));

const l3MockGetAvailableTransportersWithDetails = jest.fn();

jest.mock('../shared/services/availability.service', () => ({
  availabilityService: {
    loadTransporterDetailsMap: jest.fn(),
    getAvailableTransportersWithDetails: (...a: unknown[]) =>
      l3MockGetAvailableTransportersWithDetails(...a),
  },
}));

jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn((a: string, b: string) => `${a}_${b}`),
  generateVehicleKeyCandidates: jest.fn((a: string, b: string) => [`${a}_${b}`]),
}));

jest.mock('../shared/services/h3-geo-index.service', () => ({
  h3GeoIndexService: {
    getCandidatesNewRing: jest.fn(),
    getCandidates: jest.fn(),
    latLngToCell: jest.fn(),
  },
  getH3Mode: () => 'off',
  get FF_H3_INDEX_ENABLED() {
    return false;
  },
}));

jest.mock('../shared/services/circuit-breaker.service', () => ({
  h3Circuit: {
    tryWithFallback: jest.fn(async (_fn: () => Promise<unknown>, fallback: () => Promise<unknown>) =>
      fallback(),
    ),
  },
}));

const l3MockBatchGetPickupDistance = jest.fn();

jest.mock('../shared/services/distance-matrix.service', () => ({
  distanceMatrixService: {
    batchGetPickupDistance: (...a: unknown[]) => l3MockBatchGetPickupDistance(...a),
  },
}));

// -----------------------------------------------------------------------------
// Test helpers (prefixed with L3_ to avoid TS6200 collisions with siblings).
// -----------------------------------------------------------------------------

const L3_PICKUP_LAT = 28.6139;
const L3_PICKUP_LNG = 77.2090;
const L3_VEHICLE_TYPE = 'truck_14ft';
const L3_VEHICLE_SUBTYPE = 'open';

interface SeededTransporter {
  transporterId: string;
  latitude: number;
  longitude: number;
  distanceKm: number;
}

function seedGeoCandidates(count: number): SeededTransporter[] {
  const out: SeededTransporter[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      transporterId: `t-${i + 1}`,
      latitude: L3_PICKUP_LAT + 0.001 * (i + 1),
      longitude: L3_PICKUP_LNG + 0.001 * (i + 1),
      distanceKm: 1 + i * 0.1,
    });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('P1-L3 eta_ranking_fallback_total counter', () => {
  let progressiveRadiusMatcher: {
    findCandidates: (params: {
      pickupLat: number;
      pickupLng: number;
      vehicleType: string;
      vehicleSubtype: string;
      stepIndex: number;
      alreadyNotified: Set<string>;
      limit?: number;
    }) => Promise<unknown[]>;
  };

  beforeAll(() => {
    jest.resetModules();
    process.env.H3_MODE = 'off';
    delete process.env.FF_H3_INDEX_ENABLED;
    progressiveRadiusMatcher = require('../modules/order/progressive-radius-matcher')
      .progressiveRadiusMatcher;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    l3MockSmIsMembers.mockImplementation(async (_: string, ids: string[]) => ids.map(() => true));
    l3MockExists.mockResolvedValue(true);
  });

  it('increments counter with reason+stepIndex+errorClass when Distance Matrix throws', async () => {
    const seeded = seedGeoCandidates(5);
    l3MockGetAvailableTransportersWithDetails.mockResolvedValue(seeded);
    l3MockBatchGetPickupDistance.mockRejectedValue(new Error('Distance Matrix API returned: OVER_QUERY_LIMIT'));

    const result = await progressiveRadiusMatcher.findCandidates({
      pickupLat: L3_PICKUP_LAT,
      pickupLng: L3_PICKUP_LNG,
      vehicleType: L3_VEHICLE_TYPE,
      vehicleSubtype: L3_VEHICLE_SUBTYPE,
      stepIndex: 2,
      alreadyNotified: new Set(),
      limit: 250,
    });

    // Fallback must still return the candidates (bounded to limit).
    expect(result.length).toBeGreaterThan(0);

    // Counter must fire exactly once with the documented labels.
    const fallbackCalls = l3MockIncrementCounter.mock.calls.filter(
      c => c[0] === 'eta_ranking_fallback_total'
    );
    expect(fallbackCalls).toHaveLength(1);
    expect(fallbackCalls[0][1]).toEqual({
      reason: 'distance_matrix_failure',
      stepIndex: '2',
      errorClass: 'Error',
    });
  });

  it('uses errorClass="TypeError" when underlying error is a TypeError', async () => {
    l3MockGetAvailableTransportersWithDetails.mockResolvedValue(seedGeoCandidates(3));
    l3MockBatchGetPickupDistance.mockRejectedValue(new TypeError('foo is not a function'));

    await progressiveRadiusMatcher.findCandidates({
      pickupLat: L3_PICKUP_LAT,
      pickupLng: L3_PICKUP_LNG,
      vehicleType: L3_VEHICLE_TYPE,
      vehicleSubtype: L3_VEHICLE_SUBTYPE,
      stepIndex: 0,
      alreadyNotified: new Set(),
      limit: 250,
    });

    const fallbackCalls = l3MockIncrementCounter.mock.calls.filter(
      c => c[0] === 'eta_ranking_fallback_total'
    );
    expect(fallbackCalls).toHaveLength(1);
    expect(fallbackCalls[0][1]).toEqual({
      reason: 'distance_matrix_failure',
      stepIndex: '0',
      errorClass: 'TypeError',
    });
  });

  it('uses errorClass="Unknown" when thrown value is not an Error instance', async () => {
    l3MockGetAvailableTransportersWithDetails.mockResolvedValue(seedGeoCandidates(3));
    l3MockBatchGetPickupDistance.mockRejectedValue('string error, not an Error');

    await progressiveRadiusMatcher.findCandidates({
      pickupLat: L3_PICKUP_LAT,
      pickupLng: L3_PICKUP_LNG,
      vehicleType: L3_VEHICLE_TYPE,
      vehicleSubtype: L3_VEHICLE_SUBTYPE,
      stepIndex: 1,
      alreadyNotified: new Set(),
      limit: 250,
    });

    const fallbackCalls = l3MockIncrementCounter.mock.calls.filter(
      c => c[0] === 'eta_ranking_fallback_total'
    );
    expect(fallbackCalls).toHaveLength(1);
    expect(fallbackCalls[0][1]).toEqual({
      reason: 'distance_matrix_failure',
      stepIndex: '1',
      errorClass: 'Unknown',
    });
  });

  it('does NOT increment counter on Distance Matrix success', async () => {
    const seeded = seedGeoCandidates(4);
    l3MockGetAvailableTransportersWithDetails.mockResolvedValue(seeded);
    // Return an empty result map — the matcher treats this as a successful
    // (non-throwing) batch call and continues with haversine distances.
    l3MockBatchGetPickupDistance.mockResolvedValue(new Map());

    await progressiveRadiusMatcher.findCandidates({
      pickupLat: L3_PICKUP_LAT,
      pickupLng: L3_PICKUP_LNG,
      vehicleType: L3_VEHICLE_TYPE,
      vehicleSubtype: L3_VEHICLE_SUBTYPE,
      stepIndex: 0,
      alreadyNotified: new Set(),
      limit: 250,
    });

    const fallbackCalls = l3MockIncrementCounter.mock.calls.filter(
      c => c[0] === 'eta_ranking_fallback_total'
    );
    expect(fallbackCalls).toHaveLength(0);
  });
});

export {};
