"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.suggestionsSchema = exports.bulkPriceEstimateSchema = exports.priceEstimateSchema = exports.VALID_VEHICLE_TYPES = void 0;
const zod_1 = require("zod");
// =============================================================================
// VEHICLE TYPES (for validation)
// =============================================================================
exports.VALID_VEHICLE_TYPES = [
    'mini',
    'lcv',
    'open',
    'tipper',
    'dumper',
    'container',
    'trailer',
    'tanker',
    'bulker'
];
// =============================================================================
// REQUEST SCHEMAS
// =============================================================================
/**
 * Schema for price estimate request
 * Enhanced with optional cargo weight for tonnage-based pricing
 */
exports.priceEstimateSchema = zod_1.z.object({
    body: zod_1.z.object({
        vehicleType: zod_1.z.string().min(1, 'Vehicle type is required'),
        vehicleSubtype: zod_1.z.string().optional(),
        distanceKm: zod_1.z.number({
            required_error: 'Distance is required',
            invalid_type_error: 'Distance must be a number'
        }).min(1, 'Distance must be at least 1 km').max(5000, 'Distance cannot exceed 5000 km'),
        trucksNeeded: zod_1.z.number({
            required_error: 'Number of trucks is required',
            invalid_type_error: 'Trucks needed must be a number'
        }).int('Must be a whole number').min(1, 'At least 1 truck required').max(50, 'Max 50 trucks per booking'),
        cargoWeightKg: zod_1.z.number({
            invalid_type_error: 'Cargo weight must be a number'
        }).min(1, 'Cargo weight must be at least 1 kg').max(100000, 'Cargo weight cannot exceed 100 tons').optional()
    })
});
/**
 * Schema for bulk pricing request (multiple vehicle types)
 */
exports.bulkPriceEstimateSchema = zod_1.z.object({
    body: zod_1.z.object({
        distanceKm: zod_1.z.number().min(1).max(5000),
        vehicles: zod_1.z.array(zod_1.z.object({
            vehicleType: zod_1.z.string().min(1),
            vehicleSubtype: zod_1.z.string().optional(),
            quantity: zod_1.z.number().int().min(1).max(50)
        })).min(1, 'At least one vehicle required').max(10, 'Max 10 different vehicle types')
    })
});
/**
 * Schema for vehicle suggestions request
 * Used to recommend the most cost-effective vehicle for cargo
 */
exports.suggestionsSchema = zod_1.z.object({
    body: zod_1.z.object({
        cargoWeightKg: zod_1.z.number({
            required_error: 'Cargo weight is required for suggestions',
            invalid_type_error: 'Cargo weight must be a number'
        }).min(100, 'Cargo weight must be at least 100 kg').max(100000, 'Cargo weight cannot exceed 100 tons'),
        distanceKm: zod_1.z.number({
            required_error: 'Distance is required',
            invalid_type_error: 'Distance must be a number'
        }).min(1, 'Distance must be at least 1 km').max(5000, 'Distance cannot exceed 5000 km'),
        trucksNeeded: zod_1.z.number({
            invalid_type_error: 'Trucks needed must be a number'
        }).int('Must be a whole number').min(1, 'At least 1 truck required').max(50, 'Max 50 trucks').default(1),
        currentVehicleType: zod_1.z.string().optional(),
        currentVehicleSubtype: zod_1.z.string().optional()
    })
});
//# sourceMappingURL=pricing.schema.js.map