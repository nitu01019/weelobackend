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

import { v4 as uuid } from 'uuid';
import { db, BookingRecord } from '../../shared/database/db';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, emitToBooking, SocketEvent, isUserConnected } from '../../shared/services/socket.service';
import { fcmService } from '../../shared/services/fcm.service';
import { CreateBookingInput, GetBookingsQuery } from './booking.schema';
import { availabilityService } from '../../shared/services/availability.service';
import { generateVehicleKey } from '../../shared/services/vehicle-key.service';
import { redisService } from '../../shared/services/redis.service';
// 4 PRINCIPLES: Import production-grade error codes
import { ErrorCode } from '../../core/constants';

// =============================================================================
// CONFIGURATION - Easy to adjust for testing vs production
// =============================================================================

const BOOKING_CONFIG = {
  // Timeout in milliseconds (1 minute for quick response)
  TIMEOUT_MS: 1 * 60 * 1000,  // 60 seconds
  
  // How often to check for expired bookings (Redis-based)
  EXPIRY_CHECK_INTERVAL_MS: 5 * 1000,  // Every 5 seconds
  
  // Countdown notification interval (notify customer of remaining time)
  COUNTDOWN_INTERVAL_MS: 60 * 1000,  // Every 1 minute
};

// =============================================================================
// REDIS KEY PATTERNS (for distributed timers)
// =============================================================================
const TIMER_KEYS = {
  BOOKING_EXPIRY: (bookingId: string) => `timer:booking:${bookingId}`,
  COUNTDOWN: (bookingId: string) => `timer:countdown:${bookingId}`,
};

// Timer data interface
interface BookingTimerData {
  bookingId: string;
  customerId: string;
  createdAt: string;
}

// =============================================================================
// EXPIRY CHECKER (Runs on every server instance - Redis ensures no duplicates)
// =============================================================================
let expiryCheckerInterval: NodeJS.Timeout | null = null;

/**
 * Start the booking expiry checker
 * This runs on every server instance but uses Redis locks to prevent duplicate processing
 */
function startBookingExpiryChecker(): void {
  if (expiryCheckerInterval) return;
  
  expiryCheckerInterval = setInterval(async () => {
    try {
      await processExpiredBookings();
    } catch (error: any) {
      logger.error('Booking expiry checker error', { error: error.message });
    }
  }, BOOKING_CONFIG.EXPIRY_CHECK_INTERVAL_MS);
  
  logger.info('📅 Booking expiry checker started (Redis-based, cluster-safe)');
}

/**
 * Process all expired booking timers
 * Uses Redis distributed lock to prevent multiple instances processing the same booking
 */
async function processExpiredBookings(): Promise<void> {
  const expiredTimers = await redisService.getExpiredTimers<BookingTimerData>('timer:booking:');
  
  for (const timer of expiredTimers) {
    // Try to acquire lock for this booking (prevents duplicate processing)
    const lockKey = `lock:booking-expiry:${timer.data.bookingId}`;
    const lock = await redisService.acquireLock(lockKey, 'expiry-checker', 30);
    
    if (!lock.acquired) {
      // Another instance is processing this booking
      continue;
    }
    
    try {
      await bookingService.handleBookingTimeout(timer.data.bookingId, timer.data.customerId);
      await redisService.cancelTimer(timer.key);
    } catch (error: any) {
      logger.error('Failed to process expired booking', { 
        bookingId: timer.data.bookingId, 
        error: error.message 
      });
    } finally {
      await redisService.releaseLock(lockKey, 'expiry-checker');
    }
  }
}

// Start expiry checker when module loads
startBookingExpiryChecker();

class BookingService {
  
