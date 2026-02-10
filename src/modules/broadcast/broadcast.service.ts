/**
 * =============================================================================
 * BROADCAST MODULE - SERVICE
 * =============================================================================
 * 
 * Business logic for broadcast management.
 * Broadcasts are booking requests sent to drivers/transporters.
 * 
 * =============================================================================
 */

import { v4 as uuidv4 } from 'uuid';
import { db, BookingRecord, AssignmentRecord } from '../../shared/database/db';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, emitToRoom, emitToAllTransporters, emitToAll } from '../../shared/services/socket.service';
import { sendPushNotification } from '../../shared/services/fcm.service';

// =============================================================================
// BROADCAST EXPIRY EVENTS - For real-time timeout handling
// =============================================================================
// When a broadcast expires, we MUST notify ALL transporters immediately
// so they can remove it from their overlay/list. This prevents confusion
// where one transporter sees an expired broadcast while another doesn't.
// =============================================================================

/**
 * Socket events for broadcast lifecycle
 * These MUST match the events in captain app's SocketIOService.kt
 */
export const BroadcastEvents = {
  // Broadcast expired (timeout) - remove from all transporters
  BROADCAST_EXPIRED: 'broadcast_expired',
  // Broadcast fully filled - no more trucks needed
  BROADCAST_FULLY_FILLED: 'booking_fully_filled',
  // Broadcast cancelled by customer
  BROADCAST_CANCELLED: 'order_cancelled',
  // Real-time truck count update
  TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update',
  // New broadcast notification
  NEW_BROADCAST: 'new_broadcast',
};

interface GetActiveBroadcastsParams {
  driverId: string;
  vehicleType?: string;
  maxDistance?: number;
}

interface AcceptBroadcastParams {
  driverId: string;
  vehicleId: string;
  estimatedArrival?: string;
  notes?: string;
}

interface DeclineBroadcastParams {
  driverId: string;
  reason: string;
  notes?: string;
}

interface GetHistoryParams {
  driverId: string;
  page: number;
  limit: number;
  status?: string;
}

interface CreateBroadcastParams {
  transporterId: string;
  customerId: string;
  pickupLocation: {
    latitude: number;
    longitude: number;
    address: string;
    city: string;
    state: string;
    pincode: string;
  };
  dropLocation: {
    latitude: number;
    longitude: number;
    address: string;
    city: string;
    state: string;
    pincode: string;
  };
  vehicleType: string;
  vehicleSubtype?: string;
  totalTrucksNeeded: number;
  goodsType: string;
  weight: string;
  farePerTruck: number;
  isUrgent?: boolean;
  expiresAt?: string;
  preferredDriverIds?: string[];
}

class BroadcastService {
  
