# Phase 1: Broadcast Lifecycle Correctness - Research

**Researched:** 2026-02-19
**Domain:** Broadcast state machine correctness, atomic acceptance, idempotent search, race-safe cancel under concurrent load
**Confidence:** HIGH

## Summary

This phase fixes data-corruption-level bugs in the broadcast lifecycle: double-assignment race conditions on the Order path `acceptTruckRequest`, missing one-active-broadcast-per-customer enforcement, absence of server-side idempotent search initiation, and non-atomic cancel that loses the cancel-vs-accept race. The Booking path's `acceptBroadcast` in `broadcast.service.ts` already has the correct pattern (Serializable transaction + `updateMany` optimistic lock + P2034 retry). The Order path's `acceptTruckRequest` in **both** `booking/order.service.ts` AND `order/order.service.ts` does read-check-write without any lock or transaction -- this is the highest-severity bug producing double-assignment data corruption today.

The codebase already has all the building blocks: Prisma 5.22 supports interactive transactions with `isolationLevel: 'Serializable'`, `redisService.acquireLock` uses Lua-based SET NX EX for distributed locking, and the Redis service has `setTimer`/`cancelTimer` backed by a sorted set. No new libraries are needed. The work is applying proven patterns from the Booking path to the Order path, adding missing business rules (one-per-customer, server-generated idempotency), and adding explicit lifecycle states.

**Primary recommendation:** Apply the `broadcast.service.ts` accept pattern (Serializable transaction + `updateMany` optimistic lock + retry loop) to both `booking/order.service.ts:acceptTruckRequest` and `order/order.service.ts:acceptTruckRequest` as the first and highest-priority fix. Then layer one-active-per-customer enforcement, idempotent search, cancel atomicity, and lifecycle states on top.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| BCAST-01 | Broadcast has explicit lifecycle states: Created, Broadcasting, Awaiting Responses, Terminal | Add `broadcastState` field to Booking/Order schemas or use existing status enum extended with new values. Prisma migration required. |
| BCAST-02 | State transitions persisted with timestamps for audit trail | Add `stateChangedAt` or use existing `updatedAt`. Consider adding a `stateHistory` JSON field or separate state transition table. |
| BCAST-03 | Broadcast state visible to customer in real-time via WebSocket | Existing `emitToUser(customerId, ...)` pattern covers this. Add state-change events to existing Socket.IO event catalog. |
| BCAST-04 | Broadcast state visible to transporter in real-time via WebSocket | Existing `emitToUser(transporterId, ...)` pattern covers this. Emit to all notified transporters on state change. |
| BCAST-05 | Terminal broadcasts removed from transporter actionable views | Existing `BOOKING_EXPIRED` event pattern. Extend to cover all terminal states consistently. |
| CUST-01 | Server enforces max one active broadcast per customer | Redis key `customer:active-broadcast:{customerId}` + DB `findFirst` guard. Both paths (Booking + Order) must check. |
| CUST-02 | Customer sees "Request already in progress" message | Return 409 with `ACTIVE_BROADCAST_EXISTS` error code when guard triggers. Error code already exists as `ORDER_ACTIVE_EXISTS`. |
| CUST-03 | Different customers can have concurrent broadcasts | Redis key is per-customer (`customer:active-broadcast:{customerId}`), no cross-customer blocking. DB query is `WHERE customerId = X`. |
| CUST-04 | After terminal state, customer can immediately start new search | Cancel/expire/fully_filled paths must delete the `customer:active-broadcast:{customerId}` key. |
| ACPT-01 | Only one transporter can accept a broadcast (exactly-one-winner) | `updateMany` with `WHERE status = 'searching'` returns `count` -- if 0, someone else won. Pattern exists in `broadcast.service.ts`. |
| ACPT-02 | Concurrent accept: first wins, others get "No longer available" | Same `updateMany` pattern: count === 0 means "already taken". Return 409 `REQUEST_ALREADY_TAKEN`. |
| ACPT-03 | Accept uses atomic DB operation, no read-check-write race | Wrap in `prismaClient.$transaction` with Serializable isolation. Use `updateMany` optimistic lock inside. |
| ACPT-04 | Both Booking and Order path acceptance are atomic | Booking path (`broadcast.service.ts`) already correct. Order path (`booking/order.service.ts` + `order/order.service.ts`) needs fix. |
| IDEM-01 | Double-tap creates only one broadcast | Server-generated idempotency key stored in Redis with TTL. Second request within TTL returns cached broadcast. |
| IDEM-02 | Network retry reuses existing broadcast | Same mechanism as IDEM-01 -- idempotency key dedup returns existing active broadcast. |
| IDEM-03 | Idempotency key is server-generated per search session | Generate key server-side from `customerId + timestamp + vehicleType` hash. Do not rely on client sending key. |
| CNCL-01 | Customer can cancel at any point, even after accept/assignment | `UPDATE WHERE status IN ('active', 'partially_filled') RETURNING *` pattern. If 0 rows updated, the broadcast already reached terminal state. |
| CNCL-02 | Cancel is immediate and absolute | DB update + WebSocket fan-out to all notified transporters + FCM push. Existing pattern in `cancelBooking`. |
| CNCL-05 | Cancel clears all Redis state | `clearBookingTimers` already clears timers + notified set. Must also clear `customer:active-broadcast:{customerId}` and idempotency keys. |
| CNCL-06 | Cancel is idempotent | If booking is already cancelled, return success (not error). Current code throws 400 on already-cancelled -- change to 200 with idempotent response. |
| CNCL-07 | Cancel-vs-accept race: cancel wins | Cancel uses atomic `UPDATE WHERE status IN (active, partially_filled)`. Accept also uses atomic `updateMany WHERE trucksFilled = current`. Whichever commits first locks the row. Cancel must check post-update if accept snuck in; if assignment was created during cancel, revert it. |
</phase_requirements>

