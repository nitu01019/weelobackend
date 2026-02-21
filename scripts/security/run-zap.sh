#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT_DIR="${REPORT_DIR:-${SCRIPT_DIR}/reports}"
mkdir -p "${REPORT_DIR}"

: "${STAGING_BASE_URL:?STAGING_BASE_URL is required}"
: "${ZAP_LOGIN_PHONE:?ZAP_LOGIN_PHONE is required}"
: "${ZAP_LOGIN_OTP:?ZAP_LOGIN_OTP is required}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to run ZAP"
  exit 1
fi

ZAP_BEARER_TOKEN="$(${SCRIPT_DIR}/zap-auth.js)"
export ZAP_BEARER_TOKEN
export STAGING_BASE_URL

docker run --rm \
  -v "${SCRIPT_DIR}:/zap/wrk:rw" \
  -e STAGING_BASE_URL \
  -e ZAP_BEARER_TOKEN \
  ghcr.io/zaproxy/zaproxy:stable \
  zap.sh -cmd -autorun /zap/wrk/zap-config.yaml

cp "${SCRIPT_DIR}/zap-report.html" "${REPORT_DIR}/zap-report-$(date +%Y%m%d-%H%M%S).html" || true

echo "ZAP scan complete"
