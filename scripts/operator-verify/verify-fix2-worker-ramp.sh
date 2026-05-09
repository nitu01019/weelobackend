#!/usr/bin/env bash
# =============================================================================
# verify-fix2-worker-ramp.sh
# -----------------------------------------------------------------------------
# Operator pre-flight verification for Fix #2 (worker ramp 1 → 16) post-deploy.
#
# Source: /Users/nitishbhardwaj/Downloads/index-20-validated.md §1.2 + HEAD d97b5907
#         (`src/shared/database/prisma.service.ts:295-305` URL guard,
#          `.env.production:65-66` worker counts, RDS sizing per Step 4 Option A)
#
# What this verifies (post-deploy, against LIVE infra):
#   1. ECS task-def `REDIS_QUEUE_WORKERS` env == 16  (per §1.2 Step 5)
#   2. RDS instance class is db.r6g.large or db.r6g.xlarge  (per §1.2 Step 2)
#   3. Postgres `max_connections` >= 1500  (per §1.2 Step 2 expected output)
#   4. CloudWatch p99 of `pool_wait_seconds` last 30min <= 50ms (= 0.05s)
#      (per §1.2 Step 5 SLO gate)
#
# Required env vars (operator sets these — no secrets in script):
#   ECS_CLUSTER             - ECS cluster name (e.g. weelo-prod)
#   ECS_SERVICE             - ECS service name (e.g. weelo-backend)
#   PROD_PSQL_DATABASE_URL  - psql-compatible DSN (read-only role recommended)
#
# Optional env vars:
#   AWS_REGION              - default: ap-south-1
#   ECS_TASK_DEFINITION     - default: weelobackendtask
#   RDS_DB_INSTANCE_ID      - default: (first instance returned by describe-db-instances)
#   METRICS_NAMESPACE       - default: Weelo/Backend
#   POOL_WAIT_P99_THRESHOLD - default: 0.05  (seconds; 50ms)
#
# Exit code: 0 if ALL checks pass; 1 if ANY check fails.
# =============================================================================

set -euo pipefail

# ---- ANSI colors --------------------------------------------------------------
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
BLUE=$'\033[0;34m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

pass()   { printf "%s[PASS]%s %s\n"   "$GREEN"  "$RESET" "$1"; }
fail()   { printf "%s[FAIL]%s %s\n"   "$RED"    "$RESET" "$1"; FAILED=$((FAILED + 1)); }
info()   { printf "%s[INFO]%s %s\n"   "$BLUE"   "$RESET" "$1"; }
warn()   { printf "%s[WARN]%s %s\n"   "$YELLOW" "$RESET" "$1"; }
header() { printf "\n%s%s== %s ==%s\n" "$BOLD"  "$BLUE" "$1" "$RESET"; }

FAILED=0

# ---- Env precondition checks --------------------------------------------------
require_env() {
  local var_name="$1"
  if [[ -z "${!var_name:-}" ]]; then
    fail "Required env var ${var_name} is not set"
  fi
}

header "Fix #2 verify — worker-ramp post-deploy gate (HEAD d97b5907)"

require_env ECS_CLUSTER
require_env ECS_SERVICE
require_env PROD_PSQL_DATABASE_URL

if [[ "$FAILED" -gt 0 ]]; then
  printf "\n%s[FAIL]%s Required env vars missing — aborting before queries\n" "$RED" "$RESET"
  exit 1
fi

AWS_REGION="${AWS_REGION:-ap-south-1}"
ECS_TASK_DEFINITION="${ECS_TASK_DEFINITION:-weelobackendtask}"
METRICS_NAMESPACE="${METRICS_NAMESPACE:-Weelo/Backend}"
POOL_WAIT_P99_THRESHOLD="${POOL_WAIT_P99_THRESHOLD:-0.05}"

info "Region:           ${AWS_REGION}"
info "ECS cluster:      ${ECS_CLUSTER}"
info "ECS service:      ${ECS_SERVICE}"
info "Task def family:  ${ECS_TASK_DEFINITION}"
info "Namespace:        ${METRICS_NAMESPACE}"

# ---- Check 1: ECS task-def env REDIS_QUEUE_WORKERS == 16 ----------------------
header "Check 1/4 — ECS task-def REDIS_QUEUE_WORKERS == 16"

WORKER_VALUE="$(
  aws ecs describe-task-definition \
    --task-definition "${ECS_TASK_DEFINITION}" \
    --region "${AWS_REGION}" \
    --query 'taskDefinition.containerDefinitions[0].environment[?name==`REDIS_QUEUE_WORKERS`].value | [0]' \
    --output text 2>/dev/null || echo "ERROR"
)"

if [[ "$WORKER_VALUE" == "16" ]]; then
  pass "REDIS_QUEUE_WORKERS=16 in live task-def (${ECS_TASK_DEFINITION})"
elif [[ "$WORKER_VALUE" == "ERROR" || -z "$WORKER_VALUE" || "$WORKER_VALUE" == "None" ]]; then
  fail "Could not read REDIS_QUEUE_WORKERS from task-def — aws ecs describe-task-definition failed or env var missing"
