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
import { Prisma } from '@prisma/client';
import { db, OrderRecord, TruckRequestRecord } from '../../shared/database/db';
import { prismaClient } from '../../shared/database/prisma.service';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, emitToBooking, SocketEvent } from '../../shared/services/socket.service';
import { queueService } from '../../shared/services/queue.service';
import { redisService } from '../../shared/services/redis.service';
import { CreateOrderInput, TruckSelection } from './booking.schema';
import { transporterOnlineService } from '../../shared/services/transporter-online.service';

// =============================================================================
// CONFIGURATION
// =============================================================================

const BROADCAST_TIMEOUT_SECONDS = parseInt(process.env.BROADCAST_TIMEOUT_SECONDS || '120', 10);

const ORDER_CONFIG = {
  // Timeout: env-configurable, default 120s. Unified with booking path.
  TIMEOUT_MS: BROADCAST_TIMEOUT_SECONDS * 1000,

  // How often to check for expired orders (Redis-based)
  EXPIRY_CHECK_INTERVAL_MS: 5 * 1000,  // Every 5 seconds
};

// =============================================================================
// REDIS KEY PATTERNS (for distributed timers)
// =============================================================================
// 
// SCALABILITY: Redis keys are shared across all ECS instances
// EASY UNDERSTANDING: Clear naming convention — timer:booking-order:{orderId}
// MODULARITY: Separate prefix from booking.service.ts timers (timer:booking:)
// =============================================================================
const TIMER_KEYS = {
  ORDER_EXPIRY: (orderId: string) => `timer:booking-order:${orderId}`,
};

// Timer data interface
interface OrderTimerData {
  orderId: string;
  customerId: string;
  createdAt: string;
}


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
// EXPIRY CHECKER (Runs on every server instance - Redis ensures no duplicates)
// =============================================================================
// 
// SCALABILITY: Every ECS instance runs this checker, but Redis distributed locks
//   ensure only ONE instance processes each expired order (no duplicates)
// EASY UNDERSTANDING: Same pattern as booking.service.ts expiry checker
// MODULARITY: Independent from OrderService — runs as a background job
// =============================================================================

let orderExpiryCheckerInterval: NodeJS.Timeout | null = null;

/**
 * Start the order expiry checker
 * This runs on every server instance but uses Redis locks to prevent duplicate processing
 */
function startOrderExpiryChecker(): void {
  if (orderExpiryCheckerInterval) return;
  
  orderExpiryCheckerInterval = setInterval(async () => {
    try {
      await processExpiredOrders();
    } catch (error: any) {
      logger.error('Order expiry checker error', { error: error.message });
    }
  }, ORDER_CONFIG.EXPIRY_CHECK_INTERVAL_MS);
  
  logger.info('📅 Order expiry checker started (Redis-based, cluster-safe)');
}

/**
 * Process all expired order timers
 * Uses Redis distributed lock to prevent multiple instances processing the same order
 * 
 * SCALABILITY: Lock prevents duplicate expiry handling across ECS instances
 * EASY UNDERSTANDING: Scan expired → lock → handle → unlock
 * CODING STANDARDS: Same pattern as processExpiredBookings() in booking.service.ts
 */
async function processExpiredOrders(): Promise<void> {
  const expiredTimers = await redisService.getExpiredTimers<OrderTimerData>('timer:booking-order:');
  
  for (const timer of expiredTimers) {
    // Try to acquire lock for this order (prevents duplicate processing)
    const lockKey = `lock:booking-order-expiry:${timer.data.orderId}`;
    const lock = await redisService.acquireLock(lockKey, 'expiry-checker', 30);
    
    if (!lock.acquired) {
      // Another instance is processing this order
      continue;
    }
    
    try {
      await orderService.handleOrderTimeout(timer.data.orderId, timer.data.customerId);
      await redisService.cancelTimer(timer.key);
    } catch (error: any) {
      logger.error('Failed to process expired order', { 
        orderId: timer.data.orderId, 
        error: error.message 
      });
    } finally {
      await redisService.releaseLock(lockKey, 'expiry-checker').catch(() => {});
    }
  }
}

// Start expiry checker when module loads
startOrderExpiryChecker();

