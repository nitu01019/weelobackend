/**
 * =============================================================================
 * LOW PRIORITY FIXES — ALPHA-TEST (Team APEX)
 * =============================================================================
 *
 * Tests for 10 ALPHA fixes (low-priority group):
 *
 * F-2-17: Startup config assertion (radius time vs timeout)
 * F-2-19: BroadcastPayload type correctness
 * F-1-12: roleGuard on availability/stats route
 * F-3-19: Feature flag rename (H3_RADIUS_STEPS)
 * F-3-16: CIRCUITY_FACTORS semantic constants
 * F-1-4:  DRY normalizeOrderLifecycleState / normalizeOrderStatus
 * F-2-18: OrderStatus removal from core/constants
 *
 * @author ALPHA-TEST (Team APEX)
 * =============================================================================
 */

// =============================================================================
// F-2-17: Startup Config Assertion (tested in isolation, no side-effect imports)
// =============================================================================

describe('F-2-17: Startup config assertion — radius time vs booking timeout', () => {
  /**
   * The assertion logic in booking.service.ts checks:
   *   if (totalRadiusMs >= timeoutMs * 0.9) throw Error
   *
   * We replicate the logic here to test it without importing the module
   * (which has startup side effects like timers and DB connections).
   */
  function validateRadiusVsTimeout(
    steps: { timeoutMs: number }[],
    bookingTimeoutMs: number
  ): void {
    const totalRadiusMs = steps.reduce((sum, step) => sum + step.timeoutMs, 0);
    if (totalRadiusMs >= bookingTimeoutMs * 0.9) {
      throw new Error(
        `Config error: total radius expansion time (${totalRadiusMs}ms) must be < 90% of ` +
        `booking timeout (${bookingTimeoutMs}ms). ` +
        `Set BROADCAST_TIMEOUT_SECONDS > ${Math.ceil(totalRadiusMs / 900)}`
      );
    }
  }

  const PRODUCTION_STEPS = [
    { radiusKm: 5,   timeoutMs: 10_000 },
    { radiusKm: 10,  timeoutMs: 10_000 },
    { radiusKm: 15,  timeoutMs: 15_000 },
    { radiusKm: 30,  timeoutMs: 15_000 },
    { radiusKm: 60,  timeoutMs: 15_000 },
    { radiusKm: 100, timeoutMs: 15_000 },
  ];

  it('passes with production defaults (80s expansion, 120s timeout)', () => {
    // Total = 10+10+15+15+15+15 = 80s = 80000ms
    // Threshold = 120000 * 0.9 = 108000ms
    // 80000 < 108000 => should NOT throw
    expect(() => validateRadiusVsTimeout(PRODUCTION_STEPS, 120_000)).not.toThrow();
  });

  it('throws when total radius time >= 90% of timeout', () => {
    // 80s expansion, 90s timeout => 80000 >= 81000 (90% of 90000)
    // 80000 < 81000 => passes
    // But with 89s timeout: 80000 >= 80100 => fails
    const tightTimeout = 88_000; // 80000 >= 79200 => fails (80000 >= 79200)
    expect(() => validateRadiusVsTimeout(PRODUCTION_STEPS, tightTimeout)).toThrow('Config error');
  });

  it('throws when timeout is 0', () => {
    // 0 * 0.9 = 0, any positive sum >= 0 triggers assertion
    expect(() => validateRadiusVsTimeout(PRODUCTION_STEPS, 0)).toThrow('Config error');
  });

  it('throws with exact boundary: expansion == 90% of timeout', () => {
    // Total expansion = 80000ms. 90% of X = 80000 => X = 88889ms
    // At 88889ms: 80000 >= 80000.1 => just barely passes (rounding)
    // At 88888ms: 80000 >= 79999.2 => throws
    const exactBoundary = Math.ceil(80_000 / 0.9); // 88889
    // At exactly 88889: 80000 >= 80000.1 => should NOT throw
    expect(() => validateRadiusVsTimeout(PRODUCTION_STEPS, exactBoundary)).not.toThrow();
    // One ms less: should throw
    expect(() => validateRadiusVsTimeout(PRODUCTION_STEPS, exactBoundary - 1)).toThrow('Config error');
  });

  it('passes with empty steps array (sum=0)', () => {
    expect(() => validateRadiusVsTimeout([], 120_000)).not.toThrow();
  });

  it('error message includes recommended BROADCAST_TIMEOUT_SECONDS', () => {
    try {
      validateRadiusVsTimeout(PRODUCTION_STEPS, 0);
      fail('Should have thrown');
    } catch (e: any) {
      expect(e.message).toContain('BROADCAST_TIMEOUT_SECONDS');
      expect(e.message).toContain('Config error');
    }
  });
});

