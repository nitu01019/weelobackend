#!/usr/bin/env bash
# =============================================================================
# Fix #1 — PART B — CloudWatch alarm + Application AutoScaling policies for
# the broadcast_queue_depth metric emitted by PART A (emf-bridge.ts or sidecar).
#
# Reuses the style/helpers of setup-broadcast-p1-alarms.sh:340-427.
#
# Usage:
#   ./setup-broadcast-queue-depth-alarm.sh             # apply for real
#   ./setup-broadcast-queue-depth-alarm.sh --dry-run   # print policy JSON
#
# Required env vars:
#   AWS_REGION                  default ap-south-1
#   CW_NAMESPACE                default Weelo/Backend
#   ECS_CLUSTER                 required (e.g. weelo-prod)
#   ECS_SERVICE                 required (e.g. weelo-backend)
#   ALARM_SNS_TOPIC_ARN         required (P2 pager)
#   BROADCAST_QUEUE_DEPTH_CAP   default 10000
#   ECS_MIN_CAPACITY            default 2
#   ECS_MAX_CAPACITY            default 20
#   DIWALI_PREWARM              optional (set to "true" to add scheduled action)
# =============================================================================
set -euo pipefail

: "${AWS_REGION:=ap-south-1}"
: "${CW_NAMESPACE:=Weelo/Backend}"
: "${ECS_CLUSTER:?required (e.g. weelo-prod)}"
: "${ECS_SERVICE:?required (e.g. weelo-backend)}"
: "${ALARM_SNS_TOPIC_ARN:?required (P2 pager)}"
: "${BROADCAST_QUEUE_DEPTH_CAP:=10000}"

DRY_RUN="${1:-}"
THRESHOLD_TARGET=$((BROADCAST_QUEUE_DEPTH_CAP * 60 / 100))  # 60% of cap
THRESHOLD_STEP=$((BROADCAST_QUEUE_DEPTH_CAP * 80 / 100))    # 80% of cap

RESOURCE_ID="service/${ECS_CLUSTER}/${ECS_SERVICE}"

# (1) Register scalable target (idempotent — overwrites by name).
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --resource-id "${RESOURCE_ID}" \
  --scalable-dimension ecs:service:DesiredCount \
  --min-capacity "${ECS_MIN_CAPACITY:-2}" \
  --max-capacity "${ECS_MAX_CAPACITY:-20}" \
  --region "${AWS_REGION}" >/dev/null

# (2) TargetTracking — track 60% of cap (fast path, ~60s reaction).
TT_POLICY=$(cat <<JSON
{
  "TargetValue": ${THRESHOLD_TARGET},
  "CustomizedMetricSpecification": {
    "MetricName": "broadcast_queue_depth",
    "Namespace": "${CW_NAMESPACE}",
    "Dimensions": [{"Name":"service","Value":"${ECS_SERVICE}"}],
    "Statistic": "Average",
    "Unit": "Count"
  },
  "ScaleOutCooldown": 60,
  "ScaleInCooldown": 300
}
JSON
)

if [ "${DRY_RUN}" = "--dry-run" ]; then
  echo "[DRY-RUN] TargetTracking policy JSON:"
  echo "${TT_POLICY}"
else
  aws application-autoscaling put-scaling-policy \
    --policy-name weelo-broadcast-queue-depth-target-tracking \
    --service-namespace ecs \
    --resource-id "${RESOURCE_ID}" \
    --scalable-dimension ecs:service:DesiredCount \
    --policy-type TargetTrackingScaling \
    --target-tracking-scaling-policy-configuration "${TT_POLICY}" \
    --region "${AWS_REGION}" >/dev/null
  echo "[OK] TargetTracking policy applied (target=${THRESHOLD_TARGET})"
fi

# (3) StepScaling — safety net at 80% of cap, +2 tasks per breach.
STEP_POLICY=$(cat <<JSON
{
  "AdjustmentType": "ChangeInCapacity",
  "Cooldown": 60,
  "MetricAggregationType": "Average",
  "StepAdjustments": [
    {"MetricIntervalLowerBound": 0, "MetricIntervalUpperBound": 2000, "ScalingAdjustment": 2},
    {"MetricIntervalLowerBound": 2000, "ScalingAdjustment": 4}
  ]
}
JSON
)

if [ "${DRY_RUN}" = "--dry-run" ]; then
  echo "[DRY-RUN] StepScaling policy JSON:"
  echo "${STEP_POLICY}"
else
  POLICY_ARN=$(aws application-autoscaling put-scaling-policy \
    --policy-name weelo-broadcast-queue-depth-step-scaling \
    --service-namespace ecs \
    --resource-id "${RESOURCE_ID}" \
    --scalable-dimension ecs:service:DesiredCount \
    --policy-type StepScaling \
    --step-scaling-policy-configuration "${STEP_POLICY}" \
    --region "${AWS_REGION}" \
    --query 'PolicyARN' --output text)
  aws cloudwatch put-metric-alarm \
    --alarm-name weelo-broadcast-queue-depth \
    --alarm-description "[P2] broadcast_queue_depth > ${THRESHOLD_STEP} (80% of cap) for 2 datapoints in 2 min. Triggers StepScaling +2 tasks. SLO: stay below cap to avoid 503+Retry-After (#7) load-shed." \
    --namespace "${CW_NAMESPACE}" \
    --metric-name broadcast_queue_depth \
    --statistic Average \
    --period 60 \
    --evaluation-periods 2 \
    --threshold "${THRESHOLD_STEP}" \
    --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching \
    --dimensions "Name=service,Value=${ECS_SERVICE}" \
    --alarm-actions "${POLICY_ARN}" "${ALARM_SNS_TOPIC_ARN}" \
    --region "${AWS_REGION}"
  echo "[OK] StepScaling alarm + policy applied (threshold=${THRESHOLD_STEP})"
fi

# (4) Scheduled scale-out — Diwali burst window 18:00-22:00 IST.
if [ "${DIWALI_PREWARM:-}" = "true" ]; then
  aws application-autoscaling put-scheduled-action \
    --service-namespace ecs \
    --resource-id "${RESOURCE_ID}" \
    --scalable-dimension ecs:service:DesiredCount \
    --scheduled-action-name weelo-broadcast-prewarm-evening-ist \
    --schedule "cron(30 12 * * ? *)" \
    --scalable-target-action "MinCapacity=$((${ECS_MIN_CAPACITY:-2} + 2)),MaxCapacity=${ECS_MAX_CAPACITY:-20}" \
    --region "${AWS_REGION}"
  echo "[OK] Diwali pre-warm scheduled (12:30 UTC = 18:00 IST)"
fi
