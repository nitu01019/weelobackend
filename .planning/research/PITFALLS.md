# Pitfalls Research

**Domain:** Logistics/trucking broadcast platform (broadcast lifecycle, race conditions, secrets migration, CI/CD)
**Researched:** 2026-02-19
**Confidence:** HIGH — grounded in existing codebase analysis + verified against official AWS docs and Redis official documentation

---

## Critical Pitfalls

### Pitfall 1: Broadcast Acceptance Race — No Atomic Lock on acceptTruckRequest

**What goes wrong:**
Two transporters tap "Accept" within milliseconds of each other on the same truck request. Both read `status === 'searching'` from the DB before either write commits. Both proceed through vehicle validation, both call `db.updateTruckRequest(requestId, { status: 'assigned' })`. The second write silently overwrites the first. One transporter gets the truck; the other also receives `ACCEPT_CONFIRMATION` and believes they are assigned. The order ends up with one truck double-assigned and the customer has two drivers showing up.

**Why it happens:**
The current `acceptTruckRequest` (order.service.ts:680–731) reads `request.status`, then does multi-step validation (vehicle check, owner check, type check), then updates. There is no distributed lock or DB-level serialization protecting the window between the read and the write. On ECS Fargate with multiple concurrent requests per instance (Node.js event loop), two in-flight requests will both pass the `status !== 'searching'` guard before either commits. This is the same class of bug that caused 15+ issues in the driver online/offline toggle — non-atomic read-check-write.

**How to avoid:**
Wrap the status check and update in a single atomic Prisma transaction with a `where` clause filter that acts as an optimistic lock:

```typescript
// Atomic: only succeeds if status is still 'searching'
const updated = await prismaClient.truckRequest.updateMany({
  where: { id: requestId, status: 'searching' },
  data: { status: 'assigned', assignedTransporterId: transporterId, ... }
});
if (updated.count === 0) {
  throw new AppError(409, 'REQUEST_ALREADY_TAKEN', 'This request was just accepted.');
}
```

Alternatively, use the existing `redisService.acquireLock` pattern (already working for booking expiry) on key `lock:accept:${requestId}` before ANY reads. Do not rely on application-level status checks without a lock.

**Warning signs:**
- Customer receives two driver confirmations for one truck slot
- `assignedTransporterId` field in DB gets overwritten after assignment
- Two `ACCEPT_CONFIRMATION` events emitted for the same `requestId` in logs
- `updateTruckRequest` log entries for the same `requestId` with different `transporterId` values within 500ms of each other

**Phase to address:** Broadcast flow implementation phase (broadcast acceptance endpoint)

---

### Pitfall 2: One-Per-Customer Rule Not Enforced — Customer Creates Parallel Broadcasts

**What goes wrong:**
A customer taps "Search" twice quickly (network retry, double-tap, app reconnect) before the idempotency key response arrives. The current idempotency check uses a client-supplied `idempotencyKey` — if the client doesn't send one, or sends two different keys, two active bookings are created simultaneously. Both broadcast to all matching transporters. Transporters see duplicate cards. Customer ends up paying for two orders, or the system creates two assignments for the same physical job.

**Why it happens:**
The idempotency key is optional (`idempotencyKey?: string` in createBooking). Without it, there is no server-side enforcement of the "one active broadcast per customer" invariant. The code does not query for existing active bookings for `customerId` before creating a new one. The idempotency key only deduplicates requests with the SAME key — not duplicate intents with different keys.

**How to avoid:**
Before creating a booking, perform a server-side check:

```typescript
const existingActive = await prismaClient.booking.findFirst({
  where: {
    customerId,
    status: { in: ['active', 'partially_filled'] }
  }
});
if (existingActive) {
  throw new AppError(409, 'ACTIVE_BOOKING_EXISTS',
    'You already have an active search. Cancel it first.');
}
```

This check + the idempotency key together provide full protection. The check alone is still subject to a TOCTOU race if two requests land simultaneously — pair it with a Redis lock: `lock:customer-booking:${customerId}` with a 10-second TTL covering the creation critical section.

