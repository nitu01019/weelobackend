# Architecture

**Analysis Date:** 2026-05-04

## Pattern Overview

**Overall:** Modular monolith with layered (Routes → Service → Repository/Prisma) architecture, an event-driven outbox layer, and a multi-process cluster front. Each domain lives under `src/modules/<name>/`, shares cross-cutting infrastructure under `src/shared/`, and pulls primitives from `src/core/`. There is **no controller/handler layer in most modules** — Express routers contain inline handlers that delegate to services. Real-time concerns are first-class (Socket.IO + BullMQ), and durable lifecycle is enforced via finite state machines and outbox tables.

**Key Characteristics:**
- **Modular monolith** — 26 feature modules under `src/modules/`, single deployable, shared Prisma client (`src/shared/database/prisma.service.ts`).
- **Layered per module** — `*.routes.ts` (Express) → `*.service.ts` (business logic) → `prismaClient` (`src/shared/database/prisma.service.ts`) + `redisService` (`src/shared/services/redis/index.ts`). A thin `*.controller.ts` exists in 6 legacy modules (`auth`, `admin`, `assignment`, `booking`, `tracking`, `vehicle`, `user`, `driver-auth`) but most modules write handlers inline in `.routes.ts`.
- **No DDD aggregates** — services are large procedural classes (e.g. `src/modules/booking/booking.service.ts` is 124k LOC, `src/modules/order/order.service.ts` is 85k, `src/modules/truck-hold/truck-hold.service.ts` is 100k). Decomposition is by **responsibility split files** sharing a context object (`booking-broadcast.service.ts`, `booking-create.service.ts`, `booking-lifecycle.service.ts` …).
- **Cluster + horizontal scale** — `src/cluster.ts` forks N workers; multi-instance correctness via Redis adapter (Socket.IO), distributed locks, leader-election (`src/shared/services/leader-election.service.ts`), and `redisService.acquireLock`.
- **Event-driven backbone** — Socket.IO room emits + FCM dual-channel + BullMQ-style queues (`src/shared/services/queue.service.ts`) + outbox tables (`OrderDispatchOutbox`, `OrderLifecycleOutbox`, `VehicleTransitionOutbox`).
- **Finite state machines** — `src/core/state-machines.ts` (Booking, Order, Assignment, Vehicle), `src/modules/truck-hold/hold-state-machine.ts` (HoldPhase). Transitions are validated; FLEX→CONFIRMED uses Prisma `updateMany` CAS.
- **Idempotency baked in** — every mutation route reads `X-Idempotency-Key`. Helper at `src/shared/utils/idempotency.utils.ts`. Order creates use a DB row (`OrderIdempotency`) with `(customerId, idempotencyKey)` unique key (`src/modules/order/order-idempotency.service.ts`).
- **Single-process feature flag registry** — `src/shared/config/feature-flags.ts` (47k LOC). Boolean and numeric flags drive cutover/kill-switches across the whole system.
- **Circuit breakers + fail-open by default** — `src/shared/resilience/circuit-breaker.ts`, `src/shared/services/circuit-breaker.service.ts`. Used for socket fanout, external Maps, FCM.

## Entry Points

**`src/instrument.ts`** (17 lines)
- **What it bootstraps:** Sentry SDK (`@sentry/node`).
- **Order:** Loaded by `node -r src/instrument.ts` flag in production scripts (or imported first by Docker entrypoint at `scripts/docker-entrypoint.sh`). Strips `authorization` and `cookie` from outbound events.
- **Triggers:** SDK is `enabled: !!process.env.SENTRY_DSN`. No-op in dev unless DSN set.

**`src/instrumentation.ts`** (40 lines)
- **What it bootstraps:** OpenTelemetry NodeSDK with OTLP gRPC trace exporter, `ParentBasedSampler(TraceIdRatioBasedSampler(0.01))`. Auto-instruments Express, ioredis, http.
- **Order:** Activated only when `OTEL_ENABLED=true`. Runs `sdk.start()` on import; service name is fixed to `'weelo-backend'`.
- **Triggers:** Loaded with `--require src/instrumentation.ts` flag.

**`src/cluster.ts`** (243 lines) — **Production primary**
- **What it bootstraps:** `cluster.fork()` for N worker processes. Worker count resolved (in order) from: `WORKERS` env → `WEB_CONCURRENCY` env → `CONTAINER_CPU` (ECS CPU units / 1024) → cgroup v2 / v1 limit → containerized default (1) → `os.cpus().length`.
- **Order:** Primary forks workers, registers `cluster.on('exit')` with `MAX_RESTARTS=5` per `RESTART_WINDOW=60s` to prevent crash loops. Each worker `require('./server')`. SIGTERM/SIGINT → broadcast `'shutdown'` message and disconnect, 30s force-exit timer.
- **CLI:** `npm run start:cluster` (production). Dev runs `server.ts` directly (`npm run dev`).

**`src/server.ts`** (1426 lines) — **Per-worker HTTP/Socket bootstrap**
- **What it bootstraps:** Express app, Socket.IO server, all routers, middleware, background pollers, jobs.
- **Synchronous boot order (lines 117–593):**
  1. `validateAndLogEnvironment()` — `src/core/config/env.validation.ts:117` (fail-fast on missing/invalid env).
  2. Construct Express `app`.
  3. HTTPS or HTTP server creation (HTTPS if `SSL_KEY_PATH/SSL_CERT_PATH` exist + `config.isProduction`). TLS 1.2+ minimum, hardcoded cipher list (`server.ts:182`).
  4. `registerHoldExpiryProcessor()` — registers BullMQ-style processor for `hold-expiry` queue (`src/modules/hold-expiry/hold-expiry-cleanup.service.ts:539`).
  5. **FCM startup guard** (`server.ts:225`) — production must have `FIREBASE_SERVICE_ACCOUNT` (or path / triplet); throws otherwise.
  6. `fcmService.initialize()` — async, non-fatal.
  7. Middleware chain (lines 254–464):
     - `app.set('trust proxy', config.trustedProxyCidrs)` — CIDR list, not numeric hop count (F-A-08).
     - `edge_client_ip_source_total` metric.
     - `requestIdMiddleware` (`security.middleware.ts`).
     - `correlationMiddleware` — wraps each request in `AsyncLocalStorage` (`src/shared/context/correlation.ts:39`).
     - `compression` (gzip level 6, threshold 1KB).
     - `securityHeaders` (Helmet) + `securityResponseHeaders`.
     - `cors` — restrictive default in production if `CORS_ORIGIN` not set (`server.ts:304`).
     - `healthRoutes` (`/`) + `flagHealthRouter` + `/health/runtime` (admin-guarded) — **before rate limiter** so ALB probes never get throttled.
     - `rateLimiter` (`src/shared/middleware/rate-limiter.middleware.ts`) — **before** `express.json` so blocked IPs never allocate JSON heap (A01-005 invariant).
     - HSTS + `X-Content-Type-Options: nosniff` + `X-Frame-Options: DENY` + `Referrer-Policy`.
     - `express.json({ limit: '32kb' })` (tightened from 1MB).
     - `blockSuspiciousRequests` → `sanitizeInput` → `preventParamPollution` → `backwardCompatMiddleware` → `requestLogger` → `metricsMiddleware`.
  8. Mount routers under `/api/v1/<resource>` (lines 477–536). Full route table below.
  9. 404 handler + global `errorHandler` (`src/shared/middleware/error.middleware.ts`).
  10. **Boot-time invariant assertion** — confirms rate limiter is registered before JSON parser by walking `app._router.stack` (`server.ts:563–592`). Throws if invariant broken.