  // ==========================================================================
  // CREATE BOOKING (CUSTOMER)
  // ==========================================================================

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
   * 
   * SCALABILITY:
   * - Idempotency key prevents duplicate bookings
   * - Redis stores key for 24 hours
   * - Supports millions of concurrent users
   * 
   * EASY UNDERSTANDING:
   * - If idempotency key exists, return cached booking
   * - Otherwise create new booking and cache key
   */
  async createBooking(
    customerId: string,
    customerPhone: string,
    data: CreateBookingInput,
    idempotencyKey?: string
  ): Promise<BookingRecord & { matchingTransportersCount: number; timeoutSeconds: number }> {
    // SCALABILITY: Check idempotency key to prevent duplicate bookings
    if (idempotencyKey) {
      const cacheKey = `idempotency:booking:${customerId}:${idempotencyKey}`;
      const cachedBooking = await redisService.get(cacheKey) as string | null;
      
      if (cachedBooking) {
        // EASY UNDERSTANDING: Duplicate request detected, return existing booking
        logger.info(`🔒 Idempotency: Duplicate booking request detected`, {
          customerId,
          idempotencyKey,
          existingBookingId: cachedBooking
        });
        
        const existingBooking = await db.getBookingById(cachedBooking);
        if (existingBooking) {
          const matchingTransporters = await db.getTransportersWithVehicleType(data.vehicleType);
          return {
            ...existingBooking,
            matchingTransportersCount: matchingTransporters.length,
            timeoutSeconds: Math.floor(BOOKING_CONFIG.TIMEOUT_MS / 1000)
          };
        }
      }
    }
    
    // Get customer name
    const customer = await db.getUserById(customerId);
    const customerName = customer?.name || 'Customer';

    // Calculate expiry based on config timeout
    const expiresAt = new Date(Date.now() + BOOKING_CONFIG.TIMEOUT_MS).toISOString();

    // ========================================
    // SMART MATCHING: Find NEARBY transporters with matching vehicle TYPE
    // Uses geohash-indexed availability service for O(1) proximity lookups
    // Falls back to database query if no live transporters available
    // ========================================
    const vehicleKey = generateVehicleKey(data.vehicleType, data.vehicleSubtype);
    
    // First, try to find nearby ONLINE transporters (from heartbeat data)
    // Uses Redis GEORADIUS for O(log N) proximity search
    let nearbyTransporters = await availabilityService.getAvailableTransportersAsync(
      vehicleKey,
      data.pickup.coordinates.latitude,
      data.pickup.coordinates.longitude,
      20, // Get top 20 nearest transporters
      50  // 50km radius
    );
    
    logger.info(`📍 Found ${nearbyTransporters.length} NEARBY online transporters for ${vehicleKey}`);
    
    // Fallback: If no nearby online transporters, get ALL transporters with matching vehicle type
    // This ensures we still broadcast even if no one has sent heartbeats recently
    let matchingTransporters: string[];
    if (nearbyTransporters.length > 0) {
      matchingTransporters = nearbyTransporters;
      logger.info(`🎯 Using PROXIMITY-BASED matching (${nearbyTransporters.length} nearby)`);
    } else {
      matchingTransporters = await db.getTransportersWithVehicleType(data.vehicleType);
      logger.info(`📋 Fallback to DATABASE matching (${matchingTransporters.length} total)`);
    }

    logger.info(`╔══════════════════════════════════════════════════════════════╗`);
    logger.info(`║  🚛 NEW BOOKING REQUEST                                       ║`);
    logger.info(`╠══════════════════════════════════════════════════════════════╣`);
    logger.info(`║  Vehicle: ${data.vehicleType} - ${data.vehicleSubtype || 'Any'}`);
    logger.info(`║  Trucks Needed: ${data.trucksNeeded}`);
    logger.info(`║  Price/Truck: ₹${data.pricePerTruck}`);
    logger.info(`║  Distance: ${data.distanceKm} km`);
    logger.info(`║  Matching Transporters: ${matchingTransporters.length}`);
    logger.info(`║  Timeout: ${BOOKING_CONFIG.TIMEOUT_MS / 1000} seconds`);
    logger.info(`╚══════════════════════════════════════════════════════════════╝`);

    // Create booking
    const booking = await db.createBooking({
      id: uuid(),
      customerId,
      customerName,
      customerPhone,
      pickup: {
        latitude: data.pickup.coordinates.latitude,
        longitude: data.pickup.coordinates.longitude,
        address: data.pickup.address,
        city: data.pickup.city,
        state: data.pickup.state
      },
      drop: {
        latitude: data.drop.coordinates.latitude,
        longitude: data.drop.coordinates.longitude,
        address: data.drop.address,
        city: data.drop.city,
        state: data.drop.state
      },
      vehicleType: data.vehicleType,
      vehicleSubtype: data.vehicleSubtype,
      trucksNeeded: data.trucksNeeded,
      trucksFilled: 0,
      distanceKm: data.distanceKm,
      pricePerTruck: data.pricePerTruck,
      totalAmount: data.pricePerTruck * data.trucksNeeded,
      goodsType: data.goodsType,
      weight: data.weight,
      status: 'active',
      notifiedTransporters: matchingTransporters,
      scheduledAt: data.scheduledAt,
      expiresAt
    });

    // ========================================
    // HANDLE: No matching transporters found
    // ========================================
    if (matchingTransporters.length === 0) {
      logger.warn(`⚠️ NO TRANSPORTERS FOUND for ${data.vehicleType}`);
      
      // Immediately notify customer
      emitToUser(customerId, SocketEvent.NO_VEHICLES_AVAILABLE, {
        bookingId: booking.id,
        vehicleType: data.vehicleType,
        vehicleSubtype: data.vehicleSubtype,
        message: `No ${data.vehicleType} vehicles available right now. Please try again later or select a different vehicle type.`,
        suggestion: 'search_again'
      });

      // Mark as expired immediately
      await db.updateBooking(booking.id, { status: 'expired' });
      
      return {
        ...booking,
        status: 'expired',
        matchingTransportersCount: 0,
        timeoutSeconds: 0
      };
    }

    // ========================================
    // BROADCAST TO ALL MATCHING TRANSPORTERS
    // ========================================
    // IMPORTANT: Include broadcastId AND orderId for Captain app compatibility
    // Captain app's SocketIOService checks broadcastId first, then orderId
    const broadcastPayload = {
      broadcastId: booking.id,  // CRITICAL: Captain app expects this!
      orderId: booking.id,      // Alias for compatibility
      bookingId: booking.id,
      customerId: booking.customerId,
      customerName: booking.customerName,
      vehicleType: booking.vehicleType,
      vehicleSubtype: booking.vehicleSubtype,
      trucksNeeded: booking.trucksNeeded,
      totalTrucksNeeded: booking.trucksNeeded,  // Alias for Captain app
      trucksFilled: 0,
      trucksFilledSoFar: 0,  // Alias for Captain app
      pricePerTruck: booking.pricePerTruck,
      farePerTruck: booking.pricePerTruck,  // Alias for Captain app
      totalFare: booking.totalAmount,
      // Nested location format (for Captain app)
      pickupLocation: {
        address: booking.pickup.address,
        city: booking.pickup.city,
        latitude: booking.pickup.latitude,
        longitude: booking.pickup.longitude
      },
      dropLocation: {
        address: booking.drop.address,
        city: booking.drop.city,
        latitude: booking.drop.latitude,
        longitude: booking.drop.longitude
      },
      // Flat format (legacy)
      pickupAddress: booking.pickup.address,
      pickupCity: booking.pickup.city,
      dropAddress: booking.drop.address,
      dropCity: booking.drop.city,
      distanceKm: booking.distanceKm,
      distance: booking.distanceKm,  // Alias for Captain app
      goodsType: booking.goodsType,
      weight: data.weight,
      createdAt: booking.createdAt,
      expiresAt: booking.expiresAt,
      timeoutSeconds: BOOKING_CONFIG.TIMEOUT_MS / 1000,
      isUrgent: false,
      // requestedVehicles array for multi-truck UI compatibility
      requestedVehicles: [{
        vehicleType: booking.vehicleType,
        vehicleSubtype: booking.vehicleSubtype || '',
        count: booking.trucksNeeded,
        filledCount: 0,
        farePerTruck: booking.pricePerTruck,
        capacityTons: 0
      }]
    };

    logger.info(`╔══════════════════════════════════════════════════════════════╗`);
    logger.info(`║  📢 BROADCASTING TO ${matchingTransporters.length} TRANSPORTERS                        ║`);
    logger.info(`╚══════════════════════════════════════════════════════════════╝`);
    logger.info(`Broadcast payload: ${JSON.stringify(broadcastPayload, null, 2).substring(0, 500)}...`);
    
    for (const transporterId of matchingTransporters) {
      const transporter = await db.getUserById(transporterId);
      const isConnected = isUserConnected(transporterId);
      
      logger.info(`📢 Emitting to: ${transporter?.name || 'Unknown'} (ID: ${transporterId})`);
      logger.info(`   - Business: ${transporter?.businessName || 'N/A'}`);
      logger.info(`   - WebSocket connected: ${isConnected ? '✅ YES' : '❌ NO'}`);
      logger.info(`   - isAvailable: ${transporter?.isAvailable !== false ? '✅ YES' : '❌ NO'}`);
      
      // Send via WebSocket (for app in foreground)
      emitToUser(transporterId, SocketEvent.NEW_BROADCAST, broadcastPayload);

      logger.info(`   ✅ emitToUser() called for ${transporter?.name || transporterId}`);
    }

    // ========================================
    // SEND FCM PUSH NOTIFICATIONS (for app in background)
    // ========================================
    fcmService.notifyNewBroadcast(matchingTransporters, {
      broadcastId: booking.id,
      customerName: booking.customerName,
      vehicleType: booking.vehicleType,
      trucksNeeded: booking.trucksNeeded,
      farePerTruck: booking.pricePerTruck,
      pickupCity: booking.pickup.city,
      dropCity: booking.drop.city
    }).then(sentCount => {
      logger.info(`📱 FCM: Push notifications sent to ${sentCount}/${matchingTransporters.length} transporters`);
    }).catch(err => {
      logger.warn('📱 FCM: Failed to send push notifications', err);
    });

    // ========================================
    // START TIMEOUT TIMER
    // ========================================
    this.startBookingTimeout(booking.id, customerId);

    // ========================================
    // START COUNTDOWN NOTIFICATIONS (optional)
    // ========================================
    this.startCountdownNotifications(booking.id, customerId);

    logger.info(`✅ Booking ${booking.id} created, ${matchingTransporters.length} transporters notified`);

    // SCALABILITY: Store idempotency key to prevent duplicate bookings
    if (idempotencyKey) {
      const cacheKey = `idempotency:booking:${customerId}:${idempotencyKey}`;
      // Store for 24 hours (TTL in seconds)
      await redisService.set(cacheKey, booking.id, 24 * 60 * 60);
      logger.info(`🔒 Idempotency key stored for booking ${booking.id}`, { idempotencyKey });
    }

    return {
      ...booking,
      matchingTransportersCount: matchingTransporters.length,
      timeoutSeconds: BOOKING_CONFIG.TIMEOUT_MS / 1000
    };
  }

