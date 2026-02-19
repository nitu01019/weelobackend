# Project Research Summary

**Project:** Weelo Backend — Broadcast Lifecycle + Infrastructure Hardening Milestone
**Domain:** Logistics/trucking real-time broadcast-matching platform
**Researched:** 2026-02-19
**Confidence:** HIGH

## Executive Summary

Weelo is a production logistics backend built on Express, Socket.IO, Prisma (PostgreSQL), and Redis (ElastiCache Serverless), deployed on AWS ECS Fargate. This milestone is not a greenfield build — it hardens an already-running system by closing correctness gaps in the broadcast lifecycle and eliminating infrastructure risks (plaintext secrets, manual deployments, single-AZ database). The core product pattern is a real-time broadcast-matching system where a customer's search fans out to N transporters via WebSocket and FCM, with race-safe acceptance enforced by serializable DB transactions and Redis distributed locks. The existing code has the right bones but is missing critical enforcement at two boundaries: the "one active broadcast per customer" invariant has no server-side guard, and `acceptTruckRequest` (Order path) has no atomic lock protecting the read-check-write sequence.

The recommended approach is to work in dependency order: first harden the broadcast lifecycle state machine and atomic acceptance logic (the two correctness gaps that can produce bad data), then centralize cleanup/timer logic to eliminate orphaned Redis state on deployments, then migrate infrastructure (Secrets Manager, CI/CD pipeline, RDS hardening). This order matters because the infrastructure migration (Secrets Manager + ECS force-new-deploy) will restart all ECS tasks — doing that before the broadcast logic is correct means restarting mid-flight bookings with known bugs still present. The stack additions are minimal: `@aws-sdk/client-secrets-manager`, `@socket.io/redis-adapter`, and `node-cron` replace or harden components that already exist.

The key risks are correctness risk (double-accepted trucks if Pitfall 1 is not fixed before load increases), security risk (JWT and DB credentials are currently in plaintext ECS task definition history and must be rotated after Secrets Manager migration, not just migrated), and deployment risk (force-new-deploy kills in-memory countdown intervals and can orphan 15–30s Redis locks). All three risks are well-understood and have concrete mitigations documented in research. No novel architecture is required — the patterns are all established and most already exist in the codebase.

---

## Key Findings

### Recommended Stack

The production stack is stable and does not require large additions. Three targeted packages resolve the specific gaps this milestone addresses. `@aws-sdk/client-secrets-manager@^3.990.0` replaces plaintext ECS environment variables with IAM-role-based secret injection at startup — the entire AWS SDK v3 family is already present, so this adds no new ecosystem dependency. `@socket.io/redis-adapter@^8.3.0` replaces the hand-rolled Redis pub/sub in `socket.service.ts` with the official adapter, which correctly routes `io.to(room).emit()` calls across ECS instances when running multiple tasks. `node-cron@^3.0.3` replaces the `setInterval`-based expiry checker with a wall-clock cron expression that supports graceful `.stop()` on shutdown and prevents drift accumulation. The `redis` npm package (currently in `package.json`) should be removed — it is redundant with `ioredis` and the Socket.IO docs explicitly flag it as problematic for subscription reconnection.

**Core technologies (additions only):**
- `@aws-sdk/client-secrets-manager@^3.990.0`: Bootstrap secrets at ECS startup from Secrets Manager — eliminates plaintext credentials in task definitions
- `@socket.io/redis-adapter@^8.3.0`: Cross-instance Socket.IO room routing — required for correct `io.to(room).emit()` on multi-task ECS deployments; pairs with existing `ioredis`
- `node-cron@^3.0.3`: Replace `setInterval` in expiry checker — drift-free scheduling with `.stop()` support for graceful shutdown
- GitHub Actions AWS actions (v4/v2/v1/v2): OIDC-based keyless CI/CD to ECR and ECS — eliminates long-lived IAM keys in GitHub Secrets

