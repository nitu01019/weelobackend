/**
 * @deprecated Legacy booking order creation. See order.service.ts deprecation notice.
 *
 * Order creation pipeline: validate, create parent Order, expand truck selections
 * into TruckRequests, group by vehicle type, broadcast to matching transporters,
 * and start timeout timer.
 */

import { v4 as uuid } from 'uuid';
import { db, OrderRecord, TruckRequestRecord } from '../../shared/database/db';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, SocketEvent } from '../../shared/services/socket.service';
import { redisService } from '../../shared/services/redis.service';
import { CreateOrderInput, TruckSelection } from './booking.schema';
import { transporterOnlineService } from '../../shared/services/transporter-online.service';
import { ORDER_CONFIG, TIMER_KEYS, GroupedRequests, CreateOrderResult, OrderTimerData } from './legacy-order-types';

// =============================================================================
// ORDER CREATION
// =============================================================================

/**
 * CREATE ORDER - Main Entry Point
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
export async function createOrder(
  customerId: string,
  customerPhone: string,
  data: CreateOrderInput
): Promise<CreateOrderResult> {

  const startTime = Date.now();

  // Get customer info
  const customer = await db.getUserById(customerId);
  const customerName = customer?.name || 'Customer';

  // Calculate totals
  const totalTrucks = data.trucks!.reduce((sum, t) => sum + t.quantity, 0);
  const totalAmount = data.trucks!.reduce((sum, t) => sum + (t.quantity * t.pricePerTruck), 0);
  const expiresAt = new Date(Date.now() + ORDER_CONFIG.TIMEOUT_MS).toISOString();

  // Generate IDs
  const orderId = uuid();

  logger.info(`╔══════════════════════════════════════════════════════════════╗`);
  logger.info(`║  NEW ORDER REQUEST                                           ║`);
  logger.info(`╠══════════════════════════════════════════════════════════════╣`);
  logger.info(`║  Order ID: ${orderId}`);
  logger.info(`║  Customer: ${customerName} (${customerPhone})`);
  logger.info(`║  Total Trucks: ${totalTrucks}`);
  logger.info(`║  Total Amount: ${totalAmount}`);
  logger.info(`║  Truck Types: ${data.trucks!.map(t => `${t.quantity}x ${t.vehicleType} ${t.vehicleSubtype}`).join(', ')}`);
  logger.info(`╚══════════════════════════════════════════════════════════════╝`);

  // STEP 1: Create parent Order record
  const order = await db.createOrder({
    id: orderId,
    customerId,
    customerName,
    customerPhone,
    pickup: {
      latitude: data.pickup!.coordinates!.latitude,
      longitude: data.pickup!.coordinates!.longitude,
      address: data.pickup!.address,
      city: data.pickup!.city,
      state: data.pickup!.state
    },
    drop: {
      latitude: data.drop!.coordinates!.latitude,
      longitude: data.drop!.coordinates!.longitude,
      address: data.drop!.address,
      city: data.drop!.city,
      state: data.drop!.state
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

  // STEP 2: Expand truck selections into individual TruckRequests
  const truckRequests = expandTruckSelections(orderId, data.trucks!);

  // Batch create all truck requests
  const createdRequests = await db.createTruckRequestsBatch(truckRequests);

  // STEP 3: Group requests by vehicle type for efficient broadcasting
  const groupedRequests = groupRequestsByVehicleType(createdRequests);

  // STEP 4: Find matching transporters and broadcast (parallel)
  const broadcastSummary = await broadcastToTransporters(
    order,
    groupedRequests,
    data.distanceKm
  );

  // STEP 5: Handle case when no transporters found
  if (broadcastSummary.totalTransportersNotified === 0) {
    logger.warn(`No transporters found for any truck type in order ${orderId}`);

    // Update order status
    await db.updateOrder(orderId, { status: 'expired' });

    // Update all requests to expired
    await db.updateTruckRequestsBatch(
      createdRequests.map((r: TruckRequestRecord) => r.id),
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
      truckRequests: createdRequests.map((r: TruckRequestRecord) => ({ ...r, status: 'expired' as const })),
      broadcastSummary,
      timeoutSeconds: 0
    };
  }

  // STEP 6: Start timeout timer
  await startOrderTimeout(orderId, customerId);


  const processingTime = Date.now() - startTime;
  logger.info(`Order ${orderId} created in ${processingTime}ms`);
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
function expandTruckSelections(
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
function groupRequestsByVehicleType(requests: TruckRequestRecord[]): GroupedRequests[] {
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
async function broadcastToTransporters(
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
        // H-8 FIX: Unified location format -- nested objects for new Captain app, flat for legacy
        pickupLocation: {
          lat: order.pickup.latitude,
          lng: order.pickup.longitude,
          address: order.pickup.address || '',
        },
        dropLocation: {
          lat: order.drop.latitude,
          lng: order.drop.longitude,
          address: order.drop.address || '',
        },

        // H-8 FIX: Unified ETA -- both fields present for backward compatibility
        // pickupEtaMinutes: DEPRECATED but kept for old Captain app versions
        // pickupEtaSeconds: NEW standard field
        pickupEtaSeconds: 0,
        pickupEtaMinutes: 0,

        // Goods info
        goodsType: order.goodsType,
        weight: order.weight,

        // Timing
        createdAt: order.createdAt,
        expiresAt: order.expiresAt,
        timeoutSeconds: ORDER_CONFIG.TIMEOUT_MS / 1000,

        isUrgent: false,

        // H-8 FIX: Payload version -- lets Captain app detect new format
        payloadVersion: 2,
      };

      // H-19 FIX: Cap notified transporters to prevent FCM throttling and latency spikes
      const MAX_BROADCAST_TRANSPORTERS_ORDER = parseInt(process.env.MAX_BROADCAST_TRANSPORTERS || '100', 10);
      const cappedOrderTransporters = transporterIds.length > MAX_BROADCAST_TRANSPORTERS_ORDER
        ? (() => {
            logger.info(`[Broadcast][Order] Capping ${transporterIds.length} -> ${MAX_BROADCAST_TRANSPORTERS_ORDER} transporters`);
            return transporterIds.slice(0, MAX_BROADCAST_TRANSPORTERS_ORDER);
          })()
        : transporterIds;

      // Emit to all transporters in this group
      // Phase 3: Removed per-transporter db.getUserById() -- already filtered by Redis online set.
      // Name lookup is non-critical for broadcast; transporter ID is logged instead.
      for (const transporterId of cappedOrderTransporters) {
        emitToUser(transporterId, SocketEvent.NEW_BROADCAST, broadcastPayload);
        logger.info(`Notified: ${transporterId.substring(0, 8)}... for ${group.vehicleType} ${group.vehicleSubtype} (${group.requests.length} trucks)`);

        // H-7 FIX: Broadcast delivery tracking for observability (fire-and-forget)
        try {
          if (typeof redisService.hSet === 'function') {
            redisService.hSet(
              `broadcast:delivery:${order.id}`,
              transporterId,
              JSON.stringify({ emittedAt: Date.now(), channel: 'socket' })
            ).then(() => redisService.expire(`broadcast:delivery:${order.id}`, 3600))
             .catch((_err: unknown) => { /* silent -- observability only */ });
          }
        } catch (_h7Err: unknown) { /* H-7 is observability only -- never crash broadcast */ }
      }
    } else {
      logger.warn(`No transporters found for ${group.vehicleType} ${group.vehicleSubtype}`);
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
async function startOrderTimeout(orderId: string, customerId: string): Promise<void> {
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

  logger.info(`Timeout timer started for order ${orderId} (${ORDER_CONFIG.TIMEOUT_MS / 1000}s) [Redis-based]`);
}
