/**
 * =============================================================================
 * ORDER SERVICE - Multi-Truck Request System
 * =============================================================================
 * 
 * OPTIMIZED ALGORITHM:
 * 
 * 1. Customer selects: 2x Open 17ft + 3x Container 4ton
 * 2. System creates 1 Order (parent) + 5 TruckRequests (children)
 * 3. Requests are grouped by vehicle type for efficient broadcasting
 * 4. Each group is broadcast to matching transporters in parallel
 * 5. Transporters only see requests matching their truck types
 * 
 * PERFORMANCE OPTIMIZATIONS:
 * - Batch DB operations
 * - Parallel WebSocket emissions
 * - Grouped broadcasts (less network calls)
 * - Efficient transporter matching using Set lookups
 * 
 * SCALABILITY: Designed for millions of concurrent users
 * =============================================================================
 */

import { v4 as uuid } from 'uuid';
import { db, OrderRecord, TruckRequestRecord } from '../../shared/database/db';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, emitToBooking, SocketEvent } from '../../shared/services/socket.service';
import { CreateOrderInput, TruckSelection } from './booking.schema';

// =============================================================================
// CONFIGURATION
// =============================================================================

const ORDER_CONFIG = {
  // Timeout in milliseconds (1 minute for quick response)
  TIMEOUT_MS: 1 * 60 * 1000,  // 60 seconds
  
  // How often to check for expired orders
  EXPIRY_CHECK_INTERVAL_MS: 30 * 1000,  // Every 30 seconds
  
  // Countdown notification interval
  COUNTDOWN_INTERVAL_MS: 60 * 1000,  // Every 1 minute
};

// Store active timers for cleanup
const orderTimers = new Map<string, NodeJS.Timeout>();
const countdownTimers = new Map<string, NodeJS.Timeout>();

// =============================================================================
// TYPES
// =============================================================================

interface GroupedRequests {
  vehicleType: string;
  vehicleSubtype: string;
  requests: TruckRequestRecord[];
  transporterIds: string[];
}

interface CreateOrderResult {
  order: OrderRecord;
  truckRequests: TruckRequestRecord[];
  broadcastSummary: {
    totalRequests: number;
    groupedBy: { vehicleType: string; vehicleSubtype: string; count: number; transportersNotified: number }[];
    totalTransportersNotified: number;
  };
  timeoutSeconds: number;
}

// =============================================================================
// ORDER SERVICE
// =============================================================================

class OrderService {
  
