/**
 * =============================================================================
 * ASSIGNMENT MODULE - QUERY SERVICE
 * =============================================================================
 *
 * Read-only queries: list assignments, get by ID, driver assignments.
 * =============================================================================
 */

import { db, AssignmentRecord } from '../../shared/database/db';
import { prismaClient } from '../../shared/database/prisma.service';
import { AppError } from '../../shared/types/error.types';
import { GetAssignmentsQuery } from './assignment.schema';

// =============================================================================
// QUERY SERVICE
// =============================================================================

class AssignmentQueryService {
  // ==========================================================================
  // GET ASSIGNMENTS
  // ==========================================================================

  async getAssignments(
    userId: string,
    userRole: string,
    query: GetAssignmentsQuery
  ): Promise<{ assignments: AssignmentRecord[]; total: number; hasMore: boolean }> {
    let assignments: AssignmentRecord[];

    // PRESERVING WORKING CODE: Use existing db methods that return AssignmentRecord[]
    if (userRole === 'transporter') {
      assignments = await db.getAssignmentsByTransporter(userId);
    } else if (userRole === 'customer') {
      // SAFE FIX: Replace N+1 loop with single Prisma query with relation
      // Get customer's bookings IDs once
      const bookings = await db.getBookingsByCustomer(userId);
      const bookingIds = (bookings as Array<{ id: string }>).map((b) => b.id);

      if (bookingIds.length === 0) {
        return { assignments: [], total: 0, hasMore: false };
      }

      // Build where clause for optional status/booking filters
      const where: Record<string, unknown> = { bookingId: { in: bookingIds } };
      if (query.status) {
        where.status = query.status;
      }
      if (query.bookingId) {
        where.bookingId = query.bookingId;
      }

      // DB-level pagination: count + paginated fetch in parallel
      const skip = (query.page - 1) * query.limit;
      const [total, rawAssignments] = await Promise.all([
        prismaClient.assignment.count({ where }),
        prismaClient.assignment.findMany({
          where,
          orderBy: { assignedAt: 'desc' },
          skip,
          take: query.limit
        })
      ]);

      // Convert Prisma result to AssignmentRecord format using existing helper
      assignments = rawAssignments.map(a => ({
        id: a.id,
        bookingId: a.bookingId || '',
        truckRequestId: a.truckRequestId || '',
        orderId: a.orderId || '',
        transporterId: a.transporterId,
        transporterName: '', // Not selected in WHERE IN - would need JOIN
        vehicleId: a.vehicleId,
        vehicleNumber: a.vehicleNumber,
        vehicleType: a.vehicleType,
        vehicleSubtype: a.vehicleSubtype,
        driverId: a.driverId,
        driverName: a.driverName || '',
        driverPhone: '',
        tripId: a.tripId,
        assignedAt: a.assignedAt || '', // Already string in DB
        driverAcceptedAt: a.driverAcceptedAt || '', // Already string
        status: a.status as AssignmentRecord['status'],
        startedAt: (a as { startedAt?: string | null }).startedAt || '',
        completedAt: (a as { completedAt?: string | null }).completedAt || ''
      } as AssignmentRecord));

      const hasMore = skip + assignments.length < total;
      return { assignments, total, hasMore };
    } else {
      assignments = [];
    }

    // Filter by status (keeping existing pattern to preserve behavior)
    if (query.status) {
      assignments = assignments.filter((a) => a.status === query.status);
    }

    // Filter by booking (keeping existing pattern)
    if (query.bookingId) {
      assignments = assignments.filter(a => a.bookingId === query.bookingId);
    }

    const total = assignments.length;

    // Pagination (keeping existing pattern)
    const start = (query.page - 1) * query.limit;
    assignments = assignments.slice(start, start + query.limit);
    const hasMore = start + assignments.length < total;

    return { assignments, total, hasMore };
  }

  async getDriverAssignments(
    driverId: string,
    query: GetAssignmentsQuery
  ): Promise<{ assignments: AssignmentRecord[]; total: number; hasMore: boolean }> {
    // PRESERVING WORKING CODE: Use existing db method
    let assignments: AssignmentRecord[] = await db.getAssignmentsByDriver(driverId);

    // Filter by status (keeping existing working pattern)
    if (query.status) {
      assignments = assignments.filter((a) => a.status === query.status);
    }

    const total = assignments.length;

    // Pagination (keeping existing working pattern)
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
}

export const assignmentQueryService = new AssignmentQueryService();
