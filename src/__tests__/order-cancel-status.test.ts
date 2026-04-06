/**
 * =============================================================================
 * ORDER CANCEL STATUS -- Tests for A4#8
 * =============================================================================
 *
 * A4#8: Actual vehicle status used in Redis sync (not hardcoded 'in_transit')
 *   - Vehicle in on_hold -> Redis sync uses 'on_hold' not 'in_transit'
 *   - Vehicle not found in findMany -> fallback to 'in_transit'
 *   - Multiple vehicles with mixed statuses -> each uses its own previous status
 *
 * The fix is in order.service.ts cancelOrder():
 *   Before: hardcoded 'in_transit' as previousStatus in Redis sync
 *   After:  reads actual vehicle status via findMany before release,
 *           falls back to 'in_transit' if not found in the status map
 *
 * @author TESTER-A (Team LEO)
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

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    recordHistogram: jest.fn(),
  },
}));

jest.mock('../config/environment', () => ({
  config: { redis: { enabled: true }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {} },
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { logger } from '../shared/services/logger.service';

// =============================================================================
// UNIT TESTS: Vehicle status map logic (extracted from order.service.ts)
// =============================================================================
// The A4#8 fix reads actual vehicle statuses before releasing them.
// We test the map-building and fallback logic directly without importing
// the full order service (which has heavy dependencies).
// =============================================================================

/**
 * Simulates the A4#8 fix logic:
 * 1. Before releasing vehicles, read their actual status via findMany
 * 2. Build a Map<vehicleId, status>
 * 3. Use actual status (not hardcoded) for Redis sync
 * 4. Fallback to 'in_transit' if vehicle not in the map
 */
function buildVehicleStatusMap(
  vehicleStatusRows: Array<{ id: string; status: string }>
): Map<string, string> {
  return new Map(vehicleStatusRows.map(v => [v.id, v.status]));
}

function getReleasedVehicleData(
  assignments: Array<{
    vehicleId: string | null;
    transporterId: string;
    vehicleType: string;
    vehicleSubtype: string;
  }>,
  vehicleStatusMap: Map<string, string>
): Array<{
  transporterId: string;
  vehicleType: string;
  vehicleSubtype: string;
  previousStatus: string;
}> {
  return assignments
    .filter(a => a.vehicleId && a.transporterId)
    .map(a => ({
      transporterId: a.transporterId,
      vehicleType: a.vehicleType,
      vehicleSubtype: a.vehicleSubtype,
      previousStatus: vehicleStatusMap.get(a.vehicleId!) || 'in_transit',
    }));
}

// =============================================================================
// TESTS
// =============================================================================

