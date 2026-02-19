# Roadmap: Weelo

## Overview

This milestone hardens a production logistics backend that already runs but has correctness gaps that can corrupt bookings under concurrent load. The work proceeds in strict dependency order: fix the broadcast state machine and atomic acceptance logic first (bugs that can produce bad data), then centralize cleanup and timer logic so deployments do not orphan Redis state, then migrate secrets and database infrastructure, then wire up CI/CD and the driver visibility fix. Infrastructure cannot be safely redeployed until correctness is guaranteed; CI/CD cannot reference secrets correctly until Secrets Manager is in place.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Broadcast Lifecycle Correctness** - Fix the two data-corruption bugs: atomic TruckRequest acceptance and one-active-broadcast-per-customer enforcement, plus idempotent search and race-safe cancel
- [ ] **Phase 2: Cancel and Timeout Cleanup Hardening** - Unify timer logic, harden all terminal-state cleanup paths, eliminate orphaned Redis state and in-memory intervals across ECS deployments
- [ ] **Phase 3: AWS Infrastructure Hardening** - Migrate secrets to Secrets Manager, install Socket.IO Redis adapter, harden RDS (deletion protection, 7-day backups, Multi-AZ)
- [ ] **Phase 4: CI/CD Pipeline and Driver Visibility** - OIDC-based GitHub Actions pipeline replacing manual deploys, plus real-time driver online/offline visibility for transporters

## Phase Details

### Phase 1: Broadcast Lifecycle Correctness
**Goal**: The broadcast state machine is correct and safe under concurrent load — no double-accepted trucks, no parallel broadcasts per customer, no ghost states
**Depends on**: Nothing (first phase)
**Requirements**: BCAST-01, BCAST-02, BCAST-03, BCAST-04, BCAST-05, CUST-01, CUST-02, CUST-03, CUST-04, ACPT-01, ACPT-02, ACPT-03, ACPT-04, IDEM-01, IDEM-02, IDEM-03, CNCL-01, CNCL-02, CNCL-05, CNCL-06, CNCL-07
**Success Criteria** (what must be TRUE):
  1. Two transporters accepting the same broadcast simultaneously results in exactly one acceptance; the second receives "No longer available" — no double-assignment in database
  2. A customer with an active broadcast who attempts a new search receives "Request already in progress. Cancel it first." — no parallel broadcasts created
  3. Different customers can each have their own active broadcast concurrently without blocking each other
  4. A customer can cancel their active broadcast at any time, and the cancellation wins over a simultaneous accept — transporter sees "Request cancelled", not "Accepted"
  5. Double-tapping search or retrying a search request creates exactly one broadcast — idempotency key prevents duplicates
**Plans**: 5 plans

Plans:
- [ ] 01-01-PLAN.md — Add explicit broadcast lifecycle states with DB-persisted transitions, timestamps, and WebSocket events
- [ ] 01-02-PLAN.md — Fix atomic acceptance on Order path with Serializable transaction + updateMany optimistic lock
- [ ] 01-03-PLAN.md — Enforce one-active-broadcast-per-customer with Redis lock + DB check on both paths
- [ ] 01-04-PLAN.md — Implement server-generated idempotency key with Redis TTL dedup on broadcast creation
- [ ] 01-05-PLAN.md — Implement race-safe atomic cancel with idempotent behavior and full Redis cleanup

### Phase 2: Cancel and Timeout Cleanup Hardening
**Goal**: All terminal-state transitions (cancel, timeout, fully_filled) completely remove broadcast state from Redis and the ECS deployment cycle does not orphan timers or countdown intervals
**Depends on**: Phase 1
**Requirements**: CNCL-03, CNCL-04, TMOT-01, TMOT-02, TMOT-03, TMOT-04, TMOT-05, TIMR-01, TIMR-02, TIMR-03, TIMR-04
**Success Criteria** (what must be TRUE):
  1. When a broadcast is cancelled or times out, all Redis keys for that broadcast (notified-transporter set, customer active key, idempotency key, timer entry) are removed within seconds — no ghost keys persist after terminal state
  2. After an ECS rolling deployment, no broadcast timers are silently lost — Redis-backed timers fire correctly on whichever task picks them up
  3. Broadcast expiry fires at the configured BROADCAST_TIMEOUT_SECONDS value regardless of which ECS task is running — a single configurable timeout applies to both Booking and Order paths
  4. On timeout, the customer sees "No transporters found / Request expired" with a retry option and transporters see the broadcast removed from their actionable views
  5. On cancel, if a driver was assigned, the driver's view reverts and shows "Trip cancelled" — no dangling assignment visible to the driver
**Plans**: TBD

