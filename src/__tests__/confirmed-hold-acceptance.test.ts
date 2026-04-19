/**
 * =============================================================================
 * CONFIRMED HOLD ACCEPTANCE — Tests for FIX #25 (FK traversal) and FIX #28
 *                              (HINCRBY atomic counters)
 * =============================================================================
 *
 * FIX #25: handleDriverAcceptance now queries Assignment first to get
 *          truckRequestId, then finds correct TruckRequest (not assignmentId).
 *
 * FIX #28: Replaced JSON blob (GET+parse → modify → SET) with Redis Hash
 *          (HMSET) + atomic HINCRBY for counter updates. Updated
 *          getConfirmedHoldState (HGETALL) and cacheConfirmedHoldState (HMSET).
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
  },
}));

// Redis service mock — all Hash methods required by FIX #28
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
const mockAssignmentCount = jest.fn();
const mockTruckRequestFindFirst = jest.fn();
const mockTruckRequestFindUnique = jest.fn();
const mockTruckRequestFindMany = jest.fn();
const mockTruckRequestUpdate = jest.fn();
const mockTruckHoldLedgerUpdate = jest.fn();
const mockTruckHoldLedgerFindFirst = jest.fn();
const mockTruckHoldLedgerFindUnique = jest.fn();
const mockExecuteRaw = jest.fn();

// F-A-75: mock $queryRaw so validateActorEligibility can read User row in TX.
const mockQueryRaw = jest.fn().mockResolvedValue([{ isActive: true, kycStatus: 'VERIFIED' }]);
const mockPrismaClient: any = {
  assignment: {
    update: (...args: any[]) => mockAssignmentUpdate(...args),
    updateMany: (...args: any[]) => mockAssignmentUpdateMany(...args),
    findUnique: (...args: any[]) => mockAssignmentFindUnique(...args),
    findUniqueOrThrow: (...args: any[]) => mockAssignmentFindUniqueOrThrow(...args),
    findMany: (...args: any[]) => mockAssignmentFindMany(...args),
    count: (...args: any[]) => mockAssignmentCount(...args),
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
  },
  $executeRaw: (...args: any[]) => mockExecuteRaw(...args),
  $queryRaw: (...args: any[]) => mockQueryRaw(...args),
  // Pass-through so TX body runs against the same mock surface.
  $transaction: (fn: any) => fn(mockPrismaClient),
};
jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: mockPrismaClient,
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
  mockAssignmentCount.mockReset();
  mockTruckRequestFindFirst.mockReset();
  mockTruckRequestFindUnique.mockReset();
  mockTruckRequestFindMany.mockReset();
  mockTruckRequestUpdate.mockReset();
  mockTruckHoldLedgerUpdate.mockReset();
  mockTruckHoldLedgerFindFirst.mockReset();
  mockTruckHoldLedgerFindUnique.mockReset();
  mockExecuteRaw.mockReset();
  mockEmitToUser.mockReset();
  mockReleaseVehicle.mockReset();
}

/** Build a standard assignment record. */
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
    status: 'driver_accepted',
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
    confirmedAt: now,
    confirmedExpiresAt: new Date(now.getTime() + 180_000),
    expiresAt: new Date(now.getTime() + 180_000),
    ...overrides,
  };
}

