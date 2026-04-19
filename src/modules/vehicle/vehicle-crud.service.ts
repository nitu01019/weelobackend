/**
 * =============================================================================
 * VEHICLE CRUD SERVICE - Registration, retrieval, update, delete
 * =============================================================================
 *
 * Extracted from vehicle.service.ts (file-split).
 * Contains: registerVehicle, registerOrUpdateVehicle, checkVehicleAvailability,
 *           getVehicleById, getVehicleByNumber, getTransporterVehicles,
 *           updateVehicle, assignDriver, unassignDriver, deleteVehicle,
 *           getTransportersWithVehicleType, getVehicleTypesSummary,
 *           getAvailableVehicles, getVehicleTypes, calculatePricing.
 * =============================================================================
 */

import { v4 as uuid } from 'uuid';
import { db, VehicleRecord, VehicleStatus } from '../../shared/database/db';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToUser } from '../../shared/services/socket.service';
import { generateVehicleKey } from '../../shared/services/vehicle-key.service';
import {
  RegisterVehicleInput,
  UpdateVehicleInput,
  GetVehiclesQuery
} from './vehicle.schema';
import { getVehicleTypesCatalog } from './vehicle.catalog';

// Socket events for real-time vehicle updates
export const VehicleSocketEvents = {
  VEHICLE_REGISTERED: 'vehicle_registered',
  VEHICLE_UPDATED: 'vehicle_updated',
  VEHICLE_DELETED: 'vehicle_deleted',
  VEHICLE_STATUS_CHANGED: 'vehicle_status_changed',
  FLEET_UPDATED: 'fleet_updated'
};

// Shared helpers used by both CRUD and Status sub-modules
export function calculateStatusCounts(vehicles: VehicleRecord[]): Record<string, number> {
  const counts: Record<string, number> = {
    available: 0,
    on_hold: 0,
    in_transit: 0,
    maintenance: 0,
    inactive: 0,
    total: vehicles.length
  };
  for (const vehicle of vehicles) {
    if (vehicle.status && counts[vehicle.status] !== undefined) {
      counts[vehicle.status]++;
    } else if (!vehicle.status) {
      counts.available++;
    }
  }
  return counts;
}

function normalizeVehicle(vehicle: VehicleRecord): VehicleRecord {
  return {
    ...vehicle,
    status: (vehicle.status || 'available') as VehicleStatus
  };
}

function normalizeVehicles(vehicles: VehicleRecord[]): VehicleRecord[] {
  return vehicles.map(v => normalizeVehicle(v));
}

async function emitFleetUpdate(
  transporterId: string,
  vehicle: VehicleRecord,
  action: 'added' | 'updated' | 'deleted' | 'status_changed'
): Promise<void> {
  try {
    const fleetVehicles = await db.getVehiclesByTransporter(transporterId);
    const fleetStats = calculateStatusCounts(fleetVehicles);

    const eventName = action === 'added'
      ? VehicleSocketEvents.VEHICLE_REGISTERED
      : action === 'deleted'
        ? VehicleSocketEvents.VEHICLE_DELETED
        : VehicleSocketEvents.VEHICLE_UPDATED;

    emitToUser(transporterId, eventName, {
      vehicle,
      fleetStats,
      message: `Vehicle ${vehicle.vehicleNumber} ${action} successfully`
    });

    emitToUser(transporterId, VehicleSocketEvents.FLEET_UPDATED, {
      action,
      vehicleId: vehicle.id,
      fleetStats
    });

    logger.debug(`[SOCKET] ${eventName} emitted to ${transporterId}`);
  } catch (socketError) {
    logger.warn(`[SOCKET] Failed to emit fleet update: ${socketError}`);
  }
}

async function updateExistingVehicle(
  existing: VehicleRecord,
  transporterId: string,
  data: RegisterVehicleInput
): Promise<VehicleRecord> {
  if (existing.transporterId !== transporterId) {
    throw new AppError(403, 'FORBIDDEN', 'This vehicle does not belong to you');
  }
  const vehicleKey = generateVehicleKey(data.vehicleType, data.vehicleSubtype);
  const updated = await db.updateVehicle(existing.id, {
    vehicleType: data.vehicleType,
    vehicleSubtype: data.vehicleSubtype,
    vehicleKey,
    capacity: data.capacity,
    model: data.model,
    year: data.year,
    rcNumber: data.rcNumber,
    rcExpiry: data.rcExpiry,
    insuranceNumber: data.insuranceNumber,
    insuranceExpiry: data.insuranceExpiry,
    permitNumber: data.permitNumber,
    permitExpiry: data.permitExpiry,
    fitnessExpiry: data.fitnessExpiry,
    vehiclePhotos: data.vehiclePhotos,
    rcPhoto: data.rcPhoto,
    insurancePhoto: data.insurancePhoto,
    isActive: true
  });
  if (!updated) {
    throw new AppError(500, 'UPDATE_FAILED', 'Failed to update vehicle');
  }
  logger.info(`[VEHICLE] Updated: ${existing.vehicleNumber} by ${transporterId}`);
  emitFleetUpdate(transporterId, updated, 'updated');
  return updated;
}

