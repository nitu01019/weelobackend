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

// =============================================================================
// VEHICLE TYPES (for validation)
// =============================================================================

export const VALID_VEHICLE_TYPES = [
  'mini',
  'lcv',
  'open',
  'tipper',
  'dumper',
  'container',
  'trailer',
  'tanker',
  'bulker'
] as const;

// =============================================================================
// REQUEST SCHEMAS
// =============================================================================

/**
 * Schema for price estimate request
 * Enhanced with optional cargo weight for tonnage-based pricing
 */
export const priceEstimateSchema = z.object({
  body: z.object({
    vehicleType: z.string().min(1, 'Vehicle type is required'),
    vehicleSubtype: z.string().optional(),
    distanceKm: z.number({
      required_error: 'Distance is required',
      invalid_type_error: 'Distance must be a number'
    }).min(1, 'Distance must be at least 1 km').max(5000, 'Distance cannot exceed 5000 km'),
    trucksNeeded: z.number({
      required_error: 'Number of trucks is required',
      invalid_type_error: 'Trucks needed must be a number'
    }).int('Must be a whole number').min(1, 'At least 1 truck required').max(50, 'Max 50 trucks per booking'),
    cargoWeightKg: z.number({
      invalid_type_error: 'Cargo weight must be a number'
    }).min(1, 'Cargo weight must be at least 1 kg').max(100000, 'Cargo weight cannot exceed 100 tons').optional()
  })
});

/**
 * Schema for bulk pricing request (multiple vehicle types)
 */
export const bulkPriceEstimateSchema = z.object({
  body: z.object({
    distanceKm: z.number().min(1).max(5000),
    vehicles: z.array(z.object({
      vehicleType: z.string().min(1),
      vehicleSubtype: z.string().optional(),
      quantity: z.number().int().min(1).max(50)
    })).min(1, 'At least one vehicle required').max(10, 'Max 10 different vehicle types')
  })
});

/**
 * Schema for vehicle suggestions request
 * Used to recommend the most cost-effective vehicle for cargo
 */
export const suggestionsSchema = z.object({
  body: z.object({
    cargoWeightKg: z.number({
      required_error: 'Cargo weight is required for suggestions',
      invalid_type_error: 'Cargo weight must be a number'
    }).min(100, 'Cargo weight must be at least 100 kg').max(100000, 'Cargo weight cannot exceed 100 tons'),
    distanceKm: z.number({
      required_error: 'Distance is required',
      invalid_type_error: 'Distance must be a number'
    }).min(1, 'Distance must be at least 1 km').max(5000, 'Distance cannot exceed 5000 km'),
    trucksNeeded: z.number({
      invalid_type_error: 'Trucks needed must be a number'
    }).int('Must be a whole number').min(1, 'At least 1 truck required').max(50, 'Max 50 trucks').default(1),
    currentVehicleType: z.string().optional(),
    currentVehicleSubtype: z.string().optional()
  })
});

// =============================================================================
// RESPONSE TYPES
// =============================================================================

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

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type PriceEstimateInput = z.infer<typeof priceEstimateSchema>['body'];
export type BulkPriceEstimateInput = z.infer<typeof bulkPriceEstimateSchema>['body'];
export type SuggestionsInput = z.infer<typeof suggestionsSchema>['body'];
