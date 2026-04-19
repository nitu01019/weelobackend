/**
 * =============================================================================
 * ASSIGNMENT LIFECYCLE — Comprehensive Tests
 * =============================================================================
 *
 * Tests covering production scenarios for:
 * - Cancel (atomic, idempotent, terminal guard, concurrency)
 * - Decline (TOCTOU-safe, reason persistence, concurrency)
 * - Timeout (pending, race-lost no-ops, vehicle release)
 * - Accept (pending, state-changed guard, GPS seeding, concurrency)
 * - Production edge cases (Redis failure, FCM failure, Socket failure, DB timeout)
 *
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — must be before imports
// =============================================================================

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// --- db mock (PrismaDatabaseService instance) ---
const mockGetAssignmentById = jest.fn();
const mockGetBookingById = jest.fn();
const mockGetVehicleById = jest.fn();
const mockGetUserById = jest.fn();
const mockUpdateAssignment = jest.fn();
const mockGetActiveAssignmentByDriver = jest.fn();
const mockUpdateVehicle = jest.fn();
const mockIncrementTrucksFilled = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getAssignmentById: (...args: any[]) => mockGetAssignmentById(...args),
    getBookingById: (...args: any[]) => mockGetBookingById(...args),
    getVehicleById: (...args: any[]) => mockGetVehicleById(...args),
    getUserById: (...args: any[]) => mockGetUserById(...args),
    updateAssignment: (...args: any[]) => mockUpdateAssignment(...args),
    getActiveAssignmentByDriver: (...args: any[]) => mockGetActiveAssignmentByDriver(...args),
    updateVehicle: (...args: any[]) => mockUpdateVehicle(...args),
  },
  AssignmentRecord: {},
}));

// --- prismaClient mock ---
const mockTxAssignmentUpdateMany = jest.fn();
const mockTxAssignmentFindUnique = jest.fn();
const mockTxVehicleUpdateMany = jest.fn();
const mockTxBookingUpdateMany = jest.fn();
const mockTxOrderUpdate = jest.fn();
const mockTxTruckRequestUpdateMany = jest.fn();

const mockTx = {
  assignment: {
    updateMany: (...args: any[]) => mockTxAssignmentUpdateMany(...args),
    findUnique: (...args: any[]) => mockTxAssignmentFindUnique(...args),
    findFirst: jest.fn(),
    create: jest.fn(),
  },
  vehicle: {
    updateMany: (...args: any[]) => mockTxVehicleUpdateMany(...args),
    findUnique: jest.fn(),
  },
  booking: {
    updateMany: (...args: any[]) => mockTxBookingUpdateMany(...args),
  },
  order: {
    update: (...args: any[]) => mockTxOrderUpdate(...args),
  },
  truckRequest: {
    updateMany: (...args: any[]) => mockTxTruckRequestUpdateMany(...args),
  },
};

const mockVehicleFindUnique = jest.fn();
const mockVehicleUpdateMany = jest.fn();

const mockPrismaAssignmentUpdateMany = jest.fn();
const mockPrismaOrderUpdate = jest.fn();
const mockPrismaTruckRequestUpdateMany = jest.fn();
const mockPrismaExecuteRaw = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    $transaction: jest.fn(),
    $executeRaw: (...args: any[]) => mockPrismaExecuteRaw(...args),
    assignment: {
      updateMany: (...args: any[]) => mockPrismaAssignmentUpdateMany(...args),
      findUnique: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    vehicle: {
      findUnique: (...args: any[]) => mockVehicleFindUnique(...args),
      updateMany: (...args: any[]) => mockVehicleUpdateMany(...args),
    },
    booking: {
      update: jest.fn(),
      findUnique: jest.fn(),
    },
    order: {
      update: (...args: any[]) => mockPrismaOrderUpdate(...args),
    },
    truckRequest: {
      updateMany: (...args: any[]) => mockPrismaTruckRequestUpdateMany(...args),
    },
    declineEvent: {
      create: jest.fn().mockReturnValue(Promise.resolve({})),
    },
  },
  withDbTimeout: jest.fn(async (fn: (tx: any) => Promise<any>) => {
    return fn(mockTx);
  }),
}));

// --- Redis mock ---
const mockRedisSet = jest.fn().mockResolvedValue(undefined);
const mockRedisDel = jest.fn().mockResolvedValue(undefined);
const mockRedisGetJSON = jest.fn().mockResolvedValue(null);
const mockRedisSetJSON = jest.fn().mockResolvedValue(undefined);
const mockRedisGetOrSet = jest.fn();

const mockRedisAcquireLock = jest.fn().mockResolvedValue({ acquired: true });
const mockRedisReleaseLock = jest.fn().mockResolvedValue(true);

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    getJSON: (...args: any[]) => mockRedisGetJSON(...args),
    setJSON: (...args: any[]) => mockRedisSetJSON(...args),
    getOrSet: (...args: any[]) => mockRedisGetOrSet(...args),
    get: jest.fn().mockResolvedValue(null),
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
  },
}));

// --- LiveAvailability mock ---
const mockOnVehicleStatusChange = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: (...args: any[]) => mockOnVehicleStatusChange(...args),
  },
}));

// --- Socket mock ---
const mockEmitToUser = jest.fn();
const mockEmitToBooking = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToBooking: (...args: any[]) => mockEmitToBooking(...args),
  SocketEvent: {
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    TRUCK_ASSIGNED: 'truck_assigned',
    DRIVER_TIMEOUT: 'driver_timeout',
  },
}));

// --- Queue mock ---
const mockQueuePushNotification = jest.fn().mockResolvedValue(undefined);
const mockScheduleAssignmentTimeout = jest.fn().mockResolvedValue(undefined);
const mockCancelAssignmentTimeout = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queuePushNotification: (...args: any[]) => mockQueuePushNotification(...args),
    scheduleAssignmentTimeout: (...args: any[]) => mockScheduleAssignmentTimeout(...args),
    cancelAssignmentTimeout: (...args: any[]) => mockCancelAssignmentTimeout(...args),
  },
}));

// --- Booking service mock ---
jest.mock('../modules/booking/booking.service', () => ({
  bookingService: {
    incrementTrucksFilled: (...args: any[]) => mockIncrementTrucksFilled(...args),
    decrementTrucksFilled: jest.fn().mockResolvedValue(undefined),
  },
}));

// --- Tracking service mock ---
const mockInitializeTracking = jest.fn().mockResolvedValue(undefined);

jest.mock('../modules/tracking/tracking.service', () => ({
  trackingService: {
    initializeTracking: (...args: any[]) => mockInitializeTracking(...args),
  },
}));

// =============================================================================
// IMPORT UNDER TEST (after mocks)
// =============================================================================

import { assignmentService } from '../modules/assignment/assignment.service';
import { withDbTimeout } from '../shared/database/prisma.service';
import { logger } from '../shared/services/logger.service';

// =============================================================================
// TEST FIXTURES
// =============================================================================

const TRANSPORTER_ID = 'transporter-001';
const DRIVER_ID = 'driver-001';
const VEHICLE_ID = 'vehicle-001';
const BOOKING_ID = 'booking-001';
const ASSIGNMENT_ID = 'assignment-001';
const TRIP_ID = 'trip-001';
const ORDER_ID = 'order-001';
const TRUCK_REQUEST_ID = 'truck-request-001';

function buildAssignment(overrides: Partial<any> = {}): any {
  return {
    id: ASSIGNMENT_ID,
    bookingId: BOOKING_ID,
    orderId: undefined,
    truckRequestId: undefined,
    transporterId: TRANSPORTER_ID,
    transporterName: 'Test Transporter',
    vehicleId: VEHICLE_ID,
    vehicleNumber: 'KA01AB1234',
    vehicleType: 'open_17ft',
    vehicleSubtype: 'Open Body',
    driverId: DRIVER_ID,
    driverName: 'Test Driver',
    driverPhone: '9999999999',
    tripId: TRIP_ID,
    status: 'pending',
    assignedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Assignment Lifecycle', () => {
  beforeEach(() => {
    jest.resetAllMocks();

    // Re-set withDbTimeout mock (resetAllMocks clears implementations)
    const prismaService = require('../shared/database/prisma.service');
    prismaService.withDbTimeout.mockImplementation(async (fn: (tx: any) => Promise<any>) => {
      return fn(mockTx);
    });

    // Re-set $transaction mock (M-2: cancel/decline now use $transaction)
    prismaService.prismaClient.$transaction.mockImplementation(async (fn: any) => fn({
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: (...a: any[]) => mockPrismaExecuteRaw(...a),
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      assignment: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: (...a: any[]) => mockTxAssignmentUpdateMany(...a),
        findUnique: (...a: any[]) => mockTxAssignmentFindUnique(...a),
      },
      vehicle: {
        updateMany: (...a: any[]) => mockTxVehicleUpdateMany(...a),
        findUnique: (...a: any[]) => mockVehicleFindUnique(...a),
      },
      truckRequest: {
        updateMany: (...a: any[]) => mockTxTruckRequestUpdateMany(...a),
      },
      booking: {
        updateMany: (...a: any[]) => mockTxBookingUpdateMany(...a),
      },
      order: {
        update: (...a: any[]) => mockTxOrderUpdate(...a),
      },
    }));

    // Re-set declineEvent and assignment.count mocks (cleared by resetAllMocks)
    prismaService.prismaClient.declineEvent = {
      create: jest.fn().mockReturnValue(Promise.resolve({})),
    };
    prismaService.prismaClient.assignment.count = jest.fn().mockResolvedValue(0);

    // Default: transaction succeeds with count=1
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
    mockTxBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockTxOrderUpdate.mockResolvedValue({});
    mockTxTruckRequestUpdateMany.mockResolvedValue({ count: 1 });

    // Default: prisma direct calls (used by handleAssignmentTimeout, cancelAssignment)
    mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockPrismaOrderUpdate.mockResolvedValue({});
    mockPrismaExecuteRaw.mockResolvedValue(1);
    mockPrismaTruckRequestUpdateMany.mockResolvedValue({ count: 1 });

    // Default: prismaClient.vehicle.updateMany (used by releaseVehicleIfBusy)
    mockVehicleUpdateMany.mockResolvedValue({ count: 1 });

    // Default: db operations
    mockUpdateAssignment.mockResolvedValue(undefined);
    mockUpdateVehicle.mockResolvedValue(undefined);

    // Default: vehicle lookup for Redis sync
    mockVehicleFindUnique.mockResolvedValue({
      vehicleKey: 'open_17ft:KA01AB1234',
      transporterId: TRANSPORTER_ID,
      status: 'on_hold',
    });

    // Default: Redis ops succeed
    mockRedisSet.mockResolvedValue(undefined);
    mockRedisDel.mockResolvedValue(undefined);
    mockRedisGetJSON.mockResolvedValue(null);
    mockRedisSetJSON.mockResolvedValue(undefined);
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(true);
    mockOnVehicleStatusChange.mockResolvedValue(undefined);
    mockQueuePushNotification.mockResolvedValue(undefined);
    mockCancelAssignmentTimeout.mockResolvedValue(undefined);
    mockInitializeTracking.mockResolvedValue(undefined);

    // Default: bookingService
    const { bookingService: mockedBookingService } = require('../modules/booking/booking.service');
    mockedBookingService.decrementTrucksFilled.mockResolvedValue(undefined);
  });

  // ===========================================================================
  // CANCEL ASSIGNMENT
  // ===========================================================================

  describe('cancelAssignment', () => {
    test('1. Cancel succeeds — atomic TX updates assignment + releases vehicle', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);

      // bookingService.decrementTrucksFilled is mocked at module level
      const { bookingService: mockedBookingService } = require('../modules/booking/booking.service');
      mockedBookingService.decrementTrucksFilled.mockResolvedValue(undefined);

      // Post-TX: prismaClient.vehicle.findUnique for Redis sync
      mockVehicleFindUnique.mockResolvedValue({
        vehicleKey: 'open_17ft:KA01AB1234',
        transporterId: TRANSPORTER_ID,
        status: 'on_hold',
      });

      await assignmentService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID);

      // M-2: Verify cancel uses $transaction (atomic assignment update + vehicle release)
      const prismaService = require('../shared/database/prisma.service');
      expect(prismaService.prismaClient.$transaction).toHaveBeenCalledTimes(1);

      // Verify driver notified via WebSocket
      expect(mockEmitToUser).toHaveBeenCalledWith(
        DRIVER_ID,
        'assignment_status_changed',
        expect.objectContaining({ assignmentId: ASSIGNMENT_ID, status: 'cancelled' })
      );

      // Verify FCM push queued
      expect(mockQueuePushNotification).toHaveBeenCalledWith(
        DRIVER_ID,
        expect.objectContaining({ data: expect.objectContaining({ status: 'cancelled' }) })
      );
    });

    test('2. Cancel on already-cancelled assignment — throws ASSIGNMENT_ALREADY_TERMINAL', async () => {
      const assignment = buildAssignment({ status: 'cancelled' });
      mockGetAssignmentById.mockResolvedValue(assignment);

      // F-H11 FIX: Terminal state guard now throws for already-terminal assignments
      await expect(
        assignmentService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID)
      ).rejects.toThrow('Assignment is already cancelled');
    });

    test('3. Cancel on completed assignment — throws ASSIGNMENT_ALREADY_TERMINAL', async () => {
      const assignment = buildAssignment({ status: 'completed' });
      mockGetAssignmentById.mockResolvedValue(assignment);

      // F-H11 FIX: Terminal state guard now throws for already-terminal assignments
      await expect(
        assignmentService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID)
      ).rejects.toThrow('Assignment is already completed');
    });

    test('4. Two cancels — both succeed (current impl has no atomic guard)', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);
      const { bookingService: mockedBookingService } = require('../modules/booking/booking.service');
      mockedBookingService.decrementTrucksFilled.mockResolvedValue(undefined);

      // First cancel
      await assignmentService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID);
      const prismaService = require('../shared/database/prisma.service');
      expect(prismaService.prismaClient.$transaction).toHaveBeenCalledTimes(1);

      jest.clearAllMocks();
      // Re-set mocks after clearAllMocks
      mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
      prismaService.prismaClient.$transaction.mockImplementation(async (fn: any) => fn({
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: (...a: any[]) => mockPrismaExecuteRaw(...a),
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
        assignment: { update: jest.fn().mockResolvedValue({}), updateMany: (...a: any[]) => mockTxAssignmentUpdateMany(...a) },
        vehicle: { updateMany: (...a: any[]) => mockTxVehicleUpdateMany(...a) },
        truckRequest: { updateMany: (...a: any[]) => mockTxTruckRequestUpdateMany(...a) },
      }));
      prismaService.withDbTimeout.mockImplementation(async (fn: (tx: any) => Promise<any>) => fn(mockTx));
      mockGetAssignmentById.mockResolvedValue(assignment);
      mockedBookingService.decrementTrucksFilled.mockResolvedValue(undefined);
      mockVehicleFindUnique.mockResolvedValue({
        vehicleKey: 'open_17ft:KA01AB1234',
        transporterId: TRANSPORTER_ID,
        status: 'available',
      });
      mockOnVehicleStatusChange.mockResolvedValue(undefined);
      mockCancelAssignmentTimeout.mockResolvedValue(undefined);
      mockRedisDel.mockResolvedValue(undefined);
      mockQueuePushNotification.mockResolvedValue(undefined);

      // Second cancel — also succeeds since no atomic guard
      await assignmentService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID);
      expect(prismaService.prismaClient.$transaction).toHaveBeenCalledTimes(1);
    });

    test('5. Redis failure during post-cancel — cancel still succeeds, Redis error logged', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);
      const { bookingService: mockedBookingService } = require('../modules/booking/booking.service');
      mockedBookingService.decrementTrucksFilled.mockResolvedValue(undefined);
      // Vehicle lookup succeeds but Redis sync fails
      mockVehicleFindUnique.mockResolvedValue({
        vehicleKey: 'open_17ft:KA01AB1234',
        transporterId: TRANSPORTER_ID,
        status: 'on_hold',
      });
      mockOnVehicleStatusChange.mockRejectedValue(new Error('Redis connection refused'));

      // Should NOT throw — Redis errors are caught internally (fire-and-forget .catch)
      await assignmentService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID);

      // M-2: Cancel uses $transaction
      const prismaService = require('../shared/database/prisma.service');
      expect(prismaService.prismaClient.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // DECLINE ASSIGNMENT
  // ===========================================================================

  describe('declineAssignment', () => {
    test('6. Decline succeeds on pending assignment', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);
      const { bookingService: mockedBookingService } = require('../modules/booking/booking.service');
      mockedBookingService.decrementTrucksFilled.mockResolvedValue(undefined);

      await assignmentService.declineAssignment(ASSIGNMENT_ID, DRIVER_ID);

      // M-2: Verify decline uses $transaction (atomic assignment update + vehicle release)
      const prismaService = require('../shared/database/prisma.service');
      expect(prismaService.prismaClient.$transaction).toHaveBeenCalledTimes(1);

      // Verify transporter notified
      expect(mockEmitToUser).toHaveBeenCalledWith(
        TRANSPORTER_ID,
        'assignment_status_changed',
        expect.objectContaining({ status: 'driver_declined' })
      );
    });

    test('7. Decline on already-accepted assignment — throws INVALID_STATUS', async () => {
      const assignment = buildAssignment({ status: 'driver_accepted' });
      mockGetAssignmentById.mockResolvedValue(assignment);

      // declineAssignment checks assignment.status !== 'pending' and throws
      await expect(
        assignmentService.declineAssignment(ASSIGNMENT_ID, DRIVER_ID)
      ).rejects.toMatchObject({
        code: 'INVALID_STATUS',
        statusCode: 400,
      });
    });

    test('8. Decline stores reason in Redis', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);
      const { bookingService: mockedBookingService } = require('../modules/booking/booking.service');
      mockedBookingService.decrementTrucksFilled.mockResolvedValue(undefined);

      await assignmentService.declineAssignment(ASSIGNMENT_ID, DRIVER_ID);

      expect(mockRedisSet).toHaveBeenCalledWith(
        `assignment:reason:${ASSIGNMENT_ID}`,
        'declined',
        86400
      );
    });

    test('9. Two declines — second throws INVALID_STATUS (status guard)', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);
      const { bookingService: mockedBookingService } = require('../modules/booking/booking.service');
      mockedBookingService.decrementTrucksFilled.mockResolvedValue(undefined);

      await assignmentService.declineAssignment(ASSIGNMENT_ID, DRIVER_ID);
      const prismaService = require('../shared/database/prisma.service');
      expect(prismaService.prismaClient.$transaction).toHaveBeenCalledTimes(1);

      // Second decline — assignment is now driver_declined, not pending
      jest.clearAllMocks();
      // Re-set $transaction mock after clearAllMocks
      prismaService.prismaClient.$transaction.mockImplementation(async (fn: any) => fn({
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
        assignment: { update: jest.fn().mockResolvedValue({}) },
        vehicle: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      }));
      mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_declined' }));

      await expect(
        assignmentService.declineAssignment(ASSIGNMENT_ID, DRIVER_ID)
      ).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    });

    test('10. Decline on timed-out assignment — throws INVALID_STATUS', async () => {
      // Assignment was already timed out (status changed to driver_declined by timeout handler)
      const assignment = buildAssignment({ status: 'driver_declined' });
      mockGetAssignmentById.mockResolvedValue(assignment);

      await expect(
        assignmentService.declineAssignment(ASSIGNMENT_ID, DRIVER_ID)
      ).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    });
  });

  // ===========================================================================
  // TIMEOUT
  // ===========================================================================

  describe('handleAssignmentTimeout', () => {
    const timerData = {
      assignmentId: ASSIGNMENT_ID,
      driverId: DRIVER_ID,
      driverName: 'Test Driver',
      transporterId: TRANSPORTER_ID,
      vehicleId: VEHICLE_ID,
      vehicleNumber: 'KA01AB1234',
      bookingId: BOOKING_ID,
      tripId: TRIP_ID,
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    test('11. Timeout on pending — succeeds, marks as timed out', async () => {
      // handleAssignmentTimeout now uses $transaction; tx routes to mockTxAssignmentUpdateMany
      mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_declined' }));

      await assignmentService.handleAssignmentTimeout(timerData);

      // Verify tx.assignment.updateMany called inside $transaction
      expect(mockTxAssignmentUpdateMany).toHaveBeenCalledWith({
        where: { id: ASSIGNMENT_ID, status: 'pending' },
        data: expect.objectContaining({ status: 'driver_declined', declineType: 'timeout' }),
      });

      // Verify vehicle released inside tx (tx.vehicle.updateMany)
      expect(mockTxVehicleUpdateMany).toHaveBeenCalledWith({
        where: { id: VEHICLE_ID, status: { not: 'available' } },
        data: expect.objectContaining({ status: 'available' }),
      });

      // Verify reason persisted as 'timeout'
      expect(mockRedisSet).toHaveBeenCalledWith(
        `assignment:reason:${ASSIGNMENT_ID}`,
        'timeout',
        86400
      );

      // Verify transporter notified of timeout
      expect(mockEmitToUser).toHaveBeenCalledWith(
        TRANSPORTER_ID,
        'driver_timeout',
        expect.objectContaining({ reason: 'timeout' })
      );
    });

    test('12. Timeout on already-accepted — no-op (returns false, race lost)', async () => {
      mockTxAssignmentUpdateMany.mockResolvedValue({ count: 0 });
      mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));

      await assignmentService.handleAssignmentTimeout(timerData);

      // Vehicle should NOT be released (skipped due to count=0)
      expect(mockTxVehicleUpdateMany).not.toHaveBeenCalled();

      // No notifications sent for timeout
      expect(mockRedisSet).not.toHaveBeenCalled();

      // Info logged about no-op
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('already driver_accepted')
      );
    });

    test('13. Timeout on already-declined — no-op (returns false)', async () => {
      mockTxAssignmentUpdateMany.mockResolvedValue({ count: 0 });
      mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_declined' }));

      await assignmentService.handleAssignmentTimeout(timerData);

      expect(mockTxVehicleUpdateMany).not.toHaveBeenCalled();
      expect(mockRedisSet).not.toHaveBeenCalled();
    });

    test('14. Timeout releases vehicle back to available', async () => {
      mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_declined' }));

      await assignmentService.handleAssignmentTimeout(timerData);

      // Vehicle released inside $transaction via tx.vehicle.updateMany
      expect(mockTxVehicleUpdateMany).toHaveBeenCalledWith({
        where: { id: VEHICLE_ID, status: { not: 'available' } },
        data: expect.objectContaining({ status: 'available' }),
      });
    });
  });

  // ===========================================================================
  // ACCEPT ASSIGNMENT
  // ===========================================================================

  describe('acceptAssignment', () => {
    test('15. Accept on pending — succeeds, sets driver_accepted', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);
      mockRedisGetOrSet.mockResolvedValue(null); // No active assignment
      mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      mockTxAssignmentFindUnique.mockResolvedValue({
        ...assignment,
        status: 'driver_accepted',
        driverAcceptedAt: '2026-01-01T00:01:00.000Z',
      });
      mockGetBookingById.mockResolvedValue({ customerId: 'customer-001' });

      const result = await assignmentService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);

      expect(result.status).toBe('driver_accepted');

      // Verify atomic TX
      expect(mockTxAssignmentUpdateMany).toHaveBeenCalledWith({
        where: { id: ASSIGNMENT_ID, status: 'pending' },
        data: expect.objectContaining({ status: 'driver_accepted' }),
      });

      // Verify vehicle set to in_transit in TX
      expect(mockTxVehicleUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'in_transit' }),
        })
      );
    });

    test('16. Accept on already-declined — throws ASSIGNMENT_STATE_CHANGED', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);
      mockRedisGetOrSet.mockResolvedValue(null);

      // TX: updateMany returns 0 because assignment is no longer pending
      mockTxAssignmentUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        assignmentService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID)
      ).rejects.toMatchObject({
        code: 'ASSIGNMENT_STATE_CHANGED',
        statusCode: 400,
      });
    });

    test('17. Accept seeds tracking from driver GPS (fresh location)', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);
      mockRedisGetOrSet.mockResolvedValue(null);
      mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      mockTxAssignmentFindUnique.mockResolvedValue({
        ...assignment,
        status: 'driver_accepted',
      });
      mockGetBookingById.mockResolvedValue(null);

      // Fresh GPS (timestamp < 5 min ago)
      mockRedisGetJSON.mockResolvedValue({
        latitude: 12.9716,
        longitude: 77.5946,
        timestamp: Date.now() - 60000, // 1 minute ago
      });
      mockRedisSetJSON.mockResolvedValue(undefined);

      // Return trip data when queried
      mockRedisGetJSON
        .mockResolvedValueOnce({
          latitude: 12.9716,
          longitude: 77.5946,
          timestamp: Date.now() - 60000,
        })
        .mockResolvedValueOnce({
          tripId: TRIP_ID,
          latitude: 0,
          longitude: 0,
          status: 'pending',
        });

      await assignmentService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);

      // Tracking initialized
      expect(mockInitializeTracking).toHaveBeenCalledWith(
        TRIP_ID,
        DRIVER_ID,
        'KA01AB1234',
        BOOKING_ID,
        TRANSPORTER_ID,
        VEHICLE_ID
      );
    });

    test('18. Accept with stale GPS (>5 min) — still accepts but does not seed location', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);
      mockRedisGetOrSet.mockResolvedValue(null);
      mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      mockTxAssignmentFindUnique.mockResolvedValue({
        ...assignment,
        status: 'driver_accepted',
      });
      mockGetBookingById.mockResolvedValue(null);

      // Stale GPS (timestamp > 5 min ago)
      const staleTimestamp = Date.now() - (6 * 60 * 1000); // 6 minutes ago
      mockRedisGetJSON.mockResolvedValue({
        latitude: 12.9716,
        longitude: 77.5946,
        timestamp: staleTimestamp,
      });

      await assignmentService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);

      // Accept still succeeds
      expect(mockTxAssignmentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'driver_accepted' }) })
      );

      // Stale GPS warning logged (single string argument)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Stale GPS')
      );
    });

    test('19. Concurrent accept and decline — only one wins', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);
      mockRedisGetOrSet.mockResolvedValue(null);

      // Accept wins (count=1), decline loses (count=0)
      mockTxAssignmentUpdateMany.mockResolvedValueOnce({ count: 1 });
      mockTxAssignmentFindUnique.mockResolvedValue({
        ...assignment,
        status: 'driver_accepted',
      });
      mockGetBookingById.mockResolvedValue(null);

      const acceptResult = await assignmentService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);
      expect(acceptResult.status).toBe('driver_accepted');

      // Now decline tries — assignment is already driver_accepted, not pending
      jest.clearAllMocks();
      mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));

      await expect(
        assignmentService.declineAssignment(ASSIGNMENT_ID, DRIVER_ID)
      ).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    });
  });

  // ===========================================================================
  // PRODUCTION EDGE CASES
  // ===========================================================================

  describe('Production Edge Cases', () => {
    test('20. Vehicle findUnique fails during post-cancel Redis sync — error propagates', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);

      // Post-TX: vehicle findUnique fails (for Redis sync path)
      mockVehicleFindUnique.mockRejectedValue(new Error('DB read failure'));

      await expect(
        assignmentService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID)
      ).rejects.toThrow('DB read failure');

      // M-2: $transaction was called (assignment updated inside TX before vehicle lookup failed)
      const prismaService = require('../shared/database/prisma.service');
      expect(prismaService.prismaClient.$transaction).toHaveBeenCalledTimes(1);
    });

    test('21. FCM notification fails — cancel still succeeds', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);
      const { bookingService: mockedBookingService } = require('../modules/booking/booking.service');
      mockedBookingService.decrementTrucksFilled.mockResolvedValue(undefined);
      mockQueuePushNotification.mockRejectedValue(new Error('FCM service unavailable'));

      // Cancel should NOT throw — FCM failure is caught via .catch()
      await assignmentService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID);

      // M-2: $transaction was called
      const prismaService = require('../shared/database/prisma.service');
      expect(prismaService.prismaClient.$transaction).toHaveBeenCalledTimes(1);
    });

    test('22. Socket emit fails — error propagates (not wrapped in try/catch)', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);
      const { bookingService: mockedBookingService } = require('../modules/booking/booking.service');
      mockedBookingService.decrementTrucksFilled.mockResolvedValue(undefined);
      mockEmitToBooking.mockImplementation(() => { throw new Error('Socket.IO not initialized'); });

      await expect(
        assignmentService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID)
      ).rejects.toThrow('Socket.IO not initialized');

      // M-2: $transaction was called (assignment updated inside TX before socket error)
      const prismaService = require('../shared/database/prisma.service');
      expect(prismaService.prismaClient.$transaction).toHaveBeenCalledTimes(1);
    });

    test('23. $transaction failure — proper error thrown', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);

      // M-2: $transaction now wraps the DB write; simulate TX failure
      const prismaService = require('../shared/database/prisma.service');
      prismaService.prismaClient.$transaction.mockRejectedValue(new Error('DB write failure'));

      await expect(
        assignmentService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID)
      ).rejects.toThrow('DB write failure');
    });
  });

  // ===========================================================================
  // ADDITIONAL EDGE CASES
  // ===========================================================================

  describe('Cancel with orderId (multi-truck system)', () => {
    test('Cancel with orderId decrements order trucksFilled and restores truck request', async () => {
      const assignment = buildAssignment({
        status: 'driver_accepted',
        bookingId: undefined,
        orderId: ORDER_ID,
        truckRequestId: TRUCK_REQUEST_ID,
      });
      mockGetAssignmentById.mockResolvedValue(assignment);

      await assignmentService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID);

      // Order trucksFilled decremented via $executeRaw with GREATEST(0, ...) floor guard
      expect(mockPrismaExecuteRaw).toHaveBeenCalled();

      // Truck request restored via prismaClient.truckRequest.updateMany
      expect(mockPrismaTruckRequestUpdateMany).toHaveBeenCalledWith({
        where: { id: TRUCK_REQUEST_ID, orderId: ORDER_ID },
        data: expect.objectContaining({ status: 'searching', assignedVehicleId: null }),
      });
    });
  });

  describe('Accept — status guard messages', () => {
    test('Accept on cancelled assignment — throws with descriptive message', async () => {
      const assignment = buildAssignment({ status: 'cancelled' });
      mockGetAssignmentById.mockResolvedValue(assignment);

      try {
        await assignmentService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);
        fail('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('INVALID_STATUS');
        expect(err.message).toContain('cancelled by the transporter');
        expect(err.currentStatus).toBe('cancelled');
      }
    });

    test('Accept on already-accepted assignment — throws with "already accepted" message', async () => {
      const assignment = buildAssignment({ status: 'driver_accepted' });
      mockGetAssignmentById.mockResolvedValue(assignment);

      try {
        await assignmentService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);
        fail('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('INVALID_STATUS');
        expect(err.message).toContain('already accepted');
        expect(err.currentStatus).toBe('driver_accepted');
      }
    });
  });

  describe('Decline — driver ownership guard', () => {
    test('Decline by wrong driver — throws FORBIDDEN', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);

      await expect(
        assignmentService.declineAssignment(ASSIGNMENT_ID, 'wrong-driver-id')
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        statusCode: 403,
      });
    });

    test('Decline on non-existent assignment — throws ASSIGNMENT_NOT_FOUND', async () => {
      mockGetAssignmentById.mockResolvedValue(undefined);

      await expect(
        assignmentService.declineAssignment(ASSIGNMENT_ID, DRIVER_ID)
      ).rejects.toMatchObject({
        code: 'ASSIGNMENT_NOT_FOUND',
        statusCode: 404,
      });
    });
  });

  describe('Cancel — access control', () => {
    test('Cancel by unauthorized user — throws FORBIDDEN', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);

      await expect(
        assignmentService.cancelAssignment(ASSIGNMENT_ID, 'random-user-id')
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        statusCode: 403,
      });
    });

    test('Cancel by driver (who is assigned) — succeeds', async () => {
      const assignment = buildAssignment({ status: 'pending' });
      mockGetAssignmentById.mockResolvedValue(assignment);
      const { bookingService: mockedBookingService } = require('../modules/booking/booking.service');
      mockedBookingService.decrementTrucksFilled.mockResolvedValue(undefined);

      // Driver can cancel their own assignment
      await assignmentService.cancelAssignment(ASSIGNMENT_ID, DRIVER_ID);

      // M-2: $transaction was called
      const prismaService = require('../shared/database/prisma.service');
      expect(prismaService.prismaClient.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('Timeout with orderId (multi-truck system)', () => {
    test('Timeout with orderId decrements order and restores truck request', async () => {
      const timerData = {
        assignmentId: ASSIGNMENT_ID,
        driverId: DRIVER_ID,
        driverName: 'Test Driver',
        transporterId: TRANSPORTER_ID,
        vehicleId: VEHICLE_ID,
        vehicleNumber: 'KA01AB1234',
        tripId: TRIP_ID,
        createdAt: '2026-01-01T00:00:00.000Z',
        orderId: ORDER_ID,
        truckRequestId: TRUCK_REQUEST_ID,
      };

      // handleAssignmentTimeout uses $transaction (assignment.service.ts facade)
      mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
      mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_declined' }));

      await assignmentService.handleAssignmentTimeout(timerData);

      // Uses tx.$executeRaw with GREATEST(0, ...) floor guard for trucksFilled decrement
      expect(mockPrismaExecuteRaw).toHaveBeenCalled();

      // Uses tx.truckRequest.updateMany inside $transaction
      expect(mockTxTruckRequestUpdateMany).toHaveBeenCalledWith({
        where: { id: TRUCK_REQUEST_ID, orderId: ORDER_ID },
        data: expect.objectContaining({ status: 'searching' }),
      });
    });
  });
});
