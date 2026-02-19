# Testing Patterns

**Analysis Date:** 2026-02-19

## Test Framework

**Runner:**
- Jest (^29.7.0)
- Config: `jest.config.js`
- TypeScript support: ts-jest (^29.4.6)

**Assertion Library:**
- Built-in Jest expect() assertions

**Run Commands:**
```bash
npm test              # Run all tests matching *.test.ts pattern
npm run test:coverage # Generate coverage report
```

## Test File Organization

**Location:**
- Co-located in `__tests__/` directories within `src/`
- Test files: `src/__tests__/health.test.ts`, `src/__tests__/transporter-availability-toggle.test.ts`
- Alternative pattern: `**/?(*.)+(spec|test).ts` also matches

**Naming:**
- Pattern: `{subject}.test.ts` (not .spec.ts)
- Example: `transporter-availability-toggle.test.ts` for testing toggle functionality
- Match intent: Health checks in health.test.ts, business logic in domain-specific test files

**Configuration (jest.config.js):**
```javascript
{
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '\.d\.ts$'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/**/index.ts'
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 75,
      lines: 80,
      statements: 80
    }
  },
  clearMocks: true,
  verbose: true,
  maxWorkers: '50%'
}
```

## Test Structure

**Suite Organization:**
```typescript
describe('Feature Category', () => {
  describe('Sub-feature', () => {
    it('should do expected behavior', async () => {
      // Arrange
      // Act
      // Assert
    });
  });
});
```

**File Header Pattern:**
```typescript
/**
 * =============================================================================
 * TEST MODULE NAME — Description
 * =============================================================================
 *
 * What this tests: [Clear explanation]
 * Covers: Phase 1, Phase 2, Edge cases, etc.
 *
 * SCALABILITY: Tests verify O(1) operations, no N+1 queries
 * EASY UNDERSTANDING: Each test has clear scenario → expected behavior
 * MODULARITY: Tests grouped by feature phase
 * CODING STANDARDS: Jest best practices, proper setup/teardown
 *
 * @author Team Name
 * @version 1.0.0
 * =============================================================================
 */
```

**Global Setup/Teardown:**
```typescript
beforeAll(async () => {
  // One-time setup before all tests
  await redisService.initialize();
});

beforeEach(async () => {
  // Setup before each test
  await cleanUpTestData();
  jest.clearAllMocks();
});

afterEach(async () => {
  // Teardown after each test
  await cleanUpTestData();
});

afterAll(() => {
  // One-time cleanup after all tests
  stopBackgroundJobs();
});
```

## Mocking

**Framework:** Jest mocks via `jest.mock()`

**Pattern:**
```typescript
// Mock logger
jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock database
const mockPrismaUpdate = jest.fn().mockResolvedValue({});
const mockPrismaFindUnique = jest.fn();
jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    user: {
      update: (...args: any[]) => mockPrismaUpdate(...args),
      findUnique: (...args: any[]) => mockPrismaFindUnique(...args),
    },
  },
}));
```

**Setup/Reset Pattern:**
```typescript
beforeEach(async () => {
  jest.clearAllMocks();
  mockGetUserById.mockReset();
  mockPrismaUpdate.mockReset();
  mockPrismaUpdate.mockResolvedValue({});  // Set default
});
```

**Assertion Pattern:**
```typescript
expect(mockEmitToUser).toHaveBeenCalledWith(
  transporterId,
  'transporter_status_changed',
  expect.objectContaining({
    transporterId,
    isAvailable: true,
    updatedAt: expect.any(String),
  })
);
```

**What to Mock:**
- External services: Redis, database, file storage, SMS/Email providers
- Third-party APIs: AWS SDK, Google Maps, Firebase
- Cross-cutting concerns: Logger, socket service
- Configuration that changes per environment

**What NOT to Mock:**
- Core business logic (pure functions)
- Validation utilities
- Error classes
- Date/time generation (use mocking for specific tests only)
- In-memory/local Redis in unit tests

## Test Data and Fixtures

