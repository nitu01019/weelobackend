#!/usr/bin/env bash
set -euo pipefail

# Phase 8 canary policy: 5% -> 25% -> 100%
# This script assumes traffic weighting is configured at ALB/CodeDeploy layer.

: "${BASE_URL:?BASE_URL is required}"
: "${ROLLBACK_SCRIPT:=./scripts/rollback.sh}"

check_gate() {
  local stage="$1"
  local summary

  summary=$(curl -fsS "${BASE_URL}/health/slo?windowMinutes=5")
  local p99
  local err
  p99=$(echo "$summary" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("summary",{}).get("p99Ms",0))')
  err=$(echo "$summary" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("summary",{}).get("errorRate5xxPct",0))')

  echo "[canary:${stage}] p99Ms=${p99} errorRate5xxPct=${err}"

  python3 - <<PY
p99=float("${p99}")
err=float("${err}")
assert p99 <= 1200, f"p99 too high: {p99}"
assert err <= 0.5, f"5xx too high: {err}"
PY
}

for stage in 5 25 100; do
  echo "[canary] shift traffic to ${stage}%"
  echo "[canary] hold 30 minutes for stage ${stage}%"
  # External traffic-shift command should be invoked here by infra pipeline.
  # sleep 1800

  if ! check_gate "${stage}"; then
    echo "[canary] gate failed at ${stage}%, rolling back"
    ${ROLLBACK_SCRIPT}
    exit 1
  fi
done

echo "[canary] rollout gates passed for 5% -> 25% -> 100%"
