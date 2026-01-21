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

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../services/logger.service';

// Database file location - stored in your home directory
const DB_DIR = path.join(process.env.HOME || '/tmp', '.weelo-data');
const DB_FILE = path.join(DB_DIR, 'database.json');

// Database schema
export interface Database {
  users: UserRecord[];
  vehicles: VehicleRecord[];
  bookings: BookingRecord[];
  orders: OrderRecord[];           // NEW: Parent orders
  truckRequests: TruckRequestRecord[]; // NEW: Individual truck requests
  assignments: AssignmentRecord[];
  tracking: TrackingRecord[];
  _meta: {
    version: string;
    lastUpdated: string;
  };
}

// User Record - Customer, Transporter, or Driver
export interface UserRecord {
  id: string;
  phone: string;
  role: 'customer' | 'transporter' | 'driver';
  name: string;
  email?: string;
  profilePhoto?: string;
  
  // Customer specific
  company?: string;
  gstNumber?: string;
  
  // Transporter specific
  businessName?: string;
  businessAddress?: string;
  panNumber?: string;
  
  // Driver specific
  transporterId?: string;  // Which transporter this driver belongs to
  licenseNumber?: string;
  licenseExpiry?: string;
  aadharNumber?: string;
  
  isVerified: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// Vehicle Status - Operational state of the vehicle
export type VehicleStatus = 'available' | 'in_transit' | 'maintenance' | 'inactive';

// Vehicle Record - Registered by Transporter
export interface VehicleRecord {
  id: string;
  transporterId: string;      // Owner transporter
  assignedDriverId?: string;  // Currently assigned driver
  
  // Vehicle details
  vehicleNumber: string;      // e.g., "MH12AB1234"
  vehicleType: string;        // e.g., "tipper", "container", "tanker"
  vehicleSubtype: string;     // e.g., "20-24 Ton"
  capacity: string;           // e.g., "24 Ton"
  model?: string;             // e.g., "Tata Prima"
  year?: number;              // Manufacturing year
  
  // Status tracking - KEY FOR FLEET MANAGEMENT
  status: VehicleStatus;      // available | in_transit | maintenance | inactive
  currentTripId?: string;     // If in_transit, which booking/trip
  maintenanceReason?: string; // If in maintenance, why
  maintenanceEndDate?: string;// Expected end of maintenance
  lastStatusChange?: string;  // When status last changed
  
  // Documents
  rcNumber?: string;
  rcExpiry?: string;
  insuranceNumber?: string;
  insuranceExpiry?: string;
  permitNumber?: string;
  permitExpiry?: string;
  fitnessExpiry?: string;
  
  // Photos
  vehiclePhotos?: string[];
  rcPhoto?: string;
  insurancePhoto?: string;
  
  isVerified: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// Booking Record - Created by Customer
export interface BookingRecord {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  
  // Locations
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
  
  // Requirements
  vehicleType: string;
  vehicleSubtype: string;
  trucksNeeded: number;
  trucksFilled: number;
  distanceKm: number;
  pricePerTruck: number;
  totalAmount: number;
  
  // Goods info
  goodsType?: string;
  weight?: string;
  
  // Status
  status: 'active' | 'partially_filled' | 'fully_filled' | 'in_progress' | 'completed' | 'cancelled' | 'expired';
  
  // Matching - which transporters were notified
  notifiedTransporters: string[];  // IDs of transporters with matching trucks
  
  scheduledAt?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// NEW: Order Record - Parent container for multiple truck requests
// =============================================================================
export interface OrderRecord {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  
  // Locations (same for all trucks in order)
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
  
  // Order summary
  distanceKm: number;
  totalTrucks: number;           // Total trucks requested
  trucksFilled: number;          // How many assigned so far
  totalAmount: number;           // Sum of all truck prices
  
  // Goods info (applies to all trucks)
  goodsType?: string;
  weight?: string;
  cargoWeightKg?: number;
  
  // Status
  status: 'active' | 'partially_filled' | 'fully_filled' | 'in_progress' | 'completed' | 'cancelled' | 'expired';
  
