# Technology Stack

**Analysis Date:** 2026-05-04
**Project:** weelo-unified-backend v2.0.0 — Weelo Unified Backend (Customer + Captain App)
**Repo root:** `/Users/nitishbhardwaj/Downloads/weelo-backend`

## Languages

**Primary:**
- TypeScript 5.3.3 — entire `src/` tree (~689 `.ts` files), compiled to CommonJS via `tsc` (`package.json:8`).

**Secondary:**
- JavaScript (Node.js) — runtime + a handful of `.mjs` codegen scripts under `packages/contracts/codegen.mjs`, `packages/contracts/verify.mjs`.
- Shell (POSIX `sh`) — `scripts/docker-entrypoint.sh`, deploy + monitoring scripts under `scripts/`.
- SQL — direct manual migrations under `prisma/migrations/`, `prisma/manual-migrations/`, `migrations/`.
- YAML — AsyncAPI socket-event contract at `packages/contracts/events.asyncapi.yaml`.
- Protobuf — `packages/contracts/schemas/enums.proto` (codegen source for shared enums).

## Runtime

**Engine:** Node.js >= 18.0.0 declared in `package.json:77-79`. Production Docker images pin `node:20-alpine` (`Dockerfile:25`, `Dockerfile.production:7`).
- No `.nvmrc` is present. Effective production runtime = Node 20 (Alpine).
- Hermes / nvm not used.

**Module system:** CommonJS (`tsconfig.json:4 "module": "commonjs"`).
- Output dir: `./dist`, source maps + declarations on (`tsconfig.json:6,11-15`).

**Package Manager:** npm — `package-lock.json` present, no `pnpm-lock.yaml` / `yarn.lock`. CI installs via `npm ci --legacy-peer-deps` (`Dockerfile:37,61`).

**Cluster mode:** Production runs `node dist/cluster.js` (entry `package.json:11`) wrapped by PM2 (`ecosystem.config.js`). PM2 config: `instances: 'max'`, `exec_mode: 'cluster'`, `max_memory_restart: '1G'`, `kill_timeout: 5000`, graceful `wait_ready: true` (`ecosystem.config.js:17-43`). The Dockerfile entrypoint also auto-detects cluster mode in production: `scripts/docker-entrypoint.sh` execs `node dist/cluster.js` when `NODE_ENV=production` and `dist/cluster.js` exists.

## TypeScript Configuration

`tsconfig.json` highlights:
- `target: "ES2022"`, `lib: ["ES2022"]`
- `strict: false` — strict mode disabled
- `noImplicitAny: false`, `noUnusedLocals: false`, `noUnusedParameters: false`, `noImplicitReturns: false` (all relaxed)
- `noFallthroughCasesInSwitch: true` (the only strict-ish flag enabled)
- `esModuleInterop: true`, `skipLibCheck: true`, `forceConsistentCasingInFileNames: true`, `resolveJsonModule: true`
- `baseUrl: "./src"` with path aliases `@/*`, `@core`, `@core/*`, `@modules/*`, `@shared/*`, `@config/*` (`tsconfig.json:21-30`)
- `include: ["src/**/*", "packages/contracts/*.ts"]`
- `exclude: ["node_modules", "dist", "src/instrumentation.ts", "src/instrument.ts", "packages/contracts/codegen.mjs", "packages/contracts/verify.mjs"]` — Sentry/OTel bootstraps and codegen are intentionally excluded from `tsc` output.

## Frameworks

**Core HTTP:** Express 4.18.2 (`package.json:44`). Server entry `src/server.ts:39-100`.

**WebSocket:** Socket.IO 4.7.2 (`package.json:54`).
- Adapter: `@socket.io/redis-streams-adapter` 0.3.0 (`package.json:39`) — primary
- Fallback adapter: `@socket.io/redis-adapter` 8.3.0 (`package.json:38`) for legacy pub/sub
- Server bootstrap: `src/shared/services/socket.service.ts:285-435` (`initializeSocket(server)`)

**ORM:** Prisma 5.22.0 (`@prisma/client` runtime + `prisma` CLI; `package.json:37,52`). Schema at `prisma/schema.prisma` (currently empty in working tree — see CONCERNS; canonical schema is in git HEAD, 1468 lines, 32+ models).
- Generator config: `binaryTargets = ["native", "linux-musl", "linux-musl-openssl-3.0.x", "linux-musl-arm64-openssl-3.0.x", "linux-arm64-openssl-3.0.x", "debian-openssl-3.0.x"]` (multi-arch Alpine + Debian).
- Datasource: PostgreSQL.

