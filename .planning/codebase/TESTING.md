# Testing Patterns

**Analysis Date:** 2026-05-04
**Project:** Weelo Unified Backend
**Goal:** A new contributor can write a test that fits the existing style.

---

## Test Framework

| Item | Value | Source |
|---|---|---|
| Runner | Jest 29.7.0 | `package.json:72` |
| Preset | `ts-jest` 29.4.6 | `package.json:73`, `jest.config.js:16` |
| TypeScript transformer | `ts-jest` with `diagnostics: false` (type safety enforced separately by `tsc` in CI) | `jest.config.js:68-70` |
| Test environment | `node` | `jest.config.js:19` |
| Assertion library | Jest built-ins (`expect`, `toBe`, `toEqual`, etc.) | — |
| Mock library | Jest built-ins (`jest.fn`, `jest.mock`, `jest.spyOn`) — NO `jest-mock-extended`, NO `ioredis-mock` | `package.json:60-75` confirms minimal devDeps |
| Snapshot library | Not used (codebase prefers explicit assertions) | — |
| Coverage | `--coverage` flag → built-in `coverage/` directory | `package.json:16` |
| HTTP test client | `supertest`, `nock`, `msw` — NONE installed; tests are unit-level with mocked services | `package.json` |
| E2E framework | None in repo (Maestro for app E2E lives in `e2e/` and is excluded from Jest — `jest.config.js:31`) | `jest.config.js:28-33` |

### `jest.config.js` (`jest.config.js:1-71`)

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/?(*.)+(spec|test).ts',
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/e2e/',          // Maestro lives here — separate runner
    '\\.d\\.ts$',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/**/index.ts',
  ],
  coverageThreshold: {
    global: { branches: 70, functions: 75, lines: 80, statements: 80 },
  },
  maxWorkers: '50%',
  clearMocks: true,
  verbose: true,
  transform: {
    '^.+\\.ts$': ['ts-jest', { diagnostics: false }],
  },
};
```

**Key choices:**
- **`clearMocks: true`** — every mock is auto-cleared between tests. Tests should NOT call `jest.clearAllMocks()` themselves unless they also need to clear timers/spies.
- **`diagnostics: false`** — ts-jest does NOT type-check during test runs. Type safety is enforced separately by the `npx tsc --noEmit` step in `.github/workflows/deploy-production.yml:36`.
- **`maxWorkers: '50%'`** — half of available CPUs; tuned to avoid OOM on developer laptops.

---

## Test Directory Layout

### Top-Level: `src/__tests__/` (349 test files)

This is where **almost all tests** live — flat layout, one `*.test.ts` per audit/fix area.

```
src/__tests__/
├── *.test.ts                               ← 349 flat-listed test files
├── __helpers__/                            ← Shared test utilities (2 files)
│   ├── lock-mock.ts                        ← Holder-checked Redis lock mock
│   └── with-env.ts                         ← Hermetic process.env override helper
├── scenarios/                              ← End-to-end scenario tests (6 files)
│   ├── customer-booking-end-to-end.test.ts
│   ├── cas-stress-300rps.test.ts
│   ├── dpdp-pii-leakage.test.ts
│   ├── fcm-cross-channel-dedup.test.ts
│   ├── queue-backpressure.test.ts
│   └── refresh-token-rotation-e2e.test.ts
└── differentiator/                         ← Sacred-invariant smoke tests (2 files)
    ├── multi-vehicle-hold-concurrent.test.ts
    └── two-phase-hold-fsm.test.ts
