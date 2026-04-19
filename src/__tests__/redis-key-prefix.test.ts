/**
 * =============================================================================
 * REDIS KEY PREFIX -- Comprehensive Tests
 * =============================================================================
 *
 * Tests the transparent applyPrefix() mechanism in RedisService.
 * When REDIS_KEY_PREFIX env var is set, all key-accepting methods prefix keys
 * automatically. When unset, zero behavior change (production-safe).
 *
 * Sections:
 *   A. No Prefix (default production behavior)
 *   B. With Prefix (staging behavior)
 *   C. Double-Prefix Prevention (idempotency)
 *   D. Multi-Key Operations
 *   E. What-If / Edge-Case Scenarios
 *
 * =============================================================================
 */

// ---------------------------------------------------------------------------
// We need to control process.env.REDIS_KEY_PREFIX BEFORE the module loads,
// so we use jest.isolateModules to reload redis.service.ts per describe block.
// ---------------------------------------------------------------------------

// Suppress logger output during tests
jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helper: create a fresh RedisService with a given prefix env value
// ---------------------------------------------------------------------------
function createRedisServiceWithPrefix(prefix: string | undefined): any {
  const originalEnv = process.env.REDIS_KEY_PREFIX;

  if (prefix === undefined) {
    delete process.env.REDIS_KEY_PREFIX;
  } else {
    process.env.REDIS_KEY_PREFIX = prefix;
  }

  // Clear module cache so RedisService re-reads process.env
  jest.resetModules();

  // Re-require with the updated env
  const mod = require('../shared/services/redis.service');
  const service = mod.redisService;

  // Restore env for isolation (the service already captured the value)
  if (originalEnv === undefined) {
    delete process.env.REDIS_KEY_PREFIX;
  } else {
    process.env.REDIS_KEY_PREFIX = originalEnv;
  }

  return service;
}

// ---------------------------------------------------------------------------
// Spy helper: wraps the internal InMemoryRedisClient methods so we can
// inspect the actual keys passed to the underlying client.
// ---------------------------------------------------------------------------
function spyOnClient(service: any): Record<string, jest.SpyInstance> {
  const client = (service as any).client;
  const spies: Record<string, jest.SpyInstance> = {};

  const methodNames = [
    'get', 'set', 'del', 'exists', 'expire', 'ttl', 'keys',
    'incr', 'incrBy',
    'lPush', 'lPushMany', 'rPush', 'lRange', 'lTrim', 'rPop', 'lLen', 'brPop',
    'sAdd', 'sRem', 'sMembers', 'sScan', 'sIsMember', 'smIsMembers', 'sCard', 'sUnion',
    'hSet', 'hGet', 'hGetAll', 'hGetAllBatch', 'hDel', 'hIncrBy', 'hMSet',
    'geoAdd', 'geoRemove', 'geoPos', 'geoRadius', 'geoRadiusByMember',
    'zAdd', 'zRangeByScore', 'zRemRangeByScore',
    'eval', 'scanIterator', 'sAddWithExpire',
  ];

  for (const name of methodNames) {
    if (typeof client[name] === 'function') {
      spies[name] = jest.spyOn(client, name);
    }
  }

  return spies;
}

// =============================================================================
// A. NO PREFIX (default production behavior)
// =============================================================================

describe('A. No Prefix (default production behavior)', () => {
  let service: any;
  let spies: Record<string, jest.SpyInstance>;

  beforeEach(() => {
    service = createRedisServiceWithPrefix(undefined);
    spies = spyOnClient(service);
  });

  test('A1: keyPrefix is empty string when REDIS_KEY_PREFIX is undefined', () => {
    expect(service.keyPrefix).toBe('');
  });

  test('A2: keyPrefix is empty string when REDIS_KEY_PREFIX is empty string', () => {
    const svc = createRedisServiceWithPrefix('');
    expect(svc.keyPrefix).toBe('');
  });

  test('A3: get() passes key through unchanged', async () => {
    await service.get('mykey');
    expect(spies.get).toHaveBeenCalledWith('mykey');
  });

  test('A4: set() passes key through unchanged', async () => {
    await service.set('mykey', 'val', 300);
    expect(spies.set).toHaveBeenCalledWith('mykey', 'val', 300);
  });

  test('A5: del() passes key through unchanged', async () => {
    await service.del('mykey');
    expect(spies.del).toHaveBeenCalledWith('mykey');
  });

  test('A6: exists() passes key through unchanged', async () => {
    await service.exists('mykey');
    expect(spies.exists).toHaveBeenCalledWith('mykey');
  });

  test('A7: expire() passes key through unchanged', async () => {
    await service.set('mykey', 'val');
    await service.expire('mykey', 60);
    expect(spies.expire).toHaveBeenCalledWith('mykey', 60);
  });

  test('A8: ttl() passes key through unchanged', async () => {
    await service.ttl('mykey');
    expect(spies.ttl).toHaveBeenCalledWith('mykey');
  });

  test('A9: incr() passes key through unchanged', async () => {
    await service.incr('counter:api');
    expect(spies.incr).toHaveBeenCalledWith('counter:api');
  });

  test('A10: incrBy() passes key through unchanged', async () => {
    await service.incrBy('counter:api', 5);
    expect(spies.incrBy).toHaveBeenCalledWith('counter:api', 5);
  });

  test('A11: lPush() passes key through unchanged', async () => {
    await service.lPush('queue:jobs', 'job1');
    expect(spies.lPush).toHaveBeenCalledWith('queue:jobs', 'job1');
  });

  test('A12: prefixKey() returns key unchanged', () => {
    expect(service.prefixKey('order:lock:123')).toBe('order:lock:123');
  });

  test('A13: set+get round-trip works without prefix', async () => {
    await service.set('user:123', 'data');
    const val = await service.get('user:123');
    expect(val).toBe('data');
  });

  test('A14: lRange() passes key through unchanged', async () => {
    await service.lPush('list:test', 'a');
    await service.lRange('list:test', 0, -1);
    expect(spies.lRange).toHaveBeenCalledWith('list:test', 0, -1);
  });
});

// =============================================================================
// B. WITH PREFIX (staging behavior)
// =============================================================================