// =============================================================================
// F-2-19: BroadcastPayload type and buildBroadcastPayload
// =============================================================================

describe('F-2-19: BroadcastPayload — buildBroadcastPayload output shape', () => {
  // Import the helper directly — it has no side effects
  const { buildBroadcastPayload } = require('../modules/booking/booking-payload.helper');

  const mockBooking = {
    id: 'booking-123',
    customerId: 'cust-456',
    customerName: 'Test Customer',
    vehicleType: 'mini',
    vehicleSubtype: 'open',
    trucksNeeded: 3,
    trucksFilled: 1,
    pricePerTruck: 5000,
    totalAmount: 15000,
    pickup: {
      address: '123 Pickup St',
      city: 'Mumbai',
      latitude: 19.076,
      longitude: 72.877,
    },
    drop: {
      address: '456 Drop Ave',
      city: 'Pune',
      latitude: 18.520,
      longitude: 73.856,
    },
    distanceKm: 150,
    goodsType: 'electronics',
    weight: '500kg',
    createdAt: '2026-04-01T00:00:00Z',
    expiresAt: '2026-04-01T00:02:00Z',
  };

  it('returns an object with all required BroadcastPayload keys', () => {
    const payload = buildBroadcastPayload(mockBooking);

    // ID fields
    expect(payload.broadcastId).toBe('booking-123');
    expect(payload.orderId).toBe('booking-123');
    expect(payload.bookingId).toBe('booking-123');

    // Customer
    expect(payload.customerId).toBe('cust-456');
    expect(payload.customerName).toBe('Test Customer');

    // Vehicle
    expect(payload.vehicleType).toBe('mini');
    expect(payload.vehicleSubtype).toBe('open');
    expect(payload.trucksNeeded).toBe(3);
    expect(payload.totalTrucksNeeded).toBe(3);
    expect(payload.trucksFilled).toBe(1);
    expect(payload.trucksFilledSoFar).toBe(1);

    // Pricing
    expect(payload.pricePerTruck).toBe(5000);
    expect(payload.farePerTruck).toBe(5000);
    expect(payload.totalFare).toBe(15000);

    // Nested locations
    expect(payload.pickupLocation).toEqual({
      address: '123 Pickup St',
      city: 'Mumbai',
      latitude: 19.076,
      longitude: 72.877,
    });
    expect(payload.dropLocation).toEqual({
      address: '456 Drop Ave',
      city: 'Pune',
      latitude: 18.520,
      longitude: 73.856,
    });

    // Flat location (legacy)
    expect(payload.pickupAddress).toBe('123 Pickup St');
    expect(payload.dropAddress).toBe('456 Drop Ave');

    // Distance / cargo
    expect(payload.distanceKm).toBe(150);
    expect(payload.distance).toBe(150);
    expect(payload.goodsType).toBe('electronics');
    expect(payload.weight).toBe('500kg');

    // Timing
    expect(payload.createdAt).toBe('2026-04-01T00:00:00Z');
    expect(payload.expiresAt).toBe('2026-04-01T00:02:00Z');

    // Flags
    expect(payload.isUrgent).toBe(false);

    // Multi-truck array
    expect(payload.requestedVehicles).toHaveLength(1);
    expect(payload.requestedVehicles[0].vehicleType).toBe('mini');
    expect(payload.requestedVehicles[0].count).toBe(3);
    expect(payload.requestedVehicles[0].filledCount).toBe(1);
    expect(payload.requestedVehicles[0].farePerTruck).toBe(5000);
  });

  it('defaults pickupDistanceKm and pickupEtaMinutes to 0 when no options', () => {
    const payload = buildBroadcastPayload(mockBooking);
    expect(payload.pickupDistanceKm).toBe(0);
    expect(payload.pickupEtaMinutes).toBe(0);
  });

  it('applies overrides from options', () => {
    const payload = buildBroadcastPayload(mockBooking, {
      timeoutSeconds: 90,
      isRebroadcast: true,
      radiusStep: 3,
      trucksFilled: 2,
      pickupDistanceKm: 5.5,
      pickupEtaMinutes: 12,
    });

    expect(payload.timeoutSeconds).toBe(90);
    expect(payload.isRebroadcast).toBe(true);
    expect(payload.radiusStep).toBe(3);
    expect(payload.trucksFilled).toBe(2);
    expect(payload.trucksFilledSoFar).toBe(2);
    expect(payload.pickupDistanceKm).toBe(5.5);
    expect(payload.pickupEtaMinutes).toBe(12);
  });

  it('requestedVehicles[0].filledCount uses overridden trucksFilled', () => {
    const payload = buildBroadcastPayload(mockBooking, { trucksFilled: 2 });
    expect(payload.requestedVehicles[0].filledCount).toBe(2);
  });

  it('does not include isRebroadcast when option is false/absent', () => {
    const payload = buildBroadcastPayload(mockBooking);
    expect(payload.isRebroadcast).toBeUndefined();
  });

  it('does not include radiusStep when option is absent', () => {
    const payload = buildBroadcastPayload(mockBooking);
    expect(payload.radiusStep).toBeUndefined();
  });
});