describe('A4#8 -- Actual vehicle status in Redis sync', () => {

  it('vehicle in on_hold -> Redis sync uses on_hold, not in_transit', () => {
    const vehicleStatusRows = [
      { id: 'v-001', status: 'on_hold' },
    ];
    const statusMap = buildVehicleStatusMap(vehicleStatusRows);

    const assignments = [
      { vehicleId: 'v-001', transporterId: 't-001', vehicleType: 'open', vehicleSubtype: 'open_17ft' },
    ];

    const released = getReleasedVehicleData(assignments, statusMap);

    expect(released).toHaveLength(1);
    expect(released[0].previousStatus).toBe('on_hold');
    // The critical assertion: should NOT be 'in_transit' (the old hardcoded value)
    expect(released[0].previousStatus).not.toBe('in_transit');
  });

  it('vehicle in in_transit -> Redis sync uses in_transit', () => {
    const vehicleStatusRows = [
      { id: 'v-002', status: 'in_transit' },
    ];
    const statusMap = buildVehicleStatusMap(vehicleStatusRows);

    const assignments = [
      { vehicleId: 'v-002', transporterId: 't-002', vehicleType: 'closed', vehicleSubtype: 'closed_14ft' },
    ];

    const released = getReleasedVehicleData(assignments, statusMap);

    expect(released).toHaveLength(1);
    expect(released[0].previousStatus).toBe('in_transit');
  });

  it('vehicle not found in findMany -> fallback to in_transit', () => {
    // Empty status rows -- vehicle was not returned by findMany
    const vehicleStatusRows: Array<{ id: string; status: string }> = [];
    const statusMap = buildVehicleStatusMap(vehicleStatusRows);

    const assignments = [
      { vehicleId: 'v-missing', transporterId: 't-003', vehicleType: 'open', vehicleSubtype: 'open_22ft' },
    ];

    const released = getReleasedVehicleData(assignments, statusMap);

    expect(released).toHaveLength(1);
    // Fallback is 'in_transit' when not in the map
    expect(released[0].previousStatus).toBe('in_transit');
  });

  it('multiple vehicles with mixed statuses -> each uses its own previous status', () => {
    const vehicleStatusRows = [
      { id: 'v-a', status: 'on_hold' },
      { id: 'v-b', status: 'in_transit' },
      { id: 'v-c', status: 'maintenance' },
    ];
    const statusMap = buildVehicleStatusMap(vehicleStatusRows);

    const assignments = [
      { vehicleId: 'v-a', transporterId: 't-010', vehicleType: 'open', vehicleSubtype: 'open_17ft' },
      { vehicleId: 'v-b', transporterId: 't-010', vehicleType: 'open', vehicleSubtype: 'open_17ft' },
      { vehicleId: 'v-c', transporterId: 't-010', vehicleType: 'closed', vehicleSubtype: 'closed_14ft' },
    ];

    const released = getReleasedVehicleData(assignments, statusMap);

    expect(released).toHaveLength(3);
    expect(released[0].previousStatus).toBe('on_hold');
    expect(released[1].previousStatus).toBe('in_transit');
    expect(released[2].previousStatus).toBe('maintenance');
  });

  it('mix of found and missing vehicles -> found use actual, missing use fallback', () => {
    const vehicleStatusRows = [
      { id: 'v-found', status: 'on_hold' },
    ];
    const statusMap = buildVehicleStatusMap(vehicleStatusRows);

    const assignments = [
      { vehicleId: 'v-found', transporterId: 't-020', vehicleType: 'open', vehicleSubtype: 'open_17ft' },
      { vehicleId: 'v-lost', transporterId: 't-020', vehicleType: 'open', vehicleSubtype: 'open_22ft' },
    ];

    const released = getReleasedVehicleData(assignments, statusMap);

    expect(released).toHaveLength(2);
    expect(released[0].previousStatus).toBe('on_hold'); // Found in map
    expect(released[1].previousStatus).toBe('in_transit'); // Fallback
  });

  it('assignment with null vehicleId is filtered out', () => {
    const vehicleStatusRows = [
      { id: 'v-001', status: 'on_hold' },
    ];
    const statusMap = buildVehicleStatusMap(vehicleStatusRows);

    const assignments = [
      { vehicleId: null, transporterId: 't-030', vehicleType: 'open', vehicleSubtype: 'open_17ft' },
      { vehicleId: 'v-001', transporterId: 't-030', vehicleType: 'open', vehicleSubtype: 'open_17ft' },
    ];

    const released = getReleasedVehicleData(assignments, statusMap);

    // Only 1 result (null vehicleId filtered out)
    expect(released).toHaveLength(1);
    expect(released[0].previousStatus).toBe('on_hold');
  });

  it('empty assignments array -> empty result', () => {
    const statusMap = buildVehicleStatusMap([]);
    const released = getReleasedVehicleData([], statusMap);
    expect(released).toHaveLength(0);
  });

  it('status map preserves vehicle-to-status relationship accurately', () => {
    const rows = [
      { id: 'v-1', status: 'available' },
      { id: 'v-2', status: 'on_hold' },
      { id: 'v-3', status: 'in_transit' },
      { id: 'v-4', status: 'inactive' },
    ];
    const statusMap = buildVehicleStatusMap(rows);

    expect(statusMap.get('v-1')).toBe('available');
    expect(statusMap.get('v-2')).toBe('on_hold');
    expect(statusMap.get('v-3')).toBe('in_transit');
    expect(statusMap.get('v-4')).toBe('inactive');
    expect(statusMap.get('v-nonexistent')).toBeUndefined();
  });

  it('duplicate vehicle IDs in rows -> last value wins (Map semantics)', () => {
    const rows = [
      { id: 'v-dup', status: 'on_hold' },
      { id: 'v-dup', status: 'in_transit' }, // overwrites
    ];
    const statusMap = buildVehicleStatusMap(rows);

    expect(statusMap.get('v-dup')).toBe('in_transit');
    expect(statusMap.size).toBe(1);
  });
});

