# Worker Ramp Soak Dashboard

Operator reference for monitoring the ECS worker task-count ramp during soak testing.
Covers the CloudWatch dashboard definition, import procedure, alert escalation, and abort criteria.

---

## CloudWatch Dashboard JSON

Save the block below as `dashboard.json`, then import per the instructions in the next section.

```json
{
  "widgets": [
    {
      "type": "metric",
      "x": 0,
      "y": 0,
      "width": 24,
      "height": 6,
      "properties": {
        "title": "RDS DatabaseConnections (70% gate per §1.2 Step 5)",
        "view": "timeSeries",
        "stacked": false,
        "stat": "Maximum",
        "period": 60,
        "metrics": [
          [
            "AWS/RDS",
            "DatabaseConnections",
            "DBInstanceIdentifier",
            "weelo-prod"
          ]
        ],
        "annotations": {
          "horizontal": [
            {
              "label": "SLO ceiling — Option A r6g.xlarge (2240 / 3201 = 70%)",
              "value": 2240,
              "color": "#ff0000"
            },
            {
              "label": "SLO ceiling — Option B r6g.large (1120 / 1600 = 70%)",
              "value": 1120,
              "color": "#ff9900"
            }
          ]
        },
        "yAxis": {
          "left": {
            "min": 0,
            "label": "connections"
          }
        }
      }
    },
    {
      "type": "metric",
      "x": 0,
      "y": 6,
      "width": 24,
      "height": 6,
      "properties": {
        "title": "pool_wait_seconds p99 — primary ramp gate (§4.4 line 2221)",
        "view": "timeSeries",
        "stacked": false,
        "stat": "p99",
        "period": 60,
        "metrics": [
          [
            "Weelo/Backend",
            "pool_wait_seconds",
            { "label": "p99 (s)" }
          ]
        ],
        "annotations": {
          "horizontal": [
            {
              "label": "SLO ceiling (0.050 s = 50 ms)",
              "value": 0.05,
              "color": "#ff0000"
            }
          ]
        },
        "yAxis": {
          "left": {
            "min": 0,
            "label": "seconds"
          }
        }
      }
    },
    {
      "type": "metric",
      "x": 0,
      "y": 12,
      "width": 24,
      "height": 6,
      "properties": {
        "title": "hold_cas_conflict_total — rate/min",
        "view": "timeSeries",
        "stacked": false,
        "stat": "Sum",
        "period": 60,
        "metrics": [
          [
            "Weelo/Backend",
            "hold_cas_conflict_total",
            { "label": "conflicts/min" }
          ]
        ],
        "annotations": {
          "horizontal": [
            {
              "label": "2× baseline alert",
              "value": "__REPLACE_WITH_2X_BASELINE__",
              "color": "#ff9900"
            }
          ]
        },
        "yAxis": {
          "left": {
            "min": 0,
            "label": "count / min"
          }
        }
      }
    }
  ]
}
```

> **Baseline placeholder:** Before running soak, query the current 7-day average rate for
> `hold_cas_conflict_total` (e.g. via `aws cloudwatch get-metric-statistics`) and replace
> `__REPLACE_WITH_2X_BASELINE__` with twice that value.

---

## How to Import

```bash
# 1. Set the baseline value in dashboard.json (see note above), then:

aws cloudwatch put-dashboard \
  --dashboard-name weelo-worker-ramp-soak \
  --dashboard-body file://dashboard.json \
  --region ap-south-1
```

Open the dashboard in the AWS Console:

```
https://ap-south-1.console.aws.amazon.com/cloudwatch/home#dashboards:name=weelo-worker-ramp-soak
```

Pin all three widgets to **1-minute** granularity so anomalies surface immediately during the ramp.

---

## Widget Summary

| # | Widget | Namespace | Stat | Alert line |
|---|--------|-----------|------|------------|
| 1 | RDS DatabaseConnections | `AWS/RDS` | Maximum, 1 min | Option A: 2240 / 3201 (70%) on db.r6g.xlarge · Option B: 1120 / 1600 (70%) on db.r6g.large |
| 2 | pool_wait_seconds p99 | `Weelo/Backend` | p99, 1 min | **50 ms** (§4.4 line 2221 — primary ramp gate) |
| 3 | hold_cas_conflict_total rate | `Weelo/Backend` | Sum/min, 1 min | 2× pre-soak 7-day average |

