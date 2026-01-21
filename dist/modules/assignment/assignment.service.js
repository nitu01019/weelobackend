"use strict";
/**
 * =============================================================================
 * ASSIGNMENT MODULE - SERVICE
 * =============================================================================
 *
 * Business logic for truck assignments.
 * Transporters assign their trucks to customer bookings.
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.assignmentService = void 0;
const uuid_1 = require("uuid");
const db_1 = require("../../shared/database/db");
const error_types_1 = require("../../shared/types/error.types");
const logger_service_1 = require("../../shared/services/logger.service");
const socket_service_1 = require("../../shared/services/socket.service");
const booking_service_1 = require("../booking/booking.service");
class AssignmentService {
    // ==========================================================================
    // CREATE ASSIGNMENT (Transporter assigns truck to booking)
    // ==========================================================================
    async createAssignment(transporterId, data) {
        // Verify booking exists and is active
        const booking = db_1.db.getBookingById(data.bookingId);
        if (!booking) {
            throw new error_types_1.AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
        }
        if (booking.status !== 'active' && booking.status !== 'partially_filled') {
            throw new error_types_1.AppError(400, 'BOOKING_NOT_ACTIVE', 'Booking is not accepting more trucks');
        }
        // Verify vehicle belongs to this transporter
        const vehicle = db_1.db.getVehicleById(data.vehicleId);
        if (!vehicle) {
            throw new error_types_1.AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found');
        }
        if (vehicle.transporterId !== transporterId) {
            throw new error_types_1.AppError(403, 'FORBIDDEN', 'This vehicle does not belong to you');
        }
        // Verify vehicle type matches booking
        if (vehicle.vehicleType !== booking.vehicleType) {
            throw new error_types_1.AppError(400, 'VEHICLE_MISMATCH', `Booking requires ${booking.vehicleType}, but vehicle is ${vehicle.vehicleType}`);
        }
        // Verify driver belongs to this transporter
        const driver = db_1.db.getUserById(data.driverId);
        if (!driver) {
            throw new error_types_1.AppError(404, 'DRIVER_NOT_FOUND', 'Driver not found');
        }
        if (driver.transporterId !== transporterId) {
            throw new error_types_1.AppError(403, 'FORBIDDEN', 'This driver does not belong to you');
        }
        // Get transporter info
        const transporter = db_1.db.getUserById(transporterId);
        // Create assignment
        const tripId = (0, uuid_1.v4)();
        const assignment = {
            id: (0, uuid_1.v4)(),
            bookingId: data.bookingId,
            transporterId,
            transporterName: transporter?.businessName || transporter?.name || 'Transporter',
            vehicleId: data.vehicleId,
            vehicleNumber: vehicle.vehicleNumber,
            vehicleType: vehicle.vehicleType,
            vehicleSubtype: vehicle.vehicleSubtype,
            driverId: data.driverId,
            driverName: driver.name,
            driverPhone: driver.phone,
            tripId,
            status: 'pending',
            assignedAt: new Date().toISOString()
        };
        db_1.db.createAssignment(assignment);
        // Update booking trucks filled
        await booking_service_1.bookingService.incrementTrucksFilled(data.bookingId);
        // Notify customer
        (0, socket_service_1.emitToBooking)(data.bookingId, socket_service_1.SocketEvent.TRUCK_ASSIGNED, {
            bookingId: data.bookingId,
            assignment: {
                id: assignment.id,
                vehicleNumber: assignment.vehicleNumber,
                driverName: assignment.driverName,
                status: assignment.status
            }
        });
        // Notify driver
        (0, socket_service_1.emitToUser)(data.driverId, socket_service_1.SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
            assignmentId: assignment.id,
            tripId,
            bookingId: data.bookingId,
            status: 'pending',
            message: 'New trip assigned to you'
        });
        logger_service_1.logger.info(`Assignment created: ${assignment.id} for booking ${data.bookingId}`);
        return assignment;
    }
    // ==========================================================================
    // GET ASSIGNMENTS
    // ==========================================================================
    async getAssignments(userId, userRole, query) {
        let assignments;
        if (userRole === 'transporter') {
            assignments = db_1.db.getAssignmentsByTransporter(userId);
        }
        else if (userRole === 'customer') {
            // Get customer's bookings, then get assignments for those
            const bookings = db_1.db.getBookingsByCustomer(userId);
            const bookingIds = bookings.map(b => b.id);
            assignments = [];
            for (const bookingId of bookingIds) {
                assignments.push(...db_1.db.getAssignmentsByBooking(bookingId));
            }
        }
        else {
            assignments = [];
        }
        // Filter by status
        if (query.status) {
            assignments = assignments.filter(a => a.status === query.status);
        }
        // Filter by booking
        if (query.bookingId) {
            assignments = assignments.filter(a => a.bookingId === query.bookingId);
        }
        const total = assignments.length;
        // Pagination
        const start = (query.page - 1) * query.limit;
        assignments = assignments.slice(start, start + query.limit);
        const hasMore = start + assignments.length < total;
        return { assignments, total, hasMore };
    }
    async getDriverAssignments(driverId, query) {
        let assignments = db_1.db.getAssignmentsByDriver(driverId);
        // Filter by status
        if (query.status) {
            assignments = assignments.filter(a => a.status === query.status);
        }
        const total = assignments.length;
        // Pagination
        const start = (query.page - 1) * query.limit;
        assignments = assignments.slice(start, start + query.limit);
        const hasMore = start + assignments.length < total;
        return { assignments, total, hasMore };
    }
    async getAssignmentById(assignmentId, userId, userRole) {
        const assignment = db_1.db.getAssignmentById(assignmentId);
        if (!assignment) {
            throw new error_types_1.AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found');
        }
        // Access control
        if (userRole === 'driver' && assignment.driverId !== userId) {
            throw new error_types_1.AppError(403, 'FORBIDDEN', 'Access denied');
        }
        if (userRole === 'transporter' && assignment.transporterId !== userId) {
            throw new error_types_1.AppError(403, 'FORBIDDEN', 'Access denied');
        }
        return assignment;
    }
    // ==========================================================================
    // UPDATE STATUS
    // ==========================================================================
    async acceptAssignment(assignmentId, driverId) {
        const assignment = db_1.db.getAssignmentById(assignmentId);
        if (!assignment) {
            throw new error_types_1.AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found');
        }
        if (assignment.driverId !== driverId) {
            throw new error_types_1.AppError(403, 'FORBIDDEN', 'This assignment is not for you');
        }
        if (assignment.status !== 'pending') {
            throw new error_types_1.AppError(400, 'INVALID_STATUS', 'Assignment cannot be accepted');
        }
        const updated = db_1.db.updateAssignment(assignmentId, {
            status: 'driver_accepted',
            driverAcceptedAt: new Date().toISOString()
        });
        // Notify booking room
        (0, socket_service_1.emitToBooking)(assignment.bookingId, socket_service_1.SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
            assignmentId,
            tripId: assignment.tripId,
            status: 'driver_accepted',
            vehicleNumber: assignment.vehicleNumber
        });
        logger_service_1.logger.info(`Assignment accepted: ${assignmentId} by driver ${driverId}`);
        return updated;
    }
    async updateStatus(assignmentId, driverId, data) {
        const assignment = db_1.db.getAssignmentById(assignmentId);
        if (!assignment) {
            throw new error_types_1.AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found');
        }
        if (assignment.driverId !== driverId) {
            throw new error_types_1.AppError(403, 'FORBIDDEN', 'This assignment is not for you');
        }
        const updates = {
            status: data.status
        };
        if (data.status === 'in_transit') {
            updates.startedAt = new Date().toISOString();
        }
        if (data.status === 'completed') {
            updates.completedAt = new Date().toISOString();
        }
        const updated = db_1.db.updateAssignment(assignmentId, updates);
        // Notify booking room
        (0, socket_service_1.emitToBooking)(assignment.bookingId, socket_service_1.SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
            assignmentId,
            tripId: assignment.tripId,
            status: data.status,
            vehicleNumber: assignment.vehicleNumber
        });
        logger_service_1.logger.info(`Assignment status updated: ${assignmentId} -> ${data.status}`);
        return updated;
    }
    async cancelAssignment(assignmentId, userId) {
        const assignment = db_1.db.getAssignmentById(assignmentId);
        if (!assignment) {
            throw new error_types_1.AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found');
        }
        // Only transporter or driver can cancel
        if (assignment.transporterId !== userId && assignment.driverId !== userId) {
            throw new error_types_1.AppError(403, 'FORBIDDEN', 'Access denied');
        }
        db_1.db.updateAssignment(assignmentId, { status: 'cancelled' });
        // Decrement trucks filled
        await booking_service_1.bookingService.decrementTrucksFilled(assignment.bookingId);
        // Notify booking room
        (0, socket_service_1.emitToBooking)(assignment.bookingId, socket_service_1.SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
            assignmentId,
            tripId: assignment.tripId,
            status: 'cancelled',
            vehicleNumber: assignment.vehicleNumber
        });
        logger_service_1.logger.info(`Assignment cancelled: ${assignmentId}`);
    }
}
exports.assignmentService = new AssignmentService();
//# sourceMappingURL=assignment.service.js.map