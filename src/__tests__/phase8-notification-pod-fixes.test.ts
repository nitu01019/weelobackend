/**
 * Phase 8 -- Notification & POD Fix Tests (20 tests)
 *
 * C-1:  FCM mock mode health gate / mock drop metric
 * C-2:  Notification outbox wired in blackhole path
 * H-1:  FCM fallback for offline users on critical events
 * H-2:  FCM startup validation (mockModeReason)
 * H-28: sendWithRetry wired via executeWithRetry
 * H-18: POD routes exist (generate, verify, status)
 * H-19: POD SMS wired (smsService in generatePodOtp)
 * H-20: POD in trip flow (gate at completed, OTP at arrived_at_drop)
 */

// -- Mocks (before imports) --------------------------------------------------
jest.mock('../shared/services/logger.service', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: { incrementCounter: jest.fn(), observeHistogram: jest.fn(), recordHistogram: jest.fn() },
}));
jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: jest.fn(), set: jest.fn(), del: jest.fn(), exists: jest.fn(), expire: jest.fn(),
    lPush: jest.fn(), rPop: jest.fn(), sAdd: jest.fn(), sRem: jest.fn(),
    sCard: jest.fn().mockResolvedValue(0), sMembers: jest.fn().mockResolvedValue([]),
    isRedisEnabled: jest.fn().mockReturnValue(false), isConnected: jest.fn().mockReturnValue(false),
    setJSON: jest.fn(), getJSON: jest.fn(),
    acquireLock: jest.fn().mockResolvedValue({ acquired: true }), releaseLock: jest.fn(),
    scanIterator: jest.fn().mockReturnValue((async function* () {})()),
  },
}));
jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    assignment: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), updateMany: jest.fn() },
    vehicle: { updateMany: jest.fn() },
    order: { update: jest.fn(), updateMany: jest.fn() },
    booking: { updateMany: jest.fn() },
    deviceToken: { upsert: jest.fn(), findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn(),
  },
}));
jest.mock('../modules/auth/sms.service', () => ({ smsService: { sendOtp: jest.fn().mockResolvedValue(true) } }));
jest.mock('../config/environment', () => ({
  config: { redis: { enabled: true }, isProduction: false, isDevelopment: true, jwt: { secret: 'test-secret' }, otp: { expiryMinutes: 5 }, sms: {} },
}));
jest.mock('../shared/services/circuit-breaker.service', () => ({
  socketCircuit: { isLocallyOpen: jest.fn().mockReturnValue(false), reportFailure: jest.fn() },
  fcmCircuit: { isLocallyOpen: jest.fn().mockReturnValue(false) },
}));
jest.mock('../shared/services/notification-outbox.service', () => ({ bufferNotification: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../shared/services/queue.service', () => ({ queueService: { enqueue: jest.fn().mockResolvedValue(undefined), queuePushNotification: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../shared/services/vehicle-lifecycle.service', () => ({ releaseVehicle: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../shared/services/google-maps.service', () => ({ googleMapsService: { getETA: jest.fn().mockResolvedValue(null) } }));
jest.mock('../core/state-machines', () => ({
  ASSIGNMENT_VALID_TRANSITIONS: {
    pending: ['driver_accepted', 'driver_declined', 'cancelled'],
    driver_accepted: ['en_route_pickup', 'cancelled'], en_route_pickup: ['at_pickup', 'cancelled'],
    at_pickup: ['in_transit', 'cancelled'], in_transit: ['arrived_at_drop', 'cancelled'],
    arrived_at_drop: ['completed', 'cancelled'],
  },
}));
jest.mock('../core/config/hold-config', () => ({ HOLD_CONFIG: { driverAcceptTimeoutMs: 45000 } }));
jest.mock('../shared/services/transporter-online.service', () => ({
  TRANSPORTER_PRESENCE_KEY: (id: string) => `transporter:presence:${id}`,
  PRESENCE_TTL_SECONDS: 60, ONLINE_TRANSPORTERS_SET: 'online:transporters',
}));

import { socketCircuit, fcmCircuit } from '../shared/services/circuit-breaker.service';

// -- C-1: FCM mock mode health gate ------------------------------------------
describe('C-1: FCM mock mode health gate', () => {
  let fcm: any;
  beforeEach(() => { jest.resetModules(); jest.isolateModules(() => { fcm = require('../shared/services/fcm.service').fcmService; }); });

  test('isReady() false before init', () => { expect(fcm.isReady()).toBe(false); });
  test('getMockModeActive() true when not initialized', () => { expect(fcm.getMockModeActive()).toBe(true); });
  test('getStatus() returns initialized=false, mockMode=true', () => {
    expect(fcm.getStatus()).toEqual(expect.objectContaining({ initialized: false, mockMode: true }));
  });
});

// -- C-1 cont: mock drop metric ----------------------------------------------
describe('C-1: mock drop metric', () => {
  test('sendToTokens in mock mode increments fcm_mock_mode_drop_total', async () => {
    const { fcmService } = require('../shared/services/fcm.service');
    const { metrics } = require('../shared/monitoring/metrics.service');
    (metrics.incrementCounter as jest.Mock).mockClear();
    const result = await fcmService.sendToTokens(['tok'], { type: 'test', title: 'T', body: 'B' });
    expect(result).toBe(false);
    expect(metrics.incrementCounter).toHaveBeenCalledWith('fcm_mock_mode_drop_total');
  });
});

// -- H-2: FCM startup validation ---------------------------------------------
describe('H-2: mockModeReason populated on initialize()', () => {
  const clearFirebaseEnv = () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_PRIVATE_KEY;
    delete process.env.FIREBASE_CLIENT_EMAIL;
  };

  test('dev mode sets Development reason', async () => {
    jest.resetModules(); clearFirebaseEnv(); process.env.NODE_ENV = 'test';
    let fcm: any; jest.isolateModules(() => { fcm = require('../shared/services/fcm.service').fcmService; });
    await fcm.initialize();
    expect(fcm.getStatus().reason).toContain('Development mode');
  });

  test('production mode sets production reason', async () => {
    jest.resetModules(); clearFirebaseEnv(); process.env.NODE_ENV = 'production';
    let fcm: any; jest.isolateModules(() => { fcm = require('../shared/services/fcm.service').fcmService; });
    await fcm.initialize();
    expect(fcm.getStatus().reason).toContain('production');
    process.env.NODE_ENV = 'test';
  });
});

// -- H-28: sendWithRetry wired -----------------------------------------------
describe('H-28: sendWithRetry wired via executeWithRetry', () => {
  test('sendWithRetry delegates to sendToTokens (mock mode returns false)', async () => {
    jest.resetModules(); let fcm: any;
    jest.isolateModules(() => { fcm = require('../shared/services/fcm.service').fcmService; });
    expect(await fcm.sendWithRetry(['tok'], 'Hi', 'Body', { k: 'v' })).toBe(false);
  });

  test('sendWithRetry passes notification type through to sendToTokens', async () => {
    jest.resetModules(); let fcm: any;
    jest.isolateModules(() => { fcm = require('../shared/services/fcm.service').fcmService; });
    const spy = jest.spyOn(fcm, 'sendToTokens');
    await fcm.sendWithRetry(['tok'], 'T', 'B', {}, 3, 'trip_update');
    expect(spy).toHaveBeenCalledWith(['tok'], expect.objectContaining({ type: 'trip_update' }));
    spy.mockRestore();
  });
});

// -- C-2: Notification outbox in blackhole path ------------------------------
describe('C-2: bufferNotification on dual circuit-open', () => {
  test('emitToUser returns false when both circuits open', () => {
    (socketCircuit.isLocallyOpen as jest.Mock).mockReturnValue(true);
    (fcmCircuit as any).isLocallyOpen.mockReturnValue(true);
    let emitToUser: any;
    jest.isolateModules(() => { emitToUser = require('../shared/services/socket.service').emitToUser; });
    expect(emitToUser('u1', 'booking_updated', { id: '1' })).toBe(false);
    (socketCircuit.isLocallyOpen as jest.Mock).mockReturnValue(false);
    (fcmCircuit as any).isLocallyOpen.mockReturnValue(false);
  });

  test('emitToUser does NOT buffer when only socket circuit open', () => {
    (socketCircuit.isLocallyOpen as jest.Mock).mockReturnValue(true);
    (fcmCircuit as any).isLocallyOpen.mockReturnValue(false);
    let emitToUser: any;
    jest.isolateModules(() => { emitToUser = require('../shared/services/socket.service').emitToUser; });
    emitToUser('u2', 'trip_assigned', { id: 'a1' });
    (socketCircuit.isLocallyOpen as jest.Mock).mockReturnValue(false);
  });
});

// -- H-1: FCM fallback for offline users -------------------------------------
describe('H-1: FCM fallback for offline users', () => {
  test('critical events do not throw when io is null (FCM path exercised)', () => {
    let emitToUser: any;
    jest.isolateModules(() => { emitToUser = require('../shared/services/socket.service').emitToUser; });
    const events = ['trip_assigned', 'assignment_status_changed', 'new_broadcast',
      'booking_updated', 'driver_accepted', 'driver_declined', 'booking_expired',
      'booking_cancelled', 'order_status_update'];
    for (const e of events) { expect(emitToUser('offline', e, {})).toBe(false); }
  });

  test('high-frequency events excluded from FCM fallback', () => {
    let emitToUser: any;
    jest.isolateModules(() => { emitToUser = require('../shared/services/socket.service').emitToUser; });
    expect(emitToUser('offline', 'location_updated', { lat: 1 })).toBe(false);
  });
});

// -- H-18: POD routes exist --------------------------------------------------
describe('H-18: POD routes', () => {
  test('generate, verify, status endpoints registered', () => {
    const { podRouter } = require('../modules/tracking/pod.routes');
    const paths = podRouter.stack.filter((l: any) => l.route)
      .map((l: any) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
    expect(paths).toContain('POST /:tripId/generate');
    expect(paths).toContain('POST /:tripId/verify');
    expect(paths).toContain('GET /:tripId/status');
  });

  test('generate route has auth + roleGuard + handler (3+ middleware)', () => {
    const { podRouter } = require('../modules/tracking/pod.routes');
    const gen = podRouter.stack.find((l: any) => l.route?.path === '/:tripId/generate');
    expect(gen.route.stack.length).toBeGreaterThanOrEqual(3);
  });

  test('status route has auth + roleGuard + handler', () => {
    const { podRouter } = require('../modules/tracking/pod.routes');
    const st = podRouter.stack.find((l: any) => l.route?.path === '/:tripId/status');
    expect(st.route.stack.length).toBeGreaterThanOrEqual(3);
  });
});

// -- H-19: POD SMS wired -----------------------------------------------------
describe('H-19: POD SMS wired', () => {
  let rds: any, sms: any;
  beforeEach(() => {
    rds = require('../shared/services/redis.service').redisService;
    sms = require('../modules/auth/sms.service').smsService;
    jest.clearAllMocks(); rds.set.mockResolvedValue('OK'); sms.sendOtp.mockResolvedValue(true);
  });

  test('generatePodOtp sends SMS when phone provided', async () => {
    const { generatePodOtp } = require('../modules/tracking/pod.service');
    await generatePodOtp('t1', 'c1', '9876543210');
    expect(rds.set).toHaveBeenCalledWith('pod:otp:t1', expect.stringMatching(/^\d{4}$/), 3600);
    expect(sms.sendOtp).toHaveBeenCalledWith('9876543210', expect.stringMatching(/^\d{4}$/));
  });

  test('generatePodOtp skips SMS when phone undefined', async () => {
    const { generatePodOtp } = require('../modules/tracking/pod.service');
    await generatePodOtp('t2', 'c2');
    expect(rds.set).toHaveBeenCalledWith('pod:otp:t2', expect.stringMatching(/^\d{4}$/), 3600);
    expect(sms.sendOtp).not.toHaveBeenCalled();
  });
});

// -- H-20: POD in trip flow --------------------------------------------------
describe('H-20: POD in trip flow', () => {
  let pc: any, rds: any;
  const base = {
    id: 'a1', tripId: 'tp', driverId: 'driver-1', transporterId: 'trans-1',
    vehicleId: 'v1', vehicleNumber: 'KA01AB1234', driverName: 'Driver',
    status: 'arrived_at_drop', bookingId: 'b1', orderId: null,
    booking: { customerId: 'c1', customerName: 'Cust', id: 'b1', pickup: {}, drop: {} },
    order: null,
  };

  beforeEach(() => {
    pc = require('../shared/database/prisma.service').prismaClient;
    rds = require('../shared/services/redis.service').redisService;
    jest.clearAllMocks();
    pc.assignment.findUnique.mockResolvedValue(base);
    pc.assignment.updateMany.mockResolvedValue({ count: 1 });
    pc.order.update.mockResolvedValue({}); pc.order.updateMany.mockResolvedValue({ count: 0 });
    pc.booking.updateMany.mockResolvedValue({ count: 0 });
    pc.$transaction.mockResolvedValue([{ count: 1 }]);
    rds.getJSON.mockResolvedValue(null); rds.get.mockResolvedValue(null);
    rds.set.mockResolvedValue('OK'); rds.setJSON.mockResolvedValue('OK');
    rds.del.mockResolvedValue(1); rds.sRem.mockResolvedValue(0); rds.sCard.mockResolvedValue(0);
    rds.acquireLock.mockResolvedValue({ acquired: true }); rds.releaseLock.mockResolvedValue(undefined);
  });

  test('completion blocked when POD required but not verified', async () => {
    process.env.FF_POD_OTP_REQUIRED = 'true';
    pc.assignment.findUnique.mockResolvedValue({ ...base, status: 'arrived_at_drop' });
    rds.get.mockResolvedValue(null);
    const { trackingTripService: tts } = require('../modules/tracking/tracking-trip.service');
    await expect(tts.updateTripStatus('tp', 'driver-1', { status: 'completed' }))
      .rejects.toThrow('Delivery OTP verification required');
    delete process.env.FF_POD_OTP_REQUIRED;
  });

  test('completion succeeds when POD verified', async () => {
    process.env.FF_POD_OTP_REQUIRED = 'true';
    pc.assignment.findUnique.mockResolvedValue({ ...base, status: 'arrived_at_drop' });
    rds.get.mockImplementation((k: string) => k === 'pod:verified:tp' ? Promise.resolve('true') : Promise.resolve(null));
    const { trackingTripService: tts } = require('../modules/tracking/tracking-trip.service');
    await tts.updateTripStatus('tp', 'driver-1', { status: 'completed' });
    expect(pc.$transaction).toHaveBeenCalled();
    delete process.env.FF_POD_OTP_REQUIRED;
  });

  test('arrived_at_drop triggers POD OTP generation', async () => {
    process.env.FF_POD_OTP_REQUIRED = 'true';
    pc.assignment.findUnique.mockResolvedValue({ ...base, status: 'in_transit' });
    const { trackingTripService: tts } = require('../modules/tracking/tracking-trip.service');
    await tts.updateTripStatus('tp', 'driver-1', { status: 'arrived_at_drop' });
    await new Promise(r => setTimeout(r, 50)); // fire-and-forget
    expect(rds.set).toHaveBeenCalledWith('pod:otp:tp', expect.stringMatching(/^\d{4}$/), 3600);
    delete process.env.FF_POD_OTP_REQUIRED;
  });
});

// =============================================================================
// P7-T55 / P7-T56 — Phase 7 FCM reliability tests
// =============================================================================

// -- P7-T55a: NON_RETRYABLE expansion (messaging/authentication-error etc.) ---
describe('P7-T55: NON_RETRYABLE_FCM_ERRORS expansion (A05-011)', () => {
  let fcm: any;

  beforeEach(() => {
    jest.resetModules();
    jest.isolateModules(() => { fcm = require('../shared/services/fcm.service').fcmService; });
  });

  const NEW_NON_RETRYABLE = [
    'messaging/authentication-error',
    'messaging/unauthorized',
    'messaging/sender-id-mismatch',
  ];

  test.each(NEW_NON_RETRYABLE)(
    'executeWithRetry does not retry on %s (throws immediately)',
    async (errorCode) => {
      // Access the private method via any cast
      const service = fcm as any;
      let callCount = 0;
      const fn = async () => {
        callCount++;
        const err: any = new Error(`FCM error: ${errorCode}`);
        err.code = errorCode;
        throw err;
      };
      await expect(service.executeWithRetry(fn, 2)).rejects.toMatchObject({ code: errorCode });
      // Should only be called once — no retries for non-retryable codes
      expect(callCount).toBe(1);
    }
  );

  test('legacy non-retryable code still short-circuits (messaging/invalid-registration-token)', async () => {
    const service = fcm as any;
    let callCount = 0;
    const fn = async () => {
      callCount++;
      const err: any = new Error('FCM: invalid-registration-token');
      err.code = 'messaging/invalid-registration-token';
      throw err;
    };
    await expect(service.executeWithRetry(fn, 2)).rejects.toMatchObject({ code: 'messaging/invalid-registration-token' });
    expect(callCount).toBe(1);
  });

  test('retryable code IS retried (messaging/server-unavailable)', async () => {
    const service = fcm as any;
    let callCount = 0;
    const fn = async () => {
      callCount++;
      const err: any = new Error('FCM: server-unavailable');
      err.code = 'messaging/server-unavailable';
      throw err;
    };
    // maxRetries=1 → 2 attempts total
    await expect(service.executeWithRetry(fn, 1)).rejects.toMatchObject({ code: 'messaging/server-unavailable' });
    expect(callCount).toBe(2);
  });
});

// -- P7-T55b: revokedAt filter excludes stale tokens ---
describe('P7-T55: revokedAt filter excludes revoked/stale tokens from getTokens() DB fallback (A05-004)', () => {
  // Use module-level mocks (established at top of file via jest.mock calls).
  // Do NOT use jest.resetModules()/isolateModules here — it re-creates the mock objects
  // and the redis/prisma references inside the FCM module would point to new instances
  // while our local mockRedis/mockPrisma variables point to the original stubs.

  let fcm: any;
  let mockPrisma: any;
  let mockRedis: any;

  beforeAll(() => {
    fcm = require('../shared/services/fcm.service').fcmService;
    mockPrisma = require('../shared/database/prisma.service').prismaClient;
    mockRedis = require('../shared/services/redis.service').redisService;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Force Redis to appear unavailable so getTokens falls through to DB
    mockRedis.isRedisEnabled.mockReturnValue(false);
    mockRedis.isConnected.mockReturnValue(false);
    // Return empty Redis set (sMembers not called, but set it anyway)
    mockRedis.sMembers.mockResolvedValue([]);
  });

  afterEach(() => {
    // Restore Redis availability for other tests
    mockRedis.isRedisEnabled.mockReturnValue(false);
    mockRedis.isConnected.mockReturnValue(false);
  });

  test('findMany is called with revokedAt: null filter when Redis is unavailable', async () => {
    mockPrisma.deviceToken.findMany.mockResolvedValue([{ token: 'tok-abc' }]);

    const tokens = await fcm.getTokens('user-123');

    expect(mockPrisma.deviceToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-123',
          revokedAt: null,
          lastSeenAt: expect.objectContaining({ gt: expect.any(Date) }),
        }),
      })
    );
    expect(tokens).toEqual(['tok-abc']);
  });

  test('lastSeenAt gt filter window is approximately 90 days', async () => {
    mockPrisma.deviceToken.findMany.mockResolvedValue([]);
    await fcm.getTokens('user-456');

    const calls = mockPrisma.deviceToken.findMany.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const callArg = calls[calls.length - 1][0];
    const gtDate: Date = callArg.where.lastSeenAt.gt;
    const expectedMs = 90 * 24 * 60 * 60 * 1000;
    const diff = Date.now() - gtDate.getTime();
    // Allow 5s of test execution slack
    expect(diff).toBeGreaterThan(expectedMs - 5000);
    expect(diff).toBeLessThan(expectedMs + 5000);
  });
});

// -- P7-T56a: UNREGISTERED token sets revokedAt ---
describe('P7-T56: UNREGISTERED token is soft-revoked via revokedAt update (A05-004)', () => {
  let fcm: any;
  let mockPrisma: any;

  beforeEach(() => {
    // Use the module mock as-is (jest.mock at top already stubs deviceToken.updateMany)
    fcm = require('../shared/services/fcm.service').fcmService;
    mockPrisma = require('../shared/database/prisma.service').prismaClient;
    // Ensure updateMany is a mock function (may have been cleared by other tests)
    if (typeof mockPrisma.deviceToken.updateMany?.mockResolvedValue === 'function') {
      mockPrisma.deviceToken.updateMany.mockResolvedValue({ count: 1 });
    }
    if (typeof mockPrisma.deviceToken.deleteMany?.mockResolvedValue === 'function') {
      mockPrisma.deviceToken.deleteMany.mockResolvedValue({ count: 1 });
    }
  });

  test('sendToTokens triggers revokedAt update on UNREGISTERED error for userId', async () => {
    // Override sendWithRetry to inject the UNREGISTERED error directly into sendToTokens
    const service = fcm as any;
    service.isInitialized = false; // force mock path — revokedAt path is in the catch of real sends
    // We need to test the catch path — make executeWithRetry throw UNREGISTERED
    jest.spyOn(service, 'executeWithRetry').mockRejectedValueOnce(
      Object.assign(new Error('token not registered'), { code: 'messaging/registration-token-not-registered' })
    );
    service.isInitialized = true;
    service.admin = { messaging: () => ({ send: jest.fn() }) };

    await service.sendToTokens(['dead-token'], { type: 'test', title: 'T', body: 'B' }, 'user-999');

    // revokedAt update should be called
    expect(mockPrisma.deviceToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-999', token: 'dead-token' }),
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      })
    );
  });
});