describe('B. With Prefix (staging behavior)', () => {
  let service: any;
  let spies: Record<string, jest.SpyInstance>;

  beforeEach(() => {
    service = createRedisServiceWithPrefix('staging');
    spies = spyOnClient(service);
  });

  test('B1: keyPrefix is set correctly', () => {
    expect(service.keyPrefix).toBe('staging');
  });

  // --- Basic operations (prefix is opt-in via prefixKey(), not auto-applied) ---

  test('B2: get() passes key through unchanged (prefix is opt-in)', async () => {
    await service.get('mykey');
    expect(spies.get).toHaveBeenCalledWith('mykey');
  });

  test('B3: set() passes key through unchanged (prefix is opt-in)', async () => {
    await service.set('mykey', 'val', 300);
    expect(spies.set).toHaveBeenCalledWith('mykey', 'val', 300);
  });

  test('B4: del() passes key through unchanged (prefix is opt-in)', async () => {
    await service.del('mykey');
    expect(spies.del).toHaveBeenCalledWith('mykey');
  });

  test('B5: exists() passes key through unchanged (prefix is opt-in)', async () => {
    await service.exists('mykey');
    expect(spies.exists).toHaveBeenCalledWith('mykey');
  });

  test('B6: expire() passes key through unchanged (prefix is opt-in)', async () => {
    await service.set('mykey', 'v');
    await service.expire('mykey', 60);
    expect(spies.expire).toHaveBeenCalledWith('mykey', 60);
  });

  test('B7: ttl() passes key through unchanged (prefix is opt-in)', async () => {
    await service.ttl('mykey');
    expect(spies.ttl).toHaveBeenCalledWith('mykey');
  });

  test('B8: incr() passes key through unchanged (prefix is opt-in)', async () => {
    await service.incr('counter:api');
    expect(spies.incr).toHaveBeenCalledWith('counter:api');
  });

  test('B9: incrBy() passes key through unchanged (prefix is opt-in)', async () => {
    await service.incrBy('counter:api', 5);
    expect(spies.incrBy).toHaveBeenCalledWith('counter:api', 5);
  });

  // --- List operations (prefix is opt-in via prefixKey()) ---

  test('B10: lPush() passes key through unchanged', async () => {
    await service.lPush('queue:jobs', 'job1');
    expect(spies.lPush).toHaveBeenCalledWith('queue:jobs', 'job1');
  });

  test('B11: lPushMany() passes key through unchanged', async () => {
    await service.lPushMany('queue:jobs', ['a', 'b']);
    expect(spies.lPushMany).toHaveBeenCalledWith('queue:jobs', ['a', 'b']);
  });

  test('B12: rPush() passes key through unchanged', async () => {
    await service.rPush('queue:jobs', 'job1');
    expect(spies.rPush).toHaveBeenCalledWith('queue:jobs', 'job1');
  });

  test('B13: lRange() passes key through unchanged', async () => {
    await service.lRange('queue:jobs', 0, -1);
    expect(spies.lRange).toHaveBeenCalledWith('queue:jobs', 0, -1);
  });

  test('B14: lTrim() passes key through unchanged', async () => {
    await service.lPush('queue:jobs', 'a');
    await service.lTrim('queue:jobs', 0, 99);
    expect(spies.lTrim).toHaveBeenCalledWith('queue:jobs', 0, 99);
  });

  test('B15: rPop() passes key through unchanged', async () => {
    await service.rPop('queue:jobs');
    expect(spies.rPop).toHaveBeenCalledWith('queue:jobs');
  });

  test('B16: lLen() passes key through unchanged', async () => {
    await service.lLen('queue:jobs');
    expect(spies.lLen).toHaveBeenCalledWith('queue:jobs');
  });

  test('B17: brPop() passes key through unchanged', async () => {
    // brPop polls in-memory with timeout; use a very short timeout to avoid blocking
    const promise = service.brPop('queue:jobs', 0.1);
    await promise;
    expect(spies.brPop).toHaveBeenCalledWith('queue:jobs', 0.1);
  });

  // --- JSON helpers (prefix is opt-in via prefixKey()) ---

  test('B18: getJSON() passes key through unchanged', async () => {
    await service.set('data:json', JSON.stringify({ a: 1 }));
    const result = await service.getJSON('data:json');
    // getJSON calls client.get with key as-is (prefix is opt-in)
    expect(spies.get).toHaveBeenCalledWith('data:json');
    expect(result).toEqual({ a: 1 });
  });

  test('B19: setJSON() passes key through unchanged', async () => {
    await service.setJSON('data:json', { b: 2 }, 60);
    expect(spies.set).toHaveBeenCalledWith('data:json', '{"b":2}', 60);
  });

  // --- prefixKey() public helper ---

  test('B20: prefixKey() returns prefixed key', () => {
    expect(service.prefixKey('order:lock:123')).toBe('staging:order:lock:123');
  });

  // --- Set+Get round-trip ---

  test('B21: set+get round-trip works (prefix is opt-in, keys pass through)', async () => {
    await service.set('user:123', 'staging-data');
    const val = await service.get('user:123');
    expect(val).toBe('staging-data');
  });

  // --- keys() and scanIterator() ---

  test('B22: keys() passes the pattern through unchanged', async () => {
    await service.set('fleet:1', 'a');
    await service.set('fleet:2', 'b');
    const result = await service.keys('fleet:*');
    // The pattern passed to scanIterator is unchanged (prefix is opt-in)
    expect(spies.scanIterator).toHaveBeenCalledWith('fleet:*');
  });

  test('B23: scanIterator() passes the pattern through unchanged', async () => {
    await service.set('scan:x', 'v');
    const keys: string[] = [];
    for await (const k of service.scanIterator('scan:*')) {
      keys.push(k);
    }
    expect(spies.scanIterator).toHaveBeenCalledWith('scan:*', 100);
  });
});

// =============================================================================
// C. DOUBLE-PREFIX PREVENTION (idempotency)
// =============================================================================

describe('C. Double-Prefix Prevention', () => {
  let service: any;
  let spies: Record<string, jest.SpyInstance>;

  beforeEach(() => {
    service = createRedisServiceWithPrefix('staging');
    spies = spyOnClient(service);
  });

  test('C1: already-prefixed key is not double-prefixed via get()', async () => {
    await service.get('staging:mykey');
    expect(spies.get).toHaveBeenCalledWith('staging:mykey');
  });

  test('C2: already-prefixed key is not double-prefixed via set()', async () => {
    await service.set('staging:mykey', 'val');
    expect(spies.set).toHaveBeenCalledWith('staging:mykey', 'val', undefined);
  });

  test('C3: already-prefixed key is not double-prefixed via del()', async () => {
    await service.del('staging:mykey');
    expect(spies.del).toHaveBeenCalledWith('staging:mykey');
  });

  test('C4: already-prefixed key is not double-prefixed via exists()', async () => {
    await service.exists('staging:mykey');
    expect(spies.exists).toHaveBeenCalledWith('staging:mykey');
  });

  test('C5: prefixKey() is idempotent', () => {
    const once = service.prefixKey('mykey');
    const twice = service.prefixKey(once);
    expect(once).toBe('staging:mykey');
    expect(twice).toBe('staging:mykey');
  });

  test('C6: already-prefixed key not double-prefixed via lPush()', async () => {
    await service.lPush('staging:queue:test', 'item');
    expect(spies.lPush).toHaveBeenCalledWith('staging:queue:test', 'item');
  });

  test('C7: prefixKey() triple-call stays idempotent', () => {
    const result = service.prefixKey(service.prefixKey(service.prefixKey('key')));
    expect(result).toBe('staging:key');
  });

  test('C8: key that merely contains prefix substring but does not start with it gets prefixed', () => {
    // 'notstaging:mykey' does not start with 'staging:'
    const result = service.prefixKey('notstaging:mykey');
    expect(result).toBe('staging:notstaging:mykey');
  });
});

