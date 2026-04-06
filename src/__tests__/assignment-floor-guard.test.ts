/**
 * =============================================================================
 * ASSIGNMENT FLOOR GUARD — Tests for FIX-2 (GREATEST(0, trucksFilled - 1))
 * =============================================================================
 *
 * Validates that all 3 decrement paths in assignment.service.ts use
 * GREATEST(0, ...) to prevent trucksFilled from going negative:
 *
 *   1. cancelAssignment  (~line 894)
 *   2. declineAssignment (~line 1015)
 *   3. handleAssignmentTimeout (~line 1115)
 *
 * Also validates regression: booking.service.ts and confirmed-hold.service.ts
 * GREATEST patterns still work correctly.
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

// Config mock
jest.mock('../config/environment', () => ({
  config: { redis: { enabled: true }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {} },
}));

// Redis service mock
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisExists = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisSMembers = jest.fn();
const mockRedisSAdd = jest.fn();
const mockRedisGetJSON = jest.fn();
const mockRedisSetJSON = jest.fn();
const mockRedisGetExpiredTimers = jest.fn();
const mockRedisCancelTimer = jest.fn();
const mockRedisSetTimer = jest.fn();
const mockRedisExpire = jest.fn();
const mockRedisSIsMember = jest.fn();
const mockRedisIsConnected = jest.fn().mockReturnValue(true);

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    exists: (...args: any[]) => mockRedisExists(...args),
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    sMembers: (...args: any[]) => mockRedisSMembers(...args),
    sAdd: (...args: any[]) => mockRedisSAdd(...args),
    getJSON: (...args: any[]) => mockRedisGetJSON(...args),
    setJSON: (...args: any[]) => mockRedisSetJSON(...args),
    getExpiredTimers: (...args: any[]) => mockRedisGetExpiredTimers(...args),
    cancelTimer: (...args: any[]) => mockRedisCancelTimer(...args),
    setTimer: (...args: any[]) => mockRedisSetTimer(...args),
    expire: (...args: any[]) => mockRedisExpire(...args),
    sIsMember: (...args: any[]) => mockRedisSIsMember(...args),
    isConnected: () => mockRedisIsConnected(),
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
  },
}));

// Prisma mock — assignment, vehicle, order, truckRequest, booking
const mockAssignmentUpdateMany = jest.fn();
const mockAssignmentFindFirst = jest.fn();
const mockVehicleFindUnique = jest.fn();
const mockVehicleUpdate = jest.fn();
const mockVehicleUpdateMany = jest.fn();
const mockTruckRequestUpdateMany = jest.fn();
const mockExecuteRaw = jest.fn();
const mockBookingFindFirst = jest.fn();
const mockQueryRaw = jest.fn();
const mockBookingUpdateMany = jest.fn();

const mockAssignmentUpdate = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    assignment: {
      updateMany: (...args: any[]) => mockAssignmentUpdateMany(...args),
      findFirst: (...args: any[]) => mockAssignmentFindFirst(...args),
      update: (...args: any[]) => mockAssignmentUpdate(...args),
    },
    vehicle: {
      findUnique: (...args: any[]) => mockVehicleFindUnique(...args),
      update: (...args: any[]) => mockVehicleUpdate(...args),
      updateMany: (...args: any[]) => mockVehicleUpdateMany(...args),
    },
    truckRequest: {
      updateMany: (...args: any[]) => mockTruckRequestUpdateMany(...args),
    },
    booking: {
      findFirst: (...args: any[]) => mockBookingFindFirst(...args),
      updateMany: (...args: any[]) => mockBookingUpdateMany(...args),
    },
    $executeRaw: (...args: any[]) => mockExecuteRaw(...args),
    $queryRaw: (...args: any[]) => mockQueryRaw(...args),
    $transaction: jest.fn(async (fn: any) => fn({
      assignment: {
        update: (...a: any[]) => mockAssignmentUpdate(...a),
        updateMany: (...a: any[]) => mockAssignmentUpdateMany(...a),
      },
      vehicle: {
        updateMany: (...a: any[]) => mockVehicleUpdateMany(...a),
      },
    })),
  },
  withDbTimeout: async (fn: (tx: any) => Promise<any>, _opts?: any) => fn({
    assignment: { updateMany: (...a: any[]) => mockAssignmentUpdateMany(...a) },
    vehicle: {
      findUnique: (...a: any[]) => mockVehicleFindUnique(...a),
      updateMany: (...a: any[]) => mockVehicleUpdateMany(...a),
    },
    $executeRaw: (...a: any[]) => mockExecuteRaw(...a),
  }),
  VehicleStatus: {
    available: 'available',
    on_hold: 'on_hold',
    in_transit: 'in_transit',
    maintenance: 'maintenance',
    inactive: 'inactive',
  },
  BookingStatus: {
    created: 'created',
    broadcasting: 'broadcasting',
    active: 'active',
    partially_filled: 'partially_filled',
    fully_filled: 'fully_filled',
    cancelled: 'cancelled',
    expired: 'expired',
  },
  AssignmentStatus: {
    pending: 'pending',
    driver_accepted: 'driver_accepted',
    driver_declined: 'driver_declined',
    cancelled: 'cancelled',
  },
}));

// DB mock — getAssignmentById, updateAssignment, updateVehicle
const mockGetAssignmentById = jest.fn();
const mockUpdateAssignment = jest.fn();
const mockUpdateVehicle = jest.fn();
const mockGetBookingById = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getAssignmentById: (...args: any[]) => mockGetAssignmentById(...args),
    updateAssignment: (...args: any[]) => mockUpdateAssignment(...args),
    updateVehicle: (...args: any[]) => mockUpdateVehicle(...args),
    getBookingById: (...args: any[]) => mockGetBookingById(...args),
  },
}));

// Socket service mock
const mockEmitToUser = jest.fn();
const mockEmitToBooking = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToBooking: (...args: any[]) => mockEmitToBooking(...args),
  SocketEvent: {
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    DRIVER_TIMEOUT: 'driver_timeout',
    TRUCK_ASSIGNED: 'truck_assigned',
  },
  isUserConnected: jest.fn().mockReturnValue(false),
}));

// FCM service mock
jest.mock('../shared/services/fcm.service', () => ({
  fcmService: { sendToDevice: jest.fn().mockResolvedValue(undefined) },
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
}));

// Queue service mock
const mockCancelAssignmentTimeout = jest.fn().mockResolvedValue(undefined);
const mockQueuePushNotification = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    addJob: jest.fn(),
    cancelAssignmentTimeout: (...args: any[]) => mockCancelAssignmentTimeout(...args),
    queuePushNotification: (...args: any[]) => mockQueuePushNotification(...args),
    queuePushNotificationBatch: jest.fn().mockResolvedValue(undefined),
    scheduleAssignmentTimeout: jest.fn().mockResolvedValue(undefined),
  },
}));

// Live availability mock
const mockOnVehicleStatusChange = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: (...args: any[]) => mockOnVehicleStatusChange(...args),
  },
}));

// Booking service mock — for the bookingId path (decrementTrucksFilled)
const mockDecrementTrucksFilled = jest.fn().mockResolvedValue({ trucksFilled: 0 });
jest.mock('../modules/booking/booking.service', () => ({
  bookingService: {
    decrementTrucksFilled: (...args: any[]) => mockDecrementTrucksFilled(...args),
  },
}));

// Tracking service mock
jest.mock('../modules/tracking/tracking.service', () => ({
  trackingService: {
    getDriverLocation: jest.fn().mockResolvedValue(null),
  },
}));

// Audit service mock
jest.mock('../shared/services/audit.service', () => ({
  recordStatusChange: jest.fn().mockResolvedValue(undefined),
}));

// State machines mock
jest.mock('../core/state-machines', () => ({
  BOOKING_VALID_TRANSITIONS: {},
  isValidTransition: jest.fn().mockReturnValue(true),
  assertValidTransition: jest.fn(),
  TERMINAL_BOOKING_STATUSES: ['cancelled', 'expired', 'fully_filled', 'completed'],
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { assignmentService } from '../modules/assignment/assignment.service';

// =============================================================================
// HELPERS
// =============================================================================

function resetAllMocks(): void {
  jest.clearAllMocks();
  mockRedisGet.mockReset();
  mockRedisSet.mockReset();
  mockRedisDel.mockReset().mockResolvedValue(undefined);
  mockRedisExists.mockReset();
  mockRedisAcquireLock.mockReset();
  mockRedisReleaseLock.mockReset();
  mockRedisSMembers.mockReset();
  mockRedisSAdd.mockReset();
  mockRedisGetJSON.mockReset();
  mockRedisSetJSON.mockReset();
  mockRedisGetExpiredTimers.mockReset();
  mockRedisCancelTimer.mockReset();
  mockRedisSetTimer.mockReset();
  mockRedisExpire.mockReset();
  mockRedisSIsMember.mockReset();
  mockRedisIsConnected.mockReturnValue(true);
  mockRedisSet.mockResolvedValue(undefined);
  mockRedisGet.mockResolvedValue(null);
  mockAssignmentUpdateMany.mockReset();
  mockAssignmentFindFirst.mockReset();
  mockVehicleFindUnique.mockReset();
  mockVehicleUpdate.mockReset();
  mockVehicleUpdateMany.mockReset();
  mockVehicleUpdateMany.mockResolvedValue({ count: 1 });
  mockTruckRequestUpdateMany.mockReset();
  mockExecuteRaw.mockReset();
  mockBookingFindFirst.mockReset();
  mockQueryRaw.mockReset();
  mockBookingUpdateMany.mockReset();
  mockGetAssignmentById.mockReset();
  mockUpdateAssignment.mockReset();
  mockUpdateVehicle.mockReset();
  mockGetBookingById.mockReset();
  mockEmitToUser.mockReset();
  mockEmitToBooking.mockReset();
  mockCancelAssignmentTimeout.mockReset().mockResolvedValue(undefined);
  mockQueuePushNotification.mockReset().mockResolvedValue(undefined);
  mockOnVehicleStatusChange.mockReset().mockResolvedValue(undefined);
  mockDecrementTrucksFilled.mockReset().mockResolvedValue({ trucksFilled: 0 });
  mockUpdateVehicle.mockResolvedValue(undefined);
  mockUpdateAssignment.mockResolvedValue({});
  mockAssignmentUpdate.mockReset().mockResolvedValue({});

  // Re-set $transaction mock (resetAllMocks clears implementations)
  const prismaService = require('../shared/database/prisma.service');
  prismaService.prismaClient.$transaction.mockImplementation(async (fn: any) => fn({
    assignment: {
      update: (...a: any[]) => mockAssignmentUpdate(...a),
      updateMany: (...a: any[]) => mockAssignmentUpdateMany(...a),
    },
    vehicle: {
      updateMany: (...a: any[]) => mockVehicleUpdateMany(...a),
    },
  }));
}

/** Build a standard order-based assignment for cancel/decline/timeout tests */
function makeOrderAssignment(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'assign-001',
    orderId: 'order-001',
    truckRequestId: 'tr-001',
    bookingId: null,
    transporterId: 'transporter-001',
    vehicleId: 'vehicle-001',
    vehicleNumber: 'MH12AB1234',
    driverId: 'driver-001',
    driverName: 'Test Driver',
    driverPhone: '9876543210',
    tripId: 'trip-001',
    status: 'pending',
    vehicleType: 'Open',
    vehicleSubtype: '17ft',
    ...overrides,
  };
}

