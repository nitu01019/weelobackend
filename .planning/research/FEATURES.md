# Feature Research

**Domain:** Logistics/Trucking Broadcast-Matching Platform — Broadcast Lifecycle + Infrastructure Hardening Milestone
**Researched:** 2026-02-19
**Confidence:** HIGH (product behavior derived from PRD + existing codebase; infrastructure from AWS official docs)

---

## Context

This milestone adds to a working production system. The existing codebase already has: broadcast creation, accept (with Redis lock + idempotency + serializable transactions), expiry checker (5s interval), WebSocket events, and FCM push notifications. What is missing is enforcement of business rules at the lifecycle level, cleanup correctness, and infrastructure hardening.

Research sources: PRD (`DRIVER_ONLINE_BROADCAST_SEARCH_PRD.md`), existing `broadcast.service.ts`, Prisma schema, AWS official docs, and web research on Secrets Manager + GitHub Actions CI/CD patterns.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features the system must have. Missing any of these = the product is broken in a visible way.

#### Domain 1: Broadcast Lifecycle Management

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| One-active-broadcast-per-customer enforcement | PRD §7.1: "one customer can have only one Active Broadcast at a time"; without this, duplicate broadcasts confuse transporters and leave ghost state | MEDIUM | Needs atomic check-and-create: query active broadcast in DB, reject or cancel before creating new. Naive check-then-create has a race condition — must use DB transaction or Redis lock keyed on `customer:{id}:active_broadcast` |
| Broadcast lifecycle state machine (Created → Broadcasting → Awaiting → Terminal) | PRD §7.3 defines four stages; existing `BookingStatus` enum has the terminal states but no intermediate Broadcasting/Awaiting states; Captain App expects consistent states | MEDIUM | Current `OrderStatus` has `active / partially_filled / fully_filled / in_progress / completed / cancelled / expired`. Need to decide if broadcasting/awaiting are UI-only or DB-persisted states. Low risk to add as DB states if Prisma migration is planned. |
| Exactly-one-winner rule | PRD §7.4: at most one transporter wins a broadcast; existing code has serializable-isolation optimistic lock with `trucksFilled` CAS already; but the "already accepted" UI response is not standardized | LOW | Existing code (`BROADCAST_FILLED` error code) handles this at DB level. Gap: the API response and Captain App UI path for "this request is no longer available" needs to be defined contractually. |
| Terminal state cleanup — remove from transporter active list | PRD §9: after cancel/expire/accept, transporters must not see the broadcast as actionable; existing `emitBroadcastExpired` covers this via WebSocket but only for expiry — cancel path is missing | MEDIUM | The `declineBroadcast` method currently does nothing but log. Cancel broadcast endpoint needs to: (a) update DB status to `cancelled`, (b) call `emitBroadcastExpired(id, 'cancelled')`, (c) release any Redis keys. |
| Customer unblocked after terminal state | PRD §8.4: customer can search again only after previous broadcast reaches terminal state; currently no guard exists in `createBroadcast` | MEDIUM | On each new search request: check DB for `status IN (active, partially_filled)` for this `customerId`. If found, reject with clear error. |

