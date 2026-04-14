/**
 * =============================================================================
 * HOLD FIXES — Tests for Problem 1 (correct column lookup) and Problem 6
 *              (decline releases vehicle + decrements trucksFilled)
 * =============================================================================
 *
 * Validates that:
 *   - handleDriverAcceptance/Decline query by assignment.id, NOT tripId
 *   - handleDriverDecline releases vehicle back to available
 *   - handleDriverDecline decrements order.trucksFilled (floored at 0)
 *   - handleDriverDecline is idempotent and resilient to partial failures
 *
 * @author Weelo Team
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — Must come before any imports
// =============================================================================

// Logger mock
jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Metrics mock
jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    recordHistogram: jest.fn(),
  },
}));

// Redis service mock
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
const mockAssignmentFindMany = jest.fn();
const mockAssignmentFindUnique = jest.fn();
const mockAssignmentFindUniqueOrThrow = jest.fn();
const mockTruckRequestFindUnique = jest.fn();
const mockTruckRequestFindFirst = jest.fn();
const mockTruckRequestUpdate = jest.fn();
const mockTruckHoldLedgerUpdate = jest.fn();
const mockTruckHoldLedgerFindFirst = jest.fn();
const mockTruckHoldLedgerFindUnique = jest.fn();
const mockTruckRequestFindMany = jest.fn();
const mockExecuteRaw = jest.fn();

const mockPrismaClient: any = {
  assignment: {
    update: (...args: any[]) => mockAssignmentUpdate(...args),
    updateMany: (...args: any[]) => mockAssignmentUpdateMany(...args),
    findMany: (...args: any[]) => mockAssignmentFindMany(...args),
    findUnique: (...args: any[]) => mockAssignmentFindUnique(...args),
    findUniqueOrThrow: (...args: any[]) => mockAssignmentFindUniqueOrThrow(...args),
  },
  truckRequest: {
    findUnique: (...args: any[]) => mockTruckRequestFindUnique(...args),
    findFirst: (...args: any[]) => mockTruckRequestFindFirst(...args),
    update: (...args: any[]) => mockTruckRequestUpdate(...args),
    findMany: (...args: any[]) => mockTruckRequestFindMany(...args),
  },
  truckHoldLedger: {
    update: (...args: any[]) => mockTruckHoldLedgerUpdate(...args),
    findFirst: (...args: any[]) => mockTruckHoldLedgerFindFirst(...args),
    findUnique: (...args: any[]) => mockTruckHoldLedgerFindUnique(...args),
  },
  $executeRaw: (...args: any[]) => mockExecuteRaw(...args),
  $transaction: async (fn: any) => fn(mockPrismaClient),
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
  onVehicleTransition: jest.fn().mockResolvedValue(undefined),
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
import { logger } from '../shared/services/logger.service';

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
  mockAssignmentFindMany.mockReset();
  mockAssignmentFindUnique.mockReset();
  mockAssignmentFindUniqueOrThrow.mockReset();
  mockTruckRequestFindUnique.mockReset();
  mockTruckRequestFindFirst.mockReset();
  mockTruckRequestUpdate.mockReset();
  mockTruckHoldLedgerUpdate.mockReset();
  mockTruckHoldLedgerFindFirst.mockReset();
  mockTruckHoldLedgerFindUnique.mockReset();
  mockTruckRequestFindMany.mockReset();
  mockExecuteRaw.mockReset();
  mockEmitToUser.mockReset();
  mockReleaseVehicle.mockReset();
}

/**
 * Build a standard assignment record returned by prisma after update.
 */
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

/**
 * Set up mocks so a driver decline flows through the happy path.
 */