  // Timing
  scheduledAt?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// NEW: TruckRequest Record - Individual truck request within an order
// =============================================================================
export interface TruckRequestRecord {
  id: string;
  orderId: string;               // Parent order
  requestNumber: number;         // 1, 2, 3... within the order
  
  // Vehicle requirements
  vehicleType: string;           // e.g., "open", "container"
  vehicleSubtype: string;        // e.g., "17ft", "4ton"
  pricePerTruck: number;
  
  // Status
  status: 'searching' | 'assigned' | 'accepted' | 'in_progress' | 'completed' | 'cancelled' | 'expired';
  
  // Assignment (filled when transporter accepts)
  assignedTransporterId?: string;
  assignedTransporterName?: string;
  assignedVehicleId?: string;
  assignedVehicleNumber?: string;
  assignedDriverId?: string;
  assignedDriverName?: string;
  assignedDriverPhone?: string;
  
  // Tracking
  tripId?: string;
  
  // Which transporters were notified for THIS request
  notifiedTransporters: string[];
  
  // Timing
  assignedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// Assignment Record - Truck assigned to booking (legacy) or truck request
export interface AssignmentRecord {
  id: string;
  bookingId: string;             // Legacy: booking ID
  truckRequestId?: string;       // NEW: truck request ID
  orderId?: string;              // NEW: parent order ID
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

// Tracking Record - Driver location updates
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

// Default empty database
const DEFAULT_DB: Database = {
  users: [],
  vehicles: [],
  bookings: [],
  orders: [],
  truckRequests: [],
  assignments: [],
  tracking: [],
  _meta: {
    version: '2.0.0',  // Updated for new order system
    lastUpdated: new Date().toISOString()
  }
};

/**
 * Database class - handles all CRUD operations
 */
class DatabaseService {
  private data: Database;
  private saveTimeout: NodeJS.Timeout | null = null;

  constructor() {
    this.data = this.load();
    logger.info(`Database loaded from ${DB_FILE}`);
    logger.info(`Users: ${this.data.users.length}, Vehicles: ${this.data.vehicles.length}, Bookings: ${this.data.bookings.length}`);
  }

  /**
   * Load database from file
   */
  private load(): Database {
    try {
      // Create directory if it doesn't exist
      if (!fs.existsSync(DB_DIR)) {
        fs.mkdirSync(DB_DIR, { recursive: true });
        logger.info(`Created database directory: ${DB_DIR}`);
      }

      // Load existing database or create new
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        return JSON.parse(raw);
      } else {
        this.saveSync(DEFAULT_DB);
        return DEFAULT_DB;
      }
    } catch (error) {
      logger.error('Failed to load database, using default', error);
      return DEFAULT_DB;
    }
  }

  /**
   * Save database to file (debounced)
   */
  private save(): void {
    // Debounce saves to avoid too many writes
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      this.saveSync(this.data);
    }, 100);
  }

  /**
   * Synchronous save
   */
  private saveSync(data: Database): void {
    try {
      data._meta.lastUpdated = new Date().toISOString();
      fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
      logger.error('Failed to save database', error);
    }
  }

  // ==========================================================================
  // USER OPERATIONS
  // ==========================================================================

  /**
   * Create or update user
   */
  createUser(user: Omit<UserRecord, 'createdAt' | 'updatedAt'>): UserRecord {
    const now = new Date().toISOString();
    const newUser: UserRecord = {
      ...user,
      createdAt: now,
      updatedAt: now
    };
    
    // Check if user already exists (by phone + role)
    const existingIndex = this.data.users.findIndex(
      u => u.phone === user.phone && u.role === user.role
    );
    
    if (existingIndex >= 0) {
      // Update existing
      newUser.createdAt = this.data.users[existingIndex].createdAt;
      this.data.users[existingIndex] = newUser;
    } else {
      // Add new
      this.data.users.push(newUser);
    }
    
    this.save();
    return newUser;
  }

  /**
   * Get user by ID
   */
  getUserById(id: string): UserRecord | undefined {
    return this.data.users.find(u => u.id === id);
  }

