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

    // === P5 F7.x: Durable assignment timer schedule failure observability ===
    // Fires inside scheduleAssignmentTimeout() when the primary Redis-backed
    // setTimer call throws. The in-memory setTimeout fallback has been removed
    // (P5 contract: timers MUST be durable). A non-zero rate means callers are
    // rethrowing and relying on their own retry/compensation path or on the
    // ASSIGNMENT_RECONCILIATION backstop (every 2 min). Labels:
    //   timer_type = 'assignment_timeout' (reserved for future timer kinds)
    counter(
      'queue_schedule_failed_total',
      'Durable timer schedule failures by timer_type (Redis setTimer rejection; no in-memory fallback)',
    ),

    // A04-003 — observability-only counter on Redis Streams adapter init. The
    // adapter uses plain XREAD (not XREADGROUP) so there is no consumer-group
    // PEL to reclaim on pod death. Per-user ZSET durable-emit is the real net.
    //   Labels: adapter = '@socket.io/redis-streams-adapter'
    //   Call site: src/shared/services/socket.service.ts (setupRedisAdapter success branch)
    counter(
      'socket_adapter_no_pel_reclaim_total',
      'Redis Streams adapter init events — adapter uses plain XREAD with no consumer-group PEL (no cross-instance reclaim on pod death)',
    ),

    // A09-002 / A12-009 — role-scoped durable-emit ZSET rollout observability.
    // Emitted per durableEmit / persistRoomEnvelopes write. Lets SRE watch the
    // 3-phase rollout ramp (v1 → v2) as FF_ROLE_SCOPED_DURABLE_EMIT flips.
    //   Labels: version = 'v1' | 'v2'
    //   Call sites: src/shared/services/socket.service.ts (durableEmit, persistRoomEnvelopes)
    counter(
      'socket_unacked_key_version',
      'Role-scoped durable-emit ZSET writes labelled by key-schema version (v1 = legacy socket:unacked:{userId}, v2 = socket:unacked:{userId}:{role})',
    ),

    // A09-002 / A12-009 (Arch 1B amendment) — dual-write atomicity failure
    // observability. Fires when the MULTI/EXEC pipeline around the Phase-1
    // dual-write rejects. Non-zero indicates partial-failure risk; alert on
    // any single hit because the abort preserves atomicity but means the
    // emit did not persist to EITHER key (caller falls back to plain emit).
    //   Labels: phase = '1' | '2'
    //   Call sites: src/shared/services/socket.service.ts (durableEmit, persistRoomEnvelopes)
    counter(
      'socket_unacked_dual_write_fail_total',
      'Role-scoped durable-emit dual-write MULTI/EXEC failures by rollout phase (Arch 1B amendment — atomicity abort, neither write visible)',
    ),

    // A09-002 / A12-009 Phase 2 — cross-role replay drop observability.
    // Fires when the reconnect-time replay filter drops an envelope whose
    // `role` tag mismatches the reconnecting socket's role. Belt-and-braces
    // DPDP guard; non-zero indicates dual-role users reconnecting into a
    // different role with queued events from a prior role session.
    //   Labels: role = <socket.data.role>
    //   Call site: src/shared/services/socket.service.ts (Phase 2 replay reader)
    counter(
      'socket_replay_dropped_cross_role_total',
      'Durable-emit replay envelopes dropped due to role mismatch (envelope.role != socket.role) — Phase 2 DPDP filter',
    ),

    // A13-005 — confirmed-hold post-commit fanout observability. Emitted once
    // per outcome per confirmed-hold initialize: one 'expected' bump per driver
    // assignment (how many notifications the fast path intended to send), one
    // 'socket_ok' bump per successful socket emit, one 'fcm_ok' bump per FCM
    // enqueue. The ratio socket_ok/expected + fcm_ok/expected is the SLO signal
    // for fast-path health; sustained divergence signals poller catch-up (and
    // potential driver-notification loss pre-A03-004 outbox flip, or poller
    // replay latency post-flip).
    //   Labels: outcome = 'expected' | 'socket_ok' | 'fcm_ok'
    //   Call site: src/modules/truck-hold/confirmed-hold.service.ts (fanout loop post-commit)
    counter(
      'confirmed_hold_fanout_total',
      'Confirmed-hold post-commit fan-out outcomes by type (expected = intended notifications; socket_ok / fcm_ok = successful channel delivery)',
    ),

    // === A05-019 (P1-T23): FCM boot credential failure counter ===
    // Fires on any FCM init or dry-run failure. The `reason` label is a closed
    // enum: base64_decode_failed | pem_parse_failed | dry_run_failed | env_missing.
    // NEVER use raw error messages as label values (high cardinality + PII leak).
    //   Call site: src/shared/services/fcm.service.ts (_emitInitFailureMetric)
    //   Alarm: any non-zero rate in production → page oncall (credential mis-config)
    counter(
      'fcm_init_missing_config',
      'FCM credential init or boot dry-run failures — reason label is a closed enum (base64_decode_failed|pem_parse_failed|dry_run_failed|env_missing)',
    ),

    // === A05-019 (P1-T??): FCM mock-mode drop counter ===
    // Already referenced by fcm.service.ts; registered here so incrementCounter
    // does not silently warn on boot.
    counter(
      'fcm_mock_mode_drop_total',
      'FCM notifications dropped because the service is in mock mode (no credentials configured)',
    ),

    // === A05-019: FCM retry backoff source counter ===
    // Already referenced by fcm.service.ts (executeWithRetry). Registered here
    // so the warn-and-return branch in incrementCounter is never triggered.
    //   Labels: source = 'retry_after_header' | 'exponential'
    counter(
      'fcm_retry_backoff_source_total',
      'FCM retry backoff strategy used per attempt (retry_after_header vs exponential)',
    ),

    // === P3-T34 / A13-011: Socket.IO connection counter ===
    // Incremented on every socket 'connection' event in the Socket.IO server.
    // The rate (socket_connect_total per 30s) > 5000/s triggers a reconnect-storm
    // alarm (weelo-p3-socket-reconnect-surge). A storm indicates a rolling deploy,
    // Redis adapter restart, or client-side bug causing mass rapid reconnects.
    //   Call site: src/shared/services/socket.service.ts (io.on('connection'))
    counter(
      'socket_connect_total',
      'Total Socket.IO connection events — rate spike > 5000/s triggers reconnect-storm alarm (P3-T34 / A13-011)',
    ),

    // === A03-009 / A12-011: Notification-outbox observability ===
    // outbox_buffered_total: fires on every Redis LPUSH in bufferNotification.
    //   Labels: reason = 'adapter_down' | <caller-supplied reason>
    // outbox_drained_total: fires per entry during drainOutbox drain loop.
    //   Labels: outcome = 'delivered' | 'stale_skipped' | 'failed'
    //           outbox  = 'notification'
    counter(
      'outbox_buffered_total',
      'Notifications buffered into the Redis outbox by reason (adapter_down etc) — A03-009',
    ),
    counter(
      'outbox_drained_total',
      'Outbox drain outcomes by result and outbox name (delivered|stale_skipped|failed) — A03-009',
    ),
    // === A04-005 / A04-006 / A12-010+A13-012: dispatch_ack handler observability ===
    // dispatch_ack_oversized_total: fires when raw payload exceeds 1KB pre-parse DoS guard.
    //   Call site: src/shared/services/socket.service.ts (dispatch_ack handler P3-E amend)
    counter(
      'dispatch_ack_oversized_total',
      'dispatch_ack payloads rejected before Zod parse because raw length > 1 KB (DoS pre-filter)',
    ),
    // dispatch_ack_rate_limited_total: fires when per-socket 10/s rate limit is exceeded.
    //   Call site: src/shared/services/socket.service.ts (dispatch_ack handler P3-E amend)
    counter(
      'dispatch_ack_rate_limited_total',
      'dispatch_ack events dropped because the per-socket 10/s rate limit was exceeded',
    ),

    // === A04-002 / A15-010 (P5-08): Two-tier JWT cache observability ===
    // jwt_cache_hits_total{tier}: tracks L1 hit, L2 hit, and full-verify paths.
    //   Labels: tier = 'l1' | 'l2' | 'full'
    //   L1 hit = served from in-process LRU; L2 hit = served from Redis;
    //   full = jwt.verify ran + cache populated.
    //   Dashboard: L1/(L1+L2+full) ratio shows cache effectiveness.
    //   Call site: src/modules/auth/auth.service.ts (verifyAccessTokenCached)
    counter(
      'jwt_cache_hits_total',
      'JWT verification cache outcomes by tier (l1=in-process LRU | l2=Redis | full=jwt.verify ran) — A04-002',
    ),

    // jwt_cache_miss_total: fires when neither L1 nor L2 has the entry.
    //   (Currently recorded implicitly via tier=full; this counter is reserved
    //    for a future path where miss vs full-verify are distinguished.)
    //   Call site: reserved for src/modules/auth/auth.service.ts
    counter(
      'jwt_cache_miss_total',
      'JWT verification cache misses (neither L1 nor L2 had a valid entry) — A04-002',
    ),

    // jwt_invalidate_publish_failed_total: fires when redisService.publish('jwt_invalidate', ...)
    // throws inside the logout flow. Non-zero rate means logout is not propagating to
    // other ECS tasks; their L1/L2 caches will serve revoked tokens until TTL expires.
    //   Alert: any hit in 5m window → page oncall (token revocation gap)
    //   Call site: src/modules/auth/auth.service.ts (logout)
    counter(
      'jwt_invalidate_publish_failed_total',
      'Failures publishing jwt_invalidate Pub/Sub message on logout — non-zero means cross-task cache invalidation is broken — A04-002',
    ),

    // auth_blacklist_bypass_detected_total: auto-revert signal for P5-C.
    // Fires when a token is served from cache and the blacklist lookup is
    // skipped (FF_JWT_CACHE_SKIP_BLACKLIST=ON). Any non-zero rate in production
    // without a Bloom filter backend is a security incident.
    //   Call site: reserved for future Bloom-filter path in auth.service.ts
    counter(
      'auth_blacklist_bypass_detected_total',
      'Cache-served JWT requests where blacklist check was skipped (FF_JWT_CACHE_SKIP_BLACKLIST) — used by P5-C auto-revert — A04-002',
    ),
    // === A11-001 P6-T19: Vehicle cache sync failure observability ===
    // Fires from the VehicleTransitionOutbox drain worker when onVehicleTransition
    // throws for a specific cache sink.
    //   Labels: source = 'availability' | 'fleet'
    //   Call site: src/shared/services/vehicle-transition-outbox.service.ts
    counter(
      'vehicle_cache_sync_failures_total',
      'Vehicle cache sync failures by source (availability | fleet) — A11-001 P6-T19',
    ),

    // === P7-T09 (A05-007 / Part B P7-F): FCM egress rate-limit counter ===
    // Fires from fcmService._consumeEgressTokens() when a sendToUsersMulticast
    // batch is rejected by the in-process 8K/s token bucket.
    // Sustained non-zero rate means multi-broadcast concurrency needs to be reduced
    // or the token-bucket ceiling raised (after confirming Google quota was raised).
    //   Labels: batch_size = '>500' | '<count>'
    //   Call site: src/shared/services/fcm.service.ts (_consumeEgressTokens)
    //   Alert: any non-zero rate in production → investigate burst pattern
    counter(
      'fcm_egress_rate_limited_total',
      'FCM sends rejected by the 8K/s in-process egress token bucket (P7-T01/A05-002)',
    ),

    // === W-2a B-6 (OAD-5 / V5 contract audit): Hold finalize CAS-miss + flex revoke observability ===
    // hold_finalize_cas_miss_total: fires when the confirmed-hold finalize CAS detects
    // the ledger row advanced to a terminal state (expired/released/confirmed) between
    // TX start and finalize. Routed through the route layer as a 404 + HOLD_NOT_FOUND
    // envelope (see truck-hold.routes.ts:876 + events.asyncapi.yaml HoldNotFound).
    //   Labels: reason = 'expired' | 'released' | 'confirmed' | 'unknown'
    //   Call site: src/modules/truck-hold/confirmed-hold.service.ts (CAS-miss branch)
    counter(
      'hold_finalize_cas_miss_total',
      'Confirmed-hold finalize CAS-miss outcomes (ledger row advanced terminal between TX start and finalize) — labels: reason',
    ),
    // flex_revoke_sent_total: fires per flex_hold_superseded fan-out emission to the
    // losing drivers (winner is excluded — see B-7 winner-exclusion test).
    //   Labels: outcome = 'success' | 'fail' | 'adapter_down'
    //   Call site: flex-hold revoke fan-out path
    counter(
      'flex_revoke_sent_total',
      'Flex-hold supersede revoke fan-out emissions to losing drivers — labels: outcome',
    ),

    // === W-3 D1-6 (D-01): Customer progress mirror emit observability ===
    // Pre-registered so the customerProgressMirror helper's incrementCounter
    // call doesn't trip the warn-and-return branch. Fires once per mirror
    // emission of driver_accepted / driver_declined / trucks_remaining_update
    // events relayed from the transporter pipeline to the customer room.
    //   Labels: event = 'driver_accepted' | 'driver_declined' | 'trucks_remaining_update'
    counter(
      'customer_progress_mirror_emit_total',
      'Customer progress mirror events emitted by helper (D-01 / W-3 D1-6) — labels: event',
    ),

    // === W-4 E2-2: Replica lag fallback observability ===
    // Fires when a read-from-replica path falls back to the primary because
    // replica lag exceeded the safety threshold (or the replica probe failed).
    //   Labels: caller = <call-site identifier>
    //   Pair with replica_lag_seconds gauge for full picture.
    counter(
      'replica_lag_fallback_total',
      'Replica reads that fell back to the primary due to lag/probe failure (W-4 E2-2) — labels: caller',
    ),

    // === W-5 D3-3: FCM upgrade campaign observability ===
    // fcm_upgrade_required_skip_total: fires when an upgrade-required notify is
    // skipped before send (e.g., user already on min build, throttled, opted-out).
    //   Labels: reason = <closed enum, e.g. below_min_version|throttled|opt_out|missing_token>
    counter(
      'fcm_upgrade_required_skip_total',
      'FCM upgrade-required notifications skipped before send (W-5 D3-3) — labels: reason=below_min_version|throttled|opt_out|missing_token'
    ),
    // fcm_upgrade_notified_total: fires per upgrade notify outcome.
    //   Labels: result = success|failed
    counter(
      'fcm_upgrade_notified_total',
      'FCM upgrade-required notifications dispatched (W-5 D3-3) — labels: result=success|failed'
    ),
    // fcm_upgrade_notify_failure_total: fires on upgrade notify failure with a
    // closed-enum failure category for dashboard breakdown (sourced from
    // normalizeFirebaseErrorCode — see W-5 D3.T3).
    //   Labels: category = <closed enum, e.g. token_invalid|quota|network|unknown>
    counter(
      'fcm_upgrade_notify_failure_total',
      'FCM upgrade-required notify failures by category (W-5 D3-3) — labels: category=token_invalid|quota|network|unknown'
    ),

    // === W-5 E3-6: Audit retention observability ===
    // audit_retention_pruned_total: cumulative count of audit rows pruned by
    // the retention sweep (no labels — single counter).
    counter(
      'audit_retention_pruned_total',
      'Audit log rows pruned by the retention sweep (W-5 E3-6)'
    ),
    // audit_retention_failed_total: fires when the retention sweep itself
    // throws or otherwise fails to complete a cycle.
    counter(
      'audit_retention_failed_total',
      'Audit retention sweep failures (W-5 E3-6)'
    ),

    // === A01-009: Tiered rate limiting ===
    // rate_limit_denied_total: fires when a user request is denied by the
    // per-tier rate limiter (basic/pro/enterprise). Gated by FF_RATE_LIMIT_TIERED.
    //   Call site: rate-limit middleware deny path (A01-009)
    counter(
      'rate_limit_denied_total',
      'Requests denied by tiered rate limiter, by user tier (A01-009)'
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

    // === P7-T09 (A13-003 / A05-007): FCM connection-reuse ratio gauge ===
    // Sampled every 60s from FCM HTTP Agent. Tracks keepAlive reuse effectiveness.
    // fcm_send_connection_reuse_ratio = (successSends - newConnections) / successSends.
    // At maxSockets:400, steady-state should be >0.95 during peak broadcast windows.
    //   Call site: fcm.service.ts health check (future observability export)
    //   Alert: < 0.8 sustained 5 min → HTTP keep-alive not working as expected
    gauge(
      'fcm_send_connection_reuse_ratio',
      'Estimated HTTP connection reuse ratio for FCM sends (P7-T09 / A13-003)',
    ),

    // === P7-T09 (A05-007): FCM multicast failure ratio gauge ===
    // Derived metric: fcm_send_failure_total{error_code=multicast_chunk} /
    //   (fcm_send_success_total{tokens_bucket=multicast} + fcm_send_failure_total)
    // Observability-only — computed and SET by a 60s cron in the FCM service
    // (future work). When > 0.02 sustained 3 min → auto-revert
    //   FF_FCM_MULTICAST_ENABLED=false per Part B P7-F playbook.
    //   Dashboard: weelo-fcm-multicast-health
    gauge(
      'fcm_multicast_failure_ratio',
      'Fraction of FCM multicast sends that failed per 60s window (P7-T09 / A05-007) — auto-revert gate',
    ),

    // === Phase 1 (F-series) — observability baseline ===
    gauge(
      'circuit_breaker_state_gauge',
      'Per-circuit state (1=OPEN, 0=CLOSED/HALF_OPEN) — labels: name, source=redis|local (F15.3)',
    ),
    gauge(
      'stream_depth',
      'Socket.IO Redis Streams adapter per-stream depth (F14.5) — labels: stream',
    ),

    // === A03-009 / A12-011: Notification-outbox size gauge ===
    // Sampled every 30s via GET outbox:size (O(1) counter key maintained by
    // bufferNotification INCR / drainOutbox DECR). Avoids SCAN on large sets.
    gauge( /* @observability-only */
      'outbox_size',
      'Current estimated size of the notification outbox (O(1) Redis counter — sampled every 30s) — A03-009',
    ),

    // === Fix #6 (index-20-validated.md §1.3): DLQ broadcasts depth gauges ===
    // Sampled every 30s by `dlq-broadcasts-depth-emitter.ts` via LLEN; mirrored
    // to CloudWatch via PutMetricData so `weelo-dlq-broadcasts-depth-warn` can
    // gate the FF_BATCH_QUEUE_DEPTH_GUARD flag flip pre-flight.
    gauge( /* @observability-only */
      'dlq_broadcasts_depth',
      'LLEN dlq:broadcasts (active retry list, sampled 30s) — Fix #6 backpressure SLO',
    ),
    gauge( /* @observability-only */
      'dlq_broadcasts_permanent_depth',
      'LLEN dlq:broadcasts:permanent (dead-letter list, sampled 30s) — Fix #6 / #19c attempt-exhausted entries',
    ),
    gauge( /* @observability-only */
      'dlq_broadcasts_inflight_depth',
      'LLEN dlq:broadcasts:inflight (drainer in-flight, sampled 30s) — Fix #19c sequencing pre-flight',
    ),
    // === A04-006: Socket.IO adapter per-partition stream depth gauges ===
    // Sampled every 5s via XLEN. One gauge per partition (16 partitions default).
    // stream naming: socket.io-{i} (matches @socket.io/redis-streams-adapter default streamName)
    //   Call site: src/shared/services/socket.service.ts (setupRedisAdapter XLEN sweep P3-T19)
    gauge(
      'socket_stream_partition_depth_0',
      'A04-006: Socket.IO Redis Streams adapter stream depth for partition 0 (socket.io-0)',
    ),
    gauge(
      'socket_stream_partition_depth_1',
      'A04-006: Socket.IO Redis Streams adapter stream depth for partition 1 (socket.io-1)',
    ),
    gauge(
      'socket_stream_partition_depth_2',
      'A04-006: Socket.IO Redis Streams adapter stream depth for partition 2 (socket.io-2)',
    ),
    gauge(
      'socket_stream_partition_depth_3',
      'A04-006: Socket.IO Redis Streams adapter stream depth for partition 3 (socket.io-3)',
    ),
    gauge(
      'socket_stream_partition_depth_4',
      'A04-006: Socket.IO Redis Streams adapter stream depth for partition 4 (socket.io-4)',
    ),
    gauge(
      'socket_stream_partition_depth_5',
      'A04-006: Socket.IO Redis Streams adapter stream depth for partition 5 (socket.io-5)',
    ),
    gauge(
      'socket_stream_partition_depth_6',
      'A04-006: Socket.IO Redis Streams adapter stream depth for partition 6 (socket.io-6)',
    ),
    gauge(
      'socket_stream_partition_depth_7',
      'A04-006: Socket.IO Redis Streams adapter stream depth for partition 7 (socket.io-7)',
    ),
    gauge(
      'socket_stream_partition_depth_8',
      'A04-006: Socket.IO Redis Streams adapter stream depth for partition 8 (socket.io-8)',
    ),
    gauge(
      'socket_stream_partition_depth_9',
      'A04-006: Socket.IO Redis Streams adapter stream depth for partition 9 (socket.io-9)',
    ),
    gauge(
      'socket_stream_partition_depth_10',
      'A04-006: Socket.IO Redis Streams adapter stream depth for partition 10 (socket.io-10)',
    ),
    gauge(
      'socket_stream_partition_depth_11',
      'A04-006: Socket.IO Redis Streams adapter stream depth for partition 11 (socket.io-11)',
    ),
    gauge(
      'socket_stream_partition_depth_12',
      'A04-006: Socket.IO Redis Streams adapter stream depth for partition 12 (socket.io-12)',
    ),
    gauge(
      'socket_stream_partition_depth_13',
      'A04-006: Socket.IO Redis Streams adapter stream depth for partition 13 (socket.io-13)',
    ),
    gauge(
      'socket_stream_partition_depth_14',
      'A04-006: Socket.IO Redis Streams adapter stream depth for partition 14 (socket.io-14)',
    ),
    gauge(
      'socket_stream_partition_depth_15',
      'A04-006: Socket.IO Redis Streams adapter stream depth for partition 15 (socket.io-15)',
    ),
    gauge(
      'socket_stream_partition_depth_16',
      'A13-007: Socket.IO Redis Streams adapter stream depth for partition 16 (socket.io-16)',
    ),
    gauge(
      'socket_stream_partition_depth_17',
      'A13-007: Socket.IO Redis Streams adapter stream depth for partition 17 (socket.io-17)',
    ),
    gauge(
      'socket_stream_partition_depth_18',
      'A13-007: Socket.IO Redis Streams adapter stream depth for partition 18 (socket.io-18)',
    ),
    gauge(
      'socket_stream_partition_depth_19',
      'A13-007: Socket.IO Redis Streams adapter stream depth for partition 19 (socket.io-19)',
    ),
    gauge(
      'socket_stream_partition_depth_20',
      'A13-007: Socket.IO Redis Streams adapter stream depth for partition 20 (socket.io-20)',
    ),
    gauge(
      'socket_stream_partition_depth_21',
      'A13-007: Socket.IO Redis Streams adapter stream depth for partition 21 (socket.io-21)',
    ),
    gauge(
      'socket_stream_partition_depth_22',
      'A13-007: Socket.IO Redis Streams adapter stream depth for partition 22 (socket.io-22)',
    ),
    gauge(
      'socket_stream_partition_depth_23',
      'A13-007: Socket.IO Redis Streams adapter stream depth for partition 23 (socket.io-23)',
    ),
    gauge(
      'socket_stream_partition_depth_24',
      'A13-007: Socket.IO Redis Streams adapter stream depth for partition 24 (socket.io-24)',
    ),
    gauge(
      'socket_stream_partition_depth_25',
      'A13-007: Socket.IO Redis Streams adapter stream depth for partition 25 (socket.io-25)',
    ),
    gauge(
      'socket_stream_partition_depth_26',
      'A13-007: Socket.IO Redis Streams adapter stream depth for partition 26 (socket.io-26)',
    ),
    gauge(
      'socket_stream_partition_depth_27',
      'A13-007: Socket.IO Redis Streams adapter stream depth for partition 27 (socket.io-27)',
    ),
    gauge(
      'socket_stream_partition_depth_28',
      'A13-007: Socket.IO Redis Streams adapter stream depth for partition 28 (socket.io-28)',
    ),
    gauge(
      'socket_stream_partition_depth_29',
      'A13-007: Socket.IO Redis Streams adapter stream depth for partition 29 (socket.io-29)',
    ),
    gauge(
      'socket_stream_partition_depth_30',
      'A13-007: Socket.IO Redis Streams adapter stream depth for partition 30 (socket.io-30)',
    ),
    gauge(
      'socket_stream_partition_depth_31',
      'A13-007: Socket.IO Redis Streams adapter stream depth for partition 31 (socket.io-31)',
    ),

    // === A13-007: Per-partition stream oldest-entry age gauges (Stage-1: 32 partitions) ===
    // Sampled by the XLEN sweep (or a future XINFO STREAM call) every 5s.
    // Value = age in seconds of the oldest entry still in the stream (XINFO first-entry
    // delivery-time compared to now). Lets SRE detect retention lag independently of
    // stream depth — a deep stream with a young oldest-entry is healthy; a shallow
    // stream with an old oldest-entry may indicate a stalled consumer.
    //   stream naming: socket.io-{i} (matches @socket.io/redis-streams-adapter default)
    //   Alert threshold: > 300s (5 min) indicates consumer is not keeping up.
    //   Call site: src/shared/services/socket.service.ts (setupRedisAdapter XLEN sweep)
    gauge(
      'stream_oldest_entry_age_seconds_0',
      'A13-007: Age in seconds of oldest entry in socket.io-0 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_1',
      'A13-007: Age in seconds of oldest entry in socket.io-1 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_2',
      'A13-007: Age in seconds of oldest entry in socket.io-2 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_3',
      'A13-007: Age in seconds of oldest entry in socket.io-3 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_4',
      'A13-007: Age in seconds of oldest entry in socket.io-4 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_5',
      'A13-007: Age in seconds of oldest entry in socket.io-5 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_6',
      'A13-007: Age in seconds of oldest entry in socket.io-6 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_7',
      'A13-007: Age in seconds of oldest entry in socket.io-7 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_8',
      'A13-007: Age in seconds of oldest entry in socket.io-8 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_9',
      'A13-007: Age in seconds of oldest entry in socket.io-9 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_10',
      'A13-007: Age in seconds of oldest entry in socket.io-10 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_11',
      'A13-007: Age in seconds of oldest entry in socket.io-11 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_12',
      'A13-007: Age in seconds of oldest entry in socket.io-12 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_13',
      'A13-007: Age in seconds of oldest entry in socket.io-13 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_14',
      'A13-007: Age in seconds of oldest entry in socket.io-14 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_15',
      'A13-007: Age in seconds of oldest entry in socket.io-15 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_16',
      'A13-007: Age in seconds of oldest entry in socket.io-16 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_17',
      'A13-007: Age in seconds of oldest entry in socket.io-17 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_18',
      'A13-007: Age in seconds of oldest entry in socket.io-18 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_19',
      'A13-007: Age in seconds of oldest entry in socket.io-19 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_20',
      'A13-007: Age in seconds of oldest entry in socket.io-20 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_21',
      'A13-007: Age in seconds of oldest entry in socket.io-21 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_22',
      'A13-007: Age in seconds of oldest entry in socket.io-22 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_23',
      'A13-007: Age in seconds of oldest entry in socket.io-23 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_24',
      'A13-007: Age in seconds of oldest entry in socket.io-24 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_25',
      'A13-007: Age in seconds of oldest entry in socket.io-25 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_26',
      'A13-007: Age in seconds of oldest entry in socket.io-26 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_27',
      'A13-007: Age in seconds of oldest entry in socket.io-27 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_28',
      'A13-007: Age in seconds of oldest entry in socket.io-28 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_29',
      'A13-007: Age in seconds of oldest entry in socket.io-29 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_30',
      'A13-007: Age in seconds of oldest entry in socket.io-30 Redis stream (retention lag indicator)',
    ),
    gauge(
      'stream_oldest_entry_age_seconds_31',
      'A13-007: Age in seconds of oldest entry in socket.io-31 Redis stream (retention lag indicator)',
    ),

    // === A04-006: Stream partition depth skew ratio gauge ===
    // Computed as stddev/mean across 16 partitions. > 0.5 indicates hot-shard routing imbalance.
    //   Call site: src/shared/services/socket.service.ts (setupRedisAdapter XLEN sweep P3-T20)
    gauge(
      'socket_stream_partition_depth_skew_ratio',
      'A04-006: Skew ratio (stddev/mean) of Socket.IO stream partition depths — > 0.5 indicates hot-shard imbalance',
    ),

    // === A04-001 / P5-T38+T39: HTTP upgrade rate-limit gauges ===
    // (counters are auto-registered by incrementCounter; gauge must be pre-registered)
    // See also: counter defs for socket_upgrade_rate_limited_total, rate_limiter_open_fail_total
    //   registered below in registerDefaultCounters.

    // === A04-001 / P5-T21: HTTP upgrade handshakes in progress ===
    // Incremented when the upgrade handler accepts a request (after token-bucket
    // allow); decremented on socket 'connect' or error. Lets ops observe the
    // in-flight WS handshake count independently of fully-connected sockets.
    // Alert: sustained > SOCKET_MAX_GLOBAL_CONNECTIONS (default 10 000).
    //   Call site: src/server.ts (httpServer.on('upgrade') handler)
    gauge(
      'handshakes_in_progress',
      'A04-001: HTTP WebSocket upgrade handshakes in-flight (post token-bucket, pre socket.io connect/error)',
    ),

    // === A04-002 / A15-010 (P5-08/P5-09): Socket auth latency p99 gauge ===
    // Updated every 30s by a sampler in auth.middleware.ts (future) OR by ops
    // tooling that aggregates the http_request_duration_ms histogram filtered to
    // auth paths. Value = p99 milliseconds for socket upgrade auth verification.
    //   Alert: > 15ms for 2 consecutive minutes → auto-revert FF_JWT_CACHE_ENABLED
    //   Call site: reserved for auth latency sampling (P5-09 phase)
    gauge(
      'socket_auth_latency_p99_ms',
      'P99 socket authentication latency in ms — alert threshold 15ms triggers JWT cache auto-revert (A04-002 canary gate)',
    ),

    // === W-4 E2-2: Replica lag observability ===
    // Sampled by the replica-lag probe (pg_stat_replication / SELECT
    // EXTRACT(EPOCH FROM now()-pg_last_xact_replay_timestamp())). Read paths
    // gate on this gauge before serving from the replica; sustained > threshold
    // triggers replica_lag_fallback_total bumps and primary-read fallback.
    //   Alert: > 5s sustained 1m → investigate replica health
    gauge(
      'replica_lag_seconds',
      'Current PostgreSQL replica lag in seconds (W-4 E2-2) — read-path fallback gate',
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

    // A13-011 (P3-T28) — confirmed-hold fanout loop wall-clock duration.
    // Buckets cover the expected range from a single-driver fanout (< 5ms) up
    // to a 10-truck fanout under p99 socket + FCM latency (< 2.5s).  Outliers
    // above 5s signal a stalled await inside the loop that needs investigation.
    //   Call site: src/modules/truck-hold/confirmed-hold.service.ts
    //   (after the per-assignment fanout loop, before outbox mark-dispatched)
    hist( /* @observability-only */
      'confirmed_hold_fanout_duration_ms',
      'Wall-clock duration of the confirmed-hold post-commit per-driver fanout loop in milliseconds',
      [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
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

    // === A05-019 (P1-T46): FCM boot dry-run latency ===
    // Observed after the boot dry-run send completes (success or expected
    // invalid-token response). Measures how long Firebase OAuth minting +
    // network round-trip takes at process start. Useful for boot-time SLO.
    //   Call site: src/shared/services/fcm.service.ts (_observeDryRunLatency)
    hist(
      'fcm_boot_dry_run_latency_ms',
      'FCM boot dry-run round-trip latency in milliseconds (credential pipeline validation at startup)',
      [50, 100, 250, 500, 1000, 2500, 5000, 10000],
    ),

    // === A03-009 / A12-011: Notification-outbox per-entry drain latency ===
    // Observed per entry in drainOutbox (Date.now() delta around queuePushNotification).
    //   Labels: outbox = 'notification'
    hist( /* @observability-only */
      'outbox_drain_latency_ms',
      'Per-entry drain latency in the notification outbox from dequeue to queuePushNotification resolution — A03-009',
      [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    ),
    // === A04-006: Socket.IO adapter XADD latency histogram ===
    // Observed per XADD call via the InstrumentedRedisClient Proxy wrapper on the adapter client.
    // Lets SRE see per-stream XADD p50/p99 and correlate with stream depth skew.
    //   Call site: src/shared/services/socket.service.ts (wrapRedisClientForAdapter P3-T18)
    hist( /* @observability-only */
      'socket_adapter_xadd_ms',
      'A04-006: Socket.IO Redis Streams adapter XADD latency in milliseconds (per-call, via InstrumentedRedisClient proxy)',
      [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
    ),

    // === A12-010 / A13-012: dispatch_ack render latency histogram ===
    // Observed when the ZSET lookup for dispatchedAt succeeds (> 0).
    // Measures driver overlay render-to-ack latency in ms.
    //   Call site: src/shared/services/socket.service.ts (dispatch_ack handler P3-T25)
    hist(
      'driver_overlay_ack_latency_ms',
      'A12-010/A13-012: Time from dispatch send (dispatchedAt ZSET) to driver dispatch_ack renderedAt in milliseconds',
      [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
    ),

    // === W-2a B-6 (OAD-5 / V5 contract audit): Flex revoke fan-out latency ===
    // Observed per flex_hold_superseded emission. Buckets in seconds because the
    // tail of this loop (network adapter retries) can stretch to several seconds.
    //   Call site: flex-hold revoke fan-out path (paired with flex_revoke_sent_total)
    hist(
      'flex_revoke_latency_seconds',
      'W-2a B-6: Per-emission latency of the flex_hold_superseded revoke fan-out in seconds',
      [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    ),
  ];

  for (const def of defs) {
    histograms.set(def.name, def);
  }
}
