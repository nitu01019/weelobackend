/**
 * =============================================================================
 * PRICING MODULE - SERVICE
 * =============================================================================
 * 
 * Enhanced pricing calculation service with tonnage-based pricing.
 * Designed for easy AWS Lambda migration and scalability.
 * 
 * PRICING FACTORS:
 * - Tonnage-based pricing (per ton per km)
 * - Base rate per vehicle type
 * - Distance slab pricing (short/medium/long haul)
 * - Vehicle subtype multipliers
 * - Surge pricing (time-based)
 * - Minimum charge enforcement
 * 
 * =============================================================================
 */

import crypto from 'crypto';
import { logger } from '../../shared/services/logger.service';
import { FLAGS, isEnabled } from '../../shared/config/feature-flags';
import {
  VEHICLE_CATALOG,
  getVehicleConfig,
  getSubtypeConfig,
  getDistanceSlabMultiplier,
  findSuitableVehicles,
  getAllVehicleTypes,
  type VehicleTypeConfig,
  type VehicleSubtypeConfig,
} from './vehicle-catalog';

/**
 * Surge pricing configuration
 * Based on time of day and demand
 */
const SURGE_CONFIG = {
  peakHours: [8, 9, 10, 17, 18, 19], // 8-10 AM, 5-7 PM
  peakMultiplier: 1.2,
  nightHours: [22, 23, 0, 1, 2, 3, 4, 5], // 10 PM - 6 AM
  nightMultiplier: 1.1,
  weekendMultiplier: 1.05,
};

/**
 * Minimum distance for pricing
 */
const MIN_DISTANCE_KM = 5;

// ============================================================================
// F-A-26 — Surge determinism + signed quote token (Uber H3 × 5-min + Stripe
// PaymentIntent + Adyen HMAC)
// ============================================================================

/**
 * Surge bucket size (5 minutes) — matches Uber's real-time surge pipeline
 * and gives every quote a deterministic (cellId, bucketStart) anchor.
 */
const SURGE_BUCKET_MS = 5 * 60 * 1000;

/**
 * IST (Asia/Kolkata) extractor used for hour-of-day / day-of-week decisions.
 * This makes surge decisions independent of the container's local timezone,
 * which previously caused UTC-hosted ECS tasks to compute the wrong hour.
 */
const IST_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: 'numeric',
  hour12: false,
  weekday: 'short'
});

/**
 * HMAC key for quote tokens. Reuses JWT_SECRET to avoid introducing another
 * secret; if unset we fall back to a deterministic dev-only string so unit
 * tests remain reproducible. The production env validator enforces a
 * non-empty JWT_SECRET (see src/core/config/env.validation.ts).
 */
function getQuoteHmacKey(): string {
  return process.env.JWT_SECRET || 'weelo-dev-pricing-hmac-key';
}

/**
 * Internal shape returned by the surge resolver. Callers use the multiplier
 * and the auxiliary fields (ruleId, bucket boundaries) to sign a quote token.
 */
interface SurgeDecision {
  multiplier: number;
  ruleId: string;
  bucketStart: Date;
  bucketEnd: Date;
  surgeFactor: string;
}

function computeSurgeLabel(multiplier: number): string {
  if (multiplier > 1.15) return 'Peak Hours';
  if (multiplier > 1.05) return 'Moderate Demand';
  return 'Normal';
}

/**
 * Deterministic surge resolution:
 *   bucket  = floor(now / 5min) * 5min   (Uber real-time pipeline)
 *   hour/dw = Asia/Kolkata-resolved, NOT container-local
 *   ruleId  = SHA-256({cellId, bucketStart, parts}).slice(0, 16)
 */
