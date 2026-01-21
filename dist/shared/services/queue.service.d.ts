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
declare class QueueService {
    private queue;
    static readonly QUEUES: {
        BROADCAST: string;
        PUSH_NOTIFICATION: string;
        EMAIL: string;
        SMS: string;
        ANALYTICS: string;
        CLEANUP: string;
    };
    constructor();
    /**
     * Register default job processors
     */
    private registerDefaultProcessors;
    /**
     * Queue a broadcast to a transporter
     */
    queueBroadcast(transporterId: string, event: string, data: any, priority?: number): Promise<string>;
    /**
     * Queue broadcasts to multiple transporters (batch)
     */
    queueBroadcastBatch(transporterIds: string[], event: string, data: any): Promise<string[]>;
    /**
     * Queue a push notification
     */
    queuePushNotification(userId: string, notification: {
        title: string;
        body: string;
        data?: Record<string, string>;
    }): Promise<string>;
    /**
     * Queue push notifications to multiple users (batch)
     */
    queuePushNotificationBatch(userIds: string[], notification: {
        title: string;
        body: string;
        data?: Record<string, string>;
    }): Promise<string[]>;
    /**
     * Add custom job
     */
    addJob<T>(queueName: string, type: string, data: T, options?: {
        priority?: number;
        delay?: number;
        maxAttempts?: number;
    }): Promise<string>;
    /**
     * Register custom processor
     */
    registerProcessor(queueName: string, processor: JobProcessor): void;
    /**
     * Get queue statistics
     */
    getStats(): {
        queues: {
            name: string;
            pending: number;
            processing: number;
        }[];
        totalPending: number;
        totalProcessing: number;
    };
    /**
     * Stop all queue processing
     */
    stop(): void;
}
export declare const queueService: QueueService;
export {};
//# sourceMappingURL=queue.service.d.ts.map