- **Async `bootstrap()` order (lines 733–1255):**
  1. `redisService.initialize()` — connect Redis (or fall back to in-memory).
  2. `assertRedisEvictionPolicy()` — halt if any policy other than `noeviction` (W0-3 / F-A-77, ElastiCache `NOPERM` is a soft-skip).
  3. **HTTP upgrade rate limiter** registered on `server.on('upgrade', …)` BEFORE `initializeSocket()` so destroyed sockets never reach Socket.IO (A04-001 / P5).
  4. `initializeSocket(server)` — Socket.IO + Redis Streams adapter (`src/shared/services/socket.service.ts:initializeSocket`).
  5. `holdReconciliationService.start()` (production only) — periodic 30s sweep.
  6. **Cache warming** (non-blocking): H3 geo index rebuild (if `FF_H3_INDEX_ENABLED`), live availability rebuild w/ distributed lock + 0–5s jitter, geo SET rebuild (`availabilityService.rebuildGeoFromDB`).
  7. **Background pollers started:**
     - `startBookingExpiryChecker()` — `src/modules/booking/booking.service.ts`.
     - `startStaleTransporterCleanup()` — `src/shared/services/transporter-online.service.ts`.
     - `trackingService.startDriverOfflineChecker()`.
     - Rating reminder poller (60s).
     - `smartTimeoutService.startExpiryChecker()` (15s).
     - `broadcastService.startExpiryChecker()` (5s).
     - `startVehicleTransitionOutboxPoller()` (10s).
     - `recoverOrphanedStepTimers()` — recovers progressive radius timer keys after restart (C-8 fix).
     - `startIdempotencyCleanupJob()` — batched deletes of `OrderIdempotency`/`OrderCancelIdempotency`.
     - `registerAuditRetentionSchedule()` — leader-locked prune of `StatusEvent` (90-day default, DPDP/GDPR).
     - DLQ drainer for `dlq:broadcasts` (30s, leader-elected).
  8. **F-B-03 prefix-overlap assertion** — fails fast if any two Redis namespace owners overlap (e.g. `fleetcache:*` vs `fleet:*`).
  9. `validateProductionConfig()` — JWT length ≥32 bytes, DB connection limit positive, Redis healthy, Redis version ≥7.4 (or 7.1+`USE_PEXPIRE_FALLBACK=true`). On any failure in production: `process.exit(1)`.
  10. `assertFcmUpgradeCampaignReadiness()` — DeviceToken.appVersionCode column required if `FF_FCM_UPGRADE_CAMPAIGN` enabled.
  11. `assertBroadcastDeclineTableExists()` — soft warn (V3-M06).
  12. `server.listen(PORT, '0.0.0.0')`. After listen: `server.timeout=30s`, `keepAliveTimeout=65s`, `headersTimeout=66s` (must satisfy: `headersTimeout > keepAliveTimeout > ALB idle 60s`).
  13. `startCleanupJob()` (cleanup-expired-orders) — every 2 min.
  14. `validateFeatureFlags()` — fail-fast on invalid flags in production.
- **Graceful shutdown (`server.ts:1291–1424`):** SIGTERM/SIGINT → `_isShuttingDown=true` (health probe returns 503) → stop all pollers → `queueService.stop()` → disconnect Socket.IO clients → `server.close()` → `redisService.shutdown()` → `prismaClient.$disconnect()`. Force exit after 25s (5s buffer before ECS SIGKILL at 30s).

## Mounted Route Table (`src/server.ts:477–536`)

All routes live under `API_PREFIX = '/api/v1'`.

| Mount Path | Module Router File |
|---|---|
| `/auth` | `src/modules/auth/auth.routes.ts` |
| `/driver-auth` | `src/modules/driver-auth/driver-auth.routes.ts` |
| `/profile` | `src/modules/profile/profile.routes.ts` |
| `/customer` | `src/modules/customer/customer.routes.ts` |
| `/vehicles` | `src/modules/vehicle/vehicle.routes.ts` |
| `/bookings` | `src/modules/booking/booking.routes.ts` (+ `booking-crud.routes.ts`, `booking-legacy.routes.ts` mounted internally) |
| `/assignments` | `src/modules/assignment/assignment.routes.ts` |
| `/trips` | `src/modules/trip/trip-pii.routes.ts` |
| `/tracking` | `src/modules/tracking/tracking.routes.ts` + `src/modules/tracking/pod.routes.ts` |
| `/pricing` | `src/modules/pricing/pricing.routes.ts` |
| `/driver` | `src/modules/driver/driver.routes.ts` (composes `driver-dashboard.routes.ts`, `driver-onboarding.routes.ts`, `driver-profile.routes.ts`, `regenerate-urls.route.ts`) |
| `/broadcasts` | `src/modules/broadcast/broadcast.routes.ts` |
| `/orders` | `src/modules/order/order.routes.ts` (legacy: `order-crud.routes.ts`, `order-lifecycle.routes.ts`, `order-progress.routes.ts`) |
| `/transporter` | `src/modules/transporter/transporter.routes.ts` (`transporter-dispatch.routes.ts` is an orphan stub) |
| `/notifications` | `src/modules/notification/notification.routes.ts` |
| `/truck-hold` | `src/modules/truck-hold/truck-hold.routes.ts` (`truck-hold-lifecycle.routes.ts` is an **orphan by design** — CI guard at `truck-hold/index.ts:46`) |
| `/custom-booking` | `src/modules/custom-booking/customBooking.routes.ts` |
| `/geocoding` | `src/modules/routing/geocoding.routes.ts` |
| `/rating` | `src/modules/rating/rating.routes.ts` |
| `/` (admin sub-routes mounted internally) | `src/modules/admin/admin.routes.ts` + `src/modules/admin/admin-tier.routes.ts` |
| `/health`, `/health/runtime`, `/__flags/*` | `src/shared/routes/health.routes.ts`, `src/shared/config/feature-flags.ts` |

## Module Layer Breakdown

Every module follows: **Routes (Express)** → **Service(s)** → **Prisma + Redis**. There is no separate Controller layer in newer modules; the legacy ones still have a thin `*.controller.ts` shim.

### `auth/` — User authentication (transporter + customer)
- **Route prefix:** `/api/v1/auth`
- **Routes:** `src/modules/auth/auth.routes.ts` — `POST /send-otp`, `POST /verify-otp`, `POST /refresh`, `POST /logout`, `GET /me`, `GET /debug-otp` (dev only).
- **Controller:** `src/modules/auth/auth.controller.ts` (3.4k LOC).
- **Services:** `src/modules/auth/auth.service.ts` (39k), `src/modules/auth/otp-challenge.service.ts`, `src/modules/auth/sms.service.ts` (Exotel-backed).
- **Validation:** `src/modules/auth/auth.schema.ts` (Zod).
- **Responsibilities:** OTP challenge issuance + verification, JWT access/refresh issuance, JTI blacklist (Redis), refresh token rotation with grace window.

### `driver-auth/` — Driver authentication (separate from auth)
- **Route prefix:** `/api/v1/driver-auth`
- **Routes:** `src/modules/driver-auth/driver-auth.routes.ts` — `POST /send-otp`, `POST /verify-otp`, `POST /logout`, `GET /debug-otp`.
- **Controller:** `src/modules/driver-auth/driver-auth.controller.ts`.
- **Services:** `src/modules/driver-auth/driver-auth.service.ts` (23k LOC).
- **Validation:** `src/modules/driver-auth/driver-auth.schema.ts`.
- **Responsibilities:** Driver OTP login flow, separate JWT subject keyed by driver ID; reuses Exotel SMS service.

### `profile/` — Profile CRUD across roles
- **Route prefix:** `/api/v1/profile`
- **Routes:** `src/modules/profile/profile.routes.ts`.
- **Service:** `src/modules/profile/profile.service.ts`.
- **Schema:** `src/modules/profile/profile.schema.ts`.
- **Responsibilities:** Customer/transporter/driver profile read + upsert; uploads to S3 via `src/shared/services/s3-upload.service.ts`.

### `customer/` — Customer-only endpoints
- **Route prefix:** `/api/v1/customer`
- **Routes:** `src/modules/customer/customer.routes.ts`.
- **Service:** `src/modules/customer/customer.service.ts`.
- **Responsibilities:** Wallet, trip history, settings.

### `vehicle/` — Truck/Vehicle registration & status
- **Route prefix:** `/api/v1/vehicles`
- **Routes:** `src/modules/vehicle/vehicle.routes.ts`. Documented endpoints: `GET /types`, `GET /pricing`, `GET /list`, `GET /available`, `GET /summary`, `GET /stats`, `GET /check/:vehicleNumber`, `POST /`, `PUT /upsert`, `GET /:vehicleId`, `PUT /:vehicleId`, `DELETE /:vehicleId`, `PUT /:vehicleId/status`, `PUT /:vehicleId/maintenance`, `PUT /:vehicleId/available`.
- **Controller:** `src/modules/vehicle/vehicle.controller.ts`.
- **Services:** `src/modules/vehicle/vehicle.service.ts` (29k), `src/modules/vehicle/vehicle-crud.service.ts`, `src/modules/vehicle/vehicle-status.service.ts`.
- **Schema:** `src/modules/vehicle/vehicle.schema.ts`.
- **Static catalog:** `src/modules/vehicle/vehicle.catalog.ts`.
- **Responsibilities:** Vehicle CRUD + status transitions (validated against `VEHICLE_VALID_TRANSITIONS` in `src/core/state-machines.ts:33`). Cache invalidation via `fleetCacheService` and `liveAvailabilityService`.

### `booking/` — Customer booking (single-vehicle path; **legacy**)
- **Route prefix:** `/api/v1/bookings`
- **Routes:** `src/modules/booking/booking.routes.ts` (47k LOC) facade composing `booking-crud.routes.ts` and `booking-legacy.routes.ts`. Documented endpoints: `POST /`, `GET /`, `GET /active`, `GET /:id`, `GET /:id/trucks`, `PATCH /:id/cancel`, plus order proxies under `/bookings/orders/*`.
- **Controller:** `src/modules/booking/booking.controller.ts` (legacy thin shim).
- **Services (split for size):** `src/modules/booking/booking.service.ts` (124k facade), `booking-create.service.ts` (40k), `booking-broadcast.service.ts` (26k), `booking-lifecycle.service.ts` (47k), `booking-radius.service.ts` (27k progressive expansion), `booking-rebroadcast.service.ts`, `booking-timer.service.ts`, `booking-query.service.ts`, `booking-payload.helper.ts`, `legacy-order-accept.service.ts`, `legacy-order-create.service.ts`, `legacy-order-expiry.service.ts`, `legacy-order-query.service.ts`, `legacy-order-timeout.service.ts`, `order.service.ts` (separate **legacy** order service inside the booking module — 43k).
- **Validation:** `src/modules/booking/booking.schema.ts`.
- **Shared context:** `src/modules/booking/booking-context.ts`.
- **Responsibilities:** Customer-facing booking creation, broadcast to nearby transporters via progressive radius expansion (10/15/20/25/30/40 km), expiry timers (Redis ZSET), legacy single-vehicle path.

