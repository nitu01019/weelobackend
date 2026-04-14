/**
 * =============================================================================
 * FIX HOLD EXPIRY HARDENING TESTS
 * =============================================================================
 *
 * Covers:
 *   FIX-7:  transporterId scoping in hold expiry cleanup WHERE clause
 *   FIX-21: Distributed lock in reconciliation (acquire + skip)
 *   FIX-37: processExpiredHoldById works without fake QueueJob wrapper
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
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    isConnected: () => true,
  },
}));

// Prisma mock
const mockAssignmentFindMany = jest.fn();
const mockAssignmentUpdateMany = jest.fn();
const mockVehicleUpdateMany = jest.fn();
const mockTruckHoldLedgerFindUnique = jest.fn();
const mockTruckHoldLedgerFindMany = jest.fn();
const mockTruckHoldLedgerUpdate = jest.fn();
const mockOrderFindUnique = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    assignment: {
      findMany: (...args: any[]) => mockAssignmentFindMany(...args),
      updateMany: (...args: any[]) => mockAssignmentUpdateMany(...args),
    },
    vehicle: {
      updateMany: (...args: any[]) => mockVehicleUpdateMany(...args),
    },
    truckHoldLedger: {
      findUnique: (...args: any[]) => mockTruckHoldLedgerFindUnique(...args),
      findMany: (...args: any[]) => mockTruckHoldLedgerFindMany(...args),
      update: (...args: any[]) => mockTruckHoldLedgerUpdate(...args),
    },
    order: {
      findUnique: (...args: any[]) => mockOrderFindUnique(...args),
    },
    $transaction: (...args: any[]) => mockTransaction(...args),
  },
}));

// Queue service mock
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    add: jest.fn().mockResolvedValue('mock-job-id'),
    registerProcessor: jest.fn(),
    getStats: jest.fn().mockResolvedValue({ queues: [] }),
  },
  QueueJob: {},
}));

// Live availability mock
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: jest.fn().mockResolvedValue(undefined),
  },
}));

// Vehicle key mock
jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn().mockReturnValue('mock-vehicle-key'),
}));

// Socket service mock
jest.mock('../shared/services/socket.service', () => ({
  emitToUser: jest.fn(),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { holdExpiryCleanupService, HoldExpiryCleanupService } from '../modules/hold-expiry/hold-expiry-cleanup.service';
import { HoldReconciliationService } from '../modules/hold-expiry/hold-reconciliation.service';

// =============================================================================
// HELPERS
// =============================================================================

function resetAllMocks(): void {
  jest.clearAllMocks();
  mockRedisAcquireLock.mockReset();
  mockRedisReleaseLock.mockReset();
  mockRedisGet.mockReset();
  mockRedisSet.mockReset();
  mockRedisDel.mockReset();
  mockAssignmentFindMany.mockReset();
  mockAssignmentUpdateMany.mockReset();
  mockVehicleUpdateMany.mockReset();
  mockTruckHoldLedgerFindUnique.mockReset();
  mockTruckHoldLedgerFindMany.mockReset();
  mockTruckHoldLedgerUpdate.mockReset();
  mockOrderFindUnique.mockReset();
  mockTransaction.mockReset();
}

// =============================================================================
// FIX-7: transporterId scoping in hold expiry cleanup
// =============================================================================

describe('FIX-7: transporterId scoping in hold expiry cleanup', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('should include transporterId in assignment query when releasing confirmed vehicles', async () => {
    // Setup: hold record with specific transporterId
    const holdRecord = {
      holdId: 'hold-123',
      orderId: 'order-456',
      transporterId: 'transporter-A',
      truckRequestIds: ['tr-1'],
      phase: 'CONFIRMED',
      status: 'active',
      vehicleType: 'open',
      vehicleSubtype: '17ft',
      quantity: 2,
    };

    // Mock: hold lookup returns active hold
    mockTruckHoldLedgerFindUnique.mockResolvedValue(holdRecord);
    mockTruckHoldLedgerUpdate.mockResolvedValue({
      ...holdRecord,
      status: 'expired',
    });

    // Mock: Redis cancel check returns null (not cancelled)
    mockRedisGet.mockResolvedValue(null);

    // Mock: assignment findMany returns assignments only for this transporter
    const mockAssignment = {
      id: 'assign-1',
      orderId: 'order-456',
      transporterId: 'transporter-A',
      status: 'pending',
      vehicle: {
        id: 'vehicle-1',
        vehicleKey: 'vk-1',
        vehicleNumber: 'KA-01-1234',
        status: 'on_hold',
        transporterId: 'transporter-A',
      },
    };
    mockAssignmentFindMany.mockResolvedValue([mockAssignment]);

    // Mock: transaction for CAS cancel + vehicle release
    mockTransaction.mockImplementation(async (fn: any) => {
      return fn({
        assignment: {
          updateMany: mockAssignmentUpdateMany.mockResolvedValue({ count: 1 }),
        },
        vehicle: {
          updateMany: mockVehicleUpdateMany.mockResolvedValue({ count: 1 }),
        },
      });
    });

    // Mock: customer notification lookup
    mockOrderFindUnique.mockResolvedValue({ customerId: 'customer-1' });

    // Act: process expired hold
    await holdExpiryCleanupService.processExpiredHold({
      id: 'job-1',
      type: 'confirmed_hold_expired',
      data: { holdId: 'hold-123', phase: 'confirmed' },
      priority: 0,
      attempts: 0,
      maxAttempts: 3,
      createdAt: Date.now(),
    });

    // Assert: assignment.findMany was called WITH transporterId
    expect(mockAssignmentFindMany).toHaveBeenCalledTimes(1);
    const findManyArgs = mockAssignmentFindMany.mock.calls[0][0];
    expect(findManyArgs.where).toHaveProperty('transporterId', 'transporter-A');
    expect(findManyArgs.where).toHaveProperty('orderId', 'order-456');
  });

  it('should NOT cancel assignments belonging to other transporters', async () => {
    // Setup: hold belongs to transporter-A
    const holdRecord = {
      holdId: 'hold-123',
      orderId: 'order-shared',
      transporterId: 'transporter-A',
      truckRequestIds: ['tr-1'],
      phase: 'CONFIRMED',
      status: 'active',
      vehicleType: 'open',
      vehicleSubtype: '17ft',
      quantity: 1,
    };

    mockTruckHoldLedgerFindUnique.mockResolvedValue(holdRecord);
    mockTruckHoldLedgerUpdate.mockResolvedValue({
      ...holdRecord,
      status: 'expired',
    });
    mockRedisGet.mockResolvedValue(null);

    // Mock: findMany returns empty because the WHERE includes transporterId,
    // filtering out transporter-B's assignments
    mockAssignmentFindMany.mockResolvedValue([]);

    mockOrderFindUnique.mockResolvedValue({ customerId: 'customer-1' });

    // Act
    await holdExpiryCleanupService.processExpiredHold({
      id: 'job-2',
      type: 'confirmed_hold_expired',
      data: { holdId: 'hold-123', phase: 'confirmed' },
      priority: 0,
      attempts: 0,
      maxAttempts: 3,
      createdAt: Date.now(),
    });

    // Assert: No assignments were cancelled (transporter-B's assignments are safe)
    expect(mockTransaction).not.toHaveBeenCalled();
    // Assert: query was scoped to transporter-A
    const where = mockAssignmentFindMany.mock.calls[0][0].where;
    expect(where.transporterId).toBe('transporter-A');
  });

  it('should skip vehicle release for flex hold expiry (no vehicle release needed)', async () => {
    const holdRecord = {
      holdId: 'hold-flex-1',
      orderId: 'order-789',
      transporterId: 'transporter-C',
      phase: 'FLEX',
      status: 'active',
      vehicleType: 'open',
      vehicleSubtype: '17ft',
      quantity: 1,
    };

    mockTruckHoldLedgerFindUnique.mockResolvedValue(holdRecord);
    mockTruckHoldLedgerUpdate.mockResolvedValue({
      ...holdRecord,
      status: 'expired',
    });
    mockRedisGet.mockResolvedValue(null);
    mockOrderFindUnique.mockResolvedValue({ customerId: 'customer-2' });

    await holdExpiryCleanupService.processExpiredHold({
      id: 'job-flex',
      type: 'flex_hold_expired',
      data: { holdId: 'hold-flex-1', phase: 'flex' },
      priority: 0,
      attempts: 0,
      maxAttempts: 3,
      createdAt: Date.now(),
    });

    // Flex holds do NOT release vehicles — only confirmed holds do
    expect(mockAssignmentFindMany).not.toHaveBeenCalled();
  });
});

// =============================================================================
// FIX-21: Distributed lock in reconciliation
// =============================================================================

describe('FIX-21: Distributed lock in reconciliation', () => {
  let reconciliationService: HoldReconciliationService;

  beforeEach(() => {
    resetAllMocks();
    reconciliationService = new HoldReconciliationService();
  });

  afterEach(() => {
    reconciliationService.stop();
  });

  it('should acquire distributed lock before running reconciliation', async () => {
    // Setup: lock acquired successfully
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(true);

    // No expired holds found
    mockTruckHoldLedgerFindMany.mockResolvedValue([]);

    // Act: trigger reconciliation via start (runs immediately)
    reconciliationService.start();

    // Wait for the immediate async run to complete
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert: lock was acquired with expected key
    expect(mockRedisAcquireLock).toHaveBeenCalledWith(
      'hold:cleanup:unified',
      expect.any(String),
      35
    );

    // Assert: lock was released after completion
    expect(mockRedisReleaseLock).toHaveBeenCalledWith(
      'hold:cleanup:unified',
      expect.any(String)
    );
  });

  it('should skip reconciliation if lock is not available', async () => {
    // Setup: lock NOT acquired (another instance has it)
    mockRedisAcquireLock.mockResolvedValue({ acquired: false });

    // Act
    reconciliationService.start();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert: lock was attempted
    expect(mockRedisAcquireLock).toHaveBeenCalled();

    // Assert: no DB queries were made (skipped entirely)
    expect(mockTruckHoldLedgerFindMany).not.toHaveBeenCalled();

    // Assert: releaseLock was NOT called (we never acquired it)
    expect(mockRedisReleaseLock).not.toHaveBeenCalled();
  });

  it('should release lock even if reconciliation throws an error', async () => {
    // Setup: lock acquired
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(true);

    // Simulate DB failure during reconciliation
    mockTruckHoldLedgerFindMany.mockRejectedValue(new Error('DB connection lost'));

    // Act
    reconciliationService.start();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert: lock was released despite error (finally block)
    expect(mockRedisReleaseLock).toHaveBeenCalledWith(
      'hold:cleanup:unified',
      expect.any(String)
    );
  });

  it('should skip cycle gracefully if Redis is unreachable for lock', async () => {
    // Setup: Redis throws on acquireLock
    mockRedisAcquireLock.mockRejectedValue(new Error('ECONNREFUSED'));

    // Act
    reconciliationService.start();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert: no DB queries attempted
    expect(mockTruckHoldLedgerFindMany).not.toHaveBeenCalled();

    // Assert: no crash — service continues
    expect(mockRedisReleaseLock).not.toHaveBeenCalled();
  });

  it('should process expired holds when lock is acquired and holds exist', async () => {
    // Setup: lock acquired
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(true);

    // Return expired flex holds
    const expiredFlexHold = {
      holdId: 'hold-expired-1',
      orderId: 'order-1',
      transporterId: 'transporter-1',
      flexExpiresAt: new Date(Date.now() - 60000),
    };

    // First call returns flex holds, second returns empty confirmed holds
    mockTruckHoldLedgerFindMany
      .mockResolvedValueOnce([expiredFlexHold])  // flex
      .mockResolvedValueOnce([]);                 // confirmed

    // Mock for processExpiredHoldById's internal lookup
    mockTruckHoldLedgerFindUnique.mockResolvedValue({
      holdId: 'hold-expired-1',
      phase: 'FLEX',
      transporterId: 'transporter-1',
      orderId: 'order-1',
      status: 'active',
    });

    // The internal processExpiredHold call will fail because we
    // haven't fully mocked the cleanup service, but the reconciliation
    // should still complete and release the lock
    mockTruckHoldLedgerUpdate.mockResolvedValue({
      holdId: 'hold-expired-1',
      status: 'expired',
    });
    mockRedisGet.mockResolvedValue(null);
    mockOrderFindUnique.mockResolvedValue(null);

    // Act
    reconciliationService.start();
    await new Promise(resolve => setTimeout(resolve, 100));

    // Assert: DB was queried for expired holds
    expect(mockTruckHoldLedgerFindMany).toHaveBeenCalledTimes(2);

    // Assert: lock was released
    expect(mockRedisReleaseLock).toHaveBeenCalled();
  });
});

// =============================================================================
// FIX-37: processExpiredHoldById works without QueueJob wrapper
// =============================================================================

describe('FIX-37: processExpiredHoldById without fake QueueJob', () => {
  let reconciliationService: HoldReconciliationService;

  beforeEach(() => {
    resetAllMocks();
    reconciliationService = new HoldReconciliationService();
  });

  afterEach(() => {
    reconciliationService.stop();
  });

  it('should process a flex hold by ID without needing a QueueJob', async () => {
    // Setup: hold lookup
    mockTruckHoldLedgerFindUnique
      .mockResolvedValueOnce({ phase: 'FLEX' })   // phase lookup
      .mockResolvedValueOnce({                      // processExpiredHold internal lookup
        holdId: 'hold-37-flex',
        phase: 'FLEX',
        status: 'active',
        orderId: 'order-37',
        transporterId: 'transporter-37',
      });

    mockTruckHoldLedgerUpdate.mockResolvedValue({
      holdId: 'hold-37-flex',
      status: 'expired',
      transporterId: 'transporter-37',
      orderId: 'order-37',
    });
    mockRedisGet.mockResolvedValue(null);
    mockOrderFindUnique.mockResolvedValue({ customerId: 'customer-37' });

    // Act: call processExpiredHoldById directly (public method)
    await reconciliationService.processExpiredHoldById('hold-37-flex');

    // Assert: hold was looked up and processed
    expect(mockTruckHoldLedgerFindUnique).toHaveBeenCalledWith({
      where: { holdId: 'hold-37-flex' },
      select: { phase: true },
    });

    // Assert: hold was updated to expired
    expect(mockTruckHoldLedgerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { holdId: 'hold-37-flex' },
        data: expect.objectContaining({ status: 'expired' }),
      })
    );
  });

  it('should process a confirmed hold by ID with phase override', async () => {
    // Setup: skip phase lookup when override is provided
    mockTruckHoldLedgerFindUnique.mockResolvedValueOnce({
      holdId: 'hold-37-confirmed',
      phase: 'CONFIRMED',
      status: 'active',
      orderId: 'order-37b',
      transporterId: 'transporter-37b',
    });

    mockTruckHoldLedgerUpdate.mockResolvedValue({
      holdId: 'hold-37-confirmed',
      status: 'expired',
      transporterId: 'transporter-37b',
      orderId: 'order-37b',
    });
    mockRedisGet.mockResolvedValue(null);

    // Mock confirmed hold vehicle release
    mockAssignmentFindMany.mockResolvedValue([]);
    mockOrderFindUnique.mockResolvedValue({ customerId: 'customer-37b' });

    // Act: call with explicit phase override
    await reconciliationService.processExpiredHoldById('hold-37-confirmed', 'confirmed');

    // Assert: phase lookup was NOT performed (override used)
    // The first call should be the processExpiredHold internal lookup, not phase select
    const firstCall = mockTruckHoldLedgerFindUnique.mock.calls[0][0];
    expect(firstCall.where).toEqual({ holdId: 'hold-37-confirmed' });
  });

  it('should silently skip if hold ID does not exist', async () => {
    // Setup: hold not found
    mockTruckHoldLedgerFindUnique.mockResolvedValue(null);

    // Act
    await reconciliationService.processExpiredHoldById('hold-nonexistent');

    // Assert: no error thrown, no update attempted
    expect(mockTruckHoldLedgerUpdate).not.toHaveBeenCalled();
  });

  it('should log error and not throw if processing fails', async () => {
    const { logger } = require('../shared/services/logger.service');

    // Setup: phase lookup succeeds but processExpiredHold throws
    mockTruckHoldLedgerFindUnique
      .mockResolvedValueOnce({ phase: 'FLEX' })
      .mockRejectedValueOnce(new Error('DB timeout'));

    // Act: should not throw
    await reconciliationService.processExpiredHoldById('hold-error');

    // Assert: error was logged
    expect(logger.error).toHaveBeenCalledWith(
      '[RECONCILIATION] Failed to process',
      expect.objectContaining({ holdId: 'hold-error' })
    );
  });

  it('should default to flex phase when phase override is not "confirmed"', async () => {
    mockTruckHoldLedgerFindUnique.mockResolvedValueOnce({
      holdId: 'hold-37-unknown',
      phase: 'FLEX',
      status: 'active',
      orderId: 'order-37c',
      transporterId: 'transporter-37c',
    });

    mockTruckHoldLedgerUpdate.mockResolvedValue({
      holdId: 'hold-37-unknown',
      status: 'expired',
      transporterId: 'transporter-37c',
      orderId: 'order-37c',
    });
    mockRedisGet.mockResolvedValue(null);
    mockOrderFindUnique.mockResolvedValue(null);

    // Act: pass an unknown phase override — should default to 'flex'
    await reconciliationService.processExpiredHoldById('hold-37-unknown', 'unknown_phase');

    // Assert: hold was still processed (defaulted to flex)
    expect(mockTruckHoldLedgerFindUnique).toHaveBeenCalled();
  });
});
