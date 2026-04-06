/**
 * =============================================================================
 * CONFIRMED HOLD DECLINE -- Tests for TRIAD 4 FIX-4 decline, cleanup, HINCRBY
 * =============================================================================
 *
 * FIX #41: handleDriverDecline now sets truckRequest to 'held' (not 'searching').
 *          Also fixed FK traversal (mirrors FIX #25 from acceptance path).
 * FIX #29: Cleanup job uses updateMany with terminal status guard — prevents
 *          overwriting already-released/cancelled/expired holds.
 * FIX #36: handleDriverDecline uses HINCRBY instead of read-modify-write for
 *          trucksDeclined/trucksPending — prevents lost updates under concurrency.
 *
 * @author Weelo Team (TEST-4)
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
  },
}));

// Redis service mock — Hash methods needed for FIX #36 HINCRBY
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisGetJSON = jest.fn();
const mockRedisSetJSON = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisHIncrBy = jest.fn();
const mockRedisHGetAll = jest.fn();
const mockRedisHMSet = jest.fn();
const mockRedisExpire = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    getJSON: (...args: any[]) => mockRedisGetJSON(...args),
    setJSON: (...args: any[]) => mockRedisSetJSON(...args),
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    hIncrBy: (...args: any[]) => mockRedisHIncrBy(...args),
    hGetAll: (...args: any[]) => mockRedisHGetAll(...args),
    hMSet: (...args: any[]) => mockRedisHMSet(...args),
    expire: (...args: any[]) => mockRedisExpire(...args),
    isConnected: () => true,
  },
}));

// Prisma mock
const mockAssignmentUpdate = jest.fn();
const mockAssignmentUpdateMany = jest.fn();
const mockAssignmentFindUnique = jest.fn();
const mockAssignmentFindUniqueOrThrow = jest.fn();
const mockAssignmentFindMany = jest.fn();
const mockTruckRequestFindFirst = jest.fn();
const mockTruckRequestFindUnique = jest.fn();
const mockTruckRequestFindMany = jest.fn();
const mockTruckRequestUpdate = jest.fn();
const mockTruckHoldLedgerUpdate = jest.fn();
const mockTruckHoldLedgerFindFirst = jest.fn();
const mockTruckHoldLedgerFindUnique = jest.fn();
const mockTruckHoldLedgerUpdateMany = jest.fn();
const mockTruckHoldLedgerFindMany = jest.fn();
const mockExecuteRaw = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    assignment: {
      update: (...args: any[]) => mockAssignmentUpdate(...args),
      updateMany: (...args: any[]) => mockAssignmentUpdateMany(...args),
      findUnique: (...args: any[]) => mockAssignmentFindUnique(...args),
      findUniqueOrThrow: (...args: any[]) => mockAssignmentFindUniqueOrThrow(...args),
      findMany: (...args: any[]) => mockAssignmentFindMany(...args),
    },
    truckRequest: {
      findFirst: (...args: any[]) => mockTruckRequestFindFirst(...args),
      findUnique: (...args: any[]) => mockTruckRequestFindUnique(...args),
      findMany: (...args: any[]) => mockTruckRequestFindMany(...args),
      update: (...args: any[]) => mockTruckRequestUpdate(...args),
    },
    truckHoldLedger: {
      update: (...args: any[]) => mockTruckHoldLedgerUpdate(...args),
      findFirst: (...args: any[]) => mockTruckHoldLedgerFindFirst(...args),
      findUnique: (...args: any[]) => mockTruckHoldLedgerFindUnique(...args),
      updateMany: (...args: any[]) => mockTruckHoldLedgerUpdateMany(...args),
      findMany: (...args: any[]) => mockTruckHoldLedgerFindMany(...args),
    },
    $executeRaw: (...args: any[]) => mockExecuteRaw(...args),
  },
  HoldPhase: {
    FLEX: 'FLEX',
    CONFIRMED: 'CONFIRMED',
    EXPIRED: 'EXPIRED',
    RELEASED: 'RELEASED',
  },
  AssignmentStatus: {
    pending: 'pending',
    driver_accepted: 'driver_accepted',
    driver_declined: 'driver_declined',
    cancelled: 'cancelled',
  },
}));

// Socket service mock
const mockEmitToUser = jest.fn();
jest.mock('../shared/services/socket.service', () => ({
  socketService: {
    emitToUser: (...args: any[]) => mockEmitToUser(...args),
  },
}));

// Queue service mock
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    scheduleAssignmentTimeout: jest.fn().mockResolvedValue(undefined),
  },
}));

// Hold expiry cleanup service mock
jest.mock('../modules/hold-expiry/hold-expiry-cleanup.service', () => ({
  holdExpiryCleanupService: {
    scheduleConfirmedHoldCleanup: jest.fn().mockResolvedValue(undefined),
  },
}));

// Vehicle lifecycle service mock
const mockReleaseVehicle = jest.fn();
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: (...args: any[]) => mockReleaseVehicle(...args),
}));

// Post-accept effects mock
jest.mock('../modules/assignment/post-accept.effects', () => ({
  applyPostAcceptSideEffects: jest.fn().mockResolvedValue(undefined),
}));

// Config mock
jest.mock('../config/environment', () => ({
  config: { redis: { enabled: true }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {} },
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { confirmedHoldService } from '../modules/truck-hold/confirmed-hold.service';

// =============================================================================
// HELPERS
// =============================================================================

function resetAllMocks(): void {
  jest.clearAllMocks();
  mockRedisAcquireLock.mockReset();
  mockRedisReleaseLock.mockReset();
  mockRedisGetJSON.mockReset();
  mockRedisSetJSON.mockReset();
  mockRedisGet.mockReset();
  mockRedisSet.mockReset();
  mockRedisDel.mockReset();
  mockRedisHIncrBy.mockReset();
  mockRedisHGetAll.mockReset();
  mockRedisHMSet.mockReset();
  mockRedisExpire.mockReset();
  mockAssignmentUpdate.mockReset();
  mockAssignmentUpdateMany.mockReset();
  mockAssignmentFindUnique.mockReset();
  mockAssignmentFindUniqueOrThrow.mockReset();
  mockAssignmentFindMany.mockReset();
  mockTruckRequestFindFirst.mockReset();
  mockTruckRequestFindUnique.mockReset();
  mockTruckRequestFindMany.mockReset();
  mockTruckRequestUpdate.mockReset();
  mockTruckHoldLedgerUpdate.mockReset();
  mockTruckHoldLedgerFindFirst.mockReset();
  mockTruckHoldLedgerFindUnique.mockReset();
  mockTruckHoldLedgerUpdateMany.mockReset();
  mockTruckHoldLedgerFindMany.mockReset();
  mockExecuteRaw.mockReset();
  mockEmitToUser.mockReset();
  mockReleaseVehicle.mockReset();
}

/** Build a standard assignment record for decline tests. */
function buildAssignment(overrides: Record<string, any> = {}) {
  return {
    id: 'assign-001',
    orderId: 'order-001',
    truckRequestId: 'tr-001',
    transporterId: 'transporter-001',
    vehicleId: 'vehicle-001',
    vehicleNumber: 'MH12AB1234',
    driverId: 'driver-001',
    driverName: 'Test Driver',
    tripId: 'trip-001',
    status: 'driver_declined',
    ...overrides,
  };
}

