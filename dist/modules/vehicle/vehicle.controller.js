"use strict";
/**
 * =============================================================================
 * VEHICLE MODULE - CONTROLLER
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.vehicleController = void 0;
const vehicle_service_1 = require("./vehicle.service");
const vehicle_schema_1 = require("./vehicle.schema");
const validation_utils_1 = require("../../shared/utils/validation.utils");
const api_types_1 = require("../../shared/types/api.types");
const error_middleware_1 = require("../../shared/middleware/error.middleware");
class VehicleController {
    /**
     * Get vehicle types catalog
     */
    getVehicleTypes = (0, error_middleware_1.asyncHandler)(async (_req, res, _next) => {
        const types = await vehicle_service_1.vehicleService.getVehicleTypes();
        res.json((0, api_types_1.successResponse)({ types }));
    });
    /**
     * Calculate pricing for a route
     */
    calculatePricing = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const query = (0, validation_utils_1.validateSchema)(vehicle_schema_1.pricingQuerySchema, req.query);
        const pricing = await vehicle_service_1.vehicleService.calculatePricing({
            ...query,
            trucksNeeded: query.trucksNeeded ?? 1
        });
        res.json((0, api_types_1.successResponse)({ pricing }));
    });
    /**
     * Register a new vehicle
     */
    registerVehicle = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const transporterId = req.userId;
        const data = (0, validation_utils_1.validateSchema)(vehicle_schema_1.registerVehicleSchema, req.body);
        const vehicle = await vehicle_service_1.vehicleService.registerVehicle(transporterId, data);
        res.status(201).json((0, api_types_1.successResponse)({ vehicle }));
    });
    /**
     * Get transporter's vehicles
     */
    getMyVehicles = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const transporterId = req.userId;
        const query = (0, validation_utils_1.validateSchema)(vehicle_schema_1.getVehiclesQuerySchema, req.query);
        const result = await vehicle_service_1.vehicleService.getTransporterVehicles(transporterId, {
            ...query,
            page: query.page ?? 1,
            limit: query.limit ?? 20
        });
        res.json((0, api_types_1.successResponse)(result.vehicles, {
            page: query.page ?? 1,
            limit: query.limit ?? 20,
            total: result.total,
            hasMore: result.hasMore
        }));
    });
    /**
     * Get vehicle by ID
     */
    getVehicleById = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const { id } = req.params;
        const vehicle = await vehicle_service_1.vehicleService.getVehicleById(id);
        res.json((0, api_types_1.successResponse)({ vehicle }));
    });
    /**
     * Update vehicle
     */
    updateVehicle = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const { id } = req.params;
        const transporterId = req.userId;
        const data = (0, validation_utils_1.validateSchema)(vehicle_schema_1.updateVehicleSchema, req.body);
        const vehicle = await vehicle_service_1.vehicleService.updateVehicle(id, transporterId, data);
        res.json((0, api_types_1.successResponse)({ vehicle }));
    });
    /**
     * Delete vehicle
     */
    deleteVehicle = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const { id } = req.params;
        const transporterId = req.userId;
        await vehicle_service_1.vehicleService.deleteVehicle(id, transporterId);
        res.json((0, api_types_1.successResponse)({ message: 'Vehicle deleted successfully' }));
    });
}
exports.vehicleController = new VehicleController();
//# sourceMappingURL=vehicle.controller.js.map