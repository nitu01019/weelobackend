# Weelo Backend — Agent Memory & Workflow Guide

> **Last Updated:** 2026-04-04 IST
> **Purpose:** Everything a new agent needs to understand this repo, continue the GitHub/CodeRabbit PR review workflow, and pick up exactly where the last agent left off.
> **Rule:** Update this file on EVERY session with status of what was done.

---

## 📁 Repo Location & Git Remote

| Item | Value |
|------|-------|
| **Local path** | `Desktop/weelo-backend/` |
| **GitHub repo** | `https://github.com/nitu01019/weelobackend` |
| **GitHub token** | Use `gh auth token` at runtime — never hardcode or print tokens |
| **Active PR** | https://github.com/nitu01019/weelobackend/pull/1 |
| **PR branch** | `review/coderabbit-full-pass` |
| **Base branch** | `main` |
| **Current HEAD** | `802fed9` (Round 8 fixes) |

---

## 🔁 GitHub Workflow (How to Push Fixes)

Every time you fix something, follow this exact sequence:

```bash
# 1. Go to the backend folder
cd "Desktop/weelo-backend"

# 2. Make your code changes (find_and_replace_code or create_file)

# 3. Verify TypeScript compiles — MUST BE ZERO ERRORS before committing
npx tsc --noEmit 2>&1 | head -20

# 4. Run tests — must pass
npx jest --testPathPattern="health|toggle" --forceExit 2>&1 | tail -15

# 5. Stage all changes
git add -A

# 6. Commit with a descriptive message
git commit -m "fix: <what you fixed and why>"

# 7. Push to the PR branch
git push origin review/coderabbit-full-pass

# 8. Trigger a fresh CodeRabbit review (IMPORTANT — do this after every push)
GITHUB_TOKEN="$(gh auth token)"
curl -s -X POST \
  -H "Authorization: token ${GITHUB_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"body":"@coderabbitai full review\n\nFixes applied:\n- <list what you fixed>"}' \
  "https://api.github.com/repos/nitu01019/weelobackend/issues/1/comments"
```

---

## 🐰 How to Fetch CodeRabbit Review Comments

CodeRabbit posts two types of feedback on the PR:

### Type 1: Inline code review comments (specific file + line)

```bash
GITHUB_TOKEN="$(gh auth token)"
curl -s -H "Authorization: token ${GITHUB_TOKEN}" \
  "https://api.github.com/repos/nitu01019/weelobackend/pulls/1/comments?per_page=100&sort=created&direction=desc" \
  | python3 -c "
import json,sys
comments = json.load(sys.stdin)
cr = [c for c in comments if 'coderabbit' in c.get('user',{}).get('login','').lower()]
print(f'Total CodeRabbit inline comments: {len(cr)}')
for c in cr[:30]:
    body = c['body']
    sev = 'CRITICAL' if 'Critical' in body else 'MAJOR' if 'Major' in body else 'MINOR' if 'Minor' in body else 'NITPICK'
    print(f'[{sev}] {c[\"path\"]}:{c.get(\"line\",\"?\")}')
    print(body[:400])
    print('---')
"
```

### Type 2: Summary / general comments (overall verdict)

```bash
GITHUB_TOKEN="$(gh auth token)"
curl -s -H "Authorization: token ${GITHUB_TOKEN}" \
  "https://api.github.com/repos/nitu01019/weelobackend/issues/1/comments?per_page=100" \
  | python3 -c "
import json,sys
comments = json.load(sys.stdin)
cr = [c for c in comments if 'coderabbit' in c.get('user',{}).get('login','').lower()]
print(f'Total CodeRabbit summary comments: {len(cr)}')
if cr:
    last = cr[-1]
    print('DATE:', last['created_at'])
    print(last['body'][:4000])
"
```

### Priority order to fix comments

1. 🔴 **CRITICAL** — fix immediately, blocking
2. 🟠 **MAJOR** — fix before merge
3. 🟡 **MINOR** — fix if straightforward
4. 🔵 **NITPICK** — fix markdown/style only if easy

---

## 🏗️ Project Architecture