### `order/` — Multi-truck Order System (**canonical path**)
- **Route prefix:** `/api/v1/orders`
- **Routes:** `src/modules/order/order.routes.ts` (46k). Documented endpoints (also exposed under `/bookings/orders/*` for legacy clients): `POST /` (create), `GET /:id`, `GET /active`, `POST /:orderId/cancel`, `GET /:orderId/cancel-preview`, `POST /:orderId/cancel/dispute`, `POST /:orderId/continue-partial`, `POST /:orderId/search-again`, `GET /:orderId/status`, `GET /:orderId/broadcast-snapshot`, `GET /requests/active`, `POST /requests/:id/accept`, `POST /accept`, `GET /pending-settlements`, `GET /check-active`, `GET /active`.
- **Services:** `src/modules/order/order.service.ts` (85k facade), `order-creation.service.ts` (42k), `order-accept.service.ts` (32k), `order-broadcast.service.ts` (53k), `order-broadcast-send.service.ts` (37k), `order-broadcast-query.service.ts`, `order-cancel.service.ts` (25k), `order-cancel-policy.service.ts`, `order-dispatch-outbox.service.ts` (20k), `order-lifecycle-outbox.service.ts` (52k), `order-delegates.service.ts`, `order-delegates-bridge.service.ts`, `order-idempotency.service.ts`, `order-query.service.ts`, `order-timer.service.ts` (Redis ZSET timers w/ orphan recovery), `order-types.ts`, `order-broadcast-helpers.ts`, `customer-progress-mirror.ts`, `progressive-radius-matcher.ts`, `order-id-cache.ts`.
- **Sub-routes:** `order-crud.routes.ts`, `order-lifecycle.routes.ts`, `order-progress.routes.ts`.
- **Contract:** `src/modules/order/order.contract.ts`.
- **Responsibilities:** Multi-vehicle order placement, broadcast fanout via progressive radius (`PROGRESSIVE_RADIUS_STEPS`), one-active-order-per-customer guard (`OrderIdempotency` + DB unique index), socket emits, FCM dual-channel, outbox-driven dispatch, per-truck request lifecycle.

### `truck-hold/` — Two-phase hold system (**Weelo differentiator**)
- **Route prefix:** `/api/v1/truck-hold`
- **Routes:** `src/modules/truck-hold/truck-hold.routes.ts` (44k). Active endpoints (lifecycle):
  - `POST /hold` — legacy single-phase hold (now creates FLEX hold via `truckHoldService.holdTrucks`).
  - `POST /confirm` — returns 410 `DEPRECATED`.
  - `POST /confirm-with-assignments` — confirm with vehicle/driver pairs.
  - `POST /release` — release a hold.
  - `GET /my-active` — transporter's active holds.
  - `GET /availability/:orderId` — per-order availability.
  - **Phase-1 (FLEX):** `POST /flex-hold`, `POST /flex-hold/extend`, `GET /flex-hold/:holdId`.
  - **Phase-2 (CONFIRMED):** `POST /confirmed-hold/initialize`, `GET /confirmed-hold/:holdId`.
  - **Driver decisions:** `PUT /driver/:assignmentId/accept`, `PUT /driver/:assignmentId/decline`.
  - **Smart timeout:** `POST /order-timeout/initialize`, `POST /order-timeout/extend`, `GET /order-timeout/:orderId`.
  - **Progress:** `GET /order-progress/:orderId`, `GET /order-assignments/:orderId`.
- **Services:** `src/modules/truck-hold/truck-hold.service.ts` (100k facade), `flex-hold.service.ts` (38k Phase 1), `confirmed-hold.service.ts` (86k Phase 2), `cascade-dispatch.service.ts` (driver decline → next driver in queue), `reassign-driver.service.ts`, `truck-hold-confirm.service.ts` (40k), `truck-hold-create.service.ts`, `truck-hold-cleanup.service.ts`, `truck-hold-query.service.ts`, `truck-hold-release.service.ts`, `truck-hold-store.service.ts`.
- **State machine:** `src/modules/truck-hold/hold-state-machine.ts` (FLEX → {CONFIRMED, EXPIRED, RELEASED}; CONFIRMED → {RELEASED, EXPIRED}; both terminal otherwise) with `guardedConfirmFlexToConfirmed(tx, holdId, patch)` performing atomic Prisma `updateMany` CAS.
- **Eligibility guard:** `src/modules/truck-hold/hold-eligibility.ts`.
- **Retry processor:** `src/modules/truck-hold/hold-finalize-retry.processor.ts`.
- **Lifecycle (orphan) router:** `src/modules/truck-hold/truck-hold-lifecycle.routes.ts` — explicitly marked `IS_ORPHAN_ROUTER = true`; CI test `src/__tests__/no-orphan-bootstraps.test.ts` enforces it stays unmounted.
- **Responsibilities:** Phase-1 90s base + extensions (max 130s), Phase-2 180s exclusive lock with 45s driver windows, atomic FLEX→CONFIRMED transition, cascade re-assignment on driver decline.

### `order-timeout/` — Smart timeout + progress tracking
- **Route prefix:** mounted under `/api/v1/truck-hold/order-timeout/*` and `/order-progress/*`.
- **Services:** `src/modules/order-timeout/smart-timeout.service.ts` (26k) — base 120s + 60s on first driver + 30s per subsequent + 120s no-progress cap; leader-elected polling (15s interval, 30s lease). `src/modules/order-timeout/progress.service.ts` — order progress aggregation + customer mirror.
- **Responsibilities:** Adaptive order-level timeout that honors driver progress; emits `order_progress_update` and `order_timeout_extended`.

### `assignment/` — Assignment lifecycle
- **Route prefix:** `/api/v1/assignments`
- **Routes:** `src/modules/assignment/assignment.routes.ts` (17k). Endpoints: `POST /`, `GET /`, `GET /driver`, `GET /driver/active`, `GET /:id`, `GET /:id/status`, `PATCH /:id/accept`, `PATCH /:id/decline`, `POST /:id/driver-cancel`, `PATCH /:id/status`, `PATCH /:id/transporter-override`, `DELETE /:id`.
- **Controller:** `src/modules/assignment/assignment.controller.ts`.
- **Services:** `src/modules/assignment/assignment.service.ts` (107k facade), `assignment-lifecycle.service.ts` (35k), `assignment-response.service.ts` (24k), `assignment-dispatch.service.ts` (13k), `assignment-query.service.ts`, `auto-redispatch.service.ts`, `completion-orchestrator.ts`, `post-accept.effects.ts` (10k — fan-out after accept).
- **Schema:** `src/modules/assignment/assignment.schema.ts`. **Types:** `assignment.types.ts`.
- **State machine:** `src/core/state-machines.ts:49` — `pending → driver_accepted → en_route_pickup → at_pickup → in_transit → arrived_at_drop → completed`. Cannot bypass `arrived_at_drop` (M-20). `partial_delivery` and `cancelled_by_driver` are terminal.
- **Responsibilities:** Driver accept/decline, transporter override, auto-redispatch on decline, status progression with `validateAssignmentTransition`, completion orchestration (release vehicle, settle fare, emit completion socket events).

### `broadcast/` — Driver-facing broadcast surface (legacy/single-vehicle path)
- **Route prefix:** `/api/v1/broadcasts`
- **Routes:** `src/modules/broadcast/broadcast.routes.ts`. Endpoints: `GET /active`, `GET /history`, `GET /:broadcastId`, `POST /:broadcastId/accept`, `POST /:broadcastId/decline`, `POST /create`.
- **Services:** `src/modules/broadcast/broadcast.service.ts` (50k), `broadcast-accept.service.ts` (41k), `broadcast-dispatch.service.ts`, `broadcast-query.service.ts`, `broadcast-dto.normalizer.ts`.
- **Schema:** `src/modules/broadcast/broadcast.schema.ts`.
- **Responsibilities:** Captain-app facing broadcast acceptance for booking-path bookings; idempotent accept with race winner determination.