## Standard Stack

### Core (Already in Codebase)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Prisma | 5.22.0 | ORM with interactive transactions, Serializable isolation | Already used for accept in `broadcast.service.ts`. Supports `$transaction` with `isolationLevel`. |
| ioredis | 5.9.2 | Redis client for distributed locks, SET NX, sorted sets | Already used throughout. `acquireLock` uses Lua script for atomic SET NX EX. |
| uuid | 9.0.1 | Server-generated idempotency keys | Already used for all ID generation. |
| Socket.IO | 4.7.2 | Real-time state change notifications | Already used. `emitToUser` for targeted delivery. |

### Supporting (Already in Codebase)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| zod | 3.22.4 | Request validation schemas | Validate cancel endpoint input, accept endpoint input |
| winston | 3.11.0 | Structured logging for state transitions | Log every lifecycle transition for audit trail |

### No New Dependencies Required

This phase requires zero new npm packages. All patterns (distributed locks, atomic transactions, idempotency caching, WebSocket notification) are already implemented in the codebase for the Booking path. The work is extending these patterns to the Order path and adding missing business rules.

## Architecture Patterns

### Recommended Changes to Existing Structure

No new files or modules needed. Changes are surgical modifications to existing service files:

```
src/
  modules/
    booking/
      booking.service.ts      # Add one-per-customer guard in createBooking()
                               # Add server-generated idempotency key
                               # Make cancelBooking() atomic with UPDATE WHERE
                               # Clear customer:active-broadcast key on terminal transitions
      order.service.ts         # Fix acceptTruckRequest() with atomic transaction
                               # Add one-per-customer guard in createOrder()
    broadcast/
      broadcast.service.ts     # Already correct accept pattern (reference implementation)
    order/
      order.service.ts         # Fix acceptTruckRequest() with atomic transaction
  core/
    constants/index.ts         # Add new error codes if needed (ACTIVE_BROADCAST_EXISTS already there as ORDER_ACTIVE_EXISTS)
  prisma/
    schema.prisma              # Add broadcastState enum or extend BookingStatus/OrderStatus
                               # Add stateChangedAt timestamp fields
```

### Pattern 1: Atomic Accept via updateMany Optimistic Lock (REFERENCE)

