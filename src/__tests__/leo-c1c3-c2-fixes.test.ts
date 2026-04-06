/**
 * =============================================================================
 * LEO C1+C3+C2 FIXES -- Tests for Hold Expiry FK fix, CAS on expiry cancel,
 *                        and CAS on driver accept/decline
 * =============================================================================
 *
 * C1: Hold expiry uses orderId (not holdId) to find assignments
 * C3: CAS guard on expiry cancel -- only cancels pending/driver_declined
 * C2: CAS guard on driver acceptance/decline in confirmed-hold service
 *
 * @author LEO-Tester-1
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
const mockAssignmentFindMany = jest.fn();
const mockAssignmentFindUnique = jest.fn();
const mockAssignmentFindUniqueOrThrow = jest.fn();
const mockAssignmentUpdateMany = jest.fn();
const mockTruckHoldLedgerFindUnique = jest.fn();
const mockTruckHoldLedgerFindFirst = jest.fn();
const mockTruckHoldLedgerUpdate = jest.fn();
const mockTruckRequestFindFirst = jest.fn();
const mockTruckRequestUpdate = jest.fn();
const mockTruckRequestFindMany = jest.fn();
const mockVehicleUpdateMany = jest.fn();
const mockExecuteRaw = jest.fn();

const mockPrismaClient = {
  assignment: {
    findMany: (...args: any[]) => mockAssignmentFindMany(...args),
    findUnique: (...args: any[]) => mockAssignmentFindUnique(...args),
    findUniqueOrThrow: (...args: any[]) => mockAssignmentFindUniqueOrThrow(...args),
    updateMany: (...args: any[]) => mockAssignmentUpdateMany(...args),
  },
  truckHoldLedger: {
    findUnique: (...args: any[]) => mockTruckHoldLedgerFindUnique(...args),
    findFirst: (...args: any[]) => mockTruckHoldLedgerFindFirst(...args),
    update: (...args: any[]) => mockTruckHoldLedgerUpdate(...args),
  },
  truckRequest: {
    findFirst: (...args: any[]) => mockTruckRequestFindFirst(...args),
    update: (...args: any[]) => mockTruckRequestUpdate(...args),
    findMany: (...args: any[]) => mockTruckRequestFindMany(...args),
  },
  vehicle: {
    updateMany: (...args: any[]) => mockVehicleUpdateMany(...args),
  },
  $executeRaw: (...args: any[]) => mockExecuteRaw(...args),
  $transaction: jest.fn().mockImplementation(async (callback: any) => {
    return callback(mockPrismaClient);
  }),
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
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  socketService: {
    emitToUser: (...args: any[]) => mockEmitToUser(...args),
  },
}));

// Queue service mock
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    add: jest.fn().mockResolvedValue('job-001'),
    registerProcessor: jest.fn(),
    getStats: jest.fn().mockResolvedValue({ queues: [] }),
    scheduleAssignmentTimeout: jest.fn().mockResolvedValue(undefined),
  },
}));

// Live availability service mock
const mockOnVehicleStatusChange = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: (...args: any[]) => mockOnVehicleStatusChange(...args),
  },
}));

// Hold expiry cleanup service mock
jest.mock('../modules/hold-expiry/hold-expiry-cleanup.service', () => {
  const actual = jest.requireActual('../modules/hold-expiry/hold-expiry-cleanup.service');
  return {
    ...actual,
    holdExpiryCleanupService: {
      ...actual.holdExpiryCleanupService,
      scheduleConfirmedHoldCleanup: jest.fn().mockResolvedValue(undefined),
      scheduleFlexHoldCleanup: jest.fn().mockResolvedValue(undefined),
    },
  };
});

// Vehicle lifecycle service mock
const mockReleaseVehicle = jest.fn();
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: (...args: any[]) => mockReleaseVehicle(...args),
}));

// Vehicle key service mock
jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: (type: string, sub: string) => `${type}_${sub}`,
}));

// Post-accept effects mock
jest.mock('../modules/assignment/post-accept.effects', () => ({
  applyPostAcceptSideEffects: jest.fn().mockResolvedValue(undefined),
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { logger } from '../shared/services/logger.service';

// We need to import the hold-expiry service fresh for C1/C3 tests.
// For C2, we import confirmed-hold service.
// Both imports are done after mocks are set up.

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
  mockAssignmentFindMany.mockReset();
  mockAssignmentFindUnique.mockReset();
  mockAssignmentFindUniqueOrThrow.mockReset();
  mockAssignmentUpdateMany.mockReset();
  mockTruckHoldLedgerFindUnique.mockReset();
  mockTruckHoldLedgerFindFirst.mockReset();
  mockTruckHoldLedgerUpdate.mockReset();
  mockTruckRequestFindFirst.mockReset();
  mockTruckRequestUpdate.mockReset();
  mockTruckRequestFindMany.mockReset();
  mockVehicleUpdateMany.mockReset();
  mockExecuteRaw.mockReset();
  mockEmitToUser.mockReset();
  mockOnVehicleStatusChange.mockReset();
  mockOnVehicleStatusChange.mockResolvedValue(undefined);
  mockReleaseVehicle.mockReset();
  mockReleaseVehicle.mockResolvedValue(undefined);
}

/**
 * Build a mock hold record from TruckHoldLedger
 */
