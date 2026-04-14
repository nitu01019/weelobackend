/**
 * =============================================================================
 * QUEUE SERVICE — Unified Interface (Auto-selects Redis in Production)
 * =============================================================================
 *
 * Extracted from queue.service.ts for file-size compliance.
 * All external consumers still import from queue.service.ts (facade).
 *
 * =============================================================================
 */

import { logger } from './logger.service';
import { redisService } from './redis.service';
import { createTrackingStreamSink } from './tracking-stream-sink';
import { metrics } from '../monitoring/metrics.service';
import { prismaClient } from '../database/prisma.service';
import {
  registerBroadcastProcessor,
  registerPushNotificationProcessor,
  registerFcmBatchProcessor,
  registerTrackingEventsProcessor,
  registerVehicleReleaseProcessor,
  registerAssignmentReconciliationProcessor,
  startAssignmentTimeoutPoller
} from '../queue-processors';

import { emitToUser, SocketEvent } from './socket.service';
import { InMemoryQueue } from './queue-memory.service';
import { RedisQueue } from './queue-redis.service';
import {
  TRACKING_QUEUE_HARD_LIMIT,
  DLQ_MAX_SIZE,
  TRACKING_QUEUE_DEPTH_SAMPLE_MS,
  FF_CANCELLED_ORDER_QUEUE_GUARD,
  FF_CANCELLED_ORDER_QUEUE_GUARD_FAIL_OPEN,
  CANCELLED_ORDER_QUEUE_GUARD_CACHE_TTL_MS,
  FF_DUAL_CHANNEL_DELIVERY,
  FF_MESSAGE_PRIORITY_ENABLED,
  FF_QUEUE_DEPTH_CAP,
  MessagePriority,
  EVENT_PRIORITY,
} from './queue.types';
import type { IQueue, JobProcessor, TrackingEventPayload } from './queue.types';

export class QueueService {
  private queue: IQueue;
  private readonly trackingStreamSink = createTrackingStreamSink();
  private trackingDepthSnapshot: { depth: number; sampledAtMs: number } = { depth: 0, sampledAtMs: 0 };
  private trackingDepthSampleInFlight: Promise<void> | null = null;
  private broadcastDepthSnapshot: { depth: number; sampledAtMs: number } = { depth: 0, sampledAtMs: 0 };
  private broadcastDepthSampleInFlight: Promise<void> | null = null;
  private readonly cancelledOrderQueueGuardEnabled = FF_CANCELLED_ORDER_QUEUE_GUARD;
  private readonly cancelledOrderQueueGuardFailOpen = FF_CANCELLED_ORDER_QUEUE_GUARD_FAIL_OPEN;
  private readonly inactiveOrderStatuses = new Set(['cancelled', 'expired', 'completed', 'fully_filled']);
  private readonly orderStatusCacheTtlMs = CANCELLED_ORDER_QUEUE_GUARD_CACHE_TTL_MS;
  private readonly orderStatusCache = new Map<string, { status: string | null; expiresAt: number }>();

  // Queue names for organization
  static readonly QUEUES = {
    BROADCAST: 'broadcast',           // Broadcast notifications to transporters
    PUSH_NOTIFICATION: 'push',        // FCM push notifications (per user)
    FCM_BATCH: 'fcm_batch',          // FCM batch notifications (up to 500 drivers at once)
    TRACKING_EVENTS: 'tracking-events', // Driver telemetry stream fanout
    EMAIL: 'email',                   // Email notifications (future)
    SMS: 'sms',                       // SMS notifications (future)
    ANALYTICS: 'analytics',           // Analytics events
    CLEANUP: 'cleanup',               // Cleanup/maintenance tasks
    CUSTOM_BOOKING: 'custom-booking',  // Custom booking events
    ASSIGNMENT_RECONCILIATION: 'assignment-reconciliation',  // Periodic orphaned assignment cleanup
    HOLD_EXPIRY: 'hold-expiry',  // Periodic hold expiry cleanup jobs
    VEHICLE_RELEASE: 'vehicle-release'  // Retry queue for failed vehicle releases
  };