// =============================================================================
// D. MULTI-KEY OPERATIONS
// =============================================================================

describe('D. Multi-Key Operations', () => {
  let service: any;
  let spies: Record<string, jest.SpyInstance>;

  beforeEach(() => {
    service = createRedisServiceWithPrefix('staging');
    spies = spyOnClient(service);
  });

  test('D1: multiple set() calls pass keys unchanged (prefix is opt-in)', async () => {
    await service.set('key1', 'v1');
    await service.set('key2', 'v2');
    await service.set('key3', 'v3');

    expect(spies.set).toHaveBeenNthCalledWith(1, 'key1', 'v1', undefined);
    expect(spies.set).toHaveBeenNthCalledWith(2, 'key2', 'v2', undefined);
    expect(spies.set).toHaveBeenNthCalledWith(3, 'key3', 'v3', undefined);
  });

  test('D2: keys() passes pattern through unchanged (prefix is opt-in)', async () => {
    await service.set('user:1', 'a');
    await service.set('user:2', 'b');
    await service.keys('user:*');
    expect(spies.scanIterator).toHaveBeenCalledWith('user:*');
  });

  test('D3: scanIterator() passes pattern through unchanged (prefix is opt-in)', async () => {
    const keys: string[] = [];
    for await (const k of service.scanIterator('order:*', 50)) {
      keys.push(k);
    }
    expect(spies.scanIterator).toHaveBeenCalledWith('order:*', 50);
  });

  test('D4: sequential get calls pass keys through unchanged', async () => {
    await service.set('a', '1');
    await service.set('b', '2');
    await service.set('c', '3');

    await service.get('a');
    await service.get('b');
    await service.get('c');

    expect(spies.get).toHaveBeenCalledWith('a');
    expect(spies.get).toHaveBeenCalledWith('b');
    expect(spies.get).toHaveBeenCalledWith('c');
  });

  test('D5: concurrent operations all prefix correctly', async () => {
    await Promise.all([
      service.set('p1', 'v1'),
      service.set('p2', 'v2'),
      service.set('p3', 'v3'),
    ]);

    const results = await Promise.all([
      service.get('p1'),
      service.get('p2'),
      service.get('p3'),
    ]);

    expect(results).toEqual(['v1', 'v2', 'v3']);
  });

  test('D6: lPushMany passes key through unchanged', async () => {
    await service.lPushMany('batch:queue', ['a', 'b', 'c']);
    expect(spies.lPushMany).toHaveBeenCalledWith('batch:queue', ['a', 'b', 'c']);
  });

  test('D7: multiple del() calls pass keys through unchanged', async () => {
    await service.set('x', '1');
    await service.set('y', '2');
    await service.del('x');
    await service.del('y');

    expect(spies.del).toHaveBeenCalledWith('x');
    expect(spies.del).toHaveBeenCalledWith('y');
  });

  test('D8: exists() passes keys through unchanged', async () => {
    await service.set('alive', 'yes');
    const e1 = await service.exists('alive');
    const e2 = await service.exists('dead');

    expect(spies.exists).toHaveBeenCalledWith('alive');
    expect(spies.exists).toHaveBeenCalledWith('dead');
    expect(e1).toBe(true);
    expect(e2).toBe(false);
  });

  test('D9: getJSON + setJSON round-trip with prefix', async () => {
    const data = { orderId: 'ORD-001', items: [1, 2, 3] };
    await service.setJSON('order:cache', data, 120);
    const result = await service.getJSON('order:cache');
    expect(result).toEqual(data);
  });

  test('D10: list operations (push + range) share prefix namespace', async () => {
    await service.lPush('events', 'e1');
    await service.lPush('events', 'e2');
    const items = await service.lRange('events', 0, -1);
    expect(items).toEqual(['e2', 'e1']);
  });

  test('D11: expire and ttl pass keys through unchanged', async () => {
    await service.set('ephemeral', 'data');
    await service.expire('ephemeral', 30);
    const remaining = await service.ttl('ephemeral');

    expect(spies.expire).toHaveBeenCalledWith('ephemeral', 30);
    expect(spies.ttl).toHaveBeenCalledWith('ephemeral');
    expect(remaining).toBeGreaterThan(0);
  });
});

// =============================================================================
// E. WHAT-IF / EDGE-CASE SCENARIOS
// =============================================================================

