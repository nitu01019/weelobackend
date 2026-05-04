# External Integrations

**Analysis Date:** 2026-05-04
**Project:** weelo-unified-backend v2.0.0
**Repo root:** `/Users/nitishbhardwaj/Downloads/weelo-backend`

## Database — PostgreSQL via Prisma

**ORM:** Prisma 5.22.0. Schema `prisma/schema.prisma` (currently EMPTY in working tree — 0 bytes; canonical 1468-line schema in git HEAD `git show HEAD:prisma/schema.prisma`).

**Connection:**
- `src/shared/database/prisma.service.ts:292-316` — `getPrismaClient()` builds the pooled `DATABASE_URL` with `connection_limit=${DB_CONNECTION_LIMIT}` (default 25) + `pool_timeout=${DB_POOL_TIMEOUT}` (default 5s) + `connect_timeout=5` + `socket_timeout=10`.
- Singleton export: `prismaClient` (line 2083), `prismaReadClient` (line 2007 — used when read-replica URL set).
- Read router: `src/shared/database/read-router.ts` — `readOrFallback()` chooses replica vs primary.
- Compatibility shim: `src/shared/database/prisma-client.ts:50-67` re-exports the same singleton (was a duplicate pool, now consolidated).
- Database wrapper with stats: `src/shared/database/db.ts` (`db.getStats()` — used in `/health/runtime`).

**Generator targets:** `binaryTargets = ["native", "linux-musl", "linux-musl-openssl-3.0.x", "linux-musl-arm64-openssl-3.0.x", "linux-arm64-openssl-3.0.x", "debian-openssl-3.0.x"]` (Alpine + Debian + ARM64).

**Prisma middleware (`$use`):** registered at `prisma.service.ts:326-414`:
1. **Slow query logger** — warns when query duration > `SLOW_QUERY_THRESHOLD_MS` (default 200ms).
2. **Pool wait observer** — observes `pool_wait_seconds` histogram (proxy for connection starvation).
3. **Cache invalidation middleware** — auto-invalidates `user:profile:{id}` and `cache:vehicles:transporter:{id}` Redis keys on Prisma write ops. Note: `$use` middleware does NOT fire inside `$transaction()` — manual cache invalidation needed in transactions.

**Models in `prisma/schema.prisma` (canonical from git HEAD):**

| Model | Purpose |
|-------|---------|
| `User` | Customers, transporters, drivers (separated by `role` enum). Phone+role unique. KYC FSM + legacy `isVerified`. |
| `Vehicle` | Trucks owned by transporters; status `available\|on_hold\|in_transit\|maintenance\|inactive`. |
| `Booking` | Legacy single-truck booking flow (status `created\|broadcasting\|active\|partially_filled\|fully_filled\|in_progress\|completed\|cancelled\|expired`). |
| `Order` | Multi-truck orders with route points + dispatch observability + idempotency key. |
| `OrderIdempotency` | Customer+key → orderId+responseJson cache. |
| `OrderDispatchOutbox` | Durable broadcast replay (`status\|attempts\|nextRetryAt`). |
| `OrderLifecycleOutbox` | Durable cancel/expire fanout replay. |
| `OrderCancelIdempotency` | Cancel-op duplicate-safe retries. |
| `CancellationLedger` | Policy stage + penalty/compensation audit. |
| `CustomerPenaltyDue`, `DriverCompensationLedger` | Deferred settlement. |
| `CancellationAbuseCounter` | Per-customer churn tracking. |
| `CancelDispute` | Blocked-stage cancel escalations. |
| `TruckHoldLedger` | Two-phase hold state (FLEX/CONFIRMED/EXPIRED/RELEASED) with `flexExpiresAt`, `confirmedExpiresAt`, `confirmedAtLegacy`. |
| `TruckHoldIdempotency` | Hold/release duplicate-safe retries. |
| `ProgressEvent` | Smart-timeout extension audit (per-driver `+30s added`). |
| `OrderTimeout` | Smart timeout tracking with extensions. |
| `TransporterBroadcastView` | Per-transporter remaining-trucks view. |
| `TruckRequest` | Individual truck within a multi-truck order. |
| `Assignment` | Order/booking → transporter → vehicle → driver link. Trip-level. Partial unique index `assignment_driver_active_unique`. |
| `Tracking` | Real-time GPS state per trip. |
| `Wallet` | Customer wallet (INR balance). |
| `CustomerSettings` | Per-user prefs (notifications, theme, language, vehicle filter). |
| `CustomBookingRequest` | Long-term contract requests (separate from instant orders). |
| `Rating` | Customer→driver star rating per assignment. Denormalized to `Assignment.customerRating` + `User.avgRating`/`totalRatings`. |
| `DeviceToken` | FCM token DB fallback (Redis primary). Has `revokedAt` soft-delete + partial active index. |
| `TripRoutePoint` | GPS history persisted on trip completion. |

**Enums in schema:** `UserRole`, `VehicleStatus`, `BookingStatus`, `OrderStatus`, `TruckRequestStatus`, `AssignmentStatus`, `RoutePointType`, `HoldPhase`, `TimeoutExtensionType`, `KycStatus`, `CustomBookingStatus`. Mirrored at `packages/contracts/enums.generated.ts`.

**Tables created via direct SQL (NOT in Prisma schema):** `OtpStore` (created in `scripts/docker-entrypoint.sh`), `_MigrationFlags` (entrypoint-tracked one-time migrations), `BroadcastDecline` (analytics — boot WARN if missing), `_prisma_migrations` (production state — see CLAUDE.md: it does NOT exist in production).

**Migrations:**

`prisma/migrations/` (Prisma-tracked):
- `20260219_add_broadcast_lifecycle_states/`
- `20260225_add_truckrequest_notified_transporters_gin_index/`
- `20260228_phase2_reliability_core/`
- `20260228_phase4_hold_reliability/`
- `20260228_phase5_cancel_reliability/`
- `20260321_hold_phase_system/`
- `20260329_add_on_hold_status_and_vehicle_index/`
- `add_indexes.sql` (unfoldered)
- `phase6-indexes.sql` (unfoldered)

`prisma/manual-migrations/`: `phase-p1-sc1-sc2-indexes.sql` (one file, manually run via psql).

`migrations/` (root-level direct-SQL ops manuals):
- `M-001` through `M-017` covering: orders active expiry index, customer active-order/active-booking unique, vehicle transition outbox + fence seq, hold phase backfill, device-token fields, trip route points, assignment decline + partial-delivery + superseded, truckholdledger.confirmedAtLegacy, flex-hold dedup partial index, truck-hold-ledger active-find index.
- `phase3-f-a-02-order-unique.sql` (Order idempotencyKey unique)
- `phase3-f-b-75-kyc.sql` (KYC FSM)

