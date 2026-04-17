/**
 * =============================================================================
 * F-B-50: Ordered-lifecycle mutex — canonical SEED
 * =============================================================================
 *
 * Helper for the future outbox-first primary-write path (F-B-58/62 in P8).
 * Today this service is a NO-OP unless `FF_OUTBOX_FIRST_ENABLED` is flipped;
 * the legacy nested-circuit-guard path in `socket.service.ts` remains the
 * only writer.
 *
 * The mutex is a per-(orderId, eventName) Redis `SET NX EX` lock with a
 * short TTL. It serialises duplicate-event writes so that when F-B-58
 * promotes the outbox to the primary path, two concurrent lifecycle writers
 * cannot both emit the same event for the same order.
 *
 * Contract:
 *   - `acquireLifecycleMutex(orderId, event)` → `true` when the caller owns
 *     the critical section (either acquired or the flag is OFF).
 *   - `releaseLifecycleMutex(orderId, event)` → `true` on release (or no-op).
 *   - Any Redis error falls OPEN (returns `true`) so lifecycle correctness
 *     is never sacrificed to this helper being degraded.
 *
 * =============================================================================
 */

import { redisService } from '../../shared/services/redis.service';
import { logger } from '../../shared/services/logger.service';
import { FLAGS, isEnabled } from '../../shared/config/feature-flags';
import { LIFECYCLE_MUTEX_TTL_SECONDS } from '../../shared/constants/outbox.constants';

const MUTEX_KEY_PREFIX = 'outbox:lifecycle:mutex:';
const HOLDER_ID = 'outbox-lifecycle';

/**
 * Build the canonical mutex key. Shape: `outbox:lifecycle:mutex:<orderId>:<event>`.
 */
export function lifecycleMutexKey(orderId: string, event: string): string {
  return `${MUTEX_KEY_PREFIX}${orderId}:${event}`;
}

/**
 * Acquire the per-(orderId, event) ordered-lifecycle mutex.
 *
 * Returns `true` when:
 *   - `FF_OUTBOX_FIRST_ENABLED` is OFF (legacy path untouched — seed no-op).
 *   - OR the underlying Redis lock was acquired.
 *   - OR the Redis call threw (failsafe — do NOT block lifecycle writes).
 *
 * Returns `false` only when the flag is ON AND the lock is already held.
 */
export async function acquireLifecycleMutex(
  orderId: string,
  event: string
): Promise<boolean> {
  if (!isEnabled(FLAGS.OUTBOX_FIRST_ENABLED)) return true;
  try {
    const result = await redisService.acquireLock(
      lifecycleMutexKey(orderId, event),
      HOLDER_ID,
      LIFECYCLE_MUTEX_TTL_SECONDS
    );
    return Boolean(result?.acquired);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[outbox-lifecycle-mutex] acquire failed, failing open', {
      orderId,
      event,
      error: message,
    });
    return true;
  }
}

/**
 * Release the per-(orderId, event) mutex. Always a best-effort op — any
 * failure is logged and swallowed (the TTL ensures eventual cleanup).
 * Returns `true` on no-op, on successful release, or on error.
 */
export async function releaseLifecycleMutex(
  orderId: string,
  event: string
): Promise<boolean> {
  if (!isEnabled(FLAGS.OUTBOX_FIRST_ENABLED)) return true;
  try {
    await redisService.releaseLock(lifecycleMutexKey(orderId, event), HOLDER_ID);
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[outbox-lifecycle-mutex] release failed (TTL will expire lock)', {
      orderId,
      event,
      error: message,
    });
    return true;
  }
}
