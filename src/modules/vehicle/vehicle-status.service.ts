/**
 * =============================================================================
 * VEHICLE STATUS SERVICE - Status transitions & lifecycle
 * =============================================================================
 *
 * Extracted from vehicle.service.ts (file-split).
 * Contains: updateVehicleStatus, validateStatusTransition, setMaintenance,
 *           setAvailable, setOnHold, setInTransit.
 * =============================================================================
 */

import { db, VehicleRecord, VehicleStatus } from '../../shared/database/db';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToUser } from '../../shared/services/socket.service';
import { VEHICLE_VALID_TRANSITIONS } from '../../core/state-machines';

// Import shared helpers from CRUD (not from facade, to avoid circular)
import { VehicleSocketEvents, calculateStatusCounts } from './vehicle-crud.service';

// Re-export VehicleSocketEvents so facade can re-export it
export { VehicleSocketEvents };

/**
 * Validate status transitions (business rules).
 * Uses the canonical VEHICLE_VALID_TRANSITIONS from src/core/state-machines.ts.
 */
function validateStatusTransition(currentStatus: VehicleStatus | undefined, newStatus: VehicleStatus): void {
  const current = currentStatus || 'available';
  if (!VEHICLE_VALID_TRANSITIONS[current]?.includes(newStatus)) {
    throw new AppError(400, 'INVALID_STATUS_TRANSITION',
      `Cannot change status from ${current} to ${newStatus}`);
  }
}

/**
 * Update vehicle status
 */
export async function updateVehicleStatus(
  vehicleId: string,
  transporterId: string,
  newStatus: VehicleStatus,
  options?: {
    tripId?: string;
    maintenanceReason?: string;
    maintenanceEndDate?: string;
  }
): Promise<VehicleRecord> {
  const vehicleResult = await db.getVehicleById(vehicleId);
  const vehicle = vehicleResult && typeof vehicleResult.then === 'function'
    ? await vehicleResult : vehicleResult;

  if (!vehicle) { throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found'); }
  if (vehicle.transporterId !== transporterId) {
    throw new AppError(403, 'FORBIDDEN', 'You can only update your own vehicles');
  }

  validateStatusTransition(vehicle.status, newStatus);

  const updates: Partial<VehicleRecord> = {
    status: newStatus,
    lastStatusChange: new Date().toISOString()
  };

  if (newStatus === 'in_transit' && options?.tripId) {
    updates.currentTripId = options.tripId;
  } else if (newStatus === 'available') {
    updates.currentTripId = undefined;
    updates.maintenanceReason = undefined;
    updates.maintenanceEndDate = undefined;
  } else if (newStatus === 'maintenance') {
    updates.maintenanceReason = options?.maintenanceReason;
    updates.maintenanceEndDate = options?.maintenanceEndDate;
    updates.currentTripId = undefined;
  }

  const updatedResult = await db.updateVehicle(vehicleId, updates);
  const updated = updatedResult && typeof updatedResult.then === 'function'
    ? await updatedResult : updatedResult;

  if (!updated) { throw new AppError(500, 'UPDATE_FAILED', 'Failed to update vehicle status'); }

  logger.info(`Vehicle ${vehicleId} status changed: ${vehicle.status} -> ${newStatus}`);

  try {
    const fleetVehiclesResult = await db.getVehiclesByTransporter(transporterId);
    const fleetVehicles = fleetVehiclesResult && typeof fleetVehiclesResult.then === 'function'
      ? await fleetVehiclesResult : fleetVehiclesResult;
    const fleetStats = calculateStatusCounts(fleetVehicles);

    emitToUser(transporterId, VehicleSocketEvents.VEHICLE_STATUS_CHANGED, {
      vehicle: updated, previousStatus: vehicle.status, newStatus, fleetStats
    });
    emitToUser(transporterId, VehicleSocketEvents.FLEET_UPDATED, {
      action: 'status_changed', vehicleId, fleetStats
    });
  } catch (socketError) {
    logger.warn(`Failed to emit socket event for status change: ${socketError}`);
  }

  return updated;
}

/**
 * Put vehicle in maintenance
 */
export async function setMaintenance(
  vehicleId: string, transporterId: string, reason: string, expectedEndDate?: string
): Promise<VehicleRecord> {
  return updateVehicleStatus(vehicleId, transporterId, 'maintenance', {
    maintenanceReason: reason, maintenanceEndDate: expectedEndDate
  });
}

/**
 * Mark vehicle as available
 */
export async function setAvailable(vehicleId: string, transporterId: string): Promise<VehicleRecord> {
  return updateVehicleStatus(vehicleId, transporterId, 'available');
}

/**
 * Mark vehicle as on_hold
 */
export async function setOnHold(vehicleId: string, transporterId: string, tripId?: string): Promise<VehicleRecord> {
  return updateVehicleStatus(vehicleId, transporterId, 'on_hold', tripId ? { tripId } : undefined);
}

/**
 * Mark vehicle as in transit
 */
export async function setInTransit(vehicleId: string, transporterId: string, tripId: string): Promise<VehicleRecord> {
  return updateVehicleStatus(vehicleId, transporterId, 'in_transit', { tripId });
}
