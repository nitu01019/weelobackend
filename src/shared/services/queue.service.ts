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
}

// =============================================================================
// QUEUE SERVICE (Unified Interface)
// =============================================================================

class QueueService {
  private queue: InMemoryQueue;
  
  // Queue names for organization
  static readonly QUEUES = {
    BROADCAST: 'broadcast',           // Broadcast notifications to transporters
    PUSH_NOTIFICATION: 'push',        // FCM push notifications
    EMAIL: 'email',                   // Email notifications (future)
    SMS: 'sms',                       // SMS notifications (future)
    ANALYTICS: 'analytics',           // Analytics events
    CLEANUP: 'cleanup'                // Cleanup/maintenance tasks
  };
  
  constructor() {
    this.queue = new InMemoryQueue();
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
      emitToUser(transporterId, event, data);
    });
    
    // Push notification processor
    this.queue.process(QueueService.QUEUES.PUSH_NOTIFICATION, async (job) => {
      const { sendPushNotification } = require('./fcm.service');
      const { userId, notification } = job.data;
      await sendPushNotification(userId, notification);
    });
    
    logger.info('📋 Queue processors registered');
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
   * Add custom job
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
  }
}

// Export singleton
export const queueService = new QueueService();
