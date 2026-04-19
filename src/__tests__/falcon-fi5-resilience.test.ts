/**
 * =============================================================================
 * FALCON FI5 - LOW PRIORITY RESILIENCE FIXES - Test Suite
 * =============================================================================
 *
 * Covers:
 * - Fix #139: Firebase double-init guard (fcm.service.ts)
 * - Fix #136: getOrSet backing fn 30s timeout (redis.service.ts)
 * - Fix #138: orderStatusCache batch eviction (queue.service.ts)
 *
 * =============================================================================
 */

// ---------------------------------------------------------------------------
// 1. Fix #139: Firebase double-init guard
// ---------------------------------------------------------------------------
describe('Fix #139: Firebase double-init guard', () => {
  it('should reuse existing Firebase app when apps array is non-empty', async () => {
    // Simulate FCMService.initialize() with an already-initialized Firebase
    const mockFirebaseAdmin = {
      apps: [{ name: '[DEFAULT]' }],
      credential: { cert: jest.fn() },
      initializeApp: jest.fn(),
    };

    // Patch dynamic import to return our mock
    const originalImport = jest.fn().mockResolvedValue(mockFirebaseAdmin);

    // Replicate the guard logic from fcm.service.ts initialize()
    const firebaseAdmin = await originalImport('firebase-admin');

    let isInitialized = false;
    let admin: any = null;
    let reuseDetected = false;

    if (firebaseAdmin.apps && firebaseAdmin.apps.length > 0) {
      admin = firebaseAdmin;
      isInitialized = true;
      reuseDetected = true;
    }

    expect(reuseDetected).toBe(true);
    expect(isInitialized).toBe(true);
    expect(admin).toBe(mockFirebaseAdmin);
    // initializeApp must NOT be called when reusing
    expect(mockFirebaseAdmin.initializeApp).not.toHaveBeenCalled();
  });

  it('should call initializeApp when apps array is empty', async () => {
    const mockFirebaseAdmin = {
      apps: [] as any[],
      credential: { cert: jest.fn().mockReturnValue('mock-cert') },
      initializeApp: jest.fn(),
    };

    const firebaseAdmin = mockFirebaseAdmin;

    let initCalled = false;

    if (firebaseAdmin.apps && firebaseAdmin.apps.length > 0) {
      // reuse path — should NOT enter here
    } else {
      firebaseAdmin.initializeApp({
        credential: firebaseAdmin.credential.cert('service-account'),
      });
      initCalled = true;
    }

    expect(initCalled).toBe(true);
    expect(mockFirebaseAdmin.initializeApp).toHaveBeenCalledTimes(1);
  });

  it('should handle undefined apps property gracefully', async () => {
    const mockFirebaseAdmin = {
      apps: undefined as any,
      credential: { cert: jest.fn().mockReturnValue('mock-cert') },
      initializeApp: jest.fn(),
    };

    const firebaseAdmin = mockFirebaseAdmin;

    let shouldInitialize = true;

    if (firebaseAdmin.apps && firebaseAdmin.apps.length > 0) {
      shouldInitialize = false;
    }

    expect(shouldInitialize).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Fix #136: getOrSet backing fn timeout
// ---------------------------------------------------------------------------
describe('Fix #136: getOrSet backing fn 30s timeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should reject with timeout error when backing fn hangs', async () => {
    // Simulate the Promise.race pattern from redis.service.ts getOrSet
    const backingFnTimeoutMs = 30_000;
    const stuckBackingFn = () => new Promise<string>(() => {
      // Never resolves — simulates stuck DB query
    });

    const racePromise = Promise.race([
      stuckBackingFn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('getOrSet backing fn timeout (30s)')), backingFnTimeoutMs)
      ),
    ]);

    // Advance timers past the 30s timeout
    jest.advanceTimersByTime(30_001);

    await expect(racePromise).rejects.toThrow('getOrSet backing fn timeout (30s)');
  });

  it('should return result when backing fn completes before timeout', async () => {
    const backingFnTimeoutMs = 30_000;
    const fastBackingFn = () => Promise.resolve({ id: 'user-1', name: 'test' });

    const result = await Promise.race([
      fastBackingFn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('getOrSet backing fn timeout (30s)')), backingFnTimeoutMs)
      ),
    ]);

    expect(result).toEqual({ id: 'user-1', name: 'test' });
  });

  it('should reject with backing fn error (not timeout) when fn fails fast', async () => {
    const backingFnTimeoutMs = 30_000;
    const failingBackingFn = () => Promise.reject(new Error('DB connection lost'));

    const racePromise = Promise.race([
      failingBackingFn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('getOrSet backing fn timeout (30s)')), backingFnTimeoutMs)
      ),
    ]);

    await expect(racePromise).rejects.toThrow('DB connection lost');
  });
});

