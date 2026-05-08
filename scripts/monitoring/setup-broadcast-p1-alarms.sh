#!/usr/bin/env bash
# OPERATOR: Source the same env the backend uses BEFORE running this script.
#   source .env.production && bash scripts/monitoring/setup-broadcast-p1-alarms.sh
# SOCKET_STREAM_PARTITIONS mismatch between this script and the running backend
# will create gauge gaps (missing alarms on shards 16-31). See VERIFICATION_INDEX H2.
# =============================================================================
# WEELO CLOUDWATCH ALARMS — PHASE 3 BROADCAST RELIABILITY
# =============================================================================
#
# Follows the style of scripts/monitoring/setup-alarms.sh (phase8).
# Apply BEFORE or AFTER put-dashboard; order independent.
#
# Env vars:
#   AWS_REGION             — default ap-south-1
#   ALARM_SNS_TOPIC_ARN    — P2/P3 pager topic (required)
#   ALARM_SNS_P3_TOPIC_ARN — optional; falls back to ALARM_SNS_TOPIC_ARN if unset (soft pagers)
#   CW_NAMESPACE           — default Weelo/Backend (must match the namespace used by the
#                            metric-filter / EMF pipeline that exports Prometheus counters to CW)
#
# Prereq: the director has created CloudWatch metric-filters for each app counter
# (or switched the backend to aws-embedded-metrics EMF) — see DASHBOARD-P1.md §"Metric-filter TODOs".
# Until then these alarms will sit in INSUFFICIENT_DATA, which is the intended safe default.
#
# -----------------------------------------------------------------------------
# ALARM REGISTRY (P3-T41 runbook header)
# Every alarm created by this script is listed here with metric source + SLO.
# -----------------------------------------------------------------------------
#
#  ALARM NAME                                    METRIC / EXPRESSION                              SLO RATIONALE
#  ------------------------------------------    -----------------------------------------------  -----------------------------------------------
#  weelo-p1-socket-adapter-down                  socket_emit_while_adapter_down_total > 0 / 2m    M18: cross-instance emits drop when adapter down
#  weelo-p1-eta-fallback-spike                   eta_ranking_fallback_total > 5/min / 3m          L3: Google Directions quota/timeout
#  weelo-p1-fleet-cache-corruption               fleet_cache_corruption_total > 10/hr             L7: JSON.stringify regression
#  weelo-p1-post-commit-cache-failure-*          post_commit_cache_failure_total > 20/min / 3m    L2: staleness risk after cache write fail
#  weelo-p1-circuit-breaker-open                 circuit_breaker_state_gauge >= 1 / 5m            F15.3: critical circuit OPEN
#  weelo-p1-dlq-pushed                           dlq_pushed_total > 0 / 5m                        F7.5: retry exhaustion, jobs on DLQ
#  weelo-p1-fleetcache-read-error                fleetcache_read_total{result=error} > 300/5m     F3.6: cache corruption / Redis outage
#  weelo-p1-pool-wait-p99                        pool_wait_seconds p99 > 0.5s / 5m               F14.5: Prisma pool saturation
#  weelo-p1-fcm-quota-burn                       fcm_quota_consumed_total > 900/s / 5m            F14.5: approaching Firebase 1000/s ceiling
#
#  --- P3 SLO / A12-001 + A13-011 alarms (P3-T29 through P3-T40) ---
#
#  weelo-p3-hold-request-rate-drop               METRIC_MATH: rate drop > 20% vs 1h ago           P3-T29: booking funnel health
#  weelo-p3-hold-conversion-low                  METRIC_MATH: confirmed/requested < 0.95 / 5m     P3-T30: hold→confirm conversion SLO
#  weelo-p3-assignment-emit-fail                 new_assignment_socket_emit_total{result=fail} > 0 / 2m  P3-T31: driver misses assignment
#  weelo-p3-driver-overlay-fail                  driver_overlay_rendered_total{result=fail} > 0/5m P3-T32: driver overlay not rendering
#  weelo-p3-fcm-error-rate                       METRIC_MATH: fcm_send_failure_total/fcm_send_success_total+failure > 1% / 5m  P3-T33: FCM delivery health
#  weelo-p3-socket-reconnect-surge               socket_connect_total > 5000 / 30s               P3-T34: reconnect storm
#  weelo-p3-fanout-p99                           confirmed_hold_fanout_duration_ms p99 > 600ms / 1m  P3-T35: fanout latency SLO
#  weelo-p3-outbox-drain-failed                  outbox_drained_total{outcome=failed} > 0 / 5m   P3-T36: outbox failure
#  weelo-p3-outbox-size-high                     outbox_size > 10000 / 5m                        P3-T37: outbox backlog
#  weelo-p3-stream-partition-depth-N (×16)       socket_stream_partition_depth_N gauge > 80000 / 30s  P3-T38: per-partition stream depth
#  weelo-p3-eventloop-lag                        nodejs_eventloop_lag_ms gauge (Maximum) > 50 / 2m   P3-T39: event loop saturation
#  weelo-p3-socket-xadd-p99                      socket_adapter_xadd_ms p99 > 500ms / 30s        P3-T40: Redis Streams XADD latency
#
#  --- Fix #6 / Fix #19c (index-20-validated.md §1.3 / §1.6) DLQ depth alarms ---
#
#  weelo-dlq-broadcasts-depth-warn               dlq_broadcasts_depth > 100 / 2m                 Fix #6: drainer falling behind, early warning
#  weelo-dlq-broadcasts-depth-crit               dlq_broadcasts_depth > 500 / 5m                 Fix #6: sustained backlog, scale drainer
#  weelo-dlq-broadcasts-depth-saturation         dlq_broadcasts_depth >= 4500 / 1m               Fix #6: block-flip gate (lTrim drop risk)
#  weelo-dlq-broadcasts-permanent-depth-warn     dlq_broadcasts_permanent_depth > 0 / 5m         Fix #19c: attempt-exhausted dead-letters
# -----------------------------------------------------------------------------

