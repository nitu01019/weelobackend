/**
 * =============================================================================
 * PRICING MODULE - SCHEMA
 * =============================================================================
 *
 * Zod validation schemas for pricing-related API requests.
 * Defines the contract for fare estimation endpoints.
 *
 * ENHANCED: Added tonnage-based pricing and vehicle suggestions schemas
 * =============================================================================
 */
import { z } from 'zod';
export declare const VALID_VEHICLE_TYPES: readonly ["mini", "lcv", "open", "tipper", "dumper", "container", "trailer", "tanker", "bulker"];
/**
 * Schema for price estimate request
 * Enhanced with optional cargo weight for tonnage-based pricing
 */
export declare const priceEstimateSchema: z.ZodObject<{
    body: z.ZodObject<{
        vehicleType: z.ZodString;
        vehicleSubtype: z.ZodOptional<z.ZodString>;
        distanceKm: z.ZodNumber;
        trucksNeeded: z.ZodNumber;
        cargoWeightKg: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        vehicleType: string;
        trucksNeeded: number;
        distanceKm: number;
        vehicleSubtype?: string | undefined;
        cargoWeightKg?: number | undefined;
    }, {
        vehicleType: string;
        trucksNeeded: number;
        distanceKm: number;
        vehicleSubtype?: string | undefined;
        cargoWeightKg?: number | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    body: {
        vehicleType: string;
        trucksNeeded: number;
        distanceKm: number;
        vehicleSubtype?: string | undefined;
        cargoWeightKg?: number | undefined;
    };
}, {
    body: {
        vehicleType: string;
        trucksNeeded: number;
        distanceKm: number;
        vehicleSubtype?: string | undefined;
        cargoWeightKg?: number | undefined;
    };
}>;
/**
 * Schema for bulk pricing request (multiple vehicle types)
 */
export declare const bulkPriceEstimateSchema: z.ZodObject<{
    body: z.ZodObject<{
        distanceKm: z.ZodNumber;
        vehicles: z.ZodArray<z.ZodObject<{
            vehicleType: z.ZodString;
            vehicleSubtype: z.ZodOptional<z.ZodString>;
            quantity: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            vehicleType: string;
            quantity: number;
            vehicleSubtype?: string | undefined;
        }, {
            vehicleType: string;
            quantity: number;
            vehicleSubtype?: string | undefined;
        }>, "many">;
    }, "strip", z.ZodTypeAny, {
        distanceKm: number;
        vehicles: {
            vehicleType: string;
            quantity: number;
            vehicleSubtype?: string | undefined;
        }[];
    }, {
        distanceKm: number;
        vehicles: {
            vehicleType: string;
            quantity: number;
            vehicleSubtype?: string | undefined;
        }[];
    }>;
}, "strip", z.ZodTypeAny, {
    body: {
        distanceKm: number;
        vehicles: {
            vehicleType: string;
            quantity: number;
            vehicleSubtype?: string | undefined;
        }[];
    };
}, {
    body: {
        distanceKm: number;
        vehicles: {
            vehicleType: string;
            quantity: number;
            vehicleSubtype?: string | undefined;
        }[];
    };
}>;
/**
 * Schema for vehicle suggestions request
 * Used to recommend the most cost-effective vehicle for cargo
 */
export declare const suggestionsSchema: z.ZodObject<{
    body: z.ZodObject<{
        cargoWeightKg: z.ZodNumber;
        distanceKm: z.ZodNumber;
        trucksNeeded: z.ZodDefault<z.ZodNumber>;
        currentVehicleType: z.ZodOptional<z.ZodString>;
        currentVehicleSubtype: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        trucksNeeded: number;
        distanceKm: number;
        cargoWeightKg: number;
        currentVehicleType?: string | undefined;
        currentVehicleSubtype?: string | undefined;
    }, {
        distanceKm: number;
        cargoWeightKg: number;
        trucksNeeded?: number | undefined;
        currentVehicleType?: string | undefined;
        currentVehicleSubtype?: string | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    body: {
        trucksNeeded: number;
        distanceKm: number;
        cargoWeightKg: number;
        currentVehicleType?: string | undefined;
        currentVehicleSubtype?: string | undefined;
    };
}, {
    body: {
        distanceKm: number;
        cargoWeightKg: number;
        trucksNeeded?: number | undefined;
        currentVehicleType?: string | undefined;
        currentVehicleSubtype?: string | undefined;
    };
}>;
/**
 * Enhanced price estimate response structure
 */
export interface PriceEstimateResponse {
    basePrice: number;
    distanceCharge: number;
    tonnageCharge: number;
    pricePerTruck: number;
    totalPrice: number;
    breakdown: {
        vehicleType: string;
        vehicleSubtype: string;
        distanceKm: number;
        baseRate: number;
        perKmRate: number;
        perTonPerKmRate: number;
        surgeFactor: string;
        distanceSlab: string;
    };
    capacityInfo: {
        capacityKg: number;
        capacityTons: number;
        minTonnage: number;
        maxTonnage: number;
    };
    currency: 'INR';
    validForMinutes: number;
    estimatedAt: string;
}
/**
 * Vehicle suggestion structure
 */
export interface VehicleSuggestion {
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
/**
 * Suggestions response structure
 */
export interface SuggestionsResponse {
    suggestions: VehicleSuggestion[];
    recommendedOption: VehicleSuggestion | null;
    currentOption: VehicleSuggestion | null;
    potentialSavings: number;
}
/**
 * Vehicle pricing catalog entry (enhanced)
 */
export interface VehiclePricingEntry {
    vehicleType: string;
    displayName: string;
    baseRate: number;
    perKmRate: number;
    perTonPerKmRate: number;
    minCharge: number;
    subtypes: string[];
}
export type PriceEstimateInput = z.infer<typeof priceEstimateSchema>['body'];
export type BulkPriceEstimateInput = z.infer<typeof bulkPriceEstimateSchema>['body'];
export type SuggestionsInput = z.infer<typeof suggestionsSchema>['body'];
//# sourceMappingURL=pricing.schema.d.ts.map