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

import * as crypto from 'crypto';
import { logger } from './logger.service';
import { EventEmitter } from 'events';
import { redisService } from './redis.service';
import { createTrackingStreamSink } from './tracking-stream-sink';
import { metrics } from '../monitoring/metrics.service';
import { prismaClient } from '../database/prisma.service';
import * as admin from 'firebase-admin';
import { FLAGS, isEnabled } from '../config/feature-flags';

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

export const TRACKING_QUEUE_HARD_LIMIT = Math.max(1000, parseInt(process.env.TRACKING_QUEUE_HARD_LIMIT || '200000', 10) || 200000);

// M-6 FIX: Configurable DLQ cap (was hardcoded 1000, now defaults to 5000)
// Higher cap preserves more failed jobs for post-mortem debugging.
export const DLQ_MAX_SIZE = Math.max(100, parseInt(process.env.DLQ_MAX_SIZE || '5000', 10) || 5000);
export const TRACKING_QUEUE_DEPTH_SAMPLE_MS = Math.max(100, parseInt(process.env.TRACKING_QUEUE_DEPTH_SAMPLE_MS || '500', 10) || 500);
export const FF_CANCELLED_ORDER_QUEUE_GUARD = process.env.FF_CANCELLED_ORDER_QUEUE_GUARD !== 'false';
// FAIL-CLOSED by default: if guard lookup is ambiguous, we prefer dropping stale
// broadcast emissions to preserve cancellation correctness under race conditions.
export const FF_CANCELLED_ORDER_QUEUE_GUARD_FAIL_OPEN = process.env.FF_CANCELLED_ORDER_QUEUE_GUARD_FAIL_OPEN === 'true';
export const CANCELLED_ORDER_QUEUE_GUARD_CACHE_TTL_MS = Math.max(
  250,
  parseInt(process.env.CANCELLED_ORDER_QUEUE_GUARD_CACHE_TTL_MS || '1500', 10) || 1500
);

// =============================================================================
// PHASE 4 — GUARANTEED DELIVERY FLAGS & CONFIG
// =============================================================================

/** Sequence-numbered delivery + unacked queue + replay on reconnect */
export const FF_SEQUENCE_DELIVERY_ENABLED = process.env.FF_SEQUENCE_DELIVERY_ENABLED === 'true';

/**
 * Parallel Socket.IO + FCM delivery for every broadcast.
 *
 * F-B-53: delegated to the centralized feature-flags registry so the
 * `defaultValue: true` declared there applies uniformly. Previously this
 * module did a raw `=== 'true'` check (defaulting OFF when unset), which
 * caused split-brain with other readers that consulted `isEnabled()`.
 */
export const FF_DUAL_CHANNEL_DELIVERY = isEnabled(FLAGS.DUAL_CHANNEL_DELIVERY);

/** Message TTL enforcement — drop stale messages before emitting (H5: default ON) */
export const FF_MESSAGE_TTL_ENABLED = process.env.FF_MESSAGE_TTL_ENABLED !== 'false';

/** Priority drain order — CRITICAL(1) → HIGH(2) → NORMAL(3) → LOW(4) */
export const FF_MESSAGE_PRIORITY_ENABLED = process.env.FF_MESSAGE_PRIORITY_ENABLED === 'true';

/** Unacked queue TTL in seconds (10 minutes — covers reconnect window) */
export const UNACKED_QUEUE_TTL_SECONDS = 600;

