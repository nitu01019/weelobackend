/**
 * Assignment Timeout Poller
 *
 * FIX Problem 16: Poll for expired assignment-timeout timers every 5 seconds.
 * Uses Redis sorted-set timers with distributed locking for multi-ECS safety.
 */

import { logger } from '../services/logger.service';
import { redisService } from '../services/redis.service';

export function startAssignmentTimeoutPoller(): void {
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
        } catch (err: unknown) {
          logger.error('[TIMER] Assignment timeout handler failed', {
            key: timer.key,
            assignmentId: timer.data?.assignmentId,
            error: err instanceof Error ? err.message : String(err)
          });
        } finally {
          await redisService.releaseLock(timerLockKey, 'assignment-timeout-poller').catch(() => {});
        }
      }
    } catch (pollErr: unknown) {
      logger.warn(`[TIMER] Assignment timeout poll error: ${pollErr instanceof Error ? pollErr.message : String(pollErr)}`);
    }
  }, 5000);

  poller.unref();
}