**Test Data Constants:**
```typescript
const TRANSPORTER_ID_1 = 'transporter-test-001';
const TRANSPORTER_ID_2 = 'transporter-test-002';
const TRANSPORTER_ID_3 = 'transporter-test-003';
const TRANSPORTER_ID_OFFLINE = 'transporter-offline-001';

// Key patterns (must match production code)
const TOGGLE_COOLDOWN_KEY = (id: string) => `transporter:toggle:cooldown:${id}`;
const TOGGLE_COUNT_KEY = (id: string) => `transporter:toggle:count:${id}`;
const TOGGLE_LOCK_KEY = (id: string) => `transporter:toggle:lock:${id}`;
```

**Helper Functions:**
```typescript
/** Simulate a transporter going online */
async function simulateTransporterOnline(transporterId: string): Promise<void> {
  const presenceData = JSON.stringify({
    transporterId,
    onlineSince: new Date().toISOString(),
  });
  await redisService.set(
    TRANSPORTER_PRESENCE_KEY(transporterId),
    presenceData,
    PRESENCE_TTL_SECONDS
  );
  await redisService.sAdd(ONLINE_TRANSPORTERS_SET, transporterId);
}

/** Simulate a transporter going offline */
async function simulateTransporterOffline(transporterId: string): Promise<void> {
  await redisService.del(TRANSPORTER_PRESENCE_KEY(transporterId));
  await redisService.sRem(ONLINE_TRANSPORTERS_SET, transporterId);
}

/** Clean all test Redis keys */
async function cleanRedisKeys(): Promise<void> {
  const testIds = [TRANSPORTER_ID_1, TRANSPORTER_ID_2, TRANSPORTER_ID_3];
  for (const id of testIds) {
    await redisService.del(TRANSPORTER_PRESENCE_KEY(id));
    await redisService.del(TOGGLE_COOLDOWN_KEY(id));
    // ... more cleanup
  }
}
```

**Fixture Location:**
- Helpers defined at top of test file or in shared `__tests__/fixtures/` directory
- Factory functions for creating test objects
- Constant test IDs and expected values

## Coverage

**Thresholds (jest.config.js):**
```
global:
  branches: 70%
  functions: 75%
  lines: 80%
  statements: 80%
```

**View Coverage:**
```bash
npm run test:coverage
# Generates ./coverage/ directory with HTML report
# Open ./coverage/lcov-report/index.html in browser
```

**Coverage Exclusions:**
- `src/**/*.d.ts` - Type definitions
- `src/**/__tests__/**` - Test files themselves
- `src/**/index.ts` - Barrel exports (usually pass-through)

## Test Types

**Unit Tests:**
- Test individual functions in isolation
- Mock all external dependencies
- Fast execution (< 100ms per test)
- Example: `isOnline()` function returns correct boolean for transporter ID

**Integration Tests:**
- Test multiple components together
- Can use real Redis/database (with cleanup)
- Verify workflows end-to-end
- Example: Full toggle flow - presence key SET, online set SADD, broadcast emit, cooldown SET

**E2E Tests:**
- Not present in codebase (would require separate test framework)
- Would test via HTTP endpoints
- Not required for current phase

## Common Patterns

**Async Testing:**
```typescript
it('should complete async operation', async () => {
  const result = await asyncFunction();
  expect(result).toBe(expectedValue);
});

// OR with Promise.all for concurrent tests
await Promise.all([
  simulateTransporterOnline(id1),
  simulateTransporterOnline(id2),
  simulateTransporterOnline(id3),
]);
```

**Error Testing:**
```typescript
it('should throw ValidationError on invalid input', () => {
  expect(() => {
    validateInput(invalidData);
  }).toThrow(ValidationError);
});

// For async errors
it('should reject with specific error', async () => {
  await expect(asyncFunction()).rejects.toThrow(NotFoundError);
});

// Mock rejection
mockDatabaseCall.mockRejectedValueOnce(new Error('DB connection failed'));
```

**Truthy/Falsy Assertions:**
```typescript
expect(exists).toBe(true);        // Strict equality
expect(exists).toBe(false);       // Strict equality
expect(count).toBeGreaterThan(0); // Numeric comparison
expect(ttl).toBeLessThanOrEqual(60);
expect(data).toContain(value);    // Array membership
expect(object).toEqual(expected); // Deep equality
```

**Mock Verification:**
```typescript
// Verify called with exact args
expect(mockFn).toHaveBeenCalledWith(arg1, arg2);

// Verify called with partial args (loose matching)
expect(mockFn).toHaveBeenCalledWith(
  expectedId,
  expect.objectContaining({ isAvailable: true })
);

// Verify call count
expect(mockFn).toHaveBeenCalledTimes(3);

// Get mock call arguments for inspection
const [firstArg, secondArg] = mockFn.mock.calls[0];
```

