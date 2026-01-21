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
// INTERFACES
// ============================================================================

interface PriceEstimateRequest {
  vehicleType: string;
  vehicleSubtype?: string;
  distanceKm: number;
  trucksNeeded: number;
  cargoWeightKg?: number;  // Optional: for tonnage-based calculation
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
    const { vehicleType, vehicleSubtype, distanceKm, trucksNeeded, cargoWeightKg } = request;
    
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

    // Calculate surge multiplier
    const surgeMultiplier = this.calculateSurgeMultiplier();
    const surgeFactor = this.getSurgeFactor();

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
      validForMinutes: 15,
      capacityInfo
    };
  }

  /**
   * Calculate with default values when vehicle type not in catalog
   */
  private calculateWithDefaults(request: PriceEstimateRequest): PriceEstimateResponse {
    const { vehicleType, vehicleSubtype, distanceKm, trucksNeeded } = request;
    
    const basePrice = 2000;
    const perKmRate = 30;
    const chargeableDistance = Math.max(distanceKm, MIN_DISTANCE_KM);
    const distanceCharge = chargeableDistance * perKmRate;
    const surgeMultiplier = this.calculateSurgeMultiplier();
    const surgeFactor = this.getSurgeFactor();
    const distanceSlab = getDistanceSlabMultiplier(chargeableDistance);
    
    let pricePerTruck = (basePrice + distanceCharge) * distanceSlab.multiplier * surgeMultiplier;
    pricePerTruck = Math.max(pricePerTruck, 1500);
    pricePerTruck = Math.round(pricePerTruck);
    
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
      validForMinutes: 15,
      capacityInfo: {
        capacityKg: 10000,
        capacityTons: 10,
        minTonnage: 5,
        maxTonnage: 15
      }
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
   * Calculate surge multiplier based on current time
   */
  private calculateSurgeMultiplier(): number {
    const now = new Date();
    const hour = now.getHours();
    const dayOfWeek = now.getDay();

    let multiplier = 1.0;

    // Check peak hours
    if (SURGE_CONFIG.peakHours.includes(hour)) {
      multiplier *= SURGE_CONFIG.peakMultiplier;
    }

    // Check night hours
    if (SURGE_CONFIG.nightHours.includes(hour)) {
      multiplier *= SURGE_CONFIG.nightMultiplier;
    }

    // Check weekend
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      multiplier *= SURGE_CONFIG.weekendMultiplier;
    }

    return Math.round(multiplier * 100) / 100; // Round to 2 decimal places
  }

  /**
   * Get human-readable surge factor
   */
  private getSurgeFactor(): string {
    const multiplier = this.calculateSurgeMultiplier();
    if (multiplier > 1.15) return 'Peak Hours';
    if (multiplier > 1.05) return 'Moderate Demand';
    return 'Normal';
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