set -euo pipefail

: "${AWS_REGION:=ap-south-1}"
: "${ALARM_SNS_TOPIC_ARN:?ALARM_SNS_TOPIC_ARN is required}"
: "${CW_NAMESPACE:=Weelo/Backend}"

ALARM_SNS_P3_TOPIC_ARN="${ALARM_SNS_P3_TOPIC_ARN:-${ALARM_SNS_TOPIC_ARN}}"

# -----------------------------------------------------------------------------
# Helper: put a counter-rate alarm (Sum per period, treat missing = notBreaching).
# -----------------------------------------------------------------------------
put_counter_alarm() {
  local name="$1"
  local metric="$2"
  local threshold="$3"
  local period="$4"
  local evaluation_periods="$5"
  local sns_arn="$6"
  local description="$7"
  shift 7

  local dimensions_args=()
  if [[ $# -gt 0 ]]; then
    dimensions_args=(--dimensions "$@")
  fi

  aws cloudwatch put-metric-alarm \
    --region "${AWS_REGION}" \
    --alarm-name "${name}" \
    --alarm-description "${description}" \
    --namespace "${CW_NAMESPACE}" \
    --metric-name "${metric}" \
    --statistic Sum \
    --period "${period}" \
    --evaluation-periods "${evaluation_periods}" \
    --threshold "${threshold}" \
    --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching \
    --alarm-actions "${sns_arn}" \
    "${dimensions_args[@]}"
}

# -----------------------------------------------------------------------------
# Alarm 1 (P2) — Socket adapter emit-while-down.
# Any single emit while adapter is down during a rolling 2-minute window pages P2.
# Rationale: cross-instance broadcasts silently drop; customer app misses events.
#
# If T1.2 shipped scripts/monitoring/alarm-m18-adapter-down.json with a prebuilt
# descriptor, prefer that file (put-metric-alarm --cli-input-json file://...).
# -----------------------------------------------------------------------------
M18_ALARM_JSON="${M18_ALARM_JSON:-scripts/monitoring/alarm-m18-adapter-down.json}"
if [[ -f "${M18_ALARM_JSON}" ]]; then
  echo "[T1.7] Using T1.2-provided alarm descriptor: ${M18_ALARM_JSON}"
  aws cloudwatch put-metric-alarm \
    --region "${AWS_REGION}" \
    --cli-input-json "file://${M18_ALARM_JSON}"
else
  put_counter_alarm \
    "weelo-p1-socket-adapter-down" \
    "socket_emit_while_adapter_down_total" \
    "0" \
    "60" \
    "2" \
    "${ALARM_SNS_TOPIC_ARN}" \
    "[P2] M18 — socket.io broadcast attempted while redis adapter is down. Cross-instance emits are being dropped. Investigate redis adapter health."
fi

# -----------------------------------------------------------------------------
# Alarm 2 (P3) — ETA ranking fallback spike (>5 / minute over 3 min).
# Rationale: fallback path runs when Google Directions fails; sustained spike
# implies quota / network / key issue, degrades ranking quality.
# -----------------------------------------------------------------------------
put_counter_alarm \
  "weelo-p1-eta-fallback-spike" \
  "eta_ranking_fallback_total" \
  "5" \
  "60" \
  "3" \
  "${ALARM_SNS_P3_TOPIC_ARN}" \
  "[P3] L3 — ETA ranking fallback rate > 5/min sustained for 3m. Likely Google Directions quota/timeout issue. Ranking quality degraded."

# -----------------------------------------------------------------------------
# Alarm 3 (P3-soft) — Fleet cache corruption (>10 / hour).
# Rationale: known flake where Redis gets `[object Object]`. Soft pager so
# slow-burn corruption still surfaces.
# -----------------------------------------------------------------------------
put_counter_alarm \
  "weelo-p1-fleet-cache-corruption" \
  "fleet_cache_corruption_total" \
  "10" \
  "3600" \
  "1" \
  "${ALARM_SNS_P3_TOPIC_ARN}" \
  "[P3] L7 — fleet cache corruption > 10/hour. JSON.stringify regression likely. Check fleet-cache.service.ts writes."

# -----------------------------------------------------------------------------
# Alarm 4 (P3) — Post-commit cache failure on either cache label.
# We create ONE alarm per cache label (google_directions, idempotency) because
# CloudWatch does not support "OR across label values" on a single alarm.
# Threshold: >20 failures/min over 3 min.
# -----------------------------------------------------------------------------
for cache_label in google_directions idempotency; do
  put_counter_alarm \
    "weelo-p1-post-commit-cache-failure-${cache_label}" \
    "post_commit_cache_failure_total" \
    "20" \
    "60" \
    "3" \
    "${ALARM_SNS_P3_TOPIC_ARN}" \
    "[P3] L2 — post-commit cache failures (${cache_label}) > 20/min for 3m. DB commit succeeded but cache write failed → staleness risk." \
    "Name=cache,Value=${cache_label}"
done

# =============================================================================
# Phase 1 F-series — observability-baseline alarms (A1–A9, 2026-04-21).
# These cover the 16 new metrics registered in metrics-definitions.ts and
# observe the taps in circuit-breaker / DLQ / fleet-cache / pool / fcm code.
# Same INSUFFICIENT_DATA disclaimer applies until metric-filter / EMF pipeline
# exports them to the Weelo/Backend namespace.
# =============================================================================

# -----------------------------------------------------------------------------
# Helper: gauge alarm (Maximum per period — "is ANY member currently 1?").
# Used for circuit_breaker_state_gauge where 1 = OPEN and we must alert if any
# single breaker (redis/postgres/etc.) has been OPEN for the evaluation window.
# -----------------------------------------------------------------------------
put_gauge_max_alarm() {
  local name="$1"
  local metric="$2"
  local threshold="$3"
  local period="$4"
  local evaluation_periods="$5"
  local sns_arn="$6"
  local description="$7"

  aws cloudwatch put-metric-alarm \
    --region "${AWS_REGION}" \
    --alarm-name "${name}" \
    --alarm-description "${description}" \
    --namespace "${CW_NAMESPACE}" \
    --metric-name "${metric}" \
    --statistic Maximum \
    --period "${period}" \
    --evaluation-periods "${evaluation_periods}" \
    --threshold "${threshold}" \
    --comparison-operator GreaterThanOrEqualToThreshold \
    --treat-missing-data notBreaching \
    --alarm-actions "${sns_arn}"
}

# -----------------------------------------------------------------------------
# Helper: histogram p99 alarm (ExtendedStatistic p99, GreaterThanThreshold).
# Used for pool_wait_seconds where we care about long-tail pool saturation
# rather than the average wait.
# -----------------------------------------------------------------------------
put_histogram_p99_alarm() {
  local name="$1"
  local metric="$2"
  local threshold="$3"
  local period="$4"
  local evaluation_periods="$5"
  local sns_arn="$6"
  local description="$7"

  aws cloudwatch put-metric-alarm \
    --region "${AWS_REGION}" \
    --alarm-name "${name}" \
    --alarm-description "${description}" \
    --namespace "${CW_NAMESPACE}" \
    --metric-name "${metric}" \
    --extended-statistic p99 \
    --period "${period}" \
    --evaluation-periods "${evaluation_periods}" \
    --threshold "${threshold}" \
    --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching \
    --alarm-actions "${sns_arn}"
}

# -----------------------------------------------------------------------------
# Alarm 5 (P2) — F15.3 circuit-breaker OPEN for any critical dependency.
# threshold=1 → any gauge member reporting OPEN for 5m fires.
# Task should drain via /health/ready to stop taking traffic on this instance.
# -----------------------------------------------------------------------------
put_gauge_max_alarm \
  "weelo-p1-circuit-breaker-open" \
  "circuit_breaker_state_gauge" \
  "1" \
  "60" \
  "5" \
  "${ALARM_SNS_TOPIC_ARN}" \
  "[P2] F15.3 critical circuit OPEN for 5m — task should drain via /health/ready. Investigate upstream (redis/postgres/fcm) health."

# -----------------------------------------------------------------------------
# Alarm 6 (P2) — F7.5 DLQ push rate > 0 over 5m.
# Any job landing on the DLQ means retries have been exhausted — surface it.
# -----------------------------------------------------------------------------
put_counter_alarm \
  "weelo-p1-dlq-pushed" \
  "dlq_pushed_total" \
  "0" \
  "60" \
  "5" \
  "${ALARM_SNS_TOPIC_ARN}" \
  "[P2] F7.5 — dlq_pushed_total > 0 sustained for 5m. Jobs exhausting retries and landing on DLQ. Inspect DLQ payload + matching queue consumer."

# -----------------------------------------------------------------------------
# Alarm 7 (P3) — F3.6 fleet-cache read errors > 1/s over 5m (300/5m).
# result=error label isolates JSON.stringify corruption + Redis outages.
# -----------------------------------------------------------------------------
put_counter_alarm \
  "weelo-p1-fleetcache-read-error" \
  "fleetcache_read_total" \
  "300" \
  "60" \
  "5" \
  "${ALARM_SNS_P3_TOPIC_ARN}" \
  "[P3] F3.6 — fleetcache_read_total{result=error} > 1/s for 5m. Redis cache corruption or outage; expect DB fallback latency spikes." \
  "Name=result,Value=error"

# -----------------------------------------------------------------------------
# Alarm 8 (P2) — F14.5 Prisma pool_wait_seconds p99 > 0.5s over 5m.
# Long-tail pool saturation is the leading indicator for DB-bound stalls.
# -----------------------------------------------------------------------------
put_histogram_p99_alarm \
  "weelo-p1-pool-wait-p99" \
  "pool_wait_seconds" \
  "0.5" \
  "60" \
  "5" \
  "${ALARM_SNS_TOPIC_ARN}" \
  "[P2] F14.5 — pool_wait_seconds p99 > 0.5s for 5m. Prisma connection pool saturation; expect DB-bound stalls. Scale pool or inspect slow queries."

# -----------------------------------------------------------------------------
# Alarm 9 (P3-soft) — F14.5 FCM quota burn > 900/s over 5m (54000/5m).
# Firebase caps at 1000/s per project — warn before we get throttled.
# -----------------------------------------------------------------------------
put_counter_alarm \
  "weelo-p1-fcm-quota-burn" \
  "fcm_quota_consumed_total" \
  "270000" \
  "300" \
  "1" \
  "${ALARM_SNS_P3_TOPIC_ARN}" \
  "[P3] F14.5 — fcm_quota_consumed_total > 900/s for 5m (threshold=270000 per 5m period). Approaching Firebase 1000/s quota ceiling; throttling imminent."

# =============================================================================
# Phase 3 — SLO / A12-001 + A13-011 alarms (P3-T29 through P3-T40)
# These cover broadcast reliability, FCM delivery, socket health, and
# outbox/stream depth. Same INSUFFICIENT_DATA disclaimer applies until the
# metric-filter / EMF pipeline exports them into the Weelo/Backend namespace.
# =============================================================================

# ---------------------------------------------------------------------------
# Helper: metric-math alarm (two metrics, expression-based comparison).
# CloudWatch requires --metrics JSON for math expressions; we inline it here
# using a heredoc to avoid temporary files and keep the script portable.
# ---------------------------------------------------------------------------
put_metric_math_alarm() {
  local name="$1"
  local description="$2"
  local expression="$3"
  local threshold="$4"
  local period="$5"
  local evaluation_periods="$6"
  local sns_arn="$7"
  local metrics_json="$8"

  aws cloudwatch put-metric-alarm \
    --region "${AWS_REGION}" \
    --alarm-name "${name}" \
    --alarm-description "${description}" \
    --metrics "${metrics_json}" \
    --comparison-operator GreaterThanThreshold \
    --threshold "${threshold}" \
    --evaluation-periods "${evaluation_periods}" \
    --treat-missing-data notBreaching \
    --alarm-actions "${sns_arn}"
}

# -----------------------------------------------------------------------------
# P3-T29 — hold_request_total rate-drop > 20% over 5 min.
# Compares current 5m rate to the rate 1h ago. A 20% drop in incoming hold
# requests is a leading indicator of a booking funnel regression (app crash,
# bad deploy, or upstream outage).
# Expression: (m1 - m2) / (m2 + 1) < -0.2  →  expressed as m2 - m1 > 0.2 * m2
# We invert to use GreaterThanThreshold: (m2 - m1) / (m2 + 1) > 0.2
# threshold=0.2, evaluation_periods=1 (single 5m datapoint)
# -----------------------------------------------------------------------------
HOLD_RATE_DROP_METRICS='[
  {"Id":"m1","MetricStat":{"Metric":{"Namespace":"'"${CW_NAMESPACE}"'","MetricName":"hold_request_total"},"Period":300,"Stat":"Sum"},"Label":"current_5m","ReturnData":false},
  {"Id":"m2","MetricStat":{"Metric":{"Namespace":"'"${CW_NAMESPACE}"'","MetricName":"hold_request_total"},"Period":3600,"Stat":"Sum"},"Label":"prev_1h","ReturnData":false},
  {"Id":"e1","Expression":"(m2/12 - m1) / (m2/12 + 1)","Label":"rate_drop_fraction","ReturnData":true,"Period":300}
]'
put_metric_math_alarm \
  "weelo-p3-hold-request-rate-drop" \
  "[P3] A12-001/T29 — hold_request_total rate dropped > 20% vs 1h ago (5m window). Booking funnel regression: check app, gateway, or upstream. SLO: < 20% drop." \
  "(m2/12 - m1) / (m2/12 + 1)" \
  "0.2" \
  "300" \
  "1" \
  "${ALARM_SNS_P3_TOPIC_ARN}" \
  "${HOLD_RATE_DROP_METRICS}"

# -----------------------------------------------------------------------------
# P3-T30 — hold_confirmed_committed_total / hold_request_total < 0.95 / 5min.
# SLO: 95% of hold requests must proceed to confirmed commit. Drop below this
# threshold means captains are abandoning holds or the confirm path is broken.
# Expression: 1 - (m3 / (m4 + 1)) > 0.05  →  threshold = 0.05
# -----------------------------------------------------------------------------
HOLD_CONV_METRICS='[
  {"Id":"m3","MetricStat":{"Metric":{"Namespace":"'"${CW_NAMESPACE}"'","MetricName":"hold_confirmed_committed_total"},"Period":300,"Stat":"Sum"},"Label":"confirmed","ReturnData":false},
  {"Id":"m4","MetricStat":{"Metric":{"Namespace":"'"${CW_NAMESPACE}"'","MetricName":"hold_request_total"},"Period":300,"Stat":"Sum"},"Label":"requested","ReturnData":false},
  {"Id":"e2","Expression":"1 - (m3 / (m4 + 1))","Label":"confirm_drop_rate","ReturnData":true,"Period":300}
]'
put_metric_math_alarm \
  "weelo-p3-hold-conversion-low" \
  "[P3] A12-001/T30 — hold_confirmed_committed/hold_request_total < 0.95 over 5m. SLO breach: captains abandoning holds or confirm path broken. Investigate confirmed-hold.service.ts." \
  "1 - (m3 / (m4 + 1))" \
  "0.05" \
  "300" \
  "1" \
  "${ALARM_SNS_P3_TOPIC_ARN}" \
  "${HOLD_CONV_METRICS}"

