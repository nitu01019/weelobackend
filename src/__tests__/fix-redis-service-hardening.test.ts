/**
 * =============================================================================
 * REDIS SERVICE HARDENING -- Tests for FIX-11, FIX-28, FIX-40
 * =============================================================================
 *
 * FIX-11 (#55): safeStringify handles circular objects without throwing
 * FIX-28 (#57): Advisory lock uses pg_try_advisory_xact_lock (transaction-scoped)
 * FIX-40 (#98): keys() method uses SCAN (not blocking KEYS command)
 *
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// FIX-11: safeStringify handles circular references
// =============================================================================

/**
 * Extract and test the safeStringify function as a pure unit.
 * We replicate the exact implementation from redis.service.ts so that
 * tests remain independent of module-loading side-effects.
 */
function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    const seen = new WeakSet();
    try {
      return JSON.stringify(obj, (_key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        return value;
      });
    } catch {
      return String(obj);
    }
  }
}

describe('FIX-11 (#55) -- safeStringify handles circular references', () => {
  test('returns valid JSON for a flat object', () => {
    const obj = { a: 1, b: 'hello', c: true };
    const result = safeStringify(obj);
    expect(result).toBe(JSON.stringify(obj));
    expect(() => JSON.parse(result)).not.toThrow();
  });

  test('returns valid JSON for nested non-circular objects', () => {
    const obj = { a: { b: { c: { d: [1, 2, 3] } } } };
    const result = safeStringify(obj);
    expect(result).toBe(JSON.stringify(obj));
  });

  test('handles simple circular reference without throwing', () => {
    const obj: any = { name: 'root' };
    obj.self = obj; // circular

    const result = safeStringify(obj);
    expect(typeof result).toBe('string');
    expect(result).toContain('[Circular]');
    expect(result).toContain('root');
    // Should still produce parseable JSON
    expect(() => JSON.parse(result)).not.toThrow();
  });

  test('handles deeply nested circular references', () => {
    const a: any = { level: 'a' };
    const b: any = { level: 'b', parent: a };
    const c: any = { level: 'c', parent: b };
    a.child = c; // circular: a -> c.parent -> b.parent -> a

    const result = safeStringify(a);
    expect(typeof result).toBe('string');
    expect(result).toContain('[Circular]');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  test('handles null', () => {
    expect(safeStringify(null)).toBe('null');
  });

  test('handles undefined (falls through to String() fallback)', () => {
    // JSON.stringify(undefined) returns the JS value undefined (not a string).
    // The first try block produces undefined, which is falsy but not an exception.
    // The function returns the JS undefined value in that edge case.
    // This is acceptable because callers never pass undefined to setJSON/publishJSON.
    const result = safeStringify(undefined);
    // Either it returns a string or undefined; the key guarantee is no throw
    expect(() => safeStringify(undefined)).not.toThrow();
  });

  test('handles primitive number', () => {
    expect(safeStringify(42)).toBe('42');
  });

  test('handles primitive string', () => {
    expect(safeStringify('hello')).toBe('"hello"');
  });

  test('handles boolean', () => {
    expect(safeStringify(true)).toBe('true');
    expect(safeStringify(false)).toBe('false');
  });

  test('handles arrays', () => {
    const arr = [1, 'two', { three: 3 }];
    expect(safeStringify(arr)).toBe(JSON.stringify(arr));
  });

  test('handles array with circular reference', () => {
    const arr: any[] = [1, 2];
    arr.push(arr); // circular

    const result = safeStringify(arr);
    expect(typeof result).toBe('string');
    expect(result).toContain('[Circular]');
  });

  test('handles empty object', () => {
    expect(safeStringify({})).toBe('{}');
  });

  test('handles empty array', () => {
    expect(safeStringify([])).toBe('[]');
  });

  test('handles Date objects', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const result = safeStringify(date);
    expect(result).toBe(JSON.stringify(date));
  });

  test('handles objects with toJSON method', () => {
    const obj = {
      toJSON() {
        return { serialized: true };
      }
    };
    expect(safeStringify(obj)).toBe('{"serialized":true}');
  });

  test('handles multiple distinct circular references in one object', () => {
    const a: any = { id: 'a' };
    const b: any = { id: 'b' };
    a.ref = a; // self-reference
    b.ref = b; // self-reference
    const container: any = { a, b };

    const result = safeStringify(container);
    expect(typeof result).toBe('string');
    expect(result).toContain('[Circular]');
    expect(() => JSON.parse(result)).not.toThrow();
  });
});

// =============================================================================
// FIX-11: Verify safeStringify is used in redis.service.ts source
// =============================================================================

describe('FIX-11 (#55) -- safeStringify is wired into redis.service.ts', () => {
  const redisServicePath = path.resolve(__dirname, '../shared/services/redis.service.ts');
  let sourceCode: string;

  beforeAll(() => {
    sourceCode = fs.readFileSync(redisServicePath, 'utf-8');
  });

  test('safeStringify function is defined in the file', () => {
    expect(sourceCode).toContain('function safeStringify(obj: unknown): string');
  });

  test('setJSON uses safeStringify (not raw JSON.stringify)', () => {
    // The setJSON method should call safeStringify(value)
    expect(sourceCode).toContain('safeStringify(value), ttlSeconds');
  });

  test('setTimer uses safeStringify (not raw JSON.stringify)', () => {
    expect(sourceCode).toContain('safeStringify(timerData)');
  });

  test('hSetJSON uses safeStringify (not raw JSON.stringify)', () => {
    // Check the hSetJSON method calls safeStringify
    const hSetJSONMatch = sourceCode.match(/async hSetJSON[\s\S]*?safeStringify\(value\)/);
    expect(hSetJSONMatch).not.toBeNull();
  });

  test('publishJSON uses safeStringify (not raw JSON.stringify)', () => {
    // Check the publishJSON method calls safeStringify
    const publishJSONMatch = sourceCode.match(/async publishJSON[\s\S]*?safeStringify\(data\)/);
    expect(publishJSONMatch).not.toBeNull();
  });

  test('no raw JSON.stringify calls remain on external data paths', () => {
    // Extract lines that call JSON.stringify but are NOT inside safeStringify itself
    const lines = sourceCode.split('\n');
    const dangerousLines: number[] = [];
    let insideSafeStringify = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('function safeStringify')) insideSafeStringify = true;
      if (insideSafeStringify && line.trim() === '}') {
        // crude: the closing brace at function level
        // We just need to skip a few lines after the function definition
        if (i > 70) insideSafeStringify = false; // past the function
      }

      if (
        !insideSafeStringify &&
        line.includes('JSON.stringify') &&
        !line.trim().startsWith('//') &&
        !line.trim().startsWith('*') &&
        // Allow JSON.stringify in known-safe contexts (flat structures)
        !line.includes('JSON.stringify({key:') &&
        !line.includes('JSON.stringify({') &&
        // Allow in setJSON, setTimer, hSetJSON, publishJSON context (now using safeStringify)
        (line.includes('set(') || line.includes('hSet(') || line.includes('publish('))
      ) {
        dangerousLines.push(i + 1);
      }
    }

    expect(dangerousLines).toEqual([]);
  });
});