**Validation:** Zod 3.22.4 (`package.json:57`). Schemas live alongside route modules: `*/auth.schema.ts`, `*/driver-auth.schema.ts`, `*/tracking.schema.ts`, `routing/route-multi.schema.ts`, etc.

**Logging:** Winston 3.11.0 (`package.json:56`). Singleton at `src/shared/services/logger.service.ts`.

**Auth:** `jsonwebtoken` 9.0.2 (`package.json:50`), `bcryptjs` 2.4.3 (`package.json:40`).

**File upload:** Multer 2.0.2 (`package.json:51`).

**Push notifications:** `firebase-admin` 13.6.0 (`package.json:46`). Init at `src/shared/services/fcm.service.ts:266-`.

**Observability:**
- Sentry — `@sentry/node` (referenced at `src/instrument.ts:1`; declared as transitive — not in `package.json` `dependencies`/`devDependencies` block; bootstrapped only when `SENTRY_DSN` is set).
- OpenTelemetry — `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-grpc`, `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`, `@opentelemetry/sdk-trace-base` (referenced at `src/instrumentation.ts:1-9`; only started when `OTEL_ENABLED=true`).
- Both `instrument.ts` and `instrumentation.ts` are excluded from `tsc` build (`tsconfig.json:33`) and not declared in `package.json` — they're loaded at runtime via NODE_OPTIONS or pre-required, otherwise dormant.

## Middleware Stack (Express)

Order in `src/server.ts`:
1. `app.set('trust proxy', config.trustedProxyCidrs)` — CIDR-based XFF trust (default `10.0.0.0/16,172.16.0.0/12`) — line 254
2. `edge_client_ip_source_total` metric tap — line 261
3. `requestIdMiddleware` (`X-Request-ID` propagation) — line 277
4. `correlationMiddleware` (AsyncLocalStorage trace context) — line 281
5. `compression` (level 6, threshold 1024 bytes; `compression` 1.7.4) — line 284
6. `securityHeaders` (Helmet 7.1.0) + `securityResponseHeaders` (HSTS staged 300s, X-Content-Type-Options, X-Frame-Options=DENY, Referrer-Policy) — lines 295-440
7. `cors` (origin from `config.cors.origin`, credentials true, 24h preflight cache; `cors` 2.8.5) — line 313
8. `healthRoutes`, `flagHealthRouter`, `/health/runtime` — registered BEFORE rate limiter — lines 332-338
9. `rateLimiter` (express-rate-limit 7.1.5, Redis-backed via `RedisRateLimitStore`) — line 420
10. `express.json({ limit: '32kb' })` — tightened from 1mb (A01-005 T09) — line 445
11. `blockSuspiciousRequests` + `sanitizeInput` + `preventParamPollution` — lines 448-454
12. `backwardCompatMiddleware` (legacy Captain-app path rewrites) — line 458
13. `requestLogger` — line 461
14. `metricsMiddleware` (Prometheus-style) — line 464

Boot-time invariant assertion verifies `rateLimiterIdx < jsonParserIdx` and exits if violated (`src/server.ts:563-592`).

## All Dependencies (from `package.json`)

### Runtime dependencies (28 packages)

| Group | Package | Version | Purpose |
|-------|---------|---------|---------|
| **Web** | `express` | ^4.18.2 | HTTP framework |
| **Web** | `cors` | ^2.8.5 | CORS middleware |
| **Web** | `helmet` | ^7.1.0 | Security headers |
| **Web** | `compression` | ^1.7.4 | Gzip response compression |
| **Web** | `express-rate-limit` | ^7.1.5 | Rate limiting (Redis-backed store) |
| **Web** | `multer` | ^2.0.2 | Multipart upload parser |
| **WebSocket** | `socket.io` | ^4.7.2 | Real-time WebSocket server |
| **WebSocket** | `@socket.io/redis-adapter` | ^8.3.0 | Pub/sub fanout (legacy) |
| **WebSocket** | `@socket.io/redis-streams-adapter` | ^0.3.0 | Redis Streams adapter (primary) |
| **DB** | `@prisma/client` | ^5.22.0 | Prisma runtime client |
| **DB** | `prisma` | ^5.22.0 | Prisma CLI + generator (also runtime — used to be devDep) |
| **Cache/Queue** | `ioredis` | ^5.9.2 | Redis client (production) |
| **Cache/Queue** | `redis` | ^4.6.12 | node-redis client (some paths) |
| **Auth** | `jsonwebtoken` | ^9.0.2 | JWT signing/verification |
| **Auth** | `bcryptjs` | ^2.4.3 | Password hashing |
| **Validation** | `zod` | ^3.22.4 | Schema validation |
| **Logging** | `winston` | ^3.11.0 | Structured logging |
| **Push** | `firebase-admin` | ^13.6.0 | FCM push notifications |
| **Geo** | `h3-js` | ^4.4.0 | Uber H3 geo-indexing |
| **AWS** | `@aws-sdk/client-kinesis` | ^3.985.0 | Kinesis tracking-stream sink |
| **AWS** | `@aws-sdk/client-location` | ^3.975.0 | AWS Location Service (routing/places fallback) |
| **AWS** | `@aws-sdk/client-s3` | ^3.978.0 | S3 file uploads |
| **AWS** | `@aws-sdk/s3-request-presigner` | ^3.978.0 | S3 presigned URLs |
| **AWS** | `@aws-sdk/client-sns` | ^3.975.0 | SNS SMS provider |
| **Config** | `dotenv` | ^16.3.1 | `.env` loader |
| **Util** | `uuid` | ^9.0.1 | UUID v4 generation |

