/**
 * =============================================================================
 * TRACKING MODULE - VALIDATION SCHEMAS
 * =============================================================================
 */
import { z } from 'zod';
/**
 * Update location request schema
 */
export declare const updateLocationSchema: z.ZodObject<{
    tripId: z.ZodString;
    latitude: z.ZodNumber;
    longitude: z.ZodNumber;
    speed: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    bearing: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
}, "strict", z.ZodTypeAny, {
    tripId: string;
    latitude: number;
    longitude: number;
    speed: number;
    bearing: number;
}, {
    tripId: string;
    latitude: number;
    longitude: number;
    speed?: number | undefined;
    bearing?: number | undefined;
}>;
/**
 * Get tracking query schema
 */
export declare const getTrackingQuerySchema: z.ZodObject<{
    page: z.ZodDefault<z.ZodNumber>;
    limit: z.ZodDefault<z.ZodNumber>;
} & {
    fromTime: z.ZodOptional<z.ZodString>;
    toTime: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    page: number;
    fromTime?: string | undefined;
    toTime?: string | undefined;
}, {
    limit?: number | undefined;
    page?: number | undefined;
    fromTime?: string | undefined;
    toTime?: string | undefined;
}>;
/**
 * Location history query schema
 */
export declare const locationHistoryQuerySchema: z.ZodObject<{
    page: z.ZodDefault<z.ZodNumber>;
    limit: z.ZodDefault<z.ZodNumber>;
} & {
    fromTime: z.ZodOptional<z.ZodString>;
    toTime: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    page: number;
    fromTime?: string | undefined;
    toTime?: string | undefined;
}, {
    limit?: number | undefined;
    page?: number | undefined;
    fromTime?: string | undefined;
    toTime?: string | undefined;
}>;
/**
 * Tracking response type
 */
export interface TrackingResponse {
    tripId: string;
    driverId: string;
    vehicleNumber: string;
    latitude: number;
    longitude: number;
    speed: number;
    bearing: number;
    status: string;
    lastUpdated: string;
}
/**
 * Booking tracking response (multiple trucks)
 */
export interface BookingTrackingResponse {
    bookingId: string;
    trucks: TrackingResponse[];
}
/**
 * Location history entry
 */
export interface LocationHistoryEntry {
    latitude: number;
    longitude: number;
    speed: number;
    timestamp: string;
}
/**
 * Type exports
 */
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;
export type GetTrackingQuery = z.infer<typeof getTrackingQuerySchema>;
//# sourceMappingURL=tracking.schema.d.ts.map