  /**
   * ==========================================================================
   * CREATE ORDER - Main Entry Point
   * ==========================================================================
   * 
   * ALGORITHM:
   * 1. Validate input
   * 2. Create parent Order record
   * 3. Expand truck selections into individual TruckRequest records
   * 4. Group requests by vehicle type/subtype
   * 5. Find matching transporters for each group (parallel)
   * 6. Broadcast to transporters (grouped for efficiency)
   * 7. Start timeout timer
   */
  async createOrder(
    customerId: string,
    customerPhone: string,
    data: CreateOrderInput
  ): Promise<CreateOrderResult> {
    
    const startTime = Date.now();
    
    // Get customer info
    const customer = await db.getUserById(customerId);
    const customerName = customer?.name || 'Customer';
    
    // Calculate totals
    const totalTrucks = data.trucks.reduce((sum, t) => sum + t.quantity, 0);
    const totalAmount = data.trucks.reduce((sum, t) => sum + (t.quantity * t.pricePerTruck), 0);
    const expiresAt = new Date(Date.now() + ORDER_CONFIG.TIMEOUT_MS).toISOString();
    
    // Generate IDs
    const orderId = uuid();
    
    logger.info(`╔══════════════════════════════════════════════════════════════╗`);
    logger.info(`║  🚛 NEW ORDER REQUEST                                        ║`);
    logger.info(`╠══════════════════════════════════════════════════════════════╣`);
    logger.info(`║  Order ID: ${orderId}`);
    logger.info(`║  Customer: ${customerName} (${customerPhone})`);
    logger.info(`║  Total Trucks: ${totalTrucks}`);
    logger.info(`║  Total Amount: ₹${totalAmount}`);
    logger.info(`║  Truck Types: ${data.trucks.map(t => `${t.quantity}x ${t.vehicleType} ${t.vehicleSubtype}`).join(', ')}`);
    logger.info(`╚══════════════════════════════════════════════════════════════╝`);

    // ==========================================================================
    // STEP 1: Create parent Order record
    // ==========================================================================
    const order = await db.createOrder({
      id: orderId,
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
      distanceKm: data.distanceKm,
      totalTrucks,
      trucksFilled: 0,
      totalAmount,
      goodsType: data.goodsType,
      weight: data.weight,
      cargoWeightKg: data.cargoWeightKg,
      status: 'active',
      scheduledAt: data.scheduledAt,
      expiresAt
    });

    // ==========================================================================
    // STEP 2: Expand truck selections into individual TruckRequests
    // ==========================================================================
    const truckRequests = this.expandTruckSelections(orderId, data.trucks);
    
    // Batch create all truck requests
    const createdRequests = await db.createTruckRequestsBatch(truckRequests);
    
    // ==========================================================================
    // STEP 3: Group requests by vehicle type for efficient broadcasting
    // ==========================================================================
    const groupedRequests = this.groupRequestsByVehicleType(createdRequests);
    
    // ==========================================================================
    // STEP 4: Find matching transporters and broadcast (parallel)
    // ==========================================================================
    const broadcastSummary = await this.broadcastToTransporters(
      order,
      groupedRequests,
      data.distanceKm
    );

    // ==========================================================================
    // STEP 5: Handle case when no transporters found
    // ==========================================================================
    if (broadcastSummary.totalTransportersNotified === 0) {
      logger.warn(`⚠️ NO TRANSPORTERS FOUND for any truck type in order ${orderId}`);
      
      // Update order status
      await db.updateOrder(orderId, { status: 'expired' });
      
      // Update all requests to expired
      await db.updateTruckRequestsBatch(
        createdRequests.map(r => r.id),
        { status: 'expired' }
      );
      
      // Notify customer
      emitToUser(customerId, SocketEvent.NO_VEHICLES_AVAILABLE, {
        orderId,
        message: 'No vehicles available for your request. Please try again later or select different vehicle types.',
        suggestion: 'search_again'
      });
      
      return {
        order: { ...order, status: 'expired' },
        truckRequests: createdRequests.map(r => ({ ...r, status: 'expired' as const })),
        broadcastSummary,
        timeoutSeconds: 0
      };
    }

    // ==========================================================================
    // STEP 6: Start timeout timer
    // ==========================================================================
    this.startOrderTimeout(orderId, customerId);
    this.startCountdownNotifications(orderId, customerId);

    const processingTime = Date.now() - startTime;
    logger.info(`✅ Order ${orderId} created in ${processingTime}ms`);
    logger.info(`   - ${totalTrucks} truck requests created`);
    logger.info(`   - ${broadcastSummary.totalTransportersNotified} transporters notified`);

    return {
      order,
      truckRequests: createdRequests,
      broadcastSummary,
      timeoutSeconds: ORDER_CONFIG.TIMEOUT_MS / 1000
    };
  }

  /**
   * Expand truck selections into individual TruckRequest records
   * 
   * Input:  [{ vehicleType: "open", subtype: "17ft", quantity: 2 }]
   * Output: [TruckRequest#1, TruckRequest#2] (2 separate requests)
   */
  private expandTruckSelections(
    orderId: string, 
    selections: TruckSelection[]
  ): Omit<TruckRequestRecord, 'createdAt' | 'updatedAt'>[] {
    const requests: Omit<TruckRequestRecord, 'createdAt' | 'updatedAt'>[] = [];
    let requestNumber = 1;
    
    for (const selection of selections) {
      for (let i = 0; i < selection.quantity; i++) {
        requests.push({
          id: uuid(),
          orderId,
          requestNumber: requestNumber++,
          vehicleType: selection.vehicleType,
          vehicleSubtype: selection.vehicleSubtype,
          pricePerTruck: selection.pricePerTruck,
          status: 'searching',
          notifiedTransporters: []
        });
      }
    }
    
    return requests;
  }