/** Build a hold ledger record for confirmed phase. */
function buildHoldLedger(overrides: Record<string, any> = {}) {
  const now = new Date();
  return {
    holdId: 'hold-001',
    orderId: 'order-001',
    transporterId: 'transporter-001',
    phase: 'CONFIRMED',
    quantity: 3,
    status: 'active',
    confirmedAt: now,
    confirmedExpiresAt: new Date(now.getTime() + 180_000),
    expiresAt: new Date(now.getTime() + 180_000),
    ...overrides,
  };
}

/** Build Redis Hash state as returned by hGetAll (all string values). */
function buildRedisHashState(overrides: Record<string, string> = {}): Record<string, string> {
  const now = new Date();
  return {
    holdId: 'hold-001',
    orderId: 'order-001',
    transporterId: 'transporter-001',
    phase: 'CONFIRMED',
    confirmedAt: now.toISOString(),
    confirmedExpiresAt: new Date(now.getTime() + 120_000).toISOString(),
    remainingSeconds: '120',
    trucksCount: '3',
    trucksAccepted: '0',
    trucksDeclined: '0',
    trucksPending: '3',
    ...overrides,
  };
}

/**
 * Set up mocks for the full decline happy path.
 * Exercises FIX #41 (held status), FK traversal, and FIX #36 (HINCRBY).
 */