**CRITICAL DB rules (from CLAUDE.md):**
- Production DB has NO `_prisma_migrations` table — it was set up via legacy `prisma db push`, not `migrate deploy`.
- **NEVER** run `prisma migrate deploy` or `prisma db push` against production — both will fail or corrupt schema.
- All schema changes MUST be applied via direct SQL (psql) using `ADD COLUMN IF NOT EXISTS`, `DO $$ BEGIN…EXCEPTION…END $$`, and explicit `BEGIN`/`COMMIT`.
- The `scripts/docker-entrypoint.sh` baseline-then-deploy logic (`prisma migrate resolve --applied` for 7 known migrations, then `prisma migrate deploy`) **conflicts with this rule** — running it against the current production DB would fail because there's no `_prisma_migrations` table to resolve into.
- `Prisma cannot express partial-predicate indexes` — several `@@index` declarations in `schema.prisma` are placeholders; the actual `WHERE` clauses are added via direct SQL (e.g., `assignment_driver_active_unique`, `truck_hold_ledger_active_find_idx`, `DeviceToken_userId_lastSeenAt_active_idx`). `prisma db pull` would silently rewrite these as full indexes.

**Connection pool sizing** (`prisma.service.ts:276-287`):
- `DB_CONNECTION_LIMIT` (default 25) — max DB connections per ECS task.
- Staging budget on db.t4g.micro: 2 tasks × 25 = 50 (within ~80 available).
- Production target on db.r6g.large: 4 tasks × 125 = 500 of ~1600 max_connections (31% utilization). Production MUST set `DB_CONNECTION_LIMIT=125`.
- `DB_POOL_TIMEOUT` (default 5s) — fail fast for user-facing APIs.

**PgBouncer (optional intermediate):** `docker/pgbouncer/pgbouncer.ini`:
- Mode `transaction`, `default_pool_size=25`, `max_client_conn=10000`.
- `ignore_startup_parameters = extra_float_digits` for Prisma compat.
- Available but not visibly wired into the production ECS deploy in the current configs.

## Redis

**Client:** `ioredis` 5.9.2 (production), `redis` 4.6.12 (some legacy paths). Wrapper service: `src/shared/services/redis.service.ts` (3175 lines).

**Connection:**
- Init at boot: `redisService.initialize()` called inside `bootstrap()` (`src/server.ts:738`) — server doesn't accept HTTP traffic until Redis is ready.
- URL: `REDIS_URL` (production required, no localhost fallback per `env.validation.ts:608-611`).
- Reconnect grace period: 60s on reconnect, suppresses stale-transporter cleanup so heartbeats can repopulate (`src/server.ts:744-753`).
- Eviction policy assertion: boot dies if Redis isn't `noeviction` (`src/server.ts:773-794`).
- Redis version assertion: >= 7.4 required, or 7.1 + `USE_PEXPIRE_FALLBACK=true` (`src/server.ts:677-707`).
- Cluster scan helper: `src/shared/services/redis-cluster-scan.ts` — `clusterScanAllFlat(pattern)` walks all cluster nodes for `SCAN`.
- Distributed coordination: `src/shared/services/redis-coordination.service.ts`.
- Lua-backed atomic ops: `redisService.eval(script, keys, args)` and `redisService.sAddWithExpire(key, ttl, ...members)` (LINE Engineering atomic SADD+EXPIRE pattern).

**Redis is used for (8 distinct subsystems):**

1. **Cache layer** — `src/shared/services/cache.service.ts`, `redis-cache.service.ts`, `fleet-cache.service.ts` (`fleetcache:*` — vehicles + drivers + per-vehicle/driver detail), `availability-cache.service.ts`. TTLs: 5min vehicle/driver lists, 10min single records, 1hr places search.
2. **Queue layer** — `src/shared/services/queue.service.ts` `RedisQueue` class. Lists per priority (`queue:{name}:{critical|high|normal|low}`), processing list (`processing-list:{name}`), processing hash (`processing:{name}`), delayed sorted set (`delayed:{name}`), DLQ list (`dlq:{name}` — 7-day TTL, 5000-entry cap).
3. **Presence / online tracking** — `src/shared/services/transporter-online.service.ts`. Keys: `transporter:presence:{id}` (TTL with heartbeat refresh, default 60s), `online:transporters` SET, `transporter:vehicle:{id}`, `transporter:vehicle:keys:{id}`. Driver presence: `driver:location:{driverId}` JSON.
4. **Geospatial index** — `geo:transporters:{vehicleKey}` sorted sets (GEOADD/GEORADIUS). H3 secondary index when `FF_H3_INDEX_ENABLED=true` (via `src/shared/services/h3-geo-index.service.ts`).
5. **Distributed locks** — `acquireLock(key, holderId, ttlSec)`. Standard prefix `lock:*`. Examples: `lock:cleanup-expired-orders` (25s), `lock:cleanup-status-events` (120s), `rebuild:live-availability` (60s), `lock:hold:cleanup:unified`, `lock:trip-sla-monitor` (120s), `lock:rate-limit:{key}`, vehicle mutex keys `lock:vehicle:{vehicleKey}` (30s — `VEHICLE_MUTEX_TTL_SECONDS`).
6. **Rate limiting** — `src/shared/middleware/rate-limiter.middleware.ts`. `RedisRateLimitStore` implementing `express-rate-limit`'s Store interface. Token-bucket for socket upgrade: `ipUpgradeTokenBucket` (in-process `RateLimiterMemory` per `/24` + UA + lang fingerprint). Atomic INCR + EXPIRE.
7. **OTP storage** — `otp:{phone}:{role}` keys with `OTP_EXPIRY_MINUTES` TTL. Plus `OtpStore` table fallback when Redis unavailable.
8. **Pub/sub** — Socket.IO redis-streams adapter (and legacy redis-adapter for pub/sub fanout). Stream keys: `socket:stream:{partition}` (16 partitions tracked via `socket_stream_partition_depth_N` gauges).

