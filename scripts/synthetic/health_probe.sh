#!/usr/bin/env bash
set -euo pipefail

: "${BASE_URL:?BASE_URL is required}"

curl -fsS "${BASE_URL}/health" >/dev/null
curl -fsS "${BASE_URL}/health/ready" >/dev/null
curl -fsS "${BASE_URL}/health/slo?windowMinutes=5" >/dev/null

echo "health_probe: ok"
