/**
 * =============================================================================
 * METRICS DEFINITIONS - Counter, Gauge, and Histogram registrations
 * =============================================================================
 *
 * Extracted from metrics.service.ts to keep that file under 800 lines.
 * Each function receives the Maps from MetricsService and populates them.
 *
 * ADDING A NEW METRIC:
 *   1. Add the registration call in the appropriate section below.
 *   2. Use it via `metrics.incrementCounter('name')` from any service.
 * =============================================================================
 */

import type { CounterMetric, GaugeMetric, HistogramMetric } from './metrics.service';

// Pre-defined histogram buckets (in milliseconds for latency)
export const LATENCY_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

// ---------------------------------------------------------------------------
// Helper to create a fresh histogram entry
// ---------------------------------------------------------------------------
function hist(name: string, help: string, buckets: number[] = LATENCY_BUCKETS): HistogramMetric {
  return {
    name,
    help,
    buckets,
    values: new Map(),
    bucketCounts: new Map(),
    sum: new Map(),
    count: new Map(),
  };
}

function counter(name: string, help: string): CounterMetric {
  return { name, help, labels: {} };
}

function gauge(name: string, help: string, value = 0): GaugeMetric {
  return { name, help, value };
}

// =============================================================================
// REGISTRATION FUNCTIONS
// =============================================================================

