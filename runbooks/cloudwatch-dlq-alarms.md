# CloudWatch DLQ Alarms — Runbook (Supplementary Drainer-Health Alarms)

**Scope:** Four operator-added supplementary alarms covering DLQ broadcast drainer
health. These are **separate from** the 4 depth-tier alarms produced by
[`scripts/monitoring/setup-broadcast-p1-alarms.sh`](../scripts/monitoring/setup-broadcast-p1-alarms.sh)
(`weelo-dlq-broadcasts-depth-{warn,crit,saturation}` and
`weelo-dlq-broadcasts-permanent-depth-warn`). Run the script first; the alarms
in this runbook extend that baseline with drain-progress, replay-failure-rate,
and inflight-leak coverage.\
**Namespace:** `Weelo/Backend` (same as setup-broadcast-p1-alarms.sh)\
**Region:** `ap-south-1` (override with `AWS_REGION`)\
**SNS:** Replace every `<SNS_TOPIC_ARN>` placeholder with the real ARN before running.

> **DOC-ONLY.** No AWS commands in this file execute automatically.
> Run the CLI blocks manually after sourcing credentials.

> **Pipeline prereq:** Like the four depth-tier alarms in
> `setup-broadcast-p1-alarms.sh`, every counter-based alarm below depends on
> the CloudWatch metric-filter / EMF pipeline that exports Prometheus counters
> from log lines (see `DASHBOARD-P1.md §"Metric-filter TODOs"`). Until that
> pipeline is wired, alarms targeting `*_total` counters sit in
> `INSUFFICIENT_DATA` — the intended safe default. Gauge-based alarms (e.g.
> `dlq_broadcasts_inflight_depth`) are mirrored directly via the sidecar
> `src/shared/services/dlq-broadcasts-depth-emitter.ts` and do NOT depend on
> the metric-filter pipeline.

---

## Operator Dashboard Tip — Two Different DLQ Depth Gauges

When you run `aws cloudwatch list-metrics --namespace Weelo/Backend` you may see
**two superficially similar gauge names**. They are intentionally different and
are NOT interchangeable:

| Gauge name | Emitted by | Source path | Where it lives | Purpose |
|---|---|---|---|---|
| `dlq_broadcasts_depth` | Sidecar emitter (every 30 s, mirrored to CloudWatch via `PutMetricData`) | `src/shared/services/dlq-broadcasts-depth-emitter.ts:44` | CloudWatch + Prometheus `/metrics` | **Authoritative depth gauge for CloudWatch alarms** |
| `broadcast_dlq_depth` | Drainer (set per drain cycle on the local Prometheus registry only) | `scripts/replay-broadcast-dlq.ts:150` | Prometheus `/metrics` only — NOT mirrored to CloudWatch | Drainer-internal Prometheus gauge for `/metrics` endpoint scraping (Grafana/local) |

**Rule of thumb for alarms:** always target `dlq_broadcasts_depth` (sidecar,
mirrored). The drainer's `broadcast_dlq_depth` is observable only via the
Prometheus endpoint and will not appear in CloudWatch unless someone wires a
Prometheus-to-CloudWatch shipper for it. **Do not author CloudWatch alarms
against `broadcast_dlq_depth`** — they will sit in `INSUFFICIENT_DATA`
forever.

The four `setup-broadcast-p1-alarms.sh` depth-tier alarms (`-warn`, `-crit`,
`-saturation`, `-permanent-depth-warn`) all target the sidecar gauges
(`dlq_broadcasts_depth`, `dlq_broadcasts_permanent_depth`). The supplementary
alarms below follow the same convention.

---

## Prerequisites

```bash
# Source production env to populate AWS credentials and region
source /path/to/.env.production

# Verify the sidecar is emitting dlq_broadcasts_depth before continuing.
# The metric must appear in CW or alarms will stay in INSUFFICIENT_DATA.
aws cloudwatch get-metric-statistics \
  --namespace Weelo/Backend \
  --metric-name dlq_broadcasts_depth \
  --statistics Maximum \
  --period 60 \
  --start-time "$(date -u -v-5M +%FT%TZ 2>/dev/null || date -u -d '5 minutes ago' +%FT%TZ)" \
  --end-time   "$(date -u +%FT%TZ)" \
  --region ap-south-1
```

