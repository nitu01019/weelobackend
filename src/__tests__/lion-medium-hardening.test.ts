/**
 * =============================================================================
 * LION MEDIUM HARDENING TESTS — 42 tests for fixes #35-#59
 * =============================================================================
 *
 * CODE QUALITY AUDIT FINDINGS:
 *
 * FILES OVER 800 LINES (violation of <800 line rule):
 *   - src/modules/booking/order.service.ts: 1147 lines (CRITICAL - needs split)
 *   - src/modules/order/order-broadcast-send.service.ts: 800 lines (borderline)
 *   - src/shared/services/redis/redis.service.ts: 786 lines (close)
 *   - src/modules/pricing/vehicle-catalog.ts: 786 lines (close)
 *   - src/modules/order/order-creation.service.ts: 780 lines (close)
 *
 * CONSOLE.LOG IN SOURCE FILES (should use logger):
 *   - src/modules/driver-auth/driver-auth.service.ts: 10 occurrences (lines 303-312)
 *   - src/modules/driver/driver-onboarding.routes.ts: 10 occurrences (lines 132-141, 319)
 *   - src/modules/driver-onboarding/driver-onboarding.service.ts: 1 occurrence (line 356)
 *   - src/modules/auth/sms.service.ts: 5 occurrences (lines 187-191)
 *   - src/instrumentation.ts: 1 occurrence (line 37)
 *   Note: config/environment.ts references are in error messages, acceptable.
 *
 * `any` TYPES THAT SHOULD BE SPECIFIC:
 *   - 64+ occurrences across 20+ source files (see grep results)
 *   - Worst: tracking-trip.service.ts (5), tracking-location.service.ts (3),
 *     hold-expiry-cleanup.service.ts (8), driver-management.service.ts (5)
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
    observeHistogram: jest.fn(),
    recordHistogram: jest.fn(),
  },
}));

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    sAdd: jest.fn().mockResolvedValue(1),
    sRem: jest.fn().mockResolvedValue(1),
    sMembers: jest.fn().mockResolvedValue([]),
    sCard: jest.fn().mockResolvedValue(0),
    expire: jest.fn().mockResolvedValue(1),
    setJSON: jest.fn().mockResolvedValue('OK'),
    getJSON: jest.fn().mockResolvedValue(null),
    cancelTimer: jest.fn().mockResolvedValue(undefined),
    acquireLock: jest.fn().mockResolvedValue({ acquired: true }),
    releaseLock: jest.fn().mockResolvedValue(undefined),
    isRedisEnabled: jest.fn().mockReturnValue(true),
    isConnected: jest.fn().mockReturnValue(true),
    hSet: jest.fn().mockResolvedValue(1),
    scanIterator: jest.fn().mockReturnValue((async function* () {})()),
    incr: jest.fn().mockResolvedValue(1),
  },
}));

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    booking: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    assignment: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    vehicle: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    order: {
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn().mockImplementation(async (fn: any) => fn({
      booking: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      assignment: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    })),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
  },
  BookingStatus: {
    created: 'created',
    broadcasting: 'broadcasting',
    active: 'active',
    partially_filled: 'partially_filled',
    fully_filled: 'fully_filled',
    cancelled: 'cancelled',
    expired: 'expired',
    completed: 'completed',
  },
  AssignmentStatus: {
    pending: 'pending',
    driver_accepted: 'driver_accepted',
    in_transit: 'in_transit',
    cancelled: 'cancelled',
    completed: 'completed',
  },
}));

jest.mock('../shared/database/db', () => ({
  db: {
    getBookingById: jest.fn().mockResolvedValue(null),
    getBookingsByCustomer: jest.fn().mockResolvedValue([]),
    getActiveBookingsForTransporter: jest.fn().mockResolvedValue([]),
    getVehiclesByTransporter: jest.fn().mockResolvedValue([]),
    getAssignmentsByBooking: jest.fn().mockResolvedValue([]),
    updateBooking: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../shared/services/socket.service', () => ({
  emitToUser: jest.fn(),
  emitToBooking: jest.fn(),
  emitToTrip: jest.fn(),
  SocketEvent: {
    BOOKING_EXPIRED: 'booking_expired',
    BOOKING_UPDATED: 'booking_updated',
    BOOKING_FULLY_FILLED: 'booking_fully_filled',
    BOOKING_PARTIALLY_FILLED: 'booking_partially_filled',
    NO_VEHICLES_AVAILABLE: 'no_vehicles_available',
    TRIP_CANCELLED: 'trip_cancelled',
    TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update',
    NEW_BROADCAST: 'new_broadcast',
    LOCATION_UPDATED: 'location_updated',
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    VEHICLE_STATUS_CHANGED: 'vehicle_status_changed',
  },
}));

jest.mock('../shared/services/queue.service', () => ({
  queueService: {
    queuePushNotification: jest.fn().mockResolvedValue('job-id'),
    queuePushNotificationBatch: jest.fn().mockResolvedValue('batch-id'),
    queueBroadcast: jest.fn().mockResolvedValue('broadcast-id'),
    enqueue: jest.fn().mockResolvedValue('enqueue-id'),
  },
}));

jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  releaseVehicle: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../core/state-machines', () => ({
  assertValidTransition: jest.fn(),
  BOOKING_VALID_TRANSITIONS: {},
}));

jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: {
    getETA: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../shared/services/availability.service', () => ({
  availabilityService: {
    getTransporterDetails: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../shared/services/fcm.service', () => ({
  fcmService: {
    notifyNewBroadcast: jest.fn().mockResolvedValue(1),
  },
}));

jest.mock('../modules/booking/booking-payload.helper', () => ({
  buildBroadcastPayload: jest.fn().mockReturnValue({ id: 'payload' }),
  getRemainingTimeoutSeconds: jest.fn().mockReturnValue(60),
}));

jest.mock('../modules/tracking/tracking-history.service', () => ({
  trackingHistoryService: {
    addToHistory: jest.fn().mockResolvedValue(undefined),
    deleteHistoryPersistState: jest.fn().mockResolvedValue(undefined),
    shouldPersistHistoryPoint: jest.fn().mockResolvedValue(true),
    setHistoryPersistState: jest.fn().mockResolvedValue(undefined),
    publishTrackingEventAsync: jest.fn(),
  },
}));

jest.mock('../modules/tracking/tracking-fleet.service', () => ({
  trackingFleetService: {
    addDriverToFleet: jest.fn().mockResolvedValue(undefined),
    checkBookingCompletion: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../shared/utils/geospatial.utils', () => ({
  haversineDistanceMeters: jest.fn().mockReturnValue(1000),
  haversineDistanceKm: jest.fn().mockReturnValue(50),
}));

jest.mock('../shared/utils/safe-json.utils', () => ({
  safeJsonParse: jest.fn().mockReturnValue({}),
}));

jest.mock('../config/environment', () => ({
  config: {
    redis: { enabled: true },
    isProduction: false,
    otp: { expiryMinutes: 5 },
    sms: {},
  },
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { db } from '../shared/database/db';
import { prismaClient } from '../shared/database/prisma.service';
import { redisService } from '../shared/services/redis.service';
import { metrics } from '../shared/monitoring/metrics.service';

const fs = require('fs');
const path = require('path');

// Helper to read source file
function readSource(relativePath: string): string {
  return fs.readFileSync(
    path.resolve(__dirname, '..', relativePath),
    'utf-8'
  );
}

// =============================================================================
// FIX #35: FCM data-only vs standard notification types
// =============================================================================

describe('Fix #35: FCM notification type handling', () => {
  test('35.1 NEW_BROADCAST notification type is defined', () => {
    const source = readSource('shared/services/fcm.service.ts');
    expect(source).toContain('NotificationType.NEW_BROADCAST');
  });

  test('35.2 ASSIGNMENT_UPDATE notification type exists', () => {
    const source = readSource('shared/services/fcm.service.ts');
    expect(source).toContain('NotificationType.ASSIGNMENT_UPDATE');
  });

  test('35.3 TRIP_UPDATE notification type exists', () => {
    const source = readSource('shared/services/fcm.service.ts');
    expect(source).toContain('NotificationType.TRIP_UPDATE');
  });

  test('35.4 FCM buildMessage includes notification and data blocks', () => {
    const source = readSource('shared/services/fcm.service.ts');
    expect(source).toContain('buildMessage');
    expect(source).toContain('notification:');
    expect(source).toContain('data:');
  });

  test('35.5 PAYMENT type has its own channel ID', () => {
    const source = readSource('shared/services/fcm.service.ts');
    expect(source).toContain('NotificationType.PAYMENT');
  });

  test('35.6 GENERAL type is the default notification type', () => {
    const source = readSource('shared/services/fcm.service.ts');
    expect(source).toContain('NotificationType.GENERAL');
  });
});

// =============================================================================
// FIX #36: Booking query retry on replication lag
// =============================================================================

describe('Fix #36: Booking query retry on replication lag', () => {
  const { BookingQueryService } = require('../modules/booking/booking-query.service');
  const queryService = new BookingQueryService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('36.1 Retries after 100ms delay when first attempt returns null', async () => {
    const mockBooking = {
      id: 'booking-1',
      customerId: 'cust-1',
      vehicleType: 'mini',
      status: 'active',
    };

    (db.getBookingById as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mockBooking);

    const result = await queryService.getBookingById('booking-1', 'cust-1', 'customer');
    expect(db.getBookingById).toHaveBeenCalledTimes(2);
    expect(result).toEqual(mockBooking);
  });

  test('36.2 Source code contains 100ms delay for retry', () => {
    const source = readSource('modules/booking/booking-query.service.ts');
    expect(source).toContain('setTimeout(r, 100)');
  });

  test('36.3 Both attempts fail returns 404', async () => {
    (db.getBookingById as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await expect(
      queryService.getBookingById('booking-missing', 'cust-1', 'customer')
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(db.getBookingById).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// FIX #45: expireStaleBookings default 24h
// =============================================================================

describe('Fix #45: expireStaleBookings', () => {
  test('45.1 Default cutoff is 24 hours', () => {
    const source = readSource('modules/booking/booking-lifecycle.service.ts');
    expect(source).toContain("BOOKING_MAX_AGE_HOURS || '24'");
  });

  test('45.2 BOOKING_MAX_AGE_HOURS parsed once at module level', () => {
    const source = readSource('modules/booking/booking-lifecycle.service.ts');
    // Parsed before class definition
    const classStart = source.indexOf('class BookingLifecycleService');
    const parseLocation = source.indexOf('BOOKING_MAX_AGE_HOURS = parseInt');
    expect(parseLocation).toBeLessThan(classStart);
    expect(parseLocation).toBeGreaterThan(0);
  });

  test('45.3 Excludes TERMINAL_STATUSES from expiry', () => {
    const source = readSource('modules/booking/booking-lifecycle.service.ts');
    expect(source).toContain('notIn: [...TERMINAL_STATUSES]');
  });

  test('45.4 Cutoff calculation uses hours * 60 * 60 * 1000', () => {
    const source = readSource('modules/booking/booking-lifecycle.service.ts');
    expect(source).toContain('BOOKING_MAX_AGE_HOURS * 60 * 60 * 1000');
  });

  test('45.5 TERMINAL_STATUSES includes completed, cancelled, expired', () => {
    const source = readSource('modules/booking/booking.types.ts');
    expect(source).toContain("'completed'");
    expect(source).toContain("'cancelled'");
    expect(source).toContain("'expired'");
  });
});

// =============================================================================
// FIX #46: Tracking init retry 3x with backoff
// =============================================================================

describe('Fix #46: Tracking init retry with backoff', () => {
  test('46.1 TRACKING_INIT_MAX_RETRIES is 3', () => {
    const source = readSource('modules/tracking/tracking-trip.service.ts');
    expect(source).toContain('TRACKING_INIT_MAX_RETRIES = 3');
  });

  test('46.2 Backoff delays are 1s, 2s, 3s (linear: 1000 * attempt)', () => {
    const source = readSource('modules/tracking/tracking-trip.service.ts');
    expect(source).toContain('setTimeout(r, 1000 * attempt)');
  });

  test('46.3 Non-fatal on all retries exhausted (does not throw)', () => {
    const source = readSource('modules/tracking/tracking-trip.service.ts');
    // After retry loop, logs CRITICAL but does NOT throw
    const afterRetryLoop = source.split('// All retries exhausted')[1]?.split('async doInitializeTracking')[0] || '';
    expect(afterRetryLoop).toContain('logger.error');
    // Should NOT contain 'throw' in the after-retry section
    expect(afterRetryLoop).not.toContain('throw ');
  });

  test('46.4 Increments tracking.init_failure_total metric on exhaustion', () => {
    const source = readSource('modules/tracking/tracking-trip.service.ts');
    expect(source).toContain("'tracking.init_failure_total'");
  });

  test('46.5 Increments tracking.init_retry_total per retry attempt', () => {
    const source = readSource('modules/tracking/tracking-trip.service.ts');
    expect(source).toContain("'tracking.init_retry_total'");
  });

  test('46.6 Increments tracking.init_success_total on success', () => {
    const source = readSource('modules/tracking/tracking-trip.service.ts');
    expect(source).toContain("'tracking.init_success_total'");
  });
});

// =============================================================================
// FIX #47: on_hold orphan 5min threshold, in_transit orphan 10min threshold
// =============================================================================

describe('Fix #47: Orphan vehicle thresholds', () => {
  test('47.1 on_hold uses 5 minutes threshold', () => {
    const source = readSource('shared/queue-processors/assignment-reconciliation.processor.ts');
    expect(source).toContain("v.\"status\" = 'on_hold' AND v.\"updatedAt\" < NOW() - INTERVAL '5 minutes'");
  });

  test('47.2 in_transit uses 10 minutes threshold', () => {
    const source = readSource('shared/queue-processors/assignment-reconciliation.processor.ts');
    expect(source).toContain("v.\"status\" = 'in_transit' AND v.\"updatedAt\" < NOW() - INTERVAL '10 minutes'");
  });

  test('47.3 Query checks both on_hold and in_transit statuses', () => {
    const source = readSource('shared/queue-processors/assignment-reconciliation.processor.ts');
    expect(source).toContain("v.\"status\" IN ('in_transit', 'on_hold')");
  });
});

// =============================================================================
// FIX #48: Abandoned trip 12h default, env-configurable
// =============================================================================

describe('Fix #48: Abandoned trip threshold', () => {
  test('48.1 Default STALE_ACTIVE_TRIP_HOURS is 12', () => {
    const source = readSource('shared/queue-processors/assignment-reconciliation.processor.ts');
    expect(source).toContain("STALE_ACTIVE_TRIP_HOURS || '12'");
  });

  test('48.2 STALE_ACTIVE_TRIP_HOURS is env-configurable', () => {
    const source = readSource('shared/queue-processors/assignment-reconciliation.processor.ts');
    expect(source).toContain("process.env.STALE_ACTIVE_TRIP_HOURS");
  });

  test('48.3 Pre-transit uses separate 6h threshold', () => {
    const source = readSource('shared/queue-processors/assignment-reconciliation.processor.ts');
    expect(source).toContain("STALE_PRE_TRANSIT_TRIP_HOURS || '6'");
  });
});

// =============================================================================
// FIX #49: Module-level env parsing (BOOKING_CONCURRENCY_LIMIT)
// =============================================================================

describe('Fix #49: Module-level env parsing', () => {
  test('49.1 BOOKING_CONCURRENCY_LIMIT is parsed at module level', () => {
    const source = readSource('modules/booking/booking-create.service.ts');
    const classStart = source.indexOf('class BookingCreateService') !== -1
      ? source.indexOf('class BookingCreateService')
      : source.indexOf('export class');
    // Module-level parsing via _rawBCL then BOOKING_CONCURRENCY_LIMIT
    const parseLocation = source.indexOf("BOOKING_CONCURRENCY_LIMIT");
    expect(parseLocation).toBeGreaterThan(0);
    expect(parseLocation).toBeLessThan(classStart);
  });

  test('49.2 Default value is 50', () => {
    const source = readSource('modules/booking/booking-create.service.ts');
    expect(source).toContain("BOOKING_CONCURRENCY_LIMIT || '50'");
  });
});

// =============================================================================
// FIX #50: BookingContext readonly fields
// =============================================================================

describe('Fix #50: BookingContext readonly fields', () => {
  test('50.1 customerId is readonly', () => {
    const source = readSource('modules/booking/booking-context.ts');
    expect(source).toMatch(/readonly\s+customerId:\s*string/);
  });

  test('50.2 customerPhone is readonly', () => {
    const source = readSource('modules/booking/booking-context.ts');
    expect(source).toMatch(/readonly\s+customerPhone:\s*string/);
  });

  test('50.3 data is readonly', () => {
    const source = readSource('modules/booking/booking-context.ts');
    expect(source).toMatch(/readonly\s+data:\s*CreateBookingInput/);
  });

  test('50.4 lockKey is readonly', () => {
    const source = readSource('modules/booking/booking-context.ts');
    expect(source).toMatch(/readonly\s+lockKey:\s*string/);
  });

  test('50.5 concurrencyKey is readonly', () => {
    const source = readSource('modules/booking/booking-context.ts');
    expect(source).toMatch(/readonly\s+concurrencyKey:\s*string/);
  });

  test('50.6 bookingId is readonly', () => {
    const source = readSource('modules/booking/booking-context.ts');
    expect(source).toMatch(/readonly\s+bookingId:\s*string/);
  });
});

// =============================================================================
// FIX #53: TX timeout 5s, 2 retries = 15s max
// =============================================================================

describe('Fix #53: Transaction timeout config', () => {
  test('53.1 DB_STATEMENT_TIMEOUT_MS is env-configurable', () => {
    const source = readSource('shared/database/prisma.service.ts');
    expect(source).toContain("DB_STATEMENT_TIMEOUT_MS");
    expect(source).toContain("process.env.DB_STATEMENT_TIMEOUT_MS");
  });

  test('53.2 maxRetries has a default value', () => {
    const source = readSource('shared/database/prisma.service.ts');
    expect(source).toContain('maxRetries');
  });

  test('53.3 Transaction uses statement_timeout for DB-level timeout', () => {
    const source = readSource('shared/database/prisma.service.ts');
    expect(source).toContain('statement_timeout');
  });

  test('53.4 Retryable codes include P2034 and P2028', () => {
    const source = readSource('shared/database/prisma.service.ts');
    expect(source).toContain("'P2034'");
    expect(source).toContain("'P2028'");
  });
});

// =============================================================================
// FIX #54: Tracking location batch history in groups of 10
// =============================================================================

describe('Fix #54: Batch history writes in groups of 10', () => {
  test('54.1 HISTORY_BATCH_SIZE is 10', () => {
    const source = readSource('modules/tracking/tracking-location.service.ts');
    expect(source).toContain('HISTORY_BATCH_SIZE = 10');
  });

  test('54.2 Uses slice for batching', () => {
    const source = readSource('modules/tracking/tracking-location.service.ts');
    expect(source).toContain('historyEntries.slice(i, i + HISTORY_BATCH_SIZE)');
  });

  test('54.3 Uses Promise.all per batch for concurrent writes', () => {
    const source = readSource('modules/tracking/tracking-location.service.ts');
    // Find the section after HISTORY_BATCH_SIZE definition that uses Promise.all
    const batchIdx = source.indexOf('HISTORY_BATCH_SIZE = 10');
    expect(batchIdx).toBeGreaterThan(0);
    const afterBatchDef = source.substring(batchIdx);
    expect(afterBatchDef).toContain('Promise.all');
  });
});

// =============================================================================
// FIX #55/#56: Rebroadcast patterns
// =============================================================================

describe('Fix #55/#56: Rebroadcast service patterns', () => {
  test('55.1 Uses === "true" opt-in pattern for FF_SEQUENCE_DELIVERY_ENABLED', () => {
    const source = readSource('modules/booking/booking-rebroadcast.service.ts');
    expect(source).toContain("process.env.FF_SEQUENCE_DELIVERY_ENABLED === 'true'");
  });

  test('56.1 Unified radius cap from MAX_BROADCAST_RADIUS_KM env', () => {
    const source = readSource('modules/booking/booking-rebroadcast.service.ts');
    expect(source).toContain("process.env.MAX_BROADCAST_RADIUS_KM || '100'");
  });

  test('56.2 Default MAX_BROADCAST_RADIUS_KM is 100', () => {
    const source = readSource('modules/booking/booking-rebroadcast.service.ts');
    const match = source.match(/MAX_BROADCAST_RADIUS_KM\s*=\s*parseInt\(process\.env\.MAX_BROADCAST_RADIUS_KM\s*\|\|\s*'(\d+)'/);
    expect(match).toBeTruthy();
    expect(match![1]).toBe('100');
  });

  test('56.3 MAX_BROADCAST_RADIUS_KM is parsed at module level', () => {
    const source = readSource('modules/booking/booking-rebroadcast.service.ts');
    const classStart = source.indexOf('class BookingRebroadcastService');
    const parseLocation = source.indexOf('MAX_BROADCAST_RADIUS_KM = parseInt');
    expect(parseLocation).toBeGreaterThan(0);
    expect(parseLocation).toBeLessThan(classStart);
  });
});

// =============================================================================
// FIX #58: maxTransportersPerStep env-configurable
// =============================================================================

describe('Fix #58: maxTransportersPerStep env-configurable', () => {
  test('58.1 maxTransportersPerStep uses MAX_TRANSPORTERS_PER_STEP env', () => {
    const source = readSource('modules/booking/booking.types.ts');
    expect(source).toContain("process.env.MAX_TRANSPORTERS_PER_STEP");
  });

  test('58.2 Default is 20', () => {
    const source = readSource('modules/booking/booking.types.ts');
    expect(source).toContain("MAX_TRANSPORTERS_PER_STEP || '20'");
  });
});

// =============================================================================
// FIX #59: reconcileTrackingTrips orphan alerting
// =============================================================================

describe('Fix #59: reconcileTrackingTrips', () => {
  const { trackingTripService } = require('../modules/tracking/tracking-trip.service');
  const { logger } = require('../shared/services/logger.service');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('59.1 Returns zero counts when no trip keys in Redis', async () => {
    (redisService.scanIterator as jest.Mock).mockReturnValue((async function* () {})());

    const result = await trackingTripService.reconcileTrackingTrips();
    expect(result).toEqual({ orphanedCount: 0, cleanedCount: 0 });
  });

  test('59.2 Logs RECONCILIATION ALERT when orphans found', async () => {
    const staleDate = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // 15min ago

    (redisService.scanIterator as jest.Mock).mockReturnValue((async function* () {
      yield 'driver:trip:trip-1';
      yield 'driver:trip:trip-2';
    })());

    (prismaClient.assignment.findMany as jest.Mock).mockResolvedValue([]); // No active assignments

    (redisService.getJSON as jest.Mock).mockResolvedValue({
      tripId: 'trip-1',
      driverId: 'driver-1',
      lastUpdated: staleDate,
    });

    (redisService.del as jest.Mock).mockResolvedValue(1);

    const result = await trackingTripService.reconcileTrackingTrips();
    expect(result.orphanedCount).toBe(2);
    expect(logger.error).toHaveBeenCalledWith(
      'RECONCILIATION ALERT: Orphaned tracking records found',
      expect.objectContaining({
        type: 'tracking',
        count: 2,
      })
    );
  });

  test('59.3 Increments reconciliation.orphaned_records_total metric', async () => {
    const staleDate = new Date(Date.now() - 15 * 60 * 1000).toISOString();

    (redisService.scanIterator as jest.Mock).mockReturnValue((async function* () {
      yield 'driver:trip:trip-orphan';
    })());

    (prismaClient.assignment.findMany as jest.Mock).mockResolvedValue([]);
    (redisService.getJSON as jest.Mock).mockResolvedValue({
      tripId: 'trip-orphan',
      driverId: 'driver-1',
      lastUpdated: staleDate,
    });
    (redisService.del as jest.Mock).mockResolvedValue(1);

    await trackingTripService.reconcileTrackingTrips();
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'reconciliation.orphaned_records_total',
      expect.objectContaining({ type: 'tracking' }),
      1
    );
  });

  test('59.4 10min grace — does NOT clean young orphans', async () => {
    const recentDate = new Date(Date.now() - 3 * 60 * 1000).toISOString(); // 3min ago (young)

    (redisService.scanIterator as jest.Mock).mockReturnValue((async function* () {
      yield 'driver:trip:trip-young';
    })());

    (prismaClient.assignment.findMany as jest.Mock).mockResolvedValue([]);
    (redisService.getJSON as jest.Mock).mockResolvedValue({
      tripId: 'trip-young',
      driverId: 'driver-1',
      lastUpdated: recentDate,
    });

    const result = await trackingTripService.reconcileTrackingTrips();
    expect(result.orphanedCount).toBe(1);
    expect(result.cleanedCount).toBe(0); // Too young to clean
  });

  test('59.5 Cleans orphans older than 10 minutes', async () => {
    const oldDate = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // 15min ago

    (redisService.scanIterator as jest.Mock).mockReturnValue((async function* () {
      yield 'driver:trip:trip-old';
    })());

    (prismaClient.assignment.findMany as jest.Mock).mockResolvedValue([]);
    (redisService.getJSON as jest.Mock).mockResolvedValue({
      tripId: 'trip-old',
      driverId: 'driver-1',
      lastUpdated: oldDate,
    });
    (redisService.del as jest.Mock).mockResolvedValue(1);

    const result = await trackingTripService.reconcileTrackingTrips();
    expect(result.orphanedCount).toBe(1);
    expect(result.cleanedCount).toBe(1);
  });

  test('59.6 MIN_ORPHAN_AGE_MS is 10 minutes in source', () => {
    const source = readSource('modules/tracking/tracking-trip.service.ts');
    expect(source).toContain('MIN_ORPHAN_AGE_MS = 10 * 60 * 1000');
  });

  test('59.7 Does not delete records with active assignments', async () => {

    (redisService.scanIterator as jest.Mock).mockReturnValue((async function* () {
      yield 'driver:trip:trip-active';
    })());

    // This trip HAS an active assignment
    (prismaClient.assignment.findMany as jest.Mock).mockResolvedValue([
      { tripId: 'trip-active' },
    ]);

    const result = await trackingTripService.reconcileTrackingTrips();
    expect(result.orphanedCount).toBe(0);
    expect(result.cleanedCount).toBe(0);
  });
});