  constructor() {
    // PRODUCTION: Auto-select Redis queue if available
    // SCALABILITY: Redis queue persists across restarts, shared across ECS tasks
    const isProduction = process.env.NODE_ENV === 'production';
    const redisEnabled = process.env.REDIS_ENABLED === 'true';
    // REDIS_QUEUE_ENABLED defaults to same as REDIS_ENABLED, but can be explicitly
    // set to 'false' to use InMemoryQueue even when Redis is enabled (e.g. when
    // BRPOP workers are saturating the Redis connection pool).
    const redisQueueEnabled = process.env.REDIS_QUEUE_ENABLED !== 'false' && redisEnabled;

    if (isProduction && redisQueueEnabled) {
      this.queue = new RedisQueue();
      // FIX #11: Log BRPOP connection usage so operators can monitor Redis connection saturation
      const totalQueues = Object.keys(QueueService.QUEUES).length;
      logger.info('✅ Queue Service: Using Redis Queue (Production Mode)', {
        totalQueues,
        defaultWorkersPerQueue: 2,
        trackingWorkers: 4,
        estimatedBlockedConnections: (2 * totalQueues) + 2, // +2 for tracking extra workers
        killSwitch: 'Set REDIS_QUEUE_ENABLED=false to disable'
      });
    } else {
      this.queue = new InMemoryQueue();
      logger.info('📦 Queue Service: Using In-Memory Queue (Development Mode)');
    }

    this.registerDefaultProcessors();
  }

  /**
   * Register default job processors
   *
   * Each processor is extracted into its own file under src/shared/queue-processors/
   * for maintainability. Each processor is independent with zero shared state.
   */
  private registerDefaultProcessors(): void {
    // Broadcast processor (with cancelled-order guard, TTL, sequence numbering, dual-channel)
    registerBroadcastProcessor(
      this.queue,
      {
        cancelledOrderQueueGuardEnabled: this.cancelledOrderQueueGuardEnabled,
        cancelledOrderQueueGuardFailOpen: this.cancelledOrderQueueGuardFailOpen,
        inactiveOrderStatuses: this.inactiveOrderStatuses,
        resolveBroadcastOrderId: (data: object) => this.resolveBroadcastOrderId(data as Record<string, unknown>),
        getOrderStatusForQueueGuard: (orderId: string) => this.getOrderStatusForQueueGuard(orderId)
      },
      QueueService.QUEUES.BROADCAST
    );

    // Push notification processor (FCM with circuit breaker)
    registerPushNotificationProcessor(this.queue, QueueService.QUEUES.PUSH_NOTIFICATION);

    // FCM batch processor (up to 500 drivers in one API call)
    registerFcmBatchProcessor(this.queue, QueueService.QUEUES.FCM_BATCH);

    // Tracking stream processor (sink pluggable via env/integration service)
    registerTrackingEventsProcessor(this.queue, this.trackingStreamSink, QueueService.QUEUES.TRACKING_EVENTS);

    // Vehicle release retry processor (max 5 retries with exponential backoff)
    registerVehicleReleaseProcessor(this.queue, QueueService.QUEUES.VEHICLE_RELEASE);

    // =========================================================================
    // ASSIGNMENT_TIMEOUT queue processor REMOVED (Uber/Ola pattern)
    // Self-destruct timers now use setTimeout directly in scheduleAssignmentTimeout().
    // Zero Redis hops. Timer lives in V8 process memory -- guaranteed to fire.
    // Existing ASSIGNMENT_RECONCILIATION (below) catches the 0.01% edge case
    // where ECS restarts during the 30s timer window.
    // =========================================================================

    // Reconciliation job -- safety net for orphaned pending assignments
    registerAssignmentReconciliationProcessor(
      this.queue,
      { queuePushNotification: (userId, notification) => this.queuePushNotification(userId, notification) },
      QueueService.QUEUES.ASSIGNMENT_RECONCILIATION
    );

    // FIX #9: Tighter reconciliation interval -- 2min instead of 5min.
    // Env-configurable with Math.max guard to prevent dangerously low values.
    // L1 FIX: unref() so this non-critical timer doesn't block process exit
    const RECONCILE_INTERVAL_MS = Math.max(30000, parseInt(process.env.ASSIGNMENT_RECONCILE_INTERVAL_MS || '120000', 10) || 120000);
    setInterval(async () => {
      try {
        await this.queue.add(
          QueueService.QUEUES.ASSIGNMENT_RECONCILIATION,
          'reconcile-orphaned',
          {},
          { maxAttempts: 1 }
        );
      } catch (err) {
        logger.warn('[RECONCILIATION] Failed to schedule reconciliation job');
      }
    }, RECONCILE_INTERVAL_MS).unref();

    // =========================================================================
    // STALE VEHICLE WATCHDOG -- REMOVED (Uber/Ola Pattern)
    // =========================================================================

    // Assignment timeout poller (Problem 16 fix)
    startAssignmentTimeoutPoller();

    // H-18 FIX: Read and process overdue fallback timers on startup
    this.rehydrateFallbackTimers().catch(e =>
      logger.warn('[QueueMgmt] Fallback timer rehydration failed on startup', { error: (e as Error).message })
    );

    // #43 FIX: Periodic fallback timer scan — catches timers that expire while the server is running
    // (e.g., timers written by another instance's failed setTimer). Runs every 30s.
    setInterval(async () => {
      try {
        await this.rehydrateFallbackTimers();
      } catch (e) {
        logger.warn('[QueueMgmt] Periodic fallback timer scan failed', { error: (e as Error).message });
      }
    }, 30_000).unref();

    // H-21 FIX: Abandoned trip detection — scan for stale driver_accepted with no progress
    setInterval(async () => {
      try {
        const staleThresholdIso = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 minutes ago
        const staleTrips = await prismaClient.assignment.findMany({
          where: { status: 'driver_accepted', driverAcceptedAt: { lt: staleThresholdIso } },
          select: { id: true, driverId: true, orderId: true, transporterId: true, tripId: true },
          take: 50,
        });
        if (staleTrips.length > 0) {
          logger.warn(`[QueueMgmt] Found ${staleTrips.length} stale driver_accepted assignments`, {
            assignmentIds: staleTrips.map(t => t.id),
          });
          for (const trip of staleTrips) {
            if (trip.transporterId) {
              emitToUser(trip.transporterId, SocketEvent.ASSIGNMENT_STALE, {
                assignmentId: trip.id, driverId: trip.driverId, tripId: trip.tripId,
                message: 'Driver has not responded for 5+ minutes',
              });
            }
          }
        }
      } catch (e) { logger.warn('[QueueMgmt] Abandoned trip scan failed', { error: (e as Error).message }); }
    }, 60_000).unref();

    logger.info('Queue processors registered (including reconciliation + Redis-based assignment timeouts)');
  }

