#!/usr/bin/env bash
# =============================================================================
# enforce-log-retention.sh — DPDP Rule 8(3) §5(b) CloudWatch retention enforcer
# =============================================================================
# Without this, the env flip alone is COSMETIC: cloudWatchConfig.logRetention is
# declared-but-unused (0 put-retention-policy calls anywhere in src/ or scripts/).
# This script applies the policy via AWS CLI and fails the deploy if any /weelo/*
# group has retentionInDays=null (default forever = worst DPDP §5(b) failure mode).
# Wire into GHA setup-broadcast-p1-alarms.sh step OR ECS pre-deploy task.
#
# IAM precondition: the deploy role/principal needs the following permissions on
# `arn:aws:logs:${AWS_REGION}:${ACCOUNT_ID}:log-group:/weelo/*`:
#   logs:PutRetentionPolicy
#   logs:DescribeLogGroups
# Track the IAM-policy change as a sibling Terraform / IAM-role PR; do NOT merge
# this script ahead of it.
#
# Allowed retention values per AWS API: 1, 3, 5, 7, 14, 30, 60, 90, 120, 150,
# 180, 365, 400, 545, 731, 1827, 2192, 2557, 2922, 3288, 3653.

set -euo pipefail

AUDIT_DAYS="${LOG_RETENTION_AUDIT_DAYS:-365}"
APP_DAYS="${LOG_RETENTION_APP_DAYS:-30}"
ACCESS_DAYS="${LOG_RETENTION_ACCESS_DAYS:-90}"
AWS_REGION_VAL="${AWS_REGION:-ap-south-1}"

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

# === IAM precondition self-check ===
# Fail-fast guard: confirm the executing role has working AWS credentials AND
# can hit the logs:* surface BEFORE we try put-retention-policy. Without this,
# a missing IAM precondition PR (logs:PutRetentionPolicy + logs:DescribeLogGroups
# on arn:aws:logs:${AWS_REGION}:${ACCOUNT_ID}:log-group:/weelo/*) makes the
# first apply_policy call throw `AccessDeniedException` partway through the
# loop — by which time `/weelo/audit` may have been mutated but `/weelo/error`
# was never reached, leaving retention in a half-applied state. Self-check
# runs in <500ms and gives a clean, actionable error before any mutation.
#
# `aws sts get-caller-identity` exercises STS only — it does NOT verify the
# logs:* permissions themselves; that requires the explicit describe-log-groups
# probe below. Together they cover (1) credentials present + valid (STS) and
# (2) logs:DescribeLogGroups granted on the /weelo/* arn (CLI probe).
if ! aws sts get-caller-identity --region "$AWS_REGION_VAL" --output text \
     --query 'Arn' >/dev/null 2>&1; then
  echo "FAIL: aws sts get-caller-identity could not authenticate the deploy role."
  echo "      Check that AWS_ACCESS_KEY_ID/AWS_SESSION_TOKEN/instance-profile is wired."
  echo "      Required IAM: sts:GetCallerIdentity + logs:PutRetentionPolicy + logs:DescribeLogGroups on /weelo/*."
  exit 1
fi
if ! aws logs describe-log-groups --region "$AWS_REGION_VAL" \
     --log-group-name-prefix /weelo --max-items 1 >/dev/null 2>&1; then
  echo "FAIL: aws logs describe-log-groups denied — IAM precondition PR has not landed."
  echo "      Add logs:PutRetentionPolicy + logs:DescribeLogGroups on"
  echo "      arn:aws:logs:${AWS_REGION_VAL}:*:log-group:/weelo/* to the deploy role"
  echo "      BEFORE merging this script."
  exit 1
fi

allowed_days=(1 3 5 7 14 30 60 90 120 150 180 365 400 545 731 1827 2192 2557 2922 3288 3653)
is_allowed() {
  local needle="$1"
  for d in "${allowed_days[@]}"; do [[ "$d" == "$needle" ]] && return 0; done
  return 1
}
for v in "$AUDIT_DAYS" "$APP_DAYS" "$ACCESS_DAYS"; do
  if ! [[ "$v" =~ ^[0-9]+$ ]] || ! is_allowed "$v"; then
    echo "FAIL: retention value '$v' is not in AWS CloudWatch allowed set."
    echo "      allowed = ${allowed_days[*]}"
    exit 1
  fi
done

apply_policy() {
  local group="$1" days="$2"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY-RUN: would set $group -> ${days}d"; return 0
  fi
  aws logs put-retention-policy --region "$AWS_REGION_VAL" \
    --log-group-name "$group" --retention-in-days "$days"
  echo "OK: $group -> ${days}d"
}

apply_policy "/weelo/audit"       "$AUDIT_DAYS"
apply_policy "/weelo/application" "$APP_DAYS"
apply_policy "/weelo/access"      "$ACCESS_DAYS"
apply_policy "/weelo/error"       "$APP_DAYS"

# Orphan-group guard — retentionInDays=null = keep-forever, worst DPDP §5(b)
# failure mode. Fails the deploy so the gap is fixed before merge.
ORPHANS="$(aws logs describe-log-groups --region "$AWS_REGION_VAL" \
  --log-group-name-prefix /weelo \
  --query 'logGroups[?retentionInDays==`null`].logGroupName' --output text)"
if [[ -n "${ORPHANS// }" ]]; then
  echo "FAIL: log groups without retention policy (DPDP §5(b) breach risk):"
  echo "$ORPHANS" | tr '\t' '\n' | sed 's/^/  - /'
  exit 1
fi
echo "OK: all /weelo/* log groups have retention policies applied."