---

## Alarm 1 — DLQ Depth Sustained (>= 1000, 2 of 2 datapoints, 10 min)

**Alarm name:** `weelo-dlq-broadcasts-depth-high`

> **Why supplementary:** sits between the script's `-warn` (>100/2m) and
> `-crit` (>500/5m) tiers, biased toward catching **structural** drainer
> lag rather than transient spikes. The `2 of 2 × 5 min` requirement
> (10 min sustained) is stricter than `-crit` and eliminates single-sample
> bursts.

```bash
aws cloudwatch put-metric-alarm \
  --region "${AWS_REGION:-ap-south-1}" \
  --alarm-name "weelo-dlq-broadcasts-depth-high" \
  --alarm-description "[P2] Supplementary — dlq_broadcasts_depth >= 1000 for 2 consecutive 5-min datapoints (10 min sustained). Drainer is structurally behind admit rate (this is stricter than -crit which fires on a 5-min single window). Compare broadcast_dlq_replayed_total (drain rate) vs dlq_pushed_total (admit rate) over a 5-min window; scale drainer or roll back FF_BATCH_QUEUE_DEPTH_GUARD if saturation alarm (weelo-dlq-broadcasts-depth-saturation) has fired in the last 24h." \
  --namespace "Weelo/Backend" \
  --metric-name "dlq_broadcasts_depth" \
  --statistic Maximum \
  --period 300 \
  --evaluation-periods 2 \
  --datapoints-to-alarm 2 \
  --threshold 1000 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions "<SNS_TOPIC_ARN>"
```

**Runbook steps when firing:**

1. Compare drain rate vs admit rate in CloudWatch (5-min delta):
   - drain rate = `broadcast_dlq_replayed_total` (Sum over 5 min) — emitted by `scripts/replay-broadcast-dlq.ts:129`.
   - admit rate = `dlq_pushed_total` (Sum over 5 min) — emitted by `src/shared/services/queue.service.ts`.
   If drain < admit, the drainer is the bottleneck.
2. Inspect drainer logs: `aws logs filter-log-events --log-group-name weelobackendtask --filter-pattern "[DLQ-Drainer]"`.
3. Scale ECS task count up by 1 and watch `dlq_broadcasts_depth` trend.
4. If depth continues rising, check whether `weelo-dlq-broadcasts-depth-saturation` (from `setup-broadcast-p1-alarms.sh`) has fired; if yes, do NOT flip `FF_BATCH_QUEUE_DEPTH_GUARD=true`.

---

## Alarm 2 — Drainer Replay-Failure Rate

**Alarm name:** `weelo-dlq-drainer-replay-failed`

> **Metric source:** `scripts/replay-broadcast-dlq.ts:137` —
> `metrics.incrementCounter('broadcast_dlq_replay_failed_total', { reason })`.
> Verified to exist at HEAD `d97b5907`.

**Why supplementary:** the four `setup-broadcast-p1-alarms.sh` script alarms
only watch *depth*. They do not catch a drainer that is making progress on
the queue but every replay is failing (e.g., upstream socket adapter sustained
outage, malformed payload loop, fanout target unavailable). Watching
`broadcast_dlq_replay_failed_total` catches that case directly.

> **Replaces a stale alarm.** A previous version of this runbook targeted
> `dlq_drainer_last_success_ts` (a gauge that does NOT exist anywhere in the
> code at HEAD `d97b5907`; verify with
> `git show HEAD:scripts/replay-broadcast-dlq.ts | grep dlq_drainer_last_success_ts`
> — empty output). Use the replay-failure counter instead; it covers the
> "drainer not making progress" scenario via failure-rate observation.

