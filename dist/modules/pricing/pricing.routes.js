"use strict";
/**
 * =============================================================================
 * PRICING MODULE - ROUTES
 * =============================================================================
 *
 * API routes for price estimation and vehicle suggestions.
 * Enhanced with tonnage-based pricing and smart vehicle recommendations.
 * Designed for easy AWS integration.
 *
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.pricingRouter = void 0;
const express_1 = require("express");
const pricing_service_1 = require("./pricing.service");
const auth_middleware_1 = require("../../shared/middleware/auth.middleware");
const validation_utils_1 = require("../../shared/utils/validation.utils");
const pricing_schema_1 = require("./pricing.schema");
const router = (0, express_1.Router)();
exports.pricingRouter = router;
/**
 * @route   POST /pricing/estimate
 * @desc    Get price estimate for a booking (enhanced with tonnage-based pricing)
 * @access  Authenticated users
 *
 * @body {
 *   vehicleType: string,      // e.g., "tipper", "container"
 *   vehicleSubtype?: string,  // e.g., "20-24 Ton", "32 Feet"
 *   distanceKm: number,       // Distance in kilometers
 *   trucksNeeded: number,     // Number of trucks
 *   cargoWeightKg?: number    // Optional: cargo weight for tonnage-based pricing
 * }
 *
 * @returns {
 *   success: true,
 *   data: {
 *     basePrice: number,
 *     distanceCharge: number,
 *     tonnageCharge: number,
 *     pricePerTruck: number,
 *     totalPrice: number,
 *     breakdown: {...},
 *     capacityInfo: {...},
 *     currency: "INR",
 *     validForMinutes: 15
 *   }
 * }
 */
router.post('/estimate', auth_middleware_1.authMiddleware, (0, validation_utils_1.validateRequest)(pricing_schema_1.priceEstimateSchema), async (req, res, next) => {
    try {
        const { vehicleType, vehicleSubtype, distanceKm, trucksNeeded, cargoWeightKg } = req.body;
        const estimate = pricing_service_1.pricingService.calculateEstimate({
            vehicleType,
            vehicleSubtype,
            distanceKm,
            trucksNeeded,
            cargoWeightKg
        });
        res.json({
            success: true,
            data: estimate
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   POST /pricing/suggestions
 * @desc    Get vehicle suggestions based on cargo weight
 * @access  Authenticated users
 *
 * This endpoint helps customers find the most cost-effective vehicle for their cargo.
 * It returns multiple options sorted by price with potential savings highlighted.
 *
 * @body {
 *   cargoWeightKg: number,          // Cargo weight in kilograms (required)
 *   distanceKm: number,             // Distance in kilometers
 *   trucksNeeded?: number,          // Number of trucks (default: 1)
 *   currentVehicleType?: string,    // Currently selected vehicle type
 *   currentVehicleSubtype?: string  // Currently selected subtype
 * }
 *
 * @returns {
 *   success: true,
 *   data: {
 *     suggestions: [{
 *       vehicleType: string,
 *       vehicleSubtype: string,
 *       displayName: string,
 *       capacityKg: number,
 *       pricePerTruck: number,
 *       totalPrice: number,
 *       savingsAmount: number,
 *       savingsPercent: number,
 *       isRecommended: boolean,
 *       reason: string
 *     }],
 *     recommendedOption: {...} | null,
 *     currentOption: {...} | null,
 *     potentialSavings: number
 *   }
 * }
 */
router.post('/suggestions', auth_middleware_1.authMiddleware, (0, validation_utils_1.validateRequest)(pricing_schema_1.suggestionsSchema), async (req, res, next) => {
    try {
        const { cargoWeightKg, distanceKm, trucksNeeded, currentVehicleType, currentVehicleSubtype } = req.body;
        const suggestions = pricing_service_1.pricingService.getSuggestions({
            cargoWeightKg,
            distanceKm,
            trucksNeeded: trucksNeeded || 1,
            currentVehicleType,
            currentVehicleSubtype
        });
        res.json({
            success: true,
            data: suggestions
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /pricing/catalog
 * @desc    Get vehicle pricing catalog (enhanced with tonnage info)
 * @access  Public (for display purposes)
 *
 * @returns {
 *   success: true,
 *   data: {
 *     vehicles: {
 *       "tipper": {
 *         baseRate: 2500,
 *         perKmRate: 35,
 *         perTonPerKmRate: 3.8,
 *         minCharge: 3000,
 *         displayName: "Tipper",
 *         subtypes: ["9-11 Ton", "15-17 Ton", ...]
 *       },
 *       ...
 *     }
 *   }
 * }
 */
router.get('/catalog', async (_req, res, next) => {
    try {
        const catalog = pricing_service_1.pricingService.getVehiclePricingCatalog();
        res.json({
            success: true,
            data: {
                vehicles: catalog,
                currency: 'INR',
                note: 'Final price includes base rate + distance charge + tonnage charge. Prices may vary based on time and demand.',
                pricingFactors: [
                    'Base rate per vehicle type',
                    'Distance charge (per km rate × distance)',
                    'Tonnage charge (per ton per km rate × tonnage × distance)',
                    'Distance slab multiplier (short haul costs more)',
                    'Surge pricing during peak hours'
                ]
            }
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /pricing/catalog/detailed
 * @desc    Get detailed vehicle catalog with all capacity information
 * @access  Public
 *
 * Returns full vehicle catalog including all subtypes with their
 * tonnage capacities. Useful for vehicle selection screens.
 */
router.get('/catalog/detailed', async (_req, res, next) => {
    try {
        const catalog = pricing_service_1.pricingService.getDetailedCatalog();
        res.json({
            success: true,
            data: catalog
        });
    }
    catch (error) {
        next(error);
    }
});
//# sourceMappingURL=pricing.routes.js.map