```

### Module-Level: `src/modules/<m>/__tests__/` (5 module-co-located files)

Used sparingly for tests too tightly coupled to module internals:

```
src/modules/auth/__tests__/auth.service.otp.test.ts
src/modules/auth/__tests__/otp-challenge.service.test.ts
src/modules/booking/__tests__/booking.routes.legacy-proxy.test.ts
src/modules/driver-auth/__tests__/driver-auth.service.otp.test.ts
src/modules/pricing/__tests__/pricing.service.test.ts
```

### Service-Level: `src/shared/services/__tests__/` (2 files)

```
src/shared/services/__tests__/queue.guard.test.ts
src/shared/services/__tests__/vehicle-key.service.test.ts
```

### Other Test Locations

```
src/core/config/__tests__/env.validation.tracking-stream.test.ts   ← 1 file
scripts/__tests__/boot-dryrun.test.ts                              ← 1 file
eslint-rules/__tests__/                                            ← 4 files (ESLint RuleTester, NOT Jest — see ESLint section below)
```

### File Naming

- Test file pattern: `<feature>.test.ts` (kebab-case)
- Spec files (`*.spec.ts`) are **also** matched by `testMatch` (`jest.config.js:24`) but no `.spec.ts` files exist in the codebase today.

**Rule:** new tests go in `src/__tests__/<descriptive-name>.test.ts`. Use module-co-located `__tests__/` only when the test must reach into module-private state that is awkward to expose.

### Total Test File Inventory

```
src/__tests__/*.test.ts              349    ← top-level (~95%)
src/__tests__/scenarios/*.test.ts      6
src/__tests__/differentiator/*.test.ts 2
src/modules/*/__tests__/*.test.ts      5
src/shared/services/__tests__/*.test.ts 2
src/core/config/__tests__/*.test.ts    1
scripts/__tests__/*.test.ts            1
─────────────────────────────────────────
Total Jest tests                     366
```

`find src -name "*.test.ts" | wc -l` → 366.

---

## Test Categories

The codebase uses descriptive **filename prefixes** to group tests by category. There is no folder-based separation (apart from `scenarios/` and `differentiator/`).

| Category | Filename pattern | Purpose | Example |
|---|---|---|---|
| **Critical fixes** | `critical-*`, `critical-fix-*` | Regression suite for prod-incident fixes | `critical-22-booking-socket.test.ts` |
| **Phase fixes** | `phase1-*` ... `phase8-*`, `phase3to100-*` | Council-phase remediations | `phase4-broadcast-geo-fixes.test.ts` |
| **QA suites** | `qa-*` | End-to-end QA scenarios | `qa-broadcast-scenarios.test.ts` |
| **Stress** | `*-stress.test.ts`, `stress-*` | Load + concurrency under simulated 300 RPS | `customer-booking-create-stress.test.ts`, `stress-broadcast-hold-comprehensive.test.ts` |
| **Hawk** | `hawk-*` | Resilience / failure-injection | `hawk-resilience-stress.test.ts` |
| **Hardening** | `fix-*-hardening.test.ts`, `tiger-*-hardening.test.ts` | Service-level hardening checks | `fix-auth-server-hardening.test.ts` |
| **Eagle / Falcon / Lion / Leo / Tiger** | Animal-prefixed | Council audit codenames | `eagle-i7-hold-system.test.ts`, `falcon-fi3-hold-naming.test.ts` |
| **Edge** | `edge-*` | Edge cases (rate limiter, trust proxy, runtime auth) | `edge-rate-limit-layered-keygen.test.ts` |
| **Resilience / Reliability** | `resilience-*`, `reliability-*` | Failure-mode coverage | `resilience-audit.test.ts` |
| **Validation** | `validation-*`, `input-validation.test.ts` | Schema-level tests | `validation-h10-h18-fixes.test.ts` |
| **Contracts** | `contracts-*`, `*-contract.test.ts`, `qa-endpoint-contracts.test.ts` | Wire-format / payload contract guards | `durable-emit-contract.test.ts`, `notification-outbox-queue-contract.test.ts` |
| **Wiring / smoke** | `wiring-verification-tests.test.ts`, `health.test.ts`, `*-bootstraps.test.ts` | Boot-time wiring checks | `no-orphan-bootstraps.test.ts` |
| **Differentiator** | `src/__tests__/differentiator/` | Sacred invariants — blocking gate for all phases | `two-phase-hold-fsm.test.ts:6-11` |
| **Scenarios** | `src/__tests__/scenarios/` | Full-lifecycle Rapido-for-trucks flows | `customer-booking-end-to-end.test.ts` |

**Differentiator tests** are explicitly described as "the **blocking gate** for all of Weelo Phase 5 (104 HIGH fixes across P1-P10). Every PR in those phases must pass this suite." — `two-phase-hold-fsm.test.ts:9-11`.

**Scenarios** walk full state machines (PENDING → BROADCASTING → ASSIGNED → IN_PROGRESS → COMPLETED → RATED) and assert socket emit names, payload shape, and `payloadVersion` symmetry — `customer-booking-end-to-end.test.ts:7-26`.

### Static Source-Assertion Tests (UNUSUAL PATTERN)

A meaningful subset of tests **read service source as text and grep-assert** rather than executing the function. Example: `critical-22-booking-socket.test.ts:58-67`:
```ts
const fs = require('fs');
const path = require('path');
function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf-8');
}
const source = readSource('modules/booking/booking-broadcast.service.ts');
expect(source).toContain("if (!_radiusService)");
expect(source).toContain("'SERVICE_NOT_READY'");
```

**Used when** runtime mocking would be prohibitively expensive (deep dependency graphs, dozens of imports). They guard "the source still says X" — fast, but brittle to refactors. Examples: `accept-atomicity.test.ts:73-99`, `critical-22-booking-socket.test.ts:73-110`, `differentiator/two-phase-hold-fsm.test.ts:42-50`.

**Rule:** prefer behavioral tests with mocks. Use source-assertion only when behavioral testing would require >100 lines of mock setup.

---

## Mocking Patterns

### General Rule

**ALL `jest.mock()` calls MUST come BEFORE imports** of the module under test. The codebase enforces this with a header comment in every test:
```ts
// MOCK SETUP — must come before imports
jest.mock('../shared/services/logger.service', () => ({ ... }));
// THEN
import { authService } from '../modules/auth/auth.service';
```
See `accept-atomicity.test.ts:20-22`, `confirmed-hold-acceptance.test.ts:18-20`, `durable-emit-contract.test.ts:21-22`.

### Logger Mock (universal)

Every test mocks logger first to silence output and capture calls:

```ts
// src/__tests__/critical-22-booking-socket.test.ts:29-36
jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
```

Variant with capture (used in scenarios): `src/__tests__/scenarios/customer-booking-end-to-end.test.ts:45-50` records calls into a `loggerCalls: Array<{level, msg, meta}>` for assertion.

### Metrics Mock (universal)

```ts
// src/__tests__/accept-atomicity.test.ts:33-38
jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    recordHistogram: jest.fn(),
    observeHistogram: jest.fn(),  // Add when withDbTimeout-aware
    setGauge: jest.fn(),
  },
}));
```

### Config Mock (universal)

```ts
// src/__tests__/critical-22-booking-socket.test.ts:45-52
jest.mock('../config/environment', () => ({
  config: {
    redis: { enabled: true },
    isProduction: false,
    isDevelopment: false,
    otp: { expiryMinutes: 5, maxAttempts: 5 },
    sms: {},
    jwt: { secret: 'test-secret' },
  },
}));
```

### Hold Config Mock

```ts
// src/__tests__/durable-emit-contract.test.ts:140-149
jest.mock('../core/config/hold-config', () => ({
  HOLD_CONFIG: {
    driverAcceptTimeoutMs: 45000,
    driverAcceptTimeoutSeconds: 45,
    confirmedHoldMaxSeconds: 180,
    flexHoldDurationSeconds: 90,
    flexHoldExtensionSeconds: 30,
    flexHoldMaxDurationSeconds: 130,
    flexHoldMaxExtensions: 2,
  },
}));
```

### Redis Service Mock — Spread Pattern

Tests construct individual `jest.fn()`s and spread them into a service mock — this lets each test customize a single method:

```ts
// src/__tests__/confirmed-hold-acceptance.test.ts:40-67
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();
const mockRedisGetJSON = jest.fn();
const mockRedisHIncrBy = jest.fn();
const mockRedisHGetAll = jest.fn();
const mockRedisHMSet = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    getJSON:     (...args: any[]) => mockRedisGetJSON(...args),
    hIncrBy:     (...args: any[]) => mockRedisHIncrBy(...args),
    hGetAll:     (...args: any[]) => mockRedisHGetAll(...args),
    hMSet:       (...args: any[]) => mockRedisHMSet(...args),
    isConnected: () => true,
  },
}));
```

In-memory Redis emulator (used in scenarios): `customer-booking-end-to-end.test.ts:35-43` builds `Map`-backed stores for strings, lists, ZSETs, hashes, locks — full programmable Redis fake.

### Prisma Mock — `$transaction` Pass-Through

The dominant pattern: mock the Prisma client and define `$transaction` as a **pass-through that invokes the callback against the same mock surface**:

```ts
// src/__tests__/confirmed-hold-acceptance.test.ts:87-116
const mockPrismaClient: any = {
  assignment: {
    update:     (...args: any[]) => mockAssignmentUpdate(...args),
    updateMany: (...args: any[]) => mockAssignmentUpdateMany(...args),
    findUnique: (...args: any[]) => mockAssignmentFindUnique(...args),
    findMany:   (...args: any[]) => mockAssignmentFindMany(...args),
  },
  truckRequest:    { findFirst, findUnique, findMany, update },
  truckHoldLedger: { update, findFirst, findUnique },
  $executeRaw:        (...args: any[]) => mockExecuteRaw(...args),
  $queryRaw:          (...args: any[]) => mockQueryRaw(...args),
  // T1 MOCK GAP: withDbTimeout calls tx.$executeRawUnsafe for SET LOCAL
  // statement_timeout. Without these stubs, the tx body throws "is not a
  // function" and aborts before the fix under test runs.
  $executeRawUnsafe:  jest.fn().mockResolvedValue(0),
  $queryRawUnsafe:    jest.fn().mockResolvedValue([]),
  $transaction:       (fn: any) => fn(mockPrismaClient),  // Pass-through
};
```

**`withDbTimeout` mock** (must mirror prod behavior):

```ts
// src/__tests__/confirmed-hold-acceptance.test.ts:117-130 (excerpt)
jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: mockPrismaClient,
  withDbTimeout: async (fn: any, _opts: any) => fn(mockPrismaClient),
  HoldPhase:        { FLEX: 'FLEX', CONFIRMED: 'CONFIRMED', EXPIRED: 'EXPIRED', RELEASED: 'RELEASED' },
  AssignmentStatus: { pending: 'pending', driver_accepted: 'driver_accepted', driver_declined: 'driver_declined', /* ... */ },
}));
```

### Lock Mock Helper — `__helpers__/lock-mock.ts`

`src/__tests__/__helpers__/lock-mock.ts:30-51` provides a Map-backed Redis lock mock that **enforces holder-checked release**:

```ts
const { acquireLock, releaseLock, _state } = makeLockMock();
jest.mocked(redisService.acquireLock).mockImplementation(acquireLock);
jest.mocked(redisService.releaseLock).mockImplementation(releaseLock);

