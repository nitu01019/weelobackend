# Codebase Concerns

**Analysis Date:** 2026-02-19

## Tech Debt

### Stub Implementations (Customer Module)

**Issue:** Multiple customer-facing features return placeholder data instead of real implementations.

**Files:**
- `src/modules/customer/customer.service.ts` (lines 51, 110, 139)

**Impact:**
- Wallet balance always returns 0 with `_stub: true` flag
- Customer settings are not persisted to database
- updateSettings() logs warning but does not save changes
- Clients marked with `_stub: true` may not display properly or cause confusion

**Fix approach:**
1. Design wallet schema in Prisma (balance, currency, transactions)
2. Implement CustomerSettings model with proper persistence
3. Update getWallet(), getSettings(), updateSettings() to use database
4. Remove `_stub` flags once real implementation is in place
5. Add wallet transaction logging for audit trail

**Priority:** Medium - affects customer functionality but not core booking flow

---

### Fire-and-Forget Socket Emissions

**Issue:** Socket.io `emit()` calls are not awaited but failures are silently ignored.

**Files:**
- `src/modules/broadcast/broadcast.service.ts` (lines 667, 707-708, 983-984, 1022-1023, 1046)
- `src/shared/services/socket.service.ts` (multiple emit calls throughout)

**Pattern:**
```typescript
// Line 667-668 in broadcast.service.ts
emitToUser(driverId, 'trip_assigned', driverNotification);
sendPushNotification(driverId, {...}).catch(err => {...});  // Only FCM has catch
```

**Impact:**
- Socket emissions that fail are never logged or retried
- Real-time updates may not reach clients if socket is disconnected
- No visibility into delivery failures
- Customers may not see truck confirmations, drivers may not see trip assignments

**Fix approach:**
1. Make emitToUser/emitToRoom return Promises
2. Wrap socket emissions in try-catch with logging
3. Implement retry logic with exponential backoff for critical emissions
4. Add metrics tracking for failed emissions
5. For non-critical events, implement fire-and-forget pattern explicitly

**Priority:** High - affects real-time notification reliability

---

### Missing Error Handling on Database Operations

**Issue:** Many database operations in broadcast and order modules use generic Error throws instead of typed AppError.

**Files:**
- `src/modules/order/order.service.ts` (line 571)
- `src/modules/broadcast/broadcast.service.ts` (line 574+)

**Example:**
```typescript
// Line 571 in order.service.ts
throw new Error('Either routePoints OR both pickup and drop must be provided');
// TODO: Replace with ValidationError when imported
```

**Impact:**
- Inconsistent error responses to API clients
- No error codes for monitoring/alerting
- Clients cannot distinguish between validation errors, server errors, and resource not found
- Generic Error objects don't include proper HTTP status codes

**Fix approach:**
1. Import and use AppError from `src/shared/types/error.types`
2. Replace all generic Error throws with AppError variants
3. Add proper error codes (VALIDATION_ERROR, NOT_FOUND, etc.)
4. Include context in error messages for debugging

**Priority:** Medium - affects error reporting and client error handling

---

## Known Bugs

### Unchecked Optional Properties in Socket Handler

**Issue:** Socket event handlers access optional properties without null checks.

**Files:**
- `src/shared/services/socket.service.ts` (line 545)

**Code:**
```typescript
io.sockets.sockets.forEach((socket: any) => {
  // socket might not have expected properties
});
```

**Problem:**
- Typing as `any` bypasses null checks
- forEach on socket collection could fail if socket is undefined
- No validation that socket has expected properties

**Impact:** Potential crashes when iterating socket connections

**Fix approach:**
1. Remove `any` type, use proper Socket type
2. Add null/undefined checks before accessing socket properties
3. Add try-catch around the forEach loop

---

### Race Condition in Order Expiry

**Issue:** Order expiry check doesn't atomically mark as expired before checking.

**Files:**
- `src/modules/broadcast/broadcast.service.ts` (lines 891-910)

