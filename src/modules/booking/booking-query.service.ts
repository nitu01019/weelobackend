/**
 * =============================================================================
 * BOOKING MODULE - QUERY SERVICE
 * =============================================================================
 *
 * Handles:
 * - getCustomerBookings
 * - getActiveBroadcasts
 * - getBookingById
 * - getAssignedTrucks
 * =============================================================================
 */

import { db, BookingRecord, VehicleRecord, AssignmentRecord } from '../../shared/database/db';
import { prismaClient } from '../../shared/database/prisma.service';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { GetBookingsQuery } from './booking.schema';
// 4 PRINCIPLES: Import production-grade error codes
import { ErrorCode } from '../../core/constants';

export class BookingQueryService {

  // ==========================================================================
  // GET BOOKINGS
  // ==========================================================================

  /**
   * Get customer's bookings
   */
  async getCustomerBookings(
    customerId: string,
    query: GetBookingsQuery
  ): Promise<{ bookings: BookingRecord[]; total: number; hasMore: boolean }> {
    let bookings = await db.getBookingsByCustomer(customerId);

    // Filter by status
    if (query.status) {
      bookings = bookings.filter((b: BookingRecord) => b.status === query.status);
    }

    // Sort by newest first
    bookings.sort((a: BookingRecord, b: BookingRecord) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = bookings.length;

    // Pagination
    const start = (query.page - 1) * query.limit;
    bookings = bookings.slice(start, start + query.limit);

    return {
      bookings,
      total,
      hasMore: start + bookings.length < total
    };
  }

  /**
   * Get active broadcasts for a transporter
   * ONLY returns bookings where transporter has matching trucks!
   */
  async getActiveBroadcasts(
    transporterId: string,
    query: GetBookingsQuery
  ): Promise<{ bookings: BookingRecord[]; total: number; hasMore: boolean }> {
    // Get bookings that match this transporter's vehicle types
    let bookings = await db.getActiveBookingsForTransporter(transporterId);

    // Only show active/partially filled and not expired
    // Fix E5: Filter out bookings past their expiresAt even if status not yet updated
    const now = new Date();
    bookings = bookings.filter((b: BookingRecord) =>
      (b.status === 'active' || b.status === 'partially_filled')
      && (!b.expiresAt || new Date(b.expiresAt) > now)
    );

    // Sort by newest first
    bookings.sort((a: BookingRecord, b: BookingRecord) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = bookings.length;

    // Pagination
    // FIX F-4-1: Add page param for reconnect broadcasts
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const start = (page - 1) * limit;
    bookings = bookings.slice(start, start + limit);

    logger.info(`Transporter ${transporterId} can see ${total} matching bookings`);

    return {
      bookings,
      total,
      hasMore: start + bookings.length < total
    };
  }

  /**
   * Get booking by ID.
   *
   * FIX #36 (TEAM LEO audit): A single retry after 100ms handles the
   * case where a booking is fetched immediately after a transaction
   * commits and a read-replica has not yet replicated the row.
   * This is a standard pattern for RDS read-replica lag (typically <50ms).
   */
  async getBookingById(
    bookingId: string,
    userId: string,
    userRole: string
  ): Promise<BookingRecord> {
    let booking = await db.getBookingById(bookingId);

    if (!booking) {
      // Retry once after short delay -- handles replication lag
      await new Promise(r => setTimeout(r, 100));
      booking = await db.getBookingById(bookingId);
    }

    if (!booking) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }

    // Access control
    if (userRole === 'customer' && booking.customerId !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied');
    }

    // Transporters can only see if they have matching vehicles
    if (userRole === 'transporter') {
      const transporterVehicles = await db.getVehiclesByTransporter(userId);
      const hasMatchingVehicle = transporterVehicles.some(
        (v: VehicleRecord) => v.vehicleType === booking.vehicleType && v.isActive
      );

      if (!hasMatchingVehicle) {
        // 4 PRINCIPLES: Business logic error (insufficient vehicles)
        throw new AppError(403, ErrorCode.VEHICLE_INSUFFICIENT, 'You do not have matching vehicles for this booking');
      }
    }

    return booking;
  }

  /**
   * Get assigned trucks for a booking
   */
  async getAssignedTrucks(
    bookingId: string,
    userId: string,
    userRole: string
  ): Promise<any[]> {
    const booking = await db.getBookingById(bookingId);

    if (!booking) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }

    // Verify access
    if (userRole === 'customer' && booking.customerId !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied');
    }

    // Get assignments for this booking
    const assignments = await db.getAssignmentsByBooking(bookingId);

    // Batch fetch driver ratings — single query, no N+1
    const driverIds: string[] = assignments.map((a: AssignmentRecord) => String(a.driverId || '')).filter((id: string) => id.length > 0);
    const uniqueDriverIds = [...new Set(driverIds)];
    let driverRatingsMap: Map<string, { avg: number | null, total: number }> = new Map();
    if (uniqueDriverIds.length > 0) {
      try {
        const drivers = await prismaClient.user.findMany({
          where: { id: { in: uniqueDriverIds } },
          select: { id: true, avgRating: true, totalRatings: true }
        });
        drivers.forEach(d => driverRatingsMap.set(d.id, { avg: d.avgRating, total: d.totalRatings }));
      } catch (err) {
        // Graceful fallback — don't block tracking if rating query fails
        logger.warn('[BOOKING] Failed to fetch driver ratings, falling back', { error: (err as Error).message });
      }
    }

    type ExtendedAssignment = AssignmentRecord & {
      driverProfilePhotoUrl?: string;
      customerRating?: number | null;
      currentLocation?: string | null;
    };
    return assignments.map((a: AssignmentRecord) => {
      const ext = a as ExtendedAssignment;
      const driverRatingData = driverRatingsMap.get(a.driverId);
      return {
        assignmentId: a.id,
        tripId: a.tripId,
        vehicleNumber: a.vehicleNumber,
        vehicleType: a.vehicleType,
        driverName: a.driverName,
        driverPhone: a.driverPhone,
        driverProfilePhotoUrl: ext.driverProfilePhotoUrl || null,
        driverRating: driverRatingData?.avg ?? null,     // Real avg rating from DB (null = new driver)
        driverTotalRatings: driverRatingData?.total ?? 0, // How many ratings
        customerRating: ext.customerRating ?? null,          // This customer's rating for this trip
        status: a.status,
        assignedAt: a.assignedAt,
        currentLocation: ext.currentLocation || null
      };
    });
  }
}

export const bookingQueryService = new BookingQueryService();