> **Sizing decision dependency.** Widget 1's alert line depends on the §1.2 Step 4 RDS sizing decision (Option A db.r6g.xlarge vs Option B db.r6g.large + HPA Max=4). Confirm which option is in production before importing the dashboard, and delete the unused annotation row from `dashboard.json`.

---

## Alert Escalation

All three SLO metrics must be wired to a CloudWatch Alarm → SNS → PagerDuty integration.

### Alarm creation (repeat for each metric)

```bash
# Example: RDS connections alarm — set --threshold per §1.2 Step 4 sizing option
# Option A db.r6g.xlarge: 2240 (70% of 3201)
# Option B db.r6g.large + HPA Max=4: 1120 (70% of 1600)
aws cloudwatch put-metric-alarm \
  --alarm-name "weelo-soak-rds-connections-breach" \
  --alarm-description "RDS connections exceeded soak SLO ceiling (70% of max_connections) for 2 consecutive minutes" \
  --metric-name DatabaseConnections \
  --namespace AWS/RDS \
  --dimensions Name=DBInstanceIdentifier,Value=weelo-prod \
  --statistic Maximum \
  --period 60 \
  --evaluation-periods 2 \
  --threshold 2240 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --alarm-actions arn:aws:sns:ap-south-1:<ACCOUNT_ID>:weelo-pagerduty-p1 \
  --region ap-south-1

# pool_wait_seconds p99 alarm — primary ramp gate (§4.4 line 2221)
aws cloudwatch put-metric-alarm \
  --alarm-name "weelo-soak-pool-wait-p99-breach" \
  --alarm-description "Prisma pool_wait_seconds p99 exceeded 50ms for 2 consecutive minutes — pool saturation imminent" \
  --metric-name pool_wait_seconds \
  --namespace Weelo/Backend \
  --extended-statistic p99 \
  --period 60 \
  --evaluation-periods 2 \
  --threshold 0.05 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --alarm-actions arn:aws:sns:ap-south-1:<ACCOUNT_ID>:weelo-pagerduty-p1 \
  --region ap-south-1
```

Repeat with appropriate `--metric-name`, `--namespace`, and `--threshold` values for the third alarm (`hold_cas_conflict_total`).

### Escalation behaviour

| Condition | Alarm state | Action |
|-----------|-------------|--------|
| SLO metric ≥ threshold for **1 minute** | `ALARM` | CloudWatch Alarm fires; SNS publishes to PagerDuty topic |
| SLO metric ≥ threshold for **2 minutes** | sustained `ALARM` | PagerDuty opens **P1** incident with description `weelo-worker-ramp-soak SLO breach — <metric>` |
| Metric recovers below threshold for 2 consecutive periods | `OK` | PagerDuty auto-resolves the incident |

PagerDuty integration key lives in AWS Secrets Manager under `weelo/pagerduty/integration-key`.
The SNS topic `weelo-pagerduty-p1` must be subscribed to the HTTPS endpoint provided by PagerDuty's CloudWatch integration.

---

## Abort Signal — Operator Checklist

If **any** SLO breach is sustained for more than 2 minutes, the operator must:

1. **Stop the ramp immediately.** Do not increase worker task count further.

2. **Roll back the task definition** to the previous revision:

   ```bash
   # Identify the previous revision number
   aws ecs describe-task-definition \
     --task-definition weelo-worker \
     --region ap-south-1 \
     --query 'taskDefinition.revision'

   # Update the service to the previous revision (N-1)
   aws ecs update-service \
     --cluster weelo-prod \
     --service weelo-worker \
     --task-definition weelo-worker:<PREVIOUS_REVISION> \
     --region ap-south-1
   ```

3. **Confirm stabilisation.** Wait until all three dashboard widgets return below their alert lines for at least 5 consecutive minutes before declaring the rollback complete.

4. **File a post-mortem ticket** capturing: breach metric, breach duration, worker count at time of breach, and the task-def revision rolled back to.

5. **Do not re-attempt the ramp** until the post-mortem root cause is resolved and signed off by the on-call engineer.

---

## Quick Reference

| SLO | Threshold | Breach window before PD P1 |
|-----|-----------|---------------------------|
| RDS DatabaseConnections | ≤ 2,240 / 3,201 = 70% (Option A db.r6g.xlarge) | 2 min |
| pool_wait_seconds p99 | ≤ 50 ms (§4.4 primary ramp gate) | 2 min |
| hold_cas_conflict_total | 2× baseline rate/min | 2 min |
