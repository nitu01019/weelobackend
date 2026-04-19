/**
 * =============================================================================
 * FIX-10 / FIX-36 / FIX-27 — Driver & Lifecycle Hardening Tests
 * =============================================================================
 *
 * Covers:
 * - FIX-10 (#46): OTP rate limiter on driver onboarding routes
 * - FIX-36 (#87): GPS heartbeat coordinate validation
 * - FIX-27 (#51): Bounded findMany queries with take limits
 *
 * =============================================================================
 */

// =============================================================================
// MOCKS — must precede imports
// =============================================================================

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
    set: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn().mockResolvedValue(undefined),
    exists: jest.fn().mockResolvedValue(false),
    sAdd: jest.fn().mockResolvedValue(undefined),
    sRem: jest.fn().mockResolvedValue(undefined),
    sMembers: jest.fn().mockResolvedValue([]),
    setJSON: jest.fn().mockResolvedValue(undefined),
    getJSON: jest.fn().mockResolvedValue(null),
    acquireLock: jest.fn().mockResolvedValue({ acquired: true }),
    releaseLock: jest.fn().mockResolvedValue(undefined),
    checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 9, resetIn: 300 }),
    cancelTimer: jest.fn().mockResolvedValue(undefined),
    setTimer: jest.fn().mockResolvedValue(undefined),
    expire: jest.fn().mockResolvedValue(undefined),
    hSet: jest.fn().mockResolvedValue(undefined),
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
    multi: jest.fn().mockReturnValue({ del: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue([]) }),
  },
}));

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    booking: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    assignment: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    vehicle: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    orderLifecycleOutbox: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn().mockImplementation((fn: any) => {
      if (typeof fn === 'function') {
        return fn({
          booking: {
            findMany: jest.fn().mockResolvedValue([]),
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          },
          assignment: {
            findMany: jest.fn().mockResolvedValue([]),
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          },
        });
      }
      return Promise.resolve(fn);
    }),
    $queryRaw: jest.fn().mockResolvedValue([]),
  },
  BookingStatus: {
    created: 'created',
    broadcasting: 'broadcasting',
    active: 'active',
    partially_filled: 'partially_filled',
    fully_filled: 'fully_filled',
    expired: 'expired',
    cancelled: 'cancelled',
    completed: 'completed',
  },
  AssignmentStatus: {
    pending: 'pending',
    driver_accepted: 'driver_accepted',
    en_route_pickup: 'en_route_pickup',
    at_pickup: 'at_pickup',
    in_transit: 'in_transit',
    cancelled: 'cancelled',
    completed: 'completed',
  },
  OrderStatus: {
    created: 'created',
    broadcasting: 'broadcasting',
    active: 'active',
    partially_filled: 'partially_filled',
    fully_filled: 'fully_filled',
    expired: 'expired',
    cancelled: 'cancelled',
    completed: 'completed',
  },
}));

jest.mock('../shared/services/socket.service', () => ({
  socketService: {
    emitToUser: jest.fn(),
    emitToRoom: jest.fn(),
  },
  emitToUser: jest.fn(),
  emitToBooking: jest.fn(),
  isUserConnectedAsync: jest.fn().mockResolvedValue(false),
  SocketEvent: {
    BOOKING_EXPIRED: 'booking_expired',
    BOOKING_CANCELLED: 'booking_cancelled',
    BOOKING_UPDATED: 'booking_updated',
    BOOKING_FULLY_FILLED: 'booking_fully_filled',
    BOOKING_PARTIALLY_FILLED: 'booking_partially_filled',
    BROADCAST_STATE_CHANGED: 'broadcast_state_changed',
    NO_VEHICLES_AVAILABLE: 'no_vehicles_available',
    NEW_BROADCAST: 'new_broadcast',
    TRIP_CANCELLED: 'trip_cancelled',
    TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update',
  },
}));

jest.mock('../shared/services/fleet-cache.service', () => ({
  fleetCacheService: {
    invalidateDriverCache: jest.fn().mockResolvedValue(undefined),
    getTransporterDrivers: jest.fn().mockResolvedValue([]),
    getAvailableDrivers: jest.fn().mockResolvedValue([]),
    getDriver: jest.fn().mockResolvedValue(null),
  },
  onDriverChange: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../shared/services/fcm.service', () => ({
  fcmService: {
    notifyNewBroadcast: jest.fn().mockResolvedValue(0),
    sendPushNotification: jest.fn().mockResolvedValue(undefined),
  },
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    enqueue: jest.fn().mockResolvedValue(undefined),
    queuePushNotificationBatch: jest.fn().mockResolvedValue(undefined),
    queueBroadcast: jest.fn().mockResolvedValue(undefined),
    registerProcessor: jest.fn(),
  },
}));

jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../shared/services/live-availability.service', () => ({
  liveAvailabilityService: {
    getOnlineTransporters: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn().mockReturnValue('TRUCK:OPEN'),
}));

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    observeHistogram: jest.fn(),
    setGauge: jest.fn(),
    incrementGauge: jest.fn(),
    decrementGauge: jest.fn(),
  },
}));

jest.mock('../../src/modules/truck-hold/truck-hold.service', () => ({
  truckHoldService: {
    closeActiveHoldsForOrder: jest.fn().mockResolvedValue(0),
  },
}), { virtual: true });

jest.mock('../modules/truck-hold/truck-hold.service', () => ({
  truckHoldService: {
    closeActiveHoldsForOrder: jest.fn().mockResolvedValue(0),
  },
}));

jest.mock('../shared/database/db', () => ({
  db: {
    getBookingById: jest.fn().mockResolvedValue(null),
    getUserByPhone: jest.fn().mockResolvedValue(null),
    getUserById: jest.fn().mockResolvedValue(null),
    getOrderById: jest.fn().mockResolvedValue(null),
    getTruckRequestsByOrder: jest.fn().mockResolvedValue([]),
    updateTruckRequestsBatch: jest.fn().mockResolvedValue(undefined),
    updateOrder: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../core/state-machines', () => ({
  assertValidTransition: jest.fn(),
  BOOKING_VALID_TRANSITIONS: {},
}));

jest.mock('../modules/order/order-broadcast.service', () => ({
  emitToTransportersWithAdaptiveFanout: jest.fn().mockResolvedValue(undefined),
  emitDriverCancellationEvents: jest.fn(),
  withEventMeta: jest.fn((data: any) => data),
  clearCustomerActiveBroadcast: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../modules/order/order-timer.service', () => ({
  orderExpiryTimerKey: jest.fn().mockReturnValue('timer:order-expiry:test'),
  clearProgressiveStepTimers: jest.fn().mockResolvedValue(undefined),
}));

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../shared/services/logger.service';

// =============================================================================
// FIX-10: OTP rate limiter on driver onboarding routes
// =============================================================================

describe('FIX-10 — OTP rate limiter on driver onboarding routes', () => {
  const driverRoutesPath = path.resolve(__dirname, '../modules/driver/driver.routes.ts');

  it('driver.routes.ts file exists', () => {
    expect(fs.existsSync(driverRoutesPath)).toBe(true);
  });

  it('imports otpRateLimiter from rate-limiter middleware', () => {
    const source = fs.readFileSync(driverRoutesPath, 'utf-8');
    expect(source).toMatch(/import\s*\{[^}]*otpRateLimiter[^}]*\}\s*from\s*'\.\.\/\.\.\/shared\/middleware\/rate-limiter\.middleware'/);
  });

  it('/onboard/initiate route has otpRateLimiter middleware', () => {
    const source = fs.readFileSync(driverRoutesPath, 'utf-8');
    // The otpRateLimiter must appear between '/onboard/initiate' and 'authMiddleware'
    const initiateBlock = source.substring(
      source.indexOf("'/onboard/initiate'"),
      source.indexOf("'/onboard/initiate'") + 300
    );
    expect(initiateBlock).toContain('otpRateLimiter');
  });

  it('/onboard/verify route has verifyOtpRateLimiter middleware (Issue #21)', () => {
    const source = fs.readFileSync(driverRoutesPath, 'utf-8');
    const verifyBlock = source.substring(
      source.indexOf("'/onboard/verify'"),
      source.indexOf("'/onboard/verify'") + 300
    );
    expect(verifyBlock).toContain('verifyOtpRateLimiter');
  });

  it('/onboard/resend route has otpRateLimiter middleware', () => {
    const source = fs.readFileSync(driverRoutesPath, 'utf-8');
    const resendBlock = source.substring(
      source.indexOf("'/onboard/resend'"),
      source.indexOf("'/onboard/resend'") + 300
    );
    expect(resendBlock).toContain('otpRateLimiter');
  });

  it('otpRateLimiter is exported from rate-limiter middleware', () => {
    const { otpRateLimiter } = require('../shared/middleware/rate-limiter.middleware');
    expect(otpRateLimiter).toBeDefined();
    expect(typeof otpRateLimiter).toBe('function');
  });

  it('non-OTP routes do NOT have otpRateLimiter (e.g. /create)', () => {
    const source = fs.readFileSync(driverRoutesPath, 'utf-8');
    // The /create route block should NOT contain otpRateLimiter
    const createIdx = source.indexOf("'/create'");
    expect(createIdx).toBeGreaterThan(-1);
    const createBlock = source.substring(createIdx, createIdx + 200);
    expect(createBlock).not.toContain('otpRateLimiter');
  });
});