**Warning signs:**
- Multiple rows in `bookings` table with `status='active'` for the same `customerId`
- Transporters reporting seeing the same customer's job twice in their feed
- Double FCM push notifications to transporters for the same pickup address
- Customer receiving two `BROADCAST_COUNTDOWN` streams

**Phase to address:** Broadcast lifecycle phase, customer booking creation endpoint

---

### Pitfall 3: Search Cancel/Timeout — Cleanup Incomplete, Timers Orphaned

**What goes wrong:**
A booking is cancelled or expires. `clearBookingTimers` is called which cancels Redis timers and deletes radius keys. However:

1. **Countdown interval is in-memory only** (`startCountdownNotifications` uses `setInterval` stored nowhere — the reference is lost). When ECS deploys a new revision during a live booking (force-new-deployment), the old task dies, the interval dies with it, but the Redis booking timer is already set. The new task's expiry checker will eventually fire the expiry, but the in-memory countdown to the customer stops silently — the customer's UI freezes at whatever countdown value it last received.

2. **Progressive radius expansion fires after cancellation if the timer fires between cancel and clear.** The `advanceRadiusStep` does check `booking.status` before broadcasting, but there is a race: cancel sets DB status to `cancelled`, then calls `clearBookingTimers` (async). If the expiry checker's 5-second poll fires between the DB write and the Redis key deletion, it can acquire the lock and call `advanceRadiusStep`, which reads the booking status and correctly exits — but `redisService.cancelTimer` for `RADIUS_STEP` may not yet have executed, causing a second poll loop to also attempt it.

3. **Notified transporter set (RADIUS_KEYS.NOTIFIED_SET) may not be deleted** if `clearBookingTimers` throws on one of its parallel `Promise.all` calls (e.g., Redis timeout) — the catch is per-key, but if `del` for the notified set fails silently, stale data accumulates in Redis with no TTL beyond the booking's own TTL.

**Why it happens:**
Cleanup is split across in-memory state (countdown interval) and Redis state (timers, radius keys, notified set). There is no single authoritative cleanup path with guaranteed execution. The in-memory countdown has no external reference stored anywhere, so it cannot be cancelled by the timeout path running on a different instance.

**How to avoid:**
- Make countdown Redis-driven: use a Redis timer key (`timer:countdown:{bookingId}`) instead of `setInterval`. The expiry checker already polls — it can emit countdown events when processing the timer.
- Store the countdown interval reference in a module-level `Map<string, NodeJS.Timeout>` keyed by `bookingId`. Cancel it in `clearBookingTimers`.
- After `clearBookingTimers` resolves, verify Redis keys are gone with a spot-check log (do not fire-and-forget cleanup).
- Wrap each `Promise.all` member in try/catch explicitly rather than relying on `.catch(() => {})` silencers which hide failures.

**Warning signs:**
- Customer UI shows stale countdown (frozen at e.g. "60 seconds remaining") during a deployment
- Redis `SMEMBERS broadcast:notified:*` keys accumulating without TTL after bookings expire
- Logs showing `[RADIUS EXPANSION]` messages for bookings already in `cancelled` status
- Memory gradually increasing on long-running instances (orphaned `setInterval` references)

**Phase to address:** Broadcast lifecycle phase; also in infrastructure hardening (deployment strategy)

---

### Pitfall 4: AWS Secrets Manager Migration — Secrets Still in Task Definition After Migration

**What goes wrong:**
The team migrates from plaintext ECS environment variables to AWS Secrets Manager. The new task definition correctly uses the `secrets` block pointing to Secrets Manager ARNs. However:

1. The **old task definition revisions still exist** in ECS and contain the plaintext values. Any developer with `ecs:DescribeTaskDefinition` access can read the old revisions and extract JWT_SECRET, DATABASE_URL, etc.
2. The **GitHub Actions workflow** still has `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` stored as repository secrets — long-lived IAM user credentials. If the repository is compromised (supply chain attack via a GitHub Action, e.g., the tj-actions incident of March 2025), these credentials are exposed and an attacker gains full ECS + ECR + RDS access.
3. After migration, **rotating a secret in Secrets Manager does NOT update running ECS tasks** — the container keeps the value that was injected at task start. A forced redeployment is required for each rotation.