// ... exercise code under test ...

expect(_state.size).toBe(0); // every acquired lock was released
```

**Why it exists** (per the helper docstring at `lock-mock.ts:1-17`): "Replaces ad-hoc `jest.fn().mockResolvedValue(true)` lock mocks which silently let tests release locks they never owned — which masked at least one production bug (holder-ID drift on retry)."

**Rule:** new tests touching distributed locks MUST use `makeLockMock()`, not raw `jest.fn().mockResolvedValue(true)`.

### Env Override Helper — `__helpers__/with-env.ts`

`src/__tests__/__helpers__/with-env.ts:44-63` provides `withEnv()` and `withEnvAsync()` that snapshot, override, and restore `process.env` keys hermetically. Per the file docstring: "Direct mutation leaks across describe blocks and parallel workers; the env-pollution-audit CI script asserts `withEnv()` is the only path."

Usage:
```ts
import { withEnvAsync } from './__helpers__/with-env';

await withEnvAsync({ FF_DURABLE_EMIT_ENABLED: 'true', PHONE_KEY_SALT: 'a'.repeat(48) }, async () => {
  // ... test body ...
});
```

**CI gate:** `tools/ci/env-pollution-audit.sh` asserts no test mutates `process.env` outside this helper.

### Socket.IO Mock — Capture-Array Pattern

```ts
// src/__tests__/scenarios/customer-booking-end-to-end.test.ts:35
const socketEmits: Array<{ kind: string; target: string; event: string; payload: any }> = [];
```

Tests then assert on the captured emits:
```ts
expect(socketEmits).toContainEqual({
  kind: 'user', target: customerId, event: 'flex_hold_started',
  payload: expect.objectContaining({ holdId, deadlineMs: expect.any(Number) }),
});
```

### FCM / Push Notification Mock

```ts
// scenarios/customer-booking-end-to-end.test.ts:36
const fcmPayloads: Array<{ userId: string; payload: any }> = [];
```

The `fcm.service` is mocked to push into this array.

### BullMQ / Queue Mock

`src/__tests__/scenarios/queue-backpressure.test.ts` mocks the queue service directly. No real BullMQ/Redis is exercised. Worker logic is tested via direct invocation of the processor function with mocked dependencies.

### MULTI/EXEC Pipeline Mock

For Redis pipeline atomicity (durable emit), the mock chains operations and applies them to in-memory ZSets — `durable-emit-contract.test.ts:69-104`:

```ts
type MultiQueuedOp = { type: 'zAdd' | 'expire'; args: any[] };
let mockMultiExecImpl: (ops: MultiQueuedOp[]) => Promise<any[]> = async (ops) => { /* apply to mockZSets */ };
const mockRedisMulti = jest.fn(() => {
  const ops: MultiQueuedOp[] = [];
  const tx: any = {
    zAdd:   (k, s, m) => { ops.push({ type: 'zAdd', args: [k, s, m] }); return tx; },
    expire: (k, t)    => { ops.push({ type: 'expire', args: [k, t] }); return tx; },
    exec:   () => mockMultiExecImpl(ops),
  };
  return tx;
});
```

Tests can override `mockMultiExecImpl` to simulate `EXEC` aborts / partial failures.

### HTTP Client Mocking

Not used. The codebase makes outbound HTTP calls (Google Maps, Exotel, FCM) through services that are mocked at the service boundary, not at the HTTP layer. **No `nock`, no `msw`, no `supertest`.**

### Fake Timers

Used selectively for time-dependent logic:
- `pricing.service.test.ts:32-34` — `jest.useFakeTimers(); jest.setSystemTime(new Date('2026-04-15T14:00:00'));`
- Hold expiry tests use `jest.advanceTimersByTime(...)`.
- `confirmed-hold.service.ts:378` exposes `DISPATCH_NO_ACK_TIMEOUT_MS` as a `let` so tests can lower it to ~100ms WITHOUT fake timers (which interact poorly with `.unref()`). See the comment at `confirmed-hold.service.ts:373-378`.

**Rule:** prefer real timers + tunable timeouts over `jest.useFakeTimers()`. Use fake timers only for Date.now() determinism (pricing, surge, etc.).

---

## Test Helpers Inventory

### `src/__tests__/__helpers__/lock-mock.ts`

Holder-checked Map-backed lock mock. Exports:
- `makeLockMock(): { acquireLock, releaseLock, _state }`
- `LockResult { acquired: boolean, holderId: string | null }`
- `LockMock { acquireLock, releaseLock, _state }`

### `src/__tests__/__helpers__/with-env.ts`

Hermetic `process.env` override. Exports:
- `withEnv<T>(overrides, fn): T`
- `withEnvAsync<T>(overrides, fn): Promise<T>`

### Inline Helpers (NOT in `__helpers__/`)

These appear inline in many tests but should be considered conventional:

- **`readSource(relativePath)`** — reads a service source file as text, used for static source-assertion tests. Inlined in `critical-22-booking-socket.test.ts:61-66`, `accept-atomicity.test.ts`, etc.
- **`mockMultiExecImpl`** — overridable Redis pipeline executor for atomicity tests. Inlined in `durable-emit-contract.test.ts:70-84`.
- **`setMockDate(dateStr)` / `restoreDate()`** — fake-timer helpers in pricing tests. `pricing.service.test.ts:31-38`.

**Rule:** if a helper is reused across 3+ test files, promote it to `src/__tests__/__helpers__/`.

---

## Recent Test-Wiring Patterns (Last 20 Test-Fix Commits)

`git log --grep "^fix(tests/" -20` reveals the dominant pain points. These are CRITICAL — when adding new tests for the same code paths, you must match these mock contracts.

| Pattern | Commit | What needed wiring |
|---|---|---|
| Customer progress mirror retargeting | `c86a24d1` | `D1-4` test had to update channel + payload shape after progress-mirror refactor |
| `withDbTimeout` + `tx.$queryRaw` | `4ed0d087` | Confirmed-hold accept tests needed `withDbTimeout` mock + `tx.$queryRaw` for KYC eligibility check |
| Finalize-CAS `updateMany` | `2f27dec1` | Confirmed-hold A02-006 Stage 2 needed `updateMany` mock with count for CAS |
| `truckRequest.findUnique` + retarget channel | `ac3e3492` | Cascade-dispatch A15 needed `findUnique` mock; assertion moved from socket → FCM |
| `updateMany` + `order.findUnique` for extend-CAS | `559c7b71` | Flex-hold extend tests needed CAS mock + parent-order lookup mock |
| Cache invalidation around `onVehicleTransition` | `724ac901` | Broadcast-accept M-15 needed re-wiring after vehicle-transition outbox change |

### Recurring Mock Gaps (Required Wiring When Adding Hold/Order Tests)

1. **`withDbTimeout` pass-through** (`confirmed-hold-acceptance.test.ts:117-130`):
   ```ts
   withDbTimeout: async (fn: any, _opts: any) => fn(mockPrismaClient),
   ```

2. **`tx.$executeRawUnsafe` stub** (for `SET LOCAL statement_timeout` in withDbTimeout — `confirmed-hold-acceptance.test.ts:109-113`):
   ```ts
   $executeRawUnsafe: jest.fn().mockResolvedValue(0),
   $queryRawUnsafe:   jest.fn().mockResolvedValue([]),
   ```

3. **`tx.$queryRaw` for `validateActorEligibility`** (KYC + isActive check inside tx — `confirmed-hold-acceptance.test.ts:86`):
   ```ts
   const mockQueryRaw = jest.fn().mockResolvedValue([{ isActive: true, kycStatus: 'VERIFIED' }]);
   ```

4. **`assignment.updateMany` returning `{ count: N }`** for CAS verification — see `confirmed-hold.service.ts:1508`.

5. **`order.findUnique` / `truckRequest.findUnique`** needed when service does post-CAS reads for cache/customer-mirror payload.

6. **HoldPhase + AssignmentStatus enums** — re-export string-valued shims since the real Prisma enum types are not available without a Prisma generate (`confirmed-hold-acceptance.test.ts:117-130`).

**Rule:** when writing a test for any function in `truck-hold/`, `order/`, or `broadcast/`, copy the mock surface from `confirmed-hold-acceptance.test.ts:39-130` as your starting point. Do not omit `$executeRawUnsafe` / `$queryRawUnsafe` — they ARE called inside `withDbTimeout`.

---

## Test Structure

### Suite Organization

```ts
// src/__tests__/scenarios/cas-stress-300rps.test.ts:101-176
describe('Scenario 2 — CAS Stress @ 300 RPS', () => {
  describe('1000 concurrent vehicle-status flips (load-test)', () => {
    it('S1.1 1000 concurrent CAS flips on the SAME vehicle — only 1 succeeds', async () => { ... });
    it('S1.2 1000 concurrent flips on 1000 distinct vehicles all succeed', async () => { ... });
    it('S1.3 ZERO orphaned assignments — every successful CAS produces exactly one assignment', async () => { ... });
    it('S1.4 lost-update pattern: mid-tx racing CAS does NOT corrupt status', async () => { ... });
  });
  describe('Trap-1 regression — Redis degraded mid-tx fires F-CAS-03', () => {
    it('S2.1 sets degraded BEFORE acquireLock — throws F-CAS-03', () => { ... });
  });
});
```

**Pattern:** outer `describe` = feature/scenario, inner `describe` = sub-area, `it/test` = audit-tagged single assertion. Test names start with the audit ID (`S1.1`, `D1-4`, `M-15`, `FIX #25`) for easy cross-reference to council docs.