```bash
aws cloudwatch put-metric-alarm \
  --region "${AWS_REGION:-ap-south-1}" \
  --alarm-name "weelo-dlq-drainer-replay-failed" \
  --alarm-description "[P2] Supplementary — broadcast_dlq_replay_failed_total > 5 per 5-min Sum window. Drainer is fetching entries from dlq:broadcasts but every replay is failing (sustained upstream outage, malformed payloads being looped, or fanout target unavailable). Inspect drainer logs by reason label; if Redis is healthy and errors are payload-related, the drainer auto-quarantines attempt-exhausted entries to dlq:broadcasts:permanent (see dlq_permanent_total)." \
  --namespace "Weelo/Backend" \
  --metric-name "broadcast_dlq_replay_failed_total" \
  --statistic Sum \
  --period 300 \
  --evaluation-periods 1 \
  --datapoints-to-alarm 1 \
  --threshold 5 \
  --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions "<SNS_TOPIC_ARN>"
```

**Runbook steps when firing:**

1. Pull drainer error log lines: `aws logs filter-log-events --log-group-name weelobackendtask --filter-pattern "[DLQ-Drainer]"` and group by `reason` label.
2. Common causes:
   - **Redis ECONNREFUSED/ETIMEDOUT** — ElastiCache connectivity issue; check VPC SG rules and ElastiCache status page.
   - **JSON parse error on payload** — malformed entry in `dlq:broadcasts`; use `redis-cli LRANGE dlq:broadcasts 0 9` to inspect head; the drainer will move attempt-exhausted entries to `dlq:broadcasts:permanent` automatically (counter `dlq_permanent_total` increments on quarantine).
   - **Fanout target unavailable** — socket adapter or downstream service down; check `weelo-p1-socket-adapter-down` alarm state.
3. Confirm the drainer task is running: look for `[DLQ-Drainer]` log lines in the latest log stream.
4. Check Redis leader lock: `redis-cli TTL dlq:drainer:leader` — if 0, no leader is held; restart the ECS task to force re-election.
5. If errors persist > 15 min: disable `FF_DLQ_DRAINER_ENABLED` to stop error churn and triage offline.

---

## Alarm 3 — Saturation + Failing-Drainer Composite

**Alarm name:** `weelo-dlq-broadcasts-saturation-and-failing`

This is a **composite alarm** that fires when *both* of the following are true simultaneously:
- `weelo-dlq-broadcasts-depth-saturation` (P1, ≥4500 over 60 s — created by `setup-broadcast-p1-alarms.sh`) is in ALARM, AND
- `weelo-dlq-drainer-replay-failed` (Alarm 2 above) is in ALARM

This combination indicates depth has hit the saturation gate (lTrim drop is
imminent) **and** the drainer cannot replay any of the queued entries.
Silent broadcast loss is now guaranteed unless the failure cause clears
within ~60 s — depth-saturation alone might be recoverable by scaling the
drainer, but the composite is not.

> **Replaces a stale composite.** The previous composite combined the
> depth-high alarm with a non-existent-metric alarm
> (`weelo-dlq-drainer-last-success-age` against `dlq_drainer_last_success_ts`,
> which does NOT exist in code at HEAD `d97b5907`). This version uses two
> alarms that target metrics actually emitted at HEAD: the canonical
> `-saturation` from `setup-broadcast-p1-alarms.sh` (which targets the
> sidecar gauge `dlq_broadcasts_depth`) and the new `-replay-failed`
> defined above (which targets the drainer counter
> `broadcast_dlq_replay_failed_total`).

```bash
aws cloudwatch put-composite-alarm \
  --region "${AWS_REGION:-ap-south-1}" \
  --alarm-name "weelo-dlq-broadcasts-saturation-and-failing" \
  --alarm-description "[P1] §7C 1.2 + Pillar 4 — Composite: weelo-dlq-broadcasts-depth-saturation (>=4500 / 60s) AND weelo-dlq-drainer-replay-failed BOTH in ALARM. lTrim(0,4999) drop is imminent AND the drainer cannot replay queued entries. Immediate actions: (1) check replay-failed reason label in drainer logs, (2) if Redis blip, wait for recovery; (3) if payload loop, disable FF_DLQ_DRAINER_ENABLED and triage offline; (4) if upstream fanout outage, page on-call for that subsystem." \
  --alarm-rule "ALARM(\"weelo-dlq-broadcasts-depth-saturation\") AND ALARM(\"weelo-dlq-drainer-replay-failed\")" \
  --alarm-actions "<SNS_TOPIC_ARN>"
```