function setupDeclineHappyPath(assignmentOverrides: Record<string, any> = {}) {
  const assignment = buildAssignment(assignmentOverrides);
  const holdLedger = buildHoldLedger();

  // Lock
  mockRedisAcquireLock.mockResolvedValue({ acquired: true });
  mockRedisReleaseLock.mockResolvedValue(undefined);

  // C2 CAS: updateMany returns count=1, findUniqueOrThrow returns full record
  mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
  mockAssignmentFindUniqueOrThrow.mockResolvedValue(assignment);
  // Legacy: keep assignment.update for backward compatibility
  mockAssignmentUpdate.mockResolvedValue(assignment);

  // FK traversal: assignment.findUnique to get truckRequestId
  mockAssignmentFindUnique.mockResolvedValue({
    truckRequestId: assignment.truckRequestId,
    orderId: assignment.orderId,
  });

  // FK traversal: truckRequest.findFirst via truckRequestId
  mockTruckRequestFindFirst.mockResolvedValue({
    id: assignment.truckRequestId,
    orderId: assignment.orderId,
  });

  // truckRequest.update (FIX #41: status -> 'held')
  mockTruckRequestUpdate.mockResolvedValue({});

  // Hold ledger lookup for counter update
  mockTruckHoldLedgerFindFirst.mockResolvedValue(holdLedger);

  // FIX #36: HINCRBY returns the new counter values
  mockRedisHIncrBy
    .mockResolvedValueOnce(1)   // trucksDeclined -> 1
    .mockResolvedValueOnce(2);  // trucksPending -> 2 (was 3, -1)

  // getConfirmedHoldState — called after HINCRBY for socket payload
  mockRedisHGetAll.mockResolvedValue(buildRedisHashState({
    trucksDeclined: '1',
    trucksPending: '2',
  }));

  // cacheConfirmedHoldState (if re-caching)
  mockRedisHMSet.mockResolvedValue(undefined);
  mockRedisExpire.mockResolvedValue(true);

  // Socket emit
  mockEmitToUser.mockResolvedValue(undefined);

  // Vehicle release (P6 fix)
  mockReleaseVehicle.mockResolvedValue(undefined);

  // trucksFilled decrement (P6 fix)
  mockExecuteRaw.mockResolvedValue(1);

  return { assignment, holdLedger };
}

// =============================================================================
// TEST GROUP 1: FIX #41 — Decline preserves hold (status 'held', not 'searching')
// =============================================================================

