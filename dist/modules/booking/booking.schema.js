"use strict";
/**
 * =============================================================================
 * BOOKING MODULE - VALIDATION SCHEMAS
 * =============================================================================
 *
 * NEW ARCHITECTURE: Multi-Truck Request System
 *
 * Order (Parent) → TruckRequests (Children)
 *
 * Customer selects: 2x Open 17ft + 3x Container 4ton
 * System creates: 1 Order with 5 TruckRequests
 * Each TruckRequest is broadcast to matching transporters
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOrderQuerySchema = exports.getBookingsQuerySchema = exports.createOrderSchema = exports.createBookingSchema = exports.truckSelectionSchema = void 0;
const zod_1 = require("zod");
const validation_utils_1 = require("../../shared/utils/validation.utils");
/**
 * Individual Truck Selection (from customer)
 */
exports.truckSelectionSchema = zod_1.z.object({
    vehicleType: validation_utils_1.vehicleTypeSchema,
    vehicleSubtype: zod_1.z.string().min(2).max(50),
    quantity: zod_1.z.number().int().min(1).max(20),
    pricePerTruck: zod_1.z.number().int().min(1)
});
/**
 * Create Booking Schema (LEGACY - Single truck type)
 * Kept for backward compatibility
 */
exports.createBookingSchema = zod_1.z.object({
    pickup: validation_utils_1.locationSchema,
    drop: validation_utils_1.locationSchema,
    vehicleType: validation_utils_1.vehicleTypeSchema,
    vehicleSubtype: zod_1.z.string().min(2).max(50),
    trucksNeeded: zod_1.z.number().int().min(1).max(100),
    distanceKm: zod_1.z.number().int().min(1),
    pricePerTruck: zod_1.z.number().int().min(1),
    goodsType: zod_1.z.string().max(100).optional(),
    weight: zod_1.z.string().max(50).optional(),
    cargoWeightKg: zod_1.z.number().int().min(0).max(100000).optional(),
    capacityInfo: zod_1.z.object({
        capacityKg: zod_1.z.number().int().optional(),
        capacityTons: zod_1.z.number().optional(),
        minTonnage: zod_1.z.number().optional(),
        maxTonnage: zod_1.z.number().optional()
    }).optional(),
    scheduledAt: zod_1.z.string().datetime().optional(),
    notes: zod_1.z.string().max(500).optional()
});
/**
 * Create Order Schema (NEW - Multi-truck types)
 *
 * This is the primary schema for creating bookings with multiple truck types.
 * Each truck selection expands into individual TruckRequests.
 */
exports.createOrderSchema = zod_1.z.object({
    pickup: validation_utils_1.locationSchema,
    drop: validation_utils_1.locationSchema,
    distanceKm: zod_1.z.number().int().min(1),
    // Array of truck selections - each type/subtype with quantity
    trucks: zod_1.z.array(exports.truckSelectionSchema).min(1).max(50),
    // Goods info (applies to all trucks in order)
    goodsType: zod_1.z.string().max(100).optional(),
    weight: zod_1.z.string().max(50).optional(),
    cargoWeightKg: zod_1.z.number().int().min(0).max(100000).optional(),
    // Scheduling
    scheduledAt: zod_1.z.string().datetime().optional(),
    notes: zod_1.z.string().max(500).optional()
});
/**
 * Get Bookings Query Schema
 */
exports.getBookingsQuerySchema = validation_utils_1.paginationSchema.extend({
    status: validation_utils_1.bookingStatusSchema.optional()
});
/**
 * Get Order Query Schema
 */
exports.getOrderQuerySchema = zod_1.z.object({
    orderId: zod_1.z.string().uuid()
});
//# sourceMappingURL=booking.schema.js.map