### Common Lifecycle Hooks

```ts
beforeAll(() => { /* one-time setup, e.g. set process.env.PHONE_KEY_SALT */ });
afterEach(() => { restoreDate(); });          // pricing.service.test.ts:46
beforeEach(() => { /* reset per-test mocks */ });
```

`clearMocks: true` in `jest.config.js:62` removes the need for `jest.clearAllMocks()` in `beforeEach`. Tests still call it manually when they also need to reset captured arrays (e.g. `socketEmits.length = 0;`).

### Async / Await Pattern

Always `async () => { await ... }`. Never returns-a-promise without `await`. Errors are asserted with `await expect(promise).rejects.toThrow(...)`:

```ts
await expect(authService.verifyOtp('', '123456'))
  .rejects.toThrow('Invalid phone');
```

### Pre-Import Env Setup

When a module reads `process.env` at module load time (lazy salt resolution, feature-flag boot assertions), the test must set the env BEFORE the import:

```ts
// src/modules/auth/__tests__/auth.service.otp.test.ts:1-8
// Hermetic salt for hashPhoneForKey (DPDP §8(3)) — must be set BEFORE auth.service is required
process.env.PHONE_KEY_SALT = 'a'.repeat(48);
process.env.FF_OTP_KEY_HASH_DUAL_WRITE = 'false';

import { AppError } from '../../../shared/types/error.types';
import { hashPhoneForKey } from '../../../shared/utils/pii.utils';
```

