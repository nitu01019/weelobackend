/**
 * Broadcast Queue Processor
 *
 * Handles broadcast notifications to transporters with:
 * - Cancelled order queue guard (drops stale broadcasts for inactive orders)
 * - Message TTL enforcement (Phase 4)
 * - Sequence numbering for guaranteed delivery (Phase 4)
 * - Dual-channel delivery: Socket.IO + FCM push (Phase 4)
 */

import { logger } from '../services/logger.service';
import { redisService } from '../services/redis.service';
import { metrics } from '../monitoring/metrics.service';
import type { QueueJob } from '../services/queue.service';
import { FLAGS, isEnabled } from '../config/feature-flags';

// FIX #24: Centralized feature flags — single source of truth from feature-flags.ts
const FF_MESSAGE_TTL_ENABLED = isEnabled(FLAGS.MESSAGE_TTL_ENABLED);
const FF_SEQUENCE_DELIVERY_ENABLED = isEnabled(FLAGS.SEQUENCE_DELIVERY_ENABLED);
const FF_DUAL_CHANNEL_DELIVERY = isEnabled(FLAGS.DUAL_CHANNEL_DELIVERY);

const UNACKED_QUEUE_TTL_SECONDS = 600;

const MESSAGE_TTL_MS: Record<string, number> = {
  'new_broadcast': 90_000,
  'new_truck_request': 90_000,
  'accept_confirmation': 60_000,
  'order_cancelled': 300_000,
  'order_expired': 300_000,
  'trip_assigned': 120_000,
  'booking_updated': 120_000,
  'trucks_remaining_update': 30_000
};

const DEFAULT_MESSAGE_TTL_MS = 120_000;

/**
 * Interface for the QueueService methods needed by this processor.
 * Using an interface instead of importing QueueService avoids circular dependencies.
 */
export interface BroadcastProcessorDeps {
  cancelledOrderQueueGuardEnabled: boolean;
  cancelledOrderQueueGuardFailOpen: boolean;
  inactiveOrderStatuses: Set<string>;
  resolveBroadcastOrderId(data: object): string;
  getOrderStatusForQueueGuard(orderId: string): Promise<string | null>;
}

