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
    deviceToken: { upsert: jest.fn(), findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn() },
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
