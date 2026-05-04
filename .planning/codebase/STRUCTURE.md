# Codebase Structure

**Analysis Date:** 2026-05-04

## Top-level Directory Layout

```
weelo-backend/
├── src/                              # All TypeScript source (689 .ts files in src/)
├── packages/                         # Versioned shared contracts
│   └── contracts/                    # AsyncAPI / proto-driven event + enum codegen
├── prisma/                           # Prisma schema + migrations
│   ├── migrations/                   # Generated Prisma migrations
│   └── manual-migrations/            # Hand-rolled SQL (DB was set up via prisma db push)
├── migrations/                       # Out-of-band SQL (M-001 … M-017, plus phase3 SQL)
├── scripts/                          # Operations / one-off scripts (replay, cleanup, smoke harness, deploy)
│   ├── chaos/                        # Chaos engineering harness
│   ├── deploy/                       # Deploy helpers
│   ├── load/                         # Load-test harness
│   ├── monitoring/                   # Alarms setup
│   ├── security/                     # Security automation
│   ├── synthetic/                    # Synthetic probes
│   ├── token-rotation/               # JWT secret rotation flow
│   └── __tests__/                    # Tests for scripts
├── docs/                             # Long-form architecture + ops docs
│   ├── ops/                          # SQL/runbooks for operators
│   ├── runbooks/                     # Operational runbooks
│   └── superpowers/                  # Plans + specs (legacy planning artefacts)
├── docker/                           # Docker-related auxiliary configs
│   └── pgbouncer/                    # PgBouncer config
├── e2e/                              # Playwright E2E specs (Captain + Customer)
├── eslint-rules/                     # Custom ESLint rules + tests
│   └── __tests__/                    # Rule unit tests
├── tools/                            # CI/dev tooling
│   └── ci/                           # CI scripts
├── coverage/                         # Jest coverage output (gitignored)
├── dist/                             # TypeScript build output (see "Dist & build artifacts" below)
├── logs/                             # Local log output (gitignored)
├── node_modules/                     # Dependencies (gitignored)
├── graphify-out/                     # Graphify visualisations (graph.html, graph.json)
├── .planning/                        # Planning workspace (this file lives here)
├── .claude/                          # Claude project config
├── .council-2026-04-24/              # Multi-agent council artifacts (Apr 24 cycle)
├── .council-2026-04-26/              # Multi-agent council artifacts (Apr 26 cycle)
├── .code-review-graph/               # 220 MB graph.db + wiki (code review graph DB)
├── .taskmaster/                      # Task automation config
├── .github/                          # GitHub Actions
├── .git/                             # Git history
├── package.json                      # Manifest (scripts: dev, start, start:cluster, test, lint, typecheck)
├── package-lock.json
├── package-lock 2.json               # Stale duplicate (rename or remove)
├── tsconfig.json                     # TypeScript config
├── jest.config.js                    # Jest config (root-level)
├── docker-compose.yml                # Local dev compose
├── docker-compose.chaos.yml          # Chaos compose
├── Dockerfile / Dockerfile.production
├── deploy-production.sh / deploy.sh / start.sh / rollback.sh
├── ecosystem.config.js               # PM2 config
├── test-*.sh                         # Shell-based smoke tests (legacy)
├── README.md / CLAUDE.md / AGENTS.md / COMPREHENSIVE_FLOW_ANALYSIS.md / DB_MIGRATION_SYSTEM.md
├── .env.example                      # Public env template (committed)
├── .env / .env.production / .env.production.example / .env.production.backup  # NOT committed (verify)
├── .eslintrc.json (+ .eslintrc.eslint-rules.json + .eslintrc.pii-overlay.json)
├── .gitignore / .dockerignore / .eslintignore
├── .coderabbit.yaml                  # CodeRabbit config
└── .mcp.json                         # MCP servers config
```

### Top-level directory purposes

**`src/`** — All TypeScript source code. 689 `.ts` files. See full tree below.

**`packages/contracts/`** — Versioned shared contracts (currently a single package). Hosts AsyncAPI YAML for socket events and a proto schema for enums. Generates TypeScript bindings that the backend imports as `'../../../packages/contracts/events.generated'`. Regen with `node packages/contracts/codegen.mjs`.

**`prisma/`** — Prisma schema (currently empty file `prisma/schema.prisma` size 0 bytes — schema may have been moved/regenerated; cross-reference with manual-migrations) + migrations + `manual-migrations/`. README warns: DB was originally set up with `prisma db push`, so `_prisma_migrations` table does not exist on production — schema changes must use direct SQL.

**`migrations/`** — Out-of-band SQL applied directly to production (M-001 … M-017 + phase3 SQL). Convention: `M-NNN-short-description.sql`. Examples: `M-009-hold-phase-backfill.sql` (irreversible), `M-014-truckholdledger-confirmed-at-legacy.sql`, `M-015-flex-hold-dedup-partial-index.sql`.

**`scripts/`** — Operations scripts. Highlights: `boot-dryrun.ts`, `replay-broadcast-dlq.ts` (DLQ drainer), `cleanup-legacy-*-keys.ts` (Redis key cleanup), `phase3-smoke-harness.ts`, `phase3-sql-dry-run.ts`, `verify-env-example.ts`, `regenerate-presigned-urls.ts`, `fix-stuck-vehicles.sql`, `init-db.sql`, `docker-entrypoint.sh`, `build-production.sh`, `rollback.sh`. Subdirs: `chaos/`, `deploy/`, `load/`, `monitoring/`, `security/`, `synthetic/`, `token-rotation/`.

**`docs/`** — Architecture + ops documentation. `ARCHITECTURE-2026-05-03.md` (250 KB) and HTML render. `runbooks/` for ops, `superpowers/` for legacy planning, `ops/` for SQL fixtures.

**`docker/`** — Docker auxiliaries (PgBouncer config). Compose files live at root.

**`e2e/`** — Playwright specs. Two specs: `captain-weelo-captain.spec.ts`, `customer-weelo.spec.ts`. Per CLAUDE-rules, Playwright is the standard E2E framework for TypeScript projects.