/** Build Redis Hash data as returned by hGetAll (all string values). */
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
 * Set up mocks for the full acceptance happy path (FIX #25 + #28 flow).
 * Returns the assignment object that mocks return.
 */
function setupAcceptanceHappyPath(assignmentOverrides: Record<string, any> = {}) {
  const assignment = buildAssignment(assignmentOverrides);
  const holdLedger = buildHoldLedger();

  // Lock
  mockRedisAcquireLock.mockResolvedValue({ acquired: true });
  mockRedisReleaseLock.mockResolvedValue(undefined);

  // C2 CAS: updateMany returns count=1, findUniqueOrThrow returns full record
  mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
  mockAssignmentFindUniqueOrThrow.mockResolvedValue(assignment);
  // Legacy: keep assignment.update for backward compatibility (not used by CAS code)
  mockAssignmentUpdate.mockResolvedValue(assignment);

  // FIX #25: assignment.findUnique to get truckRequestId
  mockAssignmentFindUnique.mockResolvedValue({
    truckRequestId: assignment.truckRequestId,
    orderId: assignment.orderId,
  });

  // FIX #25: truckRequest.findFirst using the correct truckRequestId
  mockTruckRequestFindFirst.mockResolvedValue({
    id: assignment.truckRequestId,
    orderId: assignment.orderId,
  });

  // Hold ledger lookup
  mockTruckHoldLedgerFindFirst.mockResolvedValue(holdLedger);

  // FIX #28: HINCRBY returns the new counter values
  mockRedisHIncrBy
    .mockResolvedValueOnce(1)   // trucksAccepted -> 1
    .mockResolvedValueOnce(2);  // trucksPending -> 2 (was 3, -1)

  // getConfirmedHoldState — called after HINCRBY for socket payload
  mockRedisHGetAll.mockResolvedValue(buildRedisHashState({
    trucksAccepted: '1',
    trucksPending: '2',
  }));

  // cacheConfirmedHoldState (if re-caching)
  mockRedisHMSet.mockResolvedValue(undefined);
  mockRedisExpire.mockResolvedValue(true);

  // Socket emit
  mockEmitToUser.mockResolvedValue(undefined);

  return { assignment, holdLedger };
}

// =============================================================================
// TEST 1: Driver accepts — FK traversal via Assignment.findUnique
// =============================================================================

describe('FIX #25 — FK traversal: Assignment queried first, TruckRequest found by correct ID', () => {
  beforeEach(resetAllMocks);

  it('queries Assignment.findUnique to get truckRequestId, then TruckRequest.findFirst by that ID', async () => {
    setupAcceptanceHappyPath();

    await confirmedHoldService.handleDriverAcceptance('assign-001', 'driver-001');

    // Step 1: assignment.findUnique called with the assignmentId
    expect(mockAssignmentFindUnique).toHaveBeenCalledTimes(1);
    expect(mockAssignmentFindUnique).toHaveBeenCalledWith({
      where: { id: 'assign-001' },
      select: { truckRequestId: true, orderId: true },
    });

    // Step 2: truckRequest.findFirst called with the ASSIGNMENT'S truckRequestId (not assignmentId)
    expect(mockTruckRequestFindFirst).toHaveBeenCalledTimes(1);
    expect(mockTruckRequestFindFirst).toHaveBeenCalledWith({
      where: { id: 'tr-001' },
      select: { id: true, orderId: true },
    });
  });

  it('uses truckRequestId from Assignment to find TruckRequest (NOT assignmentId)', async () => {
    const { assignment } = setupAcceptanceHappyPath({ truckRequestId: 'tr-custom-999' });

    // Override: findUnique returns custom truckRequestId
    mockAssignmentFindUnique.mockResolvedValue({
      truckRequestId: 'tr-custom-999',
      orderId: assignment.orderId,
    });
    mockTruckRequestFindFirst.mockResolvedValue({
      id: 'tr-custom-999',
      orderId: assignment.orderId,
    });

    await confirmedHoldService.handleDriverAcceptance('assign-001', 'driver-001');

    // Verify the truckRequest lookup used 'tr-custom-999', not 'assign-001'
    const trFindCall = mockTruckRequestFindFirst.mock.calls[0][0];
    expect(trFindCall.where.id).toBe('tr-custom-999');
    expect(trFindCall.where.id).not.toBe('assign-001');
  });
});

// =============================================================================
// TEST 2: Driver accepts with valid truckRequestId — holdRecord is NOT null
// =============================================================================

describe('FIX #25 — valid truckRequestId resolves holdRecord', () => {
  beforeEach(resetAllMocks);

  it('holdRecord is found when truckRequestId is valid, counter updates proceed', async () => {
    setupAcceptanceHappyPath();

    const result = await confirmedHoldService.handleDriverAcceptance('assign-001', 'driver-001');

    expect(result.success).toBe(true);
    expect(result.accepted).toBe(true);

    // holdLedger was found, so HINCRBY was called (FIX #28 path)
    expect(mockRedisHIncrBy).toHaveBeenCalledTimes(2);

    // Socket event was emitted with progress
    expect(mockEmitToUser).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// TEST 3: Driver accepts with null truckRequestId — falls back to orderId
// =============================================================================

describe('FIX #25 — null truckRequestId fallback to orderId', () => {
  beforeEach(resetAllMocks);

  it('when truckRequestId is null, holdRecord falls back to orderId from assignment', async () => {
    const assignment = buildAssignment({ truckRequestId: null });
    const holdLedger = buildHoldLedger();

    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    // C2 CAS mocks
    mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockAssignmentFindUniqueOrThrow.mockResolvedValue(assignment);
    mockAssignmentUpdate.mockResolvedValue(assignment);

    // FIX #25: findUnique returns null truckRequestId
    mockAssignmentFindUnique.mockResolvedValue({
      truckRequestId: null,
      orderId: 'order-001',
    });

    // truckRequest.findFirst should NOT be called when truckRequestId is null
    // holdRecord will be null, but resolvedOrderId falls back to assignmentRecord.orderId

    // Hold ledger lookup uses the orderId directly
    mockTruckHoldLedgerFindFirst.mockResolvedValue(holdLedger);

    // HINCRBY counters
    mockRedisHIncrBy
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    mockRedisHGetAll.mockResolvedValue(buildRedisHashState({
      trucksAccepted: '1',
      trucksPending: '2',
    }));
    mockRedisHMSet.mockResolvedValue(undefined);
    mockRedisExpire.mockResolvedValue(true);
    mockEmitToUser.mockResolvedValue(undefined);

    const result = await confirmedHoldService.handleDriverAcceptance('assign-001', 'driver-001');

    expect(result.success).toBe(true);
    expect(result.accepted).toBe(true);

    // truckRequest.findFirst should NOT have been called (truckRequestId was null)
    expect(mockTruckRequestFindFirst).not.toHaveBeenCalled();

    // But HINCRBY still ran because orderId fallback found the hold ledger
    expect(mockRedisHIncrBy).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// TEST 4: Driver accepts with both truckRequestId and orderId null — graceful
// =============================================================================

describe('FIX #25 — both truckRequestId and orderId null — no crash', () => {
  beforeEach(resetAllMocks);

  it('handles gracefully when assignment.findUnique returns null for both fields', async () => {
    const assignment = buildAssignment({ truckRequestId: null, orderId: null });

    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    // C2 CAS mocks
    mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockAssignmentFindUniqueOrThrow.mockResolvedValue(assignment);
    mockAssignmentUpdate.mockResolvedValue(assignment);

    // Both fields null
    mockAssignmentFindUnique.mockResolvedValue({
      truckRequestId: null,
      orderId: null,
    });

    const result = await confirmedHoldService.handleDriverAcceptance('assign-001', 'driver-001');

    // Should still succeed (acceptance recorded), just no counter update
    expect(result.success).toBe(true);
    expect(result.accepted).toBe(true);

    // No truckRequest lookup, no HINCRBY, no socket event
    expect(mockTruckRequestFindFirst).not.toHaveBeenCalled();
    expect(mockRedisHIncrBy).not.toHaveBeenCalled();
    expect(mockEmitToUser).not.toHaveBeenCalled();
  });

  it('handles gracefully when assignment.findUnique itself returns null', async () => {
    const assignment = buildAssignment();

    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    // C2 CAS mocks
    mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockAssignmentFindUniqueOrThrow.mockResolvedValue(assignment);
    mockAssignmentUpdate.mockResolvedValue(assignment);

    // findUnique returns null entirely (edge case)
    mockAssignmentFindUnique.mockResolvedValue(null);

    const result = await confirmedHoldService.handleDriverAcceptance('assign-001', 'driver-001');

    // Still succeeds — assignment status was updated
    expect(result.success).toBe(true);
    expect(result.accepted).toBe(true);

    // No downstream calls
    expect(mockTruckRequestFindFirst).not.toHaveBeenCalled();
    expect(mockRedisHIncrBy).not.toHaveBeenCalled();
  });
});

// =============================================================================
// TEST 5: trucksAccepted increments atomically via hIncrBy
// =============================================================================

describe('FIX #28 — trucksAccepted increments atomically', () => {
  beforeEach(resetAllMocks);

  it('calls hIncrBy with correct key and field for trucksAccepted', async () => {
    setupAcceptanceHappyPath();

    await confirmedHoldService.handleDriverAcceptance('assign-001', 'driver-001');

    // hIncrBy called for trucksAccepted with +1
    const acceptedCall = mockRedisHIncrBy.mock.calls.find(
      (call: any[]) => call[1] === 'trucksAccepted'
    );
    expect(acceptedCall).toBeDefined();
    expect(acceptedCall![0]).toBe('confirmed-hold:hold-001:state');
    expect(acceptedCall![1]).toBe('trucksAccepted');
    expect(acceptedCall![2]).toBe(1);
  });
});

// =============================================================================
// TEST 6: Two drivers accept simultaneously — both HINCRBY calls succeed
// =============================================================================

describe('FIX #28 — concurrent driver acceptances with atomic HINCRBY', () => {
  beforeEach(resetAllMocks);

  it('both drivers increment trucksAccepted atomically without lost updates', async () => {
    const holdLedger = buildHoldLedger();

    // Driver 1 setup
    const assignment1 = buildAssignment({ id: 'assign-001', driverId: 'driver-001' });
    // Driver 2 setup
    const assignment2 = buildAssignment({ id: 'assign-002', driverId: 'driver-002' });

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

    // Both assignments have valid truckRequestId
    mockAssignmentFindUnique
      .mockResolvedValueOnce({ truckRequestId: 'tr-001', orderId: 'order-001' })
      .mockResolvedValueOnce({ truckRequestId: 'tr-002', orderId: 'order-001' });

    mockTruckRequestFindFirst
      .mockResolvedValueOnce({ id: 'tr-001', orderId: 'order-001' })
      .mockResolvedValueOnce({ id: 'tr-002', orderId: 'order-001' });

    mockTruckHoldLedgerFindFirst.mockResolvedValue(holdLedger);

    // HINCRBY: Driver 1 gets accepted=1, pending=2; Driver 2 gets accepted=2, pending=1
    mockRedisHIncrBy
      .mockResolvedValueOnce(1)   // driver1 trucksAccepted
      .mockResolvedValueOnce(2)   // driver1 trucksPending
      .mockResolvedValueOnce(2)   // driver2 trucksAccepted
      .mockResolvedValueOnce(1);  // driver2 trucksPending

    mockRedisHGetAll
      .mockResolvedValueOnce(buildRedisHashState({ trucksAccepted: '1', trucksPending: '2' }))
      .mockResolvedValueOnce(buildRedisHashState({ trucksAccepted: '2', trucksPending: '1' }));

    mockRedisHMSet.mockResolvedValue(undefined);
    mockRedisExpire.mockResolvedValue(true);
    mockEmitToUser.mockResolvedValue(undefined);

    // Fire both acceptances concurrently
    const [result1, result2] = await Promise.all([
      confirmedHoldService.handleDriverAcceptance('assign-001', 'driver-001'),
      confirmedHoldService.handleDriverAcceptance('assign-002', 'driver-001'),
    ]);

    expect(result1.success).toBe(true);
    expect(result1.accepted).toBe(true);
    expect(result2.success).toBe(true);
    expect(result2.accepted).toBe(true);

    // Both calls used HINCRBY (atomic) — 2 calls per acceptance (accepted + pending)
    expect(mockRedisHIncrBy).toHaveBeenCalledTimes(4);

    // Both emitted socket events
    expect(mockEmitToUser).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// TEST 7: trucksPending decrements atomically via hIncrBy(-1)
// =============================================================================

describe('FIX #28 — trucksPending decrements atomically', () => {
  beforeEach(resetAllMocks);

  it('calls hIncrBy with -1 for trucksPending field', async () => {
    setupAcceptanceHappyPath();

    await confirmedHoldService.handleDriverAcceptance('assign-001', 'driver-001');

    // Find the hIncrBy call for trucksPending
    const pendingCall = mockRedisHIncrBy.mock.calls.find(
      (call: any[]) => call[1] === 'trucksPending'
    );
    expect(pendingCall).toBeDefined();
    expect(pendingCall![0]).toBe('confirmed-hold:hold-001:state');
    expect(pendingCall![1]).toBe('trucksPending');
    expect(pendingCall![2]).toBe(-1);
  });

  it('hIncrBy for trucksAccepted and trucksPending are called in parallel', async () => {
    setupAcceptanceHappyPath();

    await confirmedHoldService.handleDriverAcceptance('assign-001', 'driver-001');

    // Both hIncrBy calls should have been made (Promise.all in the implementation)
    expect(mockRedisHIncrBy).toHaveBeenCalledTimes(2);

    // Verify both fields were updated
    const fields = mockRedisHIncrBy.mock.calls.map((call: any[]) => call[1]);
    expect(fields).toContain('trucksAccepted');
    expect(fields).toContain('trucksPending');
  });
});

// =============================================================================
// TEST 8: Socket event emitted with correct progress (N/M trucks confirmed)
// =============================================================================

describe('FIX #28 — socket event emitted with correct progress', () => {
  beforeEach(resetAllMocks);

  it('emits driver_accepted event with N/M trucks confirmed to transporter', async () => {
    setupAcceptanceHappyPath();

    await confirmedHoldService.handleDriverAcceptance('assign-001', 'driver-001');

    expect(mockEmitToUser).toHaveBeenCalledTimes(1);
    const [userId, event, payload] = mockEmitToUser.mock.calls[0];

    expect(userId).toBe('transporter-001');
    expect(event).toBe('driver_accepted');
    expect(payload.holdId).toBe('hold-001');
    expect(payload.assignmentId).toBe('assign-001');
    expect(payload.driverId).toBe('driver-001');
    expect(payload.trucksAccepted).toBe(1);
    expect(payload.trucksPending).toBe(2);
    expect(payload.message).toContain('1/');
    expect(payload.message).toContain('confirmed');
  });

  it('progress message reflects hIncrBy return values accurately', async () => {
    const holdLedger = buildHoldLedger();
    const assignment = buildAssignment();

    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    // C2 CAS mocks
    mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockAssignmentFindUniqueOrThrow.mockResolvedValue(assignment);
    mockAssignmentUpdate.mockResolvedValue(assignment);
    mockAssignmentFindUnique.mockResolvedValue({
      truckRequestId: 'tr-001',
      orderId: 'order-001',
    });
    mockTruckRequestFindFirst.mockResolvedValue({
      id: 'tr-001',
      orderId: 'order-001',
    });
    mockTruckHoldLedgerFindFirst.mockResolvedValue(holdLedger);

    // Simulate second driver accepting (accepted=2, pending=1)
    mockRedisHIncrBy
      .mockResolvedValueOnce(2)  // trucksAccepted
      .mockResolvedValueOnce(1); // trucksPending

    mockRedisHGetAll.mockResolvedValue(buildRedisHashState({
      trucksAccepted: '2',
      trucksPending: '1',
      trucksCount: '3',
    }));
    mockRedisHMSet.mockResolvedValue(undefined);
    mockRedisExpire.mockResolvedValue(true);
    mockEmitToUser.mockResolvedValue(undefined);

    await confirmedHoldService.handleDriverAcceptance('assign-001', 'driver-001');

    const [, , payload] = mockEmitToUser.mock.calls[0];
    expect(payload.trucksAccepted).toBe(2);
    expect(payload.message).toContain('2/');
    expect(payload.message).toContain('confirmed');
  });
});

// =============================================================================
// TEST 9: getConfirmedHoldState reads from Redis Hash (HGETALL)
// =============================================================================

describe('FIX #28 — getConfirmedHoldState reads from Redis Hash', () => {
  beforeEach(resetAllMocks);

  it('returns typed state from hGetAll when Redis Hash has data', async () => {
    const hashData = buildRedisHashState({
      trucksAccepted: '2',
      trucksPending: '1',
      trucksDeclined: '0',
      trucksCount: '3',
    });
    mockRedisHGetAll.mockResolvedValue(hashData);

    // Access via handleDriverAcceptance which internally calls getConfirmedHoldState
    // OR test indirectly — since getConfirmedHoldState is called after HINCRBY
    // We can test the checkExpiry method which delegates to getConfirmedHoldState
    const result = await confirmedHoldService.checkExpiry('hold-001');

    expect(mockRedisHGetAll).toHaveBeenCalledWith('confirmed-hold:hold-001:state');
    expect(result.expired).toBe(false);
    expect(result.state).toBeDefined();
    expect(result.state!.holdId).toBe('hold-001');
    expect(result.state!.trucksAccepted).toBe(2);
    expect(result.state!.trucksPending).toBe(1);
    expect(result.state!.trucksCount).toBe(3);
    expect(result.state!.phase).toBe('CONFIRMED');
  });

  it('parses numeric fields from string Hash values correctly', async () => {
    const hashData = buildRedisHashState({
      trucksAccepted: '5',
      trucksPending: '10',
      trucksDeclined: '2',
      trucksCount: '17',
      remainingSeconds: '45',
    });
    mockRedisHGetAll.mockResolvedValue(hashData);

    const result = await confirmedHoldService.checkExpiry('hold-001');

    expect(result.state).toBeDefined();
    // All numeric fields parsed from strings
    expect(typeof result.state!.trucksAccepted).toBe('number');
    expect(typeof result.state!.trucksPending).toBe('number');
    expect(typeof result.state!.trucksDeclined).toBe('number');
    expect(typeof result.state!.trucksCount).toBe('number');
    expect(result.state!.trucksAccepted).toBe(5);
    expect(result.state!.trucksPending).toBe(10);
    expect(result.state!.trucksDeclined).toBe(2);
    expect(result.state!.trucksCount).toBe(17);
  });

  it('parses date fields from ISO strings correctly', async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000);
    const hashData = buildRedisHashState({
      confirmedAt: now.toISOString(),
      confirmedExpiresAt: expiresAt.toISOString(),
    });
    mockRedisHGetAll.mockResolvedValue(hashData);

    const result = await confirmedHoldService.checkExpiry('hold-001');

    expect(result.state).toBeDefined();
    expect(result.state!.confirmedAt).toBeInstanceOf(Date);
    expect(result.state!.confirmedExpiresAt).toBeInstanceOf(Date);
  });
});

// =============================================================================
// TEST 10: getConfirmedHoldState DB fallback — when Redis empty
// =============================================================================

describe('FIX #28 — getConfirmedHoldState DB fallback when Redis empty', () => {
  beforeEach(resetAllMocks);

  it('falls back to DB when hGetAll returns empty object', async () => {
    // Redis returns empty hash
    mockRedisHGetAll.mockResolvedValue({});

    // DB fallback: holdLedger found
    const holdLedger = buildHoldLedger();
    mockTruckHoldLedgerFindUnique.mockResolvedValue(holdLedger);

    // TruckRequests for reconstructing state
    mockTruckRequestFindMany.mockResolvedValue([
      { id: 'tr-001', status: 'accepted', orderId: 'order-001' },
      { id: 'tr-002', status: 'assigned', orderId: 'order-001' },
      { id: 'tr-003', status: 'in_progress', orderId: 'order-001' },
    ]);

    // L3 fix: assignment.count for declined drivers
    mockAssignmentCount.mockResolvedValue(0);

    // cacheConfirmedHoldState will re-cache
    mockRedisHMSet.mockResolvedValue(undefined);
    mockRedisExpire.mockResolvedValue(true);

    const result = await confirmedHoldService.checkExpiry('hold-001');

    // Verify DB was queried
    expect(mockTruckHoldLedgerFindUnique).toHaveBeenCalledWith({
      where: { holdId: 'hold-001' },
    });
    expect(mockTruckRequestFindMany).toHaveBeenCalledTimes(1);

    expect(result.expired).toBe(false);
    expect(result.state).toBeDefined();
    expect(result.state!.holdId).toBe('hold-001');
    // accepted + in_progress = 2
    expect(result.state!.trucksAccepted).toBe(2);
    // assigned = 1
    expect(result.state!.trucksPending).toBe(1);
  });

  it('falls back to DB when hGetAll returns null-like data (no holdId)', async () => {
    // Redis returns a hash but without holdId (corrupt data)
    mockRedisHGetAll.mockResolvedValue({ someGarbage: 'value' });

    const holdLedger = buildHoldLedger();
    mockTruckHoldLedgerFindUnique.mockResolvedValue(holdLedger);
    mockTruckRequestFindMany.mockResolvedValue([]);
    // L3 fix: assignment.count for declined drivers
    mockAssignmentCount.mockResolvedValue(0);
    mockRedisHMSet.mockResolvedValue(undefined);
    mockRedisExpire.mockResolvedValue(true);

    const result = await confirmedHoldService.checkExpiry('hold-001');

    // Falls back to DB because hashData.holdId is falsy
    expect(mockTruckHoldLedgerFindUnique).toHaveBeenCalledTimes(1);
    expect(result.state).toBeDefined();
  });

  it('returns null when both Redis and DB have no data', async () => {
    mockRedisHGetAll.mockResolvedValue({});
    mockTruckHoldLedgerFindUnique.mockResolvedValue(null);

    const result = await confirmedHoldService.checkExpiry('hold-001');

    expect(result.expired).toBe(true);
    expect(result.state).toBeUndefined();
  });

  it('returns null when holdLedger exists but phase is not CONFIRMED', async () => {
    mockRedisHGetAll.mockResolvedValue({});
    mockTruckHoldLedgerFindUnique.mockResolvedValue(
      buildHoldLedger({ phase: 'FLEX' })
    );

    const result = await confirmedHoldService.checkExpiry('hold-001');

    expect(result.expired).toBe(true);
    expect(result.state).toBeUndefined();
  });

  it('re-caches state to Redis Hash after DB fallback', async () => {
    mockRedisHGetAll.mockResolvedValue({});
    mockTruckHoldLedgerFindUnique.mockResolvedValue(buildHoldLedger());
    mockTruckRequestFindMany.mockResolvedValue([
      { id: 'tr-001', status: 'accepted', orderId: 'order-001' },
    ]);
    // L3 fix: assignment.count for declined drivers
    mockAssignmentCount.mockResolvedValue(0);
    mockRedisHMSet.mockResolvedValue(undefined);
    mockRedisExpire.mockResolvedValue(true);

    await confirmedHoldService.checkExpiry('hold-001');

    // Verify hMSet was called to re-cache
    expect(mockRedisHMSet).toHaveBeenCalledTimes(1);
    expect(mockRedisExpire).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// TEST 11: cacheConfirmedHoldState writes Hash via hMSet
// =============================================================================

describe('FIX #28 — cacheConfirmedHoldState writes Redis Hash', () => {
  beforeEach(resetAllMocks);

  it('hMSet called with all fields serialized as strings during DB fallback', async () => {
    mockRedisHGetAll.mockResolvedValue({});
    const holdLedger = buildHoldLedger({ quantity: 5 });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(holdLedger);
    mockTruckRequestFindMany.mockResolvedValue([
      { id: 'tr-001', status: 'accepted', orderId: 'order-001' },
      { id: 'tr-002', status: 'assigned', orderId: 'order-001' },
      { id: 'tr-003', status: 'in_progress', orderId: 'order-001' },
    ]);
    // L3 fix: assignment.count for declined drivers
    mockAssignmentCount.mockResolvedValue(0);
    mockRedisHMSet.mockResolvedValue(undefined);
    mockRedisExpire.mockResolvedValue(true);

    await confirmedHoldService.checkExpiry('hold-001');

    expect(mockRedisHMSet).toHaveBeenCalledTimes(1);
    const [key, hashFields] = mockRedisHMSet.mock.calls[0];

    // Key format
    expect(key).toBe('confirmed-hold:hold-001:state');

    // All fields present as strings
    expect(hashFields.holdId).toBe('hold-001');
    expect(hashFields.orderId).toBe('order-001');
    expect(hashFields.transporterId).toBe('transporter-001');
    expect(hashFields.phase).toBe('CONFIRMED');
    expect(typeof hashFields.confirmedAt).toBe('string');
    expect(typeof hashFields.confirmedExpiresAt).toBe('string');
    expect(typeof hashFields.remainingSeconds).toBe('string');
    expect(hashFields.trucksCount).toBe('5');
    // accepted + in_progress = 2
    expect(hashFields.trucksAccepted).toBe('2');
    expect(hashFields.trucksDeclined).toBe('0');
    // assigned = 1
    expect(hashFields.trucksPending).toBe('1');
  });

  it('expire called with TTL = remainingSeconds + 10', async () => {
    mockRedisHGetAll.mockResolvedValue({});
    const holdLedger = buildHoldLedger();
    mockTruckHoldLedgerFindUnique.mockResolvedValue(holdLedger);
    mockTruckRequestFindMany.mockResolvedValue([]);
    // L3 fix: assignment.count for declined drivers
    mockAssignmentCount.mockResolvedValue(0);
    mockRedisHMSet.mockResolvedValue(undefined);
    mockRedisExpire.mockResolvedValue(true);

    await confirmedHoldService.checkExpiry('hold-001');

    expect(mockRedisExpire).toHaveBeenCalledTimes(1);
    const [key, ttl] = mockRedisExpire.mock.calls[0];
    expect(key).toBe('confirmed-hold:hold-001:state');
    // TTL should be remainingSeconds + 10, and remainingSeconds >= 1
    expect(ttl).toBeGreaterThanOrEqual(11);
  });

  it('date fields are serialized as ISO strings in the Hash', async () => {
    mockRedisHGetAll.mockResolvedValue({});
    const now = new Date();
    const holdLedger = buildHoldLedger({ confirmedAt: now });
    mockTruckHoldLedgerFindUnique.mockResolvedValue(holdLedger);
    mockTruckRequestFindMany.mockResolvedValue([]);
    // L3 fix: assignment.count for declined drivers
    mockAssignmentCount.mockResolvedValue(0);
    mockRedisHMSet.mockResolvedValue(undefined);
    mockRedisExpire.mockResolvedValue(true);

    await confirmedHoldService.checkExpiry('hold-001');

    const [, hashFields] = mockRedisHMSet.mock.calls[0];
    // confirmedAt should be ISO string
    expect(hashFields.confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(hashFields.confirmedExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
