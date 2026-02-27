/**
 * =============================================================================
 * QUEUE SERVICE - Async Processing for Scalability
 * =============================================================================
 * 
 * CRITICAL FOR MILLIONS OF USERS:
 * - Async broadcast processing
 * - Push notification batching
 * - Background job processing
 * - Retry logic for failed operations
 * 
 * MODES:
 * 1. In-Memory Queue (Development/Small scale)
 * 2. Redis/Bull Queue (Production/Large scale) - AWS SQS ready
 * 
 * AWS DEPLOYMENT:
 * - Can be replaced with AWS SQS for even larger scale
 * - Or use Bull with ElastiCache Redis
 * 
 * =============================================================================
 */

import { logger } from './logger.service';
import { EventEmitter } from 'events';
import { redisService } from './redis.service';
import { createTrackingStreamSink } from './tracking-stream-sink';
import { metrics } from '../monitoring/metrics.service';
import { prismaClient } from '../database/prisma.service';

// =============================================================================
// TYPES
// =============================================================================

export interface QueueJob<T = any> {
  id: string;
  type: string;
  data: T;
  priority: number;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  processAfter?: number;
  error?: string;
}

export type JobProcessor<T = any> = (job: QueueJob<T>) => Promise<void>;

export interface TrackingEventPayload {
  driverId: string;
  tripId: string;
  bookingId?: string;
  orderId?: string;
  latitude: number;
  longitude: number;
  speed: number;
  bearing: number;
  ts: string;
  source: 'gps' | 'batch_sync' | 'system';
}

const TRACKING_QUEUE_HARD_LIMIT = Math.max(1000, parseInt(process.env.TRACKING_QUEUE_HARD_LIMIT || '200000', 10) || 200000);
const TRACKING_QUEUE_DEPTH_SAMPLE_MS = Math.max(100, parseInt(process.env.TRACKING_QUEUE_DEPTH_SAMPLE_MS || '500', 10) || 500);
const FF_CANCELLED_ORDER_QUEUE_GUARD = process.env.FF_CANCELLED_ORDER_QUEUE_GUARD !== 'false';
// FAIL-CLOSED by default: if guard lookup is ambiguous, we prefer dropping stale
// broadcast emissions to preserve cancellation correctness under race conditions.
const FF_CANCELLED_ORDER_QUEUE_GUARD_FAIL_OPEN = process.env.FF_CANCELLED_ORDER_QUEUE_GUARD_FAIL_OPEN === 'true';
const CANCELLED_ORDER_QUEUE_GUARD_CACHE_TTL_MS = Math.max(
  250,
  parseInt(process.env.CANCELLED_ORDER_QUEUE_GUARD_CACHE_TTL_MS || '1500', 10) || 1500
);

// =============================================================================
// IN-MEMORY QUEUE (Development / Single Server)
// =============================================================================

class InMemoryQueue extends EventEmitter {
  private queues: Map<string, QueueJob[]> = new Map();
  private processors: Map<string, JobProcessor> = new Map();
  private processing: Set<string> = new Set();
  private isRunning: boolean = false;
  private processInterval: ReturnType<typeof setInterval> | null = null;

  // Configuration
  private readonly concurrency: number = 10;
  private readonly pollInterval: number = 100; // ms

  constructor() {
    super();
    this.start();
  }

  /**
   * Add a job to the queue
   */
  async add<T>(
    queueName: string,
    type: string,
    data: T,
    options?: {
      priority?: number;
      delay?: number;
      maxAttempts?: number;
    }
  ): Promise<string> {
    const job: QueueJob<T> = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      data,
      priority: options?.priority ?? 0,
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? 3,
      createdAt: Date.now(),
      processAfter: options?.delay ? Date.now() + options.delay : undefined
    };

    if (!this.queues.has(queueName)) {
      this.queues.set(queueName, []);
    }

    const queue = this.queues.get(queueName)!;

    // Insert by priority (higher priority first)
    const insertIndex = queue.findIndex(j => j.priority < job.priority);
    if (insertIndex === -1) {
      queue.push(job);
    } else {
      queue.splice(insertIndex, 0, job);
    }

