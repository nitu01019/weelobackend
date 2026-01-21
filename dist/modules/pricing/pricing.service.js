"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.pricingService = void 0;
const logger_service_1 = require("../../shared/services/logger.service");
const vehicle_catalog_1 = require("./vehicle-catalog");
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
    calculateEstimate(request) {
        const { vehicleType, vehicleSubtype, distanceKm, trucksNeeded, cargoWeightKg } = request;
        // Get vehicle config from catalog
        const vehicleConfig = (0, vehicle_catalog_1.getVehicleConfig)(vehicleType);
        const subtypeConfig = vehicleSubtype ? (0, vehicle_catalog_1.getSubtypeConfig)(vehicleType, vehicleSubtype) : null;
        // Use default if vehicle type not found
        if (!vehicleConfig) {
            logger_service_1.logger.warn(`Vehicle type not found in catalog: ${vehicleType}, using defaults`);
            return this.calculateWithDefaults(request);
        }
        // Calculate base price
        const basePrice = vehicleConfig.baseRate;
        // Calculate distance (minimum distance applies)
        const chargeableDistance = Math.max(distanceKm, MIN_DISTANCE_KM);
        // Get distance slab multiplier
        const distanceSlab = (0, vehicle_catalog_1.getDistanceSlabMultiplier)(chargeableDistance);
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
        const capacityInfo = {
            capacityKg: subtypeConfig?.capacityKg || 10000,
            capacityTons: (subtypeConfig?.capacityKg || 10000) / 1000,
            minTonnage: subtypeConfig?.minTonnage || 5,
            maxTonnage: subtypeConfig?.maxTonnage || 15
        };
        logger_service_1.logger.info(`Price calculated: ${vehicleType}/${vehicleSubtype || 'default'} x${trucksNeeded}, ${distanceKm}km = ₹${totalPrice}`);
        logger_service_1.logger.info(`Breakdown: Base=${basePrice}, Distance=${distanceCharge}, Tonnage=${tonnageCharge.toFixed(0)}, Slab=${distanceSlab.label}`);
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
    calculateWithDefaults(request) {
        const { vehicleType, vehicleSubtype, distanceKm, trucksNeeded } = request;
        const basePrice = 2000;
        const perKmRate = 30;
        const chargeableDistance = Math.max(distanceKm, MIN_DISTANCE_KM);
        const distanceCharge = chargeableDistance * perKmRate;
        const surgeMultiplier = this.calculateSurgeMultiplier();
        const surgeFactor = this.getSurgeFactor();
        const distanceSlab = (0, vehicle_catalog_1.getDistanceSlabMultiplier)(chargeableDistance);
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
    getSuggestions(request) {
        const { cargoWeightKg, distanceKm, trucksNeeded, currentVehicleType, currentVehicleSubtype } = request;
        // Find all suitable vehicles
        const suitableVehicles = (0, vehicle_catalog_1.findSuitableVehicles)(cargoWeightKg);
        if (suitableVehicles.length === 0) {
            logger_service_1.logger.warn(`No suitable vehicles found for cargo weight: ${cargoWeightKg}kg`);
            return {
                suggestions: [],
                recommendedOption: null,
                currentOption: null,
                potentialSavings: 0
            };
        }
        // Calculate price for each suitable vehicle
        const suggestions = suitableVehicles.slice(0, 5).map(vehicle => {
            const estimate = this.calculateEstimate({
                vehicleType: vehicle.vehicleType,
                vehicleSubtype: vehicle.subtype,
                distanceKm,
                trucksNeeded,
                cargoWeightKg
            });
            const vehicleConfig = (0, vehicle_catalog_1.getVehicleConfig)(vehicle.vehicleType);
            const isCurrentSelection = vehicle.vehicleType.toLowerCase() === currentVehicleType?.toLowerCase() &&
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
        logger_service_1.logger.info(`Suggestions generated: ${suggestions.length} options for ${cargoWeightKg}kg cargo`);
        if (potentialSavings > 0) {
            logger_service_1.logger.info(`Potential savings: ₹${potentialSavings}`);
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
    calculateSurgeMultiplier() {
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
    getSurgeFactor() {
        const multiplier = this.calculateSurgeMultiplier();
        if (multiplier > 1.15)
            return 'Peak Hours';
        if (multiplier > 1.05)
            return 'Moderate Demand';
        return 'Normal';
    }
    /**
     * Get all vehicle types with their base pricing
     * Enhanced to include tonnage information
     */
    getVehiclePricingCatalog() {
        const catalog = {};
        for (const [type, config] of Object.entries(vehicle_catalog_1.VEHICLE_CATALOG)) {
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
            vehicleTypes: (0, vehicle_catalog_1.getAllVehicleTypes)(),
            fullCatalog: vehicle_catalog_1.VEHICLE_CATALOG
        };
    }
}
exports.pricingService = new PricingService();
//# sourceMappingURL=pricing.service.js.map