---

## Coverage

### Threshold

```js
// jest.config.js:49-56
coverageThreshold: {
  global: {
    branches:   70,
    functions:  75,
    lines:      80,
    statements: 80,
  },
}
```

### Run Coverage

```bash
npm run test:coverage   # jest --coverage
```

Output goes to `coverage/` (HTML, lcov, text-summary). The `coverage/` directory is gitignored.

### Coverage Collection

```js
// jest.config.js:42-46
collectCoverageFrom: [
  'src/**/*.ts',
  '!src/**/*.d.ts',
  '!src/**/__tests__/**',
  '!src/**/index.ts',     // Barrels excluded
],
```

---

## Critical Test Files

These tests anchor the most important invariants. Treat them as documentation for "what NOT to break":

| File | Lines | Anchors |
|---|---|---|
| `src/__tests__/durable-emit-contract.test.ts` | ~600 | F-B-26: per-user seq + ZADD before fan-out for lifecycle events. `durable-emit-contract.test.ts:1-19` |
| `src/__tests__/critical-22-booking-socket.test.ts` | ~700 | Issues #7, #9–#21 — null guards, lock non-reentrancy, decrement guards, BOLA, vehicle-type validation, OTP safe queries. `critical-22-booking-socket.test.ts:1-23` |
| `src/__tests__/confirmed-hold-acceptance.test.ts` | ~800 | FIX #25 (FK traversal), FIX #28 (HMSET+HINCRBY), atomic accept tx |
| `src/__tests__/accept-atomicity.test.ts` | ~1500 | FIX #6 — assignment + vehicle status atomic in `handleDriverAcceptance`. Six suites: A. Atomicity, B. Race, C. Side Effects, D. Path A vs B, E. What-If, F. Data Integrity. `accept-atomicity.test.ts:7-14` |
| `src/__tests__/differentiator/two-phase-hold-fsm.test.ts` | ~400 | **Sacred invariant gate** — FLEX → CONFIRMED → EXPIRED/RELEASED state machine. `two-phase-hold-fsm.test.ts:6-30` |
| `src/__tests__/differentiator/multi-vehicle-hold-concurrent.test.ts` | ~500 | Multi-truck-type concurrent hold contention |
| `src/__tests__/scenarios/cas-stress-300rps.test.ts` | ~700 | Load-tested CAS at 300 RPS, 1000 concurrent flips |
| `src/__tests__/scenarios/customer-booking-end-to-end.test.ts` | ~2000 | Full lifecycle scenarios (happy path, cancellation at every stage, payment, cascade reassignment, SOS) |
| `src/__tests__/scenarios/dpdp-pii-leakage.test.ts` | — | Asserts the six logger redaction patterns work across all logging code paths |
| `src/__tests__/scenarios/refresh-token-rotation-e2e.test.ts` | — | JWT refresh rotation lifecycle |
| `src/__tests__/scenarios/queue-backpressure.test.ts` | — | Booking/tracking queue priority + timeout |
| `src/__tests__/scenarios/fcm-cross-channel-dedup.test.ts` | — | FCM + socket dedup by `eventId` + `eventVersion` |
| `src/__tests__/contracts-event-name-registry.test.ts` | — | Verifies socket event names match `packages/contracts/events.asyncapi.yaml` |
| `src/__tests__/notification-outbox-queue-contract.test.ts` | — | Outbox-pattern contract |
| `src/__tests__/dead-code-orphans.test.ts` | — | Asserts no orphaned files remain after refactor |
| `src/__tests__/no-orphan-bootstraps.test.ts` | — | Server boot wiring complete |
| `src/__tests__/no-501-in-production-routes.test.ts` | — | No `501 Not Implemented` reaches production routes |
| `src/__tests__/wiring-verification-tests.test.ts` | — | Cross-service wiring checks |
| `src/__tests__/health.test.ts` | — | `/health` and `/health/ready` endpoints |
| `src/__tests__/foundation-types.test.ts` | — | Type-level invariants |
| `src/__tests__/strict-mode-verify.test.ts` | — | Asserts strict-mode-related fixes hold |
| `src/__tests__/env-example-completeness.test.ts` | — | `.env.example` parity |
| `src/__tests__/phase3to100-env-lint-workflow.test.ts` | — | env-lint CI workflow shape |

