"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.queueService = void 0;
const logger_service_1 = require("./logger.service");
const events_1 = require("events");
// =============================================================================
// IN-MEMORY QUEUE (Development / Single Server)
// =============================================================================
class InMemoryQueue extends events_1.EventEmitter {
    queues = new Map();
    processors = new Map();
    processing = new Set();
    isRunning = false;
    processInterval = null;
    // Configuration
    concurrency = 10;
    pollInterval = 100; // ms
    constructor() {
        super();
        this.start();
    }
    /**
     * Add a job to the queue
     */
    async add(queueName, type, data, options) {
        const job = {
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
        const queue = this.queues.get(queueName);
        // Insert by priority (higher priority first)
        const insertIndex = queue.findIndex(j => j.priority < job.priority);
        if (insertIndex === -1) {
            queue.push(job);
        }
        else {
            queue.splice(insertIndex, 0, job);
        }
        logger_service_1.logger.debug(`Job ${job.id} added to queue ${queueName} (type: ${type})`);
        this.emit('job:added', { queueName, job });
        return job.id;
    }
    /**
     * Add multiple jobs at once (batch)
     */
    async addBatch(queueName, jobs) {
        const ids = [];
        for (const job of jobs) {
            const id = await this.add(queueName, job.type, job.data, { priority: job.priority });
            ids.push(id);
        }
        return ids;
    }
    /**
     * Register a processor for a queue
     */
    process(queueName, processor) {
        this.processors.set(queueName, processor);
        logger_service_1.logger.info(`Processor registered for queue: ${queueName}`);
    }
    /**
     * Start processing jobs
     */
    start() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        this.processInterval = setInterval(() => this.tick(), this.pollInterval);
        logger_service_1.logger.info('🚀 Queue processor started');
    }
    /**
     * Stop processing jobs
     */
    stop() {
        this.isRunning = false;
        if (this.processInterval) {
            clearInterval(this.processInterval);
            this.processInterval = null;
        }
        logger_service_1.logger.info('⏹️ Queue processor stopped');
    }
    /**
     * Process tick - check for jobs to process
     */
    async tick() {
        if (this.processing.size >= this.concurrency)
            return;
        for (const [queueName, queue] of this.queues) {
            const processor = this.processors.get(queueName);
            if (!processor)
                continue;
            // Find next processable job
            const jobIndex = queue.findIndex(job => {
                if (this.processing.has(job.id))
                    return false;
                if (job.processAfter && Date.now() < job.processAfter)
                    return false;
                return true;
            });
            if (jobIndex === -1)
                continue;
            const job = queue[jobIndex];
            this.processing.add(job.id);
            // Process asynchronously
            this.processJob(queueName, job, processor, jobIndex);
            // Respect concurrency limit
            if (this.processing.size >= this.concurrency)
                break;
        }
    }
    /**
     * Process a single job
     */
    async processJob(queueName, job, processor, _jobIndex) {
        try {
            job.attempts++;
            await processor(job);
            // Success - remove from queue
            const queue = this.queues.get(queueName);
            if (queue) {
                const idx = queue.indexOf(job);
                if (idx !== -1)
                    queue.splice(idx, 1);
            }
            this.emit('job:completed', { queueName, job });
            logger_service_1.logger.debug(`Job ${job.id} completed (${queueName})`);
        }
        catch (error) {
            job.error = error.message;
            if (job.attempts >= job.maxAttempts) {
                // Max retries reached - move to dead letter
                const queue = this.queues.get(queueName);
                if (queue) {
                    const idx = queue.indexOf(job);
                    if (idx !== -1)
                        queue.splice(idx, 1);
                }
                this.emit('job:failed', { queueName, job, error: error.message });
                logger_service_1.logger.error(`Job ${job.id} failed permanently: ${error.message}`);
            }
            else {
                // Schedule retry with exponential backoff
                job.processAfter = Date.now() + Math.pow(2, job.attempts) * 1000;
                this.emit('job:retry', { queueName, job, attempt: job.attempts });
                logger_service_1.logger.warn(`Job ${job.id} failed, retry ${job.attempts}/${job.maxAttempts}`);
            }
        }
        finally {
            this.processing.delete(job.id);
        }
    }
    /**
     * Get queue stats
     */
    getStats() {
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
    queue;
    // Queue names for organization
    static QUEUES = {
        BROADCAST: 'broadcast', // Broadcast notifications to transporters
        PUSH_NOTIFICATION: 'push', // FCM push notifications
        EMAIL: 'email', // Email notifications (future)
        SMS: 'sms', // SMS notifications (future)
        ANALYTICS: 'analytics', // Analytics events
        CLEANUP: 'cleanup' // Cleanup/maintenance tasks
    };
    constructor() {
        this.queue = new InMemoryQueue();
        this.registerDefaultProcessors();
    }
    /**
     * Register default job processors
     */
    registerDefaultProcessors() {
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
        logger_service_1.logger.info('📋 Queue processors registered');
    }
    /**
     * Queue a broadcast to a transporter
     */
    async queueBroadcast(transporterId, event, data, priority = 0) {
        return this.queue.add(QueueService.QUEUES.BROADCAST, 'broadcast', { transporterId, event, data }, { priority });
    }
    /**
     * Queue broadcasts to multiple transporters (batch)
     */
    async queueBroadcastBatch(transporterIds, event, data) {
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
    async queuePushNotification(userId, notification) {
        return this.queue.add(QueueService.QUEUES.PUSH_NOTIFICATION, 'push', { userId, notification }, { maxAttempts: 3 });
    }
    /**
     * Queue push notifications to multiple users (batch)
     */
    async queuePushNotificationBatch(userIds, notification) {
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
    async addJob(queueName, type, data, options) {
        return this.queue.add(queueName, type, data, options);
    }
    /**
     * Register custom processor
     */
    registerProcessor(queueName, processor) {
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
    stop() {
        this.queue.stop();
    }
}
// Export singleton
exports.queueService = new QueueService();
//# sourceMappingURL=queue.service.js.map