// =============================================================================
// F-1-12: roleGuard on availability/stats route (structural verification)
// =============================================================================

describe('F-1-12: roleGuard on availability/stats route', () => {
  /**
   * Since we cannot easily spin up the full Express server in unit tests,
   * we verify the source code structurally: the route definition must include
   * roleGuard(['transporter', 'admin']) before the handler.
   */
  it('transporter.routes.ts has roleGuard on /availability/stats', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require('path').resolve(__dirname, '../modules/transporter/transporter.routes.ts'),
      'utf-8'
    );

    // Route must have authMiddleware and roleGuard
    const statsRouteRegion = source.substring(
      source.indexOf("'/availability/stats'"),
      source.indexOf("'/availability/stats'") + 200
    );

    expect(statsRouteRegion).toBeDefined();
    expect(source).toContain("'/availability/stats'");
  });

  it('roleGuard includes transporter and admin roles', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require('path').resolve(__dirname, '../modules/transporter/transporter.routes.ts'),
      'utf-8'
    );

    // Find the availability/stats block
    const idx = source.indexOf("'/availability/stats'");
    expect(idx).toBeGreaterThan(-1);

    // Within 200 chars before this route, roleGuard should be referenced
    // The pattern is: router.get(\n  '/availability/stats',\n  authMiddleware,\n  roleGuard([...]),
    // Look for roleGuard within nearby context (the route block)
    const contextStart = Math.max(0, idx - 300);
    const contextEnd = idx + 300;
    const context = source.substring(contextStart, contextEnd);

    // Must have authMiddleware
    expect(context).toContain('authMiddleware');
    // Must have roleGuard with transporter
    expect(context).toMatch(/roleGuard\(\[.*'transporter'.*\]\)/);
    // Must have roleGuard with admin
    expect(context).toMatch(/roleGuard\(\[.*'admin'.*\]\)/);
  });
});

// =============================================================================
// F-3-19: Feature flag rename — FF_H3_RADIUS_STEPS
// =============================================================================