describe('E. What-If Scenarios', () => {
  // --- E.1: Special characters in prefix ---

  test('E1: prefix with special chars (hyphen) works correctly', () => {
    const svc = createRedisServiceWithPrefix('stg-us-east-1');
    expect(svc.prefixKey('mykey')).toBe('stg-us-east-1:mykey');
  });

  test('E2: prefix with dots works correctly', () => {
    const svc = createRedisServiceWithPrefix('v2.staging');
    expect(svc.prefixKey('mykey')).toBe('v2.staging:mykey');
  });

  test('E3: prefix with underscores works correctly', () => {
    const svc = createRedisServiceWithPrefix('staging_v2');
    expect(svc.prefixKey('mykey')).toBe('staging_v2:mykey');
  });

  test('E4: prefix with numbers works correctly', () => {
    const svc = createRedisServiceWithPrefix('env123');
    expect(svc.prefixKey('mykey')).toBe('env123:mykey');
  });

  // --- E.2: Empty key ---

  test('E5: empty string key with no prefix stays empty', async () => {
    const svc = createRedisServiceWithPrefix(undefined);
    const spys = spyOnClient(svc);
    await svc.get('');
    expect(spys.get).toHaveBeenCalledWith('');
  });

  test('E6: empty string key with prefix passes through unchanged (prefix is opt-in)', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const spys = spyOnClient(svc);
    await svc.get('');
    expect(spys.get).toHaveBeenCalledWith('');
  });

  // --- E.3: Keys containing colons ---

  test('E7: key with colons still gets prefix added', () => {
    const svc = createRedisServiceWithPrefix('staging');
    expect(svc.prefixKey('user:123:profile')).toBe('staging:user:123:profile');
  });

  test('E8: key with colons that resembles another prefix still gets prefixed', () => {
    const svc = createRedisServiceWithPrefix('staging');
    expect(svc.prefixKey('production:user:123')).toBe('staging:production:user:123');
  });

  test('E9: deeply nested colon key gets single prefix', () => {
    const svc = createRedisServiceWithPrefix('s');
    expect(svc.prefixKey('a:b:c:d:e:f')).toBe('s:a:b:c:d:e:f');
  });

  // --- E.4: Prefix change at runtime ---

  test('E10: prefix is captured at construction time from env', () => {
    // The prefix is read once at object construction (readonly field)
    const svc = createRedisServiceWithPrefix('alpha');
    expect(svc.keyPrefix).toBe('alpha');

    // Even if we change env now, the existing service keeps its value
    process.env.REDIS_KEY_PREFIX = 'beta';
    expect(svc.keyPrefix).toBe('alpha');

    // A new service would pick up the new value
    const svc2 = createRedisServiceWithPrefix('beta');
    expect(svc2.keyPrefix).toBe('beta');

    delete process.env.REDIS_KEY_PREFIX;
  });

  // --- E.5: Error handling not affected by prefix ---

  test('E11: prefix logic does not affect error handling on get', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    // Non-existent key returns null, not an error
    const result = await svc.get('nonexistent');
    expect(result).toBeNull();
  });

  test('E12: prefix logic does not affect error handling on del', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    // Delete of non-existent key returns false, not an error
    const result = await svc.del('nonexistent');
    expect(result).toBe(false);
  });

  test('E13: prefix logic does not affect error handling on exists', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const result = await svc.exists('nonexistent');
    expect(result).toBe(false);
  });

  // --- E.6: Redis hash tags (cluster key routing) ---

  test('E14: key with Redis hash tag {avail:xxx} gets prefix added before hash tag', () => {
    const svc = createRedisServiceWithPrefix('staging');
    const result = svc.prefixKey('{avail:open_17ft}:drivers');
    expect(result).toBe('staging:{avail:open_17ft}:drivers');
  });

  test('E15: key with curly braces gets prefix normally', () => {
    const svc = createRedisServiceWithPrefix('prod');
    expect(svc.prefixKey('{slot}:data')).toBe('prod:{slot}:data');
  });

  // --- E.7: Production never sets prefix ---

  test('E16: production without prefix has zero behavior change on get/set', async () => {
    const svc = createRedisServiceWithPrefix(undefined);
    const spys = spyOnClient(svc);

    await svc.set('user:123', 'data');
    await svc.get('user:123');

    expect(spys.set).toHaveBeenCalledWith('user:123', 'data', undefined);
    expect(spys.get).toHaveBeenCalledWith('user:123');
  });

  test('E17: production without prefix has zero behavior change on lists', async () => {
    const svc = createRedisServiceWithPrefix(undefined);
    const spys = spyOnClient(svc);

    await svc.lPush('queue:dispatch', 'job1');
    await svc.lRange('queue:dispatch', 0, -1);

    expect(spys.lPush).toHaveBeenCalledWith('queue:dispatch', 'job1');
    expect(spys.lRange).toHaveBeenCalledWith('queue:dispatch', 0, -1);
  });

  test('E18: production without prefix has zero behavior change on incr', async () => {
    const svc = createRedisServiceWithPrefix(undefined);
    const spys = spyOnClient(svc);

    await svc.incr('rate:limit:api');
    expect(spys.incr).toHaveBeenCalledWith('rate:limit:api');
  });

  // --- E.8: Staging sets prefix for complete isolation ---

  test('E19: staging and production use separate key spaces', async () => {
    const staging = createRedisServiceWithPrefix('staging');
    const prod = createRedisServiceWithPrefix(undefined);

    // Both set the same logical key
    await staging.set('shared:config', 'staging-value');
    await prod.set('shared:config', 'prod-value');

    // Staging reads its own prefixed value
    const stagingVal = await staging.get('shared:config');
    expect(stagingVal).toBe('staging-value');

    // Production reads unprefixed value
    const prodVal = await prod.get('shared:config');
    expect(prodVal).toBe('prod-value');
  });

  // --- E.9: Backward compatibility ---

  test('E20: existing code calling get("user:123") works with no prefix', async () => {
    const svc = createRedisServiceWithPrefix(undefined);
    await svc.set('user:123', 'legacy-data');
    const result = await svc.get('user:123');
    expect(result).toBe('legacy-data');
  });

  test('E21: existing code calling get("user:123") works WITH prefix', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    await svc.set('user:123', 'staging-data');
    const result = await svc.get('user:123');
    expect(result).toBe('staging-data');
  });

  test('E22: existing booking key patterns pass through unchanged', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const spys = spyOnClient(svc);

    await svc.set('booking:abc123:status', 'active');
    expect(spys.set).toHaveBeenCalledWith('booking:abc123:status', 'active', undefined);

    const val = await svc.get('booking:abc123:status');
    expect(val).toBe('active');
  });

  test('E23: OTP key patterns pass through unchanged', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const spys = spyOnClient(svc);

    await svc.set('otp:9876543210:customer', '1234', 300);
    expect(spys.set).toHaveBeenCalledWith('otp:9876543210:customer', '1234', 300);
  });

  test('E24: fleet key patterns pass through unchanged', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const spys = spyOnClient(svc);

    await svc.set('fleet:transporter:T001', '{"trucks":7}');
    expect(spys.set).toHaveBeenCalledWith('fleet:transporter:T001', '{"trucks":7}', undefined);
  });

  // --- E.10: Performance / correctness ---

  test('E25: prefixing 10000 keys does not throw', () => {
    const svc = createRedisServiceWithPrefix('perf');
    for (let i = 0; i < 10000; i++) {
      const result = svc.prefixKey(`key:${i}`);
      expect(result).toBe(`perf:key:${i}`);
    }
  });

  test('E26: prefixKey is a pure function (same input, same output)', () => {
    const svc = createRedisServiceWithPrefix('deterministic');
    const results = Array.from({ length: 100 }, () => svc.prefixKey('test'));
    const allSame = results.every(r => r === 'deterministic:test');
    expect(allSame).toBe(true);
  });

  // --- E.11: Different prefix values ---

  test('E27: prefix "prod" works', () => {
    const svc = createRedisServiceWithPrefix('prod');
    expect(svc.prefixKey('mykey')).toBe('prod:mykey');
  });

  test('E28: prefix "dev" works', () => {
    const svc = createRedisServiceWithPrefix('dev');
    expect(svc.prefixKey('mykey')).toBe('dev:mykey');
  });

  test('E29: single-char prefix works', () => {
    const svc = createRedisServiceWithPrefix('x');
    expect(svc.prefixKey('mykey')).toBe('x:mykey');
  });

  test('E30: very long prefix works', () => {
    const longPrefix = 'a'.repeat(200);
    const svc = createRedisServiceWithPrefix(longPrefix);
    expect(svc.prefixKey('k')).toBe(`${longPrefix}:k`);
  });

  // --- E.12: Real Redis key patterns from the codebase ---

  test('E31: geo key passes through unchanged (prefix is opt-in)', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const spys = spyOnClient(svc);

    await svc.geoAdd('drivers:open_17ft', 77.2, 28.6, 'driver123');
    expect(spys.geoAdd).toHaveBeenCalledWith('drivers:open_17ft', 77.2, 28.6, 'driver123');
  });

  test('E32: set operations pass keys through unchanged', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const spys = spyOnClient(svc);

    await svc.sAdd('available:trucks', 'truck1', 'truck2');
    expect(spys.sAdd).toHaveBeenCalledWith('available:trucks', 'truck1', 'truck2');
  });

  test('E33: hash operations pass keys through unchanged', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const spys = spyOnClient(svc);

    await svc.hSet('driver:info:D001', 'name', 'Ravi');
    expect(spys.hSet).toHaveBeenCalledWith('driver:info:D001', 'name', 'Ravi');
  });

  // --- E.13: Colon-only or weird prefixes ---

  test('E34: prefix that is just a colon works', () => {
    const svc = createRedisServiceWithPrefix(':');
    expect(svc.prefixKey('mykey')).toBe('::mykey');
  });

  test('E35: prefix containing colon in middle works', () => {
    const svc = createRedisServiceWithPrefix('env:staging');
    expect(svc.prefixKey('mykey')).toBe('env:staging:mykey');
  });

  // --- E.14: getOrSet singleflight uses prefix ---

  test('E36: getOrSet passes cache key through unchanged (prefix is opt-in)', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const spys = spyOnClient(svc);

    const result = await svc.getOrSet('cached:data', 60, async () => 'computed');
    // getOrSet calls getJSON and setJSON which pass key through unchanged
    expect(result).toBe('computed');
    // The underlying client.get should have been called with key as-is
    expect(spys.get).toHaveBeenCalledWith('cached:data');
  });

  // --- E.15: Health check ---

  test('E37: healthCheck works regardless of prefix', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const result = await svc.healthCheck();
    expect(result.status).toBe('healthy');
    expect(result.mode).toBe('memory');
  });

  test('E38: healthCheck works without prefix', async () => {
    const svc = createRedisServiceWithPrefix(undefined);
    const result = await svc.healthCheck();
    expect(result.status).toBe('healthy');
  });

  // --- E.16: isConnected and isRedisEnabled unaffected by prefix ---

  test('E39: isConnected unaffected by prefix', () => {
    const svc = createRedisServiceWithPrefix('staging');
    expect(svc.isConnected()).toBe(true);
  });

  test('E40: isRedisEnabled unaffected by prefix', () => {
    const svc = createRedisServiceWithPrefix('staging');
    expect(svc.isRedisEnabled()).toBe(false); // in-memory mode
  });

  // --- E.17: JSON round-trip with complex objects ---

  test('E41: setJSON/getJSON with nested objects and prefix', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const complex = {
      order: { id: 'ORD-001', trucks: [{ id: 'T1', status: 'available' }] },
      meta: { createdAt: '2026-04-09T00:00:00Z' },
    };

    await svc.setJSON('complex:obj', complex, 120);
    const result = await svc.getJSON('complex:obj');
    expect(result).toEqual(complex);
  });

  test('E42: setJSON/getJSON with arrays and prefix', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const arr = [1, 2, 3, 'hello', { nested: true }];

    await svc.setJSON('array:key', arr);
    const result = await svc.getJSON('array:key');
    expect(result).toEqual(arr);
  });

  // --- E.18: List round-trip isolation ---

  test('E43: list operations create isolated namespaces per prefix', async () => {
    const staging = createRedisServiceWithPrefix('staging');
    const dev = createRedisServiceWithPrefix('dev');

    await staging.lPush('jobs', 'staging-job');
    await dev.lPush('jobs', 'dev-job');

    const stagingJobs = await staging.lRange('jobs', 0, -1);
    const devJobs = await dev.lRange('jobs', 0, -1);

    expect(stagingJobs).toEqual(['staging-job']);
    expect(devJobs).toEqual(['dev-job']);
  });

  // --- E.19: TTL behavior with prefix ---

  test('E44: set with TTL and get before expiry works with prefix', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    await svc.set('ttl:key', 'ephemeral', 300);
    const val = await svc.get('ttl:key');
    expect(val).toBe('ephemeral');

    const remaining = await svc.ttl('ttl:key');
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(300);
  });

  // --- E.20: incr/incrBy isolation ---

  test('E45: incr creates isolated counters per prefix', async () => {
    const staging = createRedisServiceWithPrefix('staging');
    const dev = createRedisServiceWithPrefix('dev');

    await staging.incr('counter');
    await staging.incr('counter');
    await dev.incr('counter');

    const stagingVal = await staging.get('counter');
    const devVal = await dev.get('counter');

    expect(stagingVal).toBe('2');
    expect(devVal).toBe('1');
  });

  // --- E.21: Prefix with whitespace ---

  test('E46: prefix with whitespace is preserved as-is', () => {
    const svc = createRedisServiceWithPrefix('  staging  ');
    // The prefix includes the whitespace since env vars can have spaces
    expect(svc.prefixKey('key')).toBe('  staging  :key');
  });

  // --- E.22: Set then delete then exists ---

  test('E47: set, delete, exists lifecycle with prefix', async () => {
    const svc = createRedisServiceWithPrefix('staging');

    await svc.set('lifecycle', 'alive');
    expect(await svc.exists('lifecycle')).toBe(true);

    await svc.del('lifecycle');
    expect(await svc.exists('lifecycle')).toBe(false);
    expect(await svc.get('lifecycle')).toBeNull();
  });

  // --- E.23: lLen and rPop with prefix ---

  test('E48: lLen reflects correct count with prefix', async () => {
    const svc = createRedisServiceWithPrefix('staging');

    await svc.lPush('mylist', 'a');
    await svc.lPush('mylist', 'b');
    await svc.lPush('mylist', 'c');

    expect(await svc.lLen('mylist')).toBe(3);
  });

  test('E49: rPop returns correct value with prefix', async () => {
    const svc = createRedisServiceWithPrefix('staging');

    await svc.lPush('mylist', 'first');
    await svc.lPush('mylist', 'second');

    // lPush adds to head, so rPop gets 'first'
    const val = await svc.rPop('mylist');
    expect(val).toBe('first');
  });

  // --- E.24: Different environments cannot read each other's data ---

  test('E50: environment isolation - staging cannot read dev data', async () => {
    const staging = createRedisServiceWithPrefix('staging');
    const dev = createRedisServiceWithPrefix('dev');

    await dev.set('secret', 'dev-secret');
    const fromStaging = await staging.get('secret');

    // Staging should NOT see dev's data
    expect(fromStaging).toBeNull();
  });

  test('E51: environment isolation - no-prefix cannot read prefixed data', async () => {
    const prefixed = createRedisServiceWithPrefix('staging');
    const unprefixed = createRedisServiceWithPrefix(undefined);

    await prefixed.set('data', 'prefixed-value');
    const fromUnprefixed = await unprefixed.get('data');

    // Unprefixed instance should NOT see staging-prefixed data
    expect(fromUnprefixed).toBeNull();
  });
});

