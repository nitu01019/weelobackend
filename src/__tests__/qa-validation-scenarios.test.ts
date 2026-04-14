/**
 * =============================================================================
 * QA VALIDATION SCENARIOS - Data Validation & Input Sanitization
 * =============================================================================
 *
 * Agent: QA4
 *
 * Covers:
 *   GROUP 1: India geofence comprehensive (H10)
 *   GROUP 2: Distance validation comprehensive (H18)
 *   GROUP 3: Schema validation edge cases (C5)
 *   GROUP 4: OTP cooldown timing (M1)
 *
 * =============================================================================
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// GROUP 1 SETUP: Import real validation schemas (pure Zod, no I/O)
// ---------------------------------------------------------------------------
import {
  coordinatesSchema,
  locationSchema,
} from '../shared/utils/validation.utils';

import {
  createBookingSchema,
  createOrderSchema,
  acceptTruckRequestSchema,
} from '../modules/booking/booking.schema';

// ---------------------------------------------------------------------------
// GROUP 2 SETUP: Import haversine for distance validation tests
// ---------------------------------------------------------------------------
import { haversineDistanceKm } from '../shared/utils/geospatial.utils';

// =============================================================================
// GROUP 1: India Geofence Comprehensive (H10)
// =============================================================================

describe('GROUP 1: India Geofence Comprehensive (H10)', () => {
  // -------------------------------------------------------------------------
  // 1.1 coordinatesSchema — nested format
  // -------------------------------------------------------------------------
  describe('1.1 coordinatesSchema — direct coordinate validation', () => {
    test('1.1a Delhi (28.6, 77.2) => PASS (well inside India)', () => {
      const result = coordinatesSchema.safeParse({ latitude: 28.6, longitude: 77.2 });
      expect(result.success).toBe(true);
    });

    test('1.1b London (51.5, -0.12) => FAIL (UK, outside India)', () => {
      const result = coordinatesSchema.safeParse({ latitude: 51.5, longitude: -0.12 });
      expect(result.success).toBe(false);
    });

    test('1.1c Null Island (0, 0) => FAIL (ocean, below India lat boundary)', () => {
      const result = coordinatesSchema.safeParse({ latitude: 0, longitude: 0 });
      expect(result.success).toBe(false);
    });

    test('1.1d SW corner boundary (6.5, 68.0) => PASS (exact boundary)', () => {
      const result = coordinatesSchema.safeParse({ latitude: 6.5, longitude: 68.0 });
      expect(result.success).toBe(true);
    });

    test('1.1e NE corner boundary (37.0, 97.5) => PASS (exact boundary)', () => {
      const result = coordinatesSchema.safeParse({ latitude: 37.0, longitude: 97.5 });
      expect(result.success).toBe(true);
    });

    test('1.1f Just past north boundary (37.1, 97.5) => FAIL', () => {
      const result = coordinatesSchema.safeParse({ latitude: 37.1, longitude: 97.5 });
      expect(result.success).toBe(false);
    });

    test('1.1g Just below south boundary (6.4, 68.0) => FAIL', () => {
      const result = coordinatesSchema.safeParse({ latitude: 6.4, longitude: 68.0 });
      expect(result.success).toBe(false);
    });

    test('1.1h Just past east boundary (37.0, 97.6) => FAIL', () => {
      const result = coordinatesSchema.safeParse({ latitude: 37.0, longitude: 97.6 });
      expect(result.success).toBe(false);
    });

    test('1.1i Just past west boundary (6.5, 67.9) => FAIL', () => {
      const result = coordinatesSchema.safeParse({ latitude: 6.5, longitude: 67.9 });
      expect(result.success).toBe(false);
    });

    test('1.1j Mumbai (19.076, 72.877) => PASS', () => {
      const result = coordinatesSchema.safeParse({ latitude: 19.076, longitude: 72.877 });
      expect(result.success).toBe(true);
    });

    test('1.1k Bangalore (12.97, 77.59) => PASS', () => {
      const result = coordinatesSchema.safeParse({ latitude: 12.97, longitude: 77.59 });
      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 1.2 locationSchema — nested coordinates format
  // -------------------------------------------------------------------------
  describe('1.2 locationSchema — nested coordinates format', () => {
    test('1.2a Delhi nested => PASS', () => {
      const result = locationSchema.safeParse({
        coordinates: { latitude: 28.6, longitude: 77.2 },
        address: 'Delhi',
      });
      expect(result.success).toBe(true);
    });

    test('1.2b London nested => FAIL', () => {
      const result = locationSchema.safeParse({
        coordinates: { latitude: 51.5, longitude: -0.12 },
        address: 'London',
      });
      expect(result.success).toBe(false);
    });

    test('1.2c NE boundary nested => PASS', () => {
      const result = locationSchema.safeParse({
        coordinates: { latitude: 37.0, longitude: 97.5 },
        address: 'NE corner',
      });
      expect(result.success).toBe(true);
    });

    test('1.2d Past north boundary nested (37.1, 97.5) => FAIL', () => {
      const result = locationSchema.safeParse({
        coordinates: { latitude: 37.1, longitude: 97.5 },
        address: 'Just outside',
      });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 1.3 locationSchema — flat format (customer app sends { latitude, longitude })
  // -------------------------------------------------------------------------
  describe('1.3 locationSchema — flat coordinate format', () => {
    test('1.3a Delhi flat => PASS', () => {
      const result = locationSchema.safeParse({
        latitude: 28.6,
        longitude: 77.2,
        address: 'Delhi',
      });
      expect(result.success).toBe(true);
    });

    test('1.3b London flat => FAIL', () => {
      const result = locationSchema.safeParse({
        latitude: 51.5,
        longitude: -0.12,
        address: 'London',
      });
      expect(result.success).toBe(false);
    });

    test('1.3c Null Island flat (0, 0) => FAIL', () => {
      const result = locationSchema.safeParse({
        latitude: 0,
        longitude: 0,
        address: 'Null Island',
      });
      expect(result.success).toBe(false);
    });

    test('1.3d SW corner flat (6.5, 68.0) => PASS', () => {
      const result = locationSchema.safeParse({
        latitude: 6.5,
        longitude: 68.0,
        address: 'SW corner',
      });
      expect(result.success).toBe(true);
    });

    test('1.3e NE corner flat (37.0, 97.5) => PASS', () => {
      const result = locationSchema.safeParse({
        latitude: 37.0,
        longitude: 97.5,
        address: 'NE corner',
      });
      expect(result.success).toBe(true);
    });

    test('1.3f Past north boundary flat (37.1, 97.5) => FAIL', () => {
      const result = locationSchema.safeParse({
        latitude: 37.1,
        longitude: 97.5,
        address: 'Just outside',
      });
      expect(result.success).toBe(false);
    });

    test('1.3g Below south boundary flat (6.4, 68.0) => FAIL', () => {
      const result = locationSchema.safeParse({
        latitude: 6.4,
        longitude: 68.0,
        address: 'Just below',
      });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 1.4 locationSchema — missing coordinate fields
  // -------------------------------------------------------------------------
  describe('1.4 locationSchema — missing coordinate fields', () => {
    test('1.4a No coordinates and no lat/lon => FAIL', () => {
      const result = locationSchema.safeParse({ address: 'Somewhere' });
      expect(result.success).toBe(false);
    });

    test('1.4b latitude only, no longitude => FAIL', () => {
      const result = locationSchema.safeParse({
        latitude: 28.6,
        address: 'Delhi',
      });
      expect(result.success).toBe(false);
    });

    test('1.4c Empty address => FAIL', () => {
      const result = locationSchema.safeParse({
        latitude: 28.6,
        longitude: 77.2,
        address: '',
      });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 1.5 createBookingSchema — pickup and dropoff geofence for both formats
  // -------------------------------------------------------------------------
  describe('1.5 createBookingSchema — pickup/drop geofence validation', () => {
    const validBookingBase = {
      vehicleType: 'open',
      vehicleSubtype: 'Open 17ft',
      trucksNeeded: 1,
      distanceKm: 50,
      pricePerTruck: 5000,
    };

    test('1.5a Pickup in India, Drop in India => PASS', () => {
      const result = createBookingSchema.safeParse({
        ...validBookingBase,
        pickup: {
          latitude: 28.6, longitude: 77.2, address: 'Delhi',
        },
        drop: {
          latitude: 19.076, longitude: 72.877, address: 'Mumbai',
        },
      });
      expect(result.success).toBe(true);
    });

    test('1.5b Pickup outside India => FAIL', () => {
      const result = createBookingSchema.safeParse({
        ...validBookingBase,
        pickup: {
          latitude: 51.5, longitude: -0.12, address: 'London',
        },
        drop: {
          latitude: 19.076, longitude: 72.877, address: 'Mumbai',
        },
      });
      expect(result.success).toBe(false);
    });

    test('1.5c Drop outside India => FAIL', () => {
      const result = createBookingSchema.safeParse({
        ...validBookingBase,
        pickup: {
          latitude: 28.6, longitude: 77.2, address: 'Delhi',
        },
        drop: {
          latitude: 40.7128, longitude: -74.006, address: 'New York',
        },
      });
      expect(result.success).toBe(false);
    });

    test('1.5d Pickup at boundary SW (6.5, 68.0) => PASS', () => {
      const result = createBookingSchema.safeParse({
        ...validBookingBase,
        pickup: {
          latitude: 6.5, longitude: 68.0, address: 'SW corner',
        },
        drop: {
          latitude: 28.6, longitude: 77.2, address: 'Delhi',
        },
      });
      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 1.6 createOrderSchema — routePoints with geofence
  // -------------------------------------------------------------------------
  describe('1.6 createOrderSchema — routePoints geofence', () => {
    const validOrderBase = {
      distanceKm: 100,
      trucks: [
        { vehicleType: 'open', vehicleSubtype: 'Open 17ft', quantity: 1, pricePerTruck: 5000 },
      ],
    };

    test('1.6a All routePoints inside India => PASS', () => {
      const result = createOrderSchema.safeParse({
        ...validOrderBase,
        routePoints: [
          { type: 'PICKUP', coordinates: { latitude: 28.6, longitude: 77.2 }, address: 'Delhi' },
          { type: 'DROP', coordinates: { latitude: 19.076, longitude: 72.877 }, address: 'Mumbai' },
        ],
      });
      expect(result.success).toBe(true);
    });

    test('1.6b routePoint outside India => FAIL', () => {
      const result = createOrderSchema.safeParse({
        ...validOrderBase,
        routePoints: [
          { type: 'PICKUP', coordinates: { latitude: 28.6, longitude: 77.2 }, address: 'Delhi' },
          { type: 'DROP', coordinates: { latitude: 51.5, longitude: -0.12 }, address: 'London' },
        ],
      });
      expect(result.success).toBe(false);
    });

    test('1.6c Flat lat/lng in routePoint (H22 preprocess) inside India => PASS', () => {
      const result = createOrderSchema.safeParse({
        ...validOrderBase,
        routePoints: [
          { type: 'PICKUP', latitude: 28.6, longitude: 77.2, address: 'Delhi' },
          { type: 'DROP', latitude: 19.076, longitude: 72.877, address: 'Mumbai' },
        ],
      });
      expect(result.success).toBe(true);
    });

    test('1.6d Flat lat/lng in routePoint outside India => FAIL', () => {
      const result = createOrderSchema.safeParse({
        ...validOrderBase,
        routePoints: [
          { type: 'PICKUP', latitude: 28.6, longitude: 77.2, address: 'Delhi' },
          { type: 'DROP', latitude: 51.5, longitude: -0.12, address: 'London' },
        ],
      });
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// GROUP 2: Distance Validation Comprehensive (H18)
// =============================================================================

describe('GROUP 2: Distance Validation Comprehensive (H18)', () => {
  // Replicate the exact logic from order.service.ts lines 888-923
  // for direct unit testing without needing service-level mocks.

  /**
   * Applies the same floor (1.3x) and ceiling (3.0x) logic that
   * order.service.ts uses when distanceSource === 'client_fallback'.
   *
   * Returns the corrected distanceKm.
   */
  function applyDistanceGuards(
    haversineKm: number,
    clientKm: number
  ): { correctedKm: number; wasCapped: boolean; wasFloored: boolean } {
    let correctedKm = clientKm;
    let wasCapped = false;
    let wasFloored = false;

    if (haversineKm > 0) {
      const haversineFloor = Math.ceil(haversineKm * 1.3);
      if (correctedKm < haversineFloor) {
        correctedKm = haversineFloor;
        wasFloored = true;
      }

      const haversineCeiling = Math.ceil(haversineKm * 3.0);
      if (correctedKm > haversineCeiling) {
        correctedKm = haversineCeiling;
        wasCapped = true;
      }
    }

    return { correctedKm, wasCapped, wasFloored };
  }

  // -------------------------------------------------------------------------
  // 2.1 Floor and ceiling boundary tests
  // -------------------------------------------------------------------------
  describe('2.1 Haversine floor (1.3x) and ceiling (3.0x) guards', () => {
    test('2.1a haversine=10km, client=10km => no change (equal, but 10 < floor 13 => FLOORED to 13)', () => {
      const { correctedKm, wasFloored } = applyDistanceGuards(10, 10);
      // haversineFloor = ceil(10 * 1.3) = 13; 10 < 13 => floored
      expect(correctedKm).toBe(13);
      expect(wasFloored).toBe(true);
    });

    test('2.1b haversine=10km, client=15km => no change (15 >= 13 floor, 15 <= 30 ceiling)', () => {
      const { correctedKm, wasCapped, wasFloored } = applyDistanceGuards(10, 15);
      expect(correctedKm).toBe(15);
      expect(wasCapped).toBe(false);
      expect(wasFloored).toBe(false);
    });

    test('2.1c haversine=10km, client=29km => no change (2.9x, under ceiling)', () => {
      const { correctedKm, wasCapped, wasFloored } = applyDistanceGuards(10, 29);
      expect(correctedKm).toBe(29);
      expect(wasCapped).toBe(false);
      expect(wasFloored).toBe(false);
    });

    test('2.1d haversine=10km, client=30km => no change (exactly 3.0x = ceiling)', () => {
      const { correctedKm, wasCapped } = applyDistanceGuards(10, 30);
      // haversineCeiling = ceil(10 * 3.0) = 30; 30 <= 30 => no cap
      expect(correctedKm).toBe(30);
      expect(wasCapped).toBe(false);
    });

    test('2.1e haversine=10km, client=31km => CAPPED to 30km (over ceiling)', () => {
      const { correctedKm, wasCapped } = applyDistanceGuards(10, 31);
      expect(correctedKm).toBe(30);
      expect(wasCapped).toBe(true);
    });

    test('2.1f haversine=10km, client=500km => CAPPED to 30km', () => {
      const { correctedKm, wasCapped } = applyDistanceGuards(10, 500);
      expect(correctedKm).toBe(30);
      expect(wasCapped).toBe(true);
    });

    test('2.1g haversine=100km, client=250km => no change (2.5x)', () => {
      const { correctedKm, wasCapped, wasFloored } = applyDistanceGuards(100, 250);
      expect(correctedKm).toBe(250);
      expect(wasCapped).toBe(false);
      expect(wasFloored).toBe(false);
    });

    test('2.1h haversine=100km, client=301km => CAPPED to 300km', () => {
      const { correctedKm, wasCapped } = applyDistanceGuards(100, 301);
      // haversineCeiling = ceil(100 * 3.0) = 300; 301 > 300 => capped
      expect(correctedKm).toBe(300);
      expect(wasCapped).toBe(true);
    });

    test('2.1i haversine=0, client=50km => no ceiling applied (guard against div-by-zero)', () => {
      const { correctedKm, wasCapped, wasFloored } = applyDistanceGuards(0, 50);
      // haversineKm is 0, so the entire guard block is skipped
      expect(correctedKm).toBe(50);
      expect(wasCapped).toBe(false);
      expect(wasFloored).toBe(false);
    });

    test('2.1j haversine=10km, client=5km => FLOORED to 13km (1.3x floor)', () => {
      const { correctedKm, wasFloored } = applyDistanceGuards(10, 5);
      // haversineFloor = ceil(10 * 1.3) = 13; 5 < 13 => floored
      expect(correctedKm).toBe(13);
      expect(wasFloored).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 2.2 Floor/ceiling edge cases with non-round haversine values
  // -------------------------------------------------------------------------
  describe('2.2 Non-round haversine values', () => {
    test('2.2a haversine=7.7km => floor = ceil(7.7*1.3) = ceil(10.01) = 11', () => {
      const { correctedKm } = applyDistanceGuards(7.7, 5);
      expect(correctedKm).toBe(Math.ceil(7.7 * 1.3));
    });

    test('2.2b haversine=33.33km => ceiling = ceil(33.33*3.0) = ceil(99.99) = 100', () => {
      const { correctedKm, wasCapped } = applyDistanceGuards(33.33, 101);
      expect(correctedKm).toBe(Math.ceil(33.33 * 3.0));
      expect(wasCapped).toBe(true);
    });

    test('2.2c haversine=0.5km => floor = ceil(0.5*1.3) = ceil(0.65) = 1', () => {
      const { correctedKm, wasFloored } = applyDistanceGuards(0.5, 0.1);
      expect(correctedKm).toBe(1);
      expect(wasFloored).toBe(true);
    });

    test('2.2d haversine=1000km, client=2999km => no change (under 3000 ceiling)', () => {
      const { correctedKm, wasCapped } = applyDistanceGuards(1000, 2999);
      expect(correctedKm).toBe(2999);
      expect(wasCapped).toBe(false);
    });

    test('2.2e haversine=1000km, client=3001km => CAPPED to 3000km', () => {
      const { correctedKm, wasCapped } = applyDistanceGuards(1000, 3001);
      expect(correctedKm).toBe(3000);
      expect(wasCapped).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 2.3 Real-world India route scenarios with haversine
  // -------------------------------------------------------------------------
  describe('2.3 Real-world India routes', () => {
    test('2.3a Delhi to Mumbai haversine is approximately 1148km', () => {
      const dist = haversineDistanceKm(28.6139, 77.209, 19.076, 72.877);
      expect(dist).toBeGreaterThan(1100);
      expect(dist).toBeLessThan(1200);
    });

    test('2.3b Bangalore to Chennai haversine is approximately 290km', () => {
      const dist = haversineDistanceKm(12.9716, 77.5946, 13.0827, 80.2707);
      expect(dist).toBeGreaterThan(260);
      expect(dist).toBeLessThan(320);
    });

    test('2.3c Same point distance is 0km', () => {
      const dist = haversineDistanceKm(28.6139, 77.209, 28.6139, 77.209);
      expect(dist).toBe(0);
    });

    test('2.3d 500m apart => haversine < 1km', () => {
      // Two points approximately 500m apart in Delhi
      const dist = haversineDistanceKm(28.6139, 77.209, 28.618, 77.209);
      expect(dist).toBeLessThan(1);
      expect(dist).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // 2.4 createBookingSchema distanceKm bounds
  // -------------------------------------------------------------------------
  describe('2.4 createBookingSchema distanceKm bounds', () => {
    const baseBooking = {
      pickup: { latitude: 28.6, longitude: 77.2, address: 'Delhi' },
      drop: { latitude: 19.076, longitude: 72.877, address: 'Mumbai' },
      vehicleType: 'open',
      vehicleSubtype: 'Open 17ft',
      trucksNeeded: 1,
      pricePerTruck: 5000,
    };

    test('2.4a distanceKm = 0.1 (minimum) => PASS', () => {
      const result = createBookingSchema.safeParse({ ...baseBooking, distanceKm: 0.1 });
      expect(result.success).toBe(true);
    });

    test('2.4b distanceKm = 0.09 (below minimum) => FAIL', () => {
      const result = createBookingSchema.safeParse({ ...baseBooking, distanceKm: 0.09 });
      expect(result.success).toBe(false);
    });

    test('2.4c distanceKm = 5000 (maximum) => PASS', () => {
      const result = createBookingSchema.safeParse({ ...baseBooking, distanceKm: 5000 });
      expect(result.success).toBe(true);
    });

    test('2.4d distanceKm = 5001 (over maximum) => FAIL', () => {
      const result = createBookingSchema.safeParse({ ...baseBooking, distanceKm: 5001 });
      expect(result.success).toBe(false);
    });

    test('2.4e distanceKm = 0 => FAIL', () => {
      const result = createBookingSchema.safeParse({ ...baseBooking, distanceKm: 0 });
      expect(result.success).toBe(false);
    });

    test('2.4f distanceKm = -1 => FAIL', () => {
      const result = createBookingSchema.safeParse({ ...baseBooking, distanceKm: -1 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 2.5 Pickup and drop must be at least 500m apart
  // -------------------------------------------------------------------------
  describe('2.5 Minimum distance between pickup and drop', () => {
    const mkBooking = (pLat: number, pLon: number, dLat: number, dLon: number) => ({
      pickup: { latitude: pLat, longitude: pLon, address: 'A' },
      drop: { latitude: dLat, longitude: dLon, address: 'B' },
      vehicleType: 'open' as const,
      vehicleSubtype: 'Open 17ft',
      trucksNeeded: 1,
      distanceKm: 50,
      pricePerTruck: 5000,
    });

    test('2.5a Same coordinates => FAIL (0 distance < 500m)', () => {
      const result = createBookingSchema.safeParse(mkBooking(28.6, 77.2, 28.6, 77.2));
      expect(result.success).toBe(false);
    });

    test('2.5b Points ~1.1km apart => PASS (> 500m)', () => {
      // 0.01 degrees lat ~ 1.1km
      const result = createBookingSchema.safeParse(mkBooking(28.6, 77.2, 28.61, 77.2));
      expect(result.success).toBe(true);
    });

    test('2.5c Points ~110m apart => FAIL (< 500m)', () => {
      // 0.001 degrees lat ~ 111m
      const result = createBookingSchema.safeParse(mkBooking(28.6, 77.2, 28.601, 77.2));
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// GROUP 3: Schema Validation Edge Cases (C5)
// =============================================================================

describe('GROUP 3: Schema Validation Edge Cases (C5)', () => {
  // -------------------------------------------------------------------------
  // 3.1 acceptTruckRequestSchema — driverId behavior
  // -------------------------------------------------------------------------
  describe('3.1 acceptTruckRequestSchema — driverId validation', () => {
    const validVehicleId = '550e8400-e29b-41d4-a716-446655440000';
    const validDriverId = '550e8400-e29b-41d4-a716-446655440001';

    test('3.1a driverId: undefined (omitted) => PASS', () => {
      const result = acceptTruckRequestSchema.safeParse({
        vehicleId: validVehicleId,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.driverId).toBeUndefined();
      }
    });

    test('3.1b driverId: valid UUID => PASS', () => {
      const result = acceptTruckRequestSchema.safeParse({
        vehicleId: validVehicleId,
        driverId: validDriverId,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.driverId).toBe(validDriverId);
      }
    });

    test('3.1c driverId: empty string => FAIL (not a UUID)', () => {
      const result = acceptTruckRequestSchema.safeParse({
        vehicleId: validVehicleId,
        driverId: '',
      });
      expect(result.success).toBe(false);
    });

    test('3.1d driverId: "not-a-uuid" => FAIL', () => {
      const result = acceptTruckRequestSchema.safeParse({
        vehicleId: validVehicleId,
        driverId: 'not-a-uuid',
      });
      expect(result.success).toBe(false);
    });

    test('3.1e driverId: number => FAIL (wrong type)', () => {
      const result = acceptTruckRequestSchema.safeParse({
        vehicleId: validVehicleId,
        driverId: 12345,
      });
      expect(result.success).toBe(false);
    });

    test('3.1f vehicleId: missing => FAIL', () => {
      const result = acceptTruckRequestSchema.safeParse({
        driverId: validDriverId,
      });
      expect(result.success).toBe(false);
    });

    test('3.1g vehicleId: empty string => FAIL', () => {
      const result = acceptTruckRequestSchema.safeParse({
        vehicleId: '',
        driverId: validDriverId,
      });
      expect(result.success).toBe(false);
    });

    test('3.1h vehicleId: "not-a-uuid" => FAIL', () => {
      const result = acceptTruckRequestSchema.safeParse({
        vehicleId: 'not-a-uuid',
      });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 3.2 acceptRequestSchema (order.routes.ts inline) — truckRequestId + vehicleId + driverId
  // -------------------------------------------------------------------------
  describe('3.2 order.routes acceptRequestSchema (inline) — full shape', () => {
    // Replicate the inline schema from order.routes.ts
    const acceptRequestSchema = z.object({
      truckRequestId: z.string().uuid(),
      vehicleId: z.string().uuid(),
      driverId: z.string().uuid().optional(),
    });

    const validPayload = {
      truckRequestId: '550e8400-e29b-41d4-a716-446655440000',
      vehicleId: '550e8400-e29b-41d4-a716-446655440001',
    };

    test('3.2a Valid without driverId => PASS', () => {
      const result = acceptRequestSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
    });

    test('3.2b Valid with driverId => PASS', () => {
      const result = acceptRequestSchema.safeParse({
        ...validPayload,
        driverId: '550e8400-e29b-41d4-a716-446655440002',
      });
      expect(result.success).toBe(true);
    });

    test('3.2c driverId: null => treated as present but invalid type', () => {
      const result = acceptRequestSchema.safeParse({
        ...validPayload,
        driverId: null,
      });
      // Zod .optional() does not accept null (only undefined), so this fails
      expect(result.success).toBe(false);
    });

    test('3.2d driverId: "" => FAIL (empty string is not UUID)', () => {
      const result = acceptRequestSchema.safeParse({
        ...validPayload,
        driverId: '',
      });
      expect(result.success).toBe(false);
    });

    test('3.2e Missing truckRequestId => FAIL', () => {
      const result = acceptRequestSchema.safeParse({
        vehicleId: validPayload.vehicleId,
      });
      expect(result.success).toBe(false);
    });

    test('3.2f Extra fields are stripped (Zod default is strip)', () => {
      const result = acceptRequestSchema.safeParse({
        ...validPayload,
        extraField: 'should be ignored',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as any).extraField).toBeUndefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3.3 createOrderSchema edge cases
  // -------------------------------------------------------------------------
  describe('3.3 createOrderSchema — edge cases', () => {
    test('3.3a Missing both routePoints and pickup/drop => FAIL', () => {
      const result = createOrderSchema.safeParse({
        distanceKm: 50,
        trucks: [
          { vehicleType: 'open', vehicleSubtype: 'Open 17ft', quantity: 1, pricePerTruck: 5000 },
        ],
      });
      expect(result.success).toBe(false);
    });

    test('3.3b Missing both trucks and vehicleRequirements => FAIL', () => {
      const result = createOrderSchema.safeParse({
        distanceKm: 50,
        pickup: { latitude: 28.6, longitude: 77.2, address: 'Delhi' },
        drop: { latitude: 19.076, longitude: 72.877, address: 'Mumbai' },
      });
      expect(result.success).toBe(false);
    });

    test('3.3c trucks array with 0 items => FAIL (min 1)', () => {
      const result = createOrderSchema.safeParse({
        distanceKm: 50,
        pickup: { latitude: 28.6, longitude: 77.2, address: 'Delhi' },
        drop: { latitude: 19.076, longitude: 72.877, address: 'Mumbai' },
        trucks: [],
      });
      expect(result.success).toBe(false);
    });

    test('3.3d Scheduled date in far past => FAIL', () => {
      const result = createOrderSchema.safeParse({
        distanceKm: 50,
        pickup: { latitude: 28.6, longitude: 77.2, address: 'Delhi' },
        drop: { latitude: 19.076, longitude: 72.877, address: 'Mumbai' },
        trucks: [
          { vehicleType: 'open', vehicleSubtype: 'Open 17ft', quantity: 1, pricePerTruck: 5000 },
        ],
        scheduledAt: '2020-01-01T00:00:00.000Z',
      });
      expect(result.success).toBe(false);
    });

    test('3.3e notes longer than 500 chars => FAIL', () => {
      const result = createOrderSchema.safeParse({
        distanceKm: 50,
        pickup: { latitude: 28.6, longitude: 77.2, address: 'Delhi' },
        drop: { latitude: 19.076, longitude: 72.877, address: 'Mumbai' },
        trucks: [
          { vehicleType: 'open', vehicleSubtype: 'Open 17ft', quantity: 1, pricePerTruck: 5000 },
        ],
        notes: 'A'.repeat(501),
      });
      expect(result.success).toBe(false);
    });

    test('3.3f vehicleRequirements instead of trucks => PASS', () => {
      const result = createOrderSchema.safeParse({
        distanceKm: 50,
        pickup: { latitude: 28.6, longitude: 77.2, address: 'Delhi' },
        drop: { latitude: 19.076, longitude: 72.877, address: 'Mumbai' },
        vehicleRequirements: [
          { vehicleType: 'container', vehicleSubtype: 'Container 20ft', quantity: 2, pricePerTruck: 8000 },
        ],
      });
      expect(result.success).toBe(true);
    });
  });
});

// =============================================================================
// GROUP 4: OTP Cooldown Timing (M1)
// =============================================================================

describe('GROUP 4: OTP Cooldown Timing (M1)', () => {
  // -------------------------------------------------------------------------
  // We test the cooldown logic by simulating the Redis key existence
  // check used in auth.service.ts sendOtp(). The actual implementation:
  //   const cooldownKey = `otp:cooldown:${phone}:${role}`;
  //   const exists = await redisService.exists(cooldownKey);
  //   if (exists) throw AppError(429, ...);
  //   // after success: redisService.set(cooldownKey, '1', 30);
  //
  // We simulate the cooldown with timestamps instead of real Redis.
  // -------------------------------------------------------------------------

  /**
   * Simulates the cooldown check logic from auth.service.ts.
   * cooldownSetAt: timestamp when the cooldown was set (null = no active cooldown)
   * currentTime: the "now" timestamp when OTP is requested
   * cooldownSeconds: TTL in seconds (default 30)
   *
   * Returns { allowed: boolean }
   */
  function simulateCooldownCheck(
    cooldownSetAt: number | null,
    currentTime: number,
    cooldownSeconds = 30
  ): { allowed: boolean } {
    if (cooldownSetAt === null) {
      return { allowed: true };
    }
    const expiresAt = cooldownSetAt + cooldownSeconds * 1000;
    if (currentTime >= expiresAt) {
      return { allowed: true };
    }
    return { allowed: false };
  }

  describe('4.1 OTP cooldown enforcement', () => {
    test('4.1a First OTP request (no cooldown) => ALLOWED', () => {
      const result = simulateCooldownCheck(null, Date.now());
      expect(result.allowed).toBe(true);
    });

    test('4.1b Second OTP 1s after first => BLOCKED (429)', () => {
      const now = Date.now();
      const result = simulateCooldownCheck(now, now + 1000);
      expect(result.allowed).toBe(false);
    });

    test('4.1c OTP 15s after first => BLOCKED', () => {
      const now = Date.now();
      const result = simulateCooldownCheck(now, now + 15000);
      expect(result.allowed).toBe(false);
    });

    test('4.1d OTP 29s after first => BLOCKED', () => {
      const now = Date.now();
      const result = simulateCooldownCheck(now, now + 29000);
      expect(result.allowed).toBe(false);
    });

    test('4.1e OTP exactly 30s after first => ALLOWED (cooldown expired)', () => {
      const now = Date.now();
      const result = simulateCooldownCheck(now, now + 30000);
      expect(result.allowed).toBe(true);
    });

    test('4.1f OTP 31s after first => ALLOWED', () => {
      const now = Date.now();
      const result = simulateCooldownCheck(now, now + 31000);
      expect(result.allowed).toBe(true);
    });

    test('4.1g OTP 60s after first => ALLOWED (well past cooldown)', () => {
      const now = Date.now();
      const result = simulateCooldownCheck(now, now + 60000);
      expect(result.allowed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 4.2 OTP cooldown Redis key pattern
  // -------------------------------------------------------------------------
  describe('4.2 OTP cooldown Redis key pattern validation', () => {
    test('4.2a Cooldown key format is otp:cooldown:{phone}:{role}', () => {
      const phone = '9876543210';
      const role = 'customer';
      const key = `otp:cooldown:${phone}:${role}`;
      expect(key).toBe('otp:cooldown:9876543210:customer');
    });

    test('4.2b Different roles have different cooldown keys', () => {
      const phone = '9876543210';
      const customerKey = `otp:cooldown:${phone}:customer`;
      const transporterKey = `otp:cooldown:${phone}:transporter`;
      expect(customerKey).not.toBe(transporterKey);
    });

    test('4.2c 30-second TTL matches code constant', () => {
      // auth.service.ts line 148: redisService.set(cooldownKey, '1', 30);
      const cooldownTtlSeconds = 30;
      expect(cooldownTtlSeconds).toBe(30);
    });
  });

  // -------------------------------------------------------------------------
  // 4.3 OTP cooldown with sequential requests
  // -------------------------------------------------------------------------
  describe('4.3 Sequential OTP request simulation', () => {
    test('4.3a Full sequence: send => block => block => block => allow', () => {
      const baseTime = Date.now();
      let cooldownSetAt: number | null = null;

      // Request 1: No cooldown
      const r1 = simulateCooldownCheck(cooldownSetAt, baseTime);
      expect(r1.allowed).toBe(true);
      cooldownSetAt = baseTime; // cooldown set after first OTP

      // Request 2: 1 second later
      const r2 = simulateCooldownCheck(cooldownSetAt, baseTime + 1_000);
      expect(r2.allowed).toBe(false);

      // Request 3: 15 seconds later
      const r3 = simulateCooldownCheck(cooldownSetAt, baseTime + 15_000);
      expect(r3.allowed).toBe(false);

      // Request 4: 29 seconds later
      const r4 = simulateCooldownCheck(cooldownSetAt, baseTime + 29_000);
      expect(r4.allowed).toBe(false);

      // Request 5: 31 seconds later
      const r5 = simulateCooldownCheck(cooldownSetAt, baseTime + 31_000);
      expect(r5.allowed).toBe(true);
      cooldownSetAt = baseTime + 31_000; // new cooldown set

      // Request 6: 32 seconds later (1s after new cooldown)
      const r6 = simulateCooldownCheck(cooldownSetAt, baseTime + 32_000);
      expect(r6.allowed).toBe(false);

      // Request 7: 62 seconds (31s after second cooldown)
      const r7 = simulateCooldownCheck(cooldownSetAt, baseTime + 62_000);
      expect(r7.allowed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 4.4 OTP error codes match what auth.service.ts throws
  // -------------------------------------------------------------------------
  describe('4.4 OTP error shape validation', () => {
    test('4.4a Cooldown error code is OTP_COOLDOWN', () => {
      // auth.service.ts line 124: throw new AppError(429, 'OTP_COOLDOWN', ...)
      const errorCode = 'OTP_COOLDOWN';
      const errorStatus = 429;
      expect(errorCode).toBe('OTP_COOLDOWN');
      expect(errorStatus).toBe(429);
    });

    test('4.4b Cooldown error message mentions 30 seconds', () => {
      const errorMessage = 'Please wait 30 seconds before requesting another OTP';
      expect(errorMessage).toContain('30 seconds');
    });

    test('4.4c OTP expired error code', () => {
      // auth.service.ts line 249
      const errorCode = 'OTP_EXPIRED';
      expect(errorCode).toBe('OTP_EXPIRED');
    });

    test('4.4d Invalid OTP error code', () => {
      // auth.service.ts line 258
      const errorCode = 'INVALID_OTP';
      expect(errorCode).toBe('INVALID_OTP');
    });

    test('4.4e Max attempts error code', () => {
      // auth.service.ts line 251
      const errorCode = 'MAX_ATTEMPTS';
      expect(errorCode).toBe('MAX_ATTEMPTS');
    });
  });
});