### `driver/` — Driver dashboard, availability, presence
- **Route prefix:** `/api/v1/driver`
- **Routes:** `src/modules/driver/driver.routes.ts` (42k facade) + `driver-dashboard.routes.ts`, `driver-onboarding.routes.ts` (17k), `driver-profile.routes.ts`, `regenerate-urls.route.ts` (admin). Endpoints include `POST /onboard/initiate`, `POST /onboard/verify`, `POST /onboard/resend`, `POST /create`, `GET /list`, `GET /dashboard`, `GET /performance`, `PATCH /availability`, `GET /available`, `GET /online-drivers`, `GET /availability`, `GET /earnings`, `GET /trips`, `GET /trips/active`, `POST /complete-profile`, `GET /profile`, `PUT /profile/photo`, `PUT /profile/license`.
- **Services:** `src/modules/driver/driver.service.ts` (56k), `driver-presence.service.ts` (29k — Redis presence + heartbeat), `driver-management.service.ts`, `driver-performance.service.ts` (18k earnings), `presence-flap.detector.ts`.
- **Schema:** `src/modules/driver/driver.schema.ts`.
- **Responsibilities:** Driver onboarding (multi-step KYC), presence (online/offline/heartbeat) with Redis-backed status & flap detector, earnings, dashboard summary, license/photo upload (S3 presigned URLs).

### `driver-onboarding/` — KYC flow
- **Routes:** `src/modules/driver-onboarding/driver-onboarding.routes.ts`.
- **Service:** `src/modules/driver-onboarding/driver-onboarding.service.ts`.
- **Responsibilities:** Onboarding-specific endpoints separated from main driver router.

### `transporter/` — Transporter availability + dispatch
- **Route prefix:** `/api/v1/transporter`
- **Routes:** `src/modules/transporter/transporter.routes.ts` (46k monolith). Endpoints: `PUT /availability`, `GET /availability`, `POST /heartbeat` (×2 paths), `GET /availability/stats`, `GET /profile`, `PUT /profile`, `GET /stats`, `GET /dispatch/replay`. Two helper sub-files exist but are not mounted: `transporter-dispatch.routes.ts` (501 stub for tests), `transporter-profile.routes.ts`.
- **Service:** No standalone `transporter.service.ts` — handlers call `availabilityService`, `transporterOnlineService`, `prismaClient`, `redisService` directly.
- **Responsibilities:** Online toggle (idempotent + cooldown), per-vehicle-key heartbeat → Redis presence + geo:transporters sorted set, dispatch replay (Captain reconcile loop) — see Real-time Architecture below.

### `tracking/` — Live tracking + trip lifecycle + POD
- **Route prefix:** `/api/v1/tracking`
- **Routes:** `src/modules/tracking/tracking.routes.ts` + `pod.routes.ts`. Endpoints: `POST /update`, `GET /:tripId`, `GET /booking/:bookingId`, `GET /history/:tripId`, `GET /fleet`, `PUT /trip/:tripId/status`, `POST /batch`, `GET /status`, `PUT /status`, `GET /driver/:driverId/status`, `GET /active-trip`. POD: image upload + delivery confirmation.
- **Controller:** `src/modules/tracking/tracking.controller.ts`.
- **Services:** `src/modules/tracking/tracking.service.ts` (95k facade), `tracking-trip.service.ts` (39k), `tracking-location.service.ts` (21k), `tracking-fleet.service.ts` (24k), `tracking-history.service.ts` (11k), `tracking-query.service.ts`, `pod.service.ts` (proof of delivery).
- **Access policy:** `src/modules/tracking/tracking-access.policy.ts` — guards who can read tripId.
- **Schema:** `src/modules/tracking/tracking.schema.ts`. **Types:** `tracking.types.ts`.
- **Responsibilities:** Driver GPS update (single + batch), trip status transitions, fleet view (per-transporter list), location history, ETA computation, POD upload via S3.

### `trip/` — Trip-level PII reveal
- **Route prefix:** `/api/v1/trips`
- **Routes:** `src/modules/trip/trip-pii.routes.ts` — driver-only unmask endpoint (V11-NEW-10 / P5-8). Mounted alongside `/assignments` since `tripId == assignmentId` 1:1.

### `pricing/` — Fare estimation
- **Route prefix:** `/api/v1/pricing`
- **Routes:** `src/modules/pricing/pricing.routes.ts`.
- **Service:** `src/modules/pricing/pricing.service.ts` (21k). Vehicle catalog: `src/modules/pricing/vehicle-catalog.ts` (20k).
- **Schema:** `src/modules/pricing/pricing.schema.ts`.
- **Responsibilities:** Quote generation with Google Distance Matrix + per-vehicle pricing rules, deterministic quote token signing.

### `routing/` — Geocoding + Places + multi-stop routing
- **Route prefix:** `/api/v1/geocoding`
- **Routes:** `src/modules/routing/geocoding.routes.ts`.
- **Service:** `src/modules/routing/routing.service.ts` (17k).
- **Schemas:** `routing.schema.ts`, `route-multi.schema.ts`.

### `notification/` — FCM token registration + preferences
- **Route prefix:** `/api/v1/notifications`
- **Routes:** `src/modules/notification/notification.routes.ts`. Endpoints: `POST /register-token`, `DELETE /unregister-token`, `GET /preferences`, `PUT /preferences`, `POST /preferences`. **No service file** — handlers operate directly on `prismaClient` (`DeviceToken` table).

### `rating/` — Customer ratings
- **Route prefix:** `/api/v1/rating`
- **Routes:** `src/modules/rating/rating.routes.ts`.
- **Services:** `src/modules/rating/rating.service.ts` (15k), `rating-reminder.service.ts`.
- **Schema:** `src/modules/rating/rating.schema.ts`.

### `custom-booking/` — Long-term contracts
- **Route prefix:** `/api/v1/custom-booking`
- **Routes:** `src/modules/custom-booking/customBooking.routes.ts`.
- **Service:** `src/modules/custom-booking/customBooking.service.ts`.
- **Schema:** `src/modules/custom-booking/customBooking.schema.ts`.

### `hold-expiry/` — Hold lifecycle reconciliation
- **No HTTP route prefix** — internal services only.
- **Services:** `src/modules/hold-expiry/hold-expiry-cleanup.service.ts` (18k — registers `hold-expiry` queue processor + 60s legacy reconciler), `hold-reconciliation.service.ts` (11k — Layer-2 production-only periodic 30s scan).
- **Responsibilities:** Defense-in-depth for orphaned holds; reconciles `TruckHoldLedger` against vehicles.

### `admin/` — Admin endpoints
- **Routes:** `src/modules/admin/admin.routes.ts`, `admin-tier.routes.ts`. Endpoints include user suspend/warn/unsuspend, dispatch outbox redrive, dispute resolve, order rebroadcast.
- **Controller:** `src/modules/admin/admin.controller.ts`.
- **Service:** `src/modules/admin/admin-suspension.service.ts`.

### `user/` — User self-service
- **Route prefix:** Mounted internally (legacy).
- **Files:** `user.routes.ts`, `user.controller.ts`, `user.service.ts`, `user.schema.ts`.

## Cross-cutting Concerns (`src/shared/`)

### `src/shared/middleware/` — Express middleware
| File | Purpose |
|---|---|
| `auth.middleware.ts` (12k) | `authMiddleware` (verifies JWT, populates `req.user`), `roleGuard(['role'])`. |
| `backward-compat.middleware.ts` | Rewrites legacy Captain paths (`/trips/*`, `/tracking/trips/*`) to canonical routes (BRK-2/BRK-4). |
| `error.middleware.ts` | Global `errorHandler`, `asyncHandler`, `notFoundHandler`. Sanitises 5xx details. RFC 6585 `Retry-After` for 429. |
| `rate-limiter.middleware.ts` (33k) | Layered rate limit (auth/OTP/global), CIDR-aware key derivation, `ipUpgradeTokenBucket`. |
| `request-logger.middleware.ts` | Per-request structured log line. |
| `security.middleware.ts` | `requestIdMiddleware`, Helmet `securityHeaders`, `securityResponseHeaders`, `sanitizeInput`, `preventParamPollution`, `blockSuspiciousRequests`. |
| `transporter-rate-limit.middleware.ts` | Per-action rate limit (e.g. `transporterRateLimit('holdTrucks')`). |

### `src/shared/monitoring/` — Metrics + assertions
| File | Purpose |
|---|---|
| `metrics.service.ts` (32k) | Singleton `metrics` (Prom-style), `metricsMiddleware`, `incrementCounter/setGauge/observeHistogram` (auto-registers metrics on first use). |
| `metrics-definitions.ts` (60k) | Single-source-of-truth registry of counters/gauges/histograms. |
| `observability-only-metrics.ts` | Read-only monitoring counters. |
| `redis-eviction-assertion.ts` | `assertRedisEvictionPolicy` — halts boot on non-`noeviction` policies. |
| `broadcast-decline-table-assertion.ts` | Schema preflight for `BroadcastDecline`. |

### `src/shared/resilience/` — Circuit breakers + queues
- `circuit-breaker.ts` (11k) — generic CB primitive (CLOSED/OPEN/HALF-OPEN with rolling window). Used inside socket emit + external API services (`socketCircuit` is a singleton in `circuit-breaker.service.ts`).
- `request-queue.ts` (9k) — bounded request queue (used as `bookingQueue` priority middleware in `order.routes.ts`).