# -----------------------------------------------------------------------------
# P3-T31 — new_assignment_socket_emit_total{result=fail} > 0 / 2min.
# Any socket emit failure for new assignments means a driver missed the
# assignment push — results in missed trips and manual dispatch overhead.
# 2-minute evaluation window (2 × 60s periods) to catch transient failures.
# -----------------------------------------------------------------------------
put_counter_alarm \
  "weelo-p3-assignment-emit-fail" \
  "new_assignment_socket_emit_total" \
  "0" \
  "60" \
  "2" \
  "${ALARM_SNS_TOPIC_ARN}" \
  "[P2] A13-011/T31 — new_assignment_socket_emit_total{result=fail} > 0 sustained 2m. Drivers missing assignment notifications. Investigate socket.service.ts emit path." \
  "Name=result,Value=fail"

# -----------------------------------------------------------------------------
# P3-T32 — driver_overlay_rendered_total{result=fail} > 0 / 5min.
# The driver overlay is the accept/decline screen for new assignments. Any
# render failure means the driver cannot respond to the assignment (silent loss).
# -----------------------------------------------------------------------------
put_counter_alarm \
  "weelo-p3-driver-overlay-fail" \
  "driver_overlay_rendered_total" \
  "0" \
  "60" \
  "5" \
  "${ALARM_SNS_P3_TOPIC_ARN}" \
  "[P3] A13-011/T32 — driver_overlay_rendered_total{result=fail} > 0 for 5m. Driver UI cannot render assignment overlay; silent loss. Investigate F9.9 render path." \
  "Name=result,Value=fail"

