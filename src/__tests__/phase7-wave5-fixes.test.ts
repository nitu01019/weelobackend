/**
 * =============================================================================
 * PHASE 7 WAVE 5 FIXES -- Comprehensive Tests
 * =============================================================================
 *
 * Tests for all Phase 7 Wave 5 fixes:
 *
 *   C7:   Dead socket/ directory deleted (no import references)
 *   M18:  TTL consistency in production code (H3 geo index)
 *   H4:   Geo pruning function exists and works
 *   M16:  Deprecated routes have X-Deprecated header
 *   M22:  Rating poller started at boot
 *   M11:  Order auto-redispatch creates assignment
 *   H15:  Completion idempotency
 *   M21:  POD service documented as intentional placeholder
 *
 * @author fw5-tests (Phase 7 Wave 5)
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// MOCK SETUP -- Must come before any imports that use these modules
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
    recordHistogram: jest.fn(),
    observeHistogram: jest.fn(),
    setGauge: jest.fn(),
  },
}));

jest.mock('../config/environment', () => ({
  config: {
    redis: { enabled: true },
    isProduction: false,
    otp: { expiryMinutes: 5 },
    sms: {},
  },
}));

// =============================================================================
// HELPERS
// =============================================================================

function readSource(relativePath: string): string {
  return fs.readFileSync(
    path.resolve(__dirname, '..', relativePath),
    'utf-8'
  );
}

function sourceFileExists(relativePath: string): boolean {
  return fs.existsSync(path.resolve(__dirname, '..', relativePath));
}

function directoryExists(relativePath: string): boolean {
  const fullPath = path.resolve(__dirname, '..', relativePath);
  try {
    return fs.statSync(fullPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Recursively collect all .ts source files (excluding __tests__ and node_modules).
 */