Plus:
- **Idempotency cache** — `idempotency:{customerId}:{key}` (post-commit cache write, fail-soft).
- **Sequence delivery / unacked queue** (when `FF_SEQUENCE_DELIVERY_ENABLED`): `socket:unacked:{userId}:{role}` ZSET, 600s TTL (`UNACKED_QUEUE_TTL_SECONDS`).
- **Connection counter** — `socket:conncount:{userId}` (max 5 concurrent connections per user, 300s TTL).
- **Cross-pod room membership** (when `FF_CROSS_POD_ROOM_REPLAY=true`): `room:members:booking:{id}`, `room:members:order:{id}`, `room:members:trip:{id}` SETs, 24h TTL.
- **JWT blacklist** — `blacklist:{jti}` keys for token revocation.
- **Hold deduplication** — `hold:dedup:{transporterId}:{orderId}:{vehicleType}` keys.
- **FCM token storage** — `fcm:tokens:{userId}` SET (90-day TTL — see FCM section).
- **Broadcast queue guard cache** — `order:status:{orderId}` (1.5s TTL, `CANCELLED_ORDER_QUEUE_GUARD_CACHE_TTL_MS=1500`).
- **Timer keys** — `timer:booking:*`, `timer:order:*`, `timer:assignment:*` (sorted set `timers:pending`).

**Key namespace ownership (F-B-03 boot assertion enforces non-overlap):**
- `fleetcache:*` — owned by `fleetCacheService`
- `fleet:*` — owned by `trackingService`
- `geo:*`, `transporter:*`, `online:*` — owned by `transporter-online.service.ts` + `availability.service.ts`
- `queue:*`, `processing:*`, `processing-list:*`, `delayed:*`, `dlq:*` — owned by `queue.service.ts`
- `lock:*` — distributed locks (any caller)
- `cache:*` — generic caches (`cache.service.ts`)
- `socket:*`, `room:*` — Socket.IO state
- `fcm:*`, `otp:*`, `blacklist:*` — auth/notification
- Boot dies if any owner's prefix is a strict prefix of another's (`src/server.ts:1115-1151`).

## Queue System (Hand-rolled, BullMQ-style)

**No `bullmq` package is installed.** The queue layer is a hand-rolled implementation in `src/shared/services/queue.service.ts` (2808 lines).

**Two implementations behind `IQueue` interface (`queue.service.ts:1369-1378`):**
- `InMemoryQueue` (line 178) — dev/test mode, single-process.
- `RedisQueue` (line 470) — production, multi-pod via Redis lists + sorted sets.

**Auto-selection** (`queue.service.ts:1420-1446`): Production + `REDIS_ENABLED=true` + `REDIS_QUEUE_ENABLED!=false` → `RedisQueue`; otherwise `InMemoryQueue`. Override: `REDIS_QUEUE_ENABLED=false` to force in-memory even in prod.

### Queues defined (`queue.service.ts:1405-1418`)

| Queue Name | Constant | Processor location | Worker count |
|------------|----------|---------------------|--------------|
| `broadcast` | `QUEUES.BROADCAST` | `queue.service.ts:1457` (registered via `queue.process()`); pure processor at `src/shared/queue-processors/broadcast.processor.ts` | `REDIS_QUEUE_WORKERS` (16) |
| `push` | `QUEUES.PUSH_NOTIFICATION` | `queue.service.ts:1731`; pure processor at `src/shared/queue-processors/push-notification.processor.ts` | 16 |
| `fcm_batch` | `QUEUES.FCM_BATCH` | `queue.service.ts:1749`; `src/shared/queue-processors/fcm-batch.processor.ts` | 16 |
| `tracking-events` | `QUEUES.TRACKING_EVENTS` | `queue.service.ts:1827`; `src/shared/queue-processors/tracking-events.processor.ts` | `REDIS_QUEUE_TRACKING_WORKERS` (48) |
| `vehicle-release` | `QUEUES.VEHICLE_RELEASE` | `queue.service.ts:1835`; `src/shared/queue-processors/vehicle-release.processor.ts` | 16 (5 max attempts vs default 3) |
| `assignment-reconciliation` | `QUEUES.ASSIGNMENT_RECONCILIATION` | `queue.service.ts:1857`; `src/shared/queue-processors/assignment-reconciliation.processor.ts` | 16 |
| `hold-expiry` | `QUEUES.HOLD_EXPIRY` | `src/modules/hold-expiry/hold-expiry-cleanup.service.ts:66,538` (`registerHoldExpiryProcessor()` called in `server.ts:218`) | 16 |
| `email` | `QUEUES.EMAIL` | (placeholder — no processor) | — |
| `sms` | `QUEUES.SMS` | (placeholder — no processor) | — |
| `analytics` | `QUEUES.ANALYTICS` | (placeholder — no processor) | — |
| `cleanup` | `QUEUES.CLEANUP` | (placeholder — no processor) | — |
| `custom-booking` | `QUEUES.CUSTOM_BOOKING` | (placeholder — no processor) | — |

Plus dynamically-registered queues:
- `booking:resume-broadcast` — registered via `queueService.registerProcessor('booking:resume-broadcast', ...)` at `src/modules/booking/booking-lifecycle.service.ts:984` (lifecycle resume on rebroadcast).

### Queue features

- **Priority lists per queue** (`queue.service.ts:489-498`): each queue has 4 sub-lists `:critical`, `:high`, `:normal`, `:low`. Workers drain CRITICAL first. Priority constants from `MessagePriority` (1-4); event-to-priority map at `EVENT_PRIORITY` (`queue.service.ts:131-143`).
- **Delayed jobs** via Redis sorted sets (`delayed:{name}`, ZADD score=processAfter). A poller moves them to the main list when ready (`queue.service.ts:485,657-662`).
- **At-least-once delivery** via processing hash (`processing:{name}`) and BLMOVE-based processing list (`processing-list:{name}`, `STALE_PROCESSING_THRESHOLD_MS=5min`). On crash, stale jobs are re-enqueued at startup (`queue.service.ts:790`).
- **Reaper** — `REAPER_INTERVAL_MS=30s`, `REAPER_MAX_AGE_MS=60s`, `REAPER_PROCESSING_CAP=10000` (`queue.service.ts:505-508`).
- **DLQ** — `dlq:{name}` Redis list, 5000-entry cap (`DLQ_MAX_SIZE`, env `DLQ_MAX_SIZE`), 7-day TTL.
- **Backpressure policy** (`src/shared/services/queue-backlog-gate.ts`) — discriminated-union policy:
  - `silent_drop` — non-critical queues (broadcast, tracking-events) — emits `queue_enqueue_rejected_total`/`queue_backlog_cap_dropped_total`.
  - `fail_loud` — correctness-critical queues (hold-expiry, vehicle-release, assignment-reconciliation) — throws `QueueBackpressureError` so caller surfaces 5xx.
