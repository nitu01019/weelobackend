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
interface PriceEstimateRequest {
    vehicleType: string;
    vehicleSubtype?: string;
    distanceKm: number;
    trucksNeeded: number;
    cargoWeightKg?: number;
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
declare class PricingService {
    /**
     * Calculate price estimate for a booking
     * Uses enhanced tonnage-based pricing algorithm
     *
     * @param request - Pricing request parameters
     * @returns Detailed price estimate
     */
    calculateEstimate(request: PriceEstimateRequest): PriceEstimateResponse;
    /**
     * Calculate with default values when vehicle type not in catalog
     */
    private calculateWithDefaults;
    /**
     * Get vehicle suggestions based on cargo weight
     * Recommends the most cost-effective vehicle for the cargo
     */
    getSuggestions(request: SuggestionsRequest): SuggestionsResponse;
    /**
     * Calculate surge multiplier based on current time
     */
    private calculateSurgeMultiplier;
    /**
     * Get human-readable surge factor
     */
    private getSurgeFactor;
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
    }>;
    /**
     * Get detailed vehicle catalog with all capacity info
     */
    getDetailedCatalog(): {
        vehicleTypes: {
            id: string;
            displayName: string;
            minCapacity: number;
            maxCapacity: number;
            startingRate: number;
        }[];
        fullCatalog: Record<string, import("./vehicle-catalog").VehicleTypeConfig>;
    };
}
export declare const pricingService: PricingService;
export {};
//# sourceMappingURL=pricing.service.d.ts.map