#### Domain 2: Search Cancel / Timeout Cleanup

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Customer-initiated cancel produces full cleanup | PRD §8.2: after cancel, customer must be able to start a brand-new search immediately; transporters must not see it | MEDIUM | Current `declineBroadcast` is driver-side only and does nothing. A separate customer-facing `cancelBroadcast(customerId, broadcastId)` endpoint is needed. Must: (1) validate customer owns the broadcast, (2) update DB to `cancelled`, (3) emit `broadcast_cancelled` to all transporters, (4) push FCM to customer confirming cancel. |
| Timeout cleanup runs for all terminal paths | PRD §9: "any temporary matching/shortlists created for that broadcast must be removed." Existing expiry checker runs every 5s. But Redis keys (`broadcast:active:{customerId}`, `idem:broadcast:*`) are not cleaned on expiry. | MEDIUM | Add cleanup logic to `checkAndExpireBroadcasts`: delete `customer:{id}:active_broadcast` Redis key and relevant idempotency keys when a broadcast transitions to any terminal state. |
| Customer sees actionable response on timeout | PRD §8.3: customer sees "No transporters found / Request expired" with "Try again" and "Edit details" options; requires both a push notification and WebSocket event with enough data for the UI | LOW | Existing `notifyCustomerBroadcastExpired` covers WebSocket + FCM. Gap: the FCM payload does not include `suggestedAction: 'retry' | 'edit'` — add this to unlock the app UI. |
| Idempotent search initiation (double-tap protection) | PRD §8.5: if customer taps Search twice quickly, system must treat it as one broadcast; existing `acceptBroadcast` has idempotency via `idempotencyKey`, but `createBroadcast` (search initiation) has no idempotency guard | MEDIUM | On the create-broadcast path: accept a client-supplied `idempotencyKey` and cache the result in Redis with TTL 30s. Second identical request within 30s returns the cached broadcast. Requires: Redis key `idem:broadcast:create:{customerId}:{key}`. |
| Race-safe cancel vs. accept (edge case §11.4) | PRD §11.4: if transporter accepts exactly as customer cancels, exactly one outcome wins; existing serializable transaction on accept handles the DB side; cancel must also be inside a transaction | HIGH | Cancel must do: `UPDATE bookings SET status='cancelled' WHERE id=? AND status IN ('active','partially_filled') RETURNING *` — if 0 rows updated, the accept won; respond accordingly. Do not use two separate reads. Complexity is high because notification fanout must also be coordinated. |

#### Domain 3: Driver Online/Offline Visibility (Transporter Side)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Real-time driver status update to transporter | PRD §6.2: when driver goes online/offline, transporter sees the update without refresh | LOW | Redis presence model is already implemented. Gap: the WebSocket event `driver_status_changed` must be emitted to the transporter's room (not just stored in Redis) when a driver toggles. This is a single `emitToUser(transporterId, 'driver_status_changed', payload)` call. |
| Driver status reflected in broadcast eligibility | PRD §6.3: driver availability must be consistent between driver view, transporter view, and matching logic | LOW | Existing Redis `online:transporters` set drives broadcast targeting. Driver presence TTL (2-min threshold) is already enforced. No additional feature needed; just confirm the online/offline toggle hits the Redis set correctly. |

#### Domain 4: AWS Secrets Manager Migration

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| All secrets moved from ECS env vars to Secrets Manager | Known issue in `PROJECT.md`: "Secrets stored as plain-text ECS environment variables"; this is a security requirement, not an enhancement | MEDIUM | Create one Secrets Manager secret (JSON blob or per-secret) for: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `FCM_SERVER_KEY`, SNS credentials. Update ECS task definition to reference secrets via `secrets` parameter. Requires: `secretsmanager:GetSecretValue` on task execution role (HIGH confidence — AWS official docs). |
| Task execution role has correct IAM permissions | Secrets Manager injection at container startup requires `ecsTaskExecutionRole` to have `secretsmanager:GetSecretValue` | LOW | Single IAM policy statement. The existing `ecsTaskExecutionRole` already has SNS publish; add Secrets Manager. |
| Force-new-deployment on secret rotation | When a secret value changes, ECS tasks must be redeployed to pick up the new value (AWS docs: secrets are injected at startup, not runtime) | LOW | Document as operational runbook item. Can be automated via CI/CD pipeline step on secret change event. |

