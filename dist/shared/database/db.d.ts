/**
 * =============================================================================
 * DATABASE SERVICE - Persistent JSON File Storage
 * =============================================================================
 *
 * Simple file-based database that stores data on your Mac.
 * Data persists across server restarts.
 *
 * SECURITY:
 * - Data stored locally on your machine only
 * - No external database connection needed
 * - Passwords are hashed (if needed)
 * =============================================================================
 */
export interface Database {
    users: UserRecord[];
    vehicles: VehicleRecord[];
    bookings: BookingRecord[];
    orders: OrderRecord[];
    truckRequests: TruckRequestRecord[];
    assignments: AssignmentRecord[];
    tracking: TrackingRecord[];
    _meta: {
        version: string;
        lastUpdated: string;
    };
}
export interface UserRecord {
    id: string;
    phone: string;
    role: 'customer' | 'transporter' | 'driver';
    name: string;
    email?: string;
    profilePhoto?: string;
    company?: string;
    gstNumber?: string;
    businessName?: string;
    businessAddress?: string;
    panNumber?: string;
    transporterId?: string;
    licenseNumber?: string;
    licenseExpiry?: string;
    aadharNumber?: string;
    isVerified: boolean;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
}
export type VehicleStatus = 'available' | 'in_transit' | 'maintenance' | 'inactive';
export interface VehicleRecord {
    id: string;
    transporterId: string;
    assignedDriverId?: string;
    vehicleNumber: string;
    vehicleType: string;
    vehicleSubtype: string;
    capacity: string;
    model?: string;
    year?: number;
    status: VehicleStatus;
    currentTripId?: string;
    maintenanceReason?: string;
    maintenanceEndDate?: string;
    lastStatusChange?: string;
    rcNumber?: string;
    rcExpiry?: string;
    insuranceNumber?: string;
    insuranceExpiry?: string;
    permitNumber?: string;
    permitExpiry?: string;
    fitnessExpiry?: string;
    vehiclePhotos?: string[];
    rcPhoto?: string;
    insurancePhoto?: string;
    isVerified: boolean;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
}
export interface BookingRecord {
    id: string;
    customerId: string;
    customerName: string;
    customerPhone: string;
    pickup: {
        latitude: number;
        longitude: number;
        address: string;
        city?: string;
        state?: string;
    };
    drop: {
        latitude: number;
        longitude: number;
        address: string;
        city?: string;
        state?: string;
    };
    vehicleType: string;
    vehicleSubtype: string;
    trucksNeeded: number;
    trucksFilled: number;
    distanceKm: number;
    pricePerTruck: number;
    totalAmount: number;
    goodsType?: string;
    weight?: string;
    status: 'active' | 'partially_filled' | 'fully_filled' | 'in_progress' | 'completed' | 'cancelled' | 'expired';
    notifiedTransporters: string[];
    scheduledAt?: string;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
}
export interface OrderRecord {
    id: string;
    customerId: string;
    customerName: string;
    customerPhone: string;
    pickup: {
        latitude: number;
        longitude: number;
        address: string;
        city?: string;
        state?: string;
    };
    drop: {
        latitude: number;
        longitude: number;
        address: string;
        city?: string;
        state?: string;
    };
    distanceKm: number;
    totalTrucks: number;
    trucksFilled: number;
    totalAmount: number;
    goodsType?: string;
    weight?: string;
    cargoWeightKg?: number;
    status: 'active' | 'partially_filled' | 'fully_filled' | 'in_progress' | 'completed' | 'cancelled' | 'expired';
    scheduledAt?: string;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
}
export interface TruckRequestRecord {
    id: string;
    orderId: string;
    requestNumber: number;
    vehicleType: string;
    vehicleSubtype: string;
    pricePerTruck: number;
    status: 'searching' | 'assigned' | 'accepted' | 'in_progress' | 'completed' | 'cancelled' | 'expired';
    assignedTransporterId?: string;
    assignedTransporterName?: string;
    assignedVehicleId?: string;
    assignedVehicleNumber?: string;
    assignedDriverId?: string;
    assignedDriverName?: string;
    assignedDriverPhone?: string;
    tripId?: string;
    notifiedTransporters: string[];
    assignedAt?: string;
    createdAt: string;
    updatedAt: string;
}
export interface AssignmentRecord {
    id: string;
    bookingId: string;
    truckRequestId?: string;
    orderId?: string;
    transporterId: string;
    transporterName: string;
    vehicleId: string;
    vehicleNumber: string;
    vehicleType: string;
    vehicleSubtype: string;
    driverId: string;
    driverName: string;
    driverPhone: string;
    tripId: string;
    status: 'pending' | 'driver_accepted' | 'driver_declined' | 'en_route_pickup' | 'at_pickup' | 'in_transit' | 'completed' | 'cancelled';
    assignedAt: string;
    driverAcceptedAt?: string;
    startedAt?: string;
    completedAt?: string;
}
export interface TrackingRecord {
    tripId: string;
    driverId: string;
    vehicleNumber: string;
    bookingId: string;
    latitude: number;
    longitude: number;
    speed: number;
    bearing: number;
    status: string;
    lastUpdated: string;
}
/**
 * Database class - handles all CRUD operations
 */
