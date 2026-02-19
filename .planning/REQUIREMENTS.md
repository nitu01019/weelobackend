# Requirements: Weelo

**Defined:** 2026-02-19
**Core Value:** Customers can reliably search for trucks, get matched with available transporters, and track shipments — with zero ghost requests, zero stuck states, and real-time visibility for all parties.

## v1 Requirements

Requirements for this milestone. Each maps to roadmap phases.

### Broadcast Lifecycle

- [ ] **BCAST-01**: Broadcast has explicit lifecycle states: Created → Broadcasting → Awaiting Responses → Terminal (Accepted / Cancelled / Expired / Closed)
- [ ] **BCAST-02**: Broadcast state transitions are persisted in database with timestamps for audit trail
- [ ] **BCAST-03**: Broadcast state is visible to customer in real-time via WebSocket events
- [ ] **BCAST-04**: Broadcast state is visible to transporter in real-time via WebSocket events
- [ ] **BCAST-05**: Terminal broadcasts are automatically removed from transporter actionable views

### One-Active-Per-Customer

- [ ] **CUST-01**: Server enforces maximum one active broadcast per customer at any time
- [ ] **CUST-02**: Customer attempting new search while one is active sees "Request already in progress. Cancel it first."
- [ ] **CUST-03**: Multiple different customers can have concurrent active broadcasts (no cross-customer blocking)
- [ ] **CUST-04**: After broadcast reaches terminal state, customer can immediately start new search

### Atomic Accept

- [ ] **ACPT-01**: Only one transporter can accept a broadcast (exactly-one-winner rule enforced atomically)
- [ ] **ACPT-02**: Concurrent accept attempts on same broadcast: first wins, others get "No longer available"
- [ ] **ACPT-03**: Accept uses atomic database operation (UPDATE WHERE status = active) — no read-check-write race
- [ ] **ACPT-04**: Both Booking path and Order path acceptance are atomic (fix exists in Booking, missing in Order)

### Idempotent Search

- [ ] **IDEM-01**: Double-tap on search button creates only one broadcast (server-side dedup)
- [ ] **IDEM-02**: Network retry of search request reuses existing broadcast (not create duplicate)
- [ ] **IDEM-03**: Idempotency key is server-generated per search session (not client-optional)

### Cancel & Cleanup

- [ ] **CNCL-01**: Customer can cancel active broadcast at any point — even after transporter accepted and driver assignment is in progress
- [ ] **CNCL-02**: Cancel is immediate and absolute: backend state, transporter view, and driver view all update within seconds
- [ ] **CNCL-03**: On cancel, transporter sees "Order was cancelled" message on their screen, order softly removed from active list, screen scrolls to next order
- [ ] **CNCL-04**: On cancel, if driver was already assigned/notified, driver sees "Trip cancelled" and assignment is reverted
- [ ] **CNCL-05**: Cancel clears all Redis state: broadcast timers, presence keys, lock keys, notified transporter sets
- [ ] **CNCL-06**: Cancel is idempotent — multiple cancel requests for same broadcast all succeed without error
- [ ] **CNCL-07**: Cancel-vs-accept race: if cancel and accept arrive simultaneously, cancel wins — transporter sees "Request cancelled" not "Accepted"

### Timeout & Auto-Cleanup

- [ ] **TMOT-01**: Broadcast expires after configurable timeout (env var BROADCAST_TIMEOUT_SECONDS, default 120s)
- [ ] **TMOT-02**: On timeout, customer sees "No transporters found / Request expired" with retry option
- [ ] **TMOT-03**: On timeout, all transporters see broadcast removed from actionable views
- [ ] **TMOT-04**: On timeout, full cleanup runs (same as cancel: DB + Redis + WebSocket)
- [ ] **TMOT-05**: Timeout is unified across Booking and Order paths (single configurable value)

### Timer Service

- [ ] **TIMR-01**: Single shared timer.service.ts replaces 3 duplicate expiry checker implementations
- [ ] **TIMR-02**: Timers survive ECS rolling deployments (Redis-backed, not in-memory setInterval)
- [ ] **TIMR-03**: Countdown notifications to customer are trackable and cancellable across ECS instances
- [ ] **TIMR-04**: Distributed lock prevents duplicate timer processing across ECS tasks

### Secrets Manager

- [ ] **SECR-01**: DATABASE_URL migrated from plaintext ECS env var to AWS Secrets Manager
- [ ] **SECR-02**: JWT_SECRET and JWT_REFRESH_SECRET migrated to Secrets Manager
- [ ] **SECR-03**: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY removed from ECS env vars (use task role instead)
- [ ] **SECR-04**: All previously-plaintext secret values rotated after migration
- [ ] **SECR-05**: Old task definition revisions with plaintext secrets deregistered
- [ ] **SECR-06**: Application reads secrets from Secrets Manager at startup (not runtime per-request)

### CI/CD Pipeline

- [ ] **CICD-01**: GitHub Actions workflow: build TypeScript, run tests, build Docker image, push to ECR, deploy to ECS
- [ ] **CICD-02**: OIDC-based AWS authentication (no static IAM credentials in GitHub Secrets)
- [ ] **CICD-03**: Pipeline runs on push to main branch
- [ ] **CICD-04**: Pipeline blocks deploy if tests fail
- [ ] **CICD-05**: Rolling deployment with health check verification before marking stable