**`eslint-rules/`** — Custom rules:
- `cas-vehicle-update-must-check-count.js` — enforces caller checks Prisma `updateMany` `count` field for atomic vehicle status writes.
- `lock-holder-must-be-randomUUID.js` — `redisService.acquireLock` holder must be `randomUUID()`-generated, not template literals.
- `no-pii-in-redis-key.js` — bans phone/email/name in Redis keys.
- `no-setinterval-without-unref.js` — every `setInterval` must `.unref()` so it doesn't block process exit.

**`tools/ci/`** — CI helpers.

**`graphify-out/`** — Output of Graphify (codebase graph: `graph.html` 5MB, `graph.json` 7MB, `manifest.json`).

**`coverage/`, `dist/`, `logs/`, `node_modules/`** — Build/output (gitignored).

**`.planning/`** — Planning workspace. Subdirs include `arch-rewrite-2026-05-03/`, `claude-revalidation-customer-flow/`, `claude-team-final-index/`, `codebase/` (this directory), `master-execution-plan/`, `phase1-rps-validation-2026-04-27/`, `phases/`, `plan-reviews-2026-04-23/`, `re-review-2026-04-23/`, `research/`, `review-2026-04-21/`, `reviews/`, `runbooks/`, `transporter_to_driver_fix_plan/`, `verification/`, `final-verification/`. `config.json` is per-project Claude planner state.

**`.claude/`** — Project Claude config.

**`.council-2026-04-24/`, `.council-2026-04-26/`** — Multi-agent "council" review cycles. Snapshots of agent outputs.

**`.code-review-graph/`** — 220 MB graph database (`graph.db`) + `wiki/` for code-review tool output. Likely gitignored.

**`.taskmaster/`** — Task management config.

**`.github/`** — GitHub Actions workflows.

## `src/` Directory Map

```
src/
├── server.ts                         # 1426 LOC — Express bootstrap, mounts routers, runs bootstrap()
├── cluster.ts                        # 243 LOC — node:cluster primary, forks N workers
├── instrument.ts                     # 17 LOC — Sentry SDK init
├── instrumentation.ts                # 40 LOC — OpenTelemetry NodeSDK init
├── core/                             # Foundation: config, errors, responses, state machines
├── config/                           # Runtime config (separate from core/config — see "config split" below)
├── shared/                           # Cross-cutting infrastructure
├── modules/                          # Feature modules (26 directories)
├── database/                         # Single SQL fixture (recommended-indexes.sql)
└── __tests__/                        # Top-level integration / scenario / regression tests (340+ files)
```

### `src/core/` — Foundation
```
core/
├── index.ts                          # Barrel: constants, errors, responses, env validation
├── state-machines.ts                 # Booking, Order, Vehicle, Assignment FSMs + helpers
├── config/
│   ├── env.validation.ts             # validateAndLogEnvironment() — declarative env spec
│   ├── hold-config.ts                # HOLD_CONFIG (FLEX/CONFIRMED/driver windows) + BROADCAST_DEDUP_TTL_BUFFER_SECONDS
│   ├── index.ts                      # Barrel
│   └── __tests__/                    # Per-test for env validation
├── constants/
│   └── index.ts                      # ErrorCode enum + HTTP_STATUS map
├── errors/
│   ├── AppError.ts                   # AppError + 9 standard subclasses + domain-specific (BookingNotFoundError etc.)
│   └── index.ts                      # Barrel
└── responses/
    ├── ApiResponse.ts                # ApiResponse static helpers + parsePagination
    └── index.ts                      # Barrel
```

### `src/config/` — Runtime config (separate from core/config)
```
config/
├── environment.ts                    # 12k LOC — config object: port, jwt, cors, trustedProxyCidrs, isDevelopment, isProduction, nodeEnv. THIS is the canonical runtime config object.
├── aws.config.ts                     # 11k LOC — AWS region/credentials/SDK clients
├── production.config.ts              # 7k LOC — production-only overrides
└── secrets.ts                        # Secrets manager wrapper
```
**Config split rationale:** `core/config/` holds domain-specific constants (env-validation spec, hold-config). `config/` holds the live runtime configuration object that everything imports. Keep them separate; do not merge.

