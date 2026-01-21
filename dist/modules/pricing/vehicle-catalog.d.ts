/**
 * =============================================================================
 * VEHICLE CATALOG - TONNAGE & CAPACITY DATA
 * =============================================================================
 *
 * Comprehensive vehicle catalog with tonnage-based pricing data.
 * Used for:
 * - Tonnage-based pricing calculations
 * - Vehicle suggestions based on cargo weight
 * - Capacity validation
 *
 * =============================================================================
 */
/**
 * Vehicle subtype configuration with tonnage data
 */
export interface VehicleSubtypeConfig {
    name: string;
    minTonnage: number;
    maxTonnage: number;
    capacityKg: number;
    lengthFeet?: number;
    baseRateMultiplier: number;
}
/**
 * Vehicle type configuration
 */
export interface VehicleTypeConfig {
    id: string;
    displayName: string;
    category: 'tonnage' | 'length' | 'volume';
    baseRate: number;
    perKmRate: number;
    perTonPerKmRate: number;
    minCharge: number;
    subtypes: Record<string, VehicleSubtypeConfig>;
}
/**
 * Complete Vehicle Catalog
 * Pricing is based on actual industry rates for India logistics
 */
export declare const VEHICLE_CATALOG: Record<string, VehicleTypeConfig>;
/**
 * Distance slab configuration for pricing
 * Short haul costs more per km, long haul gets discount
 */
export declare const DISTANCE_SLABS: {
    maxKm: number;
    multiplier: number;
    label: string;
}[];
/**
 * Get distance slab multiplier
 */
export declare function getDistanceSlabMultiplier(distanceKm: number): {
    multiplier: number;
    label: string;
};
/**
 * Get vehicle config by type
 */
export declare function getVehicleConfig(vehicleType: string): VehicleTypeConfig | null;
/**
 * Get subtype config
 */
export declare function getSubtypeConfig(vehicleType: string, subtype: string): VehicleSubtypeConfig | null;
/**
 * Find suitable vehicles for a given cargo weight
 * Returns vehicles that can carry the weight, sorted by price
 */
export declare function findSuitableVehicles(cargoWeightKg: number, preferredType?: string): Array<{
    vehicleType: string;
    subtype: string;
    capacityKg: number;
    baseRateMultiplier: number;
    isExactFit: boolean;
    isOversized: boolean;
}>;
/**
 * Get all vehicle types for catalog display
 */
export declare function getAllVehicleTypes(): Array<{
    id: string;
    displayName: string;
    minCapacity: number;
    maxCapacity: number;
    startingRate: number;
}>;
//# sourceMappingURL=vehicle-catalog.d.ts.map