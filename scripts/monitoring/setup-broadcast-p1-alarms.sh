#!/usr/bin/env bash
# Weelo Phase 1 — broadcast-baseline alarms.
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

echo "[T1.7] Phase 1 broadcast-baseline alarms configured in ${AWS_REGION}, namespace=${CW_NAMESPACE}."
echo "[T1.7] Apply dashboard:"
echo "       aws cloudwatch put-dashboard \\"
echo "         --dashboard-name weelo-broadcast-baseline-p1 \\"
echo "         --dashboard-body file://scripts/monitoring/broadcast-baseline-p1-dashboard.json \\"
echo "         --region ${AWS_REGION}"
