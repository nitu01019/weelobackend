# Weelo Backend — Agent Memory & Workflow Guide

> **Last Updated:** 2026-02-19 IST
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

### What to do next session

1. Run the "fetch CodeRabbit comments" command above to get the latest verdict
2. Fix remaining issues in priority order: CRITICAL → MAJOR → MINOR → NITPICK
3. Push + trigger re-review
4. Repeat until CodeRabbit approves / no actionable comments remain
5. Merge `review/coderabbit-full-pass` → `main` and deploy to AWS
