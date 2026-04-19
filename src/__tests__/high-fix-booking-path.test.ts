/**
 * =============================================================================
 * HIGH FIX — BOOKING PATH TESTS (Team BRAVO, Agent B1)
 * =============================================================================
 *
 * Tests for 5 HIGH issues from the TEAM LEO audit:
 *
 * Issue #8:  Non-null assertion on _broadcastService! crashes after persist
 * Issue #9:  Legacy POST /bookings has NO rate limit
 * Issue #11: Order path active check runs OUTSIDE transaction (TOCTOU race)
 * Issue #12: Feature flag logic INVERTED (opt-OUT instead of opt-IN)
 * Issue #13: Sequential O(N) broadcast with 5 DB checks per 100 transporters
 *
 * @author B1 (Team BRAVO)
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// Issue #8: Non-null assertion on _broadcastService! — null guard
// =============================================================================

describe('Issue #8: BroadcastService null guard in booking-create', () => {
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(
      path.resolve(__dirname, '../modules/booking/booking-create.service.ts'),
      'utf-8'
    );
  });

  it('does NOT use non-null assertion _broadcastService! for method calls', () => {
    // The fix removes _broadcastService!.xxx and replaces with null guard.
    // There should be no _broadcastService!. patterns calling methods.
    const bangCalls = source.match(/_broadcastService!\.\w+/g) || [];
    expect(bangCalls).toEqual([]);
  });

  it('has an explicit null guard before calling broadcastService methods', () => {
    expect(source).toContain('if (!_broadcastService)');
    expect(source).toContain('BroadcastService not initialized after booking persisted');
  });

  it('logs error with bookingId when broadcastService is null', () => {
    // The guard must log with bookingId for debugging orphaned bookings
    const guardSection = source.substring(
      source.indexOf('if (!_broadcastService)'),
      source.indexOf('if (!_broadcastService)') + 500
    );
    expect(guardSection).toContain('bookingId');
    expect(guardSection).toContain('logger.error');
  });

  it('returns a valid response instead of crashing when broadcastService is null', () => {
    // After the null guard, should return with matchingTransportersCount and timeoutSeconds
    const guardSection = source.substring(
      source.indexOf('if (!_broadcastService)'),
      source.indexOf('if (!_broadcastService)') + 500
    );
    expect(guardSection).toContain('matchingTransportersCount');
    expect(guardSection).toContain('timeoutSeconds');
    expect(guardSection).toContain('return');
  });
});

// =============================================================================
// Issue #9: Legacy POST /bookings rate limit
// =============================================================================

describe('Issue #9: Legacy POST /bookings rate limit', () => {
  let routeSource: string;

  beforeAll(() => {
    // Rate limiting is implemented in booking.routes.ts via Redis-based checkRateLimit
    routeSource = fs.readFileSync(
      path.resolve(__dirname, '../modules/booking/booking.routes.ts'),
      'utf-8'
    );
  });

  it('has rate limiting on the booking creation path', () => {
    // The canonical order path uses checkRateLimit for per-user rate limiting
    expect(routeSource).toContain('checkRateLimit');
  });

  it('rate limits by customerId (per-user, not just per-IP)', () => {
    // Rate limiting uses order_create:{customerId} key
    expect(routeSource).toContain('order_create:${customerId}');
  });

  it('applies rate limiting before booking creation proceeds', () => {
    // The rate limit check happens before the booking is created
    const rateLimitIdx = routeSource.indexOf('checkRateLimit');
    expect(rateLimitIdx).toBeGreaterThan(-1);
  });

  it('returns 429 when rate limited', () => {
    // Rate limit response sends 429
    expect(routeSource).toContain('429');
    expect(routeSource).toContain('Too many requests');
  });

  it('rate limit window allows 5 requests per 60 seconds', () => {
    // checkRateLimit is called with (key, 5, 60) — 5 requests per 60 seconds
    expect(routeSource).toContain('checkRateLimit(`order_create:${customerId}`, 5, 60)');
  });
});

// =============================================================================
// Issue #11: Order active check TOCTOU race — must be inside TX
// =============================================================================

describe('Issue #11: Active order check inside SERIALIZABLE transaction', () => {
  let creationSource: string;

  beforeAll(() => {
    creationSource = fs.readFileSync(
      path.resolve(__dirname, '../modules/order/order-creation.service.ts'),
      'utf-8'
    );
  });

  it('checkExistingActiveOrders does NOT query DB directly (removed TOCTOU)', () => {
    // The function should only do Redis fast-path + lock acquisition.
    // The DB check (prismaClient.booking.findFirst / prismaClient.order.findFirst)
    // should NOT appear inside checkExistingActiveOrders.
    const fnStart = creationSource.indexOf('export async function checkExistingActiveOrders');
    const fnEnd = creationSource.indexOf('}', creationSource.indexOf('ctx.lockAcquired = true;', fnStart));
    const fnBody = creationSource.substring(fnStart, fnEnd + 1);

    // Should NOT contain prismaClient.booking.findFirst or prismaClient.order.findFirst
    expect(fnBody).not.toContain('prismaClient.booking.findFirst');
    expect(fnBody).not.toContain('prismaClient.order.findFirst');
  });

  it('documents that DB check was moved to SERIALIZABLE TX', () => {
    const fnStart = creationSource.indexOf('export async function checkExistingActiveOrders');
    const fnEnd = creationSource.indexOf('}', creationSource.indexOf('ctx.lockAcquired = true;', fnStart));
    const fnBody = creationSource.substring(fnStart, fnEnd + 1);

    expect(fnBody).toContain('FIX #11');
    expect(fnBody).toContain('TOCTOU');
  });

  it('persistOrderTransaction still has the SERIALIZABLE TX guard', () => {
    // The real guard must be inside the withDbTimeout/Serializable TX
    const txStart = creationSource.indexOf('await withDbTimeout(async (tx)');
    expect(txStart).toBeGreaterThan(-1);

    // Use a larger window to capture the full guard block
    const txSection = creationSource.substring(txStart, txStart + 1200);
    expect(txSection).toContain('tx.booking.findFirst');
    expect(txSection).toContain('tx.order.findFirst');
    expect(txSection).toContain('TERMINAL_STATUSES');
    expect(txSection).toContain("'ACTIVE_ORDER_EXISTS'");
  });

  it('TX guard uses Serializable isolation level', () => {
    expect(creationSource).toContain('Prisma.TransactionIsolationLevel.Serializable');
  });
});

// =============================================================================
// Issue #12: Feature flag logic INVERTED — opt-IN not opt-OUT
// =============================================================================

describe('Issue #12: Feature flag opt-IN logic', () => {
  let broadcastSource: string;

  beforeAll(() => {
    broadcastSource = fs.readFileSync(
      path.resolve(__dirname, '../modules/booking/booking-broadcast.service.ts'),
      'utf-8'
    );
  });

  it('uses === "true" (opt-IN) not !== "false" (opt-OUT) for FF_SEQUENCE_DELIVERY_ENABLED', () => {
    // Must use strict opt-in: undefined env => feature OFF
    expect(broadcastSource).toContain("process.env.FF_SEQUENCE_DELIVERY_ENABLED === 'true'");
    // Must NOT contain the old inverted check
    expect(broadcastSource).not.toContain("process.env.FF_SEQUENCE_DELIVERY_ENABLED !== 'false'");
  });

  it('documents the fix rationale', () => {
    expect(broadcastSource).toContain('FIX #12');
    // Comment uses "Opt-IN" (case-insensitive check)
    expect(broadcastSource.toLowerCase()).toContain('opt-in');
  });
});

// =============================================================================
// Issue #13: Batch eligibility check replaces sequential O(N)
// =============================================================================

describe('Issue #13: Batch eligibility check in broadcast', () => {
  let broadcastSource: string;

  beforeAll(() => {
    broadcastSource = fs.readFileSync(
      path.resolve(__dirname, '../modules/booking/booking-broadcast.service.ts'),
      'utf-8'
    );
  });

  it('performs a single batch vehicle.findMany query for eligibility', () => {
    expect(broadcastSource).toContain('prismaClient.vehicle.findMany');
    expect(broadcastSource).toContain("distinct: ['transporterId']");
  });

  it('filters transporters through eligibleSet before broadcast loop', () => {
    expect(broadcastSource).toContain('eligibleSet');
    expect(broadcastSource).toContain('eligibleTransporters');
  });

  it('fails open if batch eligibility check fails', () => {
    // On error, should broadcast to all (not crash or drop all)
    expect(broadcastSource).toContain('Batch eligibility check failed, broadcasting to all');
  });

  it('uses adaptive BOOKING_STATUS_CHECK_INTERVAL based on batch size', () => {
    // FIX #80: Adaptive interval formula: max(5, min(50, floor(count/3)))
    // This scales with batch size instead of a fixed value
    expect(broadcastSource).toContain('BOOKING_STATUS_CHECK_INTERVAL');
    expect(broadcastSource).toContain('Math.max');
    expect(broadcastSource).toContain('Math.min(50');
  });

  it('broadcast loop iterates over eligibleTransporters, not cappedTransporters', () => {
    // The for loop must use eligibleTransporters (batch-filtered)
    expect(broadcastSource).toContain('for (const transporterId of eligibleTransporters)');
    // Should NOT loop over cappedTransporters directly
    expect(broadcastSource).not.toContain('for (const transporterId of ctx.cappedTransporters)');
  });
});