### `src/shared/` — Cross-cutting infrastructure
```
shared/
├── api-response.builder.ts           # Lightweight ApiResponse wrapper used in some routes
├── config/
│   ├── feature-flags.ts              # 47k LOC — flag registry, isEnabled, getNumericFlag, validate, flagHealthRouter
│   ├── presence.config.ts            # Heartbeat/TTL constants
│   └── __tests__/                    # Tests
├── context/
│   └── correlation.ts                # AsyncLocalStorage — correlationMiddleware, withCorrelation, getCorrelationId
├── database/
│   ├── prisma.service.ts             # 86k LOC — prismaClient, prismaReadClient, withDbTimeout, type re-exports
│   ├── prisma-client.ts              # Pure construction (no service deps)
│   ├── db.ts                         # Legacy db facade (Prisma-only; JSON DB removed)
│   ├── read-router.ts                # Read replica routing
│   ├── record-helpers.ts             # Record-shape transforms
│   ├── record-types.ts               # Record interfaces (LocationRecord, OrderRecord, etc.)
│   ├── repository.interface.ts       # Generic repository abstraction
│   └── repositories/                 # Per-aggregate repos
│       ├── assignment.repository.ts
│       ├── booking.repository.ts
│       ├── order.repository.ts
│       ├── stats.repository.ts
│       ├── tracking.repository.ts
│       ├── truck-request.repository.ts
│       ├── user.repository.ts
│       └── vehicle.repository.ts
├── errors/
│   └── error-catalog.ts              # Error code registry
├── jobs/                             # Cron-style background jobs (not BullMQ-managed)
│   ├── cleanup-expired-orders.job.ts
│   ├── cleanup-order-idempotency.job.ts
│   ├── cleanup-status-events.job.ts
│   └── trip-sla-monitor.job.ts
├── middleware/
│   ├── auth.middleware.ts            # 12k — authMiddleware + roleGuard
│   ├── backward-compat.middleware.ts # Path rewriter for legacy Captain paths
│   ├── error.middleware.ts           # Global errorHandler + asyncHandler + notFoundHandler
│   ├── rate-limiter.middleware.ts    # 33k — layered rate limit + ipUpgradeTokenBucket
│   ├── request-logger.middleware.ts
│   ├── security.middleware.ts        # Helmet + sanitize + suspicious-request blocker + requestIdMiddleware
│   └── transporter-rate-limit.middleware.ts
├── monitoring/
│   ├── metrics.service.ts            # 32k — Prom-style metrics singleton
│   ├── metrics-definitions.ts        # 60k — single-source registry of counters/gauges/histograms
│   ├── observability-only-metrics.ts
│   ├── redis-eviction-assertion.ts   # noeviction policy assertion at boot
│   └── broadcast-decline-table-assertion.ts
├── queue-processors/                 # Per-queue processors registered with queueService
│   ├── index.ts                      # Barrel
│   ├── broadcast.processor.ts
│   ├── push-notification.processor.ts
│   ├── fcm-batch.processor.ts
│   ├── tracking-events.processor.ts
│   ├── vehicle-release.processor.ts
│   ├── assignment-reconciliation.processor.ts
│   ├── assignment-timeout-poller.ts  # In-process poller (not a queue processor)
│   └── audit-retention.ts            # Leader-locked schedule
├── resilience/
│   ├── circuit-breaker.ts            # 11k — generic CB (CLOSED/OPEN/HALF-OPEN)
│   └── request-queue.ts              # 9k — bounded request queue (used as Express middleware)
├── routes/
│   └── health.routes.ts              # 17k — / + /health + /health/live + /health/ready + /health/deep
├── services/                         # 40+ singleton services (the heart of the codebase)
│   ├── logger.service.ts             # Pino-style structured logger
│   ├── redis.service.ts              # 110k facade
│   ├── redis-cache.service.ts
│   ├── redis-cluster-scan.ts         # Cluster-safe SCAN
│   ├── redis-coordination.service.ts
│   ├── redis/
│   │   ├── index.ts                  # Re-exports + singleton redisService
│   │   ├── redis.service.ts          # Inner facade
│   │   ├── real-redis.client.ts      # ioredis-backed
│   │   ├── in-memory-redis.client.ts # Dev fallback
│   │   └── redis.types.ts            # IRedisClient, IRedisTransaction, GeoMember, LockResult, RedisConfig
│   ├── socket.service.ts             # 130k — all real-time
│   ├── queue.service.ts              # 119k — InMemory/Redis queues, processors, DLQ, backpressure
│   ├── queue.types.ts
│   ├── queue-backlog-gate.ts         # Per-queue backpressure policy
│   ├── notification-outbox.service.ts # 23k — durable outbox for socket+FCM events
│   ├── fcm.service.ts                # 73k — Firebase Admin wrapper
│   ├── fcm-data-coerce.ts
│   ├── fcm-upgrade-campaign.ts
│   ├── fcm-version-gate.ts
│   ├── availability.service.ts       # 40k — online set + GEO sorted sets
│   ├── availability-cache.service.ts
│   ├── availability-geo.service.ts
│   ├── availability-types.ts
│   ├── live-availability.service.ts  # 16k — counter of available trucks
│   ├── h3-geo-index.service.ts       # 19k — Uber H3 hex-cell index
│   ├── fleet-cache.service.ts
│   ├── fleet-cache-read.service.ts
│   ├── fleet-cache-write.service.ts
│   ├── fleet-cache-types.ts
│   ├── distance-matrix.service.ts    # 16k — Google Distance Matrix wrapper + CB
│   ├── directions-api.service.ts     # 15k — Google Directions wrapper
│   ├── google-maps.service.ts        # 25k — Geocoding + Places
│   ├── candidate-scorer.service.ts   # 16k — composite ranking
│   ├── transporter-online.service.ts # 18k — heartbeat + presence + stale cleanup
│   ├── tracking-stream-sink.ts       # Redis Streams sink
│   ├── vehicle-key.service.ts        # generateVehicleKey + candidates
│   ├── vehicle-lifecycle.service.ts  # releaseVehicle()
│   ├── vehicle-transition-outbox.service.ts # F-A-64 outbox poller
│   ├── circuit-breaker.service.ts    # 15k — socket/external CB singletons
│   ├── leader-election.service.ts    # acquireLeader for singleton background tasks
│   ├── rate-limit.service.ts         # Token bucket primitives
│   ├── audit.service.ts
│   ├── audit.schema.ts
│   ├── audit-sanitizer.ts
│   ├── exotel.service.ts             # OTP delivery
│   ├── s3-upload.service.ts          # Presigned URLs
│   ├── cache.service.ts              # 18k — typed cache primitives
│   └── __tests__/                    # Service tests
├── types/
│   ├── api.types.ts
│   ├── authenticated-request.ts      # Express req.user augmentation
│   ├── error.types.ts                # AppError canonical
│   ├── express.d.ts                  # Express type augmentation (req.user, req.userId)
│   ├── queue-payloads.ts             # Typed queue payloads
│   └── socket-events.ts              # Re-exports SocketEvent
└── utils/
    ├── broadcast-payload.normalizer.ts
    ├── broadcast-snapshot.builder.ts
    ├── canonical-hash.ts             # Deterministic JSON hashing
    ├── crypto.utils.ts               # HMAC + AES helpers
    ├── error.utils.ts
    ├── geo.utils.ts                  # Haversine
    ├── geospatial.utils.ts           # Bounding box
    ├── idempotency.utils.ts          # readOrGenerateIdempotencyKey + cache helpers
    ├── net.utils.ts                  # getClientIpChain, isInCidrList
    ├── order-lifecycle.utils.ts
    ├── pii.utils.ts                  # maskPhoneForLog, maskName
    ├── response-builders.ts
    ├── retry.ts                      # Exponential backoff
    ├── safe-json.utils.ts            # Defensive JSON parse
    ├── signing-secret.ts             # getIdempotencySigningSecret (fail-fast in prod)
    ├── truncate.ts
    └── validation.utils.ts
```

### `src/modules/` — Feature modules
26 directories. Each typically has: `*.routes.ts` (Express), `*.service.ts` (business), `*.schema.ts` (Zod), `*.types.ts` (interfaces), `index.ts` (barrel). Some have `*.controller.ts` (legacy thin shim).

