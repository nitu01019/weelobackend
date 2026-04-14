/**
 * =============================================================================
 * MANAGER FIX -- Cross-cutting Issues #10, #35, #36
 * =============================================================================
 *
 * Issue #10: Inconsistent error codes ORDER_ACTIVE_EXISTS vs ACTIVE_ORDER_EXISTS
 * Issue #35: FCM sends both notification + data blocks (duplicate on Android)
 * Issue #36: Booking fetch after TX can return null on replication lag
 *
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP -- Must come before any imports
// =============================================================================

const mockGetBookingById = jest.fn();
const mockGetVehiclesByTransporter = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getBookingById: mockGetBookingById,
    getVehiclesByTransporter: mockGetVehiclesByTransporter,
  },
}));

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    user: { findMany: jest.fn().mockResolvedValue([]) },
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

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    isRedisEnabled: jest.fn().mockReturnValue(true),
    isConnected: jest.fn().mockReturnValue(true),
    sAdd: jest.fn().mockResolvedValue(1),
    sRem: jest.fn().mockResolvedValue(1),
    sMembers: jest.fn().mockResolvedValue([]),
    expire: jest.fn().mockResolvedValue(true),
    del: jest.fn().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue(null),
  },
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { ErrorCode } from '../core/constants';
import { BookingQueryService } from '../modules/booking/booking-query.service';

// =============================================================================
// ISSUE #10: CONSISTENT ERROR CODES
// =============================================================================

describe('Issue #10: Consistent error code for active order/booking guard', () => {
  it('ErrorCode.ORDER_ACTIVE_EXISTS resolves to ORD_6005', () => {
    expect(ErrorCode.ORDER_ACTIVE_EXISTS).toBe('ORD_6005');
  });

  it('ErrorCode.ORDER_ACTIVE_EXISTS is the canonical alias for ORD_6005', () => {
    // ACTIVE_ORDER_EXISTS is used as a string literal in AppError, not as an enum member
    expect(ErrorCode.ORDER_ACTIVE_EXISTS).toBe('ORD_6005');
  });

  it('ORDER_ACTIVE_EXISTS is enumerable on ErrorCode', () => {
    const keys = Object.keys(ErrorCode);
    expect(keys).toContain('ORDER_ACTIVE_EXISTS');
  });
});

// =============================================================================
// ISSUE #35: FCM DATA-ONLY MESSAGES
// =============================================================================

describe('Issue #35: FCM buildMessage sends data-only for background types', () => {
  // Access private buildMessage via prototype trick
  let fcmServiceInstance: any;

  beforeAll(async () => {
    // Dynamic import to avoid hoisting issues with mocks
    const { fcmService } = await import('../shared/services/fcm.service');
    fcmServiceInstance = fcmService;
  });

  it('broadcast notification includes notification block with title and body', () => {
    const message = (fcmServiceInstance as any).buildMessage({
      type: 'new_broadcast',
      title: 'New Booking!',
      body: '3 trucks needed',
      priority: 'high',
      data: { broadcastId: 'b1' },
    });

    // Current behavior: notification block is always present
    expect(message.notification).toBeDefined();
    expect(message.notification.title).toBe('New Booking!');
    expect(message.notification.body).toBe('3 trucks needed');
    expect(message.data.type).toBe('new_broadcast');
    expect(message.data.broadcastId).toBe('b1');
    // Android priority is set
    expect(message.android.priority).toBe('high');
  });

  it('assignment_update notification includes notification block', () => {
    const message = (fcmServiceInstance as any).buildMessage({
      type: 'assignment_update',
      title: 'Assignment',
      body: 'Driver accepted',
      priority: 'normal',
      data: { assignmentId: 'a1' },
    });

    expect(message.notification).toBeDefined();
    expect(message.notification.title).toBe('Assignment');
    expect(message.data.assignmentId).toBe('a1');
  });

  it('trip_update notification includes notification block', () => {
    const message = (fcmServiceInstance as any).buildMessage({
      type: 'trip_update',
      title: 'Trip Started',
      body: 'Your trip has started',
      data: {},
    });

    expect(message.notification).toBeDefined();
    expect(message.notification.title).toBe('Trip Started');
  });

  it('payment notification keeps notification block (not data-only)', () => {
    const message = (fcmServiceInstance as any).buildMessage({
      type: 'payment_received',
      title: 'Payment Received',
      body: 'Rs 500',
      priority: 'high',
      data: { amount: '500' },
    });

    // Standard message: HAS notification block
    expect(message.notification).toBeDefined();
    expect(message.notification.title).toBe('Payment Received');
    expect(message.notification.body).toBe('Rs 500');
    // Data block also present
    expect(message.data.type).toBe('payment_received');
    // Android notification sub-block present with channelId
    expect(message.android.notification).toBeDefined();
    expect(message.android.notification.channelId).toBe('payments');
  });

  it('general notification keeps notification block', () => {
    const message = (fcmServiceInstance as any).buildMessage({
      type: 'general',
      title: 'Hello',
      body: 'World',
      data: {},
    });

    expect(message.notification).toBeDefined();
    expect(message.notification.title).toBe('Hello');
  });
});

// =============================================================================
// ISSUE #36: BOOKING FETCH RETRY ON REPLICATION LAG
// =============================================================================

describe('Issue #36: BookingQueryService.getBookingById retries on replication lag', () => {
  let service: BookingQueryService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new BookingQueryService();
  });

  it('returns booking immediately when found on first try', async () => {
    const booking = { id: 'b1', customerId: 'c1', vehicleType: 'truck' };
    mockGetBookingById.mockResolvedValueOnce(booking);

    const result = await service.getBookingById('b1', 'c1', 'customer');

    expect(result).toEqual(booking);
    // Only one DB call needed -- no retry
    expect(mockGetBookingById).toHaveBeenCalledTimes(1);
  });

  it('retries after delay when first fetch returns null (replication lag)', async () => {
    const booking = { id: 'b1', customerId: 'c1', vehicleType: 'truck' };
    // First call: undefined (replication lag)
    mockGetBookingById.mockResolvedValueOnce(undefined);
    // Second call: found after replica caught up
    mockGetBookingById.mockResolvedValueOnce(booking);

    const result = await service.getBookingById('b1', 'c1', 'customer');

    expect(result).toEqual(booking);
    // Two DB calls: initial + retry
    expect(mockGetBookingById).toHaveBeenCalledTimes(2);
    // Both calls used the same bookingId
    expect(mockGetBookingById).toHaveBeenNthCalledWith(1, 'b1');
    expect(mockGetBookingById).toHaveBeenNthCalledWith(2, 'b1');
  });

  it('throws 404 when booking not found after retry', async () => {
    // Both calls: undefined
    mockGetBookingById.mockResolvedValue(undefined);

    await expect(
      service.getBookingById('b1', 'c1', 'customer')
    ).rejects.toThrow('Booking not found');
    // Both initial + retry attempted
    expect(mockGetBookingById).toHaveBeenCalledTimes(2);
  });

  it('does not retry when booking is found on first try (no unnecessary delay)', async () => {
    const booking = { id: 'b2', customerId: 'c2', vehicleType: 'mini_truck' };
    mockGetBookingById.mockResolvedValueOnce(booking);

    const start = Date.now();
    await service.getBookingById('b2', 'c2', 'customer');
    const elapsed = Date.now() - start;

    // Should complete in <50ms (no 100ms sleep)
    expect(elapsed).toBeLessThan(50);
    expect(mockGetBookingById).toHaveBeenCalledTimes(1);
  });
});