- **Per-batch depth cap** (F-PERF-02, default OFF): `BROADCAST_QUEUE_DEPTH_CAP=5000` + `FF_BATCH_QUEUE_DEPTH_GUARD` flag — sorts batch by priority, admits up to cap, sends overflow to DLQ.
- **TTL enforcement** (default ON, `FF_MESSAGE_TTL_ENABLED`): per-event-type TTL map at `MESSAGE_TTL_MS` (`queue.service.ts:108-117`) drops stale messages. E.g., `new_broadcast=90s`, `accept_confirmation=60s`, `order_cancelled=300s`, `trucks_remaining_update=30s`.
- **Cancelled-order guard** (`FF_CANCELLED_ORDER_QUEUE_GUARD`, default ON): broadcast processor checks order status before emitting; drops `new_broadcast`/`new_truck_request` for cancelled/expired/completed/fully_filled orders. Fail-closed by default; fail-open via `FF_CANCELLED_ORDER_QUEUE_GUARD_FAIL_OPEN=true`.

### DLQ drainer

`scripts/replay-broadcast-dlq.ts` — leader-elected DLQ drainer for `dlq:broadcasts`. Replays via `queueBroadcastBatch` with `bypassDepthGuard`. Registered in `server.ts:1088-1106` with 30s interval (when `FF_DLQ_DRAINER_ENABLED!=false`).

### Tracking stream sink (Kinesis)

`src/shared/services/tracking-stream-sink.ts` — async fanout to AWS Kinesis when `TRACKING_STREAM_ENABLED=true`. Created at queue-service init (`queue.service.ts:1387`). Provider: `none` or `kinesis`. Batch size: `TRACKING_STREAM_BATCH_SIZE=100`, flush: `TRACKING_STREAM_FLUSH_MS=250`, retries: `TRACKING_STREAM_MAX_RETRIES=3`. Stream name: `TRACKING_KINESIS_STREAM`. Hard queue limit: `TRACKING_QUEUE_HARD_LIMIT=200000`. Metrics: `tracking_stream_publish_success_total`, `tracking_stream_publish_fail_total`, `tracking_stream_dropped_total`, `tracking_stream_retry_total`, `tracking_queue_dropped_total`.

## Socket.IO

**Server init:** `src/shared/services/socket.service.ts:285` (`initializeSocket(server)`). Called from `server.ts:895` after Redis init.

**Configuration:**
- `pingTimeout=20000ms`, `pingInterval=15000ms` (env `SOCKET_PING_TIMEOUT_MS`/`SOCKET_PING_INTERVAL_MS`; tuned for 2G/3G India). Builder at `buildSocketServerOptions()` (line 214).
- `transports: ['websocket']`, `allowUpgrades: false` (no polling — direct WS only).
- `maxHttpBufferSize: 10MB`.
- `connectionStateRecovery.maxDisconnectionDuration: 2 * 60 * 1000` (2-minute reconnection window).
- Per-message deflate, threshold 1KB, 16KB chunks, no context takeover.
- Global connection cap: `SOCKET_MAX_GLOBAL_CONNECTIONS=10000` (rejects new connections at capacity).
- Per-user connection cap: `MAX_CONNECTIONS_PER_USER=5` (Redis-tracked at `socket:conncount:{userId}`).
- Max events/sec/socket: 30 (`MAX_EVENTS_PER_SECOND`, `checkRateLimit`).
- HTTP upgrade pre-filter: in-process token bucket (`ipUpgradeTokenBucket` in `rate-limiter.middleware.ts`) keyed by `/24` CIDR + UA + lang fingerprint. Bypass via `x-internal-health: HEALTH_SECRET` or `ALB_CIDR_ALLOW`. Registered at `server.ts:827-882`.

**Adapters (`socket.service.ts:34`):**
- Primary: `@socket.io/redis-streams-adapter` (16 partitions tracked via `socket_stream_partition_depth_N` gauges, alarmed > 80k entries).
- Fallback: `@socket.io/redis-adapter` for pub/sub.
- Adapter status mode: `enabled | disabled | disabled_by_config | disabled_by_capability | failed`. When down, emits route into notification-outbox (durable fallback).
- ManagedRedis pub/sub probe: `REDIS_PUBSUB_DISABLED=true` to disable when provider lacks pub/sub.
- Gauge `redis_adapter_state_gauge`, counter `socket_emit_while_adapter_down_total`, `socket_emit_buffered_adapter_down_total`.

**Auth middleware (`io.use`):**
- JWT verification (`HS256`, `config.jwt.secret`) — line 354.
- JTI blacklist check (`blacklist:{jti}` Redis key) — fail-open if Redis down.
- Role-spoofing rejection: if client claims a role differing from JWT — line 394.
- Caches `userId`, `role`, `phone` on `socket.data`. Driver lookup adds `transporterId`.

**Rooms strategy (auto-join on connect, `socket.service.ts:494-603`):**
- Personal room: `user:{userId}` + `role:{role}`.
- Role-specific: `transporter:{userId}`, `driver:{userId}` (also joins `transporter:{transporterId}` if assigned), `customer:{userId}`.
- Active resource rooms: scans active `Assignment`s (max 10 per user) for `bookingId`, `orderId`, `tripId` and joins `booking:*`, `order:*`, `trip:*` rooms. Customers also auto-join trip rooms (max 20).
- DB ops are gated by `SOCKET_DB_CONCURRENCY=10` (semaphore) to prevent pool exhaustion during mass reconnect.
- Cross-pod replay (`FF_CROSS_POD_ROOM_REPLAY=true`): SADD to `room:members:booking:{id}` with 24h TTL, sRem on disconnect.

**Event catalog (canonical registry):** `packages/contracts/events.generated.ts` — auto-generated from `packages/contracts/events.asyncapi.yaml`. 79 socket events + 1 legacy alias.