  /**
   * Get active broadcasts for a driver/transporter
   * 
   * Returns BOTH:
   * 1. Legacy Bookings (single vehicle type)
   * 2. New Orders with multiple vehicle types (requestedVehicles array)
   * 
   * Filters to only show vehicles matching the transporter's fleet
   */
  async getActiveBroadcasts(params: GetActiveBroadcastsParams) {
    const { driverId, vehicleType } = params;
    
    // Get user to find their transporter
    const user = await db.getUserById(driverId);
    const transporterId = user?.transporterId || driverId;
    
    // Get transporter's vehicle types for filtering
    const transporterVehicles = await db.getVehiclesByTransporter(transporterId);
    const transporterVehicleTypes = new Set(
      transporterVehicles.map(v => `${v.vehicleType.toLowerCase()}_${(v.vehicleSubtype || '').toLowerCase()}`)
    );
    const transporterTypesList = [...new Set(transporterVehicles.map(v => v.vehicleType.toLowerCase()))];
    
    logger.info(`Transporter ${transporterId} has vehicle types: ${transporterTypesList.join(', ')}`);
    
    const activeBroadcasts: any[] = [];
    
    // ============== 1. Get Legacy Bookings ==============
    const bookings = await db.getActiveBookingsForTransporter(transporterId);
    
    for (const booking of bookings) {
      // Filter by vehicle type if specified
      if (vehicleType && booking.vehicleType.toLowerCase() !== vehicleType.toLowerCase()) {
        continue;
      }
      
      // Check if not expired
      if (new Date(booking.expiresAt) < new Date()) {
        continue;
      }
      
      // Check if still needs trucks
      if (booking.trucksFilled >= booking.trucksNeeded) {
        continue;
      }
      
      // Check if transporter has matching vehicle type
      if (!transporterTypesList.includes(booking.vehicleType.toLowerCase())) {
        continue;
      }
      
      activeBroadcasts.push(this.mapBookingToBroadcast(booking));
    }
    
    // ============== 2. Get New Orders (Multi-Vehicle) ==============
    const orders = db.getActiveOrders ? await db.getActiveOrders() : [];
    
    logger.info(`[Broadcasts] Found ${orders.length} active orders`);
    
    for (const order of orders) {
      logger.info(`[Broadcasts] Processing order ${order.id}, status: ${order.status}, trucks: ${order.trucksFilled}/${order.totalTrucks}`);
      // Check if not expired
      if (new Date(order.expiresAt) < new Date()) {
        continue;
      }
      
      // Check if still needs trucks
      if (order.trucksFilled >= order.totalTrucks) {
        continue;
      }
      
      // Get truck requests for this order
      const truckRequests = db.getTruckRequestsByOrder ? await db.getTruckRequestsByOrder(order.id) : [];
      
      logger.info(`[Broadcasts] Order ${order.id} has ${truckRequests.length} truck requests`);
      truckRequests.forEach(tr => {
        logger.info(`[Broadcasts]   - ${tr.vehicleType}/${tr.vehicleSubtype}, status: ${tr.status}`);
      });
      
      // Filter to only vehicle types the transporter has
      const relevantRequests = truckRequests.filter(tr => {
        const typeKey = `${tr.vehicleType.toLowerCase()}_${(tr.vehicleSubtype || '').toLowerCase()}`;
        return transporterVehicleTypes.has(typeKey) || transporterTypesList.includes(tr.vehicleType.toLowerCase());
      });
      
      if (relevantRequests.length === 0) {
        continue; // No matching vehicle types for this transporter
      }
      
      // Group by vehicle type to create requestedVehicles array
      const requestedVehiclesMap = new Map<string, any>();
      
      for (const tr of relevantRequests) {
        const key = `${tr.vehicleType}_${tr.vehicleSubtype}`;
        
        if (!requestedVehiclesMap.has(key)) {
          requestedVehiclesMap.set(key, {
            vehicleType: tr.vehicleType,
            vehicleSubtype: tr.vehicleSubtype || '',
            count: 0,
            filledCount: 0,
            farePerTruck: tr.pricePerTruck,
            capacityTons: 0 // Could be fetched from vehicle catalog
          });
        }
        
        const entry = requestedVehiclesMap.get(key)!;
        entry.count += 1;
        if (tr.status === 'assigned' || tr.status === 'completed') {
          entry.filledCount += 1;
        }
      }
      
      const requestedVehicles = Array.from(requestedVehiclesMap.values());
      
      logger.info(`[Broadcasts] Order ${order.id} grouped into ${requestedVehicles.length} vehicle types:`);
      requestedVehicles.forEach(rv => {
        logger.info(`[Broadcasts]   - ${rv.vehicleType}/${rv.vehicleSubtype}: ${rv.count} needed, ${rv.filledCount} filled`);
      });
      
      // Calculate totals from relevant requests only
      const totalNeeded = requestedVehicles.reduce((sum, rv) => sum + rv.count, 0);
      const totalFilled = requestedVehicles.reduce((sum, rv) => sum + rv.filledCount, 0);
      const totalFare = requestedVehicles.reduce((sum, rv) => sum + (rv.count * rv.farePerTruck), 0);
      const avgFarePerTruck = totalNeeded > 0 ? totalFare / totalNeeded : 0;
      
      // Build broadcast object with requestedVehicles
      activeBroadcasts.push({
        broadcastId: order.id,
        customerId: order.customerId,
        customerName: order.customerName || 'Customer',
        customerMobile: order.customerPhone || '',
        pickupLocation: {
          latitude: order.pickup.latitude,
          longitude: order.pickup.longitude,
          address: order.pickup.address,
          city: order.pickup.city,
          state: order.pickup.state
        },
        dropLocation: {
          latitude: order.drop.latitude,
          longitude: order.drop.longitude,
          address: order.drop.address,
          city: order.drop.city,
          state: order.drop.state
        },
        distance: order.distanceKm || 0,
        estimatedDuration: Math.round((order.distanceKm || 100) * 1.5),
        
        // Multi-truck support
        requestedVehicles: requestedVehicles,
        totalTrucksNeeded: totalNeeded,
        trucksFilledSoFar: totalFilled,
        
        // Legacy single type (first type for backward compat)
        vehicleType: requestedVehicles[0]?.vehicleType || '',
        vehicleSubtype: requestedVehicles[0]?.vehicleSubtype || '',
        
        goodsType: order.goodsType || 'General',
        weight: order.cargoWeightKg ? `${order.cargoWeightKg} kg` : 'N/A',
        farePerTruck: avgFarePerTruck,
        totalFare: totalFare,
        status: order.status,
        isUrgent: false,
        createdAt: order.createdAt,
        expiresAt: order.expiresAt
      });
    }
    
    logger.info(`Found ${activeBroadcasts.length} active broadcasts for transporter ${transporterId}`);
    
    return activeBroadcasts;
  }
  
