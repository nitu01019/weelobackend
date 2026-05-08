# Weelo Backend — Operator Playbook

**Authority:** index-20-validated.md §7C (Wk0–Wk1 operator sequence)
**Region:** ap-south-1
**Cluster/service:** fill in `ECS_CLUSTER` and `ECS_SERVICE` from your environment

---

## Phase Sequence

Execute runbooks in this exact order. Do NOT advance to the next phase until the current phase's gate passes.

| # | Runbook | Purpose | Est. time | Gate |
|---|---------|---------|-----------|------|
| 1 | `rds-upgrade.md` | Upgrade RDS db.t4g.micro → db.r6g.xlarge (3,201 max_connections) | 20–30 min | `aws rds describe-db-instances` → class = `db.r6g.xlarge` |
| 2 | `ecs-db-connection-limit.md` | Inject `DB_CONNECTION_LIMIT=125` into ECS task-def | ~8 min | `describe-task-definition` → env shows `DB_CONNECTION_LIMIT=125` |
| 3 | `hpa-cap.md` | Set HPA MaxCapacity=5 (Option A / r6g.xlarge) | ~5 min | HPA config shows `maxReplicas: 5` |
| 4 | `dlq-sidecar-verify.md` | Verify DLQ depth-emitter sidecar is live and emitting to CloudWatch | ~10 min | `weelo-dlq-broadcasts-depth-warn` alarm NOT in `INSUFFICIENT_DATA` |
| 5 | `cloudwatch-dlq-alarms.md` | Apply 4 drainer-health alarms (supplements the 4 depth-tier alarms from script) | ~10 min | 8 total alarms in OK/INSUFFICIENT_DATA (not ERROR) |
| 6 | `ff-depth-guard-flip.md` | Flip `FF_BATCH_QUEUE_DEPTH_GUARD=true` | ~10 min + 30 min soak | 4 soak signals green, no depth-guard saturation alarm |
| 7 | `dlq-drainer-preflight.md` | Pre-flip drainer readiness: 5 checks (leader lock, LLEN, canary, CW metric) | ~15 min | All 5 checks PASS before flip |
| 8 | `worker-ramp-step1.md` | Ramp `REDIS_QUEUE_WORKERS` 1 → 4, 1-hour soak | ~70 min | Gate A + B + C green for 60 min |
| 9 | `worker-ramp-step2-3.md` | Ramp 4 → 8 → 16, two 1-hour soaks | ~130 min | All 3 SLO gates green at WORKERS=16 |
| 10 | `worker-ramp-soak-dashboard.md` | CloudWatch dashboard for monitoring soaks | Before step 8 | Dashboard visible in AWS Console |

**Total elapsed time estimate:** ~5.5 hours end-to-end (dominated by 3 × 1-hour soaks).

---

## Go/No-Go Gate Summary

All three SLO gates below must hold throughout the worker ramp soaks (Steps 8–9):

| SLO Gate | Threshold | Metric | Namespace |
|----------|-----------|--------|-----------|
| Prisma pool wait | p99 ≤ **50 ms** | `pool_wait_seconds` | `Weelo/Backend` |
| RDS CPU | ≤ **70%** | `CPUUtilization` | `AWS/RDS` |
| RDS Connections | ≤ **2,240** (70% of 3,201) | `DatabaseConnections` | `AWS/RDS` |

If **any gate fails** during a soak, stop immediately and roll back to the previous worker count (one step back, never to 1). Do not re-attempt until the post-mortem root cause is resolved.

---

## Depth-Tier Alarm Thresholds (§7C 1.2)

These 4 alarms are created by `scripts/monitoring/setup-broadcast-p1-alarms.sh`. They must be in place **before** flipping `FF_BATCH_QUEUE_DEPTH_GUARD`.

| Alarm | Threshold | Period | Severity |
|-------|-----------|--------|----------|
| `weelo-dlq-broadcasts-depth-warn` | > 100 | 2 × 1 min | P3 |
| `weelo-dlq-broadcasts-depth-crit` | > 500 | 5 × 1 min | P2 |
| `weelo-dlq-broadcasts-depth-saturation` | ≥ 4500 | 60 s | P1 — HARD block-flip gate |
| `weelo-dlq-broadcasts-permanent-depth-warn` | > 0 | 5 × 1 min | P2 |

**HARD GATE:** If `weelo-dlq-broadcasts-depth-saturation` is in ALARM, do NOT flip `FF_BATCH_QUEUE_DEPTH_GUARD`. Drain the queue first.

---

## Rollback Sequence

If any phase fails its gate:

1. **Identify the breaching metric** from CloudWatch or runbook soak window.
2. **Rollback the ECS task-def** to the previous revision:
   ```bash
   # Get previous revision
   PREV_REV=$(( $(aws ecs describe-services --cluster "$ECS_CLUSTER" \
     --services "$ECS_SERVICE" --region ap-south-1 \
     --query 'services[0].taskDefinition' --output text | grep -o '[0-9]*$') - 1 ))
   aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" \
     --task-definition "weelobackendtask:${PREV_REV}" \
     --force-new-deployment --region ap-south-1
   aws ecs wait services-stable --cluster "$ECS_CLUSTER" \
     --services "$ECS_SERVICE" --region ap-south-1
   ```
3. **Confirm rollback complete:** all 3 SLO gates return to baseline.
4. **File post-mortem ticket** before re-attempting any phase.

---

## Escalation

| Escalation point | Contact |
|-----------------|---------|
| RDS upgrade issues | PLACEHOLDER: cloud infra team |
| ECS deployment failures | PLACEHOLDER: on-call engineer |
| Redis leader-lock failures | PLACEHOLDER: backend team lead |
| CloudWatch alarm misconfiguration | PLACEHOLDER: observability team |

---

## Quick Verification Script

Run `bash scripts/monitoring/verify-runbook-thresholds.sh` after completing Steps 1–5 to confirm all prerequisites are met before starting the worker ramp.