**Server → client events (selected, full list in `events.generated.ts`):**
- Lifecycle: `connected`, `error`, `heartbeat`, `server_time_sync`
- Booking/Order: `booking_updated`, `booking_completed`, `booking_cancelled`, `booking_expired`, `booking_fully_filled`, `booking_partially_filled`, `order_status_update`, `order_cancelled`, `order_expired`, `order_completed`, `order_progress_update`, `order_state_sync`, `order_timeout_extended`, `broadcast_state_changed`, `broadcast_expired`, `broadcast_countdown`, `order_no_supply`
- Truck request / hold: `new_broadcast`, `new_truck_request`, `truck_assigned`, `truck_confirmed`, `truck_request_accepted`, `trucks_remaining_update`, `trucks_remaining_update_v2`, `request_no_longer_available`, `flex_hold_started`, `flex_hold_extended`, `flex_hold_superseded`, `hold_expired`, `cascade_reassigned`
- Driver: `driver_online`, `driver_offline`, `driver_status_changed`, `driver_timeout`, `driver_presence_timeout`, `driver_approaching`, `driver_may_be_offline`, `driver_connectivity_issue`, `driver_accepted`, `driver_declined`, `driver_added`, `driver_updated`, `driver_deleted`, `drivers_updated`, `driver_rating_updated`, `driver_sos_alert`, `sos_ack`
- Trip / tracking: `trip_assigned`, `trip_cancelled`, `location_updated`, `eta_updated`, `route_progress_updated`, `assignment_status_changed`, `assignment_timeout`, `assignment_stale`
- Vehicle / fleet: `vehicle_registered`, `vehicle_updated`, `vehicle_deleted`, `vehicle_status_changed`, `fleet_updated`, `transporter_status_changed`
- Profile: `profile_completed`, `profile_photo_updated`, `license_photos_updated`
- Other: `new_order_alert`, `accept_confirmation`, `no_vehicles_available`

**Client → server events:** `join_booking`, `leave_booking`, `join_order`, `leave_order`, `join_transporter`, `join_trip`, `update_location` (driver only, rate-limited), `broadcast_ack`, `driver_sos`. Each enforces ownership check via Prisma lookup before joining.

**Phase 4 sequence delivery (`FF_SEQUENCE_DELIVERY_ENABLED`):** ZSET-based unacked queue per `{userId}:{role}`. On reconnect, replays unacked events in order. Client sends `broadcast_ack` to purge up to seq number. Decision helper `decideBroadcastAckPurge()` at line 255. Per-seq vs window-based purge.

**FCM dual-channel delivery (`FF_DUAL_CHANNEL_DELIVERY=true`, default ON):** every broadcast sent via Socket.IO AND FCM in parallel — covers offline / background app cases.

## FCM / Push Notifications

**Service:** `src/shared/services/fcm.service.ts` (1738 lines). SDK: `firebase-admin` 13.6.0.

**Initialization** (`initialize()` at `fcm.service.ts:266`, called from `server.ts:239`):
- Credential resolution order:
  1. `FIREBASE_PRIVATE_KEY_B64` (preferred for ECS — base64-encoded service account key, P1-T20)
  2. `FIREBASE_PRIVATE_KEY` (literal `\n` to real newlines)
  3. `FIREBASE_SERVICE_ACCOUNT_PATH` (file-based, local dev)
  4. `FIREBASE_SERVICE_ACCOUNT` (raw JSON string)
  5. Mock mode (notifications logged only)
- Production startup guard (`server.ts:225-236`): missing FCM credentials → fatal `throw` (dual-channel delivery hard-requires FCM).
- Boot dry-run send validates the credential pipeline; latency observed via `fcm_boot_dry_run_latency_ms`.
- `FCM_FAIL_FAST_IN_PROD=false` allows mock mode in production (rollback gate).
- Sentry-style log redactor (`redactInitLog`) strips PEM blocks + 40+ char base64 runs.

**Token storage:**
- **Primary:** Redis SET — `fcm:tokens:{userId}` (90-day TTL, `FCM_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60`).
- **Fallback:** PostgreSQL `DeviceToken` table (`userId`, `token`, `platform`, `lastSeenAt`, `revokedAt`, `appVersionCode`). Active tokens filtered via `revokedAt IS NULL AND lastSeenAt > 90d ago` partial index.
- Soft-delete on FCM `messaging/registration-token-not-registered` → set `revokedAt=now()` (P7-T05). `getTokens()` excludes revoked.
- Token registration endpoint: `POST /api/v1/notifications/register-token` (`src/modules/notification/notification.routes.ts:70`).
- Token unregister: `DELETE /api/v1/notifications/unregister-token` (line 200).

