/**
 * =============================================================================
 * VEHICLE MODULE - VALIDATION SCHEMAS
 * =============================================================================
 */
import { z } from 'zod';
export declare const vehicleStatusSchema: z.ZodEnum<["available", "in_transit", "maintenance", "inactive"]>;
/**
 * Register Vehicle Schema
 * Note: transporterId comes from auth token, not request body
 * Using passthrough() to allow extra fields from mobile apps
 */
export declare const registerVehicleSchema: z.ZodObject<{
    vehicleNumber: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
    vehicleType: z.ZodEnum<["mini", "lcv", "tipper", "container", "trailer", "tanker", "bulker", "open", "dumper", "tractor"]>;
    vehicleSubtype: z.ZodString;
    capacity: z.ZodString;
    model: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    year: z.ZodNullable<z.ZodOptional<z.ZodNumber>>;
    rcNumber: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    rcExpiry: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    insuranceNumber: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    insuranceExpiry: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    permitNumber: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    permitExpiry: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    fitnessExpiry: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    vehiclePhotos: z.ZodNullable<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
    rcPhoto: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    insurancePhoto: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    transporterId: z.ZodOptional<z.ZodString>;
    documents: z.ZodOptional<z.ZodAny>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    vehicleNumber: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
    vehicleType: z.ZodEnum<["mini", "lcv", "tipper", "container", "trailer", "tanker", "bulker", "open", "dumper", "tractor"]>;
    vehicleSubtype: z.ZodString;
    capacity: z.ZodString;
    model: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    year: z.ZodNullable<z.ZodOptional<z.ZodNumber>>;
    rcNumber: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    rcExpiry: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    insuranceNumber: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    insuranceExpiry: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    permitNumber: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    permitExpiry: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    fitnessExpiry: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    vehiclePhotos: z.ZodNullable<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
    rcPhoto: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    insurancePhoto: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    transporterId: z.ZodOptional<z.ZodString>;
    documents: z.ZodOptional<z.ZodAny>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    vehicleNumber: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
    vehicleType: z.ZodEnum<["mini", "lcv", "tipper", "container", "trailer", "tanker", "bulker", "open", "dumper", "tractor"]>;
    vehicleSubtype: z.ZodString;
    capacity: z.ZodString;
    model: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    year: z.ZodNullable<z.ZodOptional<z.ZodNumber>>;
    rcNumber: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    rcExpiry: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    insuranceNumber: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    insuranceExpiry: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    permitNumber: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    permitExpiry: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    fitnessExpiry: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    vehiclePhotos: z.ZodNullable<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
    rcPhoto: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    insurancePhoto: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    transporterId: z.ZodOptional<z.ZodString>;
    documents: z.ZodOptional<z.ZodAny>;
}, z.ZodTypeAny, "passthrough">>;
/**
 * Update Vehicle Schema
 */
export declare const updateVehicleSchema: z.ZodObject<{
    vehicleNumber: z.ZodOptional<z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>>;
    vehicleType: z.ZodOptional<z.ZodEnum<["mini", "lcv", "tipper", "container", "trailer", "tanker", "bulker", "open", "dumper", "tractor"]>>;
    vehicleSubtype: z.ZodOptional<z.ZodString>;
    capacity: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    year: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodNumber>>>;
    rcNumber: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    rcExpiry: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    insuranceNumber: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    insuranceExpiry: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    permitNumber: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    permitExpiry: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    fitnessExpiry: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    vehiclePhotos: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>>;
    rcPhoto: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    insurancePhoto: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    transporterId: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    documents: z.ZodOptional<z.ZodOptional<z.ZodAny>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    vehicleNumber: z.ZodOptional<z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>>;
    vehicleType: z.ZodOptional<z.ZodEnum<["mini", "lcv", "tipper", "container", "trailer", "tanker", "bulker", "open", "dumper", "tractor"]>>;
    vehicleSubtype: z.ZodOptional<z.ZodString>;
    capacity: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    year: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodNumber>>>;
    rcNumber: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    rcExpiry: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    insuranceNumber: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    insuranceExpiry: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    permitNumber: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    permitExpiry: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    fitnessExpiry: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    vehiclePhotos: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>>;
    rcPhoto: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    insurancePhoto: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    transporterId: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    documents: z.ZodOptional<z.ZodOptional<z.ZodAny>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    vehicleNumber: z.ZodOptional<z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>>;
    vehicleType: z.ZodOptional<z.ZodEnum<["mini", "lcv", "tipper", "container", "trailer", "tanker", "bulker", "open", "dumper", "tractor"]>>;
    vehicleSubtype: z.ZodOptional<z.ZodString>;
    capacity: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    year: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodNumber>>>;
    rcNumber: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    rcExpiry: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    insuranceNumber: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    insuranceExpiry: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    permitNumber: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    permitExpiry: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    fitnessExpiry: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    vehiclePhotos: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>>;
    rcPhoto: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    insurancePhoto: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
    transporterId: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    documents: z.ZodOptional<z.ZodOptional<z.ZodAny>>;
}, z.ZodTypeAny, "passthrough">>;
/**
 * Assign Driver to Vehicle
 */