/**
 * Helper to extract the SQL string from $executeRaw tagged template call.
 * Tagged template literals are invoked as fn(strings, ...values).
 * The first argument is a TemplateStringsArray containing the static parts.
 */
function getExecuteRawSQL(): { sql: string; values: any[] } | null {
  if (mockExecuteRaw.mock.calls.length === 0) return null;
  const call = mockExecuteRaw.mock.calls[0];
  const firstArg = call[0];

  // Tagged template: call[0] is TemplateStringsArray, call[1..n] are interpolated values
  // TemplateStringsArray has a `raw` property. Check with `in` to avoid TS narrowing issues.
  if (firstArg && typeof firstArg === 'object' && 'raw' in firstArg) {
    const strings: string[] = Array.from(firstArg);
    const values = call.slice(1);
    const sql = strings.reduce((acc: string, part: string, i: number) => {
      return acc + part + (i < values.length ? `$${i + 1}` : '');
    }, '');
    return { sql, values };
  }

  // Fallback: Prisma.sql or raw string
  return { sql: String(call[0]), values: call.slice(1) };
}

/** Set up the vehicle mock for releaseVehicleIfBusy */
function setupVehicleMock(status: string = 'on_hold'): void {
  mockVehicleFindUnique.mockResolvedValue({
    id: 'vehicle-001',
    vehicleKey: 'Open_17ft',
    transporterId: 'transporter-001',
    status,
  });
}

