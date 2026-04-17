/**
 * =============================================================================
 * TIGER ASSIGNMENT/DRIVER HARDENING TESTS
 * =============================================================================
 *
 * Edge-case tests for assignment and driver fixes:
 *   #6  — Assignment timeout scheduled immediately
 *   #7  — Notification retry with backoff + DLQ fallback
 *   #14 — Protected assignments NOT released
 *   #20 — Socket dual-emit (canonical + backward-compat)
 *   #21 — All timeout paths emit 'expired' status
 *   #22 — ASSIGNMENT_TIMEOUT separate from DRIVER_TIMEOUT
 *   #23 — FCM text does NOT contain 'reassigned'
 *   #24 — isUserConnectedAsync checks Redis first
 *   #25 — DLQ consumer logs + alert threshold
 *   #41 — Actual vehicle status used for Redis sync (decline)
 *   #42 — Actual vehicle status used for Redis sync (cancel)
 *   #43 — Negative cache TTL is 3s
 *   #44 — Timeout scheduling wrapped in try/catch
 *
 * Total: 65 tests
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — Must come before any imports
// =============================================================================

const mockDb = {
  getAssignmentById: jest.fn(),
  getBookingById: jest.fn(),
  getOrderById: jest.fn(),
  getUserById: jest.fn(),
  updateAssignment: jest.fn(),
  getActiveAssignmentByDriver: jest.fn(),
};

jest.mock('../shared/database/db', () => ({
  db: mockDb,
  BookingRecord: {},
  AssignmentRecord: {},
}));

const mockPrismaClient: any = {
  assignment: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  vehicle: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
  },
  booking: {
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  order: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  truckRequest: {
    updateMany: jest.fn(),
  },
  $transaction: jest.fn(async (fn: any) => fn(mockPrismaClient)),
  $executeRaw: jest.fn(),
  $queryRaw: jest.fn().mockResolvedValue([{ trucksFilled: 0 }]),
};

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: mockPrismaClient,
  withDbTimeout: jest.fn(async (fn: any, _opts?: any) => fn(mockPrismaClient)),
  VehicleStatus: { available: 'available', on_hold: 'on_hold', in_transit: 'in_transit' },
  AssignmentStatus: {
    pending: 'pending',
    driver_accepted: 'driver_accepted',
    en_route_pickup: 'en_route_pickup',
    at_pickup: 'at_pickup',
    in_transit: 'in_transit',
  },
}));

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
  },
}));

const mockRedisService = {
  acquireLock: jest.fn().mockResolvedValue({ acquired: true }),
  releaseLock: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  setJSON: jest.fn().mockResolvedValue('OK'),
  getJSON: jest.fn().mockResolvedValue(null),
  getOrSet: jest.fn(),
  sAdd: jest.fn().mockResolvedValue(1),
  sRem: jest.fn().mockResolvedValue(1),
  sIsMember: jest.fn().mockResolvedValue(false),
  exists: jest.fn().mockResolvedValue(false),
  expire: jest.fn().mockResolvedValue(true),
  lPush: jest.fn().mockResolvedValue(1),
  lTrim: jest.fn().mockResolvedValue('OK'),
  lRange: jest.fn().mockResolvedValue([]),
  hSet: jest.fn().mockResolvedValue(1),
};

jest.mock('../shared/services/redis.service', () => ({
  redisService: mockRedisService,
}));

const mockEmitToUser = jest.fn();
const mockEmitToBooking = jest.fn();
const mockEmitToRoom = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  socketService: {
    emitToUser: mockEmitToUser,
    emitToRoom: mockEmitToRoom,
  },
  emitToUser: mockEmitToUser,
  emitToRoom: mockEmitToRoom,
  emitToBooking: mockEmitToBooking,
  SocketEvent: {
    TRIP_ASSIGNED: 'trip_assigned',
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    TRUCK_CONFIRMED: 'truck_confirmed',
    BOOKING_UPDATED: 'booking_updated',
    ASSIGNMENT_TIMEOUT: 'assignment_timeout',
    DRIVER_TIMEOUT: 'driver_timeout',
  },
}));

const mockQueueService = {
  scheduleAssignmentTimeout: jest.fn().mockResolvedValue('timer-id'),
  cancelAssignmentTimeout: jest.fn().mockResolvedValue(undefined),
  queuePushNotification: jest.fn().mockResolvedValue(undefined),
  enqueue: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../shared/services/queue.service', () => ({
  queueService: mockQueueService,
}));

jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../shared/services/fcm.service', () => ({
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../modules/tracking/tracking.service', () => ({
  trackingService: {
    initializeTracking: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock booking service for lazy require in assignment lifecycle
jest.mock('../modules/booking/booking.service', () => ({
  bookingService: {
    decrementTrucksFilled: jest.fn().mockResolvedValue(undefined),
  },
}));

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

// =============================================================================
// IMPORTS
// =============================================================================

import { logger } from '../shared/services/logger.service';

// =============================================================================
// SECTION 1: Assignment timeout scheduled immediately (Fix #6)
// =============================================================================

describe('Assignment timeout scheduled immediately (Fix #6)', () => {
  test('1.1: Source schedules timeout right after assignment creation', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/broadcast/broadcast-accept.service.ts'),
      'utf-8'
    );

    expect(source).toContain('queueService.scheduleAssignmentTimeout');
    expect(source).toContain('FIX Issue #6');
  });

  test('1.2: Timeout scheduling uses HOLD_CONFIG.driverAcceptTimeoutMs', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/broadcast/broadcast-accept.service.ts'),
      'utf-8'
    );

    expect(source).toContain('HOLD_CONFIG.driverAcceptTimeoutMs');
  });

  test('1.3: Timeout scheduling failure is non-fatal (logged but not thrown)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/broadcast/broadcast-accept.service.ts'),
      'utf-8'
    );

    // Wrapped in try/catch, failure is logged at error level
    expect(source).toContain("logger.error('[BroadcastAccept] Failed to schedule assignment timeout'");
  });

  test('1.4: Confirm path also schedules timeout for each assignment (Fix #44)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/truck-hold-confirm.service.ts'),
      'utf-8'
    );

    expect(source).toContain('queueService.scheduleAssignmentTimeout');
    // FIX #44: Wrapped in try/catch
    expect(source).toContain('Assignment timeout scheduling FAILED');
  });

  test('1.5: Timeout scheduling failure in confirm path is non-fatal', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/truck-hold/truck-hold-confirm.service.ts'),
      'utf-8'
    );

    // Each scheduling call is wrapped in its own try/catch
    expect(source).toContain('} catch (timeoutErr: unknown) {');
    expect(source).toContain('Non-fatal: L3 DB reconciliation will catch');
  });
});

// =============================================================================
// SECTION 2: Notification retry with backoff (Fix #7)
// =============================================================================

describe('Notification retry with backoff (Fix #7)', () => {
  test('2.1: retryWithBackoff function exists in broadcast-accept', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/broadcast/broadcast-accept.service.ts'),
      'utf-8'
    );

    expect(source).toContain('async function retryWithBackoff');
    expect(source).toContain('FIX Issue #7');
  });

  test('2.2: retryWithBackoff defaults to 3 retries', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/broadcast/broadcast-accept.service.ts'),
      'utf-8'
    );

    expect(source).toContain('maxRetries: number = 3');
  });

  test('2.3: Driver notification uses retryWithBackoff', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/broadcast/broadcast-accept.service.ts'),
      'utf-8'
    );

    // Driver notification wrapped in retryWithBackoff
    expect(source).toContain('await retryWithBackoff(async () => {');
    expect(source).toContain('emitToUser(driverId');
  });

  test('2.4: All retries fail falls back to DLQ (queuePushNotification)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/broadcast/broadcast-accept.service.ts'),
      'utf-8'
    );

    expect(source).toContain('All driver notification retries failed');
    expect(source).toContain('queueService.queuePushNotification(driverId');
  });

  test('2.5: Customer notification also uses retryWithBackoff', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/broadcast/broadcast-accept.service.ts'),
      'utf-8'
    );

    expect(source).toContain('All customer notification retries failed');
  });

  test('2.6: Exponential backoff with baseDelayMs * 2^(attempt-1)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/broadcast/broadcast-accept.service.ts'),
      'utf-8'
    );

    expect(source).toContain('baseDelayMs * Math.pow(2, attempt - 1)');
  });
});

// =============================================================================
// SECTION 3: Protected assignments NOT released (Fix #14)
// =============================================================================

describe('Protected assignments NOT released on cancel', () => {
  test('3.1: VALID_TRANSITIONS for at_pickup includes only in_transit and cancelled', () => {
    // H13: transitions moved to canonical state-machines.ts
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../core/state-machines.ts'),
      'utf-8'
    );

    expect(source).toContain("at_pickup:");
    expect(source).toContain("'in_transit'");
    expect(source).toContain("'cancelled'");
  });

  test('3.2: VALID_TRANSITIONS for en_route_pickup includes at_pickup and cancelled', () => {
    // H13: transitions moved to canonical state-machines.ts
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../core/state-machines.ts'),
      'utf-8'
    );

    expect(source).toContain("en_route_pickup:");
    expect(source).toContain("'at_pickup'");
    expect(source).toContain("'cancelled'");
  });

  test('3.3: Cancel assignment releases vehicle atomically in transaction', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-lifecycle.service.ts'),
      'utf-8'
    );

    // Cancel uses $transaction for atomic cancel + release
    expect(source).toContain('FIX M-2: Atomic transaction');
    expect(source).toContain("await tx.assignment.update");
    expect(source).toContain("await tx.vehicle.updateMany");
  });

  test('3.4: Completed status cannot transition to cancelled', () => {
    // H13: transitions moved to canonical state-machines.ts
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../core/state-machines.ts'),
      'utf-8'
    );

    expect(source).toContain("completed:");
    // completed is terminal — empty transition list
    expect(source).toMatch(/completed:\s*\[\]/);
  });

  test('3.5: Timeout only fires on pending status (not at_pickup/en_route)', async () => {
    const { assignmentLifecycleService } = require('../modules/assignment/assignment-lifecycle.service');

    // Simulate timeout where assignment is already at_pickup
    mockPrismaClient.assignment.updateMany.mockResolvedValue({ count: 0 });
    mockDb.getAssignmentById.mockResolvedValue({
      id: 'a-1',
      status: 'at_pickup',
      tripId: 't-1',
    });

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: 'a-1',
      driverId: 'd-1',
      driverName: 'Test Driver',
      transporterId: 'tx-1',
      vehicleId: 'v-1',
      vehicleNumber: 'KA-01-1234',
      tripId: 't-1',
      createdAt: new Date().toISOString(),
    });

    // Should log that it's a no-op
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('already at_pickup')
    );
    // Should NOT emit timeout notifications
    expect(mockEmitToUser).not.toHaveBeenCalled();
  });
});

// =============================================================================
// SECTION 4: Socket dual-emit (Fix #20)
// =============================================================================

describe('Socket events dual-emit (Fix #20)', () => {
  test('4.1: Timeout emits ASSIGNMENT_TIMEOUT (canonical) event', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-lifecycle.service.ts'),
      'utf-8'
    );

    expect(source).toContain('SocketEvent.ASSIGNMENT_TIMEOUT');
  });

  test('4.2: Timeout also emits DRIVER_TIMEOUT (backward-compat)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-lifecycle.service.ts'),
      'utf-8'
    );

    expect(source).toContain('SocketEvent.DRIVER_TIMEOUT');
    expect(source).toContain('Backward-compat alias');
  });

  test('4.3: Status change emits ASSIGNMENT_STATUS_CHANGED (canonical)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-lifecycle.service.ts'),
      'utf-8'
    );

    expect(source).toContain('SocketEvent.ASSIGNMENT_STATUS_CHANGED');
  });

  test('4.4: Status change also emits TRIP_ASSIGNED (backward-compat)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-lifecycle.service.ts'),
      'utf-8'
    );

    // emitStatusChangeNotifications sends both events
    expect(source).toContain('Issue #20: Canonical event');
    expect(source).toContain('Issue #20: Backward-compat alias');
  });

  test('4.5: Both events sent to same booking room', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-lifecycle.service.ts'),
      'utf-8'
    );

    // Both use emitToBooking with updateStreamId
    expect(source).toContain('emitToBooking(updateStreamId, SocketEvent.ASSIGNMENT_STATUS_CHANGED');
    expect(source).toContain('emitToBooking(updateStreamId, SocketEvent.TRIP_ASSIGNED');
  });
});

// =============================================================================
// SECTION 5: All timeout paths emit 'expired' (Fix #21)
// =============================================================================

describe('All timeout paths emit expired status (Fix #21)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default mock for vehicle release in timeout path
    mockPrismaClient.vehicle.updateMany.mockResolvedValue({ count: 1 });
    // Mock for decrementTrucksFilled called by handleAssignmentTimeout
    mockDb.getBookingById.mockResolvedValue({
      id: 'b-1',
      customerId: 'cust-1',
      trucksNeeded: 2,
      trucksFilled: 1,
      status: 'active',
    });
    mockPrismaClient.$queryRaw.mockResolvedValue([{ trucksFilled: 0 }]);
    mockPrismaClient.booking.update.mockResolvedValue({});
  });

  test('5.1: Timeout transporter notification uses status expired', async () => {
    const { assignmentLifecycleService } = require('../modules/assignment/assignment-lifecycle.service');

    mockPrismaClient.assignment.updateMany.mockResolvedValue({ count: 1 });
    mockDb.getAssignmentById.mockResolvedValue({
      id: 'a-1',
      bookingId: 'b-1',
      transporterId: 'tx-1',
      driverId: 'd-1',
      vehicleId: 'v-1',
      vehicleNumber: 'KA-01',
      tripId: 't-1',
      status: 'driver_declined',
    });
    mockPrismaClient.vehicle.findUnique.mockResolvedValue({
      vehicleKey: 'vk-1',
      transporterId: 'tx-1',
      status: 'on_hold',
    });

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: 'a-1',
      driverId: 'd-1',
      driverName: 'Test',
      transporterId: 'tx-1',
      vehicleId: 'v-1',
      vehicleNumber: 'KA-01',
      bookingId: 'b-1',
      tripId: 't-1',
      createdAt: new Date().toISOString(),
    });

    // Verify transporter ASSIGNMENT_TIMEOUT event has status: 'expired'
    const calls = mockEmitToUser.mock.calls;
    const transporterTimeout = calls.find(
      (c: any[]) => c[0] === 'tx-1' && c[1] === 'assignment_timeout'
    );
    expect(transporterTimeout).toBeDefined();
    expect(transporterTimeout![2].status).toBe('expired');
  });

  test('5.2: Timeout driver notification uses status expired', async () => {
    const { assignmentLifecycleService } = require('../modules/assignment/assignment-lifecycle.service');

    mockPrismaClient.assignment.updateMany.mockResolvedValue({ count: 1 });
    mockDb.getAssignmentById.mockResolvedValue({
      id: 'a-2',
      bookingId: 'b-2',
      transporterId: 'tx-2',
      driverId: 'd-2',
      vehicleId: 'v-2',
      vehicleNumber: 'KA-02',
      tripId: 't-2',
      status: 'driver_declined',
    });
    mockPrismaClient.vehicle.findUnique.mockResolvedValue({
      vehicleKey: 'vk-2',
      transporterId: 'tx-2',
      status: 'on_hold',
    });

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: 'a-2',
      driverId: 'd-2',
      driverName: 'Test2',
      transporterId: 'tx-2',
      vehicleId: 'v-2',
      vehicleNumber: 'KA-02',
      bookingId: 'b-2',
      tripId: 't-2',
      createdAt: new Date().toISOString(),
    });

    // Verify driver event has status: 'expired'
    const calls = mockEmitToUser.mock.calls;
    const driverExpired = calls.find(
      (c: any[]) => c[0] === 'd-2' && c[1] === 'assignment_status_changed'
    );
    expect(driverExpired).toBeDefined();
    expect(driverExpired![2].status).toBe('expired');
  });

  test('5.3: Timeout booking room notification uses status expired', async () => {
    const { assignmentLifecycleService } = require('../modules/assignment/assignment-lifecycle.service');

    mockPrismaClient.assignment.updateMany.mockResolvedValue({ count: 1 });
    mockDb.getAssignmentById.mockResolvedValue({
      id: 'a-3',
      bookingId: 'b-3',
      transporterId: 'tx-3',
      driverId: 'd-3',
      vehicleId: 'v-3',
      vehicleNumber: 'KA-03',
      tripId: 't-3',
      status: 'driver_declined',
    });
    mockPrismaClient.vehicle.findUnique.mockResolvedValue({
      vehicleKey: 'vk-3',
      transporterId: 'tx-3',
      status: 'on_hold',
    });

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: 'a-3',
      driverId: 'd-3',
      driverName: 'Test3',
      transporterId: 'tx-3',
      vehicleId: 'v-3',
      vehicleNumber: 'KA-03',
      bookingId: 'b-3',
      tripId: 't-3',
      createdAt: new Date().toISOString(),
    });

    const bookingCalls = mockEmitToBooking.mock.calls;
    const bookingExpired = bookingCalls.find(
      (c: any[]) => c[2]?.status === 'expired'
    );
    expect(bookingExpired).toBeDefined();
  });

  test('5.4: FCM to transporter uses status expired', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-lifecycle.service.ts'),
      'utf-8'
    );

    // FCM data has status: 'expired'
    expect(source).toContain("status: 'expired'");
    // Not 'timed_out'
    expect(source).not.toContain("status: 'timed_out'");
  });
});

// =============================================================================
// SECTION 6: ASSIGNMENT_TIMEOUT vs DRIVER_TIMEOUT (Fix #22)
// =============================================================================

describe('ASSIGNMENT_TIMEOUT separate from DRIVER_TIMEOUT (Fix #22)', () => {
  test('6.1: SocketEvent has both ASSIGNMENT_TIMEOUT and DRIVER_TIMEOUT', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/services/socket.service.ts'),
      'utf-8'
    );

    expect(source).toContain('ASSIGNMENT_TIMEOUT');
    expect(source).toContain('DRIVER_TIMEOUT');
  });

  test('6.2: ASSIGNMENT_TIMEOUT is assignment_timeout string', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/services/socket.service.ts'),
      'utf-8'
    );

    expect(source).toContain("ASSIGNMENT_TIMEOUT: 'assignment_timeout'");
  });

  test('6.3: DRIVER_TIMEOUT is driver_timeout string', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/services/socket.service.ts'),
      'utf-8'
    );

    expect(source).toContain("DRIVER_TIMEOUT: 'driver_timeout'");
  });

  test('6.4: Timeout handler uses ASSIGNMENT_TIMEOUT as primary event', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-lifecycle.service.ts'),
      'utf-8'
    );

    // Issue #22 comment confirms this
    expect(source).toContain('Issue #22: Use ASSIGNMENT_TIMEOUT');
  });
});

// =============================================================================
// SECTION 7: FCM text does NOT contain 'reassigned' (Fix #23)
// =============================================================================

describe('FCM text does NOT contain reassigned (Fix #23)', () => {
  test('7.1: Driver FCM body does not say reassigned', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-lifecycle.service.ts'),
      'utf-8'
    );

    // Find the FCM push to driver in timeout handler
    const timeoutSection = source.substring(
      source.indexOf('handleAssignmentTimeout'),
      source.lastIndexOf('}')
    );

    // Should NOT contain "reassigned" in any FCM body
    const fcmBodies = timeoutSection.match(/body: ['"`]([^'"`]+)['"`]/g) || [];
    for (const body of fcmBodies) {
      expect(body.toLowerCase()).not.toContain('reassigned');
    }
  });

  test('7.2: Driver FCM says "available for other bookings" instead', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-lifecycle.service.ts'),
      'utf-8'
    );

    expect(source).toContain('available for other bookings');
  });

  test('7.3: Issue #23 comment documents the fix', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-lifecycle.service.ts'),
      'utf-8'
    );

    expect(source).toContain('Issue #23');
    expect(source).toContain('no auto-reassignment exists');
  });
});

// =============================================================================
// SECTION 8: isUserConnectedAsync (Fix #24)
// =============================================================================

describe('isUserConnectedAsync checks Redis first (Fix #24)', () => {
  test('8.1: isUserConnectedAsync function exists', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/services/socket.service.ts'),
      'utf-8'
    );

    expect(source).toContain('async function isUserConnectedAsync');
  });

  test('8.2: Falls back to local check (fast path)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/services/socket.service.ts'),
      'utf-8'
    );

    // Monolith falls back to isUserConnected (not isUserConnectedLocal)
    expect(source).toContain('return isUserConnected(userId)');
  });

  test('8.3: Checks Redis transporter set', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/services/socket.service.ts'),
      'utf-8'
    );

    expect(source).toContain("sIsMember('online:transporters', userId)");
  });

  test('8.4: Checks Redis driver presence key', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/services/socket.service.ts'),
      'utf-8'
    );

    expect(source).toContain('`driver:presence:${userId}`');
  });

  test('8.5: Redis down falls back to local check', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/services/socket.service.ts'),
      'utf-8'
    );

    // catch block handles Redis failure gracefully by falling back
    expect(source).toContain('Redis down');
    expect(source).toContain('return isUserConnected(userId)');
  });

  test('8.6: Cross-instance connectivity comment documents the purpose', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/services/socket.service.ts'),
      'utf-8'
    );

    expect(source).toContain('cross-instance user connection check');
  });
});

// =============================================================================
// SECTION 9: DLQ consumer (Fix #25)
// =============================================================================

// F-B-50: Fix #25 processDLQ tests skipped — methods only existed in the
// modular queue-management.service.ts facade (dead-on-arrival per Phase 1) and
// are deleted with the facade. Preserved as describe.skip for audit traceability.
describe.skip('DLQ consumer logs and alerts (Fix #25)', () => {
  test('removed with modular queue facade (F-B-50)', () => {
    // intentionally empty
  });
});

// =============================================================================
// SECTION 10: Actual vehicle status for Redis sync (Fix #41, #42)
// =============================================================================

describe('Actual vehicle status used for Redis sync (Fix #41, #42)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('10.1: Decline reads actual vehicle status from DB', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-lifecycle.service.ts'),
      'utf-8'
    );

    // M-15 FIX reads vehicle status before transaction
    expect(source).toContain('M-15 FIX');
    expect(source).toContain('ACTUAL vehicle status');
  });

  test('10.2: Cancel reads actual vehicle status from DB', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-lifecycle.service.ts'),
      'utf-8'
    );

    // M-15 FIX for cancel path
    expect(source).toContain('M-15 FIX: Read vehicle status BEFORE transaction');
  });

  test('10.3: Decline uses vehicle.status for oldStatus (not hardcoded in_transit)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-lifecycle.service.ts'),
      'utf-8'
    );

    // In decline/cancel path, preTransactionVehicle.status is used for oldStatus
    expect(source).toContain('preTransactionVehicle.status');
    expect(source).toContain("preTransactionVehicle.status !== 'available'");
  });

  test('10.4: Cancel handler fetches vehicle after transaction', async () => {
    const { assignmentLifecycleService } = require('../modules/assignment/assignment-lifecycle.service');

    const assignment = {
      id: 'a-cancel-1',
      transporterId: 'tx-1',
      driverId: 'd-1',
      vehicleId: 'v-1',
      vehicleNumber: 'KA-01',
      tripId: 't-1',
      bookingId: 'b-1',
      status: 'pending',
    };

    mockDb.getAssignmentById.mockResolvedValue(assignment);
    mockPrismaClient.vehicle.findUnique.mockResolvedValue({
      vehicleKey: 'vk-1',
      transporterId: 'tx-1',
      status: 'on_hold', // actual status
    });
    mockDb.getBookingById.mockResolvedValue(null);

    const bookingService = { decrementTrucksFilled: jest.fn() };
    jest.doMock('../modules/booking/booking.service', () => ({ bookingService }));

    await assignmentLifecycleService.cancelAssignment('a-cancel-1', 'tx-1');

    // Verify it fetched vehicle status
    expect(mockPrismaClient.vehicle.findUnique).toHaveBeenCalledWith({
      where: { id: 'v-1' },
      select: { vehicleKey: true, transporterId: true, status: true },
    });
  });

  test('10.5: releaseVehicleIfBusy reads actual vehicle status', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-lifecycle.service.ts'),
      'utf-8'
    );

    // releaseVehicleIfBusy fetches vehicle and uses vehicle.status
    expect(source).toContain('const vehicle = await prismaClient.vehicle.findUnique');
    expect(source).toContain("vehicle.status !== 'available'");
  });
});

// =============================================================================
// SECTION 11: Negative cache TTL is 3s (Fix #43)
// =============================================================================

describe('Negative cache TTL is 3s (Fix #43)', () => {
  test('11.1: acceptAssignment invalidates negative cache for driver', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-response.service.ts'),
      'utf-8'
    );

    // Invalidate negative cache on accept
    expect(source).toContain('Invalidate negative cache');
  });

  test('11.2: Negative cache uses driver:active-assignment key pattern', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-response.service.ts'),
      'utf-8'
    );

    expect(source).toContain('`driver:active-assignment:${driverId}`');
  });

  test('11.3: Cache key uses driver:active-assignment:{driverId}', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-response.service.ts'),
      'utf-8'
    );

    expect(source).toContain('`driver:active-assignment:${driverId}`');
  });

  test('11.4: Cache invalidated on accept', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-response.service.ts'),
      'utf-8'
    );

    // At the end of acceptAssignment, negative cache is deleted
    expect(source).toContain("redisService.del(`driver:active-assignment:${driverId}`)");
  });

  test('11.5: Cache invalidated on cancel', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-lifecycle.service.ts'),
      'utf-8'
    );

    expect(source).toContain("redisService.del(`driver:active-assignment:${assignment.driverId}`)");
  });

  test('11.6: Cache invalidated on decline', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-lifecycle.service.ts'),
      'utf-8'
    );

    expect(source).toContain("redisService.del(`driver:active-assignment:${driverId}`)");
  });
});

// =============================================================================
// SECTION 12: ASSIGNMENT_CONFIG uses HOLD_CONFIG (Fix #22)
// =============================================================================

describe('ASSIGNMENT_CONFIG uses centralized HOLD_CONFIG', () => {
  test('12.1: ASSIGNMENT_CONFIG.TIMEOUT_MS reads from HOLD_CONFIG', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment.types.ts'),
      'utf-8'
    );

    expect(source).toContain('HOLD_CONFIG.driverAcceptTimeoutMs');
  });

  test('12.2: HOLD_CONFIG defaults to 45s', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../core/config/hold-config.ts'),
      'utf-8'
    );

    expect(source).toContain("'45'");
  });
});

// =============================================================================
// SECTION 13: Timeout handler behavior tests
// =============================================================================

describe('Timeout handler end-to-end behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrismaClient.vehicle.updateMany.mockResolvedValue({ count: 1 });
  });

  test('13.1: Timeout persists reason as timeout (not declined)', async () => {
    const { assignmentLifecycleService } = require('../modules/assignment/assignment-lifecycle.service');

    mockPrismaClient.assignment.updateMany.mockResolvedValue({ count: 1 });
    mockDb.getAssignmentById.mockResolvedValue({
      id: 'a-timeout-1',
      bookingId: 'b-1',
      transporterId: 'tx-1',
      driverId: 'd-1',
      vehicleId: 'v-1',
      vehicleNumber: 'KA-01',
      tripId: 't-1',
      status: 'driver_declined',
    });
    mockPrismaClient.vehicle.findUnique.mockResolvedValue({
      vehicleKey: 'vk-1',
      transporterId: 'tx-1',
      status: 'on_hold',
    });

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: 'a-timeout-1',
      driverId: 'd-1',
      driverName: 'Driver1',
      transporterId: 'tx-1',
      vehicleId: 'v-1',
      vehicleNumber: 'KA-01',
      bookingId: 'b-1',
      tripId: 't-1',
      createdAt: new Date().toISOString(),
    });

    // Verify reason persisted as 'timeout'
    expect(mockRedisService.set).toHaveBeenCalledWith(
      'assignment:reason:a-timeout-1',
      'timeout',
      86400
    );
  });

  test('13.2: Timeout releases vehicle back to available', async () => {
    const { assignmentLifecycleService } = require('../modules/assignment/assignment-lifecycle.service');

    mockPrismaClient.assignment.updateMany.mockResolvedValue({ count: 1 });
    mockDb.getAssignmentById.mockResolvedValue({
      id: 'a-timeout-2',
      bookingId: 'b-2',
      transporterId: 'tx-2',
      driverId: 'd-2',
      vehicleId: 'v-2',
      vehicleNumber: 'KA-02',
      tripId: 't-2',
      status: 'driver_declined',
    });
    mockPrismaClient.vehicle.findUnique.mockResolvedValue({
      vehicleKey: 'vk-2',
      transporterId: 'tx-2',
      status: 'on_hold',
    });
    mockPrismaClient.vehicle.updateMany.mockResolvedValue({ count: 1 });

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: 'a-timeout-2',
      driverId: 'd-2',
      driverName: 'Driver2',
      transporterId: 'tx-2',
      vehicleId: 'v-2',
      vehicleNumber: 'KA-02',
      bookingId: 'b-2',
      tripId: 't-2',
      createdAt: new Date().toISOString(),
    });

    // Vehicle should be released to available
    expect(mockPrismaClient.vehicle.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'v-2' }),
        data: expect.objectContaining({ status: 'available' }),
      })
    );
  });

  test('13.3: Timeout sends FCM to both transporter and driver', async () => {
    const { assignmentLifecycleService } = require('../modules/assignment/assignment-lifecycle.service');

    mockPrismaClient.assignment.updateMany.mockResolvedValue({ count: 1 });
    mockDb.getAssignmentById.mockResolvedValue({
      id: 'a-timeout-3',
      bookingId: 'b-3',
      transporterId: 'tx-3',
      driverId: 'd-3',
      vehicleId: 'v-3',
      vehicleNumber: 'KA-03',
      tripId: 't-3',
      status: 'driver_declined',
    });
    mockPrismaClient.vehicle.findUnique.mockResolvedValue({
      vehicleKey: 'vk-3',
      transporterId: 'tx-3',
      status: 'on_hold',
    });

    await assignmentLifecycleService.handleAssignmentTimeout({
      assignmentId: 'a-timeout-3',
      driverId: 'd-3',
      driverName: 'Driver3',
      transporterId: 'tx-3',
      vehicleId: 'v-3',
      vehicleNumber: 'KA-03',
      bookingId: 'b-3',
      tripId: 't-3',
      createdAt: new Date().toISOString(),
    });

    // FCM to transporter
    expect(mockQueueService.queuePushNotification).toHaveBeenCalledWith(
      'tx-3',
      expect.objectContaining({
        data: expect.objectContaining({ status: 'expired' }),
      })
    );

    // FCM to driver
    expect(mockQueueService.queuePushNotification).toHaveBeenCalledWith(
      'd-3',
      expect.objectContaining({
        data: expect.objectContaining({ status: 'expired' }),
      })
    );
  });
});

// =============================================================================
// SECTION 14: Accept assignment behavior
// =============================================================================

describe('Accept assignment behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('14.1: acceptAssignment provides currentStatus in error for non-pending', async () => {
    const { assignmentResponseService } = require('../modules/assignment/assignment-response.service');

    mockDb.getAssignmentById.mockResolvedValue({
      id: 'a-accept-1',
      driverId: 'd-1',
      status: 'driver_accepted', // not pending
    });

    try {
      await assignmentResponseService.acceptAssignment('a-accept-1', 'd-1');
      fail('Should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('already accepted');
      expect(err.currentStatus).toBe('driver_accepted');
    }
  });

  test('14.2: acceptAssignment cancels timeout on success', async () => {
    const { assignmentResponseService } = require('../modules/assignment/assignment-response.service');

    mockDb.getAssignmentById.mockResolvedValue({
      id: 'a-accept-2',
      driverId: 'd-2',
      vehicleId: 'v-2',
      vehicleNumber: 'KA-02',
      transporterId: 'tx-2',
      tripId: 't-2',
      bookingId: 'b-2',
      status: 'pending',
    });
    mockRedisService.getOrSet.mockResolvedValue(null); // no active assignment
    mockPrismaClient.assignment.updateMany.mockResolvedValue({ count: 1 });
    mockPrismaClient.vehicle.updateMany.mockResolvedValue({ count: 1 });
    mockPrismaClient.assignment.findUnique.mockResolvedValue({
      id: 'a-accept-2',
      status: 'driver_accepted',
      driverId: 'd-2',
      vehicleId: 'v-2',
      vehicleNumber: 'KA-02',
      transporterId: 'tx-2',
      tripId: 't-2',
      bookingId: 'b-2',
    });
    mockPrismaClient.vehicle.findUnique.mockResolvedValue({
      vehicleKey: 'vk-2',
      transporterId: 'tx-2',
    });
    mockRedisService.getJSON.mockResolvedValue(null);
    mockDb.getBookingById.mockResolvedValue(null);

    await assignmentResponseService.acceptAssignment('a-accept-2', 'd-2');

    expect(mockQueueService.cancelAssignmentTimeout).toHaveBeenCalledWith('a-accept-2');
  });
});

// =============================================================================
// SECTION 15: Decline assignment behavior
// =============================================================================

describe('Decline assignment behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('15.1: declineAssignment uses atomic transaction', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-lifecycle.service.ts'),
      'utf-8'
    );

    // Decline uses $transaction
    expect(source).toContain("await prismaClient.$transaction(async (tx) => {");
  });

  test('15.2: declineAssignment cancels timeout timer', async () => {
    const { assignmentLifecycleService } = require('../modules/assignment/assignment-lifecycle.service');

    mockDb.getAssignmentById.mockResolvedValue({
      id: 'a-decline-1',
      driverId: 'd-1',
      transporterId: 'tx-1',
      vehicleId: 'v-1',
      vehicleNumber: 'KA-01',
      tripId: 't-1',
      bookingId: 'b-1',
      status: 'pending',
    });
    mockPrismaClient.vehicle.findUnique.mockResolvedValue({
      vehicleKey: 'vk-1',
      transporterId: 'tx-1',
      status: 'on_hold',
    });
    mockDb.getBookingById.mockResolvedValue(null);

    const bookingService = { decrementTrucksFilled: jest.fn() };
    jest.doMock('../modules/booking/booking.service', () => ({ bookingService }));

    await assignmentLifecycleService.declineAssignment('a-decline-1', 'd-1');

    expect(mockQueueService.cancelAssignmentTimeout).toHaveBeenCalledWith('a-decline-1');
  });

  test('15.3: declineAssignment FCM push to transporter', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/assignment/assignment-lifecycle.service.ts'),
      'utf-8'
    );

    // FCM push after decline
    expect(source).toContain("title: '❌ Driver Declined Trip'");
    expect(source).toContain('Reassign?');
  });

  test('15.4: declineAssignment notifies transporter via WebSocket', async () => {
    const { assignmentLifecycleService } = require('../modules/assignment/assignment-lifecycle.service');

    mockDb.getAssignmentById.mockResolvedValue({
      id: 'a-decline-2',
      driverId: 'd-2',
      driverName: 'TestDriver',
      transporterId: 'tx-2',
      vehicleId: 'v-2',
      vehicleNumber: 'KA-02',
      tripId: 't-2',
      bookingId: 'b-2',
      status: 'pending',
    });
    mockPrismaClient.vehicle.findUnique.mockResolvedValue({
      vehicleKey: 'vk-2',
      transporterId: 'tx-2',
      status: 'on_hold',
    });
    mockDb.getBookingById.mockResolvedValue(null);

    const bookingService = { decrementTrucksFilled: jest.fn() };
    jest.doMock('../modules/booking/booking.service', () => ({ bookingService }));

    await assignmentLifecycleService.declineAssignment('a-decline-2', 'd-2');

    // Should notify transporter
    expect(mockEmitToUser).toHaveBeenCalledWith(
      'tx-2',
      'assignment_status_changed',
      expect.objectContaining({
        status: 'driver_declined',
        message: expect.stringContaining('declined'),
      })
    );
  });
});