**Pattern:**
```typescript
// Lines 898-907
for (const booking of allBookings) {
  if (booking.status === 'active') {
    const expiresAt = new Date(booking.expiresAt);
    if (expiresAt < now) {
      await db.updateBooking(booking.id, { status: 'expired' });  // Non-atomic
    }
  }
}
```

**Problem:**
- Between reading expiry time and updating status, concurrent requests could process same booking
- Multiple workers/instances could try to expire same booking simultaneously
- No distributed lock to prevent concurrent expiry

**Impact:**
- Duplicate notifications sent to customers/drivers
- Inconsistent state if one expiry succeeds and another fails
- Resource waste on duplicate processing

**Fix approach:**
1. Use distributed lock via Redis (redisService.acquireLock)
2. Implement atomic check-and-update pattern
3. Add idempotency key to prevent duplicate processing
4. Use database transaction with SELECT FOR UPDATE

**Priority:** High - affects booking lifecycle consistency at scale

---

### Missing Await on Database Calls (Historical)

**Issue:** Previous version had missing `await` keywords on async DB calls. While likely fixed, needs verification.

**Files:**
- `src/shared/database/prisma.service.ts` (auto-expiry logic)

**Pattern from ORDER_LIFECYCLE_FIX_COMPLETE.md:**
```typescript
// BEFORE (BROKEN):
const order = db.getOrderById(orderId);  // Missing await!
```

**Status:** Supposedly fixed but should verify all auto-expiry code paths have proper await.

**Fix approach:**
1. Grep for `db\.\w+\(` without `await`
2. Lint rule to catch missing awaits on async functions
3. Add TypeScript strict mode to catch Promise types not being awaited

**Priority:** Critical if unfixed - causes database inconsistency

---

## Security Considerations

### Debug Logging in Driver Auth

**Issue:** Debug log at line 160-161 logs phone numbers to identify issues.

**Files:**
- `src/modules/driver-auth/driver-auth.service.ts` (lines 160-161)

**Code:**
```typescript
// DEBUG: Log actual phone numbers to identify the issue
logger.info('[DRIVER AUTH DEBUG] Phone numbers check', {
  driverPhone: driverPhone,
  transporterPhone: transporterPhone
});
```

**Risk:** Phone numbers are personally identifiable information (PII). If logs are stored without encryption or access control, this could expose customer contact data.

**Current Mitigation:** Logger service has masking, but explicit phone logging overrides it.

**Recommendations:**
1. Remove debug logging of raw phone numbers
2. Use maskForLogging() utility already available in crypto.utils.ts
3. Log only last 2 digits: `+91XXXXXXXX${phone.slice(-2)}`
4. Add review of all PII logging in request/response handlers

---

### Sensitive Parameter Masking

**Issue:** Request logger masks sensitive params but coverage may be incomplete.

**Files:**
- `src/shared/middleware/request-logger.middleware.ts` (lines with SENSITIVE_PARAMS)

**Current Coverage:**
```typescript
const SENSITIVE_PARAMS = ['token', 'key', 'secret', 'password', 'otp'];
```

**Gaps:**
- Phone numbers not masked (high PII value)
- Email addresses not masked
- Financial data (prices, wallet balance) not masked
- Custom header tokens may not be caught

**Recommendations:**
1. Expand SENSITIVE_PARAMS to include: phone, email, aadhar, license, pan
2. Review all auth headers (JWT tokens in Authorization header)
3. Test masking with actual request payloads from captain app
4. Consider per-field masking depth (first X chars vs last X chars)

---

### Missing Input Validation on Socket Events

**Issue:** Socket event handlers don't validate incoming data before processing.

**Files:**
- `src/shared/services/socket.service.ts` (throughout)

**Risk:**
- Malformed location data could corrupt tracking records
- Oversized payloads could cause memory issues
- Invalid role/userId could grant unauthorized access

**Recommendations:**
1. Add Zod schema validation for all socket event payloads
2. Sanitize coordinate values (lat/lng ranges: ±90, ±180)
3. Add maximum payload size limits
4. Validate userId matches authenticated token

---

## Performance Bottlenecks

### O(n) Broadcast Expiry Scan

**Issue:** Checking all bookings for expiry every 5 seconds is O(n) complexity.