```text
Desktop/weelo-backend/
├── prisma/schema.prisma           # PostgreSQL schema (Prisma ORM)
├── src/
│   ├── config/environment.ts      # All env vars — centralized
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── auth.service.ts    # OTP, JWT, SHA-256 hashing
│   │   │   └── auth.routes.ts
│   │   ├── assignment/
│   │   │   └── assignment.service.ts  # Driver assignment + 60s timeout
│   │   ├── booking/
│   │   │   ├── booking.service.ts     # Main booking logic + broadcasts
│   │   │   ├── booking.routes.ts      # REST endpoints
│   │   │   └── booking-payload.helper.ts
│   │   ├── driver/
│   │   │   └── driver.service.ts  # Online/offline toggle, heartbeat
│   │   ├── transporter/
│   │   │   └── transporter.routes.ts  # Availability toggle
│   │   └── order/
│   │       └── order.service.ts   # Multi-vehicle order logic
│   └── shared/
│       ├── services/
│       │   ├── redis.service.ts         # Redis singleton (InMemory fallback)
│       │   ├── socket.service.ts        # Socket.IO WebSocket server
│       │   ├── transporter-online.service.ts  # O(1) online filtering via SSCAN
│       │   ├── fcm.service.ts           # FCM push notifications
│       │   └── queue.service.ts         # Job queue (Redis-backed)
│       └── middleware/
│           └── rate-limiter.middleware.ts  # Redis-backed rate limiting
└── src/__tests__/
    ├── health.test.ts
    └── transporter-availability-toggle.test.ts  # 52 tests
```

---

## 🚀 AWS Deployment

```ini
AWS_ACCOUNT_ID=318774499084
AWS_REGION=ap-south-1
ECR_REPO=318774499084.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend
ECS_CLUSTER=weelocluster
ECS_SERVICE=weelobackendtask-service-joxh3c0r
ALB_URL=http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com
```

### Deploy to AWS (only after PR is merged to main)

```bash
cd "Desktop/weelo-backend"

# 1. ECR Login
aws ecr get-login-password --region ap-south-1 | \
  docker login --username AWS --password-stdin \
  318774499084.dkr.ecr.ap-south-1.amazonaws.com

# 2. Build & Push (linux/amd64 — REQUIRED for ECS Fargate)
docker buildx build --platform linux/amd64 -f Dockerfile.production --no-cache --push \
  -t 318774499084.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend:latest .

# 3. Force ECS rolling deployment
aws ecs update-service \
  --cluster weelocluster \
  --service weelobackendtask-service-joxh3c0r \
  --force-new-deployment \
  --region ap-south-1

# 4. Health check
curl -s http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com/health | python3 -m json.tool
```

---

## ✅ Key Patterns (Do NOT break these)

1. **All Redis ops have `.catch()` fallback** — Redis down must never crash a user request.
2. **Atomic DB updates use `updateMany` with `where: { status: 'pending' }`** — prevents race conditions on concurrent accept/decline/timeout.
3. **Distributed locks** — `SET NX EX` pattern. Always set short TTL to prevent deadlocks.
4. **Graceful degradation** — Redis down → fall back to DB. DB slow → return cached data.
5. **TypeScript strict** — `tsc --noEmit` must show 0 errors before every commit.
6. **Test suite** — 54 tests must pass. Run: `npx jest --forceExit 2>&1 | tail -10`
7. **No `setTimeout()`** — use `redisService.setTimer()` so timers survive restarts.
8. **No `require()` inside functions** — all imports at top of file.
9. **SSCAN not SMEMBERS** — always use `redisService.sScan()` for set iteration (safe at 10K+ members).
10. **Timer before DB write** — always delete Redis timers BEFORE atomic DB status updates.

---

## 🔄 Session Log

### 2026-04-04 — Industry-Standard Fixes for 16 Verified Production Problems

**Process:** 186 problems found by 5 audit agents → 20 most dangerous selected → 3 agents verified against code → 13 confirmed real, 6 partial, 1 false → 3 research agents found industry solutions (Uber/Stripe/Grab/Ticketmaster) → 5 fix agents + 5 QA agents + 5 test agents implemented → 5 review agents verified industry compliance → 3 gap-check agents confirmed all gaps overstated.

**TypeScript:** 0 errors | **Tests:** 519 pass / 3 pre-existing OTP fail | **New tests:** 93

#### 16 Fixes Applied (Industry Patterns)