  /**
   * Get broadcast by ID
   */
  async getBroadcastById(broadcastId: string) {
    const booking = await db.getBookingById(broadcastId);
    
    if (!booking) {
      throw new Error('Broadcast not found');
    }
    
    return this.mapBookingToBroadcast(booking);
  }
  
  /**
   * Accept a broadcast (assign driver/vehicle to booking)
   * 
   * FLOW:
   * 1. Validate booking is still available
   * 2. Create assignment record
   * 3. Update booking status
   * 4. Notify DRIVER via WebSocket + Push (trip assignment)
   * 5. Notify CUSTOMER via WebSocket (real-time confirmation)
   * 
   * SCALABILITY:
   * - Uses async notifications (non-blocking)
   * - Idempotent - safe to retry
   * - Transaction-safe with database
   */
  async acceptBroadcast(broadcastId: string, params: AcceptBroadcastParams) {
    const { driverId, vehicleId } = params;
    
    const booking = await db.getBookingById(broadcastId);
    
    if (!booking) {
      throw new Error('Broadcast not found');
    }
    
    if (booking.trucksFilled >= booking.trucksNeeded) {
      throw new Error('Broadcast already filled');
    }
    
    if (new Date(booking.expiresAt) < new Date()) {
      throw new Error('Broadcast has expired');
    }
    
    // Get driver and vehicle info
    const driver = await db.getUserById(driverId);
    const vehicle = await db.getVehicleById(vehicleId);
    const transporter = driver?.transporterId ? await db.getUserById(driver.transporterId) : null;
    
    // Create assignment
    const assignmentId = uuidv4();
    const tripId = uuidv4();
    const now = new Date().toISOString();
    
    const assignment: AssignmentRecord = {
      id: assignmentId,
      bookingId: broadcastId,
      tripId,
      transporterId: driver?.transporterId || driverId,
      transporterName: transporter?.name || '',
      driverId,
      driverName: driver?.name || 'Driver',
      driverPhone: driver?.phone || '',
      vehicleId,
      vehicleNumber: vehicle?.vehicleNumber || '',
      vehicleType: vehicle?.vehicleType || booking.vehicleType,
      vehicleSubtype: vehicle?.vehicleSubtype || booking.vehicleSubtype || '',
      status: 'pending', // Driver needs to accept
      assignedAt: now
    };
    
    await db.createAssignment(assignment);
    
    // Update booking - determine new status
    const newTrucksFilled = booking.trucksFilled + 1;
    let newStatus: BookingRecord['status'] = 'partially_filled';
    if (newTrucksFilled >= booking.trucksNeeded) {
      newStatus = 'fully_filled';
    }
    
    await db.updateBooking(broadcastId, {
      trucksFilled: newTrucksFilled,
      status: newStatus
    });
    
    logger.info(`✅ Broadcast ${broadcastId} accepted - Driver: ${driverId}, Vehicle: ${vehicleId}`);
    logger.info(`   📊 Progress: ${newTrucksFilled}/${booking.trucksNeeded} trucks assigned`);
    
    // ============== NOTIFY DRIVER ==============
    // Send notification to driver about the trip assignment
    const driverNotification = {
      type: 'trip_assignment',
      assignmentId,
      tripId,
      bookingId: broadcastId,
      pickup: booking.pickup,
      drop: booking.drop,
      vehicleNumber: vehicle?.vehicleNumber || '',
      farePerTruck: booking.pricePerTruck,
      distanceKm: booking.distanceKm,
      customerName: booking.customerName,
      customerPhone: booking.customerPhone,
      assignedAt: now,
      message: `New trip assigned! ${booking.pickup.address} → ${booking.drop.address}`
    };
    
    // WebSocket notification to driver
    emitToUser(driverId, 'trip_assigned', driverNotification);
    logger.info(`📢 Notified driver ${driverId} (${driver?.name}) about trip assignment`);
    
    // Push notification to driver (async, non-blocking)
    sendPushNotification(driverId, {
      title: '🚛 New Trip Assigned!',
      body: `${booking.pickup.city || booking.pickup.address} → ${booking.drop.city || booking.drop.address}`,
      data: {
        type: 'trip_assignment',
        tripId,
        assignmentId,
        bookingId: broadcastId
      }
    }).catch(err => {
      logger.warn(`FCM to driver ${driverId} failed: ${err.message}`);
    });
    
    // ============== NOTIFY CUSTOMER ==============
    // Send real-time update to customer about truck confirmation
    const customerNotification = {
      type: 'truck_confirmed',
      bookingId: broadcastId,
      assignmentId,
      truckNumber: newTrucksFilled,
      totalTrucksNeeded: booking.trucksNeeded,
      trucksConfirmed: newTrucksFilled,
      remainingTrucks: booking.trucksNeeded - newTrucksFilled,
      isFullyFilled: newTrucksFilled >= booking.trucksNeeded,
      driver: {
        name: driver?.name || 'Driver',
        phone: driver?.phone || ''
      },
      vehicle: {
        number: vehicle?.vehicleNumber || '',
        type: vehicle?.vehicleType || booking.vehicleType,
        subtype: vehicle?.vehicleSubtype || booking.vehicleSubtype
      },
      transporter: {
        name: transporter?.name || transporter?.businessName || '',
        phone: transporter?.phone || ''
      },
      message: `Truck ${newTrucksFilled}/${booking.trucksNeeded} confirmed! ${vehicle?.vehicleNumber || 'Vehicle'} assigned.`
    };
    
    // WebSocket notification to customer
    emitToUser(booking.customerId, 'truck_confirmed', customerNotification);
    logger.info(`📢 Notified customer ${booking.customerId} - ${newTrucksFilled}/${booking.trucksNeeded} trucks confirmed`);
    
    // Also emit to booking room for any listeners
    emitToRoom(`booking:${broadcastId}`, 'booking_updated', {
      bookingId: broadcastId,
      status: newStatus,
      trucksFilled: newTrucksFilled,
      trucksNeeded: booking.trucksNeeded
    });
    
    // Push notification to customer (async)
    sendPushNotification(booking.customerId, {
      title: `🚛 Truck ${newTrucksFilled}/${booking.trucksNeeded} Confirmed!`,
      body: `${vehicle?.vehicleNumber || 'Vehicle'} (${driver?.name || 'Driver'}) assigned to your booking`,
      data: {
        type: 'truck_confirmed',
        bookingId: broadcastId,
        trucksConfirmed: newTrucksFilled,
        totalTrucks: booking.trucksNeeded
      }
    }).catch(err => {
      logger.warn(`FCM to customer ${booking.customerId} failed: ${err.message}`);
    });
    
    return {
      assignmentId,
      tripId,
      status: 'assigned',
      trucksConfirmed: newTrucksFilled,
      totalTrucksNeeded: booking.trucksNeeded,
      isFullyFilled: newTrucksFilled >= booking.trucksNeeded
    };
  }
  