**What:** The `broadcast.service.ts` accept pattern that already works correctly.
**When to use:** Every accept endpoint across Booking and Order paths.
**Source:** `src/modules/broadcast/broadcast.service.ts:508-537`

```typescript
// INSIDE a Serializable transaction:
const bookingUpdate = await tx.booking.updateMany({
  where: {
    id: broadcastId,
    trucksFilled: booking.trucksFilled  // Optimistic lock: fails if changed
  },
  data: {
    trucksFilled: { increment: 1 }
  }
});
if (bookingUpdate.count !== 1) {
  // Someone else modified it -- check why and throw appropriate error
  throw new AppError(409, 'INVALID_ASSIGNMENT_STATE', 'Broadcast state changed. Retry.');
}
```

**Retry loop for P2034:**
```typescript
const MAX_RETRIES = 3;
for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  try {
    result = await prismaClient.$transaction(async (tx) => {
      // ... transaction body
    }, { isolationLevel: 'Serializable' as any });
    break; // Success
  } catch (error: any) {
    if ((error.code === 'P2034' || error.code === '40001') && attempt < MAX_RETRIES) {
      continue; // Retry on serialization failure
    }
    throw error;
  }
}
```

### Pattern 2: One-Active-Per-Customer Guard

**What:** Prevent customer from having two concurrent active broadcasts.
**When to use:** At the top of `createBooking()` and `createOrder()`, before any DB writes.

```typescript
// Step 1: Redis check (fast path, covers 99% of cases)
const activeKey = `customer:active-broadcast:${customerId}`;
const existingBroadcastId = await redisService.get(activeKey);
if (existingBroadcastId) {
  throw new AppError(409, 'ORDER_ACTIVE_EXISTS',
    'Request already in progress. Cancel it first.');
}

// Step 2: Redis lock to prevent TOCTOU race on concurrent requests
const lockKey = `customer-broadcast-create:${customerId}`;
const lock = await redisService.acquireLock(lockKey, customerId, 10);
if (!lock.acquired) {
  throw new AppError(409, 'ORDER_ACTIVE_EXISTS',
    'Request already in progress. Cancel it first.');
}

try {
  // Step 3: DB check (authoritative, catches Redis failures)
  const existingActive = await prismaClient.booking.findFirst({
    where: { customerId, status: { in: ['active', 'partially_filled'] } }
  });
  // Also check orders:
  const existingOrder = await prismaClient.order.findFirst({
    where: { customerId, status: { in: ['active', 'partially_filled'] } }
  });
  if (existingActive || existingOrder) {
    throw new AppError(409, 'ORDER_ACTIVE_EXISTS',
      'Request already in progress. Cancel it first.');
  }

  // ... create booking/order ...

  // Step 4: Set Redis key after successful creation
  await redisService.set(activeKey, bookingId, TIMEOUT_SECONDS + 60);
} finally {
  await redisService.releaseLock(lockKey, customerId);
}
```

### Pattern 3: Server-Generated Idempotency Key

**What:** Server generates a deterministic idempotency key so double-taps are caught without client cooperation.
**When to use:** In `createBooking()` and `createOrder()`.

```typescript
// Server generates key from request fingerprint
const idempotencyFingerprint = `${customerId}:${vehicleType}:${vehicleSubtype}:${JSON.stringify(pickup)}:${JSON.stringify(drop)}`;
const idempotencyKey = crypto.createHash('sha256').update(idempotencyFingerprint).digest('hex').substring(0, 16);

const dedupeKey = `idem:broadcast:create:${customerId}:${idempotencyKey}`;
const existing = await redisService.get(dedupeKey);
if (existing) {
  // Return cached broadcast (same as existing pattern)
  const existingBooking = await db.getBookingById(existing);
  if (existingBooking && !['cancelled', 'expired'].includes(existingBooking.status)) {
    return existingBooking; // Idempotent replay
  }
}

// ... create broadcast ...

// Store with TTL matching broadcast timeout + buffer
await redisService.set(dedupeKey, newBookingId, TIMEOUT_SECONDS + 30);
```