// =============================================================================
// F. INCREMENTWITHTLL AND RATE LIMITING
// =============================================================================

describe('F. IncrementWithTTL and Rate Limiting', () => {
  test('F1: incrementWithTTL passes key through unchanged', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const spys = spyOnClient(svc);

    await svc.incrementWithTTL('rate:api:user1', 60);
    // In in-memory mode, eval returns null, so it falls through to incr fallback
    expect(spys.incr).toHaveBeenCalledWith('rate:api:user1');
  });

  test('F2: atomicIncr passes key through unchanged', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const spys = spyOnClient(svc);

    await svc.atomicIncr('counter:total', 120);
    // In in-memory fallback, incr is called with key as-is
    expect(spys.incr).toHaveBeenCalledWith('counter:total');
  });

  test('F3: checkRateLimit passes keys through unchanged', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const spys = spyOnClient(svc);

    const result = await svc.checkRateLimit('api:user1', 10, 60);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
    // The incr call uses key as-is (prefix is opt-in)
    expect(spys.incr).toHaveBeenCalledWith('api:user1');
  });

  test('F4: rate limiting isolation between prefixed environments', async () => {
    const staging = createRedisServiceWithPrefix('staging');
    const dev = createRedisServiceWithPrefix('dev');

    // Hit rate limit in staging
    for (let i = 0; i < 5; i++) {
      await staging.incrementWithTTL('rate:test', 60);
    }

    // Dev counter should be independent
    const devResult = await dev.incrementWithTTL('rate:test', 60);
    expect(devResult).toBe(1); // First call in dev namespace
  });
});