// =============================================================================
// FIX-36: GPS heartbeat coordinate validation
// =============================================================================

describe('FIX-36 — GPS heartbeat coordinate validation', () => {
  let driverPresenceService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-require to get fresh instance with mocks applied
    jest.isolateModules(() => {
      driverPresenceService = require('../modules/driver/driver-presence.service').driverPresenceService;
    });
  });

  it('rejects NaN latitude', async () => {
    await driverPresenceService.handleHeartbeat('driver-1', { lat: NaN, lng: 77.2 });
    expect(logger.warn).toHaveBeenCalledWith(
      '[Presence] Invalid GPS coordinates rejected',
      expect.objectContaining({ driverId: 'driver-1' })
    );
  });

  it('rejects NaN longitude', async () => {
    await driverPresenceService.handleHeartbeat('driver-2', { lat: 28.6, lng: NaN });
    expect(logger.warn).toHaveBeenCalledWith(
      '[Presence] Invalid GPS coordinates rejected',
      expect.objectContaining({ driverId: 'driver-2' })
    );
  });

  it('rejects latitude > 90', async () => {
    await driverPresenceService.handleHeartbeat('driver-3', { lat: 91, lng: 77.2 });
    expect(logger.warn).toHaveBeenCalledWith(
      '[Presence] Invalid GPS coordinates rejected',
      expect.objectContaining({ driverId: 'driver-3', lat: 91 })
    );
  });

  it('rejects latitude < -90', async () => {
    await driverPresenceService.handleHeartbeat('driver-4', { lat: -91, lng: 77.2 });
    expect(logger.warn).toHaveBeenCalledWith(
      '[Presence] Invalid GPS coordinates rejected',
      expect.objectContaining({ driverId: 'driver-4', lat: -91 })
    );
  });

  it('rejects longitude > 180', async () => {
    await driverPresenceService.handleHeartbeat('driver-5', { lat: 28.6, lng: 181 });
    expect(logger.warn).toHaveBeenCalledWith(
      '[Presence] Invalid GPS coordinates rejected',
      expect.objectContaining({ driverId: 'driver-5', lng: 181 })
    );
  });

  it('rejects longitude < -180', async () => {
    await driverPresenceService.handleHeartbeat('driver-6', { lat: 28.6, lng: -181 });
    expect(logger.warn).toHaveBeenCalledWith(
      '[Presence] Invalid GPS coordinates rejected',
      expect.objectContaining({ driverId: 'driver-6', lng: -181 })
    );
  });

  it('rejects Infinity latitude', async () => {
    await driverPresenceService.handleHeartbeat('driver-7', { lat: Infinity, lng: 77.2 });
    expect(logger.warn).toHaveBeenCalledWith(
      '[Presence] Invalid GPS coordinates rejected',
      expect.objectContaining({ driverId: 'driver-7' })
    );
  });

  it('rejects -Infinity longitude', async () => {
    await driverPresenceService.handleHeartbeat('driver-8', { lat: 28.6, lng: -Infinity });
    expect(logger.warn).toHaveBeenCalledWith(
      '[Presence] Invalid GPS coordinates rejected',
      expect.objectContaining({ driverId: 'driver-8' })
    );
  });

  it('rejects string lat passed as number field', async () => {
    await driverPresenceService.handleHeartbeat('driver-9', { lat: 'not-a-number' as any, lng: 77.2 });
    expect(logger.warn).toHaveBeenCalledWith(
      '[Presence] Invalid GPS coordinates rejected',
      expect.objectContaining({ driverId: 'driver-9' })
    );
  });

  it('rejects when lat is provided but lng is null', async () => {
    await driverPresenceService.handleHeartbeat('driver-10', { lat: 28.6, lng: null as any });
    expect(logger.warn).toHaveBeenCalledWith(
      '[Presence] Invalid GPS coordinates rejected',
      expect.objectContaining({ driverId: 'driver-10' })
    );
  });

  it('accepts valid GPS coordinates (Delhi: 28.6, 77.2)', async () => {
    const { redisService } = require('../shared/services/redis.service');
    redisService.exists.mockResolvedValueOnce(true);
    redisService.set.mockResolvedValueOnce(undefined);

    await driverPresenceService.handleHeartbeat('driver-valid', { lat: 28.6, lng: 77.2 });
    // Should NOT log a rejection warning
    expect(logger.warn).not.toHaveBeenCalledWith(
      '[Presence] Invalid GPS coordinates rejected',
      expect.anything()
    );
  });

  it('accepts valid edge-case coordinates (lat 0, lng 0 — Gulf of Guinea)', async () => {
    const { redisService } = require('../shared/services/redis.service');
    redisService.exists.mockResolvedValueOnce(true);
    redisService.set.mockResolvedValueOnce(undefined);

    await driverPresenceService.handleHeartbeat('driver-zero', { lat: 0, lng: 0 });
    expect(logger.warn).not.toHaveBeenCalledWith(
      '[Presence] Invalid GPS coordinates rejected',
      expect.anything()
    );
  });

  it('accepts valid boundary coordinates (lat 90, lng 180)', async () => {
    const { redisService } = require('../shared/services/redis.service');
    redisService.exists.mockResolvedValueOnce(true);
    redisService.set.mockResolvedValueOnce(undefined);

    await driverPresenceService.handleHeartbeat('driver-boundary', { lat: 90, lng: 180 });
    expect(logger.warn).not.toHaveBeenCalledWith(
      '[Presence] Invalid GPS coordinates rejected',
      expect.anything()
    );
  });

  it('accepts valid negative boundary coordinates (lat -90, lng -180)', async () => {
    const { redisService } = require('../shared/services/redis.service');
    redisService.exists.mockResolvedValueOnce(true);
    redisService.set.mockResolvedValueOnce(undefined);

    await driverPresenceService.handleHeartbeat('driver-neg-boundary', { lat: -90, lng: -180 });
    expect(logger.warn).not.toHaveBeenCalledWith(
      '[Presence] Invalid GPS coordinates rejected',
      expect.anything()
    );
  });

  it('accepts heartbeat with no GPS data (lat/lng both undefined)', async () => {
    const { redisService } = require('../shared/services/redis.service');
    redisService.exists.mockResolvedValueOnce(true);
    redisService.set.mockResolvedValueOnce(undefined);

    await driverPresenceService.handleHeartbeat('driver-no-gps', { battery: 80 });
    // No GPS coordinates means no validation needed — should not warn
    expect(logger.warn).not.toHaveBeenCalledWith(
      '[Presence] Invalid GPS coordinates rejected',
      expect.anything()
    );
  });
});