export function registerDefaultCounters(counters: Map<string, CounterMetric>): void {
  const defs: CounterMetric[] = [
    // HTTP
    counter('http_requests_total', 'Total number of HTTP requests'),

    // Database
    counter('db_queries_total', 'Total number of database queries'),

    // Cache
    counter('cache_hits_total', 'Total number of cache hits'),
    counter('cache_misses_total', 'Total number of cache misses'),

    // Load testing
    counter('load_test_requests_total', 'Total number of requests tagged with X-Load-Test-Run-Id'),

    // Tracking stream
    counter('tracking_stream_publish_success_total', 'Total tracking telemetry records published successfully'),
    counter('tracking_stream_publish_fail_total', 'Total tracking telemetry records failed to publish'),
    counter('tracking_stream_dropped_total', 'Total tracking telemetry records dropped due to backpressure or retry exhaustion'),
    counter('tracking_stream_retry_total', 'Total tracking telemetry records retried for stream publishing'),
    counter('tracking_queue_dropped_total', 'Total tracking queue events dropped by queue hard limit policy'),

    // Broadcast queue guard
    counter('broadcast_queue_guard_dropped_total', 'Total broadcast queue jobs dropped by inactive-order guard'),
    counter('broadcast_queue_guard_fail_open_total', 'Total broadcast queue jobs emitted via guard fail-open fallback'),

    // Cancellation
    counter('cancel_requests_total', 'Total cancellation requests by policy stage and decision'),
    counter('cancel_emit_retry_total', 'Total cancellation fanout retries by channel'),
    counter('cancel_rebook_throttled_total', 'Total order create attempts blocked by cancel/rebook churn guard'),
    counter('holds_released_on_cancel_total', 'Total held rows released due to customer cancellation'),
    counter('cancel_dispute_created_total', 'Total blocked-stage cancel disputes created'),

    // Truck hold
    counter('hold_request_total', 'Total truck hold requests'),
    counter('hold_success_total', 'Total successful truck holds'),
    counter('hold_conflict_total', 'Total truck hold conflicts'),
    counter('hold_idempotent_replay_total', 'Total idempotent hold replays'),
    counter('hold_release_total', 'Total truck hold releases'),
    counter('hold_cleanup_released_total', 'Total holds released by cleanup'),
    counter('hold_idempotency_purged_total', 'Total idempotency keys purged'),

    // Phase 6: Dispatch pipeline
    counter('broadcast_candidates_found', 'Number of candidate transporters found per vehicle type and step'),
    counter('broadcast_fanout_total', 'Total transporters fanned out per broadcast by vehicle type'),
    counter('broadcast_skipped_no_available', 'Broadcasts skipped because no transporters were available'),

    // Phase 6: Delivery channels
    counter('broadcast_delivery_enqueued', 'Broadcast delivery jobs enqueued by channel (socket, fcm) and priority'),
    counter('broadcast_delivery_delivered', 'Broadcast messages successfully delivered by channel'),
    counter('broadcast_delivery_failed', 'Broadcast delivery failures by channel and reason'),

    // Reconciliation alerting (Issue #59)
    counter('reconciliation.orphaned_records_total', 'Total orphaned records found during reconciliation sweeps'),
    counter('reconciliation.tracking_orphans_total', 'Orphaned tracking records found (Redis trip key exists, no active DB assignment)'),
    counter('reconciliation.hold_orphans_total', 'Orphaned hold records found during hold reconciliation'),

    // F-A-85: Hold reconciliation backlog observability
    // Lets operators alert on sustained backlog growth (e.g., BATCH_SIZE too small
    // or upstream hold-expiry queue lagging).
    counter('hold_reconciliation_processed_total', 'Cumulative count of expired holds reconciled by the periodic sweeper'),

    // Tracking initialization retry (Issue #46)
    counter('tracking.init_retry_total', 'Total tracking initialization retry attempts'),
    counter('tracking.init_failure_total', 'Total tracking initialization failures after all retries'),
    counter('tracking.init_success_total', 'Total successful tracking initializations'),

    // F-A-70 — Dispatch-outbox outcome capture observability.
    // Labels: source=immediate|poller. `immediate` = awaited createOrder path
    // captured a DispatchAttemptOutcome inline; `poller` = outcome landed via
    // the background outbox retry loop. Ratio tells us whether the awaited
    // (FF_CREATE_ORDER_CONSOLIDATED) path is the dominant success route.
    counter('order_dispatch_outcome_captured_total', 'Order dispatch outcome captured by source (immediate vs poller)'),

    // W0-4 — FCM push priority canary (labels: priority, type).
    // Observability for W0-1's fix (commit 4d071a1 regression). Lets us see
    // the live high/normal breakdown per notification type so a silent flip
    // back to `normal` can be caught within minutes instead of days.
    //
    // Alert: fcm_priority_normal_ratio
    // Expression: sum(rate(fcm_push_priority_total{priority="normal"}[5m])) / sum(rate(fcm_push_priority_total[5m]))
    // Threshold: > 0.2 for 15m → investigate dispatch lag
    // Severity: WARN
    counter('fcm_push_priority_total', 'Total FCM pushes labelled by android priority (high|normal) and notification type'),

    // === P1-T1.2 (t1-2-obs-postcommit) ===
    // L2 — Post-commit best-effort cache write failures (fail-soft path).
    // Order creation is NOT blocked on these cache writes; this counter makes
    // the invisible failure rate visible to ops dashboards.
    //   Labels: cache = 'google_directions' | 'idempotency'
    //   Call sites (src/modules/order/order.service.ts):
    //     * Google Directions catch branch
    //     * Idempotency cache catch branch
    counter(
      'post_commit_cache_failure_total',
      'Post-commit best-effort cache write failures by cache type (fail-soft path)'
    ),

    // M18 — Socket.IO Redis adapter degraded window: per-emit counter that
    // fires every time emitToUser runs while `redisPubSubInitialized === false`.
    // The existing `socket_adapter_failure_total` fires once on state
    // transition; this one quantifies the blast radius of local-only emits.
    //   Labels: event = <socket event name>, mode = redisAdapterMode
    //   Call site: src/shared/services/socket.service.ts (emitToUser)
    //   Alarm descriptor (owned by T1.7):
    //     scripts/monitoring/alarm-m18-adapter-down.json
    counter(
      'socket_emit_while_adapter_down_total',
      'Socket emits processed while Redis adapter is down (local-instance only broadcast)'
    ),

    // P2 F5.2: Adapter-down fallback — counts emits routed into notification-outbox
    // when redisPubSubInitialized=false. Pair with socket_emit_while_adapter_down_total
    // to see what fraction of adapter-down emits were rescued via the outbox.
    //   Labels: event = <socket event name>
    //   Call site: src/shared/services/socket.service.ts (emitToUser, durableEmit)
    counter(
      'socket_emit_buffered_adapter_down_total',
      'Socket emits buffered in notification-outbox because Redis adapter was down (labels: event)'
    ),

    // === Phase 2 (H-5): Missing idempotency key telemetry ===
    // Fires inside the ALLOW_MISSING_IDEMPOTENCY_KEY_UNTIL grace-window branch
    // at order.routes.ts when the server fabricates a UUID because the client
    // did not send a valid x-idempotency-key header. SRE watches this counter
    // for 7-14 days; once it approaches zero, flip the grace-window date and
    // the server rejects missing keys outright (Stripe/Square pattern).
    // Label `user_agent_prefix` is the first 32 chars of User-Agent so we know
    // which client build is still missing the header.
    counter(
      'missing_idempotency_key_total',
      'Order creates accepted only via the grace-window UUID fabrication path (no client-provided Idempotency-Key)',
    ),

    // === Phase 4 (M-6): Order create rejection reasons ===
    // Low-cardinality 5-value reason label so dashboards can break down
    // rejection mix at each 4xx exit in order.routes.ts.
    // Reasons: validation_error | rate_limit | concurrent_request |
    //          missing_idempotency_key | active_order_exists
    counter(
      'order_create_rejected_total',
      'Order create rejections by reason label (validation, rate_limit, etc)',
    ),

    // === Phase 3 (H-9): Google Directions hard-timeout fallback ===
    // Fires when the 2s Promise.race timeout beats the real Distance Matrix
    // response. Non-zero means cold-cache Google responses are exceeding the
    // 10s distributed lock TTL and we're correctly falling through to
    // client_fallback route math.
    counter(
      'google_directions_timeout_total',
      'Google Directions/Distance Matrix calls that hit the client-side Promise.race timeout',
    ),

    // === Phase 3 (H-13, M-12): Haversine / no-api-key fallback reasons ===
    // Low-cardinality reason label so dashboards can separate "Google hit quota"
    // from "no API key configured" from "zero results" etc.
    // Reasons: no_api_key | rate_limit | api_error | zero_results | timeout
    counter(
      'distance_matrix_fallback_total',
      'Distance Matrix calls that fell through to haversine ETA (by reason label)',
    ),

    // === Phase 3 (H-12): Redis-coordinated Distance Matrix EPS bucket ===
    // Emitted per element on every token-bucket acquire attempt. Label
    // `result` is `allowed|denied` — dashboards show deny-rate trending
    // toward Google's 1000 EPS project quota ceiling so ops can scale the
    // bucket (DISTANCE_MATRIX_REDIS_EPS) before Google starts returning
    // OVER_QUERY_LIMIT.
    counter(
      'distance_matrix_rate_limit_total',
      'Distance Matrix Redis-coordinated token bucket decisions (result: allowed|denied)',
    ),

    // === Phase 3 (M-9): Order create Redis-fallback ops breakdown ===
    // Fires when Redis coord path degrades to per-instance in-memory limits.
    // Label `op` identifies WHICH stage degraded so dashboards show a root
    // cause instead of a generic "Redis flap" blur.
    // Ops: lock | dedupe | active_broadcast | idempotency | backpressure | debounce
    counter(
      'order_create_redis_fallback_total',
      'Order create paths that used the in-memory fallback after a Redis coord primitive failed (by op label)',
    ),

    // === Phase 5 (M-16): FCM observability trio ===
    // Thin-counter fill: currently only `fcm_push_priority_total` and
    // `fcm_mock_mode_drop_total` exist. These three add success/failure
    // parity and per-type breakdown for dashboards + SLO math.
    counter(
      'fcm_send_success_total',
      'FCM sendEachForMulticast successes, labelled by notification type and token-count bucket',
    ),
    counter(
      'fcm_send_failure_total',
      'FCM sendEachForMulticast failures, labelled by notification type and error code',
    ),
    counter(
      'fcm_dead_token_cleanup_total',
      'Dead device-token rows removed from DB after per-token FCM error (messaging/invalid-registration-token etc)',
    ),

    // === Phase 5 (M-19): Cross-channel dedup signal ===
    // Fires when the FCM processor runs AND the user was already connected
    // via socket (therefore the socket path should already have delivered).
    // Non-zero is fine — dual-channel dedup is defensive. Sustained >5%
    // suggests stale presence keys and warrants investigation.
    counter(
      'fcm_sent_while_online_total',
      'FCM pushes sent even though presenceService flagged the user as socket-connected (by type)',
    ),

    // === Phase 5 (M-20): DeviceToken sweep observability ===
    // Emitted by the daily cron at 03:00 IST that deletes rows older than
    // 90 days (DeviceToken.lastSeenAt). Lets ops see row-count trends.
    counter(
      'device_token_swept_total',
      'DeviceToken DB rows deleted by the 90-day lastSeenAt sweep cron',
    ),

    // === Phase 2 risk register: H3 ring-K rollback signal ===
    // Dashboard panel asserts rate <10/min steady-state. Spike to 100+/min
    // after C-1 deploy means the ring-K constant flip returned empty
    // candidate sets — rollback via FF_H3_RING_K_FIX=false.
    counter(
      'no_candidates_total',
      'Progressive radius matcher returned an empty candidate list (by progressive step)',
    ),

    // === Phase 2 (H-6): Idempotency replay counter ===
    // Fires when the route-layer Redis GET returns a cached 201 envelope
    // BEFORE active-order guard runs. Distinguishes "network-retry replay"
    // from "new duplicate request" in the dashboards.
    counter(
      'order_idempotency_replay_total',
      'Order create requests served directly from the route-layer idempotency cache (retry-after-lost-201 path)',
    ),

    // === Phase 3 (H-8 rule-1 compliant): Debounce Redis bypass ===
    // Fires in the debounce catch block when the Redis debounce GET/SET errors
    // and we fail-open (proceeding without debounce). Previously only emitted
    // from the deprecated delegate path at `order-creation.service.ts:175`.
    // Registering here ensures the live-path increment in `order.service.ts`
    // (added for H-8) isn't silently dropped by incrementCounter's warn-and-
    // return branch. Label `path: 'live' | 'delegate'` distinguishes the two
    // code paths so ops dashboards converge on a single counter.
    counter(
      'order_debounce_redis_bypass_total',
      'Order create debounce check skipped because Redis GET/SET failed (by path label: live | delegate)',
    ),

    // === Phase 3 (M-11): Async stale-geo cleanup queue ===
    // Inline `geoRemove + sRem + h3GeoIndexService.removeTransporter` on the
    // read path amplified writes on the hot shard (1% stale x 250 members x
    // 1000 dispatches/sec = 2500 writes/sec). Cleanup is now deferred to a
    // Redis list (`stale_geo_cleanup_queue`) drained by a single leader-gated
    // background worker. `queued` fires on every read-path enqueue; `drained`
    // fires when the worker completes a removal.
    counter(
      'stale_geo_cleanup_queued_total',
      'Stale transporter cleanup envelopes RPUSHed onto stale_geo_cleanup_queue from a read path',
    ),
    counter(
      'stale_geo_cleanup_drained_total',
      'Stale transporter cleanup envelopes drained and executed by the background worker',
    ),

    // === Phase 1 (F-series) — observability baseline ===
    // Register-only descriptors for the F-series broadcast-fix pipeline. Actual
    // increment call sites land in Phase 1 tasks 4-11. Names match the Fix
    // directions index at .planning/reviews/transporter_to_driver_INDEX.md.
    counter(
      'new_assignment_dispatch_total',
      'New-assignment primary dispatch commit (F4.15) — labels: vehicle_type, stage',
    ),
    counter(
      'new_assignment_socket_emit_total',
      'New-assignment socket emit outcome (F4.15) — labels: result=success|fail|adapter_down',
    ),
    counter(
      'new_assignment_outbox_insert_total',
      'New-assignment notification outbox insert outcome (F4.15) — labels: result=success|fail',
    ),
    counter(
      'new_assignment_fcm_enqueue_total',
      'New-assignment FCM enqueue outcome (F4.15) — labels: result=success|fail',
    ),
    counter(
      'fleetcache_read_total',
      'Fleet cache reads (F3.6) — labels: kind=vehicles|vehicle|vehicles_by_type|drivers|driver|snapshot, result=hit|miss|corrupted|error',
    ),
    counter(
      'dlq_pushed_total',
      'Dead-letter queue pushes (F7.5) — labels: queue',
    ),
    counter(
      'hold_confirmed_committed_total',
      'Confirmed-hold commits after phase transition — labels: stage',
    ),
    counter(
      'driver_accepted_total',
      'Driver accepts committed — labels: source=rest|socket',
    ),
    counter(
      'driver_declined_total',
      'Driver declines committed — labels: source=rest|socket',
    ),
    counter(
      'driver_timeout_total',
      'Driver 45s timeout fired — labels: source=timer|reconcile',
    ),
    counter(
      'driver_reassign_issued_total',
      'Driver reassign issued after decline/timeout — labels: reason=decline|timeout|offline',
    ),
    counter(
      'driver_overlay_rendered_total',
      'Driver overlay actually rendered (F9.9) — labels: type, result=ok|fail',
    ),
    counter(
      'fcm_quota_consumed_total',
      'FCM quota consumed per send success (F14.5) — labels: type, tokens_bucket',
    ),

    // === P4 F2.NEW-1: Serializable transaction retry observability ===
    // Fires each time withDbTimeout retries after P2034 (serializable conflict)
    // or P2028 (transaction already closed). Labels: `site` identifies the
    // caller (e.g. 'confirmed_hold_init') so dashboards can localize hot spots;
    // `outcome` is 'retry' for a successful retry or 'exhausted' when all
    // retries fail and the 409 TRANSACTION_CONFLICT surfaces to the client.
    counter(
      'tx_serializable_conflict_total',
      'Serializable transaction conflicts by site and outcome (retry|exhausted)',
    ),

    // === P4 F12.5: Sibling-assignment supersede observability ===
    // Fires inside the accept TX when a driver-accept cancels OTHER pending
    // assignments on the same vehicle. Label: `count_bucket` = '1' | '2' | '3'
    // | 'many' tracks how often multiple siblings pile up on one vehicle.
    // Sustained counts > 1 mean matcher is over-dispatching on the same truck.
    counter(
      'assignment_sibling_superseded_total',
      'Sibling pending assignments superseded inside accept TX (F12.5) — labels: count_bucket',
    ),

    // === P4 F2.3: Redis lock release failure observability ===
    // Fires when releaseLock() rejects in a finally block. Locks still auto-expire
    // via TTL so the flow recovers, but recurring failures here signal Redis
    // connectivity or lock-token drift that was previously invisible. Label: `op`
    // identifies the calling method (e.g. 'flex_hold_extend') for dashboard grouping.
    counter(
      'redis_lock_release_failed_total',
      'Redis distributed lock release failures by originating op',
    ),

    // === P4 F2.NEW-4: Vehicle release failure observability ===
    // Fires when releaseVehicle() throws inline OR when the VEHICLE_RELEASE
    // retry enqueue itself throws. Label: `reason` = 'inline_throw' |
    // 'enqueue_throw' so we can distinguish a transient vehicle-lifecycle
    // fault (recoverable via queue retry) from a Redis/queue subsystem
    // failure (vehicle may be pinned until reconciliation sweeps pick it up).
    counter(
      'vehicle_release_failed_total',
      'Vehicle release failures by reason (inline_throw vs enqueue_throw)',
    ),
  ];

  for (const def of defs) {
    counters.set(def.name, def);
  }
}

