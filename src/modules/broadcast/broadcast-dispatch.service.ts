/**
 * =============================================================================
 * BROADCAST DISPATCH SERVICE — createBroadcast, dispatch, expiry checking
 * =============================================================================
 * Extracted from broadcast.service.ts for modularity.
 * =============================================================================
 */

import { v4 as uuidv4 } from 'uuid';
import { db, BookingRecord, OrderRecord } from '../../shared/database/db';
import { logger } from '../../shared/services/logger.service';
import { emitToUsers, emitToRoom } from '../../shared/services/socket.service';
import { redisService } from '../../shared/services/redis.service';
import { mapBookingToBroadcast, BroadcastEvents } from './broadcast-query.service';

export interface CreateBroadcastParams {
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

export async function createBroadcast(params: CreateBroadcastParams) {
  logger.warn('[DEPRECATED] createBroadcast() called -- use booking.service.ts createBooking() instead', {
    transporterId: params.transporterId
  });

  const broadcastId = uuidv4();
  const customer = await db.getUserById(params.customerId);

  const booking: Omit<BookingRecord, 'createdAt' | 'updatedAt'> = {
    id: broadcastId,
    customerId: params.customerId,
    customerName: customer?.name || 'Customer',
    customerPhone: '',
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
  const notifiedDrivers = 0;

  logger.info(`[DEPRECATED] Broadcast ${broadcastId} created via legacy endpoint, 0 drivers notified`);

  return {
    broadcast: mapBookingToBroadcast(createdBooking),
    notifiedDrivers
  };
}

export async function checkAndExpireBroadcasts(): Promise<number> {
  const now = new Date();
  let expiredCount = 0;

  let allOrders: OrderRecord[] = [];
  try {
    // H-07 FIX: Ideally the repository query should add a WHERE expiresAt < now filter
    // to avoid loading all active orders. TODO: Add expiresAt filter to getActiveOrders()
    // in the repository layer. For now, the JS filter below handles it correctly.
    if (db.getActiveOrders) {
      const result = await db.getActiveOrders();
      allOrders = Array.isArray(result) ? result : [];
    }
  } catch (error) {
    logger.debug('Could not get active orders for expiry check');
  }

  for (const order of allOrders) {
    // H-07: Only process orders that are actually expired (status + expiresAt check)
    if (!(order.status === 'broadcasting' || order.status === 'active' || order.status === 'partially_filled')) continue;
    if (!(new Date(order.expiresAt) < now)) continue;

    const lockKey = `broadcast-order-expiry:${order.id}`;
    const lock = await redisService.acquireLock(lockKey, 'broadcast-expiry-checker', 15);

    if (!lock.acquired) continue;

    try {
      if (db.updateOrder) {
        await db.updateOrder(order.id, { status: 'expired' });
      }
      await emitBroadcastExpired(order.id, 'timeout');
      expiredCount++;
      logger.info(`Order ${order.id} expired - notified all transporters`);
    } catch (error: unknown) {
      logger.error('Failed to process expired order broadcast', { orderId: order.id, error: error instanceof Error ? error.message : String(error) });
    } finally {
      await redisService.releaseLock(lockKey, 'broadcast-expiry-checker').catch(() => { });
    }
  }

  if (expiredCount > 0) {
    logger.info(`Expired ${expiredCount} broadcast(s)`);
  }

  return expiredCount;
}

export async function emitBroadcastExpired(broadcastId: string, reason: string = 'timeout'): Promise<void> {
  // #88: Include explicit `bookingId` and `reason` fields in every expiry event so
  // clients can distinguish timeout vs cancellation without matching on message text.
  // Valid reason values: 'timeout' (timer fired), 'cancelled' (customer cancel),
  // 'fully_filled' (all trucks assigned).
  const payload = {
    bookingId: broadcastId,
    broadcastId,
    orderId: broadcastId,
    reason,
    timestamp: new Date().toISOString(),
    message: reason === 'timeout'
      ? 'This booking request has expired'
      : reason === 'cancelled'
        ? 'Customer cancelled this booking'
        : 'All trucks have been assigned'
  };

  let targets: string[] = [];
  try {
    const booking = await db.getBookingById(broadcastId);
    targets = booking?.notifiedTransporters ?? [];
  } catch { /* fallback */ }

  if (targets.length > 0) {
    logger.info(`Targeted expiry event: ${broadcastId} (${reason}) -> ${targets.length} transporters`);
    emitToUsers(targets, BroadcastEvents.BROADCAST_EXPIRED, payload);
  } else {
    logger.warn('[Broadcast] No target transporters found for expiry notification, skipping emit', { broadcastId, reason });
  }

  emitToRoom(`booking:${broadcastId}`, BroadcastEvents.BROADCAST_EXPIRED, payload);
  emitToRoom(`order:${broadcastId}`, BroadcastEvents.BROADCAST_EXPIRED, payload);
}

export async function emitTrucksRemainingUpdate(
  broadcastId: string,
  vehicleType: string,
  vehicleSubtype: string,
  remaining: number,
  total: number
): Promise<void> {
  const payload = {
    broadcastId, orderId: broadcastId, vehicleType, vehicleSubtype,
    trucksRemaining: remaining, trucksNeeded: total, trucksFilled: total - remaining,
    isFullyFilled: remaining === 0, timestamp: new Date().toISOString()
  };

  let targets: string[] = [];
  try {
    const booking = await db.getBookingById(broadcastId);
    targets = booking?.notifiedTransporters ?? [];
  } catch { /* fallback */ }

  if (targets.length > 0) {
    logger.info(`Targeted trucks update: ${broadcastId} - ${remaining}/${total} (${vehicleType}) -> ${targets.length} transporters`);
    emitToUsers(targets, BroadcastEvents.TRUCKS_REMAINING_UPDATE, payload);
  } else {
    logger.warn('[Broadcast] No target transporters found for trucks-remaining update, skipping emit', { broadcastId, remaining, total });
  }

  emitToRoom(`booking:${broadcastId}`, BroadcastEvents.TRUCKS_REMAINING_UPDATE, payload);
  emitToRoom(`order:${broadcastId}`, BroadcastEvents.TRUCKS_REMAINING_UPDATE, payload);

  if (remaining === 0) {
    await emitBroadcastExpired(broadcastId, 'fully_filled');
  }
}