    logger.debug(`Job ${job.id} added to queue ${queueName} (type: ${type})`);
    this.emit('job:added', { queueName, job });

    return job.id;
  }

  /**
   * Add multiple jobs at once (batch)
   */
  async addBatch<T>(
    queueName: string,
    jobs: { type: string; data: T; priority?: number }[]
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const job of jobs) {
      const id = await this.add(queueName, job.type, job.data, { priority: job.priority });
      ids.push(id);
    }
    return ids;
  }

  /**
   * Register a processor for a queue
   */
  process(queueName: string, processor: JobProcessor): void {
    this.processors.set(queueName, processor);
    logger.info(`Processor registered for queue: ${queueName}`);
  }

  /**
   * Start processing jobs
   */
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.processInterval = setInterval(() => this.tick(), this.pollInterval);
    logger.info('🚀 Queue processor started');
  }

  /**
   * Stop processing jobs
   */
  stop(): void {
    this.isRunning = false;
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
    }
    logger.info('⏹️ Queue processor stopped');
  }

  /**
   * Process tick - check for jobs to process
   */
  private async tick(): Promise<void> {
    if (this.processing.size >= this.concurrency) return;

    for (const [queueName, queue] of this.queues) {
      const processor = this.processors.get(queueName);
      if (!processor) continue;

      // Find next processable job
      const jobIndex = queue.findIndex(job => {
        if (this.processing.has(job.id)) return false;
        if (job.processAfter && Date.now() < job.processAfter) return false;
        return true;
      });

      if (jobIndex === -1) continue;

      const job = queue[jobIndex];
      this.processing.add(job.id);

      // Process asynchronously
      this.processJob(queueName, job, processor, jobIndex);

      // Respect concurrency limit
      if (this.processing.size >= this.concurrency) break;
    }
  }

  /**
   * Process a single job
   */
  private async processJob(
    queueName: string,
    job: QueueJob,
    processor: JobProcessor,
    _jobIndex: number
  ): Promise<void> {
    try {
      job.attempts++;
      await processor(job);

      // Success - remove from queue
      const queue = this.queues.get(queueName);
      if (queue) {
        const idx = queue.indexOf(job);
        if (idx !== -1) queue.splice(idx, 1);
      }

      this.emit('job:completed', { queueName, job });
      logger.debug(`Job ${job.id} completed (${queueName})`);

    } catch (error: any) {
      job.error = error.message;

      if (job.attempts >= job.maxAttempts) {
        // Max retries reached - move to dead letter
        const queue = this.queues.get(queueName);
        if (queue) {
          const idx = queue.indexOf(job);
          if (idx !== -1) queue.splice(idx, 1);
        }

        this.emit('job:failed', { queueName, job, error: error.message });
        logger.error(`Job ${job.id} failed permanently: ${error.message}`);
      } else {
        // Schedule retry with exponential backoff
        job.processAfter = Date.now() + Math.pow(2, job.attempts) * 1000;
        this.emit('job:retry', { queueName, job, attempt: job.attempts });
        logger.warn(`Job ${job.id} failed, retry ${job.attempts}/${job.maxAttempts}`);
      }
    } finally {
      this.processing.delete(job.id);
    }
  }

  /**
   * Get queue stats
   */
  getStats(): {
    queues: { name: string; pending: number; processing: number }[];
    totalPending: number;
    totalProcessing: number;
  } {
    const queueStats = Array.from(this.queues.entries()).map(([name, jobs]) => ({
      name,
      pending: jobs.length,
      processing: jobs.filter(j => this.processing.has(j.id)).length
    }));

    return {
      queues: queueStats,
      totalPending: queueStats.reduce((sum, q) => sum + q.pending, 0),
      totalProcessing: this.processing.size
    };
  }

  async getQueueDepth(queueName: string): Promise<number> {
    return this.queues.get(queueName)?.length || 0;
  }
}

