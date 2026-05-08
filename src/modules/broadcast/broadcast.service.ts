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
import { Prisma, AssignmentStatus } from '@prisma/client';
import { db, BookingRecord, AssignmentRecord } from '../../shared/database/db';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, emitToUsers, emitToRoom, emitToAllTransporters, emitToAll, SocketEvent } from '../../shared/services/socket.service';
import { sendPushNotification } from '../../shared/services/fcm.service';
import { redisService } from '../../shared/services/redis.service';
import { prismaClient, withDbTimeout, VehicleStatus } from '../../shared/database/prisma.service';
import { safeJsonParse } from '../../shared/utils/safe-json.utils';

// =============================================================================
// BROADCAST EXPIRY EVENTS - For real-time timeout handling
// =============================================================================
// When a broadcast expires, we MUST notify ALL transporters immediately
// so they can remove it from their overlay/list. This prevents confusion
// where one transporter sees an expired broadcast while another doesn't.
// =============================================================================

/**
 * Socket events for broadcast lifecycle
 * Fix E1: BroadcastEvents now references SocketEvent where string values match.
 * All string values remain IDENTICAL to before -- only the source of truth changes.
 */
export const BroadcastEvents = {
  BROADCAST_EXPIRED: SocketEvent.BROADCAST_EXPIRED,             // 'broadcast_expired'
  BROADCAST_FULLY_FILLED: SocketEvent.BOOKING_FULLY_FILLED,     // 'booking_fully_filled'
  BROADCAST_CANCELLED: SocketEvent.BROADCAST_CANCELLED,         // 'order_cancelled'
  TRUCKS_REMAINING_UPDATE: SocketEvent.TRUCKS_REMAINING_UPDATE, // 'trucks_remaining_update'
  NEW_BROADCAST: SocketEvent.NEW_BROADCAST,                     // 'new_broadcast'
};

interface GetActiveBroadcastsParams {
  actorId: string;
  vehicleType?: string;
  maxDistance?: number;
  limit?: number;      // F-M6 FIX: Pagination support (0 = all, backward compat)
  offset?: number;     // F-M6 FIX: Pagination offset
}

interface DeclineBroadcastParams {
  actorId: string;
  reason: string;
  notes?: string;
}