**Why it happens:**
Teams focus on the "add Secrets Manager references" step and forget to deregister old revisions, rotate the compromised values, and replace static IAM credentials in CI. The migration is treated as a one-step change rather than a three-step process (migrate → rotate → decommission old revisions).

**How to avoid:**
1. After migrating to Secrets Manager, **immediately rotate all secrets that existed as plaintext** (JWT_SECRET, JWT_REFRESH_SECRET, DATABASE_URL password). The old values are now compromised by their prior exposure in task definition history.
2. **Deregister old task definition revisions** that contained plaintext: `aws ecs deregister-task-definition --task-definition weelobackendtask:N` for each old revision.
3. Replace GitHub Actions static AWS credentials with **OIDC federation** (`aws-actions/configure-aws-credentials` with `role-to-assume`). This eliminates long-lived keys entirely — GitHub gets a short-lived token (15 min–12 hrs) per workflow run. [HIGH confidence — official GitHub docs + AWS docs confirm this pattern]
4. Add a post-rotation hook that triggers an ECS force-new-deployment, or document that secret rotation requires a redeployment.

**Warning signs:**
- `aws ecs describe-task-definition --task-definition weelobackendtask:1` returns plaintext JWT_SECRET in the environment block
- GitHub repo Settings > Secrets shows `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` as repository-level secrets
- No IAM rotation policy on the access key (`aws iam list-access-keys` shows key age > 90 days)
- CloudWatch logs contain lines that include `JWT_SECRET=` (application startup logging config values)

**Phase to address:** Infrastructure hardening / secrets migration phase

---

### Pitfall 5: CI/CD Pipeline — Force-Deploy Causes In-Flight Broadcast Data Loss

**What goes wrong:**
A deployment is triggered (`aws ecs update-service --force-new-deployment`). ECS starts a new task alongside the old one. During the drain period, the old task is serving live broadcast flows:
- In-memory countdown intervals die with the old task (see Pitfall 3)
- Redis-based timers survive and the new task picks them up — good
- BUT: `startBookingExpiryChecker()` starts immediately on the new task. Within 5 seconds it polls `timer:booking:*` and processes any timers that fired during deployment, including bookings the old task was mid-way through broadcasting to radius steps 2/3/4

This is correct by design — Redis locks prevent duplicate processing. However, if the old task is killed mid-lock (before `releaseLock`), the lock TTL (30s for expiry, 15s for radius) acts as the recovery mechanism. For 15–30 seconds after a deployment, no expiry processing occurs for bookings that were locked by the dying task. Active bookings experience a silent 15–30 second delay in expiry/expansion notifications.

The current GitHub Actions workflow (`GITHUB_ACTIONS_DEPLOYMENT.yml`) uses `aws ecs wait services-stable` which blocks until the service stabilizes — this is correct and prevents the pipeline from succeeding before the new task is actually running. However, it does not verify that the health check passes at application level (only ECS considers the task healthy if the ALB health check at `/health` passes).

**Why it happens:**
ECS Fargate rolling deployments default to minimum 100% healthy/maximum 200% — meaning the old task keeps running until the new task passes health checks. The 30-second lock TTL creates a gap window during the handover. The team is not aware of this gap because deployments happen manually and are not monitored for broadcast impact.

**How to avoid:**
- Add a deployment cooldown check in the expiry checker: if a lock acquisition fails, log the lock TTL remaining. If it's close to full TTL (e.g., > 25s of 30s remaining), it was abandoned by a dead task — use `releaseLock` with force and reprocess.
- Consider ECS blue/green deployment (CodeDeploy integration) for zero-downtime with traffic shifting, rather than rolling replace.
- Add a `/health/detailed` endpoint that checks Redis connectivity, DB connectivity, and reports active booking count — include this in deployment verification step.
- Make lock TTLs shorter (10s for radius expansion, 15s for expiry checker) to reduce the recovery gap.