else
  fail "REDIS_QUEUE_WORKERS=${WORKER_VALUE} (expected 16) — ramp incomplete or rolled back"
fi

# ---- Check 2: RDS instance class --------------------------------------------
header "Check 2/4 — RDS instance class is db.r6g.large or db.r6g.xlarge"

if [[ -n "${RDS_DB_INSTANCE_ID:-}" ]]; then
  RDS_QUERY="DBInstances[?DBInstanceIdentifier=='${RDS_DB_INSTANCE_ID}'].DBInstanceClass | [0]"
else
  RDS_QUERY="DBInstances[0].DBInstanceClass"
fi

RDS_CLASS="$(
  aws rds describe-db-instances \
    --region "${AWS_REGION}" \
    --query "${RDS_QUERY}" \
    --output text 2>/dev/null || echo "ERROR"
)"

case "$RDS_CLASS" in
  db.r6g.large|db.r6g.xlarge)
    pass "RDS instance class = ${RDS_CLASS}"
    ;;
  ERROR|""|None)
    fail "Could not read RDS instance class — aws rds describe-db-instances failed"
    ;;
  *)
    fail "RDS instance class = ${RDS_CLASS} (expected db.r6g.large or db.r6g.xlarge per §1.2 Step 2/4)"
    ;;
esac

# ---- Check 3: max_connections >= 1500 ----------------------------------------
header "Check 3/4 — Postgres max_connections >= 1500"

MAX_CONN_RAW="$(
  psql "${PROD_PSQL_DATABASE_URL}" -tAc "SHOW max_connections;" 2>/dev/null || echo "ERROR"
)"
MAX_CONN="$(echo "$MAX_CONN_RAW" | tr -d '[:space:]')"

if [[ "$MAX_CONN" == "ERROR" || -z "$MAX_CONN" ]]; then
  fail "psql SHOW max_connections failed — connection issue or auth"
elif ! [[ "$MAX_CONN" =~ ^[0-9]+$ ]]; then
  fail "max_connections returned non-numeric value: '${MAX_CONN}'"
elif [[ "$MAX_CONN" -ge 1500 ]]; then
  pass "max_connections = ${MAX_CONN} (>= 1500)"
else
  fail "max_connections = ${MAX_CONN} (expected >= 1500 per §1.2 Step 2)"
fi

# ---- Check 4: pool_wait_seconds p99 last 30min ≤ threshold -------------------
header "Check 4/4 — pool_wait_seconds p99 (last 30min) <= ${POOL_WAIT_P99_THRESHOLD}s"

END_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Subtract 30 minutes — portable for both GNU date and BSD date (macOS).
if date -u -d "30 minutes ago" +%Y-%m-%dT%H:%M:%SZ >/dev/null 2>&1; then
  START_TIME="$(date -u -d "30 minutes ago" +%Y-%m-%dT%H:%M:%SZ)"
else
  START_TIME="$(date -u -v -30M +%Y-%m-%dT%H:%M:%SZ)"
fi

P99_RAW="$(
  aws cloudwatch get-metric-statistics \
    --namespace "${METRICS_NAMESPACE}" \
    --metric-name pool_wait_seconds \
    --start-time "${START_TIME}" \
    --end-time "${END_TIME}" \
    --period 300 \
    --extended-statistics p99 \
    --region "${AWS_REGION}" \
    --query 'Datapoints[].ExtendedStatistics.p99 | sort(@) | [-1]' \
    --output text 2>/dev/null || echo "ERROR"
)"

if [[ "$P99_RAW" == "ERROR" ]]; then
  fail "CloudWatch get-metric-statistics failed — IAM perms or namespace mismatch (namespace=${METRICS_NAMESPACE})"
elif [[ "$P99_RAW" == "None" || -z "$P99_RAW" ]]; then
  fail "No pool_wait_seconds datapoints in last 30min — metric may not be shipping (check Prom→CW pipeline)"
else
  CMP="$(awk -v p99="$P99_RAW" -v thr="$POOL_WAIT_P99_THRESHOLD" 'BEGIN { print (p99 + 0 <= thr + 0) ? "ok" : "over" }')"
  if [[ "$CMP" == "ok" ]]; then
    pass "pool_wait_seconds p99 = ${P99_RAW}s (<= ${POOL_WAIT_P99_THRESHOLD}s)"
  else
    fail "pool_wait_seconds p99 = ${P99_RAW}s (over ${POOL_WAIT_P99_THRESHOLD}s SLO; deploy load-shedding before scaling RPS)"
  fi
fi

# ---- Summary -----------------------------------------------------------------
header "Summary"
if [[ "$FAILED" -eq 0 ]]; then
  printf "%s[ALL PASS]%s Fix #2 worker-ramp verification: 4/4 checks passed\n" "$GREEN" "$RESET"
  exit 0
else
  printf "%s[FAIL]%s Fix #2 worker-ramp verification: %d check(s) failed — DO NOT proceed past current ramp step\n" "$RED" "$RESET" "$FAILED"
  exit 1
fi
