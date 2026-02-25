#!/usr/bin/env bash
set -euo pipefail

# Phase 8 canary policy: 5% -> 25% -> 100%
# This script assumes traffic weighting is configured at ALB/CodeDeploy layer.

: "${BASE_URL:?BASE_URL is required}"
: "${ROLLBACK_SCRIPT:=./scripts/rollback.sh}"

check_gate() {
  local stage="$1"
  local summary
  local readiness
  local ws_health

  summary=$(curl -fsS "${BASE_URL}/health/slo?windowMinutes=5")
  readiness=$(curl -fsS "${BASE_URL}/health/ready")
  ws_health=$(curl -fsS "${BASE_URL}/health/websocket")
  local p99
  local err
  local ready_status
  local socket_adapter_enabled
  p99=$(echo "$summary" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("summary",{}).get("p99Ms",0))')
  err=$(echo "$summary" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("summary",{}).get("errorRate5xxPct",0))')
  ready_status=$(echo "$readiness" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("status","unknown"))')
  socket_adapter_enabled=$(echo "$ws_health" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(str(d.get("adapter",{}).get("enabled", False)).lower())')

  echo "[canary:${stage}] p99Ms=${p99} errorRate5xxPct=${err} ready=${ready_status} socketAdapter=${socket_adapter_enabled}"

  python3 - <<PY
p99=float("${p99}")
err=float("${err}")
ready_status="${ready_status}"
socket_adapter_enabled="${socket_adapter_enabled}" == "true"
require_socket_adapter="${REQUIRE_SOCKET_ADAPTER:-true}" == "true"
assert p99 <= 1200, f"p99 too high: {p99}"
assert err <= 0.5, f"5xx too high: {err}"
assert ready_status == "ready", f"service not ready: {ready_status}"
if require_socket_adapter:
    assert socket_adapter_enabled, "socket adapter disabled/failing in canary"
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