  /**
   * Decline a broadcast
   */
  async declineBroadcast(broadcastId: string, params: DeclineBroadcastParams) {
    const { driverId, reason, notes } = params;
    
    // Just log the decline - no need to store for now
    logger.info(`Broadcast ${broadcastId} declined by ${driverId}. Reason: ${reason}`, { notes });
    
    return { success: true };
  }
  
  /**
   * Get broadcast history for a driver
   */
  async getBroadcastHistory(params: GetHistoryParams) {
    const { driverId, page, limit, status } = params;
    
    // Get bookings for this driver
    let bookings = await db.getBookingsByDriver(driverId);
    
    // Filter by status if provided
    if (status) {
      bookings = bookings.filter((b: BookingRecord) => b.status === status);
    }
    
    const total = bookings.length;
    const pages = Math.ceil(total / limit);
    
    // Paginate
    const start = (page - 1) * limit;
    const paginatedBookings = bookings.slice(start, start + limit);
    
    return {
      broadcasts: paginatedBookings.map((b: BookingRecord) => this.mapBookingToBroadcast(b)),
      pagination: {
        page,
        limit,
        total,
        pages
      }
    };
  }
  
  /**
   * Create a new broadcast (from transporter)
   */
  async createBroadcast(params: CreateBroadcastParams) {
    const broadcastId = uuidv4();
    
    // Get customer info
    const customer = await db.getUserById(params.customerId);
    
    const booking: Omit<BookingRecord, 'createdAt' | 'updatedAt'> = {
      id: broadcastId,
      customerId: params.customerId,
      customerName: customer?.name || 'Customer',
      customerPhone: customer?.phone || '',
      pickup: {
        latitude: params.pickupLocation.latitude,
        longitude: params.pickupLocation.longitude,
        address: params.pickupLocation.address,
        city: params.pickupLocation.city,
        state: params.pickupLocation.state
      },
      drop: {
        latitude: params.dropLocation.latitude,
        longitude: params.dropLocation.longitude,
        address: params.dropLocation.address,
        city: params.dropLocation.city,
        state: params.dropLocation.state
      },
      vehicleType: params.vehicleType,
      vehicleSubtype: params.vehicleSubtype || '',
      trucksNeeded: params.totalTrucksNeeded,
      trucksFilled: 0,
      distanceKm: 0, // Would be calculated
      pricePerTruck: params.farePerTruck,
      totalAmount: params.farePerTruck * params.totalTrucksNeeded,
      goodsType: params.goodsType,
      weight: params.weight,
      status: 'active',
      notifiedTransporters: [params.transporterId],
      expiresAt: params.expiresAt || new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    };
    
    const createdBooking = await db.createBooking(booking);
    
    // TODO: Send push notifications to drivers
    const notifiedDrivers = 10; // Mock number
    
    logger.info(`Broadcast ${broadcastId} created, ${notifiedDrivers} drivers notified`);
    
    return {
      broadcast: this.mapBookingToBroadcast(createdBooking),
      notifiedDrivers
    };
  }
  
