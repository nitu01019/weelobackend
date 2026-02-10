/**
 * =============================================================================
 * ASSIGNMENT MODULE - SERVICE
 * =============================================================================
 * 
 * Business logic for truck assignments.
 * Transporters assign their trucks to customer bookings.
 * =============================================================================
 */

import { v4 as uuid } from 'uuid';
import { db, AssignmentRecord } from '../../shared/database/db';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, emitToBooking, SocketEvent } from '../../shared/services/socket.service';
import { bookingService } from '../booking/booking.service';
import { CreateAssignmentInput, UpdateStatusInput, GetAssignmentsQuery } from './assignment.schema';

class AssignmentService {
  
  // ==========================================================================
  // CREATE ASSIGNMENT (Transporter assigns truck to booking)
  // ==========================================================================

  async createAssignment(
    transporterId: string,
    data: CreateAssignmentInput
  ): Promise<AssignmentRecord> {
    // Verify booking exists and is active
    const booking = await db.getBookingById(data.bookingId);
    if (!booking) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }

    if (booking.status !== 'active' && booking.status !== 'partially_filled') {
      throw new AppError(400, 'BOOKING_NOT_ACTIVE', 'Booking is not accepting more trucks');
    }

    // Verify vehicle belongs to this transporter
    const vehicle = await db.getVehicleById(data.vehicleId);
    if (!vehicle) {
      throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found');
    }
    if (vehicle.transporterId !== transporterId) {
      throw new AppError(403, 'FORBIDDEN', 'This vehicle does not belong to you');
    }

    // Verify vehicle type matches booking
    if (vehicle.vehicleType !== booking.vehicleType) {
      throw new AppError(400, 'VEHICLE_MISMATCH', 
        `Booking requires ${booking.vehicleType}, but vehicle is ${vehicle.vehicleType}`);
    }

    // Verify driver belongs to this transporter
    const driver = await db.getUserById(data.driverId);
    if (!driver) {
      throw new AppError(404, 'DRIVER_NOT_FOUND', 'Driver not found');
    }
    if (driver.transporterId !== transporterId) {
      throw new AppError(403, 'FORBIDDEN', 'This driver does not belong to you');
    }

    // =================================================================
    // RULE: ONE ACTIVE TRIP PER DRIVER
    // Driver can only have one active assignment at a time
    // This prevents double-booking of drivers
    // =================================================================
    const activeAssignment = await db.getActiveAssignmentByDriver(data.driverId);
    if (activeAssignment) {
      logger.warn(`⚠️ Driver ${driver.name} already has active trip: ${activeAssignment.tripId}`);
      throw new AppError(400, 'DRIVER_BUSY', 
        `Driver ${driver.name} already has an active trip. Please assign a different driver.`);
    }

    // Get transporter info
    const transporter = await db.getUserById(transporterId);

    // Create assignment
    const tripId = uuid();
    const assignment: AssignmentRecord = {
      id: uuid(),
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

    await db.createAssignment(assignment);

    // Update booking trucks filled
    await bookingService.incrementTrucksFilled(data.bookingId);

    // Notify customer
    emitToBooking(data.bookingId, SocketEvent.TRUCK_ASSIGNED, {
      bookingId: data.bookingId,
      assignment: {
        id: assignment.id,
        vehicleNumber: assignment.vehicleNumber,
        driverName: assignment.driverName,
        status: assignment.status
      }
    });

    // Notify driver
    emitToUser(data.driverId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
      assignmentId: assignment.id,
      tripId,
      bookingId: data.bookingId,
      status: 'pending',
      message: 'New trip assigned to you'
    });

