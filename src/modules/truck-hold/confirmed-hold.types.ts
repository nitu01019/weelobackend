/**
 * =============================================================================
 * CONFIRMED HOLD — Types, Config & Redis Keys
 * =============================================================================
 *
 * Extracted from confirmed-hold.service.ts to keep main service under 800 lines.
 * All types and configuration for Phase 2 (Confirmed) of the two-phase hold system.
 * =============================================================================
 */

import { HoldPhase } from '../../shared/database/prisma.service';
import { HOLD_CONFIG } from '../../core/config/hold-config';

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

/**
 * Confirmed hold configuration
 */
export interface ConfirmedHoldConfig {
  maxDurationSeconds: number;
  driverAcceptTimeoutSeconds: number;
}

/**
 * Confirmed hold state
 */
export interface ConfirmedHoldState {
  holdId: string;
  orderId: string;
  transporterId: string;
  phase: HoldPhase;
  confirmedAt: Date;
  confirmedExpiresAt: Date;
  remainingSeconds: number;
  trucksCount: number;
  trucksAccepted: number;
  trucksDeclined: number;
  trucksPending: number;
}

/**
 * Driver acceptance response
 */
export interface DriverAcceptResponse {
  success: boolean;
  assignmentId: string;
  accepted: boolean;
  declined: boolean;
  timeout: boolean;
  message: string;
  errorCode?: string;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

export const DEFAULT_CONFIG: ConfirmedHoldConfig = {
  maxDurationSeconds: HOLD_CONFIG.confirmedHoldMaxSeconds,
  driverAcceptTimeoutSeconds: HOLD_CONFIG.driverAcceptTimeoutSeconds,
};

// Redis keys for distributed locking and state
export const REDIS_KEYS = {
  // Standardized: lock: prefix for all distributed locks (added by acquireLock automatically)
  CONFIRMED_HOLD_LOCK: (holdId: string) => `confirmed-hold:${holdId}`,
  CONFIRMED_HOLD_STATE: (holdId: string) => `confirmed-hold:${holdId}:state`,
  DRIVER_ACCEPTANCE: (assignmentId: string) => `driver-acceptance:${assignmentId}`,
};