**Files:**
- `src/modules/broadcast/broadcast.service.ts` (lines 891-910)

**Current Approach:**
```typescript
const allBookings = await db.getAllBookings();
for (const booking of allBookings) {  // Loops through ALL bookings
  if (expiresAt < now) {
    // expire it
  }
}
```

**Problem:**
- With 1M active bookings, this does 1M comparisons every 5 seconds
- Full table scans are expensive even with indexes
- No pagination or cursor support

**Current Capacity:** Works fine for <100k concurrent bookings. Degrades at scale.

**Improvement Path:**
1. Use Redis sorted set with expiry times as scores
2. Use ZRANGEBYSCORE to get only expired items in O(log n)
3. Implement pagination in DB query: WHERE expiresAt < now LIMIT 1000
4. Use database index on expiresAt column (already should exist)
5. Consider partition/sharding by date (today's bookings in separate key)

**Priority:** Medium - acceptable now, critical at 10x scale

---

### Socket.io Memory Leak Risk

**Issue:** userSockets Map and socketUsers Map grow without bounds if clients don't disconnect cleanly.

**Files:**
- `src/shared/services/socket.service.ts` (lines 49-50)

**Current Safeguard:** MAX_CONNECTIONS_PER_USER = 5 prevents single user from consuming unlimited sockets.

**Gap:** If socket 'disconnect' event is missed (network failure, proxy timeout), entries remain in Map.

**Impact:**
- Memory usage grows with stale socket references
- Eventually could cause out-of-memory crashes
- Affects broadcast to non-existent sockets

**Fix Approach:**
1. Add periodic cleanup job (every 5 min) to remove stale entries
2. Compare userSockets keys against actual connected socketIds
3. Add Max length guard: if (userSockets.size > MAX_USERS_EXPECTED) clear oldest entries
4. Log stale socket removal for debugging

**Priority:** Medium - becomes critical at 100k+ concurrent connections

---

## Fragile Areas

### Broadcast Service (High Complexity)

**Files:** `src/modules/broadcast/broadcast.service.ts` (1,139 lines)

**Why Fragile:**
- 1,139 lines in single file - hard to reason about
- Multiple state transitions (searching → held → assigned → accepted → in_progress → completed)
- Complex lock management with Redis acquireLock/releaseLock
- Distributed idempotency via Redis cache
- Multiple notification paths (socket, FCM, SMS)
- Transactional updates across multiple tables (broadcasts, assignments, vehicles)

**Safe Modification:**
1. Add comprehensive logging at each state transition
2. Always write unit tests before modifying transaction logic
3. Test both happy path and error cases (Redis down, DB transaction fails, etc.)
4. Use distributed tracing to follow request through state machine
5. Review lock timeouts - 8 seconds may be too long for high-volume scenarios

**Test Coverage:** Only 2 test files total in repo. Broadcast has no specific test file.

---

### Order Service (Complex Multi-Type System)

**Files:** `src/modules/order/order.service.ts` (1,558 lines)

**Why Fragile:**
- Handles multi-vehicle type orders (tipper + container + open)
- Creates separate TruckRequest for each vehicle type
- Broadcast filtering depends on exact vehicle type matching
- Price calculation for multiple types
- Cache invalidation across multiple keys

**Safe Modification:**
1. Test with all 3 vehicle types, multiple quantities
2. Verify cache invalidation: TRANSPORTERS_BY_VEHICLE, ORDER, ACTIVE_REQUESTS
3. Check broadcast filtering still matches correct transporters
4. Add integration test for complete order lifecycle

**Test Coverage:** None. High risk for regressions.

---

### Redis Service (Large Surface Area)

**Files:** `src/shared/services/redis.service.ts` (1,801 lines)

**Why Fragile:**
- Handles geospatial queries, sets, hashes, pub/sub, distributed locks
- Fallback to in-memory storage when Redis unavailable (masks failures)
- Connection pooling with reconnection logic
- Pipeline operations with rollback
- Complex type conversions

**Safe Modification:**
1. Test with actual Redis connection failures
2. Verify in-memory fallback still works correctly
3. Check pool size doesn't exceed configured max
4. Test geospatial commands with edge cases (0,0 coordinates, null results)

**Test Coverage:** None. Critical service has no tests.

---

## Scaling Limits

### Redis Connection Pool

**Current:** Max 50 connections (line 59 of redis.service.ts)

**Capacity:** Suitable for ~100k concurrent users with connection pooling

**Limit:** At 500k+ concurrent users, 50 connections becomes bottleneck

**Scaling Path:**
1. Increase pool size to 100-200 for medium scaling
2. Implement connection sharding: separate Redis instances for different key patterns
3. Use Redis Cluster for horizontal scaling
4. Monitor connection utilization with metrics

---

### Database Concurrency

**Current:** Prisma default connection pool (typically 10 connections)

**Capacity:** ~100 concurrent queries

**Limit:** High-traffic endpoints may queue requests

**Improvement:**
1. Increase datasource connection pool in prisma schema: `connectionLimit = 20`
2. Implement query queue/backpressure
3. Use read replicas for SELECT-heavy endpoints
4. Consider read-write splitting

---

### In-Memory Database Fallback (Development)

**Issue:** When Redis is unavailable, app falls back to in-memory storage (maps/arrays).

**Files:** `src/shared/services/redis.service.ts` (fallback implementation)

**Limit:**
- Single process memory only
- No persistence
- Lost on restart
- Cannot scale horizontally

**Risk:** If deployment uses in-memory fallback in production, data loss is guaranteed at any restart.

**Recommendation:**
1. Make Redis mandatory in production (fail fast if unavailable)
2. Use fallback only in development/testing
3. Add environment check: require Redis in NODE_ENV=production

---

## Dependencies at Risk

### Firebase Admin SDK (Soft Dependency)

**Risk:** Dynamic import pattern could fail silently.

**Files:** `src/shared/services/fcm.service.ts` (line 14, dynamic import)

**Pattern:**
```typescript
// Dynamic import of firebase-admin (optional dependency)
// Falls back to no-op if not installed
```

**Impact:**
- If firebase-admin is missing in production, push notifications silently fail
- No error during build/deploy
- Discovered only when first notification attempt fails

**Migration Plan:**
1. Make firebase-admin a required dependency (move from optional to regular dependencies)
2. Fail fast during server startup if FCM config is invalid
3. Add health check endpoint that validates FCM connectivity

---

### Socket.io Version

**Current:** ^4.7.2 (package.json)

**Risk:** Major version upgrades have breaking changes

**Recommendation:**
1. Pin to exact version or narrow range: ~4.7.2
2. Test thoroughly before upgrading major versions
3. Keep up with security patches in 4.x series

---

## Missing Critical Features

### Database Migration System

**Issue:** Only 1 migration file exists (add_indexes.sql), no migration tooling.

**Files:**
- `prisma/migrations/` (only 1 directory)
- `prisma/schema.prisma` (single source of truth)

**Problem:**
- No schema versioning
- add_indexes.sql is raw SQL, not tracked by Prisma
- Rolling back schema changes requires manual work
- Multi-environment deployments (staging/prod) have no rollback plan

**Recommendation:**
1. Move all migrations through Prisma: `prisma migrate dev`
2. Version schema in git
3. Test migration up/down on every change
4. Document migration process for team
5. Use `prisma migrate deploy` in CI/CD

---

### Automated Testing

**Issue:** Only 2 test files for entire codebase.

**Files:**
- `src/__tests__/health.test.ts` (basic health check)
- `src/__tests__/transporter-availability-toggle.test.ts` (single feature)

**Coverage Gaps:**
- No API contract tests
- No broadcast lifecycle tests
- No order state machine tests
- No auth flow tests
- No error handling tests

**Impact:**
- Regressions go undetected
- Refactoring is risky
- New developer confidence is low

**Priority Plan:**
1. Add API contract tests for all endpoints (medium effort, high value)
2. Add broadcast state machine tests (high effort, critical)
3. Add auth flow tests including edge cases
4. Add error scenario tests (network failures, timeouts)
5. Aim for >80% coverage on critical paths

---

### Input Validation Schema Documentation

**Issue:** Zod schemas are inline in routes, not documented or centralized.

**Files:**
- `src/modules/order/order.routes.ts` (inline schemas)
- `src/shared/utils/validation.utils.ts` (some shared schemas)

**Gap:**
- No clear "source of truth" for API request/response format
- Schema changes not documented
- Difficult for frontend teams to understand payload requirements

**Recommendation:**
1. Centralize validation schemas in `src/shared/schemas/` directory
2. Generate OpenAPI/Swagger docs from schemas
3. Document required vs optional fields
4. Version schemas for API versioning

---

## Test Coverage Gaps

### Order Service

**What's Not Tested:**
- Multi-type order creation (tipper + container + open)
- Truck request status transitions
- Price calculation across multiple vehicle types
- Order expiry and auto-cleanup
- Concurrent order operations (idempotency)

**Files:** `src/modules/order/order.service.ts` (1,558 lines, 0 tests)

**Risk:** Breaking changes could go undetected. Production order failures uncovered by users.

**Priority:** Critical

---

### Broadcast Service

**What's Not Tested:**
- Broadcast state machine (searching → held → assigned → completed)
- Distributed lock acquisition/release
- Idempotency cache behavior
- Driver-to-transporter-to-customer notification flow
- Broadcast expiry notifications
- Race conditions in concurrent accepts

**Files:** `src/modules/broadcast/broadcast.service.ts` (1,139 lines, 0 tests)

**Risk:** Core business logic (booking system) has no regression tests. High-impact bugs could crash all booking flows.

**Priority:** Critical

---

### Redis Service

**What's Not Tested:**
- Geospatial queries (geoAdd, geoRadius)
- Distributed locks (acquireLock, releaseLock)
- Pub/sub message delivery
- In-memory fallback correctness
- Connection failure recovery
- Pipeline transaction rollback

**Files:** `src/shared/services/redis.service.ts` (1,801 lines, 0 tests)

**Risk:** Caching/locking errors could corrupt state or cause data loss.

**Priority:** High

---

### Socket.io Integration

**What's Not Tested:**
- Connection authentication
- Room-based message isolation
- Broadcast message delivery
- Socket disconnection cleanup
- Concurrent connection limits
- Cross-server message delivery via Redis pub/sub

**Files:** `src/shared/services/socket.service.ts` (910 lines, 0 tests)

**Risk:** Real-time updates may silently fail. Users won't receive notifications.

**Priority:** High

---

### Authentication Flows

**What's Not Tested:**
- Customer OTP generation and verification
- Driver OTP (sent to transporter phone)
- JWT token generation and validation
- Refresh token lifecycle
- Token expiry and rotation
- Invalid OTP rejection (max 3 attempts)
- Concurrent login attempts

**Files:**
- `src/modules/auth/auth.service.ts`
- `src/modules/driver-auth/driver-auth.service.ts`

**Risk:** Auth bypass, token leaks, or OTP reuse could compromise security.

**Priority:** Critical

---

## Summary by Severity

### 🔴 Critical (Immediate Fix Needed)
1. **Missing Await on Async DB Calls** - Could cause data inconsistency
2. **Race Condition in Order Expiry** - Duplicate notifications, state corruption
3. **Fire-and-Forget Socket Emissions** - Real-time updates fail silently
4. **Zero Tests on Core Services** - Order, Broadcast, Redis, Socket have no tests

### 🟡 High (Fix Soon)
1. **Broadcast Service Complexity** - 1,139 lines, hard to maintain safely
2. **Socket.io Memory Leak Risk** - Stale socket references accumulate
3. **O(n) Broadcast Expiry Scan** - Degrades at scale (100k+ bookings)
4. **Debug Logging of PII** - Phone numbers exposed in logs

### 🟠 Medium (Plan for Next Sprint)
1. **Stub Customer Implementations** - Wallet, settings not persistent
2. **Missing Error Handling Consistency** - Generic Errors vs AppError
3. **Incomplete Input Validation Masking** - Phone, email not masked
4. **Database Connection Pool Limits** - Bottleneck at scale

---

*Concerns audit: 2026-02-19*