// =============================================================================
// REDIS QUEUE (Production / Horizontal Scaling / Persistent)
// =============================================================================
/**
 * PRODUCTION-GRADE REDIS QUEUE
 * 
 * SCALABILITY: 
 * - Jobs persist across server restarts
 * - Shared across all ECS tasks/containers
 * - Uses Redis LPUSH/BRPOP for reliable FIFO queue
 * - Supports millions of jobs per day
 * 
 * EASY UNDERSTANDING:
 * - Same interface as InMemoryQueue
 * - Auto-reconnects on Redis failure
 * - Dead letter queue for failed jobs
 * 
 * MODULARITY:
 * - Can be swapped for AWS SQS later
 * - Implements same IQueue interface
 * 
 * CODING STANDARDS:
 * - Uses existing redisService
 * - Follows same patterns as cache.service.ts
 */
class RedisQueue extends EventEmitter {
  private processors: Map<string, JobProcessor> = new Map();
  private processing: Set<string> = new Set();
  private isRunning: boolean = false;
  private queueInFlight: Map<string, number> = new Map();
  private queueWorkers: Map<string, Set<number>> = new Map();

  // Configuration
  private readonly defaultWorkerCount = Math.max(1, parseInt(process.env.REDIS_QUEUE_WORKERS || '2', 10) || 2);
  private readonly trackingWorkerCount = Math.max(1, parseInt(process.env.REDIS_QUEUE_TRACKING_WORKERS || '4', 10) || 4);
  private readonly blockingPopTimeoutSec = Math.max(1, parseInt(process.env.REDIS_QUEUE_BLOCKING_POP_TIMEOUT_SEC || '2', 10) || 2);
  private readonly queuePrefix: string = 'queue:';
  private readonly deadLetterPrefix: string = 'dlq:';

  constructor() {
    super();
    logger.info('🚀 Redis Queue initialized (Production Mode)');
  }

  /**
   * Get Redis key for a queue
   */
  private getQueueKey(queueName: string): string {
    return `${this.queuePrefix}${queueName}`;
  }

  /**
   * Get Redis key for dead letter queue
   */
  private getDeadLetterKey(queueName: string): string {
    return `${this.deadLetterPrefix}${queueName}`;
  }

  /**
   * Add a job to the queue
   * Uses Redis LPUSH for O(1) insertion
   */
  async add<T>(
    queueName: string,
    type: string,
    data: T,
    options?: {
      priority?: number;
      delay?: number;
      maxAttempts?: number;
    }
  ): Promise<string> {
    const job: QueueJob<T> = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      data,
      priority: options?.priority ?? 0,
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? 3,
      createdAt: Date.now(),
      processAfter: options?.delay ? Date.now() + options.delay : undefined
    };

    const queueKey = this.getQueueKey(queueName);

