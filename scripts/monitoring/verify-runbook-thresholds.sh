#!/usr/bin/env bash
# verify-runbook-thresholds.sh
# Confirms all operator runbook prerequisites are met before the worker ramp.
# Exit 0 = all checks PASS. Exit 1 = one or more checks FAIL.
#
# Usage: bash scripts/monitoring/verify-runbook-thresholds.sh
# Set AWS_REGION, ECS_CLUSTER, ECS_SERVICE, RDS_INSTANCE_ID in env or edit below.

set -euo pipefail

REGION="${AWS_REGION:-ap-south-1}"
ECS_CLUSTER="${ECS_CLUSTER:-PLACEHOLDER-cluster}"
ECS_SERVICE="${ECS_SERVICE:-PLACEHOLDER-service}"
RDS_INSTANCE_ID="${RDS_INSTANCE_ID:-PLACEHOLDER-rds-instance}"
TASK_FAMILY="weelobackendtask"

PASS=0
FAIL=0
RESULTS=()

check() {
  local label="$1"
  local result="$2"  # "PASS" or "FAIL"
  local detail="$3"
  if [ "$result" = "PASS" ]; then
    RESULTS+=("  [PASS] $label: $detail")
    (( PASS++ )) || true
  else
    RESULTS+=("  [FAIL] $label: $detail")
    (( FAIL++ )) || true
  fi
}

echo "=== Weelo Runbook Prerequisite Verification ==="
echo "Region: $REGION | Cluster: $ECS_CLUSTER | Service: $ECS_SERVICE"
echo ""

# Check 1: RDS instance class
RDS_CLASS=$(aws rds describe-db-instances \
  --db-instance-identifier "$RDS_INSTANCE_ID" \
  --region "$REGION" \
  --query 'DBInstances[0].DBInstanceClass' \
  --output text 2>/dev/null || echo "ERROR")

if [ "$RDS_CLASS" = "db.r6g.xlarge" ]; then
  check "RDS instance class" "PASS" "$RDS_CLASS (max_connections=3201)"
elif [ "$RDS_CLASS" = "ERROR" ]; then
  check "RDS instance class" "FAIL" "Could not query RDS — check RDS_INSTANCE_ID and credentials"
else
  check "RDS instance class" "FAIL" "Got $RDS_CLASS, expected db.r6g.xlarge (rds-upgrade.md not complete)"
fi

# Check 2: DB_CONNECTION_LIMIT in ECS task-def
DB_LIMIT=$(aws ecs describe-task-definition \
  --task-definition "$TASK_FAMILY" \
  --region "$REGION" \
  --query 'taskDefinition.containerDefinitions[0].environment[?name==`DB_CONNECTION_LIMIT`].value' \
  --output text 2>/dev/null || echo "ERROR")

if [ "$DB_LIMIT" = "125" ]; then
  check "DB_CONNECTION_LIMIT in task-def" "PASS" "125"
elif [ "$DB_LIMIT" = "ERROR" ] || [ -z "$DB_LIMIT" ]; then
  check "DB_CONNECTION_LIMIT in task-def" "FAIL" "Not set or query failed (ecs-db-connection-limit.md not complete)"
else
  check "DB_CONNECTION_LIMIT in task-def" "FAIL" "Got $DB_LIMIT, expected 125"
fi

# Check 3: FF_BATCH_QUEUE_DEPTH_GUARD in ECS task-def
DEPTH_GUARD=$(aws ecs describe-task-definition \
  --task-definition "$TASK_FAMILY" \
  --region "$REGION" \
  --query 'taskDefinition.containerDefinitions[0].environment[?name==`FF_BATCH_QUEUE_DEPTH_GUARD`].value' \
  --output text 2>/dev/null || echo "ERROR")

if [ "$DEPTH_GUARD" = "true" ]; then
  check "FF_BATCH_QUEUE_DEPTH_GUARD in task-def" "PASS" "true"
elif [ "$DEPTH_GUARD" = "ERROR" ] || [ -z "$DEPTH_GUARD" ]; then
  check "FF_BATCH_QUEUE_DEPTH_GUARD in task-def" "FAIL" "Not set (ff-depth-guard-flip.md not complete)"
else
  check "FF_BATCH_QUEUE_DEPTH_GUARD in task-def" "FAIL" "Got $DEPTH_GUARD, expected true"
fi

# Check 4: depth-tier alarms exist in CloudWatch
ALARM_COUNT=$(aws cloudwatch describe-alarms \
  --alarm-name-prefix "weelo-dlq-broadcasts-depth" \
  --region "$REGION" \
  --query 'length(MetricAlarms)' \
  --output text 2>/dev/null || echo "0")

if [ "$ALARM_COUNT" -ge 3 ]; then
  check "Depth-tier CloudWatch alarms" "PASS" "$ALARM_COUNT alarms found (need ≥3 depth-tier alarms)"
else
  check "Depth-tier CloudWatch alarms" "FAIL" "Only $ALARM_COUNT found; run: bash scripts/monitoring/setup-broadcast-p1-alarms.sh"
fi

# Check 5: dlq_broadcasts_depth metric has recent datapoints (sidecar running)
END_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
START_TIME=$(date -u -v-5M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ)

DATAPOINTS=$(aws cloudwatch get-metric-statistics \
  --namespace "Weelo/Backend" \
  --metric-name "dlq_broadcasts_depth" \
  --start-time "$START_TIME" \
  --end-time "$END_TIME" \
  --period 60 \
  --statistics Average \
  --region "$REGION" \
  --query 'length(Datapoints)' \
  --output text 2>/dev/null || echo "0")

if [ "$DATAPOINTS" -gt 0 ]; then
  check "DLQ depth-emitter sidecar (CloudWatch datapoints)" "PASS" "$DATAPOINTS datapoints in last 5 min"
else
  check "DLQ depth-emitter sidecar (CloudWatch datapoints)" "FAIL" "No datapoints — sidecar not emitting (dlq-sidecar-verify.md)"
fi

# Check 6: weelo-dlq-broadcasts-depth-warn alarm is not INSUFFICIENT_DATA
ALARM_STATE=$(aws cloudwatch describe-alarms \
  --alarm-names "weelo-dlq-broadcasts-depth-warn" \
  --region "$REGION" \
  --query 'MetricAlarms[0].StateValue' \
  --output text 2>/dev/null || echo "NOT_FOUND")

if [ "$ALARM_STATE" = "OK" ] || [ "$ALARM_STATE" = "ALARM" ]; then
  check "weelo-dlq-broadcasts-depth-warn alarm state" "PASS" "$ALARM_STATE (not INSUFFICIENT_DATA)"
elif [ "$ALARM_STATE" = "NOT_FOUND" ] || [ "$ALARM_STATE" = "None" ]; then
  check "weelo-dlq-broadcasts-depth-warn alarm state" "FAIL" "Alarm not found — run setup-broadcast-p1-alarms.sh"
else
  check "weelo-dlq-broadcasts-depth-warn alarm state" "FAIL" "$ALARM_STATE — sidecar must emit before this resolves (dlq-sidecar-verify.md)"
fi

# Print results
echo ""
echo "--- Results ---"
for r in "${RESULTS[@]}"; do
  echo "$r"
done

echo ""
echo "--- Summary ---"
echo "PASS: $PASS / $((PASS + FAIL))"
echo "FAIL: $FAIL / $((PASS + FAIL))"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "VERDICT: FAIL — resolve all FAIL items before starting worker ramp"
  exit 1
else
  echo ""
  echo "VERDICT: PASS — all prerequisites met, safe to start worker-ramp-step1.md"
  exit 0
fi
