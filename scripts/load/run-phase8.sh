#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT_DIR="${REPORT_DIR:-${SCRIPT_DIR}/reports}"
mkdir -p "${REPORT_DIR}"

if ! command -v k6 >/dev/null 2>&1; then
  echo "k6 is not installed. Install from https://k6.io/docs/get-started/installation/"
  exit 1
fi

API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"

run_round() {
  local round="$1"
  local rate="$2"
  local duration="$3"

  local run_id="phase8-${round}-$(date +%Y%m%d-%H%M%S)"
  echo "[phase8] Running round=${round} run_id=${run_id}"

  k6 run "${SCRIPT_DIR}/create-order-burst.js" \
    -e API_BASE_URL="${API_BASE_URL}" \
    -e LOAD_TEST_RUN_ID="${run_id}-create" \
    -e RATE="${rate}" \
    -e DURATION="${duration}" \
    --summary-export "${REPORT_DIR}/${run_id}-create-summary.json"

  k6 run "${SCRIPT_DIR}/accept-race-contention.js" \
    -e API_BASE_URL="${API_BASE_URL}" \
    -e LOAD_TEST_RUN_ID="${run_id}-accept" \
    -e DURATION="${duration}" \
    --summary-export "${REPORT_DIR}/${run_id}-accept-summary.json"

  k6 run "${SCRIPT_DIR}/cancel-during-assign.js" \
    -e API_BASE_URL="${API_BASE_URL}" \
    -e LOAD_TEST_RUN_ID="${run_id}-cancel-assign" \
    -e DURATION="${duration}" \
    --summary-export "${REPORT_DIR}/${run_id}-cancel-assign-summary.json"

  k6 run "${SCRIPT_DIR}/reconnect-event-fanout.js" \
    -e API_BASE_URL="${API_BASE_URL}" \
    -e LOAD_TEST_RUN_ID="${run_id}-reconnect" \
    -e DURATION="${duration}" \
    --summary-export "${REPORT_DIR}/${run_id}-reconnect-summary.json"
}

run_round "baseline" "80" "2m"
run_round "tuned" "120" "2m"
run_round "regression" "100" "2m"

echo "[phase8] Load rounds completed. Reports at ${REPORT_DIR}"
