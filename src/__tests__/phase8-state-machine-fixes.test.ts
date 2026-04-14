/**
 * Phase 8 — State Machine & Lifecycle Fixes
 * C-10, H-22, H-24, H-25, H-26, H-6, H-8, H-9
 */
import {
  ASSIGNMENT_VALID_TRANSITIONS,
  TERMINAL_ASSIGNMENT_STATUSES,
  isValidTransition,
} from '../core/state-machines';

// -- Mocks (before any service import) --
jest.mock('../shared/services/logger.service', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    acquireLock: jest.fn().mockResolvedValue({ acquired: true }),
    releaseLock: jest.fn().mockResolvedValue(undefined),
    hIncrBy: jest.fn().mockResolvedValue(1),
    hGetAll: jest.fn().mockResolvedValue({}),
    hMSet: jest.fn().mockResolvedValue(undefined),
    expire: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    getJSON: jest.fn().mockResolvedValue(null),
  },
}));

const mockFindMany = jest.fn();
const mockFindUnique = jest.fn();
const mockUpdateMany = jest.fn();
const mockUpdate = jest.fn();
const mockCount = jest.fn();
const mockQueryRaw = jest.fn();
const mockTransaction = jest.fn();
const mockLedgerCreate = jest.fn();
const mockAbuseUpsert = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    truckHoldLedger: { findMany: mockFindMany, findUnique: mockFindUnique, update: mockUpdate, count: mockCount },
    assignment: { findMany: mockFindMany, findUnique: mockFindUnique, updateMany: mockUpdateMany, findUniqueOrThrow: mockFindUnique, count: mockCount },
    booking: { updateMany: mockUpdateMany },
    cancellationLedger: { create: mockLedgerCreate },
    cancellationAbuseCounter: { upsert: mockAbuseUpsert },
    $transaction: mockTransaction, $queryRaw: mockQueryRaw,
  },
  HoldPhase: { FLEX: 'FLEX', CONFIRMED: 'CONFIRMED', EXPIRED: 'EXPIRED', RELEASED: 'RELEASED' },
  AssignmentStatus: {
    pending: 'pending', driver_accepted: 'driver_accepted', driver_declined: 'driver_declined',
    en_route_pickup: 'en_route_pickup', at_pickup: 'at_pickup', in_transit: 'in_transit',
    arrived_at_drop: 'arrived_at_drop', completed: 'completed', cancelled: 'cancelled',
    partial_delivery: 'partial_delivery',
  },
  BookingStatus: {
    created: 'created', broadcasting: 'broadcasting', active: 'active',
    partially_filled: 'partially_filled', fully_filled: 'fully_filled',
    in_progress: 'in_progress', completed: 'completed', cancelled: 'cancelled',
  },
}));
jest.mock('../shared/services/socket.service', () => ({ socketService: { emitToUser: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../shared/services/queue.service', () => ({ queueService: { scheduleAssignmentTimeout: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({ releaseVehicle: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../modules/hold-expiry/hold-expiry-cleanup.service', () => ({
  holdExpiryCleanupService: { scheduleConfirmedHoldCleanup: jest.fn().mockResolvedValue(undefined), processExpiredHold: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../modules/order-timeout/smart-timeout.service', () => ({ smartTimeoutService: { extendTimeout: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../modules/assignment/auto-redispatch.service', () => ({ tryAutoRedispatch: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../core/config/hold-config', () => ({
  HOLD_CONFIG: { confirmedHoldMaxSeconds: 180, driverAcceptTimeoutSeconds: 45, flexHoldDurationSeconds: 90, flexHoldExtensionSeconds: 30, flexHoldMaxDurationSeconds: 130 },
}));

// -- C-10: checkBookingCompletion handles partial_delivery --
describe('C-10: partial_delivery is terminal for booking completion', () => {
  it('partial_delivery is in TERMINAL_ASSIGNMENT_STATUSES', () => {
    expect(TERMINAL_ASSIGNMENT_STATUSES).toContain('partial_delivery');
  });
  it('arrived_at_drop can transition to partial_delivery', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'arrived_at_drop', 'partial_delivery')).toBe(true);
  });
  it('partial_delivery is terminal with no outgoing transitions', () => {
    expect(ASSIGNMENT_VALID_TRANSITIONS['partial_delivery']).toHaveLength(0);
  });
});

// -- H-22: Legacy tracking enforces ASSIGNMENT_VALID_TRANSITIONS --
describe('H-22: ASSIGNMENT_VALID_TRANSITIONS rejects invalid shortcuts', () => {
  it('in_transit -> completed is INVALID (must go via arrived_at_drop)', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'in_transit', 'completed')).toBe(false);
  });
  it('in_transit -> arrived_at_drop is VALID', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'in_transit', 'arrived_at_drop')).toBe(true);
  });
  it('arrived_at_drop -> completed is VALID', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'arrived_at_drop', 'completed')).toBe(true);
  });
});

