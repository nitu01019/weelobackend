# Coding Conventions

**Analysis Date:** 2026-05-04
**Project:** Weelo Unified Backend (Express + TypeScript + Prisma + Redis + Socket.IO)
**Purpose:** Enable contributors to write code that matches existing style without guessing.

---

## TypeScript Configuration

**Source:** `tsconfig.json:1-34`

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "strict": false,                    // Strict mode DISABLED globally
    "noImplicitAny": false,             // any allowed
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noImplicitReturns": false,
    "noFallthroughCasesInSwitch": true, // Only strict flag enabled
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "moduleResolution": "node",
    "baseUrl": "./src",
    "paths": {
      "@/*":         ["./*"],
      "@core":       ["./core"],
      "@core/*":     ["./core/*"],
      "@modules/*":  ["./modules/*"],
      "@shared/*":   ["./shared/*"],
      "@config/*":   ["./config/*"]
    }
  }
}
```

**Reality vs. config:**
- `strict: false` is the official posture — `any` is widespread, e.g. `src/modules/order/order.routes.ts:447` `dues.map((d: any) => ...)` and `src/modules/order/order.service.ts:314` `catch (error: any)`.
- Path aliases ARE declared but rarely used in source — most files use relative paths (`../../shared/services/logger.service`). New code should follow the relative-path convention.
- `noFallthroughCasesInSwitch` is the ONLY strictness gate; missing returns and unused locals will pass `tsc`.

### `any` vs `unknown` Usage

| Pattern | When | Example |
|---|---|---|
| `catch (error: any)` | Express route handlers | `src/modules/order/order.routes.ts:314,569,657` |
| `catch (error: unknown)` | Library / shared utility | `src/shared/database/prisma.service.ts:554` |
| `Record<string, unknown>` | Public type contracts | `src/shared/types/error.types.ts:18` `details?: Record<string, unknown>` |
| `unknown` for narrowed errors | Logger helpers | `src/shared/services/logger.service.ts:184` `logError(message: string, error?: unknown)` |

**Rule:** new shared utilities use `unknown` + type narrowing. Route handlers can use `any` for terseness — the existing codebase mixes both.

### Enum vs Union

- **String literal unions** for cross-app contracts: `src/shared/types/api.types.ts:73` `type UserRole = 'customer' | 'transporter' | 'driver' | 'admin'`.
- **Numeric / TypeScript `enum`** when the value flows to the database: `src/shared/types/error.types.ts:115-143` `enum ErrorCode`. Prisma also re-exports its DB enums (e.g. `HoldPhase`, `AssignmentStatus`) — see `src/shared/database/prisma.service.ts:12,36`.
- **`as const` discriminator objects** for typed catalogs: `src/shared/errors/error-catalog.ts:6-46` `ErrorCatalog = { ASSIGNMENT_NOT_FOUND: { code, status }, ... } as const`.

**Rule:** new code prefers union types (`'a' | 'b'`) over `enum` unless interop with Prisma demands an enum.

### Type-only Imports

Mixed style. Examples:
- `import type { RoutePointRecord } from '../../shared/database/record-types';` — `src/modules/truck-hold/confirmed-hold.service.ts:50`
- Types imported alongside runtime values without `type` keyword: `src/modules/order/order.service.ts:57` `import type { DispatchAttemptContext, ... } from './order-types'`

**Rule:** use `import type` for pure type imports; otherwise inline imports are accepted.

### Branded Types

None observed. Domain IDs are plain `string`. Type narrowing happens via Zod schemas at boundaries.

### Exhaustive Switch

`noFallthroughCasesInSwitch` enforces `break/return` on every case. Exhaustiveness checks via `assertNever(x: never)` are not used — switches typically handle a default case explicitly.

---

## File / Folder Naming

**Sampled modules** (10): `auth`, `order`, `truck-hold`, `booking`, `driver`, `transporter`, `vehicle`, `tracking`, `pricing`, `assignment`.

| Suffix | Purpose | Example |
|---|---|---|
| `*.service.ts` | Business logic class / singleton | `src/modules/auth/auth.service.ts` |
| `*.controller.ts` | Express request/response handlers | `src/modules/auth/auth.controller.ts` |
| `*.routes.ts` | Router + middleware wiring | `src/modules/auth/auth.routes.ts` |
| `*.schema.ts` | Zod schemas for request validation | `src/modules/auth/auth.schema.ts`, `src/modules/booking/booking.schema.ts` |
| `*.types.ts` | TypeScript type aliases / interfaces | `src/modules/order/order-types.ts`, `src/modules/truck-hold/truck-hold.types.ts` |
| `*.contract.ts` | Cross-module API/response contracts | `src/modules/order/order.contract.ts` |
| `*.repository.ts` | Prisma data-access wrappers | `src/shared/database/repositories/order.repository.ts` |
| `*.middleware.ts` | Express middleware factories | `src/shared/middleware/auth.middleware.ts` |
| `*.utils.ts` | Pure helper functions | `src/shared/utils/pii.utils.ts`, `src/shared/utils/validation.utils.ts` |
| `*.processor.ts` | Bull / queue worker | `src/modules/truck-hold/hold-finalize-retry.processor.ts` |
| `*.test.ts` | Jest tests | `src/__tests__/durable-emit-contract.test.ts` |
| `*.config.ts` | Static config object | `src/core/config/hold-config.ts`, `src/config/aws.config.ts` |
| `*.routes.ts` (split) | Granular route file when module exceeds 800 LOC | `src/modules/order/order-crud.routes.ts`, `order-lifecycle.routes.ts`, `order-progress.routes.ts` |

**Module barrel:** `index.ts` re-exports public surface. Example: `src/modules/auth/index.ts`, `src/modules/truck-hold/index.ts`.

**File case:** `kebab-case` everywhere. Hyphenated multi-word names — `cascade-dispatch.service.ts`, `vehicle-lifecycle.service.ts`, `hold-finalize-retry.processor.ts`.

---

## Module Structure (Three Representative Modules)

### 1. `src/modules/auth/`

```
auth.routes.ts          ← Router + rate-limit middleware (auth.routes.ts:29-57)
auth.controller.ts      ← Class instance `authController` (auth.controller.ts:19,107)
auth.service.ts         ← Class instance `authService` + module-level LRU cache (auth.service.ts:115)
auth.schema.ts          ← Zod schemas: sendOtpSchema, verifyOtpSchema (auth.schema.ts:17-39)
sms.service.ts          ← Exotel/SMS adapter
otp-challenge.service.ts ← Redis-backed OTP issue/verify
index.ts                ← Barrel
__tests__/
  auth.service.otp.test.ts
  otp-challenge.service.test.ts