### Pattern 4: Atomic Cancel with UPDATE WHERE

**What:** Cancel uses a single atomic UPDATE with status filter, preventing race with accept.
**When to use:** `cancelBooking()` and `cancelOrder()`.

```typescript
// Atomic: only succeeds if status is still cancellable
const updated = await prismaClient.booking.updateMany({
  where: {
    id: bookingId,
    customerId,  // Ownership check
    status: { in: ['active', 'partially_filled'] }
  },
  data: {
    status: 'cancelled'
  }
});

if (updated.count === 0) {
  // Check why: already cancelled (idempotent) or terminal state
  const current = await prismaClient.booking.findUnique({ where: { id: bookingId } });
  if (current?.status === 'cancelled') {
    return current; // Idempotent: already cancelled, return success
  }
  // Otherwise it was accepted/expired/completed -- cancel came too late
  throw new AppError(409, 'BOOKING_CANNOT_CANCEL', 'Booking is no longer cancellable');
}
```

### Anti-Patterns to Avoid

- **Read-check-write without lock or transaction (THE BUG):** Reading `status === 'searching'`, doing validation, then calling `db.updateTruckRequest()` without any atomicity guarantee. This is the exact bug in `booking/order.service.ts:690-731` and `order/order.service.ts:1336-1388`. Two concurrent requests both pass the status check.

- **Client-supplied idempotency keys:** The current `createBooking()` accepts an optional `idempotencyKey` from the client. If the client does not send one (or sends two different keys for the same intent), duplicates are created. Server-generated keys eliminate this gap.

- **Returning errors on idempotent cancel:** Current `cancelBooking()` throws 400 if already cancelled. An idempotent cancel should return 200 for an already-cancelled booking.

- **Separate DB update and status check for cancel:** Current `cancelBooking()` reads the booking, checks status in application code, then updates. Between read and update, an accept can modify the status.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Atomic accept | Application-level status check + separate update | `prismaClient.$transaction` with Serializable isolation + `updateMany` optimistic lock | Already proven in `broadcast.service.ts`. Two concurrent requests will both pass an application-level check. |
| Distributed lock for one-per-customer | Custom mutex / file lock / in-memory lock | `redisService.acquireLock` (Lua NX EX) | Already implemented with proper owner verification and TTL. Works across ECS instances. |
| Idempotency dedup | Custom in-memory map | Redis SET with TTL | In-memory maps are per-process and lost on restart. Redis survives deployments. |
| Retry on serialization failure | Manual polling/sleep | For-loop with P2034 catch (already in `broadcast.service.ts`) | Prisma documents this exact pattern. 3 retries is sufficient for current load. |

**Key insight:** Every pattern needed for this phase already exists in the codebase. The work is applying `broadcast.service.ts`'s accept pattern to the Order path, and adding the one-per-customer + idempotency + atomic cancel guards that are currently missing.

## Common Pitfalls

### Pitfall 1: Double-Assignment via Order Path acceptTruckRequest

**What goes wrong:** Two transporters accept the same TruckRequest simultaneously. Both read `status === 'searching'`, both pass validation, both call `db.updateTruckRequest(requestId, { status: 'assigned' })`. The second write silently overwrites. Both receive ACCEPT_CONFIRMATION. Customer gets two drivers for one truck slot.

**Why it happens:** `booking/order.service.ts:690-731` and `order/order.service.ts:1336-1388` do a non-atomic read-check-write. No distributed lock, no transaction, no WHERE clause guard on the update.

**How to avoid:** Wrap the entire accept flow in a Prisma Serializable transaction with `updateMany({ where: { id, status: 'searching' } })` as an optimistic lock. If `count === 0`, someone else won.

**Warning signs:** Two `ACCEPT_CONFIRMATION` WebSocket events for the same `requestId` within milliseconds. `assignedTransporterId` field changes twice for the same request.

### Pitfall 2: One-Per-Customer Race on Concurrent Create

**What goes wrong:** Customer taps Search twice quickly. Both requests pass the (currently nonexistent) active-broadcast check because neither has committed yet. Two active broadcasts created, two sets of transporters notified, duplicate broadcasts in transporter feed.