interface GetHistoryParams {
  actorId: string;
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
   * Get active broadcasts for compatibility / migration path.
   * 
   * Returns BOTH:
   * 1. Legacy Bookings (single vehicle type)
   * 2. New Orders with multiple vehicle types (requestedVehicles array)
   * 
   * NOTE:
   * Canonical transporter feed should prefer /bookings/requests/active.
   * This compatibility service remains for fallback and older clients.
   */
  async getActiveBroadcasts(params: GetActiveBroadcastsParams) {
    const { actorId, vehicleType } = params;
    logger.info('[BroadcastCompat] Resolving active feed via legacy broadcast service', {
      route_alias_used: true,
      actorId
    });

    // Resolve transporter — actorId could be a driver or transporter
    const user = await db.getUserById(actorId);
    const transporterId = user?.transporterId || actorId;

    // ============== FIX 4: REDIS CACHE (5s TTL) ==============
    // Protects DB from polling storms: 50 transporters × refresh/10s = 300 reads/min
    // Cache reduces to ~60 reads/min with 5s TTL
    const cacheKey = `cache:broadcasts:${transporterId}`;
    try {
      const cached = await redisService.get(cacheKey) as string | null;
      if (cached) {
        const parsed = safeJsonParse<unknown[]>(cached, []);
        if (parsed.length > 0) {
          logger.debug(`[BroadcastCompat] Cache HIT for transporter ${transporterId}`);
          return parsed;
        }
      }
    } catch {
      // Redis down — fall through to DB query (graceful degradation)
    }

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

    // ============== FIX 3: BATCH QUERY (N+1 → 2 queries) ==============
    // Before: N orders × 1 getTruckRequestsByOrder() each = N+1 DB calls
    // After:  1 getActiveOrders() + 1 batch findMany() = 2 DB calls total
    const validOrders = orders.filter(order => {
      if (new Date(order.expiresAt) < new Date()) return false;
      if (order.trucksFilled >= order.totalTrucks) return false;
      return true;
    });
    const orderIds = validOrders.map(o => o.id);
    const allTruckRequests = orderIds.length > 0
      ? await prismaClient.truckRequest.findMany({ where: { orderId: { in: orderIds } } })
      : [];

    // Index by orderId for O(1) lookup in loop
    const truckRequestsByOrderId = new Map<string, typeof allTruckRequests>();
    for (const tr of allTruckRequests) {
      const list = truckRequestsByOrderId.get(tr.orderId) || [];
      list.push(tr);
      truckRequestsByOrderId.set(tr.orderId, list);
    }

    logger.info(`[Broadcasts] Batch-loaded ${allTruckRequests.length} truck requests for ${validOrders.length} orders (2 queries)`);

    for (const order of validOrders) {
      // Lookup from pre-fetched map (O(1), no DB call)
      const truckRequests = (truckRequestsByOrderId.get(order.id) || []).map(tr => ({
        ...tr,
        vehicleType: tr.vehicleType || '',
        vehicleSubtype: tr.vehicleSubtype || '',
        status: tr.status || 'searching'
      }));

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
        customerMobile: '',  // FIX F-4-6: PII redacted — phone revealed only after accept (OWASP API3:2023)
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

    // ============== FIX 4: Store in Redis cache (2s TTL) ==============
    // M-15 FIX: Reduced from 5s to 2s — shorter TTL ensures truck counts
    // are closer to real-time after accepts, while still protecting DB from polling storms.
    try {
      await redisService.set(cacheKey, JSON.stringify(activeBroadcasts), 2);
    } catch {
      // Non-critical — next request will just re-query DB
    }

    // F-M6 FIX: Apply pagination if limit > 0 (0 = return all for backward compat)
    const paginationLimit = params.limit || 0;
    const paginationOffset = params.offset || 0;
    if (paginationLimit > 0) {
      return activeBroadcasts.slice(paginationOffset, paginationOffset + paginationLimit);
    }

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
   * Decline a broadcast
   */
  async declineBroadcast(broadcastId: string, params: DeclineBroadcastParams) {
    const { actorId, reason, notes } = params;

    // FIX #7: Track decline in Redis SET for analytics + re-broadcast prevention
    // TTL = 1 hour (matches booking max lifetime)
    const declineKey = `broadcast:declined:${broadcastId}`;
    let isReplay = false;
    try {
      const added = await redisService.sAdd(declineKey, actorId);
      isReplay = added === 0; // 0 means already a member (duplicate decline)
    } catch (err: unknown) {
      const declineMsg = err instanceof Error ? err.message : String(err);
      logger.warn('[declineBroadcast] Redis sAdd failed', { broadcastId, actorId, error: declineMsg });
    }
    await redisService.expire(declineKey, 3600).catch(() => {});

    // M-4 FIX: Persist decline to DB for durability (Redis is cache, DB is truth)
    // Booking model does not have a dedicated declinedTransporters column.
    // Use notifiedTransporters as the source of "who was notified" and store
    // declines in a separate Redis hash keyed by booking for durable cross-restart
    // analytics. Full DB persistence requires a schema migration (tracked below).
    // TODO: Add `declinedTransporters String[] @default([])` to Booking model
    //       via direct SQL: ALTER TABLE "Booking" ADD COLUMN "declinedTransporters" TEXT[] DEFAULT '{}';
    //       Then replace the Redis hash below with:
    //       prismaClient.booking.update({ where: { id: bookingId }, data: { declinedTransporters: { push: actorId } } });
    try {
      const declineHashKey = `broadcast:decline_log:${broadcastId}`;
      const declineEntry = JSON.stringify({
        transporterId: actorId,
        reason,
        notes: notes || null,
        declinedAt: new Date().toISOString(),
      });
      await redisService.hSet(declineHashKey, actorId, declineEntry);
      // 24h TTL — longer than booking lifetime for post-mortem analytics
      await redisService.expire(declineHashKey, 86400);
    } catch (dbErr: unknown) {
      // Non-fatal: Redis SET has the decline, hash is best-effort durability layer
      const dbMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      logger.warn('[Broadcast] Decline durable persist failed', { broadcastId, transporterId: actorId, error: dbMsg });
    }

    // H-37 FIX: Fire-and-forget DB persistence for broadcast declines.
    // Redis is volatile; DB is the source of truth. The BroadcastDecline table
    // may not exist yet (requires direct SQL migration). The try/catch ensures
    // this is completely non-blocking and non-fatal.
    prismaClient.$queryRawUnsafe(
      `INSERT INTO "BroadcastDecline" (id, "broadcastId", "transporterId", reason, "declinedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, NOW())
       ON CONFLICT ("broadcastId", "transporterId") DO NOTHING`,
      broadcastId,
      actorId,
      reason || null
    ).catch((persistErr: unknown) => {
      const persistMsg = persistErr instanceof Error ? persistErr.message : String(persistErr);
      // Silently handle missing table or other DB errors — Redis has the data
      logger.warn('[Broadcast] Decline DB persist failed (non-fatal)', {
        broadcastId,
        transporterId: actorId,
        error: persistMsg
      });
    });

    logger.info(`Broadcast ${broadcastId} declined by ${actorId}. Reason: ${reason}`, {
      notes,
      declineTracked: true,
      replayed: isReplay
    });

    return { success: true, replayed: isReplay };
  }

  /**
   * Get broadcast history for a transporter/driver
   */
  async getBroadcastHistory(params: GetHistoryParams) {
    const { actorId, page, limit, status } = params;

    // Get bookings for this actor (transporter or driver)
    let bookings = await db.getBookingsByDriver(actorId);

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
    // FIX #3: DEPRECATED — This method uses hardcoded mock values and does NOT
    // actually find/notify drivers. The real broadcast path is:
    //   booking.service.ts → createBooking() → progressive radius → emitToUser()
    // This endpoint remains for backward compatibility but logs a deprecation warning.
    logger.warn('[DEPRECATED] createBroadcast() called — use booking.service.ts createBooking() instead', {
      transporterId: params.transporterId
    });

    const broadcastId = uuidv4();

    // Get customer info
    const customer = await db.getUserById(params.customerId);

    const booking: Omit<BookingRecord, 'createdAt' | 'updatedAt'> = {
      id: broadcastId,
      customerId: params.customerId,
      customerName: customer?.name || 'Customer',
      customerPhone: '',  // FIX F-4-6: PII redacted — phone revealed only after accept
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
      distanceKm: 0,
      pricePerTruck: params.farePerTruck,
      totalAmount: params.farePerTruck * params.totalTrucksNeeded,
      goodsType: params.goodsType,
      weight: params.weight,
      status: 'active',
      notifiedTransporters: [params.transporterId],
      expiresAt: params.expiresAt || new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    };

    const createdBooking = await db.createBooking(booking);

    // DEPRECATED: No drivers actually notified via this path
    const notifiedDrivers = 0;

    logger.info(`[DEPRECATED] Broadcast ${broadcastId} created via legacy endpoint, 0 drivers notified`);

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
   * Check and expire old orders (multi-vehicle system)
   * Called periodically (every 5 seconds) by the expiry job
   * 
   * NOTE: Booking expiry is handled by booking.service.ts → processExpiredBookings()
   * using Redis timers (O(m) where m = expired only). This method only handles
   * ORDER expiry which is not covered by booking.service.ts.
   * 
   * DISTRIBUTED LOCK: Each expired order is locked individually
   * to prevent duplicate processing across multiple ECS instances.
   */
  async checkAndExpireBroadcasts(): Promise<number> {
    const now = new Date();
    let expiredCount = 0;

    // FIX #9: BOOKING EXPIRY is already handled by booking.service.ts → processExpiredBookings()
    // which uses Redis timers (O(m) where m = expired only, not ALL bookings).
    // The previous O(n) scan of ALL bookings every 5s was duplicate work and a DB bottleneck.
    // Only ORDER expiry is handled here (not covered by booking.service.ts).

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
          // Distributed lock: prevent duplicate processing across ECS instances
          // Standardized: lock: prefix added by acquireLock automatically
          const lockKey = `broadcast-order-expiry:${order.id}`;
          const lock = await redisService.acquireLock(lockKey, 'broadcast-expiry-checker', 15);

          if (!lock.acquired) {
            // Another instance is already processing this order expiry
            continue;
          }

          try {
            // Mark as expired
            if (db.updateOrder) {
              await db.updateOrder(order.id, { status: 'expired' });
            }

            // Notify notified transporters
            await this.emitBroadcastExpired(order.id, 'timeout');

            expiredCount++;
            logger.info(`⏰ Order ${order.id} expired - notified all transporters`);
          } catch (error: unknown) {
            const expiryMsg = error instanceof Error ? error.message : String(error);
            logger.error('Failed to process expired order broadcast', {
              orderId: order.id,
              error: expiryMsg
            });
          } finally {
            await redisService.releaseLock(lockKey, 'broadcast-expiry-checker').catch(() => { });
          }
        }
      }
    }

    if (expiredCount > 0) {
      logger.info(`🧹 Expired ${expiredCount} broadcast(s)`);
    }

    return expiredCount;
  }

