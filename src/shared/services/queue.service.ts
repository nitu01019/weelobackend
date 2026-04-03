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
import * as admin from 'firebase-admin';

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
// PHASE 4 — GUARANTEED DELIVERY FLAGS & CONFIG
// =============================================================================

/** Sequence-numbered delivery + unacked queue + replay on reconnect */
const FF_SEQUENCE_DELIVERY_ENABLED = process.env.FF_SEQUENCE_DELIVERY_ENABLED === 'true';

/** Parallel Socket.IO + FCM delivery for every broadcast */
const FF_DUAL_CHANNEL_DELIVERY = process.env.FF_DUAL_CHANNEL_DELIVERY === 'true';

/** Message TTL enforcement — drop stale messages before emitting */
const FF_MESSAGE_TTL_ENABLED = process.env.FF_MESSAGE_TTL_ENABLED === 'true';

/** Priority drain order — CRITICAL(1) → HIGH(2) → NORMAL(3) → LOW(4) */
const FF_MESSAGE_PRIORITY_ENABLED = process.env.FF_MESSAGE_PRIORITY_ENABLED === 'true';

/** Unacked queue TTL in seconds (10 minutes — covers reconnect window) */
const UNACKED_QUEUE_TTL_SECONDS = 600;

/** Message TTL per event type (milliseconds) */
const MESSAGE_TTL_MS: Record<string, number> = {
  'new_broadcast': 90_000,          // 90s — order expires at 5 min but show only recent
  'new_truck_request': 90_000,      // 90s — same as new_broadcast
  'accept_confirmation': 60_000,    // 60s — must be instant; stale = confusing
  'order_cancelled': 300_000,       // 300s — must always arrive even on slow network
  'order_expired': 300_000,         // 300s — critical lifecycle event
  'trip_assigned': 120_000,         // 120s — driver must see this
  'booking_updated': 120_000,       // 120s — important update
  'trucks_remaining_update': 30_000 // 30s — informational only
};

/** Default TTL for events not in the map above */
const DEFAULT_MESSAGE_TTL_MS = 120_000;

/** Priority levels for message ordering */
export const MessagePriority = {
  CRITICAL: 1, // order_cancelled, trip_cancelled, driver_timeout
  HIGH: 2,     // accept_confirmation, trip_assigned, booking_updated
  NORMAL: 3,   // new_broadcast, new_truck_request
  LOW: 4       // trucks_remaining_update, telemetry, driver_status_changed
} as const;

/** Map event types to priority levels */
const EVENT_PRIORITY: Record<string, number> = {
  'order_cancelled': MessagePriority.CRITICAL,
  'order_expired': MessagePriority.CRITICAL,
  'trip_cancelled': MessagePriority.CRITICAL,
  'driver_timeout': MessagePriority.CRITICAL,
  'accept_confirmation': MessagePriority.HIGH,
  'trip_assigned': MessagePriority.HIGH,
  'booking_updated': MessagePriority.HIGH,
  'new_broadcast': MessagePriority.NORMAL,
  'new_truck_request': MessagePriority.NORMAL,
  'trucks_remaining_update': MessagePriority.LOW,
  'driver_status_changed': MessagePriority.LOW
};

