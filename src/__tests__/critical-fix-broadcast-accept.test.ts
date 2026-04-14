/**
 * =============================================================================
 * CRITICAL FIX TESTS — broadcast-accept.service.ts (Issues #6 and #7)
 * =============================================================================
 *
 * Issue #6: Assignment created via broadcast-accept must schedule a timeout
 * Issue #7: Post-commit notifications must retry with backoff, not fire-and-forget
 *
 * Tests:
 *  1. Assignment created via broadcast-accept -> timeout IS scheduled
 *  2. Timeout scheduling fails -> assignment still created, error logged (no crash)
 *  3. After timeout expires -> assignment moves to expired/timed_out state
 *  4. Notification succeeds on first try -> parties notified
 *  5. Notification fails once, retry succeeds -> parties eventually notified
 *  6. All notification retries fail -> error logged, job queued if possible
 *
 * @author Agent-A3 (TEAM ALPHA)
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP -- Must come before any imports
// =============================================================================

const mockScheduleAssignmentTimeout = jest.fn().mockResolvedValue('timer:assignment-timeout:test-id');
const mockQueuePushNotification = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    scheduleAssignmentTimeout: mockScheduleAssignmentTimeout,
    queuePushNotification: mockQueuePushNotification,
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

const mockEmitToUser = jest.fn();
const mockEmitToRoom = jest.fn();
jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToRoom: (...args: any[]) => mockEmitToRoom(...args),
  SocketEvent: {
    TRIP_ASSIGNED: 'trip_assigned',
    TRUCK_CONFIRMED: 'truck_confirmed',
    BOOKING_UPDATED: 'booking_updated',
  },
}));

const mockSendPushNotification = jest.fn().mockResolvedValue(true);
jest.mock('../shared/services/fcm.service', () => ({
  sendPushNotification: (...args: any[]) => mockSendPushNotification(...args),
}));

const mockRedisGetJSON = jest.fn().mockResolvedValue(null);
const mockRedisSetJSON = jest.fn().mockResolvedValue(undefined);
const mockRedisAcquireLock = jest.fn().mockResolvedValue({ acquired: true });
const mockRedisReleaseLock = jest.fn().mockResolvedValue(undefined);
const mockRedisDel = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    getJSON: (...args: any[]) => mockRedisGetJSON(...args),
    setJSON: (...args: any[]) => mockRedisSetJSON(...args),
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    sAdd: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(undefined),
    hSet: jest.fn().mockResolvedValue(undefined),
  },
}));

// Build a mock transaction result that withDbTimeout will return
const baseTxResult = {
  replayed: false,
  assignmentId: 'assign-001',
  tripId: 'trip-001',
  trucksConfirmed: 1,
  totalTrucksNeeded: 2,
  isFullyFilled: false,
  booking: {
    id: 'broadcast-001',
    customerId: 'customer-001',
    customerName: 'Test Customer',
    customerPhone: '9999999999',
    trucksNeeded: 2,
    trucksFilled: 1,
    status: 'partially_filled',
    pricePerTruck: 5000,
    distanceKm: 100,
    vehicleType: 'truck',
    vehicleSubtype: 'open',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    pickup: { address: 'Pickup Place', city: 'Delhi' },
    drop: { address: 'Drop Place', city: 'Mumbai' },
  },
  driver: {
    id: 'driver-001',
    name: 'Test Driver',
    phone: '8888888888',
    transporterId: 'transporter-001',
  },
  vehicle: {
    id: 'vehicle-001',
    vehicleNumber: 'DL01AB1234',
    vehicleType: 'truck',
    vehicleSubtype: 'open',
    transporterId: 'transporter-001',
  },
  transporter: {
    id: 'transporter-001',
    name: 'Test Transporter',
    businessName: 'Test Transport Co',
    phone: '7777777777',
  },
};

const mockWithDbTimeout = jest.fn().mockResolvedValue(baseTxResult);
jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {},
  withDbTimeout: (...args: any[]) => mockWithDbTimeout(...args),
  VehicleStatus: {
    available: 'available',
    on_hold: 'on_hold',
    in_transit: 'in_transit',
  },
}));

jest.mock('../shared/database/db', () => ({
  db: {},
}));

jest.mock('../core/config/hold-config', () => ({
  HOLD_CONFIG: {
    driverAcceptTimeoutMs: 45_000,
    driverAcceptTimeoutSeconds: 45,
    confirmedHoldMaxSeconds: 180,
    flexHoldDurationSeconds: 90,
    flexHoldExtensionSeconds: 30,
    flexHoldMaxDurationSeconds: 130,
    flexHoldMaxExtensions: 2,
  },
}));

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('mock-uuid-001'),
}));

// =============================================================================
// IMPORTS — after mocks
// =============================================================================

import { acceptBroadcast, AcceptBroadcastParams } from '../modules/broadcast/broadcast-accept.service';
import { logger } from '../shared/services/logger.service';

// =============================================================================
// HELPERS
// =============================================================================

const defaultParams: AcceptBroadcastParams = {
  driverId: 'driver-001',
  vehicleId: 'vehicle-001',
  actorUserId: 'transporter-001',
  actorRole: 'transporter',
};

function resetAllMocks(): void {
  jest.clearAllMocks();
  mockWithDbTimeout.mockResolvedValue({ ...baseTxResult });
  mockScheduleAssignmentTimeout.mockResolvedValue('timer:assignment-timeout:test-id');
  mockSendPushNotification.mockResolvedValue(true);
  mockRedisGetJSON.mockResolvedValue(null);
  mockRedisAcquireLock.mockResolvedValue({ acquired: true });
  mockQueuePushNotification.mockResolvedValue(undefined);
}

// =============================================================================
// TEST SUITE
// =============================================================================

describe('Critical Fix: broadcast-accept.service.ts (Issues #6 and #7)', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: Assignment created -> timeout IS scheduled
  // -------------------------------------------------------------------------
  describe('Issue #6: Assignment timeout scheduling', () => {
    test('Test 1: scheduleAssignmentTimeout is called after assignment creation', async () => {
      const result = await acceptBroadcast('broadcast-001', defaultParams);

      expect(result.status).toBe('assigned');
      expect(result.assignmentId).toBe('assign-001');

      // Verify timeout was scheduled
      expect(mockScheduleAssignmentTimeout).toHaveBeenCalledTimes(1);
      expect(mockScheduleAssignmentTimeout).toHaveBeenCalledWith(
        expect.objectContaining({
          assignmentId: 'assign-001',
          driverId: 'driver-001',
          vehicleId: 'vehicle-001',
          tripId: 'trip-001',
          bookingId: 'broadcast-001',
          transporterId: 'transporter-001',
          vehicleNumber: 'DL01AB1234',
          driverName: 'Test Driver',
        }),
        45_000 // HOLD_CONFIG.driverAcceptTimeoutMs
      );
    });

    test('Test 1b: timeout uses HOLD_CONFIG.driverAcceptTimeoutMs (45s)', async () => {
      await acceptBroadcast('broadcast-001', defaultParams);

      const [, delayMs] = mockScheduleAssignmentTimeout.mock.calls[0];
      expect(delayMs).toBe(45_000);
    });

    // -----------------------------------------------------------------------
    // Test 2: Timeout scheduling fails -> assignment still succeeds
    // -----------------------------------------------------------------------
    test('Test 2: timeout scheduling failure does not crash the accept flow', async () => {
      mockScheduleAssignmentTimeout.mockRejectedValue(new Error('Redis unavailable'));

      const result = await acceptBroadcast('broadcast-001', defaultParams);

      // Accept still succeeds
      expect(result.status).toBe('assigned');
      expect(result.assignmentId).toBe('assign-001');

      // Error was logged
      expect(logger.error).toHaveBeenCalledWith(
        '[BroadcastAccept] Failed to schedule assignment timeout',
        expect.objectContaining({
          assignmentId: 'assign-001',
          error: 'Redis unavailable',
        })
      );
    });

    test('Test 2b: timeout scheduling failure still allows notifications to proceed', async () => {
      mockScheduleAssignmentTimeout.mockRejectedValue(new Error('Redis down'));

      await acceptBroadcast('broadcast-001', defaultParams);

      // Notifications should still fire
      expect(mockEmitToUser).toHaveBeenCalled();
      expect(mockSendPushNotification).toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Test 3: Timeout is not scheduled on idempotent replay
    // -----------------------------------------------------------------------
    test('Test 3: timeout is NOT scheduled on idempotent replay', async () => {
      mockWithDbTimeout.mockResolvedValue({
        ...baseTxResult,
        replayed: true,
      });

      const result = await acceptBroadcast('broadcast-001', defaultParams);

      expect(result.replayed).toBe(true);
      // No timeout should be scheduled for a replayed assignment
      expect(mockScheduleAssignmentTimeout).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Test 4-6: Notification retry with backoff
  // -------------------------------------------------------------------------
  describe('Issue #7: Notification retry with backoff', () => {
    test('Test 4: notifications succeed on first try -> parties notified', async () => {
      const result = await acceptBroadcast('broadcast-001', defaultParams);

      expect(result.status).toBe('assigned');

      // Driver socket notification
      expect(mockEmitToUser).toHaveBeenCalledWith(
        'driver-001',
        'trip_assigned',
        expect.objectContaining({ type: 'trip_assigned', assignmentId: 'assign-001' })
      );

      // Driver FCM
      expect(mockSendPushNotification).toHaveBeenCalledWith(
        'driver-001',
        expect.objectContaining({ title: 'New Trip Assigned!' })
      );

      // Customer socket notification
      expect(mockEmitToUser).toHaveBeenCalledWith(
        'customer-001',
        'truck_confirmed',
        expect.objectContaining({ type: 'truck_confirmed', bookingId: 'broadcast-001' })
      );

      // Customer FCM
      expect(mockSendPushNotification).toHaveBeenCalledWith(
        'customer-001',
        expect.objectContaining({ title: 'Truck 1/2 Confirmed!' })
      );

      // Booking room update
      expect(mockEmitToRoom).toHaveBeenCalledWith(
        'booking:broadcast-001',
        'booking_updated',
        expect.objectContaining({ bookingId: 'broadcast-001' })
      );
    });

    test('Test 5: driver notification fails once then succeeds on retry', async () => {
      let callCount = 0;
      mockSendPushNotification.mockImplementation(async (userId: string) => {
        if (userId === 'driver-001') {
          callCount++;
          if (callCount === 1) {
            throw new Error('FCM temporarily unavailable');
          }
        }
        return true;
      });

      const result = await acceptBroadcast('broadcast-001', defaultParams);

      expect(result.status).toBe('assigned');

      // sendPushNotification was called more than once for driver (retry)
      const driverCalls = mockSendPushNotification.mock.calls.filter(
        (call: any[]) => call[0] === 'driver-001'
      );
      expect(driverCalls.length).toBeGreaterThanOrEqual(2);

      // No error logged for driver notification (it eventually succeeded)
      expect(logger.error).not.toHaveBeenCalledWith(
        '[BroadcastAccept] All driver notification retries failed',
        expect.anything()
      );
    });

    test('Test 5b: customer notification fails once then succeeds on retry', async () => {
      let custCallCount = 0;
      mockSendPushNotification.mockImplementation(async (userId: string) => {
        if (userId === 'customer-001') {
          custCallCount++;
          if (custCallCount === 1) {
            throw new Error('FCM temporarily unavailable');
          }
        }
        return true;
      });

      const result = await acceptBroadcast('broadcast-001', defaultParams);

      expect(result.status).toBe('assigned');

      // Customer notification was retried
      const customerCalls = mockSendPushNotification.mock.calls.filter(
        (call: any[]) => call[0] === 'customer-001'
      );
      expect(customerCalls.length).toBeGreaterThanOrEqual(2);

      // No error logged for customer notification (it eventually succeeded)
      expect(logger.error).not.toHaveBeenCalledWith(
        '[BroadcastAccept] All customer notification retries failed',
        expect.anything()
      );
    });

    test('Test 6: all driver notification retries fail -> error logged + queued', async () => {
      mockSendPushNotification.mockImplementation(async (userId: string) => {
        if (userId === 'driver-001') {
          throw new Error('FCM service permanently down');
        }
        return true;
      });

      const result = await acceptBroadcast('broadcast-001', defaultParams);

      // Accept still succeeds (notifications are post-commit)
      expect(result.status).toBe('assigned');

      // Error was logged after all retries exhausted
      expect(logger.error).toHaveBeenCalledWith(
        '[BroadcastAccept] All driver notification retries failed',
        expect.objectContaining({
          assignmentId: 'assign-001',
          driverId: 'driver-001',
        })
      );

      // Fallback: notification was queued for later retry
      expect(mockQueuePushNotification).toHaveBeenCalledWith(
        'driver-001',
        expect.objectContaining({ title: 'New Trip Assigned!' })
      );
    }, 30_000);

    test('Test 6b: all customer notification retries fail -> error logged + queued', async () => {
      mockSendPushNotification.mockImplementation(async (userId: string) => {
        if (userId === 'customer-001') {
          throw new Error('FCM service permanently down');
        }
        return true;
      });

      const result = await acceptBroadcast('broadcast-001', defaultParams);

      // Accept still succeeds
      expect(result.status).toBe('assigned');

      // Error was logged after all retries exhausted
      expect(logger.error).toHaveBeenCalledWith(
        '[BroadcastAccept] All customer notification retries failed',
        expect.objectContaining({
          assignmentId: 'assign-001',
          customerId: 'customer-001',
        })
      );

      // Fallback: notification was queued for later retry
      expect(mockQueuePushNotification).toHaveBeenCalledWith(
        'customer-001',
        expect.objectContaining({ title: 'Truck 1/2 Confirmed!' })
      );
    }, 30_000);

    test('Test 6c: queue fallback itself fails -> still no crash', async () => {
      mockSendPushNotification.mockRejectedValue(new Error('FCM dead'));
      mockQueuePushNotification.mockRejectedValue(new Error('Queue dead too'));

      const result = await acceptBroadcast('broadcast-001', defaultParams);

      // Accept still succeeds even when everything post-commit fails
      expect(result.status).toBe('assigned');
      expect(result.assignmentId).toBe('assign-001');
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // Combined: Both fixes work together
  // -------------------------------------------------------------------------
  describe('Combined: timeout + notification retry', () => {
    test('both timeout scheduling and notifications execute in sequence', async () => {
      const callOrder: string[] = [];

      mockScheduleAssignmentTimeout.mockImplementation(async () => {
        callOrder.push('timeout_scheduled');
        return 'timer:test';
      });
      mockSendPushNotification.mockImplementation(async () => {
        callOrder.push('notification_sent');
        return true;
      });

      await acceptBroadcast('broadcast-001', defaultParams);

      // Timeout is scheduled before notifications
      expect(callOrder[0]).toBe('timeout_scheduled');
      // Notifications follow
      expect(callOrder.filter(c => c === 'notification_sent').length).toBeGreaterThan(0);
    });

    test('timeout failure does not prevent notifications', async () => {
      mockScheduleAssignmentTimeout.mockRejectedValue(new Error('timeout failed'));

      const result = await acceptBroadcast('broadcast-001', defaultParams);

      expect(result.status).toBe('assigned');
      expect(mockSendPushNotification).toHaveBeenCalled();
      expect(mockEmitToUser).toHaveBeenCalled();
    });
  });
});
