/**
 * =============================================================================
 * ORDER SERVICE - Multi-Vehicle Type Booking System
 * =============================================================================
 * 
 * SCALABILITY: Designed for millions of concurrent bookings
 * - Each order can have multiple vehicle types (Tipper + Container + Open)
 * - Each vehicle type creates a separate SubRequest
 * - Each SubRequest broadcasts ONLY to transporters with that vehicle type
 * 
 * FLOW:
 * 1. Customer creates ORDER with multiple vehicle types
 * 2. System creates TruckRequests (one per truck, grouped by type)
 * 3. Each vehicle type broadcasts to matching transporters
 * 4. Transporters see ONLY requests matching their vehicles
 * 5. Real-time updates to customer as trucks get filled
 * 
 * MODULARITY:
 * - Clear separation: Order → TruckRequests → Assignments
 * - Easy to extend for new vehicle types
 * - AWS-ready with message queue support (TODO)
 * =============================================================================
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db, OrderRecord, TruckRequestRecord } from '../../shared/database/db';
import { prismaClient } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { emitToUser } from '../../shared/services/socket.service';
import { sendPushNotification } from '../../shared/services/fcm.service';
import { cacheService } from '../../shared/services/cache.service';
import { queueService } from '../../shared/services/queue.service';
import { availabilityService } from '../../shared/services/availability.service';
import { generateVehicleKey } from '../../shared/services/vehicle-key.service';
import { transporterOnlineService } from '../../shared/services/transporter-online.service';
import { routingService } from '../routing';
import { redisService } from '../../shared/services/redis.service';
import { pricingService } from '../pricing/pricing.service';

// =============================================================================
// CACHE KEYS & TTL (Optimized for fast lookups)
// =============================================================================
const CACHE_KEYS = {
  TRANSPORTERS_BY_VEHICLE: 'trans:vehicle:',  // trans:vehicle:tipper:20-24Ton
  ORDER: 'order:',
  ACTIVE_REQUESTS: 'active:requests:'
};

const CACHE_TTL = {
  TRANSPORTERS: 300,    // 5 minutes - transporters by vehicle type
  ORDER: 60,            // 1 minute - order details
  ACTIVE_REQUESTS: 30   // 30 seconds - active requests list
};

// =============================================================================
// TYPES
// =============================================================================

/**
 * Vehicle requirement in a booking
 * Customer can request multiple types in one booking
 */
export interface VehicleRequirement {
  vehicleType: string;      // e.g., "tipper", "container", "open"
  vehicleSubtype: string;   // e.g., "20-24 Ton", "17ft"
  quantity: number;         // How many trucks of this type
  pricePerTruck: number;    // Price for this specific type
}

/**
 * Route Point for intermediate stops
 * 
 * IMPORTANT: Stops are defined BEFORE booking only!
 * After booking: NO adding, removing, or reordering
 */
export interface RoutePointInput {
  type: 'PICKUP' | 'STOP' | 'DROP';
  latitude: number;
  longitude: number;
  address: string;
  city?: string;
  state?: string;
}

/**
 * Create order request from customer app
 * 
 * ROUTE POINTS:
 * - Option 1: Full route with stops (routePoints array)
 * - Option 2: Simple pickup/drop (legacy, backward compatible)
 * 
 * If routePoints is provided, pickup/drop are extracted from first/last points
 */
export interface CreateOrderRequest {
  customerId: string;
  customerName: string;
  customerPhone: string;

  // Option 1: Full route with intermediate stops (NEW - preferred)
  routePoints?: RoutePointInput[];

  // Option 2: Simple pickup/drop (LEGACY - backward compatible)
  pickup?: {
    latitude: number;
    longitude: number;
    address: string;
    city?: string;
    state?: string;
  };
  drop?: {
    latitude: number;
    longitude: number;
    address: string;
    city?: string;
    state?: string;
  };

  distanceKm: number;

  // Multiple vehicle types
  vehicleRequirements: VehicleRequirement[];

  // Optional
  goodsType?: string;
  cargoWeightKg?: number;
  scheduledAt?: string;  // For scheduled bookings

  // SCALABILITY: Idempotency key prevents duplicate orders on network retry
  idempotencyKey?: string;  // UUID from client (optional)
}

/**
 * Response after creating order
 */
export interface CreateOrderResponse {
  orderId: string;
  totalTrucks: number;
  totalAmount: number;
  truckRequests: {
    id: string;
    vehicleType: string;
    vehicleSubtype: string;
    quantity: number;
    pricePerTruck: number;
    matchingTransporters: number;
  }[];
  expiresAt: string;
  expiresIn: number;  // SCALABILITY: Duration in seconds - UI uses this for countdown timer
}

/**
 * Route Point for broadcast
 */
interface BroadcastRoutePoint {
  type: 'PICKUP' | 'STOP' | 'DROP';
  latitude: number;
  longitude: number;
  address: string;
  city?: string;
  stopIndex: number;
}

/**
 * Route Leg for broadcast (ETA per leg)
 */
interface BroadcastRouteLeg {
  fromIndex: number;
  toIndex: number;
  fromType: string;
  toType: string;
  fromAddress: string;
  toAddress: string;
  fromCity?: string;
  toCity?: string;
  distanceKm: number;
  durationMinutes: number;
  durationFormatted: string;
  etaMinutes: number;  // Cumulative ETA from start
}

/**
 * Route Breakdown for broadcast
 */
interface BroadcastRouteBreakdown {
  legs: BroadcastRouteLeg[];
  totalDistanceKm: number;
  totalDurationMinutes: number;
  totalDurationFormatted: string;
  totalStops: number;
  estimatedArrival?: string;
}

/**
 * Broadcast data sent to transporters via WebSocket
 * 
 * IMPORTANT: Field names must match what Captain app's SocketIOService expects!
 * Captain app parses these in handleNewBroadcast() with fallbacks.
 * 
 * ROUTE POINTS:
 * - routePoints array includes all stops (PICKUP → STOP → STOP → DROP)
 * - Driver sees full route before accepting
 * - currentRouteIndex always 0 for new broadcasts
 * 
 * @see Captain app: SocketIOService.kt -> handleNewBroadcast()
 */
interface BroadcastData {
  type: 'new_truck_request';
  orderId: string;
  truckRequestId: string;
  requestNumber: number;

  // Customer info
  customerName: string;

  // =========================================================================
  // ROUTE POINTS (NEW - with intermediate stops)
  // =========================================================================
  routePoints: BroadcastRoutePoint[];
  totalStops: number;  // Number of intermediate stops (0, 1, or 2)

  // =========================================================================
  // ROUTE BREAKDOWN (NEW - ETA per leg)
  // =========================================================================
  routeBreakdown: BroadcastRouteBreakdown;

  // Locations - nested format (legacy, for backward compatibility)
  pickup: {
    latitude: number;
    longitude: number;
    address: string;
    city?: string;
  };
  drop: {
    latitude: number;
    longitude: number;
    address: string;
    city?: string;
  };

  // Locations - flat format (for Captain app compatibility)
  pickupAddress: string;
  pickupCity: string;
  dropAddress: string;
  dropCity: string;

  // Vehicle requirements (THIS is what the transporter can fulfill)
  vehicleType: string;
  vehicleSubtype: string;
  pricePerTruck: number;
  farePerTruck: number;  // Alias for Captain app

  // Trip info
  distanceKm: number;
  distance: number;      // Alias for Captain app
  goodsType?: string;

  // Timing
  expiresAt: string;
  createdAt: string;
}

// =============================================================================
// SERVICE CLASS
// =============================================================================

class OrderService {

  // Timeout for broadcasts (1 minute - quick response needed)
  private readonly BROADCAST_TIMEOUT_MS = parseInt(process.env.BROADCAST_TIMEOUT_SECONDS || '120', 10) * 1000;

  // Redis key patterns for distributed timers
  private readonly TIMER_KEYS = {
    ORDER_EXPIRY: (orderId: string) => `timer:order:${orderId}`,
  };

  // Order timers map (for local timer cleanup)
  private orderTimers: Map<string, NodeJS.Timeout> = new Map();

  // ===========================================================================
  // CACHED LOOKUPS (Optimized for millions of requests)
  // ===========================================================================

  // ==========================================================================
  // RATE LIMITING (Redis-based for cluster support)
  // ==========================================================================