    try {
      // Use LPUSH to add to head of list (FIFO with BRPOP)
      await redisService.lPush(queueKey, JSON.stringify(job));

      logger.debug(`Redis Queue: Job ${job.id} added to ${queueName} (type: ${type})`);
      this.emit('job:added', { queueName, job });

      return job.id;
    } catch (error: any) {
      logger.error(`Redis Queue: Failed to add job to ${queueName}:`, error.message);
      throw error;
    }
  }

  /**
   * Add multiple jobs at once (batch)
   * SCALABILITY: Uses Redis pipeline for efficiency
   */
  async addBatch<T>(
    queueName: string,
    jobs: { type: string; data: T; priority?: number }[]
  ): Promise<string[]> {
    const ids: string[] = [];
    const queueKey = this.getQueueKey(queueName);

    try {
      const serializedJobs: string[] = [];
      for (const jobData of jobs) {
        const job: QueueJob<T> = {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          type: jobData.type,
          data: jobData.data,
          priority: jobData.priority ?? 0,
          attempts: 0,
          maxAttempts: 3,
          createdAt: Date.now()
        };

        ids.push(job.id);
        serializedJobs.push(JSON.stringify(job));
      }

      if (serializedJobs.length > 0) {
        await redisService.lPushMany(queueKey, serializedJobs);
      }

      logger.debug(`Redis Queue: Batch of ${ids.length} jobs added to ${queueName}`);
      return ids;
    } catch (error: any) {
      logger.error(`Redis Queue: Failed to add batch to ${queueName}:`, error.message);
      throw error;
    }
  }

  /**
   * Register a processor for a queue
   * Starts worker loops for that queue
   */
  process(queueName: string, processor: JobProcessor): void {
    this.processors.set(queueName, processor);

    if (!this.isRunning) {
      this.start();
    } else {
      this.startWorkersForQueue(queueName);
    }

    logger.info(`Redis Queue: Processor registered for ${queueName}`);
  }

  /**
   * Start queue workers
   */
  private startWorkersForQueue(queueName: string): void {
    const processor = this.processors.get(queueName);
    if (!processor || !this.isRunning) return;

    const targetWorkers = this.getWorkerCount(queueName);
    if (!this.queueWorkers.has(queueName)) {
      this.queueWorkers.set(queueName, new Set());
    }
    const workers = this.queueWorkers.get(queueName)!;

    for (let workerId = 0; workerId < targetWorkers; workerId += 1) {
      if (workers.has(workerId)) continue;
      workers.add(workerId);
      this.runWorkerLoop(queueName, workerId, processor).catch((error: any) => {
        logger.error(`Redis Queue: Worker crashed for ${queueName}`, {
          workerId,
          message: error?.message || 'unknown'
        });
      });
    }
  }

  private getWorkerCount(queueName: string): number {
    if (queueName === QueueService.QUEUES.TRACKING_EVENTS) {
      return this.trackingWorkerCount;
    }
    return this.defaultWorkerCount;
  }

  private async runWorkerLoop(queueName: string, workerId: number, processor: JobProcessor): Promise<void> {
    const queueKey = this.getQueueKey(queueName);

    while (this.isRunning && this.processors.get(queueName) === processor) {
      try {
        const jobStr = await redisService.brPop(queueKey, this.blockingPopTimeoutSec);
        if (!jobStr) {
          // Queue empty — sleep before polling again to avoid busy-spinning
          await this.sleep(500);
          continue;
        }

        const job: QueueJob = JSON.parse(jobStr);
        if (job.processAfter && Date.now() < job.processAfter) {
          await redisService.lPush(queueKey, JSON.stringify(job));
          await this.sleep(Math.min(200, Math.max(10, job.processAfter - Date.now())));
          continue;
        }

        this.processing.add(job.id);
        this.incrementInFlight(queueName);
        await this.processJob(queueName, job, processor);
      } catch (error: any) {
        logger.error(`Redis Queue: Worker error for ${queueName}`, {
          workerId,
          message: error?.message || 'unknown'
        });
        // CRITICAL FIX: Use 2000ms backoff (was 50ms) to prevent Redis command
        // storm. 6 workers × 50ms = 120 commands/sec on a dead connection,
        // exhausting ElastiCache Serverless connection limit and causing every
        // API request (OTP, rate-limit, toggle) to hang for commandTimeout ms.
        await this.sleep(2000);
      }
    }

    const workers = this.queueWorkers.get(queueName);
    workers?.delete(workerId);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private incrementInFlight(queueName: string): void {
    const current = this.queueInFlight.get(queueName) || 0;
    this.queueInFlight.set(queueName, current + 1);
    if (queueName === QueueService.QUEUES.TRACKING_EVENTS) {
      metrics.setGauge('tracking_queue_inflight', current + 1);
    }
  }

  private decrementInFlight(queueName: string): void {
    const current = this.queueInFlight.get(queueName) || 0;
    const next = Math.max(0, current - 1);
    this.queueInFlight.set(queueName, next);
    if (queueName === QueueService.QUEUES.TRACKING_EVENTS) {
      metrics.setGauge('tracking_queue_inflight', next);
    }
  }

  /**
   * Process a single job
   */
  private async processJob(
    queueName: string,
    job: QueueJob,
    processor: JobProcessor
  ): Promise<void> {
    try {
      job.attempts++;
      await processor(job);

      this.emit('job:completed', { queueName, job });
      logger.debug(`Redis Queue: Job ${job.id} completed (${queueName})`);

    } catch (error: any) {
      job.error = error.message;

      if (job.attempts >= job.maxAttempts) {
        // Max retries reached - move to dead letter queue
        const dlqKey = this.getDeadLetterKey(queueName);
        await redisService.lPush(dlqKey, JSON.stringify(job));

        this.emit('job:failed', { queueName, job, error: error.message });
        logger.error(`Redis Queue: Job ${job.id} failed permanently, moved to DLQ`);
      } else {
        // Re-queue with exponential backoff
        job.processAfter = Date.now() + Math.pow(2, job.attempts) * 1000;
        const queueKey = this.getQueueKey(queueName);
        await redisService.lPush(queueKey, JSON.stringify(job));

        this.emit('job:retry', { queueName, job, attempt: job.attempts });
        logger.warn(`Redis Queue: Job ${job.id} failed, retry ${job.attempts}/${job.maxAttempts}`);
      }
    } finally {
      this.processing.delete(job.id);
      this.decrementInFlight(queueName);
    }
  }

  /**
   * Start processing (called automatically when processor is registered)
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    for (const queueName of this.processors.keys()) {
      this.startWorkersForQueue(queueName);
    }
    logger.info('🚀 Redis Queue processor started');
  }

  /**
   * Stop processing jobs
   */
  stop(): void {
    this.isRunning = false;
    this.queueWorkers.clear();

    logger.info('⏹️ Redis Queue processor stopped');
  }

  /**
   * Get queue stats
   */
  async getStats(): Promise<{
    queues: { name: string; pending: number; processing: number }[];
    totalPending: number;
    totalProcessing: number;
  }> {
    const queueStats: { name: string; pending: number; processing: number }[] = [];

    for (const queueName of this.processors.keys()) {
      const queueKey = this.getQueueKey(queueName);
      const pending = await redisService.lLen(queueKey);

      queueStats.push({
        name: queueName,
        pending,
        processing: this.queueInFlight.get(queueName) || 0
      });
    }

    return {
      queues: queueStats,
      totalPending: queueStats.reduce((sum, q) => sum + q.pending, 0),
      totalProcessing: this.processing.size
    };
  }

  async getQueueDepth(queueName: string): Promise<number> {
    return redisService.lLen(this.getQueueKey(queueName));
  }
}