**Why it happens:** No enforcement exists today. The idempotency key is optional and client-supplied. Even with a server-side DB check, two concurrent requests can both read "no active broadcast" before either commits.

**How to avoid:** Redis distributed lock on `customer-broadcast-create:{customerId}` covering the critical section from check through create. Combined with DB findFirst as authoritative fallback.

**Warning signs:** Multiple rows in bookings/orders table with `status='active'` for the same `customerId`. Transporters seeing duplicate broadcast cards.

### Pitfall 3: Cancel-vs-Accept Race Produces Inconsistent State

**What goes wrong:** Customer cancels while transporter accepts at the same moment. Current cancel does `read booking -> check status -> update to cancelled`. Accept does `read booking -> check status -> update trucksFilled`. If accept commits between cancel's read and update, the booking gets cancelled AFTER an assignment was created. The transporter has a confirmed assignment pointing to a cancelled booking.

**Why it happens:** Neither cancel nor accept uses an atomic UPDATE WHERE to enforce preconditions at write time.

**How to avoid:** Cancel must use `UPDATE WHERE status IN ('active', 'partially_filled')` -- if 0 rows updated, the accept already won. Conversely, accept's Serializable transaction will fail if cancel already changed the status. The key is that whichever commits first wins, and the loser gets a clean error.

**Warning signs:** Assignments with `status = 'pending'` pointing to bookings with `status = 'cancelled'`. Transporter sees "Accepted" but customer sees "Cancelled".

### Pitfall 4: Prisma updateMany Does Not Return the Updated Record

**What goes wrong:** Developer tries to use `updateMany` to get back the updated row data for the cancel response. `updateMany` only returns `{ count: number }`, not the updated record.

**Why it happens:** Prisma's `updateMany` returns `BatchPayload` (count only), unlike `update` which returns the full record.

**How to avoid:** After `updateMany` confirms count > 0, do a separate `findUnique` to get the updated record for the response. Or use `update` with a WHERE filter that includes status (but note that `update` requires the unique identifier, not arbitrary WHERE clauses -- so `updateMany` + `findUnique` is the pattern).

**Warning signs:** TypeScript compilation error on trying to access `.id` or other fields on the `updateMany` result.

### Pitfall 5: Two Separate acceptTruckRequest Functions

**What goes wrong:** Developer fixes the race condition in `booking/order.service.ts:acceptTruckRequest` but forgets about `order/order.service.ts:acceptTruckRequest`. The bug persists on the other code path.

**Why it happens:** The codebase has TWO order services with independent `acceptTruckRequest` implementations: `src/modules/booking/order.service.ts` (975 lines, called from `booking.routes.ts:391`) and `src/modules/order/order.service.ts` (1558 lines, called from `order.routes.ts:498`). Both have the exact same read-check-write race condition.

**How to avoid:** Both must be fixed. Consider extracting the atomic accept logic into a shared function or having one call the other.

**Warning signs:** After fixing one path, integration tests on the other path still show double-assignment.

### Pitfall 6: Redis Key Cleanup Missing on Terminal State

**What goes wrong:** Customer's broadcast expires or gets fully filled, but `customer:active-broadcast:{customerId}` Redis key is not deleted. Customer is blocked from creating new broadcasts even though their previous one is terminal.

**Why it happens:** The Redis key cleanup is added to `cancelBooking()` but forgotten in `handleBookingTimeout()`, `incrementTrucksFilled()` (when fully_filled), or the Order equivalent paths.

**How to avoid:** Every terminal state transition must clear the customer active-broadcast key. Create a shared helper: `clearCustomerActiveBroadcastKey(customerId)` and call it from ALL terminal paths: cancel, expire, fully_filled.

**Warning signs:** Customer cannot create new search after previous one expired. Redis `GET customer:active-broadcast:{customerId}` returns a booking ID that is already in terminal state.

## Code Examples

### Example 1: Fixed acceptTruckRequest for Order Path

Source: Pattern from `broadcast.service.ts:404-605`, adapted for TruckRequest model.

