/**
 * =============================================================================
 * DRIVER AUTH MODULE - VALIDATION SCHEMAS
 * =============================================================================
 *
 * Zod schemas for driver authentication request validation.
 *
 * FLOW:
 * 1. Driver enters their phone number
 * 2. System finds which transporter this driver belongs to
 * 3. OTP is sent to TRANSPORTER's phone (not driver's)
 * 4. Driver gets OTP from transporter and enters it
 * 5. Driver gets authenticated
 * =============================================================================
 */
import { z } from 'zod';
/**
 * Schema for sending OTP to transporter for driver login
 * Driver provides their phone, OTP goes to their transporter
 */
export declare const sendDriverOtpSchema: z.ZodObject<{
    body: z.ZodObject<{
        driverPhone: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        driverPhone: string;
    }, {
        driverPhone: string;
    }>;
}, "strip", z.ZodTypeAny, {
    body: {
        driverPhone: string;
    };
}, {
    body: {
        driverPhone: string;
    };
}>;
/**
 * Schema for verifying OTP and logging in driver
 */
export declare const verifyDriverOtpSchema: z.ZodObject<{
    body: z.ZodObject<{
        driverPhone: z.ZodString;
        otp: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        otp: string;
        driverPhone: string;
    }, {
        otp: string;
        driverPhone: string;
    }>;
}, "strip", z.ZodTypeAny, {
    body: {
        otp: string;
        driverPhone: string;
    };
}, {
    body: {
        otp: string;
        driverPhone: string;
    };
}>;
export type SendDriverOtpInput = z.infer<typeof sendDriverOtpSchema>['body'];
export type VerifyDriverOtpInput = z.infer<typeof verifyDriverOtpSchema>['body'];
//# sourceMappingURL=driver-auth.schema.d.ts.map