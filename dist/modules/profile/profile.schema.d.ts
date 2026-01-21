/**
 * =============================================================================
 * PROFILE MODULE - VALIDATION SCHEMAS
 * =============================================================================
 */
import { z } from 'zod';
/**
 * Create/Update Customer Profile
 */
export declare const customerProfileSchema: z.ZodObject<{
    name: z.ZodString;
    email: z.ZodOptional<z.ZodString>;
    profilePhoto: z.ZodOptional<z.ZodString>;
    company: z.ZodOptional<z.ZodString>;
    gstNumber: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    name: string;
    email?: string | undefined;
    profilePhoto?: string | undefined;
    company?: string | undefined;
    gstNumber?: string | undefined;
}, {
    name: string;
    email?: string | undefined;
    profilePhoto?: string | undefined;
    company?: string | undefined;
    gstNumber?: string | undefined;
}>;
/**
 * Create/Update Transporter Profile
 * Accepts both 'company' and 'businessName' for flexibility
 */
export declare const transporterProfileSchema: z.ZodObject<{
    name: z.ZodString;
    email: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    profilePhoto: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    company: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    businessName: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    businessAddress: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    address: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    panNumber: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    gstNumber: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    city: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    state: z.ZodNullable<z.ZodOptional<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    name: string;
    email?: string | null | undefined;
    profilePhoto?: string | null | undefined;
    company?: string | null | undefined;
    gstNumber?: string | null | undefined;
    businessName?: string | null | undefined;
    businessAddress?: string | null | undefined;
    panNumber?: string | null | undefined;
    address?: string | null | undefined;
    city?: string | null | undefined;
    state?: string | null | undefined;
}, {
    name: string;
    email?: string | null | undefined;
    profilePhoto?: string | null | undefined;
    company?: string | null | undefined;
    gstNumber?: string | null | undefined;
    businessName?: string | null | undefined;
    businessAddress?: string | null | undefined;
    panNumber?: string | null | undefined;
    address?: string | null | undefined;
    city?: string | null | undefined;
    state?: string | null | undefined;
}>;
/**
 * Create/Update Driver Profile
 */
export declare const driverProfileSchema: z.ZodObject<{
    name: z.ZodString;
    email: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    profilePhoto: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    licenseNumber: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    licenseExpiry: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    aadharNumber: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    emergencyContact: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    address: z.ZodNullable<z.ZodOptional<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    name: string;
    email?: string | null | undefined;
    profilePhoto?: string | null | undefined;
    licenseNumber?: string | null | undefined;
    licenseExpiry?: string | null | undefined;
    aadharNumber?: string | null | undefined;
    address?: string | null | undefined;
    emergencyContact?: string | null | undefined;
}, {
    name: string;
    email?: string | null | undefined;
    profilePhoto?: string | null | undefined;
    licenseNumber?: string | null | undefined;
    licenseExpiry?: string | null | undefined;
    aadharNumber?: string | null | undefined;
    address?: string | null | undefined;
    emergencyContact?: string | null | undefined;
}>;
/**
 * Add Driver (by Transporter)
 */
export declare const addDriverSchema: z.ZodObject<{
    phone: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
    name: z.ZodString;
    licenseNumber: z.ZodOptional<z.ZodString>;
    licenseExpiry: z.ZodOptional<z.ZodString>;
    aadharNumber: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    phone: string;
    name: string;
    licenseNumber?: string | undefined;
    licenseExpiry?: string | undefined;
    aadharNumber?: string | undefined;
}, {
    phone: string;
    name: string;
    licenseNumber?: string | undefined;
    licenseExpiry?: string | undefined;
    aadharNumber?: string | undefined;
}>;
export type CustomerProfileInput = z.infer<typeof customerProfileSchema>;
export type TransporterProfileInput = z.infer<typeof transporterProfileSchema>;
export type DriverProfileInput = z.infer<typeof driverProfileSchema>;
export type AddDriverInput = z.infer<typeof addDriverSchema>;
//# sourceMappingURL=profile.schema.d.ts.map