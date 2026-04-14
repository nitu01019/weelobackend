/**
 * =============================================================================
 * ASSIGNMENT MODULE - SHARED TYPES & CONFIG
 * =============================================================================
 *
 * Shared interfaces and configuration used across assignment sub-services.
 * =============================================================================
 */

import { HOLD_CONFIG } from '../../core/config/hold-config';

// =============================================================================
// ASSIGNMENT TIMEOUT — Queue-based (replaces setInterval polling)
// =============================================================================
//
// BEFORE: setInterval(5000ms) on EVERY ECS instance → Redis SCAN for expired keys
//   → 50 instances × SCAN every 5s = 600 Redis ops/minute even at 3am
//
// NOW: In-process setTimeout fires at HOLD_CONFIG.driverAcceptTimeoutMs
//   → Zero polling, zero wasted CPU, sub-second accuracy
//
// Processor registered in: queue.service.ts → registerDefaultProcessors()
// =============================================================================

export const ASSIGNMENT_CONFIG = {
  /** How long driver has to respond. Fix H-X1: centralized via HOLD_CONFIG */
  TIMEOUT_MS: HOLD_CONFIG.driverAcceptTimeoutMs,
};

/** Timer data — used by both queue processor and createAssignment */
export interface AssignmentTimerData {
  assignmentId: string;
  driverId: string;
  driverName: string;
  transporterId: string;
  vehicleId: string;
  vehicleNumber: string;
  bookingId?: string;  // Optional for multi-truck system (uses orderId instead)
  tripId: string;
  createdAt: string;
  orderId?: string;      // Optional for multi-truck system
  truckRequestId?: string; // Optional for multi-truck system
}
