#!/usr/bin/env bash
# =============================================================================
# verify-fix6-depth-guard.sh
# -----------------------------------------------------------------------------
# Operator pre-flight verification for Fix #6 (batch queue depth guard
# `FF_BATCH_QUEUE_DEPTH_GUARD=true`) before flipping the flag.
#
# Source: /Users/nitishbhardwaj/Downloads/index-20-validated.md §2.1.1 + HEAD d97b5907
#         (`src/server.ts:1084-1107` drainer registration log line,
#          `scripts/replay-broadcast-dlq.ts:38` DRAINER_LOCK_KEY='dlq:drainer:lock'
#          → real Redis key 'lock:dlq:drainer:lock' via acquireLock prefix)
#
# Pre-flight order MATTERS — admit-and-DLQ is *only correct* if the leader-
# elected drainer is actually running. Fail any of these → DO NOT flip flag.
#
# What this verifies (LIVE infra):
#   1. ECS task-def env `FF_BATCH_QUEUE_DEPTH_GUARD=true`  (post-flip gate)
#   2. Boot logs contain "[DLQ] broadcast drainer registered" in last 60min
#   3. Redis leader lock `lock:dlq:drainer:lock` is currently held (non-nil)
#   4. LLEN dlq:broadcasts < 100 (well below 5000 lTrim cap — drainer healthy)
#   5. All 4 weelo-dlq-* CloudWatch alarms are in OK state
#
# Required env vars (operator sets these — no secrets in script):
#   ECS_CLUSTER             - ECS cluster name
#   ECS_SERVICE             - ECS service name
#   PROD_REDIS_HOST         - Redis host (TLS rediss:// is fine via REDISCLI_AUTH)
#
# Optional env vars:
#   AWS_REGION              - default: ap-south-1
#   ECS_TASK_DEFINITION     - default: weelobackendtask
#   LOG_GROUP               - default: weelobackendtask
#   PROD_REDIS_PORT         - default: 6379
#   REDISCLI_AUTH           - Redis password (if AUTH required); read by redis-cli natively
#   PROD_REDIS_TLS          - set to '1' to use redis-cli --tls
#   DLQ_LLEN_MAX            - default: 100 (block-flip threshold)
#   DLQ_ALARM_PREFIX        - default: weelo-dlq-
#   EXPECTED_DLQ_ALARM_COUNT - default: 4
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

require_env() {
  local var_name="$1"
  if [[ -z "${!var_name:-}" ]]; then
    fail "Required env var ${var_name} is not set"
  fi
}

header "Fix #6 verify — depth-guard pre-flip gate (HEAD d97b5907)"

require_env ECS_CLUSTER
require_env ECS_SERVICE
require_env PROD_REDIS_HOST

if [[ "$FAILED" -gt 0 ]]; then
  printf "\n%s[FAIL]%s Required env vars missing — aborting before queries\n" "$RED" "$RESET"
  exit 1
fi

AWS_REGION="${AWS_REGION:-ap-south-1}"
ECS_TASK_DEFINITION="${ECS_TASK_DEFINITION:-weelobackendtask}"
LOG_GROUP="${LOG_GROUP:-weelobackendtask}"
PROD_REDIS_PORT="${PROD_REDIS_PORT:-6379}"
DLQ_LLEN_MAX="${DLQ_LLEN_MAX:-100}"
DLQ_ALARM_PREFIX="${DLQ_ALARM_PREFIX:-weelo-dlq-}"
EXPECTED_DLQ_ALARM_COUNT="${EXPECTED_DLQ_ALARM_COUNT:-4}"

# Build redis-cli command prefix
REDIS_CLI_ARGS=(-h "${PROD_REDIS_HOST}" -p "${PROD_REDIS_PORT}")
if [[ "${PROD_REDIS_TLS:-0}" == "1" ]]; then
  REDIS_CLI_ARGS+=(--tls)
fi

info "Region:           ${AWS_REGION}"
info "Task def family:  ${ECS_TASK_DEFINITION}"
info "Log group:        ${LOG_GROUP}"
info "Redis host:       ${PROD_REDIS_HOST}:${PROD_REDIS_PORT} (tls=${PROD_REDIS_TLS:-0})"
info "Block-flip if LLEN dlq:broadcasts >= ${DLQ_LLEN_MAX}"