function resolveSurgeDecision(timestampMs: number, cellId?: string): SurgeDecision {
  const bucketStartMs = Math.floor(timestampMs / SURGE_BUCKET_MS) * SURGE_BUCKET_MS;
  const bucketStart = new Date(bucketStartMs);
  const bucketEnd = new Date(bucketStartMs + SURGE_BUCKET_MS);

  // Extract IST hour + weekday deterministically regardless of container TZ.
  const parts = IST_FORMATTER.formatToParts(bucketStart);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const weekdayShort = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const isWeekend = weekdayShort === 'Sat' || weekdayShort === 'Sun';

  let multiplier = 1.0;
  const active: string[] = [];
  if (SURGE_CONFIG.peakHours.includes(hour)) {
    multiplier *= SURGE_CONFIG.peakMultiplier;
    active.push('peak');
  }
  if (SURGE_CONFIG.nightHours.includes(hour)) {
    multiplier *= SURGE_CONFIG.nightMultiplier;
    active.push('night');
  }
  if (isWeekend) {
    multiplier *= SURGE_CONFIG.weekendMultiplier;
    active.push('weekend');
  }
  multiplier = Math.round(multiplier * 100) / 100;

  const ruleId = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        cellId: cellId ?? null,
        bucketStart: bucketStart.toISOString(),
        parts: active.length > 0 ? active : ['baseline'],
      })
    )
    .digest('hex')
    .slice(0, 16);

  return {
    multiplier,
    ruleId,
    bucketStart,
    bucketEnd,
    surgeFactor: computeSurgeLabel(multiplier),
  };
}

/**
 * Sign a price quote with HMAC-SHA256 so the order-creation path can verify
 * the client didn't tamper with a previously issued price. Follows the
 * Agentic Commerce Protocol / Adyen HMAC signing pattern.
 */
export function signQuoteToken(payload: {
  pricePerTruck: number;
  surgeRuleId: string;
  surgeBucketStart: string;
  surgeBucketEnd: string;
}): string {
  const canonical = JSON.stringify({
    p: payload.pricePerTruck,
    r: payload.surgeRuleId,
    s: payload.surgeBucketStart,
    e: payload.surgeBucketEnd,
  });
  return crypto.createHmac('sha256', getQuoteHmacKey()).update(canonical).digest('hex');
}

/**
 * Verify a quote token. Returns true only if the HMAC matches AND the
 * quote's 5-min bucket has not expired relative to `nowMs`.
 */