```
modules/
├── admin/                            # Admin endpoints
│   ├── admin.routes.ts               # /users/:id/{suspend,warn,unsuspend,status,actions}, dispatch retry, dispute resolve, order rebroadcast
│   ├── admin-tier.routes.ts          # Tier management
│   ├── admin.controller.ts           # Thin shim
│   ├── admin-suspension.service.ts   # Suspension policy
│   └── index.ts
├── assignment/                       # Driver assignment lifecycle
│   ├── assignment.routes.ts          # POST /, GET /, /driver, /driver/active, /:id/{accept,decline,driver-cancel,status,transporter-override}, DELETE /:id
│   ├── assignment.controller.ts      # Thin shim
│   ├── assignment.service.ts         # 107k facade
│   ├── assignment-lifecycle.service.ts # 35k
│   ├── assignment-response.service.ts # 24k
│   ├── assignment-dispatch.service.ts # 13k
│   ├── assignment-query.service.ts
│   ├── auto-redispatch.service.ts    # On decline → next driver
│   ├── completion-orchestrator.ts    # 21k
│   ├── post-accept.effects.ts        # 10k — fan-out after accept
│   ├── assignment.schema.ts
│   ├── assignment.types.ts
│   └── index.ts
├── auth/                             # Customer + transporter auth (OTP)
│   ├── auth.routes.ts                # POST /send-otp, /verify-otp, /refresh, /logout, GET /me
│   ├── auth.controller.ts
│   ├── auth.service.ts               # 39k
│   ├── otp-challenge.service.ts      # 14k
│   ├── sms.service.ts                # 15k Exotel integration
│   ├── auth.schema.ts
│   ├── index.ts
│   └── __tests__/                    # auth.service.otp.test.ts, otp-challenge.service.test.ts
├── booking/                          # Customer booking (LEGACY single-vehicle path)
│   ├── booking.routes.ts             # 47k facade — POST /, GET /, /active, /:id, /:id/trucks, /:id/cancel + /bookings/orders/* legacy proxies
│   ├── booking-crud.routes.ts        # Sub-router (CRUD)
│   ├── booking-legacy.routes.ts      # Sub-router (legacy ports)
│   ├── booking.controller.ts         # Thin shim
│   ├── booking.service.ts            # 124k facade
│   ├── booking-create.service.ts     # 40k
│   ├── booking-broadcast.service.ts  # 26k progressive radius broadcast
│   ├── booking-lifecycle.service.ts  # 47k
│   ├── booking-radius.service.ts     # 27k progressive radius expansion
│   ├── booking-rebroadcast.service.ts # 14k
│   ├── booking-timer.service.ts
│   ├── booking-query.service.ts
│   ├── booking-payload.helper.ts
│   ├── booking-context.ts            # Shared context object
│   ├── booking.schema.ts             # 15k
│   ├── booking.types.ts              # BOOKING_CONFIG, RADIUS_EXPANSION_CONFIG, TIMER_KEYS, RADIUS_KEYS
│   ├── legacy-order-accept.service.ts # 21k
│   ├── legacy-order-create.service.ts
│   ├── legacy-order-expiry.service.ts
│   ├── legacy-order-query.service.ts
│   ├── legacy-order-timeout.service.ts
│   ├── legacy-order-types.ts
│   ├── order.service.ts              # 43k LEGACY order service inside booking module (NOT canonical)
│   ├── index.ts
│   └── __tests__/                    # booking.routes.legacy-proxy.test.ts
├── broadcast/                        # Driver-facing broadcast surface (legacy/single-vehicle)
│   ├── broadcast.routes.ts           # GET /active, /history, /:broadcastId, POST /:broadcastId/{accept,decline}, /create
│   ├── broadcast.service.ts          # 50k
│   ├── broadcast-accept.service.ts   # 41k
│   ├── broadcast-dispatch.service.ts
│   ├── broadcast-query.service.ts
│   ├── broadcast-dto.normalizer.ts
│   ├── broadcast.schema.ts
│   └── index.ts
├── custom-booking/                   # Long-term contracts
│   ├── customBooking.routes.ts       # NOTE: camelCase filename (rest of codebase uses kebab)
│   ├── customBooking.service.ts
│   ├── customBooking.schema.ts
│   └── index.ts
├── customer/                         # Customer-only endpoints
│   ├── customer.routes.ts
│   └── customer.service.ts           # No barrel index.ts, no schema/types files
├── driver/                           # Driver dashboard, availability, presence
│   ├── driver.routes.ts              # 42k facade composing sub-routers
│   ├── driver-dashboard.routes.ts
│   ├── driver-onboarding.routes.ts   # 17k (NOTE: separate from /modules/driver-onboarding)
│   ├── driver-profile.routes.ts
│   ├── regenerate-urls.route.ts      # NOTE: singular filename (only file using ".route.ts")
│   ├── driver.service.ts             # 56k
│   ├── driver-presence.service.ts    # 29k Redis presence + heartbeat
│   ├── driver-management.service.ts
│   ├── driver-performance.service.ts # 18k earnings
│   ├── presence-flap.detector.ts
│   ├── driver.schema.ts
│   ├── driver.types.ts
│   └── index.ts
├── driver-auth/                      # Driver-only auth
│   ├── driver-auth.routes.ts         # POST /send-otp, /verify-otp, /logout
│   ├── driver-auth.controller.ts
│   ├── driver-auth.service.ts        # 23k
│   ├── driver-auth.schema.ts
│   └── __tests__/                    # driver-auth.service.otp.test.ts
├── driver-onboarding/                # KYC flow (separate module from driver/)
│   ├── driver-onboarding.routes.ts
│   └── driver-onboarding.service.ts
├── hold-expiry/                      # Hold reconciliation (no HTTP routes)
│   ├── hold-expiry-cleanup.service.ts # 18k — registers `hold-expiry` queue processor + 60s reconciler
│   ├── hold-reconciliation.service.ts # 11k — Layer-2 production-only 30s sweep
│   └── index.ts
├── notification/                     # FCM token registration (NO service layer — direct prismaClient)
│   └── notification.routes.ts        # POST /register-token, DELETE /unregister-token, GET/PUT/POST /preferences
├── order/                            # Multi-truck order system (CANONICAL)
│   ├── order.routes.ts               # 46k — POST /, GET /:id, /active, /:orderId/{cancel,cancel-preview,cancel/dispute,continue-partial,search-again,status,broadcast-snapshot}
│   ├── order-crud.routes.ts          # Sub-router
│   ├── order-lifecycle.routes.ts     # Sub-router
│   ├── order-progress.routes.ts      # Sub-router
│   ├── order.service.ts              # 85k facade
│   ├── order-creation.service.ts     # 42k
│   ├── order-accept.service.ts       # 32k
│   ├── order-broadcast.service.ts    # 53k
│   ├── order-broadcast-send.service.ts # 37k
│   ├── order-broadcast-query.service.ts
│   ├── order-broadcast-helpers.ts
│   ├── order-cancel.service.ts       # 25k
│   ├── order-cancel-policy.service.ts
│   ├── order-dispatch-outbox.service.ts # 20k
│   ├── order-lifecycle-outbox.service.ts # 52k
│   ├── order-delegates.service.ts
│   ├── order-delegates-bridge.service.ts # 19k
│   ├── order-idempotency.service.ts  # OrderIdempotency table interactions
│   ├── order-query.service.ts
│   ├── order-timer.service.ts        # Redis ZSET timers + recoverOrphanedStepTimers
│   ├── order-create-context.ts       # Shared context
│   ├── order-types.ts
│   ├── order-core-types.ts
│   ├── order-id-cache.ts
│   ├── order.contract.ts             # Order shape contract
│   ├── customer-progress-mirror.ts   # buildCustomerProgressMirrorPayload
│   └── progressive-radius-matcher.ts # PROGRESSIVE_RADIUS_STEPS (10/15/20/25/30/40 km)
├── order-timeout/                    # Smart timeout + progress (PRD 7777)
│   ├── smart-timeout.service.ts      # 26k — base 120s + 60s/30s extensions, leader-elected
│   ├── progress.service.ts           # 12k — order progress aggregation
│   └── index.ts
├── pricing/                          # Fare estimation
│   ├── pricing.routes.ts
│   ├── pricing.service.ts            # 21k
│   ├── pricing.schema.ts
│   ├── vehicle-catalog.ts            # 20k pricing rules per vehicle
│   ├── index.ts
│   └── __tests__/                    # pricing.service.test.ts
├── profile/                          # Profile CRUD across roles
│   ├── profile.routes.ts
│   ├── profile.service.ts
│   ├── profile.schema.ts
│   └── index.ts
├── rating/                           # Customer ratings
│   ├── rating.routes.ts
│   ├── rating.service.ts             # 15k
│   ├── rating-reminder.service.ts
│   └── rating.schema.ts
├── routing/                          # Geocoding + Places + multi-stop
│   ├── geocoding.routes.ts           # 18k
│   ├── routing.service.ts            # 17k
│   ├── routing.schema.ts
│   ├── route-multi.schema.ts
│   └── index.ts
├── tracking/                         # Live tracking + trip lifecycle + POD
│   ├── tracking.routes.ts            # 20k — POST /update, GET /:tripId, /booking/:id, /history/:tripId, /fleet, etc.
│   ├── pod.routes.ts                 # POD upload + delivery confirmation
│   ├── tracking.controller.ts
│   ├── tracking.service.ts           # 95k facade
│   ├── tracking-trip.service.ts      # 39k
│   ├── tracking-location.service.ts  # 21k
│   ├── tracking-fleet.service.ts     # 24k
│   ├── tracking-history.service.ts   # 11k
│   ├── tracking-query.service.ts
│   ├── pod.service.ts
│   ├── tracking-access.policy.ts     # Trip-access guard
│   ├── tracking.schema.ts
│   ├── tracking.types.ts
│   └── index.ts
├── transporter/                      # Transporter availability + dispatch
│   ├── transporter.routes.ts         # 46k MONOLITH — PUT /availability, GET /availability, POST /heartbeat, GET /availability/stats, GET /profile, PUT /profile, GET /stats, GET /dispatch/replay
│   ├── transporter-dispatch.routes.ts # ORPHAN STUB — 501 for tests; NOT mounted
│   └── transporter-profile.routes.ts # NOT mounted
├── trip/                             # Trip-level PII reveal
│   └── trip-pii.routes.ts            # Driver-only unmask endpoint (mounted under /api/v1/trips)
├── truck-hold/                       # Two-phase hold (DIFFERENTIATOR)
│   ├── truck-hold.routes.ts          # 44k — POST /hold, /confirm-with-assignments, /release, GET /my-active, /availability/:orderId, POST /flex-hold(+/extend), GET /flex-hold/:holdId, POST /confirmed-hold/initialize, GET /confirmed-hold/:holdId, PUT /driver/:assignmentId/{accept,decline}, POST /order-timeout/{initialize,extend}, GET /order-timeout/:orderId, /order-progress/:orderId, /order-assignments/:orderId
│   ├── truck-hold-lifecycle.routes.ts # ORPHAN BY DESIGN — IS_ORPHAN_ROUTER=true, CI test enforces unmounted
│   ├── truck-hold-crud.routes.ts     # Sub-router
│   ├── truck-hold.service.ts         # 100k facade
│   ├── flex-hold.service.ts          # 38k Phase 1
│   ├── confirmed-hold.service.ts     # 86k Phase 2
│   ├── cascade-dispatch.service.ts   # 25k driver-decline → next driver
│   ├── reassign-driver.service.ts    # 23k
│   ├── truck-hold-confirm.service.ts # 40k
│   ├── truck-hold-create.service.ts  # 19k
│   ├── truck-hold-cleanup.service.ts # 12k
│   ├── truck-hold-query.service.ts   # 13k
│   ├── truck-hold-release.service.ts
│   ├── truck-hold-store.service.ts
│   ├── hold-state-machine.ts         # FLEX→CONFIRMED CAS guard (assertHoldPhaseTransition + guardedConfirmFlexToConfirmed)
│   ├── hold-eligibility.ts           # validateActorEligibility
│   ├── hold-finalize-retry.processor.ts # Retry queue for confirmed-hold finalization
│   ├── confirmed-hold.types.ts
│   ├── truck-hold.types.ts
│   └── index.ts                      # Barrel + IS_ORPHAN_ROUTER export for CI
├── user/                             # User self-service (legacy)
│   ├── user.routes.ts
│   ├── user.controller.ts
│   ├── user.service.ts
│   ├── user.schema.ts
│   └── index.ts
└── vehicle/                          # Truck/Vehicle CRUD + status
    ├── vehicle.routes.ts             # 26k — GET /types, /pricing, /list, /available, /summary, /stats, /check/:vehicleNumber, POST /, PUT /upsert, GET/PUT/DELETE /:vehicleId, PUT /:vehicleId/{status,maintenance,available}
    ├── vehicle.controller.ts
    ├── vehicle.service.ts            # 29k
    ├── vehicle-crud.service.ts       # 18k
    ├── vehicle-status.service.ts
    ├── vehicle.catalog.ts            # Static vehicle catalog
    ├── vehicle.schema.ts
    └── index.ts
```