  /**
   * Group requests by vehicle type/subtype for efficient broadcasting
   * 
   * This reduces the number of transporter lookups and WebSocket emissions
   */
  private groupRequestsByVehicleType(requests: TruckRequestRecord[]): GroupedRequests[] {
    const groups = new Map<string, GroupedRequests>();
    
    for (const request of requests) {
      const key = `${request.vehicleType}_${request.vehicleSubtype}`;
      
      if (!groups.has(key)) {
        groups.set(key, {
          vehicleType: request.vehicleType,
          vehicleSubtype: request.vehicleSubtype,
          requests: [],
          transporterIds: []
        });
      }
      
      groups.get(key)!.requests.push(request);
    }
    
    return Array.from(groups.values());
  }

  /**
   * Broadcast to transporters - the core matching algorithm
   * 
   * OPTIMIZED:
   * - Finds transporters for each vehicle type group in parallel
   * - Sends grouped notifications (less WebSocket calls)
   * - Updates notifiedTransporters in batch
   */
  private async broadcastToTransporters(
    order: OrderRecord,
    groupedRequests: GroupedRequests[],
    distanceKm: number
  ): Promise<CreateOrderResult['broadcastSummary']> {
    
    const allTransporterIds = new Set<string>();
    const groupSummaries: CreateOrderResult['broadcastSummary']['groupedBy'] = [];
    
    // Process each vehicle type group
    for (const group of groupedRequests) {
      // Find transporters with this vehicle type
      const transporterIds = await db.getTransportersWithVehicleType(
        group.vehicleType,
        group.vehicleSubtype
      );
      
      group.transporterIds = transporterIds;
      
      // Update notifiedTransporters for each request in this group
      const requestIds = group.requests.map(r => r.id);
      await db.updateTruckRequestsBatch(requestIds, { notifiedTransporters: transporterIds });
      
      // Track unique transporters
      transporterIds.forEach(id => allTransporterIds.add(id));
      
      // Add to summary
      groupSummaries.push({
        vehicleType: group.vehicleType,
        vehicleSubtype: group.vehicleSubtype,
        count: group.requests.length,
        transportersNotified: transporterIds.length
      });
      
      // Broadcast to each transporter in this group
      if (transporterIds.length > 0) {
        const broadcastPayload = {
          orderId: order.id,
          customerName: order.customerName,
          
          // Vehicle info for this group
          vehicleType: group.vehicleType,
          vehicleSubtype: group.vehicleSubtype,
          trucksNeeded: group.requests.length,
          
          // Individual request IDs (transporters can accept specific ones)
          requestIds: group.requests.map(r => r.id),
          
          // Pricing
          pricePerTruck: group.requests[0].pricePerTruck,
          totalFare: group.requests.reduce((sum, r) => sum + r.pricePerTruck, 0),
          
          // Location info
          pickupAddress: order.pickup.address,
          pickupCity: order.pickup.city,
          dropAddress: order.drop.address,
          dropCity: order.drop.city,
          distanceKm,
          
          // Goods info
          goodsType: order.goodsType,
          weight: order.weight,
          
          // Timing
          createdAt: order.createdAt,
          expiresAt: order.expiresAt,
          timeoutSeconds: ORDER_CONFIG.TIMEOUT_MS / 1000,
          
          isUrgent: false
        };
        
        // Emit to all transporters in this group
        for (const transporterId of transporterIds) {
          const transporter = await db.getUserById(transporterId);
          emitToUser(transporterId, SocketEvent.NEW_BROADCAST, broadcastPayload);
          logger.info(`📢 Notified: ${transporter?.name || transporterId} for ${group.vehicleType} ${group.vehicleSubtype} (${group.requests.length} trucks)`);
        }
      } else {
        logger.warn(`⚠️ No transporters found for ${group.vehicleType} ${group.vehicleSubtype}`);
      }
    }
    
    return {
      totalRequests: groupedRequests.reduce((sum, g) => sum + g.requests.length, 0),
      groupedBy: groupSummaries,
      totalTransportersNotified: allTransporterIds.size
    };
  }