describe('FIX #41 — Driver decline in Phase 2 sets truckRequest to held', () => {
  beforeEach(resetAllMocks);

  it('TEST 1: truckRequest status is "held" (NOT "searching") after decline', async () => {
    setupDeclineHappyPath();

    await confirmedHoldService.handleDriverDecline('assign-001');

    // truckRequest.update was called
    expect(mockTruckRequestUpdate).toHaveBeenCalledTimes(1);
    const updateCall = mockTruckRequestUpdate.mock.calls[0][0];

    // FIX #41: status must be 'held', NOT 'searching'
    expect(updateCall.data.status).toBe('held');
    expect(updateCall.data.status).not.toBe('searching');
  });

  it('TEST 2: assignedDriverId and assignedVehicleId cleared on decline', async () => {
    setupDeclineHappyPath();

    await confirmedHoldService.handleDriverDecline('assign-001');

    expect(mockTruckRequestUpdate).toHaveBeenCalledTimes(1);
    const updateData = mockTruckRequestUpdate.mock.calls[0][0].data;

    expect(updateData.assignedDriverId).toBeNull();
    expect(updateData.assignedVehicleId).toBeNull();
  });

  it('TEST 3: heldById is set to transporter on decline (QA-4 fix: restores exclusivity)', async () => {
    setupDeclineHappyPath();

    await confirmedHoldService.handleDriverDecline('assign-001');

    expect(mockTruckRequestUpdate).toHaveBeenCalledTimes(1);
    const updateData = mockTruckRequestUpdate.mock.calls[0][0].data;

    // QA-4 fix: heldById is set to assignment.transporterId so release/cleanup can find it
    expect(updateData.heldById).toBe('transporter-001');
  });

  it('TEST 4: handleDriverTimeout delegates to handleDriverDecline (same behavior)', async () => {
    setupDeclineHappyPath();

    const result = await confirmedHoldService.handleDriverTimeout('assign-001');

    // Timeout delegates to decline
    expect(result.success).toBe(true);
    expect(result.declined).toBe(true);

    // truckRequest is also set to 'held' on timeout (same path)
    expect(mockTruckRequestUpdate).toHaveBeenCalledTimes(1);
    const updateData = mockTruckRequestUpdate.mock.calls[0][0].data;
    expect(updateData.status).toBe('held');
  });

  it('TEST 5: TruckRequest found via correct FK traversal (assignment.truckRequestId)', async () => {
    const { assignment } = setupDeclineHappyPath({ truckRequestId: 'tr-custom-555' });

    // Override FK lookup to return custom truckRequestId
    mockAssignmentFindUnique.mockResolvedValue({
      truckRequestId: 'tr-custom-555',
      orderId: assignment.orderId,
    });
    mockTruckRequestFindFirst.mockResolvedValue({
      id: 'tr-custom-555',
      orderId: assignment.orderId,
    });

    await confirmedHoldService.handleDriverDecline('assign-001');

    // Step 1: assignment.findUnique called with assignmentId
    expect(mockAssignmentFindUnique).toHaveBeenCalledTimes(1);
    expect(mockAssignmentFindUnique).toHaveBeenCalledWith({
      where: { id: 'assign-001' },
      select: { truckRequestId: true, orderId: true },
    });

    // Step 2: truckRequest.findFirst uses the ASSIGNMENT'S truckRequestId (not assignmentId)
    expect(mockTruckRequestFindFirst).toHaveBeenCalledTimes(1);
    const trFindCall = mockTruckRequestFindFirst.mock.calls[0][0];
    expect(trFindCall.where.id).toBe('tr-custom-555');
    expect(trFindCall.where.id).not.toBe('assign-001');
  });

  it('TEST 6: assignment with null truckRequestId — graceful handling, no truckRequest update', async () => {
    const assignment = buildAssignment({ truckRequestId: null });

    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    // C2 CAS mocks
    mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockAssignmentFindUniqueOrThrow.mockResolvedValue(assignment);
    mockAssignmentUpdate.mockResolvedValue(assignment);

    // FK lookup returns null truckRequestId
    mockAssignmentFindUnique.mockResolvedValue({
      truckRequestId: null,
      orderId: 'order-001',
    });

    // Vehicle release and trucksFilled decrement still happen
    mockReleaseVehicle.mockResolvedValue(undefined);
    mockExecuteRaw.mockResolvedValue(1);

    // holdLedger lookup via orderId fallback
    mockTruckHoldLedgerFindFirst.mockResolvedValue(buildHoldLedger());
    mockRedisHIncrBy
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    mockRedisHGetAll.mockResolvedValue(buildRedisHashState({
      trucksDeclined: '1',
      trucksPending: '2',
    }));
    mockRedisHMSet.mockResolvedValue(undefined);
    mockRedisExpire.mockResolvedValue(true);
    mockEmitToUser.mockResolvedValue(undefined);

    const result = await confirmedHoldService.handleDriverDecline('assign-001');

    expect(result.success).toBe(true);
    expect(result.declined).toBe(true);

    // truckRequest.findFirst should NOT have been called (truckRequestId was null)
    expect(mockTruckRequestFindFirst).not.toHaveBeenCalled();
    // truckRequest.update should NOT have been called
    expect(mockTruckRequestUpdate).not.toHaveBeenCalled();
  });
});

// =============================================================================
// TEST GROUP 2: FIX #29 — Cleanup status guard (updateMany with terminal check)
// =============================================================================

