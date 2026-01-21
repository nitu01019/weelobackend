/**
 * =============================================================================
 * AUTH MODULE - VALIDATION SCHEMAS
 * =============================================================================
 *
 * Zod schemas for validating auth requests.
 * These define the API contract for auth endpoints.
 * =============================================================================
 */
import { z } from 'zod';
/**
 * Send OTP request schema
 */
export declare const sendOtpSchema: z.ZodObject<{
    phone: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
    role: z.ZodDefault<z.ZodEnum<["customer", "transporter", "driver", "admin"]>>;
}, "strict", z.ZodTypeAny, {
    phone: string;
    role: "customer" | "transporter" | "driver" | "admin";
}, {
    phone: string;
    role?: "customer" | "transporter" | "driver" | "admin" | undefined;
}>;
/**
 * Verify OTP request schema
 */
export declare const verifyOtpSchema: z.ZodObject<{
    phone: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
    otp: z.ZodString;
    role: z.ZodDefault<z.ZodEnum<["customer", "transporter", "driver", "admin"]>>;
    deviceId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    deviceName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strict", z.ZodTypeAny, {
    otp: string;
    phone: string;
    role: "customer" | "transporter" | "driver" | "admin";
    deviceId?: string | null | undefined;
    deviceName?: string | null | undefined;
}, {
    otp: string;
    phone: string;
    role?: "customer" | "transporter" | "driver" | "admin" | undefined;
    deviceId?: string | null | undefined;
    deviceName?: string | null | undefined;
}>;
/**
 * Refresh token request schema
 */
export declare const refreshTokenSchema: z.ZodObject<{
    refreshToken: z.ZodString;
}, "strict", z.ZodTypeAny, {
    refreshToken: string;
}, {
    refreshToken: string;
}>;
/**
 * Type exports for use in service/controller
 */
export type SendOtpInput = z.infer<typeof sendOtpSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
//# sourceMappingURL=auth.schema.d.ts.map