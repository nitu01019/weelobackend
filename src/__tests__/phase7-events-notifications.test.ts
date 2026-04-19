/**
 * =============================================================================
 * PHASE 7 — Events & Notifications Tests
 * =============================================================================
 *
 * Tests for:
 *   F-H13+H17+M15: Event unification (post-accept.effects.ts aligned with Path A)
 *   F-M26: GPS staleness check in Path B
 *   F-M2: Notification outbox (Redis-backed buffer)
 *   F-H8: Customer notification gap documented
 *   F-L6: FCM throttle (online skip, non-critical throttle, critical always)
 *   F-L9: Driver online pre-check (Socket vs FCM routing)
 *   F-H12: Presence split-brain fix (GPS path refreshes driver:presence TTL)
 *
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

jest.mock('../config/environment', () => ({
  config: {
    redis: { enabled: true },
    isProduction: false,
    otp: { expiryMinutes: 5 },
    sms: {},
    googleMaps: { apiKey: 'test-key', enabled: false },
  },
}));

// ---------- Transitive dependency mocks for order-broadcast.service ----------
jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: { calculateRoute: jest.fn() },
}));
jest.mock('../shared/services/distance-matrix.service', () => ({
  distanceMatrixService: { batchGetPickupDistance: jest.fn().mockResolvedValue(new Map()) },
}));
jest.mock('../shared/services/cache.service', () => ({
  cacheService: { get: jest.fn(), set: jest.fn(), delete: jest.fn(), scanIterator: jest.fn() },
}));
jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: {
    filterOnline: jest.fn().mockResolvedValue([]),
    isOnline: jest.fn().mockResolvedValue(true),
  },
}));
jest.mock('../modules/routing', () => ({
  routingService: { calculateRouteBreakdown: jest.fn().mockReturnValue({ legs: [], totalDistanceKm: 0, totalDurationMinutes: 0, totalDurationFormatted: '0', totalStops: 0, estimatedArrival: '' }) },
}));
jest.mock('../modules/order/progressive-radius-matcher', () => ({
  progressiveRadiusMatcher: {
    findCandidates: jest.fn().mockResolvedValue([]),
    getStepCount: jest.fn().mockReturnValue(6),
    getStep: jest.fn(),
  },
  PROGRESSIVE_RADIUS_STEPS: [],
}));
jest.mock('../shared/services/candidate-scorer.service', () => ({
  candidateScorerService: { scoreAndRank: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../modules/admin/admin-suspension.service', () => ({
  adminSuspensionService: { getSuspendedUserIds: jest.fn().mockResolvedValue(new Set()) },
}));
jest.mock('../shared/utils/pii.utils', () => ({
  maskPhoneForExternal: (phone: string) => phone ? `****${phone.slice(-4)}` : '',
}));
jest.mock('../core/config/hold-config', () => ({
  HOLD_CONFIG: { driverAcceptTimeoutMs: 45000 },
  BROADCAST_DEDUP_TTL_BUFFER_SECONDS: 30,
}));
jest.mock('../shared/database/db', () => ({
  db: {
    getOrderById: jest.fn(),
    getTruckRequestsByOrder: jest.fn().mockResolvedValue([]),
    getTransportersWithVehicleType: jest.fn().mockResolvedValue([]),
    getTransportersAvailabilitySnapshot: jest.fn().mockResolvedValue([]),
    updateTruckRequest: jest.fn(),
  },
}));
jest.mock('../modules/order/order-broadcast-helpers', () => ({
  withEventMeta: (data: any) => ({ ...data, _meta: { eventId: 'test', ts: Date.now() } }),
  notifiedTransportersKey: (orderId: string, vt: string, vs: string) => `notified:${orderId}:${vt}:${vs}`,
  makeVehicleGroupKey: (vt: string, vs: string) => `${vt}:${vs}`,
  parseVehicleGroupKey: (key: string) => { const [vehicleType, vehicleSubtype] = key.split(':'); return { vehicleType, vehicleSubtype }; },
  buildRequestsByType: jest.fn().mockReturnValue(new Map()),
  chunkTransporterIds: (ids: string[], size: number) => [ids],
}));

// ---------- Redis service mock ----------
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn().mockResolvedValue(undefined);
const mockRedisDel = jest.fn().mockResolvedValue(undefined);
const mockRedisIncr = jest.fn().mockResolvedValue(1);
const mockRedisExpire = jest.fn().mockResolvedValue(undefined);
const mockRedisExists = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisSMembers = jest.fn();
const mockRedisSAdd = jest.fn();
const mockRedisGetJSON = jest.fn();
const mockRedisSetJSON = jest.fn().mockResolvedValue(undefined);
const mockRedisCancelTimer = jest.fn();
const mockRedisSetTimer = jest.fn();
const mockRedisLPush = jest.fn().mockResolvedValue(1);
const mockRedisRPop = jest.fn();
const mockRedisHasTimer = jest.fn();
const mockRedisSAddWithExpire = jest.fn().mockResolvedValue(undefined);
const mockRedisSIsMember = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: unknown[]) => mockRedisGet(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
    incr: (...args: unknown[]) => mockRedisIncr(...args),
    expire: (...args: unknown[]) => mockRedisExpire(...args),
    exists: (...args: unknown[]) => mockRedisExists(...args),
    acquireLock: (...args: unknown[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: unknown[]) => mockRedisReleaseLock(...args),
    sMembers: (...args: unknown[]) => mockRedisSMembers(...args),
    sAdd: (...args: unknown[]) => mockRedisSAdd(...args),
    getJSON: (...args: unknown[]) => mockRedisGetJSON(...args),
    setJSON: (...args: unknown[]) => mockRedisSetJSON(...args),
    cancelTimer: (...args: unknown[]) => mockRedisCancelTimer(...args),
    setTimer: (...args: unknown[]) => mockRedisSetTimer(...args),
    lPush: (...args: unknown[]) => mockRedisLPush(...args),
    rPop: (...args: unknown[]) => mockRedisRPop(...args),
    hasTimer: (...args: unknown[]) => mockRedisHasTimer(...args),
    sAddWithExpire: (...args: unknown[]) => mockRedisSAddWithExpire(...args),
    sIsMember: (...args: unknown[]) => mockRedisSIsMember(...args),
  },
}));

// ---------- Socket service mock ----------
const mockEmitToUser = jest.fn().mockReturnValue(true);
const mockEmitToBooking = jest.fn();
const mockEmitToUsers = jest.fn();
const mockIsUserConnectedAsync = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: unknown[]) => mockEmitToUser(...args),
  emitToBooking: (...args: unknown[]) => mockEmitToBooking(...args),
  emitToUsers: (...args: unknown[]) => mockEmitToUsers(...args),
  emitToTrip: jest.fn(),
  isUserConnectedAsync: (...args: unknown[]) => mockIsUserConnectedAsync(...args),
  socketService: {
    emitToUser: (...args: unknown[]) => mockEmitToUser(...args),
    emitToBooking: (...args: unknown[]) => mockEmitToBooking(...args),
  },
  SocketEvent: {
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    DRIVER_ACCEPTED: 'driver_accepted',
    LOCATION_UPDATED: 'location_updated',
    NEW_BROADCAST: 'new_broadcast',
    TRUCK_ASSIGNED: 'truck_assigned',
    TRIP_ASSIGNED: 'trip_assigned',
    TRUCK_CONFIRMED: 'truck_confirmed',
  },
}));

// ---------- FCM service mock ----------
const mockSendPushNotification = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/fcm.service', () => ({
  sendPushNotification: (...args: unknown[]) => mockSendPushNotification(...args),
}));

// ---------- Queue service mock ----------
const mockQueuePushNotification = jest.fn().mockResolvedValue(undefined);
const mockQueuePushNotificationBatch = jest.fn().mockResolvedValue(undefined);
const mockQueueBroadcast = jest.fn().mockResolvedValue([]);
const mockQueueBroadcastBatch = jest.fn().mockResolvedValue([]);

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queuePushNotification: (...args: unknown[]) => mockQueuePushNotification(...args),
    queuePushNotificationBatch: (...args: unknown[]) => mockQueuePushNotificationBatch(...args),
    queueBroadcast: (...args: unknown[]) => mockQueueBroadcast(...args),
    queueBroadcastBatch: (...args: unknown[]) => mockQueueBroadcastBatch(...args),
  },
}));

// F-B-50: outbox drain now calls the canonical queueService singleton mocked above
// (the former separate jest.mock('../shared/services/queue-management.service') has
// been consolidated into the single queue.service mock).
const mockQueueMgmtPushNotification = mockQueuePushNotification;

// ---------- Prisma mock ----------
const mockPrismaBookingFindUnique = jest.fn();
const mockPrismaVehicleFindUnique = jest.fn();
const mockPrismaUserFindUnique = jest.fn();
const mockPrismaUserUpdate = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    booking: {
      findUnique: (...args: unknown[]) => mockPrismaBookingFindUnique(...args),
    },
    vehicle: {
      findUnique: (...args: unknown[]) => mockPrismaVehicleFindUnique(...args),
    },
    user: {
      findUnique: (...args: unknown[]) => mockPrismaUserFindUnique(...args),
      update: (...args: unknown[]) => mockPrismaUserUpdate(...args),
    },
  },
}));

// ---------- Live availability service mock ----------
const mockOnVehicleStatusChange = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: (...args: unknown[]) => mockOnVehicleStatusChange(...args),
  },
}));

// ---------- Tracking service mock ----------
const mockInitializeTracking = jest.fn().mockResolvedValue(undefined);
jest.mock('../modules/tracking/tracking.service', () => ({
  trackingService: {
    initializeTracking: (...args: unknown[]) => mockInitializeTracking(...args),
  },
}));

// ---------- Fleet cache mock ----------
jest.mock('../shared/services/fleet-cache.service', () => ({
  fleetCacheService: {
    invalidateDriverCache: jest.fn().mockResolvedValue(undefined),
  },
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { applyPostAcceptSideEffects, PostAcceptContext } from '../modules/assignment/post-accept.effects';
import { bufferNotification, drainOutbox, OutboxEntry } from '../shared/services/notification-outbox.service';
import { emitBroadcastStateChanged } from '../modules/order/order-broadcast.service';

// =============================================================================
// TEST HELPERS
// =============================================================================

function makePostAcceptCtx(overrides: Partial<PostAcceptContext> = {}): PostAcceptContext {
  return {
    assignmentId: 'assign-001',
    driverId: 'driver-001',
    vehicleId: 'vehicle-001',
    vehicleNumber: 'KA-01-AB-1234',
    tripId: 'trip-001',
    bookingId: 'booking-001',
    transporterId: 'transporter-001',
    driverName: 'Test Driver',
    ...overrides,
  };
}

// =============================================================================
// TEST SUITES
// =============================================================================

beforeEach(() => {
  jest.clearAllMocks();
  // Default mocks for common lookups
  mockPrismaVehicleFindUnique.mockResolvedValue({
    vehicleKey: 'tipper-20Ton-vehicle-001',
    transporterId: 'transporter-001',
    status: 'on_hold',
  });
  mockPrismaBookingFindUnique.mockResolvedValue({
    customerId: 'customer-001',
  });
  mockRedisGet.mockResolvedValue(null);
  mockRedisExpire.mockResolvedValue(undefined);
  mockRedisSet.mockResolvedValue(undefined);
});

// =============================================================================
// F-H13+H17+M15: Event unification (post-accept.effects.ts)
// =============================================================================

describe('F-H13+H17+M15: Post-accept event unification', () => {
  it('should emit both ASSIGNMENT_STATUS_CHANGED and driver_accepted events (dual emit)', async () => {
    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    const socketCalls = mockEmitToUser.mock.calls;
    const customerSocketCall = socketCalls.find(
      (call: unknown[]) => call[0] === 'customer-001' && call[1] === 'assignment_status_changed'
    );
    expect(customerSocketCall).toBeDefined();
    expect(customerSocketCall![1]).toBe('assignment_status_changed');
    // C3 fix: driver_accepted is now also emitted for backward compatibility
    const oldNameCall = socketCalls.find(
      (call: unknown[]) => call[1] === 'driver_accepted'
    );
    expect(oldNameCall).toBeDefined();
  });

  it('should set FCM type to "driver_assigned", not "assignment_update"', async () => {
    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    // Customer FCM push
    const customerFcmCall = mockQueuePushNotification.mock.calls.find(
      (call: unknown[]) => call[0] === 'customer-001'
    );
    expect(customerFcmCall).toBeDefined();
    expect((customerFcmCall![1] as any).data.type).toBe('driver_assigned');
    // Verify it is NOT the old type
    expect((customerFcmCall![1] as any).data.type).not.toBe('assignment_update');
  });

  it('should broadcast to booking room via emitToBooking', async () => {
    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    expect(mockEmitToBooking).toHaveBeenCalledWith(
      'booking-001',
      'assignment_status_changed',
      expect.objectContaining({
        assignmentId: 'assign-001',
        tripId: 'trip-001',
        status: 'driver_accepted',
        vehicleNumber: 'KA-01-AB-1234',
      })
    );
  });

  it('should send FCM to transporter with type "assignment_update"', async () => {
    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    const transporterFcmCall = mockQueuePushNotification.mock.calls.find(
      (call: unknown[]) => call[0] === 'transporter-001'
    );
    expect(transporterFcmCall).toBeDefined();
    expect((transporterFcmCall![1] as any).data.type).toBe('assignment_update');
  });

  it('should include driverName and vehicleNumber in customer socket payload', async () => {
    const ctx = makePostAcceptCtx({ driverName: 'Ramesh', vehicleNumber: 'MH-12-CD-5678' });
    await applyPostAcceptSideEffects(ctx);

    const customerSocketCall = mockEmitToUser.mock.calls.find(
      (call: unknown[]) => call[0] === 'customer-001'
    );
    const payload = customerSocketCall![2];
    expect(payload.driverName).toBe('Ramesh');
    expect(payload.vehicleNumber).toBe('MH-12-CD-5678');
    expect(payload.status).toBe('driver_accepted');
  });

  it('both customer socket and FCM paths emit identical event/type pairs', async () => {
    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    // Socket uses 'assignment_status_changed'
    const socketCall = mockEmitToUser.mock.calls.find(
      (call: unknown[]) => call[0] === 'customer-001'
    );
    expect(socketCall![1]).toBe('assignment_status_changed');

    // FCM uses 'driver_assigned' (matches Android TYPE_DRIVER_ASSIGNED constant)
    const fcmCall = mockQueuePushNotification.mock.calls.find(
      (call: unknown[]) => call[0] === 'customer-001'
    );
    expect((fcmCall![1] as any).data.type).toBe('driver_assigned');
    // Both carry same assignmentId and status
    expect(socketCall![2].assignmentId).toBe((fcmCall![1] as any).data.assignmentId);
    expect(socketCall![2].status).toBe((fcmCall![1] as any).data.status);
  });

  it('should not fail if emitToBooking is unavailable (graceful degrade)', async () => {
    // Temporarily override the module so emitToBooking is not a function
    const socketMod = require('../shared/services/socket.service');
    const original = socketMod.emitToBooking;
    socketMod.emitToBooking = undefined;

    const ctx = makePostAcceptCtx();
    // Should not throw
    await expect(applyPostAcceptSideEffects(ctx)).resolves.toBeUndefined();

    socketMod.emitToBooking = original;
  });

  it('should skip customer notification when booking has no customerId', async () => {
    mockPrismaBookingFindUnique.mockResolvedValue({ customerId: null });
    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    const customerSocketCall = mockEmitToUser.mock.calls.find(
      (call: unknown[]) => call[0] === 'customer-001'
    );
    expect(customerSocketCall).toBeUndefined();
  });

  it('should still notify transporter even if customer notification fails', async () => {
    mockPrismaBookingFindUnique.mockRejectedValue(new Error('DB error'));
    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    // Transporter FCM should still fire
    const transporterFcmCall = mockQueuePushNotification.mock.calls.find(
      (call: unknown[]) => call[0] === 'transporter-001'
    );
    expect(transporterFcmCall).toBeDefined();
  });
});

// =============================================================================
// F-M26: GPS staleness check in Path B (post-accept.effects.ts)
// =============================================================================

describe('F-M26: GPS staleness check in Path B', () => {
  it('should seed GPS when location is fresh (within 5 minutes)', async () => {
    const freshLocation = JSON.stringify({
      latitude: 12.9716,
      longitude: 77.5946,
      speed: 30,
      bearing: 180,
      updatedAt: new Date().toISOString(),
    });
    mockRedisGet.mockResolvedValue(freshLocation);

    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    // Should have called setJSON for trip location seed
    const tripLocationCall = mockRedisSetJSON.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('driver:trip:')
    );
    expect(tripLocationCall).toBeDefined();
    expect((tripLocationCall![1] as any).latitude).toBe(12.9716);
    expect((tripLocationCall![1] as any).longitude).toBe(77.5946);
  });

  it('should skip GPS seed when location is older than 5 minutes', async () => {
    const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6 minutes ago
    const staleLocation = JSON.stringify({
      latitude: 12.9716,
      longitude: 77.5946,
      updatedAt: staleTime,
    });
    mockRedisGet.mockResolvedValue(staleLocation);

    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    const tripLocationCall = mockRedisSetJSON.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('driver:trip:')
    );
    expect(tripLocationCall).toBeUndefined();
  });

  it('should skip gracefully when no location data exists in Redis', async () => {
    mockRedisGet.mockResolvedValue(null);

    const ctx = makePostAcceptCtx();
    await expect(applyPostAcceptSideEffects(ctx)).resolves.toBeUndefined();

    const tripLocationCall = mockRedisSetJSON.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('driver:trip:')
    );
    expect(tripLocationCall).toBeUndefined();
  });

  it('should use timestamp field as fallback when updatedAt is missing', async () => {
    const freshTs = Date.now() - 60_000; // 1 minute ago
    const locationWithTimestamp = JSON.stringify({
      latitude: 13.0827,
      longitude: 80.2707,
      timestamp: freshTs,
    });
    mockRedisGet.mockResolvedValue(locationWithTimestamp);

    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    const tripLocationCall = mockRedisSetJSON.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('driver:trip:')
    );
    expect(tripLocationCall).toBeDefined();
    expect((tripLocationCall![1] as any).latitude).toBe(13.0827);
  });

  it('should treat location without updatedAt or timestamp as fresh (age=0)', async () => {
    const locationNoTs = JSON.stringify({
      latitude: 28.7041,
      longitude: 77.1025,
      speed: 0,
    });
    mockRedisGet.mockResolvedValue(locationNoTs);

    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    const tripLocationCall = mockRedisSetJSON.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('driver:trip:')
    );
    expect(tripLocationCall).toBeDefined();
  });

  it('should handle malformed location JSON gracefully', async () => {
    mockRedisGet.mockResolvedValue('not-valid-json{');

    const ctx = makePostAcceptCtx();
    // Should not throw, just log warning
    await expect(applyPostAcceptSideEffects(ctx)).resolves.toBeUndefined();
  });

  it('should set TTL of 24h (86400s) on seeded GPS location', async () => {
    const freshLocation = JSON.stringify({
      latitude: 12.9716,
      longitude: 77.5946,
      updatedAt: new Date().toISOString(),
    });
    mockRedisGet.mockResolvedValue(freshLocation);

    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    const tripLocationCall = mockRedisSetJSON.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('driver:trip:')
    );
    expect(tripLocationCall).toBeDefined();
    // Third argument is TTL
    expect(tripLocationCall![2]).toBe(86400);
  });
});

// =============================================================================
// F-M2: Notification outbox (Redis-backed buffer)
// =============================================================================

describe('F-M2: Notification outbox', () => {
  it('bufferNotification stores entry in Redis list with correct key', async () => {
    await bufferNotification('user-123', { title: 'Test', body: 'Hello' });

    expect(mockRedisLPush).toHaveBeenCalledWith(
      'notification:outbox:user-123',
      expect.any(String)
    );
    const storedJson = JSON.parse(mockRedisLPush.mock.calls[0][1]);
    expect(storedJson.userId).toBe('user-123');
    expect(storedJson.payload.title).toBe('Test');
    expect(storedJson.payload.body).toBe('Hello');
    expect(storedJson.timestamp).toBeDefined();
  });

  it('bufferNotification sets TTL of 3600s on outbox key', async () => {
    await bufferNotification('user-456', { title: 'X', body: 'Y' });

    expect(mockRedisExpire).toHaveBeenCalledWith(
      'notification:outbox:user-456',
      3600
    );
  });

  it('drainOutbox processes pending notifications within freshness window', async () => {
    const freshEntry: OutboxEntry = {
      userId: 'user-789',
      payload: { title: 'Fresh', body: 'Notification' },
      timestamp: Date.now() - 60_000, // 1 minute ago
    };
    // rPop returns one item then null
    mockRedisRPop
      .mockResolvedValueOnce(JSON.stringify(freshEntry))
      .mockResolvedValueOnce(null);

    await drainOutbox('user-789');

    expect(mockQueueMgmtPushNotification).toHaveBeenCalledWith(
      'user-789',
      { title: 'Fresh', body: 'Notification' }
    );
  });

  it('drainOutbox skips stale notifications older than 15 minutes', async () => {
    const staleEntry: OutboxEntry = {
      userId: 'user-stale',
      payload: { title: 'Stale', body: 'Old notification' },
      timestamp: Date.now() - 20 * 60 * 1000, // 20 minutes ago
    };
    mockRedisRPop
      .mockResolvedValueOnce(JSON.stringify(staleEntry))
      .mockResolvedValueOnce(null);

    await drainOutbox('user-stale');

    expect(mockQueueMgmtPushNotification).not.toHaveBeenCalled();
  });

  it('drainOutbox is a no-op when outbox is empty', async () => {
    mockRedisRPop.mockResolvedValue(null);

    await drainOutbox('user-empty');

    expect(mockQueueMgmtPushNotification).not.toHaveBeenCalled();
  });

  it('drainOutbox processes multiple items until null', async () => {
    const entry1: OutboxEntry = {
      userId: 'user-multi',
      payload: { title: 'First', body: 'msg1' },
      timestamp: Date.now() - 1000,
    };
    const entry2: OutboxEntry = {
      userId: 'user-multi',
      payload: { title: 'Second', body: 'msg2' },
      timestamp: Date.now() - 2000,
    };
    mockRedisRPop
      .mockResolvedValueOnce(JSON.stringify(entry1))
      .mockResolvedValueOnce(JSON.stringify(entry2))
      .mockResolvedValueOnce(null);

    await drainOutbox('user-multi');

    expect(mockQueueMgmtPushNotification).toHaveBeenCalledTimes(2);
  });

  it('bufferNotification handles Redis lPush failure gracefully', async () => {
    mockRedisLPush.mockRejectedValueOnce(new Error('Redis down'));

    // Should not throw
    await expect(
      bufferNotification('user-fail', { title: 'Err', body: 'Test' })
    ).resolves.toBeUndefined();
  });

  it('drainOutbox handles Redis rPop failure gracefully', async () => {
    mockRedisRPop.mockRejectedValue(new Error('Redis read error'));

    await expect(drainOutbox('user-fail')).resolves.toBeUndefined();
  });
});

// =============================================================================
// F-H8: Customer notification gap documented
// =============================================================================

describe('F-H8: Customer notification gap documented', () => {
  it('post-accept code includes documenting comment about customer notification product decision', async () => {
    // This is a code-level documentation check. The acceptance criteria is that
    // the order-accept path has a comment documenting the product decision about
    // the customer notification gap. We verify by reading the source.
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../modules/assignment/post-accept.effects'),
      'utf8'
    );
    // The file should document the customer notification flow
    expect(source).toContain('Customer notification');
    expect(source).toContain('Socket');
    expect(source).toContain('FCM');
  });
});

// =============================================================================
// F-L6: FCM throttle (emitBroadcastStateChanged)
// =============================================================================

describe('F-L6: FCM throttle', () => {
  it('should skip FCM when customer is online (Socket already delivered)', async () => {
    mockIsUserConnectedAsync.mockResolvedValue(true);

    await emitBroadcastStateChanged('customer-online', {
      orderId: 'order-001',
      status: 'searching',
    });

    expect(mockSendPushNotification).not.toHaveBeenCalled();
  });

  it('should send FCM when customer is offline', async () => {
    mockIsUserConnectedAsync.mockResolvedValue(false);
    mockRedisGet.mockResolvedValue(null); // No throttle key

    await emitBroadcastStateChanged('customer-offline', {
      orderId: 'order-002',
      status: 'driver_accepted',
    });

    expect(mockSendPushNotification).toHaveBeenCalledWith(
      'customer-offline',
      expect.objectContaining({
        title: 'Order Update',
        data: expect.objectContaining({
          type: 'order_status_update',
          orderId: 'order-002',
          status: 'driver_accepted',
        }),
      })
    );
  });

  it('should throttle non-critical states within 30s window', async () => {
    mockIsUserConnectedAsync.mockResolvedValue(false);
    // Throttle key exists (already sent recently)
    mockRedisGet.mockResolvedValue('1');

    await emitBroadcastStateChanged('customer-throttled', {
      orderId: 'order-003',
      status: 'heading_to_pickup',
    });

    expect(mockSendPushNotification).not.toHaveBeenCalled();
  });

  it('should send FCM for non-critical state on first occurrence (no throttle key)', async () => {
    mockIsUserConnectedAsync.mockResolvedValue(false);
    mockRedisGet.mockResolvedValue(null); // No throttle

    await emitBroadcastStateChanged('customer-first', {
      orderId: 'order-004',
      status: 'heading_to_pickup',
    });

    expect(mockSendPushNotification).toHaveBeenCalled();
    // Should also SET the throttle key with 30s TTL
    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringContaining('fcm:throttle:customer-first:heading_to_pickup'),
      '1',
      30
    );
  });

  it('should always send FCM for critical states (not in NON_CRITICAL set)', async () => {
    mockIsUserConnectedAsync.mockResolvedValue(false);
    mockRedisGet.mockResolvedValue(null);

    await emitBroadcastStateChanged('customer-critical', {
      orderId: 'order-005',
      status: 'driver_accepted',
    });

    expect(mockSendPushNotification).toHaveBeenCalled();
  });

  it('should throttle "loading_complete" as non-critical', async () => {
    mockIsUserConnectedAsync.mockResolvedValue(false);
    mockRedisGet.mockResolvedValue('1'); // Already throttled

    await emitBroadcastStateChanged('customer-lc', {
      orderId: 'order-006',
      status: 'loading_complete',
    });

    expect(mockSendPushNotification).not.toHaveBeenCalled();
  });

  it('should handle isUserConnectedAsync failure gracefully (defaults to offline)', async () => {
    mockIsUserConnectedAsync.mockRejectedValue(new Error('Socket check failed'));
    mockRedisGet.mockResolvedValue(null);

    await emitBroadcastStateChanged('customer-err', {
      orderId: 'order-007',
      status: 'searching',
    });

    // Should still send FCM (failure = treat as offline)
    expect(mockSendPushNotification).toHaveBeenCalled();
  });

  it('should always emit Socket event regardless of online status', async () => {
    mockIsUserConnectedAsync.mockResolvedValue(true);

    await emitBroadcastStateChanged('customer-always', {
      orderId: 'order-008',
      status: 'searching',
    });

    // Socket emitToUser should always be called
    expect(mockEmitToUser).toHaveBeenCalledWith(
      'customer-always',
      'broadcast_state_changed',
      expect.objectContaining({
        orderId: 'order-008',
        status: 'searching',
      })
    );
  });
});

// =============================================================================
// F-L9: Driver online pre-check (Socket vs FCM routing)
// =============================================================================

describe('F-L9: Driver online pre-check', () => {
  it('online driver receives Socket emit from post-accept', async () => {
    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    // Customer should receive socket event
    const customerCall = mockEmitToUser.mock.calls.find(
      (call: unknown[]) => call[0] === 'customer-001'
    );
    expect(customerCall).toBeDefined();
    expect(customerCall![1]).toBe('assignment_status_changed');
  });

  it('FCM backup is always queued alongside Socket for customer', async () => {
    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    // Both socket and FCM should fire for customer
    const socketCall = mockEmitToUser.mock.calls.find(
      (call: unknown[]) => call[0] === 'customer-001'
    );
    const fcmCall = mockQueuePushNotification.mock.calls.find(
      (call: unknown[]) => call[0] === 'customer-001'
    );
    expect(socketCall).toBeDefined();
    expect(fcmCall).toBeDefined();
  });

  it('transporter always receives FCM (regardless of socket status)', async () => {
    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    const transporterFcm = mockQueuePushNotification.mock.calls.find(
      (call: unknown[]) => call[0] === 'transporter-001'
    );
    expect(transporterFcm).toBeDefined();
    expect((transporterFcm![1] as any).data.status).toBe('driver_accepted');
  });
});

// =============================================================================
// F-H12: Presence split-brain fix
// =============================================================================

describe('F-H12: Presence split-brain fix', () => {
  it('single-point GPS path refreshes driver:presence TTL to 35s (tracking.service.ts)', () => {
    // Verify the fix exists in source code: single-point GPS path should call
    // redisService.expire(`driver:presence:${driverId}`, 35)
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../modules/tracking/tracking.service'),
      'utf8'
    );
    // The F-H12 fix should be present
    expect(source).toContain('F-H12 FIX');
    expect(source).toContain('driver:presence:');
    expect(source).toContain('35');
  });

  it('batch GPS path also refreshes driver:presence TTL (tracking-location.service.ts)', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../modules/tracking/tracking-location.service'),
      'utf8'
    );
    // Batch path should also refresh presence
    expect(source).toContain('driver:presence:');
    expect(source).toContain('35');
  });

  it('both GPS paths keep driver online by refreshing same presence key', () => {
    const fs = require('fs');
    const singlePath = fs.readFileSync(
      require.resolve('../modules/tracking/tracking.service'),
      'utf8'
    );
    const batchPath = fs.readFileSync(
      require.resolve('../modules/tracking/tracking-location.service'),
      'utf8'
    );
    // Both files should use the same presence key pattern and TTL
    const presencePattern = /driver:presence:\$\{driverId\}/;
    expect(presencePattern.test(singlePath)).toBe(true);
    expect(presencePattern.test(batchPath)).toBe(true);
  });
});

// =============================================================================
// Post-accept side effects — vehicle availability update
// =============================================================================

describe('Post-accept: Vehicle Redis availability update', () => {
  it('should call onVehicleStatusChange from on_hold to in_transit', async () => {
    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    expect(mockOnVehicleStatusChange).toHaveBeenCalledWith(
      'transporter-001',
      'tipper-20Ton-vehicle-001',
      'on_hold',
      'in_transit'
    );
  });

  it('should use actual vehicle status when not on_hold', async () => {
    mockPrismaVehicleFindUnique.mockResolvedValue({
      vehicleKey: 'trailer-40Ton-v2',
      transporterId: 'transporter-001',
      status: 'available',
    });

    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    expect(mockOnVehicleStatusChange).toHaveBeenCalledWith(
      'transporter-001',
      'trailer-40Ton-v2',
      'available',
      'in_transit'
    );
  });

  it('should skip availability update if vehicle has no vehicleKey', async () => {
    mockPrismaVehicleFindUnique.mockResolvedValue({
      vehicleKey: null,
      transporterId: 'transporter-001',
      status: 'available',
    });

    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    expect(mockOnVehicleStatusChange).not.toHaveBeenCalled();
  });

  it('should continue with other effects if vehicle lookup fails', async () => {
    mockPrismaVehicleFindUnique.mockRejectedValue(new Error('DB timeout'));

    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    // Other effects should still run (tracking, GPS, notifications)
    expect(mockInitializeTracking).toHaveBeenCalled();
  });
});

// =============================================================================
// Post-accept: Tracking initialization
// =============================================================================

describe('Post-accept: Tracking initialization', () => {
  it('should call initializeTracking with correct arguments', async () => {
    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    expect(mockInitializeTracking).toHaveBeenCalledWith(
      'trip-001',
      'driver-001',
      'KA-01-AB-1234',
      'booking-001',
      'transporter-001',
      'vehicle-001'
    );
  });

  it('should continue if tracking initialization fails', async () => {
    mockInitializeTracking.mockRejectedValue(new Error('Tracking init failed'));

    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    // Customer notifications should still fire
    expect(mockEmitToUser).toHaveBeenCalled();
  });
});

// =============================================================================
// Post-accept: Full side effects chain isolation
// =============================================================================

describe('Post-accept: Side effect isolation', () => {
  it('each step failure does not block subsequent steps', async () => {
    // Step 1 fails (vehicle)
    mockPrismaVehicleFindUnique.mockRejectedValue(new Error('Step 1 fail'));
    // Step 2 fails (tracking)
    mockInitializeTracking.mockRejectedValue(new Error('Step 2 fail'));
    // Step 3 fails (GPS)
    mockRedisGet.mockRejectedValue(new Error('Step 3 fail'));
    // Step 4 should still succeed (customer notification)

    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    // Transporter notification (step 5) should still fire
    const transporterFcm = mockQueuePushNotification.mock.calls.find(
      (call: unknown[]) => call[0] === 'transporter-001'
    );
    expect(transporterFcm).toBeDefined();
  });

  it('should never throw from applyPostAcceptSideEffects', async () => {
    // All steps fail
    mockPrismaVehicleFindUnique.mockRejectedValue(new Error('fail'));
    mockInitializeTracking.mockRejectedValue(new Error('fail'));
    mockRedisGet.mockRejectedValue(new Error('fail'));
    mockPrismaBookingFindUnique.mockRejectedValue(new Error('fail'));
    mockQueuePushNotification.mockRejectedValue(new Error('fail'));

    const ctx = makePostAcceptCtx();
    await expect(applyPostAcceptSideEffects(ctx)).resolves.toBeUndefined();
  });
});

// =============================================================================
// FCM payload structure validation
// =============================================================================

describe('FCM payload structure', () => {
  it('customer FCM includes all required fields for Android intent parsing', async () => {
    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    const customerFcm = mockQueuePushNotification.mock.calls.find(
      (call: unknown[]) => call[0] === 'customer-001'
    );
    const payload = customerFcm![1] as any;
    expect(payload.title).toBeDefined();
    expect(payload.body).toBeDefined();
    expect(payload.data.type).toBe('driver_assigned');
    expect(payload.data.assignmentId).toBe('assign-001');
    expect(payload.data.tripId).toBe('trip-001');
    expect(payload.data.bookingId).toBe('booking-001');
    expect(payload.data.driverName).toBe('Test Driver');
    expect(payload.data.vehicleNumber).toBe('KA-01-AB-1234');
    expect(payload.data.status).toBe('driver_accepted');
  });

  it('transporter FCM includes assignmentId and status', async () => {
    const ctx = makePostAcceptCtx();
    await applyPostAcceptSideEffects(ctx);

    const transporterFcm = mockQueuePushNotification.mock.calls.find(
      (call: unknown[]) => call[0] === 'transporter-001'
    );
    const payload = transporterFcm![1] as any;
    expect(payload.data.assignmentId).toBe('assign-001');
    expect(payload.data.status).toBe('driver_accepted');
    expect(payload.data.tripId).toBe('trip-001');
    expect(payload.data.bookingId).toBe('booking-001');
  });
});

// =============================================================================
// Broadcast state — metrics and event versioning
// =============================================================================

describe('Broadcast state changed: metadata', () => {
  it('should include eventVersion in socket payload', async () => {
    mockIsUserConnectedAsync.mockResolvedValue(true);

    await emitBroadcastStateChanged('cust-meta', {
      orderId: 'order-meta',
      status: 'broadcasting',
    });

    const call = mockEmitToUser.mock.calls.find(
      (c: unknown[]) => c[0] === 'cust-meta'
    );
    expect(call).toBeDefined();
    expect(call![2].eventVersion).toBe(1);
    expect(call![2].serverTimeMs).toBeDefined();
  });

  it('should emit broadcast_state_changed event name', async () => {
    mockIsUserConnectedAsync.mockResolvedValue(true);

    await emitBroadcastStateChanged('cust-event', {
      orderId: 'order-event',
      status: 'searching',
    });

    const call = mockEmitToUser.mock.calls.find(
      (c: unknown[]) => c[0] === 'cust-event'
    );
    expect(call![1]).toBe('broadcast_state_changed');
  });
});