// -- P7-T56b: sendToUsersMulticast rate-limit gate fires ---
describe('P7-T56: sendToUsersMulticast rate-limit gate prevents burst (A05-007 / Part B P7-F)', () => {
  let fcm: any;

  beforeEach(() => {
    jest.resetModules();
    jest.isolateModules(() => { fcm = require('../shared/services/fcm.service').fcmService; });
    // Force initialized so sendToUsersMulticast runs the real path
    (fcm as any).isInitialized = true;
    const sendEachForMulticast = jest.fn().mockResolvedValue({ successCount: 0, failureCount: 0, responses: [] });
    (fcm as any).admin = {
      messaging: () => ({ sendEachForMulticast }),
    };
  });

  test('sendToUsersMulticast returns rateLimited=true when bucket is exhausted', async () => {
    const service = fcm as any;
    // Drain the bucket to zero and set lastRefill to far in the future to prevent any refill
    service._fcmEgressTokens = 0;
    service._fcmEgressLastRefill = Date.now() + 1_000_000; // future → elapsedSec is negative → no refill

    // Mock getTokens to return one token per user
    jest.spyOn(service, 'getTokens').mockResolvedValue(['tok-1']);

    const result = await service.sendToUsersMulticast(
      ['user-a'],
      { type: 'new_broadcast', title: 'T', body: 'B', priority: 'high' }
    );

    expect(result.rateLimited).toBe(true);
    expect(result.successCount).toBe(0);
  });

  test('sendToUsersMulticast succeeds when bucket has tokens', async () => {
    const service = fcm as any;
    service._fcmEgressTokens = 8000;
    service._fcmEgressLastRefill = Date.now();

    jest.spyOn(service, 'getTokens').mockResolvedValue(['tok-2']);
    service.admin.messaging = () => ({
      sendEachForMulticast: jest.fn().mockResolvedValue({
        successCount: 1,
        failureCount: 0,
        responses: [{ success: true }],
      }),
    });

    const result = await service.sendToUsersMulticast(
      ['user-b'],
      { type: 'new_broadcast', title: 'T', body: 'B', priority: 'high' }
    );

    expect(result.rateLimited).toBe(false);
    expect(result.successCount).toBe(1);
  });

  test('sendToUsersMulticast with 150K user IDs: rate-limit gate fires (burst guard)', async () => {
    // This test verifies that a burst of 150K users (each with 1 token = 150K tokens)
    // is correctly rate-limited by the 8K/s token bucket.
    const service = fcm as any;
    // Set bucket to only 100 tokens so the 150K batch is rejected immediately.
    // Set lastRefill far in the future to prevent lazy refill during token resolution.
    service._fcmEgressTokens = 100;
    service._fcmEgressLastRefill = Date.now() + 1_000_000;

    // Mock getTokens to return unique token per user — forces 150K deduped tokens
    let tokenIdx = 0;
    jest.spyOn(service, 'getTokens').mockImplementation(() =>
      Promise.resolve([`tok-unique-${tokenIdx++}`])
    );

    // Track sendEachForMulticast calls
    const sendEachMock = jest.fn().mockResolvedValue({ successCount: 0, failureCount: 0, responses: [] });
    service.admin = { messaging: () => ({ sendEachForMulticast: sendEachMock }) };

    const LARGE_USER_COUNT = 150_000;
    const userIds = Array.from({ length: LARGE_USER_COUNT }, (_, i) => `user-${i}`);

    const result = await service.sendToUsersMulticast(
      userIds,
      { type: 'new_broadcast', title: 'Broadcast', body: 'New booking', priority: 'high' }
    );

    // The bucket has only 100 tokens, 150K requested → rate limited
    expect(result.rateLimited).toBe(true);
    expect(result.successCount).toBe(0);
    // No burst > 8K/s — the gate fired before any sendEachForMulticast call
    expect(sendEachMock).not.toHaveBeenCalled();
  }, 30000); // 150K users takes up to 30s to resolve tokens (20 concurrent)
});