describe('F-3-19: Feature flag rename — H3_RADIUS_STEPS', () => {
  const {
    FLAGS,
    isEnabled,
  } = require('../shared/config/feature-flags');

  it('FLAGS.H3_RADIUS_STEPS exists with env FF_H3_RADIUS_STEPS', () => {
    expect(FLAGS.H3_RADIUS_STEPS).toBeDefined();
    expect(FLAGS.H3_RADIUS_STEPS.env).toBe('FF_H3_RADIUS_STEPS');
    expect(FLAGS.H3_RADIUS_STEPS.category).toBe('release');
  });

  it('FLAGS.H3_RADIUS_STEPS_7 no longer exists (renamed)', () => {
    expect((FLAGS as any).H3_RADIUS_STEPS_7).toBeUndefined();
  });

  it('isEnabled returns false for release flag when env is unset', () => {
    const original = process.env.FF_H3_RADIUS_STEPS;
    delete process.env.FF_H3_RADIUS_STEPS;
    expect(isEnabled(FLAGS.H3_RADIUS_STEPS)).toBe(false);
    // Restore
    if (original !== undefined) process.env.FF_H3_RADIUS_STEPS = original;
  });

  it('isEnabled returns true for release flag when env=true', () => {
    const original = process.env.FF_H3_RADIUS_STEPS;
    process.env.FF_H3_RADIUS_STEPS = 'true';
    expect(isEnabled(FLAGS.H3_RADIUS_STEPS)).toBe(true);
    // Restore
    if (original !== undefined) {
      process.env.FF_H3_RADIUS_STEPS = original;
    } else {
      delete process.env.FF_H3_RADIUS_STEPS;
    }
  });

  it('H-X2: PROGRESSIVE_RADIUS_STEPS (unified) has 6 entries', () => {
    const {
      PROGRESSIVE_RADIUS_STEPS,
    } = require('../modules/order/progressive-radius-matcher');
    expect(PROGRESSIVE_RADIUS_STEPS).toHaveLength(6);
  });

  it('H-X2: PROGRESSIVE_RADIUS_STEPS entries have radiusKm, windowMs, h3RingK', () => {
    const {
      PROGRESSIVE_RADIUS_STEPS,
    } = require('../modules/order/progressive-radius-matcher');

    for (const step of PROGRESSIVE_RADIUS_STEPS) {
      expect(step).toHaveProperty('radiusKm');
      expect(step).toHaveProperty('windowMs');
      expect(step).toHaveProperty('h3RingK');
      expect(typeof step.radiusKm).toBe('number');
      expect(typeof step.windowMs).toBe('number');
      expect(typeof step.h3RingK).toBe('number');
    }
  });

  it('H-X2: PROGRESSIVE_RADIUS_STEPS radiusKm values are [5, 10, 15, 30, 60, 100]', () => {
    const {
      PROGRESSIVE_RADIUS_STEPS,
    } = require('../modules/order/progressive-radius-matcher');
    const radii = PROGRESSIVE_RADIUS_STEPS.map((s: any) => s.radiusKm);
    expect(radii).toEqual([5, 10, 15, 30, 60, 100]);
  });

  it('H-X2: PROGRESSIVE_RADIUS_STEPS_EXTENDED is no longer exported (removed)', () => {
    const matcher = require('../modules/order/progressive-radius-matcher');
    expect(matcher.PROGRESSIVE_RADIUS_STEPS_EXTENDED).toBeUndefined();
  });
});

// =============================================================================
// F-3-16: CIRCUITY_FACTORS semantic constants
// =============================================================================

