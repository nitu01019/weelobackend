# Weelo Backend — AWS Deployment Reference Guide

> **Last Deployed:** 2026-02-10  
> **Status:** ✅ Live & Healthy  
> **This file is your single source of truth for deploying the backend.**

---

## 📋 AWS Infrastructure Details

| Resource | Value |
|----------|-------|
| **AWS Account ID** | `318774499084` |
| **Region** | `ap-south-1` (Mumbai) |
| **ECR Repository** | `318774499084.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend` |
| **ECS Cluster** | `weelocluster` |
| **ECS Service** | `weelobackendtask-service-joxh3c0r` |
| **Task Definition** | `weelobackendtask` (latest revision) |
| **ALB DNS** | `weelo-alb-380596483.ap-south-1.elb.amazonaws.com` |
| **Health Check URL** | `http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com/health` |
| **Docker Platform** | `linux/amd64` ⚠️ NOT arm64 (Mac Silicon) |
| **Dockerfile** | `Dockerfile.production` (NOT `Dockerfile`) |

---

## 🔐 AWS Login Credentials

Stored in `~/.aws/credentials` and `~/.aws/config`:

```bash
# Check current AWS config
aws configure list

# If you need to reconfigure:
aws configure
# Access Key ID: (check ~/.aws/credentials)
# Secret Access Key: (check ~/.aws/credentials)
# Region: ap-south-1
# Output: json
```

---

## 🚀 Full Deployment Steps (Copy-Paste Ready)

### Step 1: Build TypeScript (verify code compiles)

```bash
cd ~/Desktop/weelo-backend
npm run build
```

Expected: No errors. If errors, fix them before proceeding.

### Step 2: Login to AWS ECR

```bash
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 318774499084.dkr.ecr.ap-south-1.amazonaws.com
```

Expected: `Login Succeeded`

### Step 3: Build Docker Image & Push to ECR

⚠️ **CRITICAL: Must use `--platform linux/amd64`** — ECS runs on x86, not ARM (Mac Silicon).

```bash
cd ~/Desktop/weelo-backend

docker buildx build \
  --platform linux/amd64 \
  -f Dockerfile.production \
  --no-cache \
  --push \
  -t 318774499084.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend:latest \
  .
```

- **`--platform linux/amd64`** — Builds for ECS architecture (NOT Mac ARM)
- **`-f Dockerfile.production`** — Uses production Dockerfile (multi-stage, non-root user)
- **`--no-cache`** — Fresh build with correct Prisma binaries for Alpine Linux
- **`--push`** — Pushes directly to ECR after build
- Takes ~3-5 minutes

### Step 4: Force New ECS Deployment

```bash
aws ecs update-service \
  --cluster weelocluster \
  --service weelobackendtask-service-joxh3c0r \
  --force-new-deployment \
  --region ap-south-1
```

This tells ECS to pull the new `:latest` image and do a **rolling deployment** (zero downtime).

### Step 5: Monitor Deployment

```bash
# Wait for deployment to stabilize (takes ~2-3 minutes)
aws ecs wait services-stable \
  --cluster weelocluster \
  --services weelobackendtask-service-joxh3c0r \
  --region ap-south-1

# Or check manually:
aws ecs describe-services \
  --cluster weelocluster \
  --services weelobackendtask-service-joxh3c0r \
  --region ap-south-1 \
  --query 'services[0].deployments[*].{status:status,running:runningCount,desired:desiredCount,rollout:rolloutState}' \
  --output table
```

Expected:
- PRIMARY deployment: `COMPLETED`, running = 1, desired = 1
- Old ACTIVE deployment drains and disappears

### Step 6: Health Check

```bash
curl http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com/health
```

Expected: `{"status":"healthy","environment":"production",...}`

---

## 🔄 Quick Deploy (All-in-One)

Copy-paste this entire block to deploy in one go:

```bash
cd ~/Desktop/weelo-backend

# 1. Build TypeScript
npm run build && echo "✅ TypeScript build OK" || { echo "❌ Build failed"; exit 1; }

# 2. Login to ECR
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 318774499084.dkr.ecr.ap-south-1.amazonaws.com

# 3. Build & Push Docker image (linux/amd64)
docker buildx build \
  --platform linux/amd64 \
  -f Dockerfile.production \
  --no-cache \
  --push \
  -t 318774499084.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend:latest \
  .

# 4. Force ECS deployment
aws ecs update-service \
  --cluster weelocluster \
  --service weelobackendtask-service-joxh3c0r \
  --force-new-deployment \
  --region ap-south-1

# 5. Wait for deployment
echo "⏳ Waiting for deployment to stabilize..."
aws ecs wait services-stable \
  --cluster weelocluster \
  --services weelobackendtask-service-joxh3c0r \
  --region ap-south-1

# 6. Health check
echo "🏥 Health check:"
curl -s http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com/health | python3 -m json.tool

echo "✅ Deployment complete!"
```