```typescript
async acceptTruckRequest(
  requestId: string,
  transporterId: string,
  vehicleId: string,
  driverId: string
): Promise<{ success: boolean; assignmentId?: string; tripId?: string; message: string }> {
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await prismaClient.$transaction(async (tx) => {
        // Read inside transaction
        const request = await tx.truckRequest.findUnique({ where: { id: requestId } });
        if (!request || request.status !== 'searching') {
          return { success: false, message: 'Request no longer available' };
        }

        // Validate vehicle, driver, transporter (all reads inside tx)
        const vehicle = await tx.vehicle.findUnique({ where: { id: vehicleId } });
        if (!vehicle || vehicle.transporterId !== transporterId) {
          return { success: false, message: 'Vehicle not eligible' };
        }

        // Atomic status transition: only succeeds if still 'searching'
        const updated = await tx.truckRequest.updateMany({
          where: { id: requestId, status: 'searching' },
          data: {
            status: 'assigned',
            assignedTransporterId: transporterId,
            assignedVehicleId: vehicleId,
            assignedDriverId: driverId,
            tripId: uuidv4(),
            assignedAt: new Date().toISOString()
          }
        });

        if (updated.count === 0) {
          return { success: false, message: 'Request was just taken by another transporter' };
        }

        // Create assignment, update order progress...
        // (rest of the logic inside the transaction)

        return { success: true, assignmentId, tripId, message: 'Accepted' };
      }, { isolationLevel: 'Serializable' as any });

      return result;
    } catch (error: any) {
      if ((error.code === 'P2034' || error.code === '40001') && attempt < MAX_RETRIES) {
        continue;
      }
      throw error;
    }
  }

  return { success: false, message: 'Unable to process after retries' };
}
```

### Example 2: Idempotent Cancel

```typescript
async cancelBooking(bookingId: string, customerId: string): Promise<BookingRecord> {
  // Atomic cancel: only succeeds if status is cancellable
  const updated = await prismaClient.booking.updateMany({
    where: {
      id: bookingId,
      customerId,
      status: { in: ['active', 'partially_filled'] }
    },
    data: { status: 'cancelled' }
  });

  // Fetch current state regardless
  const booking = await prismaClient.booking.findUnique({ where: { id: bookingId } });
  if (!booking) {
    throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
  }

  if (booking.customerId !== customerId) {
    throw new AppError(403, 'FORBIDDEN', 'Not your booking');
  }

  // Idempotent: already cancelled is success
  if (updated.count === 0 && booking.status === 'cancelled') {
    return booking; // Already cancelled, idempotent success
  }

  if (updated.count === 0) {
    // Status was not cancellable (completed, expired, fully_filled)
    throw new AppError(409, 'BOOKING_CANNOT_CANCEL',
      `Cannot cancel booking in ${booking.status} state`);
  }

  // Cleanup: timers, Redis keys, notifications
  await this.clearBookingTimers(bookingId);
  await redisService.del(`customer:active-broadcast:${customerId}`).catch(() => {});

  // Notify transporters...
  // (existing notification logic)

  return booking;
}
```

### Example 3: Server-Generated Idempotency Key

```typescript
import crypto from 'crypto';

function generateSearchIdempotencyKey(
  customerId: string,
  vehicleType: string,
  vehicleSubtype: string,
  pickupLat: number,
  pickupLng: number,
  dropLat: number,
  dropLng: number
): string {
  // Round coordinates to prevent floating-point differences from creating different keys
  const roundedPickupLat = Math.round(pickupLat * 1000) / 1000;
  const roundedPickupLng = Math.round(pickupLng * 1000) / 1000;
  const roundedDropLat = Math.round(dropLat * 1000) / 1000;
  const roundedDropLng = Math.round(dropLng * 1000) / 1000;

  const fingerprint = `${customerId}:${vehicleType}:${vehicleSubtype}:${roundedPickupLat}:${roundedPickupLng}:${roundedDropLat}:${roundedDropLng}`;
  return crypto.createHash('sha256').update(fingerprint).digest('hex').substring(0, 16);
}
```