  /**
   * H-18 FIX: Rehydrate overdue fallback timers from Redis sorted set on startup.
   * Processes timers that were stored in `timers:fallback` when the primary Redis
   * setTimer failed, and fires them immediately if they are overdue.
   */
  private async rehydrateFallbackTimers(): Promise<void> {
    try {
      const now = Date.now();
      const overdue = await redisService.zRangeByScore('timers:fallback', '-inf', String(now));
      if (overdue.length > 0) {
        logger.info(`[QueueMgmt] Rehydrating ${overdue.length} fallback timers from Redis`);
        for (const entry of overdue) {
          try {
            const data = JSON.parse(entry);
            const { assignmentService }: typeof import('../../modules/assignment/assignment.service') = require('../../modules/assignment/assignment.service');
            await assignmentService.handleAssignmentTimeout(data);
          } catch (e) { logger.warn('[QueueMgmt] Failed to rehydrate timer entry', { error: (e as Error).message }); }
        }
        await redisService.zRemRangeByScore('timers:fallback', '-inf', String(now));
      }
    } catch (e) { logger.warn('[QueueMgmt] Fallback timer rehydration failed', { error: (e as Error).message }); }
  }

  private resolveBroadcastOrderId(data: object): string {
    if (!data || typeof data !== 'object') return '';
    const d = data as Record<string, unknown>;
    const rawId = d.orderId || d.broadcastId || d.id;
    return typeof rawId === 'string' ? rawId.trim() : '';
  }

