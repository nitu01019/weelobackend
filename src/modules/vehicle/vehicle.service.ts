/**
 * =============================================================================
 * VEHICLE MODULE - SERVICE
 * =============================================================================
 * 
 * Business logic for vehicle registration and management.
 * Transporters register their trucks here.
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

// Socket events for real-time vehicle updates
export const VehicleSocketEvents = {
  VEHICLE_REGISTERED: 'vehicle_registered',
  VEHICLE_UPDATED: 'vehicle_updated',
  VEHICLE_DELETED: 'vehicle_deleted',
  VEHICLE_STATUS_CHANGED: 'vehicle_status_changed',
  FLEET_UPDATED: 'fleet_updated'
};

class VehicleService {
  
  // ==========================================================================
  // REGISTRATION
  // ==========================================================================

  /**
   * Register a new vehicle
   * Called by Transporter when adding a truck to their fleet
   * 
   * @param transporterId - ID of the transporter registering the vehicle
   * @param data - Vehicle registration data
   * @param options - Optional settings
   * @param options.allowUpdate - If true, update existing vehicle instead of throwing error
   */
  async registerVehicle(
    transporterId: string,
    data: RegisterVehicleInput,
    options?: { allowUpdate?: boolean }
  ): Promise<VehicleRecord> {
    const vehicleNumber = data.vehicleNumber.toUpperCase().trim();
    
    // Check if vehicle already registered
    // IMPORTANT: db.getVehicleByNumber returns a Promise (Prisma) - must await!
    const existingResult = await db.getVehicleByNumber(vehicleNumber);
    const existing = existingResult && typeof existingResult.then === 'function' 
      ? await existingResult 
      : existingResult;
    
    if (existing) {
      // If allowUpdate is true, update the existing vehicle
      if (options?.allowUpdate) {
        return this.updateExistingVehicle(existing, transporterId, data);
      }
      
      // If vehicle belongs to same transporter, provide helpful message
      if (existing.transporterId === transporterId) {
        throw new AppError(
          409, 
          'VEHICLE_EXISTS_SAME_OWNER', 
          `Vehicle ${vehicleNumber} is already registered in your fleet. Use update instead.`,
          { vehicleId: existing.id, vehicleNumber: existing.vehicleNumber }
        );
      }
      
      // Vehicle belongs to different transporter
      throw new AppError(
        409, 
        'VEHICLE_EXISTS', 
        `Vehicle ${vehicleNumber} is already registered by another transporter.`
      );
    }

    // Generate normalized vehicle key at ONBOARDING time
    // This is critical for fast matching at booking time
    const vehicleKey = generateVehicleKey(data.vehicleType, data.vehicleSubtype);
    
    const vehicle = await db.createVehicle({
      id: uuid(),
      transporterId,
      vehicleNumber,
      vehicleType: data.vehicleType,
      vehicleSubtype: data.vehicleSubtype,
      vehicleKey,  // NORMALIZED KEY - used for fast matching at booking time
      capacity: data.capacity,
      model: data.model,
      year: data.year,
      status: 'available',  // New vehicles start as available
      lastStatusChange: new Date().toISOString(),
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
      isVerified: false,  // Will be verified after document check
      isActive: true
    });

    logger.info(`[VEHICLE] Registered: ${vehicleNumber} (${data.vehicleType}/${data.vehicleSubtype}) -> Key: ${vehicleKey} by ${transporterId}`);
    
    // =========================================================================
    // REAL-TIME UPDATE: Emit socket event to transporter
    // This ensures the fleet list auto-refreshes when a vehicle is added
    // =========================================================================
    this.emitFleetUpdate(transporterId, vehicle, 'added');
    
    return vehicle;
  }

  /**
   * Register or Update vehicle (Upsert)
   * If vehicle exists and belongs to same transporter, update it
   * If vehicle doesn't exist, create it
   * 
   * Use this for "save" operations where user might be editing existing vehicle
   */
  async registerOrUpdateVehicle(
    transporterId: string,
    data: RegisterVehicleInput
  ): Promise<{ vehicle: VehicleRecord; isNew: boolean }> {
    const vehicleNumber = data.vehicleNumber.toUpperCase().trim();
    
    // IMPORTANT: db.getVehicleByNumber returns a Promise (Prisma) - must await!
    const existingResult = await db.getVehicleByNumber(vehicleNumber);
    const existing = existingResult && typeof existingResult.then === 'function' 
      ? await existingResult 
      : existingResult;
    
    if (existing) {
      // Check ownership
      if (existing.transporterId !== transporterId) {
        throw new AppError(
          409, 
          'VEHICLE_EXISTS', 
          `Vehicle ${vehicleNumber} is already registered by another transporter.`
        );
      }
      
      // Update existing vehicle
      const updated = await this.updateExistingVehicle(existing, transporterId, data);
      return { vehicle: updated, isNew: false };
    }
    
    // Create new vehicle
    const vehicle = await this.registerVehicle(transporterId, data);
    return { vehicle, isNew: true };
  }

  /**
   * Check if a vehicle number is available for registration
   * Returns info about existing vehicle if it exists
   */
  async checkVehicleAvailability(
    vehicleNumber: string,
    transporterId?: string
  ): Promise<{
    available: boolean;
    exists: boolean;
    ownedByYou: boolean;
    vehicleId?: string;
    message: string;
  }> {
    const normalized = vehicleNumber.toUpperCase().trim();
    
    // IMPORTANT: db.getVehicleByNumber returns a Promise (Prisma) - must await!
    const existingResult = await db.getVehicleByNumber(normalized);
    const existing = existingResult && typeof existingResult.then === 'function' 
      ? await existingResult 
      : existingResult;
    
    if (!existing) {
      return {
        available: true,
        exists: false,
        ownedByYou: false,
        message: 'Vehicle number is available for registration'
      };
    }
    
    const ownedByYou = transporterId ? existing.transporterId === transporterId : false;
    
    return {
      available: false,
      exists: true,
      ownedByYou,
      vehicleId: existing.id,
      message: ownedByYou 
        ? 'This vehicle is already in your fleet. You can update it.'
        : 'This vehicle is registered by another transporter.'
    };
  }

  /**
   * Update an existing vehicle with new registration data
   * Internal method used by registerVehicle and registerOrUpdateVehicle
   */
  private async updateExistingVehicle(
    existing: VehicleRecord,
    transporterId: string,
    data: RegisterVehicleInput
  ): Promise<VehicleRecord> {
    // Verify ownership
    if (existing.transporterId !== transporterId) {
      throw new AppError(403, 'FORBIDDEN', 'This vehicle does not belong to you');
    }

    // Generate new vehicle key if type/subtype changed
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
      isActive: true  // Reactivate if it was inactive
    });

    if (!updated) {
      throw new AppError(500, 'UPDATE_FAILED', 'Failed to update vehicle');
    }

    logger.info(`[VEHICLE] Updated: ${existing.vehicleNumber} by ${transporterId}`);
    
    // Emit socket update
    this.emitFleetUpdate(transporterId, updated, 'updated');
    
    return updated;
  }

  /**
   * Emit fleet update socket events
   * Centralized method for consistent real-time updates
   */
  private async emitFleetUpdate(
    transporterId: string, 
    vehicle: VehicleRecord, 
    action: 'added' | 'updated' | 'deleted' | 'status_changed'
  ): Promise<void> {
    try {
      const fleetVehicles = await db.getVehiclesByTransporter(transporterId);
      const fleetStats = this.calculateStatusCounts(fleetVehicles);
      
      // Emit specific event
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
      
      // Also emit fleet updated for general refresh
      emitToUser(transporterId, VehicleSocketEvents.FLEET_UPDATED, {
        action,
        vehicleId: vehicle.id,
        fleetStats
      });
      
      logger.debug(`[SOCKET] ${eventName} emitted to ${transporterId}`);
    } catch (socketError) {
      // Don't fail operation if socket emission fails
      logger.warn(`[SOCKET] Failed to emit fleet update: ${socketError}`);
    }
  }

  // ==========================================================================
  // RETRIEVAL
  // ==========================================================================

  /**
   * Get vehicle by ID
   */
  async getVehicleById(vehicleId: string): Promise<VehicleRecord> {
    // IMPORTANT: db methods return Promises (Prisma) - must await!
    const vehicleResult = await db.getVehicleById(vehicleId);
    const vehicle = vehicleResult && typeof vehicleResult.then === 'function' 
      ? await vehicleResult 
      : vehicleResult;
    if (!vehicle) {
      throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found');
    }
    return vehicle;
  }

  /**
   * Get vehicle by number
   */
  async getVehicleByNumber(vehicleNumber: string): Promise<VehicleRecord | null> {
    // IMPORTANT: db methods return Promises (Prisma) - must await!
    const vehicleResult = await db.getVehicleByNumber(vehicleNumber.toUpperCase());
    const vehicle = vehicleResult && typeof vehicleResult.then === 'function' 
      ? await vehicleResult 
      : vehicleResult;
    return vehicle || null;
  }

  /**
   * Get all vehicles for a transporter
   */
  async getTransporterVehicles(
    transporterId: string,
    query: GetVehiclesQuery
  ): Promise<{ vehicles: VehicleRecord[]; total: number; hasMore: boolean; statusCounts: Record<string, number> }> {
    // IMPORTANT: db methods return Promises (Prisma) - must await!
    const vehiclesResult = await db.getVehiclesByTransporter(transporterId);
    let vehicles = vehiclesResult && typeof vehiclesResult.then === 'function' 
      ? await vehiclesResult 
      : vehiclesResult;

    // Calculate status counts BEFORE filtering (for dashboard stats)
    const statusCounts = this.calculateStatusCounts(vehicles);

    // Filter by type if specified
    if (query.vehicleType) {
      vehicles = vehicles.filter(v => v.vehicleType === query.vehicleType);
    }

    // Filter by status if specified
    if (query.status) {
      vehicles = vehicles.filter(v => v.status === query.status);
    }

    // Filter by active status if specified
    if (query.isActive !== undefined) {
      vehicles = vehicles.filter(v => v.isActive === query.isActive);
    }

    const total = vehicles.length;

    // Pagination
    const start = (query.page - 1) * query.limit;
    vehicles = vehicles.slice(start, start + query.limit);
    const hasMore = start + vehicles.length < total;

    // Normalize vehicles to ensure all have valid status
    const normalizedVehicles = this.normalizeVehicles(vehicles);

    return { vehicles: normalizedVehicles, total, hasMore, statusCounts };
  }

  /**
   * Calculate vehicle counts by status
   * Note: Vehicles without a status field are counted as 'available' (default state)
   */
  private calculateStatusCounts(vehicles: VehicleRecord[]): Record<string, number> {
    const counts: Record<string, number> = {
      available: 0,
      in_transit: 0,
      maintenance: 0,
      inactive: 0,
      total: vehicles.length
    };
    
    for (const vehicle of vehicles) {
      if (vehicle.status && counts[vehicle.status] !== undefined) {
        counts[vehicle.status]++;
      } else if (!vehicle.status) {
        counts.available++; // Default to available if no status
      }
    }
    
    return counts;
  }
  
  /**
   * Normalize vehicle record - ensures all fields have valid values
   * Particularly important for the 'status' field which may be missing on older records
   */
  private normalizeVehicle(vehicle: VehicleRecord): VehicleRecord {
    return {
      ...vehicle,
      status: (vehicle.status || 'available') as VehicleStatus  // Default to 'available' if missing
    };
  }
  
  /**
   * Normalize array of vehicles
   */
  private normalizeVehicles(vehicles: VehicleRecord[]): VehicleRecord[] {
    return vehicles.map(v => this.normalizeVehicle(v));
  }

  // ==========================================================================
  // STATUS MANAGEMENT - KEY FOR FLEET OPERATIONS
  // ==========================================================================

  /**
   * Update vehicle status
   * Called when: vehicle assigned to trip, trip completed, put in maintenance
   */
  async updateVehicleStatus(
    vehicleId: string,
    transporterId: string,
    newStatus: VehicleStatus,
    options?: {
      tripId?: string;
      maintenanceReason?: string;
      maintenanceEndDate?: string;
    }
  ): Promise<VehicleRecord> {
    // IMPORTANT: db methods return Promises (Prisma) - must await!
    const vehicleResult = await db.getVehicleById(vehicleId);
    const vehicle = vehicleResult && typeof vehicleResult.then === 'function' 
      ? await vehicleResult 
      : vehicleResult;
    
    if (!vehicle) {
      throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found');
    }
    
    if (vehicle.transporterId !== transporterId) {
      throw new AppError(403, 'FORBIDDEN', 'You can only update your own vehicles');
    }

    // Validate status transitions
    this.validateStatusTransition(vehicle.status, newStatus);

    const updates: Partial<VehicleRecord> = {
      status: newStatus,
      lastStatusChange: new Date().toISOString()
    };

    // Handle specific status data
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
      ? await updatedResult 
      : updatedResult;
    
    if (!updated) {
      throw new AppError(500, 'UPDATE_FAILED', 'Failed to update vehicle status');
    }

    logger.info(`Vehicle ${vehicleId} status changed: ${vehicle.status} → ${newStatus}`);
    
    // =========================================================================
    // REAL-TIME UPDATE: Emit socket event for status change
    // =========================================================================
    try {
      const fleetVehiclesResult = await db.getVehiclesByTransporter(transporterId);
      const fleetVehicles = fleetVehiclesResult && typeof fleetVehiclesResult.then === 'function' 
        ? await fleetVehiclesResult 
        : fleetVehiclesResult;
      const fleetStats = this.calculateStatusCounts(fleetVehicles);
      
      emitToUser(transporterId, VehicleSocketEvents.VEHICLE_STATUS_CHANGED, {
        vehicle: updated,
        previousStatus: vehicle.status,
        newStatus,
        fleetStats
      });
      
      emitToUser(transporterId, VehicleSocketEvents.FLEET_UPDATED, {
        action: 'status_changed',
        vehicleId,
        fleetStats
      });
    } catch (socketError) {
      logger.warn(`Failed to emit socket event for status change: ${socketError}`);
    }
    
    return updated;
  }

  /**
   * Validate status transitions (business rules)
   */
  private validateStatusTransition(currentStatus: VehicleStatus | undefined, newStatus: VehicleStatus): void {
    // Define valid transitions
    const validTransitions: Record<string, string[]> = {
      'available': ['in_transit', 'maintenance', 'inactive'],
      'in_transit': ['available', 'maintenance'],  // Trip completed or breakdown
      'maintenance': ['available', 'inactive'],     // Fixed or decommissioned
      'inactive': ['available', 'maintenance']      // Reactivated
    };

    const current = currentStatus || 'available';
    
    if (!validTransitions[current]?.includes(newStatus)) {
      throw new AppError(
        400, 
        'INVALID_STATUS_TRANSITION', 
        `Cannot change status from ${current} to ${newStatus}`
      );
    }
  }

  /**
   * Put vehicle in maintenance
   */
  async setMaintenance(
    vehicleId: string,
    transporterId: string,
    reason: string,
    expectedEndDate?: string
  ): Promise<VehicleRecord> {
    return this.updateVehicleStatus(vehicleId, transporterId, 'maintenance', {
      maintenanceReason: reason,
      maintenanceEndDate: expectedEndDate
    });
  }

  /**
   * Mark vehicle as available (ready for trips)
   */
  async setAvailable(vehicleId: string, transporterId: string): Promise<VehicleRecord> {
    return this.updateVehicleStatus(vehicleId, transporterId, 'available');
  }

  /**
   * Mark vehicle as in transit (assigned to a trip)
   * Usually called by booking/assignment service
   */
  async setInTransit(vehicleId: string, transporterId: string, tripId: string): Promise<VehicleRecord> {
    return this.updateVehicleStatus(vehicleId, transporterId, 'in_transit', { tripId });
  }

  /**
   * Get available vehicles for a transporter (ready for new trips)
   */
  async getAvailableVehicles(transporterId: string, vehicleType?: string): Promise<VehicleRecord[]> {
    // IMPORTANT: db methods return Promises (Prisma) - must await!
    const vehiclesResult = await db.getVehiclesByTransporter(transporterId);
    const allVehicles = vehiclesResult && typeof vehiclesResult.then === 'function' 
      ? await vehiclesResult 
      : vehiclesResult;
    
    let vehicles = (allVehicles || []).filter(v => v.isActive && (v.status === 'available' || !v.status));
    
    if (vehicleType) {
      vehicles = vehicles.filter(v => v.vehicleType === vehicleType);
    }
    
    return vehicles;
  }

  /**
   * Get vehicle types catalog (static)
   */
  async getVehicleTypes() {
    return [
      { type: 'mini', name: 'Mini Truck', subtypes: ['Tata Ace', 'Mahindra Bolero', 'Ashok Leyland Dost'] },
      { type: 'lcv', name: 'LCV', subtypes: ['14 Feet', '17 Feet', '19 Feet'] },
      { type: 'tipper', name: 'Tipper', subtypes: ['10-12 Ton', '16-18 Ton', '20-24 Ton'] },
      { type: 'container', name: 'Container', subtypes: ['20 Feet', '24 Feet', '32 Feet', '40 Feet'] },
      { type: 'trailer', name: 'Trailer', subtypes: ['20 Feet', '22 Feet', '40 Feet'] },
      { type: 'tanker', name: 'Tanker', subtypes: ['10 KL', '12 KL', '16 KL', '20 KL'] },
      { type: 'bulker', name: 'Bulker', subtypes: ['22 MT', '25 MT', '30 MT', '35 MT'] },
      { type: 'open', name: 'Open Body', subtypes: ['14 Feet', '17 Feet', '19 Feet', '22 Feet'] },
      { type: 'dumper', name: 'Dumper', subtypes: ['10 Wheel', '12 Wheel', '14 Wheel'] },
      { type: 'tractor', name: 'Tractor Trolley', subtypes: ['Single Trolley', 'Double Trolley'] }
    ];
  }

  /**
   * Calculate pricing for a route
   */
  async calculatePricing(params: {
    vehicleType: string;
    distanceKm: number;
    trucksNeeded: number;
  }) {
    // Base rates per km by vehicle type
    const rates: Record<string, number> = {
      mini: 15, lcv: 20, tipper: 25, container: 30,
      trailer: 35, tanker: 28, bulker: 32, open: 22, dumper: 27, tractor: 18
    };
    
    const pricePerKm = rates[params.vehicleType] || 25;
    const pricePerTruck = pricePerKm * params.distanceKm;
    const totalAmount = pricePerTruck * params.trucksNeeded;
    
    return {
      vehicleType: params.vehicleType,
      distanceKm: params.distanceKm,
      trucksNeeded: params.trucksNeeded,
      pricePerKm,
      pricePerTruck,
      totalAmount,
      estimatedDuration: `${Math.ceil(params.distanceKm / 50)} hours`
    };
  }

  // ==========================================================================
  // UPDATE
  // ==========================================================================

  /**
   * Update vehicle details
   */
  async updateVehicle(
    vehicleId: string,
    transporterId: string,
    data: UpdateVehicleInput
  ): Promise<VehicleRecord> {
    // IMPORTANT: db methods return Promises (Prisma) - must await!
    const vehicleResult = await db.getVehicleById(vehicleId);
    const vehicle = vehicleResult && typeof vehicleResult.then === 'function' 
      ? await vehicleResult 
      : vehicleResult;
    
    if (!vehicle) {
      throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found');
    }
    
    if (vehicle.transporterId !== transporterId) {
      throw new AppError(403, 'FORBIDDEN', 'This vehicle does not belong to you');
    }

    // If changing vehicle number, check uniqueness
    if (data.vehicleNumber && data.vehicleNumber !== vehicle.vehicleNumber) {
      const existingResult = await db.getVehicleByNumber(data.vehicleNumber);
      const existing = existingResult && typeof existingResult.then === 'function' 
        ? await existingResult 
        : existingResult;
      if (existing) {
        throw new AppError(400, 'VEHICLE_EXISTS', 'Vehicle with this number already exists');
      }
    }

    const updatedResult = await db.updateVehicle(vehicleId, {
      ...data,
      vehicleNumber: data.vehicleNumber?.toUpperCase()
    });
    const updated = updatedResult && typeof updatedResult.then === 'function' 
      ? await updatedResult 
      : updatedResult;

    logger.info(`Vehicle updated: ${vehicleId}`);
    
    // =========================================================================
    // REAL-TIME UPDATE: Emit socket event for vehicle update
    // =========================================================================
    try {
      const fleetVehicles2 = await db.getVehiclesByTransporter(transporterId);
      const fleetStats = this.calculateStatusCounts(fleetVehicles2);
      
      emitToUser(transporterId, VehicleSocketEvents.VEHICLE_UPDATED, {
        vehicle: updated,
        fleetStats
      });
      
      emitToUser(transporterId, VehicleSocketEvents.FLEET_UPDATED, {
        action: 'updated',
        vehicleId,
        fleetStats
      });
    } catch (socketError) {
      logger.warn(`Failed to emit socket event for vehicle update: ${socketError}`);
    }
    
    return updated!;
  }

  /**
   * Assign driver to vehicle
   */
  async assignDriver(
    vehicleId: string,
    transporterId: string,
    driverId: string
  ): Promise<VehicleRecord> {
    // IMPORTANT: db methods return Promises (Prisma) - must await!
    const vehicleResult = await db.getVehicleById(vehicleId);
    const vehicle = vehicleResult && typeof vehicleResult.then === 'function' 
      ? await vehicleResult 
      : vehicleResult;
    
    if (!vehicle) {
      throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found');
    }
    
    if (vehicle.transporterId !== transporterId) {
      throw new AppError(403, 'FORBIDDEN', 'This vehicle does not belong to you');
    }

    // Verify driver belongs to this transporter
    const driverResult = await db.getUserById(driverId);
    const driver = driverResult && typeof driverResult.then === 'function' 
      ? await driverResult 
      : driverResult;
    if (!driver || driver.transporterId !== transporterId) {
      throw new AppError(400, 'INVALID_DRIVER', 'Driver not found or does not belong to you');
    }

    const updatedResult = await db.updateVehicle(vehicleId, { assignedDriverId: driverId });
    const updated = updatedResult && typeof updatedResult.then === 'function' 
      ? await updatedResult 
      : updatedResult;
    
    logger.info(`Driver ${driverId} assigned to vehicle ${vehicleId}`);
    return updated!;
  }

  /**
   * Unassign driver from vehicle
   */
  async unassignDriver(
    vehicleId: string,
    transporterId: string
  ): Promise<VehicleRecord> {
    // IMPORTANT: db methods return Promises (Prisma) - must await!
    const vehicleResult = await db.getVehicleById(vehicleId);
    const vehicle = vehicleResult && typeof vehicleResult.then === 'function' 
      ? await vehicleResult 
      : vehicleResult;
    
    if (!vehicle) {
      throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found');
    }
    
    if (vehicle.transporterId !== transporterId) {
      throw new AppError(403, 'FORBIDDEN', 'This vehicle does not belong to you');
    }

    const updatedResult = await db.updateVehicle(vehicleId, { assignedDriverId: undefined });
    const updated = updatedResult && typeof updatedResult.then === 'function' 
      ? await updatedResult 
      : updatedResult;
    
    logger.info(`Driver unassigned from vehicle ${vehicleId}`);
    return updated!;
  }

  // ==========================================================================
  // DELETE
  // ==========================================================================

  /**
   * Delete vehicle (soft delete - marks inactive)
   */
  async deleteVehicle(vehicleId: string, transporterId: string): Promise<void> {
    // IMPORTANT: db methods return Promises (Prisma) - must await!
    const vehicleResult = await db.getVehicleById(vehicleId);
    const vehicle = vehicleResult && typeof vehicleResult.then === 'function' 
      ? await vehicleResult 
      : vehicleResult;
    
    if (!vehicle) {
      throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found');
    }
    
    if (vehicle.transporterId !== transporterId) {
      throw new AppError(403, 'FORBIDDEN', 'This vehicle does not belong to you');
    }

    // Soft delete - mark as inactive
    const updateResult = await db.updateVehicle(vehicleId, { isActive: false });
    if (updateResult && typeof updateResult.then === 'function') {
      await updateResult;
    }
    
    logger.info(`Vehicle deleted: ${vehicleId}`);
    
    // =========================================================================
    // REAL-TIME UPDATE: Emit socket event for vehicle deletion
    // =========================================================================
    try {
      const fleetVehiclesResult = await db.getVehiclesByTransporter(transporterId);
      const fleetVehicles = fleetVehiclesResult && typeof fleetVehiclesResult.then === 'function' 
        ? await fleetVehiclesResult 
        : fleetVehiclesResult;
      const fleetStats = this.calculateStatusCounts(fleetVehicles);
      
      emitToUser(transporterId, VehicleSocketEvents.VEHICLE_DELETED, {
        vehicleId,
        vehicleNumber: vehicle.vehicleNumber,
        fleetStats
      });
      
      emitToUser(transporterId, VehicleSocketEvents.FLEET_UPDATED, {
        action: 'deleted',
        vehicleId,
        fleetStats
      });
    } catch (socketError) {
      logger.warn(`Failed to emit socket event for vehicle deletion: ${socketError}`);
    }
  }

  // ==========================================================================
  // SEARCH & MATCHING
  // ==========================================================================

  /**
   * Get all transporters who have a specific vehicle type
   * Used for matching customer requests to transporters
   */
  async getTransportersWithVehicleType(
    vehicleType: string,
    vehicleSubtype?: string
  ): Promise<string[]> {
    return await db.getTransportersWithVehicleType(vehicleType, vehicleSubtype);
  }

  /**
   * Get vehicle types summary for a transporter
   */
  async getVehicleTypesSummary(transporterId: string): Promise<Record<string, number>> {
    // IMPORTANT: db methods return Promises (Prisma) - must await!
    const vehiclesResult = await db.getVehiclesByTransporter(transporterId);
    const allVehicles = vehiclesResult && typeof vehiclesResult.then === 'function' 
      ? await vehiclesResult 
      : vehiclesResult;
    
    const vehicles = (allVehicles || []).filter(v => v.isActive);

    const summary: Record<string, number> = {};
    for (const vehicle of vehicles) {
      const key = `${vehicle.vehicleType}-${vehicle.vehicleSubtype}`;
      summary[key] = (summary[key] || 0) + 1;
    }

    return summary;
  }
}

export const vehicleService = new VehicleService();