# ---- Check 1: FF_BATCH_QUEUE_DEPTH_GUARD task-def state (dual-mode) ----------
# This script supports both pre-flip and post-flip verification.
#   - Pre-flip:  flag is unset OR 'false' → PASS (ready to flip)
#   - Post-flip: flag is 'true'           → PASS (flip succeeded)
# Use VERIFY_MODE=postflip env to enforce strict 'true'.
header "Check 1/5 — task-def env FF_BATCH_QUEUE_DEPTH_GUARD state"

VERIFY_MODE="${VERIFY_MODE:-preflip}"

GUARD_VALUE="$(
  aws ecs describe-task-definition \
    --task-definition "${ECS_TASK_DEFINITION}" \
    --region "${AWS_REGION}" \
    --query 'taskDefinition.containerDefinitions[0].environment[?name==`FF_BATCH_QUEUE_DEPTH_GUARD`].value | [0]' \
    --output text 2>/dev/null || echo "ERROR"
)"

if [[ "$GUARD_VALUE" == "ERROR" ]]; then
  fail "Could not read task-def env — aws ecs describe-task-definition failed"
elif [[ "$VERIFY_MODE" == "postflip" ]]; then
  if [[ "$GUARD_VALUE" == "true" ]]; then
    pass "FF_BATCH_QUEUE_DEPTH_GUARD=true (post-flip state confirmed)"
  else
    fail "VERIFY_MODE=postflip but FF_BATCH_QUEUE_DEPTH_GUARD=${GUARD_VALUE:-<unset>} (expected 'true')"
  fi
else
  case "$GUARD_VALUE" in
    true)
      info "FF_BATCH_QUEUE_DEPTH_GUARD=true (already flipped — pre-flight gates 2-5 still safe to re-verify)"
      pass "Flag readable"
      ;;
    ""|None|false)
      pass "FF_BATCH_QUEUE_DEPTH_GUARD=${GUARD_VALUE:-<unset>} (pre-flip state — ready to flip if other checks pass)"
      ;;
    *)
      fail "FF_BATCH_QUEUE_DEPTH_GUARD='${GUARD_VALUE}' (expected 'true', 'false', or unset)"
      ;;
  esac
fi

# ---- Check 2: drainer-registered log line in last 60 minutes -----------------
header "Check 2/5 — \"[DLQ] broadcast drainer registered\" in last 60min logs"

# CloudWatch start-time is in milliseconds since epoch
START_MS="$(( $(date +%s) - 3600 ))000"

DRAINER_LOG_HITS="$(
  aws logs filter-log-events \
    --log-group-name "${LOG_GROUP}" \
    --filter-pattern '"[DLQ] broadcast drainer registered"' \
    --start-time "${START_MS}" \
    --region "${AWS_REGION}" \
    --query 'events[].message' \
    --output text 2>/dev/null \
    | wc -l \
    | tr -d '[:space:]' \
    || echo 0
)"

if [[ -z "$DRAINER_LOG_HITS" ]]; then
  DRAINER_LOG_HITS=0
fi

if [[ "$DRAINER_LOG_HITS" -ge 1 ]]; then
  pass "Drainer registered log seen on ${DRAINER_LOG_HITS} pod(s) in last 60min"
else
  fail "No '[DLQ] broadcast drainer registered' log in last 60min — drainer NOT running (check FF_DLQ_DRAINER_ENABLED!=false)"
fi

# ---- Check 3: leader lock 'lock:dlq:drainer:lock' is currently held ----------
# Note: scripts/replay-broadcast-dlq.ts:38 calls acquireLock('dlq:drainer:lock'…)
# which prepends 'lock:' → the live Redis key is 'lock:dlq:drainer:lock'.
header "Check 3/5 — Redis lock 'lock:dlq:drainer:lock' is held"

LOCK_HOLDER="$(
  redis-cli "${REDIS_CLI_ARGS[@]}" GET 'lock:dlq:drainer:lock' 2>/dev/null || echo "REDIS_ERROR"
)"

if [[ "$LOCK_HOLDER" == "REDIS_ERROR" ]]; then
  fail "redis-cli GET failed — host=${PROD_REDIS_HOST}:${PROD_REDIS_PORT} (auth/TLS/network)"
elif [[ -z "$LOCK_HOLDER" ]]; then
  fail "lock:dlq:drainer:lock is NIL — no pod has elected leader; drainer is NOT actively draining"
else
  LOCK_TTL="$(redis-cli "${REDIS_CLI_ARGS[@]}" PTTL 'lock:dlq:drainer:lock' 2>/dev/null || echo "0")"
  pass "Leader lock held by '${LOCK_HOLDER}' (TTL=${LOCK_TTL}ms)"
fi

