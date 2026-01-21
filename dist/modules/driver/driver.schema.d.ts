/**
 * =============================================================================
 * DRIVER MODULE - SCHEMA
 * =============================================================================
 *
 * Zod validation schemas for driver-related API requests.
 * Ensures type safety and input validation.
 * =============================================================================
 */
import { z } from 'zod';
/**
 * Schema for updating driver availability
 */
export declare const updateAvailabilitySchema: z.ZodObject<{
    body: z.ZodObject<{
        isOnline: z.ZodBoolean;
        currentLocation: z.ZodOptional<z.ZodObject<{
            latitude: z.ZodNumber;
            longitude: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            latitude: number;
            longitude: number;
        }, {
            latitude: number;
            longitude: number;
        }>>;
    }, "strip", z.ZodTypeAny, {
        isOnline: boolean;
        currentLocation?: {
            latitude: number;
            longitude: number;
        } | undefined;
    }, {
        isOnline: boolean;
        currentLocation?: {
            latitude: number;
            longitude: number;
        } | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    body: {
        isOnline: boolean;
        currentLocation?: {
            latitude: number;
            longitude: number;
        } | undefined;
    };
}, {
    body: {
        isOnline: boolean;
        currentLocation?: {
            latitude: number;
            longitude: number;
        } | undefined;
    };
}>;
/**
 * Schema for getting driver trips with filters
 */
export declare const getTripsQuerySchema: z.ZodObject<{
    status: z.ZodOptional<z.ZodEnum<["pending", "active", "completed", "cancelled"]>>;
    limit: z.ZodDefault<z.ZodOptional<z.ZodPipeline<z.ZodEffects<z.ZodString, number, string>, z.ZodNumber>>>;
    offset: z.ZodDefault<z.ZodOptional<z.ZodPipeline<z.ZodEffects<z.ZodString, number, string>, z.ZodNumber>>>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    offset: number;
    status?: "active" | "completed" | "cancelled" | "pending" | undefined;
}, {
    limit?: string | undefined;
    status?: "active" | "completed" | "cancelled" | "pending" | undefined;
    offset?: string | undefined;
}>;
/**
 * Schema for getting earnings with period filter
 */
export declare const getEarningsQuerySchema: z.ZodObject<{
    period: z.ZodDefault<z.ZodOptional<z.ZodEnum<["today", "week", "month", "year"]>>>;
}, "strip", z.ZodTypeAny, {
    period: "year" | "week" | "today" | "month";
}, {
    period?: "year" | "week" | "today" | "month" | undefined;
}>;
/**
 * Schema for updating trip status by driver
 */
export declare const updateTripStatusSchema: z.ZodObject<{
    body: z.ZodObject<{
        tripId: z.ZodString;
        status: z.ZodEnum<["started", "arrived_pickup", "loaded", "in_transit", "arrived_drop", "completed"]>;
        notes: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        status: "in_transit" | "completed" | "started" | "arrived_pickup" | "loaded" | "arrived_drop";
        tripId: string;
        notes?: string | undefined;
    }, {
        status: "in_transit" | "completed" | "started" | "arrived_pickup" | "loaded" | "arrived_drop";
        tripId: string;
        notes?: string | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    body: {
        status: "in_transit" | "completed" | "started" | "arrived_pickup" | "loaded" | "arrived_drop";
        tripId: string;
        notes?: string | undefined;
    };
}, {
    body: {
        status: "in_transit" | "completed" | "started" | "arrived_pickup" | "loaded" | "arrived_drop";
        tripId: string;
        notes?: string | undefined;
    };
}>;
/**
 * Schema for transporter creating a driver
 */
export declare const createDriverSchema: z.ZodObject<{
    phone: z.ZodString;
    name: z.ZodString;
    licenseNumber: z.ZodString;
    email: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    emergencyContact: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    address: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    aadharNumber: z.ZodNullable<z.ZodOptional<z.ZodString>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    phone: z.ZodString;
    name: z.ZodString;
    licenseNumber: z.ZodString;
    email: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    emergencyContact: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    address: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    aadharNumber: z.ZodNullable<z.ZodOptional<z.ZodString>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    phone: z.ZodString;
    name: z.ZodString;
    licenseNumber: z.ZodString;
    email: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    emergencyContact: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    address: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    aadharNumber: z.ZodNullable<z.ZodOptional<z.ZodString>>;
}, z.ZodTypeAny, "passthrough">>;
export type UpdateAvailabilityInput = z.infer<typeof updateAvailabilitySchema>['body'];
export type GetTripsQuery = z.infer<typeof getTripsQuerySchema>;
export type GetEarningsQuery = z.infer<typeof getEarningsQuerySchema>;
export type UpdateTripStatusInput = z.infer<typeof updateTripStatusSchema>['body'];
export type CreateDriverInput = z.infer<typeof createDriverSchema>;
//# sourceMappingURL=driver.schema.d.ts.map