  /**
   * Get user by phone and role
   */
  getUserByPhone(phone: string, role: string): UserRecord | undefined {
    return this.data.users.find(u => u.phone === phone && u.role === role);
  }

  /**
   * Get all drivers for a transporter
   */
  getDriversByTransporter(transporterId: string): UserRecord[] {
    return this.data.users.filter(
      u => u.role === 'driver' && u.transporterId === transporterId
    );
  }

  /**
   * Update user
   */
  updateUser(id: string, updates: Partial<UserRecord>): UserRecord | undefined {
    const index = this.data.users.findIndex(u => u.id === id);
    if (index < 0) return undefined;
    
    this.data.users[index] = {
      ...this.data.users[index],
      ...updates,
      updatedAt: new Date().toISOString()
    };
    
    this.save();
    return this.data.users[index];
  }

  // ==========================================================================
  // VEHICLE OPERATIONS
  // ==========================================================================

  /**
   * Register vehicle
   */
  createVehicle(vehicle: Omit<VehicleRecord, 'createdAt' | 'updatedAt'>): VehicleRecord {
    const now = new Date().toISOString();
    const newVehicle: VehicleRecord = {
      ...vehicle,
      createdAt: now,
      updatedAt: now
    };
    
    // Check if vehicle already exists (by number)
    const existingIndex = this.data.vehicles.findIndex(
      v => v.vehicleNumber === vehicle.vehicleNumber
    );
    
    if (existingIndex >= 0) {
      // Update existing
      newVehicle.createdAt = this.data.vehicles[existingIndex].createdAt;
      this.data.vehicles[existingIndex] = newVehicle;
    } else {
      // Add new
      this.data.vehicles.push(newVehicle);
    }
    
    this.save();
    logger.info(`Vehicle registered: ${vehicle.vehicleNumber} (${vehicle.vehicleType})`);
    return newVehicle;
  }

  /**
   * Get vehicle by ID
   */
  getVehicleById(id: string): VehicleRecord | undefined {
    return this.data.vehicles.find(v => v.id === id);
  }

  /**
   * Get vehicle by number
   */
  getVehicleByNumber(vehicleNumber: string): VehicleRecord | undefined {
    return this.data.vehicles.find(v => v.vehicleNumber === vehicleNumber);
  }

  /**
   * Get all vehicles for a transporter
   */
  getVehiclesByTransporter(transporterId: string): VehicleRecord[] {
    return this.data.vehicles.filter(v => v.transporterId === transporterId);
  }

  /**
   * Get all vehicles of a specific type
   */
  getVehiclesByType(vehicleType: string): VehicleRecord[] {
    return this.data.vehicles.filter(
      v => v.vehicleType === vehicleType && v.isActive
    );
  }

  /**
   * Get transporters who have specific vehicle type
   * This is the KEY function for matching bookings to transporters!
   */
  getTransportersWithVehicleType(vehicleType: string, vehicleSubtype?: string): string[] {
    const matchingVehicles = this.data.vehicles.filter(v => {
      if (!v.isActive) return false;
      if (v.vehicleType !== vehicleType) return false;
      if (vehicleSubtype && v.vehicleSubtype !== vehicleSubtype) return false;
      return true;
    });
    
    // Get unique transporter IDs
    const transporterIds = [...new Set(matchingVehicles.map(v => v.transporterId))];
    
    logger.info(`Found ${transporterIds.length} transporters with ${vehicleType} trucks`);
    return transporterIds;
  }

  /**
   * Update vehicle
   */
  updateVehicle(id: string, updates: Partial<VehicleRecord>): VehicleRecord | undefined {
    const index = this.data.vehicles.findIndex(v => v.id === id);
    if (index < 0) return undefined;
    
    this.data.vehicles[index] = {
      ...this.data.vehicles[index],
      ...updates,
      updatedAt: new Date().toISOString()
    };
    
    this.save();
    return this.data.vehicles[index];
  }

