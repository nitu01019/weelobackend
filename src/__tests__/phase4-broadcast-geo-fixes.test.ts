/**
 * =============================================================================
 * PHASE 4 — BROADCAST + GEO FIX VERIFICATION TESTS
 * =============================================================================
 *
 * Source-scanning tests that verify fix patterns exist in the codebase.
 *
 * C3:  GEORADIUS online check (availability-geo.service.ts)
 *      - smIsMembers call exists in getAvailableTransportersWithDetails
 *      - REDIS_KEYS.ONLINE_TRANSPORTERS is used
 *      - Filter removes offline transporters
 *      - geoRemove for stale entries
 *
 * H4:  GEORADIUS COUNT 250 (real-redis.client.ts + environment.ts)
 *      - Default is 250 in real-redis.client.ts
 *      - GEO_QUERY_MAX_CANDIDATES exists in environment.ts
 *      - Monolithic redis.service.ts has same change
 *
 * H6:  Personalized retry cache (order-broadcast.service.ts)
 *      - personalizedPayloadCache Map exists
 *      - cache.set during initial send
 *      - cache.get during retry
 *
 * M6:  sAddWithExpire failure logging (order-broadcast.service.ts)
 *      - .catch has logger.warn (not empty)
 *
 * M9:  DB fallback for SMEMBERS (order-broadcast.service.ts)
 *      - .catch has DB fallback query
 *      - logger.warn on Redis failure
 *
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');

function readSource(relativePath: string): string {
  const fullPath = path.join(ROOT, relativePath);
  return fs.readFileSync(fullPath, 'utf-8');
}

// Pre-load all source files once to avoid repeated I/O
const availabilityGeoSource = readSource('shared/services/availability-geo.service.ts');
const realRedisClientSource = readSource('shared/services/redis/real-redis.client.ts');
const environmentSource = readSource('config/environment.ts');
const monolithicRedisServiceSource = readSource('shared/services/redis.service.ts');
const orderBroadcastSource = readSource('modules/order/order-broadcast.service.ts');

// =============================================================================
// C3: GEORADIUS ONLINE CHECK (availability-geo.service.ts)
// =============================================================================

describe('C3: GEORADIUS online check in availability-geo.service.ts', () => {

  test('smIsMembers is called in getAvailableTransportersWithDetails', () => {
    // The function must use smIsMembers to batch-check online status
    // instead of individual sIsMember calls per transporter
    const fnBody = extractFunctionBody(
      availabilityGeoSource,
      'getAvailableTransportersWithDetails'
    );
    expect(fnBody).toContain('smIsMembers');
  });

  test('REDIS_KEYS.ONLINE_TRANSPORTERS is used in smIsMembers call', () => {
    // Verify the online check uses the correct Redis key
    expect(availabilityGeoSource).toMatch(
      /smIsMembers\s*\(\s*REDIS_KEYS\.ONLINE_TRANSPORTERS/
    );
  });

  test('smIsMembers is also called in getAvailableTransportersAsync', () => {
    // Both async functions need the online check
    const fnBody = extractFunctionBody(
      availabilityGeoSource,
      'getAvailableTransportersAsync'
    );
    expect(fnBody).toContain('smIsMembers');
  });

  test('offline transporters are filtered out (onlineFlags[i] check)', () => {
    // There must be a check that uses the onlineFlags array
    // to skip transporters whose flag is false
    expect(availabilityGeoSource).toMatch(/if\s*\(\s*!onlineFlags\[i\]/);
  });

  test('geoRemove is called for offline transporters (stale entry cleanup)', () => {
    // When a transporter is offline, their geo entry should be removed
    // to prevent them from appearing in future queries
    const offlineBlock = availabilityGeoSource.match(
      /if\s*\(\s*!onlineFlags\[i\]\)[\s\S]*?geoRemove/
    );
    expect(offlineBlock).not.toBeNull();
  });

  test('geoRemove uses the correct geo key pattern', () => {
    // The geo key must use REDIS_KEYS.GEO_TRANSPORTERS(vehicleKey)
    expect(availabilityGeoSource).toMatch(
      /geoRemove\s*\(\s*\n?\s*REDIS_KEYS\.GEO_TRANSPORTERS\(vehicleKey\)/
    );
  });

  test('fail-open: smIsMembers failure defaults all flags to true', () => {
    // If Redis SMISMEMBER fails, all transporters should be treated as online
    // (fail-open) so broadcasts are not silently dropped
    expect(availabilityGeoSource).toMatch(
      /onlineFlags\s*=\s*transporterIds\.map\(\s*\(\)\s*=>\s*true\s*\)/
    );
  });

  test('REDIS_KEYS.ONLINE_TRANSPORTERS is imported from availability-types', () => {
    // Ensure the constant comes from the shared types file
    expect(availabilityGeoSource).toMatch(
      /import\s*\{[^}]*REDIS_KEYS[^}]*\}\s*from\s*['"]\.\/availability-types['"]/
    );
  });

  test('stale entries with no details are cleaned up (geoRemove + sRem)', () => {
    // When a transporter has no details in the hash, both geo and set
    // entries should be cleaned up to prevent ghost candidates
    const staleCleanup = availabilityGeoSource.match(
      /Object\.keys\(details\)\.length\s*===\s*0[\s\S]*?geoRemove[\s\S]*?sRem/
    );
    expect(staleCleanup).not.toBeNull();
  });

  test('isOnTrip check prevents in-transit transporters from being returned', () => {
    // Transporters currently on a trip should not appear in results
    expect(availabilityGeoSource).toMatch(/details\.isOnTrip\s*===\s*['"]true['"]/);
  });
});

// =============================================================================
// H4: GEORADIUS COUNT 250 (real-redis.client.ts + environment.ts)
// =============================================================================

describe('H4: GEORADIUS COUNT default 250', () => {

  describe('environment.ts', () => {
    test('GEO_QUERY_MAX_CANDIDATES config exists', () => {
      expect(environmentSource).toContain('GEO_QUERY_MAX_CANDIDATES');
    });

    test('default value is 250', () => {
      // Should use getNumber('GEO_QUERY_MAX_CANDIDATES', 250)
      expect(environmentSource).toMatch(
        /getNumber\s*\(\s*['"]GEO_QUERY_MAX_CANDIDATES['"]\s*,\s*250\s*\)/
      );
    });

    test('config property is geoQueryMaxCandidates', () => {
      expect(environmentSource).toMatch(
        /geoQueryMaxCandidates\s*:\s*getNumber/
      );
    });
  });

  describe('real-redis.client.ts', () => {
    test('geoRadius method uses config.geoQueryMaxCandidates', () => {
      expect(realRedisClientSource).toMatch(
        /config\.geoQueryMaxCandidates/
      );
    });

    test('geoRadius has COUNT parameter with default 250 fallback', () => {
      // The method signature should have count parameter with default
      expect(realRedisClientSource).toMatch(
        /geoRadius\s*\([^)]*count\s*[:=]\s*[^)]*(?:config\.geoQueryMaxCandidates\s*\|\|\s*250|250)/
      );
    });

    test('GEOSEARCH command includes COUNT argument', () => {
      expect(realRedisClientSource).toMatch(
        /geosearch[\s\S]*?'COUNT'\s*,\s*count/
      );
    });

    test('GEORADIUS fallback includes COUNT argument', () => {
      expect(realRedisClientSource).toMatch(
        /georadius[\s\S]*?'COUNT'\s*,\s*count/
      );
    });
  });

  describe('monolithic redis.service.ts', () => {
    test('geoRadius method uses config.geoQueryMaxCandidates', () => {
      expect(monolithicRedisServiceSource).toMatch(
        /config\.geoQueryMaxCandidates/
      );
    });

    test('geoRadius has COUNT parameter with default 250 fallback', () => {
      expect(monolithicRedisServiceSource).toMatch(
        /geoRadius\s*\([^)]*count\s*[:=]\s*[^)]*(?:config\.geoQueryMaxCandidates\s*\|\|\s*250|250)/
      );
    });

    test('GEOSEARCH command includes COUNT argument', () => {
      expect(monolithicRedisServiceSource).toMatch(
        /geosearch[\s\S]*?'COUNT'\s*,\s*count/
      );
    });

    test('GEORADIUS fallback includes COUNT argument', () => {
      expect(monolithicRedisServiceSource).toMatch(
        /georadius[\s\S]*?'COUNT'\s*,\s*count/
      );
    });
  });
});

// =============================================================================
// H6: PERSONALIZED RETRY CACHE (order-broadcast.service.ts)
// =============================================================================

describe('H6: Personalized retry cache in order-broadcast.service.ts', () => {

  test('personalizedPayloadCache Map is declared', () => {
    expect(orderBroadcastSource).toMatch(
      /personalizedPayloadCache\s*=\s*new\s+Map/
    );
  });

  test('personalizedPayloadCache type is Map<string, Record<string, unknown>>', () => {
    // Verify the cache is properly typed
    expect(orderBroadcastSource).toMatch(
      /personalizedPayloadCache\s*=\s*new\s+Map<\s*string\s*,/
    );
  });

  test('personalized payload is stored in cache during initial send (.set)', () => {
    // During the initial broadcast loop, each transporter's personalized
    // payload must be cached for potential retry use
    expect(orderBroadcastSource).toMatch(
      /personalizedPayloadCache\.set\s*\(\s*transporterId/
    );
  });

  test('cached payload is retrieved during retry (.get)', () => {
    // During retry, the cached personalized payload should be used
    // instead of the generic extendedBroadcast
    expect(orderBroadcastSource).toMatch(
      /personalizedPayloadCache\.get\s*\(\s*transporterId\s*\)/
    );
  });

  test('retry falls back to extendedBroadcast if cache miss', () => {
    // If the cache somehow misses, use extendedBroadcast as fallback
    expect(orderBroadcastSource).toMatch(
      /personalizedPayloadCache\.get\s*\(\s*transporterId\s*\)\s*\|\|\s*extendedBroadcast/
    );
  });

  test('retry payload includes _retry: true flag', () => {
    // Retry sends should be tagged so recipients can distinguish them
    expect(orderBroadcastSource).toMatch(/_retry\s*:\s*true/);
  });

  test('H6 fix comment is present for documentation', () => {
    expect(orderBroadcastSource).toContain('H6 FIX');
  });

  test('personalized payload includes trucksYouCanProvide', () => {
    // The personalized broadcast must include per-transporter fields
    expect(orderBroadcastSource).toMatch(
      /personalizedBroadcast\s*=\s*\{[\s\S]*?trucksYouCanProvide/
    );
  });

  test('personalized payload includes pickupDistanceKm', () => {
    expect(orderBroadcastSource).toMatch(
      /personalizedBroadcast\s*=\s*\{[\s\S]*?pickupDistanceKm/
    );
  });
});

// =============================================================================
// M6: sAddWithExpire FAILURE LOGGING (order-broadcast.service.ts)
// =============================================================================

describe('M6: sAddWithExpire failure logging in order-broadcast.service.ts', () => {

  test('sAddWithExpire has a .catch handler', () => {
    expect(orderBroadcastSource).toMatch(
      /sAddWithExpire\s*\([^)]*\)\s*\.catch/
    );
  });

  test('.catch handler calls logger.warn (not empty)', () => {
    // The catch handler must log the error, not silently swallow it
    // Extract the sAddWithExpire + catch block
    const catchBlock = orderBroadcastSource.match(
      /sAddWithExpire\s*\([^)]*\)\s*\.catch\s*\(\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\}\s*\)/
    );
    expect(catchBlock).not.toBeNull();
    expect(catchBlock![0]).toContain('logger.warn');
  });

  test('error message is extracted safely (instanceof Error check)', () => {
    // The catch handler should safely extract the error message
    const catchBlock = orderBroadcastSource.match(
      /sAddWithExpire[\s\S]*?\.catch\s*\(\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\}\s*\)/
    );
    expect(catchBlock).not.toBeNull();
    expect(catchBlock![0]).toMatch(/instanceof\s+Error/);
  });

  test('log message includes orderId context', () => {
    // The warning should include the orderId for debugging
    const catchBlock = orderBroadcastSource.match(
      /sAddWithExpire[\s\S]*?\.catch\s*\(\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\}\s*\)/
    );
    expect(catchBlock).not.toBeNull();
    expect(catchBlock![0]).toMatch(/orderId/);
  });
});

// =============================================================================
// M9: DB FALLBACK FOR SMEMBERS (order-broadcast.service.ts)
// =============================================================================

describe('M9: DB fallback for SMEMBERS in order-broadcast.service.ts', () => {

  test('getNotifiedTransporters function exists', () => {
    expect(orderBroadcastSource).toMatch(
      /(?:export\s+)?(?:async\s+)?function\s+getNotifiedTransporters/
    );
  });

  test('sMembers has a .catch handler', () => {
    // The sMembers call should have error handling
    const fnBody = extractFunctionBody(
      orderBroadcastSource,
      'getNotifiedTransporters'
    );
    expect(fnBody).toMatch(/sMembers\s*\([^)]*\)\s*\.catch/);
  });

  test('.catch handler calls logger.warn on Redis failure', () => {
    const fnBody = extractFunctionBody(
      orderBroadcastSource,
      'getNotifiedTransporters'
    );
    expect(fnBody).toContain('logger.warn');
  });

  test('DB fallback queries truck requests by order (getTruckRequestsByOrder)', () => {
    // When Redis fails, the fallback should query the database
    const fnBody = extractFunctionBody(
      orderBroadcastSource,
      'getNotifiedTransporters'
    );
    expect(fnBody).toContain('getTruckRequestsByOrder');
  });

  test('DB fallback extracts notifiedTransporters from truck requests', () => {
    // The fallback should aggregate notifiedTransporters from all truck requests
    const fnBody = extractFunctionBody(
      orderBroadcastSource,
      'getNotifiedTransporters'
    );
    expect(fnBody).toContain('notifiedTransporters');
  });

  test('DB fallback returns array (converted to Set by caller)', () => {
    // The catch handler should return an array that the caller wraps in a Set
    const fnBody = extractFunctionBody(
      orderBroadcastSource,
      'getNotifiedTransporters'
    );
    expect(fnBody).toMatch(/Array\.from\(.*\)/);
  });

  test('double-catch: inner DB failure returns empty array (fail-open)', () => {
    // If both Redis AND DB fail, return empty array so broadcast continues
    const fnBody = extractFunctionBody(
      orderBroadcastSource,
      'getNotifiedTransporters'
    );
    // Should have a nested catch that returns []
    expect(fnBody).toMatch(/catch[\s\S]*?\[\s*\]/);
  });

  test('log message includes Broadcast context identifier', () => {
    const fnBody = extractFunctionBody(
      orderBroadcastSource,
      'getNotifiedTransporters'
    );
    expect(fnBody).toMatch(/\[Broadcast\]/);
  });

  test('log includes orderId and error message', () => {
    const fnBody = extractFunctionBody(
      orderBroadcastSource,
      'getNotifiedTransporters'
    );
    expect(fnBody).toContain('orderId');
    expect(fnBody).toMatch(/error/i);
  });
});

// =============================================================================
// CROSS-CUTTING: Verify all fix references are present
// =============================================================================

describe('Cross-cutting: fix comments and documentation', () => {

  test('availability-geo.service.ts imports smIsMembers from redis', () => {
    // The service must import from redisService which exposes smIsMembers
    expect(availabilityGeoSource).toMatch(
      /import\s*\{[^}]*redisService[^}]*\}\s*from/
    );
  });

  test('environment.ts exports config object with geoQueryMaxCandidates', () => {
    expect(environmentSource).toMatch(
      /export\s+const\s+config\s*=/
    );
    expect(environmentSource).toContain('geoQueryMaxCandidates');
  });

  test('order-broadcast.service.ts retry has 2s backoff', () => {
    // H4 retry fix: 2 second delay before retry
    expect(orderBroadcastSource).toMatch(
      /setTimeout\s*\(\s*resolve\s*,\s*2000\s*\)/
    );
  });

  test('order-broadcast.service.ts uses Promise.allSettled for retry', () => {
    // Retry should use allSettled so one failure does not block others
    expect(orderBroadcastSource).toMatch(
      /Promise\.allSettled\s*\(\s*\n?\s*enqueueFailedTransporters\.map/
    );
  });

  test('markTransportersNotified TTL includes +180 buffer', () => {
    // The dedup TTL formula: Math.ceil(BROADCAST_TIMEOUT_MS / 1000) + BROADCAST_DEDUP_TTL_BUFFER_SECONDS (= 180)
    expect(orderBroadcastSource).toMatch(
      /Math\.ceil\s*\(\s*BROADCAST_TIMEOUT_MS\s*\/\s*1000\s*\)\s*\+\s*BROADCAST_DEDUP_TTL_BUFFER_SECONDS/
    );
  });
});

// =============================================================================
// HELPER: Extract function body from source text
// =============================================================================

/**
 * Extracts the body of a named function from source text.
 * Handles both `function name(` and `async function name(` patterns.
 * Returns the full function body including braces.
 */
function extractFunctionBody(source: string, functionName: string): string {
  // Find the function declaration
  const regex = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${functionName}\\s*\\(`,
    'g'
  );
  const match = regex.exec(source);
  if (!match) {
    return '';
  }

  // Find the opening brace of the function body
  let pos = match.index + match[0].length;
  let depth = 0;
  let foundOpenBrace = false;

  // Skip past the parameter list to find the opening {
  while (pos < source.length) {
    if (source[pos] === '{' && !foundOpenBrace) {
      foundOpenBrace = true;
      depth = 1;
      pos++;
      break;
    }
    pos++;
  }

  if (!foundOpenBrace) return '';

  const bodyStart = pos;

  // Track brace depth to find the matching closing brace
  while (pos < source.length && depth > 0) {
    const char = source[pos];
    if (char === '{') depth++;
    else if (char === '}') depth--;
    pos++;
  }

  return source.slice(bodyStart, pos);
}
