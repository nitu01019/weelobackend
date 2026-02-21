#!/usr/bin/env bash
set -euo pipefail

: "${BASE_URL:?BASE_URL is required}"

health=$(curl -fsS "${BASE_URL}/health/websocket")
status=$(echo "$health" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("status",""))')
count=$(echo "$health" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("socketCount",0))')

echo "websocket_probe: status=${status} socketCount=${count}"