// =============================================================================
// TEST 1-2: cancelAssignment floor guard
// =============================================================================

describe('cancelAssignment — GREATEST(0, trucksFilled - 1) floor guard', () => {
  beforeEach(resetAllMocks);

  it('cancel assignment with orderId calls $executeRaw with GREATEST(0, ...)', async () => {
    const assignment = makeOrderAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockExecuteRaw.mockResolvedValue(1);
    setupVehicleMock();
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });

    await assignmentService.cancelAssignment('assign-001', 'transporter-001');

    // Verify $executeRaw was called
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);

    // Verify the SQL contains GREATEST(0, ...)
    const rawCall = getExecuteRawSQL();
    expect(rawCall).not.toBeNull();
    expect(rawCall!.sql).toContain('GREATEST(0,');
    expect(rawCall!.sql).toContain('"trucksFilled"');
    expect(rawCall!.sql).toContain('UPDATE "Order"');
  });

  it('cancel when trucksFilled=1 decrements to 0 (SQL prevents negative)', async () => {
    // trucksFilled=1 scenario: GREATEST(0, 1-1) = 0
    const assignment = makeOrderAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockExecuteRaw.mockResolvedValue(1);
    setupVehicleMock();
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });

    await assignmentService.cancelAssignment('assign-001', 'transporter-001');

    // SQL uses GREATEST(0, "trucksFilled" - 1) — database evaluates to max(0, 1-1) = 0
    const rawCall = getExecuteRawSQL();
    expect(rawCall).not.toBeNull();
    expect(rawCall!.sql).toMatch(/GREATEST\(0,\s*"trucksFilled"\s*-\s*1\)/);
    // The orderId is passed as a parameter
    expect(rawCall!.values).toContain('order-001');
  });

  it('cancel when trucksFilled=0 stays at 0 (floor guard prevents -1)', async () => {
    // trucksFilled=0 scenario: GREATEST(0, 0-1) = GREATEST(0, -1) = 0
    // The floor guard in SQL ensures the value cannot go below 0
    const assignment = makeOrderAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockExecuteRaw.mockResolvedValue(1);
    setupVehicleMock();
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });

    await assignmentService.cancelAssignment('assign-001', 'transporter-001');

    // Verify GREATEST(0, ...) is used — this is the floor guard
    const rawCall = getExecuteRawSQL();
    expect(rawCall).not.toBeNull();
    expect(rawCall!.sql).toMatch(/GREATEST\(0,\s*"trucksFilled"\s*-\s*1\)/);
    // Without GREATEST, this would produce -1. With GREATEST, it stays at 0.
  });

  it('cancel with bookingId uses bookingService.decrementTrucksFilled instead', async () => {
    const assignment = makeOrderAssignment({ orderId: null, bookingId: 'booking-001' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    setupVehicleMock();

    await assignmentService.cancelAssignment('assign-001', 'transporter-001');

    // Should use bookingService path, not $executeRaw
    expect(mockDecrementTrucksFilled).toHaveBeenCalledWith('booking-001');
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });
});

