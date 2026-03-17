/**
 * =============================================================================
 * HOLD EXPIRY MODULE - Dual-Layer Defense for Hold Expiry
 * =============================================================================
 *
 * EXPOSES:
 * - holdExpiryCleanupService: Layer 1 - Delayed queue cleanup
 * - holdReconciliationService: Layer 2 - Periodic safety net
 * - registerHoldExpiryProcessor: Static method to register queue processor
 *
 * USAGE:
 *   // Schedule cleanup for a hold (Layer 1)
 *   import { holdExpiryCleanupService } from './modules/hold-expiry';
 *   await holdExpiryCleanupService.scheduleFlexHoldCleanup(holdId, expiresAt);
 *
 *   // Start Layer 2 reconciliation worker (safety net)
 *   import { holdReconciliationService } from './modules/hold-expiry';
 *   holdReconciliationService.start(); // Run during app initialization
 *
 *   // Register Layer 1 queue processor during app initialization
 *   import { registerHoldExpiryProcessor } from './modules/hold-expiry';
 *   registerHoldExpiryProcessor();
 *
 * =============================================================================
 */

// Layer 1: Delayed Queue Cleanup
export { holdExpiryCleanupService, registerHoldExpiryProcessor } from './hold-expiry-cleanup.service';
export { HoldExpiryCleanupService } from './hold-expiry-cleanup.service';
export type { HoldExpiryJobData } from './hold-expiry-cleanup.service';
export { JOB_TYPES, QUEUE_NAME } from './hold-expiry-cleanup.service';

// Layer 2: Periodic Reconciliation (Safety Net)
export { holdReconciliationService } from './hold-reconciliation.service';
export { HoldReconciliationService } from './hold-reconciliation.service';