export function verifyQuoteToken(
  token: string,
  payload: {
    pricePerTruck: number;
    surgeRuleId: string;
    surgeBucketStart: string;
    surgeBucketEnd: string;
  },
  nowMs: number = Date.now()
): boolean {
  if (!token || typeof token !== 'string') return false;
  const expected = signQuoteToken(payload);
  const tokenBuf = Buffer.from(token, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (tokenBuf.length !== expectedBuf.length) return false;
  if (!crypto.timingSafeEqual(tokenBuf, expectedBuf)) return false;
  const bucketEndMs = Date.parse(payload.surgeBucketEnd);
  if (!Number.isFinite(bucketEndMs)) return false;
  return nowMs < bucketEndMs;
}

// ============================================================================
// INTERFACES
// ============================================================================

interface PriceEstimateRequest {
  vehicleType: string;
  vehicleSubtype?: string;
  distanceKm: number;
  trucksNeeded: number;
  cargoWeightKg?: number;  // Optional: for tonnage-based calculation
  // F-A-26: caller may pass a stable cellId (e.g. pickup city code or future H3
  // index) so the surge decision is deterministic per (cellId, bucketStart).
  cellId?: string;
  // F-A-26: override the surge bucket timestamp; primarily for tests.
  // In production this defaults to Date.now() inside calculateSurgeMultiplier.
  timestampMs?: number;
}

interface PriceEstimateResponse {
  basePrice: number;
  distanceCharge: number;
  tonnageCharge: number;
  subtypeMultiplier: number;
  distanceSlabMultiplier: number;
  surgeMultiplier: number;
  pricePerTruck: number;
  totalPrice: number;
  trucksNeeded: number;
  breakdown: PriceBreakdown;
  currency: string;
  validForMinutes: number;
  capacityInfo: CapacityInfo;
  // F-A-26 (additive/backward-compatible): deterministic surge anchor + HMAC
  // signed quote. Customers replay these on order-creation so the server can
  // verify the price wasn't tampered with and doesn't silently re-price.
  quoteToken?: string;
  surgeRuleId?: string;
  surgeBucketStart?: string;
  surgeBucketEnd?: string;
}

interface PriceBreakdown {
  vehicleType: string;
  vehicleSubtype: string;
  distanceKm: number;
  baseRate: number;
  perKmRate: number;
  perTonPerKmRate: number;
  surgeFactor: string;
  distanceSlab: string;
}

interface CapacityInfo {
  capacityKg: number;
  capacityTons: number;
  minTonnage: number;
  maxTonnage: number;
}

interface VehicleSuggestion {
  vehicleType: string;
  vehicleSubtype: string;
  displayName: string;
  capacityKg: number;
  capacityTons: number;
  pricePerTruck: number;
  totalPrice: number;
  savingsAmount: number;
  savingsPercent: number;
  isRecommended: boolean;
  isCurrentSelection: boolean;
  reason: string;
}

interface SuggestionsRequest {
  cargoWeightKg: number;
  distanceKm: number;
  trucksNeeded: number;
  currentVehicleType?: string;
  currentVehicleSubtype?: string;
}

interface SuggestionsResponse {
  suggestions: VehicleSuggestion[];
  recommendedOption: VehicleSuggestion | null;
  currentOption: VehicleSuggestion | null;
  potentialSavings: number;
}

// ============================================================================
// F-A-30 — calculateEstimate refactor (PricingV2)
// ============================================================================
//
// The legacy `calculateEstimate` mixed nine concerns (catalog lookup, distance
// charge, tonnage charge, subtype multiplier, surge resolve, min-charge,
// rounding, quote-token signing, response shape) into ~106 LOC. Following the
// Martin Fowler "Replace Method with Method Object / Extract Method" pattern,
// V2 splits the work across 7 pure helpers + a 15-line orchestrator. V1 is
// retained verbatim and gated behind FF_PRICING_V2 so the refactor can soak.
//
// Parity contract: V2 output MUST match V1 byte-for-byte for all 50 canned
// fixtures in `__fixtures__/pricing-golden-master-fixtures.json`.
// ============================================================================

/**
 * Synthetic "catalog miss" fallback config. Used by v2's resolveCatalog when
 * the customer asks for a vehicle type the catalog does not know about. The
 * numbers MUST match v1's `calculateWithDefaults` (basePrice=2000, perKm=30,
 * perTonPerKm=0, minCharge=1500) so byte-identical parity holds.
 */
const FALLBACK_CATALOG: VehicleTypeConfig = {
  id: '__fallback__',
  displayName: '__fallback__',
  category: 'tonnage',
  baseRate: 2000,
  perKmRate: 30,
  perTonPerKmRate: 0,
  minCharge: 1500,
  subtypes: {},
};

/** Synthetic capacity used by v2 when subtypeConfig is null (parity with v1). */
const FALLBACK_CAPACITY = {
  capacityKg: 10000,
  capacityTons: 10,
  minTonnage: 5,
  maxTonnage: 15,
};

interface ResolvedCatalog {
  catalog: VehicleTypeConfig;
  subtypeConfig: VehicleSubtypeConfig | null;
  /** True when the lookup missed and the fallback is in use. */
  isFallback: boolean;
}

/**
 * v2 helper #1 — resolveCatalog. Returns the vehicle catalog entry for the
 * requested type+subtype, or a deterministic fallback when the type is
 * unknown. Replaces v1's split between `calculateEstimate` (catalog hit) and
 * `calculateWithDefaults` (catalog miss).
 */
export function resolveCatalog(
  vehicleType: string,
  vehicleSubtype: string | undefined
): ResolvedCatalog {
  const catalog = getVehicleConfig(vehicleType);
  if (!catalog) {
    logger.warn(`Vehicle type not found in catalog: ${vehicleType}, using defaults`);
    return { catalog: FALLBACK_CATALOG, subtypeConfig: null, isFallback: true };
  }
  const subtypeConfig = vehicleSubtype ? getSubtypeConfig(vehicleType, vehicleSubtype) : null;
  return { catalog, subtypeConfig, isFallback: false };
}

/** v2 helper #2 — distance charge: chargeable distance × per-km rate. */
export function computeDistanceCharge(catalog: VehicleTypeConfig, distanceKm: number): number {
  const chargeable = Math.max(distanceKm, MIN_DISTANCE_KM);
  return chargeable * catalog.perKmRate;
}

/**
 * v2 helper #3 — tonnage charge. Uses cargo weight when supplied, else falls
 * back to subtype.maxTonnage (or 10t when no subtype). Matches v1 exactly.
 */
export function computeTonnageCharge(
  catalog: VehicleTypeConfig,
  distanceKm: number,
  cargoWeightKg: number | undefined,
  subtypeConfig: VehicleSubtypeConfig | null
): number {
  const chargeable = Math.max(distanceKm, MIN_DISTANCE_KM);
  const effectiveTonnage = cargoWeightKg ? cargoWeightKg / 1000 : subtypeConfig?.maxTonnage || 10;
  return effectiveTonnage * chargeable * catalog.perTonPerKmRate;
}

/**
 * v2 helper #4 — apply the subtype rate multiplier. When no subtype is
 * configured (catalog-miss fallback or absent subtype), the multiplier is
 * 1.0 to preserve v1 parity in the catalog-miss path.
 */
export function applySubtypeMultiplier(
  subtotal: number,
  subtypeConfig: VehicleSubtypeConfig | null
): number {
  const multiplier = subtypeConfig?.baseRateMultiplier ?? 1.0;
  return subtotal * multiplier;
}

interface SurgeApplied {
  finalPrice: number;
  surgeApplied: SurgeDecision;
}

/**
 * v2 helper #5 — apply the surge decision to a subtotal, returning the
 * surged price plus the SurgeDecision metadata used downstream by quote-token
 * signing and response shaping.
 */
export function applySurgeDecision(
  subtotal: number,
  timestampMs: number | undefined,
  cellId: string | undefined
): SurgeApplied {
  const surge = resolveSurgeDecision(timestampMs ?? Date.now(), cellId);
  return { finalPrice: subtotal * surge.multiplier, surgeApplied: surge };
}

/**
 * v2 helper #6 — enforce the minimum charge floor and round to the nearest
 * rupee. Centralises v1's two-step `Math.max` then `Math.round`.
 */
export function enforceMinCharge(finalPrice: number, catalog: VehicleTypeConfig): number {
  return Math.round(Math.max(finalPrice, catalog.minCharge));
}

interface QuoteTokenResponseFields {
  quoteToken: string;
  surgeRuleId: string;
  surgeBucketStart: string;
  surgeBucketEnd: string;
}

/**
 * v2 helper #7 — sign the quote token and shape the response fields the
 * F-A-26 client replays on order creation. `pickupH3` is reserved for the
 * future H3 cell-id integration; today the cellId comes from the
 * SurgeDecision via the surgeApplied metadata.
 */
export function buildQuoteTokenResponse(
  finalPrice: number,
  surgeApplied: SurgeDecision
): QuoteTokenResponseFields {
  const surgeBucketStart = surgeApplied.bucketStart.toISOString();
  const surgeBucketEnd = surgeApplied.bucketEnd.toISOString();
  const quoteToken = signQuoteToken({
    pricePerTruck: finalPrice,
    surgeRuleId: surgeApplied.ruleId,
    surgeBucketStart,
    surgeBucketEnd,
  });
  return { quoteToken, surgeRuleId: surgeApplied.ruleId, surgeBucketStart, surgeBucketEnd };
}

/**
 * v2 — orchestrator. ~15 lines that compose the 7 pure helpers above.
 * Output shape and numeric values are byte-identical to v1's
 * `calculateEstimateLegacy`, validated by the golden-master fixtures.
 */
function calculateEstimateV2(request: PriceEstimateRequest): PriceEstimateResponse {
  const { vehicleType, vehicleSubtype, distanceKm, trucksNeeded, cargoWeightKg, cellId, timestampMs } = request;
  const { catalog, subtypeConfig, isFallback } = resolveCatalog(vehicleType, vehicleSubtype);

  const distanceCharge = computeDistanceCharge(catalog, distanceKm);
  const tonnageCharge = computeTonnageCharge(catalog, distanceKm, cargoWeightKg, subtypeConfig);
  const distanceSlab = getDistanceSlabMultiplier(Math.max(distanceKm, MIN_DISTANCE_KM));
  const subtypeMultiplier = subtypeConfig?.baseRateMultiplier ?? 1.0;

  // The fallback path multiplies (basePrice + distanceCharge) only — no tonnage
  // and no subtype multiplier — to preserve v1's `calculateWithDefaults` parity.
  const subtotalBeforeSurge = isFallback
    ? (catalog.baseRate + distanceCharge) * distanceSlab.multiplier
    : applySubtypeMultiplier(catalog.baseRate + distanceCharge + tonnageCharge, subtypeConfig) * distanceSlab.multiplier;

  const { finalPrice: surgedPrice, surgeApplied } = applySurgeDecision(subtotalBeforeSurge, timestampMs, cellId);
  const pricePerTruck = enforceMinCharge(surgedPrice, catalog);
  const quoteFields = buildQuoteTokenResponse(pricePerTruck, surgeApplied);

  const totalPrice = pricePerTruck * trucksNeeded;
  const chargeableDistance = Math.max(distanceKm, MIN_DISTANCE_KM);

  // Parity log lines (v1 emits these inside the catalog-hit branch only).
  if (!isFallback) {
    logger.info(`Price calculated: ${vehicleType}/${vehicleSubtype || 'default'} x${trucksNeeded}, ${distanceKm}km = ₹${totalPrice}`);
    logger.info(`Breakdown: Base=${catalog.baseRate}, Distance=${distanceCharge}, Tonnage=${tonnageCharge.toFixed(0)}, Slab=${distanceSlab.label}`);
  }

  if (isFallback) {
    return {
      basePrice: catalog.baseRate,
      distanceCharge,
      tonnageCharge: 0,
      subtypeMultiplier: 1.0,
      distanceSlabMultiplier: distanceSlab.multiplier,
      surgeMultiplier: surgeApplied.multiplier,
      pricePerTruck,
      totalPrice,
      trucksNeeded,
      breakdown: {
        vehicleType,
        vehicleSubtype: vehicleSubtype || 'Standard',
        distanceKm: chargeableDistance,
        baseRate: catalog.baseRate,
        perKmRate: catalog.perKmRate,
        perTonPerKmRate: 0,
        surgeFactor: surgeApplied.surgeFactor,
        distanceSlab: distanceSlab.label,
      },
      currency: 'INR',
      validForMinutes: 5,
      capacityInfo: { ...FALLBACK_CAPACITY },
      ...quoteFields,
    };
  }

  return {
    basePrice: Math.round(catalog.baseRate * subtypeMultiplier),
    distanceCharge: Math.round(distanceCharge * distanceSlab.multiplier),
    tonnageCharge: Math.round(tonnageCharge),
    subtypeMultiplier,
    distanceSlabMultiplier: distanceSlab.multiplier,
    surgeMultiplier: surgeApplied.multiplier,
    pricePerTruck,
    totalPrice,
    trucksNeeded,
    breakdown: {
      vehicleType,
      vehicleSubtype: vehicleSubtype || 'Standard',
      distanceKm: chargeableDistance,
      baseRate: catalog.baseRate,
      perKmRate: catalog.perKmRate,
      perTonPerKmRate: catalog.perTonPerKmRate,
      surgeFactor: surgeApplied.surgeFactor,
      distanceSlab: distanceSlab.label,
    },
    currency: 'INR',
    validForMinutes: 5,
    capacityInfo: {
      capacityKg: subtypeConfig?.capacityKg || 10000,
      capacityTons: (subtypeConfig?.capacityKg || 10000) / 1000,
      minTonnage: subtypeConfig?.minTonnage || 5,
      maxTonnage: subtypeConfig?.maxTonnage || 15,
    },
    ...quoteFields,
  };
}

/**
 * Test-only indicator — true iff FF_PRICING_V2 is enabled. Used by
 * `pricing-golden-master.test.ts` to verify the v2 orchestrator is actually
 * wired and the legacy path is not silently servicing the fixtures.
 */
export function __pricingV2Active(): boolean {
  return isEnabled(FLAGS.PRICING_V2);
}

// ============================================================================
// PRICING SERVICE CLASS
// ============================================================================

class PricingService {
  
  /**
   * Calculate price estimate for a booking
   * Uses enhanced tonnage-based pricing algorithm
   *
   * F-A-30: when FF_PRICING_V2 is ON, dispatch to the refactored 7-helper
   * orchestrator (`calculateEstimateV2`). The legacy ~106-LOC implementation
   * below remains the default until the golden-master parity has soaked.
   *
   * @param request - Pricing request parameters
   * @returns Detailed price estimate
   */
  calculateEstimate(request: PriceEstimateRequest): PriceEstimateResponse {
    if (isEnabled(FLAGS.PRICING_V2)) {
      return calculateEstimateV2(request);
    }
    return this.calculateEstimateLegacy(request);
  }

  /**
   * Legacy v1 implementation — preserved verbatim. Do not edit; v2 must keep
   * byte-identical parity with this method until the FF flips and v1 is
   * deleted in a follow-up PR.
   */
  private calculateEstimateLegacy(request: PriceEstimateRequest): PriceEstimateResponse {
    const { vehicleType, vehicleSubtype, distanceKm, trucksNeeded, cargoWeightKg, cellId, timestampMs } = request;

    // Get vehicle config from catalog
    const vehicleConfig = getVehicleConfig(vehicleType);
    const subtypeConfig = vehicleSubtype ? getSubtypeConfig(vehicleType, vehicleSubtype) : null;

    // Use default if vehicle type not found
    if (!vehicleConfig) {
      logger.warn(`Vehicle type not found in catalog: ${vehicleType}, using defaults`);
      return this.calculateWithDefaults(request);
    }

    // Calculate base price
    const basePrice = vehicleConfig.baseRate;

    // Calculate distance (minimum distance applies)
    const chargeableDistance = Math.max(distanceKm, MIN_DISTANCE_KM);

    // Get distance slab multiplier
    const distanceSlab = getDistanceSlabMultiplier(chargeableDistance);
    const distanceSlabMultiplier = distanceSlab.multiplier;

    // Calculate distance charge
    const distanceCharge = chargeableDistance * vehicleConfig.perKmRate;

    // Calculate tonnage charge (if cargo weight provided or use max capacity)
    const effectiveTonnage = cargoWeightKg
      ? cargoWeightKg / 1000
      : (subtypeConfig?.maxTonnage || 10);
    const tonnageCharge = effectiveTonnage * chargeableDistance * vehicleConfig.perTonPerKmRate;

    // Get subtype multiplier
    const subtypeMultiplier = subtypeConfig?.baseRateMultiplier || 1.0;

    // F-A-26: resolve the surge decision ONCE (deterministic per 5-min bucket
    // and cellId) so multiplier, label, ruleId, and quote-token all agree.
    const surgeDecision = resolveSurgeDecision(timestampMs ?? Date.now(), cellId);
    const surgeMultiplier = surgeDecision.multiplier;
    const surgeFactor = surgeDecision.surgeFactor;

    // Calculate price per truck using enhanced formula
    // Formula: (BaseRate + DistanceCharge + TonnageCharge) * SubtypeMultiplier * DistanceSlabMultiplier * SurgeMultiplier
    let pricePerTruck = (basePrice + distanceCharge + tonnageCharge)
      * subtypeMultiplier
      * distanceSlabMultiplier
      * surgeMultiplier;

    // Apply minimum charge
    pricePerTruck = Math.max(pricePerTruck, vehicleConfig.minCharge);
    pricePerTruck = Math.round(pricePerTruck); // Round to nearest rupee

    // Calculate total price
    const totalPrice = pricePerTruck * trucksNeeded;

    // Get capacity info
    const capacityInfo: CapacityInfo = {
      capacityKg: subtypeConfig?.capacityKg || 10000,
      capacityTons: (subtypeConfig?.capacityKg || 10000) / 1000,
      minTonnage: subtypeConfig?.minTonnage || 5,
      maxTonnage: subtypeConfig?.maxTonnage || 15
    };

    logger.info(`Price calculated: ${vehicleType}/${vehicleSubtype || 'default'} x${trucksNeeded}, ${distanceKm}km = ₹${totalPrice}`);
    logger.info(`Breakdown: Base=${basePrice}, Distance=${distanceCharge}, Tonnage=${tonnageCharge.toFixed(0)}, Slab=${distanceSlab.label}`);

    const surgeBucketStart = surgeDecision.bucketStart.toISOString();
    const surgeBucketEnd = surgeDecision.bucketEnd.toISOString();
    const quoteToken = signQuoteToken({
      pricePerTruck,
      surgeRuleId: surgeDecision.ruleId,
      surgeBucketStart,
      surgeBucketEnd,
    });

    return {
      basePrice: Math.round(basePrice * subtypeMultiplier),
      distanceCharge: Math.round(distanceCharge * distanceSlabMultiplier),
      tonnageCharge: Math.round(tonnageCharge),
      subtypeMultiplier,
      distanceSlabMultiplier,
      surgeMultiplier,
      pricePerTruck,
      totalPrice,
      trucksNeeded,
      breakdown: {
        vehicleType,
        vehicleSubtype: vehicleSubtype || 'Standard',
        distanceKm: chargeableDistance,
        baseRate: vehicleConfig.baseRate,
        perKmRate: vehicleConfig.perKmRate,
        perTonPerKmRate: vehicleConfig.perTonPerKmRate,
        surgeFactor,
        distanceSlab: distanceSlab.label
      },
      currency: 'INR',
      // F-A-26: align validForMinutes with the 5-min surge bucket so clients
      // don't display a freshness window the server won't actually honour.
      validForMinutes: 5,
      capacityInfo,
      quoteToken,
      surgeRuleId: surgeDecision.ruleId,
      surgeBucketStart,
      surgeBucketEnd,
    };
  }

  /**
   * Calculate with default values when vehicle type not in catalog
   */
  private calculateWithDefaults(request: PriceEstimateRequest): PriceEstimateResponse {
    const { vehicleType, vehicleSubtype, distanceKm, trucksNeeded, cellId, timestampMs } = request;

    const basePrice = 2000;
    const perKmRate = 30;
    const chargeableDistance = Math.max(distanceKm, MIN_DISTANCE_KM);
    const distanceCharge = chargeableDistance * perKmRate;
    // F-A-26: share the same deterministic surge decision + signed quote in the
    // fallback/catalog-miss path so downstream behaviour is consistent.
    const surgeDecision = resolveSurgeDecision(timestampMs ?? Date.now(), cellId);
    const surgeMultiplier = surgeDecision.multiplier;
    const surgeFactor = surgeDecision.surgeFactor;
    const distanceSlab = getDistanceSlabMultiplier(chargeableDistance);

    let pricePerTruck = (basePrice + distanceCharge) * distanceSlab.multiplier * surgeMultiplier;
    pricePerTruck = Math.max(pricePerTruck, 1500);
    pricePerTruck = Math.round(pricePerTruck);

    const surgeBucketStart = surgeDecision.bucketStart.toISOString();
    const surgeBucketEnd = surgeDecision.bucketEnd.toISOString();
    const quoteToken = signQuoteToken({
      pricePerTruck,
      surgeRuleId: surgeDecision.ruleId,
      surgeBucketStart,
      surgeBucketEnd,
    });

    return {
      basePrice,
      distanceCharge,
      tonnageCharge: 0,
      subtypeMultiplier: 1.0,
      distanceSlabMultiplier: distanceSlab.multiplier,
      surgeMultiplier,
      pricePerTruck,
      totalPrice: pricePerTruck * trucksNeeded,
      trucksNeeded,
      breakdown: {
        vehicleType,
        vehicleSubtype: vehicleSubtype || 'Standard',
        distanceKm: chargeableDistance,
        baseRate: basePrice,
        perKmRate,
        perTonPerKmRate: 0,
        surgeFactor,
        distanceSlab: distanceSlab.label
      },
      currency: 'INR',
      validForMinutes: 5,
      capacityInfo: {
        capacityKg: 10000,
        capacityTons: 10,
        minTonnage: 5,
        maxTonnage: 15
      },
      quoteToken,
      surgeRuleId: surgeDecision.ruleId,
      surgeBucketStart,
      surgeBucketEnd,
    };
  }

  /**
   * Get vehicle suggestions based on cargo weight
   * Recommends the most cost-effective vehicle for the cargo
   */
  getSuggestions(request: SuggestionsRequest): SuggestionsResponse {
    const { cargoWeightKg, distanceKm, trucksNeeded, currentVehicleType, currentVehicleSubtype } = request;
    
    // Find all suitable vehicles
    const suitableVehicles = findSuitableVehicles(cargoWeightKg);
    
    if (suitableVehicles.length === 0) {
      logger.warn(`No suitable vehicles found for cargo weight: ${cargoWeightKg}kg`);
      return {
        suggestions: [],
        recommendedOption: null,
        currentOption: null,
        potentialSavings: 0
      };
    }

    // Calculate price for each suitable vehicle
    const suggestions: VehicleSuggestion[] = suitableVehicles.slice(0, 5).map(vehicle => {
      const estimate = this.calculateEstimate({
        vehicleType: vehicle.vehicleType,
        vehicleSubtype: vehicle.subtype,
        distanceKm,
        trucksNeeded,
        cargoWeightKg
      });

      const vehicleConfig = getVehicleConfig(vehicle.vehicleType);
      const isCurrentSelection = 
        vehicle.vehicleType.toLowerCase() === currentVehicleType?.toLowerCase() &&
        vehicle.subtype.toLowerCase() === currentVehicleSubtype?.toLowerCase();

      return {
        vehicleType: vehicle.vehicleType,
        vehicleSubtype: vehicle.subtype,
        displayName: `${vehicleConfig?.displayName || vehicle.vehicleType} - ${vehicle.subtype}`,
        capacityKg: vehicle.capacityKg,
        capacityTons: vehicle.capacityKg / 1000,
        pricePerTruck: estimate.pricePerTruck,
        totalPrice: estimate.totalPrice,
        savingsAmount: 0, // Will be calculated after sorting
        savingsPercent: 0,
        isRecommended: vehicle.isExactFit,
        isCurrentSelection,
        reason: vehicle.isExactFit 
          ? 'Best fit for your cargo' 
          : vehicle.isOversized 
            ? 'Larger than needed' 
            : 'Good option'
      };
    });

    // Sort by price
    suggestions.sort((a, b) => a.totalPrice - b.totalPrice);

    // Calculate savings compared to most expensive option
    const maxPrice = Math.max(...suggestions.map(s => s.totalPrice));
    suggestions.forEach(s => {
      s.savingsAmount = maxPrice - s.totalPrice;
      s.savingsPercent = Math.round((s.savingsAmount / maxPrice) * 100);
    });

    // Find recommended option (cheapest that fits well)
    const recommendedOption = suggestions.find(s => s.isRecommended) || suggestions[0];
    if (recommendedOption) {
      recommendedOption.isRecommended = true;
      recommendedOption.reason = '💰 Best value for your cargo';
    }

    // Find current selection
    const currentOption = suggestions.find(s => s.isCurrentSelection) || null;

    // Calculate potential savings
    const potentialSavings = currentOption 
      ? currentOption.totalPrice - (recommendedOption?.totalPrice || 0)
      : 0;

    logger.info(`Suggestions generated: ${suggestions.length} options for ${cargoWeightKg}kg cargo`);
    if (potentialSavings > 0) {
      logger.info(`Potential savings: ₹${potentialSavings}`);
    }

    return {
      suggestions,
      recommendedOption,
      currentOption,
      potentialSavings: Math.max(0, potentialSavings)
    };
  }

  /**
   * F-A-26: Deterministic surge multiplier.
   *
   * Previously this used `new Date().getHours()` / `getDay()`, which made the
   * surge decision depend on the container's local timezone. The ECS task
   * runs in UTC but Weelo's hour-of-day rules are in IST, so peak hours were
   * off by 5.5 hours in production. We now:
   *   1. Accept an explicit `timestampMs` (defaults to Date.now()) and a
   *      stable `cellId` (for future H3 integration; today just pickup city).
   *   2. Quantize to a 5-min bucket — two back-to-back calls in the same
   *      bucket return the same multiplier AND the same ruleId/token.
   *   3. Extract hour-of-day and weekday in Asia/Kolkata via Intl so the
   *      decision is container-TZ-independent.
   *
   * The public shape is preserved (`number` return) for existing callers;
   * deterministic metadata is exposed via `resolveSurgeDecisionPublic` below.
   */
  private calculateSurgeMultiplier(timestampMs?: number, cellId?: string): number {
    return resolveSurgeDecision(timestampMs ?? Date.now(), cellId).multiplier;
  }

  /**
   * Get human-readable surge factor for the same bucket as the multiplier.
   */
  private getSurgeFactor(timestampMs?: number, cellId?: string): string {
    return resolveSurgeDecision(timestampMs ?? Date.now(), cellId).surgeFactor;
  }

  /**
   * Get all vehicle types with their base pricing
   * Enhanced to include tonnage information
   */
  getVehiclePricingCatalog(): Record<string, { 
    baseRate: number; 
    perKmRate: number;
    perTonPerKmRate: number;
    minCharge: number;
    displayName: string;
    subtypes: string[];
  }> {
    const catalog: Record<string, any> = {};
    
    for (const [type, config] of Object.entries(VEHICLE_CATALOG)) {
      catalog[type] = {
        baseRate: config.baseRate,
        perKmRate: config.perKmRate,
        perTonPerKmRate: config.perTonPerKmRate,
        minCharge: config.minCharge,
        displayName: config.displayName,
        subtypes: Object.keys(config.subtypes)
      };
    }
    
    return catalog;
  }

  /**
   * Get detailed vehicle catalog with all capacity info
   */
  getDetailedCatalog() {
    return {
      vehicleTypes: getAllVehicleTypes(),
      fullCatalog: VEHICLE_CATALOG
    };
  }
}

export const pricingService = new PricingService();
