# Dashboard & Alarms — Phase 1 Broadcast Baseline

**Owner:** T1.7 (`t1-7-dashboard-handoff`)
**Scope:** CloudWatch dashboard + alarms covering Phase 1 tickets L1, L2, L3, L4, L6, L7, M9, M18, SC1, SC2, SC8.
**Region:** `ap-south-1`
**Consumer:** Release captain (Phase 2 `T2.6`) will read this doc to verify Phase 1 observability is live before starting Phase 2 work.

---

## What was built

| File | Purpose |
|---|---|
| `scripts/monitoring/broadcast-baseline-p1-dashboard.json` | CloudWatch dashboard body (11 widgets). |
| `scripts/monitoring/setup-broadcast-p1-alarms.sh` | Bash script that installs 5 alarms (1 P2, 4 P3). |
| `.planning/verification/DASHBOARD-P1.md` | This file — import & apply runbook. |
| `.planning/verification/P1-HANDOFF.md` | Exit-gate ledger — commits/SHAs/verification evidence (T1.7 fills in as PRs land). |

**Not modified:** `scripts/monitoring/setup-alarms.sh` (phase8 alarms) — preserved as-is.

---

## Why the split exists

The phase8 alarms script (`setup-alarms.sh`) covers ECS/ALB infra only. Phase 1 adds **application-level counters** (Prometheus on `/metrics`) that do not yet flow to CloudWatch. The new dashboard panels reserve the visual layout and metric names so that once the Prometheus→CloudWatch bridge is wired (see §"Metric pipeline") the widgets begin rendering automatically — no dashboard redeploy needed.

Alarm thresholds sit in `treat-missing-data=notBreaching` state until data appears, which means they will **not false-page** during the 0-data period. This is the intended safe default.

---

## How to apply

### 1. Prerequisites

- AWS CLI v2 configured with the `weelo-backend` ops profile (or equivalent IAM role with `cloudwatch:PutDashboard`, `cloudwatch:PutMetricAlarm`).
- An SNS topic for P2 paging (existing: the phase8 topic works). Export as `ALARM_SNS_TOPIC_ARN`.
- *(optional)* A separate SNS topic for P3 soft pagers → `ALARM_SNS_P3_TOPIC_ARN`. If unset, P3 alarms route to the same topic as P2.

```bash
export AWS_REGION=ap-south-1
export ALARM_SNS_TOPIC_ARN=arn:aws:sns:ap-south-1:ACCOUNT_ID:weelo-alarms-p2
export ALARM_SNS_P3_TOPIC_ARN=arn:aws:sns:ap-south-1:ACCOUNT_ID:weelo-alarms-p3  # optional
export CW_NAMESPACE=Weelo/Backend                                                 # matches bridge config
```

### 2. Install alarms

```bash
bash scripts/monitoring/setup-broadcast-p1-alarms.sh
```

Expected output (truncated):

```
[T1.7] Phase 1 broadcast-baseline alarms configured in ap-south-1, namespace=Weelo/Backend.
[T1.7] Apply dashboard:
       aws cloudwatch put-dashboard ...
```

### 3. Install dashboard

```bash
aws cloudwatch put-dashboard \
  --dashboard-name weelo-broadcast-baseline-p1 \
  --dashboard-body file://scripts/monitoring/broadcast-baseline-p1-dashboard.json \
  --region ap-south-1
```

### 4. Wire the Prometheus → CloudWatch bridge (required for app counters to render)

See §"Metric pipeline: Prometheus → CloudWatch" below for the recommended approach (EMF log-emission) and rejected alternatives. Until the bridge lands, ECS CPU/Memory is the only panel showing data.

### 5. Verify

```bash
# List installed alarms
aws cloudwatch describe-alarms \
  --alarm-name-prefix weelo-p1- \
  --region ap-south-1 \
  --query 'MetricAlarms[*].[AlarmName,StateValue,MetricName]' \
  --output table

# Confirm dashboard exists
aws cloudwatch get-dashboard \
  --dashboard-name weelo-broadcast-baseline-p1 \
  --region ap-south-1 \
  --query 'DashboardArn' --output text
```

Expected alarm states on first install (pre-bridge):
- `weelo-p1-socket-adapter-down` → `INSUFFICIENT_DATA`
- `weelo-p1-eta-fallback-spike` → `INSUFFICIENT_DATA`
- `weelo-p1-fleet-cache-corruption` → `INSUFFICIENT_DATA`
- `weelo-p1-post-commit-cache-failure-google_directions` → `INSUFFICIENT_DATA`
- `weelo-p1-post-commit-cache-failure-idempotency` → `INSUFFICIENT_DATA`

Once the bridge is wired and real traffic flows, states should transition to `OK`.

---

## Panel catalog

