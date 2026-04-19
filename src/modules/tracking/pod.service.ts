/**
 * F-H15: Proof of Delivery (POD) OTP Service
 * Behind feature flag FF_POD_OTP_REQUIRED (default: false).
 * When enabled: generates 4-digit OTP at arrived_at_drop, validates on completion.
 *
 * Routes: src/modules/tracking/pod.routes.ts
 * SMS: OTP is sent to customer phone via smsService (fire-and-forget).
 */
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { AppError } from '../../shared/types/error.types';
import { smsService } from '../auth/sms.service';

const POD_OTP_TTL = 3600; // 1 hour
const POD_VERIFIED_TTL = 86400; // 24 hours

export function isPodRequired(): boolean {
  return process.env.FF_POD_OTP_REQUIRED === 'true';
}

/**
 * Generate a 4-digit POD OTP for delivery confirmation.
 * Stores OTP in Redis and sends it to the customer phone via SMS (fire-and-forget).
 *
 * @param tripId - The trip/assignment identifier
 * @param customerId - Customer ID for logging context
 * @param customerPhone - Customer phone number to send OTP via SMS
 */
export async function generatePodOtp(
  tripId: string,
  customerId: string,
  customerPhone?: string,
): Promise<void> {
  const otp = String(Math.floor(1000 + Math.random() * 9000)); // 4-digit
  const key = `pod:otp:${tripId}`;
  await redisService.set(key, otp, POD_OTP_TTL);
  logger.info('[POD] OTP generated for delivery confirmation', { tripId, customerId });

  // Fire-and-forget SMS delivery — do not block the caller
  if (customerPhone) {
    smsService.sendOtp(customerPhone, otp).catch((err) => {
      logger.warn('[POD] SMS delivery failed', {
        tripId,
        error: (err as Error).message,
      });
    });
  } else {
    logger.warn('[POD] No customer phone provided — OTP not sent via SMS', { tripId });
  }
}

export async function validatePodOtp(tripId: string, providedOtp: string): Promise<boolean> {
  const key = `pod:otp:${tripId}`;
  const storedOtp = await redisService.get(key);
  if (!storedOtp) {
    throw new AppError(400, 'OTP_EXPIRED', 'Delivery OTP has expired. Please request a new one.');
  }
  if (storedOtp !== providedOtp) {
    throw new AppError(400, 'OTP_INVALID', 'Incorrect OTP. Please check with the customer.');
  }
  await redisService.del(key);
  return true;
}

/**
 * Store a verified POD flag in Redis. Used by routes after successful OTP validation.
 */
export async function markPodVerified(tripId: string): Promise<void> {
  await redisService.set(`pod:verified:${tripId}`, 'true', POD_VERIFIED_TTL);
  logger.info('[POD] Delivery verified', { tripId });
}

/**
 * Check if POD has been verified for a trip.
 */
export async function isPodVerified(tripId: string): Promise<boolean> {
  const val = await redisService.get(`pod:verified:${tripId}`);
  return val === 'true';
}

/**
 * Check if an OTP is currently pending (generated but not yet verified).
 */
export async function isPodOtpPending(tripId: string): Promise<boolean> {
  const val = await redisService.get(`pod:otp:${tripId}`);
  return val !== null;
}
