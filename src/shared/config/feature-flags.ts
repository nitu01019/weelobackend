// FIX F-6-26: Centralized feature flag registry
// Replaces inconsistent !== 'false' / === 'true' patterns across 13+ files
//
// Based on Fowler's Feature Toggle taxonomy:
//   - OPS toggles: default ON  (opt-out with 'false')  — safety/infra features
//   - RELEASE toggles: default OFF (opt-in with 'true') — experimental/new features
//
// TODO: Migrate consumers to use isEnabled(FLAGS.xxx) instead of raw process.env checks
// Consumer files pending migration:
//   - src/modules/order/order.service.ts (10 flags + 2 inline)
//   - src/shared/services/queue.service.ts (5 boolean flags)
//   - src/modules/truck-hold/truck-hold.service.ts (4 flags)
//   - src/modules/booking/booking.routes.ts (1 flag)
//   - src/shared/services/circuit-breaker.service.ts (1 flag)
//   - src/shared/services/directions-api.service.ts (1 flag)
//   - src/shared/services/h3-geo-index.service.ts (1 flag)
//   - src/shared/services/audit.service.ts (1 flag)
//   - src/modules/order/progressive-radius-matcher.ts (1 flag)
//   - src/modules/booking/booking.service.ts (1 inline flag)
//   - src/shared/services/socket.service.ts (2 inline checks)
//   - src/shared/jobs/trip-sla-monitor.job.ts (1 flag)
//   - src/shared/services/fcm.service.ts (1 flag — FF_FCM_SMART_RETRY)
//   - src/server.ts (1 inline check)

import { logger } from '../services/logger.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FlagCategory = 'ops' | 'release';

interface FlagDefinition {
  readonly env: string;
  readonly category: FlagCategory;
  readonly description: string;
  /**
   * F-B-53: Optional explicit default. When set, overrides the category
   * implicit default. LaunchDarkly best practice: declare the safe default
   * explicitly rather than rely on category/env-unset semantics. Only used
   * today by DUAL_CHANNEL_DELIVERY (safe default = true) so the "more
   * delivery paths" property is preserved if the env var is ever unset.
   */
  readonly defaultValue?: boolean;
}

interface NumericFlagDefinition {
  readonly env: string;
  readonly defaultValue: number;
  readonly description: string;
}

// ---------------------------------------------------------------------------
// Boolean Feature Flags — complete registry
// ---------------------------------------------------------------------------
// Ops toggles:     ON  by default, operator sets env='false' to disable
// Release toggles: OFF by default, operator sets env='true'  to enable

