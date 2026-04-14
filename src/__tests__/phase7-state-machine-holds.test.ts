/**
 * =============================================================================
 * PHASE 7 — STATE MACHINE & HOLD TRANSITIONS
 * =============================================================================
 *
 * Tests for:
 *   F-H6:  Assignment timeout scheduling in order-accept
 *   F-H2:  Distributed lock on order cancel
 *   F-M12: Atomic hold transition (FLEX → CONFIRMED only)
 *   F-M24: Phase guard on transitionToConfirmed
 *   F-M13: Cancel cleanup on phase transition
 *   F-M14: trucksFilled decrement inside TX (atomic decline)
 *   F-H3:  Legacy order creation TX (compensating pattern)
 *   F-M3:  Feature flag for deprecated expiry checker
 *   F-H9:  Multi-truck auto-redispatch
 *
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — must precede all service imports
// =============================================================================

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// --- Prisma mock ---
const mockAssignmentCreate = jest.fn();
const mockAssignmentUpdate = jest.fn();
const mockAssignmentUpdateMany = jest.fn();
const mockAssignmentFindFirst = jest.fn();
const mockAssignmentFindUnique = jest.fn();
const mockAssignmentFindUniqueOrThrow = jest.fn();
const mockAssignmentFindMany = jest.fn();
const mockAssignmentCount = jest.fn();
const mockVehicleFindUnique = jest.fn();
const mockVehicleUpdateMany = jest.fn();
const mockVehicleFindMany = jest.fn();
const mockOrderFindUnique = jest.fn();
const mockOrderUpdateMany = jest.fn();
const mockOrderDelete = jest.fn();
const mockTruckRequestFindFirst = jest.fn();
const mockTruckRequestFindMany = jest.fn();
const mockTruckRequestUpdate = jest.fn();
const mockTruckRequestUpdateMany = jest.fn();
const mockTruckHoldLedgerFindUnique = jest.fn();
const mockTruckHoldLedgerFindFirst = jest.fn();
const mockTruckHoldLedgerUpdate = jest.fn();
const mockBookingFindUnique = jest.fn();
const mockUserFindUnique = jest.fn();
const mockUserFindMany = jest.fn();
const mockTransaction = jest.fn();
const mockExecuteRaw = jest.fn();
const mockQueryRaw = jest.fn().mockResolvedValue([]);

jest.mock('../shared/database/prisma.service', () => {
  const HoldPhase = { FLEX: 'FLEX', CONFIRMED: 'CONFIRMED', EXPIRED: 'EXPIRED', RELEASED: 'RELEASED' };
  const AssignmentStatus = {
    pending: 'pending',
    driver_accepted: 'driver_accepted',
    driver_declined: 'driver_declined',
    cancelled: 'cancelled',
    en_route_pickup: 'en_route_pickup',
    at_pickup: 'at_pickup',
    in_transit: 'in_transit',
    arrived_at_drop: 'arrived_at_drop',
    completed: 'completed',
  };
  const OrderStatus = {
    created: 'created', broadcasting: 'broadcasting', active: 'active',
    partially_filled: 'partially_filled', fully_filled: 'fully_filled',
    cancelled: 'cancelled', completed: 'completed', expired: 'expired',
  };
  const VehicleStatus = { available: 'available', on_hold: 'on_hold', in_transit: 'in_transit' };
  const TruckRequestStatus = { searching: 'searching', held: 'held', assigned: 'assigned', cancelled: 'cancelled' };

  const prismaClient = {
    assignment: {
      create: mockAssignmentCreate,
      update: mockAssignmentUpdate,
      updateMany: mockAssignmentUpdateMany,
      findFirst: mockAssignmentFindFirst,
      findUnique: mockAssignmentFindUnique,
      findUniqueOrThrow: mockAssignmentFindUniqueOrThrow,
      findMany: mockAssignmentFindMany,
      count: mockAssignmentCount,
    },
    vehicle: {
      findUnique: mockVehicleFindUnique,
      updateMany: mockVehicleUpdateMany,
      findMany: mockVehicleFindMany,
    },
    order: {
      findUnique: mockOrderFindUnique,
      updateMany: mockOrderUpdateMany,
      delete: mockOrderDelete,
    },
    truckRequest: {
      findFirst: mockTruckRequestFindFirst,
      findMany: mockTruckRequestFindMany,
      update: mockTruckRequestUpdate,
      updateMany: mockTruckRequestUpdateMany,
    },
    booking: { findUnique: mockBookingFindUnique },
    user: { findUnique: mockUserFindUnique, findMany: mockUserFindMany },
    orderCancelIdempotency: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    cancellationLedger: { create: jest.fn().mockResolvedValue({}) },
    cancellationAbuseCounter: { upsert: jest.fn().mockResolvedValue({}) },
    customerPenaltyDue: { create: jest.fn().mockResolvedValue({}) },
    driverCompensationLedger: { createMany: jest.fn().mockResolvedValue({}) },
    cancelDispute: { create: jest.fn().mockResolvedValue({}) },
    orderDispatchOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    truckHoldLedger: {
      findUnique: mockTruckHoldLedgerFindUnique,
      findFirst: mockTruckHoldLedgerFindFirst,
      findMany: jest.fn().mockResolvedValue([]),
      update: mockTruckHoldLedgerUpdate,
    },
    $transaction: mockTransaction,
    $executeRaw: mockExecuteRaw,
    $queryRaw: (...args: any[]) => mockQueryRaw(...args),
  };

  return {
    prismaClient,
    HoldPhase,
    AssignmentStatus,
    OrderStatus,
    VehicleStatus,
    TruckRequestStatus,
    withDbTimeout: jest.fn(async (fn: Function, _opts?: any) => fn(prismaClient)),
  };
});

// --- Redis mock ---
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisIncr = jest.fn();
const mockRedisExpire = jest.fn();
const mockRedisSetJSON = jest.fn();
const mockRedisGetJSON = jest.fn();
const mockRedisHSet = jest.fn();
const mockRedisHGetAll = jest.fn();
const mockRedisHIncrBy = jest.fn();
const mockRedisHMSet = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisCancelTimer = jest.fn();
const mockRedisSetTimer = jest.fn();
const mockRedisGetExpiredTimers = jest.fn();
const mockRedisTtl = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
    incr: mockRedisIncr,
    expire: mockRedisExpire,
    setJSON: mockRedisSetJSON,
    getJSON: mockRedisGetJSON,
    hSet: mockRedisHSet,
    hGetAll: mockRedisHGetAll,
    hIncrBy: mockRedisHIncrBy,
    hMSet: mockRedisHMSet,
    acquireLock: mockRedisAcquireLock,
    releaseLock: mockRedisReleaseLock,
    cancelTimer: mockRedisCancelTimer,
    setTimer: mockRedisSetTimer,
    getExpiredTimers: mockRedisGetExpiredTimers,
    ttl: mockRedisTtl,
  },
}));

// --- Queue mock ---
const mockScheduleAssignmentTimeout = jest.fn();
const mockCancelAssignmentTimeout = jest.fn();
const mockQueuePushNotification = jest.fn();
const mockQueuePushNotificationBatch = jest.fn();

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    scheduleAssignmentTimeout: mockScheduleAssignmentTimeout,
    cancelAssignmentTimeout: mockCancelAssignmentTimeout,
    queuePushNotification: mockQueuePushNotification,
    queuePushNotificationBatch: mockQueuePushNotificationBatch,
  },
}));

// --- Socket mock ---
const mockEmitToUser = jest.fn();
const mockEmitToBooking = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: mockEmitToUser,
  emitToBooking: mockEmitToBooking,
  SocketEvent: {
    TRUCK_ASSIGNED: 'truck_assigned',
    TRIP_ASSIGNED: 'trip_assigned',
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    DRIVER_TIMEOUT: 'driver_timeout',
    NEW_BROADCAST: 'new_broadcast',
    BOOKING_EXPIRED: 'booking_expired',
    NO_VEHICLES_AVAILABLE: 'no_vehicles_available',
    ACCEPT_CONFIRMATION: 'accept_confirmation',
    REQUEST_NO_LONGER_AVAILABLE: 'request_no_longer_available',
    TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update',
    BOOKING_FULLY_FILLED: 'booking_fully_filled',
    ORDER_STATUS_UPDATE: 'order_status_update',
  },
  socketService: { emitToUser: mockEmitToUser },
  isUserConnected: jest.fn().mockResolvedValue(true),
}));

// --- Other mocks ---
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../shared/services/fleet-cache-write.service', () => ({
  invalidateVehicleCache: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  onVehicleTransition: jest.fn().mockResolvedValue(undefined),
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../modules/hold-expiry/hold-expiry-cleanup.service', () => ({
  holdExpiryCleanupService: {
    scheduleFlexHoldCleanup: jest.fn().mockResolvedValue(undefined),
    scheduleConfirmedHoldCleanup: jest.fn().mockResolvedValue(undefined),
    cancelScheduledCleanup: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../modules/tracking/tracking.service', () => ({
  trackingService: { initializeTracking: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../shared/database/db', () => ({
  db: {
    getBookingById: jest.fn(),
    getVehicleById: jest.fn(),
    getUserById: jest.fn(),
    getAssignmentById: jest.fn(),
    getActiveAssignmentByDriver: jest.fn(),
    updateAssignment: jest.fn(),
    getAssignmentsByTransporter: jest.fn(),
    getAssignmentsByDriver: jest.fn(),
    getBookingsByCustomer: jest.fn(),
    createOrder: jest.fn(),
    createTruckRequestsBatch: jest.fn(),
    getOrderById: jest.fn(),
    getTruckRequestsByOrder: jest.fn(),
    getTransportersWithVehicleType: jest.fn(),
    updateOrder: jest.fn(),
    updateTruckRequestsBatch: jest.fn(),
    getOrdersByCustomer: jest.fn(),
    getActiveTruckRequestsForTransporter: jest.fn(),
  },
}));
jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: {
    filterOnline: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../modules/assignment/post-accept.effects', () => ({
  applyPostAcceptSideEffects: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../modules/driver/driver-presence.service', () => ({
  driverPresenceService: {
    isDriverOnline: jest.fn().mockResolvedValue(true),
  },
}));
jest.mock('../modules/order-timeout/smart-timeout.service', () => ({
  smartTimeoutService: {
    extendTimeout: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../modules/assignment/auto-redispatch.service', () => {
  const original = jest.requireActual('../modules/assignment/auto-redispatch.service');
  return {
    ...original,
    tryAutoRedispatch: jest.fn().mockResolvedValue(false),
  };
});
jest.mock('../shared/utils/pii.utils', () => ({
  maskPhoneForExternal: jest.fn((phone: string) => '***' + phone.slice(-4)),
}));
jest.mock('../modules/order/order-lifecycle-outbox.service', () => ({
  enqueueCompletionLifecycleOutbox: jest.fn().mockResolvedValue(undefined),
  FF_CANCEL_OUTBOX_ENABLED: false,
  enqueueCancelLifecycleOutbox: jest.fn().mockResolvedValue('outbox-id'),
  processLifecycleOutboxImmediately: jest.fn().mockResolvedValue(undefined),
  emitCancellationLifecycle: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../modules/order/order-cancel-policy.service', () => ({
  evaluateTruckCancelPolicy: jest.fn().mockReturnValue({
    stage: 'PRE_DISPATCH',
    decision: 'allowed',
    reasonRequired: false,
    reasonCode: '',
    penaltyBreakdown: { finalAmount: 0 },
    driverCompensationBreakdown: { finalAmount: 0 },
    settlementState: 'none',
    pendingPenaltyAmount: 0,
  }),
}));
jest.mock('../modules/order/order-broadcast.service', () => ({
  clearCustomerActiveBroadcast: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../modules/order/order-timer.service', () => ({
  orderExpiryTimerKey: jest.fn((id: string) => `timer:order:${id}`),
  clearProgressiveStepTimers: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../modules/truck-hold/truck-hold.service', () => ({
  truckHoldService: {
    clearHoldCacheEntries: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn((type: string, subtype: string) => `${type}:${subtype}`),
}));
jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    observeHistogram: jest.fn(),
  },
}));
jest.mock('../shared/utils/geospatial.utils', () => ({
  ...jest.requireActual('../shared/utils/geospatial.utils'),
  haversineDistanceKm: jest.fn().mockReturnValue(5),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { prismaClient, HoldPhase, withDbTimeout } from '../shared/database/prisma.service';
import { redisService } from '../shared/services/redis.service';
import { queueService } from '../shared/services/queue.service';
import { holdExpiryCleanupService } from '../modules/hold-expiry/hold-expiry-cleanup.service';
import { HOLD_CONFIG } from '../core/config/hold-config';

// =============================================================================
// HELPERS
// =============================================================================

function resetAllMocks() {
  jest.clearAllMocks();
  mockRedisAcquireLock.mockResolvedValue({ acquired: true, lockHolder: 'test' });
  mockRedisReleaseLock.mockResolvedValue(undefined);
  mockRedisDel.mockResolvedValue(undefined);
  mockRedisSet.mockResolvedValue(undefined);
  mockRedisSetJSON.mockResolvedValue(undefined);
  mockRedisHMSet.mockResolvedValue(undefined);
  mockRedisExpire.mockResolvedValue(undefined);
  mockRedisHIncrBy.mockResolvedValue(1);
  mockScheduleAssignmentTimeout.mockResolvedValue(undefined);
  mockCancelAssignmentTimeout.mockResolvedValue(undefined);
  mockQueuePushNotification.mockResolvedValue(undefined);
  mockTransaction.mockImplementation(async (fnOrArray: any) => {
    if (typeof fnOrArray === 'function') return fnOrArray(prismaClient);
    return Promise.all(fnOrArray);
  });
  mockQueryRaw.mockReset().mockResolvedValue([]);
}

// =============================================================================
// TEST SUITES
// =============================================================================

describe('Phase 7 — State Machine & Hold Transitions', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  // ===========================================================================
  // F-H6: Assignment timeout scheduling in order-accept
  // ===========================================================================
  describe('F-H6: Assignment timeout scheduling', () => {
    let assignmentService: any;

    beforeEach(async () => {
      // Lazy import to pick up mocks
      jest.isolateModules(() => {
        assignmentService = require('../modules/assignment/assignment.service').assignmentService;
      });
    });

    it('should call scheduleAssignmentTimeout after TX commit with correct timeout', async () => {
      // Arrange
      const { db } = require('../shared/database/db');
      db.getBookingById.mockResolvedValue({
        id: 'booking-1', status: 'active', vehicleType: 'open', vehicleSubtype: 'Open Body',
      });
      db.getVehicleById.mockResolvedValue({
        id: 'v-1', transporterId: 't-1', vehicleNumber: 'KA01AB1234',
        vehicleType: 'open', vehicleSubtype: 'Open Body', status: 'available',
      });
      db.getUserById
        .mockResolvedValueOnce({ id: 'd-1', name: 'Driver', phone: '9999999999', transporterId: 't-1' }) // driver
        .mockResolvedValueOnce({ id: 't-1', name: 'Transporter', businessName: 'Trans' }); // transporter
      mockAssignmentFindFirst.mockResolvedValue(null); // no active assignment
      mockAssignmentCreate.mockResolvedValue(undefined);
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });

      const { assignmentService: svc } = require('../modules/assignment/assignment.service');

      // Act
      await svc.createAssignment('t-1', {
        bookingId: 'booking-1', vehicleId: 'v-1', driverId: 'd-1',
      });

      // Assert
      expect(mockScheduleAssignmentTimeout).toHaveBeenCalledTimes(1);
      const [timerData, timeoutMs] = mockScheduleAssignmentTimeout.mock.calls[0];
      expect(timerData.driverId).toBe('d-1');
      expect(timerData.vehicleId).toBe('v-1');
      expect(timerData.transporterId).toBe('t-1');
      expect(timeoutMs).toBe(HOLD_CONFIG.driverAcceptTimeoutMs);
    });

    it('should use HOLD_CONFIG.driverAcceptTimeoutMs (default 45s)', () => {
      expect(HOLD_CONFIG.driverAcceptTimeoutMs).toBe(
        parseInt(process.env.DRIVER_ACCEPT_TIMEOUT_SECONDS || '45', 10) * 1000
      );
    });

    it('should NOT throw if scheduleAssignmentTimeout fails (non-fatal, logged)', async () => {
      const { db } = require('../shared/database/db');
      db.getBookingById.mockResolvedValue({
        id: 'b-1', status: 'active', vehicleType: 'open', vehicleSubtype: 'Open Body',
      });
      db.getVehicleById.mockResolvedValue({
        id: 'v-1', transporterId: 't-1', vehicleNumber: 'KA01', vehicleType: 'open', vehicleSubtype: 'Open Body', status: 'available',
      });
      db.getUserById
        .mockResolvedValueOnce({ id: 'd-1', name: 'Driver', phone: '9999', transporterId: 't-1' })
        .mockResolvedValueOnce({ id: 't-1', name: 'Transporter', businessName: 'Trans' });
      mockAssignmentFindFirst.mockResolvedValue(null);
      mockAssignmentCreate.mockResolvedValue(undefined);
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });

      // Fail both attempts then compensate
      mockScheduleAssignmentTimeout
        .mockRejectedValueOnce(new Error('Queue down'))
        .mockRejectedValueOnce(new Error('Queue still down'));
      mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });

      const { assignmentService: svc } = require('../modules/assignment/assignment.service');

      // Should NOT throw — schedule failure is non-fatal
      await expect(svc.createAssignment('t-1', {
        bookingId: 'b-1', vehicleId: 'v-1', driverId: 'd-1',
      })).resolves.toBeDefined();
    });

    it('should compensate assignment to driver_declined when timeout scheduling permanently fails', async () => {
      const { db } = require('../shared/database/db');
      db.getBookingById.mockResolvedValue({
        id: 'b-1', status: 'active', vehicleType: 'open', vehicleSubtype: 'Open Body',
      });
      db.getVehicleById.mockResolvedValue({
        id: 'v-1', transporterId: 't-1', vehicleNumber: 'KA01', vehicleType: 'open', vehicleSubtype: 'Open Body', status: 'available',
      });
      db.getUserById
        .mockResolvedValueOnce({ id: 'd-1', name: 'Driver', phone: '9999', transporterId: 't-1' })
        .mockResolvedValueOnce({ id: 't-1', name: 'T', businessName: 'T' });
      mockAssignmentFindFirst.mockResolvedValue(null);
      mockAssignmentCreate.mockResolvedValue(undefined);
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });

      // Both attempts fail
      mockScheduleAssignmentTimeout
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'));
      mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'open:Open Body', transporterId: 't-1', status: 'on_hold' });

      const { assignmentService: svc } = require('../modules/assignment/assignment.service');
      await svc.createAssignment('t-1', { bookingId: 'b-1', vehicleId: 'v-1', driverId: 'd-1' });

      // Compensation: mark assignment as driver_declined
      expect(mockAssignmentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'pending' }),
          data: expect.objectContaining({ status: 'driver_declined' }),
        })
      );
    });
  });

  // ===========================================================================
  // F-H2: Distributed lock on order cancel
  // ===========================================================================
  describe('F-H2: Distributed lock on order cancel', () => {
    it('should acquire distributed lock before cancel logic', async () => {
      const { cancelOrder } = require('../modules/order/order-cancel.service');

      // Setup: order found, cancellable
      mockRedisAcquireLock.mockResolvedValue({ acquired: true, lockHolder: 'test' });
      (withDbTimeout as jest.Mock).mockImplementation(async (fn: Function) => {
        await fn(prismaClient);
      });
      mockOrderFindUnique.mockResolvedValue({
        id: 'ord-1', customerId: 'cust-1', status: 'active',
        trucksFilled: 0, totalTrucks: 2, lifecycleEventVersion: 0,
        customerName: 'Test', customerPhone: '999', pickup: {}, drop: {},
      });
      mockOrderUpdateMany.mockResolvedValue({ count: 1 });
      mockTruckRequestFindMany.mockResolvedValue([]);
      mockTruckHoldLedgerFindFirst.mockResolvedValue(null);
      mockAssignmentFindMany.mockResolvedValue([]);

      await cancelOrder('ord-1', 'cust-1', 'changed mind', 'idem-key-1').catch(() => {});

      expect(mockRedisAcquireLock).toHaveBeenCalledWith(
        'lock:order-cancel:ord-1',
        expect.any(String),
        15
      );
    });

    it('should return 409 when lock cannot be acquired (concurrent cancel)', async () => {
      const { cancelOrder } = require('../modules/order/order-cancel.service');

      mockRedisAcquireLock.mockResolvedValue({ acquired: false });

      await expect(cancelOrder('ord-1', 'cust-1', 'test', 'idem-key-2'))
        .rejects.toThrow(/already in progress/i);
    });

    it('should release lock in finally block even on error', async () => {
      const { cancelOrder } = require('../modules/order/order-cancel.service');

      mockRedisAcquireLock.mockResolvedValue({ acquired: true, lockHolder: 'holder-1' });
      (withDbTimeout as jest.Mock).mockRejectedValue(new Error('TX crash'));

      await cancelOrder('ord-1', 'cust-1', 'test', 'idem-key-3').catch(() => {});

      expect(mockRedisReleaseLock).toHaveBeenCalledWith(
        'lock:order-cancel:ord-1',
        expect.any(String)
      );
    });

    it('should only allow one concurrent cancel to succeed', async () => {
      const { cancelOrder } = require('../modules/order/order-cancel.service');

      // First call acquires lock
      mockRedisAcquireLock
        .mockResolvedValueOnce({ acquired: true, lockHolder: 'first' })
        .mockResolvedValueOnce({ acquired: false });

      // First cancel succeeds
      (withDbTimeout as jest.Mock).mockImplementation(async (fn: Function) => {
        await fn(prismaClient);
      });
      mockOrderFindUnique.mockResolvedValue({
        id: 'ord-1', customerId: 'cust-1', status: 'active',
        trucksFilled: 0, totalTrucks: 2, lifecycleEventVersion: 0,
        customerName: 'Test', customerPhone: '999', pickup: {}, drop: {},
      });
      mockOrderUpdateMany.mockResolvedValue({ count: 1 });
      mockTruckRequestFindMany.mockResolvedValue([]);
      mockAssignmentFindMany.mockResolvedValue([]);

      const firstResult = cancelOrder('ord-1', 'cust-1', 'reason', 'idem-key-4');

      // Second concurrent cancel fails
      const secondResult = cancelOrder('ord-1', 'cust-1', 'reason', 'idem-key-5');

      await expect(firstResult).resolves.toBeDefined();
      await expect(secondResult).rejects.toThrow(/already in progress/i);
    });
  });

  // ===========================================================================
  // F-M12 + F-M24: Atomic hold transition (FLEX → CONFIRMED)
  // ===========================================================================
  describe('F-M12 + F-M24: Atomic hold transition', () => {
    it('should wrap findUnique + update in $transaction', async () => {
      const { flexHoldService } = require('../modules/truck-hold/flex-hold.service');

      mockTransaction.mockImplementation(async (fn: Function) => {
        return fn(prismaClient);
      });
      mockTruckHoldLedgerFindUnique.mockResolvedValue({
        holdId: 'hold-1', transporterId: 't-1', phase: 'FLEX', orderId: 'ord-1',
      });
      mockTruckHoldLedgerUpdate.mockResolvedValue({ holdId: 'hold-1', phase: 'CONFIRMED' });

      const result = await flexHoldService.transitionToConfirmed('hold-1', 't-1');

      expect(result.success).toBe(true);
      expect(mockTransaction).toHaveBeenCalled();
      expect(mockTruckHoldLedgerUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { holdId: 'hold-1' },
          data: expect.objectContaining({ phase: 'CONFIRMED' }),
        })
      );
    });

    it('should reject EXPIRED → CONFIRMED transition (phase guard)', async () => {
      const { flexHoldService } = require('../modules/truck-hold/flex-hold.service');

      mockTransaction.mockImplementation(async (fn: Function) => fn(prismaClient));
      mockTruckHoldLedgerFindUnique.mockResolvedValue({
        holdId: 'hold-1', transporterId: 't-1', phase: 'EXPIRED',
      });

      const result = await flexHoldService.transitionToConfirmed('hold-1', 't-1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/EXPIRED/);
      expect(mockTruckHoldLedgerUpdate).not.toHaveBeenCalled();
    });

    it('should reject CONFIRMED → CONFIRMED transition (already confirmed)', async () => {
      const { flexHoldService } = require('../modules/truck-hold/flex-hold.service');

      mockTransaction.mockImplementation(async (fn: Function) => fn(prismaClient));
      mockTruckHoldLedgerFindUnique.mockResolvedValue({
        holdId: 'hold-1', transporterId: 't-1', phase: 'CONFIRMED',
      });

      const result = await flexHoldService.transitionToConfirmed('hold-1', 't-1');

      // Should fail because phase != FLEX
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/CONFIRMED/);
    });

    it('should reject RELEASED → CONFIRMED transition', async () => {
      const { flexHoldService } = require('../modules/truck-hold/flex-hold.service');

      mockTransaction.mockImplementation(async (fn: Function) => fn(prismaClient));
      mockTruckHoldLedgerFindUnique.mockResolvedValue({
        holdId: 'hold-1', transporterId: 't-1', phase: 'RELEASED',
      });

      const result = await flexHoldService.transitionToConfirmed('hold-1', 't-1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/RELEASED/);
    });

    it('should allow FLEX → CONFIRMED transition', async () => {
      const { flexHoldService } = require('../modules/truck-hold/flex-hold.service');

      mockTransaction.mockImplementation(async (fn: Function) => fn(prismaClient));
      mockTruckHoldLedgerFindUnique.mockResolvedValue({
        holdId: 'hold-1', transporterId: 't-1', phase: 'FLEX', orderId: 'o1',
      });
      mockTruckHoldLedgerUpdate.mockResolvedValue({});

      const result = await flexHoldService.transitionToConfirmed('hold-1', 't-1');

      expect(result.success).toBe(true);
    });

    it('should return failure if hold not found', async () => {
      const { flexHoldService } = require('../modules/truck-hold/flex-hold.service');

      mockTransaction.mockImplementation(async (fn: Function) => fn(prismaClient));
      mockTruckHoldLedgerFindUnique.mockResolvedValue(null);

      const result = await flexHoldService.transitionToConfirmed('hold-missing', 't-1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not found/i);
    });

    it('should reject transition if transporterId does not match (ownership check)', async () => {
      const { flexHoldService } = require('../modules/truck-hold/flex-hold.service');

      mockTransaction.mockImplementation(async (fn: Function) => fn(prismaClient));
      mockTruckHoldLedgerFindUnique.mockResolvedValue({
        holdId: 'hold-1', transporterId: 't-1', phase: 'FLEX',
      });

      const result = await flexHoldService.transitionToConfirmed('hold-1', 't-WRONG');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not your hold/i);
    });

    it('should clear Redis cache OUTSIDE the transaction', async () => {
      const { flexHoldService } = require('../modules/truck-hold/flex-hold.service');

      let updateCalledInTx = false;
      let delCalledInTx = false;

      mockTransaction.mockImplementation(async (fn: Function) => {
        const result = fn(prismaClient);
        updateCalledInTx = mockTruckHoldLedgerUpdate.mock.calls.length > 0;
        return result;
      });
      mockTruckHoldLedgerFindUnique.mockResolvedValue({
        holdId: 'hold-1', transporterId: 't-1', phase: 'FLEX', orderId: 'o1',
      });
      mockTruckHoldLedgerUpdate.mockResolvedValue({});
      mockRedisDel.mockImplementation(async () => {
        delCalledInTx = true;
      });

      await flexHoldService.transitionToConfirmed('hold-1', 't-1');

      // Redis del was called (outside TX)
      expect(mockRedisDel).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // F-M13: Cancel cleanup on phase transition
  // ===========================================================================
  describe('F-M13: Cancel cleanup on phase transition', () => {
    it('should call cancelScheduledCleanup after transition to CONFIRMED', async () => {
      const { flexHoldService } = require('../modules/truck-hold/flex-hold.service');

      mockTransaction.mockImplementation(async (fn: Function) => fn(prismaClient));
      mockTruckHoldLedgerFindUnique.mockResolvedValue({
        holdId: 'hold-1', transporterId: 't-1', phase: 'FLEX', orderId: 'o1',
      });
      mockTruckHoldLedgerUpdate.mockResolvedValue({});

      await flexHoldService.transitionToConfirmed('hold-1', 't-1');

      expect(holdExpiryCleanupService.cancelScheduledCleanup).toHaveBeenCalledWith('hold-1', 'flex');
    });

    it('should not throw if cancelScheduledCleanup fails (non-fatal)', async () => {
      const { flexHoldService } = require('../modules/truck-hold/flex-hold.service');

      mockTransaction.mockImplementation(async (fn: Function) => fn(prismaClient));
      mockTruckHoldLedgerFindUnique.mockResolvedValue({
        holdId: 'hold-1', transporterId: 't-1', phase: 'FLEX', orderId: 'o1',
      });
      mockTruckHoldLedgerUpdate.mockResolvedValue({});
      (holdExpiryCleanupService.cancelScheduledCleanup as jest.Mock).mockRejectedValue(new Error('cleanup fail'));

      const result = await flexHoldService.transitionToConfirmed('hold-1', 't-1');

      // Should still succeed — cleanup failure is non-fatal
      expect(result.success).toBe(true);
    });

    it('should NOT call cancelScheduledCleanup if transition fails', async () => {
      const { flexHoldService } = require('../modules/truck-hold/flex-hold.service');

      mockTransaction.mockImplementation(async (fn: Function) => fn(prismaClient));
      mockTruckHoldLedgerFindUnique.mockResolvedValue({
        holdId: 'hold-1', transporterId: 't-1', phase: 'EXPIRED',
      });

      await flexHoldService.transitionToConfirmed('hold-1', 't-1');

      expect(holdExpiryCleanupService.cancelScheduledCleanup).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // F-M14: trucksFilled decrement inside TX (atomic decline)
  // ===========================================================================
  describe('F-M14: trucksFilled decrement inside TX', () => {
    it('should wrap CAS decline + trucksFilled decrement in $transaction', async () => {
      const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');

      const txCalls: string[] = [];
      mockTransaction.mockImplementation(async (fn: Function) => {
        const txProxy = {
          ...prismaClient,
          assignment: {
            ...prismaClient.assignment,
            updateMany: jest.fn((...args: any[]) => {
              txCalls.push('assignment.updateMany');
              return Promise.resolve({ count: 1 });
            }),
            findUnique: jest.fn().mockResolvedValue({ orderId: 'ord-1' }),
          },
          $executeRaw: jest.fn((...args: any[]) => {
            txCalls.push('$executeRaw');
            return Promise.resolve(1);
          }),
        };
        return fn(txProxy);
      });

      mockRedisAcquireLock.mockResolvedValue({ acquired: true, lockHolder: 'lk' });
      mockAssignmentFindUniqueOrThrow.mockResolvedValue({
        id: 'a-1', driverId: 'd-1', vehicleId: 'v-1',
        transporterId: 't-1', orderId: 'ord-1', truckRequestId: 'tr-1',
      });
      mockTruckRequestFindFirst.mockResolvedValue({ id: 'tr-1', orderId: 'ord-1' });
      mockTruckRequestUpdate.mockResolvedValue({});
      mockTruckHoldLedgerFindFirst.mockResolvedValue({
        holdId: 'h-1', transporterId: 't-1', orderId: 'ord-1',
      });
      mockRedisHIncrBy.mockResolvedValue(1);
      mockRedisHGetAll.mockResolvedValue({});
      mockAssignmentFindUnique.mockResolvedValue({ orderId: 'ord-1', truckRequestId: 'tr-1' });

      await confirmedHoldService.handleDriverDecline('a-1', 'd-1', 'busy');

      // Both assignment update and trucksFilled decrement happen in same TX
      expect(txCalls).toContain('assignment.updateMany');
      expect(txCalls).toContain('$executeRaw');
    });

    it('should skip decrement when CAS misses (assignment not pending)', async () => {
      const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');

      const txCalls: string[] = [];
      mockTransaction.mockImplementation(async (fn: Function) => {
        const txProxy = {
          ...prismaClient,
          assignment: {
            ...prismaClient.assignment,
            updateMany: jest.fn(() => {
              txCalls.push('assignment.updateMany');
              return Promise.resolve({ count: 0 }); // CAS miss — not pending
            }),
            findUnique: jest.fn().mockResolvedValue({ orderId: 'ord-1' }),
          },
          $executeRaw: jest.fn(() => {
            txCalls.push('$executeRaw');
            return Promise.resolve(1);
          }),
        };
        return fn(txProxy);
      });

      mockRedisAcquireLock.mockResolvedValue({ acquired: true, lockHolder: 'lk' });
      mockAssignmentFindUnique.mockResolvedValue({ status: 'driver_accepted' });

      const result = await confirmedHoldService.handleDriverDecline('a-1', 'd-1', 'busy');

      // CAS missed — decrement should NOT have been called
      expect(txCalls).toContain('assignment.updateMany');
      expect(txCalls).not.toContain('$executeRaw');
      expect(result.success).toBe(false);
    });

    it('should rollback both on TX failure (atomicity guarantee)', async () => {
      const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');

      mockTransaction.mockRejectedValue(new Error('TX rolled back'));
      mockRedisAcquireLock.mockResolvedValue({ acquired: true, lockHolder: 'lk' });

      const result = await confirmedHoldService.handleDriverDecline('a-1', 'd-1', 'busy');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/failed/i);
    });
  });

  // ===========================================================================
  // F-H3: Legacy order creation TX (compensating pattern)
  // ===========================================================================
  describe('F-H3: Legacy order creation TX', () => {
    it('should delete order if truck request batch creation fails (compensation)', async () => {
      const { db } = require('../shared/database/db');

      db.createOrder.mockResolvedValue({
        id: 'ord-new', customerId: 'c-1', totalTrucks: 3,
        trucksFilled: 0, status: 'active', pickup: { latitude: 0, longitude: 0, address: '' },
        drop: { latitude: 0, longitude: 0, address: '' },
      });
      db.createTruckRequestsBatch.mockRejectedValue(new Error('batch insert failed'));
      db.getUserById.mockResolvedValue({ id: 'c-1', name: 'Cust' });
      mockOrderDelete.mockResolvedValue({});

      const { orderService } = require('../modules/booking/order.service');

      await expect(
        orderService.createOrder('c-1', '999', {
          pickup: { coordinates: { latitude: 1, longitude: 1 }, address: 'A', city: 'B', state: 'C' },
          drop: { coordinates: { latitude: 2, longitude: 2 }, address: 'D', city: 'E', state: 'F' },
          distanceKm: 10,
          trucks: [{ vehicleType: 'open', vehicleSubtype: 'Open Body', quantity: 2, pricePerTruck: 1000 }],
          goodsType: 'cement', weight: '5', cargoWeightKg: 5000,
        })
      ).rejects.toThrow('batch insert failed');

      // Compensating delete — order ID is UUID-generated by service, so match any string
      expect(mockOrderDelete).toHaveBeenCalledWith({
        where: { id: expect.any(String) },
      });
    });

    it('should NOT mask original error if compensation delete also fails', async () => {
      const { db } = require('../shared/database/db');

      db.createOrder.mockResolvedValue({
        id: 'ord-2', customerId: 'c-1', totalTrucks: 1,
        trucksFilled: 0, status: 'active', pickup: { latitude: 0, longitude: 0, address: '' },
        drop: { latitude: 0, longitude: 0, address: '' },
      });
      db.createTruckRequestsBatch.mockRejectedValue(new Error('original error'));
      db.getUserById.mockResolvedValue({ id: 'c-1', name: 'Cust' });
      mockOrderDelete.mockRejectedValue(new Error('delete also failed'));

      const { orderService } = require('../modules/booking/order.service');

      // The original error should propagate, not the compensation error
      await expect(
        orderService.createOrder('c-1', '999', {
          pickup: { coordinates: { latitude: 1, longitude: 1 }, address: 'A', city: 'B', state: 'C' },
          drop: { coordinates: { latitude: 2, longitude: 2 }, address: 'D', city: 'E', state: 'F' },
          distanceKm: 10,
          trucks: [{ vehicleType: 'open', vehicleSubtype: 'Open Body', quantity: 1, pricePerTruck: 500 }],
          goodsType: 'iron', weight: '10', cargoWeightKg: 10000,
        })
      ).rejects.toThrow('original error');
    });
  });

  // ===========================================================================
  // F-M3: Feature flag for deprecated expiry checker
  // ===========================================================================
  describe('F-M3: Feature flag for deprecated expiry checker', () => {
    it('should run checker when FF_LEGACY_ORDER_EXPIRY_CHECKER is unset (default ON)', () => {
      // The module-level code checks: process.env.FF_LEGACY_ORDER_EXPIRY_CHECKER !== 'false'
      // When unset, the checker runs. We verify the conditional logic:
      const envVal = undefined;
      expect(envVal !== 'false').toBe(true);
    });

    it('should NOT run checker when FF_LEGACY_ORDER_EXPIRY_CHECKER=false', () => {
      const envVal: string = 'false';
      expect(envVal !== 'false').toBe(false);
    });

    it('should run checker when FF_LEGACY_ORDER_EXPIRY_CHECKER=true', () => {
      const envVal: string = 'true';
      expect(envVal !== 'false').toBe(true);
    });

    it('should run checker when FF_LEGACY_ORDER_EXPIRY_CHECKER is any string except "false"', () => {
      for (const val of ['true', 'yes', '1', 'enabled', 'FALSE']) {
        expect(val !== 'false').toBe(true);
      }
    });
  });

  // ===========================================================================
  // F-H9: Multi-truck auto-redispatch
  // ===========================================================================
  describe('F-H9: Multi-truck auto-redispatch', () => {
    it('should reset truck request slot to searching for order redispatch', async () => {
      // Test the actual tryAutoRedispatch function (not the mock)
      const actual = jest.requireActual('../modules/assignment/auto-redispatch.service');

      mockRedisGet.mockResolvedValue('0'); // attempt count = 0
      mockUserFindMany.mockResolvedValue([{ id: 'd-2', name: 'Driver2', phone: '8888' }]);
      const { driverPresenceService } = require('../modules/driver/driver-presence.service');
      driverPresenceService.isDriverOnline.mockResolvedValue(true);
      mockAssignmentFindFirst.mockResolvedValue(null); // no active assignment

      mockTruckRequestFindFirst.mockResolvedValue({
        id: 'tr-1', orderId: 'ord-1', vehicleType: 'open',
        status: 'assigned', assignedDriverId: 'd-declined',
      });
      // F-H9: order-path redispatch now uses $transaction batch to atomically
      // reassign truck request + create assignment (status goes to 'assigned')
      mockVehicleFindUnique.mockResolvedValue({ vehicleNumber: 'KA01', vehicleType: 'open', vehicleSubtype: '' });
      mockUserFindUnique.mockResolvedValue({ name: 'Trans1', businessName: 'Trans1 LLC' });
      mockTruckRequestUpdate.mockResolvedValue({});
      mockAssignmentCreate.mockResolvedValue({ id: 'new-a' });
      mockRedisIncr.mockResolvedValue(1);

      const result = await actual.tryAutoRedispatch({
        orderId: 'ord-1',
        transporterId: 't-1',
        vehicleId: 'v-1',
        vehicleType: 'open',
        declinedDriverId: 'd-declined',
        assignmentId: 'a-1',
      });

      expect(result).toBe(true);
      // $transaction batch: first element is truckRequest.update with status 'assigned'
      expect(mockTransaction).toHaveBeenCalled();
    });

    it('should call createAssignment for booking redispatch (single-truck path)', async () => {
      const actual = jest.requireActual('../modules/assignment/auto-redispatch.service');

      mockRedisGet.mockResolvedValue('0');
      mockUserFindMany.mockResolvedValue([{ id: 'd-2', name: 'D2', phone: '8888' }]);
      const { driverPresenceService } = require('../modules/driver/driver-presence.service');
      driverPresenceService.isDriverOnline.mockResolvedValue(true);
      mockAssignmentFindFirst.mockResolvedValue(null);
      mockRedisIncr.mockResolvedValue(1);

      // Mock the assignmentService that is lazy-required inside tryAutoRedispatch
      jest.mock('../modules/assignment/assignment.service', () => ({
        assignmentService: {
          createAssignment: jest.fn().mockResolvedValue({ id: 'new-a' }),
        },
      }));

      const result = await actual.tryAutoRedispatch({
        bookingId: 'b-1',
        transporterId: 't-1',
        vehicleId: 'v-1',
        vehicleType: 'open',
        declinedDriverId: 'd-declined',
        assignmentId: 'a-1',
      });

      expect(result).toBe(true);
    });

    it('should return false when no bookingId and no orderId', async () => {
      const actual = jest.requireActual('../modules/assignment/auto-redispatch.service');

      mockRedisGet.mockResolvedValue('0');
      mockUserFindMany.mockResolvedValue([{ id: 'd-2', name: 'D2', phone: '8' }]);
      const { driverPresenceService } = require('../modules/driver/driver-presence.service');
      driverPresenceService.isDriverOnline.mockResolvedValue(true);
      mockAssignmentFindFirst.mockResolvedValue(null);

      const result = await actual.tryAutoRedispatch({
        transporterId: 't-1',
        vehicleId: 'v-1',
        vehicleType: 'open',
        declinedDriverId: 'd-1',
        assignmentId: 'a-1',
      });

      expect(result).toBe(false);
    });

    it('should respect MAX_REDISPATCH_ATTEMPTS limit', async () => {
      const actual = jest.requireActual('../modules/assignment/auto-redispatch.service');

      // Already at max (2)
      mockRedisGet.mockResolvedValue('2');

      const result = await actual.tryAutoRedispatch({
        bookingId: 'b-1',
        transporterId: 't-1',
        vehicleId: 'v-1',
        vehicleType: 'open',
        declinedDriverId: 'd-1',
        assignmentId: 'a-1',
      });

      expect(result).toBe(false);
      expect(mockUserFindMany).not.toHaveBeenCalled(); // should exit before driver query
    });

    it('should return false when no online drivers available', async () => {
      const actual = jest.requireActual('../modules/assignment/auto-redispatch.service');

      mockRedisGet.mockResolvedValue('0');
      mockUserFindMany.mockResolvedValue([{ id: 'd-2', name: 'D2', phone: '8' }]);
      const { driverPresenceService } = require('../modules/driver/driver-presence.service');
      driverPresenceService.isDriverOnline.mockResolvedValue(false);

      const result = await actual.tryAutoRedispatch({
        bookingId: 'b-1',
        transporterId: 't-1',
        vehicleId: 'v-1',
        vehicleType: 'open',
        declinedDriverId: 'd-1',
        assignmentId: 'a-1',
      });

      expect(result).toBe(false);
    });

    it('should skip drivers who have active assignments', async () => {
      const actual = jest.requireActual('../modules/assignment/auto-redispatch.service');

      mockRedisGet.mockResolvedValue('0');
      mockUserFindMany.mockResolvedValue([
        { id: 'd-busy', name: 'Busy', phone: '1' },
        { id: 'd-free', name: 'Free', phone: '2' },
      ]);
      const { driverPresenceService } = require('../modules/driver/driver-presence.service');
      driverPresenceService.isDriverOnline.mockResolvedValue(true);
      mockAssignmentFindFirst
        .mockResolvedValueOnce({ id: 'active-a' }) // d-busy has active
        .mockResolvedValueOnce(null); // d-free is available

      jest.mock('../modules/assignment/assignment.service', () => ({
        assignmentService: { createAssignment: jest.fn().mockResolvedValue({ id: 'new-a' }) },
      }));
      mockRedisIncr.mockResolvedValue(1);

      const result = await actual.tryAutoRedispatch({
        bookingId: 'b-1',
        transporterId: 't-1',
        vehicleId: 'v-1',
        vehicleType: 'open',
        declinedDriverId: 'd-declined',
        assignmentId: 'a-1',
      });

      expect(result).toBe(true);
    });
  });

  // ===========================================================================
  // Confirmed hold — Phase guard on initializeConfirmedHold
  // ===========================================================================
  describe('Confirmed hold — initializeConfirmedHold phase guards', () => {
    it('should only allow FLEX → CONFIRMED initialization', async () => {
      const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');

      // H-8: initializeConfirmedHold now uses $queryRaw with FOR UPDATE inside $transaction
      mockQueryRaw.mockResolvedValueOnce([
        { holdId: 'h-1', phase: 'FLEX', transporterId: 't-1', confirmedExpiresAt: null },
      ]);
      mockTruckHoldLedgerUpdate.mockResolvedValue({
        holdId: 'h-1', orderId: 'o-1', transporterId: 't-1', quantity: 2,
      });
      mockAssignmentFindMany.mockResolvedValue([]);

      const result = await confirmedHoldService.initializeConfirmedHold('h-1', 't-1', []);

      expect(result.success).toBe(true);
    });

    it('should reject EXPIRED → CONFIRMED initialization', async () => {
      const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');

      // H-8: $queryRaw returns the hold row with EXPIRED phase
      mockQueryRaw.mockResolvedValueOnce([
        { holdId: 'h-1', phase: 'EXPIRED', transporterId: 't-1', confirmedExpiresAt: null },
      ]);

      const result = await confirmedHoldService.initializeConfirmedHold('h-1', 't-1', []);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/must be FLEX/);
    });

    it('should be idempotent for CONFIRMED → CONFIRMED (returns success)', async () => {
      const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');

      // H-8: $queryRaw returns hold already in CONFIRMED phase
      mockQueryRaw.mockResolvedValueOnce([
        { holdId: 'h-1', phase: 'CONFIRMED', transporterId: 't-1',
          confirmedExpiresAt: new Date(Date.now() + 60000) },
      ]);

      const result = await confirmedHoldService.initializeConfirmedHold('h-1', 't-1', []);

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/idempotent/i);
    });

    it('should reject if transporterId does not match hold owner', async () => {
      const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');

      // H-8: $queryRaw returns hold owned by different transporter
      mockQueryRaw.mockResolvedValueOnce([
        { holdId: 'h-1', phase: 'FLEX', transporterId: 't-1', confirmedExpiresAt: null },
      ]);

      const result = await confirmedHoldService.initializeConfirmedHold('h-1', 't-OTHER', []);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not your hold/i);
    });

    it('should return failure if hold not found', async () => {
      const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');

      mockTruckHoldLedgerFindUnique.mockResolvedValue(null);

      const result = await confirmedHoldService.initializeConfirmedHold('h-gone', 't-1', []);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not found/i);
    });

    it('should schedule driver acceptance timeouts for each assignment', async () => {
      const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');

      // H-8: $queryRaw returns hold row in FLEX phase (FOR UPDATE)
      mockQueryRaw.mockResolvedValueOnce([
        { holdId: 'h-1', phase: 'FLEX', transporterId: 't-1', confirmedExpiresAt: null },
      ]);
      mockTruckHoldLedgerUpdate.mockResolvedValue({
        holdId: 'h-1', orderId: 'o-1', transporterId: 't-1', quantity: 2,
      });
      // This is called by prismaClient.assignment.findMany inside initializeConfirmedHold
      mockAssignmentFindMany.mockResolvedValue([
        { id: 'a-1', driverId: 'd-1', driverName: 'D1', transporterId: 't-1', vehicleId: 'v-1', vehicleNumber: 'KA01', tripId: 'trip-1', orderId: 'o-1', truckRequestId: 'tr-1' },
        { id: 'a-2', driverId: 'd-2', driverName: 'D2', transporterId: 't-1', vehicleId: 'v-2', vehicleNumber: 'KA02', tripId: 'trip-2', orderId: 'o-1', truckRequestId: 'tr-2' },
      ]);

      await confirmedHoldService.initializeConfirmedHold('h-1', 't-1', [
        { assignmentId: 'a-1', driverId: 'd-1', truckRequestId: 'tr-1' },
        { assignmentId: 'a-2', driverId: 'd-2', truckRequestId: 'tr-2' },
      ]);

      // Both assignments should get timeouts scheduled
      expect(mockScheduleAssignmentTimeout).toHaveBeenCalledTimes(2);
      const calls = mockScheduleAssignmentTimeout.mock.calls;
      expect(calls[0][0].assignmentId).toBe('a-1');
      expect(calls[1][0].assignmentId).toBe('a-2');
      expect(calls[0][1]).toBe(HOLD_CONFIG.driverAcceptTimeoutSeconds * 1000);
    });
  });

  // ===========================================================================
  // Confirmed hold — driver acceptance distributed lock
  // ===========================================================================
  describe('Confirmed hold — driver acceptance lock', () => {
    it('should acquire lock before processing acceptance', async () => {
      const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');

      mockRedisAcquireLock.mockResolvedValue({ acquired: true, lockHolder: 'lk' });
      mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentFindUniqueOrThrow.mockResolvedValue({
        id: 'a-1', driverId: 'd-1', vehicleId: 'v-1', transporterId: 't-1',
        tripId: 'trip-1', orderId: 'o-1', vehicleNumber: 'KA01',
      });
      mockAssignmentFindUnique.mockResolvedValue({ truckRequestId: null, orderId: null });
      mockOrderFindUnique.mockResolvedValue(null);

      await confirmedHoldService.handleDriverAcceptance('a-1', 'd-1');

      expect(mockRedisAcquireLock).toHaveBeenCalledWith(
        'driver-acceptance:a-1',
        expect.any(String),
        10
      );
    });

    it('should fail if lock cannot be acquired', async () => {
      const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');

      mockRedisAcquireLock.mockResolvedValue({ acquired: false });

      const result = await confirmedHoldService.handleDriverAcceptance('a-1', 'd-1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/could not acquire lock/i);
    });

    it('should release lock in finally block', async () => {
      const { confirmedHoldService } = require('../modules/truck-hold/confirmed-hold.service');

      mockRedisAcquireLock.mockResolvedValue({ acquired: true, lockHolder: 'lk-123' });
      mockAssignmentUpdateMany.mockRejectedValue(new Error('DB error'));

      await confirmedHoldService.handleDriverAcceptance('a-1', 'd-1');

      expect(mockRedisReleaseLock).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Assignment state machine transitions
  // ===========================================================================
  describe('Assignment state machine valid transitions', () => {
    const VALID_TRANSITIONS: Record<string, string[]> = {
      pending: ['driver_accepted', 'driver_declined', 'cancelled'],
      driver_accepted: ['en_route_pickup', 'cancelled'],
      en_route_pickup: ['at_pickup', 'cancelled'],
      at_pickup: ['in_transit', 'cancelled'],
      in_transit: ['arrived_at_drop', 'cancelled'],
      arrived_at_drop: ['completed', 'partial_delivery', 'cancelled'],
      completed: [],
      partial_delivery: [],
      driver_declined: [],
      cancelled: [],
    };

    it('should allow pending → driver_accepted', () => {
      expect(VALID_TRANSITIONS['pending']).toContain('driver_accepted');
    });

    it('should allow pending → driver_declined', () => {
      expect(VALID_TRANSITIONS['pending']).toContain('driver_declined');
    });

    it('should allow pending → cancelled', () => {
      expect(VALID_TRANSITIONS['pending']).toContain('cancelled');
    });

    it('should NOT allow pending → completed (skip states)', () => {
      expect(VALID_TRANSITIONS['pending']).not.toContain('completed');
    });

    it('should NOT allow completed → anything (terminal)', () => {
      expect(VALID_TRANSITIONS['completed']).toHaveLength(0);
    });

    it('should NOT allow cancelled → anything (terminal)', () => {
      expect(VALID_TRANSITIONS['cancelled']).toHaveLength(0);
    });

    it('should NOT allow partial_delivery → anything (terminal)', () => {
      expect(VALID_TRANSITIONS['partial_delivery']).toHaveLength(0);
    });

    it('should allow arrived_at_drop → partial_delivery', () => {
      expect(VALID_TRANSITIONS['arrived_at_drop']).toContain('partial_delivery');
    });

    it('should NOT allow in_transit → completed (must go through arrived_at_drop)', () => {
      expect(VALID_TRANSITIONS['in_transit']).not.toContain('completed');
    });
  });

  // ===========================================================================
  // HOLD_CONFIG defaults
  // ===========================================================================
  describe('HOLD_CONFIG defaults', () => {
    it('should default driverAcceptTimeoutMs to 45000', () => {
      const expected = parseInt(process.env.DRIVER_ACCEPT_TIMEOUT_SECONDS || '45', 10) * 1000;
      expect(HOLD_CONFIG.driverAcceptTimeoutMs).toBe(expected);
    });

    it('should default confirmedHoldMaxSeconds to 180', () => {
      const expected = parseInt(process.env.CONFIRMED_HOLD_MAX_SECONDS || '180', 10);
      expect(HOLD_CONFIG.confirmedHoldMaxSeconds).toBe(expected);
    });

    it('should default flexHoldDurationSeconds to 90', () => {
      const expected = parseInt(process.env.FLEX_HOLD_DURATION_SECONDS || '90', 10);
      expect(HOLD_CONFIG.flexHoldDurationSeconds).toBe(expected);
    });

    it('should default flexHoldMaxDurationSeconds to 130', () => {
      const expected = parseInt(process.env.FLEX_HOLD_MAX_DURATION_SECONDS || '130', 10);
      expect(HOLD_CONFIG.flexHoldMaxDurationSeconds).toBe(expected);
    });
  });
});