function buildHold(overrides: Record<string, any> = {}) {
  return {
    holdId: 'hold-001',
    orderId: 'order-001',
    transporterId: 'transporter-001',
    phase: 'CONFIRMED',
    status: 'confirmed',
    truckRequestIds: ['tr-001', 'tr-002'],
    vehicleType: 'Open',
    vehicleSubtype: '17ft',
    quantity: 2,
    expiresAt: new Date(Date.now() + 180_000),
    confirmedAt: new Date(),
    confirmedExpiresAt: new Date(Date.now() + 180_000),
    releasedAt: null,
    terminalReason: null,
    ...overrides,
  };
}

/**
 * Build a mock assignment record with an attached vehicle
 */
function buildAssignmentWithVehicle(overrides: Record<string, any> = {}) {
  const vehicleId = overrides.vehicleId || 'vehicle-001';
  return {
    id: overrides.id || 'assign-001',
    orderId: overrides.orderId || 'order-001',
    truckRequestId: overrides.truckRequestId || 'tr-001',
    transporterId: overrides.transporterId || 'transporter-001',
    vehicleId,
    vehicleNumber: overrides.vehicleNumber || 'MH12AB1234',
    driverId: overrides.driverId || 'driver-001',
    driverName: overrides.driverName || 'Test Driver',
    tripId: overrides.tripId || 'trip-001',
    status: overrides.status || 'pending',
    vehicle: {
      id: vehicleId,
      vehicleKey: overrides.vehicleKey || 'Open_17ft',
      vehicleNumber: overrides.vehicleNumber || 'MH12AB1234',
      status: overrides.vehicleStatus || 'on_hold',
      ...overrides.vehicle,
    },
    ...overrides,
  };
}

// =============================================================================
// C1 TESTS: Hold Expiry FK Fix (orderId, not holdId)
// =============================================================================

