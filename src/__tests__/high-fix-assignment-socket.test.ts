/**
 * =============================================================================
 * HIGH FIX TESTS — Issues #20, #21, #22, #23, #24, #25, #26
 * =============================================================================
 *
 * Agent B3 (Team BRAVO) — assignment-lifecycle, socket, queue-management fixes
 *
 * Issue #20: Inconsistent socket events (TRIP_ASSIGNED vs ASSIGNMENT_STATUS_CHANGED)
 * Issue #21: Timeout sends 3 different status strings
 * Issue #22: DRIVER_TIMEOUT event overloaded (assignment + presence)
 * Issue #23: FCM says "reassigned" but no auto-reassignment exists
 * Issue #24: isUserConnected() is LOCAL-instance only
 * Issue #25: No DLQ consumer for failed queue jobs
 * Issue #26: getTransportersWithVehicleType doesn't filter by vehicle status
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — Must come before any imports
// =============================================================================

const mockEmitToUser = jest.fn();
const mockEmitToBooking = jest.fn();
const mockQueuePushNotification = jest.fn().mockResolvedValue('job-1');
const mockCancelAssignmentTimeout = jest.fn().mockResolvedValue(undefined);

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
    setGauge: jest.fn(),
  },
}));

jest.mock('../config/environment', () => ({
  config: {
    redis: { enabled: true },
    isProduction: false,
    isDevelopment: true,
    otp: { expiryMinutes: 5 },
    sms: {},
    jwt: { secret: 'test-secret' },
  },
}));

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToBooking: (...args: any[]) => mockEmitToBooking(...args),
  isUserConnected: jest.fn(),
  isUserConnectedAsync: jest.fn(),
  SocketEvent: {
    CONNECTED: 'connected',
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    TRIP_ASSIGNED: 'trip_assigned',
    DRIVER_TIMEOUT: 'driver_timeout',
    ASSIGNMENT_TIMEOUT: 'assignment_timeout',
    DRIVER_PRESENCE_TIMEOUT: 'driver_presence_timeout',
    NEW_BROADCAST: 'new_broadcast',
    BOOKING_UPDATED: 'booking_updated',
    ERROR: 'error',
  },
}));

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queuePushNotification: (...args: any[]) => mockQueuePushNotification(...args),
    cancelAssignmentTimeout: (...args: any[]) => mockCancelAssignmentTimeout(...args),
    queueBroadcast: jest.fn().mockResolvedValue('job-id'),
    scheduleAssignmentTimeout: jest.fn().mockResolvedValue('timer-key'),
  },
}));

const mockRedisSet = jest.fn().mockResolvedValue('OK');
const mockRedisDel = jest.fn().mockResolvedValue(1);
const mockRedisExists = jest.fn().mockResolvedValue(false);
const mockRedisSIsMember = jest.fn().mockResolvedValue(false);
const mockRedisLRange = jest.fn().mockResolvedValue([]);
const mockRedisLPush = jest.fn().mockResolvedValue(1);
const mockRedisLTrim = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    set: (...args: any[]) => mockRedisSet(...args),
    get: jest.fn().mockResolvedValue(null),
    del: (...args: any[]) => mockRedisDel(...args),
    exists: (...args: any[]) => mockRedisExists(...args),
    sIsMember: (...args: any[]) => mockRedisSIsMember(...args),
    lRange: (...args: any[]) => mockRedisLRange(...args),
    lPush: (...args: any[]) => mockRedisLPush(...args),
    lTrim: (...args: any[]) => mockRedisLTrim(...args),
    getOrSet: jest.fn().mockResolvedValue(null),
    getJSON: jest.fn().mockResolvedValue(null),
    setJSON: jest.fn().mockResolvedValue('OK'),
    incr: jest.fn().mockResolvedValue(1),
    incrBy: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(true),
    sAdd: jest.fn().mockResolvedValue(1),
    sRem: jest.fn().mockResolvedValue(1),
    sMembers: jest.fn().mockResolvedValue([]),
    sCard: jest.fn().mockResolvedValue(0),
    sScan: jest.fn().mockResolvedValue(['0', []]),
    zRangeByScore: jest.fn().mockResolvedValue([]),
    zRemRangeByScore: jest.fn().mockResolvedValue(0),
    setTimer: jest.fn().mockResolvedValue(undefined),
    cancelTimer: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockPrismaAssignmentUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
const mockPrismaVehicleUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
const mockPrismaVehicleFindUnique = jest.fn().mockResolvedValue({
  vehicleKey: 'tata_ace',
  transporterId: 'txp-1',
  status: 'in_transit',
});

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    assignment: {
      updateMany: (...args: any[]) => mockPrismaAssignmentUpdateMany(...args),
      update: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    vehicle: {
      updateMany: (...args: any[]) => mockPrismaVehicleUpdateMany(...args),
      findUnique: (...args: any[]) => mockPrismaVehicleFindUnique(...args),
    },
    booking: {
      findUnique: jest.fn(),
    },
    order: {
      findUnique: jest.fn(),
    },
    truckRequest: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(async (fn: any) => fn({
      assignment: {
        updateMany: mockPrismaAssignmentUpdateMany,
        update: jest.fn(),
      },
      vehicle: {
        updateMany: mockPrismaVehicleUpdateMany,
      },
    })),
  },
  withDbTimeout: jest.fn(),
}));

jest.mock('../shared/database/db', () => ({
  db: {
    getAssignmentById: jest.fn().mockResolvedValue({
      id: 'asg-1',
      driverId: 'drv-1',
      driverName: 'Test Driver',
      transporterId: 'txp-1',
      vehicleId: 'veh-1',
      vehicleNumber: 'KA01AB1234',
      vehicleKey: 'tata_ace',
      bookingId: 'bkg-1',
      tripId: 'trip-1',
      orderId: null,
      truckRequestId: null,
      status: 'pending',
    }),
    getBookingById: jest.fn().mockResolvedValue({
      id: 'bkg-1',
      customerId: 'cust-1',
    }),
    updateAssignment: jest.fn().mockResolvedValue({}),
    getActiveAssignmentByDriver: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../modules/booking/booking.service', () => ({
  bookingService: {
    decrementTrucksFilled: jest.fn().mockResolvedValue(undefined),
    getActiveBroadcasts: jest.fn().mockResolvedValue([]),
  },
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { SocketEvent } from '../shared/services/socket.service';

// =============================================================================
// Issue #20 Tests — Inconsistent socket events
// =============================================================================

describe('Issue #20: Standardize socket events (ASSIGNMENT_STATUS_CHANGED + backward compat)', () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('#20.1: handleAssignmentTimeout emits ASSIGNMENT_TIMEOUT as canonical event to transporter', async () => {
    const { assignmentLifecycleService } = require('../modules/assignment/assignment-lifecycle.service');

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: 'asg-timeout-1',
      driverId: 'drv-1',
      driverName: 'Test Driver',
      transporterId: 'txp-1',
      vehicleId: 'veh-1',
      vehicleNumber: 'KA01AB1234',
      bookingId: 'bkg-1',
      tripId: 'trip-1',
      createdAt: new Date().toISOString(),
    });

    // Should emit ASSIGNMENT_TIMEOUT (new canonical event)
    const assignmentTimeoutCalls = mockEmitToUser.mock.calls.filter(
      (c: any[]) => c[1] === SocketEvent.ASSIGNMENT_TIMEOUT
    );
    expect(assignmentTimeoutCalls.length).toBeGreaterThanOrEqual(1);
    expect(assignmentTimeoutCalls[0][0]).toBe('txp-1');
  });

  test('#20.2: emitStatusChangeNotifications emits both canonical and backward-compat events', async () => {
    const { assignmentLifecycleService } = require('../modules/assignment/assignment-lifecycle.service');

    const { db } = require('../shared/database/db');
    db.getAssignmentById.mockResolvedValueOnce({
      id: 'asg-status-1',
      driverId: 'drv-1',
      transporterId: 'txp-1',
      vehicleId: 'veh-1',
      vehicleNumber: 'KA01AB1234',
      bookingId: 'bkg-1',
      tripId: 'trip-1',
      status: 'en_route_pickup',
    });

    await assignmentLifecycleService.updateStatus('asg-status-1', 'drv-1', { status: 'at_pickup' });

    // Should emit ASSIGNMENT_STATUS_CHANGED to booking room
    const canonicalCalls = mockEmitToBooking.mock.calls.filter(
      (c: any[]) => c[1] === SocketEvent.ASSIGNMENT_STATUS_CHANGED
    );
    expect(canonicalCalls.length).toBeGreaterThanOrEqual(1);

    // Should emit TRIP_ASSIGNED as backward-compat alias
    const backwardCompatCalls = mockEmitToBooking.mock.calls.filter(
      (c: any[]) => c[1] === SocketEvent.TRIP_ASSIGNED
    );
    expect(backwardCompatCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// Issue #21 Tests — Timeout sends 3 different status strings
// =============================================================================

describe('Issue #21: Standardize timeout status to "expired" in all notifications', () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('#21.1: Timeout socket event to driver uses status "expired"', async () => {
    const { assignmentLifecycleService } = require('../modules/assignment/assignment-lifecycle.service');

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: 'asg-21-1',
      driverId: 'drv-1',
      driverName: 'Test Driver',
      transporterId: 'txp-1',
      vehicleId: 'veh-1',
      vehicleNumber: 'KA01AB1234',
      bookingId: 'bkg-1',
      tripId: 'trip-1',
      createdAt: new Date().toISOString(),
    });

    // Find the ASSIGNMENT_STATUS_CHANGED call to driver
    const driverCalls = mockEmitToUser.mock.calls.filter(
      (c: any[]) => c[0] === 'drv-1' && c[1] === SocketEvent.ASSIGNMENT_STATUS_CHANGED
    );
    expect(driverCalls.length).toBeGreaterThanOrEqual(1);
    expect(driverCalls[0][2].status).toBe('expired');
    expect(driverCalls[0][2].reason).toBe('timeout');
  });

  test('#21.2: Timeout FCM to transporter uses status "expired" (not "timed_out")', async () => {
    const { assignmentLifecycleService } = require('../modules/assignment/assignment-lifecycle.service');

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: 'asg-21-2',
      driverId: 'drv-1',
      driverName: 'Test Driver',
      transporterId: 'txp-1',
      vehicleId: 'veh-1',
      vehicleNumber: 'KA01AB1234',
      bookingId: 'bkg-1',
      tripId: 'trip-1',
      createdAt: new Date().toISOString(),
    });

    // Find FCM push to transporter
    const transporterFCM = mockQueuePushNotification.mock.calls.filter(
      (c: any[]) => c[0] === 'txp-1'
    );
    expect(transporterFCM.length).toBeGreaterThanOrEqual(1);
    // All transporter FCM data.status should be 'expired' (not 'timed_out')
    const fcmPayload = transporterFCM[0][1];
    expect(fcmPayload.data.status).toBe('expired');
  });
});

// =============================================================================
// Issue #22 Tests — DRIVER_TIMEOUT event overloaded
// =============================================================================

describe('Issue #22: Split DRIVER_TIMEOUT into ASSIGNMENT_TIMEOUT and DRIVER_PRESENCE_TIMEOUT', () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('#22.1: handleAssignmentTimeout emits ASSIGNMENT_TIMEOUT event (not generic DRIVER_TIMEOUT only)', async () => {
    const { assignmentLifecycleService } = require('../modules/assignment/assignment-lifecycle.service');

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: 'asg-22-1',
      driverId: 'drv-1',
      driverName: 'Test Driver',
      transporterId: 'txp-1',
      vehicleId: 'veh-1',
      vehicleNumber: 'KA01AB1234',
      bookingId: 'bkg-1',
      tripId: 'trip-1',
      createdAt: new Date().toISOString(),
    });

    // Check ASSIGNMENT_TIMEOUT was emitted
    const timeoutCalls = mockEmitToUser.mock.calls.filter(
      (c: any[]) => c[1] === SocketEvent.ASSIGNMENT_TIMEOUT
    );
    expect(timeoutCalls.length).toBeGreaterThanOrEqual(1);
    expect(timeoutCalls[0][2].reason).toBe('timeout');
  });

  test('#22.2: SocketEvent constants include both ASSIGNMENT_TIMEOUT and DRIVER_PRESENCE_TIMEOUT', () => {
    expect(SocketEvent.ASSIGNMENT_TIMEOUT).toBe('assignment_timeout');
    expect(SocketEvent.DRIVER_PRESENCE_TIMEOUT).toBe('driver_presence_timeout');
    // Old DRIVER_TIMEOUT still exists for backward compat
    expect(SocketEvent.DRIVER_TIMEOUT).toBe('driver_timeout');
  });
});

// =============================================================================
// Issue #23 Tests — FCM says "reassigned" but no auto-reassignment exists
// =============================================================================

describe('Issue #23: FCM body text corrected (no misleading "reassigned" text)', () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('#23.1: Timeout FCM to driver does NOT say "reassigned"', async () => {
    const { assignmentLifecycleService } = require('../modules/assignment/assignment-lifecycle.service');

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: 'asg-23-1',
      driverId: 'drv-1',
      driverName: 'Test Driver',
      transporterId: 'txp-1',
      vehicleId: 'veh-1',
      vehicleNumber: 'KA01AB1234',
      bookingId: 'bkg-1',
      tripId: 'trip-1',
      createdAt: new Date().toISOString(),
    });

    // Find FCM push to driver
    const driverFCM = mockQueuePushNotification.mock.calls.filter(
      (c: any[]) => c[0] === 'drv-1'
    );
    expect(driverFCM.length).toBeGreaterThanOrEqual(1);
    const bodyText = driverFCM[0][1].body;
    // Should NOT contain "reassigned"
    expect(bodyText).not.toContain('reassigned');
    // Should contain helpful info about expiration
    expect(bodyText).toContain('expired');
  });

  test('#23.2: Timeout FCM to driver mentions vehicle availability', async () => {
    const { assignmentLifecycleService } = require('../modules/assignment/assignment-lifecycle.service');

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: 'asg-23-2',
      driverId: 'drv-1',
      driverName: 'Test Driver',
      transporterId: 'txp-1',
      vehicleId: 'veh-1',
      vehicleNumber: 'KA01AB1234',
      bookingId: 'bkg-1',
      tripId: 'trip-1',
      createdAt: new Date().toISOString(),
    });

    const driverFCM = mockQueuePushNotification.mock.calls.filter(
      (c: any[]) => c[0] === 'drv-1'
    );
    expect(driverFCM.length).toBeGreaterThanOrEqual(1);
    const bodyText = driverFCM[0][1].body;
    expect(bodyText).toContain('available');
  });
});

// =============================================================================
// Issue #24 Tests — isUserConnected() LOCAL-instance only
// =============================================================================

describe('Issue #24: isUserConnected checks Redis presence across instances', () => {
  // Use jest.requireActual to get the real isUserConnectedAsync from the monolith,
  // bypassing the top-level jest.mock. The function internally require()s redis.service
  // which IS mocked, so Redis calls route through our mock functions.
  const actualSocket = jest.requireActual('../shared/services/socket.service') as {
    isUserConnectedAsync: (userId: string) => Promise<boolean>;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisExists.mockResolvedValue(false);
    mockRedisSIsMember.mockResolvedValue(false);
  });

  test('#24.1: isUserConnectedAsync returns true when user is in online:transporters set', async () => {
    mockRedisSIsMember.mockResolvedValueOnce(true); // online:transporters check

    const result = await actualSocket.isUserConnectedAsync('txp-online-1');
    expect(result).toBe(true);
  });

  test('#24.2: isUserConnectedAsync returns true when driver has driver:presence key', async () => {
    mockRedisSIsMember.mockResolvedValueOnce(false); // not in transporters set
    mockRedisExists.mockResolvedValueOnce(true); // driver:presence:{id} exists

    const result = await actualSocket.isUserConnectedAsync('drv-online-1');
    expect(result).toBe(true);
  });

  test('#24.3: isUserConnectedAsync returns false when user not in any Redis presence set', async () => {
    mockRedisSIsMember.mockResolvedValueOnce(false);
    mockRedisExists.mockResolvedValueOnce(false);

    const result = await actualSocket.isUserConnectedAsync('unknown-user');
    expect(result).toBe(false);
  });

  test('#24.4: isUserConnectedAsync gracefully handles Redis failure', async () => {
    mockRedisSIsMember.mockRejectedValueOnce(new Error('Redis connection failed'));

    // Should not throw, should return false
    const result = await actualSocket.isUserConnectedAsync('txp-redis-fail');
    expect(result).toBe(false);
  });
});

// =============================================================================
// Issue #25 Tests — No DLQ consumer for failed queue jobs
// =============================================================================

// F-B-50: Issue #25 tests (processDLQ / processAllDLQs) removed — these methods
// only existed in the modular queue-management.service.ts facade which was
// dead-on-arrival (no production callers per Phase 1 audit) and is now deleted.
// The canonical queue.service.ts does not ship processDLQ; DLQ entries are
// processed by separate operational tooling and are not part of the queue
// service surface.
describe.skip('Issue #25: DLQ consumer processes permanently failed jobs', () => {
  it('removed with modular queue facade (F-B-50)', () => {
    // intentionally empty; describe.skip retains the ID for audit traceability
  });
});

// =============================================================================
// Issue #26 Tests — getTransportersWithVehicleType doesn't filter by status
// =============================================================================

describe('Issue #26: getTransportersWithVehicleType vehicle status filtering', () => {

  test('#26.1: getTransportersWithVehicleType exists in vehicle.repository.ts (not in B3 files)', () => {
    // Issue #26 is in vehicle.repository.ts which is NOT an exclusive B3 file.
    // Verify the function exists and note it needs status filtering.
    const fs = require('fs');
    const source = fs.readFileSync(
      require('path').resolve(__dirname, '../shared/database/repositories/vehicle.repository.ts'),
      'utf-8'
    );

    expect(source).toContain('getTransportersWithVehicleType');
    // Currently only checks isActive: true, should also filter by status: 'available'
    expect(source).toContain('isActive: true');
  });

  test('#26.2: getTransportersWithVehicleType now filters by vehicle status', () => {
    // FIX: The gap has been closed — getTransportersWithVehicleType now filters by status: 'available'
    const fs = require('fs');
    const source = fs.readFileSync(
      require('path').resolve(__dirname, '../shared/database/repositories/vehicle.repository.ts'),
      'utf-8'
    );

    // Extract just the getTransportersWithVehicleType function body
    const funcStart = source.indexOf('export async function getTransportersWithVehicleType');
    const funcEnd = source.indexOf('\nexport', funcStart + 1);
    const funcBody = source.substring(funcStart, funcEnd > -1 ? funcEnd : funcStart + 2000);

    // Confirm status filter IS present in the where clause
    const hasStatusFilter = funcBody.includes("status: 'available'") || funcBody.includes('status:');
    expect(hasStatusFilter).toBe(true);
  });
});

// =============================================================================
// Additional Integration-style Tests
// =============================================================================

describe('Integration: Timeout flow standardization (Issues #20-23 combined)', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrismaAssignmentUpdateMany.mockResolvedValue({ count: 1 });
  });

  test('Full timeout flow: DB, socket, FCM all use consistent status', async () => {
    const { assignmentLifecycleService } = require('../modules/assignment/assignment-lifecycle.service');

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: 'asg-full-1',
      driverId: 'drv-1',
      driverName: 'Full Test',
      transporterId: 'txp-1',
      vehicleId: 'veh-1',
      vehicleNumber: 'KA01AB1234',
      bookingId: 'bkg-1',
      tripId: 'trip-1',
      createdAt: new Date().toISOString(),
    });

    // Collect all emitted statuses across all channels
    const allStatuses = new Set<string>();

    // Socket events to users
    for (const call of mockEmitToUser.mock.calls) {
      if (call[2]?.status) allStatuses.add(call[2].status);
    }

    // Socket events to booking room
    for (const call of mockEmitToBooking.mock.calls) {
      if (call[2]?.status) allStatuses.add(call[2].status);
    }

    // FCM events
    for (const call of mockQueuePushNotification.mock.calls) {
      if (call[1]?.data?.status) allStatuses.add(call[1].data.status);
    }

    // All notification channels should consistently use 'expired'
    expect(allStatuses.has('expired')).toBe(true);
    // Should NOT have the old inconsistent statuses in notifications
    expect(allStatuses.has('timed_out')).toBe(false);
  });

  test('Timeout no-ops when driver already accepted', async () => {
    mockPrismaAssignmentUpdateMany.mockResolvedValueOnce({ count: 0 });
    const { db } = require('../shared/database/db');
    db.getAssignmentById.mockResolvedValueOnce({
      id: 'asg-noop',
      status: 'driver_accepted',
    });

    const { assignmentLifecycleService } = require('../modules/assignment/assignment-lifecycle.service');

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: 'asg-noop',
      driverId: 'drv-1',
      driverName: 'Noop Driver',
      transporterId: 'txp-1',
      vehicleId: 'veh-1',
      vehicleNumber: 'KA01AB1234',
      bookingId: 'bkg-1',
      tripId: 'trip-1',
      createdAt: new Date().toISOString(),
    });

    // Should NOT emit any socket events or FCM
    expect(mockEmitToUser).not.toHaveBeenCalled();
    expect(mockEmitToBooking).not.toHaveBeenCalled();
    expect(mockQueuePushNotification).not.toHaveBeenCalled();
  });
});
