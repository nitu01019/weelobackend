/**
 * =============================================================================
 * BROADCAST MODULE - SCHEMA
 * =============================================================================
 *
 * Zod validation schemas for broadcast-related API requests.
 * Broadcasts are booking notifications sent to available transporters/drivers.
 * =============================================================================
 */
import { z } from 'zod';
/**
 * Schema for getting broadcasts with filters
 */
export declare const getBroadcastsQuerySchema: z.ZodObject<{
    status: z.ZodOptional<z.ZodEnum<["pending", "accepted", "expired", "cancelled"]>>;
    vehicleType: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodOptional<z.ZodPipeline<z.ZodEffects<z.ZodString, number, string>, z.ZodNumber>>>;
    offset: z.ZodDefault<z.ZodOptional<z.ZodPipeline<z.ZodEffects<z.ZodString, number, string>, z.ZodNumber>>>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    offset: number;
    vehicleType?: string | undefined;
    status?: "cancelled" | "expired" | "accepted" | "pending" | undefined;
}, {
    limit?: string | undefined;
    vehicleType?: string | undefined;
    status?: "cancelled" | "expired" | "accepted" | "pending" | undefined;
    offset?: string | undefined;
}>;
/**
 * Schema for accepting a broadcast
 */
export declare const acceptBroadcastSchema: z.ZodObject<{
    body: z.ZodObject<{
        broadcastId: z.ZodString;
        vehicleId: z.ZodString;
        driverId: z.ZodOptional<z.ZodString>;
        estimatedArrival: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        vehicleId: string;
        broadcastId: string;
        driverId?: string | undefined;
        estimatedArrival?: number | undefined;
    }, {
        vehicleId: string;
        broadcastId: string;
        driverId?: string | undefined;
        estimatedArrival?: number | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    body: {
        vehicleId: string;
        broadcastId: string;
        driverId?: string | undefined;
        estimatedArrival?: number | undefined;
    };
}, {
    body: {
        vehicleId: string;
        broadcastId: string;
        driverId?: string | undefined;
        estimatedArrival?: number | undefined;
    };
}>;
/**
 * Schema for rejecting a broadcast
 */
export declare const rejectBroadcastSchema: z.ZodObject<{
    body: z.ZodObject<{
        broadcastId: z.ZodString;
        reason: z.ZodOptional<z.ZodEnum<["no_vehicle_available", "too_far", "price_too_low", "schedule_conflict", "other"]>>;
        notes: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        broadcastId: string;
        reason?: "no_vehicle_available" | "too_far" | "price_too_low" | "schedule_conflict" | "other" | undefined;
        notes?: string | undefined;
    }, {
        broadcastId: string;
        reason?: "no_vehicle_available" | "too_far" | "price_too_low" | "schedule_conflict" | "other" | undefined;
        notes?: string | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    body: {
        broadcastId: string;
        reason?: "no_vehicle_available" | "too_far" | "price_too_low" | "schedule_conflict" | "other" | undefined;
        notes?: string | undefined;
    };
}, {
    body: {
        broadcastId: string;
        reason?: "no_vehicle_available" | "too_far" | "price_too_low" | "schedule_conflict" | "other" | undefined;
        notes?: string | undefined;
    };
}>;
/**
 * Schema for creating a broadcast (internal - from booking)
 */
export declare const createBroadcastSchema: z.ZodObject<{
    body: z.ZodObject<{
        bookingId: z.ZodString;
        vehicleType: z.ZodString;
        vehicleSubtype: z.ZodOptional<z.ZodString>;
        pickup: z.ZodObject<{
            address: z.ZodString;
            latitude: z.ZodNumber;
            longitude: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            latitude: number;
            longitude: number;
            address: string;
        }, {
            latitude: number;
            longitude: number;
            address: string;
        }>;
        drop: z.ZodObject<{
            address: z.ZodString;
            latitude: z.ZodNumber;
            longitude: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            latitude: number;
            longitude: number;
            address: string;
        }, {
            latitude: number;
            longitude: number;
            address: string;
        }>;
        trucksNeeded: z.ZodNumber;
        estimatedPrice: z.ZodNumber;
        expiresAt: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        vehicleType: string;
        pickup: {
            latitude: number;
            longitude: number;
            address: string;
        };
        drop: {
            latitude: number;
            longitude: number;
            address: string;
        };
        trucksNeeded: number;
        bookingId: string;
        estimatedPrice: number;
        vehicleSubtype?: string | undefined;
        expiresAt?: string | undefined;
    }, {
        vehicleType: string;
        pickup: {
            latitude: number;
            longitude: number;
            address: string;
        };
        drop: {
            latitude: number;
            longitude: number;
            address: string;
        };
        trucksNeeded: number;
        bookingId: string;
        estimatedPrice: number;
        vehicleSubtype?: string | undefined;
        expiresAt?: string | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    body: {
        vehicleType: string;
        pickup: {
            latitude: number;
            longitude: number;
            address: string;
        };
        drop: {
            latitude: number;
            longitude: number;
            address: string;
        };
        trucksNeeded: number;
        bookingId: string;
        estimatedPrice: number;
        vehicleSubtype?: string | undefined;
        expiresAt?: string | undefined;
    };
}, {
    body: {
        vehicleType: string;
        pickup: {
            latitude: number;
            longitude: number;
            address: string;
        };
        drop: {
            latitude: number;
            longitude: number;
            address: string;
        };
        trucksNeeded: number;
        bookingId: string;
        estimatedPrice: number;
        vehicleSubtype?: string | undefined;
        expiresAt?: string | undefined;
    };
}>;
export type GetBroadcastsQuery = z.infer<typeof getBroadcastsQuerySchema>;
export type AcceptBroadcastInput = z.infer<typeof acceptBroadcastSchema>['body'];
export type RejectBroadcastInput = z.infer<typeof rejectBroadcastSchema>['body'];
export type CreateBroadcastInput = z.infer<typeof createBroadcastSchema>['body'];
//# sourceMappingURL=broadcast.schema.d.ts.map