// =============================================================================
// FIX-27: Bounded findMany queries
// =============================================================================

describe('FIX-27 — Bounded findMany queries with take limits', () => {

  describe('booking-lifecycle.service.ts', () => {
    const lifecyclePath = path.resolve(__dirname, '../modules/booking/booking-lifecycle.service.ts');

    it('resumeInterruptedBroadcasts findMany has take: 100', () => {
      const source = fs.readFileSync(lifecyclePath, 'utf-8');
      // Find the staleBroadcasts findMany block
      const staleBroadcastsIdx = source.indexOf("status: 'broadcasting'");
      expect(staleBroadcastsIdx).toBeGreaterThan(-1);
      // Get surrounding context (the findMany call)
      const block = source.substring(staleBroadcastsIdx - 100, staleBroadcastsIdx + 300);
      expect(block).toContain('take: 100');
    });

    it('expireStaleBookings findMany has take: 100', () => {
      const source = fs.readFileSync(lifecyclePath, 'utf-8');
      // Find the staleBookings findMany block (it has createdAt: { lt: cutoff })
      const staleBookingsIdx = source.indexOf('createdAt: { lt: cutoff }');
      expect(staleBookingsIdx).toBeGreaterThan(-1);
      const block = source.substring(staleBookingsIdx, staleBookingsIdx + 200);
      expect(block).toContain('take: 100');
    });
  });

  describe('booking-broadcast.service.ts', () => {
    const broadcastPath = path.resolve(__dirname, '../modules/booking/booking-broadcast.service.ts');

    it('eligibleRows findMany has take: 500', () => {
      const source = fs.readFileSync(broadcastPath, 'utf-8');
      // Find the vehicle.findMany block (batch eligibility check)
      const eligibleIdx = source.indexOf("distinct: ['transporterId']");
      expect(eligibleIdx).toBeGreaterThan(-1);
      const block = source.substring(eligibleIdx - 50, eligibleIdx + 200);
      expect(block).toContain('take: 500');
    });

    it('verifiedRows findMany has take: 500', () => {
      const source = fs.readFileSync(broadcastPath, 'utf-8');
      // Find the KYC verification findMany block
      const verifiedIdx = source.indexOf('isVerified: true');
      expect(verifiedIdx).toBeGreaterThan(-1);
      const block = source.substring(verifiedIdx, verifiedIdx + 200);
      expect(block).toContain('take: 500');
    });
  });

  describe('order-lifecycle-outbox.service.ts', () => {
    const outboxPath = path.resolve(__dirname, '../modules/order/order-lifecycle-outbox.service.ts');

    it('activeAssignments findMany has take: 200', () => {
      const source = fs.readFileSync(outboxPath, 'utf-8');
      // Find the first assignment.findMany in handleOrderExpiry (cancellableAssignmentStatuses)
      const activeIdx = source.indexOf('cancellableAssignmentStatuses');
      expect(activeIdx).toBeGreaterThan(-1);
      // Look for the first findMany after this point
      const fromActive = source.substring(activeIdx);
      const findManyIdx = fromActive.indexOf('assignment.findMany');
      expect(findManyIdx).toBeGreaterThan(-1);
      const block = fromActive.substring(findManyIdx, findManyIdx + 400);
      expect(block).toContain('take: 200');
    });

    it('activeAssignments findMany has select clause', () => {
      const source = fs.readFileSync(outboxPath, 'utf-8');
      const activeIdx = source.indexOf('cancellableAssignmentStatuses');
      const fromActive = source.substring(activeIdx);
      const findManyIdx = fromActive.indexOf('assignment.findMany');
      const block = fromActive.substring(findManyIdx, findManyIdx + 400);
      expect(block).toContain('select:');
      expect(block).toContain('driverId: true');
      expect(block).toContain('vehicleId: true');
      expect(block).toContain('tripId: true');
    });

    it('cancelledAssignments findMany has take: 200', () => {
      const source = fs.readFileSync(outboxPath, 'utf-8');
      // Find the re-fetch for cancelled assignments
      const cancelledIdx = source.indexOf('AssignmentStatus.cancelled');
      expect(cancelledIdx).toBeGreaterThan(-1);
      // Find the findMany that checks for cancelled status
      const fromCancelled = source.substring(cancelledIdx);
      const secondBlock = fromCancelled.substring(fromCancelled.indexOf('findMany'));
      expect(secondBlock.substring(0, 400)).toContain('take: 200');
    });

    it('cancelledAssignments findMany has select clause', () => {
      const source = fs.readFileSync(outboxPath, 'utf-8');
      const cancelledIdx = source.indexOf('AssignmentStatus.cancelled');
      const fromCancelled = source.substring(cancelledIdx);
      const secondBlock = fromCancelled.substring(fromCancelled.indexOf('findMany'));
      const blockText = secondBlock.substring(0, 400);
      expect(blockText).toContain('select:');
    });

    it('claimReadyLifecycleOutboxRows already has take parameter (pre-existing)', () => {
      const source = fs.readFileSync(outboxPath, 'utf-8');
      // claimReadyLifecycleOutboxRows uses $queryRaw with LIMIT instead of Prisma take
      const claimIdx = source.indexOf('claimReadyLifecycleOutboxRows');
      expect(claimIdx).toBeGreaterThan(-1);
      const block = source.substring(claimIdx, claimIdx + 1000);
      expect(block).toContain('LIMIT');
    });
  });
});