```

**Wiring:** `auth.routes.ts:17` `import { authController }` → `auth.controller.ts:13` `import { authService }`. Service depends on `db`, `redisService`, `logger`, `smsService`, `otpChallengeService` (all imported as singletons from `../../shared/...`).

### 2. `src/modules/order/` (large, 25+ files)

```
order.routes.ts                  ← Top-level router, 1332 lines (order.routes.ts:1)
order.service.ts                 ← Service class, 2008 lines (order.service.ts:1)
order.contract.ts                ← Cross-module response builders
order-crud.routes.ts             ← CRUD-only routes (split for size)
order-lifecycle.routes.ts        ← Lifecycle event routes
order-progress.routes.ts         ← Progress endpoints
order-creation.service.ts        ← Sub-service: order create flow
order-accept.service.ts          ← Sub-service: accept flow
order-broadcast.service.ts       ← Sub-service: progressive broadcast
order-broadcast-helpers.ts
order-broadcast-query.service.ts
order-broadcast-send.service.ts
order-cancel.service.ts
order-cancel-policy.service.ts
order-dispatch-outbox.service.ts ← Outbox-pattern dispatch worker
order-lifecycle-outbox.service.ts
order-idempotency.service.ts
order-query.service.ts
order-timer.service.ts
order-id-cache.ts
order-types.ts                   ← Shared types
order-core-types.ts
customer-progress-mirror.ts      ← Customer-side socket payload builder
progressive-radius-matcher.ts
```

**Pattern:** the main service (`order.service.ts`) re-exports specialized sub-service functions to maintain a single import surface for callers. Example `src/modules/order/order.service.ts:69-176` aggregates `broadcastToTransportersFn`, `processProgressiveBroadcastStepFn`, etc.

### 3. `src/modules/truck-hold/`

```
truck-hold.routes.ts             ← Single router + lifecycle-routes split
truck-hold-crud.routes.ts
truck-hold-lifecycle.routes.ts
truck-hold.service.ts            ← Facade
truck-hold-create.service.ts
truck-hold-confirm.service.ts
truck-hold-release.service.ts
truck-hold-cleanup.service.ts
truck-hold-query.service.ts
truck-hold-store.service.ts
flex-hold.service.ts             ← Phase-1 logic, 1025 lines
confirmed-hold.service.ts        ← Phase-2 logic, 2073 lines
hold-state-machine.ts            ← FSM transitions
hold-eligibility.ts              ← Actor eligibility checks (KYC, isActive)
hold-finalize-retry.processor.ts ← Bull worker
cascade-dispatch.service.ts      ← Reassign on driver decline
reassign-driver.service.ts
truck-hold.types.ts
confirmed-hold.types.ts
index.ts                         ← Barrel — exports the public facade and types
```

**Pattern:** large feature splits into a facade service + phase-specific files + shared types + state-machine module. Each sub-service file owns its Redis key namespace at the top of the file (e.g. `flex-hold.service.ts:153-163` `REDIS_KEYS`).

---

## Dependency Injection / Wiring

**No DI container.** All services are **module-level singletons**.

**Two singleton patterns:**

1. **Class with module-level instance** (most common):
   ```ts
   // src/modules/auth/auth.service.ts
   class AuthService { ... }
   export const authService = new AuthService();
   ```
   Same pattern: `confirmedHoldService` (`src/modules/truck-hold/confirmed-hold.service.ts:411`), `flexHoldService`, `orderService`, `pricingService`, `redisService`, `socketService`, `prismaDb`.

2. **Frozen module-level functions** (utilities, no state):
   ```ts
   // src/shared/utils/validation.utils.ts:184
   export function validateSchema<T extends z.ZodSchema>(schema: T, data: unknown): z.infer<T>
   ```

**Configuration injection:** services accept `Partial<Config>` in their constructor and merge with `DEFAULT_CONFIG`:
```ts
// src/modules/truck-hold/flex-hold.service.ts:172-174
constructor(config: Partial<FlexHoldConfig> = {}) {
  this.config = { ...DEFAULT_CONFIG, ...config };
}
```

**Lazy imports** to break circular deps:
```ts
// src/shared/services/socket.service.ts:64-72
let _driverService: typeof import('.../driver.service')['driverService'] | null = null;
function getDriverService() {
  if (!_driverService) _driverService = require('.../driver.service').driverService;
  return _driverService;
}
```

**Rule:** new singletons follow pattern (1). When two services would import each other, use the lazy-`require` pattern from `socket.service.ts:64-72`.

---

## Error Handling Patterns

### Custom Error Class Hierarchy

**Two parallel definitions exist** (technical debt — see CONCERNS.md if it exists):

1. **Canonical** — `src/shared/types/error.types.ts:15-110`
   - `AppError` (base class) — `error.types.ts:15`
   - `ValidationError` — `error.types.ts:61` (status 400)
   - `AuthenticationError` — `error.types.ts:70` (status 401)
   - `AuthorizationError` — `error.types.ts:79` (status 403)
   - `NotFoundError` — `error.types.ts:88` (status 404)
   - `ConflictError` — `error.types.ts:97` (status 409)
   - `RateLimitError` — `error.types.ts:106` (status 429)
   - `ErrorCode` enum — `error.types.ts:115-143`

2. **Re-export shim** — `src/core/errors/AppError.ts:1-305`
   - Re-exports `AppError` from `(1)` then defines specific subclasses:
     - `BadRequestError`, `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `UnprocessableError`, `RateLimitError`, `InternalError`, `ServiceUnavailableError`
     - Domain-specific: `AuthenticationError`, `TokenExpiredError`, `InvalidOTPError`, `OTPExpiredError`, `BookingNotFoundError`, `InvalidBookingStatusError`, `VehicleNotFoundError`, `VehicleNotAvailableError`, `DriverNotFoundError`, `DriverNotAvailableError`
   - Type guards: `isOperationalError`, `isValidationError`, `isNotFoundError`, `isUnauthorizedError`

3. **Catalog** — `src/shared/errors/error-catalog.ts:6-46` (~25 codes, status-coded `as const`).

**Existing usage:** services throw `new AppError(statusCode, code, message, details)` — see `src/shared/utils/validation.utils.ts:196`. The richer subclasses in `core/errors/AppError.ts` are imported sporadically.

### Throw vs Return-with-Error

The codebase uses **both**:

- **Throw** for unexpected failures and for Zod failures: `src/shared/utils/validation.utils.ts:196` `throw new AppError(400, 'VALIDATION_ERROR', ...)`.
- **Return discriminated union** for expected business outcomes (success/failure both valid): `src/modules/truck-hold/flex-hold.service.ts:107-116` `interface FlexHoldResponse { success: boolean; ...; message: string; error?: string }`.