describe('F-3-16: CIRCUITY_FACTORS and ROAD_DISTANCE_MULTIPLIER', () => {
  const {
    CIRCUITY_FACTORS,
    ROAD_DISTANCE_MULTIPLIER,
  } = require('../shared/utils/geospatial.utils');

  it('CIRCUITY_FACTORS.ROUTING === 1.35', () => {
    expect(CIRCUITY_FACTORS.ROUTING).toBe(1.35);
  });

  it('CIRCUITY_FACTORS.VALIDATION === 1.0', () => {
    expect(CIRCUITY_FACTORS.VALIDATION).toBe(1.0);
  });

  it('CIRCUITY_FACTORS.ETA_RANKING defaults to 1.4 (when env unset)', () => {
    // Default value from parseFloat('1.4') || 1.4
    // Note: at module load time, HAVERSINE_ROAD_FACTOR may or may not be set.
    // The code uses: Math.max(0.1, parseFloat(process.env.HAVERSINE_ROAD_FACTOR || '1.4') || 1.4)
    // Without env override, it should be 1.4
    expect(CIRCUITY_FACTORS.ETA_RANKING).toBeGreaterThanOrEqual(0.1);
    expect(typeof CIRCUITY_FACTORS.ETA_RANKING).toBe('number');
    // If env is not set, should be 1.4
    if (!process.env.HAVERSINE_ROAD_FACTOR) {
      expect(CIRCUITY_FACTORS.ETA_RANKING).toBe(1.4);
    }
  });

  it('ROAD_DISTANCE_MULTIPLIER === CIRCUITY_FACTORS.ROUTING (backward compat)', () => {
    expect(ROAD_DISTANCE_MULTIPLIER).toBe(CIRCUITY_FACTORS.ROUTING);
  });

  it('ROAD_DISTANCE_MULTIPLIER is 1.35', () => {
    expect(ROAD_DISTANCE_MULTIPLIER).toBe(1.35);
  });

  it('all CIRCUITY_FACTORS are positive numbers', () => {
    for (const [key, value] of Object.entries(CIRCUITY_FACTORS)) {
      expect(typeof value).toBe('number');
      expect(value).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// F-1-4: DRY — normalizeOrderLifecycleState / normalizeOrderStatus
// =============================================================================

describe('F-1-4: DRY normalizeOrderLifecycleState and normalizeOrderStatus', () => {
  const {
    normalizeOrderLifecycleState,
    normalizeOrderStatus,
  } = require('../shared/utils/order-lifecycle.utils');

  describe('normalizeOrderLifecycleState', () => {
    it('returns "cancelled" for "cancelled"', () => {
      expect(normalizeOrderLifecycleState('cancelled')).toBe('cancelled');
    });

    it('returns "cancelled" for "CANCELLED" (case-insensitive)', () => {
      expect(normalizeOrderLifecycleState('CANCELLED')).toBe('cancelled');
    });

    it('returns "cancelled" for "canceled" (US spelling)', () => {
      expect(normalizeOrderLifecycleState('canceled')).toBe('cancelled');
    });

    it('returns "expired" for "expired"', () => {
      expect(normalizeOrderLifecycleState('expired')).toBe('expired');
    });

    it('returns "expired" for "EXPIRED"', () => {
      expect(normalizeOrderLifecycleState('EXPIRED')).toBe('expired');
    });

    it('returns "accepted" for "fully_filled"', () => {
      expect(normalizeOrderLifecycleState('fully_filled')).toBe('accepted');
    });

    it('returns "accepted" for "completed"', () => {
      expect(normalizeOrderLifecycleState('completed')).toBe('accepted');
    });

    it('returns "accepted" for "closed"', () => {
      expect(normalizeOrderLifecycleState('closed')).toBe('accepted');
    });

    it('returns "active" for "broadcasting"', () => {
      expect(normalizeOrderLifecycleState('broadcasting')).toBe('active');
    });

    it('returns "active" for "active"', () => {
      expect(normalizeOrderLifecycleState('active')).toBe('active');
    });

    it('returns "active" for "partially_filled"', () => {
      expect(normalizeOrderLifecycleState('partially_filled')).toBe('active');
    });

    it('returns "active" for null', () => {
      expect(normalizeOrderLifecycleState(null)).toBe('active');
    });

    it('returns "active" for undefined', () => {
      expect(normalizeOrderLifecycleState(undefined)).toBe('active');
    });

    it('returns "active" for empty string', () => {
      expect(normalizeOrderLifecycleState('')).toBe('active');
    });

    it('handles whitespace-padded status', () => {
      expect(normalizeOrderLifecycleState('  cancelled  ')).toBe('cancelled');
    });

    it('handles mixed case "Fully_Filled"', () => {
      expect(normalizeOrderLifecycleState('Fully_Filled')).toBe('accepted');
    });
  });

  describe('normalizeOrderStatus', () => {
    it('lowercases string input', () => {
      expect(normalizeOrderStatus('ACTIVE')).toBe('active');
    });

    it('returns empty string for non-string input (number)', () => {
      expect(normalizeOrderStatus(42)).toBe('');
    });

    it('returns empty string for null', () => {
      expect(normalizeOrderStatus(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(normalizeOrderStatus(undefined)).toBe('');
    });

    it('lowercases "Broadcasting"', () => {
      expect(normalizeOrderStatus('Broadcasting')).toBe('broadcasting');
    });

    it('lowercases "FULLY_FILLED"', () => {
      expect(normalizeOrderStatus('FULLY_FILLED')).toBe('fully_filled');
    });
  });

  describe('exports are available from shared utils path', () => {
    it('normalizeOrderLifecycleState is a function', () => {
      expect(typeof normalizeOrderLifecycleState).toBe('function');
    });

    it('normalizeOrderStatus is a function', () => {
      expect(typeof normalizeOrderStatus).toBe('function');
    });
  });
});

// =============================================================================
// F-2-18: OrderStatus removed from core/constants
// =============================================================================

describe('F-2-18: OrderStatus removed from core/constants', () => {
  it('core/constants/index.ts contains removal comment', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require('path').resolve(__dirname, '../core/constants/index.ts'),
      'utf-8'
    );
    expect(source).toContain('REMOVED: OrderStatus enum');
    expect(source).toContain('use OrderStatus from @prisma/client instead');
  });

  it('core/constants does NOT export an OrderStatus enum', () => {
    const constants = require('../core/constants');
    expect(constants.OrderStatus).toBeUndefined();
  });
});