describe('C1 -- Hold Expiry uses orderId to find assignments (FK fix)', () => {
  beforeEach(resetAllMocks);

  it('TEST 1: findMany called with orderId, NOT holdId', async () => {
    const hold = buildHold({ holdId: 'hold-001', orderId: 'order-001' });

    // Setup: hold is found, in confirmed state, correct phase
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    mockTruckHoldLedgerUpdate.mockResolvedValue({ ...hold, status: 'expired' });

    // Assignments found for this order
    const assignment = buildAssignmentWithVehicle({ orderId: 'order-001' });
    mockAssignmentFindMany.mockResolvedValue([assignment]);
    mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockVehicleUpdateMany.mockResolvedValue({ count: 1 });

    const { HoldExpiryCleanupService } = require('../modules/hold-expiry/hold-expiry-cleanup.service');
    const service = new HoldExpiryCleanupService();

    await service.processExpiredHold({
      id: 'job-001',
      data: { holdId: 'hold-001', phase: 'confirmed' },
    });

    // Verify: assignment.findMany uses orderId, NOT holdId
    expect(mockAssignmentFindMany).toHaveBeenCalledTimes(1);
    const findManyArgs = mockAssignmentFindMany.mock.calls[0][0];
    expect(findManyArgs.where.orderId).toBe('order-001');
    expect(findManyArgs.where).not.toHaveProperty('holdId');
  });

  it('TEST 2: Null orderId guard -- early return with error log, no assignments queried', async () => {
    const hold = buildHold({ holdId: 'hold-002', orderId: null });

    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    mockTruckHoldLedgerUpdate.mockResolvedValue({ ...hold, status: 'expired' });

    const { HoldExpiryCleanupService } = require('../modules/hold-expiry/hold-expiry-cleanup.service');
    const service = new HoldExpiryCleanupService();

    await service.processExpiredHold({
      id: 'job-002',
      data: { holdId: 'hold-002', phase: 'confirmed' },
    });

    // Verify: error logged about missing orderId
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Hold has no orderId'),
      expect.objectContaining({ holdId: 'hold-002' })
    );

    // Verify: assignments NOT queried
    expect(mockAssignmentFindMany).not.toHaveBeenCalled();
  });

  it('TEST 3: Multiple assignments found -- all processed', async () => {
    const hold = buildHold({ holdId: 'hold-003', orderId: 'order-003' });

    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    mockTruckHoldLedgerUpdate.mockResolvedValue({ ...hold, status: 'expired' });

    const assignment1 = buildAssignmentWithVehicle({
      id: 'assign-001',
      orderId: 'order-003',
      vehicleId: 'vehicle-001',
      status: 'pending',
    });
    const assignment2 = buildAssignmentWithVehicle({
      id: 'assign-002',
      orderId: 'order-003',
      vehicleId: 'vehicle-002',
      vehicleKey: 'Open_20ft',
      status: 'pending',
    });

    mockAssignmentFindMany.mockResolvedValue([assignment1, assignment2]);
    mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockVehicleUpdateMany.mockResolvedValue({ count: 1 });

    const { HoldExpiryCleanupService } = require('../modules/hold-expiry/hold-expiry-cleanup.service');
    const service = new HoldExpiryCleanupService();

    await service.processExpiredHold({
      id: 'job-003',
      data: { holdId: 'hold-003', phase: 'confirmed' },
    });

    // Both assignments processed
    expect(mockAssignmentUpdateMany).toHaveBeenCalledTimes(2);
    // Both vehicles released
    expect(mockVehicleUpdateMany).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// C3 TESTS: CAS on Expiry Cancel
// =============================================================================

describe('C3 -- CAS guard on hold expiry cancellation', () => {
  beforeEach(resetAllMocks);

  /**
   * Helper: set up mocks for a confirmed hold expiry flow
   */
  function setupExpiryMocks(hold: Record<string, any>, assignments: Record<string, any>[]) {
    mockTruckHoldLedgerFindUnique.mockResolvedValue(hold);
    mockTruckHoldLedgerUpdate.mockResolvedValue({ ...hold, status: 'expired' });
    mockAssignmentFindMany.mockResolvedValue(assignments);
    mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
  }

  it('TEST 4: Cancel pending assignment -- updateMany with CAS, count=1, vehicle released', async () => {
    const hold = buildHold();
    const assignment = buildAssignmentWithVehicle({ status: 'pending' });

    setupExpiryMocks(hold, [assignment]);
    mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });

    const { HoldExpiryCleanupService } = require('../modules/hold-expiry/hold-expiry-cleanup.service');
    const service = new HoldExpiryCleanupService();

    await service.processExpiredHold({
      id: 'job-004',
      data: { holdId: 'hold-001', phase: 'confirmed' },
    });

    // Verify CAS guard: updateMany with status precondition
    expect(mockAssignmentUpdateMany).toHaveBeenCalledTimes(1);
    const updateArgs = mockAssignmentUpdateMany.mock.calls[0][0];
    expect(updateArgs.where.id).toBe('assign-001');
    expect(updateArgs.where.status).toEqual({ in: ['pending', 'driver_declined'] });
    expect(updateArgs.data.status).toBe('cancelled');

    // Vehicle released
    expect(mockVehicleUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('TEST 5: Skip driver_accepted -- updateMany returns count=0, vehicle NOT released', async () => {
    const hold = buildHold();
    const assignment = buildAssignmentWithVehicle({ status: 'driver_accepted' });

    setupExpiryMocks(hold, [assignment]);
    // CAS returns count=0 because driver_accepted is NOT in ['pending', 'driver_declined']
    mockAssignmentUpdateMany.mockResolvedValue({ count: 0 });

    const { HoldExpiryCleanupService } = require('../modules/hold-expiry/hold-expiry-cleanup.service');
    const service = new HoldExpiryCleanupService();

    await service.processExpiredHold({
      id: 'job-005',
      data: { holdId: 'hold-001', phase: 'confirmed' },
    });

    // CAS was attempted
    expect(mockAssignmentUpdateMany).toHaveBeenCalledTimes(1);
    // Vehicle NOT released (driver has it)
    expect(mockVehicleUpdateMany).not.toHaveBeenCalled();
    // Log indicates skipped
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Assignment not cancelled'),
      expect.objectContaining({ assignmentId: 'assign-001' })
    );
  });

  it('TEST 6: Cancel driver_declined -- updateMany count=1, vehicle released', async () => {
    const hold = buildHold();
    const assignment = buildAssignmentWithVehicle({ status: 'driver_declined' });

    setupExpiryMocks(hold, [assignment]);
    mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });

    const { HoldExpiryCleanupService } = require('../modules/hold-expiry/hold-expiry-cleanup.service');
    const service = new HoldExpiryCleanupService();

    await service.processExpiredHold({
      id: 'job-006',
      data: { holdId: 'hold-001', phase: 'confirmed' },
    });

    // CAS succeeded
    expect(mockAssignmentUpdateMany).toHaveBeenCalledTimes(1);
    const updateArgs = mockAssignmentUpdateMany.mock.calls[0][0];
    expect(updateArgs.where.status).toEqual({ in: ['pending', 'driver_declined'] });

    // Vehicle released
    expect(mockVehicleUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('TEST 7: Already cancelled (idempotent) -- count=0, skipped', async () => {
    const hold = buildHold();
    const assignment = buildAssignmentWithVehicle({ status: 'cancelled' });

    setupExpiryMocks(hold, [assignment]);
    // CAS returns count=0 because 'cancelled' is NOT in ['pending', 'driver_declined']
    mockAssignmentUpdateMany.mockResolvedValue({ count: 0 });

    const { HoldExpiryCleanupService } = require('../modules/hold-expiry/hold-expiry-cleanup.service');
    const service = new HoldExpiryCleanupService();

    await service.processExpiredHold({
      id: 'job-007',
      data: { holdId: 'hold-001', phase: 'confirmed' },
    });

    expect(mockAssignmentUpdateMany).toHaveBeenCalledTimes(1);
    // Vehicle NOT released
    expect(mockVehicleUpdateMany).not.toHaveBeenCalled();
  });

  it('TEST 8: Mixed batch -- 1 pending, 1 accepted, 1 declined: 2 cancelled + vehicles released, 1 skipped', async () => {
    const hold = buildHold();

    const pendingAssignment = buildAssignmentWithVehicle({
      id: 'assign-pending',
      vehicleId: 'vehicle-001',
      status: 'pending',
    });
    const acceptedAssignment = buildAssignmentWithVehicle({
      id: 'assign-accepted',
      vehicleId: 'vehicle-002',
      status: 'driver_accepted',
    });
    const declinedAssignment = buildAssignmentWithVehicle({
      id: 'assign-declined',
      vehicleId: 'vehicle-003',
      status: 'driver_declined',
    });

    setupExpiryMocks(hold, [pendingAssignment, acceptedAssignment, declinedAssignment]);

    // CAS results: pending=success, accepted=fail, declined=success
    mockAssignmentUpdateMany
      .mockResolvedValueOnce({ count: 1 })   // pending -> cancelled
      .mockResolvedValueOnce({ count: 0 })   // accepted -> CAS fail
      .mockResolvedValueOnce({ count: 1 });  // declined -> cancelled

    const { HoldExpiryCleanupService } = require('../modules/hold-expiry/hold-expiry-cleanup.service');
    const service = new HoldExpiryCleanupService();

    await service.processExpiredHold({
      id: 'job-008',
      data: { holdId: 'hold-001', phase: 'confirmed' },
    });

    // 3 CAS attempts
    expect(mockAssignmentUpdateMany).toHaveBeenCalledTimes(3);

    // Only 2 vehicles released (pending + declined), NOT the accepted one
    expect(mockVehicleUpdateMany).toHaveBeenCalledTimes(2);

    // Verify which vehicles were released
    const vehicleUpdateCalls = mockVehicleUpdateMany.mock.calls;
    const releasedVehicleIds = vehicleUpdateCalls.map((c: any) => c[0].where.id);
    expect(releasedVehicleIds).toContain('vehicle-001');
    expect(releasedVehicleIds).toContain('vehicle-003');
    expect(releasedVehicleIds).not.toContain('vehicle-002');
  });
});

// =============================================================================
// C2 TESTS: CAS on Driver Accept/Decline (confirmed-hold.service)
// =============================================================================

describe('C2 -- CAS guard on driver acceptance (confirmed-hold service)', () => {
  beforeEach(resetAllMocks);

  /**
   * Helper: set up mocks for driver acceptance happy path
   */
  function setupAcceptMocks(assignmentOverrides: Record<string, any> = {}) {
    const assignment = {
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
      ...assignmentOverrides,
    };

    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);

    // CAS updateMany succeeds (count=1)
    mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });

    // findUniqueOrThrow returns full record after CAS success
    mockAssignmentFindUniqueOrThrow.mockResolvedValue(assignment);

    // FK traversal: assignment.findUnique for truckRequestId/orderId
    mockAssignmentFindUnique.mockResolvedValue({
      truckRequestId: assignment.truckRequestId,
      orderId: assignment.orderId,
    });

    // truckRequest.findFirst via FK chain
    mockTruckRequestFindFirst.mockResolvedValue({
      id: assignment.truckRequestId,
      orderId: assignment.orderId,
    });

    // No confirmed hold ledger (simplifies test)
    mockTruckHoldLedgerFindFirst.mockResolvedValue(null);

    // Redis hash mocks
    mockRedisHIncrBy.mockResolvedValue(0);
    mockRedisHGetAll.mockResolvedValue(null);
    mockRedisHMSet.mockResolvedValue(undefined);
    mockRedisExpire.mockResolvedValue(true);

    return assignment;
  }

  /**
   * Helper: set up mocks for driver decline happy path
   */
  function setupDeclineMocks(assignmentOverrides: Record<string, any> = {}) {
    const assignment = {
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
      ...assignmentOverrides,
    };

    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);

    // CAS updateMany succeeds (count=1)
    mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });

    // findUniqueOrThrow returns full record after CAS success
    mockAssignmentFindUniqueOrThrow.mockResolvedValue(assignment);

    // FK traversal
    mockAssignmentFindUnique.mockResolvedValue({
      truckRequestId: assignment.truckRequestId,
      orderId: assignment.orderId,
    });

    mockTruckRequestFindFirst.mockResolvedValue({
      id: assignment.truckRequestId,
      orderId: assignment.orderId,
    });

    mockTruckRequestUpdate.mockResolvedValue({});
    mockTruckHoldLedgerFindFirst.mockResolvedValue(null);
    mockReleaseVehicle.mockResolvedValue(undefined);
    mockExecuteRaw.mockResolvedValue(1);

    // Redis hash mocks
    mockRedisHIncrBy.mockResolvedValue(0);
    mockRedisHGetAll.mockResolvedValue(null);
    mockRedisHMSet.mockResolvedValue(undefined);
    mockRedisExpire.mockResolvedValue(true);

    return assignment;
  }

  // ---------------------------------------------------------------------------
  // ACCEPT tests
  // ---------------------------------------------------------------------------

  it('TEST 9: Accept pending -- updateMany with CAS precondition, count=1, success=true', async () => {
    setupAcceptMocks();

    const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');
    const result = await confirmedHoldService.handleDriverAcceptance('assign-001');

    expect(result.success).toBe(true);
    expect(result.accepted).toBe(true);

    // Verify CAS: updateMany with status: 'pending' precondition
    expect(mockAssignmentUpdateMany).toHaveBeenCalledTimes(1);
    const updateArgs = mockAssignmentUpdateMany.mock.calls[0][0];
    expect(updateArgs.where.id).toBe('assign-001');
    expect(updateArgs.where.status).toBe('pending');
    expect(updateArgs.data.status).toBe('driver_accepted');
  });

  it('TEST 10: Accept already cancelled -- count=0, success=false, no side effects', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);

    // CAS fails: assignment is no longer pending (was cancelled)
    mockAssignmentUpdateMany.mockResolvedValue({ count: 0 });
    mockAssignmentFindUnique.mockResolvedValue({ status: 'cancelled' });

    const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');
    const result = await confirmedHoldService.handleDriverAcceptance('assign-001');

    expect(result.success).toBe(false);
    expect(result.accepted).toBe(false);
    expect(result.message).toContain('no longer pending');

    // No side effects: findUniqueOrThrow should NOT be called (CAS failed early)
    expect(mockAssignmentFindUniqueOrThrow).not.toHaveBeenCalled();
    // No Redis counter increments
    expect(mockRedisHIncrBy).not.toHaveBeenCalled();
  });

  it('TEST 11: Accept already accepted (double-click) -- count=0, success=false, no duplicate Redis increments', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);

    // CAS fails: already accepted
    mockAssignmentUpdateMany.mockResolvedValue({ count: 0 });
    mockAssignmentFindUnique.mockResolvedValue({ status: 'driver_accepted' });

    const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');
    const result = await confirmedHoldService.handleDriverAcceptance('assign-001');

    expect(result.success).toBe(false);
    expect(result.accepted).toBe(false);

    // No Redis HINCRBY (would cause double-count)
    expect(mockRedisHIncrBy).not.toHaveBeenCalled();
  });

  it('TEST 12: Accept already timed out -- count=0, success=false', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);

    // CAS fails: assignment timed out (status = driver_declined via timeout handler)
    mockAssignmentUpdateMany.mockResolvedValue({ count: 0 });
    mockAssignmentFindUnique.mockResolvedValue({ status: 'driver_declined' });

    const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');
    const result = await confirmedHoldService.handleDriverAcceptance('assign-001');

    expect(result.success).toBe(false);
    expect(result.message).toContain('no longer pending');
  });

  // ---------------------------------------------------------------------------
  // DECLINE tests
  // ---------------------------------------------------------------------------

  it('TEST 13: Decline pending -- updateMany with CAS, count=1, success=true', async () => {
    setupDeclineMocks();

    const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');
    const result = await confirmedHoldService.handleDriverDecline('assign-001');

    expect(result.success).toBe(true);
    expect(result.declined).toBe(true);

    // Verify CAS: updateMany with status: 'pending' precondition
    expect(mockAssignmentUpdateMany).toHaveBeenCalledTimes(1);
    const updateArgs = mockAssignmentUpdateMany.mock.calls[0][0];
    expect(updateArgs.where.id).toBe('assign-001');
    expect(updateArgs.where.status).toBe('pending');
    expect(updateArgs.data.status).toBe('driver_declined');
  });

  it('TEST 14: Decline already cancelled -- count=0, success=false', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);

    // CAS fails: assignment was cancelled (e.g., by expiry)
    mockAssignmentUpdateMany.mockResolvedValue({ count: 0 });
    mockAssignmentFindUnique.mockResolvedValue({ status: 'cancelled' });

    const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');
    const result = await confirmedHoldService.handleDriverDecline('assign-001');

    expect(result.success).toBe(false);
    expect(result.declined).toBe(false);
    expect(result.message).toContain('no longer pending');
  });

  it('TEST 15: Decline already declined (double-click) -- count=0, success=false', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);

    // CAS fails: already declined
    mockAssignmentUpdateMany.mockResolvedValue({ count: 0 });
    mockAssignmentFindUnique.mockResolvedValue({ status: 'driver_declined' });

    const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');
    const result = await confirmedHoldService.handleDriverDecline('assign-001');

    expect(result.success).toBe(false);
    expect(result.declined).toBe(false);
  });
});