| # | Problem | Fix | File(s) | Pattern |
|---|---------|-----|---------|---------|
| P1 | Confirmed hold wrong column | `tripId` → `id` in 4 places | confirmed-hold.service.ts | Primary Key Lookup (Ticketmaster) |
| P2 | Vehicle stuck after completion | VEHICLE_RELEASE retry queue + orphaned vehicle reconciliation | queue.service.ts, tracking.service.ts | Retry + Reconciliation (Google SRE) |
| P3 | Redis silent fallback | `isDegraded` flag + health endpoint reports degraded | redis.service.ts, health.routes.ts | Degraded Mode (Uber CacheFront) |
| P6 | Decline missing cleanup | releaseVehicle + trucksFilled GREATEST(0,...) decrement | confirmed-hold.service.ts | Saga Compensation (Temporal) |
| P7 | Fare uses client distance | Moved fare check AFTER Google Directions | booking.service.ts | Server-Authoritative Pricing (Uber/Lyft) |
| P8 | Timer before auth check | Moved clearBookingTimers AFTER ownership verified | booking.service.ts | Authorize-Before-Act (OWASP API1:2023) |
| P9 | No vehicle lock on accept | Added vehicle.updateMany(status:available→on_hold) inside Serializable TX | broadcast.service.ts | Atomic Reservation (Uber) |
| P10 | trucksFilled double-count risk | SQL WHERE trucksFilled < trucksNeeded guard | booking.service.ts | Idempotent Counter (Stripe) |
| P11 | KEYS command blocks Redis | Replaced with scanIterator() everywhere | redis.service.ts, server.ts | SCAN (Redis Official) |
| P13 | WebSocket no auth on join | Set transporterId from DB during socket auth, verify on join | socket.service.ts | Claims-Based Room Auth (Socket.IO/OWASP) |
| P14 | Redis restart = all offline | Reconnect grace period (60s) + stale cleanup skip + heartbeat presence restore | transporter-online.service.ts, socket.service.ts, server.ts | Cache Warming (Uber CDC) |
| P16 | setTimeout lost on restart | Redis sorted set timers via setTimer/getExpiredTimers | queue.service.ts, assignment.service.ts | Durable Timers (Uber Cadence) |
| P17 | No WebSocket rate limiting | Per-connection 30/sec limit with Map cleanup on disconnect | socket.service.ts | Token Bucket Rate Limiting |
| P18 | 3 paths bypass releaseVehicle | booking cancel + order expiry routed through releaseVehicle() | booking.service.ts, order.service.ts, tracking.service.ts | DDD Aggregate Root (Uber State Machine) |
| P19 | SLA monitor wrong field | `timestamp` → `lastUpdated` with legacy fallback | trip-sla-monitor.job.ts | Field Fix |
| P20 | Cancel ignores in_transit | All 6 non-terminal statuses + driver socket/FCM notification | booking.service.ts | Stage-Aware Cancellation (Uber/Gojek) |
| Bonus | cancelAssignment missing timer cancel | Added cancelAssignmentTimeout call | assignment.service.ts | Timer Cleanup (found by review agent) |
| Note | Redis restart presence recovery | ALREADY HANDLED by socket reconnect handler (line 556-574) — checks DB isAvailable, restores if true | socket.service.ts | Presence Restoration via DB truth |

#### Files Modified (16 files)

| File | Changes |
|------|---------|
| `confirmed-hold.service.ts` | P1 column fix + P6 decline cleanup |
| `booking.service.ts` | P7 fare order + P8 auth order + P10 guard + P18 release + P20 cancel expansion |
| `broadcast.service.ts` | P9 vehicle lock in TX |
| `redis.service.ts` | P3 isDegraded + P11 SCAN + P14 onReconnect |
| `transporter-online.service.ts` | P14 grace period |
| `server.ts` | P3 health degraded + P11 SCAN + P14 reconnect wiring |
| `health.routes.ts` | P3 degraded status in health response |
| `socket.service.ts` | P13 auth + P17 rate limiting + P14 heartbeat restore |
| `queue.service.ts` | P2 retry queue + P2 reconciliation + P16 durable timers |
| `tracking.service.ts` | P2 retry on failure + P18 use releaseVehicle |
| `vehicle-lifecycle.service.ts` | P2 import |
| `order.service.ts` | P18 use releaseVehicle in handleOrderExpiry |
| `assignment.service.ts` | P16 cancelAssignmentTimeout in accept/cancel/decline |
| `trip-sla-monitor.job.ts` | P19 field fix |

