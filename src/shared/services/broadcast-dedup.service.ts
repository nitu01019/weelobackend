/**
 * =============================================================================
 * F-B-77: Broadcast-entry dedup — canonical SEED
 * =============================================================================
 *
 * Entry-level idempotency gate for the broadcast fan-out.
 * `acquireBroadcastDedup(key, ttl)` is a Redis `SET NX EX` that wins once per
 * `(orderId, vehicleType, vehicleSubtype)` within the TTL window. Downstream
 * F-B-78/81/82 wires this gate into `order-broadcast.service.ts::broadcast
 * VehicleTypePayload` — NOT this PR. Seed only.
 *
 * Industry precedent:
 *   - Stripe / Hookdeck entry-level idempotency keys
 *   - DoorDash/Uber dispatch dedup on (order, vehicleClass) tuple
 *
 * Failsafe semantics:
 *   - Any Redis error → return `true` (let the broadcast proceed). Silent
 *     drops are worse than over-delivery here; downstream callsite will
 *     handle "already dispatched" idempotency at a lower layer (e.g. assign
 *     uniqueness constraints).
 *
 * =============================================================================
 */

import { redisService } from './redis.service';
import { logger } from './logger.service';

const BROADCAST_DEDUP_HOLDER = 'broadcast-dedup';
const DEFAULT_DEDUP_TTL_SECONDS = 300;
const DEDUP_KEY_PREFIX = 'broadcast:dedup:order:';

/**
 * Build the canonical dedup key. Shape:
 *   `broadcast:dedup:order:<orderId>:<vehicleType>:<vehicleSubtype>`
 *
 * Downstream F-B-78 uses this exact key format at callsites.
 */
export function broadcastDedupKey(
  orderId: string,
  vehicleType: string,
  vehicleSubtype: string
): string {
  return `${DEDUP_KEY_PREFIX}${orderId}:${vehicleType}:${vehicleSubtype}`;
}

/**
 * Try to acquire the per-broadcast entry-level dedup lock.
 *
 * @param key — pass a value from `broadcastDedupKey()` (or equivalent).
 * @param ttlSec — lock TTL. Defaults to 300s (5 min) — covers the entire
 *   broadcast + driver-response window of the two-phase hold.
 * @returns `true` if the caller is the single owner for this window; `false`
 *   if another caller already holds the lock (i.e. dedup rejection). Any
 *   Redis error returns `true` to preserve broadcast delivery.
 */
export async function acquireBroadcastDedup(
  key: string,
  ttlSec: number = DEFAULT_DEDUP_TTL_SECONDS
): Promise<boolean> {
  try {
    const result = await redisService.acquireLock(
      key,
      BROADCAST_DEDUP_HOLDER,
      ttlSec
    );
    return Boolean(result?.acquired);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[broadcast-dedup] acquire failed, failing open', {
      key,
      error: message,
    });
    return true;
  }
}
