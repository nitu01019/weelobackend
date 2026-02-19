# Stack Research

**Domain:** Logistics/trucking broadcast platform — real-time broadcast lifecycle, AWS infrastructure hardening
**Researched:** 2026-02-19
**Confidence:** HIGH (core recommendations verified via official docs and AWS SDK v3 docs)

---

## Context: What Already Exists (Do Not Re-add)

The following are already installed and in production use. This research covers only
the *additions* needed for the broadcast flow + infrastructure hardening milestone.

| Already Present | Version | Notes |
|-----------------|---------|-------|
| socket.io | ^4.7.2 | Real-time transport layer |
| ioredis | ^5.9.2 | Redis client — also used for custom pub/sub |
| redis | ^4.6.12 | Redundant — see note below |
| @aws-sdk/client-sns | ^3.975.0 | Already in SDK family |
| @aws-sdk/client-s3 | ^3.978.0 | Already in SDK family |
| @aws-sdk/client-location | ^3.975.0 | Already in SDK family |
| @prisma/client | ^5.22.0 | ORM |
| winston | ^3.11.0 | Logging |
| zod | ^3.22.4 | Validation |

---

## Recommended Stack (Additions Only)

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| @aws-sdk/client-secrets-manager | ^3.990.0 | Pull secrets from AWS Secrets Manager at startup | Already in the AWS SDK v3 family — tree-shakeable, modular, no new ecosystem. Latest stable as of Feb 2026. IAM-role-based auth means zero plaintext secrets in ECS task env. |
| @socket.io/redis-adapter | ^8.3.0 | Replace custom Redis pub/sub in socket.service.ts with the official Socket.IO adapter | The existing hand-rolled pub/sub works for single-channel broadcasts but does NOT handle rooms across ECS instances correctly. The official adapter handles all `io.to(room).emit()` cross-server routing automatically. Compatible with ioredis (already installed). Socket.IO docs explicitly warn the `redis` npm package has reconnection issues — ioredis is the correct pairing. |
| node-cron | ^3.0.3 | Replace `setInterval` in broadcast expiry checker with cron-expression-based scheduling | The existing `setInterval` in `startExpiryChecker()` runs every 5s with no drift protection, no graceful-shutdown hook, and accumulates if ECS tasks restart mid-interval. `node-cron` schedules by wall-clock expression, supports `.stop()` for graceful shutdown, and has TypeScript types built in since v3. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @types/node-cron | included in node-cron v3 | TypeScript types | Automatically available — no separate @types install needed |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| aws-actions/configure-aws-credentials@v4 | GitHub Actions step — OIDC keyless auth to AWS | Use OIDC (id-token: write permission) rather than long-lived IAM access keys. v4 is the current version as of 2025. |
| aws-actions/amazon-ecr-login@v2 | Push Docker image to ECR | Pairs with configure-aws-credentials |
| aws-actions/amazon-ecs-render-task-definition@v1 | Inject new ECR image URI into task definition JSON | Avoids manual sed/jq hacks in CI |
| aws-actions/amazon-ecs-deploy-task-definition@v2 | Register task definition and trigger rolling deploy | Supports `wait-for-service-stability: true` for deployment verification |

---

## Installation

```bash
# New production dependency — Secrets Manager client
npm install @aws-sdk/client-secrets-manager

# New production dependency — official Socket.IO Redis adapter
npm install @socket.io/redis-adapter

# New production dependency — cron scheduler
npm install node-cron

# TypeScript types for node-cron (only needed if @types not bundled)
npm install -D @types/node-cron
```