declare class DatabaseService {
    private data;
    private saveTimeout;
    constructor();
    /**
     * Load database from file
     */
    private load;
    /**
     * Save database to file (debounced)
     */
    private save;
    /**
     * Synchronous save
     */
    private saveSync;
    /**
     * Create or update user
     */
    createUser(user: Omit<UserRecord, 'createdAt' | 'updatedAt'>): UserRecord;
    /**
     * Get user by ID
     */
    getUserById(id: string): UserRecord | undefined;
    /**
     * Get user by phone and role
     */
    getUserByPhone(phone: string, role: string): UserRecord | undefined;
    /**
     * Get all drivers for a transporter
     */
    getDriversByTransporter(transporterId: string): UserRecord[];
    /**
     * Update user
     */
    updateUser(id: string, updates: Partial<UserRecord>): UserRecord | undefined;
    /**
     * Register vehicle
     */
    createVehicle(vehicle: Omit<VehicleRecord, 'createdAt' | 'updatedAt'>): VehicleRecord;
    /**
     * Get vehicle by ID
     */
    getVehicleById(id: string): VehicleRecord | undefined;
    /**
     * Get vehicle by number
     */
    getVehicleByNumber(vehicleNumber: string): VehicleRecord | undefined;
    /**
     * Get all vehicles for a transporter
     */
    getVehiclesByTransporter(transporterId: string): VehicleRecord[];
    /**
     * Get all vehicles of a specific type
     */
    getVehiclesByType(vehicleType: string): VehicleRecord[];
    /**
     * Get transporters who have specific vehicle type
     * This is the KEY function for matching bookings to transporters!
     */
    getTransportersWithVehicleType(vehicleType: string, vehicleSubtype?: string): string[];
    /**
     * Update vehicle
     */
    updateVehicle(id: string, updates: Partial<VehicleRecord>): VehicleRecord | undefined;
    /**
     * Delete vehicle
     */
    deleteVehicle(id: string): boolean;
    /**
     * Create booking
     */
    createBooking(booking: Omit<BookingRecord, 'createdAt' | 'updatedAt'>): BookingRecord;
    /**
     * Get booking by ID
     */
    getBookingById(id: string): BookingRecord | undefined;
    /**
     * Get bookings by customer
     */
    getBookingsByCustomer(customerId: string): BookingRecord[];
    /**
     * Get bookings by driver (from assignments)
     */
    getBookingsByDriver(driverId: string): BookingRecord[];
    /**
     * Get active bookings for a transporter (based on vehicle types they have)
     */
    getActiveBookingsForTransporter(transporterId: string): BookingRecord[];
    /**
     * Update booking
     */
    updateBooking(id: string, updates: Partial<BookingRecord>): BookingRecord | undefined;
    /**
     * Create order
     */
    createOrder(order: Omit<OrderRecord, 'createdAt' | 'updatedAt'>): OrderRecord;
    /**
     * Get order by ID
     */
    getOrderById(id: string): OrderRecord | undefined;
    /**
     * Get orders by customer
     */
    getOrdersByCustomer(customerId: string): OrderRecord[];
    /**
     * Update order
     */
    updateOrder(id: string, updates: Partial<OrderRecord>): OrderRecord | undefined;
    /**
     * Create truck request
     */
    createTruckRequest(request: Omit<TruckRequestRecord, 'createdAt' | 'updatedAt'>): TruckRequestRecord;
    /**
     * Create multiple truck requests at once (batch)
     */
    createTruckRequestsBatch(requests: Omit<TruckRequestRecord, 'createdAt' | 'updatedAt'>[]): TruckRequestRecord[];
    /**
     * Get truck request by ID
     */
    getTruckRequestById(id: string): TruckRequestRecord | undefined;
    /**
     * Get truck requests by order ID
     */
    getTruckRequestsByOrder(orderId: string): TruckRequestRecord[];
    /**
     * Get active truck requests for a transporter (based on vehicle types they have)
     */
    getActiveTruckRequestsForTransporter(transporterId: string): TruckRequestRecord[];
    /**
     * Get truck requests by vehicle type (for broadcasting)
     */
    getTruckRequestsByVehicleType(vehicleType: string, vehicleSubtype?: string): TruckRequestRecord[];
    /**
     * Update truck request
     */
    updateTruckRequest(id: string, updates: Partial<TruckRequestRecord>): TruckRequestRecord | undefined;
    /**
     * Update multiple truck requests (for batch expiry, etc.)
     */
    updateTruckRequestsBatch(ids: string[], updates: Partial<TruckRequestRecord>): number;
    /**
     * Create assignment
     */
    createAssignment(assignment: AssignmentRecord): AssignmentRecord;
    /**
     * Get assignment by ID
     */
    getAssignmentById(id: string): AssignmentRecord | undefined;
    /**
     * Get assignments by booking
     */
    getAssignmentsByBooking(bookingId: string): AssignmentRecord[];
    /**
     * Get assignments by driver
     */
    getAssignmentsByDriver(driverId: string): AssignmentRecord[];
    /**
     * Get assignments by transporter
     */
    getAssignmentsByTransporter(transporterId: string): AssignmentRecord[];
    /**
     * Update assignment
     */
    updateAssignment(id: string, updates: Partial<AssignmentRecord>): AssignmentRecord | undefined;
    /**
     * Update tracking
     */
    updateTracking(tracking: TrackingRecord): void;
    /**
     * Get tracking by trip
     */
    getTrackingByTrip(tripId: string): TrackingRecord | undefined;
    /**
     * Get all tracking for a booking
     */
    getTrackingByBooking(bookingId: string): TrackingRecord[];
    /**
     * Get database stats
     */
    getStats(): {
        users: number;
        customers: number;
        transporters: number;
        drivers: number;
        vehicles: number;
        activeVehicles: number;
        bookings: number;
        activeBookings: number;
        assignments: number;
        dbPath: string;
    };
    /**
     * Get raw database (for debugging)
     */
    getRawData(): Database;
}
export declare const db: DatabaseService;
export {};
//# sourceMappingURL=db.d.ts.map