export function registerDefaultGauges(gauges: Map<string, GaugeMetric>): void {
  const defs: GaugeMetric[] = [
    gauge('websocket_connections', 'Current number of WebSocket connections'),
    gauge('nodejs_memory_heap_used_bytes', 'Node.js heap memory used'),
    gauge('nodejs_memory_heap_total_bytes', 'Node.js total heap memory'),
    gauge('nodejs_eventloop_lag_ms', 'Node.js event loop lag in milliseconds'),
    gauge('http_active_requests', 'Number of currently active HTTP requests'),
    gauge('tracking_stream_buffer_depth', 'Current in-memory buffer depth before tracking stream flush'),
    gauge('tracking_queue_depth', 'Current tracking queue depth'),
    gauge('tracking_queue_inflight', 'Current tracking queue in-flight workers/jobs'),
    gauge('broadcast_queue_depth', 'Current broadcast queue depth'),

    // F-A-85: Hold reconciliation observability gauges
    gauge('hold_reconciliation_backlog', 'Number of expired holds still awaiting reconciliation after a sweep cycle'),
    gauge('hold_reconciliation_oldest_expired_age_seconds', 'Age in seconds of the oldest unprocessed expired hold (0 when backlog is empty)'),

    // F-A-86: Candidate-scorer weights boot validation (1 = valid, 0 = invalid/unchecked)
    gauge('scorer_weights_boot_valid', 'Result of BEHAVIORAL_WEIGHTS Zod validation at module load (1 valid, 0 invalid)'),

    // F-A-70: Stale `dispatching` state counter — set to the number of orders
    // whose `dispatchState='dispatching'` hasn't advanced past a threshold age.
    // Non-zero and growing = the outbox poller is lagging, worth paging oncall.
    gauge('order_stale_dispatching_state', 'Orders stuck in dispatchState=dispatching past the stale threshold (F-A-70)'),

    // === Phase 1 (F-series) — observability baseline ===
    gauge(
      'circuit_breaker_state_gauge',
      'Per-circuit state (1=OPEN, 0=CLOSED/HALF_OPEN) — labels: name, source=redis|local (F15.3)',
    ),
    gauge(
      'stream_depth',
      'Socket.IO Redis Streams adapter per-stream depth (F14.5) — labels: stream',
    ),
  ];

  for (const def of defs) {
    gauges.set(def.name, def);
  }
}