  private async getOrderStatusForQueueGuard(orderId: string): Promise<string | null> {
    const now = Date.now();
    const cached = this.orderStatusCache.get(orderId);
    if (cached && cached.expiresAt > now) {
      return cached.status;
    }

    const order = await prismaClient.order.findUnique({
      where: { id: orderId },
      select: { status: true }
    });
    const normalizedStatus = typeof order?.status === 'string'
      ? order.status.toLowerCase()
      : null;

    this.orderStatusCache.set(orderId, {
      status: normalizedStatus,
      expiresAt: now + this.orderStatusCacheTtlMs
    });

    // #138: Evict 100 entries at once instead of 1 — single-entry eviction means the map
    // spends time at 8001 after every insert above 8000, O(n) work per item.
    // Batch eviction reduces amortised cost and keeps the map well under limit.
    if (this.orderStatusCache.size > 8000) {
      const keysToDelete = [...this.orderStatusCache.keys()].slice(0, 100);
      keysToDelete.forEach(k => this.orderStatusCache.delete(k));
    }

    return normalizedStatus;
  }

  /**
   * Queue a broadcast to a transporter
   */
  async queueBroadcast(
    transporterId: string,
    event: string,
    data: object,
    priority: number = 0
  ): Promise<string> {
    // Phase 5: Queue depth backpressure — sampled check (every 2s, not per-call)
    await this.refreshBroadcastQueueDepth();
    if (this.broadcastDepthSnapshot.depth >= FF_QUEUE_DEPTH_CAP) {
      metrics.incrementCounter('broadcast_queue_backpressure_rejected', { event });
      logger.error('[Phase5] Broadcast DROPPED due to queue depth cap', {
        transporterId, event, depth: this.broadcastDepthSnapshot.depth, cap: FF_QUEUE_DEPTH_CAP
      });

      // Fix M-7: Store dropped broadcast in Redis DLQ for recovery
      try {
        const dlqEntry = JSON.stringify({
          transporterId, event, data,
          droppedAt: Date.now(), reason: 'queue_full'
        });
        await redisService.lPush('dlq:broadcasts', dlqEntry);
        // M-6 FIX: Configurable DLQ cap (env: DLQ_MAX_SIZE, default 5000)
        await redisService.lTrim('dlq:broadcasts', 0, DLQ_MAX_SIZE - 1);
      } catch {
        // DLQ write also failed -- log to stdout for CloudWatch
        logger.error('[CRITICAL] Broadcast dropped AND DLQ write failed', { transporterId, event });
      }

      throw new Error(`Broadcast queue depth ${this.broadcastDepthSnapshot.depth} exceeds cap ${FF_QUEUE_DEPTH_CAP}`);
    }

    // Phase 4: auto-assign priority from event type if flag enabled
    const effectivePriority = FF_MESSAGE_PRIORITY_ENABLED
      ? (EVENT_PRIORITY[event] ?? MessagePriority.NORMAL)
      : priority;

    // Phase 6: Track enqueue count by channel and priority
    metrics.incrementCounter('broadcast_delivery_enqueued', {
      channel: FF_DUAL_CHANNEL_DELIVERY ? 'dual' : 'socket',
      priority: String(effectivePriority)
    });

    return this.queue.add(
      QueueService.QUEUES.BROADCAST,
      'broadcast',
      { transporterId, event, data },
      { priority: effectivePriority }
    );
  }

  /**
   * Queue broadcasts to multiple transporters (batch)
   */
  async queueBroadcastBatch(
    transporterIds: string[],
    event: string,
    data: object
  ): Promise<string[]> {
    const jobs = transporterIds.map(transporterId => ({
      type: 'broadcast',
      data: { transporterId, event, data },
      priority: 0
    }));

    return this.queue.addBatch(QueueService.QUEUES.BROADCAST, jobs);
  }

  /**
   * Queue a push notification
   */
  async queuePushNotification(
    userId: string,
    notification: {
      title: string;
      body: string;
      data?: Record<string, string>;
    }
  ): Promise<string> {
    return this.queue.add(
      QueueService.QUEUES.PUSH_NOTIFICATION,
      'push',
      { userId, notification },
      { maxAttempts: 3 }
    );
  }

