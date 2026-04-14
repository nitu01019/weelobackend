/**
 * =============================================================================
 * VALIDATION FIXES -- Exhaustive Tests
 * =============================================================================
 *
 * Tests for Problems #4, #5, #6, #10, #23, #25, #31
 *
 * Category 1: distanceKm decimal support (#4 / #23)
 * Category 2: pricePerTruck decimal + max cap (#5 / #10)
 * Category 3: coordinatesSchema India bounding box (#6)
 * Category 4: bookingStatusSchema new values (#25)
 * Category 5: pickup != drop minimum distance (#31)
 *
 * @author LEO-TEST-1 -- Team LEO Wave 2
 * =============================================================================
 */

import { z } from 'zod';
import {
  coordinatesSchema,
  bookingStatusSchema,
} from '../shared/utils/validation.utils';
import {
  createBookingSchema,
  createOrderSchema,
  truckSelectionSchema,
} from '../modules/booking/booking.schema';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Build a minimal valid createBooking payload.
 * Override specific fields in individual tests.
 */
function makeBookingPayload(overrides: Record<string, any> = {}) {
  return {
    pickup: {
      coordinates: { latitude: 28.6, longitude: 77.2 },
      address: 'Delhi pickup',
    },
    drop: {
      coordinates: { latitude: 19.076, longitude: 72.877 },
      address: 'Mumbai drop',
    },
    vehicleType: 'open',
    vehicleSubtype: 'Open 17ft',
    trucksNeeded: 1,
    distanceKm: 1400,
    pricePerTruck: 25000,
    ...overrides,
  };
}

/**
 * Build a minimal valid createOrder payload.
 */
