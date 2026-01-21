/**
 * =============================================================================
 * BOOKING MODULE - SERVICE
 * =============================================================================
 *
 * Business logic for customer bookings.
 *
 * KEY FEATURES:
 * 1. Smart Matching Algorithm
 *    - Finds transporters with matching truck TYPE (simplified for testing)
 *    - Broadcasts to ALL matching transporters
 *
 * 2. Request Timeout System
 *    - Configurable timeout (5 min test / 30 min production)
 *    - Auto-expires unfilled bookings
 *    - Notifies customer with "No vehicle available"
 *
 * 3. Partial Fulfillment
 *    - Multiple transporters can fill same request
 *    - Tracks trucks filled vs trucks needed
 *    - Keeps broadcasting until all trucks filled or timeout
 *
 * SCALABILITY: Designed for millions of concurrent users
 * =============================================================================
 */
import { BookingRecord } from '../../shared/database/db';
import { CreateBookingInput, GetBookingsQuery } from './booking.schema';
declare class BookingService {
    /**
     * Create a new booking request
     *
     * ENHANCED BROADCAST SYSTEM:
     * 1. Customer selects vehicle type (e.g., "tipper", "20-24 Ton")
     * 2. System finds ALL transporters with that vehicle TYPE
     * 3. Broadcasts to ALL matching transporters simultaneously
     * 4. Starts timeout countdown
     * 5. Multiple transporters can accept (partial fulfillment)
     * 6. Auto-expires if not filled within timeout
     */
    createBooking(customerId: string, customerPhone: string, data: CreateBookingInput): Promise<BookingRecord & {
        matchingTransportersCount: number;
        timeoutSeconds: number;
    }>;
    /**
     * Start timeout timer for booking
     * Auto-expires booking if not fully filled within timeout
     */
    private startBookingTimeout;
    /**
     * Handle booking timeout - called when timer expires
     */
    private handleBookingTimeout;
    /**
     * Start countdown notifications to customer
     */
    private startCountdownNotifications;
    /**
     * Clear all timers for a booking
     */
    private clearBookingTimers;
    /**
     * Cancel booking timeout (called when fully filled)
     */
    cancelBookingTimeout(bookingId: string): void;
    /**
     * Get customer's bookings
     */
    getCustomerBookings(customerId: string, query: GetBookingsQuery): Promise<{
        bookings: BookingRecord[];
        total: number;
        hasMore: boolean;
    }>;
    /**
     * Get active broadcasts for a transporter
     * ONLY returns bookings where transporter has matching trucks!
     */
    getActiveBroadcasts(transporterId: string, query: GetBookingsQuery): Promise<{
        bookings: BookingRecord[];
        total: number;
        hasMore: boolean;
    }>;
    /**
     * Get booking by ID
     */
    getBookingById(bookingId: string, userId: string, userRole: string): Promise<BookingRecord>;
    /**
     * Get assigned trucks for a booking
     */
    getAssignedTrucks(bookingId: string, userId: string, userRole: string): Promise<any[]>;
    /**
     * Cancel booking
     */
    cancelBooking(bookingId: string, customerId: string): Promise<BookingRecord>;
    /**
     * Update trucks filled (called when assignment is created)
     * ENHANCED: Cancels timeout when fully filled, notifies all parties
     */
    incrementTrucksFilled(bookingId: string): Promise<BookingRecord>;
    /**
     * Decrement trucks filled (called when assignment is cancelled)
     */
    decrementTrucksFilled(bookingId: string): Promise<BookingRecord>;
}
export declare const bookingService: BookingService;
export {};
//# sourceMappingURL=booking.service.d.ts.map