**What NOT to add:**
- RDS Proxy: Prisma's prepared statements pin sessions, negating all pooling benefits — use Prisma's built-in `connection_limit` in `DATABASE_URL` instead
- `socket.io-redis` (legacy): Deprecated; the scoped `@socket.io/redis-adapter` is the correct package
- WAF on ALB: No HTTPS/domain yet; WAF without HTTPS provides minimal security gain — defer to HTTPS milestone

### Expected Features

This milestone is a production hardening release. Features are classified by whether they fix broken invariants (P1/table stakes) versus extend capability (P2/differentiators).

**Must have (table stakes — this milestone):**
- One-active-broadcast-per-customer enforcement — PRD §7.1; currently no server-side guard; customers can create parallel broadcasts
- Cancel broadcast endpoint with full cleanup — prerequisite for enforcement; cancel path currently only stubs `declineBroadcast`
- Atomic accept for `TruckRequest` (Order path) — `acceptTruckRequest` has no lock; concurrent accepts produce double-assignment
- Terminal state cleanup: Redis key removal on cancel/timeout/fully_filled — `broadcast:notified:*` and `customer:active-broadcast:*` keys not deleted on transitions
- Idempotent search initiation — double-tap protection on create-broadcast path (idempotency already exists on accept path, not on create)
- Race-safe cancel vs. accept — cancel must use `UPDATE WHERE status IN (active, partially_filled) RETURNING *` inside a transaction
- Driver status real-time emit to transporter — already listed as broken in PROJECT.md Active items
- Secrets Manager migration — known security issue in PROJECT.md; JWT and DB credentials in plaintext ECS env vars
- GitHub Actions CI/CD pipeline (OIDC-based) — replace manual `docker buildx build` deployments
- RDS deletion protection, backup retention 7 days, Multi-AZ — one-command infrastructure hardening items

**Should have (add after core is stable):**
- Auto-cancel previous broadcast on new search — product decision (PRD §13 Q1); default is block; auto-cancel is opt-in enhancement
- Broadcast history endpoints — PRD §13 Q4; schema already stores all terminal states with timestamps
- Dynamic broadcast timeout via env var — PRD §13 Q2; currently hardcoded to 2 hours

**Defer to v2+:**
- WAF on ALB — requires HTTPS/domain first
- Payment integration on broadcast accept — separate domain milestone
- Auto-retry/re-broadcast from backend — customer-controlled retry is simpler and less error-prone

### Architecture Approach

The architecture is a monolith on ECS Fargate with a well-defined service boundary pattern: `modules/` owns domain logic (booking, broadcast, order), `shared/services/` owns cross-cutting infrastructure (Redis, Socket.IO, availability, FCM). The broadcast flow has three parallel paths — single-vehicle (`booking.service.ts`), multi-vehicle (`order.service.ts`), and transporter-facing read surface (`broadcast.service.ts`) — which deliberately do not import each other, communicating only through shared services and the DB. The most important architectural gap is that `customer:active-broadcast:{customerId}` Redis key does not yet exist as a component: it needs to be set on broadcast create and cleared on every terminal transition across BOTH the booking and order paths.

**Major components and responsibilities:**
1. `booking.service.ts` — Single-vehicle broadcast lifecycle: create, cancel, timeout, progressive radius expansion, re-broadcast on transporter toggle
2. `order.service.ts` — Multi-vehicle Order + TruckRequest lifecycle: same pattern as booking but grouped by vehicle type
3. `broadcast.service.ts` — Transporter-facing read surface: list active broadcasts, accept (serializable Tx + optimistic lock), decline
4. `socket.service.ts` — All WebSocket I/O: auth, rooms, heartbeat, cross-server Redis pub/sub fan-out
5. `redis.service.ts` — Central Redis abstraction: geo, sets, distributed locks (Lua NX EX), pub/sub, distributed timers (sorted set)
6. `availability.service.ts` / `transporter-online.service.ts` — Geo index and online set for broadcast targeting

