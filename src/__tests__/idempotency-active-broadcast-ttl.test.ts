/**
 * =============================================================================
 * F-A-24 — Unified TTL: idempotency cache + active-broadcast key both 86_400s
 * =============================================================================
 *
 * Today the legacy `createOrder` write path sets the active-broadcast Redis
 * key with TTL = orderTimeoutSeconds + 60 (~180s with default config), while
 * the idempotency response cache uses 86_400s (24h). The mismatch means:
 *  - the active-broadcast guard expires LONG before the idempotency response
 *    would, so a customer that retries 5 minutes after a successful book is
 *    blocked from receiving the cached 201 by the active-order guard short-
 *    circuiting on a stale "active broadcast" ghost write.
 *
 * F-A-24 unifies both TTLs to 86_400s (matching Stripe's industry-standard
 * idempotency window) and shifts cleanup to ACTIVE deletes on terminal-state
 * transitions (cancel/expire/complete) instead of relying on a 3-minute Redis
 * tombstone.
 *
 * Gated by FF_UNIFIED_IDEMPOTENCY_TTL (release, default OFF). When OFF, legacy
 * 180s value is preserved.
 * =============================================================================
 */

import { ACTIVE_BROADCAST_TTL_SECONDS, IDEMPOTENCY_TTL_SECONDS } from '../shared/constants/idempotency';

describe('F-A-24 — Unified idempotency TTL constants', () => {
  it('IDEMPOTENCY_TTL_SECONDS is exactly 86_400 (24 hours)', () => {
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
  });

  it('ACTIVE_BROADCAST_TTL_SECONDS matches IDEMPOTENCY_TTL_SECONDS', () => {
    expect(ACTIVE_BROADCAST_TTL_SECONDS).toBe(IDEMPOTENCY_TTL_SECONDS);
  });
});

describe('F-A-24 — order.service.ts uses unified TTL when FF is ON', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.resolve(__dirname, '../modules/order/order.service.ts'),
    'utf8'
  );

  it('source imports ACTIVE_BROADCAST_TTL_SECONDS from shared constants', () => {
    expect(source).toMatch(
      /from\s+['"]\.\.\/\.\.\/shared\/constants\/idempotency['"]/
    );
  });

  it('source references the FF_UNIFIED_IDEMPOTENCY_TTL flag for TTL selection', () => {
    expect(source).toMatch(/FF_UNIFIED_IDEMPOTENCY_TTL|UNIFIED_IDEMPOTENCY_TTL/);
  });

  it('legacy ~180s TTL path still preserved when FF is OFF', () => {
    // Branch must still compute orderTimeoutSeconds + 60 in the OFF arm so
    // operators can roll back without code change.
    expect(source).toMatch(/orderTimeoutSeconds\s*\+\s*60/);
  });
});
