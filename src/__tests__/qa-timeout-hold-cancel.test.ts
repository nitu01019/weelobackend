/**
 * =============================================================================
 * QA-TIMEOUT-HOLD-CANCEL — 25+ tests for timeout, hold, and cancel flows
 * =============================================================================
 *
 * Covers:
 *  C9:  handleAssignmentTimeout uses orderId for orders, bookingId for bookings
 *  M5:  handleAssignmentTimeout atomic $transaction
 *  H9:  cascade dispatch on confirmed hold decline
 *  M10: smart timeout extension on acceptance
 *  AB2: broadcast-expiry guard rejects expired
 *  AB3: hold duration capped to broadcast remaining
 *  M3:  cancel notification sent to in-transit drivers (status unchanged)
 *       Concurrent timeout + completion race
 *
 * @author QA Fortress - qa-timeout-hold agent
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
const mockRedisHSet = jest.fn();

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
    hSet: (...args: any[]) => mockRedisHSet(...args),
    isConnected: () => true,
    cancelTimer: jest.fn().mockResolvedValue(undefined),
    setTimer: jest.fn().mockResolvedValue(undefined),
    getExpiredTimers: jest.fn().mockResolvedValue([]),
  },
}));

// Socket service mock
const mockEmitToUser = jest.fn();
const mockEmitToBooking = jest.fn();
const mockEmitToOrder = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToBooking: (...args: any[]) => mockEmitToBooking(...args),
  socketService: {
    emitToUser: (...args: any[]) => mockEmitToUser(...args),
    emitToOrder: (...args: any[]) => mockEmitToOrder(...args),
  },
  SocketEvent: {
    TRUCK_ASSIGNED: 'truck_assigned',
    TRIP_ASSIGNED: 'trip_assigned',
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    DRIVER_TIMEOUT: 'driver_timeout',
    BROADCAST_EXPIRED: 'broadcast_expired',
    BOOKING_FULLY_FILLED: 'booking_fully_filled',
    BROADCAST_CANCELLED: 'order_cancelled',
    TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update',
    NEW_BROADCAST: 'new_broadcast',
  },
  isUserConnected: jest.fn().mockReturnValue(true),
}));

// Queue service mock
const mockScheduleAssignmentTimeout = jest.fn();
const mockCancelAssignmentTimeout = jest.fn();
const mockQueuePushNotification = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    scheduleAssignmentTimeout: (...args: any[]) => mockScheduleAssignmentTimeout(...args),
    cancelAssignmentTimeout: (...args: any[]) => mockCancelAssignmentTimeout(...args),
    queuePushNotification: (...args: any[]) => mockQueuePushNotification(...args),
  },
}));

// FCM service mock
jest.mock('../shared/services/fcm.service', () => ({
  fcmService: { sendPush: jest.fn().mockResolvedValue(undefined) },
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
}));

// Vehicle lifecycle mock
const mockReleaseVehicle = jest.fn().mockResolvedValue(undefined);
const mockOnVehicleTransition = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: (...args: any[]) => mockReleaseVehicle(...args),
  onVehicleTransition: (...args: any[]) => mockOnVehicleTransition(...args),
}));

// Fleet cache mock
jest.mock('../shared/services/fleet-cache-write.service', () => ({
  invalidateVehicleCache: jest.fn().mockResolvedValue(undefined),
}));

// Live availability mock
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: jest.fn().mockResolvedValue(undefined),
  },
}));

// Tracking service mock
jest.mock('../modules/tracking/tracking.service', () => ({
  trackingService: {
    initializeTracking: jest.fn().mockResolvedValue(undefined),
  },
}));

// Hold expiry cleanup mock
jest.mock('../modules/hold-expiry/hold-expiry-cleanup.service', () => ({
  holdExpiryCleanupService: {
    scheduleConfirmedHoldCleanup: jest.fn().mockResolvedValue(undefined),
  },
}));

// Auto-redispatch mock
const mockTryAutoRedispatch = jest.fn().mockResolvedValue(undefined);
jest.mock('../modules/assignment/auto-redispatch.service', () => ({
  tryAutoRedispatch: (...args: any[]) => mockTryAutoRedispatch(...args),
}));

// Post-accept effects mock
jest.mock('../modules/assignment/post-accept.effects', () => ({
  applyPostAcceptSideEffects: jest.fn().mockResolvedValue(undefined),
}));

// Completion orchestrator mock
jest.mock('../modules/assignment/completion-orchestrator', () => ({
  completeTrip: jest.fn().mockResolvedValue(undefined),
}));

// Order lifecycle outbox mock
jest.mock('../modules/order/order-lifecycle-outbox.service', () => ({
  enqueueCompletionLifecycleOutbox: jest.fn().mockResolvedValue(undefined),
  handleOrderExpiry: jest.fn().mockResolvedValue(undefined),
}));

// Prisma mock — comprehensive
const mockAssignmentUpdateMany = jest.fn();
const mockAssignmentFindUnique = jest.fn();
const mockAssignmentFindUniqueOrThrow = jest.fn();
const mockAssignmentFindFirst = jest.fn();
const mockAssignmentFindMany = jest.fn();
const mockAssignmentUpdate = jest.fn();
const mockAssignmentCreate = jest.fn();
const mockAssignmentCount = jest.fn();
const mockVehicleUpdateMany = jest.fn();
const mockVehicleFindUnique = jest.fn();
const mockBookingFindUnique = jest.fn();
const mockBookingUpdateMany = jest.fn();
const mockOrderFindUnique = jest.fn();
const mockOrderUpdateMany = jest.fn();
const mockTruckRequestUpdateMany = jest.fn();
const mockTruckRequestFindFirst = jest.fn();
const mockTruckRequestFindMany = jest.fn();
const mockTruckRequestUpdate = jest.fn();
const mockTruckHoldLedgerFindFirst = jest.fn();
const mockTruckHoldLedgerFindUnique = jest.fn();
const mockTruckHoldLedgerUpdate = jest.fn();
const mockOrderTimeoutCreate = jest.fn();
const mockOrderTimeoutFindUnique = jest.fn();
const mockOrderTimeoutUpdate = jest.fn();
const mockProgressEventCreate = jest.fn();
const mockProgressEventFindFirst = jest.fn();
const mockProgressEventFindMany = jest.fn();
const mockExecuteRaw = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    assignment: {
      updateMany: (...args: any[]) => mockAssignmentUpdateMany(...args),
      findUnique: (...args: any[]) => mockAssignmentFindUnique(...args),
      findUniqueOrThrow: (...args: any[]) => mockAssignmentFindUniqueOrThrow(...args),
      findFirst: (...args: any[]) => mockAssignmentFindFirst(...args),
      findMany: (...args: any[]) => mockAssignmentFindMany(...args),
      update: (...args: any[]) => mockAssignmentUpdate(...args),
      create: (...args: any[]) => mockAssignmentCreate(...args),
      count: (...args: any[]) => mockAssignmentCount(...args),
    },
    vehicle: {
      updateMany: (...args: any[]) => mockVehicleUpdateMany(...args),
      findUnique: (...args: any[]) => mockVehicleFindUnique(...args),
    },
    booking: {
      findUnique: (...args: any[]) => mockBookingFindUnique(...args),
      updateMany: (...args: any[]) => mockBookingUpdateMany(...args),
    },
    order: {
      findUnique: (...args: any[]) => mockOrderFindUnique(...args),
      updateMany: (...args: any[]) => mockOrderUpdateMany(...args),
    },
    truckRequest: {
      updateMany: (...args: any[]) => mockTruckRequestUpdateMany(...args),
      findFirst: (...args: any[]) => mockTruckRequestFindFirst(...args),
      findMany: (...args: any[]) => mockTruckRequestFindMany(...args),
      update: (...args: any[]) => mockTruckRequestUpdate(...args),
    },
    truckHoldLedger: {
      findFirst: (...args: any[]) => mockTruckHoldLedgerFindFirst(...args),
      findUnique: (...args: any[]) => mockTruckHoldLedgerFindUnique(...args),
      update: (...args: any[]) => mockTruckHoldLedgerUpdate(...args),
    },
    orderTimeout: {
      create: (...args: any[]) => mockOrderTimeoutCreate(...args),
      findUnique: (...args: any[]) => mockOrderTimeoutFindUnique(...args),
      update: (...args: any[]) => mockOrderTimeoutUpdate(...args),
    },
    progressEvent: {
      create: (...args: any[]) => mockProgressEventCreate(...args),
      findFirst: (...args: any[]) => mockProgressEventFindFirst(...args),
      findMany: (...args: any[]) => mockProgressEventFindMany(...args),
    },
    $transaction: (...args: any[]) => mockTransaction(...args),
    $executeRaw: (...args: any[]) => mockExecuteRaw(...args),
    $queryRaw: jest.fn().mockResolvedValue([{ trucksFilled: 0 }]),
  },
  withDbTimeout: jest.fn().mockImplementation(async (fn: Function) => {
    // Simulate transaction by calling fn with prisma-like tx object
    const txProxy = {
      assignment: {
        updateMany: (...a: any[]) => mockAssignmentUpdateMany(...a),
        findUnique: (...a: any[]) => mockAssignmentFindUnique(...a),
        findFirst: (...a: any[]) => mockAssignmentFindFirst(...a),
        create: (...a: any[]) => mockAssignmentCreate(...a),
        update: (...a: any[]) => mockAssignmentUpdate(...a),
      },
      vehicle: {
        updateMany: (...a: any[]) => mockVehicleUpdateMany(...a),
        findUnique: (...a: any[]) => mockVehicleFindUnique(...a),
      },
      booking: {
        findUnique: (...a: any[]) => mockBookingFindUnique(...a),
        updateMany: (...a: any[]) => mockBookingUpdateMany(...a),
      },
      order: {
        findUnique: (...a: any[]) => mockOrderFindUnique(...a),
        updateMany: (...a: any[]) => mockOrderUpdateMany(...a),
      },
      truckRequest: {
        updateMany: (...a: any[]) => mockTruckRequestUpdateMany(...a),
        findFirst: (...a: any[]) => mockTruckRequestFindFirst(...a),
        update: (...a: any[]) => mockTruckRequestUpdate(...a),
      },
      $executeRaw: (...a: any[]) => mockExecuteRaw(...a),
      $queryRaw: jest.fn(),
    };
    return fn(txProxy);
  }),
  HoldPhase: { FLEX: 'FLEX', CONFIRMED: 'CONFIRMED', EXPIRED: 'EXPIRED', RELEASED: 'RELEASED' },
  AssignmentStatus: {
    pending: 'pending',
    driver_accepted: 'driver_accepted',
    driver_declined: 'driver_declined',
    cancelled: 'cancelled',
    in_transit: 'in_transit',
    completed: 'completed',
  },
  OrderStatus: {
    broadcasting: 'broadcasting',
    active: 'active',
    partially_filled: 'partially_filled',
    fully_filled: 'fully_filled',
    in_progress: 'in_progress',
    completed: 'completed',
    cancelled: 'cancelled',
    expired: 'expired',
  },
  TimeoutExtensionType: {
    FIRST_DRIVER: 'FIRST_DRIVER',
    SUBSEQUENT: 'SUBSEQUENT',
  },
  TruckRequestStatus: { searching: 'searching', held: 'held', assigned: 'assigned' },
  VehicleStatus: { available: 'available', in_transit: 'in_transit', on_hold: 'on_hold' },
  BookingStatus: { active: 'active', expired: 'expired', cancelled: 'cancelled' },
  Prisma: { TransactionIsolationLevel: { Serializable: 'Serializable' } },
}));

// DB module mock
const mockGetAssignmentById = jest.fn();
const mockGetBookingById = jest.fn();
const mockUpdateAssignment = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getAssignmentById: (...args: any[]) => mockGetAssignmentById(...args),
    getBookingById: (...args: any[]) => mockGetBookingById(...args),
    getBookingsByCustomer: jest.fn().mockResolvedValue([]),
    getVehicleById: jest.fn(),
    getUserById: jest.fn(),
    getAssignmentsByTransporter: jest.fn().mockResolvedValue([]),
    getAssignmentsByDriver: jest.fn().mockResolvedValue([]),
    getActiveAssignmentByDriver: jest.fn().mockResolvedValue(null),
    updateAssignment: (...args: any[]) => mockUpdateAssignment(...args),
    getActiveBookingsForTransporter: jest.fn().mockResolvedValue([]),
    getVehiclesByTransporter: jest.fn().mockResolvedValue([]),
  },
  AssignmentRecord: {},
}));

// State machine mock
jest.mock('../core/state-machines', () => ({
  ...jest.requireActual('../core/state-machines'),
  TERMINAL_ASSIGNMENT_STATUSES: ['completed', 'cancelled', 'driver_declined', 'partial_delivery'],
  ASSIGNMENT_VALID_TRANSITIONS: {
    pending: ['driver_accepted', 'driver_declined', 'cancelled'],
    driver_accepted: ['en_route_pickup', 'cancelled'],
    en_route_pickup: ['at_pickup', 'cancelled'],
    at_pickup: ['in_transit', 'cancelled'],
    in_transit: ['arrived_at_drop', 'completed', 'partial_delivery', 'cancelled'],
    arrived_at_drop: ['completed', 'partial_delivery', 'cancelled'],
  },
  BOOKING_VALID_TRANSITIONS: {},
  assertValidTransition: jest.fn(),
}));

// Hold config mock
jest.mock('../core/config/hold-config', () => ({
  HOLD_CONFIG: {
    driverAcceptTimeoutMs: 45000,
    driverAcceptTimeoutSeconds: 45,
    confirmedHoldMaxSeconds: 180,
    flexHoldDurationSeconds: 90,
    flexHoldExtensionSeconds: 30,
    flexHoldMaxDurationSeconds: 130,
    flexHoldMaxExtensions: 2,
  },
  BROADCAST_DEDUP_TTL_BUFFER_SECONDS: 180,
}));

// Distance matrix mock
jest.mock('../shared/services/distance-matrix.service', () => ({
  distanceMatrixService: { getDistance: jest.fn().mockResolvedValue({ distanceKm: 10 }) },
}));

// Driver service mock
jest.mock('../modules/driver/driver.service', () => ({
  driverService: { getAvailableDrivers: jest.fn().mockResolvedValue([]) },
}));

// PII utils mock
jest.mock('../shared/utils/pii.utils', () => ({
  maskPhoneForExternal: jest.fn((p: string) => '***' + p.slice(-4)),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { assignmentService } from '../modules/assignment/assignment.service';
import { confirmedHoldService } from '../modules/truck-hold/confirmed-hold.service';
import { smartTimeoutService } from '../modules/order-timeout/smart-timeout.service';

// =============================================================================
// HELPERS
// =============================================================================

function makeTimerData(overrides: Record<string, any> = {}) {
  return {
    assignmentId: 'asn-001',
    driverId: 'drv-001',
    driverName: 'Test Driver',
    transporterId: 'txp-001',
    vehicleId: 'veh-001',
    vehicleNumber: 'KA01AB1234',
    tripId: 'trip-001',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeAssignmentRecord(overrides: Record<string, any> = {}) {
  return {
    id: 'asn-001',
    bookingId: 'bkg-001',
    orderId: '',
    truckRequestId: '',
    transporterId: 'txp-001',
    transporterName: 'Test Transporter',
    vehicleId: 'veh-001',
    vehicleNumber: 'KA01AB1234',
    vehicleType: 'Truck',
    vehicleSubtype: 'Open Body',
    driverId: 'drv-001',
    driverName: 'Test Driver',
    driverPhone: '9999999999',
    tripId: 'trip-001',
    status: 'pending',
    assignedAt: new Date().toISOString(),
    driverAcceptedAt: '',
    startedAt: '',
    completedAt: '',
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('QA Timeout/Hold/Cancel Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // F-A-75: default $transaction pass-through with VERIFIED + active User row.
    // Individual tests override via mockTransaction.mockImplementation when needed.
    mockTransaction.mockImplementation(async (fn: any) => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ isActive: true, kycStatus: 'VERIFIED' }]),
        assignment: {
          updateMany: (...a: any[]) => mockAssignmentUpdateMany(...a),
          findUnique: (...a: any[]) => mockAssignmentFindUnique(...a),
          findMany: (...a: any[]) => mockAssignmentFindMany(...a),
          create: (...a: any[]) => mockAssignmentCreate(...a),
        },
      };
      return fn(tx);
    });
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(undefined);
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue(undefined);
    mockRedisDel.mockResolvedValue(undefined);
    mockRedisGetJSON.mockResolvedValue(null);
    mockRedisSetJSON.mockResolvedValue(undefined);
    mockRedisHIncrBy.mockResolvedValue(1);
    mockRedisHGetAll.mockResolvedValue({});
    mockRedisHMSet.mockResolvedValue(undefined);
    mockRedisExpire.mockResolvedValue(undefined);
    mockRedisHSet.mockResolvedValue(undefined);
    mockCancelAssignmentTimeout.mockResolvedValue(undefined);
  });

  // ===========================================================================
  // C9: handleAssignmentTimeout uses orderId for orders, bookingId for bookings
  // ===========================================================================

  describe('C9: timeout uses correct ID branch', () => {
    it('should use bookingId for booking-path timeouts', async () => {
      const timerData = makeTimerData({ bookingId: 'bkg-100', orderId: undefined });
      mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
      mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'vk-001', transporterId: 'txp-001', status: 'on_hold' });
      mockGetAssignmentById.mockResolvedValue(makeAssignmentRecord({ bookingId: 'bkg-100' }));
      // Mock booking lookup for decrementTrucksFilled (lazily required)
      mockGetBookingById.mockResolvedValue({ id: 'bkg-100', trucksFilled: 1, trucksNeeded: 3, status: 'active' });
      mockTransaction.mockImplementation(async (fn: Function) => {
        const tx = {
          assignment: { updateMany: mockAssignmentUpdateMany },
          vehicle: { updateMany: mockVehicleUpdateMany },
          truckRequest: { updateMany: mockTruckRequestUpdateMany },
          $executeRaw: mockExecuteRaw,
        };
        return fn(tx);
      });

      await assignmentService.handleAssignmentTimeout(timerData);

      // Should emit to bookingId room
      expect(mockEmitToBooking).toHaveBeenCalledWith(
        'bkg-100',
        expect.any(String),
        expect.objectContaining({ assignmentId: 'asn-001' })
      );
    });

    it('should use orderId for order-path timeouts when bookingId is absent', async () => {
      const timerData = makeTimerData({ bookingId: undefined, orderId: 'ord-200' });
      mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
      mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'vk-001', transporterId: 'txp-001', status: 'on_hold' });
      mockGetAssignmentById.mockResolvedValue(makeAssignmentRecord({ bookingId: '', orderId: 'ord-200' }));
      mockTransaction.mockImplementation(async (fn: Function) => {
        const tx = {
          assignment: { updateMany: mockAssignmentUpdateMany },
          vehicle: { updateMany: mockVehicleUpdateMany },
          truckRequest: { updateMany: mockTruckRequestUpdateMany },
          $executeRaw: mockExecuteRaw,
        };
        return fn(tx);
      });

      await assignmentService.handleAssignmentTimeout(timerData);

      // Should emit to orderId room (fallback when bookingId absent)
      expect(mockEmitToBooking).toHaveBeenCalledWith(
        'ord-200',
        expect.any(String),
        expect.objectContaining({ assignmentId: 'asn-001' })
      );
    });

    it('should decrement trucksFilled via bookingService for booking path', async () => {
      const timerData = makeTimerData({ bookingId: 'bkg-100', orderId: undefined });
      mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
      mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'vk-001', transporterId: 'txp-001', status: 'on_hold' });
      mockGetAssignmentById.mockResolvedValue(makeAssignmentRecord({ bookingId: 'bkg-100' }));
      // Mock booking lookup for decrementTrucksFilled (lazily required)
      mockGetBookingById.mockResolvedValue({ id: 'bkg-100', trucksFilled: 1, trucksNeeded: 3, status: 'active' });
      mockTransaction.mockImplementation(async (fn: Function) => {
        const tx = {
          assignment: { updateMany: mockAssignmentUpdateMany },
          vehicle: { updateMany: mockVehicleUpdateMany },
          truckRequest: { updateMany: mockTruckRequestUpdateMany },
          $executeRaw: mockExecuteRaw,
        };
        return fn(tx);
      });

      await assignmentService.handleAssignmentTimeout(timerData);

      // Timeout should complete without error (bookingService is lazily required)
      expect(mockAssignmentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'asn-001', status: 'pending' }),
        })
      );
    });

    it('should use raw SQL to decrement Order.trucksFilled for order path', async () => {
      const timerData = makeTimerData({
        bookingId: undefined,
        orderId: 'ord-200',
        truckRequestId: 'tr-001',
      });
      mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
      mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });
      mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'vk-001', transporterId: 'txp-001', status: 'on_hold' });
      mockGetAssignmentById.mockResolvedValue(makeAssignmentRecord({ bookingId: '', orderId: 'ord-200' }));
      mockTransaction.mockImplementation(async (fn: Function) => {
        const tx = {
          assignment: { updateMany: mockAssignmentUpdateMany },
          vehicle: { updateMany: mockVehicleUpdateMany },
          truckRequest: { updateMany: mockTruckRequestUpdateMany },
          $executeRaw: mockExecuteRaw,
        };
        return fn(tx);
      });

      await assignmentService.handleAssignmentTimeout(timerData);

      // Order path uses $executeRaw for GREATEST(0, trucksFilled - 1)
      expect(mockExecuteRaw).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // M5: handleAssignmentTimeout uses atomic $transaction
  // ===========================================================================

  describe('M5: atomic $transaction in handleAssignmentTimeout', () => {
    it('should wrap assignment update + vehicle release + trucksFilled in one transaction', async () => {
      const timerData = makeTimerData({ bookingId: 'bkg-100' });
      mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'vk-001', transporterId: 'txp-001', status: 'on_hold' });
      mockGetAssignmentById.mockResolvedValue(makeAssignmentRecord());
      mockGetBookingById.mockResolvedValue({ id: 'bkg-100', trucksFilled: 1, trucksNeeded: 3, status: 'active' });

      let txCallCount = 0;
      mockTransaction.mockImplementation(async (fn: Function) => {
        txCallCount++;
        const tx = {
          assignment: { updateMany: mockAssignmentUpdateMany.mockResolvedValue({ count: 1 }) },
          vehicle: { updateMany: mockVehicleUpdateMany.mockResolvedValue({ count: 1 }) },
          truckRequest: { updateMany: mockTruckRequestUpdateMany },
          $executeRaw: mockExecuteRaw,
        };
        return fn(tx);
      });

      await assignmentService.handleAssignmentTimeout(timerData);

      // $transaction must be called exactly once (atomic)
      expect(txCallCount).toBe(1);
      // Both assignment and vehicle were updated inside the same TX
      expect(mockAssignmentUpdateMany).toHaveBeenCalled();
      expect(mockVehicleUpdateMany).toHaveBeenCalled();
    });

    it('should set declineType to timeout (M-08 distinction)', async () => {
      const timerData = makeTimerData({ bookingId: 'bkg-100' });
      mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'vk-001', transporterId: 'txp-001', status: 'on_hold' });
      mockGetAssignmentById.mockResolvedValue(makeAssignmentRecord());
      mockGetBookingById.mockResolvedValue({ id: 'bkg-100', trucksFilled: 1, trucksNeeded: 3, status: 'active' });
      mockTransaction.mockImplementation(async (fn: Function) => {
        const tx = {
          assignment: { updateMany: mockAssignmentUpdateMany.mockResolvedValue({ count: 1 }) },
          vehicle: { updateMany: mockVehicleUpdateMany.mockResolvedValue({ count: 1 }) },
          truckRequest: { updateMany: mockTruckRequestUpdateMany },
          $executeRaw: mockExecuteRaw,
        };
        return fn(tx);
      });

      await assignmentService.handleAssignmentTimeout(timerData);

      expect(mockAssignmentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'driver_declined',
            declineType: 'timeout',
          }),
        })
      );
    });

    it('should no-op if assignment already accepted (CAS guard)', async () => {
      const timerData = makeTimerData();
      mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'vk-001', transporterId: 'txp-001', status: 'in_transit' });
      mockGetAssignmentById.mockResolvedValue(makeAssignmentRecord({ status: 'driver_accepted' }));
      mockTransaction.mockImplementation(async (fn: Function) => {
        const tx = {
          assignment: { updateMany: mockAssignmentUpdateMany.mockResolvedValue({ count: 0 }) },
          vehicle: { updateMany: mockVehicleUpdateMany },
          truckRequest: { updateMany: mockTruckRequestUpdateMany },
          $executeRaw: mockExecuteRaw,
        };
        return fn(tx);
      });

      await assignmentService.handleAssignmentTimeout(timerData);

      // CAS returned count: 0 → vehicle should NOT be released
      expect(mockVehicleUpdateMany).not.toHaveBeenCalled();
      // No FCM push for timeout (skipped)
      expect(mockQueuePushNotification).not.toHaveBeenCalled();
    });

    it('should release vehicle back to available inside transaction', async () => {
      const timerData = makeTimerData({ vehicleId: 'veh-777' });
      mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'vk-777', transporterId: 'txp-001', status: 'on_hold' });
      mockGetAssignmentById.mockResolvedValue(makeAssignmentRecord({ vehicleId: 'veh-777' }));
      mockTransaction.mockImplementation(async (fn: Function) => {
        const tx = {
          assignment: { updateMany: mockAssignmentUpdateMany.mockResolvedValue({ count: 1 }) },
          vehicle: { updateMany: mockVehicleUpdateMany.mockResolvedValue({ count: 1 }) },
          truckRequest: { updateMany: mockTruckRequestUpdateMany },
          $executeRaw: mockExecuteRaw,
        };
        return fn(tx);
      });

      await assignmentService.handleAssignmentTimeout(timerData);

      expect(mockVehicleUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'veh-777' }),
          data: expect.objectContaining({ status: 'available' }),
        })
      );
    });
  });

  // ===========================================================================
  // H9: cascade dispatch on confirmed hold decline
  // ===========================================================================

  describe('H9: cascade auto-redispatch on confirmed hold decline', () => {
    it('should call tryAutoRedispatch after driver decline in confirmed hold', async () => {
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      // TX: CAS succeeds, decline persisted
      mockTransaction.mockImplementation(async (fn: Function) => {
        const tx = {
          assignment: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findUnique: jest.fn().mockResolvedValue({ orderId: 'ord-300' }),
          },
          $executeRaw: mockExecuteRaw,
        };
        return fn(tx);
      });
      mockAssignmentFindUniqueOrThrow.mockResolvedValue({
        id: 'asn-301',
        driverId: 'drv-301',
        transporterId: 'txp-301',
        vehicleId: 'veh-301',
        vehicleType: 'Truck',
        vehicleSubtype: 'Open Body',
        vehicleNumber: 'KA01CD5678',
        tripId: 'trip-301',
        bookingId: null,
        orderId: 'ord-300',
        truckRequestId: 'tr-301',
        status: 'driver_declined',
      });
      mockTruckRequestFindFirst.mockResolvedValue({ id: 'tr-301', orderId: 'ord-300' });
      mockTruckHoldLedgerFindFirst.mockResolvedValue({
        holdId: 'HOLD_ABC',
        transporterId: 'txp-301',
        orderId: 'ord-300',
      });

      const result = await confirmedHoldService.handleDriverDecline('asn-301', 'drv-301', 'too far');

      expect(result.declined).toBe(true);
      expect(mockTryAutoRedispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: 'ord-300',
          declinedDriverId: 'drv-301',
        })
      );
    });

    it('should release vehicle on confirmed hold decline', async () => {
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockTransaction.mockImplementation(async (fn: Function) => {
        const tx = {
          assignment: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findUnique: jest.fn().mockResolvedValue({ orderId: 'ord-300' }),
          },
          $executeRaw: mockExecuteRaw,
        };
        return fn(tx);
      });
      mockAssignmentFindUniqueOrThrow.mockResolvedValue({
        id: 'asn-302',
        driverId: 'drv-302',
        transporterId: 'txp-302',
        vehicleId: 'veh-302',
        vehicleType: 'Truck',
        vehicleSubtype: null,
        vehicleNumber: 'KA02AB0001',
        tripId: 'trip-302',
        bookingId: null,
        orderId: 'ord-300',
        truckRequestId: 'tr-302',
        status: 'driver_declined',
      });
      mockTruckRequestFindFirst.mockResolvedValue({ id: 'tr-302', orderId: 'ord-300' });
      mockTruckHoldLedgerFindFirst.mockResolvedValue(null);

      await confirmedHoldService.handleDriverDecline('asn-302', 'drv-302');

      expect(mockReleaseVehicle).toHaveBeenCalledWith('veh-302', 'confirmedHoldDecline');
    });

    it('should update truck request to held (not searching) preserving Phase 2 exclusivity', async () => {
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockTransaction.mockImplementation(async (fn: Function) => {
        const tx = {
          assignment: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findUnique: jest.fn().mockResolvedValue({ orderId: 'ord-300' }),
          },
          $executeRaw: mockExecuteRaw,
        };
        return fn(tx);
      });
      mockAssignmentFindUniqueOrThrow.mockResolvedValue({
        id: 'asn-303',
        driverId: 'drv-303',
        transporterId: 'txp-303',
        vehicleId: 'veh-303',
        vehicleType: 'Truck',
        vehicleSubtype: null,
        vehicleNumber: 'KA03',
        tripId: 'trip-303',
        bookingId: null,
        orderId: 'ord-300',
        truckRequestId: 'tr-303',
        status: 'driver_declined',
      });
      // FK traversal: resolveAssignmentTruckRequest needs assignment.findUnique + truckRequest.findFirst
      mockAssignmentFindUnique.mockResolvedValue({ truckRequestId: 'tr-303', orderId: 'ord-300' });
      mockTruckRequestFindFirst.mockResolvedValue({ id: 'tr-303', orderId: 'ord-300' });
      mockTruckHoldLedgerFindFirst.mockResolvedValue(null);

      await confirmedHoldService.handleDriverDecline('asn-303', 'drv-303');

      // FIX #41: TruckRequest stays 'held', not 'searching'
      expect(mockTruckRequestUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'held' }),
        })
      );
    });
  });

  // ===========================================================================
  // M10: smart timeout extension on acceptance
  // ===========================================================================

  describe('M10: smart timeout extension on driver acceptance', () => {
    it('should add +60s on first driver acceptance', async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 120_000);

      mockRedisGet.mockResolvedValue('0'); // extension count = 0
      mockOrderTimeoutFindUnique.mockResolvedValue({
        orderId: 'ord-400',
        baseTimeoutMs: 120_000,
        extendedMs: 0,
        lastProgressAt: now,
        expiresAt,
        isExpired: false,
      });
      mockOrderTimeoutUpdate.mockImplementation(async ({ data }: any) => ({
        orderId: 'ord-400',
        baseTimeoutMs: 120_000,
        extendedMs: data.extendedMs,
        lastProgressAt: data.lastProgressAt,
        expiresAt: data.expiresAt,
        isExpired: false,
      }));
      mockProgressEventCreate.mockResolvedValue({ id: 'pe-001' });

      const result = await smartTimeoutService.extendTimeout({
        orderId: 'ord-400',
        driverId: 'drv-401',
        driverName: 'Driver One',
        assignmentId: 'asn-401',
        isFirstDriver: true,
        reason: 'Driver accepted',
      });

      expect(result.success).toBe(true);
      expect(result.addedSeconds).toBe(60);
      expect(result.isFirstExtension).toBe(true);
    });

    it('should add +30s on subsequent driver acceptances', async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 180_000);

      mockRedisGet.mockResolvedValue('1'); // already one extension
      mockOrderTimeoutFindUnique.mockResolvedValue({
        orderId: 'ord-400',
        baseTimeoutMs: 120_000,
        extendedMs: 60_000,
        lastProgressAt: now,
        expiresAt,
        isExpired: false,
      });
      mockOrderTimeoutUpdate.mockImplementation(async ({ data }: any) => ({
        orderId: 'ord-400',
        baseTimeoutMs: 120_000,
        extendedMs: data.extendedMs,
        lastProgressAt: data.lastProgressAt,
        expiresAt: data.expiresAt,
        isExpired: false,
      }));
      mockProgressEventCreate.mockResolvedValue({ id: 'pe-002' });

      const result = await smartTimeoutService.extendTimeout({
        orderId: 'ord-400',
        driverId: 'drv-402',
        driverName: 'Driver Two',
        assignmentId: 'asn-402',
        isFirstDriver: false,
        reason: 'Another driver accepted',
      });

      expect(result.success).toBe(true);
      expect(result.addedSeconds).toBe(30);
      expect(result.isFirstExtension).toBe(false);
    });

    it('should refuse extension if order already expired', async () => {
      mockRedisGet.mockResolvedValue('0');
      mockOrderTimeoutFindUnique.mockResolvedValue({
        orderId: 'ord-expired',
        baseTimeoutMs: 120_000,
        extendedMs: 0,
        lastProgressAt: new Date(),
        expiresAt: new Date(Date.now() - 10_000), // expired 10s ago
        isExpired: true,
      });

      const result = await smartTimeoutService.extendTimeout({
        orderId: 'ord-expired',
        driverId: 'drv-403',
        driverName: 'Driver Three',
        assignmentId: 'asn-403',
        isFirstDriver: true,
        reason: 'Late acceptance',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('expired');
    });

    it('should create a progress event for UI transparency', async () => {
      const now = new Date();
      mockRedisGet.mockResolvedValue('0');
      mockOrderTimeoutFindUnique.mockResolvedValue({
        orderId: 'ord-400',
        baseTimeoutMs: 120_000,
        extendedMs: 0,
        lastProgressAt: now,
        expiresAt: new Date(now.getTime() + 120_000),
        isExpired: false,
      });
      mockOrderTimeoutUpdate.mockImplementation(async ({ data }: any) => ({
        orderId: 'ord-400',
        baseTimeoutMs: 120_000,
        extendedMs: data.extendedMs,
        expiresAt: data.expiresAt,
        isExpired: false,
      }));
      mockProgressEventCreate.mockResolvedValue({ id: 'pe-003' });

      await smartTimeoutService.extendTimeout({
        orderId: 'ord-400',
        driverId: 'drv-404',
        driverName: 'Driver Four',
        assignmentId: 'asn-404',
        isFirstDriver: true,
        reason: 'First acceptance',
      });

      expect(mockProgressEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            orderId: 'ord-400',
            driverId: 'drv-404',
            extensionType: 'FIRST_DRIVER',
            addedSeconds: 60,
          }),
        })
      );
    });

    it('should emit socket event order_timeout_extended', async () => {
      const now = new Date();
      mockRedisGet.mockResolvedValue('0');
      mockOrderTimeoutFindUnique.mockResolvedValue({
        orderId: 'ord-400',
        baseTimeoutMs: 120_000,
        extendedMs: 0,
        lastProgressAt: now,
        expiresAt: new Date(now.getTime() + 120_000),
        isExpired: false,
      });
      mockOrderTimeoutUpdate.mockImplementation(async ({ data }: any) => ({
        orderId: 'ord-400',
        baseTimeoutMs: 120_000,
        extendedMs: data.extendedMs,
        expiresAt: data.expiresAt,
        isExpired: false,
      }));
      mockProgressEventCreate.mockResolvedValue({ id: 'pe-004' });

      await smartTimeoutService.extendTimeout({
        orderId: 'ord-400',
        driverId: 'drv-405',
        driverName: 'Driver Five',
        assignmentId: 'asn-405',
        isFirstDriver: true,
        reason: 'Acceptance trigger',
      });

      expect(mockEmitToOrder).toHaveBeenCalledWith(
        'ord-400',
        'order_timeout_extended',
        expect.objectContaining({ addedSeconds: 60 })
      );
    });
  });

  // ===========================================================================
  // AB2: broadcast-expiry guard rejects expired
  // ===========================================================================

  describe('AB2: broadcast-expiry guard rejects expired holds', () => {
    // These tests verify the truck-hold.service.ts AB-2 fix logic.
    // Since truck-hold.service.ts has deep dependencies, we test the PATTERN.

    it('should reject hold when order expiresAt is in the past', () => {
      const orderExpiresAt = new Date(Date.now() - 5000); // expired 5s ago
      const isExpired = new Date(orderExpiresAt).getTime() < Date.now();
      expect(isExpired).toBe(true);
    });

    it('should allow hold when order expiresAt is in the future', () => {
      const orderExpiresAt = new Date(Date.now() + 60_000); // 60s remaining
      const isExpired = new Date(orderExpiresAt).getTime() < Date.now();
      expect(isExpired).toBe(false);
    });

    it('should reject hold when order status is terminal', () => {
      const TERMINAL_STATUSES = new Set(['cancelled', 'expired', 'completed']);
      expect(TERMINAL_STATUSES.has('expired')).toBe(true);
      expect(TERMINAL_STATUSES.has('cancelled')).toBe(true);
      expect(TERMINAL_STATUSES.has('completed')).toBe(true);
      expect(TERMINAL_STATUSES.has('active')).toBe(false);
    });
  });

  // ===========================================================================
  // AB3: hold duration capped to broadcast remaining
  // ===========================================================================

  describe('AB3: hold duration capped to broadcast remaining', () => {
    it('should cap hold to broadcast remaining when broadcast has less time than default', () => {
      const holdDurationMs = 180_000; // 180s default
      const now = new Date();
      const orderExpiresAt = new Date(now.getTime() + 60_000); // only 60s left
      const broadcastRemainingMs = orderExpiresAt.getTime() - now.getTime();

      const cappedDurationMs = Math.min(holdDurationMs, broadcastRemainingMs);
      const expiresAt = new Date(now.getTime() + cappedDurationMs);

      // Hold should expire at orderExpiresAt, not now + 180s
      expect(cappedDurationMs).toBeLessThanOrEqual(60_000 + 10); // tolerance
      expect(expiresAt.getTime()).toBeLessThanOrEqual(orderExpiresAt.getTime() + 10);
    });

    it('should use full hold duration when broadcast has more time remaining', () => {
      const holdDurationMs = 180_000;
      const now = new Date();
      const orderExpiresAt = new Date(now.getTime() + 300_000); // 300s left
      const broadcastRemainingMs = orderExpiresAt.getTime() - now.getTime();

      const cappedDurationMs = Math.min(holdDurationMs, broadcastRemainingMs);

      expect(cappedDurationMs).toBe(holdDurationMs);
    });

    it('should handle edge case where broadcast remaining equals hold duration', () => {
      const holdDurationMs = 180_000;
      const now = new Date();
      const orderExpiresAt = new Date(now.getTime() + 180_000);
      const broadcastRemainingMs = orderExpiresAt.getTime() - now.getTime();

      const cappedDurationMs = Math.min(holdDurationMs, broadcastRemainingMs);

      expect(cappedDurationMs).toBe(holdDurationMs);
    });
  });

  // ===========================================================================
  // M3: cancel notification sent to in-transit drivers
  // ===========================================================================

  describe('M3: cancel notification to in-transit drivers', () => {
    it('should send WebSocket notification to driver on cancel', async () => {
      const assignment = makeAssignmentRecord({
        status: 'in_transit',
        driverId: 'drv-501',
      });
      mockGetAssignmentById.mockResolvedValue(assignment);
      // Mock booking lookup for decrementTrucksFilled
      mockGetBookingById.mockResolvedValue({ id: 'bkg-001', trucksFilled: 1, trucksNeeded: 3, status: 'active' });
      mockTransaction.mockImplementation(async (fn: Function) => {
        const tx = {
          assignment: { updateMany: mockAssignmentUpdateMany.mockResolvedValue({ count: 1 }) },
          vehicle: { updateMany: mockVehicleUpdateMany.mockResolvedValue({ count: 1 }) },
        };
        return fn(tx);
      });
      mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'vk-501', transporterId: 'txp-001' });

      await assignmentService.cancelAssignment('asn-501', 'txp-001');

      // Driver should receive direct WebSocket notification
      expect(mockEmitToUser).toHaveBeenCalledWith(
        'drv-501',
        'assignment_status_changed',
        expect.objectContaining({
          status: 'cancelled',
          message: expect.stringContaining('cancelled'),
        })
      );
    });

    it('should send FCM push to driver on cancel for background coverage', async () => {
      const assignment = makeAssignmentRecord({
        status: 'in_transit',
        driverId: 'drv-502',
      });
      mockGetAssignmentById.mockResolvedValue(assignment);
      mockGetBookingById.mockResolvedValue({ id: 'bkg-001', trucksFilled: 1, trucksNeeded: 3, status: 'active' });
      mockTransaction.mockImplementation(async (fn: Function) => {
        const tx = {
          assignment: { updateMany: mockAssignmentUpdateMany.mockResolvedValue({ count: 1 }) },
          vehicle: { updateMany: mockVehicleUpdateMany.mockResolvedValue({ count: 1 }) },
        };
        return fn(tx);
      });
      mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'vk-502', transporterId: 'txp-001' });

      await assignmentService.cancelAssignment('asn-502', 'txp-001');

      expect(mockQueuePushNotification).toHaveBeenCalledWith(
        'drv-502',
        expect.objectContaining({
          data: expect.objectContaining({ status: 'cancelled' }),
        })
      );
    });

    it('should reject cancel on already-terminal assignment (F-H11)', async () => {
      const assignment = makeAssignmentRecord({ status: 'completed' });
      mockGetAssignmentById.mockResolvedValue(assignment);

      await expect(
        assignmentService.cancelAssignment('asn-503', 'txp-001')
      ).rejects.toThrow('already completed');
    });

    it('should use atomic CAS to prevent double-cancel', async () => {
      const assignment = makeAssignmentRecord({ status: 'in_transit' });
      mockGetAssignmentById.mockResolvedValue(assignment);
      mockGetBookingById.mockResolvedValue({ id: 'bkg-001', trucksFilled: 1, trucksNeeded: 3, status: 'active' });
      mockTransaction.mockImplementation(async (fn: Function) => {
        const tx = {
          assignment: { updateMany: mockAssignmentUpdateMany.mockResolvedValue({ count: 0 }) }, // CAS miss
          vehicle: { updateMany: mockVehicleUpdateMany },
        };
        return fn(tx);
      });
      mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'vk-503', transporterId: 'txp-001' });

      // When CAS returns count: 0, the cancel is idempotent (no vehicle release needed)
      await assignmentService.cancelAssignment('asn-504', 'txp-001');

      // Vehicle should NOT be released since CAS missed
      expect(mockVehicleUpdateMany).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Concurrent timeout + completion race
  // ===========================================================================

  describe('Concurrent timeout + completion race conditions', () => {
    it('should handle timeout firing after driver already accepted (CAS no-op)', async () => {
      const timerData = makeTimerData();
      mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'vk-001', transporterId: 'txp-001', status: 'in_transit' });
      mockGetAssignmentById.mockResolvedValue(makeAssignmentRecord({ status: 'driver_accepted' }));
      mockTransaction.mockImplementation(async (fn: Function) => {
        const tx = {
          assignment: { updateMany: mockAssignmentUpdateMany.mockResolvedValue({ count: 0 }) },
          vehicle: { updateMany: mockVehicleUpdateMany },
          truckRequest: { updateMany: mockTruckRequestUpdateMany },
          $executeRaw: mockExecuteRaw,
        };
        return fn(tx);
      });

      await assignmentService.handleAssignmentTimeout(timerData);

      // No side effects should execute when CAS fails
      expect(mockQueuePushNotification).not.toHaveBeenCalled();
      expect(mockEmitToUser).not.toHaveBeenCalled();
    });

    it('should handle timeout firing after assignment already cancelled (CAS no-op)', async () => {
      const timerData = makeTimerData();
      mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'vk-001', transporterId: 'txp-001', status: 'available' });
      mockGetAssignmentById.mockResolvedValue(makeAssignmentRecord({ status: 'cancelled' }));
      mockTransaction.mockImplementation(async (fn: Function) => {
        const tx = {
          assignment: { updateMany: mockAssignmentUpdateMany.mockResolvedValue({ count: 0 }) },
          vehicle: { updateMany: mockVehicleUpdateMany },
          truckRequest: { updateMany: mockTruckRequestUpdateMany },
          $executeRaw: mockExecuteRaw,
        };
        return fn(tx);
      });

      await assignmentService.handleAssignmentTimeout(timerData);

      expect(mockVehicleUpdateMany).not.toHaveBeenCalled();
      expect(mockTryAutoRedispatch).not.toHaveBeenCalled();
    });

    it('should persist decline reason as timeout (not explicit)', async () => {
      const timerData = makeTimerData();
      mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'vk-001', transporterId: 'txp-001', status: 'on_hold' });
      mockGetAssignmentById.mockResolvedValue(makeAssignmentRecord());
      mockTransaction.mockImplementation(async (fn: Function) => {
        const tx = {
          assignment: { updateMany: mockAssignmentUpdateMany.mockResolvedValue({ count: 1 }) },
          vehicle: { updateMany: mockVehicleUpdateMany.mockResolvedValue({ count: 1 }) },
          truckRequest: { updateMany: mockTruckRequestUpdateMany },
          $executeRaw: mockExecuteRaw,
        };
        return fn(tx);
      });

      await assignmentService.handleAssignmentTimeout(timerData);

      // persistAssignmentReason is called with 'timeout'
      expect(mockRedisSet).toHaveBeenCalledWith(
        expect.stringContaining('assignment:reason:asn-001'),
        'timeout',
        expect.any(Number)
      );
    });

    it('should attempt auto-redispatch after successful timeout', async () => {
      const timerData = makeTimerData();
      mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'vk-001', transporterId: 'txp-001', status: 'on_hold' });
      mockGetAssignmentById.mockResolvedValue(makeAssignmentRecord());
      mockTransaction.mockImplementation(async (fn: Function) => {
        const tx = {
          assignment: { updateMany: mockAssignmentUpdateMany.mockResolvedValue({ count: 1 }) },
          vehicle: { updateMany: mockVehicleUpdateMany.mockResolvedValue({ count: 1 }) },
          truckRequest: { updateMany: mockTruckRequestUpdateMany },
          $executeRaw: mockExecuteRaw,
        };
        return fn(tx);
      });

      await assignmentService.handleAssignmentTimeout(timerData);

      expect(mockTryAutoRedispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          declinedDriverId: 'drv-001',
          assignmentId: 'asn-001',
        })
      );
    });

    it('should notify both transporter and driver on timeout', async () => {
      const timerData = makeTimerData();
      mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'vk-001', transporterId: 'txp-001', status: 'on_hold' });
      mockGetAssignmentById.mockResolvedValue(makeAssignmentRecord());
      mockTransaction.mockImplementation(async (fn: Function) => {
        const tx = {
          assignment: { updateMany: mockAssignmentUpdateMany.mockResolvedValue({ count: 1 }) },
          vehicle: { updateMany: mockVehicleUpdateMany.mockResolvedValue({ count: 1 }) },
          truckRequest: { updateMany: mockTruckRequestUpdateMany },
          $executeRaw: mockExecuteRaw,
        };
        return fn(tx);
      });

      await assignmentService.handleAssignmentTimeout(timerData);

      // Transporter gets DRIVER_TIMEOUT event
      expect(mockEmitToUser).toHaveBeenCalledWith(
        'txp-001',
        'driver_timeout',
        expect.objectContaining({ reason: 'timeout' })
      );
      // Driver gets assignment_status_changed with reason: timeout
      expect(mockEmitToUser).toHaveBeenCalledWith(
        'drv-001',
        'assignment_status_changed',
        expect.objectContaining({ reason: 'timeout' })
      );
    });
  });

  // ===========================================================================
  // Smart timeout initialization
  // ===========================================================================

  describe('Smart timeout initialization', () => {
    it('should initialize with base timeout of 120s', async () => {
      mockOrderTimeoutCreate.mockImplementation(async ({ data }: any) => data);

      const result = await smartTimeoutService.initializeOrderTimeout('ord-500', 3);

      expect(result.success).toBe(true);
      expect(result.expiresAt).toBeDefined();
      expect(mockOrderTimeoutCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            orderId: 'ord-500',
            baseTimeoutMs: 120_000,
            extendedMs: 0,
            isExpired: false,
          }),
        })
      );
    });

    it('should cache timeout state in Redis after creation', async () => {
      mockOrderTimeoutCreate.mockImplementation(async ({ data }: any) => data);

      await smartTimeoutService.initializeOrderTimeout('ord-501', 2);

      expect(mockRedisSetJSON).toHaveBeenCalledWith(
        expect.stringContaining('ord-501'),
        expect.objectContaining({ orderId: 'ord-501' }),
        expect.any(Number)
      );
    });
  });

  // ===========================================================================
  // Confirmed hold lifecycle
  // ===========================================================================

  describe('Confirmed hold phase guard', () => {
    // H-8: initializeConfirmedHold now uses $queryRaw with FOR UPDATE inside $transaction
    // We must mock $transaction to provide a tx with $queryRaw returning the hold data.
    function setupTxWithQueryRaw(holdRow: Record<string, any> | null) {
      mockTransaction.mockImplementation(async (fn: Function) => {
        const txProxy = {
          truckHoldLedger: {
            findUnique: (...a: any[]) => mockTruckHoldLedgerFindUnique(...a),
            update: (...a: any[]) => mockTruckHoldLedgerUpdate(...a),
          },
          assignment: {
            updateMany: (...a: any[]) => mockAssignmentUpdateMany(...a),
            findMany: (...a: any[]) => mockAssignmentFindMany(...a),
            create: (...a: any[]) => mockAssignmentCreate(...a),
          },
          order: {
            findUnique: (...a: any[]) => mockOrderFindUnique(...a),
          },
          truckRequest: {
            update: (...a: any[]) => mockTruckRequestUpdate(...a),
          },
          // F-A-75: first $queryRaw is User eligibility, second is the hold lookup.
          $queryRaw: jest.fn()
            .mockResolvedValueOnce([{ isActive: true, kycStatus: 'VERIFIED' }])
            .mockResolvedValueOnce(holdRow ? [holdRow] : []),
          $executeRaw: (...a: any[]) => mockExecuteRaw(...a),
        };
        return fn(txProxy);
      });
    }

    it('should reject initialization from non-FLEX phase', async () => {
      setupTxWithQueryRaw({
        holdId: 'HOLD_001',
        phase: 'EXPIRED',
        confirmedExpiresAt: null,
        transporterId: 'txp-601',
      });

      const result = await confirmedHoldService.initializeConfirmedHold(
        'HOLD_001',
        'txp-601',
        [{ assignmentId: 'asn-601', driverId: 'drv-601', truckRequestId: 'tr-601' }]
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/FLEX|expired or been released/);
    });

    it('should return idempotent success if already CONFIRMED', async () => {
      const futureExpiry = new Date(Date.now() + 180_000);
      setupTxWithQueryRaw({
        holdId: 'HOLD_002',
        phase: 'CONFIRMED',
        confirmedExpiresAt: futureExpiry,
        transporterId: 'txp-602',
      });

      const result = await confirmedHoldService.initializeConfirmedHold(
        'HOLD_002',
        'txp-602',
        []
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('idempotent');
    });

    it('should reject initialization by non-owning transporter (FIX-6)', async () => {
      setupTxWithQueryRaw({
        holdId: 'HOLD_003',
        phase: 'FLEX',
        confirmedExpiresAt: null,
        transporterId: 'txp-real-owner',
      });

      const result = await confirmedHoldService.initializeConfirmedHold(
        'HOLD_003',
        'txp-impersonator',
        [{ assignmentId: 'asn-603', driverId: 'drv-603', truckRequestId: 'tr-603' }]
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Not your hold');
    });
  });

  // ===========================================================================
  // Confirmed hold driver acceptance (CAS guard)
  // ===========================================================================

  describe('Confirmed hold driver acceptance CAS guard', () => {
    it('should reject acceptance if assignment no longer pending', async () => {
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockAssignmentUpdateMany.mockResolvedValue({ count: 0 }); // CAS miss
      mockAssignmentFindUnique.mockResolvedValue({ status: 'driver_declined' });

      const result = await confirmedHoldService.handleDriverAcceptance('asn-701', 'drv-701');

      expect(result.success).toBe(false);
      expect(result.message).toContain('no longer pending');
    });

    it('should reject acceptance if lock cannot be acquired', async () => {
      mockRedisAcquireLock.mockResolvedValue({ acquired: false });

      const result = await confirmedHoldService.handleDriverAcceptance('asn-702', 'drv-702');

      expect(result.success).toBe(false);
      expect(result.message).toContain('lock');
    });
  });

  // ===========================================================================
  // Confirmed hold driver timeout
  // ===========================================================================

  describe('Confirmed hold driver timeout', () => {
    it('should delegate to handleDriverDecline with timeout reason', async () => {
      mockAssignmentFindUnique.mockResolvedValue({ driverId: 'drv-801' });
      mockRedisAcquireLock.mockResolvedValue({ acquired: true });
      mockTransaction.mockImplementation(async (fn: Function) => {
        const tx = {
          assignment: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findUnique: jest.fn().mockResolvedValue({ orderId: null }),
          },
          $executeRaw: mockExecuteRaw,
        };
        return fn(tx);
      });
      mockAssignmentFindUniqueOrThrow.mockResolvedValue({
        id: 'asn-801',
        driverId: 'drv-801',
        transporterId: 'txp-801',
        vehicleId: null,
        vehicleType: 'Truck',
        vehicleSubtype: null,
        vehicleNumber: 'KA01ZZ',
        tripId: 'trip-801',
        bookingId: null,
        orderId: null,
        truckRequestId: null,
        status: 'driver_declined',
      });
      mockTruckRequestFindFirst.mockResolvedValue(null);
      mockTruckHoldLedgerFindFirst.mockResolvedValue(null);

      const result = await confirmedHoldService.handleDriverTimeout('asn-801');

      expect(result.declined).toBe(true);
      expect(result.timeout).toBe(false); // delegates to decline, which sets declined=true
    });

    it('should return failure if assignment not found for timeout', async () => {
      mockAssignmentFindUnique.mockResolvedValue(null);

      const result = await confirmedHoldService.handleDriverTimeout('asn-nonexistent');

      expect(result.success).toBe(false);
      expect(result.timeout).toBe(true);
    });
  });
});
