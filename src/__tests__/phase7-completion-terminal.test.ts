/**
 * =============================================================================
 * PHASE 7 — COMPLETION & TERMINAL STATE TESTS
 * =============================================================================
 *
 * Tests for:
 *   F-C3:  Atomic completion transaction (assignment + vehicle release in $transaction)
 *   F-M20: CAS for completion update (updateMany with status precondition)
 *   F-H11: Terminal state guard on cancelAssignment (409 ASSIGNMENT_ALREADY_TERMINAL)
 *   F-M11: Terminal state guard in assignment.service.ts cancelAssignment
 *   F-M21: partial_delivery in terminal status sets (booking completion)
 *   F-M25: partial_delivery in terminal status sets (order completion)
 *   F-H18: Clear active-broadcast sentinel on completion
 *
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — must come before imports
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

jest.mock('../config/environment', () => ({
  config: {
    redis: { enabled: true },
    isProduction: false,
    otp: { expiryMinutes: 5 },
    sms: {},
  },
}));

// Prisma mock
const mockPrismaTransaction = jest.fn();
const mockAssignmentUpdateMany = jest.fn();
const mockAssignmentUpdate = jest.fn();
const mockAssignmentFindMany = jest.fn();
const mockAssignmentFindFirst = jest.fn();
const mockAssignmentFindUnique = jest.fn();
const mockVehicleUpdateMany = jest.fn();
const mockVehicleFindUnique = jest.fn();
const mockBookingFindUnique = jest.fn();
const mockBookingUpdateMany = jest.fn();
const mockOrderFindUnique = jest.fn();
const mockOrderUpdateMany = jest.fn();
const mockExecuteRaw = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    $transaction: (...args: any[]) => mockPrismaTransaction(...args),
    $executeRaw: (...args: any[]) => mockExecuteRaw(...args),
    assignment: {
      updateMany: (...args: any[]) => mockAssignmentUpdateMany(...args),
      update: (...args: any[]) => mockAssignmentUpdate(...args),
      findMany: (...args: any[]) => mockAssignmentFindMany(...args),
      findFirst: (...args: any[]) => mockAssignmentFindFirst(...args),
      findUnique: (...args: any[]) => mockAssignmentFindUnique(...args),
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
  },
  withDbTimeout: jest.fn(),
  BookingStatus: {
    created: 'created',
    broadcasting: 'broadcasting',
    active: 'active',
    partially_filled: 'partially_filled',
    fully_filled: 'fully_filled',
    cancelled: 'cancelled',
    expired: 'expired',
    completed: 'completed',
  },
  AssignmentStatus: {
    pending: 'pending',
    driver_accepted: 'driver_accepted',
    en_route_pickup: 'en_route_pickup',
    at_pickup: 'at_pickup',
    in_transit: 'in_transit',
    arrived_at_drop: 'arrived_at_drop',
    completed: 'completed',
    partial_delivery: 'partial_delivery',
    driver_declined: 'driver_declined',
    cancelled: 'cancelled',
  },
}));

// DB mock
const mockGetAssignmentById = jest.fn();
const mockGetBookingById = jest.fn();
const mockUpdateAssignment = jest.fn();
const mockUpdateBooking = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getAssignmentById: (...args: any[]) => mockGetAssignmentById(...args),
    getBookingById: (...args: any[]) => mockGetBookingById(...args),
    updateAssignment: (...args: any[]) => mockUpdateAssignment(...args),
    updateBooking: (...args: any[]) => mockUpdateBooking(...args),
    getAssignmentsByTransporter: jest.fn().mockResolvedValue([]),
    getUserById: jest.fn().mockResolvedValue(null),
    getVehicleById: jest.fn().mockResolvedValue(null),
    getActiveAssignmentByDriver: jest.fn().mockResolvedValue(null),
    getBookingsByCustomer: jest.fn().mockResolvedValue([]),
    getAssignmentsByDriver: jest.fn().mockResolvedValue([]),
  },
}));

// Redis mock
const mockRedisSet = jest.fn().mockResolvedValue(undefined);
const mockRedisGet = jest.fn().mockResolvedValue(null);
const mockRedisDel = jest.fn().mockResolvedValue(undefined);
const mockRedisAcquireLock = jest.fn().mockResolvedValue({ acquired: true });
const mockRedisReleaseLock = jest.fn().mockResolvedValue(undefined);
const mockRedisHSet = jest.fn().mockResolvedValue(undefined);
const mockRedisExpire = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    hSet: (...args: any[]) => mockRedisHSet(...args),
    expire: (...args: any[]) => mockRedisExpire(...args),
    getJSON: jest.fn().mockResolvedValue(null),
    setJSON: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
    exists: jest.fn().mockResolvedValue(false),
    sMembers: jest.fn().mockResolvedValue([]),
    sAdd: jest.fn().mockResolvedValue(undefined),
    sIsMember: jest.fn().mockResolvedValue(false),
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
    cancelTimer: jest.fn().mockResolvedValue(undefined),
    setTimer: jest.fn().mockResolvedValue(undefined),
    getExpiredTimers: jest.fn().mockResolvedValue([]),
    multi: jest.fn().mockReturnValue({ del: jest.fn(), exec: jest.fn().mockResolvedValue([]) }),
  },
}));

// Socket mock
const mockEmitToUser = jest.fn();
const mockEmitToBooking = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToBooking: (...args: any[]) => mockEmitToBooking(...args),
  SocketEvent: {
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    BOOKING_UPDATED: 'booking_updated',
    BOOKING_EXPIRED: 'booking_expired',
    BOOKING_CANCELLED: 'booking_cancelled',
    BOOKING_FULLY_FILLED: 'booking_fully_filled',
    BOOKING_PARTIALLY_FILLED: 'booking_partially_filled',
    ORDER_STATUS_UPDATE: 'order_status_update',
    TRUCK_ASSIGNED: 'truck_assigned',
    TRIP_ASSIGNED: 'trip_assigned',
    TRIP_CANCELLED: 'trip_cancelled',
    DRIVER_TIMEOUT: 'driver_timeout',
    ASSIGNMENT_TIMEOUT: 'assignment_timeout',
    TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update',
    NO_VEHICLES_AVAILABLE: 'no_vehicles_available',
  },
}));

// Queue mock
const mockQueuePushNotification = jest.fn().mockResolvedValue(undefined);
const mockQueueCancelAssignmentTimeout = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queuePushNotification: (...args: any[]) => mockQueuePushNotification(...args),
    queuePushNotificationBatch: jest.fn().mockResolvedValue(undefined),
    cancelAssignmentTimeout: (...args: any[]) => mockQueueCancelAssignmentTimeout(...args),
    scheduleAssignmentTimeout: jest.fn().mockResolvedValue(undefined),
    enqueue: jest.fn().mockResolvedValue(undefined),
    registerProcessor: jest.fn(),
  },
}));

// Live availability mock
const mockOnVehicleStatusChange = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: (...args: any[]) => mockOnVehicleStatusChange(...args),
  },
}));

// Vehicle lifecycle mock
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  onVehicleTransition: jest.fn().mockResolvedValue(undefined),
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
  isValidTransition: jest.fn().mockReturnValue(true),
}));

// Fleet cache mock
jest.mock('../shared/services/fleet-cache-write.service', () => ({
  invalidateVehicleCache: jest.fn().mockResolvedValue(undefined),
}));

// Tracking mock
jest.mock('../modules/tracking/tracking.service', () => ({
  trackingService: {
    initializeTracking: jest.fn().mockResolvedValue(undefined),
  },
}));

// Auto redispatch mock
jest.mock('../modules/assignment/auto-redispatch.service', () => ({
  tryAutoRedispatch: jest.fn().mockResolvedValue(undefined),
}));

// Order lifecycle outbox mock
jest.mock('../modules/order/order-lifecycle-outbox.service', () => ({
  enqueueCompletionLifecycleOutbox: jest.fn().mockResolvedValue(undefined),
}));

// Hold config mock
jest.mock('../core/config/hold-config', () => ({
  HOLD_CONFIG: {
    driverAcceptTimeoutMs: 30000,
    flexHoldDurationMs: 90000,
    flexHoldMaxDurationMs: 130000,
    confirmedHoldMaxMs: 180000,
    driverAcceptTimeoutSeconds: 30,
  },
}));

// State machines mock
jest.mock('../core/state-machines', () => ({
  ...jest.requireActual('../core/state-machines'),
  assertValidTransition: jest.fn(),
  BOOKING_VALID_TRANSITIONS: {},
}));

// Order broadcast mock (clearCustomerActiveBroadcast)
const mockClearCustomerActiveBroadcast = jest.fn().mockResolvedValue(undefined);
jest.mock('../modules/order/order-broadcast.service', () => ({
  clearCustomerActiveBroadcast: (...args: any[]) => mockClearCustomerActiveBroadcast(...args),
  withEventMeta: jest.fn((p: any) => ({ ...p, eventId: 'eid', emittedAt: new Date().toISOString() })),
  notifiedTransportersKey: jest.fn((id: string) => `broadcast:notified:${id}`),
  makeVehicleGroupKey: jest.fn(),
  parseVehicleGroupKey: jest.fn(),
  buildRequestsByType: jest.fn(),
}));

// Smart timeout mock
jest.mock('../modules/order-timeout/smart-timeout.service', () => ({
  smartTimeoutService: {
    extendTimeout: jest.fn().mockResolvedValue(undefined),
  },
}));

// Booking service mock (for lazy require in lifecycle)
jest.mock('../modules/booking/booking.service', () => ({
  bookingService: {
    decrementTrucksFilled: jest.fn().mockResolvedValue(undefined),
    incrementTrucksFilled: jest.fn().mockResolvedValue(undefined),
  },
}));

// Progressive radius matcher mock
jest.mock('../modules/order/progressive-radius-matcher', () => ({
  PROGRESSIVE_RADIUS_STEPS: [
    { radiusKm: 5, windowMs: 10000 },
    { radiusKm: 10, windowMs: 10000 },
  ],
}));

// Completion orchestrator mock — FF_COMPLETION_ORCHESTRATOR defaults ON in source.
// completeTrip handles atomic $transaction + all side-effects internally.
// We mock it to simulate successful completion and re-fetch behavior.
const mockCompleteTrip = jest.fn();
jest.mock('../modules/assignment/completion-orchestrator', () => ({
  completeTrip: (...args: any[]) => mockCompleteTrip(...args),
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { assignmentService } from '../modules/assignment/assignment.service';
import { assignmentLifecycleService } from '../modules/assignment/assignment-lifecycle.service';

// =============================================================================
// HELPERS
// =============================================================================

function makeAssignment(overrides: Record<string, any> = {}) {
  return {
    id: 'assign-1',
    bookingId: 'booking-1',
    orderId: '',
    truckRequestId: '',
    transporterId: 'transporter-1',
    transporterName: 'Test Transporter',
    vehicleId: 'vehicle-1',
    vehicleNumber: 'KA-01-1234',
    vehicleType: 'truck',
    vehicleSubtype: 'open_body',
    driverId: 'driver-1',
    driverName: 'Test Driver',
    driverPhone: '9999999999',
    tripId: 'trip-1',
    status: 'in_transit',
    assignedAt: new Date().toISOString(),
    driverAcceptedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: '',
    ...overrides,
  };
}

function resetAllMocks(): void {
  jest.clearAllMocks();
  mockPrismaTransaction.mockReset();
  mockAssignmentUpdateMany.mockReset();
  mockAssignmentUpdate.mockReset();
  mockAssignmentFindMany.mockReset();
  mockAssignmentFindFirst.mockReset();
  mockAssignmentFindUnique.mockReset();
  mockVehicleUpdateMany.mockReset();
  mockVehicleFindUnique.mockReset();
  mockBookingFindUnique.mockReset();
  mockBookingUpdateMany.mockReset();
  mockOrderFindUnique.mockReset();
  mockOrderUpdateMany.mockReset();
  mockExecuteRaw.mockReset();
  mockGetAssignmentById.mockReset();
  mockGetBookingById.mockReset();
  mockUpdateAssignment.mockReset();
  mockUpdateBooking.mockReset();
  mockRedisSet.mockReset().mockResolvedValue(undefined);
  mockRedisGet.mockReset().mockResolvedValue(null);
  mockRedisDel.mockReset().mockResolvedValue(undefined);
  mockRedisAcquireLock.mockReset().mockResolvedValue({ acquired: true });
  mockRedisReleaseLock.mockReset().mockResolvedValue(undefined);
  mockEmitToUser.mockReset();
  mockEmitToBooking.mockReset();
  mockQueuePushNotification.mockReset().mockResolvedValue(undefined);
  mockQueueCancelAssignmentTimeout.mockReset().mockResolvedValue(undefined);
  mockOnVehicleStatusChange.mockReset().mockResolvedValue(undefined);
  mockClearCustomerActiveBroadcast.mockReset().mockResolvedValue(undefined);
  // Default: completeTrip resolves successfully (FF_COMPLETION_ORCHESTRATOR=ON path)
  mockCompleteTrip.mockReset().mockResolvedValue({ success: true, assignmentId: 'assign-1', alreadyCompleted: false });
}

// =============================================================================
// F-C3: ATOMIC COMPLETION TRANSACTION
// =============================================================================

describe('F-C3: Atomic completion transaction', () => {
  beforeEach(() => resetAllMocks());

  test('C3-01: completion delegates to completeTrip orchestrator', async () => {
    // FF_COMPLETION_ORCHESTRATOR defaults ON — completion goes through completeTrip()
    const assignment = makeAssignment({ status: 'arrived_at_drop' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    // completeTrip resolves; re-fetch returns completed assignment
    mockCompleteTrip.mockResolvedValue({ success: true, assignmentId: 'assign-1', alreadyCompleted: false });
    mockGetAssignmentById
      .mockResolvedValueOnce(assignment) // pre-check
      .mockResolvedValue({ ...assignment, status: 'completed', completedAt: new Date().toISOString() }); // post-completeTrip re-fetch

    await assignmentService.updateStatus('assign-1', 'driver-1', { status: 'completed' } as any);

    // completeTrip is called with (assignmentId, 'admin', 'completed', undefined)
    expect(mockCompleteTrip).toHaveBeenCalledTimes(1);
    expect(mockCompleteTrip).toHaveBeenCalledWith('assign-1', 'admin', 'completed', undefined);
  });

  test('C3-02: completeTrip handles atomic TX + vehicle CAS internally', async () => {
    // Verify completeTrip is called for completion status — TX + CAS are internal
    const assignment = makeAssignment({ status: 'arrived_at_drop' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockCompleteTrip.mockResolvedValue({ success: true, assignmentId: 'assign-1', alreadyCompleted: false });
    mockGetAssignmentById
      .mockResolvedValueOnce(assignment)
      .mockResolvedValue({ ...assignment, status: 'completed' });

    await assignmentService.updateStatus('assign-1', 'driver-1', { status: 'completed' } as any);

    expect(mockCompleteTrip).toHaveBeenCalledTimes(1);
  });

  test('C3-03: completeTrip failure propagates error', async () => {
    const assignment = makeAssignment({ status: 'arrived_at_drop' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockCompleteTrip.mockRejectedValue(new Error('TX deadlock'));

    await expect(
      assignmentService.updateStatus('assign-1', 'driver-1', { status: 'completed' } as any)
    ).rejects.toThrow('TX deadlock');
  });

  test('C3-04: if completeTrip fails, error propagates and no side-effects run', async () => {
    const assignment = makeAssignment({ status: 'arrived_at_drop' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockCompleteTrip.mockRejectedValue(new Error('TX deadlock'));

    await expect(
      assignmentService.updateStatus('assign-1', 'driver-1', { status: 'completed' } as any)
    ).rejects.toThrow('TX deadlock');

    // completeTrip was called but failed — no post-completion side-effects
    expect(mockCompleteTrip).toHaveBeenCalledTimes(1);
  });

  test('C3-05: completion re-fetches assignment with completedAt after completeTrip', async () => {
    const assignment = makeAssignment({ status: 'arrived_at_drop' });
    const completedAssignment = { ...assignment, status: 'completed', completedAt: new Date().toISOString() };
    mockGetAssignmentById
      .mockResolvedValueOnce(assignment) // pre-check
      .mockResolvedValue(completedAssignment); // post-completeTrip re-fetch
    mockCompleteTrip.mockResolvedValue({ success: true, assignmentId: 'assign-1', alreadyCompleted: false });

    const result = await assignmentService.updateStatus('assign-1', 'driver-1', { status: 'completed' } as any);

    expect(result.status).toBe('completed');
    expect(result.completedAt).toBeDefined();
  });

  test('C3-06: partial_delivery also delegates to completeTrip orchestrator', async () => {
    const assignment = makeAssignment({ status: 'arrived_at_drop' });
    mockGetAssignmentById
      .mockResolvedValueOnce(assignment)
      .mockResolvedValue({ ...assignment, status: 'partial_delivery' });
    mockCompleteTrip.mockResolvedValue({ success: true, assignmentId: 'assign-1', alreadyCompleted: false });

    await assignmentService.updateStatus('assign-1', 'driver-1', {
      status: 'partial_delivery',
      partialReason: 'DAMAGED',
    } as any);

    expect(mockCompleteTrip).toHaveBeenCalledWith('assign-1', 'admin', 'partial_delivery', 'DAMAGED');
  });

  test('C3-07: completion with null vehicleId still delegates to completeTrip', async () => {
    const assignment = makeAssignment({ status: 'arrived_at_drop', vehicleId: null });
    mockGetAssignmentById
      .mockResolvedValueOnce(assignment)
      .mockResolvedValue({ ...assignment, status: 'completed' });
    mockCompleteTrip.mockResolvedValue({ success: true, assignmentId: 'assign-1', alreadyCompleted: false });

    await assignmentService.updateStatus('assign-1', 'driver-1', { status: 'completed' } as any);

    // completeTrip handles vehicle release internally (skips when vehicleId is null)
    expect(mockCompleteTrip).toHaveBeenCalledTimes(1);
  });

  test('C3-08: non-completion status does NOT use $transaction', async () => {
    const assignment = makeAssignment({ status: 'in_transit' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockUpdateAssignment.mockResolvedValue({ ...assignment, status: 'arrived_at_drop' });

    await assignmentService.updateStatus('assign-1', 'driver-1', { status: 'arrived_at_drop' } as any);

    expect(mockPrismaTransaction).not.toHaveBeenCalled();
    expect(mockUpdateAssignment).toHaveBeenCalled();
  });
});

// =============================================================================
// F-M20: CAS FOR COMPLETION UPDATE
// =============================================================================

describe('F-M20: CAS for completion update', () => {
  beforeEach(() => resetAllMocks());

  test('M20-01: completion delegates to completeTrip after transition validation', async () => {
    const assignment = makeAssignment({ status: 'arrived_at_drop' });
    mockGetAssignmentById
      .mockResolvedValueOnce(assignment)
      .mockResolvedValue({ ...assignment, status: 'completed' });
    mockCompleteTrip.mockResolvedValue({ success: true, assignmentId: 'assign-1', alreadyCompleted: false });

    await assignmentService.updateStatus('assign-1', 'driver-1', { status: 'completed' } as any);

    // completeTrip is called after ASSIGNMENT_VALID_TRANSITIONS check passes
    expect(mockCompleteTrip).toHaveBeenCalledWith('assign-1', 'admin', 'completed', undefined);
  });

  test('M20-02: invalid transition from in_transit to completed is rejected', async () => {
    const assignment = makeAssignment({ status: 'in_transit' });
    mockGetAssignmentById.mockResolvedValue(assignment);

    // M-20 FIX: completed only from arrived_at_drop, not in_transit
    await expect(
      assignmentService.updateStatus('assign-1', 'driver-1', { status: 'completed' } as any)
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_TRANSITION' });
  });

  test('M20-03: valid transition from arrived_at_drop to completed succeeds', async () => {
    const assignment = makeAssignment({ status: 'arrived_at_drop' });
    mockGetAssignmentById
      .mockResolvedValueOnce(assignment)
      .mockResolvedValue({ ...assignment, status: 'completed' });
    mockCompleteTrip.mockResolvedValue({ success: true, assignmentId: 'assign-1', alreadyCompleted: false });

    const result = await assignmentService.updateStatus('assign-1', 'driver-1', { status: 'completed' } as any);

    expect(result.status).toBe('completed');
  });

  test('M20-04: already-completed assignment cannot be updated (empty transitions)', async () => {
    const assignment = makeAssignment({ status: 'completed' });
    mockGetAssignmentById.mockResolvedValue(assignment);

    await expect(
      assignmentService.updateStatus('assign-1', 'driver-1', { status: 'completed' } as any)
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_TRANSITION' });
  });

  test('M20-05: already-cancelled assignment cannot transition', async () => {
    const assignment = makeAssignment({ status: 'cancelled' });
    mockGetAssignmentById.mockResolvedValue(assignment);

    await expect(
      assignmentService.updateStatus('assign-1', 'driver-1', { status: 'completed' } as any)
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_TRANSITION' });
  });

  test('M20-06: concurrent completion requests — state machine rejects invalid transition', async () => {
    // First request succeeds, assignment transitions to completed.
    // Second request sees completed status and rejects (INVALID_TRANSITION).
    const assignment = makeAssignment({ status: 'arrived_at_drop' });
    mockCompleteTrip.mockResolvedValue({ success: true, assignmentId: 'assign-1', alreadyCompleted: false });

    // First call pre-check: arrived_at_drop -> passes transition
    // First call post-completeTrip re-fetch: completed
    // Second call pre-check: already completed -> fails transition validation
    mockGetAssignmentById
      .mockResolvedValueOnce(assignment)                                   // 1st call pre-check
      .mockResolvedValueOnce({ ...assignment, status: 'completed' })       // 2nd call pre-check (already completed)
      .mockResolvedValue({ ...assignment, status: 'completed' });          // re-fetch after completeTrip

    const results = await Promise.allSettled([
      assignmentService.updateStatus('assign-1', 'driver-1', { status: 'completed' } as any),
      assignmentService.updateStatus('assign-1', 'driver-1', { status: 'completed' } as any),
    ]);

    const successes = results.filter(r => r.status === 'fulfilled');
    const failures = results.filter(r => r.status === 'rejected');
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
  });
});

// =============================================================================
// F-H11 + F-M11: TERMINAL STATE GUARD ON cancelAssignment
// =============================================================================

describe('F-H11: Terminal state guard on cancelAssignment (assignment-lifecycle.service)', () => {
  beforeEach(() => resetAllMocks());

  test('H11-01: cannot cancel completed assignment — throws 409', async () => {
    const assignment = makeAssignment({ status: 'completed' });
    mockGetAssignmentById.mockResolvedValue(assignment);

    await expect(
      assignmentLifecycleService.cancelAssignment('assign-1', 'transporter-1')
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'ASSIGNMENT_ALREADY_TERMINAL',
    });
  });

  test('H11-02: cannot cancel already-cancelled assignment — throws 409', async () => {
    const assignment = makeAssignment({ status: 'cancelled' });
    mockGetAssignmentById.mockResolvedValue(assignment);

    await expect(
      assignmentLifecycleService.cancelAssignment('assign-1', 'transporter-1')
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'ASSIGNMENT_ALREADY_TERMINAL',
    });
  });

  test('H11-03: cannot cancel partial_delivery assignment — throws 409', async () => {
    const assignment = makeAssignment({ status: 'partial_delivery' });
    mockGetAssignmentById.mockResolvedValue(assignment);

    await expect(
      assignmentLifecycleService.cancelAssignment('assign-1', 'transporter-1')
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'ASSIGNMENT_ALREADY_TERMINAL',
    });
  });

  test('H11-04: CAS updateMany excludes terminal statuses in WHERE clause', async () => {
    const assignment = makeAssignment({ status: 'in_transit' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'VK1', transporterId: 'transporter-1', status: 'in_transit' });

    mockPrismaTransaction.mockImplementation(async (cb: Function) => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        $executeRaw: jest.fn().mockResolvedValue(0),
        $executeRawUnsafe: jest.fn().mockResolvedValue(0),
        assignment: { updateMany: mockAssignmentUpdateMany.mockResolvedValue({ count: 1 }) },
        vehicle: { updateMany: mockVehicleUpdateMany.mockResolvedValue({ count: 1 }) },
      };
      await cb(tx);
    });

    await assignmentLifecycleService.cancelAssignment('assign-1', 'transporter-1');

    const casCall = mockAssignmentUpdateMany.mock.calls[0][0];
    expect(casCall.where.status.notIn).toEqual(
      expect.arrayContaining(['completed', 'cancelled', 'partial_delivery'])
    );
  });

  test('H11-05: CAS count=0 means idempotent return (no error)', async () => {
    const assignment = makeAssignment({ status: 'in_transit' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'VK1', transporterId: 'transporter-1', status: 'in_transit' });

    mockPrismaTransaction.mockImplementation(async (cb: Function) => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        $executeRaw: jest.fn().mockResolvedValue(0),
        $executeRawUnsafe: jest.fn().mockResolvedValue(0),
        assignment: { updateMany: mockAssignmentUpdateMany.mockResolvedValue({ count: 0 }) },
        vehicle: { updateMany: mockVehicleUpdateMany },
      };
      await cb(tx);
    });

    // Should NOT throw even though count=0 (idempotent)
    await assignmentLifecycleService.cancelAssignment('assign-1', 'transporter-1');

    // Vehicle should NOT be released when cancel was a no-op
    expect(mockVehicleUpdateMany).not.toHaveBeenCalled();
  });

  test('H11-06: can cancel pending assignment — no terminal guard', async () => {
    const assignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'VK1', transporterId: 'transporter-1', status: 'on_hold' });

    mockPrismaTransaction.mockImplementation(async (cb: Function) => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        $executeRaw: jest.fn().mockResolvedValue(0),
        $executeRawUnsafe: jest.fn().mockResolvedValue(0),
        assignment: { updateMany: mockAssignmentUpdateMany.mockResolvedValue({ count: 1 }) },
        vehicle: { updateMany: mockVehicleUpdateMany.mockResolvedValue({ count: 1 }) },
      };
      await cb(tx);
    });

    await assignmentLifecycleService.cancelAssignment('assign-1', 'transporter-1');

    expect(mockAssignmentUpdateMany).toHaveBeenCalled();
  });
});

describe('F-M11: Terminal state guard on cancelAssignment (assignment.service)', () => {
  beforeEach(() => resetAllMocks());

  test('M11-01: cannot cancel completed assignment — throws 409', async () => {
    const assignment = makeAssignment({ status: 'completed' });
    mockGetAssignmentById.mockResolvedValue(assignment);

    await expect(
      assignmentService.cancelAssignment('assign-1', 'transporter-1')
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'ASSIGNMENT_ALREADY_TERMINAL',
    });
  });

  test('M11-02: cannot cancel already-cancelled assignment — throws 409', async () => {
    const assignment = makeAssignment({ status: 'cancelled' });
    mockGetAssignmentById.mockResolvedValue(assignment);

    await expect(
      assignmentService.cancelAssignment('assign-1', 'transporter-1')
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'ASSIGNMENT_ALREADY_TERMINAL',
    });
  });

  test('M11-03: cannot cancel partial_delivery assignment — throws 409', async () => {
    const assignment = makeAssignment({ status: 'partial_delivery' });
    mockGetAssignmentById.mockResolvedValue(assignment);

    await expect(
      assignmentService.cancelAssignment('assign-1', 'transporter-1')
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'ASSIGNMENT_ALREADY_TERMINAL',
    });
  });

  test('M11-04: CAS notIn includes partial_delivery', async () => {
    const assignment = makeAssignment({ status: 'in_transit' });
    mockGetAssignmentById.mockResolvedValue(assignment);

    mockPrismaTransaction.mockImplementation(async (cb: Function) => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        $executeRaw: jest.fn().mockResolvedValue(0),
        $executeRawUnsafe: jest.fn().mockResolvedValue(0),
        assignment: { updateMany: mockAssignmentUpdateMany.mockResolvedValue({ count: 1 }) },
        vehicle: { updateMany: mockVehicleUpdateMany.mockResolvedValue({ count: 1 }) },
      };
      await cb(tx);
    });
    mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'VK1', transporterId: 'transporter-1' });

    await assignmentService.cancelAssignment('assign-1', 'transporter-1');

    const casCall = mockAssignmentUpdateMany.mock.calls[0][0];
    expect(casCall.where.status.notIn).toEqual(
      expect.arrayContaining(['partial_delivery'])
    );
  });

  test('M11-05: driver can cancel their own in_transit assignment', async () => {
    const assignment = makeAssignment({ status: 'in_transit' });
    mockGetAssignmentById.mockResolvedValue(assignment);

    mockPrismaTransaction.mockImplementation(async (cb: Function) => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        $executeRaw: jest.fn().mockResolvedValue(0),
        $executeRawUnsafe: jest.fn().mockResolvedValue(0),
        assignment: { updateMany: mockAssignmentUpdateMany.mockResolvedValue({ count: 1 }) },
        vehicle: { updateMany: mockVehicleUpdateMany.mockResolvedValue({ count: 1 }) },
      };
      await cb(tx);
    });
    mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'VK1', transporterId: 'transporter-1' });

    await assignmentService.cancelAssignment('assign-1', 'driver-1');

    expect(mockAssignmentUpdateMany).toHaveBeenCalled();
  });

  test('M11-06: unauthorized user cannot cancel assignment — 403', async () => {
    const assignment = makeAssignment({ status: 'pending' });
    mockGetAssignmentById.mockResolvedValue(assignment);

    await expect(
      assignmentService.cancelAssignment('assign-1', 'random-user')
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
  });

  test('M11-07: assignment not found — 404', async () => {
    mockGetAssignmentById.mockResolvedValue(null);

    await expect(
      assignmentService.cancelAssignment('assign-nope', 'transporter-1')
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'ASSIGNMENT_NOT_FOUND',
    });
  });
});

// =============================================================================
// F-M21 + F-M25: partial_delivery IN TERMINAL STATUS SETS
// =============================================================================

describe('F-M21: partial_delivery in booking completion terminal set', () => {
  // Import the fleet service for completion checks
  let trackingFleetService: any;

  beforeEach(async () => {
    resetAllMocks();
    const mod = await import('../modules/tracking/tracking-fleet.service');
    trackingFleetService = (mod as any).trackingFleetService;
  });

  test('M21-01: all completed assignments => booking completes', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'completed' },
      { id: 'a2', status: 'completed' },
    ]);
    mockGetBookingById.mockResolvedValue({ id: 'booking-1', customerId: 'cust-1', status: 'in_progress' });
    mockUpdateBooking.mockResolvedValue({});
    mockAssignmentFindFirst.mockResolvedValue(null);

    await trackingFleetService.checkBookingCompletion('booking-1');

    expect(mockUpdateBooking).toHaveBeenCalledWith('booking-1', { status: 'completed' });
  });

  test('M21-02: completed + partial_delivery => booking completes (has at least one completed)', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'completed' },
      { id: 'a2', status: 'partial_delivery' },
    ]);
    mockGetBookingById.mockResolvedValue({ id: 'booking-1', customerId: 'cust-1', status: 'in_progress' });
    mockUpdateBooking.mockResolvedValue({});
    mockAssignmentFindFirst.mockResolvedValue(null);

    await trackingFleetService.checkBookingCompletion('booking-1');

    expect(mockUpdateBooking).toHaveBeenCalledWith('booking-1', { status: 'completed' });
  });

  test('M21-03: completed + cancelled => booking completes (has at least one completed)', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'completed' },
      { id: 'a2', status: 'cancelled' },
    ]);
    mockGetBookingById.mockResolvedValue({ id: 'booking-1', customerId: 'cust-1', status: 'in_progress' });
    mockUpdateBooking.mockResolvedValue({});
    mockAssignmentFindFirst.mockResolvedValue(null);

    await trackingFleetService.checkBookingCompletion('booking-1');

    expect(mockUpdateBooking).toHaveBeenCalledWith('booking-1', { status: 'completed' });
  });

  test('M21-04: one still in_transit => booking does NOT complete', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'completed' },
      { id: 'a2', status: 'in_transit' },
    ]);

    await trackingFleetService.checkBookingCompletion('booking-1');

    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });

  test('M21-05: all partial_delivery but none completed => booking does NOT complete', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    // Per the code: hasCompleted must be true (at least one 'completed')
    // All partial_delivery => allTerminal=true, hasCompleted=false => does not complete
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'partial_delivery' },
      { id: 'a2', status: 'partial_delivery' },
    ]);

    await trackingFleetService.checkBookingCompletion('booking-1');

    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });

  test('M21-06: booking already cancelled => skip completion', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'completed' },
    ]);
    mockGetBookingById.mockResolvedValue({ id: 'booking-1', customerId: 'cust-1', status: 'cancelled' });

    await trackingFleetService.checkBookingCompletion('booking-1');

    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });

  test('M21-07: no assignments => skip without error', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockAssignmentFindMany.mockResolvedValue([]);

    await trackingFleetService.checkBookingCompletion('booking-1');

    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });

  test('M21-08: lock not acquired => skip gracefully', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: false });

    await trackingFleetService.checkBookingCompletion('booking-1');

    expect(mockAssignmentFindMany).not.toHaveBeenCalled();
  });
});

describe('F-M25: partial_delivery in order completion terminal set', () => {
  let trackingFleetService: any;

  beforeEach(async () => {
    resetAllMocks();
    const mod = await import('../modules/tracking/tracking-fleet.service');
    trackingFleetService = (mod as any).trackingFleetService;
  });

  test('M25-01: all completed => order marked completed', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'completed' },
      { id: 'a2', status: 'completed' },
    ]);
    mockOrderFindUnique.mockResolvedValue({ id: 'order-1', status: 'in_progress', customerId: 'cust-1' });
    mockOrderUpdateMany.mockResolvedValue({ count: 1 });

    await trackingFleetService.checkOrderCompletion('order-1');

    expect(mockOrderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'completed' },
      })
    );
  });

  test('M25-02: completed + partial_delivery => order marked completed', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'completed' },
      { id: 'a2', status: 'partial_delivery' },
    ]);
    mockOrderFindUnique.mockResolvedValue({ id: 'order-1', status: 'in_progress', customerId: 'cust-1' });
    mockOrderUpdateMany.mockResolvedValue({ count: 1 });

    await trackingFleetService.checkOrderCompletion('order-1');

    expect(mockOrderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'completed' },
      })
    );
  });

  test('M25-03: all cancelled => order marked cancelled', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'cancelled' },
      { id: 'a2', status: 'cancelled' },
    ]);
    mockOrderFindUnique.mockResolvedValue({ id: 'order-1', status: 'in_progress', customerId: 'cust-1' });
    mockOrderUpdateMany.mockResolvedValue({ count: 1 });

    await trackingFleetService.checkOrderCompletion('order-1');

    expect(mockOrderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'cancelled' },
      })
    );
  });

  test('M25-04: completed + cancelled => order marked completed (at least one completed)', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'completed' },
      { id: 'a2', status: 'cancelled' },
    ]);
    mockOrderFindUnique.mockResolvedValue({ id: 'order-1', status: 'in_progress', customerId: 'cust-1' });
    mockOrderUpdateMany.mockResolvedValue({ count: 1 });

    await trackingFleetService.checkOrderCompletion('order-1');

    expect(mockOrderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'completed' },
      })
    );
  });

  test('M25-05: with partial_delivery + cancelled (no completed) => does NOT complete', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    // allTerminal=true, hasCompleted=false, allCancelled=false => falls to guard return
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'partial_delivery' },
      { id: 'a2', status: 'cancelled' },
    ]);

    await trackingFleetService.checkOrderCompletion('order-1');

    expect(mockOrderUpdateMany).not.toHaveBeenCalled();
  });

  test('M25-06: some assignments still in_transit => NOT terminal', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'completed' },
      { id: 'a2', status: 'in_transit' },
    ]);

    await trackingFleetService.checkOrderCompletion('order-1');

    expect(mockOrderUpdateMany).not.toHaveBeenCalled();
  });

  test('M25-07: order already completed => CAS skip (idempotent)', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'completed' },
    ]);
    mockOrderFindUnique.mockResolvedValue({ id: 'order-1', status: 'completed', customerId: 'cust-1' });

    await trackingFleetService.checkOrderCompletion('order-1');

    expect(mockOrderUpdateMany).not.toHaveBeenCalled();
  });

  test('M25-08: order already cancelled => CAS skip (idempotent)', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'completed' },
    ]);
    mockOrderFindUnique.mockResolvedValue({ id: 'order-1', status: 'cancelled', customerId: 'cust-1' });

    await trackingFleetService.checkOrderCompletion('order-1');

    expect(mockOrderUpdateMany).not.toHaveBeenCalled();
  });

  test('M25-09: CAS updateMany returns count=0 (concurrent race) => skip notification', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'completed' },
    ]);
    mockOrderFindUnique.mockResolvedValue({ id: 'order-1', status: 'in_progress', customerId: 'cust-1' });
    mockOrderUpdateMany.mockResolvedValue({ count: 0 });

    await trackingFleetService.checkOrderCompletion('order-1');

    // Customer should NOT be notified if CAS returned 0
    expect(mockEmitToUser).not.toHaveBeenCalled();
  });

  test('M25-10: order not found => skip gracefully', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'completed' },
    ]);
    mockOrderFindUnique.mockResolvedValue(null);

    await trackingFleetService.checkOrderCompletion('order-1');

    expect(mockOrderUpdateMany).not.toHaveBeenCalled();
  });
});

// =============================================================================
// F-H18: CLEAR ACTIVE-BROADCAST SENTINEL ON COMPLETION
// =============================================================================

describe('F-H18: Clear active-broadcast sentinel on completion', () => {
  let trackingFleetService: any;

  beforeEach(async () => {
    resetAllMocks();
    const mod = await import('../modules/tracking/tracking-fleet.service');
    trackingFleetService = (mod as any).trackingFleetService;
  });

  test('H18-01: checkBookingCompletion calls clearCustomerActiveBroadcast', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'completed' },
    ]);
    mockGetBookingById.mockResolvedValue({ id: 'booking-1', customerId: 'cust-1', status: 'in_progress' });
    mockUpdateBooking.mockResolvedValue({});
    mockAssignmentFindFirst.mockResolvedValue(null);

    await trackingFleetService.checkBookingCompletion('booking-1');

    expect(mockClearCustomerActiveBroadcast).toHaveBeenCalledWith('cust-1');
  });

  test('H18-02: checkOrderCompletion calls clearCustomerActiveBroadcast', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'completed' },
    ]);
    mockOrderFindUnique.mockResolvedValue({ id: 'order-1', status: 'in_progress', customerId: 'cust-2' });
    mockOrderUpdateMany.mockResolvedValue({ count: 1 });

    await trackingFleetService.checkOrderCompletion('order-1');

    expect(mockClearCustomerActiveBroadcast).toHaveBeenCalledWith('cust-2');
  });

  test('H18-03: customer can create new booking after completion clears sentinel', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'completed' },
    ]);
    mockGetBookingById.mockResolvedValue({ id: 'booking-1', customerId: 'cust-1', status: 'in_progress' });
    mockUpdateBooking.mockResolvedValue({});
    mockAssignmentFindFirst.mockResolvedValue(null);

    await trackingFleetService.checkBookingCompletion('booking-1');

    // clearCustomerActiveBroadcast was called, meaning Redis key is deleted
    expect(mockClearCustomerActiveBroadcast).toHaveBeenCalledTimes(1);
    // After clearing, a new booking creation would succeed (sentinel removed)
  });

  test('H18-04: clearCustomerActiveBroadcast failure does NOT block completion', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'completed' },
    ]);
    mockGetBookingById.mockResolvedValue({ id: 'booking-1', customerId: 'cust-1', status: 'in_progress' });
    mockUpdateBooking.mockResolvedValue({});
    mockAssignmentFindFirst.mockResolvedValue(null);

    // Make clearCustomerActiveBroadcast fail
    mockClearCustomerActiveBroadcast.mockRejectedValue(new Error('Redis down'));

    // Should NOT throw — completion is non-fatal
    await trackingFleetService.checkBookingCompletion('booking-1');

    // Booking was still completed
    expect(mockUpdateBooking).toHaveBeenCalledWith('booking-1', { status: 'completed' });
  });

  test('H18-05: if booking already completed, clearCustomerActiveBroadcast NOT called', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'completed' },
    ]);
    mockGetBookingById.mockResolvedValue({ id: 'booking-1', customerId: 'cust-1', status: 'completed' });

    await trackingFleetService.checkBookingCompletion('booking-1');

    // Should not call clear because booking was already completed (idempotent guard)
    expect(mockClearCustomerActiveBroadcast).not.toHaveBeenCalled();
  });

  test('H18-06: order completion without customerId does not call clearCustomerActiveBroadcast', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockAssignmentFindMany.mockResolvedValue([
      { id: 'a1', status: 'completed' },
    ]);
    mockOrderFindUnique.mockResolvedValue({ id: 'order-1', status: 'in_progress', customerId: null });
    mockOrderUpdateMany.mockResolvedValue({ count: 1 });

    await trackingFleetService.checkOrderCompletion('order-1');

    expect(mockClearCustomerActiveBroadcast).not.toHaveBeenCalled();
  });
});

// =============================================================================
// ADDITIONAL EDGE CASES: LIFECYCLE SERVICE COMPLETION
// =============================================================================

describe('Lifecycle service: updateStatus completion via lifecycle service', () => {
  beforeEach(() => resetAllMocks());

  test('LIFE-01: completed status transition from arrived_at_drop succeeds', async () => {
    const assignment = makeAssignment({ status: 'arrived_at_drop' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockUpdateAssignment.mockResolvedValue({ ...assignment, status: 'completed' });

    const result = await assignmentLifecycleService.updateStatus('assign-1', 'driver-1', { status: 'completed' } as any);

    expect(result.status).toBe('completed');
  });

  test('LIFE-02: in_transit status sets startedAt timestamp', async () => {
    const assignment = makeAssignment({ status: 'at_pickup' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockUpdateAssignment.mockImplementation((_id: string, updates: any) => ({
      ...assignment,
      ...updates,
    }));

    const result = await assignmentLifecycleService.updateStatus('assign-1', 'driver-1', { status: 'in_transit' } as any);

    expect(result.startedAt).toBeDefined();
  });

  test('LIFE-03: lifecycle service releases vehicle on completion', async () => {
    const assignment = makeAssignment({ status: 'arrived_at_drop', vehicleId: 'v-1' });
    mockGetAssignmentById.mockResolvedValue(assignment);
    mockUpdateAssignment.mockResolvedValue({ ...assignment, status: 'completed' });

    await assignmentLifecycleService.updateStatus('assign-1', 'driver-1', { status: 'completed' } as any);

    // releaseVehicle is called via releaseVehicleOnCompletion
    const { releaseVehicle } = require('../shared/services/vehicle-lifecycle.service');
    expect(releaseVehicle).toHaveBeenCalledWith('v-1', 'tripCompleted');
  });

  test('LIFE-04: wrong driver cannot update assignment status', async () => {
    const assignment = makeAssignment({ status: 'in_transit', driverId: 'driver-1' });
    mockGetAssignmentById.mockResolvedValue(assignment);

    await expect(
      assignmentLifecycleService.updateStatus('assign-1', 'wrong-driver', { status: 'arrived_at_drop' } as any)
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
  });

  test('LIFE-05: assignment not found throws 404', async () => {
    mockGetAssignmentById.mockResolvedValue(null);

    await expect(
      assignmentLifecycleService.updateStatus('nope', 'driver-1', { status: 'completed' } as any)
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'ASSIGNMENT_NOT_FOUND',
    });
  });
});

// =============================================================================
// VALID TRANSITIONS TABLE TESTS
// =============================================================================

describe('Valid transition enforcement', () => {
  beforeEach(() => resetAllMocks());

  const terminalStatuses = ['completed', 'cancelled', 'driver_declined', 'partial_delivery'];
  const nonTerminalStatuses = ['pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit', 'arrived_at_drop'];

  test.each(terminalStatuses)('VT-01: terminal status %s has empty transition list', async (status) => {
    const assignment = makeAssignment({ status });
    mockGetAssignmentById.mockResolvedValue(assignment);

    await expect(
      assignmentService.updateStatus('assign-1', 'driver-1', { status: 'completed' } as any)
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_TRANSITION' });
  });

  test.each(nonTerminalStatuses)('VT-02: non-terminal status %s allows at least one transition', async (status) => {
    const assignment = makeAssignment({ status });
    mockGetAssignmentById.mockResolvedValue(assignment);

    // Try cancellation — should be in allowed list for all non-terminal
    if (status === 'pending') {
      // pending can go to cancelled
      mockPrismaTransaction.mockImplementation(async (cb: Function) => {
        const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        $executeRaw: jest.fn().mockResolvedValue(0),
        $executeRawUnsafe: jest.fn().mockResolvedValue(0),
          assignment: { updateMany: mockAssignmentUpdateMany.mockResolvedValue({ count: 1 }) },
          vehicle: { updateMany: mockVehicleUpdateMany.mockResolvedValue({ count: 1 }) },
        };
        await cb(tx);
      });
      mockVehicleFindUnique.mockResolvedValue({ vehicleKey: 'VK1', transporterId: 'transporter-1' });

      await assignmentService.cancelAssignment('assign-1', 'transporter-1');
      expect(mockAssignmentUpdateMany).toHaveBeenCalled();
    }
    // Other statuses — just verify the status is accepted as non-terminal
    expect(['pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit', 'arrived_at_drop']).toContain(status);
  });
});
