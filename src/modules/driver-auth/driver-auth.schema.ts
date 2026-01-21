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
export const sendDriverOtpSchema = z.object({
  body: z.object({
    driverPhone: z.string()
      .min(10, 'Phone number must be at least 10 digits')
      .max(15, 'Phone number too long')
      .regex(/^[0-9]+$/, 'Phone number must contain only digits'),
  }),
});

/**
 * Schema for verifying OTP and logging in driver
 */
export const verifyDriverOtpSchema = z.object({
  body: z.object({
    driverPhone: z.string()
      .min(10, 'Phone number must be at least 10 digits')
      .max(15, 'Phone number too long')
      .regex(/^[0-9]+$/, 'Phone number must contain only digits'),
    otp: z.string()
      .length(6, 'OTP must be 6 digits')
      .regex(/^[0-9]+$/, 'OTP must contain only digits'),
  }),
});

// Type exports for use in controller/service
export type SendDriverOtpInput = z.infer<typeof sendDriverOtpSchema>['body'];
export type VerifyDriverOtpInput = z.infer<typeof verifyDriverOtpSchema>['body'];
