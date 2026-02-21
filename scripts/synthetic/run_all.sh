#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"${SCRIPT_DIR}/health_probe.sh"
"${SCRIPT_DIR}/websocket_probe.sh"

if [[ -n "${CUSTOMER_TOKEN:-}" ]]; then
  "${SCRIPT_DIR}/create_order_probe.sh"
fi

echo "synthetic probes completed"