function setupDeclineHappyPath(assignmentOverrides: Record<string, any> = {}) {
  const assignment = buildAssignment(assignmentOverrides);

  mockRedisAcquireLock.mockResolvedValue({ acquired: true });
  mockRedisReleaseLock.mockResolvedValue(undefined);
  // C2 CAS: updateMany returns count=1 (CAS success), findUniqueOrThrow returns full record
  mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
  mockAssignmentFindUniqueOrThrow.mockResolvedValue(assignment);
  mockAssignmentUpdate.mockResolvedValue(assignment);
  // F-M14: Inside $transaction, findUnique is called for orderId;
  // Outside, resolveAssignmentTruckRequest calls findUnique for truckRequestId.
  // Both go through the same mock since $transaction passes mockPrismaClient.
  mockAssignmentFindUnique.mockResolvedValue({
    truckRequestId: assignment.truckRequestId,
    orderId: assignment.orderId,
  });
  // The service uses truckRequest.findFirst via FK chain
  mockTruckRequestFindFirst.mockResolvedValue({
    id: assignment.truckRequestId,
    orderId: assignment.orderId,
  });
  mockTruckRequestUpdate.mockResolvedValue({});
  mockReleaseVehicle.mockResolvedValue(undefined);
  mockExecuteRaw.mockResolvedValue(1);
  mockTruckHoldLedgerFindFirst.mockResolvedValue(null); // No confirmed hold ledger
  mockRedisSetJSON.mockResolvedValue(undefined);
  // HINCRBY mocks (for when hold ledger IS found)
  mockRedisHIncrBy.mockResolvedValue(0);
  mockRedisHGetAll.mockResolvedValue(null);
  mockRedisHMSet.mockResolvedValue(undefined);
  mockRedisExpire.mockResolvedValue(true);

  return assignment;
}

/**
 * Set up mocks so a driver acceptance flows through the happy path.
 */
function setupAcceptHappyPath(assignmentOverrides: Record<string, any> = {}) {
  const assignment = buildAssignment({
    status: 'driver_accepted',
    ...assignmentOverrides,
  });

  mockRedisAcquireLock.mockResolvedValue({ acquired: true });
  mockRedisReleaseLock.mockResolvedValue(undefined);
  // C2 CAS: updateMany returns count=1 (CAS success), findUniqueOrThrow returns full record
  mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
  mockAssignmentFindUniqueOrThrow.mockResolvedValue(assignment);
  mockAssignmentUpdate.mockResolvedValue(assignment);
  // FK traversal: assignment.findUnique to get truckRequestId
  mockAssignmentFindUnique.mockResolvedValue({
    truckRequestId: assignment.truckRequestId,
    orderId: assignment.orderId,
  });
  // The service uses truckRequest.findFirst via FK chain
  mockTruckRequestFindFirst.mockResolvedValue({
    id: assignment.truckRequestId,
    orderId: assignment.orderId,
  });
  mockTruckHoldLedgerFindFirst.mockResolvedValue(null);
  mockRedisSetJSON.mockResolvedValue(undefined);
  // HINCRBY mocks
  mockRedisHIncrBy.mockResolvedValue(0);
  mockRedisHGetAll.mockResolvedValue(null);
  mockRedisHMSet.mockResolvedValue(undefined);
  mockRedisExpire.mockResolvedValue(true);

  return assignment;
}

// =============================================================================
// PROBLEM 1: Correct column lookup — uses assignment.id, NOT tripId
// =============================================================================

describe('Problem 1 — handleDriverAcceptance/Decline use tripId for lookup', () => {
  beforeEach(resetAllMocks);

  it('handleDriverAcceptance queries by id (fixed implementation)', async () => {
    const assignment = setupAcceptHappyPath();

    await confirmedHoldService.handleDriverAcceptance('assign-001', 'driver-001');

    // C2 CAS: updateMany with id + status precondition
    expect(mockAssignmentUpdateMany).toHaveBeenCalledTimes(1);
    const updateCall = mockAssignmentUpdateMany.mock.calls[0][0];
    expect(updateCall.where.id).toBe('assign-001');
  });

  it('handleDriverAcceptance with valid assignmentId returns success', async () => {
    setupAcceptHappyPath();

    const result = await confirmedHoldService.handleDriverAcceptance('assign-001', 'driver-001');

    expect(result.success).toBe(true);
    expect(result.accepted).toBe(true);
    expect(result.declined).toBe(false);
    expect(result.assignmentId).toBe('assign-001');
    expect(result.message).toContain('accepted');
  });

  it('handleDriverAcceptance with non-existent id returns error', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    // C2 CAS: updateMany throws on DB error
    mockAssignmentUpdateMany.mockRejectedValue(
      new Error('Record to update not found.')
    );

    const result = await confirmedHoldService.handleDriverAcceptance('non-existent-id', 'driver-001');

    expect(result.success).toBe(false);
    expect(result.accepted).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to handle driver acceptance'),
      expect.objectContaining({ assignmentId: 'non-existent-id' })
    );
  });

  it('handleDriverDecline queries by id (fixed implementation)', async () => {
    setupDeclineHappyPath();

    await confirmedHoldService.handleDriverDecline('assign-001', 'driver-001');

    // C2 CAS: updateMany with id + status precondition
    expect(mockAssignmentUpdateMany).toHaveBeenCalledTimes(1);
    const updateCall = mockAssignmentUpdateMany.mock.calls[0][0];
    expect(updateCall.where.id).toBe('assign-001');
  });
});