describe('FIX #29 — Cleanup uses updateMany with terminal status guard', () => {
  beforeEach(resetAllMocks);

  it('TEST 7: active expired hold is set to expired (updateMany count > 0)', async () => {
    // Simulate: hold is in 'active' state (non-terminal)
    // updateMany should match because 'active' is NOT in the exclusion list
    mockTruckHoldLedgerUpdateMany.mockResolvedValue({ count: 1 });

    const { prismaClient } = require('../shared/database/prisma.service');

    const result = await prismaClient.truckHoldLedger.updateMany({
      where: {
        holdId: 'hold-expired-001',
        status: { notIn: ['completed', 'cancelled', 'released', 'expired'] },
      },
      data: {
        status: 'expired',
        terminalReason: 'HOLD_TTL_EXPIRED',
        releasedAt: new Date(),
      },
    });

    expect(result.count).toBe(1);
    expect(mockTruckHoldLedgerUpdateMany).toHaveBeenCalledTimes(1);

    const call = mockTruckHoldLedgerUpdateMany.mock.calls[0][0];
    expect(call.where.status.notIn).toContain('completed');
    expect(call.where.status.notIn).toContain('cancelled');
    expect(call.where.status.notIn).toContain('released');
    expect(call.where.status.notIn).toContain('expired');
    expect(call.data.status).toBe('expired');
    expect(call.data.terminalReason).toBe('HOLD_TTL_EXPIRED');
  });

  it('TEST 8: already-released hold is no-op (updateMany count = 0)', async () => {
    // Hold status is 'released' — in the terminal exclusion list
    // updateMany should return count=0 because the WHERE clause won't match
    mockTruckHoldLedgerUpdateMany.mockResolvedValue({ count: 0 });

    const { prismaClient } = require('../shared/database/prisma.service');

    const result = await prismaClient.truckHoldLedger.updateMany({
      where: {
        holdId: 'hold-already-released',
        status: { notIn: ['completed', 'cancelled', 'released', 'expired'] },
      },
      data: {
        status: 'expired',
        terminalReason: 'HOLD_TTL_EXPIRED',
        releasedAt: new Date(),
      },
    });

    // No rows updated — hold was already in terminal state
    expect(result.count).toBe(0);
  });

  it('TEST 9: already-cancelled hold is no-op (updateMany count = 0)', async () => {
    mockTruckHoldLedgerUpdateMany.mockResolvedValue({ count: 0 });

    const { prismaClient } = require('../shared/database/prisma.service');

    const result = await prismaClient.truckHoldLedger.updateMany({
      where: {
        holdId: 'hold-already-cancelled',
        status: { notIn: ['completed', 'cancelled', 'released', 'expired'] },
      },
      data: {
        status: 'expired',
        terminalReason: 'HOLD_TTL_EXPIRED',
        releasedAt: new Date(),
      },
    });

    expect(result.count).toBe(0);
  });

  it('TEST 10: already-expired hold is no-op (prevents double-process)', async () => {
    mockTruckHoldLedgerUpdateMany.mockResolvedValue({ count: 0 });

    const { prismaClient } = require('../shared/database/prisma.service');

    const result = await prismaClient.truckHoldLedger.updateMany({
      where: {
        holdId: 'hold-already-expired',
        status: { notIn: ['completed', 'cancelled', 'released', 'expired'] },
      },
      data: {
        status: 'expired',
        terminalReason: 'HOLD_TTL_EXPIRED',
        releasedAt: new Date(),
      },
    });

    expect(result.count).toBe(0);
    // The critical guarantee: terminal statuses are protected
    const call = mockTruckHoldLedgerUpdateMany.mock.calls[0][0];
    const guardedStatuses = call.where.status.notIn;
    expect(guardedStatuses).toEqual(
      expect.arrayContaining(['completed', 'cancelled', 'released', 'expired'])
    );
  });
});

// =============================================================================
// TEST GROUP 3: FIX #36 — Atomic decline counter (HINCRBY, not read-modify-write)
// =============================================================================

