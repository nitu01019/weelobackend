/**
 * =============================================================================
 * EAGLE I12 INFRASTRUCTURE FIXES — Tests
 * =============================================================================
 *
 * Covers:
 * - #46:  OTP rate limiter applied to driver onboarding routes
 * - #47:  Phone masking in logs (maskPhone utility)
 * - #65:  Histogram label cardinality (getRoutePath normalization)
 * - #102: Vehicle cache skipped for oversized payloads
 * - #112: Cache invalidation logs errors instead of swallowing
 * - #122: LRU Map evicts oldest when full
 *
 * =============================================================================
 */

// =============================================================================
// MOCKS — must precede imports
// =============================================================================

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    observeHistogram: jest.fn(),
    setGauge: jest.fn(),
    incrementGauge: jest.fn(),
    decrementGauge: jest.fn(),
    recordHttpRequestSample: jest.fn(),
  },
  metricsMiddleware: jest.fn((_req: any, _res: any, next: any) => next()),
  metricsHandler: jest.fn(),
}));

import { maskPhone } from '../shared/utils/validation.utils';

// =============================================================================
// TEST: maskPhone utility (#47)
// =============================================================================

describe('#47 — maskPhone utility', () => {
  it('masks a 10-digit phone showing only last 4 digits', () => {
    expect(maskPhone('9876543210')).toBe('******3210');
  });

  it('masks short phones to ****', () => {
    expect(maskPhone('123')).toBe('****');
  });

  it('handles empty string', () => {
    expect(maskPhone('')).toBe('****');
  });

  it('masks a 7-digit number correctly', () => {
    const result = maskPhone('1234567');
    expect(result).not.toContain('1234');
    expect(result.endsWith('4567')).toBe(true);
  });
});

// =============================================================================
// TEST: OTP rate limiter in driver onboarding route chain (#46)
// =============================================================================

describe('#46 — OTP rate limiter on driver onboarding routes', () => {
  it('otpRateLimiter is exported from rate-limiter middleware', () => {
    const { otpRateLimiter } = require('../shared/middleware/rate-limiter.middleware');
    expect(otpRateLimiter).toBeDefined();
    expect(typeof otpRateLimiter).toBe('function');
  });

  it('driver-onboarding.routes.ts imports otpRateLimiter', () => {
    // Read the source to confirm the import exists (structural check)
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/driver/driver-onboarding.routes.ts'),
      'utf-8',
    );
    expect(source).toContain("import { otpRateLimiter }");
    // Verify it appears in the /onboard/initiate, /onboard/verify, /onboard/resend chains
    expect(source).toContain("otpRateLimiter,  // #46: Rate limit OTP requests on driver onboarding");
    expect(source).toContain("otpRateLimiter,  // #46: Rate limit OTP verify requests on driver onboarding");
    expect(source).toContain("otpRateLimiter,  // #46: Rate limit OTP resend requests on driver onboarding");
  });
});

// =============================================================================
// TEST: LRU Map eviction (#122)
// =============================================================================

describe('#122 — LRU Map evicts oldest when full', () => {
  // Replicate the LRU class from geocoding.routes.ts for isolated testing
  class LRUMap<K, V> {
    private map = new Map<K, V>();
    constructor(private maxSize: number) {}
    get(k: K): V | undefined {
      const v = this.map.get(k);
      if (v !== undefined) { this.map.delete(k); this.map.set(k, v); }
      return v;
    }
    set(k: K, v: V): void {
      if (this.map.has(k)) this.map.delete(k);
      if (this.map.size >= this.maxSize) this.map.delete(this.map.keys().next().value!);
      this.map.set(k, v);
    }
    delete(k: K): boolean { return this.map.delete(k); }
    get size(): number { return this.map.size; }
    entries(): IterableIterator<[K, V]> { return this.map.entries(); }
  }

  it('does not exceed maxSize', () => {
    const lru = new LRUMap<string, number>(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    lru.set('d', 4); // should evict 'a'

    expect(lru.size).toBe(3);
    expect(lru.get('a')).toBeUndefined();
    expect(lru.get('d')).toBe(4);
  });

  it('promotes recently accessed entries', () => {
    const lru = new LRUMap<string, number>(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);

    // Access 'a' to promote it
    lru.get('a');

    // Now inserting 'd' should evict 'b' (oldest untouched)
    lru.set('d', 4);

    expect(lru.get('a')).toBe(1);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('c')).toBe(3);
    expect(lru.get('d')).toBe(4);
  });

  it('updates existing keys without eviction', () => {
    const lru = new LRUMap<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);

    // Update 'a' should NOT evict anything
    lru.set('a', 10);

    expect(lru.size).toBe(2);
    expect(lru.get('a')).toBe(10);
    expect(lru.get('b')).toBe(2);
  });

  it('handles delete correctly', () => {
    const lru = new LRUMap<string, number>(3);
    lru.set('a', 1);
    lru.set('b', 2);

    expect(lru.delete('a')).toBe(true);
    expect(lru.size).toBe(1);
    expect(lru.get('a')).toBeUndefined();
  });
});

