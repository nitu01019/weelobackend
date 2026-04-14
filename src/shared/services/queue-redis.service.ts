/**
 * =============================================================================
 * REDIS QUEUE (Production / Horizontal Scaling / Persistent)
 * =============================================================================
 *
 * Extracted from queue.service.ts for file-size compliance.
 * All external consumers still import from queue.service.ts (facade).
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
 *
 * =============================================================================
 */

import { EventEmitter } from 'events';
import { logger } from './logger.service';
import { redisService } from './redis.service';
import { metrics } from '../monitoring/metrics.service';
import type { QueueJob, JobProcessor, IQueue } from './queue.types';

// Forward-reference to QueueService.QUEUES.TRACKING_EVENTS used in getWorkerCount().
// This constant is duplicated here to avoid a circular import with queue-management.service.ts.
const TRACKING_EVENTS_QUEUE_NAME = 'tracking-events';

export class RedisQueue extends EventEmitter implements IQueue {
  private processors: Map<string, JobProcessor> = new Map();
  private processing: Set<string> = new Set();
  private isRunning: boolean = false;
  private queueInFlight: Map<string, number> = new Map();
  private queueWorkers: Map<string, Set<number>> = new Map();

  // Configuration
  private readonly defaultWorkerCount = Math.max(1, parseInt(process.env.REDIS_QUEUE_WORKERS || '8', 10) || 8);
  private readonly trackingWorkerCount = Math.max(1, parseInt(process.env.REDIS_QUEUE_TRACKING_WORKERS || '4', 10) || 4);
  private readonly broadcastWorkerCount = Math.max(1, parseInt(process.env.REDIS_QUEUE_BROADCAST_WORKERS || '20', 10) || 20);
  private readonly notificationWorkerCount = Math.max(1, parseInt(process.env.REDIS_QUEUE_NOTIFICATION_WORKERS || '10', 10) || 10);
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
      id: `${Date.now()}-${process.pid}-${Math.random().toString(36).substr(2, 9)}`,
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
    } catch (error: unknown) {
      logger.error(`Redis Queue: Failed to add job to ${queueName}:`, error instanceof Error ? error.message : String(error));
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
          id: `${Date.now()}-${process.pid}-${Math.random().toString(36).substr(2, 9)}`,
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
    } catch (error: unknown) {
      logger.error(`Redis Queue: Failed to add batch to ${queueName}:`, error instanceof Error ? error.message : String(error));
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
    this.recoverStaleProcessingJobs(queueName).catch((err: unknown) => {
      logger.warn(`[Queue] Failed to recover processing jobs for ${queueName}: ${err instanceof Error ? err.message : String(err)}`);
    });

    const targetWorkers = this.getWorkerCount(queueName);
    if (!this.queueWorkers.has(queueName)) {
      this.queueWorkers.set(queueName, new Set());
    }
    const workers = this.queueWorkers.get(queueName)!;

    for (let workerId = 0; workerId < targetWorkers; workerId += 1) {
      if (workers.has(workerId)) continue;
      workers.add(workerId);
      this.runWorkerLoop(queueName, workerId, processor).catch((error: unknown) => {
        logger.error(`Redis Queue: Worker crashed for ${queueName}`, {
          workerId,
          message: error instanceof Error ? error.message : 'unknown'
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
        // #105 + DR-18: Use processingStartedAt (now properly written by runWorkerLoop),
        // falling back to createdAt for legacy jobs that predate DR-18.
        const processingStart = job.processingStartedAt ?? job.createdAt ?? 0;
        const processingAgeMs = now - processingStart;

        if (processingAgeMs > this.STALE_PROCESSING_THRESHOLD_MS) {
          // Stale — re-enqueue to main queue for reprocessing
          const queueKey = this.getQueueKey(queueName);
          await redisService.lPush(queueKey, staleJobs[jobId]);
          await redisService.hDel(processingKey, jobId);
          recoveredCount++;
          logger.warn(`[Queue] Recovered stale processing job ${jobId} (${queueName}, age: ${Math.round(processingAgeMs / 1000)}s)`);
        }
        // If not stale, another worker may still be processing it — leave it alone
      } catch (err: unknown) {
        // Corrupt entry — remove it
        await redisService.hDel(processingKey, jobId).catch(() => {});
        logger.warn(`[Queue] Removed corrupt processing entry ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (recoveredCount > 0) {
      logger.warn(`[Queue] 🔄 Recovered ${recoveredCount} stale job(s) for ${queueName}`);
    }
  }

  private getWorkerCount(queueName: string): number {
    if (queueName === TRACKING_EVENTS_QUEUE_NAME) {
      return this.trackingWorkerCount;
    }
    // Broadcast-critical queues: broadcast, fcm_batch
    if (queueName === 'broadcast' || queueName === 'fcm_batch') {
      return this.broadcastWorkerCount;
    }
    // Notification queues: push, sms, email
    if (queueName === 'push' || queueName === 'sms' || queueName === 'email') {
      return this.notificationWorkerCount;
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
          // Real BRPOP already waited blockingPopTimeoutSec — no sleep needed
          continue;
        }

        const job: QueueJob = JSON.parse(jobStr);

        // Bug #3 fix: processAfter check is no longer needed here.
        // Delayed jobs now sit in a Redis Sorted Set and are only moved to the
        // main queue when ready. Any residual processAfter jobs (from before
        // this fix was deployed) are handled gracefully — just process them.

        // DR-18 FIX: Enrich job with processingStartedAt BEFORE saving to processing hash.
        // This gives recoverStaleProcessingJobs an accurate timestamp for stale detection
        // instead of falling back to createdAt (which may be much older).
        const enrichedJob: QueueJob = { ...job, processingStartedAt: Date.now() };
        const enrichedJobStr = JSON.stringify(enrichedJob);

        // Bug #2 fix: Save to processing hash BEFORE processing.
        // If ECS crashes after BRPOP but before completion, this job
        // will be recovered from the processing hash on next startup.
        await redisService.hSet(processingKey, job.id, enrichedJobStr).catch(() => {});

        this.processing.add(job.id);
        this.incrementInFlight(queueName);
        await this.processJob(queueName, enrichedJob, processor);
      } catch (error: unknown) {
        logger.error(`Redis Queue: Worker error for ${queueName}`, {
          workerId,
          message: error instanceof Error ? error.message : 'unknown'
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
    if (queueName === TRACKING_EVENTS_QUEUE_NAME) {
      metrics.setGauge('tracking_queue_inflight', current + 1);
    }
  }

  private decrementInFlight(queueName: string): void {
    const current = this.queueInFlight.get(queueName) || 0;
    const next = Math.max(0, current - 1);
    this.queueInFlight.set(queueName, next);
    if (queueName === TRACKING_EVENTS_QUEUE_NAME) {
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
      // #103: Avoid mutating the original job object — create an immutable copy
      // with the incremented attempt count so the original is never side-effected.
      const updatedJob = { ...job, attempts: job.attempts + 1 };
      await processor(updatedJob);

      // Bug #2 fix: Remove from processing hash on success
      await redisService.hDel(processingKey, job.id).catch(() => {});

      this.emit('job:completed', { queueName, job });
      logger.debug(`Redis Queue: Job ${job.id} completed (${queueName})`);

    } catch (error: unknown) {
      // #103: Build immutable updated job instead of mutating the original
      const failedAttempts = job.attempts + 1;
      const errorMsg = error instanceof Error ? error.message : String(error);
      const updatedJob: QueueJob = { ...job, attempts: failedAttempts, error: errorMsg };

      // Bug #2 fix: Remove from processing hash on failure too (will be re-enqueued or DLQ'd)
      await redisService.hDel(processingKey, job.id).catch(() => {});

      if (failedAttempts >= updatedJob.maxAttempts) {
        // Max retries reached - move to dead letter queue
        const dlqKey = this.getDeadLetterKey(queueName);
        await redisService.lPush(dlqKey, JSON.stringify(updatedJob));

        // CRITICAL #8 fix: Cap DLQ size to prevent unbounded Redis memory growth.
        // Keeps newest 1000 entries (LPUSH adds to head, LTRIM keeps [0..999]).
        const DLQ_MAX_SIZE = 1000;
        try {
          const dlqLen = await redisService.lLen(dlqKey);
          if (dlqLen > DLQ_MAX_SIZE) {
            logger.warn(`[DLQ] ${queueName} reached capacity (${dlqLen}/${DLQ_MAX_SIZE}). Oldest entries will be dropped.`);
          }
          await redisService.lTrim(dlqKey, 0, DLQ_MAX_SIZE - 1);
        } catch (trimErr: unknown) {
          // lTrim failure must not crash job processing — the job is already in the DLQ.
          logger.error(`[DLQ] lTrim failed for ${queueName}: ${trimErr instanceof Error ? trimErr.message : String(trimErr)}`);
        }

        this.emit('job:failed', { queueName, job: updatedJob, error: errorMsg });
        logger.error(`Redis Queue: Job ${updatedJob.id} failed permanently, moved to DLQ`);
      } else {
        // Bug #3 fix: Re-queue with exponential backoff via Sorted Set (not LPUSH)
        // This prevents the retry from being busy-polled in the main queue.
        const retryJob: QueueJob = { ...updatedJob, processAfter: Date.now() + Math.pow(2, failedAttempts) * 1000 };
        const delayedKey = this.getDelayedKey(queueName);
        await redisService.zAdd(delayedKey, retryJob.processAfter!, JSON.stringify(retryJob));

        this.emit('job:retry', { queueName, job: retryJob, attempt: failedAttempts });
        logger.warn(`Redis Queue: Job ${retryJob.id} failed, retry ${failedAttempts}/${retryJob.maxAttempts} at ${new Date(retryJob.processAfter!).toISOString()}`);
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
          const queueKey = this.getQueueKey(queueName);
          const now = Date.now();

          // CRITICAL #22 fix: Atomic Lua script replaces the previous 3-step
          // ZRANGEBYSCORE + LPUSH loop + ZREMRANGEBYSCORE, which could duplicate
          // jobs if the poller crashed between steps.
          // Batched: moves up to 100 jobs per call. If more are ready, the next
          // poll iteration (1s later) picks them up. This prevents long Lua
          // scripts from blocking Redis when thousands of jobs become ready at once.
          let totalMoved = 0;
          let batchMoved: number;
          do {
            batchMoved = await (redisService as any).moveDelayedJobsAtomic(delayedKey, queueKey, now);
            totalMoved += batchMoved;
          } while (batchMoved >= 100);

          if (totalMoved > 0) {
            logger.debug(`[DelayPoller] Moved ${totalMoved} ready job(s) from delayed:${queueName} to queue`);
          }
        } catch (err: unknown) {
          // Non-fatal — jobs stay in sorted set, will be picked up next iteration
          logger.warn(`[DelayPoller] Error for ${queueName}: ${err instanceof Error ? err.message : String(err)}`);
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
