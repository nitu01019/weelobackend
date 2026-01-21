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
import { phoneSchema, otpSchema, userRoleSchema } from '../../shared/utils/validation.utils';

/**
 * Send OTP request schema
 */
export const sendOtpSchema = z.object({
  phone: phoneSchema,
  role: userRoleSchema.default('customer')
}).strict(); // Reject unknown fields

/**
 * Verify OTP request schema
 */
export const verifyOtpSchema = z.object({
  phone: phoneSchema,
  otp: otpSchema,
  role: userRoleSchema.default('customer'),
  // Optional device info for multi-device support (nullable to handle app sending null)
  deviceId: z.string().max(100).nullable().optional(),
  deviceName: z.string().max(100).nullable().optional()
}).strict();

/**
 * Refresh token request schema
 */
export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required')
}).strict();

/**
 * Type exports for use in service/controller
 */
export type SendOtpInput = z.infer<typeof sendOtpSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