  /**
   * Delete vehicle
   */
  deleteVehicle(id: string): boolean {
    const index = this.data.vehicles.findIndex(v => v.id === id);
    if (index < 0) return false;
    
    this.data.vehicles.splice(index, 1);
    this.save();
    return true;
  }

  // ==========================================================================
  // BOOKING OPERATIONS
  // ==========================================================================

  /**
   * Create booking
   */
  createBooking(booking: Omit<BookingRecord, 'createdAt' | 'updatedAt'>): BookingRecord {
    const now = new Date().toISOString();
    const newBooking: BookingRecord = {
      ...booking,
      createdAt: now,
      updatedAt: now
    };
    
    this.data.bookings.push(newBooking);
    this.save();
    
    logger.info(`Booking created: ${booking.id} (${booking.vehicleType}, ${booking.trucksNeeded} trucks)`);
    return newBooking;
  }

  /**
   * Get booking by ID
   */
  getBookingById(id: string): BookingRecord | undefined {
    return this.data.bookings.find(b => b.id === id);
  }

  /**
   * Get bookings by customer
   */
  getBookingsByCustomer(customerId: string): BookingRecord[] {
    return this.data.bookings.filter(b => b.customerId === customerId);
  }

  /**
   * Get bookings by driver (from assignments)
   */
  getBookingsByDriver(driverId: string): BookingRecord[] {
    // Get all assignments for this driver
    const driverAssignments = this.data.assignments.filter(a => a.driverId === driverId);
    const bookingIds = driverAssignments.map(a => a.bookingId);
    
    // Return bookings that match those assignments
    return this.data.bookings.filter(b => bookingIds.includes(b.id));
  }

  /**
   * Get active bookings for a transporter (based on vehicle types they have)
   */
  getActiveBookingsForTransporter(transporterId: string): BookingRecord[] {
    // Get vehicle types this transporter has
    const transporterVehicles = this.getVehiclesByTransporter(transporterId);
    const vehicleTypes = [...new Set(transporterVehicles.map(v => v.vehicleType))];
    
    // Get active bookings matching those vehicle types
    return this.data.bookings.filter(b => {
      if (b.status !== 'active' && b.status !== 'partially_filled') return false;
      if (!vehicleTypes.includes(b.vehicleType)) return false;
      return true;
    });
  }

  /**
   * Update booking
   */
  updateBooking(id: string, updates: Partial<BookingRecord>): BookingRecord | undefined {
    const index = this.data.bookings.findIndex(b => b.id === id);
    if (index < 0) return undefined;
    
    this.data.bookings[index] = {
      ...this.data.bookings[index],
      ...updates,
      updatedAt: new Date().toISOString()
    };
    
    this.save();
    return this.data.bookings[index];
  }

  // ==========================================================================
  // ORDER OPERATIONS (NEW)
  // ==========================================================================

  /**
   * Create order
   */
  createOrder(order: Omit<OrderRecord, 'createdAt' | 'updatedAt'>): OrderRecord {
    // Initialize orders array if it doesn't exist (for DB migration)
    if (!this.data.orders) {
      this.data.orders = [];
    }
    
    const now = new Date().toISOString();
    const newOrder: OrderRecord = {
      ...order,
      createdAt: now,
      updatedAt: now
    };
    
    this.data.orders.push(newOrder);
    this.save();
    
    logger.info(`Order created: ${order.id} (${order.totalTrucks} trucks)`);
    return newOrder;
  }

  /**
   * Get order by ID
   */
  getOrderById(id: string): OrderRecord | undefined {
    if (!this.data.orders) return undefined;
    return this.data.orders.find(o => o.id === id);
  }

  /**
   * Get orders by customer
   */
  getOrdersByCustomer(customerId: string): OrderRecord[] {
    if (!this.data.orders) return [];
    return this.data.orders.filter(o => o.customerId === customerId);
  }

  /**
   * Update order
   */
  updateOrder(id: string, updates: Partial<OrderRecord>): OrderRecord | undefined {
    if (!this.data.orders) return undefined;
    const index = this.data.orders.findIndex(o => o.id === id);
    if (index < 0) return undefined;
    
    this.data.orders[index] = {
      ...this.data.orders[index],
      ...updates,
      updatedAt: new Date().toISOString()
    };
    
    this.save();
    return this.data.orders[index];
  }