### Dev dependencies (14 packages)

| Group | Package | Version | Purpose |
|-------|---------|---------|---------|
| **Build** | `typescript` | ^5.3.3 | TS compiler |
| **Build** | `ts-node-dev` | ^2.0.0 | Dev server with hot reload (`npm run dev`) |
| **Test** | `jest` | ^29.7.0 | Test runner |
| **Test** | `ts-jest` | ^29.4.6 | TS transformer for Jest |
| **Test** | `@types/jest` | ^29.5.14 | Jest types |
| **Lint** | `eslint` | ^8.56.0 | Linter |
| **Lint** | `@typescript-eslint/parser` | ^7.18.0 | ESLint TS parser |
| **Lint** | `@typescript-eslint/eslint-plugin` | ^7.18.0 | ESLint TS rules |
| **Types** | `@types/node` | ^20.10.5 | Node type defs |
| **Types** | `@types/express` | ^4.17.21 | Express types |
| **Types** | `@types/cors` | ^2.8.17 | cors types |
| **Types** | `@types/compression` | ^1.7.5 | compression types |
| **Types** | `@types/bcryptjs` | ^2.4.6 | bcrypt types |
| **Types** | `@types/jsonwebtoken` | ^9.0.5 | JWT types |
| **Types** | `@types/multer` | ^2.0.0 | multer types |
| **Types** | `@types/uuid` | ^9.0.7 | uuid types |

### Notable absences / things to know

- `@sentry/node` is NOT declared in `package.json` despite being imported in `src/instrument.ts:1`. The file is excluded from `tsc` build (`tsconfig.json:33`) — Sentry runs only when the file is preloaded externally and the package is installed out-of-band, otherwise import fails silently.
- `@opentelemetry/*` packages are imported at `src/instrumentation.ts:1-9` but not declared in `package.json`. Same situation — file excluded from build, only loaded when `OTEL_ENABLED=true` and packages are installed.
- `twilio` SDK is dynamically `require()`-ed at `src/modules/auth/sms.service.ts:34` but not in `package.json` — SMS via Twilio fails unless `twilio` is installed in the deploy environment manually.
- `husky`, `lint-staged`, `prettier` are absent. No pre-commit hooks. Formatting is enforced only by ESLint.
- No `bullmq` / `bull` package despite the codebase calling it "BullMQ-style" — the queue layer is hand-rolled (`InMemoryQueue` + `RedisQueue`) using ioredis primitives directly, see `src/shared/services/queue.service.ts:178,470`. The hold-expiry queue is also hand-rolled (`src/modules/hold-expiry/hold-expiry-cleanup.service.ts:66`).
- `@prisma/client` is pinned to `^5.22.0` — Prisma 6.x is not used.
- `legacy-peer-deps` flag is required to install (`Dockerfile:37,61`) — npm 7+ peer-dep resolution conflicts exist.
- Redis 7.4+ is required at boot (`src/server.ts:677-707` — version assertion); 7.1 with `USE_PEXPIRE_FALLBACK=true` is the only allowed downgrade.
- BullMQ-style guidance in `.env.example:328-352`: Redis MUST be configured with `maxmemory-policy=noeviction` — this is a hard boot assertion (`src/shared/monitoring/redis-eviction-assertion.ts`, called at `src/server.ts:773-794`).

## Build & Dev Tooling

**npm scripts** (`package.json:6-30`):

