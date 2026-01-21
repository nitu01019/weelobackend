"use strict";
/**
 * =============================================================================
 * DRIVER MODULE - SERVICE
 * =============================================================================
 *
 * Business logic for driver operations.
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.driverService = void 0;
const uuid_1 = require("uuid");
const db_1 = require("../../shared/database/db");
const error_types_1 = require("../../shared/types/error.types");
const logger_service_1 = require("../../shared/services/logger.service");
class DriverService {
    // ==========================================================================
    // TRANSPORTER - DRIVER MANAGEMENT
    // ==========================================================================
    /**
     * Create a new driver under a transporter
     */
    async createDriver(transporterId, data) {
        // Check if driver with this phone already exists
        const existing = db_1.db.getUserByPhone(data.phone, 'driver');
        if (existing) {
            throw new error_types_1.AppError(400, 'DRIVER_EXISTS', 'A driver with this phone number already exists');
        }
        const driver = db_1.db.createUser({
            id: (0, uuid_1.v4)(),
            phone: data.phone,
            role: 'driver',
            name: data.name,
            email: data.email || undefined,
            transporterId: transporterId,
            licenseNumber: data.licenseNumber,
            isVerified: false,
            isActive: true
        });
        logger_service_1.logger.info(`Driver created: ${data.name} (${data.phone}) for transporter ${transporterId}`);
        return driver;
    }
    /**
     * Get all drivers for a transporter with stats
     */
    async getTransporterDrivers(transporterId) {
        const drivers = db_1.db.getDriversByTransporter(transporterId);
        // Get all vehicles to check which drivers are assigned
        const vehicles = db_1.db.getVehiclesByTransporter(transporterId);
        const driversOnTrip = new Set(vehicles
            .filter(v => v.status === 'in_transit' && v.assignedDriverId)
            .map(v => v.assignedDriverId));
        const activeDrivers = drivers.filter(d => d.isActive);
        const available = activeDrivers.filter(d => !driversOnTrip.has(d.id)).length;
        const onTrip = activeDrivers.filter(d => driversOnTrip.has(d.id)).length;
        return {
            drivers: activeDrivers,
            total: activeDrivers.length,
            available,
            onTrip
        };
    }
    // ==========================================================================
    // DRIVER DASHBOARD
    // ==========================================================================
    /**
     * Get driver dashboard data
     */
    async getDashboard(userId) {
        const bookings = db_1.db.getBookingsByDriver(userId);
        const today = new Date().toISOString().split('T')[0];
        const completedBookings = bookings.filter((b) => b.status === 'completed');
        const todayBookings = completedBookings.filter((b) => b.updatedAt?.startsWith(today));
        const totalEarnings = completedBookings.reduce((sum, b) => sum + (b.totalAmount || 0), 0);
        const todayEarnings = todayBookings.reduce((sum, b) => sum + (b.totalAmount || 0), 0);
        return {
            stats: {
                totalTrips: completedBookings.length,
                completedToday: todayBookings.length,
                totalEarnings,
                todayEarnings,
                rating: 4.5, // Default rating
                acceptanceRate: 85 // TODO: Calculate from actual data
            },
            recentTrips: completedBookings.slice(0, 5).map((b) => ({
                id: b.id,
                pickup: b.pickup?.address || 'Unknown',
                dropoff: b.drop?.address || 'Unknown',
                price: b.totalAmount,
                date: b.updatedAt,
                status: b.status
            })),
            availability: {
                isOnline: false,
                lastOnline: null
            }
        };
    }
    /**
     * Get driver availability status
     */
    async getAvailability(_userId) {
        return {
            isOnline: false,
            currentLocation: undefined,
            lastUpdated: new Date().toISOString()
        };
    }
    /**
     * Update driver availability
     */
    async updateAvailability(_userId, data) {
        // For now, just return the status - would need to extend UserRecord for full support
        return {
            isOnline: data.isOnline || false,
            currentLocation: data.currentLocation,
            lastUpdated: new Date().toISOString()
        };
    }
    /**
     * Get driver earnings
     */
    async getEarnings(userId, period = 'week') {
        const bookings = db_1.db.getBookingsByDriver(userId);
        const completedBookings = bookings.filter((b) => b.status === 'completed');
        const now = new Date();
        let startDate;
        switch (period) {
            case 'today':
                startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                break;
            case 'week':
                startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                break;
            case 'month':
                startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                break;
            default:
                startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        }
        const periodBookings = completedBookings.filter((b) => new Date(b.updatedAt || b.createdAt) >= startDate);
        const totalEarnings = periodBookings.reduce((sum, b) => sum + (b.totalAmount || 0), 0);
        // Group by date for breakdown
        const byDate = {};
        periodBookings.forEach((b) => {
            const date = (b.updatedAt || b.createdAt).split('T')[0];
            if (!byDate[date]) {
                byDate[date] = { amount: 0, trips: 0 };
            }
            byDate[date].amount += b.totalAmount || 0;
            byDate[date].trips += 1;
        });
        return {
            period,
            totalEarnings,
            tripCount: periodBookings.length,
            avgPerTrip: periodBookings.length > 0 ? totalEarnings / periodBookings.length : 0,
            breakdown: Object.entries(byDate).map(([date, data]) => ({
                date,
                amount: data.amount,
                trips: data.trips
            }))
        };
    }
    /**
     * Get driver trips
     */
    async getTrips(userId, options) {
        let bookings = db_1.db.getBookingsByDriver(userId);
        if (options.status) {
            bookings = bookings.filter((b) => b.status === options.status);
        }
        const total = bookings.length;
        const trips = bookings
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .slice(options.offset, options.offset + options.limit)
            .map((b) => ({
            id: b.id,
            pickup: b.pickup?.address || 'Unknown',
            dropoff: b.drop?.address || 'Unknown',
            price: b.totalAmount,
            status: b.status,
            date: b.createdAt,
            customer: b.customerName || 'Customer'
        }));
        return {
            trips,
            total,
            hasMore: options.offset + options.limit < total
        };
    }
    /**
     * Get active trip for driver
     */
    async getActiveTrip(userId) {
        const bookings = db_1.db.getBookingsByDriver(userId);
        const activeStatuses = ['active', 'partially_filled', 'in_progress'];
        const activeTrip = bookings.find((b) => activeStatuses.includes(b.status));
        if (!activeTrip) {
            return null;
        }
        return {
            id: activeTrip.id,
            status: activeTrip.status,
            pickup: {
                address: activeTrip.pickup?.address,
                location: { lat: activeTrip.pickup?.latitude, lng: activeTrip.pickup?.longitude }
            },
            dropoff: {
                address: activeTrip.drop?.address,
                location: { lat: activeTrip.drop?.latitude, lng: activeTrip.drop?.longitude }
            },
            price: activeTrip.totalAmount,
            customer: {
                name: activeTrip.customerName,
                phone: activeTrip.customerPhone
            },
            createdAt: activeTrip.createdAt
        };
    }
}
exports.driverService = new DriverService();
//# sourceMappingURL=driver.service.js.map