# -----------------------------------------------------------------------------
# P3-T33 — FCM delivery error rate > 1% / 5min.
# Derived from rate(fcm_send_failure_total[5m]) / rate(fcm_send_success+failure[5m]) > 0.01.
# Firebase errors at >1% indicate token churn, quota exhaustion, or credential issues.
# -----------------------------------------------------------------------------
FCM_ERR_RATE_METRICS='[
  {"Id":"m5","MetricStat":{"Metric":{"Namespace":"'"${CW_NAMESPACE}"'","MetricName":"fcm_send_failure_total"},"Period":300,"Stat":"Sum"},"Label":"fcm_errors","ReturnData":false},
  {"Id":"m6","MetricStat":{"Metric":{"Namespace":"'"${CW_NAMESPACE}"'","MetricName":"fcm_send_success_total"},"Period":300,"Stat":"Sum"},"Label":"fcm_success","ReturnData":false},
  {"Id":"e3","Expression":"m5 / (m5 + m6 + 1)","Label":"fcm_error_rate","ReturnData":true,"Period":300}
]'
put_metric_math_alarm \
  "weelo-p3-fcm-error-rate" \
  "[P3] A13-011/T33 — fcm_delivery_error_rate > 1% over 5m. FCM errors: token churn, quota, or credential issue. Check fcm.service.ts + Firebase console." \
  "m5 / (m5 + m6 + 1)" \
  "0.01" \
  "300" \
  "1" \
  "${ALARM_SNS_P3_TOPIC_ARN}" \
  "${FCM_ERR_RATE_METRICS}"