#### Domain 5: GitHub Actions CI/CD Pipeline

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Automated build + push to ECR on merge to main | Currently all deployments are manual `docker buildx build` commands; this is error-prone and requires developer machines | MEDIUM | Standard GitHub Actions workflow: checkout → `aws-actions/configure-aws-credentials` (OIDC) → `aws-actions/amazon-ecr-login` → `docker buildx build --platform linux/amd64` → `docker push` → `aws-actions/amazon-ecs-render-task-definition` → `aws-actions/amazon-ecs-deploy-task-definition`. OIDC eliminates stored AWS credentials (HIGH confidence from multiple sources). |
| Build must use `--platform linux/amd64 --target production --no-cache` | Documented in `AGENTS.md` as mandatory flags; CI runners are Linux/amd64 so `--platform` is actually consistent, but `--target production` and `--no-cache` remain critical | LOW | Bake these flags into the workflow. Add as a comment explaining why, referencing AGENTS.md. |
| OIDC-based AWS auth (no long-lived keys in GitHub Secrets) | Current approach (if any) stores keys; OIDC is the AWS-recommended approach from 2022+ | LOW | Requires: GitHub OIDC provider in AWS IAM, IAM role with trust policy for `token.actions.githubusercontent.com`, `id-token: write` permission in workflow. |
| Run tests before deploy | Any CI/CD pipeline that deploys without testing is fragile | MEDIUM | The project has Jest config (`jest.config.js`) and `__tests__` directories. Add `npm test` step before build. If tests are sparse, this still catches compile errors via TypeScript. |

#### Domain 6: RDS Hardening

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Deletion protection enabled | Without deletion protection, the production DB can be accidentally deleted by an AWS console action or CLI command; this is table stakes for any production RDS | LOW | `aws rds modify-db-instance --db-instance-identifier weelodb --deletion-protection` — one CLI command. Current instance is `db.t3.micro`. No downtime. |
| Backup retention >= 7 days | Current: 1-day backup retention (from `PROJECT.md`). PRD defines "production ready." 7 days is the minimum for any meaningful point-in-time recovery window | LOW | `aws rds modify-db-instance --backup-retention-period 7`. AWS docs: backup retention is 0-35 days; 0 disables backups. 7 days enables PITR within a 7-day window without significant storage cost increase (HIGH confidence — official AWS docs). |
| Multi-AZ enabled | Current: single-AZ. Without Multi-AZ, an AZ failure means DB downtime of 20-30 minutes until RDS fails over manually. With Multi-AZ, automatic failover in 60-120 seconds | MEDIUM | `aws rds modify-db-instance --multi-az`. This causes a brief I/O freeze during snapshot creation for the standby. Schedule during low traffic. Note: `db.t3.micro` supports Multi-AZ. The standby replica doubles effective RDS cost but is non-negotiable for production. |
| Backup window outside peak hours | Automated backups during peak traffic cause I/O impact; backup window should be set to low-traffic hours (e.g., 02:00-03:00 UTC for India-based traffic) | LOW | `--backup-window "20:30-21:30"` (UTC, which is 02:00-03:00 IST). One-time config. |

---

### Differentiators (Competitive Advantage)

Features that would make the Weelo platform stand out. Not required for this milestone but worth noting for future roadmap.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Broadcast history for customer | Customer can see all past broadcasts (accepted, cancelled, expired) with timestamps; helps build trust; PRD §13 lists this as open question | MEDIUM | Requires `GET /broadcasts/history` endpoint filtering by `customerId`. Schema already stores all terminal states with timestamps. |
| Broadcast history for transporter | Transporter can see all broadcasts they received and their outcomes; PRD §13 | MEDIUM | Requires filtering assignments + bookings by `transporterId`. Enables transporters to track their acceptance rate. |
| Dynamic broadcast timeout (configurable per search) | Current code hardcodes 2-hour expiry; real-world logistics platforms use 30-120s for on-demand, longer for scheduled | LOW | Add `broadcastTimeoutSeconds` as a config value (env var) rather than hardcoded. Allows product team to tune without code change. PRD §13 Q2: 30s / 60s / 120s timeout — this makes it configurable. |
| Auto-cancel previous broadcast on new search | PRD §13 Q1: "block or auto-cancel previous?" — auto-cancel provides better UX (no manual cancel step) | MEDIUM | Instead of rejecting a new search when one is active, automatically transition the previous broadcast to `cancelled` (with full cleanup) then create the new one. Riskier: transporter who was about to accept gets cancelled without warning. Recommend: block by default, add auto-cancel as opt-in later. |
| Transporter sees truck count live-updating | When another transporter accepts trucks, remaining count decreases in real-time; already implemented via `TRUCKS_REMAINING_UPDATE` event | LOW | Already built. Differentiator over email/SMS-based logistics platforms. No additional work. |
| Driver visibility badge on assignment screen | Transporter sees "Online" / "Offline" / "On Trip" badge next to each driver when selecting for assignment | LOW | Requires reading Redis presence keys during driver list fetch. Adds context so transporters don't assign offline drivers. |

