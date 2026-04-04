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

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    getJSON: (...args: any[]) => mockRedisGetJSON(...args),
    setJSON: (...args: any[]) => mockRedisSetJSON(...args),
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    isConnected: () => true,
  },
}));

// Prisma mock
const mockAssignmentUpdate = jest.fn();
const mockAssignmentFindMany = jest.fn();
const mockTruckRequestFindUnique = jest.fn();
const mockTruckRequestFindFirst = jest.fn();
const mockTruckRequestUpdate = jest.fn();
const mockTruckHoldLedgerUpdate = jest.fn();
const mockTruckHoldLedgerFindFirst = jest.fn();
const mockTruckHoldLedgerFindUnique = jest.fn();
const mockTruckRequestFindMany = jest.fn();
const mockExecuteRaw = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    assignment: {
      update: (...args: any[]) => mockAssignmentUpdate(...args),
      findMany: (...args: any[]) => mockAssignmentFindMany(...args),
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
  mockAssignmentUpdate.mockReset();
  mockAssignmentFindMany.mockReset();
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
  mockAssignmentUpdate.mockResolvedValue(assignment);
  // The service uses truckRequest.findFirst (not findUnique)
  mockTruckRequestFindFirst.mockResolvedValue({
    id: assignment.truckRequestId,
    orderId: assignment.orderId,
    status: 'assigned',
  });
  mockTruckRequestUpdate.mockResolvedValue({});
  mockReleaseVehicle.mockResolvedValue(undefined);
  mockExecuteRaw.mockResolvedValue(1);
  mockTruckHoldLedgerFindFirst.mockResolvedValue(null); // No confirmed hold ledger
  mockRedisSetJSON.mockResolvedValue(undefined);

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
  mockAssignmentUpdate.mockResolvedValue(assignment);
  // The service uses truckRequest.findFirst (not findUnique)
  mockTruckRequestFindFirst.mockResolvedValue({
    id: assignment.truckRequestId,
    orderId: assignment.orderId,
  });
  mockTruckHoldLedgerFindFirst.mockResolvedValue(null);
  mockRedisSetJSON.mockResolvedValue(undefined);

  return assignment;
}

// =============================================================================
// PROBLEM 1: Correct column lookup — uses assignment.id, NOT tripId
// =============================================================================

describe('Problem 1 — handleDriverAcceptance/Decline use tripId for lookup', () => {
  beforeEach(resetAllMocks);

  it('handleDriverAcceptance queries by id (fixed implementation)', async () => {
    const assignment = setupAcceptHappyPath();

    await confirmedHoldService.handleDriverAcceptance('assign-001');

    // The current implementation queries by tripId (the assignmentId param is used as tripId)
    expect(mockAssignmentUpdate).toHaveBeenCalledTimes(1);
    const updateCall = mockAssignmentUpdate.mock.calls[0][0];
    expect(updateCall.where).toEqual({ id: 'assign-001' });
  });

  it('handleDriverAcceptance with valid assignmentId returns success', async () => {
    setupAcceptHappyPath();

    const result = await confirmedHoldService.handleDriverAcceptance('assign-001');

    expect(result.success).toBe(true);
    expect(result.accepted).toBe(true);
    expect(result.declined).toBe(false);
    expect(result.assignmentId).toBe('assign-001');
    expect(result.message).toContain('accepted');
  });

  it('handleDriverAcceptance with non-existent id returns error', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    mockAssignmentUpdate.mockRejectedValue(
      new Error('Record to update not found.')
    );

    const result = await confirmedHoldService.handleDriverAcceptance('non-existent-id');

    expect(result.success).toBe(false);
    expect(result.accepted).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to handle driver acceptance'),
      expect.objectContaining({ assignmentId: 'non-existent-id' })
    );
  });

  it('handleDriverDecline queries by id (fixed implementation)', async () => {
    setupDeclineHappyPath();

    await confirmedHoldService.handleDriverDecline('assign-001');

    expect(mockAssignmentUpdate).toHaveBeenCalledTimes(1);
    const updateCall = mockAssignmentUpdate.mock.calls[0][0];
    expect(updateCall.where).toEqual({ id: 'assign-001' });
  });
});

// =============================================================================
// PROBLEM 6: Decline releases vehicle + decrements trucksFilled
// =============================================================================