function makeOrderPayload(overrides: Record<string, any> = {}) {
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

// =============================================================================
// CATEGORY 1: distanceKm validation (#4 / #23)
// =============================================================================

describe('Category 1: distanceKm validation (#4 / #23)', () => {
  // ---- createBookingSchema distanceKm ----
  describe('createBookingSchema.distanceKm', () => {
    it('accepts integer distance (1) -- was valid, still valid', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ distanceKm: 1 }));
      expect(result.success).toBe(true);
    });

    it('accepts decimal distance (12.5) -- was rejected by .int(), now valid', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ distanceKm: 12.5 }));
      expect(result.success).toBe(true);
    });

    it('accepts minimum boundary (0.1)', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ distanceKm: 0.1 }));
      expect(result.success).toBe(true);
    });

    it('rejects below minimum (0.09)', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ distanceKm: 0.09 }));
      expect(result.success).toBe(false);
    });

    it('rejects zero', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ distanceKm: 0 }));
      expect(result.success).toBe(false);
    });

    it('rejects negative value (-1)', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ distanceKm: -1 }));
      expect(result.success).toBe(false);
    });

    it('accepts large valid distance (5000)', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ distanceKm: 5000 }));
      expect(result.success).toBe(true);
    });

    it('rejects string ("abc")', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ distanceKm: 'abc' }));
      expect(result.success).toBe(false);
    });

    it('rejects null', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ distanceKm: null }));
      expect(result.success).toBe(false);
    });

    it('rejects undefined (missing field)', () => {
      const payload = makeBookingPayload();
      delete payload.distanceKm;
      const result = createBookingSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it('rejects NaN', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ distanceKm: NaN }));
      expect(result.success).toBe(false);
    });

    // Fix A5: .max(5000) now rejects Infinity
    it('rejects Infinity (Fix A5: max(5000) closes this gap)', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ distanceKm: Infinity }));
      expect(result.success).toBe(false);
    });

    it('accepts sub-1km decimal (0.5)', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ distanceKm: 0.5 }));
      expect(result.success).toBe(true);
    });

    it('accepts large decimal (999.99)', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ distanceKm: 999.99 }));
      expect(result.success).toBe(true);
    });

    it('accepts float that equals integer (1.0)', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ distanceKm: 1.0 }));
      expect(result.success).toBe(true);
    });

    it('accepts simulated Google Maps distance (47.3)', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ distanceKm: 47.3 }));
      expect(result.success).toBe(true);
    });

    it('rejects empty string', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ distanceKm: '' }));
      expect(result.success).toBe(false);
    });

    it('rejects boolean true', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ distanceKm: true }));
      expect(result.success).toBe(false);
    });

    it('rejects array', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ distanceKm: [12.5] }));
      expect(result.success).toBe(false);
    });

    it('rejects object', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ distanceKm: { km: 12 } }));
      expect(result.success).toBe(false);
    });
  });

  // ---- createOrderSchema distanceKm (same .number().min(0.1)) ----
  describe('createOrderSchema.distanceKm', () => {
    it('accepts integer distance (1)', () => {
      const result = createOrderSchema.safeParse(makeOrderPayload({ distanceKm: 1 }));
      expect(result.success).toBe(true);
    });

    it('accepts decimal distance (12.5)', () => {
      const result = createOrderSchema.safeParse(makeOrderPayload({ distanceKm: 12.5 }));
      expect(result.success).toBe(true);
    });

    it('accepts minimum boundary (0.1)', () => {
      const result = createOrderSchema.safeParse(makeOrderPayload({ distanceKm: 0.1 }));
      expect(result.success).toBe(true);
    });

    it('rejects below minimum (0.09)', () => {
      const result = createOrderSchema.safeParse(makeOrderPayload({ distanceKm: 0.09 }));
      expect(result.success).toBe(false);
    });

    it('rejects zero', () => {
      const result = createOrderSchema.safeParse(makeOrderPayload({ distanceKm: 0 }));
      expect(result.success).toBe(false);
    });

    it('rejects negative value (-5)', () => {
      const result = createOrderSchema.safeParse(makeOrderPayload({ distanceKm: -5 }));
      expect(result.success).toBe(false);
    });

    it('accepts Google-style result (47.3)', () => {
      const result = createOrderSchema.safeParse(makeOrderPayload({ distanceKm: 47.3 }));
      expect(result.success).toBe(true);
    });

    it('rejects string type', () => {
      const result = createOrderSchema.safeParse(makeOrderPayload({ distanceKm: 'abc' }));
      expect(result.success).toBe(false);
    });

    it('rejects null', () => {
      const result = createOrderSchema.safeParse(makeOrderPayload({ distanceKm: null }));
      expect(result.success).toBe(false);
    });

    it('rejects NaN', () => {
      const result = createOrderSchema.safeParse(makeOrderPayload({ distanceKm: NaN }));
      expect(result.success).toBe(false);
    });
  });

  // ---- Both schemas behave the same ----
  describe('booking and order schemas behave identically for distanceKm', () => {
    const testValues = [0.1, 0.09, 12.5, -1, 0, 1, 5000];
    testValues.forEach((val) => {
      it(`distanceKm = ${val} gives same result in both schemas`, () => {
        const bookingResult = createBookingSchema.safeParse(makeBookingPayload({ distanceKm: val }));
        const orderResult = createOrderSchema.safeParse(makeOrderPayload({ distanceKm: val }));
        expect(bookingResult.success).toBe(orderResult.success);
      });
    });
  });
});

// =============================================================================
// CATEGORY 2: pricePerTruck validation (#5 / #10)
// =============================================================================