  // ===========================================================================
  // BROADCAST EXPIRY & REAL-TIME UPDATES
  // ===========================================================================
  // These methods handle the instant removal of expired broadcasts from
  // ALL transporters' screens. Critical for Rapido-style UX.
  // ===========================================================================

  /**
   * Check and expire old broadcasts
   * Called periodically (every 5 seconds) by the expiry job
   * 
   * SCALABILITY: O(n) where n = active broadcasts. For millions of users,
   * use Redis sorted set with expiry times for O(log n) performance.
   */
  async checkAndExpireBroadcasts(): Promise<number> {
    const now = new Date();
    let expiredCount = 0;
    
    // Get all active bookings
    const allBookings = db.getAllBookings ? await db.getAllBookings() : [];
    
    for (const booking of allBookings) {
      // Check if expired and still active
      if (
        booking.status === 'active' || 
        booking.status === 'partially_filled'
      ) {
        const expiresAt = new Date(booking.expiresAt);
        if (expiresAt < now) {
          // Mark as expired in database
          await db.updateBooking(booking.id, { status: 'expired' });
          
          // CRITICAL: Notify ALL transporters to remove this broadcast
          this.emitBroadcastExpired(booking.id, 'timeout');
          
          // Notify customer that their request expired
          this.notifyCustomerBroadcastExpired(booking);
          
          expiredCount++;
          logger.info(`⏰ Broadcast ${booking.id} expired - notified all transporters`);
        }
      }
    }
    
    // Also check orders (multi-vehicle system)
    let allOrders: any[] = [];
    try {
      if (db.getActiveOrders) {
        const result = await db.getActiveOrders();
        allOrders = Array.isArray(result) ? result : [];
      }
    } catch (error) {
      logger.debug('Could not get active orders for expiry check');
    }
    
    for (const order of allOrders) {
      if (order.status === 'searching' || order.status === 'partially_filled') {
        const expiresAt = new Date(order.expiresAt);
        if (expiresAt < now) {
          // Mark as expired
          if (db.updateOrder) {
            await db.updateOrder(order.id, { status: 'expired' });
          }
          
          // Notify ALL transporters
          this.emitBroadcastExpired(order.id, 'timeout');
          
          expiredCount++;
          logger.info(`⏰ Order ${order.id} expired - notified all transporters`);
        }
      }
    }
    
    if (expiredCount > 0) {
      logger.info(`🧹 Expired ${expiredCount} broadcast(s)`);
    }
    
    return expiredCount;
  }
  