// =============================================================================
// REGISTRATION
// =============================================================================

export async function registerVehicle(
  transporterId: string,
  data: RegisterVehicleInput,
  options?: { allowUpdate?: boolean }
): Promise<VehicleRecord> {
  const vehicleNumber = data.vehicleNumber.toUpperCase().trim();
  const existingResult = await db.getVehicleByNumber(vehicleNumber);
  const existing = existingResult && typeof existingResult.then === 'function'
    ? await existingResult
    : existingResult;

  if (existing) {
    if (options?.allowUpdate) {
      return updateExistingVehicle(existing, transporterId, data);
    }
    if (existing.transporterId === transporterId) {
      throw new AppError(409, 'VEHICLE_EXISTS_SAME_OWNER',
        `Vehicle ${vehicleNumber} is already registered in your fleet. Use update instead.`,
        { vehicleId: existing.id, vehicleNumber: existing.vehicleNumber });
    }
    throw new AppError(409, 'VEHICLE_EXISTS',
      `Vehicle ${vehicleNumber} is already registered by another transporter.`);
  }

  const vehicleKey = generateVehicleKey(data.vehicleType, data.vehicleSubtype);
  const vehicle = await db.createVehicle({
    id: uuid(), transporterId, vehicleNumber,
    vehicleType: data.vehicleType, vehicleSubtype: data.vehicleSubtype,
    vehicleKey, capacity: data.capacity, model: data.model, year: data.year,
    status: 'available', lastStatusChange: new Date().toISOString(),
    rcNumber: data.rcNumber, rcExpiry: data.rcExpiry,
    insuranceNumber: data.insuranceNumber, insuranceExpiry: data.insuranceExpiry,
    permitNumber: data.permitNumber, permitExpiry: data.permitExpiry,
    fitnessExpiry: data.fitnessExpiry, vehiclePhotos: data.vehiclePhotos,
    rcPhoto: data.rcPhoto, insurancePhoto: data.insurancePhoto,
    isVerified: false, isActive: true
  });

  logger.info(`[VEHICLE] Registered: ${vehicleNumber} (${data.vehicleType}/${data.vehicleSubtype}) -> Key: ${vehicleKey} by ${transporterId}`);
  emitFleetUpdate(transporterId, vehicle, 'added');
  return vehicle;
}

export async function registerOrUpdateVehicle(
  transporterId: string,
  data: RegisterVehicleInput
): Promise<{ vehicle: VehicleRecord; isNew: boolean }> {
  const vehicleNumber = data.vehicleNumber.toUpperCase().trim();
  const existingResult = await db.getVehicleByNumber(vehicleNumber);
  const existing = existingResult && typeof existingResult.then === 'function'
    ? await existingResult
    : existingResult;

  if (existing) {
    if (existing.transporterId !== transporterId) {
      throw new AppError(409, 'VEHICLE_EXISTS',
        `Vehicle ${vehicleNumber} is already registered by another transporter.`);
    }
    const updated = await updateExistingVehicle(existing, transporterId, data);
    return { vehicle: updated, isNew: false };
  }

  const vehicle = await registerVehicle(transporterId, data);
  return { vehicle, isNew: true };
}

export async function checkVehicleAvailability(
  vehicleNumber: string,
  transporterId?: string
): Promise<{ available: boolean; exists: boolean; ownedByYou: boolean; vehicleId?: string; message: string }> {
  const normalized = vehicleNumber.toUpperCase().trim();
  const existingResult = await db.getVehicleByNumber(normalized);
  const existing = existingResult && typeof existingResult.then === 'function'
    ? await existingResult : existingResult;

  if (!existing) {
    return { available: true, exists: false, ownedByYou: false, message: 'Vehicle number is available for registration' };
  }

  const ownedByYou = transporterId ? existing.transporterId === transporterId : false;
  return {
    available: false, exists: true, ownedByYou, vehicleId: existing.id,
    message: ownedByYou
      ? 'This vehicle is already in your fleet. You can update it.'
      : 'This vehicle is registered by another transporter.'
  };
}

// =============================================================================
// RETRIEVAL
// =============================================================================

