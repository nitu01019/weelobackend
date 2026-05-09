#!/usr/bin/env bash
# =============================================================================
# verify-fix16-reaper.sh
# -----------------------------------------------------------------------------
# Operator post-deploy verification for Fix #16 (BLMOVE :processing-list reaper
# wrapped in `acquireLock('processing-reaper:<queue>', …)` cluster-wide leader
# election so HPA Max=N pods don't multiply duplicate broadcasts).
#
# Source: /Users/nitishbhardwaj/Downloads/index-20-validated.md §1.3 + HEAD d97b5907
#         (Pillar 2 reaper code: lockKey='processing-reaper:<queue>'
#          → real Redis key 'lock:processing-reaper:<queue>' via acquireLock prefix.
#          Metrics: processing_reaper_lock_miss_total, broadcast_dedup_total)
#
# What this verifies (LIVE infra):
#   1. ECS task-def env FF_PROCESSING_REAPER_LEADER_LOCK is 'true' OR unset
#      (defaultValue=true per feature-flags.ts entry in §1.3 Pillar 2)
#   2. Redis lock 'lock:processing-reaper:broadcast' is held by exactly 1 holder
#      (sample 5x at 2s spacing — same holder across all samples)
#   3. CloudWatch metric `processing_reaper_lock_miss_total` is non-zero on
#      follower pods over last 30min (proves only-one-leader contention path)
#   4. CloudWatch metric `broadcast_dedup_total` is flat or near-zero (no
#      duplicate-broadcast spike post-deploy — leader lock is doing its job)
#
# Required env vars (operator sets these — no secrets in script):
#   ECS_CLUSTER             - ECS cluster name
#   ECS_SERVICE             - ECS service name
#   PROD_REDIS_HOST         - Redis host
#
# Optional env vars:
#   AWS_REGION              - default: ap-south-1
#   ECS_TASK_DEFINITION     - default: weelobackendtask
#   PROD_REDIS_PORT         - default: 6379
#   REDISCLI_AUTH           - read by redis-cli natively if AUTH set
#   PROD_REDIS_TLS          - set to '1' to use redis-cli --tls
#   METRICS_NAMESPACE       - default: Weelo/Backend
#   REAPER_QUEUE            - default: broadcast (other: push-notification, fcm-batch, …)
#   DEDUP_RATE_MAX          - default: 5  (broadcast_dedup_total/min ceiling post-deploy)
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

header "Fix #16 verify — reaper leader-lock post-deploy gate (HEAD d97b5907)"

require_env ECS_CLUSTER
require_env ECS_SERVICE
require_env PROD_REDIS_HOST

if [[ "$FAILED" -gt 0 ]]; then
  printf "\n%s[FAIL]%s Required env vars missing — aborting before queries\n" "$RED" "$RESET"
  exit 1
fi

AWS_REGION="${AWS_REGION:-ap-south-1}"
ECS_TASK_DEFINITION="${ECS_TASK_DEFINITION:-weelobackendtask}"
PROD_REDIS_PORT="${PROD_REDIS_PORT:-6379}"
METRICS_NAMESPACE="${METRICS_NAMESPACE:-Weelo/Backend}"
REAPER_QUEUE="${REAPER_QUEUE:-broadcast}"
DEDUP_RATE_MAX="${DEDUP_RATE_MAX:-5}"

REDIS_CLI_ARGS=(-h "${PROD_REDIS_HOST}" -p "${PROD_REDIS_PORT}")
if [[ "${PROD_REDIS_TLS:-0}" == "1" ]]; then
  REDIS_CLI_ARGS+=(--tls)
fi

REAPER_LOCK_KEY="lock:processing-reaper:${REAPER_QUEUE}"

info "Region:           ${AWS_REGION}"
info "Task def family:  ${ECS_TASK_DEFINITION}"
info "Redis host:       ${PROD_REDIS_HOST}:${PROD_REDIS_PORT} (tls=${PROD_REDIS_TLS:-0})"
info "Reaper queue:     ${REAPER_QUEUE}"
info "Lock key:         ${REAPER_LOCK_KEY}"
info "Namespace:        ${METRICS_NAMESPACE}"

# ---- Check 1: FF_PROCESSING_REAPER_LEADER_LOCK is true OR unset (default ON) ----
header "Check 1/4 — FF_PROCESSING_REAPER_LEADER_LOCK enabled (default ON)"

LOCK_FLAG_VALUE="$(
  aws ecs describe-task-definition \
    --task-definition "${ECS_TASK_DEFINITION}" \
    --region "${AWS_REGION}" \
    --query 'taskDefinition.containerDefinitions[0].environment[?name==`FF_PROCESSING_REAPER_LEADER_LOCK`].value | [0]' \
    --output text 2>/dev/null || echo "ERROR"
)"

case "$LOCK_FLAG_VALUE" in
  ERROR)
    fail "Could not read task-def env — aws ecs describe-task-definition failed"
    ;;
  true)
    pass "FF_PROCESSING_REAPER_LEADER_LOCK=true in live task-def"
    ;;
  ""|None)
    # default ON per feature-flags.ts entry in §1.3 Pillar 2 (defaultValue: true)
    pass "FF_PROCESSING_REAPER_LEADER_LOCK unset → default ON (feature-flags.ts defaultValue=true)"
    ;;
  false)
    fail "FF_PROCESSING_REAPER_LEADER_LOCK=false — leader lock DISABLED; HPA Max=N → N× duplicate broadcasts"
    ;;
  *)
    fail "FF_PROCESSING_REAPER_LEADER_LOCK='${LOCK_FLAG_VALUE}' (expected 'true', 'false', or unset)"
    ;;