  /**
   * Start timeout timer for booking (Redis-based for cluster support)
   * Auto-expires booking if not fully filled within timeout
   * 
   * SCALABILITY: Uses Redis timers instead of in-memory setTimeout
   * - Works across multiple server instances
   * - Survives server restarts
   * - No duplicate processing (Redis locks)
   */
  private async startBookingTimeout(bookingId: string, customerId: string): Promise<void> {
    // Cancel any existing timer for this booking
    await redisService.cancelTimer(TIMER_KEYS.BOOKING_EXPIRY(bookingId));
    
    // Set new timer in Redis
    const expiresAt = new Date(Date.now() + BOOKING_CONFIG.TIMEOUT_MS);
    const timerData: BookingTimerData = {
      bookingId,
      customerId,
      createdAt: new Date().toISOString()
    };
    
    await redisService.setTimer(TIMER_KEYS.BOOKING_EXPIRY(bookingId), timerData, expiresAt);
    
    logger.info(`⏱️ Timeout timer started for booking ${bookingId} (${BOOKING_CONFIG.TIMEOUT_MS / 1000}s) [Redis-based]`);
  }

  /**
   * Handle booking timeout - called when timer expires
   * Made public for the expiry checker to call
   */
  async handleBookingTimeout(bookingId: string, customerId: string): Promise<void> {
    const booking = await db.getBookingById(bookingId);
    
    if (!booking) {
      logger.warn(`Booking ${bookingId} not found for timeout handling`);
      return;
    }

    // Skip if already completed or cancelled
    if (['fully_filled', 'completed', 'cancelled'].includes(booking.status)) {
      logger.info(`Booking ${bookingId} already ${booking.status}, skipping timeout`);
      this.clearBookingTimers(bookingId);
      return;
    }

    logger.info(`⏰ TIMEOUT: Booking ${bookingId} expired`);

    // Check if partially filled
    if (booking.trucksFilled > 0 && booking.trucksFilled < booking.trucksNeeded) {
      // Partially filled - notify customer
      await db.updateBooking(bookingId, { status: 'expired' });
      
      emitToUser(customerId, SocketEvent.BOOKING_EXPIRED, {
        bookingId,
        status: 'partially_filled_expired',
        trucksNeeded: booking.trucksNeeded,
        trucksFilled: booking.trucksFilled,
        message: `Only ${booking.trucksFilled} of ${booking.trucksNeeded} trucks were assigned. Would you like to continue with partial fulfillment or search again?`,
        options: ['continue_partial', 'search_again', 'cancel']
      });

      // Also notify via booking room
      emitToBooking(bookingId, SocketEvent.BOOKING_EXPIRED, {
        bookingId,
        status: 'partially_filled_expired',
        trucksFilled: booking.trucksFilled
      });

    } else if (booking.trucksFilled === 0) {
      // No trucks filled - "No vehicle available"
      await db.updateBooking(bookingId, { status: 'expired' });
      
      emitToUser(customerId, SocketEvent.NO_VEHICLES_AVAILABLE, {
        bookingId,
        vehicleType: booking.vehicleType,
        vehicleSubtype: booking.vehicleSubtype,
        message: `No ${booking.vehicleType} available right now. We'll help you find alternatives.`,
        suggestion: 'search_again',
        options: ['search_again', 'try_different_vehicle', 'cancel']
      });

      emitToBooking(bookingId, SocketEvent.BOOKING_EXPIRED, {
        bookingId,
        status: 'expired',
        trucksFilled: 0
      });
    }

    // Clear timers
    this.clearBookingTimers(bookingId);

    // Notify all transporters that this broadcast is no longer available
    for (const transporterId of booking.notifiedTransporters) {
      emitToUser(transporterId, SocketEvent.BOOKING_EXPIRED, {
        bookingId,
        message: 'This booking request has expired'
      });
    }
  }