### `src/shared/errors/` — Error catalog
- `error-catalog.ts` — registry of error codes for typed responses.

### `src/shared/routes/` — Health checks
- `health.routes.ts` (17k) — `/`, `/health`, `/health/live`, `/health/ready`, `/health/deep` (DB/Redis/Socket adapter); honors shutdown flag.

### `src/shared/services/` — 40+ singletons (the heart of the codebase)
| Service | File | Purpose |
|---|---|---|
| Logger | `logger.service.ts` | Pino-style structured logger. |
| Redis (facade) | `redis.service.ts` (110k) | All Redis ops; auto-fallback to in-memory in dev. Singleton: `redisService`. |
| Redis (impl) | `redis/in-memory-redis.client.ts`, `redis/real-redis.client.ts`, `redis/redis.types.ts` | Backend implementations. |
| Redis cluster scan | `redis-cluster-scan.ts` | Cluster-safe SCAN (legacy `redisService.keys()` was non-cluster-safe). |
| Redis coordination | `redis-coordination.service.ts` | Distributed locks helpers. |
| Cache | `cache.service.ts` (18k) | Typed cache primitives. |
| Socket.IO | `socket.service.ts` (130k) | All real-time. Singleton: `socketService` + helpers `emitToUser`, `emitToUsers`, `emitToTrip`, `getIO`, `initializeSocket`. |
| Queue (bus) | `queue.service.ts` (119k) | InMemory + Redis-backed queues, processors, DLQ, backpressure (`queue-backlog-gate.ts`). |
| Notification outbox | `notification-outbox.service.ts` (23k) | Persists outgoing socket+FCM events for replay. |
| FCM | `fcm.service.ts` (73k), `fcm-data-coerce.ts`, `fcm-upgrade-campaign.ts`, `fcm-version-gate.ts` | Firebase Admin SDK wrapper, retry, batch. |
| Availability | `availability.service.ts` (40k), `availability-cache.service.ts`, `availability-geo.service.ts`, `availability-types.ts` | Online transporter set + GEO sorted sets per vehicle key. |
| Live availability | `live-availability.service.ts` (16k) | Counter of available trucks per (transporter, vehicleKey) for matching; rebuilt from DB at boot + 5-min reconcile. |
| H3 geo index | `h3-geo-index.service.ts` (19k) | Uber H3 hex-cell index for transporter lookup. |
| Fleet cache | `fleet-cache.service.ts`, `fleet-cache-read.service.ts`, `fleet-cache-write.service.ts`, `fleet-cache-types.ts` | Per-transporter fleet cache under `fleetcache:*` prefix. |
| Distance Matrix | `distance-matrix.service.ts` (16k) | Google Distance Matrix wrapper + circuit breaker. |
| Directions | `directions-api.service.ts` (15k) | Google Directions wrapper. |
| Maps | `google-maps.service.ts` (25k) | Geocoding + places. |
| Candidate scorer | `candidate-scorer.service.ts` (16k) | Ranks transporters by composite score. |
| Vehicle key | `vehicle-key.service.ts` | `generateVehicleKey(type, subtype)` + candidates. |
| Vehicle lifecycle | `vehicle-lifecycle.service.ts` | `releaseVehicle()` + status sync to DB+Redis+caches. |
| Vehicle transition outbox | `vehicle-transition-outbox.service.ts` (13k) | F-A-64 outbox poller for vehicle status flips. |
| Transporter online | `transporter-online.service.ts` (18k) | Heartbeat + presence TTL + stale cleanup. |
| Tracking stream | `tracking-stream-sink.ts` | Redis Streams sink for telemetry. |
| Audit | `audit.service.ts`, `audit.schema.ts`, `audit-sanitizer.ts` | Audit log writer. |
| Leader election | `leader-election.service.ts` | `acquireLeader(key, holder, ttl)` for singleton background tasks. |
| Rate limit | `rate-limit.service.ts` | Token bucket primitives backing rate-limiter middleware. |
| S3 upload | `s3-upload.service.ts` | Presigned URL + multipart helpers. |
| Exotel SMS | `exotel.service.ts` | OTP delivery. |

### `src/shared/queue-processors/` — Per-queue processors
| File | Queue Name | Purpose |
|---|---|---|
| `broadcast.processor.ts` | `broadcast` | Fan out socket emits per transporter, with dead-order guard. |
| `push-notification.processor.ts` | `push` | Single-target FCM push. |
| `fcm-batch.processor.ts` | `fcm_batch` | Batched FCM (≤500 drivers). |
| `tracking-events.processor.ts` | `tracking-events` | Driver telemetry stream fanout (Redis Streams sink). |
| `vehicle-release.processor.ts` | `vehicle-release` | Retry queue for failed vehicle releases. |
| `assignment-reconciliation.processor.ts` | `assignment-reconciliation` | Periodic orphaned assignment cleanup. |
| `assignment-timeout-poller.ts` | (poller, not BullMQ) | Polls assignment timeouts. |
| `audit-retention.ts` | (scheduler) | Leader-locked prune of `StatusEvent` (90-day default). |
| `index.ts` | — | Barrel exporting all `register*Processor` functions. |

### `src/shared/jobs/` — Cron-style background jobs
| File | Schedule | Purpose |
|---|---|---|
| `cleanup-expired-orders.job.ts` | Every 2 min | Distributed-locked batch deletion of expired orders. |
| `cleanup-order-idempotency.job.ts` | Hourly | Prune `OrderIdempotency` and `OrderCancelIdempotency`. |
| `cleanup-status-events.job.ts` | Daily | Status event retention. |
| `trip-sla-monitor.job.ts` | Every 30 min | 3-tier SLA on long-running trips (12h/18h/24h). |

### `src/shared/database/` — Persistence
| File | Purpose |
|---|---|
| `prisma.service.ts` (86k) | `prismaClient`, `prismaReadClient`, `withDbTimeout`, `PrismaDatabaseService`. Re-exports `UserRole, VehicleStatus, BookingStatus, OrderStatus, TruckRequestStatus, AssignmentStatus, HoldPhase, TimeoutExtensionType` from `@prisma/client`. |
| `prisma-client.ts` | Pure client construction (separates from service to avoid circular deps). |
| `db.ts` | Legacy `db` facade — type re-exports + Prisma-only initialization (JSON DB removed). |
| `read-router.ts` | Read replica routing helper. |
| `record-helpers.ts` | Record-shape helpers. |
| `record-types.ts` | Record interfaces for cross-service typing. |
| `repository.interface.ts` (12k) | Repository abstraction. |
| `repositories/` | `assignment.repository.ts`, `booking.repository.ts`, `order.repository.ts`, `stats.repository.ts`, `tracking.repository.ts`, `truck-request.repository.ts`, `user.repository.ts`, `vehicle.repository.ts`. |

### `src/shared/context/` — AsyncLocalStorage
- `correlation.ts` — `correlationMiddleware`, `getCorrelationId()`, `withCorrelation(prefix, fn)` for background jobs.

### `src/shared/config/` — Feature flags + presence
- `feature-flags.ts` (47k) — registry, validation, `isEnabled(FLAGS.X)`, `getNumericFlag(NUMERIC_FLAGS.X)`, `validateFeatureFlags()`, `flagHealthRouter`.
- `presence.config.ts` — heartbeat/TTL constants.

### `src/shared/utils/`
| File | Purpose |
|---|---|
| `idempotency.utils.ts` | `readOrGenerateIdempotencyKey(req)` — reads `X-Idempotency-Key` or HMAC-signs server-generated key. |
| `signing-secret.ts` | `getIdempotencySigningSecret()` — fail-fast in production. |
| `pii.utils.ts` | `maskPhoneForLog`, `maskPhoneForExternal`, `maskName`. |
| `canonical-hash.ts` | Deterministic JSON hashing. |
| `crypto.utils.ts` | HMAC + AES helpers. |
| `validation.utils.ts` | Zod helpers + boundary validators. |
| `geo.utils.ts`, `geospatial.utils.ts` | Haversine, bounding box. |
| `net.utils.ts` | `getClientIpChain`, `isInCidrList`. |
| `safe-json.utils.ts` | Defensive JSON parse. |
| `retry.ts` | Exponential backoff helper. |
| `error.utils.ts` | Error normalization. |
| `truncate.ts` | String truncation. |
| `response-builders.ts` | Standardized response shapes. |
| `broadcast-payload.normalizer.ts`, `broadcast-snapshot.builder.ts` | Booking-broadcast shape canonicalization. |
| `order-lifecycle.utils.ts` | Order lifecycle helpers. |

### `src/shared/types/`
- `api.types.ts`, `authenticated-request.ts`, `error.types.ts` (`AppError` canonical), `express.d.ts` (Express type augmentation), `queue-payloads.ts`, `socket-events.ts`.

## Core Layer (`src/core/`)