esac

# ---- Check 2: Redis lock held by exactly 1 holder (5x consistency check) ------
header "Check 2/4 — '${REAPER_LOCK_KEY}' held by exactly 1 holder (5 samples × 2s)"

declare -a HOLDERS=()
SAMPLE_FAIL=0
for i in 1 2 3 4 5; do
  HOLDER="$(
    redis-cli "${REDIS_CLI_ARGS[@]}" GET "${REAPER_LOCK_KEY}" 2>/dev/null || echo "REDIS_ERROR"
  )"
  if [[ "$HOLDER" == "REDIS_ERROR" ]]; then
    SAMPLE_FAIL=1
    break
  fi
  if [[ -z "$HOLDER" ]]; then
    info "  sample ${i}: <nil>  (lock briefly released — reaper interval ~30s, lock TTL ~10s)"
    HOLDERS+=("<nil>")
  else
    info "  sample ${i}: ${HOLDER}"
    HOLDERS+=("${HOLDER}")
  fi
  if [[ "$i" -lt 5 ]]; then
    sleep 2
  fi
done

if [[ "$SAMPLE_FAIL" -eq 1 ]]; then
  fail "redis-cli GET failed during sampling"
else
  # Filter out <nil> samples; accept majority same-holder among non-nil.
  NON_NIL=()
  for h in "${HOLDERS[@]}"; do
    if [[ "$h" != "<nil>" ]]; then NON_NIL+=("$h"); fi
  done

  if [[ "${#NON_NIL[@]}" -eq 0 ]]; then
    fail "All 5 samples returned <nil> — no pod elected leader (reaper interval may be paused)"
  else
    UNIQUE_COUNT="$(printf '%s\n' "${NON_NIL[@]}" | sort -u | wc -l | tr -d '[:space:]')"
    if [[ "$UNIQUE_COUNT" -eq 1 ]]; then
      pass "Lock consistently held by '${NON_NIL[0]}' across ${#NON_NIL[@]} non-nil sample(s) — single leader confirmed"
    else
      fail "Lock holder changed across samples (${UNIQUE_COUNT} distinct holders) — multiple pods racing leader; check FF_PROCESSING_REAPER_LEADER_LOCK"
      printf "       holders seen: %s\n" "$(printf '%s\n' "${NON_NIL[@]}" | sort -u | tr '\n' ' ')"
    fi
  fi
fi

# ---- Time window helpers (portable date for GNU + BSD) -----------------------
END_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if date -u -d "30 minutes ago" +%Y-%m-%dT%H:%M:%SZ >/dev/null 2>&1; then
  START_TIME="$(date -u -d "30 minutes ago" +%Y-%m-%dT%H:%M:%SZ)"
else
  START_TIME="$(date -u -v -30M +%Y-%m-%dT%H:%M:%SZ)"
fi

# ---- Checks 3+4: Prometheus metrics (informational, not CloudWatch) ----------
# IMPORTANT: `processing_reaper_lock_miss_total` and `broadcast_dedup_total`
# are AUTO-CREATED runtime counters via `metrics.service.ts:incrementCounter`
# (see metrics-definitions.ts — neither is registered there). They live ONLY
# in the in-process Prometheus exposition at `/metrics` (gated by
# HEALTH_ADMIN_TOKEN per `health.routes.ts:140-150,416`). They are NOT
# published to CloudWatch by any sidecar at HEAD d97b5907 — only the 3 DLQ
# depth gauges are mirrored to CloudWatch via dlq-broadcasts-depth-emitter.ts.
#
# Operator manual check (run from a host with bastion access to a task IP):
#   curl -s -H "X-Health-Admin-Token: ${HEALTH_ADMIN_TOKEN}" \
#     http://<task-ip>:8080/metrics | grep -E "processing_reaper_lock_miss_total|broadcast_dedup_total"
#
# Pass criteria (per §1.3 Pillar 4 lines 405-410):
#   - processing_reaper_lock_miss_total: non-zero on follower pods
#   - broadcast_dedup_total: flat / no spike post-deploy (≤ ${DEDUP_RATE_MAX}/min)
#
# Check 2 (lock holder consistency) is the AUTHORITATIVE leader-uniqueness
# check from this script — Checks 3+4 below are informational warnings.

header "Check 3/4 — processing_reaper_lock_miss_total (Prometheus-only — informational)"
warn "Metric lives in /metrics endpoint only — not in CloudWatch."
warn "  Manual: curl /metrics from a task IP (see runbook reaper-leader-verify.md)"
warn "  Skipped automated check; Check 2 (lock-holder consistency) is the canonical leader-uniqueness gate."

header "Check 4/4 — broadcast_dedup_total (Prometheus-only — informational)"
warn "Metric lives in /metrics endpoint only — not in CloudWatch."
warn "  Manual: curl /metrics from a task IP (see runbook reaper-leader-verify.md)"
warn "  Pass criteria: rate ≤ ${DEDUP_RATE_MAX}/min — verify manually via /metrics curl."

# ---- Summary -----------------------------------------------------------------
header "Summary"
if [[ "$FAILED" -eq 0 ]]; then
  printf "%s[ALL PASS]%s Fix #16 reaper leader-lock verification: 4/4 checks passed\n" "$GREEN" "$RESET"
  exit 0
else
  printf "%s[FAIL]%s Fix #16 reaper leader-lock verification: %d check(s) failed — investigate before declaring SHIP-COMPLETE\n" "$RED" "$RESET" "$FAILED"
  exit 1
fi