  /**
   * Start countdown notifications to customer
   * 
   * NOTE: Countdown is still local per-instance as it's just UI updates
   * If user reconnects to different server, they get fresh countdown from booking state
   */
  private startCountdownNotifications(bookingId: string, customerId: string): void {
    // For countdown, we can use local interval as it's just for UI updates
    // The actual expiry is handled by Redis-based timer
    let remainingMs = BOOKING_CONFIG.TIMEOUT_MS;

    const countdownInterval = setInterval(async () => {
      remainingMs -= BOOKING_CONFIG.COUNTDOWN_INTERVAL_MS;
      
      if (remainingMs <= 0) {
        clearInterval(countdownInterval);
        return;
      }

      const booking = await db.getBookingById(bookingId);
      if (!booking || ['fully_filled', 'completed', 'cancelled', 'expired'].includes(booking.status)) {
        clearInterval(countdownInterval);
        return;
      }

      // Send countdown update
      emitToUser(customerId, SocketEvent.BROADCAST_COUNTDOWN, {
        bookingId,
        remainingSeconds: Math.floor(remainingMs / 1000),
        trucksNeeded: booking.trucksNeeded,
        trucksFilled: booking.trucksFilled,
        status: booking.status
      });

    }, BOOKING_CONFIG.COUNTDOWN_INTERVAL_MS);
    
    // Store reference locally (countdown is per-instance, not critical)
    // The Redis timer handles the actual expiry
  }