**Key patterns already in production (do not replace):**
- Redis sorted set timer (`timers:pending`) + distributed lock per expiry — keeps expiry processing correct across instances
- Serializable isolation + optimistic lock (`updateMany WHERE trucksFilled = current`) on `acceptBroadcast` — handles concurrent accepts correctly on the Booking path (needs to be applied to TruckRequest path too)
- Progressive radius expansion: 10km → 25km → 50km → 75km → DB fallback, deduplicated via `broadcast:notified:{bookingId}` Redis SET

### Critical Pitfalls

1. **Race condition in `acceptTruckRequest` (Order path)** — No atomic lock or `updateMany` optimistic pattern on the TruckRequest accept path. Two concurrent accepts both pass the `status !== 'searching'` check before either commits. Fix: `updateMany({ where: { id, status: 'searching' } })` returning `count === 0` as 409. This is the highest-severity pitfall — produces double-assignment data corruption.

2. **One-per-customer invariant not enforced** — Idempotency key is optional on `createBooking`; no `findFirst({ where: { customerId, status: { in: ['active', 'partially_filled'] } } })` check exists. Fix: server-side `findFirst` check + `lock:customer-booking:{customerId}` Redis lock covering the creation window. Pair both — check alone has TOCTOU.

3. **Incomplete cleanup on cancel/timeout — countdown intervals orphaned on deployment** — `startCountdownNotifications` uses in-memory `setInterval` with no external reference; killed silently on ECS task restart. Redis timers survive but countdown stops. Fix: make countdown client-derived from `expiresAt` timestamp (remove server-push countdown), store interval reference in a module-level `Map` keyed by `bookingId`, cancel in `clearBookingTimers`.

4. **Secrets migration incomplete if old task definition revisions not deregistered and values not rotated** — Old revisions contain plaintext credentials readable via `ecs:DescribeTaskDefinition`. Migration is three steps: add Secrets Manager references, rotate all secrets (existing values are compromised by their prior exposure), deregister old revisions. Skipping rotation means the migration provides no actual security improvement.

5. **Force-new-deploy creates 15–30s lock gap for in-flight bookings** — Old ECS task killed mid-lock; lock TTL auto-releases after 15–30s; new task picks up the expiry. Customers experience silent delay. Mitigation: shorten lock TTLs (10–15s), add lock abandonment detection (log if acquired lock has near-full TTL), consider blue/green over rolling deploy.

---

## Implications for Roadmap

Based on the dependency graph from ARCHITECTURE.md and the pitfall-to-phase mapping from PITFALLS.md, four phases are recommended in strict dependency order.

### Phase 1: Broadcast Lifecycle Correctness

**Rationale:** This must come first. The atomic acceptance gap (Pitfall 1) and the one-per-customer gap (Pitfall 2) can produce data corruption at current traffic levels. Infrastructure changes (Secrets Manager, ECS redeploy) should not land on a codebase with known correctness bugs, because a force-new-deployment restarts all tasks and re-starts mid-flight bookings. Fix the logic before touching infrastructure.

**Delivers:**
- `acceptTruckRequest` (Order path) protected by `updateMany` optimistic lock — eliminates double-assignment
- `customer:active-broadcast:{customerId}` Redis key set on create, cleared on cancel/timeout/fully_filled (both Booking and Order paths)
- Server-side `findFirst` check + Redis lock on create-broadcast — enforces one-per-customer invariant
- Idempotent `createBroadcast` path (client-supplied `idempotencyKey` with Redis TTL 30s)
- Race-safe cancel endpoint: `UPDATE WHERE status IN (active, partially_filled) RETURNING *` in Prisma transaction

**Addresses:** FEATURES.md table stakes: one-active-broadcast enforcement, cancel with full cleanup, atomic accept, idempotent search initiation, race-safe cancel vs. accept

**Avoids:** Pitfalls 1 and 2 (data corruption from concurrent accepts and parallel broadcasts)

**Research flag:** Standard patterns — no deeper research needed. All patterns (optimistic lock, Redis customer key) are fully specified in ARCHITECTURE.md with code examples.

---

### Phase 2: Cancel and Timeout Cleanup Hardening