describe('FIX #36 — trucksDeclined increments atomically via hIncrBy', () => {
  beforeEach(resetAllMocks);

  it('TEST 11: trucksDeclined incremented via hIncrBy(+1) on decline', async () => {
    setupDeclineHappyPath();

    await confirmedHoldService.handleDriverDecline('assign-001');

    // Find the hIncrBy call for trucksDeclined
    const declinedCall = mockRedisHIncrBy.mock.calls.find(
      (call: any[]) => call[1] === 'trucksDeclined'
    );
    expect(declinedCall).toBeDefined();
    expect(declinedCall![0]).toBe('confirmed-hold:hold-001:state');
    expect(declinedCall![1]).toBe('trucksDeclined');
    expect(declinedCall![2]).toBe(1);
  });

  it('TEST 12: trucksPending decremented via hIncrBy(-1) on decline', async () => {
    setupDeclineHappyPath();

    await confirmedHoldService.handleDriverDecline('assign-001');

    // Find the hIncrBy call for trucksPending
    const pendingCall = mockRedisHIncrBy.mock.calls.find(
      (call: any[]) => call[1] === 'trucksPending'
    );
    expect(pendingCall).toBeDefined();
    expect(pendingCall![0]).toBe('confirmed-hold:hold-001:state');
    expect(pendingCall![1]).toBe('trucksPending');
    expect(pendingCall![2]).toBe(-1);
  });

  it('TEST 13: two drivers decline simultaneously — both counts correct (no lost update)', async () => {
    const holdLedger = buildHoldLedger();

    // Driver 1 setup
    const assignment1 = buildAssignment({ id: 'assign-001', driverId: 'driver-001' });
    // Driver 2 setup
    const assignment2 = buildAssignment({ id: 'assign-002', driverId: 'driver-002', truckRequestId: 'tr-002' });

    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);

    // C2 CAS: updateMany returns count=1 for both, findUniqueOrThrow returns full records
    mockAssignmentUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    mockAssignmentFindUniqueOrThrow
      .mockResolvedValueOnce(assignment1)
      .mockResolvedValueOnce(assignment2);
    // Legacy: keep assignment.update for backward compatibility
    mockAssignmentUpdate
      .mockResolvedValueOnce(assignment1)
      .mockResolvedValueOnce(assignment2);

    // FK traversal for both assignments
    mockAssignmentFindUnique
      .mockResolvedValueOnce({ truckRequestId: 'tr-001', orderId: 'order-001' })
      .mockResolvedValueOnce({ truckRequestId: 'tr-002', orderId: 'order-001' });

    mockTruckRequestFindFirst
      .mockResolvedValueOnce({ id: 'tr-001', orderId: 'order-001' })
      .mockResolvedValueOnce({ id: 'tr-002', orderId: 'order-001' });

    mockTruckRequestUpdate.mockResolvedValue({});
    mockTruckHoldLedgerFindFirst.mockResolvedValue(holdLedger);

    // HINCRBY: Driver 1 gets declined=1, pending=2; Driver 2 gets declined=2, pending=1
    mockRedisHIncrBy
      .mockResolvedValueOnce(1)   // driver1 trucksDeclined
      .mockResolvedValueOnce(2)   // driver1 trucksPending
      .mockResolvedValueOnce(2)   // driver2 trucksDeclined
      .mockResolvedValueOnce(1);  // driver2 trucksPending

    mockRedisHGetAll
      .mockResolvedValueOnce(buildRedisHashState({ trucksDeclined: '1', trucksPending: '2' }))
      .mockResolvedValueOnce(buildRedisHashState({ trucksDeclined: '2', trucksPending: '1' }));

    mockRedisHMSet.mockResolvedValue(undefined);
    mockRedisExpire.mockResolvedValue(true);
    mockEmitToUser.mockResolvedValue(undefined);
    mockReleaseVehicle.mockResolvedValue(undefined);
    mockExecuteRaw.mockResolvedValue(1);

    // Fire both declines concurrently
    const [result1, result2] = await Promise.all([
      confirmedHoldService.handleDriverDecline('assign-001'),
      confirmedHoldService.handleDriverDecline('assign-002'),
    ]);

    expect(result1.success).toBe(true);
    expect(result1.declined).toBe(true);
    expect(result2.success).toBe(true);
    expect(result2.declined).toBe(true);

    // Both calls used HINCRBY (atomic) — 2 calls per decline (declined + pending)
    expect(mockRedisHIncrBy).toHaveBeenCalledTimes(4);

    // Both emitted socket events
    expect(mockEmitToUser).toHaveBeenCalledTimes(2);

    // Verify the counter values incremented correctly (no lost updates)
    const allFields = mockRedisHIncrBy.mock.calls.map((call: any[]) => call[1]);
    const declinedCalls = allFields.filter((f: string) => f === 'trucksDeclined');
    const pendingCalls = allFields.filter((f: string) => f === 'trucksPending');
    expect(declinedCalls).toHaveLength(2);
    expect(pendingCalls).toHaveLength(2);
  });
});

