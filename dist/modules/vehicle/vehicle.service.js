"use strict";
/**
 * =============================================================================
 * VEHICLE MODULE - SERVICE
 * =============================================================================
 *
 * Business logic for vehicle registration and management.
 * Transporters register their trucks here.
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.vehicleService = exports.VehicleSocketEvents = void 0;
const uuid_1 = require("uuid");
const db_1 = require("../../shared/database/db");
const error_types_1 = require("../../shared/types/error.types");
const logger_service_1 = require("../../shared/services/logger.service");
const socket_service_1 = require("../../shared/services/socket.service");
// Socket events for real-time vehicle updates
exports.VehicleSocketEvents = {
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
     */
    async registerVehicle(transporterId, data) {
        // Check if vehicle already registered
        const existing = db_1.db.getVehicleByNumber(data.vehicleNumber);
        if (existing) {
            throw new error_types_1.AppError(400, 'VEHICLE_EXISTS', 'Vehicle with this number already registered');
        }
        const vehicle = db_1.db.createVehicle({
            id: (0, uuid_1.v4)(),
            transporterId,
            vehicleNumber: data.vehicleNumber.toUpperCase(),
            vehicleType: data.vehicleType,
            vehicleSubtype: data.vehicleSubtype,
            capacity: data.capacity,
            model: data.model,
            year: data.year,
            status: 'available', // New vehicles start as available
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
            isVerified: false, // Will be verified after document check
            isActive: true
        });
        logger_service_1.logger.info(`Vehicle registered: ${data.vehicleNumber} (${data.vehicleType}) by ${transporterId}`);
        // =========================================================================
        // REAL-TIME UPDATE: Emit socket event to transporter
        // This ensures the fleet list auto-refreshes when a vehicle is added
        // =========================================================================
        try {
            // Get updated fleet stats for the transporter
            const fleetStats = this.calculateStatusCounts(db_1.db.getVehiclesByTransporter(transporterId));
            // Emit vehicle registered event
            (0, socket_service_1.emitToUser)(transporterId, exports.VehicleSocketEvents.VEHICLE_REGISTERED, {
                vehicle,
                fleetStats,
                message: `Vehicle ${vehicle.vehicleNumber} registered successfully`
            });
            // Also emit fleet updated for general refresh
            (0, socket_service_1.emitToUser)(transporterId, exports.VehicleSocketEvents.FLEET_UPDATED, {
                action: 'added',
                vehicleId: vehicle.id,
                fleetStats
            });
            logger_service_1.logger.debug(`Socket event emitted: ${exports.VehicleSocketEvents.VEHICLE_REGISTERED} to ${transporterId}`);
        }
        catch (socketError) {
            // Don't fail registration if socket emission fails
            logger_service_1.logger.warn(`Failed to emit socket event for vehicle registration: ${socketError}`);
        }
        return vehicle;
    }
    // ==========================================================================
    // RETRIEVAL
    // ==========================================================================
    /**
     * Get vehicle by ID
     */
    async getVehicleById(vehicleId) {
        const vehicle = db_1.db.getVehicleById(vehicleId);
        if (!vehicle) {
            throw new error_types_1.AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found');
        }
        return vehicle;
    }
    /**
     * Get vehicle by number
     */
    async getVehicleByNumber(vehicleNumber) {
        return db_1.db.getVehicleByNumber(vehicleNumber.toUpperCase()) || null;
    }
    /**
     * Get all vehicles for a transporter
     */
    async getTransporterVehicles(transporterId, query) {
        let vehicles = db_1.db.getVehiclesByTransporter(transporterId);
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
    calculateStatusCounts(vehicles) {
        const counts = {
            available: 0,
            in_transit: 0,
            maintenance: 0,
            inactive: 0,
            total: vehicles.length
        };
        for (const vehicle of vehicles) {
            if (vehicle.status && counts[vehicle.status] !== undefined) {
                counts[vehicle.status]++;
            }
            else if (!vehicle.status) {
                counts.available++; // Default to available if no status
            }
        }
        return counts;
    }
    /**
     * Normalize vehicle record - ensures all fields have valid values
     * Particularly important for the 'status' field which may be missing on older records
     */
    normalizeVehicle(vehicle) {
        return {
            ...vehicle,
            status: (vehicle.status || 'available') // Default to 'available' if missing
        };
    }
    /**
     * Normalize array of vehicles
     */
    normalizeVehicles(vehicles) {
        return vehicles.map(v => this.normalizeVehicle(v));
    }
    // ==========================================================================
    // STATUS MANAGEMENT - KEY FOR FLEET OPERATIONS
    // ==========================================================================
    /**
     * Update vehicle status
     * Called when: vehicle assigned to trip, trip completed, put in maintenance
     */
    async updateVehicleStatus(vehicleId, transporterId, newStatus, options) {
        const vehicle = db_1.db.getVehicleById(vehicleId);
        if (!vehicle) {
            throw new error_types_1.AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found');
        }
        if (vehicle.transporterId !== transporterId) {
            throw new error_types_1.AppError(403, 'FORBIDDEN', 'You can only update your own vehicles');
        }
        // Validate status transitions
        this.validateStatusTransition(vehicle.status, newStatus);
        const updates = {
            status: newStatus,
            lastStatusChange: new Date().toISOString()
        };
        // Handle specific status data
        if (newStatus === 'in_transit' && options?.tripId) {
            updates.currentTripId = options.tripId;
        }
        else if (newStatus === 'available') {
            updates.currentTripId = undefined;
            updates.maintenanceReason = undefined;
            updates.maintenanceEndDate = undefined;
        }
        else if (newStatus === 'maintenance') {
            updates.maintenanceReason = options?.maintenanceReason;
            updates.maintenanceEndDate = options?.maintenanceEndDate;
            updates.currentTripId = undefined;
        }
        const updated = db_1.db.updateVehicle(vehicleId, updates);
        if (!updated) {
            throw new error_types_1.AppError(500, 'UPDATE_FAILED', 'Failed to update vehicle status');
        }
        logger_service_1.logger.info(`Vehicle ${vehicleId} status changed: ${vehicle.status} → ${newStatus}`);
        // =========================================================================
        // REAL-TIME UPDATE: Emit socket event for status change
        // =========================================================================
        try {
            const fleetStats = this.calculateStatusCounts(db_1.db.getVehiclesByTransporter(transporterId));
            (0, socket_service_1.emitToUser)(transporterId, exports.VehicleSocketEvents.VEHICLE_STATUS_CHANGED, {
                vehicle: updated,
                previousStatus: vehicle.status,
                newStatus,
                fleetStats
            });
            (0, socket_service_1.emitToUser)(transporterId, exports.VehicleSocketEvents.FLEET_UPDATED, {
                action: 'status_changed',
                vehicleId,
                fleetStats
            });
        }
        catch (socketError) {
            logger_service_1.logger.warn(`Failed to emit socket event for status change: ${socketError}`);
        }
        return updated;
    }
    /**
     * Validate status transitions (business rules)
     */
    validateStatusTransition(currentStatus, newStatus) {
        // Define valid transitions
        const validTransitions = {
            'available': ['in_transit', 'maintenance', 'inactive'],
            'in_transit': ['available', 'maintenance'], // Trip completed or breakdown
            'maintenance': ['available', 'inactive'], // Fixed or decommissioned
            'inactive': ['available', 'maintenance'] // Reactivated
        };
        const current = currentStatus || 'available';
        if (!validTransitions[current]?.includes(newStatus)) {
            throw new error_types_1.AppError(400, 'INVALID_STATUS_TRANSITION', `Cannot change status from ${current} to ${newStatus}`);
        }
    }
    /**
     * Put vehicle in maintenance
     */
    async setMaintenance(vehicleId, transporterId, reason, expectedEndDate) {
        return this.updateVehicleStatus(vehicleId, transporterId, 'maintenance', {
            maintenanceReason: reason,
            maintenanceEndDate: expectedEndDate
        });
    }
    /**
     * Mark vehicle as available (ready for trips)
     */
    async setAvailable(vehicleId, transporterId) {
        return this.updateVehicleStatus(vehicleId, transporterId, 'available');
    }
    /**
     * Mark vehicle as in transit (assigned to a trip)
     * Usually called by booking/assignment service
     */
    async setInTransit(vehicleId, transporterId, tripId) {
        return this.updateVehicleStatus(vehicleId, transporterId, 'in_transit', { tripId });
    }
    /**
     * Get available vehicles for a transporter (ready for new trips)
     */
    async getAvailableVehicles(transporterId, vehicleType) {
        let vehicles = db_1.db.getVehiclesByTransporter(transporterId)
            .filter(v => v.isActive && (v.status === 'available' || !v.status));
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
    async calculatePricing(params) {
        // Base rates per km by vehicle type
        const rates = {
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
    async updateVehicle(vehicleId, transporterId, data) {
        const vehicle = db_1.db.getVehicleById(vehicleId);
        if (!vehicle) {
            throw new error_types_1.AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found');
        }
        if (vehicle.transporterId !== transporterId) {
            throw new error_types_1.AppError(403, 'FORBIDDEN', 'This vehicle does not belong to you');
        }
        // If changing vehicle number, check uniqueness
        if (data.vehicleNumber && data.vehicleNumber !== vehicle.vehicleNumber) {
            const existing = db_1.db.getVehicleByNumber(data.vehicleNumber);
            if (existing) {
                throw new error_types_1.AppError(400, 'VEHICLE_EXISTS', 'Vehicle with this number already exists');
            }
        }
        const updated = db_1.db.updateVehicle(vehicleId, {
            ...data,
            vehicleNumber: data.vehicleNumber?.toUpperCase()
        });
        logger_service_1.logger.info(`Vehicle updated: ${vehicleId}`);
        // =========================================================================
        // REAL-TIME UPDATE: Emit socket event for vehicle update
        // =========================================================================
        try {
            const fleetStats = this.calculateStatusCounts(db_1.db.getVehiclesByTransporter(transporterId));
            (0, socket_service_1.emitToUser)(transporterId, exports.VehicleSocketEvents.VEHICLE_UPDATED, {
                vehicle: updated,
                fleetStats
            });
            (0, socket_service_1.emitToUser)(transporterId, exports.VehicleSocketEvents.FLEET_UPDATED, {
                action: 'updated',
                vehicleId,
                fleetStats
            });
        }
        catch (socketError) {
            logger_service_1.logger.warn(`Failed to emit socket event for vehicle update: ${socketError}`);
        }
        return updated;
    }
    /**
     * Assign driver to vehicle
     */
    async assignDriver(vehicleId, transporterId, driverId) {
        const vehicle = db_1.db.getVehicleById(vehicleId);
        if (!vehicle) {
            throw new error_types_1.AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found');
        }
        if (vehicle.transporterId !== transporterId) {
            throw new error_types_1.AppError(403, 'FORBIDDEN', 'This vehicle does not belong to you');
        }
        // Verify driver belongs to this transporter
        const driver = db_1.db.getUserById(driverId);
        if (!driver || driver.transporterId !== transporterId) {
            throw new error_types_1.AppError(400, 'INVALID_DRIVER', 'Driver not found or does not belong to you');
        }
        const updated = db_1.db.updateVehicle(vehicleId, { assignedDriverId: driverId });
        logger_service_1.logger.info(`Driver ${driverId} assigned to vehicle ${vehicleId}`);
        return updated;
    }
    /**
     * Unassign driver from vehicle
     */
    async unassignDriver(vehicleId, transporterId) {
        const vehicle = db_1.db.getVehicleById(vehicleId);
        if (!vehicle) {
            throw new error_types_1.AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found');
        }
        if (vehicle.transporterId !== transporterId) {
            throw new error_types_1.AppError(403, 'FORBIDDEN', 'This vehicle does not belong to you');
        }
        const updated = db_1.db.updateVehicle(vehicleId, { assignedDriverId: undefined });
        logger_service_1.logger.info(`Driver unassigned from vehicle ${vehicleId}`);
        return updated;
    }
    // ==========================================================================
    // DELETE
    // ==========================================================================
    /**
     * Delete vehicle (soft delete - marks inactive)
     */
    async deleteVehicle(vehicleId, transporterId) {
        const vehicle = db_1.db.getVehicleById(vehicleId);
        if (!vehicle) {
            throw new error_types_1.AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found');
        }
        if (vehicle.transporterId !== transporterId) {
            throw new error_types_1.AppError(403, 'FORBIDDEN', 'This vehicle does not belong to you');
        }
        // Soft delete - mark as inactive
        db_1.db.updateVehicle(vehicleId, { isActive: false });
        logger_service_1.logger.info(`Vehicle deleted: ${vehicleId}`);
        // =========================================================================
        // REAL-TIME UPDATE: Emit socket event for vehicle deletion
        // =========================================================================
        try {
            const fleetStats = this.calculateStatusCounts(db_1.db.getVehiclesByTransporter(transporterId));
            (0, socket_service_1.emitToUser)(transporterId, exports.VehicleSocketEvents.VEHICLE_DELETED, {
                vehicleId,
                vehicleNumber: vehicle.vehicleNumber,
                fleetStats
            });
            (0, socket_service_1.emitToUser)(transporterId, exports.VehicleSocketEvents.FLEET_UPDATED, {
                action: 'deleted',
                vehicleId,
                fleetStats
            });
        }
        catch (socketError) {
            logger_service_1.logger.warn(`Failed to emit socket event for vehicle deletion: ${socketError}`);
        }
    }
    // ==========================================================================
    // SEARCH & MATCHING
    // ==========================================================================
    /**
     * Get all transporters who have a specific vehicle type
     * Used for matching customer requests to transporters
     */
    async getTransportersWithVehicleType(vehicleType, vehicleSubtype) {
        return db_1.db.getTransportersWithVehicleType(vehicleType, vehicleSubtype);
    }
    /**
     * Get vehicle types summary for a transporter
     */
    async getVehicleTypesSummary(transporterId) {
        const vehicles = db_1.db.getVehiclesByTransporter(transporterId)
            .filter(v => v.isActive);
        const summary = {};
        for (const vehicle of vehicles) {
            const key = `${vehicle.vehicleType}-${vehicle.vehicleSubtype}`;
            summary[key] = (summary[key] || 0) + 1;
        }
        return summary;
    }
}
exports.vehicleService = new VehicleService();
//# sourceMappingURL=vehicle.service.js.map