---

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem like good ideas but create more problems than they solve for this milestone.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Real-time DB polling for broadcast state | "Just poll the DB every second for state changes" — seems simple | Polling at scale creates thundering herd on RDS. With 100 concurrent broadcasts × 10 transporters each = 1000 DB queries/second. Already solved: WebSocket push model is correct. | Stick with WebSocket push + Redis pub/sub. Only poll DB as fallback on reconnect. |
| Store AWS secrets in GitHub Secrets as plaintext | "Just put DATABASE_URL in GitHub Secrets, it's fine" | GitHub Secrets are environment-scoped but cannot be rotated independently, audited centrally, or auto-rotated. Violates AWS security best practices. | Use GitHub Secrets only for the IAM role ARN and OIDC configuration; all application secrets go to Secrets Manager. |
| Multi-AZ for ElastiCache (Redis) this milestone | Redis HA sounds important — add it too | ElastiCache Serverless (already deployed) has automatic availability built in; adding explicit Multi-AZ configuration is redundant and not available in serverless mode | ElastiCache Serverless already handles availability. No additional config needed. |
| Broadcast retry / re-broadcast from backend | "If no one accepts in 60s, automatically re-broadcast" | Complex state management: when does re-broadcast stop? Creates duplicate broadcasts. Customer expects to control retry. | On timeout, notify customer with "Try again" action. Customer controls the retry decision. |
| WAF on ALB this milestone | Security hardening sounds related | Requires HTTPS/domain first; current ALB is HTTP-only; WAF without HTTPS provides minimal real security gain. Out of scope per PROJECT.md. | Defer WAF until HTTPS/domain milestone. |
| Broadcast payment processing | "Charge the customer when transporter accepts" | Requires payment gateway integration, refund logic, dispute handling — entirely separate domain from broadcast lifecycle | Keep pricing calculation on backend (already done); payment is a separate future milestone. |

---

## Feature Dependencies

```
[One-active-broadcast enforcement]
    └──requires──> [Cancel broadcast endpoint] (need to cancel-then-create OR block)
                       └──requires──> [Full cleanup on cancel] (DB update + Redis + WebSocket fanout)
                                          └──requires──> [Terminal state cleanup logic] (reusable across cancel/timeout/accept)

[Idempotent search initiation]
    └──requires──> [Redis idempotency key on create] (TTL 30s, keyed on customerId + clientKey)

[Exactly-one-winner on race (cancel vs accept)]
    └──requires──> [Cancel in DB transaction] (UPDATE WHERE status IN active/partially_filled)
    └──requires──> [Accept in DB transaction] (already implemented, serializable isolation)

[GitHub Actions CI/CD]
    └──requires──> [OIDC IAM role in AWS] (prerequisite: create role + trust policy)
    └──requires──> [Secrets Manager migration] (secrets must exist before pipeline references them)
    └──enhances──> [RDS hardening] (can run `aws rds modify-db-instance` as pipeline step)

[RDS Multi-AZ]
    └──requires──> [Backup retention >= 1 day] (Multi-AZ requires automated backups enabled)
    └──conflicts──> [Enabling during peak traffic] (brief I/O freeze — schedule off-peak)

[Secrets Manager migration]
    └──requires──> [Task execution role IAM update] (add secretsmanager:GetSecretValue)
    └──requires──> [ECS task definition update] (change env vars to secrets references)
    └──requires──> [Force-new-deployment] (new tasks pick up Secrets Manager injection)

[Driver status real-time to transporter]
    └──requires──> [WebSocket emit on toggle] (already have Redis presence; just need emit)
```