# -----------------------------------------------------------------------------
# P3-T34 — socket_reconnect_rate > 5000/s / 30s.
# rate(socket_connect_total[30s]) > 5000 indicates a reconnect storm (e.g. rolling
# deploy, Redis adapter restart, or client-side bug causing rapid reconnects).
# 30s period, 1 evaluation period to catch sudden spikes quickly.
# threshold=150000 (5000/s × 30s period)
# -----------------------------------------------------------------------------
put_counter_alarm \
  "weelo-p3-socket-reconnect-surge" \
  "socket_connect_total" \
  "150000" \
  "30" \
  "1" \
  "${ALARM_SNS_TOPIC_ARN}" \
  "[P2] A13-011/T34 — socket_connect_total > 5000/s (150000 per 30s). Reconnect storm detected: rolling deploy, Redis adapter restart, or client bug. Check ECS + socket.service.ts."

# -----------------------------------------------------------------------------
# P3-T35 — confirmed_hold_fanout_duration_ms p99 > 600ms / 1min.
# The fanout loop after confirmed-hold commit must complete < 600ms p99 so
# drivers receive assignment notifications before the 45s timer ticks.
# -----------------------------------------------------------------------------
put_histogram_p99_alarm \
  "weelo-p3-fanout-p99" \
  "confirmed_hold_fanout_duration_ms" \
  "600" \
  "60" \
  "1" \
  "${ALARM_SNS_TOPIC_ARN}" \
  "[P2] A13-011/T35 — confirmed_hold_fanout_duration_ms p99 > 600ms over 1m. Fanout latency SLO breach: drivers may not receive notifications before 45s timer. Investigate confirmed-hold.service.ts fanout loop."