**Warning signs:**
- Customer reports "stuck" broadcast that never expired even though the timer clearly ran out
- CloudWatch logs show gap in `[Booking expiry checker]` log lines during deployment windows
- `lock:booking-expiry:*` Redis keys with TTL close to max (29/30s) after a deployment — indicates an orphaned lock

**Phase to address:** CI/CD setup phase; deployment strategy task

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| In-memory `setInterval` for countdown notifications | Zero Redis overhead, simple | Countdown dies on ECS task restart; no cross-instance delivery | Never — already identified as risky in codebase comments |
| Optional idempotency key from client | Flexibility for clients not yet implementing it | No server-side active-booking guard means duplicate broadcasts possible | Never for production; require server-side check regardless |
| Static AWS IAM keys in GitHub Secrets | Fastest CI setup | Long-lived credentials exposed in supply chain attacks; requires manual rotation | Only as a temporary bridge; replace with OIDC within the same milestone |
| Plaintext JWT + DB credentials in ECS task definition environment | Visible in console, easy to debug | Readable from any `DescribeTaskDefinition` API call; exposed in task definition history forever | Never — migrate to Secrets Manager before next production traffic increase |
| Fire-and-forget `.catch(() => {})` on Redis cleanup | Prevents uncaught rejections | Silently hides Redis failures; stale keys accumulate | Only on truly non-critical operations (logging side effects); never on cleanup |
| `KEYS pattern` scan on Redis for idempotency cleanup | Simple to code | Fails on ElastiCache Serverless (already documented in codebase as `FIX`) | Never — use the `latest` pointer pattern already implemented |

---

## Integration Gotchas

Common mistakes when connecting to external services.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| AWS Secrets Manager + ECS | Using `environment` block instead of `secrets` block in task definition | Use `secrets` block with full ARN or ARN+JSON key: `arn:aws:secretsmanager:ap-south-1:318774499084:secret:weelo/jwt-secret:JWT_SECRET::` |
| ElastiCache Serverless Redis | Using `KEYS pattern:*` command (not supported) | Use `SCAN` cursor or maintain explicit pointer keys (pattern already fixed in codebase) |
| ElastiCache Serverless Redis | Using `redis://` URL | Use `rediss://` (TLS required for Serverless); already correct in codebase |
| GitHub Actions → ECR | Using static `AWS_ACCESS_KEY_ID` secrets | Configure OIDC provider in AWS IAM, use `role-to-assume` in `aws-actions/configure-aws-credentials@v3` |
| AWS Secrets Manager rotation | Rotating secret without redeploying ECS | ECS containers keep injected value at task start; force-new-deployment required after every rotation |
| FCM push notifications | Blocking broadcast loop on FCM response | FCM is already `.then/.catch` fire-and-forget — maintain this pattern; FCM latency of 500ms–2s would block 100 transporter notifications |

---

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| `notifiedTransporters` stored as Postgres array, iterated in broadcast loop | Works for 20 transporters; at 200+, broadcast loop becomes a 200-iteration socket emit loop blocking the event loop for ~200ms | Chunk into batches of 50 with `setImmediate` between chunks; or delegate to a queue worker | ~100 concurrent transporters per booking |
| `filterOnlineViaDB` N+1 fallback path | Each DB call adds ~5ms; 100 transporters = 500ms sequential DB round-trips during Redis outage | Already implemented with Redis primary path; ensure ElastiCache has Multi-AZ enabled so fallback is rare | First Redis failure with > 50 transporters |
| `processExpiredBookings` scans all `timer:booking:*` keys every 5s | Works with < 100 concurrent bookings; at 1,000+ concurrent, SCAN operation takes > 100ms, blocks the event loop iteration | Move to Redis Streams or keyspace notifications instead of polling; or push timer keys into a sorted set (score = expiry timestamp) | ~500 concurrent active bookings |
| `emitToUsers` publishes to Redis for every transporter even if locally connected | Correct behavior, but at 200 transporters/booking, creates 200 Redis PUBLISH calls per broadcast | Batch-publish with a single channel if all are on the same order | ~50+ transporters per booking on multi-instance deployment |
| `startCountdownNotifications` DB read every 60s per active booking | 100 active bookings = 100 DB reads/min just for countdown | Cache booking status in Redis with short TTL; only query DB on status change | ~50 concurrent active bookings |