**Rationale:** Depends on Phase 1. Once the state machine is correct, the cleanup paths can be reliably centralized. The two expiry checkers (booking + order) need to be unified into a shared `timer.service.ts` to prevent the proliferation of polling loops. Redis key cleanup must be verified for all terminal transitions, not just expiry.

**Delivers:**
- Shared `timer.service.ts` extracting the expiry checker pattern — single sorted set scan, multiple handlers dispatched by key prefix
- Redis SET (`broadcast:notified:{bookingId}`) used as canonical source for cancel/expiry fan-out (instead of DB `notifiedTransporters` array)
- In-memory countdown `setInterval` removed — clients derive countdown from `expiresAt` timestamp
- All Redis cleanup paths (notified set, customer active key, idempotency keys) wrapped in explicit try/catch (not silenced `.catch(() => {})`)
- `node-cron` replaces both `setInterval` expiry checkers with drift-free scheduling + `.stop()` graceful shutdown

**Uses:** `node-cron@^3.0.3` (STACK.md)

**Implements:** Anti-Pattern 1 fix (unified timer service) and Anti-Pattern 3 fix (remove server countdown) from ARCHITECTURE.md

**Avoids:** Pitfall 3 (orphaned countdown intervals, stale Redis keys, timer fire after cancel)

**Research flag:** Standard patterns — cron scheduling and timer centralization are well-documented.

---

### Phase 3: AWS Infrastructure Hardening

**Rationale:** Depends on Phases 1-2 being stable. Infrastructure changes involve ECS force-new-deployments (Secrets Manager migration requires restarting tasks to pick up new secret injection method). Running a force-new-deploy on clean, correct logic from Phases 1-2 minimizes risk. RDS Multi-AZ requires backup retention >= 1 day to be enabled first — ordering within this phase matters.

**Delivers:**
- `@aws-sdk/client-secrets-manager` bootstrap at server startup — `bootstrapSecrets()` called before any service initialization
- ECS task definition migrated from `environment` to `secrets` block with Secrets Manager ARNs
- Task execution role IAM policy updated with `secretsmanager:GetSecretValue`
- All previously plaintext secrets rotated (JWT_SECRET, JWT_REFRESH_SECRET, DATABASE_URL password, FCM key)
- Old ECS task definition revisions deregistered
- RDS deletion protection enabled, backup retention set to 7 days, backup window set to low-traffic hours (20:30–21:30 UTC)
- RDS Multi-AZ enabled (scheduled off-peak; brief I/O freeze during snapshot creation)
- `@socket.io/redis-adapter` installed and wired — replaces custom `publishToRedis()`/`initializeRedisPubSub()` in `socket.service.ts`; enables correct multi-instance transporter fan-out

**Uses:** `@aws-sdk/client-secrets-manager@^3.990.0`, `@socket.io/redis-adapter@^8.3.0` (STACK.md); remove `redis` npm package

**Avoids:** Pitfall 4 (incomplete secrets migration), Pitfall 5 (deployment data loss — lock TTL shortening also happens here)

**Research flag:** Standard patterns — official AWS docs cover Secrets Manager ECS injection in detail. Socket.IO Redis adapter migration is fully documented with code examples in STACK.md.

---

### Phase 4: CI/CD Pipeline + Driver Status Fix

**Rationale:** CI/CD pipeline requires OIDC IAM role in AWS to exist (prerequisite), which requires the Secrets Manager migration from Phase 3 to be complete (so the pipeline workflow references secrets correctly, not GitHub Secrets for app credentials). Driver status real-time emit is a small socket fix that can ship alongside CI/CD as it has no dependencies on the other phases.

**Delivers:**
- GitHub Actions workflow: OIDC auth → ECR build/push → ECS task definition render → ECS deploy with `wait-for-service-stability: true`
- OIDC IAM role in AWS with trust policy for `token.actions.githubusercontent.com`
- `--platform linux/amd64 --target production --no-cache` baked into workflow build step (per AGENTS.md requirements)
- Driver status WebSocket emit to transporter room on online/offline toggle — single `emitToUser(transporterId, 'driver_status_changed', payload)` call
- `/health` endpoint verified to check DB + Redis connectivity before deploy marks successful