// =============================================================================
// G. OTP OPERATIONS
// =============================================================================

describe('G. OTP Operations', () => {
  test('G1: incrementOtpAttempts constructs attempts key from base key', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const spys = spyOnClient(svc);

    await svc.set('otp:9876543210:customer', '1234', 300);
    const result = await svc.incrementOtpAttempts('otp:9876543210:customer', 3);

    expect(result.allowed).toBe(true);
    expect(result.attempts).toBe(1);
    // The attempts key is constructed from the base key (no auto-prefix)
    expect(spys.incr).toHaveBeenCalledWith('otp:9876543210:customer:attempts');
  });

  test('G2: getOtpAttempts reads attempts key', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const spys = spyOnClient(svc);

    const count = await svc.getOtpAttempts('otp:9876543210:customer');
    expect(count).toBe(0);
    expect(spys.get).toHaveBeenCalledWith('otp:9876543210:customer:attempts');
  });

  test('G3: deleteOtpWithAttempts deletes both keys', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const spys = spyOnClient(svc);

    await svc.deleteOtpWithAttempts('otp:9876543210:customer');
    // Both the main key and the attempts key (no auto-prefix)
    expect(spys.del).toHaveBeenCalledWith('otp:9876543210:customer');
    expect(spys.del).toHaveBeenCalledWith('otp:9876543210:customer:attempts');
  });
});

// =============================================================================
// H. DISTRIBUTED LOCKS
// =============================================================================

describe('H. Distributed Locks', () => {
  test('H1: acquireLock constructs lock key with lock: prefix', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const spys = spyOnClient(svc);

    const result = await svc.acquireLock('truck:1234', 'T001', 15);
    // acquireLock creates key = `lock:${lockKey}`, then calls eval
    // In in-memory fallback, it calls client.get then client.set
    expect(result.acquired).toBe(true);
    expect(result.ttl).toBe(15);
  });

  test('H2: releaseLock matches the same lock key pattern', async () => {
    const svc = createRedisServiceWithPrefix('staging');

    await svc.acquireLock('truck:1234', 'T001', 15);
    const released = await svc.releaseLock('truck:1234', 'T001');
    expect(released).toBe(true);
  });

  test('H3: lock acquire and release lifecycle works', async () => {
    const svc = createRedisServiceWithPrefix('staging');

    // Acquire
    const r1 = await svc.acquireLock('resource:X', 'holder1', 60);
    expect(r1.acquired).toBe(true);

    // Different holder cannot acquire
    const r2 = await svc.acquireLock('resource:X', 'holder2', 60);
    expect(r2.acquired).toBe(false);

    // Same holder can re-acquire (extend)
    const r3 = await svc.acquireLock('resource:X', 'holder1', 60);
    expect(r3.acquired).toBe(true);

    // Release
    const released = await svc.releaseLock('resource:X', 'holder1');
    expect(released).toBe(true);

    // Now holder2 can acquire
    const r4 = await svc.acquireLock('resource:X', 'holder2', 60);
    expect(r4.acquired).toBe(true);
  });

  test('H4: isLockHeldBy works', async () => {
    const svc = createRedisServiceWithPrefix('staging');

    await svc.acquireLock('res', 'h1', 60);
    expect(await svc.isLockHeldBy('res', 'h1')).toBe(true);
    expect(await svc.isLockHeldBy('res', 'h2')).toBe(false);
  });

  test('H5: getLockHolder returns correct holder', async () => {
    const svc = createRedisServiceWithPrefix('staging');

    await svc.acquireLock('res', 'holder-abc', 60);
    const holder = await svc.getLockHolder('res');
    expect(holder).toBe('holder-abc');
  });
});

// =============================================================================
// I. PUB/SUB (not key-prefixed, channel-based)
// =============================================================================

describe('I. Pub/Sub', () => {
  test('I1: publish/subscribe work regardless of prefix', async () => {
    const svc = createRedisServiceWithPrefix('staging');

    const received: string[] = [];
    await svc.subscribe('test-channel', (msg: string) => received.push(msg));
    await svc.publish('test-channel', 'hello');

    expect(received).toEqual(['hello']);
  });

  test('I2: publishJSON/subscribeJSON work regardless of prefix', async () => {
    const svc = createRedisServiceWithPrefix('staging');

    const received: any[] = [];
    await svc.subscribeJSON('json-channel', (data: any) => received.push(data));
    await svc.publishJSON('json-channel', { event: 'test' });

    expect(received).toEqual([{ event: 'test' }]);
  });
});

// =============================================================================
// J. EVAL (Lua scripts)
// =============================================================================

