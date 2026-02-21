#!/usr/bin/env bash
set -euo pipefail

: "${BASE_URL:?BASE_URL is required}"
: "${CUSTOMER_TOKEN:?CUSTOMER_TOKEN is required}"
: "${ORDER_ID:?ORDER_ID is required}"

curl -fsS -X POST "${BASE_URL}/api/v1/orders/${ORDER_ID}/cancel" \
  -H "Authorization: Bearer ${CUSTOMER_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-Load-Test-Run-Id: synthetic-cancel" \
  -d '{"reason":"synthetic_probe"}' >/dev/null

echo "cancel_order_probe: ok orderId=${ORDER_ID}"