export const FLAGS = {
  // ==========================================================================
  // OPS TOGGLES — ON by default (disable with FF_xxx=false)
  // These are safety features, infrastructure protections, and proven
  // production behaviors that should only be disabled for debugging.
  // ==========================================================================

  // --- Order service (order.service.ts:66-75) ---
  BROADCAST_STRICT_SENT_ACCOUNTING: {
    env: 'FF_BROADCAST_STRICT_SENT_ACCOUNTING',
    category: 'ops' as const,
    description: 'Strict accounting of broadcast send counts — prevents over-send',
  },
  DB_STRICT_IDEMPOTENCY: {
    env: 'FF_DB_STRICT_IDEMPOTENCY',
    category: 'ops' as const,
    description: 'DB-level idempotency enforcement on order operations',
  },
  ORDER_DISPATCH_OUTBOX: {
    env: 'FF_ORDER_DISPATCH_OUTBOX',
    category: 'ops' as const,
    description: 'Transactional outbox for order dispatch events',
  },
  ORDER_DISPATCH_STATUS_EVENTS: {
    env: 'FF_ORDER_DISPATCH_STATUS_EVENTS',
    category: 'ops' as const,
    description: 'Emit status events on order dispatch lifecycle changes',
  },
  CANCEL_OUTBOX_ENABLED: {
    env: 'FF_CANCEL_OUTBOX_ENABLED',
    category: 'ops' as const,
    description: 'Transactional outbox for cancel lifecycle events',
  },
  CANCEL_POLICY_TRUCK_V1: {
    env: 'FF_CANCEL_POLICY_TRUCK_V1',
    category: 'ops' as const,
    description: 'V1 cancel fee policy for truck orders',
  },
  CANCEL_EVENT_VERSION_ENFORCED: {
    env: 'FF_CANCEL_EVENT_VERSION_ENFORCED',
    category: 'ops' as const,
    description: 'Enforce event versioning on cancel payloads',
  },
  CANCEL_REBOOK_CHURN_GUARD: {
    env: 'FF_CANCEL_REBOOK_CHURN_GUARD',
    category: 'ops' as const,
    description: 'Prevent cancel-rebook churn abuse by customers',
  },
  CANCEL_DEFERRED_SETTLEMENT: {
    env: 'FF_CANCEL_DEFERRED_SETTLEMENT',
    category: 'ops' as const,
    description: 'Defer cancel penalty settlement to async processor',
  },
  CANCEL_IDEMPOTENCY_REQUIRED: {
    env: 'FF_CANCEL_IDEMPOTENCY_REQUIRED',
    category: 'ops' as const,
    description: 'Require idempotency key on cancel requests',
  },

  // --- Queue service (queue.service.ts:64) ---
  CANCELLED_ORDER_QUEUE_GUARD: {
    env: 'FF_CANCELLED_ORDER_QUEUE_GUARD',
    category: 'ops' as const,
    description: 'Guard against processing events for already-cancelled orders',
  },

  // --- Truck hold service (truck-hold.service.ts:197-200) ---
  HOLD_DB_ATOMIC_CLAIM: {
    env: 'FF_HOLD_DB_ATOMIC_CLAIM',
    category: 'ops' as const,
    description: 'Atomic DB claim with updateMany precondition in hold flow',
  },
  HOLD_STRICT_IDEMPOTENCY: {
    env: 'FF_HOLD_STRICT_IDEMPOTENCY',
    category: 'ops' as const,
    description: 'Strict idempotency enforcement on hold requests',
  },
  HOLD_RECONCILE_RECOVERY: {
    env: 'FF_HOLD_RECONCILE_RECOVERY',
    category: 'ops' as const,
    description: 'Automatic recovery of orphaned holds during reconciliation',
  },
  HOLD_SAFE_RELEASE_GUARD: {
    env: 'FF_HOLD_SAFE_RELEASE_GUARD',
    category: 'ops' as const,
    description: 'Safety guard preventing release of holds in unexpected states',
  },

  // --- Booking routes (booking.routes.ts:33) ---
  LEGACY_BOOKING_PROXY_TO_ORDER: {
    env: 'FF_LEGACY_BOOKING_PROXY_TO_ORDER',
    category: 'ops' as const,
    description: 'Proxy legacy /bookings POST to order service for migration',
  },

  // --- Circuit breaker (circuit-breaker.service.ts:36) ---
  CIRCUIT_BREAKER_ENABLED: {
    env: 'FF_CIRCUIT_BREAKER_ENABLED',
    category: 'ops' as const,
    description: 'Master circuit breaker for Redis/external service calls',
  },

  // --- Directions API (directions-api.service.ts:56) ---
  DIRECTIONS_API_SCORING_ENABLED: {
    env: 'FF_DIRECTIONS_API_SCORING_ENABLED',
    category: 'ops' as const,
    description: 'Google Directions API scoring for candidate ranking',
  },

  // --- Trip SLA monitor (trip-sla-monitor.job.ts:228) ---
  // Note: Source uses === 'false' check, but semantics are ops-toggle
  // (ON by default, disabled with 'false'). isEnabled() matches this.
  TRIP_SLA_MONITOR: {
    env: 'FF_TRIP_SLA_MONITOR',
    category: 'ops' as const,
    description: 'Trip SLA monitoring job (scans for overdue trips)',
  },

  // --- FCM service (referenced in tests, pattern: !== 'false') ---
  FCM_SMART_RETRY: {
    env: 'FF_FCM_SMART_RETRY',
    category: 'ops' as const,
    description: 'Smart retry with exponential backoff for FCM push failures',
  },

  // --- Completion orchestrator (pattern: !== 'false') ---
  COMPLETION_ORCHESTRATOR: {
    env: 'FF_COMPLETION_ORCHESTRATOR',
    category: 'ops' as const,
    description: 'Trip completion orchestrator for multi-step finalization',
  },

  // --- Legacy order expiry checker (pattern: !== 'false') ---
  LEGACY_ORDER_EXPIRY_CHECKER: {
    env: 'FF_LEGACY_ORDER_EXPIRY_CHECKER',
    category: 'ops' as const,
    description: 'Legacy order expiry checker job for stale order cleanup',
  },

  // ==========================================================================
  // RELEASE TOGGLES — OFF by default (enable with FF_xxx=true)
  // These are experimental or new features not yet proven in production.
  // ==========================================================================

  // --- H3 geo-indexing (h3-geo-index.service.ts:62) ---
  H3_INDEX_ENABLED: {
    env: 'FF_H3_INDEX_ENABLED',
    category: 'release' as const,
    description: 'H3 hexagonal geo-indexing for dispatch matching',
  },

  // --- H3 radius steps (progressive-radius-matcher.ts:73) ---
  H3_RADIUS_STEPS: {
    env: 'FF_H3_RADIUS_STEPS',
    category: 'release' as const,
    description: 'Extended progressive radius expansion (up to 100km)',
  },

  // --- Truck mode routing (booking.service.ts:448, order.service.ts:1703) ---
  TRUCK_MODE_ROUTING: {
    env: 'FF_TRUCK_MODE_ROUTING',
    category: 'release' as const,
    description: 'Truck-specific route mode for heavy vehicles',
  },

  // --- Async audit (audit.service.ts:4) ---
  ASYNC_AUDIT: {
    env: 'FF_ASYNC_AUDIT',
    category: 'release' as const,
    description: 'Queue audit events async instead of inline DB writes',
  },

  // --- Sequence delivery (queue.service.ts:78, socket.service.ts:227,650) ---
  SEQUENCE_DELIVERY_ENABLED: {
    env: 'FF_SEQUENCE_DELIVERY_ENABLED',
    category: 'release' as const,
    description: 'RAMEN-style sequenced message delivery via Socket.IO',
  },

  // --- Dual channel delivery (queue.service.ts:81) ---
  // F-B-53: Safe default flipped ON. LaunchDarkly guidance: for a dual-write
  // safety net, over-delivery is safe and under-delivery is not. Explicit
  // `defaultValue: true` overrides the 'release' category default (which
  // would otherwise return OFF when the env var is unset).
  // Implementation: broadcast.processor.ts lines 237-284.
  DUAL_CHANNEL_DELIVERY: {
    env: 'FF_DUAL_CHANNEL_DELIVERY',
    category: 'release' as const,
    description: 'Dual channel (socket + FCM) delivery for critical events',
    defaultValue: true,
  },

  // --- Message TTL (queue.service.ts:84) ---
  // H5 fix: Promoted from release -> ops. TTL is a safety feature that prevents
  // stale messages from being delivered. Default ON; disable with FF_MESSAGE_TTL_ENABLED=false.
  MESSAGE_TTL_ENABLED: {
    env: 'FF_MESSAGE_TTL_ENABLED',
    category: 'ops' as const,
    description: 'Time-to-live expiry on queued messages',
  },

  // --- Message priority (queue.service.ts:87) ---
  MESSAGE_PRIORITY_ENABLED: {
    env: 'FF_MESSAGE_PRIORITY_ENABLED',
    category: 'release' as const,
    description: 'Priority-based message ordering in broadcast queue',
  },

  // --- POD OTP requirement (pattern: === 'true') ---
  POD_OTP_REQUIRED: {
    env: 'FF_POD_OTP_REQUIRED',
    category: 'release' as const,
    description: 'Require OTP verification for proof-of-delivery confirmation',
  },

  // --- Masked calling (pattern: === 'true') ---
  MASKED_CALLING: {
    env: 'FF_MASKED_CALLING',
    category: 'release' as const,
    description: 'Enable masked/anonymous calling between driver and customer',
  },

  // --- Behavioral scoring (pattern: === 'true') ---
  BEHAVIORAL_SCORING: {
    env: 'FF_BEHAVIORAL_SCORING',
    category: 'release' as const,
    description: 'Enable behavioral scoring for driver/transporter ranking',
  },

  // --- Queue guard fail-open (queue.service.ts:67) ---
  CANCELLED_ORDER_QUEUE_GUARD_FAIL_OPEN: {
    env: 'FF_CANCELLED_ORDER_QUEUE_GUARD_FAIL_OPEN',
    category: 'release' as const,
    description: 'Fail-open mode for cancelled order queue guard (allow on error)',
  },
} as const;