**Send flows:**
- `sendToUser(userId, payload)` — fans out to all tokens for user.
- `sendToTopic(topic, payload)` — for vehicle-type broadcasts.
- `sendMulticast` — batch up to 500 tokens (`FF_FCM_MULTICAST_ENABLED`, kill-switch).
- Multicast failure-ratio kill-switch: auto-revert if `fcm_multicast_failure_ratio > 0.02`.
- Egress rate limiter: in-process token bucket — 8000 msg/s (80% of Google's 10K cap). Counter `fcm_egress_rate_limited_total`.
- Smart retry (`FF_FCM_SMART_RETRY`): exponential backoff on transient errors only (non-retryable codes skipped).
- Non-retryable codes: `messaging/registration-token-not-registered`, `messaging/invalid-registration-token`, `messaging/invalid-argument`, `messaging/mismatched-credential`, `messaging/third-party-auth-error`, `messaging/authentication-error`, `messaging/unauthorized`, `messaging/sender-id-mismatch`.
- Error code normalization: `normalizeFirebaseErrorCode()` maps 10 raw FB codes onto 7-category enum (`INVALID_TOKEN`, `NOT_REGISTERED`, `INVALID_ARGUMENT`, `QUOTA_EXCEEDED`, `SERVER_UNAVAILABLE`, `SERVER_ERROR`, `AUTH_ERROR`) for bounded label cardinality.

**Notification types** (`fcm.service.ts:71-77`):
- `NEW_BROADCAST`, `ASSIGNMENT_UPDATE`, `TRIP_UPDATE`, `PAYMENT`, `GENERAL`.
- `FF_FCM_DATA_ONLY_FULLSCREEN` toggles between notification+data and data-only payload (kill-switch).
- `FF_FCM_PRIORITY_HIGH_DEFAULT` — Android priority `high` vs `normal` (default ON).
- W0-4 canary metric `fcm_push_priority_total{priority,type}`.

**Upgrade campaign** (`FF_FCM_UPGRADE_CAMPAIGN`):
- Boot assertion: requires `DeviceToken.appVersionCode` column (`server.ts:602-614`).
- Sends force-upgrade pushes to clients below `MIN_SUPPORTED_APP_VERSION` (`fcm-upgrade-campaign.ts`).
- Version gate: `shouldSkipForVersion()` (`fcm-version-gate.ts`).

**Rotation runbook** in module-level comment (`fcm.service.ts:1-27`): generate new key in Firebase Console → base64-encode → store in AWS Secrets Manager → ECS rolling deploy → 24h overlap → revoke old key.

## External APIs

### Google Maps

**Service:** `src/shared/services/google-maps.service.ts:677` (`googleMapsService`).
- API key: `GOOGLE_MAPS_API_KEY` (production-required).
- Uses native `fetch()` (not `googlemaps` SDK).
- Endpoints used:
  - Directions API: `directionsUrl` (line 261)
  - Places Autocomplete: `placesUrl` (line 358)
  - Place Details: `placeDetailsUrl` (line 425)
  - Geocoding: `geocodingUrl` (line 479)
- Cache TTLs: places search 6h, directions 24h, geocoding 30d.
- Cache via `cacheService` (`src/shared/services/cache.service.ts`).
- `stopGoogleMapsMetrics()` invoked on graceful shutdown.

### Google Distance Matrix / Directions for ranking

- `src/shared/services/directions-api.service.ts` — Google Directions API for route/ETA scoring during candidate ranking.
- `src/shared/services/distance-matrix.service.ts` — Google Distance Matrix for batch distance calculations.
- Gated by `FF_DIRECTIONS_API_SCORING_ENABLED` (default ON).
- Rate cap: `DIRECTIONS_API_MAX_QPS=450`.
- Hard timeout: `Promise.race` 2s timeout (counter `google_directions_timeout_total`).
- Fallback metric: `eta_ranking_fallback_total` (Haversine fallback when Google fails).

### AWS Location Service (optional fallback)

- `@aws-sdk/client-location` 3.975.0.
- Config in `src/config/aws.config.ts`. Env: `AWS_LOCATION_ENABLED` (default false), `AWS_LOCATION_ROUTE_CALCULATOR=weelo-routes`, `AWS_LOCATION_PLACE_INDEX=weelo-places`, `AWS_REGION=ap-south-1`.
- Used for road-following truck-specific routing when Google fails or quota burn high.

### S3 (file storage)

- `src/shared/services/s3-upload.service.ts:50` (`S3UploadService`).
- SDK: `@aws-sdk/client-s3` 3.978.0 + `@aws-sdk/s3-request-presigner` 3.978.0.
- Bucket: `S3_BUCKET` env (default `weelo-uploads`), region `AWS_REGION` (default `ap-south-1`).
- Auth: explicit `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, OR ECS Task Role (no creds needed in production).
- Presigned URL TTL: 7 days (Instagram-style stable URL caching).
- Max file size: 10MB. Allowed MIME: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`.
- Key prefixes: `profiles/`, `vehicles/`, `documents/`, `receipts/`.
- Local-disk fallback: `uploads/{folder}/{timestamp}_{filename}` when S3 not configured.
- Regenerate presigned URLs script: `scripts/regenerate-presigned-urls.ts`.

### Exotel (masked calling)

- `src/shared/services/exotel.service.ts:106` (`exotelService`).
- Used for masked driver↔customer calls.
- Config: `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN`, `EXOTEL_SUBDOMAIN`.
- API: `https://{apiKey}:{apiToken}@{subdomain}.exotel.com/v1/Accounts/{apiKey}/Calls/connect.json`.
- HTTP timeout enforced.

### Sentry (error tracking)

- `src/instrument.ts` — `Sentry.init({ dsn: SENTRY_DSN, tracesSampleRate: 0.1 in prod / 1.0 in dev, beforeSend strips authorization + cookie headers })`.
- `enabled: !!process.env.SENTRY_DSN` — disabled if DSN unset.
- File excluded from `tsc` build (`tsconfig.json:33`); loaded via NODE_OPTIONS preload externally.
- `@sentry/node` package NOT in `package.json` — must be installed in deploy environment manually.

### OpenTelemetry (distributed tracing)

- `src/instrumentation.ts` — `NodeSDK` with OTLP gRPC exporter.
- Endpoint: `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4317`).
- Sampler: `ParentBasedSampler` with `TraceIdRatioBasedSampler(0.01)` (1% root sampling, configurable via `OTEL_SAMPLE_RATE`).
- Auto-instrumentations: `@opentelemetry/instrumentation-express`, `instrumentation-ioredis`, `instrumentation-http`.
- Activated only when `OTEL_ENABLED=true`.
- Service name: `weelo-backend`.
- File excluded from `tsc` build; packages NOT in `package.json` — installed externally in deploy env.

## Auth Providers

**Strategy:** OTP-based phone login → JWT access (HS256) + refresh token rotation. No OAuth/social login.

**JWT:**
- Signing: `config.jwt.secret` (HS256), 64-byte hex random recommended.
- Access token: `JWT_EXPIRES_IN=7d` (env default; `environment.ts:149` defaults to `5m` though `.env.example` says `7d` — discrepancy).
- Refresh token: `JWT_REFRESH_SECRET` (separate secret), `JWT_REFRESH_EXPIRES_IN=30d`.
- Token revocation: `blacklist:{jti}` Redis key, checked on every socket connect + auth middleware.
- Production validation: secret must be ≥ 32 bytes (`server.ts:626-633`), or boot dies.

**OTP:**
- Length: `OTP_LENGTH=6` (numeric).
- Expiry: `OTP_EXPIRY_MINUTES=5`.
- Max attempts: `OTP_MAX_ATTEMPTS=3` per OTP.
- Storage primary: Redis `otp:{phone}:{role}` keys.
- Storage fallback: `OtpStore` Postgres table (created in `docker-entrypoint.sh`).
- Challenge service: `src/modules/auth/otp-challenge.service.ts`.
- SMS dispatch: `src/modules/auth/sms.service.ts` — multi-provider (`mock`/`console`/`twilio`/`msg91`/`aws-sns`).

**Auth flow routes (`src/modules/auth/auth.routes.ts`):**
- `POST /api/v1/auth/send-otp` — `authRateLimiter + otpRateLimiter` (line 29)
- `POST /api/v1/auth/verify-otp` — `authRateLimiter + verifyOtpRateLimiter` (line 36)
- `POST /api/v1/auth/refresh` — token refresh (line 43)
- `POST /api/v1/auth/logout` — JTI blacklist insert (line 50)
- `GET /api/v1/auth/me` — current user (line 57)

**Driver auth flow** (separate at `src/modules/driver-auth/driver-auth.routes.ts`):
- `POST /api/v1/driver-auth/send-otp` (line 53)
- `POST /api/v1/driver-auth/verify-otp` (line 90)
- `POST /api/v1/driver-auth/logout` (line 121)

**No biometric server-side** — biometric is purely client-side gate before app-stored token submission.

**Phone hashing for keys (`src/config/environment.ts:248-254`):** `PHONE_KEY_SALT` (≥32 chars) + per-call HMAC. Used to construct rate-limit keys without storing plaintext phone in Redis.

## Webhooks