The result-style return is used for hold/order acceptance flows where a 4xx is normal traffic, not exceptional. The thrown-error style is used in middleware and for invariant violations.

### Express Error Handler

**Location:** `src/shared/middleware/error.middleware.ts:25-80`

Pipeline:
1. Logs error with `requestId`, `path`, `method`, `userId`, `ip` (`error.middleware.ts:34-42`).
2. If `error instanceof AppError`:
   - Strips `details` for 5xx in production (`error.middleware.ts:48-50`).
   - Sets `Retry-After` header for 429 (`error.middleware.ts:52-55`).
   - Returns `{ success: false, error: { code, message, details?, requestId? } }`.
3. Else returns generic 500 with sanitized message (only verbose in dev).

**Async wrapper:** `error.middleware.ts:86-92`
```ts
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
```

**404 handler:** `error.middleware.ts:97-105`.

### Sample Service-Method Patterns (5)

1. **Throw on invariant violation:** `src/modules/auth/auth.service.ts:37` imports `AppError` and throws inside `verifyOtp()` when phone mismatch.
2. **Result envelope for orchestrated flows:** `src/modules/truck-hold/flex-hold.service.ts:107-116`, `confirmed-hold.service.ts:318-326` — `{ success, accepted/declined, errorCode, message }`.
3. **Try/catch wrapping outer transaction:** `src/modules/truck-hold/confirmed-hold.service.ts:1505-1544` — wraps `withDbTimeout` in `try/catch` and logs before re-throwing.
4. **Domain-specific error class:** `src/modules/truck-hold/hold-eligibility.ts` `HoldEligibilityError` (caught at `flex-hold.service.ts:425`).
5. **catch in route, next(error):** `src/modules/order/order.routes.ts:314-316,331-333` — `try { ... } catch (error: any) { logger.error(...); next(error); }`.

**Rule:** route handlers `try/catch + next(error)`. Services may throw `AppError` directly OR return `{ success, message, error }` — pick result-envelope when callers branch on outcome (e.g. captain captures decline reason), throw when failure should bubble to error middleware.

---

## Logging Conventions

**Library:** `winston` 3.11 (`package.json:55`).
**Logger:** `src/shared/services/logger.service.ts:127-155`.
**Levels:** `error`, `warn`, `info`, `debug` — level set via `config.logLevel`.

**Format:** Combined console + file (file only when `!config.isProduction`).
- File transports: `logs/error.log`, `logs/combined.log` (5 MB max, 5 files rotation) — `logger.service.ts:141-152`.
- Production = stdout only (CloudWatch in ECS).

### PII Redaction (DPDP Act §5(b))

Hardcoded into the format pipeline — `src/shared/services/logger.service.ts:33-46`. **All six patterns redacted before write:**

| Pattern | Replacement |
|---|---|
| 10-digit Indian phone `\b(\d{10})\b` | `******XXXX` (last 4 only) |
| PEM blocks | `[PEM_REDACTED]` |
| 40+ char base64 | `[B64_REDACTED]` |
| International phone `\+\d{1,3}...` | `[PHONE_REDACTED]` |
| 16-digit card | `XXXX[****8888]YYYY` |
| Email | `[EMAIL_REDACTED]` |

**Sensitive-key redaction:** keys matching `SENSITIVE_FIELDS` (defined in `src/shared/utils/pii.utils.ts`) get value replaced with `[REDACTED]` recursively — `logger.service.ts:74-93`.

**Process-level handlers:** `logger.service.ts:162-175` — `unhandledRejection` and `uncaughtException` route through `redactSensitivePatterns` before logging.

### Structured Fields

**Required canonical fields** when applicable:

| Field | Type | When | Example |
|---|---|---|---|
| `orderId` | string | order operations | `order.routes.ts:601` |
| `userId` | string | any auth'd request | `order.routes.ts:601` |
| `phoneLast4` | string | NEVER raw phone — use `maskPhoneForLog(phone)` | `order.routes.ts:297,328,601,1026` |
| `requestId` | string | propagated from `x-request-id` header | `error.middleware.ts:31` |
| `correlationId` | string | from `correlationMiddleware` | `src/shared/context/correlation.ts:32` |
| `holdId`, `transporterId` | string | hold/transporter ops | `flex-hold.service.ts:180-184,337-341` |
| `error` | unknown | inside catch | `error: err instanceof Error ? err.message : String(err)` (`order.service.ts:627`) |

### Sample Log Lines (5)

```ts
// src/shared/middleware/error.middleware.ts:34
logger.error('Request error', { error: error.message, stack, path, method, ip, userId, requestId });

// src/modules/order/order.routes.ts:297
logger.info('Order created', { orderId: result.orderId, userId: user.userId, phoneLast4: maskPhoneForLog(user.phone) });

// src/modules/truck-hold/flex-hold.service.ts:180
logger.info('[FLEX HOLD] Creating flex hold', { orderId, transporterId, quantity });

// src/modules/order/order.service.ts:686
logger.warn(`⚠️ ORDER DEBOUNCE: Customer ${request.customerId} tried to place order within ${DEBOUNCE_SECONDS}s cooldown`);

// src/shared/database/prisma.service.ts:563
logger.warn(`[withDbTimeout] Retryable conflict (${prismaCode}), retry ${attempt}/${maxRetries} after ${backoffMs}ms`);
```

**Convenience helpers:** `logInfo`, `logError`, `logWarn`, `logDebug` — `logger.service.ts:181-196`. New code prefers calling `logger.info(message, meta)` directly with structured `meta`.

### Log-Message Tagging

Services prefix free-text messages with bracketed tags so logs grep cleanly:

| Tag | Origin |
|---|---|
| `[FLEX HOLD]` | flex-hold.service.ts |
| `[CONFIRMED HOLD]` | confirmed-hold.service.ts |
| `[withDbTimeout]` | prisma.service.ts |
| `[ORDER]`, `[OrderService]`, `[OrderIngress]` | order.service.ts / order.routes.ts |
| `[Orders]` | order.routes.ts |
| `[FleetCache]` | fleet-cache.service.ts |
| `[Redis]`, `[Prisma]`, `[Socket]` | shared services |
| `[STOP]` | order.routes.ts:770 (geofence) |
| `[unhandledRejection]`, `[uncaughtException]` | logger.service.ts |

Emoji prefixes (`⚠️`, `✅`, `🎉`, `📍`, `📊`, `🐢`) are common in `info`/`warn` for visual scanning. New code may continue this — not required.

### ESLint Restrictions on Logging