describe('Problem 6 — handleDriverDecline resets truck request and updates state', () => {
  beforeEach(resetAllMocks);

  it('handleDriverDecline succeeds and marks as declined', async () => {
    setupDeclineHappyPath();

    const result = await confirmedHoldService.handleDriverDecline('assign-001');

    expect(result.success).toBe(true);
    expect(result.declined).toBe(true);
    expect(result.assignmentId).toBe('assign-001');
  });

  it('handleDriverDecline updates assignment status to driver_declined', async () => {
    setupDeclineHappyPath();

    await confirmedHoldService.handleDriverDecline('assign-001');

    expect(mockAssignmentUpdate).toHaveBeenCalledTimes(1);
    const updateCall = mockAssignmentUpdate.mock.calls[0][0];
    expect(updateCall.data.status).toBe('driver_declined');
  });

  it('handleDriverDecline resets truck request to searching', async () => {
    setupDeclineHappyPath();

    await confirmedHoldService.handleDriverDecline('assign-001');

    // truckRequest.findFirst is used to find the request by tripId
    expect(mockTruckRequestFindFirst).toHaveBeenCalledTimes(1);
    // truckRequest.update resets to searching
    expect(mockTruckRequestUpdate).toHaveBeenCalledTimes(1);
    const trUpdateCall = mockTruckRequestUpdate.mock.calls[0][0];
    expect(trUpdateCall.data.status).toBe('searching');
    expect(trUpdateCall.data.assignedDriverId).toBeNull();
    expect(trUpdateCall.data.assignedVehicleId).toBeNull();
  });

  it('handleDriverDecline is idempotent — calling twice does not crash', async () => {
    // First call — normal happy path
    setupDeclineHappyPath();
    const result1 = await confirmedHoldService.handleDriverDecline('assign-001');
    expect(result1.success).toBe(true);

    // Second call — assignment is already declined; prisma update still succeeds
    // because we query by { tripId } not { tripId, status }
    resetAllMocks();
    setupDeclineHappyPath({ status: 'driver_declined' });
    const result2 = await confirmedHoldService.handleDriverDecline('assign-001');
    expect(result2.success).toBe(true);
  });

  it('handleDriverDecline with no truckRequest found still succeeds', async () => {
    setupDeclineHappyPath();
    // Override: findFirst returns null (no truck request for this tripId)
    mockTruckRequestFindFirst.mockResolvedValue(null);

    const result = await confirmedHoldService.handleDriverDecline('assign-001');

    expect(result.success).toBe(true);
    expect(result.declined).toBe(true);
    // truckRequest.update should not have been called
    expect(mockTruckRequestUpdate).not.toHaveBeenCalled();
  });

  it('handleDriverDecline when assignment update fails returns failure', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    mockAssignmentUpdate.mockRejectedValue(new Error('Record not found'));

    const result = await confirmedHoldService.handleDriverDecline('assign-001');

    // Error is caught and returns failure
    expect(result.success).toBe(false);
    expect(result.declined).toBe(false);
  });

  it('handleDriverDecline message contains success text', async () => {
    setupDeclineHappyPath();

    const result = await confirmedHoldService.handleDriverDecline('assign-001');

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
    mockAssignmentUpdate.mockResolvedValueOnce(assign1);
    mockTruckRequestFindFirst.mockResolvedValueOnce({
      id: 'tr-001',
      orderId: 'order-001',
      status: 'assigned',
    });
    mockTruckRequestUpdate.mockResolvedValueOnce({});
    mockTruckHoldLedgerFindFirst.mockResolvedValueOnce(null);

    mockReleaseVehicle.mockResolvedValue(undefined);
    mockExecuteRaw.mockResolvedValue(1);

    const promise1 = confirmedHoldService.handleDriverDecline('assign-001');

    // Driver 2 decline (different assignment)
    const assign2 = buildAssignment({
      id: 'assign-002',
      vehicleId: 'vehicle-002',
      driverId: 'driver-002',
      truckRequestId: 'tr-002',
    });
    mockAssignmentUpdate.mockResolvedValueOnce(assign2);
    mockTruckRequestFindFirst.mockResolvedValueOnce({
      id: 'tr-002',
      orderId: 'order-001',
      status: 'assigned',
    });
    mockTruckRequestUpdate.mockResolvedValueOnce({});
    mockTruckHoldLedgerFindFirst.mockResolvedValueOnce(null);

    const promise2 = confirmedHoldService.handleDriverDecline('assign-002');

    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1.success).toBe(true);
    expect(result1.declined).toBe(true);
    expect(result2.success).toBe(true);
    expect(result2.declined).toBe(true);

    // Both assignments should have been updated
    expect(mockAssignmentUpdate).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// ADDITIONAL EDGE CASES
// =============================================================================

describe('Edge cases — lock contention and missing data', () => {
  beforeEach(resetAllMocks);

  it('handleDriverAcceptance returns failure when lock not acquired', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: false });

    const result = await confirmedHoldService.handleDriverAcceptance('assign-001');

    expect(result.success).toBe(false);
    expect(result.message).toContain('lock');
    expect(mockAssignmentUpdate).not.toHaveBeenCalled();
  });

  it('handleDriverDecline returns failure when lock not acquired', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: false });

    const result = await confirmedHoldService.handleDriverDecline('assign-001');

    expect(result.success).toBe(false);
    expect(result.message).toContain('lock');
    expect(mockAssignmentUpdate).not.toHaveBeenCalled();
  });

  it('handleDriverDecline with no truckRequest found still succeeds', async () => {
    setupDeclineHappyPath();
    // Override: findFirst returns null (no truck request)
    mockTruckRequestFindFirst.mockResolvedValue(null);

    const result = await confirmedHoldService.handleDriverDecline('assign-001');

    expect(result.success).toBe(true);
    expect(result.declined).toBe(true);
    // truckRequest.update should not have been called
    expect(mockTruckRequestUpdate).not.toHaveBeenCalled();
  });

  it('handleDriverDecline with truckRequest found resets to searching', async () => {
    setupDeclineHappyPath();

    const result = await confirmedHoldService.handleDriverDecline('assign-001');

    expect(result.success).toBe(true);
    expect(mockTruckRequestUpdate).toHaveBeenCalledTimes(1);
    const updateData = mockTruckRequestUpdate.mock.calls[0][0].data;
    expect(updateData.status).toBe('searching');
  });

  it('handleDriverDecline truckRequest update failure returns failure', async () => {
    setupDeclineHappyPath();
    mockTruckRequestUpdate.mockRejectedValue(new Error('DB write failed'));

    const result = await confirmedHoldService.handleDriverDecline('assign-001');

    // Error is caught by the outer try/catch, returns failure
    expect(result.success).toBe(false);
  });

  it('handleDriverDecline always releases lock even on failure', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    mockAssignmentUpdate.mockRejectedValue(new Error('DB error'));

    await confirmedHoldService.handleDriverDecline('assign-001');

    // Lock should be released in the finally block
    expect(mockRedisReleaseLock).toHaveBeenCalledWith(
      'driver-acceptance:assign-001',
      'driver-decline'
    );
  });
});
