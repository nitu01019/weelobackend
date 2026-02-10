# 🤖 AGENTS.md - AI Agent Instructions for Weelo Backend

> **For AI Agents**: Read this file FIRST before making any changes to this project.

---

## ⚠️ CRITICAL: Docker Build Rules

**ALWAYS use this exact command to build and deploy:**

```bash
cd Desktop/weelo-backend && npm run build && docker buildx build --platform linux/amd64 --target production --no-cache --push -t 318774499084.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend:latest . && aws ecs update-service --cluster weelocluster --service weelobackendtask-service-joxh3c0r --force-new-deployment --region ap-south-1
```

### Why These Flags Are Required:

| Flag | Reason |
|------|--------|
| `--platform linux/amd64` | Mac builds ARM64, ECS needs AMD64 |
| `--target production` | Ensures Prisma is generated for Alpine Linux |
| `--no-cache` | Prevents stale Mac Prisma binaries |
| `--push` | Pushes directly with correct manifest |

### ❌ NEVER DO THIS:
- `docker build .` (wrong platform)
- `docker buildx build --push .` (missing target, may use dev stage)
- Build without `--no-cache` after Prisma schema changes

---

## 🏗️ Project Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    WEELO ECOSYSTEM                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  CUSTOMER APP (Weelo)        CAPTAIN APP (Weelo Captain)   │
│  └─ Customers                └─ Transporters + Drivers     │
│                                                             │
│                        ↓                                    │
│                                                             │
│              WEELO BACKEND (This Project)                   │
│              ├─ /auth/* - Customer/Transporter auth         │
│              ├─ /driver-auth/* - Driver auth                │
│              ├─ /booking/* - Orders                         │
│              └─ /tracking/* - Real-time tracking            │
│                                                             │
│                        ↓                                    │
│                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    │
│  │ PostgreSQL  │    │    Redis    │    │     SMS     │    │
│  │   (RDS)     │    │(ElastiCache)│    │   Service   │    │
│  └─────────────┘    └─────────────┘    └─────────────┘    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔐 OTP Authentication - Key Points

### Driver OTP Goes to TRANSPORTER (Not Driver!)

```
Driver enters phone → Backend finds driver's transporter → OTP sent to TRANSPORTER
```

This is **BY DESIGN** to ensure transporters control driver access.

### Endpoints:
- `/api/v1/auth/send-otp` - Customer/Transporter (OTP to their phone)
- `/api/v1/driver-auth/send-otp` - Driver (OTP to transporter's phone)

### Both auth modules use:
- Redis for OTP storage (TTL auto-expiry)
- bcrypt for OTP hashing
- Same config values (`config.otp.*`)

---

## ☁️ AWS Resources

| Resource | Value |
|----------|-------|
| Region | `ap-south-1` |
| ECS Cluster | `weelocluster` |
| ECS Service | `weelobackendtask-service-joxh3c0r` |
| ECR Repo | `318774499084.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend` |
| ALB URL | `http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com` |
| CloudWatch Logs | `weelobackendtask` |

---

## 🔍 Debugging Commands

### Check deployment status:
```bash
aws ecs describe-services --cluster weelocluster --services weelobackendtask-service-joxh3c0r --region ap-south-1 --query 'services[0].{running:runningCount,rollout:deployments[0].rolloutState}' --output table
```

### Check logs:
```bash
aws logs filter-log-events --log-group-name "weelobackendtask" --region ap-south-1 --limit 30 --query 'events[*].message' --output text
```

### Test health:
```bash
curl -s http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com/health | jq .
```

### Check events (for errors):
```bash
aws ecs describe-services --cluster weelocluster --services weelobackendtask-service-joxh3c0r --region ap-south-1 --query 'services[0].events[0:5].message' --output text
```

---

## 📁 Key Files

| File | Purpose |
|------|---------|
| `Dockerfile` | 3-stage build (builder → deps → production) |
| `prisma/schema.prisma` | Database schema with `binaryTargets` for linux-musl |
| `src/modules/auth/` | Customer/Transporter authentication |
| `src/modules/driver-auth/` | Driver authentication (OTP to transporter) |
| `AUTH_ARCHITECTURE.md` | Detailed OTP flow documentation |
| `DEPLOYMENT_GUIDE.md` | Full deployment & troubleshooting guide |

---

## 🚨 Common Errors & Fixes

### Error: "CannotPullContainerError: image Manifest does not contain descriptor matching platform 'linux/amd64'"
**Fix**: Rebuild with `--platform linux/amd64 --target production`

### Error: "Prisma Client could not locate the Query Engine for runtime 'linux-musl'"
**Fix**: Rebuild with `--no-cache --target production`

### Error: "Health check failed - Request timed out"
**Fix**: Check CloudWatch logs for startup errors

---

## 📋 Before Making Changes

1. **Read** `DEPLOYMENT_GUIDE.md` for full context
2. **Read** `AUTH_ARCHITECTURE.md` if touching auth code
3. **Test locally** with `npm run dev` before deploying
4. **Build correctly** using the command at the top of this file
5. **Monitor deployment** until `rolloutState: COMPLETED`

---

## 🎯 Quick Health Check After Deploy

```bash
# Should return "healthy"
curl -s http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com/health | jq .status

# Test OTP (should return success:true)
curl -s -X POST http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com/api/v1/auth/send-otp -H "Content-Type: application/json" -d '{"phone":"9876543210","role":"transporter"}' | jq .success
```

---

*Last Updated: January 25, 2026*
