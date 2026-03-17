/**
 * =============================================================================
 * HOLD EXPIRY MODULE - Layer 1 Delayed Queue Cleanup
 * =============================================================================
 *
 * EXPOSES:
 * - holdExpiryCleanupService: Service for scheduling and processing hold expiry
 * - registerHoldExpiryProcessor: Static method to register queue processor
 *
 * USAGE:
 *   // Schedule cleanup for a hold
 *   import { holdExpiryCleanupService } from './modules/hold-expiry';
 *   await holdExpiryCleanupService.scheduleFlexHoldCleanup(holdId, expiresAt);
 *
 *   // Register during app initialization
 *   import { registerHoldExpiryProcessor } from './modules/hold-expiry';
 *   registerHoldExpiryProcessor();
 *
 * =============================================================================
 */

export { holdExpiryCleanupService, registerHoldExpiryProcessor } from './hold-expiry-cleanup.service';
export { HoldExpiryCleanupService } from './hold-expiry-cleanup.service';

export type {
  HoldExpiryJobData,
} from './hold-expiry-cleanup.service';

export {
  JOB_TYPES,
  QUEUE_NAME,
} from './hold-expiry-cleanup.service';