  /**
   * Emit broadcast expired event to ALL transporters
   * This instantly removes the broadcast from their overlay/list
   * 
   * @param broadcastId - The broadcast/order ID that expired
   * @param reason - Why it expired ('timeout', 'cancelled', 'fully_filled')
   */
  emitBroadcastExpired(broadcastId: string, reason: string = 'timeout'): void {
    const payload = {
      broadcastId,
      orderId: broadcastId, // Alias for compatibility
      reason,
      timestamp: new Date().toISOString(),
      message: reason === 'timeout' 
        ? 'This booking request has expired' 
        : reason === 'cancelled'
        ? 'Customer cancelled this booking'
        : 'All trucks have been assigned'
    };
    
    logger.info(`📢 Broadcasting expiry event: ${broadcastId} (${reason})`);
    
    // Emit to ALL connected transporters
    emitToAllTransporters(BroadcastEvents.BROADCAST_EXPIRED, payload);
    
    // Also emit to the specific booking room (for any listeners)
    emitToRoom(`booking:${broadcastId}`, BroadcastEvents.BROADCAST_EXPIRED, payload);
    emitToRoom(`order:${broadcastId}`, BroadcastEvents.BROADCAST_EXPIRED, payload);
  }
  
  /**
   * Emit trucks remaining update to ALL transporters
   * Called when a transporter accepts trucks - others see reduced availability
   * 
   * @param broadcastId - The broadcast/order ID
   * @param vehicleType - Which vehicle type was accepted
   * @param vehicleSubtype - Which subtype
   * @param remaining - How many trucks still needed
   * @param total - Total trucks needed
   */
  emitTrucksRemainingUpdate(
    broadcastId: string,
    vehicleType: string,
    vehicleSubtype: string,
    remaining: number,
    total: number
  ): void {
    const payload = {
      broadcastId,
      orderId: broadcastId,
      vehicleType,
      vehicleSubtype,
      trucksRemaining: remaining,
      trucksNeeded: total,
      trucksFilled: total - remaining,
      isFullyFilled: remaining === 0,
      timestamp: new Date().toISOString()
    };
    
    logger.info(`📢 Trucks remaining update: ${broadcastId} - ${remaining}/${total} (${vehicleType})`);
    
    // Emit to ALL transporters so they see updated availability
    emitToAllTransporters(BroadcastEvents.TRUCKS_REMAINING_UPDATE, payload);
    
    // Also emit to booking/order room
    emitToRoom(`booking:${broadcastId}`, BroadcastEvents.TRUCKS_REMAINING_UPDATE, payload);
    emitToRoom(`order:${broadcastId}`, BroadcastEvents.TRUCKS_REMAINING_UPDATE, payload);
    
    // If fully filled, emit that event too
    if (remaining === 0) {
      this.emitBroadcastExpired(broadcastId, 'fully_filled');
    }
  }
  
