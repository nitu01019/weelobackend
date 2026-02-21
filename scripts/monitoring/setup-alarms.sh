#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:=ap-south-1}"
: "${ECS_CLUSTER:?ECS_CLUSTER is required}"
: "${ECS_SERVICE:?ECS_SERVICE is required}"
: "${ALARM_SNS_TOPIC_ARN:?ALARM_SNS_TOPIC_ARN is required}"

ALB_SUFFIX="${ALB_SUFFIX:-}"
TARGET_GROUP_SUFFIX="${TARGET_GROUP_SUFFIX:-}"
DASHBOARD_NAME="${DASHBOARD_NAME:-weelo-backend-phase8}"

put_ecs_alarm() {
  local name="$1"
  local metric="$2"
  local threshold="$3"

  aws cloudwatch put-metric-alarm \
    --region "${AWS_REGION}" \
    --alarm-name "${name}" \
    --namespace AWS/ECS \
    --metric-name "${metric}" \
    --statistic Average \
    --period 60 \
    --evaluation-periods 3 \
    --threshold "${threshold}" \
    --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching \
    --alarm-actions "${ALARM_SNS_TOPIC_ARN}" \
    --dimensions Name=ClusterName,Value="${ECS_CLUSTER}" Name=ServiceName,Value="${ECS_SERVICE}"
}

put_ecs_alarm "weelo-phase8-ecs-cpu-high" "CPUUtilization" "80"
put_ecs_alarm "weelo-phase8-ecs-memory-high" "MemoryUtilization" "85"

if [[ -n "${ALB_SUFFIX}" && -n "${TARGET_GROUP_SUFFIX}" ]]; then
  aws cloudwatch put-metric-alarm \
    --region "${AWS_REGION}" \
    --alarm-name "weelo-phase8-alb-target-5xx" \
    --namespace AWS/ApplicationELB \
    --metric-name HTTPCode_Target_5XX_Count \
    --statistic Sum \
    --period 60 \
    --evaluation-periods 2 \
    --threshold 20 \
    --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching \
    --alarm-actions "${ALARM_SNS_TOPIC_ARN}" \
    --dimensions Name=LoadBalancer,Value="${ALB_SUFFIX}" Name=TargetGroup,Value="${TARGET_GROUP_SUFFIX}"

  aws cloudwatch put-metric-alarm \
    --region "${AWS_REGION}" \
    --alarm-name "weelo-phase8-alb-latency-p95" \
    --namespace AWS/ApplicationELB \
    --metric-name TargetResponseTime \
    --extended-statistic p95 \
    --period 60 \
    --evaluation-periods 3 \
    --threshold 1.2 \
    --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching \
    --alarm-actions "${ALARM_SNS_TOPIC_ARN}" \
    --dimensions Name=LoadBalancer,Value="${ALB_SUFFIX}" Name=TargetGroup,Value="${TARGET_GROUP_SUFFIX}"
fi

cat > /tmp/weelo-phase8-dashboard.json <<JSON
{
  "widgets": [
    {
      "type": "metric",
      "width": 12,
      "height": 6,
      "properties": {
        "title": "ECS CPU/Memory",
        "view": "timeSeries",
        "stacked": false,
        "metrics": [
          ["AWS/ECS", "CPUUtilization", "ClusterName", "${ECS_CLUSTER}", "ServiceName", "${ECS_SERVICE}"],
          ["AWS/ECS", "MemoryUtilization", "ClusterName", "${ECS_CLUSTER}", "ServiceName", "${ECS_SERVICE}"]
        ],
        "region": "${AWS_REGION}",
        "period": 60
      }
    }
  ]
}
JSON

aws cloudwatch put-dashboard \
  --region "${AWS_REGION}" \
  --dashboard-name "${DASHBOARD_NAME}" \
  --dashboard-body file:///tmp/weelo-phase8-dashboard.json

echo "CloudWatch alarms and dashboard configured"