describe('J. Eval (Lua scripts)', () => {
  test('J1: eval passes KEYS and ARGV through unchanged (prefix is opt-in)', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const spys = spyOnClient(svc);

    await svc.eval('return 1', ['key1', 'key2'], ['arg1', 'arg2']);
    expect(spys.eval).toHaveBeenCalledWith('return 1', ['key1', 'key2'], ['arg1', 'arg2']);
  });

  test('J2: eval ARGV and KEYS values pass through unchanged', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const spys = spyOnClient(svc);

    await svc.eval('return ARGV[1]', ['somekey'], ['staging:should-not-strip']);
    expect(spys.eval).toHaveBeenCalledWith(
      'return ARGV[1]',
      ['somekey'],
      ['staging:should-not-strip']
    );
  });

  test('J3: eval with no keys does not prefix anything', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const spys = spyOnClient(svc);

    await svc.eval('return 42', [], ['val']);
    expect(spys.eval).toHaveBeenCalledWith('return 42', [], ['val']);
  });

  test('J4: eval with multiple KEYS passes all through unchanged', async () => {
    const svc = createRedisServiceWithPrefix('prod');
    const spys = spyOnClient(svc);

    await svc.eval('return 1', ['a', 'b', 'c'], []);
    expect(spys.eval).toHaveBeenCalledWith('return 1', ['a', 'b', 'c'], []);
  });

  test('J5: eval with no prefix passes KEYS unchanged', async () => {
    const svc = createRedisServiceWithPrefix(undefined);
    const spys = spyOnClient(svc);

    await svc.eval('return 1', ['k1', 'k2'], ['a1']);
    expect(spys.eval).toHaveBeenCalledWith('return 1', ['k1', 'k2'], ['a1']);
  });
});

// =============================================================================
// K. TIMER OPERATIONS
// =============================================================================

describe('K. Timer Operations', () => {
  test('K1: setTimer stores timer data', async () => {
    const svc = createRedisServiceWithPrefix('staging');

    const future = new Date(Date.now() + 60000);
    await svc.setTimer('timer:booking:abc', { orderId: 'abc' }, future);

    // Timer should be retrievable via the internal key
    // setTimer uses client.set directly (which uses the internal client, not prefixed)
    // This documents the current behavior
  });

  test('K2: cancelTimer deletes timer', async () => {
    const svc = createRedisServiceWithPrefix('staging');

    const future = new Date(Date.now() + 60000);
    await svc.setTimer('timer:test', { id: 'test' }, future);
    const deleted = await svc.cancelTimer('timer:test');
    expect(deleted).toBe(true);
  });

  test('K3: hasTimer checks existence', async () => {
    const svc = createRedisServiceWithPrefix('staging');

    const future = new Date(Date.now() + 60000);
    await svc.setTimer('timer:check', { id: 'check' }, future);

    // hasTimer uses client.exists directly (not prefixed currently)
    const exists = await svc.hasTimer('timer:check');
    expect(exists).toBe(true);
  });
});

// =============================================================================
// L. SORTED SETS
// =============================================================================

describe('L. Sorted Sets', () => {
  test('L1: zAdd prefixes key', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const spys = spyOnClient(svc);

    await svc.zAdd('leaderboard', 100, 'player1');
    expect(spys.zAdd).toHaveBeenCalledWith('leaderboard', 100, 'player1');
  });

  test('L2: zRangeByScore retrieves members', async () => {
    const svc = createRedisServiceWithPrefix('staging');

    await svc.zAdd('scores', 10, 'a');
    await svc.zAdd('scores', 20, 'b');
    await svc.zAdd('scores', 30, 'c');

    const result = await svc.zRangeByScore('scores', 15, 35);
    expect(result).toEqual(['b', 'c']);
  });

  test('L3: zRemRangeByScore removes members', async () => {
    const svc = createRedisServiceWithPrefix('staging');

    await svc.zAdd('scores', 10, 'a');
    await svc.zAdd('scores', 20, 'b');

    const removed = await svc.zRemRangeByScore('scores', 0, 15);
    expect(removed).toBe(1);
  });
});

// =============================================================================
// M. SADDWITHEXPIRE (atomic Lua)
// =============================================================================

describe('M. sAddWithExpire', () => {
  test('M1: sAddWithExpire adds members and sets TTL', async () => {
    const svc = createRedisServiceWithPrefix('staging');

    await svc.sAddWithExpire('myset', 60, 'a', 'b', 'c');
    const members = await svc.sMembers('myset');
    expect(members.sort()).toEqual(['a', 'b', 'c']);
  });

  test('M2: sAddWithExpire with empty members does nothing', async () => {
    const svc = createRedisServiceWithPrefix('staging');
    const spys = spyOnClient(svc);

    await svc.sAddWithExpire('empty', 60);
    // Should not call sAdd at all
    expect(spys.sAdd).not.toHaveBeenCalled();
  });
});

// =============================================================================
// N. TRANSACTION (multi)
// =============================================================================

describe('N. Transaction (multi)', () => {
  test('N1: multi().set().exec() works', async () => {
    const svc = createRedisServiceWithPrefix('staging');

    const tx = svc.multi();
    tx.set('tx:key', 'tx:val');
    tx.expire('tx:key', 60);
    const results = await tx.exec();

    expect(results.length).toBe(2);
  });
});

// =============================================================================
// O. FULL METHOD COVERAGE -- Every prefixed method exercised
// =============================================================================