describe('Category 2: pricePerTruck validation (#5 / #10)', () => {
  // ---- truckSelectionSchema pricePerTruck ----
  describe('truckSelectionSchema.pricePerTruck', () => {
    function makeTruckSelection(price: any) {
      return {
        vehicleType: 'open',
        vehicleSubtype: 'Open 17ft',
        quantity: 1,
        pricePerTruck: price,
      };
    }

    it('accepts integer price (1000) -- meets open vehicle type floor', () => {
      const result = truckSelectionSchema.safeParse(makeTruckSelection(1000));
      expect(result.success).toBe(true);
    });

    it('accepts decimal price (1250.50) -- was rejected by .int(), now valid', () => {
      const result = truckSelectionSchema.safeParse(makeTruckSelection(1250.50));
      expect(result.success).toBe(true);
    });

    it('rejects below vehicle-type floor (500 for open)', () => {
      // M-22 FIX: open vehicle type has min price floor of 1000
      const result = truckSelectionSchema.safeParse(makeTruckSelection(500));
      expect(result.success).toBe(false);
    });

    it('rejects below minimum (0.99)', () => {
      const result = truckSelectionSchema.safeParse(makeTruckSelection(0.99));
      expect(result.success).toBe(false);
    });

    it('rejects zero', () => {
      const result = truckSelectionSchema.safeParse(makeTruckSelection(0));
      expect(result.success).toBe(false);
    });

    it('rejects negative price (-100)', () => {
      const result = truckSelectionSchema.safeParse(makeTruckSelection(-100));
      expect(result.success).toBe(false);
    });

    it('accepts max boundary (1000000)', () => {
      const result = truckSelectionSchema.safeParse(makeTruckSelection(1000000));
      expect(result.success).toBe(true);
    });

    it('rejects above max (1000001)', () => {
      const result = truckSelectionSchema.safeParse(makeTruckSelection(1000001));
      expect(result.success).toBe(false);
    });

    it('rejects huge value (999999999) -- Problem #10', () => {
      const result = truckSelectionSchema.safeParse(makeTruckSelection(999999999));
      expect(result.success).toBe(false);
    });

    it('accepts typical decimal fare (15999.75)', () => {
      const result = truckSelectionSchema.safeParse(makeTruckSelection(15999.75));
      expect(result.success).toBe(true);
    });

    it('rejects string ("abc")', () => {
      const result = truckSelectionSchema.safeParse(makeTruckSelection('abc'));
      expect(result.success).toBe(false);
    });

    it('rejects null', () => {
      const result = truckSelectionSchema.safeParse(makeTruckSelection(null));
      expect(result.success).toBe(false);
    });

    it('accepts pricing API result (14999.50)', () => {
      const result = truckSelectionSchema.safeParse(makeTruckSelection(14999.50));
      expect(result.success).toBe(true);
    });

    it('accepts just below max (999999)', () => {
      const result = truckSelectionSchema.safeParse(makeTruckSelection(999999));
      expect(result.success).toBe(true);
    });

    it('accepts exactly 999999.99 (just below cap)', () => {
      const result = truckSelectionSchema.safeParse(makeTruckSelection(999999.99));
      expect(result.success).toBe(true);
    });

    it('rejects NaN', () => {
      const result = truckSelectionSchema.safeParse(makeTruckSelection(NaN));
      expect(result.success).toBe(false);
    });

    it('rejects Infinity', () => {
      const result = truckSelectionSchema.safeParse(makeTruckSelection(Infinity));
      expect(result.success).toBe(false);
    });

    it('rejects boolean true', () => {
      const result = truckSelectionSchema.safeParse(makeTruckSelection(true));
      expect(result.success).toBe(false);
    });

    it('rejects empty string', () => {
      const result = truckSelectionSchema.safeParse(makeTruckSelection(''));
      expect(result.success).toBe(false);
    });

    it('accepts small decimal above vehicle-type floor (1000.01)', () => {
      const result = truckSelectionSchema.safeParse(makeTruckSelection(1000.01));
      expect(result.success).toBe(true);
    });
  });

  // ---- createBookingSchema pricePerTruck (same rule) ----
  describe('createBookingSchema.pricePerTruck', () => {
    it('accepts integer price (500)', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ pricePerTruck: 500 }));
      expect(result.success).toBe(true);
    });

    it('accepts decimal price (1250.50)', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ pricePerTruck: 1250.50 }));
      expect(result.success).toBe(true);
    });

    it('rejects below minimum (0.99)', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ pricePerTruck: 0.99 }));
      expect(result.success).toBe(false);
    });

    it('rejects above max (1000001)', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ pricePerTruck: 1000001 }));
      expect(result.success).toBe(false);
    });

    it('rejects huge value (999999999)', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ pricePerTruck: 999999999 }));
      expect(result.success).toBe(false);
    });

    it('accepts max boundary (1000000)', () => {
      const result = createBookingSchema.safeParse(makeBookingPayload({ pricePerTruck: 1000000 }));
      expect(result.success).toBe(true);
    });
  });

  // ---- Both schemas behave the same ----
  describe('truckSelection and createBooking schemas behave identically for pricePerTruck', () => {
    // M-22 FIX: truckSelectionSchema now has per-vehicle-type min price floors.
    // For vehicleType 'open', the floor is 1000. Values below the floor fail on
    // truckSelectionSchema but may pass on createBookingSchema (which has no refine).
    // Test with values that produce the same result on both schemas:
    const testValues = [0.99, 1000, 1250.50, 1000000, 1000001, 999999999];
    testValues.forEach((val) => {
      it(`pricePerTruck = ${val} gives same result in both schemas`, () => {
        const truckResult = truckSelectionSchema.safeParse({
          vehicleType: 'open',
          vehicleSubtype: 'Open 17ft',
          quantity: 1,
          pricePerTruck: val,
        });
        const bookingResult = createBookingSchema.safeParse(makeBookingPayload({ pricePerTruck: val }));
        expect(truckResult.success).toBe(bookingResult.success);
      });
    });
  });
});

