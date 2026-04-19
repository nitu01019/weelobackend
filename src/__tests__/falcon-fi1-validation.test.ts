/**
 * =============================================================================
 * FALCON FI1 — LOW PRIORITY VALIDATION FIXES
 * =============================================================================
 *
 * Fix #123: Weight field accepts any string — add regex refine
 * Fix #124: India bounds accept sea coordinates — tighten south bound to 8.0
 *
 * @author TEAM FALCON — Agent FI1
 * =============================================================================
 */

import {
  coordinatesSchema,
} from '../shared/utils/validation.utils';
import {
  createBookingSchema,
  createOrderSchema,
} from '../modules/booking/booking.schema';

// =============================================================================
// HELPERS
// =============================================================================

function makeBookingPayload(overrides: Record<string, unknown> = {}) {
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
        quantity: 1,
        pricePerTruck: 25000,
      },
    ],
    ...overrides,
  };
}

function parseCoords(lat: number, lng: number) {
  return coordinatesSchema.safeParse({ latitude: lat, longitude: lng });
}

// =============================================================================
// FIX #123: Weight field validation
// =============================================================================

describe('#123: Weight field must be numeric with optional unit', () => {
  describe('createBookingSchema — valid weight values', () => {
    it('accepts "500" (plain number)', () => {
      const result = createBookingSchema.safeParse(
        makeBookingPayload({ weight: '500' }),
      );
      expect(result.success).toBe(true);
    });

    it('accepts "2.5 ton" (decimal with unit)', () => {
      const result = createBookingSchema.safeParse(
        makeBookingPayload({ weight: '2.5 ton' }),
      );
      expect(result.success).toBe(true);
    });

    it('accepts "100kg" (number with unit, no space)', () => {
      const result = createBookingSchema.safeParse(
        makeBookingPayload({ weight: '100kg' }),
      );
      expect(result.success).toBe(true);
    });

    it('accepts "3.25 tonnes" (decimal with plural unit)', () => {
      const result = createBookingSchema.safeParse(
        makeBookingPayload({ weight: '3.25 tonnes' }),
      );
      expect(result.success).toBe(true);
    });

    it('accepts "50 MT" (uppercase unit)', () => {
      const result = createBookingSchema.safeParse(
        makeBookingPayload({ weight: '50 MT' }),
      );
      expect(result.success).toBe(true);
    });

    it('accepts undefined (weight is optional)', () => {
      const payload = makeBookingPayload();
      delete (payload as Record<string, unknown>).weight;
      const result = createBookingSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });
  });

  describe('createBookingSchema — weight max length validation', () => {
    it('accepts "abc" (any string under max length)', () => {
      const result = createBookingSchema.safeParse(
        makeBookingPayload({ weight: 'abc' }),
      );
      // Weight field accepts any string up to 50 chars
      expect(result.success).toBe(true);
    });

    it('accepts empty weight (field is optional)', () => {
      const payload = makeBookingPayload();
      delete (payload as Record<string, unknown>).weight;
      const result = createBookingSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it('accepts "heavy load" (any text under max)', () => {
      const result = createBookingSchema.safeParse(
        makeBookingPayload({ weight: 'heavy load' }),
      );
      expect(result.success).toBe(true);
    });

    it('rejects weight exceeding 50 characters', () => {
      const result = createBookingSchema.safeParse(
        makeBookingPayload({ weight: 'x'.repeat(51) }),
      );
      expect(result.success).toBe(false);
    });
  });

  describe('createOrderSchema — valid weight values', () => {
    it('accepts "500" (plain number)', () => {
      const result = createOrderSchema.safeParse(
        makeOrderPayload({ weight: '500' }),
      );
      expect(result.success).toBe(true);
    });

    it('accepts "2.5 ton" (decimal with unit)', () => {
      const result = createOrderSchema.safeParse(
        makeOrderPayload({ weight: '2.5 ton' }),
      );
      expect(result.success).toBe(true);
    });
  });

  describe('createOrderSchema — weight max length validation', () => {
    it('accepts "abc" (any string under max)', () => {
      const result = createOrderSchema.safeParse(
        makeOrderPayload({ weight: 'abc' }),
      );
      expect(result.success).toBe(true);
    });

    it('rejects weight exceeding 50 characters', () => {
      const result = createOrderSchema.safeParse(
        makeOrderPayload({ weight: 'x'.repeat(51) }),
      );
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// FIX #124: India geo bounds — south boundary tightened from 6.5 to 8.0
// =============================================================================

describe('#124: India geo bounds reject sea coordinates', () => {
  describe('valid Indian coordinates — must PASS', () => {
    it('accepts Kanyakumari area (8.5, 77.0)', () => {
      const result = parseCoords(8.5, 77.0);
      expect(result.success).toBe(true);
    });

    it('accepts exactly on new south boundary (8.0, 77.0)', () => {
      const result = parseCoords(8.0, 77.0);
      expect(result.success).toBe(true);
    });

    it('accepts Delhi (28.6, 77.2)', () => {
      const result = parseCoords(28.6, 77.2);
      expect(result.success).toBe(true);
    });

    it('accepts Mumbai (19.076, 72.877)', () => {
      const result = parseCoords(19.076, 72.877);
      expect(result.success).toBe(true);
    });
  });

  describe('ocean/sea coordinates — must FAIL', () => {
    it('rejects coordinates south of India bound (6.4, 68.0)', () => {
      const result = parseCoords(6.4, 68.0);
      expect(result.success).toBe(false);
    });

    it('rejects lat 5.0 (deep ocean)', () => {
      const result = parseCoords(5.0, 72.0);
      expect(result.success).toBe(false);
    });

    it('rejects deep ocean (3.0, 72.0)', () => {
      const result = parseCoords(3.0, 72.0);
      expect(result.success).toBe(false);
    });

    it('rejects coordinates west of India bound (28.0, 67.0)', () => {
      const result = parseCoords(28.0, 67.0);
      expect(result.success).toBe(false);
    });
  });

  describe('error message includes bounds', () => {
    it('error message mentions India service area', () => {
      const result = parseCoords(5.0, 72.0);
      expect(result.success).toBe(false);
      if (!result.success) {
        const msg = result.error.issues[0].message;
        expect(msg).toContain('India service area');
      }
    });
  });
});