  /**
   * Emit broadcast expired event to NOTIFIED transporters only
   * This instantly removes the broadcast from their overlay/list
   * 
   * FIX 2: Changed from emitToAllTransporters → targeted emitToUsers.
   * Only transporters who were originally notified receive the expiry event.
   * Prevents 980 wasted socket messages when 1000 are online but only 20 were notified.
   * 
   * @param broadcastId - The broadcast/order ID that expired
   * @param reason - Why it expired ('timeout', 'cancelled', 'fully_filled')
   */
  async emitBroadcastExpired(broadcastId: string, reason: string = 'timeout'): Promise<void> {
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

    // Lookup notified transporters from booking record
    let targets: string[] = [];
    try {
      const booking = await db.getBookingById(broadcastId);
      targets = booking?.notifiedTransporters ?? [];
    } catch {
      // DB lookup failed — fallback to all transporters (safety net)
    }

    if (targets.length > 0) {
      logger.info(`📢 Targeted expiry event: ${broadcastId} (${reason}) → ${targets.length} transporters`);
      emitToUsers(targets, BroadcastEvents.BROADCAST_EXPIRED, payload);
    } else {
      // Fix E2: Degrade gracefully -- do NOT fan-out to ALL transporters
      logger.warn('[Broadcast] No target transporters found for expiry notification, skipping emit', {
        broadcastId, reason
      });
    }

    // Also emit to the specific booking/order room (for any listeners)
    emitToRoom(`booking:${broadcastId}`, BroadcastEvents.BROADCAST_EXPIRED, payload);
    emitToRoom(`order:${broadcastId}`, BroadcastEvents.BROADCAST_EXPIRED, payload);
  }