### `src/database/` — Tiny / mostly empty
```
database/
└── recommended-indexes.sql           # Hand-written index recommendations (informational only)
```
**Why both `src/database/` and `src/shared/database/`:** `src/database/` is a vestigial location for raw SQL; live DB code lives in `src/shared/database/`. Do not add new code to `src/database/`.

### `src/__tests__/` — Top-level tests
340+ `.test.ts` files. Subdirectories:
```
__tests__/
├── __helpers__/                      # Test fixtures
│   ├── lock-mock.ts                  # acquireLock mock
│   └── with-env.ts                   # Env scoping helper
├── differentiator/                   # Critical-flow tests (FAILING ANY OF THESE BLOCKS RELEASE)
│   ├── multi-vehicle-hold-concurrent.test.ts
│   └── two-phase-hold-fsm.test.ts    # Forward-compat check for FLEX→CONFIRMED FSM
└── scenarios/                        # End-to-end / contract scenarios
    ├── cas-stress-300rps.test.ts
    ├── customer-booking-end-to-end.test.ts
    ├── dpdp-pii-leakage.test.ts      # DPDP/GDPR PII leakage
    ├── fcm-cross-channel-dedup.test.ts
    ├── queue-backpressure.test.ts
    └── refresh-token-rotation-e2e.test.ts
```
Plus a flat list of regression / phase / hardening tests at the top level (e.g. `phase1-*`, `phase2-*`, …, `phase8-*`, `qa-*`, `tiger-*`, `falcon-*`, `eagle-*`, `hawk-*`, `lion-*`, `leo-*` — each phase represents a distinct hardening cycle, see commit history). Naming heavily reflects task IDs from `.planning/`.