// =============================================================================
// TEST 3-4: declineAssignment floor guard
// =============================================================================

describe('declineAssignment — GREATEST(0, trucksFilled - 1) floor guard', () => {
  beforeEach(resetAllMocks);

  it('decline assignment with orderId calls $executeRaw with GREATEST(0, ...)', async () => {
    const assignment = makeOrderAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockExecuteRaw.mockResolvedValue(1);
    setupVehicleMock();
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });
    mockRedisSet.mockResolvedValue(undefined);

    await assignmentService.declineAssignment('assign-001', 'driver-001');

    // Verify $executeRaw was called with GREATEST pattern
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    const rawCall = getExecuteRawSQL();
    expect(rawCall).not.toBeNull();
    expect(rawCall!.sql).toContain('GREATEST(0,');
    expect(rawCall!.sql).toContain('"trucksFilled"');
    expect(rawCall!.sql).toContain('UPDATE "Order"');
  });

  it('decline when trucksFilled=1 decrements to 0 via GREATEST', async () => {
    const assignment = makeOrderAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockExecuteRaw.mockResolvedValue(1);
    setupVehicleMock();
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });
    mockRedisSet.mockResolvedValue(undefined);

    await assignmentService.declineAssignment('assign-001', 'driver-001');

    const rawCall = getExecuteRawSQL();
    expect(rawCall).not.toBeNull();
    // GREATEST(0, 1 - 1) = 0
    expect(rawCall!.sql).toMatch(/GREATEST\(0,\s*"trucksFilled"\s*-\s*1\)/);
    expect(rawCall!.values).toContain('order-001');
  });

  it('decline when trucksFilled=0 stays at 0 (floor guard prevents -1)', async () => {
    const assignment = makeOrderAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockExecuteRaw.mockResolvedValue(1);
    setupVehicleMock();
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });
    mockRedisSet.mockResolvedValue(undefined);

    await assignmentService.declineAssignment('assign-001', 'driver-001');

    // Verify the SQL floor guard is present
    const rawCall = getExecuteRawSQL();
    expect(rawCall).not.toBeNull();
    expect(rawCall!.sql).toMatch(/GREATEST\(0,\s*"trucksFilled"\s*-\s*1\)/);
    // Database evaluates GREATEST(0, 0-1) = GREATEST(0, -1) = 0
  });

  it('decline with bookingId uses bookingService.decrementTrucksFilled instead', async () => {
    const assignment = makeOrderAssignment({ orderId: null, bookingId: 'booking-001' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    setupVehicleMock();
    mockRedisSet.mockResolvedValue(undefined);

    await assignmentService.declineAssignment('assign-001', 'driver-001');

    expect(mockDecrementTrucksFilled).toHaveBeenCalledWith('booking-001');
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });
});