export async function getVehicleById(vehicleId: string): Promise<VehicleRecord> {
  const vehicleResult = await db.getVehicleById(vehicleId);
  const vehicle = vehicleResult && typeof vehicleResult.then === 'function'
    ? await vehicleResult : vehicleResult;
  if (!vehicle) {
    throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found');
  }
  return vehicle;
}

export async function getVehicleByNumber(vehicleNumber: string): Promise<VehicleRecord | null> {
  const vehicleResult = await db.getVehicleByNumber(vehicleNumber.toUpperCase());
  const vehicle = vehicleResult && typeof vehicleResult.then === 'function'
    ? await vehicleResult : vehicleResult;
  return vehicle || null;
}

export async function getTransporterVehicles(
  transporterId: string,
  query: GetVehiclesQuery
): Promise<{ vehicles: VehicleRecord[]; total: number; hasMore: boolean; statusCounts: Record<string, number> }> {
  const vehiclesResult = await db.getVehiclesByTransporter(transporterId);
  let vehicles: VehicleRecord[] = vehiclesResult && typeof vehiclesResult.then === 'function'
    ? await vehiclesResult : vehiclesResult;

  const statusCounts = calculateStatusCounts(vehicles);

  if (query.vehicleType) { vehicles = vehicles.filter((v) => v.vehicleType === query.vehicleType); }
  if (query.status) { vehicles = vehicles.filter((v) => v.status === query.status); }
  if (query.isActive !== undefined) { vehicles = vehicles.filter((v) => v.isActive === query.isActive); }

  const total = vehicles.length;
  const start = (query.page - 1) * query.limit;
  vehicles = vehicles.slice(start, start + query.limit);
  const hasMore = start + vehicles.length < total;

  return { vehicles: normalizeVehicles(vehicles), total, hasMore, statusCounts };
}

export async function getAvailableVehicles(transporterId: string, vehicleType?: string): Promise<VehicleRecord[]> {
  const vehiclesResult = await db.getVehiclesByTransporter(transporterId);
  const allVehicles: VehicleRecord[] = vehiclesResult && typeof vehiclesResult.then === 'function'
    ? await vehiclesResult : vehiclesResult;

  let vehicles = (allVehicles || []).filter((v) => v.isActive && (v.status === 'available' || !v.status));
  if (vehicleType) { vehicles = vehicles.filter((v) => v.vehicleType === vehicleType); }
  return vehicles;
}

export async function getVehicleTypes() {
  return getVehicleTypesCatalog();
}

export async function calculatePricing(params: {
  vehicleType: string; distanceKm: number; trucksNeeded: number;
}) {
  const rates: Record<string, number> = {
    mini: 15, lcv: 20, tipper: 25, container: 30,
    trailer: 35, tanker: 28, bulker: 32, open: 22, dumper: 27, tractor: 18
  };
  const pricePerKm = rates[params.vehicleType] || 25;
  const pricePerTruck = pricePerKm * params.distanceKm;
  const totalAmount = pricePerTruck * params.trucksNeeded;
  return {
    vehicleType: params.vehicleType, distanceKm: params.distanceKm,
    trucksNeeded: params.trucksNeeded, pricePerKm, pricePerTruck, totalAmount,
    estimatedDuration: `${Math.ceil(params.distanceKm / 50)} hours`
  };
}

// =============================================================================
// UPDATE
// =============================================================================

