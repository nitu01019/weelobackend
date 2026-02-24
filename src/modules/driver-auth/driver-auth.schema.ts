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
import { otpSchema, phoneSchema } from '../../shared/utils/validation.utils';

/**
 * Schema for sending OTP to transporter for driver login
 * Driver provides their phone, OTP goes to their transporter
 */
export const sendDriverOtpSchema = z.object({
  driverPhone: phoneSchema
}).strict();

/**
 * Schema for verifying OTP and logging in driver
 */
export const verifyDriverOtpSchema = z.object({
  driverPhone: phoneSchema,
  otp: otpSchema,
}).strict();

// Type exports for use in controller/service
export type SendDriverOtpInput = z.infer<typeof sendDriverOtpSchema>;
export type VerifyDriverOtpInput = z.infer<typeof verifyDriverOtpSchema>;