// =============================================================================
// QUEUE INTERFACE (Unified type for both implementations)
// =============================================================================

interface IQueue {
  add<T>(queueName: string, type: string, data: T, options?: { priority?: number; delay?: number; maxAttempts?: number }): Promise<string>;
  addBatch<T>(queueName: string, jobs: { type: string; data: T; priority?: number }[]): Promise<string[]>;
  process(queueName: string, processor: JobProcessor): void;
  start(): void;
  stop(): void;
  getStats(): any;
  getQueueDepth(queueName: string): Promise<number>;
}

// =============================================================================
// QUEUE SERVICE (Unified Interface - Auto-selects Redis in Production)
// =============================================================================

class QueueService {
  private queue: IQueue;
  private isRedisMode: boolean = false;
  private readonly trackingStreamSink = createTrackingStreamSink();
  private trackingDepthSnapshot: { depth: number; sampledAtMs: number } = { depth: 0, sampledAtMs: 0 };
  private trackingDepthSampleInFlight: Promise<void> | null = null;
  private readonly cancelledOrderQueueGuardEnabled = FF_CANCELLED_ORDER_QUEUE_GUARD;
  private readonly cancelledOrderQueueGuardFailOpen = FF_CANCELLED_ORDER_QUEUE_GUARD_FAIL_OPEN;
  private readonly inactiveOrderStatuses = new Set(['cancelled', 'expired', 'completed', 'fully_filled']);
  private readonly orderStatusCacheTtlMs = CANCELLED_ORDER_QUEUE_GUARD_CACHE_TTL_MS;
  private readonly orderStatusCache = new Map<string, { status: string | null; expiresAt: number }>();

