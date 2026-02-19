# Weelo Backend — Agent Memory & Workflow Guide

> **Last Updated:** 2026-02-19 23:30 IST  
> **Purpose:** Everything a new agent needs to understand this repo, continue the GitHub/CodeRabbit PR review workflow, and pick up exactly where the last agent left off.  
> **Rule:** Update this file on EVERY session with status of what was done.

---

## 📁 Repo Location & Git Remote

| Item | Value |
|------|-------|
| **Local path** | `Desktop/weelo-backend/` |
| **GitHub repo** | `https://github.com/nitu01019/weelobackend` |
| **GitHub token** | Stored in local env — run `cat ~/.netrc` or ask the user. Do NOT hardcode here. |
| **Active PR** | https://github.com/nitu01019/weelobackend/pull/1 |
| **PR branch** | `review/coderabbit-full-pass` |
| **Base branch** | `main` |
| **Current HEAD** | `6b72d5e` |

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
curl -s -X POST \
  -H "Authorization: token YOUR_GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body":"@coderabbitai full review\n\nFixes applied:\n- <list what you fixed>"}' \
  "https://api.github.com/repos/nitu01019/weelobackend/issues/1/comments"
```

---

## 🐰 How to Fetch CodeRabbit Review Comments

CodeRabbit posts two types of feedback on the PR:

### Type 1: Inline code review comments (specific file + line)
```bash
curl -s -H "Authorization: token YOUR_GITHUB_TOKEN" \
  "https://api.github.com/repos/nitu01019/weelobackend/pulls/1/comments?per_page=100&sort=created&direction=desc" \
  | python3 -c "
import json,sys
comments = json.load(sys.stdin)
cr = [c for c in comments if 'coderabbit' in c.get('user',{}).get('login','').lower()]
print(f'Total CodeRabbit inline comments: {len(cr)}')
for c in cr[:30]:
    body = c['body']
    sev = 'CRITICAL' if '🔴' in body else 'MAJOR' if '🟠' in body else 'MINOR' if '🟡' in body else 'NITPICK'
    print(f'[{sev}] {c[\"path\"]}:{c.get(\"line\",\"?\")}')
    print(body[:400])
    print('---')
"
```

### Type 2: Summary / general comments (overall verdict)
```bash
curl -s -H "Authorization: token YOUR_GITHUB_TOKEN" \
  "https://api.github.com/repos/nitu01019/weelobackend/issues/1/comments?per_page=100" \
  | python3 -c "
import json,sys
comments = json.load(sys.stdin)
cr = [c for c in comments if 'coderabbit' in c.get('user',{}).get('login','').lower()]
print(f'Total CodeRabbit summary comments: {len(cr)}')
# Print the LATEST one (most recent verdict)
if cr:
    last = cr[-1]
    print('DATE:', last['created_at'])
    print(last['body'][:4000])