**Inbound webhooks: NONE.** Confirmed by `src/server.ts:398-444` — "No webhook raw-body parser exists in this codebase (no Stripe/payment webhooks)." `express.json({ limit: '32kb' })` is used uniformly with no raw-body bypass.

**Outbound webhooks: NONE detected.** No outbound webhook dispatcher in `src/`.

## Cron / Scheduled Jobs

Implemented via `setInterval(...).unref()` (no `node-cron` package).

| Job | Interval | File | Distributed lock |
|-----|----------|------|------------------|
| Cleanup expired orders | 2 min | `src/shared/jobs/cleanup-expired-orders.job.ts:138` | `lock:cleanup-expired-orders` (25s) |
| Cleanup order idempotency | 24 hr default (`STATUS_EVENT_RETENTION_DAYS`) | `src/shared/jobs/cleanup-order-idempotency.job.ts:168` | yes |
| Cleanup status events | 6 hr (`SIX_HOURS_MS`) | `src/shared/jobs/cleanup-status-events.job.ts:123` | `lock:cleanup-status-events` (120s) |
| Trip SLA monitor | 30 min (`SCAN_INTERVAL_MS`) | `src/shared/jobs/trip-sla-monitor.job.ts:241` | `lock:trip-sla-monitor` (120s) |
| Live availability reconciliation | 5 min | `src/server.ts:958` | (none — best-effort) |
| Geo index pruning | 5 min | `src/server.ts:976` | yes (`pruneStaleGeoEntries`) |
| Rating reminder poller | 60s | `src/server.ts:993-998` | (none) |
| Smart-timeout expiry checker | 15s | `src/modules/order-timeout/smart-timeout.service.ts` (started at `server.ts:1006-1013`) | (none) |
| Broadcast expiry checker | 5s | `src/modules/broadcast/broadcast.service.ts` (started at `server.ts:1017-1024`) | (none) |
| VehicleTransitionOutbox poller | 10s | `src/shared/services/vehicle-transition-outbox.service.ts` (started at `server.ts:1030-1039`) | yes |
| DLQ broadcast drainer | 30s | `scripts/replay-broadcast-dlq.ts` (started at `server.ts:1088-1106`) | leader-elected via `redisService.acquireLock` |
| Hold reconciliation | 30s (production only) | `src/modules/hold-expiry/hold-reconciliation.service.ts` (started at `server.ts:899-903`) | yes |
| Hold cleanup (legacy reconciler) | 60s | `src/modules/truck-hold/truck-hold.service.ts` | `lock:hold:cleanup:unified` |
| Driver offline checker | (started at `server.ts:988-989`) | `src/modules/tracking/tracking.service.ts` | yes |
| Stale transporter cleanup | (started at `server.ts:986`) | `src/shared/services/transporter-online.service.ts` | yes |
| Booking expiry checker | (started at `server.ts:984`) | `src/modules/booking/booking.service.ts` | yes |
| Audit retention | per leader-locked schedule | `src/shared/queue-processors/audit-retention.ts` (registered at `server.ts:1073-1078`) | leader-elected |

Leader election helper: `src/shared/services/leader-election.service.ts` — wraps `setInterval` with `.unref()`, uses Redis lock heartbeat. Used by audit-retention and DLQ drainer.

## Monitoring

### Metrics service

`src/shared/monitoring/metrics.service.ts` (953 lines) — hand-rolled Prometheus-compatible metrics.

- `MetricsService` class with `counters: Map`, `gauges: Map`, `histograms: Map`, `httpRequestSamples: HttpRequestSample[]`.
- Latency buckets: `[5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]` ms.
- HTTP sample window: 15min, max 40000 samples.
- Endpoint: `GET /metrics` (Prometheus format) — registered via `metricsMiddleware` (`server.ts:464`).
- Event loop delay: `node:perf_hooks.monitorEventLoopDelay({ resolution: 20 })` enabled at module load (disabled in test env).
- Auto-creates metrics on first `incrementCounter`/`observeHistogram` call (no boot WARN).
- Fixed historical bug: dot-notation names (`hold.request.total`) replaced with underscores (`hold_request_total`); duplicates between `metrics.service.ts` constructor and `metrics-definitions.ts` consolidated (CLAUDE.md §3 — RESOLVED 2026-04-11).

### Metric registry

`src/shared/monitoring/metrics-definitions.ts` (1211 lines) — single source of truth for metric registration. Categories:

**HTTP / DB / Cache:** `http_requests_total`, `db_queries_total`, `cache_hits_total`, `cache_misses_total`, `load_test_requests_total`, `http_request_duration_ms` (histogram), `db_query_duration_ms`, `pool_wait_seconds` (gauge).

**Tracking stream:** `tracking_stream_publish_success_total`, `tracking_stream_publish_fail_total`, `tracking_stream_dropped_total`, `tracking_stream_retry_total`, `tracking_queue_dropped_total`.

**Broadcast queue:** `broadcast_queue_guard_dropped_total`, `broadcast_queue_guard_fail_open_total`, `broadcast_candidates_found`, `broadcast_fanout_total`, `broadcast_skipped_no_available`, `broadcast_delivery_enqueued`, `broadcast_delivery_delivered`, `broadcast_delivery_failed`.

**Cancellation:** `cancel_requests_total`, `cancel_emit_retry_total`, `cancel_rebook_throttled_total`, `holds_released_on_cancel_total`, `cancel_dispute_created_total`.

**Truck hold:** `hold_request_total`, `hold_success_total`, `hold_conflict_total`, `hold_idempotent_replay_total`, `hold_release_total`, `hold_cleanup_released_total`, `hold_idempotency_purged_total`, `hold_confirmed_committed_total`, `hold_reconciliation_processed_total`, `confirmed_hold_fanout_duration_ms` (histogram).

**Reconciliation:** `reconciliation.orphaned_records_total`, `reconciliation.tracking_orphans_total`, `reconciliation.hold_orphans_total`.

**FCM:** `fcm_send_success_total`, `fcm_send_failure_total{category}` (7 normalized categories), `fcm_egress_rate_limited_total`, `fcm_send_connection_reuse_ratio`, `fcm_dead_token_cleanup_total`, `fcm_init_missing_config`, `fcm_boot_dry_run_latency_ms`, `fcm_quota_consumed_total`, `fcm_push_priority_total{priority,type}`, `fcm_multicast_failure_ratio`.

**Socket:** `socket_emit_while_adapter_down_total{event,mode}`, `socket_emit_buffered_adapter_down_total{event}`, `socket_connect_total`, `socket_auth_role_spoof_rejected_total`, `socket_replay_truncated_total`, `socket_stream_partition_depth_N` (16 gauges, one per partition), `socket_adapter_xadd_ms` (histogram), `redis_adapter_state_gauge`, `socket_upgrade_rate_limited_total{reason}`, `handshakes_in_progress` (gauge).