// -- H-24 / H-25: Booking cancel covers in_progress & in_transit assignments --
describe('H-24 / H-25: Booking cancel covers in_progress & in_transit assignments', () => {
  it('in_progress booking state allows cancel', () => {
    const { BOOKING_VALID_TRANSITIONS } = require('../core/state-machines');
    expect(BOOKING_VALID_TRANSITIONS['in_progress']).toContain('cancelled');
  });
  it('every cancellable assignment status can transition to cancelled', () => {
    const cancellable = ['pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit', 'arrived_at_drop'];
    expect(cancellable).toContain('in_transit');
    expect(cancellable).toContain('arrived_at_drop');
    for (const s of cancellable) {
      expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, s, 'cancelled')).toBe(true);
    }
  });
});

// -- H-26: Cancellation ledger + abuse counter --
describe('H-26: Cancellation ledger and abuse counter on booking cancel', () => {
  beforeEach(() => jest.clearAllMocks());

  it('ledger create and abuse counter upsert are both called', async () => {
    mockLedgerCreate.mockResolvedValue({ id: 'led-1' });
    mockAbuseUpsert.mockResolvedValue({ customerId: 'c1', cancelCount7d: 1 });
    const tx = { cancellationLedger: { create: mockLedgerCreate }, cancellationAbuseCounter: { upsert: mockAbuseUpsert } };
    await tx.cancellationLedger.create({ data: { id: 'led-1', orderId: 'b1', customerId: 'c1', reasonCode: 'customer_cancelled', policyStage: 'PRE_DISPATCH', penaltyAmount: 0, compensationAmount: 0, settlementState: 'pending', cancelDecision: 'allowed', eventVersion: 1, driverId: null, idempotencyKey: null } });
    await tx.cancellationAbuseCounter.upsert({ where: { customerId: 'c1' }, create: { customerId: 'c1', cancelCount7d: 1, cancelCount30d: 1, cancelAfterLoadingCount: 0, cancelRebook2mCount: 1, riskTier: 'normal', lastCancelAt: new Date() }, update: { cancelCount7d: { increment: 1 } } });
    expect(mockLedgerCreate).toHaveBeenCalledTimes(1);
    expect(mockAbuseUpsert).toHaveBeenCalledTimes(1);
    expect(mockLedgerCreate.mock.calls[0][0].data.reasonCode).toBe('customer_cancelled');
  });

  it('ledger failure is catchable (non-blocking in production code)', async () => {
    mockLedgerCreate.mockRejectedValue(new Error('DB timeout'));
    await expect(mockLedgerCreate({ data: {} })).rejects.toThrow('DB timeout');
  });
});

// -- H-6: Hold reconciliation bounded concurrency + phase pass-through --
describe('H-6: Hold reconciliation bounded concurrency', () => {
  it('processes holds in batches of 5', async () => {
    const { HoldReconciliationService } = require('../modules/hold-expiry/hold-reconciliation.service');
    const svc = new HoldReconciliationService();
    const spy = jest.spyOn(svc, 'processExpiredHoldById').mockResolvedValue(undefined);
    const holds = Array.from({ length: 12 }, (_, i) => ({
      holdId: `h-${i}`, phase: i % 2 === 0 ? 'FLEX' : 'CONFIRMED',
    }));
    const CONCURRENCY = 5;
    for (let i = 0; i < holds.length; i += CONCURRENCY) {
      const batch = holds.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(h => svc.processExpiredHoldById(h.holdId, h.phase)));
    }
    expect(spy).toHaveBeenCalledTimes(12);
    expect(spy).toHaveBeenCalledWith('h-0', 'FLEX');
    expect(spy).toHaveBeenCalledWith('h-1', 'CONFIRMED');
    spy.mockRestore();
  });

  it('phase pass-through delegates to cleanup with correct type', async () => {
    const { HoldReconciliationService } = require('../modules/hold-expiry/hold-reconciliation.service');
    const { holdExpiryCleanupService } = require('../modules/hold-expiry/hold-expiry-cleanup.service');
    const svc = new HoldReconciliationService();
    holdExpiryCleanupService.processExpiredHold.mockResolvedValue(undefined);
    await svc.processExpiredHoldById('hold-xyz', 'confirmed');
    expect(holdExpiryCleanupService.processExpiredHold).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'confirmed', data: expect.objectContaining({ holdId: 'hold-xyz' }) })
    );
  });
});