## Naming Conventions

**Files:**
| Suffix | Purpose | Example |
|---|---|---|
| `*.routes.ts` | Express router | `assignment.routes.ts` |
| `*.controller.ts` | Thin handler shim (legacy) | `auth.controller.ts` |
| `*.service.ts` | Business logic | `booking.service.ts` |
| `*-{x}.service.ts` | Split service for size | `booking-broadcast.service.ts`, `order-creation.service.ts` |
| `*.schema.ts` | Zod validation schemas | `order.routes.ts` imports `createOrderSchema` from `order.schema.ts` (when exists) |
| `*.types.ts` | Pure TypeScript interfaces | `assignment.types.ts` |
| `*.policy.ts` | Access policy | `tracking-access.policy.ts` |
| `*.processor.ts` | Queue processor | `broadcast.processor.ts` |
| `*.job.ts` | Cron-style job | `cleanup-expired-orders.job.ts` |
| `*.config.ts` | Config object | `aws.config.ts` |
| `*.utils.ts` | Pure utility functions | `pii.utils.ts` |
| `*.middleware.ts` | Express middleware | `auth.middleware.ts` |
| `*.repository.ts` | Repository pattern | `order.repository.ts` |
| `*.helper.ts` | Helper functions | `booking-payload.helper.ts` |
| `*.test.ts` | Jest test | `auth.service.otp.test.ts` |
| `*.spec.ts` | Playwright E2E | `customer-weelo.spec.ts` |
| `*.d.ts` | TypeScript declaration | `express.d.ts` |
| `index.ts` | Barrel export | One per module |
| `*.route.ts` (singular) | **Inconsistent** — only `regenerate-urls.route.ts` uses singular | Treat as anomaly |

**Folders:**
- **kebab-case** for module folders (`truck-hold/`, `order-timeout/`, `driver-auth/`).
- **camelCase deviation:** `customBooking.routes.ts`/`customBooking.service.ts` (in otherwise kebab-cased `custom-booking/` directory) — anomaly.
- **`__tests__/`** colocated for per-module tests; top-level `src/__tests__/` for cross-module.
- **`__helpers__/`** for test fixtures.

**Classes / functions:**
- Services exported as **singletons**: `export const fooService = new FooService()`. Most files at the bottom: `export const queueService = new QueueService()`, `export const fcmService = new FcmService()`, `export const redisService = new RedisService()`.
- Top-level helper functions exported individually: `emitToUser`, `getIO`, `withCorrelation`.
- Types: `PascalCase` (`OrderRecord`, `CreateFlexHoldRequest`).
- Constants: `SCREAMING_SNAKE_CASE` (`MAX_GLOBAL_CONNECTIONS`, `BROADCAST_DEDUP_TTL_BUFFER_SECONDS`, `HOLD_VALID_TRANSITIONS`).
- Redis keys: defined as functions/maps under `REDIS_KEYS` per service (e.g. `availability-types.ts`, `booking.types.ts:TIMER_KEYS`). Keys use **colons** (`transporter:presence:{id}`).
- Socket events: `snake_case` wire values, `SCREAMING_SNAKE_CASE` enum members (e.g. `SocketEvent.NEW_BROADCAST = 'new_broadcast'`).

## Key File Locations Table