  /**
   * Notify customer that their broadcast expired without being filled
   */
  private notifyCustomerBroadcastExpired(booking: BookingRecord): void {
    const payload = {
      type: 'booking_expired',
      bookingId: booking.id,
      trucksNeeded: booking.trucksNeeded,
      trucksFilled: booking.trucksFilled,
      message: booking.trucksFilled > 0
        ? `Your booking expired with ${booking.trucksFilled}/${booking.trucksNeeded} trucks assigned`
        : 'Your booking expired. No transporters accepted in time.'
    };
    
    // WebSocket to customer
    emitToUser(booking.customerId, 'booking_expired', payload);
    
    // Push notification
    sendPushNotification(booking.customerId, {
      title: '⏰ Booking Expired',
      body: payload.message,
      data: {
        type: 'booking_expired',
        bookingId: booking.id
      }
    }).catch(err => {
      logger.warn(`FCM to customer ${booking.customerId} failed: ${err.message}`);
    });
  }
  
  /**
   * Start the broadcast expiry checker job
   * Runs every 5 seconds to check for expired broadcasts
   * 
   * IMPORTANT: Call this from server.ts after initializing the service
   */
  startExpiryChecker(): void {
    // Check every 5 seconds
    setInterval(async () => {
      try {
        await this.checkAndExpireBroadcasts();
      } catch (error: any) {
        logger.error(`Expiry checker error: ${error.message}`);
      }
    }, 5000);
    
    logger.info('✅ Broadcast expiry checker started (5 second interval)');
  }

  /**
   * Map internal booking to broadcast format for API response
   * Enhanced with capacity/tonnage information and requestedVehicles array
   */
  private mapBookingToBroadcast(booking: BookingRecord) {
    // Import vehicle catalog to get capacity info
    const { getSubtypeConfig } = require('../pricing/vehicle-catalog');
    
    // Get capacity information for the vehicle subtype
    const subtypeConfig = getSubtypeConfig(booking.vehicleType, booking.vehicleSubtype);
    const capacityTons = subtypeConfig ? subtypeConfig.capacityKg / 1000 : 0;
    
    // Build requestedVehicles array for multi-truck UI compatibility
    const requestedVehicles = [{
      vehicleType: booking.vehicleType,
      vehicleSubtype: booking.vehicleSubtype || '',
      count: booking.trucksNeeded,
      filledCount: booking.trucksFilled || 0,
      farePerTruck: booking.pricePerTruck,
      capacityTons: capacityTons
    }];
    
    return {
      broadcastId: booking.id,
      customerId: booking.customerId,
      customerName: booking.customerName || 'Customer',
      customerMobile: booking.customerPhone || '',
      pickupLocation: booking.pickup,
      dropLocation: booking.drop,
      distance: booking.distanceKm || 0,
      estimatedDuration: Math.round((booking.distanceKm || 100) * 1.5), // Rough estimate: 1.5 min per km
      
      // Multi-truck support (NEW)
      requestedVehicles: requestedVehicles,
      
      totalTrucksNeeded: booking.trucksNeeded,
      trucksFilledSoFar: booking.trucksFilled || 0,
      vehicleType: booking.vehicleType,
      vehicleSubtype: booking.vehicleSubtype,
      goodsType: booking.goodsType || 'General',
      weight: booking.weight || 'N/A',
      farePerTruck: booking.pricePerTruck,
      totalFare: booking.totalAmount,
      status: booking.status,
      isUrgent: false,
      createdAt: booking.createdAt,
      expiresAt: booking.expiresAt,
      
      // Enhanced: Capacity information for transporters
      capacityInfo: subtypeConfig ? {
        capacityKg: subtypeConfig.capacityKg,
        capacityTons: capacityTons,
        minTonnage: subtypeConfig.minTonnage,
        maxTonnage: subtypeConfig.maxTonnage
      } : null
    };
  }
}

export const broadcastService = new BroadcastService();