export function registerBroadcastProcessor(
  queue: { process(queueName: string, processor: (job: QueueJob) => Promise<void>): void },
  deps: BroadcastProcessorDeps,
  queueName: string
): void {
  queue.process(queueName, async (job) => {
    const { emitToUser }: typeof import('../services/socket.service') = require('../services/socket.service');
    const { transporterId, event, data } = job.data;

    if (
      deps.cancelledOrderQueueGuardEnabled &&
      (event === 'new_broadcast' || event === 'new_truck_request')
    ) {
      const metric = 'broadcast.queue.drop_inactive';
      const metricLabelsBase = { event };
      const orderId = deps.resolveBroadcastOrderId(data);
      if (!orderId) {
        if (deps.cancelledOrderQueueGuardFailOpen) {
          metrics.incrementCounter('broadcast_queue_guard_fail_open_total', {
            ...metricLabelsBase,
            reason: 'missing_order_id'
          });
          logger.warn('broadcast.emit.guard_fail_open', {
            metric,
            dropReason: 'missing_order_id',
            transporterId,
            event
          });
          emitToUser(transporterId, event, data);
          return;
        }
        metrics.incrementCounter('broadcast_queue_guard_dropped_total', {
          ...metricLabelsBase,
          reason: 'missing_order_id'
        });
        logger.warn('broadcast.emit.skipped_inactive', {
          metric,
          dropReason: 'missing_order_id',
          transporterId,
          event
        });
        return;
      }

      const lookupStartedAt = Date.now();
      let lookupOutcome: 'active' | 'order_not_found' | 'order_inactive' | 'lookup_error' = 'active';
      try {
        const orderStatus = await deps.getOrderStatusForQueueGuard(orderId);
        if (!orderStatus) {
          lookupOutcome = 'order_not_found';
          if (deps.cancelledOrderQueueGuardFailOpen) {
            metrics.incrementCounter('broadcast_queue_guard_fail_open_total', {
              ...metricLabelsBase,
              reason: 'order_not_found'
            });
            logger.warn('broadcast.emit.guard_fail_open', {
              metric,
              dropReason: 'order_not_found',
              transporterId,
              orderId,
              event
            });
            emitToUser(transporterId, event, data);
            return;
          }
          metrics.incrementCounter('broadcast_queue_guard_dropped_total', {
            ...metricLabelsBase,
            reason: 'order_not_found'
          });
          logger.warn('broadcast.emit.skipped_inactive', {
            metric,
            dropReason: 'order_not_found',
            transporterId,
            orderId,
            event
          });
          return;
        }

        if (deps.inactiveOrderStatuses.has(orderStatus)) {
          lookupOutcome = 'order_inactive';
          metrics.incrementCounter('broadcast_queue_guard_dropped_total', {
            ...metricLabelsBase,
            reason: 'order_inactive'
          });
          logger.info('broadcast.emit.skipped_inactive', {
            metric,
            dropReason: 'order_inactive',
            transporterId,
            orderId,
            orderStatus,
            event
          });
          return;
        }
      } catch (error: unknown) {
        lookupOutcome = 'lookup_error';
        const errorMessage = error instanceof Error ? error.message : 'unknown';
        if (deps.cancelledOrderQueueGuardFailOpen) {
          metrics.incrementCounter('broadcast_queue_guard_fail_open_total', {
            ...metricLabelsBase,
            reason: 'lookup_error'
          });
          logger.warn('broadcast.emit.guard_fail_open', {
            metric,
            dropReason: 'lookup_error',
            transporterId,
            orderId,
            event,
            error: errorMessage
          });
          emitToUser(transporterId, event, data);
          return;
        }
        metrics.incrementCounter('broadcast_queue_guard_dropped_total', {
          ...metricLabelsBase,
          reason: 'lookup_error'
        });
        logger.warn('broadcast.emit.skipped_inactive', {
          metric,
          dropReason: 'lookup_error',
          transporterId,
          orderId,
          event,
          error: errorMessage
        });
        return;
      } finally {
        metrics.observeHistogram(
          'broadcast_queue_guard_lookup_latency_ms',
          Math.max(0, Date.now() - lookupStartedAt),
          {
            ...metricLabelsBase,
            outcome: lookupOutcome
          }
        );
      }
    }

    // === PHASE 4: MESSAGE TTL ENFORCEMENT (flag-gated) ===
    if (FF_MESSAGE_TTL_ENABLED) {
      const ttlMs = MESSAGE_TTL_MS[event] ?? DEFAULT_MESSAGE_TTL_MS;
      const ageMs = Date.now() - job.createdAt;
      if (ageMs > ttlMs) {
        metrics.incrementCounter('broadcast_delivery_stale_dropped', { event });
        logger.info('[Phase4] Stale message dropped', {
          transporterId, event, ageMs, ttlMs
        });
        return; // Drop silently
      }
    }

    // === PHASE 4: SEQUENCE NUMBERING (flag-gated) ===
    let seq: number | undefined;
    if (FF_SEQUENCE_DELIVERY_ENABLED) {
      try {
        // Step 1: increment seq counter (must be sequential -- need value)
        seq = await redisService.incr(`socket:seq:${transporterId}`);
        const envelope = JSON.stringify({
          seq, event, payload: data, createdAt: job.createdAt
        });
        // Step 2: store in unacked set + refresh TTL (parallel -- independent ops)
        await Promise.all([
          redisService.zAdd(
            `socket:unacked:${transporterId}`,
            seq,
            envelope
          ),
          redisService.expire(
            `socket:unacked:${transporterId}`,
            UNACKED_QUEUE_TTL_SECONDS
          )
        ]);
        // Attach seq to outgoing payload for client-side dedup
        if (data && typeof data === 'object') {
          data._seq = seq;
        }
      } catch (seqError: unknown) {
        // Sequence numbering is best-effort -- never block delivery
        logger.warn('[Phase4] Sequence numbering failed, delivering without seq', {
          transporterId, error: seqError instanceof Error ? seqError.message : String(seqError)
        });
      }
    }

    // === PHASE 4: DUAL-CHANNEL DELIVERY (flag-gated) ===
    // Phase 6: Measure delivery latency from enqueue to completion
    const deliveryStart = Date.now();
    if (FF_DUAL_CHANNEL_DELIVERY) {
      const { sendPushNotification }: typeof import('../services/fcm.service') = require('../services/fcm.service');
      // Fire both channels in parallel -- neither blocks the other
      const results = await Promise.allSettled([
        // Channel A: Socket.IO (primary, foreground)
        Promise.resolve().then(() => {
          emitToUser(transporterId, event, data);
          metrics.incrementCounter('broadcast_delivery_delivered', { channel: 'socket' });
        }),
        // Channel B: FCM Push (fallback, background/offline)
        // Phase 5: fcmCircuit wraps FCM -- when open, skips FCM entirely
        (async () => {
          const { fcmCircuit }: typeof import('../services/circuit-breaker.service') = require('../services/circuit-breaker.service');
          return fcmCircuit.tryWithFallback(
            async () => {
              await sendPushNotification(transporterId, {
                title: data?.pickupCity
                  ? `\uD83D\uDE9B ${data.trucksNeeded || ''}x Truck Required`
                  : 'New Broadcast',
                body: data?.pickupCity && data?.dropCity
                  ? `${data.pickupCity} \u2192 ${data.dropCity} \u2022 \u20B9${data.farePerTruck || ''}/truck`
                  : 'You have a new broadcast request',
                data: {
                  type: event,
                  orderId: data?.orderId || data?.broadcastId || '',
                  broadcastId: data?.broadcastId || data?.orderId || '',
                  seq: seq?.toString() || ''
                }
              });
              metrics.incrementCounter('broadcast_delivery_delivered', { channel: 'fcm' });
            },
            async () => {
              // Fallback: skip FCM (Socket.IO is primary anyway)
              logger.info('[Phase5] FCM circuit open, skipping FCM delivery', {
                transporterId, event
              });
            }
          );
        })()
      ]);
      // Phase 6: Record failures
      for (const r of results) {
        if (r.status === 'rejected') {
          metrics.incrementCounter('broadcast_delivery_failed', {
            channel: 'unknown', reason: r.reason?.message || 'unknown'
          });
        }
      }
    } else {
      // Original path -- Socket.IO only
      emitToUser(transporterId, event, data);
      metrics.incrementCounter('broadcast_delivery_delivered', { channel: 'socket' });
    }
    // Phase 6: Delivery latency (enqueue -> emit completion)
    metrics.observeHistogram('broadcast_delivery_latency_ms', Date.now() - deliveryStart, {
      channel: FF_DUAL_CHANNEL_DELIVERY ? 'dual' : 'socket'
    });
  });
}