### Top-Level `__tests__/` Other Critical Files (sample, not exhaustive)

```
auth-hardening.test.ts
booking-broadcast-lifecycle.test.ts
broadcast-canonicality.test.ts
critical-22-hold-system.test.ts
critical-22-security-redis.test.ts
hold-phase-cas-monolith.test.ts
hold-reconciliation-metrics.test.ts
idempotency-hard-require.test.ts
idempotency-safety.test.ts
truck-hold-state-machine.test.ts
truck-hold-single-surface-wrapper.test.ts
```

(For the full 349-file list, see `find src/__tests__ -maxdepth 1 -name "*.test.ts" | sort`.)

---

## Test Scripts (`package.json:15-17`)

```json
"test": "jest",
"test:coverage": "jest --coverage",
"test:differentiator": "jest --testPathPattern=differentiator",
```

**No** `test:integration`, `test:e2e`, `test:unit`, or `test:watch` script defined. Tests are categorically equivalent to Jest — there is no separate runner.

### Common Ad-Hoc Commands

```bash
# Run a single file
npx jest src/__tests__/durable-emit-contract.test.ts

# Run by name pattern
npx jest --testNamePattern="atomic decline"

# Run by path pattern (for filename prefixes)
npx jest --testPathPattern="^stress-"
npx jest --testPathPattern="qa-"
npx jest --testPathPattern="phase4-"

# Watch mode (manual)
npx jest --watch

# Bail on first failure
npx jest --bail

# CI-equivalent run
npx jest --forceExit       # matches deploy-production.yml:39
```