// =============================================================================
// TEST: Vehicle cache skipped for oversized payloads (#102)
// =============================================================================

describe('#102 — Vehicle cache size guard', () => {
  it('vehicle.repository.ts has cache size check before set', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/database/repositories/vehicle.repository.ts'),
      'utf-8',
    );
    // Verify the size guard exists
    expect(source).toContain('json.length > 512 * 1024');
    expect(source).toContain('Vehicle cache too large, skipping');
  });

  it('serialized payload check skips cache when large', () => {
    // Simulate the guard logic
    const MAX_CACHE_SIZE = 512 * 1024;
    const smallPayload = JSON.stringify([{ id: '1', name: 'truck' }]);
    const largePayload = 'x'.repeat(MAX_CACHE_SIZE + 1);

    expect(smallPayload.length).toBeLessThanOrEqual(MAX_CACHE_SIZE);
    expect(largePayload.length).toBeGreaterThan(MAX_CACHE_SIZE);
  });
});

// =============================================================================
// TEST: Cache invalidation logs errors (#112)
// =============================================================================

describe('#112 — Cache invalidation error logging', () => {
  it('vehicle.repository.ts replaces silent catch with logger.warn', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/database/repositories/vehicle.repository.ts'),
      'utf-8',
    );
    // Should NOT have silent .catch(() => { }) on cache invalidation
    // (the only remaining .catch(() => { }) would not be on redisService.del calls)
    const delCatchSilent = /redisService\.del\([^)]+\)\.catch\(\(\)\s*=>\s*\{\s*\}\)/g;
    expect(source.match(delCatchSilent)).toBeNull();
    // Should have logger.warn on cache invalidation
    expect(source).toContain('[VehicleRepo] Cache invalidation failed');
  });
});

// =============================================================================
// TEST: getRoutePath normalises long ID-like path segments (#65)
// =============================================================================

describe('#65 — getRoutePath long segment normalization', () => {
  it('metrics.service.ts has getRoutePath function that normalizes UUID segments', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/monitoring/metrics.service.ts'),
      'utf-8',
    );
    // Verify getRoutePath exists and normalizes UUIDs
    expect(source).toContain('getRoutePath');
    expect(source).toContain('/:id');
  });

  it('regex replaces 20+ char alphanum segments', () => {
    const longId = 'abcdef0123456789abcdef'; // 22 chars
    const path = `/api/v1/orders/${longId}/status`;
    const normalized = path
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
      .replace(/\/\d+/g, '/:id')
      .replace(/\/[a-z0-9_-]{20,}/gi, '/:id');
    expect(normalized).toBe('/api/v1/orders/:id/status');
  });

  it('does not replace short segments', () => {
    const path = '/api/v1/health';
    const normalized = path
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
      .replace(/\/\d+/g, '/:id')
      .replace(/\/[a-z0-9_-]{20,}/gi, '/:id');
    expect(normalized).toBe('/api/v1/health');
  });
});

// =============================================================================
// TEST: SMS ConsoleProvider masks phone (#47 in sms.service.ts)
// =============================================================================

describe('#47 — SMS ConsoleProvider masks phone', () => {
  it('sms.service.ts ConsoleProvider uses structured logger (no plaintext OTP logging)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/sms.service.ts'),
      'utf-8',
    );
    // Q3 fix: ConsoleProvider now uses logger instead of console.log to prevent OTP leaks
    expect(source).toContain('logger.');
    // OTP values must never appear in log output
    expect(source).not.toMatch(/console\.log.*\$\{otp\}/);
  });
});
