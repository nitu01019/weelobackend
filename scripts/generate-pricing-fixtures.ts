/**
 * =============================================================================
 * F-A-30 — Generate golden-master fixtures for PricingService.calculateEstimate
 * =============================================================================
 *
 * Runs the LEGACY (v1) pricingService.calculateEstimate against 50 canned
 * PriceEstimateRequest inputs and writes the v1 outputs to
 * `src/__tests__/__fixtures__/pricing-golden-master-fixtures.json`.
 *
 * The v2 (refactored) implementation must reproduce these outputs
 * byte-for-byte when FF_PRICING_V2=true.
 *
 * Determinism: every fixture pins `timestampMs` so the surge bucket is fixed.
 * Cell IDs vary across fixtures so the surgeRuleId/quoteToken differ in
 * production-like ways.
 *
 * Run:
 *   npx ts-node scripts/generate-pricing-fixtures.ts
 *   (or)  npx jest scripts/generate-pricing-fixtures.spec.ts (alt entry)
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';
import { pricingService } from '../src/modules/pricing/pricing.service';

interface FixtureInput {
  name: string;
  vehicleType: string;
  vehicleSubtype?: string;
  distanceKm: number;
  trucksNeeded: number;
  cargoWeightKg?: number;
  cellId?: string;
  timestampMs: number;
}

// --------------------------------------------------------------------------
// 50 canned fixtures covering happy path, surge windows, min-charge, subtype
// variants, tonnage edge cases, and catalog-miss fallback.
// --------------------------------------------------------------------------
//
// Surge buckets (5-min, IST):
//   ts=2026-04-15T08:30:00Z -> IST 14:00 (Wed)        => normal (1.0x)
//   ts=2026-04-15T03:00:00Z -> IST 08:30 (Wed peak)   => peak    (1.2x)
//   ts=2026-04-14T20:30:00Z -> IST 02:00 (Wed night)  => night   (1.1x)
//   ts=2026-04-18T08:30:00Z -> IST 14:00 (Sat weekend)=> weekend (1.05x)
//   ts=2026-04-19T01:30:00Z -> IST 07:00 (Sun weekend)=> weekend (1.05x)
//
const TS_NORMAL = Date.UTC(2026, 3, 15, 8, 30, 0);
const TS_PEAK = Date.UTC(2026, 3, 15, 3, 0, 0);
const TS_NIGHT = Date.UTC(2026, 3, 14, 20, 30, 0);
const TS_WEEKEND = Date.UTC(2026, 3, 18, 8, 30, 0);
const TS_SUNDAY = Date.UTC(2026, 3, 19, 1, 30, 0);

const FIXTURES: FixtureInput[] = [
  // 1-10: open category, varying distances and subtypes (medium haul)
  { name: 'open-17ft-50km-normal', vehicleType: 'open', vehicleSubtype: '17 Feet', distanceKm: 50, trucksNeeded: 1, cargoWeightKg: 5000, cellId: 'cell-1', timestampMs: TS_NORMAL },
  { name: 'open-17ft-100km-normal-2trucks', vehicleType: 'open', vehicleSubtype: '17 Feet', distanceKm: 100, trucksNeeded: 2, cargoWeightKg: 8000, cellId: 'cell-1', timestampMs: TS_NORMAL },
  { name: 'open-19ft-200km-normal', vehicleType: 'open', vehicleSubtype: '19 Feet', distanceKm: 200, trucksNeeded: 1, cargoWeightKg: 10000, cellId: 'cell-2', timestampMs: TS_NORMAL },
  { name: 'open-22ft-400km-normal', vehicleType: 'open', vehicleSubtype: '22 Feet', distanceKm: 400, trucksNeeded: 1, cargoWeightKg: 12000, cellId: 'cell-2', timestampMs: TS_NORMAL },
  { name: 'open-24ft-700km-normal-very-long', vehicleType: 'open', vehicleSubtype: '24 Feet', distanceKm: 700, trucksNeeded: 1, cargoWeightKg: 14000, cellId: 'cell-3', timestampMs: TS_NORMAL },
  { name: 'open-10wh-150km-peak', vehicleType: 'open', vehicleSubtype: '10 Wheeler', distanceKm: 150, trucksNeeded: 1, cargoWeightKg: 16000, cellId: 'cell-3', timestampMs: TS_PEAK },
  { name: 'open-12wh-250km-night', vehicleType: 'open', vehicleSubtype: '12 Wheeler', distanceKm: 250, trucksNeeded: 1, cargoWeightKg: 20000, cellId: 'cell-4', timestampMs: TS_NIGHT },
  { name: 'open-14wh-450km-weekend', vehicleType: 'open', vehicleSubtype: '14 Wheeler', distanceKm: 450, trucksNeeded: 1, cargoWeightKg: 22000, cellId: 'cell-4', timestampMs: TS_WEEKEND },
  { name: 'open-16wh-90km-sunday', vehicleType: 'open', vehicleSubtype: '16 Wheeler', distanceKm: 90, trucksNeeded: 3, cargoWeightKg: 25000, cellId: 'cell-5', timestampMs: TS_SUNDAY },
  { name: 'open-18wh-1200km-very-long-normal', vehicleType: 'open', vehicleSubtype: '18 Wheeler', distanceKm: 1200, trucksNeeded: 1, cargoWeightKg: 30000, cellId: 'cell-5', timestampMs: TS_NORMAL },

  // 11-20: container category
  { name: 'container-19ft-30km-local-normal', vehicleType: 'container', vehicleSubtype: '19 Feet', distanceKm: 30, trucksNeeded: 1, cargoWeightKg: 9000, cellId: 'cell-6', timestampMs: TS_NORMAL },
  { name: 'container-20ft-80km-short-haul', vehicleType: 'container', vehicleSubtype: '20 Feet', distanceKm: 80, trucksNeeded: 2, cargoWeightKg: 11000, cellId: 'cell-6', timestampMs: TS_NORMAL },
  { name: 'container-22ft-180km-medium-haul-peak', vehicleType: 'container', vehicleSubtype: '22 Feet', distanceKm: 180, trucksNeeded: 1, cargoWeightKg: 13000, cellId: 'cell-7', timestampMs: TS_PEAK },
  { name: 'container-24ft-350km-long-haul-night', vehicleType: 'container', vehicleSubtype: '24 Feet', distanceKm: 350, trucksNeeded: 1, cargoWeightKg: 14000, cellId: 'cell-7', timestampMs: TS_NIGHT },
  { name: 'container-32sxl-600km-weekend', vehicleType: 'container', vehicleSubtype: '32 Feet Single Axle', distanceKm: 600, trucksNeeded: 1, cargoWeightKg: 21000, cellId: 'cell-8', timestampMs: TS_WEEKEND },
  { name: 'container-32mxl-900km-sunday', vehicleType: 'container', vehicleSubtype: '32 Feet Multi Axle', distanceKm: 900, trucksNeeded: 1, cargoWeightKg: 24000, cellId: 'cell-8', timestampMs: TS_SUNDAY },
  { name: 'container-32txl-2500km-very-long', vehicleType: 'container', vehicleSubtype: '32 Feet Triple Axle', distanceKm: 2500, trucksNeeded: 1, cargoWeightKg: 30000, cellId: 'cell-9', timestampMs: TS_NORMAL },
  { name: 'container-19ft-no-cargo-default-tonnage', vehicleType: 'container', vehicleSubtype: '19 Feet', distanceKm: 100, trucksNeeded: 1, cellId: 'cell-9', timestampMs: TS_NORMAL },
  { name: 'container-22ft-tiny-cargo-min-charge', vehicleType: 'container', vehicleSubtype: '22 Feet', distanceKm: 5, trucksNeeded: 1, cargoWeightKg: 100, cellId: 'cell-10', timestampMs: TS_NORMAL },
  { name: 'container-24ft-zero-distance-min-charge', vehicleType: 'container', vehicleSubtype: '24 Feet', distanceKm: 0, trucksNeeded: 1, cargoWeightKg: 1000, cellId: 'cell-10', timestampMs: TS_NORMAL },

  // 21-30: tipper, tanker, dumper, bulker (specialty categories)
  { name: 'tipper-8-11ton-60km-normal', vehicleType: 'tipper', vehicleSubtype: '8-11 Ton', distanceKm: 60, trucksNeeded: 1, cargoWeightKg: 9000, cellId: 'cell-11', timestampMs: TS_NORMAL },
  { name: 'tipper-12-15ton-120km-peak', vehicleType: 'tipper', vehicleSubtype: '12-15 Ton', distanceKm: 120, trucksNeeded: 2, cargoWeightKg: 13000, cellId: 'cell-11', timestampMs: TS_PEAK },
  { name: 'tipper-16-19ton-220km-night', vehicleType: 'tipper', vehicleSubtype: '16-19 Ton', distanceKm: 220, trucksNeeded: 1, cargoWeightKg: 17000, cellId: 'cell-12', timestampMs: TS_NIGHT },
  { name: 'tipper-20-22ton-410km-weekend', vehicleType: 'tipper', vehicleSubtype: '20-22 Ton', distanceKm: 410, trucksNeeded: 1, cargoWeightKg: 21000, cellId: 'cell-12', timestampMs: TS_WEEKEND },
  { name: 'lcv-pickup-dost-25km-local-normal', vehicleType: 'lcv', vehicleSubtype: 'LCV Open - 14 Feet', distanceKm: 25, trucksNeeded: 1, cargoWeightKg: 1200, cellId: 'cell-13', timestampMs: TS_NORMAL },
  { name: 'lcv-open-17ft-70km-short', vehicleType: 'lcv', vehicleSubtype: 'LCV Open - 17 Feet', distanceKm: 70, trucksNeeded: 1, cargoWeightKg: 2500, cellId: 'cell-13', timestampMs: TS_NORMAL },
  { name: 'lcv-container-32sxl-150km-peak', vehicleType: 'lcv', vehicleSubtype: 'LCV Container - 32 Feet SXL', distanceKm: 150, trucksNeeded: 1, cargoWeightKg: 4500, cellId: 'cell-14', timestampMs: TS_PEAK },
  { name: 'mini-pickup-dost-15km-local', vehicleType: 'mini', vehicleSubtype: 'Pickup Truck - Dost', distanceKm: 15, trucksNeeded: 1, cargoWeightKg: 800, cellId: 'cell-14', timestampMs: TS_NORMAL },
  { name: 'mini-tata-ace-40km-local-night', vehicleType: 'mini', vehicleSubtype: 'Mini Truck - Tata Ace', distanceKm: 40, trucksNeeded: 1, cargoWeightKg: 700, cellId: 'cell-15', timestampMs: TS_NIGHT },
  { name: 'trailer-19ft-300km-medium-normal', vehicleType: 'trailer', vehicleSubtype: '19 Feet', distanceKm: 300, trucksNeeded: 1, cargoWeightKg: 18000, cellId: 'cell-15', timestampMs: TS_NORMAL },

  // 31-40: more variants + edge cases
  { name: 'trailer-20ft-500km-long', vehicleType: 'trailer', vehicleSubtype: '20 Feet', distanceKm: 500, trucksNeeded: 1, cargoWeightKg: 22000, cellId: 'cell-16', timestampMs: TS_NORMAL },
  { name: 'trailer-22ft-800km-very-long-night', vehicleType: 'trailer', vehicleSubtype: '22 Feet', distanceKm: 800, trucksNeeded: 1, cargoWeightKg: 24000, cellId: 'cell-16', timestampMs: TS_NIGHT },
  { name: 'trailer-24ft-1500km-very-long-weekend', vehicleType: 'trailer', vehicleSubtype: '24 Feet', distanceKm: 1500, trucksNeeded: 1, cargoWeightKg: 28000, cellId: 'cell-17', timestampMs: TS_WEEKEND },
  { name: 'open-17ft-no-subtype-normal', vehicleType: 'open', distanceKm: 100, trucksNeeded: 1, cargoWeightKg: 5000, cellId: 'cell-17', timestampMs: TS_NORMAL },
  { name: 'container-no-subtype-normal', vehicleType: 'container', distanceKm: 200, trucksNeeded: 1, cargoWeightKg: 10000, cellId: 'cell-18', timestampMs: TS_NORMAL },
  { name: 'unknown-vehicle-fallback-default-normal', vehicleType: 'unknown_xyz', vehicleSubtype: 'whatever', distanceKm: 100, trucksNeeded: 1, cargoWeightKg: 5000, cellId: 'cell-18', timestampMs: TS_NORMAL },
  { name: 'unknown-vehicle-fallback-min-charge-tiny-distance', vehicleType: 'unknown_xyz', distanceKm: 1, trucksNeeded: 1, cellId: 'cell-19', timestampMs: TS_NORMAL },
  { name: 'unknown-vehicle-fallback-peak', vehicleType: 'unknown_xyz', vehicleSubtype: 'foo', distanceKm: 200, trucksNeeded: 2, cellId: 'cell-19', timestampMs: TS_PEAK },
  { name: 'unknown-vehicle-fallback-night', vehicleType: 'unknown_xyz', distanceKm: 50, trucksNeeded: 1, cellId: 'cell-20', timestampMs: TS_NIGHT },
  { name: 'unknown-vehicle-fallback-weekend-very-long', vehicleType: 'unknown_xyz', distanceKm: 1000, trucksNeeded: 1, cellId: 'cell-20', timestampMs: TS_WEEKEND },

  // 41-50: cargo weight edge cases + multi-truck combos
  { name: 'open-17ft-very-heavy-cargo-30000kg', vehicleType: 'open', vehicleSubtype: '17 Feet', distanceKm: 100, trucksNeeded: 1, cargoWeightKg: 30000, cellId: 'cell-21', timestampMs: TS_NORMAL },
  { name: 'open-17ft-very-light-cargo-100kg', vehicleType: 'open', vehicleSubtype: '17 Feet', distanceKm: 100, trucksNeeded: 1, cargoWeightKg: 100, cellId: 'cell-21', timestampMs: TS_NORMAL },
  { name: 'tipper-20-22ton-5trucks-medium', vehicleType: 'tipper', vehicleSubtype: '20-22 Ton', distanceKm: 250, trucksNeeded: 5, cargoWeightKg: 20000, cellId: 'cell-22', timestampMs: TS_NORMAL },
  { name: 'container-32mxl-10trucks-long', vehicleType: 'container', vehicleSubtype: '32 Feet Multi Axle', distanceKm: 600, trucksNeeded: 10, cargoWeightKg: 24000, cellId: 'cell-22', timestampMs: TS_NORMAL },
  { name: 'open-10wh-distance-exactly-50-boundary', vehicleType: 'open', vehicleSubtype: '10 Wheeler', distanceKm: 50, trucksNeeded: 1, cargoWeightKg: 10000, cellId: 'cell-23', timestampMs: TS_NORMAL },
  { name: 'open-10wh-distance-exactly-100-boundary', vehicleType: 'open', vehicleSubtype: '10 Wheeler', distanceKm: 100, trucksNeeded: 1, cargoWeightKg: 10000, cellId: 'cell-23', timestampMs: TS_NORMAL },
  { name: 'open-10wh-distance-exactly-300-boundary', vehicleType: 'open', vehicleSubtype: '10 Wheeler', distanceKm: 300, trucksNeeded: 1, cargoWeightKg: 10000, cellId: 'cell-24', timestampMs: TS_NORMAL },
  { name: 'open-10wh-distance-exactly-500-boundary', vehicleType: 'open', vehicleSubtype: '10 Wheeler', distanceKm: 500, trucksNeeded: 1, cargoWeightKg: 10000, cellId: 'cell-24', timestampMs: TS_NORMAL },
  { name: 'open-10wh-no-cargo-uses-max-tonnage', vehicleType: 'open', vehicleSubtype: '10 Wheeler', distanceKm: 200, trucksNeeded: 1, cellId: 'cell-25', timestampMs: TS_NORMAL },
  { name: 'open-10wh-no-cargo-no-cell', vehicleType: 'open', vehicleSubtype: '10 Wheeler', distanceKm: 200, trucksNeeded: 1, timestampMs: TS_NORMAL },
];

if (FIXTURES.length !== 50) {
  console.error(`Expected 50 fixtures, got ${FIXTURES.length}`);
  process.exit(1);
}

const outputs = FIXTURES.map((input) => ({
  input,
  output: pricingService.calculateEstimate({ ...input }),
}));

const fixturesPath = path.resolve(__dirname, '..', 'src', '__tests__', '__fixtures__', 'pricing-golden-master-fixtures.json');
fs.writeFileSync(fixturesPath, JSON.stringify(outputs, null, 2) + '\n', 'utf8');

console.log(`Wrote ${outputs.length} fixtures to ${fixturesPath}`);