export function registerDefaultHistograms(histograms: Map<string, HistogramMetric>): void {
  const defs: HistogramMetric[] = [
    // HTTP
    hist('http_request_duration_ms', 'HTTP request duration in milliseconds'),

    // Database
    hist('db_query_duration_ms', 'Database query duration in milliseconds'),

    // Load testing
    hist('load_test_request_duration_ms', 'Load test tagged request duration in milliseconds'),

    // Tracking stream
    hist('tracking_stream_batch_size', 'Tracking stream publish batch size', [1, 5, 10, 25, 50, 100, 250, 500]),

    // Broadcast queue guard
    hist('broadcast_queue_guard_lookup_latency_ms', 'Broadcast queue guard order-status lookup latency in milliseconds'),

    // Truck hold
    hist('hold_latency_ms', 'Truck hold request latency in milliseconds'),
    hist('confirm_latency_ms', 'Truck hold confirm latency in milliseconds'),

    // Phase 6: Dispatch pipeline
    hist('broadcast_candidate_lookup_ms', 'Candidate lookup latency (H3 or GEORADIUS) per progressive step', [1, 2, 5, 10, 20, 50, 100, 250, 500]),
    hist('broadcast_scoring_ms', 'ETA scoring latency per source (directions_api, haversine_fallback, cache)', [5, 10, 25, 50, 100, 250, 500, 1000, 2500]),
    hist('broadcast_end_to_end_ms', 'End-to-end broadcast pipeline latency (order creation to last fanout enqueue)', [50, 100, 250, 500, 1000, 2500, 5000, 10000]),

    // Phase 6: Delivery channels
    hist('broadcast_delivery_latency_ms', 'Broadcast delivery latency from enqueue to emit/push completion', [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]),

    // Reconciliation (Issue #59)
    hist('reconciliation.sweep_duration_ms', 'Duration of reconciliation sweep in milliseconds'),

    // F-A-85: Hold reconciliation cycle duration (seconds buckets -- low-frequency loop)
    hist(
      'hold_reconciliation_cycle_duration_seconds',
      'Per-cycle duration of the hold reconciliation sweeper in seconds',
      [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    ),

    // === Phase 5 (M-16): FCM send latency ===
    hist(
      'fcm_send_latency_ms',
      'FCM sendEachForMulticast latency per notification type',
      [50, 100, 250, 500, 1000, 2500, 5000, 10000],
    ),

    // === Phase 1 (F-series) — observability baseline ===
    hist(
      'pool_wait_seconds',
      'Prisma connection pool wait time in seconds (F14.5) — labels: pool_name',
      [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    ),
  ];

  for (const def of defs) {
    histograms.set(def.name, def);
  }
}