---

## CI Test Execution

### GitHub Actions Workflows

`.github/workflows/`:

| File | Trigger | What it runs |
|---|---|---|
| `deploy-production.yml` | push to `main`, manual | `npx tsc --noEmit` THEN `npx jest --forceExit` THEN ECR push + ECS deploy. `deploy-production.yml:35-39` |
| `env-lint.yml` | PR + push to main | `npm run lint:env` (`scripts/verify-env-example.ts`) — gates `.env.example` parity. `env-lint.yml:43-45` |
| `security.yml` | PR + push to main | Semgrep SAST + CodeQL + npm audit + Gitleaks + Trivy filesystem scan. `security.yml:1-65` |

**Test execution gate:** `deploy-production.yml:38-41`:
```yaml
- name: Run tests (jest)
  run: npx jest --forceExit
  env:
    NODE_ENV: test
```

`NODE_ENV=test` is critical: services check this to skip side-effects (e.g. `b1170607` "skip health sampler interval under NODE_ENV=test").

### Pre-CI Local Gates

`tools/ci/`:

| Script | Purpose |
|---|---|
| `tools/ci/env-pollution-audit.sh` | Asserts no test mutates `process.env` outside `with-env.ts` |
| `tools/ci/http-scheme-scan.sh` | Forbids `http://` URLs in production code paths |
| `tools/ci/line-cap-check.ts` | File-size cap enforcement |
| `tools/ci/stale-grep.sh` | Grep against stale-pattern allowlist |

**Rule:** before opening a PR, run the relevant `tools/ci/*` script if your change touches env vars, URLs, or file size.

---

## Common Patterns

### Async Testing

