/**
 * =============================================================================
 * USER MODULE - VALIDATION SCHEMAS
 * =============================================================================
 */
import { z } from 'zod';
/**
 * Update profile request schema
 */
export declare const updateProfileSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    email: z.ZodOptional<z.ZodString>;
    businessName: z.ZodOptional<z.ZodString>;
    gstNumber: z.ZodOptional<z.ZodString>;
    address: z.ZodOptional<z.ZodString>;
    city: z.ZodOptional<z.ZodString>;
    state: z.ZodOptional<z.ZodString>;
    profilePicture: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    name?: string | undefined;
    email?: string | undefined;
    gstNumber?: string | undefined;
    businessName?: string | undefined;
    address?: string | undefined;
    city?: string | undefined;
    state?: string | undefined;
    profilePicture?: string | undefined;
}, {
    name?: string | undefined;
    email?: string | undefined;
    gstNumber?: string | undefined;
    businessName?: string | undefined;
    address?: string | undefined;
    city?: string | undefined;
    state?: string | undefined;
    profilePicture?: string | undefined;
}>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
//# sourceMappingURL=user.schema.d.ts.map