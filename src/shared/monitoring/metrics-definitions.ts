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

    // Tracking initialization retry (Issue #46)
    counter('tracking.init_retry_total', 'Total tracking initialization retry attempts'),
    counter('tracking.init_failure_total', 'Total tracking initialization failures after all retries'),
    counter('tracking.init_success_total', 'Total successful tracking initializations'),

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
  ];

  for (const def of defs) {
    histograms.set(def.name, def);
  }
}