# -----------------------------------------------------------------------------
# P3-T36 — outbox_drained_total{outcome=failed} > 0 / 5min.
# Any failed outbox drain means a durable notification was not delivered and
# could not be retried — the driver permanently misses the assignment push.
# -----------------------------------------------------------------------------
put_counter_alarm \
  "weelo-p3-outbox-drain-failed" \
  "outbox_drained_total" \
  "0" \
  "60" \
  "5" \
  "${ALARM_SNS_TOPIC_ARN}" \
  "[P2] A12-001/T36 — outbox_drained_total{outcome=failed} > 0 sustained 5m. Notification outbox drain failures: durable push permanently lost. Inspect outbox consumer + DLQ." \
  "Name=outcome,Value=failed"

# -----------------------------------------------------------------------------
# P3-T37 — outbox_size > 10_000.
# A growing outbox (>10k items) means the poller cannot keep up with production
# rate. Drivers will experience significant delay in receiving notifications.
# -----------------------------------------------------------------------------
put_gauge_max_alarm \
  "weelo-p3-outbox-size-high" \
  "outbox_size" \
  "10000" \
  "300" \
  "1" \
  "${ALARM_SNS_P3_TOPIC_ARN}" \
  "[P3] A12-001/T37 — outbox_size > 10000. Notification outbox backlog too large; poller cannot keep up. Scale poller or investigate consumer lag."