// =============================================================================
// CATEGORY 3: coordinatesSchema India bounding box (#6)
// =============================================================================

describe('Category 3: coordinatesSchema India bounding box (#6)', () => {
  function parseCoords(lat: number, lng: number) {
    return coordinatesSchema.safeParse({ latitude: lat, longitude: lng });
  }

  // ---- Valid Indian cities ----
  describe('valid Indian locations', () => {
    it('Delhi (28.6, 77.2)', () => {
      expect(parseCoords(28.6, 77.2).success).toBe(true);
    });

    it('Mumbai (19.0, 72.8)', () => {
      expect(parseCoords(19.0, 72.8).success).toBe(true);
    });

    it('Bangalore (12.9, 77.5)', () => {
      expect(parseCoords(12.9, 77.5).success).toBe(true);
    });

    it('Chennai (13.0, 80.2)', () => {
      expect(parseCoords(13.0, 80.2).success).toBe(true);
    });

    it('Kolkata (22.5, 88.3)', () => {
      expect(parseCoords(22.5, 88.3).success).toBe(true);
    });

    it('Kanyakumari (8.08, 77.5) -- southern tip', () => {
      expect(parseCoords(8.08, 77.5).success).toBe(true);
    });

    it('Andaman Islands (11.6, 92.7)', () => {
      expect(parseCoords(11.6, 92.7).success).toBe(true);
    });

    it('Lakshadweep (10.5, 72.6)', () => {
      expect(parseCoords(10.5, 72.6).success).toBe(true);
    });

    it('Srinagar (34.0, 74.8) -- northern', () => {
      expect(parseCoords(34.0, 74.8).success).toBe(true);
    });

    it('Arunachal Pradesh (28.2, 97.0) -- eastern', () => {
      expect(parseCoords(28.2, 97.0).success).toBe(true);
    });

    it('Kutch, Gujarat (23.7, 68.5) -- western', () => {
      expect(parseCoords(23.7, 68.5).success).toBe(true);
    });

    it('Hyderabad (17.38, 78.48)', () => {
      expect(parseCoords(17.38, 78.48).success).toBe(true);
    });

    it('Jaipur (26.9, 75.7)', () => {
      expect(parseCoords(26.9, 75.7).success).toBe(true);
    });
  });

  // ---- Invalid international locations ----
  describe('invalid international locations', () => {
    it('(0, 0) -- Gulf of Guinea -- FAIL', () => {
      expect(parseCoords(0, 0).success).toBe(false);
    });

    it('New York (40.7, -74.0) -- FAIL', () => {
      expect(parseCoords(40.7, -74.0).success).toBe(false);
    });

    it('London (51.5, -0.1) -- FAIL', () => {
      expect(parseCoords(51.5, -0.1).success).toBe(false);
    });

    it('Tokyo (35.6, 139.6) -- FAIL', () => {
      expect(parseCoords(35.6, 139.6).success).toBe(false);
    });

    it('Sydney (-33.8, 151.2) -- FAIL', () => {
      expect(parseCoords(-33.8, 151.2).success).toBe(false);
    });

    it('North Pole (90, 0) -- FAIL', () => {
      expect(parseCoords(90, 0).success).toBe(false);
    });

    it('South Pole (-90, 0) -- FAIL', () => {
      expect(parseCoords(-90, 0).success).toBe(false);
    });

    it('Dubai (25.2, 55.2) -- FAIL', () => {
      expect(parseCoords(25.2, 55.2).success).toBe(false);
    });

    it('Beijing (39.9, 116.4) -- FAIL', () => {
      expect(parseCoords(39.9, 116.4).success).toBe(false);
    });

    it('Sao Paulo (-23.5, -46.6) -- FAIL', () => {
      expect(parseCoords(-23.5, -46.6).success).toBe(false);
    });
  });

  // ---- Boundary edge: just outside India ----
  describe('just outside India boundaries -- must FAIL', () => {
    it('lat 6.4 (just below south boundary 6.5)', () => {
      expect(parseCoords(6.4, 80.0).success).toBe(false);
    });

    it('lat 37.1 (just above north boundary 37.0)', () => {
      expect(parseCoords(37.1, 77.0).success).toBe(false);
    });

    it('lng 67.9 (just below west boundary 68.0)', () => {
      expect(parseCoords(28.6, 67.9).success).toBe(false);
    });

    it('lng 97.6 (just above east boundary 97.5)', () => {
      expect(parseCoords(28.6, 97.6).success).toBe(false);
    });

    it('lat 6.49, lng 68.0 -- just below south', () => {
      expect(parseCoords(6.49, 68.0).success).toBe(false);
    });

    it('lat 37.01, lng 97.5 -- just above north', () => {
      expect(parseCoords(37.01, 97.5).success).toBe(false);
    });
  });

  // ---- Boundary edge: exactly on India boundary -- must PASS ----
  describe('exactly on India boundary -- must PASS', () => {
    it('lat 6.5 exactly (south boundary)', () => {
      expect(parseCoords(6.5, 80.0).success).toBe(true);
    });

    it('lat 37.0 exactly (north boundary)', () => {
      expect(parseCoords(37.0, 77.0).success).toBe(true);
    });

    it('lng 68.0 exactly (west boundary)', () => {
      expect(parseCoords(28.6, 68.0).success).toBe(true);
    });

    it('lng 97.5 exactly (east boundary)', () => {
      expect(parseCoords(28.6, 97.5).success).toBe(true);
    });

    it('southwest corner (6.5, 68.0)', () => {
      expect(parseCoords(6.5, 68.0).success).toBe(true);
    });

    it('northeast corner (37.0, 97.5)', () => {
      expect(parseCoords(37.0, 97.5).success).toBe(true);
    });

    it('northwest corner (37.0, 68.0)', () => {
      expect(parseCoords(37.0, 68.0).success).toBe(true);
    });

    it('southeast corner (6.5, 97.5)', () => {
      expect(parseCoords(6.5, 97.5).success).toBe(true);
    });
  });

  // ---- Type errors ----
  describe('type errors', () => {
    it('rejects string coordinates', () => {
      const result = coordinatesSchema.safeParse({ latitude: '28.6', longitude: '77.2' });
      expect(result.success).toBe(false);
    });

    it('rejects null coordinates', () => {
      const result = coordinatesSchema.safeParse({ latitude: null, longitude: null });
      expect(result.success).toBe(false);
    });

    it('rejects missing latitude', () => {
      const result = coordinatesSchema.safeParse({ longitude: 77.2 });
      expect(result.success).toBe(false);
    });

    it('rejects missing longitude', () => {
      const result = coordinatesSchema.safeParse({ latitude: 28.6 });
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// CATEGORY 4: bookingStatusSchema (#25)
// =============================================================================

describe('Category 4: bookingStatusSchema (#25)', () => {
  describe('newly added values', () => {
    it('accepts "created" -- newly added', () => {
      expect(bookingStatusSchema.safeParse('created').success).toBe(true);
    });

    it('accepts "broadcasting" -- newly added', () => {
      expect(bookingStatusSchema.safeParse('broadcasting').success).toBe(true);
    });
  });

  describe('previously valid values still valid', () => {
    it('accepts "active"', () => {
      expect(bookingStatusSchema.safeParse('active').success).toBe(true);
    });

    it('accepts "partially_filled"', () => {
      expect(bookingStatusSchema.safeParse('partially_filled').success).toBe(true);
    });

    it('accepts "fully_filled"', () => {
      expect(bookingStatusSchema.safeParse('fully_filled').success).toBe(true);
    });

    it('accepts "completed"', () => {
      expect(bookingStatusSchema.safeParse('completed').success).toBe(true);
    });

    it('accepts "cancelled"', () => {
      expect(bookingStatusSchema.safeParse('cancelled').success).toBe(true);
    });

    it('accepts "expired"', () => {
      expect(bookingStatusSchema.safeParse('expired').success).toBe(true);
    });

    it('accepts "in_progress"', () => {
      expect(bookingStatusSchema.safeParse('in_progress').success).toBe(true);
    });
  });

  describe('invalid values', () => {
    it('rejects "invalid_status"', () => {
      expect(bookingStatusSchema.safeParse('invalid_status').success).toBe(false);
    });

    it('rejects empty string', () => {
      expect(bookingStatusSchema.safeParse('').success).toBe(false);
    });

    it('rejects number (123)', () => {
      expect(bookingStatusSchema.safeParse(123).success).toBe(false);
    });

    it('rejects null', () => {
      expect(bookingStatusSchema.safeParse(null).success).toBe(false);
    });

    it('rejects undefined', () => {
      expect(bookingStatusSchema.safeParse(undefined).success).toBe(false);
    });

    it('rejects "ACTIVE" (wrong case)', () => {
      expect(bookingStatusSchema.safeParse('ACTIVE').success).toBe(false);
    });

    it('rejects "pending" (not a booking status)', () => {
      expect(bookingStatusSchema.safeParse('pending').success).toBe(false);
    });

    it('rejects boolean true', () => {
      expect(bookingStatusSchema.safeParse(true).success).toBe(false);
    });

    it('rejects object', () => {
      expect(bookingStatusSchema.safeParse({ status: 'active' }).success).toBe(false);
    });

    it('rejects array', () => {
      expect(bookingStatusSchema.safeParse(['active']).success).toBe(false);
    });
  });

  describe('all enum values are accounted for', () => {
    it('enum has exactly 9 values', () => {
      const allValues = bookingStatusSchema.options;
      expect(allValues).toHaveLength(9);
      expect(allValues).toEqual(
        expect.arrayContaining([
          'created',
          'broadcasting',
          'active',
          'partially_filled',
          'fully_filled',
          'in_progress',
          'completed',
          'cancelled',
          'expired',
        ])
      );
    });
  });
});

// =============================================================================
// CATEGORY 5: pickup != drop check (#31)
// =============================================================================

describe('Category 5: pickup != drop minimum distance (#31)', () => {
  // Delhi reference: 28.6, 77.2
  const delhiLat = 28.6;
  const delhiLng = 77.2;

  /**
   * Returns a latitude offset in degrees that corresponds to `meters` distance
   * from the base point at delhiLat, delhiLng.  This is approximate but
   * accurate enough for the 100 m -- 1 km range the tests need.
   */
  function latOffsetForMeters(meters: number): number {
    // 1 degree latitude ~ 111,320 m
    return meters / 111320;
  }

  describe('createBookingSchema refine', () => {
    it('rejects same exact coordinates (0 m apart)', () => {
      const result = createBookingSchema.safeParse(
        makeBookingPayload({
          pickup: { coordinates: { latitude: delhiLat, longitude: delhiLng }, address: 'A' },
          drop: { coordinates: { latitude: delhiLat, longitude: delhiLng }, address: 'B' },
        })
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        const msgs = result.error.issues.map((i) => i.message);
        expect(msgs).toContain('Pickup and drop locations must be at least 500 meters apart');
      }
    });

    it('rejects ~100 m apart', () => {
      const offset = latOffsetForMeters(100);
      const result = createBookingSchema.safeParse(
        makeBookingPayload({
          pickup: { coordinates: { latitude: delhiLat, longitude: delhiLng }, address: 'A' },
          drop: { coordinates: { latitude: delhiLat + offset, longitude: delhiLng }, address: 'B' },
        })
      );
      expect(result.success).toBe(false);
    });

    it('rejects ~200 m apart (lat shift only)', () => {
      const offset = latOffsetForMeters(200);
      const result = createBookingSchema.safeParse(
        makeBookingPayload({
          pickup: { coordinates: { latitude: delhiLat, longitude: delhiLng }, address: 'A' },
          drop: { coordinates: { latitude: delhiLat + offset, longitude: delhiLng }, address: 'B' },
        })
      );
      expect(result.success).toBe(false);
    });

    it('rejects ~200 m apart (lng shift only)', () => {
      // 1 degree longitude at 28.6N ~ 97,700 m
      const lngOffset = 200 / (111320 * Math.cos((delhiLat * Math.PI) / 180));
      const result = createBookingSchema.safeParse(
        makeBookingPayload({
          pickup: { coordinates: { latitude: delhiLat, longitude: delhiLng }, address: 'A' },
          drop: { coordinates: { latitude: delhiLat, longitude: delhiLng + lngOffset }, address: 'B' },
        })
      );
      expect(result.success).toBe(false);
    });

    it('rejects ~499 m apart', () => {
      const offset = latOffsetForMeters(499);
      const result = createBookingSchema.safeParse(
        makeBookingPayload({
          pickup: { coordinates: { latitude: delhiLat, longitude: delhiLng }, address: 'A' },
          drop: { coordinates: { latitude: delhiLat + offset, longitude: delhiLng }, address: 'B' },
        })
      );
      expect(result.success).toBe(false);
    });

    it('accepts ~500 m apart (boundary -- 510 m to clear rounding)', () => {
      const offset = latOffsetForMeters(510);
      const dist = haversineKm(delhiLat, delhiLng, delhiLat + offset, delhiLng);
      // Sanity: verify our offset is >= 0.5 km
      expect(dist).toBeGreaterThanOrEqual(0.5);
      const result = createBookingSchema.safeParse(
        makeBookingPayload({
          pickup: { coordinates: { latitude: delhiLat, longitude: delhiLng }, address: 'A' },
          drop: { coordinates: { latitude: delhiLat + offset, longitude: delhiLng }, address: 'B' },
        })
      );
      expect(result.success).toBe(true);
    });

    it('accepts ~600 m apart', () => {
      const offset = latOffsetForMeters(600);
      const result = createBookingSchema.safeParse(
        makeBookingPayload({
          pickup: { coordinates: { latitude: delhiLat, longitude: delhiLng }, address: 'A' },
          drop: { coordinates: { latitude: delhiLat + offset, longitude: delhiLng }, address: 'B' },
        })
      );
      expect(result.success).toBe(true);
    });

    it('accepts ~1 km apart', () => {
      const offset = latOffsetForMeters(1000);
      const result = createBookingSchema.safeParse(
        makeBookingPayload({
          pickup: { coordinates: { latitude: delhiLat, longitude: delhiLng }, address: 'A' },
          drop: { coordinates: { latitude: delhiLat + offset, longitude: delhiLng }, address: 'B' },
        })
      );
      expect(result.success).toBe(true);
    });

    it('accepts ~50 km apart', () => {
      const offset = latOffsetForMeters(50000);
      const result = createBookingSchema.safeParse(
        makeBookingPayload({
          pickup: { coordinates: { latitude: delhiLat, longitude: delhiLng }, address: 'A' },
          drop: { coordinates: { latitude: delhiLat + offset, longitude: delhiLng }, address: 'B' },
        })
      );
      expect(result.success).toBe(true);
    });

    it('accepts Delhi to Mumbai (~1400 km)', () => {
      const result = createBookingSchema.safeParse(
        makeBookingPayload({
          pickup: { coordinates: { latitude: 28.6, longitude: 77.2 }, address: 'Delhi' },
          drop: { coordinates: { latitude: 19.076, longitude: 72.877 }, address: 'Mumbai' },
        })
      );
      expect(result.success).toBe(true);
    });

    it('accepts Delhi to Bangalore (~2150 km)', () => {
      const result = createBookingSchema.safeParse(
        makeBookingPayload({
          pickup: { coordinates: { latitude: 28.6, longitude: 77.2 }, address: 'Delhi' },
          drop: { coordinates: { latitude: 12.97, longitude: 77.59 }, address: 'Bangalore' },
        })
      );
      expect(result.success).toBe(true);
    });

    it('accepts coordinates at Indian boundary edges (Kanyakumari to Srinagar)', () => {
      const result = createBookingSchema.safeParse(
        makeBookingPayload({
          pickup: { coordinates: { latitude: 8.08, longitude: 77.5 }, address: 'Kanyakumari' },
          drop: { coordinates: { latitude: 34.0, longitude: 74.8 }, address: 'Srinagar' },
        })
      );
      expect(result.success).toBe(true);
    });

    it('rejects when drop coordinates are outside India (bounding box fail)', () => {
      const result = createBookingSchema.safeParse(
        makeBookingPayload({
          pickup: { coordinates: { latitude: 28.6, longitude: 77.2 }, address: 'Delhi' },
          drop: { coordinates: { latitude: 51.5, longitude: -0.1 }, address: 'London' },
        })
      );
      expect(result.success).toBe(false);
    });

    it('rejects when pickup coordinates are outside India (bounding box fail)', () => {
      const result = createBookingSchema.safeParse(
        makeBookingPayload({
          pickup: { coordinates: { latitude: 40.7, longitude: -74.0 }, address: 'New York' },
          drop: { coordinates: { latitude: 19.076, longitude: 72.877 }, address: 'Mumbai' },
        })
      );
      expect(result.success).toBe(false);
    });
  });

  // ---- createOrderSchema has the same refine ----
  describe('createOrderSchema refine', () => {
    it('rejects same exact coordinates in order schema', () => {
      const result = createOrderSchema.safeParse(
        makeOrderPayload({
          pickup: { coordinates: { latitude: delhiLat, longitude: delhiLng }, address: 'A' },
          drop: { coordinates: { latitude: delhiLat, longitude: delhiLng }, address: 'B' },
        })
      );
      expect(result.success).toBe(false);
    });

    it('rejects ~300 m apart in order schema', () => {
      const offset = latOffsetForMeters(300);
      const result = createOrderSchema.safeParse(
        makeOrderPayload({
          pickup: { coordinates: { latitude: delhiLat, longitude: delhiLng }, address: 'A' },
          drop: { coordinates: { latitude: delhiLat + offset, longitude: delhiLng }, address: 'B' },
        })
      );
      expect(result.success).toBe(false);
    });

    it('accepts ~600 m apart in order schema', () => {
      const offset = latOffsetForMeters(600);
      const result = createOrderSchema.safeParse(
        makeOrderPayload({
          pickup: { coordinates: { latitude: delhiLat, longitude: delhiLng }, address: 'A' },
          drop: { coordinates: { latitude: delhiLat + offset, longitude: delhiLng }, address: 'B' },
        })
      );
      expect(result.success).toBe(true);
    });

    it('accepts Delhi to Mumbai in order schema', () => {
      const result = createOrderSchema.safeParse(makeOrderPayload());
      expect(result.success).toBe(true);
    });
  });

  // ---- Flat coordinate format ----
  describe('flat coordinate format (latitude/longitude at top level)', () => {
    it('rejects same location with flat coordinates', () => {
      const result = createBookingSchema.safeParse(
        makeBookingPayload({
          pickup: { latitude: delhiLat, longitude: delhiLng, address: 'A' },
          drop: { latitude: delhiLat, longitude: delhiLng, address: 'B' },
        })
      );
      expect(result.success).toBe(false);
    });

    it('accepts far-apart locations with flat coordinates', () => {
      const result = createBookingSchema.safeParse(
        makeBookingPayload({
          pickup: { latitude: 28.6, longitude: 77.2, address: 'Delhi' },
          drop: { latitude: 19.076, longitude: 72.877, address: 'Mumbai' },
        })
      );
      expect(result.success).toBe(true);
    });
  });

  // ---- Haversine accuracy spot-check ----
  describe('haversine distance cross-check', () => {
    it('499 m offset is actually < 0.5 km', () => {
      const offset = latOffsetForMeters(499);
      const dist = haversineKm(delhiLat, delhiLng, delhiLat + offset, delhiLng);
      expect(dist).toBeLessThan(0.5);
    });

    it('510 m offset is actually >= 0.5 km', () => {
      const offset = latOffsetForMeters(510);
      const dist = haversineKm(delhiLat, delhiLng, delhiLat + offset, delhiLng);
      expect(dist).toBeGreaterThanOrEqual(0.5);
    });
  });
});
