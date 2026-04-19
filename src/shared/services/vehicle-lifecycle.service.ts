// =============================================================================
// VEHICLE LIFECYCLE SERVICE — Centralized vehicle status management
// =============================================================================
// Industry pattern: All vehicle status changes go through ONE validated path
// that ensures transition validity and keeps Redis in sync.
// =============================================================================

import { prismaClient } from '../database/prisma.service';
import { liveAvailabilityService } from './live-availability.service';
import { invalidateVehicleCache } from './fleet-cache-write.service';
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

  // Sync Redis + fleet cache via centralized wrapper
  await onVehicleTransition(
    vehicle.transporterId,
    vehicleId,
    vehicle.vehicleKey,
    vehicle.status,
    'available',
    context
  );

  logger.info(`[vehicleLifecycle:${context}] Vehicle ${vehicleId} released: ${vehicle.status} -> available`);
}

/**
 * Centralized post-commit hook for vehicle status transitions.
 *
 * ALWAYS calls BOTH:
 *   1. liveAvailabilityService.onVehicleStatusChange() — Redis availability counters
 *   2. invalidateVehicleCache() — Fleet cache for transporter dashboard
 *
 * Uses Promise.allSettled so one failure does not block the other.
 * Call this AFTER the DB transaction that changed vehicle status has committed.
 */
export async function onVehicleTransition(
  transporterId: string,
  vehicleId: string,
  vehicleKey: string | null | undefined,
  oldStatus: string,
  newStatus: string,
  context: string
): Promise<void> {
  if (oldStatus === newStatus) return; // No-op if status didn't actually change

  const tag = `[vehicleTransition:${context}]`;

  const results = await Promise.allSettled([
    vehicleKey
      ? liveAvailabilityService.onVehicleStatusChange(transporterId, vehicleKey, oldStatus, newStatus)
      : Promise.resolve(),
    invalidateVehicleCache(transporterId, vehicleId),
  ]);

  if (results[0].status === 'rejected') {
    logger.warn(`${tag} Redis availability sync failed`, {
      transporterId: transporterId.substring(0, 8),
      vehicleId: vehicleId.substring(0, 8),
      transition: `${oldStatus} -> ${newStatus}`,
      error: results[0].reason instanceof Error ? results[0].reason.message : String(results[0].reason),
    });
  }
  if (results[1].status === 'rejected') {
    logger.warn(`${tag} Fleet cache invalidation failed`, {
      transporterId: transporterId.substring(0, 8),
      vehicleId: vehicleId.substring(0, 8),
      transition: `${oldStatus} -> ${newStatus}`,
      error: results[1].reason instanceof Error ? results[1].reason.message : String(results[1].reason),
    });
  }
}