| Subdir | Purpose |
|---|---|
| `core/config/env.validation.ts` | `validateAndLogEnvironment()` — declarative env spec with `required`, `default`, `validator`. Fails fast on missing/invalid. |
| `core/config/hold-config.ts` | Hold-system constants (`flexHoldDurationSeconds`, `confirmedHoldMaxSeconds`, `driverAcceptTimeoutSeconds`, `vehicleMutexTtlSeconds`) + `BROADCAST_DEDUP_TTL_BUFFER_SECONDS`. Single source of truth — services MUST import from here. |
| `core/constants/index.ts` | `ErrorCode` enum, `HTTP_STATUS` map, shared status enums. |
| `core/errors/AppError.ts` | Re-exports `AppError` from `shared/types/error.types.ts` and defines `BadRequestError`, `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `RateLimitError`, `InternalError`, `ServiceUnavailableError`, plus domain-specific `BookingNotFoundError`, `VehicleNotAvailableError`, etc. |
| `core/responses/ApiResponse.ts` | `ApiResponse.success/created/noContent/paginated/list/ok/download/stream` + `parsePagination`, `buildPaginationMeta`. |
| `core/state-machines.ts` | Booking, Order, Vehicle, Assignment FSMs + `validateAssignmentTransition`, `assertValidTransition`, `isValidTransition`, `TERMINAL_BOOKING_STATUSES`, `TERMINAL_ORDER_STATUSES`, `TERMINAL_ASSIGNMENT_STATUSES`. |
| `core/index.ts` | Barrel: re-exports constants, errors, responses, env validation. |

## Data Flow Walkthroughs

### Flow 1: Two-phase Truck Hold (the differentiator)

**Phase 1 — Create FLEX hold:**
1. Captain app → `POST /api/v1/truck-hold/flex-hold` (`src/modules/truck-hold/truck-hold.routes.ts:562`).
2. Route handler reads `X-Idempotency-Key` via `readOrGenerateIdempotencyKey(req)` (`shared/utils/idempotency.utils.ts:75`), validates body with `flexHoldCreateSchema` (in `truck-hold-lifecycle.routes.ts`), passes `transporterRateLimit('flexHold')`.
3. `flexHoldService.createFlexHold(request)` (`src/modules/truck-hold/flex-hold.service.ts`):
   - `validateActorEligibility(transporterId)` (`hold-eligibility.ts`) → throws `HoldEligibilityError` on suspension/KYC fail.
   - Acquires per-vehicle Redis mutex via `redisService.acquireLock('vehicle:mutex:{vehicleId}', holderUuid, HOLD_CONFIG.vehicleMutexTtlSeconds)`.
   - Inside `prismaClient.$transaction`: `withDbTimeout`-wrapped `truckHoldLedger.create({ phase: 'FLEX', status: 'active', baseExpiresAt = now+90s, currentExpiresAt = now+90s, transporterId, orderId, vehicleType, ... })`.
   - Writes `flex:hold:{holdId}` to Redis with TTL = 90s.
   - Schedules `hold-expiry` BullMQ delayed job (`queueService.scheduleAssignmentTimeout` analog) — registered processor lives at `src/modules/hold-expiry/hold-expiry-cleanup.service.ts:539`.
   - Emits `flex_hold_started` to `transporter:{transporterId}` room (`emitToUser(transporterId, SocketEvent.FLEX_HOLD_STARTED, payload)`).
4. Response: `{ holdId, baseExpiresAt, currentExpiresAt, extendedCount: 0, canExtend: true, totalDurationSeconds, remainingSeconds }`.

**Extend:**
5. Captain app → `POST /api/v1/truck-hold/flex-hold/extend` with `{ holdId, additionalDriverIds }`.
6. `flexHoldService.extendFlexHold` validates `extendedCount < maxExtensions=2` and `currentExpiresAt + 30s ≤ baseExpiresAt + maxDurationSeconds(130s)`.
7. Atomic `truckHoldLedger.updateMany({ where: { holdId, phase: 'FLEX', status: 'active' }, data: { currentExpiresAt, extendedCount: {increment: 1}, candidateDriverIds: {push: ...} } })` — CAS-guarded; loser sees `count=0` and surfaces `409 HOLD_NOT_EXTENDABLE`.
8. Reschedules `hold-expiry` queue entry with new TTL. Emits `flex_hold_extended`.

**Phase 2 — Initialize CONFIRMED:**
9. Captain app → `POST /api/v1/truck-hold/confirmed-hold/initialize` with `{ holdId, winners: [{ truckRequestId, vehicleId, driverId }, ...] }`.
10. `confirmedHoldService.initializeConfirmedHold` (`src/modules/truck-hold/confirmed-hold.service.ts`):
    - Inside `withDbTimeout(prismaClient.$transaction(...))`:
      - `guardedConfirmFlexToConfirmed(tx, holdId, { confirmedExpiresAt = now+180s })` (`hold-state-machine.ts:138`) — Prisma `updateMany` with `WHERE phase='FLEX' AND status='active'`. Concurrent callers resolve to exactly ONE `{ updated: true }`; loser gets `{ updated: false, rowsAffected: 0 }` and the route returns `409 HOLD_NOT_FLEX`.
      - For each winner: `tx.assignment.create({ status: 'pending', expiresAt = now+45s, ... })`.
      - For each non-winner candidate (`candidateDriverIds − winners`): emit `flex_hold_superseded` socket event.
      - `tx.vehicle.updateMany({ where: { id, status: 'available' }, data: { status: 'on_hold' } })` per winner — atomic preconditioned update.
    - Schedules per-assignment 45s timeout via `queueService.scheduleAssignmentTimeout({ assignmentId, fireAt = now+45s })`.
    - Emits `trip_assigned` to each winning driver via `buildTripAssignedDriverNotification` (P6-E single source of truth — same payload used by Socket.IO + FCM data field).
    - Customer mirror: `buildCustomerProgressMirrorPayload` → `customer:{customerId}` room (`order_progress_update`).
11. Response: `{ confirmedExpiresAt, assignments: [{ assignmentId, driverId, expiresAt }, ...] }`.

**Driver decision:**
12. Captain (driver app) → `PUT /api/v1/truck-hold/driver/:assignmentId/accept`.
13. `confirmedHoldService.acceptByDriver(assignmentId, driverId)`:
    - `tx.assignment.updateMany({ where: { id: assignmentId, status: 'pending', expiresAt: { gt: now } }, data: { status: 'driver_accepted', acceptedAt: now } })` — CAS race-winner. Loser sees `count=0` → `409 ACCEPT_TOO_LATE`.
    - `tx.vehicle.update({ status: 'in_transit' })` (state-machine validated via `VEHICLE_VALID_TRANSITIONS`).
    - Releases vehicle mutex.
    - `liveAvailabilityService.decrementAvailable(transporterId, vehicleKey)` — Redis counter sync.
    - `fleetCacheService.invalidateFleet(transporterId)` — cache flush.
    - Emits `driver_accepted` to `transporter:{transporterId}` and `customer:{customerId}`.
    - If all winners accepted: emits `truck_confirmed` and triggers `progressTrackingService.maybeAdvanceOrder()`.
14. Decline path: `PUT /driver/:assignmentId/decline` → `cascade-dispatch.service.ts` picks next driver in `candidateDriverIds`, creates new assignment, emits `cascade_reassigned`.

**Timeout path:**
- 45s queued job fires → assignment-timeout poller → `cascade-dispatch.service.ts.handleAssignmentTimeout()` → cascade or expire whole hold to `RELEASED`.
- 180s confirmed-hold expiry → `hold-expiry` queue processor (`hold-expiry-cleanup.service.ts:registerHoldExpiryProcessor`) → mark `phase='EXPIRED', status='expired'`, release vehicles, emit `hold_expired`.

### Flow 2: Booking Creation (legacy customer single-vehicle path)

1. Customer app → `POST /api/v1/bookings` (`src/modules/booking/booking.routes.ts:102`).
2. Route reads idempotency key, validates with `createBookingSchema` (`booking.schema.ts`), enters `bookingQueue.middleware({ priority: HIGH, timeout: 15000 })` (request queue from `shared/resilience/request-queue.ts`).
3. `bookingService.createBooking(request)` orchestrates via the split-file context:
   - `bookingCreateService.create(ctx)` → DB row in `booking` table with `status='created'`.
   - `bookingBroadcastService.broadcastBookingToTransporters(ctx)` (`booking-broadcast.service.ts:49`):
     - `assertValidTransition('Booking', BOOKING_VALID_TRANSITIONS, 'created', 'broadcasting')`.
     - Builds `candidateMap` (transporterId → distanceKm/etaSeconds) from `step1Candidates`.
     - `queueService.queueBroadcastBatch` enqueues per-transporter jobs to `broadcast` queue (BullMQ-style). Backpressure cap `BROADCAST_QUEUE_DEPTH_CAP` enforced (F-PERF-02).
     - Falls back / runs in parallel: `socketService.emitToUsers(transporterIds, SocketEvent.NEW_BROADCAST, payload)`.
     - Dual-channel: `fcmService.sendBatch(deviceTokens, ...)` (FCM batched, ≤500 per call).
   - `bookingTimerService.setupBookingTimeout(bookingId)` writes `timer:booking:{bookingId}` ZSET entry for `BOOKING_CONFIG.TIMEOUT_MS = 120s`. The 5s `bookingExpiryChecker` poller at `booking.service.ts:startBookingExpiryChecker` reads and expires.
   - `bookingRadiusService.startProgressiveExpansion(...)` schedules step expansions over 10/15/20/25/30/40 km windows.
4. Captain app receives `new_broadcast` socket event in real time (room `transporter:{transporterId}`) AND/OR FCM data push if disconnected.
5. Acceptance: Captain → `POST /api/v1/broadcasts/:broadcastId/accept` → `broadcastAcceptService.accept(broadcastId, transporterId)` → CAS `truckRequest.updateMany({ status: 'pending' → 'accepted' })`. Winner gets 200 + assignment IDs; losers get 409 `ALREADY_ACCEPTED`.

### Flow 3: Driver Accept (assignment lifecycle)

1. Captain (driver) → `PATCH /api/v1/assignments/:id/accept` (`src/modules/assignment/assignment.routes.ts:342`).
2. `assignmentLifecycleService.accept(assignmentId, driverId)` (`src/modules/assignment/assignment-lifecycle.service.ts`):
   - `validateAssignmentTransition(currentStatus, 'driver_accepted')` (state-machine guard).
   - Inside `prismaClient.$transaction`:
     - `tx.assignment.updateMany({ where: { id: assignmentId, status: 'pending', expiresAt: { gt: now } }, data: { status: 'driver_accepted', driverId, acceptedAt: now } })` — CAS.
     - On `count=0`: throw `409 ACCEPT_TOO_LATE`.
     - Vehicle transition: `tx.vehicle.updateMany({ where: { id: vehicleId, status: 'available' }, data: { status: 'in_transit' } })`. ESLint rule `cas-vehicle-update-must-check-count.js` enforces caller checks `count`.
     - Booking/order rollup: increment `acceptedTrucks`, transition booking status if applicable.
3. `postAcceptEffects.run(...)` (`assignment/post-accept.effects.ts`):
   - `liveAvailabilityService.decrementAvailable(transporterId, vehicleKey)`.
   - `fleetCacheService.invalidateFleet(transporterId)`.
   - `availabilityService.removeFromGeo(transporterId, vehicleKey)` (driver no longer matchable).
   - Emit `assignment_status_changed`, `driver_accepted` socket events.
   - `notificationOutboxService.persist(...)` — durable outbox row for replay.
4. Customer receives `customer:{customerId}` → `truck_request_accepted`, with masked driver name and ETA.

## Real-time Architecture (Socket.IO)

**Single namespace** — there is no `io.of('/foo')` usage. All clients connect to root `/`.

**Adapter:** `@socket.io/redis-streams-adapter` (`createAdapter` at `socket.service.ts:34`). On managed Redis without psubscribe (e.g. ElastiCache Serverless), falls back to no-adapter mode + warning (recovery handled in `unhandledRejection` guard `server.ts:1275`).

**Auth:**
- `io.use(authMiddleware)` at `socket.service.ts:354` verifies JWT (`HS256`), checks JTI blacklist (`blacklist:{jti}`), rejects role-spoof (`socket.handshake.auth.role !== decoded.role`), populates `socket.data.{userId, role, phone, transporterId}` and `userRoleCache`.
- Global cap: `SOCKET_MAX_GLOBAL_CONNECTIONS=10000` enforced before auth (`socket.service.ts:344`).
- Per-user cap: `MAX_CONNECTIONS_PER_USER` enforced via Redis counter `socket:conncount:{userId}` (cross-instance).

**Room strategy:**
| Room | Joined By | Used For |
|---|---|---|
| `user:{userId}` | All authenticated sockets | Per-user direct emit. |
| `role:{role}` | All authenticated sockets | Role-broadcast. |
| `transporter:{transporterId}` | Transporters + their drivers | Broadcast events to a transporter and their drivers. |
| `driver:{userId}` | Drivers | Per-driver targeted events. |
| `customer:{userId}` | Customers | Per-customer events (progress mirror). |
| `booking:{bookingId}` | Customer + assigned transporter/driver | Booking lifecycle + tracking. |
| `order:{orderId}` | Customer + assigned transporter/driver | Multi-truck order events. |
| `trip:{tripId}` | Customer + assigned driver/transporter | Live tracking. |

Auto-join on connect (`socket.service.ts:494–586`):
- `user:{userId}`, `role:{role}` always.
- Role-specific room (`transporter:`, `driver:`, `customer:`).
- For drivers, also `transporter:{their.transporterId}`.
- Active assignments in `('pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit', 'arrived_at_drop')` → auto-join `booking:` and `order:` rooms (DB lookup wrapped in `withSocketDbLimit` to bound DB pool usage during mass reconnect).
- Active bookings/orders for customers → auto-join.
- Trip rooms via active tracking lookup.

**Client-driven room joins:** `JOIN_BOOKING`, `LEAVE_BOOKING`, `JOIN_ORDER`, `LEAVE_ORDER`, `JOIN_TRIP`, `JOIN_TRANSPORTER` — each performs DB ownership/access check before `socket.join`.

**Reconnect / replay:**
- `GET /api/v1/transporter/dispatch/replay?cursor=<msEpoch>&limit=50` (`transporter.routes.ts:1042`) — Captain reconcile loop. Returns events from `cursor → now` (default last 30 min), filtered by transporter's vehicle types and 150 km pickup radius from cached transporter location. Rate limited to 1 call / 3s per transporter. Returns `{ cursor, snapshotRequired, hasMore, events: [...] }`.
- `socket:unacked:{userId}:{role}` ZSET — durable per-user/role envelope queue (Arch 1B). On reconnect, server replays unacked envelopes. `dispatch_ack` event removes by `assignmentId+source+renderedAt`.
- Cross-instance fanout: Redis Streams adapter pubsub. `userRoleCache` populated at handshake so `durableEmit` composes role-scoped key without DB hit.

**Wire vocabulary:** Single source of truth at `packages/contracts/events.generated.ts` (auto-generated from `events.asyncapi.yaml`, regenerated via `node packages/contracts/codegen.mjs`). Re-exported by `socket.service.ts:194`. 79 socket event names (+ 1 legacy alias `BROADCAST_CANCELLED → order_cancelled`).

## Background Work

### BullMQ-style queues (`src/shared/services/queue.service.ts`)

`QueueService` (singleton `queueService`) auto-selects `RedisQueue` in production with `REDIS_QUEUE_ENABLED !== 'false' && REDIS_ENABLED === 'true'`, otherwise `InMemoryQueue` (`queue.service.ts:1430`).

Queue names (`QueueService.QUEUES`, `queue.service.ts:1405`):

| Constant | Wire Name | Purpose |
|---|---|---|
| `BROADCAST` | `broadcast` | Per-transporter broadcast emits. |
| `PUSH_NOTIFICATION` | `push` | Single-target FCM. |
| `FCM_BATCH` | `fcm_batch` | Batched FCM (≤500 per call). |
| `TRACKING_EVENTS` | `tracking-events` | Driver telemetry → Redis Streams sink. |
| `EMAIL` | `email` | Future. |
| `SMS` | `sms` | Future. |
| `ANALYTICS` | `analytics` | Analytics. |
| `CLEANUP` | `cleanup` | Generic cleanup tasks. |
| `CUSTOM_BOOKING` | `custom-booking` | Long-term contract events. |
| `ASSIGNMENT_RECONCILIATION` | `assignment-reconciliation` | Periodic orphan cleanup. |
| `HOLD_EXPIRY` | `hold-expiry` | Phase-1/2 hold expiry. |
| `VEHICLE_RELEASE` | `vehicle-release` | Retry queue for failed vehicle releases (default 5 attempts). |

Additional in-tree processors:
- `hold-finalize-retry.processor.ts` registers a queue (`QUEUE_NAME` constant inside the file) for retrying confirmed-hold finalization on transient errors.

DLQ: `DLQ_MAX_SIZE=5000` (`DLQ_MAX_SIZE` env override). `dlq:broadcasts` drained by leader-elected drainer registered in `bootstrap()` at 30s cadence (`scripts/replay-broadcast-dlq.ts`).

Backpressure: `assertDepthUnderCap`, `applyBackpressurePolicy` (`queue-backlog-gate.ts`). Per-batch broadcast cap = `BROADCAST_QUEUE_DEPTH_CAP` (default 50,000) with priority-ordered partial admit. Tracking queue hard limit = `TRACKING_QUEUE_HARD_LIMIT=200000`.

### Cron-style background jobs

| Job | Interval | File |
|---|---|---|
| Booking expiry checker | 5s | `src/modules/booking/booking.service.ts:startBookingExpiryChecker` |
| Smart-timeout expiry | 15s, leader-elected | `src/modules/order-timeout/smart-timeout.service.ts:startExpiryChecker` |
| Broadcast expiry | 5s | `src/modules/broadcast/broadcast.service.ts:startExpiryChecker` |
| Vehicle transition outbox poller | 10s | `src/shared/services/vehicle-transition-outbox.service.ts:startVehicleTransitionOutboxPoller` |
| Stale transporter cleanup | 30s | `src/shared/services/transporter-online.service.ts:startStaleTransporterCleanup` |
| Driver offline checker | (configured) | `src/modules/tracking/tracking.service.ts:startDriverOfflineChecker` |
| Hold reconciliation worker (Layer 2) | 30s, production-only | `src/modules/hold-expiry/hold-reconciliation.service.ts:start` |
| Hold cleanup reconciler (legacy) | 60s, locked | `src/modules/truck-hold/truck-hold.service.ts:startCleanupJob` |
| Live availability reconcile | 5 min | `src/shared/services/live-availability.service.ts:reconcile` |
| Geo prune | 5 min | `src/shared/services/availability.service.ts:pruneStaleGeoEntries` |
| Cleanup expired orders | 2 min | `src/shared/jobs/cleanup-expired-orders.job.ts` |
| Cleanup order idempotency | hourly | `src/shared/jobs/cleanup-order-idempotency.job.ts` |
| Cleanup status events | daily | `src/shared/jobs/cleanup-status-events.job.ts` |
| Trip SLA monitor | 30 min | `src/shared/jobs/trip-sla-monitor.job.ts` |
| Audit retention prune | (scheduler) | `src/shared/queue-processors/audit-retention.ts` |
| Rating reminder poll | 60s | `src/modules/rating/rating-reminder.service.ts:processExpiredRatingReminders` |
| DLQ broadcast drainer | 30s, leader-elected | `scripts/replay-broadcast-dlq.ts:drain` |

## State Machines

### `src/core/state-machines.ts`

**Booking (`BOOKING_VALID_TRANSITIONS`):**
```
created → broadcasting | cancelled | expired
broadcasting → active | cancelled | expired
active → partially_filled | fully_filled | cancelled | expired
partially_filled → active | fully_filled | cancelled | expired
fully_filled → in_progress | cancelled
in_progress → completed | cancelled
completed | cancelled | expired → terminal
```

**Order (`ORDER_VALID_TRANSITIONS`):** Same shape as Booking.

**Vehicle (`VEHICLE_VALID_TRANSITIONS`):**
```
available → on_hold | in_transit | maintenance | inactive
on_hold → in_transit | available
in_transit → available | maintenance
maintenance → available | inactive
inactive → available | maintenance
```
**M-20 enforcement:** Note the absence of direct `available → completed`. CLAUDE.md highlights that vehicle status and assignment status must NEVER be conflated.

**Assignment (`ASSIGNMENT_VALID_TRANSITIONS`, `src/core/state-machines.ts:49`):**
```
pending → driver_accepted | driver_declined | cancelled
driver_accepted → en_route_pickup | cancelled | cancelled_by_driver  (C6)
en_route_pickup → at_pickup | cancelled
at_pickup → in_transit | cancelled
in_transit → arrived_at_drop | cancelled  (M-20: NO direct → completed)
arrived_at_drop → completed | partial_delivery | cancelled
completed | partial_delivery | driver_declined | cancelled | cancelled_by_driver → terminal
```

### `src/modules/truck-hold/hold-state-machine.ts`

**HoldPhase (Prisma enum FLEX/CONFIRMED/EXPIRED/RELEASED + UNKNOWN sentinel for wire decoding):**
```
FLEX → CONFIRMED | EXPIRED | RELEASED
CONFIRMED → RELEASED | EXPIRED
EXPIRED | RELEASED → terminal
```
- Pure guard: `assertHoldPhaseTransition(from, to)` throws `HoldTransitionError`.
- Atomic write: `guardedConfirmFlexToConfirmed(tx, holdId, patch)` performs CAS via Prisma `updateMany` with `WHERE phase='FLEX' AND status='active'`. Concurrent callers → exactly one `{ updated: true }`.
- Migration M-009 (`migrations/M-009-hold-phase-backfill.sql`) is irreversible; runs only after `FF_HOLD_GUARDED_TRANSITIONS=ON` + 1-release soak.

**Wire-decode helpers (`packages/contracts/enums.generated.ts`):** `HoldPhase_fromBackendString`, `VehicleStatus_fromBackendString`, `BookingStatus_fromBackendString`, `AssignmentStatus_fromBackendString`. All return the `'UNKNOWN'` sentinel on schema drift.

## Caching Strategy

**Three Redis namespaces with strict prefix ownership** (boot-time `F-B-03 prefix-overlap assertion` at `server.ts:1115`):

| Prefix | Owner | Purpose |
|---|---|---|
| `online:transporters` (SET) | `availability.service.ts` (`REDIS_KEYS.ONLINE_TRANSPORTERS`) | All currently online transporter IDs. |
| `transporter:presence:{id}` | `transporter-online.service.ts:TRANSPORTER_PRESENCE_KEY` | Presence key with TTL (heartbeat refreshes). 60s TTL default. |
| `transporter:details:{id}` (HASH) | `availability.service.ts` | Transporter location + vehicle keys list. |
| `geo:transporters:{vehicleKey}` (ZSET / GEO) | `availability.service.ts:REDIS_KEYS.GEO_TRANSPORTERS` | Geospatial sorted set per `vehicleKey`. Used by `availabilityService.findNearestTransporters`. |
| `live:availability:*` | `live-availability.service.ts` | Counter of available trucks per (transporter, vehicleKey) for matching gate. Rebuilt from DB at boot + 5-min reconcile. |
| `fleetcache:vehicles:{transporterId}` etc. | `fleet-cache.service.ts` | Per-transporter vehicle/driver list cache. **All keys go through `JSON.stringify`/`JSON.parse` — see CONCERNS.md re: known corruption bug.** |
| `fleet:{transporterId}`, `fleet:index:transporters` | `tracking.service.ts` (hardcoded — pending `registeredPrefixes` contract) | Tracking-fleet view. |
| `idempotency:truck-hold:{scope}:{subject}:{key}` | `truck-hold.routes.ts` | 240s success TTL, 60s failure TTL, 30s server-generated TTL. |
| `timer:booking:{bookingId}`, `timer:countdown:{bookingId}`, `timer:radius:{bookingId}` | `booking.types.ts:TIMER_KEYS` | Booking-path Redis ZSET timers. |
| `broadcast:radius:step:{bookingId}`, `broadcast:notified:{bookingId}` | `booking.types.ts:RADIUS_KEYS` | Progressive radius tracking. |
| `dlq:broadcasts` | `queue.service.ts` | Dead-letter queue for failed broadcast jobs. |
| `socket:conncount:{userId}` | `socket.service.ts` | Per-user connection counter (60s TTL). |
| `socket:unacked:{userId}:{role}` (ZSET) | `socket.service.ts` (Arch 1B) | Durable per-role unacked envelope queue. |
| `lock:*`, `hold:cleanup:unified`, `rebuild:live-availability`, `smart-timeout-leader`, `trip-sla-monitor` | `redisService.acquireLock` | Distributed locks / leader election. |
| `blacklist:{jti}` | `auth.service.ts` | JWT revocation. |
| `ratelimit:dispatch-replay:{transporterId}`, `ratelimit:*` | `rate-limiter.middleware.ts` | Layered rate limit. |

## Idempotency / Dedupe

**Header convention:** All mutation endpoints accept `X-Idempotency-Key` (clients must send a UUIDv4). Server may auto-generate via HMAC-signed key when missing.

**Helper:** `src/shared/utils/idempotency.utils.ts:readOrGenerateIdempotencyKey(req)` returns `{ key, source: 'client' | 'server-generated' }`. Server-generated keys use `getIdempotencySigningSecret()` → `IDEMPOTENCY_SIGNING_SECRET` env (fail-fast in production).

**Storage:**
- **Redis (truck-hold path):** `idempotency:truck-hold:{scope}:{subject}:{key}` with discriminated TTLs (240s success, 60s failure, 30s server-generated). Helpers `idempotencyCacheKey` + `tryReplayCached` (`truck-hold.routes.ts:65-100`).
- **Database (orders):** `OrderIdempotency` table with `(customerId, idempotencyKey)` unique key (`src/modules/order/order-idempotency.service.ts`). Stores `payloadHash` for IETF idempotency-key draft §2 compliance. Reusing a key with a different payload throws `409 IDEMPOTENCY_CONFLICT`.
- **Booking dedupe:** `flex_hold` partial index `M-015-flex-hold-dedup-partial-index.sql` + canonical hash via `canonical-hash.ts`.

**Broadcast dedupe:** Each broadcast event includes `eventId` (UUID) + `eventVersion`. `withEventMeta` helper. Dedup TTL = `BROADCAST_TIMEOUT_MS/1000 + BROADCAST_DEDUP_TTL_BUFFER_SECONDS=180` (`hold-config.ts:36`).

**Socket replay dedupe:** Per-envelope sequence numbers + `dispatch_ack` from clients drain the unacked ZSET.

---

*Architecture analysis: 2026-05-04*