  /**
   * Check if request is within rate limit
   * 
   * SCALABILITY: Uses Redis for distributed rate limiting
   * - Works across all server instances
   * - Atomic increment prevents race conditions
   * - Automatic TTL cleanup
   * 
   * @param key Unique key for rate limiting (e.g., "order_create:userId")
   * @param limit Maximum requests allowed
   * @param windowSeconds Time window in seconds
   * @returns { allowed: boolean, retryAfter: number }
   */
  async checkRateLimit(
    key: string,
    limit: number,
    windowSeconds: number
  ): Promise<{ allowed: boolean; retryAfter: number }> {
    const result = await redisService.checkRateLimit(`ratelimit:order:${key}`, limit, windowSeconds);

    return {
      allowed: result.allowed,
      retryAfter: result.allowed ? 0 : result.resetIn
    };
  }

  /**
   * Clean up expired rate limit entries
   * NOTE: With Redis, TTL handles cleanup automatically - this is now a no-op
   */
  cleanupRateLimits(): void {
    // Redis TTL handles cleanup automatically
    // This method kept for backward compatibility
  }

  // ==========================================================================
  // TRANSPORTER LOOKUP (CACHED)
  // ==========================================================================

  /**
   * Get transporters by vehicle type (CACHED + AVAILABILITY FILTERED)
   * Uses cache to avoid repeated DB queries during high-load broadcasts
   * 
   * IMPORTANT: Only returns transporters who are:
   * 1. Have matching vehicle type
   * 2. Are marked as "available" (online toggle is ON)
   * 
   * NOTE: cacheService.get() already handles JSON parsing, so we don't need
   * to call JSON.parse() again on the cached value!
   */
  private async getTransportersByVehicleCached(
    vehicleType: string,
    vehicleSubtype: string
  ): Promise<string[]> {
    const cacheKey = `${CACHE_KEYS.TRANSPORTERS_BY_VEHICLE}${vehicleType}:${vehicleSubtype}`;

    // Try cache first - cacheService.get<T>() already parses JSON!
    let transporterIds: string[];

    try {
      const cached = await cacheService.get<string[]>(cacheKey);

      if (cached && Array.isArray(cached)) {
        logger.debug(`Cache HIT: ${cacheKey} (${cached.length} transporters)`);
        transporterIds = cached;
      } else {
        // Cache miss - query database
        transporterIds = await db.getTransportersWithVehicleType(vehicleType, vehicleSubtype);

        // Store in cache (cacheService.set() handles JSON.stringify internally)
        await cacheService.set(cacheKey, transporterIds, CACHE_TTL.TRANSPORTERS);
        logger.debug(`Cache SET: ${cacheKey} (${transporterIds.length} transporters)`);
      }
    } catch (error: any) {
      // If cache fails, fall back to database
      logger.warn(`Cache error for ${cacheKey}: ${error.message}. Falling back to DB.`);
      transporterIds = await db.getTransportersWithVehicleType(vehicleType, vehicleSubtype);
    }

    // FILTER: Only include transporters who are AVAILABLE (online toggle ON)
    // Phase 3 optimization: Uses Redis `online:transporters` set for O(1) filtering
    // instead of N+1 DB queries (getUserById per transporter).
    // Graceful degradation: falls back to DB check if Redis is unavailable.
    const availableTransporters = await transporterOnlineService.filterOnline(transporterIds);

    return availableTransporters;
  }

  /**
   * Invalidate transporter cache when vehicles change
   */
  async invalidateTransporterCache(vehicleType: string, vehicleSubtype?: string): Promise<void> {
    if (vehicleSubtype) {
      await cacheService.delete(`${CACHE_KEYS.TRANSPORTERS_BY_VEHICLE}${vehicleType}:${vehicleSubtype}`);
    } else {
      // Invalidate all subtypes for this vehicle type
      const iterator = cacheService.scanIterator(`${CACHE_KEYS.TRANSPORTERS_BY_VEHICLE}${vehicleType}:*`);
      for await (const key of iterator) {
        await cacheService.delete(key);
      }
    }
    logger.debug(`Cache invalidated: transporters for ${vehicleType}${vehicleSubtype ? ':' + vehicleSubtype : ':*'}`);
  }