# -----------------------------------------------------------------------------
# P3-T38 — socket_stream_partition_depth_N > 80_000 / 30s on ANY partition.
# Redis Streams adapter uses 16 partitions (0-15). Each partition is tracked as
# an individual gauge (socket_stream_partition_depth_0 ... _15) sampled via XLEN.
# A depth > 80k means XREAD consumers are lagging, causing stale broadcast delivery.
# We create one alarm per gauge metric so CloudWatch can pinpoint the hot shard.
# -----------------------------------------------------------------------------
for i in $(seq 0 $((${SOCKET_STREAM_PARTITIONS:-32} - 1))); do
  put_gauge_max_alarm \
    "weelo-p3-stream-partition-depth-${i}" \
    "socket_stream_partition_depth_${i}" \
    "80000" \
    "30" \
    "1" \
    "${ALARM_SNS_TOPIC_ARN}" \
    "[P2] A12-001/T38 — socket_stream_partition_depth_${i} > 80000 over 30s. Redis Streams adapter consumer lagging on partition ${i}. Check XREAD group lag + pod count."
done

# -----------------------------------------------------------------------------
# P3-T39 — nodejs_eventloop_lag_ms > 50ms / 2min.
# Event loop lag above 50ms causes timer drift, socket timeouts, and delayed
# promise resolutions — leading indicator of CPU saturation or blocking I/O
# (e.g. large JSON serialisation, sync crypto, etc.).
# Metric: nodejs_eventloop_lag_ms gauge (Maximum statistic — catches any pod spikes).
# -----------------------------------------------------------------------------
put_gauge_max_alarm \
  "weelo-p3-eventloop-lag" \
  "nodejs_eventloop_lag_p99_ms" \
  "50" \
  "60" \
  "2" \
  "${ALARM_SNS_TOPIC_ARN}" \
  "[P2] A12-001/T39 — nodejs_eventloop_lag_p99_ms > 50ms (Maximum) over 2m. Node.js event loop saturation: blocking I/O or CPU-bound work. Investigate CPU metrics, GC traces, and sync operations."

# -----------------------------------------------------------------------------
# P3-T40 — socket_adapter_xadd_ms p99 > 500ms / 30s.
# The Redis Streams XADD call must complete < 500ms p99 for the socket adapter
# to deliver broadcasts within the SLO window. Sustained p99 > 500ms indicates
# Redis memory pressure or network latency to ElastiCache.
# -----------------------------------------------------------------------------
put_histogram_p99_alarm \
  "weelo-p3-socket-xadd-p99" \
  "socket_adapter_xadd_ms" \
  "500" \
  "30" \
  "1" \
  "${ALARM_SNS_TOPIC_ARN}" \
  "[P2] A13-011/T40 — socket_adapter_xadd_ms p99 > 500ms over 30s. Redis Streams XADD latency SLO breach: ElastiCache memory pressure or network latency. Check Redis metrics."

# -----------------------------------------------------------------------------
# M5 — socket_replay_truncated_total rate > 10/min / 5min (§8.4 addition).
# Counts reconnects where the 200-entry replay cap truncated the unacked queue.
# Sustained rate > 10/min means many drivers are returning from long offline
# windows with > 200 unacked events; clients must run sync-from-latest to
# reconcile. Aligned with M5 SLA severity (P3 SLO bucket).
# threshold=50 (10/min × 5m period); evaluation_periods=1 (single 5m datapoint).
# -----------------------------------------------------------------------------
put_counter_alarm \
  "weelo-p3-socket-replay-truncated" \
  "socket_replay_truncated_total" \
  "50" \
  "300" \
  "1" \
  "${ALARM_SNS_P3_TOPIC_ARN}" \
  "[P3] M5 — socket_replay_truncated_total rate > 10/min over 5m. Reconnect replay hit 200-entry cap; drivers with > 200 unacked events must run sync-from-latest. See VERIFICATION_INDEX M5."