  // Queue names for organization
  static readonly QUEUES = {
    BROADCAST: 'broadcast',           // Broadcast notifications to transporters
    PUSH_NOTIFICATION: 'push',        // FCM push notifications
    TRACKING_EVENTS: 'tracking-events', // Driver telemetry stream fanout
    EMAIL: 'email',                   // Email notifications (future)
    SMS: 'sms',                       // SMS notifications (future)
    ANALYTICS: 'analytics',           // Analytics events
    CLEANUP: 'cleanup',               // Cleanup/maintenance tasks
    CUSTOM_BOOKING: 'custom-booking'  // Custom booking events
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
      this.isRedisMode = true;
      logger.info('✅ Queue Service: Using Redis Queue (Production Mode)');
    } else {
      this.queue = new InMemoryQueue();
      this.isRedisMode = false;
      logger.info('📦 Queue Service: Using In-Memory Queue (Development Mode)');
    }

    this.registerDefaultProcessors();
  }

  /**
   * Register default job processors
   */
  private registerDefaultProcessors(): void {
    // Broadcast processor
    this.queue.process(QueueService.QUEUES.BROADCAST, async (job) => {
      const { emitToUser } = require('./socket.service');
      const { transporterId, event, data } = job.data;

      if (
        this.cancelledOrderQueueGuardEnabled &&
        (event === 'new_broadcast' || event === 'new_truck_request')
      ) {
        const metric = 'broadcast.queue.drop_inactive';
        const metricLabelsBase = { event };
        const orderId = this.resolveBroadcastOrderId(data);
        if (!orderId) {
          if (this.cancelledOrderQueueGuardFailOpen) {
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
          const orderStatus = await this.getOrderStatusForQueueGuard(orderId);
          if (!orderStatus) {
            lookupOutcome = 'order_not_found';
            if (this.cancelledOrderQueueGuardFailOpen) {
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

          if (this.inactiveOrderStatuses.has(orderStatus)) {
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
        } catch (error: any) {
          lookupOutcome = 'lookup_error';
          if (this.cancelledOrderQueueGuardFailOpen) {
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
              error: error?.message || 'unknown'
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
            error: error?.message || 'unknown'
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

      emitToUser(transporterId, event, data);
    });

    // Push notification processor
    this.queue.process(QueueService.QUEUES.PUSH_NOTIFICATION, async (job) => {
      const { sendPushNotification } = require('./fcm.service');
      const { userId, notification } = job.data;
      await sendPushNotification(userId, notification);
    });

    // Tracking stream processor (sink pluggable via env/integration service).
    // Default sink is no-op to avoid blocking hot path when no sink is configured.
    this.queue.process(QueueService.QUEUES.TRACKING_EVENTS, async (job) => {
      await this.trackingStreamSink.publishTrackingEvents([job.data as TrackingEventPayload]);
    });

    logger.info('📋 Queue processors registered');
  }

  private resolveBroadcastOrderId(data: any): string {
    if (!data || typeof data !== 'object') return '';
    const rawId = data.orderId || data.broadcastId || data.id;
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

    if (this.orderStatusCache.size > 8000) {
      const oldestKey = this.orderStatusCache.keys().next().value;
      if (oldestKey) this.orderStatusCache.delete(oldestKey);
    }

    return normalizedStatus;
  }

  /**
   * Queue a broadcast to a transporter
   */
  async queueBroadcast(
    transporterId: string,
    event: string,
    data: any,
    priority: number = 0
  ): Promise<string> {
    return this.queue.add(
      QueueService.QUEUES.BROADCAST,
      'broadcast',
      { transporterId, event, data },
      { priority }
    );
  }

  /**
   * Queue broadcasts to multiple transporters (batch)
   */
  async queueBroadcastBatch(
    transporterIds: string[],
    event: string,
    data: any
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
      } catch (error: any) {
        logger.warn('Failed to sample tracking queue depth', {
          message: error?.message || 'unknown'
        });
      }
    })();

    await this.trackingDepthSampleInFlight;
    this.trackingDepthSampleInFlight = null;
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

  /**
   * Stop all queue processing
   */
  stop(): void {
    this.queue.stop();
    this.trackingStreamSink.flush().catch((error: any) => {
      logger.warn('Failed to flush tracking stream sink during queue shutdown', {
        message: error?.message || 'unknown'
      });
    });
  }
}

// Export singleton
export const queueService = new QueueService();