// =============================================================================
// RACE CONDITION TESTS
// =============================================================================

describe('Race conditions -- CAS ensures only one winner', () => {
  beforeEach(resetAllMocks);

  it('TEST 16: Accept vs Expiry -- if expiry wins, accept returns success=false', async () => {
    // Simulate: expiry runs first, cancels the assignment.
    // Then driver tries to accept -- CAS fails (count=0).

    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);

    // Accept CAS fails because expiry already cancelled the assignment
    mockAssignmentUpdateMany.mockResolvedValue({ count: 0 });
    mockAssignmentFindUnique.mockResolvedValue({ status: 'cancelled' });

    const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');
    const result = await confirmedHoldService.handleDriverAcceptance('assign-001');

    // Accept lost the race
    expect(result.success).toBe(false);
    expect(result.accepted).toBe(false);
    expect(result.message).toContain('no longer pending');

    // No side effects
    expect(mockAssignmentFindUniqueOrThrow).not.toHaveBeenCalled();
    expect(mockRedisHIncrBy).not.toHaveBeenCalled();
  });

  it('TEST 17: Double accept -- first succeeds (count=1), second gets count=0', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);

    const assignment = {
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
    };

    // First accept: CAS succeeds
    mockAssignmentUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockAssignmentFindUniqueOrThrow.mockResolvedValueOnce(assignment);
    mockAssignmentFindUnique
      .mockResolvedValueOnce({ truckRequestId: 'tr-001', orderId: 'order-001' });
    mockTruckRequestFindFirst.mockResolvedValueOnce({ id: 'tr-001', orderId: 'order-001' });
    mockTruckHoldLedgerFindFirst.mockResolvedValueOnce(null);

    // Second accept: CAS fails
    mockAssignmentUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockAssignmentFindUnique
      .mockResolvedValueOnce({ status: 'driver_accepted' });

    const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');

    const [result1, result2] = await Promise.all([
      confirmedHoldService.handleDriverAcceptance('assign-001'),
      confirmedHoldService.handleDriverAcceptance('assign-001'),
    ]);

    // Exactly one wins, one loses
    const successes = [result1, result2].filter((r: any) => r.success);
    const failures = [result1, result2].filter((r: any) => !r.success);

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    expect(successes[0].accepted).toBe(true);
    expect(failures[0].accepted).toBe(false);
  });
});
