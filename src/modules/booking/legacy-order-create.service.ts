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
 * Broadcast to transporters — THIN-WRAP per F-B-77 (Strangler Fig).
 *
 * Delegates to the canonical `order-broadcast.service.ts::broadcastToTransporters`
 * via `order-delegates-bridge.service.ts`. Adapts fork-shaped input
 * `(OrderRecord, GroupedRequests[], distanceKm)` into the canonical
 * `(orderId, CreateOrderRequest, TruckRequestRecord[], expiresAt, resolvedPickup)` shape
 * and back-fills `CreateOrderResult['broadcastSummary']` from the canonical result.
 */
async function broadcastToTransporters(
  order: OrderRecord,
  groupedRequests: GroupedRequests[],
  distanceKm: number
): Promise<CreateOrderResult['broadcastSummary']> {
  const { broadcastToTransporters: canonicalBroadcast } = require('../order/order-delegates-bridge.service') as typeof import('../order/order-delegates-bridge.service');

  const truckRequests = groupedRequests.flatMap(g => g.requests);

  const canonicalRequest = {
    customerId: order.customerId,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    pickup: {
      latitude: order.pickup.latitude,
      longitude: order.pickup.longitude,
      address: order.pickup.address || '',
      city: order.pickup.city,
      state: order.pickup.state,
    },
    drop: {
      latitude: order.drop.latitude,
      longitude: order.drop.longitude,
      address: order.drop.address || '',
      city: order.drop.city,
      state: order.drop.state,
    },
    distanceKm,
    vehicleRequirements: groupedRequests.map(g => ({
      vehicleType: g.vehicleType,
      vehicleSubtype: g.vehicleSubtype,
      quantity: g.requests.length,
      pricePerTruck: g.requests[0]?.pricePerTruck ?? 0,
    })),
    goodsType: order.goodsType ?? undefined,
    cargoWeightKg: order.cargoWeightKg ?? undefined,
  };

  const resolvedPickup = {
    latitude: order.pickup.latitude,
    longitude: order.pickup.longitude,
    address: order.pickup.address || '',
    city: order.pickup.city,
    state: order.pickup.state,
  };

  const result = await canonicalBroadcast(
    order.id,
    canonicalRequest,
    truckRequests,
    order.expiresAt,
    resolvedPickup
  );

  const groupedBy: CreateOrderResult['broadcastSummary']['groupedBy'] = groupedRequests.map(g => ({
    vehicleType: g.vehicleType,
    vehicleSubtype: g.vehicleSubtype,
    count: g.requests.length,
    transportersNotified: 0,
  }));

  return {
    totalRequests: groupedRequests.reduce((sum, g) => sum + g.requests.length, 0),
    groupedBy,
    totalTransportersNotified: result.notifiedTransporters,
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
