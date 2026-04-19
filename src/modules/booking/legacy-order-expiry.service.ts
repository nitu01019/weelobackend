/**
 * @deprecated Legacy booking order expiry checker. See order.service.ts deprecation notice.
 *
 * Background job that scans for expired order timers in Redis
 * and delegates timeout handling to the OrderService.
 */

import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { ORDER_CONFIG, OrderTimerData } from './legacy-order-types';

// =============================================================================
// EXPIRY CHECKER (Runs on every server instance - Redis ensures no duplicates)
// =============================================================================
//
// SCALABILITY: Every ECS instance runs this checker, but Redis distributed locks
//   ensure only ONE instance processes each expired order (no duplicates)
// EASY UNDERSTANDING: Same pattern as booking.service.ts expiry checker
// MODULARITY: Independent from OrderService -- runs as a background job
// =============================================================================

let orderExpiryCheckerInterval: NodeJS.Timeout | null = null;

// Late-bound reference to avoid circular imports.
// Set by the facade (order.service.ts) before the checker fires.
let _orderServiceRef: { handleOrderTimeout(orderId: string, customerId: string): Promise<void> } | null = null;

export function setOrderServiceRef(ref: typeof _orderServiceRef): void {
  _orderServiceRef = ref;
}

/**
 * Start the order expiry checker
 * This runs on every server instance but uses Redis locks to prevent duplicate processing
 */
export function startOrderExpiryChecker(): void {
  if (orderExpiryCheckerInterval) return;

  orderExpiryCheckerInterval = setInterval(async () => {
    try {
      await processExpiredOrders();
    } catch (error: unknown) {
      logger.error('Order expiry checker error', { error: (error as Error).message });
    }
  }, ORDER_CONFIG.EXPIRY_CHECK_INTERVAL_MS);

  logger.info('Order expiry checker started (Redis-based, cluster-safe)');
}

/**
 * Process all expired order timers
 * Uses Redis distributed lock to prevent multiple instances processing the same order
 *
 * SCALABILITY: Lock prevents duplicate expiry handling across ECS instances
 * EASY UNDERSTANDING: Scan expired -> lock -> handle -> unlock
 * CODING STANDARDS: Same pattern as processExpiredBookings() in booking.service.ts
 */
async function processExpiredOrders(): Promise<void> {
  const expiredTimers = await redisService.getExpiredTimers<OrderTimerData>('timer:booking-order:');

  // Fix H-A3: Phase 1 deprecation logging -- track usage so we know when to remove this file.
  if (expiredTimers.length > 0) {
    logger.warn('[DEPRECATED] Legacy booking/order.service processing expired timers', {
      count: expiredTimers.length,
      keys: expiredTimers.map(t => t.key),
    });
  }

  for (const timer of expiredTimers) {
    // Try to acquire lock for this order (prevents duplicate processing)
    const lockKey = `lock:booking-order-expiry:${timer.data.orderId}`;
    const lock = await redisService.acquireLock(lockKey, 'expiry-checker', 30);

    if (!lock.acquired) {
      // Another instance is processing this order
      continue;
    }

    try {
      if (!_orderServiceRef) {
        logger.error('Order expiry checker: OrderService reference not set');
        continue;
      }
      await _orderServiceRef.handleOrderTimeout(timer.data.orderId, timer.data.customerId);
      await redisService.cancelTimer(timer.key);
    } catch (error: unknown) {
      logger.error('Failed to process expired order', {
        orderId: timer.data.orderId,
        error: (error as Error).message
      });
    } finally {
      await redisService.releaseLock(lockKey, 'expiry-checker').catch(() => {});
    }
  }
}

/** Stop the order expiry checker (for graceful shutdown) */
export function stopOrderExpiryChecker(): void {
  if (orderExpiryCheckerInterval) {
    clearInterval(orderExpiryCheckerInterval);
    orderExpiryCheckerInterval = null;
    logger.info('Order expiry checker stopped');
  }
}