> Composite alarms do not support `--treat-missing-data`. The component
> alarms govern missing-data behaviour individually (`-saturation` from
> `setup-broadcast-p1-alarms.sh` uses `notBreaching`; `-replay-failed`
> above also uses `notBreaching`).

**Runbook steps when firing:**

1. Confirm the saturation alarm details: depth is ≥ 4500 for ~60 s. lTrim drop is imminent.
2. Confirm replay-failure reason label (drainer logs `[DLQ-Drainer]`). Three buckets:
   - **Redis blip** — wait, do not flip flags.
   - **Upstream fanout outage** (socket adapter, customer broadcaster) — page the on-call for that subsystem.
   - **Payload loop** (same `messageId` failing repeatedly) — disable `FF_DLQ_DRAINER_ENABLED` to stop churn, then `LREM` the offending entry and move it to `dlq:broadcasts:permanent` manually.
3. Check Redis leader lock: `redis-cli TTL dlq:drainer:leader`. If 0, force a new ECS task launch — `aws ecs update-service --cluster weelo --service weelo-backend --force-new-deployment`.
4. If lTrim drop has already occurred (depth observed dropping below 4500 without a corresponding rise in `dlq_permanent_total` or `broadcast_dlq_replayed_total`), file a silent-loss incident and trigger the §1.3 reconciliation procedure.

---

## Alarm 4 — Inflight Depth Leak

**Alarm name:** `weelo-dlq-broadcasts-inflight-leak`

> **Metric source:** `src/shared/services/dlq-broadcasts-depth-emitter.ts:46`
> emits `dlq_broadcasts_inflight_depth` to both Prometheus and CloudWatch
> (`PutMetricData`, line 132). Pre-registered in
> `src/shared/monitoring/metrics-definitions.ts:824`. Verified at HEAD `d97b5907`.

**Why supplementary:** the script's permanent-depth alarm catches dead-letters,
but does NOT catch a drainer that is crashing **mid-cycle**, leaving entries
in the inflight list (`dlq:broadcasts:inflight`) without ever moving them
back to `dlq:broadcasts` or to `dlq:broadcasts:permanent`. A growing inflight
depth indicates a stuck drainer cycle.

> **Replaces a stale alarm.** A previous version of this runbook targeted
> `dlq_drainer_errors_total` (a counter that does NOT exist anywhere in the
> code at HEAD `d97b5907`; verify with
> `git show HEAD:scripts/replay-broadcast-dlq.ts | grep dlq_drainer_errors_total`
> — empty output). Use the inflight-depth gauge instead; it covers the
> "drainer crashing mid-cycle" scenario via direct observation. (The
> "drainer hitting errors" scenario is covered by Alarm 2 above.)

```bash
aws cloudwatch put-metric-alarm \
  --region "${AWS_REGION:-ap-south-1}" \
  --alarm-name "weelo-dlq-broadcasts-inflight-leak" \
  --alarm-description "[P2] Supplementary — dlq_broadcasts_inflight_depth > 50 for 5 consecutive 1-min datapoints (5 min sustained). Drainer is leaking entries into dlq:broadcasts:inflight without re-enqueueing or quarantining them. Likely a drainer cycle is crashing between the LMOVE-to-inflight and the LREM-from-inflight steps. Check ECS task crash loop status; restart the drainer and run scripts/replay-broadcast-dlq.ts manually with INFLIGHT_RECOVERY=true to drain the inflight backlog." \
  --namespace "Weelo/Backend" \
  --metric-name "dlq_broadcasts_inflight_depth" \
  --statistic Maximum \
  --period 60 \
  --evaluation-periods 5 \
  --datapoints-to-alarm 5 \
  --threshold 50 \
  --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions "<SNS_TOPIC_ARN>"
```

**Runbook steps when firing:**