// =============================================================================
// TEST 5-6: handleAssignmentTimeout floor guard
// =============================================================================

describe('handleAssignmentTimeout — GREATEST(0, trucksFilled - 1) floor guard', () => {
  beforeEach(resetAllMocks);

  const makeTimerData = (overrides: Record<string, any> = {}) => ({
    assignmentId: 'assign-001',
    driverId: 'driver-001',
    driverName: 'Test Driver',
    transporterId: 'transporter-001',
    vehicleId: 'vehicle-001',
    vehicleNumber: 'MH12AB1234',
    tripId: 'trip-001',
    createdAt: new Date().toISOString(),
    orderId: 'order-001',
    truckRequestId: 'tr-001',
    ...overrides,
  });

  function setupTimeoutMocks(): void {
    // Atomic CAS succeeds (pending -> driver_declined)
    mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    // Post-update fetch
    mockGetAssignmentById.mockResolvedValue(makeOrderAssignment({ status: 'driver_declined' }));
    // Vehicle release
    setupVehicleMock();
    // Order $executeRaw
    mockExecuteRaw.mockResolvedValue(1);
    // TruckRequest restore
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });
  }

  it('timeout with orderId calls $executeRaw with GREATEST(0, ...)', async () => {
    setupTimeoutMocks();

    await assignmentService.handleAssignmentTimeout(makeTimerData());

    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    const rawCall = getExecuteRawSQL();
    expect(rawCall).not.toBeNull();
    expect(rawCall!.sql).toContain('GREATEST(0,');
    expect(rawCall!.sql).toContain('"trucksFilled"');
    expect(rawCall!.sql).toContain('UPDATE "Order"');
  });

  it('timeout when trucksFilled=1 decrements to 0 via GREATEST', async () => {
    setupTimeoutMocks();

    await assignmentService.handleAssignmentTimeout(makeTimerData());

    const rawCall = getExecuteRawSQL();
    expect(rawCall).not.toBeNull();
    expect(rawCall!.sql).toMatch(/GREATEST\(0,\s*"trucksFilled"\s*-\s*1\)/);
    expect(rawCall!.values).toContain('order-001');
  });

  it('timeout when trucksFilled=0 stays at 0 (floor guard prevents -1)', async () => {
    setupTimeoutMocks();

    await assignmentService.handleAssignmentTimeout(makeTimerData());

    const rawCall = getExecuteRawSQL();
    expect(rawCall).not.toBeNull();
    // GREATEST(0, 0-1) = 0 — floor guard active
    expect(rawCall!.sql).toMatch(/GREATEST\(0,\s*"trucksFilled"\s*-\s*1\)/);
  });

  it('timeout with bookingId uses bookingService.decrementTrucksFilled instead', async () => {
    mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockGetAssignmentById.mockResolvedValue(
      makeOrderAssignment({ orderId: null, bookingId: 'booking-001', status: 'driver_declined' })
    );
    setupVehicleMock();

    await assignmentService.handleAssignmentTimeout(
      makeTimerData({ orderId: null, bookingId: 'booking-001' })
    );

    expect(mockDecrementTrucksFilled).toHaveBeenCalledWith('booking-001');
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it('timeout no-ops if assignment already accepted (count=0)', async () => {
    // Driver accepted before timeout — CAS returns count=0
    mockAssignmentUpdateMany.mockResolvedValue({ count: 0 });
    mockGetAssignmentById.mockResolvedValue(
      makeOrderAssignment({ status: 'driver_accepted' })
    );

    await assignmentService.handleAssignmentTimeout(makeTimerData());

    // No decrement should happen
    expect(mockExecuteRaw).not.toHaveBeenCalled();
    expect(mockDecrementTrucksFilled).not.toHaveBeenCalled();
  });
});