// ---------------------------------------------------------------------------
// Numeric Tuning Flags — not boolean, parsed with parseInt
// ---------------------------------------------------------------------------
// These are configuration knobs, not on/off switches. They use the
// pattern: parseInt(process.env.FF_xxx || 'default', 10) || default

export const NUMERIC_FLAGS = {
  CIRCUIT_BREAKER_THRESHOLD: {
    env: 'FF_CIRCUIT_BREAKER_THRESHOLD',
    defaultValue: 5,
    description: 'Error count threshold before circuit opens',
  },
  CIRCUIT_BREAKER_WINDOW_MS: {
    env: 'FF_CIRCUIT_BREAKER_WINDOW_MS',
    defaultValue: 30_000,
    description: 'Sliding window (ms) for counting circuit breaker errors',
  },
  CIRCUIT_BREAKER_OPEN_DURATION_MS: {
    env: 'FF_CIRCUIT_BREAKER_OPEN_DURATION_MS',
    defaultValue: 60_000,
    description: 'Duration (ms) circuit stays open before half-open probe',
  },
  QUEUE_DEPTH_CAP: {
    env: 'FF_QUEUE_DEPTH_CAP',
    defaultValue: 10_000,
    description: 'Max broadcast queue depth before rejecting new messages',
  },
  ADAPTIVE_FANOUT_CHUNK_SIZE: {
    env: 'FF_ADAPTIVE_FANOUT_CHUNK_SIZE',
    defaultValue: 500,
    description: 'Chunk size for adaptive fanout broadcast delivery',
  },
  ADAPTIVE_FANOUT_DELAY_MS: {
    env: 'FF_ADAPTIVE_FANOUT_DELAY_MS',
    defaultValue: 0,
    description: 'Delay (ms) between adaptive fanout chunks',
  },
} as const;

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------

