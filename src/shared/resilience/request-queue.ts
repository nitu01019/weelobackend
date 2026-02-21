/**
 * =============================================================================
 * REQUEST QUEUE - High Load Protection
 * =============================================================================
 * 
 * Manages request queuing during high load scenarios.
 * 
 * WHY THIS MATTERS FOR MILLIONS OF USERS:
 * - During traffic spikes, prevents server overload
 * - Ensures fair processing order (FIFO)
 * - Provides backpressure to prevent cascading failures
 * - Can shed load gracefully when queue is full
 * 
 * FEATURES:
 * - Priority queuing (VIP users, critical operations)
 * - Timeout handling (reject stale requests)
 * - Concurrency limiting (max parallel operations)
 * - Queue metrics for monitoring
 * 
 * USAGE:
 * ```typescript
 * const queue = new RequestQueue({ maxConcurrent: 100, maxQueueSize: 1000 });
 * 
 * app.use('/api/bookings', queue.middleware({ priority: 'high' }));
 * ```
 * =============================================================================
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../services/logger.service';
import { metrics } from '../monitoring/metrics.service';

/**
 * Priority levels
 */
export enum Priority {
  LOW = 0,
  NORMAL = 1,
  HIGH = 2,
  CRITICAL = 3
}

/**
 * Queued request item
 */
interface QueueItem {
  id: string;
  priority: Priority;
  timestamp: number;
  timeout: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * Queue configuration
 */
export interface RequestQueueOptions {
  /** Maximum concurrent requests to process */
  maxConcurrent?: number;
  /** Maximum queue size (reject if exceeded) */
  maxQueueSize?: number;
  /** Request timeout in queue (ms) */
  queueTimeout?: number;
  /** Name for metrics/logging */
  name?: string;
}

/**
 * Default options
 */
const DEFAULT_OPTIONS: Required<RequestQueueOptions> = {
  maxConcurrent: 100,
  maxQueueSize: 1000,
  queueTimeout: 30000, // 30 seconds
  name: 'default'
};

/**
 * Error when queue is full
 */
export class QueueFullError extends Error {
  constructor() {
    super('Server is busy. Please try again later.');
    this.name = 'QueueFullError';
  }
}

/**
 * Error when request times out in queue
 */
export class QueueTimeoutError extends Error {
  constructor() {
    super('Request timed out waiting in queue.');
    this.name = 'QueueTimeoutError';
  }
}

/**
 * Request Queue Implementation
 */
export class RequestQueue {
  private queue: QueueItem[] = [];
  private activeCount: number = 0;
  private options: Required<RequestQueueOptions>;
  private requestCounter: number = 0;
  private cleanupTimer: NodeJS.Timeout;
  
  constructor(options: RequestQueueOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    
    logger.info(`Request queue '${this.options.name}' initialized`, {
      maxConcurrent: this.options.maxConcurrent,
      maxQueueSize: this.options.maxQueueSize
    });
    
    // Periodically clean up timed-out requests
    this.cleanupTimer = setInterval(() => this.cleanupTimedOut(), 5000);
    // Prevent this timer from keeping test processes alive.
    this.cleanupTimer.unref();
  }
  
  /**
   * Acquire a slot (wait if necessary)
   */
  async acquire(priority: Priority = Priority.NORMAL, timeout?: number): Promise<void> {
    // If we have capacity, proceed immediately
    if (this.activeCount < this.options.maxConcurrent) {
      this.activeCount++;
      metrics.incrementGauge('queue_active_requests');
      return;
    }
    
    // Check if queue is full
    if (this.queue.length >= this.options.maxQueueSize) {
      metrics.incrementCounter('queue_rejected', { queue: this.options.name });
      throw new QueueFullError();
    }
    
    // Add to queue
    return new Promise((resolve, reject) => {
      const item: QueueItem = {
        id: `req_${++this.requestCounter}`,
        priority,
        timestamp: Date.now(),
        timeout: timeout || this.options.queueTimeout,
        resolve: () => {
          this.activeCount++;
          metrics.incrementGauge('queue_active_requests');
          resolve();
        },
        reject
      };
      
      // Insert by priority (higher priority first, then by timestamp)
      const insertIndex = this.queue.findIndex(
        q => q.priority < priority || (q.priority === priority && q.timestamp > item.timestamp)
      );
      
      if (insertIndex === -1) {
        this.queue.push(item);
      } else {
        this.queue.splice(insertIndex, 0, item);
      }
      
      metrics.setGauge('queue_size', this.queue.length);
      metrics.incrementCounter('queue_enqueued', { queue: this.options.name });
      
      logger.debug(`Request ${item.id} queued`, {
        queueSize: this.queue.length,
        priority
      });
    });
  }
  