  // ==========================================================================
  // TRUCK REQUEST OPERATIONS (NEW)
  // ==========================================================================

  /**
   * Create truck request
   */
  createTruckRequest(request: Omit<TruckRequestRecord, 'createdAt' | 'updatedAt'>): TruckRequestRecord {
    // Initialize truckRequests array if it doesn't exist (for DB migration)
    if (!this.data.truckRequests) {
      this.data.truckRequests = [];
    }
    
    const now = new Date().toISOString();
    const newRequest: TruckRequestRecord = {
      ...request,
      createdAt: now,
      updatedAt: now
    };
    
    this.data.truckRequests.push(newRequest);
    this.save();
    
    logger.info(`TruckRequest created: ${request.id} (${request.vehicleType} ${request.vehicleSubtype})`);
    return newRequest;
  }

  /**
   * Create multiple truck requests at once (batch)
   */
  createTruckRequestsBatch(requests: Omit<TruckRequestRecord, 'createdAt' | 'updatedAt'>[]): TruckRequestRecord[] {
    if (!this.data.truckRequests) {
      this.data.truckRequests = [];
    }
    
    const now = new Date().toISOString();
    const newRequests: TruckRequestRecord[] = requests.map(request => ({
      ...request,
      createdAt: now,
      updatedAt: now
    }));
    
    this.data.truckRequests.push(...newRequests);
    this.save();
    
    logger.info(`TruckRequests batch created: ${newRequests.length} requests`);
    return newRequests;
  }

  /**
   * Get truck request by ID
   */
  getTruckRequestById(id: string): TruckRequestRecord | undefined {
    if (!this.data.truckRequests) return undefined;
    return this.data.truckRequests.find(r => r.id === id);
  }

  /**
   * Get truck requests by order ID
   */
  getTruckRequestsByOrder(orderId: string): TruckRequestRecord[] {
    if (!this.data.truckRequests) return [];
    return this.data.truckRequests.filter(r => r.orderId === orderId);
  }

  /**
   * Get active truck requests for a transporter (based on vehicle types they have)
   */
  getActiveTruckRequestsForTransporter(transporterId: string): TruckRequestRecord[] {
    if (!this.data.truckRequests) return [];
    
    // Get vehicle types this transporter has
    const transporterVehicles = this.getVehiclesByTransporter(transporterId);
    
    // Create a set of "type_subtype" combinations for efficient lookup
    const vehicleKeys = new Set(
      transporterVehicles
        .filter(v => v.isActive)
        .map(v => `${v.vehicleType}_${v.vehicleSubtype}`)
    );
    
    // Get active truck requests matching those vehicle types
    return this.data.truckRequests.filter(r => {
      if (r.status !== 'searching') return false;
      const requestKey = `${r.vehicleType}_${r.vehicleSubtype}`;
      return vehicleKeys.has(requestKey);
    });
  }

  /**
   * Get truck requests by vehicle type (for broadcasting)
   */
  getTruckRequestsByVehicleType(vehicleType: string, vehicleSubtype?: string): TruckRequestRecord[] {
    if (!this.data.truckRequests) return [];
    return this.data.truckRequests.filter(r => {
      if (r.status !== 'searching') return false;
      if (r.vehicleType !== vehicleType) return false;
      if (vehicleSubtype && r.vehicleSubtype !== vehicleSubtype) return false;
      return true;
    });
  }

  /**
   * Update truck request
   */
  updateTruckRequest(id: string, updates: Partial<TruckRequestRecord>): TruckRequestRecord | undefined {
    if (!this.data.truckRequests) return undefined;
    const index = this.data.truckRequests.findIndex(r => r.id === id);
    if (index < 0) return undefined;
    
    this.data.truckRequests[index] = {
      ...this.data.truckRequests[index],
      ...updates,
      updatedAt: new Date().toISOString()
    };
    
    this.save();
    return this.data.truckRequests[index];
  }