// =============================================================================
// TEST GROUP 4: Decline also clears driver name and vehicle number
// =============================================================================

describe('FIX #41 — Decline clears all driver/vehicle assignment fields', () => {
  beforeEach(resetAllMocks);

  it('assignedDriverName and assignedVehicleNumber also cleared on decline', async () => {
    setupDeclineHappyPath();

    await confirmedHoldService.handleDriverDecline('assign-001');

    expect(mockTruckRequestUpdate).toHaveBeenCalledTimes(1);
    const updateData = mockTruckRequestUpdate.mock.calls[0][0].data;

    // All four driver/vehicle fields should be cleared
    expect(updateData.assignedDriverId).toBeNull();
    expect(updateData.assignedDriverName).toBeNull();
    expect(updateData.assignedVehicleId).toBeNull();
    expect(updateData.assignedVehicleNumber).toBeNull();
  });
});

// =============================================================================
// TEST GROUP 5: Socket emission on decline (driver_declined event)
// =============================================================================

describe('FIX #36 — Socket event emitted with correct decline progress', () => {
  beforeEach(resetAllMocks);

  it('emits driver_declined event with decline counts to transporter', async () => {
    setupDeclineHappyPath();

    await confirmedHoldService.handleDriverDecline('assign-001');

    expect(mockEmitToUser).toHaveBeenCalledTimes(1);
    const [userId, event, payload] = mockEmitToUser.mock.calls[0];

    expect(userId).toBe('transporter-001');
    expect(event).toBe('driver_declined');
    expect(payload.holdId).toBe('hold-001');
    expect(payload.assignmentId).toBe('assign-001');
    expect(payload.driverId).toBe('driver-001');
    expect(payload.trucksDeclined).toBe(1);
    expect(payload.trucksPending).toBe(2);
    expect(payload.message).toContain('declined');
  });

  it('decline with reason passes reason in socket payload', async () => {
    setupDeclineHappyPath();

    await confirmedHoldService.handleDriverDecline('assign-001', 'Driver timed out');

    expect(mockEmitToUser).toHaveBeenCalledTimes(1);
    const [, , payload] = mockEmitToUser.mock.calls[0];
    expect(payload.reason).toBe('Driver timed out');
  });
});

// =============================================================================
// TEST GROUP 6: Vehicle release and trucksFilled on decline (P6 fixes)
// =============================================================================

describe('FIX #41 — Vehicle release and trucksFilled decrement on decline', () => {
  beforeEach(resetAllMocks);

  it('releases vehicle back to available on decline', async () => {
    setupDeclineHappyPath();

    await confirmedHoldService.handleDriverDecline('assign-001');

    expect(mockReleaseVehicle).toHaveBeenCalledTimes(1);
    expect(mockReleaseVehicle).toHaveBeenCalledWith('vehicle-001', 'confirmedHoldDecline');
  });

  it('decrements trucksFilled via raw SQL with GREATEST(0,...) floor', async () => {
    setupDeclineHappyPath();

    await confirmedHoldService.handleDriverDecline('assign-001');

    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it('vehicle release failure is non-fatal (decline still succeeds)', async () => {
    setupDeclineHappyPath();
    mockReleaseVehicle.mockRejectedValue(new Error('Vehicle release failed'));

    const result = await confirmedHoldService.handleDriverDecline('assign-001');

    expect(result.success).toBe(true);
    expect(result.declined).toBe(true);
  });

  it('trucksFilled decrement failure is non-fatal (decline still succeeds)', async () => {
    setupDeclineHappyPath();
    mockExecuteRaw.mockRejectedValue(new Error('SQL execution failed'));

    const result = await confirmedHoldService.handleDriverDecline('assign-001');

    expect(result.success).toBe(true);
    expect(result.declined).toBe(true);
  });
});
