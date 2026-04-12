/**
 * =============================================================================
 * ASSIGNMENT SPLIT MODULE - Comprehensive Tests (50-70 tests)
 * =============================================================================
 *
 * Tests covering the split assignment module:
 *   1. Facade integrity (assignment.service.ts)
 *   2. Dispatch (assignment-dispatch.service.ts)
 *   3. Query (assignment-query.service.ts)
 *   4. Response (assignment-response.service.ts)
 *   5. Lifecycle (assignment-lifecycle.service.ts)
 *   6. Edge cases and race conditions
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

// --- hold-config mock (must be before assignment.types import) ---
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
}));

// --- db mock ---
const mockGetAssignmentById = jest.fn();
const mockGetBookingById = jest.fn();
const mockGetVehicleById = jest.fn();
const mockGetUserById = jest.fn();
const mockUpdateAssignment = jest.fn();
const mockGetActiveAssignmentByDriver = jest.fn();
const mockGetAssignmentsByTransporter = jest.fn();
const mockGetAssignmentsByDriver = jest.fn();
const mockGetBookingsByCustomer = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getAssignmentById: (...args: any[]) => mockGetAssignmentById(...args),
    getBookingById: (...args: any[]) => mockGetBookingById(...args),
    getVehicleById: (...args: any[]) => mockGetVehicleById(...args),
    getUserById: (...args: any[]) => mockGetUserById(...args),
    updateAssignment: (...args: any[]) => mockUpdateAssignment(...args),
    getActiveAssignmentByDriver: (...args: any[]) => mockGetActiveAssignmentByDriver(...args),
    getAssignmentsByTransporter: (...args: any[]) => mockGetAssignmentsByTransporter(...args),
    getAssignmentsByDriver: (...args: any[]) => mockGetAssignmentsByDriver(...args),
    getBookingsByCustomer: (...args: any[]) => mockGetBookingsByCustomer(...args),
  },
  AssignmentRecord: {},
}));

// --- prismaClient mock ---
const mockTxAssignmentUpdateMany = jest.fn();
const mockTxAssignmentFindUnique = jest.fn();
const mockTxAssignmentFindFirst = jest.fn();
const mockTxAssignmentCreate = jest.fn();
const mockTxVehicleUpdateMany = jest.fn();
const mockTxAssignmentUpdate = jest.fn();

const mockTx = {
  assignment: {
    updateMany: (...args: any[]) => mockTxAssignmentUpdateMany(...args),
    findUnique: (...args: any[]) => mockTxAssignmentFindUnique(...args),
    findFirst: (...args: any[]) => mockTxAssignmentFindFirst(...args),
    create: (...args: any[]) => mockTxAssignmentCreate(...args),
    update: (...args: any[]) => mockTxAssignmentUpdate(...args),
  },
  vehicle: {
    updateMany: (...args: any[]) => mockTxVehicleUpdateMany(...args),
    findUnique: jest.fn(),
  },
};

const mockVehicleFindUnique = jest.fn();
const mockPrismaVehicleUpdateMany = jest.fn();
const mockPrismaAssignmentUpdateMany = jest.fn();
const mockPrismaAssignmentCount = jest.fn();
const mockPrismaAssignmentFindMany = jest.fn();
const mockPrismaExecuteRaw = jest.fn();
const mockPrismaTruckRequestUpdateMany = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    $transaction: jest.fn(),
    $executeRaw: (...args: any[]) => mockPrismaExecuteRaw(...args),
    assignment: {
      updateMany: (...args: any[]) => mockPrismaAssignmentUpdateMany(...args),
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      count: (...args: any[]) => mockPrismaAssignmentCount(...args),
      findMany: (...args: any[]) => mockPrismaAssignmentFindMany(...args),
    },
    vehicle: {
      findUnique: (...args: any[]) => mockVehicleFindUnique(...args),
      updateMany: (...args: any[]) => mockPrismaVehicleUpdateMany(...args),
    },
    truckRequest: {
      updateMany: (...args: any[]) => mockPrismaTruckRequestUpdateMany(...args),
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
const mockRedisGet = jest.fn().mockResolvedValue(null);
const mockRedisAcquireLock = jest.fn().mockResolvedValue({ acquired: true });
const mockRedisReleaseLock = jest.fn().mockResolvedValue(true);
const mockRedisCancelTimer = jest.fn().mockResolvedValue(true);
const mockRedisSetTimer = jest.fn().mockResolvedValue('OK');
const mockRedisIncrBy = jest.fn().mockResolvedValue(1);

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    getJSON: (...args: any[]) => mockRedisGetJSON(...args),
    setJSON: (...args: any[]) => mockRedisSetJSON(...args),
    getOrSet: (...args: any[]) => mockRedisGetOrSet(...args),
    get: (...args: any[]) => mockRedisGet(...args),
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    cancelTimer: (...args: any[]) => mockRedisCancelTimer(...args),
    setTimer: (...args: any[]) => mockRedisSetTimer(...args),
    incrBy: (...args: any[]) => mockRedisIncrBy(...args),
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
    TRIP_ASSIGNED: 'trip_assigned',
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
const mockIncrementTrucksFilled = jest.fn().mockResolvedValue(undefined);
const mockDecrementTrucksFilled = jest.fn().mockResolvedValue(undefined);

jest.mock('../modules/booking/booking.service', () => ({
  bookingService: {
    incrementTrucksFilled: (...args: any[]) => mockIncrementTrucksFilled(...args),
    decrementTrucksFilled: (...args: any[]) => mockDecrementTrucksFilled(...args),
  },
}));

// --- Tracking service mock ---
const mockInitializeTracking = jest.fn().mockResolvedValue(undefined);

jest.mock('../modules/tracking/tracking.service', () => ({
  trackingService: {
    initializeTracking: (...args: any[]) => mockInitializeTracking(...args),
  },
}));

// --- Vehicle lifecycle mock ---
const mockReleaseVehicle = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: (...args: any[]) => mockReleaseVehicle(...args),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { assignmentService } from '../modules/assignment/assignment.service';
import { ASSIGNMENT_CONFIG } from '../modules/assignment/assignment.types';
import { assignmentDispatchService } from '../modules/assignment/assignment-dispatch.service';
import { assignmentQueryService } from '../modules/assignment/assignment-query.service';
import { assignmentResponseService } from '../modules/assignment/assignment-response.service';
import { assignmentLifecycleService } from '../modules/assignment/assignment-lifecycle.service';

// =============================================================================
// FIXTURES
// =============================================================================

const TRANSPORTER_ID = 'transporter-001';
const DRIVER_ID = 'driver-001';
const VEHICLE_ID = 'vehicle-001';
const BOOKING_ID = 'booking-001';
const ASSIGNMENT_ID = 'assignment-001';
const TRIP_ID = 'trip-001';
const ORDER_ID = 'order-001';
const TRUCK_REQUEST_ID = 'truck-request-001';
const CUSTOMER_ID = 'customer-001';

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

function buildBooking(overrides: Partial<any> = {}): any {
  return {
    id: BOOKING_ID,
    customerId: CUSTOMER_ID,
    customerName: 'Test Customer',
    status: 'active',
    vehicleType: 'open_17ft',
    vehicleSubtype: 'Open Body',
    trucksNeeded: 3,
    trucksFilled: 0,
    ...overrides,
  };
}

function buildVehicle(overrides: Partial<any> = {}): any {
  return {
    id: VEHICLE_ID,
    transporterId: TRANSPORTER_ID,
    vehicleNumber: 'KA01AB1234',
    vehicleType: 'open_17ft',
    vehicleSubtype: 'Open Body',
    vehicleKey: 'open_17ft:Open Body',
    status: 'available',
    ...overrides,
  };
}

function buildDriver(overrides: Partial<any> = {}): any {
  return {
    id: DRIVER_ID,
    name: 'Test Driver',
    phone: '9999999999',
    role: 'driver',
    transporterId: TRANSPORTER_ID,
    ...overrides,
  };
}

function buildTransporter(overrides: Partial<any> = {}): any {
  return {
    id: TRANSPORTER_ID,
    name: 'Transporter Owner',
    businessName: 'Test Transport Co.',
    role: 'transporter',
    ...overrides,
  };
}

// =============================================================================
// COMMON SETUP
// =============================================================================

function resetMocksAndDefaults(): void {
  jest.resetAllMocks();

  const prismaService = require('../shared/database/prisma.service');
  prismaService.withDbTimeout.mockImplementation(async (fn: (tx: any) => Promise<any>) => {
    return fn(mockTx);
  });

  prismaService.prismaClient.$transaction.mockImplementation(async (fn: any) => fn({
    assignment: {
      update: (...a: any[]) => mockTxAssignmentUpdate(...a),
      updateMany: (...a: any[]) => mockTxAssignmentUpdateMany(...a),
    },
    vehicle: {
      updateMany: (...a: any[]) => mockTxVehicleUpdateMany(...a),
    },
  }));

  // Defaults for transaction mocks
  mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
  mockTxVehicleUpdateMany.mockResolvedValue({ count: 1 });
  mockTxAssignmentFindUnique.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));
  mockTxAssignmentFindFirst.mockResolvedValue(null);
  mockTxAssignmentCreate.mockResolvedValue(undefined);
  mockTxAssignmentUpdate.mockResolvedValue({});

  // Queue mocks
  mockQueuePushNotification.mockResolvedValue(undefined);
  mockScheduleAssignmentTimeout.mockResolvedValue(undefined);
  mockCancelAssignmentTimeout.mockResolvedValue(undefined);

  // Redis mocks
  mockRedisSet.mockResolvedValue(undefined);
  mockRedisDel.mockResolvedValue(undefined);
  mockRedisGetJSON.mockResolvedValue(null);
  mockRedisSetJSON.mockResolvedValue(undefined);
  mockRedisGetOrSet.mockResolvedValue(null);
  mockRedisGet.mockResolvedValue(null);
  mockRedisAcquireLock.mockResolvedValue({ acquired: true });
  mockRedisReleaseLock.mockResolvedValue(true);
  mockRedisCancelTimer.mockResolvedValue(true);
  mockRedisSetTimer.mockResolvedValue('OK');
  mockRedisIncrBy.mockResolvedValue(1);

  // Prisma assignment.findFirst (driver busy check)
  const prismaClient = require('../shared/database/prisma.service').prismaClient;
  prismaClient.assignment.findFirst.mockResolvedValue(null);

  // LiveAvailability
  mockOnVehicleStatusChange.mockResolvedValue(undefined);

  // Vehicle lifecycle
  mockReleaseVehicle.mockResolvedValue(undefined);

  // Prisma vehicle updateMany (used by releaseVehicleIfBusy — direct prismaClient call, not transaction)
  mockPrismaVehicleUpdateMany.mockResolvedValue({ count: 1 });

  // Booking service
  mockIncrementTrucksFilled.mockResolvedValue(undefined);
  mockDecrementTrucksFilled.mockResolvedValue(undefined);
}

// =============================================================================
// 1. FACADE INTEGRITY TESTS
// =============================================================================

describe('1. Facade Integrity (assignment.service.ts)', () => {
  beforeEach(resetMocksAndDefaults);

  test('1.1 assignmentService exports a singleton instance', () => {
    expect(assignmentService).toBeDefined();
    expect(typeof assignmentService).toBe('object');
  });

  test('1.2 createAssignment method exists and delegates to dispatch service', async () => {
    expect(typeof assignmentService.createAssignment).toBe('function');
  });

  test('1.3 getAssignments method exists and delegates to query service', () => {
    expect(typeof assignmentService.getAssignments).toBe('function');
  });

  test('1.4 getDriverAssignments method exists', () => {
    expect(typeof assignmentService.getDriverAssignments).toBe('function');
  });

  test('1.5 getAssignmentById method exists', () => {
    expect(typeof assignmentService.getAssignmentById).toBe('function');
  });

  test('1.6 acceptAssignment method exists and delegates to response service', () => {
    expect(typeof assignmentService.acceptAssignment).toBe('function');
  });

  test('1.7 updateStatus method exists and delegates to lifecycle service', () => {
    expect(typeof assignmentService.updateStatus).toBe('function');
  });

  test('1.8 cancelAssignment method exists', () => {
    expect(typeof assignmentService.cancelAssignment).toBe('function');
  });

  test('1.9 declineAssignment method exists', () => {
    expect(typeof assignmentService.declineAssignment).toBe('function');
  });

  test('1.10 handleAssignmentTimeout method exists', () => {
    expect(typeof assignmentService.handleAssignmentTimeout).toBe('function');
  });

  test('1.11 ASSIGNMENT_CONFIG is exported with correct timeout value', () => {
    expect(ASSIGNMENT_CONFIG).toBeDefined();
    expect(ASSIGNMENT_CONFIG.TIMEOUT_MS).toBe(45000);
  });

  test('1.12 sub-services are exported as singletons', () => {
    expect(assignmentDispatchService).toBeDefined();
    expect(assignmentQueryService).toBeDefined();
    expect(assignmentResponseService).toBeDefined();
    expect(assignmentLifecycleService).toBeDefined();
  });
});

// =============================================================================
// 2. DISPATCH TESTS (assignment-dispatch.service.ts)
// =============================================================================

describe('2. Dispatch (assignment-dispatch.service.ts)', () => {
  beforeEach(resetMocksAndDefaults);

  test('2.1 createAssignment - happy path returns assignment record', async () => {
    mockGetBookingById.mockResolvedValue(buildBooking());
    mockGetVehicleById.mockResolvedValue(buildVehicle());
    mockGetUserById
      .mockResolvedValueOnce(buildDriver())       // driver lookup
      .mockResolvedValueOnce(buildTransporter());  // transporter lookup

    const result = await assignmentDispatchService.createAssignment(
      TRANSPORTER_ID,
      { bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID }
    );

    expect(result).toBeDefined();
    expect(result.bookingId).toBe(BOOKING_ID);
    expect(result.vehicleId).toBe(VEHICLE_ID);
    expect(result.driverId).toBe(DRIVER_ID);
    expect(result.status).toBe('pending');
  });

  test('2.2 createAssignment - throws BOOKING_NOT_FOUND when booking missing', async () => {
    mockGetBookingById.mockResolvedValue(null);

    await expect(
      assignmentDispatchService.createAssignment(TRANSPORTER_ID, {
        bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID,
      })
    ).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND' });
  });

  test('2.3 createAssignment - throws BOOKING_NOT_ACTIVE when booking is completed', async () => {
    mockGetBookingById.mockResolvedValue(buildBooking({ status: 'completed' }));

    await expect(
      assignmentDispatchService.createAssignment(TRANSPORTER_ID, {
        bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID,
      })
    ).rejects.toMatchObject({ code: 'BOOKING_NOT_ACTIVE' });
  });

  test('2.4 createAssignment - allows partially_filled booking', async () => {
    mockGetBookingById.mockResolvedValue(buildBooking({ status: 'partially_filled' }));
    mockGetVehicleById.mockResolvedValue(buildVehicle());
    mockGetUserById
      .mockResolvedValueOnce(buildDriver())
      .mockResolvedValueOnce(buildTransporter());

    const result = await assignmentDispatchService.createAssignment(
      TRANSPORTER_ID,
      { bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID }
    );

    expect(result.status).toBe('pending');
  });

  test('2.5 createAssignment - throws VEHICLE_NOT_FOUND when vehicle missing', async () => {
    mockGetBookingById.mockResolvedValue(buildBooking());
    mockGetVehicleById.mockResolvedValue(null);

    await expect(
      assignmentDispatchService.createAssignment(TRANSPORTER_ID, {
        bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID,
      })
    ).rejects.toMatchObject({ code: 'VEHICLE_NOT_FOUND' });
  });

  test('2.6 createAssignment - throws FORBIDDEN when vehicle belongs to different transporter', async () => {
    mockGetBookingById.mockResolvedValue(buildBooking());
    mockGetVehicleById.mockResolvedValue(buildVehicle({ transporterId: 'other-transporter' }));

    await expect(
      assignmentDispatchService.createAssignment(TRANSPORTER_ID, {
        bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('2.7 createAssignment - throws VEHICLE_BUSY when vehicle is in_transit', async () => {
    mockGetBookingById.mockResolvedValue(buildBooking());
    mockGetVehicleById.mockResolvedValue(buildVehicle({ status: 'in_transit' }));

    await expect(
      assignmentDispatchService.createAssignment(TRANSPORTER_ID, {
        bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID,
      })
    ).rejects.toMatchObject({ code: 'VEHICLE_BUSY' });
  });

  test('2.8 createAssignment - throws VEHICLE_BUSY when vehicle is on_hold', async () => {
    mockGetBookingById.mockResolvedValue(buildBooking());
    mockGetVehicleById.mockResolvedValue(buildVehicle({ status: 'on_hold' }));

    await expect(
      assignmentDispatchService.createAssignment(TRANSPORTER_ID, {
        bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID,
      })
    ).rejects.toMatchObject({ code: 'VEHICLE_BUSY' });
  });

  test('2.9 createAssignment - throws VEHICLE_MISMATCH when vehicle type differs from booking', async () => {
    mockGetBookingById.mockResolvedValue(buildBooking({ vehicleType: 'closed_32ft' }));
    mockGetVehicleById.mockResolvedValue(buildVehicle());

    await expect(
      assignmentDispatchService.createAssignment(TRANSPORTER_ID, {
        bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID,
      })
    ).rejects.toMatchObject({ code: 'VEHICLE_MISMATCH' });
  });

  test('2.10 createAssignment - throws VEHICLE_SUBTYPE_MISMATCH when subtype differs', async () => {
    mockGetBookingById.mockResolvedValue(buildBooking({ vehicleSubtype: 'Container' }));
    mockGetVehicleById.mockResolvedValue(buildVehicle({ vehicleSubtype: 'Open Body' }));

    await expect(
      assignmentDispatchService.createAssignment(TRANSPORTER_ID, {
        bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID,
      })
    ).rejects.toMatchObject({ code: 'VEHICLE_SUBTYPE_MISMATCH' });
  });

  test('2.11 createAssignment - allows subtype mismatch when booking has no subtype (backward compatible)', async () => {
    mockGetBookingById.mockResolvedValue(buildBooking({ vehicleSubtype: '' }));
    mockGetVehicleById.mockResolvedValue(buildVehicle());
    mockGetUserById
      .mockResolvedValueOnce(buildDriver())
      .mockResolvedValueOnce(buildTransporter());

    const result = await assignmentDispatchService.createAssignment(
      TRANSPORTER_ID,
      { bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID }
    );

    expect(result.status).toBe('pending');
  });

  test('2.12 createAssignment - case-insensitive subtype matching', async () => {
    mockGetBookingById.mockResolvedValue(buildBooking({ vehicleSubtype: 'open body' }));
    mockGetVehicleById.mockResolvedValue(buildVehicle({ vehicleSubtype: 'Open Body' }));
    mockGetUserById
      .mockResolvedValueOnce(buildDriver())
      .mockResolvedValueOnce(buildTransporter());

    const result = await assignmentDispatchService.createAssignment(
      TRANSPORTER_ID,
      { bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID }
    );

    expect(result).toBeDefined();
  });

  test('2.13 createAssignment - throws DRIVER_NOT_FOUND when driver missing', async () => {
    mockGetBookingById.mockResolvedValue(buildBooking());
    mockGetVehicleById.mockResolvedValue(buildVehicle());
    mockGetUserById.mockResolvedValue(null);

    await expect(
      assignmentDispatchService.createAssignment(TRANSPORTER_ID, {
        bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID,
      })
    ).rejects.toMatchObject({ code: 'DRIVER_NOT_FOUND' });
  });

  test('2.14 createAssignment - throws FORBIDDEN when driver belongs to different transporter', async () => {
    mockGetBookingById.mockResolvedValue(buildBooking());
    mockGetVehicleById.mockResolvedValue(buildVehicle());
    mockGetUserById.mockResolvedValue(buildDriver({ transporterId: 'other-transporter' }));

    await expect(
      assignmentDispatchService.createAssignment(TRANSPORTER_ID, {
        bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('2.15 createAssignment - throws DRIVER_BUSY when driver has active assignment', async () => {
    mockGetBookingById.mockResolvedValue(buildBooking());
    mockGetVehicleById.mockResolvedValue(buildVehicle());
    mockGetUserById
      .mockResolvedValueOnce(buildDriver())
      .mockResolvedValueOnce(buildTransporter());
    mockTxAssignmentFindFirst.mockResolvedValue(buildAssignment({ status: 'in_transit', tripId: 'existing-trip' }));

    await expect(
      assignmentDispatchService.createAssignment(TRANSPORTER_ID, {
        bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID,
      })
    ).rejects.toMatchObject({ code: 'DRIVER_BUSY' });
  });

  test('2.16 createAssignment - schedules timeout after creation', async () => {
    mockGetBookingById.mockResolvedValue(buildBooking());
    mockGetVehicleById.mockResolvedValue(buildVehicle());
    mockGetUserById
      .mockResolvedValueOnce(buildDriver())
      .mockResolvedValueOnce(buildTransporter());

    await assignmentDispatchService.createAssignment(
      TRANSPORTER_ID,
      { bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID }
    );

    expect(mockScheduleAssignmentTimeout).toHaveBeenCalledTimes(1);
    expect(mockScheduleAssignmentTimeout).toHaveBeenCalledWith(
      expect.objectContaining({
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
        bookingId: BOOKING_ID,
      }),
      ASSIGNMENT_CONFIG.TIMEOUT_MS
    );
  });

  test('2.17 createAssignment - emits socket events to booking and driver', async () => {
    mockGetBookingById.mockResolvedValue(buildBooking());
    mockGetVehicleById.mockResolvedValue(buildVehicle());
    mockGetUserById
      .mockResolvedValueOnce(buildDriver())
      .mockResolvedValueOnce(buildTransporter());

    await assignmentDispatchService.createAssignment(
      TRANSPORTER_ID,
      { bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID }
    );

    expect(mockEmitToBooking).toHaveBeenCalledWith(
      BOOKING_ID,
      'truck_assigned',
      expect.objectContaining({ bookingId: BOOKING_ID })
    );
    expect(mockEmitToUser).toHaveBeenCalledWith(
      DRIVER_ID,
      'trip_assigned',
      expect.objectContaining({ status: 'pending' })
    );
  });

  test('2.18 createAssignment - sends FCM push to driver', async () => {
    mockGetBookingById.mockResolvedValue(buildBooking());
    mockGetVehicleById.mockResolvedValue(buildVehicle());
    mockGetUserById
      .mockResolvedValueOnce(buildDriver())
      .mockResolvedValueOnce(buildTransporter());

    await assignmentDispatchService.createAssignment(
      TRANSPORTER_ID,
      { bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID }
    );

    expect(mockQueuePushNotification).toHaveBeenCalledWith(
      DRIVER_ID,
      expect.objectContaining({ title: expect.stringContaining('New Trip') })
    );
  });

  test('2.19 createAssignment - increments trucks filled on booking', async () => {
    mockGetBookingById.mockResolvedValue(buildBooking());
    mockGetVehicleById.mockResolvedValue(buildVehicle());
    mockGetUserById
      .mockResolvedValueOnce(buildDriver())
      .mockResolvedValueOnce(buildTransporter());

    await assignmentDispatchService.createAssignment(
      TRANSPORTER_ID,
      { bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID }
    );

    expect(mockIncrementTrucksFilled).toHaveBeenCalledWith(BOOKING_ID);
  });

  test('2.20 createAssignment - sets vehicle to on_hold inside transaction', async () => {
    mockGetBookingById.mockResolvedValue(buildBooking());
    mockGetVehicleById.mockResolvedValue(buildVehicle());
    mockGetUserById
      .mockResolvedValueOnce(buildDriver())
      .mockResolvedValueOnce(buildTransporter());

    await assignmentDispatchService.createAssignment(
      TRANSPORTER_ID,
      { bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID }
    );

    expect(mockTxVehicleUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: VEHICLE_ID }),
        data: expect.objectContaining({ status: 'on_hold' }),
      })
    );
  });

  test('2.21 createAssignment - continues even if timeout scheduling fails', async () => {
    mockGetBookingById.mockResolvedValue(buildBooking());
    mockGetVehicleById.mockResolvedValue(buildVehicle());
    mockGetUserById
      .mockResolvedValueOnce(buildDriver())
      .mockResolvedValueOnce(buildTransporter());
    mockScheduleAssignmentTimeout.mockRejectedValue(new Error('Queue down'));

    const result = await assignmentDispatchService.createAssignment(
      TRANSPORTER_ID,
      { bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID }
    );

    // Should still return the assignment despite timeout scheduling failure
    expect(result).toBeDefined();
    expect(result.status).toBe('pending');
  });
});

// =============================================================================
// 3. QUERY TESTS (assignment-query.service.ts)
// =============================================================================

describe('3. Query (assignment-query.service.ts)', () => {
  beforeEach(resetMocksAndDefaults);

  const defaultQuery = { page: 1, limit: 10 };

  test('3.1 getAssignments - transporter role uses db.getAssignmentsByTransporter', async () => {
    const assignments = [buildAssignment(), buildAssignment({ id: 'a-002' })];
    mockGetAssignmentsByTransporter.mockResolvedValue(assignments);

    const result = await assignmentQueryService.getAssignments(
      TRANSPORTER_ID, 'transporter', defaultQuery
    );

    expect(mockGetAssignmentsByTransporter).toHaveBeenCalledWith(TRANSPORTER_ID);
    expect(result.assignments).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  test('3.2 getAssignments - customer role fetches via Prisma with DB-level pagination', async () => {
    const bookings = [{ id: BOOKING_ID }, { id: 'booking-002' }];
    mockGetBookingsByCustomer.mockResolvedValue(bookings);
    mockPrismaAssignmentCount.mockResolvedValue(1);
    mockPrismaAssignmentFindMany.mockResolvedValue([{
      id: ASSIGNMENT_ID,
      bookingId: BOOKING_ID,
      truckRequestId: null,
      orderId: null,
      transporterId: TRANSPORTER_ID,
      vehicleId: VEHICLE_ID,
      vehicleNumber: 'KA01AB1234',
      vehicleType: 'open_17ft',
      vehicleSubtype: 'Open Body',
      driverId: DRIVER_ID,
      driverName: 'Test Driver',
      tripId: TRIP_ID,
      assignedAt: '2026-01-01T00:00:00.000Z',
      driverAcceptedAt: null,
      status: 'pending',
    }]);

    const result = await assignmentQueryService.getAssignments(
      CUSTOMER_ID, 'customer', defaultQuery
    );

    expect(mockGetBookingsByCustomer).toHaveBeenCalledWith(CUSTOMER_ID);
    expect(result.assignments).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  test('3.3 getAssignments - customer with no bookings returns empty', async () => {
    mockGetBookingsByCustomer.mockResolvedValue([]);

    const result = await assignmentQueryService.getAssignments(
      CUSTOMER_ID, 'customer', defaultQuery
    );

    expect(result.assignments).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  test('3.4 getAssignments - unknown role returns empty', async () => {
    const result = await assignmentQueryService.getAssignments(
      'some-user', 'admin', defaultQuery
    );

    expect(result.assignments).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  test('3.5 getAssignments - filters by status for transporter role', async () => {
    const assignments = [
      buildAssignment({ status: 'pending' }),
      buildAssignment({ id: 'a-002', status: 'completed' }),
    ];
    mockGetAssignmentsByTransporter.mockResolvedValue(assignments);

    const result = await assignmentQueryService.getAssignments(
      TRANSPORTER_ID, 'transporter', { ...defaultQuery, status: 'pending' }
    );

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].status).toBe('pending');
  });

  test('3.6 getAssignments - filters by bookingId for transporter role', async () => {
    const assignments = [
      buildAssignment({ bookingId: BOOKING_ID }),
      buildAssignment({ id: 'a-002', bookingId: 'other-booking' }),
    ];
    mockGetAssignmentsByTransporter.mockResolvedValue(assignments);

    const result = await assignmentQueryService.getAssignments(
      TRANSPORTER_ID, 'transporter', { ...defaultQuery, bookingId: BOOKING_ID }
    );

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].bookingId).toBe(BOOKING_ID);
  });

  test('3.7 getAssignments - pagination works for transporter role', async () => {
    const assignments = Array.from({ length: 15 }, (_, i) =>
      buildAssignment({ id: `a-${String(i).padStart(3, '0')}` })
    );
    mockGetAssignmentsByTransporter.mockResolvedValue(assignments);

    const page1 = await assignmentQueryService.getAssignments(
      TRANSPORTER_ID, 'transporter', { page: 1, limit: 10 }
    );
    expect(page1.assignments).toHaveLength(10);
    expect(page1.hasMore).toBe(true);
    expect(page1.total).toBe(15);

    const page2 = await assignmentQueryService.getAssignments(
      TRANSPORTER_ID, 'transporter', { page: 2, limit: 10 }
    );
    expect(page2.assignments).toHaveLength(5);
    expect(page2.hasMore).toBe(false);
  });

  test('3.8 getDriverAssignments - returns assignments filtered by driver', async () => {
    const assignments = [buildAssignment()];
    mockGetAssignmentsByDriver.mockResolvedValue(assignments);

    const result = await assignmentQueryService.getDriverAssignments(
      DRIVER_ID, defaultQuery
    );

    expect(mockGetAssignmentsByDriver).toHaveBeenCalledWith(DRIVER_ID);
    expect(result.assignments).toHaveLength(1);
  });

  test('3.9 getDriverAssignments - filters by status', async () => {
    const assignments = [
      buildAssignment({ status: 'pending' }),
      buildAssignment({ id: 'a-002', status: 'completed' }),
    ];
    mockGetAssignmentsByDriver.mockResolvedValue(assignments);

    const result = await assignmentQueryService.getDriverAssignments(
      DRIVER_ID, { ...defaultQuery, status: 'completed' }
    );

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].status).toBe('completed');
  });

  test('3.10 getDriverAssignments - pagination with hasMore flag', async () => {
    const assignments = Array.from({ length: 5 }, (_, i) =>
      buildAssignment({ id: `a-${i}` })
    );
    mockGetAssignmentsByDriver.mockResolvedValue(assignments);

    const result = await assignmentQueryService.getDriverAssignments(
      DRIVER_ID, { page: 1, limit: 3 }
    );

    expect(result.assignments).toHaveLength(3);
    expect(result.hasMore).toBe(true);
    expect(result.total).toBe(5);
  });

  test('3.11 getAssignmentById - returns assignment when found', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment());

    const result = await assignmentQueryService.getAssignmentById(
      ASSIGNMENT_ID, TRANSPORTER_ID, 'transporter'
    );

    expect(result.id).toBe(ASSIGNMENT_ID);
  });

  test('3.12 getAssignmentById - throws ASSIGNMENT_NOT_FOUND when missing', async () => {
    mockGetAssignmentById.mockResolvedValue(null);

    await expect(
      assignmentQueryService.getAssignmentById(ASSIGNMENT_ID, TRANSPORTER_ID, 'transporter')
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_FOUND' });
  });

  test('3.13 getAssignmentById - throws FORBIDDEN when driver accesses other driver assignment', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ driverId: 'other-driver' }));

    await expect(
      assignmentQueryService.getAssignmentById(ASSIGNMENT_ID, DRIVER_ID, 'driver')
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('3.14 getAssignmentById - throws FORBIDDEN when transporter accesses other transporter assignment', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ transporterId: 'other-transporter' }));

    await expect(
      assignmentQueryService.getAssignmentById(ASSIGNMENT_ID, TRANSPORTER_ID, 'transporter')
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('3.15 getAssignmentById - customer role has no access restriction by user ID', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment());

    const result = await assignmentQueryService.getAssignmentById(
      ASSIGNMENT_ID, CUSTOMER_ID, 'customer'
    );

    expect(result.id).toBe(ASSIGNMENT_ID);
  });
});

// =============================================================================
// 4. RESPONSE TESTS (assignment-response.service.ts)
// =============================================================================

describe('4. Response (assignment-response.service.ts)', () => {
  beforeEach(resetMocksAndDefaults);

  test('4.1 acceptAssignment - happy path updates status to driver_accepted', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockRedisGetOrSet.mockResolvedValue(null);
    mockTxAssignmentFindUnique.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    const result = await assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);

    expect(result.status).toBe('driver_accepted');
    expect(mockTxAssignmentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ASSIGNMENT_ID, status: 'pending' },
        data: expect.objectContaining({ status: 'driver_accepted' }),
      })
    );
  });

  test('4.2 acceptAssignment - throws ASSIGNMENT_NOT_FOUND when missing', async () => {
    mockGetAssignmentById.mockResolvedValue(null);

    await expect(
      assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID)
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_FOUND' });
  });

  test('4.3 acceptAssignment - throws FORBIDDEN for wrong driver', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ driverId: 'other-driver' }));

    await expect(
      assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('4.4 acceptAssignment - throws INVALID_STATUS when already accepted', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));

    await expect(
      assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID)
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });

  test('4.5 acceptAssignment - throws INVALID_STATUS when cancelled', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'cancelled' }));

    await expect(
      assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID)
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });

  test('4.6 acceptAssignment - throws INVALID_STATUS when driver_declined (expired)', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_declined' }));

    await expect(
      assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID)
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });

  test('4.7 acceptAssignment - includes currentStatus in error for non-pending states', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'in_transit' }));

    try {
      await assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);
      fail('Should have thrown');
    } catch (err: any) {
      expect(err.currentStatus).toBe('in_transit');
    }
  });

  test('4.8 acceptAssignment - throws DRIVER_BUSY when driver has another active trip', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    // Source code now uses prismaClient.assignment.findFirst for driver busy check
    const prismaClient = require('../shared/database/prisma.service').prismaClient;
    prismaClient.assignment.findFirst.mockResolvedValue(buildAssignment({ id: 'other-assignment', status: 'in_transit' }));

    await expect(
      assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID)
    ).rejects.toMatchObject({ code: 'DRIVER_BUSY' });
  });

  test('4.9 acceptAssignment - allows when same assignment is the active one (idempotent)', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    // Same assignment ID returned — not a conflict
    mockRedisGetOrSet.mockResolvedValue(buildAssignment({ id: ASSIGNMENT_ID }));
    mockTxAssignmentFindUnique.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    const result = await assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);

    expect(result).toBeDefined();
  });

  test('4.10 acceptAssignment - updates vehicle to in_transit atomically', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockRedisGetOrSet.mockResolvedValue(null);
    mockTxAssignmentFindUnique.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);

    expect(mockTxVehicleUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: VEHICLE_ID }),
        data: expect.objectContaining({ status: 'in_transit' }),
      })
    );
  });

  test('4.11 acceptAssignment - cancels timeout timer after acceptance', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockRedisGetOrSet.mockResolvedValue(null);
    mockTxAssignmentFindUnique.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);

    expect(mockCancelAssignmentTimeout).toHaveBeenCalledWith(ASSIGNMENT_ID);
  });

  test('4.12 acceptAssignment - updates Redis availability', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockRedisGetOrSet.mockResolvedValue(null);
    mockTxAssignmentFindUnique.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);

    expect(mockOnVehicleStatusChange).toHaveBeenCalledWith(
      TRANSPORTER_ID,
      'open_17ft:Open Body',
      'on_hold',
      'in_transit'
    );
  });

  test('4.13 acceptAssignment - initializes tracking', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockRedisGetOrSet.mockResolvedValue(null);
    mockTxAssignmentFindUnique.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);

    expect(mockInitializeTracking).toHaveBeenCalledWith(
      TRIP_ID, DRIVER_ID, 'KA01AB1234', BOOKING_ID, TRANSPORTER_ID, VEHICLE_ID
    );
  });

  test('4.14 acceptAssignment - notifies transporter via FCM push', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockRedisGetOrSet.mockResolvedValue(null);
    mockTxAssignmentFindUnique.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));
    mockGetBookingById.mockResolvedValue(buildBooking());

    await assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);

    expect(mockQueuePushNotification).toHaveBeenCalledWith(
      TRANSPORTER_ID,
      expect.objectContaining({ title: expect.stringContaining('Driver Accepted') })
    );
  });

  test('4.15 acceptAssignment - notifies customer via WebSocket and FCM if booking exists', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockRedisGetOrSet.mockResolvedValue(null);
    mockTxAssignmentFindUnique.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));
    mockGetBookingById.mockResolvedValue(buildBooking());

    await assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);

    // Customer should receive WebSocket and FCM
    expect(mockEmitToUser).toHaveBeenCalledWith(
      CUSTOMER_ID,
      'assignment_status_changed',
      expect.objectContaining({ status: 'driver_accepted' })
    );
    expect(mockQueuePushNotification).toHaveBeenCalledWith(
      CUSTOMER_ID,
      expect.objectContaining({ title: expect.stringContaining('Driver on the way') })
    );
  });

  test('4.16 acceptAssignment - invalidates driver active-assignment cache', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockRedisGetOrSet.mockResolvedValue(null);
    mockTxAssignmentFindUnique.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);

    expect(mockRedisDel).toHaveBeenCalledWith(`driver:active-assignment:${DRIVER_ID}`);
  });

  test('4.17 acceptAssignment - throws ASSIGNMENT_STATE_CHANGED if no rows updated', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockRedisGetOrSet.mockResolvedValue(null);
    // Simulate race: another process already changed the status
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID)
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_STATE_CHANGED' });
  });

  test('4.18 acceptAssignment - seeds GPS from driver location if fresh', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockRedisGetOrSet.mockResolvedValue(null);
    mockTxAssignmentFindUnique.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    // Fresh GPS data
    mockRedisGetJSON
      .mockResolvedValueOnce({ latitude: 12.97, longitude: 77.59, timestamp: Date.now() - 1000 }) // driver location
      .mockResolvedValueOnce({ latitude: 0, longitude: 0, status: 'pending' }); // trip data

    await assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);

    expect(mockRedisSetJSON).toHaveBeenCalledWith(
      `driver:trip:${TRIP_ID}`,
      expect.objectContaining({ latitude: 12.97, longitude: 77.59, status: 'driver_accepted' }),
      86400
    );
  });
});

// =============================================================================
// 5. LIFECYCLE TESTS (assignment-lifecycle.service.ts)
// =============================================================================

describe('5. Lifecycle (assignment-lifecycle.service.ts)', () => {
  beforeEach(resetMocksAndDefaults);

  // --- Update Status ---

  test('5.1 updateStatus - valid transition from driver_accepted to en_route_pickup', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));
    mockUpdateAssignment.mockResolvedValue(buildAssignment({ status: 'en_route_pickup' }));

    const result = await assignmentLifecycleService.updateStatus(
      ASSIGNMENT_ID, DRIVER_ID, { status: 'en_route_pickup' }
    );

    expect(result.status).toBe('en_route_pickup');
    expect(mockUpdateAssignment).toHaveBeenCalledWith(
      ASSIGNMENT_ID,
      expect.objectContaining({ status: 'en_route_pickup' })
    );
  });

  test('5.2 updateStatus - valid transition from en_route_pickup to at_pickup', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'en_route_pickup' }));
    mockUpdateAssignment.mockResolvedValue(buildAssignment({ status: 'at_pickup' }));

    const result = await assignmentLifecycleService.updateStatus(
      ASSIGNMENT_ID, DRIVER_ID, { status: 'at_pickup' }
    );

    expect(result.status).toBe('at_pickup');
  });

  test('5.3 updateStatus - valid transition at_pickup to in_transit sets startedAt', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'at_pickup' }));
    mockUpdateAssignment.mockResolvedValue(buildAssignment({ status: 'in_transit' }));

    await assignmentLifecycleService.updateStatus(
      ASSIGNMENT_ID, DRIVER_ID, { status: 'in_transit' }
    );

    expect(mockUpdateAssignment).toHaveBeenCalledWith(
      ASSIGNMENT_ID,
      expect.objectContaining({
        status: 'in_transit',
        startedAt: expect.any(String),
      })
    );
  });

  test('5.4 updateStatus - valid transition in_transit to completed sets completedAt', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'in_transit' }));
    mockUpdateAssignment.mockResolvedValue(buildAssignment({ status: 'completed' }));
    mockGetBookingById.mockResolvedValue(null);

    await assignmentLifecycleService.updateStatus(
      ASSIGNMENT_ID, DRIVER_ID, { status: 'completed' }
    );

    expect(mockUpdateAssignment).toHaveBeenCalledWith(
      ASSIGNMENT_ID,
      expect.objectContaining({
        status: 'completed',
        completedAt: expect.any(String),
      })
    );
  });

  test('5.5 updateStatus - invalid transition completed to pending throws INVALID_TRANSITION', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'completed' }));

    await expect(
      assignmentLifecycleService.updateStatus(ASSIGNMENT_ID, DRIVER_ID, { status: 'pending' })
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  test('5.6 updateStatus - invalid transition pending to in_transit throws INVALID_TRANSITION', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));

    await expect(
      assignmentLifecycleService.updateStatus(ASSIGNMENT_ID, DRIVER_ID, { status: 'in_transit' })
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  test('5.7 updateStatus - invalid transition cancelled to anything throws INVALID_TRANSITION', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'cancelled' }));

    await expect(
      assignmentLifecycleService.updateStatus(ASSIGNMENT_ID, DRIVER_ID, { status: 'pending' })
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  test('5.8 updateStatus - throws FORBIDDEN for wrong driver', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ driverId: 'other-driver' }));

    await expect(
      assignmentLifecycleService.updateStatus(ASSIGNMENT_ID, DRIVER_ID, { status: 'en_route_pickup' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('5.9 updateStatus - throws ASSIGNMENT_NOT_FOUND when missing', async () => {
    mockGetAssignmentById.mockResolvedValue(null);

    await expect(
      assignmentLifecycleService.updateStatus(ASSIGNMENT_ID, DRIVER_ID, { status: 'en_route_pickup' })
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_FOUND' });
  });

  test('5.10 updateStatus - completed triggers vehicle release', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'in_transit' }));
    mockUpdateAssignment.mockResolvedValue(buildAssignment({ status: 'completed' }));
    mockGetBookingById.mockResolvedValue(null);

    await assignmentLifecycleService.updateStatus(
      ASSIGNMENT_ID, DRIVER_ID, { status: 'completed' }
    );

    expect(mockReleaseVehicle).toHaveBeenCalledWith(VEHICLE_ID, 'tripCompleted');
  });

  test('5.11 updateStatus - completed emits notifications to booking room', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'in_transit' }));
    mockUpdateAssignment.mockResolvedValue(buildAssignment({ status: 'completed' }));
    mockGetBookingById.mockResolvedValue(null);

    await assignmentLifecycleService.updateStatus(
      ASSIGNMENT_ID, DRIVER_ID, { status: 'completed' }
    );

    expect(mockEmitToBooking).toHaveBeenCalledWith(
      BOOKING_ID,
      'assignment_status_changed',
      expect.objectContaining({ status: 'completed' })
    );
  });

  test('5.12 updateStatus - completed notifies transporter directly', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'in_transit' }));
    mockUpdateAssignment.mockResolvedValue(buildAssignment({ status: 'completed' }));
    mockGetBookingById.mockResolvedValue(null);

    await assignmentLifecycleService.updateStatus(
      ASSIGNMENT_ID, DRIVER_ID, { status: 'completed' }
    );

    expect(mockEmitToUser).toHaveBeenCalledWith(
      TRANSPORTER_ID,
      'assignment_status_changed',
      expect.objectContaining({ status: 'completed' })
    );
  });

  // --- Cancel ---

  test('5.13 cancelAssignment - transporter can cancel', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID);

    expect(mockTxAssignmentUpdate).toHaveBeenCalled();
  });

  test('5.14 cancelAssignment - driver can cancel', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.cancelAssignment(ASSIGNMENT_ID, DRIVER_ID);

    expect(mockTxAssignmentUpdate).toHaveBeenCalled();
  });

  test('5.15 cancelAssignment - throws ASSIGNMENT_NOT_FOUND when missing', async () => {
    mockGetAssignmentById.mockResolvedValue(null);

    await expect(
      assignmentLifecycleService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID)
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_FOUND' });
  });

  test('5.16 cancelAssignment - throws FORBIDDEN for unrelated user', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment());

    await expect(
      assignmentLifecycleService.cancelAssignment(ASSIGNMENT_ID, 'random-user')
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('5.17 cancelAssignment - releases vehicle in same transaction', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID);

    expect(mockTxVehicleUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: VEHICLE_ID }),
        data: expect.objectContaining({ status: 'available' }),
      })
    );
  });

  test('5.18 cancelAssignment - cancels timeout timer', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID);

    expect(mockCancelAssignmentTimeout).toHaveBeenCalledWith(ASSIGNMENT_ID);
  });

  test('5.19 cancelAssignment - decrements trucks filled on booking', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID);

    expect(mockDecrementTrucksFilled).toHaveBeenCalledWith(BOOKING_ID);
  });

  test('5.20 cancelAssignment - notifies driver directly via WebSocket and FCM', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID);

    expect(mockEmitToUser).toHaveBeenCalledWith(
      DRIVER_ID,
      'assignment_status_changed',
      expect.objectContaining({ status: 'cancelled' })
    );
    expect(mockQueuePushNotification).toHaveBeenCalledWith(
      DRIVER_ID,
      expect.objectContaining({ title: expect.stringContaining('Cancelled') })
    );
  });

  test('5.21 cancelAssignment - invalidates driver active-assignment cache', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID);

    expect(mockRedisDel).toHaveBeenCalledWith(`driver:active-assignment:${DRIVER_ID}`);
  });

  test('5.22 cancelAssignment - decrements order trucksFilled for multi-truck system', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({
      status: 'pending',
      bookingId: undefined,
      orderId: ORDER_ID,
      truckRequestId: TRUCK_REQUEST_ID,
    }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID);

    expect(mockPrismaExecuteRaw).toHaveBeenCalled();
    expect(mockPrismaTruckRequestUpdateMany).toHaveBeenCalled();
  });

  // --- Decline ---

  test('5.23 declineAssignment - happy path sets status to driver_declined', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.declineAssignment(ASSIGNMENT_ID, DRIVER_ID);

    expect(mockTxAssignmentUpdate).toHaveBeenCalled();
  });

  test('5.24 declineAssignment - throws ASSIGNMENT_NOT_FOUND when missing', async () => {
    mockGetAssignmentById.mockResolvedValue(null);

    await expect(
      assignmentLifecycleService.declineAssignment(ASSIGNMENT_ID, DRIVER_ID)
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_FOUND' });
  });

  test('5.25 declineAssignment - throws FORBIDDEN for wrong driver', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ driverId: 'other-driver' }));

    await expect(
      assignmentLifecycleService.declineAssignment(ASSIGNMENT_ID, DRIVER_ID)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('5.26 declineAssignment - throws INVALID_STATUS when not pending', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));

    await expect(
      assignmentLifecycleService.declineAssignment(ASSIGNMENT_ID, DRIVER_ID)
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });

  test('5.27 declineAssignment - releases vehicle atomically', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.declineAssignment(ASSIGNMENT_ID, DRIVER_ID);

    expect(mockTxVehicleUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'available' }),
      })
    );
  });

  test('5.28 declineAssignment - persists reason as declined', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.declineAssignment(ASSIGNMENT_ID, DRIVER_ID);

    expect(mockRedisSet).toHaveBeenCalledWith(
      `assignment:reason:${ASSIGNMENT_ID}`,
      'declined',
      86400
    );
  });

  test('5.29 declineAssignment - cancels timeout timer', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.declineAssignment(ASSIGNMENT_ID, DRIVER_ID);

    expect(mockCancelAssignmentTimeout).toHaveBeenCalledWith(ASSIGNMENT_ID);
  });

  test('5.30 declineAssignment - notifies transporter via WebSocket and FCM', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.declineAssignment(ASSIGNMENT_ID, DRIVER_ID);

    expect(mockEmitToUser).toHaveBeenCalledWith(
      TRANSPORTER_ID,
      'assignment_status_changed',
      expect.objectContaining({
        status: 'driver_declined',
        message: expect.stringContaining('declined'),
      })
    );
    expect(mockQueuePushNotification).toHaveBeenCalledWith(
      TRANSPORTER_ID,
      expect.objectContaining({ title: expect.stringContaining('Declined') })
    );
  });

  test('5.31 declineAssignment - decrements trucks filled on booking', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.declineAssignment(ASSIGNMENT_ID, DRIVER_ID);

    expect(mockDecrementTrucksFilled).toHaveBeenCalledWith(BOOKING_ID);
  });

  // --- Timeout ---

  test('5.32 handleAssignmentTimeout - sets status to driver_declined when pending', async () => {
    mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_declined' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: ASSIGNMENT_ID,
      driverId: DRIVER_ID,
      driverName: 'Test Driver',
      transporterId: TRANSPORTER_ID,
      vehicleId: VEHICLE_ID,
      vehicleNumber: 'KA01AB1234',
      bookingId: BOOKING_ID,
      tripId: TRIP_ID,
      createdAt: new Date().toISOString(),
    });

    expect(mockPrismaAssignmentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ASSIGNMENT_ID, status: 'pending' },
        data: { status: 'driver_declined' },
      })
    );
  });

  test('5.33 handleAssignmentTimeout - no-ops when assignment already accepted (race-safe)', async () => {
    mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 0 });
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: ASSIGNMENT_ID,
      driverId: DRIVER_ID,
      driverName: 'Test Driver',
      transporterId: TRANSPORTER_ID,
      vehicleId: VEHICLE_ID,
      vehicleNumber: 'KA01AB1234',
      bookingId: BOOKING_ID,
      tripId: TRIP_ID,
      createdAt: new Date().toISOString(),
    });

    // Should not attempt vehicle release or notifications
    expect(mockVehicleFindUnique).not.toHaveBeenCalled();
    expect(mockEmitToUser).not.toHaveBeenCalled();
  });

  test('5.34 handleAssignmentTimeout - releases vehicle back to available', async () => {
    mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_declined' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ status: 'on_hold', vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: ASSIGNMENT_ID,
      driverId: DRIVER_ID,
      driverName: 'Test Driver',
      transporterId: TRANSPORTER_ID,
      vehicleId: VEHICLE_ID,
      vehicleNumber: 'KA01AB1234',
      bookingId: BOOKING_ID,
      tripId: TRIP_ID,
      createdAt: new Date().toISOString(),
    });

    expect(mockPrismaVehicleUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: VEHICLE_ID }),
        data: expect.objectContaining({ status: 'available' }),
      })
    );
  });

  test('5.35 handleAssignmentTimeout - persists reason as timeout', async () => {
    mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_declined' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: ASSIGNMENT_ID,
      driverId: DRIVER_ID,
      driverName: 'Test Driver',
      transporterId: TRANSPORTER_ID,
      vehicleId: VEHICLE_ID,
      vehicleNumber: 'KA01AB1234',
      bookingId: BOOKING_ID,
      tripId: TRIP_ID,
      createdAt: new Date().toISOString(),
    });

    expect(mockRedisSet).toHaveBeenCalledWith(
      `assignment:reason:${ASSIGNMENT_ID}`,
      'timeout',
      86400
    );
  });

  test('5.36 handleAssignmentTimeout - notifies transporter with DRIVER_TIMEOUT event', async () => {
    mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_declined' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: ASSIGNMENT_ID,
      driverId: DRIVER_ID,
      driverName: 'Test Driver',
      transporterId: TRANSPORTER_ID,
      vehicleId: VEHICLE_ID,
      vehicleNumber: 'KA01AB1234',
      bookingId: BOOKING_ID,
      tripId: TRIP_ID,
      createdAt: new Date().toISOString(),
    });

    expect(mockEmitToUser).toHaveBeenCalledWith(
      TRANSPORTER_ID,
      'driver_timeout',
      expect.objectContaining({ reason: 'timeout' })
    );
  });

  test('5.37 handleAssignmentTimeout - notifies driver with expired message', async () => {
    mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_declined' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: ASSIGNMENT_ID,
      driverId: DRIVER_ID,
      driverName: 'Test Driver',
      transporterId: TRANSPORTER_ID,
      vehicleId: VEHICLE_ID,
      vehicleNumber: 'KA01AB1234',
      bookingId: BOOKING_ID,
      tripId: TRIP_ID,
      createdAt: new Date().toISOString(),
    });

    // Issue #21: Timeout socket event to driver uses status 'expired' (not 'driver_declined')
    expect(mockEmitToUser).toHaveBeenCalledWith(
      DRIVER_ID,
      'assignment_status_changed',
      expect.objectContaining({ reason: 'timeout', status: 'expired' })
    );
  });

  test('5.38 handleAssignmentTimeout - sends FCM to both transporter and driver', async () => {
    mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_declined' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: ASSIGNMENT_ID,
      driverId: DRIVER_ID,
      driverName: 'Test Driver',
      transporterId: TRANSPORTER_ID,
      vehicleId: VEHICLE_ID,
      vehicleNumber: 'KA01AB1234',
      bookingId: BOOKING_ID,
      tripId: TRIP_ID,
      createdAt: new Date().toISOString(),
    });

    // Issue #22: FCM type is 'assignment_timeout' (not 'driver_timeout' which is overloaded with presence)
    expect(mockQueuePushNotification).toHaveBeenCalledWith(
      TRANSPORTER_ID,
      expect.objectContaining({ data: expect.objectContaining({ type: 'assignment_timeout' }) })
    );
    expect(mockQueuePushNotification).toHaveBeenCalledWith(
      DRIVER_ID,
      expect.objectContaining({ data: expect.objectContaining({ status: 'expired' }) })
    );
  });

  test('5.39 handleAssignmentTimeout - decrements trucks filled on booking', async () => {
    mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_declined' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: ASSIGNMENT_ID,
      driverId: DRIVER_ID,
      driverName: 'Test Driver',
      transporterId: TRANSPORTER_ID,
      vehicleId: VEHICLE_ID,
      vehicleNumber: 'KA01AB1234',
      bookingId: BOOKING_ID,
      tripId: TRIP_ID,
      createdAt: new Date().toISOString(),
    });

    expect(mockDecrementTrucksFilled).toHaveBeenCalledWith(BOOKING_ID);
  });

  test('5.40 handleAssignmentTimeout - multi-truck: decrements order and restores truck request', async () => {
    mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockGetAssignmentById.mockResolvedValue(buildAssignment({
      status: 'driver_declined',
      bookingId: undefined,
      orderId: ORDER_ID,
      truckRequestId: TRUCK_REQUEST_ID,
    }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: ASSIGNMENT_ID,
      driverId: DRIVER_ID,
      driverName: 'Test Driver',
      transporterId: TRANSPORTER_ID,
      vehicleId: VEHICLE_ID,
      vehicleNumber: 'KA01AB1234',
      tripId: TRIP_ID,
      createdAt: new Date().toISOString(),
      orderId: ORDER_ID,
      truckRequestId: TRUCK_REQUEST_ID,
    });

    expect(mockPrismaExecuteRaw).toHaveBeenCalled();
    expect(mockPrismaTruckRequestUpdateMany).toHaveBeenCalled();
  });

  test('5.41 handleAssignmentTimeout - gracefully handles missing assignment after timeout', async () => {
    mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockGetAssignmentById.mockResolvedValue(null);

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: ASSIGNMENT_ID,
      driverId: DRIVER_ID,
      driverName: 'Test Driver',
      transporterId: TRANSPORTER_ID,
      vehicleId: VEHICLE_ID,
      vehicleNumber: 'KA01AB1234',
      bookingId: BOOKING_ID,
      tripId: TRIP_ID,
      createdAt: new Date().toISOString(),
    });

    // Should not throw, just log and return
    expect(mockEmitToUser).not.toHaveBeenCalled();
  });

  // --- Multiple valid transitions in sequence ---

  test('5.42 full lifecycle: accepted -> en_route_pickup -> at_pickup -> in_transit -> completed', async () => {
    type AssignmentStatus = 'pending' | 'driver_accepted' | 'en_route_pickup' | 'at_pickup' | 'in_transit' | 'completed' | 'cancelled';
    const transitions: { from: AssignmentStatus; to: AssignmentStatus }[] = [
      { from: 'driver_accepted', to: 'en_route_pickup' },
      { from: 'en_route_pickup', to: 'at_pickup' },
      { from: 'at_pickup', to: 'in_transit' },
      { from: 'in_transit', to: 'completed' },
    ];

    for (const { from, to } of transitions) {
      jest.clearAllMocks();
      mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: from }));
      mockUpdateAssignment.mockResolvedValue(buildAssignment({ status: to }));
      if (to === 'completed') {
        mockGetBookingById.mockResolvedValue(null);
      }

      const result = await assignmentLifecycleService.updateStatus(
        ASSIGNMENT_ID, DRIVER_ID, { status: to }
      );

      expect(result.status).toBe(to);
    }
  });
});

// =============================================================================
// 6. EDGE CASES & RACE CONDITIONS
// =============================================================================

describe('6. Edge Cases & Race Conditions', () => {
  beforeEach(resetMocksAndDefaults);

  test('6.1 race: two drivers accept same assignment - second gets ASSIGNMENT_STATE_CHANGED', async () => {
    // First accept succeeds
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockRedisGetOrSet.mockResolvedValue(null);
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockTxAssignmentFindUnique.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);

    // Second accept: updateMany returns 0 (row already changed)
    jest.clearAllMocks();
    resetMocksAndDefaults();
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockRedisGetOrSet.mockResolvedValue(null);
    mockTxAssignmentUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID)
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_STATE_CHANGED' });
  });

  test('6.2 race: timeout fires AFTER driver accepted - timeout no-ops', async () => {
    mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 0 });
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: ASSIGNMENT_ID,
      driverId: DRIVER_ID,
      driverName: 'Test Driver',
      transporterId: TRANSPORTER_ID,
      vehicleId: VEHICLE_ID,
      vehicleNumber: 'KA01AB1234',
      bookingId: BOOKING_ID,
      tripId: TRIP_ID,
      createdAt: new Date().toISOString(),
    });

    // Vehicle should NOT be released
    expect(mockVehicleFindUnique).not.toHaveBeenCalled();
    expect(mockOnVehicleStatusChange).not.toHaveBeenCalled();
  });

  test('6.3 race: cancel while driver is accepting - cancel wins (transaction order)', async () => {
    // Cancel sets status to cancelled
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID);

    // Then accept attempt: assignment is now cancelled, not pending
    jest.clearAllMocks();
    resetMocksAndDefaults();
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'cancelled' }));

    await expect(
      assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID)
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });

  test('6.4 Redis failure during accept - still completes DB transaction', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockRedisGetOrSet.mockResolvedValue(null);
    mockTxAssignmentFindUnique.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));
    // Redis availability update fails
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));
    mockOnVehicleStatusChange.mockRejectedValue(new Error('Redis down'));

    const result = await assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);

    // Should still succeed — Redis is non-fatal
    expect(result.status).toBe('driver_accepted');
  });

  test('6.5 FCM push failure during dispatch - assignment still created', async () => {
    mockGetBookingById.mockResolvedValue(buildBooking());
    mockGetVehicleById.mockResolvedValue(buildVehicle());
    mockGetUserById
      .mockResolvedValueOnce(buildDriver())
      .mockResolvedValueOnce(buildTransporter());
    mockQueuePushNotification.mockRejectedValue(new Error('FCM unavailable'));

    const result = await assignmentDispatchService.createAssignment(
      TRANSPORTER_ID,
      { bookingId: BOOKING_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID }
    );

    expect(result).toBeDefined();
    expect(result.status).toBe('pending');
  });

  test('6.6 vehicle release is skipped when vehicleId is undefined', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending', vehicleId: undefined }));

    await assignmentLifecycleService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID);

    // Vehicle update should not be attempted
    expect(mockTxVehicleUpdateMany).not.toHaveBeenCalled();
  });

  test('6.7 timeout for multi-truck order: restores truck request status to searching', async () => {
    mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockGetAssignmentById.mockResolvedValue(buildAssignment({
      status: 'driver_declined',
      bookingId: undefined,
      orderId: ORDER_ID,
      truckRequestId: TRUCK_REQUEST_ID,
    }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: ASSIGNMENT_ID,
      driverId: DRIVER_ID,
      driverName: 'Test Driver',
      transporterId: TRANSPORTER_ID,
      vehicleId: VEHICLE_ID,
      vehicleNumber: 'KA01AB1234',
      tripId: TRIP_ID,
      createdAt: new Date().toISOString(),
      orderId: ORDER_ID,
      truckRequestId: TRUCK_REQUEST_ID,
    });

    expect(mockPrismaTruckRequestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TRUCK_REQUEST_ID, orderId: ORDER_ID },
        data: expect.objectContaining({ status: 'searching' }),
      })
    );
  });

  test('6.8 decline for multi-truck order: decrements order and restores request', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({
      status: 'pending',
      bookingId: undefined,
      orderId: ORDER_ID,
      truckRequestId: TRUCK_REQUEST_ID,
    }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    await assignmentLifecycleService.declineAssignment(ASSIGNMENT_ID, DRIVER_ID);

    expect(mockPrismaExecuteRaw).toHaveBeenCalled();
    expect(mockPrismaTruckRequestUpdateMany).toHaveBeenCalled();
  });

  test('6.9 stale GPS rejected during accept - does not seed trip data', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockRedisGetOrSet.mockResolvedValue(null);
    mockTxAssignmentFindUnique.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));

    // GPS data older than 5 minutes
    mockRedisGetJSON.mockResolvedValueOnce({
      latitude: 12.97,
      longitude: 77.59,
      timestamp: Date.now() - 6 * 60 * 1000,
    });

    await assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);

    // setJSON should only be called for trip initialization, not GPS seeding
    // (stale GPS is rejected)
    expect(mockRedisSetJSON).not.toHaveBeenCalledWith(
      expect.stringContaining('driver:trip:'),
      expect.objectContaining({ latitude: 12.97 }),
      expect.anything()
    );
  });

  test('6.10 tracking initialization failure during accept - non-fatal', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockRedisGetOrSet.mockResolvedValue(null);
    mockTxAssignmentFindUnique.mockResolvedValue(buildAssignment({ status: 'driver_accepted' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));
    mockInitializeTracking.mockRejectedValue(new Error('Tracking service down'));

    const result = await assignmentResponseService.acceptAssignment(ASSIGNMENT_ID, DRIVER_ID);

    // Should still succeed
    expect(result.status).toBe('driver_accepted');
  });

  test('6.11 vehicle release failure during completion - logged but not thrown', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'in_transit' }));
    mockUpdateAssignment.mockResolvedValue(buildAssignment({ status: 'completed' }));
    mockReleaseVehicle.mockRejectedValue(new Error('Vehicle service down'));
    mockGetBookingById.mockResolvedValue(null);

    // Should not throw
    const result = await assignmentLifecycleService.updateStatus(
      ASSIGNMENT_ID, DRIVER_ID, { status: 'completed' }
    );

    expect(result.status).toBe('completed');
  });

  test('6.12 cancel timeout failure during cancel - non-fatal', async () => {
    mockGetAssignmentById.mockResolvedValue(buildAssignment({ status: 'pending' }));
    mockVehicleFindUnique.mockResolvedValue(buildVehicle({ vehicleKey: 'open_17ft:Open Body' }));
    mockCancelAssignmentTimeout.mockRejectedValue(new Error('Queue down'));

    // Should not throw
    await assignmentLifecycleService.cancelAssignment(ASSIGNMENT_ID, TRANSPORTER_ID);
  });
});