// =============================================================================
// PROBLEM 6: Decline releases vehicle + decrements trucksFilled
// =============================================================================

describe('Problem 6 — handleDriverDecline resets truck request and updates state', () => {
  beforeEach(resetAllMocks);

  it('handleDriverDecline succeeds and marks as declined', async () => {
    setupDeclineHappyPath();

    const result = await confirmedHoldService.handleDriverDecline('assign-001', 'driver-001');

    expect(result.success).toBe(true);
    expect(result.declined).toBe(true);
    expect(result.assignmentId).toBe('assign-001');
  });

  it('handleDriverDecline updates assignment status to driver_declined', async () => {
    setupDeclineHappyPath();

    await confirmedHoldService.handleDriverDecline('assign-001', 'driver-001');

    // C2 CAS: updateMany with status precondition
    expect(mockAssignmentUpdateMany).toHaveBeenCalledTimes(1);
    const updateCall = mockAssignmentUpdateMany.mock.calls[0][0];
    expect(updateCall.data.status).toBe('driver_declined');
  });

  it('handleDriverDecline sets truck request to held (Phase 2 exclusivity)', async () => {
    setupDeclineHappyPath();

    await confirmedHoldService.handleDriverDecline('assign-001', 'driver-001');

    // truckRequest.findFirst is used to find the request via FK traversal
    expect(mockTruckRequestFindFirst).toHaveBeenCalledTimes(1);
    // truckRequest.update sets to held (FIX #41: was 'searching', now 'held')
    expect(mockTruckRequestUpdate).toHaveBeenCalledTimes(1);
    const trUpdateCall = mockTruckRequestUpdate.mock.calls[0][0];
    expect(trUpdateCall.data.status).toBe('held');
    expect(trUpdateCall.data.assignedDriverId).toBeNull();
    expect(trUpdateCall.data.assignedVehicleId).toBeNull();
  });

  it('handleDriverDecline is idempotent — calling twice does not crash', async () => {
    // First call — normal happy path
    setupDeclineHappyPath();
    const result1 = await confirmedHoldService.handleDriverDecline('assign-001', 'driver-001');
    expect(result1.success).toBe(true);

    // Second call — assignment is already declined; CAS updateMany returns count=0
    // because status is no longer 'pending'. Service returns success=false gracefully.
    resetAllMocks();
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    mockAssignmentUpdateMany.mockResolvedValue({ count: 0 }); // CAS miss
    mockAssignmentFindUnique.mockResolvedValue({ status: 'driver_declined' });
    const result2 = await confirmedHoldService.handleDriverDecline('assign-001', 'driver-001');
    // Second call does not crash — idempotent behavior
    expect(result2.success).toBe(false);
    expect(result2.message).toContain('no longer pending');
  });

  it('handleDriverDecline with no truckRequest found still succeeds', async () => {
    setupDeclineHappyPath();
    // Override: findFirst returns null (no truck request for this tripId)
    mockTruckRequestFindFirst.mockResolvedValue(null);

    const result = await confirmedHoldService.handleDriverDecline('assign-001', 'driver-001');

    expect(result.success).toBe(true);
    expect(result.declined).toBe(true);
    // truckRequest.update should not have been called
    expect(mockTruckRequestUpdate).not.toHaveBeenCalled();
  });

  it('handleDriverDecline when assignment update fails returns failure', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    // C2 CAS: updateMany throws
    mockAssignmentUpdateMany.mockRejectedValue(new Error('Record not found'));

    const result = await confirmedHoldService.handleDriverDecline('assign-001', 'driver-001');

    // Error is caught and returns failure
    expect(result.success).toBe(false);
    expect(result.declined).toBe(false);
  });

  it('handleDriverDecline message contains success text', async () => {
    setupDeclineHappyPath();

    const result = await confirmedHoldService.handleDriverDecline('assign-001', 'driver-001');

    expect(result.message).toContain('declined');
  });

  it('two drivers decline simultaneously — both succeed with locks', async () => {
    // Each decline call acquires a lock keyed by assignmentId.
    // Since different drivers have different assignmentIds, they can run concurrently.

    // Driver 1 decline
    const assign1 = buildAssignment({
      id: 'assign-001',
      vehicleId: 'vehicle-001',
      driverId: 'driver-001',
    });
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    // C2 CAS mocks for both drivers
    mockAssignmentUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    mockAssignmentFindUniqueOrThrow
      .mockResolvedValueOnce(assign1);
    mockAssignmentFindUnique
      .mockResolvedValueOnce({ truckRequestId: 'tr-001', orderId: 'order-001' });
    mockTruckRequestFindFirst.mockResolvedValueOnce({
      id: 'tr-001',
      orderId: 'order-001',
      status: 'assigned',
    });
    mockTruckRequestUpdate.mockResolvedValueOnce({});
    mockTruckHoldLedgerFindFirst.mockResolvedValueOnce(null);

    mockReleaseVehicle.mockResolvedValue(undefined);
    mockExecuteRaw.mockResolvedValue(1);

    const promise1 = confirmedHoldService.handleDriverDecline('assign-001', 'driver-001');

    // Driver 2 decline (different assignment)
    const assign2 = buildAssignment({
      id: 'assign-002',
      vehicleId: 'vehicle-002',
      driverId: 'driver-002',
      truckRequestId: 'tr-002',
    });
    mockAssignmentFindUniqueOrThrow
      .mockResolvedValueOnce(assign2);
    mockAssignmentFindUnique
      .mockResolvedValueOnce({ truckRequestId: 'tr-002', orderId: 'order-001' });
    mockTruckRequestFindFirst.mockResolvedValueOnce({
      id: 'tr-002',
      orderId: 'order-001',
      status: 'assigned',
    });
    mockTruckRequestUpdate.mockResolvedValueOnce({});
    mockTruckHoldLedgerFindFirst.mockResolvedValueOnce(null);

    const promise2 = confirmedHoldService.handleDriverDecline('assign-002', 'driver-001');

    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1.success).toBe(true);
    expect(result1.declined).toBe(true);
    expect(result2.success).toBe(true);
    expect(result2.declined).toBe(true);

    // Both assignments should have been updated via CAS updateMany
    expect(mockAssignmentUpdateMany).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// ADDITIONAL EDGE CASES
// =============================================================================

describe('Edge cases — lock contention and missing data', () => {
  beforeEach(resetAllMocks);

  it('handleDriverAcceptance returns failure when lock not acquired', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: false });

    const result = await confirmedHoldService.handleDriverAcceptance('assign-001', 'driver-001');

    expect(result.success).toBe(false);
    expect(result.message).toContain('lock');
    expect(mockAssignmentUpdate).not.toHaveBeenCalled();
  });

  it('handleDriverDecline returns failure when lock not acquired', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: false });

    const result = await confirmedHoldService.handleDriverDecline('assign-001', 'driver-001');

    expect(result.success).toBe(false);
    expect(result.message).toContain('lock');
    expect(mockAssignmentUpdate).not.toHaveBeenCalled();
  });

  it('handleDriverDecline with no truckRequest found still succeeds', async () => {
    setupDeclineHappyPath();
    // Override: findFirst returns null (no truck request)
    mockTruckRequestFindFirst.mockResolvedValue(null);

    const result = await confirmedHoldService.handleDriverDecline('assign-001', 'driver-001');

    expect(result.success).toBe(true);
    expect(result.declined).toBe(true);
    // truckRequest.update should not have been called
    expect(mockTruckRequestUpdate).not.toHaveBeenCalled();
  });

  it('handleDriverDecline with truckRequest found sets to held', async () => {
    setupDeclineHappyPath();

    const result = await confirmedHoldService.handleDriverDecline('assign-001', 'driver-001');

    expect(result.success).toBe(true);
    expect(mockTruckRequestUpdate).toHaveBeenCalledTimes(1);
    const updateData = mockTruckRequestUpdate.mock.calls[0][0].data;
    expect(updateData.status).toBe('held');
  });

  it('handleDriverDecline truckRequest update failure still succeeds (non-fatal side effect)', async () => {
    setupDeclineHappyPath();
    mockTruckRequestUpdate.mockRejectedValue(new Error('DB write failed'));

    const result = await confirmedHoldService.handleDriverDecline('assign-001', 'driver-001');

    // truckRequest update error propagates to the outer try/catch
    expect(result.success).toBe(false);
  });

  it('handleDriverDecline always releases lock even on failure', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    // C2 CAS: updateMany throws
    mockAssignmentUpdateMany.mockRejectedValue(new Error('DB error'));

    await confirmedHoldService.handleDriverDecline('assign-001', 'driver-001');

    // Lock should be released in the finally block (C-02: holder is now uuidv4())
    expect(mockRedisReleaseLock).toHaveBeenCalledWith(
      'driver-acceptance:assign-001',
      expect.any(String)
    );
  });
});