"
```

### Priority order to fix comments:
1. 🔴 **CRITICAL** — fix immediately, blocking
2. 🟠 **MAJOR** — fix before merge
3. 🟡 **MINOR** — fix if straightforward
4. 🔵 **Nitpick/Trivial** — fix markdown/style issues last

---

## 📊 Current PR Status (as of 2026-02-19)

### What has been done (all merged into `review/coderabbit-full-pass`):

| Round | Fixes | Commit |
|-------|-------|--------|
| Phase 1/2/3 — 22 verified bugs | Race conditions, security, N+1 queries, Redis timers | `48efae6` |
| CodeRabbit Round 1 | 37 actionable comments fixed | `f983f14` |
| CodeRabbit Round 2 | 14 comments fixed | `731707b` |
| CodeRabbit Round 3 | 6 comments fixed | — |
| CodeRabbit Round 4 | 2 comments fixed (OTP abort, `as any` → `Prisma.JsonObject`) | — |
| **Latest push** | handleAssignmentTimeout atomic race fix, remove redundant `require('crypto')`, deliverMissedBroadcasts 30-min window + cap at 20 | `6b72d5e` |

### ⚠️ REMAINING CodeRabbit comments (open as of last review):

These are the issues CodeRabbit flagged and that are **NOT yet fixed**. Fix these next:

#### 🔴 CRITICAL
- **`src/modules/assignment/assignment.service.ts:218`** — Potential critical issue in `createAssignment` (exact body was truncated in fetch — run the fetch command above to get full details, look for the comment at line 218)

#### 🟠 MAJOR
- **`src/modules/assignment/assignment.service.ts:610`** — `declineAssignment`: Wrap `redisService.cancelTimer()` in `.catch()` so Redis failures don't abort the decline flow. Fix:
  ```typescript
  // BEFORE:
  await redisService.cancelTimer(TIMER_KEYS.ASSIGNMENT_EXPIRY(assignmentId));
  // AFTER:
  await redisService.cancelTimer(TIMER_KEYS.ASSIGNMENT_EXPIRY(assignmentId))
    .catch(err => logger.warn(`Timer cancel failed (non-critical): ${err.message}`));
  ```
- **`src/config/environment.ts:213`** — CORS configuration issue (fetch full comment to see exact problem — likely overly permissive CORS origin)

#### 🟡 MINOR
- **`src/modules/assignment/assignment.service.ts:732`** — Driver receives `status: 'expired'` in WebSocket notification but DB stores `'driver_declined'`. Client-side state mismatch risk. Fix: use `status: 'driver_declined', reason: 'timeout'` or add `'expired'` to Prisma schema enum.
- **`src/modules/booking/booking.service.ts:583`** — Some issue in booking service around line 583 (fetch full comment)
- **`src/modules/booking/booking.routes.ts:96`** — Parallelize rating aggregation queries (currently sequential, should be `Promise.all([ratedQuery, totalQuery])`)
- **`src/modules/booking/booking-payload.helper.ts:97`** — `radiusStep` related issue
- **`src/modules/booking/booking.service.ts:728`** — Doc comment says "clears timers" but method actually clears active-broadcast key and idempotency pointers. Update the comment.

#### 🔵 NITPICK (Markdown files — fix these last)
- **`src/modules/assignment/assignment.service.ts:248`** — Operation ordering: Redis timer set before `incrementTrucksFilled`. Document that timeout cleanup is the recovery mechanism, or add try-catch that cancels timer on failure.
- **`src/modules/assignment/assignment.service.ts:125`** — `processExpiredAssignments` has no batch limit. Add `slice(0, 50)` cap.
- **`.planning/phases/01-broadcast-lifecycle-correctness/01-01-PLAN.md:5`** — MD041 heading issue
- **`.planning/codebase/CONCERNS.md:44`** — MD031 blank lines around fenced code blocks
- **`.planning/codebase/CONVENTIONS.md:188`** — Add language specifier to code block
- **`.planning/codebase/CONVENTIONS.md:60`** — Add blank lines + language specifiers
- **`.planning/codebase/ARCHITECTURE.md:241`** — Blank line before fenced code block

---

## 🏗️ Project Architecture

```
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
│       │   ├── transporter-online.service.ts  # O(1) online filtering
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

```
AWS_ACCOUNT_ID=318774499084
AWS_REGION=ap-south-1
ECR_REPO=318774499084.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend
ECS_CLUSTER=weelocluster
ECS_SERVICE=weelobackendtask-service-joxh3c0r
ALB_URL=http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com
```

### Deploy to AWS (only do this after PR is merged to main):
```bash
cd "Desktop/weelo-backend"

# 1. ECR Login
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 318774499084.dkr.ecr.ap-south-1.amazonaws.com

# 2. Build & Push (linux/amd64 — REQUIRED for ECS Fargate)
docker buildx build --platform linux/amd64 -f Dockerfile.production --no-cache --push \
  -t 318774499084.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend:latest .

# 3. Force ECS rolling deployment
aws ecs update-service --cluster weelocluster --service weelobackendtask-service-joxh3c0r \
  --force-new-deployment --region ap-south-1

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

---

## 🔄 Session Log

### 2026-02-19 23:30 IST — CodeRabbit Full Pass — Round 5 Fixes ✅ PUSHED
- ✅ `handleAssignmentTimeout` — atomic `updateMany` with `status: 'pending'` precondition (race condition fix)
- ✅ `auth.service.ts hashToken()` — removed redundant inline `require('crypto')`
- ✅ `deliverMissedBroadcasts` — added 30-minute time window + cap at 20 bookings
- ✅ tsc — 0 errors
- ✅ Tests — 54/54 passed
- ✅ Pushed to `review/coderabbit-full-pass` as commit `6b72d5e`
- ✅ CodeRabbit re-review triggered
- 🔄 Waiting for CodeRabbit Round 5 verdict

### What to do next session:
1. Run the "fetch CodeRabbit comments" command above to get the Round 5 verdict
2. Fix remaining issues in priority order: CRITICAL → MAJOR → MINOR → NITPICK
3. Push + trigger re-review
4. Repeat until CodeRabbit approves / no actionable comments remain
5. Then merge `review/coderabbit-full-pass` → `main` and deploy to AWS