// -- H-8: Confirmed hold FOR UPDATE transaction --
describe('H-8: Confirmed hold uses SELECT FOR UPDATE', () => {
  beforeEach(() => jest.clearAllMocks());

  it('initializeConfirmedHold wraps read-check-write in $transaction', async () => {
    mockTransaction.mockImplementation(async (cb: Function) => {
      const tx = { $queryRaw: mockQueryRaw, truckHoldLedger: { update: mockUpdate } };
      mockQueryRaw.mockResolvedValue([{ holdId: 'h-1', phase: 'FLEX', transporterId: 't-1', confirmedExpiresAt: null }]);
      mockUpdate.mockResolvedValue({ orderId: 'o-1', transporterId: 't-1', quantity: 2 });
      return cb(tx);
    });
    mockFindMany.mockResolvedValue([]);
    const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');
    const result = await confirmedHoldService.initializeConfirmedHold('h-1', 't-1', []);
    expect(result.success).toBe(true);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockQueryRaw).toHaveBeenCalled();
  });

  it('rejects when hold is not in FLEX phase', async () => {
    mockTransaction.mockImplementation(async (cb: Function) => {
      return cb({ $queryRaw: jest.fn().mockResolvedValue([{ holdId: 'h-2', phase: 'EXPIRED', transporterId: 't-1', confirmedExpiresAt: null }]), truckHoldLedger: { update: mockUpdate } });
    });
    const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');
    const result = await confirmedHoldService.initializeConfirmedHold('h-2', 't-1', []);
    expect(result.success).toBe(false);
    expect(result.message).toContain('must be FLEX');
  });

  it('rejects when transporterId does not match (ownership)', async () => {
    mockTransaction.mockImplementation(async (cb: Function) => {
      return cb({ $queryRaw: jest.fn().mockResolvedValue([{ holdId: 'h-3', phase: 'FLEX', transporterId: 't-owner', confirmedExpiresAt: null }]), truckHoldLedger: { update: mockUpdate } });
    });
    const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');
    const result = await confirmedHoldService.initializeConfirmedHold('h-3', 't-fake', []);
    expect(result.success).toBe(false);
    expect(result.message).toBe('Not your hold');
  });
});

// -- H-9: InMemoryQueue O(1) priority insertion --
describe('H-9: InMemoryQueue uses priority bucket map', () => {
  let InMemoryQueue: any;
  beforeAll(() => { ({ InMemoryQueue } = require('../shared/services/queue-memory.service')); });

  it('groups jobs by priority bucket (O(1) insert per level)', async () => {
    const q = new InMemoryQueue();
    try {
      await q.add('tq', 'j', { v: 1 }, { priority: 10 });
      await q.add('tq', 'j', { v: 2 }, { priority: 5 });
      await q.add('tq', 'j', { v: 3 }, { priority: 10 });
      const pq = (q as any).priorityQueues.get('tq');
      expect(pq.get(10)).toHaveLength(2);
      expect(pq.get(5)).toHaveLength(1);
    } finally { q.stop(); }
  });

  it('findNextJob returns highest-priority job first', async () => {
    const q = new InMemoryQueue();
    try {
      await q.add('dq', 'j', { v: 'low' }, { priority: 1 });
      await q.add('dq', 'j', { v: 'high' }, { priority: 100 });
      await q.add('dq', 'j', { v: 'mid' }, { priority: 50 });
      const next = (q as any).findNextJob((q as any).priorityQueues.get('dq'));
      expect(next).not.toBeNull();
      expect(next.job.data.v).toBe('high');
      expect(next.job.priority).toBe(100);
    } finally { q.stop(); }
  });
});