No GitHub Actions tool installs — those are declared in `.github/workflows/*.yml` using `uses:` directives.

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| @aws-sdk/client-secrets-manager | AWS SSM Parameter Store | Use SSM when you only need plaintext config (cheaper per-call), not rotating credentials. Weelo needs rotating DB passwords and JWT secrets — Secrets Manager auto-rotation is the right tool. |
| @socket.io/redis-adapter | Keep custom Redis pub/sub (current) | Keep custom pub/sub ONLY if never running more than 1 ECS task. The current implementation manually handles `socket:user:*` and `socket:transporters` channels but does NOT handle `io.to("booking:123").emit()` across servers. |
| @socket.io/redis-adapter | @socket.io/redis-streams-adapter | Use Redis Streams adapter when you need message replay after Redis disconnect. Adds complexity. Current use case (broadcast lifecycle events) is fire-and-forget — no replay needed. |
| node-cron | setInterval (current) | Keep setInterval for sub-second polling tasks. For the 5-second expiry check, cron (`*/5 * * * * *`) gives drift-free wall-clock scheduling and proper `.stop()` on graceful shutdown. |
| node-cron | Agenda + MongoDB | Use Agenda only if you need persistent job queues that survive server restarts. The broadcast expiry check is idempotent and stateless — no persistence needed. |
| OIDC (configure-aws-credentials@v4) | Long-lived IAM access keys in GitHub Secrets | Never use long-lived keys. OIDC tokens are short-lived (15 min) and scoped per workflow. IAM keys are permanent blast radius. |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `redis` npm package (currently in package.json) | Redundant with ioredis. The Socket.IO team explicitly documents that `redis` package has problems restoring subscriptions after reconnection (GitHub issues linked in official docs). Having two Redis clients in one project is unnecessary overhead. | Remove `redis`, use `ioredis` only (already installed as `^5.9.2`) |
| AWS RDS Proxy for connection pooling | Prisma ORM uses prepared statements. AWS RDS Proxy pins the session per prepared statement, negating all pooling benefits. Official Prisma docs confirm this. | Use Prisma's built-in connection pool (`connection_limit` in DATABASE_URL) and set it per ECS task count. For high concurrency: PgBouncer in Transaction mode. |
| `socket.io-redis` (legacy) | The old package (`socket.io-redis`, not `@socket.io/redis-adapter`) is deprecated and not maintained. The new scoped package is the correct successor. | `@socket.io/redis-adapter@^8.3.0` |
| Hardcoding secrets in ECS task definition env vars | Plaintext values visible in ECS console, CloudTrail, and any IAM entity with `ecs:DescribeTaskDefinitions`. | Reference Secrets Manager ARNs in task definition `secrets` section — ECS injects them at runtime without exposing values. |
| `process.env` after startup for secret values | If a secret rotates mid-deployment, `process.env` holds the old value. | Fetch from Secrets Manager at startup with a 5-minute in-memory cache. Restart on cache miss for critical secrets. |

---

## Stack Patterns by Variant

**If running a single ECS task (dev/staging with desiredCount=1):**
- The existing custom Redis pub/sub in `socket.service.ts` works fine
- Defer `@socket.io/redis-adapter` migration to when you scale to 2+ tasks
- Still install Secrets Manager client — it's needed regardless of replica count

**If running 2+ ECS tasks (production with auto-scaling):**
- Install `@socket.io/redis-adapter` immediately
- The custom pub/sub will drop cross-server room messages (e.g., `booking:${id}` rooms)
- Configure with `ioredis` duplicate connections: one for pub, one for sub

**If using RDS with high concurrency (>100 concurrent requests):**
- Add `?connection_limit=5` to `DATABASE_URL` for Prisma's built-in pool
- Each ECS task gets its own pool, so total = tasks * connection_limit
- Do NOT use RDS Proxy (see "What NOT to Use" above)

---

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| socket.io@^4.7.2 | @socket.io/redis-adapter@^8.3.0 | Adapter v8.x requires Socket.IO 4.3.1+. Current 4.7.2 is well within range. HIGH confidence. |
| ioredis@^5.9.2 | @socket.io/redis-adapter@^8.3.0 | Official Socket.IO docs show ioredis as the recommended client. The `redis` package is explicitly flagged as problematic for subscriptions. HIGH confidence. |
| @prisma/client@^5.22.0 | PgBouncer in Transaction mode | Prisma requires `?pgbouncer=true` in connection string AND a separate DIRECT_URL for migrations. HIGH confidence (official Prisma docs). |
| @aws-sdk/client-secrets-manager@^3.990.0 | @aws-sdk/client-s3@^3.978.0 | All in the same AWS SDK v3 monorepo. Same major version. No compatibility issues. HIGH confidence. |
| node-cron@^3.0.3 | TypeScript@^5.3.3 | node-cron v3 ships its own TypeScript declarations. No separate @types package needed. MEDIUM confidence (verify on install). |

---

## Implementation Pattern: Secrets Manager Bootstrap

The pattern for loading secrets into the process at ECS startup (not per-request):

```typescript
// src/shared/services/secrets.service.ts
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'ap-south-1' });

// In-memory cache — 5-minute TTL matches AWS recommendation
const cache = new Map<string, { value: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getSecret(secretName: string): Promise<string> {
  const cached = cache.get(secretName);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }
  const command = new GetSecretValueCommand({ SecretId: secretName });
  const response = await client.send(command);
  const value = response.SecretString ?? '';
  cache.set(secretName, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

// Called once at server startup — replaces process.env reads for secrets
export async function bootstrapSecrets(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') return; // use .env locally
  const [db, jwt, redis] = await Promise.all([
    getSecret('weelo/production/database'),
    getSecret('weelo/production/jwt'),
    getSecret('weelo/production/redis'),
  ]);
  // Parse JSON secrets and apply to process.env before Prisma/Redis init
  Object.assign(process.env, JSON.parse(db), JSON.parse(jwt), JSON.parse(redis));
}
```