| Script | Command |
|--------|---------|
| `dev` | `ts-node-dev --respawn --transpile-only src/server.ts` |
| `build` | `tsc` |
| `start` | `node dist/server.js` |
| `start:cluster` | `node dist/cluster.js` |
| `start:prod` | `NODE_ENV=production node dist/cluster.js` |
| `lint` | `eslint src/**/*.ts` |
| `lint:fix` | `eslint src/**/*.ts --fix` |
| `lint:env` | `ts-node scripts/verify-env-example.ts` (verifies `.env.example` matches `env.validation.ts`) |
| `test` | `jest` |
| `test:coverage` | `jest --coverage` |
| `test:differentiator` | `jest --testPathPattern=differentiator` |
| `contracts:codegen` | `node packages/contracts/codegen.mjs` (regenerates `events.generated.ts` + `enums.generated.ts`) |
| `contracts:verify` | `node packages/contracts/verify.mjs` |
| `db:migrate:dev` | `prisma migrate dev` |
| `db:generate` | `prisma generate` |
| `db:push:prod:DANGER_DO_NOT_USE` | `prisma migrate deploy` (label warns this WILL break prod — see CLAUDE.md) |
| `db:push:prod:deploy` | `prisma migrate deploy` (alias of above) |
| `docker:build` | `docker build -t weelo-backend:latest .` |
| `docker:dev` | `docker-compose up -d` |
| `docker:down` | `docker-compose down` |
| `docker:logs` | `docker-compose logs -f api` |
| `health` | `curl -s http://localhost:3000/health \| jq` |
| `metrics` | `curl -s http://localhost:3000/metrics` |

**Jest config** (`jest.config.js`):
- `preset: 'ts-jest'`, `testEnvironment: 'node'`
- `testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts']`
- `testPathIgnorePatterns: ['/node_modules/', '/dist/', '/e2e/', '\\.d\\.ts$']` — Maestro/E2E specs run via dedicated runner, not Jest
- `coverageThreshold.global = { branches: 70, functions: 75, lines: 80, statements: 80 }`
- `maxWorkers: '50%'`, `clearMocks: true`, `verbose: true`
- `transform: { '^.+\\.ts$': ['ts-jest', { diagnostics: false }] }` — ts-jest type diagnostics OFF (enforced by `tsc` in CI instead)
- 352 test files in `src/__tests__/` plus per-module `__tests__/` directories.

**ESLint:** `.eslintrc*` not visible in repo root. Custom rules dir at `eslint-rules/` exists. ESLint config likely embedded inline or in a parent location not visible here.

**No formatter config** for Prettier or Biome — repo doesn't have `.prettierrc*` or `biome.json`.

## Configuration System

**Config layers (low → high priority):**
1. `src/core/config/env.validation.ts` — central validation registry; ~115 environment variable definitions with `required`, `default`, `validator`, `description`. Called as `validateAndLogEnvironment()` at boot (`src/server.ts:117`).
2. `src/config/environment.ts` — typed `config` object built from env vars via helpers `getRequired`, `getOptional`, `getBoolean`, `getNumber`, `parseCorsOrigins`, `parseTrustedProxyCidrs`. Calls `dotenv.config()` at module load (line 29). Exports `config.databaseUrl`, `config.redis`, `config.jwt`, `config.otp`, `config.sms`, `config.firebase`, `config.googleMaps`, `config.rateLimit`, `config.cors`, `config.trustedProxyCidrs`, `config.security`, `config.phoneKeySalt`, helpers `isProduction`/`isDevelopment`/`isTest`.
3. `src/config/aws.config.ts` — AWS-specific: `awsRegions`, `rdsConfig`, `elastiCacheConfig`, `containerConfig`, `albConfig`, `cloudWatchConfig`, `s3Config`, `secretsConfig`. Provides `getAwsConfig()` and `validateAwsConfig()`.
4. `src/config/secrets.ts` — secret manager wrapper.
5. `src/config/production.config.ts` — production overrides.
6. `src/core/config/hold-config.ts` — single source of truth for hold-system timing (`HOLD_CONFIG.driverAcceptTimeoutMs`, `flexHoldDurationSeconds`, `confirmedHoldMaxSeconds`, `vehicleMutexTtlSeconds`, etc.). Imported by every hold path; no parsing of these env vars elsewhere.
7. `src/shared/config/feature-flags.ts` — 107+ `FF_*` flag declarations with `defaultValue`, `category` (ops|release|placeholder), `env` key. Exposes `isEnabled(FLAGS.FOO)`, `validateFeatureFlags()`, `flagHealthRouter`.
8. `src/shared/config/presence.config.ts` — driver/transporter presence TTLs.