# =============================================================================
# Fix #6 / Fix #19c (index-20-validated.md §1.3 / §1.6) — DLQ broadcasts depth.
# Sidecar `src/shared/services/dlq-broadcasts-depth-emitter.ts` samples LLEN
# every 30s and publishes via PutMetricData. Three escalating thresholds gate
# the FF_BATCH_QUEUE_DEPTH_GUARD flag flip:
#   - warn @ 100 / 2m  → early signal, drainer rate < admit rate
#   - crit @ 500 / 5m  → scale the drainer or block the flip
#   - sat  @ 4500 / 1m → lTrim drops oldest at 5000; HARD block-flip gate
#
# Metric source: in-process sidecar (NOT a metric-filter), so these alarms
# transition out of INSUFFICIENT_DATA within 60s of pod warm-up.
# =============================================================================

# -----------------------------------------------------------------------------
# Alarm — Fix #6 warn: dlq_broadcasts_depth > 100 sustained 2m.
# Drainer rate < admit rate; investigate before backlog accelerates.
# -----------------------------------------------------------------------------
put_gauge_max_alarm \
  "weelo-dlq-broadcasts-depth-warn" \
  "dlq_broadcasts_depth" \
  "100" \
  "60" \
  "2" \
  "${ALARM_SNS_P3_TOPIC_ARN}" \
  "[P3] Fix #6 — dlq_broadcasts_depth > 100 sustained 2m. DLQ drainer rate < admit rate. Check dlq_drained_total vs dlq_pushed_total; scale drainer before saturation."

# -----------------------------------------------------------------------------
# Alarm — Fix #6 crit: dlq_broadcasts_depth > 500 sustained 5m.
# Sustained backlog; will saturate at 5000 (lTrim cap) within minutes at peak.
# -----------------------------------------------------------------------------
put_gauge_max_alarm \
  "weelo-dlq-broadcasts-depth-crit" \
  "dlq_broadcasts_depth" \
  "500" \
  "60" \
  "5" \
  "${ALARM_SNS_TOPIC_ARN}" \
  "[P2] Fix #6 — dlq_broadcasts_depth > 500 sustained 5m. Sustained DLQ backlog; lTrim drop imminent at 5000. Scale drainer NOW or roll back FF_BATCH_QUEUE_DEPTH_GUARD."

# -----------------------------------------------------------------------------
# Alarm — Fix #6 saturation: dlq_broadcasts_depth >= 4500 over 60s.
# Within 10% of lTrim cap (DLQ_MAX_SIZE=5000, queue.service.ts:2433). At 500 RPS
# x 50 transporter fanout the DLQ saturates in ~250ms once drainer stalls →
# silent loss begins. HARD block-flip gate: do NOT flip FF_BATCH_QUEUE_DEPTH_GUARD
# while this alarm has fired in the last 24h.
# -----------------------------------------------------------------------------
put_gauge_max_alarm \
  "weelo-dlq-broadcasts-depth-saturation" \
  "dlq_broadcasts_depth" \
  "4500" \
  "60" \
  "1" \
  "${ALARM_SNS_TOPIC_ARN}" \
  "[P1] Fix #6 — dlq_broadcasts_depth >= 4500 over 60s. lTrim(0, 4999) about to drop oldest entries; silent broadcast loss imminent. Block-flip gate per index-20-validated.md §2.1.1 Pillar 4."

# -----------------------------------------------------------------------------
# Alarm — Fix #19c: dlq_broadcasts_permanent_depth > 0 over 5m.
# Drainer moved entries to permanent dead-letter (attempt >= MAX_REPLAY_ATTEMPTS).
# Each entry is a permanent broadcast loss; requires human triage.
# -----------------------------------------------------------------------------
put_gauge_max_alarm \
  "weelo-dlq-broadcasts-permanent-depth-warn" \
  "dlq_broadcasts_permanent_depth" \
  "0" \
  "60" \
  "5" \
  "${ALARM_SNS_TOPIC_ARN}" \
  "[P2] Fix #19c — dlq_broadcasts_permanent_depth > 0 over 5m. Attempt-exhausted broadcasts dead-lettered; permanent loss without human triage. LRANGE dlq:broadcasts:permanent for context."

echo "[T1.7+P3] Phase 1 + Phase 3 broadcast alarms configured in ${AWS_REGION}, namespace=${CW_NAMESPACE}."
echo "[T1.7+P3] Total alarm groups: 9 baseline + 12 P3 SLO + 16 partition-depth + 4 DLQ depth = 41 alarms."
echo "[T1.7] Apply dashboard:"
echo "       aws cloudwatch put-dashboard \\"
echo "         --dashboard-name weelo-broadcast-baseline-p1 \\"
echo "         --dashboard-body file://scripts/monitoring/broadcast-baseline-p1-dashboard.json \\"
echo "         --region ${AWS_REGION}"
