/**
 * =============================================================================
 * VEHICLE MODULE - SERVICE
 * =============================================================================
 *
 * Business logic for vehicle registration and management.
 * Transporters register their trucks here.
 * =============================================================================
 */
import { VehicleRecord, VehicleStatus } from '../../shared/database/db';
import { RegisterVehicleInput, UpdateVehicleInput, GetVehiclesQuery } from './vehicle.schema';
export declare const VehicleSocketEvents: {
    VEHICLE_REGISTERED: string;
    VEHICLE_UPDATED: string;
    VEHICLE_DELETED: string;
    VEHICLE_STATUS_CHANGED: string;
    FLEET_UPDATED: string;
};
declare class VehicleService {
    /**
     * Register a new vehicle
     * Called by Transporter when adding a truck to their fleet
     */
    registerVehicle(transporterId: string, data: RegisterVehicleInput): Promise<VehicleRecord>;
    /**
     * Get vehicle by ID
     */
    getVehicleById(vehicleId: string): Promise<VehicleRecord>;
    /**
     * Get vehicle by number
     */
    getVehicleByNumber(vehicleNumber: string): Promise<VehicleRecord | null>;
    /**
     * Get all vehicles for a transporter
     */
    getTransporterVehicles(transporterId: string, query: GetVehiclesQuery): Promise<{
        vehicles: VehicleRecord[];
        total: number;
        hasMore: boolean;
        statusCounts: Record<string, number>;
    }>;
    /**
     * Calculate vehicle counts by status
     * Note: Vehicles without a status field are counted as 'available' (default state)
     */
    private calculateStatusCounts;
    /**
     * Normalize vehicle record - ensures all fields have valid values
     * Particularly important for the 'status' field which may be missing on older records
     */
    private normalizeVehicle;
    /**
     * Normalize array of vehicles
     */
    private normalizeVehicles;
    /**
     * Update vehicle status
     * Called when: vehicle assigned to trip, trip completed, put in maintenance
     */
    updateVehicleStatus(vehicleId: string, transporterId: string, newStatus: VehicleStatus, options?: {
        tripId?: string;
        maintenanceReason?: string;
        maintenanceEndDate?: string;
    }): Promise<VehicleRecord>;
    /**
     * Validate status transitions (business rules)
     */
    private validateStatusTransition;
    /**
     * Put vehicle in maintenance
     */
    setMaintenance(vehicleId: string, transporterId: string, reason: string, expectedEndDate?: string): Promise<VehicleRecord>;
    /**
     * Mark vehicle as available (ready for trips)
     */
    setAvailable(vehicleId: string, transporterId: string): Promise<VehicleRecord>;
    /**
     * Mark vehicle as in transit (assigned to a trip)
     * Usually called by booking/assignment service
     */
    setInTransit(vehicleId: string, transporterId: string, tripId: string): Promise<VehicleRecord>;
    /**
     * Get available vehicles for a transporter (ready for new trips)
     */
    getAvailableVehicles(transporterId: string, vehicleType?: string): Promise<VehicleRecord[]>;
    /**
     * Get vehicle types catalog (static)
     */
    getVehicleTypes(): Promise<{
        type: string;
        name: string;
        subtypes: string[];
    }[]>;
    /**
     * Calculate pricing for a route
     */
    calculatePricing(params: {
        vehicleType: string;
        distanceKm: number;
        trucksNeeded: number;
    }): Promise<{
        vehicleType: string;
        distanceKm: number;
        trucksNeeded: number;
        pricePerKm: number;
        pricePerTruck: number;
        totalAmount: number;
        estimatedDuration: string;
    }>;
    /**
     * Update vehicle details
     */
    updateVehicle(vehicleId: string, transporterId: string, data: UpdateVehicleInput): Promise<VehicleRecord>;
    /**
     * Assign driver to vehicle
     */
    assignDriver(vehicleId: string, transporterId: string, driverId: string): Promise<VehicleRecord>;
    /**
     * Unassign driver from vehicle
     */
    unassignDriver(vehicleId: string, transporterId: string): Promise<VehicleRecord>;
    /**
     * Delete vehicle (soft delete - marks inactive)
     */
    deleteVehicle(vehicleId: string, transporterId: string): Promise<void>;
    /**
     * Get all transporters who have a specific vehicle type
     * Used for matching customer requests to transporters
     */
    getTransportersWithVehicleType(vehicleType: string, vehicleSubtype?: string): Promise<string[]>;
    /**
     * Get vehicle types summary for a transporter
     */
    getVehicleTypesSummary(transporterId: string): Promise<Record<string, number>>;
}
export declare const vehicleService: VehicleService;
export {};
//# sourceMappingURL=vehicle.service.d.ts.map