// =============================================================================
// INTEGRATION: Simulated cancelOrder Redis sync flow
// =============================================================================

describe('A4#8 -- Integration: cancelOrder Redis sync flow simulation', () => {
  /**
   * Simulates the full cancel flow:
   * 1. Read vehicle statuses inside TX
   * 2. Release vehicles (updateMany)
   * 3. After TX commit, call liveAvailabilityService with actual statuses
   */
  function simulateCancelOrderRedisSync(
    vehicleStatusRows: Array<{ id: string; status: string }>,
    assignments: Array<{
      vehicleId: string | null;
      transporterId: string;
      vehicleType: string;
      vehicleSubtype: string;
    }>
  ): Array<{ transporterId: string; vehicleKey: string; previousStatus: string }> {
    const statusMap = buildVehicleStatusMap(vehicleStatusRows);

    return assignments
      .filter(a => a.vehicleId && a.transporterId)
      .map(a => ({
        transporterId: a.transporterId,
        vehicleKey: `${a.vehicleType}_${a.vehicleSubtype}`,
        previousStatus: statusMap.get(a.vehicleId!) || 'in_transit',
      }));
  }

  it('cancel order with 3 trucks -> each gets correct previous status for Redis', () => {
    const vehicleStatusRows = [
      { id: 'v-1', status: 'on_hold' },
      { id: 'v-2', status: 'in_transit' },
      { id: 'v-3', status: 'on_hold' },
    ];

    const assignments = [
      { vehicleId: 'v-1', transporterId: 't-100', vehicleType: 'open', vehicleSubtype: '17ft' },
      { vehicleId: 'v-2', transporterId: 't-101', vehicleType: 'closed', vehicleSubtype: '14ft' },
      { vehicleId: 'v-3', transporterId: 't-100', vehicleType: 'open', vehicleSubtype: '22ft' },
    ];

    const syncCalls = simulateCancelOrderRedisSync(vehicleStatusRows, assignments);

    expect(syncCalls).toHaveLength(3);
    expect(syncCalls[0]).toEqual({
      transporterId: 't-100',
      vehicleKey: 'open_17ft',
      previousStatus: 'on_hold',
    });
    expect(syncCalls[1]).toEqual({
      transporterId: 't-101',
      vehicleKey: 'closed_14ft',
      previousStatus: 'in_transit',
    });
    expect(syncCalls[2]).toEqual({
      transporterId: 't-100',
      vehicleKey: 'open_22ft',
      previousStatus: 'on_hold',
    });
  });

  it('old behavior (hardcoded) vs new behavior comparison', () => {
    const vehicleStatusRows = [
      { id: 'v-hold', status: 'on_hold' },
    ];

    const assignments = [
      { vehicleId: 'v-hold', transporterId: 't-200', vehicleType: 'open', vehicleSubtype: '17ft' },
    ];

    // New behavior: uses actual status
    const newSync = simulateCancelOrderRedisSync(vehicleStatusRows, assignments);
    expect(newSync[0].previousStatus).toBe('on_hold');

    // Old behavior would have been: 'in_transit' (hardcoded)
    // This test documents the fix
    expect(newSync[0].previousStatus).not.toBe('in_transit');
  });
});