# ---- Check 4: LLEN dlq:broadcasts < threshold --------------------------------
header "Check 4/5 — LLEN dlq:broadcasts < ${DLQ_LLEN_MAX}"

DLQ_LEN="$(
  redis-cli "${REDIS_CLI_ARGS[@]}" LLEN 'dlq:broadcasts' 2>/dev/null || echo "REDIS_ERROR"
)"

if [[ "$DLQ_LEN" == "REDIS_ERROR" ]]; then
  fail "redis-cli LLEN failed for dlq:broadcasts"
elif ! [[ "$DLQ_LEN" =~ ^[0-9]+$ ]]; then
  fail "LLEN returned non-numeric: '${DLQ_LEN}'"
elif [[ "$DLQ_LEN" -lt "$DLQ_LLEN_MAX" ]]; then
  pass "LLEN dlq:broadcasts = ${DLQ_LEN} (< ${DLQ_LLEN_MAX})"
else
  fail "LLEN dlq:broadcasts = ${DLQ_LEN} (>= ${DLQ_LLEN_MAX} block-flip threshold; drainer overwhelmed — DO NOT flip guard flag)"
fi

# ---- Check 5: All 4 weelo-dlq-* alarms in OK state ---------------------------
header "Check 5/5 — All ${DLQ_ALARM_PREFIX}* alarms in OK state (expected ${EXPECTED_DLQ_ALARM_COUNT})"

# Query both MetricAlarms AND CompositeAlarms — Vega's cloudwatch-dlq-alarms.md
# adds a composite (`weelo-dlq-broadcasts-saturation-and-failing`); without
# CompositeAlarms in the query, count would be off by 1.
ALARM_JSON="$(
  aws cloudwatch describe-alarms \
    --alarm-name-prefix "${DLQ_ALARM_PREFIX}" \
    --region "${AWS_REGION}" \
    --query "[MetricAlarms[].[AlarmName,StateValue], CompositeAlarms[].[AlarmName,StateValue]] | [] | []" \
    --output text 2>/dev/null || echo "ERROR"
)"
# Reformat: aws returns flat fields per row; group into [name, state] pairs
ALARM_JSON="$(printf '%s' "${ALARM_JSON}" | awk 'NF==2 { print $0 } NF==1 { if (prev) { printf "%s\t%s\n", prev, $0; prev="" } else { prev=$0 } }')"

if [[ "$ALARM_JSON" == "ERROR" ]]; then
  fail "aws cloudwatch describe-alarms failed for prefix=${DLQ_ALARM_PREFIX}"
elif [[ -z "$ALARM_JSON" ]]; then
  fail "No alarms found with prefix '${DLQ_ALARM_PREFIX}' (expected ${EXPECTED_DLQ_ALARM_COUNT}). Provision via runbook."
else
  ALARM_TOTAL="$(printf '%s\n' "$ALARM_JSON" | wc -l | tr -d '[:space:]')"
  ALARM_NOT_OK="$(printf '%s\n' "$ALARM_JSON" | awk '$2 != "OK" { print }')"

  if [[ "$ALARM_TOTAL" -lt "$EXPECTED_DLQ_ALARM_COUNT" ]]; then
    fail "Found ${ALARM_TOTAL} ${DLQ_ALARM_PREFIX}* alarms (expected ${EXPECTED_DLQ_ALARM_COUNT}) — provision missing alarms"
    if [[ -n "$ALARM_NOT_OK" ]]; then
      printf "%s[FAIL]%s Non-OK alarms:\n%s\n" "$RED" "$RESET" "$ALARM_NOT_OK"
    fi
  elif [[ -z "$ALARM_NOT_OK" ]]; then
    pass "All ${ALARM_TOTAL} ${DLQ_ALARM_PREFIX}* alarms in OK state"
  else
    fail "${DLQ_ALARM_PREFIX}* alarms not all OK:"
    printf '%s\n' "$ALARM_NOT_OK"
  fi
fi

# ---- Summary -----------------------------------------------------------------
header "Summary"
if [[ "$FAILED" -eq 0 ]]; then
  printf "%s[ALL PASS]%s Fix #6 depth-guard verification: 5/5 checks passed — safe to flip FF_BATCH_QUEUE_DEPTH_GUARD=true\n" "$GREEN" "$RESET"
  exit 0
else
  printf "%s[FAIL]%s Fix #6 depth-guard verification: %d check(s) failed — DO NOT flip guard flag\n" "$RED" "$RESET" "$FAILED"
  exit 1
fi
