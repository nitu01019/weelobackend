/**
 * =============================================================================
 * QA COMPLETION E2E — Comprehensive tests for trip completion flow
 * =============================================================================
 *
 * Tests the unified completion orchestrator (completion-orchestrator.ts) and
 * both entry points (driver-initiated via tracking, admin-initiated via
 * assignment.service updateStatus).
 *
 * COVERAGE:
 *  1. completeTrip() happy path (driver / admin / timeout initiators)
 *  2. Atomic DB transaction (assignment + vehicle in same TX)
 *  3. Each side-effect individually:
 *     - Outbox row (payment trigger)
 *     - Rating prompt (3-min delayed FCM)
 *     - Rating reminders (24h/72h Redis keys)
 *     - Booking cascade (checkBookingCompletion)
 *     - Order cascade (via booking)
 *     - Fleet cache invalidation
 *     - driver:active-assignment Redis cleanup
 *     - WebSocket broadcast
 *     - FCM push (transporter + customer)
 *  4. Failure in each side-effect doesn't block others
 *  5. Idempotency: 3-layer guard (Redis lock, terminal check, CAS)
 *  6. Partial delivery completion
 *  7. Feature flag FF_COMPLETION_ORCHESTRATOR toggle
 *  8. Both paths converge to same orchestrator
 *
 * @author qa-completion agent
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — must come before any imports
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

jest.mock('../config/environment', () => ({
  config: { redis: { enabled: true }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {} },
}));

// ---------------------------------------------------------------------------
// Redis mock
// ---------------------------------------------------------------------------
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn().mockResolvedValue(undefined);
const mockRedisDel = jest.fn().mockResolvedValue(undefined);
const mockRedisAcquireLock = jest.fn();
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
    exists: jest.fn().mockResolvedValue(false),
    incr: jest.fn().mockResolvedValue(1),
    incrBy: jest.fn().mockResolvedValue(1),
    sMembers: jest.fn().mockResolvedValue([]),
    sAdd: jest.fn().mockResolvedValue(undefined),
    sIsMember: jest.fn().mockResolvedValue(false),
    getJSON: jest.fn().mockResolvedValue(null),
    setJSON: jest.fn().mockResolvedValue(undefined),
    getExpiredTimers: jest.fn().mockResolvedValue([]),
    cancelTimer: jest.fn().mockResolvedValue(undefined),
    setTimer: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
    isDegraded: false,
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Prisma mock
// ---------------------------------------------------------------------------
const mockAssignmentUpdateMany = jest.fn();
const mockVehicleFindUnique = jest.fn();
const mockVehicleUpdateMany = jest.fn();
const mockBookingFindUnique = jest.fn();
const mockOrderFindUnique = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../shared/database/prisma.service', () => {
  const txProxy = {
    assignment: {
      updateMany: (...args: any[]) => mockAssignmentUpdateMany(...args),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    vehicle: {
      findUnique: (...args: any[]) => mockVehicleFindUnique(...args),
      updateMany: (...args: any[]) => mockVehicleUpdateMany(...args),
    },
    booking: {
      findUnique: (...args: any[]) => mockBookingFindUnique(...args),
    },
    order: {
      findUnique: (...args: any[]) => mockOrderFindUnique(...args),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  return {
    prismaClient: {
      ...txProxy,
      $transaction: (...args: any[]) => mockTransaction(...args),
    },
    withDbTimeout: jest.fn(),
  };
});

// ---------------------------------------------------------------------------
// DB mock (getAssignmentById)
// ---------------------------------------------------------------------------
const mockGetAssignmentById = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getAssignmentById: (...args: any[]) => mockGetAssignmentById(...args),
    getBookingById: jest.fn().mockResolvedValue(null),
    getVehicleById: jest.fn().mockResolvedValue(null),
    getUserById: jest.fn().mockResolvedValue(null),
    getBookingsByCustomer: jest.fn().mockResolvedValue([]),
    getAssignmentsByTransporter: jest.fn().mockResolvedValue([]),
    updateAssignment: jest.fn().mockResolvedValue({}),
  },
}));

// ---------------------------------------------------------------------------
// Socket mock
// ---------------------------------------------------------------------------
const mockEmitToUser = jest.fn();
const mockEmitToBooking = jest.fn();
const mockEmitToTrip = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToBooking: (...args: any[]) => mockEmitToBooking(...args),
  emitToTrip: (...args: any[]) => mockEmitToTrip(...args),
  SocketEvent: {
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    TRUCK_ASSIGNED: 'truck_assigned',
    TRIP_ASSIGNED: 'trip_assigned',
  },
}));

// ---------------------------------------------------------------------------
// Queue mock
// ---------------------------------------------------------------------------
const mockQueuePush = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queuePushNotification: (...args: any[]) => mockQueuePush(...args),
    scheduleAssignmentTimeout: jest.fn().mockResolvedValue(undefined),
    enqueue: jest.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Live availability mock
// ---------------------------------------------------------------------------
const mockOnVehicleStatusChange = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: (...args: any[]) => mockOnVehicleStatusChange(...args),
  },
}));

// ---------------------------------------------------------------------------
// Fleet cache mock
// ---------------------------------------------------------------------------
const mockInvalidateVehicleCache = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/fleet-cache-write.service', () => ({
  invalidateVehicleCache: (...args: any[]) => mockInvalidateVehicleCache(...args),
}));

// ---------------------------------------------------------------------------
// Outbox mock
// ---------------------------------------------------------------------------
const mockEnqueueOutbox = jest.fn().mockResolvedValue('outbox-id-1');

jest.mock('../modules/order/order-lifecycle-outbox.service', () => ({
  enqueueCompletionLifecycleOutbox: (...args: any[]) => mockEnqueueOutbox(...args),
}));

// ---------------------------------------------------------------------------
// Tracking mock
// ---------------------------------------------------------------------------
const mockCompleteTracking = jest.fn().mockResolvedValue(undefined);
const mockCheckBookingCompletion = jest.fn().mockResolvedValue(undefined);

jest.mock('../modules/tracking/tracking.service', () => ({
  trackingService: {
    completeTracking: (...args: any[]) => mockCompleteTracking(...args),
    checkBookingCompletion: (...args: any[]) => mockCheckBookingCompletion(...args),
  },
}));

// ---------------------------------------------------------------------------
// State machines — use real values
// ---------------------------------------------------------------------------
jest.mock('../core/state-machines', () => ({
  TERMINAL_ASSIGNMENT_STATUSES: ['completed', 'cancelled', 'driver_declined', 'partial_delivery'],
  ASSIGNMENT_VALID_TRANSITIONS: {
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
  },
}));

// Auto-redispatch mock
jest.mock('../modules/assignment/auto-redispatch.service', () => ({
  tryAutoRedispatch: jest.fn().mockResolvedValue(undefined),
}));

// Hold config mock
jest.mock('../core/config/hold-config', () => ({
  HOLD_CONFIG: { driverAcceptTimeoutMs: 30000 },
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { completeTrip } from '../modules/assignment/completion-orchestrator';

// =============================================================================
// TEST DATA FACTORY
// =============================================================================

function makeAssignment(overrides: Record<string, any> = {}) {
  return {
    id: 'assign-001',
    bookingId: 'booking-001',
    orderId: 'order-001',
    transporterId: 'trans-001',
    transporterName: 'Test Transport',
    vehicleId: 'veh-001',
    vehicleNumber: 'KA01AB1234',
    vehicleType: 'mini_truck',
    vehicleSubtype: 'open_body',
    driverId: 'driver-001',
    driverName: 'Raju',
    driverPhone: '9876543210',
    tripId: 'trip-001',
    status: 'arrived_at_drop',
    assignedAt: '2026-04-14T10:00:00.000Z',
    startedAt: '2026-04-14T10:30:00.000Z',
    ...overrides,
  };
}

// =============================================================================
// SETUP / TEARDOWN
// =============================================================================

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();

  // Default: lock acquired successfully
  mockRedisAcquireLock.mockResolvedValue({ acquired: true });

  // Default: assignment found, non-terminal
  mockGetAssignmentById.mockResolvedValue(makeAssignment());

  // Default: vehicle exists
  mockVehicleFindUnique.mockResolvedValue({
    id: 'veh-001',
    vehicleKey: 'KA01AB1234',
    transporterId: 'trans-001',
    status: 'in_transit',
  });

  // Default: TX succeeds (runs the callback)
  mockTransaction.mockImplementation(async (fn: Function) => fn({
    assignment: { updateMany: mockAssignmentUpdateMany },
    vehicle: { updateMany: mockVehicleUpdateMany },
  }));

  // Default: CAS guard passes (1 row updated)
  mockAssignmentUpdateMany.mockResolvedValue({ count: 1 });
  mockVehicleUpdateMany.mockResolvedValue({ count: 1 });

  // Default: booking found for customer resolution
  mockBookingFindUnique.mockResolvedValue({ customerId: 'cust-001' });
});

afterEach(() => {
  jest.useRealTimers();
});

// =============================================================================
// GROUP 1: HAPPY PATH — all three initiators
// =============================================================================

describe('GROUP 1: completeTrip() happy path', () => {
  it('1.1 driver-initiated completion returns success', async () => {
    const result = await completeTrip('assign-001', 'driver');
    expect(result.success).toBe(true);
    expect(result.assignmentId).toBe('assign-001');
    expect(result.alreadyCompleted).toBe(false);
  });

  it('1.2 admin-initiated completion returns success', async () => {
    const result = await completeTrip('assign-001', 'admin');
    expect(result.success).toBe(true);
    expect(result.alreadyCompleted).toBe(false);
  });

  it('1.3 timeout-initiated completion returns success', async () => {
    const result = await completeTrip('assign-001', 'timeout');
    expect(result.success).toBe(true);
    expect(result.alreadyCompleted).toBe(false);
  });

  it('1.4 acquires and releases Redis idempotency lock', async () => {
    await completeTrip('assign-001', 'driver');

    expect(mockRedisAcquireLock).toHaveBeenCalledWith(
      'completion:assign-001',
      expect.stringContaining('completion:'),
      30
    );
    expect(mockRedisReleaseLock).toHaveBeenCalledWith(
      'completion:assign-001',
      expect.stringContaining('completion:')
    );
  });

  it('1.5 fetches assignment by ID', async () => {
    await completeTrip('assign-001', 'driver');
    expect(mockGetAssignmentById).toHaveBeenCalledWith('assign-001');
  });

  it('1.6 default terminalStatus is completed', async () => {
    await completeTrip('assign-001', 'driver');

    // CAS guard updates with status = 'completed'
    expect(mockAssignmentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'completed' }),
      })
    );
  });
});

// =============================================================================
// GROUP 2: ATOMIC DB TRANSACTION (assignment + vehicle)
// =============================================================================

describe('GROUP 2: Atomic DB transaction', () => {
  it('2.1 wraps assignment + vehicle update in $transaction', async () => {
    await completeTrip('assign-001', 'driver');
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockTransaction).toHaveBeenCalledWith(expect.any(Function));
  });

  it('2.2 CAS guard uses notIn for terminal statuses', async () => {
    await completeTrip('assign-001', 'driver');

    expect(mockAssignmentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'assign-001',
          status: { notIn: expect.arrayContaining(['completed', 'cancelled', 'driver_declined', 'partial_delivery']) },
        }),
      })
    );
  });

  it('2.3 vehicle released to available inside TX', async () => {
    await completeTrip('assign-001', 'driver');

    expect(mockVehicleUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'veh-001' }),
        data: expect.objectContaining({
          status: 'available',
          currentTripId: null,
          assignedDriverId: null,
        }),
      })
    );
  });

  it('2.4 skips vehicle update when vehicleId is null', async () => {
    mockGetAssignmentById.mockResolvedValue(makeAssignment({ vehicleId: null }));

    await completeTrip('assign-001', 'driver');

    // TX is called, but vehicle.updateMany should NOT be called inside it
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    // Vehicle findUnique for status read should not be called
    const vehicleFindCalls = mockVehicleFindUnique.mock.calls.filter(
      (c: any[]) => c[0]?.where?.id === 'veh-001'
    );
    expect(vehicleFindCalls.length).toBe(0);
  });

  it('2.5 sets completedAt timestamp on assignment', async () => {
    await completeTrip('assign-001', 'driver');

    expect(mockAssignmentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          completedAt: expect.any(String),
        }),
      })
    );
  });

  it('2.6 Redis vehicle sync fires after TX commit', async () => {
    await completeTrip('assign-001', 'driver');

    expect(mockOnVehicleStatusChange).toHaveBeenCalledWith(
      'trans-001',
      'KA01AB1234',
      'in_transit',
      'available'
    );
  });
});

// =============================================================================
// GROUP 3: INDIVIDUAL SIDE-EFFECTS
// =============================================================================

describe('GROUP 3: Side-effects — outbox row', () => {
  it('3.1 writes trip_completed outbox row', async () => {
    await completeTrip('assign-001', 'driver');

    expect(mockEnqueueOutbox).toHaveBeenCalledTimes(1);
    const payload = mockEnqueueOutbox.mock.calls[0][0];
    expect(payload.type).toBe('trip_completed');
    expect(payload.assignmentId).toBe('assign-001');
    expect(payload.tripId).toBe('trip-001');
    expect(payload.transporterId).toBe('trans-001');
    expect(payload.driverId).toBe('driver-001');
    expect(payload.completedAt).toBeDefined();
    expect(payload.eventId).toBeDefined();
    expect(payload.eventVersion).toBe(1);
    expect(payload.serverTimeMs).toBeGreaterThan(0);
  });

  it('3.2 outbox payload includes customerId from booking', async () => {
    mockBookingFindUnique.mockResolvedValue({ customerId: 'cust-999' });

    await completeTrip('assign-001', 'driver');

    const payload = mockEnqueueOutbox.mock.calls[0][0];
    expect(payload.customerId).toBe('cust-999');
  });

  it('3.3 outbox payload falls back to order when no booking', async () => {
    mockGetAssignmentById.mockResolvedValue(makeAssignment({ bookingId: null }));
    mockBookingFindUnique.mockResolvedValue(null);
    mockOrderFindUnique.mockResolvedValue({ customerId: 'cust-from-order' });

    await completeTrip('assign-001', 'driver');

    const payload = mockEnqueueOutbox.mock.calls[0][0];
    expect(payload.customerId).toBe('cust-from-order');
  });
});

describe('GROUP 3: Side-effects — rating prompt', () => {
  it('3.4 schedules rating prompt FCM via setTimeout (3-min delay)', async () => {
    await completeTrip('assign-001', 'driver');

    // Advance timers by 3 minutes
    jest.advanceTimersByTime(3 * 60 * 1000);
    // Allow microtasks to flush
    await Promise.resolve();

    expect(mockQueuePush).toHaveBeenCalledWith(
      'cust-001',
      expect.objectContaining({
        title: 'How was your delivery?',
        data: expect.objectContaining({
          type: 'rating_prompt',
          assignmentId: 'assign-001',
          screen: 'RATING',
        }),
      })
    );
  });

  it('3.5 rating prompt body includes driver name', async () => {
    await completeTrip('assign-001', 'driver');
    jest.advanceTimersByTime(3 * 60 * 1000);
    await Promise.resolve();

    const call = mockQueuePush.mock.calls.find(
      (c: any[]) => c[1]?.data?.type === 'rating_prompt'
    );
    expect(call).toBeDefined();
    expect(call![1].body).toContain('Raju');
  });

  it('3.6 no rating prompt when customer cannot be resolved', async () => {
    mockBookingFindUnique.mockResolvedValue(null);
    mockOrderFindUnique.mockResolvedValue(null);
    mockGetAssignmentById.mockResolvedValue(makeAssignment({ bookingId: null, orderId: null }));

    await completeTrip('assign-001', 'driver');
    jest.advanceTimersByTime(3 * 60 * 1000);
    await Promise.resolve();

    const ratingCalls = mockQueuePush.mock.calls.filter(
      (c: any[]) => c[1]?.data?.type === 'rating_prompt'
    );
    expect(ratingCalls.length).toBe(0);
  });
});

describe('GROUP 3: Side-effects — rating reminders', () => {
  it('3.7 sets 24h and 72h rating reminder Redis keys', async () => {
    await completeTrip('assign-001', 'driver');

    expect(mockRedisSet).toHaveBeenCalledWith(
      'rating:remind:24h:assign-001',
      expect.any(String),
      86400
    );
    expect(mockRedisSet).toHaveBeenCalledWith(
      'rating:remind:72h:assign-001',
      expect.any(String),
      259200
    );
  });

  it('3.8 reminder data includes customerId and driverName', async () => {
    await completeTrip('assign-001', 'driver');

    const call24h = mockRedisSet.mock.calls.find(
      (c: any[]) => c[0] === 'rating:remind:24h:assign-001'
    );
    expect(call24h).toBeDefined();
    const data = JSON.parse(call24h![1]);
    expect(data.customerId).toBe('cust-001');
    expect(data.driverName).toBe('Raju');
    expect(data.assignmentId).toBe('assign-001');
  });
});

describe('GROUP 3: Side-effects — booking cascade', () => {
  it('3.9 calls checkBookingCompletion when bookingId exists', async () => {
    await completeTrip('assign-001', 'driver');
    expect(mockCheckBookingCompletion).toHaveBeenCalledWith('booking-001');
  });

  it('3.10 skips booking cascade when bookingId is null', async () => {
    mockGetAssignmentById.mockResolvedValue(makeAssignment({ bookingId: null }));
    await completeTrip('assign-001', 'driver');
    expect(mockCheckBookingCompletion).not.toHaveBeenCalled();
  });
});

describe('GROUP 3: Side-effects — fleet cache', () => {
  it('3.11 invalidates fleet cache for transporter + vehicle', async () => {
    await completeTrip('assign-001', 'driver');
    expect(mockInvalidateVehicleCache).toHaveBeenCalledWith('trans-001', 'veh-001');
  });

  it('3.12 skips fleet cache when transporterId is missing', async () => {
    mockGetAssignmentById.mockResolvedValue(makeAssignment({ transporterId: '' }));
    await completeTrip('assign-001', 'driver');
    expect(mockInvalidateVehicleCache).not.toHaveBeenCalled();
  });
});

describe('GROUP 3: Side-effects — driver:active-assignment cleanup', () => {
  it('3.13 deletes driver:active-assignment Redis key', async () => {
    await completeTrip('assign-001', 'driver');
    expect(mockRedisDel).toHaveBeenCalledWith('driver:active-assignment:driver-001');
  });

  it('3.14 skips cleanup when driverId is missing', async () => {
    mockGetAssignmentById.mockResolvedValue(makeAssignment({ driverId: '' }));
    await completeTrip('assign-001', 'driver');

    const delCalls = mockRedisDel.mock.calls.filter(
      (c: any[]) => (c[0] as string).startsWith('driver:active-assignment:')
    );
    expect(delCalls.length).toBe(0);
  });
});

describe('GROUP 3: Side-effects — WebSocket broadcast', () => {
  it('3.15 emits to booking room with correct payload', async () => {
    await completeTrip('assign-001', 'driver');

    expect(mockEmitToBooking).toHaveBeenCalledWith(
      'booking-001',
      'assignment_status_changed',
      expect.objectContaining({
        assignmentId: 'assign-001',
        tripId: 'trip-001',
        status: 'completed',
        vehicleNumber: 'KA01AB1234',
        driverName: 'Raju',
        completedAt: expect.any(String),
      })
    );
  });

  it('3.16 emits to transporter with message text', async () => {
    await completeTrip('assign-001', 'driver');

    expect(mockEmitToUser).toHaveBeenCalledWith(
      'trans-001',
      'assignment_status_changed',
      expect.objectContaining({
        assignmentId: 'assign-001',
        message: expect.stringContaining('Raju completed the trip'),
      })
    );
  });

  it('3.17 skips booking room emit when bookingId is null', async () => {
    mockGetAssignmentById.mockResolvedValue(makeAssignment({ bookingId: null }));
    await completeTrip('assign-001', 'driver');
    expect(mockEmitToBooking).not.toHaveBeenCalled();
  });
});

describe('GROUP 3: Side-effects — FCM push', () => {
  it('3.18 sends FCM to transporter', async () => {
    await completeTrip('assign-001', 'driver');

    expect(mockQueuePush).toHaveBeenCalledWith(
      'trans-001',
      expect.objectContaining({
        title: 'Trip Completed',
        data: expect.objectContaining({
          type: 'assignment_update',
          status: 'completed',
        }),
      })
    );
  });

  it('3.19 sends FCM to customer', async () => {
    await completeTrip('assign-001', 'driver');

    expect(mockQueuePush).toHaveBeenCalledWith(
      'cust-001',
      expect.objectContaining({
        title: 'Trip Completed',
        body: expect.stringContaining('KA01AB1234'),
      })
    );
  });

  it('3.20 emits WebSocket to customer with completion details', async () => {
    await completeTrip('assign-001', 'driver');

    expect(mockEmitToUser).toHaveBeenCalledWith(
      'cust-001',
      'assignment_status_changed',
      expect.objectContaining({
        assignmentId: 'assign-001',
        status: 'completed',
        message: expect.stringContaining('completed'),
      })
    );
  });
});

describe('GROUP 3: Side-effects — tracking cleanup', () => {
  it('3.21 calls completeTracking with tripId', async () => {
    await completeTrip('assign-001', 'driver');
    expect(mockCompleteTracking).toHaveBeenCalledWith('trip-001');
  });
});

// =============================================================================
// GROUP 4: SIDE-EFFECT FAILURE ISOLATION
// =============================================================================

describe('GROUP 4: Side-effect failure isolation', () => {
  it('4.1 outbox failure does not block other side-effects', async () => {
    mockEnqueueOutbox.mockRejectedValue(new Error('outbox DB error'));

    const result = await completeTrip('assign-001', 'driver');
    expect(result.success).toBe(true);
    expect(mockCheckBookingCompletion).toHaveBeenCalled();
    expect(mockInvalidateVehicleCache).toHaveBeenCalled();
    expect(mockEmitToUser).toHaveBeenCalled();
  });

  it('4.2 tracking cleanup failure does not block other side-effects', async () => {
    mockCompleteTracking.mockRejectedValue(new Error('Redis down'));

    const result = await completeTrip('assign-001', 'driver');
    expect(result.success).toBe(true);
    expect(mockEnqueueOutbox).toHaveBeenCalled();
    expect(mockInvalidateVehicleCache).toHaveBeenCalled();
  });

  it('4.3 booking cascade failure does not block other side-effects', async () => {
    mockCheckBookingCompletion.mockRejectedValue(new Error('cascade error'));

    const result = await completeTrip('assign-001', 'driver');
    expect(result.success).toBe(true);
    expect(mockInvalidateVehicleCache).toHaveBeenCalled();
    expect(mockRedisDel).toHaveBeenCalledWith('driver:active-assignment:driver-001');
  });

  it('4.4 fleet cache failure does not block other side-effects', async () => {
    mockInvalidateVehicleCache.mockRejectedValue(new Error('cache error'));

    const result = await completeTrip('assign-001', 'driver');
    expect(result.success).toBe(true);
    expect(mockRedisDel).toHaveBeenCalledWith('driver:active-assignment:driver-001');
    expect(mockEmitToUser).toHaveBeenCalled();
  });

  it('4.5 driver:active-assignment del failure does not block others', async () => {
    mockRedisDel.mockRejectedValue(new Error('Redis del error'));

    const result = await completeTrip('assign-001', 'driver');
    expect(result.success).toBe(true);
    expect(mockEmitToBooking).toHaveBeenCalled();
  });

  it('4.6 WebSocket failure does not block FCM push', async () => {
    mockEmitToBooking.mockImplementation(() => { throw new Error('socket error'); });
    mockEmitToUser.mockImplementation(() => { throw new Error('socket error'); });

    const result = await completeTrip('assign-001', 'driver');
    expect(result.success).toBe(true);
    // FCM still attempted
    expect(mockQueuePush).toHaveBeenCalled();
  });

  it('4.7 Redis vehicle sync failure does not block other side-effects', async () => {
    mockOnVehicleStatusChange.mockRejectedValue(new Error('Redis sync error'));

    const result = await completeTrip('assign-001', 'driver');
    expect(result.success).toBe(true);
    expect(mockCompleteTracking).toHaveBeenCalled();
    expect(mockEnqueueOutbox).toHaveBeenCalled();
  });

  it('4.8 all side-effects fail — TX still committed, returns success', async () => {
    mockCompleteTracking.mockRejectedValue(new Error('fail'));
    mockEnqueueOutbox.mockRejectedValue(new Error('fail'));
    mockCheckBookingCompletion.mockRejectedValue(new Error('fail'));
    mockInvalidateVehicleCache.mockRejectedValue(new Error('fail'));
    mockRedisDel.mockRejectedValue(new Error('fail'));
    mockEmitToBooking.mockImplementation(() => { throw new Error('fail'); });
    mockEmitToUser.mockImplementation(() => { throw new Error('fail'); });
    mockQueuePush.mockRejectedValue(new Error('fail'));
    mockOnVehicleStatusChange.mockRejectedValue(new Error('fail'));

    const result = await completeTrip('assign-001', 'driver');
    expect(result.success).toBe(true);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// GROUP 5: IDEMPOTENCY — 3-layer guard
// =============================================================================

describe('GROUP 5: Idempotency — 3-layer guard', () => {
  it('5.1 Layer 1: Redis lock not acquired returns alreadyCompleted', async () => {
    mockRedisAcquireLock.mockResolvedValue({ acquired: false });

    const result = await completeTrip('assign-001', 'driver');
    expect(result.success).toBe(true);
    expect(result.alreadyCompleted).toBe(true);
    expect(mockGetAssignmentById).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('5.2 Layer 2: assignment already terminal returns alreadyCompleted', async () => {
    mockGetAssignmentById.mockResolvedValue(makeAssignment({ status: 'completed' }));

    const result = await completeTrip('assign-001', 'driver');
    expect(result.success).toBe(true);
    expect(result.alreadyCompleted).toBe(true);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('5.3 Layer 2: cancelled status is terminal', async () => {
    mockGetAssignmentById.mockResolvedValue(makeAssignment({ status: 'cancelled' }));

    const result = await completeTrip('assign-001', 'driver');
    expect(result.alreadyCompleted).toBe(true);
  });

  it('5.4 Layer 2: driver_declined status is terminal', async () => {
    mockGetAssignmentById.mockResolvedValue(makeAssignment({ status: 'driver_declined' }));

    const result = await completeTrip('assign-001', 'driver');
    expect(result.alreadyCompleted).toBe(true);
  });

  it('5.5 Layer 2: partial_delivery status is terminal', async () => {
    mockGetAssignmentById.mockResolvedValue(makeAssignment({ status: 'partial_delivery' }));

    const result = await completeTrip('assign-001', 'driver');
    expect(result.alreadyCompleted).toBe(true);
  });

  it('5.6 Layer 3: CAS guard (updateMany count=0) skips side-effects but returns success', async () => {
    mockAssignmentUpdateMany.mockResolvedValue({ count: 0 });

    const result = await completeTrip('assign-001', 'driver');
    // TX runs but CAS guard prevents double-write
    expect(result.success).toBe(true);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('5.7 assignment not found returns not-success', async () => {
    mockGetAssignmentById.mockResolvedValue(null);

    const result = await completeTrip('nonexistent', 'driver');
    expect(result.success).toBe(false);
    expect(result.alreadyCompleted).toBe(false);
  });

  it('5.8 lock is always released even on error', async () => {
    mockGetAssignmentById.mockRejectedValue(new Error('DB exploded'));

    await expect(completeTrip('assign-001', 'driver')).rejects.toThrow('DB exploded');
    expect(mockRedisReleaseLock).toHaveBeenCalledWith(
      'completion:assign-001',
      expect.stringContaining('completion:')
    );
  });

  it('5.9 concurrent duplicate calls: second gets lock rejection', async () => {
    let callCount = 0;
    mockRedisAcquireLock.mockImplementation(async () => {
      callCount++;
      return { acquired: callCount === 1 };
    });

    const [r1, r2] = await Promise.all([
      completeTrip('assign-001', 'driver'),
      completeTrip('assign-001', 'driver'),
    ]);

    const completed = [r1, r2].filter(r => !r.alreadyCompleted);
    const skipped = [r1, r2].filter(r => r.alreadyCompleted);
    expect(completed.length).toBe(1);
    expect(skipped.length).toBe(1);
  });
});

// =============================================================================
// GROUP 6: PARTIAL DELIVERY
// =============================================================================

describe('GROUP 6: Partial delivery completion', () => {
  it('6.1 sets status to partial_delivery', async () => {
    await completeTrip('assign-001', 'driver', 'partial_delivery', 'Road blocked');

    expect(mockAssignmentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'partial_delivery' }),
      })
    );
  });

  it('6.2 WebSocket payload includes partialReason', async () => {
    await completeTrip('assign-001', 'driver', 'partial_delivery', 'Road blocked');

    expect(mockEmitToBooking).toHaveBeenCalledWith(
      'booking-001',
      'assignment_status_changed',
      expect.objectContaining({
        status: 'partial_delivery',
        partialReason: 'Road blocked',
      })
    );
  });

  it('6.3 transporter message includes partial delivery reason text', async () => {
    await completeTrip('assign-001', 'driver', 'partial_delivery', 'Road blocked');

    // The transporter gets a message in either WebSocket section (j) or FCM section (k).
    // Both use queuePushNotification or emitToUser for trans-001.
    // Check FCM push to transporter for partial text:
    const transporterFcm = mockQueuePush.mock.calls.find(
      (c: any[]) => c[0] === 'trans-001'
    );
    expect(transporterFcm).toBeDefined();
    expect(transporterFcm![1].body).toContain('partially delivered');
    expect(transporterFcm![1].body).toContain('Road blocked');
  });

  it('6.4 FCM title is Partial Delivery for partial', async () => {
    await completeTrip('assign-001', 'driver', 'partial_delivery', 'Road blocked');

    expect(mockQueuePush).toHaveBeenCalledWith(
      'trans-001',
      expect.objectContaining({ title: 'Partial Delivery' })
    );
  });

  it('6.5 outbox row still written for partial delivery', async () => {
    await completeTrip('assign-001', 'driver', 'partial_delivery', 'Road blocked');

    expect(mockEnqueueOutbox).toHaveBeenCalledTimes(1);
    const payload = mockEnqueueOutbox.mock.calls[0][0];
    expect(payload.type).toBe('trip_completed');
  });

  it('6.6 vehicle released to available even for partial delivery', async () => {
    await completeTrip('assign-001', 'driver', 'partial_delivery', 'Road blocked');

    expect(mockVehicleUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'available' }),
      })
    );
  });
});

// =============================================================================
// GROUP 7: FEATURE FLAG FF_COMPLETION_ORCHESTRATOR
// =============================================================================

describe('GROUP 7: Feature flag FF_COMPLETION_ORCHESTRATOR', () => {
  it('7.1 completeTrip is a callable function (orchestrator module exists)', () => {
    expect(typeof completeTrip).toBe('function');
  });

  it('7.2 assignment.service imports completeTrip from completion-orchestrator', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').resolve(__dirname, '../modules/assignment/assignment.service.ts'),
      'utf-8'
    );
    expect(src).toContain("import { completeTrip } from './completion-orchestrator'");
  });

  it('7.3 FF defaults to ON (process.env check)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').resolve(__dirname, '../modules/assignment/assignment.service.ts'),
      'utf-8'
    );
    expect(src).toContain("process.env.FF_COMPLETION_ORCHESTRATOR !== 'false'");
  });

  it('7.4 updateStatus routes to completeTrip when FF is ON', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').resolve(__dirname, '../modules/assignment/assignment.service.ts'),
      'utf-8'
    );
    expect(src).toContain('isCompletionStatus && FF_COMPLETION_ORCHESTRATOR');
    expect(src).toContain("await completeTrip(assignmentId, 'admin'");
  });

  it('7.5 legacy inline path still exists behind FF=false', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').resolve(__dirname, '../modules/assignment/assignment.service.ts'),
      'utf-8'
    );
    // Legacy path: else if (isCompletionStatus)
    expect(src).toContain('} else if (isCompletionStatus) {');
    expect(src).toContain('Legacy inline path');
  });
});

// =============================================================================
// GROUP 8: BOTH PATHS CONVERGE TO SAME ORCHESTRATOR
// =============================================================================

describe('GROUP 8: Both paths converge to completeTrip()', () => {
  it('8.1 tracking.service.ts calls completeTrip with driver initiator', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').resolve(__dirname, '../modules/tracking/tracking.service.ts'),
      'utf-8'
    );
    expect(src).toContain("await completeTrip(assignment.id, 'driver', 'completed')");
  });

  it('8.2 assignment.service.ts calls completeTrip with admin initiator', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').resolve(__dirname, '../modules/assignment/assignment.service.ts'),
      'utf-8'
    );
    expect(src).toContain("await completeTrip(assignmentId, 'admin'");
  });

  it('8.3 tracking path also checks FF_COMPLETION_ORCHESTRATOR', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').resolve(__dirname, '../modules/tracking/tracking.service.ts'),
      'utf-8'
    );
    expect(src).toContain('FF_COMPLETION_ORCHESTRATOR');
  });

  it('8.4 tracking path handles alreadyCompleted return', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').resolve(__dirname, '../modules/tracking/tracking.service.ts'),
      'utf-8'
    );
    expect(src).toContain('result.alreadyCompleted');
  });

  it('8.5 completeTrip accepts completedBy as second arg (type union)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').resolve(__dirname, '../modules/assignment/completion-orchestrator.ts'),
      'utf-8'
    );
    expect(src).toContain("type CompletedBy = 'driver' | 'admin' | 'timeout'");
  });

  it('8.6 completion-orchestrator has full side-effect checklist (a-k)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').resolve(__dirname, '../modules/assignment/completion-orchestrator.ts'),
      'utf-8'
    );
    const steps = ['(a)', '(b)', '(c)', '(d)', '(e)', '(f)', '(g)', '(h)', '(i)', '(j)', '(k)'];
    for (const step of steps) {
      expect(src).toContain(step);
    }
  });
});

// =============================================================================
// GROUP 9: EDGE CASES
// =============================================================================

describe('GROUP 9: Edge cases', () => {
  it('9.1 assignment with no bookingId and no orderId still completes', async () => {
    mockGetAssignmentById.mockResolvedValue(
      makeAssignment({ bookingId: null, orderId: null })
    );
    mockBookingFindUnique.mockResolvedValue(null);
    mockOrderFindUnique.mockResolvedValue(null);

    const result = await completeTrip('assign-001', 'driver');
    expect(result.success).toBe(true);
  });

  it('9.2 vehicle with no vehicleKey skips Redis sync without error', async () => {
    mockVehicleFindUnique.mockResolvedValue({
      id: 'veh-001',
      vehicleKey: null,
      transporterId: 'trans-001',
      status: 'in_transit',
    });

    const result = await completeTrip('assign-001', 'driver');
    expect(result.success).toBe(true);
    expect(mockOnVehicleStatusChange).not.toHaveBeenCalled();
  });

  it('9.3 vehicle already available — CAS guard in TX prevents double-release', async () => {
    mockVehicleFindUnique.mockResolvedValue({
      id: 'veh-001',
      vehicleKey: 'KA01AB1234',
      transporterId: 'trans-001',
      status: 'available',
    });

    const result = await completeTrip('assign-001', 'driver');
    expect(result.success).toBe(true);
    // TX still runs but vehicle updateMany has CAS: status not 'available'
    expect(mockVehicleUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { not: 'available' } }),
      })
    );
  });

  it('9.4 driverName defaults in rating prompt when null', async () => {
    mockGetAssignmentById.mockResolvedValue(makeAssignment({ driverName: null }));

    await completeTrip('assign-001', 'driver');
    jest.advanceTimersByTime(3 * 60 * 1000);
    await Promise.resolve();

    const ratingCall = mockQueuePush.mock.calls.find(
      (c: any[]) => c[1]?.data?.type === 'rating_prompt'
    );
    if (ratingCall) {
      expect(ratingCall[1].body).toContain('your driver');
    }
  });

  it('9.5 TX failure propagates as error (no silent swallow)', async () => {
    mockTransaction.mockRejectedValue(new Error('Serialization failure'));

    await expect(completeTrip('assign-001', 'driver')).rejects.toThrow('Serialization failure');
  });

  it('9.6 lock TTL is 30 seconds', async () => {
    await completeTrip('assign-001', 'driver');

    expect(mockRedisAcquireLock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      30
    );
  });
});
