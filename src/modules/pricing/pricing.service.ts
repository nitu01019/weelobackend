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
import {
  VEHICLE_CATALOG,
  getVehicleConfig,
  getSubtypeConfig,
  getDistanceSlabMultiplier,
  findSuitableVehicles,
  getAllVehicleTypes
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
// PRICING SERVICE CLASS
// ============================================================================

class PricingService {
  
  /**
   * Calculate price estimate for a booking
   * Uses enhanced tonnage-based pricing algorithm
   * 
   * @param request - Pricing request parameters
   * @returns Detailed price estimate
   */
  calculateEstimate(request: PriceEstimateRequest): PriceEstimateResponse {
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