/** Message TTL per event type (milliseconds) */
export const MESSAGE_TTL_MS: Record<string, number> = {
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
export const DEFAULT_MESSAGE_TTL_MS = 120_000;

/** Priority levels for message ordering */
export const MessagePriority = {
  CRITICAL: 1, // order_cancelled, trip_cancelled, driver_timeout
  HIGH: 2,     // accept_confirmation, trip_assigned, booking_updated
  NORMAL: 3,   // new_broadcast, new_truck_request
  LOW: 4       // trucks_remaining_update, telemetry, driver_status_changed
} as const;

/** Map event types to priority levels */
export const EVENT_PRIORITY: Record<string, number> = {
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
export const FF_QUEUE_DEPTH_CAP = Math.max(
  100,
  parseInt(process.env.FF_QUEUE_DEPTH_CAP || '10000', 10) || 10000
);

// =============================================================================
// IN-MEMORY QUEUE (Development / Single Server)
// =============================================================================

export class InMemoryQueue extends EventEmitter {
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
      id: crypto.randomUUID(),
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
    // FIX-41 / #103: Create immutable copy instead of mutating the input job object.
    const updatedJob = { ...job, attempts: job.attempts + 1 };
    try {
      await processor(updatedJob);

      // Success - remove from queue
      const queue = this.queues.get(queueName);
      if (queue) {
        const idx = queue.indexOf(job);
        if (idx !== -1) queue.splice(idx, 1);
      }

      this.emit('job:completed', { queueName, job: updatedJob });
      logger.debug(`Job ${updatedJob.id} completed (${queueName})`);

    } catch (error: any) {
      const failedJob = { ...updatedJob, error: error.message };

      if (failedJob.attempts >= failedJob.maxAttempts) {
        // Max retries reached - move to dead letter
        const queue = this.queues.get(queueName);
        if (queue) {
          const idx = queue.indexOf(job);
          if (idx !== -1) queue.splice(idx, 1);
        }

        this.emit('job:failed', { queueName, job: failedJob, error: error.message });
        logger.error(`Job ${failedJob.id} failed permanently: ${error.message}`);

        // Persist to Redis DLQ for observability and potential recovery
        try {
          const dlqKey = `dlq:${queueName}`;
          const dlqEntry = JSON.stringify({
            jobId: failedJob.id,
            type: failedJob.type,
            data: failedJob.data,
            error: error.message,
            attempts: failedJob.attempts,
            failedAt: new Date().toISOString()
          });
          await redisService.lPush(dlqKey, dlqEntry);
          // M-6 FIX: Configurable DLQ cap (env: DLQ_MAX_SIZE, default 5000)
          await redisService.lTrim(dlqKey, 0, DLQ_MAX_SIZE - 1);
          // 7-day TTL — old DLQ entries auto-expire
          await redisService.expire(dlqKey, 7 * 24 * 60 * 60);
        } catch (dlqErr: any) {
          // DLQ persistence is best-effort — don't break the failure handler
          logger.warn(`[DLQ] Failed to persist dead letter for ${failedJob.id}: ${dlqErr.message}`);
        }
      } else {
        // Schedule retry with exponential backoff
        const retryJob = { ...failedJob, processAfter: Date.now() + Math.pow(2, failedJob.attempts) * 1000 };
        // Update the original job in the queue so the retry is picked up
        const queue = this.queues.get(queueName);
        if (queue) {
          const idx = queue.indexOf(job);
          if (idx !== -1) queue[idx] = retryJob;
        }
        this.emit('job:retry', { queueName, job: retryJob, attempt: retryJob.attempts });
        logger.warn(`Job ${retryJob.id} failed, retry ${retryJob.attempts}/${retryJob.maxAttempts}`);
      }
    } finally {
      this.processing.delete(updatedJob.id);
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
export class RedisQueue extends EventEmitter {
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

  // H7 FIX: Priority suffixes in drain order (CRITICAL first, LOW last).
  // Each priority level gets its own Redis LIST for strict ordering.
  private static readonly PRIORITY_SUFFIXES: ReadonlyArray<{ priority: number; suffix: string }> = [
    { priority: MessagePriority.CRITICAL, suffix: ':critical' },
    { priority: MessagePriority.HIGH,     suffix: ':high' },
    { priority: MessagePriority.NORMAL,   suffix: ':normal' },
    { priority: MessagePriority.LOW,      suffix: ':low' },
  ];

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
   * H7 FIX: Get Redis key for a specific priority level.
   * Maps numeric priority (1-4) to named suffix lists:
   *   1 (CRITICAL) → queue:{name}:critical
   *   2 (HIGH)     → queue:{name}:high
   *   3 (NORMAL)   → queue:{name}:normal  (default)
   *   4 (LOW)      → queue:{name}:low
   * Unknown priorities default to :normal for backward compatibility.
   */
  private getPriorityQueueKey(queueName: string, priority: number): string {
    const base = this.getQueueKey(queueName);
    const entry = RedisQueue.PRIORITY_SUFFIXES.find(p => p.priority === priority);
    return entry ? `${base}${entry.suffix}` : `${base}:normal`;
  }

  /**
   * H7 FIX: Get all priority list keys for a queue in drain order.
   * Used by workers to check higher-priority lists first.
   */
  private getAllPriorityKeys(queueName: string): string[] {
    const base = this.getQueueKey(queueName);
    return RedisQueue.PRIORITY_SUFFIXES.map(p => `${base}${p.suffix}`);
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
      id: crypto.randomUUID(),
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
        // H7 FIX: Route to priority-specific list instead of single list.
        // Cancellation messages (CRITICAL) go to queue:{name}:critical,
        // normal broadcasts go to queue:{name}:normal, etc.
        // Workers drain critical first, then high, normal, low.
        const priorityKey = this.getPriorityQueueKey(queueName, job.priority);
        await redisService.lPush(priorityKey, JSON.stringify(job));
        logger.debug(`Redis Queue: Job ${job.id} added to ${queueName} priority=${job.priority} (type: ${type})`);
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

    try {
      // H7 FIX: Group jobs by priority level, then lPushMany to each priority list.
      // This preserves batch efficiency while routing to correct priority queues.
      const buckets = new Map<string, string[]>();

      for (const jobData of jobs) {
        const priority = jobData.priority ?? MessagePriority.NORMAL;
        const job: QueueJob<T> = {
          id: crypto.randomUUID(),
          type: jobData.type,
          data: jobData.data,
          priority,
          attempts: 0,
          maxAttempts: 3,
          createdAt: Date.now()
        };

        ids.push(job.id);
        const key = this.getPriorityQueueKey(queueName, priority);
        const bucket = buckets.get(key);
        if (bucket) {
          bucket.push(JSON.stringify(job));
        } else {
          buckets.set(key, [JSON.stringify(job)]);
        }
      }

      // Push each priority bucket in parallel
      const pushOps: Promise<number>[] = [];
      for (const [key, serializedJobs] of buckets) {
        if (serializedJobs.length > 0) {
          pushOps.push(redisService.lPushMany(key, serializedJobs));
        }
      }
      await Promise.all(pushOps);

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
   * Scans the processing:{queueName} hash. If a job's processingStartedAt (or createdAt
   * as fallback) is older than STALE_PROCESSING_THRESHOLD_MS, re-enqueue it to the main queue.
   * FIX-16: Uses processingStartedAt for accurate staleness detection instead of createdAt,
   * which may be much older (e.g., delayed jobs that waited before starting).
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
        const job: QueueJob & { processingStartedAt?: number } = JSON.parse(staleJobs[jobId]);
        // FIX-16: Prefer processingStartedAt (set when job starts processing) over createdAt
        // createdAt reflects when the job was enqueued, not when processing began
        const processingAgeMs = now - (job.processingStartedAt || job.createdAt || 0);

        if (processingAgeMs > this.STALE_PROCESSING_THRESHOLD_MS) {
          // Stale — re-enqueue to correct priority list for reprocessing
          const priority = (typeof job.priority === 'number') ? job.priority : MessagePriority.NORMAL;
          const targetKey = this.getPriorityQueueKey(queueName, priority);
          await redisService.lPush(targetKey, staleJobs[jobId]);
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
    const processingKey = this.getProcessingKey(queueName);
    // H7 FIX: Get all priority list keys in drain order (critical → high → normal → low)
    const priorityKeys = this.getAllPriorityKeys(queueName);
    // Legacy key for backward compat — drains jobs enqueued before H7 fix
    const legacyKey = this.getQueueKey(queueName);
    // The lowest-priority key is used for BRPOP blocking to avoid busy-spinning
    const lowestPriorityKey = priorityKeys[priorityKeys.length - 1];

    while (this.isRunning && this.processors.get(queueName) === processor) {
      try {
        // H7 FIX: Priority drain — check higher-priority lists first with non-blocking RPOP.
        // Only block (BRPOP) on the lowest-priority list when all others are empty.
        // This ensures cancellation messages are always processed before normal broadcasts.
        let jobStr: string | null = null;

        // First: drain legacy key (backward compat for pre-H7 jobs)
        if (!jobStr) {
          jobStr = await redisService.rPop(legacyKey);
        }

        // Then: try priority lists in order (critical, high, normal) with non-blocking RPOP
        if (!jobStr) {
          for (let i = 0; i < priorityKeys.length - 1; i++) {
            jobStr = await redisService.rPop(priorityKeys[i]);
            if (jobStr) break;
          }
        }

        // If no higher-priority jobs, block on lowest-priority list to avoid busy-spin
        if (!jobStr) {
          jobStr = await redisService.brPop(lowestPriorityKey, this.blockingPopTimeoutSec);
          if (!jobStr) {
            // BRPOP timed out — loop back and check higher-priority lists again
            continue;
          }
        }

        const job: QueueJob = JSON.parse(jobStr);

        // Bug #3 fix: processAfter check is no longer needed here.
        // Delayed jobs now sit in a Redis Sorted Set and are only moved to the
        // main queue when ready. Any residual processAfter jobs (from before
        // this fix was deployed) are handled gracefully — just process them.

        // Bug #2 fix: Save to processing hash BEFORE processing.
        // If ECS crashes after BRPOP but before completion, this job
        // will be recovered from the processing hash on next startup.
        // FIX-16: Stamp processingStartedAt so stale job recovery uses accurate timing
        const processingEntry = JSON.stringify({ ...job, processingStartedAt: Date.now() });
        await redisService.hSet(processingKey, job.id, processingEntry).catch(() => {});

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
    // FIX-41 / #103: Create immutable copy instead of mutating the input job object.
    // FIX-16 / #105: Stamp processingStartedAt when job begins processing for accurate staleness checks.
    const updatedJob = { ...job, attempts: job.attempts + 1, processingStartedAt: Date.now() };
    try {
      await processor(updatedJob);

      // Bug #2 fix: Remove from processing hash on success
      await redisService.hDel(processingKey, updatedJob.id).catch(() => {});

      this.emit('job:completed', { queueName, job: updatedJob });
      logger.debug(`Redis Queue: Job ${updatedJob.id} completed (${queueName})`);

    } catch (error: any) {
      const failedJob = { ...updatedJob, error: error.message };

      // Bug #2 fix: Remove from processing hash on failure too (will be re-enqueued or DLQ'd)
      await redisService.hDel(processingKey, failedJob.id).catch(() => {});

      if (failedJob.attempts >= failedJob.maxAttempts) {
        // Max retries reached - move to dead letter queue
        const dlqKey = this.getDeadLetterKey(queueName);
        await redisService.lPush(dlqKey, JSON.stringify(failedJob));

        this.emit('job:failed', { queueName, job: failedJob, error: error.message });
        logger.error(`Redis Queue: Job ${failedJob.id} failed permanently, moved to DLQ`);
      } else {
        // Bug #3 fix: Re-queue with exponential backoff via Sorted Set (not LPUSH)
        // This prevents the retry from being busy-polled in the main queue.
        const retryJob = { ...failedJob, processAfter: Date.now() + Math.pow(2, failedJob.attempts) * 1000 };
        const delayedKey = this.getDelayedKey(queueName);
        await redisService.zAdd(delayedKey, retryJob.processAfter!, JSON.stringify(retryJob));

        this.emit('job:retry', { queueName, job: retryJob, attempt: retryJob.attempts });
        logger.warn(`Redis Queue: Job ${retryJob.id} failed, retry ${retryJob.attempts}/${retryJob.maxAttempts} at ${new Date(retryJob.processAfter!).toISOString()}`);
      }
    } finally {
      this.processing.delete(updatedJob.id);
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

          // H7 FIX: Move each ready job to the correct priority list
          for (const jobStr of readyJobs) {
            let priority = MessagePriority.NORMAL;
            try {
              const parsed = JSON.parse(jobStr);
              if (typeof parsed.priority === 'number') {
                priority = parsed.priority;
              }
            } catch { /* default to NORMAL */ }
            const targetKey = this.getPriorityQueueKey(queueName, priority);
            await redisService.lPush(targetKey, jobStr);
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
   * H7 FIX: Aggregates depth across all priority lists for each queue.
   */
  async getStats(): Promise<{
    queues: { name: string; pending: number; processing: number }[];
    totalPending: number;
    totalProcessing: number;
  }> {
    const queueStats: { name: string; pending: number; processing: number }[] = [];

    for (const queueName of this.processors.keys()) {
      const pending = await this.getQueueDepth(queueName);

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

  /**
   * H7 FIX: Sum depth across all priority lists for a queue.
   * Also checks the legacy non-suffixed key for backward compatibility
   * with any jobs enqueued before the priority fix was deployed.
   */
  async getQueueDepth(queueName: string): Promise<number> {
    const priorityKeys = this.getAllPriorityKeys(queueName);
    const legacyKey = this.getQueueKey(queueName);

    const depths = await Promise.all([
      // Legacy key (jobs enqueued before H7 fix)
      redisService.lLen(legacyKey),
      // Priority-specific keys
      ...priorityKeys.map(k => redisService.lLen(k))
    ]);

    return depths.reduce((sum, d) => sum + d, 0);
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

export class QueueService {
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
  // FIX-42: Store setTimeout handles for assignment timeouts so they can be cleared on cancel/complete
  private assignmentTimers = new Map<string, NodeJS.Timeout>();

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
            for (let i = 0; i < tokens.length; i++) {
              if (batchResponse.responses[i] && !batchResponse.responses[i].success &&
                  batchResponse.responses[i].error?.code === 'messaging/registration-token-not-registered') {
                await redisService.del(`fcm_token:${tokens[i]}`);
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
    // VEHICLE_RELEASE queue processor — retries failed vehicle releases
    // Max 5 retries with exponential backoff (2s, 4s, 8s, 16s, 32s)
    // =========================================================================
    this.queue.process(QueueService.QUEUES.VEHICLE_RELEASE, async (job) => {
      const { vehicleId, context } = job.data;
      const { releaseVehicle }: typeof import('./vehicle-lifecycle.service') = require('./vehicle-lifecycle.service');
      await releaseVehicle(vehicleId, `retry:${context}`);
      logger.info(`[VEHICLE_RELEASE] Successfully released vehicle ${vehicleId} on retry attempt ${job.attempts}`);
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
        // FIX #9: Tighter reconciliation threshold — 90s instead of 3min.
        // Env-configurable with Math.max guard to prevent dangerously low values.
        // assignedAt is String (ISO), so compare as string — ISO strings sort lexicographically
        const RECONCILE_THRESHOLD_MS = Math.max(30000, parseInt(process.env.ASSIGNMENT_RECONCILE_THRESHOLD_MS || '90000', 10) || 90000);
        const thresholdAgoISO = new Date(Date.now() - RECONCILE_THRESHOLD_MS).toISOString();
        const orphaned = await prismaClient.assignment.findMany({
          where: {
            status: 'pending',
            assignedAt: { lt: thresholdAgoISO }
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
        // FIX A4#17: Split thresholds — in-transit uses 48h, pre-transit uses 24h.
        // FIX A4#16: Cursor-based pagination to handle unbounded abandoned trips.
        // FIX A4#18: Notify driver (FCM) and transporter (WebSocket) on reconciliation cancel.
        // FIX A4#19: Status-check before decrementing trucksFilled to avoid double-decrement.
        // =====================================================================
        const STALE_TRANSIT_HOURS = parseInt(process.env.STALE_ACTIVE_TRIP_HOURS || '48', 10);
        const STALE_PRE_TRANSIT_HOURS = parseInt(process.env.STALE_PRE_TRANSIT_TRIP_HOURS || '24', 10);
        const staleTransitCutoff = new Date(Date.now() - STALE_TRANSIT_HOURS * 60 * 60 * 1000).toISOString();
        const stalePreTransitCutoff = new Date(Date.now() - STALE_PRE_TRANSIT_HOURS * 60 * 60 * 1000).toISOString();

        // FIX A4#16: Cursor-based pagination — process all abandoned trips in batches of 50
        const BATCH_SIZE = 50;
        let totalAbandoned = 0;
        let cursor: string | undefined;

        // FIX A4#18: Lazy require to avoid circular dependency
        const { emitToUser, SocketEvent }: typeof import('./socket.service') = require('./socket.service');

        // eslint-disable-next-line no-constant-condition
        while (true) {
          // FIX A4#17: OR clause — different thresholds for in-transit vs pre-transit
          const abandonedBatch = await prismaClient.assignment.findMany({
            where: {
              OR: [
                // In-transit trips: use startedAt (48h threshold)
                {
                  status: { in: ['in_transit', 'arrived_at_drop'] },
                  startedAt: { not: null, lt: staleTransitCutoff }
                },
                // Pre-transit trips: use assignedAt (24h threshold)
                {
                  status: { in: ['driver_accepted', 'en_route_pickup', 'at_pickup'] },
                  assignedAt: { lt: stalePreTransitCutoff }
                }
              ]
            },
            include: {
              vehicle: { select: { id: true, vehicleKey: true, transporterId: true, status: true } }
            },
            orderBy: { id: 'asc' },
            take: BATCH_SIZE,
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {})
          });

          if (abandonedBatch.length === 0) break;

          totalAbandoned += abandonedBatch.length;
          cursor = abandonedBatch[abandonedBatch.length - 1].id;

          logger.warn(`[RECONCILIATION] Processing batch of ${abandonedBatch.length} abandoned trip(s) (transit>${STALE_TRANSIT_HOURS}h, pre-transit>${STALE_PRE_TRANSIT_HOURS}h)`);

          for (const assignment of abandonedBatch) {
            try {
              const ageHours = Math.round((Date.now() - new Date(assignment.assignedAt).getTime()) / (60 * 60 * 1000));

              // 1. Cancel the assignment (system-level — no user context needed)
              // Use updateMany count to detect if another process already cancelled (QA-3 race fix)
              const cancelResult = await prismaClient.assignment.updateMany({
                where: { id: assignment.id, status: { in: ['driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit', 'arrived_at_drop'] } },
                data: { status: 'cancelled' }
              });

              // If count === 0, another process already cancelled this assignment — skip all side effects
              if (cancelResult.count === 0) {
                logger.info(`[RECONCILIATION] Assignment ${assignment.id} already cancelled by another process, skipping`);
                continue;
              }

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

                // 3. Update Redis + fleet cache via centralized wrapper
                const vehicleKey = assignment.vehicle?.vehicleKey;
                const transporterId = assignment.vehicle?.transporterId || assignment.transporterId;
                if (vehicleKey && transporterId) {
                  const { onVehicleTransition }: typeof import('./vehicle-lifecycle.service') = require('./vehicle-lifecycle.service');
                  await onVehicleTransition(
                    transporterId, assignment.vehicleId, vehicleKey,
                    prevStatus, 'available', 'queueReconciliation'
                  ).catch((err: any) => logger.warn('[RECONCILIATION] Vehicle transition failed', err));
                }
              }

              // 4. Decrement trucks filled on booking/order
              // FIX A4#19: Check parent status before decrementing — avoid double-decrement on already-cancelled/completed
              if (assignment.bookingId) {
                const booking = await prismaClient.booking.findUnique({
                  where: { id: assignment.bookingId },
                  select: { status: true }
                });
                if (booking && booking.status !== 'cancelled' && booking.status !== 'completed') {
                  const { bookingService }: typeof import('../../modules/booking/booking.service') = require('../../modules/booking/booking.service');
                  await bookingService.decrementTrucksFilled(assignment.bookingId).catch(() => {});
                }
              } else if (assignment.orderId) {
                // FIX A4#19: Floor guard + status check — only decrement if order is still active
                // DB migration needed: ALTER TABLE "Order" ADD CONSTRAINT chk_order_trucks_filled_nonneg CHECK ("trucksFilled" >= 0);
                await prismaClient.$executeRaw`
                  UPDATE "Order"
                  SET "trucksFilled" = GREATEST(0, "trucksFilled" - 1),
                      "updatedAt" = NOW()
                  WHERE "id" = ${assignment.orderId}
                    AND "status" NOT IN ('cancelled', 'completed')
                `.catch(() => {});
              }

              logger.warn(`[RECONCILIATION] Released abandoned truck: ${assignment.vehicleNumber || 'unknown'} ` +
                `(assignment ${assignment.id}, status was '${assignment.status}', ${ageHours}h old)`);

              // FIX A4#18: Notify driver and transporter after reconciliation cancel
              if (assignment.driverId) {
                this.queuePushNotification(assignment.driverId, {
                  title: 'Trip Cancelled',
                  body: 'Your trip was auto-cancelled due to inactivity.',
                  data: { type: 'assignment_cancelled', reason: 'system_reconciliation' }
                }).catch((err: any) => logger.warn('[RECONCILIATION] FCM notify driver failed', err));
              }
              if (assignment.vehicleId) {
                const transporterId = assignment.vehicle?.transporterId || assignment.transporterId;
                if (transporterId) {
                  try {
                    emitToUser(transporterId, SocketEvent.VEHICLE_STATUS_CHANGED, {
                      vehicleId: assignment.vehicleId,
                      status: 'available',
                      reason: 'system_reconciliation'
                    });
                  } catch (socketErr: any) {
                    logger.warn('[RECONCILIATION] WebSocket notify transporter failed', { error: socketErr?.message });
                  }
                }
              }
            } catch (err: any) {
              logger.error(`[RECONCILIATION] Failed abandoned: ${assignment.id}`, { error: err.message });
            }
          }

          // If batch was smaller than BATCH_SIZE, we've processed all records
          if (abandonedBatch.length < BATCH_SIZE) break;
        }

        if (totalAbandoned > 0) {
          logger.warn(`[RECONCILIATION] Total abandoned trips processed: ${totalAbandoned}`);
        }
        // =====================================================================
        // PHASE 3: Reverse vehicle reconciliation — find vehicles stuck
        //          with no active assignment (orphaned vehicles)
        // =====================================================================
        // Catches vehicles stuck in 'in_transit' or 'on_hold' where the
        // assignment was cancelled/completed but vehicle release failed silently.
        // Uses raw SQL for index-friendly query (Vehicle.status + updatedAt).
        // =====================================================================
        try {
          const orphanedVehicles = await prismaClient.$queryRaw<
            Array<{ id: string; status: string; transporterId: string; vehicleKey: string }>
          >`
            SELECT v."id", v."status", v."transporterId", v."vehicleKey"
            FROM "Vehicle" v
            WHERE v."status" IN ('in_transit', 'on_hold')
            AND v."updatedAt" < NOW() - INTERVAL '10 minutes'
            AND NOT EXISTS (
              SELECT 1 FROM "Assignment" a
              WHERE a."vehicleId" = v."id"
              AND a."status" IN ('pending', 'driver_accepted', 'in_transit', 'en_route_pickup', 'at_pickup', 'arrived_at_drop')
            )
            LIMIT 50
          `;

          for (const v of orphanedVehicles) {
            const { releaseVehicle: releaseOrphaned }: typeof import('./vehicle-lifecycle.service') = require('./vehicle-lifecycle.service');
            await releaseOrphaned(v.id, 'reconciliation:orphaned').catch((err: any) => {
              logger.warn('[RECONCILIATION] Failed to release orphaned vehicle', { vehicleId: v.id, error: err.message });
            });
          }

          if (orphanedVehicles.length > 0) {
            logger.info(`[RECONCILIATION] Released ${orphanedVehicles.length} orphaned vehicles`);
          }
        } catch (orphanErr: any) {
          logger.warn('[RECONCILIATION] Orphaned vehicle scan failed (non-fatal)', { error: orphanErr.message });
        }
      } finally {
        await redisService.releaseLock(lockKey, 'reconciler').catch(() => {});
      }
    });

    // FIX #9: Tighter reconciliation interval — 2min instead of 5min.
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

    // Assignment timeout poller (Problem 16 fix)
    this.startAssignmentTimeoutPoller();

    logger.info('Queue processors registered (including reconciliation + Redis-based assignment timeouts)');
  }


  /**
   * FIX Problem 16: Poll for expired assignment-timeout timers every 5 seconds.
   */
  private startAssignmentTimeoutPoller(): void {
    const poller = setInterval(async () => {
      try {
        const expiredTimers = await redisService.getExpiredTimers<{
          assignmentId: string;
          driverId: string;
          driverName: string;
          transporterId: string;
          vehicleId: string;
          vehicleNumber: string;
          bookingId?: string;
          tripId: string;
          createdAt: string;
          orderId?: string;
          truckRequestId?: string;
        }>('timer:assignment-timeout:');

        for (const timer of expiredTimers) {
          // FIX #22: Per-timer distributed lock prevents duplicate processing across ECS instances.
          // Handler is already idempotent (checks assignment status before acting), so this is
          // an efficiency optimization per Kleppmann -- not a correctness requirement.
          const timerLockKey = `lock:assignment-timeout:${timer.data.assignmentId}`;
          const timerLock = await redisService.acquireLock(timerLockKey, 'assignment-timeout-poller', 30);
          if (!timerLock.acquired) {
            // Another instance is processing this assignment timeout
            continue;
          }

          try {
            const { assignmentService }: typeof import('../../modules/assignment/assignment.service') = require('../../modules/assignment/assignment.service');
            await assignmentService.handleAssignmentTimeout(timer.data);
            logger.info(`[TIMER] Assignment timeout fired: ${timer.data.assignmentId} (${timer.data.driverName})`);
          } catch (err: any) {
            logger.error('[TIMER] Assignment timeout handler failed', {
              key: timer.key,
              assignmentId: timer.data?.assignmentId,
              error: err?.message
            });
          } finally {
            await redisService.releaseLock(timerLockKey, 'assignment-timeout-poller').catch(() => {});
          }
        }
      } catch (pollErr: any) {
        logger.warn(`[TIMER] Assignment timeout poll error: ${pollErr?.message}`);
      }
    }, 5000);

    poller.unref();
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
    let normalizedStatus = typeof order?.status === 'string'
      ? order.status.toLowerCase()
      : null;

    // H6 FIX: Booking broadcasts set orderId = booking.id, which won't exist in Order table.
    // Fall back to Booking table so the cancellation guard covers booking broadcasts too.
    if (normalizedStatus === null) {
      const booking = await prismaClient.booking.findUnique({
        where: { id: orderId },
        select: { status: true }
      });
      normalizedStatus = typeof booking?.status === 'string'
        ? booking.status.toLowerCase()
        : null;
    }

    this.orderStatusCache.set(orderId, {
      status: normalizedStatus,
      expiresAt: now + this.orderStatusCacheTtlMs
    });

    // #138: Evict in batches of 100 (amortized O(1) per insert) rather than
    // 1-at-a-time which caused pathological eviction under burst load.
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
    data: any,
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
   * Queue a push notification.
   *
   * W0-1: The `priority` field is forwarded verbatim to
   * `sendPushNotification` in the processor, which passes it to
   * `buildMessage` where `android.priority` is set from it. Callers
   * that issue time-sensitive driver-dispatch pushes MUST pass
   * `priority: 'high'` at the TOP LEVEL (not nested inside `data`) — see
   * `phase3to100-fcm-priority-regression.test.ts` for the 5 positive
   * callsites this contract protects.
   */
  async queuePushNotification(
    userId: string,
    notification: {
      title: string;
      body: string;
      data?: Record<string, string>;
      priority?: 'high' | 'normal';
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
   * Queue push notifications to multiple users (batch).
   *
   * W0-1: `priority` is forwarded to each per-user job so the downstream
   * `sendPushNotification → buildMessage` path emits `android.priority`
   * correctly. See `queuePushNotification` above for the contract.
   */
  async queuePushNotificationBatch(
    userIds: string[],
    notification: {
      title: string;
      body: string;
      data?: Record<string, string>;
      priority?: 'high' | 'normal';
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
    } catch (err: any) {
      // Fallback: use in-process setTimeout if Redis is unavailable
      logger.warn(`[TIMER] Redis setTimer failed, falling back to setTimeout: ${err?.message}`);
      // FIX-42: Store the setTimeout handle so it can be cleared on cancel/complete
      const handle = setTimeout(async () => {
        try {
          const { assignmentService }: typeof import('../../modules/assignment/assignment.service') = require('../../modules/assignment/assignment.service');
          await assignmentService.handleAssignmentTimeout(data);
          logger.info(`[TIMER] setTimeout fallback fired: ${data.assignmentId} (${data.driverName})`);
        } catch (timeoutErr: any) {
          logger.error('[TIMER] setTimeout fallback handler failed', {
            assignmentId: data.assignmentId,
            error: timeoutErr?.message
          });
        } finally {
          this.assignmentTimers.delete(data.assignmentId);
        }
      }, delayMs);
      this.assignmentTimers.set(data.assignmentId, handle);
    }

    return timerKey;
  }

  /**
   * Cancel a scheduled assignment timeout (driver accepted or assignment cancelled).
   * FIX Problem 16: Replaces old clearTimeout pattern with Redis cancelTimer.
   * FIX-42: Also clears the in-memory setTimeout fallback handle if one exists.
   */
  async cancelAssignmentTimeout(assignmentId: string): Promise<void> {
    const timerKey = `timer:assignment-timeout:${assignmentId}`;
    try {
      await redisService.cancelTimer(timerKey);
      logger.info(`[TIMER] Assignment timeout cancelled: ${assignmentId}`);
    } catch (err: any) {
      logger.warn(`[TIMER] Failed to cancel assignment timeout: ${assignmentId} - ${err?.message}`);
    }
    // FIX-42: Clear in-memory setTimeout fallback handle if it exists
    const timer = this.assignmentTimers.get(assignmentId);
    if (timer) {
      clearTimeout(timer);
      this.assignmentTimers.delete(assignmentId);
      logger.debug(`[TIMER] Cleared in-memory setTimeout fallback for: ${assignmentId}`);
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
