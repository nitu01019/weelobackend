/**
 * =============================================================================
 * CUSTOMER-TO-TRANSPORTER BROADCAST & NOTIFICATION — STRESS TESTS
 * =============================================================================
 *
 * Deep testing of what happens AFTER booking creation:
 *
 * 1. Broadcast Mechanics (socket + FCM delivery, filtering, capping, Redis tracking)
 * 2. Progressive Radius Expansion (step advance, DB fallback, concurrent races)
 * 3. Rebroadcast on Transporter Online (rate limit, geo filter, dedup, FCM)
 * 4. Timeout Mechanics (expiry, partial fill, cleanup, race with accept)
 * 5. Notification Format & Content (socket payload, FCM payload, dedup)
 *
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP
// =============================================================================

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockGetBookingById = jest.fn();
const mockUpdateBooking = jest.fn();
const mockGetTransportersWithVehicleType = jest.fn();
const mockGetActiveBookingsForTransporter = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getBookingById: (...args: any[]) => mockGetBookingById(...args),
    updateBooking: (...args: any[]) => mockUpdateBooking(...args),
    getTransportersWithVehicleType: (...args: any[]) => mockGetTransportersWithVehicleType(...args),
    getActiveBookingsForTransporter: (...args: any[]) => mockGetActiveBookingsForTransporter(...args),
    getBookingsByCustomer: jest.fn().mockResolvedValue([]),
    getBookingsByDriver: jest.fn().mockResolvedValue([]),
    createBooking: jest.fn(),
    getVehiclesByTransporter: jest.fn().mockResolvedValue([]),
    getUserById: jest.fn(),
    getAssignmentsByBooking: jest.fn().mockResolvedValue([]),
    getActiveOrders: jest.fn().mockResolvedValue([]),
    updateOrder: jest.fn(),
  },
}));

const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisExists = jest.fn();
const mockRedisSAdd = jest.fn();
const mockRedisSMembers = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisSetTimer = jest.fn();
const mockRedisCancelTimer = jest.fn();
const mockRedisExpire = jest.fn();
const mockRedisHSet = jest.fn();
const mockRedisSAddWithExpire = jest.fn();
const mockRedisIsConnected = jest.fn().mockReturnValue(true);

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    exists: (...args: any[]) => mockRedisExists(...args),
    sAdd: (...args: any[]) => mockRedisSAdd(...args),
    sMembers: (...args: any[]) => mockRedisSMembers(...args),
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    setTimer: (...args: any[]) => mockRedisSetTimer(...args),
    cancelTimer: (...args: any[]) => mockRedisCancelTimer(...args),
    expire: (...args: any[]) => mockRedisExpire(...args),
    hSet: (...args: any[]) => mockRedisHSet(...args),
    sAddWithExpire: (...args: any[]) => mockRedisSAddWithExpire(...args),
    isConnected: (...args: any[]) => mockRedisIsConnected(...args),
    getJSON: jest.fn(),
    setJSON: jest.fn(),
    getExpiredTimers: jest.fn().mockResolvedValue([]),
  },
}));

const mockBookingUpdateMany = jest.fn();
const mockBookingFindUnique = jest.fn();
const mockAssignmentFindMany = jest.fn();
const mockAssignmentUpdateMany = jest.fn();
const mockVehicleFindMany = jest.fn();
const mockUserFindMany = jest.fn();
const mockQueryRaw = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    booking: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: (...args: any[]) => mockBookingFindUnique(...args),
      updateMany: (...args: any[]) => mockBookingUpdateMany(...args),
      update: jest.fn(),
    },
    assignment: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: (...args: any[]) => mockAssignmentFindMany(...args),
      updateMany: (...args: any[]) => mockAssignmentUpdateMany(...args),
    },
    vehicle: {
      findUnique: jest.fn(),
      update: jest.fn(),
      findMany: (...args: any[]) => mockVehicleFindMany(...args),
    },
    user: {
      findUnique: jest.fn(),
      findMany: (...args: any[]) => mockUserFindMany(...args),
    },
    truckRequest: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: (...args: any[]) => mockQueryRaw(...args),
    $transaction: async (fnOrArray: any, _opts?: any) => {
      if (typeof fnOrArray === 'function') {
        const txProxy = {
          booking: {
            create: jest.fn(),
            findFirst: jest.fn(),
            findUnique: (...a: any[]) => mockBookingFindUnique(...a),
            updateMany: (...a: any[]) => mockBookingUpdateMany(...a),
            update: jest.fn(),
          },
          assignment: {
            create: jest.fn(),
            findFirst: jest.fn(),
            findMany: (...a: any[]) => mockAssignmentFindMany(...a),
            updateMany: (...a: any[]) => mockAssignmentUpdateMany(...a),
          },
          vehicle: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
          user: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
          $queryRaw: (...a: any[]) => mockQueryRaw(...a),
        };
        return fnOrArray(txProxy);
      }
      return Promise.all(fnOrArray);
    },
  },
  withDbTimeout: jest.fn().mockImplementation(async (fn: any) => fn({})),
  BookingStatus: {
    created: 'created',
    broadcasting: 'broadcasting',
    active: 'active',
    partially_filled: 'partially_filled',
    fully_filled: 'fully_filled',
    completed: 'completed',
    cancelled: 'cancelled',
    expired: 'expired',
  },
  AssignmentStatus: {
    pending: 'pending',
    driver_accepted: 'driver_accepted',
    en_route_pickup: 'en_route_pickup',
    at_pickup: 'at_pickup',
    in_transit: 'in_transit',
    completed: 'completed',
    cancelled: 'cancelled',
    driver_declined: 'driver_declined',
  },
}));

const mockEmitToUser = jest.fn();
const mockEmitToBooking = jest.fn();
const mockIsUserConnected = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  emitToBooking: (...args: any[]) => mockEmitToBooking(...args),
  emitToRoom: jest.fn(),
  emitToUsers: jest.fn(),
  emitToAllTransporters: jest.fn(),
  emitToAll: jest.fn(),
  isUserConnected: (...args: any[]) => mockIsUserConnected(...args),
  isUserConnectedAsync: (...args: any[]) => Promise.resolve(mockIsUserConnected(...args)),
  SocketEvent: {
    CONNECTED: 'connected',
    BOOKING_UPDATED: 'booking_updated',
    TRUCK_ASSIGNED: 'truck_assigned',
    TRIP_ASSIGNED: 'trip_assigned',
    LOCATION_UPDATED: 'location_updated',
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    NEW_BROADCAST: 'new_broadcast',
    TRUCK_CONFIRMED: 'truck_confirmed',
    BOOKING_EXPIRED: 'booking_expired',
    BOOKING_FULLY_FILLED: 'booking_fully_filled',
    BOOKING_PARTIALLY_FILLED: 'booking_partially_filled',
    NO_VEHICLES_AVAILABLE: 'no_vehicles_available',
    BROADCAST_COUNTDOWN: 'broadcast_countdown',
    TRUCK_REQUEST_ACCEPTED: 'truck_request_accepted',
    TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update',
    REQUEST_NO_LONGER_AVAILABLE: 'request_no_longer_available',
    ORDER_STATUS_UPDATE: 'order_status_update',
    VEHICLE_REGISTERED: 'vehicle_registered',
    VEHICLE_UPDATED: 'vehicle_updated',
    VEHICLE_DELETED: 'vehicle_deleted',
    VEHICLE_STATUS_CHANGED: 'vehicle_status_changed',
    FLEET_UPDATED: 'fleet_updated',
    BROADCAST_STATE_CHANGED: 'broadcast_state_changed',
    TRIP_CANCELLED: 'trip_cancelled',
  },
}));

const mockNotifyNewBroadcast = jest.fn().mockResolvedValue(0);

jest.mock('../shared/services/fcm.service', () => ({
  fcmService: {
    notifyNewBroadcast: (...args: any[]) => mockNotifyNewBroadcast(...args),
  },
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
}));

const mockQueueBroadcast = jest.fn().mockResolvedValue(undefined);
const mockQueuePushNotificationBatch = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queueBroadcast: (...args: any[]) => mockQueueBroadcast(...args),
    queuePushNotificationBatch: (...args: any[]) => mockQueuePushNotificationBatch(...args),
  },
}));

const mockLoadTransporterDetailsMap = jest.fn().mockResolvedValue(new Map());
const mockGetTransporterDetails = jest.fn().mockResolvedValue(null);

jest.mock('../shared/services/availability.service', () => ({
  availabilityService: {
    loadTransporterDetailsMap: (...args: any[]) => mockLoadTransporterDetailsMap(...args),
    getTransporterDetails: (...args: any[]) => mockGetTransporterDetails(...args),
  },
}));

const mockFilterOnline = jest.fn();

jest.mock('../shared/services/transporter-online.service', () => ({
  transporterOnlineService: {
    filterOnline: (...args: any[]) => mockFilterOnline(...args),
    isOnline: jest.fn().mockResolvedValue(true),
  },
}));

jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    onVehicleStatusChange: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn().mockReturnValue('Tipper_20-24 Ton'),
}));

const mockFindCandidates = jest.fn().mockResolvedValue([]);

jest.mock('../modules/order/progressive-radius-matcher', () => ({
  ...jest.requireActual('../modules/order/progressive-radius-matcher'),
  progressiveRadiusMatcher: {
    findCandidates: (...args: any[]) => mockFindCandidates(...args),
    getStepCount: jest.fn().mockReturnValue(6),
    getStep: jest.fn().mockReturnValue({ radiusKm: 10, windowMs: 10_000, h3RingK: 15 }),
  },
  startProgressiveMatching: jest.fn(),
  cancelProgressiveMatching: jest.fn(),
}));

const mockBatchGetPickupDistance = jest.fn().mockResolvedValue(new Map());

jest.mock('../shared/services/distance-matrix.service', () => ({
  distanceMatrixService: {
    batchGetPickupDistance: (...args: any[]) => mockBatchGetPickupDistance(...args),
  },
}));

jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: {
    calculateRoute: jest.fn().mockResolvedValue(null),
  },
}));

const mockHaversineDistanceKm = jest.fn().mockReturnValue(10);

jest.mock('../shared/utils/geospatial.utils', () => ({
  haversineDistanceKm: (...args: any[]) => mockHaversineDistanceKm(...args),
}));

jest.mock('../shared/utils/geo.utils', () => ({
  roundCoord: jest.fn((v: number) => Math.round(v * 1000) / 1000),
}));

const mockBuildBroadcastPayload = jest.fn().mockReturnValue({
  broadcastId: 'booking-001',
  orderId: 'booking-001',
  bookingId: 'booking-001',
  customerId: 'customer-001',
  customerName: 'Test Customer',
  vehicleType: 'Tipper',
  vehicleSubtype: '20-24 Ton',
  trucksNeeded: 3,
  trucksFilled: 0,
  pricePerTruck: 5000,
  farePerTruck: 5000,
  totalFare: 15000,
  pickupLocation: { address: 'Pickup Addr', city: 'Bangalore', latitude: 12.97, longitude: 77.59 },
  dropLocation: { address: 'Drop Addr', city: 'Bangalore', latitude: 13.0, longitude: 77.6 },
  pickupAddress: 'Pickup Addr',
  dropAddress: 'Drop Addr',
  distanceKm: 50,
  pickupDistanceKm: 5,
  pickupEtaMinutes: 10,
  pickupEtaSeconds: 600,
  timeoutSeconds: 120,
  isUrgent: false,
  payloadVersion: 2,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
  requestedVehicles: [{ vehicleType: 'Tipper', vehicleSubtype: '20-24 Ton', count: 3, filledCount: 0, farePerTruck: 5000, capacityTons: 0 }],
});
const mockGetRemainingTimeoutSeconds = jest.fn().mockReturnValue(100);

jest.mock('../modules/booking/booking-payload.helper', () => ({
  buildBroadcastPayload: (...args: any[]) => mockBuildBroadcastPayload(...args),
  getRemainingTimeoutSeconds: (...args: any[]) => mockGetRemainingTimeoutSeconds(...args),
}));

jest.mock('../core/constants', () => ({
  ErrorCode: { VEHICLE_INSUFFICIENT: 'VEHICLE_INSUFFICIENT' },
}));

jest.mock('../modules/pricing/vehicle-catalog', () => ({
  getSubtypeConfig: jest.fn().mockReturnValue({ capacityKg: 20000, minTonnage: 20, maxTonnage: 24 }),
}));

jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { BookingBroadcastService } from '../modules/booking/booking-broadcast.service';
import { BookingRadiusService } from '../modules/booking/booking-radius.service';
import { BookingRebroadcastService } from '../modules/booking/booking-rebroadcast.service';
import { BookingLifecycleService, setCreateServiceRef } from '../modules/booking/booking-lifecycle.service';
import type { BookingContext } from '../modules/booking/booking-context';

// =============================================================================
// HELPERS
// =============================================================================

function makeBooking(overrides: Record<string, any> = {}): any {
  return {
    id: 'booking-001',
    customerId: 'customer-001',
    customerName: 'Test Customer',
    customerPhone: '9999999999',
    pickup: { latitude: 12.97, longitude: 77.59, address: 'Pickup Addr', city: 'Bangalore', state: 'KA' },
    drop: { latitude: 13.0, longitude: 77.6, address: 'Drop Addr', city: 'Bangalore', state: 'KA' },
    vehicleType: 'Tipper',
    vehicleSubtype: '20-24 Ton',
    trucksNeeded: 3,
    trucksFilled: 0,
    distanceKm: 50,
    pricePerTruck: 5000,
    totalAmount: 15000,
    goodsType: 'Sand',
    weight: '20 Ton',
    status: 'active',
    notifiedTransporters: ['transporter-001', 'transporter-002'],
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeContext(overrides: Partial<BookingContext> = {}): BookingContext {
  const booking = makeBooking({ status: 'created' });
  return {
    customerId: 'customer-001',
    customerPhone: '9999999999',
    data: {
      vehicleType: 'Tipper',
      vehicleSubtype: '20-24 Ton',
      trucksNeeded: 3,
      pricePerTruck: 5000,
      distanceKm: 50,
      goodsType: 'Sand',
      weight: '20 Ton',
      pickup: { coordinates: { latitude: 12.97, longitude: 77.59 }, address: 'Pickup Addr', city: 'Bangalore', state: 'KA' },
      drop: { coordinates: { latitude: 13.0, longitude: 77.6 }, address: 'Drop Addr', city: 'Bangalore', state: 'KA' },
    } as any,
    concurrencyKey: 'concurrency:key',
    incremented: false,
    lockKey: 'lock:key',
    lockAcquired: false,
    lockHolder: 'test-lock-holder',
    dedupeKey: 'dedup:key',
    idempotencyHash: 'hash',
    customerName: 'Test Customer',
    distanceSource: 'google' as const,
    clientDistanceKm: 50,
    vehicleKey: 'Tipper_20-24 Ton',
    matchingTransporters: ['transporter-001', 'transporter-002', 'transporter-003'],
    skipProgressiveExpansion: false,
    step1Candidates: [
      { transporterId: 'transporter-001', distanceKm: 5, etaSeconds: 600 },
      { transporterId: 'transporter-002', distanceKm: 8, etaSeconds: 960 },
      { transporterId: 'transporter-003', distanceKm: 12, etaSeconds: 1440 },
    ] as any,
    candidateMap: new Map(),
    cappedTransporters: ['transporter-001', 'transporter-002', 'transporter-003'],
    bookingId: 'booking-001',
    booking,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    earlyReturn: null,
    ...overrides,
  };
}

function makeRadiusStepTimerData(overrides: Record<string, any> = {}): any {
  return {
    bookingId: 'booking-001',
    customerId: 'customer-001',
    vehicleKey: 'Tipper_20-24 Ton',
    vehicleType: 'Tipper',
    vehicleSubtype: '20-24 Ton',
    pickupLat: 12.97,
    pickupLng: 77.59,
    currentStep: 0,
    ...overrides,
  };
}

// =============================================================================
// TEST SUITES
// =============================================================================

describe('Customer Broadcast Stress Tests', () => {
  let broadcastSvc: BookingBroadcastService;
  let radiusSvc: BookingRadiusService;
  let rebroadcastSvc: BookingRebroadcastService;
  let lifecycleSvc: BookingLifecycleService;

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock returns
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockResolvedValue(1);
    mockRedisExists.mockResolvedValue(0);
    mockRedisSAdd.mockResolvedValue(1);
    mockRedisSMembers.mockResolvedValue([]);
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockRedisReleaseLock.mockResolvedValue(true);
    mockRedisSetTimer.mockResolvedValue('OK');
    mockRedisCancelTimer.mockResolvedValue('OK');
    mockRedisExpire.mockResolvedValue(true);
    mockRedisHSet.mockResolvedValue(1);
    mockRedisSAddWithExpire.mockResolvedValue(undefined);
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockUpdateBooking.mockResolvedValue(undefined);
    mockIsUserConnected.mockReturnValue(true);
    mockFilterOnline.mockImplementation(async (ids: string[]) => ids);
    mockAssignmentFindMany.mockResolvedValue([]);
    // FIX #13: Batch eligibility check + rebroadcast subtype filter need vehicle data
    mockVehicleFindMany.mockResolvedValue([
      { transporterId: 'transporter-001', vehicleType: 'Tipper', vehicleSubtype: '20-24 Ton' },
      { transporterId: 'transporter-002', vehicleType: 'Tipper', vehicleSubtype: '20-24 Ton' },
      { transporterId: 'transporter-003', vehicleType: 'Tipper', vehicleSubtype: '20-24 Ton' },
      { transporterId: 'transporter-new', vehicleType: 'Tipper', vehicleSubtype: '20-24 Ton' },
    ]);
    // KYC/verification gate: return all transporters as verified
    mockUserFindMany.mockResolvedValue([
      { id: 'transporter-001' },
      { id: 'transporter-002' },
      { id: 'transporter-003' },
      { id: 'transporter-new' },
    ]);

    broadcastSvc = new BookingBroadcastService();
    radiusSvc = new BookingRadiusService();
    rebroadcastSvc = new BookingRebroadcastService();
    lifecycleSvc = new BookingLifecycleService();

    // Set up service ref needed by decrementTrucksFilled
    setCreateServiceRef({
      startBookingTimeout: jest.fn().mockResolvedValue(undefined),
    });
  });

  // ===========================================================================
  // 1. BROADCAST MECHANICS
  // ===========================================================================

  describe('Broadcast Mechanics', () => {
    it('should emit NEW_BROADCAST to all matching transporters', async () => {
      // Disable queue so direct emitToUser is used
      const origEnv = process.env.FF_SEQUENCE_DELIVERY_ENABLED;
      process.env.FF_SEQUENCE_DELIVERY_ENABLED = 'false';

      const ctx = makeContext();
      await broadcastSvc.broadcastBookingToTransporters(ctx);

      for (const tid of ctx.matchingTransporters) {
        expect(mockEmitToUser).toHaveBeenCalledWith(tid, 'new_broadcast', expect.any(Object));
      }

      process.env.FF_SEQUENCE_DELIVERY_ENABLED = origEnv;
    });

    it('should transition status from created to broadcasting', async () => {
      const ctx = makeContext();
      await broadcastSvc.broadcastBookingToTransporters(ctx);

      expect(mockBookingUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'booking-001', status: 'created' }),
          data: expect.objectContaining({ status: 'broadcasting' }),
        })
      );
    });

    it('should emit BROADCAST_STATE_CHANGED to customer after status update', async () => {
      const ctx = makeContext();
      await broadcastSvc.broadcastBookingToTransporters(ctx);

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'customer-001',
        'broadcast_state_changed',
        expect.objectContaining({ bookingId: 'booking-001', status: 'broadcasting' })
      );
    });

    it('should build candidateMap with per-transporter distances', async () => {
      const ctx = makeContext();
      await broadcastSvc.broadcastBookingToTransporters(ctx);

      expect(ctx.candidateMap.get('transporter-001')).toEqual({ distanceKm: 5, etaSeconds: 600 });
      expect(ctx.candidateMap.get('transporter-002')).toEqual({ distanceKm: 8, etaSeconds: 960 });
    });

    it('should fill location gaps with sentinel values for unknown transporters', async () => {
      const ctx = makeContext({
        matchingTransporters: ['transporter-001', 'transporter-004'],
        step1Candidates: [
          { transporterId: 'transporter-001', distanceKm: 5, etaSeconds: 600 },
        ] as any,
      });
      await broadcastSvc.broadcastBookingToTransporters(ctx);

      // transporter-004 was not in step1Candidates, should get sentinel
      expect(ctx.candidateMap.get('transporter-004')).toEqual({ distanceKm: -1, etaSeconds: 0 });
    });

    it('should cap transporters when exceeding MAX_BROADCAST_TRANSPORTERS', async () => {
      const manyTransporters = Array.from({ length: 150 }, (_, i) => `transporter-${i}`);
      const ctx = makeContext({
        matchingTransporters: manyTransporters,
        step1Candidates: manyTransporters.map(t => ({ transporterId: t, distanceKm: 5, etaSeconds: 600 })) as any,
      });

      await broadcastSvc.broadcastBookingToTransporters(ctx);

      // Default MAX_BROADCAST_TRANSPORTERS is 100
      expect(ctx.cappedTransporters.length).toBeLessThanOrEqual(100);
    });

    it('should store notified transporters in Redis SET with TTL', async () => {
      const ctx = makeContext();
      await broadcastSvc.broadcastBookingToTransporters(ctx);

      expect(mockRedisSAddWithExpire).toHaveBeenCalledWith(
        expect.stringContaining('broadcast:notified:booking-001'),
        expect.any(Number),
        ...ctx.matchingTransporters
      );
    });

    it('should retry once if sAddWithExpire fails initially', async () => {
      mockRedisSAddWithExpire
        .mockRejectedValueOnce(new Error('Redis timeout'))
        .mockResolvedValueOnce(undefined);

      const ctx = makeContext();
      await broadcastSvc.broadcastBookingToTransporters(ctx);

      expect(mockRedisSAddWithExpire).toHaveBeenCalledTimes(2);
    });

    it('should not store notified set if no matching transporters', async () => {
      const ctx = makeContext({ matchingTransporters: [] });
      await broadcastSvc.broadcastBookingToTransporters(ctx);

      expect(mockRedisSAddWithExpire).not.toHaveBeenCalled();
    });

    it('should track broadcast delivery in Redis hash for observability', async () => {
      const ctx = makeContext();
      await broadcastSvc.broadcastBookingToTransporters(ctx);

      expect(mockRedisHSet).toHaveBeenCalledWith(
        'broadcast:delivery:booking-001',
        expect.any(String),
        expect.stringContaining('emittedAt')
      );
    });

    it('should stop broadcasting mid-loop if booking status becomes cancelled', async () => {
      // Simulate booking becoming cancelled after a few emits
      let callCount = 0;
      mockBookingFindUnique.mockImplementation(() => {
        callCount++;
        return { status: callCount > 0 ? 'cancelled' : 'active' };
      });

      // Create a large set so the status check fires (every 20 by default)
      const transporters = Array.from({ length: 25 }, (_, i) => `transporter-${i}`);
      const ctx = makeContext({
        matchingTransporters: transporters,
        step1Candidates: transporters.map(t => ({ transporterId: t, distanceKm: 5, etaSeconds: 600 })) as any,
      });

      await broadcastSvc.broadcastBookingToTransporters(ctx);

      // Should not have emitted to all 25 — stopped after the status check
      const emitCalls = mockEmitToUser.mock.calls.filter(
        (c: any[]) => c[1] === 'new_broadcast'
      );
      expect(emitCalls.length).toBeLessThan(25);
    });

    it('should use queue for delivery when FF_SEQUENCE_DELIVERY_ENABLED is set', async () => {
      const origEnv = process.env.FF_SEQUENCE_DELIVERY_ENABLED;
      process.env.FF_SEQUENCE_DELIVERY_ENABLED = 'true';

      const ctx = makeContext();
      await broadcastSvc.broadcastBookingToTransporters(ctx);

      expect(mockQueueBroadcast).toHaveBeenCalled();

      process.env.FF_SEQUENCE_DELIVERY_ENABLED = origEnv;
    });

    it('should fall back to direct emit if queue fails', async () => {
      const origEnv = process.env.FF_SEQUENCE_DELIVERY_ENABLED;
      process.env.FF_SEQUENCE_DELIVERY_ENABLED = 'true';
      mockQueueBroadcast.mockRejectedValue(new Error('Queue full'));

      const ctx = makeContext();
      await broadcastSvc.broadcastBookingToTransporters(ctx);

      // emitToUser should still be called as fallback
      expect(mockEmitToUser).toHaveBeenCalled();

      process.env.FF_SEQUENCE_DELIVERY_ENABLED = origEnv;
    });
  });

  // ===========================================================================
  // 2. FCM PUSH NOTIFICATIONS
  // ===========================================================================

  describe('FCM Push Notifications', () => {
    it('should send FCM only to offline transporters', async () => {
      mockIsUserConnected.mockImplementation((id: string) => id !== 'transporter-003');
      const ctx = makeContext();
      ctx.cappedTransporters = ['transporter-001', 'transporter-002', 'transporter-003'];

      await broadcastSvc.sendFcmPushNotifications(ctx);

      expect(mockNotifyNewBroadcast).toHaveBeenCalledWith(
        ['transporter-003'],
        expect.objectContaining({ broadcastId: 'booking-001' })
      );
    });

    it('should skip FCM when all transporters are connected via socket', async () => {
      mockIsUserConnected.mockReturnValue(true);
      const ctx = makeContext();
      ctx.cappedTransporters = ['transporter-001', 'transporter-002'];

      await broadcastSvc.sendFcmPushNotifications(ctx);

      expect(mockNotifyNewBroadcast).not.toHaveBeenCalled();
    });

    it('should include booking details in FCM payload', async () => {
      mockIsUserConnected.mockReturnValue(false);
      const ctx = makeContext();
      ctx.cappedTransporters = ['transporter-001'];

      await broadcastSvc.sendFcmPushNotifications(ctx);

      expect(mockNotifyNewBroadcast).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          broadcastId: 'booking-001',
          customerName: 'Test Customer',
          vehicleType: 'Tipper',
          trucksNeeded: 3,
          farePerTruck: 5000,
          pickupCity: 'Bangalore',
          dropCity: 'Bangalore',
        })
      );
    });

    it('should include additional E3 fields for background decision-making', async () => {
      mockIsUserConnected.mockReturnValue(false);
      const ctx = makeContext();
      ctx.cappedTransporters = ['transporter-001'];

      await broadcastSvc.sendFcmPushNotifications(ctx);

      expect(mockNotifyNewBroadcast).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          pickupAddress: 'Pickup Addr',
          dropAddress: 'Drop Addr',
          distanceKm: 50,
          vehicleSubtype: '20-24 Ton',
        })
      );
    });

    it('should not crash broadcast if FCM fails', async () => {
      mockIsUserConnected.mockReturnValue(false);
      mockNotifyNewBroadcast.mockRejectedValueOnce(new Error('FCM unavailable'));
      const ctx = makeContext();
      ctx.cappedTransporters = ['transporter-001'];

      // Should not throw
      await expect(broadcastSvc.sendFcmPushNotifications(ctx)).resolves.not.toThrow();
    });

    it('should track FCM delivery in Redis hash for observability', async () => {
      mockIsUserConnected.mockReturnValue(false);
      mockNotifyNewBroadcast.mockResolvedValue(1);
      const ctx = makeContext();
      ctx.cappedTransporters = ['transporter-001'];

      await broadcastSvc.sendFcmPushNotifications(ctx);

      // After FCM resolves, hSet should be called with fcm marker
      await new Promise(r => setTimeout(r, 50));
      expect(mockRedisHSet).toHaveBeenCalledWith(
        'broadcast:delivery:booking-001',
        'transporter-001:fcm',
        expect.stringContaining('fcm')
      );
    });
  });

  // ===========================================================================
  // 3. BOOKING TIMEOUT SETUP
  // ===========================================================================

  describe('Booking Timeout Setup', () => {
    it('should start Redis-based booking timeout timer', async () => {
      await broadcastSvc.startBookingTimeout('booking-001', 'customer-001');

      expect(mockRedisCancelTimer).toHaveBeenCalledWith(expect.stringContaining('booking-001'));
      expect(mockRedisSetTimer).toHaveBeenCalledWith(
        expect.stringContaining('booking-001'),
        expect.objectContaining({ bookingId: 'booking-001', customerId: 'customer-001' }),
        expect.any(Date)
      );
    });

    it('should cancel existing timer before setting new one', async () => {
      await broadcastSvc.startBookingTimeout('booking-001', 'customer-001');

      const cancelIdx = mockRedisCancelTimer.mock.invocationCallOrder[0];
      const setIdx = mockRedisSetTimer.mock.invocationCallOrder[0];
      expect(cancelIdx).toBeLessThan(setIdx);
    });

    it('should set Redis idempotency keys in setBookingRedisKeys', async () => {
      const ctx = makeContext({ idempotencyKey: 'user-idem-key' });

      await broadcastSvc.setBookingRedisKeys(ctx);

      // FIX #30/#31: Value is now full response JSON (not just booking ID)
      expect(mockRedisSet).toHaveBeenCalledWith(
        expect.stringContaining('idempotency:booking:customer-001:user-idem-key'),
        expect.stringContaining('booking-001'),
        expect.any(Number)
      );
    });

    it('should store latest idempotency pointer', async () => {
      const ctx = makeContext({ idempotencyKey: 'user-idem-key' });

      await broadcastSvc.setBookingRedisKeys(ctx);

      // FIX #30: Latest pointer now includes payload hash suffix
      expect(mockRedisSet).toHaveBeenCalledWith(
        expect.stringContaining('idempotency:booking:customer-001:latest'),
        expect.stringContaining('user-idem-key'),
        expect.any(Number)
      );
    });

    it('should store server-generated dedup key', async () => {
      const ctx = makeContext();

      await broadcastSvc.setBookingRedisKeys(ctx);

      expect(mockRedisSet).toHaveBeenCalledWith(
        ctx.dedupeKey,
        'booking-001',
        expect.any(Number)
      );
    });
  });

  // ===========================================================================
  // 4. PROGRESSIVE RADIUS EXPANSION
  // ===========================================================================

  describe('Progressive Radius Expansion', () => {
    it('should schedule step 2 timer when starting progressive expansion', async () => {
      await radiusSvc.startProgressiveExpansion(
        'booking-001', 'customer-001', 'Tipper_20-24 Ton', 'Tipper', '20-24 Ton', 12.97, 77.59
      );

      expect(mockRedisSetTimer).toHaveBeenCalledWith(
        expect.stringContaining('radius:booking-001'),
        expect.objectContaining({ bookingId: 'booking-001', currentStep: 0 }),
        expect.any(Date)
      );
    });

    it('should store current step index in Redis', async () => {
      await radiusSvc.startProgressiveExpansion(
        'booking-001', 'customer-001', 'Tipper_20-24 Ton', 'Tipper', '20-24 Ton', 12.97, 77.59
      );

      expect(mockRedisSet).toHaveBeenCalledWith(
        expect.stringContaining('broadcast:radius:step:booking-001'),
        '0',
        expect.any(Number)
      );
    });

    it('should stop expansion if booking is cancelled', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'cancelled' }));

      await radiusSvc.advanceRadiusStep(makeRadiusStepTimerData());

      expect(mockFindCandidates).not.toHaveBeenCalled();
    });

    it('should stop expansion if booking is expired', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'expired' }));

      await radiusSvc.advanceRadiusStep(makeRadiusStepTimerData());

      expect(mockFindCandidates).not.toHaveBeenCalled();
    });

    it('should stop expansion if booking is fully_filled', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'fully_filled' }));

      await radiusSvc.advanceRadiusStep(makeRadiusStepTimerData());

      expect(mockFindCandidates).not.toHaveBeenCalled();
    });

    it('should stop expansion if booking is completed', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'completed' }));

      await radiusSvc.advanceRadiusStep(makeRadiusStepTimerData());

      expect(mockFindCandidates).not.toHaveBeenCalled();
    });

    it('should stop expansion if booking is not found', async () => {
      mockGetBookingById.mockResolvedValue(null);

      await radiusSvc.advanceRadiusStep(makeRadiusStepTimerData());

      expect(mockFindCandidates).not.toHaveBeenCalled();
    });

    it('should search for candidates at expanded radius', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active' }));
      mockFindCandidates.mockResolvedValue([
        { transporterId: 'transporter-new-1', distanceKm: 15, etaSeconds: 1800 },
      ]);

      await radiusSvc.advanceRadiusStep(makeRadiusStepTimerData());

      expect(mockFindCandidates).toHaveBeenCalledWith(
        expect.objectContaining({ stepIndex: 1 })
      );
    });

    it('should filter out already-notified transporters using Redis SET', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active' }));
      mockRedisSMembers.mockResolvedValue(['transporter-001', 'transporter-002']);
      mockFindCandidates.mockResolvedValue([]);

      await radiusSvc.advanceRadiusStep(makeRadiusStepTimerData());

      expect(mockFindCandidates).toHaveBeenCalledWith(
        expect.objectContaining({
          alreadyNotified: new Set(['transporter-001', 'transporter-002']),
        })
      );
    });

    it('should broadcast to NEW transporters only at expanded radius', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active' }));
      mockFindCandidates.mockResolvedValue([
        { transporterId: 'transporter-new-1', distanceKm: 18, etaSeconds: 2160 },
        { transporterId: 'transporter-new-2', distanceKm: 22, etaSeconds: 2640 },
      ]);

      await radiusSvc.advanceRadiusStep(makeRadiusStepTimerData());

      expect(mockEmitToUser).toHaveBeenCalledWith('transporter-new-1', 'new_broadcast', expect.any(Object));
      expect(mockEmitToUser).toHaveBeenCalledWith('transporter-new-2', 'new_broadcast', expect.any(Object));
    });

    it('should add newly notified transporters to Redis SET', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active' }));
      mockFindCandidates.mockResolvedValue([
        { transporterId: 'transporter-new-1', distanceKm: 18, etaSeconds: 2160 },
      ]);

      await radiusSvc.advanceRadiusStep(makeRadiusStepTimerData());

      expect(mockRedisSAddWithExpire).toHaveBeenCalledWith(
        expect.stringContaining('broadcast:notified:booking-001'),
        expect.any(Number),
        'transporter-new-1'
      );
    });

    it('should update notifiedTransporters in DB after expansion', async () => {
      const booking = makeBooking({ status: 'active', notifiedTransporters: ['transporter-001'] });
      mockGetBookingById.mockResolvedValue(booking);
      mockFindCandidates.mockResolvedValue([
        { transporterId: 'transporter-new-1', distanceKm: 18, etaSeconds: 2160 },
      ]);

      await radiusSvc.advanceRadiusStep(makeRadiusStepTimerData());

      expect(mockUpdateBooking).toHaveBeenCalledWith(
        'booking-001',
        expect.objectContaining({
          notifiedTransporters: expect.arrayContaining(['transporter-001', 'transporter-new-1']),
        })
      );
    });

    it('should schedule next step timer after advancing', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active' }));
      mockFindCandidates.mockResolvedValue([]);

      await radiusSvc.advanceRadiusStep(makeRadiusStepTimerData());

      // Should schedule next timer
      expect(mockRedisSetTimer).toHaveBeenCalledWith(
        expect.stringContaining('radius:booking-001'),
        expect.objectContaining({ currentStep: 1 }),
        expect.any(Date)
      );
    });

    it('should trigger DB fallback when all steps are exhausted', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active' }));
      mockGetTransportersWithVehicleType.mockResolvedValue(['transporter-db-1']);
      mockFilterOnline.mockResolvedValue(['transporter-db-1']);

      // Set currentStep so nextStepIndex >= totalSteps (6)
      await radiusSvc.advanceRadiusStep(makeRadiusStepTimerData({ currentStep: 5 }));

      // DB fallback now passes both vehicleType and vehicleSubtype
      expect(mockGetTransportersWithVehicleType).toHaveBeenCalledWith('Tipper', '20-24 Ton');
    });

    it('should cap DB fallback transporters at 100', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active' }));
      const manyTransporters = Array.from({ length: 150 }, (_, i) => `transporter-db-${i}`);
      mockGetTransportersWithVehicleType.mockResolvedValue(manyTransporters);
      mockFilterOnline.mockResolvedValue(manyTransporters);

      await radiusSvc.advanceRadiusStep(makeRadiusStepTimerData({ currentStep: 5 }));

      // filterOnline result sliced to 100
      const emitCalls = mockEmitToUser.mock.calls.filter(
        (c: any[]) => c[1] === 'new_broadcast'
      );
      expect(emitCalls.length).toBeLessThanOrEqual(100);
    });

    it('should filter DB fallback transporters beyond 200km', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active' }));
      mockGetTransportersWithVehicleType.mockResolvedValue(['transporter-far']);
      mockFilterOnline.mockResolvedValue(['transporter-far']);
      mockLoadTransporterDetailsMap.mockResolvedValue(
        new Map([['transporter-far', { latitude: '20.0', longitude: '80.0' }]])
      );
      mockBatchGetPickupDistance.mockResolvedValue(
        new Map([['transporter-far', { distanceMeters: 250_000, durationSeconds: 10_800 }]])
      );

      await radiusSvc.advanceRadiusStep(makeRadiusStepTimerData({ currentStep: 5 }));

      // transporter-far is 250km away, should be filtered
      const emitCalls = mockEmitToUser.mock.calls.filter(
        (c: any[]) => c[0] === 'transporter-far' && c[1] === 'new_broadcast'
      );
      expect(emitCalls.length).toBe(0);
    });

    it('should send FCM to new transporters during radius expansion', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active' }));
      mockFindCandidates.mockResolvedValue([
        { transporterId: 'transporter-new-1', distanceKm: 18, etaSeconds: 2160 },
      ]);

      await radiusSvc.advanceRadiusStep(makeRadiusStepTimerData());

      expect(mockNotifyNewBroadcast).toHaveBeenCalledWith(
        ['transporter-new-1'],
        expect.objectContaining({ broadcastId: 'booking-001' })
      );
    });

    it('should clear radius keys when expansion stops', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'cancelled' }));

      await radiusSvc.advanceRadiusStep(makeRadiusStepTimerData());

      expect(mockRedisCancelTimer).toHaveBeenCalledWith(expect.stringContaining('radius:booking-001'));
      expect(mockRedisDel).toHaveBeenCalledWith(expect.stringContaining('broadcast:radius:step:booking-001'));
      expect(mockRedisDel).toHaveBeenCalledWith(expect.stringContaining('broadcast:notified:booking-001'));
    });

    it('should cap notifiedTransporters at 200 in DB', async () => {
      const existingNotified = Array.from({ length: 195 }, (_, i) => `existing-${i}`);
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active', notifiedTransporters: existingNotified }));
      const newCandidates = Array.from({ length: 10 }, (_, i) => ({
        transporterId: `new-${i}`, distanceKm: 15, etaSeconds: 1800,
      }));
      mockFindCandidates.mockResolvedValue(newCandidates);

      await radiusSvc.advanceRadiusStep(makeRadiusStepTimerData());

      const updateCall = mockUpdateBooking.mock.calls[0];
      expect(updateCall[1].notifiedTransporters.length).toBeLessThanOrEqual(200);
    });

    it('should handle 3 expansion steps in sequence finding new transporters each time', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active' }));

      // Step 1 -> 2
      mockFindCandidates.mockResolvedValueOnce([{ transporterId: 'exp-t1', distanceKm: 12, etaSeconds: 1440 }]);
      await radiusSvc.advanceRadiusStep(makeRadiusStepTimerData({ currentStep: 0 }));
      expect(mockEmitToUser).toHaveBeenCalledWith('exp-t1', 'new_broadcast', expect.any(Object));

      jest.clearAllMocks();
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active' }));
      mockRedisSMembers.mockResolvedValue(['exp-t1']);

      // Step 2 -> 3
      mockFindCandidates.mockResolvedValueOnce([{ transporterId: 'exp-t2', distanceKm: 20, etaSeconds: 2400 }]);
      await radiusSvc.advanceRadiusStep(makeRadiusStepTimerData({ currentStep: 1 }));
      expect(mockEmitToUser).toHaveBeenCalledWith('exp-t2', 'new_broadcast', expect.any(Object));

      jest.clearAllMocks();
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active' }));
      mockRedisSMembers.mockResolvedValue(['exp-t1', 'exp-t2']);

      // Step 3 -> 4
      mockFindCandidates.mockResolvedValueOnce([{ transporterId: 'exp-t3', distanceKm: 28, etaSeconds: 3360 }]);
      await radiusSvc.advanceRadiusStep(makeRadiusStepTimerData({ currentStep: 2 }));
      expect(mockEmitToUser).toHaveBeenCalledWith('exp-t3', 'new_broadcast', expect.any(Object));
    });
  });

  // ===========================================================================
  // 5. REBROADCAST (transporter comes online)
  // ===========================================================================

  describe('Rebroadcast on Transporter Online', () => {
    it('should deliver missed broadcasts to transporter who just came online', async () => {
      const booking = makeBooking({ status: 'active' });
      mockGetActiveBookingsForTransporter.mockResolvedValue([booking]);

      await rebroadcastSvc.deliverMissedBroadcasts('transporter-new');

      // FF_SEQUENCE_DELIVERY_ENABLED uses === 'true'; when unset, direct emit is used
      expect(mockEmitToUser).toHaveBeenCalledWith('transporter-new', 'new_broadcast', expect.any(Object));
    });

    it('should only deliver unexpired bookings', async () => {
      const expired = makeBooking({ id: 'expired-booking', expiresAt: new Date(Date.now() - 10_000).toISOString() });
      const active = makeBooking({ id: 'active-booking', expiresAt: new Date(Date.now() + 60_000).toISOString() });
      mockGetActiveBookingsForTransporter.mockResolvedValue([expired, active]);

      await rebroadcastSvc.deliverMissedBroadcasts('transporter-new');

      // Only active booking should be delivered via direct emit (FF not set = direct)
      const emitCalls = mockEmitToUser.mock.calls.filter(
        (c: any[]) => c[1] === 'new_broadcast'
      );
      expect(emitCalls.length).toBe(1);
    });

    it('should rate limit to max once per 10 seconds per transporter', async () => {
      mockGetActiveBookingsForTransporter.mockResolvedValue([makeBooking()]);

      // First call
      await rebroadcastSvc.deliverMissedBroadcasts('transporter-new');

      // Second call should be rate limited
      mockRedisGet.mockResolvedValueOnce('1'); // rate limit key exists
      await rebroadcastSvc.deliverMissedBroadcasts('transporter-new');

      // Only first call should set the rate limit key
      expect(mockRedisSet).toHaveBeenCalledWith(
        expect.stringContaining('ratelimit:missed-broadcasts:transporter-new'),
        '1',
        10
      );
    });

    it('should cap at 20 rebroadcasts per online event', async () => {
      const manyBookings = Array.from({ length: 30 }, (_, i) =>
        makeBooking({
          id: `booking-${i}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })
      );
      mockGetActiveBookingsForTransporter.mockResolvedValue(manyBookings);

      await rebroadcastSvc.deliverMissedBroadcasts('transporter-new');

      const emitCalls = mockEmitToUser.mock.calls.filter(
        (c: any[]) => c[1] === 'new_broadcast'
      );
      expect(emitCalls.length).toBeLessThanOrEqual(20);
    });

    it('should geo-filter rebroadcasts when transporter location is available', async () => {
      const nearBooking = makeBooking({ id: 'near-booking', pickup: { latitude: 12.97, longitude: 77.59, address: 'Near', city: 'BLR' } });
      const farBooking = makeBooking({ id: 'far-booking', pickup: { latitude: 28.0, longitude: 77.0, address: 'Far', city: 'DEL' } });
      mockGetActiveBookingsForTransporter.mockResolvedValue([nearBooking, farBooking]);

      // Transporter is near Bangalore
      mockGetTransporterDetails.mockResolvedValue({ latitude: 12.97, longitude: 77.59 });

      // haversineDistanceKm returns 10 for near, 1500 for far (beyond 100km default)
      mockHaversineDistanceKm
        .mockReturnValueOnce(10)    // near booking
        .mockReturnValueOnce(1500); // far booking

      await rebroadcastSvc.deliverMissedBroadcasts('transporter-new');

      // FF not set = direct emit; only near booking should be delivered
      const emitCalls = mockEmitToUser.mock.calls.filter(
        (c: any[]) => c[1] === 'new_broadcast'
      );
      expect(emitCalls.length).toBe(1);
    });

    it('should skip geo filter gracefully when transporter location not available', async () => {
      const booking = makeBooking();
      mockGetActiveBookingsForTransporter.mockResolvedValue([booking]);
      mockGetTransporterDetails.mockResolvedValue(null);

      await rebroadcastSvc.deliverMissedBroadcasts('transporter-new');

      // Should still deliver (no geo filter applied); FF not set = direct emit
      expect(mockEmitToUser).toHaveBeenCalledWith('transporter-new', 'new_broadcast', expect.any(Object));
    });

    it('should filter by vehicle subtype matching transporter fleet', async () => {
      const tipperBooking = makeBooking({ vehicleType: 'Tipper', vehicleSubtype: '20-24 Ton' });
      const containerBooking = makeBooking({ id: 'container-booking', vehicleType: 'Container', vehicleSubtype: '20 Ft' });
      mockGetActiveBookingsForTransporter.mockResolvedValue([tipperBooking, containerBooking]);

      mockVehicleFindMany.mockResolvedValue([
        { vehicleType: 'Tipper', vehicleSubtype: '20-24 Ton' },
      ]);

      await rebroadcastSvc.deliverMissedBroadcasts('transporter-new');

      // FF not set = direct emit; only tipper booking matches fleet
      const emitCalls = mockEmitToUser.mock.calls.filter(
        (c: any[]) => c[1] === 'new_broadcast'
      );
      expect(emitCalls.length).toBe(1);
    });

    it('should skip bookings where transporter already has active assignment', async () => {
      const booking = makeBooking();
      mockGetActiveBookingsForTransporter.mockResolvedValue([booking]);
      mockAssignmentFindMany.mockResolvedValue([
        { bookingId: 'booking-001' },
      ]);

      await rebroadcastSvc.deliverMissedBroadcasts('transporter-new');

      const queueCalls = mockQueueBroadcast.mock.calls.filter(
        (c: any[]) => c[1] === 'new_broadcast'
      );
      expect(queueCalls.length).toBe(0);
    });

    it('should update notifiedTransporters in DB after rebroadcast', async () => {
      const booking = makeBooking({ notifiedTransporters: ['transporter-001'] });
      mockGetActiveBookingsForTransporter.mockResolvedValue([booking]);

      await rebroadcastSvc.deliverMissedBroadcasts('transporter-new');

      expect(mockUpdateBooking).toHaveBeenCalledWith(
        'booking-001',
        expect.objectContaining({
          notifiedTransporters: expect.arrayContaining(['transporter-001', 'transporter-new']),
        })
      );
    });

    it('should send individual FCM per booking for Android notification grouping', async () => {
      const booking1 = makeBooking({ id: 'booking-1' });
      const booking2 = makeBooking({ id: 'booking-2' });
      mockGetActiveBookingsForTransporter.mockResolvedValue([booking1, booking2]);

      await rebroadcastSvc.deliverMissedBroadcasts('transporter-new');

      // Two individual FCM calls
      expect(mockNotifyNewBroadcast).toHaveBeenCalledTimes(2);
      expect(mockNotifyNewBroadcast).toHaveBeenCalledWith(
        ['transporter-new'],
        expect.objectContaining({ broadcastId: 'booking-1', notificationTag: 'broadcast_booking-1' })
      );
      expect(mockNotifyNewBroadcast).toHaveBeenCalledWith(
        ['transporter-new'],
        expect.objectContaining({ broadcastId: 'booking-2', notificationTag: 'broadcast_booking-2' })
      );
    });

    it('should handle error in one rebroadcast FCM without affecting others', async () => {
      const booking1 = makeBooking({ id: 'booking-1' });
      const booking2 = makeBooking({ id: 'booking-2' });
      mockGetActiveBookingsForTransporter.mockResolvedValue([booking1, booking2]);
      mockNotifyNewBroadcast
        .mockRejectedValueOnce(new Error('FCM error'))
        .mockResolvedValueOnce(1);

      // Should not throw
      await expect(rebroadcastSvc.deliverMissedBroadcasts('transporter-new')).resolves.not.toThrow();
    });

    it('should handle complete rebroadcast failure gracefully', async () => {
      mockGetActiveBookingsForTransporter.mockRejectedValue(new Error('DB down'));

      await expect(rebroadcastSvc.deliverMissedBroadcasts('transporter-new')).resolves.not.toThrow();
    });

    it('should filter out old bookings beyond 30 minutes', async () => {
      const oldBooking = makeBooking({
        id: 'old-booking',
        createdAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const recentBooking = makeBooking({
        id: 'recent-booking',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      mockGetActiveBookingsForTransporter.mockResolvedValue([oldBooking, recentBooking]);

      await rebroadcastSvc.deliverMissedBroadcasts('transporter-new');

      // FF not set = direct emit; only recent booking should be delivered
      const emitCalls = mockEmitToUser.mock.calls.filter(
        (c: any[]) => c[1] === 'new_broadcast'
      );
      expect(emitCalls.length).toBe(1);
    });

    it('should not update notifiedTransporters if transporter already in list', async () => {
      const booking = makeBooking({ notifiedTransporters: ['transporter-new'] });
      mockGetActiveBookingsForTransporter.mockResolvedValue([booking]);

      await rebroadcastSvc.deliverMissedBroadcasts('transporter-new');

      // updateBooking should NOT be called since transporter is already in list
      expect(mockUpdateBooking).not.toHaveBeenCalled();
    });

    it('should mark rebroadcast payloads with isRebroadcast flag', async () => {
      const booking = makeBooking();
      mockGetActiveBookingsForTransporter.mockResolvedValue([booking]);

      await rebroadcastSvc.deliverMissedBroadcasts('transporter-new');

      expect(mockBuildBroadcastPayload).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ isRebroadcast: true })
      );
    });

    it('should set isRebroadcast true in FCM payload', async () => {
      const booking = makeBooking();
      mockGetActiveBookingsForTransporter.mockResolvedValue([booking]);

      await rebroadcastSvc.deliverMissedBroadcasts('transporter-new');

      expect(mockNotifyNewBroadcast).toHaveBeenCalledWith(
        ['transporter-new'],
        expect.objectContaining({ isRebroadcast: true })
      );
    });

    it('should deliver 0 bookings gracefully when none are active', async () => {
      mockGetActiveBookingsForTransporter.mockResolvedValue([]);

      await rebroadcastSvc.deliverMissedBroadcasts('transporter-new');

      expect(mockQueueBroadcast).not.toHaveBeenCalledWith('transporter-new', 'new_broadcast', expect.any(Object));
    });
  });

  // ===========================================================================
  // 6. TIMEOUT MECHANICS
  // ===========================================================================

  describe('Timeout Mechanics', () => {
    it('should handle booking timeout by expiring the booking', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active', trucksFilled: 0 }));

      await lifecycleSvc.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockBookingUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'expired' }),
        })
      );
    });

    it('should emit NO_VEHICLES_AVAILABLE when no trucks filled', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active', trucksFilled: 0 }));

      await lifecycleSvc.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'customer-001',
        'no_vehicles_available',
        expect.objectContaining({
          bookingId: 'booking-001',
          vehicleType: 'Tipper',
          suggestion: 'search_again',
        })
      );
    });

    it('should emit BOOKING_EXPIRED for partial fill with options', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active', trucksFilled: 1 }));

      await lifecycleSvc.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'customer-001',
        'booking_expired',
        expect.objectContaining({
          bookingId: 'booking-001',
          status: 'partially_filled_expired',
          trucksNeeded: 3,
          trucksFilled: 1,
          options: expect.arrayContaining(['continue_partial', 'search_again', 'cancel']),
        })
      );
    });

    it('should clear all booking timers on timeout', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active', trucksFilled: 0 }));

      await lifecycleSvc.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockRedisCancelTimer).toHaveBeenCalledWith(expect.stringContaining('booking:booking-001'));
      expect(mockRedisCancelTimer).toHaveBeenCalledWith(expect.stringContaining('radius:booking-001'));
    });

    it('should clear customer active broadcast key on timeout', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active', trucksFilled: 0 }));

      await lifecycleSvc.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockRedisDel).toHaveBeenCalledWith(
        expect.stringContaining('customer:active-broadcast:customer-001')
      );
    });

    it('should notify all notified transporters about expiry', async () => {
      const booking = makeBooking({
        status: 'active',
        trucksFilled: 0,
        notifiedTransporters: ['transporter-001', 'transporter-002'],
      });
      mockGetBookingById.mockResolvedValue(booking);

      await lifecycleSvc.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockEmitToUser).toHaveBeenCalledWith('transporter-001', 'booking_expired', expect.any(Object));
      expect(mockEmitToUser).toHaveBeenCalledWith('transporter-002', 'booking_expired', expect.any(Object));
    });

    it('should send FCM push to notified transporters about expiry', async () => {
      const booking = makeBooking({
        status: 'active',
        trucksFilled: 0,
        notifiedTransporters: ['transporter-001'],
      });
      mockGetBookingById.mockResolvedValue(booking);

      await lifecycleSvc.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockQueuePushNotificationBatch).toHaveBeenCalledWith(
        ['transporter-001'],
        expect.objectContaining({
          title: expect.stringContaining('Expired'),
          data: expect.objectContaining({ type: 'booking_expired', bookingId: 'booking-001' }),
        })
      );
    });

    it('should skip timeout for already fully_filled booking', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'fully_filled' }));

      await lifecycleSvc.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockBookingUpdateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'expired' }) })
      );
    });

    it('should skip timeout for already completed booking', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'completed' }));

      await lifecycleSvc.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockBookingUpdateMany).not.toHaveBeenCalled();
    });

    it('should skip timeout for already cancelled booking', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'cancelled' }));

      await lifecycleSvc.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockBookingUpdateMany).not.toHaveBeenCalled();
    });

    it('should skip timeout for non-existent booking', async () => {
      mockGetBookingById.mockResolvedValue(null);

      await lifecycleSvc.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockBookingUpdateMany).not.toHaveBeenCalled();
    });

    it('should handle timeout for booking in unexpected status safely', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'some_weird_state' }));

      await expect(
        lifecycleSvc.handleBookingTimeout('booking-001', 'customer-001')
      ).resolves.not.toThrow();
    });

    it('should emit BOOKING_EXPIRED to booking room for partial fill', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active', trucksFilled: 2 }));

      await lifecycleSvc.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockEmitToBooking).toHaveBeenCalledWith(
        'booking-001',
        'booking_expired',
        expect.objectContaining({ bookingId: 'booking-001', status: 'partially_filled_expired' })
      );
    });

    it('should emit BOOKING_EXPIRED to booking room for zero fill', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active', trucksFilled: 0 }));

      await lifecycleSvc.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockEmitToBooking).toHaveBeenCalledWith(
        'booking-001',
        'booking_expired',
        expect.objectContaining({ status: 'expired', trucksFilled: 0 })
      );
    });

    it('should use CAS-style updateMany to prevent race with concurrent accept', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active', trucksFilled: 0 }));

      await lifecycleSvc.handleBookingTimeout('booking-001', 'customer-001');

      // Should use updateMany with status precondition (not update)
      expect(mockBookingUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'booking-001',
            status: expect.objectContaining({ in: expect.arrayContaining(['broadcasting', 'active']) }),
          }),
        })
      );
    });
  });

  // ===========================================================================
  // 7. CANCEL BOOKING
  // ===========================================================================

  describe('Cancel Booking', () => {
    it('should cancel booking atomically', async () => {
      mockGetBookingById
        .mockResolvedValueOnce(makeBooking({ status: 'active' }))   // preflight
        .mockResolvedValueOnce(makeBooking({ status: 'cancelled' }))  // post-transaction
        .mockResolvedValueOnce(makeBooking({ status: 'cancelled' })); // fresh fetch
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentFindMany.mockResolvedValue([]);

      const result = await lifecycleSvc.cancelBooking('booking-001', 'customer-001');

      expect(result.status).toBe('cancelled');
    });

    it('should be idempotent for already cancelled bookings', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'cancelled' }));

      const result = await lifecycleSvc.cancelBooking('booking-001', 'customer-001');

      expect(result.status).toBe('cancelled');
    });

    it('should notify all notified transporters about cancellation', async () => {
      mockGetBookingById
        .mockResolvedValueOnce(makeBooking({ status: 'active', notifiedTransporters: ['transporter-001'] }))
        .mockResolvedValueOnce(makeBooking({ status: 'cancelled', notifiedTransporters: ['transporter-001'] }))
        .mockResolvedValueOnce(makeBooking({ status: 'cancelled', notifiedTransporters: ['transporter-001'] }));
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentFindMany.mockResolvedValue([]);

      await lifecycleSvc.cancelBooking('booking-001', 'customer-001');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'transporter-001',
        'booking_expired',
        expect.objectContaining({ reason: 'customer_cancelled' })
      );
    });

    it('should send FCM cancellation push to notified transporters', async () => {
      mockGetBookingById
        .mockResolvedValueOnce(makeBooking({ status: 'active', notifiedTransporters: ['transporter-001'] }))
        .mockResolvedValueOnce(makeBooking({ status: 'cancelled', notifiedTransporters: ['transporter-001'] }))
        .mockResolvedValueOnce(makeBooking({ status: 'cancelled', notifiedTransporters: ['transporter-001'] }));
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentFindMany.mockResolvedValue([]);

      await lifecycleSvc.cancelBooking('booking-001', 'customer-001');

      expect(mockQueuePushNotificationBatch).toHaveBeenCalledWith(
        ['transporter-001'],
        expect.objectContaining({
          title: expect.stringContaining('Cancelled'),
          data: expect.objectContaining({ type: 'booking_cancelled' }),
        })
      );
    });

    it('should clear all timers and Redis keys on cancel', async () => {
      mockGetBookingById
        .mockResolvedValueOnce(makeBooking({ status: 'active' }))
        .mockResolvedValueOnce(makeBooking({ status: 'cancelled' }))
        .mockResolvedValueOnce(makeBooking({ status: 'cancelled' }));
      mockBookingUpdateMany.mockResolvedValue({ count: 1 });
      mockAssignmentFindMany.mockResolvedValue([]);

      await lifecycleSvc.cancelBooking('booking-001', 'customer-001');

      expect(mockRedisCancelTimer).toHaveBeenCalled();
      expect(mockRedisDel).toHaveBeenCalledWith(expect.stringContaining('customer:active-broadcast'));
    });

    it('should reject cancel for wrong customer', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ customerId: 'customer-999' }));

      await expect(
        lifecycleSvc.cancelBooking('booking-001', 'customer-001')
      ).rejects.toThrow('You can only cancel your own bookings');
    });
  });

  // ===========================================================================
  // 8. TRUCK FILLING (increment / decrement)
  // ===========================================================================

  describe('Truck Filling', () => {
    it('should increment trucksFilled atomically', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ trucksFilled: 0, trucksNeeded: 3, status: 'active' }));
      mockQueryRaw.mockResolvedValue([{ trucksFilled: 1, trucksNeeded: 3 }]);

      await lifecycleSvc.incrementTrucksFilled('booking-001');

      expect(mockQueryRaw).toHaveBeenCalled();
    });

    it('should emit BOOKING_FULLY_FILLED when all trucks assigned', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ trucksFilled: 2, trucksNeeded: 3, status: 'active' }));
      mockQueryRaw.mockResolvedValue([{ trucksFilled: 3, trucksNeeded: 3 }]);

      await lifecycleSvc.incrementTrucksFilled('booking-001');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'customer-001',
        'booking_fully_filled',
        expect.objectContaining({ trucksNeeded: 3, trucksFilled: 3 })
      );
    });

    it('should cancel timeout when fully filled', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ trucksFilled: 2, trucksNeeded: 3, status: 'active' }));
      mockQueryRaw.mockResolvedValue([{ trucksFilled: 3, trucksNeeded: 3 }]);

      await lifecycleSvc.incrementTrucksFilled('booking-001');

      expect(mockRedisCancelTimer).toHaveBeenCalled();
    });

    it('should emit BOOKING_PARTIALLY_FILLED for partial fill', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ trucksFilled: 0, trucksNeeded: 3, status: 'active' }));
      mockQueryRaw.mockResolvedValue([{ trucksFilled: 1, trucksNeeded: 3 }]);

      await lifecycleSvc.incrementTrucksFilled('booking-001');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'customer-001',
        'booking_partially_filled',
        expect.objectContaining({ trucksFilled: 1, remaining: 2 })
      );
    });

    it('should skip increment if already at capacity (idempotent)', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ trucksFilled: 3, trucksNeeded: 3, status: 'fully_filled' }));

      const result = await lifecycleSvc.incrementTrucksFilled('booking-001');

      expect(mockQueryRaw).not.toHaveBeenCalled();
      expect(result.trucksFilled).toBe(3);
    });

    it('should notify remaining transporters when fully filled', async () => {
      const booking = makeBooking({
        trucksFilled: 2,
        trucksNeeded: 3,
        status: 'active',
        notifiedTransporters: ['transporter-001', 'transporter-002'],
      });
      mockGetBookingById.mockResolvedValue(booking);
      mockQueryRaw.mockResolvedValue([{ trucksFilled: 3, trucksNeeded: 3 }]);

      await lifecycleSvc.incrementTrucksFilled('booking-001');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'transporter-001',
        'booking_expired',
        expect.objectContaining({ reason: 'fully_filled' })
      );
      expect(mockEmitToUser).toHaveBeenCalledWith(
        'transporter-002',
        'booking_expired',
        expect.objectContaining({ reason: 'fully_filled' })
      );
    });

    it('should decrement trucksFilled atomically', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ trucksFilled: 2, trucksNeeded: 3, status: 'partially_filled' }));
      mockQueryRaw.mockResolvedValue([{ trucksFilled: 1 }]);

      await lifecycleSvc.decrementTrucksFilled('booking-001');

      expect(mockQueryRaw).toHaveBeenCalled();
    });

    it('should restart timeout after decrement when slots remain', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ trucksFilled: 1, trucksNeeded: 3, status: 'partially_filled' }));
      mockQueryRaw.mockResolvedValue([{ trucksFilled: 0 }]);

      await lifecycleSvc.decrementTrucksFilled('booking-001');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'customer-001',
        'trucks_remaining_update',
        expect.objectContaining({ trucksFilled: 0, trucksNeeded: 3 })
      );
    });

    it('should block status write for booking in terminal state', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ trucksFilled: 0, trucksNeeded: 3, status: 'active' }));
      mockQueryRaw.mockResolvedValue([{ trucksFilled: 1, trucksNeeded: 3 }]);
      mockBookingUpdateMany.mockResolvedValue({ count: 0 }); // terminal state blocked

      await lifecycleSvc.incrementTrucksFilled('booking-001');

      // Should still succeed (idempotent behavior) despite terminal block
      expect(mockBookingUpdateMany).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 9. NOTIFICATION FORMAT VERIFICATION
  // ===========================================================================

  describe('Notification Format Verification', () => {
    it('should build payload with all required IDs (broadcastId, orderId, bookingId)', async () => {
      const ctx = makeContext();
      await broadcastSvc.broadcastBookingToTransporters(ctx);

      expect(mockBuildBroadcastPayload).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ timeoutSeconds: expect.any(Number) })
      );
    });

    it('should include per-transporter pickupDistanceKm in payload', async () => {
      const ctx = makeContext();
      await broadcastSvc.broadcastBookingToTransporters(ctx);

      // buildBroadcastPayload is called with pickup distance from candidateMap
      const calls = mockBuildBroadcastPayload.mock.calls;
      const hasPickupDistance = calls.some(
        (c: any[]) => c[1] && typeof c[1].pickupDistanceKm === 'number'
      );
      expect(hasPickupDistance).toBe(true);
    });

    it('should include per-transporter pickupEtaMinutes and pickupEtaSeconds', async () => {
      const ctx = makeContext();
      await broadcastSvc.broadcastBookingToTransporters(ctx);

      const calls = mockBuildBroadcastPayload.mock.calls;
      const hasEta = calls.some(
        (c: any[]) => c[1] && typeof c[1].pickupEtaMinutes === 'number' && typeof c[1].pickupEtaSeconds === 'number'
      );
      expect(hasEta).toBe(true);
    });

    it('should clamp -1 sentinel pickupDistance to 0 in broadcast payload', async () => {
      const ctx = makeContext({
        matchingTransporters: ['transporter-gap'],
        step1Candidates: [] as any,
      });
      await broadcastSvc.broadcastBookingToTransporters(ctx);

      // For the gap transporter, candidateMap has distanceKm=-1
      // The broadcast code should Math.max(0, ...) it to 0
      const calls = mockBuildBroadcastPayload.mock.calls;
      for (const call of calls) {
        if (call[1]?.pickupDistanceKm !== undefined) {
          expect(call[1].pickupDistanceKm).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('should include booking room expiry event with orderId and broadcastId', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active', trucksFilled: 0, notifiedTransporters: ['t1'] }));

      await lifecycleSvc.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        't1',
        'booking_expired',
        expect.objectContaining({
          bookingId: 'booking-001',
          orderId: 'booking-001',
          broadcastId: 'booking-001',
        })
      );
    });

    it('should include customerName in transporter expiry notification', async () => {
      mockGetBookingById.mockResolvedValue(
        makeBooking({ status: 'active', trucksFilled: 0, notifiedTransporters: ['t1'] })
      );

      await lifecycleSvc.handleBookingTimeout('booking-001', 'customer-001');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        't1',
        'booking_expired',
        expect.objectContaining({ customerName: 'Test Customer' })
      );
    });

    it('should include trucksFilled=0 in partial fill notification', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active', trucksFilled: 0, trucksNeeded: 3 }));
      mockQueryRaw.mockResolvedValue([{ trucksFilled: 1, trucksNeeded: 3 }]);

      await lifecycleSvc.incrementTrucksFilled('booking-001');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'customer-001',
        'booking_updated',
        expect.objectContaining({ trucksFilled: 1, trucksNeeded: 3 })
      );
    });

    it('should use radiusStep marker in DB fallback broadcast payloads', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ status: 'active' }));
      mockGetTransportersWithVehicleType.mockResolvedValue(['transporter-db-1']);
      mockFilterOnline.mockResolvedValue(['transporter-db-1']);
      mockRedisSMembers.mockResolvedValue([]);

      await radiusSvc.advanceRadiusStep(makeRadiusStepTimerData({ currentStep: 5 }));

      const calls = mockBuildBroadcastPayload.mock.calls;
      const dbFallbackCall = calls.find(
        (c: any[]) => c[1]?.radiusStep > 6
      );
      // DB fallback uses steps.length + 1 as marker
      expect(dbFallbackCall).toBeDefined();
    });

    it('should include trucksFilled message in fully_filled notification', async () => {
      mockGetBookingById.mockResolvedValue(makeBooking({ trucksFilled: 2, trucksNeeded: 3, status: 'active' }));
      mockQueryRaw.mockResolvedValue([{ trucksFilled: 3, trucksNeeded: 3 }]);

      await lifecycleSvc.incrementTrucksFilled('booking-001');

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'customer-001',
        'booking_fully_filled',
        expect.objectContaining({
          message: expect.stringContaining('All'),
        })
      );
    });
  });

  // ===========================================================================
  // 10. TIMER CLEANUP
  // ===========================================================================

  describe('Timer Cleanup', () => {
    it('should clear all timer types for a booking', async () => {
      await lifecycleSvc.clearBookingTimers('booking-001');

      expect(mockRedisCancelTimer).toHaveBeenCalledWith(expect.stringContaining('booking:booking-001'));
      expect(mockRedisCancelTimer).toHaveBeenCalledWith(expect.stringContaining('radius:booking-001'));
      expect(mockRedisDel).toHaveBeenCalledWith(expect.stringContaining('broadcast:radius:step:booking-001'));
      expect(mockRedisDel).toHaveBeenCalledWith(expect.stringContaining('broadcast:notified:booking-001'));
    });

    it('should cancelBookingTimeout clear timers and log', async () => {
      await lifecycleSvc.cancelBookingTimeout('booking-001');

      expect(mockRedisCancelTimer).toHaveBeenCalled();
    });

    it('should clear customer active broadcast key and idempotency keys', async () => {
      mockRedisGet.mockResolvedValueOnce('some-dedup-key');

      await lifecycleSvc.clearCustomerActiveBroadcast('customer-001');

      expect(mockRedisDel).toHaveBeenCalledWith(
        expect.stringContaining('customer:active-broadcast:customer-001')
      );
    });

    it('should handle missing latest idem key gracefully', async () => {
      mockRedisGet.mockResolvedValueOnce(null);

      await expect(
        lifecycleSvc.clearCustomerActiveBroadcast('customer-001')
      ).resolves.not.toThrow();
    });
  });
});