| # | Widget | Ticket | Source | Blocker until bridge? |
|---|---|---|---|---|
| 1 | Title text | — | static | No |
| 2 | `eta_ranking_fallback_total` rate by `reason` | L3 (T1.1) | app (Prom → CW) | Yes |
| 3 | `fleet_cache_corruption_total` rate | L7 (T1.1) | app (Prom → CW) | Yes |
| 4 | `post_commit_cache_failure_total` by `cache` | L2 (T1.2) | app (Prom → CW) | Yes |
| 5 | `socket_emit_while_adapter_down_total` by `event` | M18 (T1.2) | app (Prom → CW) | Yes |
| 6 | L1 note (Firebase Analytics only) | L1 (T1.3) | customer-app analytics | N/A (not CW) |
| 7 | M9 note (removed; verified by grep) | M9 (T1.3) | — | N/A (no metric) |
| 8 | `server_boot_scan_ms` histogram (p50/p95/p99) | SC8 (T1.5) | app (Prom → CW) | Yes |
| 9 | ECS CPU / Memory | infra | AWS/ECS | No |
| 10 | SC1+SC2 pg_stat_user_indexes manual query panel | SC1+SC2 (T1.4) | psql runbook | No (manual) |
| 11 | Prometheus→CW bridge footer | — | static | No |

---

## Alarm catalog

| # | Alarm name | Severity | Metric | Threshold | Rationale |
|---|---|---|---|---|---|
| 1 | `weelo-p1-socket-adapter-down` | P2 | `socket_emit_while_adapter_down_total` | any emit in 2m window | Cross-instance broadcast drops → customer-visible |
| 2 | `weelo-p1-eta-fallback-spike` | P3 | `eta_ranking_fallback_total` | > 5/min for 3m | Google Directions issue → ranking degrades |
| 3 | `weelo-p1-fleet-cache-corruption` | P3-soft | `fleet_cache_corruption_total` | > 10/hour | Slow-burn JSON.stringify bug |
| 4a | `weelo-p1-post-commit-cache-failure-google_directions` | P3 | `post_commit_cache_failure_total{cache=google_directions}` | > 20/min for 3m | Post-commit cache sync regression |
| 4b | `weelo-p1-post-commit-cache-failure-idempotency` | P3 | `post_commit_cache_failure_total{cache=idempotency}` | > 20/min for 3m | Post-commit cache sync regression |

Note on #4: CloudWatch does not support "OR across label values" in a single alarm definition, so Alarm 4 is split by cache label. Both send to the same SNS topic.

Note on #1 semantics: the script uses `period=120s, evaluation-periods=1, threshold=0, Sum` — i.e. the alarm fires if the sum over a single 2-minute window is > 0 (any emit). `Sum` is used with `treat-missing-data=notBreaching` so zero-data keeps the alarm quiet.

---

## SC1/SC2 index usage — manual verification

The pg_stat_user_indexes counters are not exported to CloudWatch in Phase 1 (no periodic exporter). T1.4's `PRODUCTION-INDEX-RUNBOOK-P1.md` covers the execution procedure; the exit-gate verification is:

```sql
SELECT
  relname,
  indexrelname,
  idx_scan,
  idx_tup_read,
  idx_tup_fetch
FROM pg_stat_user_indexes
WHERE indexrelname IN (
  'idx_user_kyc_broadcast',
  'idx_vehicle_key_avail'
);
```

Run 1 hour after the director executes the manual migration SQL. Exit gate passes if **`idx_scan > 0` on both rows**. Record the psql output in `P1-HANDOFF.md`.

---

## Rollback

```bash
# Remove dashboard
aws cloudwatch delete-dashboards \
  --dashboard-names weelo-broadcast-baseline-p1 \
  --region ap-south-1

# Remove alarms
aws cloudwatch delete-alarms \
  --alarm-names \
    weelo-p1-socket-adapter-down \
    weelo-p1-eta-fallback-spike \
    weelo-p1-fleet-cache-corruption \
    weelo-p1-post-commit-cache-failure-google_directions \
    weelo-p1-post-commit-cache-failure-idempotency \
  --region ap-south-1
```

Rollback is safe: these are observability-only resources and removing them does not affect request handling.

---

## Metric pipeline: Prometheus → CloudWatch

**Gap:** the backend emits Prometheus text on `GET /metrics` but does NOT publish to CloudWatch. Every app-counter panel on this dashboard depends on a bridge that moves those counters into the CW `Weelo/Backend` namespace. This is a **cross-phase infra follow-up** — explicitly NOT a Phase 1 blocker. The dashboard and alarms ship as planned; they sit in `INSUFFICIENT_DATA` until the bridge is wired.

### Assumed target namespace

`Weelo/Backend` (matches `CW_NAMESPACE` default in `setup-broadcast-p1-alarms.sh` and every dashboard widget metric tuple). Whichever bridge option wins below MUST publish under this namespace so the existing JSON + alarm definitions work unchanged.

### Option A — EMF log-emission from `metrics.service.ts` **[RECOMMENDED]**