**Uses:** GitHub Actions AWS actions (configure-aws-credentials@v4, amazon-ecr-login@v2, amazon-ecs-render-task-definition@v1, amazon-ecs-deploy-task-definition@v2) (STACK.md)

**Avoids:** Pitfall 4 (static IAM keys in GitHub Secrets), Pitfall 5 (health check verification in CI)

**Research flag:** CI/CD workflow structure is fully specified in STACK.md with a complete YAML example. No deeper research needed. Driver status emit is a one-line addition — no research needed.

---

### Phase Ordering Rationale

- **Correctness before infrastructure:** Phases 1-2 fix bugs that can produce bad data. Running an ECS force-new-deployment (required for Secrets Manager migration) before fixing those bugs means restarting tasks with known correctness issues.
- **Infrastructure before CI/CD:** Phase 3's Secrets Manager migration must complete before Phase 4's CI/CD workflow can reference secrets correctly. The OIDC IAM role also needs to be created in AWS before the workflow file can be written.
- **RDS ordering within Phase 3:** Enable backup retention before Multi-AZ (AWS enforces this — Multi-AZ requires automated backups to be enabled).
- **Socket.IO adapter in Phase 3:** The custom pub/sub works for a single ECS task but breaks `io.to(room).emit()` across instances. Installing the adapter during the infrastructure phase, when ECS task count may increase due to auto-scaling, prevents the multi-instance bug from being introduced silently.
- **Cleanup before deployment:** Phase 2's timer centralization must happen before Phase 3's forced redeployments, so the new task starts with the clean, graceful-shutdown-capable `node-cron` scheduler (not the `setInterval` that accumulates on restart).

### Research Flags

**Phases with standard patterns (skip research-phase during planning):**
- **Phase 1 (Broadcast Lifecycle Correctness):** All patterns fully specified with code examples in ARCHITECTURE.md. `updateMany` optimistic lock and Redis customer key are industry-standard patterns with no ambiguity.
- **Phase 2 (Cleanup Hardening):** Timer centralization and `node-cron` migration are well-documented. No external dependencies or integrations requiring research.
- **Phase 3 (AWS Infrastructure):** AWS Secrets Manager ECS injection, RDS Multi-AZ, and Socket.IO Redis adapter are covered comprehensively by official documentation and reproduced with code examples in STACK.md.
- **Phase 4 (CI/CD + Driver Status):** Complete GitHub Actions workflow YAML is provided in STACK.md. OIDC setup steps are documented in official GitHub and AWS docs.

**Phases that may benefit from validation during execution (not blocking):**
- **Phase 3 — RDS Multi-AZ timing:** The I/O freeze during Multi-AZ conversion is documented as brief but not precisely quantified for `db.t3.micro`. Schedule during lowest-traffic window and have a rollback plan ready. Confidence: MEDIUM.
- **Phase 3 — Secret rotation order:** JWT_SECRET rotation invalidates all existing JWTs, forcing all users to re-login. Coordinate the rotation timing with product/support. Confidence: HIGH on the technical steps, LOW on the business coordination plan.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All package versions verified against official npm/docs as of Feb 2026. Compatibility between socket.io@4.7.2 and @socket.io/redis-adapter@8.x confirmed in official docs. RDS Proxy avoidance confirmed by Prisma official docs and GitHub discussion. |
| Features | HIGH | Feature list derived from PRD (primary source), existing codebase (source code inspection), and PROJECT.md known issues. No external feature inference required. |
| Architecture | HIGH | Based on direct codebase analysis, not external sources. Component map, Redis key namespace, and data flow diagrams reflect the actual running system. No guesswork. |
| Pitfalls | HIGH | Critical pitfalls derived from direct code inspection (acceptTruckRequest race condition is visible in the code). Security pitfalls confirmed against AWS official docs. CI/CD pitfalls confirmed against GitHub docs and the March 2025 tj-actions incident. |

**Overall confidence:** HIGH

### Gaps to Address