  /**
   * Queue push notifications to multiple users (batch)
   */
  async queuePushNotificationBatch(
    userIds: string[],
    notification: {
      title: string;
      body: string;
      data?: Record<string, string>;
    }
  ): Promise<string[]> {
    const jobs = userIds.map(userId => ({
      type: 'push',
      data: { userId, notification },
      priority: 0
    }));

    return this.queue.addBatch(QueueService.QUEUES.PUSH_NOTIFICATION, jobs);
  }

  /**
   * Batch FCM Push - Send to up to 500 drivers in ONE API call
   *
   * FCM supports up to 500 registration tokens per request.
   * This is critical for transporter broadcasts to many drivers.
   *
   * Queue job format:
   * {
   *   tokens: string[],  // FCM registration tokens
   *   notification: { title, body, data }
   * }
   */
  async queueBatchPush(
    tokens: string[],
    notification: {
      title: string;
      body: string;
      data?: Record<string, any>;
    }
  ): Promise<string> {
    // Remove empty/null tokens
    const validTokens = tokens.filter(t => t && t.length > 0);

    if (validTokens.length === 0) {
      logger.warn('[Queue] No valid FCM tokens for batch push');
      return 'empty';
    }

    // Batch size limits
    const BATCH_SIZE = 500;
    const batches: string[][] = [];

    for (let i = 0; i < validTokens.length; i += BATCH_SIZE) {
      batches.push(validTokens.slice(i, i + BATCH_SIZE));
    }

    let jobId = '';

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      jobId += await this.queue.add(
        QueueService.QUEUES.FCM_BATCH,
        'fcm_batch_send',
        { tokens: batch, notification },
        { maxAttempts: 3, priority: 2 }  // HIGH priority
      );
    }