/** Stop the order expiry checker (for graceful shutdown) */
export function stopOrderExpiryChecker(): void {
  if (orderExpiryCheckerInterval) {
    clearInterval(orderExpiryCheckerInterval);
    orderExpiryCheckerInterval = null;
    logger.info('Order expiry checker stopped');
  }
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
    await this.startOrderTimeout(orderId, customerId);


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
      const allTransporterIdsForType = await db.getTransportersWithVehicleType(
        group.vehicleType,
        group.vehicleSubtype
      );
      
      // Phase 3 optimization: Filter to only ONLINE transporters using Redis set
      // O(1) per transporter instead of N+1 DB queries
      const transporterIds = await transporterOnlineService.filterOnline(allTransporterIdsForType);
      
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
        // Phase 3: Removed per-transporter db.getUserById() — already filtered by Redis online set.
        // Name lookup is non-critical for broadcast; transporter ID is logged instead.
        for (const transporterId of transporterIds) {
          emitToUser(transporterId, SocketEvent.NEW_BROADCAST, broadcastPayload);
          logger.info(`📢 Notified: ${transporterId.substring(0, 8)}... for ${group.vehicleType} ${group.vehicleSubtype} (${group.requests.length} trucks)`);
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
   * Start timeout timer for order (Redis-based for cluster support)
   * Auto-expires order if not fully filled within timeout
   * 
   * SCALABILITY: Uses Redis timers instead of in-memory setTimeout
   * - Works across multiple server instances (ECS tasks)
   * - Survives server restarts (timers persist in Redis)
   * - No duplicate processing (Redis distributed locks)
   * 
   * EASY UNDERSTANDING: Same pattern as booking.service.ts
   * MODULARITY: Timer key prefix separates from booking timers
   */
  private async startOrderTimeout(orderId: string, customerId: string): Promise<void> {
    // Cancel any existing timer for this order
    await redisService.cancelTimer(TIMER_KEYS.ORDER_EXPIRY(orderId));
    
    // Set new timer in Redis
    const expiresAt = new Date(Date.now() + ORDER_CONFIG.TIMEOUT_MS);
    const timerData: OrderTimerData = {
      orderId,
      customerId,
      createdAt: new Date().toISOString()
    };
    
    await redisService.setTimer(TIMER_KEYS.ORDER_EXPIRY(orderId), timerData, expiresAt);
    
    logger.info(`⏱️ Timeout timer started for order ${orderId} (${ORDER_CONFIG.TIMEOUT_MS / 1000}s) [Redis-based]`);
  }

  /**
   * Handle order timeout - called when timer expires
   * Made public for the expiry checker to call
   * 
   * SCALABILITY: Called by Redis expiry checker (cluster-safe)
   * EASY UNDERSTANDING: Check status → expire unfilled → notify all parties
   * MODULARITY: Same notification pattern as booking.service.ts
   */
  async handleOrderTimeout(orderId: string, customerId: string): Promise<void> {
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

    // Collect all notified transporters
    const allNotifiedTransporters = new Set<string>();
    requests.forEach(r => r.notifiedTransporters.forEach(t => allNotifiedTransporters.add(t)));
    
    // Notify transporters via WebSocket (for apps in foreground)
    for (const transporterId of allNotifiedTransporters) {
      emitToUser(transporterId, SocketEvent.BOOKING_EXPIRED, {
        orderId,
        message: 'This order has expired'
      });
    }

    // ========================================
    // FCM PUSH: Notify transporters of expiry (for apps in background)
    // ========================================
    // SCALABILITY: Queued via queueService — reliable with retry
    // EASY UNDERSTANDING: Transporters need to clear this order from their UI
    // MODULARITY: Fire-and-forget, doesn't block timeout handling
    const transporterIds = Array.from(allNotifiedTransporters);
    if (transporterIds.length > 0) {
      queueService.queuePushNotificationBatch(
        transporterIds,
        {
          title: '⏰ Order Expired',
          body: `Order request has expired`,
          data: {
            type: 'booking_expired',
            orderId
          }
        }
      ).catch(err => {
        logger.warn(`FCM: Failed to queue expiry push for order ${orderId}`, err);
      });
    }
  }

  /**
   * Clear all timers for an order (Redis-based)
   */
  private async clearOrderTimers(orderId: string): Promise<void> {
    // Cancel Redis-based expiry timer
    await redisService.cancelTimer(TIMER_KEYS.ORDER_EXPIRY(orderId));
  }

  /**
   * Cancel order timeout (called when fully filled)
   * 
   * SCALABILITY: Cancels distributed Redis timer
   * EASY UNDERSTANDING: Order is fully filled → no need for expiry timer
   */
  async cancelOrderTimeout(orderId: string): Promise<void> {
    await this.clearOrderTimers(orderId);
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
    const MAX_RETRIES = 3;

    // -------------------------------------------------------------------
    // ATOMIC TRANSACTION with optimistic locking + P2034 retry loop
    // Pattern: Prisma Serializable isolation + updateMany WHERE status guard
    // Reference: broadcast.service.ts line 411
    // -------------------------------------------------------------------
    let txResult: {
      updatedRequest: TruckRequestRecord;
      request: any;
      vehicle: any;
      transporter: any;
      driver: any;
      order: any;
      tripId: string;
      newFilled: number;
      trucksRemaining: number;
      newStatus: string;
      allRequests: any[];
      remainingRequests: any[];
      notifiedTransporters: Set<string>;
    } | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        txResult = await prismaClient.$transaction(async (tx) => {

          // STEP 1: Validate request exists and is still available (inside tx)
          const request = await tx.truckRequest.findUnique({ where: { id: requestId } });
          if (!request) {
            throw new AppError(404, 'REQUEST_NOT_FOUND', 'Truck request not found');
          }

          if (request.status !== 'searching') {
            throw new AppError(400, 'REQUEST_ALREADY_TAKEN',
              'This truck request was just taken by another transporter. Check for remaining trucks.');
          }

          // Verify transporter has this vehicle type (inside tx for consistency)
          const vehicle = await tx.vehicle.findUnique({ where: { id: vehicleId } });
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

          // Get transporter and driver info (inside tx)
          const transporter = await tx.user.findUnique({ where: { id: transporterId } });
          const driver = driverId
            ? await tx.user.findUnique({ where: { id: driverId } })
            : null;

          // STEP 2: Optimistic lock — updateMany with status guard
          // If another concurrent request already flipped status away from 'searching',
          // this WHERE clause matches 0 rows and we detect the conflict.
          const tripId = uuid();
          const now = new Date().toISOString();

          const requestUpdate = await tx.truckRequest.updateMany({
            where: {
              id: requestId,
              status: 'searching'
            },
            data: {
              status: 'assigned',
              assignedTransporterId: transporterId,
              assignedTransporterName: transporter?.businessName || transporter?.name || 'Unknown',
              assignedVehicleId: vehicleId,
              assignedVehicleNumber: vehicle.vehicleNumber,
              assignedDriverId: driverId || null,
              assignedDriverName: driver?.name || null,
              assignedDriverPhone: driver?.phone || null,
              tripId,
              assignedAt: now
            }
          });

          if (requestUpdate.count === 0) {
            throw new AppError(409, 'REQUEST_ALREADY_TAKEN',
              'This request is no longer available');
          }

          // Fetch the updated request record after the atomic update
          const updatedRow = await tx.truckRequest.findUnique({ where: { id: requestId } });
          if (!updatedRow) {
            throw new AppError(500, 'INTERNAL_ERROR', 'Failed to read updated truck request');
          }

          // Map to TruckRequestRecord shape
          const updatedRequest: TruckRequestRecord = {
            ...updatedRow,
            heldBy: updatedRow.heldById || undefined,
            assignedTo: updatedRow.assignedTransporterId || undefined,
            status: updatedRow.status as TruckRequestRecord['status'],
            notifiedTransporters: updatedRow.notifiedTransporters || [],
            createdAt: updatedRow.createdAt.toISOString(),
            updatedAt: updatedRow.updatedAt.toISOString(),
          };

          // STEP 3: Get parent order and update atomically
          const order = await tx.order.findUnique({ where: { id: request.orderId } });
          if (!order) {
            logger.error(`Order ${request.orderId} not found for request ${requestId}`);
            return {
              updatedRequest,
              request,
              vehicle,
              transporter,
              driver,
              order: null,
              tripId,
              newFilled: 0,
              trucksRemaining: 0,
              newStatus: 'unknown',
              allRequests: [],
              remainingRequests: [],
              notifiedTransporters: new Set<string>()
            };
          }

          const newFilled = order.trucksFilled + 1;
          const trucksRemaining = order.totalTrucks - newFilled;
          const newStatus = newFilled >= order.totalTrucks ? 'fully_filled' : 'partially_filled';

          // Optimistic lock on order: only update if trucksFilled hasn't changed
          const orderUpdate = await tx.order.updateMany({
            where: {
              id: request.orderId,
              trucksFilled: order.trucksFilled
            },
            data: {
              trucksFilled: newFilled,
              status: newStatus as any
            }
          });

          if (orderUpdate.count === 0) {
            // Another concurrent accept changed trucksFilled — retry will re-read
            throw new AppError(409, 'ORDER_STATE_CHANGED',
              'Order state changed concurrently. Retrying.');
          }

          // STEP 4: Get remaining searching requests (inside tx for consistency)
          const allRequestRows = await tx.truckRequest.findMany({
            where: { orderId: request.orderId }
          });
          const allRequests = allRequestRows.map((r: any) => ({
            ...r,
            heldBy: r.heldById || undefined,
            assignedTo: r.assignedTransporterId || undefined,
            status: r.status as string,
            notifiedTransporters: r.notifiedTransporters || [],
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
          }));

          const remainingRequests = allRequests.filter((r: any) =>
            r.status === 'searching' &&
            r.vehicleType === request.vehicleType &&
            r.vehicleSubtype === request.vehicleSubtype
          );

          // Collect notified transporters for post-tx notifications
          const notifiedTransporters = new Set<string>();
          allRequests.forEach((r: any) =>
            (r.notifiedTransporters || []).forEach((t: string) => notifiedTransporters.add(t))
          );

          return {
            updatedRequest,
            request,
            vehicle,
            transporter,
            driver,
            order,
            tripId,
            newFilled,
            trucksRemaining,
            newStatus,
            allRequests,
            remainingRequests,
            notifiedTransporters
          };

        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

        // Transaction succeeded — break out of retry loop
        break;

      } catch (txError: any) {
        // Retry on serialization conflict (P2034 = Prisma, 40001 = Postgres)
        const isRetryable = txError?.code === 'P2034' || txError?.code === '40001';
        if (isRetryable && attempt < MAX_RETRIES) {
          logger.warn(`[acceptTruckRequest] Serialization conflict, retry ${attempt}/${MAX_RETRIES}`, {
            requestId, transporterId, vehicleId, attempt, code: txError.code
          });
          continue;
        }
        // Non-retryable or exhausted retries — rethrow
        throw txError;
      }
    }

    if (!txResult) {
      throw new AppError(409, 'REQUEST_ALREADY_TAKEN',
        'Unable to complete assignment after retries');
    }

    // -------------------------------------------------------------------
    // ALL NOTIFICATIONS BELOW — outside the transaction
    // -------------------------------------------------------------------
    const {
      updatedRequest, request, vehicle, transporter, driver, order,
      tripId, newFilled, trucksRemaining, newStatus,
      allRequests, remainingRequests, notifiedTransporters
    } = txResult;

    // If order was missing, return early (edge case preserved from original)
    if (!order) {
      return updatedRequest;
    }

    logger.info(`╔══════════════════════════════════════════════════════════════╗`);
    logger.info(`║  TRUCK ACCEPTED (atomic)                                     ║`);
    logger.info(`╠══════════════════════════════════════════════════════════════╣`);
    logger.info(`║  Request: ${requestId}`);
    logger.info(`║  Transporter: ${transporter?.name || transporterId}`);
    logger.info(`║  Vehicle: ${vehicle.vehicleNumber} (${vehicle.vehicleType} ${vehicle.vehicleSubtype})`);
    logger.info(`║  Progress: ${newFilled}/${order.totalTrucks} trucks filled`);
    logger.info(`║  Remaining (same type): ${remainingRequests.length}`);
    logger.info(`║  Processing time: ${Date.now() - startTime}ms`);
    logger.info(`╚══════════════════════════════════════════════════════════════╝`);

    // STEP 5: Send INSTANT confirmation to accepting transporter
    emitToUser(transporterId, SocketEvent.ACCEPT_CONFIRMATION, {
      success: true,
      requestId,
      orderId: order.id,
      vehicleNumber: vehicle.vehicleNumber,
      tripId,
      message: `You got it! Truck ${request.requestNumber} assigned to you.`,

      // Show if more trucks available of same type
      moreTrucksAvailable: remainingRequests.length > 0,
      remainingOfSameType: remainingRequests.length,
      remainingRequestIds: remainingRequests.map((r: any) => r.id)
    });

    // STEP 6: Update ALL other transporters with remaining count
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
          remainingRequestIds: remainingRequests.map((r: any) => r.id),

          // Status
          orderStatus: newStatus,
          message: remainingRequests.length > 0
            ? `${remainingRequests.length} ${request.vehicleType} ${request.vehicleSubtype} trucks still available!`
            : `All ${request.vehicleType} ${request.vehicleSubtype} trucks have been taken.`
        });
      }
    }

    // STEP 7: Notify customer with REAL-TIME progress
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

      message: `Truck ${newFilled}/${order.totalTrucks} assigned!`
    });

    // STEP 8: Handle completion or partial fill
    if (newStatus === 'fully_filled') {
      // All trucks filled - Cancel timeout and celebrate!
      await this.cancelOrderTimeout(order.id);

      emitToUser(order.customerId, SocketEvent.BOOKING_FULLY_FILLED, {
        orderId: order.id,
        totalTrucks: order.totalTrucks,
        totalAmount: order.totalAmount,
        message: 'All trucks have been assigned! Your order is complete.',
        assignedTrucks: allRequests
          .filter((r: any) => r.status === 'assigned')
          .map((r: any) => ({
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

      logger.info(`ORDER ${order.id} FULLY FILLED!`);
    }

    return updatedRequest;
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