| Concern | Location |
|---|---|
| **App entry (worker)** | `src/server.ts` |
| **Cluster primary** | `src/cluster.ts` |
| **Sentry init** | `src/instrument.ts` |
| **OpenTelemetry init** | `src/instrumentation.ts` |
| **Route registration** | `src/server.ts:477-536` |
| **Global error handler** | `src/shared/middleware/error.middleware.ts` |
| **404 handler** | `src/server.ts:543` (inline) |
| **Boot env validation** | `src/core/config/env.validation.ts` |
| **Production config validator** | `src/server.ts:622` (`validateProductionConfig`) |
| **Runtime config object** | `src/config/environment.ts` (imports as `config`) |
| **Hold-system constants** | `src/core/config/hold-config.ts` (`HOLD_CONFIG`) |
| **Feature flag registry** | `src/shared/config/feature-flags.ts` (`FLAGS`, `NUMERIC_FLAGS`, `isEnabled`) |
| **Socket.IO setup** | `src/shared/services/socket.service.ts:initializeSocket` |
| **Socket event registry** | `packages/contracts/events.generated.ts` |
| **Enum registry (wire)** | `packages/contracts/enums.generated.ts` |
| **Queue init + processor registry** | `src/shared/services/queue.service.ts:registerDefaultProcessors` |
| **Prisma client** | `src/shared/database/prisma.service.ts:prismaClient` |
| **Read-replica router** | `src/shared/database/read-router.ts` |
| **Redis singleton** | `src/shared/services/redis/index.ts:redisService` |
| **Logger** | `src/shared/services/logger.service.ts:logger` |
| **Metrics** | `src/shared/monitoring/metrics.service.ts:metrics` |
| **AppError canonical** | `src/shared/types/error.types.ts` |
| **State machines (Booking/Order/Vehicle/Assignment)** | `src/core/state-machines.ts` |
| **HoldPhase state machine** | `src/modules/truck-hold/hold-state-machine.ts` |
| **Auth middleware** | `src/shared/middleware/auth.middleware.ts` (`authMiddleware`, `roleGuard`) |
| **Rate limiter** | `src/shared/middleware/rate-limiter.middleware.ts` |
| **Idempotency helper** | `src/shared/utils/idempotency.utils.ts:readOrGenerateIdempotencyKey` |
| **Idempotency signing secret** | `src/shared/utils/signing-secret.ts:getIdempotencySigningSecret` |
| **Health endpoints** | `src/shared/routes/health.routes.ts` |
| **AsyncLocalStorage correlation** | `src/shared/context/correlation.ts` |
| **JWT secret env name** | `JWT_SECRET` (≥ 32 bytes, validated at boot) |
| **DB env name** | `DATABASE_URL` (Prisma) |
| **Socket adapter env** | Implicit via `redisService` |
| **FCM service account env** | `FIREBASE_SERVICE_ACCOUNT` (or `FIREBASE_SERVICE_ACCOUNT_PATH`, or triplet `FIREBASE_PROJECT_ID/PRIVATE_KEY/CLIENT_EMAIL`) |
| **Hold expiry queue processor** | `src/modules/hold-expiry/hold-expiry-cleanup.service.ts:registerHoldExpiryProcessor` |
| **Smart-timeout poller** | `src/modules/order-timeout/smart-timeout.service.ts:startExpiryChecker` |
| **DLQ drainer** | `scripts/replay-broadcast-dlq.ts:drain` |
| **Custom ESLint rules** | `eslint-rules/` |

## Where to Add New Code

