# HPA Cap Runbook — ECS MaxCapacity=5

**Scope:** AWS Application Auto Scaling for the Weelo backend ECS service.
**Owner:** Platform / SRE
**Last reviewed:** 2026-05-08

---

## Why

The decision to cap ECS pods at **MaxCapacity=5** is gated by the headroom available on the RDS instance.

Per §7C 0.5 of the validated index (lines 3030-3049):

> Option A (MaxCapacity=5) on **db.r6g.xlarge** → 54.5% utilization at peak, 45% headroom.
> Option B (MaxCapacity=4) is the fallback reserved exclusively for db.r6g.large.

Running more than 5 pods against db.r6g.xlarge would push RDS CPU/connection utilization above the safe operating threshold and risk query saturation at peak. If the cluster is ever downgraded back to db.r6g.large, MaxCapacity must be reduced to 4 before increasing traffic.

The scalable-target lives in **AWS Application Auto Scaling** (ECS-side, target-tracking policy) — it is NOT encoded in this repository's source tree.

---

## Current State

Run the following command to confirm the live cap before making any change:

```bash
aws application-autoscaling describe-scalable-targets \
  --service-namespace ecs \
  --resource-ids "service/${ECS_CLUSTER}/${ECS_SERVICE}" \
  --region "${AWS_REGION}" \
  --query 'ScalableTargets[0].{Min:MinCapacity,Max:MaxCapacity}' \
  --output table
```

Expected output after this runbook is applied:

```
-----------------
|  Min  |  Max  |
-----------------
|   2   |   5   |
-----------------
```

If Max is currently 4, the service is still capped at the db.r6g.large limit and must be updated (see Execution below). If Max is already 5, no action is required.

Required environment variables:

| Variable | Where to find it |
|---|---|
| `ECS_CLUSTER` | AWS Console → ECS → Clusters, or `aws ecs list-clusters` |
| `ECS_SERVICE` | AWS Console → ECS → Cluster → Services |
| `AWS_REGION` | Typically `ap-south-1` for Weelo production |

---

## Execution

Apply MaxCapacity=5 with the following command. Substitute the actual cluster and service names:

```bash
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --resource-id "service/${ECS_CLUSTER}/${ECS_SERVICE}" \
  --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 2 \
  --max-capacity 5 \
  --region "${AWS_REGION}"
```

`register-scalable-target` is idempotent — running it again with the same values is safe. The command updates the existing target if one already exists.

---

## Verification

Re-run describe-scalable-targets and confirm Min=2 / Max=5:

```bash
aws application-autoscaling describe-scalable-targets \
  --service-namespace ecs \
  --resource-ids "service/${ECS_CLUSTER}/${ECS_SERVICE}" \
  --region "${AWS_REGION}" \
  --query 'ScalableTargets[0].{Min:MinCapacity,Max:MaxCapacity}' \
  --output table
```

Also confirm the target-tracking scaling policy still references the correct metric (e.g. ECSServiceAverageCPUUtilization or ALBRequestCountPerTarget) and that its target value is unchanged:

```bash
aws application-autoscaling describe-scaling-policies \
  --service-namespace ecs \
  --resource-id "service/${ECS_CLUSTER}/${ECS_SERVICE}" \
  --region "${AWS_REGION}" \
  --output json
```

---

## IaC Drift Prevention

If the project maintains a separate Infrastructure-as-Code repository (Terraform, AWS CDK, CloudFormation, Pulumi, etc.) that defines the `aws_appautoscaling_target` or equivalent resource, that file **must receive the same change** (max_capacity = 5) before or alongside this manual step. Failing to update IaC means the next `terraform apply` / `cdk deploy` will silently revert MaxCapacity to its old value.

Steps:
1. Search the IaC repo for `register-scalable-target`, `aws_appautoscaling_target`, or `ApplicationAutoScaling::ScalableTarget`.
2. Update `max_capacity` / `MaxCapacity` to `5`.
3. Open a PR and have it merged before the next planned infrastructure deployment.

Note: the original §7C 0.5 review deducted 2% confidence specifically because IaC drift was not confirmed at review time.

---

## Rollback

To revert to the previous MaxCapacity, re-run the register command with the old value. Example rollback to MaxCapacity=4:

```bash
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --resource-id "service/${ECS_CLUSTER}/${ECS_SERVICE}" \
  --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 2 \
  --max-capacity 4 \
  --region "${AWS_REGION}"
```

Verify with describe-scalable-targets as shown in the Verification section.

**When to rollback:** If RDS CPU exceeds 80% sustained after raising the cap, or if the db.r6g.xlarge instance is replaced with db.r6g.large, reduce MaxCapacity to 4 immediately.