**Validation chain at boot:**
- Step 1: `validateAndLogEnvironment()` (`src/server.ts:117`) — checks required vars, applies defaults, validates per-var validators. In production, missing `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `REDIS_URL`, `GOOGLE_MAPS_API_KEY` are fatal (`env.validation.ts:582-625`).
- Step 2: `validateConfig()` (`src/config/environment.ts:265-325`) — runs at module load; rejects `CORS_ORIGIN=*` in production, demands `PHONE_KEY_SALT` >= 32 chars and not the dev placeholder.
- Step 3: `validateProductionConfig()` (`src/server.ts:622-725`) — async pre-flight inside `bootstrap()`: JWT length >= 32 bytes, `DB_CONNECTION_LIMIT` is positive integer, Redis healthCheck passes, Redis version >= 7.4 (or 7.1 + `USE_PEXPIRE_FALLBACK`).
- Step 4: `validateFeatureFlags()` (`src/server.ts:1254`) — fail-fast on invalid flag values in production.
- Step 5: `assertRedisEvictionPolicy()` (`src/server.ts:773-794`) — boot dies if Redis isn't configured with `noeviction` policy (with NOPERM escape hatch for managed providers).
- Step 6: `assertFcmUpgradeCampaignReadiness()` (`src/server.ts:602-614`) — verifies `DeviceToken.appVersionCode` column exists if upgrade campaign flag is on.
- Step 7: `assertBroadcastDeclineTableExists()` (`src/server.ts:1184`) — WARN if `BroadcastDecline` analytics table missing.
- Step 8: F-B-03 prefix-overlap assertion — boot dies if two services share a Redis SCAN prefix (`src/server.ts:1115-1151`).

**`.env.example` keys (full list at `.env.example:14-352`):**

Server: `NODE_ENV`, `PORT`, `HOST`.

Database: `DATABASE_URL`, `DB_POOL_MIN`, `DB_POOL_MAX`, `DB_CONNECTION_LIMIT` (default 25, prod target 125), `DB_POOL_TIMEOUT` (5s).

Redis: `REDIS_ENABLED`, `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PUBSUB_DISABLED`, `REDIS_MAX_RETRIES`, `REDIS_RETRY_DELAY_MS`, `REDIS_MAX_CONNECTIONS`, `REDIS_CONNECTION_TIMEOUT_MS`, `REDIS_COMMAND_TIMEOUT_MS`, `REDIS_MAXMEMORY_POLICY=noeviction` (mandatory).

Tracking stream: `TRACKING_STREAM_ENABLED`, `TRACKING_STREAM_PROVIDER` (`none`|`kinesis`), `TRACKING_KINESIS_STREAM`, `TRACKING_STREAM_BATCH_SIZE`, `TRACKING_STREAM_FLUSH_MS`, `TRACKING_STREAM_MAX_RETRIES`, `TRACKING_QUEUE_HARD_LIMIT` (200000), `TRACKING_QUEUE_DEPTH_SAMPLE_MS`, `REDIS_QUEUE_WORKERS` (16), `REDIS_QUEUE_TRACKING_WORKERS` (48), `REDIS_QUEUE_BLOCKING_POP_TIMEOUT_SEC` (1).

Fanout: `ORDER_TRANSPORTER_FANOUT_QUEUE_ENABLED`, `ORDER_TRANSPORTER_FANOUT_SYNC_THRESHOLD` (64), `ORDER_TRANSPORTER_FANOUT_QUEUE_CHUNK_SIZE` (500), `SOCKET_MULTI_ROOM_EMIT_CHUNK_SIZE` (300), `TRACKING_ETA_REDIS_BATCH_SIZE` (120), `TRACKING_OFFLINE_CHECK_BATCH_SIZE` (120).

JWT/Auth: `JWT_SECRET`, `JWT_REFRESH_SECRET`, `JWT_EXPIRES_IN` (7d default), `JWT_REFRESH_EXPIRES_IN` (30d), `OTP_EXPIRY_MINUTES` (5), `OTP_LENGTH` (6), `OTP_MAX_ATTEMPTS` (3), `PHONE_KEY_SALT` (≥32 chars).

SMS: `SMS_PROVIDER` (`mock`|`console`|`twilio`|`msg91`|`aws-sns`), `SMS_RETRIEVER_HASH` (Android, 11 chars), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `MSG91_AUTH_KEY`, `MSG91_SENDER_ID` (WEELO), `MSG91_TEMPLATE_ID`, `AWS_SNS_REGION`.

Maps: `GOOGLE_MAPS_API_KEY`, `AWS_LOCATION_ENABLED`, `AWS_LOCATION_ROUTE_CALCULATOR` (`weelo-routes`), `AWS_LOCATION_PLACE_INDEX` (`weelo-places`).

Rate limit: `RATE_LIMIT_WINDOW_MS` (60000), `RATE_LIMIT_MAX_REQUESTS` (1000), `LOG_LEVEL` (`debug`/`info`/`warn`/`error`), `CORS_ORIGIN`, `ENABLE_SECURITY_HEADERS`, `ENABLE_RATE_LIMITING`, `ENABLE_REQUEST_LOGGING`.

AWS: `AWS_REGION` (`ap-south-1`), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`, `RDS_HOST`, `RDS_PORT`, `RDS_DATABASE`, `RDS_USERNAME`, `RDS_PASSWORD`, `RDS_CA_CERT`, `RDS_READ_REPLICA_1`, `RDS_READ_REPLICA_2`.