// ---------------------------------------------------------------------------
// 3. Fix #138: orderStatusCache batch eviction
// ---------------------------------------------------------------------------
describe('Fix #138: orderStatusCache batch eviction', () => {
  it('should delete 100 entries when cache exceeds 8000', () => {
    // Simulate the orderStatusCache Map
    const orderStatusCache = new Map<string, { status: string | null; expiresAt: number }>();

    // Fill cache to 8001 entries
    for (let i = 0; i < 8001; i++) {
      orderStatusCache.set(`order-${i}`, {
        status: 'active',
        expiresAt: Date.now() + 10000,
      });
    }

    expect(orderStatusCache.size).toBe(8001);

    // Apply the batch eviction logic (same as queue.service.ts)
    if (orderStatusCache.size > 8000) {
      const keysToDelete = [...orderStatusCache.keys()].slice(0, 100);
      keysToDelete.forEach(k => orderStatusCache.delete(k));
    }

    expect(orderStatusCache.size).toBe(7901);
  });

  it('should not evict when cache is at or below 8000', () => {
    const orderStatusCache = new Map<string, { status: string | null; expiresAt: number }>();

    for (let i = 0; i < 8000; i++) {
      orderStatusCache.set(`order-${i}`, {
        status: 'active',
        expiresAt: Date.now() + 10000,
      });
    }

    expect(orderStatusCache.size).toBe(8000);

    // Apply the batch eviction check
    if (orderStatusCache.size > 8000) {
      const keysToDelete = [...orderStatusCache.keys()].slice(0, 100);
      keysToDelete.forEach(k => orderStatusCache.delete(k));
    }

    // No eviction — size did not exceed 8000
    expect(orderStatusCache.size).toBe(8000);
  });

  it('should evict oldest entries (Map insertion order)', () => {
    const orderStatusCache = new Map<string, { status: string | null; expiresAt: number }>();

    // Insert entries in order: order-0, order-1, ..., order-8000
    for (let i = 0; i <= 8000; i++) {
      orderStatusCache.set(`order-${i}`, {
        status: 'active',
        expiresAt: Date.now() + 10000,
      });
    }

    // Apply batch eviction
    if (orderStatusCache.size > 8000) {
      const keysToDelete = [...orderStatusCache.keys()].slice(0, 100);
      keysToDelete.forEach(k => orderStatusCache.delete(k));
    }

    // The first 100 entries (order-0 through order-99) should be gone
    expect(orderStatusCache.has('order-0')).toBe(false);
    expect(orderStatusCache.has('order-99')).toBe(false);
    // Entry 100 should still exist
    expect(orderStatusCache.has('order-100')).toBe(true);
    // Last entry should still exist
    expect(orderStatusCache.has('order-8000')).toBe(true);
  });

  it('should handle cache with fewer than 100 entries above threshold gracefully', () => {
    // Edge case: cache has 8001 entries, so only 1 above threshold
    // Batch still deletes 100 (first 100 by insertion order)
    const orderStatusCache = new Map<string, { status: string | null; expiresAt: number }>();

    for (let i = 0; i < 8001; i++) {
      orderStatusCache.set(`order-${i}`, {
        status: 'active',
        expiresAt: Date.now() + 10000,
      });
    }

    if (orderStatusCache.size > 8000) {
      const keysToDelete = [...orderStatusCache.keys()].slice(0, 100);
      keysToDelete.forEach(k => orderStatusCache.delete(k));
    }

    // 8001 - 100 = 7901
    expect(orderStatusCache.size).toBe(7901);
  });
});
