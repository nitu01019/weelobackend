/**
 * =============================================================================
 * IN-MEMORY QUEUE (Development / Single Server)
 * =============================================================================
 *
 * Extracted from queue.service.ts for file-size compliance.
 * All external consumers still import from queue.service.ts (facade).
 * =============================================================================
 */

import { EventEmitter } from 'events';
import { logger } from './logger.service';
import { redisService } from './redis.service';
import { DLQ_MAX_SIZE } from './queue.types';
import type { QueueJob, JobProcessor, IQueue } from './queue.types';

// =============================================================================
// IN-MEMORY QUEUE (Development / Single Server)
// =============================================================================

export class InMemoryQueue extends EventEmitter implements IQueue {
  // H-9 FIX: Replace flat array with Map<priority, jobs[]> per queue name.
  // Insertion is O(1) per priority level instead of O(n) findIndex + splice.
  private priorityQueues: Map<string, Map<number, QueueJob[]>> = new Map();
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
      id: `${Date.now()}-${process.pid}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      data,
      priority: options?.priority ?? 0,
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? 3,
      createdAt: Date.now(),
      processAfter: options?.delay ? Date.now() + options.delay : undefined
    };

    if (!this.priorityQueues.has(queueName)) {
      this.priorityQueues.set(queueName, new Map());
    }

    const pqMap = this.priorityQueues.get(queueName)!;

    // H-9 FIX: O(1) push into the bucket for this priority level
    if (!pqMap.has(job.priority)) {
      pqMap.set(job.priority, []);
    }
    pqMap.get(job.priority)!.push(job);

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
   * H-9 FIX: Helper — find the next processable job by draining from
   * highest priority bucket first.  Returns { job, bucket } or null.
   */
  private findNextJob(pqMap: Map<number, QueueJob[]>): { job: QueueJob; bucket: QueueJob[] } | null {
    // Sort priority keys descending (higher number = higher priority)
    const priorities = [...pqMap.keys()].sort((a, b) => b - a);
    const now = Date.now();

    for (const p of priorities) {
      const bucket = pqMap.get(p)!;
      for (let i = 0; i < bucket.length; i++) {
        const job = bucket[i];
        if (this.processing.has(job.id)) continue;
        if (job.processAfter && now < job.processAfter) continue;
        return { job, bucket };
      }
    }
    return null;
  }

  private async tick(): Promise<void> {
    if (this.processing.size >= this.concurrency) return;

    for (const [queueName, pqMap] of this.priorityQueues) {
      const processor = this.processors.get(queueName);
      if (!processor) continue;

      const found = this.findNextJob(pqMap);
      if (!found) continue;

      const { job, bucket } = found;
      this.processing.add(job.id);

      // Process asynchronously
      this.processJob(queueName, job, processor, bucket);

      // Respect concurrency limit
      if (this.processing.size >= this.concurrency) break;
    }
  }

  /**
   * H-9 FIX: Helper — remove a job from its priority bucket.
   */
  private removeJobFromBucket(queueName: string, job: QueueJob): void {
    const pqMap = this.priorityQueues.get(queueName);
    if (!pqMap) return;
    const bucket = pqMap.get(job.priority);
    if (!bucket) return;
    const idx = bucket.indexOf(job);
    if (idx !== -1) bucket.splice(idx, 1);
    // Clean up empty buckets to avoid accumulating stale keys
    if (bucket.length === 0) pqMap.delete(job.priority);
  }

  private async processJob(
    queueName: string,
    job: QueueJob,
    processor: JobProcessor,
    _bucket: QueueJob[]
  ): Promise<void> {
    try {
      // #103: Create an immutable copy with the incremented attempt count
      // instead of mutating the original job object in place.
      const updatedJob = { ...job, attempts: job.attempts + 1 };
      await processor(updatedJob);

      // Success - remove from queue
      this.removeJobFromBucket(queueName, job);

      this.emit('job:completed', { queueName, job });
      logger.debug(`Job ${job.id} completed (${queueName})`);

    } catch (error: unknown) {
      // #103: Build immutable updated job instead of mutating the original
      const failedAttempts = job.attempts + 1;
      const errorMsg = error instanceof Error ? error.message : String(error);
      const updatedJob: QueueJob = { ...job, attempts: failedAttempts, error: errorMsg };

      if (failedAttempts >= updatedJob.maxAttempts) {
        // Max retries reached - move to dead letter
        this.removeJobFromBucket(queueName, job);

        this.emit('job:failed', { queueName, job: updatedJob, error: errorMsg });
        logger.error(`Job ${updatedJob.id} failed permanently: ${error instanceof Error ? error.message : String(error)}`);

        // Persist to Redis DLQ for observability and potential recovery
        try {
          const dlqKey = `dlq:${queueName}`;
          const dlqEntry = JSON.stringify({
            jobId: updatedJob.id,
            type: updatedJob.type,
            data: updatedJob.data,
            error: error instanceof Error ? error.message : String(error),
            attempts: failedAttempts,
            failedAt: new Date().toISOString()
          });
          await redisService.lPush(dlqKey, dlqEntry);
          // M-6 FIX: Configurable DLQ cap (env: DLQ_MAX_SIZE, default 5000)
          await redisService.lTrim(dlqKey, 0, DLQ_MAX_SIZE - 1);
          // 7-day TTL — old DLQ entries auto-expire
          await redisService.expire(dlqKey, 7 * 24 * 60 * 60);
        } catch (dlqErr: unknown) {
          // DLQ persistence is best-effort — don't break the failure handler
          logger.warn(`[DLQ] Failed to persist dead letter for ${job.id}: ${dlqErr instanceof Error ? dlqErr.message : String(dlqErr)}`);
        }
      } else {
        // Schedule retry with exponential backoff — store updated job back
        const retryJob: QueueJob = { ...updatedJob, processAfter: Date.now() + Math.pow(2, failedAttempts) * 1000 };
        // Replace original job reference in its bucket with the retry copy
        const pqMap = this.priorityQueues.get(queueName);
        if (pqMap) {
          const bucket = pqMap.get(job.priority);
          if (bucket) {
            const idx = bucket.indexOf(job);
            if (idx !== -1) bucket[idx] = retryJob;
          }
        }
        this.emit('job:retry', { queueName, job: retryJob, attempt: failedAttempts });
        logger.warn(`Job ${retryJob.id} failed, retry ${failedAttempts}/${retryJob.maxAttempts}`);
      }
    } finally {
      this.processing.delete(job.id);
    }
  }

  /**
   * H-9 FIX: Helper — collect all jobs across priority buckets for a queue.
   */
  private allJobs(queueName: string): QueueJob[] {
    const pqMap = this.priorityQueues.get(queueName);
    if (!pqMap) return [];
    const jobs: QueueJob[] = [];
    for (const bucket of pqMap.values()) {
      for (const job of bucket) jobs.push(job);
    }
    return jobs;
  }

  getStats(): {
    queues: { name: string; pending: number; processing: number }[];
    totalPending: number;
    totalProcessing: number;
  } {
    const queueStats = Array.from(this.priorityQueues.keys()).map(name => {
      const jobs = this.allJobs(name);
      return {
        name,
        pending: jobs.length,
        processing: jobs.filter(j => this.processing.has(j.id)).length
      };
    });

    return {
      queues: queueStats,
      totalPending: queueStats.reduce((sum, q) => sum + q.pending, 0),
      totalProcessing: this.processing.size
    };
  }

  async getQueueDepth(queueName: string): Promise<number> {
    const pqMap = this.priorityQueues.get(queueName);
    if (!pqMap) return 0;
    let count = 0;
    for (const bucket of pqMap.values()) count += bucket.length;
    return count;
  }
}