#### New Test Files (93 tests)

| File | Tests | Coverage |
|------|-------|----------|
| `hold-fixes.test.ts` | 18 | P1 column fix + P6 decline cleanup |
| `booking-fixes.test.ts` | 14 | P7 fare + P8 auth + P9 vehicle lock + P20 cancel |
| `redis-fixes.test.ts` | 11 | P3 degraded + P11 SCAN + P14 grace period |
| `vehicle-fixes.test.ts` | 19 | P2 retry + P2 reconciliation + P18 bypass fixes |
| `websocket-fixes.test.ts` | 30 | P13 auth + P16 timers + P17 rate limit + P10 counter + P19 SLA |

#### Gap Analysis (All 8 "gaps" verified as OVERSTATED)

| Gap | Claimed Issue | Verified Result |
|-----|--------------|----------------|
| P3 | No circuit breaker | OVERSTATED — full CB system already exists for H3/FCM/Directions/Queue |
| P7 | Client can manipulate fare | NOT AN ISSUE — Google distance OVERWRITES client value before fare check |
| P13 | DB query every connection | OVERSTATED — runs once per connection, PK lookup, cached in socket.data |
| P14 | Grace period not enough | OVERSTATED — stale cleanup only removes missing, socket reconnect restores |
| P16 | Custom timers vs BullMQ | OVERSTATED — uses same Redis sorted set as BullMQ, has DLQ/retry/persistence |
| P17 | Rate limit not distributed | NOT A GAP — WebSocket is persistent TCP, always pinned to one instance |
| P18 | cancelOrder bypass | ARCHITECTURALLY JUSTIFIED — releaseVehicle doesn't accept TX client |
| P2 | Missing jitter | OVERSTATED — 2 BRPOP workers serialize naturally, no thundering herd |

#### Research & Audit Files (on disk)

| File | Content |
|------|---------|
| `Desktop/PROBLEMS.md` | Master summary of 186 problems |
| `Desktop/CRITICAL-SOLUTIONS.md` | 19 problems + industry solutions |
| `AUDIT-1-BOOKING.md` | 35 booking creation problems |
| `AUDIT-2-MATCHING.md` | 36 matching/broadcast problems |
| `AUDIT-3-ACCEPT.md` | 50 accept/assignment problems |
| `AUDIT-4-TRIP.md` | 35 trip/release problems |
| `AUDIT-5-CROSSFLOW.md` | 30 cross-flow/system problems |
| `INDUSTRY-RESEARCH-1/2/3.md` | Solutions from Uber/Stripe/Grab/Ticketmaster |
| `VERIFY-GROUP-1/2/3.md` | Line-by-line code verification |
| `FINAL-VERIFICATION.md` | Re-verification of all 20 problems |
| `FINAL-REVIEW-1/2/3/4/5.md` | Industry standard code reviews |
| `GAP-VERIFY-1/2/3.md` | Gap verification results |
| `FIX-PRD.md` | Implementation PRD with agent assignments |
| `QA-*-REVIEW.md` | QA review reports per group |

### 2026-03-23 — Transporter to Driver Pending-Assignment Hotfix ✅ LOCAL

- ✅ `truck-hold.service.ts` — removed early `vehicle.status = in_transit` / live availability promotion from `confirm-with-assignments`
- ✅ `truck-hold.service.ts` — added active-vehicle assignment validation alongside existing active-driver validation, including transactional re-checks
- ✅ `assignment.service.ts` — multi-truck decline/timeout/cancel now restore truck-request assignment metadata consistently and decrement `order.trucksFilled` when `bookingId` is absent
- ✅ `assignment.service.ts` — booking-room emits now fall back to `orderId` when legacy `bookingId` is absent
- ✅ `progress.service.ts` — `GET /truck-hold/order-assignments/:orderId` now returns pending/declined/in-progress rows for transporter tracking instead of accepted-only rows
- ✅ `tsc --noEmit` — 0 errors
- ✅ `npx jest --testPathPattern="health|toggle" --forceExit` — 54/54 passed
- ℹ️ Android app repo updated separately in the paired workspace to add global driver assignment ingress + transporter tracking route/screen
- 🔄 Changes are local only in this session (no commit/push performed)

### 2026-02-20 — CodeRabbit Round 8 Fixes ✅ PUSHED

