#!/usr/bin/env bash
set -euo pipefail

: "${BASE_URL:?BASE_URL is required}"
: "${CUSTOMER_TOKEN:?CUSTOMER_TOKEN is required}"

response=$(curl -fsS -X POST "${BASE_URL}/api/v1/orders" \
  -H "Authorization: Bearer ${CUSTOMER_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-Load-Test-Run-Id: synthetic-create" \
  -d '{
    "pickup": {"latitude": 28.6139, "longitude": 77.2090, "address": "Connaught Place, New Delhi"},
    "drop": {"latitude": 28.4595, "longitude": 77.0266, "address": "Sector 29, Gurugram"},
    "distanceKm": 38,
    "vehicleRequirements": [{"vehicleType": "open", "vehicleSubtype": "14ft", "quantity": 1, "pricePerTruck": 3200}]
  }')

echo "$response" | python3 -c 'import json,sys; d=json.load(sys.stdin); oid=(d.get("data",{}).get("order",{}) or {}).get("id") or (d.get("data",{}) or {}).get("orderId"); print(oid if oid else "")' \
  | sed 's/^/create_order_probe orderId=/'