/** Phase 5: Queue depth cap for broadcast backpressure */
const FF_QUEUE_DEPTH_CAP = Math.max(
  100,
  parseInt(process.env.FF_QUEUE_DEPTH_CAP || '10000', 10) || 10000
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
    // L1 FIX: unref() so queue polling doesn't block process exit
    this.processInterval.unref();
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

        // Persist to Redis DLQ for observability and potential recovery
        try {
          const dlqKey = `dlq:${queueName}`;
          const dlqEntry = JSON.stringify({
            jobId: job.id,
            type: job.type,
            data: job.data,
            error: error.message,
            attempts: job.attempts,
            failedAt: new Date().toISOString()
          });
          await redisService.lPush(dlqKey, dlqEntry);
          // Cap at 1000 entries to prevent unbounded growth
          await redisService.lTrim(dlqKey, 0, 999);
          // 7-day TTL — old DLQ entries auto-expire
          await redisService.expire(dlqKey, 7 * 24 * 60 * 60);
        } catch (dlqErr: any) {
          // DLQ persistence is best-effort — don't break the failure handler
          logger.warn(`[DLQ] Failed to persist dead letter for ${job.id}: ${dlqErr.message}`);
        }
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
  private readonly processingPrefix: string = 'processing:';
  private readonly delayedPrefix: string = 'delayed:';
  private delayPollerInterval: ReturnType<typeof setInterval> | null = null;

  // At-least-once delivery: max age (ms) before a processing job is considered stale
  // and re-enqueued on startup. 5 minutes is generous — most jobs complete in <10s.
  private readonly STALE_PROCESSING_THRESHOLD_MS = 5 * 60 * 1000;

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
   * Get Redis key for processing hash (at-least-once delivery)
   * Stores jobs being processed — recovered on crash/restart
   */
  private getProcessingKey(queueName: string): string {
    return `${this.processingPrefix}${queueName}`;
  }

  /**
   * Get Redis key for delayed sorted set
   * Jobs with processAfter sit here until ready, then moved to main queue
   */
  private getDelayedKey(queueName: string): string {
    return `${this.delayedPrefix}${queueName}`;
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

    try {
      if (job.processAfter) {
        // Bug #3 fix: Delayed jobs go to Redis Sorted Set (ZADD) instead of main LIST.
        // A poller moves them to the main queue when ready — zero busy-polling.
        const delayedKey = this.getDelayedKey(queueName);
        await redisService.zAdd(delayedKey, job.processAfter, JSON.stringify(job));
        logger.debug(`Redis Queue: Job ${job.id} delayed until ${new Date(job.processAfter).toISOString()} in ${queueName}`);
      } else {
        // Immediate jobs go to main LIST as before (FIFO with BRPOP)
        const queueKey = this.getQueueKey(queueName);
        await redisService.lPush(queueKey, JSON.stringify(job));
        logger.debug(`Redis Queue: Job ${job.id} added to ${queueName} (type: ${type})`);
      }

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
   * Start queue workers + recover any stale processing jobs from a previous crash
   */
  private startWorkersForQueue(queueName: string): void {
    const processor = this.processors.get(queueName);
    if (!processor || !this.isRunning) return;

    // Bug #2 fix: Recover stale processing jobs left behind by a crash.
    // On startup, scan the processing hash and re-enqueue anything older than threshold.
    this.recoverStaleProcessingJobs(queueName).catch((err: any) => {
      logger.warn(`[Queue] Failed to recover processing jobs for ${queueName}: ${err.message}`);
    });

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

  /**
   * Bug #2: Recover jobs that were being processed when ECS crashed.
   * Scans the processing:{queueName} hash. If a job's createdAt is older
   * than STALE_PROCESSING_THRESHOLD_MS, re-enqueue it to the main queue.
   * Industry pattern: Sidekiq's "reliable fetch" + Bull's "stalled job recovery".
   */
  private async recoverStaleProcessingJobs(queueName: string): Promise<void> {
    const processingKey = this.getProcessingKey(queueName);
    const staleJobs = await redisService.hGetAll(processingKey);
    const jobIds = Object.keys(staleJobs);
    if (jobIds.length === 0) return;

    const now = Date.now();
    let recoveredCount = 0;

    for (const jobId of jobIds) {
      try {
        const job: QueueJob = JSON.parse(staleJobs[jobId]);
        const processingAgeMs = now - (job.createdAt || 0);

        if (processingAgeMs > this.STALE_PROCESSING_THRESHOLD_MS) {
          // Stale — re-enqueue to main queue for reprocessing
          const queueKey = this.getQueueKey(queueName);
          await redisService.lPush(queueKey, staleJobs[jobId]);
          await redisService.hDel(processingKey, jobId);
          recoveredCount++;
          logger.warn(`[Queue] Recovered stale processing job ${jobId} (${queueName}, age: ${Math.round(processingAgeMs / 1000)}s)`);
        }
        // If not stale, another worker may still be processing it — leave it alone
      } catch (err: any) {
        // Corrupt entry — remove it
        await redisService.hDel(processingKey, jobId).catch(() => {});
        logger.warn(`[Queue] Removed corrupt processing entry ${jobId}: ${err.message}`);
      }
    }

    if (recoveredCount > 0) {
      logger.warn(`[Queue] 🔄 Recovered ${recoveredCount} stale job(s) for ${queueName}`);
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
    const processingKey = this.getProcessingKey(queueName);

    while (this.isRunning && this.processors.get(queueName) === processor) {
      try {
        const jobStr = await redisService.brPop(queueKey, this.blockingPopTimeoutSec);
        if (!jobStr) {
          // Queue empty — sleep before polling again to avoid busy-spinning
          await this.sleep(500);
          continue;
        }

        const job: QueueJob = JSON.parse(jobStr);

        // Bug #3 fix: processAfter check is no longer needed here.
        // Delayed jobs now sit in a Redis Sorted Set and are only moved to the
        // main queue when ready. Any residual processAfter jobs (from before
        // this fix was deployed) are handled gracefully — just process them.

        // Bug #2 fix: Save to processing hash BEFORE processing.
        // If ECS crashes after BRPOP but before completion, this job
        // will be recovered from the processing hash on next startup.
        await redisService.hSet(processingKey, job.id, jobStr).catch(() => {});

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
    const processingKey = this.getProcessingKey(queueName);
    try {
      job.attempts++;
      await processor(job);

      // Bug #2 fix: Remove from processing hash on success
      await redisService.hDel(processingKey, job.id).catch(() => {});

      this.emit('job:completed', { queueName, job });
      logger.debug(`Redis Queue: Job ${job.id} completed (${queueName})`);

    } catch (error: any) {
      job.error = error.message;

      // Bug #2 fix: Remove from processing hash on failure too (will be re-enqueued or DLQ'd)
      await redisService.hDel(processingKey, job.id).catch(() => {});

      if (job.attempts >= job.maxAttempts) {
        // Max retries reached - move to dead letter queue
        const dlqKey = this.getDeadLetterKey(queueName);
        await redisService.lPush(dlqKey, JSON.stringify(job));

        this.emit('job:failed', { queueName, job, error: error.message });
        logger.error(`Redis Queue: Job ${job.id} failed permanently, moved to DLQ`);
      } else {
        // Bug #3 fix: Re-queue with exponential backoff via Sorted Set (not LPUSH)
        // This prevents the retry from being busy-polled in the main queue.
        job.processAfter = Date.now() + Math.pow(2, job.attempts) * 1000;
        const delayedKey = this.getDelayedKey(queueName);
        await redisService.zAdd(delayedKey, job.processAfter, JSON.stringify(job));

        this.emit('job:retry', { queueName, job, attempt: job.attempts });
        logger.warn(`Redis Queue: Job ${job.id} failed, retry ${job.attempts}/${job.maxAttempts} at ${new Date(job.processAfter).toISOString()}`);
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
    // Bug #3 fix: Start the delay poller that moves ready jobs from sorted sets to main queues
    this.startDelayPoller();
    logger.info('🚀 Redis Queue processor started');
  }

  /**
   * Stop processing jobs
   */
  stop(): void {
    this.isRunning = false;
    this.queueWorkers.clear();
    if (this.delayPollerInterval) {
      clearInterval(this.delayPollerInterval);
      this.delayPollerInterval = null;
    }
    logger.info('⏹️ Redis Queue processor stopped');
  }

  /**
   * Bug #3 fix: Delay Poller — moves ready delayed jobs to main queue.
   * Industry pattern (Bull/Celery): Delayed jobs sit in a Redis Sorted Set
   * with score = processAfter timestamp. Every 1 second, this poller runs
   * ZRANGEBYSCORE to find ready jobs and RPUSH them to the main LIST queue.
   * Workers pick them up via BRPOP as normal — zero busy-polling.
   */
  private startDelayPoller(): void {
    if (this.delayPollerInterval) return;

    this.delayPollerInterval = setInterval(async () => {
      if (!this.isRunning) return;

      for (const queueName of this.processors.keys()) {
        try {
          const delayedKey = this.getDelayedKey(queueName);
          const now = Date.now();

          // Find all jobs whose processAfter timestamp has passed
          const readyJobs = await redisService.zRangeByScore(delayedKey, 0, now);
          if (readyJobs.length === 0) continue;

          // Move each ready job to the main queue
          const queueKey = this.getQueueKey(queueName);
          for (const jobStr of readyJobs) {
            await redisService.lPush(queueKey, jobStr);
          }

          // Remove moved jobs from the sorted set
          await redisService.zRemRangeByScore(delayedKey, 0, now);

          if (readyJobs.length > 0) {
            logger.debug(`[DelayPoller] Moved ${readyJobs.length} ready job(s) from delayed:${queueName} to queue`);
          }
        } catch (err: any) {
          // Non-fatal — jobs stay in sorted set, will be picked up next iteration
          logger.warn(`[DelayPoller] Error for ${queueName}: ${err.message}`);
        }
      }
    }, 1000); // Poll every 1 second — lightweight, just a ZRANGEBYSCORE per queue

    this.delayPollerInterval.unref(); // Don't prevent Node.js from exiting
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
    HOLD_EXPIRY: 'hold-expiry'  // Periodic hold expiry cleanup jobs
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
    // H18 FIX: Add type annotations to lazy require() calls for type safety
    this.queue.process(QueueService.QUEUES.BROADCAST, async (job) => {
      const { emitToUser }: typeof import('./socket.service') = require('./socket.service');
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
          // Step 1: increment seq counter (must be sequential — need value)
          seq = await redisService.incr(`socket:seq:${transporterId}`);
          const envelope = JSON.stringify({
            seq, event, payload: data, createdAt: job.createdAt
          });
          // Step 2: store in unacked set + refresh TTL (parallel — independent ops)
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
        } catch (seqError: any) {
          // Sequence numbering is best-effort — never block delivery
          logger.warn('[Phase4] Sequence numbering failed, delivering without seq', {
            transporterId, error: seqError?.message
          });
        }
      }

      // === PHASE 4: DUAL-CHANNEL DELIVERY (flag-gated) ===
      // Phase 6: Measure delivery latency from enqueue to completion
      const deliveryStart = Date.now();
      if (FF_DUAL_CHANNEL_DELIVERY) {
        const { sendPushNotification }: typeof import('./fcm.service') = require('./fcm.service');
        // Fire both channels in parallel — neither blocks the other
        const results = await Promise.allSettled([
          // Channel A: Socket.IO (primary, foreground)
          Promise.resolve().then(() => {
            emitToUser(transporterId, event, data);
            metrics.incrementCounter('broadcast_delivery_delivered', { channel: 'socket' });
          }),
          // Channel B: FCM Push (fallback, background/offline)
          // Phase 5: fcmCircuit wraps FCM — when open, skips FCM entirely
          (async () => {
            const { fcmCircuit }: typeof import('./circuit-breaker.service') = require('./circuit-breaker.service');
            return fcmCircuit.tryWithFallback(
              async () => {
                await sendPushNotification(transporterId, {
                  title: data?.pickupCity
                    ? `🚛 ${data.trucksNeeded || ''}x Truck Required`
                    : 'New Broadcast',
                  body: data?.pickupCity && data?.dropCity
                    ? `${data.pickupCity} → ${data.dropCity} • ₹${data.farePerTruck || ''}/truck`
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
        // Original path — Socket.IO only
        emitToUser(transporterId, event, data);
        metrics.incrementCounter('broadcast_delivery_delivered', { channel: 'socket' });
      }
      // Phase 6: Delivery latency (enqueue → emit completion)
      metrics.observeHistogram('broadcast_delivery_latency_ms', Date.now() - deliveryStart, {
        channel: FF_DUAL_CHANNEL_DELIVERY ? 'dual' : 'socket'
      });
    });

    // Push notification processor
    // Circuit breaker wraps FCM — when open, skips push (Socket.IO is primary delivery)
    this.queue.process(QueueService.QUEUES.PUSH_NOTIFICATION, async (job) => {
      const { sendPushNotification }: typeof import('./fcm.service') = require('./fcm.service');
      const { fcmCircuit }: typeof import('./circuit-breaker.service') = require('./circuit-breaker.service');
      const { userId, notification } = job.data;

      await fcmCircuit.tryWithFallback(
        async () => {
          await sendPushNotification(userId, notification);
        },
        async () => {
          // Circuit open — skip FCM push (Socket.IO is primary delivery channel)
          logger.info(`[FCM] Circuit open — skipping push for user ${userId} (Socket.IO primary)`);
        }
      );
    });

    // FCM batch processor - sends to up to 500 drivers in ONE API call
    // Circuit breaker wraps entire batch — when open, skips batch FCM entirely
    this.queue.process(QueueService.QUEUES.FCM_BATCH, async (job) => {
      const { fcmCircuit }: typeof import('./circuit-breaker.service') = require('./circuit-breaker.service');
      const { tokens, notification } = job.data;

      await fcmCircuit.tryWithFallback(
        async () => {
          // Import fcmService
          const fcmService = (await import('./fcm.service')).fcmService;

          // Get FCM SDK
          let admin: any;
          try {
            admin = require('firebase-admin');
          } catch (error) {
            logger.warn('[FCM_BATCH] Firebase Admin not available, falling back to individual sends');
            // Fallback: Send one-by-one using fcmService
            for (const token of tokens) {
              try {
                await fcmService.sendToTokens([token], {
                  type: notification.data?.type || 'general',
                  title: notification.title,
                  body: notification.body,
                  priority: 'high',
                  data: notification.data
                });
              } catch (err) {
                if (err?.code === 'messaging/registration-token-not-registered') {
                  // Token invalid, remove from Redis
                  await redisService.del(`fcm_token:${token}`);
                }
              }
            }
            return;
          }

          // Use Firebase Admin SDK multicast for batch send
          // FCM supports up to 500 tokens per request
          if (tokens.length === 1) {
            await fcmService.sendToTokens(tokens, {
              type: notification.data?.type || 'general',
              title: notification.title,
              body: notification.body,
              priority: 'high',
              data: notification.data
            });
          } else {
            const batchResponse = await admin.messaging().sendMulticast({
              tokens: tokens.slice(0, 500),  // FCM limit: 500
              notification: {
                title: notification.title,
                body: notification.body
              },
              data: notification.data || {}
            });

            const successCount = batchResponse.successCount || 0;
            const failureCount = (tokens.length || 1) - successCount;

            logger.info(`[FCM_BATCH] Sent to ${tokens.length} drivers: ${successCount} succeeded, ${failureCount} failed`);

            // Remove invalid tokens from Redis
            for (const token of tokens) {
              const index = batchResponse.responses.findIndex(r => r.success === false);
              if (index !== -1 && batchResponse.responses[index].error?.code === 'messaging/registration-token-not-registered') {
                await redisService.del(`fcm_token:${token}`);
              }
            }
          }
        },
        async () => {
          // Circuit open — skip batch FCM (Socket.IO is primary delivery channel)
          logger.info(`[FCM_BATCH] Circuit open — skipping batch push for ${tokens.length} tokens (Socket.IO primary)`);
        }
      );
    });

    // Tracking stream processor (sink pluggable via env/integration service).
    // Default sink is no-op to avoid blocking hot path when no sink is configured.
    this.queue.process(QueueService.QUEUES.TRACKING_EVENTS, async (job) => {
      await this.trackingStreamSink.publishTrackingEvents([job.data as TrackingEventPayload]);
    });

    // =========================================================================
    // ASSIGNMENT_TIMEOUT queue processor REMOVED (Uber/Ola pattern)
    // Self-destruct timers now use setTimeout directly in scheduleAssignmentTimeout().
    // Zero Redis hops. Timer lives in V8 process memory — guaranteed to fire.
    // Existing ASSIGNMENT_RECONCILIATION (below) catches the 0.01% edge case
    // where ECS restarts during the 30s timer window.
    // =========================================================================

    // =========================================================================
    // RECONCILIATION JOB — Safety net for orphaned pending assignments
    // Industry pattern (Uber uTask): Periodic background sweep catches orphaned
    // records left behind when queue/Redis was down during assignment creation.
    // Runs every 5 minutes via setInterval. Uses distributed lock — safe on
    // multiple ECS instances.
    // =========================================================================
    this.queue.process(QueueService.QUEUES.ASSIGNMENT_RECONCILIATION, async (job) => {
      const lockKey = 'lock:assignment-reconciliation';
      const lock = await redisService.acquireLock(lockKey, 'reconciler', 120);
      if (!lock.acquired) {
        return; // Another instance is processing
      }

      try {
        // =====================================================================
        // PHASE 1: Orphaned PENDING assignments (ECS restart during 30s timer)
        // =====================================================================
        // assignedAt is String (ISO), so compare as string — ISO strings sort lexicographically
        const threeMinutesAgoISO = new Date(Date.now() - 3 * 60 * 1000).toISOString();
        const orphaned = await prismaClient.assignment.findMany({
          where: {
            status: 'pending',
            assignedAt: { lt: threeMinutesAgoISO }
          },
          take: 100
        });

        if (orphaned.length > 0) {
          logger.warn(`[RECONCILIATION] Found ${orphaned.length} orphaned pending assignments`);

          // Use the FULL handleAssignmentTimeout pipeline (same as normal timeout).
          // This includes: status update, vehicle release, booking decrement,
          // transporter notification, driver notification, booking room emit, FCM push.
          // Industry pattern (Uber uTask): reconciliation uses same cleanup path as normal flow.
          const { assignmentService }: typeof import('../../modules/assignment/assignment.service') = require('../../modules/assignment/assignment.service');

          for (const assignment of orphaned) {
            try {
              await assignmentService.handleAssignmentTimeout({
                assignmentId: assignment.id,
                driverId: assignment.driverId,
                driverName: assignment.driverName || '',
                transporterId: assignment.transporterId,
                vehicleId: assignment.vehicleId,
                vehicleNumber: assignment.vehicleNumber || '',
                bookingId: assignment.bookingId || '',
                orderId: assignment.orderId || '',
                truckRequestId: assignment.truckRequestId || '',
                tripId: assignment.tripId || '',
                createdAt: assignment.assignedAt
              });
              logger.info(`[RECONCILIATION] Processed orphaned pending: ${assignment.id}`);
            } catch (err: any) {
              logger.error(`[RECONCILIATION] Failed pending: ${assignment.id}`, { error: err.message });
            }
          }
        }

        // =====================================================================
        // PHASE 2: Abandoned IN-TRANSIT trucks (driver disappeared mid-trip)
        // =====================================================================
        // TRUCK-SPECIFIC: Freight trips can legitimately last 12-24 hours.
        // But a truck in active status for >48 hours with NO completion is
        // definitely abandoned (driver phone died, app crashed, driver went AWOL).
        //
        // This replaces the old STALE_VEHICLE_WATCHDOG with a lightweight check
        // inside the existing reconciliation — same Uber pattern, no separate scanner.
        //
        // Threshold: 48 hours (configurable via env var)
        // =====================================================================
        const STALE_ACTIVE_HOURS = parseInt(process.env.STALE_ACTIVE_TRIP_HOURS || '48', 10);
        const staleActiveThresholdISO = new Date(Date.now() - STALE_ACTIVE_HOURS * 60 * 60 * 1000).toISOString();

        const abandonedTrips = await prismaClient.assignment.findMany({
          where: {
            status: { in: ['driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit', 'arrived_at_drop'] },
            assignedAt: { lt: staleActiveThresholdISO }
          },
          include: {
            vehicle: { select: { id: true, vehicleKey: true, transporterId: true, status: true } }
          },
          take: 50
        });

        if (abandonedTrips.length > 0) {
          logger.warn(`[RECONCILIATION] 🚛 Found ${abandonedTrips.length} abandoned active trip(s) (>${STALE_ACTIVE_HOURS}h old)`);

          const { liveAvailabilityService }: typeof import('./live-availability.service') = require('./live-availability.service');

          for (const assignment of abandonedTrips) {
            try {
              const ageHours = Math.round((Date.now() - new Date(assignment.assignedAt).getTime()) / (60 * 60 * 1000));

              // 1. Cancel the assignment (system-level — no user context needed)
              await prismaClient.assignment.updateMany({
                where: { id: assignment.id, status: { in: ['driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit', 'arrived_at_drop'] } },
                data: { status: 'cancelled' }
              });

              // 2. Release the vehicle back to available
              if (assignment.vehicleId) {
                const prevStatus = assignment.vehicle?.status || 'in_transit';
                await prismaClient.vehicle.updateMany({
                  where: { id: assignment.vehicleId, status: { not: 'available' } },
                  data: {
                    status: 'available',
                    currentTripId: null,
                    assignedDriverId: null,
                    lastStatusChange: new Date().toISOString()
                  }
                });

                // 3. Update Redis availability (hot path sync)
                const vehicleKey = assignment.vehicle?.vehicleKey;
                const transporterId = assignment.vehicle?.transporterId || assignment.transporterId;
                if (vehicleKey && transporterId) {
                  await liveAvailabilityService.onVehicleStatusChange(
                    transporterId,
                    vehicleKey,
                    prevStatus,
                    'available'
                  ).catch((err: any) => logger.warn('[RECONCILIATION] Redis update failed', err));
                }
              }

              // 4. Decrement trucks filled on booking/order
              if (assignment.bookingId) {
                const { bookingService }: typeof import('../../modules/booking/booking.service') = require('../../modules/booking/booking.service');
                await bookingService.decrementTrucksFilled(assignment.bookingId).catch(() => {});
              } else if (assignment.orderId) {
                await prismaClient.order.update({
                  where: { id: assignment.orderId },
                  data: { trucksFilled: { decrement: 1 } }
                }).catch(() => {});
              }

              logger.warn(`[RECONCILIATION] 🚛 Released abandoned truck: ${assignment.vehicleNumber || 'unknown'} ` +
                `(assignment ${assignment.id}, status was '${assignment.status}', ${ageHours}h old)`);
            } catch (err: any) {
              logger.error(`[RECONCILIATION] Failed abandoned: ${assignment.id}`, { error: err.message });
            }
          }
        }
      } finally {
        await redisService.releaseLock(lockKey, 'reconciler').catch(() => {});
      }
    });

    // Self-scheduling reconciliation: enqueue every 5 minutes via setInterval
    // L1 FIX: unref() so this non-critical timer doesn't block process exit
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
    }, 5 * 60 * 1000).unref();

    // =========================================================================
    // STALE VEHICLE WATCHDOG — REMOVED (Uber/Ola Pattern)
    // =========================================================================
    // BEFORE: setInterval → queue.add(Redis) → BRPOP → scan Postgres DB
    //         → 6 failure points, scans Filing Cabinet instead of Whiteboard
    //
    // AFTER:  Self-destruct timers (setTimeout) prevent stuck vehicles in the
    //         first place. ASSIGNMENT_RECONCILIATION (above, every 5 min)
    //         catches the 0.01% ECS-restart-during-30s-window edge case.
    //
    // WHY REMOVED:
    //   1. With bulletproof setTimeout timers, on_hold vehicles always release
    //   2. The watchdog was scanning Postgres (Filing Cabinet) — wrong per
    //      Uber/Ola's Whiteboard pattern
    //   3. The watchdog itself went through Redis BRPOP — same failure mode
    //      as the broken timers it was meant to catch
    // =========================================================================

    logger.info(`📋 Queue processors registered (including reconciliation — self-destruct timers handle assignment timeouts)`);
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
    // Phase 5: Queue depth backpressure — sampled check (every 2s, not per-call)
    await this.refreshBroadcastQueueDepth();
    if (this.broadcastDepthSnapshot.depth >= FF_QUEUE_DEPTH_CAP) {
      metrics.incrementCounter('broadcast_queue_backpressure_rejected', { event });
      logger.warn('[Phase5] Broadcast queue depth exceeded cap', {
        transporterId, event, depth: this.broadcastDepthSnapshot.depth, cap: FF_QUEUE_DEPTH_CAP
      });
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
   * Schedule a self-destruct timer for an assignment (Uber/Cadence pattern).
   *
   * BEFORE: Redis ZADD → DelayPoller → BRPOP → Worker (4 failure points)
   * AFTER:  setTimeout in V8 process memory (0 failure points)
   *
   * WHY setTimeout:
   *   - Lives in V8 heap — cannot be lost by Redis, BRPOP, or connection blips
   *   - Exactly how Uber's Cadence/Temporal works under the hood
   *   - Node.js GC keeps the timer alive until it fires or process exits
   *
   * SAFETY:
   *   - handleAssignmentTimeout() is 100% idempotent:
   *     updateMany({ where: { status: 'pending' }}) returns 0 if driver already accepted
   *   - ECS restart during 30s window (0.01% chance): caught by
   *     ASSIGNMENT_RECONCILIATION job (runs every 5 min, finds pending > 3 min)
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
    const jobId = `timeout:${data.assignmentId}:${Date.now()}`;

    // Uber/Cadence pattern: In-process timer. Lives in V8 heap.
    // Cannot be lost by Redis, BRPOP, or ECS connection blips.
    setTimeout(async () => {
      try {
        const { assignmentService }: typeof import('../../modules/assignment/assignment.service') = require('../../modules/assignment/assignment.service');
        await assignmentService.handleAssignmentTimeout(data);
        logger.info(`[TIMER] ⏰ Self-destruct fired: ${data.assignmentId} (${data.driverName})`);
      } catch (err: any) {
        logger.error('[TIMER] Self-destruct handler failed', {
          assignmentId: data.assignmentId,
          error: err?.message
        });
      }
    }, delayMs);

    logger.info(`[TIMER] Self-destruct armed: ${data.assignmentId} fires in ${delayMs / 1000}s`);
    return jobId;
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
      } catch (error: any) {
        logger.warn('[Phase5] Failed to sample broadcast queue depth', {
          message: error?.message || 'unknown'
        });
      }
    })();

    await this.broadcastDepthSampleInFlight;
    this.broadcastDepthSampleInFlight = null;
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