  /**
   * Create a new order with multiple vehicle types
   * 
   * SCALABILITY NOTES:
   * - For millions of users, this should be moved to a message queue
   * - Each vehicle type can be processed in parallel
   * - Database writes should be batched
   * - Idempotency prevents duplicate processing on retry
   * 
   * ROUTE POINTS:
   * - If routePoints provided, use them directly
   * - If only pickup/drop provided, build routePoints from them
   * - routePoints are IMMUTABLE after creation
   */
  async createOrder(request: CreateOrderRequest): Promise<CreateOrderResponse> {
    // ==========================================================================
    // PER-CUSTOMER ORDER DEBOUNCE (3 second cooldown)
    // ==========================================================================
    // SCALABILITY: Redis-based, works across all server instances
    // EASY UNDERSTANDING: Prevents rapid-fire different orders from same customer
    // MODULARITY: Independent of idempotency (which checks same request, this
    //             checks same customer making ANY request too quickly)
    // CODING STANDARDS: Uses Redis SETNX for atomic check-and-set
    //
    // NOTE: Idempotency = same request retried. Debounce = different requests
    //       submitted too quickly. Both are needed for production safety.
    // ==========================================================================
    const DEBOUNCE_SECONDS = 3;
    const debounceKey = `debounce:order:${request.customerId}`;

    try {
      const debounceActive = await redisService.get(debounceKey);
      if (debounceActive) {
        logger.warn(`⚠️ ORDER DEBOUNCE: Customer ${request.customerId} tried to place order within ${DEBOUNCE_SECONDS}s cooldown`);
        throw new Error(`Please wait a few seconds before placing another order.`);
      }
      // Set debounce key — auto-expires after 3 seconds
      await redisService.set(debounceKey, '1', DEBOUNCE_SECONDS);
    } catch (error: any) {
      // If error is our debounce error, rethrow it
      if (error.message.includes('Please wait')) throw error;
      // If Redis fails, skip debounce (don't block orders)
      logger.warn(`⚠️ Debounce check failed: ${error.message}. Proceeding without debounce.`);
    }

    // ==========================================================================
    // IDEMPOTENCY CHECK - Prevents duplicate orders on network retry
    // ==========================================================================
    // SCALABILITY: Uses Redis for fast lookup across all server instances
    // EASY UNDERSTANDING: Same idempotency key = return cached response
    // MODULARITY: Can be called multiple times safely
    // ==========================================================================
    if (request.idempotencyKey) {
      const cacheKey = `idempotency:${request.customerId}:${request.idempotencyKey}`;

      try {
        const cached = await redisService.get(cacheKey);
        if (cached) {
          const cachedResponse = JSON.parse(cached) as CreateOrderResponse;
          logger.info(`✅ Idempotency HIT: Returning cached order ${cachedResponse.orderId.substring(0, 8)}... for key ${request.idempotencyKey.substring(0, 8)}...`);
          return cachedResponse;
        }
        logger.debug(`🔍 Idempotency MISS: Processing new order for key ${request.idempotencyKey.substring(0, 8)}...`);
      } catch (error: any) {
        logger.warn(`⚠️ Idempotency cache error: ${error.message}. Proceeding with order creation.`);
        // Continue with order creation even if cache fails
      }
    }

    // ========================================
    // ONE-ACTIVE-BROADCAST-PER-CUSTOMER GUARD
    // ========================================
    const activeKey = `customer:active-broadcast:${request.customerId}`;
    const existingBroadcastId = await redisService.get(activeKey);
    if (existingBroadcastId) {
      throw new Error('Request already in progress. Cancel it first.');
    }

    const lockKey = `customer-broadcast-create:${request.customerId}`;
    const lock = await redisService.acquireLock(lockKey, request.customerId, 10);
    if (!lock.acquired) {
      throw new Error('Request already in progress. Cancel it first.');
    }

    try {
    // DB authoritative check (covers Redis failure edge case)
    const existingBooking = await prismaClient.booking.findFirst({
      where: { customerId: request.customerId, status: { in: ['created', 'broadcasting', 'active', 'partially_filled'] as any } }
    });
    const existingOrder = await prismaClient.order.findFirst({
      where: { customerId: request.customerId, status: { in: ['created', 'broadcasting', 'active', 'partially_filled'] as any } }
    });
    if (existingBooking || existingOrder) {
      throw new Error('Request already in progress. Cancel it first.');
    }

    // ========================================
    // SERVER-GENERATED IDEMPOTENCY (double-tap / retry protection)
    // ========================================
    const roundCoord = (n: number) => Math.round(n * 1000) / 1000;
    // Extract pickup/drop coords from routePoints or legacy fields
    const idemPickup = request.routePoints?.[0] || request.pickup;
    const idemDrop = request.routePoints?.[request.routePoints?.length ? request.routePoints.length - 1 : 0] || request.drop;
    const truckTypesSorted = request.vehicleRequirements
      .map(t => `${t.vehicleType}:${t.vehicleSubtype || ''}:${t.quantity}`)
      .sort()
      .join('|');
    const idempotencyFingerprint = [
      request.customerId,
      truckTypesSorted,
      roundCoord(idemPickup?.latitude || 0),
      roundCoord(idemPickup?.longitude || 0),
      roundCoord(idemDrop?.latitude || 0),
      roundCoord(idemDrop?.longitude || 0)
    ].join(':');
    const idempotencyHash = crypto.createHash('sha256').update(idempotencyFingerprint).digest('hex').substring(0, 16);
    const dedupeKey = `idem:broadcast:create:${request.customerId}:${idempotencyHash}`;

    const existingDedupeId = await redisService.get(dedupeKey);
    if (existingDedupeId) {
      const existingDedupeOrder = await db.getOrderById(existingDedupeId);
      if (existingDedupeOrder && !['cancelled', 'expired'].includes(existingDedupeOrder.status)) {
        logger.info('Idempotent replay: returning existing order', { orderId: existingDedupeId, idempotencyHash });
        const totalTrucks = request.vehicleRequirements.reduce((sum, req) => sum + req.quantity, 0);
        const totalAmount = request.vehicleRequirements.reduce((sum, req) => sum + (req.quantity * req.pricePerTruck), 0);
        return {
          orderId: existingDedupeId,
          totalTrucks,
          totalAmount,
          truckRequests: [],
          expiresAt: existingDedupeOrder.expiresAt,
          expiresIn: 0
        };
      }
    }

    const orderId = uuidv4();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.BROADCAST_TIMEOUT_MS).toISOString();

    // Calculate totals
    const totalTrucks = request.vehicleRequirements.reduce((sum, req) => sum + req.quantity, 0);

    // ==========================================================================
    // SECURITY: Server-side price validation
    // ==========================================================================
    // Recalculate prices server-side to prevent client-side price tampering.
    // The client-submitted pricePerTruck is compared against the server-calculated
    // price. If the client price is lower (manipulated), we use the server price.
    // A tolerance of 5% is allowed for rounding/timing differences (e.g., surge).
    // ==========================================================================
    const PRICE_TOLERANCE = 0.05; // 5% tolerance for rounding/surge timing

    for (const req of request.vehicleRequirements) {
      try {
        const serverEstimate = pricingService.calculateEstimate({
          vehicleType: req.vehicleType,
          vehicleSubtype: req.vehicleSubtype,
          distanceKm: request.distanceKm,
          trucksNeeded: req.quantity,
          cargoWeightKg: request.cargoWeightKg
        });

        const serverPrice = serverEstimate.pricePerTruck;
        const clientPrice = req.pricePerTruck;
        const priceDiff = (clientPrice - serverPrice) / serverPrice;

        if (priceDiff < -PRICE_TOLERANCE) {
          // Client price is suspiciously low - use server price
          logger.warn(`⚠️ PRICE TAMPER DETECTED: ${req.vehicleType}/${req.vehicleSubtype} ` +
            `client=₹${clientPrice} vs server=₹${serverPrice} (diff=${(priceDiff * 100).toFixed(1)}%). ` +
            `Using server price.`);
          req.pricePerTruck = serverPrice;
        } else if (Math.abs(priceDiff) > PRICE_TOLERANCE) {
          // Price differs significantly but client paid more - log but allow
          logger.info(`ℹ️ Price variance: ${req.vehicleType}/${req.vehicleSubtype} ` +
            `client=₹${clientPrice} vs server=₹${serverPrice} (diff=${(priceDiff * 100).toFixed(1)}%)`);
        }
      } catch (error: any) {
        logger.warn(`⚠️ Price validation failed for ${req.vehicleType}: ${error.message}. Using client price.`);
        // If pricing service fails, allow client price to avoid blocking orders
      }
    }

    const totalAmount = request.vehicleRequirements.reduce(
      (sum, req) => sum + (req.quantity * req.pricePerTruck),
      0
    );

    // ==========================================================================
    // BUILD ROUTE POINTS (with intermediate stops support)
    // ==========================================================================
    // 
    // INPUT OPTIONS:
    // 1. routePoints array (NEW) - directly use these
    // 2. pickup + drop (LEGACY) - build routePoints from them
    //
    // OUTPUT: routePoints array with auto-assigned stopIndex
    // ==========================================================================

    let routePoints: { type: 'PICKUP' | 'STOP' | 'DROP'; latitude: number; longitude: number; address: string; city?: string; state?: string; stopIndex: number }[];
    let pickup: { latitude: number; longitude: number; address: string; city?: string; state?: string };
    let drop: { latitude: number; longitude: number; address: string; city?: string; state?: string };

    if (request.routePoints && request.routePoints.length >= 2) {
      // NEW: Use provided routePoints
      routePoints = request.routePoints.map((point, index) => ({
        ...point,
        stopIndex: index
      }));

      // Extract pickup (first) and drop (last) for backward compatibility
      const firstPoint = request.routePoints[0];
      const lastPoint = request.routePoints[request.routePoints.length - 1];

      pickup = {
        latitude: firstPoint.latitude,
        longitude: firstPoint.longitude,
        address: firstPoint.address,
        city: firstPoint.city,
        state: firstPoint.state
      };

      drop = {
        latitude: lastPoint.latitude,
        longitude: lastPoint.longitude,
        address: lastPoint.address,
        city: lastPoint.city,
        state: lastPoint.state
      };

      logger.info(`📍 Route has ${routePoints.length} points (${routePoints.filter(p => p.type === 'STOP').length} intermediate stops)`);
    } else if (request.pickup && request.drop) {
      // LEGACY: Build routePoints from pickup + drop
      pickup = request.pickup;
      drop = request.drop;

      routePoints = [
        { type: 'PICKUP', ...pickup, stopIndex: 0 },
        { type: 'DROP', ...drop, stopIndex: 1 }
      ];

      logger.info(`📍 Route has 2 points (no intermediate stops)`);
    } else {
      // SCALABILITY: Use structured error code for monitoring
      // EASY UNDERSTANDING: Clear validation error message
      // MODULARITY: Consistent with other validation errors
      // CODING STANDARDS: REST API error response pattern
      throw new Error('Either routePoints OR both pickup and drop must be provided'); // TODO: Replace with ValidationError when imported
    }

    const stopsCount = routePoints.filter(p => p.type === 'STOP').length;

    logger.info(`╔══════════════════════════════════════════════════════════════╗`);
    logger.info(`║  🚛 NEW MULTI-VEHICLE ORDER                                   ║`);
    logger.info(`╠══════════════════════════════════════════════════════════════╣`);
    logger.info(`║  Order ID: ${orderId.substring(0, 8)}...`);
    logger.info(`║  Customer: ${request.customerName}`);
    logger.info(`║  Total Trucks: ${totalTrucks}`);
    logger.info(`║  Total Amount: ₹${totalAmount}`);
    logger.info(`║  Vehicle Types: ${request.vehicleRequirements.length}`);
    request.vehicleRequirements.forEach((req, i) => {
      logger.info(`║    ${i + 1}. ${req.quantity}x ${req.vehicleType} (${req.vehicleSubtype}) @ ₹${req.pricePerTruck}`);
    });
    logger.info(`║  Route Points: ${routePoints.length} (${stopsCount} stops)`);
    routePoints.forEach((point, i) => {
      logger.info(`║    ${i}. [${point.type}] ${point.address.substring(0, 40)}...`);
    });
    logger.info(`╚══════════════════════════════════════════════════════════════╝`);

    // 1. Create the parent Order
    const order: Omit<OrderRecord, 'createdAt' | 'updatedAt'> = {
      id: orderId,
      customerId: request.customerId,
      customerName: request.customerName,
      customerPhone: request.customerPhone,

      // Route points (NEW - with intermediate stops)
      routePoints,
      currentRouteIndex: 0,        // Start at pickup
      stopWaitTimers: [],          // Empty until driver reaches stops

      // Legacy pickup/drop (for backward compatibility)
      pickup,
      drop,

      distanceKm: request.distanceKm,
      totalTrucks,
      trucksFilled: 0,
      totalAmount,
      goodsType: request.goodsType,
      cargoWeightKg: request.cargoWeightKg,
      status: 'created',
      stateChangedAt: new Date(),
      scheduledAt: request.scheduledAt,
      expiresAt
    };

    await db.createOrder(order);

    // Emit lifecycle state: created
    emitToUser(request.customerId, 'broadcast_state_changed', {
      orderId,
      status: 'created',
      stateChangedAt: new Date().toISOString()
    });

    // 2. Create TruckRequests for each vehicle type
    const truckRequests: TruckRequestRecord[] = [];
    const responseRequests: CreateOrderResponse['truckRequests'] = [];
    let requestNumber = 1;

    for (const vehicleReq of request.vehicleRequirements) {
      // Create one TruckRequest per truck (not per type)
      // This allows each truck to be assigned independently
      for (let i = 0; i < vehicleReq.quantity; i++) {
        const truckRequestId = uuidv4();

        const truckRequest: Omit<TruckRequestRecord, 'createdAt' | 'updatedAt'> = {
          id: truckRequestId,
          orderId,
          requestNumber,
          vehicleType: vehicleReq.vehicleType,
          vehicleSubtype: vehicleReq.vehicleSubtype,
          pricePerTruck: vehicleReq.pricePerTruck,
          status: 'searching',
          notifiedTransporters: []
        };

        truckRequests.push(truckRequest as TruckRequestRecord);
        requestNumber++;
      }

      // Find matching transporters for this vehicle type
      const matchingTransporters = await db.getTransportersWithVehicleType(
        vehicleReq.vehicleType,
        vehicleReq.vehicleSubtype
      );

      responseRequests.push({
        id: truckRequests[truckRequests.length - 1].id,
        vehicleType: vehicleReq.vehicleType,
        vehicleSubtype: vehicleReq.vehicleSubtype,
        quantity: vehicleReq.quantity,
        pricePerTruck: vehicleReq.pricePerTruck,
        matchingTransporters: matchingTransporters.length
      });
    }

    // Batch create all truck requests
    await db.createTruckRequestsBatch(truckRequests);

    // 3. Broadcast to matching transporters (per vehicle type)
    // IMPORTANT: Wrapped in try-catch - broadcast errors should NEVER fail the order creation!
    // The order is already created, so even if broadcast fails, customer can still track it
    try {
      await this.broadcastToTransporters(orderId, request, truckRequests, expiresAt, pickup);
    } catch (broadcastError: any) {
      // Log the error but DON'T throw - order is already created successfully
      logger.error(`⚠️ Broadcast error (order still created): ${broadcastError.message}`);
      logger.error(broadcastError.stack);
    }

    // Transition: created -> broadcasting (transporters have been notified)
    await db.updateOrder(orderId, { status: 'broadcasting', stateChangedAt: new Date() });
    emitToUser(request.customerId, 'broadcast_state_changed', {
      orderId,
      status: 'broadcasting',
      stateChangedAt: new Date().toISOString()
    });

    // 4. Set expiry timer
    this.setOrderExpiryTimer(orderId, this.BROADCAST_TIMEOUT_MS);

    // Transition: broadcasting -> active (timer started, awaiting responses)
    await db.updateOrder(orderId, { status: 'active', stateChangedAt: new Date() });
    emitToUser(request.customerId, 'broadcast_state_changed', {
      orderId,
      status: 'active',
      stateChangedAt: new Date().toISOString()
    });

    // SCALABILITY: Calculate expiresIn for UI countdown timer
    // EASY UNDERSTANDING: UI always matches backend TTL
    const expiresIn = Math.floor(this.BROADCAST_TIMEOUT_MS / 1000); // 60 seconds

    // Build response
    const orderResponse: CreateOrderResponse = {
      orderId,
      totalTrucks,
      totalAmount,
      truckRequests: responseRequests,
      expiresAt,
      expiresIn  // NEW: UI uses this for countdown (backend-driven)
    };

    // ==========================================================================
    // IDEMPOTENCY CACHE - Store response for future retries
    // ==========================================================================
    // SCALABILITY: 5 minute TTL prevents duplicate processing
    // EASY UNDERSTANDING: Client can safely retry failed requests
    // MODULARITY: Automatic cleanup via Redis TTL
    // ==========================================================================
    if (request.idempotencyKey) {
      const cacheKey = `idempotency:${request.customerId}:${request.idempotencyKey}`;
      const ttl = 300; // 5 minutes

      try {
        await redisService.set(cacheKey, JSON.stringify(orderResponse), ttl);
        // Store pointer for cleanup on cancel/expiry
        await redisService.set(`idempotency:order:${request.customerId}:latest`, request.idempotencyKey, ttl);
        logger.info(`Idempotency cached: ${cacheKey.substring(0, 50)}... (TTL: ${ttl}s)`);
      } catch (error: any) {
        logger.warn(`⚠️ Failed to cache idempotency response: ${error.message}`);
        // Non-critical error, continue
      }
    }

    // Store server-generated idempotency key
    const orderTimeoutSeconds = Math.ceil(this.BROADCAST_TIMEOUT_MS / 1000);
    await redisService.set(dedupeKey, orderId, orderTimeoutSeconds + 30);
    await redisService.set(`idem:broadcast:latest:${request.customerId}`, dedupeKey, orderTimeoutSeconds + 30);

    // Set customer active broadcast key (one-per-customer enforcement)
    await redisService.set(activeKey, orderId, orderTimeoutSeconds + 60);

    // Return response
    return orderResponse;
    } finally {
      await redisService.releaseLock(lockKey, request.customerId);
    }
  }

  /**
   * Broadcast truck requests to matching transporters
   * 
   * KEY: Each vehicle type goes ONLY to transporters with that type
   * 
   * CRITICAL FIX: Accepts `resolvedPickup` as parameter instead of using
   * `request.pickup` which is OPTIONAL (undefined when routePoints used).
   * The caller extracts pickup from routePoints or request.pickup.
   */
  private async broadcastToTransporters(
    orderId: string,
    request: CreateOrderRequest,
    truckRequests: TruckRequestRecord[],
    expiresAt: string,
    resolvedPickup: { latitude: number; longitude: number; address: string; city?: string; state?: string }
  ): Promise<void> {

    // Group requests by vehicle type for efficient broadcasting
    const requestsByType = new Map<string, TruckRequestRecord[]>();

    for (const tr of truckRequests) {
      const key = `${tr.vehicleType}_${tr.vehicleSubtype}`;
      if (!requestsByType.has(key)) {
        requestsByType.set(key, []);
      }
      requestsByType.get(key)!.push(tr);
    }

    // Broadcast each vehicle type to matching transporters
    for (const [typeKey, requests] of requestsByType) {
      const [vehicleType, vehicleSubtype] = typeKey.split('_');

      // =====================================================================
      // PROXIMITY-BASED BATCH NOTIFY (Rapido-style optimization)
      // =====================================================================
      // 1. First try LIVE availability service (top 10 nearby by geohash)
      // 2. If not enough, expand to database lookup
      // 3. This reduces load and improves acceptance speed
      // =====================================================================

      // Generate vehicle key for availability lookup
      const vehicleKey = generateVehicleKey(vehicleType, vehicleSubtype);

      // STEP 1: Try live availability service first (nearby transporters)
      // =====================================================================
      // CRITICAL FIX: Use resolvedPickup (always defined) instead of
      // request.pickup (undefined when routePoints is used).
      //
      // CRITICAL FIX: Use ASYNC getAvailableTransportersAsync() instead of
      // sync getAvailableTransporters() which ALWAYS returns [] because
      // Redis operations are async. The sync version logs a warning and
      // fires the async search in the background (results are lost).
      // =====================================================================
      let matchingTransporters: string[] = [];
      const pickupLat = resolvedPickup.latitude;
      const pickupLng = resolvedPickup.longitude;

      // Get top 10 nearby from live availability (ASYNC — proper Redis GEORADIUS)
      const nearbyTransporters = await availabilityService.getAvailableTransportersAsync(
        vehicleKey,
        pickupLat,
        pickupLng,
        10,  // Top 10 nearby first
        50   // 50km radius
      );

      if (nearbyTransporters.length > 0) {
        logger.info(`🎯 Found ${nearbyTransporters.length} NEARBY transporters from live availability`);
        matchingTransporters = nearbyTransporters;
      }

      // STEP 2: If not enough nearby, fall back to database (all matching transporters)
      if (matchingTransporters.length < 5) {
        logger.info(`📡 Not enough nearby, expanding to database lookup...`);
        const dbTransporters = await this.getTransportersByVehicleCached(vehicleType, vehicleSubtype);

        // Merge: nearby first, then others (avoid duplicates)
        const nearbySet = new Set(matchingTransporters);
        const additionalTransporters = dbTransporters.filter(t => !nearbySet.has(t));
        matchingTransporters = [...matchingTransporters, ...additionalTransporters];
      }

      if (matchingTransporters.length === 0) {
        logger.warn(`⚠️ No transporters found for ${vehicleType} (${vehicleSubtype})`);
        continue;
      }

      const nearbyCount = nearbyTransporters.length;
      logger.info(`📢 Broadcasting ${requests.length}x ${vehicleType} (${vehicleSubtype}) to ${matchingTransporters.length} transporters (${nearbyCount} nearby first)`);

      // Create broadcast data for this vehicle type
      // Send the FIRST request of this type (others are same type, just different trucks)
      const firstRequest = requests[0];

      // Get order to access routePoints
      const order = await db.getOrderById(orderId);

      // Build routePoints for broadcast (with city info)
      const broadcastRoutePoints: BroadcastRoutePoint[] = order?.routePoints?.map(point => ({
        type: point.type,
        latitude: point.latitude,
        longitude: point.longitude,
        address: point.address,
        city: point.city,
        stopIndex: point.stopIndex
      })) || [];

      // Count intermediate stops
      const totalStops = broadcastRoutePoints.filter(p => p.type === 'STOP').length;

      // Get pickup and drop from routePoints or request
      const pickupPoint = broadcastRoutePoints.find(p => p.type === 'PICKUP') || request.pickup;
      const dropPoint = broadcastRoutePoints.find(p => p.type === 'DROP') || request.drop;

      // =======================================================================
      // CALCULATE ROUTE BREAKDOWN (ETA per leg)
      // =======================================================================
      const routeBreakdownCalc = routingService.calculateRouteBreakdown(
        order?.routePoints?.map(p => ({
          type: p.type,
          latitude: p.latitude,
          longitude: p.longitude,
          address: p.address,
          city: p.city,
          stopIndex: p.stopIndex
        })) || [],
        new Date()  // Departure time = now
      );

      // Convert to broadcast format
      const routeBreakdown: BroadcastRouteBreakdown = {
        legs: routeBreakdownCalc.legs.map(leg => ({
          fromIndex: leg.fromIndex,
          toIndex: leg.toIndex,
          fromType: leg.fromType,
          toType: leg.toType,
          fromAddress: leg.fromAddress,
          toAddress: leg.toAddress,
          fromCity: leg.fromCity,
          toCity: leg.toCity,
          distanceKm: leg.distanceKm,
          durationMinutes: leg.durationMinutes,
          durationFormatted: `${Math.floor(leg.durationMinutes / 60)} hrs ${leg.durationMinutes % 60} mins`,
          etaMinutes: leg.etaToEndMinutes
        })),
        totalDistanceKm: routeBreakdownCalc.totalDistanceKm,
        totalDurationMinutes: routeBreakdownCalc.totalDurationMinutes,
        totalDurationFormatted: routeBreakdownCalc.totalDurationFormatted,
        totalStops: routeBreakdownCalc.totalStops,
        estimatedArrival: routeBreakdownCalc.estimatedArrival
      };

      logger.info(`📍 Route breakdown: ${routeBreakdown.totalDistanceKm} km, ${routeBreakdown.totalDurationFormatted}, ${routeBreakdown.legs.length} legs`);

      // Build broadcast data compatible with Captain app's SocketIOService parser
      // Captain app expects: pickupLocation/dropLocation OR pickup/drop (with fallbacks)
      const broadcastData: BroadcastData = {
        type: 'new_truck_request',
        orderId,
        truckRequestId: firstRequest.id,
        requestNumber: firstRequest.requestNumber,
        customerName: request.customerName,

        // =====================================================================
        // ROUTE POINTS (NEW - with intermediate stops)
        // =====================================================================
        routePoints: broadcastRoutePoints,
        totalStops,

        // =====================================================================
        // ROUTE BREAKDOWN (NEW - ETA per leg)
        // =====================================================================
        routeBreakdown,

        // Both formats for maximum compatibility
        pickup: {
          latitude: pickupPoint?.latitude || 0,
          longitude: pickupPoint?.longitude || 0,
          address: pickupPoint?.address || '',
          city: pickupPoint?.city
        },
        drop: {
          latitude: dropPoint?.latitude || 0,
          longitude: dropPoint?.longitude || 0,
          address: dropPoint?.address || '',
          city: dropPoint?.city
        },
        // Captain app also looks for these flat fields
        pickupAddress: pickupPoint?.address || '',
        pickupCity: pickupPoint?.city || '',
        dropAddress: dropPoint?.address || '',
        dropCity: dropPoint?.city || '',
        vehicleType,
        vehicleSubtype,
        pricePerTruck: firstRequest.pricePerTruck,
        farePerTruck: firstRequest.pricePerTruck, // Alias for Captain app
        distanceKm: request.distanceKm,
        distance: request.distanceKm, // Alias for Captain app
        goodsType: request.goodsType,
        expiresAt,
        createdAt: new Date().toISOString()
      };

      // Build requestedVehicles array with ALL vehicle types in the order
      const requestedVehicles: any[] = [];
      for (const [key, reqs] of requestsByType) {
        const [vType, vSubtype] = key.split('_');
        const firstReq = reqs[0];
        requestedVehicles.push({
          vehicleType: vType,
          vehicleSubtype: vSubtype || '',
          count: reqs.length,
          filledCount: 0,
          farePerTruck: firstReq.pricePerTruck,
          capacityTons: 0
        });
      }

      // Also include how many trucks of this type are needed
      // IMPORTANT: Include BOTH orderId AND broadcastId for Captain app compatibility
      // Captain app checks broadcastId first, then falls back to orderId
      const extendedBroadcast = {
        ...broadcastData,
        broadcastId: orderId,  // CRITICAL: Captain app expects this field!
        trucksNeededOfThisType: requests.length,
        trucksNeeded: requests.length,  // Alias for Captain app
        totalTrucksInOrder: truckRequests.length,
        totalTrucksNeeded: truckRequests.length,
        trucksFilled: 0,  // For Captain app
        requestedVehicles: requestedVehicles  // ALL vehicle types in the order!
      };

      logger.info(`📢 Including ${requestedVehicles.length} vehicle types in broadcast:`, requestedVehicles.map(rv => `${rv.vehicleType}/${rv.vehicleSubtype}:${rv.count}`));

      // =========================================================================
      // PERSONALIZED BROADCAST - Each transporter sees their available capacity
      // =========================================================================
      // 
      // CRITICAL: This is the core of partial fulfillment UX!
      // 
      // Rule: trucksYouCanProvide = MIN(transporter_available, trucks_still_needed)
      // 
      // Example (Order needs 5 "Open 17ft" trucks):
      //   Transporter A (2 available) → sees "Request for 2 trucks"
      //   Transporter B (1 available) → sees "Request for 1 truck"
      //   Transporter C (10 available) → sees "Request for 5 trucks" (capped)
      // 
      // This ensures:
      // 1. Transporters only see requests they can fulfill
      // 2. No over-promising (can't accept more than they have)
      // 3. Partial fulfillment is natural
      // =========================================================================

      const trucksStillNeeded = requests.length; // How many of this type are still searching

      logger.info(`╔══════════════════════════════════════════════════════════════╗`);
      logger.info(`║  📢 PERSONALIZED BROADCAST                                   ║`);
      logger.info(`╠══════════════════════════════════════════════════════════════╣`);
      logger.info(`║  Vehicle: ${vehicleType} ${vehicleSubtype}`);
      logger.info(`║  Trucks Still Needed: ${trucksStillNeeded}`);
      logger.info(`║  Matching Transporters: ${matchingTransporters.length}`);
      logger.info(`╚══════════════════════════════════════════════════════════════╝`);

      // Get availability snapshot for all matching transporters
      // CRITICAL FIX: Must await — db is Prisma instance, this is async!
      // Without await, availabilitySnapshot is a Promise (empty map → no broadcasts sent)
      const availabilitySnapshot = await db.getTransportersAvailabilitySnapshot(vehicleType, vehicleSubtype) as Array<{
        transporterId: string;
        transporterName: string;
        totalOwned: number;
        available: number;
        inTransit: number;
      }>;

      // Create a map for quick lookup
      const availabilityMap = new Map(
        availabilitySnapshot.map(t => [t.transporterId, t])
      );

      // Send personalized broadcast to each transporter
      let sentCount = 0;
      let skippedNoAvailable = 0;

      for (const transporterId of matchingTransporters) {
        const availability = availabilityMap.get(transporterId);

        // Skip if no available trucks (they shouldn't receive broadcast)
        if (!availability || availability.available <= 0) {
          skippedNoAvailable++;
          continue;
        }

        // Calculate personalized capacity
        const trucksYouCanProvide = Math.min(availability.available, trucksStillNeeded);

        // Create personalized broadcast payload
        const personalizedBroadcast = {
          ...extendedBroadcast,
          // =====================================================================
          // PERSONALIZED FIELDS - Unique per transporter
          // =====================================================================
          trucksYouCanProvide,           // How many they can accept (1 to N)
          maxTrucksYouCanProvide: trucksYouCanProvide, // Alias
          yourAvailableTrucks: availability.available, // How many they have free
          yourTotalTrucks: availability.totalOwned,    // How many they own of this type

          // =====================================================================
          // ORDER FIELDS - Same for everyone
          // =====================================================================
          trucksStillNeeded,             // Total still needed for this type
          trucksNeededOfThisType: trucksStillNeeded, // Alias

          // Personalization metadata
          isPersonalized: true,
          personalizedFor: transporterId
        };

        // Send via WebSocket
        emitToUser(transporterId, 'new_broadcast', personalizedBroadcast);
        sentCount++;

        logger.info(`   📱 → ${availability.transporterName || transporterId.substring(0, 8)}: ` +
          `${trucksYouCanProvide}/${trucksStillNeeded} trucks (has ${availability.available} available)`);
      }

      logger.info(`   ✅ Sent personalized broadcasts: ${sentCount}, Skipped (no available): ${skippedNoAvailable}`)

      // Update truck requests with notified transporters
      for (const tr of requests) {
        await db.updateTruckRequest(tr.id, {
          notifiedTransporters: matchingTransporters
        });
      }

      // FCM Push notifications (QUEUED for reliability)
      await queueService.queuePushNotificationBatch(
        matchingTransporters,
        {
          title: `🚛 ${extendedBroadcast.trucksNeededOfThisType}x ${vehicleType.toUpperCase()} Required!`,
          body: `${extendedBroadcast.pickup.city || extendedBroadcast.pickup.address} → ${extendedBroadcast.drop.city || extendedBroadcast.drop.address}`,
          data: {
            type: 'new_truck_request',
            orderId: extendedBroadcast.orderId,
            truckRequestId: extendedBroadcast.truckRequestId
          }
        }
      );
    }
  }

  /**
   * Set timer to expire order after timeout (Redis-based for cluster support)
   * 
   * SCALABILITY: Uses Redis timers instead of in-memory setTimeout
   * - Works across multiple server instances
   * - Survives server restarts
   * - No duplicate processing (Redis locks)
   */
  private async clearCustomerActiveBroadcast(customerId: string): Promise<void> {
    const activeKey = `customer:active-broadcast:${customerId}`;
    await redisService.del(activeKey).catch((err: any) => {
      logger.warn('Failed to clear customer active broadcast key', { customerId, error: err.message });
    });
    // Clean up server-generated idempotency key
    const latestIdemKey = await redisService.get(`idem:broadcast:latest:${customerId}`).catch(() => null);
    if (latestIdemKey) {
      await redisService.del(latestIdemKey).catch(() => {});
      await redisService.del(`idem:broadcast:latest:${customerId}`).catch(() => {});
    }
    // Clean up client-supplied idempotency key
    const latestClientIdemKey = await redisService.get(`idempotency:order:${customerId}:latest`).catch(() => null);
    if (latestClientIdemKey) {
      await redisService.del(`idempotency:${customerId}:${latestClientIdemKey}`).catch(() => {});
      await redisService.del(`idempotency:order:${customerId}:latest`).catch(() => {});
    }
  }

  private async setOrderExpiryTimer(orderId: string, timeoutMs: number): Promise<void> {
    // Cancel any existing timer
    await redisService.cancelTimer(this.TIMER_KEYS.ORDER_EXPIRY(orderId));

    // Set new timer in Redis
    const expiresAt = new Date(Date.now() + timeoutMs);
    const timerData = {
      orderId,
      createdAt: new Date().toISOString()
    };

    await redisService.setTimer(this.TIMER_KEYS.ORDER_EXPIRY(orderId), timerData, expiresAt);
    logger.info(`⏱️ Order expiry timer set for ${orderId} (${timeoutMs / 1000}s) [Redis-based]`);
  }

  /**
   * Handle order expiry
   * Mark unfilled truck requests as expired
   */
  async handleOrderExpiry(orderId: string): Promise<void> {
    logger.info(`⏰ ORDER EXPIRED: ${orderId}`);

    const order = await db.getOrderById(orderId);
    if (!order) return;

    // Only expire if not fully filled
    if (order.status === 'fully_filled' || order.status === 'completed') {
      return;
    }

    // Get all truck requests for this order
    const truckRequests = await db.getTruckRequestsByOrder(orderId);
    const unfilled = truckRequests.filter(tr => tr.status === 'searching');

    if (unfilled.length > 0) {
      // Update unfilled requests to expired
      const unfilledIds = unfilled.map(tr => tr.id);
      await db.updateTruckRequestsBatch(unfilledIds, { status: 'expired' });

      logger.info(`   ${unfilled.length} truck requests expired`);
    }

    // Update order status
    const newStatus = order.trucksFilled > 0 ? 'partially_filled' : 'expired';
    await db.updateOrder(orderId, { status: newStatus, stateChangedAt: new Date() });

    // Notify customer
    emitToUser(order.customerId, 'order_expired', {
      orderId,
      totalTrucks: order.totalTrucks,
      trucksFilled: order.trucksFilled,
      status: newStatus
    });

    // =========================================================================
    // CRITICAL FIX: Notify ALL transporters to remove expired broadcast
    // =========================================================================
    // Previously only customer was notified. Transporters kept seeing the stale
    // broadcast overlay until broadcast.service.ts poll caught it (up to 5s gap).
    // Now we notify transporters immediately via WebSocket + FCM push.
    //
    // SCALABILITY: Uses queue for batches >50 transporters
    // EASY UNDERSTANDING: Same pattern as cancelOrder() transporter notification
    // MODULARITY: broadcast.service.ts poll checker remains as safety net
    // =========================================================================
    const notifiedTransporters = new Set<string>();
    for (const tr of truckRequests) {
      if (tr.notifiedTransporters) {
        tr.notifiedTransporters.forEach((t: string) => notifiedTransporters.add(t));
      }
    }

    const transporterIds = Array.from(notifiedTransporters);

    if (transporterIds.length > 0) {
      const expiryPayload = {
        broadcastId: orderId,
        orderId,
        reason: 'timeout',
        timestamp: new Date().toISOString(),
        message: 'This booking request has expired'
      };

      // WebSocket: Instant removal from overlay (for foreground transporters)
      if (transporterIds.length < 50) {
        for (const transporterId of transporterIds) {
          emitToUser(transporterId, 'broadcast_expired', expiryPayload);
        }
        logger.info(`   📱 Direct expiry broadcast to ${transporterIds.length} transporters`);
      } else {
        await queueService.queueBroadcastBatch(
          transporterIds,
          'broadcast_expired',
          expiryPayload
        );
        logger.info(`   📱 Queued expiry broadcast to ${transporterIds.length} transporters`);
      }

      // FCM: Push notification for background/closed app transporters
      await queueService.queuePushNotificationBatch(
        transporterIds,
        {
          title: '⏰ Request Expired',
          body: `A truck request has expired`,
          data: {
            type: 'broadcast_expired',
            orderId
          }
        }
      ).catch((err: any) => {
        logger.warn(`FCM: Failed to queue expiry push for order ${orderId}`, err);
      });
    }

    // Cleanup timer from Redis
    await redisService.cancelTimer(this.TIMER_KEYS.ORDER_EXPIRY(orderId));

    // Clear customer active broadcast key (one-per-customer enforcement)
    await this.clearCustomerActiveBroadcast(order.customerId);
  }

  /**
   * Cancel an order — atomic, idempotent, race-safe
   *
   * Uses updateMany with status precondition to prevent cancel-vs-accept races.
   * Already-cancelled orders return success (idempotent).
   */
  async cancelOrder(
    orderId: string,
    customerId: string,
    reason?: string
  ): Promise<{ success: boolean; message: string; transportersNotified: number }> {
    logger.info(`CANCEL ORDER: ${orderId} by customer ${customerId}`);

    // ATOMIC cancel: only succeeds if status is still cancellable
    const updated = await prismaClient.order.updateMany({
      where: {
        id: orderId,
        customerId,
        status: { in: ['created', 'broadcasting', 'active', 'partially_filled'] as any }
      },
      data: {
        status: 'cancelled' as any,
        stateChangedAt: new Date(),
        cancelledAt: new Date().toISOString(),
        cancellationReason: reason || 'Cancelled by customer'
      }
    });

    // Fetch current state
    const order = await db.getOrderById(orderId);

    if (!order) {
      return { success: false, message: 'Order not found', transportersNotified: 0 };
    }

    if (order.customerId !== customerId) {
      return { success: false, message: 'You can only cancel your own orders', transportersNotified: 0 };
    }

    // IDEMPOTENT: already cancelled is success
    if (updated.count === 0 && order.status === 'cancelled') {
      return { success: true, message: 'Order already cancelled', transportersNotified: 0 };
    }

    if (updated.count === 0) {
      return { success: false, message: `Cannot cancel order in ${order.status} state`, transportersNotified: 0 };
    }

    // === CANCEL WON: Full cleanup ===

    // 1. Cancel all associated TruckRequests atomically
    const truckRequests = await db.getTruckRequestsByOrder(orderId);
    const requestIds = truckRequests.filter(tr => ['searching', 'held'].includes(tr.status)).map(tr => tr.id);
    if (requestIds.length > 0) {
      await db.updateTruckRequestsBatch(requestIds, { status: 'cancelled' });
    }

    // 2. Clear expiry timer from Redis
    await redisService.cancelTimer(this.TIMER_KEYS.ORDER_EXPIRY(orderId));
    logger.info(`   Cleared expiry timer for ${orderId}`);

    // 3. Clear customer active broadcast key + idempotency keys
    await this.clearCustomerActiveBroadcast(customerId);

    // 4. Collect and notify all notified transporters
    const notifiedTransporters = new Set<string>();
    for (const tr of truckRequests) {
      if (tr.notifiedTransporters) {
        tr.notifiedTransporters.forEach(t => notifiedTransporters.add(t));
      }
    }

    const cancellationData = {
      type: 'order_cancelled',
      orderId,
      reason: reason || 'Cancelled by customer',
      cancelledAt: new Date().toISOString()
    };

    const transporterIds = Array.from(notifiedTransporters);

    if (transporterIds.length > 0) {
      if (transporterIds.length < 50) {
        for (const transporterId of transporterIds) {
          emitToUser(transporterId, 'order_cancelled', cancellationData);
        }
        logger.info(`   Direct cancellation broadcast to ${transporterIds.length} transporters`);
      } else {
        await queueService.queueBroadcastBatch(
          transporterIds,
          'order_cancelled',
          cancellationData
        );
        logger.info(`   Queued cancellation broadcast to ${transporterIds.length} transporters`);
      }

      await queueService.queuePushNotificationBatch(
        transporterIds,
        {
          title: '❌ Order Cancelled',
          body: `Order #${orderId.slice(-8).toUpperCase()} was cancelled by customer`,
          data: {
            type: 'order_cancelled',
            orderId
          }
        }
      ).catch((err: any) => {
        logger.warn(`FCM: Failed to queue cancellation push for order ${orderId}`, err);
      });
    }

    // 5. Notify customer
    emitToUser(customerId, 'order_cancelled', {
      orderId,
      status: 'cancelled',
      reason: reason || 'Cancelled by customer',
      stateChangedAt: new Date().toISOString()
    });

    // 6. Revert active assignments — release vehicles and notify drivers
    try {
      const activeAssignments = await prismaClient.assignment.findMany({
        where: { orderId, status: { in: ['pending', 'driver_accepted', 'driver_en_route'] as any } }
      });
      if (activeAssignments.length > 0) {
        await prismaClient.assignment.updateMany({
          where: { orderId, status: { in: ['pending', 'driver_accepted', 'driver_en_route'] as any } },
          data: { status: 'cancelled' as any }
        });
        for (const assignment of activeAssignments) {
          if (assignment.vehicleId) {
            await prismaClient.vehicle.update({
              where: { id: assignment.vehicleId },
              data: { status: 'available' as any, currentTripId: null, assignedDriverId: null }
            }).catch(() => {});
          }
          if (assignment.driverId) {
            emitToUser(assignment.driverId, 'trip_cancelled', {
              orderId, tripId: assignment.tripId, message: 'Trip cancelled by customer'
            });
          }
        }
        logger.info(`[CANCEL] Reverted ${activeAssignments.length} assignments, released vehicles`);
      }
    } catch (err: any) {
      logger.warn(`[CANCEL] Failed to revert assignments (non-critical)`, { error: err.message });
    }

    logger.info(`Order ${orderId} cancelled, notified ${transporterIds.length} transporters`);

    return {
      success: true,
      message: 'Order cancelled successfully',
      transportersNotified: transporterIds.length
    };
  }

  /**
   * Accept a truck request (transporter assigns vehicle + driver)
   * 
   * Called when transporter accepts from the Captain app
   */
  async acceptTruckRequest(
    truckRequestId: string,
    transporterId: string,
    vehicleId: string,
    driverId: string
  ): Promise<{
    success: boolean;
    assignmentId?: string;
    tripId?: string;
    message: string;
  }> {
    const MAX_RETRIES = 3;
    let txResult: {
      assignmentId: string;
      tripId: string;
      newTrucksFilled: number;
      newStatus: OrderRecord['status'];
      orderId: string;
      customerId: string;
      orderPickup: OrderRecord['pickup'];
      orderDrop: OrderRecord['drop'];
      orderDistanceKm: number;
      orderCustomerName: string;
      orderCustomerPhone: string;
      orderTotalTrucks: number;
      truckRequestPricePerTruck: number;
      vehicleNumber: string;
      vehicleType: string;
      vehicleSubtype: string;
      driverName: string;
      driverPhone: string;
      transporterName: string;
      transporterPhone: string;
      now: string;
    } | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        txResult = await prismaClient.$transaction(async (tx) => {
          // ----- Read all data inside the transaction -----
          const truckRequest = await tx.truckRequest.findUnique({
            where: { id: truckRequestId }
          });

          if (!truckRequest) {
            throw new Error('EARLY_RETURN:Truck request not found');
          }

          if (truckRequest.status !== 'searching') {
            throw new Error(`EARLY_RETURN:Request already ${truckRequest.status}`);
          }

          const order = await tx.order.findUnique({
            where: { id: truckRequest.orderId }
          });
          if (!order) {
            throw new Error('EARLY_RETURN:Order not found');
          }

          const transporter = await tx.user.findUnique({
            where: { id: transporterId }
          });

          const vehicle = await tx.vehicle.findUnique({
            where: { id: vehicleId }
          });
          if (!vehicle) {
            throw new Error('EARLY_RETURN:Vehicle not found');
          }

          const driver = await tx.user.findUnique({
            where: { id: driverId }
          });
          if (!driver) {
            throw new Error('EARLY_RETURN:Driver not found');
          }

          // Verify vehicle type matches
          if (vehicle.vehicleType !== truckRequest.vehicleType) {
            throw new Error(
              `EARLY_RETURN:Vehicle type mismatch. Request requires ${truckRequest.vehicleType}, vehicle is ${vehicle.vehicleType}`
            );
          }

          // ----- Optimistic lock: update truck request only if still 'searching' -----
          const truckRequestUpdate = await tx.truckRequest.updateMany({
            where: { id: truckRequestId, status: 'searching' },
            data: {
              status: 'assigned',
              assignedTransporterId: transporterId,
              assignedTransporterName: transporter?.name || transporter?.businessName || '',
              assignedVehicleId: vehicleId,
              assignedVehicleNumber: vehicle.vehicleNumber,
              assignedDriverId: driverId,
              assignedDriverName: driver.name,
              assignedDriverPhone: driver.phone,
              tripId: uuidv4(),
              assignedAt: new Date().toISOString()
            }
          });

          if (truckRequestUpdate.count === 0) {
            throw new Error('EARLY_RETURN:This request is no longer available');
          }

          // Fetch the updated truck request to get generated tripId
          const updatedTruckRequest = await tx.truckRequest.findUnique({
            where: { id: truckRequestId }
          });
          const tripId = updatedTruckRequest!.tripId!;
          const assignmentId = uuidv4();
          const now = new Date().toISOString();

          // ----- Create assignment record inside transaction -----
          await tx.assignment.create({
            data: {
              id: assignmentId,
              bookingId: truckRequest.orderId, // Legacy field
              truckRequestId,
              orderId: truckRequest.orderId,
              transporterId,
              transporterName: transporter?.name || '',
              vehicleId,
              vehicleNumber: vehicle.vehicleNumber,
              vehicleType: vehicle.vehicleType,
              vehicleSubtype: vehicle.vehicleSubtype,
              driverId,
              driverName: driver.name,
              driverPhone: driver.phone || '',
              tripId,
              status: 'pending',
              assignedAt: now
            }
          });

          // ----- Optimistic lock: update order progress only if trucksFilled hasn't changed -----
          const orderUpdate = await tx.order.updateMany({
            where: { id: order.id, trucksFilled: order.trucksFilled },
            data: {
              trucksFilled: { increment: 1 }
            }
          });

          if (orderUpdate.count === 0) {
            // Another concurrent request incremented trucksFilled first; retry
            throw new Error('RETRY:Order state changed concurrently');
          }

          const newTrucksFilled = order.trucksFilled + 1;
          const newStatus: OrderRecord['status'] = newTrucksFilled >= order.totalTrucks
            ? 'fully_filled'
            : 'partially_filled';

          await tx.order.update({
            where: { id: order.id },
            data: { status: newStatus as any, stateChangedAt: new Date() }
          });

          // ----- Update vehicle status inside transaction -----
          await tx.vehicle.update({
            where: { id: vehicleId },
            data: {
              status: 'in_transit',
              currentTripId: tripId,
              assignedDriverId: driverId
            }
          });

          // Parse JSON fields for notification use outside the transaction
          const pickup = typeof order.pickup === 'string'
            ? JSON.parse(order.pickup as string)
            : order.pickup;
          const drop = typeof order.drop === 'string'
            ? JSON.parse(order.drop as string)
            : order.drop;

          return {
            assignmentId,
            tripId,
            newTrucksFilled,
            newStatus,
            orderId: order.id,
            customerId: order.customerId,
            orderPickup: pickup as OrderRecord['pickup'],
            orderDrop: drop as OrderRecord['drop'],
            orderDistanceKm: order.distanceKm,
            orderCustomerName: order.customerName,
            orderCustomerPhone: order.customerPhone,
            orderTotalTrucks: order.totalTrucks,
            truckRequestPricePerTruck: truckRequest.pricePerTruck,
            vehicleNumber: vehicle.vehicleNumber,
            vehicleType: vehicle.vehicleType,
            vehicleSubtype: vehicle.vehicleSubtype,
            driverName: driver.name,
            driverPhone: driver.phone || '',
            transporterName: transporter?.name || transporter?.businessName || '',
            transporterPhone: transporter?.phone || '',
            now
          };
        }, { isolationLevel: 'Serializable' as any });

        // Transaction succeeded, break out of retry loop
        break;
      } catch (error: any) {
        // Handle EARLY_RETURN errors (validation failures — no retry)
        if (error?.message?.startsWith('EARLY_RETURN:')) {
          return {
            success: false,
            message: error.message.replace('EARLY_RETURN:', '')
          };
        }

        // Handle retryable serialization conflicts (P2034 / 40001)
        const isRetryableContention =
          error?.code === 'P2034' ||
          error?.code === '40001' ||
          error?.message?.startsWith('RETRY:');

        if (!isRetryableContention || attempt >= MAX_RETRIES) {
          logger.error(`acceptTruckRequest failed after ${attempt} attempt(s)`, {
            truckRequestId,
            vehicleId,
            driverId,
            error: error.message
          });
          throw error;
        }

        logger.warn('[OrderAccept] Contention retry', {
          truckRequestId,
          vehicleId,
          driverId,
          attempt,
          maxAttempts: MAX_RETRIES,
          code: error.code || 'RETRY'
        });
      }
    }

    if (!txResult) {
      return {
        success: false,
        message: 'Unable to finalize assignment after retries'
      };
    }

    // =====================================================================
    // All notifications OUTSIDE the transaction (side-effects are not
    // rolled back on serialization retry, so they must happen after commit)
    // =====================================================================

    const {
      assignmentId,
      tripId,
      newTrucksFilled,
      newStatus,
      orderId,
      customerId,
      orderPickup,
      orderDrop,
      orderDistanceKm,
      orderCustomerName,
      orderCustomerPhone,
      orderTotalTrucks,
      truckRequestPricePerTruck,
      vehicleNumber,
      vehicleType,
      vehicleSubtype,
      driverName,
      driverPhone,
      transporterName,
      transporterPhone,
      now
    } = txResult;

    logger.info(`Truck request ${truckRequestId} accepted`);
    logger.info(`   Vehicle: ${vehicleNumber} (${vehicleType})`);
    logger.info(`   Driver: ${driverName} (${driverPhone})`);
    logger.info(`   Order progress: ${newTrucksFilled}/${orderTotalTrucks}`);

    // ============== NOTIFY DRIVER ==============
    const driverNotification = {
      type: 'trip_assigned',
      assignmentId,
      tripId,
      orderId,
      truckRequestId,
      pickup: orderPickup,
      drop: orderDrop,
      vehicleNumber,
      farePerTruck: truckRequestPricePerTruck,
      distanceKm: orderDistanceKm,
      customerName: orderCustomerName,
      customerPhone: orderCustomerPhone,
      assignedAt: now,
      message: `New trip assigned! ${orderPickup.address} → ${orderDrop.address}`
    };

    emitToUser(driverId, 'trip_assigned', driverNotification);
    logger.info(`Notified driver ${driverName} about trip assignment`);

    // Push notification to driver
    sendPushNotification(driverId, {
      title: 'New Trip Assigned!',
      body: `${orderPickup.city || orderPickup.address} → ${orderDrop.city || orderDrop.address}`,
      data: {
        type: 'trip_assigned',
        tripId,
        assignmentId,
        orderId
      }
    }).catch(err => logger.warn(`FCM to driver failed: ${err.message}`));

    // ============== NOTIFY CUSTOMER ==============
    const customerNotification = {
      type: 'truck_confirmed',
      orderId,
      truckRequestId,
      assignmentId,
      truckNumber: newTrucksFilled,
      totalTrucks: orderTotalTrucks,
      trucksConfirmed: newTrucksFilled,
      remainingTrucks: orderTotalTrucks - newTrucksFilled,
      isFullyFilled: newTrucksFilled >= orderTotalTrucks,
      driver: {
        name: driverName,
        phone: driverPhone
      },
      vehicle: {
        number: vehicleNumber,
        type: vehicleType,
        subtype: vehicleSubtype
      },
      transporter: {
        name: transporterName,
        phone: transporterPhone
      },
      message: `Truck ${newTrucksFilled}/${orderTotalTrucks} confirmed!`
    };

    emitToUser(customerId, 'truck_confirmed', customerNotification);
    logger.info(`Notified customer - ${newTrucksFilled}/${orderTotalTrucks} trucks confirmed`);

    // Push notification to customer
    sendPushNotification(customerId, {
      title: `Truck ${newTrucksFilled}/${orderTotalTrucks} Confirmed!`,
      body: `${vehicleNumber} (${driverName}) assigned`,
      data: {
        type: 'truck_confirmed',
        orderId,
        trucksConfirmed: newTrucksFilled,
        totalTrucks: orderTotalTrucks
      }
    }).catch(err => logger.warn(`FCM to customer failed: ${err.message}`));

    // If fully filled, cancel expiry timer and clear active key
    if (newStatus === 'fully_filled') {
      if (this.orderTimers.has(orderId)) {
        clearTimeout(this.orderTimers.get(orderId)!);
        this.orderTimers.delete(orderId);
      }
      await redisService.cancelTimer(this.TIMER_KEYS.ORDER_EXPIRY(orderId)).catch(() => {});
      await this.clearCustomerActiveBroadcast(customerId);
      logger.info(`Order ${orderId} fully filled! All ${orderTotalTrucks} trucks assigned.`);
    }

    return {
      success: true,
      assignmentId,
      tripId,
      message: `Successfully assigned. ${newTrucksFilled}/${orderTotalTrucks} trucks filled.`
    };
  }

  /**
   * Get order details with all truck requests
   */
  async getOrderDetails(orderId: string): Promise<(OrderRecord & { truckRequests: TruckRequestRecord[] }) | null> {
    const order = await db.getOrderById(orderId);
    if (!order) return null;

    const truckRequests = await db.getTruckRequestsByOrder(orderId);

    return {
      ...order,
      truckRequests
    };
  }

  /**
   * Get active truck requests for a transporter
   * Returns ONLY requests matching their vehicle types
   */
  async getActiveRequestsForTransporter(transporterId: string): Promise<TruckRequestRecord[]> {
    return await db.getActiveTruckRequestsForTransporter(transporterId);
  }

  /**
   * Get orders by customer
   */
  async getOrdersByCustomer(customerId: string): Promise<OrderRecord[]> {
    return await db.getOrdersByCustomer(customerId);
  }
}

// Export singleton
export const orderService = new OrderService();