## Real Test Example

From `transporter-availability-toggle.test.ts`:

**Test Suite for Redis Key Management:**
```typescript
describe('Phase 1: Backend Hardening — Redis Key Management', () => {
  describe('Presence Key (transporter:presence:{id})', () => {

    it('should SET presence key with TTL when transporter goes ONLINE', async () => {
      // Setup: Simulate transporter coming online
      await simulateTransporterOnline(TRANSPORTER_ID_1);

      // Verify presence key exists
      const exists = await redisService.exists(TRANSPORTER_PRESENCE_KEY(TRANSPORTER_ID_1));
      expect(exists).toBe(true);

      // Verify data is correct
      const data = await redisService.get(TRANSPORTER_PRESENCE_KEY(TRANSPORTER_ID_1));
      expect(data).not.toBeNull();
      const parsed = JSON.parse(data!);
      expect(parsed.transporterId).toBe(TRANSPORTER_ID_1);
      expect(parsed.onlineSince).toBeDefined();
    });

    it('should have correct TTL on presence key', async () => {
      await simulateTransporterOnline(TRANSPORTER_ID_1);

      const ttl = await redisService.ttl(TRANSPORTER_PRESENCE_KEY(TRANSPORTER_ID_1));
      // TTL should be close to PRESENCE_TTL_SECONDS (60s)
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(PRESENCE_TTL_SECONDS);
    });
  });

  describe('Distributed Lock', () => {

    it('should reject second lock while first is held', async () => {
      const lockKey = TOGGLE_LOCK_KEY(TRANSPORTER_ID_1);

      const first = await redisService.acquireLock(lockKey, TRANSPORTER_ID_1, 5);
      expect(first.acquired).toBe(true);

      const second = await redisService.acquireLock(lockKey, 'another-holder', 5);
      expect(second.acquired).toBe(false);
    });
  });
});
```

**End-to-End Workflow Test:**
```typescript
it('should complete full toggle ON flow: presence + set + broadcast', async () => {
  const transporterId = TRANSPORTER_ID_1;

  // Step 1: Set presence key
  const presenceData = JSON.stringify({
    transporterId,
    onlineSince: new Date().toISOString(),
  });
  await redisService.set(
    TRANSPORTER_PRESENCE_KEY(transporterId),
    presenceData,
    PRESENCE_TTL_SECONDS
  );

  // Step 2: Add to online set
  await redisService.sAdd(ONLINE_TRANSPORTERS_SET, transporterId);

  // Step 3: WebSocket broadcast
  mockEmitToUser(transporterId, 'transporter_status_changed', {
    transporterId,
    isAvailable: true,
    updatedAt: new Date().toISOString(),
  });

  // Step 4: Set cooldown
  await redisService.set(TOGGLE_COOLDOWN_KEY(transporterId), Date.now().toString(), 5);

  // Verify all steps completed
  expect(await redisService.exists(TRANSPORTER_PRESENCE_KEY(transporterId))).toBe(true);
  expect(await redisService.sIsMember(ONLINE_TRANSPORTERS_SET, transporterId)).toBe(true);
  expect(mockEmitToUser).toHaveBeenCalledWith(
    transporterId,
    'transporter_status_changed',
    expect.objectContaining({ isAvailable: true })
  );
  expect(await redisService.exists(TOGGLE_COOLDOWN_KEY(transporterId))).toBe(true);
});
```

## Current Test Coverage

**Test Files:**
- `src/__tests__/health.test.ts` - Basic health check (2 tests)
- `src/__tests__/transporter-availability-toggle.test.ts` - Comprehensive integration tests (75+ tests)

**Tested Areas:**
- Redis key management (presence, online set, cooldowns)
- Rate limiting and distributed locking
- Idempotency checking
- Presence refresh with guard patterns
- WebSocket broadcast integration
- Stale transporter cleanup
- Concurrent operations
- Scalability with 1000+ transporters
- Graceful degradation and fallbacks
- Data integrity verification

**Not Yet Tested:**
- API endpoints (route handlers)
- Customer/Driver/Order services
- Payment processing
- Notification services
- Database migrations

---

*Testing analysis: 2026-02-19*
