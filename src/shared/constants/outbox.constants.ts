/**
 * =============================================================================
 * F-B-50: FCM outbox canonical SEED — unified constants
 * =============================================================================
 *
 * Single source of truth for the notification outbox + ordered-lifecycle
 * primary-write path that F-B-58/62 flip in P8. Today the constants are
 * exported but the downstream write-path consumers are NOT yet wired —
 * `FF_OUTBOX_FIRST_ENABLED` stays OFF until the flip wave.
 *
 * Dependencies:
 *   - `DLQ_MAX_SIZE` in `queue.types.ts:68` — re-exported here under
 *     `LIFECYCLE_OUTBOX_DLQ_MAX` so future outbox consumers share one cap.
 *   - The socket service already declares `LIFECYCLE_EMIT_EVENTS` as a
 *     module-local set. Duplicating the set here (the canonical home for
 *     downstream writers) until F-B-58 migrates the socket service to import
 *     from this file — avoids a circular import hazard today.
 *
 * =============================================================================
 */

import { DLQ_MAX_SIZE } from '../services/queue.types';

/**
 * Unified DLQ cap for lifecycle outbox failures. Mirrors the existing
 * `DLQ_MAX_SIZE` env-tunable from `queue.types.ts`. Consumers should import
 * from THIS file so the cap is single-sourced; the queue re-export remains
 * for backward compat.
 */
export const LIFECYCLE_OUTBOX_DLQ_MAX = DLQ_MAX_SIZE;

/**
 * Lifecycle events that require at-least-once durable delivery. Downstream
 * F-B-58/62 use this set to gate the ordered-lifecycle primary-write path;
 * F-B-50 SEEDS the canonical declaration without yet flipping the path.
 *
 * Kept in sync manually with `socket.service.ts`'s same-named module-local
 * set until F-B-58 migrates the socket service to import from here.
 */
export const LIFECYCLE_EMIT_EVENTS: ReadonlySet<string> = new Set([
  'trip_assigned',
  'truck_confirmed',
  'driver_accepted',
  'driver_declined',
  'booking_updated',
  'booking_expired',
  'booking_cancelled',
  'booking_completed',
  'assignment_status_changed',
  'assignment_stale',
  'assignment_timeout',
  'driver_timeout',
  'hold_expired',
  'hold_confirmed',
  'hold_released',
  'flex_hold_started',
  'flex_hold_extended',
  'new_broadcast',
  'broadcast_state_changed',
  'order_cancelled',
  'order_expired',
  'order_completed',
  'order_status_update',
  'order_state_sync',
  'payment_pending',
  'payment_confirmed',
  'payment_succeeded',
  'payment_failed',
  'sos_alert',
  'cascade_reassigned',
]);

/**
 * TTL for the per-(orderId,event) ordered-lifecycle mutex. Must be short —
 * only covers the critical section between "outbox write" and "socket emit"
 * handoff. F-B-58 consumes this TTL; seed declares it.
 */
export const LIFECYCLE_MUTEX_TTL_SECONDS = 5;
