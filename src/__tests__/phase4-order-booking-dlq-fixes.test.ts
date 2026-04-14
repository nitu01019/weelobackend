/**
 * =============================================================================
 * PHASE 4: ORDER + BOOKING + DLQ FIXES TESTS
 * =============================================================================
 *
 * Validates four production fixes:
 *
 *  H2: Math.max(1, Math.round) distance normalization (order.contract.ts)
 *      - distanceKm uses Math.round (not Math.floor)
 *      - distanceKm is clamped to minimum 1
 *      - No Math.floor on distanceKm line
 *
 *  M5: routePoints distance refine (booking.schema.ts)
 *      - Second .refine() exists for routePoints
 *      - Checks first/last point distance >= 500m
 *      - Uses Haversine formula (R = 6371, sin, cos, atan2)
 *
 *  M10: Legacy lock + rate limit (booking.routes.ts)
 *      - acquireLock in legacy POST /bookings/ handler
 *      - checkRateLimit or rate limit logic exists
 *      - Lock release in finally block
 *      - 409 for concurrent requests
 *
 *  H3: DLQ metric + admin re-drive (order-dispatch-outbox.service.ts + admin)
 *      - dispatch_dlq_total metric on retry exhaustion
 *      - logger.error on retry exhaustion
 *      - redriveFailedDispatch function exists
 *      - POST /dispatch-outbox/:orderId/retry admin route
 *
 * @author Team Lita, Agent 3
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP -- Must come before any imports
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
  },
}));

// =============================================================================
// HELPERS
// =============================================================================

const fs = require('fs');
const path = require('path');

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, relativePath), 'utf-8');
}

// =============================================================================
// H2 TESTS: Math.max(1, Math.round) distance normalization
// =============================================================================

describe('H2: Math.max(1, Math.round) distance normalization (order.contract.ts)', () => {
  const contractSource = readSource('../modules/order/order.contract.ts');

  // ---------------------------------------------------------------------------
  // H2.1: distanceKm uses Math.round (not Math.floor)
  // ---------------------------------------------------------------------------
  test('H2.1: distanceKm normalization uses Math.round', () => {
    const distanceLine = contractSource
      .split('\n')
      .find((line: string) => line.includes('distanceKm') && line.includes('Math.'));
    expect(distanceLine).toBeDefined();
    expect(distanceLine).toContain('Math.round');
  });

  // ---------------------------------------------------------------------------
  // H2.2: distanceKm is clamped to minimum 1 via Math.max(1, ...)
  // ---------------------------------------------------------------------------
  test('H2.2: distanceKm is clamped to minimum 1 via Math.max(1, ...)', () => {
    expect(contractSource).toContain('Math.max(1, Math.round(');
  });

  // ---------------------------------------------------------------------------
  // H2.3: No Math.floor on the distanceKm line
  // ---------------------------------------------------------------------------
  test('H2.3: distanceKm line does NOT use Math.floor', () => {
    const distanceLine = contractSource
      .split('\n')
      .find(
        (line: string) => line.includes('distanceKm') && line.includes('Math.')
      );
    expect(distanceLine).toBeDefined();
    expect(distanceLine).not.toContain('Math.floor');
  });

  // ---------------------------------------------------------------------------
  // H2.4: Pattern is exactly Math.max(1, Math.round(parseNumber(...)))
  // ---------------------------------------------------------------------------
  test('H2.4: Full pattern is Math.max(1, Math.round(parseNumber(input.distanceKm, ...)))', () => {
    const pattern = /Math\.max\(\s*1\s*,\s*Math\.round\(\s*parseNumber\(\s*input\.distanceKm/;
    expect(contractSource).toMatch(pattern);
  });

  // ---------------------------------------------------------------------------
  // H2.5: distanceKm assignment is on a single line (no multi-line split)
  // ---------------------------------------------------------------------------
  test('H2.5: distanceKm assignment is a single expression', () => {
    const lines = contractSource.split('\n');
    const distanceLines = lines.filter(
      (line: string) =>
        line.includes('const distanceKm') && line.includes('Math.max')
    );
    expect(distanceLines.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // H2.6: Behavioral test -- normalizeCreateOrderInput rounds distance
  // ---------------------------------------------------------------------------
  test('H2.6: normalizeCreateOrderInput rounds 4.7 to 5', () => {
    const { normalizeCreateOrderInput } = require('../modules/order/order.contract');
    const result = normalizeCreateOrderInput({
      pickup: { latitude: 12.9, longitude: 77.5, address: 'A' },
      drop: { latitude: 13.0, longitude: 77.6, address: 'B' },
      distanceKm: 4.7,
      vehicleRequirements: [
        { vehicleType: 'open', vehicleSubtype: '17ft', quantity: 1, pricePerTruck: 1000 },
      ],
    });
    expect(result.distanceKm).toBe(5);
  });

  // ---------------------------------------------------------------------------
  // H2.7: Behavioral test -- normalizeCreateOrderInput clamps 0.3 to 1
  // ---------------------------------------------------------------------------
  test('H2.7: normalizeCreateOrderInput clamps 0.3 to minimum 1', () => {
    const { normalizeCreateOrderInput } = require('../modules/order/order.contract');
    const result = normalizeCreateOrderInput({
      pickup: { latitude: 12.9, longitude: 77.5, address: 'A' },
      drop: { latitude: 13.0, longitude: 77.6, address: 'B' },
      distanceKm: 0.3,
      vehicleRequirements: [
        { vehicleType: 'open', vehicleSubtype: '17ft', quantity: 1, pricePerTruck: 1000 },
      ],
    });
    expect(result.distanceKm).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // H2.8: Behavioral test -- normalizeCreateOrderInput rounds 10.5 to 11
  // ---------------------------------------------------------------------------
  test('H2.8: normalizeCreateOrderInput rounds 10.5 to 11 (not floors to 10)', () => {
    const { normalizeCreateOrderInput } = require('../modules/order/order.contract');
    const result = normalizeCreateOrderInput({
      pickup: { latitude: 12.9, longitude: 77.5, address: 'A' },
      drop: { latitude: 13.0, longitude: 77.6, address: 'B' },
      distanceKm: 10.5,
      vehicleRequirements: [
        { vehicleType: 'open', vehicleSubtype: '17ft', quantity: 1, pricePerTruck: 1000 },
      ],
    });
    // Math.round(10.5) === 11 in JS (rounds to even is not used)
    expect(result.distanceKm).toBe(11);
  });

  // ---------------------------------------------------------------------------
  // H2.9: Behavioral test -- integer distances pass through unchanged
  // ---------------------------------------------------------------------------
  test('H2.9: normalizeCreateOrderInput passes integer 42 unchanged', () => {
    const { normalizeCreateOrderInput } = require('../modules/order/order.contract');
    const result = normalizeCreateOrderInput({
      pickup: { latitude: 12.9, longitude: 77.5, address: 'A' },
      drop: { latitude: 13.0, longitude: 77.6, address: 'B' },
      distanceKm: 42,
      vehicleRequirements: [
        { vehicleType: 'open', vehicleSubtype: '17ft', quantity: 1, pricePerTruck: 1000 },
      ],
    });
    expect(result.distanceKm).toBe(42);
  });
});

// =============================================================================
// M5 TESTS: routePoints distance refine (booking.schema.ts)
// =============================================================================

describe('M5: routePoints distance refine (booking.schema.ts)', () => {
  const bookingSchemaSource = readSource('../modules/booking/booking.schema.ts');

  // ---------------------------------------------------------------------------
  // M5.1: Second .refine() exists in createOrderSchema for routePoints
  // ---------------------------------------------------------------------------
  test('M5.1: createOrderSchema has a .refine() with M5 FIX comment for routePoints', () => {
    expect(bookingSchemaSource).toContain('M5 FIX');
    expect(bookingSchemaSource).toContain('routePoints');
  });

  // ---------------------------------------------------------------------------
  // M5.2: The refine checks first and last routePoint distance
  // ---------------------------------------------------------------------------
  test('M5.2: M5 refine accesses first and last routePoints', () => {
    // The refine must extract first and last from data.routePoints
    const m5Section = bookingSchemaSource.slice(
      bookingSchemaSource.indexOf('M5 FIX')
    );
    expect(m5Section).toContain('routePoints[0]');
    expect(m5Section).toContain('routePoints[data.routePoints.length - 1]');
  });

  // ---------------------------------------------------------------------------
  // M5.3: Uses Haversine formula constants (R = 6371, sin, cos, atan2)
  // ---------------------------------------------------------------------------
  test('M5.3: M5 refine uses Haversine formula (R = 6371, sin, cos, atan2)', () => {
    const m5Section = bookingSchemaSource.slice(
      bookingSchemaSource.indexOf('M5 FIX')
    );
    expect(m5Section).toContain('6371');
    expect(m5Section).toContain('Math.sin');
    expect(m5Section).toContain('Math.cos');
    expect(m5Section).toContain('Math.atan2');
  });

  // ---------------------------------------------------------------------------
  // M5.4: Distance threshold is 0.5 (500 meters = 0.5 km)
  // ---------------------------------------------------------------------------
  test('M5.4: Distance threshold is 0.5 km (500 meters)', () => {
    const m5Section = bookingSchemaSource.slice(
      bookingSchemaSource.indexOf('M5 FIX')
    );
    expect(m5Section).toContain('>= 0.5');
  });

  // ---------------------------------------------------------------------------
  // M5.5: Error message mentions 500m
  // ---------------------------------------------------------------------------
  test('M5.5: Refine error message mentions 500m distance requirement', () => {
    expect(bookingSchemaSource).toContain(
      'Route start and end points must be at least 500m apart'
    );
  });

  // ---------------------------------------------------------------------------
  // M5.6: The refine skips when routePoints has fewer than 2 items
  // ---------------------------------------------------------------------------
  test('M5.6: M5 refine returns true when routePoints has < 2 items', () => {
    const m5Section = bookingSchemaSource.slice(
      bookingSchemaSource.indexOf('M5 FIX')
    );
    expect(m5Section).toContain('data.routePoints.length < 2');
  });

  // ---------------------------------------------------------------------------
  // M5.7: The refine skips when pickup/drop fields are present
  // ---------------------------------------------------------------------------
  test('M5.7: M5 refine skips when pickup/drop are also provided', () => {
    const m5Section = bookingSchemaSource.slice(
      bookingSchemaSource.indexOf('M5 FIX')
    );
    expect(m5Section).toContain('data.pickup && data.drop');
  });

  // ---------------------------------------------------------------------------
  // M5.8: Behavioral test -- routePoints too close together fails validation
  // ---------------------------------------------------------------------------
  test('M5.8: createOrderSchema rejects routePoints with start/end < 500m apart', () => {
    const { createOrderSchema } = require('../modules/booking/booking.schema');

    // Two points ~0m apart (same location)
    const input = {
      routePoints: [
        {
          type: 'PICKUP',
          coordinates: { latitude: 12.9716, longitude: 77.5946 },
          address: 'Point A',
        },
        {
          type: 'DROP',
          coordinates: { latitude: 12.9716, longitude: 77.5946 },
          address: 'Point B',
        },
      ],
      distanceKm: 5,
      trucks: [
        { vehicleType: 'open', vehicleSubtype: '17ft', quantity: 1, pricePerTruck: 1000 },
      ],
    };

    const result = createOrderSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.errors.map((e: any) => e.message);
      expect(
        messages.some((m: string) => m.includes('500m') || m.includes('500 meters'))
      ).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // M5.9: Behavioral test -- routePoints far apart passes validation
  // ---------------------------------------------------------------------------
  test('M5.9: createOrderSchema accepts routePoints with start/end > 500m apart', () => {
    const { createOrderSchema } = require('../modules/booking/booking.schema');

    // Delhi (28.6139, 77.2090) to Jaipur-direction (~50km away)
    const input = {
      routePoints: [
        {
          type: 'PICKUP',
          coordinates: { latitude: 28.6139, longitude: 77.209 },
          address: 'Delhi',
        },
        {
          type: 'DROP',
          coordinates: { latitude: 28.2, longitude: 76.8 },
          address: 'Towards Jaipur',
        },
      ],
      distanceKm: 50,
      trucks: [
        { vehicleType: 'open', vehicleSubtype: '17ft', quantity: 1, pricePerTruck: 5000 },
      ],
    };

    const result = createOrderSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // M5.10: Behavioral test -- skips routePoints refine when pickup/drop given
  // ---------------------------------------------------------------------------
  test('M5.10: createOrderSchema skips routePoints refine when pickup and drop are provided', () => {
    const { createOrderSchema } = require('../modules/booking/booking.schema');

    // routePoints are close, but pickup/drop are also provided (different refine handles that)
    const input = {
      routePoints: [
        {
          type: 'PICKUP',
          coordinates: { latitude: 12.9716, longitude: 77.5946 },
          address: 'Same place A',
        },
        {
          type: 'DROP',
          coordinates: { latitude: 12.9716, longitude: 77.5946 },
          address: 'Same place B',
        },
      ],
      pickup: {
        coordinates: { latitude: 28.6139, longitude: 77.209 },
        address: 'Delhi',
      },
      drop: {
        coordinates: { latitude: 28.2, longitude: 76.8 },
        address: 'Towards Jaipur',
      },
      distanceKm: 50,
      trucks: [
        { vehicleType: 'open', vehicleSubtype: '17ft', quantity: 1, pricePerTruck: 5000 },
      ],
    };

    const result = createOrderSchema.safeParse(input);
    // M5 refine returns true because pickup/drop are provided
    // The pickup/drop refine checks those locations and they are far apart -> passes
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// M10 TESTS: Legacy lock + rate limit (booking.routes.ts)
// =============================================================================

describe('M10: Legacy lock + rate limit (booking.routes.ts)', () => {
  const bookingRoutesSource = readSource('../modules/booking/booking.routes.ts');

  // ---------------------------------------------------------------------------
  // M10.1: acquireLock exists in legacy POST /bookings/ handler
  // ---------------------------------------------------------------------------
  test('M10.1: acquireLock is called in legacy POST / handler', () => {
    // The legacy handler is router.post('/', ...) with FF_LEGACY_BOOKING_PROXY_TO_ORDER guard
    const legacyBlock = bookingRoutesSource.slice(
      bookingRoutesSource.indexOf("router.post(\n  '/',"),
      bookingRoutesSource.indexOf("router.get(\n  '/',")
    );
    expect(legacyBlock).toContain('acquireLock');
  });

  // ---------------------------------------------------------------------------
  // M10.2: M10 FIX comment is present
  // ---------------------------------------------------------------------------
  test('M10.2: M10 FIX comment exists in the legacy handler', () => {
    expect(bookingRoutesSource).toContain('M10 FIX');
  });

  // ---------------------------------------------------------------------------
  // M10.3: Lock key uses customer ID
  // ---------------------------------------------------------------------------
  test('M10.3: Lock key is based on order:create:{customerId}', () => {
    // The lock key in the legacy handler section
    const legacySection = bookingRoutesSource.slice(
      0,
      bookingRoutesSource.indexOf("router.get(\n  '/',")
    );
    expect(legacySection).toContain('`order:create:${customerId}`');
  });

  // ---------------------------------------------------------------------------
  // M10.4: checkRateLimit or rate limit logic exists
  // ---------------------------------------------------------------------------
  test('M10.4: checkRateLimit is called in legacy handler', () => {
    const legacySection = bookingRoutesSource.slice(
      0,
      bookingRoutesSource.indexOf("router.get(\n  '/',")
    );
    expect(legacySection).toContain('checkRateLimit');
  });

  // ---------------------------------------------------------------------------
  // M10.5: Rate limit key uses order_create:{customerId}
  // ---------------------------------------------------------------------------
  test('M10.5: Rate limit key is order_create:{customerId}', () => {
    const legacySection = bookingRoutesSource.slice(
      0,
      bookingRoutesSource.indexOf("router.get(\n  '/',")
    );
    expect(legacySection).toContain('`order_create:${customerId}`');
  });

  // ---------------------------------------------------------------------------
  // M10.6: 409 response for concurrent requests
  // ---------------------------------------------------------------------------
  test('M10.6: Returns 409 with CONCURRENT_REQUEST when lock is not acquired', () => {
    const legacySection = bookingRoutesSource.slice(
      0,
      bookingRoutesSource.indexOf("router.get(\n  '/',")
    );
    expect(legacySection).toContain('res.status(409)');
    expect(legacySection).toContain('CONCURRENT_REQUEST');
  });

  // ---------------------------------------------------------------------------
  // M10.7: Lock release in finally block
  // ---------------------------------------------------------------------------
  test('M10.7: Lock is released in a finally block', () => {
    const legacySection = bookingRoutesSource.slice(
      0,
      bookingRoutesSource.indexOf("router.get(\n  '/',")
    );
    expect(legacySection).toContain('finally');
    expect(legacySection).toContain('releaseLock');
  });

  // ---------------------------------------------------------------------------
  // M10.8: Comment about M10 mentions deadlock prevention
  // ---------------------------------------------------------------------------
  test('M10.8: Finally block has comment about preventing deadlocks', () => {
    expect(bookingRoutesSource).toContain(
      'M10: Release lock in finally block to prevent deadlocks'
    );
  });

  // ---------------------------------------------------------------------------
  // M10.9: Lock acquired check guards releaseLock
  // ---------------------------------------------------------------------------
  test('M10.9: releaseLock is guarded by lockAcquired.acquired check', () => {
    const legacySection = bookingRoutesSource.slice(
      0,
      bookingRoutesSource.indexOf("router.get(\n  '/',")
    );
    // Pattern: if (lockAcquired.acquired) { await redisService.releaseLock(...) }
    expect(legacySection).toContain('lockAcquired.acquired');
  });

  // ---------------------------------------------------------------------------
  // M10.10: Rate limit returns 429
  // ---------------------------------------------------------------------------
  test('M10.10: Returns 429 with RATE_LIMIT_EXCEEDED when rate limit hit', () => {
    const legacySection = bookingRoutesSource.slice(
      0,
      bookingRoutesSource.indexOf("router.get(\n  '/',")
    );
    expect(legacySection).toContain('res.status(429)');
    expect(legacySection).toContain('RATE_LIMIT_EXCEEDED');
  });

  // ---------------------------------------------------------------------------
  // M10.11: Rate limit has 5 requests per 60 seconds
  // ---------------------------------------------------------------------------
  test('M10.11: Rate limit is 5 requests per 60 seconds', () => {
    const legacySection = bookingRoutesSource.slice(
      0,
      bookingRoutesSource.indexOf("router.get(\n  '/',")
    );
    // checkRateLimit(`order_create:${customerId}`, 5, 60)
    const rateLimitCall = legacySection.match(
      /checkRateLimit\([^,]+,\s*(\d+)\s*,\s*(\d+)\s*\)/
    );
    expect(rateLimitCall).not.toBeNull();
    expect(rateLimitCall![1]).toBe('5');
    expect(rateLimitCall![2]).toBe('60');
  });

  // ---------------------------------------------------------------------------
  // M10.12: Canonical POST /orders also has matching lock + rate limit
  // ---------------------------------------------------------------------------
  test('M10.12: Canonical POST /orders route also has acquireLock and checkRateLimit', () => {
    const canonicalSection = bookingRoutesSource.slice(
      bookingRoutesSource.indexOf("router.post(\n  '/orders',")
    );
    expect(canonicalSection).toContain('acquireLock');
    expect(canonicalSection).toContain('checkRateLimit');
  });

  // ---------------------------------------------------------------------------
  // M10.13: releaseLock .catch() prevents unhandled rejection
  // ---------------------------------------------------------------------------
  test('M10.13: releaseLock uses .catch() to prevent unhandled rejection', () => {
    const legacySection = bookingRoutesSource.slice(
      0,
      bookingRoutesSource.indexOf("router.get(\n  '/',")
    );
    // L-06 FIX: lock token is now a crypto.randomUUID() instead of customerId
    expect(legacySection).toContain('releaseLock(lockKey, lockToken).catch(');
  });
});

// =============================================================================
// H3 TESTS: DLQ metric + admin re-drive (order-dispatch-outbox.service.ts)
// =============================================================================

describe('H3: DLQ metric + admin re-drive', () => {
  const outboxSource = readSource(
    '../modules/order/order-dispatch-outbox.service.ts'
  );
  const adminRoutesSource = readSource('../modules/admin/admin.routes.ts');
  const adminControllerSource = readSource(
    '../modules/admin/admin.controller.ts'
  );

  // ---------------------------------------------------------------------------
  // H3.1: dispatch_dlq_total metric exists for RETRY_EXHAUSTED
  // ---------------------------------------------------------------------------
  test('H3.1: dispatch_dlq_total metric is emitted on RETRY_EXHAUSTED', () => {
    const match = outboxSource.match(
      /metrics\.incrementCounter\(\s*'dispatch_dlq_total'\s*,\s*\{[^}]*reason:\s*'RETRY_EXHAUSTED'/
    );
    expect(match).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // H3.2: dispatch_dlq_total metric exists for EXCEPTION_EXHAUSTED
  // ---------------------------------------------------------------------------
  test('H3.2: dispatch_dlq_total metric is emitted on EXCEPTION_EXHAUSTED', () => {
    const match = outboxSource.match(
      /metrics\.incrementCounter\(\s*'dispatch_dlq_total'\s*,\s*\{[^}]*reason:\s*'EXCEPTION_EXHAUSTED'/
    );
    expect(match).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // H3.3: logger.error on retry exhaustion (RETRY_EXHAUSTED)
  // ---------------------------------------------------------------------------
  test('H3.3: logger.error is called on RETRY_EXHAUSTED with DLQ context', () => {
    const lines = outboxSource.split('\n');
    const dlqLogLine = lines.find(
      (line: string) =>
        line.includes('logger.error') &&
        line.includes('DLQ') &&
        line.includes('max retries')
    );
    expect(dlqLogLine).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // H3.4: logger.error on exception exhaustion (EXCEPTION_EXHAUSTED)
  // ---------------------------------------------------------------------------
  test('H3.4: logger.error is called on EXCEPTION_EXHAUSTED with DLQ context', () => {
    const lines = outboxSource.split('\n');
    const dlqLogLine = lines.find(
      (line: string) =>
        line.includes('logger.error') &&
        line.includes('DLQ') &&
        line.includes('exception exhausted')
    );
    expect(dlqLogLine).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // H3.5: DLQ error log includes orderId
  // ---------------------------------------------------------------------------
  test('H3.5: DLQ error logs include orderId in context', () => {
    // Find DLQ logger.error blocks and verify they include orderId
    const dlqSections = outboxSource.split('dispatch_dlq_total');
    // There should be at least 2 occurrences (RETRY_EXHAUSTED and EXCEPTION_EXHAUSTED)
    expect(dlqSections.length).toBeGreaterThanOrEqual(3); // original + 2 splits

    // Each section near the metric should have a logger.error with orderId
    for (let i = 1; i < dlqSections.length; i++) {
      const section = dlqSections[i].slice(0, 300);
      expect(section).toContain('orderId');
    }
  });

  // ---------------------------------------------------------------------------
  // H3.6: DLQ error log includes attempts and maxAttempts
  // ---------------------------------------------------------------------------
  test('H3.6: DLQ error logs include attempts and maxAttempts', () => {
    const dlqLogBlocks = outboxSource.match(
      /logger\.error\('\[DispatchOutbox\] Message moved to DLQ[\s\S]{0,300}/g
    );
    expect(dlqLogBlocks).not.toBeNull();
    expect(dlqLogBlocks!.length).toBeGreaterThanOrEqual(2);

    for (const block of dlqLogBlocks!) {
      expect(block).toContain('attempts');
      expect(block).toContain('maxAttempts');
    }
  });

  // ---------------------------------------------------------------------------
  // H3.7: redriveFailedDispatch function is exported
  // ---------------------------------------------------------------------------
  test('H3.7: redriveFailedDispatch function is exported from outbox service', () => {
    expect(outboxSource).toContain('export async function redriveFailedDispatch');
  });

  // ---------------------------------------------------------------------------
  // H3.8: redriveFailedDispatch accepts orderId parameter
  // ---------------------------------------------------------------------------
  test('H3.8: redriveFailedDispatch takes orderId: string as parameter', () => {
    const fnSignature = outboxSource.match(
      /export async function redriveFailedDispatch\(\s*orderId:\s*string\s*\)/
    );
    expect(fnSignature).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // H3.9: redriveFailedDispatch returns DispatchOutboxRow | null
  // ---------------------------------------------------------------------------
  test('H3.9: redriveFailedDispatch returns Promise<DispatchOutboxRow | null>', () => {
    const fnDecl = outboxSource.match(
      /redriveFailedDispatch\([^)]+\):\s*Promise<DispatchOutboxRow\s*\|\s*null>/
    );
    expect(fnDecl).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // H3.10: redriveFailedDispatch resets status to 'pending'
  // ---------------------------------------------------------------------------
  test('H3.10: redriveFailedDispatch resets row status to pending', () => {
    const fnBody = outboxSource.slice(
      outboxSource.indexOf('redriveFailedDispatch')
    );
    expect(fnBody).toContain("status: 'pending'");
  });

  // ---------------------------------------------------------------------------
  // H3.11: redriveFailedDispatch resets attempts to 0
  // ---------------------------------------------------------------------------
  test('H3.11: redriveFailedDispatch resets attempts to 0', () => {
    const fnBody = outboxSource.slice(
      outboxSource.indexOf('redriveFailedDispatch')
    );
    expect(fnBody).toContain('attempts: 0');
  });

  // ---------------------------------------------------------------------------
  // H3.12: redriveFailedDispatch only operates on 'failed' rows
  // ---------------------------------------------------------------------------
  test('H3.12: redriveFailedDispatch checks that row status is failed before re-driving', () => {
    const fnBody = outboxSource.slice(
      outboxSource.indexOf('redriveFailedDispatch'),
      outboxSource.indexOf('redriveFailedDispatch') + 600
    );
    expect(fnBody).toContain("row.status !== 'failed'");
  });

  // ---------------------------------------------------------------------------
  // H3.13: redriveFailedDispatch increments dispatch_dlq_redrive_total metric
  // ---------------------------------------------------------------------------
  test('H3.13: redriveFailedDispatch increments dispatch_dlq_redrive_total metric', () => {
    const fnBody = outboxSource.slice(
      outboxSource.indexOf('redriveFailedDispatch')
    );
    expect(fnBody).toContain("dispatch_dlq_redrive_total");
  });

  // ---------------------------------------------------------------------------
  // H3.14: redriveFailedDispatch logs info about re-drive
  // ---------------------------------------------------------------------------
  test('H3.14: redriveFailedDispatch logs re-drive info', () => {
    const fnBody = outboxSource.slice(
      outboxSource.indexOf('redriveFailedDispatch')
    );
    expect(fnBody).toContain('Failed dispatch re-driven by admin');
  });

  // ---------------------------------------------------------------------------
  // H3.15: Admin route POST /dispatch-outbox/:orderId/retry exists
  // ---------------------------------------------------------------------------
  test('H3.15: Admin route POST /dispatch-outbox/:orderId/retry is registered', () => {
    expect(adminRoutesSource).toContain(
      "router.post('/dispatch-outbox/:orderId/retry'"
    );
  });

  // ---------------------------------------------------------------------------
  // H3.16: Admin route requires admin role
  // ---------------------------------------------------------------------------
  test('H3.16: Admin routes are guarded by admin role', () => {
    expect(adminRoutesSource).toContain("roleGuard(['admin'])");
  });

  // ---------------------------------------------------------------------------
  // H3.17: Admin route requires authentication
  // ---------------------------------------------------------------------------
  test('H3.17: Admin routes require authMiddleware', () => {
    expect(adminRoutesSource).toContain('authMiddleware');
  });

  // ---------------------------------------------------------------------------
  // H3.18: Admin controller imports redriveFailedDispatch
  // ---------------------------------------------------------------------------
  test('H3.18: Admin controller imports redriveFailedDispatch from outbox service', () => {
    expect(adminControllerSource).toContain(
      "import { redriveFailedDispatch } from '../order/order-dispatch-outbox.service'"
    );
  });

  // ---------------------------------------------------------------------------
  // H3.19: Admin controller calls redriveFailedDispatch with orderId
  // ---------------------------------------------------------------------------
  test('H3.19: Admin controller calls redriveFailedDispatch(orderId.trim())', () => {
    expect(adminControllerSource).toContain(
      'redriveFailedDispatch(orderId.trim())'
    );
  });

  // ---------------------------------------------------------------------------
  // H3.20: Admin controller returns 404 when no failed row found
  // ---------------------------------------------------------------------------
  test('H3.20: Admin controller returns 404 when redriveFailedDispatch returns null', () => {
    const controllerBlock = adminControllerSource.slice(
      adminControllerSource.indexOf('redriveDispatchOutbox')
    );
    expect(controllerBlock).toContain('res.status(404)');
    expect(controllerBlock).toContain('No failed dispatch outbox row found');
  });

  // ---------------------------------------------------------------------------
  // H3.21: Admin controller validates orderId is present
  // ---------------------------------------------------------------------------
  test('H3.21: Admin controller validates orderId is a non-empty string', () => {
    const controllerBlock = adminControllerSource.slice(
      adminControllerSource.indexOf('redriveDispatchOutbox')
    );
    expect(controllerBlock).toContain('orderId.trim().length === 0');
  });

  // ---------------------------------------------------------------------------
  // H3.22: Admin controller returns 400 for missing orderId
  // ---------------------------------------------------------------------------
  test('H3.22: Admin controller returns 400 for missing/empty orderId', () => {
    const controllerBlock = adminControllerSource.slice(
      adminControllerSource.indexOf('redriveDispatchOutbox')
    );
    expect(controllerBlock).toContain('res.status(400)');
    expect(controllerBlock).toContain('VALIDATION_ERROR');
  });

  // ---------------------------------------------------------------------------
  // H3.23: Admin controller returns success with updated row data
  // ---------------------------------------------------------------------------
  test('H3.23: Admin controller returns success response with orderId, status, and attempts', () => {
    const controllerBlock = adminControllerSource.slice(
      adminControllerSource.indexOf('redriveDispatchOutbox')
    );
    expect(controllerBlock).toContain('success: true');
    expect(controllerBlock).toContain('updated.orderId');
    expect(controllerBlock).toContain('updated.status');
    expect(controllerBlock).toContain('updated.attempts');
  });

  // ---------------------------------------------------------------------------
  // H3.24: DLQ metric includes orderId label
  // ---------------------------------------------------------------------------
  test('H3.24: dispatch_dlq_total metric includes orderId label', () => {
    const dlqMetricCalls = outboxSource.match(
      /metrics\.incrementCounter\(\s*'dispatch_dlq_total'\s*,\s*\{[^}]*orderId/g
    );
    expect(dlqMetricCalls).not.toBeNull();
    expect(dlqMetricCalls!.length).toBeGreaterThanOrEqual(2);
  });

  // ---------------------------------------------------------------------------
  // H3.25: redriveFailedDispatch resets lastError to null
  // ---------------------------------------------------------------------------
  test('H3.25: redriveFailedDispatch resets lastError to null', () => {
    const fnBody = outboxSource.slice(
      outboxSource.indexOf('redriveFailedDispatch')
    );
    expect(fnBody).toContain('lastError: null');
  });

  // ---------------------------------------------------------------------------
  // H3.26: redriveFailedDispatch resets processedAt and lockedAt to null
  // ---------------------------------------------------------------------------
  test('H3.26: redriveFailedDispatch resets processedAt and lockedAt to null', () => {
    const fnBody = outboxSource.slice(
      outboxSource.indexOf('redriveFailedDispatch')
    );
    expect(fnBody).toContain('processedAt: null');
    expect(fnBody).toContain('lockedAt: null');
  });

  // ---------------------------------------------------------------------------
  // H3.27: redriveFailedDispatch sets nextRetryAt to now
  // ---------------------------------------------------------------------------
  test('H3.27: redriveFailedDispatch sets nextRetryAt to new Date()', () => {
    const fnBody = outboxSource.slice(
      outboxSource.indexOf('redriveFailedDispatch')
    );
    expect(fnBody).toContain('nextRetryAt: new Date()');
  });
});