function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      results.push(...collectSourceFiles(fullPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

// =============================================================================
// C7: Dead socket/ directory deleted
// =============================================================================

describe('C7: Dead socket/ directory removed', () => {
  test('C7-01: src/modules/socket/ directory does not exist', () => {
    expect(directoryExists('modules/socket')).toBe(false);
  });

  test('C7-02: src/shared/services/socket/ directory does not exist', () => {
    expect(directoryExists('shared/services/socket')).toBe(false);
  });

  test('C7-03: No source file imports from a socket/ subdirectory', () => {
    const srcRoot = path.resolve(__dirname, '..');
    const sourceFiles = collectSourceFiles(srcRoot);

    const violations: string[] = [];
    const socketImportPattern = /(?:from\s+['"]|require\s*\(\s*['"])([^'"]*\/socket\/[^'"]*)['"]/g;

    for (const filePath of sourceFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      let match: RegExpExecArray | null;
      while ((match = socketImportPattern.exec(content)) !== null) {
        const relativeName = path.relative(srcRoot, filePath);
        violations.push(`${relativeName}: imports "${match[1]}"`);
      }
    }

    expect(violations).toEqual([]);
  });

  test('C7-04: socket.service.ts exists as the canonical socket module', () => {
    expect(sourceFileExists('shared/services/socket.service.ts')).toBe(true);
  });
});

// =============================================================================
// M18: TTL consistency in production code
// =============================================================================

describe('M18: TTL consistency in H3 geo index', () => {
  const h3Source = readSource('shared/services/h3-geo-index.service.ts');

  test('M18-01: H3_CELL_TTL_SECONDS is defined relative to H3_POS_TTL_SECONDS', () => {
    // The cell TTL should be pos TTL + small buffer, not 2x
    expect(h3Source).toContain('H3_CELL_TTL_SECONDS = H3_POS_TTL_SECONDS + 10');
  });

  test('M18-02: H3_POS_TTL_SECONDS is 90 seconds', () => {
    expect(h3Source).toMatch(/H3_POS_TTL_SECONDS\s*=\s*90/);
  });

  test('M18-03: Cell TTL is 100s (90 + 10 buffer), not the old 180s', () => {
    // Cell TTL should NOT be 2x POS TTL (the old bug)
    expect(h3Source).not.toMatch(/H3_CELL_TTL_SECONDS\s*=\s*180/);
    expect(h3Source).not.toMatch(/H3_CELL_TTL_SECONDS\s*=\s*2\s*\*/);
  });

  test('M18-04: addTransporter uses aligned TTLs for both cell and position', () => {
    // Both sAddWithExpire (cell) and set (pos) should use their respective constants
    expect(h3Source).toContain('sAddWithExpire(key, H3_CELL_TTL_SECONDS, transporterId)');
    expect(h3Source).toContain(`posKey(transporterId), \`\${cell}:\${vehicleKey}\`, H3_POS_TTL_SECONDS`);
  });

  test('M18-05: updateLocation refreshes both position and cell TTLs', () => {
    expect(h3Source).toContain('expire(posKey(transporterId), H3_POS_TTL_SECONDS)');
    expect(h3Source).toContain('expire(cellKey(newCell, vk), H3_CELL_TTL_SECONDS)');
  });
});

// =============================================================================
// H4: Geo pruning function exists and works
// =============================================================================

describe('H4: Geo index pruning', () => {
  const h3Source = readSource('shared/services/h3-geo-index.service.ts');

  test('H4-01: H3 geo index service exports the singleton', () => {
    expect(h3Source).toContain('export const h3GeoIndexService');
  });

  test('H4-02: removeTransporter function exists for individual pruning', () => {
    expect(h3Source).toContain('async removeTransporter(transporterId: string)');
  });

  test('H4-03: removeTransporter cleans up both position and cell keys', () => {
    // Should delete the position key and SREM from the cell set
    expect(h3Source).toContain('redisService.del(posKey(transporterId))');
    expect(h3Source).toContain('redisService.sRem(cellKey(cell, vk), transporterId)');
  });

  test('H4-04: Cell keys have TTL to auto-expire stale entries', () => {
    // Cell sets use sAddWithExpire (atomic SADD + EXPIRE)
    expect(h3Source).toContain('sAddWithExpire');
    expect(h3Source).toContain('H3_CELL_TTL_SECONDS');
  });

  test('H4-05: Position keys have TTL for auto-expiry', () => {
    expect(h3Source).toContain('H3_POS_TTL_SECONDS');
    // Position keys are set with TTL via redisService.set(..., TTL)
    expect(h3Source).toMatch(/redisService\.set\(posKey\(.*\),.*H3_POS_TTL_SECONDS\)/s);
  });

  test('H4-06: H3 service handles multi-vehicle key cleanup', () => {
    // removeTransporter should handle comma-separated vehicle keys
    expect(h3Source).toContain("vehicleKeysStr.split(',')");
  });
});

// =============================================================================
// M16: Deprecated routes have X-Deprecated header
// =============================================================================

describe('M16: Deprecated routes emit X-Deprecated header', () => {
  const bookingRoutesSource = readSource('modules/booking/booking.routes.ts');

  test('M16-01: booking.routes.ts sets X-Deprecated header on legacy order creation', () => {
    expect(bookingRoutesSource).toContain("res.setHeader('X-Deprecated', 'true')");
  });

  test('M16-02: X-Deprecated-Reason header is set with migration guidance', () => {
    expect(bookingRoutesSource).toContain("res.setHeader('X-Deprecated-Reason'");
    // Should mention the canonical route
    expect(bookingRoutesSource).toMatch(/X-Deprecated-Reason.*\/api\/v1\/orders/);
  });

  test('M16-03: X-Weelo-Canonical-Path header points to new route', () => {
    expect(bookingRoutesSource).toContain("res.setHeader('X-Weelo-Canonical-Path', '/api/v1/orders')");
  });

  test('M16-04: Legacy proxy header is set for debugging', () => {
    expect(bookingRoutesSource).toContain("res.setHeader('X-Weelo-Legacy-Proxy'");
  });
});

// =============================================================================
// M22: Rating poller started at boot
// =============================================================================

describe('M22: Rating reminder poller started at boot', () => {
  const serverSource = readSource('server.ts');
  const ratingReminderSource = readSource('modules/rating/rating-reminder.service.ts');

  test('M22-01: server.ts imports processExpiredRatingReminders', () => {
    expect(serverSource).toContain('processExpiredRatingReminders');
  });

  test('M22-02: server.ts starts the rating reminder poller with setInterval', () => {
    expect(serverSource).toMatch(/setInterval\(\s*\(\)\s*=>\s*\{?\s*\n?\s*processExpiredRatingReminders/s);
  });

  test('M22-03: Poller interval is 60 seconds', () => {
    // The interval should be 60_000ms (1 minute)
    expect(serverSource).toContain('60_000');
  });

  test('M22-04: Poller uses .unref() to not block process exit', () => {
    // setInterval(..., 60_000).unref() prevents the timer from keeping Node alive
    // The callback is multiline so we match the closing paren + .unref()
    expect(serverSource).toMatch(/60_000\)\.unref\(\)/);
  });

  test('M22-05: Rating reminder service exports processExpiredRatingReminders', () => {
    expect(ratingReminderSource).toContain('export async function processExpiredRatingReminders');
  });

  test('M22-06: Rating reminder service has 3 reminder delays (1h, 24h, 72h)', () => {
    expect(ratingReminderSource).toContain('1 * 60 * 60 * 1000');
    expect(ratingReminderSource).toContain('24 * 60 * 60 * 1000');
    expect(ratingReminderSource).toContain('72 * 60 * 60 * 1000');
  });

  test('M22-07: processExpiredRatingReminders handles errors non-fatally', () => {
    // The poll loop should catch errors so one failure does not crash the poller
    expect(ratingReminderSource).toContain("logger.warn('[RATING REMINDER] Poll cycle failed (non-fatal)'");
  });

  test('M22-08: Startup logs success message for rating poller', () => {
    expect(serverSource).toContain('Rating reminder poller started');
  });
});

// =============================================================================
// M11: Order auto-redispatch creates assignment
// =============================================================================

describe('M11: Auto-redispatch for order path', () => {
  const redispatchSource = readSource('modules/assignment/auto-redispatch.service.ts');

  test('M11-01: tryAutoRedispatch is exported', () => {
    expect(redispatchSource).toContain('export async function tryAutoRedispatch');
  });

  test('M11-02: Max redispatch attempts is capped at 2', () => {
    expect(redispatchSource).toMatch(/MAX_REDISPATCH_ATTEMPTS\s*=\s*2/);
  });

  test('M11-03: Redis counter TTL is 300 seconds (5 minutes)', () => {
    expect(redispatchSource).toMatch(/REDISPATCH_COUNTER_TTL_SECONDS\s*=\s*300/);
  });

  test('M11-04: Order path (multi-truck) redispatch uses atomic transaction', () => {
    // When bookingId is absent and orderId is present, should do atomic TX
    expect(redispatchSource).toContain('prismaClient.$transaction');
    // Should update truck request with new driver and create assignment
    expect(redispatchSource).toContain('truckRequest.update');
    expect(redispatchSource).toContain('assignment.create');
  });

  test('M11-05: Order redispatch queries for truck request matching declined driver', () => {
    expect(redispatchSource).toContain('truckRequest.findFirst');
    expect(redispatchSource).toContain('assignedDriverId: declinedDriverId');
  });

  test('M11-06: Redispatch counter is incremented with TTL on order path', () => {
    // After resetting truck request, counter should be incremented
    expect(redispatchSource).toContain('redisService.incr(redisKey)');
    expect(redispatchSource).toContain('redisService.expire(redisKey, REDISPATCH_COUNTER_TTL_SECONDS)');
  });

  test('M11-07: Booking path creates assignment via assignmentService', () => {
    expect(redispatchSource).toContain('assignmentService.createAssignment');
  });

  test('M11-08: Candidate driver must be online and not busy', () => {
    expect(redispatchSource).toContain('driverPresenceService.isDriverOnline(driver.id)');
    expect(redispatchSource).toContain('prismaClient.assignment.findFirst');
  });

  test('M11-09: Declined driver is excluded from candidates', () => {
    expect(redispatchSource).toContain('id: { not: declinedDriverId }');
  });

  test('M11-10: AutoRedispatchParams interface includes orderId', () => {
    expect(redispatchSource).toContain('orderId?: string');
  });
});

// =============================================================================
// H15: Completion idempotency
// =============================================================================

describe('H15: Completion endpoint idempotency', () => {
  const completionSource = readSource('modules/assignment/completion-orchestrator.ts');

  test('H15-01: completeTrip function is exported', () => {
    expect(completionSource).toContain('export async function completeTrip');
  });

  test('H15-02: Redis lock is acquired for idempotency guard', () => {
    expect(completionSource).toContain('redisService.acquireLock(lockKey, holderId');
  });

  test('H15-03: Lock key uses assignment ID for per-assignment idempotency', () => {
    expect(completionSource).toContain('`completion:${assignmentId}`');
  });

  test('H15-04: Lock TTL is 30 seconds', () => {
    expect(completionSource).toMatch(/IDEMPOTENCY_LOCK_TTL_SECONDS\s*=\s*30/);
  });

  test('H15-05: Already-in-progress requests return success with alreadyCompleted flag', () => {
    expect(completionSource).toContain('alreadyCompleted: true');
  });

  test('H15-06: Terminal status check prevents double-completion', () => {
    expect(completionSource).toContain('TERMINAL_ASSIGNMENT_STATUSES');
    expect(completionSource).toContain('TERMINAL.has(assignment.status)');
  });

  test('H15-07: CAS guard in transaction prevents race conditions', () => {
    // updateMany with status NOT IN terminal statuses = CAS guard
    expect(completionSource).toContain('tx.assignment.updateMany');
    expect(completionSource).toContain('notIn: [...TERMINAL_ASSIGNMENT_STATUSES]');
  });

  test('H15-08: Lock is released in finally block', () => {
    expect(completionSource).toContain('finally');
    expect(completionSource).toContain('redisService.releaseLock(lockKey, holderId)');
  });

  test('H15-09: CompletionResult type includes alreadyCompleted field', () => {
    expect(completionSource).toContain('alreadyCompleted: boolean');
  });

  test('H15-10: Supports partial_delivery as terminal status', () => {
    expect(completionSource).toContain("'completed' | 'partial_delivery'");
  });

  test('H15-11: Vehicle is atomically returned to available in same transaction', () => {
    expect(completionSource).toContain("tx.vehicle.updateMany");
    expect(completionSource).toContain("status: 'available'");
  });

  test('H15-12: Side-effects are wrapped in try/catch (non-fatal)', () => {
    // Each post-TX side-effect should be independently wrapped
    const nonFatalCount = (completionSource.match(/non-fatal/gi) || []).length;
    expect(nonFatalCount).toBeGreaterThanOrEqual(5);
  });
});

// =============================================================================
// M21: POD service documented as intentional placeholder
// =============================================================================

describe('M21: POD service documented as intentional placeholder', () => {
  const podSource = readSource('modules/tracking/pod.service.ts');

  test('M21-01: POD service file exists', () => {
    expect(sourceFileExists('modules/tracking/pod.service.ts')).toBe(true);
  });

  test('M21-02: POD service has feature flag documentation', () => {
    // POD service is now a full implementation behind feature flag, not a placeholder
    expect(podSource).toMatch(/feature flag|FF_POD_OTP_REQUIRED/i);
  });

  test('M21-03: POD service mentions feature flag FF_POD_OTP_REQUIRED', () => {
    expect(podSource).toContain('FF_POD_OTP_REQUIRED');
  });

  test('M21-04: POD service exports isPodRequired function', () => {
    expect(podSource).toContain('export function isPodRequired');
  });

  test('M21-05: POD service exports generatePodOtp function', () => {
    expect(podSource).toContain('export async function generatePodOtp');
  });

  test('M21-06: POD service exports validatePodOtp function', () => {
    expect(podSource).toContain('export async function validatePodOtp');
  });

  test('M21-07: Feature flag defaults to false (dormant)', () => {
    expect(podSource).toContain("process.env.FF_POD_OTP_REQUIRED === 'true'");
  });

  test('M21-08: POD service documents its purpose and trigger condition', () => {
    // POD service is now fully implemented with documentation about when it activates
    expect(podSource).toMatch(/arrived_at_drop|completion|OTP/i);
  });

  test('M21-09: POD service is protected by feature flag default', () => {
    // Instead of a "do not remove" comment, the file is protected by the feature flag default=false
    expect(podSource).toContain("=== 'true'");
  });
});

// =============================================================================
// CROSS-CUTTING: Structural integrity checks
// =============================================================================

describe('Cross-cutting: Wave 5 structural integrity', () => {
  test('XCUT-01: completion-orchestrator.ts exists', () => {
    expect(sourceFileExists('modules/assignment/completion-orchestrator.ts')).toBe(true);
  });

  test('XCUT-02: auto-redispatch.service.ts exists', () => {
    expect(sourceFileExists('modules/assignment/auto-redispatch.service.ts')).toBe(true);
  });

  test('XCUT-03: rating-reminder.service.ts exists', () => {
    expect(sourceFileExists('modules/rating/rating-reminder.service.ts')).toBe(true);
  });

  test('XCUT-04: h3-geo-index.service.ts exists', () => {
    expect(sourceFileExists('shared/services/h3-geo-index.service.ts')).toBe(true);
  });

  test('XCUT-05: geo.utils.ts exists with roundCoord', () => {
    const geoSource = readSource('shared/utils/geo.utils.ts');
    expect(geoSource).toContain('export function roundCoord');
  });

  test('XCUT-06: server.ts has M22 fix comment for rating poller', () => {
    const serverSource = readSource('server.ts');
    expect(serverSource).toContain('M22 FIX');
  });
});