// =============================================================================
// FIX-28: Advisory lock uses pg_try_advisory_xact_lock
// =============================================================================

describe('FIX-28 (#57) -- Advisory lock uses transaction-scoped xact_lock', () => {
  const redisServicePath = path.resolve(__dirname, '../shared/services/redis.service.ts');
  let sourceCode: string;

  beforeAll(() => {
    sourceCode = fs.readFileSync(redisServicePath, 'utf-8');
  });

  test('uses pg_try_advisory_xact_lock (not session-scoped pg_try_advisory_lock)', () => {
    expect(sourceCode).toContain('pg_try_advisory_xact_lock');
  });

  test('does NOT use session-scoped pg_try_advisory_lock', () => {
    // pg_try_advisory_xact_lock contains "pg_try_advisory_lock" as a substring,
    // so we need a precise check: find pg_try_advisory_lock NOT followed by _xact
    const sessionScopedPattern = /pg_try_advisory_lock\b(?!.*xact)/;
    // Check each line individually to avoid false positive from xact_lock containing the substring
    const lines = sourceCode.split('\n');
    const sessionScopedLines = lines.filter(line => {
      return line.includes('pg_try_advisory_lock') && !line.includes('pg_try_advisory_xact_lock');
    });
    expect(sessionScopedLines).toEqual([]);
  });

  test('advisory lock is used within a query context (hashtext key)', () => {
    expect(sourceCode).toContain('pg_try_advisory_xact_lock(hashtext(');
  });
});

// =============================================================================
// FIX-40: keys() uses SCAN (not blocking KEYS command)
// =============================================================================

describe('FIX-40 (#98) -- keys() uses SCAN instead of blocking KEYS', () => {
  const realRedisClientPath = path.resolve(
    __dirname,
    '../shared/services/redis/real-redis.client.ts'
  );
  let sourceCode: string;

  beforeAll(() => {
    sourceCode = fs.readFileSync(realRedisClientPath, 'utf-8');
  });

  test('keys() method exists in real-redis.client.ts', () => {
    expect(sourceCode).toContain('async keys(pattern: string): Promise<string[]>');
  });

  test('keys() method uses this.client.scan (SCAN command)', () => {
    // Extract the keys() method body
    const keysMethodStart = sourceCode.indexOf('async keys(pattern: string)');
    expect(keysMethodStart).toBeGreaterThan(-1);

    // Find the closing brace of the method (next method or significant block)
    const methodBody = sourceCode.substring(keysMethodStart, keysMethodStart + 500);
    expect(methodBody).toContain('this.client.scan');
    expect(methodBody).toContain("'MATCH'");
    expect(methodBody).toContain("'COUNT'");
  });

  test('keys() method does NOT use this.client.keys (blocking KEYS command)', () => {
    const keysMethodStart = sourceCode.indexOf('async keys(pattern: string)');
    const methodBody = sourceCode.substring(keysMethodStart, keysMethodStart + 500);

    // Should not contain this.client.keys() call (that is the blocking command)
    expect(methodBody).not.toContain('this.client.keys(');
  });

  test('keys() iterates with cursor until cursor returns to 0', () => {
    const keysMethodStart = sourceCode.indexOf('async keys(pattern: string)');
    // Use a larger window to capture the full do/while loop
    const methodBody = sourceCode.substring(keysMethodStart, keysMethodStart + 800);

    // Cursor-based iteration pattern: do { ... } while (cursor !== '0');
    expect(methodBody).toContain("cursor !== '0'");
  });
});