Firebase: `FIREBASE_PROJECT_ID`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_PRIVATE_KEY_B64` (preferred for ECS), `FIREBASE_CLIENT_EMAIL`, `FIREBASE_SERVICE_ACCOUNT_PATH`, `FIREBASE_SA_S3_URI` (entrypoint downloads from S3).

Hold system (PRD-7777, must match `hold-config.ts` defaults): `FLEX_HOLD_DURATION_SECONDS` (90), `FLEX_HOLD_EXTENSION_SECONDS` (30), `FLEX_HOLD_MAX_DURATION_SECONDS` (130), `FLEX_HOLD_MAX_EXTENSIONS` (2), `CONFIRMED_HOLD_MAX_SECONDS` (180), `DRIVER_ACCEPT_TIMEOUT_SECONDS` (45), `ORDER_BASE_TIMEOUT_SECONDS` (120), `VEHICLE_MUTEX_TTL_SECONDS` (30), `BROADCAST_TIMEOUT_SECONDS` (120), `ASSIGNMENT_TIMEOUT_MS` (45000 — DEPRECATED).

Order guards: `REQUIRE_IDEMPOTENCY_KEY` (true), `ALLOW_MISSING_IDEMPOTENCY_KEY_UNTIL` (2026-05-01 grace deadline), `ORDER_MAX_CONCURRENT_CREATES` (200), `MINIMUM_FARE_PER_TRUCK` (500 INR).

Dispatch: `DIRECTIONS_API_MAX_QPS` (450), `MAX_ARRIVAL_DISTANCE_METERS` (200), `DRIVER_PROXIMITY_NOTIFICATION_KM` (2).

Feature flags (~25 surfaced in `.env.example`): `FF_BROADCAST_STRICT_SENT_ACCOUNTING`, `FF_CANCELLED_ORDER_QUEUE_GUARD`, `FF_CANCELLED_ORDER_QUEUE_GUARD_FAIL_OPEN`, `FF_LEGACY_BOOKING_PROXY_TO_ORDER`, `FF_DB_STRICT_IDEMPOTENCY`, `FF_ORDER_DISPATCH_OUTBOX`, `FF_ORDER_DISPATCH_STATUS_EVENTS`, `FF_CANCEL_OUTBOX_ENABLED`, `FF_CANCEL_POLICY_TRUCK_V1`, `FF_CANCEL_EVENT_VERSION_ENFORCED`, `FF_CANCEL_REBOOK_CHURN_GUARD`, `FF_CANCEL_DEFERRED_SETTLEMENT`, `FF_CANCEL_IDEMPOTENCY_REQUIRED`, `FF_MATCHING_CANONICAL_ENFORCED`, `FF_ORDER_CREATE_PENDING_QUEUE`, `FF_DUAL_CHANNEL_DELIVERY` (default ON), `FF_ORDER_JOIN_RACE_REEMIT`, `FF_H3_INDEX_ENABLED`, `FF_CIRCUIT_BREAKER_ENABLED` (default ON), `FF_SEQUENCE_DELIVERY_ENABLED` (default OFF), `FF_DIRECTIONS_API_SCORING_ENABLED` (default ON), `FF_HOLD_DB_ATOMIC_CLAIM` (default ON), `FF_QUEUE_DEPTH_CAP` (10000), `FF_DLQ_DRAINER_ENABLED`, `FF_FCM_UPGRADE_CAMPAIGN`, `MIN_SUPPORTED_APP_VERSION`, `SOCKET_UPGRADE_LIMITER_ENABLED`, `SOCKET_MAX_GLOBAL_CONNECTIONS` (10000), `SOCKET_PING_TIMEOUT_MS` (20000), `SOCKET_PING_INTERVAL_MS` (15000), `ALB_CIDR_ALLOW`, `HEALTH_SECRET`, `TRUSTED_PROXY_CIDRS` (`10.0.0.0/16,172.16.0.0/12`), `SOCKET_DB_CONCURRENCY` (10).

CI lint: `scripts/verify-env-example.ts` enforces every key from `env.validation.ts` appears in `.env.example` (run via `npm run lint:env`).

## Container / Deploy Stack

**Dockerfile** (`Dockerfile`, 142 lines) — multi-stage:
- Stage 1 `builder` (node:20-alpine + openssl): `npm ci --legacy-peer-deps`, `npx prisma generate`, `npm run build` → `/app/dist`.
- Stage 2 `deps` (node:20-alpine): `npm ci --legacy-peer-deps --omit=dev` for production deps.
- Stage 3 `production` (node:20-alpine + openssl + wget): copies `node_modules` + `.prisma` + `dist`. Non-root user `weelo:nodejs` (UID 1001). HEALTHCHECK every 30s on `/health`. Runs `./docker-entrypoint.sh`.
- Stage 4 `development` (optional): hot-reload via `npm run dev`.

**Dockerfile.production** (`Dockerfile.production`, 87 lines) — simpler 2-stage with explicit `linux/amd64` platform pin (ECS-targeted). Production stage installs `curl` (instead of wget) and runs `node` with `NODE_OPTIONS="--max-old-space-size=2048 --enable-source-maps"`.

**docker-compose.yml** (`docker-compose.yml`, 147 lines) — local dev stack:
- `api` (build `target: development`, port 3000, hot-reload via volume mount)
- `postgres` (postgres:15-alpine, port 5432, runs `scripts/init-db.sql` on first boot, `weelo:weelo123` creds — DEV ONLY)
- `redis` (redis:7-alpine, port 6379, `--appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru` — note: dev uses `allkeys-lru`; prod MUST use `noeviction`)
- Optional under `tools` profile: `redis-commander` (port 8081), `pgadmin` (port 8082).

**docker-compose.chaos.yml** (`docker-compose.chaos.yml`, 41 lines) — chaos rig (Phase 7):
- `redis` (redis:7-alpine, port 16379)
- `postgres-primary` (postgres:15-alpine, port 15432)
- `toxiproxy` (`ghcr.io/shopify/toxiproxy:2.9.0`, ports 18474 API + 16380 Redis + 15433 Postgres)
- `firebase-emulator` (placeholder, awaiting real wiring)

**PgBouncer** (`docker/pgbouncer/pgbouncer.ini`):
- Listen `0.0.0.0:6432`, auth via `userlist.txt` (md5)
- `pool_mode = transaction` (returns connection per tx)
- `max_client_conn = 10000`, `default_pool_size = 25`, `reserve_pool_size = 5`
- `server_idle_timeout = 600s`, `server_lifetime = 3600s`, `server_connect_timeout = 15s`, `query_timeout = 300s`, `client_idle_timeout = 300s`
- `ignore_startup_parameters = extra_float_digits` (Prisma compat)
- `docker/pgbouncer/docker-compose.yml` available for local pgbouncer testing.

**ECS deployment:**
- `Dockerfile.production` is the ECS image (linux/amd64).
- `scripts/docker-entrypoint.sh` is the ECS task entry point. Behaviour:
  1. If `FIREBASE_SA_S3_URI` set → `aws s3 cp` Firebase service account JSON to `/app/firebase-service-account.json`.
  2. Run `prisma migrate resolve --applied` for 7 known migrations (idempotent baseline).
  3. Run `prisma migrate deploy` (will fail in current production — see CLAUDE.md note: prod DB has no `_prisma_migrations` table; entrypoint script and CLAUDE.md disagree).
  4. Create `OtpStore` table directly via `$executeRawUnsafe` (cross-task OTP fallback).
  5. Run one-time `_MigrationFlags`-tracked language reset migration.
  6. Exec `node dist/cluster.js` if `NODE_ENV=production` and `dist/cluster.js` exists, else `node dist/server.js`.
- Cluster mode entrypoint: `src/cluster.ts`.
- Health check: `GET /health` (registered before rate limiter so ALB probes never get throttled — `src/server.ts:332`).
- Server timeouts (`src/server.ts:1202-1204`): `server.timeout = 30000`, `server.keepAliveTimeout = 65000`, `server.headersTimeout = 66000` (must satisfy `headersTimeout > keepAliveTimeout > ALB idle 60s`).
- HTTPS support: if `SSL_KEY_PATH` + `SSL_CERT_PATH` exist, server boots `createHttpsServer` with TLS 1.2+ and a strong cipher whitelist (`src/server.ts:166-211`); otherwise falls back to HTTP. ALB terminates TLS in production.
- Graceful shutdown: SIGTERM/SIGINT → 25s force-kill timeout (5s before ECS default 30s). Sequence: drain socket clients → `queueService.stop()` → close HTTP server → `redisService.shutdown()` → `prismaClient.$disconnect()`. See `src/server.ts:1291-1421`.

**Deploy scripts:**
- `deploy.sh`, `deploy-production.sh` — ECS deploy wrappers
- `optimize-backend.sh` — production tuning script
- `start.sh` — local boot helper
- `scripts/build-production.sh`, `scripts/rollback.sh`, `scripts/deploy/` — ECS-specific
- `GITHUB_ACTIONS_DEPLOYMENT.yml` — GitHub Actions config (in repo root, unusual location)

## Top 30 Package Versions Table

| # | Package | Version | Purpose |
|---|---------|---------|---------|
| 1 | typescript | 5.3.3 | TS compiler |
| 2 | @prisma/client | 5.22.0 | ORM runtime |
| 3 | prisma | 5.22.0 | ORM CLI |
| 4 | express | 4.18.2 | HTTP framework |
| 5 | socket.io | 4.7.2 | WebSocket server |
| 6 | @socket.io/redis-streams-adapter | 0.3.0 | Multi-instance socket fanout (primary) |
| 7 | @socket.io/redis-adapter | 8.3.0 | Pub/sub adapter (legacy fallback) |
| 8 | ioredis | 5.9.2 | Redis client (production) |
| 9 | redis | 4.6.12 | node-redis client (alt path) |
| 10 | firebase-admin | 13.6.0 | FCM push |
| 11 | jsonwebtoken | 9.0.2 | JWT |
| 12 | bcryptjs | 2.4.3 | Password hashing |
| 13 | zod | 3.22.4 | Schema validation |
| 14 | winston | 3.11.0 | Logging |
| 15 | helmet | 7.1.0 | Security headers |
| 16 | cors | 2.8.5 | CORS |
| 17 | compression | 1.7.4 | Gzip |
| 18 | express-rate-limit | 7.1.5 | Rate limiter middleware |
| 19 | multer | 2.0.2 | Multipart upload |
| 20 | h3-js | 4.4.0 | Uber H3 geo-indexing |
| 21 | @aws-sdk/client-s3 | 3.978.0 | S3 uploads |
| 22 | @aws-sdk/s3-request-presigner | 3.978.0 | S3 presigned URLs |
| 23 | @aws-sdk/client-sns | 3.975.0 | SNS SMS |
| 24 | @aws-sdk/client-kinesis | 3.985.0 | Kinesis tracking-stream sink |
| 25 | @aws-sdk/client-location | 3.975.0 | AWS Location Service |
| 26 | dotenv | 16.3.1 | .env loader |
| 27 | uuid | 9.0.1 | UUID generation |
| 28 | jest | 29.7.0 | Test runner |
| 29 | ts-jest | 29.4.6 | TS Jest transformer |
| 30 | ts-node-dev | 2.0.0 | Dev hot-reload |
| 31 | eslint | 8.56.0 | Linter |
| 32 | @typescript-eslint/parser | 7.18.0 | ESLint TS parser |

## Platform Requirements

**Development:**
- Node.js >= 18 (Node 20 recommended for Docker parity)
- npm 7+ (`legacy-peer-deps` flag required)
- Docker + Docker Compose (for local Postgres/Redis)
- Optional: Redis 7+, PostgreSQL 15+ if running outside Docker

**Production:**
- AWS ECS Fargate (linux/amd64), `node:20-alpine` base
- AWS RDS PostgreSQL (db.t4g.micro for staging, db.r6g.large recommended for production with `max_connections` ≥ 1600)
- AWS ElastiCache Redis 7.4+ (or 7.1 + `USE_PEXPIRE_FALLBACK=true`)
  - **MUST** be configured with `maxmemory-policy=noeviction` (boot-time assertion, fatal on mismatch)
  - Pub/sub support required (or `REDIS_PUBSUB_DISABLED=true` with reduced socket fanout)
- AWS Application Load Balancer (idle timeout 60s — server `keepAliveTimeout=65s` accommodates this)
- AWS S3 bucket for uploads (presigned URLs)
- AWS SNS for SMS (or Twilio/MSG91)
- Firebase project with service account JSON (FCM credentials are a hard production boot guard — `src/server.ts:225-236`)
- Optional: AWS Kinesis stream for tracking telemetry (`TRACKING_STREAM_PROVIDER=kinesis`)
- Optional: AWS Location Service for road routing fallback (`AWS_LOCATION_ENABLED=true`)
- Optional: AWS Secrets Manager for credential rotation
- CloudWatch namespace `Weelo/Backend` for metrics export (via metric-filter / EMF pipeline — see `scripts/monitoring/setup-broadcast-p1-alarms.sh`)

**Min OS / Mobile clients:**
- Customer App (Android/iOS) and Captain App (Android, Kotlin) — backend versions are aligned via `MIN_SUPPORTED_APP_VERSION` env var; FCM upgrade campaign feature flag triggers force-upgrade pushes.

---

*Stack analysis: 2026-05-04*