`.eslintrc.json:29-39` and `.eslintrc.pii-overlay.json:11-34` BLOCK PII in template literals:
```ts
// BLOCKED — DPDP §5(b)
logger.info(`User ${customer.phone}`)
// REQUIRED
logger.info('User', { phoneLast4: maskPhoneForLog(customer.phone) })
```

The overlay also blocks `customer?.name || 'fallback'`, ternaries, and member-access (`customer.phone`, `order.customerName`, etc.) inside template literals.

---

## Validation

**Library:** `zod` 3.22 (`package.json:57`).
**Helpers:** `src/shared/utils/validation.utils.ts`.

### Schema Locations

- **Per-module schemas:** `src/modules/<module>/<module>.schema.ts`. Examples: `auth.schema.ts:17-39`, `booking/booking.schema.ts`, `driver/driver.schema.ts`.
- **Shared atomic schemas:** `src/shared/utils/validation.utils.ts:24-175`:
  - `uuidSchema` — `validation.utils.ts:27`
  - `phoneSchema` — `validation.utils.ts:32-45` (transforms `+91`/`91` prefix, refines `^[6-9]\d{9}$`)
  - `vehicleNumberSchema` — `validation.utils.ts:52-57` (uppercase, strips spaces/dashes)
  - `coordinatesSchema` — `validation.utils.ts:62-69` (clamped to India bounding box 6.5–37.0 lat, 68.0–97.5 lng)
  - `locationSchema` — `validation.utils.ts:75-100` (supports both nested `coordinates: {...}` and flat `latitude/longitude`)
  - `paginationSchema` — `validation.utils.ts:105-108`
  - Status enums: `bookingStatusSchema`, `assignmentStatusSchema`, `vehicleTypeSchema`, `userRoleSchema`, `otpSchema`

### Schema Conventions

**Strict mode:** every request schema closes with `.strict()` to reject unknown fields — see `src/modules/auth/auth.schema.ts:21,32,39`.

**Default values via `.default()`:** `auth.schema.ts:19` `role: userRoleSchema.default('customer')`.

**Type inference:** every schema exports its inferred type:
```ts
// src/modules/auth/auth.schema.ts:44-46
export type SendOtpInput = z.infer<typeof sendOtpSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
```

### Validation Entry Points

Three styles, **all wrap Zod errors into `AppError(400, 'VALIDATION_ERROR', ...)`**:

1. **`validateSchema(schema, data)`** — synchronous helper for controllers — `validation.utils.ts:184-200`. Used in `auth.controller.ts:24,41,60`.
2. **`validateRequest(schema)` middleware** — `validation.utils.ts:208-231`. Replaces `req.body` with parsed result.
3. **`validateQuery(schema)` middleware** — `validation.utils.ts:237-256`.

**Inline `safeParse`** style (route handler responsible for response shape):
```ts
// src/modules/order/order.routes.ts:130-141
const validationResult = createOrderSchema.safeParse(req.body);
if (!validationResult.success) {
  res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', ..., details: validationResult.error.errors } });
  return;
}
```

**Rule:** new endpoints prefer `validateSchema()` in controllers (fail-fast, single envelope) or `validateRequest()` middleware. `safeParse` inline is the legacy style — still in use in `order.routes.ts` but should be migrated.

### Sanitization

`validation.utils.ts:295-315`:
- `sanitizeString(input)` — strips HTML tags + special chars
- `sanitizePhone(input)` — digits-only, last 10
- `maskPhone(phone)` — `'******' + last4`
- `maskSensitive(data)` — recursively REDACTs `password|token|otp|secret|key`-like keys

PII helpers: `src/shared/utils/pii.utils.ts` exports `maskPhoneForLog`, `maskPhoneForExternal`, `maskName`, `hashPhoneForKey`, and `SENSITIVE_FIELDS`.

---

## Async Patterns

### `Promise.all` vs Sequential

- `Promise.all` for independent reads — used heavily in services to parallelize Prisma queries.
- Sequential for ordered side effects (hold-create → cache → emit) — see `flex-hold.service.ts:366-405` (DB tx → cache state → schedule expiry → emit socket — explicitly sequential).

### AsyncLocalStorage

`src/shared/context/correlation.ts:25` — `correlationStore = new AsyncLocalStorage<CorrelationContext>()`.

Public API:
- `getCorrelationId()` — `correlation.ts:31` returns `correlationId` or fallback `no-ctx:<8 hex>`
- `correlationMiddleware` — `correlation.ts:39-44` reads `X-Correlation-ID` header or generates `req:<8 hex>`
- `withCorrelation(prefix, fn)` — `correlation.ts:53-56` for background jobs

**Rule:** background tasks (Bull workers, outbox pollers) wrap their handler with `withCorrelation('bg:my-job', () => ...)` so logs carry a stable correlation ID.

### Generators / Async Iterators

Not observed in production code paths.

### Concurrency Limiting

`src/shared/services/socket.service.ts:80-94` — counting semaphore (`MAX_CONCURRENT_SOCKET_DB`, default 10) wraps Socket.IO connection-time DB ops to avoid pool exhaustion during reconnect storms.

**Rule:** for any code path that can fan out to >50 concurrent DB ops (worker batch processing, broadcast send), use a similar semaphore or a `p-limit`-style pool.

---

## Database Access Patterns

### Prisma Singleton

`src/shared/database/prisma.service.ts:2083` — `export const prismaClient = getPrismaClient()`.

The `prisma-client.ts` file is a thin **deprecated re-export shim** (`prisma-client.ts:1-69`) — both files return the same singleton, but new code should import from `prisma.service.ts`.

**Two clients:**
- `prismaClient` — primary (reads + writes), pool ~10 connections by default (`prisma.service.ts:309-315`)
- `prismaReadClient` — replica (reads only), 60% of primary pool (`prisma.service.ts:2022,2027`)

**Slow-query middleware:** `prisma.service.ts:2038-2052` logs queries >`SLOW_QUERY_THRESHOLD_MS` (default 200 ms) with `🐢` prefix.

### Transactions: `withDbTimeout`

**Definition:** `src/shared/database/prisma.service.ts:490-616`.

Wraps `prismaClient.$transaction()` with:
1. `SET LOCAL statement_timeout` inside the tx (`prisma.service.ts:542`) — default 8s, configurable via `options.timeoutMs`.
2. Auto-retry for serializable conflicts (P2034), connection-pool timeouts (P2024), and "transaction not started" (P2028) — `prisma.service.ts:530-571`.
3. Full-jitter exponential backoff (AWS pattern) — `prisma.service.ts:559-562` `random(0, min(1000ms, 100 * 2^attempt))`.
4. Translates persisted P2034 → `AppError(409, 'TRANSACTION_CONFLICT', ...)` (`prisma.service.ts:585-589`).
5. Translates Postgres `57014` (statement_timeout) → `AppError(503, 'DB_TIMEOUT', ...)` (`prisma.service.ts:602-606`).