1. Check ECS task crash status: `aws ecs describe-services --cluster weelo --services weelo-backend` and look for recent task replacements.
2. Confirm the drainer task is running: look for `[DLQ-Drainer]` log lines in the latest log stream.
3. Inspect inflight contents: `redis-cli LRANGE dlq:broadcasts:inflight 0 9` — these are entries that the drainer pulled but never finished.
4. If the drainer is healthy now but inflight remains stuck, run a one-shot recovery: temporarily set `INFLIGHT_RECOVERY=true` and execute `scripts/replay-broadcast-dlq.ts` to LMOVE inflight entries back to the active list.
5. If inflight depth keeps climbing despite restarts: disable `FF_DLQ_DRAINER_ENABLED` to stop further leaks while triage proceeds.

---

## Alarm Summary

### Drainer-Health Alarms (supplemental — created by this runbook)

| Alarm Name | Metric | Threshold | Window | treat-missing-data | Severity |
|---|---|---|---|---|---|
| `weelo-dlq-broadcasts-depth-high` | `dlq_broadcasts_depth` (Max) | >= 1000 | 2 of 2 × 5 min (10 min) | notBreaching | P2 |
| `weelo-dlq-drainer-replay-failed` | `broadcast_dlq_replay_failed_total` (Sum) | > 5 per 5 min | 1 of 1 × 5 min | notBreaching | P2 |
| `weelo-dlq-broadcasts-saturation-and-failing` | Composite of `-saturation` (script) + `-replay-failed` (above) | BOTH in ALARM | Composite (component-driven) | N/A (composite) | P1 |
| `weelo-dlq-broadcasts-inflight-leak` | `dlq_broadcasts_inflight_depth` (Max) | > 50 | 5 of 5 × 1 min (5 min) | notBreaching | P2 |

---

## Depth-Tier Alarms (§7C 1.2 canonical — created by setup-broadcast-p1-alarms.sh)

> **DEFECT F1 REMEDIATION:** This section documents the 4 canonical depth-tier alarms mandated by
> §7C 1.2 of `index-20-validated.md` (lines 3077–3091). These alarms **supplement** the 4
> drainer-health alarms above; they are not replacements. Both sets must be present.
>
> These alarms are created by running `bash scripts/monitoring/setup-broadcast-p1-alarms.sh`.
> Do NOT create them manually — the script encodes the exact thresholds verbatim.

### §7C 1.2 Alarm Definitions

| Alarm Name | Metric | Threshold | Window | Severity | Notes |
|---|---|---|---|---|---|
| `weelo-dlq-broadcasts-depth-warn` | `dlq_broadcasts_depth` (Max) | > 100 | 2 consecutive 1-min periods | P3 | First warning tier |
| `weelo-dlq-broadcasts-depth-crit` | `dlq_broadcasts_depth` (Max) | > 500 | 5 consecutive 1-min periods | P2 | Escalation tier |
| `weelo-dlq-broadcasts-depth-saturation` | `dlq_broadcasts_depth` (Max) | ≥ 4500 | 60-second period | P1 | Hard block-flip gate — do NOT flip FF_BATCH_QUEUE_DEPTH_GUARD if in ALARM |
| `weelo-dlq-broadcasts-permanent-depth-warn` | `dlq_broadcasts_permanent_depth` (Max) | > 0 | 5 consecutive 1-min periods | P2 | Any permanent DLQ entry means exhausted-retry broadcast loss |

### Apply canonical depth-tier alarms

```bash
# Creates all 4 canonical depth-tier alarms defined in §7C 1.2
bash scripts/monitoring/setup-broadcast-p1-alarms.sh
```

### Verify all 8 alarms are present (4 drainer-health + 4 depth-tier)

```bash
aws cloudwatch describe-alarms \
  --alarm-name-prefix "weelo-dlq" \
  --region "${AWS_REGION:-ap-south-1}" \
  --query 'sort_by(MetricAlarms, &AlarmName)[*].{Name:AlarmName,State:StateValue,Threshold:Threshold}' \
  --output table
```

Expected: 8 rows total — the 4 drainer-health alarms from this runbook plus the 4 depth-tier alarms from setup-broadcast-p1-alarms.sh.

---

## Alarm Correction Procedure

Use this procedure to remove a misconfigured alarm and re-apply the correct definition.

### Delete a single alarm

