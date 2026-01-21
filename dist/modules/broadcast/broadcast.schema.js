"use strict";
/**
 * =============================================================================
 * BROADCAST MODULE - SCHEMA
 * =============================================================================
 *
 * Zod validation schemas for broadcast-related API requests.
 * Broadcasts are booking notifications sent to available transporters/drivers.
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBroadcastSchema = exports.rejectBroadcastSchema = exports.acceptBroadcastSchema = exports.getBroadcastsQuerySchema = void 0;
const zod_1 = require("zod");
// =============================================================================
// REQUEST SCHEMAS
// =============================================================================
/**
 * Schema for getting broadcasts with filters
 */
exports.getBroadcastsQuerySchema = zod_1.z.object({
    status: zod_1.z.enum(['pending', 'accepted', 'expired', 'cancelled']).optional(),
    vehicleType: zod_1.z.string().optional(),
    limit: zod_1.z.string().transform(Number).pipe(zod_1.z.number().int().min(1).max(100)).optional().default('20'),
    offset: zod_1.z.string().transform(Number).pipe(zod_1.z.number().int().min(0)).optional().default('0')
});
/**
 * Schema for accepting a broadcast
 */
exports.acceptBroadcastSchema = zod_1.z.object({
    body: zod_1.z.object({
        broadcastId: zod_1.z.string().uuid('Invalid broadcast ID'),
        vehicleId: zod_1.z.string().uuid('Invalid vehicle ID'),
        driverId: zod_1.z.string().uuid('Invalid driver ID').optional(),
        estimatedArrival: zod_1.z.number().int().min(5).max(480).optional() // Minutes, 5 min to 8 hours
    })
});
/**
 * Schema for rejecting a broadcast
 */
exports.rejectBroadcastSchema = zod_1.z.object({
    body: zod_1.z.object({
        broadcastId: zod_1.z.string().uuid('Invalid broadcast ID'),
        reason: zod_1.z.enum([
            'no_vehicle_available',
            'too_far',
            'price_too_low',
            'schedule_conflict',
            'other'
        ]).optional(),
        notes: zod_1.z.string().max(500).optional()
    })
});
/**
 * Schema for creating a broadcast (internal - from booking)
 */
exports.createBroadcastSchema = zod_1.z.object({
    body: zod_1.z.object({
        bookingId: zod_1.z.string().uuid('Invalid booking ID'),
        vehicleType: zod_1.z.string().min(1, 'Vehicle type is required'),
        vehicleSubtype: zod_1.z.string().optional(),
        pickup: zod_1.z.object({
            address: zod_1.z.string().min(1),
            latitude: zod_1.z.number().min(-90).max(90),
            longitude: zod_1.z.number().min(-180).max(180)
        }),
        drop: zod_1.z.object({
            address: zod_1.z.string().min(1),
            latitude: zod_1.z.number().min(-90).max(90),
            longitude: zod_1.z.number().min(-180).max(180)
        }),
        trucksNeeded: zod_1.z.number().int().min(1).max(50),
        estimatedPrice: zod_1.z.number().min(0),
        expiresAt: zod_1.z.string().datetime().optional()
    })
});
//# sourceMappingURL=broadcast.schema.js.map