**Usage:**
```ts
// src/modules/truck-hold/flex-hold.service.ts:460-465
const txResult = await withDbTimeout(async (tx) => {
  const rows = await tx.$queryRaw<...>` ... `;
  return tx.truckHoldLedger.create({ data: { ... } });
}, {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  timeoutMs: 8_000,
  site: 'flex_hold_create'  // metric label for retry telemetry
});
```

**Site labels** show up in `tx_serializable_conflict_total` and `tx_retry_wait_seconds` metrics — `prisma.service.ts:567,569`.

**Rule:** all critical transactions (hold create, accept, decline, order create, cancel) MUST use `withDbTimeout`. Tests must mock both `withDbTimeout` and `tx.$executeRawUnsafe` (the `SET LOCAL` call) — see `confirmed-hold-acceptance.test.ts:109-115`.

### `$queryRaw` / `$executeRaw` Usage

**When used:**
- `SELECT ... FOR UPDATE` row locks: `flex-hold.service.ts:467,543`, `confirmed-hold.service.ts:1533`.
- KYC eligibility check inside the same tx: `confirmed-hold.service.ts` calls `validateActorEligibility` which runs `tx.$queryRaw<Array<{ isActive, kycStatus }>>` (mocked at `confirmed-hold-acceptance.test.ts:86`).
- Atomic counters: `tx.$executeRaw` for `UPDATE "Order" SET "trucksFilled" = GREATEST(0, "trucksFilled" - 1)` — `confirmed-hold.service.ts:1533-1536`.
- `SET LOCAL statement_timeout` — `prisma.service.ts:542`.

**Rule:** prefer `prismaClient` typed methods. Drop to `$queryRaw` / `$executeRaw` only for `FOR UPDATE`, atomic counters, or Prisma-unsupported SQL. Always tag-templated literals — never string concat.

### CAS (Compare-And-Set) via `updateMany`

**Pattern:** `updateMany({ where: { ..., status: <expected> } })` returns `{ count: number }`. If `count === 0`, the precondition failed — return CONFLICT or 409.

```ts
// src/modules/truck-hold/confirmed-hold.service.ts:1508-1521
const updated = await tx.assignment.updateMany({
  where: { id: assignmentId, driverId, status: AssignmentStatus.pending },
  data: { status: AssignmentStatus.driver_declined },
});
if (updated.count === 0) {
  txCasMiss = true;
  return; // TX commits no-op — caller checks flag
}
```

```ts
// src/modules/order/order.routes.ts:789-798
const updated = await prismaClient.order.updateMany({
  where: { id: orderId, currentRouteIndex: currentIndex },
  data:  { currentRouteIndex: newIndex, stopWaitTimers: stopWaitTimers as any }
});
if (updated.count === 0) {
  return res.status(409).json({ success: false, error: { code: 'CONFLICT', ... } });
}
```

**Custom ESLint rule** `cas-vehicle-update-must-check-count` (`eslint-rules/cas-vehicle-update-must-check-count.js`) flags `vehicle.updateMany({ where: { ..., status: ... }})` not followed by a count-check + throw within 5 statements. Escape hatch: `// CAS-OK:<reason>` adjacent comment.

**Rule:** every `updateMany` with a status precondition must check `count` and produce a 409/CONFLICT path. No exceptions.

---

## Caching Patterns (Redis)

**Service:** `src/shared/services/redis.service.ts` (3175 lines).

### Read/Write Patterns