export type FlagKey = keyof typeof FLAGS;
export type NumericFlagKey = keyof typeof NUMERIC_FLAGS;

// ---------------------------------------------------------------------------
// Runtime evaluation
// ---------------------------------------------------------------------------

/**
 * Check if a boolean feature flag is enabled.
 *
 * Precedence:
 *   1. If env var is set, explicit 'true'/'false' wins.
 *   2. Otherwise, `flag.defaultValue` (if declared) wins (F-B-53).
 *   3. Otherwise, category implicit default:
 *        ops:     ON  (safe-by-default, opt-out)
 *        release: OFF (explicit opt-in)
 *
 * Rationale: LaunchDarkly safe-default pattern lets a specific flag declare
 * "default ON" even inside the 'release' category (e.g. dual-channel delivery
 * where over-delivery is safe but under-delivery is not).
 */
export function isEnabled(flag: FlagDefinition): boolean {
  const value = process.env[flag.env];
  // Explicit env override wins.
  if (value === 'true') return true;
  if (value === 'false') return false;
  // No env setting — honor explicit defaultValue if declared.
  if (typeof flag.defaultValue === 'boolean') {
    return flag.defaultValue;
  }
  // Fall back to category implicit default.
  return flag.category === 'ops';
}

/**
 * Read a numeric tuning flag with its declared default.
 *
 * Equivalent to: parseInt(process.env.FF_xxx || 'default', 10) || default
 */
export function getNumericFlag(flag: NumericFlagDefinition): number {
  const raw = process.env[flag.env];
  if (raw === undefined || raw === '') {
    return flag.defaultValue;
  }
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? flag.defaultValue : parsed;
}

// ---------------------------------------------------------------------------
// Startup diagnostics
// ---------------------------------------------------------------------------

/**
 * Log all flag states at startup for deploy-time verification.
 * Call this once from server.ts during bootstrap.
 */
export function logFlagStates(): void {
  const booleanLines: string[] = [];
  for (const [name, def] of Object.entries(FLAGS) as [string, FlagDefinition][]) {
    const enabled = isEnabled(def);
    const raw = process.env[def.env] ?? '(unset)';
    booleanLines.push(
      `  ${enabled ? 'ON ' : 'OFF'} | ${def.category.padEnd(7)} | ${def.env} = ${raw} — ${def.description}`
    );
  }

  const numericLines: string[] = [];
  for (const [name, def] of Object.entries(NUMERIC_FLAGS) as [string, NumericFlagDefinition][]) {
    const value = getNumericFlag(def);
    const raw = process.env[def.env] ?? '(unset)';
    numericLines.push(
      `  ${String(value).padStart(6)} | tuning  | ${def.env} = ${raw} — ${def.description}`
    );
  }

  logger.info(
    `[FeatureFlags] ${Object.keys(FLAGS).length} boolean + ${Object.keys(NUMERIC_FLAGS).length} numeric flags:\n` +
    `--- Boolean Flags ---\n${booleanLines.join('\n')}\n` +
    `--- Numeric Flags ---\n${numericLines.join('\n')}`
  );
}