Plans:
- [ ] 02-01: Replace duplicate setInterval expiry checkers with shared timer.service.ts using Redis sorted set + distributed lock — single handler dispatched by key prefix
- [ ] 02-02: Replace node-cron for drift-free scheduling with graceful .stop() on shutdown — eliminate both setInterval expiry loops (Booking and Order paths)
- [ ] 02-03: Centralize Redis cleanup for all terminal transitions — explicit try/catch on notified set deletion, customer active key removal, idempotency key clearance
- [ ] 02-04: Remove server-push countdown notifications — clients derive countdown from expiresAt timestamp; cancel setInterval references stored in module-level Map keyed by broadcastId
- [ ] 02-05: Implement and verify cancel full-cleanup path — transporter view update, driver assignment revert, WebSocket fan-out to all notified parties on cancel and timeout

### Phase 3: AWS Infrastructure Hardening
**Goal**: Secrets are out of plaintext ECS task definitions and rotated, the database is protected against accidental deletion and AZ failure, and Socket.IO events route correctly across multiple ECS tasks
**Depends on**: Phase 2
**Requirements**: SECR-01, SECR-02, SECR-03, SECR-04, SECR-05, SECR-06, RDS-01, RDS-02, RDS-03, SOCK-01, SOCK-02, SOCK-03, SOCK-04
**Success Criteria** (what must be TRUE):
  1. The running ECS task definition contains no plaintext DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET, or AWS credentials — all are injected from Secrets Manager ARNs via the secrets block
  2. All previously-plaintext secret values have been rotated — old values in task definition history are no longer valid credentials
  3. The RDS instance cannot be deleted without deliberate override, retains 7 days of automated backups, and fails over automatically to a standby replica on instance failure
  4. A WebSocket event emitted in a booking room on ECS task A is received by clients connected to ECS task B — cross-instance delivery works correctly
  5. The application starts correctly after a force-new-deploy and reads all required secrets from Secrets Manager at startup — no plaintext env vars required at runtime
**Plans**: TBD

Plans:
- [ ] 03-01: Install @aws-sdk/client-secrets-manager and implement bootstrapSecrets() called before any service initialization at server startup
- [ ] 03-02: Migrate ECS task definition from environment block to secrets block with Secrets Manager ARNs; update task execution role with secretsmanager:GetSecretValue permission
- [ ] 03-03: Rotate all previously-plaintext secrets (DATABASE_URL password, JWT_SECRET, JWT_REFRESH_SECRET, FCM key) and deregister old task definition revisions
- [ ] 03-04: Enable RDS deletion protection, increase backup retention to 7 days, schedule Multi-AZ conversion in off-peak window
- [ ] 03-05: Install @socket.io/redis-adapter, wire to existing ioredis instance, replace custom publishToRedis/initializeRedisPubSub in socket.service.ts; remove redundant redis npm package

### Phase 4: CI/CD Pipeline and Driver Visibility
**Goal**: Every push to main automatically builds, tests, and deploys to ECS with health verification — no more manual docker build and ECR push; transporter sees driver online/offline changes in real time without refreshing
**Depends on**: Phase 3
**Requirements**: CICD-01, CICD-02, CICD-03, CICD-04, CICD-05, DRVR-01, DRVR-02, DRVR-03, DRVR-04
**Success Criteria** (what must be TRUE):
  1. Pushing a commit to main triggers a GitHub Actions run that builds TypeScript, runs tests, builds the Docker image with --platform linux/amd64 --target production, pushes to ECR, and deploys to ECS — no manual steps required
  2. A failing test suite blocks the deploy — the ECS service is not updated if tests do not pass
  3. The deployment waits for ECS service stability and health check success before the pipeline marks the run green — a bad deploy does not mark as successful
  4. No long-lived IAM credentials exist in GitHub Secrets for AWS access — OIDC federation provides temporary credentials for each workflow run
  5. When a driver toggles online or offline, the transporter's driver list, driver details page, and assignment selection screen all update within seconds via WebSocket — no manual refresh required

**Plans**: TBD

Plans:
- [ ] 04-01: Create OIDC IAM role in AWS with trust policy for token.actions.githubusercontent.com and minimum ECR/ECS permissions
- [ ] 04-02: Write GitHub Actions workflow (.github/workflows/deploy.yml) — OIDC auth, TypeScript build, Jest tests, Docker build/push to ECR, ECS task definition render and deploy with wait-for-service-stability
- [ ] 04-03: Verify /health endpoint checks DB and Redis connectivity; confirm rolling deployment works correctly end-to-end with health gate
- [ ] 04-04: Implement driver_status_changed WebSocket emit on driver online/offline toggle — emitToUser(transporterId, 'driver_status_changed', payload) in availability.service.ts

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Broadcast Lifecycle Correctness | 0/5 | Planned | - |
| 2. Cancel and Timeout Cleanup Hardening | 0/5 | Not started | - |
| 3. AWS Infrastructure Hardening | 0/5 | Not started | - |
| 4. CI/CD Pipeline and Driver Visibility | 0/4 | Not started | - |