// =============================================================================
// FIX-36 (source code verification): Validation exists in presence service
// =============================================================================

describe('FIX-36 — GPS validation exists in source code', () => {
  const presencePath = path.resolve(__dirname, '../modules/driver/driver-presence.service.ts');

  it('handleHeartbeat method validates lat range [-90, 90]', () => {
    const source = fs.readFileSync(presencePath, 'utf-8');
    expect(source).toContain('lat < -90');
    expect(source).toContain('lat > 90');
  });

  it('handleHeartbeat method validates lng range [-180, 180]', () => {
    const source = fs.readFileSync(presencePath, 'utf-8');
    expect(source).toContain('lng < -180');
    expect(source).toContain('lng > 180');
  });

  it('handleHeartbeat method checks isFinite', () => {
    const source = fs.readFileSync(presencePath, 'utf-8');
    expect(source).toContain('isFinite(lat)');
    expect(source).toContain('isFinite(lng)');
  });

  it('handleHeartbeat method checks typeof number', () => {
    const source = fs.readFileSync(presencePath, 'utf-8');
    expect(source).toContain("typeof lat !== 'number'");
    expect(source).toContain("typeof lng !== 'number'");
  });

  it('logs a warning with driverId when rejecting invalid coordinates', () => {
    const source = fs.readFileSync(presencePath, 'utf-8');
    expect(source).toContain("'[Presence] Invalid GPS coordinates rejected'");
    expect(source).toContain('driverId, lat, lng');
  });
});