### Dependency Notes

- **Cancel requires cleanup before new search:** The one-active-broadcast enforcement and the cancel endpoint are co-dependent. Build cancel first, then enforcement is straightforward (cancel → create is also a path).
- **Secrets Manager before CI/CD:** The pipeline workflow file should reference secrets from Secrets Manager, not GitHub Secrets for app credentials. Secrets Manager migration unlocks a clean CI/CD config.
- **RDS Multi-AZ requires backup retention >= 1:** AWS enforces this. Cannot enable Multi-AZ if automated backups are disabled (retention = 0). Enable backup retention first.
- **OIDC before pipeline:** GitHub Actions OIDC requires an IAM role ARN to exist in AWS before the workflow file can be written.

---

## MVP Definition

This is a subsequent milestone on a production system. "MVP" here means: minimum to ship this milestone safely.

### Launch With (Milestone v1 — must ship)

- [ ] One-active-broadcast-per-customer enforcement — core business rule, without it customers create ghost duplicates
- [ ] Cancel broadcast endpoint with full cleanup — required for the enforcement to be usable (can't block without cancel)
- [ ] Terminal state cleanup (Redis key removal + WebSocket fanout) — prevents ghost requests on transporter side
- [ ] Idempotent search initiation — prevents double-tap duplicates; required for mobile reliability
- [ ] Race-safe cancel vs. accept (DB transaction) — correctness requirement; without this, two parties get conflicting outcomes
- [ ] Driver status real-time emit to transporter — currently broken per PROJECT.md Active items
- [ ] Secrets Manager migration — security baseline; plain-text ECS env vars are the known issue
- [ ] Task execution IAM role update — prerequisite for Secrets Manager
- [ ] GitHub Actions workflow: build + push + deploy — replaces manual deploy process
- [ ] OIDC IAM role setup — prerequisite for GitHub Actions
- [ ] RDS deletion protection — one CLI command, prevents catastrophic data loss
- [ ] RDS backup retention set to 7 days — one CLI command, extends recovery window
- [ ] RDS Multi-AZ enable — eliminates single-AZ risk; schedule off-peak

### Add After Validation (v1.x — after milestone ships)

- [ ] Auto-cancel previous broadcast on new search — depends on product decision (PRD §13 Q1); add after observing user behavior with the block behavior
- [ ] Broadcast history endpoints for customer + transporter — depends on product decision (PRD §13 Q4)
- [ ] Dynamic broadcast timeout (configurable via env var) — after product decides on duration (PRD §13 Q2)
- [ ] `npm test` in CI/CD before deploy — add once test coverage is meaningful; currently may have sparse tests

### Future Consideration (v2+)

- [ ] WAF on ALB — deferred until HTTPS/domain is set up (per PROJECT.md Out of Scope)
- [ ] ElastiCache Multi-AZ explicit config — ElastiCache Serverless already handles availability
- [ ] Payment integration on broadcast accept — separate domain/milestone
- [ ] Broadcast re-broadcast / auto-retry from backend — complex state management; customer-controlled retry is simpler

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| One-active-broadcast enforcement | HIGH | MEDIUM | P1 |
| Cancel broadcast with full cleanup | HIGH | MEDIUM | P1 |
| Race-safe cancel vs. accept | HIGH | HIGH | P1 |
| Idempotent search initiation | HIGH | MEDIUM | P1 |
| Driver status real-time to transporter | HIGH | LOW | P1 |
| Terminal state cleanup (Redis + WebSocket) | HIGH | MEDIUM | P1 |
| Secrets Manager migration | HIGH | MEDIUM | P1 |
| GitHub Actions CI/CD pipeline | HIGH | MEDIUM | P1 |
| RDS deletion protection | HIGH | LOW | P1 |
| RDS backup retention (7 days) | HIGH | LOW | P1 |
| RDS Multi-AZ | HIGH | MEDIUM | P1 |
| Broadcast lifecycle state machine in DB | MEDIUM | MEDIUM | P2 |
| Broadcast history endpoints | MEDIUM | MEDIUM | P2 |
| Dynamic broadcast timeout | LOW | LOW | P2 |
| Auto-cancel previous on new search | MEDIUM | MEDIUM | P2 |
| WAF on ALB | MEDIUM | HIGH | P3 |
| ElastiCache explicit HA config | LOW | LOW | P3 |

**Priority key:**
- P1: Must have for this milestone
- P2: Should have, add after core is stable
- P3: Nice to have, future milestone

---

## Competitor Feature Analysis

| Feature | Rapido/Uber Freight (ride-hailing) | Transporeon / Convoy (freight marketplace) | Weelo Approach |
|---------|-------------------------------------|---------------------------------------------|----------------|
| One-active-request per user | YES — driver/rider both have one active ride at a time | YES — one active load per carrier | Block new search if one active; cancel-first pattern |
| Broadcast lifecycle states | CREATED → DISPATCHING → MATCHED → CANCELLED/EXPIRED | REQUEST → BIDDING → AWARDED → DELIVERED | Add Broadcasting/Awaiting as intermediate states or keep as UI-only via WebSocket events |
| Timeout cleanup | Automatic — 30-120s timeout, instant cleanup | Varies — 24-72h for freight RFQ | Polling-based cleanup every 5s already exists; add Redis cleanup on transition |
| Idempotency on request | YES — deduplication key per request | YES — idempotency on tender | Add `idempotencyKey` to create-broadcast path (already on accept-broadcast) |
| Secrets in CI/CD | OIDC or vault integration | Enterprise secret management | AWS Secrets Manager + GitHub OIDC |
| DB high availability | Multi-region / Multi-AZ | Enterprise HA | Multi-AZ on existing db.t3.micro |

---

## Sources

- Weelo PRD: `/Users/nitishbhardwaj/Desktop/DRIVER_ONLINE_BROADCAST_SEARCH_PRD.md` — non-technical product requirements (HIGH confidence — primary source)
- Existing broadcast service: `src/modules/broadcast/broadcast.service.ts` — existing implementation (HIGH confidence — source code)
- Prisma schema: `prisma/schema.prisma` — data model (HIGH confidence — source code)
- PROJECT.md: `.planning/PROJECT.md` — known issues and active requirements (HIGH confidence — primary source)
- AWS official docs: [Secrets Management in ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security-secrets-management.html) — Secrets Manager injection at container startup (HIGH confidence)
- AWS official docs: [RDS Backup Retention](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html) — backup retention 0-35 days, Multi-AZ requires backups enabled (HIGH confidence)
- GitHub Actions ECS pattern: [Cloud Tech Simplified — CI/CD for Fargate](https://www.cloudtechsimplified.com/ci-cd-pipeline-aws-fargate-github-actions-nodejs/) — OIDC + six-step workflow (MEDIUM confidence — verified against AWS docs)
- AWS Security Blog: [IAM roles for GitHub Actions](https://aws.amazon.com/blogs/security/use-iam-roles-to-connect-github-actions-to-actions-in-aws/) — OIDC is AWS-recommended approach (HIGH confidence)
- RDS Multi-AZ guide: [OneUptime — Enable RDS Multi-AZ](https://oneuptime.com/blog/post/2026-02-12-enable-rds-multi-az-high-availability/view) — online conversion, brief I/O freeze (MEDIUM confidence)
- Distributed systems patterns: [InfoQ — Timeouts, Retries and Idempotency](https://www.infoq.com/presentations/distributed-systems-resiliency/) — idempotency key patterns (MEDIUM confidence)

---

*Feature research for: Weelo logistics broadcast platform — broadcast lifecycle + infrastructure hardening milestone*
*Researched: 2026-02-19*