### RDS Hardening

- [ ] **RDS-01**: Deletion protection enabled on production RDS instance
- [ ] **RDS-02**: Backup retention increased from 1 day to 7 days
- [ ] **RDS-03**: Multi-AZ enabled for automatic failover (scheduled off-peak for I/O freeze)

### Socket.IO Redis Adapter

- [ ] **SOCK-01**: @socket.io/redis-adapter installed for correct cross-ECS-instance event delivery
- [ ] **SOCK-02**: Room-scoped events (booking:{id}) delivered to all connected clients regardless of which ECS task they're on
- [ ] **SOCK-03**: Existing custom pub/sub replaced with adapter's built-in mechanism
- [ ] **SOCK-04**: Redundant `redis` npm package removed (ioredis handles everything)

### Driver Visibility (Real-Time)

- [ ] **DRVR-01**: Driver online/offline status updates reflected on transporter driver list within seconds via WebSocket
- [ ] **DRVR-02**: Driver status updates reflected on transporter driver details page
- [ ] **DRVR-03**: Driver status updates reflected on assignment selection screens
- [ ] **DRVR-04**: Transporter views update automatically (no manual refresh required for correct status)

## v2 Requirements

Deferred to future milestone. Tracked but not in current roadmap.

### HTTPS & Security

- **HTTPS-01**: ACM certificate + ALB HTTPS listener + HTTP→HTTPS redirect
- **HTTPS-02**: WAF on ALB for OWASP top 10 protection
- **HTTPS-03**: tsconfig strict mode enabled (incremental hardening)

### Advanced Features

- **ADV-01**: Broadcast history screen for customer (past searches with outcomes)
- **ADV-02**: Broadcast analytics for transporter (acceptance rate, response time)
- **ADV-03**: PgBouncer connection pooling for scale beyond current RDS limits
- **ADV-04**: Auto-cancel previous broadcast on new search (alternative to block)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Pricing algorithm changes | Current pricing logic is stable and working |
| Customer App Compose migration | XML layouts work fine, not a priority |
| Mobile app UI redesign | Focus on backend reliability, not UI changes |
| HTTPS/SSL | No domain available yet, HTTP works for current stage |
| WAF | Depends on HTTPS being set up first |
| Real-time chat | High complexity, not core to logistics value |
| Payment integration | Separate milestone when ready |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| BCAST-01 | Phase 1 | Pending |
| BCAST-02 | Phase 1 | Pending |
| BCAST-03 | Phase 1 | Pending |
| BCAST-04 | Phase 1 | Pending |
| BCAST-05 | Phase 1 | Pending |
| CUST-01 | Phase 1 | Pending |
| CUST-02 | Phase 1 | Pending |
| CUST-03 | Phase 1 | Pending |
| CUST-04 | Phase 1 | Pending |
| ACPT-01 | Phase 1 | Pending |
| ACPT-02 | Phase 1 | Pending |
| ACPT-03 | Phase 1 | Pending |
| ACPT-04 | Phase 1 | Pending |
| IDEM-01 | Phase 1 | Pending |
| IDEM-02 | Phase 1 | Pending |
| IDEM-03 | Phase 1 | Pending |
| CNCL-01 | Phase 1 | Pending |
| CNCL-02 | Phase 1 | Pending |
| CNCL-03 | Phase 2 | Pending |
| CNCL-04 | Phase 2 | Pending |
| CNCL-05 | Phase 1 | Pending |
| CNCL-06 | Phase 1 | Pending |
| CNCL-07 | Phase 1 | Pending |
| TMOT-01 | Phase 2 | Pending |
| TMOT-02 | Phase 2 | Pending |
| TMOT-03 | Phase 2 | Pending |
| TMOT-04 | Phase 2 | Pending |
| TMOT-05 | Phase 2 | Pending |
| TIMR-01 | Phase 2 | Pending |
| TIMR-02 | Phase 2 | Pending |
| TIMR-03 | Phase 2 | Pending |
| TIMR-04 | Phase 2 | Pending |
| SECR-01 | Phase 3 | Pending |
| SECR-02 | Phase 3 | Pending |
| SECR-03 | Phase 3 | Pending |
| SECR-04 | Phase 3 | Pending |
| SECR-05 | Phase 3 | Pending |
| SECR-06 | Phase 3 | Pending |
| CICD-01 | Phase 4 | Pending |
| CICD-02 | Phase 4 | Pending |
| CICD-03 | Phase 4 | Pending |
| CICD-04 | Phase 4 | Pending |
| CICD-05 | Phase 4 | Pending |
| RDS-01 | Phase 3 | Pending |
| RDS-02 | Phase 3 | Pending |
| RDS-03 | Phase 3 | Pending |
| SOCK-01 | Phase 3 | Pending |
| SOCK-02 | Phase 3 | Pending |
| SOCK-03 | Phase 3 | Pending |
| SOCK-04 | Phase 3 | Pending |
| DRVR-01 | Phase 4 | Pending |
| DRVR-02 | Phase 4 | Pending |
| DRVR-03 | Phase 4 | Pending |
| DRVR-04 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 52 total
- Mapped to phases: 52
- Unmapped: 0

---
*Requirements defined: 2026-02-19*
*Last updated: 2026-02-19 — traceability populated after roadmap creation*
