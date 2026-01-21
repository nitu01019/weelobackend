/**
 * =============================================================================
 * ASSIGNMENT MODULE - VALIDATION SCHEMAS
 * =============================================================================
 */
import { z } from 'zod';
/**
 * Create Assignment Schema (Transporter assigns truck)
 */
export declare const createAssignmentSchema: z.ZodObject<{
    bookingId: z.ZodString;
    vehicleId: z.ZodString;
    driverId: z.ZodString;
}, "strict", z.ZodTypeAny, {
    bookingId: string;
    vehicleId: string;
    driverId: string;
}, {
    bookingId: string;
    vehicleId: string;
    driverId: string;
}>;
/**
 * Update Status Schema
 */
export declare const updateStatusSchema: z.ZodObject<{
    status: z.ZodEnum<["pending", "driver_accepted", "en_route_pickup", "at_pickup", "in_transit", "completed", "cancelled"]>;
    notes: z.ZodOptional<z.ZodString>;
    location: z.ZodOptional<z.ZodObject<{
        latitude: z.ZodNumber;
        longitude: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        latitude: number;
        longitude: number;
    }, {
        latitude: number;
        longitude: number;
    }>>;
}, "strict", z.ZodTypeAny, {
    status: "in_transit" | "completed" | "cancelled" | "pending" | "driver_accepted" | "en_route_pickup" | "at_pickup";
    notes?: string | undefined;
    location?: {
        latitude: number;
        longitude: number;
    } | undefined;
}, {
    status: "in_transit" | "completed" | "cancelled" | "pending" | "driver_accepted" | "en_route_pickup" | "at_pickup";
    notes?: string | undefined;
    location?: {
        latitude: number;
        longitude: number;
    } | undefined;
}>;
/**
 * Get Assignments Query Schema
 */
export declare const getAssignmentsQuerySchema: z.ZodObject<{
    page: z.ZodDefault<z.ZodNumber>;
    limit: z.ZodDefault<z.ZodNumber>;
} & {
    status: z.ZodOptional<z.ZodEnum<["pending", "driver_accepted", "en_route_pickup", "at_pickup", "in_transit", "completed", "cancelled"]>>;
    bookingId: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    page: number;
    status?: "in_transit" | "completed" | "cancelled" | "pending" | "driver_accepted" | "en_route_pickup" | "at_pickup" | undefined;
    bookingId?: string | undefined;
}, {
    limit?: number | undefined;
    status?: "in_transit" | "completed" | "cancelled" | "pending" | "driver_accepted" | "en_route_pickup" | "at_pickup" | undefined;
    bookingId?: string | undefined;
    page?: number | undefined;
}>;
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;
export type UpdateStatusInput = z.infer<typeof updateStatusSchema>;
export type GetAssignmentsQuery = z.infer<typeof getAssignmentsQuerySchema>;
//# sourceMappingURL=assignment.schema.d.ts.map