  /**
   * Start timeout timer for order
   */
  private startOrderTimeout(orderId: string, customerId: string): void {
    if (orderTimers.has(orderId)) {
      clearTimeout(orderTimers.get(orderId)!);
    }

    const timer = setTimeout(async () => {
      await this.handleOrderTimeout(orderId, customerId);
    }, ORDER_CONFIG.TIMEOUT_MS);

    orderTimers.set(orderId, timer);
    logger.info(`⏱️ Timeout timer started for order ${orderId} (${ORDER_CONFIG.TIMEOUT_MS / 1000}s)`);
  }

  /**
   * Handle order timeout
   */
  private async handleOrderTimeout(orderId: string, customerId: string): Promise<void> {
    const order = await db.getOrderById(orderId);
    
    if (!order) {
      logger.warn(`Order ${orderId} not found for timeout handling`);
      return;
    }

    // Skip if already completed or cancelled
    if (['fully_filled', 'completed', 'cancelled'].includes(order.status)) {
      logger.info(`Order ${orderId} already ${order.status}, skipping timeout`);
      this.clearOrderTimers(orderId);
      return;
    }

    logger.info(`⏰ TIMEOUT: Order ${orderId} expired`);

    // Get unfilled requests
    const requests = await db.getTruckRequestsByOrder(orderId);
    const unfilledRequests = requests.filter(r => r.status === 'searching');
    const filledCount = requests.filter(r => ['assigned', 'accepted', 'in_progress', 'completed'].includes(r.status)).length;

    // Update unfilled requests to expired
    await db.updateTruckRequestsBatch(
      unfilledRequests.map(r => r.id),
      { status: 'expired' }
    );

    if (filledCount > 0 && filledCount < order.totalTrucks) {
      // Partially filled
      await db.updateOrder(orderId, { status: 'expired' });
      
      emitToUser(customerId, SocketEvent.BOOKING_EXPIRED, {
        orderId,
        status: 'partially_filled_expired',
        totalTrucks: order.totalTrucks,
        trucksFilled: filledCount,
        message: `Only ${filledCount} of ${order.totalTrucks} trucks were assigned. Would you like to continue with partial fulfillment?`,
        options: ['continue_partial', 'search_again', 'cancel']
      });
    } else if (filledCount === 0) {
      // No trucks filled
      await db.updateOrder(orderId, { status: 'expired' });
      
      emitToUser(customerId, SocketEvent.NO_VEHICLES_AVAILABLE, {
        orderId,
        message: 'No vehicles available right now. Please try again later.',
        suggestion: 'search_again'
      });
    }

    // Clear timers
    this.clearOrderTimers(orderId);

    // Notify transporters that order is no longer available
    const allNotifiedTransporters = new Set<string>();
    requests.forEach(r => r.notifiedTransporters.forEach(t => allNotifiedTransporters.add(t)));
    
    for (const transporterId of allNotifiedTransporters) {
      emitToUser(transporterId, SocketEvent.BOOKING_EXPIRED, {
        orderId,
        message: 'This order has expired'
      });
    }
  }

  /**
   * Start countdown notifications
   */
  private startCountdownNotifications(orderId: string, customerId: string): void {
    let remainingMs = ORDER_CONFIG.TIMEOUT_MS;

    const countdownInterval = setInterval(async () => {
      remainingMs -= ORDER_CONFIG.COUNTDOWN_INTERVAL_MS;
      
      if (remainingMs <= 0) {
        clearInterval(countdownInterval);
        return;
      }

      const order = await db.getOrderById(orderId);
      if (!order || ['fully_filled', 'completed', 'cancelled', 'expired'].includes(order.status)) {
        clearInterval(countdownInterval);
        return;
      }

      emitToUser(customerId, SocketEvent.BROADCAST_COUNTDOWN, {
        orderId,
        remainingSeconds: Math.floor(remainingMs / 1000),
        totalTrucks: order.totalTrucks,
        trucksFilled: order.trucksFilled,
        status: order.status
      });

    }, ORDER_CONFIG.COUNTDOWN_INTERVAL_MS);

    countdownTimers.set(orderId, countdownInterval as unknown as NodeJS.Timeout);
  }

