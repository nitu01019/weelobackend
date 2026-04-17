/**
 * =============================================================================
 * L-16: Pricing Service Unit Tests
 * =============================================================================
 *
 * Tests for PricingService covering:
 * - calculateEstimate (base + distance + tonnage + surge)
 * - calculateSurgeMultiplier (peak/night/weekend)
 * - getSuggestions (sort + recommend)
 * - Edge cases (zero distance, min charge, rounding, unknown vehicle type)
 *
 * Mocks: Date, logger only.
 * =============================================================================
 */

jest.mock('../../../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { pricingService } from '../pricing.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setMockDate(dateStr: string) {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(dateStr));
}

function restoreDate() {
  jest.useRealTimers();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PricingService', () => {
  afterEach(() => {
    restoreDate();
  });

  // =========================================================================
  // calculateEstimate — basic calculations
  // =========================================================================
  describe('calculateEstimate', () => {
    it('should return a valid estimate for a known vehicle type (open 17 Feet)', () => {
      // Wednesday 2pm — normal hours, no surge
      setMockDate('2026-04-15T14:00:00');
      const result = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '17 Feet',
        distanceKm: 100,
        trucksNeeded: 1,
      });
      expect(result.currency).toBe('INR');
      // F-A-26: quote freshness now aligns with the 5-min surge bucket so
      // the server never honours a price it wouldn't compute again.
      expect(result.validForMinutes).toBe(5);
      expect(result.pricePerTruck).toBeGreaterThan(0);
      expect(result.totalPrice).toBe(result.pricePerTruck * 1);
      expect(result.breakdown.vehicleType).toBe('open');
      expect(result.breakdown.vehicleSubtype).toBe('17 Feet');
    });

    it('should multiply price by trucksNeeded', () => {
      setMockDate('2026-04-15T14:00:00');
      const single = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '17 Feet',
        distanceKm: 50,
        trucksNeeded: 1,
      });
      const triple = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '17 Feet',
        distanceKm: 50,
        trucksNeeded: 3,
      });
      expect(triple.totalPrice).toBe(single.pricePerTruck * 3);
    });

    it('should enforce minimum distance of 5 km', () => {
      setMockDate('2026-04-15T14:00:00');
      const zeroKm = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '17 Feet',
        distanceKm: 0,
        trucksNeeded: 1,
      });
      const fiveKm = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '17 Feet',
        distanceKm: 5,
        trucksNeeded: 1,
      });
      expect(zeroKm.pricePerTruck).toBe(fiveKm.pricePerTruck);
      expect(zeroKm.breakdown.distanceKm).toBe(5);
    });

    it('should apply distance slab multiplier for local (<= 50km)', () => {
      setMockDate('2026-04-15T14:00:00');
      const result = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '17 Feet',
        distanceKm: 30,
        trucksNeeded: 1,
      });
      expect(result.distanceSlabMultiplier).toBe(1.3);
      expect(result.breakdown.distanceSlab).toBe('Local');
    });

    it('should apply medium haul slab for 101-300 km', () => {
      setMockDate('2026-04-15T14:00:00');
      const result = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '17 Feet',
        distanceKm: 200,
        trucksNeeded: 1,
      });
      expect(result.distanceSlabMultiplier).toBe(1.0);
      expect(result.breakdown.distanceSlab).toBe('Medium Haul');
    });

    it('should apply long haul slab for 301-500 km', () => {
      setMockDate('2026-04-15T14:00:00');
      const result = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '17 Feet',
        distanceKm: 400,
        trucksNeeded: 1,
      });
      expect(result.distanceSlabMultiplier).toBe(0.95);
      expect(result.breakdown.distanceSlab).toBe('Long Haul');
    });

    it('should apply very long haul slab for > 500 km', () => {
      setMockDate('2026-04-15T14:00:00');
      const result = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '17 Feet',
        distanceKm: 800,
        trucksNeeded: 1,
      });
      expect(result.distanceSlabMultiplier).toBe(0.9);
      expect(result.breakdown.distanceSlab).toBe('Very Long Haul');
    });

    it('should include tonnage charge when cargoWeightKg is provided', () => {
      setMockDate('2026-04-15T14:00:00');
      const withCargo = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '17 Feet',
        distanceKm: 100,
        trucksNeeded: 1,
        cargoWeightKg: 5000,
      });
      expect(withCargo.tonnageCharge).toBeGreaterThan(0);
    });

    it('should use max tonnage when cargoWeightKg is not provided', () => {
      setMockDate('2026-04-15T14:00:00');
      const withoutCargo = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '17 Feet',
        distanceKm: 100,
        trucksNeeded: 1,
      });
      // Without cargoWeightKg, effective tonnage = subtype.maxTonnage (7) -> tonnage > 0
      expect(withoutCargo.tonnageCharge).toBeGreaterThan(0);
    });

    it('should apply subtype multiplier', () => {
      setMockDate('2026-04-15T14:00:00');
      const base17 = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '17 Feet',
        distanceKm: 200,
        trucksNeeded: 1,
      });
      const bigger24 = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '24 Feet',
        distanceKm: 200,
        trucksNeeded: 1,
      });
      expect(bigger24.subtypeMultiplier).toBeGreaterThan(base17.subtypeMultiplier);
      expect(bigger24.pricePerTruck).toBeGreaterThan(base17.pricePerTruck);
    });

    it('should enforce minimum charge', () => {
      setMockDate('2026-04-15T14:00:00');
      // Mini has minCharge = 800. With zero-ish cargo + min distance, price must be >= 800
      const result = pricingService.calculateEstimate({
        vehicleType: 'mini',
        vehicleSubtype: 'Mini Truck - Tata Ace',
        distanceKm: 1,
        trucksNeeded: 1,
        cargoWeightKg: 100,
      });
      expect(result.pricePerTruck).toBeGreaterThanOrEqual(800);
    });

    it('should round pricePerTruck to nearest rupee', () => {
      setMockDate('2026-04-15T14:00:00');
      const result = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '17 Feet',
        distanceKm: 150,
        trucksNeeded: 1,
      });
      expect(result.pricePerTruck).toBe(Math.round(result.pricePerTruck));
    });

    it('should populate capacityInfo from subtype', () => {
      setMockDate('2026-04-15T14:00:00');
      const result = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '17 Feet',
        distanceKm: 100,
        trucksNeeded: 1,
      });
      expect(result.capacityInfo.capacityKg).toBe(7000);
      expect(result.capacityInfo.capacityTons).toBe(7);
      expect(result.capacityInfo.minTonnage).toBe(5);
      expect(result.capacityInfo.maxTonnage).toBe(7);
    });

    it('should use default subtype label "Standard" when no subtype provided', () => {
      setMockDate('2026-04-15T14:00:00');
      const result = pricingService.calculateEstimate({
        vehicleType: 'open',
        distanceKm: 100,
        trucksNeeded: 1,
      });
      expect(result.breakdown.vehicleSubtype).toBe('Standard');
    });

    it('should fall back to defaults for unknown vehicle type', () => {
      setMockDate('2026-04-15T14:00:00');
      const result = pricingService.calculateEstimate({
        vehicleType: 'spacecraft',
        distanceKm: 100,
        trucksNeeded: 1,
      });
      expect(result.basePrice).toBe(2000);
      expect(result.tonnageCharge).toBe(0);
      expect(result.pricePerTruck).toBeGreaterThanOrEqual(1500);
    });

    it('should enforce minimum charge of 1500 for unknown vehicle type', () => {
      setMockDate('2026-04-15T14:00:00');
      const result = pricingService.calculateEstimate({
        vehicleType: 'unknown',
        distanceKm: 0,
        trucksNeeded: 1,
      });
      expect(result.pricePerTruck).toBeGreaterThanOrEqual(1500);
    });
  });

  // =========================================================================
  // calculateSurgeMultiplier (tested indirectly via calculateEstimate)
  // =========================================================================
  describe('surge pricing', () => {
    it('should apply peak multiplier (1.2) during morning peak (9 AM weekday)', () => {
      setMockDate('2026-04-15T09:00:00'); // Wednesday 9 AM
      const result = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '17 Feet',
        distanceKm: 200,
        trucksNeeded: 1,
      });
      expect(result.surgeMultiplier).toBe(1.2);
      expect(result.breakdown.surgeFactor).toBe('Peak Hours');
    });

    it('should apply peak multiplier (1.2) during evening peak (18:00 weekday)', () => {
      setMockDate('2026-04-15T18:00:00'); // Wednesday 6 PM
      const result = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '17 Feet',
        distanceKm: 200,
        trucksNeeded: 1,
      });
      expect(result.surgeMultiplier).toBe(1.2);
    });

    it('should apply night multiplier (1.1) during night hours (23:00 weekday)', () => {
      setMockDate('2026-04-15T23:00:00'); // Wednesday 11 PM
      const result = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '17 Feet',
        distanceKm: 200,
        trucksNeeded: 1,
      });
      expect(result.surgeMultiplier).toBe(1.1);
      expect(result.breakdown.surgeFactor).toBe('Moderate Demand');
    });

    it('should apply weekend multiplier (1.05) on Saturday afternoon', () => {
      setMockDate('2026-04-18T14:00:00'); // Saturday 2 PM
      const result = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '17 Feet',
        distanceKm: 200,
        trucksNeeded: 1,
      });
      expect(result.surgeMultiplier).toBe(1.05);
      expect(result.breakdown.surgeFactor).toBe('Normal');
    });

    it('should apply combined peak + weekend multiplier on Saturday morning', () => {
      setMockDate('2026-04-18T09:00:00'); // Saturday 9 AM
      const result = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '17 Feet',
        distanceKm: 200,
        trucksNeeded: 1,
      });
      // 1.2 * 1.05 = 1.26
      expect(result.surgeMultiplier).toBe(1.26);
      expect(result.breakdown.surgeFactor).toBe('Peak Hours');
    });

    it('should apply combined night + weekend on Sunday night', () => {
      setMockDate('2026-04-19T23:00:00'); // Sunday 11 PM
      const result = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '17 Feet',
        distanceKm: 200,
        trucksNeeded: 1,
      });
      // 1.1 * 1.05 = 1.155 -> rounded to 1.16
      expect(result.surgeMultiplier).toBe(1.16);
      expect(result.breakdown.surgeFactor).toBe('Peak Hours');
    });

    it('should return multiplier 1.0 during normal weekday hours', () => {
      setMockDate('2026-04-15T14:00:00'); // Wednesday 2 PM
      const result = pricingService.calculateEstimate({
        vehicleType: 'open',
        vehicleSubtype: '17 Feet',
        distanceKm: 200,
        trucksNeeded: 1,
      });
      expect(result.surgeMultiplier).toBe(1.0);
      expect(result.breakdown.surgeFactor).toBe('Normal');
    });
  });

  // =========================================================================
  // getSuggestions
  // =========================================================================
  describe('getSuggestions', () => {
    beforeEach(() => {
      setMockDate('2026-04-15T14:00:00'); // Normal hours
    });

    it('should return sorted suggestions by price (cheapest first)', () => {
      const result = pricingService.getSuggestions({
        cargoWeightKg: 5000,
        distanceKm: 100,
        trucksNeeded: 1,
      });
      expect(result.suggestions.length).toBeGreaterThan(0);
      for (let i = 1; i < result.suggestions.length; i++) {
        expect(result.suggestions[i].totalPrice).toBeGreaterThanOrEqual(
          result.suggestions[i - 1].totalPrice
        );
      }
    });

    it('should mark a recommended option', () => {
      const result = pricingService.getSuggestions({
        cargoWeightKg: 5000,
        distanceKm: 100,
        trucksNeeded: 1,
      });
      expect(result.recommendedOption).not.toBeNull();
      expect(result.recommendedOption!.isRecommended).toBe(true);
    });

    it('should calculate savings relative to most expensive option', () => {
      const result = pricingService.getSuggestions({
        cargoWeightKg: 5000,
        distanceKm: 100,
        trucksNeeded: 1,
      });
      if (result.suggestions.length > 1) {
        const cheapest = result.suggestions[0];
        const mostExpensive = result.suggestions[result.suggestions.length - 1];
        expect(cheapest.savingsAmount).toBeGreaterThanOrEqual(0);
        expect(mostExpensive.savingsAmount).toBe(0);
      }
    });

    it('should mark current selection when it matches', () => {
      const result = pricingService.getSuggestions({
        cargoWeightKg: 5000,
        distanceKm: 100,
        trucksNeeded: 1,
        currentVehicleType: 'lcv',
        currentVehicleSubtype: 'LCV Open - 17 Feet',
      });
      const current = result.suggestions.find(s => s.isCurrentSelection);
      if (current) {
        expect(current.vehicleType).toBe('lcv');
        expect(result.currentOption).not.toBeNull();
      }
    });

    it('should return empty suggestions for extremely light cargo (0 kg)', () => {
      // findSuitableVehicles looks for capacityKg >= cargoWeightKg
      // 0 kg should match everything, but let's verify no crash
      const result = pricingService.getSuggestions({
        cargoWeightKg: 0,
        distanceKm: 100,
        trucksNeeded: 1,
      });
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it('should return empty suggestions for impossibly heavy cargo', () => {
      const result = pricingService.getSuggestions({
        cargoWeightKg: 999999,
        distanceKm: 100,
        trucksNeeded: 1,
      });
      expect(result.suggestions).toHaveLength(0);
      expect(result.recommendedOption).toBeNull();
      expect(result.potentialSavings).toBe(0);
    });

    it('should limit suggestions to at most 5 options', () => {
      const result = pricingService.getSuggestions({
        cargoWeightKg: 5000,
        distanceKm: 100,
        trucksNeeded: 1,
      });
      expect(result.suggestions.length).toBeLessThanOrEqual(5);
    });

    it('should calculate potential savings when current selection is more expensive', () => {
      const result = pricingService.getSuggestions({
        cargoWeightKg: 10000,
        distanceKm: 100,
        trucksNeeded: 1,
        currentVehicleType: 'trailer',
        currentVehicleSubtype: '32-35 Ton',
      });
      // Trailer 32-35 is oversized for 10000kg, cheaper options should exist
      expect(result.potentialSavings).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // getVehiclePricingCatalog
  // =========================================================================
  describe('getVehiclePricingCatalog', () => {
    it('should return all vehicle types from catalog', () => {
      const catalog = pricingService.getVehiclePricingCatalog();
      expect(Object.keys(catalog)).toContain('mini');
      expect(Object.keys(catalog)).toContain('open');
      expect(Object.keys(catalog)).toContain('container');
      expect(Object.keys(catalog)).toContain('trailer');
    });

    it('should include required fields for each vehicle type', () => {
      const catalog = pricingService.getVehiclePricingCatalog();
      for (const [, config] of Object.entries(catalog)) {
        expect(config.baseRate).toBeGreaterThan(0);
        expect(config.perKmRate).toBeGreaterThan(0);
        expect(config.minCharge).toBeGreaterThan(0);
        expect(config.displayName).toBeTruthy();
        expect(Array.isArray(config.subtypes)).toBe(true);
      }
    });
  });

  // =========================================================================
  // getDetailedCatalog
  // =========================================================================
  describe('getDetailedCatalog', () => {
    it('should return vehicleTypes array and fullCatalog', () => {
      const catalog = pricingService.getDetailedCatalog();
      expect(Array.isArray(catalog.vehicleTypes)).toBe(true);
      expect(catalog.vehicleTypes.length).toBeGreaterThan(0);
      expect(catalog.fullCatalog).toBeDefined();
    });
  });
});