- ✅ `assignment.service.ts:218` — CRITICAL: `db.createAssignment` inside Serializable `$transaction` replaced with `tx.assignment.create` — now actually uses tx context, preventing concurrent duplicate assignments
- ✅ `assignment.service.ts:726` — `status: 'expired'` → `status: 'driver_declined', reason: 'timeout'` — driver WebSocket event now matches DB state
- ✅ `prisma/migrations/...migration.sql` — `stateChangedAt` backfilled from `createdAt` not `CURRENT_TIMESTAMP` — existing rows now have correct timestamps
- ✅ `.planning/.../01-05-PLAN.md` — Added H1 heading after front matter (MD041)
- ✅ tsc — 0 errors, Tests — 54/54 passed
- 🔄 Waiting for CodeRabbit Round 8 verdict

### 2026-02-20 — CodeRabbit Round 7 Fixes ✅ PUSHED

- ✅ `booking.routes.ts` — rating groupBy queries parallelized with `Promise.all`
- ✅ `AGENTS.md` — `gh auth token` pattern, MD040/MD031/MD022 fixes
- ✅ tsc — 0 errors, Tests — 54/54 passed, pushed `5ec4dae`

### 2026-02-20 — CodeRabbit Round 6 Fixes ✅ PUSHED

- ✅ `cancelBooking` — timers deleted BEFORE atomic `updateMany` (race condition fix)
- ✅ `redis.service.ts` — added `sScan()` to `IRedisClient` interface + all 3 implementations
- ✅ `transporter-online.service.ts` — `getOnlineSet()` uses SSCAN cursor loop (was SMEMBERS)
- ✅ `deliverMissedBroadcasts` — 30s per-transporter Redis rate limit (DOS prevention)
- ✅ `booking.routes.ts` — rating groupBy queries parallelized with `Promise.all`
- ✅ tsc — 0 errors
- ✅ Tests — 54/54 passed
- ✅ Pushed commit `1692ded` to `review/coderabbit-full-pass`
- 🔄 Waiting for CodeRabbit Round 6 verdict

### 2026-02-19 23:30 IST — CodeRabbit Round 5 Fixes ✅ PUSHED

- ✅ `handleAssignmentTimeout` — atomic `updateMany` with `status: 'pending'` precondition
- ✅ `auth.service.ts hashToken()` — removed redundant inline `require('crypto')`
- ✅ `deliverMissedBroadcasts` — 30-minute time window + cap at 20 bookings
- ✅ tsc — 0 errors, Tests — 54/54 passed, pushed `6b72d5e`

### 2026-03-03 — Broadcast Dispatch System Upgrade (6-Phase PRD)

**PRD Document:** See conversation artifact `weelo_dispatch_prd_v2.md`

**CRITICAL RULES (NON-NEGOTIABLE):**
- ⚠️ **ZERO latency regression** — do not touch anything that increases latency
- ⚠️ **Broadcasts go to TRANSPORTERS ONLY** — never to drivers
- ⚠️ **HTTP is intentional** — do not change transport layer
- ⚠️ **All new algorithms behind feature flags, default OFF**
- ⚠️ **Complete one phase at a time** — do not combine phases

**6 Phases (in order):**
1. **Phase 1 — Edge Layer & Request Hardening** — 24h idempotency, rate limits, one-active-order
2. **Phase 2 — H3 Geo-Index** — hexagonal grid candidate lookup (`h3-js`), 7 progressive steps 
3. **Phase 3 — Google Directions API ETA Scoring** — road-time ETA for top-20 candidates, cached 3 min
4. **Phase 4 — Guaranteed Delivery (2G/3G safe)** — seq-numbered messages, priority buckets, TTLs, FCM parallel
5. **Phase 5 — Resilience** — circuit breakers, adaptive fanout, backpressure controls
6. **Phase 6 — Observability** — metrics, SLO dashboards, pre-deploy latency gates

**Current Status:** Phase 1 in progress.

### What to do next session

1. Check which phase is current (see Phase status above)
2. Read the PRD v2 artifact for full technical details of each phase
3. Complete the current phase fully before moving to next
4. Run `tsc --noEmit` — ZERO errors before any commit
5. Run tests — all must pass
6. Push + trigger CodeRabbit re-review
7. Update this session log with what was done
