# Architecture Research

**Domain:** Logistics/trucking real-time broadcast platform — broadcast lifecycle + infrastructure hardening milestone
**Researched:** 2026-02-19
**Confidence:** HIGH (based on direct codebase analysis, no external sources required for architecture dimension)

---

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        CLIENT LAYER                                       │
│  ┌──────────────┐  ┌──────────────────┐  ┌───────────────────────┐       │
│  │  Customer    │  │  Transporter /   │  │  Driver               │       │
│  │  App (HTTP   │  │  Captain App     │  │  App (Socket.IO +     │       │
│  │  + Socket.IO)│  │  (Socket.IO +    │  │  heartbeat every 12s) │       │
│  │              │  │  heartbeat)      │  │                       │       │
│  └──────┬───────┘  └────────┬─────────┘  └──────────┬────────────┘       │
│         │                  │                         │                   │
└─────────┼──────────────────┼─────────────────────────┼───────────────────┘
          │  HTTPS + WS      │  HTTPS + WS              │  HTTPS + WS
┌─────────▼──────────────────▼─────────────────────────▼───────────────────┐
│                        API + SOCKET LAYER (Express / Socket.IO)           │
│  ┌──────────────┐  ┌──────────────────┐  ┌───────────────────────┐       │
│  │  booking     │  │  broadcast       │  │  order                │       │
│  │  .service.ts │  │  .service.ts     │  │  .service.ts          │       │
│  │  (legacy     │  │  (transporter-   │  │  (multi-vehicle       │       │
│  │  single-     │  │  facing reads +  │  │  parent record,       │       │
│  │  vehicle)    │  │  accept/decline) │  │  TruckRequest         │       │
│  └──────┬───────┘  └────────┬─────────┘  └──────────┬────────────┘       │
│         │                  │                         │                   │
│  ┌──────▼──────────────────▼─────────────────────────▼────────────────┐  │
│  │              socket.service.ts (Socket.IO server)                  │  │
│  │   emitToUser / emitToRoom / emitToAllTransporters                  │  │
│  │   Redis Pub/Sub cross-server fan-out (socket:user:{id} channel)    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────────────┤
│                        SHARED SERVICES LAYER                              │
│  ┌────────────────┐  ┌──────────────┐  ┌────────────────────────────┐   │
│  │ availability   │  │ transporter  │  │  redis.service.ts          │   │
│  │ .service.ts    │  │ -online.     │  │  (geo, sets, locks,        │   │
│  │ (geo:drivers:  │  │ service.ts   │  │  pub/sub, timers,          │   │
│  │ {vehicleKey}   │  │ (online:     │  │  distributed locks)        │   │
│  │ geospatial     │  │ transporters │  │                            │   │
│  │ GEORADIUS)     │  │ SET filter)  │  │                            │   │
│  └────────────────┘  └──────────────┘  └────────────────────────────┘   │
├──────────────────────────────────────────────────────────────────────────┤
│                        PERSISTENCE LAYER                                  │
│  ┌────────────────────────────────┐  ┌─────────────────────────────────┐ │
│  │  PostgreSQL (via Prisma ORM)   │  │  Redis (AWS ElastiCache TLS)    │ │
│  │  Booking, Order, TruckRequest  │  │  Presence, timers, geo index,   │ │
│  │  Assignment, User, Vehicle     │  │  pub/sub, distributed locks     │ │
│  └────────────────────────────────┘  └─────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| `booking.service.ts` | Legacy single-vehicle broadcast lifecycle: create, cancel, timeout, progressive radius expansion, re-broadcast on toggle | `BookingService` class; Redis timers (`timer:booking:{id}`); radius expansion via `timer:radius:{id}` |
| `order.service.ts` | Multi-vehicle order lifecycle: create parent Order + N TruckRequests, broadcast by vehicle type group, timeout | `OrderService` class; Redis timer `timer:booking-order:{id}`; grouped broadcast per vehicle type |
| `broadcast.service.ts` | Transporter-facing read surface: list active broadcasts (Booking + Order), accept a broadcast slot, decline, history. Also owns `BroadcastEvents` socket event names | `BroadcastService` class; uses Prisma serializable transactions for accept; idempotency cache via Redis |
| `socket.service.ts` | All WebSocket I/O: connect, auth middleware, room management, heartbeat, presence restore on reconnect, cross-server Redis pub/sub fan-out | Socket.IO `Server`; `userSockets` Map; pub/sub via `redisService.publish/subscribe` |
| `availability.service.ts` | Driver geo index: GEOADD on heartbeat, GEORADIUS on booking create (step 1 radius search). Key: `geo:drivers:{vehicleKey}` | Stateless class; wraps `redisService.geoAdd/geoRadius`; 60s TTL auto-offline |
| `transporter-online.service.ts` | O(1) online filter: `online:transporters` Redis set, presence TTL check, stale cleanup job every 30s | Singleton; `filterOnline()` via SMEMBERS + Set intersection; distributed lock on cleanup |
| `redis.service.ts` | Unified Redis abstraction: basic ops, geo, sets, hashes, distributed locks (Lua NX EX), pub/sub, distributed timers (sorted set `timers:pending`), fallback in-memory mode | `RedisService` singleton wrapping `IRedisClient`; in-memory fallback for dev |
| `fcm.service.ts` | Background push via FCM: new broadcast, trip assigned, expiry, cancellation | Fire-and-forget; queued through `queue.service.ts` for retry |
| `queue.service.ts` | Redis list-backed job queue: push notification batches, deferred heavy ops | `lPush`/`brPop`; separate worker consumer |

---

## Recommended Project Structure

```
src/
├── modules/
│   ├── booking/
│   │   ├── booking.service.ts        # Legacy single-vehicle broadcast lifecycle
│   │   ├── order.service.ts          # Multi-vehicle Order + TruckRequest lifecycle
│   │   ├── booking-payload.helper.ts # Shared payload builder (broadcastId+orderId aliases)
│   │   ├── booking.controller.ts
│   │   ├── booking.routes.ts
│   │   └── booking.schema.ts
│   ├── broadcast/
│   │   ├── broadcast.service.ts      # Transporter read/accept/decline surface
│   │   ├── broadcast.routes.ts
│   │   └── broadcast.schema.ts
│   ├── order/
│   │   └── order.routes.ts           # REST endpoints for Order/TruckRequest
│   └── transporter/
│       └── transporter.routes.ts     # Toggle online/offline + re-broadcast trigger
├── shared/
│   ├── services/
│   │   ├── redis.service.ts          # Central Redis abstraction
│   │   ├── socket.service.ts         # Socket.IO + Redis pub/sub cross-server
│   │   ├── availability.service.ts   # Geo driver index
│   │   ├── transporter-online.service.ts  # Online set + stale cleanup
│   │   ├── fcm.service.ts
│   │   ├── queue.service.ts          # Redis list queue
│   │   └── logger.service.ts
│   ├── database/
│   │   ├── db.ts                     # Unified DB facade (Booking, Order, TruckRequest)
│   │   └── prisma.service.ts
│   └── middleware/
│       └── auth.middleware.ts
└── core/
    ├── constants/index.ts            # ErrorCode enum
    └── errors/AppError.ts
```

### Structure Rationale

- **`modules/booking/`:** Both `booking.service.ts` (legacy path) and `order.service.ts` (new multi-vehicle path) live here. They share the same `booking-payload.helper.ts` to keep socket event payloads consistent across both broadcast types.
- **`modules/broadcast/`:** Intentionally separate from `booking/`. This is the transporter-facing read surface. It reads from both Booking and Order tables. Keeping it separate prevents the transporter API from importing booking creation logic.
- **`shared/services/`:** All cross-cutting infrastructure. Nothing in `modules/` imports from other modules' services directly — they go through `shared/`.

---

## Architectural Patterns

### Pattern 1: Redis Distributed Timer for Broadcast Expiry

**What:** Store expiry timestamp in Redis with TTL. Background job (`setInterval` every 5s on each instance) scans `timers:pending` sorted set for expired keys. Distributed lock (`lock:booking-expiry:{id}`) ensures only one ECS instance processes each expiry.

**When to use:** Any stateful operation that needs to fire after a delay, across a cluster. Replaces in-memory `setTimeout` which is lost on process restart.

**Trade-offs:** Adds Redis round-trips; polling interval (5s) means up to 5s latency on expiry. Acceptable for logistics where 5s window is invisible to users.

**Example:**
```typescript
// Set timer
await redisService.setTimer(
  `timer:booking:${bookingId}`,
  { bookingId, customerId, createdAt: new Date().toISOString() },
  new Date(Date.now() + BOOKING_CONFIG.TIMEOUT_MS)
);

// Process (runs every 5s on each instance)
const expiredTimers = await redisService.getExpiredTimers<BookingTimerData>('timer:booking:');
for (const timer of expiredTimers) {
  const lock = await redisService.acquireLock(`lock:booking-expiry:${timer.data.bookingId}`, 'expiry-checker', 30);
  if (!lock.acquired) continue;  // Another instance handling this
  try {
    await bookingService.handleBookingTimeout(timer.data.bookingId, timer.data.customerId);
    await redisService.cancelTimer(timer.key);
  } finally {
    await redisService.releaseLock(`lock:booking-expiry:${timer.data.bookingId}`, 'expiry-checker');
  }
}
```

### Pattern 2: Progressive Radius Expansion

**What:** Step 1 broadcasts to transporters within 10km. If no accept within 15s, step 2 expands to 25km — but only to NEW transporters (dedup via `broadcast:notified:{bookingId}` Redis SET). Steps: 10km → 25km → 50km → 75km → DB fallback (all matching, online).

**When to use:** Demand-supply mismatch: prefer nearby transporters but don't block on sparse areas.

**Trade-offs:** Complexity in timer chaining (`timer:radius:{bookingId}`). If all steps exhausted and still no accept, DB fallback queries all online matching transporters — correct fallback but O(N) Redis set membership check.

**Example:**
```typescript
// Track notified set to avoid duplicate notifications
await redisService.sAdd(`broadcast:notified:${bookingId}`, ...step1Transporters);

// On next step, dedup:
const alreadyNotified = await redisService.sMembers(`broadcast:notified:${bookingId}`);
const alreadyNotifiedSet = new Set(alreadyNotified);
const newTransporters = step2Transporters.filter(t => !alreadyNotifiedSet.has(t));
```

### Pattern 3: Serializable Transaction + Optimistic Concurrency for Accept

**What:** `broadcast.service.ts` `acceptBroadcast()` uses `prismaClient.$transaction({ isolationLevel: 'Serializable' })`. Inside the transaction, it does `updateMany({ where: { id, trucksFilled: currentFilled } })` and checks `count === 1` — atomic optimistic lock. Up to 3 retries on Prisma error code P2034 (serialization failure).

**When to use:** Multiple transporters can race to accept the same truck slot. No application-level row lock can be safely held across async DB calls — let the DB serialize.

**Trade-offs:** Serializable isolation is expensive under high write contention. For the current scale (tens of concurrent accepts on one booking), this is fine. At 1000+ concurrent accepts per slot, consider pessimistic locking or a Redis-based counter with conditional increment (GETSET/Lua).

**Example:**
```typescript
const bookingUpdate = await tx.booking.updateMany({
  where: { id: broadcastId, trucksFilled: booking.trucksFilled },  // Optimistic lock
  data: { trucksFilled: { increment: 1 } }
});
if (bookingUpdate.count !== 1) {
  throw new AppError(409, 'INVALID_ASSIGNMENT_STATE', 'Broadcast state changed. Retry.');
}
```

### Pattern 4: One-Per-Customer Enforcement (to be built)

**What:** Currently missing. The booking system has idempotency keys per request but no enforcement of "customer can only have one active broadcast at a time." This needs a Redis key `customer:active-broadcast:{customerId}` set at broadcast creation, checked before create, cleared on cancel/expire/fully_filled.

**When to use:** Must be enforced before any broadcast search/create flow. Prevents customers spamming the transporter network.

**Example (recommended approach):**
```typescript
// On broadcast create
const activeKey = `customer:active-broadcast:${customerId}`;
const existing = await redisService.get(activeKey);
if (existing) {
  throw new AppError(409, 'ACTIVE_BROADCAST_EXISTS', 'You already have an active search.');
}
await redisService.set(activeKey, bookingId, BOOKING_CONFIG.TIMEOUT_MS / 1000 + 60);

// On cancel/expire/fully_filled
await redisService.del(`customer:active-broadcast:${customerId}`);
```

---

## Data Flow

### Broadcast Creation Flow (Single-Vehicle Booking)

```
Customer HTTP POST /api/v1/booking
    |
    v
bookingService.createBooking()
    |-- Idempotency check: Redis "idempotency:booking:{customerId}:{key}"
    |-- Progressive radius step 1: availabilityService.getAvailableTransportersAsync(vehicleKey, lat, lng, 20, 10km)
    |   └── Redis GEORADIUS on "geo:drivers:{vehicleKey}"
    |-- Fallback if empty: db.getTransportersWithVehicleType() + transporterOnlineService.filterOnline()
    |   └── Redis SMEMBERS "online:transporters" + Set intersection
    |
    |-- db.createBooking() → PostgreSQL INSERT
    |
    |-- For each matching transporter:
    |   └── emitToUser(transporterId, 'new_broadcast', payload)
    |       └── Socket.IO local emit + redisService.publish("socket:user:{id}", ...)
    |
    |-- fcmService.notifyNewBroadcast(matchingTransporters, ...) → FCM API (async)
    |
    |-- Redis: sAdd("broadcast:notified:{bookingId}", ...transporters)
    |-- Redis: setTimer("timer:booking:{bookingId}", data, expiresAt)
    |-- Redis: setTimer("timer:radius:{bookingId}", stepData, step1Timeout)
    |
    HTTP 201 → Customer (matchingTransportersCount, timeoutSeconds)

Background (every 5s):
    processExpiredBookings() + processRadiusExpansionTimers()
        |-- getExpiredTimers("timer:booking:") → scan "timers:pending" sorted set
        |-- For each expired: acquireLock → handleBookingTimeout → cancelTimer → releaseLock
        |
    handleBookingTimeout():
        |-- db.getBookingById()
        |-- db.updateBooking({ status: 'expired' })
        |-- emitToUser(customerId, 'no_vehicles_available' or 'booking_expired', ...)
        |-- For each notifiedTransporter: emitToUser(transporterId, 'booking_expired', ...)
        |-- queueService.queuePushNotificationBatch(notifiedTransporters, expiry push)
        |-- clearBookingTimers(): cancel Redis timers + del notified SET
```

### Broadcast Accept Flow

```
Transporter HTTP POST /api/v1/broadcast/{broadcastId}/accept
    |
    v
broadcastService.acceptBroadcast()
    |-- Idempotency check: Redis "idem:broadcast:accept:{broadcastId}:{driverId}:{vehicleId}:{key}"
    |-- redisService.acquireLock("broadcast-accept:{broadcastId}", holder, 8s)
    |
    |-- prismaClient.$transaction(Serializable):
    |   |-- tx.booking.findUnique() — validate exists
    |   |-- tx.user.findUnique(actorUserId) — validate actor active
    |   |-- tx.user.findUnique(driverId) — validate driver in fleet
    |   |-- tx.vehicle.findUnique(vehicleId) — validate vehicle in fleet
    |   |-- tx.assignment.findFirst(driverId, activeStatuses) — DRIVER_BUSY check
    |   |-- Check expiry + capacity
    |   |-- tx.booking.updateMany({ where: { id, trucksFilled: current } }) — optimistic lock
    |   |-- tx.booking.update({ status: 'partially_filled' | 'fully_filled' })
    |   |-- tx.assignment.create()
    |   └── return result
    |-- Retry up to 3x on P2034 / 40001 (serialization failure)
    |
    |-- emitToUser(driverId, 'trip_assigned', ...) — WebSocket to driver
    |-- sendPushNotification(driverId, ...) — FCM async
    |-- emitToUser(customerId, 'truck_confirmed', ...) — WebSocket to customer
    |-- emitToRoom("booking:{id}", 'booking_updated', ...)
    |-- sendPushNotification(customerId, ...) — FCM async
    |-- Redis: setJSON idempotency cache 24h
    |-- redisService.releaseLock(...)
    |
    HTTP 200 → Transporter (assignmentId, tripId, trucksConfirmed, isFullyFilled)
```

### Cancel Flow

```
Customer HTTP PUT /api/v1/booking/{bookingId}/cancel
    |
    v
bookingService.cancelBooking()
    |-- db.getBookingById() + access control
    |-- db.updateBooking({ status: 'cancelled' })
    |-- clearBookingTimers():
    |   └── cancelTimer("timer:booking:{id}") + cancelTimer("timer:radius:{id}")
    |       + del "broadcast:radius:step:{id}" + del "broadcast:notified:{id}"
    |-- For each notifiedTransporter:
    |   └── emitToUser(transporterId, 'booking_expired', { reason: 'customer_cancelled', ... })
    |-- emitToBooking(bookingId, 'booking_updated', { status: 'cancelled' })
    |-- del idempotency key (or bypass flag)
    |-- queueService.queuePushNotificationBatch(notifiedTransporters, cancel push)
    |
    HTTP 200 → Customer
```

### Transporter Toggle Online → Re-Broadcast

```
Transporter PUT /api/v1/transporter/availability { isAvailable: true }
    |
    v
transporter.routes.ts
    |-- Rate limit check: Redis "transporter:toggle:count:{id}" (10 per 5min window)
    |-- Idempotency: skip if already in desired state
    |-- acquireLock("transporter:toggle:lock:{id}", 5s)
    |-- prismaClient.user.update({ isAvailable: true })
    |-- redisService.set("transporter:presence:{id}", presenceData, 120s TTL)
    |-- redisService.sAdd("online:transporters", transporterId)
    |-- cacheService.del transporter cache entries
    |-- Set toggle cooldown key
    |-- releaseLock()
    |
    |-- bookingService.deliverMissedBroadcasts(transporterId)  ← fire-and-forget
    |   |-- db.getActiveBookingsForTransporter(transporterId) — filter by vehicle types
    |   |-- Filter expiresAt > now
    |   |-- For each active booking: emitToUser(transporterId, 'new_broadcast', payload)
    |   |-- db.updateBooking({ notifiedTransporters: [...existing, transporterId] })
    |   |-- fcmService.notifyNewBroadcast([transporterId], ...)
    |
    HTTP 200 → Transporter (immediate, re-broadcast is async)
```

### Key Data Flows Summary

1. **New broadcast:** Customer → BookingService → PostgreSQL → Socket.IO fan-out to N transporters → Redis timers started
2. **Accept:** Transporter → BroadcastService → Serializable Tx (Postgres) → Socket.IO to driver + customer → Idempotency cache
3. **Timeout/cancel:** Redis timer fires → expiry checker (each instance, distributed lock) → DB update → Socket.IO to all notified transporters → FCM push queue
4. **Toggle online:** Transporter → DB + Redis presence SET → fire-and-forget re-broadcast delivery

---

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 0–1k concurrent users | Current monolith on single ECS task is fine. Redis + Postgres on same VPC. |
| 1k–10k users | Multiple ECS tasks + Redis pub/sub already implemented. Main bottleneck: `getExpiredTimers()` scanning sorted set — monitor latency. `emitToAllTransporters()` iterates local socket map: fine for 1 instance, requires Socket.IO Redis adapter for true multi-instance fan-out to all transporters. |
| 10k+ users | Replace `emitToAllTransporters()` (in-process socket iteration) with Socket.IO Redis adapter (`@socket.io/redis-adapter`). Split `timer:*` scanner into dedicated worker ECS task. Consider separate read replica for `getActiveBookingsForTransporter()`. |

### Scaling Priorities

1. **First bottleneck: `emitToAllTransporters` under multi-instance** — currently iterates local sockets only, missing transporters connected to other ECS tasks. Fix: `@socket.io/redis-adapter` OR replace with `redisService.publish(REDIS_CHANNELS.TRANSPORTERS, ...)` (partially implemented but per-instance only). The pub/sub fanout for TRANSPORTERS channel handles cross-server delivery, but each server only delivers to its local transporter sockets — this is correct by design. Verify this works for broadcast expiry events under load.

2. **Second bottleneck: N+1 Redis calls in `getAvailableTransportersAsync`** — each geo match does `hGetAll(DRIVER_DETAILS:{id})`. At 100+ results per radius query, this is 100 sequential Redis calls. Fix: Redis pipeline / MGET batch.

3. **Third bottleneck: `getExpiredTimers()` sorted set scan** — at high booking volume, `timers:pending` sorted set grows. Already uses `ZRANGEBYSCORE` which is O(log N + M). Monitor at >10k concurrent bookings.

---

## Component Boundaries

### What Talks to What

| Boundary | Communication | Direction | Notes |
|----------|---------------|-----------|-------|
| `booking.service.ts` ↔ `broadcast.service.ts` | None — they are parallel paths. `broadcast.service.ts` reads Booking records directly via Prisma. | Independent | This is intentional: broadcast module is the transporter view; booking module is the customer/lifecycle view. |
| `booking.service.ts` ↔ `socket.service.ts` | Direct import (`emitToUser`, `emitToBooking`) | booking → socket | socket never imports booking |
| `broadcast.service.ts` ↔ `socket.service.ts` | Direct import (`emitToUser`, `emitToRoom`, `emitToAllTransporters`) | broadcast → socket | socket never imports broadcast |
| `booking.service.ts` ↔ `redis.service.ts` | Direct import | booking → redis | Timer keys: `timer:booking:*`, `timer:radius:*`, `broadcast:notified:*` |
| `order.service.ts` ↔ `redis.service.ts` | Direct import | order → redis | Timer key: `timer:booking-order:*` |
| `broadcast.service.ts` ↔ `redis.service.ts` | Direct import | broadcast → redis | Idempotency cache: `idem:broadcast:accept:*`, distributed lock: `broadcast-accept:*` |
| `socket.service.ts` ↔ `redis.service.ts` | Pub/Sub | bidirectional | `socket:user:{id}`, `socket:room:{name}`, `socket:broadcast`, `socket:transporters` channels |
| `transporter.routes.ts` ↔ `redis.service.ts` | Direct | routes → redis | `online:transporters`, `transporter:presence:*`, `transporter:toggle:*` |
| `transporter.routes.ts` ↔ `booking.service.ts` | Direct import (`deliverMissedBroadcasts`) | routes → booking | Re-broadcast on toggle-online, fire-and-forget |
| `availability.service.ts` ↔ `redis.service.ts` | Direct | availability → redis | `geo:drivers:{vehicleKey}`, `driver:details:*`, `driver:vehicle:*`, `online:drivers` |
| `transporter-online.service.ts` ↔ `redis.service.ts` | Direct | online-svc → redis | `online:transporters`, `transporter:presence:*` |

### Internal Boundaries — Critical Missing Piece

**One-per-customer enforcement** does not currently exist as a component. It needs to be added at the `booking.service.ts` create boundary. It should be a shared utility (`customer-broadcast-lock.ts` or inline in `booking.service.ts`) that:
- Checks `customer:active-broadcast:{customerId}` before creating
- Sets it on successful create
- Clears it on cancel / timeout / fully_filled

This boundary is important because the current `cancelBooking()` flow clears idempotency keys, but does NOT prevent a customer from creating a second concurrent booking through the Order path (`order.service.ts`).

---

## Anti-Patterns

### Anti-Pattern 1: Splitting Booking and Order Expiry Checkers

**What people do:** Add a third expiry checker for a new broadcast type (e.g., "scheduled bookings") as another `setInterval` in a new service file.

**Why it's wrong:** The system already has two expiry checkers (`booking.service.ts` and `order.service.ts`), each running every 5s. A third adds more polling pressure on Redis's `timers:pending` sorted set and increases log noise. All checkers share the same Redis timer namespace structure.

**Do this instead:** Extract the expiry checker pattern (`processExpiredTimers(prefix, handler)`) into a shared `timer.service.ts`. New broadcast types register their handler with the central timer service. One `setInterval`, one sorted set scan, multiple handlers dispatched by key prefix.

### Anti-Pattern 2: Emitting to All Transporters via `emitToAllTransporters()` for Per-Booking Events

**What people do:** Use `emitToAllTransporters()` to send broadcast expiry events because it's convenient.

**Why it's wrong:** `emitToAllTransporters()` iterates ALL connected transporter sockets and sends to each one, regardless of whether they were notified about the original broadcast. This wastes bandwidth and confuses transporters who never saw the broadcast.

**Do this instead:** For expiry/cancel events, emit only to `booking.notifiedTransporters` (already stored in DB). Use `emitToUser()` per notified transporter. The `emitToAllTransporters()` function is only appropriate for true system-wide announcements (price changes, maintenance).

### Anti-Pattern 3: Countdown Notifications via Local `setInterval`

**What people do:** Both `booking.service.ts` and `order.service.ts` currently use local `setInterval` for countdown notifications to customers.

**Why it's wrong:** If the customer reconnects to a different ECS instance after a crash, the countdown stops because the interval lives only on the original instance. The customer sees no countdown timer.

**Do this instead:** The countdown is a UI nicety, not business logic. The real expiry is Redis-backed. For the countdown specifically, the client app should derive remaining time from the `expiresAt` timestamp returned in the booking response — no server-push countdown needed. Remove server-side countdown `setInterval` to simplify the codebase.

### Anti-Pattern 4: Using `booking.notifiedTransporters` Array for Post-Broadcast State

**What people do:** Store all notified transporter IDs in `booking.notifiedTransporters` (Postgres array field) and iterate it for cancel/expiry notifications.

**Why it's wrong (at scale):** The array grows with each progressive radius step. DB updates to append transporter IDs (`updateBooking({ notifiedTransporters: [...existing, ...new] })`) cause write amplification on a hot row. At 75km radius with 200 transporters, this is a 200-element JSON array in PostgreSQL that gets rewritten on each radius step.

**Do this instead:** The `broadcast:notified:{bookingId}` Redis SET already tracks notified transporters for dedup during radius expansion. Use the Redis SET as the source of truth for cancel/expiry notification fan-out, not the DB array. Keep the DB array as an audit trail only, written once at the end (or not at all).

---

## Build Order Implications for Roadmap

The dependency graph dictates this build sequence:

**Phase 1 — Broadcast Lifecycle States (foundation)**
- Must come first: adds `status` transitions and one-per-customer enforcement to both Booking and Order paths
- Establishes the state machine that all subsequent cleanup logic depends on
- No dependencies on other new components
- Components: DB schema migration (add lifecycle states), customer-broadcast-lock utility, `booking.service.ts` + `order.service.ts` create/cancel guards

**Phase 2 — Cancel/Timeout Cleanup Hardening (depends on Phase 1)**
- Requires Phase 1 states to be correct before cleanup logic can be reliable
- Centralizes the expiry checker pattern (shared `timer.service.ts`)
- Fixes the DB array vs Redis SET notification tracking problem
- Components: `timer.service.ts` extraction, Redis SET as canonical notified-set for cancel fan-out, test coverage for concurrent accept races

**Phase 3 — One-Per-Customer Enforcement + Re-Broadcast Reliability**
- Depends on Phase 1 (needs cancel to clear the lock correctly)
- Customer lock integrates into both Booking and Order create paths
- Re-broadcast dedup (no duplicate deliveries on toggle)
- Components: `customer:active-broadcast:{id}` Redis key, `deliverMissedBroadcasts()` dedup check

**Phase 4 — AWS Infrastructure Hardening**
- Depends on Phases 1-3 being stable (infra changes should land on clean logic)
- ElastiCache, ECS task scaling, Socket.IO Redis adapter for true multi-instance transporter broadcasts
- Components: `@socket.io/redis-adapter`, ECS task definition changes, health checks

---

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| AWS ElastiCache (Redis) | ioredis with TLS (`rediss://`), `rejectUnauthorized: false` | Already configured. `enableOfflineQueue: false` prevents command queuing on disconnect. |
| Firebase FCM | REST API via `fcm.service.ts`, fire-and-forget | Wrapped in `queueService.queuePushNotificationBatch()` for retry. Direct `sendPushNotification()` calls in broadcast/booking services bypass the queue — these should be moved to queue for reliability. |
| AWS ECS | Multi-instance deployment | Socket.IO Redis pub/sub partially covers cross-instance messaging. Full transporter fan-out requires `@socket.io/redis-adapter`. |
| Prisma ORM | PostgreSQL via connection pooling | Serializable isolation on accept path. Monitor P2034 retry rate in production. |

### Internal Boundaries (Redis Key Namespace)

| Namespace | Owner | Purpose |
|-----------|-------|---------|
| `timer:booking:*` | `booking.service.ts` | Single-vehicle booking expiry timers |
| `timer:radius:*` | `booking.service.ts` | Progressive radius expansion timers |
| `timer:booking-order:*` | `order.service.ts` | Multi-vehicle order expiry timers |
| `broadcast:notified:*` | `booking.service.ts` | Dedup set for radius expansion |
| `idem:broadcast:accept:*` | `broadcast.service.ts` | Accept idempotency cache |
| `broadcast-accept:*` | `broadcast.service.ts` (lock namespace) | Distributed lock per broadcast accept |
| `idempotency:booking:*` | `booking.service.ts` | Create booking idempotency |
| `online:transporters` | `transporter-online.service.ts`, `transporter.routes.ts` | Online set (source of truth for broadcast filter) |
| `transporter:presence:*` | `transporter.routes.ts`, `socket.service.ts` | Heartbeat TTL presence (120s) |
| `geo:drivers:*` | `availability.service.ts` | Geospatial index per vehicle key |
| `driver:details:*` | `availability.service.ts` | Driver geo details hash (60s TTL) |
| `lock:*` | Multiple services | Distributed lock namespace (prefix applied by `acquireLock`) |
| `timers:pending` | `redis.service.ts` | Sorted set for all timers (shared across all timer types) |
| `socket:user:*` | `socket.service.ts` | Cross-server user message pub/sub |
| `socket:transporters` | `socket.service.ts` | Cross-server transporter fan-out |
| `customer:active-broadcast:*` | NOT YET BUILT | One-per-customer enforcement (Phase 1) |

---

## Sources

- Direct codebase analysis: `/Users/nitishbhardwaj/Desktop/weelo-backend/src/modules/broadcast/broadcast.service.ts`
- Direct codebase analysis: `/Users/nitishbhardwaj/Desktop/weelo-backend/src/modules/booking/booking.service.ts`
- Direct codebase analysis: `/Users/nitishbhardwaj/Desktop/weelo-backend/src/modules/booking/order.service.ts`
- Direct codebase analysis: `/Users/nitishbhardwaj/Desktop/weelo-backend/src/shared/services/redis.service.ts`
- Direct codebase analysis: `/Users/nitishbhardwaj/Desktop/weelo-backend/src/shared/services/socket.service.ts`
- Direct codebase analysis: `/Users/nitishbhardwaj/Desktop/weelo-backend/src/shared/services/availability.service.ts`
- Direct codebase analysis: `/Users/nitishbhardwaj/Desktop/weelo-backend/src/shared/services/transporter-online.service.ts`
- Direct codebase analysis: `/Users/nitishbhardwaj/Desktop/weelo-backend/src/modules/transporter/transporter.routes.ts`

---

*Architecture research for: Weelo logistics/trucking broadcast platform — broadcast lifecycle + infrastructure hardening*
*Researched: 2026-02-19*