```bash
aws cloudwatch delete-alarms \
  --alarm-names "ALARM_NAME_HERE" \
  --region "${AWS_REGION:-ap-south-1}"
```

### Re-apply all canonical depth-tier alarms (§7C 1.2)

```bash
# Idempotent — safe to re-run; put-metric-alarm overwrites existing alarms with the same name
bash scripts/monitoring/setup-broadcast-p1-alarms.sh
```

### Re-apply drainer-health alarms (this runbook)

Re-run the four `aws cloudwatch put-metric-alarm` / `put-composite-alarm` blocks above with the correct `<SNS_TOPIC_ARN>` filled in.

### Verify alarm correctness after correction

```bash
aws cloudwatch describe-alarms \
  --alarm-name-prefix "weelo-dlq" \
  --region "${AWS_REGION:-ap-south-1}" \
  --query '[MetricAlarms[*].{Name:AlarmName,Threshold:Threshold,Period:Period,EvalPeriods:EvaluationPeriods,State:StateValue}]'
```

Cross-check the `Threshold` and `Period` values against the tables above. Any mismatch means the alarm was not re-applied correctly — delete and re-apply.

---

## Why These Thresholds (§7C 1.2 Rationale)

**Source lines:** `index-20-validated.md` §7C 1.2, offset 3077–3096.

### Alarm 1 — depth >= 1000 / 2 of 2 datapoints / 10 min

The existing tiered depth alarms (from `setup-broadcast-p1-alarms.sh`) fire at 100 (warn, 2 min) and 500 (crit, 5 min). A sustained 1000-deep backlog over 10 consecutive minutes means the drainer is *structurally* behind — not just a transient burst — and signals that the admit rate has outpaced drain capacity long enough to risk approaching the 4500-saturation gate (§7C 1.2 line 3088: `weelo-dlq-broadcasts-depth-saturation — P1, ≥4500 over 60s — HARD block-flip gate`). The 2-of-2 datapoints requirement eliminates single-sample spikes (e.g. a momentary Redis XADD pause) from generating false pages.

### Alarm 2 — replay-failed > 5 per 5 min