  /**
   * Clear all timers for an order
   */
  private clearOrderTimers(orderId: string): void {
    if (orderTimers.has(orderId)) {
      clearTimeout(orderTimers.get(orderId)!);
      orderTimers.delete(orderId);
    }
    if (countdownTimers.has(orderId)) {
      clearInterval(countdownTimers.get(orderId)!);
      countdownTimers.delete(orderId);
    }
  }

  /**
   * Cancel order timeout (called when fully filled)
   */
  cancelOrderTimeout(orderId: string): void {
    this.clearOrderTimers(orderId);
    logger.info(`⏱️ Timeout cancelled for order ${orderId}`);
  }

  // ==========================================================================
  // ACCEPT TRUCK REQUEST - Transporter accepts a specific truck
  // ==========================================================================

  /**
   * Accept a truck request (transporter assigns their truck)
   * 
   * LIGHTNING FAST FLOW:
   * 1. Validate request is still available (atomic check)
   * 2. Update request status immediately
   * 3. Send confirmation to accepting transporter
   * 4. Update remaining count for all other transporters
   * 5. Notify customer with progress update
   * 
   * HANDLES: 10 same truck type → 10 transporters get notified → Each can accept 1
   */
  async acceptTruckRequest(
    requestId: string,
    transporterId: string,
    vehicleId: string,
    driverId?: string
  ): Promise<TruckRequestRecord> {
    
    const startTime = Date.now();
    
    // STEP 1: Validate request exists and is available
    const request = await db.getTruckRequestById(requestId);
    if (!request) {
      throw new AppError(404, 'REQUEST_NOT_FOUND', 'Truck request not found');
    }

    if (request.status !== 'searching') {
      // Request already taken - send immediate feedback
      throw new AppError(400, 'REQUEST_ALREADY_TAKEN', 
        'This truck request was just taken by another transporter. Check for remaining trucks.');
    }

    // Verify transporter has this vehicle type
    const vehicle = await db.getVehicleById(vehicleId);
    if (!vehicle) {
      throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found');
    }
    if (vehicle.transporterId !== transporterId) {
      throw new AppError(403, 'FORBIDDEN', 'This vehicle does not belong to you');
    }
    if (vehicle.vehicleType !== request.vehicleType || vehicle.vehicleSubtype !== request.vehicleSubtype) {
      throw new AppError(400, 'VEHICLE_TYPE_MISMATCH', 
        `Your vehicle (${vehicle.vehicleType} ${vehicle.vehicleSubtype}) doesn't match the request (${request.vehicleType} ${request.vehicleSubtype})`);
    }

    // Get transporter and driver info
    const transporter = await db.getUserById(transporterId);
    const driver = driverId ? await db.getUserById(driverId) : null;
    
    // STEP 2: Update the truck request IMMEDIATELY (atomic operation)
    const tripId = uuid();
    const updatedRequest = await db.updateTruckRequest(requestId, {
      status: 'assigned',
      assignedTransporterId: transporterId,
      assignedTransporterName: transporter?.businessName || transporter?.name || 'Unknown',
      assignedVehicleId: vehicleId,
      assignedVehicleNumber: vehicle.vehicleNumber,
      assignedDriverId: driverId,
      assignedDriverName: driver?.name,
      assignedDriverPhone: driver?.phone,
      tripId,
      assignedAt: new Date().toISOString()
    });

    // Get the parent order
    const order = await db.getOrderById(request.orderId);
    if (!order) {
      logger.error(`Order ${request.orderId} not found for request ${requestId}`);
      return updatedRequest!;
    }

    // STEP 3: Update order stats
    const newFilled = order.trucksFilled + 1;
    const trucksRemaining = order.totalTrucks - newFilled;
    const newStatus = newFilled >= order.totalTrucks ? 'fully_filled' : 'partially_filled';
    
    await db.updateOrder(request.orderId, {
      trucksFilled: newFilled,
      status: newStatus
    });

    // Get remaining searching requests for this vehicle type
    const allRequests = await db.getTruckRequestsByOrder(request.orderId);
    const remainingRequests = allRequests.filter(r => 
      r.status === 'searching' && 
      r.vehicleType === request.vehicleType && 
      r.vehicleSubtype === request.vehicleSubtype
    );

    logger.info(`╔══════════════════════════════════════════════════════════════╗`);
    logger.info(`║  ✅ TRUCK ACCEPTED                                           ║`);
    logger.info(`╠══════════════════════════════════════════════════════════════╣`);
    logger.info(`║  Request: ${requestId}`);
    logger.info(`║  Transporter: ${transporter?.name || transporterId}`);
    logger.info(`║  Vehicle: ${vehicle.vehicleNumber} (${vehicle.vehicleType} ${vehicle.vehicleSubtype})`);
    logger.info(`║  Progress: ${newFilled}/${order.totalTrucks} trucks filled`);
    logger.info(`║  Remaining (same type): ${remainingRequests.length}`);
    logger.info(`║  Processing time: ${Date.now() - startTime}ms`);
    logger.info(`╚══════════════════════════════════════════════════════════════╝`);

    // STEP 4: Send INSTANT confirmation to accepting transporter
    emitToUser(transporterId, SocketEvent.ACCEPT_CONFIRMATION, {
      success: true,
      requestId,
      orderId: order.id,
      vehicleNumber: vehicle.vehicleNumber,
      tripId,
      message: `✅ You got it! Truck ${request.requestNumber} assigned to you.`,
      
      // Show if more trucks available of same type
      moreTrucksAvailable: remainingRequests.length > 0,
      remainingOfSameType: remainingRequests.length,
      remainingRequestIds: remainingRequests.map(r => r.id)
    });

    // STEP 5: Update ALL other transporters with remaining count
    const notifiedTransporters = new Set<string>();
    allRequests.forEach(r => r.notifiedTransporters.forEach(t => notifiedTransporters.add(t)));
    
    for (const otherTransporterId of notifiedTransporters) {
      if (otherTransporterId !== transporterId) {
        // Tell them this specific request is gone
        emitToUser(otherTransporterId, SocketEvent.REQUEST_NO_LONGER_AVAILABLE, {
          orderId: order.id,
          requestId,
          takenBy: transporter?.businessName || 'Another transporter',
          message: 'This truck was just taken'
        });

        // Update remaining truck count for this order
        emitToUser(otherTransporterId, SocketEvent.TRUCKS_REMAINING_UPDATE, {
          orderId: order.id,
          vehicleType: request.vehicleType,
          vehicleSubtype: request.vehicleSubtype,
          
          // Overall order progress
          totalTrucks: order.totalTrucks,
          trucksFilled: newFilled,
          trucksRemaining,
          
          // Remaining of same type (what they can still accept)
          remainingOfSameType: remainingRequests.length,
          remainingRequestIds: remainingRequests.map(r => r.id),
          
          // Status
          orderStatus: newStatus,
          message: remainingRequests.length > 0 
            ? `${remainingRequests.length} ${request.vehicleType} ${request.vehicleSubtype} trucks still available!`
            : `All ${request.vehicleType} ${request.vehicleSubtype} trucks have been taken.`
        });
      }
    }

    // STEP 6: Notify customer with REAL-TIME progress
    emitToUser(order.customerId, SocketEvent.TRUCK_ASSIGNED, {
      orderId: order.id,
      requestId,
      requestNumber: request.requestNumber,
      vehicleType: request.vehicleType,
      vehicleSubtype: request.vehicleSubtype,
      vehicleNumber: vehicle.vehicleNumber,
      transporterName: transporter?.businessName || transporter?.name,
      transporterPhone: transporter?.phone,
      driverName: driver?.name,
      driverPhone: driver?.phone,
      tripId,
      
      // Progress info
      trucksFilled: newFilled,
      totalTrucks: order.totalTrucks,
      trucksRemaining,
      progressPercent: Math.round((newFilled / order.totalTrucks) * 100),
      
      message: `🚛 Truck ${newFilled}/${order.totalTrucks} assigned!`
    });

    // STEP 7: Handle completion or partial fill
    if (newStatus === 'fully_filled') {
      // All trucks filled - Cancel timeout and celebrate!
      this.cancelOrderTimeout(order.id);
      
      emitToUser(order.customerId, SocketEvent.BOOKING_FULLY_FILLED, {
        orderId: order.id,
        totalTrucks: order.totalTrucks,
        totalAmount: order.totalAmount,
        message: '🎉 All trucks have been assigned! Your order is complete.',
        assignedTrucks: allRequests
          .filter(r => r.status === 'assigned')
          .map(r => ({
            requestNumber: r.requestNumber,
            vehicleType: r.vehicleType,
            vehicleSubtype: r.vehicleSubtype,
            vehicleNumber: r.assignedVehicleNumber,
            transporterName: r.assignedTransporterName,
            driverName: r.assignedDriverName,
            driverPhone: r.assignedDriverPhone
          }))
      });

      // Notify all transporters that order is complete
      for (const tid of notifiedTransporters) {
        if (tid !== transporterId) {
          emitToUser(tid, SocketEvent.ORDER_STATUS_UPDATE, {
            orderId: order.id,
            status: 'fully_filled',
            message: 'This order has been fully filled'
          });
        }
      }
      
      logger.info(`🎉 ORDER ${order.id} FULLY FILLED!`);
    }

    return updatedRequest!;
  }