  /**
   * Update multiple truck requests (for batch expiry, etc.)
   */
  updateTruckRequestsBatch(ids: string[], updates: Partial<TruckRequestRecord>): number {
    if (!this.data.truckRequests) return 0;
    
    let updatedCount = 0;
    const now = new Date().toISOString();
    
    ids.forEach(id => {
      const index = this.data.truckRequests.findIndex(r => r.id === id);
      if (index >= 0) {
        this.data.truckRequests[index] = {
          ...this.data.truckRequests[index],
          ...updates,
          updatedAt: now
        };
        updatedCount++;
      }
    });
    
    if (updatedCount > 0) {
      this.save();
    }
    
    return updatedCount;
  }

  // ==========================================================================
  // ASSIGNMENT OPERATIONS
  // ==========================================================================

  /**
   * Create assignment
   */
  createAssignment(assignment: AssignmentRecord): AssignmentRecord {
    this.data.assignments.push(assignment);
    this.save();
    
    logger.info(`Assignment created: ${assignment.id} for booking ${assignment.bookingId}`);
    return assignment;
  }

  /**
   * Get assignment by ID
   */
  getAssignmentById(id: string): AssignmentRecord | undefined {
    return this.data.assignments.find(a => a.id === id);
  }

  /**
   * Get assignments by booking
   */
  getAssignmentsByBooking(bookingId: string): AssignmentRecord[] {
    return this.data.assignments.filter(a => a.bookingId === bookingId);
  }

  /**
   * Get assignments by driver
   */
  getAssignmentsByDriver(driverId: string): AssignmentRecord[] {
    return this.data.assignments.filter(a => a.driverId === driverId);
  }

  /**
   * Get assignments by transporter
   */
  getAssignmentsByTransporter(transporterId: string): AssignmentRecord[] {
    return this.data.assignments.filter(a => a.transporterId === transporterId);
  }

  /**
   * Update assignment
   */
  updateAssignment(id: string, updates: Partial<AssignmentRecord>): AssignmentRecord | undefined {
    const index = this.data.assignments.findIndex(a => a.id === id);
    if (index < 0) return undefined;
    
    this.data.assignments[index] = {
      ...this.data.assignments[index],
      ...updates
    };
    
    this.save();
    return this.data.assignments[index];
  }

  // ==========================================================================
  // TRACKING OPERATIONS
  // ==========================================================================

  /**
   * Update tracking
   */
  updateTracking(tracking: TrackingRecord): void {
    const index = this.data.tracking.findIndex(t => t.tripId === tracking.tripId);
    
    if (index >= 0) {
      this.data.tracking[index] = tracking;
    } else {
      this.data.tracking.push(tracking);
    }
    
    this.save();
  }

  /**
   * Get tracking by trip
   */
  getTrackingByTrip(tripId: string): TrackingRecord | undefined {
    return this.data.tracking.find(t => t.tripId === tripId);
  }

  /**
   * Get all tracking for a booking
   */
  getTrackingByBooking(bookingId: string): TrackingRecord[] {
    return this.data.tracking.filter(t => t.bookingId === bookingId);
  }

  // ==========================================================================
  // UTILITY
  // ==========================================================================

  /**
   * Get database stats
   */
  getStats() {
    return {
      users: this.data.users.length,
      customers: this.data.users.filter(u => u.role === 'customer').length,
      transporters: this.data.users.filter(u => u.role === 'transporter').length,
      drivers: this.data.users.filter(u => u.role === 'driver').length,
      vehicles: this.data.vehicles.length,
      activeVehicles: this.data.vehicles.filter(v => v.isActive).length,
      bookings: this.data.bookings.length,
      activeBookings: this.data.bookings.filter(b => b.status === 'active').length,
      assignments: this.data.assignments.length,
      dbPath: DB_FILE
    };
  }

  /**
   * Get raw database (for debugging)
   */
  getRawData(): Database {
    return this.data;
  }
}

// Export singleton instance
export const db = new DatabaseService();