**Order:** `missing_idempotency_key_total`, `order_create_rejected_total{reason}`, `order_dispatch_outcome_captured_total{source}`, `google_directions_timeout_total`, `eta_ranking_fallback_total`, `new_assignment_socket_emit_total{result}`, `driver_overlay_rendered_total{result}`.

**Resilience:** `circuit_breaker_state_gauge`, `dlq_pushed_total{queue}`, `queue_enqueue_rejected_total{queue}`, `queue_backlog_cap_dropped_total{queue,reason}`, `queue_backpressure_rejected_total{queue}`, `queue_processing_hash_failed_total`, `queue_processing_reaped_total{queue}`, `rate_limiter_open_fail_total`, `jwt_blacklist_check_failures_total{reason}`.

**Outbox:** `outbox_drained_total{outcome}`, `outbox_size` (gauge), `post_commit_cache_failure_total{cache}`.

**Cache:** `fleetcache_read_total{result}`, `fleet_cache_corruption_total`.

**Edge:** `edge_client_ip_source_total{source}`, `middleware_order_rate_limiter_before_json_parser` (gauge, asserted=1 at boot).

**Misc:** `redis_eviction_check_skipped_total`, `nodejs_eventloop_lag_ms`, `nodejs_eventloop_lag_p99_ms`.

### CloudWatch alarms

`scripts/monitoring/setup-broadcast-p1-alarms.sh` (565 lines) — creates 9 baseline + 12 P3 SLO + 16 partition-depth = **37 CloudWatch alarms** in `Weelo/Backend` namespace.

Helpers: `put_counter_alarm`, `put_gauge_max_alarm`, `put_histogram_p99_alarm`, `put_metric_math_alarm`.

Alarms (full list at top of script):
- `weelo-p1-socket-adapter-down`, `weelo-p1-eta-fallback-spike`, `weelo-p1-fleet-cache-corruption`, `weelo-p1-post-commit-cache-failure-{google_directions,idempotency}`, `weelo-p1-circuit-breaker-open`, `weelo-p1-dlq-pushed`, `weelo-p1-fleetcache-read-error`, `weelo-p1-pool-wait-p99`, `weelo-p1-fcm-quota-burn`.
- P3: `weelo-p3-hold-request-rate-drop` (metric-math, 20% rate drop), `weelo-p3-hold-conversion-low` (metric-math, < 95% confirm rate), `weelo-p3-assignment-emit-fail`, `weelo-p3-driver-overlay-fail`, `weelo-p3-fcm-error-rate` (metric-math, > 1%), `weelo-p3-socket-reconnect-surge` (> 5000/s), `weelo-p3-fanout-p99` (> 600ms), `weelo-p3-outbox-drain-failed`, `weelo-p3-outbox-size-high` (> 10k), `weelo-p3-stream-partition-depth-{0..15}` (16 gauges, > 80k), `weelo-p3-eventloop-lag` (> 50ms), `weelo-p3-socket-xadd-p99` (> 500ms), `weelo-p3-socket-replay-truncated` (> 50/5min).
- M18 alarm descriptor: `scripts/monitoring/alarm-m18-adapter-down.json` (preferred over inline definition).

CloudWatch dashboard: `scripts/monitoring/broadcast-baseline-p1-dashboard.json`.

Setup-alarms wrapper: `scripts/monitoring/setup-alarms.sh` (phase 8 baseline alarms).

SNS topics required: `ALARM_SNS_TOPIC_ARN` (P2 pager, required), `ALARM_SNS_P3_TOPIC_ARN` (optional P3 pager — falls back to ALARM_SNS_TOPIC_ARN).

Region: `AWS_REGION=ap-south-1` default. Namespace: `CW_NAMESPACE=Weelo/Backend`.

### Logger

`src/shared/services/logger.service.ts` — Winston-based, JSON output in production, pretty-print in dev. Levels: `debug | info | warn | error`. Configured via `LOG_LEVEL` env.

Log groups (from `aws.config.ts:239-243`): `/weelo/application`, `/weelo/access`, `/weelo/error`. Retention: `LOG_RETENTION_DAYS=30`.

### Health endpoints

`src/shared/routes/health.routes.ts` registered before rate limiter (`server.ts:332`):
- `GET /health` — unauthenticated, ALB probe target. Returns 503 if `_isShuttingDown=true`.
- `GET /health/ready` — readiness probe.
- `GET /health/runtime` — auth required + `roleGuard(['admin'])` (post-A09 lockdown). Returns DB/Redis/socket/connectedUsers stats.
- `GET /flag-health/*` (`flagHealthRouter`) — feature flag inspection.

## Boot Assertions Summary

These all happen inside `bootstrap()` before `server.listen` (`src/server.ts:733-1255`):

1. `validateAndLogEnvironment()` — env var registry validation.
2. `redisService.initialize()` — Redis must connect first.
3. `assertRedisEvictionPolicy(client)` — Redis must be `noeviction`.
4. HTTP upgrade rate limiter registered (in-process token bucket).
5. `initializeSocket(server)` — Socket.IO + Redis Streams adapter.
6. `holdReconciliationService.start()` (production only).
7. H3 geo index rebuild (when `FF_H3_INDEX_ENABLED`).
8. Live availability rebuild (with random jitter + distributed lock).
9. Geo rebuild from DB (Redis restart recovery).
10. Background jobs started: booking-expiry, stale-transporter-cleanup, driver-offline-checker, rating-reminder, smart-timeout, broadcast-expiry, vehicle-transition-outbox, orphaned-step-timer recovery, idempotency cleanup, audit-retention, DLQ drainer.
11. F-B-03 prefix-overlap assertion — Redis namespace owners non-overlap.
12. `validateProductionConfig()` — JWT length, DB pool, Redis health + version >= 7.4.
13. DEBUG env guard (production only).
14. `assertFcmUpgradeCampaignReadiness()` — DeviceToken.appVersionCode column present.
15. `assertBroadcastDeclineTableExists()` — analytics table WARN.
16. `validateFeatureFlags()` — fail-fast on invalid flag values.
17. `server.listen(PORT, '0.0.0.0')`.
18. Server timeouts set: `timeout=30s`, `keepAliveTimeout=65s`, `headersTimeout=66s`.
19. `cleanupExpiredOrders` cron job started (2min interval).

---

*Integration audit: 2026-05-04*