---

## 📁 Key Files

| File | Purpose |
|------|---------|
| `Dockerfile.production` | Multi-stage production build (node:20-alpine, non-root user) |
| `Dockerfile` | Development build (simpler, for local testing) |
| `scripts/docker-entrypoint.sh` | Container startup: runs `prisma db push` then starts server |
| `.env.production` | Production environment variables (DB URL, JWT secret, etc.) |
| `.env.production.example` | Template for `.env.production` (no real secrets) |
| `deploy-production.sh` | Alternative deploy script |
| `deploy.sh` | Alternative deploy script |

---

## 🐳 Docker Details

### Why `linux/amd64`?
- Mac uses ARM (Apple Silicon / M1/M2/M3)
- AWS ECS uses x86_64 (Intel/AMD) instances
- If you build without `--platform linux/amd64`, the container crashes on ECS with `exec format error`

### Why `Dockerfile.production` (not `Dockerfile`)?
- Multi-stage build: builder (compiles TS) → production (only dist + node_modules)
- Non-root user (`weelo:nodejs`) for security
- Prisma binaries generated for `linux-musl` (Alpine Linux)
- Health check built into the Docker image
- `NODE_OPTIONS="--max-old-space-size=2048"` for production memory

### What Happens on Container Start?
1. `docker-entrypoint.sh` runs
2. If `DATABASE_URL` is set → runs `prisma db push --skip-generate` (creates/syncs tables)
3. If `cluster.js` exists → starts in cluster mode (multi-core)
4. Otherwise → starts `node dist/server.js` (single process)

---

## 🔍 Troubleshooting

### Deployment stuck / health check failing

```bash
# Check ECS task logs
aws logs tail /ecs/weelo-backend --since 5m --region ap-south-1

# Check running tasks
aws ecs list-tasks --cluster weelocluster --service-name weelobackendtask-service-joxh3c0r --region ap-south-1

# Describe a specific task (get task ID from above)
aws ecs describe-tasks --cluster weelocluster --tasks <TASK_ID> --region ap-south-1
```

### Docker build fails with Prisma error

```bash
# Clear buildx cache and rebuild
docker buildx prune -f
docker buildx build --platform linux/amd64 -f Dockerfile.production --no-cache --push -t 318774499084.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend:latest .
```

### ECR login expired

```bash
# Re-login (tokens expire after 12 hours)
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 318774499084.dkr.ecr.ap-south-1.amazonaws.com
```

### Rollback to previous version

```bash
# List recent image tags
aws ecr describe-images --repository-name weelo-backend --region ap-south-1 --query 'imageDetails | sort_by(@, &imagePushedAt) | [-5:].[imageTags[0], imagePushedAt]' --output table

# Force deploy previous version by tagging it as :latest
# Or update task definition to point to a specific image digest
```

### Check if server is running

```bash
# Health check
curl http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com/health

# Debug stats
curl http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com/api/v1/debug/stats
```

---

## 📱 App Endpoints (Customer + Captain)

Both apps connect to:
- **API:** `http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com/api/v1`
- **WebSocket:** `ws://weelo-alb-380596483.ap-south-1.elb.amazonaws.com`

When domain + SSL is ready, update to:
- **API:** `https://your-domain.com/api/v1`
- **WebSocket:** `wss://your-domain.com`

Files to update:
- Captain: `app/src/main/java/com/weelo/logistics/utils/Constants.kt`
- Customer: `app/src/main/java/com/weelo/logistics/data/remote/ApiConfig.kt`

---

## 📌 Remember

1. **Always use `--platform linux/amd64`** — Never build without it on Mac
2. **Always use `Dockerfile.production`** — Not `Dockerfile`
3. **Always use `--no-cache`** — Ensures fresh Prisma binaries for Alpine
4. **Always check health after deploy** — `curl /health`
5. **Never commit `.env.production`** — It's in `.gitignore`
6. **ECR tokens expire after 12 hours** — Re-login if push fails
