# Canary Rollback Checklist (Backend ECS)

Use this checklist for every `5% -> 25% -> 100%` promotion gate.

## Pre-checks
- Confirm target commit SHA and task definition revision.
- Confirm alarms are active via `scripts/monitoring/setup-alarms.sh`.
- Confirm rollout flags:
  - `FF_CANCELLED_ORDER_QUEUE_GUARD=true`
  - `FF_CANCELLED_ORDER_QUEUE_GUARD_FAIL_OPEN=false`
  - `FF_LEGACY_BOOKING_PROXY_TO_ORDER=true`

## Promotion Gate Metrics
- Availability >= `99.9%`.
- Critical API `p99 < 1200ms`.
- Cancel-to-dismiss latency within agreed threshold.
- No cross-instance socket loss alerts.
- Cost-per-10k operations not regressing.

## Rollback Triggers
- ECS circuit breaker failure.
- Target-group unhealthy task trend during canary.
- Error-rate or p99 breach beyond gate.
- Broadcast stale-delivery guard drop anomaly spike.

## Rollback Actions
1. Stop promotion immediately.
2. Run canary rollback using:
   - `scripts/deploy/canary-rollout.sh` (rollback mode)
   - or `aws ecs update-service --force-new-deployment` to last known-good task def.
3. Verify stable desired/running count and healthy targets.
4. Verify OTP, broadcast ingest, cancel-dismiss, and tracking endpoints on smoke checks.
5. Keep feature flags at safest values while triaging.

## Post-Rollback Triage Snapshot
- Capture CloudWatch window (metrics + ECS events + logs).
- Record queue guard metrics:
  - `broadcast_queue_guard_dropped_total`
  - `broadcast_queue_guard_fail_open_total`
  - `broadcast_queue_guard_lookup_latency_ms`
- Record alias ingestion telemetry for captain events.
- Publish incident notes with timestamped actions.