| Method family | Use |
|---|---|
| `get`, `set(key, val, ttlSec)` | Plain string + TTL — `redis.service.ts` |
| `getJSON<T>`, `setJSON(key, val, ttl)` | Auto-(de)serialize JSON. **Always check return: a returned `[object Object]` string indicates a missing `JSON.stringify` upstream — see CLAUDE.md "Known Issue 2"** |
| `hSet`, `hGet`, `hGetAll`, `hIncrBy`, `hMSet` | Atomic counters / hash maps. `confirmed-hold.service.ts` uses `HMSET`+`HINCRBY` instead of get+modify+set (FIX #28) |
| `sAdd`, `sRem`, `sMembers`, `sIsMember` | Sets — used for online transporter index, fleet cache |
| `zAdd`, `zRangeByScore`, `zRemRangeByScore` | Sorted sets — durable emit queue, hold-expiry timers |
| `incr`, `incrBy`, `expire` | Counters + TTL refresh — rate limit, idempotency |
| `multi() / exec()` | Pipeline / MULTI-EXEC for atomicity |

### TTL Conventions

- OTP: 5 min (`config.otp.expiryMinutes`)
- Idempotency keys: 24 h (per `order.service.ts:711-733`)
- Hold state cache: matches hold lifetime (90s flex / 180s confirmed)
- Backpressure counters: 300 s (`order.service.ts:627`)
- Distributed lock TTLs: 10–30 s typical (`order.routes.ts:174`, `flex-hold.service.ts:196`)

### Key Naming

**Convention:** `<domain>:<id>[:<sub>]` colon-separated — see `flex-hold.service.ts:153-163`:
```ts
const REDIS_KEYS = {
  FLEX_HOLD_LOCK:        (holdId: string) => `flex-hold:${holdId}`,
  FLEX_HOLD_CREATE_LOCK: (orderId, transporterId) => `flex-hold:create:${orderId}:${transporterId}`,
  FLEX_HOLD_STATE:       (holdId: string) => `flex-hold:${holdId}:state`,
  FLEX_HOLD_EXTENSIONS:  (holdId: string) => `flex-hold:${holdId}:extensions`,
};
```

`acquireLock` automatically prefixes the key with `lock:` — see comment at `flex-hold.service.ts:154`.

**ESLint rule** `no-pii-in-redis-key` (`eslint-rules/no-pii-in-redis-key.js`) blocks raw PII (`phone`, `name`, `email`, `aadhaar`, `pan`) in Redis key first-arg. Auto-allows `phoneHash`, `phoneSha`, `phoneHmac`, `nameHash`. Escape hatch: `// PII-OK:<reason>`.

### Invalidation

Two strategies in use:

1. **Inline invalidation** after the write — `flex-hold.service.ts:944-947`:
   ```ts
   await redisService.del(REDIS_KEYS.FLEX_HOLD_STATE(holdId)).catch(...);
   ```
2. **Outbox-driven invalidation** for cross-service caches — vehicle status changes go through `vehicle-transition-outbox.service.ts` so cache busts happen post-commit (see commit `73a96918` "post-commit vehicle cache invalidation via outbox").

---

## Concurrency / Locking

### Distributed Locks (Redis Lua)

**API:** `redisService.acquireLock(lockKey, holderId, ttlSeconds)` and `releaseLock(lockKey, holderId)`.

**Implementation:** `src/shared/services/redis.service.ts:2886-2962` — Lua-script atomic SET-NX-EX + holder-checked release. Lock keys prefixed with `lock:` automatically.

**Tiered degradation** (`redis.service.ts:2906-2917`):
1. Try Redis Lua eval.
2. Fallback to PostgreSQL advisory lock (rare).
3. Final fallback rejects.

### Holder-ID Discipline (CRITICAL)

**Rule from `eslint-rules/lock-holder-must-be-randomUUID.js`:** the second arg to `acquireLock` MUST be `crypto.randomUUID()` (or imported `randomUUID()` from `'crypto'`). Reusing/sharing holder IDs is forbidden — every acquisition must mint a fresh UUID. Escape hatch: `// LOCK-RE-ENTRANT-INTENT:<reason>`.

**Pattern:**
```ts
// src/modules/order/order.routes.ts:172-174,327
const lockKey  = `order:create:${user.userId}`;
const holderId = randomUUID();
const lockAcquired = await redisService.acquireLock(lockKey, holderId, 10);
try {
  // ... work ...
} finally {
  await redisService.releaseLock(lockKey, holderId); // SAME holder
}
```

`releaseLock` is holder-checked at the Lua level (`redis.service.ts:2962`) — so passing the wrong holder is a no-op, NOT a panic.

### Idempotency Keys

`x-idempotency-key` HTTP header is **hard-required** for `POST /api/v1/orders` — `src/modules/order/order.routes.ts:224-255`. Must match UUID v4 regex. Grace window (`ALLOW_MISSING_IDEMPOTENCY_KEY_UNTIL`) lets legacy clients bypass during cutover.

**Service-side dedup:** `order.service.ts:711-733` — Redis cache hit returns cached response, DB-table dedup behind that.

**Server-generated idempotency keys** (HMAC-signed) for socket flows — see commit `e9ae58c9` "HMAC-signed server keys".

### CAS — see "Database Access Patterns" above.

### Pessimistic Locks

`SELECT ... FOR UPDATE` inside `withDbTimeout(... { isolationLevel: Serializable })` — `flex-hold.service.ts:460-468`, `543`, `confirmed-hold.service.ts:467`.

---

## API Conventions

### Versioning

`const API_PREFIX = '/api/v1'` — `src/server.ts:470`. Every router mounts at `app.use(\`${API_PREFIX}/<resource>\`, router)` — `server.ts:477-490+`.

### Response Envelope

**Success:**
```json
{ "success": true, "data": <T>, "message"?: string, "meta"?: { "timestamp", "pagination"? } }
```
Builder: `src/core/responses/ApiResponse.ts:78-94` `ApiResponse.success(res, data, message?, meta?)`.
Helper: `successResponse<T>(data, meta?)` — `src/shared/types/api.types.ts:117-123`.

**Error:**
```json
{ "success": false, "error": { "code": string, "message": string, "details"?: object, "requestId"?: string } }
```
Produced by `errorHandler` middleware (`error.middleware.ts:56-65`) or constructed inline in routes for legacy reasons.

**Pagination meta:**
```json
{ "meta": { "pagination": { "page", "pageSize", "total", "totalPages", "hasNext", "hasPrev" } } }
```
Builder: `ApiResponse.paginated(res, data, { page, pageSize, total })` — `ApiResponse.ts:125-150`.

**Pagination utility:** `parsePagination(query)` returns `{ page, pageSize, offset }`, capping pageSize at 100 — `ApiResponse.ts:225-238`. Also `clampPageSize` — `validation.utils.ts:281-285`.

**Pagination defaults:**
- `MAX_PAGE_SIZE = 100` for API queries — `validation.utils.ts:265`
- `MAX_PAGE_SIZE = 500` for internal Prisma queries — `prisma-client.ts:35`

### Error-Status Mapping

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_PARAM`, `MISSING_IDEMPOTENCY_KEY` | Bad input |
| 401 | `UNAUTHORIZED`, `AUTH_TOKEN_EXPIRED`, `AUTH_TOKEN_INVALID` | Auth |
| 403 | `FORBIDDEN`, `DRIVER_NOT_IN_FLEET` | AuthZ |
| 404 | `NOT_FOUND`, `ORDER_NOT_FOUND`, `HOLD_NOT_FOUND` | Resource missing OR BOLA-shielded (return 404 instead of 403 to prevent info leak — `order.routes.ts:497-500`) |
| 409 | `CONFLICT`, `ACTIVE_ORDER_EXISTS`, `CONCURRENT_REQUEST`, `TRANSACTION_CONFLICT`, `BROADCAST_FILLED` | State conflict |
| 422 | `UNPROCESSABLE` | Cannot process |
| 429 | `RATE_LIMIT_EXCEEDED`, `LOCK_CONTENTION` | Throttled (always sets `Retry-After`) |
| 500 | `INTERNAL_ERROR`, `SERVICE_NOT_READY` | Unexpected |
| 503 | `SERVICE_UNAVAILABLE`, `DB_TIMEOUT` | Dependency down |

### Route Patterns

**Roles enforced via middleware composition:**
```ts
// src/modules/order/order.routes.ts:113-117
router.post('/',
  authMiddleware,
  roleGuard(['customer']),
  bookingQueue.middleware({ priority: Priority.HIGH, timeout: 15000 }),
  async (req, res, next) => { ... }
);
```

`bookingQueue.middleware` and `trackingQueue.middleware` (from `src/shared/resilience/request-queue`) are priority queues (CRITICAL/HIGH/NORMAL) used for backpressure on hot endpoints.

**Order of middleware:** `authMiddleware` → `roleGuard(...)` → resilience queue → handler. Validation runs **inside** the handler (or via `validateSchema`).

---

## Socket.IO Conventions

**Service:** `src/shared/services/socket.service.ts`.
**Adapter:** Redis Streams (`@socket.io/redis-streams-adapter`) for multi-pod fanout.

### Event Naming

**snake_case** strings — registered in `packages/contracts/events.generated.ts` (auto-generated from `events.asyncapi.yaml`). Re-exported as `SocketEvent` enum:
```ts
// src/shared/services/socket.service.ts:194
import { SocketEvent } from '../../../packages/contracts/events.generated';
```

**Lifecycle events** (sample): `flex_hold_started`, `flex_hold_extended`, `flex_hold_superseded`, `confirmed_hold_started`, `driver_accepted`, `driver_declined`, `trip_assigned`, `trip_cancelled`, `trucks_remaining_update`, `order_cancelled`, `booking_completed`, `route_progress_updated`.

**Connection events:** `connect`, `connected`, `disconnect`, `error`, `join_booking`, `leave_booking`, `update_location`, `heartbeat`, `dispatch_ack`.

### Payload Shape

**Versioned payloads:** lifecycle events include `payloadVersion: number` for forward-compat — see `dispatchAckSchema` at `socket.service.ts:55-61`.

**Server-time anchor:** time-bounded events include `serverNowMs` and `deadlineMs` (epoch ms) so the client can offset-correct its countdown — `confirmed-hold.service.ts:88-90`.

**Discriminated unions** for events shared by multiple roles — `src/shared/types/socket-events.ts:100-117` documents `trip_cancelled` having different shapes for driver vs customer (driver: per-assignment fields; customer: aggregate counters with `cancelledAssignmentCount`).

**Eventid + eventVersion** stamped for idempotent client dedup — `socket-events.ts:113-115`.

### Emit Patterns

```ts
// Per-user (default)
emitToUser(userId, 'flex_hold_started', payload)        // socket.service.ts (re-exported in many services)

// Trip room
emitToTrip(tripId, SocketEvent.LOCATION_UPDATED, data)

// Booking room
io.to(`booking:${bookingId}`).emit(...)
```

### Durable Emit (At-Least-Once)

When `FF_DURABLE_EMIT_ENABLED=true`, lifecycle emits go through:
1. `redisService.incr(\`socket:seq:${userId}\`)` for per-user sequence number.
2. `redisService.zAdd(\`socket:unacked:${userId}:${role}\`, seq, envelope)` + `expire` (TTL).
3. Then the actual `io.to(...).emit(...)` fan-out.

**Reconnect replay** reads from the ZSET and re-emits up to 200 entries. Driven by `src/__tests__/durable-emit-contract.test.ts`.

### Dispatch Ack

`dispatch_ack` from client is rate-limited (10/s), Zod-validated, capped at 1KB pre-parse — `socket.service.ts:55-61`. Acks `acknowledgeDispatch(assignmentId)` (`confirmed-hold.service.ts:400-405`) which clears the 15s no-ack sweep timer.

---

## Comments & Docs

### File Headers

Every service/module file opens with a banner block — see `src/modules/auth/auth.service.ts:1-27`:
```
/**
 * =============================================================================
 * AUTH MODULE - SERVICE
 * =============================================================================
 *
 * <Description>
 *
 * SECURITY FEATURES: ...
 * SCALABILITY:       ...
 * FOR BACKEND DEVELOPERS: ...
 * =============================================================================
 */
```

Sections under banners use `// =====` separators — `auth.service.ts:50-52`.

### Inline Comments

**Density: high.** Codebase carries extensive inline rationales tagged with audit IDs:
- `// FIX-#NN`, `// FIX P4-T11`, `// A02-005`, `// ADR: ...`, `// V3-M05 (P8-3)`, `// F-CAS-04`, `// H-S1 FIX`, `// M-2 FIX`, `// BOLA guard per OWASP`.
- These IDs trace back to council reviews and PRs — DO NOT delete without checking the corresponding planning doc.

### JSDoc

Used on **public exports** of utility / shared modules:
- `src/shared/database/prisma.service.ts:481-503` — full JSDoc on `withDbTimeout`.
- `src/shared/utils/validation.utils.ts:27-280` — JSDoc on every exported schema/helper.
- `src/core/responses/ApiResponse.ts:21-31` — usage examples in JSDoc.

Service-internal methods often skip JSDoc when the method name is self-documenting (e.g. `flex-hold.service.ts:179` `async createFlexHold(request)` — no JSDoc, just a banner).

**Rule:** new exported helpers in `src/shared/` get JSDoc. Service methods get JSDoc only when behavior is non-obvious or has audit-ID rationale.

### TODO / FIXME

- `// TODO(LEO-L2): ...` — owner-tagged TODOs are accepted (`order.service.ts:21`).
- `// TODO(Phase-6-migration): ...` — phase-tagged migration debt (`confirmed-hold.service.ts:360`).
- Bare `// TODO:` and `// FIXME:` are rare — only ~5 occurrences across `order.service.ts` + `confirmed-hold.service.ts`.
- `// HACK:` — not seen in production code.

**Rule:** TODOs must have an owner tag or phase tag. Pure `TODO:` should be replaced with a JIRA-style ID.

---

## Lint & Format Rules

**Format:** No `prettier` config in repo. Whitespace/indentation is whatever each author wrote — 2-space is dominant. Code submissions should match the surrounding file.

**Lint:**

### Primary `.eslintrc.json` (`.eslintrc.json:1-46`)

| Rule | Level | Note |
|---|---|---|
| `extends: eslint:recommended, plugin:@typescript-eslint/recommended` | — | Defaults |
| `no-console` | warn | Production code uses `logger.*`, never `console.log` |
| `@typescript-eslint/no-explicit-any` | warn | Reality: many `any` usages — warn-not-error |
| `@typescript-eslint/no-unused-vars` | warn | `argsIgnorePattern: "^_"` — prefix unused with `_` |
| `@typescript-eslint/no-require-imports` | off | `require()` allowed (used for circular-dep workarounds) |
| `no-restricted-syntax` | error | Two custom selectors (see below) |

**Custom no-restricted-syntax selectors:**
1. `.eslintrc.json:31-34` — blocks PII identifiers (`phone`, `name`, `customerName`, `driverName`, `customerPhone`, `driverPhone`) inside `logger.*` template literals (DPDP §5(b) / A12-003-006).
2. `.eslintrc.json:35-38` — `LIFECYCLE_EMIT_EVENTS` array entries must have an adjacent `// ADR:` comment (A03-007/P6-T06).

### PII Overlay `.eslintrc.pii-overlay.json`

Five additional `no-restricted-syntax` selectors (warn level) blocking PII via member access (`user.phone`), logical expressions (`customer?.name || 'fallback'`), and conditional expressions inside logger template literals.

### Custom Rule Set `.eslintrc.eslint-rules.json` (`eslintRules` overlay)

Loaded via `npx eslint --rulesdir eslint-rules --config .eslintrc.eslint-rules.json src/`. Four custom rules (warn level):

| Rule | Enforces | Source |
|---|---|---|
| `weelo/no-setinterval-without-unref` | `setInterval(...)` handle calls `.unref()` within 3 stmts (F-PERF-05) | `eslint-rules/no-setinterval-without-unref.js` |
| `weelo/cas-vehicle-update-must-check-count` | `vehicle.updateMany({ where: { ..., status: ... }})` followed by count-check + throw within 5 stmts (V11-NEW-08) | `eslint-rules/cas-vehicle-update-must-check-count.js` |
| `weelo/lock-holder-must-be-randomUUID` | `acquireLock(key, holder, ...)` holder MUST be `crypto.randomUUID()` (F-CAS-04) | `eslint-rules/lock-holder-must-be-randomUUID.js` |
| `weelo/no-pii-in-redis-key` | First arg of `redisService.<m>(key, ...)` does not contain raw PII (V11-NEW-09 / DPDP §8(3)) | `eslint-rules/no-pii-in-redis-key.js` |

Per-call escape hatches:
- `// CAS-OK:<reason>` (cas-vehicle-update-must-check-count)
- `// LOCK-RE-ENTRANT-INTENT:<reason>` (lock-holder-must-be-randomUUID)
- `// PII-OK:<reason>` (no-pii-in-redis-key)
- (no escape for `no-setinterval-without-unref` — fix the missing `.unref()`)

### `.eslintignore`

```
dist/
node_modules/
*.js
```

### Lint Scripts

```bash
npm run lint        # eslint src/**/*.ts
npm run lint:fix    # eslint src/**/*.ts --fix
npm run lint:env    # ts-node scripts/verify-env-example.ts (env config drift check)
```

---

## Commit Conventions

**Format:** `<type>(<scope>): <imperative description>` — based on Conventional Commits.

**From last 50 commits:**

| Type | Count | Notes |
|---|---|---|
| `fix(...)` | ~40 | dominant |
| `feat(...)` | rare | most production work goes through `fix` with a planning ID |
| `docs(...)` | a few | runbooks, council notes |
| `chore(...)` | rare | |
| `refactor(...)` | rare | |
| `test(...)` | rare — test-only commits go through `fix(tests/...)` |

**Scope conventions:**

```
fix(tests/<test-area>): wire <mock> for <fix>          # most common test-fix pattern
fix(<audit-id>): <change>                              # e.g. fix(A02-006): ...
fix(<service>): <change>                               # e.g. fix(flags-boot): ...
docs(<area>): <change>                                 # e.g. docs(council): ...
```

**Recent test-fix scopes** (from `git log --grep "^fix(tests/"`):
- `fix(tests/accept-atomicity): retarget D1-4 customer progress mirror channel + payload shape`
- `fix(tests/confirmed-hold): wire withDbTimeout + tx $queryRaw for accept CAS`
- `fix(tests/confirmed-hold): wire finalize-CAS updateMany for A02-006 Stage 2`
- `fix(tests/cascade-dispatch): wire truckRequest.findUnique + retarget A15 isCascade to FCM`
- `fix(tests/flex-hold): wire updateMany + order.findUnique mocks for extend-CAS`
- `fix(tests/broadcast-accept): re-wire M-15 cache invalidation around onVehicleTransition`

**Audit-ID prefixed commits:** `fix(A02-006):`, `fix(A04-002):`, `fix(P4-T11):` — these reference council remediation IDs and ALWAYS land in conjunction with planning docs in `.planning/`.

**Rule:**
- Production fix → `fix(<audit-id-or-scope>): <imperative>`.
- Test wiring update → `fix(tests/<area>): wire <mock> for <fix>`.
- Docs only → `docs(<area>): <change>`.
- Body explains the WHY; description is the WHAT.
- Attribution lines (`Co-Authored-By`) disabled globally per `~/.claude/settings.json` — do not add them.

---

## Function & Module Design

**Function size:** No hard cap. Existing services have functions exceeding 200 lines (e.g. `confirmed-hold.service.ts handleDriverAcceptance`). The codebase prioritizes "complete transactional logic in one place" over tiny functions.

**File size:**
- Routes: 1300–1600 lines acceptable
- Services: 2000+ lines exists (`order.service.ts:2008`, `confirmed-hold.service.ts:2073`, `redis.service.ts:3175`, `prisma.service.ts:2086`)
- Once a service file approaches 2000 lines, split into `<base>-<concern>.service.ts` siblings (see `order/` directory structure above).

**Exports:** Named exports preferred. Default exports used for the main router file in some modules — `src/modules/order/order.routes.ts:1332` `export default router;`.

**Barrel files (`index.ts`):** Used for module surface. Examples:
- `src/modules/auth/index.ts`
- `src/modules/truck-hold/index.ts`
- `src/core/errors/index.ts`
- `src/core/responses/index.ts`

**Rule:** new modules ship an `index.ts` barrel re-exporting the public surface. Internal helpers should stay un-re-exported.

---

## Import Organization

No automated import sort. Observed convention (top to bottom):

1. Node built-ins — `import crypto from 'crypto'`, `import { EventEmitter } from 'events'`
2. External NPM packages — `import jwt from 'jsonwebtoken'`, `import { v4 as uuidv4 } from 'uuid'`
3. Prisma generated types — `import { Prisma, HoldPhase } from '@prisma/client'`
4. Local config — `import { config } from '../../config/environment'`
5. Shared services — `import { logger } from '../../shared/services/logger.service'`
6. Shared utils / types — `import { AppError } from '../../shared/types/error.types'`
7. Sibling module files — `import { authService } from './auth.service'`

Path aliases (`@modules/...`, `@shared/...`) are declared in `tsconfig.json:23-29` but rarely used in source — relative paths dominate. **Prefer relative imports** to match existing files.

---

## Configuration Files

| File | Purpose |
|---|---|
| `src/config/environment.ts` | Runtime config loader — `config.isDevelopment`, `config.isProduction`, `config.logLevel`, `config.jwt.*`, `config.otp.*` |
| `src/config/aws.config.ts` | AWS SDK config |
| `src/config/secrets.ts` | Secret loader (env + AWS Secrets Manager) |
| `src/config/production.config.ts` | Prod-specific overrides |
| `src/core/config/hold-config.ts` | Hold timing constants — `HOLD_CONFIG.flexHoldDurationSeconds`, etc. |
| `src/core/config/env.validation.ts` | Startup env-var validation (gates server boot) |
| `src/shared/config/feature-flags.ts` | `FLAGS`, `NUMERIC_FLAGS`, `isEnabled(...)`, `getNumericFlag(...)` |
| `.env.example` | Source-of-truth — `lint:env` script (`scripts/verify-env-example.ts`) gates CI on parity |

**Rule:** every new env var MUST be added to `.env.example` AND consumed via `feature-flags.ts` (`isEnabled` / `getNumericFlag`) — no raw `process.env.X` in services.

---

*Convention analysis: 2026-05-04*