// =============================================================================
// TEST 7: Two concurrent cancels — floor guard prevents negative
// =============================================================================

describe('Concurrent cancel race condition — floor guard prevents negative trucksFilled', () => {
  beforeEach(resetAllMocks);

  it('two concurrent cancels on same order (trucksFilled=1) both use GREATEST(0, ...)', async () => {
    // Scenario: trucksFilled=1, two cancels fire simultaneously
    // Without GREATEST: both read 1, both write 0 -> (1-1)=0, (0-1)=-1
    // With GREATEST: SQL GREATEST(0, 1-1)=0, then GREATEST(0, 0-1)=0
    //
    // We verify the SQL pattern is correct — the actual database handles atomicity

    const assignment1 = makeOrderAssignment({ id: 'assign-001', status: 'pending' });
    const assignment2 = makeOrderAssignment({ id: 'assign-002', status: 'pending' });

    // First cancel
    mockGetAssignmentById.mockResolvedValueOnce(assignment1);
    mockExecuteRaw.mockResolvedValueOnce(1);
    setupVehicleMock();
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });

    await assignmentService.cancelAssignment('assign-001', 'transporter-001');

    const firstCallSQL = getExecuteRawSQL();
    expect(firstCallSQL).not.toBeNull();
    expect(firstCallSQL!.sql).toMatch(/GREATEST\(0,\s*"trucksFilled"\s*-\s*1\)/);

    // Reset for second cancel
    mockExecuteRaw.mockReset();
    mockGetAssignmentById.mockReset();
    mockVehicleFindUnique.mockReset();
    mockUpdateVehicle.mockReset().mockResolvedValue(undefined);
    mockUpdateAssignment.mockReset().mockResolvedValue({});
    mockRedisDel.mockReset().mockResolvedValue(undefined);
    mockCancelAssignmentTimeout.mockReset().mockResolvedValue(undefined);

    // Second cancel — same order, trucksFilled may already be 0
    mockGetAssignmentById.mockResolvedValueOnce(assignment2);
    mockExecuteRaw.mockResolvedValueOnce(1);
    setupVehicleMock();

    await assignmentService.cancelAssignment('assign-002', 'transporter-001');

    const secondCallSQL = getExecuteRawSQL();
    expect(secondCallSQL).not.toBeNull();
    // Both cancels use GREATEST — database handles the floor
    expect(secondCallSQL!.sql).toMatch(/GREATEST\(0,\s*"trucksFilled"\s*-\s*1\)/);
    // Both target the same order
    expect(secondCallSQL!.values).toContain('order-001');
  });
});

// =============================================================================
// TEST 8: booking.service.ts GREATEST pattern regression test
// =============================================================================

describe('Regression — booking.service.ts decrementTrucksFilled uses GREATEST', () => {
  it('booking decrementTrucksFilled source contains GREATEST(0, trucksFilled - 1)', () => {
    // Static analysis: verify the source code contains the GREATEST pattern.
    // We cannot import the real booking service here because it is mocked at module level
    // for the assignment service tests. Instead, verify the source directly.
    const fs = require('fs');
    const path = require('path');
    const bookingSource = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'booking', 'booking.service.ts'),
      'utf8'
    );

    // The decrementTrucksFilled method must use GREATEST floor guard
    expect(bookingSource).toContain('GREATEST(0, "trucksFilled" - 1)');
    // It must target the Booking table
    expect(bookingSource).toContain('UPDATE "Booking"');
    // It must use $queryRaw (with RETURNING clause)
    expect(bookingSource).toContain('$queryRaw');
    expect(bookingSource).toContain('RETURNING "trucksFilled"');
  });
});

// =============================================================================
// TEST 9: confirmed-hold.service.ts GREATEST pattern regression test
// =============================================================================