---

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| JWT_SECRET and JWT_REFRESH_SECRET in ECS task definition plaintext (current state) | Any developer with AWS console access or `ecs:DescribeTaskDefinition` can extract all JWT secrets, forge tokens for any user | Migrate to Secrets Manager immediately; rotate the existing plaintext secrets after migration since they are now compromised by their history |
| DATABASE_URL with password in plaintext ECS env var | Full database access to anyone who can read task definitions or CloudWatch startup logs | Same: Secrets Manager migration + immediate password rotation |
| Long-lived GitHub Actions IAM key (`AWS_ACCESS_KEY_ID` as repo secret) | Supply chain attack on any action in the workflow exposes the key; March 2025 tj-actions incident stole secrets from 23k+ repos | Replace with OIDC federation; restrict the assumed role to `ecr:GetAuthorizationToken`, `ecr:BatchCheckLayerAvailability`, `ecr:PutImage`, `ecs:UpdateService`, `ecs:DescribeServices` only |
| `cors: '*'` in production Socket.IO config for `isDevelopment` check | If `NODE_ENV` is misconfigured on ECS, CORS is wide open | Assert `NODE_ENV=production` at startup; add explicit origin allowlist as fallback |
| Transporter can accept any `vehicleId` without fleet ownership re-check at DB write time | After passing the ownership check at line 706, a second transaction on the vehicle could change ownership before the update at line 720 | Include `vehicleId` and `transporterId` in the `updateTruckRequest` where clause to ensure the vehicle still belongs to the transporter at write time |

---

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Emitting `BOOKING_EXPIRED` to all `notifiedTransporters` on cancel — including transporters who already accepted | A transporter who already received assignment sees "Booking Cancelled" and is confused about their confirmed trip | Filter: only emit `BOOKING_EXPIRED` to transporters where `status !== 'assigned'` for their request |
| Countdown notification only via WebSocket, no fallback for background app | Customer puts phone down; app goes to background; WebSocket delivery not guaranteed; customer sees no countdown | Pair WebSocket countdown with FCM push at the 60-second remaining mark |
| `REQUEST_ALREADY_TAKEN` error to transporter with no next-step guidance | Transporter is frustrated, doesn't know if other trucks are available | Include `remainingRequests` count in the error payload so the client can show "1 truck still available — accept it?" |
| No acknowledgment timeout on `emitToUser` — fire-and-forget Socket.IO | If a transporter's connection is weak, they may miss the broadcast entirely with no retry | Use Socket.IO acknowledgment callbacks with 5s timeout; on timeout, queue an FCM fallback |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Broadcast acceptance:** Code path exists but `acceptTruckRequest` has no atomic lock — verify `updateMany` with `where: { status: 'searching' }` pattern is used, not read-then-write
- [ ] **One-per-customer:** Idempotency key is implemented but only deduplicates same-key requests — verify server-side `findFirst` for active bookings exists before creation
- [ ] **Timer cleanup on cancel:** `clearBookingTimers` clears Redis but not in-memory `setInterval` — verify interval reference is stored and cancelled
- [ ] **Secrets migration:** Task definition updated to use `secrets` block — verify old task definition revisions are deregistered and old secret values rotated
- [ ] **CI/CD:** GitHub Actions workflow file exists (`GITHUB_ACTIONS_DEPLOYMENT.yml`) but uses static IAM keys — verify OIDC has replaced static keys before first production deployment from CI
- [ ] **Transporter notification on cancel:** `cancelBooking` notifies all `notifiedTransporters` — verify it excludes already-assigned transporters
- [ ] **Health check in CI:** `aws ecs wait services-stable` checks ECS-level health, not application health — verify `/health` returns 200 with DB + Redis connectivity confirmed before marking deploy successful

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Double-accepted truck request | HIGH | Identify which transporter has the legitimate assignment via timestamp; contact the other transporter directly; mark the second assignment as cancelled in DB; refund if payment was taken |
| Secrets exposed via plaintext task definition | HIGH | Immediately rotate JWT_SECRET + JWT_REFRESH_SECRET (all existing JWTs become invalid — users must re-login); rotate DB password; invalidate and reissue IAM access key; deregister compromised task definition revisions |
| Orphaned Redis timers after bad deployment | LOW | `redis-cli SCAN 0 MATCH timer:booking:* COUNT 100` to find orphaned timers; cross-reference with DB bookings table; delete keys for bookings that are already in terminal status |
| In-memory countdown intervals surviving ECS drain | LOW | Next booking creation starts fresh countdown; customers only need to refresh their UI — no data corruption |
| Static IAM key leaked via GitHub Actions supply chain | HIGH | Immediately deactivate key in IAM console; rotate and update all downstream resources; audit CloudTrail for unauthorized API calls in past 72 hours |
| Lock not released after ECS task kill mid-lock | LOW | Lock TTL auto-releases within 15–30 seconds; affected booking gets a delayed expiry notification; no data loss, only delay |