Embedded Metric Format lines written to stdout on every counter increment. The existing ECS `awslogs` driver ships stdout to the `weelobackendtask` CloudWatch Logs group; CloudWatch auto-parses EMF records and creates custom metrics with zero additional infrastructure.

**Pros**
- Zero new infra. No sidecar, no IAM changes, no Lambda, no VPC/SG rework. Re-uses the log pipeline we already rely on.
- Label cardinality stays under developer control (same shape as today's Prometheus labels).
- Works locally in dev — EMF records are just JSON, still human-readable.
- Cheapest operationally — metric ingestion is priced on log volume that already flows.

**Cons**
- ~30-40 LOC change in `metrics.service.ts` to wrap `incrementCounter` / `observeHistogram` with an EMF stdout write. Small, well-scoped PR.
- Each counter increment emits one log line → volume increases. Mitigated via `aws-embedded-metrics`'s request-scoped flush (one EMF record per request cycle instead of one per increment).
- No pre-aggregation: hot counters (`http_requests_total`) need histograms/percentiles, or periodic flush.

**Evidence it's a clean fit here**
- `Dockerfile.production:36` logs to stdout; no file mounts to re-wire.
- `metrics.service.ts:128` (`incrementCounter`) and `:243` (`getPrometheusMetrics`) are single chokepoints — one place to hook EMF. (Line numbers verified against `origin/main-new` baseline; grep-pattern-stable even if lines drift further.)
- `@aws-sdk/client-kinesis`/`-s3`/`-sns` are already in `package.json`; adding `aws-embedded-metrics` (~60KB) is not a footprint concern.
- CLAUDE.md §"Metrics Counters Not Registered" shows the metrics path was recently consolidated into `metrics-definitions.ts`; EMF is a natural next layer on top.

**Estimated effort:** 1 teammate, half a day (code + test) + half a day observing ingestion on staging.

### Option B — ADOT collector sidecar (AWS Distro for OpenTelemetry)

Run an ADOT container as a sidecar in the ECS task; it scrapes `GET /metrics` on a schedule and calls `PutMetricData`.

**Pros**
- Zero app-code change. Prometheus text is already exposed — ADOT just scrapes it.
- Open-source, AWS-maintained, well-documented.
- Side-benefits (traces, logs) available later under the same sidecar.

**Cons**
- New container in every ECS task. Memory/CPU budget increases (~128MB + 128m CPU default).
- Task-definition + CICD changes; IAM role needs `cloudwatch:PutMetricData`.
- Collector health becomes a new dependency of metric-pipeline health.
- Slightly higher API cost — `PutMetricData` priced per metric per minute; label combinations multiply.

**Estimated effort:** 1 teammate, 1-2 days.

### Option C — Lambda cron scraping `/metrics` + `PutMetricData`

EventBridge-triggered Lambda curls the ECS service's `/metrics` and calls `PutMetricData`.

**Pros**
- Fully decoupled from the app; no code/container changes.

**Cons**
- Most code to write (Lambda, IAM, VPC for internal ECS reach, EventBridge rule, Prometheus text parser).
- Sampling-based — misses sub-minute spikes.
- VPC Lambda cold-starts add operational complexity.
- Multiple ECS tasks → which to scrape? Needs aggregation or per-task scrape.

**Estimated effort:** 1 teammate, 2-3 days.

### Recommendation for the director

**Go with Option A (EMF).** It matches Weelo's existing pattern (stdout → awslogs → CloudWatch), requires no new infra, and the code change is isolated to `src/shared/monitoring/metrics.service.ts` — a file T1.6 just consolidated, so context is already fresh on the team. `aws-embedded-metrics` is the AWS-supported library and handles batching/flush semantics correctly.

If label cardinality becomes a concern later (e.g. high-cardinality `user_id` labels), migrate hot counters to histograms or move to ADOT — but start with EMF.

### Follow-up ticket

Tracked in `P1-HANDOFF.md` §3 as a P1 director follow-up `P1-FOLLOWUP-1`. Effort estimate: <1 day, one teammate. Must ship before Phase 2 canary.

---

## Phase 2 handoff notes (for `T2.6` release captain)

1. Read `P1-HANDOFF.md` first — that's the ledger of what landed and the evidence.
2. Before starting Phase 2 work, confirm all 5 alarms are in `OK` state for at least 24h of real traffic — not `INSUFFICIENT_DATA` (that means the bridge never wired up and Phase 1 observability is de facto not live).
3. If any app counter panel is empty for > 1h after director confirms bridge deployment, open a P3 ticket against T1.6 to fix the emit path before proceeding.
4. SC1/SC2: verify `idx_scan > 0` via the psql snippet above. Record in your Phase 2 kickoff doc.
5. `P1-FOLLOWUP-1` (Prometheus→CW bridge) MUST be closed before Phase 2 canary — otherwise you're canarying a feature flip with no signal.