export async function updateVehicle(
  vehicleId: string, transporterId: string, data: UpdateVehicleInput
): Promise<VehicleRecord> {
  const vehicleResult = await db.getVehicleById(vehicleId);
  const vehicle = vehicleResult && typeof vehicleResult.then === 'function'
    ? await vehicleResult : vehicleResult;
  if (!vehicle) { throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found'); }
  if (vehicle.transporterId !== transporterId) { throw new AppError(403, 'FORBIDDEN', 'This vehicle does not belong to you'); }

  if (data.vehicleNumber && data.vehicleNumber !== vehicle.vehicleNumber) {
    const existingResult = await db.getVehicleByNumber(data.vehicleNumber);
    const existing = existingResult && typeof existingResult.then === 'function'
      ? await existingResult : existingResult;
    if (existing) { throw new AppError(400, 'VEHICLE_EXISTS', 'Vehicle with this number already exists'); }
  }

  const updatedResult = await db.updateVehicle(vehicleId, { ...data, vehicleNumber: data.vehicleNumber?.toUpperCase() });
  const updated = updatedResult && typeof updatedResult.then === 'function'
    ? await updatedResult : updatedResult;

  logger.info(`Vehicle updated: ${vehicleId}`);
  try {
    const fleetVehicles2 = await db.getVehiclesByTransporter(transporterId);
    const fleetStats = calculateStatusCounts(fleetVehicles2);
    emitToUser(transporterId, VehicleSocketEvents.VEHICLE_UPDATED, { vehicle: updated, fleetStats });
    emitToUser(transporterId, VehicleSocketEvents.FLEET_UPDATED, { action: 'updated', vehicleId, fleetStats });
  } catch (socketError) {
    logger.warn(`Failed to emit socket event for vehicle update: ${socketError}`);
  }
  return updated!;
}

export async function assignDriver(
  vehicleId: string, transporterId: string, driverId: string
): Promise<VehicleRecord> {
  const vehicleResult = await db.getVehicleById(vehicleId);
  const vehicle = vehicleResult && typeof vehicleResult.then === 'function'
    ? await vehicleResult : vehicleResult;
  if (!vehicle) { throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found'); }
  if (vehicle.transporterId !== transporterId) { throw new AppError(403, 'FORBIDDEN', 'This vehicle does not belong to you'); }

  const driverResult = await db.getUserById(driverId);
  const driver = driverResult && typeof driverResult.then === 'function'
    ? await driverResult : driverResult;
  if (!driver || driver.transporterId !== transporterId) {
    throw new AppError(400, 'INVALID_DRIVER', 'Driver not found or does not belong to you');
  }

  const updatedResult = await db.updateVehicle(vehicleId, { assignedDriverId: driverId });
  const updated = updatedResult && typeof updatedResult.then === 'function'
    ? await updatedResult : updatedResult;
  logger.info(`Driver ${driverId} assigned to vehicle ${vehicleId}`);
  return updated!;
}

export async function unassignDriver(vehicleId: string, transporterId: string): Promise<VehicleRecord> {
  const vehicleResult = await db.getVehicleById(vehicleId);
  const vehicle = vehicleResult && typeof vehicleResult.then === 'function'
    ? await vehicleResult : vehicleResult;
  if (!vehicle) { throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found'); }
  if (vehicle.transporterId !== transporterId) { throw new AppError(403, 'FORBIDDEN', 'This vehicle does not belong to you'); }

  const updatedResult = await db.updateVehicle(vehicleId, { assignedDriverId: undefined });
  const updated = updatedResult && typeof updatedResult.then === 'function'
    ? await updatedResult : updatedResult;
  logger.info(`Driver unassigned from vehicle ${vehicleId}`);
  return updated!;
}

// =============================================================================
// DELETE
// =============================================================================

export async function deleteVehicle(vehicleId: string, transporterId: string): Promise<void> {
  const vehicleResult = await db.getVehicleById(vehicleId);
  const vehicle = vehicleResult && typeof vehicleResult.then === 'function'
    ? await vehicleResult : vehicleResult;
  if (!vehicle) { throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found'); }
  if (vehicle.transporterId !== transporterId) { throw new AppError(403, 'FORBIDDEN', 'This vehicle does not belong to you'); }

  const updateResult = await db.updateVehicle(vehicleId, { isActive: false });
  if (updateResult && typeof updateResult.then === 'function') { await updateResult; }
  logger.info(`Vehicle deleted: ${vehicleId}`);

  try {
    const fleetVehiclesResult = await db.getVehiclesByTransporter(transporterId);
    const fleetVehicles = fleetVehiclesResult && typeof fleetVehiclesResult.then === 'function'
      ? await fleetVehiclesResult : fleetVehiclesResult;
    const fleetStats = calculateStatusCounts(fleetVehicles);
    emitToUser(transporterId, VehicleSocketEvents.VEHICLE_DELETED, { vehicleId, vehicleNumber: vehicle.vehicleNumber, fleetStats });
    emitToUser(transporterId, VehicleSocketEvents.FLEET_UPDATED, { action: 'deleted', vehicleId, fleetStats });
  } catch (socketError) {
    logger.warn(`Failed to emit socket event for vehicle deletion: ${socketError}`);
  }
}

// =============================================================================
// SEARCH & MATCHING
// =============================================================================

export async function getTransportersWithVehicleType(vehicleType: string, vehicleSubtype?: string): Promise<string[]> {
  return await db.getTransportersWithVehicleType(vehicleType, vehicleSubtype);
}

export async function getVehicleTypesSummary(transporterId: string): Promise<Record<string, number>> {
  const vehiclesResult = await db.getVehiclesByTransporter(transporterId);
  const allVehicles: VehicleRecord[] = vehiclesResult && typeof vehiclesResult.then === 'function'
    ? await vehiclesResult : vehiclesResult;
  const vehicles = (allVehicles || []).filter((v) => v.isActive);
  const summary: Record<string, number> = {};
  for (const vehicle of vehicles) {
    const key = `${vehicle.vehicleType}-${vehicle.vehicleSubtype}`;
    summary[key] = (summary[key] || 0) + 1;
  }
  return summary;
}