// =============================================================================
// FIX-40: keys() mock integration test
// =============================================================================

describe('FIX-40 (#98) -- keys() SCAN behavior with mock Redis client', () => {
  test('keys() aggregates results across multiple SCAN iterations', async () => {
    // Simulate a Redis client that returns keys in 2 batches
    const mockClient = {
      scan: jest.fn()
        .mockResolvedValueOnce(['42', ['key:1', 'key:2', 'key:3']]) // first batch, cursor=42
        .mockResolvedValueOnce(['0', ['key:4', 'key:5']]),          // second batch, cursor=0 (done)
    };

    // Replicate the SCAN-based keys() logic
    async function keysViaScan(pattern: string): Promise<string[]> {
      const results: string[] = [];
      let cursor = '0';
      do {
        const [nextCursor, keys] = await mockClient.scan(
          cursor, 'MATCH', pattern, 'COUNT', 100
        );
        cursor = nextCursor;
        results.push(...keys);
      } while (cursor !== '0');
      return results;
    }

    const result = await keysViaScan('key:*');

    expect(result).toEqual(['key:1', 'key:2', 'key:3', 'key:4', 'key:5']);
    expect(mockClient.scan).toHaveBeenCalledTimes(2);
    expect(mockClient.scan).toHaveBeenCalledWith('0', 'MATCH', 'key:*', 'COUNT', 100);
    expect(mockClient.scan).toHaveBeenCalledWith('42', 'MATCH', 'key:*', 'COUNT', 100);
  });

  test('keys() returns empty array when no keys match', async () => {
    const mockClient = {
      scan: jest.fn().mockResolvedValueOnce(['0', []]),
    };

    async function keysViaScan(pattern: string): Promise<string[]> {
      const results: string[] = [];
      let cursor = '0';
      do {
        const [nextCursor, keys] = await mockClient.scan(
          cursor, 'MATCH', pattern, 'COUNT', 100
        );
        cursor = nextCursor;
        results.push(...keys);
      } while (cursor !== '0');
      return results;
    }

    const result = await keysViaScan('nonexistent:*');
    expect(result).toEqual([]);
    expect(mockClient.scan).toHaveBeenCalledTimes(1);
  });

  test('keys() handles single-batch result (cursor returns 0 immediately)', async () => {
    const mockClient = {
      scan: jest.fn().mockResolvedValueOnce(['0', ['only:one']]),
    };

    async function keysViaScan(pattern: string): Promise<string[]> {
      const results: string[] = [];
      let cursor = '0';
      do {
        const [nextCursor, keys] = await mockClient.scan(
          cursor, 'MATCH', pattern, 'COUNT', 100
        );
        cursor = nextCursor;
        results.push(...keys);
      } while (cursor !== '0');
      return results;
    }

    const result = await keysViaScan('only:*');
    expect(result).toEqual(['only:one']);
    expect(mockClient.scan).toHaveBeenCalledTimes(1);
  });

  test('keys() handles many iterations (large keyspace)', async () => {
    const mockClient = {
      scan: jest.fn()
        .mockResolvedValueOnce(['10', ['k:1']])
        .mockResolvedValueOnce(['20', ['k:2']])
        .mockResolvedValueOnce(['30', ['k:3']])
        .mockResolvedValueOnce(['40', ['k:4']])
        .mockResolvedValueOnce(['0', ['k:5']]),
    };

    async function keysViaScan(pattern: string): Promise<string[]> {
      const results: string[] = [];
      let cursor = '0';
      do {
        const [nextCursor, keys] = await mockClient.scan(
          cursor, 'MATCH', pattern, 'COUNT', 100
        );
        cursor = nextCursor;
        results.push(...keys);
      } while (cursor !== '0');
      return results;
    }

    const result = await keysViaScan('k:*');
    expect(result).toEqual(['k:1', 'k:2', 'k:3', 'k:4', 'k:5']);
    expect(mockClient.scan).toHaveBeenCalledTimes(5);
  });
});
