/**
 * =============================================================================
 * TRUCK HOLD TYPES & SHARED CONFIGURATION
 * =============================================================================
 *
 * All types, interfaces, and shared constants for the truck hold system.
 * Sub-modules import from this file DIRECTLY.
 */

import { AssignmentStatus } from '@prisma/client';
// FIX #90: Import from single source of truth instead of duplicating parseInt(process.env...) calls
import { HOLD_CONFIG } from '../../core/config/hold-config';
import type { LocationRecord } from '../../shared/database/record-types';

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

/**
 * Status of a truck in the system
 */
/**
 * Truck status for the hold system
 * Note: Maps to TruckRequestRecord status in db.ts
 * - 'searching' = available for transporters to hold
 * - 'held' = temporarily held (duration from HOLD_DURATION_CONFIG)
 * - 'assigned' = confirmed, waiting for driver assignment
 */
export type TruckStatus = 'searching' | 'held' | 'assigned' | 'in_transit' | 'completed';

/**
 * Hold record - tracks who is holding which trucks
 */
export interface TruckHold {
  holdId: string;
  orderId: string;
  transporterId: string;
  vehicleType: string;
  vehicleSubtype: string;
  quantity: number;
  truckRequestIds: string[];      // Which specific truck requests are held
  createdAt: Date;
  expiresAt: Date;
  status: 'active' | 'confirmed' | 'expired' | 'released';
}

/**
 * Request to hold trucks
 */
export interface HoldTrucksRequest {
  orderId: string;
  transporterId: string;
  vehicleType: string;
  vehicleSubtype: string;
  quantity: number;
  idempotencyKey?: string;
}

/**
 * Response from hold operation
 */
export interface HoldTrucksResponse {
  success: boolean;
  holdId?: string;
  expiresAt?: Date;
  heldQuantity?: number;
  holdState?: 'reserved' | 'released' | 'confirmed';
  eventId?: string;
  eventVersion?: number;
  serverTimeMs?: number;
  message: string;
  error?: string;
}

/**
 * Truck availability for a vehicle type
 */
export interface TruckAvailability {
  vehicleType: string;
  vehicleSubtype: string;
  totalNeeded: number;
  available: number;
  held: number;
  assigned: number;
  farePerTruck: number;
}

/**
 * Order availability response
 */
export interface OrderAvailability {
  orderId: string;
  customerName: string;
  customerPhone: string;
  pickup: LocationRecord;
  drop: LocationRecord;
  distanceKm: number;
  goodsType: string;
  trucks: TruckAvailability[];
  totalValue: number;
  isFullyAssigned: boolean;
}

/**
 * Redis-serializable hold data (dates as strings)
 */
export interface TruckHoldRedis extends Omit<TruckHold, 'createdAt' | 'expiresAt'> {
  createdAt: string;
  expiresAt: string;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Shared hold timing config — single source of truth for ALL hold durations.
 * Reads from environment variables with PRD 7777 defaults.
 * Both legacy and FLEX paths MUST use these values.
 *
 * Industry standard (Ola): Single hold config, phase-based.
 * Industry standard (BlackBuck): Single hold system with configurable phases.
 */
// FIX #90: HOLD_DURATION_CONFIG is now derived from hold-config.ts (single source of truth).
// All values come from HOLD_CONFIG which centralises all parseInt(process.env...) calls.
// The constant name and shape are preserved so callers require no changes.
export const HOLD_DURATION_CONFIG = {
  FLEX_DURATION_SECONDS: HOLD_CONFIG.flexHoldDurationSeconds,
  EXTENSION_SECONDS: HOLD_CONFIG.flexHoldExtensionSeconds,
  MAX_DURATION_SECONDS: HOLD_CONFIG.flexHoldMaxDurationSeconds,
  CONFIRMED_MAX_SECONDS: HOLD_CONFIG.confirmedHoldMaxSeconds,
  MAX_EXTENSIONS: HOLD_CONFIG.flexHoldMaxExtensions,
} as const;

/**
 * Hold configuration - easy to adjust
 * Legacy CONFIG now reads HOLD_DURATION_SECONDS from the shared env-based config
 * instead of a hardcoded 180s value.
 */
export const CONFIG = {
  // FIX #4: Use env-based FLEX duration instead of hardcoded 180s.
  // Legacy path now aligned with FLEX hold system per PRD 7777.
  HOLD_DURATION_SECONDS: HOLD_DURATION_CONFIG.FLEX_DURATION_SECONDS,
  CLEANUP_INTERVAL_MS: 5000,       // How often to clean expired holds
  MAX_HOLD_QUANTITY: 50,           // Max trucks one transporter can hold at once
  MIN_HOLD_QUANTITY: 1,            // Minimum trucks to hold
};

export const ACTIVE_ORDER_STATUSES = new Set(['created', 'broadcasting', 'active', 'partially_filled']);
export const TERMINAL_ORDER_STATUSES = new Set(['cancelled', 'expired', 'completed', 'fully_filled']);

/**
 * Terminal hold statuses — holds in these states must NOT be overwritten by
 * expiry cleanup, finalize-retry compensation, or any other background processor.
 *
 * Single source of truth: imported by hold-expiry-cleanup.service.ts and
 * hold-finalize-retry.processor.ts. Do NOT duplicate this list elsewhere.
 *
 * TruckHoldLedger.status is a plain String column, so string[] is the correct type.
 */
export const TERMINAL_HOLD_STATUSES: string[] = ['completed', 'cancelled', 'expired', 'released', 'confirmed'];

/**
 * Assignment statuses safe to cancel during hold release.
 * 'driver_accepted' is intentionally excluded — the driver has committed.
 *
 * Shared by hold-expiry-cleanup.service.ts and hold-finalize-retry.processor.ts
 * so both paths use identical CAS guards.
 *
 * Uses Prisma AssignmentStatus enum for type safety in Prisma queries.
 */
export const RELEASABLE_ASSIGNMENT_STATUSES: AssignmentStatus[] = [
  AssignmentStatus.pending,
  AssignmentStatus.driver_declined,
];
export const HOLD_EVENT_VERSION = 1;

export const FF_HOLD_DB_ATOMIC_CLAIM = process.env.FF_HOLD_DB_ATOMIC_CLAIM !== 'false';
export const FF_HOLD_STRICT_IDEMPOTENCY = process.env.FF_HOLD_STRICT_IDEMPOTENCY !== 'false';
export const FF_HOLD_RECONCILE_RECOVERY = process.env.FF_HOLD_RECONCILE_RECOVERY !== 'false';
export const FF_HOLD_SAFE_RELEASE_GUARD = process.env.FF_HOLD_SAFE_RELEASE_GUARD !== 'false';
export const HOLD_IDEMPOTENCY_RETENTION_HOURS = Math.max(24, parseInt(process.env.HOLD_IDEMPOTENCY_RETENTION_HOURS || '168', 10) || 168);
export const HOLD_IDEMPOTENCY_PURGE_INTERVAL_MS = Math.max(
  60_000,
  parseInt(process.env.HOLD_IDEMPOTENCY_PURGE_INTERVAL_MS || String(30 * 60 * 1000), 10) || (30 * 60 * 1000)
);
// FIX #40: NaN guard + min 1 + max 5000 cap to prevent runaway batch queries
const _rawHCBS = parseInt(process.env.HOLD_CLEANUP_BATCH_SIZE || '500', 10);
export const HOLD_CLEANUP_BATCH_SIZE = Math.min(5000, Math.max(1, isNaN(_rawHCBS) ? 500 : _rawHCBS));