## State of the Art

| Old Approach (Current Bug) | Current Approach (Fix) | Where Changed | Impact |
|---------------------------|----------------------|---------------|--------|
| Read status, validate in app, then update (Order path) | Serializable transaction + `updateMany` optimistic lock (Booking path pattern) | `booking/order.service.ts`, `order/order.service.ts` | Eliminates double-assignment race condition |
| Client-optional idempotency key | Server-generated idempotency key from request fingerprint | `booking.service.ts:createBooking`, `order.service.ts:createOrder` | Prevents duplicate broadcasts regardless of client behavior |
| No one-per-customer check | Redis lock + DB findFirst guard | Both create paths | Prevents parallel broadcasts per customer |
| Non-atomic cancel (read-check-update) | `updateMany WHERE status IN (active, partially_filled)` | `cancelBooking`, `cancelOrder` | Cancel-vs-accept race resolved atomically |
| Cancel throws on already-cancelled | Return success for already-cancelled (idempotent) | `cancelBooking`, `cancelOrder` | Multiple cancel requests all succeed without error |

## Prisma Transaction Details

**Prisma version:** 5.22.0 (confirmed in `package.json`)

**Interactive transactions with isolation level:** Supported since Prisma 4.4.0. The codebase already uses this at `broadcast.service.ts:588`:
```typescript
}, { isolationLevel: 'Serializable' as any });
```

**P2034 retry pattern:** Already implemented in `broadcast.service.ts:590-604`. The codebase catches both `P2034` (Prisma error) and `40001` (PostgreSQL serialization failure SQLSTATE). 3 retries is the current setting.

**updateMany behavior:** Returns `{ count: number }` (BatchPayload). Does NOT return the updated record. Use `findUnique` after count > 0 to get the updated row if needed.

**Key constraint:** `updateMany` does NOT support `include` or `select` -- it is a batch operation. For the accept flow, the assignment creation and other writes happen inside the same transaction, so the data is available without a separate read.

## Redis Key Namespace (New Keys for This Phase)

| Key Pattern | Owner | Purpose | TTL |
|-------------|-------|---------|-----|
| `customer:active-broadcast:{customerId}` | booking.service.ts, order.service.ts | One-per-customer enforcement | Broadcast timeout + 60s buffer |
| `lock:customer-broadcast-create:{customerId}` | booking.service.ts, order.service.ts | Distributed lock for create critical section | 10s |
| `idem:broadcast:create:{customerId}:{hash}` | booking.service.ts, order.service.ts | Server-generated idempotency dedup | Broadcast timeout + 30s buffer |

**Existing keys that need cleanup on terminal transitions:**
- `customer:active-broadcast:{customerId}` -- must be deleted
- `idempotency:booking:{customerId}:*` -- existing, already cleaned
- `broadcast:notified:{bookingId}` -- existing, already cleaned
- `timer:booking:{bookingId}` -- existing, already cleaned
- `timer:radius:{bookingId}` -- existing, already cleaned
- `broadcast:radius:step:{bookingId}` -- existing, already cleaned

## Database Schema Changes

### Option A: Extend Existing Enums (Recommended)

Add new values to the Prisma `BookingStatus` and `OrderStatus` enums:

```prisma
enum BookingStatus {
  created          // NEW: Initial state before broadcasting
  broadcasting     // NEW: Actively sending to transporters
  active           // Existing: Awaiting responses (rename semantics)
  partially_filled // Existing: Some trucks assigned
  fully_filled     // Existing: All trucks assigned
  in_progress      // Existing: Trip started
  completed        // Existing: Trip completed
  cancelled        // Existing: Cancelled by customer
  expired          // Existing: No transporter accepted in time
}
```

**Migration approach:** Add new enum values via Prisma migration. Existing rows with `active` status remain valid. New broadcasts start as `created`, transition to `broadcasting` (after transporters notified), then to `active` (awaiting responses). The state machine is:

```
created -> broadcasting -> active -> partially_filled -> fully_filled -> completed
                           |                |                |
                           v                v                v
                        cancelled        cancelled        in_progress -> completed
                           |                |
                           v                v
                        expired          expired
```