    logger.info(`Assignment created: ${assignment.id} for booking ${data.bookingId}`);
    return assignment;
  }

  // ==========================================================================
  // GET ASSIGNMENTS
  // ==========================================================================

  async getAssignments(
    userId: string,
    userRole: string,
    query: GetAssignmentsQuery
  ): Promise<{ assignments: AssignmentRecord[]; total: number; hasMore: boolean }> {
    let assignments: AssignmentRecord[];

    if (userRole === 'transporter') {
      assignments = await db.getAssignmentsByTransporter(userId);
    } else if (userRole === 'customer') {
      // Get customer's bookings, then get assignments for those
      const bookings = await db.getBookingsByCustomer(userId);
      const bookingIds = bookings.map(b => b.id);
      assignments = [];
      for (const bookingId of bookingIds) {
        const bookingAssignments = await db.getAssignmentsByBooking(bookingId);
        assignments.push(...bookingAssignments);
      }
    } else {
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

  async getDriverAssignments(
    driverId: string,
    query: GetAssignmentsQuery
  ): Promise<{ assignments: AssignmentRecord[]; total: number; hasMore: boolean }> {
    let assignments = await db.getAssignmentsByDriver(driverId);

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

  async getAssignmentById(
    assignmentId: string,
    userId: string,
    userRole: string
  ): Promise<AssignmentRecord> {
    const assignment = await db.getAssignmentById(assignmentId);

    if (!assignment) {
      throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found');
    }

    // Access control
    if (userRole === 'driver' && assignment.driverId !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied');
    }
    if (userRole === 'transporter' && assignment.transporterId !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied');
    }

    return assignment;
  }

  // ==========================================================================
  // UPDATE STATUS
  // ==========================================================================

  async acceptAssignment(
    assignmentId: string,
    driverId: string
  ): Promise<AssignmentRecord> {
    const assignment = await db.getAssignmentById(assignmentId);

    if (!assignment) {
      throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found');
    }

    if (assignment.driverId !== driverId) {
      throw new AppError(403, 'FORBIDDEN', 'This assignment is not for you');
    }

    if (assignment.status !== 'pending') {
      throw new AppError(400, 'INVALID_STATUS', 'Assignment cannot be accepted');
    }

    // =================================================================
    // RULE: ONE ACTIVE TRIP PER DRIVER (Double-check at accept time)
    // Even if assignment was created, driver might have accepted another
    // trip in the meantime. This is the final safety check.
    // =================================================================
    const activeAssignment = await db.getActiveAssignmentByDriver(driverId);
    if (activeAssignment && activeAssignment.id !== assignmentId) {
      logger.warn(`⚠️ Driver ${driverId} tried to accept ${assignmentId} but already has active trip: ${activeAssignment.tripId}`);
      throw new AppError(400, 'DRIVER_BUSY', 
        'You already have an active trip. Complete or cancel it before accepting a new one.');
    }

    const updated = await db.updateAssignment(assignmentId, {
      status: 'driver_accepted',
      driverAcceptedAt: new Date().toISOString()
    });

    // Notify booking room
    emitToBooking(assignment.bookingId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
      assignmentId,
      tripId: assignment.tripId,
      status: 'driver_accepted',
      vehicleNumber: assignment.vehicleNumber
    });

    logger.info(`Assignment accepted: ${assignmentId} by driver ${driverId}`);
    return updated!;
  }

  async updateStatus(
    assignmentId: string,
    driverId: string,
    data: UpdateStatusInput
  ): Promise<AssignmentRecord> {
    const assignment = await db.getAssignmentById(assignmentId);

    if (!assignment) {
      throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found');
    }

    if (assignment.driverId !== driverId) {
      throw new AppError(403, 'FORBIDDEN', 'This assignment is not for you');
    }

    const updates: Partial<AssignmentRecord> = {
      status: data.status as any
    };

    if (data.status === 'in_transit') {
      updates.startedAt = new Date().toISOString();
    }

    if (data.status === 'completed') {
      updates.completedAt = new Date().toISOString();
    }

    const updated = await db.updateAssignment(assignmentId, updates);

    // Notify booking room
    emitToBooking(assignment.bookingId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
      assignmentId,
      tripId: assignment.tripId,
      status: data.status,
      vehicleNumber: assignment.vehicleNumber
    });

    logger.info(`Assignment status updated: ${assignmentId} -> ${data.status}`);
    return updated!;
  }

  async cancelAssignment(
    assignmentId: string,
    userId: string
  ): Promise<void> {
    const assignment = await db.getAssignmentById(assignmentId);

    if (!assignment) {
      throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found');
    }

    // Only transporter or driver can cancel
    if (assignment.transporterId !== userId && assignment.driverId !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied');
    }

    await db.updateAssignment(assignmentId, { status: 'cancelled' });

    // Decrement trucks filled
    await bookingService.decrementTrucksFilled(assignment.bookingId);

    // Notify booking room
    emitToBooking(assignment.bookingId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
      assignmentId,
      tripId: assignment.tripId,
      status: 'cancelled',
      vehicleNumber: assignment.vehicleNumber
    });

    logger.info(`Assignment cancelled: ${assignmentId}`);
  }
}

export const assignmentService = new AssignmentService();
