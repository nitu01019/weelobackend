#!/usr/bin/env bash
# =============================================================================
# M-007a — Per-prefix timer ZSET migrator (NEW#1 rollout + rollback helper)
# =============================================================================
# SOTH: /Users/nitishbhardwaj/Downloads/index-20-validated.md §5.1
#   - Round-7 stamp at SOTH:108 — "Promote inline-Bash migrator to committed
#     scripts/timer-zset-migrate.sh (M-007a)"
#   - SOTH §5.1 lines 2296-2308 (PREFIX_TO_SHARD lock-list)
#   - SOTH §5.1 lines 2365-2371 (rollback inline-Bash block being promoted)
#
# CLAUDE.md "CRITICAL RULES FOR THIS DB" — this script touches Redis ONLY,
# never the DB; safe to run without invoking prisma migrate / prisma db push.
#
# Purpose
# -------
# Move timer entries between the legacy global ZSET `timers:pending` and the
# per-prefix shard ZSETs `timers:pending:{<prefix>}` introduced by NEW#1.
#
# Two directions:
#   forward   legacy `timers:pending`               -> per-prefix shard ZSETs
#             (use during NEW#1 cutover when in-flight entries written before
#              the rolling deploy still sit in the legacy bucket)
#   rollback  per-prefix shard ZSETs                -> legacy `timers:pending`
#             (use ONLY when reverting NEW#1 after legacy ZSET has drained per
#              SOTH §5.1 lines 2362-2372 — required step (b) of joint revert)
#
# Two modes:
#   dry-run   read + count + log only — never ZADD/ZREM. Safe to run anytime.
#   apply     perform ZADD on destination + (forward only) ZREM from source.
#             Idempotent — ZADD on existing member updates score in place.
#
# Pre-flight (operator)
#   - Confirm FF_TIMER_LEGACY_ZSET_ENABLED=true so dual-write window is live.
#   - Run `dry-run` first; verify per-prefix counts match expectation.
#   - For rollback: verify ZCARD timers:pending >= sum(shard ZCARDs) AFTER apply
#     before merging any revert PR (SOTH §5.1 line 2372).
#
# Usage
#   REDIS_URL=redis://host:6379/0 ./scripts/timer-zset-migrate.sh forward dry-run
#   REDIS_URL=redis://host:6379/0 ./scripts/timer-zset-migrate.sh forward apply
#   REDIS_URL=redis://host:6379/0 ./scripts/timer-zset-migrate.sh rollback dry-run
#   REDIS_URL=redis://host:6379/0 ./scripts/timer-zset-migrate.sh rollback apply
# =============================================================================
set -euo pipefail

REDIS_URL="${REDIS_URL:?REDIS_URL is required (e.g. redis://host:6379/0)}"
DIRECTION="${1:?Usage: $0 <forward|rollback> <dry-run|apply>}"
MODE="${2:?Usage: $0 <forward|rollback> <dry-run|apply>}"

case "$DIRECTION" in forward|rollback) ;; *) echo "direction must be forward or rollback" >&2; exit 2;; esac
case "$MODE" in dry-run|apply) ;; *) echo "mode must be dry-run or apply" >&2; exit 2;; esac

LEGACY_ZSET="timers:pending"

# Mirror of SOTH §5.1 lines 2297-2303 (PREFIX_TO_SHARD lock-list) plus _misc
# fallback at line 2308. Keep this list in sync with timerShardZset() in
# src/shared/services/redis.service.ts — drift = silent migration gap.
PREFIXES=(
  "order-expiry"
  "order-broadcast-step"
  "assignment-timeout"
  "booking-order"
  "booking"
  "radius"
  "rating-reminder"
  "_misc"
)

# Map a `timer:<prefix>:<id>` member back to its shard suffix. Mirrors the
# startsWith() loop in timerShardZset(). Returns _misc for unknown prefixes
# (matches SOTH §5.1 line 2308 fallback).
member_to_prefix() {
  local member="$1"
  case "$member" in
    timer:order-expiry:*)         echo "order-expiry" ;;
    timer:order-broadcast-step:*) echo "order-broadcast-step" ;;
    timer:assignment-timeout:*)   echo "assignment-timeout" ;;
    timer:booking-order:*)        echo "booking-order" ;;
    timer:booking:*)              echo "booking" ;;
    timer:radius:*)               echo "radius" ;;
    timer:rating-reminder:*)      echo "rating-reminder" ;;
    *)                            echo "_misc" ;;
  esac
}

shard_zset() { echo "timers:pending:{$1}"; }

rcli() { redis-cli -u "$REDIS_URL" "$@"; }

echo "[migrate] direction=$DIRECTION mode=$MODE redis=${REDIS_URL%%@*}"
echo "[migrate] FF_TIMER_LEGACY_ZSET_ENABLED expected: true (dual-write window)"

if [[ "$DIRECTION" == "forward" ]]; then
  TOTAL=0
  declare -A MOVED_BY_PREFIX
  for p in "${PREFIXES[@]}"; do MOVED_BY_PREFIX[$p]=0; done

  while IFS=$'\n' read -r line; do
    [[ -z "$line" ]] && continue
    member="$line"
    IFS=$'\n' read -r score
    [[ -z "$score" ]] && continue
    prefix="$(member_to_prefix "$member")"
    dest="$(shard_zset "$prefix")"
    if [[ "$MODE" == "apply" ]]; then
      rcli ZADD "$dest" "$score" "$member" >/dev/null
      rcli ZREM "$LEGACY_ZSET" "$member" >/dev/null
    fi
    MOVED_BY_PREFIX[$prefix]=$(( ${MOVED_BY_PREFIX[$prefix]} + 1 ))
    TOTAL=$(( TOTAL + 1 ))
  done < <(rcli ZRANGEBYSCORE "$LEGACY_ZSET" -inf +inf WITHSCORES)

  echo "[migrate] forward $MODE complete — total=$TOTAL"
  for p in "${PREFIXES[@]}"; do
    echo "[migrate]   $p -> $(shard_zset "$p"): ${MOVED_BY_PREFIX[$p]}"
  done
else
  TOTAL=0
  for p in "${PREFIXES[@]}"; do
    src="$(shard_zset "$p")"
    COUNT=0
    while IFS=$'\n' read -r line; do
      [[ -z "$line" ]] && continue
      member="$line"
      IFS=$'\n' read -r score
      [[ -z "$score" ]] && continue
      if [[ "$MODE" == "apply" ]]; then
        rcli ZADD "$LEGACY_ZSET" "$score" "$member" >/dev/null
      fi
      COUNT=$(( COUNT + 1 ))
    done < <(rcli ZRANGEBYSCORE "$src" -inf +inf WITHSCORES)
    echo "[migrate]   $src -> $LEGACY_ZSET: $COUNT"
    TOTAL=$(( TOTAL + COUNT ))
  done
  echo "[migrate] rollback $MODE complete — total=$TOTAL"
  echo "[migrate] verify: ZCARD $LEGACY_ZSET >= sum(shard ZCARDs) per SOTH §5.1 line 2372"
fi

echo "[migrate] done"
