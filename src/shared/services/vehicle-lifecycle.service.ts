// =============================================================================
// VEHICLE LIFECYCLE SERVICE — Centralized vehicle status management
// =============================================================================
// Industry pattern: All vehicle status changes go through ONE validated path
// that ensures transition validity and keeps Redis in sync.
// =============================================================================

import { prismaClient } from '../database/prisma.service';
import { liveAvailabilityService } from './live-availability.service';
import { logger } from './logger.service';

/**
 * Valid vehicle status transitions.
 * Exported so vehicle.service.ts can reuse the same map
 * instead of maintaining a duplicate.
 */
export const VALID_TRANSITIONS: Record<string, string[]> = {
  available:    ['on_hold', 'in_transit', 'maintenance', 'inactive'],
  on_hold:      ['in_transit', 'available'],
  in_transit:   ['available', 'maintenance'],
  maintenance:  ['available', 'inactive'],
  inactive:     ['available', 'maintenance'],
};

/**
 * Validate whether a status transition is allowed.
 *
 * @returns true if the transition is valid, false otherwise
 */
export function isValidTransition(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return !!allowed && allowed.includes(to);
}

/**
 * Release a vehicle back to 'available' with validation.
 * Idempotent: if vehicle is already 'available', no-op.
 * Uses updateMany with status guard for atomic conditional update.
 */
export async function releaseVehicle(
  vehicleId: string,
  context: string
): Promise<void> {
  // Read current state
  const vehicle = await prismaClient.vehicle.findUnique({
    where: { id: vehicleId },
    select: { id: true, status: true, vehicleKey: true, transporterId: true }
  });

  if (!vehicle) {
    logger.warn(`[vehicleLifecycle:${context}] Vehicle ${vehicleId} not found`);
    return;
  }

  // Already available — idempotent no-op
  if (vehicle.status === 'available') {
    return;
  }

  // Validate transition
  if (!isValidTransition(vehicle.status, 'available')) {
    logger.warn(
      `[vehicleLifecycle:${context}] Invalid transition: ${vehicle.status} -> available for vehicle ${vehicleId}`
    );
    return; // Don't throw — defensive guard
  }

  // Atomic conditional update (prevents race conditions)
  const result = await prismaClient.vehicle.updateMany({
    where: { id: vehicleId, status: { not: 'available' } },
    data: {
      status: 'available',
      currentTripId: null,
      assignedDriverId: null,
      lastStatusChange: new Date().toISOString()
    }
  });

  if (result.count === 0) {
    // Another path already released it — idempotent
    return;
  }

  // Sync Redis availability count
  if (vehicle.vehicleKey && vehicle.transporterId) {
    await liveAvailabilityService.onVehicleStatusChange(
      vehicle.transporterId,
      vehicle.vehicleKey,
      vehicle.status, // Actual old status, not hardcoded
      'available'
    ).catch(err => logger.warn(`[vehicleLifecycle:${context}] Redis sync failed`, err));
  }

  logger.info(`[vehicleLifecycle:${context}] Vehicle ${vehicleId} released: ${vehicle.status} -> available`);
}
