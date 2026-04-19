/**
 * F-H14: Rating Reminder Service
 * Schedules push notification reminders at 1h, 24h, 72h after trip completion.
 * Uses existing redisService timer infrastructure for delayed job scheduling
 * and queueService for push notification delivery.
 */
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { queueService } from '../../shared/services/queue.service';

const REMINDER_DELAYS_MS = [
  1 * 60 * 60 * 1000,   // 1 hour
  24 * 60 * 60 * 1000,  // 24 hours
  72 * 60 * 60 * 1000,  // 72 hours
];

const TIMER_PREFIX = 'timer:rating-reminder:';

function buildTimerKey(assignmentId: string, delayMs: number): string {
  return `${TIMER_PREFIX}${assignmentId}:${delayMs}`;
}

export async function scheduleRatingReminders(params: {
  customerId: string;
  assignmentId: string;
  tripId: string;
  bookingId: string;
  driverName: string;
  vehicleNumber: string;
}): Promise<void> {
  for (const delayMs of REMINDER_DELAYS_MS) {
    try {
      const timerKey = buildTimerKey(params.assignmentId, delayMs);
      const expiresAt = new Date(Date.now() + delayMs);

      await redisService.setTimer(timerKey, {
        ...params,
        delayMs,
      }, expiresAt);

      logger.debug('[RATING REMINDER] Scheduled', {
        assignmentId: params.assignmentId,
        delayMs,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (err) {
      logger.warn('[RATING REMINDER] Failed to schedule (non-fatal)', {
        assignmentId: params.assignmentId,
        delayMs,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function cancelRatingReminders(assignmentId: string): Promise<void> {
  for (const delayMs of REMINDER_DELAYS_MS) {
    const timerKey = buildTimerKey(assignmentId, delayMs);
    await redisService.cancelTimer(timerKey).catch(() => {});
  }
  logger.debug('[RATING REMINDER] Cancelled all reminders', { assignmentId });
}

/**
 * Process expired rating reminder timers.
 * Called by a poller (e.g., setInterval in app startup or queue processor).
 * Sends a push notification to the customer if they haven't rated yet.
 */
export async function processExpiredRatingReminders(): Promise<void> {
  try {
    const expired = await redisService.getExpiredTimers<{
      customerId: string;
      assignmentId: string;
      tripId: string;
      bookingId: string;
      driverName: string;
      vehicleNumber: string;
      delayMs: number;
    }>(TIMER_PREFIX);

    for (const timer of expired) {
      try {
        const { customerId, driverName, vehicleNumber, assignmentId } = timer.data;

        await queueService.queuePushNotification(customerId, {
          title: 'Rate your trip',
          body: `How was your trip with ${driverName} (${vehicleNumber})? Tap to rate.`,
          data: {
            type: 'rating_reminder',
            assignmentId,
          },
        });

        logger.info('[RATING REMINDER] Push notification sent', {
          customerId,
          assignmentId,
          timerKey: timer.key,
        });
      } catch (err) {
        logger.warn('[RATING REMINDER] Failed to send push (non-fatal)', {
          timerKey: timer.key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.warn('[RATING REMINDER] Poll cycle failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