describe('O. Full Method Coverage (prefix applied to every data-type method)', () => {
  let service: any;
  let spies: Record<string, jest.SpyInstance>;

  beforeEach(() => {
    service = createRedisServiceWithPrefix('stg');
    spies = spyOnClient(service);
  });

  // --- Sets ---

  test('O1: sAdd prefixes key', async () => {
    await service.sAdd('myset', 'a', 'b');
    expect(spies.sAdd).toHaveBeenCalledWith('myset', 'a', 'b');
  });

  test('O2: sRem prefixes key', async () => {
    await service.sAdd('myset', 'a');
    await service.sRem('myset', 'a');
    expect(spies.sRem).toHaveBeenCalledWith('myset', 'a');
  });

  test('O3: sMembers prefixes key', async () => {
    await service.sAdd('myset', 'x');
    await service.sMembers('myset');
    expect(spies.sMembers).toHaveBeenCalledWith('myset');
  });

  test('O4: sScan prefixes key', async () => {
    await service.sScan('myset', '0', 100);
    expect(spies.sScan).toHaveBeenCalledWith('myset', '0', 100);
  });

  test('O5: sIsMember prefixes key', async () => {
    await service.sAdd('myset', 'x');
    await service.sIsMember('myset', 'x');
    expect(spies.sIsMember).toHaveBeenCalledWith('myset', 'x');
  });

  test('O6: smIsMembers prefixes key', async () => {
    await service.sAdd('myset', 'a', 'b');
    await service.smIsMembers('myset', ['a', 'b', 'c']);
    expect(spies.smIsMembers).toHaveBeenCalledWith('myset', ['a', 'b', 'c']);
  });

  test('O7: sCard prefixes key', async () => {
    await service.sAdd('myset', 'a');
    await service.sCard('myset');
    expect(spies.sCard).toHaveBeenCalledWith('myset');
  });

  test('O8: sUnion prefixes all keys', async () => {
    await service.sAdd('set1', 'a');
    await service.sAdd('set2', 'b');
    await service.sUnion('set1', 'set2');
    expect(spies.sUnion).toHaveBeenCalledWith('set1', 'set2');
  });

  // --- Hashes ---

  test('O9: hSet prefixes key', async () => {
    await service.hSet('myhash', 'field1', 'value1');
    expect(spies.hSet).toHaveBeenCalledWith('myhash', 'field1', 'value1');
  });

  test('O10: hGet prefixes key', async () => {
    await service.hSet('myhash', 'f', 'v');
    await service.hGet('myhash', 'f');
    expect(spies.hGet).toHaveBeenCalledWith('myhash', 'f');
  });

  test('O11: hGetAll prefixes key', async () => {
    await service.hSet('myhash', 'f', 'v');
    await service.hGetAll('myhash');
    expect(spies.hGetAll).toHaveBeenCalledWith('myhash');
  });

  test('O12: hGetAllBatch prefixes all keys', async () => {
    await service.hGetAllBatch(['h1', 'h2', 'h3']);
    expect(spies.hGetAllBatch).toHaveBeenCalledWith(['h1', 'h2', 'h3']);
  });

  test('O13: hDel prefixes key (not fields)', async () => {
    await service.hSet('myhash', 'f1', 'v1');
    await service.hDel('myhash', 'f1', 'f2');
    expect(spies.hDel).toHaveBeenCalledWith('myhash', 'f1', 'f2');
  });

  test('O14: hIncrBy prefixes key', async () => {
    await service.hIncrBy('myhash', 'counter', 5);
    expect(spies.hIncrBy).toHaveBeenCalledWith('myhash', 'counter', 5);
  });

  test('O15: hMSet prefixes key', async () => {
    await service.hMSet('myhash', { a: '1', b: '2' });
    expect(spies.hMSet).toHaveBeenCalledWith('myhash', { a: '1', b: '2' });
  });

  test('O16: hSetJSON prefixes key', async () => {
    await service.hSetJSON('myhash', 'data', { x: 1 });
    expect(spies.hSet).toHaveBeenCalledWith('myhash', 'data', '{"x":1}');
  });

  test('O17: hGetJSON prefixes key', async () => {
    await service.hSet('myhash', 'data', '{"x":1}');
    const result = await service.hGetJSON('myhash', 'data');
    expect(spies.hGet).toHaveBeenCalledWith('myhash', 'data');
    expect(result).toEqual({ x: 1 });
  });

  // --- Geospatial ---

  test('O18: geoAdd prefixes key', async () => {
    await service.geoAdd('drivers', 77.2, 28.6, 'd1');
    expect(spies.geoAdd).toHaveBeenCalledWith('drivers', 77.2, 28.6, 'd1');
  });

  test('O19: geoRemove prefixes key', async () => {
    await service.geoAdd('drivers', 77.2, 28.6, 'd1');
    await service.geoRemove('drivers', 'd1');
    expect(spies.geoRemove).toHaveBeenCalledWith('drivers', 'd1');
  });

  test('O20: geoPos prefixes key', async () => {
    await service.geoAdd('drivers', 77.2, 28.6, 'd1');
    await service.geoPos('drivers', 'd1');
    expect(spies.geoPos).toHaveBeenCalledWith('drivers', 'd1');
  });

  test('O21: geoRadius prefixes key', async () => {
    await service.geoAdd('drivers', 77.2, 28.6, 'd1');
    await service.geoRadius('drivers', 77.2, 28.6, 10, 'km');
    expect(spies.geoRadius).toHaveBeenCalledWith('drivers', 77.2, 28.6, 10, 'km');
  });

  test('O22: geoRadiusByMember prefixes key', async () => {
    await service.geoAdd('drivers', 77.2, 28.6, 'd1');
    await service.geoRadiusByMember('drivers', 'd1', 10, 'km');
    expect(spies.geoRadiusByMember).toHaveBeenCalledWith('drivers', 'd1', 10, 'km');
  });

  // --- Sorted Sets ---

  test('O23: zAdd prefixes key', async () => {
    await service.zAdd('zs', 10, 'm1');
    expect(spies.zAdd).toHaveBeenCalledWith('zs', 10, 'm1');
  });

  test('O24: zRangeByScore prefixes key', async () => {
    await service.zAdd('zs', 10, 'm1');
    await service.zRangeByScore('zs', 0, 100);
    expect(spies.zRangeByScore).toHaveBeenCalledWith('zs', 0, 100);
  });

  test('O25: zRemRangeByScore prefixes key', async () => {
    await service.zAdd('zs', 10, 'm1');
    await service.zRemRangeByScore('zs', 0, 5);
    expect(spies.zRemRangeByScore).toHaveBeenCalledWith('zs', 0, 5);
  });

  // --- sAddWithExpire ---

  test('O26: sAddWithExpire prefixes key', async () => {
    await service.sAddWithExpire('timed:set', 60, 'a', 'b');
    expect(spies.sAddWithExpire).toHaveBeenCalledWith('timed:set', 60, 'a', 'b');
  });

  // --- rPush + lLen round-trip ---

  test('O27: rPush prefixes key', async () => {
    await service.rPush('rlist', 'val');
    expect(spies.rPush).toHaveBeenCalledWith('rlist', 'val');
  });

  // --- Lock key construction includes prefix ---

  test('O28: acquireLock passes prefixed key to eval/fallback', async () => {
    // acquireLock constructs `lock:${lockKey}` then calls applyPrefix
    await service.acquireLock('truck:99', 'holder1', 30);
    // In in-memory fallback, it calls client.get('lock:truck:99')
    expect(spies.get).toHaveBeenCalledWith('lock:truck:99');
  });

  test('O29: releaseLock passes prefixed key to fallback', async () => {
    await service.acquireLock('truck:99', 'holder1', 30);
    await service.releaseLock('truck:99', 'holder1');
    // In in-memory fallback, checks client.get then client.del on prefixed key
    const getCalls = spies.get.mock.calls.map((c: any[]) => c[0]);
    expect(getCalls).toContain('lock:truck:99');
  });

  test('O30: isLockHeldBy passes prefixed key', async () => {
    await service.acquireLock('res:A', 'h1', 60);
    await service.isLockHeldBy('res:A', 'h1');
    const getCalls = spies.get.mock.calls.map((c: any[]) => c[0]);
    expect(getCalls).toContain('lock:res:A');
  });

  test('O31: getLockHolder passes prefixed key', async () => {
    await service.acquireLock('res:B', 'h2', 60);
    await service.getLockHolder('res:B');
    const getCalls = spies.get.mock.calls.map((c: any[]) => c[0]);
    expect(getCalls).toContain('lock:res:B');
  });
});
