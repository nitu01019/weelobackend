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
#                            Prometheus→CloudWatch bridge — see DASHBOARD-P1.md §"Metric pipeline")
#   M18_ALARM_JSON         — optional; path to T1.2's prebuilt alarm descriptor (if present,
#                            takes precedence over the inline put_counter_alarm for M18)
#
# Prereq: the director has wired the Prometheus→CloudWatch bridge (recommended: EMF log emission
# from metrics.service.ts — see DASHBOARD-P1.md §"Metric pipeline: Prometheus → CloudWatch").
# Until then these alarms will sit in INSUFFICIENT_DATA, which is the intended safe default.

set -euo pipefail

: "${AWS_REGION:=ap-south-1}"
: "${ALARM_SNS_TOPIC_ARN:?ALARM_SNS_TOPIC_ARN is required}"
: "${CW_NAMESPACE:=Weelo/Backend}"

ALARM_SNS_P3_TOPIC_ARN="${ALARM_SNS_P3_TOPIC_ARN:-${ALARM_SNS_TOPIC_ARN}}"

# -----------------------------------------------------------------------------
# Helper: put a counter-rate alarm (Sum per period, treat missing = notBreaching).
# Any trailing args after the 7 positionals are passed through as --dimensions.
# The function splits into two codepaths rather than expanding an empty array,
# because macOS bash 3.2 + `set -u` fails on "${arr[@]}" when the array is empty.
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

  if [[ $# -gt 0 ]]; then
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
      --dimensions "$@"
  else
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
      --alarm-actions "${sns_arn}"
  fi
}

# -----------------------------------------------------------------------------
# Alarm 1 (P2) — Socket adapter emit-while-down.
# Semantics: Sum of emits per 120s window > 0 for 1 evaluation period. That is,
# a single emit-while-adapter-down in any rolling 2-minute window pages P2.
# Rationale: cross-instance broadcasts silently drop; customer app misses events.
#
# If T1.2 shipped scripts/monitoring/alarm-m18-adapter-down.json with a prebuilt
# descriptor, prefer that file (put-metric-alarm --cli-input-json file://...).
# Override path via M18_ALARM_JSON env var.
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
    "120" \
    "1" \
    "${ALARM_SNS_TOPIC_ARN}" \
    "[P2] M18 — socket.io broadcast attempted while redis adapter is down. Any single emit in a 2-minute window pages. Cross-instance emits are being dropped; investigate redis adapter health."
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

echo "[T1.7] Phase 1 broadcast-baseline alarms configured in ${AWS_REGION}, namespace=${CW_NAMESPACE}."
echo "[T1.7] Apply dashboard:"
echo "       aws cloudwatch put-dashboard \\"
echo "         --dashboard-name weelo-broadcast-baseline-p1 \\"
echo "         --dashboard-body file://scripts/monitoring/broadcast-baseline-p1-dashboard.json \\"
echo "         --region ${AWS_REGION}"