```ts
// Resolves
await expect(orderService.createOrder(req)).resolves.toMatchObject({ orderId: expect.any(String) });

// Rejects with code
await expect(authService.verifyOtp(phone, 'wrong')).rejects.toThrow(/Invalid OTP/);

// Rejects with AppError shape
const err = await orderService.createOrder(badReq).catch(e => e);
expect(err).toBeInstanceOf(AppError);
expect(err.statusCode).toBe(400);
expect(err.code).toBe('VALIDATION_ERROR');
```

### Error Testing

```ts
// Patterns from various tests in src/__tests__/
expect(() => fn()).toThrow();
expect(() => fn()).toThrow(AppError);
expect(() => fn()).toThrow('expected message substring');
await expect(asyncFn()).rejects.toThrow();
await expect(asyncFn()).rejects.toMatchObject({ code: 'SERVICE_NOT_READY' });
```

### CAS Result Assertions

When testing `updateMany` with status precondition, always assert BOTH the success and conflict paths:

```ts
// Success
mockUpdateMany.mockResolvedValueOnce({ count: 1 });
const result = await service.action(...);
expect(result.success).toBe(true);

// CAS miss
mockUpdateMany.mockResolvedValueOnce({ count: 0 });
const conflict = await service.action(...);
expect(conflict.success).toBe(false);
expect(conflict.errorCode).toBe('CONFLICT'); // or whatever the service returns
```

### Lock Lifecycle Assertion

```ts
const { acquireLock, releaseLock, _state } = makeLockMock();
// ... wire to redisService mock ...
await action();
expect(_state.size).toBe(0);  // every acquired lock was released
```

### Socket Emit Assertion

```ts
// Capture array
const socketEmits: any[] = [];
mockSocketService.emitToUser.mockImplementation((userId, event, payload) => {
  socketEmits.push({ kind: 'user', target: userId, event, payload });
});

// Assert specific event
expect(socketEmits).toContainEqual({
  kind: 'user',
  target: customerId,
  event: 'flex_hold_started',
  payload: expect.objectContaining({ holdId, deadlineMs: expect.any(Number) }),
});

// Assert order of events
expect(socketEmits.map(e => e.event)).toEqual([
  'flex_hold_started', 'flex_hold_extended', 'driver_accepted', 'trucks_remaining_update',
]);
```

### Source Assertion

```ts
const source = readSource('modules/booking/booking-broadcast.service.ts');
expect(source).toContain("if (!_radiusService)");
expect(source).toMatch(/throw new AppError\(500,\s*'SERVICE_NOT_READY'/);
expect(source).not.toMatch(/_radiusService!/); // No non-null assertions
```

### Static Module-Existence Assertion

```ts
// src/__tests__/differentiator/two-phase-hold-fsm.test.ts:48-50
function sourceExists(relPath: string): boolean {
  return fs.existsSync(path.join(REPO_ROOT, relPath));
}
expect(STATE_MACHINE_CANDIDATES.some(sourceExists)).toBe(true);
```

---

## ESLint Custom Rule Tests (NOT Jest)

`eslint-rules/__tests__/` contains tests that use **ESLint's `RuleTester` directly — no Jest dependency** (per `eslint-rules/README.md:51`):

```bash
node eslint-rules/__tests__/no-setinterval-without-unref.test.js
node eslint-rules/__tests__/cas-vehicle-update-must-check-count.test.js
node eslint-rules/__tests__/lock-holder-must-be-randomUUID.test.js
node eslint-rules/__tests__/no-pii-in-redis-key.test.js
```

These are **NOT** part of the Jest test suite and **NOT** run in CI today (per the README, "Suggested package.json wiring (deferred — `package.json` is hook-protected)"). When changing custom ESLint rules, run them manually.

---

## Anti-Patterns (Things NOT in This Codebase)

If you're tempted to do these, reconsider — none are used:

- ❌ `supertest` / HTTP-level integration tests against a live Express app
- ❌ `nock` / `msw` for HTTP mock servers (services are mocked at TS-import boundary)
- ❌ `ioredis-mock` / `redis-mock` (custom in-memory shim is preferred — `customer-booking-end-to-end.test.ts:38-43`)
- ❌ `jest-mock-extended` / `ts-mockito` (manual `jest.fn()` spread pattern is preferred)
- ❌ Real database integration (`@testcontainers/postgresql`) — tests run hermetically with mocked Prisma
- ❌ Real Redis (`testcontainers/redis`) — same; in-memory mocks always
- ❌ Snapshot testing (`toMatchSnapshot`) — explicit `expect().toEqual(...)` is preferred
- ❌ Custom Jest reporters / setup files — `setupFilesAfterEach`, `globalSetup`, `globalTeardown` not configured

If your change requires any of the above, document the rationale in the test file header and discuss in PR.

---

*Testing analysis: 2026-05-04*