  // ==========================================================================
  // GET OPERATIONS
  // ==========================================================================

  /**
   * Get order by ID with all truck requests
   */
  async getOrderWithRequests(orderId: string, userId: string, userRole: string) {
    const order = await db.getOrderById(orderId);
    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
    }

    // Access control
    if (userRole === 'customer' && order.customerId !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied');
    }

    const requests = await db.getTruckRequestsByOrder(orderId);

    return {
      order,
      requests,
      summary: {
        totalTrucks: order.totalTrucks,
        trucksFilled: order.trucksFilled,
        trucksSearching: requests.filter(r => r.status === 'searching').length,
        trucksExpired: requests.filter(r => r.status === 'expired').length
      }
    };
  }

  /**
   * Get active truck requests for transporter (only matching their vehicle types)
   */
  async getActiveTruckRequestsForTransporter(transporterId: string) {
    const requests = await db.getActiveTruckRequestsForTransporter(transporterId);
    
    // Group by order for better UI
    const orderMap = new Map<string, { order: OrderRecord | undefined; requests: TruckRequestRecord[] }>();
    
    for (const request of requests) {
      if (!orderMap.has(request.orderId)) {
        orderMap.set(request.orderId, {
          order: await db.getOrderById(request.orderId),
          requests: []
        });
      }
      orderMap.get(request.orderId)!.requests.push(request);
    }

    return Array.from(orderMap.values()).filter(item => item.order);
  }

  /**
   * Get customer's orders
   */
  async getCustomerOrders(customerId: string, page: number = 1, limit: number = 20) {
    const orders = await db.getOrdersByCustomer(customerId);
    
    // Sort by newest first
    orders.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    
    const total = orders.length;
    const start = (page - 1) * limit;
    const paginatedOrders = orders.slice(start, start + limit);
    
    // Include truck requests summary for each order
    const ordersWithSummary = await Promise.all(paginatedOrders.map(async (order) => {
      const requests = await db.getTruckRequestsByOrder(order.id);
      return {
        ...order,
        requestsSummary: {
          total: requests.length,
          searching: requests.filter(r => r.status === 'searching').length,
          assigned: requests.filter(r => r.status === 'assigned').length,
          completed: requests.filter(r => r.status === 'completed').length,
          expired: requests.filter(r => r.status === 'expired').length
        }
      };
    }));

    return {
      orders: ordersWithSummary,
      total,
      hasMore: start + paginatedOrders.length < total
    };
  }
}

export const orderService = new OrderService();