- **`npm test` in CI/CD pipeline:** Test suite exists (`jest.config.js`, `__tests__/` directories) but coverage may be sparse. Add `npm test` step to the pipeline workflow, but verify it doesn't fail on missing coverage thresholds before first pipeline run. Resolution: check test output locally before enabling test gate in CI.
- **Multi-AZ I/O freeze duration on `db.t3.micro`:** AWS documentation documents a "brief I/O freeze" but does not specify duration for this instance class. Resolution: schedule during off-peak (02:00–03:00 IST), monitor RDS CloudWatch for `DatabaseConnections` drop, have manual rollback command ready.
- **JWT rotation user impact coordination:** Technical rotation is straightforward, but all active JWTs become invalid simultaneously. Resolution: notify support team before rotation; consider rotating off-peak (same window as Multi-AZ change).
- **`node-cron` TypeScript types:** STACK.md notes MEDIUM confidence on whether `@types/node-cron` is needed separately. Resolution: verify on `npm install node-cron` — v3 ships its own declarations, but confirm no TypeScript compilation errors before committing.

---

## Sources

### Primary (HIGH confidence)
- Weelo PRD: `/Users/nitishbhardwaj/Desktop/DRIVER_ONLINE_BROADCAST_SEARCH_PRD.md` — product requirements, lifecycle states, edge cases
- Weelo codebase: `src/modules/broadcast/broadcast.service.ts`, `src/modules/booking/booking.service.ts`, `src/modules/booking/order.service.ts`, `src/shared/services/socket.service.ts`, `src/shared/services/redis.service.ts` — ground-truth architecture
- Weelo planning: `.planning/PROJECT.md` — known issues, active requirements, out-of-scope items
- [AWS SDK v3 Secrets Manager npm](https://www.npmjs.com/package/@aws-sdk/client-secrets-manager) — version 3.990.0, updated 3 days before research date
- [AWS Secrets Manager Best Practices](https://docs.aws.amazon.com/secretsmanager/latest/userguide/best-practices.html) — caching and least-privilege IAM patterns
- [AWS ECS Secrets Injection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html) — task definition `secrets` block format
- [Socket.IO Redis Adapter docs](https://socket.io/docs/v4/redis-adapter/) — v8.3.0, ioredis recommendation
- [Prisma Caveats for AWS Platforms](https://www.prisma.io/docs/orm/prisma-client/deployment/caveats-when-deploying-to-aws-platforms) — RDS Proxy / PgBouncer guidance
- [GitHub Actions OIDC for AWS](https://docs.github.com/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services) — OIDC federation setup
- [AWS Security Blog — IAM Roles for GitHub Actions](https://aws.amazon.com/blogs/security/use-iam-roles-to-connect-github-actions-to-actions-in-aws/) — OIDC recommended approach
- [Redis Official — Distributed Locks](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/) — lock pattern correctness
- aws-actions/* GitHub repos (v4/v2/v1/v2 versions confirmed)

### Secondary (MEDIUM confidence)
- [RDS Multi-AZ online conversion guide](https://oneuptime.com/blog/post/2026-02-12-enable-rds-multi-az-high-availability/view) — I/O freeze behavior
- [Prisma RDS Proxy discussion](https://github.com/prisma/prisma/discussions/23547) — prepared statement pinning confirmed
- [GitHub Actions CI/CD for Fargate](https://www.cloudtechsimplified.com/ci-cd-pipeline-aws-fargate-github-actions-nodejs/) — six-step workflow pattern (verified against AWS docs)
- [InfoQ — Timeouts, Retries and Idempotency](https://www.infoq.com/presentations/distributed-systems-resiliency/) — idempotency key patterns
- [Arctiq — GitHub Actions Security Pitfalls](https://arctiq.com/blog/top-10-github-actions-security-pitfalls-the-ultimate-guide-to-bulletproof-workflows) — tj-actions incident reference
- Martin Kleppmann: [How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) — authoritative lock pattern reference

---
*Research completed: 2026-02-19*
*Ready for roadmap: yes*