  /**
   * Release a slot
   */
  release(): void {
    if (this.activeCount > 0) {
      this.activeCount--;
    } else {
      // Defensive guard: duplicate release hooks should never underflow active slots.
      this.activeCount = 0;
      logger.warn(`Queue '${this.options.name}' release called with activeCount=0`);
    }
    metrics.decrementGauge('queue_active_requests');
    
    // Process next in queue
    this.processNext();
  }
  
  /**
   * Process next item in queue
   */
  private processNext(): void {
    if (this.queue.length === 0) return;
    if (this.activeCount >= this.options.maxConcurrent) return;
    
    const item = this.queue.shift();
    if (!item) return;
    
    metrics.setGauge('queue_size', this.queue.length);
    
    // Check if request timed out while waiting
    const waitTime = Date.now() - item.timestamp;
    if (waitTime > item.timeout) {
      metrics.incrementCounter('queue_timeout', { queue: this.options.name });
      item.reject(new QueueTimeoutError());
      this.processNext(); // Try next one
      return;
    }
    
    metrics.observeHistogram('queue_wait_time_ms', waitTime, { queue: this.options.name });
    item.resolve();
  }
  
  /**
   * Clean up timed-out requests
   */
  private cleanupTimedOut(): void {
    const now = Date.now();
    const timedOut = this.queue.filter(
      item => now - item.timestamp > item.timeout
    );
    
    for (const item of timedOut) {
      const index = this.queue.indexOf(item);
      if (index > -1) {
        this.queue.splice(index, 1);
        metrics.incrementCounter('queue_timeout', { queue: this.options.name });
        item.reject(new QueueTimeoutError());
      }
    }
    
    if (timedOut.length > 0) {
      metrics.setGauge('queue_size', this.queue.length);
      logger.warn(`Cleaned up ${timedOut.length} timed-out requests from queue`);
    }
  }
  
  /**
   * Express middleware factory
   */
  middleware(options: { priority?: Priority; timeout?: number } = {}) {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        await this.acquire(options.priority, options.timeout);

        let released = false;
        const releaseOnce = () => {
          if (released) return;
          released = true;
          this.release();
        };

        // Release slot exactly once when response finishes/closes.
        res.once('finish', releaseOnce);
        res.once('close', releaseOnce);
        
        next();
      } catch (error) {
        if (error instanceof QueueFullError) {
          res.status(503).json({
            success: false,
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: error.message
            }
          });
        } else if (error instanceof QueueTimeoutError) {
          res.status(408).json({
            success: false,
            error: {
              code: 'REQUEST_TIMEOUT',
              message: error.message
            }
          });
        } else {
          next(error);
        }
      }
    };
  }
  
  /**
   * Get queue statistics
   */
  getStats(): {
    name: string;
    activeCount: number;
    queueSize: number;
    maxConcurrent: number;
    maxQueueSize: number;
  } {
    return {
      name: this.options.name,
      activeCount: this.activeCount,
      queueSize: this.queue.length,
      maxConcurrent: this.options.maxConcurrent,
      maxQueueSize: this.options.maxQueueSize
    };
  }
  
  /**
   * Clear the queue (reject all waiting requests)
   */
  clear(): void {
    const error = new Error('Queue cleared');
    for (const item of this.queue) {
      item.reject(error);
    }
    this.queue = [];
    metrics.setGauge('queue_size', 0);
    logger.info(`Queue '${this.options.name}' cleared`);
  }
}

// =============================================================================
// PRE-CONFIGURED QUEUES
// =============================================================================

/**
 * Default request queue for general API requests
 */
export const defaultQueue = new RequestQueue({
  name: 'default',
  maxConcurrent: 200,
  maxQueueSize: 2000,
  queueTimeout: 30000
});

/**
 * Booking queue (higher priority, smaller)
 */
export const bookingQueue = new RequestQueue({
  name: 'booking',
  maxConcurrent: 50,
  maxQueueSize: 500,
  queueTimeout: 20000
});

/**
 * Tracking queue (high throughput for GPS updates)
 */
export const trackingQueue = new RequestQueue({
  name: 'tracking',
  maxConcurrent: 500,
  maxQueueSize: 5000,
  queueTimeout: 5000
});

/**
 * Auth queue (strict limits for security)
 */
export const authQueue = new RequestQueue({
  name: 'auth',
  maxConcurrent: 100,
  maxQueueSize: 1000,
  queueTimeout: 15000
});
