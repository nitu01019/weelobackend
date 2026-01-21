"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_service_1 = require("../services/logger.service");
// Database file location - stored in your home directory
const DB_DIR = path.join(process.env.HOME || '/tmp', '.weelo-data');
const DB_FILE = path.join(DB_DIR, 'database.json');
// Default empty database
const DEFAULT_DB = {
    users: [],
    vehicles: [],
    bookings: [],
    orders: [],
    truckRequests: [],
    assignments: [],
    tracking: [],
    _meta: {
        version: '2.0.0', // Updated for new order system
        lastUpdated: new Date().toISOString()
    }
};
/**
 * Database class - handles all CRUD operations
 */
class DatabaseService {
    data;
    saveTimeout = null;
    constructor() {
        this.data = this.load();
        logger_service_1.logger.info(`Database loaded from ${DB_FILE}`);
        logger_service_1.logger.info(`Users: ${this.data.users.length}, Vehicles: ${this.data.vehicles.length}, Bookings: ${this.data.bookings.length}`);
    }
    /**
     * Load database from file
     */
    load() {
        try {
            // Create directory if it doesn't exist
            if (!fs.existsSync(DB_DIR)) {
                fs.mkdirSync(DB_DIR, { recursive: true });
                logger_service_1.logger.info(`Created database directory: ${DB_DIR}`);
            }
            // Load existing database or create new
            if (fs.existsSync(DB_FILE)) {
                const raw = fs.readFileSync(DB_FILE, 'utf-8');
                return JSON.parse(raw);
            }
            else {
                this.saveSync(DEFAULT_DB);
                return DEFAULT_DB;
            }
        }
        catch (error) {
            logger_service_1.logger.error('Failed to load database, using default', error);
            return DEFAULT_DB;
        }
    }
    /**
     * Save database to file (debounced)
     */
    save() {
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
    saveSync(data) {
        try {
            data._meta.lastUpdated = new Date().toISOString();
            fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
        }
        catch (error) {
            logger_service_1.logger.error('Failed to save database', error);
        }
    }
    // ==========================================================================
    // USER OPERATIONS
    // ==========================================================================
    /**
     * Create or update user
     */
    createUser(user) {
        const now = new Date().toISOString();
        const newUser = {
            ...user,
            createdAt: now,
            updatedAt: now
        };
        // Check if user already exists (by phone + role)
        const existingIndex = this.data.users.findIndex(u => u.phone === user.phone && u.role === user.role);
        if (existingIndex >= 0) {
            // Update existing
            newUser.createdAt = this.data.users[existingIndex].createdAt;
            this.data.users[existingIndex] = newUser;
        }
        else {
            // Add new
            this.data.users.push(newUser);
        }
        this.save();
        return newUser;
    }
    /**
     * Get user by ID
     */
    getUserById(id) {
        return this.data.users.find(u => u.id === id);
    }
    /**
     * Get user by phone and role
     */
    getUserByPhone(phone, role) {
        return this.data.users.find(u => u.phone === phone && u.role === role);
    }
    /**
     * Get all drivers for a transporter
     */
    getDriversByTransporter(transporterId) {
        return this.data.users.filter(u => u.role === 'driver' && u.transporterId === transporterId);
    }
    /**
     * Update user
     */
    updateUser(id, updates) {
        const index = this.data.users.findIndex(u => u.id === id);
        if (index < 0)
            return undefined;
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
    createVehicle(vehicle) {
        const now = new Date().toISOString();
        const newVehicle = {
            ...vehicle,
            createdAt: now,
            updatedAt: now
        };
        // Check if vehicle already exists (by number)
        const existingIndex = this.data.vehicles.findIndex(v => v.vehicleNumber === vehicle.vehicleNumber);
        if (existingIndex >= 0) {
            // Update existing
            newVehicle.createdAt = this.data.vehicles[existingIndex].createdAt;
            this.data.vehicles[existingIndex] = newVehicle;
        }
        else {
            // Add new
            this.data.vehicles.push(newVehicle);
        }
        this.save();
        logger_service_1.logger.info(`Vehicle registered: ${vehicle.vehicleNumber} (${vehicle.vehicleType})`);
        return newVehicle;
    }
    /**
     * Get vehicle by ID
     */
    getVehicleById(id) {
        return this.data.vehicles.find(v => v.id === id);
    }
    /**
     * Get vehicle by number
     */
    getVehicleByNumber(vehicleNumber) {
        return this.data.vehicles.find(v => v.vehicleNumber === vehicleNumber);
    }
    /**
     * Get all vehicles for a transporter
     */
    getVehiclesByTransporter(transporterId) {
        return this.data.vehicles.filter(v => v.transporterId === transporterId);
    }
    /**
     * Get all vehicles of a specific type
     */
    getVehiclesByType(vehicleType) {
        return this.data.vehicles.filter(v => v.vehicleType === vehicleType && v.isActive);
    }
    /**
     * Get transporters who have specific vehicle type
     * This is the KEY function for matching bookings to transporters!
     */
    getTransportersWithVehicleType(vehicleType, vehicleSubtype) {
        const matchingVehicles = this.data.vehicles.filter(v => {
            if (!v.isActive)
                return false;
            if (v.vehicleType !== vehicleType)
                return false;
            if (vehicleSubtype && v.vehicleSubtype !== vehicleSubtype)
                return false;
            return true;
        });
        // Get unique transporter IDs
        const transporterIds = [...new Set(matchingVehicles.map(v => v.transporterId))];
        logger_service_1.logger.info(`Found ${transporterIds.length} transporters with ${vehicleType} trucks`);
        return transporterIds;
    }
    /**
     * Update vehicle
     */
    updateVehicle(id, updates) {
        const index = this.data.vehicles.findIndex(v => v.id === id);
        if (index < 0)
            return undefined;
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
    deleteVehicle(id) {
        const index = this.data.vehicles.findIndex(v => v.id === id);
        if (index < 0)
            return false;
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
    createBooking(booking) {
        const now = new Date().toISOString();
        const newBooking = {
            ...booking,
            createdAt: now,
            updatedAt: now
        };
        this.data.bookings.push(newBooking);
        this.save();
        logger_service_1.logger.info(`Booking created: ${booking.id} (${booking.vehicleType}, ${booking.trucksNeeded} trucks)`);
        return newBooking;
    }
    /**
     * Get booking by ID
     */
    getBookingById(id) {
        return this.data.bookings.find(b => b.id === id);
    }
    /**
     * Get bookings by customer
     */
    getBookingsByCustomer(customerId) {
        return this.data.bookings.filter(b => b.customerId === customerId);
    }
    /**
     * Get bookings by driver (from assignments)
     */
    getBookingsByDriver(driverId) {
        // Get all assignments for this driver
        const driverAssignments = this.data.assignments.filter(a => a.driverId === driverId);
        const bookingIds = driverAssignments.map(a => a.bookingId);
        // Return bookings that match those assignments
        return this.data.bookings.filter(b => bookingIds.includes(b.id));
    }
    /**
     * Get active bookings for a transporter (based on vehicle types they have)
     */
    getActiveBookingsForTransporter(transporterId) {
        // Get vehicle types this transporter has
        const transporterVehicles = this.getVehiclesByTransporter(transporterId);
        const vehicleTypes = [...new Set(transporterVehicles.map(v => v.vehicleType))];
        // Get active bookings matching those vehicle types
        return this.data.bookings.filter(b => {
            if (b.status !== 'active' && b.status !== 'partially_filled')
                return false;
            if (!vehicleTypes.includes(b.vehicleType))
                return false;
            return true;
        });
    }
    /**
     * Update booking
     */
    updateBooking(id, updates) {
        const index = this.data.bookings.findIndex(b => b.id === id);
        if (index < 0)
            return undefined;
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
    createOrder(order) {
        // Initialize orders array if it doesn't exist (for DB migration)
        if (!this.data.orders) {
            this.data.orders = [];
        }
        const now = new Date().toISOString();
        const newOrder = {
            ...order,
            createdAt: now,
            updatedAt: now
        };
        this.data.orders.push(newOrder);
        this.save();
        logger_service_1.logger.info(`Order created: ${order.id} (${order.totalTrucks} trucks)`);
        return newOrder;
    }
    /**
     * Get order by ID
     */
    getOrderById(id) {
        if (!this.data.orders)
            return undefined;
        return this.data.orders.find(o => o.id === id);
    }
    /**
     * Get orders by customer
     */
    getOrdersByCustomer(customerId) {
        if (!this.data.orders)
            return [];
        return this.data.orders.filter(o => o.customerId === customerId);
    }
    /**
     * Update order
     */
    updateOrder(id, updates) {
        if (!this.data.orders)
            return undefined;
        const index = this.data.orders.findIndex(o => o.id === id);
        if (index < 0)
            return undefined;
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
    createTruckRequest(request) {
        // Initialize truckRequests array if it doesn't exist (for DB migration)
        if (!this.data.truckRequests) {
            this.data.truckRequests = [];
        }
        const now = new Date().toISOString();
        const newRequest = {
            ...request,
            createdAt: now,
            updatedAt: now
        };
        this.data.truckRequests.push(newRequest);
        this.save();
        logger_service_1.logger.info(`TruckRequest created: ${request.id} (${request.vehicleType} ${request.vehicleSubtype})`);
        return newRequest;
    }
    /**
     * Create multiple truck requests at once (batch)
     */
    createTruckRequestsBatch(requests) {
        if (!this.data.truckRequests) {
            this.data.truckRequests = [];
        }
        const now = new Date().toISOString();
        const newRequests = requests.map(request => ({
            ...request,
            createdAt: now,
            updatedAt: now
        }));
        this.data.truckRequests.push(...newRequests);
        this.save();
        logger_service_1.logger.info(`TruckRequests batch created: ${newRequests.length} requests`);
        return newRequests;
    }
    /**
     * Get truck request by ID
     */
    getTruckRequestById(id) {
        if (!this.data.truckRequests)
            return undefined;
        return this.data.truckRequests.find(r => r.id === id);
    }
    /**
     * Get truck requests by order ID
     */
    getTruckRequestsByOrder(orderId) {
        if (!this.data.truckRequests)
            return [];
        return this.data.truckRequests.filter(r => r.orderId === orderId);
    }
    /**
     * Get active truck requests for a transporter (based on vehicle types they have)
     */
    getActiveTruckRequestsForTransporter(transporterId) {
        if (!this.data.truckRequests)
            return [];
        // Get vehicle types this transporter has
        const transporterVehicles = this.getVehiclesByTransporter(transporterId);
        // Create a set of "type_subtype" combinations for efficient lookup
        const vehicleKeys = new Set(transporterVehicles
            .filter(v => v.isActive)
            .map(v => `${v.vehicleType}_${v.vehicleSubtype}`));
        // Get active truck requests matching those vehicle types
        return this.data.truckRequests.filter(r => {
            if (r.status !== 'searching')
                return false;
            const requestKey = `${r.vehicleType}_${r.vehicleSubtype}`;
            return vehicleKeys.has(requestKey);
        });
    }
    /**
     * Get truck requests by vehicle type (for broadcasting)
     */
    getTruckRequestsByVehicleType(vehicleType, vehicleSubtype) {
        if (!this.data.truckRequests)
            return [];
        return this.data.truckRequests.filter(r => {
            if (r.status !== 'searching')
                return false;
            if (r.vehicleType !== vehicleType)
                return false;
            if (vehicleSubtype && r.vehicleSubtype !== vehicleSubtype)
                return false;
            return true;
        });
    }
    /**
     * Update truck request
     */
    updateTruckRequest(id, updates) {
        if (!this.data.truckRequests)
            return undefined;
        const index = this.data.truckRequests.findIndex(r => r.id === id);
        if (index < 0)
            return undefined;
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
    updateTruckRequestsBatch(ids, updates) {
        if (!this.data.truckRequests)
            return 0;
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
    createAssignment(assignment) {
        this.data.assignments.push(assignment);
        this.save();
        logger_service_1.logger.info(`Assignment created: ${assignment.id} for booking ${assignment.bookingId}`);
        return assignment;
    }
    /**
     * Get assignment by ID
     */
    getAssignmentById(id) {
        return this.data.assignments.find(a => a.id === id);
    }
    /**
     * Get assignments by booking
     */
    getAssignmentsByBooking(bookingId) {
        return this.data.assignments.filter(a => a.bookingId === bookingId);
    }
    /**
     * Get assignments by driver
     */
    getAssignmentsByDriver(driverId) {
        return this.data.assignments.filter(a => a.driverId === driverId);
    }
    /**
     * Get assignments by transporter
     */
    getAssignmentsByTransporter(transporterId) {
        return this.data.assignments.filter(a => a.transporterId === transporterId);
    }
    /**
     * Update assignment
     */
    updateAssignment(id, updates) {
        const index = this.data.assignments.findIndex(a => a.id === id);
        if (index < 0)
            return undefined;
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
    updateTracking(tracking) {
        const index = this.data.tracking.findIndex(t => t.tripId === tracking.tripId);
        if (index >= 0) {
            this.data.tracking[index] = tracking;
        }
        else {
            this.data.tracking.push(tracking);
        }
        this.save();
    }
    /**
     * Get tracking by trip
     */
    getTrackingByTrip(tripId) {
        return this.data.tracking.find(t => t.tripId === tripId);
    }
    /**
     * Get all tracking for a booking
     */
    getTrackingByBooking(bookingId) {
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
    getRawData() {
        return this.data;
    }
}
// Export singleton instance
exports.db = new DatabaseService();
//# sourceMappingURL=db.js.map