  /**
   * Clear all timers for a booking (Redis-based)
   */
  private async clearBookingTimers(bookingId: string): Promise<void> {
    await redisService.cancelTimer(TIMER_KEYS.BOOKING_EXPIRY(bookingId));
  }

  /**
   * Cancel booking timeout (called when fully filled)
   */
  async cancelBookingTimeout(bookingId: string): Promise<void> {
    await this.clearBookingTimers(bookingId);
    logger.info(`⏱️ Timeout cancelled for booking ${bookingId}`);
  }

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
      bookings = bookings.filter(b => b.status === query.status);
    }

    // Sort by newest first
    bookings.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

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

    // Only show active/partially filled
    bookings = bookings.filter(b => 
      b.status === 'active' || b.status === 'partially_filled'
    );

    // Sort by newest first
    bookings.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = bookings.length;

    // Pagination
    const start = (query.page - 1) * query.limit;
    bookings = bookings.slice(start, start + query.limit);

    logger.info(`Transporter ${transporterId} can see ${total} matching bookings`);

    return {
      bookings,
      total,
      hasMore: start + bookings.length < total
    };
  }

  /**
   * Get booking by ID
   */
  async getBookingById(
    bookingId: string,
    userId: string,
    userRole: string
  ): Promise<BookingRecord> {
    const booking = await db.getBookingById(bookingId);

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
        v => v.vehicleType === booking.vehicleType && v.isActive
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

    return assignments.map(a => ({
      assignmentId: a.id,
      tripId: a.tripId,
      vehicleNumber: a.vehicleNumber,
      vehicleType: a.vehicleType,
      driverName: a.driverName,
      driverPhone: a.driverPhone,
      status: a.status,
      assignedAt: a.assignedAt
    }));
  }

  // ==========================================================================
  // UPDATE BOOKING
  // ==========================================================================

  /**
   * Cancel booking
   */
  async cancelBooking(bookingId: string, customerId: string): Promise<BookingRecord> {
    const booking = await db.getBookingById(bookingId);

    if (!booking) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }

    if (booking.customerId !== customerId) {
      throw new AppError(403, 'FORBIDDEN', 'You can only cancel your own bookings');
    }

    if (booking.status === 'cancelled' || booking.status === 'completed') {
      throw new AppError(400, 'INVALID_STATUS', 'Booking cannot be cancelled');
    }

    const updated = await db.updateBooking(bookingId, { status: 'cancelled' });

    // Notify via WebSocket
    emitToBooking(bookingId, SocketEvent.BOOKING_UPDATED, {
      bookingId,
      status: 'cancelled'
    });

    logger.info(`Booking cancelled: ${bookingId}`);
    return updated!;
  }

  /**
   * Update trucks filled (called when assignment is created)
   * ENHANCED: Cancels timeout when fully filled, notifies all parties
   */
  async incrementTrucksFilled(bookingId: string): Promise<BookingRecord> {
    const booking = await db.getBookingById(bookingId);

    if (!booking) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }

    const newFilled = booking.trucksFilled + 1;
    const newStatus = newFilled >= booking.trucksNeeded ? 'fully_filled' : 'partially_filled';

    const updated = await db.updateBooking(bookingId, {
      trucksFilled: newFilled,
      status: newStatus
    });

    // Notify customer via WebSocket
    emitToUser(booking.customerId, SocketEvent.BOOKING_UPDATED, {
      bookingId,
      status: newStatus,
      trucksFilled: newFilled,
      trucksNeeded: booking.trucksNeeded,
      message: newStatus === 'fully_filled' 
        ? `🎉 All ${booking.trucksNeeded} trucks assigned! Your booking is complete.`
        : `✅ ${newFilled}/${booking.trucksNeeded} trucks assigned. Searching for more...`
    });

    // Also notify via booking room
    emitToBooking(bookingId, SocketEvent.BOOKING_UPDATED, {
      bookingId,
      status: newStatus,
      trucksFilled: newFilled,
      trucksNeeded: booking.trucksNeeded
    });

    // If fully filled, cancel timeout and notify
    if (newStatus === 'fully_filled') {
      this.cancelBookingTimeout(bookingId);
      
      // Send fully filled event to customer
      emitToUser(booking.customerId, SocketEvent.BOOKING_FULLY_FILLED, {
        bookingId,
        trucksNeeded: booking.trucksNeeded,
        trucksFilled: newFilled,
        message: 'All trucks have been assigned to your booking!'
      });

      // Notify remaining transporters that booking is no longer available
      for (const transporterId of booking.notifiedTransporters) {
        emitToUser(transporterId, SocketEvent.BOOKING_UPDATED, {
          bookingId,
          status: 'fully_filled',
          message: 'This booking has been fully filled'
        });
      }

      logger.info(`🎉 Booking ${bookingId} FULLY FILLED: ${newFilled}/${booking.trucksNeeded} trucks`);
    } else {
      // Partially filled - notify customer
      emitToUser(booking.customerId, SocketEvent.BOOKING_PARTIALLY_FILLED, {
        bookingId,
        trucksNeeded: booking.trucksNeeded,
        trucksFilled: newFilled,
        remaining: booking.trucksNeeded - newFilled,
        message: `${newFilled} truck${newFilled > 1 ? 's' : ''} assigned, searching for ${booking.trucksNeeded - newFilled} more...`
      });

      logger.info(`📦 Booking ${bookingId} PARTIALLY FILLED: ${newFilled}/${booking.trucksNeeded} trucks`);
    }

    return updated!;
  }

  /**
   * Decrement trucks filled (called when assignment is cancelled)
   */
  async decrementTrucksFilled(bookingId: string): Promise<BookingRecord> {
    const booking = await db.getBookingById(bookingId);

    if (!booking) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }

    const newFilled = Math.max(0, booking.trucksFilled - 1);
    const newStatus = newFilled === 0 ? 'active' : 'partially_filled';

    const updated = await db.updateBooking(bookingId, {
      trucksFilled: newFilled,
      status: newStatus
    });

    // Notify via WebSocket
    emitToBooking(bookingId, SocketEvent.BOOKING_UPDATED, {
      bookingId,
      status: newStatus,
      trucksFilled: newFilled,
      trucksNeeded: booking.trucksNeeded
    });

    return updated!;
  }
}

export const bookingService = new BookingService();
