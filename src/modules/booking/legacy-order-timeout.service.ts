/**
 * @deprecated Legacy booking order timeout handling. See order.service.ts deprecation notice.
 *
 * Handles order timeout: expires unfilled requests, notifies customer
 * and transporters, sends FCM push for backgrounded apps.
 */

import { db, TruckRequestRecord } from '../../shared/database/db';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, SocketEvent } from '../../shared/services/socket.service';
import { queueService } from '../../shared/services/queue.service';
import { redisService } from '../../shared/services/redis.service';
import { TIMER_KEYS } from './legacy-order-types';

// =============================================================================
// TIMEOUT HANDLING
// =============================================================================

/**
 * Clears order timers for the legacy booking flow.
 * NOTE: A separate clearOrderTimers exists as a private method in order.service.ts
 * for the multi-truck order flow. They are NOT duplicates — they operate on
 * different timer registries. Remove this version when legacy flow is deprecated.
 */
async function clearOrderTimers(orderId: string): Promise<void> {
  // Cancel Redis-based expiry timer
  await redisService.cancelTimer(TIMER_KEYS.ORDER_EXPIRY(orderId));
}

/**
 * Handle order timeout - called when timer expires
 *
 * SCALABILITY: Called by Redis expiry checker (cluster-safe)
 * EASY UNDERSTANDING: Check status -> expire unfilled -> notify all parties
 * MODULARITY: Same notification pattern as booking.service.ts
 */
export async function handleOrderTimeout(orderId: string, customerId: string): Promise<void> {
  const order = await db.getOrderById(orderId);

  if (!order) {
    logger.warn(`Order ${orderId} not found for timeout handling`);
    return;
  }

  // Skip if already completed or cancelled
  if (['fully_filled', 'completed', 'cancelled'].includes(order.status)) {
    logger.info(`Order ${orderId} already ${order.status}, skipping timeout`);
    clearOrderTimers(orderId);
    return;
  }

  logger.info(`TIMEOUT: Order ${orderId} expired`);

  // Get unfilled requests
  const requests = await db.getTruckRequestsByOrder(orderId);
  const unfilledRequests = requests.filter((r: TruckRequestRecord) => r.status === 'searching');
  const filledCount = requests.filter((r: TruckRequestRecord) => ['assigned', 'accepted', 'in_progress', 'completed'].includes(r.status)).length;

  // Update unfilled requests to expired
  await db.updateTruckRequestsBatch(
    unfilledRequests.map((r: TruckRequestRecord) => r.id),
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

    // Also emit order_expired for customer app compatibility (C1 fix)
    emitToUser(customerId, 'order_expired', {
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
  clearOrderTimers(orderId);

  // Collect all notified transporters
  const allNotifiedTransporters = new Set<string>();
  requests.forEach((r: TruckRequestRecord) => (r.notifiedTransporters as string[]).forEach((t: string) => allNotifiedTransporters.add(t)));

  // Notify transporters via WebSocket (for apps in foreground)
  for (const transporterId of allNotifiedTransporters) {
    emitToUser(transporterId, SocketEvent.BOOKING_EXPIRED, {
      orderId,
      message: 'This order has expired'
    });
  }

  // FCM PUSH: Notify transporters of expiry (for apps in background)
  // SCALABILITY: Queued via queueService -- reliable with retry
  // EASY UNDERSTANDING: Transporters need to clear this order from their UI
  // MODULARITY: Fire-and-forget, doesn't block timeout handling
  const transporterIds = Array.from(allNotifiedTransporters);
  if (transporterIds.length > 0) {
    queueService.queuePushNotificationBatch(
      transporterIds,
      {
        title: 'Order Expired',
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
 * Cancel order timeout (called when fully filled)
 *
 * SCALABILITY: Cancels distributed Redis timer
 * EASY UNDERSTANDING: Order is fully filled -> no need for expiry timer
 */
export async function cancelOrderTimeout(orderId: string): Promise<void> {
  await clearOrderTimers(orderId);
  logger.info(`Timeout cancelled for order ${orderId}`);
}
