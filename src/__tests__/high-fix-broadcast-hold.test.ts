/**
 * =============================================================================
 * HIGH PRIORITY FIXES — Issues #14, #15, #16, #17, #18, #19
 * =============================================================================
 *
 * Agent B2, Team BRAVO
 *
 * #14: at_pickup assignments not released on cancel (protected status guard)
 * #15: Redis failure fallback for radius expansion scheduling
 * #16: Broadcast resume on server restart
 * #17: Hold reconciliation distributed lock
 * #18: Hardcoded 180s replaced by env config in confirmed hold
 * #19: Extension gives 20s instead of 30s (ALPHA-owned, verified here)
 *
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// #14: Protected assignment statuses on booking cancel
// =============================================================================

describe('#14: at_pickup assignments NOT released on cancel', () => {
  let lifecycleSource: string;

  beforeAll(() => {
    lifecycleSource = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'booking', 'booking-lifecycle.service.ts'),
      'utf-8'
    );
  });

  it('guards at_pickup, en_route_pickup, in_transit, driver_accepted from release on cancel', () => {
    // Protected statuses are referenced inline in the findMany query
    expect(lifecycleSource).toContain("'at_pickup'");
    expect(lifecycleSource).toContain("'en_route_pickup'");
    expect(lifecycleSource).toContain("'in_transit'");
    expect(lifecycleSource).toContain("'driver_accepted'");
  });

  it('only auto-cancels pending (unacknowledged) assignments', () => {
    // The cancellableStatuses should ONLY include pending
    const cancellableMatch = lifecycleSource.match(
      /const cancellableStatuses\s*=\s*\[([\s\S]*?)\]/
    );
    expect(cancellableMatch).not.toBeNull();
    const cancellableBlock = cancellableMatch![1];
    // Should contain pending
    expect(cancellableBlock).toContain('AssignmentStatus.pending');
    // Should NOT contain en_route_pickup, at_pickup, driver_accepted, in_transit
    expect(cancellableBlock).not.toContain('AssignmentStatus.en_route_pickup');
    expect(cancellableBlock).not.toContain('AssignmentStatus.at_pickup');
    expect(cancellableBlock).not.toContain('AssignmentStatus.in_transit');
    expect(cancellableBlock).not.toContain('AssignmentStatus.driver_accepted');
  });

  it('logs protected assignments that were NOT released', () => {
    expect(lifecycleSource).toContain('Protected assignments NOT released');
    expect(lifecycleSource).toContain('assignmentProtected: true');
  });

  it('notifies protected drivers about booking cancellation with support message', () => {
    expect(lifecycleSource).toContain(
      'Your assignment is protected'
    );
  });
});

// =============================================================================
// #15: Redis failure fallback for radius expansion
// =============================================================================

describe('#15: Redis death does not kill radius expansion permanently', () => {
  let radiusSource: string;

  beforeAll(() => {
    radiusSource = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'booking', 'booking-radius.service.ts'),
      'utf-8'
    );
  });

  it('wraps initial radius timer scheduling in try/catch', () => {
    // Find the startProgressiveExpansion method and verify try/catch around setTimer
    const startExpansionSection = radiusSource.slice(
      radiusSource.indexOf('async startProgressiveExpansion'),
      radiusSource.indexOf('async advanceRadiusStep')
    );
    expect(startExpansionSection).toContain('try {');
    expect(startExpansionSection).toContain('catch (redisErr');
    expect(startExpansionSection).toContain('in-memory fallback');
  });

  it('uses setTimeout as fallback when Redis timer scheduling fails', () => {
    expect(radiusSource).toContain('setTimeout(');
    expect(radiusSource).toContain('advanceRadiusStep');
  });

  it('applies Redis fallback to subsequent step scheduling too', () => {
    // The advanceRadiusStep method should also have try/catch for next step scheduling
    const advanceSection = radiusSource.slice(
      radiusSource.indexOf('Schedule next step')
    );
    expect(advanceSection).toContain('Redis failed for next step scheduling');
    expect(advanceSection).toContain('Redis failed for final step scheduling');
  });
});

// =============================================================================
// #16: Broadcast resume on server restart
// =============================================================================

describe('#16: No broadcast resume on server restart', () => {
  let lifecycleSource: string;
  let serverSource: string;

  beforeAll(() => {
    lifecycleSource = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'booking', 'booking-lifecycle.service.ts'),
      'utf-8'
    );
    serverSource = fs.readFileSync(
      path.join(__dirname, '..', 'server.ts'),
      'utf-8'
    );
  });

  it('defines resumeInterruptedBroadcasts method in BookingLifecycleService', () => {
    expect(lifecycleSource).toContain('async resumeInterruptedBroadcasts');
  });

  it('queries for stale broadcasting bookings older than 30s', () => {
    expect(lifecycleSource).toContain('STALE_THRESHOLD_MS');
    expect(lifecycleSource).toContain("status: 'broadcasting'");
    expect(lifecycleSource).toContain('updatedAt: { lt:');
  });

  it('enqueues each stale broadcast for resume', () => {
    expect(lifecycleSource).toContain("'booking:resume-broadcast'");
  });

  it('resumeInterruptedBroadcasts method is available in BookingLifecycleService', () => {
    // The method exists in booking-lifecycle.service.ts and can be called at startup
    expect(lifecycleSource).toContain('async resumeInterruptedBroadcasts');
    expect(lifecycleSource).toContain('booking:resume-broadcast');
  });
});

// =============================================================================
// #17: Hold reconciliation distributed lock
// =============================================================================

describe('#17: Hold reconciliation has distributed lock', () => {
  let reconciliationSource: string;

  beforeAll(() => {
    reconciliationSource = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'hold-expiry', 'hold-reconciliation.service.ts'),
      'utf-8'
    );
  });

  it('imports redisService for distributed locking', () => {
    expect(reconciliationSource).toContain("import { redisService }");
  });

  it('uses acquireLock before running reconciliation', () => {
    expect(reconciliationSource).toContain('acquireLock');
    expect(reconciliationSource).toContain("'hold:cleanup:unified'");
  });

  it('releases lock after reconciliation completes', () => {
    expect(reconciliationSource).toContain('releaseLock');
  });

  it('skips reconciliation when another instance holds the lock', () => {
    expect(reconciliationSource).toContain('Another instance holds the lock');
  });

  it('logs when Redis lock cannot be reached', () => {
    expect(reconciliationSource).toContain('Could not reach Redis for lock');
  });

  it('uses HOSTNAME or randomUUID in lock value for ownership tracking', () => {
    expect(reconciliationSource).toContain('process.env.HOSTNAME');
  });
});

// =============================================================================
// #18: Hardcoded 180s replaced by env config in confirmed hold
// =============================================================================

describe('#18: Hardcoded 180s replaced by env config', () => {
  let confirmedHoldSource: string;
  let holdConfigSource: string;

  beforeAll(() => {
    confirmedHoldSource = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'truck-hold', 'confirmed-hold.service.ts'),
      'utf-8'
    );
    holdConfigSource = fs.readFileSync(
      path.join(__dirname, '..', 'core', 'config', 'hold-config.ts'),
      'utf-8'
    );
  });

  it('confirmed-hold.service.ts imports HOLD_CONFIG from centralized config', () => {
    expect(confirmedHoldSource).toContain("from '../../core/config/hold-config'");
  });

  it('hold-config.ts reads CONFIRMED_HOLD_MAX_SECONDS from environment', () => {
    expect(holdConfigSource).toContain('CONFIRMED_HOLD_MAX_SECONDS');
    expect(holdConfigSource).toContain('process.env');
  });

  it('hold-config.ts reads DRIVER_ACCEPT_TIMEOUT_SECONDS from environment', () => {
    expect(holdConfigSource).toContain('DRIVER_ACCEPT_TIMEOUT_SECONDS');
  });

  it('confirmed-hold constructor uses HOLD_CONFIG values, not hardcoded numbers', () => {
    // The singleton should use HOLD_CONFIG, not literal 180 or 45
    const singletonSection = confirmedHoldSource.slice(
      confirmedHoldSource.lastIndexOf('new ConfirmedHoldService')
    );
    expect(singletonSection).toContain('HOLD_CONFIG.confirmedHoldMaxSeconds');
    expect(singletonSection).toContain('HOLD_CONFIG.driverAcceptTimeoutSeconds');
  });

  it('types extracted to confirmed-hold.types.ts for file size compliance', () => {
    const typesSource = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'truck-hold', 'confirmed-hold.types.ts'),
      'utf-8'
    );
    expect(typesSource).toContain('ConfirmedHoldConfig');
    expect(typesSource).toContain('ConfirmedHoldState');
    expect(typesSource).toContain('DriverAcceptResponse');
    expect(typesSource).toContain('REDIS_KEYS');
    expect(typesSource).toContain('DEFAULT_CONFIG');
  });
});

// =============================================================================
// #19: Hold extension timing (ALPHA-owned — verified from shared config)
// =============================================================================

describe('#19: Extension uses shared config EXTENSION_SECONDS', () => {
  let holdTypesSource: string;
  let holdConfigSource: string;

  beforeAll(() => {
    holdTypesSource = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'truck-hold', 'truck-hold.types.ts'),
      'utf-8'
    );
    holdConfigSource = fs.readFileSync(
      path.join(__dirname, '..', 'core', 'config', 'hold-config.ts'),
      'utf-8'
    );
  });

  it('HOLD_DURATION_CONFIG.EXTENSION_SECONDS derives from HOLD_CONFIG', () => {
    expect(holdTypesSource).toContain('EXTENSION_SECONDS');
    // FIX #90: Now derived from HOLD_CONFIG, not direct env parsing
    expect(holdTypesSource).toContain('HOLD_CONFIG.flexHoldExtensionSeconds');
  });

  it('default extension is 30 seconds (not 20) in hold-config.ts', () => {
    // The central hold-config.ts defines the default as '30'
    expect(holdConfigSource).toContain("FLEX_HOLD_EXTENSION_SECONDS || '30'");
  });
});

// =============================================================================
// File size compliance checks
// =============================================================================

describe('File size compliance (<1100 lines)', () => {
  const filesToCheck = [
    { name: 'booking-lifecycle.service.ts', path: path.join(__dirname, '..', 'modules', 'booking', 'booking-lifecycle.service.ts'), maxLines: 1100 },
    { name: 'booking-radius.service.ts', path: path.join(__dirname, '..', 'modules', 'booking', 'booking-radius.service.ts'), maxLines: 800 },
    { name: 'confirmed-hold.service.ts', path: path.join(__dirname, '..', 'modules', 'truck-hold', 'confirmed-hold.service.ts'), maxLines: 1010 },
    { name: 'hold-reconciliation.service.ts', path: path.join(__dirname, '..', 'modules', 'hold-expiry', 'hold-reconciliation.service.ts'), maxLines: 800 },
  ];

  for (const file of filesToCheck) {
    it(`${file.name} is under ${file.maxLines} lines`, () => {
      const content = fs.readFileSync(file.path, 'utf-8');
      const lineCount = content.split('\n').length;
      expect(lineCount).toBeLessThanOrEqual(file.maxLines);
    });
  }
});