    logger.info(`[Queue] Batch FCM queued: ${validTokens.length} tokens in ${batches.length} batch(es)`);
    return jobId;
  }

  /**
   * Schedule an assignment timeout using Redis sorted-set timers.
   *
   * FIX Problem 16: Replaced in-memory setTimeout with Redis-backed timer.
   * BEFORE: setTimeout in V8 process memory - lost on ECS restart.
   * AFTER:  Redis sorted-set timer (setTimer/getExpiredTimers infrastructure)
   *         - survives restarts, shared across ECS instances.
   *
   * SAFETY:
   *   - handleAssignmentTimeout() is 100% idempotent
   *   - ASSIGNMENT_RECONCILIATION (every 5 min) is the backstop
   */
  async scheduleAssignmentTimeout(data: {
    assignmentId: string;
    driverId: string;
    driverName: string;
    transporterId: string;
    vehicleId: string;
    vehicleNumber: string;
    bookingId?: string;  // Optional for multi-truck system
    tripId: string;
    createdAt: string;
    orderId?: string;      // Optional for multi-truck system
    truckRequestId?: string; // Optional for multi-truck system
  }, delayMs: number): Promise<string> {
    const timerKey = `timer:assignment-timeout:${data.assignmentId}`;
    const expiresAt = new Date(Date.now() + delayMs);

    try {
      await redisService.setTimer(timerKey, data, expiresAt);
      logger.info(`[TIMER] Assignment timeout set via Redis: ${data.assignmentId} fires in ${delayMs / 1000}s`);
    } catch (err: unknown) {
      // Fallback: use in-process setTimeout if Redis is unavailable
      logger.warn(`[TIMER] Redis setTimer failed, falling back to setTimeout: ${err instanceof Error ? err.message : String(err)}`);
      const expiresAtMs = Date.now() + delayMs;
      // #104: Also store the timer data in a Redis sorted-set as a backup so
      // the poller can recover it after a process restart even when setTimer failed.
      // This is best-effort: if Redis is down entirely, we rely on the DB reconciliation.
      await redisService.zAdd('timers:fallback', expiresAtMs, JSON.stringify(data)).catch(() => {});
      setTimeout(async () => {
        try {
          const { assignmentService }: typeof import('../../modules/assignment/assignment.service') = require('../../modules/assignment/assignment.service');
          await assignmentService.handleAssignmentTimeout(data);
          logger.info(`[TIMER] setTimeout fallback fired: ${data.assignmentId} (${data.driverName})`);
        } catch (timeoutErr: unknown) {
          logger.error('[TIMER] setTimeout fallback handler failed', {
            assignmentId: data.assignmentId,
            error: timeoutErr instanceof Error ? timeoutErr.message : String(timeoutErr)
          });
        }
      }, delayMs);
    }

    return timerKey;
  }

  /**
   * Cancel a scheduled assignment timeout (driver accepted or assignment cancelled).
   * FIX Problem 16: Replaces old clearTimeout pattern with Redis cancelTimer.
   */
  async cancelAssignmentTimeout(assignmentId: string): Promise<void> {
    const timerKey = `timer:assignment-timeout:${assignmentId}`;
    try {
      await redisService.cancelTimer(timerKey);
      logger.info(`[TIMER] Assignment timeout cancelled: ${assignmentId}`);
    } catch (err: unknown) {
      logger.warn(`[TIMER] Failed to cancel assignment timeout: ${assignmentId} - ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Queue tracking telemetry event for async fanout (Kinesis/MSK adapter later).
   */
  async queueTrackingEvent(event: TrackingEventPayload): Promise<string> {
    await this.refreshTrackingQueueDepth(false);
    if (this.trackingDepthSnapshot.depth >= TRACKING_QUEUE_HARD_LIMIT) {
      metrics.incrementCounter('tracking_queue_dropped_total', { reason: 'hard_limit' });
      logger.warn('Tracking event dropped due to queue hard limit', {
        hardLimit: TRACKING_QUEUE_HARD_LIMIT,
        depth: this.trackingDepthSnapshot.depth
      });
      return `dropped-${Date.now()}`;
    }

    return this.queue.add(
      QueueService.QUEUES.TRACKING_EVENTS,
      'tracking_event',
      event,
      { priority: -1, maxAttempts: 2 }
    );
  }

  private async refreshTrackingQueueDepth(force: boolean): Promise<void> {
    const nowMs = Date.now();
    const shouldRefresh = force ||
      (nowMs - this.trackingDepthSnapshot.sampledAtMs >= TRACKING_QUEUE_DEPTH_SAMPLE_MS);
    if (!shouldRefresh) return;

    if (this.trackingDepthSampleInFlight) {
      await this.trackingDepthSampleInFlight;
      return;
    }

    this.trackingDepthSampleInFlight = (async () => {
      try {
        const depth = await this.queue.getQueueDepth(QueueService.QUEUES.TRACKING_EVENTS);
        this.trackingDepthSnapshot = { depth, sampledAtMs: Date.now() };
        metrics.setGauge('tracking_queue_depth', depth);
        if (depth >= Math.floor(TRACKING_QUEUE_HARD_LIMIT * 0.8)) {
          logger.warn('Tracking queue depth nearing hard limit', {
            depth,
            hardLimit: TRACKING_QUEUE_HARD_LIMIT
          });
        }
      } catch (error: unknown) {
        logger.warn('Failed to sample tracking queue depth', {
          message: error instanceof Error ? error.message : 'unknown'
        });
      }
    })();

    await this.trackingDepthSampleInFlight;
    this.trackingDepthSampleInFlight = null;
  }

  private async refreshBroadcastQueueDepth(): Promise<void> {
    const nowMs = Date.now();
    // Sample every 2 seconds — avoids per-call Redis overhead
    if (nowMs - this.broadcastDepthSnapshot.sampledAtMs < 2000) return;

    if (this.broadcastDepthSampleInFlight) {
      await this.broadcastDepthSampleInFlight;
      return;
    }

    this.broadcastDepthSampleInFlight = (async () => {
      try {
        const depth = await this.queue.getQueueDepth(QueueService.QUEUES.BROADCAST);
        this.broadcastDepthSnapshot = { depth, sampledAtMs: Date.now() };
        metrics.setGauge('broadcast_queue_depth', depth);
        if (depth >= Math.floor(FF_QUEUE_DEPTH_CAP * 0.8)) {
          logger.warn('[Phase5] Broadcast queue depth nearing cap', {
            depth, cap: FF_QUEUE_DEPTH_CAP
          });
        }
      } catch (error: unknown) {
        logger.warn('[Phase5] Failed to sample broadcast queue depth', {
          message: error instanceof Error ? error.message : 'unknown'
        });
      }
    })();

    await this.broadcastDepthSampleInFlight;
    this.broadcastDepthSampleInFlight = null;
  }

  /**
   * Enqueue a job to a named queue with sensible defaults.
   * Convenience method used by callers that need retry semantics
   * (e.g., VEHICLE_RELEASE with maxAttempts=5, exponential backoff).
   */
  async enqueue<T>(
    queueName: string,
    data: T,
    options?: { priority?: number; delay?: number; maxAttempts?: number }
  ): Promise<string> {
    const maxAttempts = options?.maxAttempts ?? (queueName === QueueService.QUEUES.VEHICLE_RELEASE ? 5 : 3);
    return this.queue.add(queueName, queueName, data, { ...options, maxAttempts });
  }

  /**
   * Add custom job (full method name)
   */
  async addJob<T>(
    queueName: string,
    type: string,
    data: T,
    options?: { priority?: number; delay?: number; maxAttempts?: number }
  ): Promise<string> {
    return this.queue.add(queueName, type, data, options);
  }

  /**
   * Add job to queue (alias for addJob)
   *
   * EASY UNDERSTANDING: Shorter method name for convenience
   * CODING STANDARDS: Matches common queue library patterns
   */
  async add<T>(
    queueName: string,
    type: string,
    data: T,
    options?: { priority?: number; delay?: number; maxAttempts?: number }
  ): Promise<string> {
    return this.queue.add(queueName, type, data, options);
  }

  /**
   * Register custom processor
   */
  registerProcessor(queueName: string, processor: JobProcessor): void {
    this.queue.process(queueName, processor);
  }

  /**
   * Get queue statistics
   */
  getStats() {
    return this.queue.getStats();
  }

  // =========================================================================
  // Issue #25: DLQ consumer — inspect and alert on permanently failed jobs
  // =========================================================================

  /**
   * Process dead letter queue: log all permanently failed jobs and alert
   * when depth exceeds threshold. Returns the number of DLQ entries found.
   */
  async processDLQ(queueName: string): Promise<number> {
    const dlqKey = `dlq:${queueName}`;
    try {
      const failedJobs = await redisService.lRange(dlqKey, 0, -1);
      for (const jobData of failedJobs) {
        try {
          const job = JSON.parse(jobData);
          logger.error('[DLQ] Permanently failed job', {
            queue: queueName,
            jobId: job.id ?? 'unknown',
            error: job.error ?? job.lastError ?? 'unknown',
            attempts: job.attempts ?? job.maxAttempts ?? 'unknown',
            originalData: job.data ?? job
          });
        } catch {
          logger.error('[DLQ] Malformed DLQ entry', { queue: queueName, raw: jobData });
        }
      }
      const depth = failedJobs.length;
      if (depth > 10) {
        logger.error('[DLQ] ALERT: Queue depth exceeds threshold', { queue: queueName, depth });
      }
      return depth;
    } catch (err: unknown) {
      logger.warn(`[DLQ] Failed to read DLQ for ${queueName}: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  /**
   * Process all known DLQ queues (one pass).
   * Designed to be called from a periodic reconciliation interval.
   */
  async processAllDLQs(): Promise<Record<string, number>> {
    const results: Record<string, number> = {};
    for (const queueName of Object.values(QueueService.QUEUES)) {
      results[queueName] = await this.processDLQ(queueName);
    }
    // Also check the broadcasts DLQ (used by backpressure drop path)
    results['broadcasts'] = await this.processDLQ('broadcasts');
    return results;
  }

  /**
   * Stop all queue processing
   */
  stop(): void {
    this.queue.stop();
    this.trackingStreamSink.flush().catch((error: unknown) => {
      logger.warn('Failed to flush tracking stream sink during queue shutdown', {
        message: error instanceof Error ? error.message : 'unknown'
      });
    });
  }
}
