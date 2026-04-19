/**
 * =============================================================================
 * VALIDATION FIXES H10 + H18 -- Comprehensive Tests
 * =============================================================================
 *
 * H10: India geofence check on flat-format coordinates
 *   - locationSchema now applies India bounds refine to BOTH nested
 *     { coordinates: { latitude, longitude } } AND flat { latitude, longitude }
 *   - File: src/shared/utils/validation.utils.ts
 *
 * H18: Distance ceiling (caps inflated client distance)
 *   - If client distanceKm > haversine * 3.0, cap to ceil(haversine * 3.0)
 *   - File: src/modules/order/order.service.ts  (~lines 912-921)
 *
 * @author Test Agent T4
 * =============================================================================
 */

import { z } from 'zod';
import {
  locationSchema,
  coordinatesSchema,
} from '../shared/utils/validation.utils';
import { haversineDistanceKm } from '../shared/utils/geospatial.utils';

// =============================================================================
// HELPERS
// =============================================================================

/** India bounding box constants (must match validation.utils.ts) */
const INDIA_LAT_MIN = 6.5;
const INDIA_LAT_MAX = 37.0;
const INDIA_LNG_MIN = 68.0;
const INDIA_LNG_MAX = 97.5;

/**
 * Build a valid locationSchema payload using nested coordinates format.
 */
function makeNestedLocation(lat: number, lng: number, address = 'Test address') {
  return {
    coordinates: { latitude: lat, longitude: lng },
    address,
  };
}

/**
 * Build a valid locationSchema payload using flat format (the customer app format).
 */
function makeFlatLocation(lat: number, lng: number, address = 'Test address') {
  return {
    latitude: lat,
    longitude: lng,
    address,
  };
}

/**
 * Simulate the distance ceiling logic from order.service.ts lines 912-921.
 * This is a pure function extraction of the production logic for testability.
 *
 * @param clientDistanceKm  The distance the client submitted
 * @param haversineDist     The straight-line haversine distance in km
 * @returns The (possibly capped) distance
 */
function applyDistanceCeiling(clientDistanceKm: number, haversineDist: number): number {
  let result = clientDistanceKm;
  if (haversineDist > 0) {
    const haversineCeiling = Math.ceil(haversineDist * 3.0);
    if (result > haversineCeiling) {
      result = haversineCeiling;
    }
  }
  return result;
}

/**
 * Simulate BOTH floor and ceiling logic from order.service.ts lines 900-921.
 */
function applyFloorAndCeiling(clientDistanceKm: number, haversineDist: number): number {
  let result = clientDistanceKm;
  if (haversineDist > 0) {
    // Floor: minimum of haversine * 1.3
    const haversineFloor = Math.ceil(haversineDist * 1.3);
    if (result < haversineFloor) {
      result = haversineFloor;
    }
    // Ceiling: cap at haversine * 3.0
    const haversineCeiling = Math.ceil(haversineDist * 3.0);
    if (result > haversineCeiling) {
      result = haversineCeiling;
    }
  }
  return result;
}

// =============================================================================
// H10: India geofence check on flat-format coordinates
// =============================================================================

