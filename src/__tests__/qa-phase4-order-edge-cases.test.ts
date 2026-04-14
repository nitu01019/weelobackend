/**
 * =============================================================================
 * QA PHASE 4 -- Order / Booking Edge Cases
 * =============================================================================
 *
 * Covers EDGE CASES for three specific fixes:
 *
 * 1. H2  -- Math.max(1, Math.round(...)) distance rounding
 *           in order.contract.ts:221  (normalizeCreateOrderInput)
 *
 * 2. M5  -- routePoints distance refine in booking.schema.ts:245
 *           (createOrderSchema M5 FIX refine)
 *
 * 3. M10 -- Legacy POST /bookings/ Redis lock + rate limit
 *           in booking.routes.ts:84  (M10 FIX block)
 *
 * @author Team Bruta, Agent 2 -- QA
 * =============================================================================
 */

import { z } from 'zod';
import { createOrderSchema } from '../modules/booking/booking.schema';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Import normalizeCreateOrderInput directly to test H2 rounding logic
// ---------------------------------------------------------------------------
// The function is exported from order.contract.ts
import { normalizeCreateOrderInput } from '../modules/order/order.contract';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Build a minimal valid createOrder payload.
 * Uses Delhi->Mumbai as default pickup/drop (well over 500m apart).
 */
function makeOrderPayload(overrides: Record<string, unknown> = {}) {
  return {
    pickup: {
      coordinates: { latitude: 28.6, longitude: 77.2 },
      address: 'Delhi pickup',
    },
    drop: {
      coordinates: { latitude: 19.076, longitude: 72.877 },
      address: 'Mumbai drop',
    },
    distanceKm: 1400,
    trucks: [
      {
        vehicleType: 'open',
        vehicleSubtype: 'Open 17ft',
        quantity: 2,
        pricePerTruck: 25000,
      },
    ],
    ...overrides,
  };
}

/**
 * Build a minimal createOrder payload that uses routePoints instead of
 * separate pickup/drop.  The caller can override individual routePoint
 * coordinates to test the M5 distance refine.
 */
function makeRoutePointsPayload(
  firstCoords: { latitude: number; longitude: number },
  lastCoords: { latitude: number; longitude: number },
  extraOverrides: Record<string, unknown> = {}
) {
  return {
    routePoints: [
      {
        type: 'PICKUP',
        coordinates: firstCoords,
        address: 'Start point',
      },
      {
        type: 'DROP',
        coordinates: lastCoords,
        address: 'End point',
      },
    ],
    distanceKm: 100,
    trucks: [
      {
        vehicleType: 'open',
        vehicleSubtype: 'Open 17ft',
        quantity: 1,
        pricePerTruck: 15000,
      },
    ],
    ...extraOverrides,
  };
}

/**
 * Haversine distance helper (km) -- mirrors the schema's internal calc.
 * Used to construct test coordinates at precise distances.
 */