### Option B: Add Separate broadcastState Field

Add a dedicated field to track broadcast-specific lifecycle separately from the booking/order status:

```prisma
model Booking {
  // ... existing fields ...
  broadcastState  String?  // 'created' | 'broadcasting' | 'awaiting' | null
  stateChangedAt  DateTime? // Timestamp of last state change
}
```

This is less disruptive to existing code but adds a second state field to track.

**Recommendation:** Option A is cleaner. The new enum values (`created`, `broadcasting`) are additive and backward-compatible with existing queries that check for `active`, `partially_filled`, etc.

## Open Questions

1. **Which acceptTruckRequest should be the canonical one?**
   - There are two: `booking/order.service.ts:680` and `order/order.service.ts:1325`
   - Both are called from different routes
   - What we know: Both have the same race condition bug
   - What's unclear: Whether they should be consolidated into one or kept separate
   - Recommendation: Fix both with the same atomic pattern. If routes allow, consolidate into one shared implementation later. For now, fix independently to minimize blast radius.

2. **Should cancel-wins-over-accept be enforced with cancel having higher DB priority?**
   - What we know: CNCL-07 says cancel should win over accept in a race
   - What's unclear: The strict ordering guarantee at the DB level
   - Recommendation: Both use atomic UPDATE WHERE. Cancel checks `status IN (active, partially_filled)`. Accept checks `trucksFilled = current_value`. If cancel commits first, accept's `updateMany` will return count 0 (status changed). If accept commits first, cancel's `updateMany` returns count 0 (but booking is now `partially_filled` or `fully_filled`). To enforce cancel-wins, cancel should also check for assignments created in the same window and revert them. Implementation: after cancel succeeds, query for assignments created in the last 5 seconds and mark them cancelled.

3. **Lifecycle state persistence: enum extension or separate field?**
   - What we know: BCAST-01 and BCAST-02 require explicit states with timestamps
   - Recommendation: Extend existing enums (Option A above). Simpler, less code change, and the states map naturally to the existing status field semantics.

## Sources

### Primary (HIGH confidence)
- Direct codebase analysis: `src/modules/broadcast/broadcast.service.ts` -- reference implementation for atomic accept
- Direct codebase analysis: `src/modules/booking/order.service.ts:680-731` -- buggy read-check-write accept
- Direct codebase analysis: `src/modules/order/order.service.ts:1325-1428` -- second buggy accept
- Direct codebase analysis: `src/modules/booking/booking.service.ts:222-461` -- createBooking with idempotency
- Direct codebase analysis: `src/modules/booking/booking.service.ts:1045-1141` -- cancelBooking with cleanup
- Direct codebase analysis: `src/shared/services/redis.service.ts:1631-1701` -- distributed lock implementation
- Direct codebase analysis: `prisma/schema.prisma` -- current enum definitions and model structure
- [Prisma Transactions Documentation](https://www.prisma.io/docs/orm/prisma-client/queries/transactions) -- interactive transactions, isolation levels, P2034 retry

### Secondary (MEDIUM confidence)
- [Prisma GitHub Discussion #24993](https://github.com/prisma/prisma/discussions/24993) -- optimistic concurrency alternatives
- [Redis Distributed Locks](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/) -- SET NX pattern
- [Redis Idempotency Patterns](https://redis.io/blog/what-is-idempotency-in-redis/) -- dedup with SET NX + TTL

### Tertiary (LOW confidence)
- [PostgreSQL UPDATE atomicity thread](https://postgrespro.com/list/thread-id/1500285) -- UPDATE RETURNING atomicity at READ COMMITTED level

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- zero new dependencies, all patterns already in codebase
- Architecture: HIGH -- changes are surgical fixes to existing code, not new architecture
- Pitfalls: HIGH -- bugs are confirmed by direct code inspection, not theoretical
- Database changes: MEDIUM -- enum extension is well-understood but migration needs careful testing

**Research date:** 2026-02-19
**Valid until:** 2026-03-19 (stable domain, no external dependency changes expected)