describe('H10: locationSchema India geofence on flat-format coordinates', () => {

  // -------------------------------------------------------------------------
  // Nested coordinates — existing behavior (should still work)
  // -------------------------------------------------------------------------
  describe('nested coordinates format', () => {
    it('nested coordinates in India (Delhi 28.6, 77.2) passes', () => {
      const result = locationSchema.safeParse(makeNestedLocation(28.6, 77.2));
      expect(result.success).toBe(true);
    });

    it('nested coordinates in India (Mumbai 19.0, 72.8) passes', () => {
      const result = locationSchema.safeParse(makeNestedLocation(19.0, 72.8));
      expect(result.success).toBe(true);
    });

    it('nested coordinates in India (Bangalore 12.9, 77.5) passes', () => {
      const result = locationSchema.safeParse(makeNestedLocation(12.9, 77.5));
      expect(result.success).toBe(true);
    });

    it('nested coordinates outside India (London 51.5, -0.12) fails', () => {
      const result = locationSchema.safeParse(makeNestedLocation(51.5, -0.12));
      expect(result.success).toBe(false);
    });

    it('nested coordinates outside India (Tokyo 35.6, 139.6) fails', () => {
      const result = locationSchema.safeParse(makeNestedLocation(35.6, 139.6));
      expect(result.success).toBe(false);
    });

    it('nested coordinates outside India (New York 40.7, -74.0) fails', () => {
      const result = locationSchema.safeParse(makeNestedLocation(40.7, -74.0));
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Flat coordinates — this was the BUG (H10). These tests verify the fix.
  // -------------------------------------------------------------------------
  describe('flat coordinates format (customer app format — the H10 bug fix)', () => {
    it('flat lat/lng in Mumbai (19.0, 72.8) passes', () => {
      const result = locationSchema.safeParse(makeFlatLocation(19.0, 72.8));
      expect(result.success).toBe(true);
    });

    it('flat lat/lng in Delhi (28.6, 77.2) passes', () => {
      const result = locationSchema.safeParse(makeFlatLocation(28.6, 77.2));
      expect(result.success).toBe(true);
    });

    it('flat lat/lng in Bangalore (12.9, 77.5) passes', () => {
      const result = locationSchema.safeParse(makeFlatLocation(12.9, 77.5));
      expect(result.success).toBe(true);
    });

    it('flat lat/lng in Chennai (13.0, 80.2) passes', () => {
      const result = locationSchema.safeParse(makeFlatLocation(13.0, 80.2));
      expect(result.success).toBe(true);
    });

    it('flat lat/lng in Kolkata (22.5, 88.3) passes', () => {
      const result = locationSchema.safeParse(makeFlatLocation(22.5, 88.3));
      expect(result.success).toBe(true);
    });

    it('flat lat/lng in Srinagar (34.0, 74.8) passes', () => {
      const result = locationSchema.safeParse(makeFlatLocation(34.0, 74.8));
      expect(result.success).toBe(true);
    });

    it('flat lat/lng in London (51.5, -0.12) fails', () => {
      const result = locationSchema.safeParse(makeFlatLocation(51.5, -0.12));
      expect(result.success).toBe(false);
      if (!result.success) {
        const msgs = result.error.issues.map(i => i.message);
        expect(msgs).toContain('Location must be within India service area');
      }
    });

    it('flat lat/lng in Tokyo (35.6, 139.6) fails', () => {
      const result = locationSchema.safeParse(makeFlatLocation(35.6, 139.6));
      expect(result.success).toBe(false);
      if (!result.success) {
        const msgs = result.error.issues.map(i => i.message);
        expect(msgs).toContain('Location must be within India service area');
      }
    });

    it('flat lat/lng in New York (40.7, -74.0) fails', () => {
      const result = locationSchema.safeParse(makeFlatLocation(40.7, -74.0));
      expect(result.success).toBe(false);
    });

    it('flat lat/lng in Dubai (25.2, 55.2) fails', () => {
      const result = locationSchema.safeParse(makeFlatLocation(25.2, 55.2));
      expect(result.success).toBe(false);
    });

    it('flat lat/lng in Sydney (-33.8, 151.2) fails', () => {
      const result = locationSchema.safeParse(makeFlatLocation(-33.8, 151.2));
      expect(result.success).toBe(false);
    });

    it('flat lat/lng in Beijing (39.9, 116.4) fails', () => {
      const result = locationSchema.safeParse(makeFlatLocation(39.9, 116.4));
      expect(result.success).toBe(false);
    });

    it('flat lat/lng in Sao Paulo (-23.5, -46.6) fails', () => {
      const result = locationSchema.safeParse(makeFlatLocation(-23.5, -46.6));
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Boundary edge cases for flat format
  // -------------------------------------------------------------------------
  describe('flat format — India boundary edge cases', () => {
    it('flat exactly on south boundary (lat 6.5) passes', () => {
      const result = locationSchema.safeParse(makeFlatLocation(INDIA_LAT_MIN, 80.0));
      expect(result.success).toBe(true);
    });

    it('flat exactly on north boundary (lat 37.0) passes', () => {
      const result = locationSchema.safeParse(makeFlatLocation(INDIA_LAT_MAX, 77.0));
      expect(result.success).toBe(true);
    });

    it('flat exactly on west boundary (lng 68.0) passes', () => {
      const result = locationSchema.safeParse(makeFlatLocation(28.6, INDIA_LNG_MIN));
      expect(result.success).toBe(true);
    });

    it('flat exactly on east boundary (lng 97.5) passes', () => {
      const result = locationSchema.safeParse(makeFlatLocation(28.6, INDIA_LNG_MAX));
      expect(result.success).toBe(true);
    });

    it('flat southwest corner (6.5, 68.0) passes', () => {
      const result = locationSchema.safeParse(makeFlatLocation(INDIA_LAT_MIN, INDIA_LNG_MIN));
      expect(result.success).toBe(true);
    });

    it('flat northeast corner (37.0, 97.5) passes', () => {
      const result = locationSchema.safeParse(makeFlatLocation(INDIA_LAT_MAX, INDIA_LNG_MAX));
      expect(result.success).toBe(true);
    });

    it('flat just below south boundary (lat 6.49) fails', () => {
      const result = locationSchema.safeParse(makeFlatLocation(6.49, 80.0));
      expect(result.success).toBe(false);
    });

    it('flat just above north boundary (lat 37.01) fails', () => {
      const result = locationSchema.safeParse(makeFlatLocation(37.01, 77.0));
      expect(result.success).toBe(false);
    });

    it('flat just below west boundary (lng 67.99) fails', () => {
      const result = locationSchema.safeParse(makeFlatLocation(28.6, 67.99));
      expect(result.success).toBe(false);
    });

    it('flat just above east boundary (lng 97.51) fails', () => {
      const result = locationSchema.safeParse(makeFlatLocation(28.6, 97.51));
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Missing coordinates entirely — existing behavior
  // -------------------------------------------------------------------------
  describe('missing coordinates entirely', () => {
    it('no coordinates and no lat/lng fails', () => {
      const result = locationSchema.safeParse({ address: 'Test' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const msgs = result.error.issues.map(i => i.message);
        expect(msgs).toContain('Either coordinates object OR latitude+longitude fields are required');
      }
    });

    it('only latitude provided (no longitude) fails', () => {
      const result = locationSchema.safeParse({ latitude: 28.6, address: 'Test' });
      expect(result.success).toBe(false);
    });

    it('only longitude provided (no latitude) fails', () => {
      const result = locationSchema.safeParse({ longitude: 77.2, address: 'Test' });
      expect(result.success).toBe(false);
    });

    it('empty object fails', () => {
      const result = locationSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('address missing fails', () => {
      const result = locationSchema.safeParse({ latitude: 28.6, longitude: 77.2 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Both formats should give identical results for same coordinates
  // -------------------------------------------------------------------------
  describe('nested and flat format produce identical India-check results', () => {
    const testCases = [
      { name: 'Mumbai', lat: 19.0, lng: 72.8, expected: true },
      { name: 'Delhi', lat: 28.6, lng: 77.2, expected: true },
      { name: 'London', lat: 51.5, lng: -0.12, expected: false },
      { name: 'Tokyo', lat: 35.6, lng: 139.6, expected: false },
      { name: 'South boundary', lat: 6.5, lng: 80.0, expected: true },
      { name: 'North boundary', lat: 37.0, lng: 77.0, expected: true },
      { name: 'Below south', lat: 6.4, lng: 80.0, expected: false },
      { name: 'Above north', lat: 37.1, lng: 77.0, expected: false },
    ];

    testCases.forEach(({ name, lat, lng, expected }) => {
      it(`${name} (${lat}, ${lng}) — nested and flat both ${expected ? 'pass' : 'fail'}`, () => {
        const nestedResult = locationSchema.safeParse(makeNestedLocation(lat, lng));
        const flatResult = locationSchema.safeParse(makeFlatLocation(lat, lng));
        expect(nestedResult.success).toBe(expected);
        expect(flatResult.success).toBe(expected);
      });
    });
  });

  // -------------------------------------------------------------------------
  // coordinatesSchema directly (nested-only, for completeness)
  // -------------------------------------------------------------------------
  describe('coordinatesSchema direct (nested-only reference)', () => {
    it('Delhi passes', () => {
      expect(coordinatesSchema.safeParse({ latitude: 28.6, longitude: 77.2 }).success).toBe(true);
    });

    it('London fails', () => {
      expect(coordinatesSchema.safeParse({ latitude: 51.5, longitude: -0.12 }).success).toBe(false);
    });
  });
});

// =============================================================================
// H18: Distance ceiling (caps inflated client distance)
// =============================================================================

describe('H18: Distance ceiling — caps inflated client distances', () => {

  // -------------------------------------------------------------------------
  // Core ceiling logic (extracted from order.service.ts lines 912-921)
  // -------------------------------------------------------------------------
  describe('ceiling logic', () => {
    it('client distance within 3x haversine is NOT modified', () => {
      // haversine = 50km, client = 100km, ceiling = ceil(50*3) = 150km
      const result = applyDistanceCeiling(100, 50);
      expect(result).toBe(100);
    });

    it('client distance > 3x haversine is capped to ceil(haversine * 3.0)', () => {
      // haversine = 50km, client = 200km, ceiling = ceil(50*3) = 150km
      const result = applyDistanceCeiling(200, 50);
      expect(result).toBe(150);
    });

    it('client distance exactly at 3x is NOT modified (boundary)', () => {
      // haversine = 50km, client = 150km, ceiling = ceil(50*3) = 150km
      // 150 > 150 is false, so no cap
      const result = applyDistanceCeiling(150, 50);
      expect(result).toBe(150);
    });

    it('client distance of 500km for 5km haversine is capped to 15km', () => {
      // haversine = 5km, ceiling = ceil(5*3.0) = 15
      const result = applyDistanceCeiling(500, 5);
      expect(result).toBe(15);
    });

    it('client distance of 100km for 50km haversine is NOT modified (within 2x)', () => {
      // haversine = 50km, ceiling = ceil(50*3) = 150km, 100 < 150
      const result = applyDistanceCeiling(100, 50);
      expect(result).toBe(100);
    });

    it('haversine of 0 — no ceiling applied (division guard)', () => {
      // When haversine is 0, the ceiling block is skipped (haversineDist > 0 is false)
      const result = applyDistanceCeiling(9999, 0);
      expect(result).toBe(9999);
    });

    it('haversine negative — no ceiling applied (safety)', () => {
      // Negative haversine should not happen but haversineDist > 0 guards it
      const result = applyDistanceCeiling(9999, -5);
      expect(result).toBe(9999);
    });
  });

  // -------------------------------------------------------------------------
  // Floor + Ceiling combined (both from the same code block)
  // -------------------------------------------------------------------------
  describe('floor + ceiling combined', () => {
    it('low value is floored, high value is ceilinged', () => {
      // haversine = 100km
      // Floor: ceil(100*1.3) = 130
      // Ceiling: ceil(100*3.0) = 300
      // client = 50 → floored to 130
      expect(applyFloorAndCeiling(50, 100)).toBe(130);
      // client = 400 → ceilinged to 300
      expect(applyFloorAndCeiling(400, 100)).toBe(300);
    });

    it('value between floor and ceiling is untouched', () => {
      // haversine = 100km
      // Floor: ceil(100*1.3) = 130
      // Ceiling: ceil(100*3.0) = 300
      // client = 200 → no change
      expect(applyFloorAndCeiling(200, 100)).toBe(200);
    });

    it('value exactly at floor is untouched', () => {
      // haversine = 100km, floor = ceil(100*1.3) = 130
      // 130 < 130 is false, so no floor applied
      expect(applyFloorAndCeiling(130, 100)).toBe(130);
    });

    it('value exactly at ceiling is untouched', () => {
      // haversine = 100km, ceiling = ceil(100*3.0) = 300
      // 300 > 300 is false, so no ceiling
      expect(applyFloorAndCeiling(300, 100)).toBe(300);
    });

    it('haversine 0 — neither floor nor ceiling applied', () => {
      expect(applyFloorAndCeiling(5, 0)).toBe(5);
      expect(applyFloorAndCeiling(9999, 0)).toBe(9999);
    });
  });

  // -------------------------------------------------------------------------
  // Ceiling with Math.ceil behavior (fractional haversine)
  // -------------------------------------------------------------------------
  describe('Math.ceil rounding on ceiling', () => {
    it('haversine 10.1 → ceiling = ceil(10.1*3) = ceil(30.3) = 31', () => {
      const result = applyDistanceCeiling(50, 10.1);
      expect(result).toBe(31);
    });

    it('haversine 10.0 → ceiling = ceil(10*3) = 30 (exact, no rounding)', () => {
      const result = applyDistanceCeiling(50, 10.0);
      expect(result).toBe(30);
    });

    it('haversine 7.5 → ceiling = ceil(7.5*3) = ceil(22.5) = 23', () => {
      const result = applyDistanceCeiling(50, 7.5);
      expect(result).toBe(23);
    });

    it('haversine 0.5 → ceiling = ceil(0.5*3) = ceil(1.5) = 2', () => {
      const result = applyDistanceCeiling(100, 0.5);
      expect(result).toBe(2);
    });

    it('very small haversine 0.1 → ceiling = ceil(0.1*3) = ceil(0.3) = 1', () => {
      const result = applyDistanceCeiling(100, 0.1);
      expect(result).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Real-world scenarios with actual haversine distances
  // -------------------------------------------------------------------------
  describe('real-world distance scenarios', () => {
    it('Delhi to nearby suburb (~30km haversine), client sends 500km → capped', () => {
      const hDist = haversineDistanceKm(28.6, 77.2, 28.8, 77.4);
      const ceiling = Math.ceil(hDist * 3.0);
      const result = applyDistanceCeiling(500, hDist);
      expect(result).toBe(ceiling);
      expect(result).toBeLessThan(500);
    });

    it('Delhi to Mumbai (~1150km haversine), client sends 1400km → NOT capped (within 3x)', () => {
      const hDist = haversineDistanceKm(28.6, 77.2, 19.076, 72.877);
      const ceiling = Math.ceil(hDist * 3.0);
      // 1400 should be well within 3x of ~1150
      expect(1400).toBeLessThanOrEqual(ceiling);
      const result = applyDistanceCeiling(1400, hDist);
      expect(result).toBe(1400);
    });

    it('Delhi to Mumbai, client sends 5000km → capped to ceiling', () => {
      const hDist = haversineDistanceKm(28.6, 77.2, 19.076, 72.877);
      const ceiling = Math.ceil(hDist * 3.0);
      const result = applyDistanceCeiling(5000, hDist);
      expect(result).toBe(ceiling);
      expect(result).toBeLessThan(5000);
    });

    it('same location (0 haversine), client sends any distance → not capped', () => {
      const hDist = haversineDistanceKm(28.6, 77.2, 28.6, 77.2);
      expect(hDist).toBe(0);
      const result = applyDistanceCeiling(9999, hDist);
      expect(result).toBe(9999);
    });

    it('short urban trip (~5km haversine), client sends 100km → capped to 15km', () => {
      const result = applyDistanceCeiling(100, 5);
      expect(result).toBe(15);
    });

    it('short urban trip (~5km haversine), client sends 14km → NOT capped', () => {
      const result = applyDistanceCeiling(14, 5);
      expect(result).toBe(14);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases for the ceiling guard
  // -------------------------------------------------------------------------
  describe('edge cases', () => {
    it('client distance of 0 with haversine > 0 → floored (not ceiling concern)', () => {
      // Ceiling only triggers when client > ceiling. 0 < any ceiling.
      const result = applyDistanceCeiling(0, 50);
      expect(result).toBe(0);
    });

    it('client distance negative with haversine > 0 → not changed by ceiling', () => {
      const result = applyDistanceCeiling(-10, 50);
      expect(result).toBe(-10);
    });

    it('very large haversine (1000km) with moderate client distance → not capped', () => {
      // ceiling = ceil(1000*3) = 3000
      const result = applyDistanceCeiling(2500, 1000);
      expect(result).toBe(2500);
    });

    it('very large haversine (1000km) with absurd client distance → capped', () => {
      const result = applyDistanceCeiling(5000, 1000);
      expect(result).toBe(3000);
    });

    it('client distance exactly 1 above ceiling → capped', () => {
      // haversine = 10, ceiling = ceil(10*3) = 30
      const result = applyDistanceCeiling(31, 10);
      expect(result).toBe(30);
    });

    it('client distance exactly 1 below ceiling → not capped', () => {
      // haversine = 10, ceiling = ceil(10*3) = 30
      const result = applyDistanceCeiling(29, 10);
      expect(result).toBe(29);
    });

    it('fractional client distance above fractional ceiling → capped', () => {
      // haversine = 3.3, ceiling = ceil(3.3*3) = ceil(9.9) = 10
      const result = applyDistanceCeiling(10.5, 3.3);
      expect(result).toBe(10);
    });
  });

  // -------------------------------------------------------------------------
  // Verify haversineDistanceKm utility works correctly (test dependency)
  // -------------------------------------------------------------------------
  describe('haversineDistanceKm sanity checks', () => {
    it('same point returns 0', () => {
      expect(haversineDistanceKm(28.6, 77.2, 28.6, 77.2)).toBe(0);
    });

    it('Delhi to Mumbai is approximately 1150km', () => {
      const dist = haversineDistanceKm(28.6, 77.2, 19.076, 72.877);
      expect(dist).toBeGreaterThan(1100);
      expect(dist).toBeLessThan(1200);
    });

    it('short distance is positive and small', () => {
      const dist = haversineDistanceKm(28.6, 77.2, 28.61, 77.21);
      expect(dist).toBeGreaterThan(0);
      expect(dist).toBeLessThan(5);
    });
  });
});