  /**
   * Emit trucks remaining update to NOTIFIED transporters only
   * Called when a transporter accepts trucks - others see reduced availability
   * 
   * FIX 2: Changed from emitToAllTransporters → targeted emitToUsers.
   * Only transporters who received this broadcast see the truck count update.
   * 
   * @param broadcastId - The broadcast/order ID
   * @param vehicleType - Which vehicle type was accepted
   * @param vehicleSubtype - Which subtype
   * @param remaining - How many trucks still needed
   * @param total - Total trucks needed
   */
  async emitTrucksRemainingUpdate(
    broadcastId: string,
    vehicleType: string,
    vehicleSubtype: string,
    remaining: number,
    total: number
  ): Promise<void> {
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

    // Lookup notified transporters from booking record
    let targets: string[] = [];
    try {
      const booking = await db.getBookingById(broadcastId);
      targets = booking?.notifiedTransporters ?? [];
    } catch {
      // DB lookup failed — fallback to all transporters
    }

    if (targets.length > 0) {
      logger.info(`📢 Targeted trucks update: ${broadcastId} - ${remaining}/${total} (${vehicleType}) → ${targets.length} transporters`);
      emitToUsers(targets, BroadcastEvents.TRUCKS_REMAINING_UPDATE, payload);
    } else {
      // Fix E2: Degrade gracefully -- do NOT fan-out to ALL transporters
      logger.warn('[Broadcast] No target transporters found for trucks-remaining update, skipping emit', {
        broadcastId, remaining, total
      });
    }

    // Also emit to booking/order room
    emitToRoom(`booking:${broadcastId}`, BroadcastEvents.TRUCKS_REMAINING_UPDATE, payload);
    emitToRoom(`order:${broadcastId}`, BroadcastEvents.TRUCKS_REMAINING_UPDATE, payload);

    // If fully filled, emit that event too
    if (remaining === 0) {
      await this.emitBroadcastExpired(broadcastId, 'fully_filled');
    }
  }

  /**
   * Start the broadcast expiry checker job
   * Runs every 5 seconds to check for expired broadcasts
   * 
   * IMPORTANT: Call this from server.ts after initializing the service
   */
  private expiryCheckerInterval: NodeJS.Timeout | null = null;

  startExpiryChecker(): void {
    if (this.expiryCheckerInterval) return;
    // Check every 5 seconds
    this.expiryCheckerInterval = setInterval(async () => {
      try {
        await this.checkAndExpireBroadcasts();
      } catch (error: unknown) {
        const checkerMsg = error instanceof Error ? error.message : String(error);
        logger.error(`Expiry checker error: ${checkerMsg}`);
      }
    }, 5000);

    logger.info('Broadcast expiry checker started (5 second interval)');
  }

  stopExpiryChecker(): void {
    if (this.expiryCheckerInterval) {
      clearInterval(this.expiryCheckerInterval);
      this.expiryCheckerInterval = null;
      logger.info('Broadcast expiry checker stopped');
    }
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
      customerMobile: '',  // FIX F-4-6: PII redacted — phone revealed only after accept (OWASP API3:2023)
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