---

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Race condition in acceptTruckRequest | Broadcast flow implementation | Integration test: two concurrent accept requests on same requestId — only one should succeed with 200, other gets 409 |
| One-per-customer broadcast not enforced | Broadcast lifecycle (createBooking) | Integration test: customer sends two create requests without cancelling — second must return 409 |
| Countdown interval orphaned on redeploy | Broadcast lifecycle + infrastructure hardening | Deploy during an active booking; verify customer receives expiry notification within 30s of timer firing on new task |
| AWS Secrets Manager migration | Infrastructure hardening phase | `aws ecs describe-task-definition` shows no plaintext secrets; old revisions deregistered; secrets rotated |
| CI/CD static IAM credentials | CI/CD setup phase | GitHub Actions workflow uses `role-to-assume` not `aws-access-key-id`; no `AWS_ACCESS_KEY_ID` secret exists in repo settings |
| Force-deploy broadcast data loss gap | CI/CD + deployment strategy | Monitor lock TTL histogram in CloudWatch during deployments; alert if any lock TTL > 25s is observed post-deploy |
| `KEYS` scan fails on ElastiCache Serverless | Already fixed in codebase | Verify no `redis.keys(pattern)` calls remain; use `SCAN` or pointer keys |

---

## Sources

- Weelo codebase analysis: `src/modules/booking/booking.service.ts`, `src/modules/booking/order.service.ts`, `src/shared/services/socket.service.ts`, `src/shared/services/transporter-online.service.ts` (HIGH confidence — direct code inspection)
- AWS official docs: [Pass Secrets Manager secrets through ECS environment variables](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html) (HIGH confidence)
- AWS official docs: [Pass sensitive data to an ECS container](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specifying-sensitive-data.html) (HIGH confidence)
- Redis official docs: [Distributed Locks with Redis](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/) (HIGH confidence)
- Leapcell: [10 Hidden Pitfalls of Using Redis Distributed Locks](https://leapcell.io/blog/redis-distributed-locks-10-common-mistakes) (MEDIUM confidence — community post, consistent with Redis official docs)
- GitHub Docs: [Configuring OpenID Connect in Amazon Web Services](https://docs.github.com/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services) (HIGH confidence)
- Martin Kleppmann: [How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) (MEDIUM confidence — authoritative industry reference, patterns still applicable)
- Arctiq: [Top 10 GitHub Actions Security Pitfalls](https://arctiq.com/blog/top-10-github-actions-security-pitfalls-the-ultimate-guide-to-bulletproof-workflows) (MEDIUM confidence — community post with documented incidents)
- Socket.IO GitHub issues: Memory leak patterns in long-running Node.js servers (MEDIUM confidence — multiple confirmed issues across versions)
- `src/.planning/research/*.md` existing research files (HIGH confidence — project context)

---
*Pitfalls research for: Weelo backend — broadcast flow + infrastructure hardening milestone*
*Researched: 2026-02-19*
