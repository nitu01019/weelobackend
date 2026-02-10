# 🚀 WEELO BACKEND - DEPLOYMENT & BUILD GUIDE

> **IMPORTANT**: This document contains critical information for building, deploying, and managing the Weelo backend. Read this before making any changes.

---

## 📋 Table of Contents

1. [Project Overview](#-project-overview)
2. [AWS Infrastructure](#-aws-infrastructure)
3. [Docker Build - CRITICAL](#-docker-build---critical)
4. [Deployment Commands](#-deployment-commands)
5. [Common Issues & Solutions](#-common-issues--solutions)
6. [OTP Authentication Architecture](#-otp-authentication-architecture)
7. [Monitoring & Debugging](#-monitoring--debugging)
8. [Quick Reference Commands](#-quick-reference-commands)

---

## 📦 Project Overview

### What is Weelo?

Weelo is a logistics platform with **2 apps** and **3 user roles**:

| App | Users | Purpose |
|-----|-------|---------|
| **Weelo** (Customer App) | Customers | Create orders, track shipments |
| **Weelo Captain** | Transporters & Drivers | Manage fleet, accept/complete trips |

### Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | Node.js 20 + TypeScript + Express |
| Database | PostgreSQL (AWS RDS) |
| Cache/Sessions | Redis (AWS ElastiCache) |
| ORM | Prisma |
| Container | Docker (Alpine Linux) |
| Hosting | AWS ECS Fargate |
| Load Balancer | AWS ALB |

---

## ☁️ AWS Infrastructure

### Resources

| Resource | Name/Endpoint | Region |
|----------|---------------|--------|
| **ECS Cluster** | `weelocluster` | ap-south-1 |
| **ECS Service** | `weelobackendtask-service-joxh3c0r` | ap-south-1 |
| **Task Definition** | `weelobackendtask` | ap-south-1 |
| **ECR Repository** | `318774499084.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend` | ap-south-1 |
| **Load Balancer** | `weelo-alb-380596483.ap-south-1.elb.amazonaws.com` | ap-south-1 |
| **Target Group** | `weelo-tg` | ap-south-1 |
| **RDS PostgreSQL** | `weelodb.cdqoiou8wm0y.ap-south-1.rds.amazonaws.com` | ap-south-1 |
| **ElastiCache Redis** | `weeloredis-zt8pfs.serverless.aps1.cache.amazonaws.com:6379` | ap-south-1 |
| **CloudWatch Logs** | `weelobackendtask` | ap-south-1 |

### API Endpoint

```
http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com
```

---

## 🐳 Docker Build - CRITICAL

> ⚠️ **READ THIS CAREFULLY** - Incorrect builds will cause deployment failures!

### Why Builds Fail

1. **Platform Mismatch**: Mac (ARM64) vs ECS (AMD64)
2. **Prisma Binary Mismatch**: Mac binaries vs Alpine Linux binaries
3. **Wrong Docker Stage**: Using `development` instead of `production`

### ✅ CORRECT Build Command

```bash
cd Desktop/weelo-backend

# ALWAYS use these flags:
docker buildx build \
  --platform linux/amd64 \
  --target production \
  --no-cache \
  --push \
  -t 318774499084.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend:latest \
  .
```

### Explanation of Flags

| Flag | Purpose | Why It's Required |
|------|---------|-------------------|
| `--platform linux/amd64` | Build for ECS architecture | Mac M1/M2 builds ARM64, ECS needs AMD64 |
| `--target production` | Use production stage | Includes proper Prisma binaries |
| `--no-cache` | Fresh build | Prevents stale Prisma binaries |
| `--push` | Push directly to ECR | Avoids manifest issues |

### ❌ WRONG Build Commands (DO NOT USE)

```bash
# DON'T DO THIS - wrong platform
docker build -t weelo-backend:latest .

# DON'T DO THIS - uses development stage
docker buildx build --platform linux/amd64 --push -t ... .

# DON'T DO THIS - may use cached Mac binaries
docker buildx build --platform linux/amd64 --target production --push -t ... .
```

### Dockerfile Structure (3-Stage Build)

```
┌─────────────────────────────────────────────────────────────────┐
│ Stage 1: BUILDER                                                │
│ - Installs ALL dependencies (including devDependencies)         │
│ - Runs `prisma generate` for linux-musl (Alpine)               │
│ - Creates correct Prisma binaries for production               │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Stage 2: DEPS                                                   │
│ - Installs production dependencies only                         │
│ - Smaller node_modules without devDependencies                  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Stage 3: PRODUCTION                                             │
│ - Copies production deps from DEPS stage                        │
│ - Copies Prisma client from BUILDER stage                       │
│ - Copies pre-built dist/ folder                                 │
│ - Runs as non-root user for security                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📤 Deployment Commands

### Pre-requisites

```bash
# 1. Ensure AWS CLI is configured
aws configure list

# 2. Login to ECR
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 318774499084.dkr.ecr.ap-south-1.amazonaws.com
```

### Full Deployment Process

```bash
# Step 1: Build TypeScript
cd Desktop/weelo-backend
npm run build

# Step 2: Build & Push Docker Image
docker buildx build \
  --platform linux/amd64 \
  --target production \
  --no-cache \
  --push \
  -t 318774499084.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend:latest \
  .

# Step 3: Force New ECS Deployment
aws ecs update-service \
  --cluster weelocluster \
  --service weelobackendtask-service-joxh3c0r \
  --force-new-deployment \
  --region ap-south-1

# Step 4: Monitor Deployment
watch -n 5 'aws ecs describe-services --cluster weelocluster --services weelobackendtask-service-joxh3c0r --region ap-south-1 --query "services[0].{running:runningCount,desired:desiredCount,rollout:deployments[0].rolloutState}" --output table'
```

### Quick Deploy (One-Liner)

```bash
cd Desktop/weelo-backend && npm run build && docker buildx build --platform linux/amd64 --target production --no-cache --push -t 318774499084.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend:latest . && aws ecs update-service --cluster weelocluster --service weelobackendtask-service-joxh3c0r --force-new-deployment --region ap-south-1
```

---

## 🔧 Common Issues & Solutions

### Issue 1: "CannotPullContainerError: image Manifest does not contain descriptor matching platform 'linux/amd64'"

**Cause**: Docker image was built for ARM64 (Mac) instead of AMD64 (ECS)

**Solution**:
```bash
docker buildx build --platform linux/amd64 --target production --no-cache --push -t 318774499084.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend:latest .
```

### Issue 2: "Prisma Client could not locate the Query Engine for runtime 'linux-musl'"

**Cause**: Prisma was generated on Mac, not inside Alpine container

**Solution**:
1. Ensure Dockerfile has 3-stage build with `prisma generate` in builder stage
2. Use `--no-cache` flag to avoid stale binaries
3. Use `--target production` to ensure correct stage is built

### Issue 3: "Health check failed - Request timed out"

**Cause**: Server not starting or crashing on startup

**Solution**:
1. Check CloudWatch logs:
   ```bash
   aws logs filter-log-events --log-group-name "weelobackendtask" --region ap-south-1 --limit 50
   ```
2. Look for Prisma errors, connection errors, or startup failures

### Issue 4: Deployment stuck "IN_PROGRESS"

**Cause**: New tasks failing health checks, rolling back

**Solution**:
1. Check events:
   ```bash
   aws ecs describe-services --cluster weelocluster --services weelobackendtask-service-joxh3c0r --region ap-south-1 --query 'services[0].events[0:10].message' --output table
   ```
2. Check stopped tasks for errors:
   ```bash
   aws ecs list-tasks --cluster weelocluster --desired-status STOPPED --region ap-south-1
   ```

### Issue 5: OTP not being sent

**Cause**: SMS service configuration or rate limiting

**Solution**:
1. Check CloudWatch logs for SMS errors
2. Verify environment variables are set correctly
3. Check if phone number is rate-limited

---

## 🔐 OTP Authentication Architecture

### User Roles & OTP Flow

| Role | App | OTP Sent To | Endpoint |
|------|-----|-------------|----------|
| Customer | Weelo | Customer's phone | `/api/v1/auth/send-otp` |
| Transporter | Captain | Transporter's phone | `/api/v1/auth/send-otp` |
| **Driver** | Captain | **Transporter's phone** | `/api/v1/driver-auth/send-otp` |

### Why Driver OTP Goes to Transporter?

- Ensures driver is authorized by their transporter
- Transporter maintains control over fleet access
- Prevents unauthorized driver logins

### Redis Key Patterns

```
# Customer/Transporter OTPs
otp:{phone}:{role}              # TTL: 5 minutes

# Driver OTPs
driver-otp:{driverPhone}        # TTL: 5 minutes

# Refresh Tokens
refresh:{tokenHash}             # TTL: 30 days
user:tokens:{userId}            # Set of user's tokens
```

### Auth Modules

```
src/modules/
├── auth/                    # Customer & Transporter Auth
│   ├── auth.service.ts      # Redis-powered OTP
│   └── sms.service.ts       # SMS provider
│
└── driver-auth/             # Driver Auth (separate)
    └── driver-auth.service.ts # Redis-powered, OTP to transporter
```

---

## 📊 Monitoring & Debugging

### Health Check

```bash
curl http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com/health
```

### CloudWatch Logs

```bash
# Get recent logs
aws logs filter-log-events \
  --log-group-name "weelobackendtask" \
  --start-time $(date -v-1H +%s000) \
  --region ap-south-1 \
  --query 'events[*].message' \
  --output text

# Search for errors
aws logs filter-log-events \
  --log-group-name "weelobackendtask" \
  --filter-pattern "ERROR" \
  --region ap-south-1
```

### ECS Service Status

```bash
# Quick status
aws ecs describe-services \
  --cluster weelocluster \
  --services weelobackendtask-service-joxh3c0r \
  --region ap-south-1 \
  --query 'services[0].{running:runningCount,desired:desiredCount,status:status}' \
  --output table

# Deployment status
aws ecs describe-services \
  --cluster weelocluster \
  --services weelobackendtask-service-joxh3c0r \
  --region ap-south-1 \
  --query 'services[0].deployments[*].{status:status,running:runningCount,rollout:rolloutState}' \
  --output table
```

### Test OTP Endpoints

```bash
# Transporter OTP
curl -X POST http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com/api/v1/auth/send-otp \
  -H "Content-Type: application/json" \
  -d '{"phone": "9876543210", "role": "transporter"}'

# Driver OTP (goes to transporter!)
curl -X POST http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com/api/v1/driver-auth/send-otp \
  -H "Content-Type: application/json" \
  -d '{"driverPhone": "9123456789"}'
```

---

## 📝 Quick Reference Commands

### Build & Deploy

```bash
# Full deploy
cd Desktop/weelo-backend && npm run build && docker buildx build --platform linux/amd64 --target production --no-cache --push -t 318774499084.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend:latest . && aws ecs update-service --cluster weelocluster --service weelobackendtask-service-joxh3c0r --force-new-deployment --region ap-south-1
```

### Check Status

```bash
# Deployment status
aws ecs describe-services --cluster weelocluster --services weelobackendtask-service-joxh3c0r --region ap-south-1 --query 'services[0].{running:runningCount,rollout:deployments[0].rolloutState}' --output table

# Recent events
aws ecs describe-services --cluster weelocluster --services weelobackendtask-service-joxh3c0r --region ap-south-1 --query 'services[0].events[0:5].message' --output text
```

### Logs

```bash
# Recent logs
aws logs filter-log-events --log-group-name "weelobackendtask" --region ap-south-1 --limit 30 --query 'events[*].message' --output text
```

### Health

```bash
# Health check
curl -s http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com/health | jq .
```

---

## 🏗️ Project File Structure

```
weelo-backend/
├── src/
│   ├── modules/
│   │   ├── auth/              # Customer/Transporter auth
│   │   ├── driver-auth/       # Driver auth (OTP to transporter)
│   │   ├── booking/           # Order management
│   │   ├── vehicle/           # Fleet management
│   │   └── tracking/          # Real-time tracking
│   ├── shared/
│   │   ├── services/          # Redis, SMS, FCM, etc.
│   │   ├── middleware/        # Auth, rate limiting, etc.
│   │   └── database/          # Prisma client
│   └── config/                # Environment config
├── prisma/
│   └── schema.prisma          # Database schema
├── dist/                      # Compiled TypeScript
├── Dockerfile                 # Multi-stage production build
├── docker-compose.yml         # Local development
├── AUTH_ARCHITECTURE.md       # OTP flow documentation
└── DEPLOYMENT_GUIDE.md        # This file
```

---

## 🔑 Environment Variables

Key environment variables (set in ECS Task Definition):

```
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
JWT_SECRET=...
JWT_REFRESH_SECRET=...
SMS_API_KEY=...
```

---

## 📅 Last Updated

- **Date**: January 25, 2026
- **Version**: 2.0.0
- **Last Deploy**: Successful

---

## ⚡ TL;DR - Quick Deploy

```bash
# One command to rule them all:
cd Desktop/weelo-backend && npm run build && docker buildx build --platform linux/amd64 --target production --no-cache --push -t 318774499084.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend:latest . && aws ecs update-service --cluster weelocluster --service weelobackendtask-service-joxh3c0r --force-new-deployment --region ap-south-1

# Then monitor:
watch -n 10 'curl -s http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com/health | jq .status'
```

---

*This document should be updated whenever infrastructure changes are made.*