| Goal | Location |
|---|---|
| **New REST endpoint** in existing module | `src/modules/<module>/<module>.routes.ts` (add `router.post/get/put/patch/delete`) |
| **New REST endpoint** in new module | Create `src/modules/<new-module>/{routes,service,schema,types,index}.ts`; mount in `src/server.ts:477-536`; add `__tests__/` |
| **New service / business logic** | `src/modules/<module>/<module>.service.ts` (or split file `<module>-<concern>.service.ts` if file > 800 LOC) |
| **New shared infrastructure** (used by 2+ modules) | `src/shared/services/<name>.service.ts` |
| **New cross-cutting middleware** | `src/shared/middleware/<name>.middleware.ts` |
| **New background job** (cron-style, in-process) | `src/shared/jobs/<name>.job.ts` + register in `src/server.ts:bootstrap()` |
| **New BullMQ-style queue processor** | `src/shared/queue-processors/<name>.processor.ts` + register via `queueService.registerProcessor` |
| **New socket event** | Add to `packages/contracts/events.asyncapi.yaml`, regen with `node packages/contracts/codegen.mjs`, then use via `SocketEvent.X` |
| **New enum value** | Add to `packages/contracts/schemas/enums.proto` + regen + update `prisma/schema.prisma` (manual SQL since `_prisma_migrations` doesn't exist) |
| **New Redis key prefix** | Add to per-service `REDIS_KEYS` map; ensure no overlap with `fleetcache:*`, `fleet:*`, `idempotency:*`, etc. (boot asserts F-B-03) |
| **New error class** | `src/core/errors/AppError.ts` (extend existing `AppError` subclass) |
| **New validation schema** | `src/modules/<module>/<module>.schema.ts` (Zod) |
| **New utility (pure function)** | `src/shared/utils/<name>.utils.ts` |
| **New repository** | `src/shared/database/repositories/<name>.repository.ts` (implement `Repository<T>` interface) |
| **New DB schema change** | **Direct SQL** in `migrations/M-NNN-description.sql` — never run `prisma migrate deploy` per CLAUDE.md (production has no `_prisma_migrations` table) |
| **New unit test** | Co-located `src/modules/<module>/__tests__/<thing>.test.ts` OR top-level `src/__tests__/<thing>.test.ts` for cross-module tests |
| **New scenario test** | `src/__tests__/scenarios/<name>.test.ts` |
| **New differentiator test** | `src/__tests__/differentiator/<name>.test.ts` (failure blocks release) |
| **New E2E test** | `e2e/<role>-<flow>.spec.ts` (Playwright) |
| **New custom ESLint rule** | `eslint-rules/<rule-name>.js` + `eslint-rules/__tests__/<rule-name>.test.js`; register in `eslint-rules/index.js` |
| **New script** | `scripts/<name>.ts` (TS) or `scripts/<name>.sh` (shell) |
| **New runbook** | `docs/runbooks/<topic>.md` |

## Special Directories

| Directory | Generated? | Committed? | Purpose |
|---|---|---|---|
| `dist/` | Yes (`tsc`) | No | TypeScript build output. **CONTAINS STALE DUPLICATES** — see Dist & Build Artifacts below. |
| `node_modules/` | Yes (npm) | No | Dependencies. |
| `coverage/` | Yes (Jest) | No | Coverage reports. |
| `logs/` | Yes (runtime) | No | Local logs. |
| `graphify-out/` | Yes (graphify tool) | No | Codebase graph viz. |
| `.code-review-graph/` | Yes (review tool) | Likely no (`.gitignore` inside) | 220 MB graph DB. |
| `.planning/` | Manually authored | Yes (private team workspace) | Plans, reviews, codebase docs. |
| `.council-2026-04-24/`, `.council-2026-04-26/` | Snapshot | Yes | Multi-agent review cycles. |
| `.taskmaster/` | Manually authored | Yes | Task automation config. |
| `prisma/manual-migrations/` | Manually authored | Yes | Hand-rolled SQL outside Prisma migration flow. |
| `migrations/` | Manually authored | Yes | Out-of-band SQL applied to production. |
| `packages/contracts/events.generated.ts` | Yes (codegen) | Yes | **Committed** generated artefact (re-generate via `node packages/contracts/codegen.mjs`). |
| `packages/contracts/enums.generated.ts` | Yes (codegen) | Yes | Same as above. |

## Test Structure

```
src/__tests__/                        # 340+ files
├── __helpers__/                      # Shared test fixtures (lock-mock.ts, with-env.ts)
├── differentiator/                   # 2 critical FSM tests — gate release
├── scenarios/                        # 6 end-to-end behavior scenarios
├── (flat list)                       # Phase / hardening / regression tests
│   ├── phase1-*.test.ts              # Phase 1 fixes (atomic timer ZREM, audit PII, P0 fixes…)
│   ├── phase2-*.test.ts              # Phase 2 fixes (cascade timeout, customer mirror, finalize CAS…)
│   ├── …
│   ├── phase8-*.test.ts              # Phase 8 fixes
│   ├── qa-*.test.ts                  # QA scenario suites (auth, booking, broadcast, race conditions…)
│   ├── eagle-i*.test.ts              # Eagle review iteration tests
│   ├── falcon-fi*.test.ts            # Falcon iteration tests
│   ├── tiger-*.test.ts               # Tiger hardening
│   ├── hawk-*.test.ts                # Hawk stress
│   ├── lion-*.test.ts, leo-*.test.ts # Other review cycles
│   ├── critical-*.test.ts            # Critical-fix verifications
│   ├── fix-*.test.ts                 # Hardening per-module
│   ├── regression-*.test.ts          # Regression guards
│   └── stress-*.test.ts              # Stress / load harness
└── (per-module dirs):                # See per-module structure
    └── (modules with __tests__): auth, booking, custom-booking-N/A, driver-auth, pricing
```

Configuration:
- `jest.config.js` (root) — Jest config.
- `tsconfig.json` (root) — TypeScript project config (paths likely include `@core` via tsconfig paths or barrel re-export).

E2E:
- `e2e/captain-weelo-captain.spec.ts` — Captain app flow.
- `e2e/customer-weelo.spec.ts` — Customer app flow.

## Generated Files

| File | Generator | Source |
|---|---|---|
| `packages/contracts/events.generated.ts` | `node packages/contracts/codegen.mjs` | `events.asyncapi.yaml` |
| `packages/contracts/enums.generated.ts` | Same | `schemas/enums.proto` |
| Prisma client (`@prisma/client`) | `prisma generate` | `prisma/schema.prisma` (currently **0 bytes** — verify before regen) |
| `dist/**` | `tsc` | `src/**/*.ts` |
| `coverage/**` | `jest --coverage` | Test runs |
| `graphify-out/**` | Graphify CLI | Codebase scan |

## Hidden / Dotfiles Worth Knowing

| File / Dir | Role |
|---|---|
| `.env`, `.env.production`, `.env.production.example`, `.env.production.backup` | Environment files. Per-environment values; **never quote contents in any committed artifact** (CLAUDE.md). |
| `.env.example` | Public template (committed). |
| `.eslintrc.json` | Standard ESLint config. |
| `.eslintrc.eslint-rules.json` | Activates custom rules from `eslint-rules/`. |
| `.eslintrc.pii-overlay.json` | PII-specific overlay (no-pii-in-redis-key, etc.). |
| `.eslintignore` | Ignored paths. |
| `.dockerignore` | Docker build ignore list. |
| `.coderabbit.yaml` | CodeRabbit AI review config. |
| `.mcp.json` | MCP servers (LLM tooling). |
| `.taskmaster/` | Task automation. |
| `.planning/` | Team planning workspace (this file lives here). |
| `.council-2026-04-24/`, `.council-2026-04-26/` | Multi-agent council snapshots. Each contains per-agent outputs (e.g. `MANUAL_STEPS_TO_RUN.md`). |
| `.code-review-graph/` | Code review graph DB. |
| `.git/` | Git history. |
| `.github/` | GitHub Actions workflows. |
| `graphify-out/` | Visual codebase graph (HTML + JSON). |
| `package-lock 2.json` | **Stale duplicate** — investigate / remove. |

## Dist & Build Artifacts (KNOWN ISSUE)

The `dist/` directory contains **stale duplicate folders** that should be cleaned:

```
dist/
├── __tests__/                        # OK
├── __tests__ 2/                      # STALE (March 13)
├── config/                           # OK
├── config 2/                         # STALE (March 13)
├── core/                             # OK
├── core 2/                           # STALE (March 13)
├── modules/                          # OK
├── modules 3/                        # STALE (March 13) — note ' 3' suffix, NOT ' 2'
├── shared/                           # OK
├── shared 2/                         # STALE (March 13)
├── server.js, cluster.js, server.d.ts, server-routes.js, server-middleware.js, …
└── packages/, src/                   # Generated build outputs
```

**Why these exist:** macOS Finder copy-on-conflict creates ` 2`, ` 3` suffixed folders when a file system operation collides. These are stale dist artefacts from an earlier build that should have been wiped on `tsc --clean`.

**Fix:** `rm -rf "dist/__tests__ 2" "dist/config 2" "dist/core 2" "dist/modules 3" "dist/shared 2"` and ensure `dist/` is wiped on every build (`scripts/build-production.sh` should `rm -rf dist/` first). Also note `package-lock 2.json` at root — same issue.

These do not affect production deploys (Docker `Dockerfile.production` runs a fresh `tsc`), but they pollute IDE search and balloon `dist/` size.

---

*Structure analysis: 2026-05-04*