§7C 1.2 does not specify an explicit error-rate number, but the surrounding
context (Fix #6 / Fix #19c requiring drainer correctness) implies zero-error
tolerance during steady state. A threshold of 5 failures per 5-minute Sum
window tolerates: (a) up to ~1 transient Redis timeout retry per minute
without paging, and (b) one transient malformed-payload error per minute
without paging. At 6+ per 5 min sustained, the drainer is in a continuous
error loop — the same entry is likely being retried repeatedly without
being quarantined, constituting a live liveness failure for that message.
`treat-missing-data=notBreaching` is safe here because the absence of
counter data simply means no failures were emitted (counter started at 0
and never incremented).

> **Why this replaces a "drainer last-success age" alarm:** §7C 1.2 (line
> 3085) describes the DLQ alarms as a prerequisite gate: "This creates 4
> alarms … per the verbatim definitions in §2.1.1." The previous version
> of this alarm targeted `dlq_drainer_last_success_ts` (a heartbeat gauge
> that does not exist anywhere in the code at HEAD `d97b5907`). A
> stalled-drainer condition is now covered indirectly: a stalled drainer
> stops emitting *all* its counters, which means
> `broadcast_dlq_replay_failed_total` will not increment and the depth
> alarms (`-warn`/`-crit`/`-saturation` from
> `setup-broadcast-p1-alarms.sh`, plus Alarm 1 above) will catch the
> resulting backlog growth. If a true heartbeat is desired in future,
> add a `metrics.setGauge('dlq_drainer_heartbeat_ts', Date.now()/1000)`
> at `replay-broadcast-dlq.ts` line 150 alongside the existing
> `broadcast_dlq_depth` setGauge, mirror it via the sidecar, then
> reintroduce a heartbeat alarm.

### Alarm 3 — saturation + failing-drainer composite

§7C 1.2 (line 3091) gates the block-flip on the saturation alarm being in
OK state. The composite captures the worst case — depth at saturation
**and** the drainer cannot replay — which is a strict subset of the
saturation condition but warrants P1 severity escalation because silent
loss is now guaranteed unless the failure cause clears within 60 s. The
saturation alarm alone (without replay-failure) might still be recoverable
by scaling the drainer; the composite is not.

### Alarm 4 — inflight depth > 50 / 5 min

The drainer uses an `LMOVE` from `dlq:broadcasts` to `dlq:broadcasts:inflight`
followed by an `LREM` from `dlq:broadcasts:inflight` after replay completes
(success or attempt-exhaust). A drainer that crashes between the LMOVE and
the LREM leaks entries into the inflight list. A small steady-state depth
(0–10) is normal during a drain cycle. >50 sustained for 5 minutes indicates
the drainer is crashing mid-cycle. Threshold tuned conservatively: lower
thresholds risk false positives during high-throughput drains; higher
thresholds delay detection of a leak that compounds over time.

> **Why this replaces a "drainer error rate" alarm:** the previous
> version of this alarm targeted `dlq_drainer_errors_total` (a counter
> that does not exist anywhere in the code at HEAD `d97b5907`). The
> "drainer hitting errors" scenario is now covered by Alarm 2
> (`broadcast_dlq_replay_failed_total` is the actual emitted counter).
> The "drainer crashing mid-cycle" scenario was previously uncovered;
> Alarm 4 now explicitly catches it via the inflight-depth gauge.

---

## Verification

After running the three `put-metric-alarm` blocks (Alarms 1, 2, 4) and the
one `put-composite-alarm` block (Alarm 3), plus
`bash scripts/monitoring/setup-broadcast-p1-alarms.sh` for the canonical
depth-tier alarms:

```bash
aws cloudwatch describe-alarms \
  --alarm-name-prefix "weelo-dlq-" \
  --region "${AWS_REGION:-ap-south-1}" \
  --query '[MetricAlarms[*].{Name:AlarmName,State:StateValue}, CompositeAlarms[*].{Name:AlarmName,State:StateValue}]'
```

Expected: 8 entries total — the 4 supplementary alarms from this runbook
(`weelo-dlq-broadcasts-depth-high`, `weelo-dlq-drainer-replay-failed`,
`weelo-dlq-broadcasts-saturation-and-failing`,
`weelo-dlq-broadcasts-inflight-leak`) plus the 4 canonical depth-tier
alarms from `setup-broadcast-p1-alarms.sh`
(`weelo-dlq-broadcasts-depth-warn`/`-crit`/`-saturation`/`-permanent-depth-warn`).
All in `OK` or `INSUFFICIENT_DATA`. `INSUFFICIENT_DATA` is acceptable if
(a) the sidecar metric-emitter is not yet running (gauge alarms will
resolve to `OK` within 60 s of the first `dlq_broadcasts_depth` datapoint
arriving), or (b) the metric-filter / EMF pipeline is not yet wired
(counter alarms — Alarm 2 — sit until the pipeline ships counters).
Per §7C 1.2 line 3091: "NOT INSUFFICIENT_DATA — that means the sidecar
isn't emitting; go back to 1.1".

---

## Cross-References

- [`scripts/monitoring/setup-broadcast-p1-alarms.sh`](../scripts/monitoring/setup-broadcast-p1-alarms.sh) — creates the 4 canonical depth-tier alarms this runbook supplements (verbatim per `index-20-validated.md` §7C 1.2 / §2.1.1).
- `scripts/replay-broadcast-dlq.ts` — drainer source for `broadcast_dlq_replay_failed_total` (line 137) and the internal Prometheus-only `broadcast_dlq_depth` gauge (line 150). Verified at HEAD `d97b5907`.
- `src/shared/services/dlq-broadcasts-depth-emitter.ts` — sidecar source for the CloudWatch-mirrored gauges `dlq_broadcasts_depth`, `dlq_broadcasts_permanent_depth`, `dlq_broadcasts_inflight_depth` (every 30 s, `PutMetricData`).
- `src/shared/monitoring/metrics-definitions.ts:816–825` — pre-registered DLQ depth gauge definitions (active / permanent / inflight).
- `src/shared/services/queue.service.ts` — counter source for `dlq_pushed_total` (admit rate; multiple call sites).