export declare const assignDriverSchema: z.ZodObject<{
    driverId: z.ZodString;
}, "strict", z.ZodTypeAny, {
    driverId: string;
}, {
    driverId: string;
}>;
/**
 * Get Vehicles Query
 */
export declare const getVehiclesQuerySchema: z.ZodObject<{
    page: z.ZodDefault<z.ZodNumber>;
    limit: z.ZodDefault<z.ZodNumber>;
} & {
    vehicleType: z.ZodOptional<z.ZodEnum<["mini", "lcv", "tipper", "container", "trailer", "tanker", "bulker", "open", "dumper", "tractor"]>>;
    status: z.ZodOptional<z.ZodEnum<["available", "in_transit", "maintenance", "inactive"]>>;
    isActive: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    page: number;
    isActive?: boolean | undefined;
    vehicleType?: "mini" | "lcv" | "tipper" | "container" | "trailer" | "tanker" | "bulker" | "open" | "dumper" | "tractor" | undefined;
    status?: "available" | "in_transit" | "maintenance" | "inactive" | undefined;
}, {
    limit?: number | undefined;
    isActive?: boolean | undefined;
    vehicleType?: "mini" | "lcv" | "tipper" | "container" | "trailer" | "tanker" | "bulker" | "open" | "dumper" | "tractor" | undefined;
    status?: "available" | "in_transit" | "maintenance" | "inactive" | undefined;
    page?: number | undefined;
}>;
/**
 * Update Vehicle Status Schema
 */
export declare const updateStatusSchema: z.ZodObject<{
    status: z.ZodEnum<["available", "in_transit", "maintenance", "inactive"]>;
    tripId: z.ZodOptional<z.ZodString>;
    maintenanceReason: z.ZodOptional<z.ZodString>;
    maintenanceEndDate: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "available" | "in_transit" | "maintenance" | "inactive";
    maintenanceReason?: string | undefined;
    maintenanceEndDate?: string | undefined;
    tripId?: string | undefined;
}, {
    status: "available" | "in_transit" | "maintenance" | "inactive";
    maintenanceReason?: string | undefined;
    maintenanceEndDate?: string | undefined;
    tripId?: string | undefined;
}>;
/**
 * Set Maintenance Schema
 */
export declare const setMaintenanceSchema: z.ZodObject<{
    reason: z.ZodString;
    expectedEndDate: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    reason: string;
    expectedEndDate?: string | undefined;
}, {
    reason: string;
    expectedEndDate?: string | undefined;
}>;
/**
 * Pricing Query Schema
 */
export declare const pricingQuerySchema: z.ZodObject<{
    vehicleType: z.ZodEnum<["mini", "lcv", "tipper", "container", "trailer", "tanker", "bulker", "open", "dumper", "tractor"]>;
    distanceKm: z.ZodNumber;
    trucksNeeded: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    vehicleType: "mini" | "lcv" | "tipper" | "container" | "trailer" | "tanker" | "bulker" | "open" | "dumper" | "tractor";
    distanceKm: number;
    trucksNeeded?: number | undefined;
}, {
    vehicleType: "mini" | "lcv" | "tipper" | "container" | "trailer" | "tanker" | "bulker" | "open" | "dumper" | "tractor";
    distanceKm: number;
    trucksNeeded?: number | undefined;
}>;
export type RegisterVehicleInput = z.infer<typeof registerVehicleSchema>;
export type UpdateVehicleInput = z.infer<typeof updateVehicleSchema>;
export type AssignDriverInput = z.infer<typeof assignDriverSchema>;
export type GetVehiclesQuery = z.infer<typeof getVehiclesQuerySchema>;
export type PricingQuery = z.infer<typeof pricingQuerySchema>;
//# sourceMappingURL=vehicle.schema.d.ts.map