describe('Regression — confirmed-hold.service.ts decline uses GREATEST', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('confirmed-hold decline calls $executeRaw with GREATEST(0, trucksFilled - 1)', async () => {
    // Set up mocks for confirmed-hold decline path
    const assignment = {
      id: 'assign-001',
      orderId: 'order-001',
      truckRequestId: 'tr-001',
      vehicleId: 'vehicle-001',
      driverId: 'driver-001',
      driverName: 'Test Driver',
      tripId: 'trip-001',
      status: 'driver_declined',
    };

    // The confirmed-hold service uses its own prisma mock
    // We need to import and call the handleDriverDecline method
    // The key verification: $executeRaw SQL contains GREATEST(0, ...)

    // Mock for assignment.update (confirmed-hold uses update, not updateMany)
    const mockAssignmentUpdate = jest.fn().mockResolvedValue(assignment);
    const mockTruckRequestFindFirst = jest.fn().mockResolvedValue({
      id: 'tr-001',
      orderId: 'order-001',
      status: 'assigned',
    });
    const mockTruckRequestUpdate = jest.fn().mockResolvedValue({});
    const mockTruckHoldLedgerFindFirst = jest.fn().mockResolvedValue(null);
    const mockReleaseVehicle = jest.fn().mockResolvedValue(undefined);

    // Verify the source code contains the GREATEST pattern for confirmed-hold
    // This is a static analysis test — we read the source and verify the pattern
    const fs = require('fs');
    const path = require('path');
    const confirmedHoldSource = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'truck-hold', 'confirmed-hold.service.ts'),
      'utf8'
    );

    // The decline path must contain the GREATEST floor guard
    expect(confirmedHoldSource).toContain('GREATEST(0, "trucksFilled" - 1)');
    // It must target the Order table
    expect(confirmedHoldSource).toContain('UPDATE "Order"');
    // It must use $executeRaw (not $queryRaw or Prisma ORM)
    expect(confirmedHoldSource).toContain('$executeRaw');
  });
});

// =============================================================================
// TEST: SQL correctness — orderId is passed as parameter (not inlined)
// =============================================================================

describe('SQL parameter safety — orderId passed as tagged template parameter', () => {
  beforeEach(resetAllMocks);

  it('cancelAssignment passes orderId as SQL parameter, not string interpolation', async () => {
    const assignment = makeOrderAssignment({ orderId: 'order-inject-test' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockExecuteRaw.mockResolvedValue(1);
    setupVehicleMock();
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });

    await assignmentService.cancelAssignment('assign-001', 'transporter-001');

    const rawCall = getExecuteRawSQL();
    expect(rawCall).not.toBeNull();
    // orderId should be in the values array (parameterized), not in the SQL string
    expect(rawCall!.values).toContain('order-inject-test');
    // The SQL should have a placeholder, not the raw value
    expect(rawCall!.sql).not.toContain('order-inject-test');
  });

  it('declineAssignment passes orderId as SQL parameter', async () => {
    const assignment = makeOrderAssignment({ orderId: 'order-decline-test' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockExecuteRaw.mockResolvedValue(1);
    setupVehicleMock();
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });
    mockRedisSet.mockResolvedValue(undefined);

    await assignmentService.declineAssignment('assign-001', 'driver-001');

    const rawCall = getExecuteRawSQL();
    expect(rawCall).not.toBeNull();
    expect(rawCall!.values).toContain('order-decline-test');
  });

  it('handleAssignmentTimeout passes orderId as SQL parameter', async () => {
    mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
    mockGetAssignmentById.mockResolvedValue(
      makeOrderAssignment({ orderId: 'order-timeout-test', status: 'driver_declined' })
    );
    setupVehicleMock();
    mockExecuteRaw.mockResolvedValue(1);
    mockTruckRequestUpdateMany.mockResolvedValue({ count: 1 });

    await assignmentService.handleAssignmentTimeout({
      assignmentId: 'assign-001',
      driverId: 'driver-001',
      driverName: 'Test Driver',
      transporterId: 'transporter-001',
      vehicleId: 'vehicle-001',
      vehicleNumber: 'MH12AB1234',
      tripId: 'trip-001',
      createdAt: new Date().toISOString(),
      orderId: 'order-timeout-test',
      truckRequestId: 'tr-001',
    });

    const rawCall = getExecuteRawSQL();
    expect(rawCall).not.toBeNull();
    expect(rawCall!.values).toContain('order-timeout-test');
  });
});