function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371;
  const dLatR = ((lat2 - lat1) * Math.PI) / 180;
  const dLonR = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLatR / 2) * Math.sin(dLatR / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLonR / 2) *
      Math.sin(dLonR / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Returns a latitude offset in degrees that corresponds to `meters` distance.
 * Approximate but accurate for the ranges the tests need.
 */
function latOffsetForMeters(meters: number): number {
  // 1 degree latitude ~ 111,320 m
  return meters / 111320;
}

// Reference point: Delhi
const delhiLat = 28.6;
const delhiLng = 77.2;

// =============================================================================
// SECTION 1: H2 -- Distance rounding (Math.max(1, Math.round(...)))
// =============================================================================
// The fix is at order.contract.ts:221:
//   const distanceKm = Math.max(1, Math.round(parseNumber(input.distanceKm, 'distanceKm')));
//
// Expected behaviour:
//   - Math.round(x) rounds to nearest integer
//   - Math.max(1, result) enforces a minimum of 1
//   - So any value that rounds to 0 or below becomes 1
// =============================================================================

describe('H2: Distance rounding -- Math.max(1, Math.round(...))', () => {
  /**
   * Helper: call normalizeCreateOrderInput with a given distanceKm and return
   * the normalized distanceKm value.
   */
  function normalizeDistance(distanceKm: number | string): number {
    const input = makeOrderPayload({ distanceKm });
    const result = normalizeCreateOrderInput(input);
    return result.distanceKm;
  }

  describe('standard rounding behaviour', () => {
    it('Math.round(0.5) = 1, not 0 (banker rounding is NOT used)', () => {
      // JavaScript Math.round(0.5) = 1 (rounds up at .5)
      expect(normalizeDistance(0.5)).toBe(1);
    });

    it('Math.round(0.4) = 0 => Math.max(1, 0) = 1 (minimum enforced)', () => {
      expect(normalizeDistance(0.4)).toBe(1);
    });

    it('Math.round(0.1) = 0 => Math.max(1, 0) = 1', () => {
      expect(normalizeDistance(0.1)).toBe(1);
    });

    it('Math.round(4.7) = 5 (rounds up correctly)', () => {
      expect(normalizeDistance(4.7)).toBe(5);
    });

    it('Math.round(4.4) = 4 (rounds down correctly)', () => {
      expect(normalizeDistance(4.4)).toBe(4);
    });

    it('Math.round(4.5) = 5 (midpoint rounds up)', () => {
      expect(normalizeDistance(4.5)).toBe(5);
    });

    it('Math.round(99.5) = 100', () => {
      expect(normalizeDistance(99.5)).toBe(100);
    });

    it('Math.round(1.0) = 1 (integer-valued float stays same)', () => {
      expect(normalizeDistance(1.0)).toBe(1);
    });

    it('Math.round(10.0) = 10', () => {
      expect(normalizeDistance(10.0)).toBe(10);
    });
  });

  describe('minimum enforcement (Math.max(1, ...))', () => {
    it('distanceKm=0.01 => rounds to 0 => clamped to 1', () => {
      expect(normalizeDistance(0.01)).toBe(1);
    });

    it('distanceKm=0.49 => rounds to 0 => clamped to 1', () => {
      expect(normalizeDistance(0.49)).toBe(1);
    });

    it('distanceKm=0.001 => rounds to 0 => clamped to 1', () => {
      expect(normalizeDistance(0.001)).toBe(1);
    });
  });

  describe('negative values => Math.max(1, negative) = 1', () => {
    it('distanceKm=-1 => Math.round(-1) = -1 => Math.max(1, -1) = 1', () => {
      expect(normalizeDistance(-1)).toBe(1);
    });

    it('distanceKm=-0.5 => Math.round(-0.5) = 0 => Math.max(1, 0) = 1', () => {
      // Note: Math.round(-0.5) = 0 in JavaScript (rounds toward +Infinity)
      expect(normalizeDistance(-0.5)).toBe(1);
    });

    it('distanceKm=-100 => clamped to 1', () => {
      expect(normalizeDistance(-100)).toBe(1);
    });

    it('distanceKm=-0.1 => Math.round(-0.1) = 0 => clamped to 1', () => {
      expect(normalizeDistance(-0.1)).toBe(1);
    });
  });

  describe('very large values pass through correctly', () => {
    it('distanceKm=9999.9 => Math.round = 10000', () => {
      expect(normalizeDistance(9999.9)).toBe(10000);
    });

    it('distanceKm=9999.4 => Math.round = 9999', () => {
      expect(normalizeDistance(9999.4)).toBe(9999);
    });

    it('distanceKm=5000 => stays 5000', () => {
      expect(normalizeDistance(5000)).toBe(5000);
    });

    it('distanceKm=1 => stays 1 (minimum realistic value)', () => {
      expect(normalizeDistance(1)).toBe(1);
    });
  });

  describe('string coercion via parseNumber', () => {
    it('distanceKm="47.3" (string) => rounds to 47', () => {
      expect(normalizeDistance('47.3')).toBe(47);
    });

    it('distanceKm="0.4" (string) => rounds to 0 => clamped to 1', () => {
      expect(normalizeDistance('0.4')).toBe(1);
    });

    it('distanceKm="1400" (string) => 1400', () => {
      expect(normalizeDistance('1400')).toBe(1400);
    });
  });

  describe('invalid distanceKm values throw AppError', () => {
    it('throws on non-numeric string "abc"', () => {
      expect(() => normalizeDistance('abc' as any)).toThrow();
    });

    it('throws on NaN', () => {
      expect(() => normalizeDistance(NaN as any)).toThrow();
    });

    it('throws on Infinity', () => {
      expect(() => normalizeDistance(Infinity as any)).toThrow();
    });

    it('throws on empty string', () => {
      expect(() => normalizeDistance('' as any)).toThrow();
    });
  });

  describe('source code verification', () => {
    it('order.contract.ts line 221 contains Math.max(1, Math.round(parseNumber(...)))', () => {
      const contractPath = path.resolve(
        __dirname,
        '../modules/order/order.contract.ts'
      );
      const source = fs.readFileSync(contractPath, 'utf-8');
      // Verify the exact H2 fix pattern exists
      expect(source).toContain('Math.max(1, Math.round(parseNumber(input.distanceKm,');
    });
  });
});

// =============================================================================
// SECTION 2: M5 -- routePoints distance refine
// =============================================================================
// The fix is at booking.schema.ts:245-268:
//   M5 FIX refine on createOrderSchema validates that first and last
//   routePoints are at least 500m (0.5km) apart, when no separate
//   pickup/drop fields are provided.
//
// Key logic:
//   - If routePoints is absent or < 2 points => skip (return true)
//   - If pickup AND drop fields present => skip (previous refine handles it)
//   - Otherwise Haversine(first, last) >= 0.5km required
// =============================================================================

describe('M5: routePoints distance refine (createOrderSchema)', () => {
  describe('reject: first/last point too close (< 500m)', () => {
    it('identical first and last point (distance = 0m) => reject', () => {
      const payload = makeRoutePointsPayload(
        { latitude: delhiLat, longitude: delhiLng },
        { latitude: delhiLat, longitude: delhiLng }
      );
      const result = createOrderSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message);
        expect(messages).toContain('Route start and end points must be at least 500m apart');
      }
    });

    it('~100m apart => reject', () => {
      const offset = latOffsetForMeters(100);
      const payload = makeRoutePointsPayload(
        { latitude: delhiLat, longitude: delhiLng },
        { latitude: delhiLat + offset, longitude: delhiLng }
      );
      const result = createOrderSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it('~200m apart => reject', () => {
      const offset = latOffsetForMeters(200);
      const payload = makeRoutePointsPayload(
        { latitude: delhiLat, longitude: delhiLng },
        { latitude: delhiLat + offset, longitude: delhiLng }
      );
      const result = createOrderSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it('~400m apart => reject', () => {
      const offset = latOffsetForMeters(400);
      const payload = makeRoutePointsPayload(
        { latitude: delhiLat, longitude: delhiLng },
        { latitude: delhiLat + offset, longitude: delhiLng }
      );
      const result = createOrderSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it('~499m apart => reject (just under threshold)', () => {
      const offset = latOffsetForMeters(499);
      const distKm = haversineKm(delhiLat, delhiLng, delhiLat + offset, delhiLng);
      expect(distKm).toBeLessThan(0.5); // sanity check
      const payload = makeRoutePointsPayload(
        { latitude: delhiLat, longitude: delhiLng },
        { latitude: delhiLat + offset, longitude: delhiLng }
      );
      const result = createOrderSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });
  });

  describe('accept: first/last point >= 500m apart', () => {
    it('~510m apart => accept (just over threshold)', () => {
      const offset = latOffsetForMeters(510);
      const distKm = haversineKm(delhiLat, delhiLng, delhiLat + offset, delhiLng);
      expect(distKm).toBeGreaterThanOrEqual(0.5); // sanity check
      const payload = makeRoutePointsPayload(
        { latitude: delhiLat, longitude: delhiLng },
        { latitude: delhiLat + offset, longitude: delhiLng }
      );
      const result = createOrderSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it('~600m apart => accept', () => {
      const offset = latOffsetForMeters(600);
      const payload = makeRoutePointsPayload(
        { latitude: delhiLat, longitude: delhiLng },
        { latitude: delhiLat + offset, longitude: delhiLng }
      );
      const result = createOrderSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it('~1km apart => accept', () => {
      const offset = latOffsetForMeters(1000);
      const payload = makeRoutePointsPayload(
        { latitude: delhiLat, longitude: delhiLng },
        { latitude: delhiLat + offset, longitude: delhiLng }
      );
      const result = createOrderSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it('Delhi to Mumbai (~1100km) => accept', () => {
      const payload = makeRoutePointsPayload(
        { latitude: 28.6, longitude: 77.2 },
        { latitude: 19.076, longitude: 72.877 }
      );
      const result = createOrderSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });
  });

  describe('skip conditions (refine returns true early)', () => {
    it('routePoints absent => M5 refine skips (earlier refines may catch)', () => {
      // With pickup+drop provided, routePoints absent => M5 refine returns true
      const payload = makeOrderPayload(); // has pickup + drop, no routePoints
      const result = createOrderSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it('with pickup AND drop present + routePoints => M5 refine skips (previous refine handles)', () => {
      // M5 refine explicitly skips when both pickup and drop fields are present
      const offset = latOffsetForMeters(100); // 100m apart would normally fail
      const payload = {
        ...makeOrderPayload(),
        routePoints: [
          {
            type: 'PICKUP',
            coordinates: { latitude: delhiLat, longitude: delhiLng },
            address: 'Start',
          },
          {
            type: 'DROP',
            coordinates: { latitude: delhiLat + offset, longitude: delhiLng },
            address: 'End',
          },
        ],
      };
      // M5 skips because pickup+drop exist; BUT the previous refine catches
      // that pickup+drop are far apart (Delhi to Mumbai), so it passes.
      const result = createOrderSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });
  });

  describe('routePoints with intermediate stops', () => {
    it('3 points (pickup, stop, drop) -- distance measured between first and last', () => {
      const farOffset = latOffsetForMeters(1000); // 1km between first and last
      const payload = {
        routePoints: [
          {
            type: 'PICKUP',
            coordinates: { latitude: delhiLat, longitude: delhiLng },
            address: 'Pickup point',
          },
          {
            type: 'STOP',
            coordinates: { latitude: delhiLat + farOffset / 2, longitude: delhiLng },
            address: 'Intermediate stop',
          },
          {
            type: 'DROP',
            coordinates: { latitude: delhiLat + farOffset, longitude: delhiLng },
            address: 'Drop point',
          },
        ],
        distanceKm: 100,
        trucks: [
          {
            vehicleType: 'open',
            vehicleSubtype: 'Open 17ft',
            quantity: 1,
            pricePerTruck: 15000,
          },
        ],
      };
      const result = createOrderSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it('3 points with first=last (round trip through stop) => reject', () => {
      const payload = {
        routePoints: [
          {
            type: 'PICKUP',
            coordinates: { latitude: delhiLat, longitude: delhiLng },
            address: 'Pickup point',
          },
          {
            type: 'STOP',
            coordinates: { latitude: 19.076, longitude: 72.877 },
            address: 'Far stop in Mumbai',
          },
          {
            type: 'DROP',
            coordinates: { latitude: delhiLat, longitude: delhiLng },
            address: 'Drop point (same as pickup)',
          },
        ],
        distanceKm: 2800,
        trucks: [
          {
            vehicleType: 'open',
            vehicleSubtype: 'Open 17ft',
            quantity: 1,
            pricePerTruck: 15000,
          },
        ],
      };
      const result = createOrderSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message);
        expect(messages).toContain('Route start and end points must be at least 500m apart');
      }
    });
  });

  describe('source code verification', () => {
    it('booking.schema.ts contains M5 FIX refine comment', () => {
      const schemaPath = path.resolve(
        __dirname,
        '../modules/booking/booking.schema.ts'
      );
      const source = fs.readFileSync(schemaPath, 'utf-8');
      expect(source).toContain('M5 FIX: Validate minimum distance when using routePoints');
    });

    it('M5 refine checks R * c >= 0.5 (500m threshold)', () => {
      const schemaPath = path.resolve(
        __dirname,
        '../modules/booking/booking.schema.ts'
      );
      const source = fs.readFileSync(schemaPath, 'utf-8');
      // Verify the 500m threshold is correctly coded as >= 0.5 km
      expect(source).toContain('return R * c >= 0.5;');
    });

    it('M5 refine error message is "Route start and end points must be at least 500m apart"', () => {
      const schemaPath = path.resolve(
        __dirname,
        '../modules/booking/booking.schema.ts'
      );
      const source = fs.readFileSync(schemaPath, 'utf-8');
      expect(source).toContain("'Route start and end points must be at least 500m apart'");
    });
  });
});

// =============================================================================
// SECTION 3: M10 -- Legacy POST /bookings/ Redis lock + rate limit
// =============================================================================
// The fix is at booking.routes.ts:84-218:
//   M10 FIX block adds distributed Redis lock + per-customer rate limit
//   to the legacy POST /bookings/ route, matching canonical /bookings/orders.
//
// We verify by source-scanning that:
//   (a) acquireLock is called with the correct lock key pattern
//   (b) 409 is returned when lock is not acquired
//   (c) checkRateLimit is called
//   (d) 429 is returned when rate limit is exceeded
//   (e) Lock is released in a finally block
//   (f) Lock key matches canonical pattern: order:create:{customerId}
// =============================================================================

describe('M10: Legacy booking route Redis lock + rate limit (source scan)', () => {
  let routeSource: string;

  beforeAll(() => {
    const routePath = path.resolve(
      __dirname,
      '../modules/booking/booking.routes.ts'
    );
    routeSource = fs.readFileSync(routePath, 'utf-8');
  });

  describe('M10 FIX presence', () => {
    it('contains M10 FIX comment', () => {
      expect(routeSource).toContain('M10 FIX: Add distributed Redis lock + per-customer rate limit');
    });

    it('M10 fix is inside the legacy POST / handler (not /orders)', () => {
      // The M10 fix comment appears AFTER the legacy POST '/' route definition
      const legacyRouteIndex = routeSource.indexOf("router.post(\n  '/',");
      const m10Index = routeSource.indexOf('M10 FIX:');
      const canonicalRouteIndex = routeSource.indexOf("router.post(\n  '/orders',");
      expect(legacyRouteIndex).toBeLessThan(m10Index);
      expect(m10Index).toBeLessThan(canonicalRouteIndex);
    });
  });

  describe('distributed lock (acquireLock)', () => {
    it('calls redisService.acquireLock on legacy path', () => {
      // L-06 FIX: lock token is now a crypto.randomUUID() instead of customerId
      expect(routeSource).toContain('await redisService.acquireLock(lockKey, lockToken, 10)');
    });

    it('lock key uses canonical pattern: order:create:${customerId}', () => {
      expect(routeSource).toContain('`order:create:${customerId}`');
    });

    it('lock TTL is 10 seconds (matches acquireLock third argument)', () => {
      // L-06 FIX: lock token is now a crypto.randomUUID() instead of customerId
      expect(routeSource).toContain('acquireLock(lockKey, lockToken, 10)');
    });
  });

  describe('409 Conflict on concurrent request', () => {
    it('returns 409 status when lock is not acquired', () => {
      expect(routeSource).toContain('res.status(409).json(');
    });

    it('409 response includes CONCURRENT_REQUEST error code', () => {
      expect(routeSource).toContain("code: 'CONCURRENT_REQUEST'");
    });

    it('409 response includes retryAfter data', () => {
      // Inside the 409 error response data block
      expect(routeSource).toContain('retryAfter: 2');
    });
  });

  describe('rate limit (checkRateLimit)', () => {
    it('calls canonicalOrderService.checkRateLimit on legacy path', () => {
      expect(routeSource).toContain('canonicalOrderService.checkRateLimit(`order_create:${customerId}`');
    });

    it('rate limit allows 5 requests per 60 seconds', () => {
      // checkRateLimit(`order_create:${customerId}`, 5, 60)
      expect(routeSource).toContain('checkRateLimit(`order_create:${customerId}`, 5, 60)');
    });
  });

  describe('429 Too Many Requests on rate limit exceeded', () => {
    it('returns 429 status when rate limit exceeded', () => {
      expect(routeSource).toContain('res.status(429).json(');
    });

    it('429 response includes RATE_LIMIT_EXCEEDED error code', () => {
      expect(routeSource).toContain("code: 'RATE_LIMIT_EXCEEDED'");
    });

    it('sets Retry-After header on 429 response', () => {
      expect(routeSource).toContain("res.setHeader('Retry-After',");
    });

    it('429 response includes retryAfterMs in data', () => {
      expect(routeSource).toContain('retryAfterMs');
    });
  });

  describe('lock release in finally block', () => {
    it('has a finally block that releases the lock', () => {
      expect(routeSource).toContain('} finally {');
      expect(routeSource).toContain('M10: Release lock in finally block to prevent deadlocks');
    });

    it('finally block calls releaseLock with same key and holder', () => {
      // L-06 FIX: lock token is now a crypto.randomUUID() instead of customerId
      expect(routeSource).toContain('await redisService.releaseLock(lockKey, lockToken)');
    });

    it('releaseLock failure is caught (does not throw)', () => {
      // L-06 FIX: lock token is now a crypto.randomUUID() instead of customerId
      expect(routeSource).toContain("releaseLock(lockKey, lockToken).catch(() => { })");
    });

    it('lock release is conditional on lockAcquired.acquired', () => {
      expect(routeSource).toContain('if (lockAcquired.acquired)');
    });
  });

  describe('parity with canonical /bookings/orders route', () => {
    it('canonical route also uses order:create:${customerId} lock key', () => {
      // The canonical POST /orders route should have the same lock key
      const canonicalSection = routeSource.substring(
        routeSource.indexOf("router.post(\n  '/orders',")
      );
      expect(canonicalSection).toContain('`order:create:${customerId}`');
    });

    it('canonical route also calls checkRateLimit with same params', () => {
      const canonicalSection = routeSource.substring(
        routeSource.indexOf("router.post(\n  '/orders',")
      );
      expect(canonicalSection).toContain('checkRateLimit(`order_create:${customerId}`, 5, 60)');
    });

    it('canonical route also releases lock in finally block', () => {
      const canonicalSection = routeSource.substring(
        routeSource.indexOf("router.post(\n  '/orders',")
      );
      // L-06 FIX: lock token is now a crypto.randomUUID() instead of customerId
      expect(canonicalSection).toContain('releaseLock(lockKey, lockToken)');
    });

    it('both routes return same error codes (409 and 429)', () => {
      const legacySection = routeSource.substring(
        routeSource.indexOf("router.post(\n  '/'),"),
        routeSource.indexOf("router.post(\n  '/orders',")
      );
      // We already verified 409 and 429 exist in the full source.
      // Now verify both CONCURRENT_REQUEST and RATE_LIMIT_EXCEEDED appear
      // at least twice (once per route).
      const concurrentCount = (routeSource.match(/CONCURRENT_REQUEST/g) || []).length;
      const rateLimitCount = (routeSource.match(/RATE_LIMIT_EXCEEDED/g) || []).length;
      expect(concurrentCount).toBeGreaterThanOrEqual(2);
      expect(rateLimitCount).toBeGreaterThanOrEqual(2);
    });
  });
});

// =============================================================================
// SECTION 4: Cross-cutting -- Booking schema + contract interaction
// =============================================================================
// Verify that the Zod schema (booking.schema.ts) and the normalizer
// (order.contract.ts) do not conflict on edge-case distanceKm values.
// =============================================================================

describe('Cross-cutting: Zod schema vs. normalizer distance handling', () => {
  it('Zod schema accepts 0.1 (min boundary), normalizer rounds to 1', () => {
    const zodResult = createOrderSchema.safeParse(makeOrderPayload({ distanceKm: 0.1 }));
    expect(zodResult.success).toBe(true);
    const normalized = normalizeCreateOrderInput(makeOrderPayload({ distanceKm: 0.1 }));
    expect(normalized.distanceKm).toBe(1);
  });

  it('Zod schema accepts 0.5, normalizer rounds to 1', () => {
    const zodResult = createOrderSchema.safeParse(makeOrderPayload({ distanceKm: 0.5 }));
    expect(zodResult.success).toBe(true);
    const normalized = normalizeCreateOrderInput(makeOrderPayload({ distanceKm: 0.5 }));
    expect(normalized.distanceKm).toBe(1);
  });

  it('Zod schema accepts 47.3, normalizer rounds to 47', () => {
    const zodResult = createOrderSchema.safeParse(makeOrderPayload({ distanceKm: 47.3 }));
    expect(zodResult.success).toBe(true);
    const normalized = normalizeCreateOrderInput(makeOrderPayload({ distanceKm: 47.3 }));
    expect(normalized.distanceKm).toBe(47);
  });

  it('Zod schema rejects 0 (below min 0.1), normalizer never reached', () => {
    const zodResult = createOrderSchema.safeParse(makeOrderPayload({ distanceKm: 0 }));
    expect(zodResult.success).toBe(false);
  });

  it('Zod schema rejects negative (-5), normalizer never reached', () => {
    const zodResult = createOrderSchema.safeParse(makeOrderPayload({ distanceKm: -5 }));
    expect(zodResult.success).toBe(false);
  });

  it('Zod schema rejects > 5000, normalizer never reached', () => {
    const zodResult = createOrderSchema.safeParse(makeOrderPayload({ distanceKm: 5001 }));
    expect(zodResult.success).toBe(false);
  });

  it('consistent: 1400km passes both Zod and normalizer as 1400', () => {
    const zodResult = createOrderSchema.safeParse(makeOrderPayload({ distanceKm: 1400 }));
    expect(zodResult.success).toBe(true);
    const normalized = normalizeCreateOrderInput(makeOrderPayload({ distanceKm: 1400 }));
    expect(normalized.distanceKm).toBe(1400);
  });
});