Call `await bootstrapSecrets()` in `server.ts` before any service initialization.

---

## Implementation Pattern: Socket.IO Redis Adapter

Replace the custom pub/sub in `socket.service.ts` with the official adapter:

```typescript
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';

const pubClient = new Redis(redisConfig);
const subClient = pubClient.duplicate(); // ioredis duplicate() for subscriber connection

io.adapter(createAdapter(pubClient, subClient));
// All io.to(room).emit() calls now automatically cross ECS instances
// Remove custom publishToRedis() / initializeRedisPubSub() functions
```

---

## Implementation Pattern: Broadcast Expiry with node-cron

Replace `setInterval` in `broadcast.service.ts`:

```typescript
import cron from 'node-cron';

private expiryTask: cron.ScheduledTask | null = null;

startExpiryChecker(): void {
  // Run every 5 seconds using cron expression
  this.expiryTask = cron.schedule('*/5 * * * * *', async () => {
    try {
      await this.checkAndExpireBroadcasts();
    } catch (error: any) {
      logger.error(`Expiry checker error: ${error.message}`);
    }
  });
  logger.info('Broadcast expiry checker started (5 second cron)');
}

stopExpiryChecker(): void {
  this.expiryTask?.stop();
  logger.info('Broadcast expiry checker stopped');
}
```

Wire `stopExpiryChecker()` into the graceful shutdown handler in `server.ts`.

---

## GitHub Actions CI/CD Workflow Structure

The recommended 3-job workflow for ECS deployment:

```yaml
# .github/workflows/deploy.yml
name: Deploy to ECS

on:
  push:
    branches: [main]

permissions:
  id-token: write   # Required for OIDC
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm test

  build-push:
    needs: test
    runs-on: ubuntu-latest
    outputs:
      image: ${{ steps.build.outputs.image }}
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ap-south-1
      - uses: aws-actions/amazon-ecr-login@v2
      - name: Build and push
        id: build
        run: |
          IMAGE=${{ steps.login-ecr.outputs.registry }}/weelo-backend:${{ github.sha }}
          docker build -t $IMAGE .
          docker push $IMAGE
          echo "image=$IMAGE" >> $GITHUB_OUTPUT

  deploy:
    needs: build-push
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ap-south-1
      - uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: task-definition.json
          container-name: weelo-backend
          image: ${{ needs.build-push.outputs.image }}
      - uses: aws-actions/amazon-ecs-deploy-task-definition@v2
        with:
          task-definition: task-definition.json
          service: weelo-backend-service
          cluster: weelo-cluster
          wait-for-service-stability: true
```

---

## Sources

- [AWS SDK v3 Secrets Manager npm](https://www.npmjs.com/package/@aws-sdk/client-secrets-manager) — version 3.990.0 confirmed, updated 3 days ago
- [AWS Secrets Manager Best Practices](https://docs.aws.amazon.com/secretsmanager/latest/userguide/best-practices.html) — caching and least-privilege IAM patterns (HIGH confidence)
- [Socket.IO Redis Adapter docs](https://socket.io/docs/v4/redis-adapter/) — ioredis recommendation, v8.3.0 version, adapter vs custom pub/sub tradeoffs (HIGH confidence)
- [aws-actions/amazon-ecs-deploy-task-definition](https://github.com/aws-actions/amazon-ecs-deploy-task-definition) — v2 confirmed current (HIGH confidence)
- [aws-actions/configure-aws-credentials](https://github.com/aws-actions/configure-aws-credentials) — v4 with OIDC (HIGH confidence)
- [Prisma Caveats for AWS Platforms](https://www.prisma.io/docs/orm/prisma-client/deployment/caveats-when-deploying-to-aws-platforms) — RDS Proxy / PgBouncer guidance (HIGH confidence)
- [Prisma PgBouncer docs](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/pgbouncer) — Transaction mode requirement (HIGH confidence)
- [RDS Proxy no benefit discussion](https://github.com/prisma/prisma/discussions/23547) — prepared statement pinning confirmed (MEDIUM confidence)
- [node-cron npm](https://www.npmjs.com/package/node-cron) — v3 TypeScript support (MEDIUM confidence, verify on install)

---

*Stack research for: Weelo logistics backend — broadcast lifecycle + AWS infrastructure hardening milestone*
*Researched: 2026-02-19*
